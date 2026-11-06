// src/core/api.js —— 管理台的只读 API。
// 写操作（屏蔽、回滚）留在 CLI 与后续版本；P8 先把"看得见"做出来。
import { readMarker, listPersonas } from './persona.js'
import { recall, listEntries, openEntry, contextFor, buildCard } from './memory.js'
import { healthReport } from './inbox.js'
import { loadEffectiveRules, recentRefusals } from './rules.js'

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

  return { status: 404, body: { ok: false, error: 'no such api' } }
}
