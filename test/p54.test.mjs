// test/p54.test.mjs —— 表达层：她可以自己改的那一层。
//
// 三条要被钉住的不变量：
//   ① **写进去的每一条都会进上下文**（写入按注入预算卡住，不是"写了被悄悄截掉"）；
//   ② 每次改动都要 reason、都进版本历史、能回滚；
//   ③ 骨架（SELF.md）不在这条路径上——那层永远只有人能改。
import { test, before } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { scaffold } from '../src/core/scaffold.js'
import { personaPaths } from '../src/core/paths.js'
import { readStyle, addStyleLine, removeStyleLine, styleHistory, STYLE_MAX_ITEMS, STYLE_LINE_MAX } from '../src/core/style.js'
import { contextFor, EXPRESSION_BYTES } from '../src/core/memory.js'
import { history } from '../src/core/version.js'

const PID = 'yuanling'
let root

before(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'yuanling-p54-'))
  scaffold(root, {})
})

test('预算与上限是同一个数：写入上限不能大于注入预算', () => {
  // 如果写入允许 400 字节、注入只给 320，就会出现"写进去了但没生效"——最难查的那种
  assert.equal(EXPRESSION_BYTES, 320)
  assert.equal(readStyle(root, PID).budget, EXPRESSION_BYTES)
})

test('初始是空的（模板里的 <占位符> 不算条目）', () => {
  const s = readStyle(root, PID)
  assert.deepEqual(s.items, [])
  assert.equal(s.bytes, 0)
})

test('add：加进去、能读回来、并且真的进上下文', () => {
  const r = addStyleLine(root, PID, { line: '拿不准的时候说「我猜」', reason: '试过几次，这样说更自然' })
  assert.equal(r.changed, true)
  assert.deepEqual(r.items, ['拿不准的时候说「我猜」'])

  const ctx = contextFor(root, PID, { preview: true })
  assert.match(ctx, /\[习惯\] 拿不准的时候说「我猜」/)
})

test('add：前导 "- " 会被规范化，不会出现 "- -"', () => {
  addStyleLine(root, PID, { line: '-   不用感叹号收尾  ', reason: '用户说过两次' })
  const s = readStyle(root, PID)
  assert.ok(s.items.includes('不用感叹号收尾'))
  const raw = fs.readFileSync(path.join(root, personaPaths(PID).style), 'utf8')
  assert.ok(!raw.includes('- -'), raw)
})

test('add：重复的那条不会写第二遍（幂等）', () => {
  const before = fs.readFileSync(path.join(root, personaPaths(PID).style), 'utf8')
  const r = addStyleLine(root, PID, { line: '不用感叹号收尾', reason: '又想起一次' })
  assert.equal(r.changed, false)
  assert.equal(fs.readFileSync(path.join(root, personaPaths(PID).style), 'utf8'), before)
})

test('add：没写 reason 就拒绝（都要能回看"为什么养成"）', () => {
  assert.throws(() => addStyleLine(root, PID, { line: '新的习惯' }), /reason 必填/)
})

test('add：单条太长就拒绝，并说清多长', () => {
  assert.throws(
    () => addStyleLine(root, PID, { line: '啊'.repeat(STYLE_LINE_MAX + 5), reason: '想写长点' }),
    /最多 \d+ 字/,
  )
})

test('add：超预算就拒绝，并报出现在多少、加完多少（不悄悄截断）', () => {
  // 一路加到超预算为止：必须是被**拒绝**，而不是写进去之后注入时被截掉
  let err = null
  for (let i = 0; i < 40 && !err; i += 1) {
    try {
      addStyleLine(root, PID, { line: `习惯第 ${i} 条：说话要短`, reason: '压测预算' })
    } catch (e) {
      err = e
    }
  }
  assert.ok(err, '应该在某一条上被拒绝')
  assert.match(err.message, /超预算|最多 \d+ 条/)

  // 拒绝之后，文件里的东西必须仍然完整地进上下文（不多不少）
  const s = readStyle(root, PID)
  assert.ok(s.bytes <= s.budget, `落盘 ${s.bytes} 超过预算 ${s.budget}`)
  const ctx = contextFor(root, PID, { preview: true })
  for (const item of s.items) assert.ok(ctx.includes(item), `这一条没进上下文：${item}`)
})

test('remove：删掉之后立刻不在上下文里了', () => {
  const s0 = readStyle(root, PID)
  const target = s0.items[0]
  const r = removeStyleLine(root, PID, { line: target, reason: '不算固定习惯，去掉' })
  assert.equal(r.changed, true)
  const ctx = contextFor(root, PID, { preview: true })
  assert.ok(!ctx.includes(target), '删掉了却还在注入里')
})

test('remove：找不到就明确报错，列出已有的（不静默成功）', () => {
  assert.throws(() => removeStyleLine(root, PID, { line: '根本不存在的一条', reason: 'x' }), /没有这一条/)
})

test('每一次改动都进版本历史，actor 是模型', () => {
  const h = styleHistory(root, PID)
  assert.ok(h.length >= 2)
  assert.equal(h[h.length - 1].actor, 'model:style')
  assert.ok(h[h.length - 1].reason)
  assert.ok(history(root, personaPaths(PID).style).length >= 2)
})

test('她改不了骨架：SELF.md 没有模型可调的写路径', () => {
  // 表达层的工具只碰 style.md；SELF.md 在 personacard 里只接受 human:editor。
  // 这条测试盯的是"别哪天有人顺手给骨架也开个模型工具"。
  const stylePath = path.join(root, personaPaths(PID).style)
  const selfPath = path.join(root, personaPaths(PID).self)
  const selfBefore = fs.readFileSync(selfPath, 'utf8')

  addStyleLine(root, PID, { line: '这条只会写进表达层', reason: '验证边界' })
  assert.equal(fs.readFileSync(selfPath, 'utf8'), selfBefore, '写表达层不该动到 SELF.md')
  assert.ok(fs.existsSync(stylePath))
})
