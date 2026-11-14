// src/core/purposes.js —— 目的账本：那些"还没说完的话"。
//
// 和 surfcore 最大的不同：**每条目的必须带 origin 指针**，能翻回 raw 里那句话。
// 它的素材是记忆摘要，答不出"我为什么突然问这个"；我们要答得出。
//
// 生命周期只有三档：open（惦记着）→ done（提过了/结了）/ dropped（不想提了）。
// 没有 surfcore 的九种状态、没有目标假设树——那些是为"独立模型回合"服务的，我们用不上。
import path from 'node:path'
import { readJson, writeJsonAtomic, localIso, ulid } from './fsx.js'
import { P } from './paths.js'
import { matchDrive } from './drives.js'

export const PURPOSES_VERSION = 1
export const PURPOSE_TTL_DAYS = 14
export const MAX_OPEN = 12
export const PURPOSE_MAX_BYTES = 120

const DAY = 86_400_000

export function purposesPath(root, pid) {
  return path.join(root, P.personas, pid, 'self', 'purposes.json')
}

export function readPurposes(root, pid) {
  const j = readJson(purposesPath(root, pid), null)
  return { version: PURPOSES_VERSION, items: Array.isArray(j?.items) ? j.items : [] }
}

export function writePurposes(root, pid, doc) {
  writeJsonAtomic(purposesPath(root, pid), doc)
  return doc
}

// ── 文本工具（本地实现，避免和 memory.js 循环依赖）──────────────────────

function norm(s) {
  return String(s ?? '')
    .toLowerCase()
    .replace(/[\s，。！？、；：""''（）()【】\[\]…·.,!?;:]/g, '')
}

function bigrams(s) {
  const t = norm(s)
  const out = new Set()
  for (let i = 0; i < t.length - 1; i += 1) out.add(t.slice(i, i + 2))
  return out
}

export function textSimilarity(a, b) {
  const A = bigrams(a)
  const B = bigrams(b)
  if (!A.size || !B.size) return 0
  let hit = 0
  for (const g of A) if (B.has(g)) hit += 1
  return hit / (A.size + B.size - hit)
}

function clipBytes(text, maxBytes = PURPOSE_MAX_BYTES) {
  let s = String(text ?? '').replace(/\s+/g, ' ').trim()
  while (Buffer.byteLength(s, 'utf8') > maxBytes) s = s.slice(0, -1)
  return s
}

// ── 挖掘：从记忆里挑"问了没用答完"的事 ────────────────────────────────

/**
 * @param {object} doc 现有账本
 * @param {Array} facts 记忆事实（需带 topic）
 * @returns {{items:Array, added:Array}}
 */
export function minePurposes(doc, facts, { now = Date.now(), maxAgeDays = 7, minAgeHours = 6, customDrives = [] } = {}) {
  const items = Array.isArray(doc.items) ? doc.items.slice() : []
  const added = []

  for (const f of Array.isArray(facts) ? facts : []) {
    if (!f || !f.text) continue
    if (f.until) continue
    if (f.kind === 'identity-claim') continue
    const created = Date.parse(f.created)
    if (Number.isNaN(created)) continue

    const ageMs = now - created
    if (ageMs < minAgeHours * 3_600_000) continue       // 刚说的别马上追问
    if (ageMs > maxAgeDays * DAY) continue               // 太久远的别翻旧账

    const emotional = Number(f.emotional ?? 0)
    // 自定义动机的关键词撞上就算数：哪怕这句话本身很平淡——
    // "她自己在意的方向"比"这句话情绪有多强"更该决定惦记什么。
    const hitDrive = matchDrive(f.text, customDrives)
    if (emotional < 8 && !f.slot && !hitDrive) continue    // 平淡的闲聊不惦记

    const need = hitDrive ? hitDrive.id : emotional >= 16 ? 'care' : f.slot ? 'curiosity' : 'share'
    const text = clipBytes(`你上次说「${f.text}」，后来怎么样了？`)

    // 同一个原始记录只惦记一次；措辞相近的不重复
    if (items.some((p) => p.origin === f.src)) continue
    if (items.some((p) => p.status === 'open' && textSimilarity(p.text, text) >= 0.55)) continue

    const item = {
      id: `pur_${ulid()}`,
      need,
      text,
      origin: f.src,
      topic: String(f.topic ?? ''),
      status: 'open',
      created: localIso(new Date(now)),
      due: localIso(new Date(now)),
      hits: 0,
    }
    items.push(item)
    added.push(item)
  }

  // 账本不能只增不减：超过上限时先丢最老的已完成项
  if (items.length > MAX_OPEN) {
    const closed = items.filter((p) => p.status !== 'open').sort((a, b) => String(a.created).localeCompare(String(b.created)))
    while (items.length > MAX_OPEN && closed.length) {
      const victim = closed.shift()
      const idx = items.indexOf(victim)
      if (idx >= 0) items.splice(idx, 1)
    }
    // 还是超就丢最老的 open
    while (items.length > MAX_OPEN) items.shift()
  }

  return { items, added }
}

/** 到期的目的（open 且 due <= now），按需求强度排序。 */
export function duePurposes(items, drives = {}, { now = Date.now(), limit = 2 } = {}) {
  const open = (Array.isArray(items) ? items : [])
    .filter((p) => p && p.status === 'open' && Date.parse(p.due) <= now)
    .sort(
      (a, b) =>
        (Number(drives[b.need]) || 0) - (Number(drives[a.need]) || 0) ||
        String(b.created).localeCompare(String(a.created)),
    )
  return open.slice(0, Math.max(0, limit))
}

/** 同一条目的冷却窗口：刚摆到面前就别再摆，否则每次对话都在追同一件事。 */
export const SELECT_RECENT_MS = 6 * 3_600_000
/** 同一条目的最大**提及**次数（她说出口的），超过就自动放下。 */
export const SELECT_MAX_HITS = 2
/**
 * 同一条目最大**被摆到面前**的次数（注入次数）。
 *
 * 为什么要单独记这个：以前把"注入"当"提过"，结果是——模型压根没提，
 * 系统也认定"提过两次了"，于是静默把这件事放下（理由还写着"提过 2 次"）。
 * 现在两者分开：`hits` 只有模型显式回报才算；`offered` 记被摆出去几次。
 * 摆了这么多次她一次都没接，说明这件事其实不重要，放掉。
 */
export const SELECT_MAX_OFFERED = 5

/**
 * 挑这一轮要说哪几条「惦记」。
 *
 * 四层过滤，对应四种真实的骚扰：
 *   ① 刚摆到面前过（6 小时内）→ 冷却
 *   ② 已经说出口够次数 → 放下（由调用方关掉）
 *   ③ 摆了够多次但一次都没接 → 也放下（这不是"提过了"，是"她没兴趣"）
 *   ④ 一轮里两条话说的是同一件事 → 只留一条
 *
 * @returns {{picked:Array, exhausted:Array<{id:string, why:string}>, cooled:number}}
 */
export function selectIntent(
  items,
  drives = {},
  { now = Date.now(), limit = 2, recentMs = SELECT_RECENT_MS, maxHits = SELECT_MAX_HITS, maxOffered = SELECT_MAX_OFFERED } = {},
) {
  const exhausted = []
  let cooled = 0
  const pool = []

  for (const p of Array.isArray(items) ? items : []) {
    if (!p || p.status !== 'open') continue
    if (Date.parse(p.due) > now) continue

    const hits = Number(p.hits ?? 0)
    if (hits >= maxHits) {
      exhausted.push({ id: p.id, why: 'mentioned' })
      continue
    }
    const offered = Number(p.offered ?? 0)
    if (offered >= maxOffered && hits === 0) {
      exhausted.push({ id: p.id, why: 'ignored' })
      continue
    }
    // 冷却看"最近一次被摆出去或被她提起"，两者都算，否则每轮都会重新摆一遍
    const last = Math.max(Date.parse(p.last_hit ?? '') || 0, Date.parse(p.last_offered ?? '') || 0)
    if (last && now - last < recentMs) {
      cooled += 1
      continue
    }
    pool.push(p)
  }

  pool.sort(
    (a, b) =>
      (Number(drives[b.need]) || 0) - (Number(drives[a.need]) || 0) ||
      String(b.created).localeCompare(String(a.created)),
  )

  const picked = []
  for (const p of pool) {
    if (picked.length >= Math.max(0, limit)) break
    if (picked.some((q) => textSimilarity(q.text, p.text) >= 0.55)) continue
    picked.push(p)
  }
  return { picked, exhausted, cooled }
}

export function closePurpose(doc, id, { now = Date.now(), reason = '' } = {}) {
  const items = Array.isArray(doc.items) ? doc.items : []
  const hit = items.find((p) => p.id === id)
  if (!hit) return { items, changed: false }
  hit.status = 'done'
  hit.closed_at = localIso(new Date(now))
  hit.close_reason = String(reason ?? '').slice(0, 80)
  return { items, changed: true }
}

/** 过期清理：超过 TTL 还没提的，标 dropped。 */
export function expirePurposes(doc, { now = Date.now(), ttlDays = PURPOSE_TTL_DAYS } = {}) {
  let changed = 0
  for (const p of Array.isArray(doc.items) ? doc.items : []) {
    if (p.status !== 'open') continue
    if (now - Date.parse(p.created) > ttlDays * DAY) {
      p.status = 'dropped'
      p.dropped_at = localIso(new Date(now))
      changed += 1
    }
  }
  return changed
}

/** 记一次"被摆到面前"（注入）。**不代表她说出口了**。 */
export function markOffered(doc, ids, { now = localIso() } = {}) {
  const set = new Set(ids)
  let changed = false
  for (const p of doc.items ?? []) {
    if (set.has(p.id)) {
      p.offered = Number(p.offered ?? 0) + 1
      p.last_offered = now
      changed = true
    }
  }
  return changed
}

/** 记一次"她真的提了"（由模型显式回报，见 MCP 的 yuanling_purpose）。 */
export function markHit(doc, ids, { now = localIso() } = {}) {
  const set = new Set(ids)
  let changed = false
  for (const p of doc.items ?? []) {
    if (set.has(p.id)) {
      p.hits = Number(p.hits ?? 0) + 1
      p.last_hit = now
      p.last_offered = p.last_offered ?? now
      changed = true
    }
  }
  return changed
}
