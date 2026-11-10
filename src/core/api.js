// src/core/api.js —— 管理台的只读 API。
// 写操作（屏蔽、回滚）留在 CLI 与后续版本；P8 先把"看得见"做出来。
import { readMarker, listPersonas, createPersona, switchPersona } from './persona.js'
import { recall, listEntries, openEntry, contextFor, buildCard, CARD_BUDGET_BYTES, PURPOSE_INJECT_LIMIT } from './memory.js'
import { readCard, saveCardFile, saveCardFiles, renameCard, seedCard } from './personacard.js'
import { readDrives, DRIVE_NEEDS, DRIVE_BASE, DRIVE_CAP } from './drives.js'
import { readPurposes, writePurposes, closePurpose, SELECT_MAX_HITS, SELECT_MAX_OFFERED, SELECT_RECENT_MS } from './purposes.js'
import { healthReport } from './inbox.js'
import { loadEffectiveRules, recentRefusals, rulePaths, ruleFieldSpec, writeGlobalRules, loadGuardrails } from './rules.js'
import { shield, unshield } from './shield.js'
import { listProposals, approve, reject, rollback, scan as scanProposals, mayEvolve } from './proposals.js'
import {
  loadIdentities,
  readProfile,
  writeProfile,
  listPeopleForUi,
  setPinned,
  movePinned,
  createPersonWithCard,
  setAdmin,
  currentAdmin,
  setIdentityText,
} from './entities.js'
import { listDays, readDay, today, listScenes } from './raw.js'
import { resolveChannel } from './channels.js'
import { writePrefs, readPrefs } from './prefs.js'
import { refreshWeights } from './weights.js'
import fs from 'node:fs'
import path from 'node:path'
import { listModules, moduleDetail, moduleSummary, setModuleGranted, setModuleGrantedAll, setModuleEnabled, exportModule, readModuleConfig, writeModuleConfig, readConfigSchema } from './modules/manage.js'
import { validateConfig, describeFields } from './modules/configschema.js'
import { readRegistry } from './modules/registry.js'
import { listSources, fetchStats } from './modules/sources.js'
import {
  listGroups,
  readGroupLive,
  writeGroup,
  setGroupTier,
  moveGroupPinned,
  createGroupWithCard,
  collectMembers,
  ensureGroup,
  refreshGroupWeight,
} from './groups.js'
import { setImpression } from './impressions.js'
import { installFromBytes, fetchModuleBytes, checkUpdate } from './modules/installer.js'
import { uninstall } from './modules/installer.js'
import { readTimeline, readWrites } from './events.js'
import { diagnose } from './diagnostics.js'
import { DIAG_TTL_MS } from './modules/service.js'
import { moduleDir } from './modules/registry.js'
import { revertTo, trackedPaths, normRel } from './version.js'

/**
 * 粗略 token 估算：以中文为主的文本，UTF-8 一个字 3 字节，1 token ≈ 0.7 字。
 * 折算下来 1 token ≈ 4.3 字节。误差 ±30%，**不是账单**，只用来判断量级。
 */
const BYTES_PER_TOKEN = 4.3

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
 * 一个场景在注入时会带进什么。
 *
 * 用来回答"我明明选了人物场景，为什么预览和通用一模一样"：只有解析到人物/群体，
 * 才会有额外那几行。没解析到就必须说清是哪一步没成，而不是让页面静悄悄给同一份文本。
 */
function sceneReport(root, scene) {
  if (!scene) return { sceneInfo: { resolved: false, reason: '没选场景：这是通用预览，不含群体卡与人物卡' } }
  const c = resolveChannel(root, scene)
  if (c.kind === 'private') {
    if (c.personUid) {
      const prof = readProfile(root, readMarker(root)?.active, c.personUid)
      if (!prof?.sketch) {
        return {
          sceneInfo: {
            resolved: true,
            kind: 'private',
            personUid: c.personUid,
            reason: '解析到了人物，但这个人还没有档案（她还没认识他），所以注入里没有人物卡',
          },
        }
      }
      return { sceneInfo: { resolved: true, kind: 'private', personUid: c.personUid, reason: '会带上这个人的画像' } }
    }
    return {
      sceneInfo: {
        resolved: false,
        kind: 'private',
        reason: `场景编号必须是人物编号（person_…），而不是外部账号。${c.id} 是旧格式（把号码直接当编号用），没法归属`,
      },
    }
  }
  if (c.kind === 'group') {
    if (!c.gid) {
      return {
        sceneInfo: {
          resolved: false,
          kind: 'group',
          reason: `场景编号必须是群体编号（grp_…）。${c.id} 是旧格式（把群号直接当编号用），没法归属；跑一次 yuanling group backfill 会把它登记成正式编号`,
        },
      }
    }
    return { sceneInfo: { resolved: true, kind: 'group', gid: c.gid, reason: '会带上这个群体的印象' } }
  }
  return { sceneInfo: { resolved: true, kind: c.kind, reason: '这不是人物/群体场景，注入里不会多出卡' } }
}

/**
 * 读模块自报的诊断项（直接读文件，不依赖运行中的 service 实例——
 * 管理台可能由 `yuanling serve` 单独起，那里没有模块进程）。
 */
function readModuleDiagFromFile(root, id, { now = Date.now(), ttlMs = DIAG_TTL_MS } = {}) {
  const rec = readJsonFile(path.join(moduleDir(root, id), 'diag.json'))
  if (!rec || !Array.isArray(rec.items)) return { items: [], at: null, stale: false }
  const at = Date.parse(String(rec.at ?? ''))
  const stale = !Number.isFinite(at) || now - at > ttlMs
  return { items: stale ? [] : rec.items, at: rec.at ?? null, stale }
}

function readJsonFile(p) {
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'))
  } catch {
    return null
  }
}

/**
 * 这个路径有没有被版本跟踪过。
 *
 * 存在的意义是**限制回滚的作用面**：`/api/rollback` 带 token，若不设防，
 * 它就是一个"可以改任意文件"的口子。只认 trackedPaths 里出现过的路径。
 */
function isTrackedPath(root, rel) {
  try {
    return trackedPaths(root).includes(normRel(rel))
  } catch {
    return false
  }
}

/**
 * 群体的列表行。字段命名和人物行对齐（weight / weightSource / important），
 * 但平台与 id 分开给——群体不跨平台合并，平台本身就是身份的一部分。
 */
function groupRow(g) {
  return {
    gid: g.gid ?? `${g.platform}:${g.id}`,
    platform: g.platform,
    id: g.id,
    name: g.name || '',
    feature: g.feature || '',
    memberCount: Number(g.memberCount ?? 0),
    weight: Number(g.weight ?? 0),
    storedWeight: Number(g.storedWeight ?? g.weight ?? 0),
    weightKind: g.weightKind ?? 'auto',
    rank: g.rank ?? null,
    pinRank: g.pinRank ?? null,
    important: g.tier === 'important',
    firstSeen: g.firstSeen ?? null,
    lastSeen: g.lastSeen ?? null,
  }
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

  // ── 人格（P12）─────────────────────────────────────────────────────────
  // 一台机器上有哪几个人格、当前这张卡长什么样。卡里既有原文也有"注入实测"——
  // 两样都来自同一套函数，页面上不放近似示意。
  if (pathname === '/api/persona') {
    return { status: 200, body: { ok: true, ...readCard(root, pid) } }
  }

  // 动机：五股劲 + 攒着还没说的事。只读——刷新强度会写盘，那件事只该由
  // 注入时（rememberLine）做，页面点一下不该让她的状态动一下。
  if (pathname === '/api/motive') {
    const drv = readDrives(root, pid)
    const doc = readPurposes(root, pid)
    const items = (doc.items ?? []).slice().sort((a, b) => {
      const rank = (p) => (p.status === 'open' ? 0 : 1)
      return rank(a) - rank(b) || String(b.created).localeCompare(String(a.created))
    })
    return {
      status: 200,
      body: {
        ok: true,
        drives: {
          values: drv.values,
          at: drv.at,
          needs: DRIVE_NEEDS,
          base: DRIVE_BASE,
          cap: DRIVE_CAP,
          // 她自己加的动机：名字与关键词是"它什么时候会涨"的唯一线索
          custom: (drv.custom ?? []).map((d) => ({ id: d.id, name: d.name, keywords: d.keywords, base: d.base })),
        },
        items: items.map((p) => ({
          id: p.id,
          need: p.need,
          text: p.text,
          topic: p.topic ?? '',
          origin: p.origin ?? null,
          status: p.status,
          created: p.created,
          due: p.due,
          hits: Number(p.hits ?? 0),
          offered: Number(p.offered ?? 0),
          lastHit: p.last_hit ?? null,
          lastOffered: p.last_offered ?? null,
          closedAt: p.closed_at ?? null,
          closeReason: p.close_reason ?? null,
        })),
        counts: {
          open: items.filter((p) => p.status === 'open').length,
          done: items.filter((p) => p.status === 'done').length,
          dropped: items.filter((p) => p.status === 'dropped').length,
        },
        rules: {
          limit: PURPOSE_INJECT_LIMIT,
          maxHits: SELECT_MAX_HITS,
          maxOffered: SELECT_MAX_OFFERED,
          recentHours: Math.round(SELECT_RECENT_MS / 3_600_000),
        },
      },
    }
  }


  // ── 模块（读）──────────────────────────────────────────────────────────
  if (pathname === '/api/modules') {
    return { status: 200, body: { ok: true, modules: listModules(root), summary: moduleSummary(root) } }
  }

  // 投递方心跳（谁还在往这投消息）——这个路径从 P8 起就是这个语义，
  // v1.1 曾把它改成"模块能提供的数据"，那是错的：来源页按心跳字段读，页面直接坏掉。
  if (pathname === '/api/sources') {
    return { status: 200, body: { ok: true, sources: healthReport(root) } }
  }

  // v1.1：有哪些模块能被"要数据"（模型工具读这个视图）。v1.3 起带使用统计。
  if (pathname === '/api/module-sources') {
    const modulesWithSources = listSources(root)
    const ids = modulesWithSources.flatMap((m) => m.sources.map((s) => s.id))
    const { stats, partial, daysScanned } = fetchStats(root, ids)
    return {
      status: 200,
      body: {
        ok: true,
        // 每个 source 挂上它被取过几次、最近一次什么时候——"她到底用没用上"是这里唯一要回答的问题
        modules: modulesWithSources.map((m) => ({
          ...m,
          sources: m.sources.map((s) => ({
            ...s,
            ...(stats[s.id] ?? { count: 0, lastAt: null, lastAtApprox: false, lastDay: null }),
          })),
        })),
        partial,
        daysScanned,
      },
    }
  }

  if (pathname === '/api/module') {
    const id = searchParams.get('id') ?? ''
    if (!id) return { status: 400, body: { ok: false, error: '缺少 id' } }
    const d = moduleDetail(root, id)
    if (!d) return { status: 404, body: { ok: false, error: `没有这个模块：${id}` } }
    return { status: 200, body: { ok: true, module: d } }
  }

  // ── 日志 / 审计（v1.4）────────────────────────────────────────────────
  // 同一份时间线，lens 决定看哪个镜头：all / write（审计）/ error / module / refusal。
  // 审计行带 ref（版本 hash），页面据此给「回滚」入口。
  if (pathname === '/api/logs') {
    const lens = searchParams.get('lens') || 'all'
    const limit = Number(searchParams.get('limit') ?? 200)
    const module = searchParams.get('module') || null
    const since = searchParams.get('since') || null
    return { status: 200, body: { ok: true, ...readTimeline(root, { lens, limit, module, since }) } }
  }

  // 诊断：{code, stage, level, hint} 清单。只读，什么都不改。
  if (pathname === '/api/diagnostics') {
    const only = searchParams.get('only') !== 'all'
    const fast = searchParams.get('fast') === '1'
    const result = diagnose(root, {
      onlyProblems: only,
      fast,
      moduleDiag: (id) => readModuleDiagFromFile(root, id),
    })
    return { status: 200, body: { ok: true, ...result } }
  }

  // 模块级：日志走 /api/module 里的 log 字段；审计与诊断单独给，页面三个 tab 各取一份。
  if (pathname === '/api/module/audit') {
    const id = searchParams.get('id') ?? ''
    if (!id) return { status: 400, body: { ok: false, error: '缺少 id' } }
    const limit = Number(searchParams.get('limit') ?? 100)
    const writes = readWrites(root, { limit, module: id })
    return { status: 200, body: { ok: true, module: id, writes } }
  }

  if (pathname === '/api/module/diag') {
    const id = searchParams.get('id') ?? ''
    if (!id) return { status: 400, body: { ok: false, error: '缺少 id' } }
    const result = diagnose(root, { onlyProblems: true, fast: true, moduleDiag: (mid) => (mid === id ? readModuleDiagFromFile(root, mid) : { items: [] }) })
    const mine = result.items.filter((x) => x.module === id || x.code.startsWith(`module.`))
    const reported = readModuleDiagFromFile(root, id)
    return {
      status: 200,
      body: {
        ok: true,
        module: id,
        items: result.items.filter((x) => x.module === id),
        reported: { items: reported.items, at: reported.at, stale: reported.stale },
        global: mine.length,
      },
    }
  }

  // 原始层里出现过的频道：注入预览要能挑一个真实存在的，而不是让人手打（打错了看不出）
  // 原始层里出现过的**场景**（人物场景 / 群体场景）。
  // 注入预览要能挑一个真实存在的，而不是让人手打（打错了看不出）。
  // `/api/channels` 是老名字，保留兼容（旧页面/脚本还在用）。
  if (pathname === '/api/scenes' || pathname === '/api/channels') {
    const days = Number(searchParams.get('days') ?? 30)
    const list = listScenes(root, { days: Number.isFinite(days) ? days : 30 })
    return {
      status: 200,
      body: { ok: true, days, scenes: list, channels: list },
    }
  }

  if (pathname === '/api/card') {
    // `scene` 是新名字，`channel` 是老名字——两个都收，老页面不会突然 502
    const scene = searchParams.get('scene') || searchParams.get('channel') || null
    const budgetParam = searchParams.get('budget')
    const budget = budgetParam ? Number(budgetParam) : CARD_BUDGET_BYTES
    // preview：管理台里"看一眼"不该改她的状态（不记 offered、不挖新的、不判过期）
    const text = contextFor(root, pid, { channel: scene, budget, preview: true })
    return {
      status: 200,
      body: {
        ok: true,
        scene,
        channel: scene,
        text,
        budget,
        bytes: Buffer.byteLength(text, 'utf8'),
        // 场景解析结果：选了场景却和通用预览一模一样时，**必须能说清为什么**。
        // 否则人会以为"选了没用"，或者以为功能坏了。
        ...sceneReport(root, scene),
      },
    }
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
          kind: h.fact.kind ?? 'fact',
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
    // own = 当前人格 global.json 里**自己写的那一份**（不含继承），表单要用它回填。
    // 直接把合并后的有效值塞进表单是错的：那样群/私聊覆盖会被并进全局层，等于压平继承。
    const ownPath = rulePaths(root, pid).global
    const own = readJsonFile(path.join(root, ownPath)) ?? {}
    return {
      status: 200,
      body: {
        ok: true,
        channel,
        rules,
        sources,
        missing,
        own,
        ownPath,
        spec: ruleFieldSpec(),
        guardrails: loadGuardrails(root),
      },
    }
  }

  if (pathname === '/api/refusals') {
    return { status: 200, body: { ok: true, refusals: recentRefusals(root, { limit: 50 }) } }
  }

  if (pathname === '/api/sources') {
    return { status: 200, body: { ok: true, sources: healthReport(root) } }
  }

  if (pathname === '/api/usage') {
    const want = Number(searchParams.get('days') ?? 14)
    const span = Math.min(90, Math.max(1, Number.isFinite(want) ? want : 14))

    // 按天统计原始消息量与文本字节：这是本地能精确算出来的部分
    const byDate = new Map()
    for (const d of listDays(root)) {
      let messages = 0
      let bytes = 0
      for (const r of readDay(root, d)) {
        if ((r.type ?? 'message') !== 'message') continue
        messages += 1
        bytes += Buffer.byteLength(String(r.text ?? ''), 'utf8')
      }
      byDate.set(d, { messages, bytes })
    }

    const days = []
    for (let i = span - 1; i >= 0; i -= 1) {
      const d = today(new Date(Date.now() - i * 86_400_000))
      const hit = byDate.get(d) ?? { messages: 0, bytes: 0 }
      days.push({ date: d, messages: hit.messages, bytes: hit.bytes })
    }

    const totals = days.reduce(
      (a, d) => ({ messages: a.messages + d.messages, bytes: a.bytes + d.bytes }),
      { messages: 0, bytes: 0 },
    )

    const cardText = contextFor(root, pid, { preview: true })
    const cardBytes = Buffer.byteLength(cardText, 'utf8')

    return {
      status: 200,
      body: {
        ok: true,
        span,
        days,
        totals: { ...totals, estTokens: Math.round(totals.bytes / BYTES_PER_TOKEN) },
        card: { bytes: cardBytes, estTokens: Math.round(cardBytes / BYTES_PER_TOKEN) },
        est: {
          bytesPerToken: BYTES_PER_TOKEN,
          note: '本地按字节估算，中文为主时误差约 ±30%；模型侧真实用量需宿主提供 usage。',
        },
        cost: { supported: false, note: '未接入：需要宿主给出真实 token 用量与单价，当前不做估算之外的任何推算。' },
      },
    }
  }

  if (pathname === '/api/proposals') {
    return { status: 200, body: { ok: true, proposals: listProposals(root, pid) } }
  }

  // ── 群体（读）──────────────────────────────────────────────────────────
  // 和人物页并列：一群人也是一个实体，但它**不跨平台合并**（QQ群 ≠ 贴吧）。
  if (pathname === '/api/groups') {
    const list = listGroups(root, pid)
    const important = list.filter((g) => g.tier === 'important')
    const rest = list.filter((g) => g.tier !== 'important')
    return {
      status: 200,
      body: {
        ok: true,
        important: important.map(groupRow),
        groups: rest.map(groupRow),
        total: list.length,
      },
    }
  }

  if (pathname === '/api/group') {
    const gid = searchParams.get('gid') ?? ''
    if (!gid) return { status: 400, body: { ok: false, error: '缺少 gid' } }
    const g = readGroupLive(root, pid, gid)
    if (!g) return { status: 404, body: { ok: false, error: '没有这个群体' } }
    const members = g.members.map((uid) => {
      const person = loadIdentities(root).people?.[uid]
      return { uid, display: person?.display ?? uid, identities: person?.identities ?? [] }
    })
    return { status: 200, body: { ok: true, group: g, members } }
  }

  if (pathname === '/api/people') {
    // 顺手按互动重算落盘权重：她聊得多，下次打开这页权重就涨了。
    // 只在值变了的时候写盘（weights.js 自己判断），所以不会刷出一堆版本。
    try {
      refreshWeights(root, pid)
    } catch {
      /* 权重算不出来不该让页面打不开 */
    }
    const data = loadIdentities(root)
    const all = Object.values(data.people ?? {})
    // 影子卡（只见过、没认识过）不进列表，但要让人知道"还有这些人"——
    // 藏起来不等于不存在，否则会出现"我明明在群里见到过他，人物页却没有"。
    const shadow = all.filter((p) => p.tier === 'shadow')
    return {
      status: 200,
      body: {
        ok: true,
        admin: currentAdmin(root),
        people: listPeopleForUi(root, pid),
        pending: data.pending ?? [],
        shadowCount: shadow.length,
        prefs: readPrefs(root, pid),
      },
    }
  }

  if (pathname === '/api/person') {
    const uid = searchParams.get('uid')
    if (!uid) return { status: 400, body: { ok: false, error: '缺少 uid' } }
    const data = loadIdentities(root)
    const person = data.people[uid]
    if (!person) return { status: 404, body: { ok: false, error: '没有这个人物' } }
    // 生效权重/名次和列表同一口径（重点名单按名次，其余按互动分）
    const row = listPeopleForUi(root, pid).find((p) => p.uid === uid) ?? null
    return { status: 200, body: { ok: true, person, profile: readProfile(root, pid, uid), weight: row } }
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
    // ── 人格卡（P12）─────────────────────────────────────────────────────
    // 底稿只有人能写。`actor` 写死 human:editor——将来若有人在这儿接模型，
    // 版本历史里必须一眼能看出来是谁动的。
    if (pathname === '/api/persona/save') {
      // 两种用法：
      //   {files:[{file, sections|text, expect}]} —— 卡上一个「保存」按钮，一次交上来几份
      //   {file, sections|text, expect}          —— 单份（脚本用）
      const r = Array.isArray(b.files)
        ? saveCardFiles(root, pid, b.files, { reason: '管理台编辑人格卡' })
        : {
            files: [
              saveCardFile(root, pid, {
                file: String(b.file ?? ''),
                sections: Array.isArray(b.sections) ? b.sections : undefined,
                text: typeof b.text === 'string' ? b.text : undefined,
                expect: b.expect ? String(b.expect) : undefined,
              }),
            ],
          }
      // 保存完把整张卡回给页面：指纹（expect）随之更新，下一次保存才不会误判"过期"。
      // 形状统一成 {active, personas, card}，和 GET /api/persona 一样。
      return { status: 200, body: { ok: true, ...r, ...readCard(root, pid) } }
    }

    if (pathname === '/api/persona/rename') {
      const r = renameCard(root, pid, b.name, { expect: b.expect ? String(b.expect) : undefined })
      return { status: 200, body: { ok: true, ...r, ...readCard(root, pid) } }
    }

    if (pathname === '/api/persona/create') {
      const id = String(b.id ?? '').trim()
      const name = String(b.name ?? '').trim() || id
      if (!id) return { status: 400, body: { ok: false, error: '需要目录名（小写字母/数字/-/_，例如 xiaoyu）' } }
      // from: 'copy' = 照抄当前人格的底稿（不抄记忆）；不传则用空白模板
      const from = b.from === 'copy' ? pid : null
      const created = createPersona(root, id, name, { from })
      // 卡上填的那几项写进骨架（空白模板里全是 <占位符>，不清掉就永远读不到东西）
      if (b.card && typeof b.card === 'object') {
        try {
          seedCard(root, id, b.card)
        } catch {
          /* 种子写不进去不该让新人格建不出来；建完在卡里补也一样 */
        }
      }
      return { status: 200, body: { ok: true, ...created, from, ...readCard(root, pid) } }
    }

    if (pathname === '/api/persona/switch') {
      const id = String(b.id ?? '').trim()
      if (!id) return { status: 400, body: { ok: false, error: '缺少 id' } }
      const r = switchPersona(root, id)
      return { status: 200, body: { ok: true, ...r, ...readCard(root, readMarker(root)?.active ?? null) } }
    }

    if (pathname === '/api/rules') {
      // 只写当前人格的 global.json（白名单字段见 RULE_FIELDS）。
      // 群 / 私聊的覆盖层故意不做页面编辑：那三层是"越具体越优先"的继承，
      // 在页面上压平写回某一层，等于把继承悄悄改掉。
      const r = writeGlobalRules(root, pid, b.patch ?? {}, { reason: '管理台改规则（人格全局层）' })
      return {
        status: 200,
        body: { ok: true, ...r, ...loadEffectiveRules(root, pid, { channel: b.channel || null }) },
      }
    }

    if (pathname === '/api/purpose/close') {
      const id = String(b.id ?? '')
      if (!id) return { status: 400, body: { ok: false, error: '缺少 id' } }
      const doc = readPurposes(root, pid)
      const r = closePurpose(doc, id, { reason: String(b.reason ?? '人为放下') })
      if (!r.changed) return { status: 404, body: { ok: false, error: '没有这条，或它已经关过了' } }
      writePurposes(root, pid, { ...doc, items: r.items })
      return { status: 200, body: { ok: true, id } }
    }

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
        // 「允许演化」关掉 = 不扫描。手动点也一样，但要**说清为什么**——
        // 点一下什么都没发生，比报错更让人困惑。
        if (!mayEvolve(root, pid)) {
          return {
            status: 200,
            body: {
              ok: true,
              created: [],
              skipped: 'evolve=false',
              message: '这个人的「允许演化」是关的（人格 → 规则 → 提案演化）。要扫描就先把它打开',
            },
          }
        }
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

    // ── 群体（写）──────────────────────────────────────────────────────
    // 只有三类操作：改名字/描述（自然语言）、置顶/取消、重新归集成员。
    // 群体**没有** merge：QQ群和贴吧永远不是同一个实体（用户明确要求）。
    if (pathname === '/api/group') {
      const gid = String(b.gid ?? '')
      if (!gid) return { status: 400, body: { ok: false, error: '缺少 gid' } }
      const patch = { __reason: '管理台编辑群体档案' }
      if (typeof b.name === 'string') patch.name = b.name.slice(0, 60)
      if (Object.keys(patch).length > 1) writeGroup(root, pid, gid, patch, { actor: 'human:editor' })
      // 和人物的素描一样：描述走印象层，受 600 字节上限，进版本历史
      if (typeof b.feature === 'string') {
        setImpression(root, pid, 'group', gid, { text: b.feature, reason: '管理台手动修改', actor: 'human:editor' })
      }
      const g = readGroupLive(root, pid, gid)
      return { status: 200, body: { ok: true, group: g } }
    }

    if (pathname === '/api/group/tier') {
      const gid = String(b.gid ?? '')
      if (!gid) return { status: 400, body: { ok: false, error: '缺少 gid' } }
      const tier = b.important === false ? null : 'important'
      return { status: 200, body: { ok: true, group: readGroupLive(root, pid, setGroupTier(root, pid, gid, tier).gid) } }
    }

    if (pathname === '/api/group/move') {
      const gid = String(b.gid ?? '')
      if (!gid) return { status: 400, body: { ok: false, error: '缺少 gid' } }
      const r = moveGroupPinned(root, pid, gid, b.direction === 'down' ? 'down' : 'up')
      return { status: 200, body: { ok: true, ...r } }
    }

    if (pathname === '/api/group/create') {
      // 平台的"自然语言入口"：不强制前端给 platform/nativeId 两个字段，
      // 一句「QQ群 123456789」就够——加新平台不该改界面。
      const g = createGroupWithCard(root, pid, {
        name: b.name,
        accountText: b.accountText ?? b.account,
        platform: b.platform,
        nativeId: b.nativeId ?? b.id,
        feature: b.feature,
      })
      return { status: 200, body: { ok: true, gid: g.gid, group: g } }
    }

    if (pathname === '/api/group/members') {
      const gid = String(b.gid ?? '')
      if (!gid) return { status: 400, body: { ok: false, error: '缺少 gid' } }
      // 成员是"事实"（谁在这个群说过话），从原始层归集，不让模型编
      const r = collectMembers(root, pid, gid)
      ensureGroup(root, pid, gid, {})
      writeGroup(root, pid, gid, { members: r.members, memberCount: r.memberCount })
      refreshGroupWeight(root, pid, gid)
      return { status: 200, body: { ok: true, group: readGroupLive(root, pid, gid), members: r.members, scannedDays: r.scannedDays } }
    }

    if (pathname === '/api/rollback') {
      // 审计行的回滚入口。参数是「路径 + 目标版本 hash」，跑的是 version.js 的 revertTo——
      // 回滚本身也是一次新版本，不擦掉后来的历史。
      const rel = String(b.path ?? '')
      const hash = String(b.hash ?? '')
      if (!rel || !hash) return { status: 400, body: { ok: false, error: '需要 path 与 hash' } }
      // 只允许回滚被跟踪过的路径：任意路径 + token 就是"能改任何文件"，那不是回滚
      if (!isTrackedPath(root, rel)) return { status: 400, body: { ok: false, error: '这个路径没有版本历史，不能回滚' } }
      const r = revertTo(root, rel, hash, { actor: 'human:editor' })
      return { status: 200, body: { ok: true, changed: r.changed, path: rel, hash: r.hash } }
    }

    if (pathname === '/api/person/identity') {
      const uid = String(b.uid ?? '')
      if (!uid) return { status: 400, body: { ok: false, error: '缺少 uid' } }
      const r = setIdentityText(root, uid, String(b.text ?? ''), { autoLink: b.autoLink !== false })
      return {
        status: 200,
        body: {
          ok: true,
          identityText: r.person.identity_text,
          parsed: r.parsed.items,
          unparsed: r.parsed.unparsed,
          linked: r.linked,
          conflicts: r.conflicts,
        },
      }
    }

    if (pathname === '/api/person/pin') {
      const uid = String(b.uid ?? '')
      if (!uid) return { status: 400, body: { ok: false, error: '缺少 uid' } }
      const pinned = b.pinned === undefined ? true : Boolean(b.pinned)
      const profile = setPinned(root, pid, uid, pinned)
      return { status: 200, body: { ok: true, pinned: profile.pinned, rank: profile.pin_rank ?? null } }
    }

    if (pathname === '/api/person/move') {
      const uid = String(b.uid ?? '')
      if (!uid) return { status: 400, body: { ok: false, error: '缺少 uid' } }
      const r = movePinned(root, pid, uid, b.direction === 'down' ? 'down' : 'up')
      return { status: 200, body: { ok: true, ...r } }
    }

    if (pathname === '/api/person/create') {
      const r = createPersonWithCard(root, pid, {
        display: b.display,
        identityText: b.identityText ?? b.identity,
        sketch: b.sketch,
      })
      return { status: 200, body: { ok: true, uid: r.person.uid, person: r.person, linked: r.linked, conflicts: r.conflicts } }
    }

    // 人格级偏好（切人格就会变的那部分设置）
    if (pathname === '/api/prefs') {
      const next = writePrefs(root, pid, b, { actor: 'human:editor', reason: '管理台修改人格偏好' })
      return { status: 200, body: { ok: true, prefs: next } }
    }

    if (pathname === '/api/person/admin') {
      const uid = b.uid === null || b.uid === undefined || b.uid === '' ? null : String(b.uid)
      const r = setAdmin(root, uid)
      return { status: 200, body: { ok: true, admin: currentAdmin(root), uid: r.adminUid } }
    }

    if (pathname === '/api/person') {
      const uid = String(b.uid ?? '')
      if (!uid) return { status: 400, body: { ok: false, error: '缺少 uid' } }
      const patch = { __reason: '管理台编辑人物档案' }
      if (typeof b.display === 'string' && b.display.trim()) patch.display = b.display.trim().slice(0, 60)
      if (Object.keys(patch).length > 1) writeProfile(root, pid, uid, patch, { actor: 'human:editor' })
      // 素描也走印象那一层：人手写同样受 600 字节上限约束，同样进版本历史。
      // 不然界面上能存 2000 字、注入时被截到 600——那就成了"存下来的和看到的不是一回事"。
      if (typeof b.sketch === 'string') {
        setImpression(root, pid, 'person', uid, { text: b.sketch, reason: '管理台手动修改', actor: 'human:editor' })
      }
      return { status: 200, body: { ok: true, profile: readProfile(root, pid, uid) } }
    }

    // ── 模块管理 ─────────────────────────────────────────────────────────
    // 本地 .tgz：读字节 → 校验 → 落盘。
    // 网址：走 fetchModuleBytes（要联网，所以放在下面的 handleModuleInstallFromUrl 里，由 server await）。
    if (pathname === '/api/modules/install') {
      const file = String(b.file ?? '')
      if (!file) {
        return {
          status: 400,
          body: { ok: false, error: '需要 file（本地 .tgz 路径）或 url（库的网址 / .tgz 直链）' },
        }
      }
      if (!fs.existsSync(file)) return { status: 400, body: { ok: false, error: `找不到文件：${file}` } }
      const bytes = fs.readFileSync(file)
      const r = installFromBytes({
        root,
        bytes,
        repo: b.repo ? String(b.repo) : null,
        source: b.source ? String(b.source) : 'manual',
        ref: b.ref === undefined ? null : String(b.ref),
        expectSha256: b.sha256 ? String(b.sha256) : null,
      })
      // 装完是**空授权**（v1.1）：把声明的能力连同结果一起回给页面，
      // 页面负责"一次通知 + 一个全部授予的按钮"。核心不替人点头。
      return {
        status: 200,
        body: {
          ok: true,
          id: r.manifest.id,
          version: r.manifest.version,
          updated: r.updated,
          sha256: r.sha256,
          capabilities: r.manifest.capabilities ?? [],
          granted: r.entry?.granted ?? [],
        },
      }
    }

    // 保存模块配置：先按模块自己的 schema 校验，再落盘。
    // 落盘之后由 server.js 触发重启（配置只在 init 时下发，不热更新）。
    if (pathname === '/api/modules/config') {
      const id = String(b.id ?? '')
      if (!id) return { status: 400, body: { ok: false, error: '缺少 id' } }
      if (!readRegistry(root).modules[id]) {
        return { status: 404, body: { ok: false, error: `没有这个模块：${id}` } }
      }
      const schema = readConfigSchema(root, id)
      const checked = validateConfig(schema, b.config ?? {})
      if (!checked.ok) {
        return {
          status: 400,
          body: {
            ok: false,
            error: '配置不符合模块声明的 schema',
            errors: checked.errors,
            fields: describeFields(schema),
          },
        }
      }
      writeModuleConfig(root, id, checked.value)
      return {
        status: 200,
        body: {
          ok: true,
          id,
          config: checked.value,
          // 丢掉的未知键要如实说：用户会以为是"保存了但没生效"
          dropped: checked.unknown,
          unsupported: checked.unsupported,
        },
      }
    }

    if (pathname === '/api/modules/grant-all') {
      const id = String(b.id ?? '')
      if (!id) return { status: 400, body: { ok: false, error: '缺少 id' } }
      return { status: 200, body: { ok: true, ...setModuleGrantedAll(root, id, b.granted !== false) } }
    }

    if (pathname === '/api/modules/uninstall') {
      const id = String(b.id ?? '')
      if (!id) return { status: 400, body: { ok: false, error: '缺少 id' } }
      return { status: 200, body: { ok: true, ...uninstall(root, id) } }
    }

    if (pathname === '/api/modules/grant') {
      const id = String(b.id ?? '')
      const capability = String(b.capability ?? '')
      if (!id || !capability) return { status: 400, body: { ok: false, error: '需要 id 与 capability' } }
      return { status: 200, body: { ok: true, ...setModuleGranted(root, id, capability, b.granted !== false) } }
    }

    if (pathname === '/api/modules/enable') {
      const id = String(b.id ?? '')
      if (!id) return { status: 400, body: { ok: false, error: '缺少 id' } }
      return { status: 200, body: { ok: true, ...setModuleEnabled(root, id, b.enabled !== false) } }
    }

    if (pathname === '/api/modules/export') {
      const id = String(b.id ?? '')
      if (!id) return { status: 400, body: { ok: false, error: '缺少 id' } }
      return { status: 200, body: { ok: true, ...exportModule(root, id) } }
    }
  } catch (err) {
    // 409 = 你手里那份过期了（文件在别处被改过）。它不是"参数错"，分开报才说得清。
    const status = err?.code === 'E_STALE' ? 409 : 400
    return { status, body: { ok: false, code: err?.code ?? null, error: String(err?.message ?? err) } }
  }

  return { status: 404, body: { ok: false, error: 'no such api' } }
}

/**
 * 检查某个模块有没有新版本（联网，只查元数据不下载）。
 *
 * 没有 repo 的模块（本地 tgz 装的、或手改过注册表的）直接告诉用户"没法查"——
 * 装作"已是最新"比说实话更糟。
 */
export async function handleModuleCheckUpdate(root, body, opts = {}) {
  const b = body && typeof body === 'object' ? body : {}
  const id = String(b.id ?? '').trim()
  if (!id) return { status: 400, body: { ok: false, error: '缺少 id' } }

  const entry = readRegistry(root).modules[id]
  if (!entry) return { status: 404, body: { ok: false, error: `没有这个模块：${id}` } }
  if (!entry.repo) {
    return {
      status: 400,
      body: { ok: false, error: '这个模块不是从库安装的（没有记录来源地址），没法检查更新' },
    }
  }

  try {
    const r = await checkUpdate(entry.repo, entry.version, opts)
    return { status: 200, body: { ok: true, id, ...r } }
  } catch (error) {
    const code = error?.code ?? ''
    const status = code === 'E_NO_REPO' ? 404 : 400
    return { status, body: { ok: false, error: String(error?.message ?? error) } }
  }
}

/**
 * 模块自定义 tab 的数据（协议 v1.2 的 `/api/modules/ui`）。
 *
 * 为什么是 async 独立函数：要跟**活着的模块进程**要数据，而进程只存在于插件宿主里，
 * `handleApiWrite` 是无状态的、拿不到它。和 install-url 一样由 server.js await 这一条。
 */
export async function handleModuleUi(root, body, { onUiGet } = {}) {
  const b = body && typeof body === 'object' ? body : {}
  const id = String(b.id ?? '').trim()
  const tab = String(b.tab ?? '').trim()
  if (!id) return { status: 400, body: { ok: false, error: '缺少 id' } }
  if (!tab) return { status: 400, body: { ok: false, error: '缺少 tab' } }
  if (!onUiGet) {
    return {
      status: 503,
      body: { ok: false, error: '这个进程没有模块宿主（CLI 起的控制台取不到模块界面数据）' },
    }
  }
  try {
    const r = await onUiGet(id, tab)
    return { status: 200, body: { ok: true, ...r } }
  } catch (error) {
    const code = error?.code ?? ''
    const status = code === 'E_NO_ROUTE' ? 404 : code === 'E_BAD_REQUEST' ? 400 : 400
    return { status, body: { ok: false, code, error: String(error?.message ?? error) } }
  }
}

/**
 * 从**网址**装模块（管理台那条）。
 *
 * 为什么单独一个 async 函数而不是塞进 handleApiWrite：handleApiWrite 是同步的
 * （页面里绝大多数写操作只是同步读写注册表）。这条要联网、要等两个平台回话，
 * 混进去会让所有同步调用方都被迫处理 Promise。server.js 单独 await 这一条。
 *
 * 接受两种网址：
 *   · 库的网址（Gitee / GitHub）→ 去它的发行版里找 .tgz 资产
 *   · .tgz 直链 → 直接用
 */
export async function handleModuleInstallFromUrl(root, body, opts = {}) {
  const b = body && typeof body === 'object' ? body : {}
  const url = String(b.url ?? '').trim()
  if (!url) return { status: 400, body: { ok: false, error: '需要 url（库的网址或 .tgz 直链）' } }

  const pid = readMarker(root)?.active
  if (!pid) return { status: 503, body: { ok: false, error: '没有激活人格' } }

  let bytes = null
  let resolved = null
  try {
    ;({ bytes, resolved } = await fetchModuleBytes(url, opts))
  } catch (error) {
    const code = error?.code ?? ''
    const status = code === 'E_NO_REPO' ? 404 : code === 'E_RATE' ? 429 : 400
    return { status, body: { ok: false, error: String(error?.message ?? error) } }
  }

  try {
    const r = installFromBytes({
      root,
      bytes,
      repo: resolved?.repo ?? url,
      source: resolved?.source ?? 'url',
      ref: resolved?.ref ?? null,
      expectSha256: b.sha256 ? String(b.sha256) : null,
    })
    return {
      status: 200,
      body: {
        ok: true,
        id: r.manifest.id,
        version: r.manifest.version,
        updated: r.updated,
        sha256: r.sha256,
        // 让页面能显示"这个包是从哪儿来的"，排查时省一轮
        resolvedFrom: resolved?.tgzUrl ?? url,
        repo: resolved?.repo ?? null,
        ref: resolved?.ref ?? null,
        assetName: resolved?.assetName ?? null,
        capabilities: r.manifest.capabilities ?? [],
        granted: r.entry?.granted ?? [],
      },
    }
  } catch (error) {
    return { status: 400, body: { ok: false, error: String(error?.message ?? error) } }
  }
}
