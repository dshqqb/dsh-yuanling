// src/core/modules/host.js —— 模块进程宿主：spawn + 握手 + 请求响应 + 生存管理。
//
// 对应协议 §6 握手、§8 运行时管理、§17 的 1/3/4/5/6 条。
//
// 造这个类时守住几条：
//   · **模块只跑在子进程里**，绝不 import 进宿主（进程崩了宿主不受影响）；
//   · 响应允许乱序，靠 id 关联；
//   · 超时按 op 分档（§4.3），超时只作废该请求，不杀进程；
//   · 崩溃按指数退避重启，重试到上限后标 crashed，**不再自动拉起**（§8.3）；
//   · stdout 出现非 JSON = E_PROTO，断开并按崩溃处理（模块日志必须走 stderr 或 log op）。
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'

import { FrameReader, parseFrame, encodeFrame } from './frame.js'

/** §4.3 的按 op 超时表。 */
export const OP_TIMEOUTS = {
  default: 10_000,
  init: 30_000,
  ingest: 10_000,
  'media.put.file': 10_000,
  'media.get': 10_000,
  'propose.fact': 10_000,
  send: 30_000,
  actuate: 300_000,
}

/** §8.3 重启退避：1s → 2s → 4s → 8s → 上限 5 次。 */
export const RESTART_BACKOFF_MS = [1000, 2000, 4000, 8000]
export const MAX_RESTARTS = 5
/** 同一模块连续超时多少次算崩（§4.3 规定 3 次）。 */
export const CONSECUTIVE_TIMEOUT_LIMIT = 3

export function timeoutFor(op, explicit) {
  if (Number.isFinite(explicit) && explicit > 0) return explicit
  return OP_TIMEOUTS[op] ?? OP_TIMEOUTS.default
}

/**
 * 一个模块实例。
 *
 * 事件（都通过 on() 注册，宿主不关心业务）：
 *   'log'    {level, message}      模块 stderr / log op
 *   'request' {op, id, data}       模块发起的请求（需要宿主回应）
 *   'state'  {state, reason}       starting / ready / stopped / crashed
 */
export class ModuleProcess {
  constructor({
    id,
    command,
    cwd = process.cwd(),
    env = {},
    onLog = null,
    onRequest = null,
    onState = null,
    spawnImpl = spawn,
    restartBackoffMs = RESTART_BACKOFF_MS,
    maxRestarts = MAX_RESTARTS,
    timeoutOverrides = {},
    autoRestart = true,
  } = {}) {
    this.id = id
    this.command = Array.isArray(command) ? command : [command]
    this.cwd = cwd
    this.env = env
    this.onLog = onLog
    this.onRequest = onRequest
    this.onState = onState
    this.spawnImpl = spawnImpl
    this.restartBackoffMs = restartBackoffMs
    this.maxRestarts = maxRestarts
    this.timeoutOverrides = timeoutOverrides
    this.autoRestart = autoRestart

    this.child = null
    this.state = 'stopped'
    this.pending = new Map() // id -> {op, resolve, reject, timer}
    this.reader = new FrameReader()
    this.restarts = 0
    this.consecutiveTimeouts = 0
    this.stopping = false
    this.lastError = null
  }

  _emitState(state, reason = '') {
    this.state = state
    if (!reason) this.lastError = null
    try {
      this.onState?.({ id: this.id, state, reason })
    } catch {
      /* 观察者出错不该影响宿主 */
    }
  }

  _emitLog(level, message) {
    try {
      this.onLog?.({ id: this.id, level, message: String(message ?? '').slice(0, 500) })
    } catch {
      /* ignore */
    }
  }

  /** 起进程。stderr 原样转发为日志；stdout 只认协议帧。 */
  start() {
    if (this.child) return this

    this.stopping = false
    this.reader = new FrameReader()
    this._emitState('starting')

    let child
    try {
      child = this.spawnImpl(this.command[0], this.command.slice(1), {
        cwd: this.cwd,
        env: { ...process.env, ...this.env },
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
      })
    } catch (error) {
      this.lastError = `spawn 失败：${error?.message ?? error}`
      this._emitLog('error', this.lastError)
      this._emitState('crashed', this.lastError)
      return this
    }

    this.child = child

    child.stdout?.on('data', (chunk) => {
      let lines
      try {
        lines = this.reader.feed(chunk.toString('utf8'))
      } catch (error) {
        // 帧超限：按协议错误断开
        this._handleProtocolError(error)
        return
      }
      for (const line of lines) {
        let frame
        try {
          frame = parseFrame(line)
        } catch (error) {
          // stdout 污染：立刻断开，不猜测"这行是不是日志"
          this._handleProtocolError(error)
          return
        }
        this._dispatch(frame)
      }
    })

    child.stderr?.on('data', (chunk) => {
      this._emitLog('stderr', chunk.toString('utf8').trim())
    })

    child.on('error', (error) => {
      this.lastError = `进程错误：${error?.message ?? error}`
      this._emitLog('error', this.lastError)
    })

    child.on('exit', (code, signal) => {
      const wasStopping = this.stopping
      this._failPending(`模块进程退出（code=${code}, signal=${signal}）`)
      this.child = null
      if (wasStopping) {
        this._emitState('stopped')
        return
      }
      this._handleCrash(`exit code=${code} signal=${signal}`)
    })

    return this
  }

  _handleProtocolError(error) {
    this._emitLog('error', error?.message ?? String(error))
    this.lastError = error?.message ?? 'E_PROTO'
    // 断开 = 杀进程；这一步走崩溃流程，但不一定是"自动重启"那一套
    try {
      this.child?.kill()
    } catch {
      /* ignore */
    }
  }

  _dispatch(frame) {
    if (typeof frame.id === 'string' && typeof frame.ok === 'boolean') {
      const waiter = this.pending.get(frame.id)
      if (!waiter) {
        // 迟到响应：作废并记日志（§4.3）
        this._emitLog('warn', `收到孤儿响应 id=${frame.id}（可能已超时）`)
        return
      }
      this.pending.delete(frame.id)
      if ('timeoutMs' in waiter) clearTimeout(waiter.timeoutMs)
      this.consecutiveTimeouts = 0
      if (frame.ok) waiter.resolve(frame.result ?? {})
      else {
        const e = new Error(frame.error?.message ?? '模块返回失败')
        e.code = frame.error?.code ?? 'E_MODULE'
        e.retry = Boolean(frame.error?.retry)
        waiter.reject(e)
      }
      return
    }

    if (typeof frame.op === 'string') {
      if (this.onRequest) {
        // 模块 → 宿主的请求：交出去，错误统一回 E_INTERNAL
        Promise.resolve()
          .then(() => this.onRequest({ id: this.id, op: frame.op, data: frame.data ?? {} }))
          .then((result) => this._send({ id: frame.id, ok: true, result }))
          .catch((error) =>
            this._send({
              id: frame.id,
              ok: false,
              error: { code: error?.code ?? 'E_INTERNAL', message: String(error?.message ?? error), retry: false },
            }),
          )
      }
      return
    }

    this._emitLog('warn', `不认识的帧：${JSON.stringify(frame).slice(0, 120)}`)
  }

  _send(obj) {
    try {
      this.child?.stdin?.write(encodeFrame(obj))
      return true
    } catch (error) {
      this._emitLog('error', `写入失败：${error?.message ?? error}`)
      return false
    }
  }

  _failPending(reason) {
    for (const [id, waiter] of this.pending) {
      if (waiter.timeoutMs) clearTimeout(waiter.timeoutMs)
      waiter.reject(new Error(reason))
      this.pending.delete(id)
    }
  }

  /**
   * 发一个请求并等响应。
   * @param {string} op
   * @param {object} data
   * @param {{timeoutMs?:number, id?:string}} opts
   */
  request(op, data = {}, { timeoutMs, id } = {}) {
    if (this.state === 'crashed') return Promise.reject(Object.assign(new Error('模块已崩溃，不再接受请求'), { code: 'E_CRASHED' }))
    if (!this.child) return Promise.reject(Object.assign(new Error('模块未启动'), { code: 'E_NOT_RUNNING' }))

    const rid = id ?? randomUUID()
    const limit = timeoutFor(op, timeoutMs ?? this.timeoutOverrides[op])

    return new Promise((resolve, reject) => {
      const waiter = { op, resolve, reject, timeoutMs: null }
      this.pending.set(rid, waiter)

      waiter.timeoutMs = setTimeout(() => {
        this.pending.delete(rid)
        this.consecutiveTimeouts += 1
        const err = new Error(`请求超时：${op}（${limit}ms）`)
        err.code = 'E_TIMEOUT'
        err.retry = true
        // 超时只作废这一个请求，**不杀进程**（§4.3）
        reject(err)
        if (this.consecutiveTimeouts >= CONSECUTIVE_TIMEOUT_LIMIT) {
          this._emitLog('error', `连续 ${CONSECUTIVE_TIMEOUT_LIMIT} 次超时，按崩溃处理`)
          this._handleProtocolError(Object.assign(new Error('连续超时'), { code: 'E_TIMEOUT' }))
        }
      }, limit)

      const sent = this._send({ op, id: rid, data })
      if (!sent) {
        clearTimeout(waiter.timeoutMs)
        this.pending.delete(rid)
        reject(new Error('写入失败'))
      }
    })
  }

  /** 通知帧（无 id、不需应答）。 */
  notify(op, data = {}) {
    return this._send({ op, data })
  }

  /** 握手：发 init，等 ready（§6）。 */
  async init(payload = {}) {
    const r = await this.request('init', payload, { timeoutMs: this.timeoutOverrides.init })
    this._emitState('ready')
    return r
  }

  async ping() {
    return this.request('ping', {})
  }

  _handleCrash(reason) {
    this.lastError = reason
    this._emitLog('error', `崩溃：${reason}`)

    if (!this.autoRestart || this.restarts >= this.maxRestarts) {
      this._emitState('crashed', reason)
      return
    }
    const delay = this.restartBackoffMs[Math.min(this.restarts, this.restartBackoffMs.length - 1)]
    this.restarts += 1
    this._emitState('restarting', reason)

    const timer = setTimeout(() => {
      if (this.stopping) return
      this._emitLog('info', `第 ${this.restarts} 次重启（退避 ${delay}ms）`)
      this.start()
    }, delay)
    timer.unref?.()
    this._restartTimer = timer
  }

  /** 主动停：先说 shutdown，再关 stdin，最后 kill（§8.1 的干净退出）。 */
  async stop({ deadlineMs = 2000 } = {}) {
    this.stopping = true
    if (this._restartTimer) clearTimeout(this._restartTimer)

    if (this.child && this.state !== 'crashed') {
      try {
        this.notify('shutdown', { deadline_ms: deadlineMs })
      } catch {
        /* ignore */
      }
    }
    try {
      this.child?.stdin?.end()
    } catch {
      /* ignore */
    }
    const child = this.child
    if (!child) {
      this._emitState('stopped')
      return
    }
    await new Promise((resolve) => {
      const timer = setTimeout(() => {
        try {
          child.kill()
        } catch {
          /* ignore */
        }
        resolve()
      }, deadlineMs + 500)
      timer.unref?.()
      child.once('exit', () => {
        clearTimeout(timer)
        resolve()
      })
    })
    this._failPending('模块已停止')
    this._emitState('stopped')
  }

  /**
   * 硬杀进程，**视同意外崩溃**（走 crash 流程、可能触发重启）。
   *
   * 与 stop() 的区别必须分清（踩过混淆）：
   *   · stop()   = "我要停它" → stopping=true → exit 后报 stopped
   *   · kill()   = 模拟外部把进程弄死 → 不设 stopping → exit 后进 _handleCrash
   * 想"安静地收尸不重启"，用 dispose()。
   */
  kill() {
    try {
      this.child?.kill()
    } catch {
      /* ignore */
    }
  }

  /**
   * 收尸：立刻杀掉且**不再重启**，不等优雅退出、不产生状态噪声。
   * 测试 after()、插件卸载等"必须干净走开"的场景用它。
   */
  dispose() {
    this.stopping = true
    this.autoRestart = false
    if (this._restartTimer) clearTimeout(this._restartTimer)
    this._failPending('已销毁')
    try {
      this.child?.kill()
    } catch {
      /* ignore */
    }
  }
}
