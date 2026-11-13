// test/p81.test.mjs —— 账户卡 / 人物卡（2026-11-13）
//
// 一个账户 = 一个平台上的一个号；昵称可多个；人物只是账户的归组。
import { test, before } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { scaffold } from '../src/core/scaffold.js'
import {
  createAccountWithPerson,
  setAccountNicknames,
  setAccountDescription,
  mergeAccounts,
  splitPerson,
  loadAccount,
  listAccounts,
  personForAccount,
  accountsForPerson,
  labelOfPerson,
  personWeight,
  setAccountFriend,
} from '../src/core/accounts.js'
import { listPeopleForUi, readProfile, writeProfile, setPinned } from '../src/core/entities.js'

const PID = 'yuanling'
let root

before(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'yuanling-p81-'))
  scaffold(root, {})
})

test('账户卡：一个号一张卡，昵称可以多个', () => {
  const r = createAccountWithPerson(root, PID, {
    platform: 'qq',
    nativeId: '10001',
    nicknames: ['老王', '老老王'],
    description: '爱喝茶',
  })
  const card = loadAccount(root, PID, r.acct)
  assert.deepEqual(card.nicknames, ['老王', '老老王'])
  assert.equal(card.description, '爱喝茶')
  assert.equal(personForAccount(root, PID, r.acct).uid, r.person)
  assert.equal(labelOfPerson(root, PID, r.person), '老王 / 老老王')
})

test('账户卡：改昵称、描述、好友', () => {
  const acct = listAccounts(root, PID).find((a) => a.nativeId === '10001').uid
  setAccountNicknames(root, PID, acct, ['老王', '王叔'])
  setAccountDescription(root, PID, acct, '好友备注：王叔\n爱喝茶')
  setAccountFriend(root, PID, acct, true)
  const card = loadAccount(root, PID, acct)
  assert.deepEqual(card.nicknames, ['老王', '王叔'])
  assert.match(card.description, /好友备注：王叔/)
  assert.equal(card.friend, true)
})

test('合并：账户权重不变，人物权重求和，必须给 sketch', () => {
  const qq = listAccounts(root, PID).find((a) => a.platform === 'qq')
  const b = createAccountWithPerson(root, PID, { platform: 'bili', nativeId: '老王bili', nickname: '老王' })
  const qqWeight = loadAccount(root, PID, qq.uid).weight
  const bWeight = loadAccount(root, PID, b.acct).weight

  const m = mergeAccounts(root, PID, {
    accounts: [qq.uid, b.acct],
    sketch: '同一个人：QQ 和 B 站',
    reason: '本人在私聊里说的',
  })
  assert.equal(personForAccount(root, PID, qq.uid).uid, m.person)
  assert.equal(personForAccount(root, PID, b.acct).uid, m.person)
  assert.equal(accountsForPerson(root, PID, m.person).length, 2)
  assert.equal(loadAccount(root, PID, qq.uid).weight, qqWeight, '账户权重不能变')
  assert.equal(loadAccount(root, PID, b.acct).weight, bWeight, '账户权重不能变')
  assert.equal(readProfile(root, PID, m.person).sketch, '同一个人：QQ 和 B 站')
  assert.equal(personWeight(root, PID, m.person), Math.min(100, qqWeight + bWeight))
})

test('合并：不给 sketch 直接拒绝', () => {
  const accts = listAccounts(root, PID).map((a) => a.uid)
  assert.throws(() => mergeAccounts(root, PID, { accounts: accts, reason: '想合并' }), /sketch/)
})

test('拆分：原描述跟主账户走，新人物保留带标注的副本；账户权重不变', () => {
  const accts = listAccounts(root, PID)
  const qq = accts.find((a) => a.platform === 'qq').uid
  const bili = accts.find((a) => a.platform === 'bili').uid
  const person = personForAccount(root, PID, qq).uid
  const qqWeight = loadAccount(root, PID, qq).weight
  const r = splitPerson(root, PID, { person, accounts: [bili] })
  assert.notEqual(personForAccount(root, PID, bili).uid, person)
  assert.equal(loadAccount(root, PID, qq).weight, qqWeight)
  assert.match(readProfile(root, PID, r.to).sketch, /拆分前/)
  assert.match(readProfile(root, PID, person).sketch, /同一个人/)
})

test('人物列表带昵称与账户（页面显示用）', () => {
  const rows = listPeopleForUi(root, PID)
  const wang = rows.find((x) => (x.nicknames ?? []).includes('老王'))
  assert.ok(wang)
  assert.ok(wang.accounts.length >= 1)
  assert.ok(wang.accounts[0].nativeId)
})

test('熟人/重要人物计数来自列表本身（移动就少一个）', () => {
  const r = createAccountWithPerson(root, PID, { platform: 'qq', nativeId: '40001', nickname: '熟人甲' })
  writeProfile(root, PID, r.person, { sketch: '认识的人' })
  const before = listPeopleForUi(root, PID)
  const restBefore = before.filter((x) => !x.admin && !x.pinned).length
  setPinned(root, PID, r.person, true)
  const after = listPeopleForUi(root, PID)
  assert.equal(after.filter((x) => !x.admin && !x.pinned).length, restBefore - 1)
  assert.equal(after.filter((x) => x.pinned && !x.admin).length, 1)
})
