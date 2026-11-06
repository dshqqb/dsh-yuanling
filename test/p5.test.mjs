// test/p5.test.mjs —— 三带 / 衰减 / 清晰度 / 召回计数 / 卡片配额与裁剪。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { scaffold } from '../src/core/scaffold.js'
import { appendRecord } from '../src/core/raw.js'
import { localIso } from '../src/core/fsx.js'
import { addFact, recall, buildCard } from '../src/core/memory.js'
import {
  emotionalScore,
  retentionOf,
  clarityOf,
  originDraw,
  originProbability,
  shouldMarkOrigin,
  classify,
  recordAccess,
  recallCounts,
  PROTECT_DAYS,
} from '../src/core/retention.js'

const PID = 'yuanling'

function tmpRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'yuanling-p5-'))
  scaffold(root, {})
  return root
}

function seedRaw(root, text = '今天备份脚本跑到一半断了') {
  const r = appendRecord(root, {
    source: 'qq',
    acct: '10001',
    channel: 'group:1',
    actor: { kind: 'owner', id: '10001', name: '主人' },
    role: 'user',
    text,
    ts: localIso(),
  })
  return { ptr: `${r.file}#${r.id}`, id: r.id }
}

function daysAgo(n) {
  return localIso(new Date(Date.now() - n * 86_400_000))
}

// ── 情绪与衰减 ──────────────────────────────────────────────────────────

test('emotionalScore：强词多分，封顶 24', () => {
  assert.equal(emotionalScore('嗯'), 0)
  const one = emotionalScore('有点难过')
  const many = emotionalScore('难过 委屈 哭 心疼 想念 舍不得')
  assert.ok(one > 0)
  assert.ok(many > one)
  assert.equal(emotionalScore('难过 委屈 哭 心疼 想念 舍不得 抱抱 亲亲 陪伴 永远 最爱 在乎 重要'), 24)
})

test('retention：同样重要度，新事比旧事高', () => {
  const fresh = { imp: 60, created: localIso() }
  const old = { imp: 60, created: daysAgo(60) }
  assert.ok(retentionOf(fresh) > retentionOf(old))
})

test('retention：保护期内不罚，过期后按天扣', () => {
  const base = { imp: 50 }
  const d3 = retentionOf({ ...base, created: daysAgo(3) })
  const d5 = retentionOf({ ...base, created: daysAgo(5) })
  assert.equal(d3, d5, '保护期内（7 天）不扣时间惩罚')

  const d10 = retentionOf({ ...base, created: daysAgo(10) })
  assert.ok(d10 < d5)
})

test('retention：召回会把它往回拉', () => {
  const f = { imp: 40, created: daysAgo(30) }
  const none = retentionOf(f, { recall: 0 })
  const six = retentionOf(f, { recall: 6 })
  // 0.35 * 23 = 8.04999…，两个两位小数相减会带出 1e-15 级的尾巴，用容差比较
  assert.ok(Math.abs(six - none - 12) < 1e-6, `召回加成应为 12（封顶），实际 ${six - none}`)
})

test('retention：origin 不随时间衰减', () => {
  const f = { imp: 50, origin: true }
  // 都过了近期加成窗口，剩下的差异只可能来自时间惩罚
  assert.equal(retentionOf({ ...f, created: daysAgo(30) }), retentionOf({ ...f, created: daysAgo(365) }))
})

test('clarity：按阈值分档', () => {
  assert.equal(clarityOf(90), 'vivid')
  assert.equal(clarityOf(70), 'clear')
  assert.equal(clarityOf(50), 'fuzzy')
  assert.equal(clarityOf(30), 'trace')
  assert.equal(clarityOf(10), 'gone')
})

// ── 最初 ────────────────────────────────────────────────────────────────

test('originDraw：同 id 结果稳定，不同 id 会分散', () => {
  assert.equal(originDraw('fact_A'), originDraw('fact_A'))
  const draws = new Set()
  for (let i = 0; i < 20; i += 1) draws.add(originDraw(`fact_${i}`))
  assert.ok(draws.size > 10, '抽签应该分散')
})

test('originProbability：越久越难被标成最初', () => {
  assert.equal(originProbability(0), 0.9)
  assert.equal(originProbability(15), 0.55)
  assert.equal(originProbability(25), 0.3)
  assert.equal(originProbability(90), 0.03)
  assert.ok(originProbability(5) > originProbability(25))
})

test('shouldMarkOrigin：概率为 0.9 时多数命中，0.03 时极少', () => {
  let hitNew = 0
  let hitOld = 0
  for (let i = 0; i < 200; i += 1) {
    if (shouldMarkOrigin({ factId: `fact_${i}`, entryAgeDays: 1 })) hitNew += 1
    if (shouldMarkOrigin({ factId: `fact_${i}`, entryAgeDays: 100 })) hitOld += 1
  }
  assert.ok(hitNew > 140, `新条目的命中率应接近 90%，实际 ${hitNew}/200`)
  assert.ok(hitOld < 30, `老条目的命中率应接近 3%，实际 ${hitOld}/200`)
})

test('addFact：会写入 emotional 与 origin 字段', () => {
  const root = tmpRoot()
  const { ptr } = seedRaw(root)
  const r = addFact(root, PID, { topic: '情绪', text: '有点难过，想抱抱', src: ptr, origin: false })
  assert.ok(r.fact.emotional > 0)
  assert.equal(r.fact.origin, false)
})

test('addFact：可以显式指定 origin', () => {
  const root = tmpRoot()
  const { ptr } = seedRaw(root)
  const r = addFact(root, PID, { topic: '初见', text: '第一次见面是在十月', src: ptr, origin: true })
  assert.equal(r.fact.origin, true)
  assert.equal(classify(r.fact, { recall: 0 }), 'first')
})

// ── 三条带 ──────────────────────────────────────────────────────────────

test('classify：deep 需要「重要 + 被反复召回」两个条件', () => {
  const f = { imp: 90, emotional: 0, origin: false, created: localIso() }
  assert.equal(classify(f, { recall: 0 }), 'recent')
  assert.equal(classify(f, { recall: 3 }), 'deep')
})

test('classify：情绪浓度高也能进 deep', () => {
  const f = { imp: 40, emotional: 20, origin: false, created: localIso() }
  assert.equal(classify(f, { recall: 3 }), 'deep')
})

test('classify：旧事不新，也不够深刻 → 不属于任何带', () => {
  const f = { imp: 30, emotional: 0, origin: false, created: daysAgo(60) }
  assert.equal(classify(f, { recall: 0 }), null)
})

// ── 召回计数 ────────────────────────────────────────────────────────────

test('recordAccess / recallCounts：记一次数一次', () => {
  const root = tmpRoot()
  recordAccess(root, PID, ['fact_a', 'fact_b'], '测试')
  recordAccess(root, PID, ['fact_a'], '测试')
  const c = recallCounts(root, PID)
  assert.equal(c.get('fact_a'), 2)
  assert.equal(c.get('fact_b'), 1)
})

test('recall：默认会把命中的事实记进 access', () => {
  const root = tmpRoot()
  const { ptr } = seedRaw(root)
  addFact(root, PID, { topic: '备份', text: '备份脚本坏了', src: ptr, origin: false })
  recall(root, PID, '备份')
  recall(root, PID, '备份')
  assert.equal(recallCounts(root, PID).size, 1)
})

test('recall：track=false 时不记 access（避免"看一眼就算用过"）', () => {
  const root = tmpRoot()
  const { ptr } = seedRaw(root)
  addFact(root, PID, { topic: '备份', text: '备份脚本坏了', src: ptr, origin: false })
  recall(root, PID, '备份', { track: false })
  assert.equal(recallCounts(root, PID).size, 0)
})

// ── gone ────────────────────────────────────────────────────────────────

test('recall：沉到底（gone）的事默认不返回，--all 才给', () => {
  const root = tmpRoot()
  const { ptr } = seedRaw(root)
  addFact(root, PID, { topic: '旧事', text: '旧事一桩，早就过去了', src: ptr, imp: 10, origin: false, now: daysAgo(120) })

  assert.equal(recall(root, PID, '旧事').length, 0, 'gone 的事实不该出现在默认检索里')
  assert.equal(recall(root, PID, '旧事', { includeGone: true }).length, 1)
})

// ── 卡片 ────────────────────────────────────────────────────────────────

test('card：有「最初」时单独成段', () => {
  const root = tmpRoot()
  const { ptr } = seedRaw(root)
  addFact(root, PID, { topic: '初见', text: '第一次见面是在十月', src: ptr, origin: true })
  addFact(root, PID, { topic: '杂事', text: '今天风很大', src: ptr, origin: false })

  const card = buildCard(root, PID)
  assert.match(card, /\[最初\]/)
  assert.match(card, /第一次见面/)
})

test('card：预算不够时先砍「最新」，再砍「最深刻」，「最初」不动', () => {
  const root = tmpRoot()
  const { ptr } = seedRaw(root)
  addFact(root, PID, { topic: '初见', text: '最初的那件事要保住', src: ptr, origin: true })
  for (let i = 0; i < 12; i += 1) {
    addFact(root, PID, {
      topic: `杂事${i}`,
      text: `第 ${i} 条很长的近期事实，用来把预算撑爆，看看裁剪顺序对不对。`,
      src: ptr,
      imp: 70,
      origin: false,
    })
  }
  for (let i = 0; i < 3; i += 1) recall(root, PID, '最初', { track: true })

  const card = buildCard(root, PID, { budget: 160 })
  assert.ok(Buffer.byteLength(card, 'utf8') <= 160, `超预算：${Buffer.byteLength(card, 'utf8')}`)
  assert.match(card, /\[最初\]/, '「最初」不该被裁掉')
  assert.ok(!/\[最新\]/.test(card), '预算不够时应该先砍「最新」')
})

test('card：「最新」最多 5 条', () => {
  const root = tmpRoot()
  const { ptr } = seedRaw(root)
  for (let i = 0; i < 9; i += 1) {
    addFact(root, PID, { topic: `事${i}`, text: `近期第 ${i} 条`, src: ptr, origin: false })
  }
  const card = buildCard(root, PID, { budget: 2000 })
  const line = card.split('\n').find((l) => l.startsWith('[最新]'))
  assert.ok(line, '应该有「最新」段')
  assert.equal(line.split('；').length, 5, '「最新」配额是 5 条')
})

test('card：gone 的事实不进卡片', () => {
  const root = tmpRoot()
  const { ptr } = seedRaw(root)
  addFact(root, PID, { topic: '旧事', text: '早该沉底的旧事', src: ptr, imp: 5, origin: false, now: daysAgo(200) })
  const card = buildCard(root, PID)
  assert.ok(!card.includes('早该沉底的旧事'))
})
