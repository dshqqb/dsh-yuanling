// src/core/identity.js —— 身份主张与纠错。
//
// 一条原则：**身份是「主张」，不是「配置」。**
//   有人说"我 b 站是 UID 123" → 这是一条带证据的记忆事实，不是设置项。
//   主张会被推翻，所以旧主张不删、只关闭；合并错了可以拆，并留下为什么拆。
//
// 三条保守规则：
//   ① 只有 owner 私聊里的自述自动确认——群聊里说"这是我小号"可能是冒充。
//   ② 推断（昵称/同群）只生成候选，永不自动合并。
//   ③ 纠错走 split + 关闭旧主张，全程留痕。
import { localIso } from './fsx.js'
import {
  addCandidate,
  createPerson,
  createPersonAuto,
  findByIdentity,
  linkIdentity,
  loadIdentities,
  personForChannel,
  splitIdentity,
} from './entities.js'
import { listEntries, entryRel, addFact } from './memory.js'
import { writeTracked } from './version.js'
import { listDays, readDay } from './raw.js'
import { appendLine } from './fsx.js'
import { P } from './paths.js'
import path from 'node:path'

/** 从一句话里抽"我是谁"的主张。只认最明确的那几种说法。 */
export function extractClaims(text) {
  const t = String(text ?? '')
  const out = []
  const bili = /我的?\s*b\s*站(?:号|账号|id)?\s*(?:是|为)?\s*[:：]?\s*([A-Za-z0-9_-]{3,})/i.exec(t)
  if (bili) out.push({ platform: 'bili', id: bili[1] })
  const qq = /我的?\s*qq\s*(?:号)?\s*(?:是|为)?\s*[:：]?\s*(\d{5,12})/i.exec(t)
  if (qq) out.push({ platform: 'qq', id: qq[1] })
  return out
}

function logChange(root, entry) {
  appendLine(path.join(root, P.changes), { ts: localIso(), ...entry })
}

/**
 * 记一条身份主张。
 *
 * - owner 私聊自述 → 直接确认（建人 / 绑定 / 写一条 identity-claim 事实）
 * - 其余（别人说的、群里的、推断出来的）→ 进候选，不自动合并
 *
 * @returns {{state:'confirmed'|'pending', uid:string|null, identity:object, factId?:string}}
 */
export function claimIdentity(
  root,
  pid,
  { platform, id, channel = null, speakerKind = 'owner', text = '', src, now = localIso() },
) {
  const p = String(platform)
  const i = String(id)
  if (!/^[a-z0-9]{2,24}$/.test(p)) throw new Error(`不认识的平台：${p}（只允许小写字母/数字）`)
  if (!i) throw new Error('缺少账号 id')
  if (!src) throw new Error('身份主张要有证据指针（谁在哪儿说的）')

  const isOwnerPrivate = speakerKind === 'owner' && String(channel ?? '').startsWith('private:')

  if (!isOwnerPrivate) {
    const r = addCandidate(root, { uid: null, platform: p, id: i, reason: '非本人私聊自述，需人工确认', evidence: [src] })
    logChange(root, { kind: 'identity_claim', state: 'pending', platform: p, id: i, channel, src, added: r.added })
    return { state: 'pending', uid: null, identity: { platform: p, id: i }, added: r.added }
  }

  // 先确定"本人"是谁：私聊频道里的 qq 号；没有就建一个
  const speakerId = String(channel).split(':')[1]
  let uid = personForChannel(root, channel)
  if (!uid) {
    // 自动建卡：撞名就自动加标识（(QQ) 主人），不把人卡流程卡死
    const person = createPersonAuto(root, { display: '主人', platform: 'qq', nativeId: speakerId })
    uid = person.uid
    if (speakerId) linkIdentity(root, uid, { platform: 'qq', id: speakerId })
  }

  const existing = findByIdentity(root, p, i)
  if (existing) {
    return { state: 'confirmed', uid: existing.uid, identity: { platform: p, id: i }, changed: false }
  }

  linkIdentity(root, uid, { platform: p, id: i, state: 'confirmed', confidence: 1, evidence: [src] })

  const fact = addFact(root, pid, {
    topic: '身份',
    text: String(text || `我的 ${p} 是 ${i}`).slice(0, 200),
    src,
    kind: 'identity-claim',
    slot: `${p}-id`,
    person: uid,
    origin: false,
    now,
  })

  logChange(root, { kind: 'identity_claim', state: 'confirmed', uid, platform: p, id: i, channel, src })
  return { state: 'confirmed', uid, identity: { platform: p, id: i }, factId: fact.fact?.id, changed: true }
}

// ── 推断 ────────────────────────────────────────────────────────────────

function platformOfChannel(channel) {
  const s = String(channel ?? '')
  if (s.startsWith('bili:')) return 'bili'
  if (s.startsWith('dsh:')) return 'dsh'
  if (s.startsWith('private:') || s.startsWith('group:')) return 'qq'
  return null
}

function normName(name) {
  return String(name ?? '').trim().toLowerCase().replace(/\s+/g, '')
}

/**
 * 从 raw 里找"同一个名字出现在多个平台"的情况，生成候选。
 * **只看，不写**——要不要采纳由人决定。
 *
 * @returns {Array<{name:string, identities:Array<{platform:string,id:string}>, reason:string}>}
 */
export function inferIdentityCandidates(root, { minNameLength = 2, limit = 50 } = {}) {
  /** @type {Map<string, {display:string, ids:Map<string,{platform:string,id:string,count:number}>}>} */
  const byName = new Map()

  for (const date of listDays(root)) {
    for (const r of readDay(root, date)) {
      if ((r.type ?? 'message') !== 'message') continue
      const platform = platformOfChannel(r.channel)
      if (!platform) continue
      const name = normName(r.actor?.name)
      const id = String(r.actor?.id ?? '')
      if (name.length < minNameLength || !id) continue

      const slot = byName.get(name) ?? { display: String(r.actor?.name ?? ''), ids: new Map() }
      const key = `${platform}:${id}`
      const cur = slot.ids.get(key) ?? { platform, id, count: 0 }
      cur.count += 1
      slot.ids.set(key, cur)
      byName.set(name, slot)
    }
  }

  const out = []
  for (const [name, slot] of byName) {
    const identities = [...slot.ids.values()]
    const platforms = new Set(identities.map((x) => x.platform))
    if (platforms.size < 2) continue
    out.push({
      name,
      display: slot.display,
      identities: identities.map(({ platform, id, count }) => ({ platform, id, count })),
      reason: `同一个昵称「${slot.display}」出现在 ${[...platforms].join(' / ')} 上`,
    })
    if (out.length >= limit) break
  }
  return out
}

/** 把推断结果写进候选（仍然不合并）。 */
export function applyInferredCandidates(root, pid, { limit = 50 } = {}) {
  const proposals = inferIdentityCandidates(root, { limit })
  let added = 0
  for (const c of proposals) {
    for (const identity of c.identities) {
      const r = addCandidate(root, {
        uid: null,
        platform: identity.platform,
        id: identity.id,
        reason: c.reason,
        evidence: [],
      })
      if (r.added) added += 1
    }
  }
  logChange(root, { kind: 'identity_infer', proposals: proposals.length, added })
  return { proposals: proposals.length, added }
}

// ── 纠错 ────────────────────────────────────────────────────────────────

/**
 * 纠正一条错误归属：把账号拆出去，并关闭指向它的身份主张。
 * 旧主张不删，只写 until——"当时确实这么说过"也是事实。
 */
export function correctIdentity(root, pid, { uid, platform, id, reason = '', evidence = [], now = localIso() }) {
  const p = String(platform)
  const i = String(id)
  const current = findByIdentity(root, p, i)
  if (!current) throw new Error(`没有找到 ${p}:${i} 的归属`)
  if (uid && current.uid !== uid) throw new Error(`这个账号实际属于 ${current.uid}，不是 ${uid}`)

  const moved = splitIdentity(root, current.uid, p, i)

  // 关闭旧主张
  const closed = []
  for (const e of listEntries(root, pid)) {
    let changed = false
    for (const f of e.facts) {
      if (f.kind !== 'identity-claim') continue
      if (f.slot !== `${p}-id`) continue
      if (f.until) continue
      f.until = now.slice(0, 10)
      closed.push(f.id)
      changed = true
    }
    if (changed) {
      e.updated = now
      writeTracked(root, entryRel(pid, e.space, e.topic), JSON.stringify(e, null, 2) + '\n', {
        actor: 'system:identity',
        reason: `纠正身份归属：${p}:${i} 从 ${current.uid} 拆出`,
      })
    }
  }

  logChange(root, {
    kind: 'identity_correction',
    from: current.uid,
    to: moved.uid,
    platform: p,
    id: i,
    reason,
    evidence,
    closed_facts: closed,
  })

  return { from: current.uid, to: moved.uid, closedFacts: closed }
}
