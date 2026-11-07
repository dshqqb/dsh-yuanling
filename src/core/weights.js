// src/core/weights.js —— 人物权重：她多在意这个人。
//
// 口径（已与用户确认）：**只算"和 AI 的互动"**。
//   · 私聊里跟她说的话 → 算
//   · 群里跟别人说的话 → 不算（那是别人的社交，不是她与这个人的关系）
//   · B站 评论/弹幕里出现这个人的痕迹 → 算（她确实读到了）
//
// 权重 = 消息数×0.5 + 活跃天数×1.0 + 近30天消息数×0.3，封顶 100。
// 手动覆写（weight_source=manual）之后，自动分不再覆盖它。
import { listDays, readDay } from './raw.js'
import { loadIdentities, readProfile, writeProfile } from './entities.js'

export const WEIGHT = {
  perMessage: 0.5,
  perActiveDay: 1.0,
  perRecentMessage: 0.3,
  recentDays: 30,
  cap: 100,
}

/** 这条记录算不算"和这个人的互动"。 */
function isInteraction(r, identity) {
  const id = String(identity.id)
  const chan = String(r.channel ?? '')
  const actor = String(r.actor?.id ?? '')
  if (!id || actor !== id) return false
  if (identity.platform === 'qq') {
    // 只认私聊：群里说话不等于跟她说话
    return chan === `private:${id}`
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
 * 重算所有人物的自动权重。
 * 手动覆写的人跳过；值没变就不写盘（不制造无意义的版本）。
 *
 * @returns {Array<{uid:string, weight:number, source:string, changed:boolean, stats?:object}>}
 */
export function refreshWeights(root, pid, { now = Date.now() } = {}) {
  const data = loadIdentities(root)
  const out = []

  for (const person of Object.values(data.people)) {
    const prof = readProfile(root, pid, person.uid)
    if (!prof) continue // 她还没认识这个人

    if (prof.weight_source === 'manual') {
      out.push({ uid: person.uid, weight: Number(prof.weight ?? 0), source: 'manual', changed: false })
      continue
    }

    const stats = interactionStats(root, person, { now })
    const weight = computeWeight(stats)
    const same = Number(prof.weight ?? -1) === weight
    if (!same) {
      writeProfile(root, pid, person.uid, {
        weight,
        weight_source: 'auto',
        weight_at: new Date(now).toISOString(),
        __reason: `权重自动更新 ${Number(prof.weight ?? 0)} → ${weight}`,
      })
    }
    out.push({ uid: person.uid, weight, source: 'auto', changed: !same, stats })
  }

  return out.sort((a, b) => b.weight - a.weight)
}

/** 手动覆写：之后就由人说了算，自动分不再覆盖。 */
export function setManualWeight(root, pid, uid, weight) {
  const w = Math.max(0, Math.min(WEIGHT.cap, Math.round(Number(weight))))
  if (!Number.isFinite(w)) throw new Error('权重必须是数字')
  return writeProfile(root, pid, uid, {
    weight: w,
    weight_source: 'manual',
    weight_at: new Date().toISOString(),
    __reason: `手动设置权重 ${w}`,
  })
}

/** 恢复自动计分：清掉 manual 标记，下次 refresh 会重算。 */
export function clearManualWeight(root, pid, uid) {
  return writeProfile(root, pid, uid, {
    weight_source: 'auto',
    __reason: '恢复自动权重',
  })
}
