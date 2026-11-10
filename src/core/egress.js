// src/core/egress.js —— 出站准入：模块要替她说话，必须先问过核心。
//
// 为什么需要这一层：协议 §1 第 4 条写"不能自己决定发什么，发送由核心发起、模块只投递"。
// 但真实世界里，回复的内容是**模型产生、模块投递**的——如果模块拿到内容就直接发，
// 那条边界就成了文档里的装饰：静默时段、配额、黑名单、《在乎》里写的取舍，全都被绕过去。
//
// 所以模块在发之前必须调用 `egress.request`：
//
//   模块 → 核心：{ channel, text, media?, trace? }
//      ↓ 核心依次检查
//      ① 场景必须解析成内部编号（不是外部号码）
//      ② rules/action：deny、静默时段、每小时/每天配额（per_target）
//      ③ 黑白名单：这个对象现在允许她回话吗（canReply）
//      ↓ 通过
//   核心 → 模块：{ ok:true, id }   ← 模块拿到这个才去投递
//      ↓ 拒绝
//   核心 → 模块：{ ok:false, code:'E_REFUSED', reason }  ← **内容不落盘、不回显**
//
// 账本：`personas/<人格>/self/egress.ndjson` 只记 **hash / 字节数 / 场景 / 模块**，
// **不记正文**——出站内容没必要永久留存，留哈希是为了"能不能对账"，不是"说了什么"。
import path from 'node:path'
import fs from 'node:fs'
import { exists, ensureDir, localIso, sha256, ulid } from './fsx.js'
import { P } from './paths.js'
import { loadEffectiveRules, loadGuardrails, logRefusal } from './rules.js'
import { resolveChannel } from './channels.js'
import { canReply } from './audience.js'
import { inQuietHours } from './proactive.js'
import { appendEvent } from './events.js'

export const EGRESS_MAX_TEXT = 4000

function ledgerPath(root, pid) {
  return path.join(root, P.personas, pid, 'self', 'egress.ndjson')
}

/** 读最近若干条出站记录（只含 hash/字节，不含正文）。 */
export function readEgress(root, pid, { limit = 50 } = {}) {
  const abs = ledgerPath(root, pid)
  if (!exists(abs)) return []
  try {
    return fs
      .readFileSync(abs, 'utf8')
      .split('\n')
      .filter(Boolean)
      .slice(-Math.max(1, Math.min(500, limit)))
      .map((l) => JSON.parse(l))
  } catch {
    return []
  }
}

function appendEgress(root, pid, row) {
  const abs = ledgerPath(root, pid)
  ensureDir(path.dirname(abs))
  fs.appendFileSync(abs, `${JSON.stringify(row)}\n`, 'utf8')
}

/** 窗口内已经放行了几条（按人/按场景，取决于 per_target）。 */
function countSent(root, pid, { sinceMs, scene = null, now = Date.now() }) {
  return readEgress(root, pid, { limit: 500 }).filter(
    (r) => Date.parse(r.ts) >= now - sinceMs && (!scene || r.channel === scene),
  ).length
}

/**
 * 模块请求发一条消息。
 *
 * @returns {{ok:true, id:string, channel:string} | {ok:false, code:string, reason:string}}
 */
export function requestEgress(root, pid, { moduleId, channel, text, media = [], now = Date.now() } = {}) {
  const body = String(text ?? '')
  if (!body.trim() && !(Array.isArray(media) && media.length)) {
    return { ok: false, code: 'E_EMPTY', reason: '既没有文字也没有媒体，发什么？' }
  }
  if ([...body].length > EGRESS_MAX_TEXT) {
    return { ok: false, code: 'E_TOO_LONG', reason: `正文最多 ${EGRESS_MAX_TEXT} 字（收到 ${[...body].length}）` }
  }

  // ① 场景必须是内部编号：外部号码当场景 = 回到"频道属于某个 App"的老路
  const scene = String(channel ?? '')
  const resolved = resolveChannel(root, scene)
  if (!resolved.resolved) {
    return {
      ok: false,
      code: 'E_BAD_SCENE',
      reason: `场景必须是内部编号（private:person_… / group:grp_…），收到：${scene}`,
    }
  }

  const rules = loadEffectiveRules(root, pid, { channel: scene }).rules
  const action = rules.action ?? {}

  // ② 动作闸门：deny 列表 + 静默时段
  if ((rules.deny ?? []).includes('send')) {
    return refuse(root, { pid, moduleId, scene, reason: 'deny: send', code: 'E_REFUSED' })
  }
  if (inQuietHours(action.quiet_hours, new Date(now))) {
    return refuse(root, { pid, moduleId, scene, reason: 'quiet_hours', code: 'E_REFUSED' })
  }

  // ③ 黑白名单：只影响"回不回话"，出站正是回话
  const isGroup = scene.startsWith('group:')
  const kind = isGroup ? 'groups' : 'people'
  const targetId = isGroup ? scene.slice('group:'.length) : scene.slice('private:'.length)
  const verdict = canReply(root, pid, kind, targetId)
  if (!verdict.allowed) {
    return refuse(root, { pid, moduleId, scene, reason: `audience:${verdict.reason}`, code: 'E_REFUSED' })
  }

  // ④ 配额：和主动开口共用同一套刻度（她一天说多少句，不该有两本账）
  const perTarget = action.per_target !== false
  const key = perTarget ? scene : null
  const hourCap = Number(action.max_per_hour ?? 3)
  const dayCap = Number(action.max_per_day ?? 20)
  if (countSent(root, pid, { sinceMs: 3_600_000, scene: key, now }) >= hourCap) {
    return refuse(root, { pid, moduleId, scene, reason: 'max_per_hour', code: 'E_REFUSED' })
  }
  if (countSent(root, pid, { sinceMs: 86_400_000, scene: key, now }) >= dayCap) {
    return refuse(root, { pid, moduleId, scene, reason: 'max_per_day', code: 'E_REFUSED' })
  }

  // ⑤ 硬线的 never_do 是"能力声明"，不是正文过滤：正文里出现它也没意义。
  //    这里只把它读一遍，确保数据坏了不会让出站整条挂掉。
  void loadGuardrails(root)

  const id = `eg_${ulid()}`
  appendEgress(root, pid, {
    id,
    ts: localIso(new Date(now)),
    module: String(moduleId ?? 'unknown'),
    channel: scene,
    bytes: Buffer.byteLength(body, 'utf8'),
    chars: [...body].length,
    hash: sha256(Buffer.from(body, 'utf8')),
    media: Array.isArray(media) ? media.length : 0,
  })
  return { ok: true, id, channel: scene }
}

/** 拒绝：记一条 refusal（**不记正文**），并留事件；返回给模块的是"为什么不行"。 */
function refuse(root, { pid, moduleId, scene, reason, code }) {
  try {
    logRefusal(root, pid, { dim: 'egress', action: 'send', channel: scene, reason })
  } catch {
    /* 记账失败不影响拒绝 */
  }
  try {
    appendEvent(root, {
      kind: 'refusal',
      level: 'warn',
      actor: `module:${moduleId ?? 'unknown'}`,
      text: `出站被拒（${scene}）：${reason}`,
      data: { dim: 'egress', channel: scene, reason },
    })
  } catch {
    /* ignore */
  }
  return { ok: false, code, reason }
}
