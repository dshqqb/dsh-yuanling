// test/p59.test.mjs —— 记忆自动成长：从消息里提炼事实（规则表，不调模型）。
//
// 用户定的判据（2026-11-10）：
//   · 私聊**全部**提炼（谁的私聊都算，私聊天然是跟她说话）；
//   · 群里只有"跟她有关"的才提炼：被提到、或她开口之后跟她有关的对话；
//   · 窗口 4 分钟滑动、20 分钟封顶；**无关消息不推窗口**，宁可分段；
//   · 每条事实都必须带 raw 指针（没有指针的事实不写）。
import { test, before } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { scaffold } from '../src/core/scaffold.js'
import { ingest } from '../src/core/inbox.js'
import { listEntries } from '../src/core/memory.js'
import { extractFacts, EXTRACT_MAX_PER_MESSAGE } from '../src/core/extract.js'
import { noteGroupMessage, clearEngage, readEngage, herNames, ENGAGE_WINDOW_MS, ENGAGE_MAX_MS } from '../src/core/engage.js'

const PID = 'yuanling'
let root

before(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'yuanling-p59-'))
  scaffold(root, {})
})

function send(channel, text, actor = { kind: 'member', id: '10001', name: '老王' }, role = 'user', ts = new Date().toISOString()) {
  return ingest(root, { v: 1, source: 'qq', acct: '1', items: [{ ts, channel, kind: 'msg', actor, role, text }] })
}

function allFacts() {
  return listEntries(root, PID).flatMap((e) => (e.facts ?? []).map((f) => ({ ...f, topic: e.topic })))
}

test('规则表：认得出身份 / 喜好 / 打算 / 关系 / 情绪 / 叮嘱', () => {
  assert.equal(extractFacts('我叫老张')[0].topic, '身份')
  assert.equal(extractFacts('我特别喜欢猫')[0].topic, '喜好')
  assert.equal(extractFacts('明天我要去面试')[0].topic, '打算')
  assert.equal(extractFacts('我妈住院了')[0].topic, '关系')
  assert.equal(extractFacts('我今天很累')[0].topic, '情绪')
  assert.equal(extractFacts('记得帮我买牛奶')[0].topic, '叮嘱')
})

test('规则表：平淡的话不提炼；一句话不会拆成两条', () => {
  assert.deepEqual(extractFacts('随便聊聊天气'), [])
  assert.deepEqual(extractFacts('我觉得这个方案还行'), [])
  const facts = extractFacts('明天我要去面试')
  assert.equal(facts.length, 1, '长短两条只留长的')
  assert.ok(facts[0].text.includes('明天'))
  assert.ok(extractFacts('我叫A，我喜欢B，我妈C，我要D').length <= EXTRACT_MAX_PER_MESSAGE)
})

test('私聊：不管谁说话都提炼，事实一定带 raw 指针', () => {
  send('private:20001', '我叫老王，我特别喜欢吃面', { kind: 'member', id: '20001', name: '老王' })
  const facts = allFacts()
  assert.ok(facts.length >= 2)
  for (const f of facts) {
    assert.ok(f.src?.startsWith('raw/'), '每条事实都要有 raw 指针')
    assert.equal(f.kind, 'extracted')
  }
  assert.ok(facts.some((f) => f.text.includes('老王')))
})

test('群聊：跟她无关 → 一条都不提炼', () => {
  const before = allFacts().length
  send('group:30001', '今天好热啊，晚上吃什么', { kind: 'member', id: '30002', name: '路人' })
  send('group:30001', '我叫小明', { kind: 'member', id: '30003', name: '小明' })
  assert.equal(allFacts().length, before, '无关的群聊不该进记忆')
})

test('群聊：被提到 → 这条进记忆，并且进入在场', () => {
  clearEngage(root)
  const before = allFacts().length
  send('group:30001', '原灵，明天我要去面试', { kind: 'member', id: '30002', name: '路人' })
  assert.equal(allFacts().length, before + 1)
  const state = readEngage(root)
  const gid = Object.keys(state.scenes)[0]
  assert.ok(gid, '应该记下在场')
  assert.ok(state.scenes[gid].until > Date.now() - 1000)
})

test('群聊：在场的人接着说 → 继续进记忆', () => {
  const before = allFacts().length
  send('group:30001', '我准备了一大堆材料', { kind: 'member', id: '30002', name: '路人' })
  assert.equal(allFacts().length, before + 1)
})

test('群聊：无关的人插话 → 不进记忆，也不延长窗口', () => {
  const gid = Object.keys(readEngage(root).scenes)[0]
  const untilBefore = readEngage(root).scenes[gid].until
  const before = allFacts().length
  send('group:30001', '我特别喜欢吃辣', { kind: 'member', id: '30009', name: '另一个人' })
  assert.equal(allFacts().length, before, '不在场的人说的话不记')
  assert.equal(readEngage(root).scenes[gid].until, untilBefore, '无关消息不该推窗口')
})

test('窗口：4 分钟滑动、20 分钟封顶；超时就退出', () => {
  clearEngage(root)
  const gid = 'grp_test'
  const names = herNames(root, PID)
  const t0 = Date.now()

  const a = noteGroupMessage(root, { gid, text: '原灵你在吗', actorKey: 'person_a', now: t0, names })
  assert.equal(a.engaged, true)
  assert.equal(a.until - t0, ENGAGE_WINDOW_MS, '提到她 → 窗口 4 分钟')

  // 3 分钟后同伴接着说：窗口顺延到 now+4min，但不超过 since+20min
  const t1 = t0 + 3 * 60 * 1000
  const b = noteGroupMessage(root, { gid, text: '继续说', actorKey: 'person_a', now: t1, names })
  assert.equal(b.engaged, true)
  assert.equal(b.until, t1 + ENGAGE_WINDOW_MS)

  // 反复顺延也不能超过封顶
  let last = b
  for (let i = 1; i <= 6; i += 1) {
    last = noteGroupMessage(root, { gid, text: '还在聊', actorKey: 'person_a', now: t0 + i * 3 * 60 * 1000, names })
  }
  assert.ok(last.until <= t0 + ENGAGE_MAX_MS, '不能突破 20 分钟封顶')

  // 超时之后：同一段对话不再算在场
  const expired = noteGroupMessage(root, { gid, text: '还在聊', actorKey: 'person_a', now: t0 + ENGAGE_MAX_MS + 1000, names })
  assert.equal(expired.engaged, false)
  assert.equal(expired.reason, 'expired')
})

test('她开口 → 进入在场（哪怕没人提她）', () => {
  clearEngage(root)
  const gid = 'grp_bot'
  const r = noteGroupMessage(root, { gid, text: '我在。', actorKey: '', isBot: true, now: Date.now(), names: herNames(root, PID) })
  assert.equal(r.engaged, true)
  assert.equal(r.reason, 'she-spoke')
})

test('她自己的话不提炼成事实（但那句话会开启在场）', () => {
  clearEngage(root)
  const before = allFacts().length
  send('group:30002', '我喜欢这样聊天', { kind: 'bot', id: '1', name: '原灵' }, 'bot')
  assert.equal(allFacts().length, before, '她自己的话不是关于别人的事实')
  assert.equal(Object.keys(readEngage(root).scenes).length, 1, '但她在场了')
})

test('提炼出来的事实能查到出处（指针指向真实 raw 记录）', () => {
  const facts = allFacts().filter((f) => f.kind === 'extracted')
  assert.ok(facts.length > 0)
  for (const f of facts.slice(0, 3)) {
    const [file] = String(f.src).split('#')
    assert.ok(fs.existsSync(path.join(root, file)), `指针指向的文件要存在：${f.src}`)
  }
})
