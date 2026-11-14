// 管理台前端：无构建、无依赖。token 存 localStorage，只发给本机回环服务。
const $ = (id) => document.getElementById(id)
const tokenKey = 'yuanling.token'
const themeKey = 'yuanling.theme'

const state = {
  token: localStorage.getItem(tokenKey) || '',
  tab: 'status',
  mode: 'frame',
  // 每个模式各记一个"上次停在哪"，切回来不用重找
  tabByMode: { frame: 'status', persona: 'overview' },
  logLens: 'all',
  diagMode: 'problems',
  memoryView: 'search',
  moduleId: null,
  // 模块模式下的左侧菜单：控制台 + 每个已装模块。列表缓存在这里，回车/点击都不用再请求
  modules: [],
  moduleView: 'console',
  moduleTab: 'brief',
  // 当前打开模块的**详情**（含 uiTabs / configFields）。列表那份没有这些字段，
  // 点 tab 时要靠它判断"这页是 config 型还是 records 型"。
  moduleDetail: null,
  // 人格卡：最近一次从服务端拿到的卡（保存时要用它的 expect 指纹防覆盖）。
  // cardForm 里除了卡本身，还压着各个文本域——保存按钮要能一次把它们全交上去。
  cardForm: null,
  personaList: [],
}

/**
 * 左侧菜单里显示的模块名。
 *
 * 来源是**模块自己声明的 `manifest.name`**——名字归模块定，核心不猜（也不该从
 * 仓库名或 id 反推：`dsh-yuanling-qq` 只是包名，不一定是它想让人看到的名字）。
 *
 * 模块没写 name 时才退回 id，并去掉常见前缀（`dsh-yuanling-qq` → `qq`）。
 * 无论哪条路径，最多显示 16 个字，超了截断加省略号——侧栏宽度有限，
 * 让它撑开或折行都比截断难看得多。完整名字放 title 提示里。
 */
const NAME_MAX = 16

function moduleDisplayName(m) {
  const declared = String(m.name ?? '').trim()
  // manage.js 在模块没写 name 时会把 id 填进来，所以"等于 id"就视为没声明
  if (declared && declared !== m.id) return clipName(declared)

  const id = String(m.id ?? '')
  const hit = /^(?:dsh-yuanling|yuanling)-([a-z0-9-]+)$/i.exec(id)
  return clipName(hit ? hit[1] : id)
}

function clipName(s) {
  const str = String(s ?? '')
  return str.length > NAME_MAX ? `${str.slice(0, NAME_MAX)}…` : str
}
const I = {
  gauge: '<circle cx="12" cy="12" r="3.2"/><path d="M12 4v2.2M12 17.8V20M4 12h2.2M17.8 12H20M6.3 6.3l1.6 1.6M16.1 16.1l1.6 1.6M17.7 6.3l-1.6 1.6M7.9 16.1l-1.6 1.6" stroke-linecap="round"/>',
  layers: '<path d="M12 3.5l8 4.2-8 4.2-8-4.2 8-4.2z"/><path d="M4 12.3l8 4.2 8-4.2" stroke-linejoin="round"/>',
  search: '<circle cx="11" cy="11" r="6.4"/><path d="M15.8 15.8L20 20" stroke-linecap="round"/>',
  list: '<path d="M8.5 7h11M8.5 12h11M8.5 17h11" stroke-linecap="round"/><circle cx="4.5" cy="7" r="1"/><circle cx="4.5" cy="12" r="1"/><circle cx="4.5" cy="17" r="1"/>',
  spark: '<path d="M12 3.5l1.9 5.1 5.1 1.9-5.1 1.9L12 17.5l-1.9-5.1L5 10.5l5.1-1.9L12 3.5z" stroke-linejoin="round"/>',
  user: '<circle cx="12" cy="8.4" r="3.6"/><path d="M5 20c0-3.6 3.1-5.6 7-5.6s7 2 7 5.6" stroke-linecap="round"/>',
  users: '<circle cx="9" cy="8.4" r="3.2"/><path d="M3.4 19.4c0-3.2 2.5-5 5.6-5s5.6 1.8 5.6 5" stroke-linecap="round"/><path d="M16.2 5.7a3.2 3.2 0 010 6.2M17.8 14.9c2 .5 3.3 2 3.3 4.1" stroke-linecap="round"/>',
  shield: '<path d="M12 3.6l7 2.6v5.4c0 4.4-3 7.4-7 8.8-4-1.4-7-4.4-7-8.8V6.2l7-2.6z" stroke-linejoin="round"/>',
  plug: '<path d="M9 3.5v4M15 3.5v4" stroke-linecap="round"/><path d="M6.5 7.5h11v3.2a5.5 5.5 0 01-11 0V7.5z" stroke-linejoin="round"/><path d="M12 16.5v4" stroke-linecap="round"/>',
  ban: '<circle cx="12" cy="12" r="8"/><path d="M6.4 17.6L17.6 6.4" stroke-linecap="round"/>',
  chart: '<path d="M4 20V9M9.3 20V4M14.7 20v-7M20 20v-4" stroke-linecap="round"/>',
  pulse: '<path d="M3 12h4l2.5-6 4 12 2.5-6H21" stroke-linecap="round" stroke-linejoin="round"/>',
  // 模块菜单项用立方体：和"控制台"的插头区分开，一眼能看出"这是一个模块"
  box: '<path d="M12 3.2l7.5 4.2-7.5 4.2-7.5-4.2 7.5-4.2z" stroke-linejoin="round"/><path d="M4.5 7.4v6.6l7.5 4.2 7.5-4.2V7.4" stroke-linejoin="round"/>',
  // 动机用火苗：和人群、盾牌都不同形，扫一眼就能定位
  flame: '<path d="M12 3.5c2.7 3.1 4.2 5.2 4.2 7.7a4.2 4.2 0 01-8.4 0c0-1.1.3-2 1-3 .3 1.3 1 2 2 2.2.6-2 .8-4.2 1.2-6.9z" stroke-linejoin="round"/>',
}

// 顶部三块：框架（共通）/ 人格（每人格一份）/ 模块（外部进程）。
//
// 分开的依据只有一条：**切换人格时，哪一页会变？**
// 会变的进"人格"，不会变的进"框架"。所以"规则"在人格里（它存在
// personas/<人格>/rules/ 下，换人格就换一份，新建人格拿默认值），
// 而"用量 / 来源 / 日志 / 诊断 / 拒绝记录 / 状态"在框架里（跟人格无关）。
const FRAME_NAV = [
  { id: 'status', label: '状态', icon: 'gauge' },
  { id: 'usage', label: '用量', icon: 'chart' },
  { id: 'sources', label: '来源', icon: 'plug' },
  { id: 'logs', label: '日志', icon: 'list' },
  { id: 'diag', label: '诊断', icon: 'pulse' },
  { id: 'refusals', label: '拒绝记录', icon: 'ban' },
]

const PERSONA_NAV = [
  { id: 'overview', label: '概况', icon: 'layers' },
  { id: 'shape', label: '人格塑造', icon: 'spark' },
  { id: 'memory', label: '记忆', icon: 'search' },
  { id: 'motive', label: '动机', icon: 'flame' },
  { id: 'people', label: '人物', icon: 'user' },
  { id: 'groups', label: '群体', icon: 'users' },
  { id: 'rules', label: '规则', icon: 'shield' },
  { id: 'chat', label: '对话', icon: 'spark' },
  { id: 'chat-test', label: '对话测试', icon: 'search' },
]

const NAV_BY_MODE = { frame: FRAME_NAV, persona: PERSONA_NAV }
const TAB_MODE = Object.fromEntries(
  Object.entries(NAV_BY_MODE).flatMap(([mode, list]) => list.map((n) => [n.id, mode])),
)

// ── 小工具 ────────────────────────────────────────────────────────────
function el(tag, cls, text) {
  const n = document.createElement(tag)
  if (cls) n.className = cls
  if (text !== undefined) n.textContent = text
  return n
}

function icon(name, size = 18) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
  svg.setAttribute('viewBox', '0 0 24 24')
  svg.setAttribute('width', size)
  svg.setAttribute('height', size)
  svg.setAttribute('fill', 'none')
  svg.setAttribute('stroke', 'currentColor')
  svg.setAttribute('stroke-width', '1.7')
  svg.innerHTML = I[name] || ''
  return svg
}

function setConn(ok, title) {
  const d = $('conn')
  d.className = `dot ${ok ? 'ok' : 'bad'}`
  d.title = title || (ok ? '已连接' : '连接失败')
}

// ── 页面级报错 ────────────────────────────────────────────────────────
//
// 为什么要这一条：`openTab` 以前把加载失败只打进 console，页面就是一片空白。
// 空白和"真的没数据"在界面上长得一模一样——人会开始怀疑数据，而不是怀疑代码。
// 现在失败必须写在页面上，并且给出下一步。
function showPageError(err) {
  const box = $('page-error')
  if (!box) return
  const text = String(err?.message ?? err)
  if (text === 'unauthorized') {
    box.textContent = '没有令牌，或令牌不对：点右上角钥匙，粘贴 system/secrets/console.token 的内容。'
  } else if (/^404\b/.test(text)) {
    // 最常见的 404：后端还是旧代码（新接口在重启后才存在）
    box.textContent = `这个接口不存在（${text}）。如果是刚更新过代码，重启 DSH 再试——静态页面刷新就生效，但后端路由要重启进程。`
  } else {
    box.textContent = `这一页没加载出来：${text}`
  }
  box.hidden = false
}

function hidePageError() {
  const box = $('page-error')
  if (box) box.hidden = true
}


function showTokenBar(show) {
  $('tokenbar').hidden = !show
  if (show) $('token-input').focus()
}

// ── 网络 ──────────────────────────────────────────────────────────────
async function api(path) {
  const res = await fetch(path, { headers: state.token ? { 'x-yuanling-token': state.token } : {} })
  if (res.status === 401) {
    setConn(false, state.token ? '令牌无效' : '还没有填令牌')
    showTokenBar(true)
    throw new Error('unauthorized')
  }
  if (!res.ok) {
    setConn(false, `请求失败 ${res.status}`)
    throw new Error(`${res.status} ${(await res.text().catch(() => '')).slice(0, 120)}`)
  }
  setConn(true)
  return res.json()
}

async function postApi(path, body) {
  const res = await fetch(path, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(state.token ? { 'x-yuanling-token': state.token } : {}),
    },
    body: JSON.stringify(body ?? {}),
  })
  if (res.status === 401) {
    setConn(false, '令牌无效')
    showTokenBar(true)
    throw new Error('unauthorized')
  }
  const data = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(data.error || `${res.status}`)
  return data
}

function mkBtn(label, cls, onClick) {
  const b = el('button', `btn ${cls || ''}`.trim(), label)
  b.addEventListener('click', async () => {
    b.disabled = true
    try {
      await onClick()
    } catch (err) {
      alert(`失败：${err.message || err}`)
    } finally {
      b.disabled = false
    }
  })
  return b
}

// ── 导航 / 模式 / 主题 ────────────────────────────────────────────────
function buildNav() {
  const nav = $('nav')
  nav.innerHTML = ''

  // 模块模式：最上面是「控制台」，下面是每个已装模块。点击模块直接进详情。
  if (state.mode === 'modules') {
    const consoleBtn = el('button', 'nav-item' + (state.moduleView === 'console' ? ' is-active' : ''))
    consoleBtn.append(icon('plug'), el('span', 'label', '控制台'))
    consoleBtn.addEventListener('click', () => openModuleConsole())
    nav.append(consoleBtn)

    if (!state.modules.length) {
      nav.append(el('div', 'muted small nav-hint', '还没有已安装的模块'))
      return
    }

    const head = el('div', 'nav-group', '已安装')
    nav.append(head)

    for (const m of state.modules) {
      const [stateText, stateCls] = STATE_LABELS[m.state] ?? [m.state, '']
      const b = el('button', 'nav-item' + (state.moduleView === m.id ? ' is-active' : ''))
      b.append(icon('box'), el('span', 'label', moduleDisplayName(m)))
      b.append(el('span', `tag ${stateCls} nav-tag`.trim(), stateText))
      b.title = `${m.name || m.id}（${m.id}） · v${m.version} · ${stateText}`
      b.addEventListener('click', () => openModule(m.id))
      // 有新版挂个版本角标（不弹窗，不打断）。数据来自 state.modules[].update
      if (m.update) b.append(el('span', 'tag ok nav-tag', `v${m.update}`))
      nav.append(b)
    }
    return
  }

  for (const item of NAV_BY_MODE[state.mode] ?? FRAME_NAV) {
    const b = el('button', 'nav-item' + (item.id === state.tab ? ' is-active' : ''))
    b.dataset.tab = item.id
    b.append(icon(item.icon), el('span', 'label', item.label))
    b.addEventListener('click', () => openTab(item.id))
    nav.append(b)
  }
}

function paintModes() {
  for (const m of ['frame', 'persona', 'modules']) {
    const btn = $(`mode-${m}`)
    if (btn) btn.classList.toggle('is-active', state.mode === m)
  }
}

/**
 * 切顶部的三块。
 *
 * 三块里只有「模块」会换掉整个页面区（它有自己的 #page-modules），另外两块共用
 * 同一批 `.page`，靠 openTab 显隐。所以这里只记住各自停在哪一页，剩下的交给它。
 */
function setMode(mode) {
  if (mode === 'modules') {
    state.mode = 'modules'
    paintModes()
    state.moduleView = 'console'
    for (const s of document.querySelectorAll('.main > .page')) s.hidden = s.id !== 'page-modules'
    buildNav()
    $('crumb-page').textContent = '控制台'
    loadModules()
      .then(() => {
        buildNav()
        autoCheckUpdates()
      })
      .catch(() => {})
    showModuleView('console')
    return
  }

  state.mode = mode
  paintModes()
  buildNav()
  const want = state.tabByMode[mode]
  const fallback = (NAV_BY_MODE[mode] ?? FRAME_NAV)[0].id
  openTab(TAB_MODE[want] === mode ? want : fallback)
}

function applyTheme(t) {
  document.documentElement.dataset.theme = t
  try {
    localStorage.setItem(themeKey, t)
  } catch {}
}

function toggleTheme() {
  applyTheme(document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark')
}

// ── 各页 ──────────────────────────────────────────────────────────────
function stat(k, v, sub, primary) {
  const n = el('div', 'stat' + (primary ? ' primary' : ''))
  n.append(el('div', 'k', k), el('div', 'v', String(v)))
  if (sub) n.append(el('div', 'sub', sub))
  return n
}

async function loadStatus() {
  const s = await api('/api/status')
  let pending = 0
  try {
    const p = await api('/api/proposals')
    pending = p.proposals.filter((x) => x.status === 'pending').length
  } catch {}
  let mods = null
  try {
    mods = await api('/api/modules')
  } catch {}

  $('side-persona').textContent = s.personas.find((p) => p.active)?.name || s.active || '—'
  $('side-root').textContent = s.root

  const box = $('status-cards')
  box.innerHTML = ''
  box.append(
    stat('条目', s.entries, '当前人格的主题'),
    stat('事实', s.facts, '当前人格的记忆'),
    stat('待定提案', pending, '等你点头'),
    stat('人格', s.personas.length, s.active || ''),
  )

  const meta = $('status-meta')
  meta.innerHTML = ''
  const kv = (k, v) => meta.append(el('div', 'k', k), el('div', 'v', String(v)))
  kv('数据目录', s.root)
  kv('当前人格', `${s.personas.find((p) => p.active)?.name ?? '—'}（${s.active ?? '—'}）`)
  kv('格式版本', s.format ?? '—')
  if (mods) {
    const running = (mods.modules ?? []).filter((m) => m.state === 'running').length
    kv('模块', `${(mods.modules ?? []).length} 个已装，${running} 个在跑`)
  }
  kv('切换人格', '在「人格 → 概况」里')
  try { await loadModel() } catch (err) {
    const msg = $('model-msg')
    if (msg) msg.textContent = `模型目录读取失败：${err?.message ?? err}`
  }
}

let modelCatalog = null

function modelChoiceValue(provider, model) {
  return JSON.stringify({ provider, model })
}

function renderModelEfforts() {
  const sel = $('model-effort')
  const label = $('model-effort-label')
  if (!sel || !label) return
  const view = window.YLModelView?.effortValue?.(modelCatalog, $('model-select')?.value) ?? { visible: false, value: '', efforts: [] }
  if (!view.visible) {
    sel.hidden = true
    label.hidden = true
    sel.innerHTML = ''
    return
  }
  sel.innerHTML = ''
  sel.append(new Option('自动', ''))
  for (const e of view.efforts) sel.append(new Option(e.name || e.id, e.id))
  sel.value = view.value
  sel.hidden = false
  label.hidden = false
}

function renderModel() {
  const sel = $('model-select')
  if (!sel) return
  sel.innerHTML = ''
  const providers = modelCatalog?.providers ?? []
  if (!providers.some((p) => (p.models ?? []).length)) {
    sel.append(new Option(modelCatalog?.error || 'DSH 里没有可用模型', ''))
    sel.disabled = true
    $('model-save').disabled = true
    $('model-current').textContent = modelCatalog?.error ? '不可用' : '未配置'
    return
  }
  sel.append(new Option('选择模型…', ''))
  for (const p of providers) {
    const models = p.models ?? []
    if (!models.length) continue
    const group = document.createElement('optgroup')
    group.label = p.name || p.id
    for (const m of models) {
      const opt = new Option(m.name || m.id, modelChoiceValue(p.id, m.id))
      if (m.error) opt.textContent += '（元数据读取失败）'
      group.append(opt)
    }
    sel.append(group)
  }
  const cur = modelCatalog?.current
  if (cur) {
    const value = modelChoiceValue(cur.provider, cur.model)
    if ([...sel.options].some((o) => o.value === value)) sel.value = value
    $('model-current').textContent = `${cur.provider} / ${cur.model}${cur.reasoningEffort ? ` · ${cur.reasoningEffort}` : ''}`
  } else {
    $('model-current').textContent = '沿用 DSH 默认模型'
  }
  sel.disabled = false
  $('model-save').disabled = !sel.value
  renderModelEfforts()
}

async function loadModel() {
  modelCatalog = await api('/api/model')
  renderModel()
  $('model-msg').textContent = ''
}

async function saveModel() {
  const sel = $('model-select')
  const btn = $('model-save')
  const msg = $('model-msg')
  let picked = null
  try { picked = JSON.parse(sel.value) } catch {}
  if (!picked?.provider || !picked?.model) return
  const effort = $('model-effort').hidden ? '' : $('model-effort').value
  btn.disabled = true
  msg.textContent = '切换中…'
  try {
    const d = await postApi('/api/model', {
      provider: picked.provider,
      model: picked.model,
      ...(effort ? { reasoningEffort: effort } : {}),
    })
    modelCatalog.current = {
      provider: picked.provider,
      model: picked.model,
      ...(effort ? { reasoningEffort: effort } : {}),
    }
    const applied = (d.applied ?? []).length
    msg.textContent = `已保存${effort ? `（推理等级 ${effort}）` : ''}${applied ? `，已作用于 ${applied} 个运行中的会话` : ''}`
    renderModel()
    if (effort) {
      const e = $('model-effort')
      if (e && !e.hidden) e.value = effort
    }
  } catch (err) {
    msg.textContent = `切换失败：${err?.message ?? err}`
  } finally {
    btn.disabled = false
  }
}

/**
 * 注入预览的**场景**选择。
 *
 * 「场景」= 她这一轮在哪儿说话。只有两种：
 *   · 人物场景（`private:<人物编号>`）—— 跟某个人一对一
 *   · 群体场景（`group:<群体编号>`）—— 在某个群里
 *
 * 场景**不属于任何 App**。它不是"QQ 私聊""QQ 群"——换成微信、贴吧、Discord，
 * 场景还是这两类，变的只是人物卡/群体卡里记的账号。所以场景编号一律指向
 * **人物卡编号 / 群体卡编号**，真实号码（QQ 号、微博 uid、群号、吧名）只存在两张卡里。
 *
 * 这么做的理由很简单：两个不同 App 上的 `10001` 是两个人。把外部号码写进场景，
 * 等于让"新增一个平台"变成"改掉全部历史数据的语义"。
 *
 * 场景决定三件只跟这一轮有关的事：当前群体卡、在场人物卡、按场景叠加的规则。
 * 不选场景 = 通用预览：没有群体卡、没有人物卡。
 *
 * 为什么是下拉而不是输入框：手打场景名打错了，结果和"没有这个场景"长得一模一样
 * ——都是同一份通用预览，人看不出自己输错了。所以只列原始层里**真实出现过**的场景。
 */
const SCENE_LABELS = { private: '人物场景', group: '群体场景' }

function sceneLabel(scene, extra = '') {
  const [kind, ...rest] = String(scene).split(':')
  const tail = rest.join(':')
  const kindText = SCENE_LABELS[kind] ?? kind
  // 场景编号 = 人物编号 / 群体编号（内部编号）。截短显示，方便和人物页/群体页对。
  if (tail.startsWith('person_')) return `${kindText} · 人物 ${tail.slice(7, 15)}…${extra}`
  if (tail.startsWith('grp_')) return `${kindText} · 群体 ${tail.slice(4, 12)}…${extra}`
  // 旧格式：把外部号码直接当编号用。它不是"编号"，也认不到卡片——
  // 页面上要明说，否则人会以为"10001 是 QQ 号"，或者以为数据丢了。
  if (kind === 'private' || kind === 'group') return `${kindText} · 旧格式 ${tail}（无对应卡片）${extra}`
  return `${kindText} · ${tail}${extra}`
}

async function loadCardScenes() {
  const sel = $('card-scene')
  const hint = $('card-scene-hint')
  let scenes = []
  try {
    const d = await api('/api/scenes?days=90')
    scenes = d.scenes ?? []
  } catch {
    scenes = []
  }

  const keep = sel.value
  sel.innerHTML = ''
  const none = document.createElement('option')
  none.value = ''
  none.textContent = '（不带场景：通用预览）'
  sel.append(none)

  for (const c of scenes) {
    const o = document.createElement('option')
    o.value = c.scene
    o.textContent = `${sceneLabel(c.scene)}（${c.messages} 条${c.legacy ? `，${c.legacy} 条老写法` : ''}）`
    sel.append(o)
  }

  if (keep && [...sel.options].some((o) => o.value === keep)) sel.value = keep

  hint.textContent = scenes.length
    ? `场景决定三件事：当前群体卡、这一轮在场的人物卡、按场景叠加的规则。共 ${scenes.length} 个真实场景（近 90 天）。编号指向人物卡/群体卡，不是 QQ 号或群号——所以新增一个平台不会串号。`
    : '原始层里还没有任何场景记录，所以只能看通用预览：没有群体卡、没有人物卡。等收到第一条真实消息后，这里会出现具体场景。'
  return scenes.length
}

async function loadCard() {
  const scene = $('card-scene').value
  const q = scene ? `?scene=${encodeURIComponent(scene)}` : ''
  const d = await api(`/api/card${q}`)
  $('card-out').textContent = d.text || '（空）'
  $('card-meta').textContent = `${d.bytes} 字节 / 预算 ${d.budget}${d.scene ? ` · ${sceneLabel(d.scene)}` : ' · 通用（不含群体与人物卡）'}`

  // 选了场景却和通用预览一样，必须说清为什么——否则人会以为"选了没用"或功能坏了
  const note = $('card-scene-note')
  const info = d.sceneInfo ?? null
  if (d.scene && !info) {
    // 接口没给这个字段：几乎一定是后端还是旧代码（静态页刷新就生效，后端要重启）。
    // 不报错就等于让人对着"没反应"猜。
    note.textContent = '⚠ 这个接口没返回场景解析结果（sceneInfo）：后端可能还是旧代码，重启 DSH 再试'
    note.classList.add('dirty')
  } else if (d.scene && !info.resolved) {
    note.textContent = `⚠ 这个场景没解析到人物/群体，所以内容和不选一样：${info.reason}`
    note.classList.add('dirty')
  } else if (d.scene && info.resolved) {
    note.textContent = `✓ ${info.reason}`
    note.classList.remove('dirty')
  } else {
    note.textContent = ''
    note.classList.remove('dirty')
  }
}

// ── 人格 → 概况 ────────────────────────────────────────────────────────
//
// 一页两件事：**一张人格卡**（改了不点保存不算数）+ **一段注入预览**。
//
// "她真正读到的"没有单独一列：每一节标题右边直接写"她会读到：…"，因为能改的东西
// 和它的效果必须挨着——分成两页，人就得来回对，对两次就懒得对了。
//
// 底稿的生效面（Q2=A / Q3=A）：SELF.md 三段 + lines.md（[硬线]）+ style.md（[习惯]）进上下文。
// `persona/user.md`（"用户画像"）已经整个删掉了——它从来没被任何代码读写，
// 而"关于你"这件事由**记忆事实 + 人物卡**覆盖，不需要第三份。
const PERSONA_FILE_HINT = {
  self: '三段进上下文；其余段落只给人看。骨架只有人能改——她永远动不了这一页。',
  lines: '会整段进上下文——代码在拦的那条（guardrails.json）她看不见，这段是让她知道边界。',
  style:
    '这是**她自己也能改**的一层：她可以用工具直接增删，人也可以在这里手改，提案批准也写这里。' +
    '每一条都会进上下文（最多 8 条 / 240 字节）。注意：回滚某条提案会把整个文件退回应用前那一版，中间的直改会一起被覆盖。',
}

function markDirty() {
  const msg = $('persona-save-msg')
  msg.textContent = '有改动，还没保存'
  msg.classList.add('dirty')
}

function sectionBlock(s, areas) {
  const sect = el('div', 'sect')
  const sh = el('div', 'sect-head')
  sh.append(el('span', 'sect-title', s.title))
  if (s.injected) {
    // 比的是**她真正读到的那一行**，不是这一节的字节数——
    // 一节里可能只有两条被抽走（核心身份只取名字/存在的原因），拿整节去比会误报超预算。
    const over = s.lineBytes > s.budget
    sh.append(el('span', `tag ${over ? 'bad' : 'ok'}`, `${s.lineBytes}/${s.budget} 字节`))
    if (!s.line) sh.append(el('span', 'tag warn', '这一节没抽出可用内容（空着，或还是 &lt;占位符&gt;）'))
  } else {
    sh.append(el('span', 'tag', '不进上下文'))
  }
  sect.append(sh)
  if (s.injected && s.line) sect.append(el('div', 'muted small mono-line', `她会读到：${s.line}`))

  const ta = document.createElement('textarea')
  ta.rows = Math.min(12, Math.max(3, s.body.split('\n').length + 1))
  ta.value = s.body
  ta.dataset.title = s.title
  ta.placeholder = `## ${s.title}`
  ta.addEventListener('input', markDirty)
  sect.append(ta)
  areas.push(ta)
  return sect
}

function fileBlock(f, form) {
  const wrap = el('div', 'card')
  const head = el('div', 'card-head')
  head.append(el('h3', undefined, f.label))
  // 骨架不挂整体标签：它四节里只有三节进上下文，逐节标更准
  if (f.key !== 'self') {
    head.append(el('span', f.injected ? 'tag ok' : 'tag', f.injected ? '进上下文' : '不进上下文'))
    if (f.injected && f.budget) {
      const over = f.lineBytes > f.budget
      const empty = !f.line
      head.append(el('span', `tag ${over ? 'bad' : empty ? 'warn' : 'ok'}`, empty ? '还没有内容' : `${f.lineBytes}/${f.budget} 字节`))
    }
  }
  wrap.append(head)
  wrap.append(el('div', 'muted small', PERSONA_FILE_HINT[f.key] ?? f.note))
  wrap.append(el('div', 'muted small', f.path))

  if (!f.exists) {
    wrap.append(el('div', 'zone-empty', '文件不存在。这个版本不会替你新建底稿。'))
    return wrap
  }

  if (f.key === 'self') {
    for (const s of f.sections) wrap.append(sectionBlock(s, form.self))
    return wrap
  }

  // lines.md / style.md 没有 `## 小节`，就是一段话：整篇编辑
  if (f.injected && f.line) {
    wrap.append(el('div', 'muted small mono-line', `她会读到：${f.line}`))
  } else if (f.injected && f.key === 'style') {
    wrap.append(
      el(
        'div',
        'muted small',
        '这里还空着：写一条就是一条习惯（每行一条），或者等「人格塑造」里采纳的提案自动写进来。写进来的会进上下文。',
      ),
    )
  }
  const ta = document.createElement('textarea')
  ta.rows = Math.min(14, Math.max(4, f.text.split('\n').length))
  ta.value = f.text
  ta.addEventListener('input', markDirty)
  form.texts[f.key] = ta
  wrap.append(ta)
  return wrap
}

async function loadOverview() {
  hidePageError()
  const say = $('persona-save-msg')
  say.textContent = '改了不点保存不算数'
  say.classList.remove('dirty')

  const d = await api('/api/persona')
  state.personaList = d.personas ?? []
  const card = d.card
  const form = { card, self: [], texts: {}, nameEl: null }
  state.cardForm = form

  const box = $('persona-files')
  box.innerHTML = ''

  if (!card) {
    $('persona-active-tag').textContent = '还没有人格'
    $('persona-meta').textContent = '先跑 yuanling init'
    return
  }

  $('persona-active-tag').textContent = `● ${card.name}`
  $('persona-meta').textContent = `（${card.id}）· personas/${card.id} · 建于 ${String(card.created_at ?? '').replace('T', ' ').slice(0, 19)}`

  // 名称是卡的一部分：单独一张，放在卡最上面。
  // 名称可以**有多个**（空格分隔），任一个都能把她叫醒；人格 id 才是唯一标识。
  const nameCard = el('div', 'card')
  const nh = el('div', 'card-head')
  nh.append(el('h3', undefined, '名称'))
  nh.append(el('span', 'muted small', '可以有多个名称，用空格分开（例：原灵 小灵）；保存时会一起改 persona.json、人格清单、骨架标题'))
  nameCard.append(nh)
  const nameIn = document.createElement('input')
  nameIn.placeholder = '名称（多个用空格分开）'
  nameIn.value = card.name
  nameIn.addEventListener('input', markDirty)
  form.nameEl = nameIn
  const row = el('div', 'field-row')
  row.append(nameIn)
  nameCard.append(row)
  box.append(nameCard)

  for (const f of card.files) box.append(fileBlock(f, form))

  // 卡下面就是注入预览。它是 preview：算得出她会读到什么，但**不改她的状态**
  // （不记 offered、不挖新的、不判过期）——翻几遍管理台不该把一件事翻成"她不想提"。
  await loadCardScenes().catch(() => {})
  await loadCard().catch(() => {})
}

async function saveOverview() {
  const form = state.cardForm
  const msg = $('persona-save-msg')
  if (!form?.card) {
    msg.textContent = '还没有人格可保存'
    return
  }
  const btn = $('persona-save')
  btn.disabled = true
  msg.textContent = '保存中…'

  let done = '没有改动'
  try {
    const files = []
    for (const f of form.card.files) {
      if (!f.editable) continue
      if (f.key === 'self') {
        files.push({ file: 'self', sections: form.self.map((t) => ({ title: t.dataset.title, body: t.value })), expect: f.expect })
      } else if (form.texts[f.key]) {
        files.push({ file: f.key, text: form.texts[f.key].value, expect: f.expect })
      }
    }

    const name = form.nameEl?.value.trim() ?? ''
    const renamed = Boolean(name) && name !== form.card.name
    if (form.nameEl && !name) throw new Error('名字不能为空')

    const r = await postApi('/api/persona/save', { files })
    if (renamed) await postApi('/api/persona/rename', { name })
    if (r.changed || renamed) {
      done = `✓ 已保存${renamed ? `（名字改成「${name}」）` : ''}—— 进版本历史，可在「框架 → 日志 → 只看写入」里回滚`
    }
  } catch (err) {
    const stale = String(err.message).includes('被改过')
    await loadOverview()
    msg.textContent = stale ? '文件在你打开之后被改过——已重新加载，请再改一次' : `保存失败：${err.message}`
    msg.classList.add('dirty')
    btn.disabled = false
    return
  }

  await loadOverview()
  await loadStatus()
  msg.textContent = done
  msg.classList.remove('dirty')
  btn.disabled = false
}

// ── 新建 / 切换：都是弹窗 ──────────────────────────────────────────────
function openNewPersona() {
  for (const id of ['pn-name', 'pn-id', 'pn-reason', 'pn-tone', 'pn-tic', 'pn-avoid', 'pn-values']) $(id).value = ''
  $('pn-copy').checked = false
  $('pn-msg').textContent = ''
  $('persona-new-modal').hidden = false
  $('pn-name').focus()
}

async function submitNewPersona() {
  const name = $('pn-name').value.trim()
  const id = $('pn-id').value.trim()
  const msg = $('pn-msg')
  if (!name) {
    msg.textContent = '名字要填'
    return
  }
  if (!/^[a-z0-9][a-z0-9_-]{1,31}$/.test(id)) {
    msg.textContent = '目录名：小写字母/数字/-/_，2-32 位，例如 xiaoyu'
    return
  }

  const btn = $('pn-ok')
  btn.disabled = true
  msg.textContent = '正在建目录…'
  try {
    const values = $('pn-values')
      .value.split('\n')
      .map((s) => s.trim())
      .filter(Boolean)

    const r = await postApi('/api/persona/create', {
      id,
      name,
      from: $('pn-copy').checked ? 'copy' : '',
      card: {
        reason: $('pn-reason').value,
        tone: $('pn-tone').value,
        tic: $('pn-tic').value,
        avoid: $('pn-avoid').value,
        values,
      },
    })

    msg.textContent = '已建好，正在切过去…'
    await postApi('/api/persona/switch', { id: r.id })
    $('persona-new-modal').hidden = true
    await loadStatus()
    state.tabByMode.persona = 'overview'
    await openTab('overview')
    $('persona-save-msg').textContent = `✓ 已新建并切到「${r.name || r.id}」（personas/${r.id}/）`
  } catch (err) {
    msg.textContent = `失败：${err.message}`
  } finally {
    btn.disabled = false
  }
}

function openSwitchPersona() {
  const list = $('ps-list')
  list.innerHTML = ''
  $('ps-msg').textContent = ''

  const personas = state.personaList ?? []
  if (!personas.length) {
    list.append(el('div', 'zone-empty', '这台机器上只有一个人格。'))
  }

  for (const p of personas) {
    const row = el('div', 'item' + (p.active ? ' is-current' : ''))
    const body = el('div', 'body')
    const t = el('div', 't')
    if (p.active) t.append(el('span', 'tag ok', '当前'))
    t.append(document.createTextNode(p.name))
    body.append(t, el('div', 's', `${p.id} · personas/${p.id}/${p.dirExists ? '' : ' · 目录缺失，切不了'}`))
    row.append(body)

    const acts = el('div', 'actions')
    const btn = el('button', 'btn small ghost', p.active ? '已经是它' : '切到它')
    btn.disabled = Boolean(p.active) || !p.dirExists
    btn.addEventListener('click', () => switchTo(p.id))
    acts.append(btn)
    row.append(acts)
    list.append(row)
  }

  $('persona-switch-modal').hidden = false
}

async function switchTo(id) {
  const msg = $('ps-msg')
  msg.textContent = '正在切换…'
  try {
    const r = await postApi('/api/persona/switch', { id })
    $('persona-switch-modal').hidden = true
    await loadStatus()
    state.tabByMode.persona = 'overview'
    await openTab('overview')
    $('persona-save-msg').textContent = r.changed ? `✓ 已切到 ${id}` : `本来就是 ${id}`
  } catch (err) {
    msg.textContent = `失败：${err.message}`
  }
}

// ── 人格 → 动机 ────────────────────────────────────────────────────────
const NEED_LABELS = {
  connect: '想陪',
  care: '想关心',
  curiosity: '好奇',
  share: '想分享',
  identity: '想被记住',
}

/** 主动开口的待发队列：她"想说、还没说出口"的话。 */
async function loadOutbox() {
  const d = await api('/api/outbox')
  $('outbox-count').textContent =
    `待发 ${d.counts.pending} · 压着 ${d.counts.held} · 已发 ${d.counts.sent} · 取消 ${d.counts.dropped}`

  const box = $('outbox-out')
  box.innerHTML = ''
  const live = d.items.filter((x) => x.status === 'pending' || x.status === 'held')
  if (!live.length) {
    box.append(el('div', 'muted small', '现在没有待发的话。她只在"有到期的事 + 相关动机够强"时才会想开口。'))
    return
  }
  for (const it of live) {
    const n = el('div', 'item')
    const body = el('div', 'body')
    const t = el('div', 't')
    const tags = el('span')
    tags.append(el('span', 'tag', it.needName))
    tags.append(el('span', it.status === 'pending' ? 'tag ok' : 'tag warn', it.status === 'pending' ? '待发' : '压着'))
    // 发在哪、要不要 @ 谁，一眼要能看出来
    const where = it.scene.startsWith('group:') ? `群 ${it.scene.slice(6, 14)}…` : `私聊 ${it.scene.slice(8, 16)}…`
    if (it.target?.name) tags.append(el('span', 'tag purple', `@${it.target.name}`))
    t.append(tags, document.createTextNode(it.text))
    body.append(t, el('div', 's', `${where} · 因为 ${it.why} · ${it.created}`))
    n.append(body)
    n.append(
      el('div', 'actions').appendChild(mkBtn('不要她说这句', 'small ghost', async () => {
        await postApi('/api/outbox/drop', { id: it.id, reason: '人为取消' })
        await loadOutbox()
      })).parentNode,
    )
    box.append(n)
  }
}

async function loadMotive() {
  const d = await api('/api/motive')

  const drives = $('motive-drives')
  drives.innerHTML = ''
  const vals = d.drives?.values ?? {}
  const rows = (d.drives?.needs ?? []).map((need) => ({ id: need, label: NEED_LABELS[need] ?? need, custom: false }))
  for (const c of d.drives?.custom ?? []) rows.push({ id: c.id, label: c.name, custom: true, keywords: c.keywords })
  for (const row of rows) {
    const v = Number(vals[row.id] ?? 0)
    const line = el('div', 'drive-row')
    const name = el('span', 'drive-name', row.label)
    if (row.custom) name.append(el('span', 'tag', '自定义'))
    line.append(name)
    const meter = el('span', 'meter')
    const fill = el('span', 'meter-fill')
    fill.style.width = `${Math.round(Math.min(1, v) * 100)}%`
    meter.append(fill)
    line.append(meter, el('span', 'drive-val', `${Math.round(v * 100)}%`))
    drives.append(line)
    if (row.keywords?.length) {
      // 关键词是它唯一会自己升温的来源，摆在明面上
      drives.append(el('div', 'muted small', `听到这些会更有劲：${row.keywords.join('、')}`))
    }
  }
  $('motive-drives-at').textContent = d.drives?.at
    ? `上次刷新 ${String(d.drives.at).replace('T', ' ').slice(0, 19)}（注入时会自动强度衰减）`
    : '还没有记录：她还没和人说过话'

  $('motive-count').textContent = `挂着的 ${d.counts.open} 条 · 已放下 ${d.counts.done} · 过期 ${d.counts.dropped}`
  $('motive-rules').textContent =
    `一轮最多摆 ${d.rules.limit} 条；同一条 ${d.rules.recentHours} 小时内不重复；` +
    `她说过 ${d.rules.maxHits} 次，或摆了 ${d.rules.maxOffered} 次一次都没接，就自动放下。`

  const out = $('motive-out')
  out.innerHTML = ''
  if (!d.items.length) {
    out.append(el('div', 'muted small', '还没有。动机是从记忆里挖出来的：有情绪、或带着"以后怎么样"的事实，放几天才会变成一条。'))
    return
  }

  const STATUS = { open: ['', '挂着'], done: ['ok', '已放下'], dropped: ['warn', '过期'] }
  for (const p of d.items) {
    const n = el('div', 'item')
    const body = el('div', 'body')
    const t = el('div', 't')
    const tags = el('span')
    const [cls, label] = STATUS[p.status] ?? ['', p.status]
    tags.append(el('span', `tag ${cls}`.trim(), label))
    const needLabel = NEED_LABELS[p.need] ?? (d.drives?.custom ?? []).find((c) => c.id === p.need)?.name ?? p.need ?? '—'
    tags.append(el('span', 'tag purple', needLabel))
    t.append(tags, document.createTextNode(p.text))
    body.append(t)

    const bits = [`说过 ${p.hits} 次 / 摆过 ${p.offered} 次`]
    if (p.topic) bits.push(`主题「${p.topic}」`)
    if (p.origin) bits.push(p.origin)
    body.append(el('div', 's', bits.join(' · ')))
    if (p.closeReason) body.append(el('div', 's', `放下原因：${p.closeReason}`))
    n.append(body)

    if (p.status === 'open') {
      const acts = el('div', 'actions')
      acts.append(
        mkBtn('放下', 'small ghost', async () => {
          await postApi('/api/purpose/close', { id: p.id, reason: '人为放下' })
          await loadMotive()
        }),
      )
      n.append(acts)
    }
    out.append(n)
  }

  await loadOutbox()
}

async function loadMemory() {
  // 一页两视图：按词搜 / 按目录翻。数据同源（spaces/），视图不同。
  if (state.memoryView === 'entries') return loadEntries()

  const q = $('mem-q').value.trim()
  const all = $('mem-all').checked ? '1' : '0'
  const d = await api(`/api/memory?q=${encodeURIComponent(q)}&all=${all}&limit=20`)
  const box = $('mem-out')
  box.innerHTML = ''
  if (!d.hits.length) {
    box.append(el('div', 'muted small', '没有命中。可能没记过，或换个说法。'))
    return
  }
  for (const h of d.hits) {
    const n = el('div', 'item')
    const body = el('div', 'body')
    const t = el('div', 't')

    const tags = el('span')
    tags.append(el('span', 'tag', h.topic))
    // 规则提炼出来的事实：误报总是有的，标出来人才能一眼筛掉
    if (h.kind === 'extracted') tags.append(el('span', 'tag', '提炼'))
    if (h.band) tags.append(el('span', 'tag purple', h.band))
    if (h.until) tags.append(el('span', 'tag warn', '已失效'))
    if (h.shielded) tags.append(el('span', 'tag bad', '已隔离'))
    t.append(tags, document.createTextNode(h.text))

    body.append(t, el('div', 's', `${h.score} · ${h.clarity} · ${h.src}`))
    n.append(body)

    const rawId = String(h.src || '').split('#').pop()
    if (rawId && h.src.startsWith('raw/')) {
      const acts = el('div', 'actions')
      acts.append(
        mkBtn('屏蔽', 'small danger', async () => {
          if (!confirm(`屏蔽这条原始记录？\n\n${h.src}\n\nraw 不会被删除，只在所有出口隔离；可撤销。`)) return
          const r = await postApi('/api/shield', { targets: [rawId], reason: '管理台手动屏蔽' })
          alert(`已屏蔽；级联隔离 ${r.cascaded.length} 条记忆`)
          await loadMemory()
        }),
      )
      n.append(acts)
    }
    box.append(n)
  }
}

async function loadEntries() {
  const d = await api('/api/entries')
  const box = $('entries-out')
  box.innerHTML = ''
  if (!d.entries.length) {
    box.append(el('div', 'muted small', '还没有任何条目。'))
    return
  }
  for (const e of d.entries) {
    const n = el('div', 'item')
    const body = el('div', 'body')
    body.append(el('div', 't', `${e.space} / ${e.topic}`))
    body.append(el('div', 's', `${e.facts} 条事实（${e.active} 条有效）${e.summary ? ' · ' + e.summary : ''}`))
    n.append(body)
    box.append(n)
  }
}

async function loadProposals() {
  const d = await api('/api/proposals')
  const box = $('proposals-out')
  box.innerHTML = ''
  if (!d.proposals.length) {
    box.append(el('div', 'muted small', '还没有提案。点右上角「扫描新提案」试试。'))
    return
  }
  const tagOf = { pending: ['warn', '待定'], approved: ['ok', '已生效'], rejected: ['bad', '已否决'], rolled_back: ['', '已回滚'] }
  for (const p of d.proposals) {
    const n = el('div', 'item')
    const body = el('div', 'body')
    const t = el('div', 't')
    const [cls, label] = tagOf[p.status] || ['', p.status]
    t.append(el('span', `tag ${cls}`.trim(), label), document.createTextNode(p.claim))
    body.append(t, el('div', 's', `重复 ${p.count} 次 / ${p.days} 天 · 主题「${p.topic}」`))
    n.append(body)

    const acts = el('div', 'actions')
    if (p.status === 'pending') {
      acts.append(
        mkBtn('采纳', 'small', async () => {
          await postApi('/api/proposal', { id: p.id, action: 'approve' })
          await loadProposals()
        }),
        mkBtn('否决', 'small danger', async () => {
          if (!confirm(`否决这条提案？\n${p.claim}\n\n否决后不会再被自动批准。`)) return
          await postApi('/api/proposal', { id: p.id, action: 'reject' })
          await loadProposals()
        }),
      )
    } else if (p.status === 'approved') {
      acts.append(
        mkBtn('回滚', 'small ghost', async () => {
          if (!confirm(`把「${p.claim}」从 style.md 撤掉？`)) return
          await postApi('/api/proposal', { id: p.id, action: 'rollback' })
          await loadProposals()
        }),
      )
    }
    if (acts.childNodes.length) n.append(acts)
    box.append(n)
  }
}

// ── 通用弹窗：新增/编辑人物与群体都走它 ────────────────────────────────
//
// 三家共用一套：标题 + 若干字段 + 保存/取消。取消 = 什么都不做（不是"清空表单"），
// 所以状态全在这个闭包里，关一次就没了。
const MODAL = { submit: null }

function fieldNode(f, inputs) {
  const row = el('div', 'modal-field')
  row.append(el('label', 'modal-label', f.label))
  let node
  if (f.type === 'textarea') {
    node = document.createElement('textarea')
    node.rows = f.rows ?? 4
  } else if (f.type === 'select') {
    node = document.createElement('select')
    for (const [v, label] of f.options ?? []) {
      const o = document.createElement('option')
      o.value = v
      o.textContent = label
      node.append(o)
    }
  } else if (f.type === 'static') {
    node = el('div', 'modal-static', String(f.value ?? ''))
  } else {
    node = document.createElement('input')
    node.type = 'text'
  }
  if (node.value !== undefined && f.type !== 'static') node.value = f.value ?? ''
  if (f.placeholder && node.placeholder !== undefined) node.placeholder = f.placeholder
  if (f.readonly && node.readOnly !== undefined) node.readOnly = true
  if (f.mono) node.classList.add('mono-line')
  row.append(node)
  if (f.hint) row.append(el('div', 'muted small', f.hint))
  if (f.key) inputs[f.key] = node
  return row
}

/**
 * @param {{title:string, fields:Array, okText?:string, onSubmit:(v:object)=>Promise<void>}} spec
 */
function openModal({ title, fields, okText = '保存', onSubmit, onMount }) {
  $('modal-title').textContent = title
  $('modal-ok').textContent = okText
  $('modal-msg').textContent = ''
  $('modal-msg').classList.remove('dirty')

  const body = $('modal-body')
  body.innerHTML = ''
  const inputs = {}
  for (const f of fields) body.append(fieldNode(f, inputs))
  if (typeof onMount === 'function') onMount({ body, inputs })

  MODAL.submit = async () => {
    const vals = {}
    for (const [k, node] of Object.entries(inputs)) vals[k] = node.value
    await onSubmit(vals)
  }
  $('modal').hidden = false
  const first = Object.values(inputs)[0]
  if (first?.focus) first.focus()
}

function closeModal() {
  MODAL.submit = null
  $('modal').hidden = true
}

async function submitModal() {
  if (!MODAL.submit) return
  const ok = $('modal-ok')
  ok.disabled = true
  try {
    await MODAL.submit()
    closeModal()
  } catch (err) {
    // 错在弹窗里显示：关掉再报，用户填的东西就白填了
    $('modal-msg').textContent = String(err?.message ?? err)
    $('modal-msg').classList.add('dirty')
  } finally {
    ok.disabled = false
  }
}

/** 权重那一行：只读展示，不可编辑（权重只能由互动/名次决定）。 */
function weightField(row) {
  const bits = [`当前生效：${row.weight}`]
  if (row.weightKind === 'pinned') {
    bits.push(`重要第 ${Number(row.rank ?? 0) + 1} 名`)
    bits.push('落盘权重：' + row.storedWeight)
    bits.push('取消重要后，落盘的权重会重新生效')
  } else {
    bits.push('由互动推算，不能手改')
  }
  return { label: '权重', type: 'static', value: bits.join(' · ') }
}

function personCard(p, { onMove } = {}) {
  const n = el('div', 'item')
  const body = el('div', 'body')
  const head = el('div', 't')
  const tags = el('span')
  if (p.admin) tags.append(el('span', 'tag purple', '管理员'))
  if (p.pinned) tags.append(el('span', 'tag ok', `重要 #${Number(p.rank ?? 0) + 1}`))
  tags.append(el('span', p.weightKind === 'pinned' ? 'tag ok' : 'tag', String(p.weight)))
  head.append(tags, document.createTextNode(p.display))

  const accts = (p.accounts ?? []).map((a) => `${a.app}:${a.nativeId}`).join('、') || '无账户'
  const names = (p.nicknames ?? []).join(' / ')
  const firstMet = p.firstMet ? `初识 ${String(p.firstMet).slice(0, 10)}` : ''
  const desc = (p.accounts ?? [])
    .map((a) => String(a.description ?? '').split('\n').filter((l) => !l.startsWith('好友备注：')).join(' '))
    .filter(Boolean)
    .join(' / ')
  body.append(
    head,
    el('div', 's', [names, accts, firstMet, p.description ? p.description.slice(0, 40) : '', desc ? `账户：${desc}` : ''].filter(Boolean).join(' · ')),
    el('div', 's muted small', `权重 ${p.weight} = ${(p.accounts ?? []).map((a) => `${a.nativeId}:${a.weight}`).join(' + ') || '0'}`),
  )
  n.append(body)

  const acts = el('div', 'actions')
  // 管理员固定在 dsh:master（安装时建的第一张卡）：没有「设为管理员 / 卸任」这两个按钮了。

  if (p.pinned) {
    acts.append(
      mkBtn('↑', 'small ghost', () => onMove?.(p, 'up')),
      mkBtn('↓', 'small ghost', () => onMove?.(p, 'down')),
      mkBtn('取消重要', 'small ghost', async () => {
        await postApi('/api/person/pin', { uid: p.uid, pinned: false })
        await loadPeople()
      }),
    )
  } else if (!p.admin) {
    acts.append(
      mkBtn('设为重要', 'small ghost', async () => {
        await postApi('/api/person/pin', { uid: p.uid, pinned: true })
        await loadPeople()
      }),
      ...(p.audience === 'allow' ? [] : [mkBtn('设为白名单', 'small ghost', async () => {
        await setAudienceMember('people', p.uid, 'allow')
        await loadPeople()
        flash(`已把「${p.display}」加入白名单`)
      })]),
      ...(p.audience === 'deny' ? [] : [mkBtn('设为黑名单', 'small danger', async () => {
        await setAudienceMember('people', p.uid, 'deny')
        await loadPeople()
        flash(`已把「${p.display}」加入黑名单`)
      })]),
    )
  }
  acts.append(mkBtn('编辑', 'small ghost', () => openPersonEditor(p)))
  // 账户：每个号一张卡，点开单独改昵称/描述
  for (const a of p.accounts ?? []) {
    acts.append(mkBtn(`账户 ${a.nativeId}`, 'small ghost', () => openAccountEditor(a)))
  }
  acts.append(mkBtn('合并', 'small ghost', () => openMergeDialog(p)))
  n.append(acts)
  return n
}

async function openAccountEditor(a) {
  const d2 = await api(`/api/account?uid=${encodeURIComponent(a.uid)}`)
  const card = d2.account
  openModal({
    title: `账户 ${card.app}:${card.nativeId}`,
    fields: [
      { key: 'nicknames', label: '昵称（空格分隔可多个）', value: (card.nicknames ?? []).join(' ') },
      {
        key: 'description',
        label: '账户描述',
        type: 'textarea',
        rows: 6,
        value: card.description ?? '',
        hint: '好友备注写在这里（「好友备注：…」一行）；上限 2000 字。人物描述由所有账户描述合并而成',
      },
      { label: '权重（只读）', type: 'static', value: `${card.weight ?? 0} · 统计 ${card.stats?.messages ?? 0} 条 / ${card.stats?.activeDays ?? 0} 天` },
    ],
    onSubmit: async (v) => {
      await postApi('/api/account/update', {
        uid: a.uid,
        nicknames: String(v.nicknames ?? '').split(/\s+/).filter(Boolean),
        description: v.description,
      })
      invalidatePicker()
      await loadPeople()
    },
  })
}

async function openPersonEditor(p) {
  const d2 = await api(`/api/person?uid=${encodeURIComponent(p.uid)}`)
  const row = d2.weight ?? p
  const mainUid = d2.person.uid
  const members = (d2.accounts ?? []).filter((a) => a.uid !== mainUid)
  openModal({
    title: `${d2.person.display}（${p.uid}）`,
    fields: [
      { label: '账户', type: 'static', value: (d2.accounts ?? []).map((a) => `${a.app}:${a.nativeId}`).join('、') || '无' },
      { label: '初识', type: 'static', value: d2.person?.firstMet ? String(d2.person.firstMet).slice(0, 10) : '—' },
      {
        key: 'nicknames',
        label: '昵称（空格分隔可多个）',
        value: (d2.person?.nicknames ?? []).join(' '),
        hint: '改的是主卡的昵称；多个昵称用空格分开，列表里会用「 / 」连起来显示。不能为空。',
      },
      { key: 'description', label: '主卡账户描述', type: 'textarea', rows: 6, value: d2.person?.description || '', hint: '人物描述由所有成员卡的账户描述合并而成；这里改的是主卡自己的账户描述' },
      weightField(row),
    ],
    // 已经合并进来的账户：列在这里，可以手动分离（分离前确认）
    onMount: ({ body }) => {
      if (!members.length) return
      const box = el('div', 'modal-field')
      box.append(el('label', 'modal-label', `已合并的账户（${members.length}）`))
      for (const a of members) {
        const line = el('div', 'merged-row')
        const name = (a.nicknames ?? []).join(' / ') || '（没昵称）'
        line.append(el('span', 'merged-name', `${name} · ${a.app}:${a.nativeId}`))
        line.append(
          mkBtn('分离', 'small ghost', async () => {
            const ok = confirm(
              `把「${name}」（${a.app}:${a.nativeId}）从「${d2.person.display}」分离出去？\n\n` +
                '分离后它是一张独立的人物卡，账户描述和统计都跟着它走，不会删任何数据。',
            )
            if (!ok) return
            await postApi('/api/person/split', { person: mainUid, accounts: [a.uid] })
            invalidatePicker()
            closeModal()
            await loadPeople()
            flash(`已把「${name}」分离出去`)
            await openPersonEditor({ uid: mainUid })
          }),
        )
        box.append(line)
      }
      body.append(box)
    },
    onSubmit: async (v) => {
      const nicknames = String(v.nicknames ?? '').split(/\s+/).filter(Boolean)
      if (!nicknames.length) throw new Error('保存失败：昵称不能为空，至少填一个')
      await postApi('/api/person', { uid: p.uid, nicknames, description: v.description })
      invalidatePicker()
      await loadPeople()
    },
  })
}

async function openAccountCreate() {
  const picker = await loadPicker()
  const options = appOptionsOf(picker)
  if (!options.length) throw new Error('还没有模块上报 App；先安装一个模块')
  openModal({
    title: '新建人物',
    okText: '创建',
    fields: [
      { key: 'app', label: 'App', type: 'select', options, value: options[0][0] },
      { key: 'nativeId', label: '账户（id 或账户名）', placeholder: 'QQ 号 / B 站 UID / 米聊号' },
      { key: 'nickname', label: '账户昵称（空格分隔可多个）' },
      { key: 'description', label: '账户描述', type: 'textarea', rows: 4, placeholder: '好友备注 / 对这个号的印象（≤2000 字）' },
    ],
    onSubmit: async (v) => {
      const app = String(v.app ?? '')
      if (!/^[a-z0-9]{2,24}$/.test(app)) throw new Error('App 标识只能是小写字母和数字')
      await postApi('/api/account/create', {
        app,
        nativeId: v.nativeId,
        nickname: v.nickname,
        description: v.description,
      })
      invalidatePicker()
      await loadPeople()
    },
  })
}

// ── 选 App / 选账户（合并、群体加人共用）────────────────────────────────
//
// 一次请求拿齐（/api/picker），前端缓存 30 秒：这个弹窗点开就发 1 个请求，
// 换 App 只是内存过滤，不再每次去扫模块目录、也不再拉全部账户的统计/描述。
const PICKER_TTL_MS = 30_000
let pickerCache = null
let pickerAt = 0

async function loadPicker({ force = false } = {}) {
  if (!force && pickerCache && Date.now() - pickerAt < PICKER_TTL_MS) return pickerCache
  pickerCache = await api('/api/picker')
  pickerAt = Date.now()
  return pickerCache
}
function invalidatePicker() {
  pickerCache = null
}

function appOptionsOf(picker, extraApp = '') {
  const apps = (picker.apps ?? []).map((a) => [a.app, `${a.app}（${(a.modules ?? []).map((m) => m.name ?? m.id).join('、')}）`])
  if (extraApp && !apps.some(([v]) => v === extraApp)) apps.unshift([extraApp, `${extraApp}（模块没装）`])
  return apps
}

const isAdminAccount = (a) => String(a.app) === 'dsh' && String(a.nativeId) === 'master'

function accountLabel(a, { ownerOf = null } = {}) {
  const name = (a.nicknames ?? []).join(' / ') || a.nativeId
  const owner = ownerOf && a.person && a.person.uid !== ownerOf ? `（现在挂在「${a.person.display}」名下）` : ''
  return `${name} · ${a.app}:${a.nativeId}${owner}`
}

/** 把"App 下拉 + 账户下拉"接起来：换 App 就换账户列表。 */
function wireAppPicker({ inputs, pickable, ownerOf = null }) {
  const refill = () => {
    const app = String(inputs.app?.value ?? '')
    const list = pickable(app)
    inputs.account.innerHTML = ''
    if (!list.length) {
      inputs.account.append(new Option('（这个 App 下没有可选的账户）', ''))
      return
    }
    for (const a of list) inputs.account.append(new Option(accountLabel(a, { ownerOf }), a.uid))
  }
  inputs.app.addEventListener('change', refill)
  refill()
}

/**
 * 合并账户：两级选择。
 *   ① App —— 只列**已装模块上报**的 App（用户 2026-11-14 定）；
 *   ② 账户 —— 该 App 下的卡，显示"昵称 · 账号"，不显示卡 id；
 *      已经被合并进来的、以及管理员卡（dsh:master）不出现在列表里。
 * 一次合并一个；要合多个就再来一次。
 */
async function openMergeDialog(person) {
  const picker = await loadPicker()
  const apps = picker.apps ?? []
  const accounts = picker.accounts ?? []
  const mainUid = person.uid
  const mine = new Set((person.accounts ?? []).map((a) => a.uid))
  const pickable = (app) => accounts.filter((a) => String(a.app) === app && !mine.has(a.uid) && !isAdminAccount(a))
  if (!apps.length) throw new Error('还没有模块上报 App；先安装一个模块，或手动新建账户')

  openModal({
    title: `合并账户 → ${person.display}`,
    okText: '合并',
    fields: [
      { key: 'app', label: '第一步：选 App', type: 'select', options: appOptionsOf(picker), value: apps[0].app },
      { key: 'account', label: '第二步：选要合并进来的账户', type: 'select', options: [] },
    ],
    onMount: ({ inputs }) => wireAppPicker({ inputs, pickable, ownerOf: mainUid }),
    onSubmit: async (v) => {
      const uid = String(v.account ?? '')
      if (!uid) throw new Error('请选择要合并进来的账户')
      if (mine.has(uid)) throw new Error('这个账户已经在这个人身上了')
      await postApi('/api/person/merge', { accounts: [mainUid, uid] })
      invalidatePicker()
      await loadPeople()
    },
  })
}

async function openPersonCreate() {
  await openAccountCreate()
}

async function loadPeople() {
  const d = await api('/api/people')

  const adminSlot = $('admin-slot')
  adminSlot.innerHTML = ''
  const admins = d.people.filter((p) => p.admin)
  $('admin-count').textContent = admins.length ? `${admins.length} 人` : ''
  if (!admins.length) adminSlot.append(el('div', 'zone-empty', '还没有管理员卡：安装时应该自动建一张 dsh:master。没建出来就先新建一个 dsh 账户。'))
  for (const p of admins) adminSlot.append(personCard(p))

  // 「对管理员更温柔」是人格级偏好：没有人管理员时勾了也没意义，所以隐藏
  $('gentle-row').hidden = !admins.length
  $('gentle-admin').checked = Boolean(d.prefs?.gentleToAdmin)

  const pinnedSlot = $('pinned-slot')
  pinnedSlot.innerHTML = ''
  const pinned = d.people.filter((p) => p.pinned && !p.admin)
  $('pinned-count').textContent = pinned.length ? `${pinned.length} 人` : ''
  if (!pinned.length) pinnedSlot.append(el('div', 'zone-empty', '还没有重要人物。点下面任意一张卡上的「设为重要」。'))
  const move = async (p, direction) => {
    await postApi('/api/person/move', { uid: p.uid, direction })
    await loadPeople()
  }
  for (const p of pinned) pinnedSlot.append(personCard(p, { onMove: move }))

  const rest = d.people.filter((p) => !p.admin && !p.pinned)
  $('people-count').textContent = `${rest.length} 人`
  const box = $('people-out')
  box.innerHTML = ''
  if (!rest.length) box.append(el('div', 'muted small', '还没有好友。'))
  for (const p of rest) box.append(personCard(p))

  await loadAudience('people')
}

// ── 群体 ──────────────────────────────────────────────────────────────
//
// 群体和人物是并列的实体，但**不跨平台合并**：QQ 群和贴吧永远不是同一个地方。
// 描述全是自然语言（她自己总结、人也可以改），成员是事实，由核心从原始层归集。
const PLATFORM_LABELS = { qq: 'QQ 群', wechat: '微信群', tieba: '贴吧', bili: 'B 站' }

/**
 * 黑白名单的两个栏位（人物页 / 群体页共用）。
 *
 * 规矩（用户定）：只影响她**回不回话**，不影响接收；两开关互斥（都关 = 不限制）；
 * 管理员/重要人物、重点群体**永远在白名单里**，不能被设成黑名单——所以它们出现在
 * 「自动」那一组，而不是让人手动加。
 */
function renderAudience(kind, d) {
  const allowOn = $(`${kind}-allow-on`)
  const denyOn = $(`${kind}-deny-on`)
  allowOn.checked = d.mode === 'allow'
  denyOn.checked = d.mode === 'deny'
  $(`${kind}-allow-label`).textContent = d.mode === 'allow' ? '开' : '关'
  $(`${kind}-deny-label`).textContent = d.mode === 'deny' ? '开' : '关'

  // 横排胶囊：一个名字一个 chip，同名后面跟一个 ×（自动豁免的那组没有 ×，因为它删不掉）
  const chip = (r, { removable, auto }) => {
    const c = el('span', 'chip' + (auto ? ' is-auto' : ''))
    if (r.why) c.append(el('span', 'chip-why', r.why))
    c.append(el('span', 'chip-name', r.name || r.id))
    if (removable) {
      const x = document.createElement('button')
      x.type = 'button'
      x.className = 'chip-x'
      x.title = '移出名单'
      x.textContent = '×'
      x.addEventListener('click', async () => {
        x.disabled = true
        try {
          await postApi('/api/audience', { kind, action: 'remove', id: r.id })
          await loadAudience(kind)
        } catch (err) {
          x.disabled = false
          alert(`移出失败：${err.message}`)
        }
      })
      c.append(x)
    }
    return c
  }

  const fill = (box, chips, emptyText) => {
    box.innerHTML = ''
    if (!chips.length) {
      box.append(el('div', 'zone-empty', emptyText))
      return
    }
    for (const c of chips) box.append(c)
  }

  const allowChips = [
    ...(d.auto ?? []).map((r) => chip(r, { removable: false, auto: true })),
    // 兜底：万一后端把豁免的人漏进 allow（旧数据/竞态），前端也不给它 ×
    ...d.allow.map((r) => chip(r, { removable: !r.exempt, auto: Boolean(r.exempt) })),
  ]
  fill($(`${kind}-allow-list`), allowChips, '白名单是空的。')

  fill(
    $(`${kind}-deny-list`),
    d.deny.map((r) => chip(r, { removable: !r.exempt, auto: Boolean(r.exempt) })),
    '黑名单是空的。',
  )
}

async function loadAudience(kind) {
  const d = await api(`/api/audience?kind=${kind}`)
  renderAudience(kind, d)
  return d
}

async function setAudienceMode(kind, mode) {
  await postApi('/api/audience', { kind, action: 'mode', mode })
  await loadAudience(kind)
}

async function setAudienceMember(kind, id, list) {
  await postApi('/api/audience', { kind, action: 'add', id, list })
  await loadAudience(kind)
}

/** 开关事件绑定（人物页 / 群体页各一套）。 */
function wireAudience(kind) {
  $(`${kind}-allow-on`).addEventListener('change', (e) => {
    const on = e.target.checked
    setAudienceMode(kind, on ? 'allow' : 'off').catch((err) => alert(`切换失败：${err.message}`))
  })
  $(`${kind}-deny-on`).addEventListener('change', (e) => {
    const on = e.target.checked
    setAudienceMode(kind, on ? 'deny' : 'off').catch((err) => alert(`切换失败：${err.message}`))
  })
}

function flash(text) {
  const t = el('div', 'toast', text)
  document.body.append(t)
  setTimeout(() => t.remove(), 3200)
}

function groupCard(g) {
  const n = el('div', 'item')
  const body = el('div', 'body')
  const head = el('div', 't')
  const tags = el('span')
  tags.append(el('span', 'tag purple', PLATFORM_LABELS[g.platform] ?? g.platform))
  if (g.important) tags.append(el('span', 'tag ok', `重点 #${Number(g.rank ?? 0) + 1}`))
  tags.append(el('span', g.weightKind === 'pinned' ? 'tag ok' : 'tag', String(g.weight)))
  head.append(tags, document.createTextNode(g.name || g.gid))

  const bits = [g.gid]
  // 群体编号是内部编号（grp_xxx）；真实群号/吧名在卡里，显示出来才认得出是哪个群
  if (g.nativeId || g.id) bits.push(`${g.platform}:${g.nativeId || g.id}`)
  if (g.memberCount) bits.push(`成员 ${g.memberCount}`)
  if (g.feature) bits.push(g.feature.slice(0, 48))
  body.append(head, el('div', 's', bits.join(' · ')))
  n.append(body)

  const acts = el('div', 'actions')
  if (g.important) {
    acts.append(
      mkBtn('↑', 'small ghost', () => moveGroup(g, 'up')),
      mkBtn('↓', 'small ghost', () => moveGroup(g, 'down')),
      mkBtn('取消重点', 'small ghost', async () => {
        await postApi('/api/group/tier', { gid: g.gid, important: false })
        await loadGroups()
      }),
    )
  } else {
    acts.append(
      mkBtn('设为重点', 'small ghost', async () => {
        await postApi('/api/group/tier', { gid: g.gid, important: true })
        await loadGroups()
      }),
      // 白/黑名单只对"其余"群体开放：重点群体永远在白名单里。
      // 已经在某个名单里的群，对应那个按钮不再显示（用名单里的 × 移出）。
      ...(g.audience === 'allow' ? [] : [mkBtn('设为白名单', 'small ghost', async () => {
        await setAudienceMember('groups', g.gid, 'allow')
        await loadGroups()
        flash(`已把「${g.name || g.gid}」加入白名单`)
      })]),
      ...(g.audience === 'deny' ? [] : [mkBtn('设为黑名单', 'small danger', async () => {
        await setAudienceMember('groups', g.gid, 'deny')
        await loadGroups()
        flash(`已把「${g.name || g.gid}」加入黑名单`)
      })]),
    )
  }
  acts.append(mkBtn('编辑', 'small ghost', () => openGroupEditor(g)))
  n.append(acts)
  return n
}

async function moveGroup(g, direction) {
  await postApi('/api/group/move', { gid: g.gid, direction })
  await loadGroups()
}

async function loadGroups() {
  const d = await api('/api/groups')

  const imp = $('groups-important')
  imp.innerHTML = ''
  if (!d.important.length) imp.append(el('div', 'zone-empty', '还没有重点群体。点下面任意一个群上的「设为重点」。'))
  for (const g of d.important) imp.append(groupCard(g))

  $('groups-count').textContent = `共 ${d.total} 个群体`
  const box = $('groups-out')
  box.innerHTML = ''
  if (!d.groups.length) {
    box.append(
      el(
        'div',
        'muted small',
        d.total ? '没有其他群体了。' : '还没有任何群体档案。点「新增群体」，或等她在某个群里说过话。',
      ),
    )
  }
  for (const g of d.groups) box.append(groupCard(g))

  await loadAudience('groups')
}

async function openGroupEditor(g) {
  const [d, picker] = await Promise.all([api(`/api/group?gid=${encodeURIComponent(g.gid)}`), loadPicker()])
  const gg = d.group
  const memberUids = new Set((d.members ?? []).map((m) => m.uid))
  const appOpts = appOptionsOf(picker, gg.platform)
  const accounts = picker.accounts ?? []
  // 加人：只列还没在群里的账户（管理员那个号也排掉——它不是群里的人）
  const pickable = (app) =>
    accounts.filter((a) => String(a.app) === app && !isAdminAccount(a) && !(a.person && memberUids.has(a.person.uid)))
  const memberLine = (m) => {
    const acc = (m.accounts ?? [])[0]
    if (!acc) return m.display || m.uid
    // 用户看不懂卡 id：显示"第一个昵称 · App 账号"
    return `${acc.nickname || m.display || '（没昵称）'} · ${acc.app}:${acc.nativeId}`
  }

  openModal({
    title: `${gg.name || gg.gid}（${gg.gid}）`,
    fields: [
      { key: 'name', label: '名字', value: gg.name || '' },
      { key: 'app', label: 'App', type: 'select', options: appOpts, value: gg.platform },
      {
        key: 'account',
        label: '账户（群号 / 吧名 / 群 id）',
        value: gg.nativeId ?? gg.id ?? '',
        hint: '改号码会同步改身份登记；gid 不变，印象/成员/权重都留在原卡上。改号之前的群聊记录仍按旧号归档',
      },
      { key: 'feature', label: '群体描述', type: 'textarea', rows: 5, value: gg.feature || '' },
      weightField(gg),
    ],
    onMount: ({ body }) => {
      // ① 成员列表：一行一个，可以移除（先确认）
      const box = el('div', 'modal-field')
      box.append(el('label', 'modal-label', `群成员（${(d.members ?? []).length}${gg.memberCount ? ` / 共见过 ${gg.memberCount}` : ''}）`))
      if (!(d.members ?? []).length) box.append(el('div', 'muted small', '还没有成员：群里有人跟她说过话、或从下面手动加一个'))
      for (const m of d.members ?? []) {
        const line = el('div', 'merged-row')
        line.append(el('span', 'merged-name', memberLine(m)))
        line.append(
          mkBtn('移除', 'small ghost', async () => {
            if (!confirm(`把「${memberLine(m)}」从「${gg.name || gg.gid}」的成员里移除？\n\n（他下次在群里说话还会被自动加回来——成员名单记的是"谁在这里说过话"）`)) return
            await postApi('/api/group/member', { gid: g.gid, uid: m.uid, action: 'remove' })
            closeModal()
            await loadGroups()
            await openGroupEditor(g)
          }),
        )
        box.append(line)
      }
      body.append(box)

      // ② 加人：同样的两级选择（App → 账户）
      const add = el('div', 'modal-field')
      add.append(el('label', 'modal-label', '添加人物到群里'))
      const row = el('div', 'merged-row')
      const appSel = document.createElement('select')
      for (const [v, label] of appOpts) appSel.append(new Option(label, v))
      const accSel = document.createElement('select')
      appSel.addEventListener('change', () => fillAccounts(String(appSel.value)))
      function fillAccounts(app) {
        accSel.innerHTML = ''
        const list = pickable(app)
        if (!list.length) {
          accSel.append(new Option('（这个 App 下没有可加的人）', ''))
          return
        }
        for (const a of list) accSel.append(new Option(accountLabel(a), a.uid))
      }
      fillAccounts(String(appSel.value))
      row.append(appSel, accSel)
      row.append(
        mkBtn('添加', 'small ghost', async () => {
          const acc = accounts.find((a) => a.uid === String(accSel.value))
          if (!acc) throw new Error('先选一个账户')
          const person = acc.person?.uid
          if (!person) throw new Error('这个账户还没有对应的人物卡')
          await postApi('/api/group/member', { gid: g.gid, uid: person, action: 'add' })
          closeModal()
          await loadGroups()
          await openGroupEditor(g)
        }),
      )
      add.append(row)
      body.append(add)
    },
    onSubmit: async (v) => {
      await postApi('/api/group', {
        gid: g.gid,
        name: v.name,
        platform: String(v.app ?? ''),
        nativeId: String(v.account ?? '').trim(),
        feature: v.feature,
      })
      await loadGroups()
    },
  })
}

async function openGroupCreate() {
  const picker = await loadPicker()
  const appOpts = appOptionsOf(picker)
  if (!appOpts.length) throw new Error('还没有模块上报 App；先安装一个模块')
  openModal({
    title: '新增群体',
    okText: '创建',
    fields: [
      { key: 'name', label: '名字', placeholder: '怎么称呼这个群' },
      { key: 'app', label: 'App', type: 'select', options: appOpts, value: appOpts[0][0] },
      { key: 'account', label: '账户（群号 / 吧名 / 群 id）', placeholder: '123456789 / 原神吧 / abc@chatroom' },
      { key: 'feature', label: '群体描述', type: 'textarea', rows: 4, placeholder: '这个群是什么地方、什么氛围' },
      { label: '权重', type: 'static', value: '新建 0：只有群里有人 @她 / 叫她名字 / 引用她、她发言、别人接她话才涨' },
    ],
    onSubmit: async (v) => {
      const platform = String(v.app ?? '')
      const nativeId = String(v.account ?? '').trim()
      if (!platform) throw new Error('请选择 App')
      if (!nativeId) throw new Error('账户不能为空')
      await postApi('/api/group/create', { name: v.name, platform, nativeId, feature: v.feature })
      await loadGroups()
    },
  })
}

// ── 框架 → 规则 ────────────────────────────────────────────────────────
//
// 以前这页只有一个输入框 + 一个「查看」按钮，下面是整段 JSON。
// JSON 能看懂的人不需要这页；需要这页的人看不懂 JSON。所以改成按字段渲染的真表单：
// 每一项有中文标签、单位、范围、以及**它到底有没有在生效**。
//
// 那个**场景**选择器的作用不是"搜索"：规则是三层继承的（全局 → 群体 → 人物），
// 换个场景就换一条继承链，页面显示的"有效值"跟着变。但**保存只写全局层**——
// 把合并结果压平写回某一层，等于把继承悄悄改掉。
const RULE_INPUTS = { fields: new Map() }
/** 运行设置的输入框（跟数据目录走，不属于任何人格）。 */
const POLICY_INPUTS = new Map()

function ruleDirty() {
  const msg = $('rule-msg')
  msg.textContent = '有改动，还没保存'
  msg.classList.add('dirty')
}

function makeRuleInput(f, value) {
  if (f.type === 'bool') {
    const wrap = el('label', 'switch-row')
    const cb = document.createElement('input')
    cb.type = 'checkbox'
    cb.checked = value !== false && value !== 'false'
    cb.addEventListener('change', ruleDirty)
    const track = el('span', 'switch-track')
    track.append(el('span', 'switch-knob'))
    wrap.append(cb, track, el('span', 'small', cb.checked ? '开' : '关'))
    cb.addEventListener('change', () => {
      wrap.lastChild.textContent = cb.checked ? '开' : '关'
    })
    return { node: wrap, get: () => cb.checked }
  }

  if (f.type === 'enum') {
    const cb = document.createElement('select')
    for (const [v, label] of f.options ?? []) {
      const o = document.createElement('option')
      o.value = v
      o.textContent = label
      if (String(value) === v) o.selected = true
      cb.append(o)
    }
    cb.addEventListener('change', ruleDirty)
    return { node: cb, get: () => cb.value }
  }

  if (f.type === 'int') {
    const inp = document.createElement('input')
    inp.type = 'number'
    if (f.min !== null) inp.min = String(f.min)
    if (f.max !== null) inp.max = String(f.max)
    inp.value = String(value ?? '')
    inp.addEventListener('input', ruleDirty)
    return { node: inp, get: () => Number(inp.value) }
  }

  // ranges / list：都当"用逗号分隔的一串"处理，人不必记 JSON 数组语法
  const inp = document.createElement('input')
  inp.value = Array.isArray(value) ? value.join('，') : String(value ?? '')
  if (f.hint) inp.placeholder = f.hint
  inp.addEventListener('input', ruleDirty)
  return { node: inp, get: () => inp.value }
}

function ruleGroup(g, own, effective) {
  const card = el('div', 'card')
  const head = el('div', 'card-head')
  head.append(el('h3', undefined, g.group))
  head.append(el('span', g.honored ? 'tag ok' : 'tag warn', g.honored ? '生效' : '未生效'))
  card.append(head)
  card.append(el('div', 'muted small', g.desc))
  if (!g.honored && g.why) {
    card.append(el('div', 'muted small', `为什么标「未生效」：${g.why}`))
  }

  for (const f of g.fields) {
    const row = el('div', 'rule-row')
    const label = el('div', 'rule-label')
    label.append(el('span', f.label))
    if (f.hint) label.append(el('span', 'muted small', f.hint))

    const pick = (o) => f.path.split('.').reduce((cur, k) => (cur && typeof cur === 'object' ? cur[k] : undefined), o)
    const ownVal = pick(own)
    const effVal = pick(effective ?? {})
    const ctl = makeRuleInput(f, ownVal ?? f.def)
    row.append(label, ctl.node)

    // 选了场景之后，"这一层写的"和"实际生效的"可能不是一回事。
    // 不把差异说出来，人会以为自己写进去的被忽略了（其实是被更具体的层覆盖了）。
    if (effVal !== undefined && JSON.stringify(effVal) !== JSON.stringify(ownVal ?? f.def)) {
      const shown = Array.isArray(effVal) ? effVal.join('、') || '（空）' : String(effVal)
      row.append(el('div', 'muted small rule-eff', `当前有效值：${shown}（被更具体的层覆盖）`))
    }

    // 键是"点了保存才会写"的那个字段；值是一个取值函数
    RULE_INPUTS.fields.set(f.path, { get: ctl.get, def: f.def })
  }
  return card
}

async function loadRules() {
  // 规则页只管"当前人格的底层规则"。场景继承链的选择器已经删了：
  // 它只在"三层都能在页面上编辑"时才有意义，而群体/人物规则以后挪到各自页面。
  const d = await api('/api/rules')

  const box = $('rule-form')
  box.innerHTML = ''
  RULE_INPUTS.fields.clear()
  $('rule-msg').textContent = '改了不点保存不算数'
  $('rule-msg').classList.remove('dirty')

  for (const g of d.spec ?? []) box.append(ruleGroup(g, d.own ?? {}, d.rules ?? {}))

  await loadPolicy().catch(() => {})

  // 根级硬线：只读。它不是"规则"，是底线——页面上必须有，但不能从这里改。
  const gbox = $('rule-guardrails')
  gbox.innerHTML = ''
  const gr = d.guardrails ?? {}
  const rows = [
    ['永不记录（连原始层都不写）', gr.never_record],
    ['永不注入（记下来，但不进上下文）', gr.never_inject],
    ['永不执行（宣言）', gr.never_do],
  ]
  for (const [label, list] of rows) {
    const n = el('div', 'item')
    const body = el('div', 'body')
    body.append(el('div', 't', label))
    body.append(el('div', 's', Array.isArray(list) && list.length ? list.join('、') : '（空）'))
    n.append(body)
    gbox.append(n)
  }
}

/** 运行设置：跟数据目录走、不跟人格走，所以单独一块。 */
async function loadPolicy() {
  const d = await api('/api/policy')
  const box = $('policy-form')
  box.innerHTML = ''
  POLICY_INPUTS.clear()

  for (const f of d.fields ?? []) {
    const row = el('div', 'field-row')
    const label = el('label', 'small', f.label || f.key)
    if (f.hint) label.title = f.hint

    let input
    if (f.type === 'bool') {
      input = document.createElement('input')
      input.type = 'checkbox'
      input.checked = Boolean(f.value)
    } else if (f.type === 'enum') {
      input = document.createElement('select')
      for (const v of f.values ?? []) {
        const o = document.createElement('option')
        o.value = v
        o.textContent = v
        input.append(o)
      }
      input.value = String(f.value ?? '')
    } else if (f.type === 'number') {
      input = document.createElement('input')
      input.type = 'number'
      if (f.min != null) input.min = String(f.min)
      if (f.max != null) input.max = String(f.max)
      input.value = String(f.value ?? '')
    } else {
      input = document.createElement('input')
      input.value = String(f.value ?? '')
    }

    row.append(label, input)
    if (f.restart) row.append(el('span', 'tag', '重启后生效'))
    if (f.hint) row.append(el('span', 'muted small', f.hint))
    box.append(row)
    POLICY_INPUTS.set(f.key, { type: f.type, el: input })
  }
  $('policy-msg').textContent = ''
}

async function savePolicy() {
  const msg = $('policy-msg')
  const btn = $('policy-save')
  const patch = {}
  for (const [key, io] of POLICY_INPUTS) {
    patch[key] = io.type === 'bool' ? io.el.checked : io.el.value
  }
  btn.disabled = true
  msg.textContent = '保存中…'
  try {
    const r = await postApi('/api/policy', { patch })
    await loadPolicy()
    msg.textContent = r.changed?.length ? `✓ 已保存：${r.changed.join('、')}` : '没有改动'
  } catch (err) {
    msg.textContent = `保存失败：${err.message}`
  } finally {
    btn.disabled = false
  }
}

async function saveRules() {
  const msg = $('rule-msg')
  const btn = $('rule-save')
  btn.disabled = true
  msg.textContent = '保存中…'

  const patch = {}
  for (const [pathKey, io] of RULE_INPUTS.fields) patch[pathKey] = io.get()

  try {
    const r = await postApi('/api/rules', { patch })
    await loadRules()
    msg.textContent = r.changed
      ? `✓ 已保存${r.dropped?.length ? `（${r.dropped.length} 个未知字段被忽略：${r.dropped.join('、')}）` : ''}`
      : '没有改动'
  } catch (err) {
    msg.textContent = `保存失败：${err.message}`
    msg.classList.add('dirty')
  } finally {
    btn.disabled = false
  }
}

async function loadUsage() {
  const d = await api('/api/usage?days=14')
  $('usage-span').textContent = `${d.days[0]?.date ?? ''} → ${d.days[d.days.length - 1]?.date ?? ''}`

  const box = $('usage-cards')
  box.innerHTML = ''
  box.append(
    stat('消息', d.totals.messages, `近 ${d.span} 天`),
    stat('估算 token', d.totals.estTokens, '由字节换算'),
    stat('当前卡片', `${d.card.bytes} B`, `≈ ${d.card.estTokens} token`),
    stat('费用', '—', '未接入'),
  )

  // 柱子只画真实数据：没有消息的那天就是 0，不做平滑、不编造
  const chart = $('usage-chart')
  chart.innerHTML = ''
  const max = Math.max(1, ...d.days.map((x) => x.messages))
  d.days.forEach((x, i) => {
    const col = el('div', 'bar-col')
    col.title = `${x.date} · ${x.messages} 条 · ${(x.bytes / 1024).toFixed(1)} KB`
    const bar = el('div', x.messages ? 'bar' : 'bar is-empty')
    bar.style.height = `${Math.max(2, Math.round((x.messages / max) * 100))}%`
    col.append(bar)
    if (i % 3 === 0 || i === d.days.length - 1) {
      col.append(el('span', 'bar-label', x.date.slice(5)))
    }
    chart.append(col)
  })

  $('usage-cost').textContent = d.cost.note
}

async function loadSources() {
  const d = await api('/api/sources')
  const box = $('sources-out')
  box.innerHTML = ''
  if (!d.sources.length) {
    box.append(el('div', 'muted small', '还没有任何来源写过心跳。'))
  } else {
    for (const s of d.sources) {
      const n = el('div', 'item')
      const body = el('div', 'body')
      const cls = s.state === 'silent' ? 'bad' : s.state === 'ok' ? 'ok' : 'warn'
      const t = el('div', 't')
      t.append(el('span', `tag ${cls}`, s.state), document.createTextNode(s.source))
      body.append(t, el('div', 's', s.at || '-'))
      n.append(body)
      box.append(n)
    }
  }

  // 模块能提供的数据：她要得着的东西，以及"到底取过没有"
  await loadModuleSources().catch(() => {})
}

async function loadModuleSources() {
  const box = $('module-sources-out')
  const hint = $('module-sources-hint')
  if (!box) return
  const d = await api('/api/module-sources')
  const mods = d.modules ?? []
  hint.textContent = `${mods.reduce((n, m) => n + (m.sources ?? []).length, 0)} 个来源${d.partial ? '（统计只扫了最近一部分原始层）' : ''}`
  box.innerHTML = ''

  if (!mods.length) {
    box.append(
      el('div', 'muted small', '还没有模块声明数据来源。装一个带 sources 的模块（例如 B站），这里就会出现它能被要什么。'),
    )
    return
  }

  for (const m of mods) {
    const head = el('div', 'source-module-head')
    const st = !m.enabled ? '已停用' : m.state === 'ready' || m.state === 'running' ? '运行中' : `状态 ${m.state}`
    head.append(el('span', 'tag', st), el('span', `tag ${m.granted ? 'ok' : 'bad'}`, m.granted ? '已授权' : '未授权'))
    head.append(document.createTextNode(`${m.moduleName}（${m.module}）`))
    box.append(head)

    for (const s of m.sources) {
      const n = el('div', 'item')
      const body = el('div', 'body')
      const t = el('div', 't')
      const used = s.count > 0
      t.append(el('span', `tag ${used ? 'ok' : ''}`.trim(), used ? `取过 ${s.count} 次` : '从没取过'))
      t.append(document.createTextNode(s.title || s.id))
      const meta = used
        ? `${s.id} · 最近一次 ${String(s.lastAt || '').replace('T', ' ').slice(0, 16) || '—'}` +
          `${s.lastAtApprox ? '（旧记录，按事件时间估算）' : ''} · 落在 raw/${s.lastDay || '—'}`
        : `${s.id} · 她还没向它要过数据`
      body.append(t, el('div', 's', meta))
      n.append(body)
      box.append(n)
    }
  }
}

async function loadRefusals() {  const d = await api('/api/refusals')
  const box = $('refusals-out')
  box.innerHTML = ''
  if (!d.refusals.length) {
    box.append(el('div', 'muted small', '还没有拒绝记录。'))
    return
  }
  for (const r of d.refusals) {
    const n = el('div', 'item')
    const body = el('div', 'body')
    body.append(el('div', 't', `${r.dim} / ${r.action}`))
    body.append(el('div', 's', `${r.ts} ${r.channel || ''} ${r.reason || ''}`))
    n.append(body)
    box.append(n)
  }
}

// ── 日志 / 审计 ────────────────────────────────────────────────────────
//
// 一个页面两个镜头：lens=all 看全部，lens=write 就是审计。
// 审计行带 hash 与 path，所以能给「回滚」——没有回滚入口的审计只是另一种日志。
const LENS_TITLES = {
  all: '全部事件',
  write: '审计：每一次写入',
  error: '异常',
  module: '模块相关',
  refusal: '拒绝',
}

const LEVEL_TAGS = {
  info: ['', ''],
  warn: ['警', 'warn'],
  error: ['错', 'bad'],
}

async function loadLogs() {
  const lens = state.logLens || 'all'
  const d = await api(`/api/logs?lens=${lens}&limit=200`)

  // 统计条：现在只是数字，位置留给以后画图
  const box = $('log-stats')
  box.innerHTML = ''
  box.append(
    stat('事件', d.counts.events, '运行流水'),
    stat('写入', d.counts.writes, '可回滚'),
    stat('异常', `${d.counts.error} / ${d.counts.warn}`, '错 / 警'),
    stat('拒绝', d.counts.refusals, '规则拦下'),
  )

  $('log-title').textContent = LENS_TITLES[lens] || lens
  $('log-hint').textContent = `共 ${d.items.length} 条`

  const out = $('log-out')
  out.innerHTML = ''
  if (!d.items.length) {
    // 空就是空：不编"暂无"，说清楚为什么空
    out.append(
      el(
        'div',
        'muted small',
        lens === 'write'
          ? '还没有任何写入记录。她第一次改记忆、改人物或群体档案之后，这里才有东西。'
          : '还没有事件。收到第一条消息、装上第一个模块之后，这里才会有。',
      ),
    )
    return
  }

  for (const it of [...d.items].reverse()) {
    const n = el('div', 'item')
    const body = el('div', 'body')
    const head = el('div', 't')
    const tags = el('span')
    const [lbl, cls] = LEVEL_TAGS[it.level] ?? ['', '']
    if (lbl) tags.append(el('span', `tag ${cls}`, lbl))
    if (it.module) tags.append(el('span', 'tag', it.module))
    tags.append(el('span', 'tag', it.kind))
    head.append(tags, document.createTextNode(String(it.ts).replace('T', ' ').slice(0, 19)))

    const who = it.kind === 'write' ? it.actor || '未知' : it.actor || 'core'
    const text = it.kind === 'write' ? it.reason || '（没写原因）' : it.text || ''
    body.append(head, el('div', 's', `${who}${it.path ? ` · ${it.path}` : ''}`), el('div', 's', text))
    n.append(body)

    // 审计行给回滚：这是"审计"和"日志"真正的区别
    if (it.kind === 'write') {
      const acts = el('div', 'actions')
      acts.append(
        mkBtn('回滚到上一版', 'small ghost', async () => {
          if (!confirm(`把 ${it.path} 回滚到这一版之前？\n\n回滚本身也会记一条新版本，不会抹掉后来的历史。`)) return
          try {
            await postApi('/api/rollback', { path: it.path, hash: it.prev })
            await loadLogs()
          } catch (err) {
            alert(`回滚失败：${err.message}`)
          }
        }),
      )
      n.append(acts)
    }
    out.append(n)
  }
}

// ── 诊断 ──────────────────────────────────────────────────────────────
const DIAG_TAGS = {
  error: ['错', 'bad'],
  warn: ['警', 'warn'],
  info: ['讯', ''],
}

async function loadDiag() {
  const only = state.diagMode !== 'all'
  const d = await api(`/api/diagnostics?only=${only ? 'problems' : 'all'}`)

  $('diag-ts').textContent = `跑于 ${String(d.ts).replace('T', ' ').slice(0, 19)}`
  const sum = $('diag-summary')
  sum.innerHTML = ''
  sum.append(
    stat('结论', d.ok ? '没有硬故障' : '有硬故障', `${d.items.length} 项`),
    stat('错', d.summary.error ?? 0, '必须处理'),
    stat('警告', d.summary.warn ?? 0, '会影响功能'),
    stat('提示', d.summary.info ?? 0, '说明'),
  )

  $('diag-hint').textContent = only ? '只列需要处理的' : '全部检查项（含通过的）'
  const out = $('diag-out')
  out.innerHTML = ''
  if (!d.items.length) {
    out.append(
      el(
        'div',
        'muted small',
        only
          ? '没有需要处理的事。想看它到底查了什么，切到「全部检查项」。'
          : '这个版本还没有内置任何检查项。',
      ),
    )
    return
  }

  for (const it of d.items) {
    const n = el('div', 'item')
    const body = el('div', 'body')
    const head = el('div', 't')
    const tags = el('span')
    const [lbl, cls] = DIAG_TAGS[it.level] ?? ['', '']
    if (lbl) tags.append(el('span', `tag ${cls}`, lbl))
    if (it.module) tags.append(el('span', 'tag purple', it.module))
    if (it.source === 'module') tags.append(el('span', 'tag', '模块自报'))
    tags.append(el('span', 'tag', it.stage))
    head.append(tags, document.createTextNode(it.code))
    body.append(head)
    if (it.hint) body.append(el('div', 's', it.hint))
    n.append(body)
    out.append(n)
  }
}

// ── 切页 ──────────────────────────────────────────────────────────────
// 键就是菜单 id。注意 shape 用的是 loadProposals——"人格塑造"就是原来那页提案，
// 改名是为了让人看懂，不是重写。
// ── 控制台对话 ────────────────────────────────────────────────────────
function chatPrefix(mode) {
  return mode === 'test' ? 'chat-test' : 'chat'
}

function appendChatBubble(mode, role, text, { test = mode === 'test', error = '' } = {}) {
  const log = $(mode === 'test' ? 'chat-test-log' : 'chat-log')
  if (!log) return null
  const empty = log.querySelector('.console-empty')
  if (empty) empty.remove()
  const bubble = el('div', `console-msg ${role}${test && role === 'assistant' ? ' test' : ''}`)
  if (role === 'assistant' && test) bubble.append(el('span', 'console-tag', '测试模式 · 不保存'))
  bubble.append(document.createTextNode(text || ''))
  if (error) bubble.append(el('div', 'console-err', error))
  log.append(bubble)
  log.scrollTop = log.scrollHeight
  return bubble
}

async function loadChat(mode) {
  const log = $(mode === 'test' ? 'chat-test-log' : 'chat-log')
  if (!log) return
  const data = await api(`/api/console/history?mode=${mode === 'test' ? 'test' : 'chat'}`)
  log.innerHTML = ''
  const items = data.items ?? []
  if (!items.length) log.append(el('div', 'console-empty', mode === 'test' ? '测试对话从这里开始。不会写 raw，也不会提炼记忆。' : '从这里开始和她说话。'))
  for (const it of items) {
    if (it.role === 'user' || it.role === 'assistant') {
      appendChatBubble(mode, it.role, it.text || '', { test: mode === 'test', error: it.error || '' })
    }
  }
  const input = $(mode === 'test' ? 'chat-test-input' : 'chat-input')
  const sendBtn = $(mode === 'test' ? 'chat-test-send' : 'chat-send')
  if (input && !input.dataset.bound) {
    input.dataset.bound = '1'
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault()
        sendChat(mode).catch(() => {})
      }
    })
    input.addEventListener('input', () => {
      input.style.height = 'auto'
      input.style.height = `${Math.min(160, input.scrollHeight)}px`
    })
  }
  if (sendBtn && !sendBtn.dataset.bound) {
    sendBtn.dataset.bound = '1'
    sendBtn.addEventListener('click', () => sendChat(mode).catch(() => {}))
  }
}

async function sendChat(mode) {
  const input = $(mode === 'test' ? 'chat-test-input' : 'chat-input')
  const sendBtn = $(mode === 'test' ? 'chat-test-send' : 'chat-send')
  const hint = $(mode === 'test' ? 'chat-test-hint' : 'chat-hint')
  if (!input || !sendBtn) return
  const text = input.value.trim()
  if (!text) return
  input.value = ''
  input.style.height = 'auto'
  input.disabled = true
  sendBtn.disabled = true
  appendChatBubble(mode, 'user', text, { test: false })
  const reply = appendChatBubble(mode, 'assistant', '', { test: mode === 'test' })
  const replyText = document.createTextNode('')
  reply.append(replyText)
  let acc = ''
  try {
    const res = await fetch('/api/console/turn', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(state.token ? { 'x-yuanling-token': state.token } : {}),
      },
      body: JSON.stringify({ mode: mode === 'test' ? 'test' : 'chat', text }),
    })
    if (res.status === 401) {
      state.token = null
      showTokenBar(true)
      throw new Error('unauthorized')
    }
    if (!res.ok) throw new Error((await res.text().catch(() => '')).slice(0, 200) || `请求失败 ${res.status}`)
    const reader = res.body.getReader()
    const dec = new TextDecoder()
    let buf = ''
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      buf += dec.decode(value, { stream: true })
      const parts = buf.split('\n\n')
      buf = parts.pop() ?? ''
      for (const part of parts) {
        let event = 'message'
        let data = ''
        for (const line of part.split('\n')) {
          if (line.startsWith('event:')) event = line.slice(6).trim()
          else if (line.startsWith('data:')) data += line.slice(5).trim()
        }
        let payload = {}
        try { payload = data ? JSON.parse(data) : {} } catch { continue }
        if (event === 'delta' && payload.text) {
          acc += payload.text
          replyText.data = acc
          const log = reply.parentElement
          if (log) log.scrollTop = log.scrollHeight
        } else if (event === 'done') {
          if (payload.text) {
            acc = payload.text
            replyText.data = acc
          }
        } else if (event === 'error') {
          reply.append(el('div', 'console-err', payload.message || '出错了'))
        }
      }
    }
    if (hint) hint.textContent = mode === 'test' ? '测试模式：不写 raw，不提炼记忆' : ''
  } catch (err) {
    reply.append(el('div', 'console-err', String(err.message ?? err)))
  } finally {
    input.disabled = false
    sendBtn.disabled = false
    input.focus()
  }
}

const loaders = {
  status: loadStatus,
  overview: loadOverview,
  shape: loadProposals,
  memory: loadMemory,
  motive: loadMotive,
  people: loadPeople,
  groups: loadGroups,
  rules: loadRules,
  chat: () => loadChat('chat'),
  'chat-test': () => loadChat('test'),
  usage: loadUsage,
  sources: loadSources,
  logs: loadLogs,
  diag: loadDiag,
  refusals: loadRefusals,
}

// ── 模块页 ────────────────────────────────────────────────────────────
//
// 页面只做三件事：看状态、授予能力、装/卸。
// **下载不在页面里做**（联网 + 超时 + sha256 放 HTTP 请求里会变成"点了没反应"），
// 页面只接受本地 .tgz 路径，下载走 CLI。

const CAP_LABELS = {
  'ingest.message': '收消息',
  'propose.fact': '提事实',
  'media.put.file': '存媒体',
  'media.read': '读媒体',
  send: '发消息',
  actuate: '生成内容',
  'provide.source': '提供数据',
}

/** send 是唯一"能往外说话"的能力，单独标风险。 */
const CAP_RISK = { send: true }

/** 授权弹窗里的一句话说明：人得看明白自己在批什么，不能只给个英文词。 */
const CAP_HINTS = {
  'ingest.message': '把外部消息写进原始层（落盘、脱敏都由核心做）',
  'propose.fact': '提交候选事实，入不入库由核心判',
  'media.put.file': '把媒体文件交给核心归档',
  'media.read': '读走核心里的媒体文件',
  send: '用她的名义往外说话——这是唯一能"发出去"的能力',
  actuate: '被核心调用来生成语音/图片/视频',
  'provide.source': '允许核心按需向它要数据（她检索时会用到）',
}

const STATE_LABELS = {
  running: ['运行中', 'ok'],
  ready: ['就绪', 'ok'],
  stopped: ['已停止', ''],
  starting: ['启动中', 'warn'],
  restarting: ['重启中', 'warn'],
  crashed: ['已崩溃', 'bad'],
}

/** 切换模块页的两块：控制台 / 某个模块的详情。左侧菜单的高亮跟着它走。 */
function showModuleView(view, id = null) {
  state.moduleView = view
  state.moduleId = view === 'console' ? null : id
  if (view === 'console') state.moduleDetail = null
  $('module-console').hidden = view !== 'console'
  $('module-detail').hidden = view === 'console'
  $('crumb-page').textContent = view === 'console' ? '控制台' : (state.modules.find((m) => m.id === id)?.name || id || '模块')
  buildNav()
}

function openModuleConsole() {
  showModuleView('console')
}

async function loadModules() {
  const d = await api('/api/modules')
  state.modules = d.modules ?? []

  const sum = d.summary ?? {}
  const box = $('module-summary')
  box.innerHTML = ''
  for (const [label, value, cls] of [
    ['已安装', sum.total ?? 0, ''],
    ['运行中', sum.running ?? 0, 'ok'],
    ['已崩溃', sum.crashed ?? 0, sum.crashed ? 'bad' : ''],
    ['已停用', sum.disabled ?? 0, ''],
  ]) {
    const c = el('div', 'stat' + (cls ? ` ${cls}` : ''))
    c.append(el('div', 'v', String(value)), el('div', 'k', label))
    box.append(c)
  }

  $('module-count').textContent = d.modules.length ? `共 ${d.modules.length} 个` : ''
  const list = $('module-list')
  list.innerHTML = ''
  if (!d.modules.length) {
    list.append(
      el('div', 'muted small', '还没有安装任何模块。在上面粘一个库的网址就能装，例如 https://gitee.com/dshqqb/dsh-yuanling-bili'),
    )
  }

  for (const m of d.modules) {
    const n = el('div', 'item')
    const body = el('div', 'body')
    const t = el('div', 't')
    const tags = el('span')
    const [stateText, stateCls] = STATE_LABELS[m.state] ?? [m.state, '']
    tags.append(el('span', `tag ${stateCls}`.trim(), stateText))
    if (!m.enabled) tags.append(el('span', 'tag', '已停用'))
    tags.append(el('span', 'tag', m.source || 'manual'))
    if (m.state === 'crashed' && m.lastCrash) tags.append(el('span', 'tag bad', '崩溃过'))
    t.append(tags, document.createTextNode(moduleDisplayName(m)))

    const caps = (m.granted ?? []).map((c) => CAP_LABELS[c] ?? c).join('、') || '无'
    body.append(t, el('div', 's', `${m.id} · v${m.version} · 能力：${caps}`))
    n.append(body)

    const acts = el('div', 'actions')
    acts.append(mkBtn('详情', 'small ghost', () => openModule(m.id)))
    n.append(acts)
    list.append(n)
  }

  // 左侧菜单跟着列表走：模块装完/卸载之后菜单要立刻变
  buildNav()
  // 详情页开着的时候，它可能刚被卸载了
  if (state.moduleView !== 'console' && !state.modules.some((m) => m.id === state.moduleView)) {
    showModuleView('console')
  }
}

/**
 * 模块详情的 tab 条。
 *
 * 前两个由核心固定提供：**概况**（默认）与**日志**（日志可能很长，单独一页免得把概况挤下去）。
 * 第三个起留给模块自定义——协议还没定，所以现在只渲染固定的两个；
 * 等 `ui.tabs` 定下来，这里按模块下发的数组往下排即可（渲染逻辑见 selectModuleTab）。
 */
const MODULE_BASE_TABS = [
  { id: 'brief', label: '概况' },
  { id: 'log', label: '日志' },
  { id: 'audit', label: '审计' },
  { id: 'diag', label: '诊断' },
]

function renderModuleTabs(module, active) {
  const bar = $('module-tabs')
  bar.innerHTML = ''
  // 模块自定义 tab（v1.2）：manifest.ui.tabs = [{id, label, kind}]，从第三个位置开始
  const extra = Array.isArray(module?.uiTabs) ? module.uiTabs : []
  const tabs = [...MODULE_BASE_TABS, ...extra.map((t) => ({ id: String(t.id), label: String(t.label || t.id), kind: t.kind, custom: true }))]

  for (const t of tabs) {
    const b = el('button', t.id === active ? 'is-active' : '')
    b.textContent = t.label
    b.dataset.tabId = t.id
    b.title = t.custom ? '模块自定义的标签页（只读，数据由模块提供）' : ''
    b.addEventListener('click', () => selectModuleTab(t.id))
    bar.append(b)
  }
  selectModuleTab(active && tabs.some((t) => t.id === active) ? active : 'brief', module)
}

function selectModuleTab(id, module = null) {
  state.moduleTab = id
  // 详情必须留住：列表视图（`state.modules`）里没有 uiTabs / configFields（为了轻量），
  // 点 tab 时若从列表里找 spec，就会"什么类型都不是"→ 落到 text 分支 → 空白页（真踩过）。
  const current = module ?? state.moduleDetail ?? state.modules.find((x) => x.id === state.moduleId)
  // 用 dataset 比而不是比文字：两个 tab 可能同名（尤其模块自定义的那几个）
  for (const b of $('module-tabs').querySelectorAll('button')) {
    b.classList.toggle('is-active', b.dataset.tabId === id)
  }
  $('module-panel-brief').hidden = id !== 'brief'
  $('module-panel-log').hidden = id !== 'log'
  $('module-panel-audit').hidden = id !== 'audit'
  $('module-panel-diag').hidden = id !== 'diag'
  const custom = $('module-panel-custom')
  const isCustom = !MODULE_BASE_TABS.some((t) => t.id === id)
  custom.hidden = !isCustom
  if (!isCustom) {
    // 审计 / 诊断是核心侧的（模块不用改协议），要现取，所以在这里触发
    if (id === 'audit') loadModuleAudit(state.moduleId).catch((err) => showTabError(err))
    if (id === 'diag') loadModuleDiag(state.moduleId).catch((err) => showTabError(err))
    return
  }

  const spec = (current?.uiTabs ?? []).find((t) => t.id === id)
  // 两种自定义页都是异步的（要现取数据），失败只该影响这一块，不该冒到整页
  if (spec?.kind === 'config') renderConfigTab(id, current).catch((err) => showTabError(err))
  else loadModuleTabData(id, current).catch((err) => showTabError(err))
}

// ── 模块的审计 / 诊断（核心统一提供，模块不用改协议）─────────────────
const MODULE_AUDIT_MODEL = 'actor 是 model 的，都是她自己写的；human 是你改的'

async function loadModuleAudit(id) {
  const d = await api(`/api/module/audit?id=${encodeURIComponent(id)}&limit=100`)
  const out = $('module-audit-out')
  out.innerHTML = ''
  if (!d.writes.length) {
    out.append(el('div', 'muted small', '这个模块还没有造成任何写入。它取一次数、收一条消息之后才会有。'))
    return
  }
  for (const w of [...d.writes].reverse()) {
    const n = el('div', 'item')
    const body = el('div', 'body')
    const head = el('div', 't')
    const tags = el('span')
    tags.append(el('span', 'tag', w.actor || '未知'))
    head.append(tags, document.createTextNode(String(w.ts).replace('T', ' ').slice(0, 19)))
    body.append(head, el('div', 's', w.path), el('div', 's', w.reason || '（没写原因）'))
    n.append(body)
    const acts = el('div', 'actions')
    acts.append(
      mkBtn('回滚到上一版', 'small ghost', async () => {
        if (!confirm(`把 ${w.path} 回滚到这一版之前？`)) return
        try {
          await postApi('/api/rollback', { path: w.path, hash: w.prev })
          await loadModuleAudit(id)
        } catch (err) {
          alert(`回滚失败：${err.message}`)
        }
      }),
    )
    n.append(acts)
    out.append(n)
  }
  $('module-audit-out').title = MODULE_AUDIT_MODEL
}

async function loadModuleDiag(id) {
  const d = await api(`/api/module/diag?id=${encodeURIComponent(id)}`)
  const out = $('module-diag-out')
  out.innerHTML = ''
  $('module-diag-hint').textContent = '核心自己知道的事实：进程、握手、能力、配置、崩溃'
  if (!d.items.length) {
    out.append(el('div', 'muted small', '没有需要处理的问题。'))
  } else {
    for (const it of d.items) {
      const n = el('div', 'item')
      const body = el('div', 'body')
      const head = el('div', 't')
      const tags = el('span')
      const [lbl, cls] = DIAG_TAGS[it.level] ?? ['', '']
      if (lbl) tags.append(el('span', `tag ${cls}`, lbl))
      tags.append(el('span', 'tag', it.stage))
      head.append(tags, document.createTextNode(it.code))
      body.append(head)
      if (it.hint) body.append(el('div', 's', it.hint))
      n.append(body)
      out.append(n)
    }
  }

  const rep = $('module-diag-reported')
  rep.innerHTML = ''
  const r = d.reported ?? {}
  if (!r.items?.length) {
    rep.append(
      el(
        'div',
        'muted small',
        r.stale
          ? '上次自报已经过期（15 分钟内没再报），不再当作有效结论。'
          : '这个模块还没有自报过诊断项（协议 v1.4 的 diag.report 是可选的）。',
      ),
    )
  } else {
    for (const it of r.items) {
      const n = el('div', 'item')
      const body = el('div', 'body')
      const head = el('div', 't')
      const tags = el('span')
      const [lbl, cls] = DIAG_TAGS[it.level] ?? ['', '']
      if (lbl) tags.append(el('span', `tag ${cls}`, lbl))
      head.append(tags, document.createTextNode(String(it.code)))
      body.append(head)
      if (it.hint) body.append(el('div', 's', it.hint))
      n.append(body)
      rep.append(n)
    }
  }
}

/** 自定义页取数失败：在该页里说清楚，别让用户对着空白猜。 */
function showTabError(err) {
  const box = $('module-panel-custom')
  if (!box) return
  box.innerHTML = ''
  const card = el('div', 'card')
  card.append(el('div', 'muted small', `这个页没加载出来：${err?.message ?? err}`))
  box.append(card)
}

/**
 * `kind: "config"` 的 tab：内容就是**这个模块自己的配置表单**。
 *
 * 为什么把它做成 tab 而不是新控件系统：配置已经有 schema 校验、落盘、密码框、
 * 改完自动重启这一整套；另开一套"tab 里的控件值"必然出现"存哪、和 config 谁优先"的分叉。
 * 模块想给某组设置单独开一页，只要声明一个 config 型 tab 就行。
 *
 * **数据从 `/api/modules/ui` 现取**，不读 `state.modules` 缓存——那份列表视图
 * 里没有 `configFields`（列表要轻），拿它渲染会得到一个空白页（真踩过）。
 */
async function renderConfigTab(tabId, module) {
  const box = $('module-panel-custom')
  box.innerHTML = ''
  const card = el('div', 'card')
  const head = el('div', 'card-head')
  head.append(el('h3', '', (module?.uiTabs ?? []).find((t) => t.id === tabId)?.label || tabId))
  head.append(el('span', 'muted small', '这个页就是它的配置项，保存后会重启模块'))
  card.append(head)

  const form = el('div', 'config-form')
  card.append(form)

  const actions = el('div', 'field-row')
  const save = el('button', 'btn small', '保存并重启模块')
  const msg = el('span', 'muted small')
  actions.append(save, msg)
  card.append(actions)
  box.append(card)

  let payload = null
  try {
    payload = await postApi('/api/modules/ui', { id: state.moduleId, tab: tabId })
  } catch (err) {
    form.append(el('div', 'muted small', `取不到这个页的配置：${err.message}`))
    actions.hidden = true
    return
  }

  renderConfigForm({ configFields: payload.fields ?? [], config: payload.config ?? {} }, { form, actions, msg, hint: null })

  save.addEventListener('click', async () => {
    const id = state.moduleId
    if (!id) return
    save.disabled = true
    msg.textContent = '保存中…'
    try {
      const r = await postApi('/api/modules/config', { id, config: collectConfigForm(form) })
      const dropped = (r.dropped ?? []).length ? `（忽略了未声明的字段：${r.dropped.join('、')}）` : ''
      const rt = r.runtime?.restarted
        ? '，模块已用新配置重启'
        : r.runtime?.skipped === 'disabled'
          ? '，模块处于停用状态，启用后生效'
          : ''
      msg.textContent = `✓ 已保存${dropped}${rt}`
      await loadModules()
      await openModule(id)
      renderConfigTab(tabId, state.modules.find((x) => x.id === id))
    } catch (err) {
      msg.textContent = `保存失败：${err.message}`
    } finally {
      save.disabled = false
    }
  })
}

/**
 * 拉一个模块自定义 tab 的数据并渲染。
 *
 * 渲染是**纯数据 → DOM**：模块只会给 `kv` / `list` / `text` 三种形状，
 * 我们一律用 textContent 写进去。模块没有任何机会塞 HTML/JS——
 * 管理台握着 console.token，能读全部记忆、改规则、卸模块，这条线不能松。
 */
async function loadModuleTabData(tabId, module) {
  const box = $('module-panel-custom')
  box.innerHTML = ''
  const card = el('div', 'card')
  card.append(el('div', 'muted small', '加载中…'))
  box.append(card)

  try {
    const d = await postApi('/api/modules/ui', { id: state.moduleId, tab: tabId })
    box.innerHTML = ''
    const out = el('div', 'card')
    const head = el('div', 'card-head')
    const tabLabel = (module?.uiTabs ?? []).find((t) => t.id === tabId)?.label || tabId
    head.append(el('h3', '', tabLabel))
    if (d.truncated) head.append(el('span', 'tag warn', '内容较多，已截断'))
    out.append(head)

    if (d.kind === 'kv') {
      const kv = el('div', 'kv')
      for (const row of d.rows ?? []) {
        kv.append(el('div', 'k', String(row.k)), el('div', 'v', String(row.v)))
      }
      if (!(d.rows ?? []).length) kv.append(el('div', 'muted small', '（没有数据）'))
      out.append(kv)
    } else if (d.kind === 'list') {
      const list = el('div', 'list')
      for (const it of d.items ?? []) {
        const n = el('div', 'item')
        const body = el('div', 'body')
        body.append(el('div', 't', String(it.title)))
        if (it.sub) body.append(el('div', 's', String(it.sub)))
        n.append(body)
        list.append(n)
      }
      if (!(d.items ?? []).length) list.append(el('div', 'muted small', '（没有数据）'))
      out.append(list)
    } else if (d.kind === 'records') {
    // records 型：核心查自己的原始层，模块没参与——所以这里只负责把记录列出来
    const list = el('div', 'list')
    for (const it of d.items ?? []) {
      const n = el('div', 'item')
      const body = el('div', 'body')
      body.append(el('div', 't', String(it.title)))
      const sub = el('div', 's', String(it.sub || ''))
      if (it.ptr) sub.append(el('span', 'muted small', `　${it.ptr}`))
      body.append(sub)
      n.append(body)
      list.append(n)
    }
    if (!(d.items ?? []).length) {
      list.append(
        el('div', 'muted small', '还没有记录。她做过这类事情之后，这里会按时间倒序列出来（记录在原始层里，模块停着也能看）。'),
      )
    }
    out.append(list)
    if (d.partial) out.append(el('div', 'muted small', '（原始层只扫了最近一部分，可能还有更早的记录）'))
  } else {
      const pre = el('pre', 'code', String(d.text ?? ''))
      out.append(pre)
    }
    box.append(out)
  } catch (err) {
    box.innerHTML = ''
    const card2 = el('div', 'card')
    card2.append(el('div', 'muted small', `取不到这个页的数据：${err.message}`))
    box.append(card2)
  }
}

/**
 * 按模块声明的 config.schema 渲染表单。
 *
 * 字段元信息由核心算好（`configFields`：key/type/widget/required/enum/min/max/secret），
 * 页面只负责画控件——前端再解释一遍 schema，迟早和核心的校验规则对不上。
 *
 * 支持 8 种控件（其余两种"按钮/浏览文件"要等 ui.action 协议，见 v1.3）：
 *   switch / checkbox / radio / select / slider / input / textarea / list
 */
function renderConfigForm(m, opts = {}) {
  const form = opts.form ?? $('module-config-form')
  const actions = opts.actions ?? $('module-config-actions')
  const hint = opts.hint ?? $('module-config-hint')
  const msg = opts.msg ?? $('module-config-msg')
  form.innerHTML = ''
  if (msg) msg.textContent = ''

  const fields = Array.isArray(m.configFields) ? m.configFields : []
  if (!fields.length) {
    form.append(el('div', 'muted small', '该模块没有声明配置。'))
    if (actions) actions.hidden = true
    if (hint) hint.textContent = ''
    return
  }

  const values = m.config ?? {}
  for (const f of fields) {
    form.append(buildConfigRow(f, values[f.key]))
  }

  if (actions) actions.hidden = false
  if (hint) hint.textContent = `${fields.length} 个字段`
}

/**
 * 下拉框。原生 select 在暗色主题下是系统样式（灰白底、方角、默认箭头），
 * 和旁边那些圆角输入框放一起像两个不同的应用。所以自己画：外观交给 CSS，
 * 箭头用一个绝对定位的 chevron（原生箭头没法在 select 上直接改样式）。
 */
function buildSelect(f, cur) {
  const wrap = el('div', 'select-wrap')
  const input = document.createElement('select')
  if (!f.required) input.append(new Option('（不设置）', ''))
  for (const opt of f.enum) input.append(new Option(opt, opt))
  input.value = cur === undefined || cur === null ? '' : String(cur)
  input.dataset.configKey = f.key
  input.dataset.configType = f.type || 'string'
  input.dataset.configWidget = 'select'

  const chev = el('span', 'select-chev')
  chev.innerHTML =
    '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M6 9.5l6 6 6-6"/></svg>'
  wrap.append(input, chev)
  return wrap
}

/** 一个字段 → 一行控件。抽出来是为了"列表型配置"里的每一行也能复用。 */
function buildConfigRow(f, cur) {
  const row = el('div', 'config-row')
  const label = el('label', 'config-label')
  label.append(document.createTextNode(f.label))
  if (f.required) label.append(el('span', 'tag warn', '必填'))
  if (f.description) label.title = f.description
  row.append(label)

  const holder = el('div', 'config-control')
  const widget = f.widget || 'input'
  let input = null

  if (widget === 'radio' && f.enum) {
    // 选项少的时候铺开成单选：一眼看全，不用点开下拉
    const group = el('div', 'radio-group')
    for (const opt of f.enum) {
      const lab = el('label', 'radio-item')
      const r = document.createElement('input')
      r.type = 'radio'
      r.name = `cfg-${f.key}`
      r.value = opt
      r.checked = cur === opt
      r.dataset.configKey = f.key
      r.dataset.configType = 'radio'
      lab.append(r, document.createTextNode(opt))
      group.append(lab)
    }
    holder.append(group)
  } else if (widget === 'select' && f.enum) {
    holder.append(buildSelect(f, cur))
  } else if (widget === 'switch') {
    const lab = el('label', 'switch-row')
    input = document.createElement('input')
    input.type = 'checkbox'
    input.checked = cur === true || cur === 'true'
    const track = el('span', 'switch-track')
    track.append(el('span', 'switch-knob'))
    lab.append(input, track, el('span', 'small', input.checked ? '开' : '关'))
    input.addEventListener('change', () => {
      lab.lastChild.textContent = input.checked ? '开' : '关'
    })
    holder.append(lab)
  } else if (widget === 'checkbox') {
    const lab = el('label', 'check-row')
    input = document.createElement('input')
    input.type = 'checkbox'
    input.checked = cur === true || cur === 'true'
    const tick = el('span', 'check-tick')
    tick.textContent = input.checked ? '✓' : ''
    input.addEventListener('change', () => {
      tick.textContent = input.checked ? '✓' : ''
    })
    // 顺序要紧：CSS 用的是 `input:checked + .check-tick`（相邻兄弟），
    // 把 tick 放在 input 前面的话，勾上了样式也不会变——看起来就是"点不动"（真踩过）。
    lab.append(input, tick, el('span', 'small', f.description || '勾选'))
    holder.append(lab)
  } else if (widget === 'slider') {
    const wrap = el('div', 'slider-row')
    input = document.createElement('input')
    input.type = 'range'
    const lo = f.min ?? 0
    const hi = f.max ?? 100
    input.min = String(lo)
    input.max = String(hi)
    input.step = String(f.step ?? 1)
    input.value = String(Number.isFinite(Number(cur)) ? Number(cur) : lo)
    const out = el('span', 'small slider-value', input.value)
    input.addEventListener('input', () => {
      out.textContent = input.value
    })
    wrap.append(input, out)
    holder.append(wrap)
  } else if (widget === 'textarea') {
    input = document.createElement('textarea')
    input.rows = 4
    input.value = cur === undefined || cur === null ? '' : String(cur)
    if (f.default !== null && f.default !== undefined) input.placeholder = `默认 ${f.default}`
    holder.append(input)
  } else if (widget === 'list') {
    holder.append(buildListEditor(f, Array.isArray(cur) ? cur : []))
  } else if (widget === 'action') {
    // 占位：按钮要等 ui.action 协议（v1.3），现在只画出来，点了什么也不做
    const b = el('button', 'btn ghost small', f.description || '按钮')
    b.disabled = true
    b.title = '等 ui.action 协议（v1.3）：现在只是占位，点了不会发生任何事'
    holder.append(b, el('span', 'tag', '待接入'))
  } else if (widget === 'file') {
    // 占位：浏览本机文件需要核心出面（浏览器拿不到真实路径），先把位置留出来
    input = document.createElement('input')
    input.type = 'text'
    input.disabled = true
    input.placeholder = '（待接入：核心侧文件选择器）'
    const b = el('button', 'btn ghost small', '浏览…')
    b.disabled = true
    b.title = '等 ui.action 协议：模块不能直接拿到本机路径'
    holder.append(input, b, el('span', 'tag', '待接入'))
  } else {
    input = document.createElement('input')
    input.type = f.secret ? 'password' : f.type === 'number' ? 'number' : 'text'
    input.value = cur === undefined || cur === null ? '' : String(cur)
    input.autocomplete = 'off'
    if (f.default !== null && f.default !== undefined) input.placeholder = `默认 ${f.default}`
    holder.append(input)
    if (f.secret) {
      const peek = mkBtn('显示', 'small ghost', async () => {
        input.type = input.type === 'password' ? 'text' : 'password'
        peek.textContent = input.type === 'password' ? '显示' : '隐藏'
      })
      holder.append(peek)
    }
  }

  if (input && widget !== 'switch' && widget !== 'checkbox') {
    input.dataset.configKey = f.key
    input.dataset.configType = f.type || 'string'
    input.dataset.configWidget = widget
  } else if (input) {
    input.dataset.configKey = f.key
    input.dataset.configType = 'boolean'
    input.dataset.configWidget = widget
  }
  // 占位控件不参与提交
  if (input && (widget === 'action' || widget === 'file')) {
    delete input.dataset.configKey
    delete input.dataset.configType
  }

  row.append(holder)
  if (f.description && widget !== 'checkbox') {
    row.append(el('div', 'config-desc muted small', f.description))
  }
  return row
}

/**
 * 列表型配置（数组里放对象）：能增、删、改、上下移动。
 *
 * 为什么用上下按钮而不是拖拽：拖拽要处理指针捕获、触摸、键盘可达性，
 * 而"调顺序"这件事用两个箭头按钮就能表达清楚，还不用学。
 */
function buildListEditor(f, rows) {
  const box = el('div', 'list-editor')
  box.dataset.configKey = f.key
  box.dataset.configType = 'array'
  const items = rows.map((r) => ({ ...r }))
  const itemFields = f.itemFields ?? []

  const draw = () => {
    box.innerHTML = ''
    if (!items.length) {
      box.append(el('div', 'muted small', '（空列表）'))
    }
    items.forEach((row, i) => {
      const line = el('div', 'list-row')
      const idx = el('span', 'list-idx muted small', String(i + 1))
      line.append(idx)

      for (const sub of itemFields) {
        const cell = el('label', 'list-cell')
        cell.append(el('span', 'muted small', sub.label))
        let inp
        if (sub.enum) {
          // 列表里的下拉用同一套外观（原生 select 在暗色下太突兀）
          const wrap = el('div', 'select-wrap')
          inp = document.createElement('select')
          for (const opt of sub.enum) inp.append(new Option(opt, opt))
          inp.value = row[sub.key] ?? sub.enum[0]
          const chev = el('span', 'select-chev')
          chev.innerHTML =
            '<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M6 9.5l6 6 6-6"/></svg>'
          wrap.append(inp, chev)
          inp.addEventListener('change', () => {
            row[sub.key] = inp.value
          })
          cell.append(wrap)
          line.append(cell)
          continue
        } else if (sub.type === 'boolean') {
          inp = document.createElement('input')
          inp.type = 'checkbox'
          inp.checked = Boolean(row[sub.key])
        } else if (sub.type === 'number') {
          inp = document.createElement('input')
          inp.type = 'number'
          inp.value = row[sub.key] ?? ''
        } else {
          inp = document.createElement('input')
          inp.type = 'text'
          inp.value = row[sub.key] ?? ''
        }
        inp.addEventListener('input', () => {
          row[sub.key] = sub.type === 'boolean' ? inp.checked : sub.type === 'number' ? Number(inp.value) : inp.value
        })
        inp.addEventListener('change', () => {
          row[sub.key] = sub.type === 'boolean' ? inp.checked : sub.type === 'number' ? Number(inp.value) : inp.value
        })
        cell.append(inp)
        line.append(cell)
      }

      const ops = el('div', 'list-ops')
      ops.append(
        mkBtn('↑', 'small ghost', async () => {
          if (i === 0) return
          ;[items[i - 1], items[i]] = [items[i], items[i - 1]]
          draw()
        }),
        mkBtn('↓', 'small ghost', async () => {
          if (i >= items.length - 1) return
          ;[items[i + 1], items[i]] = [items[i], items[i + 1]]
          draw()
        }),
        mkBtn('删除', 'small ghost danger', async () => {
          items.splice(i, 1)
          draw()
        }),
      )
      line.append(ops)
      box.append(line)
    })

    const add = mkBtn('＋ 添加一行', 'small', async () => {
      const blank = {}
      for (const sub of itemFields) {
        blank[sub.key] = sub.type === 'boolean' ? false : sub.type === 'number' ? 0 : sub.enum ? sub.enum[0] : ''
      }
      items.push(blank)
      draw()
    })
    box.append(add)
  }

  draw()
  // 收集时读这个闭包里的 items（而不是 DOM），免得输入过程中丢状态
  box.__read = () => items.map((r) => ({ ...r }))
  return box
}

/** 收集表单值：空串表示"没填"，不写进配置（核心的校验器也是这么理解的）。 */
function collectConfigForm(root = null) {
  const scope = root ?? $('module-config-form')
  const out = {}

  // 列表型：值在闭包里（不是 DOM），直接问编辑器要
  for (const box of scope.querySelectorAll('.list-editor')) {
    if (typeof box.__read === 'function') out[box.dataset.configKey] = box.__read()
  }

  // 单选：同一组里只有被选中的那个有值
  const radioKeys = new Set()
  for (const r of scope.querySelectorAll('[data-config-type="radio"]')) {
    radioKeys.add(r.dataset.configKey)
    if (r.checked) out[r.dataset.configKey] = r.value
  }

  for (const input of scope.querySelectorAll('[data-config-key]')) {
    const key = input.dataset.configKey
    const type = input.dataset.configType
    const widget = input.dataset.configWidget
    if (widget === 'list' || type === 'radio') continue
    if (radioKeys.has(key) && out[key] === undefined) continue
    if (type === 'boolean') {
      out[key] = input.checked
      continue
    }
    const raw = String(input.value ?? '').trim()
    if (raw === '') continue // 没填就不提交这个键
    out[key] = type === 'number' ? Number(raw) : raw
  }
  return out
}

$('module-config-save').addEventListener('click', async () => {
  const id = state.moduleId
  if (!id) return
  const msg = $('module-config-msg')
  const btn = $('module-config-save')
  btn.disabled = true
  msg.textContent = '保存中…'
  try {
    const r = await postApi('/api/modules/config', { id, config: collectConfigForm() })
    const dropped = (r.dropped ?? []).length ? `（忽略了未声明的字段：${r.dropped.join('、')}）` : ''
    const rt = r.runtime?.restarted ? '，模块已用新配置重启' : r.runtime?.skipped === 'disabled' ? '，模块处于停用状态，启用后生效' : ''
    msg.textContent = `✓ 已保存${dropped}${rt}`
    await loadModules()
    await openModule(id)
    $('module-config-msg').textContent = `✓ 已保存${dropped}${rt}`
  } catch (err) {
    msg.textContent = `保存失败：${err.message}`
  } finally {
    btn.disabled = false
  }
})

async function openModule(id) {
  const d = await api(`/api/module?id=${encodeURIComponent(id)}`)
  const m = d.module
  // 留住详情：列表里没有 uiTabs / configFields，点 tab 时要靠这一份判断页型
  // 同时把"有没有新版"带过来（列表那份可能已经被自动检查标过）
  m.update = state.modules.find((x) => x.id === id)?.update ?? null
  state.moduleDetail = m
  showModuleView(id, id)
  renderUpdateBadge()

  $('module-title').textContent = moduleDisplayName(m)
  $('module-subtitle').textContent = `${m.id} · v${m.version}${m.description ? ` · ${m.description}` : ''}`
  $('module-msg').textContent = ''
  // 开关状态直接绑 enabled（不是"按钮文字"那种间接表达）
  $('module-toggle').checked = m.enabled
  $('module-toggle-label').textContent = m.enabled ? '已启用' : '已停用'
  // 每次进详情都从「概况」开始：上次停在哪个 tab 是浏览痕迹，不是状态
  state.moduleTab = 'brief'
  renderModuleTabs(m, 'brief')

  const meta = $('module-meta')
  meta.innerHTML = ''
  const rows = [
    ['状态', (STATE_LABELS[m.state] ?? [m.state])[0]],
    ['版本', `v${m.version}`],
    ['协议', `api ${m.api}`],
    ['类型', m.kind || 'gateway'],
    ['来源', m.source || 'manual'],
    ['仓库', m.repo || '—'],
    ['上次源', m.previousRepo || '—'],
    ['安装于', (m.installedAt || '').slice(0, 19).replace('T', ' ') || '—'],
    ['崩溃', m.lastCrash ? `${m.lastCrash.reason}（${String(m.lastCrash.at).slice(0, 19)}）` : '无'],
  ]
  for (const [k, v] of rows) {
    meta.append(el('div', 'k', k), el('div', 'v', String(v)))
  }

  // 能力：每条一个开关。没声明的能力没有开关——授予不存在的权限是无意义的。
  const caps = $('module-caps')
  caps.innerHTML = ''
  for (const c of m.capabilities ?? []) {
    const on = (m.granted ?? []).includes(c)
    const n = el('div', 'item')
    const body = el('div', 'body')
    const t = el('div', 't')
    if (CAP_RISK[c]) t.append(el('span', 'tag warn', '敏感'))
    t.append(document.createTextNode(CAP_LABELS[c] ?? c), el('span', 'muted small', `  ${c}`))
    body.append(t, el('div', 's', on ? '已授予' : '未授予'))
    n.append(body)

    const acts = el('div', 'actions')
    acts.append(
      mkBtn(on ? '收回' : '授予', 'small ghost', async () => {
        await postApi('/api/modules/grant', { id: m.id, capability: c, granted: !on })
        await openModule(m.id)
        await loadModules()
        if (!on) $('module-msg').textContent = '已授予，模块正在启动…'
      }),
    )
    n.append(acts)
    caps.append(n)
  }
  if (!(m.capabilities ?? []).length) caps.append(el('div', 'muted small', '该模块没有声明任何能力。'))

  // 配置：按模块声明的 schema 渲染成真表单（原来是打印一段 JSON，等于让人手改文件）。
  // 被「config 型 tab」认领的字段不在这里重复出现——同一份配置不该有两个编辑入口。
  const claimed = new Set((m.uiTabs ?? []).flatMap((t) => (Array.isArray(t.fields) ? t.fields : [])))
  const briefConfig =
    claimed.size && Array.isArray(m.configFields)
      ? { ...m, configFields: m.configFields.filter((f) => !claimed.has(f.key)) }
      : m
  renderConfigForm(briefConfig)

  const sources = m.sources ?? []
  $('module-rules').innerHTML = ''
  if (m.routes?.length) $('module-rules').append(el('div', undefined, `认领的场景：${m.routes.join('、')}`))
  if (sources.length) $('module-rules').append(el('div', undefined, `它能被要的数据：${sources.join('、')}`))
  if (!m.routes?.length && !sources.length) $('module-rules').append(el('div', undefined, '没有场景认领，也没有声明可被取数的来源。'))

  const log = $('module-log')
  log.textContent = (m.log ?? []).slice(-40).join('\n') || '（还没有日志）'
  $('module-log-hint').textContent = `${(m.log ?? []).length} 行`
}

const titles = Object.fromEntries([...FRAME_NAV, ...PERSONA_NAV].map((n) => [n.id, n.label]))
const MODE_LABELS = { frame: '框架', persona: '人格', modules: '模块' }

async function openTab(name) {
  const mode = TAB_MODE[name]
  if (!mode) return
  // 从别的模式点过来：先换顶栏与左侧菜单，再走公共的显隐逻辑
  if (state.mode !== mode) {
    state.mode = mode
    paintModes()
    buildNav()
  }
  state.tab = name
  state.tabByMode[mode] = name
  for (const b of document.querySelectorAll('.nav-item')) b.classList.toggle('is-active', b.dataset.tab === name)
  for (const s of document.querySelectorAll('.main > .page')) s.hidden = s.id !== `tab-${name}`
  $('crumb-root').textContent = `原灵 · ${MODE_LABELS[mode] ?? mode}`
  $('crumb-page').textContent = titles[name] || name
  hidePageError()
  try {
    await loaders[name]()
  } catch (err) {
    if (String(err.message) !== 'unauthorized') console.error(err)
    showPageError(err)
  }
}

// ── 事件绑定 ──────────────────────────────────────────────────────────
$('mode-frame').addEventListener('click', () => setMode('frame'))
$('mode-persona').addEventListener('click', () => setMode('persona'))
$('mode-modules').addEventListener('click', () => setMode('modules'))

// ── 模块页事件 ────────────────────────────────────────────────────────
$('module-refresh').addEventListener('click', () => {
  loadModules().catch(() => {})
})

$('module-back').addEventListener('click', () => openModuleConsole())

$('module-refresh-one').addEventListener('click', () => {
  if (state.moduleId) openModule(state.moduleId).catch(() => {})
})

$('module-toggle').addEventListener('change', async () => {
  if (!state.moduleId) return
  const id = state.moduleId
  const enable = $('module-toggle').checked
  const box = $('module-toggle')
  box.disabled = true
  $('module-msg').textContent = enable ? '正在启动…' : '正在停止…'
  try {
    const r = await postApi('/api/modules/enable', { id, enabled: enable })
    // 如实说进程发生了什么：光改注册表不叫"已停用"
    const rt = r.runtime ?? {}
    const detail = enable
      ? rt.started
        ? '已启动'
        : rt.skipped === 'already-running'
          ? '已在运行'
          : rt.error
            ? `启动失败：${rt.error}`
            : '已启用'
      : rt.stopped
        ? '已停止'
        : '注册表已停用（进程本来就没在跑）'
    $('module-msg').textContent = detail
    await loadModules()
    await openModule(id)
    $('module-msg').textContent = detail
  } catch (err) {
    // 失败要把开关拨回去，否则界面撒谎说"已停用"
    box.checked = !enable
    $('module-msg').textContent = `失败：${err.message}`
  } finally {
    box.disabled = false
  }
})

/**
 * 检查更新：只查元数据（不下载），有新版就弹窗问要不要更新。
 *
 * "有没有新版"只存在一个地方：`state.modules[].update`。
 * DOM 上的角标每次由 renderUpdateBadge() 从数据推导——之前把 DOM 的 hidden 当状态存，
 * 结果手动查完（已是最新）清掉了角标，列表一重建又按内存里的旧标记挂回来（真踩过）。
 */
$('module-check-update').addEventListener('click', async () => {
  const id = state.moduleId
  if (!id) return
  const msg = $('module-msg')
  const btn = $('module-check-update')
  btn.disabled = true
  msg.textContent = '正在查发行版…（只查版本，不下载）'
  try {
    const r = await postApi('/api/modules/check-update', { id })
    setUpdateState(id, r.hasUpdate ? r.latest : null)

    if (!r.hasUpdate) {
      msg.textContent = `已是最新（本地 ${r.current}，远端 ${r.latest ?? '—'}）`
      return
    }
    msg.textContent = `发现新版本 ${r.latest}（当前 ${r.current}）`
    if (confirm(`「${id}」有新版本 ${r.latest}（当前 ${r.current}）。\n\n现在更新吗？更新会重新下载并覆盖当前版本，模块会短暂重启。`)) {
      msg.textContent = '正在下载并安装…'
      await postApi('/api/modules/install-url', { url: r.repo })
      setUpdateState(id, null)
      await loadModules()
      await openModule(id)
      $('module-msg').textContent = '✓ 已更新'
    }
  } catch (err) {
    msg.textContent = `检查失败：${err.message}`
  } finally {
    btn.disabled = false
  }
})

/** 记下某个模块有没有新版（null = 没有/未知）。同时刷新菜单角标与详情角标。 */
function setUpdateState(id, latest) {
  const m = state.modules.find((x) => x.id === id)
  if (m) m.update = latest || null
  if (state.moduleDetail && state.moduleDetail.id === id) state.moduleDetail.update = latest || null
  renderUpdateBadge()
  buildNav()
}

/** 详情页右上角那个"有新版本"标签：只从数据推导，不接受命令式开关。 */
function renderUpdateBadge() {
  const badge = $('module-update-badge')
  if (!badge) return
  const latest = state.moduleDetail?.update ?? null
  badge.hidden = !latest
  if (latest) {
    badge.textContent = `有新版本 ${latest}`
    badge.title = '点「检查更新」查看并更新'
  }
}

/**
 * 自动检查更新：进模块模式时顺手查一次，**6 小时内不重复查**。
 *
 * 为什么不每次都查：查更新是打外部 API，一天开十次页面就打十次——
 * 对方限流还算轻的，慢的时候整个页面都跟着卡。所以节流 + 失败静默。
 * 也不自动装：装是覆盖操作，必须人点头。
 */
const UPDATE_CHECK_KEY = 'yl.updateCheckedAt'
const UPDATE_CHECK_INTERVAL = 6 * 60 * 60 * 1000

async function autoCheckUpdates() {
  let last = 0
  try {
    last = Number(localStorage.getItem(UPDATE_CHECK_KEY)) || 0
  } catch {}
  if (Date.now() - last < UPDATE_CHECK_INTERVAL) return
  try {
    localStorage.setItem(UPDATE_CHECK_KEY, String(Date.now()))
  } catch {}

  for (const m of state.modules) {
    if (!m.repo) continue // 本地装的没法查
    try {
      const r = await postApi('/api/modules/check-update', { id: m.id })
      // 统一走 setUpdateState：它同时管内存与两处角标
      setUpdateState(m.id, r.hasUpdate ? r.latest : null)
    } catch {
      /* 查不到就算了：网络问题不该冒泡到界面 */
    }
  }
  buildNav()
}

$('module-export').addEventListener('click', async () => {
  if (!state.moduleId) return
  try {
    const r = await postApi('/api/modules/export', { id: state.moduleId })
    $('module-msg').textContent = `已导出：${r.path}（${(r.bytes / 1024).toFixed(1)} KB，sha256 ${r.sha256.slice(0, 12)}…）`
  } catch (err) {
    $('module-msg').textContent = `导出失败：${err.message}`
  }
})

$('module-uninstall').addEventListener('click', async () => {
  if (!state.moduleId) return
  if (!confirm(`确定卸载 ${state.moduleId}？模块目录与配置会一起删除。`)) return
  try {
    await postApi('/api/modules/uninstall', { id: state.moduleId })
    showModuleView('console')
    await loadModules()
  } catch (err) {
    $('module-msg').textContent = `卸载失败：${err.message}`
  }
})

$('module-install').addEventListener('click', async () => {
  const input = $('module-file').value.trim()
  const msg = $('module-install-msg')
  if (!input) {
    msg.textContent = '请填库的网址、.tgz 直链，或本地 .tgz 的绝对路径'
    return
  }
  const isUrl = /^https?:\/\//i.test(input)
  msg.textContent = isUrl ? '正在查发行版并下载…（要联网，慢的话等 30 秒）' : '安装中…'
  try {
    const r = isUrl
      ? await postApi('/api/modules/install-url', { url: input })
      : await postApi('/api/modules/install', { file: input, source: 'manual' })
    const from = r.assetName ? `（${r.assetName}${r.ref ? ` · ${r.ref}` : ''}）` : ''
    const runtime = r.runtime?.started ? '，已启动' : r.runtime?.skipped === 'already-running' ? '，已在运行' : ''
    msg.textContent = `✓ 已安装 ${r.id} v${r.version}${r.updated ? '（更新）' : ''}${from}${runtime}`
    $('module-file').value = ''
    await loadModules()
    showGrantModal({ id: r.id, name: state.modules.find((m) => m.id === r.id)?.name, capabilities: r.capabilities })
  } catch (err) {
    msg.textContent = `安装失败：${err.message}`
  }
})

/**
 * 装完的能力确认（协议 §2.1，v1.1）：**弹窗**里一次列全、一个决定，不逐条勾选。
 * 默认是空授权，所以这个弹窗是"要不要开"的唯一入口。
 */
function showGrantModal(result) {
  const modal = $('grant-modal')
  const list = $('grant-modal-list')
  const caps = Array.isArray(result.capabilities) ? result.capabilities : []
  if (!modal) return
  state.pendingGrantId = result.id

  $('grant-modal-title').textContent = `授予「${result.name || result.id}」的能力`
  $('grant-modal-msg').textContent = ''
  list.textContent = ''
  if (!caps.length) {
    list.append(el('div', 'muted small', '这个模块没有声明任何能力，装完就能用。'))
    $('grant-modal-ok').hidden = true
    $('grant-modal-skip').textContent = '知道了'
  } else {
    $('grant-modal-ok').hidden = false
    $('grant-modal-skip').textContent = '先不授予'
    for (const c of caps) {
      const row = el('div', 'item')
      const body = el('div', 'body')
      const t = el('div', 't')
      if (CAP_RISK[c]) t.append(el('span', 'tag warn', '敏感'))
      t.append(document.createTextNode(CAP_LABELS[c] ?? c), el('span', 'muted small', `  ${c}`))
      body.append(t, el('div', 's', CAP_HINTS[c] ?? ''))
      row.append(body)
      list.append(row)
    }
  }
  modal.hidden = false
}

function closeGrantModal() {
  $('grant-modal').hidden = true
  state.pendingGrantId = null
}

$('grant-modal-ok').addEventListener('click', async () => {
  const id = state.pendingGrantId
  if (!id) return closeGrantModal()
  const btn = $('grant-modal-ok')
  btn.disabled = true
  try {
    const r = await postApi('/api/modules/grant-all', { id, granted: true })
    closeGrantModal()
    await loadModules()
    // 授予之后顺手打开它的详情：让人立刻看到"现在真的是运行中"
    await openModule(id)
    $('module-msg').textContent = `已授予：${(r.granted ?? []).join('、') || '无'}`
  } catch (err) {
    $('grant-modal-msg').textContent = `授予失败：${err.message}`
  } finally {
    btn.disabled = false
  }
})

$('grant-modal-skip').addEventListener('click', () => {
  closeGrantModal()
  $('module-install-msg').textContent = '已安装但不授予任何能力：模块装着不干活。想开的时候在它的详情页里逐条授予。'
})
$('theme-toggle').addEventListener('click', toggleTheme)
$('model-select').addEventListener('change', () => {
  $('model-save').disabled = !$('model-select').value
  renderModelEfforts()
})
$('model-save').addEventListener('click', () => saveModel())

$('btn-token').addEventListener('click', () => showTokenBar($('tokenbar').hidden))
$('token-save').addEventListener('click', async () => {
  state.token = $('token-input').value.trim()
  try {
    localStorage.setItem(tokenKey, state.token)
  } catch {}

  const msg = $('token-msg')
  if (!state.token) {
    setConn(false, '令牌为空')
    msg.textContent = '令牌为空'
    return
  }

  // 明确的反馈：成功才收起输入条，失败把原因留在原地——
  // 之前这里静默失败，用户只会看到"点了没反应"。
  msg.textContent = '正在验证…'
  try {
    await api('/api/status')
    msg.textContent = '✓ 已连接'
    setConn(true)
    showTokenBar(false)
    await openTab(state.tab)
  } catch (error) {
    const reason = String(error?.message ?? error) === 'unauthorized' ? '令牌不匹配（HTTP 401）' : String(error?.message ?? error)
    msg.textContent = `✗ ${reason}`
    setConn(false, reason)
  }
})

$('global-search').addEventListener('keydown', (e) => {
  if (e.key !== 'Enter') return
  const q = $('global-search').value.trim()
  if (!q) return
  $('mem-q').value = q
  openTab('memory').then(() => loadMemory())
})

// ── 人格卡事件 ────────────────────────────────────────────────────────
$('persona-new-open').addEventListener('click', () => openNewPersona())
$('persona-switch-open').addEventListener('click', () => openSwitchPersona())
$('ps-cancel').addEventListener('click', () => {
  $('persona-switch-modal').hidden = true
})
$('pn-cancel').addEventListener('click', () => {
  $('persona-new-modal').hidden = true
})
$('pn-ok').addEventListener('click', () => {
  submitNewPersona().catch((err) => {
    $('pn-msg').textContent = `失败：${err.message}`
  })
})
$('persona-save').addEventListener('click', () => {
  saveOverview().catch((err) => {
    $('persona-save-msg').textContent = `保存失败：${err.message}`
    $('persona-save').disabled = false
  })
})
$('persona-reload').addEventListener('click', () => {
  loadOverview().catch((err) => showPageError(err))
})

// 记忆页：两张脸之间切
$('mem-view').addEventListener('click', (e) => {
  const b = e.target.closest('button[data-view]')
  if (!b) return
  state.memoryView = b.dataset.view
  for (const x of $('mem-view').querySelectorAll('button')) x.classList.toggle('is-active', x === b)
  const search = state.memoryView === 'search'
  $('mem-view-search').hidden = !search
  $('mem-view-entries').hidden = search
  loadMemory().catch(() => {})
})


$('card-load').addEventListener('click', () => loadCard().catch((err) => showPageError(err)))
$('card-scene').addEventListener('change', () => loadCard().catch((err) => showPageError(err)))
$('mem-go').addEventListener('click', () => loadMemory().catch(() => {}))
$('mem-q').addEventListener('keydown', (e) => e.key === 'Enter' && loadMemory().catch(() => {}))
$('mem-all').addEventListener('change', () => loadMemory().catch(() => {}))
$('rule-save').addEventListener('click', () => {
  saveRules().catch((err) => {
    $('rule-msg').textContent = `保存失败：${err.message}`
    $('rule-save').disabled = false
  })
})
$('rule-reload').addEventListener('click', () => loadRules().catch((err) => showPageError(err)))
$('policy-save').addEventListener('click', () => savePolicy().catch(() => {}))

$('proposal-scan').addEventListener('click', async () => {
  try {
    const r = await postApi('/api/proposal', { action: 'scan' })
    await loadProposals()
    if (!r.created.length) alert('没有新提案（重复次数或跨度还不够）')
  } catch (err) {
    alert(`扫描失败：${err.message}`)
  }
})

// ── 弹窗事件（人物/群体的新增与编辑共用）──────────────────────────────
$('modal-ok').addEventListener('click', () => submitModal().catch(() => {}))
$('modal-cancel').addEventListener('click', () => closeModal())
$('modal-mask').addEventListener('click', () => closeModal())
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !$('modal').hidden) closeModal()
})

// ── 人物事件 ──────────────────────────────────────────────────────────
$('person-new').addEventListener('click', () => openPersonCreate().catch((err) => alert(`打不开新增窗口：${err.message}`)))

$('gentle-admin').addEventListener('change', async (e) => {
  const want = e.target.checked
  try {
    await postApi('/api/prefs', { gentleToAdmin: want })
    flash(want ? '已开启：注入里会要求对管理员更温柔' : '已关闭')
  } catch (err) {
    e.target.checked = !want
    alert(`保存失败：${err.message}`)
  }
})

// ── 群体事件 ──────────────────────────────────────────────────────────
$('group-new').addEventListener('click', () => openGroupCreate().catch((err) => alert(`打不开新增窗口：${err.message}`)))

// 黑白名单的开关（两页各一套，互斥由后端保证）
wireAudience('people')
wireAudience('groups')

$('outbox-plan').addEventListener('click', async () => {
  try {
    const r = await postApi('/api/outbox/plan', {})
    await loadOutbox()
    const bits = [`想出 ${r.queued} 句`]
    if (r.held?.length) bits.push(`压着 ${r.held.length} 条（${[...new Set(r.held.map((h) => h.reason))].join('、')}）`)
    if (r.skipped?.length) bits.push(`跳过 ${r.skipped.length} 条`)
    flash(bits.join('；'))
  } catch (err) {
    alert(`算失败：${err.message}`)
  }
})

$('log-lens').addEventListener('click', (e) => {
  const b = e.target.closest('button[data-lens]')
  if (!b) return
  state.logLens = b.dataset.lens
  for (const x of $('log-lens').querySelectorAll('button')) x.classList.toggle('is-active', x === b)
  loadLogs().catch(() => {})
})

$('diag-mode').addEventListener('click', (e) => {
  const b = e.target.closest('button[data-mode]')
  if (!b) return
  state.diagMode = b.dataset.mode
  for (const x of $('diag-mode').querySelectorAll('button')) x.classList.toggle('is-active', x === b)
  loadDiag().catch(() => {})
})

// ── 启动 ──────────────────────────────────────────────────────────────
buildNav()
openTab('status')
if (!state.token) showTokenBar(true)
