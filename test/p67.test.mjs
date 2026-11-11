// test/p67.test.mjs —— 有人**引用回复她**也算"在叫她"（群里最常见的叫她方式）。
//
// 为什么不能只靠关键词：群里回复某人时，正文常常是「你觉得呢」「然后呢」——
// 她的名字和昵称一个都没出现，但她确实被叫到了。
//
// 判据：被引用的那条消息，在 raw 里是不是 `role: "bot"`。
// 前提：她自己的消息也要进 raw（网关的 reportSelfMessage / message_sent）——
// 找不到就为假，**不猜、也不拿别人的消息冒充**。
import { test, before } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { scaffold } from '../src/core/scaffold.js'
import { appendRecord } from '../src/core/raw.js'
import { localIso } from '../src/core/fsx.js'
import { isReplyToHer, noteGroupMessage, readEngage } from '../src/core/engage.js'
import { ingest } from '../src/core/inbox.js'
import { listEntries } from '../src/core/memory.js'

const PID = 'yuanling'
const GID = 'qq:900001'
const SCENE = 'group:qq:900001'
let root

before(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'yuanling-p67-'))
  scaffold(root, {})
})

test('isReplyToHer：被引用的是她发的（role=bot）→ 真', () => {
  appendRecord(root, {
    source: 'qq',
    acct: '2823503286',
    channel: SCENE,
    type: 'message',
    ext: { message_id: 'm1' },
    role: 'bot',
    actor: { kind: 'bot', id: '2823503286', name: '原灵' },
    text: '我在',
    ts: localIso(),
  })
  assert.equal(isReplyToHer(root, 'm1'), true)
})

test('isReplyToHer：被引用的是别人发的 → 假（不拿别人的消息冒充）', () => {
  appendRecord(root, {
    source: 'qq',
    acct: '1',
    channel: SCENE,
    type: 'message',
    ext: { message_id: 'm2' },
    role: 'user',
    actor: { kind: 'member', id: '10001', name: '小李' },
    text: '在吗',
    ts: localIso(),
  })
  assert.equal(isReplyToHer(root, 'm2'), false)
  assert.equal(isReplyToHer(root, 'nope'), false)
  assert.equal(isReplyToHer(root, ''), false)
})

test('noteGroupMessage：replyToHer=true 就跟被点名一样进入在场', () => {
  const now = Date.now()
  const r = noteGroupMessage(root, {
    gid: GID,
    text: '你觉得呢',
    actorKey: 'qq:10001',
    replyToHer: true,
    now,
    names: ['原灵'],
  })
  assert.equal(r.engaged, true)
  assert.equal(r.reason, 'replied-to-her')
  assert.ok(r.until > now)
})

test('noteGroupMessage：既没点名也没回复她 → 不算（窗口不推）', () => {
  const r = noteGroupMessage(root, { gid: 'qq:900002', text: '今天吃什么', actorKey: 'qq:10002', now: Date.now(), names: ['原灵'] })
  assert.equal(r.engaged, false)
  assert.ok(['not-engaged', 'expired'].includes(r.reason), r.reason)
})

test('整条链：她说过话 → 有人引用回复 → 这段对话算跟她有关（进记忆）', () => {
  const scene = 'group:qq:900003'
  const gid = 'qq:900003'

  // ① 她先说了一句（网关要把自己的消息也交上来）
  ingest(root, {
    v: 1,
    source: 'qq',
    acct: '2823503286',
    items: [
      {
        ts: localIso(),
        channel: scene,
        kind: 'msg',
        ext_id: 'q1',
        role: 'bot',
        actor: { kind: 'bot', id: '2823503286', name: '原灵' },
        text: '我猜是明天',
      },
    ],
  })

  // ② 有人直接引用她那句，正文里没有名字
  ingest(root, {
    v: 1,
    source: 'qq',
    acct: '1',
    items: [
      {
        ts: localIso(),
        channel: scene,
        kind: 'msg',
        ext_id: 'q2',
        reply_to: 'q1',
        role: 'user',
        actor: { kind: 'member', id: '10001', name: '小李' },
        text: '我明天要去医院复查',
      },
    ],
  })

  const state = readEngage(root)
  // 场景键是内部 gid（`grp_…`），不是外部群号——频道编号指向内部是既定语义
  const entry = Object.values(state.scenes).find((s) => Number(s.until) > Date.now() - 1000)
  assert.ok(entry, '应该进入在场')

  // 并且这条回复真的进了记忆（"算跟她有关"的最终证据）
  const facts = listEntries(root, PID).flatMap((e) => e.facts ?? []).map((f) => f.text)
  assert.ok(facts.some((x) => x.includes('医院复查')), `事实应该被提炼：${facts.join(' / ')}`)
})
