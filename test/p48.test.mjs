// test/p48.test.mjs —— 日志 / 审计 / 诊断的 HTTP 接口，以及模块自报诊断的协议（v1.4）。
//
// 这一层要注意的只有两件事：
//   ① 审计带回滚入口，所以 `/api/rollback` 必须**只认被跟踪过的路径**——
//      带 token 就能改任意文件的口子不能存在；
//   ② 这几个页在"还没内容"时返回空数组，不是 404、更不是编点东西出来。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { scaffold } from '../src/core/scaffold.js'
import { handleApi, handleApiWrite } from '../src/core/api.js'
import { appendEvent } from '../src/core/events.js'
import { writeGroup, readGroup } from '../src/core/groups.js'
import { ModuleService, DIAG_MAX_ITEMS } from '../src/core/modules/service.js'
import { moduleDir } from '../src/core/modules/registry.js'

const PID = 'yuanling'

function tmpRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'yuanling-p48-'))
  scaffold(root, {})
  return root
}

const api = (root, p) => handleApi(root, new URL(`http://127.0.0.1:1${p}`))
const write = (root, p, body) => handleApiWrite(root, new URL(`http://127.0.0.1:1${p}`), body)

// ── 日志 ────────────────────────────────────────────────────────────────

test('/api/logs：空库返回空 items，不是 404 也不是编的东西', () => {
  const root = tmpRoot()
  const r = api(root, '/api/logs')
  assert.equal(r.status, 200)
  assert.deepEqual(r.body.items, [])
  assert.equal(r.body.counts.total, 0)
  assert.equal(r.body.lens, 'all')
})

test('/api/logs：lens 透传，统计跟着镜头走', () => {
  const root = tmpRoot()
  appendEvent(root, { kind: 'ingest', text: 'a' })
  appendEvent(root, { kind: 'error', level: 'error', text: 'b' })
  writeGroup(root, PID, 'qq:555', { name: 'x' }, { actor: 'model:group', reason: '写入' })

  const all = api(root, '/api/logs?lens=all')
  assert.equal(all.body.items.length, 3)

  const err = api(root, '/api/logs?lens=error')
  assert.equal(err.body.items.length, 1)
  assert.equal(err.body.items[0].kind, 'error')

  const au = api(root, '/api/logs?lens=write')
  assert.equal(au.body.items.length, 1, 'lens=write 就是审计')
})

test('/api/logs：可以按 module 过滤（模块的日志页要用）', () => {
  const root = tmpRoot()
  appendEvent(root, { kind: 'module.start', module: 'bili', text: '启动' })
  appendEvent(root, { kind: 'module.start', module: 'qq', text: '启动' })
  const r = api(root, '/api/logs?module=bili')
  assert.equal(r.body.items.length, 1)
  assert.equal(r.body.items[0].module, 'bili')
})

// ── 审计（模块级）───────────────────────────────────────────────────────

test('/api/module/audit：缺 id → 400，给了 id → 只出这个模块造成的写入', () => {
  const root = tmpRoot()
  assert.equal(api(root, '/api/module/audit').status, 400)

  writeGroup(root, PID, 'qq:555', { name: 'x' }, { actor: 'model:group', reason: '群写入' })
  // 模块的写入靠路径区分（模块自己的 config.json 不进 journal，这里只验过滤不误伤）
  const r = api(root, '/api/module/audit?id=bili')
  assert.equal(r.status, 200)
  assert.equal(r.body.module, 'bili')
  assert.deepEqual(r.body.writes, [], '别人的写入不该算到这个模块头上')

  const all = api(root, '/api/logs?lens=write')
  assert.equal(all.body.items.length, 1, '但全局审计里还在')
})

// ── 回滚：只认被跟踪过的路径 ────────────────────────────────────────────

test('/api/rollback：能退回上一版（回滚本身也是一次新版本）', () => {
  const root = tmpRoot()
  writeGroup(root, PID, 'qq:555', { name: '第一版' }, { actor: 'model:group', reason: '一' })
  const w = api(root, '/api/logs?lens=write').body.items.at(-1)

  writeGroup(root, PID, 'qq:555', { name: '第二版' }, { actor: 'model:group', reason: '二' })
  assert.equal(readGroup(root, PID, 'qq:555').name, '第二版')

  const r = write(root, '/api/rollback', { path: w.path, hash: w.hash })
  assert.equal(r.status, 200)
  assert.equal(readGroup(root, PID, 'qq:555').name, '第一版')
  assert.equal(r.body.changed, true)
})

test('/api/rollback：没被跟踪过的路径一律拒——带 token 就能改任意文件的口子不能存在', () => {
  const root = tmpRoot()
  const r = write(root, '/api/rollback', { path: 'system/manifest.json', hash: 'sha256:abc' })
  assert.equal(r.status, 400)
  assert.match(r.body.error, /没有版本历史/)
})

test('/api/rollback：缺参数 → 400', () => {
  const root = tmpRoot()
  assert.equal(write(root, '/api/rollback', { path: 'x' }).status, 400)
  assert.equal(write(root, '/api/rollback', {}).status, 400)
})

// ── 诊断 ────────────────────────────────────────────────────────────────

test('/api/diagnostics：默认只列问题，only=all 列全部检查项', () => {
  const root = tmpRoot()
  const problems = api(root, '/api/diagnostics')
  assert.equal(problems.status, 200)
  const all = api(root, '/api/diagnostics?only=all')
  assert.ok(all.body.items.length >= problems.body.items.length)
  for (const it of all.body.items) {
    assert.ok(it.code && it.stage && it.hint, '三件套缺一不可')
  }
})

test('/api/module/diag：缺 id → 400；有 id 时把该模块的项与自报分开给', () => {
  const root = tmpRoot()
  assert.equal(api(root, '/api/module/diag').status, 400)

  const dir = moduleDir(root, 'fake')
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(
    path.join(dir, 'yuanling.module.json'),
    JSON.stringify({ id: 'fake', version: '0.1.0', api: '1.2', capabilities: ['send'], entry: { command: ['node', 'x.js'] } }),
  )
  fs.writeFileSync(path.join(root, 'system', 'modules.json'), JSON.stringify({ version: 1, modules: { fake: { enabled: true, capabilities: ['send'], granted: [], state: 'ready' } } }), 'utf8')

  const r = api(root, '/api/module/diag?id=fake')
  assert.equal(r.status, 200)
  assert.equal(r.body.module, 'fake')
  assert.ok(r.body.items.some((x) => x.code === 'module.capability-pending'))
  assert.deepEqual(r.body.reported.items, [], '没自报过就是空')
})

// ── 协议 v1.4：diag.report ─────────────────────────────────────────────

test('协议：模块自报诊断项 → 落盘、有 TTL、过期即消失', () => {
  const root = tmpRoot()
  const svc = new ModuleService({ root })
  const dir = moduleDir(root, 'fake')
  fs.mkdirSync(dir, { recursive: true })

  const ack = svc.reportDiag('fake', { items: [{ code: 'cookie.expired', level: 'error', hint: '去设置页重新登录' }] })
  assert.equal(ack.accepted, 1)
  assert.equal(ack.truncated, false)

  const fresh = svc.readModuleDiag('fake')
  assert.equal(fresh.items.length, 1)
  assert.equal(fresh.stale, false)

  // 时间往后拨 20 分钟，再看
  const stale = svc.readModuleDiag('fake', { now: Date.now() + 20 * 60 * 1000 })
  assert.deepEqual(stale.items, [], '进程死了之后，它自报的"正常"不能还挂着')
  assert.equal(stale.stale, true)
})

test('协议：自报项条数封顶（一个模块不能靠诊断刷满页面）', () => {
  const root = tmpRoot()
  const svc = new ModuleService({ root })
  const many = Array.from({ length: DIAG_MAX_ITEMS + 10 }, (_, i) => ({ code: `c${i}`, level: 'warn', hint: 'x' }))
  const ack = svc.reportDiag('fake', { items: many })
  assert.equal(ack.accepted, DIAG_MAX_ITEMS)
  assert.equal(ack.truncated, true)
  assert.equal(svc.readModuleDiag('fake').items.length, DIAG_MAX_ITEMS)
})

test('协议：自报是整份替换，不是累加', () => {
  const root = tmpRoot()
  const svc = new ModuleService({ root })
  svc.reportDiag('fake', { items: [{ code: 'a', level: 'warn', hint: 'x' }] })
  svc.reportDiag('fake', { items: [{ code: 'b', level: 'warn', hint: 'y' }] })
  const r = svc.readModuleDiag('fake')
  assert.deepEqual(r.items.map((x) => x.code), ['b'], '模块重算一遍比核心帮它做增量合并更可靠')
})

test('协议：diag.report 不需要能力（它是报告，不是动作）', async () => {
  const root = tmpRoot()
  const svc = new ModuleService({ root })
  // 注册表里没有这个模块、也没授予任何能力
  const r = await svc.handleModuleRequest('unknown-mod', { op: 'diag.report', data: { items: [{ code: 'x', hint: 'y' }] } })
  assert.equal(r.accepted, 1, '报告不该被能力门控挡住')
})
