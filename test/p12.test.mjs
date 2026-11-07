// test/p12.test.mjs —— 卡片 v2：8KB 预算、人物段、排序与单人上限。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { scaffold } from '../src/core/scaffold.js'
import { appendRecord } from '../src/core/raw.js'
import { localIso } from '../src/core/fsx.js'
import {
  addFact,
  buildCard,
  contextFor,
  CARD_BUDGET_BYTES,
  QUOTA,
  PERSON_BUDGET_BYTES,
} from '../src/core/memory.js'
import {
  createPerson,
  linkIdentity,
  writeProfile,
  loadIdentities,
  saveIdentities,
} from '../src/core/entities.js'

const PID = 'yuanling'
const bytes = (s) => Buffer.byteLength(s, 'utf8')

function tmpRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'yuanling-p12-'))
  scaffold(root, {})
  return root
}

function seedRaw(root, text = '一句话') {
  const r = appendRecord(root, {
    source: 'qq',
    acct: '10001',
    channel: 'private:10001',
    actor: { kind: 'owner', id: '10001', name: '主人' },
    role: 'user',
    text,
    ts: localIso(),
  })
  return `${r.file}#${r.id}`
}

/** 建一个人物 + 档案；tier='admin' 写在客观映射里，'important' 写在档案里。 */
function mkPerson(root, { display, qq, sketch = '', weight = 0, tier = 'normal', firstMet = null } = {}) {
  const p = createPerson(root, { display })
  if (qq) linkIdentity(root, p.uid, { platform: 'qq', id: String(qq) })
  writeProfile(root, PID, p.uid, {
    sketch,
    weight,
    tier: tier === 'important' ? 'important' : 'normal',
    first_met: firstMet,
  })
  if (tier === 'admin') {
    const data = loadIdentities(root)
    data.people[p.uid].tier = 'admin'
    saveIdentities(root, data)
  }
  return p.uid
}

test('card：没有人物档案时不该有「人物」段', () => {
  const root = tmpRoot()
  const card = buildCard(root, PID)
  assert.ok(!card.includes('[人物]'))
})

test('card：有人物时出现显示名与素描', () => {
  const root = tmpRoot()
  mkPerson(root, { display: '张三', qq: '12345', sketch: '说话短，爱用草' })

  const card = buildCard(root, PID)
  assert.match(card, /\[人物\]/)
  assert.match(card, /张三（qq:12345）/)
  assert.match(card, /说话短/)
})

test('card：管理员排第一，且带 ★', () => {
  const root = tmpRoot()
  mkPerson(root, { display: '路人甲', qq: '1', weight: 90, sketch: '权重很高' })
  mkPerson(root, { display: '主人', qq: '2', tier: 'admin', weight: 1, sketch: '这是主人' })

  const line = buildCard(root, PID).split('\n').find((l) => l.startsWith('[人物]'))
  assert.ok(line)
  assert.ok(line.indexOf('★主人') < line.indexOf('路人甲'), '管理员必须排在前面，哪怕权重更低')
})

test('card：「人物」最多 3 人', () => {
  const root = tmpRoot()
  for (let i = 0; i < 5; i += 1) mkPerson(root, { display: `人${i}`, qq: String(100 + i), weight: i })

  const line = buildCard(root, PID).split('\n').find((l) => l.startsWith('[人物]'))
  const list = line.replace(/^\[人物\]\s*/, '').split('；')
  assert.equal(list.length, QUOTA.people)
})

test('card：单个人物不超过 600 字节', () => {
  const root = tmpRoot()
  mkPerson(root, { display: '长素描', qq: '1', sketch: '很长的描述'.repeat(200) })

  const line = buildCard(root, PID).split('\n').find((l) => l.startsWith('[人物]'))
  const one = line.replace(/^\[人物\]\s*/, '').split('；')[0]
  assert.ok(bytes(one) <= PERSON_BUDGET_BYTES, `单人 ${bytes(one)} 字节，超过 ${PERSON_BUDGET_BYTES}`)
})

test('card：预算由 800 提到 8KB', () => {
  assert.equal(CARD_BUDGET_BYTES, 8192)
})

test('card：预算不够时按 最新 → 最深刻 → 人物 的顺序砍，「最初」不动', () => {
  const root = tmpRoot()
  const src = seedRaw(root)
  addFact(root, PID, { topic: '初见', text: '最初的那件事要保住', src, origin: true })
  for (let i = 0; i < 12; i += 1) {
    addFact(root, PID, { topic: `杂事${i}`, text: `第 ${i} 条近期事实，撑一点体积。`, src, imp: 70, origin: false })
  }
  mkPerson(root, { display: '张三', qq: '12345', sketch: '一个不该出现在极小预算里的素描' })

  // 预算给到"骨架 + 最初 + 索引"刚好放不下人物段的水位
  const card = buildCard(root, PID, { budget: 150 })
  assert.match(card, /\[最初\]/, '「最初」永远不该被裁')
  assert.ok(!card.includes('[最新]'), '先砍「最新」')
  assert.ok(!card.includes('[人物]'), '人物在最后才砍')
})

test('contextFor：正在私聊的对方不重复出现在「人物」段', () => {
  const root = tmpRoot()
  const uid = mkPerson(root, { display: '张三', qq: '12345', sketch: '话不多' })

  const ctx = contextFor(root, PID, { channel: 'private:12345' })
  assert.match(ctx, /\[这个人\] 张三/, '应该作为「这一轮的对方」出现')
  assert.ok(!ctx.includes('[人物]'), '不该同时出现在背景人物里')
  assert.equal(uid.length > 0, true)
})
