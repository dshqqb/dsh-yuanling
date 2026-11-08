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

// 账号平台清单：解析器认得的与绑定层接受的**必须是同一张表**，
// 否则会出现"描述写对了、绑定报不认识"这种漂移（p15 就是这么挂的）。
export const PLATFORMS = ['qq', 'bili', 'weibo', 'wechat', 'xhs', 'tg', 'github', 'pet', 'dsh']

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

/** 候选：只提，不自动合并。uid 允许为 null（还没确定属于谁）。 */
export function addCandidate(root, { uid = null, platform, id, reason = '', evidence = [] }) {
  const data = loadIdentities(root)
  if (uid && !data.people[uid]) throw new Error(`人物不存在：${uid}`)
  if (findByIdentity(root, platform, id)) return { added: false, reason: 'already-linked' }
  if (data.pending.some((c) => c.platform === platform && String(c.id) === String(id))) {
    return { added: false, reason: 'already-pending' }
  }
  data.pending.push({ uid: uid ?? null, platform: String(platform), id: String(id), reason, evidence, at: localIso() })
  saveIdentities(root, data)
  return { added: true }
}

export function listCandidates(root) {
  return loadIdentities(root).pending.slice()
}

/**
 * 确认候选。候选可能还没归属（uid=null），这时必须显式给一个 uid。
 */
export function confirmCandidate(root, index, { uid = null } = {}) {
  const data = loadIdentities(root)
  const c = data.pending[index]
  if (!c) throw new Error(`候选不存在：#${index}`)
  const target = uid ?? c.uid
  if (!target) throw new Error(`候选 #${index} 还没确定属于谁，请传 uid`)
  if (!data.people[target]) throw new Error(`人物不存在：${target}`)
  data.pending.splice(index, 1)
  saveIdentities(root, data)
  return linkIdentity(root, target, { platform: c.platform, id: c.id, state: 'confirmed', confidence: 1 })
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

// ── 自然语言身份描述 ────────────────────────────────────────────────────
//
// 为什么要用一段话而不是一排输入框：以后加 telegram / 小红书 / github，
// 只要改下面的别名表，历史记录能重跑，用户不用重填。
//
// 纪律：**原文是正本，解析结果是派生。** 解析错了不丢原文；解析器升级后 reparse 一遍即可。

export const PLATFORM_ALIASES = [
  { platform: 'qq', re: /(?:qq|QQ|企鹅号)/i, value: /[0-9]{4,12}/ },
  { platform: 'bili', re: /(?:b\s*站|B站|bilibili|哔哩哔哩)/i, value: /@?[A-Za-z0-9_\-\u4e00-\u9fa5]{2,}/ },
  { platform: 'weibo', re: /(?:微博|weibo)/i, value: /@?[A-Za-z0-9_\-\u4e00-\u9fa5]{2,}/ },
  { platform: 'wechat', re: /(?:微信|wechat)/i, value: /@?[A-Za-z0-9_\-\u4e00-\u9fa5]{2,}/ },
  { platform: 'xhs', re: /(?:小红书|xhs)/i, value: /@?[A-Za-z0-9_\-\u4e00-\u9fa5]{2,}/ },
  { platform: 'tg', re: /(?:telegram|tg)/i, value: /@?[A-Za-z0-9_]{3,}/ },
  { platform: 'github', re: /(?:github)/i, value: /@?[A-Za-z0-9_-]{2,}/ },
]

/** 去掉"号是 / 账号叫 / uid:" 这类连接词，只留值。 */
function stripLead(rest) {
  return rest.replace(
    /^(?:\s*(?:账号|帐号|号码|号|uid|id|昵称|名字|名称|是|为|叫|有|在)\s*(?:是|为|叫|：|:|=)?\s*)+/i,
    '',
  )
}

/**
 * 从一段话里解析出账号。
 * @returns {{items:Array<{platform,id}>, unparsed:string[], segments:number}}
 */
export function parseIdentityText(text) {
  const s = String(text ?? '')
  const items = []
  const unparsed = []
  const segs = s
    .split(/[\n，,；;、|]+/)
    .map((x) => x.trim())
    .filter(Boolean)

  for (const seg of segs) {
    let matchedPlatform = null
    for (const a of PLATFORM_ALIASES) {
      const m = a.re.exec(seg)
      if (!m) continue
      matchedPlatform = a.platform
      const rest = stripLead(seg.slice(m.index + m[0].length))
      // "我的 b 站还没注册" 这类话不该解析出一个叫「还没注册」的账号
      if (/^(还没|没有|没|无|未|不)/.test(rest)) break
      const v = a.value.exec(rest)
      if (v && v[0]) {
        const id = v[0].replace(/^@/, '')
        if (!items.some((x) => x.platform === a.platform && x.id === id)) items.push({ platform: a.platform, id })
        matchedPlatform = null // 认出来了
        break
      }
      break // 提到平台但没认出值
    }
    if (matchedPlatform) unparsed.push(seg)
  }

  return { items, unparsed, segments: segs.length }
}

/**
 * 写入身份描述：存原文 → 解析 → 把**还没有归属**的账号自动绑上。
 * 已经被别人占用的账号不抢，记进 conflicts 交给人。
 */
export function setIdentityText(root, uid, text, { autoLink = true } = {}) {
  const data = loadIdentities(root)
  const person = data.people[uid]
  if (!person) throw new Error(`人物不存在：${uid}`)

  const parsed = parseIdentityText(text)
  person.identity_text = String(text ?? '')
  person.identity_parsed = parsed.items
  person.identity_unparsed = parsed.unparsed
  person.identity_parsed_at = localIso()
  saveIdentities(root, data)

  const linked = []
  const conflicts = []
  if (autoLink) {
    for (const item of parsed.items) {
      const cur = findByIdentity(root, item.platform, item.id)
      if (cur && cur.uid === uid) continue
      if (cur) {
        conflicts.push({ ...item, owner: cur.uid })
        continue
      }
      linkIdentity(root, uid, {
        platform: item.platform,
        id: item.id,
        state: 'inferred',
        confidence: 0.8,
        evidence: ['identity_text'],
      })
      linked.push(item)
    }
  }

  const fresh = loadIdentities(root)
  return { person: fresh.people[uid], parsed, linked, conflicts }
}

/** 重新解析所有人物（解析器升级后跑一次）。 */
export function reparseIdentityTexts(root, { autoLink = false } = {}) {
  const data = loadIdentities(root)
  const out = []
  for (const person of Object.values(data.people)) {
    if (!person.identity_text) continue
    const parsed = parseIdentityText(person.identity_text)
    person.identity_parsed = parsed.items
    person.identity_unparsed = parsed.unparsed
    person.identity_parsed_at = localIso()
    out.push({ uid: person.uid, items: parsed.items.length, unparsed: parsed.unparsed.length })
  }
  saveIdentities(root, data)
  if (autoLink) {
    for (const row of out) {
      setIdentityText(root, row.uid, loadIdentities(root).people[row.uid].identity_text, { autoLink })
    }
  }
  return out
}

/**
 * 重要人物：这是"她多在意他"的判断，所以存在人格档案里（pinned 布尔）。
 * 不做人数上限——重要人物是你的判断，不是系统配额。
 */
export function setPinned(root, pid, uid, pinned = true) {
  if (!readProfile(root, pid, uid)) throw new Error('这个人还没有档案，先让她认识他')
  return writeProfile(root, pid, uid, {
    pinned: Boolean(pinned),
    __reason: pinned ? '标为重要人物' : '取消重要人物',
  })
}

/**
 * 管理员：这是"谁是主人"的客观事实，全库唯一，存在 identities 里。
 * 换人必须先卸任——不允许悄悄顶掉。
 */
export function setAdmin(root, uid = null) {
  const data = loadIdentities(root)
  if (uid) {
    if (!data.people[uid]) throw new Error(`人物不存在：${uid}`)
    const current = Object.values(data.people).find((p) => p.tier === 'admin' && p.uid !== uid)
    if (current) throw new Error(`${current.display} 还是管理员，先卸任再任命`)
    data.people[uid].tier = 'admin'
  } else {
    for (const p of Object.values(data.people)) {
      if (p.tier === 'admin') delete p.tier
    }
  }
  saveIdentities(root, data)
  return { adminUid: uid }
}

/** 读取当前管理员（没有就 null）。 */
export function currentAdmin(root) {
  const data = loadIdentities(root)
  const hit = Object.values(data.people).find((p) => p.tier === 'admin')
  return hit ? { uid: hit.uid, display: hit.display } : null
}

/**
 * 人物页列表：管理员 → 重要人物 → 其余（按权重或按时间）。
 */
export function listPeopleForUi(root, pid, { sort = 'weight' } = {}) {
  const data = loadIdentities(root)
  const rows = Object.values(data.people).map((person) => {
    const profile = readProfile(root, pid, person.uid)
    return {
      uid: person.uid,
      display: profile?.display || person.display || person.uid,
      admin: person.tier === 'admin',
      pinned: Boolean(profile?.pinned),
      weight: Number(profile?.weight ?? 0),
      weightSource: profile?.weight_source ?? 'auto',
      sketch: profile?.sketch ?? '',
      firstMet: profile?.first_met ?? null,
      lastMet: profile?.last_met ?? null,
      hasProfile: Boolean(profile),
      identities: person.identities ?? [],
    }
  })

  const timeOf = (r) => String(r.lastMet ?? r.firstMet ?? '')
  rows.sort(
    (a, b) =>
      Number(b.admin) - Number(a.admin) ||
      Number(b.pinned) - Number(a.pinned) ||
      (sort === 'time' ? timeOf(b).localeCompare(timeOf(a)) : b.weight - a.weight) ||
      timeOf(b).localeCompare(timeOf(a)),
  )
  return rows
}

// 群体（群档案）不在这里：它有自己的一套规则（平台:标识、不跨平台合并、权重、
// 成员归集），见 groups.js。这里只留人物与频道解析。

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
