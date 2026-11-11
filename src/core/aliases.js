// src/core/aliases.js —— 从自然语言描述里认出"她还可能被怎么叫"，用来把一句话对到一张卡。
//
// 用户定的（2026-11-11）：
//   · **名字唯一**（由 names.js 保证），名字直接定位卡片；
//   · **昵称不单独存字段**，就写在描述里（人物卡的印象、群体卡的描述），不同卡片可以有同一个昵称；
//   · 昵称撞了怎么办：群聊里用"谁属于这个群"筛；筛不唯一就**跳过**——宁可不给，也不给错人。
//
// 所以这里只做两件事：**从描述里抽昵称**、**把一段文本对到卡片**。
// 抽取是启发式的，宁可少抽（抽错会让一张卡被随便一句话激活，比漏抽糟）。
import { loadIdentities, readProfile } from './entities.js'
import { readImpression } from './impressions.js'
import { listGroups } from './groups.js'

/** 昵称最多 8 个字：再长就不是"称呼"了，是句子。 */
export const ALIAS_MAX_CHARS = 8

/** 这些词跟在"叫"后面也不是昵称。 */
const ALIAS_STOP = new Set([
  '他', '她', '它', '我', '你', '大家', '我们', '他们', '她们', '什么', '这个', '那个', '名字', '外号',
])

/**
 * 从一段自然语言里抽"称呼"。
 *
 * 只认显式说法：**叫 / 称呼 / 昵称 / 外号 / 别名 / 简称 / 号称** 后面那串字。
 * 不做模糊匹配——"他是我的同事"不该被当成昵称。
 *
 * @returns {string[]}
 */
export function extractAliases(text, { max = 8 } = {}) {
  const s = String(text ?? '')
  if (!s) return []
  const out = []
  const re = /(?:叫做|叫作|叫|称呼为|称呼|昵称为|昵称|外号是|外号|别名是|别名|简称为|简称|号称)\s*[「『"“']?([^\s，。；、！？：:,.!?「」『』“”"'（）()\[\]]{1,12})/g
  for (const m of s.matchAll(re)) {
    let v = String(m[1] ?? '').trim()
    // 去掉开头的代词/助词（"叫他老王" → "老王"）
    v = v.replace(/^(?:他|她|它|我|你|大家|他们|她们)+/, '').trim()
    if (!v) continue
    if ([...v].length > ALIAS_MAX_CHARS) continue
    if ([...v].length < 2) continue
    if (ALIAS_STOP.has(v)) continue
    if (!out.includes(v)) out.push(v)
    if (out.length >= max) break
  }
  return out
}

/** 一张人物卡的全部"可被怎么称呼"：唯一名 + 描述里认出的昵称。 */
function personAliases(root, pid, uid) {
  const data = loadIdentities(root)
  const person = data.people?.[uid]
  if (!person) return { names: [], aliases: [] }
  const profile = readProfile(root, pid, uid)
  const names = [...new Set([person.display, profile?.display].filter(Boolean).map(String))]
  const texts = []
  try {
    const imp = readImpression(root, pid, 'person', uid)
    if (imp?.text) texts.push(String(imp.text))
  } catch {
    /* 印象读不到不影响 */
  }
  if (profile?.sketch) texts.push(String(profile.sketch))
  const aliases = []
  for (const t of texts) {
    for (const a of extractAliases(t)) if (!names.includes(a) && !aliases.includes(a)) aliases.push(a)
  }
  return { names, aliases }
}

/**
 * 建索引：`称呼 → 可能是谁`。
 *
 * 名字只会指向一个人（唯一性保证）；昵称可能指向多个（用户明说允许重复）。
 *
 * @returns {Map<string, {key:string, uids:string[], kind:'name'|'alias'}>}
 */
export function personMentionIndex(root, pid) {
  const data = loadIdentities(root)
  const map = new Map()
  const add = (key, uid, kind) => {
    const k = String(key ?? '').trim()
    if (!k || [...k].length < 2) return
    const hit = map.get(k) ?? { key: k, uids: [], kind }
    if (!hit.uids.includes(uid)) hit.uids.push(uid)
    // 名字优先：同一个字符串既是名字又是昵称时，按名字处理（唯一命中）
    if (kind === 'name') hit.kind = 'name'
    map.set(k, hit)
  }
  for (const person of Object.values(data.people ?? {})) {
    if (person.tier === 'shadow') continue
    if (!readProfile(root, pid, person.uid)) continue
    const { names, aliases } = personAliases(root, pid, person.uid)
    for (const n of names) add(n, person.uid, 'name')
    for (const a of aliases) add(a, person.uid, 'alias')
  }
  return map
}

/**
 * 这段文本里提到了谁（只返回**能确定**的）。
 *
 * @param {object} o
 * @param {string} o.text
 * @param {Set<string>|string[]} [o.exclude] 已经在场的人，不再重复给卡
 * @param {string[]} [o.groupMembers] 当前群的成员 uid：昵称撞车时用它裁决
 * @param {number} [o.limit]
 * @returns {string[]} uid 列表（按称呼长度降序：长名字更具体，先认长的）
 */
export function mentionedPeople(root, pid, { text = '', exclude = [], groupMembers = null, limit = 2 } = {}) {
  const hay = String(text ?? '')
  if (!hay) return []
  const skip = new Set(Array.isArray(exclude) ? exclude : [...(exclude ?? [])])
  const members = Array.isArray(groupMembers) ? new Set(groupMembers) : null
  const index = personMentionIndex(root, pid)

  const hits = []
  for (const entry of [...index.values()].sort((a, b) => b.key.length - a.key.length)) {
    if (!hay.includes(entry.key)) continue
    let uids = entry.uids.filter((uid) => !skip.has(uid))
    if (!uids.length) continue
    if (uids.length > 1) {
      // 昵称撞车：优先用"这个群里的人"裁决；没有群、或群里也不唯一 → 跳过
      if (!members) continue
      const inGroup = uids.filter((uid) => members.has(uid))
      if (inGroup.length !== 1) continue
      uids = inGroup
    }
    const uid = uids[0]
    if (!hits.includes(uid)) hits.push(uid)
    if (hits.length >= limit) break
  }
  return hits.slice(0, limit)
}

/** 群体这边：名字 + 描述里认出的昵称（与人物同一套抽取规则）。 */
export function groupAliasIndex(root, pid) {
  const map = new Map()
  const add = (key, gid, kind) => {
    const k = String(key ?? '').trim()
    if (!k || [...k].length < 2) return
    const hit = map.get(k) ?? { key: k, gids: [], kind }
    if (!hit.gids.includes(gid)) hit.gids.push(gid)
    if (kind === 'name') hit.kind = 'name'
    map.set(k, hit)
  }
  for (const g of listGroups(root, pid)) {
    if (g.name) add(g.name, g.gid, 'name')
    const texts = []
    if (g.feature) texts.push(String(g.feature))
    try {
      const imp = readImpression(root, pid, 'group', g.gid)
      if (imp?.text) texts.push(String(imp.text))
    } catch {
      /* 印象读不到不影响 */
    }
    for (const t of texts) {
      for (const a of extractAliases(t)) if (a !== g.name) add(a, g.gid, 'alias')
    }
  }
  return map
}

/** 这段文本提到了哪些群：名字命中唯一；昵称撞车就跳过（群体没有"成员"能裁决）。 */
export function mentionedGroups(root, pid, { text = '', exclude = [], limit = 2 } = {}) {
  const hay = String(text ?? '')
  if (!hay) return []
  const skip = new Set(exclude)
  const index = groupAliasIndex(root, pid)
  const hits = []
  for (const entry of [...index.values()].sort((a, b) => b.key.length - a.key.length)) {
    if (!hay.includes(entry.key)) continue
    const gids = entry.gids.filter((g) => !skip.has(g))
    if (gids.length !== 1) continue
    if (!hits.includes(gids[0])) hits.push(gids[0])
    if (hits.length >= limit) break
  }
  return hits.slice(0, limit)
}

