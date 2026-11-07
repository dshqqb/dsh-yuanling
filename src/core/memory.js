// src/core/memory.js —— L1 记忆层：条目、事实、指针校验、查重、槽位、检索、卡片。
//
// 与文档的一处有意偏差：条目与人物档案用 JSON，不用 Markdown。
// 理由：这些文件是**机器写、机器读**的结构化数据（槽位 / 时效 / 指针 / 重要度），
// 用 md 每次都要整篇重写、还得再写一个解析器；人设骨架（SELF.md / lines.md /
// user.md / style.md）仍然是 Markdown——那是人写的散文。
import fs from 'node:fs'
import path from 'node:path'
import { exists, isDir, readJson, localIso, ulid } from './fsx.js'
import { P } from './paths.js'
import { writeTracked, history } from './version.js'
import { resolvePointer } from './pointer.js'
import { listDays, readDay } from './raw.js'
import { refreshDrives } from './drives.js'
import { readPurposes, writePurposes, minePurposes, selectIntent, expirePurposes, markHit, closePurpose, SELECT_MAX_HITS } from './purposes.js'
import { ensureFirstMet, loadIdentities, parseChannel, personForChannel, readGroup, readProfile } from './entities.js'
import {
  ageDays,
  clarityOf,
  classify,
  emotionalScore,
  recallCounts,
  recordAccess,
  retentionOf,
  shouldMarkOrigin,
  RECENT_WINDOW_DAYS,
} from './retention.js'

export const DEFAULT_SPACE = '日常'
// 1M 上下文下 8KB 只占 0.5%，放得下；但预算的作用是逼出取舍，不是省钱。
export const CARD_BUDGET_BYTES = 8192
export const RECENT_DAYS = 14

// 各段配额：宁少勿滥——一条对的记忆胜过十条平庸的。
export const QUOTA = { first: 3, deep: 6, recent: 10 }
// 单张人物卡的字节上限。人物卡是按对话对象检索的档案，不是全局榜单，所以没有人数配额。
export const PERSON_BUDGET_BYTES = 600
// 一次上下文里最多带几张人物卡（群聊里在说话的那几个人）
export const MAX_PEOPLE_PER_CONTEXT = 8

// ── 路径 ────────────────────────────────────────────────────────────────

/** 文件名安全化：去掉 Windows 非法字符。 */
export function safeName(s) {
  const v = String(s ?? '').trim()
  if (!v) throw new Error('名字不能为空')
  return v.replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').replace(/^\.+/, '').replace(/[. ]+$/, '')
}

export function entryRel(pid, space, topic) {
  return `${P.personas}/${pid}/spaces/${safeName(space)}/entries/${safeName(topic)}.json`
}

export function spacesDir(root, pid) {
  return path.join(root, P.personas, pid, 'spaces')
}

/** 列出所有人格 id（读根标记，不依赖 persona.js，避免循环引用）。 */
export function listPersonaIds(root) {
  const marker = readJson(path.join(root, P.marker), null)
  if (!marker || !Array.isArray(marker.personas)) return []
  return marker.personas.map((p) => p.id).filter((id) => typeof id === 'string')
}

/**
 * 屏蔽级联：把证据指向这些原始记录的**所有人格**的事实都标记/解除标记。
 * 屏蔽是全局的（raw 共享），所以级联也必须跨人格。
 *
 * @returns {Array<{persona:string, topic:string, factId:string}>}
 */
export function setFactsShieldedBySrc(root, targets, on, now = localIso()) {
  const ids = new Set((Array.isArray(targets) ? targets : [targets]).map(String))
  if (!ids.size) return []
  const touched = []

  for (const pid of listPersonaIds(root)) {
    for (const e of listEntries(root, pid)) {
      let changed = false
      for (const f of e.facts) {
        const srcId = String(f.src ?? '').split('#').pop()
        if (!ids.has(srcId)) continue
        if (on && !f.shielded_at) {
          f.shielded_at = now
          changed = true
          touched.push({ persona: pid, topic: e.topic, factId: f.id })
        } else if (!on && f.shielded_at) {
          f.shielded_at = null
          changed = true
          touched.push({ persona: pid, topic: e.topic, factId: f.id })
        }
      }
      if (!changed) continue
      e.updated = now
      writeTracked(root, entryRel(pid, e.space, e.topic), JSON.stringify(e, null, 2) + '\n', {
        actor: 'system:shield',
        reason: on ? '证据被屏蔽，级联隔离' : '证据撤销屏蔽，级联恢复',
      })
    }
  }
  return touched
}

// ── 文本工具 ────────────────────────────────────────────────────────────

const CJK = /[\u4e00-\u9fff]/

export function normalizeText(s) {
  return String(s ?? '')
    .toLowerCase()
    .replace(/[\s，。、；：！？,.;:!?"'“”‘’()（）[\]【】—\-~·]/g, '')
}

export function bigrams(s) {
  const t = normalizeText(s)
  const out = new Set()
  for (let i = 0; i + 2 <= t.length; i += 1) out.add(t.slice(i, i + 2))
  return out
}

function jaccard(a, b) {
  if (!a.size || !b.size) return 0
  let inter = 0
  for (const x of a) if (b.has(x)) inter += 1
  return inter / (a.size + b.size - inter)
}

/** 三档查重（文档 §7.7）。返回命中的事实或 null。 */
export function findDuplicate(facts, text) {
  const n = normalizeText(text)
  if (!n) return null
  const bn = bigrams(text)
  for (const f of facts) {
    const fn = normalizeText(f.text)
    if (!fn) continue
    if (fn === n) return f
    // 短句被长句包含，且长度比 ≥0.45
    const [short, long] = fn.length <= n.length ? [fn, n] : [n, fn]
    if (long.includes(short) && short.length / long.length >= 0.45) return f
    // 两句都够长，且二元组重合度高
    if (fn.length >= 10 && n.length >= 10 && jaccard(bigrams(f.text), bn) >= 0.78) return f
  }
  return null
}

// ── 重要度 ──────────────────────────────────────────────────────────────

const EMOTION_STRONG = /喜欢|想念|舍不得|难过|委屈|哭|心疼|感动|害怕|孤单|抱歉|对不起|谢谢|抱抱|陪伴|永远|最爱|在乎/g
const EMOTION_MEDIUM = /开心|高兴|可爱|温柔|生气|烦|郁闷|害羞|讨厌|累|困|饿|紧张|激动/g
const FIRST_RE = /第一次|初次|头一次|最早|刚认识|纪念日/
const PROMISE_RE = /答应|约定|说好|以后|下次|记得|不要忘|发誓|保证/
const CONFLICT_RE = /吵架|生气|道歉|对不起|和好|误会|冷战|原谅/
const SELF_RE = /我(?:喜欢|讨厌|想要|是|会|在)|我的/

/** 写入时算一次初值（文档 §7.3）。规则表，不调模型。 */
export function scoreImportance(text, { slot = null, evidence = 1 } = {}) {
  const t = String(text ?? '')
  let score = 8
  const strong = (t.match(EMOTION_STRONG) ?? []).length
  const medium = (t.match(EMOTION_MEDIUM) ?? []).length
  score += Math.min(24, strong * 8 + medium * 3 + (t.match(/[!！]/g) ?? []).length)
  if (FIRST_RE.test(t)) score += 30
  if (PROMISE_RE.test(t)) score += 16
  if (CONFLICT_RE.test(t)) score += 14
  if (SELF_RE.test(t)) score += 5
  if (slot) score += 2
  if (evidence >= 2) score += Math.min(10, evidence * 3)
  if (t.length < 6) score -= 12
  return Math.max(1, Math.min(100, Math.round(score)))
}

// ── 条目读写 ────────────────────────────────────────────────────────────

function emptyEntry(topic, space, now) {
  return { topic, space, summary: '', aliases: [], created: now, updated: now, facts: [] }
}

export function readEntry(root, pid, topic, space = DEFAULT_SPACE) {
  return readJson(path.join(root, entryRel(pid, space, topic)), null)
}

export function listEntries(root, pid, space = null) {
  const base = spacesDir(root, pid)
  if (!isDir(base)) return []
  const out = []
  const spaces = space ? [safeName(space)] : fs.readdirSync(base)
  for (const sp of spaces) {
    const dir = path.join(base, sp, 'entries')
    if (!isDir(dir)) continue
    for (const f of fs.readdirSync(dir)) {
      if (!f.endsWith('.json')) continue
      const e = readJson(path.join(dir, f), null)
      if (e && Array.isArray(e.facts)) out.push(e)
    }
  }
  return out
}

/**
 * 写一条事实。
 * 硬规则：指针必须能解析；查重命中不入；同槽位自动关闭旧值。
 *
 * @returns {{added:boolean, reason?:string, fact?:object, closed?:string[], entry?:object}}
 */
export function addFact(
  root,
  pid,
  {
    topic,
    space = DEFAULT_SPACE,
    text,
    slot = null,
    src,
    since = null,
    imp = null,
    tags = [],
    summary = null,
    origin = null,
    person = null,
    kind = 'fact',
    now = localIso(),
  },
) {
  const t = String(text ?? '').trim()
  if (!t) throw new Error('事实内容不能为空')
  if (!src) throw new Error('缺少证据指针 @src（没有指针的事实不写）')

  const check = resolvePointer(root, src)
  if (!check.ok) {
    throw new Error(
      `证据指针无效：${check.reason}（应为 raw/YYYY-MM/DD/qq.ndjson#ULID，可用 \`yuanling last\` 查，或 CLI 传 --src-last 1）`,
    )
  }

  const rel = entryRel(pid, space, topic)
  const entry = readJson(path.join(root, rel), null) ?? emptyEntry(topic, space, now)

  const dup = findDuplicate(entry.facts.filter((f) => !f.until), t)
  if (dup) {
    // 重复表述不是垃圾，是信号：人格演化就靠"同一句话被反复说"。
    // 所以不新增事实，但把次数、最近一次时间、证据都记下来。
    dup.repeat = Number(dup.repeat ?? 1) + 1
    dup.last_seen = now
    dup.srcs = [...new Set([...(dup.srcs ?? (dup.src ? [dup.src] : [])), src])].slice(-20)
    entry.updated = now
    writeTracked(root, rel, JSON.stringify(entry, null, 2) + '\n', {
      actor: 'model:memory_save',
      reason: `重复表述 +1（累计 ${dup.repeat} 次）`,
    })
    return { added: false, reason: 'duplicate', fact: dup, entry, repeated: true }
  }

  const closed = []
  if (slot) {
    const today = now.slice(0, 10)
    for (const f of entry.facts) {
      if (f.slot === slot && !f.until) {
        f.until = today
        closed.push(f.id)
      }
    }
  }

  const factId = 'fact_' + ulid()
  // 「最初」只考虑条目最早的两条事实，并按 id 做确定性抽签。
  // 抽签而不是"前 N 条一律算"——否则新条目会把所有早期事实都标成最初。
  const autoOrigin =
    entry.facts.length < 2 &&
    shouldMarkOrigin({ factId, entryAgeDays: ageDays(entry.created, Date.parse(now) || Date.now()) })

  // 关于某个人的第一条事实：这是"跟 TA 的第一次"，比条目的第一条更重要。
  let personFirst = false
  if (person) {
    const fm = ensureFirstMet(root, pid, person, now)
    personFirst = fm.first
  }

  const fact = {
    id: factId,
    kind,
    slot,
    text: t,
    since: since ?? now.slice(0, 7),
    until: null,
    src,
    person: person ?? null,
    imp: Number.isFinite(imp) ? Math.max(1, Math.min(100, Math.round(imp))) : scoreImportance(t, { slot }),
    emotional: emotionalScore(t),
    origin: origin === null ? (person ? personFirst : autoOrigin) : Boolean(origin),
    tags: Array.isArray(tags) ? tags : [],
    created: now,
    last_seen: now,
    recall: 0,
    supersedes: closed[0] ?? null,
  }

  entry.facts.push(fact)
  entry.updated = now
  // ★ 不要用「第一条事实」自动填摘要。
  // 摘要会被并进检索文本，自动填等于让第一条事实（可能是很快失效的旧值）
  // 永久影响该条目的匹配 —— 实测会让"已失效的事实"借摘要复活。
  if (summary && !entry.summary) entry.summary = String(summary)

  writeTracked(root, rel, JSON.stringify(entry, null, 2) + '\n', {
    actor: 'model:memory_save',
    reason: `+1 fact${slot ? ` [${slot}]` : ''}${closed.length ? `, 关闭 ${closed.length} 条旧值` : ''}`,
  })

  return { added: true, fact, closed, entry }
}

/** 打开条目：active 与 expired 分开，便于"以前是什么样"。 */
export function openEntry(root, pid, topic, space = DEFAULT_SPACE) {
  const entry = readEntry(root, pid, topic, space)
  if (!entry) return null
  return {
    ...entry,
    active: entry.facts.filter((f) => !f.until),
    expired: entry.facts.filter((f) => f.until),
  }
}

// ── 检索 ────────────────────────────────────────────────────────────────

function tokens(s) {
  const out = new Set()
  const t = String(s ?? '').toLowerCase()
  for (const m of t.matchAll(/[a-z0-9_]{2,}/g)) out.add(m[0])
  const cjk = t.replace(/[^\u4e00-\u9fff]/g, '')
  for (let i = 0; i + 2 <= cjk.length; i += 1) out.add(cjk.slice(i, i + 2))
  return out
}

function lexScore(queryTokens, text) {
  if (!queryTokens.size) return 0
  const tt = tokens(text)
  if (!tt.size) return 0
  let hit = 0
  for (const q of queryTokens) if (tt.has(q)) hit += 1
  return hit / queryTokens.size
}

function daysSince(iso, now = Date.now()) {
  const t = Date.parse(iso)
  if (Number.isNaN(t)) return 9999
  return Math.max(0, (now - t) / 86_400_000)
}

/**
 * 认轴检索（P3 只实现"词 + 时间"两轴，其余在 P5/P6 补）。
 * @returns {Array<{topic,space,fact,score,parts}>}
 */
export function recall(
  root,
  pid,
  query,
  {
    space = null,
    limit = 5,
    includeExpired = false,
    includeShielded = false,
    includeGone = false,
    track = true,
    now = Date.now(),
  } = {},
) {
  const entries = listEntries(root, pid, space)
  const qt = tokens(query)
  const counts = recallCounts(root, pid, { now })
  const out = []

  for (const e of entries) {
    for (const f of e.facts) {
      if (f.until && !includeExpired) continue
      if (f.shielded_at && !includeShielded) continue
      const recallN = counts.get(f.id) ?? 0
      const retention = retentionOf(f, { recall: recallN, now })
      if (!includeGone && clarityOf(retention) === 'gone') continue
      const lex = query ? lexScore(qt, `${e.topic} ${e.summary} ${f.text}`) : 0
      const imp = (f.imp ?? 50) / 100
      const rec = Math.max(0, 1 - daysSince(f.created ?? f.last_seen ?? '', now) / 30) * 0.15
      const score = query ? 0.6 * lex + 0.25 * imp + rec : 0.7 * imp + 0.3 * rec
      if (query && lex === 0) continue
      out.push({
        topic: e.topic,
        space: e.space,
        fact: f,
        retention,
        clarity: clarityOf(retention),
        band: classify(f, { recall: recallN, now }),
        score: Number(score.toFixed(4)),
        parts: { lex, imp },
      })
    }
  }

  out.sort((a, b) => b.score - a.score)
  const hits = out.slice(0, Math.max(1, limit))
  if (track && hits.length) recordAccess(root, pid, hits.map((h) => h.fact.id), query)
  return hits
}

/** 按 id 找一条事实（跨主题、跨空间）。 */
export function findFact(root, pid, factId) {
  for (const e of listEntries(root, pid)) {
    const f = e.facts.find((x) => x.id === factId)
    if (f) return { topic: e.topic, space: e.space, entry: e, fact: f }
  }
  return null
}

/**
 * 「凭什么记得这个」：事实 → 指针 → 原始记录；再叠加该条目的变更史。
 */
export function why(root, pid, factId) {
  const hit = findFact(root, pid, factId)
  if (!hit) return null
  const { fact, entry } = hit
  const ptr = resolvePointer(root, fact.src)
  return {
    topic: hit.topic,
    space: hit.space,
    fact,
    shielded: Boolean(fact.shielded_at),
    src: { pointer: fact.src, ok: ptr.ok, kind: ptr.kind ?? null, reason: ptr.reason ?? null },
    history: history(root, entryRel(pid, hit.space, hit.topic)),
  }
}

// ── 卡片 ────────────────────────────────────────────────────────────────

/**
 * 从 SELF.md 抽「骨架」。
 *
 * 只有三段进上下文（其余段落是人看的）：
 *   核心身份 → 名字 + 存在的原因
 *   说话方式 → 三行（语气 / 口癖 / 不做的表达）
 *   价值观   → 按优先级排的条目
 *
 * 为什么要把「说话方式」也注入：语气是最直接影响输出的东西，不进去等于白写。
 * 为什么不全篇注入：骨架会抢记忆的预算，「最初 3 条」是更硬的底线。
 */
export const SKELETON_BYTES = { core: 120, speak: 200, values: 160 }

/** 按 `## 标题` 切段，返回 { 标题: 正文 }。 */
function splitSections(text) {
  const out = {}
  let title = ''
  let buf = []
  const flush = () => {
    if (title) out[title] = buf.join('\n')
  }
  for (const line of String(text ?? '').split('\n')) {
    const m = /^##\s+(.+?)\s*$/.exec(line)
    if (m) {
      flush()
      title = m[1]
      buf = []
      continue
    }
    if (title) buf.push(line)
  }
  flush()
  return out
}

function clipBytes(s, maxBytes) {
  let t = String(s ?? '').trim()
  while (Buffer.byteLength(t, 'utf8') > maxBytes) t = t.slice(0, -1)
  return t
}

/** 列表项（`- 标签：值`）。值本身是 `<…>` 占位符时整条跳过。 */
function bullets(section) {
  const out = []
  for (const line of String(section ?? '').split('\n')) {
    const m = /^\s*-\s+(.+)$/.exec(line)
    if (!m) continue
    const raw = m[1].trim()
    if (!raw) continue
    // 值部分才是占位符（`- 语气：<例：短句…>`）时，这条不算内容
    const value = raw.replace(/^.*?[:：]\s*/, '')
    if (/^<.*>$/.test(raw) || /^<.*>$/.test(value)) continue
    out.push(raw)
  }
  return out
}

/** 价值观：`1. xxx` 的条目。 */
function numbered(section) {
  const out = []
  for (const line of String(section ?? '').split('\n')) {
    const m = /^\s*\d+\s*[.、]\s*(.+)$/.exec(line)
    if (!m) continue
    const raw = m[1].trim()
    if (!raw || /^<.*>$/.test(raw)) continue
    out.push(raw)
  }
  return out
}

/** 返回若干净的行（不含标签前缀），由 buildCard 逐行加标签。 */
function identityLines(root, pid) {
  const p = path.join(root, P.personas, pid, 'persona', 'SELF.md')
  if (!exists(p)) return []

  const text = fs.readFileSync(p, 'utf8')
  const sections = splitSections(text)
  const coreSection = sections['核心身份'] ?? ''
  const speakSection = Object.entries(sections).find(([k]) => k.startsWith('说话方式'))?.[1] ?? ''
  const valueSection = Object.entries(sections).find(([k]) => k.startsWith('价值观'))?.[1] ?? ''

  const core = []
  for (const line of coreSection.split('\n')) {
    const m = /^\s*-\s*(名字|存在的原因)\s*[:：]\s*(.+)$/.exec(line)
    if (m && !/^<.*>$/.test(m[2].trim())) core.push(m[2].trim())
  }

  const out = []
  // 每条先去掉自己的句末标点，再统一用「；」连接——否则会出现「。；」
  const clean = (s) => s.replace(/[。；;、]$/, '')

  if (core.length) out.push(`[骨架] ${clipBytes(core.map(clean).join('，'), SKELETON_BYTES.core)}`)

  const speak = bullets(speakSection)
  if (speak.length) out.push(`[说话] ${clipBytes(speak.map(clean).join('；'), SKELETON_BYTES.speak)}`)

  const values = numbered(valueSection)
  if (values.length) out.push(`[在乎] ${clipBytes(values.map(clean).join('；'), SKELETON_BYTES.values)}`)

  if (out.length) return out

  // 兜底：结构不规范的老文件，至少把第一个条目当骨架
  const firstBullet = text.split('\n').find((l) => /^\s*-\s+\S/.test(l))
  return firstBullet ? [`[骨架] ${clipBytes(firstBullet.replace(/^\s*-\s*/, ''), SKELETON_BYTES.core)}`] : []
}

function byteLen(s) {
  return Buffer.byteLength(String(s), 'utf8')
}

/** 读这个人格下所有人物档案。 */
function listPersonProfiles(root, pid) {
  const dir = path.join(root, P.personas, pid, 'entities', 'people')
  if (!exists(dir)) return []
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .map((f) => readJson(path.join(dir, f), null))
    .filter(Boolean)
}

/** 按 (platform, id) 找人。 */
function findIdentityIn(data, platform, id) {
  const p = String(platform)
  const i = String(id)
  for (const [uid, person] of Object.entries(data.people)) {
    const hit = (person.identities ?? []).find((x) => x.platform === p && String(x.id) === i)
    if (hit) return { uid, person }
  }
  return null
}

/**
 * 从一句话里找出被点名的账号。
 * 认两种写法：人类习惯的 `@123456`，和协议端的 `[CQ:at,qq=123456]`。
 * 只有能解析到已知人物时才生效，所以宁可放宽——认错一个陌生 id 只是不产生卡。
 */
function mentionedIds(text) {
  const s = String(text ?? '')
  const out = []
  for (const m of s.matchAll(/@(\d{2,})/g)) out.push(m[1])
  for (const m of s.matchAll(/\[CQ:at,qq=(\d+)\]/g)) out.push(m[1])
  return out
}

/** 某频道最近的消息（按时间倒序）。只用来判断"这一轮谁在场"。 */
function recentChannelRecords(root, channel, limit = 40) {
  const out = []
  for (const date of listDays(root).slice(-3).reverse()) {
    for (const r of readDay(root, date)) {
      if ((r.type ?? 'message') !== 'message') continue
      if (String(r.channel ?? '') !== String(channel)) continue
      out.push(r)
    }
    if (out.length >= limit * 2) break
  }
  out.sort((a, b) => String(b.ts).localeCompare(String(a.ts)))
  return out.slice(0, limit)
}

/**
 * 这一轮谁在场——人物卡是按**在场者**取的，不是按权重榜取的。
 *   私聊：只有对方
 *   群聊：被 @ 的人优先（这话冲谁去的），然后是最近发言人
 *
 * 权重不参与这里的判断。权重只影响管理台的列表顺序。
 */
export function resolveParticipants(
  root,
  pid,
  { channel = null, participants = null, maxPeople = MAX_PEOPLE_PER_CONTEXT } = {},
) {
  const data = loadIdentities(root)
  const uids = []
  const push = (uid) => {
    if (uid && !uids.includes(uid)) uids.push(uid)
  }

  // ① 调用方显式给出的（适配器可以传 uid，或 {platform,id}）
  for (const item of participants ?? []) {
    if (!item) continue
    if (typeof item === 'string') {
      if (item.startsWith('person_')) push(item)
    } else if (item.platform && item.id) {
      push(findIdentityIn(data, item.platform, item.id)?.uid)
    } else if (item.uid) {
      push(item.uid)
    }
  }

  if (channel) {
    const { kind } = parseChannel(channel)
    if (kind === 'private') push(personForChannel(root, channel))

    if (kind === 'group') {
      const recs = recentChannelRecords(root, channel, 40)
      // 被 @ 的人优先：一句话冲谁去，谁就该有卡
      for (const r of recs) {
        for (const id of mentionedIds(r.text)) {
          push(findIdentityIn(data, 'qq', id)?.uid)
        }
      }
      // 然后是发言人，按最近发言时间
      for (const r of recs) {
        if (r.role === 'bot') continue
        push(findIdentityIn(data, 'qq', r.actor?.id)?.uid)
      }
    }
  }

  return uids
    .map((uid) => ({ uid, person: data.people[uid], profile: readProfile(root, pid, uid) }))
    .filter((x) => x.profile) // 她还没认识的人，不硬编
    .slice(0, maxPeople)
}

/** 一张人物卡压缩成一行，硬上限 PERSON_BUDGET_BYTES。 */
function personCardLine({ uid, person, profile }) {
  const display = profile.display || person?.display || uid
  const name = person?.tier === 'admin' ? `★${display}` : display
  const acct = (person?.identities ?? [])[0]
  const head = acct ? `${name}（${acct.platform}:${acct.id}）` : name
  const bits = [head]
  if (profile.sketch) bits.push(String(profile.sketch))
  if (profile.first_met) bits.push(`初识 ${String(profile.first_met).slice(0, 10)}`)

  let s = bits.join(' · ')
  while (byteLen(s) > PERSON_BUDGET_BYTES) s = s.slice(0, -1)
  return `[人物] ${s}`
}

/**
 * 组装"记忆卡"：只含记忆与骨架，**不含人物**。
 * 人物卡是按对话对象检索的，由 contextFor 追加——这样群聊里不会出现不在场的人。
 *
 * 各段按配额混装：最初 3 / 最深刻 6 / 最新 10。
 * 裁剪顺序：最新 → 最深刻，**永不动「最初」**。
 * 注意：预算是**软上限**。当「骨架 + 最初 + 索引」本身就超过预算时，卡片会超出而不是继续裁——
 * 「最初」是不可压缩的底线，宁可超几个字节，也不能把她最早认识你的那几件事挤掉。
 */
export function buildCard(root, pid, { budget = CARD_BUDGET_BYTES, now = Date.now() } = {}) {
  const entries = listEntries(root, pid)
  const counts = recallCounts(root, pid, { now })

  const first = []
  const deep = []
  const recent = []
  let shielded = 0
  let active = 0

  for (const e of entries) {
    for (const f of e.facts) {
      if (f.until) continue
      if (f.shielded_at) {
        shielded += 1
        continue
      }
      active += 1
      const recallN = counts.get(f.id) ?? 0
      const retention = retentionOf(f, { recall: recallN, now })
      if (clarityOf(retention) === 'gone') continue

      const item = { ...f, topic: e.topic, retention, recall: recallN }
      const band = classify(f, { recall: recallN, now })
      if (band === 'first') first.push(item)
      else if (band === 'deep') deep.push(item)
      else if (band === 'recent') recent.push(item)
    }
  }

  const firstPick = first.sort((a, b) => String(a.created).localeCompare(String(b.created))).slice(0, QUOTA.first)
  const deepPick = deep.sort((a, b) => b.retention - a.retention).slice(0, QUOTA.deep)
  const recentPick = recent.sort((a, b) => String(b.created).localeCompare(String(a.created))).slice(0, QUOTA.recent)

  const lines = []
  lines.push(...identityLines(root, pid))
  if (firstPick.length) lines.push('[最初] ' + firstPick.map((f) => `〔${f.topic}〕${f.text}`).join('；'))
  if (deepPick.length) lines.push('[最深刻] ' + deepPick.map((f) => `〔${f.topic}〕${f.text}`).join('；'))
  if (recentPick.length) lines.push('[最新] ' + recentPick.map((f) => `〔${f.topic}〕${f.text}`).join('；'))
  lines.push(`[索引] ${active} 条事实 / ${entries.length} 个主题${shielded ? ` / ${shielded} 条已隔离` : ''}`)

  // 裁：最新 → 最深刻，**永不动「最初」**
  while (byteLen(lines.join('\n')) > budget) {
    const order = ['[最新]', '[最深刻]']
    let removed = false
    for (const tag of order) {
      const i = lines.findIndex((l) => l.startsWith(tag))
      if (i >= 0) {
        lines.splice(i, 1)
        removed = true
        break
      }
    }
    if (!removed) break
  }
  return lines.join('\n')
}

/** 最近一条消息的时间（用来算"多久没和人说话了"）。 */
function lastActivityMs(root) {
  for (const date of listDays(root).slice(-3).reverse()) {
    let max = 0
    for (const r of readDay(root, date)) {
      if ((r.type ?? 'message') !== 'message') continue
      const t = Date.parse(r.ts)
      if (!Number.isNaN(t) && t > max) max = t
    }
    if (max) return max
  }
  return 0
}

/** 一次上下文里最多带几条「惦记」。多了就不是惦记，是汇报。 */
export const PURPOSE_INJECT_LIMIT = 2

/**
 * 动机层：刷新需求 → 从记忆里挖目的 → 取到期的 → 生成一行「惦记」。
 * 任何一步出问题都不该让注入失败，所以整体兜底。
 */
function rememberLine(root, pid, { now = Date.now(), limit = PURPOSE_INJECT_LIMIT } = {}) {
  try {
    const entries = listEntries(root, pid)
    const facts = entries.flatMap((e) => (e.facts ?? []).map((f) => ({ ...f, topic: e.topic })))

    const last = lastActivityMs(root)
    const hoursSinceMaster = last ? Math.max(0, (now - last) / 3_600_000) : null
    const drives = refreshDrives(root, pid, { now, hoursSinceMaster })

    const doc = readPurposes(root, pid)
    const mined = minePurposes(doc, facts, { now })
    const expired = expirePurposes(mined, { now })
    if (mined.added.length || expired) writePurposes(root, pid, mined)

    const { picked, exhausted } = selectIntent(mined.items, drives, { now, limit })

    let dirty = false
    // 提够次数的自动放下：留着只会变成"每次都在追同一件事"
    for (const id of exhausted) {
      const r = closePurpose(mined, id, { now, reason: `提过 ${SELECT_MAX_HITS} 次，先放下` })
      if (r.changed) dirty = true
    }
    if (picked.length && markHit(mined, picked.map((p) => p.id))) dirty = true
    if (dirty) writePurposes(root, pid, mined)

    if (!picked.length) return null
    return `[惦记] ${picked.map((p) => p.text).join('；')}（想提就提，不想提就别提，别硬塞）`
  } catch {
    return null
  }
}

/**
 * 按对话对象组装上下文：卡片 + 对象先验。
 * 人格不变，变的是"这一轮该想起谁"。
 */
export function contextFor(
  root,
  pid,
  {
    channel = null,
    budget = CARD_BUDGET_BYTES,
    now = Date.now(),
    participants = null,
    maxPeople = MAX_PEOPLE_PER_CONTEXT,
  } = {},
) {
  // 人物卡按"谁在场"检索：私聊只有对方，群聊是被 @ 的人和最近发言人
  const people = resolveParticipants(root, pid, { channel, participants, maxPeople })
  const personLines = people.map(personCardLine)
  const peopleBytes = personLines.reduce((n, s) => n + byteLen(s) + 1, 0)

  // 给在场的人留预算，但最多占一半——记忆永远是主体
  const reserve = Math.min(peopleBytes, Math.floor(budget / 2))
  const card = buildCard(root, pid, { budget: Math.max(1024, budget - reserve), now })

  const lines = [card]

  // 「惦记」排在群档案之后、人物卡之前：它是这一轮里最该被"想起来"的一句话
  const remember = rememberLine(root, pid, { now })
  if (remember) lines.push(remember)

  if (channel) {
    const { kind, id } = parseChannel(channel)
    if (kind === 'group') {
      const g = readGroup(root, pid, id)
      if (g) {
        const bits = [g.name || g.gid]
        if (g.intro) bits.push(g.intro)
        if (g.tone) bits.push(g.tone)
        lines.push(`[这个群] ${bits.join(' · ')}`)
      }
    }
  }

  // 一条一条塞人物卡，塞不下的丢排在后面的（越靠后越只是路过）
  const kept = []
  for (const line of personLines) {
    const trial = [...lines, ...kept, line].join('\n')
    if (byteLen(trial) > budget) break
    kept.push(line)
  }

  return [...lines, ...kept].filter(Boolean).join('\n')
}
