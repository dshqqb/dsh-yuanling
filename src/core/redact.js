// src/core/redact.js —— 入库前的脱敏与黑名单判定。
//
// 三档（文档 §5.3）：
//   硬敏感   → 无条件掩码，规则关不掉（密钥进了 raw 就是一次事故）
//   软黑名单 → 入 raw 但标 hidden，派生层跳过，可恢复
//   显式 skip → 完全不入 raw，只留计数
import path from 'node:path'
import { readJson } from './fsx.js'
import { P } from './paths.js'

/** 这些一律掩码：泄露即事故，没有反悔余地。 */
const HARD = [
  [/sk-[A-Za-z0-9_-]{16,}/g, '[已隐藏:密钥]'],
  [/gh[pousr]_[A-Za-z0-9]{20,}/g, '[已隐藏:令牌]'],
  [/AKIA[0-9A-Z]{16}/g, '[已隐藏:AWS]'],
  [/Bearer\s+[A-Za-z0-9._-]{16,}/gi, 'Bearer [已隐藏]'],
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, '[已隐藏:私钥]'],
  [/(api[_-]?key|apikey|access[_-]?token|client[_-]?secret|password|passwd|pwd)\s*[:=]\s*\S{6,}/gi, '$1=[已隐藏]'],
  [/(session_token|context_token|cookie)\s*[:=]\s*\S{6,}/gi, '$1=[已隐藏]'],
]

/** 掩码。返回 {text, hits}。 */
export function redact(text) {
  let out = String(text ?? '')
  let hits = 0
  for (const [re, rep] of HARD) {
    out = out.replace(re, (...args) => {
      hits += 1
      const a = args
      return typeof rep === 'string' ? rep.replace('$1', a[1] ?? '') : rep
    })
  }
  return { text: out, hits }
}

/** 读全局入库规则（根级 rules/ingest.json）。缺失时用空规则。 */
export function loadIngestRules(root) {
  const raw = readJson(path.join(root, P.ingestRules), null)
  if (!raw || typeof raw !== 'object') {
    return { soft_blacklist: [], skip_channels: [] }
  }
  return {
    soft_blacklist: Array.isArray(raw.soft_blacklist) ? raw.soft_blacklist.filter(Boolean) : [],
    skip_channels: Array.isArray(raw.skip_channels) ? raw.skip_channels.filter(Boolean) : [],
  }
}

/**
 * 对一条文本应用入口策略。
 * @returns {{text:string, flags:string[], skip:boolean, hits:number}}
 */
export function applyIngestPolicy(text, { channel = '', channelNative = '', gid = '', rules } = {}) {
  const r = rules ?? { soft_blacklist: [], skip_channels: [] }
  const masked = redact(text)

  // 显式 skip：连内容都不留，只让调用方加计数。
  //
  // 频道在 2026-11-09 之后改成内部编号（`group:qq:123456`），而 skip_channels 是
  // 人手写进 ingest.json 的，写的多半是外部形状（`group:123456`）。所以这里三个都认：
  // 规范频道、适配器原话、群体 gid。只认其中一个，会让"我明明拉黑了它"变成静默失效。
  const candidates = [channel, channelNative, gid].filter(Boolean)
  for (const c of r.skip_channels) {
    if (!c) continue
    if (candidates.some((cur) => cur === c || cur.startsWith(c))) {
      return { text: '', flags: [], skip: true, hits: masked.hits }
    }
  }

  const flags = []
  for (const kw of r.soft_blacklist) {
    if (kw && masked.text.includes(kw)) {
      if (!flags.includes('hidden')) flags.push('hidden')
      break
    }
  }
  if (masked.hits > 0 && !flags.includes('sensitive')) flags.push('sensitive')

  return { text: masked.text, flags, skip: false, hits: masked.hits }
}
