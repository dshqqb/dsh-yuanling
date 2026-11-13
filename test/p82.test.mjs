// test/p82.test.mjs —— 入库建卡 / 权重 / raw 场景（每账户一张）。
import { test, before } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { scaffold } from '../src/core/scaffold.js'
import { ingest } from '../src/core/inbox.js'
import { listDays, readDay } from '../src/core/raw.js'
import { listCards, cardByAccount, mergeCards, mainOf, personWeight } from '../src/core/accounts.js'
import { findByIdentity, listPeopleForUi } from '../src/core/entities.js'

const PID = 'yuanling'
let root

before(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'yuanling-p82-'))
  scaffold(root, {})
})

function send(id, text, { channel = 'private:61001', name = '小甲', actorId = '61001' } = {}) {
  ingest(root, {
    v: 1,
    source: 'qq',
    acct: '2823503286',
    items: [{ channel, kind: 'msg', role: 'user', ext_id: `m-${id}`, ts: new Date(Date.now() + id * 1000).toISOString(), text, actor: { kind: 'member', id: actorId, name } }],
  })
}

function last() {
  const days = listDays(root)
  return readDay(root, days[days.length - 1]).at(-1)
}

test('私聊：建一张卡，raw 场景挂在卡 id 上', () => {
  send(1, '在吗')
  const id = cardByAccount(root, PID, 'qq', '61001')
  assert.ok(id)
  const card = listCards(root, PID).find((c) => c.id === id)
  assert.deepEqual(card.nicknames, ['小甲'])
  assert.equal(card.stats.messages, 1)
  assert.ok(card.weight > 0)
  const rec = last()
  assert.equal(rec.channel, `private:${id}`)
  assert.equal(rec.channel_native, 'private:qq:61001')
})

test('第二条私聊：同一张卡统计累加', () => {
  send(2, '今天好累')
  const id = cardByAccount(root, PID, 'qq', '61001')
  assert.equal(listCards(root, PID).find((c) => c.id === id).stats.messages, 2)
})

test('群聊旁听：建卡但不进人物页（影子）', () => {
  send(3, '冒泡', { channel: 'group:123456', actorId: '77777', name: '路人乙' })
  const id = cardByAccount(root, PID, 'qq', '77777')
  assert.ok(id)
  assert.equal(listPeopleForUi(root, PID).some((r) => r.uid === id), false)
})

test('合并：账户权重不变，人物权重求和', () => {
  send(4, '我 b 站叫小明', { channel: 'private:61002', actorId: '61002', name: '小明' })
  const a = cardByAccount(root, PID, 'qq', '61001')
  const b = cardByAccount(root, PID, 'qq', '61002')
  const wa = listCards(root, PID).find((c) => c.id === a).weight
  const wb = listCards(root, PID).find((c) => c.id === b).weight
  const r = mergeCards(root, PID, [a, b])
  assert.equal(listCards(root, PID).find((c) => c.id === a).weight, wa)
  assert.equal(listCards(root, PID).find((c) => c.id === b).weight, wb)
  assert.equal(mainOf(root, PID, a), r.main)
  assert.equal(personWeight(root, PID, r.main), Math.min(100, wa + wb))
})

test('findByIdentity 返回主卡', () => {
  const hit = findByIdentity(root, 'qq', '61002')
  assert.ok(hit)
  assert.equal(hit.uid, mainOf(root, PID, hit.acct))
})
