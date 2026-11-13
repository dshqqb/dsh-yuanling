// test/helpers.mjs —— 测试专用门面。
// 产品代码只有一种卡；这里给老测试提供 createPerson/linkIdentity/readProfile 等便捷入口，
// 免得每个测试都手写“建卡 + 写描述 + 改字段”。
export * from '../src/core/entities.js'

import { localIso } from '../src/core/fsx.js'
import { P } from '../src/core/paths.js'
import { activePid } from '../src/core/scope.js'
import path from 'node:path'

import {
  cardByAccount,
  cardRel,
  createCard,
  listCards,
  loadCardRegistry,
  mainOf,
  mergeCards,
  personDescription,
  readCard,
  saveCardRegistry,
  setCardDescription,
  setCardNicknames,
  setCardPersonFields,
  setCardWeight,
  splitCard,
  writeCard,
} from '../src/core/accounts.js'
import { listPeopleForUi, listCandidates } from '../src/core/entities.js'

export function personProfileRel(pid, id) {
  return cardRel(pid, id)
}

export function readProfile(root, pid, id) {
  const main = mainOf(root, pid, id)
  const card = readCard(root, pid, main)
  if (!card) return null
  return {
    uid: main,
    display: card.nicknames?.join(' / ') || `${card.app}:${card.account}`,
    sketch: personDescription(root, pid, main),
    first_met: card.firstMet,
    weight: Number(card.weight ?? 0),
    pinned: Boolean(card.pinned),
    pin_rank: Number(card.pinRank ?? 0),
    tier: card.tier ?? null,
    created: card.created,
    updated_at: card.updated_at,
  }
}

export function writeProfile(root, pid, id, patch = {}, { actor = 'system:entity', reason = null } = {}) {
  const main = mainOf(root, pid, id)
  const card = readCard(root, pid, main)
  if (!card) throw new Error(`人物不存在：${id}`)
  if (typeof patch.sketch === 'string') {
    setCardDescription(root, pid, main, patch.sketch, { actor, reason: patch.__reason ?? reason ?? '更新账户描述' })
  }
  const next = {}
  if (patch.first_met) next.firstMet = patch.first_met
  if (patch.pinned !== undefined) next.pinned = Boolean(patch.pinned)
  if (patch.pin_rank !== undefined) next.pinRank = Number(patch.pin_rank)
  if (patch.tier !== undefined) next.tier = patch.tier
  if (patch.weight !== undefined) next.weight = Number(patch.weight)
  if (Object.keys(next).length) setCardPersonFields(root, pid, main, next)
  return readProfile(root, pid, main)
}

export function createPerson(root, { uid = null, display = '', aliases = [] } = {}) {
  const card = createCard(root, null, {
    app: 'unknown',
    account: (uid || `placeholder-${Date.now()}`).replace(/^card_/, ''),
    nicknames: display ? [display] : [],
    id: uid || undefined,
  })
  return { uid: card.id, display: display || card.id, aliases: [...aliases] }
}

export function createPersonAuto(root, { display = '', platform = null, nativeId = '', uid = null, aliases = [] } = {}) {
  if (platform && nativeId) {
    const card = createCard(root, null, { app: platform, account: nativeId, nicknames: display ? [display] : [], id: uid || undefined })
    return { uid: card.id, display: display || card.id }
  }
  return createPerson(root, { uid, display, aliases })
}

export function linkIdentity(root, uid, { platform, id } = {}) {
  const card = readCard(root, null, uid)
  if (!card) throw new Error(`人物不存在：${uid}`)
  const existing = cardByAccount(root, null, platform, id)
  if (existing) {
    if (existing === uid) return { acct: uid, uid, changed: false }
    const main = mergeCards(root, null, [uid, existing])
    return { acct: existing, uid: main.main, changed: true }
  }
  if (card.app === 'unknown') {
    card.app = String(platform)
    card.account = String(id)
    card.updated_at = localIso()
    writeCard(root, null, uid, card)
    const reg = loadCardRegistry(root, null)
    delete reg.byAccount[`unknown:${uid.replace(/^card_/, '')}`]
    reg.byAccount[`${platform}:${id}`] = uid
    if (reg.cards[uid]) { reg.cards[uid].app = String(platform); reg.cards[uid].account = String(id) }
    saveCardRegistry(root, reg, null)
    return { acct: uid, uid, changed: true }
  }
  const created = createCard(root, null, { app: platform, account: id, nicknames: card.nicknames ?? [] })
  const r = mergeCards(root, null, [uid, created.id])
  return { acct: created.id, uid: r.main, changed: true }
}

export function loadIdentities(root, pid = null) {
  const people = {}
  for (const row of listPeopleForUi(root, pid, { includeShadow: true })) {
    people[row.uid] = {
      uid: row.uid,
      display: row.display,
      aliases: row.nicknames.slice(1),
      identities: row.identities.map((x) => ({ platform: x.platform, id: String(x.id), state: 'observed', confidence: 1 })),
      tier: row.tier,
      created: null,
    }
  }
  return { version: 3, people, merges: [], pending: listCandidates(root) }
}

export function mergePeople(root, fromUid, intoUid) {
  const r = mergeCards(root, null, [fromUid, intoUid])
  return { uid: r.main, absorbed: r.main === fromUid ? intoUid : fromUid }
}

export function splitIdentity(root, uid, platform, id) {
  const cardId = cardByAccount(root, null, platform, id)
  if (!cardId) throw new Error(`没有这个账户：${platform}:${id}`)
  const r = splitCard(root, null, cardId)
  return { uid: cardId, moved: cardId, main: r.main }
}
