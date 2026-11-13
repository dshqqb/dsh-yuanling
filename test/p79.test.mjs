// test/p79.test.mjs —— 好友关系是账户卡上的平台事实（2026-11-13）
import { test, before } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { scaffold } from '../src/core/scaffold.js'
import { ingest } from '../src/core/inbox.js'
import { findByIdentity, readProfile } from '../src/core/entities.js'
import { accountForNative, ensureAccount, ensurePersonForAccount, loadAccount, setAccountFriend } from '../src/core/accounts.js'
import { contextFor } from '../src/core/memory.js'
import { localIso } from '../src/core/fsx.js'

const PID = 'yuanling'
let root

before(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'yuanling-p79-'))
  scaffold(root, {})
})

let seq = 0
function send({ channel, actorId, actorName, text = '你好', friend = false, remark = '' }) {
  seq += 1
  return ingest(root, {
    v: 1,
    source: 'qq',
    acct: '2823503286',
    items: [
      {
        channel,
        kind: 'msg',
        role: 'user',
        ext_id: `x-${seq}`,
        ts: localIso(),
        text: `${text} #${seq}`,
        actor: {
          kind: channel.startsWith('group:') ? 'member' : 'owner',
          id: String(actorId),
          name: actorName,
          ...(friend ? { friend: true } : {}),
          ...(remark ? { remark } : {}),
        },
      },
    ],
  })
}

test('私聊好友：账户上记 friend + 备注写进描述', () => {
  send({ channel: 'private:70001', actorId: '70001', actorName: '小李', friend: true, remark: '老李' })
  const acct = accountForNative(root, PID, 'qq', '70001')
  const card = loadAccount(root, PID, acct)
  assert.equal(card.friend, true)
  assert.match(card.description, /好友备注：老李/)
})

test('备注没变时不重复追加（账户描述不做流水账）', () => {
  const acct = accountForNative(root, PID, 'qq', '70001')
  const before = loadAccount(root, PID, acct).description
  send({ channel: 'private:70001', actorId: '70001', actorName: '小李', friend: true, remark: '老李' })
  assert.equal(loadAccount(root, PID, acct).description, before)
})

test('不是好友：friend=false，描述不被写', () => {
  send({ channel: 'private:70002', actorId: '70002', actorName: '陌生人' })
  const acct = accountForNative(root, PID, 'qq', '70002')
  const card = loadAccount(root, PID, acct)
  assert.equal(card.friend, false)
  assert.equal(card.description, '')
})

test('注入：人物卡里有 QQ 号 + 好友 + 备注', () => {
  const uid = findByIdentity(root, 'qq', '70001').uid
  assert.ok(readProfile(root, PID, uid), '私聊过的人有 profile')
  const ctx = contextFor(root, PID, { channel: `private:${uid}` })
  assert.match(ctx, /小李（qq:70001）/)
  assert.match(ctx, /好友（备注「老李」）/)
})

test('群里说话的好友：账户上记好友，但仍然是影子（不建档）', () => {
  send({ channel: 'group:80001', actorId: '70003', actorName: '群友', friend: true, remark: '同事' })
  const acct = accountForNative(root, PID, 'qq', '70003')
  const card = loadAccount(root, PID, acct)
  assert.equal(card.friend, true)
  assert.match(card.description, /好友备注：同事/)
  assert.equal(readProfile(root, PID, findByIdentity(root, 'qq', '70003').uid), null)
})

test('好友关系按账户存：两个号可以一个是一个不是', () => {
  const first = findByIdentity(root, 'qq', '70001')
  const r = ensureAccount(root, PID, { platform: 'bili', nativeId: 'bili-1', nickname: '小李B站' })
  ensurePersonForAccount(root, PID, r.acct)
  setAccountFriend(root, PID, r.acct, false)
  assert.equal(loadAccount(root, PID, r.acct).friend, false)
  assert.equal(loadAccount(root, PID, first.acct).friend, true)
})
