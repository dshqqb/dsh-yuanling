// src/core/drives.js —— 动机层：她"想要什么"的强度。
//
// 五个内置维度（陪 / 关心 / 好奇 / 分享 / 自我）是基线：它们**不能删**，
// 因为目的层的默认排序就靠它们。除此之外，模型可以**自己加动机**：
//
//   · 加的时候必须给一条"什么情况下会涨"的线索（关键词）——
//     记忆里撞上就升温，也能生成属于它的目的（purposes.minePurposes）。
//   · 名字 ≤12 字；内置 5 个 + 自定义最多 3 个（一共 8 个）。
//   · 她自己调权重要带 reason，单次 ≤±0.2，一天最多 6 次，全部进版本历史。
//
// 衰减：所有维度都按半衰期回落到**自己的基线**（内置有固定基线，自定义默认 0.15）。
// 所以她会黏一阵、静一阵，而不是恒定。
import path from 'node:path'
import { readJson, writeJsonAtomic, localIso, ulid } from './fsx.js'
import { P } from './paths.js'
import { writeTracked } from './version.js'

export const DRIVE_NEEDS = ['connect', 'care', 'curiosity', 'share', 'identity']

export const DRIVE_BASE = { connect: 0.30, care: 0.25, curiosity: 0.20, share: 0.20, identity: 0.12 }

/** 给页面和注入用的中文名。 */
export const DRIVE_LABELS = {
  connect: '想陪着你',
  care: '想关心你',
  curiosity: '想弄明白',
  share: '想分享',
  identity: '想确认自己',
}

/** 半衰期：12 小时（surfcore 用 8 小时；我们的对话密度更低，慢一点更自然）。 */
export const DRIVE_HALF_LIFE_HOURS = 12
export const DRIVE_CAP = 0.95
/** 变化小于这个值就不写盘——避免每分钟生成一个"没变"的版本。 */
const WRITE_EPSILON = 0.01

/** 自定义动机的规矩（用户 2026-11-10 定）。 */
export const DRIVE_LIMITS = {
  maxCustom: 3,
  nameMax: 12,
  keywordsMax: 8,
  keywordLen: 12,
  adjustMax: 0.2,
  adjustsPerDay: 6,
  /** 关键词撞上时一次升温多少（同一条消息最多算 3 次）。 */
  hitHeat: 0.04,
  hitMaxPerMessage: 3,
}

export function drivesPath(root, pid) {
  return path.join(root, P.personas, pid, 'self', 'drives.json')
}

function clamp01(n) {
  return Math.max(0, Math.min(DRIVE_CAP, n))
}

/**
 * 读动机。
 * @returns {{version:number, values:object, at:string|null, custom:Array<{id,name,keywords,base,created}>}}
 */
export function readDrives(root, pid) {
  const j = readJson(drivesPath(root, pid), null)
  const custom = Array.isArray(j?.custom)
    ? j.custom
        .filter((d) => d && d.id && d.name)
        .slice(0, DRIVE_LIMITS.maxCustom)
        .map((d) => ({
          id: String(d.id),
          name: String(d.name),
          keywords: Array.isArray(d.keywords) ? d.keywords.map(String).filter(Boolean).slice(0, DRIVE_LIMITS.keywordsMax) : [],
          base: Number.isFinite(Number(d.base)) ? clamp01(Number(d.base)) : 0.15,
          created: d.created ?? null,
        }))
    : []

  const values = { ...DRIVE_BASE }
  for (const need of DRIVE_NEEDS) {
    const n = Number(j?.values?.[need])
    if (Number.isFinite(n)) values[need] = n
  }
  for (const d of custom) {
    const n = Number(j?.values?.[d.id])
    values[d.id] = Number.isFinite(n) ? clamp01(n) : d.base
  }
  return { version: Number(j?.version ?? 1), values, at: j?.at ?? null, custom }
}

/** 所有动机的展示名（内置 + 自定义）。 */
export function driveName(drives, need) {
  if (DRIVE_LABELS[need]) return DRIVE_LABELS[need]
  return drives?.custom?.find((d) => d.id === need)?.name ?? need
}

function baseOf(need, custom) {
  if (DRIVE_BASE[need] !== undefined) return DRIVE_BASE[need]
  return custom.find((d) => d.id === need)?.base ?? 0.15
}

/**
 * 刷新需求强度（衰减 + 想陪的上涨）。
 * @param {{now?:number, hoursSinceMaster?:number|null, persist?:boolean}} opts
 *   hoursSinceMaster = 距离上次互动的小时数；persist=false 只算不写（管理台预览用）
 */
export function refreshDrives(root, pid, { now = Date.now(), hoursSinceMaster = null, persist = true } = {}) {
  const cur = readDrives(root, pid)
  const hours = cur.at ? Math.min(72, Math.max(0, (now - Date.parse(cur.at)) / 3_600_000)) : 0
  const decay = Math.pow(0.5, hours / DRIVE_HALF_LIFE_HOURS)

  const next = {}
  const allNeeds = [...DRIVE_NEEDS, ...cur.custom.map((d) => d.id)]
  for (const need of allNeeds) {
    const base = baseOf(need, cur.custom)
    const v = Number(cur.values[need])
    // 朝自己的基线衰减：超过的降下来，低于的也慢慢回升
    next[need] = base + ((Number.isFinite(v) ? v : base) - base) * decay
  }

  // 想陪：越久没说话越涨（每天最多 +0.4，封顶 0.95）
  if (Number.isFinite(hoursSinceMaster) && hoursSinceMaster >= 0) {
    next.connect = Math.min(DRIVE_CAP, next.connect + Math.min(0.5, (hoursSinceMaster / 24) * 0.4))
  }

  let maxDelta = 0
  for (const need of allNeeds) {
    next[need] = clamp01(next[need])
    maxDelta = Math.max(maxDelta, Math.abs(next[need] - (Number(cur.values[need]) || 0)))
  }

  if (persist && (hours > 0 || maxDelta >= WRITE_EPSILON)) {
    writeJsonAtomic(drivesPath(root, pid), {
      version: 2,
      values: next,
      at: localIso(new Date(now)),
      custom: cur.custom,
    })
  }
  return next
}

// ── 自定义动机（模型可以加）──────────────────────────────────────────────

function normalizeKeywords(list) {
  const out = []
  for (const raw of Array.isArray(list) ? list : []) {
    const k = String(raw ?? '').trim()
    if (!k) continue
    if ([...k].length > DRIVE_LIMITS.keywordLen) {
      throw new Error(`关键词「${k}」太长（最多 ${DRIVE_LIMITS.keywordLen} 字）`)
    }
    if (!out.includes(k)) out.push(k)
    if (out.length >= DRIVE_LIMITS.keywordsMax) break
  }
  return out
}

/**
 * 加一个自定义动机。
 *
 * `keywords` 是"什么情况下会涨"的线索：记忆或消息里出现这些词，这条动机就升温。
 * 没有关键词的动机是不会动的，所以**必填**。
 */
export function addDrive(root, pid, { name, keywords, reason, base = 0.25, actor = 'model:drive' } = {}) {
  const title = String(name ?? '').trim()
  if (!title) throw new Error('动机得有个名字')
  if ([...title].length > DRIVE_LIMITS.nameMax) {
    throw new Error(`动机名最多 ${DRIVE_LIMITS.nameMax} 字（现在是 ${[...title].length} 字）`)
  }
  if (!String(reason ?? '').trim()) throw new Error('reason 必填：为什么想多在意这件事')
  const kws = normalizeKeywords(keywords)
  if (!kws.length) throw new Error('必须给关键词：她听到什么才会更想做这件事？（例如 ["报错","为什么"]）')

  const cur = readDrives(root, pid)
  if (cur.custom.length >= DRIVE_LIMITS.maxCustom) {
    throw new Error(
      `自定义动机最多 ${DRIVE_LIMITS.maxCustom} 个（内置 5 个 + 自定义 ${DRIVE_LIMITS.maxCustom} 个 = 上限 8）。先从别处挪一个吧`,
    )
  }
  const all = [...DRIVE_NEEDS, ...cur.custom.map((d) => d.name)]
  if (all.some((n) => n.toLowerCase() === title.toLowerCase())) {
    throw new Error(`已经有一个叫「${title}」的动机了`)
  }

  const id = `drive_${ulid()}`
  const next = {
    version: 2,
    values: { ...cur.values, [id]: clamp01(Number(base) || 0.25) },
    at: localIso(),
    custom: [...cur.custom, { id, name: title, keywords: kws, base: clamp01(Number(base) || 0.25), created: localIso() }],
  }
  writeTracked(root, relDrives(pid), JSON.stringify(next, null, 2) + '\n', {
    actor,
    reason: String(reason).slice(0, 200),
  })
  return readDrives(root, pid)
}

/** 删一个**自定义**动机（内置五维不许删：那是骨架级的基线）。 */
export function removeDrive(root, pid, { need, reason, actor = 'model:drive' } = {}) {
  if (DRIVE_NEEDS.includes(String(need))) throw new Error('内置的五个动机不能删（它们是目的层的基线）')
  if (!String(reason ?? '').trim()) throw new Error('reason 必填：为什么不再在意这件事')
  const cur = readDrives(root, pid)
  const hit = cur.custom.find((d) => d.id === need || d.name === need)
  if (!hit) throw new Error(`没有这个自定义动机：${need}`)

  const values = { ...cur.values }
  delete values[hit.id]
  const next = { version: 2, values, at: localIso(), custom: cur.custom.filter((d) => d.id !== hit.id) }
  writeTracked(root, relDrives(pid), JSON.stringify(next, null, 2) + '\n', {
    actor,
    reason: String(reason).slice(0, 200),
  })
  return readDrives(root, pid)
}

function relDrives(pid) {
  return `${P.personas}/${pid}/self/drives.json`
}

/** 今天已经调过几次（按 drives.json 里的 changes 记账）。 */
function todayAdjustCount(j, now) {
  const day = localIso(new Date(now)).slice(0, 10)
  return (Array.isArray(j?.changes) ? j.changes : []).filter((c) => String(c.at ?? '').startsWith(day)).length
}

/**
 * 她自己调一个动机的权重。
 *
 * 限制（用户定）：单次 ≤±0.2，一天最多 6 次，必须带 reason，进版本历史。
 */
export function adjustDrive(root, pid, { need, delta, reason, actor = 'model:drive', now = Date.now() } = {}) {
  const id = String(need ?? '').trim()
  const cur = readDrives(root, pid)
  const existsNeed = DRIVE_NEEDS.includes(id) || cur.custom.some((d) => d.id === id || d.name === id)
  if (!existsNeed) throw new Error(`没有这个动机：${id}（先加，或者用内置的 ${DRIVE_NEEDS.join(' / ')}）`)

  const d = Number(delta)
  if (!Number.isFinite(d) || d === 0) throw new Error('delta 要给一个非零数字（正数=更想要，负数=淡一点）')
  if (Math.abs(d) > DRIVE_LIMITS.adjustMax) {
    throw new Error(`一次最多调 ±${DRIVE_LIMITS.adjustMax}（想大改就分几次，别一下拉满）`)
  }
  if (!String(reason ?? '').trim()) throw new Error('reason 必填：为什么这次动它')

  const j = readJson(drivesPath(root, pid), null) ?? {}
  const used = todayAdjustCount(j, now)
  if (used >= DRIVE_LIMITS.adjustsPerDay) {
    throw new Error(`今天已经调过 ${used} 次了（上限 ${DRIVE_LIMITS.adjustsPerDay} 次/天）。明天再动，或者先说说为什么这么频繁`)
  }

  const key = DRIVE_NEEDS.includes(id) ? id : cur.custom.find((x) => x.id === id || x.name === id).id
  const before = Number(cur.values[key]) || 0
  const after = clamp01(before + d)

  const changes = Array.isArray(j?.changes) ? j.changes.slice(-199) : []
  changes.push({ at: localIso(new Date(now)), need: key, delta: Number((after - before).toFixed(4)), reason: String(reason).slice(0, 200) })

  const next = { version: 2, values: { ...cur.values, [key]: after }, at: localIso(new Date(now)), custom: cur.custom, changes }
  writeTracked(root, relDrives(pid), JSON.stringify(next, null, 2) + '\n', {
    actor,
    reason: String(reason).slice(0, 200),
  })
  return { before, after, need: key, name: driveName(cur, key) }
}

/**
 * 消息里出现自定义动机的关键词 → 升温。
 *
 * 在**入库**时调用（不是每轮读时算）：消息只到一次，热量只加一次。
 * @returns {Array<{need:string, by:number}>} 这次涨了哪些
 */
export function noteDriveHits(root, pid, text) {
  const t = String(text ?? '')
  if (!t) return []
  const cur = readDrives(root, pid)
  if (!cur.custom.length) return []

  const hits = []
  for (const d of cur.custom) {
    const n = Math.min(
      DRIVE_LIMITS.hitMaxPerMessage,
      d.keywords.reduce((acc, k) => acc + (t.includes(k) ? 1 : 0), 0),
    )
    if (!n) continue
    hits.push({ need: d.id, by: n * DRIVE_LIMITS.hitHeat })
  }
  if (!hits.length) return []

  const values = { ...cur.values }
  for (const h of hits) values[h.need] = clamp01((Number(values[h.need]) || 0) + h.by)
  writeJsonAtomic(drivesPath(root, pid), { version: 2, values, at: localIso(), custom: cur.custom })
  return hits
}

/** 哪些自定义动机的关键词撞上了这段文字（目的挖掘用）。 */
export function matchDrive(text, custom = []) {
  const t = String(text ?? '')
  if (!t) return null
  for (const d of custom) {
    if ((d.keywords ?? []).some((k) => k && t.includes(k))) return d
  }
  return null
}
