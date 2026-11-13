// test/p83.test.mjs —— 旧 identities.json → 账户卡/人物卡 迁移（2026-11-13）
import { test, before } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { scaffold } from '../src/core/scaffold.js'
import { migrateToAccounts } from '../src/core/migrate-accounts.js'
import { appendRecord, listDays, readDay } from '../src/core/raw.js'
import { accountForNative, accountsForPerson, loadAccount, loadPersons, labelOfPerson } from '../src/core/accounts.js'
import { refreshWeights } from '../src/core/weights.js'
import { localIso, ulid } from '../src/core/fsx.js'

const PID = 'yuanling'
let root

function writeOld(people) {
  const p = path.join(root, 'personas', PID, 'entities', 'identities.json')
  fs.mkdirSync(path.dirname(p), { recursive: true })
  fs.writeFileSync(p, JSON.stringify({ version: 1, people, pending: [] }, null, 2))
}

before(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'yuanling-p83-'))
  scaffold(root, {})
})

test('dry-run：只出数量，不写 accounts/persons', () => {
  writeOld({
    person_a: {
      uid: 'person_a',
      display: '老王',
      identities: [{ platform: 'qq', id: '12345', state: 'observed', confidence: 1, friend: true, remark: '老李' }],
      created: localIso(),
    },
  })
  const r = migrateToAccounts(root, { apply: false })
  assert.equal(r.reason, 'dry-run')
  assert.equal(r.people, 1)
  assert.equal(r.accounts, 1)
  assert.equal(fs.existsSync(path.join(root, 'personas', PID, 'entities', 'accounts.json')), true)
  // 空注册表（scaffold 建的），说明没写
  const reg = JSON.parse(fs.readFileSync(path.join(root, 'personas', PID, 'entities', 'accounts.json'), 'utf8'))
  assert.equal(Object.keys(reg.accounts).length, 0)
})

test('apply：一个人两个号 → 两个账户卡、一个人物卡；昵称/好友/备注搬过去', () => {
  writeOld({
    person_a: {
      uid: 'person_a',
      display: '老王',
      identities: [
        { platform: 'qq', id: '12345', state: 'observed', confidence: 1, friend: true, remark: '老李' },
        { platform: 'bili', id: 'bili-1', state: 'observed', confidence: 1 },
      ],
      created: localIso(),
    },
  })
  const r = migrateToAccounts(root, { apply: true })
  assert.equal(r.reason, 'migrated')
  assert.equal(r.people, 1)
  assert.equal(r.accounts, 2)
  assert.equal(fs.existsSync(path.join(root, 'personas', PID, 'entities', 'identities.json')), false, '旧文件移走')
  const rec = loadPersons(root, PID).persons.person_a
  assert.equal(rec.accounts.length, 2)
  assert.equal(labelOfPerson(root, PID, 'person_a'), '老王')
  const qq = loadAccount(root, PID, accountForNative(root, PID, 'qq', '12345'))
  assert.equal(qq.friend, true)
  assert.match(qq.description, /好友备注：老李/)
  assert.equal(accountsForPerson(root, PID, 'person_a').length, 2)
})

test('apply 后权重从 raw 重算（旧频道/actor 都能对上）', () => {
  for (let i = 0; i < 3; i += 1) {
    appendRecord(root, {
      source: 'qq',
      acct: 'x',
      channel: 'private:person_a',
      actor: { kind: 'owner', id: '12345', name: '老王' },
      role: 'user',
      text: `m-${ulid()}`,
      ts: localIso(),
    })
  }
  migrateToAccounts(root, { apply: true }) // 幂等：不再迁移
  const qq = accountForNative(root, PID, 'qq', '12345')
  refreshWeights(root, PID)
  assert.ok(loadAccount(root, PID, qq).weight > 0, '三条私聊要算出权重')
  const days = listDays(root)
  assert.ok(readDay(root, days[days.length - 1]).length > 0)
})

test('幂等：第二次 apply 直接跳过', () => {
  const r = migrateToAccounts(root, { apply: true })
  assert.equal(r.reason, 'already-migrated')
})
