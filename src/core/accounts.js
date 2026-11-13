// src/core/accounts.js —— 账户卡 / 人物卡 两级实体。
//
// 用户 2026-11-13 定的模型：
//   · **账户卡** acct_xxx：平台 + 原生号，一个号一张卡。昵称（可多个）、描述、好友、
//     统计与**基础权重**都在这里。raw 的私聊场景挂在账户上（private:acct_xxx）。
//   · **人物卡** person_xxx：只是“这些账户是同一个人”的归组。没有 display；
//     称呼由账户昵称合并而来；素描、管理员/重要人物/黑白名单在人物层；
//     人物权重 = 各账户权重之和（封顶 100），合并/拆分**不改账户权重**。
//   · 合并必须显式给一句 sketch；拆分时原 sketch 跟主账户走，新人物拿一份带标注的副本。
//
// 存储（都按人格隔离）：
//   personas/<p>/entities/accounts.json          账户注册表（uid / platform / nativeId / byNative）
//   personas/<p>/entities/accounts/<acct>.json   账户卡
//   personas/<p>/entities/persons.json           人物注册表（accounts / primary / tier / merges / splits）
//   personas/<p>/entities/people/<person>.json   人物素描与置顶（versioned）
import fs from 'node:fs'
import path from 'node:path'

import { exists, localIso, readJson, ulid, writeJsonAtomic } from './fsx.js'
import { P } from './paths.js'
import { requirePid } from './scope.js'
import { writeTracked } from './version.js'

export const PLATFORMS = ['qq', 'bili', 'weibo', 'wechat', 'xhs', 'tieba', 'tg', 'github', 'pet', 'dsh']

/** 账户权重公式（与旧人物权重同一口径，只是按账户统）。 */
export function weightFromStats(stats = {}) {
  const messages = Number(stats.messages ?? 0)
  const activeDays = Number(stats.activeDays ?? 0)
  const last30 = Number(stats.last30 ?? 0)
  return Math.max(0, Math.min(100, Math.round(messages * 0.5 + activeDays * 1.0 + last30 * 0.3)))
}

function entityBase(root, pid) {
  return path.join(root, P.personas, requirePid(root, pid), 'entities')
}

export function accountsRel(pid) {
  return `${P.personas}/${pid}/entities/accounts.json`
}
export function personsRel(pid) {
  return `${P.personas}/${pid}/entities/persons.json`
}
export function accountCardRel(pid, acct) {
  return `${P.personas}/${pid}/entities/accounts/${String(acct).replace(/[\\/:*?"<>|]/g, '_')}.json`
}
export function personProfileRel(pid, uid) {
  return `${P.personas}/${pid}/entities/people/${String(uid).replace(/[\\/:*?"<>|]/g, '_')}.json`
}

const nativeKey = (platform, id) => `${String(platform || 'unknown')}:${String(id ?? '')}`

export function newAcctUid() {
  return 'acct_' + ulid()
}
export function newPersonUid() {
  return 'person_' + ulid()
}
export const isAccountUid = (s) => /^acct_/.test(String(s ?? ''))
export const isPersonUid = (s) => /^person_/.test(String(s ?? ''))

// ── 注册表 ─────────────────────────────────────────────────────────────

export function loadAccountRegistry(root, pid = null) {
  const j = readJson(path.join(entityBase(root, pid), 'accounts.json'), null)
  if (!j || typeof j !== 'object') return { version: 1, accounts: {}, byNative: {} }
  return {
    version: 1,
    accounts: j.accounts && typeof j.accounts === 'object' ? j.accounts : {},
    byNative: j.byNative && typeof j.byNative === 'object' ? j.byNative : {},
  }
}

export function saveAccountRegistry(root, data, pid = null) {
  writeJsonAtomic(path.join(entityBase(root, pid), 'accounts.json'), data)
  return data
}

export function loadPersons(root, pid = null) {
  const j = readJson(path.join(entityBase(root, pid), 'persons.json'), null)
  if (!j || typeof j !== 'object') return { version: 1, persons: {} }
  return { version: 1, persons: j.persons && typeof j.persons === 'object' ? j.persons : {} }
}

export function savePersons(root, data, pid = null) {
  writeJsonAtomic(path.join(entityBase(root, pid), 'persons.json'), data)
  return data
}

// ── 账户卡 ─────────────────────────────────────────────────────────────

export function readAccountCard(root, pid, acct) {
  return readJson(path.join(root, accountCardRel(requirePid(root, pid), acct)), null)
}

export function writeAccountCard(root, pid, acct, card) {
  ensureDirFor(path.join(root, accountCardRel(requirePid(root, pid), acct)))
  writeJsonAtomic(path.join(root, accountCardRel(requirePid(root, pid), acct)), card)
  return card
}

function ensureDirFor(file) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true })
  } catch {
    /* ignore */
  }
}

/** 账户注册表里的一条 → 卡（卡丢了也能从注册表恢复基本信息）。 */
function cardFromRegistry(rec) {
  return {
    uid: rec.uid,
    nicknames: [],
    description: '',
    friend: false,
    stats: { messages: 0, activeDays: 0, last30: 0, dayCounts: {}, updatedAt: null },
    weight: 0,
    created: rec.created,
    updated_at: rec.created,
  }
}

export function loadAccount(root, pid, acct) {
  const uid = String(acct ?? '')
  const reg = loadAccountRegistry(root, pid)
  const rec = reg.accounts[uid]
  if (!rec) return null
  const card = readAccountCard(root, pid, uid) ?? cardFromRegistry(rec)
  return { ...rec, ...card, uid: rec.uid, platform: rec.platform, nativeId: rec.nativeId }
}

/** 所有账户卡（按注册表顺序）。 */
export function listAccounts(root, pid) {
  const reg = loadAccountRegistry(root, pid)
  return Object.keys(reg.accounts)
    .map((uid) => loadAccount(root, pid, uid))
    .filter(Boolean)
}

export function accountForNative(root, pid, platform, id) {
  const reg = loadAccountRegistry(root, pid)
  return reg.byNative[nativeKey(platform, id)] ?? null
}

/**
 * 保证一个 (平台, 原生号) 有账户卡；没有就新建。
 * 只建账户，不建人物——调用方决定要不要挂到人物上。
 */
export function ensureAccount(root, pid, { platform, nativeId, nickname = '', nicknames = null, created = null } = {}) {
  const p = String(platform || 'unknown')
  const id = String(nativeId ?? '').trim()
  if (!id) throw new Error('缺少账户原生号')
  const reg = loadAccountRegistry(root, pid)
  const hit = reg.byNative[nativeKey(p, id)]
  if (hit && reg.accounts[hit]) {
    const card = loadAccount(root, pid, hit)
    // 补昵称（第一次拿到时写进去）
    const want = [...(Array.isArray(nicknames) ? nicknames : nickname ? [nickname] : [])]
      .map((x) => String(x ?? '').trim())
      .filter(Boolean)
    if (want.length) {
      const cur = new Set(card.nicknames ?? [])
      let changed = false
      for (const n of want) if (!cur.has(n)) { cur.add(n); changed = true }
      if (changed) {
        card.nicknames = [...cur]
        card.updated_at = localIso()
        writeAccountCard(root, pid, card.uid, card)
      }
    }
    return { acct: card.uid, created: false, card: loadAccount(root, pid, card.uid) }
  }
  const acct = newAcctUid()
  const now = created || localIso()
  reg.accounts[acct] = { uid: acct, platform: p, nativeId: id, created: now, firstSeen: now, lastSeen: now }
  reg.byNative[nativeKey(p, id)] = acct
  saveAccountRegistry(root, reg, pid)
  const card = {
    uid: acct,
    nicknames: [...new Set((Array.isArray(nicknames) ? nicknames : nickname ? [nickname] : []).map((x) => String(x ?? '').trim()).filter(Boolean))],
    description: '',
    friend: false,
    stats: { messages: 0, activeDays: 0, last30: 0, dayCounts: {}, updatedAt: null },
    weight: 0,
    created: now,
    updated_at: now,
  }
  writeAccountCard(root, pid, acct, card)
  return { acct, created: true, card }
}

/** 追加/替换昵称（昵称允许多个，跨账户允许重名）。 */
export function setAccountNicknames(root, pid, acct, nicknames) {
  const card = loadAccount(root, pid, acct)
  if (!card) throw new Error(`账户不存在：${acct}`)
  const next = [...new Set((Array.isArray(nicknames) ? nicknames : String(nicknames ?? '').split(/\s+/)).map((x) => String(x ?? '').trim()).filter(Boolean))]
  card.nicknames = next
  card.updated_at = localIso()
  writeAccountCard(root, pid, acct, card)
  return card
}

/** 写账户描述（短印象；好友备注也放这里，由适配器维护）。 */
export function setAccountDescription(root, pid, acct, description, { actor = 'human:editor' } = {}) {
  const card = loadAccount(root, pid, acct)
  if (!card) throw new Error(`账户不存在：${acct}`)
  card.description = String(description ?? '').trim()
  card.updated_at = localIso()
  writeAccountCard(root, pid, acct, card)
  return card
}

/** 好友备注写进描述：只维护一行 `好友备注：...`，不重复。 */
export function noteAccountFriend(root, pid, acct, { friend = null, remark = '' } = {}) {
  const card = loadAccount(root, pid, acct)
  if (!card) return false
  const rem = String(remark ?? '').trim()
  let desc = String(card.description ?? '')
  const had = desc.split('\n').some((line) => line.startsWith('好友备注：'))
  if (rem && !had) {
    desc = `${desc ? desc + '\n' : ''}好友备注：${rem}`
  } else if (rem && had) {
    desc = desc
      .split('\n')
      .map((line) => (line.startsWith('好友备注：') ? `好友备注：${rem}` : line))
      .join('\n')
  }
  const nextFriend = friend === null ? Boolean(card.friend) : Boolean(friend)
  if (desc === card.description && nextFriend === Boolean(card.friend)) return false
  card.description = desc
  card.friend = nextFriend
  card.updated_at = localIso()
  writeAccountCard(root, pid, acct, card)
  return true
}

/** 一条私聊消息 → 账户统计与权重（每次聊天更新；合并/拆分不碰它）。 */
export function noteAccountMessage(root, pid, acct, { now = Date.now(), ts = null } = {}) {
  const card = loadAccount(root, pid, acct)
  if (!card) return null
  const at = ts ? new Date(ts) : new Date(now)
  if (Number.isNaN(at.getTime())) return card
  const day = `${at.getFullYear()}-${String(at.getMonth() + 1).padStart(2, '0')}-${String(at.getDate()).padStart(2, '0')}`
  const stats = card.stats ?? { messages: 0, activeDays: 0, last30: 0, dayCounts: {}, updatedAt: null }
  const dayCounts = { ...(stats.dayCounts ?? {}) }
  dayCounts[day] = Number(dayCounts[day] ?? 0) + 1
  // 只留最近 60 天
  const cutoff = new Date(at.getTime() - 60 * 86_400_000)
  for (const key of Object.keys(dayCounts)) {
    const d = new Date(`${key}T00:00:00`)
    if (Number.isNaN(d.getTime()) || d < cutoff) delete dayCounts[key]
  }
  const last30 = Object.entries(dayCounts).reduce(
    (n, [key, v]) => (new Date(`${key}T00:00:00`) >= new Date(at.getTime() - 30 * 86_400_000) ? n + Number(v) : n),
    0,
  )
  const next = {
    messages: Number(stats.messages ?? 0) + 1,
    activeDays: Object.keys(dayCounts).length,
    last30,
    dayCounts,
    updatedAt: localIso(at),
  }
  card.stats = next
  card.weight = weightFromStats(next)
  card.updated_at = localIso(at)
  writeAccountCard(root, pid, acct, card)
  // 同步注册表里的 lastSeen
  const reg = loadAccountRegistry(root, pid)
  if (reg.accounts[acct]) {
    reg.accounts[acct].lastSeen = localIso(at)
    saveAccountRegistry(root, reg, pid)
  }
  return card
}

/** 从 raw 重算后写回账户统计/权重（值没变就不写）。 */
export function setAccountWeightFromStats(root, pid, acct, stats, weight) {
  const card = loadAccount(root, pid, acct)
  if (!card) return null
  const sameStats = JSON.stringify(card.stats ?? {}) === JSON.stringify(stats ?? {})
  if (sameStats && Number(card.weight ?? 0) === Number(weight ?? 0)) return card
  card.stats = stats
  card.weight = Number(weight ?? 0)
  card.updated_at = localIso()
  writeAccountCard(root, pid, acct, card)
  return card
}

export function setAccountFriend(root, pid, acct, friend) {
  const card = loadAccount(root, pid, acct)
  if (!card) throw new Error(`账户不存在：${acct}`)
  card.friend = Boolean(friend)
  card.updated_at = localIso()
  writeAccountCard(root, pid, acct, card)
  return card
}

export function accountsForPerson(root, pid, personUid) {  const persons = loadPersons(root, pid)
  const rec = persons.persons[String(personUid ?? '')]
  if (!rec) return []
  return (rec.accounts ?? []).map((acct) => loadAccount(root, pid, acct)).filter(Boolean)
}

export function personForAccount(root, pid, acct) {
  const persons = loadPersons(root, pid)
  for (const rec of Object.values(persons.persons)) {
    if ((rec.accounts ?? []).includes(String(acct))) return rec
  }
  return null
}

/** 账户昵称合并（人物层的“显示名”）。 */
export function nicknamesOfPerson(root, pid, personUid) {
  const list = []
  for (const card of accountsForPerson(root, pid, personUid)) {
    for (const n of card.nicknames ?? []) if (!list.includes(n)) list.push(n)
  }
  return list
}

export function labelOfPerson(root, pid, personUid) {
  const names = nicknamesOfPerson(root, pid, personUid)
  if (names.length) return names.join(' / ')
  const rec = loadPersons(root, pid).persons[String(personUid ?? '')]
  if (!rec) return String(personUid)
  const primary = rec.primary ? loadAccount(root, pid, rec.primary) : null
  return primary ? `${primary.platform}:${primary.nativeId}` : String(personUid)
}

/** 人物权重：账户权重求和、封顶 100（重点人物的名次分在 weights/UI 层覆盖）。 */
export function personWeight(root, pid, personUid) {
  const sum = accountsForPerson(root, pid, personUid).reduce((n, card) => n + Number(card.weight ?? 0), 0)
  return Math.min(100, Math.round(sum))
}

// ── 人物 ───────────────────────────────────────────────────────────────

/** 建一个空人物（只给迁移/测试/无账户的旧数据用；正常入口是 createAccountWithPerson）。 */
export function createPersonRecord(root, pid, { uid = newPersonUid(), label = '', tier = null, created = null } = {}) {
  const data = loadPersons(root, pid)
  const now = created || localIso()
  data.persons[uid] = {
    uid,
    accounts: [],
    primary: null,
    tier,
    label: String(label ?? ''),
    created: now,
    merges: [],
    splits: [],
  }
  savePersons(root, data, pid)
  return data.persons[uid]
}

/** 把一个账户挂到人物上；没有人物就建一个（1:1），返回人物 uid。 */
export function ensurePersonForAccount(root, pid, acct, { nickname = '', created = null } = {}) {
  const existing = personForAccount(root, pid, acct)
  if (existing) return existing.uid
  const data = loadPersons(root, pid)
  const uid = newPersonUid()
  data.persons[uid] = {
    uid,
    accounts: [String(acct)],
    primary: String(acct),
    tier: null,
    label: '',
    created: created || localIso(),
    merges: [],
    splits: [],
  }
  savePersons(root, data, pid)
  return uid
}

/** 新建账户 + 对应人物（“新建账户卡即新建人物卡”）。 */
export function createAccountWithPerson(root, pid, { platform, nativeId, nickname = '', nicknames = null, description = '', friend = false } = {}) {
  const r = ensureAccount(root, pid, { platform, nativeId, nickname, nicknames })
  if (r.created) {
    const person = ensurePersonForAccount(root, pid, r.acct)
    if (description) setAccountDescription(root, pid, r.acct, description)
    if (friend) noteAccountFriend(root, pid, r.acct, { friend: true })
    return { acct: r.acct, person, created: true }
  }
  const person = ensurePersonForAccount(root, pid, r.acct)
  return { acct: r.acct, person, created: false }
}

// ── 人物素描 / 置顶 ─────────────────────────────────────────────────────

export function readPersonProfile(root, pid, uid) {
  return readJson(path.join(root, personProfileRel(requirePid(root, pid), uid)), null)
}

export function writePersonProfile(root, pid, uid, patch = {}, { actor = 'system:entity', reason = '更新人物档案' } = {}) {
  const rel = personProfileRel(requirePid(root, pid), uid)
  const cur = readPersonProfile(root, pid, uid) ?? {
    uid,
    sketch: '',
    pinned: false,
    pin_rank: 0,
    weight: 0,
    first_met: null,
    created: localIso(),
  }
  const next = { ...cur, ...patch, uid, updated_at: localIso() }
  writeTracked(root, rel, JSON.stringify(next, null, 2) + '\n', { actor, reason })
  return next
}

export function ensurePersonProfile(root, pid, uid, { firstMet = null, reason = '第一次跟她说话，建路人卡' } = {}) {
  const cur = readPersonProfile(root, pid, uid)
  if (cur) return { created: false, profile: cur }
  const profile = writePersonProfile(
    root,
    pid,
    uid,
    { first_met: firstMet || localIso(), weight: personWeight(root, pid, uid) },
    { actor: 'system:ingest', reason },
  )
  // 建档即转正：路人卡不再是影子
  const data = loadPersons(root, pid)
  if (data.persons[uid]?.tier === 'shadow') {
    delete data.persons[uid].tier
    savePersons(root, data, pid)
  }
  return { created: true, profile }
}

export function promotePerson(root, pid, uid) {
  const data = loadPersons(root, pid)
  const rec = data.persons[uid]
  if (!rec || rec.tier !== 'shadow') return false
  delete rec.tier
  savePersons(root, data, pid)
  return true
}

// ── 合并 / 拆分 ────────────────────────────────────────────────────────

/**
 * 合并账户到一个人物。`sketch` 必填（显式写一句）。
 * 账户自身权重/描述/昵称一律不动；只改人物归属与人物权重/素描。
 *
 * @param {object} opts
 * @param {string[]} opts.accounts
 * @param {string} [opts.intoPerson]
 * @param {string} opts.sketch
 * @param {string} opts.reason
 * @param {object|null} [opts.evidence]
 * @param {string} [opts.actor]
 */
export function mergeAccounts(root, pid, { accounts = [], intoPerson = '', sketch = '', reason = '', evidence = null, actor = 'human:editor' } = {}) {
  const wanted = [...new Set((accounts ?? []).map(String).filter(Boolean))]
  if (wanted.length < 1) throw new Error('至少要给一个账户')
  const body = String(sketch ?? '').trim()
  if (!body) throw new Error('合并人物必须显式写一句描述（sketch）')
  const cards = wanted.map((acct) => loadAccount(root, pid, acct))
  if (cards.some((c) => !c)) throw new Error('有账户不存在')

  const data = loadPersons(root, pid)
  const currentPersons = new Set()
  for (const acct of wanted) {
    for (const rec of Object.values(data.persons)) if ((rec.accounts ?? []).includes(acct)) currentPersons.add(rec.uid)
  }
  const targetUid = intoPerson && data.persons[intoPerson] ? intoPerson : [...currentPersons][0] ?? newPersonUid()
  if (!data.persons[targetUid]) {
    data.persons[targetUid] = { uid: targetUid, accounts: [], primary: null, tier: null, label: '', created: localIso(), merges: [], splits: [] }
  }
  const target = data.persons[targetUid]

  // 从所有旧人物里摘掉这些账户
  const fromUids = []
  for (const [uid, rec] of Object.entries(data.persons)) {
    if (uid === targetUid) continue
    const keep = (rec.accounts ?? []).filter((a) => !wanted.includes(a))
    if (keep.length !== (rec.accounts ?? []).length) {
      fromUids.push(uid)
      rec.accounts = keep
      if (!keep.length) {
        // 旧人物空壳：保留档案做审计，从注册表移除
        const old = readPersonProfile(root, pid, uid)
        if (old) {
          const dir = path.join(entityBase(root, pid), 'people', '.merged')
          ensureDirFor(path.join(dir, 'x.json'))
          writeJsonAtomic(path.join(dir, `${uid}.json`), { ...old, merged_into: targetUid, merged_at: localIso() })
        }
        delete data.persons[uid]
      } else if (rec.primary && !keep.includes(rec.primary)) {
        rec.primary = keep[0]
      }
    }
  }

  const before = new Set(target.accounts ?? [])
  for (const acct of wanted) before.add(acct)
  target.accounts = [...before]
  if (!target.primary || !target.accounts.includes(target.primary)) {
    const sorted = [...target.accounts].sort((a, b) => Number(loadAccount(root, pid, b)?.weight ?? 0) - Number(loadAccount(root, pid, a)?.weight ?? 0))
    target.primary = sorted[0] ?? wanted[0]
  }
  target.tier = target.tier ?? null
  target.merges.push({
    at: localIso(),
    accounts: wanted,
    from: fromUids,
    sketch: body,
    reason: String(reason ?? ''),
    evidence: evidence ?? null,
    actor,
  })
  savePersons(root, data, pid)

  const profile = readPersonProfile(root, pid, targetUid) ?? { uid: targetUid, first_met: localIso(), created: localIso(), pinned: false, pin_rank: 0 }
  writePersonProfile(
    root,
    pid,
    targetUid,
    { sketch: body, weight: personWeight(root, pid, targetUid) },
    { actor: `entity:${actor}`, reason: `合并账户：${reason || '合并人物'}` },
  )
  return { person: targetUid, accounts: target.accounts, from: fromUids, profile: readPersonProfile(root, pid, targetUid) }
}

/**
 * 从人物拆出若干账户。原素描跟主账户走；新人物拿一份带标注的副本。
 */
export function splitPerson(root, pid, { person, accounts = [], primary = '', actor = 'human:editor' } = {}) {
  const uid = String(person ?? '')
  const moved = [...new Set((accounts ?? []).map(String).filter(Boolean))]
  const data = loadPersons(root, pid)
  const rec = data.persons[uid]
  if (!rec) throw new Error(`人物不存在：${uid}`)
  if (!moved.length) throw new Error('要拆的账户不能为空')
  if (moved.some((a) => !(rec.accounts ?? []).includes(a))) throw new Error('有账户不属于这个人物')
  if (moved.length >= (rec.accounts ?? []).length) throw new Error('不能把全部账户都拆走（那不是拆分）')

  const keep = rec.accounts.filter((a) => !moved.includes(a))
  const nextUid = newPersonUid()
  const oldProfile = readPersonProfile(root, pid, uid)
  const oldSketch = String(oldProfile?.sketch ?? '')
  rec.accounts = keep
  if (!keep.includes(rec.primary)) rec.primary = keep[0]
  rec.splits.push({ at: localIso(), moved, to: nextUid, primary: primary || moved[0], actor })
  data.persons[nextUid] = {
    uid: nextUid,
    accounts: moved,
    primary: primary && moved.includes(primary) ? primary : moved[0],
    tier: null,
    label: '',
    created: localIso(),
    merges: [{ at: localIso(), accounts: moved, from: [uid], sketch: oldSketch, reason: '拆分的副本', actor }],
    splits: [],
  }
  savePersons(root, data, pid)

  writePersonProfile(
    root,
    pid,
    nextUid,
    {
      sketch: oldSketch ? `${oldSketch}\n（拆分前与 ${labelOfPerson(root, pid, uid)} 的共同描述，${localIso().slice(0, 10)}）` : '',
      weight: personWeight(root, pid, nextUid),
    },
    { actor: `entity:${actor}`, reason: '拆分人物：复制共同描述' },
  )
  writePersonProfile(root, pid, uid, { weight: personWeight(root, pid, uid) }, { actor: `entity:${actor}`, reason: '拆分人物：重算权重' })
  return { from: uid, to: nextUid, accounts: moved, profile: readPersonProfile(root, pid, nextUid) }
}

// ── 账户描述里的账号解析（兼容旧调用方/迁移）──────────────────────────

/** 从一段话里解析出账号（旧 API 保留；新模型里账户是显式的，不再用它建卡）。 */
export const PLATFORM_ALIASES = [
  { platform: 'qq', re: /(?:qq|QQ|企鹅号)/i, value: /[0-9]{4,12}/ },
  { platform: 'bili', re: /(?:b\s*站|B站|bilibili|哔哩哔哩)/i, value: /@?[A-Za-z0-9_\-\u4e00-\u9fa5]{2,}/ },
  { platform: 'weibo', re: /(?:微博|weibo)/i, value: /@?[A-Za-z0-9_\-\u4e00-\u9fa5]{2,}/ },
  { platform: 'wechat', re: /(?:微信|wechat)/i, value: /@?[A-Za-z0-9_\-\u4e00-\u9fa5]{2,}/ },
  { platform: 'tieba', re: /(?:贴吧|tieba)/i, value: /@?[A-Za-z0-9_\-\u4e00-\u9fa5]{2,}/ },
  { platform: 'xhs', re: /(?:小红书|xhs)/i, value: /@?[A-Za-z0-9_\-\u4e00-\u9fa5]{2,}/ },
  { platform: 'tg', re: /(?:telegram|tg)/i, value: /@?[A-Za-z0-9_]{3,}/ },
  { platform: 'github', re: /(?:github)/i, value: /@?[A-Za-z0-9_-]{2,}/ },
]

function stripLead(rest) {
  return rest.replace(
    /^(?:\s*(?:账号|帐号|号码|号|uid|id|昵称|名字|名称|是|为|叫|有|在)\s*(?:是|为|叫|：|:|=)?\s*)+/i,
    '',
  )
}

export function parseIdentityText(text) {
  const s = String(text ?? '')
  const items = []
  const unparsed = []
  const segs = s.split(/[\n，,；;、|]+/).map((x) => x.trim()).filter(Boolean)
  for (const seg of segs) {
    let matchedPlatform = null
    for (const a of PLATFORM_ALIASES) {
      const m = a.re.exec(seg)
      if (!m) continue
      matchedPlatform = a.platform
      const rest = stripLead(seg.slice(m.index + m[0].length))
      if (/^(还没|没有|没|无|未|不)/.test(rest)) break
      const v = a.value.exec(rest)
      if (v && v[0]) {
        const id = v[0].replace(/^@/, '')
        if (!items.some((x) => x.platform === a.platform && x.id === id)) items.push({ platform: a.platform, id })
        matchedPlatform = null
        break
      }
      break
    }
    if (matchedPlatform) unparsed.push(seg)
  }
  return { items, unparsed, segments: segs.length }
}
