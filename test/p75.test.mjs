// test/p75.test.mjs —— 称呼索引缓存：按人格维度 + 文件指纹失效。
//
// 要求（Q37=A）：
//   · 命中缓存时不再读所有人档案（只 stat，不读内容）；
//   · 文件一变（改了印象/新建人物）就重建；
//   · 缓存不能跨人格串（两个人格各一份索引）；
//   · 语义不变：缓存前后"提到谁"结果一样。
import { test, before, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { scaffold } from '../src/core/scaffold.js'
import { createPersona, switchPersona } from '../src/core/persona.js'
import { createPerson, linkIdentity, writeProfile } from './helpers.mjs'
import { setImpression } from '../src/core/impressions.js'
import { createGroupWithCard, writeGroup } from '../src/core/groups.js'
import { appendRecord } from '../src/core/raw.js'
import { localIso } from '../src/core/fsx.js'
import { contextFor } from '../src/core/memory.js'
import {
  personMentionIndex,
  groupAliasIndex,
  mentionedPeople,
  mentionedGroups,
  clearMentionCache,
  mentionCacheStats,
} from '../src/core/aliases.js'

const PID = 'yuanling'
let root

function mkPerson(name, qq, alias) {
  const p = createPerson(root, { display: name })
  linkIdentity(root, p.uid, { platform: 'qq', id: String(qq) })
  writeProfile(root, PID, p.uid, { sketch: name })
  if (alias) setImpression(root, PID, 'person', p.uid, { text: `大家都叫他${alias}`, reason: '测试' })
  return p
}

before(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'yuanling-p75-'))
  scaffold(root, {})
})

beforeEach(() => {
  clearMentionCache()
})

test('命中：第二次返回同一个索引对象（没重建）', () => {
  mkPerson('甲一', 50001, '小甲')
  const first = personMentionIndex(root, PID)
  const second = personMentionIndex(root, PID)
  assert.equal(first, second, '同指纹应该复用同一个 Map')
  assert.equal(mentionCacheStats().size, 1)
})

test('失效：改了印象 → 索引重建，新昵称立刻能命中', () => {
  const p = mkPerson('乙二', 50002, null)
  const before = mentionedPeople(root, PID, { text: '小乙来了' })
  assert.deepEqual(before, [], '还没有这个昵称')

  setImpression(root, PID, 'person', p.uid, { text: '同事叫他小乙', reason: '测试' })
  const after = mentionedPeople(root, PID, { text: '小乙来了' })
  assert.deepEqual(after, [p.uid], '改完印象应该马上生效（指纹变了）')
})

test('失效：新建人物 → 名字立刻能命中', () => {
  mkPerson('丙三', 50003, null)
  const hit = mentionedPeople(root, PID, { text: '丙三今天没来' })
  assert.equal(hit.length, 1)
})

test('按人格隔离：两个人格各一份索引，不互相污染', () => {
  createPersona(root, 'other', '另一个人格')
  switchPersona(root, 'other')
  const pB = createPerson(root, { display: '丁四' })
  linkIdentity(root, pB.uid, { platform: 'qq', id: '50004' })
  writeProfile(root, 'other', pB.uid, { sketch: 'B 认识的人' })

  assert.deepEqual(mentionedPeople(root, 'other', { text: '丁四来了' }).map(String), [pB.uid])

  switchPersona(root, PID)
  assert.deepEqual(mentionedPeople(root, PID, { text: '丁四来了' }), [], 'A 不该认识 B 的人')
})

test('群体索引同样缓存 + 失效', () => {
  const g = createGroupWithCard(root, PID, { name: '技术群', accountText: 'QQ群 750001' })
  const first = groupAliasIndex(root, PID)
  assert.equal(groupAliasIndex(root, PID), first, '命中应复用')

  writeGroup(root, PID, g.gid, { feature: '群里人叫它老窝' }, { reason: '测试', skipNameCheck: true })
  assert.deepEqual(mentionedGroups(root, PID, { text: '回老窝聊' }), [g.gid], '改完描述应该马上生效')
})

test('语义不变：缓存热了之后 contextFor 仍然带出被提到的人', () => {
  const g = createGroupWithCard(root, PID, { name: '缓存群', accountText: 'QQ群 750002' })
  const speaker = mkPerson('说话的人', 50005, null)
  const talked = mkPerson('被提的人', 50006, '老被')

  appendRecord(root, {
    source: 'qq',
    acct: '1',
    channel: `group:${g.gid}`,
    type: 'message',
    role: 'user',
    actor: { kind: 'member', id: '50005', name: '说话的人' },
    text: '老被说他明天不来',
    ts: localIso(),
  })

  // 先跑两次让缓存热起来
  contextFor(root, PID, { channel: `group:${g.gid}`, preview: true })
  const ctx = contextFor(root, PID, { channel: `group:${g.gid}`, preview: true })
  assert.match(ctx, /被提的人/)
  assert.match(ctx, /老被/)
  void speaker
  void talked
})
