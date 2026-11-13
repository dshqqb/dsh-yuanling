// test/p9.test.mjs —— 身份主张：自述确认、他人转述进候选、推断、纠错。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { scaffold } from '../src/core/scaffold.js'
import { appendRecord } from '../src/core/raw.js'
import { localIso } from '../src/core/fsx.js'
import { addFact, listEntries } from '../src/core/memory.js'
import { findByIdentity, createPerson, listCandidates, confirmCandidate } from './helpers.mjs'
import {
  extractClaims,
  claimIdentity,
  inferIdentityCandidates,
  applyInferredCandidates,
  correctIdentity,
} from '../src/core/identity.js'

const PID = 'yuanling'

function tmpRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'yuanling-p9-'))
  scaffold(root, {})
  return root
}

function seedRaw(root, { text = '一句话', channel = 'private:10001', name = '主人', id = '10001', source = 'qq' } = {}) {
  const r = appendRecord(root, {
    source,
    acct: '10001',
    channel,
    actor: { kind: 'owner', id, name },
    role: 'user',
    text,
    ts: localIso(),
  })
  return `${r.file}#${r.id}`
}

// ── 主张抽取 ────────────────────────────────────────────────────────────

test('extractClaims：认「我 b 站是 X」「我 QQ 是 Y」', () => {
  assert.deepEqual(extractClaims('我的b站是 abc123'), [{ platform: 'bili', id: 'abc123' }])
  assert.deepEqual(extractClaims('我 QQ 是 12345678'), [{ platform: 'qq', id: '12345678' }])
  assert.deepEqual(extractClaims('今天天气不错'), [])
})

// ── 自述确认 ────────────────────────────────────────────────────────────

test('claim：owner 私聊自述 → 直接确认并绑定', () => {
  const root = tmpRoot()
  const src = seedRaw(root)

  const r = claimIdentity(root, PID, {
    platform: 'bili',
    id: 'abc123',
    channel: 'private:10001',
    speakerKind: 'owner',
    text: '我的b站是 abc123',
    src,
  })

  assert.equal(r.state, 'confirmed')
  assert.ok(r.uid)
  assert.equal(findByIdentity(root, 'bili', 'abc123').uid, r.uid)
  // 本人 qq 也绑到同一个人
  assert.equal(findByIdentity(root, 'qq', '10001').uid, r.uid)
})

test('claim：会写一条 identity-claim 事实（带证据）', () => {
  const root = tmpRoot()
  const src = seedRaw(root)
  const r = claimIdentity(root, PID, {
    platform: 'bili',
    id: 'abc123',
    channel: 'private:10001',
    text: '我的b站是 abc123',
    src,
  })

  const entries = listEntries(root, PID)
  const fact = entries.flatMap((e) => e.facts).find((f) => f.kind === 'identity-claim')
  assert.ok(fact, '应该有一条身份主张事实')
  assert.equal(fact.src, src)
  assert.equal(fact.slot, 'bili-id')
  assert.equal(fact.person, r.uid)
})

test('claim：重复自述同一账号是幂等的', () => {
  const root = tmpRoot()
  const src = seedRaw(root)
  const a = claimIdentity(root, PID, { platform: 'bili', id: 'abc123', channel: 'private:10001', src })
  const b = claimIdentity(root, PID, { platform: 'bili', id: 'abc123', channel: 'private:10001', src })
  assert.equal(b.changed, false)
  assert.equal(b.uid, a.uid)
})

test('claim：没有证据指针就拒绝', () => {
  const root = tmpRoot()
  assert.throws(
    () => claimIdentity(root, PID, { platform: 'bili', id: 'abc', channel: 'private:1' }),
    /证据指针/,
  )
})

// ── 他人转述 / 群聊 → 候选 ──────────────────────────────────────────────

test('claim：别人转述的 → 只进候选，不绑定', () => {
  const root = tmpRoot()
  const src = seedRaw(root)
  const r = claimIdentity(root, PID, {
    platform: 'bili',
    id: 'zzz999',
    channel: 'private:10001',
    speakerKind: 'member',
    text: '张三说他的b站是 zzz999',
    src,
  })
  assert.equal(r.state, 'pending')
  assert.equal(findByIdentity(root, 'bili', 'zzz999'), null)
  assert.equal(listCandidates(root).length, 1)
})

test('claim：群聊里的自述也不采信（可能冒充）', () => {
  const root = tmpRoot()
  const src = seedRaw(root, { channel: 'group:123' })
  const r = claimIdentity(root, PID, {
    platform: 'bili',
    id: 'qqq777',
    channel: 'group:123',
    speakerKind: 'owner',
    text: '这是我小号',
    src,
  })
  assert.equal(r.state, 'pending')
  assert.equal(findByIdentity(root, 'bili', 'qqq777'), null)
})

test('候选：确认时可以显式指定属于谁', () => {
  const root = tmpRoot()
  const src = seedRaw(root)
  claimIdentity(root, PID, { platform: 'bili', id: 'zzz999', channel: 'group:1', speakerKind: 'member', src })

  const p = createPerson(root, { display: '张三' })
  confirmCandidate(root, 0, { uid: p.uid })
  assert.equal(findByIdentity(root, 'bili', 'zzz999').uid, p.uid)
})

// ── 推断 ────────────────────────────────────────────────────────────────

test('infer：同一个昵称出现在两个平台 → 出一组候选', () => {
  const root = tmpRoot()
  seedRaw(root, { text: 'qq 说的一句', channel: 'group:1', name: '张三', id: '111', source: 'qq' })
  seedRaw(root, { text: 'bili 说的一句', channel: 'bili:video:BV1', name: '张三', id: '222', source: 'bili' })

  const list = inferIdentityCandidates(root)
  assert.equal(list.length, 1)
  assert.equal(list[0].identities.length, 2)
  const platforms = list[0].identities.map((i) => i.platform).sort()
  assert.deepEqual(platforms, ['bili', 'qq'])
})

test('infer：只推断，不自动合并', () => {
  const root = tmpRoot()
  seedRaw(root, { channel: 'group:1', name: '张三', id: '111' })
  seedRaw(root, { channel: 'bili:video:BV1', name: '张三', id: '222', source: 'bili' })

  const before = listCandidates(root).length
  const r = applyInferredCandidates(root, PID)
  assert.ok(r.added >= 2)
  assert.equal(listCandidates(root).length, before + r.added)
  assert.equal(findByIdentity(root, 'bili', '222'), null, '推断不能直接绑定')
})

test('infer：单个平台上的同名不算', () => {
  const root = tmpRoot()
  seedRaw(root, { channel: 'group:1', name: '张三', id: '111' })
  seedRaw(root, { channel: 'group:2', name: '张三', id: '111' })
  assert.equal(inferIdentityCandidates(root).length, 0)
})

// ── 纠错 ────────────────────────────────────────────────────────────────

test('correct：拆出错绑的账号，并关闭旧主张（不删）', () => {
  const root = tmpRoot()
  const src = seedRaw(root)
  const r = claimIdentity(root, PID, {
    platform: 'bili',
    id: 'abc123',
    channel: 'private:10001',
    text: '我的b站是 abc123',
    src,
  })

  const fixed = correctIdentity(root, PID, {
    uid: r.uid,
    platform: 'bili',
    id: 'abc123',
    reason: '本人说那不是他的号',
  })

  assert.equal(fixed.from, r.uid)
  assert.notEqual(fixed.to, r.uid)
  assert.equal(findByIdentity(root, 'bili', 'abc123').uid, fixed.to)
  assert.equal(findByIdentity(root, 'qq', '10001').uid, r.uid, 'qq 不该被一起拆走')

  const fact = listEntries(root, PID).flatMap((e) => e.facts).find((f) => f.kind === 'identity-claim')
  assert.ok(fact.until, '旧主张应该被关闭而不是删除')
  assert.deepEqual(fixed.closedFacts, [fact.id])
})

test('correct：账号不存在时明确报错', () => {
  const root = tmpRoot()
  assert.throws(
    () => correctIdentity(root, PID, { platform: 'bili', id: 'nope' }),
    /没有找到/,
  )
})

// ── 普通事实的 kind ─────────────────────────────────────────────────────

test('addFact：默认 kind 是 fact，可以显式指定', () => {
  const root = tmpRoot()
  const src = seedRaw(root)
  const a = addFact(root, PID, { topic: '杂事', text: '普通一条', src })
  assert.equal(a.fact.kind, 'fact')

  const b = addFact(root, PID, { topic: '杂事', text: '一条判断', src, kind: 'preference' })
  assert.equal(b.fact.kind, 'preference')
})
