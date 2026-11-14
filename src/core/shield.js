// src/core/shield.js —— 墓碑：屏蔽"刚才"，全局生效，可撤销。
//
// 三个原则：
//   ① raw 不删。屏蔽是一条**追加**的事件（redact），原始记录一个字节不动。
//   ② 全局生效。隐私要求对所有人格一致——A 人格屏蔽的，B 人格也看不到。
//   ③ 可撤销。误删比删不掉更常见，所以 unredact 是一条对称的事件。
//
// 真相在 raw 的 system.ndjson 里；system/shields.json 是为了快速判断的索引，
// 可以由 raw 重建（rebuild）。
import path from 'node:path'
import { readJson, writeJsonAtomic, localIso } from './fsx.js'
import { P } from './paths.js'
import { appendSystemEvent, listDays, readDay } from './raw.js'
import { setFactsShieldedBySrc } from './memory.js'

export function shieldsPath(root) {
  return path.join(root, P.shields)
}

/** 读登记簿。没有就返回空结构。 */
export function loadShields(root) {
  const j = readJson(shieldsPath(root), null)
  if (!j || !Array.isArray(j.redactions)) return { version: 1, redactions: [] }
  return j
}

function saveShields(root, s) {
  writeJsonAtomic(shieldsPath(root), s)
}

/** 当前生效的屏蔽目标集合。 */
export function shieldedSet(root) {
  const set = new Set()
  for (const r of loadShields(root).redactions) {
    if (r.revoked_at) continue
    for (const t of r.targets ?? []) set.add(t)
  }
  return set
}

export function isShielded(root, id) {
  return shieldedSet(root).has(id)
}

/**
 * 最近的原始消息 id（"刚才"）。
 * 只取 type=message 的记录，跳过 system 事件与墓碑本身。
 */
export function recentRecordIds(root, { last = 1, channel = null, maxDays = 7 } = {}) {
  const days = listDays(root).slice(-maxDays).reverse()
  const out = []
  for (const date of days) {
    const recs = readDay(root, date)
      .filter((r) => (r.type ?? 'message') === 'message')
      .filter((r) => (channel ? r.channel === channel : true))
      .sort((a, b) => String(b.ts).localeCompare(String(a.ts)))
    for (const r of recs) {
      if (!r.id) continue
      out.push({ id: r.id, ts: r.ts, channel: r.channel, text: String(r.text ?? ''), file: relDayOf(date) })
      if (out.length >= last) return out
    }
  }
  return out
}

function relDayOf(date) {
  const [y, m, d] = date.split('-')
  return `${P.raw}/${y}-${m}/${d}`
}

/**
 * 屏蔽一组记录。
 * @returns {{redaction:object, cascaded:Array, already:number}}
 */
export function shield(root, targets, { by = 'owner', reason = '', now = localIso(), cascade = true } = {}) {
  const ids = (Array.isArray(targets) ? targets : [targets]).map(String).filter(Boolean)
  if (!ids.length) throw new Error('没有指定要屏蔽的记录')

  const active = shieldedSet(root)
  const fresh = ids.filter((id) => !active.has(id))
  if (!fresh.length) return { redaction: null, cascaded: [], already: ids.length }

  const rec = appendSystemEvent(root, { type: 'redact', targets: fresh, by, reason, ts: now })

  const s = loadShields(root)
  s.redactions.push({
    redaction_id: rec.id,
    targets: fresh,
    at: rec.ts,
    by,
    reason,
    revoked_at: null,
  })
  saveShields(root, s)

  const cascaded = cascade ? setFactsShieldedBySrc(root, fresh, true, now) : []
  return { redaction: rec, cascaded, already: ids.length - fresh.length }
}

/** 撤销屏蔽：追加 unredact，并把相关登记标为已撤销。 */
export function unshield(root, targets, { by = 'owner', reason = '', now = localIso() } = {}) {
  const ids = (Array.isArray(targets) ? targets : [targets]).map(String).filter(Boolean)
  if (!ids.length) throw new Error('没有指定要撤销的记录')

  const active = shieldedSet(root)
  const live = ids.filter((id) => active.has(id))
  if (!live.length) return { redaction: null, restored: [] }

  const rec = appendSystemEvent(root, { type: 'unredact', targets: live, by, reason, ts: now })

  const s = loadShields(root)
  for (const r of s.redactions) {
    if (r.revoked_at) continue
    if ((r.targets ?? []).some((t) => live.includes(t))) r.revoked_at = rec.ts
  }
  saveShields(root, s)

  const restored = setFactsShieldedBySrc(root, live, false, now)
  return { redaction: rec, restored }
}

/**
 * 从 raw 重建登记簿（system/shields.json 是索引，raw 才是真相）。
 * 事件按时间顺序重放：redact 生效，unredact 撤销。
 */
export function rebuildShields(root) {
  const events = []
  for (const date of listDays(root)) {
    for (const r of readDay(root, date)) {
      if (r.type === 'redact' || r.type === 'unredact') events.push(r)
    }
  }
  events.sort((a, b) => String(a.ts).localeCompare(String(b.ts)))

  /** @type {Map<string, {redaction_id:string, targets:string[], at:string, by:string, reason:string, revoked_at:string|null}>} */
  const byId = new Map()
  for (const e of events) {
    if (e.type === 'redact') {
      byId.set(e.id, {
        redaction_id: e.id,
        targets: e.targets ?? [],
        at: e.ts,
        by: e.by ?? '',
        reason: e.reason ?? '',
        revoked_at: null,
      })
    } else {
      for (const r of byId.values()) {
        if (r.revoked_at) continue
        if ((r.targets ?? []).some((t) => (e.targets ?? []).includes(t))) r.revoked_at = e.ts
      }
    }
  }
  const s = { version: 1, redactions: [...byId.values()] }
  saveShields(root, s)
  return { events: events.length, redactions: s.redactions.length }
}

/** 列出所有屏蔽登记（含已撤销）。 */
export function listShields(root) {
  return loadShields(root).redactions.slice().sort((a, b) => String(b.at).localeCompare(String(a.at)))
}
