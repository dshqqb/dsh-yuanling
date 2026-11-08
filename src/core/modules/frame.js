// src/core/modules/frame.js —— NDJSON 分帧（协议 §4.1 / §4.2）。
//
// 分帧是最容易"看起来对"的一层：表面上 readline 就够了，但真实 IPC 里
// 一次 write 可能塞两条 JSON、一条 JSON 可能分两次 write 到达，
// 而且模块可能往 stdout 打出非协议内容（我们称之为"污染"）。
// 所以这里做成纯函数 + 小状态机，方便把每种切法都测到。
export const MAX_FRAME_BYTES = 256 * 1024

/**
 * 累加器：把任意切分的 chunk 拼成完整的帧行。
 *
 * - 只按 `\n` 切；`\r\n` 当作行尾一并去掉（Windows 模块自己加 \r 很常见）。
 * - 单帧超过 256KB 视为协议错误：不静默截断，交出去让对方按崩溃处理。
 */
export class FrameReader {
  constructor({ maxBytes = MAX_FRAME_BYTES } = {}) {
    this.maxBytes = maxBytes
    this.buf = ''
  }

  /** 喂入一段 chunk，返回这一批里已经完整的行（原始字符串，未 JSON.parse）。 */
  feed(chunk) {
    this.buf += String(chunk ?? '')
    const out = []
    let idx = this.buf.indexOf('\n')
    while (idx >= 0) {
      let line = this.buf.slice(0, idx)
      this.buf = this.buf.slice(idx + 1)
      if (line.endsWith('\r')) line = line.slice(0, -1)
      if (line.trim() !== '') out.push(line)
      idx = this.buf.indexOf('\n')
    }
    if (this.buf.length > this.maxBytes) {
      const err = new Error(`单帧超过 ${this.maxBytes} 字节，按协议错误处理`)
      err.code = 'E_PROTO'
      this.buf = ''
      throw err
    }
    return out
  }

  /** 连接结束时可能还有半行——不完整的一律丢弃。 */
  flush() {
    this.buf = ''
  }
}

/**
 * 解析一帧为信封对象。**非 JSON 就是污染**，直接抛 E_PROTO（协议 §17 第 6 条）。
 */
export function parseFrame(line) {
  let obj
  try {
    obj = JSON.parse(line)
  } catch {
    const err = new Error(`stdout 出现非 JSON 内容（算协议污染）：${String(line).slice(0, 80)}`)
    err.code = 'E_PROTO'
    throw err
  }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
    const err = new Error('帧必须是 JSON 对象')
    err.code = 'E_PROTO'
    throw err
  }
  return obj
}

/** 序列化一帧（总是以 \n 结尾）。 */
export function encodeFrame(obj) {
  return `${JSON.stringify(obj)}\n`
}

/** 判断一帧是响应还是请求：响应必带 id + ok，请求带 op。 */
export function frameKind(obj) {
  if (!obj || typeof obj !== 'object') return 'unknown'
  if (typeof obj.id === 'string' && typeof obj.ok === 'boolean') return 'response'
  if (typeof obj.op === 'string') return 'request'
  return 'unknown'
}
