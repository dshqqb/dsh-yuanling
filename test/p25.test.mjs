// test/p25.test.mjs —— 重复条目清理与探针移除。
//
// 真机踩到：手工往 profile 的 cordis.patch.yml 里贴过一条 `- insert: id: mcp-yuanling`，
// 之后 `mcp install` 又在标记块里写了一份 → 同一个 id 出现两次，块外那份会盖掉块内那份，
// 而且 `mcp uninstall` 摘不掉它（它不在标记块内）。改数据目录时就变成幽灵配置。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  MARK_BEGIN,
  MARK_END,
  MCP_ENTRY_ID,
  dedupeForeignEntries,
  installMcp,
  uninstallMcp,
  mcpStatus,
} from '../src/core/mcpinstall.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const REPO = path.join(HERE, '..')
const read = (rel) => fs.readFileSync(path.join(REPO, rel), 'utf8')

const FOREIGN = `# 用户自己的配置
- id: agent-default-model
  name: '@deepseek-ai/dsh-agent-default-model'
  config:
    provider: ark

# 手工贴进来的重复条目（没有引号，用的还是裸 node）
- insert:
    - id: ${MCP_ENTRY_ID}
      name: '@deepseek-ai/dsh-mcp-client'
      config:
        serverName: yuanling
        transport: stdio
        command: D:\\Program Files\\nodejs\\node.exe
        args:
          - D:\\doc\\x\\mcp-server.mjs
          - '--root'
          - D:\\yuanling
        toolCallTimeoutMs: 30000

# === qq-bridge MCP BEGIN ===
- insert:
    - id: mcp-snowluma
      name: '@deepseek-ai/dsh-mcp-client'
      config:
        serverName: snowluma
# === qq-bridge MCP END ===
`

function tmpPatch(text = FOREIGN) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'yuanling-p25-'))
  const patchPath = path.join(dir, 'cordis.patch.yml')
  fs.writeFileSync(patchPath, text)
  return patchPath
}

test('dedupe：标记块外的同名条目被整段删除', () => {
  const r = dedupeForeignEntries(FOREIGN)
  assert.equal(r.removed.length, 1)
  assert.match(r.removed[0], /serverName: yuanling/)
  assert.ok(!r.text.includes('D:\\\\Program Files\\\\nodejs'), '手工那份应该被删掉')
})

test('dedupe：别人的条目一条不动', () => {
  const r = dedupeForeignEntries(FOREIGN)
  assert.match(r.text, /id: agent-default-model/)
  assert.match(r.text, /id: mcp-snowluma/)
  assert.match(r.text, /# === qq-bridge MCP BEGIN ===/)
  assert.match(r.text, /# === qq-bridge MCP END ===/)
})

test('dedupe：不许吞掉下一个块的列 0 注释（真机踩过）', () => {
  // 第一版实现"吃到下一个 `^- ` 行为止"，于是把紧跟其后的
  // `# === qq-bridge MCP BEGIN ===` 一起吃掉了 —— surfcore 的 uninstall.mjs
  // 靠这行文本判断区块，删了它等于把别人的卸载路径弄坏。
  const src = [
    '- insert:',
    `    - id: ${MCP_ENTRY_ID}`,
    '      name: x',
    '',
    '# === qq-bridge MCP BEGIN ===',
    '- insert:',
    '    - id: mcp-snowluma',
    '      name: y',
    '# === qq-bridge MCP END ===',
  ].join('\n')

  const r = dedupeForeignEntries(src)
  assert.equal(r.removed.length, 1)
  assert.match(r.text, /# === qq-bridge MCP BEGIN ===/, '别人的 BEGIN 标记必须留着')
  assert.match(r.text, /# === qq-bridge MCP END ===/)
  assert.ok(!r.text.includes(`id: ${MCP_ENTRY_ID}`))
  assert.match(r.text, /id: mcp-snowluma/)
})

test('dedupe：标记块内的同名条目不动（那是它自己的地盘）', () => {
  const block = [
    MARK_BEGIN,
    '- insert:',
    `    - id: ${MCP_ENTRY_ID}`,
    "      name: '@deepseek-ai/dsh-mcp-client'",
    MARK_END,
  ].join('\n')
  const r = dedupeForeignEntries(block)
  assert.equal(r.removed.length, 0, '块内不该被当成残留')
  assert.ok(r.text.includes(MCP_ENTRY_ID))
})

test('install：标记块里的别人的条目（如 llm-pi-ai）绝不能被删', () => {
  // 真机事故 2026-11-08：用户从 DSH 设置页加的火山引擎 provider 恰好落在
  // BEGIN/END 之间，整段替换把它删了 —— 表现为"我加的 api 消失了"。
  const patchPath = tmpPatch(
    [
      '- id: agent-default-model',
      '  name: x',
      '',
      MARK_BEGIN,
      '- insert:',
      `    - id: ${MCP_ENTRY_ID}`,
      '      name: y',
      '- id: llm-pi-ai',
      '  name: "@deepseek-ai/dsh-llm-pi-ai"',
      '  config:',
      '    providers:',
      '      ark:',
      '        apiKeyEnv: ARK_API_KEY',
      MARK_END,
    ].join('\n'),
  )

  installMcp({ patchPath, nodeCmd: 'C:\\nodejs\\node.exe', serverPath: 'C:\\y\\mcp-server.mjs' })

  const text = fs.readFileSync(patchPath, 'utf8')
  assert.match(text, /id: llm-pi-ai/, '用户的 provider 必须活着')
  assert.match(text, /ARK_API_KEY/, '配置内容也要完整保留')
  assert.match(text, /id: agent-default-model/)

  // 而且下次 install 也不能再把它吃掉（幂等）
  installMcp({ patchPath, nodeCmd: 'C:\\nodejs\\node.exe', serverPath: 'C:\\y\\mcp-server.mjs' })
  assert.match(fs.readFileSync(patchPath, 'utf8'), /id: llm-pi-ai/)
})

test('uninstall：标记块里的别人的条目同样要保住', () => {
  // 和 install 对称：卸载也只该摘掉我们那一条，不能连坐用户的 provider。
  const patchPath = tmpPatch(
    [
      '- id: agent-default-model',
      '  name: x',
      '',
      MARK_BEGIN,
      '- insert:',
      `    - id: ${MCP_ENTRY_ID}`,
      '      name: y',
      '- id: llm-pi-ai',
      '  name: "@deepseek-ai/dsh-llm-pi-ai"',
      '  config:',
      '    providers:',
      '      ark:',
      '        apiKeyEnv: ARK_API_KEY',
      MARK_END,
    ].join('\n'),
  )

  const r = uninstallMcp({ patchPath })
  assert.equal(r.changed, true)

  const text = fs.readFileSync(patchPath, 'utf8')
  assert.match(text, /id: llm-pi-ai/, '卸载也不能删用户的 provider')
  assert.match(text, /ARK_API_KEY/)
  assert.match(text, /id: agent-default-model/)
  assert.ok(!text.includes(MCP_ENTRY_ID), '我们那条要干净摘掉')
})

test('install：写完只有一份 mcp-yuanling，且 command 是绝对路径', () => {
  const patchPath = tmpPatch()
  const r = installMcp({ patchPath, nodeCmd: 'C:\\nodejs\\node.exe', serverPath: 'C:\\y\\mcp-server.mjs' })

  const text = fs.readFileSync(patchPath, 'utf8')
  assert.equal(text.split(`id: ${MCP_ENTRY_ID}`).length - 1, 1, '只该剩一份')
  assert.ok(text.includes("'C:\\nodejs\\node.exe'"), 'command 要用绝对路径，不写裸 node')
  assert.equal(r.removedForeign.length, 1)
})

test('install → uninstall：文件回到没有本插件的状态', () => {
  const patchPath = tmpPatch()
  installMcp({ patchPath, nodeCmd: 'C:\\nodejs\\node.exe', serverPath: 'C:\\y\\mcp-server.mjs' })

  uninstallMcp({ patchPath })
  const text = fs.readFileSync(patchPath, 'utf8')
  assert.ok(!text.includes(MCP_ENTRY_ID), '卸载后不该还有残留（块内块外都不许）')
  assert.match(text, /id: agent-default-model/)
  assert.match(text, /id: mcp-snowluma/)
})

test('status：块外的重复条目不算数', () => {
  const patchPath = tmpPatch()
  installMcp({ patchPath, nodeCmd: 'C:\\nodejs\\node.exe', serverPath: 'C:\\y\\mcp-server.mjs', dataRoot: 'D:\\yuanling' })
  const st = mcpStatus({ patchPath })
  assert.equal(st.installed, true)
  assert.match(st.nodeCmd, /node\.exe/)
  assert.ok(!st.nodeCmd.includes('Program Files'), '不该读到块外那份')
})

test('探针已移除：客户端与服务端都不再发 ping', () => {
  const client = read('web/client.js')
  assert.ok(!client.includes('ping=1'), '客户端不该再发探针请求')
  assert.ok(!client.includes('ping=2'), '客户端不该再发探针请求')

  const index = read('index.js')
  assert.ok(!index.includes("includes('ping=1')"), '服务端不该再有探针分支')
  assert.ok(!index.includes("'client.log'"), '不该再写调试日志')
})

test('目录分工：ref/ 不进仓库，doc/ 要随仓库发布', () => {
  const gi = read('.gitignore')
  assert.match(gi, /^\/ref\/$/m, 'ref/ 必须被忽略（自用参考）')
  assert.match(gi, /^\/WORKLIST\.md$/m, '根目录旧 WORKLIST 也要忽略（兼容）')
  assert.ok(!/^\/doc\/$/m.test(gi), 'doc/ 是给用户看的文档，不能被忽略')

  // 文档真的在 doc/ 里，且随包发布
  for (const name of ['PROTOCOL.md', 'PURPOSE_ANALYSIS.md', 'SECURITY.md']) {
    assert.ok(fs.existsSync(path.join(REPO, 'doc', name)), `doc/${name} 应该存在`)
  }
  assert.ok(JSON.parse(read('package.json')).files.includes('doc/'), 'files 里要有 doc/')
})
