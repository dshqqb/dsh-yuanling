// test/p62.test.mjs —— 规则页收口：记忆召回接上、动作黑名单删掉、根级硬线 never_inject 接上。
//
// 用户 2026-11-10 定的：
//   · 规则页只留「提案演化 / 开口意愿 / 记忆召回」；「黑名单」（按动作名）删掉；
//   · 记忆召回接上 hidden_kinds + min_importance，删掉 max_inject（和注入预算重复）；
//   · 根级硬线接上 never_inject（记下来但不进上下文），never_do 保留为宣言。
import { test, before } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { scaffold } from '../src/core/scaffold.js'
import { appendRecord } from '../src/core/raw.js'
import { localIso } from '../src/core/fsx.js'
import { addFact, buildCard, contextFor } from '../src/core/memory.js'
import { writeGlobalRules, RULE_FIELDS, loadGuardrails } from '../src/core/rules.js'
import { personaPaths } from '../src/core/paths.js'

const PID = 'yuanling'
let root

before(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'yuanling-p62-'))
  scaffold(root, {})
})

function ptr(text = '原始记录') {
  const r = appendRecord(root, {
    source: 'qq',
    acct: '1',
    channel: 'private:person_x',
    actor: { kind: 'owner', id: '1', name: '主人' },
    role: 'user',
    text,
    ts: localIso(),
  })
  return `${r.file}#${r.id}`
}

test('字段表：动作名黑名单已删除，记忆召回还在但没有 max_inject', () => {
  const names = RULE_FIELDS.map((g) => g.group)
  assert.ok(!names.includes('黑名单'), '按动作名的黑名单该删了')
  assert.ok(names.includes('记忆召回'))
  const recall = RULE_FIELDS.find((g) => g.group === '记忆召回')
  const paths = recall.fields.map((f) => f.path)
  assert.deepEqual(paths.sort(), ['recall.hidden_kinds', 'recall.min_importance'])
  assert.ok(!paths.includes('recall.max_inject'), 'max_inject 与注入预算重复，已删')
  assert.equal(recall.honored, true)
})

test('记忆召回：hidden_kinds 命中就不进上下文（但事实还在盘上、检索还能搜到）', () => {
  const src = ptr('我叫原灵')
  addFact(root, PID, { topic: '身份', text: '账号归属：QQ 12345', src, kind: 'identity-claim' })

  // 默认不隐藏 → 进卡片
  const before = buildCard(root, PID)
  assert.match(before, /账号归属/)

  writeGlobalRules(root, PID, { 'recall.hidden_kinds': ['identity-claim'] })
  const after = buildCard(root, PID)
  assert.ok(!after.includes('账号归属'), '被隐藏的事实不该进上下文')

  // 数据层没被删：条目文件里还在
  const rel = personaPaths(PID).spaces ?? null
  void rel
  const spacesDir = path.join(root, 'personas', PID, 'spaces')
  const all = fs
    .readdirSync(spacesDir, { recursive: true })
    .filter((f) => String(f).endsWith('.json'))
    .map((f) => fs.readFileSync(path.join(spacesDir, String(f)), 'utf8'))
    .join('\n')
  assert.match(all, /账号归属/, '隐藏只是不进上下文，不是删除')
})

test('记忆召回：min_importance 会把低分事实挡在外面', () => {
  const src = ptr('随手一提')
  addFact(root, PID, { topic: '碎事', text: '今天天气不错', src, imp: 5 })
  addFact(root, PID, { topic: '碎事', text: '下周三去看牙医（重要）', src, imp: 90 })

  writeGlobalRules(root, PID, { 'recall.min_importance': 50, 'recall.hidden_kinds': [] })
  const card = buildCard(root, PID)
  assert.ok(card.includes('看牙医'), '高分事实应该还在')
  assert.ok(!card.includes('天气不错'), '低分事实不该进上下文')
})

test('根级硬线 never_inject：记下来，但不进上下文', () => {
  const src = ptr('密钥相关')
  addFact(root, PID, { topic: '杂项', text: '他的邮箱是 someone@example.com', src, imp: 80 })

  // 先确认它本来会进卡片
  assert.match(buildCard(root, PID), /someone@example\.com/)

  // guardrails 在数据目录根上（不在 system/ 下）
  const gp = path.join(root, 'guardrails.json')
  const g = loadGuardrails(root)
  g.never_inject = ['someone@example.com']
  fs.writeFileSync(gp, JSON.stringify(g, null, 2), 'utf8')

  const card = buildCard(root, PID)
  assert.ok(!card.includes('someone@example.com'), '命中 never_inject 的内容不该出现在上下文里')

  // 但原始层和记忆里都还在（"记下来但不让她说"）
  const spacesDir = path.join(root, 'personas', PID, 'spaces')
  const all = fs
    .readdirSync(spacesDir, { recursive: true })
    .filter((f) => String(f).endsWith('.json'))
    .map((f) => fs.readFileSync(path.join(spacesDir, String(f)), 'utf8'))
    .join('\n')
  assert.match(all, /someone@example\.com/)
})

test('never_do 仍然是宣言：不参与过滤，也不会让卡片报错', () => {
  const g = loadGuardrails(root)
  assert.ok(Array.isArray(g.never_do), 'never_do 还在（它是宣言）')
  assert.ok((g.never_do ?? []).length >= 0)
  assert.ok(contextFor(root, PID, { preview: true }).length > 0)
})
