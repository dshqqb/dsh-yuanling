// src/core/manifest.js —— system/manifest.json 的读写与格式对齐检查。
import path from 'node:path'
import { readJson } from './fsx.js'
import { P } from './paths.js'
import { SCHEMA_VERSION } from './templates.js'

export function manifestPath(root) {
  return path.join(root, P.manifest)
}

export function readManifest(root) {
  return readJson(manifestPath(root), null)
}

/**
 * 校验 format 一致性：yuanling.json 与 system/manifest.json 必须相等。
 * 不等的常见原因：拷了半个目录、手改了其中一个、或者插件降级运行过。
 * 这种情况必须拒绝启动（退出码 4），否则会在两套结构上继续写。
 */
export function checkFormat(root) {
  const marker = readJson(path.join(root, P.marker), null)
  const manifest = readManifest(root)
  const errors = []
  if (!marker) errors.push({ code: 'NO_MARKER', message: `${P.marker} 缺失或损坏` })
  if (!manifest) errors.push({ code: 'NO_MANIFEST', message: `${P.manifest} 缺失或损坏` })
  if (!marker || !manifest) return { ok: false, errors }
  if (marker.format !== manifest.format) {
    errors.push({
      code: 'FORMAT_MISMATCH',
      message: `format 不一致：yuanling.json=${marker.format}，manifest.json=${manifest.format}`,
    })
  }
  if (manifest.schema_version > SCHEMA_VERSION) {
    errors.push({
      code: 'SCHEMA_TOO_NEW',
      message: `数据结构版本 ${manifest.schema_version} 高于本插件支持的 ${SCHEMA_VERSION}`,
    })
  }
  return { ok: errors.length === 0, errors, marker, manifest }
}
