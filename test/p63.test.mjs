// test/p63.test.mjs —— 主动开口闭环：outbox.fetch / outbox.ack（协议 v1.5）。
//
// 用户 2026-11-10 定的 A：队列由核心算，**模块来取、模块回报**——
// 因为"说没说出去"只有模块知道，核心不能假设。
//
// 要钉住的四条：
//   ① 取出即 claimed，不直接 sent；只有 ack 才算数；
//   ② 交给模块前重新过闸门（静默时段 / 名单 / 主动开关 / 配额）；
//   ③ ok:false 回 pending 重试，连续失败 3 次自动 dropped；
//   ④ 领了不 ack 会超时回收，队列不能永久卡住。
import { test, before } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { scaffold } from '../src/core/scaffold.js'
import { appendRecord } from '../src/core/raw.js'
import { localIso } from '../src/core/fsx.js'
import { createPerson, linkIdentity, writeProfile } from './helpers.mjs'
import { writePurposes } from '../src/core/purposes.js'
import { adjustDrive } from '../src/core/drives.js'
import { writeGlobalRules } from '../src/core/rules.js'
import { setAudienceMode, setAudienceMember } from '../src/core/audience.js'
import {
  planProactive,
  readOutbox,
  claimOutbox,
  ackOutbox,
  releaseStaleClaims,
  OUTBOX_MAX_ATTEMPTS,
  OUTBOX_CLAIM_TTL_MS,
} from '../src/core/proactive.js'
import { ModuleService } from '../src/core/modules/service.js'
import { writeRegistry } from '../src/core/modules/registry.js'

const PID = 'yuanling'
const HOUR = 3_600_000
const DAY = 86_400_000

let root
let person

before(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'yuanling-p63-'))
  scaffold(root, {})
  writeGlobalRules(root, PID, { 'action.quiet_hours': [] })
  person = createPerson(root, { display: '小李' })
  linkIdentity(root, person.uid, { platform: 'qq', id: '40004' })
  writeProfile(root, PID, person.uid, { sketch: '小李' })

  // 造一条 10 小时前的私聊 + 挂在它上面的到期目的
  const rec = appendRecord(root, {
    source: 'qq',
    acct: '1',
    channel: `private:${person.uid}`,
    actor: { kind: 'member', id: '40004', name: '小李' },
    role: 'user',
    text: '我妈住院了',
    ts: localIso(new Date(Date.now() - 10 * HOUR)),
  })
  writePurposes(root, PID, {
    version: 1,
    items: [
      {
        id: 'pur_1',
        need: 'care',
        text: '你上次说「我妈住院了」，后来怎么样了？',
        origin: `${rec.file}#${rec.id}`,
        status: 'open',
        created: localIso(new Date(Date.now() - 10 * HOUR)),
        due: localIso(new Date(Date.now() - HOUR)),
        hits: 0,
        offered: 0,
      },
    ],
  })
  for (let i = 0; i < 3; i += 1) adjustDrive(root, PID, { need: 'care', delta: 0.2, reason: '测试' })
  planProactive(root, PID)
})

test('队列里先有一条 pending（核心算出来，还没交给任何人）', () => {
  const box = readOutbox(root, PID)
  assert.equal(box.items.length, 1)
  assert.equal(box.items[0].status, 'pending')
})

test('fetch：取出即 claimed，内容对模块可见，但不含内部记账字段', () => {
  const items = claimOutbox(root, PID, { limit: 5, claimBy: 'fake-qq' })
  assert.equal(items.length, 1)
  assert.equal(items[0].channel, `private:${person.uid}`)
  assert.match(items[0].text, /我妈住院了/)
  assert.ok(items[0].id)
  // 内部字段不外泄
  for (const k of ['claimed_at', 'claim_by', 'attempts', 'origin']) assert.equal(items[0][k], undefined, k)

  const box = readOutbox(root, PID)
  assert.equal(box.items[0].status, 'claimed')
  assert.equal(box.items[0].claim_by, 'fake-qq')
  assert.equal(box.items[0].attempts, 1)
})

test('同一条不会被取两次', () => {
  assert.equal(claimOutbox(root, PID).length, 0)
})

test('ack：说成了 → sent（记时间与投递者）', () => {
  const [it] = readOutbox(root, PID).items
  const r = ackOutbox(root, PID, it.id, { ok: true, claimBy: 'fake-qq' })
  assert.equal(r.status, 'sent')
  const after = readOutbox(root, PID).items[0]
  assert.equal(after.status, 'sent')
  assert.ok(after.sent_at)
  assert.equal(after.delivered_by, 'fake-qq')
})

test('ack：状态不对要拒绝（没 fetch 就 ack = 撒谎）', () => {
  const [it] = readOutbox(root, PID).items
  assert.throws(() => ackOutbox(root, PID, it.id, { ok: true }), /不在"已领取"状态/)
})

test('ok:false → 回 pending；连续失败到上限才 dropped', () => {
  // 再造两条，手工走 3 轮失败
  planAgain()
  const box = readOutbox(root, PID)
  const pending = box.items.filter((x) => x.status === 'pending')
  assert.ok(pending.length >= 1)
  const id = pending[0].id

  const seen = []
  for (let i = 0; i < OUTBOX_MAX_ATTEMPTS; i += 1) {
    const got = claimOutbox(root, PID, { claimBy: 'fake-qq' })
    if (!got.length) break
    const target = got.find((x) => x.id === id) ?? got[0]
    const r = ackOutbox(root, PID, target.id, { ok: false, code: 'rate_limited', message: '被限流' })
    seen.push(r.status)
  }
  assert.ok(seen.includes('pending') || seen.includes('dropped'))
  assert.equal(seen[seen.length - 1], 'dropped', `应到上限才放弃：${seen.join(' → ')}`)
  const dead = readOutbox(root, PID).items.find((x) => x.id === id)
  assert.equal(dead.status, 'dropped')
  assert.match(dead.drop_reason, /发送失败/)
})

test('领了不 ack → 超时回收成 pending（不会永久卡住）', () => {
  planAgain()
  const id = readOutbox(root, PID).items.find((x) => x.status === 'pending').id
  claimOutbox(root, PID, { claimBy: 'crashed-module' })
  assert.equal(readOutbox(root, PID).items.find((x) => x.id === id).status, 'claimed')

  releaseStaleClaims(root, PID, { now: Date.now() + OUTBOX_CLAIM_TTL_MS + 1000 })
  const back = readOutbox(root, PID).items.find((x) => x.id === id)
  assert.equal(back.status, 'pending')
  assert.equal(back.last_error, 'claim-timeout')
})

test('交给模块之前重新过闸门：黑名单里的人不会被交出去', () => {
  planAgain()
  setAudienceMode(root, PID, 'people', 'deny')
  setAudienceMember(root, PID, 'people', person.uid, 'deny')
  const got = claimOutbox(root, PID)
  assert.ok(
    !got.some((x) => x.channel === `private:${person.uid}`),
    '被拉黑的对象不该被交出去（别人可以）',
  )
  setAudienceMode(root, PID, 'people', 'off')
  removeFromDeny()
})

test('交给模块之前重新过闸门：静默时段不交', () => {
  planAgain()
  const h = new Date().getHours()
  writeGlobalRules(root, PID, { 'action.quiet_hours': [`${String(h).padStart(2, '0')}:00-${String((h + 1) % 24).padStart(2, '0')}:00`] })
  assert.equal(claimOutbox(root, PID).length, 0)
  writeGlobalRules(root, PID, { 'action.quiet_hours': [] })
})

test('协议路径：假模块通过 outbox.fetch / outbox.ack 走通（能力门控）', async () => {
  planAgain()
  const svc = new ModuleService({
    root,
    pid: PID,
    onOutboxFetch: ({ id, data }) => ({ version: 1, items: claimOutbox(root, PID, { limit: data?.limit, claimBy: id }) }),
    onOutboxAck: ({ id, data }) => ackOutbox(root, PID, data.id, { ok: data.ok === true, claimBy: id }),
  })

  // 没授予 → E_NO_CAP
  writeRegistry(root, { version: 1, modules: { 'fake-qq': { id: 'fake-qq', capabilities: ['outbox'], granted: [] } } })
  await assert.rejects(svc.handleModuleRequest('fake-qq', { op: 'outbox.fetch', data: {} }), /能力未授予：outbox/)

  // 授予之后照常
  writeRegistry(root, { version: 1, modules: { 'fake-qq': { id: 'fake-qq', capabilities: ['outbox'], granted: ['outbox'] } } })
  const fetched = await svc.handleModuleRequest('fake-qq', { op: 'outbox.fetch', data: { limit: 1 } })
  assert.equal(fetched.version, 1)
  assert.equal(fetched.items.length, 1)
  const acked = await svc.handleModuleRequest('fake-qq', { op: 'outbox.ack', data: { id: fetched.items[0].id, ok: true } })
  assert.equal(acked.status, 'sent')
})

// ── 小工具 ────────────────────────────────────────────────────────────

/** 再往队列里塞一条：换个人、换条目的。 */
function planAgain() {
  const someone = createPerson(root, { display: `补充${Math.random().toString(36).slice(2, 6)}` })
  linkIdentity(root, someone.uid, { platform: 'qq', id: String(50000 + Math.floor(Math.random() * 9000)) })
  writeProfile(root, PID, someone.uid, { sketch: 'x' })
  const rec = appendRecord(root, {
    source: 'qq',
    acct: '1',
    channel: `private:${someone.uid}`,
    actor: { kind: 'member', id: '50001', name: '某人' },
    role: 'user',
    text: '我最近压力很大',
    ts: localIso(new Date(Date.now() - 10 * HOUR)),
  })
  const doc = JSON.parse(fs.readFileSync(path.join(root, 'personas', PID, 'self', 'purposes.json'), 'utf8'))
  doc.items.push({
    id: `pur_${Math.random().toString(36).slice(2, 10)}`,
    need: 'care',
    text: '你上次说「压力很大」，后来怎么样了？',
    origin: `${rec.file}#${rec.id}`,
    status: 'open',
    created: localIso(new Date(Date.now() - 10 * HOUR)),
    due: localIso(new Date(Date.now() - HOUR)),
    hits: 0,
    offered: 0,
  })
  writePurposes(root, PID, doc)
  planProactive(root, PID)
}

function removeFromDeny() {
  const rel = path.join(root, 'personas', PID, 'state', 'audience.json')
  const doc = JSON.parse(fs.readFileSync(rel, 'utf8'))
  doc.people.deny = []
  fs.writeFileSync(rel, JSON.stringify(doc, null, 2), 'utf8')
}
