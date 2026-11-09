// test/p55.test.mjs —— 定时演化：记忆 → 提案 → 表达层。
//
// 这条链以前是断的：`scan` / `sweep` 只有人工触发，规则页里那些 auto_adopt /
// auto_approve_days 其实是摆设。这些用例钉住"接上之后的行为"，尤其三条边界：
//   ① 只动提案与表达层，**绝不碰 SELF.md**；
//   ② auto_adopt=false / 一天条数上限 真的生效；
//   ③ 一个个人格出错不影响别人格。
import { test, before } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { scaffold } from '../src/core/scaffold.js'
import { appendRecord } from '../src/core/raw.js'
import { localIso } from '../src/core/fsx.js'
import { addFact } from '../src/core/memory.js'
import { personaPaths } from '../src/core/paths.js'
import { createPersona } from '../src/core/persona.js'
import { listProposals } from '../src/core/proposals.js'
import { readStyle } from '../src/core/style.js'
import { writeGlobalRules } from '../src/core/rules.js'
import { evolveOnce, startEvolution } from '../src/core/evolve.js'

const PID = 'yuanling'
const DAY = 86_400_000

function tmpRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'yuanling-p55-'))
  scaffold(root, {})
  return root
}

function seedSrc(root) {
  const r = appendRecord(root, {
    source: 'qq',
    acct: '1',
    channel: 'private:1',
    actor: { kind: 'owner', id: '1', name: '主人' },
    role: 'user',
    text: '别用颜文字',
    ts: localIso(),
  })
  return `${r.file}#${r.id}`
}

/** 制造"同一句话被反复说了 5 次、跨 3 天"的记忆。 */
function seedRepeated(root, { text = '说话别用感叹号', times = 5, spanDays = 4 } = {}) {
  const src = seedSrc(root)
  for (let i = 0; i < times; i += 1) {
    addFact(root, PID, {
      topic: '说话方式',
      text,
      src,
      now: localIso(new Date(Date.now() - (spanDays - i) * DAY)),
    })
  }
}

test('空库：跑一轮什么都不发生，但返回 ok（不是"没跑"）', () => {
  const root = tmpRoot()
  const r = evolveOnce(root)
  assert.equal(r.ok, true)
  assert.equal(r.created, 0)
  assert.equal(r.approved, 0)
  assert.deepEqual(r.personas.map((p) => p.pid), [PID])
  assert.equal(r.personas[0].error, null)
})

test('scan：重复够多、跨度够长的记忆 → 自动长出提案', () => {
  const root = tmpRoot()
  seedRepeated(root, { text: '别用颜文字' })

  const r = evolveOnce(root)
  assert.equal(r.created, 1, '应该长出一条提案')
  assert.equal(r.approved, 0, '刚生成的提案还没到期，不该被立刻采纳')

  const list = listProposals(root, PID)
  assert.equal(list.length, 1)
  assert.equal(list[0].status, 'pending')
})

test('sweep：过了 auto_approve_days 的提案被自动采纳，并写进表达层', () => {
  const root = tmpRoot()
  seedRepeated(root, { text: '别用颜文字' })
  // 第一次跑：生成提案（created = 现在）
  evolveOnce(root)

  // 把时间往后拨 4 天（auto_approve_days 默认 3）
  const r = evolveOnce(root, { now: Date.now() + 4 * DAY })
  assert.equal(r.approved, 1, '到期应该自动采纳')

  const p = listProposals(root, PID)[0]
  assert.equal(p.status, 'approved')
  assert.equal(p.decided_by, 'auto')

  const style = readStyle(root, PID)
  assert.ok(style.items.some((x) => x.includes('颜文字')), '采纳的内容应该落到表达层')
})

test('采纳之后真的进上下文（不是写了个没人读的文件）', async () => {
  const root = tmpRoot()
  seedRepeated(root, { text: '少用排比句' })
  evolveOnce(root)
  evolveOnce(root, { now: Date.now() + 4 * DAY })

  const { contextFor } = await import('../src/core/memory.js')
  const ctx = contextFor(root, PID, { preview: true })
  assert.match(ctx, /\[习惯\] .*排比/)
})

test('每日上限：daily_auto_limit=1 时一天只采纳一条', () => {
  const root = tmpRoot()
  writeGlobalRules(root, PID, { 'persona.daily_auto_limit': 1, 'persona.auto_approve_days': 0 })

  // 造两条不同的重复主张
  const src = seedSrc(root)
  for (const text of ['少用感叹号', '别用颜文字']) {
    for (let i = 0; i < 5; i += 1) {
      addFact(root, PID, { topic: '说话方式', text, src, now: localIso(new Date(Date.now() - (4 - i) * DAY)) })
    }
  }

  const r = evolveOnce(root)
  assert.equal(r.created, 2, '应该生成两条提案')
  // auto_approve_days=0 → 同一轮 sweep 就会到期；上限 1
  assert.equal(r.approved, 1, '一天最多自动采纳 1 条')

  const approved = listProposals(root, PID).filter((p) => p.status === 'approved')
  assert.equal(approved.length, 1)
})

test('auto_adopt=false：不自动采纳，提案留在 pending 等人工点头', () => {
  const root = tmpRoot()
  writeGlobalRules(root, PID, { 'persona.auto_adopt': false })
  seedRepeated(root, { text: '别用颜文字' })

  evolveOnce(root)
  const r = evolveOnce(root, { now: Date.now() + 10 * DAY })
  assert.equal(r.approved, 0)

  const p = listProposals(root, PID)[0]
  assert.equal(p.status, 'pending')
  assert.equal(readStyle(root, PID).items.length, 0)
})

test('绝不碰骨架：自动演化只写表达层，SELF.md 一个字节都不变', () => {
  const root = tmpRoot()
  const selfPath = path.join(root, personaPaths(PID).self)
  const before = fs.readFileSync(selfPath, 'utf8')

  seedRepeated(root, { text: '别用颜文字' })
  evolveOnce(root)
  evolveOnce(root, { now: Date.now() + 4 * DAY })

  assert.equal(fs.readFileSync(selfPath, 'utf8'), before, '骨架只有人能改')
})

test('每人个格各跑一遍：两个人格各自出提案，互不影响', () => {
  const root = tmpRoot()
  seedRepeated(root, { text: '别用颜文字' })

  createPersona(root, 'other', '另一个人格')
  // 给另一个人格也种一条重复记忆
  const src = seedSrc(root)
  for (let i = 0; i < 5; i += 1) {
    addFact(root, 'other', {
      topic: '说话方式',
      text: '先给结论',
      src,
      now: localIso(new Date(Date.now() - (4 - i) * DAY)),
    })
  }

  const r = evolveOnce(root)
  assert.equal(r.personas.length, 2)
  assert.equal(r.created, 2, '两个人格各长一条')
  assert.equal(listProposals(root, PID).length, 1)
  assert.equal(listProposals(root, 'other').length, 1)
})

test('一个人格出错不影响别人格（写不进去的那个人格）', () => {
  const root = tmpRoot()
  createPersona(root, 'broken', '坏的那个')

  // 把这个人的 proposals 目录换成一个同名文件：要写提案时必然失败
  const dir = path.join(root, 'personas', 'broken', 'proposals')
  fs.rmSync(dir, { recursive: true, force: true })
  fs.writeFileSync(dir, '不是目录', 'utf8')

  // 让 broken 也有一条够格的重复记忆：它会在写提案那步炸
  const src = seedSrc(root)
  for (let i = 0; i < 5; i += 1) {
    addFact(root, 'broken', {
      topic: '说话方式',
      text: '这条会让坏人格炸',
      src,
      now: localIso(new Date(Date.now() - (4 - i) * DAY)),
    })
  }

  seedRepeated(root, { text: '别用颜文字' })
  const r = evolveOnce(root)

  assert.equal(r.ok, true, '整体不该因为一个人格失败而失败')
  const broken = r.personas.find((p) => p.pid === 'broken')
  assert.ok(broken.error, '坏掉的那个人格要如实报错')
  const good = r.personas.find((p) => p.pid === PID)
  assert.equal(good.error, null, '好的人格照常跑')
  assert.equal(good.created.length, 1, '好的人格照样生成了提案')
})

test('startEvolution：everyHours=0 时不排定时器（等同关闭）', () => {
  const root = tmpRoot()
  const h = startEvolution(root, { everyHours: 0 })
  assert.equal(h.disabled, true)
  h.stop()
  h.runNow() // 不该抛
})

test('startEvolution：stop() 之后不会再跑', async () => {
  const root = tmpRoot()
  let runs = 0
  const h = startEvolution(root, { everyHours: 1, firstDelayMs: 5, onRun: () => (runs += 1) })
  await new Promise((r) => setTimeout(r, 60))
  h.stop()
  const after = runs
  await new Promise((r) => setTimeout(r, 120))
  assert.equal(runs, after, '停掉之后不该再跑')
  assert.ok(after >= 1, '停之前至少跑过一次')
})
