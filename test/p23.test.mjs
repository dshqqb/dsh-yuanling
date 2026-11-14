// test/p23.test.mjs —— 设置页：配置读写 + 客户端 bundle 契约。
//
// 客户端代码在浏览器里跑，Node 里测不了它的渲染；能测的是「契约」——
// bundle 形状对不对、API 路径对不对、package.json 声明对不对。这几样错了，
// DSH 根本不会加载它，而错误会在浏览器控制台里一闪而过，最难查。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  NS,
  API_PREFIX,
  pickRow,
  normalizePatch,
  applyPatch,
  consoleTokenPath,
  readConsoleToken,
  folderPickerScript,
  pickPathFromStdout,
  unwrapConfigValue,
  describeConfigValue,
} from '../src/core/settingsapi.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const REPO = path.join(HERE, '..')
const read = (rel) => fs.readFileSync(path.join(REPO, rel), 'utf8')

const pkg = JSON.parse(read('package.json'))

test('index.js：Config 必须有 volatile 字段（否则 settings.update 拒绝写入）', () => {
  const code = read('index.js')
  // 真机报错：Plugin entry "dsh-yuanling" has no volatile fields
  assert.match(code, /\.extra\('volatile', true\)/, 'enabled / dataDir 要标 volatile')
  const volatileCount = (code.match(/\.extra\('volatile', true\)/g) ?? []).length
  assert.ok(volatileCount >= 2, `至少两个字段可热改，实际 ${volatileCount}`)
})

test('index.js：不许静态 import schemastery（它只有 CJS 入口，ESM 解析会失败）', () => {
  const code = read('index.js')
  assert.ok(
    !/^\s*import\s+.*from\s+['"]@deepseek-ai\/schemastery['"]/m.test(code),
    '静态 import 会让整个插件 import failed',
  )
  assert.match(code, /createRequire\(import\.meta\.url\)/, '必须用 createRequire 走 CJS 入口')
})

test('package：客户端声明齐全（入口可放子目录，由 exports 映射）', () => {
  // 2026-11-07 真机教训：`dsh-yuanling: import failed` 的真正原因是**服务端**
  // 静态 import 了 @deepseek-ai/schemastery（只有 CJS 入口），与客户端入口放在
  // 哪个目录无关。surfcore 的客户端也在 lib/client.js，靠 exports 映射即可。
  assert.equal(pkg.dsh?.client?.platform, 'web')
  const entry = pkg.exports?.['./client']
  assert.ok(entry, '要有 ./client 导出')
  assert.ok(fs.existsSync(path.join(REPO, entry)), `入口文件不存在：${entry}`)
})

test('client bundle：是 DSH 能加载的模块形状', () => {
  const code = read('web/client.js')
  assert.match(code, /window\.__ModuleLoader__\.load\(\{/, '必须走宿主模块加载器')
  // 宿主按 id 认领客户端；id ≠ 包名时只报 "import failed"，renderer 里一行都没有
  assert.ok(code.includes(`id: '${pkg.name}'`), `客户端 id 必须等于包名 ${pkg.name}`)
  assert.match(code, /factory: \(require\) =>/, '必须是 factory 形式')
  assert.match(code, /require\('react'\)|require\("react"\)/, '只能从宿主拿 react')
  assert.match(code, /ctx\.slots\.inject\('settings\.section'|ctx\.slots\.inject\("settings\.section"/, '要挂进设置页')
  assert.match(code, /exports\.apply = apply/)
  assert.match(code, /exports\.inject = inject/)
  assert.ok(!/^\s*import\s/m.test(code), '客户端文件不能有 ESM import')
})

test('client bundle：重复执行时不会二次注册（曾把 DSH 弄挂）', () => {
  const code = read('web/client.js')
  assert.match(code, /window\.__yuanlingClientLoaded/, '幂等闸门只能挂在 window 上')
  // 宿主是按经典脚本、同一作用域执行两次；任何顶层声明都会 "already been declared"
  assert.ok(!/^(?:const|let|class)\s/m.test(code), '不能有顶层 const/let/class')
})

test('client bundle：API 路径与服务端一致', () => {
  const code = read('web/client.js')
  assert.ok(code.includes(API_PREFIX), `客户端请求 ${API_PREFIX}`)
})

test('插件 id 三处一致：包名 / patch id / export name（否则宿主不去重）', () => {
  const patch = read('cordis.patch.yml')
  assert.match(patch, new RegExp(`id: ${NS}`), 'patch 里的 id 必须是包名')
  assert.equal(pkg.name, NS, '包名要等于 id')
  assert.match(read('index.js'), new RegExp(`export const name = '${NS}'`), 'export name 也要一致')
})

test('pickRow：只认自己的命名空间，并兼容旧的 yuanling', () => {
  const rows = [
    { ns: 'qq-mode', value: { mode: 'chat' } },
    { ns: NS, value: { enabled: true, dataDir: 'D:\\yuanling' } },
  ]
  assert.deepEqual(pickRow(rows)?.value, { enabled: true, dataDir: 'D:\\yuanling' })
  assert.equal(pickRow([]), null)

  // 老 profile：id 还叫 yuanling
  const legacy = [{ ns: 'yuanling', value: { enabled: true } }]
  assert.equal(pickRow(legacy)?.ns, 'yuanling', '读得到旧 id，才能迁移')
})

test('normalizePatch：接受 enabled / dataDir 与管理台四项', () => {
  const patch = normalizePatch({ enabled: false, dataDir: '  D:\\y  ', consolePort: 9999, consoleHost: '0.0.0.0', allowRemote: true, consoleEnabled: false })
  assert.deepEqual(patch, { enabled: false, dataDir: 'D:\\y', consolePort: 9999, consoleHost: '0.0.0.0', allowRemote: true, consoleEnabled: false })
})

test('applyPatch：非回环地址没有勾选局域网访问时拒绝', async () => {
  const settings = { update: async () => {} }
  await assert.rejects(
    () => applyPatch({ settings, body: { consoleHost: '0.0.0.0', allowRemote: false }, current: { consoleHost: '127.0.0.1', allowRemote: false } }),
    /允许同一局域网/,
  )
  const ok = await applyPatch({ settings, body: { consoleHost: '0.0.0.0', allowRemote: true }, current: { consoleHost: '127.0.0.1' } })
  assert.equal(ok.restartRequired, true)
})

test('applyPatch：写进宿主设置，并报告是否要重启', async () => {
  const calls = []
  const settings = { update: async (ns, patch) => calls.push([ns, patch]) }

  const r = await applyPatch({ settings, body: { enabled: false }, current: { enabled: true } })
  assert.deepEqual(calls, [[NS, { enabled: false }]])
  assert.equal(r.restartRequired, false, '只切换开关不需要重启')
})

test('applyPatch：换数据目录时同步 MCP，并要求重启', async () => {
  const settings = { update: async () => {} }
  const synced = []
  const r = await applyPatch({
    settings,
    body: { dataDir: 'D:\\new-dir' },
    current: { dataDir: 'D:\\old-dir' },
    validate: () => ({ ok: true }),
    syncMcp: (dir) => {
      synced.push(dir)
      return { changed: true }
    },
  })
  assert.deepEqual(synced, ['D:\\new-dir'])
  assert.equal(r.restartRequired, true)
  assert.equal(r.mcp.changed, true)
})

test('applyPatch：目录没变就不动 MCP', async () => {
  const synced = []
  await applyPatch({
    settings: { update: async () => {} },
    body: { dataDir: 'D:\\same' },
    current: { dataDir: 'D:\\same' },
    syncMcp: (dir) => synced.push(dir),
  })
  assert.deepEqual(synced, [])
})

test('applyPatch：目录不可用 → 400，且一个字都不写', async () => {
  const calls = []
  await assert.rejects(
    applyPatch({
      settings: { update: async (ns, p) => calls.push(p) },
      body: { dataDir: 'D:\\nope' },
      current: {},
      validate: () => ({ ok: false, errors: [{ code: 'ROOT_MISSING', message: '数据目录不存在' }] }),
    }),
    /ROOT_MISSING/,
  )
  assert.deepEqual(calls, [], '校验失败时不许写配置')
})

test('applyPatch：宿主没有 settings.update 时明确报错', async () => {
  await assert.rejects(applyPatch({ settings: {}, body: { enabled: true } }), /settings\.update/)
})

test('配置值解包：宿主把 dataDir 包成对象时也要认出来', () => {
  // 真机现场：config.dataDir 是对象，String() 得到 "[object Object]"，
  // 于是数据目录回落默认位置、控制台令牌换了一份 → 永远"令牌不匹配"。
  assert.equal(unwrapConfigValue('D:\\yuanling'), 'D:\\yuanling')
  assert.equal(unwrapConfigValue({ value: 'D:\\yuanling' }), 'D:\\yuanling')
  assert.equal(unwrapConfigValue({ default: 'D:\\yuanling' }), 'D:\\yuanling')
  assert.equal(unwrapConfigValue({ $value: 'D:\\yuanling' }), 'D:\\yuanling')
  assert.equal(unwrapConfigValue(null), '')
  assert.equal(unwrapConfigValue({ weird: 1 }), '', '认不出就当空，绝不返回 [object Object]')

  const d = describeConfigValue({ value: 'D:\\yuanling', extra: true })
  assert.equal(d.type, 'object')
  assert.deepEqual(d.keys, ['value', 'extra'])
})

test('令牌：路径与读取', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'yuanling-p23-token-'))
  assert.ok(consoleTokenPath(root).endsWith(path.join('system', 'secrets', 'console.token')))
  assert.equal(readConsoleToken(root), null, '没有文件时返回 null，不抛')

  const p = consoleTokenPath(root)
  fs.mkdirSync(path.dirname(p), { recursive: true })
  fs.writeFileSync(p, 'abc123\n')
  assert.equal(readConsoleToken(root), 'abc123', '去掉换行')
})

test('选择目录：脚本是 FolderBrowserDialog，且能从输出里取到最后一行路径', () => {
  const ps = folderPickerScript('选个目录')
  assert.match(ps, /System\.Windows\.Forms/)
  assert.match(ps, /FolderBrowserDialog/)
  assert.match(ps, /选个目录/)

  assert.equal(pickPathFromStdout('warning: 一些噪音\nD:\\yuanling\n'), 'D:\\yuanling')
  assert.equal(pickPathFromStdout(''), '', '取消时为空')
})

test('applyPatch：空 patch 被拒绝', async () => {
  await assert.rejects(applyPatch({ settings: { update: async () => {} }, body: {} }), /没有可应用的改动/)
})
