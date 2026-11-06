// 管理台前端：无构建、无依赖。token 存 localStorage，只发给本机回环服务。
const $ = (id) => document.getElementById(id)
const tokenKey = 'yuanling.token'

const state = { token: localStorage.getItem(tokenKey) || '', tab: 'status' }

function showTokenBar(show) {
  $('tokenbar').hidden = !show
  if (show) $('token-input').focus()
}

async function api(path, { retry = true } = {}) {
  const res = await fetch(path, {
    headers: state.token ? { 'x-yuanling-token': state.token } : {},
  })
  if (res.status === 401) {
    showTokenBar(true)
    throw new Error('unauthorized')
  }
  if (!res.ok) {
    const t = await res.text().catch(() => '')
    throw new Error(`${res.status} ${t.slice(0, 120)}`)
  }
  return res.json()
}

function el(tag, cls, text) {
  const n = document.createElement(tag)
  if (cls) n.className = cls
  if (text !== undefined) n.textContent = text
  return n
}

function card(k, v) {
  const n = el('div', 'card')
  n.append(el('div', 'k', k), el('div', 'v', String(v)))
  return n
}

// ── 各面板 ──────────────────────────────────────────────────────────────

async function loadStatus() {
  const s = await api('/api/status')
  $('status-line').textContent = `${s.active ?? '（无）'} · ${s.root}`
  const box = $('status-cards')
  box.innerHTML = ''
  box.append(card('人格', s.personas.length), card('条目', s.entries), card('事实', s.facts), card('格式', s.format ?? '-'))

  const list = $('personas')
  list.innerHTML = ''
  for (const p of s.personas) {
    const n = el('div', 'item')
    n.append(el('div', 't', `${p.active ? '● ' : '○ '}${p.name}（${p.id}）`))
    list.append(n)
  }
}

async function loadCard() {
  const ch = $('card-channel').value.trim()
  const q = ch ? `?channel=${encodeURIComponent(ch)}` : ''
  const d = await api(`/api/card${q}`)
  $('card-out').textContent = d.text || '（空）'
  $('card-meta').textContent = `${d.bytes} 字节 / 预算 800`
}

async function loadMemory() {
  const q = $('mem-q').value.trim()
  const all = $('mem-all').checked ? '1' : '0'
  const d = await api(`/api/memory?q=${encodeURIComponent(q)}&all=${all}&limit=20`)
  const box = $('mem-out')
  box.innerHTML = ''
  if (!d.hits.length) {
    box.append(el('div', 'muted', '没有命中。可能没记过，或换个说法。'))
    return
  }
  for (const h of d.hits) {
    const n = el('div', 'item')
    const head = el('div', 't')
    head.append(el('span', 'tag', h.topic))
    if (h.band) head.append(el('span', 'tag', h.band))
    if (h.until) head.append(el('span', 'tag warn', '已失效'))
    if (h.shielded) head.append(el('span', 'tag bad', '已隔离'))
    head.append(document.createTextNode(h.text))
    n.append(head)
    n.append(el('div', 's', `${h.score} · ${h.clarity} · ${h.src}`))
    box.append(n)
  }
}

async function loadEntries() {
  const d = await api('/api/entries')
  const box = $('entries-out')
  box.innerHTML = ''
  if (!d.entries.length) {
    box.append(el('div', 'muted', '还没有任何条目。'))
    return
  }
  for (const e of d.entries) {
    const n = el('div', 'item')
    n.append(el('div', 't', `${e.space} / ${e.topic}`))
    n.append(el('div', 's', `${e.facts} 条事实（${e.active} 条有效） ${e.summary || ''}`))
    box.append(n)
  }
}

async function loadRules() {
  const ch = $('rule-channel').value.trim()
  const q = ch ? `?channel=${encodeURIComponent(ch)}` : ''
  const d = await api(`/api/rules${q}`)
  $('rule-out').textContent = JSON.stringify(d.rules, null, 2)
  $('rule-src').textContent = d.sources.length ? `来源：${d.sources.join(' → ')}` : '（无规则文件，全部取默认）'
}

async function loadSources() {
  const d = await api('/api/sources')
  const box = $('sources-out')
  box.innerHTML = ''
  if (!d.sources.length) {
    box.append(el('div', 'muted', '还没有任何来源写过心跳。'))
    return
  }
  for (const s of d.sources) {
    const n = el('div', 'item')
    const cls = s.state === 'silent' ? 'bad' : s.state === 'ok' ? '' : 'warn'
    const head = el('div', 't')
    head.append(el('span', cls ? `tag ${cls}` : 'tag', s.state))
    head.append(document.createTextNode(s.source))
    n.append(head)
    n.append(el('div', 's', s.at || '-'))
    box.append(n)
  }
}

async function loadRefusals() {
  const d = await api('/api/refusals')
  const box = $('refusals-out')
  box.innerHTML = ''
  if (!d.refusals.length) {
    box.append(el('div', 'muted', '还没有拒绝记录。'))
    return
  }
  for (const r of d.refusals) {
    const n = el('div', 'item')
    n.append(el('div', 't', `${r.dim}/${r.action}`))
    n.append(el('div', 's', `${r.ts} ${r.channel || ''} ${r.reason || ''}`))
    box.append(n)
  }
}

// ── 切页 ────────────────────────────────────────────────────────────────

const loaders = {
  status: loadStatus,
  card: loadCard,
  memory: loadMemory,
  entries: loadEntries,
  rules: loadRules,
  sources: loadSources,
  refusals: loadRefusals,
}

async function openTab(name) {
  state.tab = name
  for (const b of $('tabs').querySelectorAll('button')) b.classList.toggle('active', b.dataset.tab === name)
  for (const s of document.querySelectorAll('main > section')) s.hidden = s.id !== `tab-${name}`
  try {
    await loaders[name]()
  } catch (err) {
    if (String(err.message) !== 'unauthorized') console.error(err)
  }
}

$('tabs').addEventListener('click', (e) => {
  const b = e.target.closest('button[data-tab]')
  if (b) openTab(b.dataset.tab)
})

$('btn-token').addEventListener('click', () => showTokenBar($('tokenbar').hidden))
$('token-save').addEventListener('click', () => {
  state.token = $('token-input').value.trim()
  localStorage.setItem(tokenKey, state.token)
  showTokenBar(false)
  openTab(state.tab)
})

$('card-load').addEventListener('click', () => loadCard().catch(() => {}))
$('mem-go').addEventListener('click', () => loadMemory().catch(() => {}))
$('rule-load').addEventListener('click', () => loadRules().catch(() => {}))
$('mem-q').addEventListener('keydown', (e) => e.key === 'Enter' && loadMemory().catch(() => {}))
$('card-channel').addEventListener('keydown', (e) => e.key === 'Enter' && loadCard().catch(() => {}))

if (!state.token) showTokenBar(true)
openTab('status')
