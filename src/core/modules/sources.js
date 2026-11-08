// src/core/modules/sources.js —— v1.1 的「向模块要一次数据」。
//
// 这条链路的形状（协议 §5.2.2）：
//   模型/人 → 核心 → source.fetch(模块) → 标准 inbox 信封 → ingest() → raw → 回给调用方
//
// 三个不能松的地方，都写死在这里：
//   ① 回填**必须**走 ingest()：脱敏、never_record、分片、日链全挂在它上面，
//      另写一条落盘路径等于"这些规则对取回的数据不生效"，而且没人拦得住。
//   ② `h` 由核心算（sha256(模块 + source + ext_id)），**不认模块自报的 h**——
//      模块若能自定指纹，就能让核心"以为见过"而静默丢条。
//   ③ 任何一处不合格都报错，不静默丢：宁可这次没取到，也不要库里少一条还不知道。
import { sha256, exists, readJson } from '../fsx.js'
import path from 'node:path'

import { P } from '../paths.js'
import { readRegistry, grantedOf, moduleDir } from './registry.js'
import { ingest } from '../inbox.js'

/** 单次最多收多少条：够表达"这一屏"，又不会把上下文挤爆。 */
export const FETCH_MAX_ITEMS = 20
/** 回给模型的文本预算（字节）。超了就只给标题行 + 指针。 */
export const FETCH_TEXT_BUDGET = 8192
/** 每个模块每分钟最多被取几次。 */
export const FETCH_RATE = { limit: 10, windowMs: 60_000 }

/** 一次取数的错误：带协议错误码，HTTP 层按码映射状态。 */
export function fetchError(code, message) {
  return Object.assign(new Error(message), { code })
}

/**
 * 装上但没声明 `sources` 的模块不会出现在这里——它们没什么可要的。
 * 只读注册表与 manifest，不需要进程活着（列表本身不该要求"正在运行"）。
 */
export function listSources(root) {
  const reg = readRegistry(root)
  const out = []
  for (const id of Object.keys(reg.modules).sort()) {
    const entry = reg.modules[id]
    const manifest = readJson(path.join(moduleDir(root, id), 'yuanling.module.json'), null)
    const specs = Array.isArray(manifest?.sources) ? manifest.sources : []
    if (!specs.length) continue
    out.push({
      module: id,
      moduleName: manifest?.name ?? id,
      enabled: entry.enabled !== false,
      state: entry.state ?? 'stopped',
      granted: grantedOf(entry).includes('provide.source'),
      sources: specs.map((s) => ({ id: s.id, title: s.title, params: s.params ?? null })),
    })
  }
  return out
}

/**
 * source id → 模块。source 全局带模块前缀，所以这里只需线性找一遍。
 * 找不到就是 `E_NO_ROUTE`——不猜、不模糊匹配。
 */
export function resolveSource(root, sourceId) {
  const id = String(sourceId ?? '').trim()
  if (!id) throw fetchError('E_BAD_REQUEST', '缺少 source')

  const reg = readRegistry(root)
  for (const moduleId of Object.keys(reg.modules).sort()) {
    const manifest = readJson(path.join(moduleDir(root, moduleId), 'yuanling.module.json'), null)
    const spec = (manifest?.sources ?? []).find((s) => s?.id === id)
    if (spec) return { moduleId, spec, manifest, entry: reg.modules[moduleId] }
  }
  throw fetchError('E_NO_ROUTE', `没有模块声明 source「${id}」（先装一个带 sources 的模块）`)
}

/** 核心侧算指纹：模块给的是 ext_id，不是 h。 */
export function fetchedHash(moduleId, sourceId, extId) {
  return sha256(Buffer.from(`${moduleId}\u0000${sourceId}\u0000${extId}`, 'utf8'))
}

/**
 * 校验模块回来的信封，压在 FETCH_MAX_ITEMS 之内。
 * 形状不对就整批拒——一半收一半丢比全丢更难排查。
 */
export function normalizeReply({ moduleId, sourceId, reply, limit }) {
  if (!reply || typeof reply !== 'object') throw fetchError('E_BAD_REQUEST', '模块没有返回信封')
  if (Number(reply.v) !== 1) throw fetchError('E_PROTO', `信封版本不是 1：${reply.v}`)
  const items = Array.isArray(reply.items) ? reply.items : []
  const cap = Math.max(1, Math.min(FETCH_MAX_ITEMS, Number(limit) || FETCH_MAX_ITEMS))
  const truncated = items.length > cap

  const picked = []
  items.slice(0, cap).forEach((raw, i) => {
    if (!raw || typeof raw !== 'object') throw fetchError('E_BAD_REQUEST', `items[${i}] 不是对象`)
    const extId = String(raw.ext_id ?? '').trim()
    if (!extId) {
      // 没有稳定 id 就无法幂等：同一条数据每取一次就多一条，raw 会被复制成垃圾场
      throw fetchError('E_BAD_REQUEST', `items[${i}] 缺少 ext_id（幂等靠它，不能用随机的）`)
    }
    if (extId.length > 200) throw fetchError('E_BAD_REQUEST', `items[${i}].ext_id 太长`)

    const text = String(raw.text ?? '')
    if (!text.trim()) throw fetchError('E_BAD_REQUEST', `items[${i}] 正文为空`)

    picked.push({
      extId,
      ts: typeof raw.ts === 'string' && raw.ts.trim() ? raw.ts : null,
      kind: String(raw.kind ?? 'material'),
      text,
      actor: raw.actor && typeof raw.actor === 'object' ? raw.actor : null,
      media: Array.isArray(raw.media) ? raw.media : [],
      // 模块自报的 h 一律丢弃：见文件头 ②
    })
  })

  return { items: picked, truncated, total: items.length }
}

/**
 * 落 raw 并拿回指针。走 ingest()，所以脱敏/硬线/去重/分片一个都不少。
 * @returns {{records:Array<{id:string, ptr:string, ts:string, actor:object, text:string, deduped:boolean}>, counts:object}}
 */
export function storeFetched(root, { moduleId, sourceId, items, ackedAt }) {
  const env = {
    v: 1,
    source: moduleId, // 协议 §1：source 由核心盖章，模块自报无效
    acct: `module:${moduleId}`,
    items: items.map((it) => ({
      ts: it.ts ?? ackedAt,
      kind: it.kind,
      channel: `module:${sourceId}`,
      role: 'source',
      text: it.text,
      actor: it.actor,
      media: it.media,
      flags: ['fetched'],
      h: fetchedHash(moduleId, sourceId, it.extId),
      ext: { module: moduleId, source: sourceId, ext_id: it.extId },
    })),
  }

  const counts = ingest(root, env, { withRecords: true })
  const records = (counts.records ?? []).map((r) => ({
    id: r.id,
    ptr: `${r.file}#${r.id}`,
    ts: r.ts,
    actor: r.actor,
    text: r.text,
    deduped: Boolean(r.deduped),
  }))
  return { records, counts }
}

/** 来源章：模型看到的每一行都要能追回"谁给的、什么时候、原文在哪"。 */
export function renderFetched({ sourceId, records, truncated, total }) {
  const head = `〔${sourceId}〕命中 ${records.length} 条${total > records.length ? `（共 ${total} 条，只展开前 ${records.length} 条）` : ''}`
  if (!records.length) return `${head}\n（这个来源没有返回任何数据）`

  const lines = [head]
  for (const r of records) {
    const who = r.actor?.name || r.actor?.id || '未知来源'
    const when = String(r.ts ?? '').replace('T', ' ').slice(0, 16)
    lines.push(`- [${when}] ${who}${r.deduped ? '（以前取过，未重复落库）' : ''}`)
    // 正文保留换行：字幕是按分钟切段的，行结构就是时间码，压成一行就没法读了。
    // 连续空行折掉，避免模块回一堆换行把预算吃光。
    const body = String(r.text ?? '')
      .replace(/\r\n?/g, '\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim()
    for (const ln of body.split('\n')) lines.push(`  ${ln}`)
    lines.push(`  证据：${r.ptr}`)
  }
  return lines.join('\n')
}

/** 文本预算：按字节裁，宁可少给几条，也不要一次把上下文塞满。 */
export function clipText(text, budget = FETCH_TEXT_BUDGET) {
  const buf = Buffer.from(text, 'utf8')
  if (buf.length <= budget) return { text, clipped: false }
  return { text: `${buf.subarray(0, budget).toString('utf8')}\n…（超出 ${budget} 字节预算，已截断）`, clipped: true }
}

/** 数据目录里有没有控制台在跑（mcp-server 用它决定能不能问模块）。 */
export function readConsoleRuntime(root) {
  const p = path.join(root, P.consoleRuntime)
  if (!exists(p)) return null
  const v = readJson(p, null)
  if (!v || typeof v.url !== 'string') return null
  return v
}
