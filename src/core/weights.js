// src/core/weights.js —— 每张人物卡（账户）的权重；人物权重由成员卡求和。
import { listDays, readDay } from './raw.js'
import { cardByAccount, listCards, setCardWeight } from './accounts.js'

export const WEIGHT = {
  perMessage: 0.5,
  perActiveDay: 1.0,
  perRecentMessage: 0.3,
  recentDays: 30,
  cap: 100,
}

export const SEED_WEIGHT = 50
export const PIN_WEIGHT = { base: 110, step: 5 }

function isInteraction(r, card) {
  const id = String(card.account ?? '')
  const chan = String(r.channel ?? '')
  const actor = String(r.actor?.id ?? '')
  if (!id || actor !== id) return false
  if (card.app === 'qq' || card.app === 'wechat' || card.app === 'dsh') return chan.startsWith('private:')
  if (card.app === 'bilibili' || card.app === 'bili') return chan.startsWith('bili:')
  return false
}

export function accountStatsFromRaw(root, card, { now = Date.now() } = {}) {
  const cutoff = now - WEIGHT.recentDays * 86_400_000
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

export function computeWeight({ msgs, days, recent }) {
  const raw = msgs * WEIGHT.perMessage + days * WEIGHT.perActiveDay + recent * WEIGHT.perRecentMessage
  return Math.min(WEIGHT.cap, Math.round(raw))
}

export function interactionStats(root, person, { now = Date.now() } = {}) {
  const cards = []
  for (const ident of person?.identities ?? []) {
    const id = cardByAccount(root, null, ident.platform, ident.id)
    cards.push(id ? cards.find((c) => c.id === id) ?? { id, app: ident.platform, account: String(ident.id) } : { app: ident.platform, account: String(ident.id) })
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

/** 从 raw 重算每张卡的权重；一次扫描，不按卡重复读 raw。 */
export function refreshWeights(root, pid, { now = Date.now() } = {}) {
  const cards = listCards(root, pid)
  const byActor = new Map()
  for (const card of cards) {
    const key = String(card.account ?? '')
    if (!key) continue
    const list = byActor.get(key) ?? []
    list.push(card)
    byActor.set(key, list)
  }
  const stats = new Map(cards.map((c) => [c.id, { messages: 0, activeDays: 0, last30: 0, dayCounts: {}, updatedAt: new Date(now).toISOString() }]))
  const cutoff = now - WEIGHT.recentDays * 86_400_000
  const daySets = new Map()
  for (const date of listDays(root)) {
    for (const r of readDay(root, date)) {
      if ((r.type ?? 'message') !== 'message') continue
      if (r.role === 'bot') continue
      const actor = String(r.actor?.id ?? '')
      const candidates = byActor.get(actor)
      if (!candidates) continue
      const chan = String(r.channel ?? '')
      for (const card of candidates) {
        if (card.app === 'qq' || card.app === 'wechat' || card.app === 'dsh') {
          if (!chan.startsWith('private:')) continue
        } else if (card.app === 'bilibili' || card.app === 'bili') {
          if (!chan.startsWith('bili:')) continue
        } else continue
        const s = stats.get(card.id)
        s.messages += 1
        s.dayCounts[date] = Number(s.dayCounts[date] ?? 0) + 1
        const t = Date.parse(r.ts)
        if (!Number.isNaN(t) && t >= cutoff) s.last30 += 1
        let set = daySets.get(card.id)
        if (!set) { set = new Set(); daySets.set(card.id, set) }
        set.add(date)
      }
    }
  }
  const out = []
  for (const card of cards) {
    const s = stats.get(card.id)
    s.activeDays = daySets.get(card.id)?.size ?? 0
    const old = Number(card.weight ?? 0)
    let weight = old
    if (s.messages > 0) {
      weight = computeWeight({ msgs: s.messages, days: s.activeDays, recent: s.last30 })
      setCardWeight(root, pid, card.id, s, weight)
    }
    out.push({ uid: card.id, weight, changed: old !== weight })
  }
  return out.sort((a, b) => b.weight - a.weight)
}
