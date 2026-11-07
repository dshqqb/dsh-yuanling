// test/p14.test.mjs —— 管理台人物页：排序 / 重要人物 / 管理员 / 手动权重。
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { scaffold } from '../src/core/scaffold.js'
import { createPerson, linkIdentity, writeProfile, loadIdentities } from '../src/core/entities.js'
import { listen, readToken } from '../src/core/server.js'

const PID = 'yuanling'
let root
let server
let url
let token
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

  mk('低权重', '111', { weight: 5, last_met: '2026-10-01T00:00:00+08:00' })
  mk('高权重', '222', { weight: 80, last_met: '2026-09-01T00:00:00+08:00' })
  mk('近期活跃', '333', { weight: 10, last_met: '2026-11-06T00:00:00+08:00' })

  token = readToken(root)
  const started = await listen(root, { port: 0 })
  server = started.server
  url = started.url
})

after(async () => {
  await new Promise((res) => server.close(res))
})

test('people：默认按权重排，管理员恒在第一位', async () => {
  await post('/api/person/admin', { uid: uids['低权重'] })

  const d = await (await get('/api/people')).json()
  assert.equal(d.people[0].uid, uids['低权重'], '管理员必须排最前，哪怕权重最低')
  assert.equal(d.people[0].admin, true)

  const rest = d.people.slice(1).map((p) => p.weight)
  assert.deepEqual(rest, [...rest].sort((a, b) => b - a), '其余按权重降序')
})

test('people：sort=time 按最近互动排', async () => {
  const d = await (await get('/api/people?sort=time')).json()
  assert.equal(d.sort, 'time')
  const rest = d.people.filter((p) => !p.admin)
  assert.equal(rest[0].uid, uids['近期活跃'], '最近互动过的排前面')
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

test('admin：全库唯一，换人必须先卸任', async () => {
  const res = await post('/api/person/admin', { uid: uids['高权重'] })
  assert.equal(res.status, 400)
  const body = await res.json()
  assert.match(body.error, /卸任/)

  await post('/api/person/admin', { uid: null })
  const d = await (await get('/api/people')).json()
  assert.equal(d.admin, null, '卸任后没有管理员')

  const res2 = await post('/api/person/admin', { uid: uids['高权重'] })
  assert.equal(res2.status, 200)
  const d2 = await (await get('/api/people')).json()
  assert.equal(d2.admin.uid, uids['高权重'])
})

test('weight：手动覆写与恢复自动', async () => {
  const r1 = await (await post('/api/person/weight', { uid: uids['近期活跃'], weight: 45 })).json()
  assert.equal(r1.weight, 45)
  assert.equal(r1.source, 'manual')

  const d = await (await get('/api/people')).json()
  assert.equal(d.people.find((p) => p.uid === uids['近期活跃']).weightSource, 'manual')

  const r2 = await (await post('/api/person/weight', { uid: uids['近期活跃'], weight: null })).json()
  assert.equal(r2.source, 'auto')
})

test('weight：超出范围的数值被夹住', async () => {
  const r = await (await post('/api/person/weight', { uid: uids['低权重'], weight: 999 })).json()
  assert.equal(r.weight, 100)
})

test('admin：设给不存在的 uid 时报错', async () => {
  const res = await post('/api/person/admin', { uid: 'person_nope' })
  assert.equal(res.status, 400)
})

test('people：没有管理员时 admin 为 null，且不崩', async () => {
  await post('/api/person/admin', { uid: null })
  const d = await (await get('/api/people')).json()
  assert.equal(d.admin, null)
  assert.ok(d.people.every((p) => !p.admin))

  const data = loadIdentities(root)
  assert.ok(Object.values(data.people).every((p) => p.tier !== 'admin'))
})
