// test/p2.test.mjs —— 版本与审计：blob、journal、回滚、外部编辑检测、作用域。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { P } from '../src/core/paths.js'
import { scaffold } from '../src/core/scaffold.js'
import {
  writeTracked,
  snapshotCurrent,
  history,
  revertTo,
  scanExternalEdits,
  headFor,
  scopeOf,
  stats,
  trackedPaths,
  readBlob,
} from '../src/core/version.js'

function tmpRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'yuanling-p2-'))
  scaffold(root, {})
  return root
}

const REL = 'guardrails.json'

// ── 写入与 blob ─────────────────────────────────────────────────────────

test('writeTracked：写盘 + 存 blob + 记 journal', () => {
  const root = tmpRoot()
  const r = writeTracked(root, REL, '{"a":1}\n', { actor: 'human:editor', reason: '首次' })
  assert.equal(r.changed, true)
  assert.equal(r.prev, null)

  assert.equal(fs.readFileSync(path.join(root, REL), 'utf8'), '{"a":1}\n')

  const h = history(root, REL)
  assert.equal(h.length, 1)
  assert.equal(h[0].kind, 'create')
  assert.equal(h[0].path, REL)
  assert.equal(h[0].reason, '首次')
  assert.ok(readBlob(root, REL, h[0].hash), 'blob 应该能读回来')
})

test('writeTracked：第二次写会记下 prev 链', () => {
  const root = tmpRoot()
  const a = writeTracked(root, REL, 'v1\n')
  const b = writeTracked(root, REL, 'v2\n')
  assert.equal(b.prev, a.hash)

  const h = history(root, REL)
  assert.equal(h.length, 2)
  assert.equal(h[1].prev, h[0].hash)
})

test('writeTracked：内容没变就不产生新版本（幂等）', () => {
  const root = tmpRoot()
  writeTracked(root, REL, 'same\n')
  const again = writeTracked(root, REL, 'same\n')
  assert.equal(again.changed, false)
  assert.equal(history(root, REL).length, 1)
})

test('blob 是内容寻址：两个文件同内容只存一份', () => {
  const root = tmpRoot()
  writeTracked(root, 'a.txt', 'shared\n')
  writeTracked(root, 'b.txt', 'shared\n')
  const blobs = stats(root).find((s) => s.scope === 'root')
  assert.equal(blobs.entries, 2)
  assert.equal(blobs.blobs, 1, '同内容应该只存一个 blob')
})

// ── 回滚 ────────────────────────────────────────────────────────────────

test('revert：能回到旧内容，且回滚本身是新版本', () => {
  const root = tmpRoot()
  const v1 = writeTracked(root, REL, 'v1\n')
  writeTracked(root, REL, 'v2\n')

  const r = revertTo(root, REL, v1.hash)
  assert.equal(r.changed, true)
  assert.equal(fs.readFileSync(path.join(root, REL), 'utf8'), 'v1\n')

  const h = history(root, REL)
  assert.equal(h.length, 3)
  assert.equal(h[2].kind, 'revert')
  assert.equal(h[2].prev, h[1].hash, '回滚不擦历史，而是接在后面')
})

test('revert：支持 hash 前缀与时间戳前缀', () => {
  const root = tmpRoot()
  const v1 = writeTracked(root, REL, 'one\n')
  writeTracked(root, REL, 'two\n')

  const byPrefix = revertTo(root, REL, String(v1.hash).slice(0, 12))
  assert.equal(byPrefix.changed, true)
  assert.equal(fs.readFileSync(path.join(root, REL), 'utf8'), 'one\n')

  const ts = history(root, REL)[0].ts
  revertTo(root, REL, ts)
  assert.equal(fs.readFileSync(path.join(root, REL), 'utf8'), 'one\n')
})

test('revert：找不到版本要报错', () => {
  const root = tmpRoot()
  writeTracked(root, REL, 'x\n')
  assert.throws(() => revertTo(root, REL, 'deadbeef'), /找不到版本/)
})

// ── 外部编辑 ────────────────────────────────────────────────────────────

test('scan：记事本改了文件 → 记一条 external_edit，不重复记', () => {
  const root = tmpRoot()
  writeTracked(root, REL, 'original\n')

  fs.writeFileSync(path.join(root, REL), '手改过的内容\n', 'utf8')

  const first = scanExternalEdits(root)
  assert.equal(first.length, 1)
  assert.equal(first[0].path, REL)

  const h = history(root, REL)
  assert.equal(h.length, 2)
  assert.equal(h[1].kind, 'external_edit')
  assert.equal(h[1].actor, 'human:editor')

  // 再扫一次不应该重复记
  const second = scanExternalEdits(root)
  assert.equal(second.length, 0)
  assert.equal(history(root, REL).length, 2)
})

test('scan：没改过的文件不会被误报', () => {
  const root = tmpRoot()
  writeTracked(root, REL, 'x\n')
  assert.deepEqual(scanExternalEdits(root), [])
})

// ── 作用域 ──────────────────────────────────────────────────────────────

test('scopeOf：人格文件进人格自己的版本库', () => {
  const sc = scopeOf('personas/yuanling/persona/SELF.md')
  assert.equal(sc.scope, 'yuanling')
  assert.equal(sc.versions, 'personas/yuanling/versions')

  const root = scopeOf('guardrails.json')
  assert.equal(root.scope, 'root')
  assert.equal(root.versions, P.versions)
})

test('人格文件的版本进 personas/<id>/versions，可随人格一起拷走', () => {
  const root = tmpRoot()
  const rel = 'personas/yuanling/persona/SELF.md'
  writeTracked(root, rel, '# 骨架\n')

  assert.ok(fs.existsSync(path.join(root, 'personas/yuanling/versions/journal.ndjson')))
  assert.ok(!fs.existsSync(path.join(root, 'system/versions/journal.ndjson')), '不该写进根级版本库')

  assert.ok(trackedPaths(root).includes(rel))
})

// ── 与人格注册表联动 ────────────────────────────────────────────────────

test('切换人格会给 yuanling.json 留一条版本', async () => {
  const root = tmpRoot()
  const { createPersona, switchPersona } = await import('../src/core/persona.js')
  createPersona(root, 'ling2', '灵二')
  switchPersona(root, 'ling2')

  const h = history(root, P.marker)
  assert.ok(h.length >= 2, `应该有切换记录，实际 ${h.length} 条`)
  assert.ok(h.some((e) => String(e.reason).includes('switch')))
})
