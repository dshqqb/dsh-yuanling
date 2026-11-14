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
//
// 用户 2026-11-14 定的性能：人物卡会长到几千张，**读路径不能每轮把全部卡文件读一遍**。
// 所以：
//   · 存储还是一卡一文件（可读、可 diff、可复制迁移）；
//   · 读缓存三层——注册表、卡内容（按 id 增量失效）、主卡成员表（派生）；
//   · "写代数" = 进程内计数器 + `.cards-stamp` 的 mtime/size，进程外写也能感知；
//   · 全表只给 UI / 统计 / 称呼索引用，每轮上下文只点查在场的那几个人。
import fs from 'node:fs'
import path from 'node:path'

import { localIso, readJson, ulid, writeJsonAtomic } from './fsx.js'
import { P } from './paths.js'
import { requirePid } from './scope.js'
import { writeTracked } from './version.js'

export const PLATFORMS = ['qq', 'bili', 'weibo', 'wechat', 'xhs', 'tieba', 'tg', 'github', 'pet', 'dsh']
export const CARD_DESC_MAX_CHARS = 2000

/**
 * 卡只代表**好友**（加上管理员那张）。"重要人物"是卡上的独立标记 `pinned`。
 *
 * 用户 2026-11-14 定：**没有"路人卡"这回事**——说过话才建卡；只在群里见过、没说过话的人，
 * 系统里不留任何记录（连名册都没有）。管理员固定是 `dsh:master` 那张卡（见 isConsoleMasterCard）。
 */
export function weightFromStats(stats = {}) {
  const messages = Number(stats.messages ?? 0)
  const activeDays = Number(stats.activeDays ?? 0)
  const last30 = Number(stats.last30 ?? 0)
  return Math.max(0, Math.min(100, Math.round(messages * 0.5 + activeDays * 1.0 + last30 * 0.3)))
}

function base(root, pid) {
  return path.join(root, P.personas, requirePid(root, pid), 'entities')
}

export function cardRel(pid, id) {
  return `${P.personas}/${pid}/entities/cards/${String(id).replace(/[\\/:*?"<>|]/g, '_')}.json`
}
export function newCardUid() {
  return 'card_' + ulid()
}
export const isCardUid = (s) => /^(card_|acct_)/.test(String(s ?? ''))

const keyOf = (app, account) => `${String(app)}:${String(account)}`

// ── 写代数 + 三层读缓存 ────────────────────────────────────────────────
//
// `.cards-stamp` 是**跨进程**的"写过卡"的凭据（CLI 和管理台可能不在一个进程）。
// 光看它的 mtime 不够：同一毫秒里连写两张卡（合并一次就写好几张）会因为
// 时间戳精度相同而漏判。所以代数 = **进程内计数器 + 落盘时间戳**：
// 进程内写必变，进程外写靠时间戳变，两头都不漏。
let writeGen = 0
let reads = 0

/** 只读诊断：这一进程真正打开过多少个卡文件（测试用它断言"与卡数无关"）。 */
export function cardIoStats() {
  return { reads }
}
export function resetCardIoStats() {
  reads = 0
}

function cacheKey(root, pid) {
  return `${path.resolve(root)}|${requirePid(root, pid)}`
}

function stampFile(root, pid) {
  return path.join(base(root, pid), '.cards-stamp')
}

function stampOf(root, pid) {
  try {
    const st = fs.statSync(stampFile(root, pid))
    return `${writeGen}:${st.mtimeMs}:${st.size}`
  } catch {
    return `${writeGen}:0:0`
  }
}

/** 记一次"卡数据变了"，并返回新的写代数。 */
function touchCards(root, pid) {
  writeGen += 1
  try {
    fs.mkdirSync(path.dirname(stampFile(root, pid)), { recursive: true })
    fs.writeFileSync(stampFile(root, pid), String(writeGen))
  } catch {
    /* 写标记失败不挡写盘：代数已经变了，进程内仍然会重建 */
  }
  return stampOf(root, pid)
}

export const cardGen = (root, pid) => stampOf(root, requirePid(root, pid))

const regCache = new Map() // key -> { stamp, reg }
const cardCache = new Map() // key -> { stamp, reg, ids, byId }
const idxCache = new Map() // key -> { stamp, idx }

function registryFile(root, pid) {
  return path.join(base(root, pid), 'cards.json')
}

export function loadCardRegistry(root, pid = null) {
  const p = requirePid(root, pid)
  const key = cacheKey(root, p)
  let stamp = 'missing'
  try {
    const st = fs.statSync(registryFile(root, p))
    stamp = `${st.mtimeMs}:${st.size}`
  } catch {
    /* 还没建注册表 */
  }
  const hit = regCache.get(key)
  if (hit && hit.stamp === stamp) return hit.reg

  const j = readJson(registryFile(root, p), null)
  const reg =
    j && typeof j === 'object'
      ? {
          version: 1,
          cards: j.cards && typeof j.cards === 'object' ? j.cards : {},
          byAccount: j.byAccount && typeof j.byAccount === 'object' ? j.byAccount : {},
        }
      : { version: 1, cards: {}, byAccount: {} }
  regCache.set(key, { stamp, reg })
  return reg
}

export function saveCardRegistry(root, data, pid = null) {
  const p = requirePid(root, pid)
  const key = cacheKey(root, p)
  writeJsonAtomic(registryFile(root, p), data)
  regCache.delete(key)
  idxCache.delete(key)
  const reg = loadCardRegistry(root, p)
  const store = cardCache.get(key)
  if (store) {
    // 注册表变了：id 名单跟着变，但已在缓存里的卡内容不必重读
    store.reg = reg
    store.ids = Object.keys(reg.cards)
    for (const id of [...store.byId.keys()]) if (!(id in reg.cards)) store.byId.delete(id)
  }
  // 注册表本身也是"卡数据变了"：称呼索引、成员表都得跟着重建
  const stamp = touchCards(root, p)
  if (store) store.stamp = stamp
  return data
}

function ensureDir(file) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
}

export function readCard(root, pid, id) {
  reads += 1
  return readJson(path.join(root, cardRel(requirePid(root, pid), id)), null)
}

export function writeCard(root, pid, id, card) {
  const p = requirePid(root, pid)
  ensureDir(path.join(root, cardRel(p, id)))
  writeJsonAtomic(path.join(root, cardRel(p, id)), card)
  forgetCard(root, p, id)
  return card
}

/** 内容变了：只丢这一张，别把整表缓存打掉。 */
function forgetCard(root, pid, id) {
  const key = cacheKey(root, pid)
  const stamp = touchCards(root, pid)
  const store = cardCache.get(key)
  if (store) {
    store.byId.delete(String(id))
    store.stamp = stamp
  }
  idxCache.delete(key)
}

export function listCards(root, pid = null) {
  const p = requirePid(root, pid)
  const key = cacheKey(root, p)
  const stamp = stampOf(root, p)
  let store = cardCache.get(key)
  if (!store) {
    store = { stamp, reg: null, ids: [], byId: new Map() }
    cardCache.set(key, store)
  } else if (store.stamp !== stamp) {
    // 不是这个进程写的（CLI / 另一个进程）：只信任磁盘，整表重读一次
    store.byId.clear()
    store.stamp = stamp
  }

  const reg = loadCardRegistry(root, p)
  if (store.reg !== reg) {
    store.reg = reg
    store.ids = Object.keys(reg.cards)
    for (const id of [...store.byId.keys()]) if (!(id in reg.cards)) store.byId.delete(id)
  }

  const out = []
  for (const id of store.ids) {
    let card = store.byId.get(id)
    if (card === undefined) {
      card = readCard(root, p, id) // 只读缺的那几张
      if (card) store.byId.set(id, card)
    }
    if (card) out.push(card)
  }
  return out
}

/**
 * 只读点查一张卡（走缓存）。
 *
 * **别改它返回的对象**——那是缓存里的那一份；要改就走 readCard + writeCard。
 * 用它的是"这一轮要带谁"这种读路径：群聊一次要解析几十个账号，
 * 不该每个账号都去敲一次盘。
 */
export function peekCard(root, pid, id) {
  const p = requirePid(root, pid)
  const key = cacheKey(root, p)
  const stamp = stampOf(root, p)
  const store = cardCache.get(key)
  if (store && store.stamp === stamp) {
    const hit = store.byId.get(String(id))
    if (hit !== undefined) return hit
  }
  const card = readCard(root, p, id)
  if (card && store && store.stamp === stamp) store.byId.set(String(id), card)
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
    pinned: false,
    pinRank: 0,
    stats: { messages: 0, activeDays: 0, last30: 0, dayCounts: {}, updatedAt: null },
    created: created || localIso(),
    updated_at: localIso(),
  }
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
  forgetCard(root, requirePid(root, pid), id)
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
export const isConsoleMasterCard = (card) => card?.app === 'dsh' && card?.account === 'master'

function mainIdFor(cards, ids) {
  const list = [...new Set(ids)]
  const master = list.map((id) => cards.get(id)).find((c) => c && isConsoleMasterCard(c))
  return master?.id ?? list.sort()[0]
}

export function cardIndex(root, pid = null) {
  const p = requirePid(root, pid)
  const key = cacheKey(root, p)
  const stamp = stampOf(root, p)
  const hit = idxCache.get(key)
  if (hit && hit.stamp === stamp) return hit.idx

  const cards = listCards(root, p)
  const byId = new Map(cards.map((c) => [c.id, c]))
  const map = new Map()
  const conflicts = []
  for (const card of cards) {
    const members = Array.isArray(card.members) ? card.members.filter((x) => byId.has(x)) : []
    if (!members.length) continue
    const group = new Set([...members, card.id])
    const main = mainIdFor(byId, group)
    for (const id of group) {
      const prev = map.get(id)
      if (!prev || main < prev) map.set(id, main)
      else if (prev !== main) conflicts.push({ id, kept: prev, dropped: main })
    }
  }
  const idx = { cards, byId, map, conflicts }
  idxCache.set(key, { stamp, idx })
  return idx
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

/**
 * 合并：所有卡的 id 写进主卡的 members。
 *
 * 主卡 = 管理员那张（`dsh:master`，永远主卡）；没有管理员时才取 id 最小。
 * 人物级字段（重要人物）只在主卡上：合并进来的卡如果被标过重要，标记搬到主卡。
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
  const groupCards = list.map((id) => readCard(root, pid, id)).filter(Boolean)
  const main = groupCards.find(isConsoleMasterCard)?.id ?? list[0]
  const mainRec = readCard(root, pid, main)
  const donor = groupCards.find((c) => c.pinned && c.id !== main)
  if (donor) {
    // 管理员不能兼任"重要人物"：并进管理员时，重要标记直接丢掉
    if (!mainRec.pinned && !isConsoleMasterCard(mainRec)) {
      mainRec.pinned = true
      mainRec.pinRank = Number(donor.pinRank ?? 0)
    }
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
  const restCards = new Map(rest.map((x) => [x, readCard(root, pid, x)]))
  const newMain = mainIdFor(restCards, rest)
  const newRec = readCard(root, pid, newMain)
  const splitRec = readCard(root, pid, id)
  if (main === id) {
    newRec.pinned = Boolean(mainRec.pinned)
    newRec.pinRank = Number(mainRec.pinRank ?? 0)
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
  const group = groupOf(root, pid, id)
  const main = group.find(isConsoleMasterCard) ?? [...group].sort((a, b) => a.id.localeCompare(b.id))[0]
  const names = main?.nicknames ?? []
  return names.length ? names.join(' / ') : main ? `${main.app}:${main.account}` : String(id)
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
