// test/p78.test.mjs —— 跟她直接说过话的人才建档（2026-11-12，Q39；2026-11-14 改）
//
// 用户定的口径：
//   · 私聊：每条都算"跟她说话" → 建好友卡；
//   · 群聊：只有 **@ 她 / 引用回复她 / 叫她的名字** 才算；群里旁听的人**什么都不记**；
//   · 档案只写最小内容：名字（QQ 昵称，撞名自动加标识）、初识时间；账户在 identities 里；
//   · 初识 = 第一次直接对话的时间；手动建的卡留空，直到那一刻。
import { test, before } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { scaffold } from '../src/core/scaffold.js'
import { ingest } from '../src/core/inbox.js'
import { findByIdentity, readProfile, renamePersonAuto } from './helpers.mjs'
import { readCard, createCard } from '../src/core/accounts.js'
import { localIso } from '../src/core/fsx.js'

const PID = 'yuanling'
let root

before(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'yuanling-p78-'))
  scaffold(root, {})
})

let seq = 0
function send({ channel, actorId, actorName, text = '你好', role = 'user', replyTo = null, extId = null }) {
  seq += 1
  const item = {
    channel,
    kind: 'msg',
    role,
    ext_id: extId || `x-${seq}`,
    ts: localIso(),
    text: `${text} #${seq}`,
    actor: { kind: channel.startsWith('group:') ? 'member' : 'owner', id: String(actorId), name: actorName },
    ...(replyTo ? { reply_to: replyTo } : {}),
  }
  return ingest(root, { v: 1, source: 'qq', acct: '2823503286', items: [item] })
}

const uidOf = (qq) => findByIdentity(root, 'qq', String(qq))?.uid ?? null

test('私聊：第一次说话就建档（好友），名字用 QQ 昵称，账户在 identities', () => {
  send({ channel: 'private:50001', actorId: '50001', actorName: '小李', text: '在吗' })
  const uid = uidOf('50001')
  assert.ok(uid)
  const profile = readProfile(root, PID, uid)
  assert.ok(profile, '要有一份档案')
  assert.ok(profile.first_met, '要记初识时间')
  assert.equal(profile.sketch, '', '素描留空，等她自己写')
  const card = readCard(root, PID, findByIdentity(root, 'qq', '50001').acct)
  assert.equal(card.nicknames[0], '小李')
  assert.ok(card.firstMet, '初识 = 第一次说话的时间')
})

test('私聊：第二条不重写账户描述', () => {
  const uid = uidOf('50001')
  const before = readProfile(root, PID, uid).sketch
  send({ channel: 'private:50001', actorId: '50001', actorName: '小李', text: '还在吗' })
  assert.equal(readProfile(root, PID, uid).sketch, before)
})

test('群聊：只是说话 → 不建档、不留记录', () => {
  send({ channel: 'group:60001', actorId: '60001', actorName: '老王', text: '今天谁值班' })
  assert.equal(uidOf('60001'), null, '没说过话就没有卡')
})

test('群聊：@ 她 → 建档', () => {
  send({ channel: 'group:60002', actorId: '60002', actorName: '阿强', text: '@2823503286 在吗' })
  const uid = uidOf('60002')
  assert.ok(uid, '被叫到就是好友')
  const hit = findByIdentity(root, 'qq', '60002')
  assert.ok(readCard(root, PID, hit.acct).firstMet, '初识 = 被叫到这一刻')
  assert.ok(readProfile(root, PID, uid))
})

test('群聊：叫她的名字 → 建档', () => {
  send({ channel: 'group:60003', actorId: '60003', actorName: '小美', text: '原灵你觉得呢' })
  assert.ok(uidOf('60003'))
})

test('群聊：引用回复她 → 建档（要能翻回那条 bot 消息）', () => {
  ingest(root, {
    v: 1,
    source: 'qq',
    acct: '2823503286',
    items: [
      {
        channel: 'group:60004',
        kind: 'msg',
        role: 'bot',
        ext_id: 'bot-msg-1',
        ts: localIso(),
        text: '我在',
        actor: { kind: 'member', id: '2823503286', name: '原灵' },
      },
    ],
  })
  send({ channel: 'group:60004', actorId: '60004', actorName: '阿呆', text: '你说的对', replyTo: 'bot-msg-1' })
  assert.ok(uidOf('60004'))
})

test('两个同名的人先后建档：昵称允许相同（人物没有名字）', () => {
  send({ channel: 'group:60005', actorId: '60005', actorName: '老王', text: '在' })
  send({ channel: 'group:60006', actorId: '60006', actorName: '老王', text: '在' })
  send({ channel: 'private:60005', actorId: '60005', actorName: '老王', text: '你好' })
  send({ channel: 'private:60006', actorId: '60006', actorName: '老王', text: '你好' })
  const a = readCard(root, PID, findByIdentity(root, 'qq', '60005').acct)
  const b = readCard(root, PID, findByIdentity(root, 'qq', '60006').acct)
  assert.ok(a.nicknames.includes('老王'))
  assert.ok(b.nicknames.includes('老王'))
  assert.notEqual(findByIdentity(root, 'qq', '60005').uid, findByIdentity(root, 'qq', '60006').uid)
})

test('她给账户加称呼（renamePersonAuto 是账户昵称门面）', () => {
  const uid = uidOf('50001')
  const r = renamePersonAuto(root, PID, uid, '小李（同事）', { reason: '她自己起的名字' })
  assert.deepEqual(r.nicknames, ['小李', '小李（同事）'])
  const card = readCard(root, PID, r.uid)
  assert.ok(card.nicknames.includes('小李（同事）'))
})

test('先旁听、后被叫到：建卡用被叫到那条消息的群名片', () => {
  // 先在群里见过：什么都不记
  send({ channel: 'group:60007', actorId: '60007', actorName: '甲哥', text: '路过' })
  assert.equal(uidOf('60007'), null)

  // 再被叫到 → 建卡，名字来自这条消息
  send({ channel: 'group:60007', actorId: '60007', actorName: '甲哥', text: '@2823503286 你看' })
  const hit = findByIdentity(root, 'qq', '60007')
  assert.ok(hit)
  assert.ok(readCard(root, PID, hit.acct).nicknames.includes('甲哥'))
})

test('手动建的卡：初识为空，第一次说话才写上', () => {
  const card = createCard(root, PID, { app: 'qq', account: '60008', nicknames: ['手建的'] })
  assert.equal(readCard(root, PID, card.id).firstMet, null, '手动建卡没有初识')
  assert.equal(readCard(root, PID, card.id).weight, 0, '手动建卡权重 0')

  send({ channel: 'group:60008', actorId: '60008', actorName: '手建的', text: '@2823503286 在吗' })
  const card2 = readCard(root, PID, card.id)
  assert.ok(card2.firstMet, '被叫到之后写上初识')
  assert.equal(card2.weight, 0, '只是说了一句话，权重还是 0（不算互动）')
})

test('她自己的话（role=bot）不建档', () => {
  ingest(root, {
    v: 1,
    source: 'qq',
    acct: '2823503286',
    items: [
      {
        channel: 'private:2823503286',
        kind: 'msg',
        role: 'bot',
        ext_id: 'bot-self-1',
        ts: localIso(),
        text: '我自己说的话',
        actor: { kind: 'owner', id: '2823503286', name: '原灵' },
      },
    ],
  })
  assert.equal(uidOf('2823503286'), null)
})
