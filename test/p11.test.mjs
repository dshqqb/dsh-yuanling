// test/p11.test.mjs —— 管理台写操作：屏蔽 / 提案动作 / 人物素描。
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { scaffold } from '../src/core/scaffold.js'
import { appendRecord } from '../src/core/raw.js'
import { localIso } from '../src/core/fsx.js'
import { addFact } from '../src/core/memory.js'
import { createPerson, linkIdentity } from '../src/core/entities.js'
import { listen, readToken } from '../src/core/server.js'
import { styleRel } from '../src/core/proposals.js'

const PID = 'yuanling'
let root
let server
let url
let token
let personUid

const daysAgo = (n) => localIso(new Date(Date.now() - n * 86_400_000))

function seedRaw(text = '一句话') {
  const r = appendRecord(root, {
    source: 'qq',
    acct: '10001',
    channel: 'private:10001',
    actor: { kind: 'owner', id: '10001', name: '主人' },
    role: 'user',
    text,
    ts: localIso(),
  })
  return `${r.file}#${r.id}`
}

function post(pathname, body) {
  return fetch(`${url}${pathname}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-yuanling-token': token },
    body: JSON.stringify(body ?? {}),
  })
}

before(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'yuanling-p11-'))
  scaffold(root, {})

  // 一条普通事实（用于屏蔽）
  const src = seedRaw('今天备份脚本跑到一半断了')
  addFact(root, PID, { topic: '备份', text: '备份脚本的定时任务被宿主收走了', src })

  // 一组重复表述（用于提案）
  const src2 = seedRaw('原文-别用颜文字')
  addFact(root, PID, { topic: '说话方式', text: '别用颜文字', src: src2, now: daysAgo(6) })
  for (let i = 1; i < 5; i += 1) {
    addFact(root, PID, { topic: '说话方式', text: '别用颜文字', src: src2, now: daysAgo(6 - i) })
  }

  // 一个人物
  const p = createPerson(root, { display: '张三' })
  personUid = p.uid
  linkIdentity(root, personUid, { platform: 'qq', id: '12345' })

  token = readToken(root)
  const started = await listen(root, { port: 0 })
  server = started.server
  url = started.url
})

after(async () => {
  await new Promise((res) => server.close(res))
})

test('写操作：没有 token 一律 401', async () => {
  const res = await fetch(`${url}/api/shield`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ targets: ['x'] }),
  })
  assert.equal(res.status, 401)
})

test('shield：屏蔽后检索里消失，并级联隔离记忆', async () => {
  const before = await (await fetch(`${url}/api/memory?q=${encodeURIComponent('备份')}`, {
    headers: { 'x-yuanling-token': token },
  })).json()
  assert.equal(before.hits.length, 1)
  const rawId = before.hits[0].src.split('#').pop()

  const res = await post('/api/shield', { targets: [rawId], reason: '测试屏蔽' })
  assert.equal(res.status, 200)
  const r = await res.json()
  assert.equal(r.ok, true)
  assert.ok(r.cascaded.length >= 1, '应该级联隔离那条记忆')

  const after = await (await fetch(`${url}/api/memory?q=${encodeURIComponent('备份')}`, {
    headers: { 'x-yuanling-token': token },
  })).json()
  assert.equal(after.hits.length, 0)
})

test('unshield：撤销后回到检索', async () => {
  const mem = await (await fetch(`${url}/api/memory?q=${encodeURIComponent('备份')}&all=1`, {
    headers: { 'x-yuanling-token': token },
  })).json()
  const rawId = mem.hits[0].src.split('#').pop()

  const res = await post('/api/unshield', { targets: [rawId] })
  const r = await res.json()
  assert.equal(r.ok, true)

  const after = await (await fetch(`${url}/api/memory?q=${encodeURIComponent('备份')}`, {
    headers: { 'x-yuanling-token': token },
  })).json()
  assert.equal(after.hits.length, 1)
})

test('shield：缺少 targets 返回 400', async () => {
  const res = await post('/api/shield', {})
  assert.equal(res.status, 400)
})

test('proposal：scan 生成提案，approve 写进 style.md', async () => {
  const scanRes = await post('/api/proposal', { action: 'scan' })
  const scan = await scanRes.json()
  assert.ok(scan.created.length >= 1, '应该扫出一条提案')
  const id = scan.created[0].id

  const res = await post('/api/proposal', { id, action: 'approve' })
  const r = await res.json()
  assert.equal(r.ok, true)
  assert.equal(r.proposal.status, 'approved')

  const style = fs.readFileSync(path.join(root, styleRel(PID)), 'utf8')
  assert.ok(style.includes('别用颜文字'))
})

test('proposal：rollback 把 style.md 退回去', async () => {
  const list = await (await fetch(`${url}/api/proposals`, { headers: { 'x-yuanling-token': token } })).json()
  const approved = list.proposals.find((p) => p.status === 'approved')
  assert.ok(approved)

  const res = await post('/api/proposal', { id: approved.id, action: 'rollback' })
  assert.equal(res.status, 200)

  const style = fs.readFileSync(path.join(root, styleRel(PID)), 'utf8')
  assert.ok(!style.includes('别用颜文字'), '回滚后不该还留着那句')
})

test('proposal：未知动作返回 400', async () => {
  const res = await post('/api/proposal', { id: 'prop_x', action: 'nonsense' })
  assert.equal(res.status, 400)
})

test('people：列表与编辑素描', async () => {
  const list = await (await fetch(`${url}/api/people`, { headers: { 'x-yuanling-token': token } })).json()
  assert.ok(list.people.some((p) => p.uid === personUid))

  const res = await post('/api/person', { uid: personUid, sketch: '说话短，爱用草', display: '张三' })
  const r = await res.json()
  assert.equal(r.ok, true)
  assert.equal(r.profile.sketch, '说话短，爱用草')

  const one = await (await fetch(`${url}/api/person?uid=${encodeURIComponent(personUid)}`, {
    headers: { 'x-yuanling-token': token },
  })).json()
  assert.equal(one.profile.sketch, '说话短，爱用草')
})

test('写操作：未知路径 404', async () => {
  const res = await post('/api/nope', {})
  assert.equal(res.status, 404)
})

test('last：recentMessages 给出的指针可以直接用来记事实', async () => {
  const { recentMessages } = await import('../src/core/raw.js')
  const rows = recentMessages(root, { limit: 3 })
  assert.ok(rows.length >= 1)
  assert.match(rows[0].pointer, /^raw\/\d{4}-\d{2}\/\d{2}\/.+\.ndjson#[0-9A-Z]+$/)

  const r = addFact(root, PID, { topic: '指针测试', text: '用 last 的指针写一条', src: rows[0].pointer })
  assert.equal(r.added, true)
})
