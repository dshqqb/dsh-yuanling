// src/core/scope.js —— "人格范围内的数据放哪"的唯一答案。
//
// 用户定的（2026-11-11，Q33=B）：**除原始层之外，所有人格相关数据都在 `personas/<id>/` 下**，
// 复制粘贴这一个目录就能迁移人格。所以：
//   · 群体 ↔ 平台群号（group-identities.json）同理；
//   · 在场状态（engage.json）也按人格存。
//
// raw 例外：它只追加、跨人格共用，频道里存的是**写入时那个人格的内部编号**。
import path from 'node:path'
import { readJson } from './fsx.js'

/** 这个数据目录当前激活的人格 id（没有就 null）。 */
export function activePid(root) {
  const marker = readJson(path.join(root, 'yuanling.json'), null)
  if (!marker || !Array.isArray(marker.personas)) return null
  const hit = marker.personas.find((p) => p.id === marker.active)
  return hit?.id ?? marker.personas[0]?.id ?? null
}

/** 必须拿到一个人格 id；拿不到就报清楚。 */
export function requirePid(root, pid = null) {
  const p = pid || activePid(root)
  if (!p) throw new Error('没有激活的人格：先建一个人格，或设置 yuanling.json 的 active')
  return p
}

export const personaFile = {
  cards: (pid) => `personas/${pid}/entities/cards.json`,
  groupIdentities: (pid) => `personas/${pid}/entities/group-identities.json`,
  engage: (pid) => `personas/${pid}/state/engage.json`,
}
