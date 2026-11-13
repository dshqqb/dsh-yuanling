// test/p56.test.mjs —— 人物/群体页重做：权重只读、重点按名次、新增、温柔开关。
//
// 口径（用户 2026-11-10 定）：
//   · 普通名单：互动分 0–100，**不能手改**
//   · 重点名单：按名次 110 起（最后一名 110，往上每名 +5），永远排在普通人前面
//   · 落盘权重一直保留：取消重点后立刻回来
//   · 新建人物/群体默认 50；一次互动都没有时不会被抹成 0
import { test, before } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { scaffold } from '../src/core/scaffold.js'
import { appendRecord } from '../src/core/raw.js'
import { localIso } from '../src/core/fsx.js'
import {
  createPerson,
  linkIdentity,
  writeProfile,
  readProfile,
  setPinned,
  movePinned,
  pinnedPeople,
  setAdmin,
} from '../src/core/entities.js'
import { createAccountWithPerson, labelOfPerson, loadPersons } from '../src/core/accounts.js'
import { pinWeight, effectivePersonWeight, SEED_WEIGHT } from '../src/core/weights.js'
import {
  createGroupWithCard,
  parseGroupAccountText,
  setGroupTier,
  moveGroupPinned,
  listGroups,
  readGroup,
  ensureGroupScene,
} from '../src/core/groups.js'
import { readPrefs, writePrefs } from '../src/core/prefs.js'
import { personaExtraLines } from '../src/core/memory.js'

const PID = 'yuanling'
let root

before(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'yuanling-p56-'))
  scaffold(root, {})
})

test('量程：普通 0–100，重点从 110 起、每名 +5', () => {
  assert.equal(SEED_WEIGHT, 50)
  assert.equal(pinWeight(0, 1), 110, '只有一个人时就是 110')
  assert.equal(pinWeight(2, 3), 110, '三个人时最后一名 110')
  assert.equal(pinWeight(1, 3), 115)
  assert.equal(pinWeight(0, 3), 120)
})

test('生效权重：重点用名次分，普通用落盘分；落盘值始终保留', () => {
  const prof = { weight: 37, pinned: true, pin_rank: 1 }
  const eff = effectivePersonWeight(prof, { totalPinned: 3 })
  assert.equal(eff.weight, 115)
  assert.equal(eff.kind, 'pinned')
  assert.equal(eff.stored, 37, '落盘值不能被抹掉')

  const plain = effectivePersonWeight({ weight: 37, pinned: false })
  assert.equal(plain.weight, 37)
  assert.equal(plain.kind, 'auto')
})

test('新建账户：自动建人物；新账户权重 0；素描可写', () => {
  const r = createAccountWithPerson(root, PID, { platform: 'qq', nativeId: '10010', nickname: '小明' })
  writeProfile(root, PID, r.person, { sketch: '话少' })
  const prof = readProfile(root, PID, r.person)
  assert.equal(prof.weight, 0, '账户还没互动，人物权重从 0 起')
  assert.equal(prof.sketch, '话少')
})

test('重点名单：设为重点 → 名次 0；再设一个 → 名次 1；取消后名次不留空洞', () => {
  const a = createPerson(root, { display: 'A' })
  linkIdentity(root, a.uid, { platform: 'qq', id: '20001' })
  writeProfile(root, PID, a.uid, { weight: 12 })
  const b = createPerson(root, { display: 'B' })
  linkIdentity(root, b.uid, { platform: 'qq', id: '20002' })
  writeProfile(root, PID, b.uid, { weight: 80 })

  setPinned(root, PID, a.uid, true)
  setPinned(root, PID, b.uid, true)
  assert.deepEqual(pinnedPeople(root, PID), [a.uid, b.uid], '先设的排在前面')

  movePinned(root, PID, b.uid, 'up')
  assert.deepEqual(pinnedPeople(root, PID), [b.uid, a.uid])

  // 取消 a：b 仍然是第 0 名，不该留个空洞
  setPinned(root, PID, a.uid, false)
  assert.deepEqual(pinnedPeople(root, PID), [b.uid])
  assert.equal(readProfile(root, PID, b.uid).pin_rank, 0)

  // 取消重点后回到落盘权重
  assert.equal(readProfile(root, PID, a.uid).weight, 12)
})

test('聚焦顺序真的改权重：往上挪一格，权重从 110 变 115', () => {
  const c = createPerson(root, { display: 'C' })
  linkIdentity(root, c.uid, { platform: 'qq', id: '20003' })
  writeProfile(root, PID, c.uid, { weight: 5 })
  setPinned(root, PID, c.uid, true)

  const list = pinnedPeople(root, PID)
  const rank = list.indexOf(c.uid)
  const total = list.length
  const beforeW = effectivePersonWeight(readProfile(root, PID, c.uid), { totalPinned: total }).weight

  if (rank > 0) {
    movePinned(root, PID, c.uid, 'up')
    const afterW = effectivePersonWeight(readProfile(root, PID, c.uid), { totalPinned: total }).weight
    assert.equal(afterW, beforeW + 5)
  } else {
    assert.ok(beforeW >= 110)
  }
})

test('新建群体：平台与号码必填；默认 50；重复创建会拒绝', () => {
  assert.throws(() => createGroupWithCard(root, PID, { name: '群', platform: 'qq', nativeId: '' }), /群号/)
  assert.throws(() => createGroupWithCard(root, PID, { name: '群', platform: '', nativeId: '1' }), /平台/)

  const g = createGroupWithCard(root, PID, { name: '摸鱼群', platform: 'qq', nativeId: '30001', feature: '晚上活跃' })
  assert.match(g.gid, /^grp_/)
  assert.equal(g.name, '摸鱼群')

  const [row] = listGroups(root, PID)
  assert.equal(row.weight, 50, '一次互动都没有 → 显示新建默认分')
  assert.equal(row.weightKind, 'auto')

  assert.throws(() => createGroupWithCard(root, PID, { name: '再来一次', platform: 'qq', nativeId: '30001' }), /已经有卡/)
})

test('新建群体：用一句人话就能指定平台和号（不做平台下拉）', () => {
  assert.deepEqual(parseGroupAccountText('QQ群 123456789'), { ok: true, platform: 'qq', nativeId: '123456789' })
  assert.deepEqual(parseGroupAccountText('QQ 群号是 123456789'), { ok: true, platform: 'qq', nativeId: '123456789' })
  assert.deepEqual(parseGroupAccountText('贴吧 原神吧'), { ok: true, platform: 'tieba', nativeId: '原神吧' })
  assert.deepEqual(parseGroupAccountText('微信群 abc123@chatroom'), {
    ok: true,
    platform: 'wechat',
    nativeId: 'abc123@chatroom',
  })
  // 认不出的平台照样能进：任意"平台:号码"都收，所以加新 App 不用改界面
  assert.deepEqual(parseGroupAccountText('someapp:xyz-123'), { ok: true, platform: 'someapp', nativeId: 'xyz-123' })

  // 只给号码不猜平台
  assert.equal(parseGroupAccountText('123456789').ok, false)
  assert.equal(parseGroupAccountText('').ok, false)

  const g = createGroupWithCard(root, PID, { name: '贴吧群', accountText: '贴吧 原神吧' })
  assert.equal(g.platform, 'tieba')
  assert.equal(g.nativeId, '原神吧')
})

test('重点群体：名次分同样从 110 起，取消后回落到互动分', () => {
  const g1 = ensureGroupScene(root, { platform: 'qq', nativeId: '30001' })
  const g2 = createGroupWithCard(root, PID, { name: '另一个群', platform: 'qq', nativeId: '30002' })

  setGroupTier(root, PID, g1, 'important')
  setGroupTier(root, PID, g2.gid, 'important')
  let rows = listGroups(root, PID)
  assert.equal(rows[0].gid, g1, '先设的重点排在前面')
  assert.equal(rows[0].weight, 115)
  assert.equal(rows[1].weight, 110)

  moveGroupPinned(root, PID, g2.gid, 'up')
  rows = listGroups(root, PID)
  assert.equal(rows[0].gid, g2.gid)
  assert.equal(rows[0].weight, 115)

  setGroupTier(root, PID, g2.gid, null)
  rows = listGroups(root, PID)
  const back = rows.find((x) => x.gid === g2.gid)
  assert.equal(back.weightKind, 'auto')
  assert.equal(back.weight, 50, '回到落盘默认分')
})

test('偏好：温柔开关按人格存、只认已知字段', () => {
  assert.equal(readPrefs(root, PID).gentleToAdmin, false)
  writePrefs(root, PID, { gentleToAdmin: true })
  assert.equal(readPrefs(root, PID).gentleToAdmin, true)
  assert.throws(() => writePrefs(root, PID, { nope: 1 }), /不认识的偏好项/)
})

test('注入：勾了「更温柔」才多一行 [对象]，而且叫得出管理员的名字', () => {
  const data = loadPersons(root, PID)
  const admin = Object.values(data.persons)[0]
  setAdmin(root, admin.uid)
  const adminName = labelOfPerson(root, PID, admin.uid)

  writePrefs(root, PID, { gentleToAdmin: false })
  assert.ok(!personaExtraLines(root, PID).some((l) => l.startsWith('[对象]')))

  writePrefs(root, PID, { gentleToAdmin: true })
  const lines = personaExtraLines(root, PID)
  const line = lines.find((l) => l.startsWith('[对象]'))
  assert.ok(line, '应该有 [对象] 那一行')
  assert.match(line, /温柔/)
  assert.ok(line.includes(adminName), '要叫得出管理员是谁')
})
