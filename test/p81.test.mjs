// test/p81.test.mjs —— 身份描述可以有多条（2026-11-12）
//
// 用户定：一个人物卡可以有多个身份描述（QQ、微信、贴吧 ID 各一句），不是绑在一个账户上。
// 存储：person.account_texts = [{ text, parsed:[{platform,id}], unparsed, at }]
import { test, before } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { scaffold } from '../src/core/scaffold.js'
import {
  createPerson,
  accountTextsOf,
  listPeopleForUi,
  loadIdentities,
  readProfile,
  setAccountTexts,
  writeProfile,
} from '../src/core/entities.js'
import { setPinned } from '../src/core/entities.js'

const PID = 'yuanling'
let root

before(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'yuanling-p81-'))
  scaffold(root, {})
})

test('多条描述：QQ / 微信 / 贴吧 各一句，都解析成账号', () => {
  const p = createPerson(root, { display: '老王' })
  const r = setAccountTexts(root, p.uid, ['QQ 号是 10001', '微信 laowang_88', '贴吧叫老王吧'])
  assert.equal(r.texts.length, 3)
  const person = loadIdentities(root).people[p.uid]
  assert.equal(person.account_texts.length, 3)
  assert.deepEqual(
    person.account_texts.map((x) => x.text),
    ['QQ 号是 10001', '微信 laowang_88', '贴吧叫老王吧'],
  )
  const platforms = person.identities.map((x) => x.platform).sort()
  assert.deepEqual(platforms, ['qq', 'tieba', 'wechat'])
})

test('追加模式：不改已有的描述', () => {
  const p = createPerson(root, { display: '小李' })
  setAccountTexts(root, p.uid, ['QQ 号是 20001'])
  const r = setAccountTexts(root, p.uid, ['微信 lixiaoli'], { replace: false })
  assert.equal(r.texts.length, 2)
  assert.ok(accountTextsOf(r.person).some((x) => x.text === 'QQ 号是 20001'))
})

test('整组覆盖：没再提到的"由描述推出来的"账号被收回', () => {
  const p = createPerson(root, { display: '小张' })
  setAccountTexts(root, p.uid, ['QQ 号是 30001', 'b站叫小张'])
  setAccountTexts(root, p.uid, ['QQ 号是 30001'])
  const person = loadIdentities(root).people[p.uid]
  assert.equal(person.account_texts.length, 1)
  assert.deepEqual(person.identities.map((x) => x.platform), ['qq'])
})

test('人物列表带 accountTexts（页面显示用）', () => {
  const rows = listPeopleForUi(root, PID)
  const wang = rows.find((x) => x.display === '老王')
  assert.ok(wang)
  assert.equal(wang.accountTexts.length, 3)
})

test('熟人/重要人物/管理员的计数来自列表本身（移动就少一个）', () => {
  const p = createPerson(root, { display: '熟人甲' })
  setAccountTexts(root, p.uid, ['QQ 号是 40001'])
  writeProfile(root, PID, p.uid, { sketch: '认识的人' })

  const before = listPeopleForUi(root, PID)
  assert.equal(before.filter((x) => !x.admin && !x.pinned).length, before.filter((x) => !x.admin && !x.pinned).length)

  const restBefore = before.filter((x) => !x.admin && !x.pinned).length
  setPinned(root, PID, p.uid, true)
  const after = listPeopleForUi(root, PID)
  const restAfter = after.filter((x) => !x.admin && !x.pinned).length
  assert.equal(restAfter, restBefore - 1, '设为重点后，熟人少一个')
  assert.equal(after.filter((x) => x.pinned && !x.admin).length, 1)
})

test('身份描述读得回、也整理得干净（空行 / 重复）', () => {
  const p = createPerson(root, { display: '小美' })
  setAccountTexts(root, p.uid, ['QQ 号是 50001', '  ', 'QQ 号是 50001'])
  assert.equal(accountTextsOf(loadIdentities(root).people[p.uid]).length, 1)
})
