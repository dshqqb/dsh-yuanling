// test/p14.test.mjs —— 管理台人物页：排序 / 重要人物 / 管理员 / 手动权重。
//
// 用户 2026-11-14 定：管理员**固定**是 dsh:master 那张卡（安装时建的第一张），
// 不可卸任、不可换人，也不能被设为重要人物。
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { scaffold } from '../src/core/scaffold.js'
import { ensureConsoleMaster } from '../src/core/console.js'
import { createPerson, linkIdentity, writeProfile, loadIdentities } from './helpers.mjs'
import { readCard } from '../src/core/accounts.js'
import { listen, readToken } from '../src/core/server.js'

const PID = 'yuanling'
let root
let server
let url
let token
let master
const uids = {}

function post(pathname, body) {
  return fetch(`${url}${pathname}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-yuanling-token': token },
    body: JSON.stringify(body ?? {}),
  })
}

function get(pathname) {
  return fetch(`${url}${pathname}`, { headers: { 'x-yuanling-token': token } })
}

function mk(name, qq, extra = {}) {
  const p = createPerson(root, { display: name })
  linkIdentity(root, p.uid, { platform: 'qq', id: qq })
  writeProfile(root, PID, p.uid, { sketch: `${name}的素描`, ...extra })
  uids[name] = p.uid
  return p.uid
}

before(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'yuanling-p14-'))
  scaffold(root, {})
  master = ensureConsoleMaster(root, PID)

  mk('低权重', '111', { weight: 5 })
  mk('高权重', '222', { weight: 80 })
  mk('近期活跃', '333', { weight: 10 })

  token = readToken(root)
  const started = await listen(root, { port: 0 })
  server = started.server
  url = started.url
})

after(async () => {
  await new Promise((res) => server.close(res))
})

test('people：管理员恒在第一位，其余按权重降序', async () => {
  const d = await (await get('/api/people')).json()
  assert.equal(d.people[0].uid, master.id, '管理员就是 dsh:master')
  assert.equal(d.people[0].admin, true)
  assert.equal(d.people[0].display, '管理员', '默认昵称是管理员')

  const rest = d.people.slice(1).map((p) => p.weight)
  assert.deepEqual(rest, [...rest].sort((a, b) => b - a), '其余按权重降序')
})

test('people：去掉时间排序（只按权重）', async () => {
  const d = await (await get('/api/people?sort=time')).json()
  const rest = d.people.filter((p) => !p.admin && !p.pinned).map((p) => p.weight)
  assert.deepEqual(rest, [...rest].sort((a, b) => b - a))
})

test('pin：设为重要后排到「其余」之前，且可取消', async () => {
  const res = await post('/api/person/pin', { uid: uids['高权重'], pinned: true })
  const r = await res.json()
  assert.equal(r.pinned, true)

  const d = await (await get('/api/people')).json()
  assert.equal(d.people[1].uid, uids['高权重'], '重要人物排在管理员之后、其余之前')
  assert.equal(d.people[1].pinned, true)

  await post('/api/person/pin', { uid: uids['高权重'], pinned: false })
  const after1 = await (await get('/api/people')).json()
  assert.equal(after1.people.find((p) => p.uid === uids['高权重']).pinned, false)
})

test('admin：接口已经删掉（管理员固定，不能设也不能卸）', async () => {
  const res = await post('/api/person/admin', { uid: uids['高权重'] })
  assert.equal(res.status, 404)

  const d = await (await get('/api/people')).json()
  assert.equal(d.admin.uid, master.id, '管理员没变')
  await post('/api/person/admin', { uid: null })
  const d2 = await (await get('/api/people')).json()
  assert.equal(d2.admin.uid, master.id, '卸任也不生效')
})

test('admin：管理员不能设为重要人物', async () => {
  const res = await post('/api/person/pin', { uid: master.id, pinned: true })
  assert.equal(res.status, 400)
  const body = await res.json()
  assert.match(body.error, /管理员/)
})

test('weight：手改接口已经删掉（权重只能由互动/名次决定）', async () => {
  const res = await post('/api/person/weight', { uid: uids['近期活跃'], weight: 45 })
  assert.equal(res.status, 404, '这个接口不该再存在')
})

test('pin：重点人物按名次给分（110 起，越靠前越高），取消后回到落盘权重', async () => {
  const before = (await (await get('/api/people')).json()).people.find((p) => p.uid === uids['高权重'])
  const stored = before.weight

  await post('/api/person/pin', { uid: uids['高权重'], pinned: true })
  const pinnedOnly = (await (await get('/api/people')).json()).people.find((p) => p.uid === uids['高权重'])
  assert.equal(pinnedOnly.weightKind, 'pinned')
  assert.equal(pinnedOnly.weight, 110, '只有一个重点时就是 110')
  assert.equal(pinnedOnly.storedWeight, stored, '落盘权重仍然保留')

  // 再设一个重点、并把它挪到前面 → 它 115、原来那个 110
  await post('/api/person/pin', { uid: uids['近期活跃'], pinned: true })
  await post('/api/person/move', { uid: uids['近期活跃'], direction: 'up' })
  const two = (await (await get('/api/people')).json()).people
  assert.equal(two.find((p) => p.uid === uids['近期活跃']).weight, 115)
  assert.equal(two.find((p) => p.uid === uids['高权重']).weight, 110)

  // 取消重点 → 立刻回到落盘的互动分
  await post('/api/person/pin', { uid: uids['高权重'], pinned: false })
  const after = (await (await get('/api/people')).json()).people.find((p) => p.uid === uids['高权重'])
  assert.equal(after.weightKind, 'auto')
  assert.equal(after.weight, stored)
})

test('create：手动新建的人物权重 0、初识为空', async () => {
  const bad = await post('/api/person/create', { display: '张三' })
  assert.equal(bad.status, 400)
  assert.match((await bad.json()).error, /platform|nativeId|账户/)

  const ok = await post('/api/person/create', {
    display: '李四',
    platform: 'qq',
    nativeId: '88888',
    description: '说话很快',
  })
  assert.equal(ok.status, 200)
  const created = await ok.json()
  assert.ok(created.uid)

  const d = await (await get('/api/people')).json()
  const row = d.people.find((p) => p.uid === created.uid)
  assert.equal(row.display, '李四')
  assert.equal(row.weight, 0, '新账户还没互动，权重从 0 起')
  assert.equal(row.firstMet, null, '手动新建的卡初识为空，等第一次说话')
  assert.ok(row.identities.some((x) => x.platform === 'qq' && x.id === '88888'))
})

test('people：管理员永远在列表里，且只有一个 admin', async () => {
  const d = await (await get('/api/people')).json()
  assert.ok(d.admin, '管理员不会是 null')
  assert.equal(d.people.filter((p) => p.admin).length, 1)
  // 数据层面也不再写 tier
  const doc = loadIdentities(root)
  assert.ok(Object.values(doc.people).every((p) => p.tier === undefined))
  assert.equal(readCard(root, PID, master.id).tier, undefined, '卡上没有 tier 字段了')
})
