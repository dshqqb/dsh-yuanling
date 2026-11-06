// src/core/inbox.js —— 生产者投递区：文件 + HTTP 两个入口，同一套规范化。
//
// 契约（文档 §6.1）：
//   { v:1, source:"qq", acct:"10001", items:[{ ts, channel, actor, role, kind, text, ... }] }
// 只有本进程写 raw；生产者只投递。
import fs from 'node:fs'
import path from 'node:path'
import { exists, ensureDir, readJson, appendLine, localIso } from './fsx.js'
import { P } from './paths.js'
import { appendRecord } from './raw.js'
import { applyIngestPolicy, loadIngestRules } from './redact.js'
import { canIngest, logRefusal } from './rules.js'

export const INBOX_VERSION = 1

/** 规范化并校验信封。未知版本拒收；未知字段忽略。 */
export function normalizeEnvelope(env) {
  if (!env || typeof env !== 'object') throw new Error('信封必须是对象')
  const v = Number(env.v ?? 0)
  if (v !== INBOX_VERSION) throw new Error(`不支持的 inbox 版本：${env.v}（本插件支持 ${INBOX_VERSION}）`)
  const source = String(env.source ?? '').trim()
  if (!source) throw new Error('信封缺少 source')
  const acct = String(env.acct ?? 'default')
  const items = Array.isArray(env.items) ? env.items : []
  if (!items.length) throw new Error('信封里没有任何 items')
  return { v, source, acct, items }
}

/**
 * 摄入一个信封。
 * @returns {{accepted:number, deduped:number, skipped:number, errors:string[]}}
 */
export function ingest(root, env, { now, maxBytes } = {}) {
  const { source, acct, items } = normalizeEnvelope(env)
  const rules = loadIngestRules(root)
  const out = { accepted: 0, deduped: 0, skipped: 0, errors: [] }

  for (const item of items) {
    try {
      const channel = String(item.channel ?? 'unknown')
      const rawText = String(item.text ?? '')

      // 硬线：guardrails.never_record 命中的内容，连 raw 都不进。
      const guard = canIngest(root, channel, rawText)
      if (!guard.ok) {
        countSkip(root, source)
        logRefusal(root, null, { dim: 'ingest', action: 'record', channel, reason: guard.reason })
        out.skipped += 1
        continue
      }

      const policy = applyIngestPolicy(rawText, { channel, rules })

      if (policy.skip) {
        // 完全不入 raw，只留计数。计数写进当天的 day.json 之外的一个小账本，
        // 避免为了"记一条被跳过"反而把内容写进去。
        countSkip(root, source)
        out.skipped += 1
        continue
      }

      const r = appendRecord(
        root,
        {
          ...item,
          // inbox 用 kind，raw 用 type：msg → message，其余原样传
          type: item.kind === 'msg' ? 'message' : String(item.kind ?? 'message'),
          source,
          acct: item.acct ?? acct,
          channel,
          text: policy.text,
          flags: [...new Set([...(Array.isArray(item.flags) ? item.flags : []), ...policy.flags])],
        },
        { now, maxBytes },
      )
      if (r.deduped) out.deduped += 1
      else out.accepted += 1
    } catch (err) {
      out.errors.push(String(err?.message ?? err))
    }
  }
  if (out.errors.length === 0 && out.accepted > 0) beat(root, source, { ok: true })
  return out
}

function skipLedgerPath(root) {
  return path.join(root, P.inbox, '.skipped.ndjson')
}

function countSkip(root, source) {
  try {
    appendLine(skipLedgerPath(root), { ts: localIso(), source, n: 1 })
  } catch {
    /* 计数失败不该阻塞摄入 */
  }
}

/** 读被跳过的计数（只报数，不含内容）。 */
export function skipStats(root) {
  const p = skipLedgerPath(root)
  if (!exists(p)) return {}
  const out = {}
  for (const line of fs.readFileSync(p, 'utf8').split('\n')) {
    if (!line.trim()) continue
    try {
      const r = JSON.parse(line)
      out[r.source] = (out[r.source] ?? 0) + (r.n ?? 1)
    } catch {
      /* 坏行 */
    }
  }
  return out
}

/** 扫一遍 inbox 目录，消费所有投递文件后删除。 */
export function drain(root, { now, maxBytes } = {}) {
  const dir = path.join(root, P.inbox)
  if (!fs.existsSync(dir)) return { files: 0, ...emptyResult() }
  const total = { files: 0, accepted: 0, deduped: 0, skipped: 0, errors: [] }
  const names = fs
    .readdirSync(dir)
    .filter((n) => n.endsWith('.ndjson') && !n.startsWith('.'))
    .sort()

  for (const name of names) {
    const abs = path.join(dir, name)
    let text = ''
    try {
      text = fs.readFileSync(abs, 'utf8')
    } catch (err) {
      total.errors.push(`${name}: ${err?.message ?? err}`)
      continue
    }
    for (const line of text.split('\n')) {
      if (!line.trim()) continue
      try {
        const env = JSON.parse(line)
        const r = ingest(root, env, { now, maxBytes })
        total.accepted += r.accepted
        total.deduped += r.deduped
        total.skipped += r.skipped
        total.errors.push(...r.errors)
      } catch (err) {
        total.errors.push(`${name}: ${err?.message ?? err}`)
      }
    }
    try {
      fs.unlinkSync(abs)
      total.files += 1
    } catch (err) {
      total.errors.push(`${name}: 消费后删除失败 ${err?.message ?? err}`)
    }
  }
  return total
}

function emptyResult() {
  return { accepted: 0, deduped: 0, skipped: 0, errors: [] }
}

// ── 心跳 ────────────────────────────────────────────────────────────────

export function healthPath(root, source) {
  return path.join(root, P.health, `${source}.json`)
}

/** 写心跳。来源只要活着就每分钟写一次。 */
export function beat(root, source, { ok = true, lastEvent } = {}) {
  ensureDir(path.join(root, P.health))
  const p = healthPath(root, source)
  const prev = readJson(p, null)
  const now = localIso()
  const next = {
    source,
    at: now,
    ok,
    last_event: lastEvent ?? prev?.last_event ?? null,
  }
  fs.writeFileSync(p, JSON.stringify(next, null, 2) + '\n', 'utf8')
  return next
}

/**
 * 静默判定（文档 §6.5）：
 *   ok     心跳新鲜 + 最近有事件
 *   quiet  心跳新鲜但很久没事件 —— 正常，不报警
 *   silent 心跳过期 —— 可能挂了，报警
 *   absent 从没心跳 —— 来源未接入，提示
 */
export function classifyHealth(record, { now = Date.now(), staleMs = 5 * 60_000, quietMs = 60 * 60_000 } = {}) {
  if (!record?.at) return 'absent'
  const at = Date.parse(record.at)
  if (Number.isNaN(at)) return 'absent'
  if (now - at > staleMs) return 'silent'
  const last = record.last_event ? Date.parse(record.last_event) : null
  if (last === null || Number.isNaN(last)) return 'quiet'
  if (now - last > quietMs) return 'quiet'
  return 'ok'
}

/** 列出所有来源健康状态。 */
export function healthReport(root, opts = {}) {
  const dir = path.join(root, P.health)
  if (!exists(dir)) return []
  return fs
    .readdirSync(dir)
    .filter((n) => n.endsWith('.json'))
    .sort()
    .map((n) => {
      const rec = readJson(path.join(dir, n), null)
      return { source: rec?.source ?? n.replace(/\.json$/, ''), state: classifyHealth(rec, opts), at: rec?.at ?? null }
    })
}
