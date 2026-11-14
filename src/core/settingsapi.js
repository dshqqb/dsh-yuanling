// src/core/settingsapi.js —— 设置页的服务端半边：读配置、写配置、同步 MCP。
//
// 为什么设置页的东西要走这里而不是让客户端直接改：客户端在浏览器里，拿不到
// 宿主的 settings 服务。所以浏览器只跟同源 API 说话，由服务端调 settings.update。
import fs from 'node:fs'
import path from 'node:path'

import { P } from './paths.js'

// 设置页用的命名空间与同源路由（客户端也从这里抄同样的字符串）
export const NS = 'dsh-yuanling'
export const API_PREFIX = '/dsh-yuanling/api'

/** 控制台令牌文件的位置。 */
export function consoleTokenPath(root) {
  return path.join(root, P.consoleToken)
}

/** 读令牌（服务端专用；只接受本机回环请求的那条路由才会调它）。 */
export function readConsoleToken(root) {
  try {
    const t = fs.readFileSync(consoleTokenPath(root), 'utf8').trim()
    return t || null
  } catch {
    return null
  }
}

/**
 * 把宿主递进来的配置值解包成字符串。
 *
 * 真机踩到：设置页写过 `dataDir` 之后，插件拿到的 `config.dataDir` 不是字符串，
 * 而是一个对象（`String(x)` → "[object Object]"）。于是数据目录回落默认位置、
 * 控制台令牌也换了一份 → 用户永远看到"令牌不匹配"。
 * 不同宿主版本的包法可能不同，按常见形状逐个试；都不中就当空。
 */
export function unwrapConfigValue(v) {
  if (typeof v === 'string') return v
  if (typeof v === 'number' || typeof v === 'boolean') return String(v)
  if (v && typeof v === 'object') {
    // ① 惰性访问器：宿主把"被设置页改过"的字段换成了 { get: fn }（JSON 看是 {}）
    if (typeof v.get === 'function') {
      try {
        const inner = v.get()
        if (typeof inner === 'string') return inner
        if (inner !== undefined && inner !== null && typeof inner !== 'object') return String(inner)
      } catch {
        /* 取不到就继续试别的形状 */
      }
    }
    // ② 常见的包装字段
    for (const key of ['value', 'default', '$value', 'current']) {
      const inner = v[key]
      if (typeof inner === 'string') return inner
    }
  }
  return ''
}

/** 诊断用：这个值到底是什么形状（写进 /root 的 meta）。 */
export function describeConfigValue(v) {
  const type = Array.isArray(v) ? 'array' : typeof v
  const keys = v && typeof v === 'object' && !Array.isArray(v) ? Object.keys(v).slice(0, 8) : null
  let json = ''
  try {
    json = JSON.stringify(v)
  } catch {
    json = '(不可序列化)'
  }
  return { type, keys, json: String(json ?? '').slice(0, 200) }
}

/**
 * 原生「选择目录」的 PowerShell 脚本。
 * 浏览器拿不到绝对路径，只能由宿主的进程弹 Windows 对话框（surfcore 也是这么做的）。
 */
export function folderPickerScript(title = '选择数据目录') {
  return `Add-Type -AssemblyName System.Windows.Forms;
$d = New-Object System.Windows.Forms.FolderBrowserDialog;
$d.Description = ${JSON.stringify(String(title))};
$d.ShowNewFolderButton = $true;
if ($d.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) { Write-Output $d.SelectedPath }`
}

/** 从 PowerShell 的输出里取最后一行（对话框的路径）。 */
export function pickPathFromStdout(stdout) {
  const lines = String(stdout ?? '')
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter(Boolean)
  return lines.length ? lines[lines.length - 1] : ''
}

/**
 * 兼容旧 id：早期版本把插件 id 写成 `yuanling`，有人在 profile 里可能还留着。
 * 读的时候两个都试，写的时候用实际命中的那个 ns——不然 settings.update 会写丢。
 */
export const NS_CANDIDATES = ['dsh-yuanling', 'yuanling']

/** 从 settings.describe() 返回的行里取出本插件的配置。 */
export function pickRow(rows, ns = null) {
  const list = Array.isArray(rows) ? rows : []
  const names = ns ? [ns] : NS_CANDIDATES
  for (const name of names) {
    const hit = list.find((r) => r?.ns === name)
    if (hit) return hit
  }
  return null
}

/**
 * 只接受这几个字段。**故意的**：
 *   · consoleHost / consolePort 现在是只读的（改 IP 属于危险操作，留到以后）；
 *   · consoleEnabled 不再单独存在——总开关开，管理台就起。
 */
export function normalizePatch(body = {}) {
  const patch = {}
  if (body.enabled !== undefined) patch.enabled = Boolean(body.enabled)
  if (body.dataDir !== undefined) patch.dataDir = String(body.dataDir ?? '').trim()
  if (body.consoleEnabled !== undefined) patch.consoleEnabled = Boolean(body.consoleEnabled)
  if (body.consoleHost !== undefined) patch.consoleHost = String(body.consoleHost ?? '').trim()
  if (body.consolePort !== undefined) patch.consolePort = Number(body.consolePort)
  if (body.allowRemote !== undefined) patch.allowRemote = Boolean(body.allowRemote)
  return patch
}

class SettingsError extends Error {
  constructor(message, status = 400) {
    super(message)
    this.name = 'SettingsError'
    this.status = status
  }
}

export { SettingsError }

/**
 * 应用补丁。
 * @param {object} opts
 * @param {object} opts.settings   宿主的 settings 服务（需要 update）
 * @param {object} opts.body       请求体
 * @param {object} opts.current    当前配置（用来判断数据目录是否真的变了）
 * @param {function} [opts.validate] 校验数据目录（返回 {ok, errors}）
 * @param {function} [opts.syncMcp] 改目录后同步 MCP 的 --root
 */
export async function applyPatch({ settings, body, current = {}, ns = NS, validate, syncMcp } = {}) {
  const patch = normalizePatch(body)
  if (!Object.keys(patch).length) throw new SettingsError('没有可应用的改动')
  if (typeof settings?.update !== 'function') throw new SettingsError('宿主没有 settings.update，无法保存', 501)

  // 数据目录先校验再写：写进去一个不存在的目录，下次启动插件会直接拒绝启动
  if (patch.dataDir) {
    if (typeof validate === 'function') {
      const r = validate(patch.dataDir)
      if (r && r.ok === false) {
        const first = r.errors?.[0]
        throw new SettingsError(`数据目录不可用：${first ? `${first.code} ${first.message}` : patch.dataDir}`)
      }
    }
  }

  if (patch.consolePort !== undefined) {
    if (!Number.isFinite(patch.consolePort) || patch.consolePort < 0 || patch.consolePort > 65535) {
      throw new SettingsError('管理台端口必须在 0~65535 之间')
    }
  }
  if (patch.consoleHost !== undefined) {
    const host = String(patch.consoleHost)
    const loopback = host === '127.0.0.1' || host === 'localhost' || host === '::1'
    const allow = patch.allowRemote !== undefined ? patch.allowRemote : current.allowRemote === true
    if (!host) throw new SettingsError('管理台监听地址不能为空')
    if (!loopback && !allow) {
      throw new SettingsError('监听 127.0.0.1 之外的地址前，必须先勾选「允许同一局域网内的其他设备访问」')
    }
  }
  if (patch.allowRemote === false) {
    const host = String(patch.consoleHost ?? current.consoleHost ?? '127.0.0.1')
    const loopback = host === '127.0.0.1' || host === 'localhost' || host === '::1'
    if (!loopback) throw new SettingsError('取消局域网访问前，先把监听地址改回 127.0.0.1')
  }

  const before = String(current.dataDir ?? '').trim()
  const changedDir = patch.dataDir !== undefined && patch.dataDir !== before

  await settings.update(ns, patch)

  let mcp = null
  if (changedDir && typeof syncMcp === 'function') mcp = syncMcp(patch.dataDir)

  return {
    patch,
    changedDir,
    mcp,
    // 改目录/管理台监听参数都必须重启：插件下次启动才会去读新配置
    restartRequired: changedDir || patch.consoleHost !== undefined || patch.consolePort !== undefined || patch.allowRemote !== undefined || patch.consoleEnabled !== undefined,
  }
}
