// test/p12.test.mjs —— 注入 v2：卡片只放记忆；人物卡按"在场者"检索。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { scaffold } from '../src/core/scaffold.js'
import { appendRecord } from '../src/core/raw.js'
import { localIso, ulid } from '../src/core/fsx.js'
import { addFact, buildCard, contextFor, resolveParticipants, CARD_BUDGET_BYTES, PERSON_BUDGET_BYTES, MAX_PEOPLE_PER_CONTEXT } from '../src/core/memory.js'
import { createPerson, linkIdentity, writeProfile } from '../src/core/entities.js'

const PID = 'yuanling'
const bytes = (s) => Buffer.byteLength(s, 'utf8')

function tmpRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'yuanling-p12-'))
  scaffold(root, {})
  return root
}

/** 投一条消息到 raw（文本带 ulid，避免被 h 去重吃掉）。 */
function say(root, { id, channel = 'group:999', text = null, ts = localIso(), role = 'user' } = {}) {
  return appendRecord(root, {
    source: 'qq',
    acct: '10001',
    channel,
    actor: { kind: 'member', id: String(id), name: `用户${id}` },
    role,
    text: text ?? `第${ulid()}条`,
    ts,
  })
}

/** 建人 + 档案。 */
function mkPerson(root, { display, qq, sketch = '', weight = 0, tier = 'normal' } = {}) {
  const p = createPerson(root, { display })
  if (qq) linkIdentity(root, p.uid, { platform: 'qq', id: String(qq) })
  writeProfile(root, PID, p.uid, { sketch, weight, tier })
  return p.uid
}

// ── 卡片里不再有全局人物段 ──────────────────────────────────────────────

test('card：buildCard 不含人物——人物卡由 contextFor 按在场者追加', () => {
  const root = tmpRoot()
  mkPerson(root, { display: '张三', qq: '12345', sketch: '说话短', weight: 99 })

  const card = buildCard(root, PID)
  assert.ok(!card.includes('[人物]'), '卡片不该有全局人物榜')
})

test('card：预算常量是 32KB，裁剪顺序只剩 最新 → 最深刻', () => {
  assert.equal(CARD_BUDGET_BYTES, 32768)

  const root = tmpRoot()
  const r = say(root, { id: '10001', channel: 'private:10001' })
  const ptr = `${r.file}#${r.id}`

  addFact(root, PID, { topic: '初见', text: '最初的那件事要保住', src: ptr, origin: true })
  for (let i = 0; i < 12; i += 1) {
    addFact(root, PID, { topic: `杂事${i}`, text: `第${i}条近期事实 ${ulid()} 撑体积`, src: ptr, imp: 70, origin: false })
  }

  const card = buildCard(root, PID, { budget: 150 })
  assert.match(card, /\[最初\]/, '「最初」永远不该被裁')
  assert.ok(!card.includes('[最新]'), '先砍「最新」')
})

// ── 私聊：只有对方一张 ──────────────────────────────────────────────────

test('contextFor：私聊只带对方那一张卡', () => {
  const root = tmpRoot()
  const uid = mkPerson(root, { display: '张三', qq: '12345', sketch: '话不多' })
  say(root, { id: '12345', channel: 'private:12345' })

  const ctx = contextFor(root, PID, { channel: 'private:12345' })
  const lines = ctx.split('\n').filter((l) => l.startsWith('[人物]'))
  assert.equal(lines.length, 1)
  assert.match(lines[0], /张三/)
  assert.match(lines[0], /话不多/)
  assert.equal(uid.length > 0, true)
})

// ── 群聊：按在场者 ──────────────────────────────────────────────────────

test('contextFor：群聊带最近发言的人', () => {
  const root = tmpRoot()
  mkPerson(root, { display: '甲', qq: '111' })
  mkPerson(root, { display: '乙', qq: '222' })
  say(root, { id: '111' })
  say(root, { id: '222' })

  const ctx = contextFor(root, PID, { channel: 'group:999' })
  assert.match(ctx, /\[人物\].*甲/)
  assert.match(ctx, /\[人物\].*乙/)
})

test('contextFor：群聊里被 @ 的人即使没说话也要带卡（含 CQ 形式）', () => {
  const root = tmpRoot()
  mkPerson(root, { display: '甲', qq: '111' })
  mkPerson(root, { display: '丙', qq: '333' })
  mkPerson(root, { display: '丁', qq: '444' })
  say(root, { id: '111', text: '你好 @333' })
  say(root, { id: '111', text: '另外 [CQ:at,qq=444] 你看下' })

  const ctx = contextFor(root, PID, { channel: 'group:999' })
  assert.match(ctx, /\[人物\].*丙/, '@333 应该被认出来')
  assert.match(ctx, /\[人物\].*丁/, 'CQ:at 形式也该认')
})

test('contextFor：不在场的人不进上下文，哪怕权重最高', () => {
  const root = tmpRoot()
  mkPerson(root, { display: '高权重但没说话', qq: '444', weight: 100 })
  mkPerson(root, { display: '在场', qq: '111' })
  say(root, { id: '111' })

  const ctx = contextFor(root, PID, { channel: 'group:999' })
  assert.match(ctx, /\[人物\].*在场/)
  assert.ok(!ctx.includes('高权重但没说话'), '权重不该把人塞进不在场的群')
})

test('contextFor：群聊人物卡最多 8 张', () => {
  const root = tmpRoot()
  for (let i = 1; i <= 12; i += 1) {
    mkPerson(root, { display: `人${i}`, qq: String(1000 + i) })
    say(root, { id: String(1000 + i) })
  }

  const ctx = contextFor(root, PID, { channel: 'group:999' })
  const lines = ctx.split('\n').filter((l) => l.startsWith('[人物]'))
  assert.equal(lines.length, MAX_PEOPLE_PER_CONTEXT)
})

test('contextFor：没档案的人只发言也不带卡（她还不认识他）', () => {
  const root = tmpRoot()
  say(root, { id: '777' })

  const ctx = contextFor(root, PID, { channel: 'group:999' })
  assert.ok(!ctx.includes('[人物]'))
})

test('contextFor：单张人物卡不超过 600 字节', () => {
  const root = tmpRoot()
  mkPerson(root, { display: '长素描', qq: '12345', sketch: '很长的描述'.repeat(200) })
  say(root, { id: '12345', channel: 'private:12345' })

  const ctx = contextFor(root, PID, { channel: 'private:12345' })
  const line = ctx.split('\n').find((l) => l.startsWith('[人物]')).replace('[人物] ', '')
  assert.ok(bytes(line) <= PERSON_BUDGET_BYTES, `单卡 ${bytes(line)} 字节，超过 ${PERSON_BUDGET_BYTES}`)
})

test('resolveParticipants：显式传入的参与者优先，且去重', () => {
  const root = tmpRoot()
  const a = mkPerson(root, { display: '甲', qq: '111' })
  const b = mkPerson(root, { display: '乙', qq: '222' })

  const list = resolveParticipants(root, PID, {
    participants: [a, { platform: 'qq', id: '222' }, a],
    channel: null,
  })
  assert.equal(list.length, 2)
  assert.deepEqual(list.map((x) => x.uid).sort(), [a, b].sort())
})

test('contextFor：预算不够时从后往前丢人物卡，记忆卡不丢', () => {
  const root = tmpRoot()
  for (let i = 1; i <= 3; i += 1) {
    mkPerson(root, { display: `人${i}`, qq: String(200 + i), sketch: '很长的素描'.repeat(30) })
    say(root, { id: String(200 + i) })
  }

  const ctx = contextFor(root, PID, { channel: 'group:999', budget: 400 })
  const personLines = ctx.split('\n').filter((l) => l.startsWith('[人物]'))
  assert.ok(personLines.length < 3, '塞不下时该丢掉靠后的卡')
  assert.match(ctx, /\[索引\]/, '记忆卡不能被人物卡挤掉')
})
