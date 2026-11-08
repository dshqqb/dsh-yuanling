// test/p36.test.mjs —— 模块配置：schema 校验 + 保存接口 + 改完要重启。
//
// 为什么值得单独一组：模块配置是**核心保管、模块不读文件**，所以核心写进去什么，
// 模块就拿到什么。校验漏一个分支的后果很具体——用户在页面上把 ws 地址填成空、
// 把 timeout 填成 "abc"，模块要么起不来，要么静默用错值，而页面什么提示都没有。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import zlib from 'node:zlib'

import { scaffold } from '../src/core/scaffold.js'
import { installFromBytes } from '../src/core/modules/installer.js'
import { validateConfig, describeFields } from '../src/core/modules/configschema.js'
import { readModuleConfig, writeModuleConfig, moduleDetail } from '../src/core/modules/manage.js'
import { handleApiWrite } from '../src/core/api.js'
import { kickModule } from '../src/core/server.js'

const u = (p) => new URL(p, 'http://127.0.0.1')

function tmpRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'yuanling-p36-'))
  scaffold(root, {})
  return root
}

function makeTar(files) {
  const blocks = []
  for (const [name, content] of Object.entries(files)) {
    const data = Buffer.from(content)
    const h = Buffer.alloc(512)
    h.write(name, 0, 'utf8')
    h.write(data.length.toString(8).padStart(11, '0'), 124, 'utf8')
    h.write('0', 156, 'utf8')
    blocks.push(h, data)
    const pad = (512 - (data.length % 512)) % 512
    if (pad) blocks.push(Buffer.alloc(pad))
  }
  blocks.push(Buffer.alloc(1024))
  return zlib.gzipSync(Buffer.concat(blocks))
}

const SCHEMA = {
  type: 'object',
  properties: {
    wsUrl: { type: 'string', description: 'NapCat WebSocket 地址' },
    selfId: { type: 'number' },
    mode: { type: 'string', enum: ['whitelist', 'blacklist'] },
    quiet: { type: 'boolean' },
    retries: { type: 'number', default: 3 },
    sessdata: { type: 'string', description: '登录 cookie' },
  },
  required: ['wsUrl'],
}

const MANIFEST = {
  id: 'demo',
  name: '演示模块',
  version: '0.1.0',
  api: '1.0',
  kind: 'gateway',
  entry: { command: ['node', 'index.mjs'] },
  capabilities: ['ingest.message'],
  config: { schema: SCHEMA },
}

function withModule() {
  const root = tmpRoot()
  installFromBytes({
    root,
    bytes: makeTar({ 'yuanling.module.json': JSON.stringify(MANIFEST, null, 2), 'index.mjs': 'export default {}' }),
    source: 'test',
  })
  return root
}

// ── 校验器 ──────────────────────────────────────────────────────────────

test('config：必填缺失要拦住（空串也算没填）', () => {
  const r = validateConfig(SCHEMA, {})
  assert.equal(r.ok, false)
  assert.deepEqual(r.errors.map((e) => e.field), ['wsUrl'])

  const blank = validateConfig(SCHEMA, { wsUrl: '   ' })
  assert.equal(blank.ok, false, '空白字符串不该被当成填好了')
})

test('config：类型转换——数字接受字符串，布尔接受常见写法', () => {
  const r = validateConfig(SCHEMA, { wsUrl: 'ws://127.0.0.1:3001', selfId: '12345', quiet: 'true' })
  assert.equal(r.ok, true, JSON.stringify(r.errors))
  assert.equal(r.value.selfId, 12345)
  assert.equal(typeof r.value.selfId, 'number')
  assert.equal(r.value.quiet, true)

  assert.equal(validateConfig(SCHEMA, { wsUrl: 'x', quiet: '0' }).value.quiet, false)
})

test('config：数字填成非数字要明确报错，不静默变 NaN', () => {
  const r = validateConfig(SCHEMA, { wsUrl: 'ws://x', selfId: 'abc' })
  assert.equal(r.ok, false)
  assert.match(r.errors[0].message, /不是合法数字/)
})

test('config：枚举只能填列出的值', () => {
  assert.equal(validateConfig(SCHEMA, { wsUrl: 'x', mode: 'whitelist' }).ok, true)
  const bad = validateConfig(SCHEMA, { wsUrl: 'x', mode: 'whatever' })
  assert.equal(bad.ok, false)
  assert.match(bad.errors[0].message, /whitelist \/ blacklist/)
})

test('config：可选项没填就不写进结果，也不塞空串', () => {
  const r = validateConfig(SCHEMA, { wsUrl: 'ws://x', sessdata: '' })
  assert.equal(r.ok, true)
  assert.equal('sessdata' in r.value, false, '空值不该变成空串写进配置')

  // 有 default 的可选项，没填就用默认值
  assert.equal(r.value.retries, 3)
})

test('config：未声明的字段被丢掉，并如实报告（不然用户以为存上了）', () => {
  const r = validateConfig(SCHEMA, { wsUrl: 'ws://x', 乱写的字段: 1 })
  assert.deepEqual(r.unknown, ['乱写的字段'])
  assert.equal('乱写的字段' in r.value, false)
})

test('config：schema 里的子集外关键字被标出来，不假装支持', () => {
  const r = validateConfig(
    { type: 'object', properties: { a: { type: 'string', pattern: '^x$' } }, oneOf: [] },
    { a: 'y' },
  )
  assert.ok(r.unsupported.some((x) => x.includes('oneOf') || x === 'oneOf'))
  assert.ok(r.unsupported.some((x) => x.includes('pattern')))
})

test('config：没有 schema 时不校验，原样收下', () => {
  const r = validateConfig(null, { anything: 1 })
  assert.equal(r.ok, true)
  assert.deepEqual(r.value, { anything: 1 })
})

test('config：describeFields 给页面用的元信息（类型/必填/枚举/密码框）', () => {
  const fields = describeFields(SCHEMA)
  const byKey = Object.fromEntries(fields.map((f) => [f.key, f]))
  assert.equal(byKey.wsUrl.required, true)
  assert.equal(byKey.selfId.type, 'number')
  assert.deepEqual(byKey.mode.enum, ['whitelist', 'blacklist'])
  assert.equal(byKey.quiet.type, 'boolean')
  assert.equal(byKey.sessdata.secret, true, '名字像密钥的要用密码框')
  assert.equal(byKey.wsUrl.secret, false)
})

// ── 接口 ────────────────────────────────────────────────────────────────

test('API：保存配置 → 落盘 → 详情里能读回来', () => {
  const root = withModule()
  const r = handleApiWrite(root, u('/api/modules/config'), {
    id: 'demo',
    config: { wsUrl: 'ws://127.0.0.1:3001', selfId: '777' },
  })
  assert.equal(r.status, 200, JSON.stringify(r.body))
  assert.equal(r.body.config.selfId, 777)

  const onDisk = readModuleConfig(root, 'demo')
  assert.equal(onDisk.wsUrl, 'ws://127.0.0.1:3001')
  assert.equal(onDisk.selfId, 777)

  const detail = moduleDetail(root, 'demo')
  assert.equal(detail.config.selfId, 777)
  assert.ok(Array.isArray(detail.configFields) && detail.configFields.length >= 5, '详情要带字段元信息')
})

test('API：配置不合 schema 时 400，且不动磁盘上已有的值', () => {
  const root = withModule()
  writeModuleConfig(root, 'demo', { wsUrl: 'ws://old', selfId: 1 })

  const r = handleApiWrite(root, u('/api/modules/config'), { id: 'demo', config: { selfId: 'x' } })
  assert.equal(r.status, 400)
  assert.ok(r.body.errors.some((e) => e.field === 'wsUrl'), '要指出缺了哪个必填')
  assert.equal(readModuleConfig(root, 'demo').wsUrl, 'ws://old', '失败不该覆盖旧配置')
})

test('API：没装过的模块给 404；缺 id 给 400', () => {
  const root = withModule()
  assert.equal(handleApiWrite(root, u('/api/modules/config'), { id: 'nope', config: {} }).status, 404)
  assert.equal(handleApiWrite(root, u('/api/modules/config'), { config: {} }).status, 400)
})

// ── 重启语义 ────────────────────────────────────────────────────────────

test('kick：配置变更要求重启（restart 标志透传给宿主）', async () => {
  const calls = []
  const notify = async (id, opts) => {
    calls.push({ id, opts })
    return { restarted: true }
  }

  const r = await kickModule({ ok: true, id: 'demo' }, notify, { restart: true })
  assert.deepEqual(calls, [{ id: 'demo', opts: { restart: true } }])
  assert.deepEqual(r.runtime, { restarted: true })
})

test('kick：安装/授予只要确保在跑（不带 restart）', async () => {
  const calls = []
  const r = await kickModule({ ok: true, id: 'demo' }, async (id, opts) => {
    calls.push({ id, opts })
    return { started: true }
  })
  assert.deepEqual(calls, [{ id: 'demo', opts: {} }])
  assert.deepEqual(r.runtime, { started: true })
})

test('kick：宿主没起来 / 抛错时，写操作本身仍然算成功', async () => {
  const noHost = await kickModule({ ok: true, id: 'demo' }, null)
  assert.equal(noHost.ok, true)
  assert.equal(noHost.runtime, undefined)

  const boom = await kickModule({ ok: true, id: 'demo' }, async () => {
    throw new Error('spawn EPERM')
  })
  assert.equal(boom.ok, true, '启动失败不该让"保存配置"变成失败')
  assert.match(boom.runtime.error, /EPERM/)
})

test('kick：失败的写操作不触发启动', async () => {
  let called = false
  const r = await kickModule({ ok: false, error: 'x' }, async () => {
    called = true
  })
  assert.equal(called, false)
  assert.equal(r.ok, false)
})
