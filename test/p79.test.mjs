// test/p79.test.mjs —— 好友关系写在账户描述里（不再单独存字段）。
import { test, before } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { scaffold } from '../src/core/scaffold.js'
import { ingest } from '../src/core/inbox.js'
import { cardByAccount, listCards } from '../src/core/accounts.js'
import { contextFor } from '../src/core/memory.js'
import { localIso } from '../src/core/fsx.js'

const PID = 'yuanling'
let root
let seq = 0

before(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'yuanling-p79-'))
  scaffold(root, {})
})

function send({ channel, actorId, actorName, friend = false, remark = '' }) {
  seq += 1
  ingest(root, {
    v: 1,
    source: 'qq',
    acct: '2823503286',
    items: [{
      channel,
      kind: 'msg',
      role: 'user',
      ext_id: `x-${seq}`,
      ts: localIso(),
      text: `你好 #${seq}`,
      actor: { kind: channel.startsWith('group:') ? 'member' : 'owner', id: String(actorId), name: actorName, ...(friend ? { friend: true } : {}), ...(remark ? { remark } : {}) },
    }],
  })
}

test('私聊好友：备注写进账户描述', () => {
  send({ channel: 'private:70001', actorId: '70001', actorName: '小李', friend: true, remark: '老李' })
  const id = cardByAccount(root, PID, 'qq', '70001')
  const card = listCards(root, PID).find((c) => c.id === id)
  assert.match(card.description, /好友备注：老李/)
})

test('不是好友：描述不被写', () => {
  send({ channel: 'private:70002', actorId: '70002', actorName: '陌生人' })
  const id = cardByAccount(root, PID, 'qq', '70002')
  assert.equal(listCards(root, PID).find((c) => c.id === id).description, '')
})

test('注入：人物卡里有 QQ 号 + 好友 + 备注', () => {
  const id = cardByAccount(root, PID, 'qq', '70001')
  const ctx = contextFor(root, PID, { channel: `private:${id}` })
  assert.match(ctx, /小李（qq:70001）/)
  assert.match(ctx, /好友（备注「老李」）/)
})

test('群里说话的好友：账户上写备注，仍是影子', () => {
  send({ channel: 'group:80001', actorId: '70003', actorName: '群友', friend: true, remark: '同事' })
  const id = cardByAccount(root, PID, 'qq', '70003')
  const card = listCards(root, PID).find((c) => c.id === id)
  assert.match(card.description, /好友备注：同事/)
})
