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
    'module-console',
    'module-summary',
    'module-list',
    'module-count',
    'module-detail',
    'module-title',
    'module-meta',
    'module-caps',
    // 配置从"打印一段 JSON"改成了真表单（2026-11-08）：
    // 表单容器要有、保存按钮要有，旧的只读文本节点不再存在
    'module-config-form',
    'module-config-save',
    'module-config-msg',
    'module-rules',
    'module-log',
    'module-tabs',
    'module-panel-brief',
    'module-panel-log',
    'module-export',
    'module-toggle',
    'module-uninstall',
    'module-file',
    'module-install',
    'module-install-msg',
    'grant-modal',
    'grant-modal-ok',
  ]) {
    assert.match(html, new RegExp(`id="${id}"`), `缺少 #${id}`)
  }
})

test('模块页：配置是表单不是只读文本，且能保存', () => {
  assert.match(app, /renderConfigForm/, '要按 schema 渲染控件')
  assert.match(app, /\/api\/modules\/config/, '保存要走配置接口')
  assert.match(app, /module-config-save/, '要有保存按钮的绑定')
  assert.match(html, /data-config-key|config-form/, '表单容器')
})

test('模块页：config 型 tab 的数据来自接口，不读列表缓存', () => {
  // 列表视图（listModules）不含 configFields / uiTabs —— 拿它渲染 config 型 tab 会得到空白页。
  // 这条钉住两件事：① 页型判断要靠详情缓存；② 数据要现取 /api/modules/ui。
  const fn = app.slice(app.indexOf('async function renderConfigTab'), app.indexOf('async function openModule'))
  assert.ok(fn.length > 0, '找得到 renderConfigTab')
  assert.match(fn, /\/api\/modules\/ui/, '要现取 fields/config')
  assert.ok(!/state\.modules\.find/.test(fn.split('renderConfigForm')[0]), '首屏渲染不能依赖列表缓存')
})

test('模块页：点 tab 时页型判断用详情缓存（列表里没有 uiTabs）', () => {
  assert.match(app, /moduleDetail: null/, 'state 要留一份详情')
  assert.match(app, /state\.moduleDetail = m/, 'openModule 要把它填上')
  const sel = app.slice(app.indexOf('function selectModuleTab'), app.indexOf('/** 自定义页取数失败'))
  assert.match(sel, /moduleDetail/, '点 tab 时要能从详情里找 uiTabs')
})

test('样式：hidden 属性必须真的能隐藏（否则设了 hidden 也还在显示）', () => {
  // 浏览器自带的 `[hidden]{display:none}` 优先级极低，作者的 .tag{
  // display:inline-block} 会盖掉它——更新角标就因此"设了 hidden 却一直在"（真踩过）
  assert.match(css, /\[hidden\]\s*\{\s*display:\s*none\s*!important;?\s*\}/, '要有带 !important 的全局 hidden 规则')
  // 顺带确认我们没把 .tokenbar[hidden] 误当成全局规则
  assert.match(css, /\.tokenbar\[hidden\]/, 'tokenbar 那条仍在（局部规则）')
})

test('静态页带 no-cache：改了 app.js 刷新就该看到新行为', () => {
  const srv = read('src/core/server.js')
  assert.match(srv, /'cache-control': 'no-cache/, '不这么写，浏览器会拿旧脚本，排查方向全错')
  // 脚本引用带版本号：缓存头万一没生效（比如服务端还没重启），换 query 也能强刷
  assert.match(html, /\/app\.js\?v=/, 'app.js 要带版本号')
})

test('控件：勾选项的 tick 必须紧跟 input（CSS 用的是相邻兄弟选择器）', () => {
  // 顺序写反的话，勾上了样式也不变——看起来就是"点不动"（真踩过）
  assert.match(app, /lab\.append\(input, tick/, 'tick 要放在 input 后面')
  assert.match(css, /\.check-row input:checked \+ \.check-tick/, 'CSS 依赖相邻兄弟')
})

test('控件：下拉框不用原生外观，走 buildSelect（外观由核心定）', () => {
  assert.match(app, /function buildSelect/, '要自己画下拉')
  assert.match(css, /appearance: none/, 'CSS 要关掉原生外观')
  assert.match(css, /\.select-wrap select \{/, '下拉有自己的样式')
  assert.match(css, /\.select-chev/, '箭头要自己画（原生箭头没法单独改样式）')
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

test('一致性：app.js 里引用的 id 都存在（静态 HTML 或 app.js 自己创建）', () => {
  // 这条是白屏的常见根因。**不用 execFileSync**：受限环境里同步管道会 EPERM，
  // 直接在这里算一遍即可（逻辑与 scripts/check-web-ids.mjs 相同）。
  //
  // 有些元素是 app.js 运行时建的（例如跟进「名称」后面的昵称卡），
  // 所以"存在"要算上 `el.id = 'x'` 这种动态创建，否则会误报。
  const ids = new Set([...html.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]))
  for (const m of app.matchAll(/\.id\s*=\s*'([^']+)'/g)) ids.add(m[1])
  const used = new Set([...app.matchAll(/\$\('([^']+)'\)/g)].map((m) => m[1]))
  const missing = [...used].filter((u) => !ids.has(u))
  assert.deepEqual(missing, [], `app.js 引用了不存在的元素：${missing.join(', ')}`)
})
