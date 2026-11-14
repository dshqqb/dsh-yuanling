// test/p94.test.mjs —— 协议 v1.9：`accountSource` + raw 的来源命名。
//
// 用户定的（2026-11-14）：
//   · 模块可以声明 accountSource，标记它接的数据源**有没有账户信息**；
//     true 时 app 必填，并且只有这类模块的 app 出现在「新增人物」的下拉里。
//   · 模块写进 raw 的 `source`：有 app 用 app，没有才用模块 id（不用中文 name）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { scaffold } from '../src/core/scaffold.js'
import { validateManifest, API_MINOR, summarizeErrors } from '../src/core/modules/manifest.js'
import { makeEntry, moduleDir } from '../src/core/modules/registry.js'
import { listModules } from '../src/core/modules/manage.js'
import { moduleHandlers } from '../src/core/modules/wire.js'
import { storeFetched } from '../src/core/modules/sources.js'
import { handleApi } from '../src/core/api.js'
import { readDay, today } from '../src/core/raw.js'
import { listCards } from '../src/core/accounts.js'

const PID = 'yuanling'

function tmpRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'yuanling-p94-'))
  scaffold(root, {})
  return root
}

/** 造一个"已装模块"：manifest 文件 + 注册表条目。 */
function addModule(root, { id, app = null, accountSource, sources = [], inRegistry = {} }) {
  const dir = moduleDir(root, id)
  fs.mkdirSync(dir, { recursive: true })
  const manifest = {
    id,
    version: '0.1.0',
    api: '1.9',
    entry: { command: ['node', 'x.js'] },
    capabilities: ['ingest.message'],
  }
  if (app) manifest.app = app
  if (accountSource !== undefined) manifest.accountSource = accountSource
  if (sources.length) {
    manifest.sources = sources
    manifest.capabilities.push('provide.source')
  }
  fs.writeFileSync(path.join(dir, 'yuanling.module.json'), JSON.stringify(manifest, null, 2))

  const regPath = path.join(root, 'system', 'modules.json')
  const reg = fs.existsSync(regPath) ? JSON.parse(fs.readFileSync(regPath, 'utf8')) : { version: 1, modules: {} }
  reg.modules[id] = {
    id,
    version: '0.1.0',
    api: '1.9',
    app,
    ...(accountSource === undefined ? {} : { accountSource }),
    enabled: true,
    capabilities: manifest.capabilities,
    granted: manifest.capabilities,
    state: 'running',
    ...inRegistry,
  }
  fs.writeFileSync(regPath, JSON.stringify(reg, null, 2))
  return { manifest, dir }
}

const u = (p) => new URL(`http://127.0.0.1${p}`)

// ── manifest 校验 ──────────────────────────────────────────────────────

test('v1.9：api 次版本升到 9', () => {
  assert.equal(API_MINOR, 9)
})

test('accountSource=true 必须给 app；给了就通过', () => {
  const base = { id: 'echo', version: '0.1.0', api: '1.9', entry: { command: ['node', 'x.js'] } }
  const bad = validateManifest({ ...base, accountSource: true })
  assert.equal(bad.ok, false)
  assert.match(summarizeErrors(bad.errors), /MISSING_APP|accountSource/)

  const ok = validateManifest({ ...base, app: 'qq', accountSource: true })
  assert.equal(ok.ok, true)
  assert.equal(ok.manifest.accountSource, true)
})

test('accountSource 缺省按 app 推断；显式 false 可以不要 app', () => {
  const base = { id: 'echo', version: '0.1.0', api: '1.9', entry: { command: ['node', 'x.js'] } }
  assert.equal(validateManifest({ ...base, app: 'qq' }).manifest.accountSource, true, '有 app = 有账户')
  assert.equal(validateManifest({ ...base }).manifest.accountSource, false, '没 app 也没账户')
  assert.equal(validateManifest({ ...base, app: 'qq', accountSource: false }).manifest.accountSource, false, '显式关掉')

  const badType = validateManifest({ ...base, accountSource: 'yes' })
  assert.equal(badType.ok, false)
  assert.match(summarizeErrors(badType.errors), /accountSource/)
})

test('注册表快照带 accountSource；老注册表按 app 推断', () => {
  const entry = makeEntry({
    manifest: { id: 'qq', version: '0.1.0', api: '1.9', app: 'qq', accountSource: true, kind: 'gateway', routes: [], sources: [], capabilities: [] },
    source: 'local',
  })
  assert.equal(entry.accountSource, true)

  // 没写这个字段但有 app：makeEntry 也要按 app 推断成 true（和 manifest 的缺省一致）
  const inferred = makeEntry({
    manifest: { id: 'echo', version: '0.1.0', api: '1.9', app: 'qq', kind: 'gateway', routes: [], sources: [], capabilities: [] },
    source: 'local',
  })
  assert.equal(inferred.accountSource, true)

  const root = tmpRoot()
  addModule(root, { id: 'legacy', app: 'qq' }) // 注册表条目里没有 accountSource
  addModule(root, { id: 'tools', app: 'bilibili', accountSource: false })
  const list = listModules(root)
  assert.equal(list.find((m) => m.id === 'legacy').accountSource, true)
  assert.equal(list.find((m) => m.id === 'tools').accountSource, false)
})

// ── 新增人物的 App 下拉 ─────────────────────────────────────────────────

test('/api/picker：只列 accountSource=true 的 app', () => {
  const root = tmpRoot()
  addModule(root, { id: 'qq', app: 'qq', accountSource: true })
  addModule(root, { id: 'bili', app: 'bilibili', accountSource: false })
  addModule(root, { id: 'subs', app: null })

  const body = handleApi(root, u('/api/picker')).body
  assert.deepEqual(body.apps.map((a) => a.app), ['qq'], '工具模块的 app 不进下拉')
})

// ── raw 的来源命名 ─────────────────────────────────────────────────────

test('ingest：有 app 用 app 当 source，没 app 用模块 id', () => {
  const root = tmpRoot()
  addModule(root, { id: 'qq', app: 'qq', accountSource: true })
  addModule(root, { id: 'subs', app: null })
  const wire = moduleHandlers({ root, pid: PID })

  const item = (channel, id, text) => ({
    v: 1,
    acct: 'default',
    items: [{ channel, actor: { id, name: `人${id}` }, role: 'user', text }],
  })
  wire.onIngest({ id: 'qq', data: item('private:10001', '10001', '你好') })
  wire.onIngest({ id: 'subs', data: item('private:10002', '10002', '字幕来了') })

  const day = readDay(root, today())
  const byText = (t) => day.find((r) => r.text === t)
  assert.equal(byText('你好').source, 'qq')
  assert.equal(byText('字幕来了').source, 'subs')
})

test('ingest：来自 bili 模块的账户，平台是它声明的 app（bilibili），不是模块 id', () => {
  const root = tmpRoot()
  addModule(root, { id: 'bili', app: 'bilibili', accountSource: true })
  const wire = moduleHandlers({ root, pid: PID })

  wire.onIngest({
    id: 'bili',
    data: { v: 1, acct: 'default', items: [{ channel: 'private:777', actor: { id: '777', name: '阿七' }, role: 'user', text: '在吗' }] },
  })

  const rec = readDay(root, today()).find((r) => r.text === '在吗')
  assert.equal(rec.source, 'bilibili', 'raw 来源是 app')
  assert.ok(rec.channel.startsWith('private:card_'), `频道应该归到卡：${rec.channel}`)

  const cards = listCards(root, PID)
  const card = cards.find((c) => c.account === '777')
  assert.equal(card.app, 'bilibili', '账户平台按模块的 app 解析')
})

test('source.fetch 落 raw：source 同样用 app', () => {
  const root = tmpRoot()
  addModule(root, { id: 'bili', app: 'bilibili', accountSource: true, sources: [{ id: 'bili.search_video', title: '搜视频' }] })

  const r = storeFetched(root, {
    moduleId: 'bili',
    sourceId: 'bili.search_video',
    ackedAt: new Date().toISOString(),
    items: [{ extId: 'BV1xx', text: '一个视频', kind: 'material' }],
  })
  assert.equal(r.records.length, 1)
  const rec = readDay(root, today()).find((x) => x.text === '一个视频')
  assert.equal(rec.source, 'bilibili')
  assert.equal(rec.ext?.module, 'bili', 'ext 里仍记模块 id')
})

test('app 不能撞保留字：它会成为 raw 的来源文件名', () => {
  const base = { id: 'echo', version: '0.1.0', api: '1.9', entry: { command: ['node', 'x.js'] } }
  for (const app of ['system', 'dsh', 'media']) {
    const r = validateManifest({ ...base, app, accountSource: true })
    assert.equal(r.ok, false, `app=${app} 不该通过`)
    assert.match(summarizeErrors(r.errors), /RESERVED|保留字/)
  }
  assert.equal(validateManifest({ ...base, app: 'qq', accountSource: true }).ok, true)
})

test('外部投递不能伪造 originModule（它只走 ingest 的选项）', () => {
  const root = tmpRoot()
  addModule(root, { id: 'bili', app: 'bilibili', accountSource: true })
  const wire = moduleHandlers({ root, pid: PID })

  // 伪造：信封里写别人家的 originModule —— 必须被无视
  wire.onIngest({
    id: 'qq',
    data: {
      v: 1,
      acct: 'default',
      originModule: 'bili',
      source: 'bili',
      items: [{ channel: 'private:888', actor: { id: '888', name: '路人' }, role: 'user', text: '假装是b站' }],
    },
  })

  const rec = readDay(root, today()).find((r) => r.text === '假装是b站')
  assert.equal(rec.source, 'qq', 'source 由核心按连接身份盖章')
  const card = listCards(root, PID).find((c) => c.account === '888')
  assert.equal(card.app, 'qq', '平台按真实模块（qq）解析，不是信封里写的 bili')
})
