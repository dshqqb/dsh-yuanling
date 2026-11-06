// src/core/entities.js —— 人物与群：客观身份映射 + 主观认识。
//
// 分工（文档 §9.1）：
//   system/identities.json        账号 → person_uid 的**客观**映射（跨人格共用）
//   personas/<p>/entities/...     这个角色**认识**的 TA（按人格隔离）
//
// 合并/拆分只改映射，各人格的记忆文件零改动——这就是把两者分开的收益。
import fs from 'node:fs'
import path from 'node:path'
import { exists, isDir, readJson, writeJsonAtomic, localIso, ulid } from './fsx.js'
import { P } from './paths.js'
import { writeTracked } from './version.js'

export const PLATFORMS = ['qq', 'bili', 'pet', 'dsh']

export function identitiesPath(root) {
  return path.join(root, P.identities)
}

export function loadIdentities(root) {
  const j = readJson(identitiesPath(root), null)
  if (!j || typeof j !== 'object') return { version: 1, people: {}, pending: [], merges: [] }
  return {
    version: j.version ?? 1,
    people: j.people && typeof j.people === 'object' ? j.people : {},
    pending: Array.isArray(j.pending) ? j.pending : [],
    merges: Array.isArray(j.merges) ? j.merges : [],
  }
}

export function saveIdentities(root, data) {
  writeJsonAtomic(identitiesPath(root), data)
  return data
}

export function newUid() {
  return 'person_' + ulid()
}

/** 按 (platform, id) 找人。返回 {uid, identity} 或 null。 */
export function findByIdentity(root, platform, id) {
  const data = loadIdentities(root)
  const p = String(platform)
  const i = String(id)
  for (const [uid, person] of Object.entries(data.people)) {
    const hit = (person.identities ?? []).find((x) => x.platform === p && String(x.id) === i)
    if (hit) return { uid, identity: hit, person }
  }
  return null
}

/** 建一个人物（不建主观档案；那是每个人格自己的事）。 */
export function createPerson(root, { uid = newUid(), display = '', aliases = [] } = {}) {
  const data = loadIdentities(root)
  if (data.people[uid]) throw new Error(`人物已存在：${uid}`)
  data.people[uid] = { uid, display: display || uid, aliases: [...new Set(aliases)], identities: [], created: localIso() }
  saveIdentities(root, data)
  return data.people[uid]
}

/**
 * 绑定一个账号到人物。
 * 同一个号不能同时绑两个人——先拆再绑。
 */
export function linkIdentity(root, uid, { platform, id, state = 'confirmed', confidence = 1, evidence = [] } = {}) {
  if (!PLATFORMS.includes(String(platform))) throw new Error(`不认识的平台：${platform}`)
  if (!id) throw new Error('缺少账号 id')

  const data = loadIdentities(root)
  const person = data.people[uid]
  if (!person) throw new Error(`人物不存在：${uid}`)

  const existing = findByIdentity(root, platform, id)
  if (existing && existing.uid !== uid) {
    throw new Error(`这个账号已经属于 ${existing.uid}；要改归属请先 split 或 merge`)
  }
  if (existing && existing.uid === uid) return { changed: false, person }

  person.identities = person.identities ?? []
  person.identities.push({
    platform: String(platform),
    id: String(id),
    state,
    confidence,
    evidence: Array.isArray(evidence) ? evidence : [],
    linked_at: localIso(),
  })
  saveIdentities(root, data)
  return { changed: true, person }
}

/** 候选：只提，不自动合并。 */
export function addCandidate(root, { uid, platform, id, reason = '', evidence = [] }) {
  const data = loadIdentities(root)
  if (!data.people[uid]) throw new Error(`人物不存在：${uid}`)
  if (findByIdentity(root, platform, id)) return { added: false, reason: 'already-linked' }
  if (data.pending.some((c) => c.platform === platform && String(c.id) === String(id))) {
    return { added: false, reason: 'already-pending' }
  }
  data.pending.push({ uid, platform: String(platform), id: String(id), reason, evidence, at: localIso() })
  saveIdentities(root, data)
  return { added: true }
}

export function listCandidates(root) {
  return loadIdentities(root).pending.slice()
}

export function confirmCandidate(root, index) {
  const data = loadIdentities(root)
  const c = data.pending[index]
  if (!c) throw new Error(`候选不存在：#${index}`)
  data.pending.splice(index, 1)
  saveIdentities(root, data)
  return linkIdentity(root, c.uid, { platform: c.platform, id: c.id, state: 'confirmed', confidence: 1 })
}

export function rejectCandidate(root, index) {
  const data = loadIdentities(root)
  if (!data.pending[index]) throw new Error(`候选不存在：#${index}`)
  const [c] = data.pending.splice(index, 1)
  saveIdentities(root, data)
  return c
}

/** 合并：把 from 的所有账号并进 into，并记一笔（可逆：看 merges 就知道从哪来）。 */
export function mergePeople(root, fromUid, intoUid) {
  if (fromUid === intoUid) throw new Error('不能把一个人并进自己')
  const data = loadIdentities(root)
  const from = data.people[fromUid]
  const into = data.people[intoUid]
  if (!from) throw new Error(`人物不存在：${fromUid}`)
  if (!into) throw new Error(`人物不存在：${intoUid}`)

  into.identities = into.identities ?? []
  for (const identity of from.identities ?? []) {
    if (!into.identities.some((x) => x.platform === identity.platform && String(x.id) === String(identity.id))) {
      into.identities.push(identity)
    }
  }
  into.aliases = [...new Set([...(into.aliases ?? []), from.display, ...(from.aliases ?? [])])].filter(Boolean)

  data.merges.push({
    at: localIso(),
    from: { uid: fromUid, display: from.display, identities: from.identities ?? [] },
    into: intoUid,
  })
  delete data.people[fromUid]
  saveIdentities(root, data)
  return { uid: intoUid, absorbed: fromUid }
}

/** 拆分：把一个账号从 uid 上解下来，落到一个新 uid。 */
export function splitIdentity(root, uid, platform, id) {
  const data = loadIdentities(root)
  const person = data.people[uid]
  if (!person) throw new Error(`人物不存在：${uid}`)
  const idx = (person.identities ?? []).findIndex((x) => x.platform === String(platform) && String(x.id) === String(id))
  if (idx < 0) throw new Error(`这个账号不属于 ${uid}`)

  const [identity] = person.identities.splice(idx, 1)
  const nextUid = newUid()
  data.people[nextUid] = {
    uid: nextUid,
    display: `${person.display}'`,
    aliases: [],
    identities: [{ ...identity, state: 'confirmed' }],
    created: localIso(),
  }
  saveIdentities(root, data)
  return { uid: nextUid, moved: identity }
}

// ── 主观档案（按人格隔离）──────────────────────────────────────────────

export function personProfileRel(pid, uid) {
  return `${P.personas}/${pid}/entities/people/${String(uid).replace(/[\\/:*?"<>|]/g, '_')}.json`
}

export function readProfile(root, pid, uid) {
  return readJson(path.join(root, personProfileRel(pid, uid)), null)
}

/** 改档案（走版本，可回滚）。 */
export function writeProfile(root, pid, uid, patch = {}) {
  const rel = personProfileRel(pid, uid)
  const fresh = !exists(path.join(root, rel))
  const cur = readJson(path.join(root, rel), null) ?? {
    uid,
    display: '',
    sketch: '',
    focus: [],
    first_met: null,
    facts: [],
    created: localIso(),
  }
  const { __reason, ...rest } = patch
  // 新建档案时把显示名带上——否则注入时只能显示 uid，人会看不出这是谁
  const seedDisplay = fresh && !rest.display ? loadIdentities(root).people[uid]?.display ?? '' : undefined
  const next = { ...cur, ...(seedDisplay ? { display: seedDisplay } : {}), ...rest, uid, updated_at: localIso() }
  writeTracked(root, rel, JSON.stringify(next, null, 2) + '\n', {
    actor: 'system:entity',
    reason: __reason ?? '更新人物档案',
  })
  return next
}

/** 第一次和这个人打交道：只写一次。 */
export function ensureFirstMet(root, pid, uid, now = localIso()) {
  const cur = readProfile(root, pid, uid)
  if (cur?.first_met) return { first: false, profile: cur }
  const data = loadIdentities(root)
  const person = data.people[uid]
  const profile = writeProfile(root, pid, uid, {
    display: person?.display ?? uid,
    first_met: now,
    __reason: '记录第一次打交道',
  })
  profile.first_met = now
  return { first: true, profile }
}

// ── 群 ──────────────────────────────────────────────────────────────────

export function groupRel(pid, gid) {
  return `${P.personas}/${pid}/entities/groups/${String(gid).replace(/[\\/:*?"<>|]/g, '_')}.json`
}

export function readGroup(root, pid, gid) {
  return readJson(path.join(root, groupRel(pid, gid)), null)
}

export function writeGroup(root, pid, gid, patch = {}) {
  const rel = groupRel(pid, gid)
  const cur = readJson(path.join(root, rel), null) ?? {
    gid: String(gid),
    name: '',
    intro: '',
    tone: '',
    topics: [],
    created: localIso(),
  }
  const { __reason, ...rest } = patch
  const next = { ...cur, ...rest, gid: String(gid), updated_at: localIso() }
  writeTracked(root, rel, JSON.stringify(next, null, 2) + '\n', {
    actor: 'system:entity',
    reason: __reason ?? '更新群档案',
  })
  return next
}

// ── 频道解析 ────────────────────────────────────────────────────────────

/** `private:10001` / `group:123` / `bili:video:BV1` / `dsh:xxx` */
export function parseChannel(channel) {
  const s = String(channel ?? '')
  const i = s.indexOf(':')
  if (i < 0) return { kind: 'unknown', id: s }
  return { kind: s.slice(0, i), id: s.slice(i + 1) }
}

/** 私聊频道 → 人物 uid（认不出来就 null）。 */
export function personForChannel(root, channel) {
  const { kind, id } = parseChannel(channel)
  if (kind !== 'private') return null
  const hit = findByIdentity(root, 'qq', id)
  return hit ? hit.uid : null
}
