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

/** 托管平台：只有这两个能"给个库地址就自动找发行包"。 */
export const REPO_HOSTS = ['github.com', 'gitee.com']

/**
 * 把"库的网址"拆成 owner / repo / 可选 tag。
 *
 * 认这些写法（管理台里人真的会这么粘）：
 *   https://gitee.com/o/r
 *   https://gitee.com/o/r.git
 *   https://github.com/o/r/tree/main
 *   https://github.com/o/r/releases/tag/v0.1.0     ← 指定版本
 * 不认的（archive 源码包、issues 之类）交给上层报错，别硬猜。
 */
export function parseRepoUrl(raw) {
  let u
  try {
    u = new URL(String(raw))
  } catch {
    return null
  }
  if (!REPO_HOSTS.includes(u.hostname)) return null

  const seg = u.pathname.split('/').filter(Boolean)
  if (seg.length < 2) return null
  const owner = seg[0]
  const repo = seg[1].replace(/\.git$/, '')
  if (!owner || !repo) return null

  // 指定版本：/releases/tag/<tag>（GitHub 也支持 /releases/tags/<tag>）
  let tag = null
  const i = seg.indexOf('releases')
  if (i >= 0 && seg[i + 1] === 'tag' && seg[i + 2]) tag = decodeURIComponent(seg[i + 2])

  return { host: u.hostname, owner, repo, tag }
}

/** 一个 URL 是不是 .tgz 直链（含 /releases/download/<tag>/x.tgz 这种）。 */
export function isTgzUrl(raw) {
  try {
    const u = new URL(String(raw))
    return u.pathname.toLowerCase().endsWith('.tgz')
  } catch {
    return false
  }
}

function apiHeaders(host) {
  // GitHub 要 UA，不然 403；Gitee 匿名可访问、不需要 token
  return host === 'github.com'
    ? { 'user-agent': 'yuanling-module-installer', accept: 'application/vnd.github+json' }
    : { 'user-agent': 'yuanling-module-installer', accept: 'application/json' }
}

/** 从发行版条目里挑一个 tgz 资产。
 *
 * **只认 `.tgz`**：两个平台都会把源码归档（`v1.2.3.tar.gz` / `.zip`）塞进 assets，
 * 它长得像模块包但解出来是仓库源码（没有 yuanling.module.json）。
 * 曾经放行 `tar.gz` 就把源码包当模块包下载了——所以这里的正则故意写死成 tgz。
 */
export function pickTgzAsset(assets) {
  const list = Array.isArray(assets) ? assets : []
  const items = list
    .map((a) => ({
      name: String(a?.name ?? ''),
      url: String(a?.browser_download_url ?? a?.url ?? ''),
    }))
    .filter((a) => a.url && /\.tgz$/i.test(a.name) && !/source|archive/i.test(a.name))
  if (!items.length) return null
  // 有多个时优先名字里带版本的（`bili-0.1.0.tgz`），否则按名字排序取第一个，保证结果可复现
  const versioned = items.find((a) => /\d+\.\d+\.\d+/.test(a.name))
  return versioned ?? items.slice().sort((a, b) => a.name.localeCompare(b.name))[0]
}

/** 按 created_at 倒序，挑"最新且非预发布"的那一条。 */
export function latestRelease(releases) {
  const list = Array.isArray(releases) ? releases.filter((r) => r && typeof r === 'object') : []
  const stable = list.filter((r) => r.prerelease !== true)
  const pool = stable.length ? stable : list
  return pool
    .slice()
    .sort((a, b) => String(b.created_at ?? '').localeCompare(String(a.created_at ?? '')))[0] ?? null
}

/**
 * 把"库的网址"或".tgz 直链"解析成可以下载的 tgz 地址。
 *
 * @returns {Promise<{tgzUrl:string, repo:string|null, ref:string|null, source:string, assetName:string|null}>}
 */
export async function resolveInstallUrl(raw, { fetchImpl = globalThis.fetch, timeoutMs = 20_000 } = {}) {
  const input = String(raw ?? '').trim()
  if (!input) throw new Error('请填一个地址：库的网址（Gitee / GitHub）或 .tgz 直链')

  const checked = checkUrl(input)
  if (!checked.ok) throw new Error(checked.reason)

  if (isTgzUrl(input)) {
    return { tgzUrl: input, repo: null, ref: null, source: 'url', assetName: null }
  }

  const repo = parseRepoUrl(input)
  if (!repo) {
    throw new Error(
      `看不懂这个地址：${input}\n` +
        '能填两种：① 库的网址（https://gitee.com/<owner>/<repo> 或 https://github.com/<owner>/<repo>）；② 模块包 .tgz 的直链。',
    )
  }

  if (typeof fetchImpl !== 'function') throw new Error('当前环境没有 fetch，无法查询发行版')

  const repoUrl = `https://${repo.host}/${repo.owner}/${repo.repo}`
  const api =
    repo.host === 'github.com'
      ? `https://api.github.com/repos/${repo.owner}/${repo.repo}/releases`
      : `https://gitee.com/api/v5/repos/${repo.owner}/${repo.repo}/releases?per_page=100`

  let releases = null
  try {
    const res = await fetchImpl(api, {
      headers: apiHeaders(repo.host),
      signal: AbortSignal.timeout ? AbortSignal.timeout(timeoutMs) : undefined,
    })
    if (res.status === 404) {
      // 库不存在、是私有库、或 owner/repo 打错——这三种在页面上长得一模一样
      throw Object.assign(
        new Error(`找不到这个库（HTTP 404）：${repoUrl}。检查 owner/repo 拼写；私有库需要先公开`),
        { code: 'E_NO_REPO' },
      )
    }
    if (res.status === 403) {
      throw Object.assign(
        new Error(`${repo.host} 拒绝匿名访问（HTTP 403）：可能被限流了，稍后再试或改用 grep 直链`),
        { code: 'E_RATE' },
      )
    }
    if (!res.ok) throw new Error(`${repo.host} 返回 HTTP ${res.status}（${api}）`)
    releases = await res.json()
  } catch (error) {
    const msg = String(error?.message ?? error)
    if (/AbortError|timeout/i.test(msg)) throw new Error(`查发行版超时（${timeoutMs}ms）：${api}`)
    if (error?.code) throw error
    throw new Error(`查发行版失败：${msg}`)
  }

  const list = Array.isArray(releases) ? releases : []
  if (!list.length) {
    // 区分"只是没建发行版"和"推了 tag 但没建发行版"——后者最常见：
    // 开发者以为推 tag 就够了，但模块装在 release 的 .tgz 资产上，tag 本身没有包。
    const tags = await peekTags(repo, fetchImpl, timeoutMs)
    if (tags.length) {
      throw new Error(
        `这个库有 tag 但没有发行版（release）：${repoUrl}\n` +
          `找到 tag：${tags.slice(0, 5).join(' / ')}\n` +
          '模块装的是发行版里的 .tgz 附件，光有 tag 不够——去建一个 release，把 tgz 作为附件传上去；\n' +
          '或者直接填那个 .tgz 的直链。',
      )
    }
    throw new Error(
      `这个库还没有发行版：${repoUrl}\n` +
        '去库里建一个发行版（Release），把 scripts/pack.mjs 打出来的 .tgz 作为附件传上去，再回来装；\n' +
        '或者直接填那个 .tgz 的直链。',
    )
  }

  const entry = repo.tag ? list.find((r) => String(r.tag_name) === repo.tag) ?? null : latestRelease(list)
  if (!entry) {
    throw new Error(`发行版里找不到 tag「${repo.tag}」：${repoUrl}/releases`)
  }

  const asset = pickTgzAsset(entry.assets)
  if (!asset) {
    throw new Error(
      `发行版 ${entry.tag_name ?? ''} 里没有 .tgz 附件。\n` +
        '源码 zip/tar.gz 不能装（协议 §2.1 装的是发行包）。把 pack.mjs 打出来的 tgz 传上去再试。',
    )
  }

  return {
    tgzUrl: asset.url,
    repo: repoUrl,
    ref: String(entry.tag_name ?? '') || null,
    source: repo.host === 'gitee.com' ? 'gitee' : 'github',
    assetName: asset.name,
  }
}

/**
 * 比较两个版本号（只比较数字部分，忽略预发布后缀的排序差异）。
 * @returns {number} a>b 返回 1，a<b 返回 -1，相等 0；无法解析时返回 0（保守：不提示更新）
 */
export function compareVersions(a, b) {
  const pa = parseSemverLoose(a)
  const pb = parseSemverLoose(b)
  if (!pa || !pb) return 0
  for (const k of ['major', 'minor', 'patch']) {
    if (pa[k] > pb[k]) return 1
    if (pa[k] < pb[k]) return -1
  }
  return 0
}

function parseSemverLoose(v) {
  const m = /^v?(\d+)\.(\d+)(?:\.(\d+))?/i.exec(String(v ?? '').trim())
  if (!m) return null
  return { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3] ?? 0) }
}

/**
 * 检查某个库有没有比当前更新的发行版。
 *
 * 只在**模块是从库里装的**（注册表记了 repo）时才有意义；本地 tgz 装的没有 repo，
 * 调用方应该直接告诉用户"这个模块不是从库装的，没法查更新"。
 *
 * 注意：这里**不下载**，只查元数据——查更新是个高频动作，不该每次都拉一个包。
 *
 * @returns {Promise<{repo:string, current:string, latest:string|null, hasUpdate:boolean, tag:string|null, assetName:string|null, tgzUrl:string|null}>}
 */
export async function checkUpdate(repoUrl, currentVersion, { fetchImpl = globalThis.fetch, timeoutMs = 15_000 } = {}) {
  const repo = parseRepoUrl(repoUrl)
  if (!repo) throw new Error(`不是能查更新的库地址：${repoUrl}`)

  const api =
    repo.host === 'github.com'
      ? `https://api.github.com/repos/${repo.owner}/${repo.repo}/releases`
      : `https://gitee.com/api/v5/repos/${repo.owner}/${repo.repo}/releases?per_page=100`

  let list = []
  try {
    const res = await fetchImpl(api, {
      headers: _apiHeaders(repo.host),
      signal: AbortSignal.timeout ? AbortSignal.timeout(timeoutMs) : undefined,
    })
    if (res.status === 404) throw Object.assign(new Error(`找不到这个库（HTTP 404）：${repoUrl}`), { code: 'E_NO_REPO' })
    if (!res.ok) throw new Error(`${repo.host} 返回 HTTP ${res.status}`)
    const json = await res.json()
    list = Array.isArray(json) ? json : []
  } catch (error) {
    if (error?.code) throw error
    throw new Error(`查更新失败：${error?.message ?? error}`)
  }

  if (!list.length) {
    return { repo: repoUrl, current: currentVersion, latest: null, hasUpdate: false, tag: null, assetName: null, tgzUrl: null }
  }

  const entry = latestRelease(list)
  const tag = String(entry?.tag_name ?? '') || null
  const asset = pickTgzAsset(entry?.assets)
  // 版本号优先看 tag（`v0.1.1`），资产名兜底（`bili-0.1.1.tgz`）
  const latest = tag ?? (asset?.name ?? '').replace(/^.*?(\d+\.\d+(?:\.\d+)?).*$/, '$1')
  const hasUpdate = compareVersions(latest, currentVersion) > 0

  return {
    repo: repoUrl,
    current: String(currentVersion ?? ''),
    latest,
    hasUpdate,
    tag,
    assetName: asset?.name ?? null,
    tgzUrl: asset?.url ?? null,
  }
}

// 平台请求头（两个平台要求不同，抽成一个小函数避免重复字面量）
function _apiHeaders(host) {
  return host === 'github.com'
    ? { 'user-agent': 'yuanling-module-installer', accept: 'application/vnd.github+json' }
    : { 'user-agent': 'yuanling-module-installer', accept: 'application/json' }
}

/**
 * 看这个库有没有 tag（只在"没有发行版"的失败路径上问一次）。
 * 目的不是拿 tag 来装——tag 里没有打好的 tgz——而是把错误说准：
 * "推了 tag 却没建 release"和"什么都没发"是两种不同的坑。
 */
async function peekTags(repo, fetchImpl, timeoutMs) {
  if (typeof fetchImpl !== 'function') return []
  const api =
    repo.host === 'github.com'
      ? `https://api.github.com/repos/${repo.owner}/${repo.repo}/tags`
      : `https://gitee.com/api/v5/repos/${repo.owner}/${repo.repo}/tags?per_page=20`
  try {
    const res = await fetchImpl(api, {
      headers: _apiHeaders(repo.host),
      signal: AbortSignal.timeout ? AbortSignal.timeout(timeoutMs) : undefined,
    })
    if (!res.ok) return []
    const json = await res.json()
    return (Array.isArray(json) ? json : []).map((t) => String(t?.name ?? '')).filter(Boolean)
  } catch {
    // 探测失败不该盖住原本的错误信息
    return []
  }
}

/**
 * 解析 + 下载。CLI 与管理台共用这一条，避免两边对"库网址"的理解走偏。
 * @returns {Promise<{bytes:Buffer, resolved:object}>}
 */
export async function fetchModuleBytes(raw, { fetchImpl = globalThis.fetch, timeoutMs = 20_000 } = {}) {
  const resolved = await resolveInstallUrl(raw, { fetchImpl, timeoutMs })
  const bytes = await download(resolved.tgzUrl, { fetchImpl, timeoutMs: Math.max(timeoutMs, 60_000) })
  return { bytes, resolved }
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

    // **配置必须跟着人走，不能跟着包走。**
    // config.json 是核心保管的用户资产（cookie / ws 地址 / 规则），不在发行包里；
    // 目录整体替换会把它一起删掉——用户填完 cookie 再更新一次就白填了（这条真踩过）。
    try {
      const oldCfg = path.join(backup, 'config.json')
      const newCfg = path.join(destDir, 'config.json')
      if (fs.existsSync(oldCfg) && !fs.existsSync(newCfg)) {
        fs.copyFileSync(oldCfg, newCfg)
      }
    } catch {
      /* 配置搬不过去不该让安装失败：模块照样能用，只是要人重填 */
    }

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
    // 新装 = 空授权（§2.1：装完把声明的能力列一次，让人一次性确认）。
    // 更新则保留既有授予（下面按新 manifest 取交集），不会偷偷扩权，也不会偷偷降权。
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
