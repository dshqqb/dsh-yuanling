// test/p15.test.mjs —— 自然语言身份描述：原文正本、解析派生、自动绑定不抢已占用的号。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { scaffold } from '../src/core/scaffold.js'
import {
  createPerson,
  linkIdentity,
  findByIdentity,
  loadIdentities,
  parseIdentityText,
  setIdentityText,
  reparseIdentityTexts,
  PLATFORMS,
  PLATFORM_ALIASES,
} from '../src/core/entities.js'

const PID = 'yuanling'

function tmpRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'yuanling-p15-'))
  scaffold(root, {})
  return root
}

test('parse：认 QQ 与微信', () => {
  const r = parseIdentityText('QQ 号是 12345，微信 zhang_01')
  assert.equal(r.items.length, 2)
  assert.deepEqual(r.items[0], { platform: 'qq', id: '12345' })
  assert.deepEqual(r.items[1], { platform: 'wechat', id: 'zhang_01' })
})

test('parse：认 B站中文昵称', () => {
  const r = parseIdentityText('B站昵称是老张')
  assert.equal(r.items.length, 1)
  assert.deepEqual(r.items[0], { platform: 'bili', id: '老张' })
})

test('parse：提到平台但没给值，不算账号', () => {
  const r = parseIdentityText('我的 b 站还没注册')
  assert.equal(r.items.length, 0)
  assert.equal(r.unparsed.length, 1)
})

test('parse：同一段里重复的不重复计', () => {
  const r = parseIdentityText('QQ 是 12345，qq:12345')
  assert.equal(r.items.length, 1)
})

test('平台表与解析器不漂移：解析器认的平台，绑定层必须也认', () => {
  for (const a of PLATFORM_ALIASES) {
    assert.ok(PLATFORMS.includes(a.platform), `${a.platform} 只在解析器里，绑定层不认`)
  }
})

test('identity：存原文、解析、并自动绑定没被占用的账号', () => {
  const root = tmpRoot()
  const p = createPerson(root, { display: '张三' })

  const r = setIdentityText(root, p.uid, 'QQ 号是 12345，b站叫老张，微博@zhang_01')
  assert.equal(r.parsed.items.length, 3)
  assert.equal(r.linked.length, 3, '三个号都没被别人占用，应该都绑上')

  const data = loadIdentities(root)
  assert.equal(data.people[p.uid].identity_text, 'QQ 号是 12345，b站叫老张，微博@zhang_01')
  assert.equal(data.people[p.uid].identities.length, 3)
  assert.equal(findByIdentity(root, 'qq', '12345').uid, p.uid)
})

test('identity：已经被别人占用的号不抢，只报冲突', () => {
  const root = tmpRoot()
  const a = createPerson(root, { display: '甲' })
  linkIdentity(root, a.uid, { platform: 'qq', id: '12345' })

  const b = createPerson(root, { display: '乙' })
  const r = setIdentityText(root, b.uid, 'QQ 号是 12345')

  assert.equal(r.linked.length, 0)
  assert.equal(r.conflicts.length, 1)
  assert.equal(r.conflicts[0].owner, a.uid)
  assert.equal(findByIdentity(root, 'qq', '12345').uid, a.uid, '归属不能被悄悄改掉')
})

test('identity：重复保存同一段话是幂等的', () => {
  const root = tmpRoot()
  const p = createPerson(root, { display: '张三' })
  setIdentityText(root, p.uid, 'QQ 号是 12345')
  const again = setIdentityText(root, p.uid, 'QQ 号是 12345')

  assert.equal(again.linked.length, 0, '已经绑在它自己身上了')
  assert.equal(again.conflicts.length, 0)
  assert.equal(loadIdentities(root).people[p.uid].identities.length, 1, '不该重复绑')
})

test('identity：改描述不会把旧账号解绑（解绑要显式做）', () => {
  const root = tmpRoot()
  const p = createPerson(root, { display: '张三' })
  setIdentityText(root, p.uid, 'QQ 号是 12345，b站叫老张')
  setIdentityText(root, p.uid, 'QQ 号是 12345')

  const data = loadIdentities(root)
  assert.equal(data.people[p.uid].identities.length, 2, 'b站那个还在——改描述不等于清空')
  assert.equal(data.people[p.uid].identity_parsed.length, 1, '解析视图跟着新描述')
})

test('identity：reparse 只刷新解析视图，不动链接', () => {
  const root = tmpRoot()
  const p = createPerson(root, { display: '张三' })
  setIdentityText(root, p.uid, 'QQ 号是 12345')

  const before = loadIdentities(root).people[p.uid].identities.length
  const rows = reparseIdentityTexts(root, { autoLink: false })
  assert.equal(rows.length, 1)
  assert.equal(loadIdentities(root).people[p.uid].identities.length, before)
})

test('identity：空文本把解析视图清空', () => {
  const root = tmpRoot()
  const p = createPerson(root, { display: '张三' })
  setIdentityText(root, p.uid, 'QQ 号是 12345')
  const r = setIdentityText(root, p.uid, '')

  assert.equal(r.parsed.items.length, 0)
  assert.equal(loadIdentities(root).people[p.uid].identity_parsed.length, 0)
})
