// test/p47.test.mjs —— 诊断：把"模糊的不对劲"拆成 {code, stage, hint}。
//
// 借鉴 surfcore：诊断不是贴日志，而是每条都给「错在哪 / 哪一步 / 下一步做什么」。
// 还有一条硬规矩：**假绿比不绿更糟**——模块崩了，它自报的"一切正常"必须消失。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { scaffold } from '../src/core/scaffold.js'
import { diagnose, renderDiagnostics } from '../src/core/diagnostics.js'
import { DIAG_MAX_ITEMS, DIAG_TTL_MS } from '../src/core/modules/service.js'
import { moduleDir } from '../src/core/modules/registry.js'

const PID = 'yuanling'

function tmpRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'yuanling-p47-'))
  scaffold(root, {})
  return root
}

/** 造一个模块目录 + 注册表条目（不走安装器：这里只关心诊断怎么读它们）。 */
function seedModule(root, id, { manifest = {}, entry = {} } = {}) {
  const dir = moduleDir(root, id)
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(
    path.join(dir, 'yuanling.module.json'),
    JSON.stringify({ id, version: '0.1.0', api: '1.2', entry: { command: ['node', 'index.js'] }, ...manifest }, null, 2),
  )
  const regPath = path.join(root, 'system', 'modules.json')
  const reg = fs.existsSync(regPath)
    ? JSON.parse(fs.readFileSync(regPath, 'utf8'))
    : { version: 1, modules: {} }
  reg.modules[id] = {
    id,
    version: '0.1.0',
    api: '1.2',
    capabilities: manifest.capabilities ?? [],
    granted: manifest.capabilities ?? [],
    enabled: true,
    state: 'ready',
    routes: [],
    sources: [],
    permissions: [],
    ...entry,
  }
  fs.writeFileSync(regPath, JSON.stringify(reg, null, 2))
  return dir
}

const codes = (r) => r.items.map((x) => x.code)

// ── 形状与纪律 ──────────────────────────────────────────────────────────

test('诊断：每一项都有 code / stage / level / hint', () => {
  const root = tmpRoot()
  const r = diagnose(root, { onlyProblems: false })
  assert.ok(r.items.length > 0, '一个刚建的目录至少要把查了什么列出来')
  for (const it of r.items) {
    assert.ok(it.code, 'code 是给人查的键，不能空')
    assert.ok(it.stage, 'stage 要说明哪一段出的问题')
    assert.ok(['info', 'warn', 'error'].includes(it.level), `level 不合法：${it.level}`)
    assert.ok(it.hint, '没有 hint 的项等于"只告诉你坏了，不告诉你怎么办"')
  }
})

test('诊断：报错的项不许出现"一切正常"这种空话', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'yuanling-p47-bad-'))
  const r = diagnose(root, { onlyProblems: false })
  const bad = r.items.filter((x) => x.level === 'error')
  assert.ok(bad.length > 0, '空目录应该报出问题')
  for (const it of bad) {
    assert.ok(!/一切正常|正常/.test(it.hint), `错误项不该给一句"正常"：${it.code} → ${it.hint}`)
  }
})

test('诊断：全部通过时 ok=true，且有 items 说明查了什么', () => {
  const root = tmpRoot()
  const r = diagnose(root, { onlyProblems: false })
  for (const it of r.items) {
    if (it.level === 'error') assert.fail(`刚建好的目录不该有硬错误：${it.code} ${it.hint}`)
  }
  assert.ok(r.summary.info >= 1)
})

test('诊断：onlyProblems=false 比默认多（默认只列问题）', () => {
  const root = tmpRoot()
  const only = diagnose(root)
  const all = diagnose(root, { onlyProblems: false })
  assert.ok(all.items.length >= only.items.length)
})

// ── 模块事实 ────────────────────────────────────────────────────────────

test('模块：声明了能力却没授 → 警告，并说清后果', () => {
  const root = tmpRoot()
  seedModule(root, 'fake', { manifest: { capabilities: ['ingest.message', 'send'] }, entry: { granted: [] } })
  const r = diagnose(root)
  const hit = r.items.find((x) => x.code === 'module.capability-pending')
  assert.ok(hit, '没授权的模块必须被点名')
  assert.equal(hit.module, 'fake')
  assert.match(hit.hint, /E_NO_CAP/)
})

test('模块：启用了却没在跑 → 警告，带上最后一行日志', () => {
  const root = tmpRoot()
  seedModule(root, 'fake', { entry: { state: 'crashed', last_crash: { reason: '握手超时' } } })
  fs.mkdirSync(path.join(root, 'system', 'log', 'modules'), { recursive: true })
  fs.writeFileSync(path.join(root, 'system', 'log', 'modules', 'fake.log'), '2026-11-01T10:00:00+08:00 握手超时\n')

  const r = diagnose(root)
  const hit = r.items.find((x) => x.code === 'module.not-running')
  assert.ok(hit)
  assert.equal(hit.level, 'error')
  assert.match(hit.hint, /重启/)
  assert.match(hit.hint, /握手超时/)
})

test('模块：目录里没有 manifest → 错误，并给出卸载命令', () => {
  const root = tmpRoot()
  seedModule(root, 'ghost')
  fs.rmSync(path.join(moduleDir(root, 'ghost'), 'yuanling.module.json'))
  const r = diagnose(root)
  const hit = r.items.find((x) => x.code === 'module.manifest-missing')
  assert.ok(hit)
  assert.match(hit.hint, /uninstall ghost/)
})

test('模块：配置过不了 schema → 错误（模块不读文件，坏值会一路带进去）', () => {
  const root = tmpRoot()
  const dir = seedModule(root, 'fake', {
    manifest: {
      config: {
        schema: {
          type: 'object',
          properties: { cookie: { type: 'string', title: 'cookie' } },
          required: ['cookie'],
        },
      },
    },
  })
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({}), 'utf8')
  const r = diagnose(root)
  const hit = r.items.find((x) => x.code === 'module.config-invalid')
  assert.ok(hit, '必填字段缺失应该被诊断出来')
  assert.match(hit.hint, /配置表单/)
})

test('模块：注册表坏了也不炸（readRegistry 容错，诊断不该比它还脆）', () => {
  const root = tmpRoot()
  fs.writeFileSync(path.join(root, 'system', 'modules.json'), '{ 坏 json', 'utf8')
  const r = diagnose(root, { onlyProblems: false })
  assert.ok(Array.isArray(r.items), '坏注册表应该被当成"没有模块"，而不是抛出去')
  assert.ok(!r.items.some((x) => x.code === 'modules.registry-unreadable'), '不编一条永远显示不出来的项')
})

// ── 模块自报（协议 v1.4）───────────────────────────────────────────────

test('自报：新鲜的报告会并进清单，标 source=module', () => {
  const root = tmpRoot()
  seedModule(root, 'fake')
  const dir = moduleDir(root, 'fake')
  fs.writeFileSync(
    path.join(dir, 'diag.json'),
    JSON.stringify({ at: new Date().toISOString(), items: [{ code: 'cookie.expired', level: 'error', hint: '去设置页重新登录' }] }),
    'utf8',
  )

  const r = diagnose(root, { moduleDiag: () => readFileDiag(root, 'fake') })
  const hit = r.items.find((x) => x.code === 'module.cookie.expired')
  assert.ok(hit, '模块自报项要并进同一张清单')
  assert.equal(hit.source, 'module')
  assert.equal(hit.module, 'fake')
  assert.equal(hit.level, 'error')
})

test('自报：过期（15 分钟没再报）就当它不再成立——假绿比不绿更糟', () => {
  const root = tmpRoot()
  seedModule(root, 'fake')
  const dir = moduleDir(root, 'fake')
  const old = new Date(Date.now() - DIAG_TTL_MS - 60_000).toISOString()
  fs.writeFileSync(path.join(dir, 'diag.json'), JSON.stringify({ at: old, items: [{ code: 'ok', level: 'info', hint: '一切正常' }] }), 'utf8')

  const r = readFileDiag(root, 'fake')
  assert.deepEqual(r.items, [], '过期自报不能再算数')
  assert.equal(r.stale, true)
})

test('自报：没有 diag.json 时返回空，不报错', () => {
  const root = tmpRoot()
  seedModule(root, 'fake')
  const r = readFileDiag(root, 'fake')
  assert.deepEqual(r.items, [])
  assert.equal(r.stale, false)
})

test('自报：条数与提示长度有上限（模块不能把诊断页刷满）', () => {
  const root = tmpRoot()
  seedModule(root, 'fake')
  const dir = moduleDir(root, 'fake')
  const items = Array.from({ length: DIAG_MAX_ITEMS + 5 }, (_, i) => ({ code: `c${i}`, level: 'warn', hint: '啊'.repeat(300) }))
  fs.writeFileSync(path.join(dir, 'diag.json'), JSON.stringify({ at: new Date().toISOString(), items }), 'utf8')
  const r = readFileDiag(root, 'fake')
  assert.equal(r.items.length, DIAG_MAX_ITEMS)
})

/** 测试里的"读文件版"（api.js 与 service.js 都是这一套规则，这里只用来验行为）。 */
function readFileDiag(root, id, { now = Date.now(), ttlMs = DIAG_TTL_MS } = {}) {
  const p = path.join(moduleDir(root, id), 'diag.json')
  let rec = null
  try {
    rec = JSON.parse(fs.readFileSync(p, 'utf8'))
  } catch {
    return { items: [], at: null, stale: false }
  }
  const at = Date.parse(String(rec.at ?? ''))
  const stale = !Number.isFinite(at) || now - at > ttlMs
  return { items: stale ? [] : (rec.items ?? []).slice(0, DIAG_MAX_ITEMS), at: rec.at ?? null, stale }
}

// ── 渲染 ────────────────────────────────────────────────────────────────

test('渲染：有错时标题直说，并说明诊断不会自己去修', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'yuanling-p47-r-'))
  const r = diagnose(root)
  const text = renderDiagnostics(r)
  assert.match(text, /诊断/)
  assert.match(text, /只读/)
  for (const it of r.items) assert.ok(text.includes(it.code), '每条都要能被看到')
})
