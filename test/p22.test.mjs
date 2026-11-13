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
import { createPerson } from '../src/core/entities.js'
import { listAccounts, loadAccount, personForAccount } from '../src/core/accounts.js'

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

test('tools/list：十三个工具都在（账户卡 / 合并 / 拆分）', async () => {
  const res = await call('tools/list', {})
  const names = res.result.tools.map((t) => t.name).sort()
  assert.deepEqual(names, [
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
})

test('account：platform + nativeId 建账户，并自动建 1:1 人物', async () => {
  const res = await call('tools/call', {
    name: 'yuanling_account',
    arguments: { platform: 'qq', nativeId: '12345', nickname: '张三', description: '爱较真' },
  })
  const text = toolText(res)
  assert.match(text, /qq:12345/)
  assert.match(text, /张三/)
  assert.match(text, /出现人物|属于人物/)

  const acct = text.match(/acct_[0-9A-Z]+/)?.[0]
  assert.ok(acct)
  assert.equal(loadAccount(root, PID, acct).description, '爱较真')
})

test('account：改昵称与描述', async () => {
  const acct = listAccounts(root, PID).find((a) => a.nativeId === '12345').uid
  const res = await call('tools/call', {
    name: 'yuanling_account',
    arguments: { uid: acct, nicknames: ['张三', '老张'], description: '好友备注：老张\n话少' },
  })
  toolText(res)
  const card = loadAccount(root, PID, acct)
  assert.deepEqual(card.nicknames, ['张三', '老张'])
  assert.match(card.description, /好友备注：老张/)
})

test('merge：两个账户合并成一个人物，必须给 sketch', async () => {
  const qq = listAccounts(root, PID).find((a) => a.platform === 'qq').uid
  const res0 = await call('tools/call', {
    name: 'yuanling_account',
    arguments: { platform: 'bili', nativeId: '阿四', nickname: '阿四' },
  })
  const bili = toolText(res0).match(/acct_[0-9A-Z]+/)?.[0]
  assert.ok(bili)

  const res = await call('tools/call', {
    name: 'yuanling_person_merge',
    arguments: { accounts: [qq, bili], sketch: '同一个人：QQ 与 B 站', reason: '本人在私聊里说的' },
  })
  const text = toolText(res)
  assert.match(text, /已合并/)
  assert.equal(personForAccount(root, PID, qq).uid, personForAccount(root, PID, bili).uid)
})

test('merge：不给 sketch 直接拒绝', async () => {
  const accts = listAccounts(root, PID).map((a) => a.uid)
  const res = await call('tools/call', {
    name: 'yuanling_person_merge',
    arguments: { accounts: accts, reason: '想合并' },
  })
  assert.match(errText(res), /sketch/)
})

test('account：缺 platform/nativeId 时报错而不是崩', async () => {
  const res = await call('tools/call', { name: 'yuanling_account', arguments: {} })
  assert.match(errText(res), /platform \+ nativeId/)
})

test('account：uid 不存在时报错', async () => {
  const res = await call('tools/call', {
    name: 'yuanling_account',
    arguments: { uid: 'acct_nope', description: 'x' },
  })
  assert.match(errText(res), /账户不存在/)
})

test('account：描述超过 600 字节被拒绝（不是悄悄截断）', async () => {
  const acct = listAccounts(root, PID)[0].uid
  const res = await call('tools/call', {
    name: 'yuanling_account',
    arguments: { uid: acct, description: '很长的描述'.repeat(200) },
  })
  assert.match(errText(res), /600/)
})

test('split：拆出一个账户，两个人分别持有', async () => {
  const accts = listAccounts(root, PID)
  const qq = accts.find((a) => a.platform === 'qq').uid
  const bili = accts.find((a) => a.platform === 'bili').uid
  const person = personForAccount(root, PID, qq).uid
  const res = await call('tools/call', {
    name: 'yuanling_person_split',
    arguments: { person, accounts: [bili], reason: '不是同一个人' },
  })
  toolText(res)
  assert.notEqual(personForAccount(root, PID, qq).uid, personForAccount(root, PID, bili).uid)
})
