// test/p72.test.mjs —— 媒体入库/出库（协议 §13）。
//
// 规矩（协议里写死的）：
//   · 模块只碰自己的临时目录；路径/大小/mime 由核心校验；
//   · 内容寻址去重；命中归档会搬回热库；指针永不过期（两处都找）；
//   · 出站给的是**临时文件**，帧里不出现内部指针；
//   · 单文件 20MB、mime 白名单、20 次/分钟。
import { test, before } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { scaffold } from '../src/core/scaffold.js'
import {
  putMedia,
  getMedia,
  mediaTmpDir,
  mediaArchiveDir,
  parseMediaPointer,
  MEDIA_MAX_BYTES,
  mediaStats,
} from '../src/core/media.js'
import { moduleHandlers } from '../src/core/modules/wire.js'
import { ModuleService } from '../src/core/modules/service.js'
import { writeRegistry } from '../src/core/modules/registry.js'

const PID = 'yuanling'
const MOD = 'fake-media'
let root
let tmp

function writeTmp(name, bytes, mimeExt = 'png') {
  const abs = path.join(tmp, name)
  fs.mkdirSync(tmp, { recursive: true })
  fs.writeFileSync(abs, bytes)
  return abs
}

before(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'yuanling-p72-'))
  scaffold(root, {})
  tmp = mediaTmpDir(root, MOD)
  fs.mkdirSync(tmp, { recursive: true })
})

test('入库：算 hash、落到 media/sha256/、删掉源文件、返回指针', () => {
  const src = writeTmp('a.png', Buffer.from('hello-media'))
  const r = putMedia(root, { moduleId: MOD, path: src, mime: 'image/png' })
  assert.equal(r.ok, true)
  assert.match(r.ptr, /^media:sha256:[a-f0-9]{64}\.png$/)
  assert.equal(fs.existsSync(src), false, '源临时文件应被收走')

  const parsed = parseMediaPointer(r.ptr)
  const stored = path.join(root, 'media', 'sha256', parsed.hash.slice(0, 2), parsed.hash.slice(2, 4), `${parsed.hash}.png`)
  assert.equal(fs.existsSync(stored), true)
  assert.equal(fs.readFileSync(stored, 'utf8'), 'hello-media')
})

test('去重：同内容不同文件只存一份', () => {
  const before = mediaStats(root).files
  const src = writeTmp('b.png', Buffer.from('hello-media'))
  const r = putMedia(root, { moduleId: MOD, path: src, mime: 'image/png' })
  assert.equal(r.ok, true)
  assert.equal(mediaStats(root).files, before, '同 hash 不该多一个文件')
})

test('出站：给临时文件路径 + 过期时间，读得到内容', () => {
  const src = writeTmp('c.png', Buffer.from('roundtrip'))
  const put = putMedia(root, { moduleId: MOD, path: src, mime: 'image/png' })
  const got = getMedia(root, { moduleId: MOD, ptr: put.ptr })
  assert.equal(got.ok, true)
  assert.ok(got.path.startsWith(tmp), '应该落在模块自己的临时目录里')
  assert.equal(fs.readFileSync(got.path, 'utf8'), 'roundtrip')
  assert.equal(got.mime, 'image/png')
  assert.equal(got.size, 'roundtrip'.length)
  assert.ok(Date.parse(got.expires_at) > Date.now())
})

test('归档：热库找不到就去归档找（指针永不过期）', () => {
  const src = writeTmp('d.png', Buffer.from('archived-content'))
  const put = putMedia(root, { moduleId: MOD, path: src, mime: 'image/png' })
  const parsed = parseMediaPointer(put.ptr)
  const hot = path.join(root, 'media', 'sha256', parsed.hash.slice(0, 2), parsed.hash.slice(2, 4), `${parsed.hash}.png`)
  const cold = path.join(root, 'media-archive', 'sha256', parsed.hash.slice(0, 2), parsed.hash.slice(2, 4), `${parsed.hash}.png`)
  fs.mkdirSync(path.dirname(cold), { recursive: true })
  fs.renameSync(hot, cold)

  const got = getMedia(root, { moduleId: MOD, ptr: put.ptr })
  assert.equal(got.ok, true)
  assert.equal(fs.readFileSync(got.path, 'utf8'), 'archived-content')
})

test('归档复活：同一内容再次入库，从归档搬回热库（不留两份）', () => {
  const src = writeTmp('e.png', Buffer.from('come-back'))
  const put = putMedia(root, { moduleId: MOD, path: src, mime: 'image/png' })
  const parsed = parseMediaPointer(put.ptr)
  const hot = path.join(root, 'media', 'sha256', parsed.hash.slice(0, 2), parsed.hash.slice(2, 4), `${parsed.hash}.png`)
  const cold = path.join(root, 'media-archive', 'sha256', parsed.hash.slice(0, 2), parsed.hash.slice(2, 4), `${parsed.hash}.png`)
  fs.mkdirSync(path.dirname(cold), { recursive: true })
  fs.renameSync(hot, cold)

  const again = writeTmp('f.png', Buffer.from('come-back'))
  const r = putMedia(root, { moduleId: MOD, path: again, mime: 'image/png' })
  assert.equal(r.ok, true)
  assert.equal(fs.existsSync(hot), true, '应该搬回热库')
  assert.equal(fs.existsSync(cold), false, '归档里不该留副本')
  assert.equal(mediaArchiveDir(root).length > 0, true)
})

test('校验：路径必须在自己的临时目录里（不许读别处）', () => {
  const outside = path.join(root, 'media', 'x.png')
  fs.mkdirSync(path.dirname(outside), { recursive: true })
  fs.writeFileSync(outside, Buffer.from('nope'))
  const r = putMedia(root, { moduleId: MOD, path: outside, mime: 'image/png' })
  assert.equal(r.ok, false)
  assert.equal(r.code, 'E_BAD_PATH')
})

test('校验：mime 白名单 / 大小上限 / 指针格式', () => {
  const src = writeTmp('g.bin', Buffer.from('x'))
  assert.equal(putMedia(root, { moduleId: MOD, path: src, mime: 'application/x-msdownload' }).code, 'E_MIME')

  const big = writeTmp('big.png', Buffer.alloc(MEDIA_MAX_BYTES + 1))
  const r = putMedia(root, { moduleId: MOD, path: big, mime: 'image/png' })
  assert.equal(r.code, 'E_TOO_LARGE')
  fs.unlinkSync(big)

  assert.equal(getMedia(root, { moduleId: MOD, ptr: 'media:sha256:notahash.png' }).code, 'E_PTR')
  assert.equal(getMedia(root, { moduleId: MOD, ptr: 'media:sha256:' + 'a'.repeat(64) + '.png' }).code, 'E_PTR')
})

test('协议路径：假模块走 media.put.file / media.get（能力门控 + 限频）', async () => {
  const svc = new ModuleService({ root, pid: PID, ...moduleHandlers({ root, pid: PID }) })

  writeRegistry(root, { version: 1, modules: { [MOD]: { id: MOD, capabilities: ['media.put.file', 'media.read'], granted: [] } } })
  await assert.rejects(
    svc.handleModuleRequest(MOD, { op: 'media.put.file', data: { path: writeTmp('h.png', Buffer.from('x')), mime: 'image/png' } }),
    /能力未授予：media.put.file/,
  )

  writeRegistry(root, { version: 1, modules: { [MOD]: { id: MOD, capabilities: ['media.put.file', 'media.read'], granted: ['media.put.file', 'media.read'] } } })
  const put = await svc.handleModuleRequest(MOD, { op: 'media.put.file', data: { path: writeTmp('i.png', Buffer.from('via-protocol')), mime: 'image/png' } })
  assert.equal(put.ok, true)
  const got = await svc.handleModuleRequest(MOD, { op: 'media.get', data: { ptr: put.ptr } })
  assert.equal(got.ok, true)
  assert.equal(fs.readFileSync(got.path, 'utf8'), 'via-protocol')

  // 限频：一分钟内第 21 次被拒
  let last
  for (let i = 0; i < 25; i += 1) {
    const p = writeTmp(`rate-${i}.png`, Buffer.from(`rate-${i}`))
    last = await svc.handleModuleRequest(MOD, { op: 'media.put.file', data: { path: p, mime: 'image/png' } }).catch((e) => e)
    if (last?.code === 'E_RATE') break
  }
  assert.equal(last?.code, 'E_RATE', '第 21 次之后应该被限频')
})
