// test/p10.test.mjs —— 演化提案：重复 → 提案 → 批准/否决/自动批准/回滚。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { scaffold } from '../src/core/scaffold.js'
import { appendRecord } from '../src/core/raw.js'
import { localIso } from '../src/core/fsx.js'
import { addFact, listEntries } from '../src/core/memory.js'
import { scan, listProposals, findProposal, approve, reject, rollback, sweep, styleRel, readPolicy, writePolicy } from '../src/core/proposals.js'
import { history } from '../src/core/version.js'

const PID = 'yuanling'

function tmpRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'yuanling-p10-'))
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

const daysAgo = (n) => localIso(new Date(Date.now() - n * 86_400_000))

/** 把一句话重复说 times 次，跨 days 天。 */
function repeatClaim(root, { topic = '说话方式', text = '别用颜文字', times = 5, startDaysAgo = 6 } = {}) {
  const src = seedRaw(root, `原文-${text}`)
  addFact(root, PID, { topic, text, src, now: daysAgo(startDaysAgo) })
  for (let i = 1; i < times; i += 1) {
    addFact(root, PID, { topic, text, src, now: daysAgo(startDaysAgo - i) })
  }
  return src
}

const styleText = (root) => fs.readFileSync(path.join(root, styleRel(PID)), 'utf8')

// ── 重复是信号 ──────────────────────────────────────────────────────────

test('重复：同一句话再说一次不新增事实，但累计 repeat', () => {
  const root = tmpRoot()
  const src = seedRaw(root)
  const t2 = daysAgo(2) // 只算一次：断言时再算会跨秒
  const a = addFact(root, PID, { topic: '说话方式', text: '别用颜文字', src, now: daysAgo(3) })
  const b = addFact(root, PID, { topic: '说话方式', text: '别用颜文字', src, now: t2 })

  assert.equal(a.added, true)
  assert.equal(b.added, false)
  assert.equal(b.repeated, true)

  const facts = listEntries(root, PID).flatMap((e) => e.facts)
  assert.equal(facts.length, 1, '不该多出一条事实')
  assert.equal(facts[0].repeat, 2)
  assert.equal(facts[0].last_seen, t2)
})

test('重复：证据会累积，便于日后解释"为什么提这条"', () => {
  const root = tmpRoot()
  const s1 = seedRaw(root, '第一次说')
  const s2 = seedRaw(root, '第二次说')
  addFact(root, PID, { topic: 't', text: '别用颜文字', src: s1, now: daysAgo(3) })
  addFact(root, PID, { topic: 't', text: '别用颜文字', src: s2, now: daysAgo(2) })

  const f = listEntries(root, PID).flatMap((e) => e.facts)[0]
  assert.equal(f.srcs.length, 2)
  assert.ok(f.srcs.includes(s1) && f.srcs.includes(s2))
})

// ── 提案生成 ────────────────────────────────────────────────────────────

test('scan：次数不够就不提', () => {
  const root = tmpRoot()
  repeatClaim(root, { times: 3, startDaysAgo: 5 })
  assert.deepEqual(scan(root, PID, { minRepeat: 5 }), [])
})

test('scan：跨度不够也不提', () => {
  const root = tmpRoot()
  const src = seedRaw(root)
  for (let i = 0; i < 5; i += 1) addFact(root, PID, { topic: 't', text: '别用颜文字', src, now: daysAgo(1) })
  assert.deepEqual(scan(root, PID, { minRepeat: 5, minDays: 3 }), [])
})

test('scan：次数与跨度都够 → 出提案，带证据与统计', () => {
  const root = tmpRoot()
  const src = repeatClaim(root)
  const list = scan(root, PID)

  assert.equal(list.length, 1)
  const p = list[0]
  assert.equal(p.status, 'pending')
  assert.equal(p.claim, '别用颜文字')
  assert.ok(p.count >= 5)
  assert.ok(p.days >= 3)
  assert.ok(p.evidence.length >= 1)
  assert.equal(p.evidence[0].src, src)
})

test('scan：幂等，同一主张不会重复提；已否决的也不再提', () => {
  const root = tmpRoot()
  repeatClaim(root)
  const first = scan(root, PID)
  assert.equal(first.length, 1)

  assert.equal(scan(root, PID).length, 0, '第二次不该再提')
  reject(root, PID, first[0].id)
  assert.equal(scan(root, PID).length, 0, '否决过的不该复活')
})

// ── 批准 ────────────────────────────────────────────────────────────────

test('approve：把主张写进 style.md，并记下回滚锚点', () => {
  const root = tmpRoot()
  repeatClaim(root)
  const [p] = scan(root, PID)

  const before = styleText(root)
  const r = approve(root, PID, p.id, { now: daysAgo(0) })

  assert.equal(r.changed, true)
  assert.ok(styleText(root).includes('别用颜文字'))
  assert.ok(styleText(root).length > before.length)
  assert.ok(r.proposal.applied.before_hash)
  assert.ok(r.proposal.rollback_until)
})

test('approve：重复批准是幂等的', () => {
  const root = tmpRoot()
  repeatClaim(root)
  const [p] = scan(root, PID)
  approve(root, PID, p.id)
  const again = approve(root, PID, p.id)
  assert.equal(again.changed, false)
})

test('approve：已否决的不能批准', () => {
  const root = tmpRoot()
  repeatClaim(root)
  const [p] = scan(root, PID)
  reject(root, PID, p.id)
  assert.throws(() => approve(root, PID, p.id), /已被否决/)
})

// ── 回滚 ────────────────────────────────────────────────────────────────

test('rollback：7 天内能把 style.md 退回去', () => {
  const root = tmpRoot()
  repeatClaim(root)
  const [p] = scan(root, PID)
  const before = styleText(root)

  approve(root, PID, p.id, { now: daysAgo(2) })
  assert.ok(styleText(root).includes('别用颜文字'))

  rollback(root, PID, p.id, { now: daysAgo(1) })
  assert.equal(styleText(root), before)
  assert.equal(findProposal(root, PID, p.id).status, 'rolled_back')
})

test('rollback：超过窗口就拒绝', () => {
  const root = tmpRoot()
  repeatClaim(root)
  const [p] = scan(root, PID)
  approve(root, PID, p.id, { now: daysAgo(10) })
  assert.throws(() => rollback(root, PID, p.id, { now: daysAgo(0) }), /窗口已过/)
})

test('rollback：回滚本身也进版本历史（可再回滚）', () => {
  const root = tmpRoot()
  repeatClaim(root)
  const [p] = scan(root, PID)
  approve(root, PID, p.id, { now: daysAgo(2) })
  rollback(root, PID, p.id, { now: daysAgo(1) })

  const h = history(root, styleRel(PID))
  assert.ok(h.length >= 2, '采纳与回滚都该留版本')
})

// ── 自动批准 ────────────────────────────────────────────────────────────

test('sweep：到期且没被否决 → 自动批准', () => {
  const root = tmpRoot()
  repeatClaim(root)
  const [p] = scan(root, PID, { now: daysAgo(10) })

  const r = sweep(root, PID, { now: daysAgo(2) })
  assert.ok(r.approved.includes(p.id))
  assert.equal(findProposal(root, PID, p.id).decided_by, 'auto')
  assert.ok(styleText(root).includes('别用颜文字'))
})

test('sweep：被否决的不会被自动批准', () => {
  const root = tmpRoot()
  repeatClaim(root)
  const [p] = scan(root, PID, { now: daysAgo(10) })
  reject(root, PID, p.id)

  const r = sweep(root, PID, { now: daysAgo(2) })
  assert.deepEqual(r.approved, [])
  assert.ok(!styleText(root).includes('别用颜文字'))
})

test('sweep：默认 3 天到期（不是 7 天）', () => {
  const root = tmpRoot()
  repeatClaim(root)
  const [p] = scan(root, PID, { now: daysAgo(5) })
  const created = Date.parse(p.created)
  const autoAt = Date.parse(p.auto_approve_at)
  assert.ok(Math.abs(autoAt - created - 3 * 86_400_000) < 1000, '默认应该是 3 天')

  assert.deepEqual(sweep(root, PID, { now: daysAgo(3) }).approved, [], '第 3 天还不到期')
  assert.equal(sweep(root, PID, { now: daysAgo(2) }).approved.length, 1, '第 2 天应该到期')
})

test('policy：把每日上限改成 2，同一天可以批 2 条', () => {
  const root = tmpRoot()
  writePolicy(root, { autoApproveDays: 3, dailyAutoLimit: 2 })
  repeatClaim(root, { text: '别用颜文字' })
  repeatClaim(root, { text: '回话短一点' })
  scan(root, PID, { now: daysAgo(10) })

  const r = sweep(root, PID, { now: daysAgo(0) })
  assert.equal(r.approved.length, 2)
  assert.equal(readPolicy(root).dailyAutoLimit, 2)
})

test('policy：每日配额按天重置', () => {
  const root = tmpRoot()
  writePolicy(root, { autoApproveDays: 3, dailyAutoLimit: 1 })
  repeatClaim(root, { text: '别用颜文字' })
  repeatClaim(root, { text: '回话短一点' })
  scan(root, PID, { now: daysAgo(10) })

  const d0 = localIso(new Date(Date.now() - 0 * 86_400_000))
  const d1 = localIso(new Date(Date.now() + 1 * 86_400_000))

  const first = sweep(root, PID, { now: d0 })
  assert.equal(first.approved.length, 1, '当天只能批 1 条')

  const second = sweep(root, PID, { now: d1 })
  assert.equal(second.approved.length, 1, '第二天配额重置，再批 1 条')
})

test('policy：把到期改成 1 天，已有提案立刻按新设置算', () => {
  const root = tmpRoot()
  writePolicy(root, { autoApproveDays: 1, dailyAutoLimit: 1 })
  repeatClaim(root)
  scan(root, PID, { now: daysAgo(5) })

  const r = sweep(root, PID, { now: daysAgo(4) })
  assert.equal(r.approved.length, 1)
  assert.equal(r.days, 1)
})

test('proposal：否决后不再出现在待定列表里', () => {
  const root = tmpRoot()
  repeatClaim(root)
  const [p] = scan(root, PID)
  reject(root, PID, p.id)

  assert.equal(listProposals(root, PID).filter((x) => x.status === 'pending').length, 0)
  assert.equal(listProposals(root, PID).length, 1, '记录仍然保留，只是状态变了')
})
