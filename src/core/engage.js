// src/core/engage.js —— 她在某个群里"是否在场"。
//
// 用户定的判据（2026-11-10）：群聊里**只有跟她有关的**内容进记忆；
// 而她一旦被提到或开口，就进入"在场"，**之后跟她有关的**群聊也会算进来。
//
// 窗口规则（用户定，别随手改）：
//   · 4 分钟滑动：被提到 / 她说话 / 在场的人接着说 → 把结束时间推到 now+4min；
//   · 20 分钟封顶：从进入在场那一刻算起，超过就强制退出，下次要有新的触发才重新进入；
//   · **无关消息不推窗口**——宁可把一段对话切成两段，也不要把整群闲聊吸进记忆。
//
// 这是运行时状态，不是她的记忆：存 `system/engage.json`，普通原子写、不进版本历史。
import path from 'node:path'
import fs from 'node:fs'
import { exists, readJson, writeJsonAtomic, localIso } from './fsx.js'
import { P } from './paths.js'

import { readPrefs } from './prefs.js'

export const ENGAGE_WINDOW_MS = 4 * 60 * 1000
export const ENGAGE_MAX_MS = 20 * 60 * 1000

/** 她说不出名字时的兜底叫法（SELF.md 读不到时不至于判定失败）。 */
const FALLBACK_NAMES = ['原灵']

function engagePath(root) {
  return path.join(root, P.system, 'engage.json')
}

/**
 * 她可能被怎么称呼：SELF.md 的名字 + 昵称（用户填的或她自己在记忆里归纳的）+ 兜底词。
 * 昵称也算"叫她"——否则群里喊"灵灵"她不会有反应。
 */
export function herNames(root, pid) {
  const names = new Set(FALLBACK_NAMES)
  try {
    const abs = path.join(root, P.personas, pid, 'persona', 'SELF.md')
    if (exists(abs)) {
      const text = fs.readFileSync(abs, 'utf8')
      const m = /^\s*-\s*名字\s*[:：]\s*(.+)$/m.exec(text)
      const name = m?.[1]?.trim()
      if (name && name.length >= 1 && name.length <= 20 && !/^<.*>$/.test(name)) names.add(name)
    }
  } catch {
    /* 名字读不到不算错 */
  }
  try {
    const prefs = readPrefs(root, pid)
    for (const n of prefs.nicknames ?? []) if (n) names.add(String(n))
  } catch {
    /* 偏好读坏了就当没有昵称 */
  }
  return [...names]
}

/** 这句话里有没有提到她。 */
export function mentionsHer(text, names) {
  const t = String(text ?? '')
  if (!t) return false
  return names.some((n) => n && t.includes(n))
}

export function readEngage(root) {
  const j = readJson(engagePath(root), null)
  return { version: 1, scenes: j?.scenes && typeof j.scenes === 'object' ? j.scenes : {} }
}

function saveEngage(root, state) {
  writeJsonAtomic(engagePath(root), { version: 1, scenes: state.scenes, at: localIso() })
}

/**
 * 一条群消息进来之后调用：要不要把这段对话算成"跟她有关"。
 *
 * @param {object} o
 * @param {string} o.gid
 * @param {string} o.text
 * @param {string} o.actorKey 说话的人：`<平台>:<原生号>`（**不用 person uid**——群里大多数成员没有卡）
 * @param {boolean} o.isBot    是不是她自己在说话
 * @param {number} o.now
 * @param {string[]} o.names   她的名字（herNames 的结果）
 * @returns {{engaged:boolean, reason:string, until:number|null, since:number|null}}
 */
export function noteGroupMessage(root, { gid, text = '', actorKey = '', isBot = false, now = Date.now(), names = FALLBACK_NAMES } = {}) {
  const key = String(gid ?? '')
  if (!key) return { engaged: false, reason: 'no-gid', until: null, since: null }

  const state = readEngage(root)
  const scene = state.scenes[key] ?? null
  const active = scene && now < Number(scene.until ?? 0) && now < Number(scene.since ?? 0) + ENGAGE_MAX_MS

  const mentioned = mentionsHer(text, names)
  let next = null
  let reason = 'not-engaged'

  if (mentioned) {
    // 被提到 / 她说话：进入或延续在场
    next = {
      since: active ? Number(scene.since) : now,
      until: now + ENGAGE_WINDOW_MS,
      participants: active ? [...new Set([...(scene.participants ?? []), actorKey].filter(Boolean))] : [actorKey].filter(Boolean),
      at: localIso(new Date(now)),
    }
    reason = 'mentioned'
  } else if (isBot) {
    // 她开口了：从这里开始算"她在场"（之后别人的话才可能相关）
    next = {
      since: active ? Number(scene.since) : now,
      until: now + ENGAGE_WINDOW_MS,
      participants: active ? scene.participants ?? [] : [],
      at: localIso(new Date(now)),
    }
    reason = 'she-spoke'
  } else if (active && actorKey && (scene.participants ?? []).includes(actorKey)) {
    // 在场的人接着说：延续窗口（但不超过封顶）
    next = {
      since: Number(scene.since),
      until: Math.min(now + ENGAGE_WINDOW_MS, Number(scene.since) + ENGAGE_MAX_MS),
      participants: scene.participants ?? [],
      at: localIso(new Date(now)),
    }
    reason = 'in-conversation'
  } else if (active) {
    // 跟她无关的群聊：**不推窗口**，但也不算"退出"——
    // 只是这条不进记忆。窗口靠时间自己走到头。
    return { engaged: false, reason: 'unrelated', until: Number(scene.until), since: Number(scene.since) }
  } else {
    if (scene) delete state.scenes[key] // 过期就清掉，下次要有新触发
    saveEngage(root, state)
    return { engaged: false, reason: 'expired', until: null, since: null }
  }

  const before = JSON.stringify(state.scenes[key] ?? null)
  state.scenes[key] = next
  // 只在"结束时间推进了 30 秒以上"或参与人变了时写盘：一场热聊不该每条消息都写一次盘
  const changed = before === null ? true : Math.abs(Number(next.until) - Number(scene?.until ?? 0)) >= 30_000
  if (changed) saveEngage(root, state)

  return { engaged: true, reason, until: next.until, since: next.since }
}

/** 清除某个群的在场状态（测试与人工排查用）。 */
export function clearEngage(root, gid = null) {
  const state = readEngage(root)
  if (gid) delete state.scenes[String(gid)]
  else state.scenes = {}
  saveEngage(root, state)
  return state
}
