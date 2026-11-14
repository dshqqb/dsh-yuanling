// src/core/entities.js —— 人物卡（每账户一张 + 主卡成员表）的对外门面。
import path from 'node:path'

import { localIso, readJson, writeJsonAtomic } from './fsx.js'
import { P } from './paths.js'
import { requirePid } from './scope.js'
import {
  readCard,
  writeCard,
  cardByAccount,
  listCards,
  setCardNicknames,
  setCardDescription,
  setCardPersonFields,
  noteFriendRemark,
  cardIndex,
  mainOf,
  groupOf,
  mergeCards,
  splitCard,
  labelOfPerson,
  personForAccount,
  ensureCard,
} from './accounts.js'

export {
  readCard,
  writeCard,
  cardByAccount,
  listCards,
  setCardNicknames,
  setCardDescription,
  cardIndex,
  mainOf,
  groupOf,
  mergeCards,
  splitCard,
  labelOfPerson,
  personForAccount,
  ensureCard,
}

// ── 卡上的状态 ──────────────────────────────────────────────────────────

/** 私聊/被叫到之后，路人卡转正。 */
export function recognizeCard(root, pid, id) {
  const main = mainOf(root, pid, id)
  const card = readCard(root, pid, main)
  if (!card) return null
  if (card.tier === 'shadow') setCardPersonFields(root, pid, main, { tier: null })
  return readCard(root, pid, main)
}

export function ensureFirstMet(root, pid, id, now = localIso()) {
  const main = mainOf(root, pid, id)
  const card = readCard(root, pid, main)
  if (!card) return { first: false, card: null }
  if (card.firstMet) return { first: false, card }
  card.firstMet = now
  card.updated_at = localIso()
  writeCard(root, pid, main, card)
  return { first: true, card }
}

// ── 账户/人物兼容 ──────────────────────────────────────────────────────

export function findByIdentity(root, platform, id, pid = null) {
  const p = requirePid(root, pid)
  const cardId = cardByAccount(root, p, platform, id)
  if (!cardId) return null
  const main = mainOf(root, p, cardId)
  const card = readCard(root, p, main)
  return {
    uid: main,
    card: cardId,
    acct: cardId,
    display: labelOfPerson(root, p, main),
    platform: String(platform),
    id: String(id),
    person: { ...card, display: labelOfPerson(root, p, main) },
  }
}

export function noteFriendship(root, uid, platform, nativeId, { remark = '' } = {}) {
  const p = requirePid(root)
  const cardId = cardByAccount(root, p, platform, nativeId)
  if (!cardId) return false
  return noteFriendRemark(root, p, cardId, { remark })
}

export function renamePersonAuto(root, pid, uid, display) {
  const main = mainOf(root, pid, uid)
  const card = readCard(root, pid, main)
  if (!card) throw new Error(`没有这个人物：${uid}`)
  const next = [...new Set([...(card.nicknames ?? []), String(display ?? '').trim()].filter(Boolean))]
  setCardNicknames(root, pid, main, next)
  if (card.tier === 'shadow') setCardPersonFields(root, pid, main, { tier: null })
  return { uid: main, nicknames: next }
}

// ── 置顶 / 管理员 ──────────────────────────────────────────────────────

export function setPinned(root, pid, uid, pinned = true) {
  const main = mainOf(root, pid, uid)
  const card = readCard(root, pid, main)
  if (!card) throw new Error(`没有这个人物：${uid}`)
  if (pinned && card.tier === 'admin') throw new Error('管理员高于重要人物，不能再设为重要')
  const rank = pinned ? (card.pinRank || nextPinRank(root, pid)) : 0
  setCardPersonFields(root, pid, main, { pinned: Boolean(pinned), pinRank: rank })
  renumberPinned(root, pid)
  return readCard(root, pid, main)
}

function nextPinRank(root, pid) {
  return pinnedPeople(root, pid).reduce((n, id) => Math.max(n, Number(readCard(root, pid, id)?.pinRank ?? 0)), 0) + 1
}

export function pinnedPeople(root, pid) {
  const p = requirePid(root, pid)
  const rows = listMainCards(root, p).filter((c) => c.pinned && c.tier !== 'admin')
  return rows.sort((a, b) => Number(a.pinRank ?? 0) - Number(b.pinRank ?? 0)).map((c) => c.id)
}

export function renumberPinned(root, pid, ids = null) {
  const list = ids ?? pinnedPeople(root, pid)
  list.forEach((id, i) => {
    const card = readCard(root, pid, id)
    if (!card) return
    if (Number(card.pinRank ?? 0) !== i) setCardPersonFields(root, pid, id, { pinRank: i })
  })
}

export function movePinned(root, pid, uid, direction) {
  const list = pinnedPeople(root, pid)
  const idx = list.indexOf(uid)
  if (idx < 0) throw new Error('不在重要人物里')
  const to = idx + (direction === 'up' ? -1 : 1)
  if (to < 0 || to >= list.length) return list
  const ids = [...list]
  ;[ids[idx], ids[to]] = [ids[to], ids[idx]]
  renumberPinned(root, pid, ids)
  return ids
}

export function setAdmin(root, uid = null) {
  const p = requirePid(root)
  const current = listMainCards(root, p).find((c) => c.tier === 'admin')
  if (uid && current && current.id !== uid) throw new Error(`已经有一个管理员（${current.id}），换人前先卸任`)
  if (!uid) {
    for (const c of listMainCards(root, p)) {
      if (c.tier === 'admin') setCardPersonFields(root, p, c.id, { tier: null, pinned: false, pinRank: 0 })
    }
    return null
  }
  const main = mainOf(root, p, uid)
  if (!readCard(root, p, main)) throw new Error(`人物不存在：${uid}`)
  // 管理员高于重要人物：同一个人不能同时占两个位置。
  setCardPersonFields(root, p, main, { tier: 'admin', pinned: false, pinRank: 0 })
  renumberPinned(root, p)
  return main
}

export function currentAdmin(root) {
  const p = requirePid(root)
  const card = listMainCards(root, p).find((c) => c.tier === 'admin')
  return card ? { ...card, uid: card.id, display: labelOfPerson(root, p, card.id) } : null
}

// ── 列表 ───────────────────────────────────────────────────────────────

function listMainCards(root, pid) {
  const p = requirePid(root, pid)
  const idx = cardIndex(root, p)
  const hidden = new Set()
  for (const [id, main] of idx.map) if (id !== main) hidden.add(id)
  return idx.cards.filter((c) => !hidden.has(c.id))
}

export function listPeopleForUi(root, pid, { includeShadow = false } = {}) {
  const p = requirePid(root, pid)
  const idx = cardIndex(root, p)
  const hidden = new Set()
  for (const [id, main] of idx.map) if (id !== main) hidden.add(id)
  const rows = []
  for (const main of idx.cards) {
    if (hidden.has(main.id)) continue
    if (!includeShadow && main.tier === 'shadow') continue
    const group = (main.members?.length ? main.members : [main.id])
      .map((id) => idx.byId.get(id))
      .filter(Boolean)
      .sort((a, b) => a.id.localeCompare(b.id))
    const accounts = group.map((c) => ({
      uid: c.id,
      platform: c.app,
      app: c.app,
      nativeId: c.account,
      nicknames: c.nicknames ?? [],
      description: c.description ?? '',
      weight: Number(c.weight ?? 0),
    }))
    const names = [...new Set(group.flatMap((c) => c.nicknames ?? []))]
    const description = group
      .map((c) => String(c.description ?? '').trim())
      .filter(Boolean)
      .filter((x, i, arr) => arr.indexOf(x) === i)
      .join('\n')
    const first = group.map((c) => c.firstMet).filter(Boolean).sort()[0] ?? null
    rows.push({
      uid: main.id,
      display: main.nicknames?.length ? main.nicknames.join(' / ') : `${main.app}:${main.account}`,
      nicknames: names,
      accounts,
      identities: accounts.map((a) => ({ platform: a.app, id: a.nativeId })),
      description,
      weight: Math.min(100, group.reduce((n, c) => n + Number(c.weight ?? 0), 0)),
      admin: main.tier === 'admin',
      tier: main.tier ?? null,
      pinned: main.tier !== 'admin' && Boolean(main.pinned),
      pinRank: main.tier === 'admin' ? 0 : Number(main.pinRank ?? 0),
      firstMet: first,
      lastMet: first,
      hasProfile: true,
    })
  }
  return rows
}

// ── 频道 ───────────────────────────────────────────────────────────────

export function parseChannel(channel) {
  const s = String(channel ?? '')
  const i = s.indexOf(':')
  if (i < 0) return { kind: 'unknown', id: s }
  return { kind: s.slice(0, i), id: s.slice(i + 1) }
}

export function personForChannel(root, channel, pid = null) {
  const p = requirePid(root, pid)
  const s = String(channel ?? '')
  if (!s.startsWith('private:')) return null
  const id = s.slice('private:'.length)
  const card = readCard(root, p, id)
  if (card) return mainOf(root, p, id)
  const acct = cardByAccount(root, p, 'qq', id)
  return acct ? mainOf(root, p, acct) : null
}

export function appForCard(root, pid, id) {
  return readCard(root, requirePid(root, pid), id)?.app ?? null
}

/** 兼容视图：主卡 → 成员卡 id。 */
function candidateCard(root, pid, item) {
  return cardByAccount(root, pid, item.platform, item.id)
}

// ── 候选 ────────────────────────────────────────────────────────────────
function candidatesFile(root, pid) {
  return path.join(root, P.personas, requirePid(root, pid), 'entities', 'candidates.json')
}

export function listCandidates(root, pid = null) {
  const j = readJson(candidatesFile(root, pid), { items: [] })
  return Array.isArray(j?.items) ? j.items : []
}

function saveCandidates(root, pid, items) {
  writeJsonAtomic(candidatesFile(root, pid), { version: 1, items })
}

export function addCandidate(root, { uid = null, platform, id, reason = '', evidence = [] }) {
  const items = listCandidates(root)
  const key = `${platform}:${id}:${uid ?? ''}`
  if (items.some((x) => x.key === key)) return { added: false, candidate: items.find((x) => x.key === key) }
  const item = { key, uid, platform: String(platform), id: String(id), reason, evidence, at: localIso() }
  items.push(item)
  saveCandidates(root, null, items)
  return { added: true, candidate: item }
}

export function confirmCandidate(root, index, { uid = null } = {}) {
  const items = listCandidates(root)
  const item = items[Number(index)]
  if (!item) throw new Error('候选不存在')
  const target = uid || item.uid
  if (!target) throw new Error('候选没有指定人物，确认时要给 uid')
  const main = mainOf(root, null, target)
  const existing = candidateCard(root, null, item)
  let acct = existing
  if (!existing) {
    const created = ensureCard(root, null, { app: item.platform, account: item.id, nickname: '' })
    acct = created.cardId
  }
  if (acct !== main) mergeCards(root, null, [main, acct])
  const out = mainOf(root, null, main)
  items.splice(Number(index), 1)
  saveCandidates(root, null, items)
  return { uid: out, acct, identity: { platform: item.platform, id: item.id } }
}

export function rejectCandidate(root, index) {
  const items = listCandidates(root)
  if (!items[Number(index)]) throw new Error('候选不存在')
  const [removed] = items.splice(Number(index), 1)
  saveCandidates(root, null, items)
  return { rejected: removed }
}
