// src/core/entities.js —— 账户卡 / 人物卡 的对外门面。
//
// 存储与核心逻辑在 accounts.js；这里保留调用方需要的门面：
//   · findByIdentity / createPerson / linkIdentity（旧名，语义已改成“账户→人物”）
//   · 人物素描、置顶、管理员、UI 列表
//   · 旧调用方的只读视图 loadIdentities()（给 aliases / claims / audience 等尚未迁移的模块）
import path from 'node:path'

import { appendLine, exists, localIso, readJson, ulid, writeJsonAtomic } from './fsx.js'
import { P } from './paths.js'
import { requirePid } from './scope.js'
import { writeTracked } from './version.js'
import {
  PLATFORMS,
  PLATFORM_ALIASES,
  accountForNative,
  accountsForPerson,
  createAccountWithPerson,
  createPersonRecord,
  ensureAccount,
  ensurePersonForAccount,
  ensurePersonProfile as ensureProfile,
  isAccountUid,
  isPersonUid,
  labelOfPerson,
  listAccounts,
  loadAccount,
  loadAccountRegistry,
  loadPersons,
  mergeAccounts,
  newAcctUid,
  newPersonUid,
  nicknamesOfPerson,
  parseIdentityText,
  personForAccount,
  personProfileRel as profileRel,
  personWeight,
  readAccountCard,
  readPersonProfile,
  savePersons,
  setAccountDescription,
  setAccountFriend,
  setAccountNicknames,
  splitPerson,
  weightFromStats,
  writeAccountCard,
  writePersonProfile,
} from './accounts.js'

export {
  PLATFORMS,
  PLATFORM_ALIASES,
  parseIdentityText,
  newAcctUid,
  newPersonUid,
  isAccountUid,
  isPersonUid,
  listAccounts,
  loadAccount,
  readAccountCard,
  writeAccountCard,
  loadAccountRegistry,
  loadPersons,
  personWeight,
  weightFromStats,
  accountsForPerson,
  nicknamesOfPerson,
  labelOfPerson,
  personForAccount,
  setAccountNicknames,
  setAccountDescription,
  setAccountFriend,
  ensureAccount,
  ensurePersonForAccount,
  createAccountWithPerson,
  mergeAccounts,
  splitPerson,
}

export const PLATFORMS_LIST = PLATFORMS

export function newUid() {
  return newPersonUid()
}

export function identitiesPath(root, pid = null) {
  return path.join(root, P.personas, requirePid(root, pid), 'entities', 'persons.json')
}

/**
 * 旧调用方的只读视图：把账户/人物拼成旧的 `{people:{uid:{display,identities,...}}, merges}` 形状。
 * **不要用它写盘**——新代码用 accounts.js。
 */
export function loadIdentities(root, pid = null) {
  const p = requirePid(root, pid)
  const persons = loadPersons(root, p).persons
  const people = {}
  const merges = []
  for (const rec of Object.values(persons)) {
    const accounts = accountsForPerson(root, p, rec.uid)
    const identities = accounts.map((a) => ({
      platform: a.platform,
      id: String(a.nativeId),
      state: 'observed',
      confidence: 1,
      friend: Boolean(a.friend),
      linked_at: a.created,
    }))
    const names = nicknamesOfPerson(root, p, rec.uid)
    people[rec.uid] = {
      uid: rec.uid,
      display: labelOfPerson(root, p, rec.uid),
      aliases: names.slice(1),
      identities,
      tier: rec.tier ?? null,
      created: rec.created,
      accounts: rec.accounts,
      primary: rec.primary,
      nicknames: names,
    }
    for (const m of rec.merges ?? []) merges.push({ ...m, into: rec.uid })
  }
  return { version: 2, people, merges, pending: listCandidates(root, pid) }
}

/** 已废弃：写盘走 accounts.js。保留函数只为尽早报错（旧代码误调用时看得见）。 */
export function saveIdentities() {
  throw new Error('saveIdentities 已废弃：请用 accounts.js（账户/人物注册表）')
}

// ── 账户 ←→ 人物 ──────────────────────────────────────────────────────

/** 按平台号找“账户 + 人物”。返回 null 或 `{uid, acct, display, ...}`。 */
export function findByIdentity(root, platform, id, pid = null) {
  const p = requirePid(root, pid)
  const acct = accountForNative(root, p, platform, id)
  if (!acct) return null
  const person = personForAccount(root, p, acct)
  if (!person) return null
  const card = loadAccount(root, p, acct)
  return {
    uid: person.uid,
    acct,
    display: labelOfPerson(root, p, person.uid),
    platform: String(platform),
    id: String(id),
    friend: Boolean(card?.friend),
    person: { ...person, display: labelOfPerson(root, p, person.uid) },
  }
}

export function findAccountByIdentity(root, platform, id, pid = null) {
  return accountForNative(root, requirePid(root, pid), platform, id)
}

/**
 * 只读兼容：建一个空人物（label 仅在没有账户时兜底）。
 * 正常入口是 createAccountWithPerson()。
 */
export function createPerson(root, { uid = newUid(), display = '', aliases = [] } = {}) {
  const p = requirePid(root)
  const rec = createPersonRecord(root, p, { uid, label: String(display ?? '').trim() })
  return { uid: rec.uid, display: display || rec.uid, aliases: [...aliases] }
}

export function createPersonAuto(root, { display = '', platform = null, nativeId = '', uid = newUid(), aliases = [] } = {}) {
  const p = requirePid(root)
  const person = createPerson(root, { uid, display })
  if (platform && nativeId) {
    const r = ensureAccount(root, p, { platform, nativeId, nickname: display || nativeId })
    const data = loadPersons(root, p)
    const rec = data.persons[person.uid]
    rec.accounts = [...new Set([...(rec.accounts ?? []), r.acct])]
    if (!rec.primary) rec.primary = r.acct
    savePersons(root, data, p)
  }
  if (aliases.length) {
    const data = loadPersons(root, p)
    data.persons[person.uid].label = display || ''
    savePersons(root, data, p)
  }
  return person
}

/** 把 (平台,号) 建账户并挂到指定人物；已被别人占用就报错。 */
export function linkIdentity(root, uid, { platform, id, state = 'confirmed', confidence = 1, evidence = [] } = {}) {
  const p = requirePid(root)
  const person = loadPersons(root, p).persons[uid]
  if (!person) throw new Error(`人物不存在：${uid}`)
  const acct = accountForNative(root, p, platform, id)
  if (acct) {
    const owner = personForAccount(root, p, acct)
    if (owner && owner.uid !== uid) throw new Error(`这个账号已经属于 ${owner.uid}`)
    if (!(person.accounts ?? []).includes(acct)) {
      person.accounts = [...new Set([...(person.accounts ?? []), acct])]
      if (!person.primary) person.primary = acct
      savePersons(root, loadPersons(root, p), p)
      return { acct, uid, created: false, changed: true }
    }
    return { acct, uid, created: false, changed: false }
  }
  const r = ensureAccount(root, p, { platform, nativeId: id, nickname: person.label || '' })
  const data = loadPersons(root, p)
  const rec = data.persons[uid]
  rec.accounts = [...new Set([...(rec.accounts ?? []), r.acct])]
  if (!rec.primary) rec.primary = r.acct
  savePersons(root, data, p)
  return { acct: r.acct, uid, created: true, changed: true, state, confidence, evidence }
}

// ── 候选（身份主张待确认）─────────────────────────────────────────────

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
  const r = linkIdentity(root, target, { platform: item.platform, id: item.id })
  items.splice(Number(index), 1)
  saveCandidates(root, null, items)
  return { uid: target, acct: r.acct, identity: { platform: item.platform, id: item.id } }
}

export function rejectCandidate(root, index) {
  const items = listCandidates(root)
  if (!items[Number(index)]) throw new Error('候选不存在')
  const [removed] = items.splice(Number(index), 1)
  saveCandidates(root, null, items)
  return { rejected: removed }
}

// ── 合并 / 拆分（旧名门面）───────────────────────────────────────────

export function mergePeople(root, fromUid, intoUid, { sketch = '', reason = '合并人物', actor = 'human:editor', evidence = null } = {}) {
  const p = requirePid(root)
  const from = loadPersons(root, p).persons[fromUid]
  const into = loadPersons(root, p).persons[intoUid]
  if (!from || !into) throw new Error('人物不存在')
  const body = String(sketch ?? '').trim() || String(readPersonProfile(root, p, intoUid)?.sketch ?? '').trim() || '合并人物'
  const r = mergeAccounts(root, p, {
    accounts: [...(into.accounts ?? []), ...(from.accounts ?? [])],
    intoPerson: intoUid,
    sketch: body,
    reason,
    evidence,
    actor,
  })
  return { uid: r.person, absorbed: fromUid }
}

export function splitIdentity(root, uid, platform, id, { actor = 'human:editor' } = {}) {
  const p = requirePid(root)
  const acct = accountForNative(root, p, platform, id)
  if (!acct) throw new Error(`这个账号不存在：${platform}:${id}`)
  const owner = personForAccount(root, p, acct)
  if (!owner || owner.uid !== uid) throw new Error(`这个账号不属于 ${uid}`)
  const r = splitPerson(root, p, { person: uid, accounts: [acct], actor })
  return { uid: r.to, moved: acct }
}

// ── 主观档案 ───────────────────────────────────────────────────────────

export function personProfileRel(pid, uid) {
  return profileRel(pid, uid)
}

export function readProfile(root, pid, uid) {
  return readPersonProfile(root, pid, uid)
}

/** 人物档案（无 display；只写素描/置顶/权重/初识）。 */
export function writeProfile(root, pid, uid, patch = {}, { actor = 'system:entity' } = {}) {
  const p = requirePid(root, pid)
  const persons = loadPersons(root, p).persons
  if (!persons[uid]) throw new Error(`人物不存在：${uid}`)
  if (patch && Object.prototype.hasOwnProperty.call(patch, 'display')) {
    throw new Error('人物卡不再有 display：称呼用账户昵称，改昵称请编辑账户')
  }
  const { __reason, ...rest } = patch
  return writePersonProfile(root, p, uid, rest, {
    actor,
    reason: __reason ? String(__reason) : '更新人物档案',
  })
}

export function ensurePersonProfile(root, pid, uid, { firstMet = null, reason = '第一次跟她说话，建路人卡' } = {}) {
  const p = requirePid(root, pid)
  return ensureProfile(root, p, uid, { firstMet, reason })
}

/** 旧名门面：她没有“改名”这回事了；把新名字作为主账户的昵称补进去。 */
export function renamePersonAuto(root, pid, uid, display, { reason = '账户昵称', actor = 'model:person' } = {}) {
  const p = requirePid(root, pid)
  const person = loadPersons(root, p).persons[uid]
  if (!person) throw new Error(`没有这个人物：${uid}`)
  const name = String(display ?? '').trim()
  if (!name) throw new Error('昵称不能为空')
  const acct = person.primary ?? (person.accounts ?? [])[0]
  if (!acct) throw new Error('这个人物还没有账户，改不了昵称')
  const card = loadAccount(root, p, acct)
  const next = [...new Set([...(card.nicknames ?? []), name])]
  setAccountNicknames(root, p, acct, next)
  // 给她改了称呼 = 认识了：影子转正
  const data = loadPersons(root, p)
  if (data.persons[uid]?.tier === 'shadow') {
    delete data.persons[uid].tier
    savePersons(root, data, p)
  }
  return { uid, acct, nicknames: next, reason, actor }
}

export function noteFriendship(root, uid, platform, nativeId, { remark = '', friend = true } = {}) {
  const p = requirePid(root)
  const acct = accountForNative(root, p, platform, nativeId)
  if (!acct) return false
  const owner = personForAccount(root, p, acct)
  if (owner && owner.uid !== uid) return false
  const card = loadAccount(root, p, acct)
  if (!card) return false
  const desc = friend ? card.description : card.description
  let changed = false
  if (Boolean(card.friend) !== Boolean(friend)) {
    card.friend = Boolean(friend)
    changed = true
  }
  if (remark) {
    const lines = String(card.description ?? '').split('\n')
    const idx = lines.findIndex((l) => l.startsWith('好友备注：'))
    if (idx >= 0) lines[idx] = `好友备注：${remark}`
    else lines.push(`好友备注：${remark}`)
    card.description = lines.join('\n')
    changed = true
  }
  if (changed) {
    card.updated_at = localIso()
    writeAccountCard(root, p, acct, card)
  }
  return changed
}

export function friendshipOf(person) {
  if (!person) return false
  if (Array.isArray(person.accounts)) return person.accounts.some((a) => Boolean(a.friend))
  return Boolean(person.friend)
}

export function ensureFirstMet(root, pid, uid, now = localIso()) {
  const cur = readProfile(root, pid, uid)
  if (cur?.first_met) return { first: false, profile: cur }
  const profile = writeProfile(root, pid, uid, { first_met: now }, { actor: 'system:entity' })
  return { first: true, profile: { ...profile, first_met: now } }
}

// ── 置顶 / 管理员 ──────────────────────────────────────────────────────

export function setPinned(root, pid, uid, pinned = true) {
  const cur = readProfile(root, pid, uid)
  if (!cur && !loadPersons(root, pid).persons?.[uid]) throw new Error(`没有这个人物：${uid}`)
  if (!cur) ensurePersonProfile(root, pid, uid, { reason: '人替她设为重点' })
  const base = readProfile(root, pid, uid)
  const rank = pinned ? (base.pin_rank || nextPinRank(root, pid)) : 0
  const next = writeProfile(root, pid, uid, { pinned: Boolean(pinned), pin_rank: rank }, { actor: 'human:editor' })
  renumberPinned(root, pid)
  return next
}

function nextPinRank(root, pid) {
  const max = pinnedPeople(root, pid).reduce((n, uid) => Math.max(n, Number(readProfile(root, pid, uid)?.pin_rank ?? 0)), 0)
  return max + 1
}

export function pinnedPeople(root, pid) {
  const p = requirePid(root, pid)
  const out = []
  for (const uid of Object.keys(loadPersons(root, p).persons)) {
    const prof = readProfile(root, p, uid)
    if (prof?.pinned) out.push(uid)
  }
  return out.sort(
    (a, b) => Number(readProfile(root, p, a)?.pin_rank ?? 0) - Number(readProfile(root, p, b)?.pin_rank ?? 0),
  )
}

export function renumberPinned(root, pid, uids = null) {
  const p = requirePid(root, pid)
  const list = uids ?? pinnedPeople(root, p)
  list.forEach((uid, i) => {
    const cur = readProfile(root, p, uid)
    if (!cur) return
    if (Number(cur.pin_rank ?? 0) !== i) writeProfile(root, p, uid, { pin_rank: i }, { actor: 'system:entity' })
  })
}

export function movePinned(root, pid, uid, direction) {
  const list = pinnedPeople(root, pid)
  const idx = list.findIndex((x) => x === uid)
  if (idx < 0) throw new Error('不在重要人物里')
  const to = idx + (direction === 'up' ? -1 : 1)
  if (to < 0 || to >= list.length) return list
  const uids = [...list]
  ;[uids[idx], uids[to]] = [uids[to], uids[idx]]
  renumberPinned(root, pid, uids)
  return uids
}

export function setAdmin(root, uid = null) {
  const p = requirePid(root)
  const data = loadPersons(root, p)
  const current = Object.values(data.persons).find((rec) => rec.tier === 'admin')
  if (uid && current && current.uid !== uid) {
    throw new Error(`已经有一个管理员（${current.uid}），换人前先卸任`)
  }
  if (!uid) {
    for (const rec of Object.values(data.persons)) if (rec.tier === 'admin') rec.tier = null
    savePersons(root, data, p)
    return null
  }
  if (!data.persons[uid]) throw new Error(`人物不存在：${uid}`)
  data.persons[uid].tier = 'admin'
  savePersons(root, data, p)
  return uid
}

export function currentAdmin(root) {
  const p = requirePid(root)
  for (const rec of Object.values(loadPersons(root, p).persons)) {
    if (rec.tier === 'admin') return { ...rec, display: labelOfPerson(root, p, rec.uid) }
  }
  return null
}

// ── UI 列表 ─────────────────────────────────────────────────────────────

export function listPeopleForUi(root, pid, { includeShadow = false } = {}) {
  const p = requirePid(root, pid)
  const rows = []
  for (const rec of Object.values(loadPersons(root, p).persons)) {
    if (!includeShadow && rec.tier === 'shadow') continue
    const profile = readProfile(root, p, rec.uid)
    if (!profile && !(rec.accounts ?? []).length && !includeShadow) continue
    const cards = accountsForPerson(root, p, rec.uid)
    const names = nicknamesOfPerson(root, p, rec.uid)
    const weight = personWeight(root, p, rec.uid)
    rows.push({
      uid: rec.uid,
      display: names.join(' / ') || rec.label || rec.uid,
      nicknames: names,
      accounts: cards.map((a) => ({
        uid: a.uid,
        platform: a.platform,
        nativeId: String(a.nativeId),
        nicknames: a.nicknames ?? [],
        description: a.description ?? '',
        friend: Boolean(a.friend),
        weight: Number(a.weight ?? 0),
      })),
      identities: cards.map((a) => ({ platform: a.platform, id: String(a.nativeId), friend: Boolean(a.friend) })),
      accountTexts: cards.map((a) => a.description).filter(Boolean),
      sketch: profile?.sketch ?? '',
      weight,
      admin: rec.tier === 'admin',
      tier: rec.tier ?? null,
      pinned: Boolean(profile?.pinned),
      pin_rank: Number(profile?.pin_rank ?? 0),
      firstMet: profile?.first_met ?? null,
      lastMet: profile?.first_met ?? null,
      friend: cards.some((a) => a.friend),
      hasProfile: Boolean(profile),
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

/** private:<acct> / private:<person> / private:<平台号> → 人物 uid（找不到 null）。 */
export function personForChannel(root, channel, pid = null) {
  const p = requirePid(root, pid)
  const s = String(channel ?? '')
  if (!s.startsWith('private:')) return null
  const id = s.slice('private:'.length)
  if (isAccountUid(id)) {
    const person = personForAccount(root, p, id)
    return person?.uid ?? null
  }
  if (isPersonUid(id)) return loadPersons(root, p).persons[id] ? id : null
  const acct = accountForNative(root, p, 'qq', id) ?? accountForNative(root, p, 'wechat', id) ?? accountForNative(root, p, 'dsh', id)
  const person = acct ? personForAccount(root, p, acct) : null
  return person?.uid ?? null
}
