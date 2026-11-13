// src/core/accounts.js —— 人物卡（每账户一张）+ 主卡成员表。
//
// 用户 2026-11-13 定案：
//   · 只有一种卡：每张卡对应一个账户（app + account）；账户描述、权重、昵称、初识都在卡上。
//   · 多张卡属于同一人时：所有卡 id 写进 **id 最小那张卡** 的 `members`；列表只显示这张主卡，
//     其他卡隐藏但账户字段照常维护。
//   · 人物描述 = 成员卡账户描述按卡 id 升序直接拼接（不设上限）；人物权重 = 成员卡权重之和（封顶 100）。
//   · 管理员/重要人物/黑白名单只存在主卡上；主卡换人时搬过去。
//   · 不存合并/分离历史；想记就写进账户描述。
//   · 好友关系不单独存，好友备注写进账户描述。
//   · 账户描述上限 2000 个字符。
import fs from 'node:fs'
import path from 'node:path'

import { localIso, readJson, ulid, writeJsonAtomic } from './fsx.js'
import { P } from './paths.js'
import { requirePid } from './scope.js'
import { writeTracked } from './version.js'

export const PLATFORMS = ['qq', 'bili', 'weibo', 'wechat', 'xhs', 'tieba', 'tg', 'github', 'pet', 'dsh']
export const CARD_DESC_MAX_CHARS = 2000

export function weightFromStats(stats = {}) {
  const messages = Number(stats.messages ?? 0)
  const activeDays = Number(stats.activeDays ?? 0)
  const last30 = Number(stats.last30 ?? 0)
  return Math.max(0, Math.min(100, Math.round(messages * 0.5 + activeDays * 1.0 + last30 * 0.3)))
}

function base(root, pid) {
  return path.join(root, P.personas, requirePid(root, pid), 'entities')
}

export function cardsRel(pid) {
  return `${P.personas}/${pid}/entities/cards.json`
}
export function cardRel(pid, id) {
  return `${P.personas}/${pid}/entities/cards/${String(id).replace(/[\\/:*?"<>|]/g, '_')}.json`
}
export function newCardUid() {
  return 'card_' + ulid()
}
export const isCardUid = (s) => /^(card_|acct_)/.test(String(s ?? ''))

const keyOf = (app, account) => `${String(app)}:${String(account)}`

export function loadCardRegistry(root, pid = null) {
  const j = readJson(path.join(base(root, pid), 'cards.json'), null)
  if (!j || typeof j !== 'object') return { version: 1, cards: {}, byAccount: {} }
  return {
    version: 1,
    cards: j.cards && typeof j.cards === 'object' ? j.cards : {},
    byAccount: j.byAccount && typeof j.byAccount === 'object' ? j.byAccount : {},
  }
}

const cardCache = new Map()

function cacheKey(root, pid) {
  return `${path.resolve(root)}|${requirePid(root, pid)}`
}

function stampFile(root, pid) {
  return path.join(base(root, pid), '.cards-stamp')
}

function stampOf(root, pid) {
  try {
    const st = fs.statSync(stampFile(root, pid))
    return `${Math.round(st.mtimeMs)}:${st.size}`
  } catch {
    return '0:0'
  }
}

function invalidateCards(root, pid) {
  const p = requirePid(root, pid)
  cardCache.delete(cacheKey(root, p))
  try {
    fs.mkdirSync(path.dirname(stampFile(root, p)), { recursive: true })
    fs.writeFileSync(stampFile(root, p), `${Date.now()}-${Math.random()}`)
  } catch {
    /* 缓存失效失败不挡写盘 */
  }
}

export function saveCardRegistry(root, data, pid = null) {
  writeJsonAtomic(path.join(base(root, pid), 'cards.json'), data)
  invalidateCards(root, pid)
  return data
}

function ensureDir(file) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
}

export function readCard(root, pid, id) {
  return readJson(path.join(root, cardRel(requirePid(root, pid), id)), null)
}

export function writeCard(root, pid, id, card) {
  ensureDir(path.join(root, cardRel(requirePid(root, pid), id)))
  writeJsonAtomic(path.join(root, cardRel(requirePid(root, pid), id)), card)
  invalidateCards(root, pid)
  return card
}

function blankCard({ id, app, account, nicknames = [], description = '', firstMet = null, created = null }) {
  return {
    id,
    app,
    account: String(account),
    nicknames: [...new Set(nicknames.map((x) => String(x ?? '').trim()).filter(Boolean))],
    description: String(description ?? ''),
    weight: 0,
    firstMet: firstMet ?? null,
    members: [],
    tier: null,
    pinned: false,
    pinRank: 0,
    stats: { messages: 0, activeDays: 0, last30: 0, dayCounts: {}, updatedAt: null },
    created: created || localIso(),
    updated_at: localIso(),
  }
}

export function listCards(root, pid = null) {
  const p = requirePid(root, pid)
  const key = cacheKey(root, p)
  const stamp = stampOf(root, p)
  const hit = cardCache.get(key)
  if (hit && hit.stamp === stamp) return hit.cards
  const reg = loadCardRegistry(root, p)
  const cards = Object.keys(reg.cards)
    .map((id) => readCard(root, p, id))
    .filter(Boolean)
  cardCache.set(key, { stamp, cards })
  return cards
}

export function cardByAccount(root, pid, app, account) {
  const reg = loadCardRegistry(root, pid)
  return reg.byAccount[keyOf(app, account)] ?? null
}

export function loadCard(root, pid, id) {
  return readCard(root, pid, id)
}

/** 新建卡；同一 (app, account) 只能一张。 */
export function createCard(root, pid, { app, account, nicknames = [], description = '', firstMet = null, id = null } = {}) {
  const a = String(app ?? '').trim()
  const acc = String(account ?? '').trim()
  if (!/^[a-z0-9]{2,24}$/.test(a)) throw new Error('app 只能由小写字母和数字组成，2~24 字符')
  if (!acc) throw new Error('缺少账户')
  const hit = cardByAccount(root, pid, a, acc)
  if (hit) throw new Error(`这个账户已经有卡了：${a}:${acc}（${hit}）`)
  const cid = id || newCardUid()
  const card = blankCard({ id: cid, app: a, account: acc, nicknames, description, firstMet })
  assertDescription(card.description)
  const reg = loadCardRegistry(root, pid)
  reg.cards[cid] = { id: cid, app: a, account: acc, created: card.created }
  reg.byAccount[keyOf(a, acc)] = cid
  saveCardRegistry(root, reg, pid)
  writeCard(root, pid, cid, card)
  return card
}

export function assertDescription(text) {
  const s = String(text ?? '')
  if ([...s].length > CARD_DESC_MAX_CHARS) throw new Error(`账户描述最多 ${CARD_DESC_MAX_CHARS} 个字符`)
}

export function setCardDescription(root, pid, id, description, { actor = 'human:editor', reason = '更新账户描述' } = {}) {
  const card = readCard(root, pid, id)
  if (!card) throw new Error(`卡不存在：${id}`)
  const text = String(description ?? '').trim()
  assertDescription(text)
  card.description = text
  card.updated_at = localIso()
  const rel = cardRel(requirePid(root, pid), id)
  writeTracked(root, rel, JSON.stringify(card, null, 2) + '\n', { actor, reason })
  invalidateCards(root, pid)
  return card
}

export function setCardNicknames(root, pid, id, nicknames) {
  const card = readCard(root, pid, id)
  if (!card) throw new Error(`卡不存在：${id}`)
  card.nicknames = [...new Set((Array.isArray(nicknames) ? nicknames : String(nicknames ?? '').split(/\s+/)).map((x) => String(x ?? '').trim()).filter(Boolean))]
  card.updated_at = localIso()
  writeCard(root, pid, id, card)
  return card
}

export function noteCardMessage(root, pid, id, { now = Date.now(), ts = null } = {}) {
  const card = readCard(root, pid, id)
  if (!card) return null
  const at = ts ? new Date(ts) : new Date(now)
  if (Number.isNaN(at.getTime())) return card
  const day = `${at.getFullYear()}-${String(at.getMonth() + 1).padStart(2, '0')}-${String(at.getDate()).padStart(2, '0')}`
  const stats = card.stats ?? { messages: 0, activeDays: 0, last30: 0, dayCounts: {}, updatedAt: null }
  const dayCounts = { ...(stats.dayCounts ?? {}) }
  dayCounts[day] = Number(dayCounts[day] ?? 0) + 1
  const cutoff = new Date(at.getTime() - 60 * 86_400_000)
  for (const k of Object.keys(dayCounts)) {
    const d = new Date(`${k}T00:00:00`)
    if (Number.isNaN(d.getTime()) || d < cutoff) delete dayCounts[k]
  }
  const last30 = Object.entries(dayCounts).reduce(
    (n, [k, v]) => (new Date(`${k}T00:00:00`) >= new Date(at.getTime() - 30 * 86_400_000) ? n + Number(v) : n),
    0,
  )
  card.stats = { messages: Number(stats.messages ?? 0) + 1, activeDays: Object.keys(dayCounts).length, last30, dayCounts, updatedAt: localIso(at) }
  if (!card.firstMet) card.firstMet = localIso(at)
  card.weight = weightFromStats(card.stats)
  card.updated_at = localIso(at)
  writeCard(root, pid, id, card)
  return card
}

// ── 主卡 / 成员表（全表扫描，不存 canonicalId）────────────────────────────

/**
 * 全表扫描：members 非空的卡是“主卡候选”，列表里的每个 id 都归到其中最小的主卡。
 * 不写盘；用于读时解析。
 */
export function cardIndex(root, pid = null) {
  const cards = listCards(root, pid)
  const byId = new Map(cards.map((c) => [c.id, c]))
  const map = new Map()
  const conflicts = []
  for (const card of cards) {
    const members = Array.isArray(card.members) ? card.members.filter((x) => byId.has(x)) : []
    if (!members.length) continue
    const main = [...new Set([...members, card.id])].sort()[0]
    for (const id of new Set([...members, card.id])) {
      const prev = map.get(id)
      if (!prev || main < prev) map.set(id, main)
      else if (prev !== main) conflicts.push({ id, kept: prev, dropped: main })
    }
  }
  return { cards, byId, map, conflicts }
}

export function mainOf(root, pid, id) {
  return cardIndex(root, pid).map.get(String(id)) ?? String(id)
}

export function groupOf(root, pid, id) {
  const idx = cardIndex(root, pid)
  const main = idx.map.get(String(id)) ?? String(id)
  const card = idx.byId.get(main)
  const members = card?.members?.length ? [...new Set(card.members)].filter((x) => idx.byId.has(x)) : [main]
  return [...new Set([main, ...members])].sort().map((x) => idx.byId.get(x)).filter(Boolean)
}

/** 人物级字段只在主卡上；返回主卡。 */
export function mainCard(root, pid, id) {
  const main = mainOf(root, pid, id)
  return readCard(root, pid, main)
}

/**
 * 合并：所有卡的 id 写进 id 最小那张的 members。
 * 主卡换人时，人物级字段搬到新主卡；其他卡清空 members/人物级字段。
 */
export function mergeCards(root, pid, ids = []) {
  const wanted = [...new Set(ids.map(String).filter(Boolean))]
  if (!wanted.length) throw new Error('至少要给一张卡')
  const idx = cardIndex(root, pid)
  const all = new Set()
  for (const id of wanted) {
    if (!idx.byId.has(id)) throw new Error(`卡不存在：${id}`)
    const main = idx.map.get(id) ?? id
    const mainCardRec = idx.byId.get(main)
    const group = mainCardRec?.members?.length ? mainCardRec.members : [main]
    for (const x of group) if (idx.byId.has(x)) all.add(x)
  }
  const list = [...all].sort()
  const main = list[0]
  const mainRec = readCard(root, pid, main)
  const donor = list.map((id) => readCard(root, pid, id)).find((c) => c && (c.tier || c.pinned))
  if (donor && donor.id !== main) {
    mainRec.tier = donor.tier ?? null
    mainRec.pinned = Boolean(donor.pinned)
    mainRec.pinRank = Number(donor.pinRank ?? 0)
    donor.tier = null
    donor.pinned = false
    donor.pinRank = 0
    writeCard(root, pid, donor.id, donor)
  }
  for (const id of list) {
    const card = id === main ? mainRec : readCard(root, pid, id)
    if (!card) continue
    if (id === main) {
      card.members = list.length > 1 ? list : []
    } else {
      card.members = []
      card.tier = null
      card.pinned = false
      card.pinRank = 0
    }
    card.updated_at = localIso()
    writeCard(root, pid, id, card)
  }
  return { main, members: list.length > 1 ? list : [] }
}

/** 分离：把一张卡从组里移除；它是主卡时，主卡搬到剩下最小 id。 */
export function splitCard(root, pid, id) {
  const idx = cardIndex(root, pid)
  if (!idx.byId.has(id)) throw new Error(`卡不存在：${id}`)
  const main = idx.map.get(id) ?? id
  const mainRec = readCard(root, pid, main)
  const group = mainRec?.members?.length ? [...new Set(mainRec.members)] : [main]
  const rest = group.filter((x) => x !== id)
  if (!rest.length) return { main, members: [] }
  const newMain = rest.sort()[0]
  const newRec = readCard(root, pid, newMain)
  const splitRec = readCard(root, pid, id)
  if (main === id) {
    newRec.tier = mainRec.tier ?? null
    newRec.pinned = Boolean(mainRec.pinned)
    newRec.pinRank = Number(mainRec.pinRank ?? 0)
    splitRec.tier = null
    splitRec.pinned = false
    splitRec.pinRank = 0
  }
  newRec.members = rest.length > 1 ? rest.sort() : []
  splitRec.members = []
  writeCard(root, pid, newMain, newRec)
  writeCard(root, pid, id, splitRec)
  if (main !== id) {
    mainRec.members = rest.length > 1 ? rest.sort() : []
    mainRec.updated_at = localIso()
    writeCard(root, pid, main, mainRec)
  } else {
    mainRec.members = []
    mainRec.updated_at = localIso()
    writeCard(root, pid, main, mainRec)
  }
  return { main: newMain, members: rest.length > 1 ? rest.sort() : [] }
}

// ── 派生 ───────────────────────────────────────────────────────────────

export function personDescription(root, pid, id) {
  return groupOf(root, pid, id)
    .map((c) => String(c.description ?? '').trim())
    .filter(Boolean)
    .filter((x, i, arr) => arr.indexOf(x) === i)
    .join('\n')
}

export function personWeight(root, pid, id) {
  const sum = groupOf(root, pid, id).reduce((n, c) => n + Number(c.weight ?? 0), 0)
  return Math.min(100, Math.round(sum))
}

export function labelOfPerson(root, pid, id) {
  const main = [...groupOf(root, pid, id)].sort((a, b) => a.id.localeCompare(b.id))[0]
  const names = main?.nicknames ?? []
  return names.length ? names.join(' / ') : main ? `${main.app}:${main.account}` : String(id)
}

export function nicknamesOfPerson(root, pid, id) {
  const out = []
  for (const c of groupOf(root, pid, id)) for (const n of c.nicknames ?? []) if (!out.includes(n)) out.push(n)
  return out
}

export function personForAccount(root, pid, cardId) {
  const card = readCard(root, pid, cardId)
  if (!card) return null
  const main = mainOf(root, pid, cardId)
  return readCard(root, pid, main)
}

export function setCardPersonFields(root, pid, id, patch = {}) {
  const main = mainOf(root, pid, id)
  const card = readCard(root, pid, main)
  if (!card) throw new Error(`卡不存在：${id}`)
  Object.assign(card, patch)
  card.updated_at = localIso()
  writeCard(root, pid, main, card)
  return card
}

// ── 写路径 ─────────────────────────────────────────────────────────────

export function setCardWeight(root, pid, id, stats, weight) {
  const card = readCard(root, pid, id)
  if (!card) return null
  if (JSON.stringify(card.stats ?? {}) === JSON.stringify(stats ?? {}) && Number(card.weight ?? 0) === Number(weight ?? 0)) return card
  card.stats = stats
  card.weight = Number(weight ?? 0)
  card.updated_at = localIso()
  writeCard(root, pid, id, card)
  return card
}

export function noteFriendRemark(root, pid, id, { remark = '' } = {}) {
  const card = readCard(root, pid, id)
  if (!card || !remark) return false
  const lines = String(card.description ?? '').split('\n')
  const idx = lines.findIndex((l) => l.startsWith('好友备注：'))
  if (idx >= 0) lines[idx] = `好友备注：${remark}`
  else lines.push(`好友备注：${remark}`)
  card.description = lines.join('\n').slice(0, CARD_DESC_MAX_CHARS)
  card.updated_at = localIso()
  writeCard(root, pid, id, card)
  return true
}

/** 按 (app, account) 找卡；没有就建。 */
export function ensureCard(root, pid, { app, account, nickname = '', nicknames = null, created = null } = {}) {
  const a = String(app || 'unknown')
  const acc = String(account ?? '').trim()
  if (!acc) throw new Error('缺少账户')
  const hit = cardByAccount(root, pid, a, acc)
  if (hit) {
    const card = readCard(root, pid, hit)
    const want = [...(Array.isArray(nicknames) ? nicknames : nickname ? [nickname] : [])].map(String).filter(Boolean)
    if (want.length) {
      const set = new Set(card.nicknames ?? [])
      let changed = false
      for (const n of want) if (!set.has(n)) { set.add(n); changed = true }
      if (changed) {
        card.nicknames = [...set]
        card.updated_at = localIso()
        writeCard(root, pid, hit, card)
      }
    }
    return { cardId: hit, created: false, card: readCard(root, pid, hit) }
  }
  const card = createCard(root, pid, { app: a, account: acc, nicknames: nicknames ?? (nickname ? [nickname] : []), created })
  return { cardId: card.id, created: true, card }
}
