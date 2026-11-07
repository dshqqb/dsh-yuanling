// test/p3.test.mjs —— 记忆层最小闭环：指针、写入、查重、槽位、检索、卡片。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { scaffold } from '../src/core/scaffold.js'
import { appendRecord } from '../src/core/raw.js'
import { localIso, ulid } from '../src/core/fsx.js'
import { parsePointer, resolvePointer } from '../src/core/pointer.js'
import {
  addFact,
  openEntry,
  recall,
  buildCard,
  listEntries,
  entryRel,
  safeName,
  scoreImportance,
  findDuplicate,
  CARD_BUDGET_BYTES,
} from '../src/core/memory.js'
import { history } from '../src/core/version.js'

const PID = 'yuanling'

function tmpRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'yuanling-p3-'))
  scaffold(root, {})
  return root
}

/** 先造一条 raw 记录，返回可用的证据指针。 */
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

// ── 指针 ────────────────────────────────────────────────────────────────

test('pointer：能解析，也能验证到真实记录', () => {
  const root = tmpRoot()
  const { ptr, id } = seedRaw(root)
  const p = parsePointer(ptr)
  assert.equal(p.kind, 'raw')
  assert.equal(p.id, id)
  assert.equal(resolvePointer(root, ptr).ok, true)
})

test('pointer：id 不存在要拒绝', () => {
  const root = tmpRoot()
  const { ptr } = seedRaw(root)
  const bad = ptr.replace(/#.*/, '#01JCV8K3M2QH7X9AAAAAAAAAA')
  const r = resolvePointer(root, bad)
  assert.equal(r.ok, false)
})

test('pointer：文件不存在要拒绝', () => {
  const root = tmpRoot()
  const r = resolvePointer(root, 'raw/2026-11/05/nope.ndjson#01JCV8K3M2QH7X9AAAAAAAAAA')
  assert.equal(r.ok, false)
})

// ── 写入 ────────────────────────────────────────────────────────────────

test('save：写入一条事实，带指针与重要度', () => {
  const root = tmpRoot()
  const { ptr } = seedRaw(root)

  const r = addFact(root, PID, { topic: '备份', text: '备份脚本的定时任务被宿主收走了', src: ptr })
  assert.equal(r.added, true)
  assert.ok(r.fact.id.startsWith('fact_'))
  assert.equal(r.fact.src, ptr)
  assert.ok(r.fact.imp >= 1 && r.fact.imp <= 100)
  assert.equal(r.fact.until, null)

  const file = path.join(root, entryRel(PID, '日常', '备份'))
  assert.ok(fs.existsSync(file), '条目文件应该落盘')
  const saved = JSON.parse(fs.readFileSync(file, 'utf8'))
  assert.equal(saved.facts.length, 1)
  assert.equal(saved.topic, '备份')
})

test('save：没有指针就拒绝（硬规则）', () => {
  const root = tmpRoot()
  assert.throws(() => addFact(root, PID, { topic: '备份', text: '凭记忆写的' }), /缺少证据指针/)
})

test('save：指针指不到记录也拒绝', () => {
  const root = tmpRoot()
  assert.throws(
    () => addFact(root, PID, { topic: '备份', text: 'x', src: 'raw/2026-11/05/qq.ndjson#01JCV8K3M2QH7X9AAAAAAAA' }),
    /证据指针无效/,
  )
})

test('save：写入会进版本历史（能回滚）', () => {
  const root = tmpRoot()
  const { ptr } = seedRaw(root)
  addFact(root, PID, { topic: '备份', text: '第一条事实', src: ptr })
  const h = history(root, entryRel(PID, '日常', '备份'))
  assert.equal(h.length, 1)
  assert.equal(h[0].kind, 'create')
})

// ── 查重 ────────────────────────────────────────────────────────────────

test('查重：完全相同不入', () => {
  const root = tmpRoot()
  const { ptr } = seedRaw(root)
  addFact(root, PID, { topic: '备份', text: '备份脚本坏了', src: ptr })
  const r = addFact(root, PID, { topic: '备份', text: '备份脚本坏了', src: ptr })
  assert.equal(r.added, false)
  assert.equal(r.reason, 'duplicate')
})

test('查重：短句被长句包含也不入', () => {
  const root = tmpRoot()
  const { ptr } = seedRaw(root)
  addFact(root, PID, { topic: '备份', text: '备份脚本的定时任务被宿主收走了', src: ptr })
  const r = addFact(root, PID, { topic: '备份', text: '备份脚本的定时任务被宿主收走了。', src: ptr })
  assert.equal(r.added, false)
})

test('查重：三句不同的话都能入', () => {
  const root = tmpRoot()
  const { ptr } = seedRaw(root)
  for (const t of ['备份脚本坏了', '今天风很大', '晚上吃了面']) {
    assert.equal(addFact(root, PID, { topic: '杂事', text: t, src: ptr }).added, true, t)
  }
  assert.equal(openEntry(root, PID, '杂事').active.length, 3)
})

// ── 槽位 ────────────────────────────────────────────────────────────────

test('槽位：同槽位新值自动关闭旧值，旧值不删', () => {
  const root = tmpRoot()
  const { ptr } = seedRaw(root)

  const a = addFact(root, PID, { topic: '环境', text: '包管理器用 npm', slot: '包管理', src: ptr })
  const b = addFact(root, PID, { topic: '环境', text: '包管理器改用 pnpm', slot: '包管理', src: ptr })

  assert.equal(b.added, true)
  assert.deepEqual(b.closed, [a.fact.id])

  const e = openEntry(root, PID, '环境')
  assert.equal(e.active.length, 1)
  assert.equal(e.expired.length, 1)
  assert.equal(e.expired[0].text, '包管理器用 npm')
  assert.equal(e.active[0].supersedes, a.fact.id)
  assert.ok(e.expired[0].until)
})

// ── 检索 ────────────────────────────────────────────────────────────────

test('recall：按词命中并返回指针', () => {
  const root = tmpRoot()
  const { ptr } = seedRaw(root)
  addFact(root, PID, { topic: '备份', text: '备份脚本的定时任务被宿主收走了', src: ptr })
  addFact(root, PID, { topic: '饮食', text: '晚上吃了面', src: ptr })

  const hits = recall(root, PID, '备份')
  assert.equal(hits.length, 1)
  assert.equal(hits[0].topic, '备份')
  assert.equal(hits[0].fact.src, ptr)
})

test('recall：默认不返回已失效的事实，--all 才返回', () => {
  const root = tmpRoot()
  const { ptr } = seedRaw(root)
  addFact(root, PID, { topic: '环境', text: '包管理器用 npm', slot: '包管理', src: ptr })
  addFact(root, PID, { topic: '环境', text: '包管理器改用 pnpm', slot: '包管理', src: ptr })

  // 回归：条目摘要一度被自动填成"第一条事实"，于是旧值 npm 借摘要复活，
  // 让「已失效」的查询命中新值。摘要不再自动生成后，这条必须为 0。
  assert.equal(recall(root, PID, 'npm').length, 0)
  assert.equal(recall(root, PID, 'npm', { includeExpired: true }).length, 1)

  // 新值仍然能被自己的词命中
  assert.equal(recall(root, PID, 'pnpm').length, 1)
})

test('recall：没命中就是空数组', () => {
  const root = tmpRoot()
  const { ptr } = seedRaw(root)
  addFact(root, PID, { topic: '备份', text: '备份脚本坏了', src: ptr })
  assert.deepEqual(recall(root, PID, '量子力学'), [])
})

// ── 卡片 ────────────────────────────────────────────────────────────────

test('card：空记忆时只有索引行', () => {
  const root = tmpRoot()
  const card = buildCard(root, PID)
  assert.match(card, /\[索引\] 0 条事实/)
})

test('card：有事实时包含骨架 / 最深刻 / 索引', () => {
  const root = tmpRoot()
  const { ptr } = seedRaw(root)
  // origin:false —— 「最初」由确定性抽签决定，测试里不要碰运气
  addFact(root, PID, { topic: '备份', text: '备份脚本的定时任务被宿主收走了', src: ptr, imp: 90, origin: false })

  // 「最深刻」要求被反复召回（recall ≥ 3）
  for (let i = 0; i < 3; i += 1) recall(root, PID, '备份')

  const card = buildCard(root, PID)
  assert.match(card, /\[骨架\] 原灵/)
  assert.match(card, /\[最深刻\]/)
  assert.match(card, /\[索引\] 1 条事实/)
})

test('card：超预算会裁掉「最新」，但绝不动「骨架」', () => {
  const root = tmpRoot()
  const { ptr } = seedRaw(root)
  // 文本必须唯一：只差序号的话会被 bigram 查重吃掉，卡片根本撑不起来
  for (let i = 0; i < 40; i += 1) {
    addFact(root, PID, {
      topic: `主题${i % 5}`,
      text: `第${i}条记录 ${ulid()} 用来把卡片撑爆，看看裁剪逻辑是否守规矩`,
      src: ptr,
      imp: 60 + (i % 30),
    })
  }

  // 先量出这张卡实际多大，再把预算压到刚好放不下——不猜数字
  const full = buildCard(root, PID, { budget: 1_000_000 })
  assert.ok(full.includes('[最新]'), '前提：这张卡本来是有「最新」的')
  const budget = Buffer.byteLength(full, 'utf8') - 20

  const card = buildCard(root, PID, { budget })
  assert.ok(Buffer.byteLength(card, 'utf8') <= budget, `卡片 ${Buffer.byteLength(card, 'utf8')} 字节仍超预算 ${budget}`)
  assert.match(card, /\[骨架\]/)
  assert.ok(!/\[最新\]/.test(card), '预算不够时必须先砍「最新」')
})

// ── 杂项 ────────────────────────────────────────────────────────────────

test('safeName：非法字符被替换', () => {
  assert.equal(safeName('a/b:c'), 'a_b_c')
  assert.throws(() => safeName('   '), /名字不能为空/)
})

test('importance：承诺比闲聊高', () => {
  const promise = scoreImportance('答应你下周把备份脚本修好')
  const chatter = scoreImportance('嗯')
  assert.ok(promise > chatter, `${promise} 应大于 ${chatter}`)
})

test('findDuplicate：长句里改几个字也能抓到', () => {
  const facts = [{ text: '备份脚本的定时任务被宿主收走了' }]
  const hit = findDuplicate(facts, '备份脚本的定时任务被宿主收走了啊')
  assert.ok(hit, '应该判为重复')
})

test('listEntries：列出所有条目', () => {
  const root = tmpRoot()
  const { ptr } = seedRaw(root)
  addFact(root, PID, { topic: '备份', text: 'a1', src: ptr })
  addFact(root, PID, { topic: '饮食', text: 'b1', src: ptr })
  const list = listEntries(root, PID)
  assert.equal(list.length, 2)
})
