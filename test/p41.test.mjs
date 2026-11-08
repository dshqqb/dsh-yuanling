// test/p41.test.mjs —— 两件事：`records` 型 tab（核心代查）与「检查更新」。
//
// records 的设计要点：**数据不经过模块**。像"点赞记录"这种页，记录本来就在原始层，
// 让模块再读出来返回就等于让它读 raw（违反第一硬边界）。所以方向反过来：
// 模块只声明要什么，核心查自己的账本，并**强制按模块 id 过滤**。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import zlib from 'node:zlib'

import { scaffold } from '../src/core/scaffold.js'
import { installFromBytes, checkUpdate, compareVersions } from '../src/core/modules/installer.js'
import { validateManifest, summarizeErrors, UI_KINDS } from '../src/core/modules/manifest.js'
import { queryRecords, RECORD_TYPE_RE } from '../src/core/modules/records.js'
import { ModuleService } from '../src/core/modules/service.js'
import { handleModuleCheckUpdate } from '../src/core/api.js'
import { appendRecord, today } from '../src/core/raw.js'
import { writeRegistry, readRegistry } from '../src/core/modules/registry.js'

// ── 校验：records 声明 ──────────────────────────────────────────────────

test('ui：kind 增加 records', () => {
  assert.deepEqual(UI_KINDS, ['list', 'kv', 'text', 'config', 'records'])
})

test('ui：records 型必须给 {type}，limit 限 1~200', () => {
  const ok = validateManifest({
    id: 'demo',
    version: '0.1.0',
    api: '1.2',
    entry: { command: ['node', 'x.mjs'] },
    ui: { tabs: [{ id: 'likes', label: '点赞记录', kind: 'records', records: { type: 'like', limit: 50 } }] },
  })
  assert.equal(ok.ok, true, summarizeErrors(ok.errors))
  assert.deepEqual(ok.manifest.ui.tabs[0].records, { type: 'like', limit: 50 })

  const missing = validateManifest({
    id: 'demo',
    version: '0.1.0',
    api: '1.2',
    entry: { command: ['node', 'x.mjs'] },
    ui: { tabs: [{ id: 'likes', label: '点赞', kind: 'records' }] },
  })
  assert.equal(missing.ok, false)
  assert.match(summarizeErrors(missing.errors), /必须给 records/)

  const badType = validateManifest({
    id: 'demo',
    version: '0.1.0',
    api: '1.2',
    entry: { command: ['node', 'x.mjs'] },
    ui: { tabs: [{ id: 'likes', label: '点赞', kind: 'records', records: { type: 'Like Me' } }] },
  })
  assert.equal(badType.ok, false)

  const badLimit = validateManifest({
    id: 'demo',
    version: '0.1.0',
    api: '1.2',
    entry: { command: ['node', 'x.mjs'] },
    ui: { tabs: [{ id: 'likes', label: '点赞', kind: 'records', records: { type: 'like', limit: 999 } }] },
  })
  assert.equal(badLimit.ok, false)
})

// ── 查询层 ──────────────────────────────────────────────────────────────

function tmpRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'yuanling-p41-'))
  scaffold(root, {})
  return root
}

let seq = 0
function addRecord(root, { source = 'bili', type = 'like', text = null, ts = null } = {}) {
  seq += 1
  return appendRecord(root, {
    source,
    type,
    channel: 'bili:like',
    actor: { kind: 'system', id: '', name: 'B站' },
    text: text ?? `点赞了第 ${seq} 条`,
    ts: ts ?? `${today(new Date())}T10:00:00+08:00`,
  })
}

test('records：只返回指定模块 + 指定类型的记录', () => {
  const root = tmpRoot()
  addRecord(root, { type: 'like', text: '点赞了视频 A' })
  addRecord(root, { type: 'like', text: '点赞了评论 B' })
  addRecord(root, { type: 'comment', text: '这条不是点赞' })
  addRecord(root, { source: 'qq', type: 'like', text: '别的模块的记录' })

  const r = queryRecords(root, { module: 'bili', type: 'like' })
  assert.equal(r.items.length, 2)
  assert.ok(r.items.every((i) => i.title.startsWith('点赞了')))
})

test('records：别的模块的记录绝对看不见（核心强制按 source 过滤）', () => {
  const root = tmpRoot()
  addRecord(root, { source: 'qq', type: 'like', text: 'QQ 那边的 like' })
  const r = queryRecords(root, { module: 'bili', type: 'like' })
  assert.equal(r.items.length, 0, '模块不能借 records 页看别人的账本')
})

test('records：最新在前，带指针', () => {
  const root = tmpRoot()
  addRecord(root, { ts: '2026-11-01T10:00:00+08:00', text: '早的' })
  addRecord(root, { ts: '2026-11-05T10:00:00+08:00', text: '晚的' })
  const r = queryRecords(root, { module: 'bili', type: 'like' })
  assert.equal(r.items[0].title, '晚的')
  assert.match(r.items[0].ptr, /^raw\/\d{4}-\d{2}\/\d{2}\/bili\.ndjson#/)
})

test('records：limit 生效并标 truncated', () => {
  const root = tmpRoot()
  for (let i = 0; i < 5; i += 1) addRecord(root, { text: `第 ${i} 条` })
  const r = queryRecords(root, { module: 'bili', type: 'like', limit: 2 })
  assert.equal(r.items.length, 2)
  assert.equal(r.truncated, true)
})

test('records：type 不合法直接拒（防止模块拿它当通配符乱查）', () => {
  const root = tmpRoot()
  assert.throws(() => queryRecords(root, { module: 'bili', type: '*' }), (e) => e.code === 'E_BAD_REQUEST')
  assert.throws(() => queryRecords(root, { module: 'bili', type: '' }), (e) => e.code === 'E_BAD_REQUEST')
  assert.equal(RECORD_TYPE_RE.test('like'), true)
  assert.equal(RECORD_TYPE_RE.test('comment.reply'), true)
})

test('records：坏行不影响查询', () => {
  const root = tmpRoot()
  addRecord(root, { text: '好记录' })
  const day = today(new Date())
  const dir = path.join(root, 'raw', day.slice(0, 7), day.slice(8, 10))
  fs.appendFileSync(path.join(dir, 'bili.ndjson'), '{"坏 JSON"\n')
  const r = queryRecords(root, { module: 'bili', type: 'like' })
  assert.equal(r.items.length, 1)
})

// ── service：records tab 不需要模块进程 ─────────────────────────────────

const MANIFEST = {
  id: 'demo',
  name: '演示',
  version: '0.1.0',
  api: '1.2',
  kind: 'enricher',
  entry: { command: ['node', 'index.mjs'] },
  ui: { tabs: [{ id: 'likes', label: '点赞记录', kind: 'records', records: { type: 'like', limit: 20 } }] },
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

function withModule() {
  const root = tmpRoot()
  installFromBytes({
    root,
    bytes: makeTar({ 'yuanling.module.json': JSON.stringify(MANIFEST, null, 2), 'index.mjs': 'export default {}' }),
    source: 'test',
  })
  return root
}

test('service：records tab 在模块停用时照样能看（记录在核心这边）', async () => {
  const root = withModule()
  addRecord(root, { source: 'demo', type: 'like', text: '她点赞了一条' })
  const svc = new ModuleService({ root })
  const r = await svc.uiGet('demo', 'likes')
  assert.equal(r.kind, 'records')
  assert.equal(r.items.length, 1)
  assert.equal(r.items[0].title, '她点赞了一条')
})

// ── 检查更新 ────────────────────────────────────────────────────────────

test('更新：版本比较', () => {
  assert.equal(compareVersions('0.1.1', '0.1.0'), 1)
  assert.equal(compareVersions('v0.1.0', '0.1.0'), 0)
  assert.equal(compareVersions('0.2.0', '0.10.0'), -1, '按数字比，不按字符串比')
  assert.equal(compareVersions('乱写', '0.1.0'), 0, '解析不了就不提示更新（保守）')
})

function fakeReleases(list) {
  return async () => ({ ok: true, status: 200, json: async () => list })
}

test('更新：有新版时 hasUpdate=true，并给出资产地址', async () => {
  const r = await checkUpdate('https://gitee.com/o/r', '0.1.0', {
    fetchImpl: fakeReleases([
      {
        tag_name: 'v0.1.1',
        created_at: '2026-11-09T00:00:00Z',
        prerelease: false,
        assets: [{ name: 'bili-0.1.1.tgz', browser_download_url: 'https://g/bili-0.1.1.tgz' }],
      },
    ]),
  })
  assert.equal(r.hasUpdate, true)
  assert.equal(r.latest, 'v0.1.1')
  assert.equal(r.assetName, 'bili-0.1.1.tgz')
  assert.match(r.tgzUrl, /bili-0\.1\.1\.tgz$/)
})

test('更新：同版本不算更新；预发布不提示', async () => {
  const same = await checkUpdate('https://gitee.com/o/r', '0.1.1', {
    fetchImpl: fakeReleases([{ tag_name: 'v0.1.1', assets: [{ name: 'a.tgz', browser_download_url: 'https://g/a.tgz' }] }]),
  })
  assert.equal(same.hasUpdate, false)

  const pre = await checkUpdate('https://gitee.com/o/r', '0.1.0', {
    fetchImpl: fakeReleases([
      { tag_name: 'v0.2.0-rc', prerelease: true, assets: [{ name: 'a.tgz', browser_download_url: 'https://g/a.tgz' }] },
      { tag_name: 'v0.1.0', assets: [{ name: 'a.tgz', browser_download_url: 'https://g/a.tgz' }] },
    ]),
  })
  assert.equal(pre.hasUpdate, false, '不该拿预发布版催人更新')
})

test('更新：库没有发行版时 hasUpdate=false，不报错', async () => {
  const r = await checkUpdate('https://gitee.com/o/r', '0.1.0', { fetchImpl: fakeReleases([]) })
  assert.equal(r.hasUpdate, false)
  assert.equal(r.latest, null)
})

test('更新：API —— 本地装的模块明确说"查不了"，不假装最新', async () => {
  const root = withModule()
  const reg = readRegistry(root)
  reg.modules.demo.repo = null
  writeRegistry(root, reg)

  const r = await handleModuleCheckUpdate(root, { id: 'demo' })
  assert.equal(r.status, 400)
  assert.match(r.body.error, /不是从库安装/)
})

test('更新：API —— 有 repo 时走 checkUpdate', async () => {
  const root = withModule()
  const reg = readRegistry(root)
  reg.modules.demo.repo = 'https://gitee.com/o/r'
  writeRegistry(root, reg)

  const r = await handleModuleCheckUpdate(
    root,
    { id: 'demo' },
    {
      fetchImpl: fakeReleases([
        { tag_name: 'v0.2.0', assets: [{ name: 'demo-0.2.0.tgz', browser_download_url: 'https://g/demo-0.2.0.tgz' }] },
      ]),
    },
  )
  assert.equal(r.status, 200)
  assert.equal(r.body.hasUpdate, true)
  assert.equal(r.body.latest, 'v0.2.0')
})
