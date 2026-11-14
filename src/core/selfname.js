// src/core/selfname.js —— "她被人用一个新称呼叫了" → 攒够了就写进她自己的名称里。
//
// 用户定的（2026-11-11）：人格可以**有多个名称**；名称由用户填，也可以由她自己塑造——
// "如有人多次用一个昵称称呼虚拟人格，虚拟人格接收后就可以将昵称写入人格卡"。
//
// 为什么必须保守：名称写错会污染她对自己的认知（她会以奇怪的名字自认），
// 而且这是**自动写**、没人看着。所以三条闸门全开才落笔：
//   ① 那条消息必须**是在叫她**（@她 / 引用回复她）——普通闲聊里出现的两个字不算；
//   ② 同一个称呼要**不同的两个人以上**用过，且累计 ≥3 次、跨 ≥1 天；
//   ③ 抽取只认"句首的称呼"（「小灵，…」「小灵在吗」），且要过一串排除规则。
//
// 攒的过程中落在 `state/names.json`；写进名称走 renameCard，和人工改名同一条路（可回滚）。
import path from 'node:path'
import { readJson, writeJsonAtomic, localIso } from './fsx.js'
import { P } from './paths.js'
import { listDays, readDay } from './raw.js'
import { readCard, renameCard } from './personacard.js'
import { personaNameList } from './engage.js'

export const NAME_PROMOTE_MIN_ACTORS = 2
export const NAME_PROMOTE_MIN_HITS = 3
export const NAME_PROMOTE_MIN_DAYS = 1
export const NAME_MAX_TOTAL = 6

/** 句首 2–6 个字 + 标点/语气词，才算"称呼"；"灵" 这种单字一律不要。 */
const VOCATIVE_RE = /^[\s，。!！?？、~～]*([\u4e00-\u9fa5]{2,6})(?:啊|呀|呢|哦|嘛|哈|，|,|!|！|\?|？|\s|$)/
/** @她之后紧跟着的称呼：「@2823503286 小灵，…」 */
const AT_VOCATIVE_RE = /@\d{3,}\s*([\u4e00-\u9fa5]{2,6})(?:啊|呀|呢|哦|，|,|\s|$)/

const STOP = new Set([
  '你好', '您好', '大家', '我们', '你们', '他们', '她们', '这个', '那个', '什么', '怎么', '为什么',
  '今天', '明天', '昨天', '谢谢', '哈哈', '不是', '就是', '可以', '没有', '知道', '现在', '然后',
])

/** 去掉粘在称呼后面的语气/疑问尾巴（"阿灵在吗" → "阿灵"）。中文没有词边界，只能这样收。 */
function trimParticles(s) {
  const tails = ['在不在', '在吗', '在么', '在', '吗', '呢', '啊', '呀', '吧', '哦', '嘛', '哟']
  let cur = s
  for (let i = 0; i < 4; i += 1) {
    const hit = tails.find((x) => cur.endsWith(x) && [...cur].length - [...x].length >= 2)
    if (!hit) break
    cur = cur.slice(0, cur.length - hit.length)
  }
  return cur
}

function namesStatePath(root, pid) {
  return path.join(root, P.personas, pid, 'state', 'names.json')
}

export function readNameState(root, pid) {
  const j = readJson(namesStatePath(root, pid), null)
  return { version: 1, candidates: j?.candidates && typeof j.candidates === 'object' ? j.candidates : {} }
}

function saveNameState(root, pid, state) {
  writeJsonAtomic(namesStatePath(root, pid), { version: 1, candidates: state.candidates, at: localIso() })
}

/**
 * 她自己的账号 id（从 raw 里"她说过的话"反查）：用来判断"这条是不是在 @ 她"。
 * 找不到就返回空集——那时只靠"引用回复她"这一路。
 */
export function herPlatformIds(root, { days = 14 } = {}) {
  const ids = new Set()
  try {
    for (const day of listDays(root).slice(-Math.max(1, days))) {
      for (const rec of readDay(root, day)) {
        if (String(rec.role ?? '') !== 'bot') continue
        const id = rec.actor?.id
        if (id) ids.add(String(id))
      }
    }
  } catch {
    /* raw 读不到就当不知道 */
  }
  return ids
}

/** 这条消息是不是在叫她：@ 她的号，或者正文里喊了她的某个名字。 */
export function addressesHer(text, { names = [], selfIds = new Set() } = {}) {
  const t = String(text ?? '')
  if (!t) return false
  for (const id of selfIds) if (id && t.includes(`@${id}`)) return true
  return names.some((n) => n && t.includes(n))
}

/** 从"叫她"的那句话里抽出可能的称呼（句首 / @ 后面）。 */
export function extractVocatives(text, { names = [] } = {}) {
  const t = String(text ?? '')
  const out = []
  const push = (raw) => {
    const s = trimParticles(String(raw ?? '').trim())
    if ([...s].length < 2 || [...s].length > 6) return
    if (STOP.has(s)) return
    // 已知名字的一部分（「原」之于「原灵」「原灵」之于「小原灵」）不重复收
    if (names.some((n) => n.includes(s) || s.includes(n))) return
    if (!out.includes(s)) out.push(s)
  }
  const head = VOCATIVE_RE.exec(t)
  if (head) push(head[1])
  const at = AT_VOCATIVE_RE.exec(t)
  if (at) push(at[1])
  return out
}

/**
 * 记一次"被人这样叫"；攒够了就写进名称。
 *
 * @returns {{promoted:string|null, counts:object}}
 */
export function noteSelfNameCandidate(root, pid, { text = '', actorKey = '', names = [], selfIds = new Set(), now = Date.now() } = {}) {
  if (!addressesHer(text, { names, selfIds })) return { promoted: null, counts: {} }
  const candidates = extractVocatives(text, { names })
  if (!candidates.length) return { promoted: null, counts: {} }

  const state = readNameState(root, pid)
  const day = localIso(new Date(now)).slice(0, 10)
  let promoted = null

  for (const cand of candidates) {
    const cur = state.candidates[cand] ?? { actors: [], hits: 0, days: [], first: localIso(new Date(now)) }
    if (actorKey && !cur.actors.includes(String(actorKey))) cur.actors.push(String(actorKey))
    cur.hits = Number(cur.hits ?? 0) + 1
    if (!cur.days.includes(day)) cur.days.push(day)
    cur.last = localIso(new Date(now))
    state.candidates[cand] = cur

    const enough =
      cur.actors.length >= NAME_PROMOTE_MIN_ACTORS &&
      cur.hits >= NAME_PROMOTE_MIN_HITS &&
      cur.days.length >= NAME_PROMOTE_MIN_DAYS &&
      personaNameList(readCard(root, pid)?.card?.name ?? '').length < NAME_MAX_TOTAL

    if (enough && !promoted) {
      const card = readCard(root, pid)
      const next = `${card?.card?.name ?? ''} ${cand}`.trim()
      try {
        renameCard(root, pid, next)
        delete state.candidates[cand]
        promoted = cand
      } catch {
        /* 改名失败就继续攒着，不硬写 */
      }
    }
  }

  saveNameState(root, pid, state)
  return { promoted, counts: state.candidates }
}
