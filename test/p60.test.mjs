// test/p60.test.mjs —— 主动开口的决策层 + 原始层日链巡检。
//
// 用户定的（2026-11-10）：
//   · 内容 = 到期目的 + 模板拼句；
//   · **发在原话来的地方**：群里说的就发回那个群并 @ 说话人，私聊说的就发回那个人；
//   · 只产出待发队列，不真发送；`rules.action.*` 的闸门真的生效。
//   · 日链巡检：raw 被封存后被动过（哈希对不上）必须报出来。
import { test, before } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { scaffold } from '../src/core/scaffold.js'
import { appendRecord, sealDay, today } from '../src/core/raw.js'
import { localIso } from '../src/core/fsx.js'
import { writePurposes } from '../src/core/purposes.js'
import { adjustDrive } from '../src/core/drives.js'
import { writeGlobalRules } from '../src/core/rules.js'
import {
  planProactive,
  readOutbox,
  markSent,
  dropOutbox,
  startProactive,
  inQuietHours,
  PROACTIVE_MIN_DRIVE,
} from '../src/core/proactive.js'
import { diagnose } from '../src/core/diagnostics.js'
import { history } from '../src/core/version.js'

const PID = 'yuanling'
const HOUR = 3_600_000
let root

before(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'yuanling-p60-'))
  scaffold(root, {})
})

/** 造一条原始记录 + 一条挂在它上面的到期目的。 */
function seedPurpose({ channel = 'private:person_x', actor = { kind: 'member', id: '40004', name: '小李' }, fact = '我妈住院了', need = 'care', id = 'pur_1', ruleOff = false } = {}) {
  const rec = appendRecord(root, {
    source: 'qq',
    acct: '1',
    channel,
    actor,
    role: 'user',
    text: fact,
    ts: localIso(new Date(Date.now() - 10 * HOUR)),
  })
  const doc = readPurposesSafe()
  doc.items.push({
    id,
    need,
    text: `你上次说「${fact}」，后来怎么样了？`,
    origin: `${rec.file}#${rec.id}`,
    status: ruleOff ? 'done' : 'open',
    created: localIso(new Date(Date.now() - 10 * HOUR)),
    due: localIso(new Date(Date.now() - HOUR)),
    hits: 0,
    offered: 0,
  })
  writePurposes(root, PID, doc)
  return rec
}

function readPurposesSafe() {
  try {
    const j = JSON.parse(fs.readFileSync(path.join(root, 'personas', PID, 'self', 'purposes.json'), 'utf8'))
    return { version: 1, items: Array.isArray(j.items) ? j.items : [] }
  } catch {
    return { version: 1, items: [] }
  }
}

function raiseDrive(r = root, need = 'care', times = 3) {
  for (let i = 0; i < times; i += 1) adjustDrive(r, PID, { need, delta: 0.2, reason: '测试' })
}

test('门槛：动机不够强就不开口', () => {
  seedPurpose({ id: 'pur_low' })
  const r = planProactive(root, PID)
  assert.equal(r.queued.length, 0)
  assert.equal(readOutbox(root, PID).items.length, 0)
})

test('私聊来源：发回那个人的私聊，不带 @', () => {
  raiseDrive(root, 'care')
  const r = planProactive(root, PID)
  assert.equal(r.queued.length, 1)
  const it = readOutbox(root, PID).items[0]
  assert.equal(it.scene, 'private:person_x')
  assert.equal(it.target, null)
  assert.match(it.text, /我妈住院了/, '要复述对方说过的事')
  assert.ok(it.why, '每条都要能回答"为什么说这句"')
  assert.ok(it.origin?.startsWith('raw/'))
})

test('同一条目的不会重复入队', () => {
  const before = readOutbox(root, PID).items.length
  planProactive(root, PID)
  assert.equal(readOutbox(root, PID).items.length, before)
})

test('群来源 + 群里默认不许主动插话 → 压着（held），不产出', () => {
  const r2root = fs.mkdtempSync(path.join(os.tmpdir(), 'yuanling-p60b-'))
  scaffold(r2root, {})
  const rec = appendRecord(r2root, {
    source: 'qq', acct: '1', channel: 'group:grp_demo',
    actor: { kind: 'member', id: '30002', name: '老王' },
    role: 'user', text: '我面试没过，很难过', ts: localIso(new Date(Date.now() - 10 * HOUR)),
  })
  writePurposes(r2root, PID, {
    version: 1,
    items: [{ id: 'pur_g', need: 'care', text: 'x', origin: `${rec.file}#${rec.id}`, status: 'open', created: localIso(), due: localIso(new Date(Date.now() - HOUR)), hits: 0, offered: 0 }],
  })
  raiseDrive(r2root, 'care')

  const r = planProactive(r2root, PID)
  assert.equal(r.queued.length, 0)
  assert.deepEqual(r.held.map((h) => h.reason), ['group_proactive=false'])
  assert.equal(readOutbox(r2root, PID).items.length, 0, 'held 不该进队列')
})

test('群来源 + 允许群里开口 → 发回那个群，并 @ 说话的人', () => {
  const r2root = fs.mkdtempSync(path.join(os.tmpdir(), 'yuanling-p60c-'))
  scaffold(r2root, {})
  const rec = appendRecord(r2root, {
    source: 'qq', acct: '1', channel: 'group:grp_demo',
    actor: { kind: 'member', id: '30002', name: '老王' },
    role: 'user', text: '我面试没过，很难过', ts: localIso(new Date(Date.now() - 10 * HOUR)),
  })
  writePurposes(r2root, PID, {
    version: 1,
    items: [{ id: 'pur_g', need: 'care', text: 'x', origin: `${rec.file}#${rec.id}`, status: 'open', created: localIso(), due: localIso(new Date(Date.now() - HOUR)), hits: 0, offered: 0 }],
  })
  raiseDrive(r2root, 'care')
  writeGlobalRules(r2root, PID, { 'action.group_proactive': true })

  const r = planProactive(r2root, PID)
  assert.equal(r.queued.length, 1)
  const it = readOutbox(r2root, PID).items[0]
  assert.equal(it.scene, 'group:grp_demo')
  assert.deepEqual(it.target, { platform: 'qq', id: '30002', name: '老王' }, '群里要 @ 说话的人')
})

test('闸门：proactive=off 不产出；静默时段压着；每小时上限压着', () => {
  const r3root = fs.mkdtempSync(path.join(os.tmpdir(), 'yuanling-p60d-'))
  scaffold(r3root, {})
  const rec = appendRecord(r3root, {
    source: 'qq', acct: '1', channel: 'private:person_y',
    actor: { kind: 'member', id: '50005', name: '小张' },
    role: 'user', text: '我最近压力很大', ts: localIso(new Date(Date.now() - 10 * HOUR)),
  })
  writePurposes(r3root, PID, {
    version: 1,
    items: [{ id: 'pur_x', need: 'care', text: 'x', origin: `${rec.file}#${rec.id}`, status: 'open', created: localIso(), due: localIso(new Date(Date.now() - HOUR)), hits: 0, offered: 0 }],
  })
  raiseDrive(r3root, 'care')

  writeGlobalRules(r3root, PID, { 'action.proactive': 'off' })
  assert.equal(planProactive(r3root, PID).queued.length, 0, '关掉主动就不该产出')

  // 静默时段：把当前小时包住
  const h = new Date().getHours()
  writeGlobalRules(r3root, PID, { 'action.proactive': 'on', 'action.quiet_hours': [`${String(h).padStart(2, '0')}:00-${String((h + 1) % 24).padStart(2, '0')}:00`] })
  const r = planProactive(r3root, PID)
  assert.equal(r.queued.length, 0)
  assert.deepEqual(r.held.map((x) => x.reason), ['quiet_hours'])

  // 每小时上限
  writeGlobalRules(r3root, PID, { 'action.quiet_hours': [], 'action.max_per_hour': 1 })
  const first = planProactive(r3root, PID)
  assert.equal(first.queued.length, 1)
  const item = readOutbox(r3root, PID).items[0]
  markSent(r3root, PID, item.id)
  // 再给**同一个人**安排一条目的：按人计数时，这个人的配额已经用满 → held
  const rec2 = appendRecord(r3root, {
    source: 'qq', acct: '1', channel: 'private:person_y',
    actor: { kind: 'member', id: '50005', name: '小张' },
    role: 'user', text: '我今天很累', ts: localIso(new Date(Date.now() - 10 * HOUR)),
  })
  const doc = readPurposesSafeFor(r3root)
  doc.items.push({ id: 'pur_2', need: 'care', text: 'y', origin: `${rec2.file}#${rec2.id}`, status: 'open', created: localIso(), due: localIso(new Date(Date.now() - HOUR)), hits: 0, offered: 0 })
  writePurposes(r3root, PID, doc)
  const r2 = planProactive(r3root, PID)
  assert.equal(r2.queued.length, 0)
  assert.ok(r2.held.length >= 1)
  assert.ok(r2.held.every((x) => x.reason === 'max_per_hour'), JSON.stringify(r2.held))
})

function readPurposesSafeFor(r) {
  try {
    return JSON.parse(fs.readFileSync(path.join(r, 'personas', PID, 'self', 'purposes.json'), 'utf8'))
  } catch {
    return { version: 1, items: [] }
  }
}

test('静默时段解析：普通区间与跨零点都认', () => {
  const at = (h, m = 0) => new Date(2026, 10, 10, h, m)
  assert.equal(inQuietHours(['01:00-08:00'], at(2)), true)
  assert.equal(inQuietHours(['01:00-08:00'], at(9)), false)
  assert.equal(inQuietHours(['23:00-08:00'], at(23, 30)), true)
  assert.equal(inQuietHours(['23:00-08:00'], at(7, 59)), true)
  assert.equal(inQuietHours(['23:00-08:00'], at(12)), false)
})

test('取消：人不要她说这句 → dropped，记录还在', () => {
  const box = readOutbox(root, PID)
  const it = box.items[0]
  dropOutbox(root, PID, it.id, { reason: '不想她说' })
  const after = readOutbox(root, PID).items[0]
  assert.equal(after.status, 'dropped')
  assert.equal(after.drop_reason, '不想她说')
  assert.ok(history(root, `personas/${PID}/self/outbox.json`).length >= 1, '要能回看')
})

test('定时器：stop 之后不再跑', async () => {
  const r = fs.mkdtempSync(path.join(os.tmpdir(), 'yuanling-p60e-'))
  scaffold(r, {})
  let runs = 0
  const h = startProactive(r, { everyMinutes: 1, firstDelayMs: 5, onRun: () => (runs += 1) })
  await new Promise((res) => setTimeout(res, 60))
  h.stop()
  const after = runs
  await new Promise((res) => setTimeout(res, 120))
  assert.equal(runs, after)
  assert.ok(after >= 1)
})

// ── 原始层日链巡检 ──────────────────────────────────────────────────────

test('日链：未封存 → warn；封存后 → 通过；被改过 → error', () => {
  const r = fs.mkdtempSync(path.join(os.tmpdir(), 'yuanling-p60f-'))
  scaffold(r, {})
  appendRecord(r, {
    source: 'qq', acct: '1', channel: 'private:person_x',
    actor: { kind: 'owner', id: '1' }, role: 'user', text: 'hi', ts: localIso(),
  })
  const codes = () => (diagnose(r).items ?? []).filter((x) => x.code.startsWith('raw.')).map((x) => x.code)

  assert.deepEqual(codes(), ['raw.not-sealed'], '有数据但没封存 → 提示')

  sealDay(r, today())
  assert.deepEqual(codes(), [], '封存后应该通过')

  // 模拟"有人绕过只读改盘"
  const d = today()
  const dir = path.join(r, 'raw', d.slice(0, 7), d.slice(8))
  const f = path.join(dir, fs.readdirSync(dir).find((x) => x.endsWith('.ndjson')))
  fs.chmodSync(f, 0o666)
  fs.appendFileSync(f, JSON.stringify({ v: 2, id: 'tampered', text: '改过' }) + '\n', 'utf8')
  assert.ok(codes().includes('raw.chain-broken'), '被改过必须报出来')
})
