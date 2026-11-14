// test/p66.test.mjs —— 设置分成两处：
//   · 管理台开关/监听地址/端口/局域网访问 → DSH 设置页（Config，即时读取）；
//   · 演化周期/主动开口/日志级别等 → 数据目录 system/policy.json（可迁移）。
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

test('policy 只保留运行设置：管理台四项不在里面', () => {
  for (const key of ['consoleEnabled', 'consoleHost', 'consolePort', 'allowRemote']) {
    assert.equal(POLICY_KEYS.includes(key), false, `${key} 不再属于 policy`)
  }
  const p = ensurePolicy(root, { consolePort: 18080, evolveEveryHours: 12, logLevel: 'debug' })
  assert.equal(p.evolveEveryHours, 12)
  assert.equal(p.logLevel, 'debug')
  assert.equal('consolePort' in p, false)
  assert.ok(fs.existsSync(path.join(root, POLICY)))
})

test('第二次启动：文件里已有的值不被 DSH 配置覆盖', () => {
  writePolicy(root, { evolveEveryHours: 3 })
  const p = ensurePolicy(root, { evolveEveryHours: 6 })
  assert.equal(p.evolveEveryHours, 3)
})

test('只补缺：新版本加的字段会用初值补上，老字段保持不动', () => {
  const p = ensurePolicy(root, { proactiveEveryMinutes: 45 })
  assert.equal(p.proactiveEveryMinutes, 45)
  assert.equal(p.evolveEveryHours, 3)
})

test('runtimeConfig：管理台四项来自 DSH config；其余 policy 赢', () => {
  const rc = runtimeConfig(
    { dataDir: 'D:\\yuanling', consolePort: 18080, consoleHost: '0.0.0.0', allowRemote: true, consoleEnabled: true, evolveEveryHours: 999 },
    { evolveEveryHours: 4 },
  )
  assert.equal(rc.consolePort, 18080)
  assert.equal(rc.consoleHost, '0.0.0.0')
  assert.equal(rc.allowRemote, true)
  assert.equal(rc.consoleEnabled, true)
  assert.equal(rc.evolveEveryHours, 4)
  assert.equal(rc.dataDir, 'D:\\yuanling')
})

test('写入：不认识的键直接拒绝（包括已迁走的管理台字段）', () => {
  assert.throws(() => writePolicy(root, { nonsenseKey: 1 }), /不认识的设置项/)
  assert.throws(() => writePolicy(root, { consolePort: 18080 }), /不认识的设置项/)
})

test('写入：类型和范围校验（"abc" 不会变成 0）', () => {
  assert.throws(() => writePolicy(root, { evolveEveryHours: 99999 }), /不能大于/)
  assert.throws(() => writePolicy(root, { logLevel: 'verbose' }), /只能是/)
})

test('坏值写进文件也不会让插件起不来（读取时回落到默认值）', () => {
  fs.writeFileSync(
    path.join(root, POLICY),
    JSON.stringify({ evolveEveryHours: -5, logLevel: 'nope' }),
    'utf8',
  )
  const p = readPolicy(root)
  assert.equal(p.evolveEveryHours, 6)
  assert.equal(p.logLevel, 'info')
})

test('normalizePolicy：缺字段补默认，字符串数字能转换', () => {
  const p = normalizePolicy({ evolveEveryHours: '12' })
  assert.equal(p.evolveEveryHours, 12)
  for (const key of POLICY_KEYS) assert.ok(p[key] !== undefined, `${key} 应该有值`)
})

test('policyView：只给页面的运行设置，不含管理台四项', () => {
  const view = policyView(root)
  assert.equal(view.some((f) => f.key === 'consolePort'), false)
  const evolve = view.find((f) => f.key === 'evolveEveryHours')
  assert.ok(evolve)
  assert.equal(evolve.restart, false)
  assert.ok(evolve.label)
})

test('可迁移：拷到另一个目录后，运行设置还在', () => {
  writePolicy(root, { logLevel: 'warn' })
  const copy = fs.mkdtempSync(path.join(os.tmpdir(), 'yuanling-p66-copy-'))
  fs.cpSync(root, copy, { recursive: true })
  const p = readPolicy(copy)
  assert.equal(p.logLevel, 'warn')
})
