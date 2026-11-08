// src/core/api.js —— 管理台的只读 API。
// 写操作（屏蔽、回滚）留在 CLI 与后续版本；P8 先把"看得见"做出来。
import { readMarker, listPersonas } from './persona.js'
import { recall, listEntries, openEntry, contextFor, buildCard, CARD_BUDGET_BYTES } from './memory.js'
import { healthReport } from './inbox.js'
import { loadEffectiveRules, recentRefusals } from './rules.js'
import { shield, unshield } from './shield.js'
import { listProposals, approve, reject, rollback, scan as scanProposals } from './proposals.js'
import { loadIdentities, readProfile, writeProfile, listPeopleForUi, setPinned, setAdmin, currentAdmin, setIdentityText } from './entities.js'
import { listDays, readDay, today } from './raw.js'
import { setManualWeight, clearManualWeight } from './weights.js'
import fs from 'node:fs'
import { listModules, moduleDetail, moduleSummary, setModuleGranted, setModuleGrantedAll, setModuleEnabled, exportModule, readModuleConfig, writeModuleConfig, readConfigSchema } from './modules/manage.js'
import { validateConfig, describeFields } from './modules/configschema.js'
import { readRegistry } from './modules/registry.js'
import { listSources } from './modules/sources.js'
import { installFromBytes, fetchModuleBytes } from './modules/installer.js'
import { uninstall } from './modules/installer.js'

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
 * @returns {{status:number, body:any}}
 */
export function handleApi(root, url) {
  const { pathname, searchParams } = url
  const pid = readMarker(root)?.active
  if (!pid && pathname !== '/api/status') {
    return { status: 503, body: { ok: false, error: '没有激活人格，先跑 yuanling init' } }
  }

  if (pathname === '/api/status') return { status: 200, body: buildStatus(root) }

  // ── 模块（读）──────────────────────────────────────────────────────────
  if (pathname === '/api/modules') {
    return { status: 200, body: { ok: true, modules: listModules(root), summary: moduleSummary(root) } }
  }

  // v1.1：有哪些模块能被"要数据"（模型工具也读这一个视图）
  if (pathname === '/api/sources') {
    return { status: 200, body: { ok: true, sources: listSources(root) } }
  }

  if (pathname === '/api/module') {
    const id = searchParams.get('id') ?? ''
    if (!id) return { status: 400, body: { ok: false, error: '缺少 id' } }
    const d = moduleDetail(root, id)
    if (!d) return { status: 404, body: { ok: false, error: `没有这个模块：${id}` } }
    return { status: 200, body: { ok: true, module: d } }
  }

  if (pathname === '/api/card') {
    const channel = searchParams.get('channel') || null
    const budgetParam = searchParams.get('budget')
    const budget = budgetParam ? Number(budgetParam) : CARD_BUDGET_BYTES
    const text = contextFor(root, pid, { channel, budget })
    return { status: 200, body: { ok: true, channel, text, budget, bytes: Buffer.byteLength(text, 'utf8') } }
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

    const cardText = contextFor(root, pid, {})
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

  if (pathname === '/api/people') {
    const sort = searchParams.get('sort') === 'time' ? 'time' : 'weight'
    const data = loadIdentities(root)
    return {
      status: 200,
      body: {
        ok: true,
        sort,
        admin: currentAdmin(root),
        people: listPeopleForUi(root, pid, { sort }),
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
      return { status: 200, body: { ok: true, pinned: profile.pinned } }
    }

    if (pathname === '/api/person/admin') {
      const uid = b.uid === null || b.uid === undefined || b.uid === '' ? null : String(b.uid)
      const r = setAdmin(root, uid)
      return { status: 200, body: { ok: true, admin: currentAdmin(root), uid: r.adminUid } }
    }

    if (pathname === '/api/person/weight') {
      const uid = String(b.uid ?? '')
      if (!uid) return { status: 400, body: { ok: false, error: '缺少 uid' } }
      if (b.weight === null || b.weight === undefined) {
        const profile = clearManualWeight(root, pid, uid)
        return { status: 200, body: { ok: true, weight: profile.weight, source: profile.weight_source } }
      }
      const profile = setManualWeight(root, pid, uid, Number(b.weight))
      return { status: 200, body: { ok: true, weight: profile.weight, source: profile.weight_source } }
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
    return { status: 400, body: { ok: false, error: String(err?.message ?? err) } }
  }

  return { status: 404, body: { ok: false, error: 'no such api' } }
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
