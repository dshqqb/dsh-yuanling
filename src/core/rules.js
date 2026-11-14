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
import { appendEvent } from './events.js'
import { writeTracked } from './version.js'
import { resolveChannel } from './channels.js'
import { readGroupIdentity } from './channels.js'

export function rulePaths(root, pid) {
  return {
    global: `${P.personas}/${pid}/rules/global.json`,
    groupDir: `${P.personas}/${pid}/rules/qq`,
    privateDir: `${P.personas}/${pid}/rules`,
    guardrails: P.guardrails,
    ingest: P.ingestRules,
  }
}

/**
 * 按 channel 推这条会话该叠哪几层。
 *
 * 群层的文件名要能装下 gid（`qq:123456`）——Windows 不允许文件名带冒号，所以
 * 冒号一律换成 `_`（`group-qq_123456.json`）。同时**仍然认老文件**（`group-123456.json`）：
 * 群覆盖层是手写的，改名等于让人重新抄一遍。
 */
export function ruleChain(root, pid, { channel = null } = {}) {
  const p = rulePaths(root, pid)
  const chain = [p.global]
  if (!channel) return chain

  // 场景的"键"用内部编号：老写法（private:10001 / group:123555）和新写法
  // 必须叠到同一份覆盖规则，否则换个写法就等于换了一套规矩。
  const c = resolveChannel(root, channel)
  const kind = c.kind
  const id = c.personUid ?? c.gid ?? c.id

  if (kind === 'group' && id) {
    chain.push(`${p.groupDir}/group-${encodeKey(id)}.json`)
    // 老命名（2026-11-09 之前）：`group-<群号>.json` 和 `group-<平台>_<群号>.json`。
    // 群覆盖层是手写的，改名不能让人重新抄一遍，所以这两种也列进来。
    const idn = c.gid ? readGroupIdentity(root, c.gid) : null
    if (idn?.nativeId) {
      chain.push(`${p.groupDir}/group-${encodeKey(`${idn.platform}_${idn.nativeId}`)}.json`)
      chain.push(`${p.groupDir}/group-${encodeKey(idn.nativeId)}.json`)
    }
  }
  if (kind === 'private' && id) {
    chain.push(`${p.privateDir}/private-${encodeKey(id)}.json`)
    // 老形状：private-<对方QQ号>.json
    if (c.personUid && c.personUid !== c.id) chain.push(`${p.privateDir}/private-${encodeKey(c.id)}.json`)
  }
  return [...new Set(chain)]
}

/** 文件名里的键：冒号/斜杠等非法字符换 `_`。 */
function encodeKey(value) {
  return String(value).replace(/[\\/:*?"<>|]/g, '_')
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
  // 记忆召回：只管"哪些事实能进上下文"；总量由注入预算管（不再有 max_inject 这种重复旋钮）
  recall: { hidden_kinds: [], min_importance: 0 },
  action: { proactive: 'on', quiet_hours: [], max_per_hour: 3, max_per_day: 20, per_target: true, group_proactive: false },
  persona: { evolve: true, auto_adopt: true, daily_auto_limit: 1, auto_approve_days: 3, rollback_days: 7 },
  // deny/allow 不再有页面入口（与主动开口的总开关重复），但合并逻辑保留：
  // 老规则文件里写了也不该被静默忽略——CLI `rule check` 仍会用。
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

// ── 管理台表单：字段表 + 写入 ──────────────────────────────────────────
//
// 为什么要一张字段表：规则以前只能在页面上看一段 JSON。JSON 能看懂的人不需要这个页面，
// 需要这个页面的人看不懂 JSON。所以字段的**标签、单位、范围、是否真的生效**由这里统一定义，
// 页面照着渲染，不在前端再抄一份（抄两份迟早对不上）。
//
// `honored` 是事实，不是期望：
//   · persona.*  → proposals.js 真的读（自动采纳的开关与阈值）；取值顺序是
//                  **人格规则 > 系统 policy.json > 代码默认**（2026-11-10 改的，以前 policy 优先，
//                  导致规则页改完一重启就被设置页盖掉）
//   · action.*   → 只有 CLI `yuanling rule check` 读；运行时没有代码执行（等 QQ 适配器）
//   · recall.*   → checkRecall / checkRecallKind 没有任何调用者（死代码）
//   · deny/allow → 只有 CLI 读

export const RULE_FIELDS = [
  {
    group: '提案演化',
    desc: '她能不能自己长大：把反复出现的说法攒成提案，到期自动采纳。',
    honored: true,
    fields: [
      { path: 'persona.evolve', label: '允许演化', type: 'bool', def: true, hint: '关掉之后定时任务与手动扫描都不再长新提案（已有提案仍会到期采纳）' },
      { path: 'persona.auto_adopt', label: '自动采纳', type: 'bool', def: true, hint: '关掉之后每条都要你手动点「采纳」' },
      { path: 'persona.auto_approve_days', label: '等几天才自动采纳', type: 'int', min: 0, max: 90, def: 3, hint: '0 = 立刻' },
      { path: 'persona.daily_auto_limit', label: '一天最多自动采纳', type: 'int', min: 0, max: 50, def: 1, hint: '防止她一天改自己十次' },
      { path: 'persona.rollback_days', label: '采纳后几天内可回滚', type: 'int', min: 1, max: 90, def: 7 },
    ],
  },
  {
    group: '开口意愿',
    desc: '她能不能主动说话、几点之后闭嘴、一小时说几句。**这是主动开口的闸门**（管"什么时候说、说多少"），和黑白名单（管"跟谁说"）是两回事。',
    honored: true,
    fields: [
      { path: 'action.proactive', label: '主动开口', type: 'enum', options: [['on', '允许'], ['off', '不许']], def: 'on' },
      { path: 'action.group_proactive', label: '群里主动插话', type: 'bool', def: false },
      { path: 'action.max_per_hour', label: '每小时最多几条', type: 'int', min: 0, max: 60, def: 3 },
      { path: 'action.max_per_day', label: '一天最多几条', type: 'int', min: 0, max: 500, def: 20 },
      { path: 'action.quiet_hours', label: '别吵的时段', type: 'ranges', def: [], hint: '例如 01:00-08:00，多个用逗号隔开（支持跨零点）' },
      { path: 'action.per_target', label: '按人分别计数', type: 'bool', def: true, hint: '关掉就是全局共用一份配额' },
    ],
  },
  {
    group: '记忆召回',
    desc: '一条事实够不够格进上下文。**它管的是"哪些记忆能进"，不是"能进多少"**——总量由注入预算管。',
    honored: true,
    fields: [
      {
        path: 'recall.min_importance',
        label: '最低重要度',
        type: 'int',
        min: 0,
        max: 100,
        def: 0,
        hint: '低于这个分数的事实不往上下文里放（0 = 不过滤）。适合把"随口一提"挡在外面',
      },
      {
        path: 'recall.hidden_kinds',
        label: '永不注入的事实类型',
        type: 'list',
        def: [],
        hint: '例如 identity-claim：她的账号归属不该每轮都摆到面前。类型见记忆里的 kind 字段',
      },
    ],
  },
]

/** 按点号路径取值。 */
function getPath(obj, p) {
  return p.split('.').reduce((o, k) => (o && typeof o === 'object' ? o[k] : undefined), obj)
}

function setPath(obj, p, v) {
  const keys = p.split('.')
  let cur = obj
  for (let i = 0; i < keys.length - 1; i += 1) {
    if (!cur[keys[i]] || typeof cur[keys[i]] !== 'object') cur[keys[i]] = {}
    cur = cur[keys[i]]
  }
  cur[keys[keys.length - 1]] = v
}

const RANGE_RE = /^\d{1,2}:\d{2}-\d{1,2}:\d{2}$/

/**
 * 把一个字段的输入值规整成能落盘的形状。
 * 不合法的就抛错——**不静默兜底**：把 "abc" 静默存成 0，人下次看到会以为自己填对了。
 */
function coerce(field, raw) {
  if (field.type === 'bool') {
    if (typeof raw === 'boolean') return raw
    if (raw === 'true' || raw === 1 || raw === '1') return true
    if (raw === 'false' || raw === 0 || raw === '0') return false
    throw new Error(`「${field.label}」要的是 true/false`)
  }
  if (field.type === 'int') {
    const n = Number(raw)
    if (!Number.isFinite(n)) throw new Error(`「${field.label}」要的是数字`)
    if (field.min !== undefined && n < field.min) throw new Error(`「${field.label}」不能小于 ${field.min}`)
    if (field.max !== undefined && n > field.max) throw new Error(`「${field.label}」不能大于 ${field.max}`)
    return Math.round(n)
  }
  if (field.type === 'enum') {
    const ok = field.options.map(([v]) => v)
    if (!ok.includes(String(raw))) throw new Error(`「${field.label}」只能是 ${ok.join(' / ')}`)
    return String(raw)
  }
  if (field.type === 'ranges') {
    const list = Array.isArray(raw)
      ? raw
      : String(raw ?? '')
          .split(/[,，、\s]+/)
          .map((x) => x.trim())
          .filter(Boolean)
    for (const r of list) {
      if (!RANGE_RE.test(r)) throw new Error(`「${field.label}」里的 ${r} 不是 HH:MM-HH:MM 形式`)
    }
    return list
  }
  if (field.type === 'list') {
    const list = Array.isArray(raw)
      ? raw
      : String(raw ?? '')
          .split(/[,，、\s]+/)
          .map((x) => x.trim())
          .filter(Boolean)
    return list
  }
  throw new Error(`不认识的字段类型：${field.type}`)
}

/** 管理台要渲染的那张表（带默认值，页面不用再猜）。 */
export function ruleFieldSpec() {
  return RULE_FIELDS.map((g) => ({
    group: g.group,
    desc: g.desc,
    honored: g.honored,
    why: g.why ?? null,
    fields: g.fields.map((f) => ({
      path: f.path,
      label: f.label,
      type: f.type,
      def: f.def,
      min: f.min ?? null,
      max: f.max ?? null,
      options: f.options ?? null,
      hint: f.hint ?? null,
    })),
  }))
}

/**
 * 改人格级全局规则（`personas/<p>/rules/global.json`）。
 *
 * 只认 RULE_FIELDS 里的路径——这是**白名单**，不是"随便传什么都能写"。
 * 未知键一律丢掉并在回执里列出来，别让人以为存进去了。
 *
 * @returns {{changed:boolean, written:object, dropped:string[], path:string}}
 */
export function writeGlobalRules(root, pid, patch, { actor = 'human:editor', reason = '管理台改规则' } = {}) {
  const b = patch && typeof patch === 'object' ? patch : {}
  const known = new Set(RULE_FIELDS.flatMap((g) => g.fields.map((f) => f.path)))
  const fields = new Map(RULE_FIELDS.flatMap((g) => g.fields.map((f) => [f.path, f])))

  const rel = rulePaths(root, pid).global
  const abs = path.join(root, rel)
  const cur = readJson(abs, null) ?? JSON.parse(JSON.stringify(DEFAULTS))

  const next = JSON.parse(JSON.stringify(cur))
  const dropped = []
  let touched = 0

  for (const [pathKey, raw] of Object.entries(b)) {
    if (!known.has(pathKey)) {
      dropped.push(pathKey)
      continue
    }
    const field = fields.get(pathKey)
    const value = coerce(field, raw)
    if (JSON.stringify(getPath(next, pathKey)) === JSON.stringify(value)) continue
    setPath(next, pathKey, value)
    touched += 1
  }

  if (!touched) return { changed: false, written: next, dropped, path: rel }

  // 保留 _comment：它是给人看的那句话，别因为表单保存就丢掉
  if (!next._comment && cur._comment) next._comment = cur._comment
  writeTracked(root, rel, JSON.stringify(next, null, 2) + '\n', { actor, reason })
  return { changed: true, written: next, dropped, path: rel }
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
  // 同时进事件流：拒绝记录页读 changes.ndjson（历史不变），日志页读事件流。
  // 两处都写不是冗余——一个是"语义变更账本"，一个是"运行流水"，读者不同。
  appendEvent(root, {
    kind: 'refusal',
    level: 'warn',
    actor: 'core',
    text: `${dim}/${action} 被拒${channel ? `（${channel}）` : ''}：${reason}`,
    data: { dim, action, channel, reason, persona: pid ?? null },
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
