// src/core/retention.js —— 衰减、清晰度、三条记忆带。
//
// 一条纪律：**衰减是算出来的，不是存下来的。**
// 存下来就要维护，维护就有漏跑的那一天；纯函数则没有"昨天任务没跑"这回事。
import fs from 'node:fs'
import path from 'node:path'
import { exists, appendLine, localIso, sha256 } from './fsx.js'
import { P } from './paths.js'

export const PROTECT_DAYS = 7 // 新事保护期
export const RECENT_WINDOW_DAYS = 14 // 「最新」带的窗口
/**
 * 「最初」的保留下限。origin 事实哪怕重要度只有 1，也不许沉到 gone——
 * 否则低重要度的那条"第一印象"会被 clarity 过滤掉，整个「最初」段凭空消失。
 * 45 = 「模糊」档的下限，够低（不抢别的段），又够高（永远看得见）。
 */
export const ORIGIN_FLOOR = 45
export const ACCESS_WINDOW_DAYS = 90 // 统计召回次数的时间窗

const STRONG =
  /喜欢|想念|舍不得|难过|委屈|哭|心疼|感动|害怕|孤单|抱歉|对不起|谢谢|抱抱|亲亲|陪伴|永远|最爱|在乎|重要/g
const MEDIUM = /开心|高兴|可爱|温柔|生气|烦|郁闷|害羞|讨厌|累|困|饿|紧张|激动/g

/** 情绪浓度 0..24（写入时算一次，存进事实）。 */
export function emotionalScore(text) {
  const t = String(text ?? '')
  const strong = (t.match(STRONG) ?? []).length
  const medium = (t.match(MEDIUM) ?? []).length
  const bang = (t.match(/[!！]/g) ?? []).length
  return Math.min(24, strong * 8 + medium * 3 + bang)
}

export function ageDays(iso, now = Date.now()) {
  const t = Date.parse(iso)
  if (Number.isNaN(t)) return 9999
  return Math.max(0, (now - t) / 86_400_000)
}

/** 清晰度阶梯（文档 §7.4）。 */
export function clarityOf(retention) {
  if (retention >= 85) return 'vivid'
  if (retention >= 65) return 'clear'
  if (retention >= 45) return 'fuzzy'
  if (retention >= 25) return 'trace'
  return 'gone'
}

/**
 * retention = 重要度 + 召回加成 + 近期加成 − 时间惩罚
 *
 * 时间惩罚按 k 分档：origin 不衰减（k=0）；重要度高（≥65）慢衰减（0.12）；
 * 其余快衰减（0.35）。保护期内不罚。
 */
export function retentionOf(fact, { recall = 0, now = Date.now() } = {}) {
  const imp = Number(fact.imp ?? 50)
  const age = ageDays(fact.created ?? fact.last_seen ?? '', now)
  let r = imp
  r += Math.min(12, recall * 2)
  if (age <= PROTECT_DAYS) r += 18
  if (age <= 2) r += 8
  const k = fact.origin ? 0 : imp >= 65 ? 0.12 : 0.35
  r -= Math.max(0, age - PROTECT_DAYS) * k
  // 最初不沉底：她最早认识你的那几件事，不该因为"当时没写重要度"而消失
  if (fact.origin && r < ORIGIN_FLOOR) r = ORIGIN_FLOOR
  return Number(r.toFixed(2))
}

// ── 召回次数（access.ndjson）────────────────────────────────────────────

const cache = new Map()

export function accessPath(root, pid) {
  return path.join(root, P.personas, pid, 'state', 'access.ndjson')
}

/** 记一次召回。只追加，不改事实文件——读路径不该产生写放大。 */
export function recordAccess(root, pid, factIds, query = '') {
  const ids = (Array.isArray(factIds) ? factIds : [factIds]).filter(Boolean)
  if (!ids.length) return
  const p = accessPath(root, pid)
  const ts = localIso()
  for (const id of ids) appendLine(p, { ts, fact: id, q: String(query).slice(0, 40) })
}

/** 每个事实在时间窗内被召回了几次。按文件 mtime 缓存。 */
export function recallCounts(root, pid, { now = Date.now(), windowDays = ACCESS_WINDOW_DAYS } = {}) {
  const p = accessPath(root, pid)
  if (!exists(p)) return new Map()
  const st = fs.statSync(p)
  const key = `${p}::${st.mtimeMs}:${st.size}:${windowDays}`
  const hit = cache.get(key)
  if (hit) return hit

  const counts = new Map()
  const cutoff = now - windowDays * 86_400_000
  for (const line of fs.readFileSync(p, 'utf8').split('\n')) {
    if (!line.trim()) continue
    try {
      const r = JSON.parse(line)
      const t = Date.parse(r.ts)
      if (Number.isNaN(t) || t < cutoff) continue
      counts.set(r.fact, (counts.get(r.fact) ?? 0) + 1)
    } catch {
      /* 坏行跳过 */
    }
  }
  cache.set(key, counts)
  return counts
}

// ── 「最初」的确定性抽签 ────────────────────────────────────────────────

/** 按 id 的稳定散列抽 [0,1) 的签：同一张卡读一百次结果一样。 */
export function originDraw(id) {
  const hex = String(sha256(Buffer.from(String(id), 'utf8'))).replace(/^sha256:/, '').slice(0, 8)
  return parseInt(hex, 16) / 0xffffffff
}

/** 距离"第一次"越近，越可能被标成最初。 */
export function originProbability(ageDaysValue) {
  if (ageDaysValue <= 10) return 0.9
  if (ageDaysValue <= 20) return 0.55
  if (ageDaysValue <= 30) return 0.3
  return 0.03
}

/** 是否为「最初」。只对条目最早的两条事实考虑，避免把一切都标成最初。 */
export function shouldMarkOrigin({ factId, entryAgeDays }) {
  return originDraw(factId) < originProbability(entryAgeDays)
}

/** 三条带：一个事实只属于一条（first > deep > recent）。 */
export function classify(fact, { recall = 0, now = Date.now() } = {}) {
  if (fact.origin) return 'first'
  const emotional = Number(fact.emotional ?? 0)
  if ((Number(fact.imp ?? 0) >= 80 || emotional >= 20) && recall >= 3) return 'deep'
  if (ageDays(fact.created, now) <= RECENT_WINDOW_DAYS) return 'recent'
  return null
}
