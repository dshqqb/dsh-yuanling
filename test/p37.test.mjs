// test/p37.test.mjs —— 模块自定义 tab（协议 v1.2 的 ui.tabs / ui.get）。
//
// 这层的风险不在"能不能显示"，而在**边界**：
//   · 模块只能给三种纯数据形状，给不了 HTML/JS（管理台握着 token，这条线不能松）；
//   · 不能占核心的两个 tab（概况 / 日志）；
//   · 数据无限大会把页面和日志拖死，所以必须限幅。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import zlib from 'node:zlib'

import { validateManifest, summarizeErrors, UI_MAX_TABS, UI_KINDS } from '../src/core/modules/manifest.js'
import { normalizeUiPayload, UI_LIMITS } from '../src/core/modules/ui.js'
import { ModuleService } from '../src/core/modules/service.js'
import { moduleDetail, setModuleGrantedAll } from '../src/core/modules/manage.js'
import { scaffold } from '../src/core/scaffold.js'
import { installFromBytes } from '../src/core/modules/installer.js'
import { handleModuleUi } from '../src/core/api.js'

const GOOD = {
  id: 'demo',
  version: '0.1.0',
  api: '1.2',
  entry: { command: ['node', 'x.mjs'] },
}

function withUi(tabs, over = {}) {
  return { ...GOOD, ...over, ui: { tabs } }
}

// ── manifest ────────────────────────────────────────────────────────────

test('ui：正常声明通过，字段被规整', () => {
  const r = validateManifest(withUi([{ id: 'stats', label: '统计', kind: 'kv' }]))
  assert.equal(r.ok, true, summarizeErrors(r.errors))
  assert.deepEqual(r.manifest.ui.tabs, [{ id: 'stats', label: '统计', kind: 'kv' }])
  assert.deepEqual(UI_KINDS, ['list', 'kv', 'text'])
})

test('ui：声明 ui 就必须 api ≥ 1.2', () => {
  const r = validateManifest(withUi([{ id: 'stats', label: '统计', kind: 'kv' }], { api: '1.1' }))
  assert.equal(r.ok, false)
  assert.match(summarizeErrors(r.errors), /api "1\.2"/)
})

test('ui：核心的 tab id / 名字不许占用', () => {
  const bad = validateManifest(withUi([{ id: 'log', label: '我的日志', kind: 'text' }]))
  assert.equal(bad.ok, false)
  assert.match(summarizeErrors(bad.errors), /保留/)

  const bad2 = validateManifest(withUi([{ id: 'mine', label: '概况', kind: 'text' }]))
  assert.equal(bad2.ok, false)
  assert.match(summarizeErrors(bad2.errors), /核心的 tab 名/)
})

test('ui：kind 只认三种，不能自带 html', () => {
  for (const kind of ['html', 'script', 'form']) {
    const r = validateManifest(withUi([{ id: 'x1', label: 'X', kind }]))
    assert.equal(r.ok, false, `${kind} 不该通过`)
  }
  const ok = validateManifest(withUi([{ id: 'x1', label: 'X' }]))
  assert.equal(ok.ok, true)
  assert.equal(ok.manifest.ui.tabs[0].kind, 'text', '不写 kind 默认 text')
})

test('ui：tab 数量、id 格式、label 长度、重复都要卡', () => {
  assert.equal(UI_MAX_TABS, 5)
  const many = Array.from({ length: UI_MAX_TABS + 1 }, (_, i) => ({ id: `t${i}`, label: `T${i}`, kind: 'text' }))
  assert.match(summarizeErrors(validateManifest(withUi(many)).errors), /最多 5 个/)

  assert.equal(validateManifest(withUi([{ id: 'Bad_Id', label: 'X' }])).ok, false)
  assert.equal(validateManifest(withUi([{ id: 'ok', label: '超'.repeat(17) }])).ok, false)
  assert.match(
    summarizeErrors(validateManifest(withUi([{ id: 'ok', label: 'X' }, { id: 'ok', label: 'Y' }])).errors),
    /重复/,
  )
})

test('ui：不声明 ui 就是没有 tab（老模块不受影响）', () => {
  const r = validateManifest({ ...GOOD, api: '1.1' })
  assert.equal(r.ok, true)
  assert.equal(r.manifest.ui, null)
})

// ── 数据形状 ────────────────────────────────────────────────────────────

test('ui数据：kv 接受对象或 [{k,v}]', () => {
  const a = normalizeUiPayload('kv', { 在线: '12', 队列: 3 })
  assert.equal(a.kind, 'kv')
  assert.deepEqual(a.rows, [
    { k: '在线', v: '12' },
    { k: '队列', v: '3' },
  ])

  const b = normalizeUiPayload('kv', [{ k: 'a', v: 1 }])
  assert.deepEqual(b.rows, [{ k: 'a', v: '1' }])
  assert.throws(() => normalizeUiPayload('kv', '不是对象'), /kv 类型/)
})

test('ui数据：list 接受 [{title,sub}] 或字符串数组', () => {
  const a = normalizeUiPayload('list', [{ title: '任务一', sub: '排队中' }, { title: '任务二' }])
  assert.deepEqual(a.items, [
    { title: '任务一', sub: '排队中' },
    { title: '任务二', sub: null },
  ])
  assert.deepEqual(normalizeUiPayload('list', ['甲', '乙']).items, [
    { title: '甲', sub: null },
    { title: '乙', sub: null },
  ])
  assert.throws(() => normalizeUiPayload('list', { a: 1 }), /list 类型/)
})

test('ui数据：text 接受字符串、数字、{text}', () => {
  assert.equal(normalizeUiPayload('text', '一段话').text, '一段话')
  assert.equal(normalizeUiPayload('text', 42).text, '42')
  assert.equal(normalizeUiPayload('text', { text: '包一层也行' }).text, '包一层也行')
  assert.equal(normalizeUiPayload('text', null).text, '')
  assert.throws(() => normalizeUiPayload('text', [1, 2]), /text 类型/)
})

test('ui数据：超量要截断并标记，不能把页面拖死', () => {
  const rows = Array.from({ length: UI_LIMITS.rows + 50 }, (_, i) => ({ k: `k${i}`, v: i }))
  const kv = normalizeUiPayload('kv', rows)
  assert.equal(kv.rows.length, UI_LIMITS.rows)
  assert.equal(kv.truncated, true)

  const items = Array.from({ length: UI_LIMITS.rows + 5 }, (_, i) => `第${i}条`)
  const list = normalizeUiPayload('list', items)
  assert.equal(list.items.length, UI_LIMITS.rows)
  assert.equal(list.truncated, true)

  const text = normalizeUiPayload('text', '长'.repeat(UI_LIMITS.textBytes))
  assert.equal(text.truncated, true)
  assert.ok(Buffer.byteLength(text.text, 'utf8') <= UI_LIMITS.textBytes + 64)
  assert.match(text.text, /已截断/)
})

test('ui数据：单个字段过长也要裁', () => {
  const r = normalizeUiPayload('kv', { k: '很'.repeat(1000), v: 'x' })
  assert.ok(r.rows[0].k.length <= UI_LIMITS.fieldChars + 1)
})

// ── service / api ───────────────────────────────────────────────────────

function tmpRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'yuanling-p37-'))
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

const MANIFEST = {
  ...GOOD,
  id: 'demo',
  kind: 'enricher',
  capabilities: ['provide.source'],
  ui: {
    tabs: [
      { id: 'stats', label: '统计', kind: 'kv' },
      { id: 'queue', label: '待办', kind: 'list' },
      { id: 'notes', label: '说明', kind: 'text' },
    ],
  },
}

function withModule() {
  const root = tmpRoot()
  installFromBytes({
    root,
    bytes: makeTar({ 'yuanling.module.json': JSON.stringify(MANIFEST, null, 2), 'index.mjs': 'export default {}' }),
    source: 'test',
  })
  setModuleGrantedAll(root, 'demo', true)
  return root
}

/** 假模块进程：只实现 request。 */
function fakeProc(reply) {
  return { child: {}, request: async () => reply }
}

test('service：模块没在跑 → E_NO_ROUTE（不返回空内容冒充"没有数据"）', async () => {
  const root = withModule()
  const svc = new ModuleService({ root })
  await assert.rejects(svc.uiGet('demo', 'stats'), (e) => e.code === 'E_NO_ROUTE')
})

test('service：没声明过的 tab → E_NO_ROUTE', async () => {
  const root = withModule()
  const svc = new ModuleService({ root })
  svc.procs.set('demo', fakeProc({}))
  await assert.rejects(svc.uiGet('demo', 'nope'), (e) => e.code === 'E_NO_ROUTE')
  await assert.rejects(svc.uiGet('ghost', 'stats'), (e) => e.code === 'E_NO_ROUTE')
})

test('service：按声明取到数据，形状对得上', async () => {
  const root = withModule()
  const svc = new ModuleService({ root })

  svc.procs.set('demo', fakeProc({ data: { 在线: 3 } }))
  const kv = await svc.uiGet('demo', 'stats')
  assert.equal(kv.tab, 'stats')
  assert.equal(kv.kind, 'kv')
  assert.deepEqual(kv.rows, [{ k: '在线', v: '3' }])

  // 模块直接回结果（没包 data）也要能收
  svc.procs.set('demo', fakeProc(['甲', '乙']))
  assert.deepEqual((await svc.uiGet('demo', 'queue')).items.map((i) => i.title), ['甲', '乙'])

  svc.procs.set('demo', fakeProc({ text: '说明文字' }))
  assert.equal((await svc.uiGet('demo', 'notes')).text, '说明文字')
})

test('service：形状不符 → E_BAD_REQUEST（整块拒，不半截渲染）', async () => {
  const root = withModule()
  const svc = new ModuleService({ root })
  svc.procs.set('demo', fakeProc({ data: '我偏要回字符串' }))
  await assert.rejects(svc.uiGet('demo', 'stats'), (e) => e.code === 'E_BAD_REQUEST')
})

test('详情接口带 uiTabs，页面据此排 tab', () => {
  const root = withModule()
  const d = moduleDetail(root, 'demo')
  assert.deepEqual(d.uiTabs.map((t) => t.id), ['stats', 'queue', 'notes'])
})

test('API：/api/modules/ui 走回调，缺参/没宿主都给得清楚', async () => {
  const root = withModule()

  const noHost = await handleModuleUi(root, { id: 'demo', tab: 'stats' }, {})
  assert.equal(noHost.status, 503)

  const noId = await handleModuleUi(root, { tab: 'stats' }, { onUiGet: async () => ({}) })
  assert.equal(noId.status, 400)
  const noTab = await handleModuleUi(root, { id: 'demo' }, { onUiGet: async () => ({}) })
  assert.equal(noTab.status, 400)

  const ok = await handleModuleUi(
    root,
    { id: 'demo', tab: 'stats' },
    { onUiGet: async (id, tab) => ({ tab, kind: 'kv', rows: [{ k: id, v: '1' }] }) },
  )
  assert.equal(ok.status, 200)
  assert.equal(ok.body.kind, 'kv')

  const missing = await handleModuleUi(
    root,
    { id: 'demo', tab: 'nope' },
    {
      onUiGet: async () => {
        throw Object.assign(new Error('没有声明这个 tab'), { code: 'E_NO_ROUTE' })
      },
    },
  )
  assert.equal(missing.status, 404)
})
