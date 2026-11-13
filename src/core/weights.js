// src/core/weights.js —— 账户权重（基础）/ 人物权重（派生）。
//
// 用户 2026-11-13 定：
//   · 账户卡权重是基础数据，每次与该账户的聊天会更新（inbox 里增量更新）。
//   · 人物卡权重 = 各账户权重之和（封顶 100）。合并/拆分不改账户权重，只重算人物。
//   · 重点名单仍按名次给 110 起；管理员单独标记。
//
// 这里负责“从 raw 重算”（迁移/修复用），以及把人物权重缓存写回档案。
import { listDays, readDay } from './raw.js'
import {
  accountForNative,
  accountsForPerson,
  loadPersons,
  personWeight,
  readPersonProfile,
  setAccountWeightFromStats,
  writePersonProfile,
} from './accounts.js'

export const WEIGHT = {
  perMessage: 0.5,
  perActiveDay: 1.0,
  perRecentMessage: 0.3,
  recentDays: 30,
  cap: 100,
}

export const SEED_WEIGHT = 50
export const PIN_WEIGHT = { base: 110, step: 5 }

/** 这条记录算不算“和这个账户的互动”。 */
function isInteraction(r, card) {
  const id = String(card.nativeId ?? '')
  const chan = String(r.channel ?? '')
  const actor = String(r.actor?.id ?? '')
  if (!id || actor !== id) return false
  if (card.platform === 'qq' || card.platform === 'wechat' || card.platform === 'dsh') return chan.startsWith('private:')
  if (card.platform === 'bili') return chan.startsWith('bili:')
  return false
}

/** 从 raw 统计一个账户的互动（消息数 / 活跃天 / 近 30 天）。 */
export function accountStatsFromRaw(root, card, { now = Date.now() } = {}) {  const cutoff = now - WEIGHT.recentDays * 86_400_000
  const activeDays = new Set()
  const dayCounts = {}
  let msgs = 0
  let recent = 0
  for (const date of listDays(root)) {
    for (const r of readDay(root, date)) {
      if ((r.type ?? 'message') !== 'message') continue
      if (r.role === 'bot') continue
      if (!isInteraction(r, card)) continue
      msgs += 1
      activeDays.add(date)
      dayCounts[date] = Number(dayCounts[date] ?? 0) + 1
      const t = Date.parse(r.ts)
      if (!Number.isNaN(t) && t >= cutoff) recent += 1
    }
  }
  return { messages: msgs, activeDays: activeDays.size, last30: recent, dayCounts, updatedAt: new Date(now).toISOString() }
}

/** 旧调用方的门面：按“一个人物”汇总其所有账户的互动。 */
export function interactionStats(root, person, { now = Date.now() } = {}) {
  const cards = []
  for (const ident of person?.identities ?? []) {
    const acct = accountForNative(root, null, ident.platform, ident.id)
    if (acct) cards.push({ uid: acct, platform: ident.platform, nativeId: String(ident.id) })
    else cards.push({ uid: null, platform: ident.platform, nativeId: String(ident.id) })
  }
  let msgs = 0
  let recent = 0
  const daySet = new Set()
  for (const card of cards) {
    const s = accountStatsFromRaw(root, card, { now })
    msgs += s.messages
    recent += s.last30
    for (const d of Object.keys(s.dayCounts ?? {})) daySet.add(d)
  }
  return { msgs, days: daySet.size, recent }
}

export function computeWeight({ msgs, days, recent }) {
  const raw = msgs * WEIGHT.perMessage + days * WEIGHT.perActiveDay + recent * WEIGHT.perRecentMessage
  return Math.min(WEIGHT.cap, Math.round(raw))
}

export function pinWeight(rank, total) {
  const n = Math.max(1, Number(total) || 1)
  const r = Math.max(0, Math.min(n - 1, Number(rank) || 0))
  return PIN_WEIGHT.base + PIN_WEIGHT.step * (n - 1 - r)
}

export function effectivePersonWeight(profile, { totalPinned = 0 } = {}) {
  const stored = clampWeight(profile?.weight, SEED_WEIGHT)
  if (profile?.pinned) {
    const rank = Number.isFinite(Number(profile.pin_rank)) ? Number(profile.pin_rank) : 0
    return { weight: pinWeight(rank, totalPinned), kind: 'pinned', stored, rank }
  }
  return { weight: stored, kind: 'auto', stored, rank: null }
}

export function clampWeight(v, fallback = 0) {
  const n = Number(v)
  const base = Number.isFinite(n) ? n : Number(fallback) || 0
  return Math.max(0, Math.min(WEIGHT.cap, Math.round(base)))
}

/**
 * 重算所有账户权重（从 raw），再刷新每个人物的派生权重。
 * 值没变就不写盘（不制造无意义版本）。
 */
export function refreshWeights(root, pid, { now = Date.now() } = {}) {
  const out = []
  for (const person of Object.values(loadPersons(root).persons)) {
    const prof = readPersonProfile(root, pid, person.uid)
    for (const card of accountsForPerson(root, pid, person.uid)) {
      const stats = accountStatsFromRaw(root, card, { now })
      // 没有历史互动时保留已有 weight（新建默认分）
      if (stats.messages > 0) {
        const weight = computeWeight({ msgs: stats.messages, days: stats.activeDays, recent: stats.last30 })
        setAccountWeightFromStats(root, pid, card.uid, stats, weight)
      }
    }
    const weight = personWeight(root, pid, person.uid)
    if (!prof) continue
    const same = Number(prof.weight ?? -1) === weight
    if (!same) {
      writePersonProfile(root, pid, person.uid, { weight, weight_at: new Date(now).toISOString() }, {
        actor: 'system:weight',
        reason: `权重自动更新 ${Number(prof.weight ?? 0)} → ${weight}`,
      })
    }
    out.push({ uid: person.uid, weight, changed: !same })
  }
  return out.sort((a, b) => b.weight - a.weight)
}
