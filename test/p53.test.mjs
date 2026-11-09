// test/p53.test.mjs —— 频道编号指向内部编号（不是外部账号）。
//
// 为什么值得单独测：频道是跨模块的唯一标识。如果它等于外部 id，那么"新增一个平台"
// 就等于"改掉全部历史数据的语义"——两个 App 上的 10001 会被当成同一个人。
//
// 这套改动同时必须**不弄坏老数据**（raw 只追加，改不了），所以老形状要能读、能匹配。
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { scaffold } from '../src/core/scaffold.js'
import { personaPaths } from '../src/core/paths.js'
import { ingest } from '../src/core/inbox.js'
import { appendRecord, readDay, listDays } from '../src/core/raw.js'
import { canonicalChannelForIngest, resolveChannel, platformFromSource, nativeChannelsFor, ensureSenderPerson, promoteShadow, isShadow } from '../src/core/channels.js'
import { loadIdentities, linkIdentity, createPerson, personForChannel, listPeopleForUi, readProfile } from '../src/core/entities.js'
import { gidForChannel, channelOfGid, ensureGroupScene, readGroupIdentity } from '../src/core/groups.js'
import { loadEffectiveRules, ruleChain } from '../src/core/rules.js'
import { contextFor } from '../src/core/memory.js'
import { localIso } from '../src/core/fsx.js'

const PID = 'yuanling'
let root

before(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'yuanling-p53-'))
  scaffold(root, {})
})

after(() => {
  /* 临时目录，交给系统回收 */
})

// ── 解析 ──────────────────────────────────────────────────────────────

test('platformFromSource：从模块名推平台（qq / qq-p1 / dsh-yuanling-qq）', () => {
  assert.equal(platformFromSource('qq'), 'qq')
  assert.equal(platformFromSource('qq-p1'), 'qq')
  assert.equal(platformFromSource('dsh-yuanling-qq'), 'qq')
  assert.equal(platformFromSource('tieba'), 'tieba')
  assert.equal(platformFromSource('dsh-yuanling-bili'), 'bili')
  assert.equal(platformFromSource('mystery'), null)
})

test('resolveChannel：老私聊频道 private:10001 → 认到人（唯一命中才算）', () => {
  const p = createPerson(root, { display: '老张' })
  linkIdentity(root, p.uid, { platform: 'qq', id: '10001' })

  const c = resolveChannel(root, 'private:10001')
  assert.equal(c.personUid, p.uid)
  assert.equal(c.canonical, `private:${p.uid}`)
  assert.equal(c.legacy, true)
  assert.equal(c.resolved, true)
  assert.equal(c.nativeId, 'qq:10001')
})

test('resolveChannel：老私聊频道认不出人时标 unresolved，不猜', () => {
  const c = resolveChannel(root, 'private:99999')
  assert.equal(c.resolved, false)
  assert.equal(c.personUid, null)
})

test('resolveChannel：同一个号出现在两个平台 → 不猜是谁', () => {
  const a = createPerson(root, { display: 'A' })
  linkIdentity(root, a.uid, { platform: 'qq', id: '777' })
  const b = createPerson(root, { display: 'B' })
  linkIdentity(root, b.uid, { platform: 'wechat', id: '777' })

  const c = resolveChannel(root, 'private:777')
  assert.equal(c.resolved, false, '两个平台都有 777 时不能认定是谁')
})

test('resolveChannel：老群场景 group:123555 → 去登记表查，查不到就 unresolved', () => {
  // 没登记过：不能猜成"qq:123555"
  const miss = resolveChannel(root, 'group:123555')
  assert.equal(miss.gid, null)
  assert.equal(miss.resolved, false)

  // 登记之后：老写法指向同一个内部编号
  const gid = ensureGroupScene(root, { platform: 'qq', nativeId: '123555' })
  const hit = resolveChannel(root, 'group:123555')
  assert.equal(hit.gid, gid)
  assert.equal(hit.canonical, `group:${gid}`)
  assert.equal(hit.legacy, true)
  assert.equal(hit.resolved, true)
})

test('resolveChannel：老形状（带平台）也去登记表查', () => {
  const gid = ensureGroupScene(root, { platform: 'qq', nativeId: '123555' })
  const c = resolveChannel(root, 'group:qq:123555')
  assert.equal(c.gid, gid)
  assert.equal(c.canonical, `group:${gid}`)
  assert.equal(c.legacy, true)
})

test('resolveChannel：不是人也不是地方的频道原样保留', () => {
  for (const ch of ['bili:video:BV1', 'dsh:main', 'module:bili.search_video']) {
    const c = resolveChannel(root, ch)
    assert.equal(c.canonical, ch)
    assert.equal(c.personUid, null)
    assert.equal(c.gid, null)
  }
})

test('gidForChannel 与 channelOfGid 互逆（群体编号是纯内部编号）', () => {
  const gid = ensureGroupScene(root, { platform: 'qq', nativeId: '123456' })
  assert.match(gid, /^grp_/)

  assert.equal(channelOfGid(gid), `group:${gid}`)
  assert.equal(gidForChannel(root, channelOfGid(gid)), gid)

  // 老写法仍然指向同一个群体
  assert.equal(gidForChannel(root, 'group:123456'), gid)
  assert.equal(gidForChannel(root, 'group:qq:123456'), gid)

  // 贴吧这类：老场景就是 平台:对象
  const tieba = ensureGroupScene(root, { platform: 'tieba', nativeId: '原神吧' })
  assert.equal(gidForChannel(root, 'tieba:原神吧'), tieba)
  assert.equal(channelOfGid(tieba), `group:${tieba}`)

  // 查不到就是 null，不猜
  assert.equal(gidForChannel(root, 'group:999999'), null)
})

// ── 入库归人 ──────────────────────────────────────────────────────────

test('入库：私聊消息的频道变成 private:person_x，并留痕原始号码', () => {
  const before = loadIdentities(root).people
  const r = ingest(root, {
    v: 1,
    source: 'qq',
    acct: '10003',
    items: [{ ts: localIso(), channel: 'private:10003', actor: { kind: 'owner', id: '10003', name: '新来的人' }, kind: 'msg', text: '在吗' }],
  })
  assert.equal(r.accepted, 1)

  const days = listDays(root)
  const rec = readDay(root, days[days.length - 1]).at(-1)
  assert.match(rec.channel, /^private:person_/, '频道必须是内部编号')
  assert.equal(rec.channel_native, 'private:10003', '原始号码要留痕')
  // 频道里不能再出现外部号码
  assert.ok(!rec.channel.includes('10003'))

  // 新人物是影子卡（见过但还没认识）
  const after = loadIdentities(root).people
  const created = Object.keys(after).find((uid) => !before[uid])
  assert.ok(created, '应该建了一张人物卡')
  assert.equal(after[created].tier, 'shadow')
  assert.ok(after[created].identities.some((x) => x.platform === 'qq' && x.id === '10003'))
})

test('入库：群消息的场景变成 group:<群体编号>，并留痕原始群号', () => {
  const r = ingest(root, {
    v: 1,
    source: 'qq',
    acct: '10001',
    items: [{ ts: localIso(), channel: 'group:123555', actor: { kind: 'member', id: '10002', name: '群友' }, kind: 'msg', text: '群里说话' }],
  })
  assert.equal(r.accepted, 1)
  const days = listDays(root)
  const rec = readDay(root, days[days.length - 1]).at(-1)
  assert.match(rec.channel, /^group:grp_/, '场景里只能是内部编号')
  assert.ok(!rec.channel.includes('123555'), '场景里不许出现群号')
  assert.equal(rec.channel_native, 'group:123555', '原始群号要留痕')
  // 群体身份登记表里能查回来
  const gid = rec.channel.slice('group:'.length)
  const idn = readGroupIdentity(root, gid)
  assert.equal(idn.platform, 'qq')
  assert.equal(idn.nativeId, '123555')
})

test('入库：同一个外部号再来一次，不会建第二张卡', () => {
  const before = Object.keys(loadIdentities(root).people).length
  ingest(root, {
    v: 1,
    source: 'qq',
    acct: '10001',
    items: [{ ts: localIso(), channel: 'private:10001', actor: { kind: 'owner', id: '10001', name: '老张' }, kind: 'msg', text: '第二条' }],
  })
  assert.equal(Object.keys(loadIdentities(root).people).length, before, '同一账号不该重复建卡')
})

test('入库：跨平台同号是**两个**人（这正是不能用外部 id 当频道的原因）', () => {
  const uid1 = ensureSenderPerson(root, { platform: 'qq', nativeId: '500', display: 'QQ 上的 500' })
  const uid2 = ensureSenderPerson(root, { platform: 'wechat', nativeId: '500', display: '微信上的 500' })
  assert.notEqual(uid1, uid2)

  const c1 = canonicalChannelForIngest(root, { channel: 'private:500', source: 'qq' })
  // `private:500` 是老形状，两边都有 500 → 不能猜
  assert.equal(resolveChannel(root, 'private:500').resolved, false)
  // 但走入库时平台是已知的（source=qq），所以归人不会错
  assert.equal(c1.personUid, uid1)
})

// ── 影子卡 ────────────────────────────────────────────────────────────

test('影子卡：不进人物页、不进注入', () => {
  const people = listPeopleForUi(root, PID)
  const shadowUid = Object.keys(loadIdentities(root).people).find((uid) => isShadow(root, uid))
  assert.ok(shadowUid)
  assert.ok(!people.some((p) => p.uid === shadowUid), '人物页默认不显示影子')

  // 影子卡没有档案，所以注入时也不会出现人物卡
  assert.equal(readProfile(root, PID, shadowUid), null, '影子卡没有档案')
})

test('影子卡：写了档案就转正，之后人物页看得到', () => {
  const uid = ensureSenderPerson(root, { platform: 'qq', nativeId: '600', display: '六百' })
  assert.equal(isShadow(root, uid), true)
  assert.equal(promoteShadow(root, uid), true)
  assert.equal(isShadow(root, uid), false)
})

// ── 兼容：老频道还能匹配 ───────────────────────────────────────────────

test('nativeChannelsFor：新场景的记录能连老写法一起找回来', () => {
  const p = createPerson(root, { display: '小李' })
  linkIdentity(root, p.uid, { platform: 'qq', id: '321' })
  const set = nativeChannelsFor(root, `private:${p.uid}`)
  assert.ok(set.includes(`private:${p.uid}`))
  assert.ok(set.includes('private:321'), '老记录用的是外部号，必须也能找到')

  // 群体：登记过之后，老场景（group:123555 / group:qq:123555）也要一并找回来
  ensureGroupScene(root, { platform: 'qq', nativeId: '123555' })
  const gset = nativeChannelsFor(root, 'group:qq:123555')
  assert.ok(gset.includes('group:qq:123555'))
  assert.ok(gset.includes('group:123555'), '老群记录是 group:123555')
})

test('规则链：群覆盖文件名用内部编号；老文件名仍然要读', () => {
  const gid = ensureGroupScene(root, { platform: 'qq', nativeId: '123555' })
  const chain = ruleChain(root, PID, { channel: `group:${gid}` })
  assert.ok(chain.some((p) => p.endsWith(`group-${gid}.json`)), '新命名用内部编号')
  // 老命名两种（group-qq_123555 / group-123555）都要读：群覆盖是手写的，不能让人重抄
  assert.ok(chain.some((p) => p.endsWith('group-qq_123555.json')))
  assert.ok(chain.some((p) => p.endsWith('group-123555.json')))
  // 文件名里不能出现冒号（Windows 不允许）
  for (const rel of chain) assert.ok(!rel.includes(':'), rel)

  // 私聊：场景 id 是 person_uid，文件名直接用它
  const pchain = ruleChain(root, PID, { channel: 'private:person_abc' })
  assert.ok(pchain.some((p) => p.endsWith('private-person_abc.json')))
})

test('规则链：老私聊频道也能叠到同一层（private:10001 → private-person_x）', () => {
  const p = createPerson(root, { display: '小王' })
  linkIdentity(root, p.uid, { platform: 'qq', id: '654' })
  const old = ruleChain(root, PID, { channel: 'private:654' })
  const now = ruleChain(root, PID, { channel: `private:${p.uid}` })

  // 两边都必须有"按人物"的那一层；老这边还会多一条 private-654.json（老文件名，留着兼容）
  assert.ok(old.some((x) => x.endsWith(`private-${p.uid}.json`)), '老频道也要能叠到人物层')
  assert.ok(now.some((x) => x.endsWith(`private-${p.uid}.json`)))
  assert.ok(old.some((x) => x.endsWith('private-654.json')), '老文件名仍要读')
})

test('ingest.json 的 skip_channels 写老形状也仍然生效', () => {
  const p = path.join(root, 'rules', 'ingest.json')
  fs.mkdirSync(path.dirname(p), { recursive: true })
  fs.writeFileSync(p, JSON.stringify({ version: 1, soft_blacklist: [], skip_channels: ['group:777'] }), 'utf8')

  const r = ingest(root, {
    v: 1,
    source: 'qq',
    acct: '10001',
    items: [{ ts: localIso(), channel: 'group:777', actor: { kind: 'member', id: '1' }, kind: 'msg', text: '不该被记下' }],
  })
  assert.equal(r.skipped, 1, '拉黑的群不该因为频道换了形状就失效')
  assert.equal(r.accepted, 0)
})

// ── 硬要求：频道里不许出现外部号码 ─────────────────────────────────────

test('硬要求：入库后的场景里永远没有外部号码', () => {
  for (const day of listDays(root)) {
    for (const rec of readDay(root, day)) {
      if ((rec.type ?? 'message') !== 'message') continue
      const ch = String(rec.channel ?? '')
      // 私聊 → 人物编号；群聊 → 群体编号。两种都是内部编号，都不该出现号码。
      if (ch.startsWith('private:')) assert.match(ch, /^private:person_/, `泄漏：${ch}`)
      if (ch.startsWith('group:')) assert.match(ch, /^group:grp_/, `泄漏：${ch}`)
    }
  }
})
