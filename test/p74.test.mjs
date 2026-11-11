// test/p74.test.mjs —— 发图：egress.request 收指针、校验存在、换成临时文件随放行结果返回。
//
// 协议 §13 的最后一句：帧里不出现内部指针，模块只看得到临时文件路径。
import { test, before } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { scaffold } from '../src/core/scaffold.js'
import { createPerson, linkIdentity, writeProfile } from '../src/core/entities.js'
import { putMedia, mediaTmpDir } from '../src/core/media.js'
import { requestEgress, readEgress, EGRESS_MAX_MEDIA } from '../src/core/egress.js'

const PID = 'yuanling'
const MOD = 'fake-qq'
let root
let person
let tmp

function put(name, text) {
  const abs = path.join(tmp, name)
  fs.mkdirSync(tmp, { recursive: true })
  fs.writeFileSync(abs, text)
  const r = putMedia(root, { moduleId: MOD, path: abs, mime: 'image/png' })
  assert.equal(r.ok, true, r.message)
  return r.ptr
}

before(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'yuanling-p74-'))
  scaffold(root, {})
  person = createPerson(root, { display: '小李' })
  linkIdentity(root, person.uid, { platform: 'qq', id: '40004' })
  writeProfile(root, PID, person.uid, { sketch: '小李' })
  tmp = mediaTmpDir(root, MOD)
  fs.mkdirSync(tmp, { recursive: true })
})

test('放行：指针换成临时文件，路径/mime/大小/过期时间都在', () => {
  const ptr = put('a.png', 'image-bytes')
  const r = requestEgress(root, PID, {
    moduleId: MOD,
    channel: `private:${person.uid}`,
    text: '看图',
    media: [ptr],
  })
  assert.equal(r.ok, true)
  assert.equal(r.media.length, 1)
  const m = r.media[0]
  assert.ok(fs.existsSync(m.path), '临时文件应该真的存在')
  assert.equal(fs.readFileSync(m.path, 'utf8'), 'image-bytes')
  assert.equal(m.mime, 'image/png')
  assert.equal(m.size, 'image-bytes'.length)
  assert.ok(Date.parse(m.expires_at) > Date.now())
  // 帧里不该出现内部指针
  assert.ok(!m.path.includes('media:sha256:'))
})

test('账本只记张数，不记内容', () => {
  const rows = readEgress(root, PID, { limit: 10 })
  const last = rows.at(-1)
  assert.equal(last.media, 1)
  assert.equal(last.text, undefined, '账本不记正文')
})

test('只有媒体、没有文字也放行（发图不说话是正常行为）', () => {
  const ptr = put('b.png', 'only-image')
  const r = requestEgress(root, PID, { moduleId: MOD, channel: `private:${person.uid}`, text: '', media: [ptr] })
  assert.equal(r.ok, true)
  assert.equal(r.media.length, 1)
})

test('校验：指针格式不认识 / 文件不存在 / 超过张数上限', () => {
  const bad = requestEgress(root, PID, { moduleId: MOD, channel: `private:${person.uid}`, text: 'x', media: ['not-a-ptr'] })
  assert.equal(bad.code, 'E_MEDIA')

  const missing = requestEgress(root, PID, {
    moduleId: MOD,
    channel: `private:${person.uid}`,
    text: 'x',
    media: [`media:sha256:${'a'.repeat(64)}.png`],
  })
  assert.equal(missing.code, 'E_MEDIA')

  const tooMany = requestEgress(root, PID, {
    moduleId: MOD,
    channel: `private:${person.uid}`,
    text: 'x',
    media: Array.from({ length: EGRESS_MAX_MEDIA + 1 }, () => put('c.png', 'dup')),
  })
  assert.equal(tooMany.code, 'E_MEDIA')
})

test('既没有文字也没有媒体 → E_EMPTY', () => {
  const r = requestEgress(root, PID, { moduleId: MOD, channel: `private:${person.uid}`, text: '', media: [] })
  assert.equal(r.code, 'E_EMPTY')
})

test('接受 {ptr} 形状（模块两种写法都自然）', () => {
  const ptr = put('d.png', 'object-form')
  const r = requestEgress(root, PID, { moduleId: MOD, channel: `private:${person.uid}`, text: 'x', media: [{ ptr }] })
  assert.equal(r.ok, true)
  assert.equal(r.media.length, 1)
})
