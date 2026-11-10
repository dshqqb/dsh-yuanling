// src/core/weights.js —— 人物权重：她多在意这个人。
//
// 口径（已与用户确认）：**只算"和 AI 的互动"**。
//   · 私聊里跟她说的话 → 算
//   · 群里跟别人说的话 → 不算（那是别人的社交，不是她与这个人的关系）
//   · B站 评论/弹幕里出现这个人的痕迹 → 算（她确实读到了）
//
// 两条量程（用户定，2026-11-10）：
//   · **普通名单**：互动分，0–100。消息数×0.5 + 活跃天数×1.0 + 近30天×0.3。
//   · **重点名单**：按名次给分，**从 110 起**，最后一名 110、往上每名 +5
//     （N 个人时：第 k 名（1 起）= 110 + 5×(N−k)）。所以重点永远排在普通人前面。
//
// 权重**只能由互动推演**：没有任何手改入口（2026-11-10 删掉了 manual 覆写）。
// 人想抬高权重唯一的办法是"设为重点人物"并把它往前挪。
// 落盘的 `weight` 仍然保留：它记录"这个人最近一次算出来的互动分"，
// 取消重点之后立刻拿它当生效权重。
import { listDays, readDay } from './raw.js'
import { loadIdentities, readProfile, writeProfile } from './entities.js'

export const WEIGHT = {
  perMessage: 0.5,
  perActiveDay: 1.0,
  perRecentMessage: 0.3,
  recentDays: 30,
  cap: 100,
}

/** 新建人物/群体的默认分（普通名单的中值）。 */
export const SEED_WEIGHT = 50

/** 重点名单的量程：最后一名 110，往上每名 +5。 */
export const PIN_WEIGHT = { base: 110, step: 5 }

/** 这条记录算不算"和这个人的互动"。 */
function isInteraction(r, identity) {
  const id = String(identity.id)
  const chan = String(r.channel ?? '')
  const actor = String(r.actor?.id ?? '')
  if (!id || actor !== id) return false
  if (identity.platform === 'qq') {
    // 只认私聊：群里说话不等于跟她说话。
    // 不再比 `private:<对方QQ号>`——频道已经改成内部编号（`private:person_x`），
    // 而老记录还是老形状。人是谁已经由 actor.id 说清了，这里只要判断"这是私聊"。
    return chan.startsWith('private:')
  }
  if (identity.platform === 'bili') {
    return chan.startsWith('bili:')
  }
  return false
}

/**
 * 统计一个人和她的互动。
 * @returns {{msgs:number, days:number, recent:number}}
 */
export function interactionStats(root, person, { now = Date.now() } = {}) {
  const identities = person?.identities ?? []
  if (!identities.length) return { msgs: 0, days: 0, recent: 0 }

  const cutoff = now - WEIGHT.recentDays * 86_400_000
  const activeDays = new Set()
  let msgs = 0
  let recent = 0

  for (const date of listDays(root)) {
    for (const r of readDay(root, date)) {
      if ((r.type ?? 'message') !== 'message') continue
      if (r.role === 'bot') continue // 她自己说的话不算他的互动
      if (!identities.some((i) => isInteraction(r, i))) continue
      msgs += 1
      activeDays.add(date)
      const t = Date.parse(r.ts)
      if (!Number.isNaN(t) && t >= cutoff) recent += 1
    }
  }
  return { msgs, days: activeDays.size, recent }
}

export function computeWeight({ msgs, days, recent }) {
  const raw = msgs * WEIGHT.perMessage + days * WEIGHT.perActiveDay + recent * WEIGHT.perRecentMessage
  return Math.min(WEIGHT.cap, Math.round(raw))
}

/**
 * 重点名单里第 `rank` 名（0 起，0 = 第一名）的权重。
 *
 * N 个人：最后一名是 `base`，每往前一名 +`step`。
 * 一个人时就是 base（110）。
 */
export function pinWeight(rank, total) {
  const n = Math.max(1, Number(total) || 1)
  const r = Math.max(0, Math.min(n - 1, Number(rank) || 0))
  return PIN_WEIGHT.base + PIN_WEIGHT.step * (n - 1 - r)
}

/**
 * 一个人生效的权重。
 *
 * 注意 `stored` 永远保留：重点时它不生效（被名次分盖住），取消重点就立刻回来。
 *
 * @returns {{weight:number, kind:'auto'|'pinned', stored:number, rank:number|null}}
 */
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
 * 重算所有人物的**落盘**权重（互动分）。
 * 值没变就不写盘（不制造无意义的版本）。重点人物也照算——落盘值要一直是"最新的互动分"，
 * 这样取消重点时拿到的不是一份陈年旧数。
 *
 * @returns {Array<{uid:string, weight:number, changed:boolean, stats?:object}>}
 */
export function refreshWeights(root, pid, { now = Date.now() } = {}) {
  const data = loadIdentities(root)
  const out = []

  for (const person of Object.values(data.people)) {
    const prof = readProfile(root, pid, person.uid)
    if (!prof) continue // 她还没认识这个人

    const stats = interactionStats(root, person, { now })
    // 还一次都没互动过：保留新建时写的默认分（50）。
    // 否则"新建人物默认 50"会被一次 refresh 抹成 0——那不叫推演，那叫清零。
    if (stats.msgs === 0) {
      out.push({ uid: person.uid, weight: Number(prof.weight ?? 0), changed: false, stats })
      continue
    }
    const weight = computeWeight(stats)
    const same = Number(prof.weight ?? -1) === weight
    if (!same) {
      writeProfile(root, pid, person.uid, {
        weight,
        weight_at: new Date(now).toISOString(),
        __reason: `权重自动更新 ${Number(prof.weight ?? 0)} → ${weight}`,
      })
    }
    out.push({ uid: person.uid, weight, changed: !same, stats })
  }

  return out.sort((a, b) => b.weight - a.weight)
}
