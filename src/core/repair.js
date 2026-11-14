// src/core/repair.js —— 把原灵重新登记回 DSH profile。
//
// 为什么需要它（2026-11-14 的事故）：
//   DSH 桌面的「禁用第三方插件、备份 profile patch 并重启」会做三件事：
//     ① profile 的 package.json 删掉第三方 dependencies；
//     ② dsh.profile.bundles 删掉第三方 bundle；
//     ③ cordis.patch.yml 里第三方条目整段清掉。
//   于是原灵在设置页里直接消失，而且**之后也不会再被加载**。
//
// 关键点（读 `@deepseek-ai/dsh-app-boot` 的 loadProfile 确认过）：
//   profile 里那条 `- id: dsh-yuanling` 只是**对已存在条目的 config 覆盖**；
//   条目本身来自插件包自己的 `dsh.bundle.patch`，而那个只有把插件写进
//   `dsh.profile.bundles` 才会被应用。所以「注册」这一步是 bundles，不是 patch。
//
// 这个命令幂等、可 dry-run，只补三样 + 两样可选的：
//   ① dependencies 里加回 `dsh-yuanling: link:<本仓库>`
//   ② dsh.profile.bundles 里加回 `dsh-yuanling`
//   ③ node_modules/dsh-yuanling 软链回本仓库
//   ④ cordis.patch.yml 里补一条带 dataDir 的配置条目（没有才补，有就不动）
//   ⑤ MCP 条目（mcp-server.mjs）——复用 mcpinstall 的幂等写块
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { exists, writeFileAtomic, writeJsonAtomic } from './fsx.js'
import { installMcp } from './mcpinstall.js'

export const PLUGIN_NAME = 'dsh-yuanling'

const ENTRY_BEGIN = '# === yuanling plugin BEGIN ==='
const ENTRY_END = '# === yuanling plugin END ==='

/** 本仓库（插件根）。 */
export function pluginDir() {
  return fileURLToPath(new URL('../../', import.meta.url)).replace(/[\\/]+$/, '')
}

/** DSH 数据根：显式 → DSH_HOME → ~/.dsh。 */
export function dshHome(explicit = null) {
  if (explicit) return path.resolve(String(explicit))
  if (process.env.DSH_HOME) return path.resolve(process.env.DSH_HOME)
  return path.join(os.homedir(), '.dsh')
}

/** 列出 home 下的 profile（带 package.json 与 cordis.patch.yml 的目录）。 */
export function listProfiles(home = dshHome()) {
  const dir = path.join(home, 'profiles')
  let names = []
  try {
    names = fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name)
      .sort()
  } catch {
    return []
  }
  return names
    .map((name) => {
      const profileDir = path.join(dir, name)
      return {
        name,
        dir: profileDir,
        pkgPath: path.join(profileDir, 'package.json'),
        patchPath: path.join(profileDir, 'cordis.patch.yml'),
        packageOk: exists(path.join(profileDir, 'package.json')),
        patchOk: exists(path.join(profileDir, 'cordis.patch.yml')),
      }
    })
    .filter((p) => p.packageOk || p.patchOk)
}

/** 选一个 profile：显式指定 → 有 dsh-yuanling 痕迹的 → 唯一一个 → 报错。 */
export function resolveProfile(name = null, home = dshHome()) {
  const all = listProfiles(home)
  if (name) {
    const hit = all.find((p) => p.name === String(name))
    if (!hit) throw new Error(`没有这个 profile：${name}（现有：${all.map((p) => p.name).join('、') || '无'}）`)
    return hit
  }
  if (!all.length) throw new Error(`在 ${home} 下没找到任何 profile（是不是 DSH 还没初始化？）`)
  const withUs = all.find((p) => {
    try {
      return fs.readFileSync(p.pkgPath, 'utf8').includes(PLUGIN_NAME) || (p.patchOk && fs.readFileSync(p.patchPath, 'utf8').includes(PLUGIN_NAME))
    } catch {
      return false
    }
  })
  if (withUs) return withUs
  if (all.length === 1) return all[0]
  const desktop = all.find((p) => p.name === 'desktop')
  if (desktop) return desktop
  throw new Error(`有多个 profile（${all.map((p) => p.name).join('、')}），请用 --profile 指定一个`)
}

function readJsonFile(file, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    return fallback
  }
}

function linkSpec(dir) {
  return `link:${String(dir).replace(/\\/g, '/')}`
}

/** 按顶层 `- ` 切块（缩进行跟着上一块）。 */
export function splitTopLevel(text) {
  const lines = String(text ?? '').replace(/\r\n/g, '\n').split('\n')
  const head = []
  const blocks = []
  let cur = null
  for (const line of lines) {
    const startsEntry = /^-\s/.test(line) || line === '-'
    if (startsEntry) {
      if (cur) blocks.push(cur)
      cur = [line]
    } else if (cur) {
      cur.push(line)
    } else {
      head.push(line)
    }
  }
  if (cur) blocks.push(cur)
  return { head, blocks: blocks.map((b) => b.join('\n')) }
}

function blockId(block) {
  const m = String(block).match(/^-\s+id:\s*['"]?([^'"\s]+)['"]?\s*$/m)
  return m ? m[1] : ''
}

function entryBlock(dataRoot) {
  const lines = [
    ENTRY_BEGIN,
    '# 由 `yuanling repair` 维护；整块会被替换，请勿手工编辑内部条目。',
    `- id: ${PLUGIN_NAME}`,
    `  name: ${PLUGIN_NAME}`,
    '  config:',
  ]
  if (dataRoot) lines.push(`    dataDir: '${String(dataRoot).replace(/'/g, "''")}'`)
  lines.push('    enabled: true', ENTRY_END)
  return lines.join('\n')
}

/**
 * 修好一个 profile。
 *
 * @param {object} o
 * @param {string} [o.profile]    profile 名（不给就自动挑）
 * @param {string} [o.home]       DSH 数据根
 * @param {string} [o.pluginDir]  插件所在目录（默认本仓库）
 * @param {string|null} [o.dataRoot] 数据目录；不给就看 patch 里原有的
 * @param {boolean} [o.withMcp]   顺手补 MCP 条目（默认 true）
 * @param {boolean} [o.dryRun]    只报告不写盘
 * @returns {{profile, dir, changes:string[], warnings:string[], backups:string[], restartRequired:boolean}}
 */
export function repair({ profile = null, home = null, pluginDir: dir = null, dataRoot = null, withMcp = true, dryRun = false } = {}) {
  const h = dshHome(home)
  const target = resolveProfile(profile, h)
  const src = path.resolve(dir ?? pluginDir())
  const changes = []
  const warnings = []
  const backups = []

  // ① package.json：依赖 + bundle
  const pkg = readJsonFile(target.pkgPath, null)
  if (!pkg || typeof pkg !== 'object') throw new Error(`读取失败：${target.pkgPath}`)
  const next = { ...pkg }
  next.dependencies = { ...(pkg.dependencies ?? {}) }
  const want = linkSpec(src)
  if (next.dependencies[PLUGIN_NAME] !== want) {
    changes.push(`dependencies: ${PLUGIN_NAME} → ${want}`)
    next.dependencies[PLUGIN_NAME] = want
  }
  next.dsh = { ...(pkg.dsh ?? {}) }
  next.dsh.profile = { ...(next.dsh.profile ?? {}) }
  const bundles = Array.isArray(next.dsh.profile.bundles) ? [...next.dsh.profile.bundles] : []
  if (!bundles.includes(PLUGIN_NAME)) {
    bundles.push(PLUGIN_NAME)
    changes.push(`dsh.profile.bundles: 加入 ${PLUGIN_NAME}（这一条才是"注册"）`)
  }
  next.dsh.profile.bundles = bundles

  // ② node_modules 软链
  const linkPath = path.join(target.dir, 'node_modules', PLUGIN_NAME)
  const ignoredPath = path.join(target.dir, 'node_modules', `.ignored_${PLUGIN_NAME}`)
  let needLink = true
  if (exists(linkPath)) {
    try {
      needLink = fs.realpathSync(linkPath) !== fs.realpathSync(src)
      if (needLink) changes.push(`node_modules/${PLUGIN_NAME}: 指向别处，改指 ${src}`)
    } catch {
      needLink = true
      changes.push(`node_modules/${PLUGIN_NAME}: 链接坏了，重建`)
    }
  } else {
    changes.push(`node_modules/${PLUGIN_NAME}: 建立链接 → ${src}`)
  }

  // ③ cordis.patch.yml：配置条目
  let patchText = ''
  try {
    patchText = fs.readFileSync(target.patchPath, 'utf8')
  } catch {
    warnings.push(`没有 ${target.patchPath}，会新建一份（内容只有本插件的条目）`)
  }
  const { head, blocks } = splitTopLevel(patchText)
  const ours = blocks.filter((b) => blockId(b) === PLUGIN_NAME)
  const others = blocks.filter((b) => blockId(b) !== PLUGIN_NAME)

  // dataDir：参数 → 已有条目 → 不写
  let effectiveRoot = dataRoot ? String(dataRoot) : ''
  if (!effectiveRoot) {
    const m = ours.map((b) => String(b).match(/^\s+dataDir:\s*['"]?(.+?)['"]?\s*$/m)).find(Boolean)
    effectiveRoot = m ? m[1] : ''
  }
  if (!effectiveRoot) {
    warnings.push('不知道数据目录：patch 里没有 dataDir，命令行也没给 --data-dir；插件会回落到默认的 ~/.dsh/yuanling')
  }
  const shouldRewrite = ours.length !== 1 || (effectiveRoot && !/dataDir:/.test(ours[0] ?? ''))
  if (ours.length === 0) changes.push('cordis.patch.yml: 补一条 dsh-yuanling 配置条目')
  else if (ours.length > 1) changes.push(`cordis.patch.yml: 有 ${ours.length} 条重复的 dsh-yuanling 条目，收成一条`)
  else if (shouldRewrite) changes.push('cordis.patch.yml: dsh-yuanling 条目没有 dataDir，补上')

  const keep = shouldRewrite ? [...others, entryBlock(effectiveRoot)] : blocks
  const newPatch = [...head, ...keep].join('\n').replace(/\n{3,}/g, '\n\n').replace(/\s*$/, '\n')
  const patchChanged = newPatch !== patchText

  const report = {
    profile: target.name,
    dir: target.dir,
    pluginDir: src,
    dataRoot: effectiveRoot || null,
    changes,
    warnings,
    backups,
    restartRequired: changes.length > 0,
  }
  if (dryRun) return { ...report, dryRun: true }

  // 写盘：先备份（固定后缀，不产生一堆垃圾）
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const backup = (file) => {
    if (!exists(file)) return
    const to = `${file}.bak-repair-${stamp}`
    fs.copyFileSync(file, to)
    backups.push(to)
  }
  if (changes.some((c) => c.startsWith('dependencies') || c.startsWith('dsh.profile.bundles'))) {
    backup(target.pkgPath)
    writeJsonAtomic(target.pkgPath, next)
  }
  if (patchChanged) {
    backup(target.patchPath)
    fs.mkdirSync(path.dirname(target.patchPath), { recursive: true })
    writeFileAtomic(target.patchPath, newPatch)
  }
  if (needLink) {
    fs.mkdirSync(path.join(target.dir, 'node_modules'), { recursive: true })
    if (exists(ignoredPath)) {
      try {
        fs.rmSync(ignoredPath, { recursive: true, force: true })
      } catch {
        /* 删不掉就留着，不影响 */
      }
    }
    if (exists(linkPath)) {
      try {
        fs.rmSync(linkPath, { recursive: true, force: true })
      } catch (err) {
        throw new Error(`删不掉旧的 ${linkPath}：${err?.message ?? err}（DSH 是不是还开着？先退出它再试）`)
      }
    }
    const type = process.platform === 'win32' ? 'junction' : 'dir'
    fs.symlinkSync(src, linkPath, type)
  }

  // ④ MCP 条目（幂等；它自己会备份）
  let mcp = null
  if (withMcp) {
    try {
      mcp = installMcp({ patchPath: target.patchPath, dataRoot: effectiveRoot || null })
      if (mcp.changed) changes.push('cordis.patch.yml: 补了 mcp-yuanling（模型工具）')
      if (mcp.backup) backups.push(mcp.backup)
    } catch (err) {
      warnings.push(`MCP 条目没装上：${err?.message ?? err}`)
    }
  }

  return { ...report, mcp, restartRequired: changes.length > 0 }
}
