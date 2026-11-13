// test/p68.test.mjs —— 名字唯一、昵称写在描述里、提到谁就给谁的卡（3.5 的最后一句）。
//
// 用户定的规则（2026-11-11）：
//   · 名字**永远唯一**；只有"她自动建卡"撞名时才自动加标识（(QQ) 张三），人建的撞名就失败；
//   · 昵称不单独存字段，写在描述里，**允许重复**；
//   · 群聊里昵称撞车 → 用"谁属于这个群"裁决；还不行就跳过（宁可不给，也不给错人）；
//   · 最多 2 张，排在在场者之后。
import { test, before } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { scaffold } from '../src/core/scaffold.js'
import { createPerson, createPersonAuto, findByIdentity, linkIdentity, writeProfile } from '../src/core/entities.js'
import { loadAccount } from '../src/core/accounts.js'
import { setImpression } from '../src/core/impressions.js'
import { createGroupWithCard, readGroup, writeGroup } from '../src/core/groups.js'
import { appendRecord } from '../src/core/raw.js'
import { localIso } from '../src/core/fsx.js'
import { contextFor } from '../src/core/memory.js'
import { ingest } from '../src/core/inbox.js'
import { autoUniqueName } from '../src/core/names.js'
import { extractAliases, mentionedPeople, mentionedGroups } from '../src/core/aliases.js'

const PID = 'yuanling'
let root

before(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'yuanling-p68-'))
  scaffold(root, {})
})

function mkPerson(name, qq) {
  const p = createPerson(root, { display: name })
  linkIdentity(root, p.uid, { platform: 'qq', id: String(qq) })
  writeProfile(root, PID, p.uid, { sketch: name })
  return p
}

test('autoUniqueName：撞名先加平台，再撞带号', () => {
  const taken = new Set(['张三', '(QQ) 张三'])
  const name = autoUniqueName('张三', { platform: 'qq', nativeId: '10001', taken: (n) => taken.has(n) })
  assert.equal(name, '(QQ 10001) 张三')
})

test('她自动建卡：昵称重复也允许（人物没有名字，称呼由账户合并）', () => {
  const a = mkPerson('主人', 90000)
  const auto = createPersonAuto(root, { display: '主人', platform: 'qq', nativeId: '90001' })
  assert.notEqual(auto.uid, a.uid)
  assert.ok(loadAccount(root, PID, findByIdentity(root, 'qq', '90001').acct).nicknames.includes('主人'))

  const auto2 = createPersonAuto(root, { display: '主人', platform: 'qq', nativeId: '90002' })
  assert.notEqual(auto2.uid, auto.uid)
})

test('人建卡：同名不再失败（账户昵称允许重名）', () => {
  const p = createPerson(root, { display: '(QQ) 主人' })
  assert.ok(p.uid)
})

test('extractAliases：只认显式称呼，不把普通句子当昵称', () => {
  assert.deepEqual(extractAliases('大家都叫他老张'), ['老张'])
  assert.deepEqual(extractAliases('外号是胖子，群里都这么叫'), ['胖子'])
  assert.deepEqual(extractAliases('他是我的同事，人挺好'), [])
  assert.deepEqual(extractAliases('简称原灵'), ['原灵'])
})

test('提及：名字唯一 → 直接命中', () => {
  const p = mkPerson('王五', 10005)
  assert.deepEqual(mentionedPeople(root, PID, { text: '王五今天没来' }), [p.uid])
})

test('提及：昵称写在描述里也能命中', () => {
  const p = mkPerson('赵六', 10006)
  setImpression(root, PID, 'person', p.uid, { text: '同事们叫他小六', reason: '测试' })
  assert.deepEqual(mentionedPeople(root, PID, { text: '小六昨天请假了' }), [p.uid])
})

test('提及：昵称撞车 → 用群成员裁决；裁决不了就跳过', () => {
  const a = mkPerson('甲', 10011)
  const b = mkPerson('乙', 10012)
  setImpression(root, PID, 'person', a.uid, { text: '有人叫他老大', reason: '测试' })
  setImpression(root, PID, 'person', b.uid, { text: '也有人叫他老大', reason: '测试' })

  // 没有任何群上下文 → 分不清，跳过
  assert.deepEqual(mentionedPeople(root, PID, { text: '老大说今晚聚餐' }), [])

  // 甲在这个群 → 只能是甲
  assert.deepEqual(
    mentionedPeople(root, PID, { text: '老大说今晚聚餐', groupMembers: [a.uid] }),
    [a.uid],
  )

  // 两个人都在这个群 → 还是分不清，跳过
  assert.deepEqual(mentionedPeople(root, PID, { text: '老大说今晚聚餐', groupMembers: [a.uid, b.uid] }), [])
})

test('注入：提到不在场的人 → 带他的卡（最多 2 张，排在在场者之后）', () => {
  const g = createGroupWithCard(root, PID, { name: '测试群', accountText: 'QQ群 770001' })
  const speaker = mkPerson('说话的人', 20001)
  const talked = mkPerson('被提到的人', 20002)
  setImpression(root, PID, 'person', talked.uid, { text: '大家都叫他老被', reason: '测试' })

  appendRecord(root, {
    source: 'qq',
    acct: '1',
    channel: `group:${g.gid}`,
    type: 'message',
    role: 'user',
    actor: { kind: 'member', id: '20001', name: '说话的人' },
    text: '老被说他明天不来',
    ts: localIso(),
  })

  const ctx = contextFor(root, PID, { channel: `group:${g.gid}` })
  assert.match(ctx, /被提到的人/, '应该带被提到的人的卡')
  assert.match(ctx, /老被/, '昵称要能从描述里认出来')
  assert.ok(ctx.includes(`group:${g.gid}`) || ctx.includes(g.gid), '群体卡也在')
  void speaker
})

test('群体：昵称写在描述里也能被提及找出来', () => {
  const g = createGroupWithCard(root, PID, { name: '技术群', accountText: 'QQ群 770002' })
  writeGroup(root, PID, g.gid, { feature: '群里人都叫它老窝' }, { reason: '测试', skipNameCheck: true })
  assert.deepEqual(mentionedGroups(root, PID, { text: '回老窝聊' }), [g.gid])
})

test('群体成员：消息进来就记一笔（提及时要用它裁决）', () => {
  const g = createGroupWithCard(root, PID, { name: '成员群', accountText: 'QQ群 770003' })
  const p = mkPerson('群友', 30001)
  ingest(root, {
    v: 1,
    source: 'qq',
    acct: '1',
    items: [
      {
        ts: localIso(),
        channel: `group:${g.gid}`,
        kind: 'msg',
        role: 'user',
        actor: { kind: 'member', id: '30001', name: '群友' },
        text: '我来了',
      },
    ],
  })
  const after = readGroup(root, PID, g.gid)
  assert.ok((after.members ?? []).includes(p.uid), `成员应该记上：${JSON.stringify(after.members)}`)
})
