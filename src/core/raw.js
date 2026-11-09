// src/core/raw.js —— L0 原始层：只追加、按天分目录、按来源分文件、封存与校验。
//
// 三条不变式：
//   ① 只追加。没有 update / delete，墓碑也是追加一条 redact。
//   ② 单写者。只有本进程写，其他进程走 inbox。
//   ③ 每条记录带 ULID（指针锚点）与 h（幂等键）。
import fs from 'node:fs'
import path from 'node:path'
import { exists, isDir, ensureDir, readJson, writeJsonAtomic, sha256, ulid, localIso } from './fsx.js'
import { P } from './paths.js'

/** 单文件分片阈值（文档 §5.1）。 */
export const MAX_RAW_BYTES = 32 * 1024 * 1024

const DAY_RE = /^(\d{4})-(\d{2})-(\d{2})$/

export function assertDay(dateStr) {
  const m = DAY_RE.exec(String(dateStr))
  if (!m) throw new Error(`日期格式必须是 YYYY-MM-DD：${dateStr}`)
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]))
  if (Number.isNaN(d.getTime())) throw new Error(`非法日期：${dateStr}`)
  return { y: m[1], m: m[2], d: m[3], month: `${m[1]}-${m[2]}` }
}

/** 当天目录的绝对路径。 */
export function dayDirFor(root, dateStr) {
  const { month, d } = assertDay(dateStr)
  return path.join(root, P.raw, month, d)
}

/** 当天目录的相对路径（写进指针里，永远是相对 root）。 */
export function relDayDir(dateStr) {
  const { month, d } = assertDay(dateStr)
  return `${P.raw}/${month}/${d}`
}

/** 今天（本地时区）。 */
export function today(now = new Date()) {
  const p2 = (n) => String(n).padStart(2, '0')
  return `${now.getFullYear()}-${p2(now.getMonth() + 1)}-${p2(now.getDate())}`
}

/** 列出所有已存在的日期（升序）。 */
export function listDays(root) {
  const base = path.join(root, P.raw)
  if (!isDir(base)) return []
  const out = []
  for (const month of fs.readdirSync(base).sort()) {
    if (!/^\d{4}-\d{2}$/.test(month)) continue
    const mdir = path.join(base, month)
    if (!isDir(mdir)) continue
    for (const dd of fs.readdirSync(mdir).sort()) {
      if (!/^\d{2}$/.test(dd)) continue
      if (isDir(path.join(mdir, dd))) out.push(`${month}-${dd}`)
    }
  }
  return out.sort()
}

/** 前一天的日期字符串（用于日链）。 */
export function prevDate(dateStr) {
  const { y, m, d } = assertDay(dateStr)
  const t = new Date(Number(y), Number(m) - 1, Number(d))
  t.setDate(t.getDate() - 1)
  const p2 = (n) => String(n).padStart(2, '0')
  return `${t.getFullYear()}-${p2(t.getMonth() + 1)}-${p2(t.getDate())}`
}

/** 该月之前、最近一个有 day.json 的日期（用于月链）。 */
export function prevMonthAnchor(root, month) {
  const first = `${month}-01`
  const days = listDays(root).filter((d) => d < first)
  for (let i = days.length - 1; i >= 0; i -= 1) {
    const dj = readJson(path.join(dayDirFor(root, days[i]), 'day.json'), null)
    if (dj) return { date: days[i], day: dj }
  }
  return null
}

/** 稳定序列化（键排序），用于链上的摘要，保证跨机器一致。 */
export function canonical(obj) {
  if (obj === null || typeof obj !== 'object') return JSON.stringify(obj)
  if (Array.isArray(obj)) return '[' + obj.map(canonical).join(',') + ']'
  const keys = Object.keys(obj).sort()
  return '{' + keys.map((k) => JSON.stringify(k) + ':' + canonical(obj[k])).join(',') + '}'
}

/** 记录的内容指纹：同一内容重复投递时用它去重。 */
export function recordHash(rec) {
  const basis = {
    type: rec.type ?? 'message',
    source: rec.source ?? '',
    acct: rec.acct ?? '',
    channel: rec.channel ?? '',
    actor: rec.actor?.id ?? rec.actor?.name ?? '',
    ts: rec.ts ?? '',
    text: rec.text ?? '',
  }
  return sha256(Buffer.from(canonical(basis), 'utf8'))
}

// ── 去重缓存 ────────────────────────────────────────────────────────────
// 按「root + 日期」缓存当天已出现过的 h → 它落在哪个文件。
// 存文件不是多余的：去重时调用方仍需要一个合法指针，否则拿不到 file 就拼不出 src。
const seenCache = new Map()

function seenKey(root, dateStr) {
  return `${path.resolve(root)}::${dateStr}`
}

function seenMap(root, dateStr) {
  const key = seenKey(root, dateStr)
  let map = seenCache.get(key)
  if (map) return map
  map = new Map()
  const dir = dayDirFor(root, dateStr)
  if (isDir(dir)) {
    for (const name of fs.readdirSync(dir)) {
      if (!name.endsWith('.ndjson')) continue
      const buf = fs.readFileSync(path.join(dir, name), 'utf8')
      for (const line of buf.split('\n')) {
        if (!line.trim()) continue
        try {
          const r = JSON.parse(line)
          if (r.h) map.set(r.h, { file: `${relDayDir(dateStr)}/${name}`, id: r.id })
        } catch {
          /* 坏行跳过，不阻塞 */
        }
      }
    }
  }
  seenCache.set(key, map)
  return map
}

/** 选中要写的分片：超过阈值就往 qq-p2.ndjson 顺延。 */
export function pickShard(root, dateStr, source, maxBytes = MAX_RAW_BYTES) {
  const dir = dayDirFor(root, dateStr)
  ensureDir(dir)
  for (let n = 0; n < 1000; n += 1) {
    const name = n === 0 ? `${source}.ndjson` : `${source}-p${n + 1}.ndjson`
    const abs = path.join(dir, name)
    if (!exists(abs)) return { abs, name, shard: n + 1 }
    if (fs.statSync(abs).size < maxBytes) return { abs, name, shard: n + 1 }
  }
  throw new Error(`分片过多：${source}`)
}

/**
 * 追加一条记录。
 * @param {string} root
 * @param {object} input 至少要有 source / actor；其余缺失会被补默认值
 * @param {{maxBytes?: number, now?: string}} opts
 * @returns {{ok:boolean, id?:string, file?:string, deduped?:boolean, skip?:string}}
 */
export function appendRecord(root, input, { maxBytes = MAX_RAW_BYTES, now } = {}) {
  if (!input || typeof input !== 'object') throw new Error('记录必须是对象')
  const source = String(input.source ?? '').trim()
  if (!source) throw new Error('记录缺少 source')

  const ts = input.ts ? String(input.ts) : now ?? localIso()
  const dateStr = today(new Date(ts))
  const rec = {
    v: 2,
    type: input.type ?? 'message',
    id: input.id ?? ulid(),
    ts,
    source,
    acct: String(input.acct ?? 'default'),
    channel: String(input.channel ?? 'unknown'),
    actor: normalizeActor(input.actor),
    role: input.role ?? 'user',
    text: String(input.text ?? ''),
    reply_to: input.reply_to ?? null,
    media: Array.isArray(input.media) ? input.media : [],
    flags: Array.isArray(input.flags) ? [...new Set(input.flags)] : [],
    h: '',
    ext: input.ext && typeof input.ext === 'object' ? input.ext : {},
  }
  rec.h = input.h ?? recordHash(rec)

  // 单行截断：超长工具结果会把一行撑到几十 MB，读一次就卡死。
  // 截断了要留痕（flags + 长度），不能悄悄切。
  const LIMIT = 256 * 1024
  if (rec.text.length > LIMIT) {
    const original = rec.text.length
    rec.text = rec.text.slice(0, LIMIT) + `…[截断，原长 ${original} 字符]`
    if (!rec.flags.includes('truncated')) rec.flags.push('truncated')
    rec.h = recordHash(rec)
  }

  const seen = seenMap(root, dateStr)
  if (seen.has(rec.h)) {
    // 去重要给出**原来那条**的 id 与文件：指针必须能解析回已经存在的记录。
    // （旧实现回的是本次新生成的 id，拼出来的指针指向一个不存在的行——踩过）
    const hit = seen.get(rec.h)
    return { ok: true, deduped: true, id: hit?.id ?? rec.id, file: hit?.file ?? null }
  }

  const { abs, name } = pickShard(root, dateStr, source, maxBytes)
  fs.appendFileSync(abs, JSON.stringify(rec) + '\n', 'utf8')
  const rel = `${relDayDir(dateStr)}/${name}`
  seen.set(rec.h, { file: rel, id: rec.id })
  return { ok: true, id: rec.id, file: rel, deduped: false }
}

function normalizeActor(a) {
  if (typeof a === 'string') return { kind: a, id: '', name: '' }
  const kind = a?.kind ?? 'member'
  return { kind, id: String(a?.id ?? ''), name: String(a?.name ?? '') }
}

/**
 * 追加一条系统事件（redact / unredact / purge 等）。
 * 与消息不同，系统事件**不做去重**——同一个目标被屏蔽两次是两件事。
 * 落在当天的 system.ndjson 里，仍然是 raw 的一部分（只追加、可审计）。
 */
export function appendSystemEvent(root, { type, targets = [], by = 'owner', reason = '', ts } = {}) {
  if (!type) throw new Error('系统事件缺少 type')
  const when = ts ?? localIso()
  const dateStr = today(new Date(when))
  const { abs, name } = pickShard(root, dateStr, 'system')
  const rec = { v: 2, type, id: ulid(), ts: when, source: 'system', targets, by, reason }
  fs.appendFileSync(abs, JSON.stringify(rec) + '\n', 'utf8')
  return { ...rec, file: `${relDayDir(dateStr)}/${name}` }
}

/** 读某一天的全部记录（可按来源过滤）。坏行只跳过、不抛。 */
export function readDay(root, dateStr, { source } = {}) {
  const dir = dayDirFor(root, dateStr)
  if (!isDir(dir)) return []
  const out = []
  const names = fs
    .readdirSync(dir)
    .filter((n) => n.endsWith('.ndjson'))
    .filter((n) => (source ? n === `${source}.ndjson` || n.startsWith(`${source}-p`) : true))
    .sort()
  for (const name of names) {
    const buf = fs.readFileSync(path.join(dir, name), 'utf8')
    for (const line of buf.split('\n')) {
      if (!line.trim()) continue
      try {
        out.push(JSON.parse(line))
      } catch {
        /* 坏行 */
      }
    }
  }
  return out
}

/**
 * 封存某一天：算 sha256、写 day.json、设只读。
 * 幂等：已有 sealed 的 day.json 直接返回。
 */
export function sealDay(root, dateStr, { now = localIso() } = {}) {
  const dir = dayDirFor(root, dateStr)
  if (!isDir(dir)) throw new Error(`当天目录不存在：${dateStr}`)
  const dayJsonPath = path.join(dir, 'day.json')
  const existing = readJson(dayJsonPath, null)
  if (existing?.sealed) return { sealed: false, reason: 'already-sealed', day: existing }

  const files = {}
  for (const name of fs
    .readdirSync(dir)
    .filter((n) => n.endsWith('.ndjson'))
    .sort()) {
    const buf = fs.readFileSync(path.join(dir, name))
    files[name] = {
      lines: buf.toString('utf8').split('\n').filter((l) => l.trim()).length,
      bytes: buf.length,
      sha256: sha256(buf),
    }
  }

  const prev = prevDate(dateStr)
  const prevDay = readJson(path.join(dayDirFor(root, prev), 'day.json'), null)
  const anchor = prevMonthAnchor(root, assertDay(dateStr).month)

  const day = {
    date: dateStr,
    tz: tzOffset(now),
    sealed: true,
    sealed_at: now,
    files,
    cursor: { extract: {} },
    prev_day: prevDay ? sha256(Buffer.from(canonical(prevDay), 'utf8')) : null,
    month: assertDay(dateStr).month,
    prev_month: anchor ? sha256(Buffer.from(canonical(anchor.day), 'utf8')) : null,
  }
  writeJsonAtomic(dayJsonPath, day)

  for (const name of Object.keys(files)) {
    try {
      fs.chmodSync(path.join(dir, name), 0o444)
    } catch {
      /* Windows 上语义有限，忽略 */
    }
  }
  return { sealed: true, day }
}

function tzOffset(iso) {
  const m = /([+-]\d{2}:\d{2})$/.exec(String(iso))
  return m ? m[1] : '+00:00'
}

/**
 * 校验某一天：文件 hash、行数、与前一天的链。
 * @returns {{ok:boolean, errors:Array, warnings:Array}}
 */
export function verifyDay(root, dateStr) {
  const dir = dayDirFor(root, dateStr)
  const errors = []
  const warnings = []
  const day = readJson(path.join(dir, 'day.json'), null)
  if (!day) {
    errors.push({ code: 'NO_DAY_JSON', message: `${dateStr} 没有 day.json（可能没封存）` })
    return { ok: false, errors, warnings }
  }
  for (const [name, meta] of Object.entries(day.files ?? {})) {
    const abs = path.join(dir, name)
    if (!exists(abs)) {
      errors.push({ code: 'FILE_MISSING', message: `${name} 不存在` })
      continue
    }
    const buf = fs.readFileSync(abs)
    const actual = sha256(buf)
    if (actual !== meta.sha256) {
      errors.push({ code: 'HASH_MISMATCH', message: `${name} 的 hash 与 day.json 不一致（文件被改过）` })
    }
    const lines = buf.toString('utf8').split('\n').filter((l) => l.trim()).length
    if (typeof meta.lines === 'number' && lines !== meta.lines) {
      errors.push({ code: 'LINE_MISMATCH', message: `${name} 行数 ${lines} ≠ 记录 ${meta.lines}` })
    }
  }
  if (day.prev_day) {
    const prev = prevDate(dateStr)
    const prevJson = readJson(path.join(dayDirFor(root, prev), 'day.json'), null)
    if (!prevJson) {
      warnings.push({ code: 'PREV_DAY_MISSING', message: `前一天 ${prev} 的 day.json 不在（可能已归档）` })
    } else {
      const expect = sha256(Buffer.from(canonical(prevJson), 'utf8'))
      if (expect !== day.prev_day) {
        errors.push({ code: 'CHAIN_BROKEN', message: `与前一天的链对不上（${prev}）` })
      }
    }
  }
  return { ok: errors.length === 0, errors, warnings }
}

/** 清掉去重缓存（测试用；换 root 时其实 key 已经区分了）。 */
export function _resetSeenCache() {
  seenCache.clear()
}

/**
 * 最近的消息，带可直接使用的指针。
 * 手动测试与排障用：不用自己拼 `raw/…/qq.ndjson#ULID`。
 */
/**
 * 原始层里出现过的频道（最近 N 天，按最近一次活动倒序）。
 *
 * 用途：管理台的「注入预览」要让人能挑一个真实频道看效果。手打频道名容易打错，
 * 而打错的频道和"没有这个频道"在页面上长得一样——都是同一份通用预览，看不出输入无效。
 *
 * @returns {Array<{channel:string, messages:number, lastAt:string}>}
 */
export function listChannels(root, { days = 30, limit = 50 } = {}) {
  const seen = new Map()
  const recent = listDays(root).slice(-Math.max(1, days))
  for (const date of recent) {
    for (const r of readDay(root, date)) {
      if ((r.type ?? 'message') !== 'message') continue
      const ch = String(r.channel ?? '')
      if (!ch) continue
      const cur = seen.get(ch) ?? { channel: ch, messages: 0, lastAt: null }
      cur.messages += 1
      const ts = String(r.ts ?? '')
      if (!cur.lastAt || ts > cur.lastAt) cur.lastAt = ts
      seen.set(ch, cur)
    }
  }
  return [...seen.values()]
    .sort((a, b) => String(b.lastAt).localeCompare(String(a.lastAt)))
    .slice(0, limit)
}

export function recentMessages(root, { limit = 5, source = null } = {}) {
  const out = []
  const days = listDays(root).slice(-3).reverse()
  for (const date of days) {
    const dir = dayDirFor(root, date)
    if (!isDir(dir)) continue
    const names = fs
      .readdirSync(dir)
      .filter((n) => n.endsWith('.ndjson'))
      .filter((n) => (source ? n === `${source}.ndjson` || n.startsWith(`${source}-p`) : true))
      .sort()
    const rows = []
    for (const name of names) {
      const buf = fs.readFileSync(path.join(dir, name), 'utf8')
      for (const line of buf.split('\n')) {
        if (!line.trim()) continue
        try {
          const r = JSON.parse(line)
          if ((r.type ?? 'message') !== 'message') continue
          rows.push({ r, file: `${relDayDir(date)}/${name}` })
        } catch {
          /* 坏行跳过 */
        }
      }
    }
    rows.sort((a, b) => String(b.r.ts).localeCompare(String(a.r.ts)))
    for (const { r, file } of rows) {
      out.push({ ...r, pointer: `${file}#${r.id}` })
      if (out.length >= limit) return out
    }
  }
  return out
}
