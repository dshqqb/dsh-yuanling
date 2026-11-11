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
import { autoUniqueName } from './names.js'
import { effectivePersonWeight } from './weights.js'

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
/** 名字的规范形：全角半角统一、空白压成一个、大小写不敏感。 */
function nameKey(s) {
  return String(s ?? '')
    .normalize('NFKC')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase()
}

/**
 * 人物名字只有一个主人（影子卡不算：那只是"见过"，还不是"认识"）。
 *
 * 人物是**全库**的实体（换人格还是同一个人），所以名字在整个人物表里唯一。
 * @returns {object|null} 占用这个名字的人物
 */
export function personNameOwner(root, name, { exceptUid = null } = {}) {
  const key = nameKey(name)
  if (!key) return null
  for (const p of Object.values(loadIdentities(root).people ?? {})) {
    if (p.uid === exceptUid) continue
    if (p.tier === 'shadow') continue
    if (nameKey(p.display) === key) return p
  }
  return null
}

/** 名字被占了就抛错，并把"换个什么"说清楚——不静默改名，也不静默建重名。 */
export function assertPersonNameFree(root, name, opts = {}) {
  const hit = personNameOwner(root, name, opts)
  if (!hit) return
  const n = String(name ?? '').trim()
  throw new Error(`人物名字「${n}」已经有人用了（${hit.uid}）。换一个：可以按他的特点加个区分，例如「${n}（B站）」`)
}

/**
 * 自动建人物（她自己在办事时用）：撞名就自动加标识，**不抛错**。
 *
 * 与 createPerson 的区别是"谁来办这件事"：人建卡撞名要失败（让人自己改），
 * 她自动建卡撞名要能继续（否则一条消息就能把入库流程卡死）。
 *
 * @param {{display?:string, platform?:string|null, nativeId?:string|number|null, uid?:string, aliases?:string[]}} opts
 */
export function createPersonAuto(root, { display = '', platform = null, nativeId = '', uid = newUid(), aliases = [] } = {}) {
  const name = uniquePersonName(root, display, { platform, nativeId })
  return createPerson(root, { uid, display: name, aliases })
}

/** 自动取名：名字唯一是硬要求，昵称不必。 */
export function uniquePersonName(root, display, { platform = null, nativeId = '' } = {}) {
  return autoUniqueName(display, {
    platform,
    nativeId,
    taken: (name) => Boolean(personNameOwner(root, name)),
  })
}

export function createPerson(root, { uid = newUid(), display = '', aliases = [] } = {}) {
  const data = loadIdentities(root)
  if (data.people[uid]) throw new Error(`人物已存在：${uid}`)
  assertPersonNameFree(root, display || uid)
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
export function writeProfile(root, pid, uid, patch = {}, { actor = 'system:entity' } = {}) {
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
  // 改名要查重：重名会让人物页和注入都分不清谁是谁。
  // 只查"真的变了"的情况（把名字原样写回来不算改）。
  const renaming = rest.display !== undefined && nameKey(rest.display) !== nameKey(cur.display)
  if (renaming) {
    assertPersonNameFree(root, rest.display, { exceptUid: uid })
    // 名字只有一份：人物档案里的显示名就是 identities 里的显示名。
    // 不两处各存一份，否则查重和页面会各说各话。
    const data = loadIdentities(root)
    if (data.people?.[uid]) {
      data.people[uid].display = String(rest.display).trim()
      writeJsonAtomic(identitiesPath(root), data)
    }
  }
  // 新建档案时把显示名带上——否则注入时只能显示 uid，人会看不出这是谁
  const seedDisplay = fresh && !rest.display ? loadIdentities(root).people[uid]?.display ?? '' : undefined
  const next = { ...cur, ...(seedDisplay ? { display: seedDisplay } : {}), ...rest, uid, updated_at: localIso() }
  writeTracked(root, rel, JSON.stringify(next, null, 2) + '\n', {
    actor,
    reason: __reason ?? '更新人物档案',
  })
  // 有人给她写档案 = 从"见过"变成"认识"：影子卡转正。
  // 反过来（转正后再写档案）什么也不用做，promoteShadow 自己会判断。
  if (personIsShadow(root, uid)) promoteShadowLocal(root, uid)
  return next
}

/** 局部实现，避免 entities ↔ channels 的循环 import。 */
function personIsShadow(root, uid) {
  return loadIdentities(root).people?.[uid]?.tier === 'shadow'
}

function promoteShadowLocal(root, uid) {
  const data = loadIdentities(root)
  const person = data.people?.[uid]
  if (!person || person.tier !== 'shadow') return false
  delete person.tier
  saveIdentities(root, data)
  return true
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

  // 第二遍：补"省略平台名"的后续号。
  // "QQ 号是 12345，还有个号 54321" —— 后半句没写平台，但它跟着前半句走。
  // 只在前一段刚刚认出了平台、且这段里没有别的平台名时才补，避免张冠李戴。
  let lastPlatform = null
  for (let i = 0; i < segs.length; i += 1) {
    const seg = segs[i]
    const hit = items.find((x) => seg.includes(x.id) && maybeMentionsPlatform(seg))
    if (hit) {
      lastPlatform = hit.platform
      continue
    }
    if (!lastPlatform) continue
    if (PLATFORM_ALIASES.some((a) => a.re.test(seg))) continue // 这段有自己的平台名，别抢
    if (!/号|账号|小号|另一个|还有/.test(seg)) continue
    const m = /(?:^|[^\d])(\d{4,12})(?:[^\d]|$)/.exec(seg)
    if (!m) continue
    const id = m[1]
    if (!items.some((x) => x.platform === lastPlatform && x.id === id)) {
      items.push({ platform: lastPlatform, id })
      const idx = unparsed.indexOf(seg)
      if (idx >= 0) unparsed.splice(idx, 1)
    }
  }

  return { items, unparsed, segments: segs.length }
}

/** 这一段里有没有出现平台名（用来判断"平台线索是否还延续"）。 */
function maybeMentionsPlatform(seg) {
  return PLATFORM_ALIASES.some((a) => a.re.test(seg))
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
 * 重点人物（pinned）：名单内的**顺序**就是权重（越靠前越高，见 weights.js）。
 *
 * 所以置顶要同时分配一个名次，取消置顶要把后面的人往前挪——否则名次会留空洞，
 * 权重就会跳级（例如 120 → 110 → 100 之间突然空一档）。
 */
export function setPinned(root, pid, uid, pinned = true) {
  // 还没有档案 = 她"还没认识"这个人。但人点「设为重点」就是在替她做判断：
  // 那就顺势建一份最小档案（writeProfile 会建），而不是甩一句"先让她认识他"。
  const list = pinnedPeople(root, pid)
  const already = list.includes(uid)

  if (pinned && !already) {
    return writeProfile(root, pid, uid, { pinned: true, pin_rank: list.length }, { __reason: '设为重点人物' })
  }
  if (!pinned && already) {
    const next = list.filter((x) => x !== uid)
    const prof = writeProfile(root, pid, uid, { pinned: false, pin_rank: null }, { __reason: '取消重点人物' })
    renumberPinned(root, pid, next)
    return prof
  }
  return readProfile(root, pid, uid)
}

/** 重点人物名单（按名次），返回 uid 数组。 */
export function pinnedPeople(root, pid) {
  const data = loadIdentities(root)
  return Object.values(data.people)
    .map((person) => ({ uid: person.uid, prof: readProfile(root, pid, person.uid) }))
    .filter((x) => x.prof?.pinned)
    .sort((a, b) => Number(a.prof.pin_rank ?? 999) - Number(b.prof.pin_rank ?? 999))
    .map((x) => x.uid)
}

/** 把名单里的名次重排成 0..n-1（去掉空洞）。 */
export function renumberPinned(root, pid, uids) {
  uids.forEach((uid, i) => {
    const prof = readProfile(root, pid, uid)
    if (Number(prof?.pin_rank) === i) return
    writeProfile(root, pid, uid, { pin_rank: i }, { __reason: '重点人物重新排序' })
  })
}

/**
 * 在重点名单里往上/下挪一格。
 * @param {'up'|'down'} direction
 */
export function movePinned(root, pid, uid, direction) {
  const list = pinnedPeople(root, pid)
  const i = list.indexOf(uid)
  if (i < 0) throw new Error('不在重点名单里')
  const j = direction === 'up' ? i - 1 : i + 1
  if (j < 0 || j >= list.length) return { moved: false, rank: i }
  const next = [...list]
  ;[next[i], next[j]] = [next[j], next[i]]
  renumberPinned(root, pid, next)
  return { moved: true, rank: j }
}

/**
 * 新建人物：建卡 + 认领账户 + 写素描，一步到位（管理台的「新增」按钮用）。
 *
 * 账户必填：一个既没有名字来源、也没有账号的人，等于一个纯字符串，建了也没用。
 */
export function createPersonWithCard(root, pid, { display, identityText, sketch = '', actor = 'human:editor' } = {}) {
  const name = String(display ?? '').trim()
  if (!name) throw new Error('名字不能为空')
  const text = String(identityText ?? '').trim()
  if (!text) throw new Error('账户不能为空：用自然语言写清他/她在哪个平台叫什么')
  if (!parseIdentityText(text).items.length) {
    throw new Error(`账户里没认出任何账号：${text}。写成"QQ 号是 12345"或"b站叫老张"这样`)
  }
  const person = createPerson(root, { display: name })
  const r = setIdentityText(root, person.uid, text, { autoLink: true })
  if (!r.linked.length) {
    const why = r.conflicts.length
      ? `这些账号已经属于别人了：${r.conflicts.map((c) => `${c.platform}:${c.id}`).join('、')}`
      : '账户里没认出可以绑定的号'
    throw new Error(why)
  }
  if (String(sketch).trim()) {
    writeProfile(root, pid, person.uid, { sketch: String(sketch).trim(), weight: NEW_PERSON_WEIGHT }, { actor })
  } else {
    // 建卡 = 认识；哪怕没写素描也要有一份档案，否则她"认识"这件事不落地
    writeProfile(root, pid, person.uid, { weight: NEW_PERSON_WEIGHT }, { actor })
  }
  return { person: r.person, linked: r.linked, conflicts: r.conflicts }
}

/**
 * 新建人物的默认权重（普通名单的中值）。
 * 和 `weights.SEED_WEIGHT` 是同一个数；这里另写一份是为了避免
 * entities ↔ weights 的循环 import（weights 依赖 entities 读写档案）。
 */
const NEW_PERSON_WEIGHT = 50

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
 * 人物页列表：管理员 → 重点人物（按名次）→ 其余（按权重）。
 *
 * 权重口径见 weights.js：普通名单是互动分（0–100），重点名单按名次给分（110 起）。
 * 列表里的 `weight` 是**生效值**；`storedWeight` 是落盘值（取消重点后会给生效值用）。
 */
export function listPeopleForUi(root, pid, { includeShadow = false } = {}) {
  const data = loadIdentities(root)
  const totalPinned = Object.values(data.people).filter((person) => readProfile(root, pid, person.uid)?.pinned).length

  const rows = Object.values(data.people)
    // 影子卡（只见过、没认识过）默认不显示：人物页是"她认识谁"，不是"谁发过言"。
    // 没写过档案的影子也一定没有 sketch/pinned/weight，藏起来不丢信息。
    .filter((person) => includeShadow || person.tier !== 'shadow')
    .map((person) => {
      const profile = readProfile(root, pid, person.uid)
      const eff = effectivePersonWeight(profile, { totalPinned })
      return {
        uid: person.uid,
        display: profile?.display || person.display || person.uid,
        admin: person.tier === 'admin',
        pinned: Boolean(profile?.pinned),
        rank: eff.rank,
        weight: eff.weight,
        storedWeight: eff.stored,
        weightKind: eff.kind,
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
      (a.pinned ? Number(a.rank ?? 0) - Number(b.rank ?? 0) : b.weight - a.weight) ||
      timeOf(b).localeCompare(timeOf(a)),
  )
  return rows
}

// 群体（群档案）不在这里：它有自己的一套规则（平台:标识、不跨平台合并、权重、
// 成员归集），见 groups.js。这里只留人物与频道解析。

// ── 频道解析 ────────────────────────────────────────────────────────────

/** `private:person_x` / `group:qq:123` / `bili:video:BV1` / `dsh:xxx` */
export function parseChannel(channel) {
  const s = String(channel ?? '')
  const i = s.indexOf(':')
  if (i < 0) return { kind: 'unknown', id: s }
  return { kind: s.slice(0, i), id: s.slice(i + 1) }
}

/**
 * 私聊频道 → 人物 uid（认不出来就 null）。
 *
 * 新形状直接就是 `private:<person_uid>`；老形状 `private:10001` 按账号反查一次
 * （唯一命中才算，见 channels.js 的 resolveChannel）。
 */
export function personForChannel(root, channel) {
  const { kind, id } = parseChannel(channel)
  if (kind !== 'private') return null
  if (/^person_/.test(id)) return existsInIdentities(root, id) ? id : null
  const hit = findByIdentity(root, 'qq', id)
  return hit ? hit.uid : null
}

function existsInIdentities(root, uid) {
  return Boolean(loadIdentities(root).people?.[uid])
}
