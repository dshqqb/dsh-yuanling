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
import { writeTracked } from './version.js'
import { resolvePointer } from './pointer.js'

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
  { topic, space = DEFAULT_SPACE, text, slot = null, src, since = null, imp = null, tags = [], summary = null, now = localIso() },
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

  const fact = {
    id: 'fact_' + ulid(),
    slot,
    text: t,
    since: since ?? now.slice(0, 7),
    until: null,
    src,
    imp: Number.isFinite(imp) ? Math.max(1, Math.min(100, Math.round(imp))) : scoreImportance(t, { slot }),
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
export function recall(root, pid, query, { space = null, limit = 5, includeExpired = false, now = Date.now() } = {}) {
  const entries = listEntries(root, pid, space)
  const qt = tokens(query)
  const out = []

  for (const e of entries) {
    for (const f of e.facts) {
      if (f.until && !includeExpired) continue
      const lex = query ? lexScore(qt, `${e.topic} ${e.summary} ${f.text}`) : 0
      const imp = (f.imp ?? 50) / 100
      const rec = Math.max(0, 1 - daysSince(f.created ?? f.last_seen ?? '', now) / 30) * 0.15
      const score = query ? 0.6 * lex + 0.25 * imp + rec : 0.7 * imp + 0.3 * rec
      if (query && lex === 0) continue
      out.push({ topic: e.topic, space: e.space, fact: f, score: Number(score.toFixed(4)), parts: { lex, imp } })
    }
  }

  out.sort((a, b) => b.score - a.score)
  return out.slice(0, Math.max(1, limit))
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
 * 预算 800 字节；从后往前裁：先砍「最新」，再砍「最深刻」，至死不动「骨架」。
 */
export function buildCard(root, pid, { budget = CARD_BUDGET_BYTES, now = Date.now() } = {}) {
  const entries = listEntries(root, pid)
  const active = []
  for (const e of entries) for (const f of e.facts) if (!f.until) active.push({ ...f, topic: e.topic })

  const peak = [...active].sort((a, b) => (b.imp ?? 0) - (a.imp ?? 0)).slice(0, 3)
  const recent = [...active]
    .filter((f) => daysSince(f.created, now) <= RECENT_DAYS)
    .sort((a, b) => String(b.created).localeCompare(String(a.created)))
    .slice(0, 3)

  const lines = []
  const id = identityLine(root, pid)
  if (id) lines.push(`[骨架] ${id}`)
  if (peak.length) lines.push('[最深刻] ' + peak.map((f) => `〔${f.topic}〕${f.text}`).join('；'))
  if (recent.length) lines.push('[最新] ' + recent.map((f) => `〔${f.topic}〕${f.text}`).join('；'))
  lines.push(`[索引] ${active.length} 条事实 / ${entries.length} 个主题`)

  // 裁：先丢「最新」，再丢「最深刻」
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
