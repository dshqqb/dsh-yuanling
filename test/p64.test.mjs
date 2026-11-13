// test/p64.test.mjs —— 模块 → 核心的接线：ingest / propose.fact 真的能干活。
//
// 之前 `index.js` 里 `new ModuleService({root,pid})` 没传 handler，
// 模块一投消息就报"核心未配置 ingest 处理器"——等于模块化的另一端没接。
// 这组用例走**真实的请求分发**（`handleModuleRequest`），只把模块进程换成假模块。
import { test, before } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { scaffold } from '../src/core/scaffold.js'
import { moduleHandlers } from '../src/core/modules/wire.js'
import { ModuleService } from '../src/core/modules/service.js'
import { writeRegistry } from '../src/core/modules/registry.js'
import { readDay, listDays, today } from '../src/core/raw.js'
import { listEntries } from '../src/core/memory.js'
import { localIso } from '../src/core/fsx.js'

const PID = 'yuanling'
let root
let svc

function grant(id, capabilities = ['ingest.message', 'propose.fact']) {
  writeRegistry(root, { version: 1, modules: { [id]: { id, capabilities, granted: capabilities } } })
}

before(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'yuanling-p64-'))
  scaffold(root, {})
  svc = new ModuleService({ root, pid: PID, ...moduleHandlers({ root, pid: PID }) })
  grant('fake-qq')
})

test('ingest：模块投进来的消息真的落到 raw，source 由核心盖章', async () => {
  const r = await svc.handleModuleRequest('fake-qq', {
    op: 'ingest',
    data: {
      v: 1,
      // 模块自报的 source 不可信；核心会换成模块 id
      source: 'client-says-something-else',
      acct: '10001',
      items: [
        {
          ts: localIso(),
          channel: 'private:10001',
          kind: 'msg',
          actor: { kind: 'owner', id: '10001', name: '主人' },
          text: '今天加班到九点',
        },
      ],
    },
  })
  assert.equal(r.accepted, 1)
  assert.equal(r.skipped, 0)

  const day = today()
  const rows = readDay(root, day)
  assert.equal(rows.length, 1)
  assert.equal(rows[0].source, 'fake-qq', 'source 必须是核心盖的章，不是模块自报的')
  assert.equal(rows[0].text, '今天加班到九点')
  assert.match(rows[0].channel, /^private:card_/, '频道要归到内部卡编号')
})

test('ingest：脱敏与硬线照旧生效（不因为换了入口就绕过）', async () => {
  const g = JSON.parse(fs.readFileSync(path.join(root, 'guardrails.json'), 'utf8'))
  g.never_record = ['银行卡号']
  fs.writeFileSync(path.join(root, 'guardrails.json'), JSON.stringify(g, null, 2), 'utf8')

  const r = await svc.handleModuleRequest('fake-qq', {
    op: 'ingest',
    data: { v: 1, acct: '1', items: [{ ts: localIso(), channel: 'private:10001', kind: 'msg', actor: { kind: 'owner', id: '10001' }, text: '我的银行卡号是 6222' }] },
  })
  assert.equal(r.skipped, 1, '硬线命中要拦')

  const all = listDays(root).flatMap((d) => readDay(root, d)).map((x) => x.text).join('\n')
  assert.ok(!all.includes('6222'), '被硬线拦下的内容一个字都不该进 raw')

  g.never_record = []
  fs.writeFileSync(path.join(root, 'guardrails.json'), JSON.stringify(g, null, 2), 'utf8')
})

test('propose.fact：指针有效就收下，并记 origin_module', async () => {
  const day = today()
  const rec = readDay(root, day).find((x) => x.text === '今天加班到九点')
  assert.ok(rec)

  const r = await svc.handleModuleRequest('fake-qq', {
    op: 'propose.fact',
    data: { topic: '工作', text: '他今天加班到九点', src: `raw/${day.slice(0, 7)}/${day.slice(8)}/fake-qq.ndjson#${rec.id}` },
  })
  assert.equal(r.status, 'accepted')
  assert.ok(r.factId)

  const facts = listEntries(root, PID).flatMap((e) => e.facts ?? [])
  const hit = facts.find((f) => f.text === '他今天加班到九点')
  assert.ok(hit)
  assert.equal(hit.origin_module, 'fake-qq')
})

test('propose.fact：假指针一律拒绝（没有指针的事实不写）', async () => {
  const before = listEntries(root, PID).flatMap((e) => e.facts ?? []).length
  await assert.rejects(
    svc.handleModuleRequest('fake-qq', {
      op: 'propose.fact',
      data: { topic: 'x', text: '编的事实', src: 'raw/2026-01/01/qq.ndjson#nope' },
    }),
    /指针/,
  )
  assert.equal(listEntries(root, PID).flatMap((e) => e.facts ?? []).length, before)
})

test('能力门控：没授予就进不来', async () => {
  grant('no-cap', [])
  writeRegistry(root, { version: 1, modules: { 'no-cap': { id: 'no-cap', capabilities: ['ingest.message'], granted: [] } } })
  await assert.rejects(
    svc.handleModuleRequest('no-cap', { op: 'ingest', data: { v: 1, items: [] } }),
    /能力未授予：ingest.message/,
  )
})

test('ingest：单批超过 100 条直接拒（让模块自己分批，不静默截断）', async () => {
  grant('fake-qq') // 上一条用例把注册表换成了 no-cap，这里补回来
  const items = Array.from({ length: 101 }, (_, i) => ({
    ts: localIso(),
    channel: 'private:10001',
    kind: 'msg',
    actor: { kind: 'owner', id: '10001' },
    text: `第 ${i} 条`,
  }))
  await assert.rejects(svc.handleModuleRequest('fake-qq', { op: 'ingest', data: { v: 1, items } }), /不得超过 100/)
})
