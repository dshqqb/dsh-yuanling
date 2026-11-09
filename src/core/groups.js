// src/core/groups.js —— 群体实体：她身处的"一群人"。
//
// 和人物（entities.js）刻意不同：
//   · **人物可以跨平台合并**（一个 QQ 号和一个 B站号可能是同一个人）；
//   · **群体不能**。一个 QQ 群永远不等于一个贴吧，它们只是"同一种位置"上的两个实体。
//     所以 gid 就是 `platform:id` 本身，没有"把这个群和那个群并起来"的操作，也不需要
//     "一个群体对应多个频道"的映射表——用 platform 前缀只是为了将来接别的 app 时能扩展。
//
// 存储沿用 `personas/<pid>/entities/groups/<gid>.json`（原来那个[name/intro/tone]的半成品
// 会在这里被升级）。字段尽量少：身份三件（gid/platform/name）固定，其余**用自然语言写**，
// 由模型或人描述。固定字段一多，模型就只会填空，写不出"这群人什么味儿"。
import fs from 'node:fs'
import path from 'node:path'

import { exists, isDir, localIso, readJson } from './fsx.js'
import { P } from './paths.js'
import { writeTracked } from './version.js'

/** 频道 kind → 平台名。群里说话就是 QQ，贴吧就是贴吧——这个映射写死在核心，不让模块乱报。 */
export const CHANNEL_PLATFORM = {
  group: 'qq',
  private: 'qq',
  wechat: 'wechat',
  wx: 'wechat',
  tieba: 'tieba',
  bili: 'bili',
  discord: 'discord',
  telegram: 'telegram',
}

/**
 * **哪些频道 kind 才算"一个地方"**。
 *
 * 只有这里面的 kind 才会变成群体。白名单而不是黑名单：`module:bili.search_video`
 * 这种频道说的是"一次调用"，`bili:video:BV1` 说的是"一个视频"，它们都不是"一群人"。
 * 黑名单会把将来新出现的 kind 默认为群体，那正是假群体的来源。
 */
export const GROUP_KINDS = new Set(['group', 'tieba', 'wechat', 'wx', 'discord', 'telegram'])

/** 一个群体最多记多少人（成员是"素材"，不是通讯录）。 */
export const MAX_MEMBERS = 60
/** 成员扫描看最近几天。 */
export const MEMBER_SCAN_DAYS = 30

/** 群体文件（人格内，按 gid）。文件名要能容忍 `贴吧:原神吧` 这种非 ASCII 与冒号。 */
export function groupRel(pid, gid) {
  return `${P.personas}/${pid}/entities/groups/${String(gid).replace(/[\\/:*?"<>|]/g, '_')}.json`
}

/**
 * 频道 → 群体 gid。
 *   `group:12345` → `qq:12345`
 *   `tieba:原神吧` → `tieba:原神吧`
 * 私聊不是群体，返回 null（她的"一群人"里不该出现一对一对话）。
 */
export function gidForChannel(channel) {
  const s = String(channel ?? '').trim()
  const i = s.indexOf(':')
  if (i < 0) return null
  const kind = s.slice(0, i)
  const id = s.slice(i + 1)
  if (!id) return null
  // 私聊是一对一，不是群体；module:/dsh:/bili:video: 这些也不是"一个地方"
  if (!GROUP_KINDS.has(kind)) return null
  const platform = CHANNEL_PLATFORM[kind] ?? kind
  // 贴吧这类，频道本身就是 `平台:对象`，「吧名」直接当 id
  return `${platform}:${id}`
}

/** gid → 原始层里的频道名（QQ 群是 `group:id`，其余平台就是 `平台:id`）。 */
export function channelOfGid(gid) {
  const { platform, id } = parseGid(gid)
  return platform === 'qq' ? `group:${id}` : `${platform}:${id}`
}

/** gid → { platform, id }。 */
export function parseGid(gid) {
  const s = String(gid ?? '')
  const i = s.indexOf(':')
  if (i < 0) return { platform: 'unknown', id: s }
  return { platform: s.slice(0, i), id: s.slice(i + 1) }
}

/** 读一个群体档案；没有就返回 null（**不自动建**：没见过的群不该凭空出现）。 */
export function readGroup(root, pid, gid) {
  const rel = groupRel(pid, gid)
  const cur = readJson(path.join(root, rel), null)
  if (!cur) return null
  return normalizeGroup(cur, gid)
}

/**
 * 老版本的文件（[name/intro/tone/topics]）在这里被认出来并升级：
 * intro/tone 折进 `feature`，topics 数组折进自然语言 `topics`。
 * 不丢内容——用户手写的字也算她的记忆。
 */
export function normalizeGroup(raw, gid) {
  const { platform, id } = parseGid(gid ?? raw?.gid)
  if (raw?.feature === undefined && (raw?.intro || raw?.tone)) {
    const bits = []
    if (raw.intro) bits.push(String(raw.intro))
    if (raw.tone) bits.push(`说话语气：${raw.tone}`)
    raw.feature = bits.join('；')
  }
  if (raw?.topics === undefined || Array.isArray(raw?.topics)) {
    const arr = Array.isArray(raw?.topics) ? raw.topics : []
    raw.topics = arr.length ? `主要在聊：${arr.join('、')}` : ''
  }
  return {
    gid: gid ?? raw.gid,
    platform,
    id,
    name: String(raw?.name ?? ''),
    aliases: Array.isArray(raw?.aliases) ? raw.aliases.map(String) : [],
    feature: String(raw?.feature ?? ''),
    topics: String(raw?.topics ?? ''),
    members: Array.isArray(raw?.members) ? raw.members.map(String) : [],
    memberCount: Number(raw?.memberCount ?? 0),
    weight: Number(raw?.weight ?? 0),
    weightSource: raw?.weight_source === 'manual' ? 'manual' : 'auto',
    tier: raw?.tier === 'important' ? 'important' : null,
    firstSeen: raw?.first_seen ?? null,
    lastSeen: raw?.last_seen ?? null,
    updatedAt: raw?.updated_at ?? null,
  }
}

/** 写群体档案。走 version.js 的追踪写，可回滚、有变更记录。 */
export function writeGroup(root, pid, gid, patch = {}, { actor = 'system:group', reason = '更新群体档案' } = {}) {
  const rel = groupRel(pid, gid)
  const cur = readGroup(root, pid, gid) ?? normalizeGroup({}, gid)
  const { platform, id } = parseGid(gid)
  const next = {
    gid,
    platform,
    id,
    name: patch.name !== undefined ? String(patch.name) : cur.name,
    aliases: patch.aliases ? patch.aliases.map(String) : cur.aliases,
    feature: patch.feature !== undefined ? String(patch.feature) : cur.feature,
    topics: patch.topics !== undefined ? String(patch.topics) : cur.topics,
    members: patch.members ? patch.members.map(String) : cur.members,
    memberCount: patch.memberCount !== undefined ? Number(patch.memberCount) : cur.memberCount,
    weight: patch.weight !== undefined ? Number(patch.weight) : cur.weight,
    // 注意：这里不能写成"不是 manual 就沿用旧值"——那样 `clearGroupWeight` 永远清不掉。
    // 要区分"没给这个字段"（沿用）和"明确给了 auto"（清掉手改）。
    weight_source:
      patch.weightSource === undefined ? (cur.weightSource === 'manual' ? 'manual' : 'auto') : patch.weightSource === 'manual' ? 'manual' : 'auto',
    tier: patch.tier === undefined ? cur.tier : patch.tier === 'important' ? 'important' : null,
    first_seen: patch.firstSeen ?? cur.firstSeen ?? localIso(),
    last_seen: patch.lastSeen ?? cur.lastSeen,
    updated_at: localIso(),
  }
  writeTracked(root, rel, JSON.stringify(next, null, 2) + '\n', {
    actor,
    reason: patch.__reason ?? reason,
  })
  return normalizeGroup(next, gid)
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
    const cur = normalizeGroup(g, gid)
    out.push({ ...cur, sealedNotes: undefined, weight: liveGroupWeight(root, pid, cur, { now }) })
  }
  return out.sort((a, b) => b.weight - a.weight || String(b.lastSeen ?? '').localeCompare(String(a.lastSeen ?? '')))
}

/** 读一个群体，返回值里带上**实时**权重（详情页 / CLI / MCP 用）。 */
export function readGroupLive(root, pid, gid, { now = Date.now() } = {}) {
  const g = readGroup(root, pid, gid)
  return g ? { ...g, weight: liveGroupWeight(root, pid, g, { now }) } : null
}

/** 实时权重：手改过的用手改值，其余按原始层里的互动现算（不写盘）。 */
export function liveGroupWeight(root, pid, g, { now = Date.now() } = {}) {
  if (!g) return 0
  if (g.weightSource === 'manual') return Number(g.weight ?? 0)
  return computeGroupWeight(channelStats(root, channelOfGid(g.gid), now))
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
export function ensureGroup(root, pid, gid, { name = '', seenAt = null, firstSeen = null } = {}) {
  const cur = readGroup(root, pid, gid)
  if (cur) {
    if (seenAt && shouldAdvance(cur.lastSeen, String(seenAt))) {
      return writeGroup(root, pid, gid, { lastSeen: String(seenAt) }, { reason: '见到这个群体有新动静' })
    }
    return cur
  }
  return writeGroup(
    root,
    pid,
    gid,
    { name: name || '', lastSeen: seenAt, firstSeen: firstSeen ?? localIso() },
    { reason: '第一次见到这个群体' },
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
  const { platform, id } = parseGid(gid)
  // 频道名跟 gid 同源：qq:12345 → group:12345；其它平台直接用平台名做 kind
  const channel = platform === 'qq' ? `group:${id}` : `${platform}:${id}`
  const counts = new Map()
  let scannedDays = 0

  for (const day of listRawDays(root).slice(-days)) {
    scannerDay(root, day, channel, counts)
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
  const p = path.join(root, P.identities)
  if (!exists(p)) return null
  try {
    return readJson(p, null)
  } catch {
    return null
  }
}

function scannerDay(root, day, channel, counts) {
  const dir = path.join(root, P.raw, day.slice(0, 7), day.slice(8, 10))
  if (!isDir(dir)) return
  for (const name of fs.readdirSync(dir).filter((n) => n.endsWith('.ndjson'))) {
    let text = ''
    try {
      text = fs.readFileSync(path.join(dir, name), 'utf8')
    } catch {
      continue
    }
    for (const line of text.split('\n')) {
      if (!line.includes(channel)) continue
      let rec = null
      try {
        rec = JSON.parse(line)
      } catch {
        continue
      }
      if (String(rec?.channel) !== channel) continue
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
  const weight = computeGroupWeight(channelStats(root, channelOfGid(gid), now))
  return writeGroup(root, pid, gid, { weight }, { reason: '按互动自动算权重' })
}

// ── 启动回填 ────────────────────────────────────────────────────────────

/**
 * 扫原始层里出现过的**群频道**（只看 channel/ts，不读正文），把还没建卡的群补上。
 *
 * 幂等：已有的群只把 `lastSeen` 往前推，`firstSeen` 只在第一次建卡时写。
 * 认不出的频道（`module:...`、`bili:video:...`、私聊）一律不建——宁可少一个群，
 * 也不让"一次调用"变成一个"地方"。
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
        const gid = gidForChannel(m[1])
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

function channelStats(root, channel, now) {
  const days = new Set()
  let msgs = 0
  let recent = 0
  const nowMs = Number(now)
  for (const day of listRawDays(root).slice(-30)) {
    const t = channelDayCount(root, day, channel)
    if (!t) continue
    msgs += t
    days.add(day)
    if (nowMs - Date.parse(`${day}T23:59:59`) < 30 * 24 * 3600 * 1000) recent += t
  }
  return { msgs, days: days.size, recent }
}

function channelDayCount(root, day, channel) {
  const dir = path.join(root, P.raw, day.slice(0, 7), day.slice(8, 10))
  if (!isDir(dir)) return 0
  let n = 0
  for (const name of fs.readdirSync(dir).filter((x) => x.endsWith('.ndjson'))) {
    let text = ''
    try {
      text = fs.readFileSync(path.join(dir, name), 'utf8')
    } catch {
      continue
    }
    for (const line of text.split('\n')) {
      if (!line.includes(channel)) continue
      if (line.includes(`"channel":"${channel}"`)) n += 1
    }
  }
  return n
}

/** 重要群体：手动置顶（和人物的 pinned 同一个语义）。 */
export function setGroupTier(root, pid, gid, tier) {
  return writeGroup(root, pid, gid, { tier }, { reason: tier === 'important' ? '提升为重要群体' : '取消重要群体' })
}

/** 手改权重（改过之后自动计分不再覆盖）。 */
export function setGroupWeight(root, pid, gid, weight) {
  return writeGroup(root, pid, gid, { weight, weightSource: 'manual' }, { reason: '手动设置群体权重' })
}

export function clearGroupWeight(root, pid, gid) {
  return writeGroup(root, pid, gid, { weightSource: 'auto' }, { reason: '恢复自动权重' })
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

  const gid = channel ? gidForChannel(channel) : null
  if (gid) {
    const g = readGroup(root, pid, gid)
    if (g) {
      picked.push(g)
      seen.add(g.gid)
    }
  }

  const hay = String(text ?? '')
  if (hay) {
    for (const g of listGroups(root, pid)) {
      if (seen.has(g.gid)) continue
      if (!mentionsGroup(hay, g)) continue
      picked.push(g)
      seen.add(g.gid)
      if (picked.length >= limit) break
    }
  }

  return picked.slice(0, limit)
}

function mentionsGroup(text, g) {
  const needles = [g.name, ...(g.aliases ?? [])].map((s) => String(s ?? '').trim()).filter((s) => s.length >= 2)
  for (const n of needles) if (text.includes(n)) return true
  return false
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
  if (g.topics) bits.push(g.topics)

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
