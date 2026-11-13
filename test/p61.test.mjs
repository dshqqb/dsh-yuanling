// test/p61.test.mjs —— 黑白名单：只影响"她回不回话"，不影响接收。
//
// 用户定的（2026-11-10，Q21=A）：
//   · 白名单开 → 只跟名单上的人/群说话；黑名单开 → 除名单外都行；都关 = 不限制（互斥）；
//   · 管理员 / 重要人物 / 重点群体**永远在白名单里**，且不能被设为黑名单（动态豁免）；
//   · raw 与记忆完全不受影响：她照样收、照样记，只是不回。
import { test, before } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { scaffold } from '../src/core/scaffold.js'
import { createPerson, linkIdentity, writeProfile, readProfile, setAdmin } from './helpers.mjs'
import { createGroupWithCard, setGroupTier } from '../src/core/groups.js'
import { setPinned } from './helpers.mjs'
import {
  canReply,
  setAudienceMode,
  setAudienceMember,
  removeAudienceMember,
  readAudience,
  audienceView,
  isExempt,
} from '../src/core/audience.js'
import { ingest } from '../src/core/inbox.js'
import { listEntries } from '../src/core/memory.js'
import { appendRecord } from '../src/core/raw.js'
import { localIso } from '../src/core/fsx.js'
import { writePurposes } from '../src/core/purposes.js'
import { adjustDrive } from '../src/core/drives.js'
import { planProactive, readOutbox } from '../src/core/proactive.js'

const PID = 'yuanling'
const HOUR = 3_600_000
let root
let alice
let bob
let boss

before(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'yuanling-p61-'))
  scaffold(root, {})
  alice = createPerson(root, { display: '阿甲' })
  linkIdentity(root, alice.uid, { platform: 'qq', id: '10001' })
  writeProfile(root, PID, alice.uid, { sketch: '甲' })
  bob = createPerson(root, { display: '阿乙' })
  linkIdentity(root, bob.uid, { platform: 'qq', id: '10002' })
  writeProfile(root, PID, bob.uid, { sketch: '乙' })
  boss = createPerson(root, { display: '管理员' })
  linkIdentity(root, boss.uid, { platform: 'qq', id: '10003' })
  writeProfile(root, PID, boss.uid, {})
  setAdmin(root, boss.uid)
})

test('默认不限制：没有开关时谁都能回', () => {
  assert.equal(readAudience(root, PID).people.mode, 'off')
  assert.deepEqual(canReply(root, PID, 'people', bob.uid), { allowed: true, mode: 'off', reason: 'off' })
})

test('白名单开：名单上的能回，不在名单上的不回', () => {
  setAudienceMode(root, PID, 'people', 'allow')
  setAudienceMember(root, PID, 'people', alice.uid, 'allow')
  assert.equal(canReply(root, PID, 'people', alice.uid).allowed, true)
  assert.equal(canReply(root, PID, 'people', bob.uid).allowed, false)
  assert.equal(canReply(root, PID, 'people', bob.uid).reason, 'not-in-allowlist')
})

test('管理员 / 重要人物永远在白名单里（动态豁免，不写文件）', () => {
  assert.equal(canReply(root, PID, 'people', boss.uid).allowed, true)
  assert.equal(canReply(root, PID, 'people', boss.uid).reason, 'exempt')
  // 阿乙设为重点后也自动豁免
  setPinned(root, PID, bob.uid, true)
  assert.equal(canReply(root, PID, 'people', bob.uid).allowed, true)
  assert.equal(isExempt(root, PID, 'people', bob.uid), true)
  // 取消重点就没了
  setPinned(root, PID, bob.uid, false)
  assert.equal(canReply(root, PID, 'people', bob.uid).allowed, false)
})

test('豁免对象不能进黑名单（硬规则）', () => {
  assert.throws(() => setAudienceMember(root, PID, 'people', boss.uid, 'deny'), /永远在白名单/)
  setPinned(root, PID, bob.uid, true)
  assert.throws(() => setAudienceMember(root, PID, 'people', bob.uid, 'deny'), /永远在白名单/)
  setPinned(root, PID, bob.uid, false)
})

test('黑名单开：名单内的不回，名单外的都行', () => {
  setAudienceMode(root, PID, 'people', 'deny')
  setAudienceMember(root, PID, 'people', bob.uid, 'deny')
  assert.equal(canReply(root, PID, 'people', bob.uid).allowed, false)
  assert.equal(canReply(root, PID, 'people', bob.uid).reason, 'blacklisted')
  assert.equal(canReply(root, PID, 'people', alice.uid).allowed, true)
  assert.equal(canReply(root, PID, 'people', boss.uid).allowed, true, '管理员仍然豁免')
})

test('名单互斥：设进一边会自动从另一边移除', () => {
  setAudienceMember(root, PID, 'people', bob.uid, 'allow')
  const doc = readAudience(root, PID)
  assert.ok(doc.people.allow.includes(bob.uid))
  assert.ok(!doc.people.deny.includes(bob.uid))

  setAudienceMember(root, PID, 'people', bob.uid, 'deny')
  const doc2 = readAudience(root, PID)
  assert.ok(doc2.people.deny.includes(bob.uid))
  assert.ok(!doc2.people.allow.includes(bob.uid))

  removeAudienceMember(root, PID, 'people', bob.uid)
  const doc3 = readAudience(root, PID)
  assert.ok(!doc3.people.allow.includes(bob.uid) && !doc3.people.deny.includes(bob.uid))
})

test('模式互斥：开白名单会关掉黑名单（反之亦然），都关 = off', () => {
  setAudienceMode(root, PID, 'people', 'allow')
  assert.equal(readAudience(root, PID).people.mode, 'allow')
  setAudienceMode(root, PID, 'people', 'deny')
  assert.equal(readAudience(root, PID).people.mode, 'deny')
  setAudienceMode(root, PID, 'people', 'off')
  assert.equal(readAudience(root, PID).people.mode, 'off')
})

test('群体：同一套规则，重点群体豁免', () => {
  const g1 = createGroupWithCard(root, PID, { name: '甲群', accountText: 'QQ群 900001' })
  const g2 = createGroupWithCard(root, PID, { name: '乙群', accountText: 'QQ群 900002' })

  setAudienceMode(root, PID, 'groups', 'allow')
  setAudienceMember(root, PID, 'groups', g1.gid, 'allow')
  assert.equal(canReply(root, PID, 'groups', g1.gid).allowed, true)
  assert.equal(canReply(root, PID, 'groups', g2.gid).allowed, false)

  setGroupTier(root, PID, g2.gid, 'important')
  assert.equal(canReply(root, PID, 'groups', g2.gid).allowed, true, '重点群体自动豁免')
  assert.throws(() => setAudienceMember(root, PID, 'groups', g2.gid, 'deny'), /永远在白名单/)

  const view = audienceView(root, PID, 'groups')
  assert.equal(view.mode, 'allow')
  assert.ok(view.auto.some((x) => x.id === g2.gid), '自动豁免的群要单独列出来')
})

test('先加白名单、后来升成重要人物：从 allow 移到「自动」，不再挂 ×', () => {
  const r = fs.mkdtempSync(path.join(os.tmpdir(), 'yuanling-p61c-'))
  scaffold(r, {})
  const p = createPerson(r, { display: '先白后重' })
  linkIdentity(r, p.uid, { platform: 'qq', id: '30001' })
  writeProfile(r, PID, p.uid, { sketch: 'x' })

  setAudienceMode(r, PID, 'people', 'allow')
  setAudienceMember(r, PID, 'people', p.uid, 'allow')
  assert.ok(audienceView(r, PID, 'people').allow.some((x) => x.id === p.uid))

  setPinned(r, PID, p.uid, true)
  const view = audienceView(r, PID, 'people')
  assert.ok(!view.allow.some((x) => x.id === p.uid), '豁免之后不该再出现在手动白名单里')
  assert.ok(view.auto.some((x) => x.id === p.uid && x.exempt), '应该在「自动」那一组')
})

test('没有档案的人也能设为重点（人替她做判断，不该被"先认识他"挡住）', () => {
  const r = fs.mkdtempSync(path.join(os.tmpdir(), 'yuanling-p61d-'))
  scaffold(r, {})
  const p = createPerson(r, { display: '没档案' })
  linkIdentity(r, p.uid, { platform: 'qq', id: '30002' })

  setPinned(r, PID, p.uid, true)
  assert.equal(readProfile(r, PID, p.uid).pinned, true)
  assert.equal(canReply(r, PID, 'people', p.uid).reason, 'exempt')
})

test('接收信息不受影响：白名单外的人发消息，raw 照记、记忆照长', () => {
  setAudienceMode(root, PID, 'people', 'allow')
  // 只放阿甲，不放阿乙
  setAudienceMember(root, PID, 'people', alice.uid, 'allow')
  const before = listEntries(root, PID).flatMap((e) => e.facts ?? []).length

  ingest(root, {
    v: 1,
    source: 'qq',
    acct: '1',
    items: [{ ts: localIso(), channel: `private:${bob.uid}`, kind: 'msg', actor: { kind: 'member', id: '10002', name: '阿乙' }, text: '我叫阿乙，我特别喜欢喝咖啡' }],
  })

  const after = listEntries(root, PID).flatMap((e) => e.facts ?? [])
  assert.ok(after.length > before, '黑名单不该拦住"记住"')
  const hasCoffee = after.some((f) => String(f.text).includes('咖啡'))
  assert.equal(hasCoffee, true, '事实照常提炼')

  // raw 里也有这条
  const today = localIso().slice(0, 10)
  const dir = path.join(root, 'raw', today.slice(0, 7), today.slice(8))
  const text = fs.readdirSync(dir).map((f) => fs.readFileSync(path.join(dir, f), 'utf8')).join('\n')
  assert.match(text, /咖啡/)
})

test('主动开口：目标在黑名单里 → 压着不排', () => {
  const r = fs.mkdtempSync(path.join(os.tmpdir(), 'yuanling-p61b-'))
  scaffold(r, {})
  const p = createPerson(r, { display: '阿丙' })
  linkIdentity(r, p.uid, { platform: 'qq', id: '20001' })
  writeProfile(r, PID, p.uid, { sketch: '丙' })

  const rec = appendRecord(r, {
    source: 'qq', acct: '1', channel: `private:${p.uid}`,
    actor: { kind: 'member', id: '20001', name: '阿丙' },
    role: 'user', text: '我妈住院了', ts: localIso(new Date(Date.now() - 10 * HOUR)),
  })
  writePurposes(r, PID, {
    version: 1,
    items: [{ id: 'pur_a', need: 'care', text: 'x', origin: `${rec.file}#${rec.id}`, status: 'open', created: localIso(), due: localIso(new Date(Date.now() - HOUR)), hits: 0, offered: 0 }],
  })
  for (let i = 0; i < 3; i += 1) adjustDrive(r, PID, { need: 'care', delta: 0.2, reason: 't' })

  setAudienceMode(r, PID, 'people', 'deny')
  setAudienceMember(r, PID, 'people', p.uid, 'deny')

  const out = planProactive(r, PID)
  assert.equal(out.queued.length, 0, '黑名单里的人不该收到她主动的话')
  assert.ok(out.held.some((h) => String(h.reason).startsWith('audience:')))
  assert.equal(readOutbox(r, PID).items.length, 0)
})
