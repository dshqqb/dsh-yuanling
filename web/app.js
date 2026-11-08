// 管理台前端：无构建、无依赖。token 存 localStorage，只发给本机回环服务。
const $ = (id) => document.getElementById(id)
const tokenKey = 'yuanling.token'
const themeKey = 'yuanling.theme'

const state = {
  token: localStorage.getItem(tokenKey) || '',
  tab: 'status',
  mode: 'core',
  peopleSort: 'weight',
  moduleId: null,
  // 模块模式下的左侧菜单：控制台 + 每个已装模块。列表缓存在这里，回车/点击都不用再请求
  modules: [],
  moduleView: 'console',
  moduleTab: 'brief',
  // 当前打开模块的**详情**（含 uiTabs / configFields）。列表那份没有这些字段，
  // 点 tab 时要靠它判断"这页是 config 型还是 records 型"。
  moduleDetail: null,
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
  shield: '<path d="M12 3.6l7 2.6v5.4c0 4.4-3 7.4-7 8.8-4-1.4-7-4.4-7-8.8V6.2l7-2.6z" stroke-linejoin="round"/>',
  plug: '<path d="M9 3.5v4M15 3.5v4" stroke-linecap="round"/><path d="M6.5 7.5h11v3.2a5.5 5.5 0 01-11 0V7.5z" stroke-linejoin="round"/><path d="M12 16.5v4" stroke-linecap="round"/>',
  ban: '<circle cx="12" cy="12" r="8"/><path d="M6.4 17.6L17.6 6.4" stroke-linecap="round"/>',
  chart: '<path d="M4 20V9M9.3 20V4M14.7 20v-7M20 20v-4" stroke-linecap="round"/>',
  // 模块菜单项用立方体：和"控制台"的插头区分开，一眼能看出"这是一个模块"
  box: '<path d="M12 3.2l7.5 4.2-7.5 4.2-7.5-4.2 7.5-4.2z" stroke-linejoin="round"/><path d="M4.5 7.4v6.6l7.5 4.2 7.5-4.2V7.4" stroke-linejoin="round"/>',
}

const NAV = [
  { id: 'status', label: '状态', icon: 'gauge' },
  { id: 'card', label: '注入预览', icon: 'layers' },
  { id: 'memory', label: '记忆', icon: 'search' },
  { id: 'entries', label: '条目', icon: 'list' },
  { id: 'proposals', label: '提案', icon: 'spark' },
  { id: 'people', label: '人物', icon: 'user' },
  { id: 'rules', label: '规则', icon: 'shield' },
  { id: 'usage', label: '用量', icon: 'chart' },
  { id: 'sources', label: '来源', icon: 'plug' },
  { id: 'refusals', label: '拒绝记录', icon: 'ban' },
]

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
  if (state.mode !== 'core') {
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

  for (const item of NAV) {
    const b = el('button', 'nav-item' + (item.id === state.tab ? ' is-active' : ''))
    b.dataset.tab = item.id
    b.append(icon(item.icon), el('span', 'label', item.label))
    b.addEventListener('click', () => openTab(item.id))
    nav.append(b)
  }
}

function setMode(mode) {
  state.mode = mode
  $('mode-core').classList.toggle('is-active', mode === 'core')
  $('mode-modules').classList.toggle('is-active', mode !== 'core')
  if (mode === 'core') {
    $('page-modules').hidden = true
    state.moduleView = 'console'
    buildNav()
    openTab(state.tab)
    return
  }
  // 进模块模式：先把列表拉回来（左侧菜单直接从它渲染），默认落在控制台
  for (const s of document.querySelectorAll('.main > .page')) s.hidden = s.id !== 'page-modules'
  state.moduleView = 'console'
  loadModules()
    .then(() => autoCheckUpdates())
    .catch(() => {})
  showModuleView('console')
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

  $('side-persona').textContent = s.personas.find((p) => p.active)?.name || s.active || '—'
  $('side-root').textContent = s.root

  const box = $('status-cards')
  box.innerHTML = ''
  box.append(stat('条目', s.entries, '个主题'), stat('事实', s.facts, '条记忆'), stat('待定提案', pending, '等你决定'), stat('人格', s.personas.length, s.active || ''))

  const list = $('personas')
  list.innerHTML = ''
  if (!s.personas.length) list.append(el('div', 'muted small', '还没有人格'))
  for (const p of s.personas) {
    const n = el('div', 'item')
    const body = el('div', 'body')
    body.append(el('div', 't', `${p.active ? '● ' : '○ '}${p.name}`), el('div', 's', p.id))
    n.append(body)
    list.append(n)
  }
}

async function loadCard() {
  const ch = $('card-channel').value.trim()
  const q = ch ? `?channel=${encodeURIComponent(ch)}` : ''
  const d = await api(`/api/card${q}`)
  $('card-out').textContent = d.text || '（空）'
  $('card-meta').textContent = `${d.bytes} 字节 / 预算 ${d.budget}${d.channel ? ` · 频道 ${d.channel}` : ''}`
}

async function loadMemory() {
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

function personCard(p, { draggable = false } = {}) {
  const n = el('div', 'item' + (draggable ? ' is-draggable' : ''))
  if (draggable) {
    n.draggable = true
    n.addEventListener('dragstart', (e) => {
      e.dataTransfer.setData('text/plain', p.uid)
      e.dataTransfer.effectAllowed = 'move'
      n.classList.add('dragging')
    })
    n.addEventListener('dragend', () => n.classList.remove('dragging'))
  }

  const body = el('div', 'body')
  const head = el('div', 't')
  const tags = el('span')
  if (p.admin) tags.append(el('span', 'tag purple', '管理员'))
  if (p.pinned) tags.append(el('span', 'tag ok', '重要'))
  tags.append(el('span', p.weightSource === 'manual' ? 'tag warn' : 'tag', `${p.weight}${p.weightSource === 'manual' ? ' 手动' : ''}`))
  head.append(tags, document.createTextNode(p.display))

  const accts = p.identities.map((x) => `${x.platform}:${x.id}`).join('、') || '无账号'
  body.append(head, el('div', 's', `${p.uid} · ${accts}${p.sketch ? ' · ' + p.sketch.slice(0, 40) : ''}`))
  n.append(body)

  const acts = el('div', 'actions')
  if (!p.admin) {
    acts.append(
      mkBtn('设为管理员', 'small ghost', async () => {
        await postApi('/api/person/admin', { uid: p.uid })
        await loadPeople()
      }),
    )
  } else {
    acts.append(
      mkBtn('卸任', 'small ghost', async () => {
        await postApi('/api/person/admin', { uid: null })
        await loadPeople()
      }),
    )
  }
  if (p.pinned) {
    acts.append(
      mkBtn('移出重要', 'small ghost', async () => {
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
    )
  }
  acts.append(mkBtn('编辑', 'small ghost', () => openPersonEditor(p)))
  n.append(acts)
  return n
}

async function openPersonEditor(p) {
  const d2 = await api(`/api/person?uid=${encodeURIComponent(p.uid)}`)
  state.personUid = p.uid
  $('person-editor').hidden = false
  $('person-title').textContent = `${d2.person.display}（${p.uid}）`
  $('person-display').value = d2.person.display || ''
  $('person-identity').value = d2.person.identity_text || ''
  const parsedBits = (d2.person.identity_parsed ?? []).map((x) => `${x.platform}:${x.id}`)
  $('person-identity-msg').textContent = parsedBits.length ? `已识别：${parsedBits.join('、')}` : ''
  $('person-sketch').value = d2.profile?.sketch || ''
  $('person-weight').value = d2.profile?.weight_source === 'manual' ? d2.profile.weight : ''
  $('person-msg').textContent = d2.profile ? '' : '（还没有档案，保存后会新建）'
  $('person-editor').scrollIntoView({ behavior: 'smooth', block: 'nearest' })
}

async function loadPeople() {
  const d = await api(`/api/people?sort=${state.peopleSort || 'weight'}`)

  const adminSlot = $('admin-slot')
  adminSlot.innerHTML = ''
  const admins = d.people.filter((p) => p.admin)
  if (!admins.length) adminSlot.append(el('div', 'zone-empty', '还没指定管理员。在下面任意一张卡上点「设为管理员」。'))
  for (const p of admins) adminSlot.append(personCard(p))

  const pinnedSlot = $('pinned-slot')
  pinnedSlot.innerHTML = ''
  const pinned = d.people.filter((p) => p.pinned && !p.admin)
  if (!pinned.length) pinnedSlot.append(el('div', 'zone-empty', '把下面的人物卡拖到这里，或点「设为重要」。'))
  for (const p of pinned) pinnedSlot.append(personCard(p))

  const rest = d.people.filter((p) => !p.admin && !p.pinned)
  $('people-count').textContent = `共 ${d.people.length} 人`
  const box = $('people-out')
  box.innerHTML = ''
  if (!rest.length) box.append(el('div', 'muted small', '没有其他人物了。'))
  for (const p of rest) box.append(personCard(p, { draggable: true }))
}

async function savePerson() {
  if (!state.personUid) return
  await postApi('/api/person', {
    uid: state.personUid,
    display: $('person-display').value,
    sketch: $('person-sketch').value,
  })

  // 身份描述：原文存下来，解析由核心做；没归属的账号会自动绑上
  const text = $('person-identity').value
  const r = await postApi('/api/person/identity', { uid: state.personUid, text })
  const bits = []
  if (r.parsed.length) bits.push(`识别出 ${r.parsed.map((x) => `${x.platform}:${x.id}`).join('、')}`)
  if (r.linked.length) bits.push(`新绑定 ${r.linked.length} 个`)
  if (r.conflicts.length) bits.push(`${r.conflicts.length} 个账号已属于别人，没有抢`)
  if (r.unparsed.length) bits.push(`没认出：${r.unparsed.join(' / ')}`)
  $('person-identity-msg').textContent = bits.join('；')

  const raw = $('person-weight').value.trim()
  if (raw !== '') {
    await postApi('/api/person/weight', { uid: state.personUid, weight: Number(raw) })
  }

  $('person-msg').textContent = '已保存（进版本历史，可回滚）'
  await loadPeople()
}

async function loadRules() {
  const ch = $('rule-channel').value.trim()
  const q = ch ? `?channel=${encodeURIComponent(ch)}` : ''
  const d = await api(`/api/rules${q}`)
  $('rule-out').textContent = JSON.stringify(d.rules, null, 2)
  $('rule-src').textContent = d.sources.length ? `来源：${d.sources.join(' → ')}` : '（无规则文件，全部取默认）'
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

async function loadRefusals() {
  const d = await api('/api/refusals')
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

// ── 切页 ──────────────────────────────────────────────────────────────
const loaders = {
  status: loadStatus,
  card: loadCard,
  memory: loadMemory,
  entries: loadEntries,
  proposals: loadProposals,
  people: loadPeople,
  rules: loadRules,
  usage: loadUsage,
  sources: loadSources,
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
  const custom = $('module-panel-custom')
  const isCustom = !MODULE_BASE_TABS.some((t) => t.id === id)
  custom.hidden = !isCustom
  if (!isCustom) return

  const spec = (current?.uiTabs ?? []).find((t) => t.id === id)
  // 两种自定义页都是异步的（要现取数据），失败只该影响这一块，不该冒到整页
  if (spec?.kind === 'config') renderConfigTab(id, current).catch((err) => showTabError(err))
  else loadModuleTabData(id, current).catch((err) => showTabError(err))
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
  if (m.routes?.length) $('module-rules').append(el('div', undefined, `认领的频道：${m.routes.join('、')}`))
  if (sources.length) $('module-rules').append(el('div', undefined, `它能被要的数据：${sources.join('、')}`))
  if (!m.routes?.length && !sources.length) $('module-rules').append(el('div', undefined, '没有频道认领，也没有声明可被取数的来源。'))

  const log = $('module-log')
  log.textContent = (m.log ?? []).slice(-40).join('\n') || '（还没有日志）'
  $('module-log-hint').textContent = `${(m.log ?? []).length} 行`
}

const titles = Object.fromEntries(NAV.map((n) => [n.id, n.label]))

async function openTab(name) {
  // 从「模块」回到「核心」时不走 setMode，避免它再回调 openTab 造成二次加载
  if (state.mode !== 'core') {
    state.mode = 'core'
    $('mode-core').classList.add('is-active')
    $('mode-modules').classList.remove('is-active')
    buildNav()
  }
  state.tab = name
  for (const b of document.querySelectorAll('.nav-item')) b.classList.toggle('is-active', b.dataset.tab === name)
  for (const s of document.querySelectorAll('.main > .page')) s.hidden = s.id !== `tab-${name}`
  $('crumb-page').textContent = titles[name] || name
  try {
    await loaders[name]()
  } catch (err) {
    if (String(err.message) !== 'unauthorized') console.error(err)
  }
}

// ── 事件绑定 ──────────────────────────────────────────────────────────
$('mode-core').addEventListener('click', () => setMode('core'))
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

$('card-load').addEventListener('click', () => loadCard().catch(() => {}))
$('card-channel').addEventListener('keydown', (e) => e.key === 'Enter' && loadCard().catch(() => {}))
$('mem-go').addEventListener('click', () => loadMemory().catch(() => {}))
$('mem-q').addEventListener('keydown', (e) => e.key === 'Enter' && loadMemory().catch(() => {}))
$('mem-all').addEventListener('change', () => loadMemory().catch(() => {}))
$('rule-load').addEventListener('click', () => loadRules().catch(() => {}))
$('rule-channel').addEventListener('keydown', (e) => e.key === 'Enter' && loadRules().catch(() => {}))

$('proposal-scan').addEventListener('click', async () => {
  try {
    const r = await postApi('/api/proposal', { action: 'scan' })
    await loadProposals()
    if (!r.created.length) alert('没有新提案（重复次数或跨度还不够）')
  } catch (err) {
    alert(`扫描失败：${err.message}`)
  }
})

$('person-save').addEventListener('click', () => {
  savePerson().catch((err) => {
    $('person-msg').textContent = `失败：${err.message}`
  })
})

$('person-weight-auto').addEventListener('click', async () => {
  if (!state.personUid) return
  try {
    await postApi('/api/person/weight', { uid: state.personUid, weight: null })
    $('person-weight').value = ''
    $('person-msg').textContent = '已恢复自动计分'
    await loadPeople()
  } catch (err) {
    $('person-msg').textContent = `失败：${err.message}`
  }
})

$('people-sort').addEventListener('click', (e) => {
  const b = e.target.closest('button[data-sort]')
  if (!b) return
  state.peopleSort = b.dataset.sort
  for (const x of $('people-sort').querySelectorAll('button')) x.classList.toggle('is-active', x === b)
  loadPeople().catch(() => {})
})

// 拖进「重要人物」即置顶
const pinnedSlot = $('pinned-slot')
pinnedSlot.addEventListener('dragover', (e) => {
  e.preventDefault()
  pinnedSlot.classList.add('drop-hot')
})
pinnedSlot.addEventListener('dragleave', () => pinnedSlot.classList.remove('drop-hot'))
pinnedSlot.addEventListener('drop', async (e) => {
  e.preventDefault()
  pinnedSlot.classList.remove('drop-hot')
  const uid = e.dataTransfer.getData('text/plain')
  if (!uid) return
  try {
    await postApi('/api/person/pin', { uid, pinned: true })
    await loadPeople()
  } catch (err) {
    alert(`失败：${err.message}`)
  }
})

// ── 启动 ──────────────────────────────────────────────────────────────
buildNav()
openTab('status')
if (!state.token) showTokenBar(true)
