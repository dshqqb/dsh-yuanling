// src/core/modules/registry.js —— system/modules.json（协议 §16）。
//
// 分工要记牢：
//   · 这里的 **repo / installedRef / previousRepo / installed_at / last_crash / enabled**
//     是唯一权威——它们不在 manifest 里，重扫目录恢复不出来；
//   · 其余字段（id/version/api/routes/capabilities）以 manifest 为准，这里只是快照；
//   · state 是运行时快照，核心重启后重置，不是持久事实。
import path from 'node:path'

import { readJson, writeJsonAtomic, localIso } from '../fsx.js'
import { P } from '../paths.js'

export const REGISTRY_VERSION = 1

/** §3.3：capabilities 的封闭词表（与 manifest.js 同源，这里只做白名单过滤）。 */
export const GRANTABLE = [
  'ingest.message',
  'propose.fact',
  'media.put.file',
  'media.read',
  'send',
  'actuate',
  'provide.source',
  // v1.5：取 / 回执主动开口的待发队列
  'outbox',
]

export function registryPath(root) {
  return path.join(root, P.modulesRegistry)
}

/** 模块目录（每个 id 一个）。 */
export function moduleDir(root, id) {
  return path.join(root, P.modules, id)
}

export function emptyRegistry() {
  return { version: REGISTRY_VERSION, modules: {} }
}

/** 读注册表；坏了就给空表，不抛（坏了不该让整个插件起不来）。 */
export function readRegistry(root) {
  const raw = readJson(registryPath(root), null)
  if (!raw || typeof raw !== 'object' || typeof raw.modules !== 'object' || raw.modules === null) {
    return emptyRegistry()
  }
  const modules = {}
  for (const [id, m] of Object.entries(raw.modules)) {
    if (!m || typeof m !== 'object') continue
    modules[id] = { ...m, id }
  }
  return { version: Number(raw.version) || REGISTRY_VERSION, modules }
}

export function writeRegistry(root, reg) {
  writeJsonAtomic(registryPath(root), { version: REGISTRY_VERSION, modules: reg.modules })
  return reg
}

/** 只要授予了的能力（未授予的一律不认，哪怕 manifest 声明了）。 */
export function grantedOf(entry) {
  const granted = Array.isArray(entry?.granted) ? entry.granted : entry?.capabilities ?? []
  return granted.filter((c) => GRANTABLE.includes(c))
}

/** 把 manifest 与安装信息合成一条注册表记录。 */
export function makeEntry({ manifest, source, repo, ref = null, retrievedAt = null, granted = null }) {
  const capabilities = manifest.capabilities ?? []
  return {
    id: manifest.id,
    version: manifest.version,
    api: manifest.api,
    app: manifest.app ?? null,
    kind: manifest.kind,
    routes: (manifest.routes ?? []).map((r) => r.path),
    sources: (manifest.sources ?? []).map((s) => s.id),
    capabilities,
    // 声明 ≠ 授予（v1.1 改定）：装完是空授权，由人在安装时一次性确认全部。
    // 之前这里是 `granted ?? capabilities`——那等于"装上就能往外说话"，文档写着要人点，代码闭着眼给。
    granted: granted ?? [],
    permissions: manifest.permissions ?? [],
    source: source ?? null,
    repo: repo ?? null,
    installedRef: ref,
    previousRepo: null,
    installed_at: localIso(),
    retrieved_at: retrievedAt,
    enabled: true,
    state: 'stopped',
    last_crash: null,
  }
}

/**
 * 装/更新时改写授权：**之前授予过的能力保留**（更新不该偷偷降权或扩权），
 * 新增的能力按 defaultGranted 决定。
 */
export function mergeGranted(previous, capabilities, { defaultGranted = true } = {}) {
  const prev = Array.isArray(previous) ? previous : []
  return capabilities.filter((c) => prev.includes(c) || defaultGranted)
}

/** 单独授予/收回某条能力。返回新记录；能力不合法时抛。 */
export function setGranted(entry, capability, granted) {
  if (!GRANTABLE.includes(capability)) throw new Error(`未知能力：${capability}`)
  if (!(entry.capabilities ?? []).includes(capability)) {
    throw new Error(`模块没有声明「${capability}」，不能授予`)
  }
  const cur = new Set(grantedOf(entry))
  if (granted) cur.add(capability)
  else cur.delete(capability)
  return { ...entry, granted: GRANTABLE.filter((c) => cur.has(c)) }
}

/** 一次性授予全部声明的能力，或全收回。安装确认用：一次通知、一个决定，不做逐条勾选。 */
export function setGrantedAll(entry, granted) {
  return {
    ...entry,
    granted: granted ? GRANTABLE.filter((c) => (entry.capabilities ?? []).includes(c)) : [],
  }
}

/** 运行时状态（advisory，重启后重置）。 */
export function setState(root, id, state, extra = {}) {
  const reg = readRegistry(root)
  const entry = reg.modules[id]
  if (!entry) return null
  reg.modules[id] = { ...entry, state, ...extra }
  writeRegistry(root, reg)
  return reg.modules[id]
}

export function recordCrash(root, id, reason) {
  const reg = readRegistry(root)
  const entry = reg.modules[id]
  if (!entry) return null
  reg.modules[id] = {
    ...entry,
    state: 'crashed',
    last_crash: { at: localIso(), reason: String(reason ?? '').slice(0, 200) },
  }
  writeRegistry(root, reg)
  return reg.modules[id]
}

/** 已装模块的 id 列表（稳定排序，页面才好显示）。 */
export function listIds(reg) {
  return Object.keys(reg.modules).sort()
}

/** 检查 routes 是否与已安装模块重叠（协议 §3.3 第 8 条）。 */
export function conflictingRoutes(reg, routes, { ignoreId = null } = {}) {
  const wanted = (routes ?? []).map((r) => (typeof r === 'string' ? r : r.path))
  const clashes = []
  for (const [id, m] of Object.entries(reg.modules)) {
    if (id === ignoreId) continue
    for (const existing of m.routes ?? []) {
      if (wanted.includes(existing)) clashes.push({ id, route: existing })
    }
  }
  return clashes
}
