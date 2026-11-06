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
export const CARD_BUDGET_BYTES = 800
export const RECENT_DAYS = 14

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
    now = localIso(),
  },
) {
  const t = String(text ?? '').trim()
  if (!t) throw new Error('事实内容不能为空')
  if (!src) throw new Error('缺少证据指针 @src（没有指针的事实不写）')

  const check = resolvePointer(root, src)
  if (!check.ok) throw new Error(`证据指针无效：${check.reason}`)

  const rel = entryRel(pid, space, topic)
  const entry = readJson(path.join(root, rel), null) ?? emptyEntry(topic, space, now)

  const dup = findDuplicate(entry.facts.filter((f) => !f.until), t)
  if (dup) return { added: false, reason: 'duplicate', fact: dup, entry }

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

function identityLine(root, pid) {
  const p = path.join(root, P.personas, pid, 'persona', 'SELF.md')
  if (!exists(p)) return ''
  const lines = fs.readFileSync(p, 'utf8').split('\n')
  const picks = []
  for (const line of lines) {
    const m = /^\s*-\s*(名字|存在的原因)\s*[:：]\s*(.+)$/.exec(line)
    if (m) picks.push(m[2].trim())
  }
  if (picks.length) return picks.join('，').slice(0, 120)
  const firstBullet = lines.find((l) => /^\s*-\s+\S/.test(l))
  return firstBullet ? firstBullet.replace(/^\s*-\s*/, '').trim().slice(0, 120) : ''
}

function byteLen(s) {
  return Buffer.byteLength(String(s), 'utf8')
}

/**
 * 组装每轮注入的卡片（文档 §12.3）。
 *
 * 三条带各自排序、按配额混装：
 *   最初 2 行（永不衰减、永不淘汰）/ 最深刻 3 行 / 最新 5 行
 * 预算 800 字节，从后往前裁：先砍「最新」，再砍「最深刻」，至死不动「最初」。
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

  const firstPick = first.sort((a, b) => String(a.created).localeCompare(String(b.created))).slice(0, 2)
  const deepPick = deep.sort((a, b) => b.retention - a.retention).slice(0, 3)
  const recentPick = recent.sort((a, b) => String(b.created).localeCompare(String(a.created))).slice(0, 5)

  const lines = []
  const id = identityLine(root, pid)
  if (id) lines.push(`[骨架] ${id}`)
  if (firstPick.length) lines.push('[最初] ' + firstPick.map((f) => `〔${f.topic}〕${f.text}`).join('；'))
  if (deepPick.length) lines.push('[最深刻] ' + deepPick.map((f) => `〔${f.topic}〕${f.text}`).join('；'))
  if (recentPick.length) lines.push('[最新] ' + recentPick.map((f) => `〔${f.topic}〕${f.text}`).join('；'))
  lines.push(`[索引] ${active} 条事实 / ${entries.length} 个主题${shielded ? ` / ${shielded} 条已隔离` : ''}`)

  // 裁：先丢「最新」，再丢「最深刻」，**永不动「最初」**
  while (byteLen(lines.join('\n')) > budget) {
    const i = lines.findIndex((l) => l.startsWith('[最新]'))
    if (i >= 0) {
      lines.splice(i, 1)
      continue
    }
    const j = lines.findIndex((l) => l.startsWith('[最深刻]'))
    if (j >= 0) {
      lines.splice(j, 1)
      continue
    }
    break
  }
  return lines.join('\n')
}

/**
 * 按对话对象组装上下文：卡片 + 对象先验。
 * 人格不变，变的是"这一轮该想起谁"。
 */
export function contextFor(root, pid, { channel = null, budget = CARD_BUDGET_BYTES, now = Date.now() } = {}) {
  const lines = [buildCard(root, pid, { budget, now })]
  if (channel) {
    const { kind, id } = parseChannel(channel)
    if (kind === 'private') {
      const uid = personForChannel(root, channel)
      if (uid) {
        const p = readProfile(root, pid, uid)
        if (p) {
          // 档案里没写显示名时，回到客观映射里取——注入时别显示一串 uid
          const display = p.display || loadIdentities(root).people[uid]?.display || uid
          const bits = [display]
          if (p.sketch) bits.push(p.sketch)
          if (p.first_met) bits.push(`第一次 ${String(p.first_met).slice(0, 10)}`)
          lines.push(`[这个人] ${bits.join(' · ')}`)
        }
      }
    } else if (kind === 'group') {
      const g = readGroup(root, pid, id)
      if (g) {
        const bits = [g.name || g.gid]
        if (g.intro) bits.push(g.intro)
        if (g.tone) bits.push(g.tone)
        lines.push(`[这个群] ${bits.join(' · ')}`)
      }
    }
  }
  return lines.filter(Boolean).join('\n')
}
