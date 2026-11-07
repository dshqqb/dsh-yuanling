// test/p20.test.mjs —— 回归：低重要度的「最初」不许沉底。
//
// 真机上踩到的：`别用颜文字`（imp=1、origin=true、4 天前）
//   retention = 1 + 18(保护期) = 19 → clarity 判成 gone → 卡片跳过 → 「最初」整段消失。
// 文档说的是"最初不衰减、不淘汰"，代码先做 gone 过滤再看 origin，顺序反了。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { scaffold } from '../src/core/scaffold.js'
import { appendRecord } from '../src/core/raw.js'
import { localIso } from '../src/core/fsx.js'
import { addFact, buildCard, recall } from '../src/core/memory.js'
import { retentionOf, clarityOf, ORIGIN_FLOOR } from '../src/core/retention.js'

const PID = 'yuanling'
const daysAgo = (n) => localIso(new Date(Date.now() - n * 86_400_000))

function tmpRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'yuanling-p20-'))
  scaffold(root, {})
  return root
}

function seedRaw(root, text) {
  const r = appendRecord(root, {
    source: 'qq',
    acct: '10001',
    channel: 'private:10001',
    actor: { kind: 'owner', id: '10001', name: '主人' },
    role: 'user',
    text,
    ts: localIso(),
  })
  return `${r.file}#${r.id}`
}

test('retention：origin 有保底，重要度再低也不会判成 gone', () => {
  const r = retentionOf({ imp: 1, origin: true, created: daysAgo(4) })
  assert.ok(r >= ORIGIN_FLOOR, `origin 保底 ${ORIGIN_FLOOR}，实际 ${r}`)
  assert.notEqual(clarityOf(r), 'gone')
})

test('retention：origin 一年后仍是保底值', () => {
  assert.ok(retentionOf({ imp: 1, origin: true, created: daysAgo(365) }) >= ORIGIN_FLOOR)
})

test('card：低重要度的 origin 事实仍然出现在「最初」段', () => {
  const root = tmpRoot()
  const src = seedRaw(root, '别用颜文字')
  addFact(root, PID, { topic: '说话方式', text: '别用颜文字', src, imp: 1, origin: true, now: daysAgo(4) })

  const card = buildCard(root, PID)
  assert.match(card, /\[最初\]/, '这一段不该消失')
  assert.match(card, /别用颜文字/)
})

test('recall：低重要度的 origin 事实默认也能被召回', () => {
  const root = tmpRoot()
  const src = seedRaw(root, '别用颜文字')
  addFact(root, PID, { topic: '说话方式', text: '别用颜文字', src, imp: 1, origin: true, now: daysAgo(4) })

  const rows = recall(root, PID, '颜文字')
  assert.equal(rows.length, 1, 'origin 不该被 gone 过滤掉')
})

test('不误伤：非 origin 的低分事实照样会沉底', () => {
  const root = tmpRoot()
  const src = seedRaw(root, '随手一提的小事')
  addFact(root, PID, { topic: '杂事', text: '随手一提的小事', src, imp: 1, origin: false, now: daysAgo(30) })

  const r = retentionOf({ imp: 1, origin: false, created: daysAgo(30) })
  assert.equal(clarityOf(r), 'gone')

  const card = buildCard(root, PID)
  assert.ok(!card.includes('随手一提的小事'), '沉底的事实不该进卡片')
})
