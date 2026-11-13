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
import {
  accountForNative,
  accountsForPerson,
  ensureAccount,
  ensurePersonForAccount,
  labelOfPerson,
  loadAccount,
  loadPersons,
  savePersons,
  personForAccount,
  personWeight,
} from './accounts.js'
import { isAccountUid, isPersonUid } from './accounts.js'
import { writeJsonAtomic, readJson, localIso, ulid } from './fsx.js'
import { P } from './paths.js'
import { CHANNEL_PLATFORM, GROUP_KINDS } from './platforms.js'
import { personaFile, requirePid } from './scope.js'
import { readRegistry } from './modules/registry.js'

import { PLATFORMS } from './accounts.js'

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

/** v1.8：模块 manifest 上报的 app；没有就 null。 */
export function appForModule(root, moduleId) {
  const id = String(moduleId ?? '').trim()
  if (!id) return null
  const hit = readRegistry(root).modules?.[id]
  return hit?.app ? String(hit.app) : null
}

/**
 * 内部场景 → 平台侧的投递地址（QQ 号 / 群号）。
 *
 * 为什么需要它：出站必须给模块一个"能直接投递"的原始字符串（协议 §5.2 的 `target`），
 * 而场景编号里**故意不含**外部号码。这里做的是**反查**，方向与 resolveChannel 相反：
 *   `private:person_xxx` → 那个人挂在 qq 上的号
 *   `group:qq:123456`    → `123456`
 *
 * @returns {{platform:string, id:string} | null}
 */
export function nativeTargetFor(root, channel) {
  const scene = resolveChannel(root, channel)

  if (scene.kind === 'private' && scene.acct) {
    const card = loadAccount(root, requirePid(root), scene.acct)
    return card ? { platform: String(card.platform), id: String(card.nativeId) } : null
  }
  if (scene.kind === 'private' && scene.personUid) {
    // 兼容旧场景：拿主账户
    const rec = loadPersons(root).persons?.[scene.personUid]
    const card = rec?.primary ? loadAccount(root, requirePid(root), rec.primary) : null
    return card ? { platform: String(card.platform), id: String(card.nativeId) } : null
  }

  if (scene.gid) {
    const s = String(scene.gid)
    const i = s.indexOf(':')
    if (i <= 0) return null
    return { platform: s.slice(0, i), id: s.slice(i + 1) }
  }

  return null
}

/**
 * 场景编号是内部编号：`private:<acct_xxx>`（新）/ `private:<person_xxx>`（旧）。
 * 旧的 `private:<外部号>` 只有在能**唯一**反查到账户时才认；认不出就 unresolved，不猜。
 */
export function resolveChannel(root, channel) {
  const raw = String(channel ?? '')
  const { kind, id } = parseChannel(raw)

  if (kind === 'private') {
    if (isAccountUid(id)) {
      const card = loadAccount(root, requirePid(root), id)
      if (!card) {
        return { raw, kind, id, canonical: raw, acct: null, personUid: null, gid: null, nativeId: null, resolved: false, legacy: false, unresolvedReason: 'account-missing' }
      }
      const person = personForAccount(root, id)
      return {
        raw,
        kind,
        id,
        canonical: raw,
        acct: id,
        personUid: person?.uid ?? null,
        gid: null,
        nativeId: `${card.platform}:${card.nativeId}`,
        resolved: true,
        legacy: false,
      }
    }
    if (isPersonUid(id)) {
      const rec = loadPersons(root).persons?.[id]
      const acct = rec?.primary ?? rec?.accounts?.[0] ?? null
      return {
        raw,
        kind,
        id,
        canonical: raw,
        acct,
        personUid: rec ? id : null,
        gid: null,
        nativeId: acct ? null : null,
        resolved: Boolean(rec),
        legacy: false,
        unresolvedReason: rec ? undefined : 'person-missing',
      }
    }
    // 旧格式：外部号当编号。按 qq/微信/贴吧等逐个查账户；唯一命中才认。
    const platforms = ['qq', 'wechat', 'tieba', 'tg', 'dsh']
    const hits = []
    for (const platform of platforms) {
      const acct = accountForNative(root, platform, id)
      if (acct) hits.push({ platform, acct })
    }
    if (hits.length === 1) {
      const person = personForAccount(root, hits[0].acct)
      return {
        raw,
        kind,
        id,
        canonical: raw,
        acct: hits[0].acct,
        personUid: person?.uid ?? null,
        gid: null,
        nativeId: `${hits[0].platform}:${id}`,
        resolved: true,
        legacy: true,
      }
    }
    return {
      raw,
      kind,
      id,
      canonical: raw,
      acct: null,
      personUid: null,
      gid: null,
      nativeId: null,
      resolved: false,
      legacy: true,
      unresolvedReason: hits.length ? 'ambiguous-native' : 'not-internal-id',
    }
  }

  if (GROUP_KINDS.has(kind)) {
    if (/^grp_/.test(id)) {
      return { raw, kind, id, canonical: raw, acct: null, personUid: null, gid: id, nativeId: null, resolved: true, legacy: false }
    }
    return {
      raw,
      kind,
      id,
      canonical: raw,
      acct: null,
      personUid: null,
      gid: null,
      nativeId: null,
      resolved: false,
      legacy: true,
      unresolvedReason: 'not-internal-id',
    }
  }

  // 不是人也不是地方：bili:video:BV1 / dsh:xxx / module:xxx —— 原样
  return { raw, kind, id, canonical: raw, acct: null, personUid: null, gid: null, nativeId: null, resolved: true, legacy: false }
}

/**
 * 旧格式场景 → 编号。**只给迁移/统计用**（scan、backfill、CLI 参数归一），
 * 不参与"这个场景是谁"的解析。要新注册一个群体时用它。
 *
 * @returns {{kind:'private'|'group', platform:string|null, nativeId:string}|null}
 */
export function legacySceneIdentity(root, scene) {
  void root
  const { kind, id } = parseChannel(scene)
  if (kind === 'private') {
    // 私聊的旧格式里没有平台信息，无从归属——返回 null，不猜
    return null
  }
  if (!GROUP_KINDS.has(kind) || !id) return null
  const platform = id.includes(':') ? id.split(':')[0] : platformOfKind(kind)
  const nativeId = id.includes(':') ? id.split(':').slice(1).join(':') : id
  return { kind: 'group', platform, nativeId }
}

/**
 * 入库时把**外部**频道换成规范频道，并保证私聊一定有对应人物。
 *
 * 私聊来源还没人物卡时建一张**影子卡**（tier=shadow）：记着"这个人我见过，但还不认识"。
 * 影子卡不进注入、默认不在人物页显示；等有人写素描、被认领、或当管理员才算认识。
 */
export function canonicalChannelForIngest(root, { channel, source, actorName = '', createPerson = true }) {
  const raw = String(channel || 'unknown')
  const { kind, id } = parseChannel(raw)

  if (kind === 'private') {
    // 已经是账户编号 → 直接用
    if (isAccountUid(id)) {
      const person = personForAccount(root, id)
      return { channel: raw, native: null, acct: id, personUid: person?.uid ?? null, gid: null }
    }
    // 旧内部人物编号 → 主账户
    if (isPersonUid(id)) {
      const rec = loadPersons(root).persons?.[id]
      const acct = rec?.primary ?? rec?.accounts?.[0] ?? null
      return { channel: acct ? `private:${acct}` : raw, native: null, acct, personUid: rec ? id : null, gid: null }
    }
    // 她自己的话不建卡
    if (!createPerson) return { channel: raw, native: raw, acct: null, personUid: null, gid: null }
    const platform = appForModule(root, source) ?? platformFromSource(source) ?? platformOfKind(kind) ?? 'unknown'
    const r = ensureSenderAccount(root, { platform, nativeId: id, nickname: actorName || id })
    return { channel: `private:${r.acct}`, native: `private:${platform}:${id}`, acct: r.acct, personUid: r.person, gid: null }
  }

  if (GROUP_KINDS.has(kind)) {
    if (/^grp_/.test(id)) {
      return { channel: raw, native: null, acct: null, personUid: null, gid: id }
    }
    const platform = appForModule(root, source) ?? platformFromSource(source) ?? platformOfKind(kind) ?? 'unknown'
    const nativeId = id.includes(':') ? id.split(':').slice(1).join(':') : id
    const gid = ensureGroupScene(root, { platform, nativeId })
    return { channel: `group:${gid}`, native: raw, acct: null, personUid: null, gid }
  }

  return { channel: raw, native: null, acct: null, personUid: null, gid: null }
}

/**
 * 保证某个外部账号有账户卡 + 人物卡（没有人物就建一张影子人物）。
 * @returns {{acct:string, person:string, createdAcct:boolean, createdPerson:boolean}}
 */
export function ensureSenderAccount(root, { platform, nativeId, nickname = '', nicknames = null } = {}) {
  if (!nativeId) throw new Error('缺少账号 id，没法归人')
  const p = requirePid(root)
  const r = ensureAccount(root, p, { platform: platform || 'unknown', nativeId, nickname, nicknames })
  let person = personForAccount(root, p, r.acct)
  let createdPerson = false
  if (!person) {
    const uid = ensurePersonForAccount(root, p, r.acct)
    createdPerson = true
    const data = loadPersons(root, p)
    const rec = data.persons[uid]
    const hasProfile = Boolean(readJson(path.join(root, P.personas, p, 'entities', 'people', `${uid}.json`), null))
    if (rec && !hasProfile) rec.tier = 'shadow'
    savePersons(root, data, p)
    person = loadPersons(root, p).persons[uid]
  }
  return { acct: r.acct, person: person.uid, createdAcct: r.created, createdPerson }
}

/** 旧名门面：返回人物 uid。 */
export function ensureSenderPerson(root, opts = {}) {
  return ensureSenderAccount(root, opts).person
}

/** 影子卡转正：有人写过素描 / 认过领 / 当了管理员，就不再是“路人”。 */
export function promoteShadow(root, uid) {
  const data = loadPersons(root)
  const person = data.persons?.[uid]
  if (!person || person.tier !== 'shadow') return false
  delete person.tier
  savePersons(root, data)
  return true
}

export function isShadow(root, uid) {
  return loadPersons(root).persons?.[uid]?.tier === 'shadow'
}

// ── 群体身份（客观，跨人格共用）────────────────────────────────────────

/**
 * 群体身份登记表：`personas/<p>/entities/group-identities.json`（**按人格**）。
 *
 * 用户定的（2026-11-11）：**除原始层外，所有人格相关数据都在 personas/<id>/ 下**。
 * "这个群是哪个 QQ 群"也是一种认知（网关报错、号变了都会让它出错），所以随人格走。
 *
 * 为什么编号不能是 `qq:123456`：场景不属于任何 App。换成微信、贴吧、Discord，
 * 场景还是"群体场景"这一类，变的只是卡里记的号。编号里带平台名，就等于把场景
 * 钉死在某一个 App 上（这正是被反复纠正的那一点）。
 */
export function loadGroupIdentities(root) {
  const j = readJson(path.join(root, personaFile.groupIdentities(requirePid(root))), null)
  if (!j || typeof j !== 'object') return { version: 1, groups: {}, byNative: {} }
  return {
    version: j.version ?? 1,
    groups: j.groups && typeof j.groups === 'object' ? j.groups : {},
    byNative: j.byNative && typeof j.byNative === 'object' ? j.byNative : {},
  }
}

export function saveGroupIdentities(root, data) {
  writeJsonAtomic(path.join(root, personaFile.groupIdentities(requirePid(root))), data)
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
  const gid = 'grp_' + ulid()
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

  if (c.acct) {
    const card = loadAccount(root, requirePid(root), c.acct)
    if (card) {
      out.add(`private:${card.nativeId}`)
      out.add(`private:${card.platform}:${card.nativeId}`)
    }
    out.add(`private:${c.acct}`)
    if (c.personUid) out.add(`private:${c.personUid}`)
  }
  if (!c.acct && c.personUid) {
    for (const card of accountsForPerson(root, requirePid(root), c.personUid)) {
      out.add(`private:${card.nativeId}`)
      out.add(`private:${card.platform}:${card.nativeId}`)
    }
    out.add(`private:${c.personUid}`)
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

