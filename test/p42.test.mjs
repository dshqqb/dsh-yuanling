// test/p42.test.mjs —— 群体实体。
//
// 和人物刻意不同的一点（也是用户明确纠正的）：
//   **群体不能跨平台合并**。一个 QQ 群永远不等于一个贴吧，
//   所以 gid = `platform:id`，没有 merge、没有"一个群体映射多个频道"。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { scaffold } from '../src/core/scaffold.js'
import { appendRecord, today } from '../src/core/raw.js'
import { createPerson, linkIdentity } from '../src/core/entities.js'
import { contextFor } from '../src/core/memory.js'
import {
  gidForChannel,
  parseGid,
  readGroup,
  writeGroup,
  listGroups,
  ensureGroup,
  normalizeGroup,
  collectMembers,
  computeGroupWeight,
  refreshGroupWeight,
  setGroupTier,
  setGroupWeight,
  clearGroupWeight,
  groupsForContext,
  groupCardLine,
  MAX_MEMBERS,
} from '../src/core/groups.js'

function tmpRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'yuanling-p42-'))
  scaffold(root, {})
  return root
}

const PID = 'yuanling'

// ── 标识 ────────────────────────────────────────────────────────────────

test('群体：频道 → gid（QQ群用 qq 前缀，贴吧用自己的名字）', () => {
  assert.equal(gidForChannel('group:123456'), 'qq:123456')
  assert.equal(gidForChannel('tieba:原神吧'), 'tieba:原神吧')
  assert.equal(gidForChannel('wechat:abc'), 'wechat:abc')
  assert.equal(gidForChannel('private:10001'), null, '私聊不是群体')
  assert.equal(gidForChannel('dsh:main'), null)
  assert.equal(gidForChannel(''), null)
})

test('群体：gid 拆出平台与 id', () => {
  assert.deepEqual(parseGid('qq:123456'), { platform: 'qq', id: '123456' })
  assert.deepEqual(parseGid('tieba:原神吧'), { platform: 'tieba', id: '原神吧' })
})

test('群体：同一个 gid 在不同平台不冲突（QQ群 ≠ 贴吧）', () => {
  const root = tmpRoot()
  writeGroup(root, PID, 'qq:123456', { name: 'QQ 群' })
  writeGroup(root, PID, 'tieba:123456', { name: '贴吧' })
  const list = listGroups(root, PID)
  assert.equal(list.length, 2, '两个平台同号也是两个群体，绝不合并')
  assert.deepEqual(list.map((g) => g.gid).sort(), ['qq:123456', 'tieba:123456'])
})

// ── 存储与迁移 ──────────────────────────────────────────────────────────

test('群体：没有档案时返回 null（不凭空造群）', () => {
  const root = tmpRoot()
  assert.equal(readGroup(root, PID, 'qq:999'), null)
})

test('群体：写了能读回来，字段齐全', () => {
  const root = tmpRoot()
  const g = writeGroup(root, PID, 'qq:123456', { name: '游戏群', feature: '一群人互相嘲讽', topics: '主要在聊抽卡' })
  assert.equal(g.gid, 'qq:123456')
  assert.equal(g.platform, 'qq')
  assert.equal(g.name, '游戏群')
  assert.equal(g.feature, '一群人互相嘲讽')
  assert.equal(g.topics, '主要在聊抽卡')
  assert.equal(readGroup(root, PID, 'qq:123456').name, '游戏群')
})

test('群体：老版本文件（name/intro/tone/topics 数组）能升级，不丢内容', () => {
  const old = normalizeGroup({ gid: 'qq:1', name: '旧群', intro: '旧简介', tone: '阴阳怪气', topics: ['抽卡', '攻略'] }, 'qq:1')
  assert.match(old.feature, /旧简介/, 'intro 不该丢')
  assert.match(old.feature, /阴阳怪气/, 'tone 折进 feature')
  assert.equal(old.topics, '主要在聊：抽卡、攻略')
})

test('群体：写档案走版本追踪（可回滚）', () => {
  const root = tmpRoot()
  writeGroup(root, PID, 'qq:1', { name: 'A' })
  writeGroup(root, PID, 'qq:1', { name: 'B' })
  const versionsDir = path.join(root, 'personas', PID, 'versions')
  assert.ok(fs.existsSync(path.join(versionsDir, 'journal.ndjson')), '要有版本日志')
})

// ── 成员收集 ────────────────────────────────────────────────────────────

function say(root, { channel = 'group:123456', qq = '111', name = '张三', text = '在吗', role = 'user' } = {}) {
  return appendRecord(root, {
    source: 'qq',
    channel,
    actor: { kind: 'member', id: qq, name },
    role,
    text,
    ts: `${today(new Date())}T10:00:00+08:00`,
  })
}

test('成员：只算能对上人物卡的（宁可少几个，也不塞假人）', () => {
  const root = tmpRoot()
  // 张三有卡
  const a = createPerson(root, { uid: 'person_a', display: '张三' })
  linkIdentity(root, a.uid, { platform: 'qq', id: '111' })
  // 李四没有卡
  say(root, { qq: '222', name: '李四' })
  say(root, { qq: '111', name: '张三', text: '第一条' })
  say(root, { qq: '111', name: '张三', text: '第二条' })

  const r = collectMembers(root, PID, 'qq:123456')
  assert.deepEqual(r.members, ['person_a'], '没有人物卡的不进成员表')
})

test('成员：她自己的发言不算（role=bot 跳过）', () => {
  const root = tmpRoot()
  const a = createPerson(root, { uid: 'person_a', display: '张三' })
  linkIdentity(root, a.uid, { platform: 'qq', id: '111' })
  say(root, { qq: '111', role: 'bot' })
  const r = collectMembers(root, PID, 'qq:123456')
  assert.deepEqual(r.members, [], '她说话不算"群里的人"')
})

test('成员：别的频道的人不会混进来', () => {
  const root = tmpRoot()
  const a = createPerson(root, { uid: 'person_a', display: '张三' })
  linkIdentity(root, a.uid, { platform: 'qq', id: '111' })
  const b = createPerson(root, { uid: 'person_b', display: '王五' })
  linkIdentity(root, b.uid, { platform: 'qq', id: '333' })

  say(root, { channel: 'group:123456', qq: '111' })
  say(root, { channel: 'group:999', qq: '333' })

  const r = collectMembers(root, PID, 'qq:123456')
  assert.deepEqual(r.members, ['person_a'], '别的群的人不该出现在这个群的成员表里')
})

test('成员：上限封顶（成员是素材，不是通讯录）', () => {
  const root = tmpRoot()
  for (let i = 0; i < MAX_MEMBERS + 5; i += 1) {
    const p = createPerson(root, { uid: `person_${i}`, display: `人${i}` })
    linkIdentity(root, p.uid, { platform: 'qq', id: String(1000 + i) })
    say(root, { qq: String(1000 + i), name: `人${i}`, text: `第 ${i} 条` })
  }
  const r = collectMembers(root, PID, 'qq:123456')
  assert.ok(r.members.length <= MAX_MEMBERS)
})

// ── 权重与重要群体 ──────────────────────────────────────────────────────

test('权重：聊得多、跨天数多、最近活跃 → 更高，封顶 100', () => {
  assert.equal(computeGroupWeight({ msgs: 0, days: 0, recent: 0 }), 0)
  assert.equal(computeGroupWeight({ msgs: 10, days: 3, recent: 5 }), Math.round(10 * 0.5 + 3 + 5 * 0.3))
  assert.equal(computeGroupWeight({ msgs: 10000, days: 400, recent: 4000 }), 100)
})

test('权重：手改之后自动计分不再覆盖', () => {
  const root = tmpRoot()
  writeGroup(root, PID, 'qq:1', { name: '群' })
  setGroupWeight(root, PID, 'qq:1', 88)
  const g = refreshGroupWeight(root, PID, 'qq:1')
  assert.equal(g.weight, 88, 'manual 的权重不该被自动算掉')
  assert.equal(g.weightSource, 'manual')

  clearGroupWeight(root, PID, 'qq:1')
  assert.equal(readGroup(root, PID, 'qq:1').weightSource, 'auto')
})

test('重要群体：置顶与取消', () => {
  const root = tmpRoot()
  writeGroup(root, PID, 'qq:1', { name: '群' })
  const up = setGroupTier(root, PID, 'qq:1', 'important')
  assert.equal(up.tier, 'important')
  const down = setGroupTier(root, PID, 'qq:1', null)
  assert.equal(down.tier, null)
})

test('ensureGroup：见过才建，第二次只更新 lastSeen', () => {
  const root = tmpRoot()
  const g1 = ensureGroup(root, PID, 'qq:1', { name: '群', seenAt: '2026-11-01T10:00:00+08:00' })
  assert.equal(g1.name, '群')
  const g2 = ensureGroup(root, PID, 'qq:1', { seenAt: '2026-11-05T10:00:00+08:00' })
  assert.equal(g2.lastSeen, '2026-11-05T10:00:00+08:00')
  assert.equal(g2.name, '群', '已有名字不该被空值覆盖')
})

// ── 注入 ────────────────────────────────────────────────────────────────

test('注入：当前频道对应的群体一定带', () => {
  const root = tmpRoot()
  writeGroup(root, PID, 'qq:123456', { name: '游戏群', feature: '爱互相嘲讽' })
  const picked = groupsForContext(root, PID, { channel: 'group:123456' })
  assert.equal(picked.length, 1)
  assert.equal(picked[0].name, '游戏群')
})

test('注入：群里聊到别的群，两个都带（Q3 的例外）', () => {
  const root = tmpRoot()
  writeGroup(root, PID, 'qq:123456', { name: '游戏群' })
  writeGroup(root, PID, 'qq:888', { name: '画画群' })

  const picked = groupsForContext(root, PID, { channel: 'group:123456', text: '你们画画群那边最近怎么样' })
  assert.equal(picked.length, 2, '当前群 + 被提到的群')
  assert.deepEqual(picked.map((g) => g.name), ['游戏群', '画画群'])
})

test('注入：私聊不带群体', () => {
  const root = tmpRoot()
  writeGroup(root, PID, 'qq:1', { name: '群' })
  assert.deepEqual(groupsForContext(root, PID, { channel: 'private:10001' }), [])
})

test('注入：群体卡是自然语言，带成员名字而不是 uid', () => {
  const root = tmpRoot()
  const a = createPerson(root, { uid: 'person_a', display: '张三' })
  linkIdentity(root, a.uid, { platform: 'qq', id: '111' })
  writeGroup(root, PID, 'qq:123456', { name: '游戏群', feature: '爱互相嘲讽', topics: '主要聊抽卡', members: ['person_a'] })
  const line = groupCardLine(root, PID, readGroup(root, PID, 'qq:123456'))
  assert.match(line, /^\[群体\]/)
  assert.match(line, /游戏群/)
  assert.match(line, /爱互相嘲讽/)
  assert.match(line, /张三/, '要显示名字，不是 person_a')
  assert.ok(!line.includes('person_a'), '不该把 uid 写进注入')
})

test('注入：contextFor 里能看见 [群体] 段', () => {
  const root = tmpRoot()
  writeGroup(root, PID, 'qq:123456', { name: '游戏群', feature: '爱互相嘲讽' })
  const text = contextFor(root, PID, { channel: 'group:123456', budget: 8192 })
  assert.match(text, /\[群体\] 游戏群/)
})

test('注入：私聊的注入里没有 [群体]', () => {
  const root = tmpRoot()
  writeGroup(root, PID, 'qq:1', { name: '群' })
  const text = contextFor(root, PID, { channel: 'private:10001', budget: 8192 })
  assert.ok(!text.includes('[群体]'))
})
