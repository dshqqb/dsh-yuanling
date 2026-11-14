// test/p86.test.mjs —— 控制台对话的“记忆语义”测试（不依赖真实 DSH 模型）。
// 用假 subagent 验证：chat 写 raw，test 不写；两者都走 subagent child。
import { test, before } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { scaffold } from '../src/core/scaffold.js'
import { bindConsoleRoot, createConsoleChat, ensureConsoleMaster, consoleHistory } from '../src/core/console.js'
import { readConsoleModel } from '../src/core/model.js'
import { listDays, readDay } from '../src/core/raw.js'

const PID = 'yuanling'
let root
let chat
let calls = []

function makeCtx() {
  const parent = { id: 'main', model: { current: () => ({ provider: 'fake', model: 'fake-model' }) } }
  const child = { ctx: { on: () => () => {} } }
  const subagents = {
    startActivation: async (spec) => {
      calls.push(spec)
      const isTest = spec.request.agentPreset === 'yuanling-console-test'
      return {
        childId: `child-${calls.length}`,
        result: Promise.resolve({ output: [{ type: 'text', text: isTest ? '测试回复' : '正常回复' }], stopReason: 'completed' }),
        dispose: async () => {},
      }
    },
  }
  return {
    get(name) {
      if (name === 'agents') return { roots: () => [parent], get: () => child }
      if (name === 'subagents') return subagents
      if (name === 'llm') {
        return {
          listProviders: () => [{ id: 'fake', name: 'Fake' }],
          listModels: async () => [{ id: 'fake-model', name: 'Fake Model' }],
          resolveModelInfo: async (provider, model) => ({
            provider,
            id: model,
            name: 'Fake Model',
            reasoning: { efforts: [{ id: 'low', name: '低' }], defaultEffort: 'low' },
          }),
        }
      }
      return null
    },
  }
}

before(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'yuanling-p86-'))
  scaffold(root, {})
  ensureConsoleMaster(root, PID)
  bindConsoleRoot(root)
  chat = createConsoleChat(makeCtx())
})

test('chat：走 subagent child，写 user + assistant 两条 raw', async () => {
  const events = []
  await chat.turn({ pid: PID, mode: 'chat', text: '正常一句', send: (e, d) => events.push([e, d]) })
  assert.ok(events.some(([e]) => e === 'done'))
  assert.equal(calls.at(-1).request.agentPreset, 'yuanling-console')
  const day = listDays(root).at(-1)
  const rows = readDay(root, day).filter((r) => String(r.ext?.message_id || '').startsWith('turn_'))
  assert.equal(rows.length, 2)
  assert.equal(rows[0].source, 'dsh')
  assert.equal(rows[0].role, 'user')
  assert.equal(rows[1].role, 'bot')
})

test('test：走测试 preset，有回复但不写 raw', async () => {
  const before = listDays(root).flatMap((d) => readDay(root, d)).length
  const events = []
  await chat.turn({ pid: PID, mode: 'test', text: '测试一句', send: (e, d) => events.push([e, d]) })
  assert.ok(events.some(([e]) => e === 'done'))
  assert.equal(calls.at(-1).request.agentPreset, 'yuanling-console-test')
  const after = listDays(root).flatMap((d) => readDay(root, d)).length
  assert.equal(after, before)
  assert.equal(consoleHistory(root, PID, 'test').at(-1).text, '测试回复')
  assert.equal(consoleHistory(root, PID, 'test').at(-1).test, true)
})

test('切换模型：写文件，下一轮 subagent 使用新模型', async () => {
  const r = await chat.selectModel({ provider: 'fake', model: 'fake-model', reasoningEffort: 'low' })
  assert.deepEqual(r.current, { provider: 'fake', model: 'fake-model', reasoningEffort: 'low' })
  assert.deepEqual(readConsoleModel(root), { provider: 'fake', model: 'fake-model', reasoningEffort: 'low' })
  await chat.turn({ pid: PID, mode: 'chat', text: '再一句', send: () => {} })
  assert.deepEqual(calls.at(-1).request.agentOptions, { provider: 'fake', model: 'fake-model', reasoningEffort: 'low' })
})
