// src/core/channels.js —— 频道编号的**唯一真相**。
//
// 为什么不把频道写成外部账号：
//   `private:10001` 只说了"某个平台的 10001"，没说哪个平台。模块是可以扩展的
//   （以后可能接微信、贴吧、Discord），两个不同 App 上的 10001 是两个人。
//   把外部 id 写进频道，等于让"新增一个平台"变成"改掉全部历史数据的语义"。
//
// 所以频道的编号一律指向**内部编号**：
//   private:<person_uid>   私聊——对方是谁，从人物卡里记的账号映射出来
//   group:<gid>            群聊——gid 形如 `qq:123456` / `tieba:某吧` / `wechat:xxx@chatroom`
//   其余（bili:video:BV1 / dsh:xxx / module:xxx）不是人也不是地方，原样保留
//
// 外部号码不进频道，但**必须留痕**：raw 记录里同时写 `channel_native`（适配器原话），
// 否则"这个频道真实的群号是多少"就再也查不回来了。
//
// 老数据不可改写（raw 只追加），所以读取侧要认得老形状：`private:10001`、
// `group:123555`。认不出的标 unresolved，**不猜**。
import path from 'node:path'
import { loadIdentities, findByIdentity, newUid, PLATFORMS, identitiesPath } from './entities.js'
import { writeJsonAtomic, readJson, localIso } from './fsx.js'
import { P } from './paths.js'
import { CHANNEL_PLATFORM, GROUP_KINDS } from './platforms.js'

/** 频道种类 → 平台（`group`/`private` 默认 qq：历史上只有 QQ 用过这两个）。 */
function platformOfKind(kind) {
  return CHANNEL_PLATFORM[kind] ?? kind
}

/** 从 source 推平台：`qq` / `qq-p1` / `dsh-yuanling-qq` 都算 qq。 */
export function platformFromSource(source) {
  const s = String(source ?? '').trim().toLowerCase()
  if (!s) return null
  const bare = s.replace(/^dsh-yuanling-/, '').replace(/^dsh-/, '')
  // 平台既可能是"账号平台"（qq/wechat/bili…），也可能是"频道种类"（tieba/tg…），
  // 两张表合起来认，否则 `source: tieba` 会推不出平台。
  const known = new Set([...PLATFORMS, ...Object.values(CHANNEL_PLATFORM)])
  if (known.has(bare)) return bare
  const head = bare.split(/[-_/]/)[0]
  return known.has(head) ? head : null
}

export function parseChannel(channel) {
  const s = String(channel ?? '')
  const i = s.indexOf(':')
  if (i < 0) return { kind: 'unknown', id: s }
  return { kind: s.slice(0, i), id: s.slice(i + 1) }
}

export function isPersonUid(id) {
  return /^person_/.test(String(id ?? ''))
}

/** 任意平台上按账号 id 找人（老频道没写平台，只能这样反查）。唯一命中才算数。 */
function findAnyIdentity(root, id) {
  const data = loadIdentities(root)
  const i = String(id)
  const hits = []
  for (const [uid, person] of Object.entries(data.people ?? {})) {
    for (const identity of person.identities ?? []) {
      if (String(identity.id) === i) hits.push({ uid, identity })
    }
  }
  return hits.length === 1 ? hits[0] : null
}

/**
 * 把一个频道解析成**结构化语义**。
 *
 * `legacy:true` 表示这是老形状（外部 id 直接写在频道里），`resolved:false`
 * 表示连反查都没命中——这种频道不该被当成有效频道。
 */
export function resolveChannel(root, channel) {
  const raw = String(channel ?? '')
  const { kind, id } = parseChannel(raw)

  if (kind === 'private') {
    if (isPersonUid(id)) {
      return { raw, kind, id, canonical: raw, personUid: id, gid: null, nativeId: null, resolved: true, legacy: false }
    }
    const hit = findAnyIdentity(root, id)
    if (hit) {
      return {
        raw,
        kind,
        id,
        canonical: `private:${hit.uid}`,
        personUid: hit.uid,
        gid: null,
        nativeId: `${hit.identity.platform}:${hit.identity.id}`,
        resolved: true,
        legacy: true,
      }
    }
    return { raw, kind, id, canonical: raw, personUid: null, gid: null, nativeId: null, resolved: false, legacy: true }
  }

  if (GROUP_KINDS.has(kind)) {
    // 新形状：`group:<grp_xxx>` —— 编号是内部的，属于任何 App 都能用
    if (/^grp_/.test(id)) {
      return { raw, kind, id, canonical: raw, personUid: null, gid: id, nativeId: null, resolved: true, legacy: false }
    }
    // 老形状：`group:123555` 或 `group:qq:123555` —— 按 (平台, 号) 去登记表查
    const platform = id.includes(':') ? id.split(':')[0] : platformOfKind(kind)
    const nativeId = id.includes(':') ? id.split(':').slice(1).join(':') : id
    const gid = findGidByNative(root, platform, nativeId)
    if (gid) {
      return {
        raw,
        kind,
        id,
        canonical: `group:${gid}`,
        personUid: null,
        gid,
        nativeId: `${platform}:${nativeId}`,
        resolved: true,
        legacy: true,
      }
    }
    return { raw, kind, id, canonical: raw, personUid: null, gid: null, nativeId: null, resolved: false, legacy: true }
  }

  // 不是人也不是地方：bili:video:BV1 / dsh:xxx / module:xxx —— 原样
  return { raw, kind, id, canonical: raw, personUid: null, gid: null, nativeId: null, resolved: true, legacy: false }
}

/**
 * 入库时把**外部**频道换成规范频道，并保证私聊一定有对应人物。
 *
 * 私聊来源还没人物卡时建一张**影子卡**（tier=shadow）：记着"这个人我见过，但还不认识"。
 * 影子卡不进注入、默认不在人物页显示；等有人写素描、被认领、或当管理员才算认识。
 */
export function canonicalChannelForIngest(root, { channel, source, actorName = '' }) {
  const raw = String(channel || 'unknown')
  const { kind, id } = parseChannel(raw)

  if (kind === 'private') {
    // 已经是内部编号（适配器自己归好人了）→ 直接用
    if (isPersonUid(id)) {
      return { channel: raw, native: null, personUid: id, gid: null }
    }
    const platform = platformOfKind(kind) ?? platformFromSource(source)
    const uid = ensureSenderPerson(root, { platform, nativeId: id, display: actorName || id })
    return { channel: `private:${uid}`, native: raw, personUid: uid, gid: null }
  }

  if (GROUP_KINDS.has(kind)) {
    const platform = platformOfKind(kind) ?? platformFromSource(source)
    const nativeId = id.includes(':') ? id.split(':').slice(1).join(':') : id
    const gid = ensureGroupScene(root, { platform, nativeId })
    return { channel: `group:${gid}`, native: raw, personUid: null, gid }
  }

  return { channel: raw, native: null, personUid: null, gid: null }
}

/**
 * 保证某个外部账号有一个人物卡（没有就建影子卡）。返回 person uid。
 *
 * **只按 (平台, 号) 精确匹配**，绝不跨平台复用：两个 App 上的 10001 默认是两个人。
 * 想认定"这两个号是同一个人"，只能走身份主张 / 人工合并——那是需要证据的判断，
 * 不能由"号码碰巧一样"自动做掉。这条正是"频道不能用外部 id"的同一个理由。
 */
export function ensureSenderPerson(root, { platform, nativeId, display = '' }) {
  if (!nativeId) throw new Error('缺少账号 id，没法归人')
  const p = platform || 'unknown'
  const hit = findByIdentity(root, p, nativeId)
  if (hit) return hit.uid

  const data = loadIdentities(root)
  const uid = newUid()
  data.people[uid] = {
    uid,
    display: display || nativeId,
    aliases: [],
    identities: [
      { platform: p, id: String(nativeId), state: 'observed', confidence: 1, evidence: [], linked_at: localIso() },
    ],
    created: localIso(),
    // 影子：见过，但还不认识。不进注入、人物页默认不显示。
    tier: 'shadow',
  }
  writeJsonAtomic(identitiesPath(root), data)
  return uid
}

/** 影子卡转正：有人写过素描 / 认过领 / 当了管理员，就不再是"路人"。 */
export function promoteShadow(root, uid) {
  const data = loadIdentities(root)
  const person = data.people?.[uid]
  if (!person || person.tier !== 'shadow') return false
  delete person.tier
  writeJsonAtomic(identitiesPath(root), data)
  return true
}

export function isShadow(root, uid) {
  return loadIdentities(root).people?.[uid]?.tier === 'shadow'
}

// ── 群体身份（客观，跨人格共用）────────────────────────────────────────

/**
 * 群体身份登记表：`system/groups.json`。
 *
 * 和 `identities.json` 同一个道理：**群体是谁是客观事实**（同一个 QQ 群在所有人格里
 * 都是同一个群），而"她对这个群有什么印象"才按人格存。所以编号（`grp_xxx`）在这里
 * 分配一次，人格目录里只放印象卡。
 *
 * 为什么编号不能是 `qq:123456`：场景不属于任何 App。换成微信、贴吧、Discord，
 * 场景还是"群体场景"这一类，变的只是卡里记的号。编号里带平台名，就等于把场景
 * 钉死在某一个 App 上（这正是被反复纠正的那一点）。
 */
export function loadGroupIdentities(root) {
  const j = readJson(path.join(root, P.groupIdentities), null)
  if (!j || typeof j !== 'object') return { version: 1, groups: {}, byNative: {} }
  return {
    version: j.version ?? 1,
    groups: j.groups && typeof j.groups === 'object' ? j.groups : {},
    byNative: j.byNative && typeof j.byNative === 'object' ? j.byNative : {},
  }
}

export function saveGroupIdentities(root, data) {
  writeJsonAtomic(path.join(root, P.groupIdentities), data)
  return data
}

/** (平台, 原生号) → 查登记表用的键。 */
export function nativeGroupKey(platform, nativeId) {
  return `${String(platform || 'unknown')}:${String(nativeId ?? '')}`
}

/** 按 (平台, 原生号) 找群体编号；找不到返回 null。 */
export function findGidByNative(root, platform, nativeId) {
  if (!nativeId) return null
  return loadGroupIdentities(root).byNative[nativeGroupKey(platform, nativeId)] ?? null
}

/** 群体编号 → { platform, nativeId }（登记表里的客观身份）。 */
export function readGroupIdentity(root, gid) {
  return loadGroupIdentities(root).groups[String(gid ?? '')] ?? null
}

/**
 * 拿到一个群体场景的编号；没有就分配一个 `grp_xxx` 并登记。
 *
 * **只按 (平台, 原生号) 精确匹配**：两个平台上的 `123456` 是两个地方
 * （QQ 群 ≠ 贴吧吧），和人物一样不允许"号码碰巧一样就合并"。
 */
export function ensureGroupScene(root, { platform, nativeId, seenAt = null }) {
  if (!nativeId) throw new Error('缺少群体原生号，没法归到群体')
  const p = platform || 'unknown'
  const hit = findGidByNative(root, p, nativeId)
  if (hit) {
    const data = loadGroupIdentities(root)
    const rec = data.groups[hit]
    if (rec) {
      rec.lastSeen = seenAt || rec.lastSeen || localIso()
      saveGroupIdentities(root, data)
    }
    return hit
  }

  const data = loadGroupIdentities(root)
  const gid = 'grp_' + newUid().slice('person_'.length)
  data.groups[gid] = {
    gid,
    platform: p,
    nativeId: String(nativeId),
    created: localIso(),
    firstSeen: seenAt || localIso(),
    lastSeen: seenAt || localIso(),
  }
  data.byNative[nativeGroupKey(p, nativeId)] = gid
  saveGroupIdentities(root, data)
  return gid
}

/**
 * 把一个场景可能对应的**全部原始写法**列出来（读历史记录用）。
 *
 * raw 只追加，老记录里场景写的是外部号码（`private:10001` / `group:123555`），
 * 新记录才是内部编号。只比一种写法，老记录就会突然"不在场"、群权重突然归零。
 */
export function sceneRecordKeys(root, channel) {
  const c = resolveChannel(root, channel)
  const out = new Set([String(channel), c.raw, c.canonical])
  const data = loadIdentities(root)

  if (c.personUid) {
    for (const identity of data.people?.[c.personUid]?.identities ?? []) {
      out.add(`private:${identity.id}`)
    }
  }
  if (c.gid) {
    const idn = readGroupIdentity(root, c.gid)
    if (idn) {
      out.add(`group:${idn.platform}:${idn.nativeId}`)
      out.add(`group:${idn.nativeId}`)
      // 贴吧这类，老写法就是 `平台:对象`
      if (idn.platform !== 'qq') out.add(`${idn.platform}:${idn.nativeId}`)
    }
  }
  return [...out].filter(Boolean)
}

/** 老名字（保留给已有调用方）。 */
export const nativeChannelsFor = sceneRecordKeys

