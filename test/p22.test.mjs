// test/p22.test.mjs —— MCP 写路径：账户卡（每账户一张）+ 合并/拆分。
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import readline from 'node:readline'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

import { scaffold } from '../src/core/scaffold.js'
import { listCards, readCard, personForAccount } from '../src/core/accounts.js'

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
    if (msg.id && pending.has(msg.id)) {
      const { resolve } = pending.get(msg.id)
      pending.delete(msg.id)
      resolve(msg)
    }
  })
  return (method, params = {}) =>
    new Promise((resolve) => {
      const id = nextId++
      pending.set(id, { resolve })
      proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n')
    })
}

const toolText = (res) => res.result.content.map((c) => c.text).join('\n')
const errText = (res) => {
  assert.equal(res.result.isError, true, '这里应该报错')
  return res.result.content.map((c) => c.text).join('\n')
}

before(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'yuanling-p22-'))
  scaffold(root, {})
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

test('account：platform + nativeId 建卡（每账户一张）', async () => {
  const res = await call('tools/call', {
    name: 'yuanling_account',
    arguments: { platform: 'qq', nativeId: '12345', nickname: '张三', description: '爱较真' },
  })
  const text = toolText(res)
  assert.match(text, /qq:12345/)
  assert.match(text, /张三/)
  const card = listCards(root, PID).find((a) => a.account === '12345')
  assert.ok(card)
  assert.equal(readCard(root, PID, card.id).description, '爱较真')
})

test('account：改昵称与描述', async () => {
  const acct = listCards(root, PID).find((a) => a.account === '12345').id
  const res = await call('tools/call', {
    name: 'yuanling_account',
    arguments: { uid: acct, nicknames: ['张三', '老张'], description: '好友备注：老张\n话少' },
  })
  toolText(res)
  const card = readCard(root, PID, acct)
  assert.deepEqual(card.nicknames, ['张三', '老张'])
  assert.match(card.description, /好友备注：老张/)
})

test('merge：两个账户合并，不需要 sketch', async () => {
  const qq = listCards(root, PID).find((a) => a.app === 'qq').id
  const res0 = await call('tools/call', {
    name: 'yuanling_account',
    arguments: { platform: 'bilibili', nativeId: '阿四', nickname: '阿四' },
  })
  toolText(res0)
  const bili = listCards(root, PID).find((a) => a.app === 'bilibili').id
  const res = await call('tools/call', {
    name: 'yuanling_person_merge',
    arguments: { accounts: [qq, bili], reason: '本人在私聊里说的' },
  })
  assert.match(toolText(res), /已合并/)
  assert.equal(personForAccount(root, PID, qq).id, personForAccount(root, PID, bili).id)
})

test('account：缺 platform/nativeId 时报错而不是崩', async () => {
  const res = await call('tools/call', { name: 'yuanling_account', arguments: {} })
  assert.match(errText(res), /platform \+ nativeId/)
})

test('account：uid 不存在时报错', async () => {
  const res = await call('tools/call', {
    name: 'yuanling_account',
    arguments: { uid: 'card_nope', description: 'x' },
  })
  assert.match(errText(res), /账户不存在/)
})

test('account：描述超过 2000 字符被拒绝', async () => {
  const acct = listCards(root, PID)[0].id
  const res = await call('tools/call', {
    name: 'yuanling_account',
    arguments: { uid: acct, description: '啊'.repeat(2001) },
  })
  assert.match(errText(res), /2000/)
})

test('split：拆出一张卡，两个人分别持有', async () => {
  const qq = listCards(root, PID).find((a) => a.app === 'qq').id
  const bili = listCards(root, PID).find((a) => a.app === 'bilibili').id
  const res = await call('tools/call', {
    name: 'yuanling_person_split',
    arguments: { accounts: [bili], reason: '不是同一个人' },
  })
  toolText(res)
  assert.notEqual(personForAccount(root, PID, qq).id, personForAccount(root, PID, bili).id)
})
