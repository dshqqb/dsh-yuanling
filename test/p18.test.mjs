// test/p18.test.mjs —— MCP server：协议握手、工具清单、真实取回记忆。
//
// 直接 spawn mcp-server.mjs 走 stdio，验证的是"DSH 真会这么问"的那套流程。
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import readline from 'node:readline'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

import { scaffold } from '../src/core/scaffold.js'
import { appendRecord } from '../src/core/raw.js'
import { localIso, ulid } from '../src/core/fsx.js'
import { addFact } from '../src/core/memory.js'
import { createPerson, linkIdentity, writeProfile } from '../src/core/entities.js'

const PID = 'yuanling'
const HERE = path.dirname(fileURLToPath(import.meta.url))
const SERVER = path.join(HERE, '..', 'mcp-server.mjs')

let root
let child
let call
let nextId = 1

function makeClient(proc) {
  const pending = new Map()
  const rl = readline.createInterface({ input: proc.stdout })
  rl.on('line', (line) => {
    let msg = null
    try {
      msg = JSON.parse(line)
    } catch {
      return
    }
    const waiter = msg?.id !== undefined ? pending.get(msg.id) : null
    if (waiter) {
      pending.delete(msg.id)
      waiter.resolve(msg)
    }
  })

  return (method, params, { notify = false } = {}) => {
    const id = notify ? undefined : nextId++
    const frame = { jsonrpc: '2.0', method, params }
    if (!notify) frame.id = id
    proc.stdin.write(`${JSON.stringify(frame)}\n`)

    if (notify) return Promise.resolve(null)
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject })
      setTimeout(() => {
        if (!pending.has(id)) return
        pending.delete(id)
        reject(new Error(`MCP 无响应：${method}`))
      }, 8000).unref?.()
    })
  }
}

const toolText = (res) => {
  assert.equal(res?.result?.isError, false, '工具执行不该报错')
  assert.ok(Array.isArray(res.result.content), '要有 content 数组')
  return res.result.content.map((c) => c.text).join('\n')
}

before(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'yuanling-p18-'))
  scaffold(root, {})

  // 一点真实数据：一条可检索的事实 + 一个在场的人
  const r = appendRecord(root, {
    source: 'qq',
    acct: '10001',
    channel: 'private:10001',
    actor: { kind: 'owner', id: '10001', name: '主人' },
    role: 'user',
    text: `今天去面试了 ${ulid()}`,
    ts: localIso(),
  })
  addFact(root, PID, { topic: '生活', text: '面试没过，有点难过', src: `${r.file}#${r.id}` })

  const p = createPerson(root, { display: '张三' })
  linkIdentity(root, p.uid, { platform: 'qq', id: '10001' })
  writeProfile(root, PID, p.uid, { sketch: '话不多，爱较真' })

  // 用 --root 传数据目录：这正是 mcp install 写进 args 的形式
  child = spawn(process.execPath, [SERVER, '--root', root], {
    env: { ...process.env, YUANLING_HOME: '' },
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  call = makeClient(child)
  await call('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test' } })
})

after(() => {
  child?.kill()
})

test('initialize：握手返回 yuanling 与 tools 能力', async () => {
  // 再握一次，验证幂等与字段
  const res = await call('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test2' } })
  assert.equal(res.result.serverInfo.name, 'yuanling')
  assert.equal(res.result.protocolVersion, '2025-06-18', '回显客户端版本')
  assert.ok(res.result.capabilities.tools, '必须声明 tools 能力')
})

test('tools/list：十三个工具，schema 都是 object', async () => {
  const res = await call('tools/list', {})
  const names = res.result.tools.map((t) => t.name)
  assert.deepEqual(names.sort(), [
    'yuanling_account',
    'yuanling_context',
    'yuanling_drive',
    'yuanling_fetch',
    'yuanling_group',
    'yuanling_observe',
    'yuanling_person_merge',
    'yuanling_person_split',
    'yuanling_purpose',
    'yuanling_recall',
    'yuanling_remember',
    'yuanling_sources',
    'yuanling_style',
  ])
  for (const t of res.result.tools) {
    assert.equal(t.inputSchema.type, 'object')
    assert.ok(t.description, '工具必须有描述，否则模型不知道什么时候调')
  }
})

test('tools/list：context 的描述写明「每轮必调」——不靠宿主提示也能提醒模型', async () => {
  const res = await call('tools/list', {})
  const ctxTool = res.result.tools.find((t) => t.name === 'yuanling_context')
  assert.match(ctxTool.description, /每轮必调/)
  assert.match(ctxTool.description, /不调用就等于失忆/)
})

test('yuanling_context：私聊取回记忆卡与在场的人', async () => {
  const res = await call('tools/call', { name: 'yuanling_context', arguments: { channel: 'private:10001' } })
  const text = toolText(res)
  assert.match(text, /\[骨架\]/)
  assert.match(text, /\[索引\]/)
  assert.match(text, /\[人物\].*张三/, '在场的人应该有卡')
  assert.match(text, /话不多/, '卡里要带素描')
})

test('yuanling_context：不传频道时只有记忆卡，不硬编人物', async () => {
  const res = await call('tools/call', { name: 'yuanling_context', arguments: {} })
  const text = toolText(res)
  assert.ok(!text.includes('[人物]'))
})

test('yuanling_recall：命中并带证据指针', async () => {
  const res = await call('tools/call', { name: 'yuanling_recall', arguments: { query: '面试' } })
  const text = toolText(res)
  assert.match(text, /面试/)
  assert.match(text, /证据：raw\//, '必须能指回原文')
})

test('yuanling_recall：没有 query 时报错而不是崩', async () => {
  const res = await call('tools/call', { name: 'yuanling_recall', arguments: {} })
  assert.equal(res.result.isError, true)
  assert.match(toolText({ result: { ...res.result, isError: false } }), /缺少 query/)
})

test('未知工具：isError 为真，且连接没断', async () => {
  const bad = await call('tools/call', { name: 'nope', arguments: {} })
  assert.equal(bad.result.isError, true)

  const ping = await call('ping', {})
  assert.ok(ping.result !== undefined, '出错后仍能应答')
})

test('通知帧（无 id）不产生响应，也不打断后续请求', async () => {
  await call('notifications/initialized', {}, { notify: true })
  const ping = await call('ping', {})
  assert.deepEqual(ping.result, {})
})

test('坏 JSON 帧不会弄崩服务', async () => {
  child.stdin.write('{not json\n')
  const ping = await call('ping', {})
  assert.deepEqual(ping.result, {})
})
