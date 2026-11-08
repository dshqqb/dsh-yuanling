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
}

// ── 图标（内联，不引图标库）──────────────────────────────────────────
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
  if (state.mode !== 'core') {
    nav.append(el('div', 'muted small', '（还没有已安装的模块）'))
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
  buildNav()
  if (mode === 'core') {
    openTab(state.tab)
    return
  }
  $('crumb-page').textContent = '模块'
  for (const s of document.querySelectorAll('.main > .page')) s.hidden = s.id !== 'page-modules'
  loadModules().catch(() => {})
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
    return
  }
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
}

/** send 是唯一"能往外说话"的能力，单独标风险。 */
const CAP_RISK = { send: true }

const STATE_LABELS = {
  running: ['运行中', 'ok'],
  ready: ['就绪', 'ok'],
  stopped: ['已停止', ''],
  starting: ['启动中', 'warn'],
  restarting: ['重启中', 'warn'],
  crashed: ['已崩溃', 'bad'],
}

async function loadModules() {
  const d = await api('/api/modules')

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
    list.append(el('div', 'muted small', '还没有安装任何模块。QQ 适配器会作为第一个官方模块出现在这里。'))
    return
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
    t.append(tags, document.createTextNode(m.name || m.id))

    const caps = (m.granted ?? []).map((c) => CAP_LABELS[c] ?? c).join('、') || '无'
    body.append(t, el('div', 's', `${m.id} · v${m.version} · 能力：${caps}`))
    n.append(body)

    const acts = el('div', 'actions')
    acts.append(mkBtn('详情', 'small ghost', () => openModule(m.id)))
    n.append(acts)
    list.append(n)
  }
}

async function openModule(id) {
  const d = await api(`/api/module?id=${encodeURIComponent(id)}`)
  const m = d.module
  state.moduleId = id

  $('module-detail').hidden = false
  $('module-title').textContent = `${m.name || m.id}（${m.id}）`
  $('module-msg').textContent = ''
  $('module-toggle').textContent = m.enabled ? '停用' : '启用'

  const meta = $('module-meta')
  meta.innerHTML = ''
  const rows = [
    ['版本', `v${m.version}`],
    ['协议', `api ${m.api}`],
    ['类型', m.kind || 'gateway'],
    ['来源', m.source || 'manual'],
    ['仓库', m.repo || '—'],
    ['上次源', m.previousRepo || '—'],
    ['安装于', (m.installedAt || '').slice(0, 19).replace('T', ' ') || '—'],
    ['状态', (STATE_LABELS[m.state] ?? [m.state])[0]],
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
      }),
    )
    n.append(acts)
    caps.append(n)
  }
  if (!(m.capabilities ?? []).length) caps.append(el('div', 'muted small', '该模块没有声明任何能力。'))

  // 配置：这一轮只读（QQ 模块还不存在，表单没有真实字段可绑）
  $('module-config').textContent = m.configSchema
    ? `已声明 schema，当前值：${JSON.stringify(m.config ?? {}, null, 2)}`
    : '该模块没有声明配置。'

  const log = $('module-log')
  log.textContent = (m.log ?? []).slice(-40).join('\n') || '（还没有日志）'
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

$('module-close').addEventListener('click', () => {
  $('module-detail').hidden = true
  state.moduleId = null
})

$('module-toggle').addEventListener('click', async () => {
  if (!state.moduleId) return
  const cur = $('module-toggle').textContent === '停用'
  try {
    await postApi('/api/modules/enable', { id: state.moduleId, enabled: !cur })
    $('module-msg').textContent = cur ? '已停用（重启也不再启动）' : '已启用'
    await openModule(state.moduleId)
    await loadModules()
  } catch (err) {
    $('module-msg').textContent = `失败：${err.message}`
  }
})

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
    $('module-detail').hidden = true
    state.moduleId = null
    await loadModules()
  } catch (err) {
    $('module-msg').textContent = `卸载失败：${err.message}`
  }
})

$('module-install').addEventListener('click', async () => {
  const file = $('module-file').value.trim()
  const msg = $('module-install-msg')
  if (!file) {
    msg.textContent = '请填本地 .tgz 的绝对路径'
    return
  }
  msg.textContent = '安装中…'
  try {
    const r = await postApi('/api/modules/install', { file, source: 'manual' })
    msg.textContent = `✓ 已安装 ${r.id} v${r.version}${r.updated ? '（更新）' : ''}`
    $('module-file').value = ''
    await loadModules()
  } catch (err) {
    msg.textContent = `安装失败：${err.message}`
  }
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
