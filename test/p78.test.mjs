// test/p78.test.mjs —— 路人卡：跟她直接说过话的人自动建档（2026-11-12，Q39）
//
// 用户定的口径：
//   · 私聊：每条都算"跟她说话" → 建第一份档案（影子卡转正成路人卡）；
//   · 群聊：只有 **@ 她 / 引用回复她 / 叫她的名字** 才算；群里旁听的人仍然只有影子卡；
//   · 档案只写最小内容：名字（QQ 昵称，撞名自动加标识）、初识时间；账户在 identities 里；
//   · 名字与素描可以由她自己改（renamePersonAuto + 已有的 yuanling_observe）。
import { test, before } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { scaffold } from '../src/core/scaffold.js'
import { ingest } from '../src/core/inbox.js'
import { findByIdentity, readProfile, renamePersonAuto } from './helpers.mjs'
import { readCard } from '../src/core/accounts.js'
import { isShadow } from '../src/core/channels.js'
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

test('私聊：第一次说话就建档（影子卡转正），名字用 QQ 昵称，账户在 identities', () => {
  send({ channel: 'private:50001', actorId: '50001', actorName: '小李', text: '在吗' })
  const uid = uidOf('50001')
  assert.ok(uid)
  assert.equal(isShadow(root, uid), false, '说话过的人不再是影子')
  const profile = readProfile(root, PID, uid)
  assert.ok(profile, '要有一份档案')
  assert.ok(profile.first_met, '要记初识时间')
  assert.equal(profile.sketch, '', '素描留空，等她自己写')
  const card = readCard(root, PID, findByIdentity(root, 'qq', '50001').acct)
  assert.equal(card.nicknames[0], '小李')
})

test('私聊：第二条不重写账户描述', () => {
  const uid = uidOf('50001')
  const before = readProfile(root, PID, uid).sketch
  send({ channel: 'private:50001', actorId: '50001', actorName: '小李', text: '还在吗' })
  assert.equal(readProfile(root, PID, uid).sketch, before)
})

test('群聊：只是说话 → 仍是影子卡，不建档', () => {
  send({ channel: 'group:60001', actorId: '60001', actorName: '老王', text: '今天谁值班' })
  const uid = uidOf('60001')
  assert.ok(uid, '影子卡要建（不然同一个人每条都串号）')
  assert.equal(isShadow(root, uid), true)
  assert.equal(readProfile(root, PID, uid)?.tier, 'shadow', '旁听的人不写人物描述')
})

test('群聊：@ 她 → 建档', () => {
  send({ channel: 'group:60002', actorId: '60002', actorName: '阿强', text: '@2823503286 在吗' })
  const uid = uidOf('60002')
  assert.equal(isShadow(root, uid), false)
  assert.ok(readProfile(root, PID, uid))
})

test('群聊：叫她的名字 → 建档', () => {
  send({ channel: 'group:60003', actorId: '60003', actorName: '小美', text: '原灵你觉得呢' })
  const uid = uidOf('60003')
  assert.equal(isShadow(root, uid), false)
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
  const uid = uidOf('60004')
  assert.equal(isShadow(root, uid), false)
})

test('两个同名影子先后转正：昵称允许相同（人物没有名字）', () => {
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

test('她给影子卡改名 = 直接转正', () => {
  send({ channel: 'group:60007', actorId: '60007', actorName: '路人甲', text: '路过' })
  const uid = uidOf('60007')
  assert.equal(isShadow(root, uid), true)
  renamePersonAuto(root, PID, uid, '甲哥', { reason: '她在群里认识了他' })
  assert.equal(isShadow(root, uid), false)
  const card = readCard(root, PID, findByIdentity(root, 'qq', '60007').acct)
  assert.ok(card.nicknames.includes('甲哥'))
})

test('她自己的话（role=bot）不建档、不改名', () => {
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
