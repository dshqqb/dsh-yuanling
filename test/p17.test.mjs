// test/p17.test.mjs —— selectIntent：冷却、次数上限、一轮内去重。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { scaffold } from '../src/core/scaffold.js'
import { appendRecord } from '../src/core/raw.js'
import { localIso, ulid } from '../src/core/fsx.js'
import { addFact, contextFor } from '../src/core/memory.js'
import { readPurposes, selectIntent, SELECT_MAX_HITS, SELECT_MAX_OFFERED, SELECT_RECENT_MS } from '../src/core/purposes.js'

const PID = 'yuanling'
const HOUR = 3_600_000

function tmpRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'yuanling-p17-'))
  scaffold(root, {})
  return root
}

const iso = (ms) => localIso(new Date(ms))
const open = (id, text, extra = {}) => ({
  id,
  need: 'care',
  text,
  origin: `raw/x#${id}`,
  status: 'open',
  created: iso(Date.now() - 30 * HOUR),
  due: iso(Date.now() - HOUR),
  hits: 0,
  ...extra,
})

function seedRaw(root, text) {
  const r = appendRecord(root, {
    source: 'qq',
    acct: '10001',
    channel: 'private:10001',
    actor: { kind: 'owner', id: '10001', name: '主人' },
    role: 'user',
    text: `${text} ${ulid()}`,
    ts: localIso(),
  })
  return `${r.file}#${r.id}`
}

function writeDoc(root, items) {
  fs.writeFileSync(
    path.join(root, 'personas', PID, 'self', 'purposes.json'),
    JSON.stringify({ version: 1, items }, null, 2),
  )
}

// ── 纯函数 ──────────────────────────────────────────────────────────────

test('select：刚提过的进冷却，不再挑出来', () => {
  const items = [open('a', '面试的事', { hits: 1, last_hit: iso(Date.now() - HOUR) })]
  const r = selectIntent(items, { care: 0.9 })
  assert.equal(r.picked.length, 0)
  assert.equal(r.cooled, 1)
})

test('select：冷却窗口过去后可以再提', () => {
  const items = [open('a', '面试的事', { hits: 1, last_hit: iso(Date.now() - SELECT_RECENT_MS - HOUR) })]
  const r = selectIntent(items, { care: 0.9 })
  assert.equal(r.picked.length, 1)
  assert.equal(r.cooled, 0)
})

test('select：说出口够次数就不再出现，并报告出来', () => {
  const items = [open('a', '面试的事', { hits: SELECT_MAX_HITS })]
  const r = selectIntent(items, { care: 0.9 })
  assert.equal(r.picked.length, 0)
  // why 要分开：`mentioned` 是"她说过了"，`ignored` 是"摆了多次没接"
  assert.deepEqual(r.exhausted, [{ id: 'a', why: 'mentioned' }])
})

test('select：摆了够多次但一次都没接 → 也放下，但理由不同', () => {
  const items = [open('a', '面试的事', { offered: SELECT_MAX_OFFERED, hits: 0 })]
  const r = selectIntent(items, { care: 0.9 })
  assert.equal(r.picked.length, 0)
  assert.deepEqual(r.exhausted, [{ id: 'a', why: 'ignored' }])
})

test('select：被摆到面前过也在冷却窗内（否则每轮都会重新摆一遍）', () => {
  const items = [open('a', '面试的事', { offered: 1, last_offered: iso(Date.now() - HOUR) })]
  const r = selectIntent(items, { care: 0.9 })
  assert.equal(r.picked.length, 0)
  assert.equal(r.cooled, 1)
})

test('select：注入了但没提（offered 涨、hits 为 0）不算"提过"', () => {
  const items = [open('a', '面试的事', { offered: SELECT_MAX_HITS, hits: 0 })]
  const r = selectIntent(items, { care: 0.9 })
  assert.equal(r.picked.length, 1, '被摆两次不等于她说过了两次')
})

test('select：一轮里说的是同一件事，只留一条', () => {
  // 这两句几乎一字不差（相似度 ~0.86），断言它们不该同时出现
  const items = [open('a', '面试没过，很难过'), open('b', '面试没过，很难过啊')]
  const r = selectIntent(items, { care: 0.9 })
  assert.equal(r.picked.length, 1)
})

test('select：完成的、未到期的都不参与', () => {
  const items = [
    open('done', '已完成', { status: 'done' }),
    open('future', '还没到期', { due: iso(Date.now() + 3 * HOUR) }),
    open('ok', '正常的'),
  ]
  const r = selectIntent(items, { care: 0.9 })
  assert.equal(r.picked.length, 1)
  assert.equal(r.picked[0].id, 'ok')
})

test('select：limit 生效，且按需求强度排序', () => {
  const items = [
    open('share1', 'A 事', { need: 'share' }),
    open('care1', 'B 事', { need: 'care' }),
    open('care2', 'C 事', { need: 'care' }),
  ]
  const r = selectIntent(items, { care: 0.9, share: 0.1 }, { limit: 1 })
  assert.equal(r.picked.length, 1)
  assert.equal(r.picked[0].need, 'care')
})

// ── 和注入串起来 ────────────────────────────────────────────────────────

test('contextFor：同一件事不会在两轮里连着被惦记', () => {
  const root = tmpRoot()
  const src = seedRaw(root, '面试')
  addFact(root, PID, { topic: '生活', text: '面试没过，很难过', src, now: localIso(new Date(Date.now() - 30 * HOUR)) })

  const first = contextFor(root, PID, { channel: 'private:10001' })
  assert.match(first, /\[惦记\]/)

  const second = contextFor(root, PID, { channel: 'private:10001' })
  assert.ok(!second.includes('[惦记]'), '刚提过的，下一轮不该再提')
})

test('contextFor：她真的说出口够次数的目的会被自动放下（记为 done）', () => {
  const root = tmpRoot()
  const src = seedRaw(root, '面试')
  addFact(root, PID, { topic: '生活', text: '面试没过，很难过', src, now: localIso(new Date(Date.now() - 30 * HOUR)) })

  // 先让它存在
  contextFor(root, PID, { channel: 'private:10001' })
  const doc = readPurposes(root, PID)
  assert.ok(doc.items.length >= 1)

  // 人为推到次数上限，再跑一轮
  const items = doc.items.map((p) => ({ ...p, hits: SELECT_MAX_HITS }))
  writeDoc(root, items)

  const ctx = contextFor(root, PID, { channel: 'private:10001' })
  assert.ok(!ctx.includes('[惦记]'), '说出口够次数了就不该再提')

  const after = readPurposes(root, PID)
  const closed = after.items.filter((p) => p.status === 'done')
  assert.ok(closed.length >= 1, '应该被标成 done')
  assert.match(closed[0].close_reason ?? '', /说出口/)
})

test('contextFor：只被摆到面前（offered）不等于说出口，不会被放下', () => {
  const root = tmpRoot()
  const src = seedRaw(root, '面试')
  addFact(root, PID, { topic: '生活', text: '面试没过，很难过', src, now: localIso(new Date(Date.now() - 30 * HOUR)) })

  // 跑一轮：这条会被摆出来一次
  contextFor(root, PID, { channel: 'private:10001' })
  const doc = readPurposes(root, PID)
  const p = doc.items[0]
  assert.equal(Number(p.offered), 1, '注入应该记 offered')
  assert.equal(Number(p.hits ?? 0), 0, '注入不能替她说"提过了"——这是这次要修的缺陷')
  assert.equal(p.status, 'open', '没真正说过，不能放下')
})
