// src/core/catchup.js —— 切入补跑：切换人格后把游标追平。
//
// 为什么要补：raw 是共享的，一个人格离线这几天，世界还在往前走。
// 不补，它回来时看到的是断档的记忆；补太狠，切一次卡十秒。
// 所以：单次有上限，剩下的留给下一轮。
import path from 'node:path'
import { readJson, writeJsonAtomic, localIso } from './fsx.js'
import { P } from './paths.js'
import { listDays, readDay } from './raw.js'

export const CATCHUP_LIMIT = 200

export function cursorPath(root, pid) {
  return path.join(root, P.personas, pid, 'state', 'cursor.json')
}

export function readCursor(root, pid) {
  const j = readJson(cursorPath(root, pid), null)
  return j ?? { version: 1, extract: {}, promote: {}, raw_tail: null }
}

function writeCursor(root, pid, cursor, now = localIso()) {
  writeJsonAtomic(cursorPath(root, pid), { ...cursor, updated_at: now })
  return cursor
}

function keyOf(r) {
  return `${r.ts}|${r.id}`
}

/** 收集所有原始消息（只要 message，跳过 system 事件与墓碑）。 */
export function allMessages(root) {
  const out = []
  for (const date of listDays(root)) {
    for (const r of readDay(root, date)) {
      if ((r.type ?? 'message') !== 'message') continue
      if (!r.id) continue
      out.push(r)
    }
  }
  out.sort((a, b) => keyOf(a).localeCompare(keyOf(b)))
  return out
}

/**
 * 把游标追平（有上限）。
 * @returns {{processed:number, remaining:number, tail:string|null, done:boolean}}
 */
export function catchUp(root, pid, { limit = CATCHUP_LIMIT, now = localIso() } = {}) {
  const cursor = readCursor(root, pid)
  const since = cursor.raw_tail ?? ''
  const messages = allMessages(root)
  const pending = since ? messages.filter((m) => keyOf(m) > since) : messages

  const batch = pending.slice(0, Math.max(1, limit))
  if (batch.length) {
    cursor.raw_tail = keyOf(batch[batch.length - 1])
    cursor.catchup_at = now
    cursor.catchup_total = Number(cursor.catchup_total ?? 0) + batch.length
    writeCursor(root, pid, cursor, now)
  }

  return {
    processed: batch.length,
    remaining: Math.max(0, pending.length - batch.length),
    tail: cursor.raw_tail,
    done: pending.length <= batch.length,
  }
}

/** 只读：还剩多少没追。 */
export function catchUpStatus(root, pid) {
  const cursor = readCursor(root, pid)
  const since = cursor.raw_tail ?? ''
  const messages = allMessages(root)
  const pending = since ? messages.filter((m) => keyOf(m) > since) : messages
  return { pending: pending.length, tail: cursor.raw_tail, last: cursor.catchup_at ?? null }
}
