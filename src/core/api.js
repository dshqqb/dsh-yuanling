// src/core/api.js —— 管理台的只读 API。
// 写操作（屏蔽、回滚）留在 CLI 与后续版本；P8 先把"看得见"做出来。
import { readMarker, listPersonas } from './persona.js'
import { recall, listEntries, openEntry, contextFor, buildCard } from './memory.js'
import { healthReport } from './inbox.js'
import { loadEffectiveRules, recentRefusals } from './rules.js'
import { shield, unshield } from './shield.js'
import { listProposals, approve, reject, rollback, scan as scanProposals } from './proposals.js'
import { loadIdentities, readProfile, writeProfile } from './entities.js'

export function buildStatus(root) {
  const marker = readMarker(root)
  const entries = marker?.active ? listEntries(root, marker.active) : []
  return {
    ok: true,
    root,
    active: marker?.active ?? null,
    format: marker?.format ?? null,
    personas: listPersonas(root).map((p) => ({ id: p.id, name: p.name, active: p.active })),
    entries: entries.length,
    facts: entries.reduce((n, e) => n + (e.facts?.length ?? 0), 0),
  }
}

function need(result) {
  return result ?? null
}

/**
 * @returns {{status:number, body:any}}
 */
export function handleApi(root, url) {
  const { pathname, searchParams } = url
  const pid = readMarker(root)?.active
  if (!pid && pathname !== '/api/status') {
    return { status: 503, body: { ok: false, error: '没有激活人格，先跑 yuanling init' } }
  }

  if (pathname === '/api/status') return { status: 200, body: buildStatus(root) }

  if (pathname === '/api/card') {
    const channel = searchParams.get('channel') || null
    const budget = Number(searchParams.get('budget') ?? 800)
    const text = contextFor(root, pid, { channel, budget })
    return { status: 200, body: { ok: true, channel, text, bytes: Buffer.byteLength(text, 'utf8') } }
  }

  if (pathname === '/api/memory') {
    const query = searchParams.get('q') ?? ''
    const limit = Number(searchParams.get('limit') ?? 10)
    const all = searchParams.get('all') === '1'
    const hits = recall(root, pid, query, {
      limit,
      includeExpired: all,
      includeGone: all,
      includeShielded: all,
      track: false, // 管理台里翻看不该算"被想起"
    })
    return {
      status: 200,
      body: {
        ok: true,
        query,
        hits: hits.map((h) => ({
          topic: h.topic,
          space: h.space,
          text: h.fact.text,
          score: h.score,
          imp: h.fact.imp,
          clarity: h.clarity,
          band: h.band,
          src: h.fact.src,
          until: h.fact.until,
          shielded: Boolean(h.fact.shielded_at),
        })),
      },
    }
  }

  if (pathname === '/api/entries') {
    const list = listEntries(root, pid)
    return {
      status: 200,
      body: {
        ok: true,
        entries: list.map((e) => ({
          topic: e.topic,
          space: e.space,
          summary: e.summary,
          facts: e.facts.length,
          active: e.facts.filter((f) => !f.until).length,
          updated: e.updated,
        })),
      },
    }
  }

  if (pathname === '/api/entry') {
    const topic = searchParams.get('topic')
    const space = searchParams.get('space') ?? '日常'
    if (!topic) return { status: 400, body: { ok: false, error: '缺少 topic' } }
    const e = need(openEntry(root, pid, topic, space))
    if (!e) return { status: 404, body: { ok: false, error: '没有这个条目' } }
    return { status: 200, body: { ok: true, ...e } }
  }

  if (pathname === '/api/rules') {
    const channel = searchParams.get('channel') || null
    const { rules, sources, missing } = loadEffectiveRules(root, pid, { channel })
    return { status: 200, body: { ok: true, channel, rules, sources, missing } }
  }

  if (pathname === '/api/refusals') {
    return { status: 200, body: { ok: true, refusals: recentRefusals(root, { limit: 50 }) } }
  }

  if (pathname === '/api/sources') {
    return { status: 200, body: { ok: true, sources: healthReport(root) } }
  }

  if (pathname === '/api/proposals') {
    return { status: 200, body: { ok: true, proposals: listProposals(root, pid) } }
  }

  if (pathname === '/api/people') {
    const data = loadIdentities(root)
    return {
      status: 200,
      body: {
        ok: true,
        people: Object.values(data.people).map((p) => ({
          uid: p.uid,
          display: p.display,
          aliases: p.aliases ?? [],
          identities: p.identities ?? [],
          hasProfile: Boolean(readProfile(root, pid, p.uid)),
        })),
        pending: data.pending ?? [],
      },
    }
  }

  if (pathname === '/api/person') {
    const uid = searchParams.get('uid')
    if (!uid) return { status: 400, body: { ok: false, error: '缺少 uid' } }
    const data = loadIdentities(root)
    const person = data.people[uid]
    if (!person) return { status: 404, body: { ok: false, error: '没有这个人物' } }
    return { status: 200, body: { ok: true, person, profile: readProfile(root, pid, uid) } }
  }

  return { status: 404, body: { ok: false, error: 'no such api' } }
}

/**
 * 写操作。只有 POST 到这里，且必须带 token。
 * 每一次写都会进版本历史或 changes.ndjson——管理台不是后门。
 *
 * @returns {{status:number, body:any}}
 */
export function handleApiWrite(root, url, body) {
  const pid = readMarker(root)?.active
  if (!pid) return { status: 503, body: { ok: false, error: '没有激活人格' } }
  const b = body && typeof body === 'object' ? body : {}
  const { pathname } = url

  try {
    if (pathname === '/api/shield') {
      const targets = Array.isArray(b.targets) ? b.targets.filter(Boolean) : []
      if (!targets.length) return { status: 400, body: { ok: false, error: '缺少 targets' } }
      const r = shield(root, targets, { reason: String(b.reason ?? '管理台手动屏蔽') })
      return { status: 200, body: { ok: true, redaction: r.redaction?.id ?? null, already: r.already, cascaded: r.cascaded } }
    }

    if (pathname === '/api/unshield') {
      const targets = Array.isArray(b.targets) ? b.targets.filter(Boolean) : []
      if (!targets.length) return { status: 400, body: { ok: false, error: '缺少 targets' } }
      const r = unshield(root, targets, { reason: String(b.reason ?? '管理台撤销') })
      return { status: 200, body: { ok: true, restored: r.restored } }
    }

    if (pathname === '/api/proposal') {
      const id = String(b.id ?? '')
      const action = String(b.action ?? '')
      if (action === 'scan') {
        // 阈值可以用请求覆盖，方便调试与演示；默认仍是 5 次 / 3 天
        const opts = {}
        if (Number(b.minRepeat) > 0) opts.minRepeat = Number(b.minRepeat)
        if (Number.isFinite(Number(b.minDays)) && Number(b.minDays) >= 0) opts.minDays = Number(b.minDays)
        const created = scanProposals(root, pid, opts)
        return { status: 200, body: { ok: true, created } }
      }
      if (!id) return { status: 400, body: { ok: false, error: '缺少 id' } }
      if (action === 'approve') {
        const r = approve(root, pid, id, { by: 'human' })
        return { status: 200, body: { ok: true, changed: r.changed, proposal: r.proposal } }
      }
      if (action === 'reject') {
        return { status: 200, body: { ok: true, proposal: reject(root, pid, id, { reason: String(b.reason ?? '管理台否决') }) } }
      }
      if (action === 'rollback') {
        return { status: 200, body: { ok: true, proposal: rollback(root, pid, id) } }
      }
      return { status: 400, body: { ok: false, error: `未知动作：${action}` } }
    }

    if (pathname === '/api/person') {
      const uid = String(b.uid ?? '')
      if (!uid) return { status: 400, body: { ok: false, error: '缺少 uid' } }
      const patch = { __reason: '管理台编辑人物档案' }
      if (typeof b.sketch === 'string') patch.sketch = b.sketch.slice(0, 2000)
      if (typeof b.display === 'string' && b.display.trim()) patch.display = b.display.trim().slice(0, 60)
      const prof = writeProfile(root, pid, uid, patch)
      return { status: 200, body: { ok: true, profile: prof } }
    }
  } catch (err) {
    return { status: 400, body: { ok: false, error: String(err?.message ?? err) } }
  }

  return { status: 404, body: { ok: false, error: 'no such api' } }
}
