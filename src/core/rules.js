// src/core/rules.js —— 规则层：三级继承 + deny 优先 + 每次拒绝留痕。
//
// 层级（越具体越高）：
//   personas/<p>/rules/private-<uid>.json   30
//   personas/<p>/rules/qq/group-<gid>.json  20
//   personas/<p>/rules/global.json          10
//   guardrails.json（根级）                 ∞   ← 不参与合并，单独硬拦
//   rules/ingest.json（根级）               ingest 维度唯一来源（raw 共享）
//
// 硬边界：规则只管进出口，永不直接改记忆内容。
import path from 'node:path'
import fs from 'node:fs'
import { exists, readJson, appendLine, localIso } from './fsx.js'
import { P } from './paths.js'
import { parseChannel } from './entities.js'

export const LEVELS = { global: 10, group: 20, private: 30 }

export function rulePaths(root, pid) {
  return {
    global: `${P.personas}/${pid}/rules/global.json`,
    groupDir: `${P.personas}/${pid}/rules/qq`,
    privateDir: `${P.personas}/${pid}/rules`,
    guardrails: P.guardrails,
    ingest: P.ingestRules,
  }
}

/** 按 channel 推这条会话该叠哪几层。 */
export function ruleChain(root, pid, { channel = null } = {}) {
  const p = rulePaths(root, pid)
  const chain = [p.global]
  const { kind, id } = parseChannel(channel)
  if (kind === 'group' && id) chain.push(`${p.groupDir}/group-${id}.json`)
  if (kind === 'private' && id) chain.push(`${p.privateDir}/private-${id}.json`)
  return chain
}

function deepMerge(a, b) {
  const out = { ...a }
  for (const [k, v] of Object.entries(b)) {
    if (v && typeof v === 'object' && !Array.isArray(v) && a[k] && typeof a[k] === 'object' && !Array.isArray(a[k])) {
      out[k] = deepMerge(a[k], v)
    } else {
      out[k] = v
    }
  }
  return out
}

const META_KEYS = new Set(['_comment', 'inherit', 'override_deny', 'schema'])

/**
 * 合并一层。
 * - 普通字段：深合并（数组整体替换）
 * - deny / allow：**取并集**（下层不许悄悄放宽上层）
 * - override_deny:true：只放开本层 allow 里显式列出的那几条
 */
function mergeLayer(acc, layer) {
  const next = { ...acc }
  for (const [k, v] of Object.entries(layer)) {
    if (META_KEYS.has(k)) continue
    if (k === 'deny' || k === 'allow') continue
    next[k] =
      v && typeof v === 'object' && !Array.isArray(v) ? deepMerge(acc[k] ?? {}, v) : v
  }
  next.deny = [...new Set([...(acc.deny ?? []), ...(layer.deny ?? [])])]
  next.allow = [...new Set([...(acc.allow ?? []), ...(layer.allow ?? [])])]
  if (layer.override_deny === true) {
    next.deny = next.deny.filter((d) => !(layer.allow ?? []).includes(d))
  }
  return next
}

const DEFAULTS = {
  schema: 1,
  recall: { max_inject: 800, hidden_kinds: [], min_importance: 0 },
  action: { proactive: 'on', quiet_hours: [], max_per_hour: 3, max_per_day: 20, per_target: true, group_proactive: false },
  persona: { evolve: true, auto_adopt: true, weekly_auto_limit: 1, rollback_days: 7 },
  deny: [],
  allow: [],
}

/**
 * 算出这条会话的有效规则。
 * @returns {{rules:object, sources:string[], channel:string|null, missing:string[]}}
 */
export function loadEffectiveRules(root, pid, { channel = null } = {}) {
  const chain = ruleChain(root, pid, { channel })
  const sources = []
  const missing = []
  let rules = JSON.parse(JSON.stringify(DEFAULTS))

  for (const rel of chain) {
    const abs = path.join(root, rel)
    if (!exists(abs)) {
      missing.push(rel)
      continue
    }
    const layer = readJson(abs, null)
    if (!layer || typeof layer !== 'object') continue
    rules = mergeLayer(rules, layer)
    sources.push(rel)
  }
  return { rules, sources, channel, missing }
}

// ── 时间窗 ──────────────────────────────────────────────────────────────

function minutesOf(hhmm) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(hhmm).trim())
  if (!m) return null
  return Number(m[1]) * 60 + Number(m[2])
}

/** "01:00-08:00" 是否覆盖当前时刻（支持跨零点）。 */
export function inQuietHours(quietHours, now = Date.now()) {
  if (!Array.isArray(quietHours) || !quietHours.length) return false
  const d = new Date(now)
  const t = d.getHours() * 60 + d.getMinutes()
  for (const range of quietHours) {
    const m = /^(.+?)-(.+)$/.exec(String(range).trim())
    if (!m) continue
    const a = minutesOf(m[1])
    const b = minutesOf(m[2])
    if (a === null || b === null) continue
    if (a === b) continue
    if (a < b) {
      if (t >= a && t < b) return true
    } else if (t >= a || t < b) {
      return true // 跨零点
    }
  }
  return false
}

// ── 判定 ────────────────────────────────────────────────────────────────

function denied(rules, action) {
  return Array.isArray(rules.deny) && rules.deny.includes(action)
}

/**
 * 能不能做某个动作。
 * @returns {{allowed:boolean, reason?:string}}
 */
export function checkAction(rules, action, { channel = null, now = Date.now() } = {}) {
  if (denied(rules, action)) return { allowed: false, reason: `deny: ${action}` }

  if (action === 'proactive') {
    if (rules.action?.proactive === 'off') return { allowed: false, reason: 'proactive=off' }
    const { kind } = parseChannel(channel)
    if (kind === 'group' && rules.action?.group_proactive === false) {
      return { allowed: false, reason: 'group_proactive=false' }
    }
    if (inQuietHours(rules.action?.quiet_hours, now)) {
      return { allowed: false, reason: 'quiet_hours' }
    }
  }
  return { allowed: true }
}

/** 一条事实够不够格进注入。 */
export function checkRecall(rules, fact) {
  const min = Number(rules.recall?.min_importance ?? 0)
  const imp = Number(fact?.imp ?? 0)
  if (imp < min) return { allowed: false, reason: `importance ${imp} < ${min}` }
  return { allowed: true }
}

/** 这个事实类型是否被禁止进注入。 */
export function checkRecallKind(rules, kind) {
  const hidden = rules.recall?.hidden_kinds ?? []
  if (hidden.includes(kind)) return { allowed: false, reason: `hidden_kind: ${kind}` }
  return { allowed: true }
}

// ── 入库（全局）─────────────────────────────────────────────────────────

export function loadGuardrails(root) {
  return readJson(path.join(root, P.guardrails), null) ?? { never_record: [], never_inject: [], never_do: [] }
}

/**
 * 入库前判定：guardrails 的 never_record 是硬线，规则关不掉。
 * skip_channels / soft_blacklist 仍由 redact.applyIngestPolicy 负责。
 */
export function canIngest(root, channel, text) {
  const g = loadGuardrails(root)
  const never = Array.isArray(g.never_record) ? g.never_record : []
  const t = String(text ?? '')
  for (const kw of never) {
    if (kw && t.includes(kw)) return { ok: false, reason: `guardrails.never_record: ${kw}` }
  }
  return { ok: true }
}

/** 注入前判定：never_inject 命中就整条不进上下文（但可以留在 raw 里）。 */
export function canInject(root, text) {
  const g = loadGuardrails(root)
  const never = Array.isArray(g.never_inject) ? g.never_inject : []
  const t = String(text ?? '')
  for (const kw of never) {
    if (kw && t.includes(kw)) return { ok: false, reason: `guardrails.never_inject: ${kw}` }
  }
  return { ok: true }
}

// ── 拒绝留痕 ────────────────────────────────────────────────────────────

/** 每一次拒绝都要留下理由，否则"她为什么没回我"永远查不出来。 */
export function logRefusal(root, pid, { dim, action, channel = null, reason = '' } = {}) {
  appendLine(path.join(root, P.changes), {
    ts: localIso(),
    kind: 'rule_refusal',
    persona: pid,
    dim,
    action,
    channel,
    reason,
  })
}

/** 读最近 N 条拒绝记录。 */
export function recentRefusals(root, { limit = 20 } = {}) {
  const p = path.join(root, P.changes)
  if (!exists(p)) return []
  const out = []
  for (const line of fs.readFileSync(p, 'utf8').split('\n')) {
    if (!line.trim()) continue
    try {
      const r = JSON.parse(line)
      if (r.kind === 'rule_refusal') out.push(r)
    } catch {
      /* 坏行 */
    }
  }
  return out.slice(-limit).reverse()
}
