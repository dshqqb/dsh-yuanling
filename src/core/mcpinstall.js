// src/core/mcpinstall.js —— 把 MCP 条目写进宿主的 cordis.patch.yml。
//
// 为什么要有一个命令，而不是让用户手改：
//   · 条目里含**绝对路径**（装在哪台机器都不一定一样），没法硬编码进包；
//   · 手改的东西没有幂等保障：重装、换 profile 就丢；
//   · 卸载时用户不知道该删哪几行。
//
// 纪律：只动标记块内部。标记外的一律原样保留。
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { ensureDir, writeFileAtomic } from './fsx.js'

export const MARK_BEGIN = '# === yuanling MCP BEGIN ==='
export const MARK_END = '# === yuanling MCP END ==='
export const MCP_ENTRY_ID = 'mcp-yuanling'
export const MCP_SERVER_NAME = 'yuanling'

/** 本仓库里 MCP 服务器脚本的位置（相对本文件固定）。 */
export function defaultServerPath() {
  return fileURLToPath(new URL('../../mcp-server.mjs', import.meta.url))
}

/** 默认 node：跑 CLI 的那个 node；不是 node 就退回 PATH 里的 node。 */
export function defaultNodeCmd(execPath = process.execPath) {
  const base = path.basename(String(execPath ?? '')).toLowerCase()
  return base.startsWith('node') ? execPath : 'node'
}

/** 找出 ~/.dsh/profiles/<name>/ 下所有带 cordis.patch.yml 的 profile。 */
export function findProfiles(homeDir = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')) {
  const dir = path.join(homeDir, 'profiles')
  let names = []
  try {
    names = fs.readdirSync(dir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name)
  } catch {
    return []
  }
  const out = []
  for (const name of names) {
    const patchPath = path.join(dir, name, 'cordis.patch.yml')
    if (fs.existsSync(patchPath)) out.push({ name, dir: path.join(dir, name), patchPath })
  }
  return out
}

function quote(s) {
  return `'${String(s).replace(/'/g, "''")}'`
}

/** 生成标记块（含前后标记行）。 */
export function buildBlock({ nodeCmd = defaultNodeCmd(), serverPath = defaultServerPath() } = {}) {
  return [
    MARK_BEGIN,
    '# 由 `yuanling mcp install` 维护；整块会被替换，请勿手工编辑内部条目。',
    '- insert:',
    `    - id: ${MCP_ENTRY_ID}`,
    "      name: '@deepseek-ai/dsh-mcp-client'",
    '      config:',
    `        serverName: ${MCP_SERVER_NAME}`,
    '        transport: stdio',
    `        command: ${quote(nodeCmd)}`,
    '        args:',
    `          - ${quote(serverPath)}`,
    '        toolCallTimeoutMs: 30000',
    MARK_END,
  ].join('\n')
}

/** 把新块替换进文本；没有标记就追加到末尾。 */
export function applyBlock(text, block) {
  const src = String(text ?? '')
  const begin = src.indexOf(MARK_BEGIN)
  const end = src.indexOf(MARK_END)

  if (begin >= 0 && end > begin) {
    const after = end + MARK_END.length
    return `${src.slice(0, begin)}${block}${src.slice(after)}`
  }
  const base = src.replace(/\r\n/g, '\n').replace(/\s*$/u, '')
  return `${base ? `${base}\n\n` : ''}${block}\n`
}

/** 摘掉标记块，其余原样。 */
export function stripBlock(text) {
  const src = String(text ?? '')
  const begin = src.indexOf(MARK_BEGIN)
  const end = src.indexOf(MARK_END)
  if (begin < 0 || end <= begin) return { text: src, changed: false }

  const before = src.slice(0, begin).replace(/\s*$/u, '')
  const after = src.slice(end + MARK_END.length).replace(/\s*$/u, '')
  const joined = [before, after].filter(Boolean).join('\n\n')
  return { text: joined ? `${joined}\n` : '', changed: true }
}

/** 当前状态：有没有块、里面的路径是什么。 */
export function mcpStatus({ patchPath }) {
  let text = ''
  try {
    text = fs.readFileSync(patchPath, 'utf8')
  } catch {
    return { exists: false, installed: false, patchPath }
  }
  const installed = text.includes(MARK_BEGIN) && text.includes(MARK_END)
  const nodeMatch = /command: '([^']*)'/.exec(text)
  const argMatch = /args:\s*\n\s*- '([^']*)'/.exec(text)
  return {
    exists: true,
    installed,
    patchPath,
    nodeCmd: installed ? (nodeMatch?.[1] ?? '') : '',
    serverPath: installed ? (argMatch?.[1] ?? '') : '',
  }
}

function backupOf(patchPath) {
  return `${patchPath}.bak-yuanling`
}

/**
 * 安装（幂等）。**写前先备份**，备份文件固定名，不产生一堆垃圾。
 * @returns {{patchPath:string, changed:boolean, backup:string|null, restartRequired:boolean}}
 */
export function installMcp({ patchPath, nodeCmd = defaultNodeCmd(), serverPath = defaultServerPath(), dryRun = false } = {}) {
  if (!patchPath) throw new Error('缺少 profile 的 cordis.patch.yml 路径')
  if (!fs.existsSync(patchPath)) throw new Error(`找不到 ${patchPath}（profile 是否装好？可用 --dir 指定）`)

  const before = fs.readFileSync(patchPath, 'utf8')
  const block = buildBlock({ nodeCmd, serverPath })
  const after = applyBlock(before, block)
  const changed = after !== before

  if (!dryRun && changed) {
    const backup = backupOf(patchPath)
    fs.copyFileSync(patchPath, backup)
    ensureDir(path.dirname(patchPath))
    writeFileAtomic(patchPath, after)
    return { patchPath, changed: true, backup, restartRequired: true }
  }
  return { patchPath, changed, backup: null, restartRequired: changed }
}

/** 卸载：只摘自己那段。 */
export function uninstallMcp({ patchPath, dryRun = false } = {}) {
  if (!patchPath) throw new Error('缺少 profile 的 cordis.patch.yml 路径')
  if (!fs.existsSync(patchPath)) throw new Error(`找不到 ${patchPath}`)

  const before = fs.readFileSync(patchPath, 'utf8')
  const r = stripBlock(before)
  if (!r.changed) return { patchPath, changed: false, restartRequired: false }

  if (!dryRun) {
    const backup = backupOf(patchPath)
    fs.copyFileSync(patchPath, backup)
    writeFileAtomic(patchPath, r.text)
    return { patchPath, changed: true, backup, restartRequired: true }
  }
  return { patchPath, changed: true, restartRequired: true }
}
