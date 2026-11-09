// src/core/drives.js —— 最小动机层：她"想要什么"的强度。
//
// 与 surfcore 的 9 维需求相比，这里只留 5 维：陪 / 关心 / 好奇 / 分享 / 自我。
// 其余四个（玩/学/装/创作）本质是**话题**而不是**需求**——它们该躺在记忆主题里，
// 不需要单独一维，否则每次判断都要维护一张关键词表。
//
// 两条会变的东西：
//   · connect（陪）随"多久没和人说话"上涨；
//   · 所有维度按半衰期回落到基线——所以她会黏一阵、静一阵，而不是恒定。
import path from 'node:path'
import { exists, readJson, writeJsonAtomic, localIso } from './fsx.js'
import { P } from './paths.js'

export const DRIVE_NEEDS = ['connect', 'care', 'curiosity', 'share', 'identity']

export const DRIVE_BASE = { connect: 0.30, care: 0.25, curiosity: 0.20, share: 0.20, identity: 0.12 }

/** 半衰期：12 小时（surfcore 用 8 小时；我们的对话密度更低，慢一点更自然）。 */
export const DRIVE_HALF_LIFE_HOURS = 12
export const DRIVE_CAP = 0.95
/** 变化小于这个值就不写盘——避免每分钟生成一个"没变"的版本。 */
const WRITE_EPSILON = 0.01

export function drivesPath(root, pid) {
  return path.join(root, P.personas, pid, 'self', 'drives.json')
}

export function readDrives(root, pid) {
  const j = readJson(drivesPath(root, pid), null)
  const values = { ...DRIVE_BASE }
  for (const need of DRIVE_NEEDS) {
    const n = Number(j?.values?.[need])
    if (Number.isFinite(n)) values[need] = n
  }
  return { version: 1, values, at: j?.at ?? null }
}

function clamp01(n) {
  return Math.max(0, Math.min(DRIVE_CAP, n))
}

/**
 * 刷新需求强度。
 * @param {{now?:number, hoursSinceMaster?:number|null, persist?:boolean}} opts
 *   hoursSinceMaster = 距离上次互动的小时数；persist=false 只算不写（管理台预览用）
 */
export function refreshDrives(root, pid, { now = Date.now(), hoursSinceMaster = null, persist = true } = {}) {
  const cur = readDrives(root, pid)
  const hours = cur.at ? Math.min(72, Math.max(0, (now - Date.parse(cur.at)) / 3_600_000)) : 0
  const decay = Math.pow(0.5, hours / DRIVE_HALF_LIFE_HOURS)

  const next = { ...DRIVE_BASE }
  for (const need of DRIVE_NEEDS) {
    next[need] = DRIVE_BASE[need] + (cur.values[need] - DRIVE_BASE[need]) * decay
  }

  // 想陪：越久没说话越涨（每天最多 +0.4，封顶 0.95）
  if (Number.isFinite(hoursSinceMaster) && hoursSinceMaster >= 0) {
    next.connect = Math.min(DRIVE_CAP, next.connect + Math.min(0.5, (hoursSinceMaster / 24) * 0.4))
  }

  let maxDelta = 0
  for (const need of DRIVE_NEEDS) {
    next[need] = clamp01(next[need])
    maxDelta = Math.max(maxDelta, Math.abs(next[need] - cur.values[need]))
  }

  if (persist && (hours > 0 || maxDelta >= WRITE_EPSILON)) {
    writeJsonAtomic(
      drivesPath(root, pid),
      { version: 1, values: next, at: localIso(new Date(now)) },
    )
  }
  return next
}

/** 单测与调试用：把当前值推高一点（模拟"最近老看到某类东西"）。 */
export function nudgeDrive(values, need, amount) {
  if (!DRIVE_NEEDS.includes(need)) return values
  return { ...values, [need]: clamp01((Number(values[need]) || 0) + amount) }
}

export function _existsDrives(root, pid) {
  return exists(drivesPath(root, pid))
}
