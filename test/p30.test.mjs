// test/p30.test.mjs —— 管理台的模块视图（不持进程的那半）：列表 / 详情 / 授予 / 导出。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import zlib from 'node:zlib'

import { scaffold } from '../src/core/scaffold.js'
import { installFromBytes } from '../src/core/modules/installer.js'
import {
  listModules,
  moduleDetail,
  moduleSummary,
  setModuleGranted,
  setModuleEnabled,
  exportModule,
  tailModuleLog,
} from '../src/core/modules/manage.js'
import { readRegistry } from '../src/core/modules/registry.js'
import { untar, stripPackagePrefix } from '../src/core/modules/untar.js'
import { handleApi, handleApiWrite } from '../src/core/api.js'

function tmpRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'yuanling-p30-'))
  scaffold(root, {})
  return root
}

function makeTar(files) {
  const blocks = []
  for (const [name, content] of Object.entries(files)) {
    const data = Buffer.from(content)
    const header = Buffer.alloc(512)
    header.write(name, 0, 'utf8')
    header.write(data.length.toString(8).padStart(11, '0'), 124, 'utf8')
    header.write('0', 156, 'utf8')
    blocks.push(header, data)
    const pad = (512 - (data.length % 512)) % 512
    if (pad) blocks.push(Buffer.alloc(pad))
  }
  blocks.push(Buffer.alloc(1024))
  return zlib.gzipSync(Buffer.concat(blocks))
}

const MANIFEST = {
  id: 'demo',
  name: '演示模块',
  description: '给测试用的模块',
  version: '1.0.0',
  api: '1.0',
  kind: 'gateway',
  entry: { command: ['node', 'index.mjs'] },
  capabilities: ['ingest.message', 'send'],
}

function withModule() {
  const root = tmpRoot()
  installFromBytes({
    root,
    bytes: makeTar({
      'yuanling.module.json': JSON.stringify(MANIFEST, null, 2),
      'index.mjs': 'export default {}',
    }),
    repo: 'https://x',
    source: 'gitee',
  })
  return root
}

test('manage：列表带 name/description/source/能力/授予', () => {
  const root = withModule()
  const list = listModules(root)
  assert.equal(list.length, 1)
  assert.equal(list[0].name, '演示模块')
  assert.equal(list[0].description, '给测试用的模块')
  assert.equal(list[0].source, 'gitee')
  assert.deepEqual(list[0].granted, ['ingest.message', 'send'])
  assert.equal(list[0].enabled, true)
})

test('manage：摘要把 crashed/disabled 分开数', () => {
  const root = withModule()
  assert.equal(moduleSummary(root).total, 1)
  assert.equal(moduleSummary(root).crashed, 0)

  setModuleEnabled(root, 'demo', false)
  assert.equal(moduleSummary(root).disabled, 1)
})

test('manage：详情带 config、schema、日志尾巴', () => {
  const root = withModule()
  fs.writeFileSync(
    path.join(root, 'system', 'modules', 'demo', 'config.json'),
    JSON.stringify({ mode: 'whitelist' }),
  )
  const d = moduleDetail(root, 'demo')
  assert.equal(d.config.mode, 'whitelist')
  assert.equal(d.configSchema, null, 'manifest 没写 schema 就该是 null')
  assert.deepEqual(d.log, [])
  assert.equal(d.permissions.length, 0)
})

test('manage：日志能读到（页面右下角那块）', () => {
  const root = withModule()
  const p = path.join(root, 'system', 'log', 'modules', 'demo.log')
  fs.mkdirSync(path.dirname(p), { recursive: true })
  fs.writeFileSync(p, 'line1\nline2\nline3\n')
  assert.deepEqual(tailModuleLog(root, 'demo', { lines: 2 }), ['line2', 'line3'])
})

test('manage：授予与收回（send 可以单独关）', () => {
  const root = withModule()
  const r = setModuleGranted(root, 'demo', 'send', false)
  assert.deepEqual(r.granted, ['ingest.message'])

  const back = setModuleGranted(root, 'demo', 'send', true)
  assert.deepEqual(back.granted, ['ingest.message', 'send'])

  assert.throws(() => setModuleGranted(root, 'demo', 'presence', true), /未知能力/)
})

test('manage：停用写进注册表（持久）', () => {
  const root = withModule()
  setModuleEnabled(root, 'demo', false)
  assert.equal(readRegistry(root).modules.demo.enabled, false)
})

test('manage：导出 tgz 可解回、可再装（往返一致）', () => {
  const root = withModule()
  const r = exportModule(root, 'demo')
  assert.ok(fs.existsSync(r.path))
  assert.equal(r.sha256.length, 64)

  const files = stripPackagePrefix(untar(fs.readFileSync(r.path)).entries)
  assert.ok(files.some((e) => e.name === 'yuanling.module.json'))
  assert.ok(files.some((e) => e.name === 'index.mjs'))

  const root2 = tmpRoot()
  const re = installFromBytes({ root: root2, bytes: fs.readFileSync(r.path), source: 'manual' })
  assert.equal(re.manifest.id, 'demo')
  assert.equal(re.sha256, r.sha256)
})

test('manage：导出落在 system/exports 下', () => {
  const root = withModule()
  const r = exportModule(root, 'demo')
  assert.ok(r.path.includes('exports'))
  assert.match(r.path, /demo-1\.0\.0\.tgz/)
})

// ── HTTP 层 ────────────────────────────────────────────────────────────

test('API：GET /api/modules 返回列表与摘要', () => {
  const root = withModule()
  const r = handleApi(root, u('/api/modules'))
  assert.equal(r.status, 200)
  assert.equal(r.body.modules.length, 1)
  assert.equal(r.body.summary.total, 1)
})

test('API：GET /api/module?id= 返回详情，缺 id 是 400，找不到是 404', () => {
  const root = withModule()

  const ok = handleApi(root, u('/api/module?id=demo'))
  assert.equal(ok.status, 200)
  assert.equal(ok.body.module.id, 'demo')

  const bad = handleApi(root, u('/api/module'))
  assert.equal(bad.status, 400)

  const missing = handleApi(root, u('/api/module?id=nope'))
  assert.equal(missing.status, 404)
})
// handleApi/handleApiWrite 收的是 URL 对象（server.js 解析好再传进来），
// 传字符串会拿到 undefined.pathname 并一路 404 —— 踩过。
const u = (p) => new URL(p, 'http://127.0.0.1')

test('API 写：授予/停用/卸载 都走 handleApiWrite', () => {
  const root = withModule()

  const g = handleApiWrite(root, u('/api/modules/grant'), { id: 'demo', capability: 'send', granted: false })
  assert.equal(g.status, 200)
  assert.deepEqual(g.body.granted, ['ingest.message'])

  const e = handleApiWrite(root, u('/api/modules/enable'), { id: 'demo', enabled: false })
  assert.equal(e.status, 200)
  assert.equal(readRegistry(root).modules.demo.enabled, false)

  const x = handleApiWrite(root, u('/api/modules/export'), { id: 'demo' })
  assert.equal(x.status, 200)
  assert.ok(fs.existsSync(x.body.path))

  const un = handleApiWrite(root, u('/api/modules/uninstall'), { id: 'demo' })
  assert.equal(un.status, 200)
  assert.deepEqual(readRegistry(root).modules, {})
})

test('API 写：install 缺 file 时给可读错误（不是让你自己猜）', () => {
  const root = tmpRoot()
  const r = handleApiWrite(root, u('/api/modules/install'), {})
  assert.equal(r.status, 400)
  assert.match(r.body.error, /yuanling module install --url/)
})

test('API 写：install 从本地 tgz 装上（管理台路径）', () => {
  const root = tmpRoot()
  const tgz = path.join(root, 'demo.tgz')
  fs.writeFileSync(
    tgz,
    makeTar({
      'yuanling.module.json': JSON.stringify(MANIFEST, null, 2),
      'index.mjs': 'export default {}',
    }),
  )
  const r = handleApiWrite(root, u('/api/modules/install'), { file: tgz, source: 'manual', repo: 'local' })
  assert.equal(r.status, 200)
  assert.equal(r.body.id, 'demo')
  assert.equal(listModules(root).length, 1)
})
