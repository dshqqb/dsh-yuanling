// src/core/audience.js —— "她跟谁说话"的白名单 / 黑名单。
//
// 用户定的（2026-11-10，Q21=A）：
//   · 名单**只影响她是否回话**，不影响她接收信息 —— raw 照记，记忆照长；
//   · 白名单开启：只跟名单上的人/群说话；黑名单开启：除名单外都行；
//   · 两个开关都关 = 不限制（默认），打开一个自动关掉另一个（互斥）；
//   · **重要人物 / 管理员永远在白名单里，且永远不能被设成黑名单**；群体的「重点群体」同理；
//     这是**动态豁免**，不写进名单文件——取消重点/卸任后豁免自动消失，不留脏数据。
//
// 核心不发消息，所以这里给的是"能不能回"的判定，给适配器查（`canReply`），
// 并且主动开口（proactive.js）会先过这一关。
import path from 'node:path'
import fsSync from 'node:fs'
import { readJson } from './fsx.js'
import { P } from './paths.js'
import { writeTracked } from './version.js'
import { listPeopleForUi } from './entities.js'
import { readGroup } from './groups.js'

export const AUDIENCE_KINDS = ['people', 'groups']
export const AUDIENCE_MODES = ['off', 'allow', 'deny']

export const AUDIENCE_DEFAULTS = () => ({
  people: { mode: 'off', allow: [], deny: [] },
  groups: { mode: 'off', allow: [], deny: [] },
})

function audienceRel(pid) {
  return `${P.personas}/${pid}/state/audience.json`
}

function normalizeOne(raw) {
  const mode = AUDIENCE_MODES.includes(raw?.mode) ? raw.mode : 'off'
  const uniq = (v) => [...new Set((Array.isArray(v) ? v : []).map(String).filter(Boolean))]
  return { mode, allow: uniq(raw?.allow), deny: uniq(raw?.deny) }
}

export function readAudience(root, pid) {
  const j = readJson(path.join(root, audienceRel(pid)), null)
  return {
    version: 1,
    people: normalizeOne(j?.people),
    groups: normalizeOne(j?.groups),
  }
}

function saveAudience(root, pid, doc, { actor = 'human:editor', reason = '更新黑白名单' } = {}) {
  const next = { version: 1, ...doc }
  writeTracked(root, audienceRel(pid), JSON.stringify(next, null, 2) + '\n', { actor, reason })
  return next
}

function assertKind(kind) {
  if (!AUDIENCE_KINDS.includes(kind)) throw new Error(`名单只有 people / groups，收到：${kind}`)
}

/**
 * 是不是"永远在白名单、永不能进黑名单"的那类。
 * 人物：管理员 / 重要人物；群体：重点群体。
 */
export function isExempt(root, pid, kind, id) {
  if (kind === 'people') {
    const row = listPeopleForUi(root, pid).find((p) => p.uid === id)
    if (!row) return false
    if (row.admin) return true
    return Boolean(row.pinned)
  }
  if (kind === 'groups') return readGroup(root, pid, id)?.tier === 'important'
  return false
}

/** 这个对象现在该不该被她"回话"。 */
export function canReply(root, pid, kind, id) {
  assertKind(kind)
  const a = readAudience(root, pid)[kind]
  const exempt = isExempt(root, pid, kind, id)
  if (exempt) return { allowed: true, mode: a.mode, reason: 'exempt' }
  if (a.mode === 'off') return { allowed: true, mode: a.mode, reason: 'off' }
  if (a.mode === 'allow') {
    return a.allow.includes(String(id))
      ? { allowed: true, mode: a.mode, reason: 'whitelisted' }
      : { allowed: false, mode: a.mode, reason: 'not-in-allowlist' }
  }
  // deny：名单里的人不回，其余都行
  return a.deny.includes(String(id))
    ? { allowed: false, mode: a.mode, reason: 'blacklisted' }
    : { allowed: true, mode: a.mode, reason: 'not-blacklisted' }
}

/** 切模式（互斥：allow / deny / off 三选一）。 */
export function setAudienceMode(root, pid, kind, mode, { actor = 'human:editor' } = {}) {
  assertKind(kind)
  if (!AUDIENCE_MODES.includes(mode)) throw new Error(`模式只有 off / allow / deny，收到：${mode}`)
  const doc = readAudience(root, pid)
  if (doc[kind].mode === mode) return doc
  doc[kind].mode = mode
  return saveAudience(root, pid, doc, {
    actor,
    reason: mode === 'off' ? `关闭${kind === 'people' ? '人物' : '群体'}名单` : `开启${kind === 'people' ? '人物' : '群体'}${mode === 'allow' ? '白' : '黑'}名单`,
  })
}

/**
 * 把一个对象放进白/黑名单（自动从另一边移除，保持互斥）。
 * 豁免对象（管理员/重要人物/重点群体）**不能进黑名单**——这是硬规则，直接拒绝。
 */
export function setAudienceMember(root, pid, kind, id, list, { actor = 'human:editor' } = {}) {
  assertKind(kind)
  if (list !== 'allow' && list !== 'deny') throw new Error(`名单只有 allow / deny，收到：${list}`)
  const key = String(id ?? '').trim()
  if (!key) throw new Error('缺少对象 id')

  if (list === 'deny' && isExempt(root, pid, kind, key)) {
    throw new Error(
      kind === 'people'
        ? '管理员和重要人物永远在白名单里，不能设为黑名单'
        : '重点群体永远在白名单里，不能设为黑名单',
    )
  }

  const doc = readAudience(root, pid)
  const one = doc[kind]
  one.allow = one.allow.filter((x) => x !== key)
  one.deny = one.deny.filter((x) => x !== key)
  one[list].push(key)
  return saveAudience(root, pid, doc, {
    actor,
    reason: `加入${list === 'allow' ? '白' : '黑'}名单：${key}`,
  })
}

/** 从两个名单里都移除。 */
export function removeAudienceMember(root, pid, kind, id, { actor = 'human:editor' } = {}) {
  assertKind(kind)
  const key = String(id ?? '').trim()
  const doc = readAudience(root, pid)
  const one = doc[kind]
  one.allow = one.allow.filter((x) => x !== key)
  one.deny = one.deny.filter((x) => x !== key)
  return saveAudience(root, pid, doc, { actor, reason: `移出名单：${key}` })
}

/**
 * 给页面用的完整视图：两个名单 + 自动豁免的人（标出来，说明"不用手动加"）。
 */
export function audienceView(root, pid, kind) {
  assertKind(kind)
  const doc = readAudience(root, pid)
  const one = doc[kind]

  if (kind === 'people') {
    const rows = listPeopleForUi(root, pid).map((x) => ({
      id: x.uid,
      name: x.display || x.uid,
      exempt: Boolean(x.admin || x.pinned),
      why: x.admin ? '管理员' : x.pinned ? '重要人物' : '',
    }))
    const byId = new Map(rows.map((r) => [r.id, r]))
    const decorate = (id) => byId.get(id) ?? { id, name: id, exempt: false, why: '' }
    const allow = one.allow.filter((id) => !byId.get(id)?.exempt).map(decorate)
    const deny = one.deny.map(decorate)
    return {
      mode: one.mode,
      allow,
      deny,
      auto: rows.filter((r) => r.exempt),
    }
  }

  const groups = (listGroupsSafe(root, pid) ?? []).map((g) => ({
    id: g.gid,
    name: g.name || g.gid,
    exempt: g.tier === 'important',
    why: g.tier === 'important' ? '重点群体' : '',
  }))
  const byId = new Map(groups.map((r) => [r.id, r]))
  const decorate = (id) => byId.get(id) ?? { id, name: id, exempt: false, why: '' }
  return {
    mode: one.mode,
    allow: one.allow.filter((id) => !isExempt(root, pid, 'groups', id)).map(decorate),
    deny: one.deny.map(decorate),
    auto: groups.filter((r) => r.exempt),
  }
}

/** 群体列表要拿到名字；这里只读卡片，避免 listGroups 现算权重的开销。 */
function listGroupsSafe(root, pid) {
  const dir = path.join(root, P.personas, pid, 'entities', 'groups')
  let names = []
  try {
    const fs = readDirSyncSafe(dir)
    names = fs
      .filter((f) => f.endsWith('.json'))
      .map((f) => {
        const g = readJson(path.join(dir, f), null)
        return g ? { gid: String(g.gid ?? f.replace(/\.json$/, '')), name: String(g.name ?? ''), tier: g.tier ?? null } : null
      })
      .filter(Boolean)
  } catch {
    names = []
  }
  return names
}

function readDirSyncSafe(dir) {
  try {
    return fsSync.readdirSync(dir)
  } catch {
    return []
  }
}
