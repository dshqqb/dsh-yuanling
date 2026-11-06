// src/core/fsx.js —— 文件系统小工具。零依赖，只用 node: 内置模块。
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'

/** 路径是否存在（不抛异常）。 */
export function exists(p) {
  try {
    fs.statSync(p)
    return true
  } catch {
    return false
  }
}

/** 是否为目录。 */
export function isDir(p) {
  try {
    return fs.statSync(p).isDirectory()
  } catch {
    return false
  }
}

/** 递归建目录。 */
export function ensureDir(p) {
  fs.mkdirSync(p, { recursive: true })
}

/** 读 JSON，失败返回 fallback（不抛）。 */
export function readJson(p, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'))
  } catch {
    return fallback
  }
}

/**
 * 原子写：同目录写临时文件 → rename 覆盖。
 * rename 在同一卷上是原子的，所以读到的要么是旧内容、要么是新内容，不会有半截。
 */
export function writeFileAtomic(p, content, { mode } = {}) {
  const dir = path.dirname(p)
  fs.mkdirSync(dir, { recursive: true })
  const tmp = path.join(dir, `.tmp-${process.pid}-${crypto.randomBytes(4).toString('hex')}`)
  const opts = { encoding: 'utf8' }
  if (typeof mode === 'number') opts.mode = mode
  fs.writeFileSync(tmp, content, opts)
  try {
    fs.renameSync(tmp, p)
  } catch (err) {
    // 目标被占用（Windows 常见）时清理临时文件再抛
    try {
      fs.unlinkSync(tmp)
    } catch {
      /* 忽略清理失败 */
    }
    throw err
  }
}

/** 原子写 JSON（带缩进与尾换行，便于人读与 diff）。 */
export function writeJsonAtomic(p, value, opts) {
  writeFileAtomic(p, JSON.stringify(value, null, 2) + '\n', opts)
}

/** 追加一行（NDJSON 用）。caller 保证单写者。 */
export function appendLine(p, obj) {
  fs.mkdirSync(path.dirname(p), { recursive: true })
  fs.appendFileSync(p, JSON.stringify(obj) + '\n', 'utf8')
}

/** sha256 摘要（带前缀，便于在日志里一眼看出算法）。 */
export function sha256(buf) {
  return 'sha256:' + crypto.createHash('sha256').update(buf).digest('hex')
}

/** 文件内容摘要。 */
export function fileSha256(p) {
  return sha256(fs.readFileSync(p))
}

/** 字符串内容摘要。 */
export function textSha256(s) {
  return sha256(Buffer.from(String(s), 'utf8'))
}

// ── ULID ────────────────────────────────────────────────────────────────
// 26 字符：10 位时间 + 16 位随机，Crockford base32。
// 选它而不是 seq：分片、重排、导入回填都不会改变已写下的 id。
const ENC = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'

function encodeTime(ms, len) {
  let n = Math.max(0, Math.floor(ms))
  let out = ''
  for (let i = 0; i < len; i += 1) {
    out = ENC[n % 32] + out
    n = Math.floor(n / 32)
  }
  return out
}

function encodeRandom(len) {
  const bytes = crypto.randomBytes(len)
  let out = ''
  for (let i = 0; i < len; i += 1) out += ENC[bytes[i] % 32]
  return out
}

/** 生成 ULID。同一毫秒内可能不严格单调，但全局唯一足够。 */
export function ulid(now = Date.now()) {
  return encodeTime(now, 10) + encodeRandom(16)
}

/** 校验 ULID 形态（26 位 Crockford 字符）。 */
export function isUlid(s) {
  return typeof s === 'string' && /^[0-9A-HJKMNP-TV-Z]{26}$/.test(s)
}

/** 本地时区的 ISO 8601（带偏移），用于所有对外时间戳。 */
export function localIso(d = new Date()) {
  const p2 = (n) => String(n).padStart(2, '0')
  const off = -d.getTimezoneOffset()
  const sign = off >= 0 ? '+' : '-'
  const oh = p2(Math.floor(Math.abs(off) / 60))
  const om = p2(Math.abs(off) % 60)
  return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}T${p2(d.getHours())}:${p2(d.getMinutes())}:${p2(d.getSeconds())}${sign}${oh}:${om}`
}
