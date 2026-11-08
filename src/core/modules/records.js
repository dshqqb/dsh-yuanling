// src/core/modules/records.js —— `records` 型 tab：把"我自己产生的记录"摆出来。
//
// 为什么要这个类型：像「点赞记录」这种页，数据**本来就在原始层**（模块点赞时通过 ingest
// 报给核心）。如果让模块再通过 ui.get 把它读出来返回，等于让模块读 raw——
// 那违反协议第一硬边界（模块不能读原始层，只能往里写）。
//
// 所以这里把方向反过来：模块只**声明要什么**（类型/条数），核心自己查自己的账本、自己渲染。
// 好处三条：
//   ① 零数据流过来，不存在越权读 raw；
//   ② 核心强制按 `source = <声明它的模块 id>` 过滤，模块看不见别人的记录；
//   ③ **模块停着也能看**——记录已经在 raw 里，不依赖进程活着。
import fs from 'node:fs'
import path from 'node:path'

import { isDir } from '../fsx.js'
import { P } from '../paths.js'

export const RECORD_LIMITS = { maxRows: 200, scanDays: 30, maxBytes: 32 * 1024 * 1024 }

/** 一次查询的失败：带协议错误码（与 ui.get 其它分支保持一致）。 */
function recordError(code, message) {
  return Object.assign(new Error(message), { code })
}

/** 记录类型：小写、点/下划线/连字符，够表达 `like` / `comment.reply` 这类。 */
export const RECORD_TYPE_RE = /^[a-z][a-z0-9._-]{0,31}$/

/**
 * 查某个模块自己在原始层里的记录。
 *
 * @param {string} root 数据目录
 * @param {{module:string, type:string, limit?:number, days?:number, maxBytes?:number, now?:Date}} q
 * @returns {{items:Array<{title:string,sub:string,ptr:string,ts:string,actor:object}>, total:number, truncated:boolean, partial:boolean}}
 */
export function queryRecords(root, { module, type, limit, days, maxBytes, now = null } = {}) {
  if (!module) throw recordError('E_BAD_REQUEST', '缺少 module（records 查询必须限定模块）')
  const wantType = String(type ?? '').trim()
  if (!RECORD_TYPE_RE.test(wantType)) {
    throw recordError('E_BAD_REQUEST', `records.type 不合法：「${wantType}」（小写字母开头，只含字母数字 . _ -）`)
  }
  const cap = Math.max(1, Math.min(RECORD_LIMITS.maxRows, Number(limit) || 50))
  const scanDays = Math.max(1, Math.min(RECORD_LIMITS.scanDays, Number(days) || RECORD_LIMITS.scanDays))
  const budget = Math.max(1024, Number(maxBytes) || RECORD_LIMITS.maxBytes)
  void now

  const allDays = listRawDays(root).slice(-scanDays)
  let scanned = 0
  let partial = false
  const hits = []

  // 从最新的一天往回读：要的是"最近几条"，没必要从 30 天前开始
  for (let i = allDays.length - 1; i >= 0 && hits.length < cap * 3; i -= 1) {
    const day = allDays[i]
    const dir = path.join(root, P.raw, day.slice(0, 7), day.slice(8, 10))
    if (!isDir(dir)) continue
    for (const name of fs.readdirSync(dir).filter((n) => n.endsWith('.ndjson')).sort()) {
      const p = path.join(dir, name)
      let size = 0
      try {
        size = fs.statSync(p).size
      } catch {
        continue
      }
      if (scanned + size > budget) {
        partial = true
        break
      }
      scanned += size
      let text = ''
      try {
        text = fs.readFileSync(p, 'utf8')
      } catch {
        continue
      }
      for (const line of text.split('\n')) {
        // 预筛：只有同时出现类型名与模块名的行才值得解析
        if (!line.includes(`"${wantType}"`) || !line.includes(module)) continue
        let rec = null
        try {
          rec = JSON.parse(line)
        } catch {
          continue
        }
        // 隔离在核心侧做强制的：只认核心盖过章的那个 source
        if (rec?.source !== module) continue
        if (String(rec.type) !== wantType) continue
        hits.push({ rec, day, file: name })
      }
    }
    if (partial) break
  }

  // 最新在前
  hits.sort((a, b) => String(b.rec.ts ?? '').localeCompare(String(a.rec.ts ?? '')))
  const picked = hits.slice(0, cap)
  const items = picked.map(({ rec, day, file }) => {
    const who = rec.actor?.name || rec.actor?.id || ''
    const ts = String(rec.ts ?? '').replace('T', ' ').slice(0, 16)
    return {
      title: String(rec.text ?? '').replace(/\s+/g, ' ').slice(0, 160) || '（空记录）',
      sub: [ts, who, rec.channel].filter(Boolean).join(' · '),
      // 指针要和 raw 的真实布局一致：raw/<年-月>/<日>/<source>.ndjson#<id>
      ptr: `raw/${day.slice(0, 7)}/${day.slice(8, 10)}/${file}#${rec.id}`,
      ts: String(rec.ts ?? ''),
      actor: rec.actor ?? null,
    }
  })

  return { items, total: hits.length, truncated: hits.length > items.length, partial }
}

/** raw 目录下的日目录（`YYYY-MM-DD`），升序。和 sources.js 里同一套逻辑，但那边是私有的。 */
function listRawDays(root) {
  const base = path.join(root, P.raw)
  if (!isDir(base)) return []
  const out = []
  for (const month of fs.readdirSync(base).sort()) {
    if (!/^\d{4}-\d{2}$/.test(month)) continue
    const mdir = path.join(base, month)
    if (!isDir(mdir)) continue
    for (const dd of fs.readdirSync(mdir).sort()) {
      if (/^\d{2}$/.test(dd) && isDir(path.join(mdir, dd))) out.push(`${month}-${dd}`)
    }
  }
  return out
}
