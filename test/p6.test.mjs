// test/p6.test.mjs —— 实体档案：身份映射、合并/拆分、候选、档案、按对象注入、切入补跑。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { scaffold } from '../src/core/scaffold.js'
import { appendRecord } from '../src/core/raw.js'
import { localIso } from '../src/core/fsx.js'
import { addFact, contextFor } from '../src/core/memory.js'
import {
  createPerson,
  linkIdentity,
  findByIdentity,
  mergePeople,
  splitIdentity,
  addCandidate,
  listCandidates,
  confirmCandidate,
  rejectCandidate,
  personForChannel,
  writeProfile,
  readProfile,
  writeGroup,
  readGroup,
  loadIdentities,
} from '../src/core/entities.js'
import { catchUp, catchUpStatus } from '../src/core/catchup.js'
import { history } from '../src/core/version.js'
import { createPersona as pbCreate } from '../src/core/persona.js'

const PID = 'yuanling'

function tmpRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'yuanling-p6-'))
  scaffold(root, {})
  return root
}

function seedRaw(root, text = '一句话', ts = localIso()) {
  const r = appendRecord(root, {
    source: 'qq',
    acct: '10001',
    channel: 'private:10001',
    actor: { kind: 'owner', id: '10001', name: '主人' },
    role: 'user',
    text,
    ts,
  })
  return `${r.file}#${r.id}`
}

// ── 身份映射 ────────────────────────────────────────────────────────────

test('person：建人 + 绑号 + 按号查人', () => {
  const root = tmpRoot()
  const p = createPerson(root, { display: '张三' })
  linkIdentity(root, p.uid, { platform: 'qq', id: '12345' })

  const hit = findByIdentity(root, 'qq', '12345')
  assert.equal(hit.uid, p.uid)
  assert.equal(hit.person.display, '张三')
})

test('person：一个号不能同时属于两个人', () => {
  const root = tmpRoot()
  const a = createPerson(root, { display: 'A' })
  const b = createPerson(root, { display: 'B' })
  linkIdentity(root, a.uid, { platform: 'qq', id: '1' })
  assert.throws(() => linkIdentity(root, b.uid, { platform: 'qq', id: '1' }), /已经属于/)
})

test('person：重复绑定同一个号是幂等的', () => {
  const root = tmpRoot()
  const p = createPerson(root, { display: '张三' })
  linkIdentity(root, p.uid, { platform: 'qq', id: '1' })
  const again = linkIdentity(root, p.uid, { platform: 'qq', id: '1' })
  assert.equal(again.changed, false)
})

test('person：合并后两个号都指向同一个人，且留了合并记录', () => {
  const root = tmpRoot()
  const a = createPerson(root, { display: '张三' })
  const b = createPerson(root, { display: '老张' })
  linkIdentity(root, a.uid, { platform: 'qq', id: '1' })
  linkIdentity(root, b.uid, { platform: 'bili', id: '99' })

  mergePeople(root, b.uid, a.uid)

  assert.equal(findByIdentity(root, 'qq', '1').uid, a.uid)
  assert.equal(findByIdentity(root, 'bili', '99').uid, a.uid)

  const data = loadIdentities(root)
  assert.equal(data.people[b.uid], undefined, '被合并的人应该从注册表消失')
  assert.equal(data.merges.length, 1, '要留合并记录，便于追溯')
  assert.ok(data.people[a.uid].aliases.includes('老张'), '旧名字应该进别名')
})

test('person：拆分把号移到一个新人物', () => {
  const root = tmpRoot()
  const p = createPerson(root, { display: '张三' })
  linkIdentity(root, p.uid, { platform: 'qq', id: '1' })
  linkIdentity(root, p.uid, { platform: 'bili', id: '99' })

  const r = splitIdentity(root, p.uid, 'bili', '99')
  assert.notEqual(r.uid, p.uid)
  assert.equal(findByIdentity(root, 'bili', '99').uid, r.uid)
  assert.equal(findByIdentity(root, 'qq', '1').uid, p.uid)
})

// ── 候选 ────────────────────────────────────────────────────────────────

test('候选：只提不并，确认后才生效', () => {
  const root = tmpRoot()
  const p = createPerson(root, { display: '张三' })
  linkIdentity(root, p.uid, { platform: 'qq', id: '1' })

  const r = addCandidate(root, { uid: p.uid, platform: 'bili', id: '99', reason: '同群昵称相似' })
  assert.equal(r.added, true)
  assert.equal(listCandidates(root).length, 1)

  // 未确认前不参与聚合
  assert.equal(findByIdentity(root, 'bili', '99'), null)

  confirmCandidate(root, 0)
  assert.equal(findByIdentity(root, 'bili', '99').uid, p.uid)
  assert.equal(listCandidates(root).length, 0)
})

test('候选：拒绝就消失，不会偷偷绑上', () => {
  const root = tmpRoot()
  const p = createPerson(root, { display: '张三' })
  addCandidate(root, { uid: p.uid, platform: 'bili', id: '99' })
  rejectCandidate(root, 0)
  assert.equal(listCandidates(root).length, 0)
  assert.equal(findByIdentity(root, 'bili', '99'), null)
})

test('候选：同一个号不会重复进候选', () => {
  const root = tmpRoot()
  const p = createPerson(root, { display: '张三' })
  addCandidate(root, { uid: p.uid, platform: 'bili', id: '99' })
  const again = addCandidate(root, { uid: p.uid, platform: 'bili', id: '99' })
  assert.equal(again.added, false)
})

// ── 频道 → 人 ───────────────────────────────────────────────────────────

test('personForChannel：私聊能认出人，群聊不乱认', () => {
  const root = tmpRoot()
  const p = createPerson(root, { display: '张三' })
  linkIdentity(root, p.uid, { platform: 'qq', id: '12345' })

  assert.equal(personForChannel(root, 'private:12345'), p.uid)
  assert.equal(personForChannel(root, 'private:99999'), null)
  assert.equal(personForChannel(root, 'group:12345'), null, '群号不是人')
})

// ── 档案 ────────────────────────────────────────────────────────────────

test('profile：写入并读回，且进版本历史', () => {
  const root = tmpRoot()
  const p = createPerson(root, { display: '张三' })
  writeProfile(root, PID, p.uid, { sketch: '做 mod，晚上活跃', __reason: '手写素描' })

  const prof = readProfile(root, PID, p.uid)
  assert.equal(prof.sketch, '做 mod，晚上活跃')
  assert.equal(prof.__reason, undefined, '__reason 不该落盘')

  const h = history(root, `personas/${PID}/entities/people/${p.uid}.json`)
  assert.equal(h.length, 1)
})

test('profile：档案按人格隔离（同一个人，两个角色各记各的）', () => {
  const root = tmpRoot()
  const p = createPerson(root, { display: '张三' })
  writeProfile(root, PID, p.uid, { sketch: 'A 的印象' })

  pbCreate(root, 'ling2', '灵二')

  assert.equal(readProfile(root, 'ling2', p.uid), null, '另一个人格不该看到这份档案')
  assert.equal(readProfile(root, PID, p.uid).sketch, 'A 的印象')
})

test('group：写群档案并读回', () => {
  const root = tmpRoot()
  writeGroup(root, PID, '123456', { name: 'XX 游戏群', intro: '折腾 mod 的人', tone: '技术向' })
  const g = readGroup(root, PID, '123456')
  assert.equal(g.name, 'XX 游戏群')
  assert.equal(g.tone, '技术向')
})

// ── 关于某个人的第一次 ──────────────────────────────────────────────────

test('addFact：关于某人的第一条事实自动成为「最初」，第二条不是', () => {
  const root = tmpRoot()
  const p = createPerson(root, { display: '张三' })
  linkIdentity(root, p.uid, { platform: 'qq', id: '10001' })
  const src = seedRaw(root, '你好')

  const first = addFact(root, PID, { topic: '张三', text: '第一次跟张三说话', src, person: p.uid })
  assert.equal(first.fact.origin, true)
  assert.ok(readProfile(root, PID, p.uid).first_met, '应该记下 first_met')

  const second = addFact(root, PID, { topic: '张三', text: '后来张三搬家了', src, person: p.uid })
  assert.equal(second.fact.origin, false, '只有第一次算最初')
})

// ── 按对象注入 ──────────────────────────────────────────────────────────

test('contextFor：私聊带人档案', () => {
  const root = tmpRoot()
  const p = createPerson(root, { display: '张三' })
  linkIdentity(root, p.uid, { platform: 'qq', id: '12345' })
  writeProfile(root, PID, p.uid, { sketch: '说话短，爱用草' })

  const ctx = contextFor(root, PID, { channel: 'private:12345' })
  assert.match(ctx, /\[这个人\] 张三/)
  assert.match(ctx, /说话短/)
})

test('contextFor：群里带群档案', () => {
  const root = tmpRoot()
  writeGroup(root, PID, '555', { name: '摸鱼群', tone: '晚上活跃' })
  const ctx = contextFor(root, PID, { channel: 'group:555' })
  assert.match(ctx, /\[这个群\] 摸鱼群/)
  assert.match(ctx, /晚上活跃/)
})

test('contextFor：认不出对象时只有卡片，不硬编', () => {
  const root = tmpRoot()
  const ctx = contextFor(root, PID, { channel: 'private:99999' })
  assert.ok(!ctx.includes('[这个人]'))
  assert.match(ctx, /\[索引\]/)
})

// ── 切入补跑 ────────────────────────────────────────────────────────────

test('catchup：有上限地追平，多跑几次才追完', () => {
  const root = tmpRoot()
  for (let i = 0; i < 5; i += 1) {
    seedRaw(root, `第 ${i} 条`, localIso(new Date(Date.now() - (5 - i) * 60_000)))
  }
  assert.equal(catchUpStatus(root, PID).pending, 5)

  const r1 = catchUp(root, PID, { limit: 2 })
  assert.equal(r1.processed, 2)
  assert.equal(r1.remaining, 3)
  assert.equal(r1.done, false)

  const r2 = catchUp(root, PID, { limit: 2 })
  assert.equal(r2.processed, 2)
  assert.equal(r2.remaining, 1)

  const r3 = catchUp(root, PID, { limit: 2 })
  assert.equal(r3.processed, 1)
  assert.equal(r3.remaining, 0)
  assert.equal(r3.done, true)

  const r4 = catchUp(root, PID, { limit: 2 })
  assert.equal(r4.processed, 0, '追平后再跑不该重复处理')
})
