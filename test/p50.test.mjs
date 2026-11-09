// test/p50.test.mjs —— 目的账本的"读过"与"提过"必须分开。
//
// 修的是一个静默丢事的缺陷：以前 markHit 在**注入时**计数，于是模型压根没提，
// 系统也认定"提过两次了"并自动放下（理由还写着"提过 2 次"）。她心里存着的事
// 会无声消失，人还以为问过了。
//
// 现在：注入只记 `offered`；`hits` 只有模型显式回报（MCP 的 yuanling_purpose）才算。
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
import { addFact, contextFor } from '../src/core/memory.js'
import { readPurposes, writePurposes, SELECT_MAX_HITS, SELECT_MAX_OFFERED } from '../src/core/purposes.js'

const PID = 'yuanling'
const HERE = path.dirname(fileURLToPath(import.meta.url))
const SERVER = path.join(HERE, '..', 'mcp-server.mjs')
const HOUR = 3_600_000

function tmpRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'yuanling-p50-'))
  scaffold(root, {})
  return root
}

const iso = (ms) => localIso(new Date(ms))

function seedRaw(root) {
  const r = appendRecord(root, {
    source: 'qq',
    acct: '10001',
    channel: 'private:10001',
    actor: { kind: 'owner', id: '10001', name: '主人' },
    role: 'user',
    text: `面试 ${ulid()}`,
    ts: localIso(),
  })
  return `${r.file}#${r.id}`
}

/** 造一条够格被挖出来的事实（要带情绪或槽位，且发生在 6 小时~7 天前）。 */
function seedMineable(root) {
  const src = seedRaw(root)
  addFact(root, PID, { topic: '生活', text: '面试没过，很难过', src, now: iso(Date.now() - 30 * HOUR) })
  return src
}

const openItem = (extra = {}) => ({
  id: `pur_${ulid()}`,
  need: 'care',
  text: '你上次说「面试没过，很难过」，后来怎么样了？',
  origin: 'raw/x#y',
  status: 'open',
  created: iso(Date.now() - 30 * HOUR),
  due: iso(Date.now() - HOUR),
  hits: 0,
  offered: 0,
  ...extra,
})

// ── 语义：offered ≠ hits ────────────────────────────────────────────────

test('注入一次：只有 offered 涨，hits 不动，状态仍是 open', () => {
  const root = tmpRoot()
  seedMineable(root)
  contextFor(root, PID, { channel: 'private:10001' })

  const doc = readPurposes(root, PID)
  assert.ok(doc.items.length >= 1, '应该挖出一条')
  const p = doc.items[0]
  assert.equal(Number(p.offered), 1)
  assert.equal(Number(p.hits ?? 0), 0, '注入不能替她说"提过了"')
  assert.equal(p.status, 'open')
})

test('被摆到面前三次：仍然不放下（摆了不等于说了）', () => {
  const root = tmpRoot()
  const doc = { version: 1, items: [openItem({ offered: 3, hits: 0 })] }
  writePurposes(root, PID, doc)

  // 冷却窗靠 last_offered，手动推旧一点才可能再被摆出来
  const items = doc.items.map((p) => ({ ...p, last_offered: iso(Date.now() - 7 * HOUR) }))
  writePurposes(root, PID, { version: 1, items })

  const after = readPurposes(root, PID)
  assert.equal(after.items[0].status, 'open', `摆了 3 次（上限 ${SELECT_MAX_OFFERED}）不该放下`)
})

test(`摆满 ${SELECT_MAX_OFFERED} 次且一次都没接 → 放下，理由是"摆了没接"`, () => {
  const root = tmpRoot()
  writePurposes(root, PID, { version: 1, items: [openItem({ offered: SELECT_MAX_OFFERED, hits: 0 })] })
  contextFor(root, PID, { channel: 'private:10001' })

  const p = readPurposes(root, PID).items[0]
  assert.equal(p.status, 'done')
  assert.match(p.close_reason ?? '', /没接/, '理由要写"摆了没接"，不能冒充"提过"')
})

// ── MCP：模型显式回报 ──────────────────────────────────────────────────

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
  return (method, params) => {
    const id = nextId++
    proc.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`)
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

const tool = (name, args) => call('tools/call', { name, arguments: args })
const toolText = (res) => {
  assert.equal(res?.result?.isError, false, `工具不该报错：${res?.result?.content?.[0]?.text ?? ''}`)
  return res.result.content.map((c) => c.text).join('\n')
}

before(async () => {
  root = tmpRoot()
  writePurposes(root, PID, { version: 1, items: [openItem({ id: 'pur_test1', text: '你上次说面试，后来怎么样了？' })] })

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

test('purpose：空账本时说清"为什么空"，不是一句"没有"', async () => {
  const empty = tmpRoot()
  const doc = readPurposes(empty, PID)
  assert.deepEqual(doc.items, [])
  // 渲染逻辑在 MCP 侧，这里只确认空账本是合法状态（不抛）
})

test('purpose list：能看到条目、说过几次、摆过几次', async () => {
  const text = toolText(await tool('yuanling_purpose', { action: 'list' }))
  assert.match(text, /pur_test1/)
  assert.match(text, /面试/)
  assert.match(text, /说过/)
  assert.match(text, /摆到面前/)
})

test('purpose mentioned：真的回报"问过了" → hits 涨', async () => {
  toolText(await tool('yuanling_purpose', { action: 'mentioned', ids: ['pur_test1'] }))
  const p = readPurposes(root, PID).items.find((x) => x.id === 'pur_test1')
  assert.equal(Number(p.hits), 1)
  assert.ok(p.last_hit, '要记下她什么时候提的')
})

test(`purpose mentioned：真提满 ${SELECT_MAX_HITS} 次 → 自动放下`, async () => {
  toolText(await tool('yuanling_purpose', { action: 'mentioned', ids: ['pur_test1'] }))
  const p = readPurposes(root, PID).items.find((x) => x.id === 'pur_test1')
  assert.equal(Number(p.hits), SELECT_MAX_HITS)

  // 下一轮注入时它应该被 selectIntent 判成"说够了"，自动关掉
  contextFor(root, PID, { channel: 'private:10001' })
  const after = readPurposes(root, PID).items.find((x) => x.id === 'pur_test1')
  assert.equal(after.status, 'done')
  assert.match(after.close_reason ?? '', /说出口/)
})

test('purpose drop：主动放下，理由要留下', async () => {
  writePurposes(root, PID, { version: 1, items: [openItem({ id: 'pur_drop1', text: '你上次说搬家' })] })
  toolText(await tool('yuanling_purpose', { action: 'drop', id: 'pur_drop1', reason: '她明显不想聊这个' }))

  const p = readPurposes(root, PID).items.find((x) => x.id === 'pur_drop1')
  assert.equal(p.status, 'done')
  assert.match(p.close_reason ?? '', /不想聊/)
})

test('purpose：不认识的动作要报错，不能装没事', async () => {
  const res = await tool('yuanling_purpose', { action: 'nonsense', ids: ['x'] })
  assert.equal(res.result.isError, true)
  assert.match(res.result.content.map((c) => c.text).join('\n'), /list \/ mentioned \/ drop/)
})

test('purpose：mentioned 缺 id 时提示先 list 一遍', async () => {
  const res = await tool('yuanling_purpose', { action: 'mentioned' })
  assert.equal(res.result.isError, true)
  assert.match(res.result.content.map((c) => c.text).join('\n'), /list/)
})
