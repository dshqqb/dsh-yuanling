// src/core/proposals.js —— 人格演化提案。
//
// 思路（用户定的）：
//   记忆与人格共同塑造灵魂，记忆在潜移默化地改变人格；规则只限定权限，不塑造人格。
//
// 所以演化只有一条路：
//   重复出现的主张 → 提案（带证据）→ 人批准 → 改表达层 → 7 天可回滚
//   人不理会 → 若干天后自动批准（除非被否决）
//
// 一个文件一个提案；风格改动落在 style.md（表达层），SELF.md 的骨架**永不自动改**。
import fs from 'node:fs'
import path from 'node:path'
import { exists, readJson, writeJsonAtomic, localIso, ulid, sha256 } from './fsx.js'
import { P } from './paths.js'
import { writeTracked, history, snapshotCurrent, revertTo } from './version.js'
import { listEntries, entryRel } from './memory.js'
import { loadEffectiveRules } from './rules.js'

export const DEFAULT_MIN_REPEAT = 5
export const DEFAULT_MIN_DAYS = 3
export const DEFAULT_AUTO_DAYS = 3
export const DEFAULT_ROLLBACK_DAYS = 7
export const DEFAULT_DAILY_LIMIT = 1

/**
 * 策略文件：由 DSH 设置页同步过来的两个旋钮。
 * 它比 rules 优先——因为设置页是给人随手调的，规则文件是给人精调的。
 */
export function readPolicy(root) {
  const j = readJson(path.join(root, P.policy), null)
  if (!j || typeof j !== 'object') return null
  const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : null)
  return { autoApproveDays: num(j.autoApproveDays), dailyAutoLimit: num(j.dailyAutoLimit) }
}

export function writePolicy(root, { autoApproveDays, dailyAutoLimit }) {
  const next = {
    _comment: '由 DSH 设置页同步；直接改这里等价于改设置。',
    autoApproveDays,
    dailyAutoLimit,
    updated_at: localIso(),
  }
  writeJsonAtomic(path.join(root, P.policy), next)
  return next
}

export function proposalsDir(root, pid) {
  return path.join(root, P.personas, pid, 'proposals')
}

function proposalRel(pid, id) {
  return `${P.personas}/${pid}/proposals/${id}.json`
}

export function styleRel(pid) {
  return `${P.personas}/${pid}/style.md`
}

export function listProposals(root, pid) {
  const dir = proposalsDir(root, pid)
  if (!exists(dir)) return []
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .map((f) => readJson(path.join(dir, f), null))
    .filter(Boolean)
    .sort((a, b) => String(b.created).localeCompare(String(a.created)))
}

export function findProposal(root, pid, id) {
  return readJson(path.join(root, proposalRel(pid, id)), null)
}

function saveProposal(root, pid, proposal) {
  writeJsonAtomic(path.join(root, proposalRel(pid, proposal.id)), proposal)
  return proposal
}

function keyOf(text) {
  return sha256(Buffer.from(String(text).trim().toLowerCase(), 'utf8'))
}

function daysBetween(a, b) {
  const t1 = Date.parse(a)
  const t2 = Date.parse(b)
  if (Number.isNaN(t1) || Number.isNaN(t2)) return 0
  return Math.abs(t2 - t1) / 86_400_000
}

/**
 * 扫一遍记忆，把"反复出现且跨度够长"的主张变成提案。
 * 幂等：同一个主张（按文本哈希）只提一次；已否决的不再提。
 */
export function scan(
  root,
  pid,
  { now = localIso(), minRepeat = DEFAULT_MIN_REPEAT, minDays = DEFAULT_MIN_DAYS, autoApproveDays = null } = {},
) {
  const entries = listEntries(root, pid)
  const existing = listProposals(root, pid)
  const seen = new Set(existing.map((p) => p.key))
  const policy = readPolicy(root)
  const autoDays = autoApproveDays ?? policy?.autoApproveDays ?? DEFAULT_AUTO_DAYS

  const created = []
  for (const e of entries) {
    for (const f of e.facts ?? []) {
      if (f.until) continue
      if (f.shielded_at) continue
      if (f.kind === 'identity-claim') continue // 身份主张由 P9 处理
      const repeat = Number(f.repeat ?? 1)
      if (repeat < minRepeat) continue
      const span = daysBetween(f.created, f.last_seen ?? f.created)
      if (span < minDays) continue

      const key = keyOf(f.text)
      if (seen.has(key)) continue
      seen.add(key)

      const created_at = now
      const proposal = {
        id: 'prop_' + ulid(),
        key,
        persona: pid,
        kind: 'style',
        claim: String(f.text),
        line: `- ${String(f.text).replace(/\s+/g, ' ').slice(0, 120)}`,
        evidence: (f.srcs ?? [f.src]).filter(Boolean).map((src) => ({ src, factId: f.id })),
        count: repeat,
        days: Number(span.toFixed(1)),
        topic: e.topic,
        status: 'pending',
        created: created_at,
        auto_approve_at: new Date(Date.parse(created_at) + autoDays * 86_400_000).toISOString(),
        decided_at: null,
        applied: null,
        rollback_until: null,
      }
      saveProposal(root, pid, proposal)
      created.push(proposal)
    }
  }
  return created
}

function personaPolicy(root, pid) {
  const { rules } = loadEffectiveRules(root, pid)
  const policy = readPolicy(root)
  return {
    autoAdopt: rules.persona?.auto_adopt !== false,
    dailyLimit: policy?.dailyAutoLimit ?? Number(rules.persona?.daily_auto_limit ?? DEFAULT_DAILY_LIMIT),
    autoApproveDays: policy?.autoApproveDays ?? Number(rules.persona?.auto_approve_days ?? DEFAULT_AUTO_DAYS),
    rollbackDays: Number(rules.persona?.rollback_days ?? DEFAULT_ROLLBACK_DAYS),
  }
}

/** 把提案应用到表达层（style.md），并记下可回滚的锚点。 */
export function approve(root, pid, id, { now = localIso(), by = 'human' } = {}) {
  const p = findProposal(root, pid, id)
  if (!p) throw new Error(`提案不存在：${id}`)
  if (p.status === 'approved') return { changed: false, proposal: p }
  if (p.status === 'rejected') throw new Error('这个提案已被否决，不能批准')
  if (p.status === 'rolled_back') throw new Error('这个提案已经回滚过，不能再批一次')

  const rel = styleRel(pid)
  const abs = path.join(root, rel)
  const cur = exists(abs) ? fs.readFileSync(abs, 'utf8') : '# 表达层\n'
  // 先把"改动前"记进历史，回滚才有东西可回
  snapshotCurrent(root, rel, { actor: 'system:proposal', reason: '提案应用前快照' })
  const before = history(root, rel).slice(-1)[0]?.hash ?? null

  const next = cur.endsWith('\n') ? cur + p.line + '\n' : cur + '\n' + p.line + '\n'
  writeTracked(root, rel, next, { actor: `system:proposal:${by}`, reason: `采纳提案 ${p.id}` })
  const after = history(root, rel).slice(-1)[0]?.hash ?? null

  const policy = personaPolicy(root, pid)
  p.status = 'approved'
  p.decided_at = now
  p.decided_by = by
  p.applied = { file: rel, line: p.line, before_hash: before, after_hash: after }
  p.rollback_until = new Date(Date.parse(now) + policy.rollbackDays * 86_400_000).toISOString()
  saveProposal(root, pid, p)
  return { changed: true, proposal: p }
}

export function reject(root, pid, id, { now = localIso(), reason = '' } = {}) {
  const p = findProposal(root, pid, id)
  if (!p) throw new Error(`提案不存在：${id}`)
  if (p.status === 'approved') throw new Error('已经生效的提案请用 rollback，不能用 reject')
  p.status = 'rejected'
  p.decided_at = now
  p.decided_by = 'human'
  p.reject_reason = reason
  saveProposal(root, pid, p)
  return p
}

/** 7 天窗口内可回滚：按锚点把 style.md 退回去。 */
export function rollback(root, pid, id, { now = localIso() } = {}) {
  const p = findProposal(root, pid, id)
  if (!p) throw new Error(`提案不存在：${id}`)
  if (p.status !== 'approved') throw new Error('只有已生效的提案能回滚')
  if (p.rollback_until && Date.parse(now) > Date.parse(p.rollback_until)) {
    throw new Error(`回滚窗口已过（截止 ${p.rollback_until.slice(0, 10)}）`)
  }
  const before = p.applied?.before_hash
  if (!before) throw new Error('缺少回滚锚点，无法自动回滚')
  revertTo(root, p.applied.file, before, { actor: 'human:rollback' })
  p.status = 'rolled_back'
  p.rolled_back_at = now
  saveProposal(root, pid, p)
  return p
}

/**
 * 定时扫：到期的 pending 自动批准（除非被否决）。
 *
 * 到期时间按**当前设置**现算（created + autoApproveDays），
 * 这样把"3 天"改成"1 天"会立刻对已有提案生效，而不是等下一轮重新生成。
 * 每天自动采纳数量受 dailyAutoLimit 限制（默认 1 条/天）。
 */
export function sweep(root, pid, { now = localIso() } = {}) {
  const policy = personaPolicy(root, pid)
  if (!policy.autoAdopt) return { approved: [], skipped: 'auto_adopt=false' }

  const list = listProposals(root, pid)
  const today = String(now).slice(0, 10)
  const usedToday = list.filter(
    (p) => p.status === 'approved' && p.decided_by === 'auto' && String(p.decided_at).slice(0, 10) === today,
  ).length
  let budget = Math.max(0, policy.dailyLimit - usedToday)

  const dueAt = (p) => Date.parse(p.created) + policy.autoApproveDays * 86_400_000
  const due = list
    .filter((p) => p.status === 'pending' && dueAt(p) <= Date.parse(now))
    .sort((a, b) => dueAt(a) - dueAt(b))

  const approved = []
  for (const p of due) {
    if (budget <= 0) break
    try {
      approve(root, pid, p.id, { now, by: 'auto' })
      approved.push(p.id)
      budget -= 1
    } catch {
      /* 单条失败不拖垮整批 */
    }
  }
  return { approved, budgetLeft: budget, dailyLimit: policy.dailyLimit, days: policy.autoApproveDays }
}
