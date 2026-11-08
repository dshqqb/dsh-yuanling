// test/p22.test.mjs —— MCP 写路径：模型把身份信息写回 identities.json。
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import readline from 'node:readline'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

import { scaffold } from '../src/core/scaffold.js'
import { createPerson, linkIdentity, loadIdentities } from '../src/core/entities.js'

const PID = 'yuanling'
const HERE = path.dirname(fileURLToPath(import.meta.url))
const SERVER = path.join(HERE, '..', 'mcp-server.mjs')
const MAX_TEXT = 2000

let root
let child
let call
let nextId = 1
let aliceUid

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

const toolText = (res) => {
  assert.equal(res?.result?.isError, false, `工具不该报错：${res?.result?.content?.[0]?.text ?? ''}`)
  return res.result.content.map((c) => c.text).join('\n')
}

const errText = (res) => {
  assert.equal(res.result.isError, true, '这里应该报错')
  return res.result.content.map((c) => c.text).join('\n')
}

before(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'yuanling-p22-'))
  scaffold(root, {})
  const p = createPerson(root, { display: '张三' })
  aliceUid = p.uid

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

test('tools/list：五个工具都在（v1.1 加了 sources / fetch）', async () => {
  const res = await call('tools/list', {})
  const names = res.result.tools.map((t) => t.name).sort()
  assert.deepEqual(names, [
    'yuanling_context',
    'yuanling_fetch',
    'yuanling_person_identity',
    'yuanling_recall',
    'yuanling_sources',
  ])
})

test('identity：给 uid 写描述 → 解析并绑定没被占用的号', async () => {
  const res = await call('tools/call', {
    name: 'yuanling_person_identity',
    arguments: { uid: aliceUid, text: 'QQ 号是 12345，b站叫老张' },
  })
  const text = toolText(res)
  assert.match(text, /已写入/)
  assert.match(text, /qq:12345/)
  assert.match(text, /新绑定/)

  const data = loadIdentities(root)
  const person = data.people[aliceUid]
  assert.equal(person.identity_text, 'QQ 号是 12345，b站叫老张', '原文必须原样存下')
  assert.ok(person.identities.some((x) => x.platform === 'qq' && String(x.id) === '12345'))
})

test('identity：只给 display 时会新建人物', async () => {
  const res = await call('tools/call', {
    name: 'yuanling_person_identity',
    arguments: { display: '李四', text: 'b站昵称是阿四' },
  })
  const text = toolText(res)
  assert.match(text, /李四/)

  const data = loadIdentities(root)
  const hit = Object.values(data.people).find((p) => p.display === '李四')
  assert.ok(hit, '应该新建出李四')
  assert.ok(hit.identities.some((x) => x.platform === 'bili' && x.id === '阿四'))
})

test('identity：号已属于别人 → 只报冲突，不抢', async () => {
  const other = createPerson(root, { display: '王五' })
  linkIdentity(root, other.uid, { platform: 'qq', id: '99999' })

  const res = await call('tools/call', {
    name: 'yuanling_person_identity',
    arguments: { uid: aliceUid, text: 'QQ 号是 99999' },
  })
  const text = toolText(res)
  assert.match(text, /冲突/)
  assert.match(text, /没有抢/)

  const data = loadIdentities(root)
  assert.equal(data.people[other.uid].identities.find((x) => x.id === '99999').platform, 'qq')
  assert.ok(!data.people[aliceUid].identities.some((x) => x.id === '99999'))
})

test('identity：缺 text 时报错而不是崩', async () => {
  const res = await call('tools/call', { name: 'yuanling_person_identity', arguments: { uid: aliceUid } })
  assert.match(errText(res), /缺少 text/)
})

test('identity：uid 不存在时报错', async () => {
  const res = await call('tools/call', {
    name: 'yuanling_person_identity',
    arguments: { uid: 'person_nope', text: 'QQ 号是 12345' },
  })
  assert.match(errText(res), /人物不存在/)
})

test('identity：超长描述被拒绝（不是悄悄截断）', async () => {
  const res = await call('tools/call', {
    name: 'yuanling_person_identity',
    // 5 字 × 500 = 2500 字，超过 2000 上限
    arguments: { uid: aliceUid, text: '很长的描述'.repeat(500) },
  })
  assert.match(errText(res), new RegExp(`≤${MAX_TEXT}`))
})

test('identity：autoLink=false 时只存原文，不绑号', async () => {
  const res = await call('tools/call', {
    name: 'yuanling_person_identity',
    arguments: { uid: aliceUid, text: '微博 @zhang_new', autoLink: false },
  })
  toolText(res)

  const data = loadIdentities(root)
  assert.ok(!data.people[aliceUid].identities.some((x) => String(x.id) === 'zhang_new'))
  assert.match(data.people[aliceUid].identity_text, /zhang_new/, '原文还是存着的')
})
