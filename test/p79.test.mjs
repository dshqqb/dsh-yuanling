// test/p79.test.mjs —— 好友关系：适配器说"他是好友"，核心记在身份上（2026-11-12）
//
// 用户定：她应该知道自己聊的人是不是好友。好友关系是**平台事实**，按身份条目存
// （同一个人的两个号可以一个是好友一个不是），不进 raw、不猜。
import { test, before } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { scaffold } from '../src/core/scaffold.js'
import { ingest } from '../src/core/inbox.js'
import { findByIdentity, loadIdentities, readProfile } from '../src/core/entities.js'
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

test('私聊好友：身份上记 friend + remark，只写有变化的一次', () => {
  send({ channel: 'private:70001', actorId: '70001', actorName: '小李', friend: true, remark: '老李' })
  const uid = findByIdentity(root, 'qq', '70001').uid
  const entry = loadIdentities(root).people[uid].identities.find((x) => x.id === '70001')
  assert.equal(entry.friend, true)
  assert.equal(entry.remark, '老李')

  // 备注没变时不重写（身份文件不做流水账）
  const before = JSON.stringify(loadIdentities(root).people[uid])
  send({ channel: 'private:70001', actorId: '70001', actorName: '小李', friend: true, remark: '老李' })
  assert.equal(JSON.stringify(loadIdentities(root).people[uid]), before)
})

test('不是好友：不写 friend，也不写 remark', () => {
  send({ channel: 'private:70002', actorId: '70002', actorName: '陌生人' })
  const uid = findByIdentity(root, 'qq', '70002').uid
  const entry = loadIdentities(root).people[uid].identities.find((x) => x.id === '70002')
  assert.equal(entry.friend, undefined)
  assert.equal(entry.remark, undefined)
})

test('注入：人物卡里有 QQ 号 + 好友 + 备注', () => {
  const uid = findByIdentity(root, 'qq', '70001').uid
  assert.ok(readProfile(root, PID, uid), '私聊过的人有 profile')
  const ctx = contextFor(root, PID, { channel: `private:${uid}` })
  assert.match(ctx, /小李（qq:70001）/)
  assert.match(ctx, /好友（备注「老李」）/)
})

test('群里说话的好友：影子卡上也记好友（关系是平台事实，不是"认识"）', () => {
  send({ channel: 'group:80001', actorId: '70003', actorName: '群友', friend: true, remark: '同事' })
  const uid = findByIdentity(root, 'qq', '70003').uid
  const entry = loadIdentities(root).people[uid].identities.find((x) => x.id === '70003')
  assert.equal(entry.friend, true)
  assert.equal(entry.remark, '同事')
  // 只是群里说话、没 @ 她：仍然是影子（不建档）
  assert.equal(readProfile(root, PID, uid), null)
})

test('好友关系按身份存：同一个人两个号可以一个是一个不是', () => {
  // 手动给 70001 再挂一个 b 站号（不是好友）
  const uid = findByIdentity(root, 'qq', '70001').uid
  const data = loadIdentities(root)
  data.people[uid].identities.push({ platform: 'bili', id: 'bili-1', state: 'observed', confidence: 1, evidence: [], linked_at: localIso() })
  fs.writeFileSync(path.join(root, 'personas', PID, 'entities', 'identities.json'), JSON.stringify(data, null, 2))
  const entry = loadIdentities(root).people[uid].identities.find((x) => x.platform === 'bili')
  assert.equal(entry.friend, undefined)
})
