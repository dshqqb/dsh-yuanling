// src/core/proactive.js —— 主动开口的**决策层**（不发送）。
//
// 用户定的（2026-11-10）：
//   · 内容 = 到期目的 + 模板拼句，产出可直接发送的文本；
//   · **发在原话来的地方**：那句话是群里说的，就发回那个群并 @ 说话的人；
//     是私聊说的，就发回那个人的私聊——而不是统一甩给管理员。
//
// 这一层只做三件事：算"该不该说"、拼"要说什么"、把结果放进**待发队列**（outbox）。
// 真发送留给模块（QQ 模块来取队列）。所以现在它不会替你说话，只会记账。
//
// 纪律：
//   · `rules.action.*` 的闸门真的生效（proactive / quiet_hours / 每小时每天上限 / per_target /
//     group_proactive）；被闸门拦下的进 `held` 而不是丢掉——过了时段还能放出来；
//   · 一条目的只进队列一次；
//   · 每条都要能回答"为什么说这句"：队列项带 `why`（目的 id）与 `origin`（原话指针）。
import path from 'node:path'
import fs from 'node:fs'
import { exists, readJson, localIso, ulid } from './fsx.js'
import { P } from './paths.js'
import { writeTracked } from './version.js'
import { readPurposes } from './purposes.js'
import { readDrives, driveName } from './drives.js'
import { loadEffectiveRules } from './rules.js'
import { parsePointer } from './pointer.js'
import { readMarker } from './persona.js'
import { appendEvent } from './events.js'
import { canReply } from './audience.js'

/** 主动开口的门槛：动机强度低于这个数就不打扰人。 */
export const PROACTIVE_MIN_DRIVE = 0.55
/** 一轮最多产出几条（再多就是刷屏）。 */
export const PROACTIVE_MAX_PER_RUN = 1
/** 默认多久看一次。 */
export const PROACTIVE_EVERY_MINUTES = 15

/**
 * 拼句模板。按动机选一句，`{fact}` 是对方原话。
 *
 * 为什么不写得更花：主动开口最怕"像客服"。这几句都只是**把对方说过的事接回去**，
 * 不评价、不推销、不假装关心——真正的语气由她的表达层（style.md）决定。
 */
export const PROACTIVE_TEMPLATES = {
  care: '你上次说「{fact}」，后来怎么样了？',
  curiosity: '还在想你说的「{fact}」——后来弄明白了吗？',
  share: '刚想起你提过的「{fact}」。',
  connect: '这几天没怎么聊。你之前说的「{fact}」，后来呢？',
  identity: '又想到你说的「{fact}」。',
  _default: '想起你提过「{fact}」。',
}

function outboxPath(root, pid) {
  return path.join(root, P.personas, pid, 'self', 'outbox.json')
}

export function readOutbox(root, pid) {
  const j = readJson(outboxPath(root, pid), null)
  return { version: 1, items: Array.isArray(j?.items) ? j.items : [] }
}

function saveOutbox(root, pid, doc, { reason = '主动开口队列更新', actor = 'core:proactive' } = {}) {
  writeTracked(root, `${P.personas}/${pid}/self/outbox.json`, JSON.stringify(doc, null, 2) + '\n', { actor, reason })
}

/** 按指针把那条原始记录读出来（发回原场景要靠它的 channel / actor）。 */
export function recordOfPointer(root, ptr) {
  const p = parsePointer(ptr)
  if (!p || p.kind !== 'raw') return null
  const abs = path.join(root, p.rel)
  if (!exists(abs)) return null
  try {
    for (const line of fs.readFileSync(abs, 'utf8').split('\n')) {
      if (!line.trim()) continue
      const rec = JSON.parse(line)
      if (rec?.id === p.id) return { ...rec, pointer: ptr }
    }
  } catch {
    return null
  }
  return null
}

function templateFor(drives, need) {
  return PROACTIVE_TEMPLATES[need] ?? PROACTIVE_TEMPLATES._default
}

/** 当前小时是否落在"别吵"的时段里（支持跨零点，例如 23:00-08:00）。 */
export function inQuietHours(ranges, now = new Date()) {
  if (!Array.isArray(ranges) || !ranges.length) return false
  const mins = now.getHours() * 60 + now.getMinutes()
  for (const r of ranges) {
    const m = /^(\d{1,2}):(\d{2})\s*-\s*(\d{1,2}):(\d{2})$/.exec(String(r).trim())
    if (!m) continue
    const a = Number(m[1]) * 60 + Number(m[2])
    const b = Number(m[3]) * 60 + Number(m[4])
    if (a <= b ? mins >= a && mins < b : mins >= a || mins < b) return true
  }
  return false
}

function countSent(items, sinceMs, scene = null) {
  const since = Date.now() - sinceMs
  return items.filter((it) => it.status === 'sent' && Date.parse(it.sent_at ?? 0) >= since && (!scene || it.scene === scene)).length
}

/**
 * 算一轮：该不该说、要说什么、发到哪。
 *
 * @returns {{queued:Array, held:Array, skipped:Array, reasons:object}}
 */
export function planProactive(root, pid, { now = Date.now() } = {}) {
  const doc = readPurposes(root, pid)
  const drives = readDrives(root, pid)
  const outbox = readOutbox(root, pid)
  const queued = []
  const held = []
  const skipped = []
  const reasons = {}

  const queuedIds = new Set(outbox.items.filter((i) => i.status === 'pending' || i.status === 'held').map((i) => i.why))

  const candidates = (doc.items ?? [])
    .filter((p) => p && p.status === 'open')
    .filter((p) => Date.parse(p.due ?? 0) <= now)
    .filter((p) => (Number(drives.values[p.need]) || 0) >= PROACTIVE_MIN_DRIVE)
    .filter((p) => !queuedIds.has(p.id))
    .sort((a, b) => (Number(drives.values[b.need]) || 0) - (Number(drives.values[a.need]) || 0))

  let made = 0
  for (const p of candidates) {
    if (made >= PROACTIVE_MAX_PER_RUN) break
    const rec = p.origin ? recordOfPointer(root, p.origin) : null
    if (!rec) {
      skipped.push({ why: p.id, reason: 'no-origin-record' })
      continue
    }
    const rules = loadEffectiveRules(root, pid, { channel: rec.channel }).rules
    const action = rules.action ?? {}

    if (action.proactive === 'off') {
      skipped.push({ why: p.id, reason: 'proactive=off' })
      continue
    }

    const scene = String(rec.channel ?? '')
    const isGroup = scene.startsWith('group:')
    if (isGroup && action.group_proactive === false) {
      // 群里默认不主动插话：这条留在 held，等你允许了再放
      held.push({ why: p.id, reason: 'group_proactive=false' })
      continue
    }

    // 黑白名单：只影响她"回不回话"，所以主动开口也要先过这一关。
    // 发到白名单外/黑名单里的人，等于绕过了名单——不能放行。
    {
      const targetKind = isGroup ? 'groups' : 'people'
      const targetId = isGroup ? scene.slice('group:'.length) : scene.slice('private:'.length)
      const verdict = canReply(root, pid, targetKind, targetId)
      if (!verdict.allowed) {
        held.push({ why: p.id, reason: `audience:${verdict.reason}` })
        continue
      }
    }

    const fact = String(rec.text ?? '').replace(/\s+/g, ' ').trim().slice(0, 40)
    if (!fact) {
      skipped.push({ why: p.id, reason: 'empty-fact' })
      continue
    }

    const perTarget = action.per_target !== false
    const targetKey = isGroup ? scene : scene
    const hourCap = Number(action.max_per_hour ?? 3)
    const dayCap = Number(action.max_per_day ?? 20)
    const sentLastHour = countSent(outbox.items, 3_600_000, perTarget ? targetKey : null)
    const sentLastDay = countSent(outbox.items, 86_400_000, perTarget ? targetKey : null)
    if (sentLastHour >= hourCap || sentLastDay >= dayCap) {
      held.push({ why: p.id, reason: sentLastHour >= hourCap ? 'max_per_hour' : 'max_per_day' })
      continue
    }

    if (inQuietHours(action.quiet_hours, new Date(now))) {
      held.push({ why: p.id, reason: 'quiet_hours' })
      continue
    }

    const text = templateFor(drives, p.need).replace('{fact}', fact)
    const item = {
      id: `out_${ulid()}`,
      scene,
      // 群里要 @ 说话的人：发送方拿这个字段去 @
      target: isGroup && rec.actor?.id ? { platform: rec.source ?? 'qq', id: String(rec.actor.id), name: rec.actor?.name ?? '' } : null,
      text,
      need: p.need,
      needName: driveName(drives, p.need),
      why: p.id,
      origin: rec.pointer ?? p.origin ?? null,
      status: 'pending',
      created: localIso(new Date(now)),
      due: localIso(new Date(now)),
    }
    outbox.items.push(item)
    queued.push(item)
    made += 1
  }

  if (queued.length) {
    saveOutbox(root, pid, outbox, { reason: `主动开口：产出 ${queued.length} 条待发` })
    try {
      appendEvent(root, {
        kind: 'proactive.queued',
        level: 'info',
        actor: 'core:proactive',
        text: `想出 ${queued.length} 句话：${queued.map((q) => q.text.slice(0, 20)).join(' / ')}`,
        data: { items: queued.map((q) => ({ id: q.id, scene: q.scene, why: q.why })) },
      })
    } catch {
      /* 事件写不进去不影响队列 */
    }
  }
  for (const h of held) reasons[h.reason] = (reasons[h.reason] ?? 0) + 1
  return { queued, held, skipped, reasons }
}

/** 人工/调度把一条标记成已发（模块发送成功后调；现在只有测试与 CLI 会用）。 */
export function markSent(root, pid, id, { now = Date.now() } = {}) {
  const doc = readOutbox(root, pid)
  const it = doc.items.find((x) => x.id === id)
  if (!it) throw new Error(`没有这条待发：${id}`)
  it.status = 'sent'
  it.sent_at = localIso(new Date(now))
  saveOutbox(root, pid, doc, { reason: `已发出：${it.text.slice(0, 30)}` })
  return it
}

/** 人不要她说这句：标记成 dropped（不删记录，留着能回看"她本来想说什么"）。 */
export function dropOutbox(root, pid, id, { reason = '人为取消', actor = 'human:editor' } = {}) {
  const doc = readOutbox(root, pid)
  const it = doc.items.find((x) => x.id === id)
  if (!it) throw new Error(`没有这条待发：${id}`)
  it.status = 'dropped'
  it.dropped_at = localIso()
  it.drop_reason = String(reason).slice(0, 100)
  saveOutbox(root, pid, doc, { reason: `取消主动消息：${reason}`, actor })
  return it
}

/** 定时器：每 N 分钟算一轮。返回 stop()。 */
export function startProactive(root, { everyMinutes = PROACTIVE_EVERY_MINUTES, firstDelayMs = 20_000, onRun = null } = {}) {
  const everyMs = Math.max(60_000, Number(everyMinutes || PROACTIVE_EVERY_MINUTES) * 60_000)
  let stopped = false
  let timer = null

  const run = () => {
    if (stopped) return
    let result = null
    try {
      const pid = readMarker(root)?.active
      result = pid ? planProactive(root, pid) : { queued: [], held: [], skipped: [], reasons: { 'no-persona': 1 } }
    } catch (err) {
      result = { queued: [], held: [], skipped: [], reasons: { error: String(err?.message ?? err) } }
    }
    try {
      onRun?.(result)
    } catch {
      /* 回调出错不影响下一轮 */
    }
  }

  const first = setTimeout(() => {
    run()
    timer = setInterval(run, everyMs)
    timer.unref?.()
  }, Math.max(0, Number(firstDelayMs) || 0))
  first.unref?.()

  return {
    stop() {
      stopped = true
      clearTimeout(first)
      if (timer) clearInterval(timer)
    },
    runNow: run,
  }
}
