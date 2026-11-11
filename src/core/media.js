// src/core/media.js —— 媒体入库与出库（协议 §13）。
//
// 分工一句话：**模块只碰自己的临时目录，核心负责"存哪、叫什么"**。
//   · 入站：模块把文件写进 system/tmp/<id>/ → media.put.file{path,mime} → 核心校验、算 hash、
//     落到 media/sha256/ab/cd/<hash>.<ext>、追加 index、删掉源临时文件 → 返回指针。
//   · 出站：核心把指针解析成**临时文件**交给模块（帧里不出现内部指针），模块读路径即可。
//
// 三条硬规矩：
//   ① 路径必须在模块自己的临时目录里（不许读别处）；
//   ② 单文件 ≤20MB，mime 必须在白名单里（能力词是"能收媒体"，不是"能收任意文件"）；
//   ③ 指针**永不过期**：找不到热库就去归档库找（归档只是搬家）。
import fs from 'node:fs'
import path from 'node:path'
import { createHash, randomBytes } from 'node:crypto'
import { ensureDir, exists, localIso } from './fsx.js'
import { P } from './paths.js'

export const MEDIA_MAX_BYTES = 20 * 1024 * 1024
/** 一次出站解析出来的临时文件多久过期（模块必须在这之前读完）。 */
export const MEDIA_TMP_TTL_MS = 10 * 60 * 1000
/** media.put.file 的默认频率上限。 */
export const MEDIA_PUT_PER_MINUTE = 20

/** mime → 扩展名白名单。不在表里的一律拒（能力词不能变成"任意文件投递"）。 */
export const MIME_EXT = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'image/gif': 'gif',
  'image/bmp': 'bmp',
  'audio/wav': 'wav',
  'audio/x-wav': 'wav',
  'audio/mpeg': 'mp3',
  'audio/ogg': 'ogg',
  'audio/silk': 'silk',
  'audio/amr': 'amr',
  'video/mp4': 'mp4',
  'video/webm': 'webm',
  'application/pdf': 'pdf',
  'application/zip': 'zip',
  'text/plain': 'txt',
  'application/json': 'json',
}

const EXT_MIME = Object.fromEntries(Object.entries(MIME_EXT).map(([m, e]) => [e, m]))

/** 模块的临时目录（核心侧，**不是**模块自报的路径）。 */
export function mediaTmpDir(root, moduleId) {
  return path.join(root, 'system', 'tmp', String(moduleId))
}

export function mediaArchiveDir(root) {
  return path.join(root, 'media-archive')
}

function shardRel(hash, ext) {
  return `media/sha256/${hash.slice(0, 2)}/${hash.slice(2, 4)}/${hash}.${ext}`
}

function archiveRel(hash, ext) {
  return `media-archive/sha256/${hash.slice(0, 2)}/${hash.slice(2, 4)}/${hash}.${ext}`
}

/** 指针形状：`media:sha256:<hash>.<ext>`。 */
export function mediaPointer(hash, ext) {
  return `media:sha256:${hash}.${ext}`
}

export function parseMediaPointer(ptr) {
  const m = /^media:sha256:([a-f0-9]{64})\.([a-z0-9]{1,8})$/i.exec(String(ptr ?? '').trim())
  return m ? { hash: m[1].toLowerCase(), ext: m[2].toLowerCase() } : null
}

function within(dir, target) {
  const base = path.resolve(dir) + path.sep
  return path.resolve(target).startsWith(base)
}

function appendIndex(root, row) {
  ensureDir(path.join(root, 'media', 'index'))
  fs.appendFileSync(path.join(root, P.mediaIndex), `${JSON.stringify(row)}\n`, 'utf8')
}

/** 读索引里某个指针最后一次登记（用来给出准确的 mime/size）。 */
function lookupIndex(root, ptr, { limit = 5000 } = {}) {
  const abs = path.join(root, P.mediaIndex)
  if (!exists(abs)) return null
  try {
    const lines = fs.readFileSync(abs, 'utf8').split('\n').filter(Boolean).slice(-limit)
    for (let i = lines.length - 1; i >= 0; i -= 1) {
      try {
        const row = JSON.parse(lines[i])
        if (row.ptr === ptr && row.kind !== 'delete') return row
      } catch {
        /* 坏行跳过 */
      }
    }
  } catch {
    /* 索引读不到就用扩展名兜底 */
  }
  return null
}

/**
 * 入站：把模块临时目录里的一个文件收进媒体层。
 *
 * @param {{moduleId:string, path:string, mime:string, now?:number}} opts
 * @returns {{ok:true, ptr:string, hash:string, size:number, mime:string} | {ok:false, code:string, message:string}}
 */
export function putMedia(root, { moduleId, path: srcPath, mime, now = Date.now() } = {}) {
  const type = String(mime ?? '').trim().toLowerCase()
  const ext = MIME_EXT[type]
  if (!ext) {
    return { ok: false, code: 'E_MIME', message: `不收这种类型：${type || '(空)'}（白名单里没有）` }
  }

  const tmp = mediaTmpDir(root, moduleId)
  const abs = path.resolve(String(srcPath ?? ''))
  if (!within(tmp, abs)) {
    return { ok: false, code: 'E_BAD_PATH', message: `文件必须在模块自己的临时目录里：${tmp}` }
  }
  let st
  try {
    st = fs.statSync(abs)
  } catch {
    return { ok: false, code: 'E_NOT_FOUND', message: `临时文件不存在：${abs}` }
  }
  if (!st.isFile()) return { ok: false, code: 'E_BAD_PATH', message: '只能交文件，不能交目录' }
  if (st.size > MEDIA_MAX_BYTES) {
    return { ok: false, code: 'E_TOO_LARGE', message: `单文件上限 ${MEDIA_MAX_BYTES} 字节（收到 ${st.size}）` }
  }

  const buf = fs.readFileSync(abs)
  const hash = createHash('sha256').update(buf).digest('hex')
  const targetPlace = path.join(root, shardRel(hash, ext))
  const archived = path.join(root, archiveRel(hash, ext))

  ensureDir(path.dirname(targetPlace))
  if (!exists(targetPlace)) {
    if (exists(archived)) {
      // 归档里已经有同一份：搬回热库，不复制第二份
      try {
        fs.renameSync(archived, targetPlace)
      } catch {
        fs.copyFileSync(archived, targetPlace)
        try {
          fs.unlinkSync(archived)
        } catch {
          /* 归档删不掉不算错 */
        }
      }
    } else {
      fs.writeFileSync(targetPlace, buf)
    }
  }

  const ptr = mediaPointer(hash, ext)
  appendIndex(root, {
    ts: localIso(new Date(now)),
    kind: 'put',
    ptr,
    hash,
    mime: type,
    size: st.size,
    module: String(moduleId ?? 'unknown'),
  })

  // 收走源文件：删不掉只记日志，不阻断——媒体已经入库，临时文件清理不是正确性问题
  try {
    fs.unlinkSync(abs)
  } catch {
    /* ignore */
  }

  return { ok: true, ptr, hash, size: st.size, mime: type }
}

/**
 * 出站：把指针解析成一个**临时文件**交给模块（帧里不出现内部指针）。
 *
 * @returns {{ok:true, path:string, mime:string, size:number, expires_at:string} | {ok:false, code:string, message:string}}
 */
export function getMedia(root, { moduleId, ptr, now = Date.now() } = {}) {
  const parsed = parseMediaPointer(ptr)
  if (!parsed) return { ok: false, code: 'E_PTR', message: `指针格式不认识：${ptr}` }

  const hot = path.join(root, shardRel(parsed.hash, parsed.ext))
  const cold = path.join(root, archiveRel(parsed.hash, parsed.ext))
  const src = exists(hot) ? hot : exists(cold) ? cold : null
  if (!src) return { ok: false, code: 'E_PTR', message: `两处都找不到这份媒体：${ptr}` }

  const row = lookupIndex(root, mediaPointer(parsed.hash, parsed.ext))
  const mime = row?.mime ?? EXT_MIME[parsed.ext] ?? 'application/octet-stream'
  const size = fs.statSync(src).size

  const tmp = mediaTmpDir(root, moduleId)
  ensureDir(tmp)
  // 清扫过期的临时文件（顺手做，不需要单独定时器）
  cleanupTmp(root, moduleId, { now })
  const name = `${Date.now().toString(36)}-${randomBytes(4).toString('hex')}.${parsed.ext}`
  const dest = path.join(tmp, name)
  fs.copyFileSync(src, dest)

  appendIndex(root, {
    ts: localIso(new Date(now)),
    kind: 'get',
    ptr: mediaPointer(parsed.hash, parsed.ext),
    module: String(moduleId ?? 'unknown'),
  })

  return {
    ok: true,
    path: dest,
    mime,
    size,
    expires_at: localIso(new Date(now + MEDIA_TMP_TTL_MS)),
  }
}

/** 清掉模块临时目录里过期的文件（按 mtime 判断）。 */
export function cleanupTmp(root, moduleId, { now = Date.now(), ttlMs = MEDIA_TMP_TTL_MS } = {}) {
  const tmp = mediaTmpDir(root, moduleId)
  let names = []
  try {
    names = fs.readdirSync(tmp)
  } catch {
    return 0
  }
  let removed = 0
  for (const name of names) {
    const abs = path.join(tmp, name)
    try {
      const st = fs.statSync(abs)
      if (st.isFile() && now - st.mtimeMs > ttlMs) {
        fs.unlinkSync(abs)
        removed += 1
      }
    } catch {
      /* 单个文件失败不影响其它 */
    }
  }
  return removed
}

/**
 * 列出热库里所有媒体文件（按 hash 布局扫）。
 *
 * @returns {Array<{ptr:string, rel:string, abs:string, hash:string, ext:string, size:number, mtimeMs:number}>}
 */
export function listMedia(root) {
  const base = path.join(root, 'media', 'sha256')
  const out = []
  const walk = (dir, relPrefix) => {
    let list = []
    try {
      list = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const it of list) {
      const abs = path.join(dir, it.name)
      const rel = relPrefix ? `${relPrefix}/${it.name}` : it.name
      if (it.isDirectory()) {
        walk(abs, rel)
        continue
      }
      const m = /^([a-f0-9]{64})\.([a-z0-9]{1,8})$/i.exec(it.name)
      if (!m) continue
      let st
      try {
        st = fs.statSync(abs)
      } catch {
        continue
      }
      out.push({
        ptr: mediaPointer(m[1].toLowerCase(), m[2].toLowerCase()),
        rel: `media/sha256/${rel}`,
        abs,
        hash: m[1].toLowerCase(),
        ext: m[2].toLowerCase(),
        size: st.size,
        mtimeMs: st.mtimeMs,
      })
    }
  }
  walk(base, '')
  return out
}

/**
 * 数一数 raw 里有多少条记录引用了这些指针。
 *
 * **只用于清单展示**：归档不按引用做判断——指针永不过期（`get` 会去归档找），
 * 所以"这条还有没有人用"是给人看的，不是拦截条件。
 *
 * @param {Map<string, number>} counts 会被就地累加
 */
export function countMediaRefs(root, counts, { limitFiles = 5000 } = {}) {
  const rawBase = path.join(root, 'raw')
  let scanned = 0
  const walk = (dir) => {
    if (scanned >= limitFiles) return
    let list = []
    try {
      list = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const it of list) {
      if (scanned >= limitFiles) return
      const abs = path.join(dir, it.name)
      if (it.isDirectory()) {
        walk(abs)
        continue
      }
      if (!it.name.endsWith('.ndjson')) continue
      scanned += 1
      let text = ''
      try {
        text = fs.readFileSync(abs, 'utf8')
      } catch {
        continue
      }
      for (const ptr of counts.keys()) {
        if (!text.includes(ptr)) continue
        // 一条记录一行；同一行里出现多次也只算一条
        for (const line of text.split('\n')) {
          if (line.includes(ptr)) counts.set(ptr, counts.get(ptr) + 1)
        }
      }
    }
  }
  walk(rawBase)
  return { scannedFiles: scanned }
}

/** 默认归档年龄：一年。 */
export const ARCHIVE_AFTER_MS = 365 * 86_400_000

/**
 * 归档计划：热库里**超过 `olderThanMs` 没被动过**的文件。
 *
 * 默认只算计划、不动文件——"删不删由人决定"是同一条原则：**先给清单，再动手**。
 *
 * @returns {{files:Array, totalBytes:number, oldest:number|null, hotFiles:number, hotBytes:number}}
 */
export function planArchive(root, { olderThanMs = ARCHIVE_AFTER_MS, now = Date.now(), withRefs = true } = {}) {
  const all = listMedia(root)
  const cutoff = now - olderThanMs
  const files = all
    .filter((f) => f.mtimeMs <= cutoff)
    .sort((a, b) => a.mtimeMs - b.mtimeMs)

  const counts = new Map(files.map((f) => [f.ptr, 0]))
  if (withRefs && files.length) countMediaRefs(root, counts)

  const rows = files.map((f) => ({
    ptr: f.ptr,
    from: f.rel,
    to: `media-archive/sha256/${f.hash.slice(0, 2)}/${f.hash.slice(2, 4)}/${f.hash}.${f.ext}`,
    size: f.size,
    mtime: localIso(new Date(f.mtimeMs)),
    refs: counts.get(f.ptr) ?? 0,
  }))

  const hotBytes = all.reduce((n, f) => n + f.size, 0)
  return {
    files: rows,
    totalBytes: rows.reduce((n, f) => n + f.size, 0),
    oldest: rows.length ? rows[0].mtime : null,
    hotFiles: all.length,
    hotBytes,
  }
}

/**
 * 执行归档：把计划里的文件搬进 `media-archive/`（同 hash 布局），索引记一条 `archive`。
 *
 * 幂等：已经搬过的（热库没有、归档有）会跳过；搬失败只记在返回结果里，不中断其它文件。
 */
export function applyArchive(root, plan, { now = Date.now() } = {}) {
  const moved = []
  const skipped = []
  const failed = []
  for (const row of plan?.files ?? []) {
    const hot = path.join(root, row.from)
    const cold = path.join(root, row.to)
    if (!exists(hot)) {
      skipped.push(row.ptr)
      continue
    }
    try {
      ensureDir(path.dirname(cold))
      fs.renameSync(hot, cold)
      appendIndex(root, { ts: localIso(new Date(now)), kind: 'archive', ptr: row.ptr, size: row.size })
      moved.push(row.ptr)
    } catch (error) {
      failed.push({ ptr: row.ptr, error: String(error?.message ?? error) })
    }
  }
  return { moved, skipped, failed }
}

/** 统计（管理台/诊断用）：热库多少文件、多大。 */
export function mediaStats(root) {
  const base = path.join(root, 'media', 'sha256')
  let files = 0
  let bytes = 0
  const walk = (dir) => {
    let list = []
    try {
      list = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const it of list) {
      const abs = path.join(dir, it.name)
      if (it.isDirectory()) walk(abs)
      else {
        files += 1
        try {
          bytes += fs.statSync(abs).size
        } catch {
          /* ignore */
        }
      }
    }
  }
  walk(base)
  let archivedFiles = 0
  let archivedBytes = 0
  const walkCold = (dir) => {
    let list = []
    try {
      list = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const it of list) {
      const abs = path.join(dir, it.name)
      if (it.isDirectory()) walkCold(abs)
      else {
        archivedFiles += 1
        try {
          archivedBytes += fs.statSync(abs).size
        } catch {
          /* ignore */
        }
      }
    }
  }
  walkCold(path.join(root, 'media-archive', 'sha256'))
  return { files, bytes, archivedFiles, archivedBytes }
}
