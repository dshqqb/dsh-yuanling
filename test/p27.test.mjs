// test/p27.test.mjs —— 模块宿主之二：注册表 + 安装器（从包字节到落盘）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import zlib from 'node:zlib'

import { scaffold } from '../src/core/scaffold.js'
import {
  readRegistry,
  writeRegistry,
  makeEntry,
  mergeGranted,
  setGranted,
  setGrantedAll,
  grantedOf,
  recordCrash,
  setState,
  conflictingRoutes,
} from '../src/core/modules/registry.js'
import {
  sha256Of,
  checkUrl,
  extractToDir,
  manifestFromEntries,
  installFromBytes,
  uninstall,
} from '../src/core/modules/installer.js'
import { untar } from '../src/core/modules/untar.js'
import { validateManifest } from '../src/core/modules/manifest.js'

const PID = 'yuanling'

function tmpRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'yuanling-p27-'))
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
    header.write('ustar', 257, 'utf8')
    blocks.push(header, data)
    const pad = (512 - (data.length % 512)) % 512
    if (pad) blocks.push(Buffer.alloc(pad))
  }
  blocks.push(Buffer.alloc(1024))
  return zlib.gzipSync(Buffer.concat(blocks))
}

const MANIFEST = {
  id: 'qq',
  version: '0.1.0',
  api: '1.0',
  kind: 'gateway',
  entry: { command: ['node', 'index.mjs'] },
  capabilities: ['ingest.message', 'send'],
}

function pkgBytes(manifest = MANIFEST, extra = {}) {
  return makeTar({
    'yuanling.module.json': JSON.stringify(manifest, null, 2),
    'index.mjs': 'export default {}',
    ...extra,
  })
}

// ── 注册表 ──────────────────────────────────────────────────────────────

test('registry：没有文件时给空表，不抛', () => {
  const root = tmpRoot()
  const reg = readRegistry(root)
  assert.deepEqual(reg.modules, {})
  assert.equal(reg.version, 1)
})

test('registry：坏了也给空表（不能因为注册表坏了就起不来）', () => {
  const root = tmpRoot()
  fs.writeFileSync(path.join(root, 'system', 'modules.json'), '{ not json')
  assert.deepEqual(readRegistry(root).modules, {})
})

test('registry：写入再读出，字段完整', () => {
  const root = tmpRoot()
  const reg = readRegistry(root)
  reg.modules.qq = makeEntry({ manifest: validateManifest(MANIFEST).manifest, repo: 'https://x', source: 'github' })
  writeRegistry(root, reg)

  const back = readRegistry(root)
  assert.equal(back.modules.qq.repo, 'https://x')
  assert.equal(back.modules.qq.source, 'github')
  assert.equal(back.modules.qq.enabled, true)
  assert.deepEqual(back.modules.qq.granted, [], 'v1.1：声明 ≠ 授予，装完是空授权')
})

test('registry：更新时保留既有授予，不偷偷扩权', () => {
  const got = mergeGranted(['ingest.message'], ['ingest.message', 'send'], { defaultGranted: false })
  assert.deepEqual(got, ['ingest.message'], '新能力默认不给，除非显式 defaultGranted')
})

test('registry：send 可以单独收回；没声明的能力不许授予', () => {
  // v1.1：makeEntry 默认空授权，先一次性授予再测收回
  const entry = setGrantedAll(makeEntry({ manifest: validateManifest(MANIFEST).manifest }), true)
  assert.deepEqual(grantedOf(entry), ['ingest.message', 'send'], '声明了就给得出来')

  const off = setGranted(entry, 'send', false)
  assert.deepEqual(grantedOf(off), ['ingest.message'])

  const again = setGranted(off, 'send', true)
  assert.deepEqual(grantedOf(again), ['ingest.message', 'send'])

  assert.throws(() => setGranted(entry, 'media.read', true), /没有声明/)
  assert.throws(() => setGranted(entry, 'presence', true), /未知能力/)
})

test('registry：崩溃记录与运行时状态', () => {
  const root = tmpRoot()
  const reg = readRegistry(root)
  reg.modules.qq = makeEntry({ manifest: validateManifest(MANIFEST).manifest })
  writeRegistry(root, reg)

  const crashed = recordCrash(root, 'qq', 'exit code 1')
  assert.equal(crashed.state, 'crashed')
  assert.match(crashed.last_crash.reason, /exit code 1/)

  const st = setState(root, 'qq', 'running')
  assert.equal(st.state, 'running')
})

test('registry：路由冲突能查出来', () => {
  const reg = { modules: { a: { routes: ['/a'] }, b: { routes: ['/b'] } } }
  assert.deepEqual(conflictingRoutes(reg, ['/b']), [{ id: 'b', route: '/b' }])
  assert.deepEqual(conflictingRoutes(reg, ['/b'], { ignoreId: 'b' }), [], '自己更新自己不算冲突')
})

// ── 安装器 ──────────────────────────────────────────────────────────────

test('installer：http 只允许本机，其它一律 https', () => {
  assert.equal(checkUrl('https://github.com/x').ok, true)
  assert.equal(checkUrl('http://127.0.0.1:8080/x').ok, true)
  assert.equal(checkUrl('http://example.com/x').ok, false)
  assert.match(checkUrl('http://example.com/x').reason, /https/)
  assert.equal(checkUrl('ftp://x').ok, false)
  assert.equal(checkUrl('不是url').ok, false)
})

test('installer：sha256 不符就拒装', () => {
  const root = tmpRoot()
  const bytes = pkgBytes()
  assert.throws(() => installFromBytes({ root, bytes, expectSha256: 'deadbeef' }), /sha256 不符/)
})

test('installer：正常装上一个模块，目录与注册表都对', () => {
  const root = tmpRoot()
  const bytes = pkgBytes()
  const r = installFromBytes({ root, bytes, repo: 'https://x', source: 'github', expectSha256: sha256Of(bytes) })

  assert.equal(r.manifest.id, 'qq')
  assert.equal(r.sha256, sha256Of(bytes))

  const dir = path.join(root, 'system', 'modules', 'qq')
  assert.ok(fs.existsSync(path.join(dir, 'index.mjs')), '文件要落盘')
  assert.ok(fs.existsSync(path.join(dir, 'yuanling.mengin.json')) === false)
  assert.ok(fs.existsSync(path.join(dir, 'yuanling.module.json')))
  assert.ok(fs.existsSync(path.join(dir, 'VERSION')), '要记版本')

  const reg = readRegistry(root)
  assert.equal(reg.modules.qq.version, '0.1.0')
  assert.equal(reg.modules.qq.repo, 'https://x')
})

test('installer：同名再装 = 更新，不新增条目', () => {
  const root = tmpRoot()
  installFromBytes({ root, bytes: pkgBytes(), repo: 'https://x' })
  const r2 = installFromBytes({
    root,
    bytes: pkgBytes({ ...MANIFEST, version: '0.2.0' }),
    repo: 'https://x',
  })
  assert.equal(r2.updated, true)

  const reg = readRegistry(root)
  assert.equal(Object.keys(reg.modules).length, 1, '还是只有一条')
  assert.equal(reg.modules.qq.version, '0.2.0')
})

test('installer：换源更新时留下 previousRepo（回滚线索）', () => {
  const root = tmpRoot()
  installFromBytes({ root, bytes: pkgBytes(), repo: 'https://github/x', source: 'github' })
  installFromBytes({ root, bytes: pkgBytes(), repo: 'https://gitee/x', source: 'gitee' })

  const reg = readRegistry(root)
  assert.equal(reg.modules.qq.repo, 'https://gitee/x')
  assert.equal(reg.modules.qq.source, 'gitee')
  assert.equal(reg.modules.qq.previousRepo, 'https://github/x')
})

test('installer：manifest 坏了就不落盘（宁可装不上，不要装一半）', () => {
  const root = tmpRoot()
  const bad = pkgBytes({ ...MANIFEST, capabilities: ['presence'] })
  assert.throws(() => installFromBytes({ root, bytes: bad }), /manifest 校验失败/)
  assert.ok(!fs.existsSync(path.join(root, 'system', 'modules', 'qq')), '目录不该被创建')
  assert.deepEqual(readRegistry(root).modules, {})
})

test('installer：dryRun 只校验不落盘', () => {
  const root = tmpRoot()
  const r = installFromBytes({ root, bytes: pkgBytes(), dryRun: true })
  assert.equal(r.manifest.id, 'qq')
  assert.ok(!fs.existsSync(path.join(root, 'system', 'modules', 'qq')))
  assert.deepEqual(readRegistry(root).modules, {})
})

test('installer：包里缺 manifest 时明确报错', () => {
  const entries = untar(makeTar({ 'index.mjs': 'x' })).entries
  const r = manifestFromEntries(entries)
  assert.equal(r.ok, false)
  assert.match(r.errors[0].message, /没有 yuanling\.module\.json/)
})

test('installer：卸载删目录并摘条目', () => {
  const root = tmpRoot()
  installFromBytes({ root, bytes: pkgBytes() })
  uninstall(root, 'qq')
  assert.deepEqual(readRegistry(root).modules, {})
  assert.ok(!fs.existsSync(path.join(root, 'system', 'modules', 'qq')))
})

test('installer：卸载没装过的要报错', () => {
  const root = tmpRoot()
  assert.throws(() => uninstall(root, 'nope'), /没有装过模块/)
})

test('extractToDir：中途失败不留下半个模块', () => {
  const root = tmpRoot()
  const dest = path.join(root, 'system', 'modules', 'half')
  const entries = [
    { name: 'ok.txt', type: 'file', data: Buffer.from('ok') },
    { name: 'sub/bad.txt', type: 'file', data: Buffer.from('x') },
  ]
  // 第二次调用：先塞一个同名目录让它正常装
  extractToDir(entries, dest)
  assert.ok(fs.existsSync(path.join(dest, 'ok.txt')))

  // 造一个会抛的：目录类型里带非法名
  assert.throws(() => extractToDir([{ name: '../x.txt', type: 'file', data: Buffer.from('x') }], path.join(root, 'system', 'modules', 'evil')), /非法路径/)
  assert.ok(!fs.existsSync(path.join(root, 'system', 'modules', 'evil')))
  assert.ok(!fs.readdirSync(path.join(root, 'system', 'modules')).some((n) => n.includes('.installing-')), '临时目录要清理干净')
})
