// src/core/events.js —— 统一事件流：日志页的唯一数据源。
//
// 为什么要一条流：日志和审计不是两件事，是**同一批数据的两个镜头**。
//   · 日志：最近发生了什么（投递、摄入、模块启停、拒绝、错误）
//   · 审计：其中"谁改了记忆/档案、为什么、能不能退回去"的那一类
// 所以只写一份 `system/log/events.ndjson`，页面按 lens 筛；不另建 audit.ndjson。
//
// **它不是正本**。写入的正本永远在 `system/versions/journal.ndjson`（writeTracked 写的，
// 带 hash/prev/actor/reason）。审计镜头直接读 journal，事件流只承担"运行流水"。
// 这样删掉 events.ndjson 不会丢任何可回滚信息，也不会出现两份互相矛盾的真相。
//
// 写入纪律：日志写不进去**绝不阻塞主流程**（一次磁盘满不该让消息丢失），
// 但会记在 health 里——"审计写不进去"本身就是一条要看到的诊断。
import fs from 'node:fs'
import path from 'node:path'

import { exists, ensureDir, localIso } from './fsx.js'
import { P } from './paths.js'
import { history, trackedPaths } from './version.js'

/** 单个文件到这么大就轮转：1MB × 5 个，总共约 5MB。 */
export const EVENTS_MAX_BYTES = 1024 * 1024
export const EVENTS_MAX_FILES = 5
/** 轮转出去的文件超过这么多天就删。 */
export const EVENTS_RETENTION_DAYS = 90
/** 一次最多返回多少条（页面翻页也够用；再多也没人看得完）。 */
export const EVENTS_READ_MAX = 500

export const EVENT_LEVELS = new Set(['info', 'warn', 'error'])

/** 已知的事件种类。写别的也收（不卡死扩展），页面按这张表分组。 */
export const EVENT_KINDS = [
  'ingest',
  'source.fetch',
  'module.install',
  'module.uninstall',
  'module.start',
  'module.stop',
  'module.crash',
  'module.grant',
  'module.revoke',
  'module.config',
  'refusal',
  'write',
  'error',
]

const sink = {
  writable: true,
  appended: 0,
  lastError: '',
  lastErrorAt: null,
  rotatedAt: null,
}

export function eventsPath(root) {
  return path.join(root, P.events)
}

function rotatedPath(root, i) {
  return `${eventsPath(root)}.${i}`
}

function sizeOf(p) {
  try {
    return fs.statSync(p).size
  } catch {
    return 0
  }
}

/**
 * 轮转：主文件 → .1 → .2 …，最老的删掉。
 * 轮转失败**不截断**（继续往主文件追加）——丢日志比日志文件变大严重得多。
 */
function rotateIfNeeded(root) {
  if (sizeOf(eventsPath(root)) < EVENTS_MAX_BYTES) return
  try {
    const oldest = rotatedPath(root, EVENTS_MAX_FILES - 1)
    if (exists(oldest)) fs.rmSync(oldest, { force: true })
    for (let i = EVENTS_MAX_FILES - 2; i >= 1; i -= 1) {
      const from = rotatedPath(root, i)
      if (!exists(from)) continue
      fs.renameSync(from, rotatedPath(root, i + 1))
    }
    fs.renameSync(eventsPath(root), rotatedPath(root, 1))
    sink.rotatedAt = localIso()
  } catch (error) {
    sink.lastError = `rotate: ${error?.message ?? error}`
    sink.lastErrorAt = localIso()
  }
}

/**
 * 追加一条事件。
 *
 * @param {string} root
 * @param {{kind:string, level?:'info'|'warn'|'error', text?:string, actor?:string, module?:string, ref?:string, data?:object, ts?:string}} entry
 * @returns {{ok:boolean, entry?:object, error?:string}}
 */
export function appendEvent(root, entry = {}) {
  const kind = String(entry?.kind ?? '')
  if (!kind) return { ok: false, error: '事件缺少 kind' }

  const rec = {
    v: 1,
    ts: entry.ts ?? localIso(),
    kind,
    level: EVENT_LEVELS.has(entry.level) ? entry.level : 'info',
    actor: String(entry.actor ?? 'core'),
    ...(entry.module ? { module: String(entry.module) } : {}),
    text: String(entry.text ?? '').slice(0, 2000),
    ...(entry.ref ? { ref: String(entry.ref) } : {}),
    ...(entry.data && typeof entry.data === 'object' ? { data: entry.data } : {}),
    // 清单之外的 kind 照写，但标 ext——扩展不该因为核心的清单没更新就被拒
    ...EVENT_KINDS.includes(kind) || kind.startsWith('module.') ? {} : { ext: true },
  }

  try {
    ensureDir(path.dirname(eventsPath(root)))
    rotateIfNeeded(root)
    fs.appendFileSync(eventsPath(root), `${JSON.stringify(rec)}\n`, 'utf8')
    sink.writable = true
    sink.appended += 1
    return { ok: true, entry: rec }
  } catch (error) {
    // 写不进去不抛：调用它的地方多是"顺手记一笔"，不能让日志故障吃掉消息
    sink.writable = false
    sink.lastError = `write: ${error?.message ?? error}`
    sink.lastErrorAt = localIso()
    return { ok: false, error: sink.lastError }
  }
}

/** 读事件流自己那份"写得进去吗"的健康状态（诊断页会用到）。 */
export function eventsHealth(root) {
  return {
    ...sink,
    path: eventsPath(root),
    bytes: sizeOf(eventsPath(root)),
    files: [eventsPath(root), ...Array.from({ length: EVENTS_MAX_FILES - 1 }, (_, i) => rotatedPath(root, i + 1))].filter(exists),
  }
}

/** 读所有分片里的原始行（主文件最新 → .1 → .2 …），按时间正序返回。 */
function readAllLines(root) {
  const files = [eventsPath(root)]
  for (let i = 1; i < EVENTS_MAX_FILES; i += 1) files.push(rotatedPath(root, i))
  const chunks = []
  for (const p of files) {
    if (!exists(p)) continue
    try {
      chunks.push(fs.readFileSync(p, 'utf8').split('\n').filter((l) => l.trim()))
    } catch {
      /* 读不了就跳过，别让一个坏文件废掉整页 */
    }
  }
  // files 是"新→旧"，按时间正序要反过来
  return chunks.reverse().flat()
}

/** 清掉超过保留期的轮转文件（主文件不动）。 */
export function cleanupEvents(root, { now = Date.now(), days = EVENTS_RETENTION_DAYS } = {}) {
  const cutoff = now - days * 86_400_000
  const removed = []
  for (let i = 1; i < EVENTS_MAX_FILES; i += 1) {
    const p = rotatedPath(root, i)
    if (!exists(p)) continue
    try {
      if (fs.statSync(p).mtimeMs < cutoff) {
        fs.rmSync(p, { force: true })
        removed.push(i)
      }
    } catch {
      /* 删不掉就算了，下次再来 */
    }
  }
  return removed
}

/**
 * 读事件流（运行时流水）。坏行跳过、不抛。
 *
 * @param {{limit?:number, kind?:string|string[], level?:string, module?:string, since?:string, actor?:string}} opts
 */
export function readEvents(root, { limit = 100, kind = null, level = null, module = null, since = null, actor = null } = {}) {
  const kinds = kind ? (Array.isArray(kind) ? kind : [kind]) : null
  const want = Math.max(1, Math.min(EVENTS_READ_MAX, Number(limit) || 100))
  const out = []
  for (const line of readAllLines(root)) {
    let r = null
    try {
      r = JSON.parse(line)
    } catch {
      continue
    }
    if (!r || !r.kind) continue
    if (kinds && !kinds.includes(r.kind)) continue
    if (level && r.level !== level) continue
    if (module && r.module !== module) continue
    if (actor && r.actor !== actor) continue
    if (since && String(r.ts) < String(since)) continue
    out.push(r)
  }
  return out.slice(-want)
}

/**
 * 审计镜头：**直接从版本 journal 读**（正本），不读事件流。
 *
 * 为什么不复用事件流：journal 里每一次写都有 hash / prev / actor / reason，
 * 这些是"能不能回滚"的依据；事件流里的 write 事件只是索引，删了也不该影响回滚。
 *
 * @returns {Array<{ts, kind:'write', actor, reason, path, hash, prev, opId}>}
 */
export function readWrites(root, { limit = 100, since = null, module = null, actor = null } = {}) {
  const want = Math.max(1, Math.min(EVENTS_READ_MAX, Number(limit) || 100))
  const rows = []

  let paths = []
  try {
    paths = trackedPaths(root)
  } catch {
    // 目录还没建、或者被外力改坏：退化成"没有写入记录"，不让整个日志页 500
    paths = []
  }

  for (const rel of paths) {
    for (const e of history(root, rel)) {
      const row = {
        ts: e.ts,
        kind: 'write',
        actor: e.actor ?? '',
        reason: e.reason ?? '',
        path: e.path,
        hash: e.hash,
        prev: e.prev ?? null,
        opId: e.op_id ?? '',
      }
      if (module && !String(row.path).includes(`modules/${module}`)) continue
      if (actor && row.actor !== actor) continue
      if (since && String(row.ts) < String(since)) continue
      rows.push(row)
    }
  }
  rows.sort((a, b) => String(a.ts).localeCompare(String(b.ts)))
  return rows.slice(-want)
}

/**
 * 合并时间线：日志页拿这个。
 *
 * lens 的语义（页面上的筛选按钮就是这几个）：
 *   all      —— 全部（运行流水 + 写入）
 *   write    —— 审计：只看写入
 *   error    —— 只看 error / warn
 *   module   —— 只看模块相关
 *   refusal  —— 只看拒绝
 *
 * @returns {{items:Array, counts:object, lens:string}}
 */
export function readTimeline(root, { lens = 'all', limit = 200, since = null, module = null } = {}) {
  const want = Math.max(1, Math.min(EVENTS_READ_MAX, Number(limit) || 200))
  const events = readEvents(root, { limit: want, since, module })
  const writes = readWrites(root, { limit: want, since, module })

  let items = []
  if (lens === 'write') items = writes
  else if (lens === 'error') items = events.filter((e) => e.level === 'error' || e.level === 'warn')
  else if (lens === 'module') items = events.filter((e) => e.module || String(e.kind).startsWith('module.'))
  else if (lens === 'refusal') items = events.filter((e) => e.kind === 'refusal')
  else {
    items = [...events, ...writes]
    items.sort((a, b) => String(a.ts).localeCompare(String(b.ts)))
  }
  items = items.slice(-want)

  // 统计条（页面顶部那几个数字；后期换成图形化也是读这份）
  const all = [...events, ...writes]
  const counts = {
    total: all.length,
    events: events.length,
    writes: writes.length,
    warn: all.filter((x) => x.level === 'warn').length,
    error: all.filter((x) => x.level === 'error').length,
    refusals: all.filter((x) => x.kind === 'refusal').length,
    modules: [...new Set(all.filter((x) => x.module).map((x) => x.module))].length,
  }
  return { items, counts, lens }
}
