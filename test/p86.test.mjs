// test/p86.test.mjs —— 控制台对话的“记忆语义”测试（不依赖真实 DSH 模型）。
// 用一个假 Agent 验证：chat 写 raw，test 不写；两者都不影响对方。
import { test, before } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { scaffold } from '../src/core/scaffold.js'
import { bindConsoleRoot, createConsoleChat, ensureConsoleMaster, consoleHistory } from '../src/core/console.js'
import { listDays, readDay } from '../src/core/raw.js'

const PID = 'yuanling'
let root
let chat
let deniedTools = []

function makeCtx() {
  const agents = []
  const fakeAgents = {
    get: () => null,
    roots: () => [],
    resume: async () => { throw new Error('no session') },
    create: async ({ sessionId, setup }) => {
      if (setup) setup({ tools: { restrict: ({ deny }) => deniedTools.push(...(deny ?? [])) } })
      const messages = [{ role: 'system', content: [{ type: 'text', text: 'sys' }] }]
      let idle = false
      const agent = {
        id: sessionId,
        status: 'idle',
        model: { current: () => ({ provider: 'fake', model: 'fake' }) },
        session: { deriveMessages: () => messages },
        ctx: { on: () => {} },
        followup: ({ content }) => {
          messages.push({ role: 'user', content })
          setTimeout(() => {
            messages.push({ role: 'assistant', content: [{ type: 'text', text: sessionId.includes('-test') ? '测试回复' : '正常回复' }] })
            idle = true
          }, 20)
        },
        whenIdle: async () => {
          for (let i = 0; i < 30; i += 1) {
            if (idle) return
            await new Promise((r) => setTimeout(r, 10))
          }
        },
        cancel: () => {},
      }
      agents.push(agent)
      return { agent, dispose: async () => {} }
    },
  }
  return {
    get(name) {
      if (name === 'agents') return fakeAgents
      if (name === 'agentPresets') return { presetForSession: () => null, select: async () => {} }
      if (name === 'agentDefaultModel') return { currentSelection: () => ({ provider: 'fake', model: 'fake' }) }
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

test('chat：写 user + assistant 两条 raw', async () => {
  const events = []
  await chat.turn({ pid: PID, mode: 'chat', text: '正常一句', send: (e, d) => events.push([e, d]) })
  const done = events.find(([e]) => e === 'done')
  assert.ok(done)
  const day = listDays(root).at(-1)
  const rows = readDay(root, day).filter((r) => String(r.ext?.message_id || '').startsWith('turn_'))
  assert.equal(rows.length, 2)
  assert.equal(rows[0].source, 'dsh')
  assert.equal(rows[0].role, 'user')
  assert.equal(rows[1].role, 'bot')
})

test('test：有回复，但不写 raw', async () => {
  const before = listDays(root).flatMap((d) => readDay(root, d)).length
  deniedTools = []
  const events = []
  await chat.turn({ pid: PID, mode: 'test', text: '测试一句', send: (e, d) => events.push([e, d]) })
  assert.ok(events.some(([e]) => e === 'done'))
  assert.ok(deniedTools.includes('mcp__yuanling__yuanling_remember'))
  const after = listDays(root).flatMap((d) => readDay(root, d)).length
  assert.equal(after, before)
  assert.equal(consoleHistory(root, PID, 'test').at(-1).text, '测试回复')
  assert.equal(consoleHistory(root, PID, 'test').at(-1).test, true)
})
