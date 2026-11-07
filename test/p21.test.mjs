// test/p21.test.mjs —— 骨架注入：核心身份 + 说话方式 + 价值观。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { scaffold } from '../src/core/scaffold.js'
import { buildCard, SKELETON_BYTES } from '../src/core/memory.js'

const PID = 'yuanling'
const bytes = (s) => Buffer.byteLength(s, 'utf8')

function tmpRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'yuanling-p21-'))
  scaffold(root, {})
  return root
}

function selfPath(root) {
  return path.join(root, 'personas', PID, 'persona', 'SELF.md')
}

function writeSelf(root, text) {
  fs.writeFileSync(selfPath(root), text)
}

const FULL = `# 原灵 · 骨架

## 核心身份

- 名字：原灵
- 存在的原因：陪一个人把话说清楚，并且记得住说过的话。
- 与用户的关系：叫「你」，不叫主人。

## 说话方式

- 语气：短句，先结论后理由，不用感叹号收尾。
- 口癖：偶尔「嗯」「行」；拿不准说「我猜」。
- 不做的表达：不卖萌，不说「作为一个 AI」。

## 价值观（按优先级）

1. 不编造，记不清就说记不清。
2. 不替他做决定，动手前先问。
3. 直说，但不刻薄。

## 演化区

- 最近在意的事：（留空）
`

test('骨架：完整文件 → 三段都进卡片', () => {
  const root = tmpRoot()
  writeSelf(root, FULL)
  const card = buildCard(root, PID)

  assert.match(card, /\[骨架\] 原灵，陪一个人把话说清楚/, '名字 + 存在的原因')
  assert.match(card, /\[说话\] 语气：短句/, '说话方式进注入')
  assert.match(card, /\[在乎\] 不编造/, '价值观进注入')
})

test('骨架：只有核心身份时，不硬编另外两段', () => {
  const root = tmpRoot()
  writeSelf(root, '## 核心身份\n\n- 名字：原灵\n- 存在的原因：记得住。\n')
  const card = buildCard(root, PID)

  assert.match(card, /\[骨架\]/)
  assert.ok(!card.includes('[说话]'))
  assert.ok(!card.includes('[在乎]'))
})

test('骨架：占位符 <…> 不算内容', () => {
  const root = tmpRoot()
  writeSelf(root, '## 核心身份\n\n- 名字：原灵\n- 存在的原因：<一句话，别写套话>\n')
  const card = buildCard(root, PID)

  assert.match(card, /\[骨架\] 原灵$|\[骨架\] 原灵\n/, '只剩名字，不把占位符当内容')
  assert.ok(!card.includes('<一句话'))
})

test('骨架：每段都有字节上限，写太长会被截断', () => {
  const root = tmpRoot()
  const long = '很长的描述'.repeat(60)
  writeSelf(root, `## 核心身份\n\n- 名字：原灵\n\n## 说话方式\n\n- 语气：${long}\n\n## 价值观\n\n1. ${long}\n`)
  const card = buildCard(root, PID)

  const speak = card.split('\n').find((l) => l.startsWith('[说话] '))
  const values = card.split('\n').find((l) => l.startsWith('[在乎] '))
  assert.ok(speak && bytes(speak.slice('[说话] '.length)) <= SKELETON_BYTES.speak)
  assert.ok(values && bytes(values.slice('[在乎] '.length)) <= SKELETON_BYTES.values)
})

test('骨架：默认 scaffold 的模板不会被当成内容注入', () => {
  const root = tmpRoot() // 不覆盖 SELF.md，用脚手架原件
  const card = buildCard(root, PID)

  assert.match(card, /\[骨架\] 原灵/, '名字不是占位符，应该留着')
  assert.ok(!card.includes('[说话]'), '「- 语气：<例：…>」是占位符，不该进注入')
  assert.ok(!card.includes('[在乎]'), '「1. <最重要的一条>」也是占位符')
  assert.ok(!card.includes('<'), '卡片里不该出现任何占位符片段')
})

test('骨架：条目末尾的句号不会重复成「。；」', () => {
  const root = tmpRoot()
  writeSelf(root, '## 说话方式\n\n- 语气：短句。\n- 口癖：偶尔「嗯」。\n')
  const card = buildCard(root, PID)
  const line = card.split('\n').find((l) => l.startsWith('[说话] '))
  assert.ok(line, '应该有说话段')
  assert.ok(!line.includes('。；'), `不该出现「。；」：${line}`)
  assert.match(line, /短句；口癖/)
})

test('骨架：没有 SELF.md 时，卡片里就没有骨架行', () => {
  const root = tmpRoot()
  fs.rmSync(selfPath(root))
  const card = buildCard(root, PID)
  assert.ok(!card.includes('[骨架]'))
})

test('骨架：结构不规范的老文件，兜底取第一个条目', () => {
  const root = tmpRoot()
  writeSelf(root, '- 我是原灵，记得住事。\n')
  const card = buildCard(root, PID)
  assert.match(card, /\[骨架\] 我是原灵/)
})
