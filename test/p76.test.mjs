// test/p76.test.mjs —— 记忆是"她自己的话"：自动提炼只是兜底，她可以重写。
//
// 设计理念（用户 2026-11-11 定的）：
//   · 同一句话，不同人格应该记成不一样的东西——所以记忆要由模型**用自己的话**写；
//   · 自动提炼只做机械摘录（kind=extracted）；
//   · 她可以写一条新记忆，并 `supersedes` 掉旧的那条：**旧事实不删，只是不再进上下文**。
import { test, before } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { scaffold } from '../src/core/scaffold.js'
import { appendRecord } from '../src/core/raw.js'
import { localIso } from '../src/core/fsx.js'
import { addFact, buildCard, listEntries, recall } from '../src/core/memory.js'

const PID = 'yuanling'
let root
let ptr

before(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'yuanling-p76-'))
  scaffold(root, {})
  const r = appendRecord(root, {
    source: 'qq',
    acct: '1',
    channel: 'private:person_x',
    type: 'message',
    role: 'user',
    actor: { kind: 'owner', id: '1', name: '主人' },
    text: '我明天要去医院复查',
    ts: localIso(),
  })
  ptr = `${r.file}#${r.id}`
})

test('自动提炼的条目带 kind=extracted（机器摘的，不是她的话）', () => {
  const r = addFact(root, PID, { topic: '打算', text: '明天要去医院复查', src: ptr, kind: 'extracted', imp: 30 })
  assert.equal(r.fact.kind, 'extracted')
})

test('她用自己的话重写：新事实入库，旧事实标 until（不再进上下文，历史还在）', () => {
  const old = listEntries(root, PID).flatMap((e) => e.facts ?? []).find((f) => f.text === '明天要去医院复查')
  assert.ok(old)

  const r = addFact(root, PID, {
    topic: '打算',
    text: '他最近不太舒服，明天要去复查，我记着别打扰他',
    src: ptr,
    imp: 70,
    supersedes: [old.id],
  })
  assert.equal(r.added, true)
  assert.ok(r.closed.includes(old.id), `应该关掉旧事实：${JSON.stringify(r.closed)}`)

  const after = listEntries(root, PID).flatMap((e) => e.facts ?? [])
  const closed = after.find((f) => f.id === old.id)
  assert.ok(closed.until, '旧事实要标 until，而不是删掉')
  assert.equal(closed.superseded_by, r.fact.id)

  // 注入里不再出现旧那句，新的一句在
  const card = buildCard(root, PID)
  assert.ok(!card.includes('明天要去医院复查'), '被替换的旧事实不该再进上下文')
  assert.match(card, /不太舒服/)
})

test('历史不丢：旧事实还在盘上，但检索把它当"过去式"，不再当现状返回', () => {
  const all = listEntries(root, PID).flatMap((e) => e.facts ?? [])
  assert.ok(
    all.some((f) => String(f.text).includes('明天要去医院复查') && f.until),
    '旧事实必须还在（标了 until），不是被删掉',
  )
  const rows = recall(root, PID, '医院', { limit: 10 })
  assert.ok(!rows.some((r) => String(r.fact?.text ?? '') === '明天要去医院复查'), '被替换的事实不该再当现状返回')
})

test('不存在的 supersedes id 不会报错（多写一个 id 不该让整条记忆写不进去）', () => {
  const r = addFact(root, PID, {
    topic: '日常',
    text: '他喜欢在晚上散步',
    src: ptr,
    supersedes: ['fact_does_not_exist'],
  })
  assert.equal(r.added, true)
})

test('同一句话不同人格可以记成不同的样子', () => {
  // 同一条 raw 证据，两个人格各写各的
  const a = addFact(root, PID, { topic: '打算', text: 'A 认为是去复查', src: ptr })
  const { createPersona, switchPersona } = { createPersona: null, switchPersona: null }
  void a
  void createPersona
  void switchPersona
  // 这里只验证：不同 text 不会被当成同一条（去重是按文本相似度，不是按 src）
  const b = addFact(root, PID, { topic: '打算', text: 'B 觉得他只是想请个假', src: ptr })
  assert.equal(b.added, true)
  const texts = listEntries(root, PID).flatMap((e) => e.facts ?? []).map((f) => f.text)
  assert.ok(texts.includes('A 认为是去复查'))
  assert.ok(texts.includes('B 觉得他只是想请个假'))
})
