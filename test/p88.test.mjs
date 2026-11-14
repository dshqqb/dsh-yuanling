// test/p88.test.mjs —— 测试模式的工具闸门用 guard，不依赖工具是否已注册。
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { apply } from '../guard.js'

test('guard 在调用时按工具名拦截，不要求 MCP 工具先注册', () => {
  let guard = null
  apply({ tools: { guard: (fn) => { guard = fn } } })
  assert.equal(typeof guard, 'function')
  assert.match(guard({ name: 'mcp__yuanling__yuanling_remember' }), /禁止写入/)
  assert.equal(guard({ name: 'read_mcp_resource' }), undefined)
})
