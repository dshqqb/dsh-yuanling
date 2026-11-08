// test/p38.test.mjs —— 管理台「来源」页：投递方心跳 + 模块能提供的数据（含取用统计）。
//
// 这里有一条**回归**要钉住：`/api/sources` 从 P8 起就是"投递方心跳"，v1.1 我曾把它
// 改成"模块数据源"，页面按心跳字段读，于是整页坏掉——而且没人会立刻发现。
// 所以两个接口各测各的，语义不许再混。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import zlib from 'node:zlib'

import { scaffold } from '../src/core/scaffold.js'
import { installFromBytes } from '../src/core/modules/installer.js'
import { setModuleGrantedAll } from '../src/core/modules/manage.js'
import { fetchStats, listSources } from '../src/core/modules/sources.js'
import { handleApi } from '../src/core/api.js'
import { appendRecord, today } from '../src/core/raw.js'
import { beat } from '../src/core/inbox.js'

const u = (p) => new URL(p, 'http://127.0.0.1')

const MANIFEST = {
  id: 'bili',
  name: 'B站',
  version: '0.1.0',
  api: '1.1',
  kind: 'enricher',
  entry: { command: ['node', 'index.mjs'] },
  capabilities: ['provide.source'],
  sources: [
    { id: 'bili.search_video', title: '按关键词搜视频' },
    { id: 'bili.video_subtitles', title: '拉字幕' },
  ],
}

function makeTar(files) {
  const blocks = []
  for (const [name, content] of Object.entries(files)) {
    const data = Buffer.from(content)
    const h = Buffer.alloc(512)
    h.write(name, 0, 'utf8')
    h.write(data.length.toString(8).padStart(11, '0'), 124, 'utf8')
    h.write('0', 156, 'utf8')
    blocks.push(h, data)
    const pad = (512 - (data.length % 512)) % 512
    if (pad) blocks.push(Buffer.alloc(pad))
  }
  blocks.push(Buffer.alloc(1024))
  return zlib.gzipSync(Buffer.concat(blocks))
}

function tmpRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'yuanling-p38-'))
  scaffold(root, {})
  return root
}

function withModule({ grant = true } = {}) {
  const root = tmpRoot()
  installFromBytes({
    root,
    bytes: makeTar({ 'yuanling.module.json': JSON.stringify(MANIFEST, null, 2), 'index.mjs': 'export default {}' }),
    source: 'test',
  })
  if (grant) setModuleGrantedAll(root, 'bili', true)
  return root
}

/** 造一条"取回来的"记录（核心侧就是这样落盘的）。 */
let seq = 0
function writeFetched(root, sourceId, { text = null, ts = null, fetchedAt = null } = {}) {
  seq += 1
  return appendRecord(root, {
    source: 'bili',
    channel: `module:${sourceId}`,
    actor: { kind: 'member', id: '', name: 'B站' },
    // 正文必须各不相同：raw 的内容哈希把 text/ts/channel 都算进去，一样的会被去重
    text: text ?? `示例 ${seq}`,
    ts: ts ?? `${today(new Date())}T10:00:00+08:00`,
    flags: ['fetched'],
    ext: {
      module: 'bili',
      source: sourceId,
      ext_id: `x-${seq}`,
      // 取回来的时刻；不给就当作老记录（没有这个字段）
      ...(fetchedAt ? { fetched_at: fetchedAt } : {}),
    },
  })
}

// ── 统计 ────────────────────────────────────────────────────────────────

test('统计：只数"取回来的"记录，普通消息不算', () => {
  const root = withModule()
  writeFetched(root, 'bili.search_video', { fetchedAt: '2026-11-08T22:00:00+08:00' })
  writeFetched(root, 'bili.search_video', { fetchedAt: '2026-11-08T22:05:00+08:00' })
  writeFetched(root, 'bili.video_subtitles', { fetchedAt: '2026-11-08T22:06:00+08:00' })
  // 一条普通投递（不是取数来的）
  appendRecord(root, { source: 'bili', channel: 'group:1', text: '普通消息' })

  const { stats } = fetchStats(root, ['bili.search_video', 'bili.video_subtitles'])
  assert.equal(stats['bili.search_video'].count, 2)
  assert.equal(stats['bili.video_subtitles'].count, 1)
  assert.equal(stats['bili.search_video'].lastAt, '2026-11-08T22:05:00+08:00')
  assert.equal(stats['bili.search_video'].lastAtApprox, false)
})

test('统计：从没取过的 source 计数为 0，且 lastAt 为空', () => {
  const root = withModule()
  const { stats } = fetchStats(root, ['bili.search_video', 'bili.video_subtitles'])
  assert.deepEqual(stats['bili.search_video'], { count: 0, lastAt: null, lastAtApprox: false, lastDay: null })
})

test('统计：lastAt 取最大的那个（不是最后读到的）', () => {
  const root = withModule()
  writeFetched(root, 'bili.search_video', { fetchedAt: '2026-11-01T10:00:00+08:00' })
  writeFetched(root, 'bili.search_video', { fetchedAt: '2026-11-05T10:00:00+08:00' })
  const { stats } = fetchStats(root, ['bili.search_video'])
  assert.match(stats['bili.search_video'].lastAt, /^2026-11-05/)
})

test('统计：用"取回来的时刻"，不是事件时间（否则取老视频会显示成它的发布日）', () => {
  const root = withModule()
  writeFetched(root, 'bili.search_video', { ts: '2023-04-17T10:00:00+08:00', fetchedAt: '2026-11-08T22:10:00+08:00' })
  const { stats } = fetchStats(root, ['bili.search_video'])
  assert.match(stats['bili.search_video'].lastAt, /^2026-11-08/, '取数时间才该被显示')
  // 记录本身仍落在**事件日期**的日目录里（保留原始时间是刻意的），所以 lastDay 是 2023-04-17
  assert.equal(stats['bili.search_video'].lastDay, '2023-04-17')
})

test('统计：老记录没有 fetched_at 时退回事件时间，并标成近似', () => {
  const root = withModule()
  writeFetched(root, 'bili.search_video', { ts: '2026-11-07T10:00:00+08:00' }) // 不给 fetchedAt
  const { stats } = fetchStats(root, ['bili.search_video'])
  assert.match(stats['bili.search_video'].lastAt, /^2026-11-07/)
  assert.equal(stats['bili.search_video'].lastAtApprox, true, '要让人知道这个时间是估的')
})

test('统计：超过字节上限就停，并如实标 partial（不假装数全）', () => {
  const root = withModule()
  for (let i = 0; i < 40; i += 1) writeFetched(root, 'bili.search_video', { text: 'x'.repeat(500) })

  const full = fetchStats(root, ['bili.search_video'])
  assert.equal(full.partial, false)

  const capped = fetchStats(root, ['bili.search_video'], { maxBytes: 1 })
  assert.equal(capped.partial, true)
  assert.ok(capped.daysScanned >= 1)
})

test('统计：坏行不影响统计（raw 里可能有半截写入）', () => {
  const root = withModule()
  writeFetched(root, 'bili.search_video')
  const dir = path.join(root, 'raw', today(new Date()).slice(0, 7), today(new Date()).slice(8, 10))
  fs.appendFileSync(path.join(dir, 'bili.ndjson'), '{"这不是合法 JSON"\n')
  const { stats } = fetchStats(root, ['bili.search_video'])
  assert.equal(stats['bili.search_video'].count, 1)
})

// ── 接口 ────────────────────────────────────────────────────────────────

test('回归：/api/sources 仍然是"投递方心跳"，不是模块数据源', () => {
  const root = withModule()
  beat(root, 'qq', { ok: true })

  const r = handleApi(root, u('/api/sources'))
  assert.equal(r.status, 200)
  const list = r.body.sources
  assert.ok(Array.isArray(list))
  assert.ok(list.every((s) => 'source' in s && 'state' in s), '每条必须是心跳形状（source/state）')
  assert.ok(list.some((s) => s.source === 'qq'), '要能看见刚才打过心跳的 qq')
  assert.ok(!list.some((s) => 'sources' in s), '不能把模块数据源混进这个接口')
})

test('/api/module-sources：给出模块、来源、授权状态与取用次数', () => {
  const root = withModule()
  writeFetched(root, 'bili.search_video')

  const r = handleApi(root, u('/api/module-sources'))
  assert.equal(r.status, 200)
  assert.equal(r.body.modules.length, 1)
  const m = r.body.modules[0]
  assert.equal(m.module, 'bili')
  assert.equal(m.moduleName, 'B站')
  assert.equal(m.granted, true)
  assert.equal(m.sources.length, 2)

  const search = m.sources.find((s) => s.id === 'bili.search_video')
  assert.equal(search.count, 1)
  assert.ok(search.lastDay, '要能说清落在哪天')
  const sub = m.sources.find((s) => s.id === 'bili.video_subtitles')
  assert.equal(sub.count, 0)
})

test('/api/module-sources：没授权也列出来（人要知道它差什么）', () => {
  const root = withModule({ grant: false })
  const r = handleApi(root, u('/api/module-sources'))
  const m = r.body.modules[0]
  assert.equal(m.granted, false)
  assert.equal(m.sources.length, 2)
})

test('/api/module-sources：没有模块时给空数组，不报错', () => {
  const root = tmpRoot()
  const r = handleApi(root, u('/api/module-sources'))
  assert.equal(r.status, 200)
  assert.deepEqual(r.body.modules, [])
})

test('listSources 仍是模块视图（页面与模型共用同一份声明）', () => {
  const root = withModule()
  const list = listSources(root)
  assert.equal(list[0].module, 'bili')
  assert.deepEqual(list[0].sources.map((s) => s.id), ['bili.search_video', 'bili.video_subtitles'])
})
