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
    $('status-line').textContent = state.token ? '令牌无效（可能已随重建数据目录而更换）' : '还没有填令牌'
    showTokenBar(true)
    throw new Error('unauthorized')
  }
  if (!res.ok) {
    const t = await res.text().catch(() => '')
    $('status-line').textContent = `请求失败 ${res.status}`
    throw new Error(`${res.status} ${t.slice(0, 120)}`)
  }
  return res.json()
}

/** 写操作：POST + token。服务端不返回 CORS 头，所以跨站页面发不出这种请求。 */
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
    showTokenBar(true)
    throw new Error('unauthorized')
  }
  const data = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(data.error || `${res.status}`)
  return data
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

    const rawId = String(h.src || '').split('#').pop()
    if (rawId && h.src.startsWith('raw/')) {
      const acts = el('div', 'actions')
      acts.append(
        mkBtn('屏蔽这条', 'small danger', async () => {
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

function mkBtn(label, cls, onClick) {
  const b = el('button', cls, label)
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

async function loadProposals() {
  const d = await api('/api/proposals')
  const box = $('proposals-out')
  box.innerHTML = ''
  if (!d.proposals.length) {
    box.append(el('div', 'muted', '还没有提案。点上面的「扫描新提案」试试。'))
    return
  }
  for (const p of d.proposals) {
    const n = el('div', 'item')
    const head = el('div', 't')
    head.append(el('span', 'tag', p.status))
    head.append(document.createTextNode(p.claim))
    n.append(head)
    n.append(el('div', 's', `重复 ${p.count} 次 / ${p.days} 天 · 主题「${p.topic}」`))

    const acts = el('div', 'actions')
    if (p.status === 'pending') {
      acts.append(
        mkBtn('采纳', 'small', async () => {
          await postApi('/api/proposal', { id: p.id, action: 'approve' })
          await loadProposals()
        }),
      )
      acts.append(
        mkBtn('否决', 'small danger', async () => {
          if (!confirm(`否决这条提案？\n${p.claim}\n\n否决后不会再被自动批准。`)) return
          await postApi('/api/proposal', { id: p.id, action: 'reject' })
          await loadProposals()
        }),
      )
    } else if (p.status === 'approved') {
      acts.append(
        mkBtn('回滚', 'small ghost', async () => {
          if (!confirm(`把 ${p.claim} 从 style.md 撤掉？`)) return
          await postApi('/api/proposal', { id: p.id, action: 'rollback' })
          await loadProposals()
        }),
      )
    }
    if (acts.childNodes.length) n.append(acts)
    box.append(n)
  }
}

async function loadPeople() {
  const d = await api('/api/people')
  const box = $('people-out')
  box.innerHTML = ''
  if (!d.people.length) {
    box.append(el('div', 'muted', '还没有人物档案。'))
    return
  }
  for (const p of d.people) {
    const n = el('div', 'item')
    n.append(el('div', 't', `${p.display}（${p.uid}）`))
    const ids = p.identities.map((x) => `${x.platform}:${x.id}`).join('、') || '（无账号）'
    n.append(el('div', 's', ids))
    n.append(
      mkBtn('编辑素描', 'small ghost', async () => {
        const d2 = await api(`/api/person?uid=${encodeURIComponent(p.uid)}`)
        state.personUid = p.uid
        $('person-editor').hidden = false
        $('person-title').textContent = `${d2.person.display}（${p.uid}）`
        $('person-display').value = d2.person.display || ''
        $('person-sketch').value = d2.profile?.sketch || ''
        $('person-msg').textContent = d2.profile ? '' : '（还没有档案，保存后会新建）'
      }),
    )
    box.append(n)
  }
}

async function savePerson() {
  if (!state.personUid) return
  await postApi('/api/person', {
    uid: state.personUid,
    display: $('person-display').value,
    sketch: $('person-sketch').value,
  })
  $('person-msg').textContent = '已保存（进版本历史，可回滚）'
  await loadPeople()
}

// ── 切页 ────────────────────────────────────────────────────────────────

const loaders = {
  status: loadStatus,
  card: loadCard,
  memory: loadMemory,
  entries: loadEntries,
  proposals: loadProposals,
  people: loadPeople,
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
  if (!state.token) {
    $('status-line').textContent = '令牌为空'
    return
  }
  $('status-line').textContent = '连接中…'
  openTab(state.tab)
})

$('card-load').addEventListener('click', () => loadCard().catch(() => {}))
$('mem-go').addEventListener('click', () => loadMemory().catch(() => {}))
$('rule-load').addEventListener('click', () => loadRules().catch(() => {}))
$('mem-q').addEventListener('keydown', (e) => e.key === 'Enter' && loadMemory().catch(() => {}))
$('card-channel').addEventListener('keydown', (e) => e.key === 'Enter' && loadCard().catch(() => {}))

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

if (!state.token) showTokenBar(true)
openTab('status')
