// src/core/groups.js —— 群体实体：她身处的"一群人"。
//
// 和人物（entities.js）刻意不同：
//   · **人物可以跨平台合并**（一个 QQ 号和一个 B站号可能是同一个人）；
//   · **群体不能**。一个 QQ 群永远不等于一个贴吧，它们只是"同一种位置"上的两个实体。
//     所以没有"把这个群和那个群并起来"的操作。
//
// 编号（2026-11-09 改）：**`grp_xxx`，纯内部编号**，不含平台也不含外部号码。
//   · 客观身份（平台 + 原生号：QQ 群号 / 贴吧吧名 / 微信群 id）存在 `system/groups.json`
//   · 主观印象（名字、氛围、成员、权重）存在 `personas/<pid>/entities/groups/<gid>.json`
// 这和人物是同一套分法：谁是谁客观、怎么看她主观。场景（`group:<gid>`）只说"哪个群体"，
// 不说"哪个 App 的哪个群"——否则换成微信/贴吧就要改全部历史数据的语义。
//
// 字段尽量少：身份在登记表，卡里只放自然语言。固定字段一多，模型就只会填空，
// 写不出"这群人什么味儿"。
import fs from 'node:fs'
import path from 'node:path'

import { exists, isDir, localIso, readJson } from './fsx.js'
import { P } from './paths.js'
import { writeTracked } from './version.js'

// 频道 kind ↔ 平台、哪些 kind 算"一个地方"——纯常量放 platforms.js（channels.js 也要用，
// 放在这里会和它循环 import）。这里 import 进来自己用，并重新导出，老调用方不用改。
import { CHANNEL_PLATFORM, GROUP_KINDS } from './platforms.js'
import { pinWeight } from './weights.js'
import { autoUniqueName } from './names.js'
import { personaFile, requirePid } from './scope.js'
import { mentionedGroups } from './aliases.js'

export { CHANNEL_PLATFORM, GROUP_KINDS }

// 场景解析、群体身份登记表都在 channels.js。它不 import groups.js（只 import 常量层），
// 所以这里引它不会成环。
import { resolveChannel, sceneRecordKeys, readGroupIdentity, ensureGroupScene, parseChannel, findGidByNative } from './channels.js'
// 群体身份的读写是 channels.js 的事（那里是"场景/身份"的唯一真相）。
// 这里再导出一次，调用方（CLI / API / 测试）从 groups.js 取就够了。
export { ensureGroupScene, readGroupIdentity, findGidByNative }

/** 一个群体最多记多少人（成员是"素材"，不是通讯录）。 */
export const MAX_MEMBERS = 60
/** 成员扫描看最近几天。 */
export const MEMBER_SCAN_DAYS = 30

/** 群体档案文件（人格内，按**群体编号**）。编号是 `grp_xxx`，不含平台与外部号码。 */
export function groupRel(pid, gid) {
  return `${P.personas}/${pid}/entities/groups/${String(gid).replace(/[\\/:*?"<>|]/g, '_')}.json`
}

/**
 * 场景 → 群体编号（不是群体场景就 null）。
 *
 * 场景只有两类，和 App 无关：`private:<人物编号>` / `group:<群体编号>`。
 * 老记录里场景还写着外部号码（`group:123555`），这种要先去登记表查映射；
 * 查不到就是 null——**不猜**。
 */
export function gidForChannel(root, channel) {
  const c = resolveChannel(root, channel)
  if (!c) return null
  // 群体场景有两类写法：`group:<gid>`，以及贴吧这类 `tieba:<吧名>`（本身就是"平台:对象"）。
  // 两类都算群体；私聊与 module:/bili:video: 不算。
  if (c.kind !== 'group' && !GROUP_KINDS.has(c.kind)) return null
  return c.gid ?? null
}

/**
 * 群体编号 → 场景名。永远返回 `group:<gid>`，真实群号只在登记表与卡里。
 */
export function channelOfGid(gid) {
  return `group:${gid}`
}

/** 这个群体可能对应的所有原始写法（读历史记录用：老记录写的是外部号码）。 */
export function sceneKeysForGid(root, gid) {
  return sceneRecordKeys(root, channelOfGid(gid))
}

/** 读一个群体档案；没有就返回 null（**不自动建**：没见过的群不该凭空出现）。 */
export function readGroup(root, pid, gid) {
  const rel = groupRel(pid, gid)
  const cur = readJson(path.join(root, rel), null)
  if (!cur) return null
  return normalizeGroup(cur, gid, root)
}

/**
 * 群体卡的形状。
 *
 * 卡里只有：名字、描述（自然语言）、成员（事实）、权重与重点名次。
 * 平台与原生号不在这里——它们在 `system/groups.json`（客观身份），卡只认 `gid`。
 */
export function normalizeGroup(raw, gid, root = null) {
  // 平台与原生号不在编号里（编号是 `grp_xxx`），从**客观登记表**取。
  const identity = root ? readGroupIdentity(root, gid ?? raw?.gid) : null
  const platform = identity?.platform ?? raw?.platform ?? 'unknown'
  const nativeId = identity?.nativeId ?? raw?.nativeId ?? raw?.id ?? ''

  return {
    gid: gid ?? raw.gid,
    platform,
    // 原生号（QQ 群号 / 贴吧吧名 / 微信群 id）。场景里不出现它，但卡里必须有。
    nativeId,
    // 老字段名，前端和 CLI 还在读；等于 nativeId
    id: nativeId,
    name: String(raw?.name ?? ''),
    feature: String(raw?.feature ?? ''),
    members: Array.isArray(raw?.members) ? raw.members.map(String) : [],
    memberCount: Number(raw?.memberCount ?? 0),
    weight: Number(raw?.weight ?? 0),
    // 新建时的默认分：一次互动都没有时用它显示（否则刚建的群会显示 0）
    weightSeed: Number(raw?.weight_seed ?? 0),
    // 重点名单里的名次（0 起）；不在名单里就是 null。
    // 名次决定权重（weights.js 的 pinWeight：最后一名 110，往上每名 +5）。
    pinRank: Number.isFinite(Number(raw?.pin_rank)) ? Number(raw.pin_rank) : null,
    weightSource: 'auto',
    tier: raw?.tier === 'important' ? 'important' : null,
    firstSeen: raw?.first_seen ?? null,
    lastSeen: raw?.last_seen ?? null,
    updatedAt: raw?.updated_at ?? null,
  }
}

/** 名字的规范形：全角半角统一、空白压成一个、大小写不敏感。 */
function nameKey(s) {
  return String(s ?? '')
    .normalize('NFKC')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase()
}

/**
 * 群体名字在同一人格里唯一（不同人格可以各叫各的：那是她对不同地方的印象）。
 *
 * @returns {object|null} 占用这个名字的群体
 */
export function groupNameOwner(root, pid, name, { exceptGid = null } = {}) {
  const key = nameKey(name)
  if (!key) return null
  for (const g of listGroups(root, pid)) {
    if (g.gid === exceptGid) continue
    if (nameKey(g.name) === key) return g
  }
  return null
}

/** 名字被占了就抛错，并说清"换个什么"——不静默改名。 */
export function assertGroupNameFree(root, pid, name, opts = {}) {
  const hit = groupNameOwner(root, pid, name, opts)
  if (!hit) return
  const n = String(name ?? '').trim()
  throw new Error(`群体名字「${n}」已经有人用了（${hit.gid}）。换一个：可以带上平台或特点，例如「${n}（贴吧）」`)
}

/** 写群体档案。走 version.js 的追踪写，可回滚、有变更记录。 */
export function writeGroup(root, pid, gid, patch = {}, { actor = 'system:group', reason = '更新群体档案', skipNameCheck = false } = {}) {
  const rel = groupRel(pid, gid)
  const cur = readGroup(root, pid, gid) ?? normalizeGroup({}, gid, root)
  // 改名查重（新建也走这里，所以创建同样受约束）。
  // 迁移例外：那是同一张卡换个编号，名字本来就在那儿。
  if (!skipNameCheck && patch.name !== undefined && nameKey(patch.name) !== nameKey(cur.name)) {
    assertGroupNameFree(root, pid, patch.name, { exceptGid: gid })
  }
  const next = {
    // 卡里**不再存 gid 之外的编号信息**：平台与原生号在 system/groups.json（客观层）。
    // 不在这里再抄一份，否则两处迟早分叉。
    gid,
    name: patch.name !== undefined ? String(patch.name) : cur.name,
    feature: patch.feature !== undefined ? String(patch.feature) : cur.feature,
    members: patch.members ? patch.members.map(String) : cur.members,
    memberCount: patch.memberCount !== undefined ? Number(patch.memberCount) : cur.memberCount,
    weight: patch.weight !== undefined ? Number(patch.weight) : cur.weight,
    weight_seed: patch.weightSeed !== undefined ? Number(patch.weightSeed) : cur.weightSeed ?? 0,
    weight_source: 'auto',
    pin_rank: patch.pinRank !== undefined ? patch.pinRank : cur.pinRank ?? null,
    tier: patch.tier === undefined ? cur.tier : patch.tier === 'important' ? 'important' : null,
    first_seen: patch.firstSeen ?? cur.firstSeen ?? localIso(),
    last_seen: patch.lastSeen ?? cur.lastSeen,
    updated_at: localIso(),
  }
  writeTracked(root, rel, JSON.stringify(next, null, 2) + '\n', {
    actor,
    reason: patch.__reason ?? reason,
  })
  return normalizeGroup(next, gid, root)
}

/**
 * 列出人格下的所有群体。
 *
 * 列表里的 `weight` 是**读的时候现算的**（手改过的除外）：权重只用来排序和显示，
 * 没有任何地方拿它做取舍，所以没必要为了"看得见"造一条后台写路径，也不该让页面
 * 显示"0 分但其实聊了几百条"的旧数。落盘的 `weight` 仍然保留，作为冻结值给
 * `refreshGroupWeight` 用。
 */
export function listGroups(root, pid, { now = Date.now() } = {}) {
  const dir = path.join(root, P.personas, pid, 'entities', 'groups')
  if (!isDir(dir)) return []
  const out = []
  for (const name of fs.readdirSync(dir)) {
    if (!name.endsWith('.json')) continue
    const g = readJson(path.join(dir, name), null)
    if (!g) continue
    const gid = String(g.gid ?? name.replace(/\.json$/, ''))
    const cur = normalizeGroup(g, gid, root)
    out.push({ ...cur, sealedNotes: undefined, weight: liveGroupWeight(root, pid, cur, { now }) })
  }
  // 重点名单按名次（越靠前越高），其余按互动分
  const pinned = out.filter((g) => g.tier === 'important')
  const total = pinned.length
  for (const g of out) {
    const eff = effectiveGroupWeight(g, { totalPinned: total })
    g.weight = eff.weight
    g.storedWeight = eff.stored
    g.weightKind = eff.kind
    g.rank = eff.rank
  }
  out.sort((a, b) => {
    const ap = a.tier === 'important' ? 1 : 0
    const bp = b.tier === 'important' ? 1 : 0
    if (ap !== bp) return bp - ap
    if (ap) return Number(a.rank ?? 0) - Number(b.rank ?? 0)
    return b.weight - a.weight || String(b.lastSeen ?? '').localeCompare(String(a.lastSeen ?? ''))
  })
  return out
}

/**
 * 读一个群体，返回值里带上**生效**权重（详情页 / CLI / MCP 用）。
 * 生效口径：重点名单按名次（110 起），其余用互动分。
 */
export function readGroupLive(root, pid, gid, { now = Date.now() } = {}) {
  const g = readGroup(root, pid, gid)
  if (!g) return null
  const live = liveGroupWeight(root, pid, g, { now })
  const total = pinnedGroups(root, pid).length
  const eff = effectiveGroupWeight({ ...g, weight: live }, { totalPinned: total })
  return { ...g, weight: eff.weight, storedWeight: eff.stored, weightKind: eff.kind, rank: eff.rank }
}

/** 实时权重：按原始层里的互动现算（不写盘）。重点名单则由名次覆盖，见 effectiveGroupWeight。 */
export function liveGroupWeight(root, pid, g, { now = Date.now() } = {}) {
  if (!g) return 0
  const computed = computeGroupWeight(channelStats(root, g.gid, now))
  // 一次互动都没有：保留新建时的默认分（50），别把"刚建的群"显示成 0
  if (computed === 0) return Number(g.weightSeed ?? g.weight ?? 0)
  return computed
}

/**
 * 一个群体生效的权重：重点名单按名次（110 起），其余用互动分。
 * 和人物同一套口径（weights.js）。
 */
export function effectiveGroupWeight(g, { totalPinned = 0 } = {}) {
  const stored = Math.max(0, Math.min(100, Math.round(Number(g?.weight ?? 0))))
  if (g?.tier === 'important') {
    const rank = Number.isFinite(Number(g.pinRank)) ? Number(g.pinRank) : 0
    return { weight: pinWeight(rank, totalPinned), kind: 'pinned', stored, rank }
  }
  return { weight: stored, kind: 'auto', stored, rank: null }
}

/** 重点群体名单（按名次），返回 gid 数组。 */
export function pinnedGroups(root, pid) {
  return listGroups(root, pid)
    .filter((g) => g.tier === 'important')
    .sort((a, b) => Number(a.pinRank ?? 0) - Number(b.pinRank ?? 0))
    .map((g) => g.gid)
}

/**
 * 两条消息之间至少隔这么久，才值得为"最后一次见到"再写一次盘。
 *
 * `lastSeen` 是给人看的**粗粒度**信息（"今天下午还在聊"），不是精确到秒的审计。
 * 而每次写都进版本历史——一条消息一个版本，几周就能把 versions 目录撑爆。
 * 所以按 30 分钟取整：够新，又不会为每句话造一条记录。
 */
export const LAST_SEEN_MIN_GAP_MS = 30 * 60 * 1000

/** 这次的"见到"值不值得写盘：第一次见到、或者比上次晚了足够久。 */
function shouldAdvance(prev, next) {
  if (!next) return false
  const a = Date.parse(prev ?? '')
  const b = Date.parse(next)
  if (!Number.isFinite(a) || !Number.isFinite(b)) return !prev || String(next) > String(prev)
  return b - a >= LAST_SEEN_MIN_GAP_MS
}

/** 确保群体存在（**只在确实见过东西时才调**，比如这个频道有消息了）。 */
/** 群编号 'qq:123' → 平台 'qq'；认不出就 null。 */
export function platformFromGid(gid) {
  const s = String(gid ?? '')
  const i = s.indexOf(':')
  return i > 0 ? s.slice(0, i) : null
}

/** 自动取群名：群名唯一是硬要求（同名群靠名字区分时不能撞）。 */
export function uniqueGroupName(root, pid, display, { platform = null, nativeId = '' } = {}) {
  return autoUniqueName(display, {
    platform,
    nativeId,
    taken: (name) => Boolean(groupNameOwner(root, pid, name)),
  })
}

export function ensureGroup(root, pid, gid, { name = '', seenAt = null, firstSeen = null } = {}) {
  const cur = readGroup(root, pid, gid)
  if (cur) {
    // 第一次建卡时适配器没带群名（老版本 / 接口失败），后来拿到了就补上。
    // 只补"空名字"，不覆盖人写过的名字——补名和自动建卡是同一条路（撞名自动加标识）。
    const wantName = String(name ?? '').trim()
    if (wantName && !String(cur.name ?? '').trim()) {
      const idn = readGroupIdentity(root, gid)
      const uniqueName = uniqueGroupName(root, pid, wantName, {
        platform: idn?.platform ?? platformFromGid(gid),
        nativeId: idn?.nativeId ?? '',
      })
      return writeGroup(
        root,
        pid,
        gid,
        { name: uniqueName, ...(seenAt ? { lastSeen: String(seenAt) } : {}) },
        { reason: '第一次拿到这个群的名字', skipNameCheck: true },
      )
    }
    if (seenAt && shouldAdvance(cur.lastSeen, String(seenAt))) {
      return writeGroup(root, pid, gid, { lastSeen: String(seenAt) }, { reason: '见到这个群体有新动静' })
    }
    return cur
  }
  // 自动建卡：群名撞了也自动加标识（(QQ) 老窝），理由和人物一样——这是她在办事。
  // 平台从身份登记表取：gid 是内部编号（grp_xxx），里面没有平台名。
  const idn = readGroupIdentity(root, gid)
  const uniqueName = name
    ? uniqueGroupName(root, pid, name, { platform: idn?.platform ?? platformFromGid(gid), nativeId: idn?.nativeId ?? '' })
    : ''
  return writeGroup(
    root,
    pid,
    gid,
    { name: uniqueName, lastSeen: seenAt, firstSeen: firstSeen ?? localIso() },
    { reason: '第一次见到这个群体', skipNameCheck: true },
  )
}

/**
 * 一条消息进来时顺手记一笔"这个人在这个群里"。
 *
 * 为什么不只靠 collectMembers（扫 raw）：提及判定要用"谁属于这个群"来裁决重名昵称，
 * 而扫 raw 只在页面按下按钮时发生——中间这段时间，裁决就没有依据。
 * 上限沿用 MAX_MEMBERS：成员是"素材"，不是通讯录。
 */
export function noteGroupMember(root, pid, gid, uid) {
  const who = String(uid ?? '').trim()
  if (!gid || !who) return null
  const cur = readGroup(root, pid, gid)
  if (!cur) return null
  if ((cur.members ?? []).includes(who)) return cur
  if ((cur.members ?? []).length >= MAX_MEMBERS) return cur
  const members = [...(cur.members ?? []), who]
  return writeGroup(
    root,
    pid,
    gid,
    { members, memberCount: Math.max(Number(cur.memberCount ?? 0) + 1, members.length) },
    { reason: '见到这个人在群里说话', skipNameCheck: true },
  )
}

// ── 成员自动收集 ────────────────────────────────────────────────────────

/**
 * 从原始层归集"这个群里都有谁"。
 *
 * 只做**统计**，不做判断：谁说了几句话就是几句话。`members` 存人物卡 uid，
 * 认不出人物卡的 actor 不计入（宁可少几个，也不往人物表里塞假人）。
 *
 * @returns {{members:string[], memberCount:number, scannedDays:number, partial:boolean}}
 */
export function collectMembers(root, pid, gid, { days = MEMBER_SCAN_DAYS, now = null } = {}) {
  void now
  // 老记录里这个群写的是外部号码（`group:123555`），新记录是 `group:<gid>`。
  // 只按一种写法扫，历史成员会突然全部消失。
  const keys = new Set(sceneKeysForGid(root, gid))
  const counts = new Map()
  let scannedDays = 0

  for (const day of listRawDays(root).slice(-days)) {
    scannerDay(root, day, keys, counts)
    scannedDays += 1
  }

  // 只留能对上人物卡的
  const data = readIdentitiesSafe(root)
  const people = data?.people ?? {}
  const byQq = new Map()
  for (const person of Object.values(people)) {
    for (const ident of person.identities ?? []) {
      if (ident.state === 'blocked') continue
      byQq.set(`${ident.platform}:${ident.id}`, person.uid)
    }
  }

  const rows = []
  for (const [cue, n] of counts) {
    const uid = byQq.get(cue)
    if (uid) rows.push({ uid, n })
  }
  rows.sort((a, b) => b.n - a.n)

  const members = [...new Set(rows.map((r) => r.uid))].slice(0, MAX_MEMBERS)
  return { members, memberCount: rows.length, scannedDays, partial: scannedDays < days }
}

function readIdentitiesSafe(root) {
  const p = path.join(root, personaFile.identities(requirePid(root)))
  if (!exists(p)) return null
  try {
    return readJson(p, null)
  } catch {
    return null
  }
}

function scannerDay(root, day, keys, counts) {
  const dir = path.join(root, P.raw, day.slice(0, 7), day.slice(8, 10))
  if (!isDir(dir)) return
  const wanted = keys instanceof Set ? keys : new Set([keys])
  for (const name of fs.readdirSync(dir).filter((n) => n.endsWith('.ndjson'))) {
    let text = ''
    try {
      text = fs.readFileSync(path.join(dir, name), 'utf8')
    } catch {
      continue
    }
    for (const line of text.split('\n')) {
      let rec = null
      try {
        rec = JSON.parse(line)
      } catch {
        continue
      }
      if (!wanted.has(String(rec?.channel))) continue
      if (rec?.role === 'bot') continue // 她自己的发言不算"群里的人"
      const a = rec?.actor
      if (!a || !a.id) continue
      const cue = `${a.kind === 'member' ? 'qq' : String(a.kind ?? 'qq')}:${a.id}`
      counts.set(cue, (counts.get(cue) ?? 0) + 1)
    }
  }
}

function listRawDays(root) {
  const base = path.join(root, P.raw)
  if (!isDir(base)) return []
  const out = []
  for (const month of fs.readdirSync(base).sort()) {
    if (!/^\d{4}-\d{2}$/.test(month)) continue
    const mdir = path.join(base, month)
    if (!isDir(mdir)) continue
    for (const dd of fs.readdirSync(mdir).sort()) {
      if (/^\d{2}$/.test(dd) && isDir(path.join(mdir, dd))) out.push(`${month}-${dd}`)
    }
  }
  return out
}

// ── 权重与重要群体 ──────────────────────────────────────────────────────

/** 关注度：聊得越多、跨度越长、最近越活跃，她越在意这个群体。封顶 100。 */
export function computeGroupWeight({ msgs = 0, days = 0, recent = 0 } = {}) {
  return Math.min(100, Math.round(msgs * 0.5 + days * 1 + recent * 0.3))
}

/** 刷新一个群体的权重（手改过的不动）。落盘值，给"冻结一份"的场合用。 */
export function refreshGroupWeight(root, pid, gid, { now = Date.now() } = {}) {
  const g = readGroup(root, pid, gid)
  if (!g) return null
  if (g.weightSource === 'manual') return g
  const weight = computeGroupWeight(channelStats(root, gid, now))
  return writeGroup(root, pid, gid, { weight }, { reason: '按互动自动算权重' })
}

// ── 启动回填 ────────────────────────────────────────────────────────────

/**
 * 扫原始层里出现过的**群体场景**（只看 channel/ts，不读正文），把还没建卡的群补上。
 *
 * 幂等：已有的群只把 `lastSeen` 往前推，`firstSeen` 只在第一次建卡时写。
 * 认不出的场景（`module:...`、`bili:video:...`、私聊）一律不建——宁可少一个群，
 * 也不让"一次调用"变成一个"地方"。
 *
 * 老记录里的场景写着外部号码（`group:123555`），这里会顺手在身份登记表里补一条映射，
 * 之后同一个群就固定对应一个 `grp_xxx`。
 */
export function backfillGroups(root, pid) {
  const seen = scanGroupChannels(root)
  const created = []
  const touched = []
  for (const [gid, s] of seen) {
    const before = readGroup(root, pid, gid)
    if (!before) {
      ensureGroup(root, pid, gid, { seenAt: s.last, firstSeen: s.first })
      created.push(gid)
    } else if (s.last && (!before.lastSeen || String(s.last) > String(before.lastSeen))) {
      writeGroup(root, pid, gid, { lastSeen: s.last }, { reason: '回填历史时见到这个群体有动静' })
      touched.push(gid)
    }
  }
  return { created, touched, scannedDays: listRawDays(root).length }
}

/** 扫一遍原始层，得到 `gid → {first,last}`。只读频道与时间，不碰正文。 */
export function scanGroupChannels(root) {
  const out = new Map()
  for (const day of listRawDays(root)) {
    const dir = path.join(root, P.raw, day.slice(0, 7), day.slice(8, 10))
    if (!isDir(dir)) continue
    for (const name of fs.readdirSync(dir).filter((x) => x.endsWith('.ndjson'))) {
      let text = ''
      try {
        text = fs.readFileSync(path.join(dir, name), 'utf8')
      } catch {
        continue
      }
      for (const line of text.split('\n')) {
        const m = /"channel":"([^"]+)"/.exec(line)
        if (!m) continue
        const gid = resolveGidForScan(root, m[1])
        if (!gid) continue
        const tm = /"ts":"([^"]+)"/.exec(line)
        const ts = tm ? tm[1] : `${day}T00:00:00+08:00`
        const cur = out.get(gid)
        if (!cur) out.set(gid, { first: ts, last: ts })
        else {
          if (ts < cur.first) cur.first = ts
          if (ts > cur.last) cur.last = ts
        }
      }
    }
  }
  return out
}

/**
 * 扫描时把场景解析成群体编号：老场景（`group:123555`）顺手在登记表里落一条，
 * 这样同一个群只会被分配一次 `grp_xxx`，之后再扫就稳定了。
 */
function resolveGidForScan(root, scene) {
  const direct = gidForChannel(root, scene)
  if (direct) return direct
  const { kind, id } = parseChannel(scene)
  if (!GROUP_KINDS.has(kind) || !id) return null
  const platform = id.includes(':') ? id.split(':')[0] : CHANNEL_PLATFORM[kind] ?? kind
  const nativeId = id.includes(':') ? id.split(':').slice(1).join(':') : id
  try {
    return ensureGroupScene(root, { platform, nativeId })
  } catch {
    return null
  }
}

function channelStats(root, gid, now) {
  const days = new Set()
  let msgs = 0
  let recent = 0
  const nowMs = Number(now)
  // 老记录里场景写的是外部号码（`group:555` / `group:qq:555`），新记录是 `group:<gid>`。
  // 只数一种写法，老群会"权重突然归 0"——看起来就像群被人删了。
  const keys = new Set(sceneKeysForGid(root, gid))
  for (const day of listRawDays(root).slice(-30)) {
    const t = channelDayCount(root, day, keys)
    if (!t) continue
    msgs += t
    days.add(day)
    if (nowMs - Date.parse(`${day}T23:59:59`) < 30 * 24 * 3600 * 1000) recent += t
  }
  return { msgs, days: days.size, recent }
}

function channelDayCount(root, day, keys) {
  const dir = path.join(root, P.raw, day.slice(0, 7), day.slice(8, 10))
  if (!isDir(dir)) return 0
  const wanted = keys instanceof Set ? keys : new Set(Array.isArray(keys) ? keys : [keys])
  let n = 0
  for (const name of fs.readdirSync(dir).filter((x) => x.endsWith('.ndjson'))) {
    let text = ''
    try {
      text = fs.readFileSync(path.join(dir, name), 'utf8')
    } catch {
      continue
    }
    for (const line of text.split('\n')) {
      if (!wanted.size) continue
      for (const c of wanted) {
        if (line.includes(`"channel":"${c}"`)) {
          n += 1
          break
        }
      }
    }
  }
  return n
}

/**
 * 重要群体（重点名单）：置顶时分配名次，取消时把后面的往前挪（不留空洞）。
 */
export function setGroupTier(root, pid, gid, tier) {
  const important = tier === 'important'
  const list = pinnedGroups(root, pid)
  const already = list.includes(gid)
  if (important && !already) {
    return writeGroup(root, pid, gid, { tier: 'important', pinRank: list.length }, { reason: '设为重点群体' })
  }
  if (!important && already) {
    const next = list.filter((x) => x !== gid)
    const g = writeGroup(root, pid, gid, { tier: null, pinRank: null }, { reason: '取消重点群体' })
    renumberGroups(root, pid, next)
    return g
  }
  return readGroup(root, pid, gid)
}

/** 把名单里的名次重排成 0..n-1。 */
export function renumberGroups(root, pid, gids) {
  gids.forEach((gid, i) => {
    const g = readGroup(root, pid, gid)
    if (Number(g?.pinRank) === i) return
    writeGroup(root, pid, gid, { pinRank: i }, { reason: '重点群体重新排序' })
  })
}

/** 在重点名单里往上/下挪一格。 */
export function moveGroupPinned(root, pid, gid, direction) {
  const list = pinnedGroups(root, pid)
  const i = list.indexOf(gid)
  if (i < 0) throw new Error('不在重点名单里')
  const j = direction === 'up' ? i - 1 : i + 1
  if (j < 0 || j >= list.length) return { moved: false, rank: i }
  const next = [...list]
  ;[next[i], next[j]] = [next[j], next[i]]
  renumberGroups(root, pid, next)
  return { moved: true, rank: j }
}

/**
 * 平台名 → 内部 id。**只认得出常见的那几个**，认不出的原样保留小写——
 * 因为"加一个新平台"不该需要改代码（贴吧、Discord、Telegram 都能这么进来）。
 */
const PLATFORM_WORDS = [
  [/^(qq群|qq|扣扣)$/i, 'qq'],
  [/^(微信群|微信|wechat|weixin)$/i, 'wechat'],
  [/^(贴吧|tieba)$/i, 'tieba'],
  [/^(b站|bilibili|bili)$/i, 'bili'],
  [/^(discord|dc)$/i, 'discord'],
  [/^(telegram|tg|电报)$/i, 'telegram'],
  [/^(kook|开黑啦)$/i, 'kook'],
]

function platformOfWord(word) {
  const w = String(word ?? '').trim()
  for (const [re, id] of PLATFORM_WORDS) if (re.test(w)) return id
  return w.toLowerCase()
}

/** 去掉"号是 / 群号 / 叫 / @"这类连接词，留下真正的号码或名字。 */
function cleanNative(v) {
  return String(v ?? '')
    .trim()
    .replace(/^[:：\-—\s]+/, '')
    .replace(/^(群号|群号码|号码|号)\s*(是|为|:)?\s*/i, '')
    .replace(/^(是|为)\s*/, '')
    .replace(/^[@＠]\s*/, '')
    .replace(/[。，,；;、\s]+$/, '')
    .trim()
}

/**
 * 用自然语言描述一个群体的账号，解析成 `{platform, nativeId}`。
 *
 * 为什么不做平台下拉：下拉等于把"有哪些平台"写死在界面上，而模块是可扩展的。
 * 这里只做一件事——从一句人话里认出"哪个平台 + 哪个号"，认不出就明确拒绝。
 *
 * 接受的写法（示例）：
 *   · QQ群 123456789 / QQ 群号是 123456789
 *   · 贴吧 原神吧 / tieba:原神吧
 *   · 微信群 abc123@chatroom
 *   · discord: 987654321098765432
 *   · 电报 https://t.me/somegroup（未知平台就原样记成 platform='telegram' 之外的值也照收）
 *
 * @returns {{ok:true, platform:string, nativeId:string} | {ok:false, reason:string}}
 */
export function parseGroupAccountText(text) {
  const raw = String(text ?? '').trim()
  if (!raw) return { ok: false, reason: '先写清是哪个平台、哪个号，例如「QQ群 123456789」或「贴吧 原神吧」' }

  // ① "平台:号码"（中英文冒号都认），平台可以是任何词
  const colon = /^([^:：\s]{1,20})\s*[:：]\s*(.+)$/.exec(raw)
  if (colon) {
    const platform = platformOfWord(colon[1])
    const nativeId = cleanNative(colon[2])
    if (nativeId) return { ok: true, platform, nativeId }
  }

  // ② "平台 + 号码/名字"（空格或直接连着）
  const lead = /^([A-Za-z\u4e00-\u9fa5]{1,12})\s*(.*)$/.exec(raw)
  if (lead) {
    const platform = platformOfWord(lead[1])
    // 认出来的平台才继续；否则这句可能是"原神吧 123"这种没有平台的话
    const known = PLATFORM_WORDS.some(([re]) => re.test(lead[1]))
    if (known) {
      const nativeId = cleanNative(lead[2])
      if (nativeId) return { ok: true, platform, nativeId }
      return { ok: false, reason: `认出了平台「${lead[1]}」，但没看到号码/名字` }
    }
  }

  // ③ 只有号码没有平台：不猜（QQ 号 / 微信群 id / Discord id 长得都不一样）
  if (/^\d{4,}$/.test(raw)) {
    return { ok: false, reason: '只有号码不够：这是哪个平台的号？写成「QQ群 123456789」这样' }
  }

  return {
    ok: false,
    reason: `没认出平台与号码：${raw}。写成「QQ群 123456789」「贴吧 原神吧」或「平台:号码」`,
  }
}

/**
 * 新建群体：必须说清是哪个平台的哪个号（否则它对应不到任何真实地方）。
 *
 * `accountText` 是给人用的自然语言入口；`platform`/`nativeId` 留给程序调用（CLI、测试）。
 * 建完顺手写名字与描述。
 */
export function createGroupWithCard(root, pid, { name, accountText, platform, nativeId, feature = '' } = {}) {
  const title = String(name ?? '').trim()
  if (!title) throw new Error('名字不能为空')

  let p = String(platform ?? '').trim()
  let nid = String(nativeId ?? '').trim()
  if (accountText !== undefined && accountText !== null && String(accountText).trim()) {
    const parsed = parseGroupAccountText(accountText)
    if (!parsed.ok) throw new Error(parsed.reason)
    p = parsed.platform
    nid = parsed.nativeId
  }
  if (!p) throw new Error('平台不能为空：写成「QQ群 123456789」或「贴吧 原神吧」')
  if (!nid) throw new Error('群号 / 吧名不能为空，否则这个群体对应不到任何地方')

  const gid = ensureGroupScene(root, { platform: p, nativeId: nid })
  const existsAlready = Boolean(readJson(path.join(root, groupRel(pid, gid)), null))
  if (existsAlready) throw new Error(`这个群体已经有卡了：${gid}（${p}:${nid}）`)
  return writeGroup(
    root,
    pid,
    gid,
    { name: title, feature: String(feature ?? ''), weight: 50, weightSeed: 50 },
    { reason: '新建群体' },
  )
}

// ── 注入用的检索 ────────────────────────────────────────────────────────

/**
 * 这一轮该带哪些群体。
 *
 * 规则（Q3 的答案）：**当前频道对应的那个群体**一定带；另外，如果这一轮的文本里
 * 提到了别的群体名字，也带上——"群里聊到另一个群"是真实会发生的事。
 *
 * @returns {Array<object>} 群体档案（最多 3 个：当前 + 2 个被提到的）
 */
export function groupsForContext(root, pid, { channel = null, text = '', limit = 3 } = {}) {
  const picked = []
  const seen = new Set()

  const gid = channel ? gidForChannel(root, channel) : null
  if (gid) {
    const g = readGroup(root, pid, gid)
    if (g) {
      picked.push(g)
      seen.add(g.gid)
    }
  }

  const hay = String(text ?? '')
  if (hay) {
    // 名字命中（唯一）走原来的路；**昵称**走 aliases.js（撞车就跳过，宁可少给一个群）
    for (const g of listGroups(root, pid)) {
      if (seen.has(g.gid)) continue
      if (!mentionsGroup(hay, g)) continue
      picked.push(g)
      seen.add(g.gid)
      if (picked.length >= limit) break
    }
    if (picked.length < limit) {
      for (const gid of mentionedGroups(root, pid, { text: hay, exclude: [...seen], limit: limit - picked.length })) {
        const g = readGroup(root, pid, gid)
        if (!g) continue
        picked.push(g)
        seen.add(gid)
        if (picked.length >= limit) break
      }
    }
  }

  return picked.slice(0, limit)
}

function mentionsGroup(text, g) {
  const name = String(g?.name ?? '').trim()
  return name.length >= 2 && text.includes(name)
}

/**
 * 一个群体在注入里长什么样。
 *
 * 自然语言为主：**不写字段名**，只把人写的那几句连起来，让她读到的是"一群人什么样"，
 * 而不是一张表。成员只报几个名字——全列出来会把预算吃光，而且"群里都有谁"她随时能查。
 *
 * @returns {string|null} 超预算或没有内容时返回 null（不塞空壳）
 */
export function groupCardLine(root, pid, g, { budgetBytes = 240, maxNames = 4 } = {}) {
  if (!g) return null
  const bits = []
  const head = g.name ? `${g.name}（${g.gid}）` : g.gid
  bits.push(head)
  if (g.feature) bits.push(g.feature)

  const names = mentionableNames(root, pid, g.members ?? []).slice(0, maxNames)
  if (names.length) bits.push(`常出现的人：${names.join('、')}`)

  let s = bits.join(' · ')
  while (byteLen(s) > budgetBytes && s.length > 8) s = s.slice(0, -1)
  return s.trim() ? `[群体] ${s}` : null
}

/** 成员 uid → 显示名（认不出的跳过，绝不拿 uid 当名字给人看）。 */
function mentionableNames(root, pid, uids) {
  const data = readIdentitiesSafe(root)
  const people = data?.people ?? {}
  const out = []
  for (const uid of uids) {
    const person = people[uid]
    if (!person) continue
    const prof = readProfileSafe(root, pid, uid)
    const name = String(prof?.display || person.display || '').trim()
    if (name) out.push(name)
  }
  return out
}

function readProfileSafe(root, pid, uid) {
  const p = path.join(root, P.personas, pid, 'entities', 'people', `${String(uid).replace(/[\\/:*?"<>|]/g, '_')}.json`)
  if (!exists(p)) return null
  try {
    return readJson(p, null)
  } catch {
    return null
  }
}

function byteLen(s) {
  return Buffer.byteLength(String(s), 'utf8')
}

// ── 一次性迁移：老编号（qq:123456）→ grp_xxx ────────────────────────────
//
// 2026-11-09 之后群体编号是纯内部编号。这之前建的群体，文件名和 gid 都是
// `平台:原生号`。迁移做三件事：登记身份、换卡文件名、把规则覆盖文件跟着改名。
//
// 幂等：已经是 grp_ 的直接跳过。

/** 从一个老卡/老 gid 里推断 (平台, 原生号)。 */
function legacyIdentityOf(raw, gid) {
  const platform = String(raw?.platform ?? '').trim()
  const nativeId = String(raw?.nativeId ?? raw?.id ?? '').trim()
  if (platform && nativeId) return { platform, nativeId }
  const s = String(gid ?? raw?.gid ?? '')
  const i = s.indexOf(':')
  if (i < 0) return null
  return { platform: s.slice(0, i), nativeId: s.slice(i + 1) }
}

/**
 * 把所有人格里的老群体编号迁成 `grp_xxx`。
 *
 * @returns {{migrated:Array, skipped:Array, rules:Array}}
 */
export function migrateGroupIds(root) {
  const out = { migrated: [], skipped: [], rules: [] }
  const base = path.join(root, P.personas)
  if (!isDir(base)) return out

  for (const pid of fs.readdirSync(base)) {
    if (!/^[a-z0-9][a-z0-9_-]{1,31}$/.test(pid)) continue
    const dir = path.join(base, pid, 'entities', 'groups')
    if (isDir(dir)) {
      for (const name of fs.readdirSync(dir).filter((n) => n.endsWith('.json'))) {
        const abs = path.join(dir, name)
        const raw = readJson(abs, null)
        const oldGid = String(raw?.gid ?? name.replace(/\.json$/, ''))
        if (/^grp_/.test(oldGid)) {
          out.skipped.push({ pid, gid: oldGid, why: 'already-internal' })
          continue
        }
        const idn = legacyIdentityOf(raw, oldGid)
        if (!idn) {
          out.skipped.push({ pid, gid: oldGid, why: 'no-identity' })
          continue
        }
        const gid = ensureGroupScene(root, { platform: idn.platform, nativeId: idn.nativeId })
        const target = path.join(root, groupRel(pid, gid))
        if (exists(target)) {
          // 已经迁过（例如两个人格先后迁移）：老文件只是残留，删掉即可
          fs.unlinkSync(abs)
          out.skipped.push({ pid, gid: oldGid, why: 'target-exists' })
          continue
        }
        writeGroup(root, pid, gid, {
          name: raw?.name,
          feature: raw?.feature,
          members: raw?.members,
          memberCount: raw?.memberCount,
          weight: raw?.weight,
          weightSource: raw?.weight_source,
          tier: raw?.tier,
          firstSeen: raw?.first_seen,
          lastSeen: raw?.last_seen,
          __reason: `迁移群体编号：${oldGid} → ${gid}`,
        }, { actor: 'system:migration', reason: `迁移群体编号：${oldGid} → ${gid}`, skipNameCheck: true })
        fs.unlinkSync(abs)
        out.migrated.push({ pid, from: oldGid, to: gid, platform: idn.platform, nativeId: idn.nativeId })
      }
    }

    // 规则覆盖文件：group-<老键>.json → group-<gid>.json
    const rulesDir = path.join(base, pid, 'rules', 'qq')
    if (isDir(rulesDir)) {
      for (const name of fs.readdirSync(rulesDir).filter((n) => /^group-.*\.json$/.test(n))) {
        const oldKey = name.replace(/^group-/, '').replace(/\.json$/, '')
        // 老键可能是 `qq_123456`（编码过的 平台:号）或 `123456`（只有号）
        const platform = oldKey.includes('_') ? oldKey.split('_')[0] : null
        const nativeId = oldKey.includes('_') ? oldKey.split('_').slice(1).join('_') : oldKey
        const gid = platform
          ? ensureGroupScene(root, { platform, nativeId })
          : ensureGroupScene(root, { platform: 'qq', nativeId })
        const target = path.join(rulesDir, `group-${gid}.json`)
        if (exists(target)) continue
        fs.renameSync(path.join(rulesDir, name), target)
        out.rules.push({ pid, from: name, to: `group-${gid}.json` })
      }
    }
  }
  return out
}
