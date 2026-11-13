// test/p57.test.mjs —— 名字规则（2026-11-13 改）：人物没有 display，账户昵称允许重名；
// 群体名仍在同一人格内唯一。
import { test, before } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { scaffold } from '../src/core/scaffold.js'
import { createPersona } from '../src/core/persona.js'
import { createAccountWithPerson, listAccounts } from '../src/core/accounts.js'
import { createGroupWithCard, writeGroup, readGroup, groupNameOwner } from '../src/core/groups.js'

const PID = 'yuanling'
let root

before(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'yuanling-p57-'))
  scaffold(root, {})
})

test('账户昵称允许重名：两个号都叫“老王”也能各自建卡', () => {
  createAccountWithPerson(root, PID, { platform: 'qq', nativeId: '1', nickname: '老王' })
  createAccountWithPerson(root, PID, { platform: 'wechat', nativeId: 'wx1', nickname: '老王' })
  const rows = listAccounts(root, PID).filter((a) => a.nicknames.includes('老王'))
  assert.equal(rows.length, 2)
})

test('群体：同一人格内重名被拒绝', () => {
  createGroupWithCard(root, PID, { name: '老群', accountText: 'qq:123456' })
  assert.throws(
    () => createGroupWithCard(root, PID, { name: '老群', accountText: 'qq:654321' }),
    /已经有人用了/,
  )
})

test('群体：不同人格各叫各的（群体卡按人格存）', () => {
  createPersona(root, 'xiaoyu', '小雨')
  const g = createGroupWithCard(root, 'xiaoyu', { name: '老群', accountText: 'qq:123456' })
  assert.ok(g.gid)
  assert.notEqual(groupNameOwner(root, PID, '老群'), groupNameOwner(root, 'xiaoyu', '老群'))
})

test('群体：改名撞到同人格里别的群会被拒绝', () => {
  const a = createGroupWithCard(root, PID, { name: 'A群', accountText: 'qq:111111' })
  const b = createGroupWithCard(root, PID, { name: 'B群', accountText: 'qq:222222' })
  assert.throws(() => writeGroup(root, PID, b.gid, { name: 'A群', __reason: '测试' }), /已经有人用了/)
  writeGroup(root, PID, b.gid, { name: 'B群', __reason: '改回自己的名字' })
  assert.equal(readGroup(root, PID, b.gid).name, 'B群')
})

test('人物与群体可以同名（两个不同的类别）', () => {
  const p = createAccountWithPerson(root, PID, { platform: 'qq', nativeId: '333333', nickname: '同名' })
  assert.ok(p.person)
  const g = createGroupWithCard(root, PID, { name: '同名', accountText: 'qq:444444' })
  assert.ok(g.gid)
})
