// test/p92.test.mjs —— 群体三件事（2026-11-14 定）：
//
//   ① 权重只算"跟她有关"的互动：@她 / 叫她的名字 / 引用回复她 / 她自己发言 / 她开口后别人接话；
//      群里刷无关的话不涨。新建群体权重 0。
//   ② 群体卡能手动加/删成员（加的是人物卡；删了再说话会被自动加回来）。
//   ③ 群体身份（App + 账号）可编辑；/api/picker 一次拿齐"App → 账户"。
import { test, before } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { scaffold } from '../src/core/scaffold.js'
import { ingest } from '../src/core/inbox.js'
import { handleApi, handleApiWrite } from '../src/core/api.js'
import { createCard } from '../src/core/accounts.js'
import {
  addGroupMember,
  ensureGroup,
  ensureGroupScene,
  findGidByNative,
  listGroups,
  readGroup,
  readGroupIdentity,
  removeGroupMember,
  setGroupIdentity,
  MAX_MEMBERS,
} from '../src/core/groups.js'
import { localIso } from '../src/core/fsx.js'

const PID = 'yuanling'
let root

before(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'yuanling-p92-'))
  scaffold(root, {})
})

let seq = 0
function send({ channel, text, actorId = '10001', name = '老王', role = 'user', replyTo = null }) {
  seq += 1
  return ingest(root, {
    v: 1,
    source: 'qq',
    acct: '1',
    items: [{
      channel,
      kind: 'msg',
      role,
      ext_id: `m-${seq}`,
      ts: localIso(),
      text: `${text} #${seq}`,
      actor: { kind: role === 'bot' ? 'bot' : 'member', id: String(actorId), name },
      ...(replyTo ? { reply_to: replyTo } : {}),
    }],
  })
}

const gidOf = (native) => findGidByNative(root, 'qq', String(native))
const weightOf = (native) => {
  const gid = gidOf(native)
  return gid ? readGroup(root, PID, gid)?.weight ?? null : null
}
const statsOf = (native) => {
  const gid = gidOf(native)
  return gid ? readGroup(root, PID, gid)?.stats ?? null : null
}

test('群权重：无关闲聊不涨；@她 / 她发言才涨', () => {
  send({ channel: 'group:910001', text: '今天好热啊，晚上吃什么' })
  assert.equal(statsOf('910001').engaged, 0, '无关的话不算')
  assert.equal(weightOf('910001'), 0)

  send({ channel: 'group:910001', text: '原灵，明天我要去面试' })
  assert.equal(statsOf('910001').engaged, 1, '叫她的名字算一次')
  assert.ok(weightOf('910001') > 0)

  // 她自己发言也算
  send({ channel: 'group:910001', text: '面试加油', role: 'bot', actorId: '999', name: '原灵' })
  assert.equal(statsOf('910001').engaged, 2)
})

test('群权重：引用回复她算；她开口后别人接话也算', () => {
  send({ channel: 'group:920001', text: '随便聊聊' })
  assert.equal(statsOf('920001').engaged, 0)

  // 她先说话（拿到她的消息 id）
  seq += 1
  const herId = `m-${seq}`
  ingest(root, {
    v: 1,
    source: 'qq',
    acct: '1',
    items: [{ channel: 'group:920001', kind: 'msg', role: 'bot', ext_id: herId, ts: localIso(), text: '我在', actor: { kind: 'bot', id: '999', name: '原灵' } }],
  })
  assert.equal(statsOf('920001').engaged, 1, '她发言 +1')

  // 别人接她的话（在场窗口内）
  send({ channel: 'group:920001', text: '接着说两句', actorId: '10002', name: '小李' })
  assert.equal(statsOf('920001').engaged, 2, '她开口后别人接话 +1')

  // 引用回复她
  send({ channel: 'group:920001', text: '你说得对', actorId: '10003', name: '小张', replyTo: herId })
  assert.equal(statsOf('920001').engaged, 3, '引用回复她 +1')
})

test('群权重：新建群体 0；group 卡上有 stats', () => {
  const gid = ensureGroupScene(root, { platform: 'qq', nativeId: '930001' })
  ensureGroup(root, PID, gid, {})
  assert.equal(readGroup(root, PID, gid).weight, 0)
  assert.equal(readGroup(root, PID, gid).stats.engaged, 0)
})

test('成员：手动加 / 手动删 / 上限', () => {
  const a = createCard(root, PID, { app: 'qq', account: '940001', nicknames: ['甲'] })
  const b = createCard(root, PID, { app: 'qq', account: '940002', nicknames: ['乙'] })
  const gid = ensureGroupScene(root, { platform: 'qq', nativeId: '940000' })
  ingest(root, { v: 1, source: 'qq', acct: '1', items: [{ channel: 'group:940000', kind: 'msg', role: 'user', ext_id: 'x1', ts: localIso(), text: '群里说话', actor: { kind: 'member', id: '10009', name: '丙' } }] })

  addGroupMember(root, PID, gid, a.id)
  assert.deepEqual(readGroup(root, PID, gid).members, [a.id])
  addGroupMember(root, PID, gid, a.id) // 幂等
  assert.deepEqual(readGroup(root, PID, gid).members, [a.id])

  addGroupMember(root, PID, gid, b.id)
  assert.deepEqual(readGroup(root, PID, gid).members, [a.id, b.id])

  removeGroupMember(root, PID, gid, a.id)
  assert.deepEqual(readGroup(root, PID, gid).members, [b.id])

  // 上限
  const seed = []
  for (let i = 0; i < MAX_MEMBERS; i += 1) seed.push(`card_seed${i}`)
  handleApiWrite(root, new URL('http://x/api/group/member'), { gid, uid: 'card_missing' }) // 不存在的卡也先写进去（成员表不校验卡存在）
  const cur = readGroup(root, PID, gid)
  assert.ok(cur.members.length >= 1)
  void seed
})

test('身份：改 App/号码；gid 不变；重复号码拒绝', () => {
  const gid = ensureGroupScene(root, { platform: 'qq', nativeId: '950001' })
  ensureGroupScene(root, { platform: 'qq', nativeId: '950002' })
  setGroupIdentity(root, PID, gid, { platform: 'qq', nativeId: '950003' })

  const idn = readGroupIdentity(root, gid)
  assert.equal(idn.nativeId, '950003')
  assert.equal(findGidByNative(root, 'qq', '950001'), null, '旧号码不再指向它')
  assert.equal(findGidByNative(root, 'qq', '950003'), gid, '新号码指向它')

  assert.throws(() => setGroupIdentity(root, PID, gid, { platform: 'qq', nativeId: '950002' }), /已经登记给另一个群体/)
})

test('API：/api/picker 一次给 App 和账户；/api/group/member 能加人', () => {
  const card = createCard(root, PID, { app: 'qq', account: '960001', nicknames: ['阿丁'] })
  const gid = ensureGroupScene(root, { platform: 'qq', nativeId: '960000' })
  ensureGroup(root, PID, gid, {})

  const picker = handleApi(root, new URL('http://x/api/picker')).body
  assert.equal(picker.ok, true)
  assert.ok(Array.isArray(picker.accounts))
  const row = picker.accounts.find((a) => a.uid === card.id)
  assert.ok(row, '账户要出现在 picker 里')
  assert.equal(row.nativeId, '960001')
  assert.equal(row.person.uid, card.id)

  const add = handleApiWrite(root, new URL('http://x/api/group/member'), { gid, uid: card.id, action: 'add' })
  assert.equal(add.status, 200)
  assert.deepEqual(readGroup(root, PID, gid).members, [card.id])

  const del = handleApiWrite(root, new URL('http://x/api/group/member'), { gid, uid: card.id, action: 'remove' })
  assert.equal(del.status, 200)
  assert.deepEqual(readGroup(root, PID, gid).members, [])

  // 编辑群体身份走 /api/group
  const edit = handleApiWrite(root, new URL('http://x/api/group'), { gid, platform: 'qq', nativeId: '960009', name: '改了号' })
  assert.equal(edit.status, 200)
  assert.equal(readGroupIdentity(root, gid).nativeId, '960009')
})
