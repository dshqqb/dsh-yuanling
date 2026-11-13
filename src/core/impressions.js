// src/core/impressions.js —— "我对某人 / 某个地方的印象"的唯一写入口。
//
// 人物和群体走**同一套**逻辑（用户明确要求两边一致）：
//   ① 整段覆盖：印象是"现在怎么看他"，不是日记。增量拼接会越写越长、
//      旧印象又删不掉，最后被预算截在半句话上——那是流水账，不是印象。
//   ② 旧版本只留在版本历史里（`versions/`），随时能回滚。
//   ③ 每次写必须记下"为什么改"，模型下次能读回自己的印象是怎么变的。
//   ④ 硬上限 600 字节（就是注入预算）：超了**直接拒**，不静默截断。
//
// 这一层只管"那段话"：人物存 `sketch`，群体存 `feature`。
// 身份（账号归属）走 entities.js，成员走 groups.js，不在这里。
import { history, readBlob } from './version.js'
import { personProfileRel, readProfile, writeProfile } from './entities.js'
import { groupRel, readGroup, writeGroup } from './groups.js'
import { resolvePointer } from './pointer.js'

/** 印象的硬上限，和注入侧的人/群卡预算一致。 */
export const IMPRESSION_MAX_BYTES = 600

const SIDES = {
  person: {
    label: '人物',
    rel: (pid, id) => personProfileRel(pid, id),
    read: (root, pid, id) => readProfile(root, pid, id),
    write: (root, pid, id, patch, opts) => writeProfile(root, pid, id, patch, opts),
    field: 'sketch',
    missing: (id) => `还没有 ${id} 的人物档案——先建账户卡（yuanling_account），再写印象`,
  },
  group: {
    label: '群体',
    rel: (pid, id) => groupRel(pid, id),
    read: (root, pid, id) => readGroup(root, pid, id),
    write: (root, pid, id, patch, opts) => writeGroup(root, pid, id, patch, opts),
    field: 'feature',
    missing: (id) => `还没有 ${id} 这个群体——它在收到第一条群消息（或开机回填）之后才存在`,
  },
}

function sideOf(kind) {
  const side = SIDES[String(kind ?? '')]
  if (!side) throw new Error(`kind 只能是 person 或 group，收到的是：${kind}`)
  return side
}

/**
 * 读现在的印象。
 * @returns {{kind,id,field,text,bytes,updatedAt}|null}
 */
export function readImpression(root, pid, kind, id) {
  const side = sideOf(kind)
  const cur = side.read(root, pid, id)
  if (!cur) return null
  const text = String(cur[side.field] ?? '')
  return {
    kind: String(kind),
    id: String(id),
    field: side.field,
    text,
    bytes: Buffer.byteLength(text, 'utf8'),
    updatedAt: cur.updated_at ?? null,
  }
}

/**
 * 写一次印象：整段覆盖 + 记原因 + 进版本历史。
 *
 * `reason` 必填——"为什么改"就是这段记忆的出处；没有理由的改动，
 * 下次读历史只会看到一串没头没尾的文本。
 * `evidence` 可选，给了就必须能解析到真实记录（和 addFact 同一条硬规则）。
 *
 * @returns {{kind,id,changed,before,after,reason,actor,impression}}
 */
export function setImpression(root, pid, kind, id, { text, reason, evidence = null, actor = 'model:observe' } = {}) {
  const side = sideOf(kind)
  const cur = side.read(root, pid, id)
  if (!cur) throw new Error(side.missing(id))

  const body = String(text ?? '').trim()
  if (!body) throw new Error('印象不能为空——真要表达"还没什么印象"，就写一句那样的话')
  const bytes = Buffer.byteLength(body, 'utf8')
  if (bytes > IMPRESSION_MAX_BYTES) {
    throw new Error(
      `印象太长：${bytes} 字节 > ${IMPRESSION_MAX_BYTES}。这是注入预算，写超了也会被截断，所以干脆不写——删掉细节再试`,
    )
  }

  const why = String(reason ?? '').trim()
  if (!why) throw new Error('必须写一句 reason：这次为什么改这条印象')

  let evOk = null
  if (evidence) {
    const p = String(evidence).trim()
    if (p) {
      const r = resolvePointer(root, p)
      if (!r.ok) throw new Error(`证据指针用不了：${p}（${r.reason ?? '解析失败'}）`)
      evOk = p
    }
  }

  const fullReason = evOk ? `${why}（证据：${evOk}）` : why
  const before = String(cur[side.field] ?? '')

  // 内容没变就**真的不写**。
  //
  // 以前这里是无条件 side.write：`writeProfile` 每次都会把 `updated_at` 改成当前时间，
  // 于是"同样的文本"也能拼出一个内容不同的文件 → 写盘 → 版本历史里多一条假记录。
  // 它之所以多数时候没暴露，是因为时间戳只到秒：同一秒内两次写出来的 JSON 一模一样，
  // hash 相同才被 writeTracked 的幂等挡掉。一旦跨过秒边界（机器忙的时候特别容易），
  // 就会凭空长出一条"内容没变"的版本。这就是那个偶发失败的根因。
  if (before === body) {
    return {
      kind: String(kind),
      id: String(id),
      changed: false,
      before,
      after: body,
      reason: fullReason,
      actor,
      impression: readImpression(root, pid, kind, id),
    }
  }

  side.write(root, pid, id, { [side.field]: body, __reason: fullReason }, { actor, reason: fullReason })

  return {
    kind: String(kind),
    id: String(id),
    changed: true,
    before,
    after: body,
    reason: fullReason,
    actor,
    impression: readImpression(root, pid, kind, id),
  }
}

/**
 * 印象的演变：从版本历史里把每一版的"那段话 + 为什么 + 谁写的"按时间取出来。
 * 这是模型能回答"我对他的印象是怎么变成现在这样的"的依据。
 *
 * @returns {{total:number, entries:Array<{at,actor,reason,text}>}}
 */
export function impressionHistory(root, pid, kind, id, { limit = 10 } = {}) {
  const side = sideOf(kind)
  const rel = side.rel(pid, id)
  const rows = []
  for (const e of history(root, rel)) {
    const buf = readBlob(root, rel, e.hash)
    if (!buf) continue
    let obj = null
    try {
      obj = JSON.parse(buf.toString('utf8'))
    } catch {
      continue
    }
    rows.push({ at: e.ts, actor: e.actor ?? '', reason: e.reason ?? '', text: String(obj?.[side.field] ?? '') })
  }
  const n = Math.max(1, Number(limit) || 10)
  return { total: rows.length, entries: rows.slice(-n) }
}

/** 把印象渲染成给人/模型看的一段纯文本（CLI 与 MCP 共用）。 */
export function renderImpression(root, pid, kind, id, { withHistory = false, limit = 10 } = {}) {
  const side = sideOf(kind)
  const cur = readImpression(root, pid, kind, id)
  if (!cur) return side.missing(id)

  const lines = [`[${side.label}] ${id} · ${cur.bytes}/${IMPRESSION_MAX_BYTES} 字节${cur.updatedAt ? ` · 更新于 ${cur.updatedAt}` : ''}`]
  lines.push(cur.text ? cur.text : '（还是空的）')

  if (withHistory) {
    const h = impressionHistory(root, pid, kind, id, { limit })
    if (!h.total) {
      lines.push('', '（没有历史：这版就是最初的）')
    } else {
      lines.push('', `印象的变化（最近 ${h.entries.length}/${h.total} 版）：`)
      h.entries.forEach((e, i) => {
        lines.push(`${i + 1}. ${String(e.at).replace('T', ' ').slice(0, 16)}  ${e.actor || '未知'}  ${e.reason || '（没写原因）'}`)
        const t = e.text ? e.text.replace(/\s+/g, ' ').slice(0, 120) : '（空）'
        lines.push(`   ${t}`)
      })
    }
  }
  return lines.join('\n')
}
