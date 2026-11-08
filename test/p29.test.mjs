// test/p29.test.mjs —— 模块门面：能力门控、持久停用、导出 tgz。
//
// 重点验三件"错了会很难查"的事：
//   ① 没授予的能力，模块发请求必须被拒（E_NO_CAP）——协议 §1 的硬边界靠这里守住；
//   ② 停用是**持久**的（enabled 写注册表），不是只停本次；
//   ③ 导出的 tgz 能被自己的 untar 解回来（否则"导出"等于丢文件）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import zlib from 'node:zlib'

import { scaffold } from '../src/core/scaffold.js'
import { ModuleService, readModuleConfig, writeModuleConfig, tailModuleLog, appendModuleLog } from '../src/core/modules/service.js'
import { installFromBytes } from '../src/core/modules/installer.js'
import { readRegistry } from '../src/core/modules/registry.js'
import { untar, stripPackagePrefix } from '../src/core/modules/untar.js'

function tmpRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'yuanling-p29-'))
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
  version: '1.0.0',
  api: '1.0',
  kind: 'gateway',
  entry: { command: ['node', 'index.mjs'] },
  capabilities: ['ingest.message', 'send'],
}

function pkg(extra = {}) {
  return makeTar({
    'yuanling.module.json': JSON.stringify(MANIFEST, null, 2),
    'index.mjs': 'export default {}',
    ...extra,
  })
}

function withModule() {
  const root = tmpRoot()
  installFromBytes({ root, bytes: pkg(), repo: 'https://x', source: 'github' })
  const svc = new ModuleService({ root })
  return { root, svc }
}

// ── 列表与详情 ──────────────────────────────────────────────────────────

test('service：空注册表时列表为空、摘要是 0', () => {
  const root = tmpRoot()
  const svc = new ModuleService({ root })
  assert.deepEqual(svc.list(), [])
  assert.equal(svc.summary().total, 0)
})

test('service：装上之后列表能反映版本/源/能力', () => {
  const { svc } = withModule()
  const list = svc.list()
  assert.equal(list.length, 1)
  assert.equal(list[0].id, 'demo')
  assert.equal(list[0].version, '1.0.0')
  assert.equal(list[0].source, 'github')
  assert.deepEqual(list[0].granted, ['ingest.message', 'send'])
  assert.equal(list[0].enabled, true)
})

test('service：详情带 config 与日志尾巴', () => {
  const { root, svc } = withModule()
  writeModuleConfig(root, 'demo', { hello: 1 })
  appendModuleLog(root, 'demo', '一条日志')
  const d = svc.detail('demo')
  assert.deepEqual(d.config, { hello: 1 })
  assert.ok(d.log.some((l) => l.includes('一条日志')))
  assert.equal(svc.detail('nope'), null)
})

// ── 能力门控（最要紧的一条）─────────────────────────────────────────────

test('service：ingest 单批超过 100 条 → E_BATCH（不静默截断）', async () => {
  const root = tmpRoot()
  installFromBytes({ root, bytes: pkg() })
  const svc = new ModuleService({ root, onIngest: () => ({ accepted: 0 }) })

  const items = Array.from({ length: 101 }, (_, i) => ({ text: `m${i}` }))
  await assert.rejects(
    svc.handleModuleRequest('demo', { op: 'ingest', data: { items } }),
    (e) => e.code === 'E_BATCH',
  )

  // 恰好 100 条应当通过
  const ok = await svc.handleModuleRequest('demo', { op: 'ingest', data: { items: items.slice(0, 100) } })
  assert.equal(ok.accepted, 0)
})

test('service：log.data 超过 4KB 会被截断并标记', async () => {
  const root = tmpRoot()
  installFromBytes({ root, bytes: pkg() })
  const svc = new ModuleService({ root })

  await svc.handleModuleRequest('demo', {
    op: 'log',
    data: { level: 'warn', event: 'big', data: { blob: 'x'.repeat(10000) } },
  })

  const line = tailModuleLog(root, 'demo').find((l) => l.includes('big'))
  assert.ok(line, '要有这条日志')
  assert.match(line, /truncated/, '超限要打标记')
  assert.ok(line.length < 10000, '不该原样写进去')
})

test('service：没授予的能力，模块请求被拒（E_NO_CAP）', async () => {
  const { root, svc } = withModule()
  svc.grant('demo', 'send', false)

  await assert.rejects(svc.handleModuleRequest('demo', { op: 'send', data: {} }), (e) => e.code === 'E_NO_CAP')
})

test('service：授予了但核心没接处理器时明确报错（不假装成功）', async () => {
  const { svc } = withModule()
  await assert.rejects(svc.handleModuleRequest('demo', { op: 'ingest', data: {} }), /未配置 ingest 处理器/)
})

test('service：接了处理器就能收到 ingest', async () => {
  const root = tmpRoot()
  installFromBytes({ root, bytes: pkg() })
  const seen = []
  const svc = new ModuleService({ root, onIngest: ({ id, data }) => { seen.push({ id, data }); return { accepted: 1 } } })
  const r = await svc.handleModuleRequest('demo', { op: 'ingest', data: { items: [{ text: 'x' }] } })
  assert.equal(r.accepted, 1)
  assert.equal(seen[0].id, 'demo')
})

test('service：config.get 直接回核心存的配置', async () => {
  const { root, svc } = withModule()
  writeModuleConfig(root, 'demo', { mode: 'whitelist' })
  const cfg = await svc.handleModuleRequest('demo', { op: 'config.get', data: {} })
  assert.equal(cfg.mode, 'whitelist')
})

test('service：log op 落盘，不返回错误', async () => {
  const { root, svc } = withModule()
  const r = await svc.handleModuleRequest('demo', { op: 'log', data: { level: 'warn', event: 'x', data: { a: 1 } } })
  assert.deepEqual(r, {})
  assert.ok(tailModuleLog(root, 'demo').some((l) => l.includes('warn')))
})

test('service：send 在模块没运行时明确报错', async () => {
  const { svc } = withModule()
  await assert.rejects(svc.send('demo', { text: 'hi' }), /模块未运行/)
})

// ── 停用是持久的 ────────────────────────────────────────────────────────

test('service：setEnabled(false) 写进注册表，重启也不起（持久）', async () => {
  const { root, svc } = withModule()
  svc.setEnabled('demo', false)

  const reg = readRegistry(root)
  assert.equal(reg.modules.demo.enabled, false, '注册表要记下来')

  // 模拟"重启"：新建一个 service，startEnabled 不该拉起它
  const svc2 = new ModuleService({ root })
  const r = await svc2.startEnabled()
  assert.deepEqual(r, [], '停用的模块不该被拉起')
})

test('service：setEnabled(true) 之后恢复启用', () => {
  const { root, svc } = withModule()
  svc.setEnabled('demo', false)
  svc.setEnabled('demo', true)
  assert.equal(readRegistry(root).modules.demo.enabled, true)
})

test('service：没装过的模块，停用/授予都报错', () => {
  const { svc } = withModule()
  assert.throws(() => svc.setEnabled('nope', false), /没有这个模块/)
  assert.throws(() => svc.grant('nope', 'send', true), /没有这个模块/)
})

// ── 导出（用户要求的功能）───────────────────────────────────────────────

test('service：导出的 tgz 能解回原文件，且带 sha256', () => {
  const { root, svc } = withModule()
  const r = svc.exportModule('demo')

  assert.ok(fs.existsSync(r.path), '文件要真的写出来')
  assert.ok(r.path.includes('system'), '落在 system/exports 下')
  assert.match(r.path, /demo-1\.0\.0\.tgz/)
  assert.equal(r.sha256.length, 64)

  const back = untar(fs.readFileSync(r.path))
  const files = stripPackagePrefix(back.entries)
  const names = files.map((e) => e.name).sort()
  assert.ok(names.includes('index.mjs'))
  assert.ok(names.includes('yuanling.module.json'))

  const mf = files.find((e) => e.name === 'yuanling.module.json')
  assert.equal(JSON.parse(mf.data.toString('utf8')).id, 'demo', '内容要完整')
})

test('service：导出的包能被 installFromBytes 再装回来（换机器可用）', () => {
  const { root, svc } = withModule()
  const r = svc.exportModule('demo')

  // 换一个干净的数据目录
  const root2 = tmpRoot()
  const bytes = fs.readFileSync(r.path)
  const re = installFromBytes({ root: root2, bytes, repo: 'exported://demo', source: 'manual' })
  assert.equal(re.manifest.id, 'demo')
  assert.equal(re.sha256, r.sha256, '导出再装，哈希应当一致')
})

test('service：没装的模块不能导出', () => {
  const root = tmpRoot()
  const svc = new ModuleService({ root })
  assert.throws(() => svc.exportModule('nope'), /没有这个模块/)
})
