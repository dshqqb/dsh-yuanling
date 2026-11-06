// test/p1.test.mjs —— L0 原始层：追加、去重、分片、封存、链校验、脱敏、投递、心跳、HTTP。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { P } from '../src/core/paths.js'
import { scaffold } from '../src/core/scaffold.js'
import { appendRecord, readDay, sealDay, verifyDay, dayDirFor, relDayDir, today, MAX_RAW_BYTES } from '../src/core/raw.js'
import { redact, applyIngestPolicy } from '../src/core/redact.js'
import { drain, ingest, beat, classifyHealth, healthReport } from '../src/core/inbox.js'
import { listen, readToken } from '../src/core/server.js'

function tmpRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'yuanling-p1-'))
  scaffold(root, {})
  return root
}

const TS = '2026-11-05T10:00:00+08:00'
const DAY = today(new Date(TS))

function rec(over = {}) {
  return {
    source: 'qq',
    acct: '10001',
    channel: 'group:123',
    actor: { kind: 'member', id: '20002', name: '张三' },
    role: 'user',
    text: '第一句',
    ts: TS,
    ...over,
  }
}

// ── 追加 ────────────────────────────────────────────────────────────────

test('append：写到 raw/YYYY-MM/DD/<source>.ndjson，并补齐 v/id/h', () => {
  const root = tmpRoot()
  const r = appendRecord(root, rec())
  assert.equal(r.ok, true)
  assert.equal(r.deduped, false)

  const file = path.join(dayDirFor(root, DAY), 'qq.ndjson')
  assert.ok(fs.existsSync(file), '文件没建出来')

  const line = fs.readFileSync(file, 'utf8').trim()
  const obj = JSON.parse(line)
  assert.equal(obj.v, 2)
  assert.match(obj.id, /^[0-9A-HJKMNP-TV-Z]{26}$/)
  assert.match(obj.h, /^sha256:[0-9a-f]{64}$/)
  assert.equal(obj.actor.kind, 'member')
  assert.equal(r.file, `${relDayDir(DAY)}/qq.ndjson`)
})

test('append：同一条内容重复投递只会写一次', () => {
  const root = tmpRoot()
  appendRecord(root, rec())
  const second = appendRecord(root, rec())
  assert.equal(second.deduped, true)
  assert.equal(readDay(root, DAY).length, 1)
})

test('append：超过阈值自动分片到 qq-p2.ndjson', () => {
  const root = tmpRoot()
  appendRecord(root, rec({ text: 'a' }), { maxBytes: 10 })
  appendRecord(root, rec({ text: 'b' }), { maxBytes: 10 })
  const dir = dayDirFor(root, DAY)
  assert.ok(fs.existsSync(path.join(dir, 'qq.ndjson')))
  assert.ok(fs.existsSync(path.join(dir, 'qq-p2.ndjson')))
})

test('readDay：能按来源过滤，坏行只跳过不抛', () => {
  const root = tmpRoot()
  appendRecord(root, rec({ source: 'qq', text: 'qq 的' }))
  appendRecord(root, rec({ source: 'bili', channel: 'bili:video:BV1', text: 'bili 的' }))

  assert.equal(readDay(root, DAY).length, 2)
  assert.equal(readDay(root, DAY, { source: 'qq' }).length, 1)
  assert.equal(readDay(root, DAY, { source: 'nope' }).length, 0)

  fs.appendFileSync(path.join(dayDirFor(root, DAY), 'qq.ndjson'), '{坏行\n', 'utf8')
  assert.equal(readDay(root, DAY, { source: 'qq' }).length, 1)
})

// ── 封存与链 ────────────────────────────────────────────────────────────

test('seal：写 day.json，含 lines/bytes/sha256，且再次封存是幂等的', () => {
  const root = tmpRoot()
  appendRecord(root, rec())
  const r = sealDay(root, DAY)
  assert.equal(r.sealed, true)

  const dj = JSON.parse(fs.readFileSync(path.join(dayDirFor(root, DAY), 'day.json'), 'utf8'))
  assert.equal(dj.date, DAY)
  assert.equal(dj.sealed, true)
  assert.equal(dj.files['qq.ndjson'].lines, 1)
  assert.match(dj.files['qq.ndjson'].sha256, /^sha256:/)

  const again = sealDay(root, DAY)
  assert.equal(again.sealed, false)
  assert.equal(again.reason, 'already-sealed')
})

test('verify：没被改过就是 ok', () => {
  const root = tmpRoot()
  appendRecord(root, rec())
  sealDay(root, DAY)
  const v = verifyDay(root, DAY)
  assert.equal(v.ok, true, JSON.stringify(v.errors))
})

test('verify：改一个字节就能抓到（HASH_MISMATCH）', () => {
  const root = tmpRoot()
  appendRecord(root, rec())
  sealDay(root, DAY)
  const f = path.join(dayDirFor(root, DAY), 'qq.ndjson')
  fs.chmodSync(f, 0o644)
  fs.appendFileSync(f, '{"v":2}\n', 'utf8')
  const v = verifyDay(root, DAY)
  assert.equal(v.ok, false)
  assert.ok(v.errors.some((e) => e.code === 'HASH_MISMATCH' || e.code === 'LINE_MISMATCH'))
})

test('verify：日链——前一天被改，后一天会报 CHAIN_BROKEN', () => {
  const root = tmpRoot()
  const d1 = '2026-11-05'
  const d2 = '2026-11-06'
  appendRecord(root, rec({ ts: `${d1}T10:00:00+08:00` }))
  appendRecord(root, rec({ ts: `${d2}T10:00:00+08:00`, text: '第二天' }))
  sealDay(root, d1)
  sealDay(root, d2)

  assert.equal(verifyDay(root, d2).ok, true)

  // 手改前一天的 day.json（模拟被篡改）
  const p = path.join(dayDirFor(root, d1), 'day.json')
  const dj = JSON.parse(fs.readFileSync(p, 'utf8'))
  dj.files['qq.ndjson'].lines = 999
  fs.writeFileSync(p, JSON.stringify(dj, null, 2) + '\n', 'utf8')

  const v = verifyDay(root, d2)
  assert.equal(v.ok, false)
  assert.ok(v.errors.some((e) => e.code === 'CHAIN_BROKEN'), JSON.stringify(v.errors))
})

// ── 脱敏与黑名单 ────────────────────────────────────────────────────────

test('redact：密钥无条件掩码', () => {
  const r = redact('我的 key 是 sk-abcdefghijklmnopqrstuvwxyz，别外传')
  assert.ok(!r.text.includes('sk-abcdefghijklmnopqrstuvwxyz'))
  assert.ok(r.text.includes('[已隐藏'))
  assert.ok(r.hits >= 1)
})

test('applyIngestPolicy：软黑名单入 raw 但标 hidden', () => {
  const rules = { soft_blacklist: ['八卦'], skip_channels: [] }
  const p = applyIngestPolicy('今天聊聊八卦', { channel: 'group:1', rules })
  assert.equal(p.skip, false)
  assert.deepEqual(p.flags, ['hidden'])
})

test('applyIngestPolicy：显式 skip 的内容完全不入 raw，只计数', () => {
  const root = tmpRoot()
  fs.writeFileSync(
    path.join(root, P.ingestRules),
    JSON.stringify({ version: 1, soft_blacklist: [], skip_channels: ['group:secret'] }, null, 2),
    'utf8',
  )
  const r = ingest(root, {
    v: 1,
    source: 'qq',
    acct: '10001',
    items: [{ ts: TS, channel: 'group:secret', actor: { kind: 'member', id: '1' }, kind: 'msg', text: '不该被记下' }],
  })
  assert.equal(r.skipped, 1)
  assert.equal(r.accepted, 0)
  assert.equal(readDay(root, DAY).length, 0, '被 skip 的内容不该落 raw')
})

// ── 投递与心跳 ──────────────────────────────────────────────────────────

test('drain：消费 inbox 文件后删除，内容进 raw', () => {
  const root = tmpRoot()
  const env = {
    v: 1,
    source: 'qq',
    acct: '10001',
    items: [
      { ts: TS, channel: 'group:1', actor: { kind: 'member', id: '1', name: '甲' }, kind: 'msg', text: '一' },
      { ts: TS, channel: 'group:1', actor: { kind: 'member', id: '2', name: '乙' }, kind: 'msg', text: '二' },
    ],
  }
  fs.writeFileSync(path.join(root, P.inbox, 'qq-1.ndjson'), JSON.stringify(env) + '\n', 'utf8')

  const r = drain(root)
  assert.equal(r.files, 1)
  assert.equal(r.accepted, 2)
  assert.equal(readDay(root, DAY).length, 2)
  assert.equal(fs.readdirSync(path.join(root, P.inbox)).filter((n) => n.endsWith('.ndjson')).length, 0)
})

test('ingest：未知版本拒收', () => {
  const root = tmpRoot()
  assert.throws(
    () => ingest(root, { v: 99, source: 'qq', acct: '1', items: [{ text: 'x' }] }),
    /不支持的 inbox 版本/,
  )
})

test('心跳：新鲜=ok、过期=silent、从没心跳=absent', () => {
  assert.equal(classifyHealth(null), 'absent')
  const fresh = { source: 'qq', at: new Date().toISOString(), last_event: new Date().toISOString() }
  assert.equal(classifyHealth(fresh), 'ok')
  const stale = { source: 'qq', at: new Date(Date.now() - 10 * 60_000).toISOString() }
  assert.equal(classifyHealth(stale), 'silent')
})

test('healthReport：列出已写心跳的来源', () => {
  const root = tmpRoot()
  beat(root, 'qq')
  const list = healthReport(root)
  assert.equal(list.length, 1)
  assert.equal(list[0].source, 'qq')
})

// ── HTTP ────────────────────────────────────────────────────────────────

test('HTTP：带 token 的 POST /inbox 能落盘，没 token 是 401', async () => {
  const root = tmpRoot()
  const token = readToken(root)
  const { server, port, url } = await listen(root, { port: 0 })
  try {
    const env = {
      v: 1,
      source: 'qq',
      acct: '10001',
      items: [{ ts: TS, channel: 'group:9', actor: { kind: 'owner', id: '10001', name: '主人' }, kind: 'msg', text: '从 HTTP 来的' }],
    }

    const bad = await fetch(`${url}/inbox`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(env),
    })
    assert.equal(bad.status, 401)

    const good = await fetch(`${url}/inbox`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-yuanling-token': token },
      body: JSON.stringify(env),
    })
    assert.equal(good.status, 200)
    const body = await good.json()
    assert.equal(body.accepted, 1)

    assert.equal(readDay(root, DAY).length, 1)
    assert.ok(port > 0)
  } finally {
    await new Promise((res) => server.close(res))
  }
})
