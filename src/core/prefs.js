// src/core/prefs.js —— 人格级的小偏好（**切人格就变**的那种设置）。
//
// 和 rules（行为边界）、SELF.md（她是谁）分开：
//   · 这里放的是"这个人格的习惯偏好"，不影响别人格，也不进继承链。
//   · 目前只有一项：`gentleToAdmin` —— 对管理员说话更温柔。
//
// 存 `personas/<人格>/state/prefs.json`，走 writeTracked：可回滚、有版本。
import path from 'node:path'
import { exists, readJson } from './fsx.js'
import { P } from './paths.js'
import { writeTracked } from './version.js'

export const PREFS_DEFAULTS = {
  /** 对管理员说话更温柔（注入里会多一行要求）。 */
  gentleToAdmin: false,
  /** 她可以被怎么叫。她自己也会从记忆里归纳着往里加。 */
  nicknames: [],
}

export const NICKNAME_LIMITS = { max: 8, nameLen: 12 }

export function prefsRel(pid) {
  return `${P.personas}/${pid}/state/prefs.json`
}

/** 读偏好：文件不存在就是默认值（不替人建文件）。 */
export function readPrefs(root, pid) {
  const abs = path.join(root, prefsRel(pid))
  const raw = exists(abs) ? readJson(abs, null) : null
  const out = { ...PREFS_DEFAULTS }
  if (raw && typeof raw === 'object') {
    if (typeof raw.gentleToAdmin === 'boolean') out.gentleToAdmin = raw.gentleToAdmin
    if (Array.isArray(raw.nicknames)) out.nicknames = normalizeNicknames(raw.nicknames, { strict: false })
  }
  return out
}

/**
 * 昵称归一：去空、去重、限长限量。数组或空格分隔的字符串都收。
 *
 * 为什么要限量：昵称每一条都会进注入（`[称呼]`），也会参与"群里是不是在叫她"的判定——
 * 往里塞二十个昵称，等于让一段正常对话天天命中她。
 */
export function normalizeNicknames(input, { strict = true } = {}) {
  const list = Array.isArray(input) ? input : String(input ?? '').split(/\s+/)
  const all = []
  for (const raw of list) {
    const v = String(raw ?? '').trim()
    if (!v) continue
    if ([...v].length > NICKNAME_LIMITS.nameLen) {
      if (strict) throw new Error(`昵称「${v}」太长（最多 ${NICKNAME_LIMITS.nameLen} 字）`)
      continue
    }
    if (!all.includes(v)) all.push(v)
  }
  if (strict && all.length > NICKNAME_LIMITS.max) {
    throw new Error(`昵称最多 ${NICKNAME_LIMITS.max} 个（现在是 ${all.length} 个）`)
  }
  return all.slice(0, NICKNAME_LIMITS.max)
}

/**
 * 改偏好。只接受已知字段（防止打错一个键就悄悄多出一项没人读的配置）。
 *
 * @param {object} patch 例如 { gentleToAdmin: true, nicknames: ['小灵'] }
 */
export function writePrefs(root, pid, patch = {}, { actor = 'human:editor', reason = '更新人格偏好' } = {}) {
  const known = new Set(Object.keys(PREFS_DEFAULTS))
  const next = { ...readPrefs(root, pid) }
  for (const [k, v] of Object.entries(patch)) {
    if (!known.has(k)) throw new Error(`不认识的偏好项：${k}（可用：${[...known].join(' / ')}）`)
    if (k === 'gentleToAdmin') next[k] = Boolean(v)
    if (k === 'nicknames') next[k] = normalizeNicknames(v)
  }
  writeTracked(root, prefsRel(pid), JSON.stringify(next, null, 2) + '\n', { actor, reason })
  return next
}
