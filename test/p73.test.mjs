// test/p73.test.mjs —— 媒体归档：先给清单，确认才搬；指针不会失效。
//
// 规矩：
//   · 默认只出计划（dry run），`--apply` 才搬；
//   · 搬走之后 `media.get` 仍然读得到（热库找不到就去归档找）；
//   · 清单里给出 raw 引用数，但**不用它做拦截**（指针永不过期）；
//   · 幂等：搬过的再跑一次跳过。
import { test, before } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { scaffold } from '../src/core/scaffold.js'
import { appendRecord } from '../src/core/raw.js'
import { localIso } from '../src/core/fsx.js'
import {
  putMedia,
  getMedia,
  listMedia,
  mediaStats,
  planArchive,
  applyArchive,
  mediaTmpDir,
  parseMediaPointer,
} from '../src/core/media.js'

const DAY = 86_400_000
let root
let tmp

function put(name, text, mime = 'image/png') {
  const abs = path.join(tmp, name)
  fs.mkdirSync(tmp, { recursive: true })
  fs.writeFileSync(abs, text)
  const r = putMedia(root, { moduleId: 'm', path: abs, mime })
  assert.equal(r.ok, true, `入库失败：${r.message ?? ''}`)
  return r
}

/** 把热库里某个 hash 的文件时间改成 N 天前。 */
function ageFile(ptr, days) {
  const p = parseMediaPointer(ptr)
  const abs = path.join(root, 'media', 'sha256', p.hash.slice(0, 2), p.hash.slice(2, 4), `${p.hash}.${p.ext}`)
  const t = Date.now() - days * DAY
  fs.utimesSync(abs, new Date(t), new Date(t))
}

before(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'yuanling-p73-'))
  scaffold(root, {})
  tmp = mediaTmpDir(root, 'm')
  fs.mkdirSync(tmp, { recursive: true })
})

test('计划：只列出超过阈值的文件，新文件不动', () => {
  const oldOne = put('old.png', 'old-content')
  const fresh = put('fresh.png', 'fresh-content')
  ageFile(oldOne.ptr, 400)

  const plan = planArchive(root, { olderThanMs: 365 * DAY })
  assert.deepEqual(plan.files.map((f) => f.ptr), [oldOne.ptr])
  assert.ok(!plan.files.some((f) => f.ptr === fresh.ptr))
  assert.ok(plan.totalBytes > 0)
  assert.match(plan.oldest, /^\d{4}-\d{2}-\d{2}T/)
})

test('计划是 dry run：跑完热库一个都没少', () => {
  const before = mediaStats(root)
  planArchive(root, { olderThanMs: 365 * DAY })
  const after = mediaStats(root)
  assert.equal(after.files, before.files, '看清单不该动文件')
})

test('清单里有 raw 引用数，但只是给人看的', () => {
  const one = put('ref.png', 'referenced-by-raw')
  ageFile(one.ptr, 500)
  appendRecord(root, {
    source: 'qq',
    acct: '1',
    channel: 'private:person_x',
    type: 'message',
    role: 'user',
    actor: { kind: 'owner', id: '1', name: '主人' },
    text: '看图',
    media: [one.ptr],
    ts: localIso(),
  })
  const plan = planArchive(root, { olderThanMs: 365 * DAY })
  const row = plan.files.find((f) => f.ptr === one.ptr)
  assert.ok(row)
  assert.ok(row.refs >= 1, `应该数到 raw 引用：${row.refs}`)
})

test('执行：文件搬进 media-archive/，索引记 archive，get 仍然读得到', () => {
  const one = put('archive-me.png', 'archive-me')
  ageFile(one.ptr, 400)
  const plan = planArchive(root, { olderThanMs: 365 * DAY })
  const r = applyArchive(root, plan)
  assert.ok(r.moved.includes(one.ptr))

  const p = parseMediaPointer(one.ptr)
  const hot = path.join(root, 'media', 'sha256', p.hash.slice(0, 2), p.hash.slice(2, 4), `${p.hash}.${p.ext}`)
  const cold = path.join(root, 'media-archive', 'sha256', p.hash.slice(0, 2), p.hash.slice(2, 4), `${p.hash}.${p.ext}`)
  assert.equal(fs.existsSync(hot), false)
  assert.equal(fs.existsSync(cold), true)

  const got = getMedia(root, { moduleId: 'm', ptr: one.ptr })
  assert.equal(got.ok, true, '归档之后还要读得到（指针永不过期）')
  assert.equal(fs.readFileSync(got.path, 'utf8'), 'archive-me')
})

test('幂等：同一份计划再跑一次，已经搬过的跳过', () => {
  const one = put('already.png', 'already-moved')
  ageFile(one.ptr, 400)
  const plan = planArchive(root, { olderThanMs: 365 * DAY })
  const first = applyArchive(root, plan)
  assert.ok(first.moved.includes(one.ptr))

  // 重新算一次计划：热库里已经没有它了，所以计划里不会再有
  const plan2 = planArchive(root, { olderThanMs: 365 * DAY })
  assert.ok(!plan2.files.some((f) => f.ptr === one.ptr))
  const second = applyArchive(root, plan2)
  assert.equal(second.moved.length, 0)
})

test('统计：热库与归档分开报', () => {
  const s = mediaStats(root)
  assert.ok(s.files > 0)
  assert.ok(s.archivedFiles > 0, '归档里应该有文件了')
  assert.ok(s.bytes > 0 && s.archivedBytes > 0)
})

test('listMedia：热库列表带指针与时间', () => {
  const rows = listMedia(root)
  assert.ok(rows.length > 0)
  const row = rows[0]
  assert.match(row.ptr, /^media:sha256:/)
  assert.ok(row.size > 0)
  assert.ok(row.mtimeMs > 0)
})
