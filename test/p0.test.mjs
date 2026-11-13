// test/p0.test.mjs —— P0 的验收用例。只测纯 Node 部分，不碰 DSH 宿主。
// 运行：node --test test/
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { resolveRoot, validateRoot, defaultRoot, P } from '../src/core/paths.js'
import { scaffold } from '../src/core/scaffold.js'
import { readMarker, listPersonas, createPersona, switchPersona } from '../src/core/persona.js'
import { doctor } from '../src/core/doctor.js'
import { checkFormat } from '../src/core/manifest.js'

function tmpRoot(prefix = 'yuanling-test-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix))
}

function freshScaffold(opts) {
  const root = tmpRoot()
  scaffold(root, opts)
  return root
}

// ── root 解析 ───────────────────────────────────────────────────────────

test('resolveRoot：CLI 优先于 env / config / 默认', () => {
  const env = { YUANLING_HOME: 'E:\\from-env' }
  const config = { dataDir: 'F:\\from-config' }

  assert.equal(resolveRoot({ cli: 'D:\\cli', env, config }).source, 'cli')
  assert.equal(resolveRoot({ env, config }).source, 'env')
  assert.equal(resolveRoot({ env: {}, config }).source, 'config')
  assert.equal(resolveRoot({ env: {}, config: {} }).source, 'default')
})

test('resolveRoot：空白字符串不算数（回落而不是用空路径）', () => {
  const r = resolveRoot({ cli: '   ', env: { YUANLING_HOME: '  ' }, config: { dataDir: '' } })
  assert.equal(r.source, 'default')
})

test('defaultRoot：尊重 DSH_HOME', () => {
  const r = defaultRoot({ DSH_HOME: 'D:\\dsh-home' })
  assert.equal(r, path.join('D:\\dsh-home', 'yuanling'))
})

// ── 校验 ────────────────────────────────────────────────────────────────

test('validateRoot：目录不存在 → ROOT_MISSING（绝不自动创建）', () => {
  const missing = path.join(os.tmpdir(), 'yuanling-definitely-missing-' + Date.now())
  const v = validateRoot(missing)
  assert.equal(v.ok, false)
  assert.ok(v.errors.some((e) => e.code === 'ROOT_MISSING'))
  assert.equal(fs.existsSync(missing), false, '校验不应该顺手把目录建出来')
})

test('validateRoot：UNC 路径 → UNC_PATH', () => {
  const v = validateRoot('\\\\NAS\\share\\yuanling')
  assert.equal(v.ok, false)
  assert.ok(v.errors.some((e) => e.code === 'UNC_PATH'))
})

test('validateRoot：可写目录 → ok，且 fs_type 是 skip 不是 pass', () => {
  const root = tmpRoot()
  const v = validateRoot(root)
  assert.equal(v.ok, true, JSON.stringify(v.errors))
  assert.ok(v.skips.some((s) => s.id === 'fs_type' && s.reason))
})

test('validateRoot：路径是文件而不是目录 → NOT_A_DIR', () => {
  const root = tmpRoot()
  const file = path.join(root, 'a.txt')
  fs.writeFileSync(file, 'x')
  const v = validateRoot(file)
  assert.equal(v.ok, false)
  assert.ok(v.errors.some((e) => e.code === 'NOT_A_DIR'))
})

// ── 骨架 ────────────────────────────────────────────────────────────────

test('scaffold：建出根级七项与关键文件', () => {
  const root = freshScaffold({ personaId: 'yuanling', name: '原灵' })

  for (const rel of [P.marker, P.guardrails, P.ingestRules, P.firstDoc, 'raw', 'raw-archive', 'media', 'personas', 'system', 'web']) {
    assert.ok(fs.existsSync(path.join(root, rel)), `缺少 ${rel}`)
  }
  for (const rel of [
    P.manifest,
    P.shields,
    P.consoleToken,
    'personas/yuanling/persona/SELF.md',
    // 身份登记已按人格：除原始层外，人格数据都在 personas/<id>/ 下
    'personas/yuanling/entities/accounts.json',
    'personas/yuanling/entities/persons.json',
    'personas/yuanling/entities/group-identities.json',
  ]) {
    assert.ok(fs.existsSync(path.join(root, rel)), `缺少 ${rel}`)
  }

  // 根级必须只有"人该动的" + 数据区
  assert.ok(!fs.existsSync(path.join(root, 'identities.json')), 'identities.json 不该在根级')
  assert.ok(fs.existsSync(path.join(root, 'guardrails.json')), 'guardrails.json 必须在根级')
})

test('scaffold：第二次运行只跳过，不覆盖已有内容', () => {
  const root = tmpRoot()
  scaffold(root, {})

  const selfPath = path.join(root, 'personas/yuanling/persona/SELF.md')
  fs.writeFileSync(selfPath, '# 我改过了\n', 'utf8')

  const second = scaffold(root, {})
  assert.equal(second.created.length, 0, `不该再创建任何东西：${second.created.join(',')}`)
  assert.equal(fs.readFileSync(selfPath, 'utf8'), '# 我改过了\n', '已有文件被覆盖了')
})

test('scaffold：中文 + 空格路径可用', () => {
  const base = tmpRoot('yuanling-中文 路径-')
  const root = path.join(base, '我的 记忆 库')
  fs.mkdirSync(root, { recursive: true })
  scaffold(root, {})
  assert.ok(fs.existsSync(path.join(root, P.marker)))
  const v = validateRoot(root)
  assert.equal(v.ok, true, JSON.stringify(v.errors))
})

test('scaffold：人格 id 非法时直接拒绝', () => {
  const root = tmpRoot()
  assert.throws(() => scaffold(root, { personaId: '原灵' }), /人格 id 非法/)
  assert.throws(() => scaffold(root, { personaId: 'A' }), /人格 id 非法/)
})

test('scaffold：令牌是 64 位 hex', () => {
  const root = freshScaffold({})
  const token = fs.readFileSync(path.join(root, P.consoleToken), 'utf8').trim()
  assert.match(token, /^[0-9a-f]{64}$/)
})

// ── 人格 ────────────────────────────────────────────────────────────────

test('persona：初始有一个人格且是激活态', () => {
  const root = freshScaffold({})
  const list = listPersonas(root)
  assert.equal(list.length, 1)
  assert.equal(list[0].id, 'yuanling')
  assert.equal(list[0].active, true)
})

test('persona：新建 / 列表 / 切换', () => {
  const root = freshScaffold({})
  createPersona(root, 'ling2', '灵二')

  const list = listPersonas(root)
  assert.deepEqual(list.map((p) => p.id).sort(), ['ling2', 'yuanling'])

  const r = switchPersona(root, 'ling2')
  assert.equal(r.changed, true)
  assert.equal(readMarker(root).active, 'ling2')

  const again = switchPersona(root, 'ling2')
  assert.equal(again.changed, false, '重复切换应该是幂等的')
})

test('persona：切到不存在的人格要报错，且不改 active', () => {
  const root = freshScaffold({})
  assert.throws(() => switchPersona(root, 'nobody'), /不存在/)
  assert.equal(readMarker(root).active, 'yuanling')
})

test('persona：重复 id 要报错', () => {
  const root = freshScaffold({})
  assert.throws(() => createPersona(root, 'yuanling', '又一个'), /已存在/)
})

test('persona：--from 复制骨架，不复制记忆', () => {
  const root = freshScaffold({})
  const srcSelf = path.join(root, 'personas/yuanling/persona/SELF.md')
  fs.writeFileSync(srcSelf, '# 源人格骨架\n', 'utf8')
  // 在源人格里塞一条"记忆"
  fs.writeFileSync(path.join(root, 'personas/yuanling/core.json'), '{"facts":["不该被复制"]}\n', 'utf8')

  createPersona(root, 'copy', '副本', { from: 'yuanling' })

  const dstSelf = path.join(root, 'personas/copy/persona/SELF.md')
  assert.equal(fs.readFileSync(dstSelf, 'utf8'), '# 源人格骨架\n')

  const dstCore = JSON.parse(fs.readFileSync(path.join(root, 'personas/copy/core.json'), 'utf8'))
  assert.deepEqual(dstCore.facts, [], '记忆不该被复制')
})

// ── 完整性 ──────────────────────────────────────────────────────────────

test('manifest：新建时 format 一致', () => {
  const root = freshScaffold({})
  const f = checkFormat(root)
  assert.equal(f.ok, true, JSON.stringify(f.errors))
})

test('manifest：两边 format 不一致要拒绝', () => {
  const root = freshScaffold({})
  const m = JSON.parse(fs.readFileSync(path.join(root, P.manifest), 'utf8'))
  m.format = 99
  fs.writeFileSync(path.join(root, P.manifest), JSON.stringify(m, null, 2) + '\n', 'utf8')

  const f = checkFormat(root)
  assert.equal(f.ok, false)
  assert.ok(f.errors.some((e) => e.code === 'FORMAT_MISMATCH'))
})

test('doctor：全新数据目录 → ok，且 summary 完整', () => {
  const root = freshScaffold({})
  const d = doctor(root)
  assert.equal(d.ok, true, JSON.stringify(d.checks.filter((c) => c.status === 'fail')))
  assert.equal(d.checks.some((c) => c.id === 'pointer'), false, 'P0 还没有记忆层，不该有 pointer 检查')
  for (const c of d.checks) {
    if (c.status === 'skip') assert.ok(c.reason, `skip 必须带 reason：${c.id}`)
  }
})

test('doctor：删掉根标记后必须报错（这就是 P0 的验收场景）', () => {
  const root = freshScaffold({})
  fs.rmSync(path.join(root, P.marker))
  const d = doctor(root)
  assert.equal(d.ok, false)
  assert.ok(d.checks.some((c) => c.id === 'format' && c.status === 'fail'))
})

test('doctor：令牌被改坏要报错', () => {
  const root = freshScaffold({})
  fs.writeFileSync(path.join(root, P.consoleToken), 'not-a-token\n', 'utf8')
  const d = doctor(root)
  assert.equal(d.ok, false)
  assert.ok(d.checks.some((c) => c.id === 'token' && c.status === 'fail'))
})
