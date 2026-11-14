// src/core/scope.js —— "人格范围内的数据放哪"的唯一答案。
//
// 用户定的（2026-11-11，Q33=B）：**除原始层之外，所有人格相关数据都在 `personas/<id>/` 下**，
// 复制粘贴这一个目录就能迁移人格。所以：
//   · 群体 ↔ 平台群号（group-identities.json）同理；
//   · 在场状态（engage.json）也按人格存。
//
// raw 例外：它只追加、跨人格共用，频道里存的是**写入时那个人格的内部编号**。
import fs from 'node:fs'
import path from 'node:path'
import { readJson } from './fsx.js'

// 根标记（yuanling.json）会被**每一条**消息、每一次读群/读人物调到；
// 每次去读它，在这台机器上差不多 1.7ms。按 mtime+size 缓存一下，
// 切换人格时由 writeMarker 主动作废（同毫秒写入也不会读旧值）。
const markerCache = new Map() // 绝对路径 -> { stamp, pid }

export function invalidateActivePid() {
  markerCache.clear()
}

/** 这个数据目录当前激活的人格 id（没有就 null）。 */
export function activePid(root) {
  const file = path.join(root, 'yuanling.json')
  const key = path.resolve(file)
  let stamp = 'missing'
  try {
    const st = fs.statSync(file)
    stamp = `${st.mtimeMs}:${st.size}`
  } catch {
    /* 标记文件还没有 */
  }
  const hit = markerCache.get(key)
  if (hit && hit.stamp === stamp) return hit.pid

  const marker = readJson(file, null)
  let pid = null
  if (marker && Array.isArray(marker.personas)) {
    const cur = marker.personas.find((p) => p.id === marker.active)
    pid = cur?.id ?? marker.personas[0]?.id ?? null
  }
  markerCache.set(key, { stamp, pid })
  return pid
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
