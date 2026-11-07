// test/p19.test.mjs —— mcp install：只动标记块、幂等、可回滚。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import {
  MARK_BEGIN,
  MARK_END,
  buildBlock,
  applyBlock,
  stripBlock,
  installMcp,
  uninstallMcp,
  mcpStatus,
  findProfiles,
} from '../src/core/mcpinstall.js'

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'yuanling-p19-'))
}

const ORIGINAL = `# 用户自己的配置
- id: agent-default-model
  name: '@deepseek-ai/dsh-agent-default-model'
  config:
    provider: volcengine-ark
    model: deepseek-v4.1-flash

# === qq-bridge MCP END ===
`

function writePatch(dir, text = ORIGINAL) {
  const p = path.join(dir, 'cordis.patch.yml')
  fs.writeFileSync(p, text)
  return p
}

test('install：首次写入带标记的块', () => {
  const dir = tmpDir()
  const patchPath = writePatch(dir)
  const r = installMcp({ patchPath, nodeCmd: 'C:\\node.exe', serverPath: 'C:\\y\\mcp-server.mjs' })

  assert.equal(r.changed, true)
  assert.equal(r.restartRequired, true)

  const text = fs.readFileSync(patchPath, 'utf8')
  assert.ok(text.includes(MARK_BEGIN))
  assert.ok(text.includes(MARK_END))
  assert.ok(text.includes("serverName: yuanling"))
  assert.ok(text.includes("'C:\\node.exe'"))
  assert.ok(text.includes("mcp-server.mjs'"))
})

test('install：原有条目与注释一字不动', () => {
  const dir = tmpDir()
  const patchPath = writePatch(dir)
  installMcp({ patchPath, nodeCmd: 'node', serverPath: '/tmp/mcp-server.mjs' })

  const text = fs.readFileSync(patchPath, 'utf8')
  assert.ok(text.includes("name: '@deepseek-ai/dsh-agent-default-model'"), '原有条目要留着')
  assert.ok(text.includes('# 用户自己的配置'))
  assert.ok(text.includes('# === qq-bridge MCP END ==='), '用户自己的标记块也要留着')
})

test('install：幂等——跑第二次内容不变', () => {
  const dir = tmpDir()
  const patchPath = writePatch(dir)
  installMcp({ patchPath, nodeCmd: 'node', serverPath: '/tmp/mcp-server.mjs' })
  const first = fs.readFileSync(patchPath, 'utf8')

  const again = installMcp({ patchPath, nodeCmd: 'node', serverPath: '/tmp/mcp-server.mjs' })
  assert.equal(again.changed, false)
  assert.equal(fs.readFileSync(patchPath, 'utf8'), first)
})

test('install：换路径时整块被替换，不叠加第二份', () => {
  const dir = tmpDir()
  const patchPath = writePatch(dir)
  installMcp({ patchPath, nodeCmd: 'node', serverPath: '/tmp/old.mjs' })
  installMcp({ patchPath, nodeCmd: 'node2', serverPath: '/tmp/new.mjs' })

  const text = fs.readFileSync(patchPath, 'utf8')
  assert.equal(text.split(MARK_BEGIN).length - 1, 1, '只能有一块')
  assert.ok(text.includes('/tmp/new.mjs'))
  assert.ok(!text.includes('/tmp/old.mjs'))
})

test('install：写前留备份', () => {
  const dir = tmpDir()
  const patchPath = writePatch(dir)
  const r = installMcp({ patchPath, nodeCmd: 'node', serverPath: '/tmp/m.mjs' })
  assert.ok(r.backup && fs.existsSync(r.backup))
  assert.equal(fs.readFileSync(r.backup, 'utf8'), ORIGINAL)
})

test('uninstall：只摘自己那段，恢复成原文', () => {
  const dir = tmpDir()
  const patchPath = writePatch(dir)
  installMcp({ patchPath, nodeCmd: 'node', serverPath: '/tmp/m.mjs' })

  const r = uninstallMcp({ patchPath })
  assert.equal(r.changed, true)

  const text = fs.readFileSync(patchPath, 'utf8')
  assert.ok(!text.includes(MARK_BEGIN))
  assert.ok(text.includes('agent-default-model'))
  assert.ok(text.includes('# === qq-bridge MCP END ==='))
})

test('dry-run：只报告，不落盘', () => {
  const dir = tmpDir()
  const patchPath = writePatch(dir)
  const r = installMcp({ patchPath, nodeCmd: 'node', serverPath: '/tmp/m.mjs', dryRun: true })
  assert.equal(r.changed, true)
  assert.equal(fs.readFileSync(patchPath, 'utf8'), ORIGINAL, 'dry-run 不该改文件')
})

test('配置文件不存在时明确报错（不自动创建）', () => {
  const dir = tmpDir()
  assert.throws(() => installMcp({ patchPath: path.join(dir, 'nope.yml') }), /找不到/)
})

test('status：装前 false，装后能读出路径', () => {
  const dir = tmpDir()
  const patchPath = writePatch(dir)
  assert.equal(mcpStatus({ patchPath }).installed, false)

  installMcp({ patchPath, nodeCmd: 'C:\\node.exe', serverPath: 'C:\\y\\mcp-server.mjs' })
  const st = mcpStatus({ patchPath })
  assert.equal(st.installed, true)
  assert.match(st.nodeCmd, /node\.exe/)
  assert.match(st.serverPath, /mcp-server\.mjs/)
})

test('buildBlock：路径里的单引号被 YAML 转义', () => {
  const block = buildBlock({ nodeCmd: "C:\\it's\\node.exe", serverPath: 'x.mjs' })
  assert.ok(block.includes("'C:\\it''s\\node.exe'"))
})

test('apply/strip：纯文本层的幂等', () => {
  const block = buildBlock({ nodeCmd: 'node', serverPath: '/tmp/m.mjs' })
  const once = applyBlock(ORIGINAL, block)
  const twice = applyBlock(once, block)
  assert.equal(twice, once)

  const back = stripBlock(twice)
  assert.equal(back.changed, true)
  assert.ok(!back.text.includes(MARK_BEGIN))
  assert.ok(back.text.includes('agent-default-model'))
})

test('findProfiles：只认有 cordis.patch.yml 的目录', () => {
  const home = tmpDir()
  fs.mkdirSync(path.join(home, 'profiles', 'desktop'), { recursive: true })
  fs.mkdirSync(path.join(home, 'profiles', 'empty'), { recursive: true })
  fs.writeFileSync(path.join(home, 'profiles', 'desktop', 'cordis.patch.yml'), ORIGINAL)

  const list = findProfiles(home)
  assert.equal(list.length, 1)
  assert.equal(list[0].name, 'desktop')
})
