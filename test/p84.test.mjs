// test/p84.test.mjs —— 账户卡 API：建/改/合并/拆分（2026-11-13）
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { scaffold } from '../src/core/scaffold.js'
import { listen, readToken } from '../src/core/server.js'

const PID = 'yuanling'
let root
let server
let url
let token

const get = (p) => fetch(`${url}${p}`, { headers: { 'x-yuanling-token': token } })
const post = (p, body) =>
  fetch(`${url}${p}`, {
    method: 'POST',
    headers: { 'x-yuanling-token': token, 'content-type': 'application/json' },
    body: JSON.stringify(body ?? {}),
  })

before(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'yuanling-p84-'))
  scaffold(root, {})
  token = readToken(root)
  const started = await listen(root, { port: 0 })
  server = started.server
  url = started.url
})

after(async () => {
  await new Promise((res) => server.close(res))
})

test('account/create：建账户 + 自动 1:1 人物', async () => {
  const r = await post('/api/account/create', { platform: 'qq', nativeId: '88801', nickname: '小甲', description: '测试' })
  assert.equal(r.status, 200)
  const body = await r.json()
  assert.match(body.acct, /^card_/)
  assert.match(body.person, /^card_/)

  const list = await (await get('/api/accounts')).json()
  const card = list.accounts.find((a) => a.uid === body.acct)
  assert.deepEqual(card.nicknames, ['小甲'])
  assert.equal(card.person.uid, body.person)
})

test('account/update：改昵称与描述', async () => {
  const list = await (await get('/api/accounts')).json()
  const acct = list.accounts[0].uid
  const r = await post('/api/account/update', { uid: acct, nicknames: ['小甲', '甲哥'], description: '好友备注：甲哥' })
  assert.equal(r.status, 200)
  const one = await (await get(`/api/account?uid=${acct}`)).json()
  assert.deepEqual(one.account.nicknames, ['小甲', '甲哥'])
  assert.match(one.account.description, /甲哥/)
})

test('person/merge：合并两个账户（不需要 sketch）', async () => {
  const a = await (await get('/api/accounts')).json()
  const first = a.accounts[0].uid
  const r2 = await post('/api/account/create', { platform: 'bilibili', nativeId: 'bili-888', nickname: '小甲B站' })
  const second = (await r2.json()).acct

  const ok = await post('/api/person/merge', { accounts: [first, second], reason: '测试' })
  assert.equal(ok.status, 200)
  const main = (await ok.json()).person
  const one = await (await get(`/api/person?uid=${encodeURIComponent(main)}`)).json()
  assert.equal(one.accounts.length, 2)
})

test('person/split：拆出一个账户', async () => {
  const list = await (await get('/api/accounts')).json()
  const mergedPerson = list.accounts.find((a) => a.nicknames.length)?.person?.uid
  const accts = list.accounts.filter((a) => a.person?.uid === mergedPerson).map((a) => a.uid)
  assert.equal(accts.length, 2)
  const r = await post('/api/person/split', { person: mergedPerson, accounts: [accts[1]] })
  assert.equal(r.status, 200)
  const after = await (await get('/api/accounts')).json()
  const moved = after.accounts.find((a) => a.uid === accts[1])
  assert.notEqual(moved.person.uid, mergedPerson)
})
