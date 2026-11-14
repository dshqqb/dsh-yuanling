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
import fs from 'node:fs'
import path from 'node:path'
import {
  groupOf,
  loadCard,
  readCard,
  mainOf,
  ensureCard,
  listCards,
} from './accounts.js'
import { isCardUid } from './accounts.js'
import { writeJsonAtomic, readJson, localIso, ulid } from './fsx.js'
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
 * 模块的数据在 raw 里的「来源」名（v1.9 的规则）：
 *   · 模块声明了 app → 用 app（数据属于这个 App；几个都接 QQ 的模块天然合成一个来源）
 *   · 没声明 app    → 用模块 id（不能用 manifest 里的中文 name：它会进文件名与频道号）
 *
 * 来源名只决定 raw 的 `source` 与心跳；**平台**仍按模块 id 查（`appForModule`），
 * 因为来源可能已经是 app，反查模块会落空。
 */
export function sourceForModule(root, moduleId) {
  const id = String(moduleId ?? '').trim()
  if (!id) return ''
  return appForModule(root, id) ?? id
}

/**
 * 模块 → 账户平台：先看它 manifest 里的 app（`bili` 模块的 app 是 `bilibili`），
 * 再退回来源名推断。v1.9 把 raw 的 source 换成 app 之后，平台不能再从 source 猜——
 * 猜出来是 `bilibili`，而模块 id 推出来是 `bili`，两张牌就分裂了。
 */
export function platformForModule(root, moduleId, fallback = '') {
  const id = String(moduleId ?? '').trim()
  return appForModule(root, id) ?? platformFromSource(id) ?? platformFromSource(fallback) ?? null
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
    const card = loadCard(root, requirePid(root), scene.acct)
    return card ? { platform: String(card.app), id: String(card.account) } : null
  }
  if (scene.gid) {
    const s = String(scene.gid)
    const i = s.indexOf(':')
    if (i <= 0) return null
    return { platform: s.slice(0, i), id: s.slice(i + 1) }
  }
  return null
}

/** 场景编号是内部卡 id：`private:card_xxx`；旧外部号只在唯一命中时认。 */
export function resolveChannel(root, channel) {
  const raw = String(channel ?? '')
  const { kind, id } = parseChannel(raw)
  const p = requirePid(root)

  if (kind === 'private') {
    if (isCardUid(id)) {
      const card = readCard(root, p, id)
      if (!card) return { raw, kind, id, canonical: raw, acct: null, personUid: null, gid: null, nativeId: null, resolved: false, legacy: false, unresolvedReason: 'card-missing' }
      const main = mainOf(root, p, id)
      return { raw, kind, id, canonical: raw, acct: id, personUid: main, gid: null, nativeId: `${card.app}:${card.account}`, resolved: true, legacy: false }
    }
    const hits = listCards(root, p).filter((c) => String(c.account) === String(id))
    if (hits.length === 1) {
      const card = hits[0]
      return { raw, kind, id, canonical: raw, acct: card.id, personUid: mainOf(root, p, card.id), gid: null, nativeId: `${card.app}:${card.account}`, resolved: true, legacy: true }
    }
    return { raw, kind, id, canonical: raw, acct: null, personUid: null, gid: null, nativeId: null, resolved: false, legacy: true, unresolvedReason: hits.length ? 'ambiguous-native' : 'not-internal-id' }
  }

  if (GROUP_KINDS.has(kind)) {
    if (/^grp_/.test(id)) {
      return { raw, kind, id, canonical: raw, acct: null, personUid: null, gid: id, nativeId: null, resolved: true, legacy: false }
    }
    return { raw, kind, id, canonical: raw, acct: null, personUid: null, gid: null, nativeId: null, resolved: false, legacy: true, unresolvedReason: 'not-internal-id' }
  }

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
 * 私聊没有卡时**直接建一张好友卡**：私聊就是"跟她说话"，按定义不是路人。
 * （用户 2026-11-14 定：没有"路人"这个概念——说过话才有卡。）
 */
export function canonicalChannelForIngest(root, { channel, source, actorName = '', createPerson = true, platform = null }) {
  const raw = String(channel || 'unknown')
  const { kind, id } = parseChannel(raw)

  if (kind === 'private') {
    if (isCardUid(id)) {
      const card = readCard(root, requirePid(root), id)
      return { channel: raw, native: null, acct: id, personUid: card ? mainOf(root, requirePid(root), id) : null, gid: null }
    }
    if (!createPerson) return { channel: raw, native: raw, acct: null, personUid: null, gid: null }
    const plat = platform ?? appForModule(root, source) ?? platformFromSource(source) ?? platformOfKind(kind) ?? 'unknown'
    const r = ensureSenderAccount(root, { platform: plat, nativeId: id, nickname: actorName || id })
    return { channel: `private:${r.acct}`, native: `private:${plat}:${id}`, acct: r.acct, personUid: r.person, gid: null }
  }

  if (GROUP_KINDS.has(kind)) {
    if (/^grp_/.test(id)) {
      return { channel: raw, native: null, acct: null, personUid: null, gid: id }
    }
    const plat = platform ?? appForModule(root, source) ?? platformFromSource(source) ?? platformOfKind(kind) ?? 'unknown'
    const nativeId = id.includes(':') ? id.split(':').slice(1).join(':') : id
    const gid = ensureGroupScene(root, { platform: plat, nativeId })
    return { channel: `group:${gid}`, native: raw, acct: null, personUid: null, gid }
  }

  return { channel: raw, native: null, acct: null, personUid: null, gid: null }
}

/**
 * 保证某个外部账号有卡（没有就建——建卡即好友）。
 * 建卡时 accounts.createCard 会自动把这个人从路人名册里删掉。
 * @returns {{acct:string, person:string, createdAcct:boolean}}
 */
export function ensureSenderAccount(root, { platform, nativeId, nickname = '', nicknames = null } = {}) {
  if (!nativeId) throw new Error('缺少账号 id，没法归人')
  const p = requirePid(root)
  const r = ensureCard(root, p, { app: platform || 'unknown', account: nativeId, nickname, nicknames })
  return { acct: r.cardId, person: mainOf(root, p, r.cardId), createdAcct: r.created }
}

export function ensureSenderPerson(root, opts = {}) {
  return ensureSenderAccount(root, opts).person
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
  const pid = requirePid(root)
  const file = path.join(root, personaFile.groupIdentities(pid))
  const key = `${path.resolve(root)}|${pid}`
  let stamp = 'missing'
  try {
    const st = fs.statSync(file)
    stamp = `${st.mtimeMs}:${st.size}`
  } catch {
    /* 还没建登记表 */
  }
  const hit = identitiesCache.get(key)
  if (hit && hit.stamp === stamp) return hit.data

  const j = readJson(file, null)
  const data =
    j && typeof j === 'object'
      ? {
          version: j.version ?? 1,
          groups: j.groups && typeof j.groups === 'object' ? j.groups : {},
          byNative: j.byNative && typeof j.byNative === 'object' ? j.byNative : {},
        }
      : { version: 1, groups: {}, byNative: {} }
  identitiesCache.set(key, { stamp, data })
  return data
}

/** 身份登记表也按 stamp 缓一下：`gidForChannel` 每条消息都会用到它。 */
const identitiesCache = new Map()

export function saveGroupIdentities(root, data) {
  const pid = requirePid(root)
  const file = path.join(root, personaFile.groupIdentities(pid))
  writeJsonAtomic(file, data)
  try {
    const st = fs.statSync(file)
    identitiesCache.set(`${path.resolve(root)}|${pid}`, { stamp: `${st.mtimeMs}:${st.size}`, data })
  } catch {
    identitiesCache.delete(`${path.resolve(root)}|${pid}`)
  }
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
    const card = readCard(root, requirePid(root), c.acct)
    if (card) {
      out.add(`private:${card.account}`)
      out.add(`private:${card.app}:${card.account}`)
    }
    out.add(`private:${c.acct}`)
    if (c.personUid && c.personUid !== c.acct) out.add(`private:${c.personUid}`)
  }
  if (!c.acct && c.personUid) {
    for (const card of groupOf(root, requirePid(root), c.personUid)) {
      out.add(`private:${card.account}`)
      out.add(`private:${card.app}:${card.account}`)
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

