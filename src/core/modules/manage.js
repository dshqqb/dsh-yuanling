// src/core/modules/manage.js —— 管理台用的模块视图（只读 + 可直接落盘的写操作）。
//
// 和 service.js 的区别：service 持有**运行中的进程**，是插件启动时用的；
// manage 不持进程，只读写注册表与文件，供 HTTP 层每次请求临时使用。
//
// 为什么分开：管理台可能被 CLI 单独起（`yuanling serve`），那里没有插件进程，
// 但页面照样要能列模块、授予能力、导出 tgz。共用一份"只碰文件"的逻辑最省事。
import fs from 'node:fs'
import path from 'node:path'

import { readJson, ensureDir, exists, writeJsonAtomic } from '../fsx.js'
import { P } from '../paths.js'
import { readRegistry, writeRegistry, setGranted, setGrantedAll, grantedOf, moduleDir } from './registry.js'
import { sha256Of } from './installer.js'
import { describeFields } from './configschema.js'
import { untar, stripPackagePrefix } from './untar.js'

export function moduleLogPath(root, id) {
  return path.join(root, P.modulesLog, `${id}.log`)
}

export function tailModuleLog(root, id, { lines = 60 } = {}) {
  const p = moduleLogPath(root, id)
  if (!exists(p)) return []
  const all = fs.readFileSync(p, 'utf8').split('\n').filter(Boolean)
  return all.slice(-Math.max(1, Math.min(200, lines)))
}

export function readModuleConfig(root, id) {
  return readJson(path.join(moduleDir(root, id), 'config.json'), {}) ?? {}
}

/**
 * 写模块配置。**写之前必须过 schema 校验**（见 configschema.js）——
 * 模块自己不读文件，只靠 init 时核心发给它的这份，所以坏值会一路带到模块里。
 */
export function writeModuleConfig(root, id, value) {
  const p = path.join(moduleDir(root, id), 'config.json')
  writeJsonAtomic(p, value ?? {})
  return value ?? {}
}

/** 模块声明的 config.schema（没有就返回 null）。 */
export function readConfigSchema(root, id) {
  const manifest = readJson(path.join(moduleDir(root, id), 'yuanling.module.json'), null)
  return manifest?.config?.schema ?? null
}

/** 页面列表：注册表 + manifest 里的展示字段 + 运行时状态（读注册表里的快照）。 */
export function listModules(root) {
  const reg = readRegistry(root)
  return Object.keys(reg.modules)
    .sort()
    .map((id) => {
      const e = reg.modules[id]
      const manifest = readJson(path.join(moduleDir(root, id), 'yuanling.module.json'), null)
      return {
        id,
        name: manifest?.name ?? id,
        description: manifest?.description ?? '',
        version: e.version,
        api: e.api,
        app: e.app ?? manifest?.app ?? null,
        kind: e.kind,
        source: e.source ?? null,
        repo: e.repo ?? null,
        previousRepo: e.previousRepo ?? null,
        installedAt: e.installed_at ?? null,
        enabled: e.enabled !== false,
        state: e.state ?? 'stopped',
        lastCrash: e.last_crash ?? null,
        capabilities: e.capabilities ?? [],
        granted: grantedOf(e),
        routes: e.routes ?? [],
        sources: e.sources ?? [],
        // 有配置 schema 才能在页面上渲染表单
        hasConfig: Boolean(manifest?.config?.schema),
      }
    })
}

export function moduleSummary(root) {
  const list = listModules(root)
  return {
    total: list.length,
    running: list.filter((m) => m.state === 'running' || m.state === 'ready').length,
    crashed: list.filter((m) => m.state === 'crashed').length,
    disabled: list.filter((m) => !m.enabled).length,
  }
}

export function moduleDetail(root, id) {
  const list = listModules(root)
  const m = list.find((x) => x.id === id)
  if (!m) return null
  const reg = readRegistry(root)
  const manifest = readJson(path.join(moduleDir(root, id), 'yuanling.module.json'), null)
  const schema = manifest?.config?.schema ?? null
  return {
    ...m,
    permissions: reg.modules[id].permissions ?? [],
    config: readModuleConfig(root, id),
    configSchema: schema,
    // 页面直接照着渲染：字段名、类型、是否必填、要不要当密码框，都在这里定好，
    // 别让前端再猜一遍 schema 结构（两边各解释一次迟早不一致）
    configFields: describeFields(schema),
    // v1.2：模块声明的自定义 tab（页面从第三个位置往后排）
    uiTabs: manifest?.ui?.tabs ?? [],
    log: tailModuleLog(root, id),
  }
}

/** 授予/收回能力。 */
export function setModuleGranted(root, id, capability, granted) {
  const reg = readRegistry(root)
  const entry = reg.modules[id]
  if (!entry) throw new Error(`没有这个模块：${id}`)
  const next = setGranted(entry, capability, granted)
  reg.modules[id] = next
  writeRegistry(root, reg)
  return { id, granted: grantedOf(next) }
}

/** 一次性授予全部声明能力 / 全收回（安装确认页用）。 */
export function setModuleGrantedAll(root, id, granted) {
  const reg = readRegistry(root)
  const entry = reg.modules[id]
  if (!entry) throw new Error(`没有这个模块：${id}`)
  const next = setGrantedAll(entry, granted)
  reg.modules[id] = next
  writeRegistry(root, reg)
  return { id, granted: grantedOf(next) }
}

/** 持久停用/启用（能力：enabled 写注册表，重启也不起）。 */
export function setModuleEnabled(root, id, enabled) {
  const reg = readRegistry(root)
  const entry = reg.modules[id]
  if (!entry) throw new Error(`没有这个模块：${id}`)
  reg.modules[id] = { ...entry, enabled: Boolean(enabled) }
  writeRegistry(root, reg)
  return { id, enabled: Boolean(enabled) }
}

/**
 * 导出 tgz 到 system/exports/<id>-<version>.tgz。
 *
 * 为什么要"整体导出"：换机器/备份模块时，拷一个文件比拷一棵目录树可靠，
 * 而且导出包能被 installFromBytes 直接装回来（测试已钉住这条往返）。
 */
export function exportModule(root, id) {
  const reg = readRegistry(root)
  const entry = reg.modules[id]
  if (!entry) throw new Error(`没有这个模块：${id}`)

  const src = moduleDir(root, id)
  if (!exists(src)) throw new Error(`模块目录不存在：${src}`)

  const outDir = path.join(root, P.exports)
  ensureDir(outDir)
  const dest = path.join(outDir, `${id}-${entry.version}.tgz`)

  const bytes = packDirToTgz(src)
  fs.writeFileSync(dest, bytes)
  return { path: dest, bytes: bytes.length, sha256: sha256Of(bytes) }
}

// ── tar 打包（导出用）──────────────────────────────────────────────────

function packDirToTgz(dir) {
  const zlib = requireZlib()
  const blocks = []
  const walk = (cur, relBase) => {
    for (const name of fs.readdirSync(cur).sort()) {
      const full = path.join(cur, name)
      const rel = relBase ? `${relBase}/${name}` : name
      const st = fs.statSync(full)
      if (st.isDirectory()) {
        blocks.push(tarHeader(rel, 0))
        walk(full, rel)
      } else if (st.isFile()) {
        const data = fs.readFileSync(full)
        blocks.push(tarHeader(rel, data.length), data)
        const pad = (512 - (data.length % 512)) % 512
        if (pad) blocks.push(Buffer.alloc(pad))
      }
    }
  }
  walk(dir, '')
  blocks.push(Buffer.alloc(1024))
  return zlib.gzipSync(Buffer.concat(blocks))
}

/**
 * 512 字节 tar 头。
 * ⚠️ 两个字段的宽度必须精确：size 是八进制（偏移 124，11 字节含 NUL），
 *    checksum 是 8 字节（偏移 148）。写宽 1 字节就会覆盖偏移 156 的 typeflag，
 *    解包时报"特殊成员（type 空格）"——导出功能就废了（真踩过）。
 */
function tarHeader(name, size) {
  const h = Buffer.alloc(512)
  h.write(String(name).slice(0, 100), 0, 'utf8')
  h.write('0000644\u0000', 100, 8)
  h.write('0000000\u0000', 108, 8)
  h.write('0000000\u0000', 116, 8)
  h.write(`${size.toString(8).padStart(10, '0')}\u0000`, 124, 11)
  h.write('00000000000\u0000', 136, 12)
  h.write('0', 156, 1)
  h.write('ustar\u0000', 257, 6)
  h.write('00', 263, 2)

  h.fill(0, 148, 156)
  let sum = 0
  for (let i = 0; i < 512; i += 1) sum += h[i]
  h.write(`${sum.toString(8).padStart(7, '0')}\u0000 `, 148, 8)
  return h
}

/** 同步取 zlib（本文件只在服务端跑，不存在打包进浏览器的问题）。 */
function requireZlib() {
  // 用 require 而不是顶层 import，避免测试里 mock 不了
  return zlibRef
}

import zlib from 'node:zlib'
const zlibRef = zlib

/** 供测试：解开导出的包。 */
export { untar, stripPackagePrefix }
