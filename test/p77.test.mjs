// test/p77.test.mjs —— 未知 QQ / 未知群：路人名册 + 群名（2026-11-11, Q38=A；2026-11-14 改）
//
// 用户定的：
//   · **没说过话就没有卡**：群里第一次见的人什么都不记（用户 2026-11-14 取消路人概念）；
//   · 群卡以前没有名字（ensureGroup 不带 name），现在由适配器带 `group_name`；
//   · 路人不进注入、人物页没有，也**不算成员名单**里的"认识的人"；
//   · 名字只补空、不覆盖人写过的；补名走自动建卡同一条路（撞名自动加标识）。
import { test, before } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { scaffold } from '../src/core/scaffold.js'
import { ingest } from '../src/core/inbox.js'
import { readGroup, ensureGroupScene } from '../src/core/groups.js'
import { readGroupIdentity, findGidByNative } from '../src/core/channels.js'
import { loadIdentities, findByIdentity, listPeopleForUi } from './helpers.mjs'
import { localIso } from '../src/core/fsx.js'

const PID = 'yuanling'
let root

before(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'yuanling-p77-'))
  scaffold(root, {})
})

let seq = 0
function ingestGroup({ groupId, userId = '20002', actorName = '', groupName = '', role = 'user', text = '今天谁值班' }) {
  seq += 1
  const item = {
    channel: `group:${groupId}`,
    kind: 'msg',
    role,
    ext_id: `g${groupId}-${seq}`,
    ts: localIso(),
    // 正文也带序号：raw 的幂等是按内容算的，同秒同文的两条会被当成重复
    text: `${text} #${seq}`,
    ...(actorName ? { actor: { kind: 'member', id: String(userId), name: actorName } } : { actor: { kind: 'member', id: String(userId) } }),
    ...(groupName ? { group_name: groupName } : {}),
  }
  return ingest(root, { v: 1, source: 'qq', acct: '10001', items: [item] })
}

const groupIdOf = (nativeId) => findGidByNative(root, 'qq', String(nativeId))

test('群名：第一条消息就建卡并带上名字', () => {
  const r = ingestGroup({ groupId: '700001', groupName: '摸鱼群', actorName: '值班员' })
  assert.equal(r.accepted, 1)
  const gid = groupIdOf('700001')
  assert.ok(gid, '群场景要建出来')
  assert.equal(readGroup(root, PID, gid).name, '摸鱼群')
  const idn = readGroupIdentity(root, gid)
  assert.equal(idn.platform, 'qq')
  assert.equal(idn.nativeId, '700001')
})

test('群名撞名：自动加平台标识，不抛错', () => {
  ingestGroup({ groupId: '700002', groupName: '摸鱼群', actorName: '另一个人' })
  const gid = groupIdOf('700002')
  assert.equal(readGroup(root, PID, gid).name, '(QQ) 摸鱼群')
})

test('后到的群名：只补空名字，不覆盖人写过的', () => {
  // 先建一个没有名字的群（模拟老适配器 / 第一次接口失败）
  const emptyGid = ensureGroupScene(root, { platform: 'qq', nativeId: '700003' })
  ingestGroup({ groupId: '700003', actorName: '甲' })
  assert.equal(readGroup(root, PID, emptyGid).name, '')

  ingestGroup({ groupId: '700003', groupName: '后来的名字', actorName: '乙' })
  assert.equal(readGroup(root, PID, emptyGid).name, '后来的名字')

  // 已经有名字了：再来一个不同的群名也不能覆盖
  ingestGroup({ groupId: '700003', groupName: '第三个名字', actorName: '丙' })
  assert.equal(readGroup(root, PID, emptyGid).name, '后来的名字')
})

test('群里说话的人：不建卡、不留记录', () => {
  ingestGroup({ groupId: '700004', groupName: '技术群', userId: '30001', actorName: '老王' })
  assert.equal(findByIdentity(root, 'qq', '30001'), null, '没跟她说过话就没有卡')
  assert.ok(!listPeopleForUi(root, PID).some((p) => p.display === '老王'))
})

test('没说过话的人不在成员名单里（重名裁决不该拿陌生人当依据）', () => {
  ingestGroup({ groupId: '700004', userId: '30001', actorName: '老王' })
  const gid = groupIdOf('700004')
  const g = readGroup(root, PID, gid)
  assert.deepEqual(g.members ?? [], [])
})

test('她自己的话（role=bot）不建卡', () => {
  ingestGroup({ groupId: '700005', userId: '99999', actorName: '原灵', role: 'bot', text: '我在' })
  assert.equal(findByIdentity(root, 'qq', '99999'), null)
})

test('私聊陌生人：直接建好友卡，且群名不会串进私聊', () => {
  seq += 1
  const r = ingest(root, {
    v: 1,
    source: 'qq',
    acct: '10001',
    items: [
      {
        channel: 'private:40001',
        kind: 'msg',
        role: 'user',
        ext_id: `p40001-${seq}`,
        ts: localIso(),
        text: '在吗',
        actor: { kind: 'owner', id: '40001', name: '小李' },
        group_name: '不该出现',
      },
    ],
  })
  assert.equal(r.accepted, 1)
  const hit = findByIdentity(root, 'qq', '40001')
  assert.ok(hit)
  assert.equal(loadIdentities(root).people[hit.uid].display, '小李')
})
