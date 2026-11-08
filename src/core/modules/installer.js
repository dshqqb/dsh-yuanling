// src/core/modules/installer.js —— 从发行包装模块（协议 §2）。
//
// 为什么是"下载 tgz"而不是"git clone"：
//   · 用户机器上不一定有 git；
//   · clone 之后总要 npm install，那等于让远程仓库在你机器上执行代码（§2.5 正警惕这个）；
//   · 更新/回滚是"换一个 tgz"，而 pull 拿到的是"某个 commit"，退不回去。
//
// 安全约束（每一条都有对应测试）：
//   · 只允许 https（明文 http 只允许 localhost，方便本地联调）；
//   · sha256 必须对上（给了 expected 就必须校验）；
//   · 解包前先看清单：**拒绝任何绝对路径 / .. / 特殊成员**；
//   · 装完再跑 `--ignore-scripts` 那条规矩：我们根本不跑 npm，所以不存在构建脚本。
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

import { ensureDir, writeFileAtomic } from '../fsx.js'
import { P } from '../paths.js'
import { untar, stripPackagePrefix } from './untar.js'
import { validateManifest, summarizeErrors } from './manifest.js'
import { moduleDir, readRegistry, writeRegistry, makeEntry, conflictingRoutes } from './registry.js'

/** 下载体积上限（模块包不该比这大；超了多半是打错地址）。 */
export const MAX_BYTES = 64 * 1024 * 1024

export function sha256Of(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex')
}

/** 只允许 https；http 仅限本机（测试与本地联调用）。 */
export function checkUrl(url) {
  let u
  try {
    u = new URL(String(url))
  } catch {
    return { ok: false, reason: `不是合法 URL：${url}` }
  }
  if (u.protocol === 'https:') return { ok: true, url: u }
  if (u.protocol === 'http:') {
    const host = u.hostname
    const loopback = host === '127.0.0.1' || host === 'localhost' || host === '::1'
    if (loopback) return { ok: true, url: u }
    return { ok: false, reason: '只允许 https（http 仅限本机回环，避免明文传输被篡改）' }
  }
  return { ok: false, reason: `不支持的协议：${u.protocol}` }
}

/**
 * 下载字节。测试里可以注入 fetch 以外的实现（传入 fetchImpl），也可以直接给 bytes。
 * @returns {Promise<Buffer>}
 */
export async function download(url, { timeoutMs = 60_000, fetchImpl = globalThis.fetch } = {}) {
  const checked = checkUrl(url)
  if (!checked.ok) throw new Error(checked.reason)
  if (typeof fetchImpl !== 'function') throw new Error('当前环境没有 fetch，无法下载')

  const ctrl = typeof AbortController === 'function' ? new AbortController() : null
  const timer = ctrl ? setTimeout(() => ctrl.abort(), timeoutMs) : null
  try {
    const res = await fetchImpl(checked.url.href, { signal: ctrl?.signal, redirect: 'follow' })
    if (!res.ok) throw new Error(`下载失败：HTTP ${res.status}`)
    const buf = Buffer.from(await res.arrayBuffer())
    if (buf.length > MAX_BYTES) throw new Error(`模块包太大（${buf.length} 字节，上限 ${MAX_BYTES}）`)
    return buf
  } finally {
    if (timer) clearTimeout(timer)
  }
}

/**
 * 把包解开并落盘到 `system/modules/<id>/`。
 * **先写临时目录再整体替换**：装一半失败时不会留下半个模块。
 */
export function extractToDir(entries, destDir) {
  const staging = `${destDir}.installing-${crypto.randomBytes(4).toString('hex')}`
  try {
    ensureDir(staging)
    for (const e of entries) {
      if (e.type === 'dir') {
        ensureDir(path.join(staging, e.name))
        continue
      }
      const target = path.join(staging, e.name)
      // 双保险：名单已经过滤过非法路径，这里再按真实路径确认一次
      const rel = path.relative(staging, target)
      if (rel.startsWith('..') || path.isAbsolute(rel)) throw new Error(`非法路径：${e.name}`)
      ensureDir(path.dirname(target))
      fs.writeFileSync(target, e.data)
    }

    // 整体替换旧目录：先把旧的挪走，失败还能挪回来
    const backup = `${destDir}.previous-${crypto.randomBytes(4).toString('hex')}`
    if (fs.existsSync(destDir)) fs.renameSync(destDir, backup)
    fs.renameSync(staging, destDir)
    try {
      if (fs.existsSync(backup)) fs.rmSync(backup, { recursive: true, force: true })
    } catch {
      /* 清不掉备份不影响使用 */
    }
    return { dir: destDir }
  } catch (error) {
    try {
      if (fs.existsSync(staging)) fs.rmSync(staging, { recursive: true, force: true })
    } catch {
      /* ignore */
    }
    throw error
  }
}

/** 从包里取出 manifest 并校验。 */
export function manifestFromEntries(entries) {
  const hit = entries.find((e) => e.name === 'yuanling.module.json')
  if (!hit) return { ok: false, errors: [{ field: '*', code: 'MISSING', message: '包里没有 yuanling.module.json' }] }
  let raw
  try {
    raw = JSON.parse(hit.data.toString('utf8'))
  } catch (error) {
    return { ok: false, errors: [{ field: '*', code: 'BAD_JSON', message: `manifest 不是合法 JSON：${error.message}` }] }
  }
  return validateManifest(raw)
}

/**
 * 安装 / 更新一个模块（从已下载的字节）。
 *
 * @param {object} opts
 * @param {string} opts.root      数据目录
 * @param {Buffer} opts.bytes     包字节
 * @param {string} opts.repo      来源（release 页或仓库地址，记进注册表）
 * @param {string} [opts.source]  源名（github / gitee / manual）
 * @param {string} [opts.expectSha256]
 * @param {string} [opts.ref]     版本或 commit（记进注册表，便于回滚说明）
 * @param {boolean} [opts.dryRun]
 */
export function installFromBytes({
  root,
  bytes,
  repo = null,
  source = null,
  expectSha256 = null,
  ref = null,
  dryRun = false,
}) {
  if (!bytes || !bytes.length) throw new Error('包为空')

  const sha = sha256Of(bytes)
  if (expectSha256 && String(expectSha256).toLowerCase() !== sha) {
    throw new Error(`sha256 不符：期望 ${expectSha256}，实际 ${sha}`)
  }

  const { entries: all } = untar(bytes)
  const entries = stripPackagePrefix(all)
  if (!entries.length) throw new Error('包里没有任何文件')

  const check = manifestFromEntries(entries)
  if (!check.ok) throw new Error(`manifest 校验失败 —— ${summarizeErrors(check.errors)}`)

  const manifest = check.manifest
  const reg = readRegistry(root)

  // 单例：同 id 已装 = 更新
  const prev = reg.modules[manifest.id] ?? null
  const clashes = conflictingRoutes(reg, manifest.routes ?? [], { ignoreId: manifest.id })
  if (clashes.length) {
    throw new Error(`路由冲突：${clashes.map((c) => `${c.route} 已被 ${c.id} 占用`).join('；')}`)
  }

  const destDir = moduleDir(root, manifest.id)
  if (!dryRun) extractToDir(entries, destDir)

  const entry = makeEntry({
    manifest,
    source,
    repo: repo ?? prev?.repo ?? null,
    ref,
    // 更新时保留既有授予；新装时按 defaultGranted（调用方决定 send 这类能力给不给）
    granted: prev ? undefined : manifest.capabilities,
  })
  if (prev) {
    entry.granted = (prev.granted ?? []).filter((c) => (manifest.capabilities ?? []).includes(c))
    entry.previousRepo = prev.repo !== entry.repo ? prev.repo : prev.previousRepo ?? null
    entry.installed_at = prev.installed_at // 更新不改"初次安装时间"
    entry.enabled = prev.enabled !== false
    entry.state = 'stopped'
  }

  if (!dryRun) {
    reg.modules[manifest.id] = entry
    writeRegistry(root, reg)
    writeFileAtomic(
      path.join(destDir, 'VERSION'),
      `${JSON.stringify({ version: manifest.version, api: manifest.api, sha256: sha, source, repo, ref, at: entry.installed_at }, null, 2)}\n`,
    )
  }

  return { manifest, entry, dir: destDir, sha256: sha, updated: Boolean(prev), dryRun }
}

/** 卸载：删目录 + 摘注册表条目。数据（system/modules/<id>/config.json）一并删。 */
export function uninstall(root, id, { dryRun = false } = {}) {
  const reg = readRegistry(root)
  if (!reg.modules[id]) throw new Error(`没有装过模块：${id}`)
  const dir = moduleDir(root, id)

  if (!dryRun) {
    delete reg.modules[id]
    writeRegistry(root, reg)
    try {
      if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true })
    } catch (error) {
      throw new Error(`删不掉模块目录：${error.message}`)
    }
  }
  return { id, dir, dryRun }
}

/** 模块自己的临时目录（协议 §15 的 $YUANLING_TMP）。 */
export function moduleTmpDir(root, id) {
  return path.join(root, 'system', 'tmp', id)
}

/** 数据目录常量，页面/测试用。 */
export const MODULES_REL = P.modules
