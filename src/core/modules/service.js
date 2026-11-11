// src/core/modules/service.js —— 模块管理的外观层：把 registry / installer / host 串成一个门面。
//
// 为什么要门面：管理台 API 与插件启动逻辑都要用同一套操作（列表、装、更、停、卸、授予、导出）。
// 如果两边各写一份，"页面看到的状态"和"实际运行的状态"迟早分叉。
import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'

import { localIso, readJson, writeJsonAtomic, ensureDir, exists } from '../fsx.js'
import { P } from '../paths.js'
import { readRegistry, writeRegistry, setGranted, grantedOf, setState, recordCrash, moduleDir, listIds } from './registry.js'
import { installFromBytes, uninstall, moduleTmpDir, sha256Of } from './installer.js'
import { ModuleProcess } from './host.js'
import { resolveSource, normalizeReply, storeFetched, fetchError, FETCH_MAX_ITEMS, FETCH_RATE } from './sources.js'
import { normalizeUiPayload, uiError } from './ui.js'
import { describeFields } from './configschema.js'
import { queryRecords } from './records.js'
import { appendEvent } from '../events.js'

/** 协议 §5.1：单批 ingest 最多 100 条。超了拒绝，不静默截断（截断会让模块以为全写进去了）。 */
export const INGEST_BATCH_MAX = 100
/** 协议 §5.1：log.data 上限 4KB。不截的话，一个模块能靠日志把磁盘写满。 */
export const LOG_DATA_MAX = 4096
/** v1.4：模块自报诊断项的硬上限（条数与每条提示的长度）。 */
export const DIAG_MAX_ITEMS = 20
export const DIAG_HINT_MAX = 200
/** 自报诊断的存活期：超过就当成不再成立（进程崩了，它报的"正常"必须消失）。 */
export const DIAG_TTL_MS = 15 * 60 * 1000

/** 日志文件：system/log/modules/<id>.log（协议 §10）。 */
export function moduleLogPath(root, id) {
  return path.join(root, P.modulesLog, `${id}.log`)
}

export function appendModuleLog(root, id, line) {
  try {
    const p = moduleLogPath(root, id)
    ensureDir(path.dirname(p))
    fs.appendFileSync(p, `${localIso()} ${line}\n`)
  } catch {
    /* 日志写不进去不该影响主流程 */
  }
}

/** 读日志尾巴（页面用）。默认 80 行，超过 200 行会被截断。 */
export function tailModuleLog(root, id, { lines = 80 } = {}) {
  const p = moduleLogPath(root, id)
  if (!exists(p)) return []
  try {
    const all = fs.readFileSync(p, 'utf8').split('\n').filter(Boolean)
    return all.slice(-Math.max(1, Math.min(200, lines)))
  } catch {
    return []
  }
}

/** 模块的配置（核心存、核心给）：system/modules/<id>/config.json。 */
// 配置的读写只有一份实现（manage.js）：模块配置是"核心保管 + 页面可编辑"，
// 两个文件各写一份迟早会出现"页面存进去的和模块读到的不一样"。
import { readModuleConfig as readModuleConfigFromManage, writeModuleConfig as writeModuleConfigFromManage } from './manage.js'
export const readModuleConfig = readModuleConfigFromManage
export const writeModuleConfig = writeModuleConfigFromManage

/**
 * 模块门面。一个实例管一个数据目录下的所有模块。
 *
 * 进程生命周期策略（协议 §2 / §8）：
 *   · 启动时只拉起 `enabled` 的模块；
 *   · `enabled:false` 是**持久**停用——重启也不起（用户定的 C）；
 *   · 崩溃到上限后标 crashed，不再自动拉起，等人工处理。
 */
export class ModuleService {
  constructor({ root, pid = null, onIngest = null, onPropose = null, onOutboxFetch = null, onOutboxAck = null, onEgress = null, onMediaPut = null, onMediaGet = null, spawnImpl = undefined } = {}) {
    this.root = root
    this.pid = pid
    this.handlers = { onIngest, onPropose, onOutboxFetch, onOutboxAck, onEgress, onMediaPut, onMediaGet }
    this.spawnImpl = spawnImpl
    this.procs = new Map() // id -> ModuleProcess
    this.logs = new Map() // id -> string[] 最近若干行（内存里，页面即时看）
    this.fetchTimes = new Map() // id -> number[] 取数时间戳（限频用）
    this.mediaTimes = new Map() // id -> number[] 媒体入库时间戳（限频用）
  }

  /** 当前注册表快照。 */
  registry() {
    return readRegistry(this.root)
  }

  /** 列表：注册表 + 运行时状态 + manifest 里的展示信息。 */
  list() {
    const reg = readRegistry(this.root)
    return listIds(reg).map((id) => {
      const entry = reg.modules[id]
      const proc = this.procs.get(id)
      return {
        id,
        version: entry.version,
        api: entry.api,
        kind: entry.kind,
        source: entry.source,
        repo: entry.repo,
        previousRepo: entry.previousRepo,
        installedAt: entry.installed_at,
        enabled: entry.enabled !== false,
        state: proc?.state ?? entry.state ?? 'stopped',
        restarts: proc?.restarts ?? 0,
        lastCrash: entry.last_crash,
        capabilities: entry.capabilities ?? [],
        granted: grantedOf(entry),
        routes: entry.routes ?? [],
        running: Boolean(proc?.child),
      }
    })
  }

  detail(id) {
    const reg = readRegistry(this.root)
    const entry = reg.modules[id]
    if (!entry) return null
    const proc = this.procs.get(id)
    return {
      ...this.list().find((m) => m.id === id),
      capabilities: entry.capabilities ?? [],
      granted: grantedOf(entry),
      permissions: entry.permissions ?? [],
      config: readModuleConfig(this.root, id),
      log: tailModuleLog(this.root, id),
      memory: this.logs.get(id)?.slice(-40) ?? [],
      entry,
    }
  }

  /** 装 / 更新（从字节，方便测试；真实下载在 api 层做）。 */
  install({ bytes, repo = null, source = null, ref = null, expectSha256 = null }) {
    const r = installFromBytes({ root: this.root, bytes, repo, source, ref, expectSha256 })
    appendModuleLog(this.root, r.manifest.id, `installed ${r.manifest.version}（${source ?? 'manual'}，sha256 ${r.sha256.slice(0, 12)}…）`)
    appendEvent(this.root, {
      kind: 'module.install',
      actor: 'human:editor',
      module: r.manifest.id,
      text: `安装 ${r.manifest.version}（${source ?? 'manual'}）`,
      data: { version: r.manifest.version, sha256: r.sha256.slice(0, 16), source: source ?? 'manual' },
    })
    return r
  }

  remove(id) {
    this.stop(id)
    const r = uninstall(this.root, id)
    this.logs.delete(id)
    appendEvent(this.root, { kind: 'module.uninstall', level: 'warn', actor: 'human:editor', module: id, text: '卸载模块（目录与配置一起删掉）' })
    return r
  }

  /** 授予/收回能力。 */
  grant(id, capability, granted) {
    const reg = readRegistry(this.root)
    const entry = reg.modules[id]
    if (!entry) throw new Error(`没有这个模块：${id}`)
    const next = setGranted(entry, capability, granted)
    reg.modules[id] = next
    writeRegistry(this.root, reg)
    appendModuleLog(this.root, id, `${granted ? 'grant' : 'revoke'} ${capability}`)
    // 授权是"谁能做什么"的变更，进事件流（诊断页也按它比对"声明 vs 已授"）
    appendEvent(this.root, {
      kind: granted ? 'module.grant' : 'module.revoke',
      level: granted ? 'info' : 'warn',
      actor: 'human:editor',
      module: id,
      text: `${granted ? '授予' : '收回'}能力 ${capability}`,
      data: { capability },
    })
    return { granted: grantedOf(next) }
  }

  /** 持久停用/启用（enabled 写注册表）。 */
  setEnabled(id, enabled) {
    const reg = readRegistry(this.root)
    const entry = reg.modules[id]
    if (!entry) throw new Error(`没有这个模块：${id}`)
    reg.modules[id] = { ...entry, enabled: Boolean(enabled) }
    writeRegistry(this.root, reg)
    if (!enabled) this.stop(id)
    else this.start(id).catch(() => {})
    return { enabled: Boolean(enabled) }
  }

  /** 起一个模块（若已启用且没在跑）。 */
  async start(id) {
    const reg = readRegistry(this.root)
    const entry = reg.modules[id]
    if (!entry) throw new Error(`没有这个模块：${id}`)
    if (entry.enabled === false) return { skipped: 'disabled' }
    if (this.procs.get(id)?.child) return { skipped: 'already-running' }

    const dir = moduleDir(this.root, id)
    const manifest = readJson(path.join(dir, 'yuanling.module.json'), null)
    if (!manifest) throw new Error(`模块目录里没有 yuanling.module.json：${dir}`)

    const command = manifest.entry?.command ?? []
    const proc = new ModuleProcess({
      id,
      command: command[0] === 'node' ? [process.execPath, ...command.slice(1)] : command,
      cwd: dir,
      env: {
        YUANLING_MODULE_ID: id,
        YUANLING_TMP: moduleTmpDir(this.root, id),
        YUANLING_API: String(manifest.api ?? '1.0'),
      },
      onLog: ({ level, message }) => {
        appendModuleLog(this.root, id, `[${level}] ${message}`)
        const buf = this.logs.get(id) ?? []
        buf.push(`${localIso()} [${level}] ${message}`)
        this.logs.set(id, buf.slice(-200))
      },
      onState: ({ state, reason }) => {
        // crashed 必须走 recordCrash：它才会写 last_crash。
        // 只调 setState 的话，状态对了但"为什么崩"永久丢失——排查时最需要的就是这条。
        if (state === 'crashed') {
          recordCrash(this.root, id, reason || '未知原因')
        } else {
          setState(this.root, id, state, {})
        }
        appendModuleLog(this.root, id, `state=${state}${reason ? ` ${reason}` : ''}`)
        appendEvent(this.root, {
          kind: `module.${state}`,
          level: state === 'crashed' ? 'error' : state === 'stopped' ? 'info' : 'info',
          actor: 'core',
          module: id,
          text: `状态 → ${state}${reason ? `（${reason}）` : ''}`,
        })
      },
      onRequest: (req) => this.handleModuleRequest(id, req),
      spawnImpl: this.spawnImpl,
    })

    ensureDir(moduleTmpDir(this.root, id))
    this.procs.set(id, proc)
    proc.start()
    try {
      await proc.init({ id, api: manifest.api ?? '1.0', config: readModuleConfig(this.root, id), granted: grantedOf(entry), tmp: moduleTmpDir(this.root, id) })
    } catch (error) {
      appendModuleLog(this.root, id, `握手失败：${error?.message ?? error}`)
            throw error
    }
    return { started: true }
  }

  /** 模块 → 核心的请求分发（能力门控在这里，协议 §5.1 + §12）。 */
  async handleModuleRequest(id, { op, data }) {
    const reg = readRegistry(this.root)
    const granted = grantedOf(reg.modules[id])
    const need = {
      ingest: 'ingest.message',
      'propose.fact': 'propose.fact',
      'media.put.file': 'media.put.file',
      'media.get': 'media.read',
      actuate: 'actuate',
      // v1.5：取/回执主动开口的待发队列。和 send 同一份权利（都是"往外说话"），
      // 但单独一个词：只做投递的模块可以只申请 send，不申请 outbox。
      'outbox.fetch': 'outbox',
      'outbox.ack': 'outbox',
      // v1.6：模块要替她发消息，必须先过核心的闸门（rules/action + 名单 + 配额）。
      // 用的是 send 这份权利：能发消息的模块才需要它。
      'egress.request': 'send',
    }[op]

    if (need && !granted.includes(need)) {
      const e = new Error(`能力未授予：${need}`)
      e.code = 'E_NO_CAP'
      throw e
    }

    if (op === 'config.get') return readModuleConfig(this.root, id)

    if (op === 'log') {
      // 协议 §5.1：log.data 上限 4KB，超限截断并打标记。
      // 不截的话一个模块能靠日志把磁盘写满——这不是理论风险，是"忘了限流"的必然结果。
      let payload = ''
      try {
        payload = JSON.stringify(data?.data ?? {})
      } catch {
        payload = '(不可序列化)'
      }
      let truncated = false
      if (payload.length > LOG_DATA_MAX) {
        payload = `${payload.slice(0, LOG_DATA_MAX)}…(截断)`
        truncated = true
      }
      appendModuleLog(
        this.root,
        id,
        `[${data?.level ?? 'info'}] ${String(data?.event ?? '')} ${payload}${truncated ? ' [truncated]' : ''}`,
      )
      return {}
    }

    if (op === 'ingest') {
      // 协议 §5.1：单批 items ≤ 100。超了直接拒，让模块自己分批——
      // 悄悄截断会让模块以为全写进去了，丢数据还不报错。
      const items = Array.isArray(data?.items) ? data.items : []
      if (items.length > INGEST_BATCH_MAX) {
        const e = new Error(`单批 items 不得超过 ${INGEST_BATCH_MAX} 条（收到 ${items.length}）`)
        e.code = 'E_BATCH'
        throw e
      }
      if (!this.handlers.onIngest) throw new Error('核心未配置 ingest 处理器')
      return this.handlers.onIngest({ id, data })
    }
    if (op === 'propose.fact') {
      if (!this.handlers.onPropose) throw new Error('核心未配置 propose 处理器')
      return this.handlers.onPropose({ id, data })
    }

    // v1.5：主动开口的待发队列。队列由核心算，**发不发、发没发出去只有模块知道**，
    // 所以这里只做两件事：交给它（claimed）、听它回报（sent / 重试 / 放弃）。
    if (op === 'outbox.fetch') {
      if (!this.handlers.onOutboxFetch) throw new Error('核心未配置 outbox 处理器')
      return this.handlers.onOutboxFetch({ id, data })
    }
    if (op === 'outbox.ack') {
      if (!this.handlers.onOutboxAck) throw new Error('核心未配置 outbox 处理器')
      return this.handlers.onOutboxAck({ id, data })
    }

    // v1.6：出站准入。模块**不得自己决定发什么**——先把要发的内容交给核心，
    // 核心跑完闸门才回 ok；模块拿到 ok 才去投递。被拒时核心不落正文、只记原因。
    if (op === 'egress.request') {
      if (!this.handlers.onEgress) throw new Error('核心未配置 egress 处理器')
      return this.handlers.onEgress({ id, data })
    }

    // 协议 §13：媒体入库 / 出库。模块只碰自己的临时目录，核心决定存哪。
    if (op === 'media.put.file') {
      if (!this.handlers.onMediaPut) throw new Error('核心未配置媒体处理器')
      const now = Date.now()
      const times = (this.mediaTimes.get(id) ?? []).filter((x) => now - x < 60_000)
      if (times.length >= 20) {
        const e = new Error('media.put.file 太快了（每分钟最多 20 次），稍后再试')
        e.code = 'E_RATE'
        e.retry = true
        throw e
      }
      times.push(now)
      this.mediaTimes.set(id, times)
      return this.handlers.onMediaPut({ id, data })
    }
    if (op === 'media.get') {
      if (!this.handlers.onMediaGet) throw new Error('核心未配置媒体处理器')
      return this.handlers.onMediaGet({ id, data })
    }

    // v1.4：模块回报自己的健康项（诊断页把它们并进核心那份清单）。
    // 不需要能力：这是**报告**，不是动作；但限额很硬——一个模块不能靠诊断把页面刷满。
    if (op === 'diag.report') {
      return this.reportDiag(id, data)
    }

    throw new Error(`宿主不支持的操作：${op}`)
  }

  /**
   * 模块自报诊断项（协议 v1.4）。
   *
   * 形状：`{ op:"diag.report", data:{ items:[{ code, level, hint, detail? }] } }`
   * 纪律（三条都是硬性，超了直接改掉而不是放行）：
   *   ① 一次最多 20 条，`code` ≤60 字、`hint` ≤200 字；
   *   ② **整份替换**，不是累加——模块重算一遍比核心帮它做增量合并更可靠；
   *   ③ 带 TTL：15 分钟没再报，就当它不再成立（进程死了诊断不能还绿着）。
   */
  reportDiag(id, data) {
    const items = Array.isArray(data?.items) ? data.items : []
    const clipped = items.slice(0, DIAG_MAX_ITEMS).map((x) => ({
      code: String(x?.code ?? 'module.reported').slice(0, 60),
      level: ['info', 'warn', 'error'].includes(x?.level) ? x.level : 'info',
      hint: String(x?.hint ?? '').slice(0, DIAG_HINT_MAX),
      ...(x?.detail && typeof x.detail === 'object' ? { detail: x.detail } : {}),
    }))
    writeJsonAtomic(path.join(moduleDir(this.root, id), 'diag.json'), {
      at: localIso(),
      items: clipped,
    })
    return { accepted: clipped.length, truncated: items.length > DIAG_MAX_ITEMS }
  }

  /**
   * 读模块自报的诊断项：过期（默认 15 分钟）就当成"没在报"，不返回。
   * 过期必须消失——模块崩了之后它自己报的"一切正常"还挂在页面上，
   * 比没有诊断更糟（假绿）。
   */
  readModuleDiag(id, { now = Date.now(), ttlMs = DIAG_TTL_MS } = {}) {
    const p = path.join(moduleDir(this.root, id), 'diag.json')
    const rec = readJson(p, null)
    if (!rec || !Array.isArray(rec.items)) return { items: [], at: null, stale: false }
    const at = Date.parse(String(rec.at ?? ''))
    const stale = !Number.isFinite(at) || now - at > ttlMs
    return { items: stale ? [] : rec.items, at: rec.at ?? null, stale }
  }

  notifyCrash(id, reason) {
    recordCrash(this.root, id, reason || '未知原因')
    appendModuleLog(this.root, id, `crashed: ${reason}`)
    appendEvent(this.root, {
      kind: 'module.crash',
      level: 'error',
      actor: 'core',
      module: id,
      text: `模块崩了：${reason || '未知原因'}`,
      data: { reason: String(reason || '') },
    })
  }

  /** 停一个模块（不写 enabled，仅本次运行）。 */
  async stop(id) {
    const proc = this.procs.get(id)
    if (!proc) return { stopped: false }
    await proc.stop()
    this.procs.delete(id)
    return { stopped: true }
  }

  /**
   * 重启一个模块：停掉再起。
   *
   * 为什么需要它：协议 §3.1 规定**配置变更的唯一生效方式是 shutdown + 重新 spawn + init**。
   * 所以页面保存配置之后，只"确保它跑着"是不够的——跑着的还是旧配置。
   *
   * 停用状态的模块不重启（配置照样存盘，等启用时再读）。
   */
  async restart(id) {
    const reg = readRegistry(this.root)
    const entry = reg.modules[id]
    if (!entry) throw new Error(`没有这个模块：${id}`)
    if (entry.enabled === false) return { skipped: 'disabled' }
    await this.stop(id)
    return this.start(id)
  }

  /** 启动时拉起所有 enabled 的模块。返回每条的启动结果（失败不致命）。 */
  async startEnabled() {
    const reg = readRegistry(this.root)
    const results = []
    for (const id of listIds(reg)) {
      if (reg.modules[id].enabled === false) continue
      try {
        results.push({ id, ...(await this.start(id)) })
      } catch (error) {
        results.push({ id, error: String(error?.message ?? error) })
      }
    }
    return results
  }

  /** 关停全部（插件 dispose 时调用）。 */
  async stopAll() {
    for (const id of [...this.procs.keys()]) {
      await this.stop(id)
    }
  }

  /**
   * 向模块要一次数据并落 raw（协议 §5.2.2，v1.1）。
   *
   * 顺序是刻意的：**先落盘，再返回**。调用方（模型）看到的每条都带指针，
   * 所以"她查过什么"这件事本身留在原始层里，下次 recall 得到的是同一批记录。
   *
   * @returns {{sourceId:string, moduleId:string, records:Array, truncated:boolean, total:number}}
   */
  async fetchSource({ source, params = {}, limit } = {}) {
    const { moduleId, spec } = resolveSource(this.root, source)
    const entry = readRegistry(this.root).modules[moduleId]

    if (!grantedOf(entry).includes('provide.source')) {
      throw fetchError('E_NO_CAP', `模块「${moduleId}」没被授予 provide.source（在管理台或 CLI 里补授）`)
    }
    const proc = this.procs.get(moduleId)
    if (!proc?.child) {
      // 没在运行就取不到。用 E_NO_ROUTE 而不是"假装返回空"：空结果会被模型当成"确实没有"
      throw fetchError('E_NO_ROUTE', `模块「${moduleId}」没在运行，取不到数据（先启用它）`)
    }
    if (!this.consumeFetchRate(moduleId)) {
      throw fetchError('E_RATE', `模块「${moduleId}」被取得太频繁了（每分钟最多 ${FETCH_RATE.limit} 次）`)
    }

    const reply = await proc.request(
      'source.fetch',
      { source: spec.id, params, limit: limit ?? FETCH_MAX_ITEMS },
      { timeoutMs: 30_000 },
    )
    const { items, truncated, total } = normalizeReply({ moduleId, sourceId: spec.id, reply, limit })

    const ackedAt = localIso()
    const { records } = storeFetched(this.root, { moduleId, sourceId: spec.id, items, ackedAt })
    appendModuleLog(this.root, moduleId, `source.fetch ${spec.id} → ${records.length}/${total} 条已落 raw${truncated ? '（截断）' : ''}`)
    appendEvent(this.root, {
      kind: 'source.fetch',
      actor: 'model:fetch',
      module: moduleId,
      text: `取数 ${spec.id} → ${records.length}/${total} 条已落 raw${truncated ? '（截断）' : ''}`,
      data: { sourceId: spec.id, stored: records.length, total, truncated },
    })

    return { sourceId: spec.id, moduleId, records, truncated, total }
  }

  /** 简单计数窗口。进程内即可——"每分钟几次"不是需要持久化的事实。 */
  consumeFetchRate(id, now = Date.now()) {
    const list = (this.fetchTimes.get(id) ?? []).filter((t) => now - t < FETCH_RATE.windowMs)
    if (list.length >= FETCH_RATE.limit) {
      this.fetchTimes.set(id, list)
      return false
    }
    list.push(now)
    this.fetchTimes.set(id, list)
    return true
  }

  /**
   * 取一次模块自定义 tab 的数据（协议 v1.2 的 `ui.get`）。
   *
   * 只读：核心拿回**纯数据**，怎么画由核心定，模块没有任何机会往页面里塞标记。
   * 没声明这个 tab、或模块没在跑 → 直接报错，不返回空内容：
   * 否则页面显示"这个 tab 是空的"，看起来像模块坏了。
   */
  async uiGet(id, tabId) {
    const entry = readRegistry(this.root).modules[id]
    if (!entry) throw uiError('E_NO_ROUTE', `没有这个模块：${id}`)

    const manifest = readJson(path.join(moduleDir(this.root, id), 'yuanling.module.json'), null)
    const tab = (manifest?.ui?.tabs ?? []).find((t) => t.id === String(tabId ?? ''))
    if (!tab) throw uiError('E_NO_ROUTE', `模块「${id}」没有声明 tab「${tabId}」`)

    // `config` 型 tab 是核心自己渲染的配置表单：不需要模块进程，也不问它要数据。
    // 所以它**在模块停用时照样能用**——这正是把它放成页面而不是放成模块 API 的意义。
    if (tab.kind === 'config') {
      const all = describeFields(manifest?.config?.schema)
      // 认领了字段就只给这些（按声明的顺序），没认领就给全部
      const wanted = Array.isArray(tab.fields) && tab.fields.length ? tab.fields : null
      const fields = wanted ? wanted.map((k) => all.find((f) => f.key === k)).filter(Boolean) : all
      return { tab: tab.id, kind: 'config', config: readModuleConfigFromManage(this.root, id), fields }
    }

    // `records` 型 tab：核心查自己的原始层，**强制只查这个模块自己的记录**。
    // 同样不需要模块进程——点赞记录在她停着的时候也该能看。
    if (tab.kind === 'records') {
      const spec = tab.records ?? {}
      const r = queryRecords(this.root, { module: id, type: spec.type, limit: spec.limit })
      return { tab: tab.id, kind: 'records', ...r }
    }

    const proc = this.procs.get(id)
    if (!proc?.child) throw uiError('E_NO_ROUTE', `模块「${id}」没在运行，取不到它的界面数据`)

    const reply = await proc.request('ui.get', { tab: tab.id }, { timeoutMs: 15_000 })
    // 模块可能回 `{data: ...}` 也可能直接回结果；两种都收，少一个坑
    const payload = reply && typeof reply === 'object' && 'data' in reply ? reply.data : reply
    return { tab: tab.id, ...normalizeUiPayload(tab.kind, payload) }
  }

  /**
   * 导出一个模块为 tgz（用户要求的"可整体导出"）。
   * 落到 system/exports/<id>-<version>.tgz，返回路径与 sha256。
   */
  exportModule(id, { dir = null } = {}) {
    const reg = readRegistry(this.root)
    const entry = reg.modules[id]
    if (!entry) throw new Error(`没有这个模块：${id}`)

    const src = moduleDir(this.root, id)
    if (!exists(src)) throw new Error(`模块目录不存在：${src}`)

    const outDir = dir ?? path.join(this.root, P.exports)
    ensureDir(outDir)
    const dest = path.join(outDir, `${id}-${entry.version}.tgz`)

    const bytes = packDirToTgz(src)
    fs.writeFileSync(dest, bytes)
    appendModuleLog(this.root, id, `exported → ${dest}`)
    return { path: dest, bytes: bytes.length, sha256: sha256Of(bytes) }
  }

  /** 健康摘要（管理台首页能一眼看到"有没有模块在崩"）。 */
  summary() {
    const list = this.list()
    return {
      total: list.length,
      running: list.filter((m) => m.state === 'ready' || m.state === 'running').length,
      crashed: list.filter((m) => m.state === 'crashed').length,
      disabled: list.filter((m) => !m.enabled).length,
    }
  }
}

// ── 打包成 tgz（导出用）────────────────────────────────────────────────

/** 极简 tar 写入：只写普通文件。导出给"换机器"用，不需要保留符号链接。 */
function packDirToTgz(dir, { prefix = 'package/' } = {}) {
  const blocks = []
  const walk = (cur, relBase) => {
    for (const name of fs.readdirSync(cur).sort()) {
      const full = path.join(cur, name)
      const rel = relBase ? `${relBase}/${name}` : name
      const st = fs.statSync(full)
      if (st.isDirectory()) {
        // 目录也写一条，保留空目录
        blocks.push(tarHeader(`${prefix}${rel}/`, 0))
        walk(full, rel)
      } else if (st.isFile()) {
        const data = fs.readFileSync(full)
        blocks.push(tarHeader(`${prefix}${rel}`, data.length), data)
        const pad = (512 - (data.length % 512)) % 512
        if (pad) blocks.push(Buffer.alloc(pad))
      }
    }
  }
  walk(dir, '')
  blocks.push(Buffer.alloc(1024))
  return zlib.gzipSync(Buffer.concat(blocks))
}

/** 512 字节 tar 头：name/size/type/mode/ustar。 */
function tarHeader(name, size) {
  const h = Buffer.alloc(512)
  const put = (str, off, len) => h.write(String(str).slice(0, len), off, len)
  put(name, 0, 100)
  put('0000644\u0000', 100, 8) // mode
  put('0000000\u0000', 108, 8) // uid
  put('0000000\u0000', 116, 8) // gid
  // size 八进制（11 位含结尾 NUL）——这是 tar 的规定，写十进制会解出错误的长度
  h.write(`${size.toString(8).padStart(10, '0')}\u0000`, 124, 11)
  h.write('00000000000\u0000', 136, 12) // mtime 占位
  h.write('0', 156, 1) // typeflag：普通文件
  put('ustar\u0000', 257, 6)
  put('00', 263, 2)

  // checksum：先把该字段（148..155，共 8 字节）置零，再对整个头求和
  h.fill(0, 148, 156)
  let sum = 0
  for (let i = 0; i < 512; i += 1) sum += h[i]
  // 标准写法：7 位八进制 + NUL + 空格，**正好 8 字节**。
  // 写成 9 字节会越界覆盖 156 的 typeflag，解包时就报"特殊成员"。
  h.write(`${sum.toString(8).padStart(7, '0')}\u0000 `, 148, 8)
  return h
}
