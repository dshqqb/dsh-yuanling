// test/p31.test.mjs —— 模块页的契约（HTML 结构 + API 对齐）。
//
// 页面代码在浏览器里跑，Node 里渲染不了；能测的是"结构对不对"：
// 元素 id 存在、API 路径存在、风格与既有页面一致。这几样错了页面会白屏，
// 而在浏览器控制台里只是一行 null.addEventListener。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const REPO = path.join(HERE, '..')
const read = (rel) => fs.readFileSync(path.join(REPO, rel), 'utf8')

const html = read('web/index.html')
const app = read('web/app.js')
const css = read('web/style.css')

test('模块页：必要元素都在', () => {
  for (const id of [
    'page-modules',
    'module-summary',
    'module-list',
    'module-count',
    'module-detail',
    'module-title',
    'module-meta',
    'module-caps',
    'module-config',
    'module-log',
    'module-export',
    'module-toggle',
    'module-uninstall',
    'module-file',
    'module-install',
    'module-install-msg',
  ]) {
    assert.match(html, new RegExp(`id="${id}"`), `缺少 #${id}`)
  }
})

test('模块页：不再是"这里还空着"的占位', () => {
  assert.ok(!html.includes('这里还空着'), '模块页应该已经接进真实内容')
  assert.ok(!html.includes('现在没有已安装的模块'), '不该还有写死的空态文案')
})

test('模块页：调用的 API 都存在', () => {
  for (const p of ['/api/modules', '/api/module?id=', '/api/modules/install', '/api/modules/grant', '/api/modules/enable', '/api/modules/export', '/api/modules/uninstall']) {
    // 客户端代码里的路径
    assert.ok(app.includes(p) || html.includes(p), `客户端没用到 ${p}`)
  }
})

test('模块页：能力用人话显示，send 标敏感', () => {
  assert.match(app, /'ingest\.message': '收消息'/, '能力要翻译成人话')
  assert.match(app, /CAP_RISK = \{ send: true \}/, 'send 要单独标风险')
})

test('模块页：切到"模块"会加载数据', () => {
  assert.match(app, /loadModules\(\)\.catch/, 'setMode 里应触发加载')
})

test('模块页：有刷新按钮且绑了事件', () => {
  assert.match(html, /id="module-refresh"/)
  assert.match(app, /\$\('module-refresh'\)\.addEventListener/)
})

test('模块页：卸载前会二次确认', () => {
  assert.match(app, /confirm\(/, '卸载是不可逆操作，必须确认')
})

test('模块页：装载框接受库的网址，也接受本地路径（2026-11-08 起管理台能直接联网装）', () => {
  assert.match(html, /库的网址/, '输入框要说明可以填库的网址')
  assert.match(app, /\/api\/modules\/install-url/, '填网址时走 install-url 这条异步接口')
  assert.match(app, /\/api\/modules\/install\b/, '填本地路径时仍走同步的 install')
  assert.match(app, /install-url', \{ url: input \}/, '要把用户填的值作为 url 传过去')
})

test('样式：模块页要用的类都有定义', () => {
  for (const sel of ['.stat-row', '.kv', '.subhead', '.logbox']) {
    assert.ok(css.includes(sel), `样式缺少 ${sel}`)
  }
})

test('一致性：app.js 里引用的 id 在 HTML 里都存在', () => {
  // 这条是白屏的常见根因。**不用 execFileSync**：受限环境里同步管道会 EPERM，
  // 直接在这里算一遍即可（逻辑与 scripts/check-web-ids.mjs 相同）。
  const ids = new Set([...html.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]))
  const used = new Set([...app.matchAll(/\$\('([^']+)'\)/g)].map((m) => m[1]))
  const missing = [...used].filter((u) => !ids.has(u))
  assert.deepEqual(missing, [], `app.js 引用了不存在的元素：${missing.join(', ')}`)
})
