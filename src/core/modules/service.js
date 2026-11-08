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

/** 协议 §5.1：单批 ingest 最多 100 条。超了拒绝，不静默截断（截断会让模块以为全写进去了）。 */
export const INGEST_BATCH_MAX = 100
/** 协议 §5.1：log.data 上限 4KB。不截的话，一个模块能靠日志把磁盘写满。 */
export const LOG_DATA_MAX = 4096

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
  constructor({ root, pid = null, onIngest = null, onSend = null, onPropose = null, spawnImpl = undefined } = {}) {
    this.root = root
    this.pid = pid
    this.handlers = { onIngest, onSend, onPropose }
    this.spawnImpl = spawnImpl
    this.procs = new Map() // id -> ModuleProcess
    this.logs = new Map() // id -> string[] 最近若干行（内存里，页面即时看）
    this.fetchTimes = new Map() // id -> number[] 取数时间戳（限频用）
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
    return r
  }

  remove(id) {
    this.stop(id)
    const r = uninstall(this.root, id)
    this.logs.delete(id)
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
      },
      onRequest: (req) => this.handleModuleRequest(id, req),
      spawnImpl: this.spawnImpl,
    })

    ensureDir(moduleTmpDir(this.root, id))
    this.procs.set(id, proc)
    proc.start()
    try {
      await proc.init({ id, api: manifest.api ?? '1.0', config: readModuleConfig(this.root, id), granted: grantedOf(entry) })
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
      send: 'send',
      actuate: 'actuate',
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
    throw new Error(`宿主不支持的操作：${op}`)
  }

  /** 崩溃时统一入口：写 last_crash + 落日志（两处都要，缺一个排查时就瞎）。 */
  notifyCrash(id, reason) {
    recordCrash(this.root, id, reason || '未知原因')
    appendModuleLog(this.root, id, `crashed: ${reason}`)
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

  /** 发出一个 egress 请求（协议 §5.2 的 send）。 */
  async send(id, payload) {
    const proc = this.procs.get(id)
    if (!proc) throw new Error(`模块未运行：${id}`)
    const granted = grantedOf(readRegistry(this.root).modules[id])
    if (!granted.includes('send')) throw Object.assign(new Error('能力未授予：send'), { code: 'E_NO_CAP' })
    return proc.request('send', payload, { timeoutMs: 30_000 })
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
