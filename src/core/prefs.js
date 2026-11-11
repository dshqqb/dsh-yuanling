// src/core/prefs.js —— 人格级的小偏好（**切人格就变**的那种设置）。
//
// 和 rules（行为边界）、SELF.md（她是谁）分开：
//   · 这里放的是"这个人格的习惯偏好"，不影响别人格，也不进继承链。
//   · 目前只有一项：`gentleToAdmin` —— 对管理员说话更温柔。
//
// 注意：人格的**名称**不在这里。名称属于人格卡本身（`persona.json` 的 name + SELF.md 标题），
// 一个名字可以是多个称呼、空格分隔；这里不另存一份，免得"两处都写着名字"。
//
// 存 `personas/<人格>/state/prefs.json`，走 writeTracked：可回滚、有版本。
import path from 'node:path'
import { exists, readJson } from './fsx.js'
import { P } from './paths.js'
import { writeTracked } from './version.js'

export const PREFS_DEFAULTS = {
  /** 对管理员说话更温柔（注入里会多一行要求）。 */
  gentleToAdmin: false,
}

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
  }
  return out
}

/**
 * 改偏好。只接受已知字段（防止打错一个键就悄悄多出一项没人读的配置）。
 *
 * @param {object} patch 例如 { gentleToAdmin: true }
 */
export function writePrefs(root, pid, patch = {}, { actor = 'human:editor', reason = '更新人格偏好' } = {}) {
  const known = new Set(Object.keys(PREFS_DEFAULTS))
  const next = { ...readPrefs(root, pid) }
  for (const [k, v] of Object.entries(patch)) {
    if (!known.has(k)) throw new Error(`不认识的偏好项：${k}（可用：${[...known].join(' / ')}）`)
    if (k === 'gentleToAdmin') next[k] = Boolean(v)
  }
  writeTracked(root, prefsRel(pid), JSON.stringify(next, null, 2) + '\n', { actor, reason })
  return next
}
