// test/p46.test.mjs —— 统一事件流：日志与审计是同一批数据的两个镜头。
//
// 用户拍的两条：
//   ① 日志页只读一条事件流（不另建 audit.ndjson，不造第二个真相来源）；
//   ② 审计 = 其中"谁改了记忆、为什么、能不能退回去"的那一类，直接从 version journal 读。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { scaffold } from '../src/core/scaffold.js'
import {
  appendEvent,
  readEvents,
  readWrites,
  readTimeline,
  cleanupEvents,
  eventsHealth,
  eventsPath,
  EVENTS_MAX_BYTES,
  EVENTS_RETENTION_DAYS,
} from '../src/core/events.js'
import { writeGroup, readGroup } from '../src/core/groups.js'
import { ingest } from '../src/core/inbox.js'
import { logRefusal } from '../src/core/rules.js'

const PID = 'yuanling'

function tmpRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'yuanling-p46-'))
  scaffold(root, {})
  return root
}

const lines = (root) => (fs.existsSync(eventsPath(root)) ? fs.readFileSync(eventsPath(root), 'utf8').split('\n').filter(Boolean) : [])

// ── 写入 ────────────────────────────────────────────────────────────────

test('事件：写进去能读回来，字段齐全', () => {
  const root = tmpRoot()
  appendEvent(root, { kind: 'ingest', actor: 'source:qq', text: '接收 3 条', data: { accepted: 3 } })
  const got = readEvents(root, { limit: 10 })
  assert.equal(got.length, 1)
  const e = got[0]
  assert.equal(e.kind, 'ingest')
  assert.equal(e.level, 'info')
  assert.equal(e.actor, 'source:qq')
  assert.equal(e.text, '接收 3 条')
  assert.equal(e.v, 1)
  assert.equal(e.data.accepted, 3)
})

test('事件：缺 kind 直接拒（不写一条没类型的东西进流水）', () => {
  const root = tmpRoot()
  const r = appendEvent(root, { text: '没有 kind' })
  assert.equal(r.ok, false)
  assert.equal(lines(root).length, 0)
})

test('事件：未知的 kind 照写但标 ext（扩展不该被核心的清单卡住）', () => {
  const root = tmpRoot()
  appendEvent(root, { kind: 'something.new', text: 'x' })
  const e = readEvents(root, { limit: 5 })[0]
  assert.equal(e.kind, 'something.new')
  assert.equal(e.ext, true)
})

test('事件：level 只认 info/warn/error，乱写降级成 info', () => {
  const root = tmpRoot()
  appendEvent(root, { kind: 'error', level: 'fatal', text: 'x' })
  assert.equal(readEvents(root, { limit: 5 })[0].level, 'info')
})

test('事件：正文超长截到 2000 字（一条日志不该能塞满页面）', () => {
  const root = tmpRoot()
  appendEvent(root, { kind: 'error', text: 'あ'.repeat(3000) })
  assert.equal(readEvents(root, { limit: 5 })[0].text.length, 2000)
})

test('事件：写不进去不抛（返回 ok:false，但主流程不受影响）', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'yuanling-p46-bad-'))
  // 不 scaffold：system/log 建不出来也不授权，模拟"盘满/权限不对"
  const r = appendEvent(root, { kind: 'ingest', text: 'x' })
  assert.equal(typeof r.ok, 'boolean')
  if (!r.ok) {
    assert.match(r.error, /write|EACCES|ENOENT/i)
  }
  assert.equal(eventsHealth(root).writable, Boolean(r.ok))
})

// ── 轮转与保留 ──────────────────────────────────────────────────────────

test('轮转：主文件超过 1MB 就滚到 .1，最老的被删掉', () => {
  const root = tmpRoot()
  const big = 'x'.repeat(2000)
  // 直接造一个超了阈值的主文件，再写一条触发轮转
  fs.mkdirSync(path.dirname(eventsPath(root)), { recursive: true })
  const filler = `${JSON.stringify({ v: 1, ts: '2026-11-01T00:00:00+08:00', kind: 'ingest', level: 'info', actor: 'core', text: big })}\n`
  fs.writeFileSync(eventsPath(root), filler.repeat(Math.ceil(EVENTS_MAX_BYTES / filler.length) + 1), 'utf8')

  appendEvent(root, { kind: 'ingest', text: '触发轮转' })
  assert.ok(fs.existsSync(`${eventsPath(root)}.1`), '主文件应该被滚成 .1')
  assert.ok(fs.statSync(eventsPath(root)).size < EVENTS_MAX_BYTES, '轮转之后主文件应该变小')
  assert.equal(eventsHealth(root).rotatedAt !== null, true)
})

test('轮转：读过 .1 里的旧事件（轮转不等于丢历史）', () => {
  const root = tmpRoot()
  appendEvent(root, { kind: 'ingest', text: '旧的' })
  // 手工把主文件滚成 .1，再写一条新的
  fs.renameSync(eventsPath(root), `${eventsPath(root)}.1`)
  appendEvent(root, { kind: 'ingest', text: '新的' })

  const all = readEvents(root, { limit: 10 })
  assert.deepEqual(all.map((e) => e.text), ['旧的', '新的'], '按时间正序，跨分片也要拼对')
})

test('清理：超过 90 天的轮转文件被删，新鲜的不动', () => {
  const root = tmpRoot()
  fs.mkdirSync(path.dirname(eventsPath(root)), { recursive: true })
  const old = `${eventsPath(root)}.1`
  const fresh = `${eventsPath(root)}.2`
  fs.writeFileSync(old, '', 'utf8')
  fs.writeFileSync(fresh, '', 'utf8')
  const ancient = Date.now() - (EVENTS_RETENTION_DAYS + 1) * 86_400_000
  fs.utimesSync(old, ancient / 1000, ancient / 1000)

  const removed = cleanupEvents(root)
  assert.deepEqual(removed, [1])
  assert.equal(fs.existsSync(old), false)
  assert.equal(fs.existsSync(fresh), true, '没到期的轮转文件不能删')
})

// ── 审计镜头（读 journal，不读事件流）──────────────────────────────────

test('审计：写入事件从 journal 来，带 actor/reason/hash/prev', () => {
  const root = tmpRoot()
  writeGroup(root, PID, 'qq:555', { name: '摸鱼群' }, { actor: 'model:group', reason: '模型补写' })

  const w = readWrites(root, { limit: 10 })
  assert.equal(w.length, 1)
  assert.equal(w[0].kind, 'write')
  assert.equal(w[0].actor, 'model:group')
  assert.equal(w[0].reason, '模型补写')
  assert.match(w[0].path, /groups\/qq_555\.json/)
  assert.match(w[0].hash, /^sha256:/)
})

test('审计：删掉事件流也不影响审计（它读的是正本）', () => {
  const root = tmpRoot()
  writeGroup(root, PID, 'qq:555', { name: '摸鱼群' }, { actor: 'model:group', reason: '写入' })
  fs.rmSync(eventsPath(root), { force: true })
  const w = readWrites(root, { limit: 10 })
  assert.equal(w.length, 1, '事件流删了，审计还在——这才是"不造第二个真相来源"')
})

test('审计：能按 actor 过滤（谁改的）', () => {
  const root = tmpRoot()
  writeGroup(root, PID, 'qq:555', { name: 'a' }, { actor: 'model:group', reason: '模型写的' })
  writeGroup(root, PID, 'qq:555', { name: 'b' }, { actor: 'human:editor', reason: '人改的' })

  const human = readWrites(root, { actor: 'human:editor' })
  assert.equal(human.length, 1)
  assert.equal(human[0].reason, '人改的')
})

// ── 合并时间线 ──────────────────────────────────────────────────────────

test('时间线：all 把事件和写入并成一条（按时间正序）', () => {
  const root = tmpRoot()
  appendEvent(root, { kind: 'ingest', actor: 'source:qq', text: '接收 1 条', ts: '2026-11-01T10:00:00+08:00' })
  writeGroup(root, PID, 'qq:555', { name: 'x' }, { actor: 'model:group', reason: '写入' })

  const tl = readTimeline(root, { lens: 'all' })
  assert.equal(tl.items.length, 2)
  assert.deepEqual(tl.items.map((x) => x.kind).sort(), ['ingest', 'write'])
})

test('时间线：lens=write 就是审计（只有写入）', () => {
  const root = tmpRoot()
  appendEvent(root, { kind: 'ingest', text: '运行流水' })
  writeGroup(root, PID, 'qq:555', { name: 'x' }, { actor: 'model:group', reason: '写入' })

  const w = readTimeline(root, { lens: 'write' })
  assert.equal(w.items.length, 1)
  assert.equal(w.items[0].kind, 'write')
})

test('时间线：lens=error 只出 warn/error', () => {
  const root = tmpRoot()
  appendEvent(root, { kind: 'ingest', text: '正常' })
  appendEvent(root, { kind: 'error', level: 'error', text: '坏了' })
  appendEvent(root, { kind: 'refusal', level: 'warn', text: '被拒' })

  const e = readTimeline(root, { lens: 'error' })
  assert.deepEqual(e.items.map((x) => x.text).sort(), ['坏了', '被拒'].sort())
})

test('时间线：lens=module 只出模块相关，lens=refusal 只出拒绝', () => {
  const root = tmpRoot()
  appendEvent(root, { kind: 'module.start', module: 'bili', text: '启动' })
  appendEvent(root, { kind: 'refusal', level: 'warn', text: '被拒' })
  appendEvent(root, { kind: 'ingest', text: '普通' })

  assert.equal(readTimeline(root, { lens: 'module' }).items.length, 1)
  assert.equal(readTimeline(root, { lens: 'refusal' }).items.length, 1)
})

test('时间线：counts 是统计条（后期图形化读同一份）', () => {
  const root = tmpRoot()
  appendEvent(root, { kind: 'ingest', text: 'a' })
  appendEvent(root, { kind: 'error', level: 'error', text: 'b' })
  appendEvent(root, { kind: 'refusal', level: 'warn', text: 'c' })
  writeGroup(root, PID, 'qq:555', { name: 'x' })

  const tl = readTimeline(root, { lens: 'all' })
  assert.equal(tl.counts.events, 3)
  assert.equal(tl.counts.writes, 1)
  assert.equal(tl.counts.error, 1)
  assert.equal(tl.counts.warn, 1)
  assert.equal(tl.counts.refusals, 1)
})

test('时间线：空库不炸，返回空数组与零统计', () => {
  const root = tmpRoot()
  const tl = readTimeline(root, { lens: 'all' })
  assert.deepEqual(tl.items, [])
  assert.equal(tl.counts.total, 0)
})

// ── 自动写入点 ──────────────────────────────────────────────────────────

test('摄入：一批记一条事件（不是一条消息一条）', () => {
  const root = tmpRoot()
  const r = ingest(root, {
    v: 1,
    source: 'qq',
    acct: 'demo',
    items: [
      { ts: '2026-11-01T10:00:00+08:00', channel: 'group:1', actor: { kind: 'user', id: '1' }, role: 'user', kind: 'msg', text: 'a' },
      { ts: '2026-11-01T10:00:01+08:00', channel: 'group:1', actor: { kind: 'user', id: '1' }, role: 'user', kind: 'msg', text: 'b' },
    ],
  })
  assert.equal(r.accepted, 2)

  const ev = readEvents(root, { kind: 'ingest' })
  assert.equal(ev.length, 1, '两条消息应该合成一条摄入事件')
  assert.match(ev[0].text, /接收 2 条/)
  assert.equal(ev[0].actor, 'source:qq')
})

test('拒绝：logRefusal 同时进 changes 与事件流（读者不同，两处都要）', () => {
  const root = tmpRoot()
  logRefusal(root, PID, { dim: 'send', action: 'proactive', reason: '静默时段' })
  const ev = readEvents(root, { kind: 'refusal' })
  assert.equal(ev.length, 1)
  assert.equal(ev[0].level, 'warn')
  assert.match(ev[0].text, /静默时段/)
})
