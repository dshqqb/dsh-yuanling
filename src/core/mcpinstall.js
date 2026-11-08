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
export function buildBlock({ nodeCmd = defaultNodeCmd(), serverPath = defaultServerPath(), dataRoot = null } = {}) {
  const args = [serverPath]
  // 数据目录用参数传，不靠宿主 env：这样换机器/换目录都不用改宿主
  if (dataRoot) args.push('--root', dataRoot)
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
    ...args.map((a) => `          - ${quote(a)}`),
    '        toolCallTimeoutMs: 30000',
    MARK_END,
  ].join('\n')
}

const OUR_COMMENT_MARK = '由 `yuanling mcp install` 维护'

/** 把一段文本按顶层行（非空且不从空格开始）切成若干块。 */
function splitTopLevel(region) {
  const chunks = []
  let cur = []
  for (const line of String(region ?? '').split('\n')) {
    const startsNew = line.trim() !== '' && !/^\s/.test(line)
    if (startsNew && cur.length) {
      chunks.push(cur)
      cur = []
    }
    cur.push(line)
  }
  if (cur.length) chunks.push(cur)
  return chunks
}

/**
 * 把新块替换进文本；没有标记就追加到末尾。
 *
 * ⚠️ 这里**只能替换属于我们的那一段**，不能把 BEGIN 到 END 之间整体替换掉。
 * 真机事故（2026-11-08）：用户通过 DSH 设置页加的火山引擎 provider（`llm-pi-ai`）
 * 恰好落在标记块内部，整段替换把它一起删了，用户以为"api 消失了"。
 * 现在的做法：块里凡不是我们这条 entry 的内容，一律搬到 END 之后保留下来。
 */
export function applyBlock(text, block) {
  const src = String(text ?? '')
  const begin = src.indexOf(MARK_BEGIN)
  const end = src.indexOf(MARK_END)

  if (begin >= 0 && end > begin) {
    const region = src.slice(begin + MARK_BEGIN.length, end)
    const foreign = splitTopLevel(region)
      .filter((chunk) => {
        const joined = chunk.join('\n')
        // 我们的 entry 和我们自己生成的注释：删掉重写
        if (joined.includes(`- id: ${MCP_ENTRY_ID}`)) return false
        if (joined.includes(OUR_COMMENT_MARK)) return false
        return joined.trim() !== ''
      })
      .map((chunk) => chunk.join('\n').replace(/\s+$/u, ''))
      .filter(Boolean)

    const head = src.slice(0, begin)
    const tail = src.slice(end + MARK_END.length)
    const carried = foreign.length ? `\n\n${foreign.join('\n\n')}` : ''
    return `${head}${block}${carried}${tail}`
  }

  const base = src.replace(/\r\n/g, '\n').replace(/\s*$/u, '')
  return `${base ? `${base}\n\n` : ''}${block}\n`
}

/**
 * 找出**标记块外**的同名 id 条目，并整段删掉。
 *
 * 为什么需要它：手工往 patch 里贴过 `- insert: { - id: mcp-yuanling … }` 之后，
 * 文件里就有了两份同 id 条目（一份在标记块内、一份在外）。加载器会拿后者覆盖前者，
 * 而且 `mcp uninstall` 摘不掉块外那份 —— 改数据目录时它就成了幽灵配置。
 *
 * 判定方式很保守：只删「`- insert:\n  - id: <目标id>`」这一小段，遇到下一个
 * 顶层 `- ` 开头（列 0）的行就停。认不准就原样留着，宁可漏删也不误伤别人的条目。
 */
export function dedupeForeignEntries(text, id = MCP_ENTRY_ID) {
  const src = String(text ?? '')
  const lines = src.split('\n')
  const removed = []

  // 标记块的区间：块内一律不动
  const begin = src.indexOf(MARK_BEGIN)
  const end = src.indexOf(MARK_END)

  let i = 0
  while (i < lines.length) {
    if (!/^- insert:\s*$/.test(lines[i])) {
      i += 1
      continue
    }
    // 记下这一段的绝对字符位置，用来判断是否落在标记块内
    const insertStart = lines.slice(0, i).join('\n').length
    if (begin >= 0 && end > begin && insertStart >= begin && insertStart <= end) {
      i += 1
      continue
    }

    // 只看紧跟着的那一条 entry
    const entryLine = lines[i + 1] ?? ''
    const m = /^    - id: ([^\s#]+)\s*$/.exec(entryLine)
    if (!m || m[1] !== id) {
      i += 1
      continue
    }

    // 向后吃到「下一个顶层元素」为止。
    // 判据必须是「非空且不从空格开始」，不能只看 `^- `：
    // 列 0 的注释（例如 `# === qq-bridge MCP BEGIN ===`）属于**下一个块**，
    // 按 `^- ` 判会被一起吞掉——真机上就这么把 surfcore 的 BEGIN 标记删了。
    let j = i + 1
    while (j < lines.length) {
      const line = lines[j]
      if (line.trim() !== '' && !/^\s/.test(line)) break
      j += 1
    }

    // 尾部空行不跟着删（它们属于下一个块之前的视觉分隔）
    let tail = j
    while (tail > i + 1 && lines[tail - 1].trim() === '') tail -= 1

    removed.push(lines.slice(i + 1, tail).join('\n'))
    lines.splice(i, tail - i)
  }

  const out = lines.join('\n').replace(/\n{3,}/g, '\n\n')
  return { text: out, removed }
}

/**
 * 摘掉标记块，其余原样。
 *
 * 和 applyBlock 一样，**不能把 BEGIN→END 之间整段丢掉**：块里可能有用户后来写进去的
 * 条目（真机事故：火山引擎 provider 落在块内，被 install 删掉过）。卸载时同样要保住它们。
 */
export function stripBlock(text) {
  const src = String(text ?? '')
  const begin = src.indexOf(MARK_BEGIN)
  const end = src.indexOf(MARK_END)
  if (begin < 0 || end <= begin) return { text: src, changed: false }

  const region = src.slice(begin + MARK_BEGIN.length, end)
  const foreign = splitTopLevel(region)
    .filter((chunk) => {
      const joined = chunk.join('\n')
      if (joined.includes(`- id: ${MCP_ENTRY_ID}`)) return false
      if (joined.includes(OUR_COMMENT_MARK)) return false
      return joined.trim() !== ''
    })
    .map((chunk) => chunk.join('\n').replace(/\s+$/u, ''))
    .filter(Boolean)

  const before = src.slice(0, begin).replace(/\s*$/u, '')
  const after = src.slice(end + MARK_END.length).replace(/\s*$/u, '')
  const pieces = [before, foreign.join('\n\n'), after.replace(/^\s*$/u, '')].filter(Boolean)
  const joined = pieces.join('\n\n').replace(/\n{3,}/g, '\n\n')
  return { text: joined ? `${joined}\n` : '', changed: true }
}

/**
 * 当前状态：有没有块、里面的路径是什么。
 * **只在标记块内解析**——文件里还排着别人的 MCP 条目（snowluma 那几条就在我们前面）。
 */
export function mcpStatus({ patchPath }) {
  let text = ''
  try {
    text = fs.readFileSync(patchPath, 'utf8')
  } catch {
    return { exists: false, installed: false, patchPath }
  }
  const begin = text.indexOf(MARK_BEGIN)
  const end = text.indexOf(MARK_END)
  const installed = begin >= 0 && end > begin
  const block = installed ? text.slice(begin, end) : ''

  const nodeMatch = /command: '([^']*)'/.exec(block)
  // args 是若干单引号行；顺序 [serverPath, '--root', dataRoot]
  const argv = [...block.matchAll(/^\s{4,}- '([^']*)'$/gm)].map((m) => m[1])

  return {
    exists: true,
    installed,
    patchPath,
    nodeCmd: installed ? (nodeMatch?.[1] ?? '') : '',
    serverPath: installed ? (argv[0] ?? '') : '',
    dataRoot: installed ? (argv[2] ?? '') : '',
  }
}

function backupOf(patchPath) {
  return `${patchPath}.bak-yuanling`
}

/**
 * 把"文件被占用"翻译成人话。
 * Windows 上 DSH 正跑着时，profile 的 cordis.patch.yml 是热加载的，rename 会 EPERM；
 * 直接甩 EPERM 没人看得懂，用户会以为是权限不够。
 */
export function friendlyWriteError(error) {
  const code = error?.code
  if (code === 'EPERM' || code === 'EBUSY' || code === 'EACCES') {
    const e = new Error(
      `写入失败：文件被占用（${code}）。如果 DSH 正在运行，请先退出 DSH 再执行——它占着 profile 的 cordis.patch.yml。`,
    )
    e.cause = error
    return e
  }
  return error
}

/**
 * 安装（幂等）。**写前先备份**，备份文件固定名，不产生一堆垃圾。
 * @returns {{patchPath:string, changed:boolean, backup:string|null, restartRequired:boolean}}
 */
export function installMcp({
  patchPath,
  nodeCmd = defaultNodeCmd(),
  serverPath = defaultServerPath(),
  dataRoot = null,
  dryRun = false,
} = {}) {
  if (!patchPath) throw new Error('缺少 profile 的 cordis.patch.yml 路径')
  if (!fs.existsSync(patchPath)) throw new Error(`找不到 ${patchPath}（profile 是否装好？可用 --dir 指定）`)

  const before = fs.readFileSync(patchPath, 'utf8')
  const block = buildBlock({ nodeCmd, serverPath, dataRoot })

  // 顺序很重要：先清掉标记块外的同名残留，再写块。
  // 否则文件里会同时存在两份同 id 条目（见过：手工加的那份把块内那份盖掉）。
  const deduped = dedupeForeignEntries(before)
  const after = applyBlock(deduped.text, block)
  const changed = after !== before

  if (!dryRun && changed) {
    const backup = backupOf(patchPath)
    fs.copyFileSync(patchPath, backup)
    ensureDir(path.dirname(patchPath))
    try {
      writeFileAtomic(patchPath, after)
    } catch (error) {
      throw friendlyWriteError(error)
    }
    return { patchPath, changed: true, backup, restartRequired: true, removedForeign: deduped.removed }
  }
  return { patchPath, changed, backup: null, restartRequired: changed, removedForeign: deduped.removed }
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
    try {
      writeFileAtomic(patchPath, r.text)
    } catch (error) {
      throw friendlyWriteError(error)
    }
    return { patchPath, changed: true, backup, restartRequired: true }
  }
  return { patchPath, changed: true, restartRequired: true }
}
