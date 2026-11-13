// test/p65.test.mjs —— 出站准入：模块要替她说话，必须先问过核心（协议 v1.6）。
//
// 为什么这条重要：协议 §1 第 4 条"模块不能自己决定发什么"在 v1.5 之前**没有执行点**。
// 回复是模型产生、模块投递的，模块拿到就发的话，静默时段/配额/黑白名单全被绕过去了。
import { test, before } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { scaffold } from '../src/core/scaffold.js'
import { createPerson, linkIdentity, writeProfile } from './helpers.mjs'
import { writeGlobalRules } from '../src/core/rules.js'
import { setAudienceMember, setAudienceMode } from '../src/core/audience.js'
import { requestEgress, readEgress } from '../src/core/egress.js'
import { moduleHandlers } from '../src/core/modules/wire.js'
import { ModuleService } from '../src/core/modules/service.js'
import { writeRegistry } from '../src/core/modules/registry.js'
import { recentRefusals } from '../src/core/rules.js'

const PID = 'yuanling'
let root
let person

before(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'yuanling-p65-'))
  scaffold(root, {})
  person = createPerson(root, { display: '小李' })
  linkIdentity(root, person.uid, { platform: 'qq', id: '40004' })
  writeProfile(root, PID, person.uid, { sketch: '小李' })
})

test('通过：场景是内部编号 → 放行，账本只记 hash/字节，不记正文', () => {
  const r = requestEgress(root, PID, {
    moduleId: 'fake-qq',
    channel: `private:${person.uid}`,
    text: '嗯，我在。',
  })
  assert.equal(r.ok, true)
  assert.ok(r.id)

  const rows = readEgress(root, PID)
  assert.equal(rows.length, 1)
  assert.equal(rows[0].channel, `private:${person.uid}`)
  assert.ok(rows[0].hash.startsWith('sha256:'))
  assert.equal(rows[0].bytes, Buffer.byteLength('嗯，我在。', 'utf8'))
  assert.equal(rows[0].text, undefined, '账本不存正文')
})

test('拒绝：外部号码当场景（E_BAD_SCENE）', () => {
  const r = requestEgress(root, PID, { moduleId: 'fake-qq', channel: 'private:10001', text: 'hi' })
  assert.equal(r.ok, false)
  assert.equal(r.code, 'E_BAD_SCENE')
})

test('拒绝：静默时段（E_REFUSED:quiet_hours）', () => {
  const h = new Date().getHours()
  writeGlobalRules(root, PID, { 'action.quiet_hours': [`${String(h).padStart(2, '0')}:00-${String((h + 1) % 24).padStart(2, '0')}:00`] })
  const r = requestEgress(root, PID, { moduleId: 'fake-qq', channel: `private:${person.uid}`, text: 'hi' })
  assert.equal(r.ok, false)
  assert.match(r.reason, /quiet_hours/)
  writeGlobalRules(root, PID, { 'action.quiet_hours': [] })
})

test('拒绝：黑名单里的人（audience:blacklisted）', () => {
  setAudienceMode(root, PID, 'people', 'deny')
  setAudienceMember(root, PID, 'people', person.uid, 'deny')
  const r = requestEgress(root, PID, { moduleId: 'fake-qq', channel: `private:${person.uid}`, text: 'hi' })
  assert.equal(r.ok, false)
  assert.match(r.reason, /audience:blacklisted/)
  setAudienceMode(root, PID, 'people', 'off')
  removeFrom(root, person.uid)
})

test('配额：每小时上限用完就拒（和主动开口共用一本账）', () => {
  const p = freshPerson('配额')
  writeGlobalRules(root, PID, { 'action.max_per_hour': 1, 'action.max_per_day': 20 })
  const ok = requestEgress(root, PID, { moduleId: 'fake-qq', channel: `private:${p.uid}`, text: '第一条' })
  assert.equal(ok.ok, true)
  const blocked = requestEgress(root, PID, { moduleId: 'fake-qq', channel: `private:${p.uid}`, text: '第二条' })
  assert.equal(blocked.ok, false)
  assert.match(blocked.reason, /max_per_hour/)
  writeGlobalRules(root, PID, { 'action.max_per_hour': 3 })
})

test('拒绝时正文不落盘，但拒绝原因进「拒绝记录」', () => {
  const p = freshPerson('拒绝')
  const before = readEgress(root, PID).length
  const h = new Date().getHours()
  writeGlobalRules(root, PID, { 'action.quiet_hours': [`${String(h).padStart(2, '0')}:00-${String((h + 1) % 24).padStart(2, '0')}:00`] })
  const r = requestEgress(root, PID, { moduleId: 'fake-qq', channel: `private:${p.uid}`, text: '这句话不该被留下' })
  assert.equal(r.ok, false)
  assert.equal(readEgress(root, PID).length, before, '被拒的消息不进账本')

  const hit = recentRefusals(root, { limit: 50 }).find((x) => x.dim === 'egress')
  assert.ok(hit, '应有一条 egress 维度的拒绝记录')
  assert.ok(!JSON.stringify(hit).includes('这句话不该留'), '拒绝记录也不该带正文')

  writeGlobalRules(root, PID, { 'action.quiet_hours': [] })
})

test('协议路径：假模块走 egress.request（能力门控：需要 send）', async () => {
  const p = freshPerson('协议')
  writeRegistry(root, { version: 1, modules: { 'fake-qq': { id: 'fake-qq', capabilities: ['send'], granted: [] } } })
  const svc = new ModuleService({ root, pid: PID, ...moduleHandlers({ root, pid: PID }) })
  await assert.rejects(
    svc.handleModuleRequest('fake-qq', { op: 'egress.request', data: { channel: `private:${p.uid}`, text: 'hi' } }),
    /能力未授予：send/,
  )

  writeRegistry(root, { version: 1, modules: { 'fake-qq': { id: 'fake-qq', capabilities: ['send'], granted: ['send'] } } })
  const r = await svc.handleModuleRequest('fake-qq', {
    op: 'egress.request',
    data: { channel: `private:${p.uid}`, text: '嗯，我在。' },
  })
  assert.equal(r.ok, true)
})

/** 每条用例自己造人：配额/名单都是按对象算的，共用一个人会互相干扰。 */
function freshPerson(tag) {
  const p = createPerson(root, { display: `${tag}${Math.random().toString(36).slice(2, 6)}` })
  linkIdentity(root, p.uid, { platform: 'qq', id: String(60000 + Math.floor(Math.random() * 9000)) })
  writeProfile(root, PID, p.uid, { sketch: tag })
  return p
}

function removeFrom(r, uid) {
  const rel = path.join(r, 'personas', PID, 'state', 'audience.json')
  const doc = JSON.parse(fs.readFileSync(rel, 'utf8'))
  doc.people.deny = doc.people.deny.filter((x) => x !== uid)
  fs.writeFileSync(rel, JSON.stringify(doc, null, 2), 'utf8')
}
