// test/p7.test.mjs —— 规则层：三级继承、deny 优先、时间窗、入库硬线、拒绝留痕。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { scaffold } from '../src/core/scaffold.js'
import { P } from '../src/core/paths.js'
import {
  loadEffectiveRules,
  checkAction,
  checkRecall,
  inQuietHours,
  canIngest,
  logRefusal,
  recentRefusals,
} from '../src/core/rules.js'
import { ingest } from '../src/core/inbox.js'
import { readDay, today } from '../src/core/raw.js'

const PID = 'yuanling'

function tmpRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'yuanling-p7-'))
  scaffold(root, {})
  return root
}

function writeRule(root, rel, obj) {
  const abs = path.join(root, rel)
  fs.mkdirSync(path.dirname(abs), { recursive: true })
  fs.writeFileSync(abs, JSON.stringify(obj, null, 2) + '\n', 'utf8')
}

const at = (h, m = 0) => new Date(2026, 10, 6, h, m).getTime()

// ── 继承 ────────────────────────────────────────────────────────────────

test('规则：默认只有人格级 global', () => {
  const root = tmpRoot()
  const { sources, rules } = loadEffectiveRules(root, PID)
  assert.deepEqual(sources, [`personas/${PID}/rules/global.json`])
  assert.equal(rules.action.max_per_hour, 3)
})

test('规则：群规则覆盖全局', () => {
  const root = tmpRoot()
  writeRule(root, `personas/${PID}/rules/qq/group-123.json`, { action: { max_per_hour: 1 } })

  const { rules, sources } = loadEffectiveRules(root, PID, { channel: 'group:123' })
  assert.equal(rules.action.max_per_hour, 1)
  assert.equal(sources.length, 2, 'global → group')
})

test('规则：私聊覆盖群（更具体者优先）', () => {
  const root = tmpRoot()
  writeRule(root, `personas/${PID}/rules/qq/group-123.json`, { action: { max_per_hour: 1 } })
  writeRule(root, `personas/${PID}/rules/private-456.json`, { action: { max_per_hour: 30 } })

  const g = loadEffectiveRules(root, PID, { channel: 'group:123' })
  assert.equal(g.rules.action.max_per_hour, 1)

  // 同一份 global + private 链（私聊不叠群规则）
  const p = loadEffectiveRules(root, PID, { channel: 'private:456' })
  assert.equal(p.rules.action.max_per_hour, 30)
})

test('规则：deny 取并集，下层不许悄悄放宽', () => {
  const root = tmpRoot()
  writeRule(root, `personas/${PID}/rules/global.json`, { deny: ['send'] })
  writeRule(root, `personas/${PID}/rules/private-1.json`, { deny: ['proactive'] })

  const { rules } = loadEffectiveRules(root, PID, { channel: 'private:1' })
  assert.deepEqual([...rules.deny].sort(), ['proactive', 'send'])
})

test('规则：override_deny:true 只放开本层 allow 里写明的那条', () => {
  const root = tmpRoot()
  writeRule(root, `personas/${PID}/rules/global.json`, { deny: ['send', 'call'] })
  writeRule(root, `personas/${PID}/rules/private-1.json`, {
    allow: ['send'],
    override_deny: true,
  })

  const { rules } = loadEffectiveRules(root, PID, { channel: 'private:1' })
  assert.ok(!rules.deny.includes('send'), 'send 应该被显式放开')
  assert.ok(rules.deny.includes('call'), 'call 不该跟着被放开')
})

test('规则：没有 override_deny 时，allow 不放宽 deny', () => {
  const root = tmpRoot()
  writeRule(root, `personas/${PID}/rules/global.json`, { deny: ['send'] })
  writeRule(root, `personas/${PID}/rules/private-1.json`, { allow: ['send'] })

  const { rules } = loadEffectiveRules(root, PID, { channel: 'private:1' })
  assert.ok(rules.deny.includes('send'))
})

// ── 动作判定 ────────────────────────────────────────────────────────────

test('checkAction：deny 命中就拒绝', () => {
  const root = tmpRoot()
  writeRule(root, `personas/${PID}/rules/global.json`, { deny: ['send'] })
  const { rules } = loadEffectiveRules(root, PID)
  const r = checkAction(rules, 'send')
  assert.equal(r.allowed, false)
  assert.match(r.reason, /deny/)
})

test('checkAction：proactive=off 拒绝主动', () => {
  const root = tmpRoot()
  writeRule(root, `personas/${PID}/rules/global.json`, { action: { proactive: 'off' } })
  const { rules } = loadEffectiveRules(root, PID)
  assert.equal(checkAction(rules, 'proactive', { now: at(12) }).allowed, false)
})

test('checkAction：静默时段内拒绝，外出放行', () => {
  const root = tmpRoot()
  writeRule(root, `personas/${PID}/rules/global.json`, { action: { quiet_hours: ['01:00-08:00'] } })
  const { rules } = loadEffectiveRules(root, PID)

  assert.equal(checkAction(rules, 'proactive', { channel: 'private:1', now: at(3) }).allowed, false)
  assert.equal(checkAction(rules, 'proactive', { channel: 'private:1', now: at(12) }).allowed, true)
})

test('checkAction：群聊主动默认关', () => {
  const root = tmpRoot()
  const { rules } = loadEffectiveRules(root, PID)
  assert.equal(checkAction(rules, 'proactive', { channel: 'group:9', now: at(12) }).allowed, false)
  assert.equal(checkAction(rules, 'proactive', { channel: 'private:9', now: at(12) }).allowed, true)
})

test('inQuietHours：支持跨零点', () => {
  assert.equal(inQuietHours(['23:00-06:00'], at(2)), true)
  assert.equal(inQuietHours(['23:00-06:00'], at(23)), true)
  assert.equal(inQuietHours(['23:00-06:00'], at(12)), false)
  assert.equal(inQuietHours([], at(3)), false)
})

test('checkRecall：低于门槛的事实不进注入', () => {
  const root = tmpRoot()
  writeRule(root, `personas/${PID}/rules/global.json`, { recall: { min_importance: 60 } })
  const { rules } = loadEffectiveRules(root, PID)
  assert.equal(checkRecall(rules, { imp: 30 }).allowed, false)
  assert.equal(checkRecall(rules, { imp: 90 }).allowed, true)
})

// ── 入库硬线 ────────────────────────────────────────────────────────────

test('canIngest：guardrails.never_record 命中就 false', () => {
  const root = tmpRoot()
  fs.writeFileSync(
    path.join(root, P.guardrails),
    JSON.stringify({ never_record: ['机密'], never_inject: [], never_do: [] }, null, 2),
    'utf8',
  )
  assert.equal(canIngest(root, 'private:1', '这是机密内容').ok, false)
  assert.equal(canIngest(root, 'private:1', '普通内容').ok, true)
})

test('ingest：命中 never_record 时连 raw 都不写，并留一条拒绝记录', () => {
  const root = tmpRoot()
  fs.writeFileSync(
    path.join(root, P.guardrails),
    JSON.stringify({ never_record: ['机密'], never_inject: [], never_do: [] }, null, 2),
    'utf8',
  )

  const r = ingest(root, {
    v: 1,
    source: 'qq',
    acct: '10001',
    items: [
      { ts: '2026-11-06T10:00:00+08:00', channel: 'private:1', actor: { kind: 'owner', id: '1' }, kind: 'msg', text: '这是机密' },
      { ts: '2026-11-06T10:00:01+08:00', channel: 'private:1', actor: { kind: 'owner', id: '1' }, kind: 'msg', text: '普通内容' },
    ],
  })

  assert.equal(r.skipped, 1)
  assert.equal(r.accepted, 1)
  const day = today(new Date('2026-11-06T10:00:00+08:00'))
  const msgs = readDay(root, day).filter((x) => x.type === 'message')
  assert.equal(msgs.length, 1)
  assert.equal(msgs[0].text, '普通内容')

  const refusals = recentRefusals(root)
  assert.ok(refusals.some((x) => x.dim === 'ingest' && /never_record/.test(x.reason)))
})

test('logRefusal / recentRefusals：按时间倒序给最近的', () => {
  const root = tmpRoot()
  logRefusal(root, PID, { dim: 'action', action: 'proactive', reason: 'quiet_hours' })
  logRefusal(root, PID, { dim: 'recall', action: 'inject', reason: 'min_importance' })

  const list = recentRefusals(root, { limit: 5 })
  assert.equal(list.length, 2)
  assert.equal(list[0].reason, 'min_importance', '最新的在前')
})

// ── 缺文件 ──────────────────────────────────────────────────────────────

test('规则：规则文件缺失时用默认值，并把缺失路径报出来', () => {
  const root = tmpRoot()
  fs.rmSync(path.join(root, `personas/${PID}/rules/global.json`))
  const { rules, sources, missing } = loadEffectiveRules(root, PID)
  assert.deepEqual(sources, [])
  assert.ok(missing.some((m) => m.includes('global.json')))
  assert.equal(rules.action.max_per_hour, 3, '默认值兜底')
})
