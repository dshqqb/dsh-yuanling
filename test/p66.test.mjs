// test/p66.test.mjs —— 运行设置的真值在数据目录里（README 第一条"复制粘贴可迁移"）。
//
// 之前：端口 / 演化周期 / 主动周期 / 日志级别只存在 DSH 插件配置里，
// 把数据目录拷到新机器，人格和记忆都在，但这些旋钮全要重配。
// 现在：system/policy.json 是真值；DSH 设置页只在"没有这个文件"时给初值。
import { test, before } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { scaffold } from '../src/core/scaffold.js'
import {
  ensurePolicy,
  readPolicy,
  writePolicy,
  runtimeConfig,
  policyView,
  normalizePolicy,
  POLICY_KEYS,
} from '../src/core/policy.js'

const POLICY = 'system/policy.json'
let root

before(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'yuanling-p66-'))
  scaffold(root, {})
})

const readFile = () => JSON.parse(fs.readFileSync(path.join(root, POLICY), 'utf8'))

test('首次运行：把 DSH 设置页的初值灌进数据目录', () => {
  const p = ensurePolicy(root, { consolePort: 18080, evolveEveryHours: 12, logLevel: 'debug' })
  assert.equal(p.consolePort, 18080)
  assert.equal(p.evolveEveryHours, 12)
  assert.equal(p.logLevel, 'debug')
  assert.ok(fs.existsSync(path.join(root, POLICY)))
  // 没给的字段用默认值补齐（一份完整的设置，不留"undefined 算多少"）
  assert.equal(typeof p.consoleEnabled, 'boolean')
  assert.equal(p.consoleHost, '127.0.0.1')
})

test('第二次启动：文件里已有的值不被 DSH 配置覆盖（否则每次启动都冲掉人的修改）', () => {
  writePolicy(root, { evolveEveryHours: 3, consolePort: 18081 })
  const p = ensurePolicy(root, { consolePort: 17777, evolveEveryHours: 6 })
  assert.equal(p.consolePort, 18081, '人在数据目录里改过的端口要留着')
  assert.equal(p.evolveEveryHours, 3)
})

test('只补缺：新版本加的字段会用初值补上，老字段保持不动', () => {
  const p = ensurePolicy(root, { proactiveEveryMinutes: 45 })
  assert.equal(p.proactiveEveryMinutes, 45)
  assert.equal(p.consolePort, 18081)
})

test('runtimeConfig：policy 赢，config 只是兜底', () => {
  const rc = runtimeConfig(
    { dataDir: 'D:\\yuanling', consolePort: 1, evolveEveryHours: 999 },
    { consolePort: 18082, evolveEveryHours: 4 },
  )
  assert.equal(rc.consolePort, 18082)
  assert.equal(rc.evolveEveryHours, 4)
  assert.equal(rc.dataDir, 'D:\\yuanling', 'dataDir 属于启动参数，不该被 policy 改')
})

test('写入：不认识的键直接拒绝（不静默存一个没人读的配置）', () => {
  assert.throws(() => writePolicy(root, { nonsenseKey: 1 }), /不认识的设置项/)
})

test('写入：类型和范围校验（"abc" 不会变成 0）', () => {
  assert.throws(() => writePolicy(root, { consolePort: 'abc' }), /要的是数字/)
  assert.throws(() => writePolicy(root, { evolveEveryHours: 99999 }), /不能大于/)
  assert.throws(() => writePolicy(root, { logLevel: 'verbose' }), /只能是/)
})

test('坏值写进文件也不会让插件起不来（读取时回落到默认值）', () => {
  fs.writeFileSync(
    path.join(root, POLICY),
    JSON.stringify({ consolePort: 'not-a-port', evolveEveryHours: -5, logLevel: 'nope' }),
    'utf8',
  )
  const p = readPolicy(root)
  assert.equal(p.consolePort, 17777)
  assert.equal(p.evolveEveryHours, 6)
  assert.equal(p.logLevel, 'info')
})

test('normalizePolicy：缺字段补默认，字符串数字能转换', () => {
  const p = normalizePolicy({ consolePort: '18000', allowRemote: 'true' })
  assert.equal(p.consolePort, 18000)
  assert.equal(p.allowRemote, true)
  for (const key of POLICY_KEYS) assert.ok(p[key] !== undefined, `${key} 应该有值`)
})

test('policyView：给页面用的字段说明，含"要不要重启"', () => {
  const view = policyView(root)
  const port = view.find((f) => f.key === 'consolePort')
  assert.equal(port.restart, true, '改端口必须重启，页面要说清楚')
  const evolve = view.find((f) => f.key === 'evolveEveryHours')
  assert.equal(evolve.restart, false)
  assert.ok(evolve.label)
})

test('可迁移：拷到另一个目录后，设置还在（这就是 README 第一条）', () => {
  writePolicy(root, { consolePort: 19000, logLevel: 'warn' })
  const copy = fs.mkdtempSync(path.join(os.tmpdir(), 'yuanling-p66-copy-'))
  fs.cpSync(root, copy, { recursive: true })
  const p = readPolicy(copy)
  assert.equal(p.consolePort, 19000)
  assert.equal(p.logLevel, 'warn')
})
