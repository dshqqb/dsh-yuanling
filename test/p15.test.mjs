// test/p15.test.mjs —— 自然语言身份描述：原文正本、解析派生、自动绑定不抢已占用的号。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { scaffold } from '../src/core/scaffold.js'
import { parseIdentityText, PLATFORMS, PLATFORM_ALIASES } from '../src/core/entities.js'

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
