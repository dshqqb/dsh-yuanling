// test/p58.test.mjs —— 动机层可以由她自己改（Q14 选 B）。
//
// 用户的规矩（2026-11-10）：
//   · 她可以调权重、可以加新动机；
//   · 加新动机**必须给关键词**（"听到什么会更有劲"）——记忆/消息里撞上就升温，
//     也能生成属于它的「惦记」（这条是 B 与 A 的区别）；
//   · 单次 ≤±0.2、一天最多 6 次、必须带 reason、进版本历史；
//   · 名字 ≤12 字；内置 5 个不能删；自定义最多 3 个（总共 8）。
import { test, before } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { scaffold } from '../src/core/scaffold.js'
import { appendRecord } from '../src/core/raw.js'
import { localIso } from '../src/core/fsx.js'
import { addFact } from '../src/core/memory.js'
import {
  readDrives,
  addDrive,
  adjustDrive,
  removeDrive,
  noteDriveHits,
  matchDrive,
  DRIVE_NEEDS,
  DRIVE_LIMITS,
  refreshDrives,
  driveName,
} from '../src/core/drives.js'
import { minePurposes, duePurposes } from '../src/core/purposes.js'
import { personaExtraLines } from '../src/core/memory.js'
import { contextFor } from '../src/core/memory.js'
import { ingest } from '../src/core/inbox.js'
import { readMarker } from '../src/core/persona.js'
import { history } from '../src/core/version.js'

const PID = 'yuanling'
const DAY = 86_400_000
let root

before(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'yuanling-p58-'))
  scaffold(root, {})
})

function seedRaw(text = '一句话') {
  const r = appendRecord(root, {
    source: 'qq',
    acct: '1',
    channel: 'private:1',
    actor: { kind: 'owner', id: '1', name: '主人' },
    role: 'user',
    text,
    ts: localIso(),
  })
  return `${r.file}#${r.id}`
}

function newDrive(name = '弄明白报错', keywords = ['报错', 'bug']) {
  const d = addDrive(root, PID, { name, keywords, reason: '最近老遇到' })
  return d.custom.find((x) => x.name === name)
}

test('内置五维仍然是基线，读出来就有值', () => {
  const d = readDrives(root, PID)
  for (const need of DRIVE_NEEDS) assert.ok(Number.isFinite(d.values[need]))
  assert.deepEqual(d.custom, [])
})

test('add：必须给关键词和 reason；名字有长度上限', () => {
  assert.throws(() => addDrive(root, PID, { name: '空动机', keywords: [], reason: 'x' }), /关键词/)
  assert.throws(() => addDrive(root, PID, { name: '没原因', keywords: ['a'] }), /reason/)
  assert.throws(() => addDrive(root, PID, { name: '这个动机名字实在是太长了根本放不下', keywords: ['a'], reason: 'x' }), /最多 12 字/)
})

test('add：加成功之后有值、有名字、出现在注入里', () => {
  const d = newDrive('弄明白报错', ['报错'])
  assert.ok(d.id)
  assert.equal(readDrives(root, PID).custom.length, 1)
  assert.ok(Number.isFinite(readDrives(root, PID).values[d.id]))

  adjustDrive(root, PID, { need: d.id, delta: 0.2, reason: '最近真的一直在查' })
  const lines = personaExtraLines(root, PID)
  const motive = lines.find((l) => l.startsWith('[动机]'))
  assert.ok(motive, '应该有一行 [动机]')
  assert.match(motive, /弄明白报错/, '自定义动机要叫得出名字')
})

test('adjust：超过 ±0.2 拒绝，没 reason 拒绝，不认识的动机拒绝', () => {
  const d = readDrives(root, PID).custom[0]
  assert.throws(() => adjustDrive(root, PID, { need: d.id, delta: 0.5, reason: 'x' }), /最多调/)
  assert.throws(() => adjustDrive(root, PID, { need: d.id, delta: 0.05 }), /reason/)
  assert.throws(() => adjustDrive(root, PID, { need: 'drive_nope', delta: 0.1, reason: 'x' }), /没有这个动机/)
})

test('adjust：一天最多 6 次', () => {
  const d = readDrives(root, PID).custom[0]
  let rejected = null
  for (let i = 0; i < 10; i += 1) {
    try {
      adjustDrive(root, PID, { need: d.id, delta: 0.02, reason: `第 ${i} 次` })
    } catch (e) {
      rejected = e
      break
    }
  }
  assert.ok(rejected, '超过 6 次应该被拒绝')
  assert.match(rejected.message, /今天已经调过/)
})

test('adjust：改的是落盘值，并且进了版本历史', () => {
  const d = readDrives(root, PID).custom[0]
  const before = readDrives(root, PID).values[d.id]
  // 换一天（手动清掉今天的记账），确认写入本身是有效的
  const abs = path.join(root, 'personas', PID, 'self', 'drives.json')
  const j = JSON.parse(fs.readFileSync(abs, 'utf8'))
  j.changes = []
  fs.writeFileSync(abs, JSON.stringify(j, null, 2), 'utf8')

  adjustDrive(root, PID, { need: d.id, delta: 0.1, reason: '再确认一下' })
  assert.ok(readDrives(root, PID).values[d.id] >= before)
  assert.ok(history(root, `personas/${PID}/self/drives.json`).length >= 1, '应该进版本历史')
})

test('关键词撞上就升温（消息入库时也算）', () => {
  const d = readDrives(root, PID).custom[0]
  const before = readDrives(root, PID).values[d.id]
  const hits = noteDriveHits(root, PID, '这个报错又出现了')
  assert.equal(hits.length, 1)
  assert.ok(readDrives(root, PID).values[d.id] > before)
})

test('入库：消息里出现关键词会自动升温', () => {
  const d = readDrives(root, PID).custom[0]
  const before = readDrives(root, PID).values[d.id]
  ingest(root, {
    v: 1,
    source: 'qq',
    acct: '1',
    items: [{ ts: localIso(), channel: 'private:1', kind: 'msg', actor: { kind: 'owner', id: '1' }, text: '又报错了' }],
  })
  assert.ok(readDrives(root, PID).values[d.id] > before)
})

test('目的挖掘：撞上关键词的平淡事实也能长出一条目的，而且用的是这个动机', () => {
  const d = readDrives(root, PID).custom[0]
  const src = seedRaw('那个报错到底怎么回事')
  const created = localIso(new Date(Date.now() - 12 * 3_600_000))
  const facts = [
    {
      id: 'f1',
      text: '那个报错一直没修好',
      topic: '工作',
      src,
      created,
      emotional: 0,
      slot: null,
    },
  ]
  const { items } = minePurposes({ items: [] }, facts, { now: Date.now(), customDrives: readDrives(root, PID).custom })
  assert.equal(items.length, 1, '有关键词命中就该产生目的')
  assert.equal(items[0].need, d.id, '这条目的的动机应该是那个自定义动机')
})

test('目的排序：自定义动机强度高时，属于它的惦记排在前面', () => {
  const d = readDrives(root, PID).custom[0]
  const values = { ...readDrives(root, PID).values, [d.id]: 0.9, share: 0.2 }
  const base = { status: 'open', due: localIso(new Date(Date.now() - 1000)), created: localIso(), hits: 0, offered: 0 }
  const items = [
    { ...base, id: 'p1', need: 'share', text: '分享一件小事' },
    { ...base, id: 'p2', need: d.id, text: '那个报错后来怎么样了' },
  ]
  const picked = duePurposes(items, values, { limit: 1 })
  assert.equal(picked[0].id, 'p2', '强度高的动机对应的惦记先摆')
})

test('remove：内置五维不能删；自定义可以删', () => {
  assert.throws(() => removeDrive(root, PID, { need: 'care', reason: 'x' }), /内置/)
  const d = readDrives(root, PID).custom[0]
  removeDrive(root, PID, { need: d.id, reason: '不再在意了' })
  assert.equal(readDrives(root, PID).custom.length, 0)
  assert.equal(readDrives(root, PID).values[d.id], undefined)
})

test('上限：自定义最多 3 个（内置 5 + 自定义 3 = 8）', () => {
  const names = ['甲动机', '乙动机', '丙动机', '丁动机']
  let rejected = null
  for (const n of names) {
    try {
      addDrive(root, PID, { name: n, keywords: [`kw${n}`], reason: 'x' })
    } catch (e) {
      rejected = e
      break
    }
  }
  assert.ok(rejected, '第 4 个应该被拒绝')
  assert.match(rejected.message, /最多 3 个/)
  assert.equal(readDrives(root, PID).custom.length, DRIVE_LIMITS.maxCustom)
})

test('衰减：自定义动机也会回落到自己的基线', () => {
  const d = readDrives(root, PID).custom[0]
  // 拉高
  adjustDrive(root, PID, { need: d.id, delta: 0.2, reason: 'x' }).before
  const high = readDrives(root, PID).values[d.id]
  const after = refreshDrives(root, PID, { now: Date.now() + 48 * 3_600_000 })
  assert.ok(after[d.id] < high, '48 小时后应该回落')
  assert.ok(after[d.id] >= d.base - 0.01, '但不低于它自己的基线')
})

test('名字：driveName 认识内置与自定义，注入用中文名', () => {
  const drv = readDrives(root, PID)
  assert.equal(driveName(drv, 'care'), '想关心你')
  assert.equal(driveName(drv, drv.custom[0].id), drv.custom[0].name)
})

test('matchDrive：没有自定义动机时永远不命中', () => {
  assert.equal(matchDrive('报错', []), null)
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'yuanling-p58b-'))
  scaffold(empty, {})
  assert.equal(matchDrive('报错', readDrives(empty, PID).custom), null)
})

test('注入预览：动机行不进 [惦记]，两者是分开的两行', () => {
  const d = readDrives(root, PID).custom[0]
  adjustDrive(root, PID, { need: d.id, delta: 0.15, reason: 'x' })
  const ctx = contextFor(root, PID, { preview: true })
  if (ctx.includes('[动机]')) assert.ok(!/\[动机\][^\n]*\[惦记\]/.test(ctx))
})
