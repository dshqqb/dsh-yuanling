// test/p34.test.mjs —— v1.1：向模块要一次数据（source.fetch）。
//
// 这条链路的风险集中在一处：**数据要经过 ingest() 落 raw**，不能另开一条写盘路径。
// 所以这里既验"形状"（source 解析、上限、ext_id 必填），也验"真的落进 raw 且幂等"。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import zlib from 'node:zlib'

import { scaffold } from '../src/core/scaffold.js'
import { installFromBytes } from '../src/core/modules/installer.js'
import { setModuleGrantedAll } from '../src/core/modules/manage.js'
import { ModuleService } from '../src/core/modules/service.js'
import {
  listSources,
  resolveSource,
  normalizeReply,
  storeFetched,
  renderFetched,
  clipText,
  fetchedHash,
  FETCH_MAX_ITEMS,
} from '../src/core/modules/sources.js'
import { listDays, readDay } from '../src/core/raw.js'
import { handleApi } from '../src/core/api.js'

function tmpRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'yuanling-p34-'))
  scaffold(root, {})
  return root
}

function makeTar(files) {
  const blocks = []
  for (const [name, content] of Object.entries(files)) {
    const data = Buffer.from(content)
    const header = Buffer.alloc(512)
    header.write(name, 0, 'utf8')
    header.write(data.length.toString(8).padStart(11, '0'), 124, 'utf8')
    header.write('0', 156, 'utf8')
    blocks.push(header, data)
    const pad = (512 - (data.length % 512)) % 512
    if (pad) blocks.push(Buffer.alloc(pad))
  }
  blocks.push(Buffer.alloc(1024))
  return zlib.gzipSync(Buffer.concat(blocks))
}

const MANIFEST = {
  id: 'bili',
  name: 'B站',
  version: '0.1.0',
  api: '1.1',
  kind: 'enricher',
  entry: { command: ['node', 'index.mjs'] },
  capabilities: ['provide.source'],
  sources: [
    {
      id: 'bili.search_video',
      title: '按关键词搜 B 站视频',
      params: { type: 'object', properties: { q: { type: 'string' } }, required: ['q'] },
    },
  ],
}

function withModule({ grant = true } = {}) {
  const root = tmpRoot()
  installFromBytes({
    root,
    bytes: makeTar({ 'yuanling.module.json': JSON.stringify(MANIFEST, null, 2), 'index.mjs': 'export default {}' }),
    source: 'test',
  })
  if (grant) setModuleGrantedAll(root, 'bili', true)
  const svc = new ModuleService({ root })
  return { root, svc }
}

/** 假的模块进程：只实现 request，够验核心这一侧的全部分支。 */
function fakeProc(reply) {
  return { child: {}, request: async () => reply }
}

const OK_REPLY = {
  v: 1,
  source: 'bili',
  acct: 'default',
  items: [
    { ext_id: 'BV1xx411c7mD', ts: '2026-11-06T21:04:00+08:00', text: '原灵是什么', actor: { name: 'B站' } },
    { ext_id: 'BV1yy411c7mE', ts: '2026-11-07T10:00:00+08:00', text: '另一个视频', actor: { name: 'B站' } },
  ],
}

/**
 * 跨所有日目录数某个 source 的记录。
 * 取回的数据带**自己的事件时间**，两条可能落在不同的日目录里——
 * 这正是"保留原始时间戳"的意思，测试不能假设它们在同一天。
 */
function countAll(root, source) {
  return listDays(root).reduce((n, d) => n + readDay(root, d, { source }).length, 0)
}

// ── 解析与列表 ──────────────────────────────────────────────────────────

test('sources：列表只含声明了 sources 的模块，并带授权状态', () => {
  const { root } = withModule({ grant: false })
  const list = listSources(root)
  assert.equal(list.length, 1)
  assert.equal(list[0].module, 'bili')
  assert.equal(list[0].granted, false, '没授权要如实说，否则模型会以为是空的')
  assert.deepEqual(list[0].sources.map((s) => s.id), ['bili.search_video'])
})

test('sources：未知 source → E_NO_ROUTE（不猜、不模糊匹配）', () => {
  const { root } = withModule()
  assert.throws(() => resolveSource(root, 'nope.xxx'), (e) => e.code === 'E_NO_ROUTE')
  assert.throws(() => resolveSource(root, ''), (e) => e.code === 'E_BAD_REQUEST')
  assert.equal(resolveSource(root, 'bili.search_video').moduleId, 'bili')
})

// ── 信封校验 ────────────────────────────────────────────────────────────

test('reply：缺 ext_id 整批拒（没有稳定 id 就不可能有幂等）', () => {
  assert.throws(
    () =>
      normalizeReply({
        moduleId: 'bili',
        sourceId: 'bili.search_video',
        reply: { v: 1, items: [{ text: '没 id' }] },
      }),
    (e) => e.code === 'E_BAD_REQUEST' && /ext_id/.test(e.message),
  )
})

test('reply：超过上限只收前 20 条，并标记被截断', () => {
  const items = Array.from({ length: 25 }, (_, i) => ({ ext_id: `x${i}`, text: `t${i}` }))
  const r = normalizeReply({ moduleId: 'bili', sourceId: 'bili.search_video', reply: { v: 1, items } })
  assert.equal(r.items.length, FETCH_MAX_ITEMS)
  assert.equal(r.total, 25)
  assert.equal(r.truncated, true)
})

test('reply：版本不对是 E_PROTO，空正文拒', () => {
  assert.throws(
    () => normalizeReply({ moduleId: 'bili', sourceId: 'bili.search_video', reply: { v: 2, items: [] } }),
    (e) => e.code === 'E_PROTO',
  )
  assert.throws(
    () =>
      normalizeReply({
        moduleId: 'bili',
        sourceId: 'bili.search_video',
        reply: { v: 1, items: [{ ext_id: 'a', text: '   ' }] },
      }),
    (e) => e.code === 'E_BAD_REQUEST',
  )
})

test('reply：模块自报的 h 被丢弃（核心按 ext_id 自己算）', () => {
  const r = normalizeReply({
    moduleId: 'bili',
    sourceId: 'bili.search_video',
    reply: { v: 1, items: [{ ext_id: 'a', text: 'x', h: '模块想自定的指纹' }] },
  })
  assert.equal(r.items[0].h, undefined)
})

// ── 落 raw ──────────────────────────────────────────────────────────────

test('store：落进 raw，指针可用，来源由核心盖章', () => {
  const { root } = withModule()
  const { items } = normalizeReply({
    moduleId: 'bili',
    sourceId: 'bili.search_video',
    reply: OK_REPLY,
  })
  const { records } = storeFetched(root, {
    moduleId: 'bili',
    sourceId: 'bili.search_video',
    items,
    ackedAt: '2026-11-08T10:00:00+08:00',
  })

  assert.equal(records.length, 2)
  assert.match(records[0].ptr, /^raw\/\d{4}-\d{2}\/\d{2}\/bili\.ndjson#/)

  assert.equal(countAll(root, 'bili'), 2, '两条各自落在自己的事件日期下')
  const recs = listDays(root).flatMap((d) => readDay(root, d, { source: 'bili' }))
  assert.equal(recs[0].source, 'bili', 'source 以核心盖章为准')
  assert.equal(recs[0].ext.source, 'bili.search_video', '要留下是谁给的')
  assert.equal(recs[0].ext.ext_id, 'BV1xx411c7mD', 'ext_id 要留痕，排查幂等时全靠它')
  assert.ok(recs[0].flags.includes('fetched'))
})

test('store：同一个 ext_id 再取一次不会多一条（幂等靠核心算的 h）', () => {
  const { root } = withModule()
  const { items } = normalizeReply({ moduleId: 'bili', sourceId: 'bili.search_video', reply: OK_REPLY })

  const first = storeFetched(root, { moduleId: 'bili', sourceId: 'bili.search_video', items, ackedAt: '2026-11-08T10:00:00+08:00' })
  const second = storeFetched(root, { moduleId: 'bili', sourceId: 'bili.search_video', items, ackedAt: '2026-11-08T10:05:00+08:00' })

  assert.equal(second.counts.accepted, 0, '第二次不该再写')
  assert.equal(second.counts.deduped, 2)
  assert.equal(second.records[0].ptr, first.records[0].ptr, '去重后要指回原来那条')
  assert.equal(countAll(root, 'bili'), 2, 'raw 里还是 2 条，没被复制')
})

test('store：h 只由模块+source+ext_id 决定，跟正文变化无关', () => {
  const a = fetchedHash('bili', 'bili.search_video', 'BV1')
  assert.equal(a, fetchedHash('bili', 'bili.search_video', 'BV1'))
  assert.notEqual(a, fetchedHash('bili', 'bili.search_video', 'BV2'))
  assert.notEqual(a, fetchedHash('bili', 'bili.other', 'BV1'), '不同 source 的同一个 ext_id 是两条')
})

// ── 展示 ────────────────────────────────────────────────────────────────

test('render：每段都带来源章与指针；空结果也把话说清', () => {
  const text = renderFetched({
    sourceId: 'bili.search_video',
    records: [{ ts: '2026-11-06T21:04:00+08:00', actor: { name: 'B站' }, text: '原灵是什么', ptr: 'raw/2026-11/06/bili.ndjson#01ABC' }],
    total: 1,
  })
  assert.match(text, /bili\.search_video/)
  assert.match(text, /B站/)
  assert.match(text, /raw\/2026-11\/06\/bili\.ndjson#01ABC/)

  assert.match(renderFetched({ sourceId: 'x.y', records: [], total: 0 }), /没有返回任何数据/)
})

test('clipText：超预算才截断，且明说截了', () => {
  const small = clipText('短', 100)
  assert.equal(small.clipped, false)
  const big = clipText('长'.repeat(5000), 1024)
  assert.equal(big.clipped, true)
  assert.ok(Buffer.byteLength(big.text, 'utf8') < 1200)
  assert.match(big.text, /已截断/)
})

// ── service.fetchSource：门控与端到端 ───────────────────────────────────

test('service：没授予 provide.source → E_NO_CAP', async () => {
  const { svc } = withModule({ grant: false })
  svc.procs.set('bili', fakeProc(OK_REPLY))
  await assert.rejects(svc.fetchSource({ source: 'bili.search_video' }), (e) => e.code === 'E_NO_CAP')
})

test('service：模块没在跑 → E_NO_ROUTE（不返回空结果冒充"没有数据"）', async () => {
  const { svc } = withModule()
  await assert.rejects(svc.fetchSource({ source: 'bili.search_video' }), (e) => e.code === 'E_NO_ROUTE')
})

test('service：取数 → 落 raw → 回带指针的记录', async () => {
  const { root, svc } = withModule()
  svc.procs.set('bili', fakeProc(OK_REPLY))

  const r = await svc.fetchSource({ source: 'bili.search_video', params: { q: '原灵' } })
  assert.equal(r.sourceId, 'bili.search_video')
  assert.equal(r.records.length, 2)
  assert.equal(r.truncated, false)
  assert.match(r.records[0].ptr, /raw\/.+#/)

  assert.equal(countAll(root, 'bili'), 2)
})

test('service：一分钟内超过 10 次 → E_RATE', async () => {
  const { svc } = withModule()
  svc.procs.set('bili', fakeProc(OK_REPLY))
  for (let i = 0; i < 10; i += 1) {
    await svc.fetchSource({ source: 'bili.search_video', params: { q: `w${i}` } })
  }
  // 前 10 次用的是同一批 ext_id，被去重但计数照算——限频看的是调用次数
  await assert.rejects(svc.fetchSource({ source: 'bili.search_video' }), (e) => e.code === 'E_RATE')
})

// ── API ────────────────────────────────────────────────────────────────

test('API：GET /api/sources 给出可取的来源', () => {
  const { root } = withModule()
  const u = new URL('/api/sources', 'http://127.0.0.1')
  const r = handleApi(root, u)
  assert.equal(r.status, 200)
  assert.equal(r.body.sources.length, 1)
  assert.equal(r.body.sources[0].module, 'bili')
})
