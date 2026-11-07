// test/p8.test.mjs —— 管理台：静态页、Token 门、只读 API、目录穿越防护。
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { scaffold } from '../src/core/scaffold.js'
import { appendRecord } from '../src/core/raw.js'
import { localIso } from '../src/core/fsx.js'
import { addFact } from '../src/core/memory.js'
import { listen, readToken } from '../src/core/server.js'

const PID = 'yuanling'
let root
let server
let url
let token

before(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'yuanling-p8-'))
  scaffold(root, {})

  const r = appendRecord(root, {
    source: 'qq',
    acct: '10001',
    channel: 'private:10001',
    actor: { kind: 'owner', id: '10001', name: '主人' },
    role: 'user',
    text: '今天备份脚本跑到一半断了',
    ts: localIso(),
  })
  addFact(root, PID, { topic: '备份', text: '备份脚本的定时任务被宿主收走了', src: `${r.file}#${r.id}` })

  token = readToken(root)
  const started = await listen(root, { port: 0 })
  server = started.server
  url = started.url
})

after(async () => {
  await new Promise((res) => server.close(res))
})

const auth = () => ({ 'x-yuanling-token': token })

test('管理台：GET / 返回页面', async () => {
  const res = await fetch(`${url}/`)
  assert.equal(res.status, 200)
  assert.match(res.headers.get('content-type') ?? '', /text\/html/)
  const html = await res.text()
  assert.match(html, /原灵/)
  assert.match(html, /注入预览/)
})

test('管理台：静态资源可访问', async () => {
  for (const p of ['/app.js', '/style.css']) {
    const res = await fetch(`${url}${p}`)
    assert.equal(res.status, 200, p)
  }
})

test('API：没有 token 一律 401', async () => {
  for (const p of ['/api/status', '/api/card', '/api/memory', '/api/rules']) {
    const res = await fetch(`${url}${p}`)
    assert.equal(res.status, 401, p)
  }
})

test('API：status 返回数据目录与激活人格', async () => {
  const res = await fetch(`${url}/api/status`, { headers: auth() })
  assert.equal(res.status, 200)
  const d = await res.json()
  assert.equal(d.active, PID)
  assert.equal(d.facts, 1)
  assert.ok(d.personas.some((p) => p.id === PID && p.active))
})

test('API：card 返回注入文本与字节数', async () => {
  const res = await fetch(`${url}/api/card?channel=${encodeURIComponent('private:10001')}`, { headers: auth() })
  assert.equal(res.status, 200)
  const d = await res.json()
  assert.ok(d.text.includes('[索引]'))
  assert.ok(d.bytes > 0)
})

test('API：memory 搜索命中并带指针', async () => {
  const res = await fetch(`${url}/api/memory?q=${encodeURIComponent('备份')}`, { headers: auth() })
  const d = await res.json()
  assert.equal(d.hits.length, 1)
  assert.match(d.hits[0].src, /^raw\//)
})

test('API：entries 与 rules 可用', async () => {
  const e = await (await fetch(`${url}/api/entries`, { headers: auth() })).json()
  assert.equal(e.entries.length, 1)
  assert.equal(e.entries[0].topic, '备份')

  const r = await (await fetch(`${url}/api/rules`, { headers: auth() })).json()
  assert.ok(r.rules.action)
  assert.ok(Array.isArray(r.sources))
})

test('API：sources 返回数组（没有心跳就是空）', async () => {
  const d = await (await fetch(`${url}/api/sources`, { headers: auth() })).json()
  assert.ok(Array.isArray(d.sources))
})

test('API：不存在的接口 404', async () => {
  const res = await fetch(`${url}/api/nope`, { headers: auth() })
  assert.equal(res.status, 404)
})

test('静态页：目录穿越拿不到仓库文件', async () => {
  const res = await fetch(`${url}/..%2fpackage.json`)
  assert.equal(res.status, 404)
})

test('API：usage 给出近 14 天的真实消息量与估算', async () => {
  const res = await fetch(`${url}/api/usage?days=14`, { headers: auth() })
  assert.equal(res.status, 200)
  const d = await res.json()

  assert.equal(d.span, 14)
  assert.equal(d.days.length, 14)
  assert.ok(d.totals.messages >= 1, '刚投递过一条消息')
  assert.ok(d.totals.estTokens >= 1)
  assert.ok(d.card.bytes > 0)
  assert.equal(d.cost.supported, false, '费用还没接入，不能假装能算')
  for (const x of d.days) {
    assert.match(x.date, /^\d{4}-\d{2}-\d{2}$/)
    assert.ok(x.messages >= 0)
  }
})

test('管理台：页面里有「用量」入口的骨架', async () => {
  const html = await (await fetch(`${url}/`)).text()
  assert.match(html, /用量/)
  assert.match(html, /usage-chart/)
})
