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
  return { files, bytes }
}
