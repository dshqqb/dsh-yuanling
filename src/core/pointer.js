// src/core/pointer.js —— 证据指针的解析与校验。
//
// 格式（文档 §7.2）：
//   raw/2026-11/05/qq.ndjson#01JCV8K3M2QH7X9
//
// 硬规则：没有合法指针的事实不写。指针指不到真实记录，就等于断言。
import fs from 'node:fs'
import path from 'node:path'
import { exists } from './fsx.js'

const RAW_POINTER_RE = /^raw\/(\d{4}-\d{2})\/(\d{2})\/([^#]+)#([0-9A-HJKMNP-TV-Z]{26})$/
const IMPORT_POINTER_RE = /^import:([a-z0-9-]+)\/(.+)$/

// 解析缓存：同一个文件被反复校验时不要每次都扫全文
const cache = new Map()

function idsOf(root, rel) {
  const key = `${path.resolve(root)}::${rel}`
  const abs = path.join(root, rel)
  let st
  try {
    st = fs.statSync(abs)
  } catch {
    return null
  }
  const stamp = `${st.mtimeMs}:${st.size}`
  const hit = cache.get(key)
  if (hit && hit.stamp === stamp) return hit.ids

  const ids = new Set()
  const buf = fs.readFileSync(abs, 'utf8')
  for (const line of buf.split('\n')) {
    if (!line.trim()) continue
    try {
      const r = JSON.parse(line)
      if (r.id) ids.add(r.id)
    } catch {
      /* 坏行跳过 */
    }
  }
  cache.set(key, { stamp, ids })
  return ids
}

/** 解析指针形状。不是已知格式就返回 null。 */
export function parsePointer(ptr) {
  const s = String(ptr ?? '').trim()
  const m = RAW_POINTER_RE.exec(s)
  if (m) return { kind: 'raw', month: m[1], day: m[2], file: m[3], id: m[4], rel: `raw/${m[1]}/${m[2]}/${m[3]}` }
  const i = IMPORT_POINTER_RE.exec(s)
  if (i) return { kind: 'import', source: i[1], rest: i[2] }
  return null
}

/**
 * 校验指针是否指向真实记录。
 * @returns {{ok:boolean, kind?:string, reason?:string}}
 */
export function resolvePointer(root, ptr) {
  const p = parsePointer(ptr)
  if (!p) return { ok: false, reason: '指针格式不认识' }

  if (p.kind === 'import') {
    // 导入数据的证据指向 system/imports/ 里的真实快照。P11 才实现导入，
    // 这里只要求快照目录存在——不假装能溯源。
    const dir = path.join(root, 'system', 'imports', p.source)
    return exists(dir)
      ? { ok: true, kind: 'import', reason: '导入快照存在（无原始层指针）' }
      : { ok: false, reason: `导入快照不存在：system/imports/${p.source}` }
  }

  if (!exists(path.join(root, p.rel))) return { ok: false, reason: `原始文件不存在：${p.rel}` }
  const ids = idsOf(root, p.rel)
  if (!ids) return { ok: false, reason: `读不到原始文件：${p.rel}` }
  if (!ids.has(p.id)) return { ok: false, reason: `原始文件里找不到这条记录：${p.rel}#${p.id}` }
  return { ok: true, kind: 'raw' }
}

/** 清缓存（测试用）。 */
export function _clearPointerCache() {
  cache.clear()
}
