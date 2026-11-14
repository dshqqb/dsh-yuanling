// test/p93.test.mjs —— `yuanling repair`：把插件重新登记进 DSH profile。
//
// 背景：DSH 桌面的「禁用第三方插件、备份 profile patch 并重启」会删掉
// package.json 里的第三方依赖、dsh.profile.bundles 里的第三方 bundle、以及
// cordis.patch.yml 里的条目。**注册靠的是 bundles**——那一项没了，插件就不会被加载，
// 设置页里也看不到它（2026-11-14 真踩过）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { dshHome, listProfiles, repair, resolveProfile, splitTopLevel } from '../src/core/repair.js'

const BASE_BUNDLES = ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app']

function mkHome({ bundles = [...BASE_BUNDLES], deps = {}, patch = '', extraProfiles = [] } = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'yuanling-p93-'))
  const plugin = path.join(home, '_plugin')
  fs.mkdirSync(plugin, { recursive: true })
  fs.writeFileSync(path.join(plugin, 'package.json'), JSON.stringify({ name: 'dsh-yuanling', version: '0.1.3' }, null, 2) + '\n')

  const makeProfile = (name, { patchText = patch, pkg = null } = {}) => {
    const dir = path.join(home, 'profiles', name)
    fs.mkdirSync(path.join(dir, 'node_modules'), { recursive: true })
    const manifest = pkg ?? {
      name: `dsh-profile-${name}`,
      private: true,
      dependencies: { ...deps },
      dsh: { profile: { bundles: [...bundles] } },
    }
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify(manifest, null, 2) + '\n')
    if (patchText) fs.writeFileSync(path.join(dir, 'cordis.patch.yml'), patchText)
    return dir
  }

  const desktop = makeProfile('desktop')
  for (const name of extraProfiles) makeProfile(name)
  return { home, plugin, desktop }
}

const UNRELATED = `# profile patch
- id: ui-chat
  name: '@deepseek-ai/dsh-client-ui-chat'
  config:
    transcriptView: standard
- id: ui-settings
  name: '@deepseek-ai/dsh-client-ui-settings'
  config:
    enabled: true
`

const OUR_BLOCK = `- id: dsh-yuanling
  name: dsh-yuanling
  config:
    dataDir: D:\\yuanling
    enabled: true
`

test('dry-run：只报告要修什么，不写盘', () => {
  const { home, plugin } = mkHome({ patch: `${UNRELATED}${OUR_BLOCK}` })
  const pkgPath = path.join(home, 'profiles', 'desktop', 'package.json')
  const before = fs.readFileSync(pkgPath, 'utf8')
  const r = repair({ home, pluginDir: plugin, dryRun: true })
  assert.equal(r.dryRun, true)
  assert.ok(r.changes.some((c) => /bundles/.test(c)), '缺的正是 bundle 注册')
  assert.equal(fs.readFileSync(pkgPath, 'utf8'), before, 'dry-run 不该写盘')
})

test('真跑：补依赖 + 补 bundle + 建软链；配置条目已经对了就不动', () => {
  const { home, plugin, desktop } = mkHome({ patch: `${UNRELATED}${OUR_BLOCK}` })
  const r = repair({ home, pluginDir: plugin, withMcp: false })
  assert.equal(r.profile, 'desktop')

  const pkg = JSON.parse(fs.readFileSync(path.join(desktop, 'package.json'), 'utf8'))
  assert.equal(pkg.dependencies['dsh-yuanling'], `link:${plugin.replace(/\\/g, '/')}`)
  assert.ok(pkg.dsh.profile.bundles.includes('dsh-yuanling'), 'bundle 里必须有它')
  assert.deepEqual(pkg.dsh.profile.bundles.slice(0, 2), BASE_BUNDLES, '原有 bundle 顺序不动')

  const link = path.join(desktop, 'node_modules', 'dsh-yuanling')
  assert.equal(fs.realpathSync(link), fs.realpathSync(plugin), '软链要指回插件目录')

  const patch = fs.readFileSync(path.join(desktop, 'cordis.patch.yml'), 'utf8')
  assert.ok(patch.includes('dataDir: D:\\yuanling'), '原来的 dataDir 留着')
  assert.equal(patch.match(/- id: dsh-yuanling/g).length, 1, '只能有一条')
  assert.ok(r.backups.length >= 1, '写之前要备份')
  assert.ok(r.changes.length >= 2)
})

test('再跑一次：什么都不改（幂等）', () => {
  const { home, plugin } = mkHome({ patch: `${UNRELATED}${OUR_BLOCK}` })
  repair({ home, pluginDir: plugin, withMcp: false })
  const after1 = {
    pkg: fs.readFileSync(path.join(home, 'profiles', 'desktop', 'package.json'), 'utf8'),
    patch: fs.readFileSync(path.join(home, 'profiles', 'desktop', 'cordis.patch.yml'), 'utf8'),
  }
  const r2 = repair({ home, pluginDir: plugin, withMcp: false })
  assert.deepEqual(r2.changes, [], `第二次不该再有改动：${r2.changes.join('；')}`)
  assert.equal(fs.readFileSync(path.join(home, 'profiles', 'desktop', 'package.json'), 'utf8'), after1.pkg)
  assert.equal(fs.readFileSync(path.join(home, 'profiles', 'desktop', 'cordis.patch.yml'), 'utf8'), after1.patch)
})

test('配置条目被整段清掉了：补回来，别的条目不碰', () => {
  const { home, plugin, desktop } = mkHome({ patch: UNRELATED })
  repair({ home, pluginDir: plugin, dataRoot: 'D:\\yuanling', withMcp: false })
  const patch = fs.readFileSync(path.join(desktop, 'cordis.patch.yml'), 'utf8')
  assert.ok(patch.includes('ui-chat'), '无关条目要保留')
  assert.ok(patch.includes('ui-settings'), '无关条目要保留')
  assert.ok(patch.includes('- id: dsh-yuanling'))
  assert.ok(patch.includes("dataDir: 'D:\\yuanling'"))
})

test('条目在但没有 dataDir：补上 dataDir', () => {
  const { home, plugin, desktop } = mkHome({
    patch: `${UNRELATED}- id: dsh-yuanling\n  name: dsh-yuanling\n  config:\n    enabled: true\n`,
  })
  repair({ home, pluginDir: plugin, dataRoot: 'D:\\yuanling', withMcp: false })
  const patch = fs.readFileSync(path.join(desktop, 'cordis.patch.yml'), 'utf8')
  assert.ok(patch.includes('dataDir'))
})

test('重复条目：收成一条', () => {
  const { home, plugin, desktop } = mkHome({ patch: `${OUR_BLOCK}${UNRELATED}${OUR_BLOCK}` })
  repair({ home, pluginDir: plugin, withMcp: false })
  const patch = fs.readFileSync(path.join(desktop, 'cordis.patch.yml'), 'utf8')
  assert.equal(patch.match(/- id: dsh-yuanling/g).length, 1)
  assert.ok(patch.includes('ui-chat'))
})

test('node_modules 里的 .ignored_ 残留会被清掉再建链接', () => {
  const { home, plugin, desktop } = mkHome({ patch: `${UNRELATED}${OUR_BLOCK}` })
  const stale = path.join(desktop, 'node_modules', '.ignored_dsh-yuanling')
  fs.mkdirSync(stale, { recursive: true })
  repair({ home, pluginDir: plugin, withMcp: false })
  assert.equal(fs.existsSync(stale), false)
  assert.ok(fs.existsSync(path.join(desktop, 'node_modules', 'dsh-yuanling')))
})

test('MCP 条目：默认会补，--no-mcp 时不补', () => {
  const a = mkHome({ patch: `${UNRELATED}${OUR_BLOCK}` })
  repair({ home: a.home, pluginDir: a.plugin, dataRoot: 'D:\\yuanling' })
  const withMcp = fs.readFileSync(path.join(a.desktop, 'cordis.patch.yml'), 'utf8')
  assert.ok(withMcp.includes('mcp-yuanling'), '要补上 MCP 条目')
  assert.ok(withMcp.includes('serverName: yuanling'))

  const b = mkHome({ patch: `${UNRELATED}${OUR_BLOCK}` })
  repair({ home: b.home, pluginDir: b.plugin, withMcp: false })
  const noMcp = fs.readFileSync(path.join(b.desktop, 'cordis.patch.yml'), 'utf8')
  assert.ok(!noMcp.includes('mcp-yuanling'))
})

test('多 profile：自动挑提到原灵的那个；也能显式指定；自动挑不出来时报错', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'yuanling-p93-multi-'))
  const plugin = path.join(home, '_plugin')
  fs.mkdirSync(plugin, { recursive: true })
  fs.writeFileSync(path.join(plugin, 'package.json'), '{"name":"dsh-yuanling","version":"0.1.3"}\n')

  const mk = (name, patchText) => {
    const dir = path.join(home, 'profiles', name)
    fs.mkdirSync(path.join(dir, 'node_modules'), { recursive: true })
    fs.writeFileSync(
      path.join(dir, 'package.json'),
      JSON.stringify({ name: `dsh-profile-${name}`, private: true, dependencies: {}, dsh: { profile: { bundles: [] } } }, null, 2) + '\n',
    )
    fs.writeFileSync(path.join(dir, 'cordis.patch.yml'), patchText)
    return dir
  }
  mk('web', UNRELATED)
  const tui = mk('tui', `${UNRELATED}${OUR_BLOCK}`)

  assert.equal(resolveProfile(null, home).name, 'tui', '有原灵痕迹的那个优先')
  assert.equal(resolveProfile('web', home).name, 'web')
  assert.deepEqual(listProfiles(home).map((p) => p.name), ['tui', 'web'])

  // 两个都不含原灵：desktop 不存在、又不止一个 → 要人指定
  const home2 = fs.mkdtempSync(path.join(os.tmpdir(), 'yuanling-p93-multi2-'))
  for (const name of ['a', 'b']) {
    const dir = path.join(home2, 'profiles', name)
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, 'package.json'), '{"name":"x","dsh":{"profile":{"bundles":[]}}}\n')
    fs.writeFileSync(path.join(dir, 'cordis.patch.yml'), UNRELATED)
  }
  assert.throws(() => resolveProfile(null, home2), /--profile/)
  assert.equal(dshHome(home2), path.resolve(home2))
})

test('splitTopLevel：顶层块切得对（缩进行跟着上一块）', () => {
  const { head, blocks } = splitTopLevel(`# 头\n\n- id: a\n  name: x\n  config:\n    y: 1\n- insert:\n    - id: b\n      name: y\n`)
  assert.deepEqual(head, ['# 头', ''])
  assert.equal(blocks.length, 2)
  assert.match(blocks[1], /- id: b/)
})
