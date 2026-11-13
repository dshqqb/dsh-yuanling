// test/p82.test.mjs —— 账户卡自动建立 / 权重 / raw 场景（2026-11-13）
import { test, before } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { scaffold } from '../src/core/scaffold.js'
import { ingest } from '../src/core/inbox.js'
import { listDays, readDay } from '../src/core/raw.js'
import {
  accountForNative,
  accountsForPerson,
  loadAccount,
  mergeAccounts,
  personForAccount,
  personWeight,
  setAccountDescription,
  setAccountFriend,
} from '../src/core/accounts.js'
import { findByIdentity, readProfile } from '../src/core/entities.js'

const PID = 'yuanling'
let root

before(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'yuanling-p82-'))
  scaffold(root, {})
})

function send(id, text, { channel = 'private:61001', name = '小甲' } = {}) {
  ingest(root, {
    v: 1,
    source: 'qq',
    acct: '2823503286',
    items: [
      {
        channel,
        kind: 'msg',
        role: 'user',
        ext_id: `m-${id}`,
        ts: new Date(Date.now() + id * 1000).toISOString(),
        text,
        actor: { kind: 'owner', id: '61001', name },
      },
    ],
  })
}

function lastRecord() {
  const days = listDays(root)
  const day = days[days.length - 1]
  const recs = readDay(root, day)
  return recs[recs.length - 1]
}

test('私聊入库：自动建账户 + 人物，raw 场景挂在账户上', () => {
  send(1, '在吗')
  const acct = accountForNative(root, PID, 'qq', '61001')
  assert.ok(acct, '应该有账户卡')
  const person = personForAccount(root, PID, acct)
  assert.ok(person, '应该有 1:1 人物')
  assert.ok(readProfile(root, PID, person.uid), '私聊要建人物档案')

  const r = lastRecord()
  assert.equal(r.channel, `private:${acct}`)
  assert.equal(r.channel_native, 'private:qq:61001')
  const card = loadAccount(root, PID, acct)
  assert.deepEqual(card.nicknames, ['小甲'])
  assert.equal(card.stats.messages, 1)
  assert.ok(card.weight > 0, '一条消息也该有权重')
})

test('第二条私聊：账户统计累加，权重跟着涨', () => {
  const acct = accountForNative(root, PID, 'qq', '61001')
  const before = loadAccount(root, PID, acct).weight
  send(2, '今天好累')
  const card = loadAccount(root, PID, acct)
  assert.equal(card.stats.messages, 2)
  assert.ok(card.weight >= before)
})

test('合并：只改人物归属，账户权重/描述不动；人物权重求和', () => {
  const qq = accountForNative(root, PID, 'qq', '61001')
  send(3, '我 b 站叫小明', { channel: 'private:61002', name: '小明' })
  const bili = accountForNative(root, PID, 'qq', '61002')
  setAccountDescription(root, PID, bili, 'B 站同名')
  setAccountFriend(root, PID, bili, true)
  const qqWeight = loadAccount(root, PID, qq).weight
  const biliWeight = loadAccount(root, PID, bili).weight
  const qqDesc = loadAccount(root, PID, qq).description

  const m = mergeAccounts(root, PID, { accounts: [qq, bili], sketch: '同一个人', reason: '自述' })
  assert.equal(accountsForPerson(root, PID, m.person).length, 2)
  assert.equal(loadAccount(root, PID, qq).weight, qqWeight)
  assert.equal(loadAccount(root, PID, bili).weight, biliWeight)
  assert.equal(loadAccount(root, PID, qq).description, qqDesc)
  assert.equal(personWeight(root, PID, m.person), Math.min(100, qqWeight + biliWeight))
})

test('账户描述与人物素描分开：写账户描述不会动人物素描', () => {
  const acct = accountForNative(root, PID, 'qq', '61001')
  const person = personForAccount(root, PID, acct).uid
  setAccountDescription(root, PID, acct, '好友备注：老甲')
  assert.match(loadAccount(root, PID, acct).description, /老甲/)
  assert.equal(readProfile(root, PID, person).sketch, '同一个人')
})

test('群里旁听的人：建账户 + 影子人物，但不建档、不进人物页', () => {
  send(4, '大家好', { channel: 'group:123456', name: '路人乙' })
  const acct = accountForNative(root, PID, 'qq', '61001')
  assert.ok(acct)
  // 群消息的 actor 是 61001（send 固定），已有账户；换一个号测影子
  ingest(root, {
    v: 1,
    source: 'qq',
    acct: '2823503286',
    items: [
      {
        channel: 'group:123456',
        kind: 'msg',
        role: 'user',
        ext_id: 'm-g2',
        ts: new Date().toISOString(),
        text: '冒个泡',
        actor: { kind: 'member', id: '77777', name: '路人乙' },
      },
    ],
  })
  const shadowAcct = accountForNative(root, PID, 'qq', '77777')
  assert.ok(shadowAcct)
  const hit = findByIdentity(root, 'qq', '77777', PID)
  assert.equal(readProfile(root, PID, hit.uid), null, '影子不建档')
})
