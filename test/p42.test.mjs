// test/p42.test.mjs —— 群体实体：编号、存储、成员、权重、注入。
//
// 2026-11-09 改过**编号模型**：gid 是纯内部编号 `grp_xxx`，平台与外部号码存在
// `system/groups.json`（客观身份），人格目录里只放印象卡。所以这里的断言跟着换：
// 同一个 QQ 群号只会分配一次 gid；两个平台上的同一个号是两个群体。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { scaffold } from '../src/core/scaffold.js'
import { appendRecord, today } from '../src/core/raw.js'
import { createPerson, linkIdentity } from './helpers.mjs'
import { contextFor } from '../src/core/memory.js'
import { legacySceneIdentity, sceneRecordKeys } from '../src/core/channels.js'
import {
  gidForChannel,
  channelOfGid,
  ensureGroupScene,
  readGroupIdentity,
  migrateGroupIds,
  readGroup,
  writeGroup,
  listGroups,
  ensureGroup,
  collectMembers,
  computeGroupWeight,
  setGroupTier,
  refreshGroupWeight,
  backfillGroups,
  scanGroupChannels,
  groupsForContext,
  groupCardLine,
  normalizeGroup,
  MAX_MEMBERS,
} from '../src/core/groups.js'

function tmpRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'yuanling-p42-'))
  scaffold(root, {})
  return root
}

const PID = 'yuanling'

/** 建一个群体（先归身份，再写印象），返回 gid。 */
function mkGroup(root, platform, nativeId, patch = {}) {
  const gid = ensureGroupScene(root, { platform, nativeId })
  writeGroup(root, PID, gid, { name: patch.name ?? '', ...patch })
  return gid
}

// ── 身份与编号 ──────────────────────────────────────────────────────────

test('群体编号：是纯内部编号，不含平台也不含外部号码', () => {
  const root = tmpRoot()
  const gid = ensureGroupScene(root, { platform: 'qq', nativeId: '123456' })
  assert.match(gid, /^grp_[0-9A-Z]{26}$/)
  assert.ok(!gid.includes('123456'), '编号里不许出现外部号码')
  assert.ok(!gid.includes('qq'), '编号里不许出现平台名')
  // 场景只写内部编号
  assert.equal(channelOfGid(gid), `group:${gid}`)
})

test('群体身份：同一个 (平台, 号) 永远分到同一个编号', () => {
  const root = tmpRoot()
  const a = ensureGroupScene(root, { platform: 'qq', nativeId: '123456' })
  const b = ensureGroupScene(root, { platform: 'qq', nativeId: '123456' })
  assert.equal(a, b)
  assert.equal(readGroupIdentity(root, a).platform, 'qq')
  assert.equal(readGroupIdentity(root, a).nativeId, '123456')
})

test('群体身份：两个平台的同一个号是**两个**群体（绝不合并）', () => {
  const root = tmpRoot()
  const qq = ensureGroupScene(root, { platform: 'qq', nativeId: '123456' })
  const tieba = ensureGroupScene(root, { platform: 'tieba', nativeId: '123456' })
  assert.notEqual(qq, tieba, 'QQ 群永远不等于贴吧')
  assert.equal(readGroupIdentity(root, qq).platform, 'qq')
  assert.equal(readGroupIdentity(root, tieba).platform, 'tieba')
})

test('场景 → 编号：只有内部编号能解析；旧格式一律 null（编号不是外部号）', () => {
  const root = tmpRoot()
  const gid = ensureGroupScene(root, { platform: 'qq', nativeId: '123456' })

  assert.equal(gidForChannel(root, `group:${gid}`), gid, '新写法')
  // 旧格式：把群号直接当编号用。就算登记过也不认——那是"按群号找群"，语义错了
  assert.equal(gidForChannel(root, 'group:123456'), null)
  assert.equal(gidForChannel(root, 'group:qq:123456'), null)

  assert.equal(gidForChannel(root, 'private:person_x'), null, '私聊不是群体')
  assert.equal(gidForChannel(root, 'dsh:main'), null)
  assert.equal(gidForChannel(root, ''), null)
})

test('旧格式 → 身份（只给迁移用）：贴吧的原生号是「吧名」', () => {
  const root = tmpRoot()
  const idn = legacySceneIdentity(root, 'tieba:原神吧')
  assert.deepEqual(idn, { kind: 'group', platform: 'tieba', nativeId: '原神吧' })
  const gid = ensureGroupScene(root, { platform: idn.platform, nativeId: idn.nativeId })
  assert.equal(readGroupIdentity(root, gid).nativeId, '原神吧')
  // 场景本身仍然是内部编号
  assert.equal(channelOfGid(gid), `group:${gid}`)
})

// ── 存储 ────────────────────────────────────────────────────────────────

test('群体：没有档案时返回 null（不凭空造群）', () => {
  const root = tmpRoot()
  assert.equal(readGroup(root, PID, ensureGroupScene(root, { platform: 'qq', nativeId: '999' })), null)
})

test('群体：写了能读回来，字段齐全（平台/原生号来自登记表）', () => {
  const root = tmpRoot()
  const gid = mkGroup(root, 'qq', '123456', { name: '游戏群', feature: '一群人互相嘲讽' })
  const g = readGroup(root, PID, gid)
  assert.equal(g.gid, gid)
  assert.equal(g.platform, 'qq')
  assert.equal(g.nativeId, '123456')
  assert.equal(g.name, '游戏群')
  assert.equal(g.feature, '一群人互相嘲讽')
})

test('群体：卡里不重复存平台与号码（同一事实只存一处）', () => {
  const root = tmpRoot()
  const gid = mkGroup(root, 'qq', '123456', { name: '游戏群' })
  const raw = JSON.parse(fs.readFileSync(path.join(root, 'personas', PID, 'entities', 'groups', `${gid}.json`), 'utf8'))
  assert.equal(raw.gid, gid)
  assert.equal(raw.platform, undefined, '平台在 system/groups.json，不在卡里')
  assert.equal(raw.nativeId, undefined)
})

test('群体卡只有名字/描述/成员/权重：没有别名与话题', () => {
  const root = tmpRoot()
  const gid = mkGroup(root, 'qq', '123456', { name: '游戏群', feature: '爱互相嘲讽' })
  const g = readGroup(root, PID, gid)
  assert.equal(g.aliases, undefined, '别名等价于名字，不该单独存在')
  assert.equal(g.topics, undefined, '“在聊什么”是描述的一部分')

  // 就算旧文件里还带着这两个字段，读出来也不认（不保留兼容）
  const raw = JSON.parse(fs.readFileSync(path.join(root, 'personas', PID, 'entities', 'groups', `${gid}.json`), 'utf8'))
  writeGroup(root, PID, gid, { name: raw.name })
  const after = JSON.parse(fs.readFileSync(path.join(root, 'personas', PID, 'entities', 'groups', `${gid}.json`), 'utf8'))
  assert.equal(after.aliases, undefined)
  assert.equal(after.topics, undefined)
})

test('群体：写档案走版本追踪（可回滚）', () => {
  const root = tmpRoot()
  const gid = mkGroup(root, 'qq', '1', { name: 'A' })
  writeGroup(root, PID, gid, { name: 'B' })
  const versionsDir = path.join(root, 'personas', PID, 'versions')
  assert.ok(fs.existsSync(path.join(versionsDir, 'journal.ndjson')), '要有版本日志')
})

// ── 迁移 ────────────────────────────────────────────────────────────────

test('迁移：老的 qq_123456.json 换成 grp_xxx.json，内容不丢', () => {
  const root = tmpRoot()
  const dir = path.join(root, 'personas', PID, 'entities', 'groups')
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(
    path.join(dir, 'qq_123456.json'),
    JSON.stringify({ gid: 'qq:123456', platform: 'qq', id: '123456', name: '老群', feature: '爱嘲讽', members: ['person_a'] }),
    'utf8',
  )

  const r = migrateGroupIds(root)
  assert.equal(r.migrated.length, 1)
  const { to } = r.migrated[0]
  assert.match(to, /^grp_/)

  // 老文件没了，新文件在
  assert.ok(!fs.existsSync(path.join(dir, 'qq_123456.json')))
  const g = readGroup(root, PID, to)
  assert.equal(g.name, '老群')
  assert.match(g.feature, /爱嘲讽/)
  assert.deepEqual(g.members, ['person_a'])
  assert.equal(g.nativeId, '123456')
  // 场景仍是内部编号；老写法不再被解析成"这个群"，但读历史时能匹配上
  assert.equal(channelOfGid(to), `group:${to}`)
  assert.equal(gidForChannel(root, 'group:123456'), null)
  assert.ok(sceneRecordKeys(root, `group:${to}`).includes('group:123456'))
})

test('迁移：规则覆盖文件跟着改名，内容不动', () => {
  const root = tmpRoot()
  const rulesDir = path.join(root, 'personas', PID, 'rules', 'qq')
  fs.mkdirSync(rulesDir, { recursive: true })
  fs.writeFileSync(path.join(rulesDir, 'group-123456.json'), JSON.stringify({ action: { max_per_day: 5 } }), 'utf8')

  const r = migrateGroupIds(root)
  assert.equal(r.rules.length, 1)
  const gid = ensureGroupScene(root, { platform: 'qq', nativeId: '123456' })
  const newFile = path.join(rulesDir, `group-${gid}.json`)
  assert.ok(fs.existsSync(newFile), '规则文件应跟着换成新编号')
  assert.equal(JSON.parse(fs.readFileSync(newFile, 'utf8')).action.max_per_day, 5)
  assert.ok(!fs.existsSync(path.join(rulesDir, 'group-123456.json')))
})

test('迁移：幂等（跑第二遍什么都不动）', () => {
  const root = tmpRoot()
  const gid = mkGroup(root, 'qq', '777', { name: '群' })
  const r = migrateGroupIds(root)
  assert.equal(r.migrated.length, 0)
  assert.equal(readGroup(root, PID, gid).name, '群')
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
  const a = createPerson(root, { uid: 'person_a', display: '张三' })
  linkIdentity(root, a.uid, { platform: 'qq', id: '111' })
  say(root, { qq: '222', name: '李四' })
  say(root, { qq: '111', name: '张三', text: '第一条' })
  say(root, { qq: '111', name: '张三', text: '第二条' })

  const gid = ensureGroupScene(root, { platform: 'qq', nativeId: '123456' })
  const r = collectMembers(root, PID, gid)
  assert.deepEqual(r.members, ['person_a'], '没有人物卡的不进成员表')
})

test('成员：她自己的发言不算（role=bot 跳过）', () => {
  const root = tmpRoot()
  const a = createPerson(root, { uid: 'person_a', display: '张三' })
  linkIdentity(root, a.uid, { platform: 'qq', id: '111' })
  say(root, { qq: '111', role: 'bot' })
  const gid = ensureGroupScene(root, { platform: 'qq', nativeId: '123456' })
  assert.deepEqual(collectMembers(root, PID, gid).members, [], '她说话不算"群里的人"')
})

test('成员：别的群体的人不会混进来', () => {
  const root = tmpRoot()
  const a = createPerson(root, { uid: 'person_a', display: '张三' })
  linkIdentity(root, a.uid, { platform: 'qq', id: '111' })
  const b = createPerson(root, { uid: 'person_b', display: '王五' })
  linkIdentity(root, b.uid, { platform: 'qq', id: '333' })

  say(root, { channel: 'group:123456', qq: '111' })
  say(root, { channel: 'group:999', qq: '333' })

  const gid = ensureGroupScene(root, { platform: 'qq', nativeId: '123456' })
  assert.deepEqual(collectMembers(root, PID, gid).members, ['person_a'], '别的群的人不该出现在这个群的成员表里')
})

test('成员：上限封顶（成员是素材，不是通讯录）', () => {
  const root = tmpRoot()
  for (let i = 0; i < MAX_MEMBERS + 5; i += 1) {
    const p = createPerson(root, { uid: `person_${i}`, display: `人${i}` })
    linkIdentity(root, p.uid, { platform: 'qq', id: String(1000 + i) })
    say(root, { qq: String(1000 + i), name: `人${i}`, text: `第 ${i} 条` })
  }
  const gid = ensureGroupScene(root, { platform: 'qq', nativeId: '123456' })
  assert.ok(collectMembers(root, PID, gid).members.length <= MAX_MEMBERS)
})

// ── 权重与重要群体 ──────────────────────────────────────────────────────

test('权重：聊得多、跨天数多、最近活跃 → 更高，封顶 100', () => {
  assert.equal(computeGroupWeight({ msgs: 0, days: 0, recent: 0 }), 0)
  assert.equal(computeGroupWeight({ msgs: 10, days: 3, recent: 5 }), Math.round(10 * 0.5 + 3 + 5 * 0.3))
  assert.equal(computeGroupWeight({ msgs: 10000, days: 400, recent: 4000 }), 100)
})

test('权重：没有手改入口了（群体权重也只由互动/名次决定）', async () => {
  const g = await import('../src/core/groups.js')
  assert.equal(g.setGroupWeight, undefined)
  assert.equal(g.clearGroupWeight, undefined)
})

test('重要群体：置顶与取消，并给名次分（110 起）', () => {
  const root = tmpRoot()
  const gid = mkGroup(root, 'qq', '1', { name: '群' })
  const a = setGroupTier(root, PID, gid, 'important')
  assert.equal(a.tier, 'important')
  assert.equal(a.pinRank, 0)

  const [row] = listGroups(root, PID)
  assert.equal(row.weightKind, 'pinned')
  assert.equal(row.weight, 110, '只有一个重点群体时是 110')

  assert.equal(setGroupTier(root, PID, gid, null).tier, null)
  const [back] = listGroups(root, PID)
  assert.equal(back.weightKind, 'auto')
})

test('ensureGroup：见过才建，第二次只更新 lastSeen', () => {
  const root = tmpRoot()
  const gid = ensureGroupScene(root, { platform: 'qq', nativeId: '1' })
  const g1 = ensureGroup(root, PID, gid, { name: '群', seenAt: '2026-11-01T10:00:00+08:00' })
  assert.equal(g1.name, '群')
  const g2 = ensureGroup(root, PID, gid, { seenAt: '2026-11-05T10:00:00+08:00' })
  assert.equal(g2.lastSeen, '2026-11-05T10:00:00+08:00')
  assert.equal(g2.name, '群', '已有名字不该被空值覆盖')
})

// ── 启动回填 ────────────────────────────────────────────────────────────

test('回填：raw 里的老场景也能补成档案，并落到同一个内部编号', () => {
  const root = tmpRoot()
  say(root, { channel: 'group:123456', qq: '111' })
  const scanned = scanGroupChannels(root)
  assert.equal(scanned.size, 1)
  const [gid] = scanned.keys()
  assert.match(gid, /^grp_/)

  const r = backfillGroups(root, PID)
  assert.equal(r.created.length, 1)
  const g = readGroup(root, PID, gid)
  assert.ok(g, '回填后应该有档案')
  // 回填会把老场景登记成身份；之后**新场景**指向它，老写法本身仍然不是编号
  assert.equal(gidForChannel(root, channelOfGid(gid)), gid)
  assert.equal(gidForChannel(root, 'group:123456'), null)
  assert.ok(sceneRecordKeys(root, channelOfGid(gid)).includes('group:123456'))
})

test('回填：幂等（第二遍不新建）', () => {
  const root = tmpRoot()
  say(root, { channel: 'group:123456', qq: '111' })
  backfillGroups(root, PID)
  const second = backfillGroups(root, PID)
  assert.equal(second.created.length, 0)
  assert.equal(listGroups(root, PID).length, 1)
})

test('scanGroupChannels 只认「一个地方」的场景', () => {
  const root = tmpRoot()
  say(root, { channel: 'group:1' })
  say(root, { channel: 'private:10001' })
  say(root, { channel: 'bili:video:BV1' })
  say(root, { channel: 'module:bili.search_video' })
  const scanned = scanGroupChannels(root)
  assert.equal(scanned.size, 1, '只有群场景算一个地方')
})

// ── 注入 ────────────────────────────────────────────────────────────────

test('注入：当前场景对应的群体一定带', () => {
  const root = tmpRoot()
  const gid = mkGroup(root, 'qq', '123456', { name: '游戏群', feature: '爱互相嘲讽' })
  const picked = groupsForContext(root, PID, { channel: channelOfGid(gid) })
  assert.equal(picked.length, 1)
  assert.equal(picked[0].name, '游戏群')
})

test('注入：旧格式场景不被解释成某个群体（只认内部编号）', () => {
  const root = tmpRoot()
  const gid = mkGroup(root, 'qq', '123456', { name: '游戏群' })
  // 旧格式：不知道是哪个群，宁可不带，也不猜
  assert.deepEqual(groupsForContext(root, PID, { channel: 'group:123456' }), [])
  // 内部编号：正常带
  const picked = groupsForContext(root, PID, { channel: channelOfGid(gid) })
  assert.equal(picked.length, 1)
  assert.equal(picked[0].name, '游戏群')
})

test('注入：群里聊到别的群，两个都带', () => {
  const root = tmpRoot()
  const a = mkGroup(root, 'qq', '123456', { name: '游戏群' })
  mkGroup(root, 'qq', '888', { name: '画画群' })

  const picked = groupsForContext(root, PID, { channel: channelOfGid(a), text: '你们画画群那边最近怎么样' })
  assert.equal(picked.length, 2, '当前群 + 被提到的群')
  assert.deepEqual(picked.map((g) => g.name), ['游戏群', '画画群'])
})

test('注入：私聊不带群体', () => {
  const root = tmpRoot()
  mkGroup(root, 'qq', '1', { name: '群' })
  assert.deepEqual(groupsForContext(root, PID, { channel: 'private:10001' }), [])
})

test('注入：群体卡是自然语言，带成员名字而不是 uid', () => {
  const root = tmpRoot()
  const a = createPerson(root, { uid: 'person_a', display: '张三' })
  linkIdentity(root, a.uid, { platform: 'qq', id: '111' })
  const gid = mkGroup(root, 'qq', '123456', { name: '游戏群', feature: '爱互相嘲讽', members: ['person_a'] })
  const line = groupCardLine(root, PID, readGroup(root, PID, gid))
  assert.match(line, /^\[群体\]/)
  assert.match(line, /游戏群/)
  assert.match(line, /爱互相嘲讽/)
  assert.match(line, /张三/, '要显示名字，不是 person_a')
  assert.ok(!line.includes('person_a'), '不该把 uid 写进注入')
})

test('注入：contextFor 里能看见 [群体] 段', () => {
  const root = tmpRoot()
  const gid = mkGroup(root, 'qq', '123456', { name: '游戏群', feature: '爱互相嘲讽' })
  const text = contextFor(root, PID, { channel: channelOfGid(gid), budget: 8192 })
  assert.match(text, /\[群体\] 游戏群/)
})

test('注入：私聊的注入里没有 [群体]', () => {
  const root = tmpRoot()
  mkGroup(root, 'qq', '1', { name: '群' })
  const text = contextFor(root, PID, { channel: 'private:10001', budget: 8192 })
  assert.ok(!text.includes('[群体]'))
})
