// test/p4.test.mjs —— 墓碑：屏蔽、级联隔离、撤销、重建、为什么记得。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { scaffold } from '../src/core/scaffold.js'
import { appendRecord, readDay, today } from '../src/core/raw.js'
import { localIso } from '../src/core/fsx.js'
import { addFact, recall, buildCard, findFact, why } from '../src/core/memory.js'
import { shield, unshield, shieldedSet, isShielded, recentRecordIds, rebuildShields, listShields, shieldsPath } from '../src/core/shield.js'
import { createPersona } from '../src/core/persona.js'

const PID = 'yuanling'

function tmpRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'yuanling-p4-'))
  scaffold(root, {})
  return root
}

function seedRaw(root, text = '今天备份脚本跑到一半断了', ts = localIso()) {
  const r = appendRecord(root, {
    source: 'qq',
    acct: '10001',
    channel: 'group:1',
    actor: { kind: 'owner', id: '10001', name: '主人' },
    role: 'user',
    text,
    ts,
  })
  return { ptr: `${r.file}#${r.id}`, id: r.id }
}

// ── 屏蔽 ────────────────────────────────────────────────────────────────

test('shield：向 raw 追加 redact 事件，原记录一字不动', () => {
  const root = tmpRoot()
  const { ptr, id } = seedRaw(root, '这句话要删掉')

  shield(root, [id], { reason: '用户要求' })

  const recs = readDay(root, today())
  const evt = recs.find((r) => r.type === 'redact')
  assert.ok(evt, '应该追加一条 redact 事件')
  assert.deepEqual(evt.targets, [id])
  assert.equal(evt.by, 'owner')

  // 原始消息还在
  assert.ok(recs.some((r) => r.id === id && r.text === '这句话要删掉'))
  assert.ok(ptr)
})

test('shield：登记簿生效，isShielded 为真', () => {
  const root = tmpRoot()
  const { id } = seedRaw(root)
  shield(root, [id])
  assert.equal(isShielded(root, id), true)
  assert.ok(shieldedSet(root).has(id))
})

test('shield：重复屏蔽同一条是幂等的', () => {
  const root = tmpRoot()
  const { id } = seedRaw(root)
  const a = shield(root, [id])
  assert.ok(a.redaction)

  const b = shield(root, [id])
  assert.equal(b.redaction, null)
  assert.equal(b.already, 1)
})

// ── 级联 ────────────────────────────────────────────────────────────────

test('shield：证据被屏蔽 → 记忆事实级联隔离，检索不到', () => {
  const root = tmpRoot()
  const { ptr, id } = seedRaw(root)
  const r = addFact(root, PID, { topic: '备份', text: '备份脚本的定时任务被宿主收走了', src: ptr })

  const res = shield(root, [id])
  assert.equal(res.cascaded.length, 1)
  assert.equal(res.cascaded[0].factId, r.fact.id)

  assert.equal(recall(root, PID, '备份').length, 0, '被隔离的事实不该出现在检索里')
  assert.equal(recall(root, PID, '备份', { includeShielded: true }).length, 1, '显式要求时才给')
})

test('shield：被隔离的事实不进卡片', () => {
  const root = tmpRoot()
  const { ptr, id } = seedRaw(root)
  addFact(root, PID, { topic: '备份', text: '这句会因为它被屏蔽而消失', src: ptr, imp: 99 })

  shield(root, [id])
  const card = buildCard(root, PID)
  assert.ok(!card.includes('这句会因为它被屏蔽而消失'), '被隔离的内容不该出现在卡片里')
  assert.match(card, /1 条已隔离/)
})

test('shield：级联跨人格（raw 共享，隐私对所有人格一致）', () => {
  const root = tmpRoot()
  const { ptr, id } = seedRaw(root)

  addFact(root, PID, { topic: '备份', text: '第一个人格看到的', src: ptr })
  createPersona(root, 'ling2', '灵二')
  addFact(root, 'ling2', { topic: '备份', text: '第二个人格也看到的', src: ptr })

  const res = shield(root, [id])
  assert.equal(res.cascaded.length, 2, '两个人格的事实都该被隔离')

  assert.equal(recall(root, 'ling2', '备份').length, 0)
})

// ── 撤销 ────────────────────────────────────────────────────────────────

test('unshield：撤销后恢复检索，且留下 unredact 事件', () => {
  const root = tmpRoot()
  const { ptr, id } = seedRaw(root)
  addFact(root, PID, { topic: '备份', text: '恢复后应该能查到', src: ptr })

  shield(root, [id])
  assert.equal(recall(root, PID, '恢复').length, 0)

  const r = unshield(root, [id])
  assert.equal(r.restored.length, 1)
  assert.equal(recall(root, PID, '恢复').length, 1)

  const evt = readDay(root, today()).find((x) => x.type === 'unredact')
  assert.ok(evt, '应该留下 unredact 事件')
  assert.equal(isShielded(root, id), false)
})

test('unshield：没被屏蔽过的记录不产生事件', () => {
  const root = tmpRoot()
  const { id } = seedRaw(root)
  const r = unshield(root, [id])
  assert.equal(r.redaction, null)
  assert.equal(readDay(root, today()).some((x) => x.type === 'unredact'), false)
})

// ── 重建 ────────────────────────────────────────────────────────────────

test('rebuild：登记簿丢了也能从 raw 还原', () => {
  const root = tmpRoot()
  const { id } = seedRaw(root)
  shield(root, [id])

  fs.rmSync(shieldsPath(root))
  assert.equal(isShielded(root, id), false, '登记簿没了就查不到')

  const r = rebuildShields(root)
  assert.ok(r.events >= 1)
  assert.equal(isShielded(root, id), true)
  assert.equal(listShields(root).length, 1)
})

test('rebuild：撤销过的不会被还原成生效', () => {
  const root = tmpRoot()
  const { id } = seedRaw(root)
  shield(root, [id])
  unshield(root, [id])

  fs.rmSync(shieldsPath(root))
  rebuildShields(root)

  assert.equal(isShielded(root, id), false)
})

// ── "刚才" 与 why ───────────────────────────────────────────────────────

test('recent：取最近的消息，跳过系统事件', () => {
  const root = tmpRoot()
  const early = localIso(new Date(Date.now() - 60_000))
  const a = seedRaw(root, '第一条', early)
  const b = seedRaw(root, '第二条')
  shield(root, [a.id]) // 会产生一条 system 事件

  const list = recentRecordIds(root, { last: 2 })
  assert.equal(list.length, 2)
  assert.equal(list[0].id, b.id, '最新的应该是第二条消息')
  assert.ok(!list.some((x) => x.text === ''), '系统事件不该混进来')
})

test('why：给出指针可达性与变更史', () => {
  const root = tmpRoot()
  const { ptr } = seedRaw(root)
  const r = addFact(root, PID, { topic: '备份', text: '备份脚本坏了', src: ptr })

  const w = why(root, PID, r.fact.id)
  assert.equal(w.fact.text, '备份脚本坏了')
  assert.equal(w.src.ok, true)
  assert.equal(w.src.pointer, ptr)
  assert.ok(w.history.length >= 1, '应该有变更史')
  assert.equal(w.shielded, false)

  shield(root, [ptr.split('#').pop()])
  const w2 = why(root, PID, r.fact.id)
  assert.equal(w2.shielded, true)
})

test('why：找不到就返回 null', () => {
  const root = tmpRoot()
  assert.equal(why(root, PID, 'fact_nope'), null)
  assert.equal(findFact(root, PID, 'fact_nope'), null)
})
