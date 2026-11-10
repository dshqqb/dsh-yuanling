// test/p43.test.mjs —— MCP 群体工具：模型补写"这个群是什么地方"。
//
// 这里只验 MCP 这一层（协议 + 参数归一 + 落盘结果）；
// 群体本身的行为（gid 映射、不合并、权重、成员归集）在 p42 里。
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import readline from 'node:readline'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

import { scaffold } from '../src/core/scaffold.js'
import { readGroup, listGroups, gidForChannel, findGidByNative, readGroupIdentity } from '../src/core/groups.js'

const PID = 'yuanling'

/** 按原生号找群体卡（编号是内部编号，测试里不写死）。 */
function groupByNative(platform, nativeId) {
  const gid = findGidByNative(root, platform, nativeId)
  return gid ? readGroup(root, PID, gid) : null
}

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
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'yuanling-p43-'))
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

test('tools/list 里有 yuanling_group', async () => {
  const res = await call('tools/list', {})
  const names = res.result.tools.map((t) => t.name)
  assert.ok(names.includes('yuanling_group'), '工具清单里必须有群体工具')
})

test('写：只给 channel 就能定位到群并建档案', async () => {
  const text = toolText(
    await tool('yuanling_group', {
      channel: 'group:12345',
      feature: '老同学的群，气氛松散，爱发老照片',
      reason: '刚进来看了几条，明显是老同学在叙旧',
    }),
  )
  assert.match(text, /已写入/)
  // 输出里给的是群体编号（内部编号），不再是 qq:12345
  assert.match(text, /grp_/)

  const g = groupByNative('qq', '12345')
  assert.ok(g, '应该落下档案')
  assert.equal(g.platform, 'qq')
  assert.equal(g.nativeId, '12345')
  assert.match(g.feature, /老同学/)
  assert.equal(g.tier, null)
})

test('写：只给数字的 gid 按 QQ 群理解', async () => {
  toolText(await tool('yuanling_group', { gid: '777', name: '数码群', reason: '见面记下名字' }))
  const g = groupByNative('qq', '777')
  assert.ok(g, '数字该被补成 QQ 群的号')
  assert.equal(g.name, '数码群')
})

test('写：描述是整段覆盖（印象语义），不会把卡写没', async () => {
  toolText(await tool('yuanling_group', { gid: 'qq:12345', feature: '最近在聊孩子上学', reason: '描述变了' }))
  const g = groupByNative('qq', '12345')
  assert.ok(g, '卡还在')
  assert.match(g.feature, /孩子上学/, '描述整段覆盖')
})

test('读：没有任何写入参数时是只读，不会凭空建档', async () => {
  const before = listGroups(root, PID).length
  const text = toolText(await tool('yuanling_group', { gid: 'qq:999000' }))
  assert.match(text, /还没有档案/)
  assert.equal(listGroups(root, PID).length, before, '只读不该建出新群体')
})

test('读：读到的是自然语言描述，成员带名字不带 uid', async () => {
  const text = toolText(await tool('yuanling_group', { channel: 'group:12345' }))
  assert.match(text, /grp_/)
  assert.match(text, /孩子上学/, '读到的应该是当前的群体描述')
  assert.ok(text.includes('权重'), '应该报权重，管理台和 CLI 用的是同一套数')
})

test('两个参数都不给 → 报错而不是瞎猜一个群', async () => {
  const res = await tool('yuanling_group', {})
  assert.equal(res.result.isError, true)
  assert.match(res.result.content.map((c) => c.text).join('\n'), /gid/)
})

test('写：群体卡没有别名/话题这两栏（工具不再接受它们）', async () => {
  const r = await tool('yuanling_group', { gid: 'qq:777', aliases: ['七群'], topics: '聊数码', reason: 'x' })
  const g = groupByNative('qq', '777')
  assert.equal(g.aliases, undefined)
  assert.equal(g.topics, undefined)
  void r
})
