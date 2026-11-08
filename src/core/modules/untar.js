// src/core/modules/untar.js —— 最小 tar 解包（gzip 或不压缩）。
//
// 为什么自己写：模块安装要解开 .tgz，而"零运行时依赖"是硬约束（不引 tar 包）。
// tar 格式足够简单：每个成员 512 字节头 + 内容（补齐到 512 的整数倍）。
//
// 只支持我们需要的子集：POSIX ustar 的普通文件与目录；跳过符号链接/设备文件
// （模块包里不该有这些，遇到就报错，而不是静默忽略——静默会让"装上了但少文件"很难查）。
import zlib from 'node:zlib'

const BLOCK = 512

/** 读一个以 NUL 结尾的字段。 */
function readString(buf, offset, length) {
  let end = offset
  const limit = offset + length
  while (end < limit && buf[end] !== 0) end += 1
  return buf.subarray(offset, end).toString('utf8')
}

/** octal 数字字段（可能带空格填充）。 */
function readNumber(buf, offset, length) {
  const s = readString(buf, offset, length).trim()
  if (!s) return 0
  // 有的实现用 base-256（高位标记），这里只接受八进制，遇到就当 0 让上层报错
  const n = Number.parseInt(s, 8)
  return Number.isFinite(n) ? n : 0
}

function isZeroBlock(buf, offset) {
  for (let i = 0; i < BLOCK; i += 1) if (buf[offset + i] !== 0) return false
  return true
}

/**
 * 解开 tar。
 * @param {Buffer} input 可能是 gzip（.tgz/.tar.gz），也可能已经是 tar
 * @returns {{entries: Array<{name:string,type:string,size:number,data:Buffer}>}}
 */
export function untar(input) {
  let buf = Buffer.isBuffer(input) ? input : Buffer.from(input)

  // gzip 魔数 1f 8b
  if (buf.length >= 2 && buf[0] === 0x1f && buf[1] === 0x8b) {
    buf = zlib.gunzipSync(buf)
  }

  const entries = []
  let pos = 0
  while (pos + BLOCK <= buf.length) {
    if (isZeroBlock(buf, pos)) break // 归档结束标记

    const name = readString(buf, pos, 100)
    if (!name) break

    // ustar 前缀（长路径）：prefix 在偏移 345，长度 155
    const prefix = readString(buf, pos + 345, 155)
    const fullName = prefix ? `${prefix}/${name}` : name

    const size = readNumber(buf, pos + 124, 12)
    const typeFlag = readString(buf, pos + 156, 1) || '0'

    const dataStart = pos + BLOCK
    const dataEnd = dataStart + size
    const data = buf.subarray(dataStart, Math.min(dataEnd, buf.length))

    // '0'/'\0' 普通文件，'5' 目录，'L' GNU 长文件名（先不支持，报出来）
    if (typeFlag === '0' || typeFlag === '\0' || typeFlag === '') {
      entries.push({ name: normalize(fullName), type: 'file', size, data })
    } else if (typeFlag === '5') {
      entries.push({ name: normalize(fullName), type: 'dir', size: 0, data: Buffer.alloc(0) })
    } else if (typeFlag === 'L' || typeFlag === 'K') {
      throw new Error(`不支持的 tar 扩展头（type ${typeFlag}）：${fullName}`)
    } else {
      throw new Error(`模块包里不允许出现特殊成员（type ${typeFlag}）：${fullName}`)
    }

    pos = dataStart + Math.ceil(size / BLOCK) * BLOCK
  }

  return { entries }
}

/** 去掉 `./` 前缀与尾部斜杠；顺手拒掉绝对路径与 `..`（防目录穿越）。 */
function normalize(name) {
  const s = String(name).replace(/^\.\//, '').replace(/^\/+/, '')
  if (/^[A-Za-z]:/.test(s) || s.includes('..')) {
    throw new Error(`模块包里有非法路径：${name}`)
  }
  return s.replace(/\/+$/, '')
}

/** npm pack 的包通常把内容放在 `package/` 下，这里把这一层剥掉。 */
export function stripPackagePrefix(entries) {
  const all = entries.every((e) => e.name === 'package' || e.name.startsWith('package/'))
  if (!all) return entries
  return entries
    .map((e) => ({ ...e, name: e.name.replace(/^package\/?/, '') }))
    .filter((e) => e.name !== '')
}
