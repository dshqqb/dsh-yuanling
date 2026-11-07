// test/p16.test.mjs —— 最小动机层：drives 会涨会落；目的带指针；[惦记] 最多 2 条。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { scaffold } from '../src/core/scaffold.js'
import { appendRecord } from '../src/core/raw.js'
import { localIso, ulid } from '../src/core/fsx.js'
import { addFact, contextFor } from '../src/core/memory.js'
import {
  DRIVE_BASE,
  DRIVE_CAP,
  DRIVE_HALF_LIFE_HOURS,
  readDrives,
  refreshDrives,
} from '../src/core/drives.js'
import {
  readPurposes,
  writePurposes,
  minePurposes,
  duePurposes,
  closePurpose,
  expirePurposes,
  PURPOSE_MAX_BYTES,
} from '../src/core/purposes.js'

const PID = 'yuanling'
const bytes = (s) => Buffer.byteLength(s, 'utf8')
const HOUR = 3_600_000
const daysAgo = (n) => localIso(new Date(Date.now() - n * 86_400_000))
const hoursAgo = (n) => localIso(new Date(Date.now() - n * HOUR))

function tmpRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'yuanling-p16-'))
  scaffold(root, {})
  return root
}

function seedRaw(root, text = '一句话') {
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

// ── drives ──────────────────────────────────────────────────────────────

test('drives：没有状态文件时取基线', () => {
  const root = tmpRoot()
  const d = readDrives(root, PID)
  assert.deepEqual(d.values, DRIVE_BASE)
})

test('drives：久没互动 → connect 上涨，且不超上限', () => {
  const root = tmpRoot()
  const d = refreshDrives(root, PID, { hoursSinceMaster: 48 })
  assert.ok(d.connect > DRIVE_BASE.connect, '越久没说话，越会想')
  assert.ok(d.connect <= DRIVE_CAP)

  const far = refreshDrives(root, PID, { hoursSinceMaster: 24 * 30 })
  assert.equal(far.connect, DRIVE_CAP)
})

test('drives：推进过的值会随半衰期回落基线', () => {
  const root = tmpRoot()
  // 先把它推到高位
  refreshDrives(root, PID, { hoursSinceMaster: 48 })
  const high = readDrives(root, PID).values

  // 再模拟"过了两个半衰期"
  const later = Date.now() + 2 * DRIVE_HALF_LIFE_HOURS * HOUR
  const decayed = refreshDrives(root, PID, { now: later, hoursSinceMaster: 0 })
  const expected = DRIVE_BASE.connect + (high.connect - DRIVE_BASE.connect) * 0.25
  assert.ok(Math.abs(decayed.connect - expected) < 0.05, `应回落到约 ${expected}，实际 ${decayed.connect}`)
})

// ── purposes ────────────────────────────────────────────────────────────

function factOf({ text, created, src, emotional = 16, slot = null, kind = 'fact' }) {
  return { id: `f-${ulid()}`, text, created, src, emotional, slot, kind, until: null }
}

test('mine：带情绪或带槽位的旧事实会变成「惦记」，并带 origin 指针', () => {
  const src = 'raw/2026-11/06/qq.ndjson#01JCV01'
  const mined = minePurposes({ version: 1, items: [] }, [factOf({ text: '面试压力很大', created: hoursAgo(30), src })], {})
  assert.equal(mined.added.length, 1)
  assert.equal(mined.added[0].origin, src)
  assert.equal(mined.added[0].need, 'care', '情绪重的归「关心」')
  assert.match(mined.added[0].text, /后来怎么样/)
})

test('mine：刚说过的不追问，陈年旧账也不翻', () => {
  const mined = minePurposes(
    { version: 1, items: [] },
    [
      factOf({ text: '刚说的难过事', created: hoursAgo(1), src: 'raw/x#a' }),
      factOf({ text: '很久以前的难过事', created: daysAgo(40), src: 'raw/x#b' }),
    ],
    {},
  )
  assert.equal(mined.added.length, 0)
})

test('mine：同一份事实重复挖不重复记；关闭后不复活', () => {
  const src = 'raw/2026-11/06/qq.ndjson#01JCV02'
  const facts = [factOf({ text: '面试没过，心里很难过', created: hoursAgo(30), src })]

  const first = minePurposes({ version: 1, items: [] }, facts, {})
  assert.equal(first.added.length, 1)

  const again = minePurposes({ version: 1, items: first.items }, facts, {})
  assert.equal(again.added.length, 0, '同一个 origin 只惦记一次')

  const closed = closePurpose({ version: 1, items: first.items }, first.items[0].id)
  const after = minePurposes({ version: 1, items: closed.items }, facts, {})
  assert.equal(after.added.length, 0, '关闭后不该复活')
})

test('due：按需求强度排序，并且可以限制条数', () => {
  const items = [
    { id: 'a', need: 'share', text: 'A', status: 'open', due: '2020-01-01T00:00:00+08:00', created: '2020-01-01' },
    { id: 'b', need: 'care', text: 'B', status: 'open', due: '2020-01-01T00:00:00+08:00', created: '2020-02-01' },
    { id: 'c', need: 'care', text: 'C', status: 'done', due: '2020-01-01T00:00:00+08:00', created: '2020-03-01' },
  ]
  const due = duePurposes(items, { care: 0.9, share: 0.1 }, { limit: 1 })
  assert.equal(due.length, 1)
  assert.equal(due[0].id, 'b', '关心 > 分享')
})

test('expire：超过 TTL 的 open 项被标 dropped', () => {
  const doc = { items: [{ id: 'x', status: 'open', created: daysAgo(20), due: daysAgo(20), text: '旧事' }] }
  const changed = expirePurposes(doc)
  assert.equal(changed, 1)
  assert.equal(doc.items[0].status, 'dropped')
})

// ── [惦记] 注入 ─────────────────────────────────────────────────────────

test('contextFor：有条目时注入 [惦记]，并写明"可选"', () => {
  const root = tmpRoot()
  const src = seedRaw(root, '面试')
  addFact(root, PID, { topic: '生活', text: '面试压力很大，有点难过', src, now: hoursAgo(30) })

  const ctx = contextFor(root, PID, { channel: 'private:10001' })
  assert.match(ctx, /\[惦记\]/)
  assert.match(ctx, /别硬塞/)
})

test('contextFor：最多 2 条，每条不超过 120 字节', () => {
  const root = tmpRoot()
  const texts = ['面试没过，很难过', '搬家一直拖，很委屈', '妈妈住院，很担心', '跟他吵架，心里委屈', '连着加班，很心疼']
  for (let i = 0; i < texts.length; i += 1) {
    const src = seedRaw(root, `事${i}`)
    addFact(root, PID, { topic: `主题${i}`, text: texts[i], src, now: hoursAgo(20 + i) })
  }

  const ctx = contextFor(root, PID, { channel: 'private:10001' })
  const line = ctx.split('\n').find((l) => l.startsWith('[惦记]'))
  assert.ok(line, '应该有惦记段')

  const body = line.replace(/^\[惦记\]\s*/, '').replace(/（想提就提.*$/, '')
  const parts = body.split('；')
  assert.ok(parts.length <= 2, `最多 2 条，实际 ${parts.length}`)
  assert.ok(parts.length >= 1)
  for (const p of parts) assert.ok(bytes(p) <= PURPOSE_MAX_BYTES, `单条 ${bytes(p)} 字节`)
})

test('contextFor：没有可惦记的事时，不硬编一段', () => {
  const root = tmpRoot()
  const ctx = contextFor(root, PID, {})
  assert.ok(!ctx.includes('[惦记]'))
})
