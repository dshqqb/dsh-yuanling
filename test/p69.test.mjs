// test/p69.test.mjs —— 人格：id 唯一、名称可以有多个；昵称字段取消；新称呼会被她自己写进名称。
//
// 用户定的（2026-11-11）：
//   · 人格有唯一 **id**；名称可以有多个（空格分隔），**不查重**（不同 id 可以同名）；
//   · 人格的"昵称"字段取消（UI 到代码全删）；
//   · 新增：同一个称呼被不同人多次用来叫她 → 她自己写进名称。
import { test, before } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { scaffold } from '../src/core/scaffold.js'
import { createPersona, readMarker } from '../src/core/persona.js'
import { readCard, renameCard } from '../src/core/personacard.js'
import { herNames, noteGroupMessage, personaNameList } from '../src/core/engage.js'
import { identityLines } from '../src/core/memory.js'
import { writePrefs, readPrefs } from '../src/core/prefs.js'
import { appendRecord } from '../src/core/raw.js'
import { localIso } from '../src/core/fsx.js'
import { ingest } from '../src/core/inbox.js'
import {
  noteSelfNameCandidate,
  extractVocatives,
  addressesHer,
  herPlatformIds,
  NAME_PROMOTE_MIN_ACTORS,
  NAME_PROMOTE_MIN_HITS,
} from '../src/core/selfname.js'

const PID = 'yuanling'
const SELF_QQ = '2823503286'
let root

before(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'yuanling-p69-'))
  scaffold(root, {})
})

test('名称可以有多个：空格分开，每一个都算在叫她', () => {
  renameCard(root, PID, '原灵 小灵 灵灵')
  assert.equal(readCard(root, PID).card.name, '原灵 小灵 灵灵')
  assert.deepEqual(personaNameList('原灵 小灵 灵灵'), ['原灵', '小灵', '灵灵'])
  const names = herNames(root, PID)
  for (const n of ['原灵', '小灵', '灵灵']) assert.ok(names.includes(n), `应该认「${n}」`)

  // 注入里三个名字都在（骨架那一行）
  const line = identityLines(root, PID).find((l) => l.startsWith('[骨架]'))
  assert.match(line, /原灵 小灵 灵灵/)

  // 喊其中任意一个都算叫她
  const r = noteGroupMessage(root, { gid: 'qq:990001', text: '灵灵在吗', actorKey: 'qq:1', now: Date.now(), names })
  assert.equal(r.engaged, true)
})

test('人格 id 唯一，但名称不查重（不同 id 可以同名）', () => {
  createPersona(root, 'twin', '同名人格')
  createPersona(root, 'twin2', '同名人格')
  assert.throws(() => createPersona(root, 'twin', '另一个名字'), /已存在/, 'id 重复要拒绝')
  const names = readMarker(root).personas.map((p) => p.name)
  assert.equal(names.filter((n) => n === '同名人格').length, 2, '两个 id 可以同名')
})

test('改名不查重名（改名只改这一个）', () => {
  createPersona(root, 'third', '别的')
  renameCard(root, 'third', '原灵 小灵 灵灵')
  const names = readMarker(root).personas.map((p) => p.name)
  assert.ok(names.filter((n) => n === '原灵 小灵 灵灵').length >= 1)
})

test('人格昵称字段已取消：写 nicknames 会被拒（不再有第二份名字）', () => {
  assert.throws(() => writePrefs(root, PID, { nicknames: ['小灵'] }), /不认识的偏好项/)
  assert.equal(readPrefs(root, PID).nicknames, undefined)
})

test('地址判定：@ 她的号 或 喊她已知名字，都算在叫她', () => {
  appendRecord(root, {
    source: 'qq',
    acct: SELF_QQ,
    channel: 'group:qq:990002',
    type: 'message',
    role: 'bot',
    actor: { kind: 'bot', id: SELF_QQ, name: '原灵' },
    text: '我在',
    ts: localIso(),
  })
  const selfIds = herPlatformIds(root)
  assert.ok(selfIds.has(SELF_QQ), '应该能从 raw 里认出她自己的号')

  assert.equal(addressesHer(`@${SELF_QQ} 你好`, { selfIds, names: ['原灵'] }), true)
  assert.equal(addressesHer('原灵在吗', { selfIds, names: ['原灵'] }), true)
  assert.equal(addressesHer('今天吃什么', { selfIds, names: ['原灵'] }), false)
})

test('称呼抽取：只认句首/@ 后面的 2–6 字，已知名字和常用词不算', () => {
  assert.deepEqual(extractVocatives('小灵，你觉得呢', { names: ['原灵'] }), ['小灵'])
  assert.deepEqual(extractVocatives(`@${SELF_QQ} 阿灵在吗`, { names: ['原灵'] }), ['阿灵'])
  assert.deepEqual(extractVocatives('原灵在吗', { names: ['原灵'] }), [], '已知名字不必再收')
  assert.deepEqual(extractVocatives('你好，今天怎么样', { names: ['原灵'] }).filter((x) => x === '你好'), [], '常用词要挡掉')
})

test('自动发现：不同的人多次用同一个新称呼叫她 → 攒够了写进名称', () => {
  const gid = 'qq:990003'
  const names0 = herNames(root, PID)
  const selfIds = herPlatformIds(root)

  // 前两次不够：只有一个 actor、次数也没到阈值
  let r = noteSelfNameCandidate(root, PID, { text: `@${SELF_QQ} 阿原，在吗`, actorKey: 'qq:10001', names: names0, selfIds })
  assert.equal(r.promoted, null)
  r = noteSelfNameCandidate(root, PID, { text: `@${SELF_QQ} 阿原，出来`, actorKey: 'qq:10001', names: names0, selfIds })
  assert.equal(r.promoted, null)

  // 换一个人再叫一次：不同人 + 次数够了
  r = noteSelfNameCandidate(root, PID, { text: `@${SELF_QQ} 阿原，问你个事`, actorKey: 'qq:10002', names: names0, selfIds })
  assert.equal(r.promoted, '阿原', '阈值到了就该写进名称')
  assert.ok(herNames(root, PID).includes('阿原'))
  assert.match(readCard(root, PID).card.name, /阿原/)

  void gid
  void NAME_PROMOTE_MIN_ACTORS
  void NAME_PROMOTE_MIN_HITS
})

test('自动发现：只是在聊天里出现、没在叫她 → 不算', () => {
  const names = herNames(root, PID)
  const selfIds = herPlatformIds(root)
  const before = readCard(root, PID).card.name
  noteSelfNameCandidate(root, PID, { text: '小灵昨天说他要搬家', actorKey: 'qq:20001', names, selfIds })
  assert.equal(readCard(root, PID).card.name, before, '没在叫她就不该动名称')
})

test('整条链：群里 @ 她用新称呼 → 消息入库时会记账（不必等手动调用）', () => {
  const scene = 'group:qq:990004'
  const before = readCard(root, PID).card.name
  for (const [i, actor] of ['30001', '30002', '30001'].entries()) {
    ingest(root, {
      v: 1,
      source: 'qq',
      acct: SELF_QQ,
      items: [
        {
          ts: localIso(new Date(Date.now() + i * 1000)),
          channel: scene,
          kind: 'msg',
          role: 'user',
          actor: { kind: 'member', id: actor, name: `人${actor}` },
          text: `@${SELF_QQ} 阿灵，在吗`,
        },
      ],
    })
  }
  const after = readCard(root, PID).card.name
  assert.ok(after.includes('阿灵'), `名称应该自动加上了：${before} → ${after}`)
  const state = JSON.parse(fs.readFileSync(path.join(root, 'personas', PID, 'state', 'names.json'), 'utf8'))
  assert.ok(state.candidates, '记账文件应该存在')
})
