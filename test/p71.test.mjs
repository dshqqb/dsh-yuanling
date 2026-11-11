// test/p71.test.mjs —— 复制粘贴进来的新人格，要点亮就能用。
//
// 迁移方式定为"复制 personas/<id>/"，但如果只认根标记 yuanling.json，
// 复制进来的**新 id** 会"明明在目录里却看不见"——那迁移还是没做成。
import { test, before } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { scaffold } from '../src/core/scaffold.js'
import { createPersona, readMarker, listPersonas, switchPersona, reconcilePersonas } from '../src/core/persona.js'

let root

before(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'yuanling-p71-'))
  scaffold(root, {})
})

test('没登记的人格不会被凭空创建（只增不删、只认有 persona.json 的目录）', () => {
  // 一个空目录 + 一个半截目录（没有 persona.json）
  fs.mkdirSync(path.join(root, 'personas', 'halfcopy'), { recursive: true })
  const r = reconcilePersonas(root)
  assert.deepEqual(r.adopted, [], '没有 persona.json 的目录不算人格')
  assert.equal(listPersonas(root).some((p) => p.id === 'halfcopy'), false)

  // 从根标记里消失的人格（目录没了）也不该被删掉
  const before = readMarker(root).personas.length
  fs.rmSync(path.join(root, 'personas', '空'), { recursive: true, force: true })
  reconcilePersonas(root)
  assert.equal(readMarker(root).personas.length, before, '登记不该被删')
})

test('复制进来的新人格：认领 → 可切换 → 数据能读', () => {
  createPersona(root, 'source', '源人格')
  // 造一点数据：换名 + 一个状态文件
  const src = path.join(root, 'personas', 'source')
  fs.writeFileSync(path.join(src, 'state', 'prefs.json'), JSON.stringify({ gentleToAdmin: true }), 'utf8')

  // 模拟"复制粘贴迁移"到同一个数据目录里的新 id
  const copy = path.join(root, 'personas', 'copied')
  fs.cpSync(src, copy, { recursive: true })
  const manifest = JSON.parse(fs.readFileSync(path.join(copy, 'persona.json'), 'utf8'))
  manifest.id = 'copied'
  manifest.name = '复制来的人格'
  fs.writeFileSync(path.join(copy, 'persona.json'), JSON.stringify(manifest, null, 2) + '\n', 'utf8')

  // 认领之前：看不见
  assert.equal(listPersonas(root).some((p) => p.id === 'copied'), false)

  const r = reconcilePersonas(root)
  assert.deepEqual(r.adopted, ['copied'], `应该认领 copied，实际：${r.adopted.join(',')}`)

  const listed = listPersonas(root).find((p) => p.id === 'copied')
  assert.ok(listed, '认领之后应该出现在列表里')
  assert.equal(listed.name, '复制来的人格', '名字取 persona.json 里的')
  assert.equal(listed.dirExists, true)

  // 能切过去、能读到它的数据
  switchPersona(root, 'copied')
  assert.equal(readMarker(root).active, 'copied')
  assert.equal(fs.readFileSync(path.join(root, 'personas', 'copied', 'state', 'prefs.json'), 'utf8').includes('true'), true)
})

test('幂等：已经登记的不会重复加，也不制造新版本', () => {
  const before = readMarker(root).personas.length
  const r = reconcilePersonas(root)
  assert.deepEqual(r.adopted, [])
  assert.equal(readMarker(root).personas.length, before)
})

test('一个人格都没有时，认领的第一个会顺手设为激活', () => {
  const fresh = fs.mkdtempSync(path.join(os.tmpdir(), 'yuanling-p71-fresh-'))
  scaffold(fresh, {})
  const marker = readMarker(fresh)
  marker.active = null
  fs.writeFileSync(path.join(fresh, 'yuanling.json'), JSON.stringify(marker, null, 2) + '\n', 'utf8')

  const r = reconcilePersonas(fresh)
  assert.deepEqual(r.adopted, [], '已登记的人格不算认领')
  assert.equal(readMarker(fresh).active, 'yuanling', '没有激活时回落到第一个')
})
