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
  createCard,
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
  peekCard,
  isConsoleMasterCard,
} from './accounts.js'

export {
  readCard,
  writeCard,
  cardByAccount,
  listCards,
  createCard,
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
  peekCard,
  isConsoleMasterCard,
}

// ── 管理员 ──────────────────────────────────────────────────────────────
//
// 用户 2026-11-14 定：**管理员永远是 `dsh:master` 那张卡**（安装时建的第一张）。
// 不可卸任、不可换人，也不能被设为"重要人物"。所以这里不存任何"谁是管理员"的状态，
// 每次都由 app/account 派生——没有可写坏的地方。

/** 管理员（没有就是 null）。 */
export function currentAdmin(root, pid = null) {
  const p = requirePid(root, pid)
  const id = cardByAccount(root, p, 'dsh', 'master')
  if (!id) return null
  const card = peekCard(root, p, mainOf(root, p, id))
  return card ? { ...card, uid: card.id, display: labelOfPerson(root, p, card.id) } : null
}

/** 初识：只有"第一次跟她直接说话"才写（私聊 / 被 @ / 叫名字 / 引用回复）。 */
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
  const card = peekCard(root, p, main)
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
  return { uid: main, nicknames: next }
}

// ── 重要人物 ──────────────────────────────────────────────────────────

export function setPinned(root, pid, uid, pinned = true) {
  const main = mainOf(root, pid, uid)
  const card = readCard(root, pid, main)
  if (!card) throw new Error(`没有这个人物：${uid}`)
  // 管理员固定在 dsh:master 上，不能兼任"重要人物"
  if (pinned && isConsoleMasterCard(card)) throw new Error('管理员不能设为重要人物')
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
  const rows = listMainCards(root, p).filter((c) => c.pinned && !isConsoleMasterCard(c))
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

// ── 列表 ───────────────────────────────────────────────────────────────

function listMainCards(root, pid) {
  const p = requirePid(root, pid)
  const idx = cardIndex(root, p)
  const hidden = new Set()
  for (const [id, main] of idx.map) if (id !== main) hidden.add(id)
  return idx.cards.filter((c) => !hidden.has(c.id))
}

/** 一行人物：主卡 + 它的成员卡拼起来。UI 列表和点查**共用这一份**，免得两套逻辑漂移。 */
function rowFromGroup(idx, mainId) {
  const main = idx.byId.get(mainId)
  if (!main) return null
  const group = (main.members?.length ? main.members : [main.id])
    .map((id) => idx.byId.get(id))
    .filter(Boolean)
    .sort((a, b) => a.id.localeCompare(b.id))
  const accounts = group.map((c) => ({
    uid: c.id,
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
  const admin = isConsoleMasterCard(main)
  return {
    uid: main.id,
    display: main.nicknames?.length ? main.nicknames.join(' / ') : `${main.app}:${main.account}`,
    nicknames: names,
    accounts,
    identities: accounts.map((a) => ({ platform: a.app, id: a.nativeId })),
    description,
    weight: Math.min(100, group.reduce((n, c) => n + Number(c.weight ?? 0), 0)),
    admin,
    pinned: !admin && Boolean(main.pinned),
    pinRank: admin ? 0 : Number(main.pinRank ?? 0),
    firstMet: first,
    lastMet: first,
  }
}

export function listPeopleForUi(root, pid) {
  const p = requirePid(root, pid)
  const idx = cardIndex(root, p)
  const hidden = new Set()
  for (const [id, main] of idx.map) if (id !== main) hidden.add(id)
  const rows = []
  for (const main of idx.cards) {
    if (hidden.has(main.id)) continue
    const row = rowFromGroup(idx, main.id)
    if (row) rows.push(row)
  }
  return rows
}

/**
 * 点查一个人（这一轮在场的某一个）——只装配这一行，**不再把几千张卡装配成列表**。
 *
 * 主卡成员表（cardIndex）按写代数 memo 着，所以这里只是两次 Map 查；真正省掉的是
 * "为 3~8 个人把全部卡都拼一遍行"的那笔账。
 */
export function personRow(root, pid, uid) {
  const p = requirePid(root, pid)
  const idx = cardIndex(root, p)
  const id = String(uid ?? '')
  if (!id) return null
  const main = idx.map.get(id) ?? id
  return rowFromGroup(idx, main)
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
