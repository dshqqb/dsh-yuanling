// test/p44.test.mjs —— 群体怎么"长出来"：收到消息自动建卡、开机回填、权重读时现算。
//
// 这三件事是用户拍的两个决定：
//   A（建卡时机）：第一条群消息进来就建，并在启动时回填 raw 里出现过的群频道；
//   A（权重要点）：读的时候现算，不写盘——权重只用来排序和显示。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { scaffold } from '../src/core/scaffold.js'
import { appendRecord } from '../src/core/raw.js'
import { ingest } from '../src/core/inbox.js'
import {
  gidForChannel,
  readGroup,
  readGroupLive,
  writeGroup,
  listGroups,
  backfillGroups,
  scanGroupChannels,
  ensureGroup,
  ensureGroupScene,
  readGroupIdentity,
  findGidByNative,
  computeGroupWeight,
  setGroupWeight,
} from '../src/core/groups.js'
import { legacySceneIdentity } from '../src/core/channels.js'

const PID = 'yuanling'

function tmpRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'yuanling-p44-'))
  scaffold(root, {})
  return root
}

/** 走真实投递入口：inbox.ingest 是模块真正会调的路径。 */
function env(items, source = 'qq') {
  return { v: 1, source, acct: 'demo', items }
}

const msg = (channel, text = '在吗', extra = {}) => ({
  ts: '2026-11-01T20:00:00+08:00',
  channel,
  actor: { kind: 'user', id: '111', name: '张三' },
  role: 'user',
  kind: 'msg',
  text,
  ...extra,
})

/**
 * 场景 → 群体编号。
 * 场景编号是内部编号（`grp_xxx`），所以旧格式（`group:555`）本身不是编号；
 * 测试里要拿某个群的卡，就先按它的身份去登记表查编号。
 */
const gidOf = (root, scene) => {
  const direct = gidForChannel(root, scene)
  if (direct) return direct
  const idn = legacySceneIdentity(root, scene)
  return idn ? findGidByNative(root, idn.platform, idn.nativeId) : null
}

// ── 收到消息就建卡（Q1 = A）─────────────────────────────────────────────

test('群消息进来 → 这个群自动出现，lastSeen 就是这条消息的时间', () => {
  const root = tmpRoot()
  const r = ingest(root, env([msg('group:123456', '今晚开黑吗')]))
  assert.equal(r.accepted, 1)

  const gid = gidOf(root, 'group:123456')
  assert.ok(gid, '第一条群消息就该把群体身份登记出来')
  const g = readGroup(root, PID, gid)
  assert.ok(g, '第一条群消息就该把群体建出来')
  assert.equal(g.platform, 'qq')
  assert.equal(g.nativeId, '123456')
  assert.equal(g.lastSeen, '2026-11-01T20:00:00+08:00')
  assert.equal(g.name, '', '消息里没有群名，就老实空着，不猜')
  // 场景里不出现外部号码
  assert.match(gid, /^grp_/)
})

test('私聊 / module: / bili:video: 都不会长出群体', () => {
  const root = tmpRoot()
  ingest(root, env([msg('private:10001'), msg('module:bili.search_video'), msg('bili:video:BV1xx')]))
  assert.deepEqual(listGroups(root, PID), [], '只有"一个地方"才算群体，一次调用不是一个地方')
  assert.equal(gidForChannel(root, 'module:bili.search_video'), null)
  assert.equal(gidForChannel(root, 'bili:video:BV1xx'), null)
})

test('同一句话投两次（去重）不会把 lastSeen 来回推', () => {
  const root = tmpRoot()
  const one = msg('group:123456', '重复的一句')
  ingest(root, env([one]))
  const gid = gidOf(root, 'group:123456')
  const first = readGroup(root, PID, gid).lastSeen

  const again = ingest(root, env([one]))
  assert.equal(again.deduped, 1)
  assert.equal(readGroup(root, PID, gid).lastSeen, first, '去重的那条不该再动 time')
})

test('第二个群进来 → 两个群，各自 time 独立', () => {
  const root = tmpRoot()
  ingest(root, env([msg('group:111', 'a')]))
  ingest(root, env([msg('group:222', 'b', { ts: '2026-11-02T09:00:00+08:00' })]))

  const list = listGroups(root, PID)
  assert.deepEqual(
    list.map((g) => g.nativeId).sort(),
    ['111', '222'],
    '两个群各一张卡，原生号才对得上',
  )
  assert.equal(readGroup(root, PID, gidOf(root, 'group:222')).lastSeen, '2026-11-02T09:00:00+08:00')
})

// ── 开机回填（Q1 = A 的后半句）─────────────────────────────────────────

/** 直接写 raw：模拟"装插件之前就有的历史"，那时还没有建卡逻辑。 */
function seedRaw(root, { channel, ts, text = '历史消息' }) {
  appendRecord(root, {
    type: 'message',
    source: channel.startsWith('group') ? 'qq' : channel.split(':')[0],
    acct: 'demo',
    channel,
    actor: { kind: 'user', id: '111', name: '张三' },
    role: 'user',
    text,
    ts,
  })
}

test('回填：raw 里出现过的群频道补成档案，firstSeen/lastSeen 取真实首末时间', () => {
  const root = tmpRoot()
  seedRaw(root, { channel: 'group:555', ts: '2026-09-01T10:00:00+08:00' })
  seedRaw(root, { channel: 'group:555', ts: '2026-09-20T22:00:00+08:00' })
  seedRaw(root, { channel: 'group:777', ts: '2026-09-05T08:00:00+08:00' })
  seedRaw(root, { channel: 'private:10001', ts: '2026-09-01T09:00:00+08:00' })

  const r = backfillGroups(root, PID)
  assert.equal(r.created.length, 2, '回填不是"把 raw 里所有频道都当群"')
  assert.deepEqual(r.created.map((gid) => readGroupIdentity(root, gid).nativeId).sort(), ['555', '777'])

  const g = readGroup(root, PID, gidOf(root, 'group:555'))
  assert.equal(g.firstSeen, '2026-09-01T10:00:00+08:00', '第一次见到就用最早那条的时间')
  assert.equal(g.lastSeen, '2026-09-20T22:00:00+08:00')
})

test('回填幂等：跑第二遍不新建、不改时间', () => {
  const root = tmpRoot()
  seedRaw(root, { channel: 'group:555', ts: '2026-09-01T10:00:00+08:00' })
  const first = backfillGroups(root, PID)
  assert.equal(first.created.length, 1)

  const gid = gidOf(root, 'group:555')
  const before = readGroup(root, PID, gid)
  const second = backfillGroups(root, PID)
  assert.deepEqual(second.created, [])
  const after = readGroup(root, PID, gid)
  assert.equal(after.firstSeen, before.firstSeen)
  assert.equal(after.lastSeen, before.lastSeen)
})

test('回填不动已有的描述和名字（只补"见过"这件事）', () => {
  const root = tmpRoot()
  const gid = ensureGroupScene(root, { platform: 'qq', nativeId: '555' })
  writeGroup(root, PID, gid, { name: '摸鱼群', feature: '晚上最热闹' })
  seedRaw(root, { channel: 'group:555', ts: '2026-09-01T10:00:00+08:00' })

  backfillGroups(root, PID)
  const g = readGroup(root, PID, gid)
  assert.equal(g.name, '摸鱼群')
  assert.equal(g.feature, '晚上最热闹')
  assert.equal(g.lastSeen, '2026-09-01T10:00:00+08:00')
})

test('回填：没有 raw 时不建任何东西（空库不能凭空多出群）', () => {
  const root = tmpRoot()
  const r = backfillGroups(root, PID)
  assert.deepEqual(r.created, [])
  assert.deepEqual(listGroups(root, PID), [])
})

test('scanGroupChannels 只认「一个地方」的场景', () => {
  const root = tmpRoot()
  seedRaw(root, { channel: 'group:555', ts: '2026-09-01T10:00:00+08:00' })
  seedRaw(root, { channel: 'tieba:原神吧', ts: '2026-09-02T10:00:00+08:00' })
  seedRaw(root, { channel: 'module:bili.search_video', ts: '2026-09-02T11:00:00+08:00' })

  const m = scanGroupChannels(root)
  assert.equal(m.size, 2)
  // 键是内部编号；原生号从登记表反查
  const natives = [...m.keys()].map((gid) => `${readGroupIdentity(root, gid).platform}:${readGroupIdentity(root, gid).nativeId}`).sort()
  assert.deepEqual(natives, ['qq:555', 'tieba:原神吧'])
})

// ── "最后一次见到"的写盘节流 ────────────────────────────────────────────

test('同一群里连着说话，lastSeen 不会每条都写一次盘', () => {
  const root = tmpRoot()
  const gid = ensureGroupScene(root, { platform: 'qq', nativeId: '555' })
  ensureGroup(root, PID, gid, { seenAt: '2026-11-01T20:00:00+08:00' })
  ensureGroup(root, PID, gid, { seenAt: '2026-11-01T20:00:10+08:00' })
  ensureGroup(root, PID, gid, { seenAt: '2026-11-01T20:00:20+08:00' })
  assert.equal(readGroup(root, PID, gid).lastSeen, '2026-11-01T20:00:00+08:00', '一分钟内不该为每句话造一条版本')
})

test('隔了足够久再来消息，lastSeen 才往前推', () => {
  const root = tmpRoot()
  const gid = ensureGroupScene(root, { platform: 'qq', nativeId: '555' })
  ensureGroup(root, PID, gid, { seenAt: '2026-11-01T20:00:00+08:00' })
  ensureGroup(root, PID, gid, { seenAt: '2026-11-01T20:45:00+08:00' })
  assert.equal(readGroup(root, PID, gid).lastSeen, '2026-11-01T20:45:00+08:00')
})

// ── 权重读时现算（Q2 = A）───────────────────────────────────────────────

test('权重：列表里是现算的，文件里的值不跟着变', () => {
  const root = tmpRoot()
  seedRaw(root, { channel: 'group:555', ts: '2026-11-01T10:00:00+08:00' })
  seedRaw(root, { channel: 'group:555', ts: '2026-11-01T11:00:00+08:00' })
  backfillGroups(root, PID)

  const gid = gidOf(root, 'group:555')
  const g = listGroups(root, PID).find((x) => x.gid === gid)
  assert.ok(g.weight > 0, `两条消息应该算出手改之外的分数，实际 ${g.weight}`)

  const stored = readGroup(root, PID, gid)
  assert.equal(stored.weight, 0, '读的时候算，不该顺手写盘')
})

test('权重：公式和 computeGroupWeight 一致', () => {
  const root = tmpRoot()
  const day = '2026-11-01'
  for (const h of ['10', '12', '20']) seedRaw(root, { channel: 'group:555', ts: `${day}T${h}:00:00+08:00` })
  backfillGroups(root, PID)

  const g = listGroups(root, PID)[0]
  const now = Date.now()
  const expect = computeGroupWeight({ msgs: 3, days: 1, recent: now - Date.parse(`${day}T23:59:59`) < 30 * 86400000 ? 3 : 0 })
  assert.equal(g.weight, expect)
})

test('权重：手改过的优先，读时不再覆盖它', () => {
  const root = tmpRoot()
  seedRaw(root, { channel: 'group:555', ts: '2026-11-01T10:00:00+08:00' })
  backfillGroups(root, PID)
  const gid = gidOf(root, 'group:555')
  setGroupWeight(root, PID, gid, 88)

  const g = listGroups(root, PID)[0]
  assert.equal(g.weight, 88)
  assert.equal(g.weightSource, 'manual')
})

test('readGroupLive 带实时权重，readGroup 保持落盘值', () => {
  const root = tmpRoot()
  seedRaw(root, { channel: 'group:555', ts: '2026-11-01T10:00:00+08:00' })
  backfillGroups(root, PID)
  const gid = gidOf(root, 'group:555')

  assert.ok(readGroupLive(root, PID, gid).weight > 0)
  assert.equal(readGroup(root, PID, gid).weight, 0)
})

test('readGroupLive：不存在的群返回 null，不凭空造一个', () => {
  const root = tmpRoot()
  assert.equal(readGroupLive(root, PID, 'qq:404'), null)
  assert.deepEqual(listGroups(root, PID), [])
})
