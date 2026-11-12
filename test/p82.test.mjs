// test/p82.test.mjs —— 账户信息自动补全（2026-11-12）
//
// 用户定：账户信息 = 账号（QQ/微信/贴吧…），不是人物描述。
// 从消息里拿到的 QQ 号要立刻出现在账户信息里；历史人物启动时补一次（幂等）。
import { test, before } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { scaffold } from '../src/core/scaffold.js'
import { ingest } from '../src/core/inbox.js'
import {
  accountTextsOf,
  backfillAccountTexts,
  createPerson,
  ensureAccountTextForIdentity,
  findByIdentity,
  linkIdentity,
  loadIdentities,
  readProfile,
} from '../src/core/entities.js'
import { localIso } from '../src/core/fsx.js'

const PID = 'yuanling'
let root

before(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'yuanling-p82-'))
  scaffold(root, {})
})

test('私聊转正：账户信息里自动有 QQ 号', () => {
  ingest(root, {
    v: 1,
    source: 'qq',
    acct: '2823503286',
    items: [
      {
        channel: 'private:61001',
        kind: 'msg',
        role: 'user',
        ext_id: 'a-1',
        ts: localIso(),
        text: '在吗',
        actor: { kind: 'owner', id: '61001', name: '小甲' },
      },
    ],
  })
  const uid = findByIdentity(root, 'qq', '61001').uid
  assert.ok(readProfile(root, PID, uid), '私聊要有档案')
  const texts = accountTextsOf(loadIdentities(root).people[uid]).map((x) => x.text)
  assert.deepEqual(texts, ['QQ：61001'])
})

test('已有观察到的号、没写账户信息：启动补全一次', () => {
  const p = createPerson(root, { display: '小乙' })
  linkIdentity(root, p.uid, { platform: 'qq', id: '61002' })
  const n = backfillAccountTexts(root)
  assert.ok(n >= 1)
  const texts = accountTextsOf(loadIdentities(root).people[p.uid]).map((x) => x.text)
  assert.deepEqual(texts, ['QQ：61002'])
})

test('补全是幂等的：跑两次不会重复', () => {
  const p = createPerson(root, { display: '小丙' })
  linkIdentity(root, p.uid, { platform: 'qq', id: '61003' })
  backfillAccountTexts(root)
  backfillAccountTexts(root)
  const texts = accountTextsOf(loadIdentities(root).people[p.uid]).map((x) => x.text)
  assert.deepEqual(texts, ['QQ：61003'])
})

test('ensureAccountTextForIdentity：已有就不动，没有才补', () => {
  const p = createPerson(root, { display: '小丁' })
  linkIdentity(root, p.uid, { platform: 'qq', id: '61004' })
  assert.equal(ensureAccountTextForIdentity(root, p.uid, { platform: 'qq', id: '61004' }), true)
  assert.equal(ensureAccountTextForIdentity(root, p.uid, { platform: 'qq', id: '61004' }), false)
  const texts = accountTextsOf(loadIdentities(root).people[p.uid]).map((x) => x.text)
  assert.deepEqual(texts, ['QQ：61004'])
})

test('账户信息是账号，不是印象：人物描述仍为空', () => {
  const uid = findByIdentity(root, 'qq', '61001').uid
  const profile = readProfile(root, PID, uid)
  assert.equal(profile.sketch, '', '没写印象就是空的')
  assert.deepEqual(accountTextsOf(loadIdentities(root).people[uid]).map((x) => x.text), ['QQ：61001'])
})
