// src/core/persona.js —— 人格注册表：列、建、切。一次只有一个激活。
import fs from 'node:fs'
import path from 'node:path'
import { exists, readJson, writeJsonAtomic, appendLine, localIso, ulid, isDir } from './fsx.js'
import { P, personaPaths } from './paths.js'
import { PERSONA_ID_RE } from './scaffold.js'
import * as T from './templates.js'
import { snapshotCurrent } from './version.js'

export function markerPath(root) {
  return path.join(root, P.marker)
}

/** 读根标记；没有或坏了返回 null。 */
export function readMarker(root) {
  const m = readJson(markerPath(root), null)
  if (!m || typeof m !== 'object' || !Array.isArray(m.personas)) return null
  return m
}

export function writeMarker(root, marker) {
  marker.updated_at = localIso()
  writeJsonAtomic(markerPath(root), marker)
  return marker
}

/** 记一条语义变更（system/log/changes.ndjson）。 */
export function appendChange(root, entry) {
  appendLine(path.join(root, P.changes), { ts: localIso(), op_id: ulid(), ...entry })
}

/** 列出人格（来自注册表，并校验目录还在）。 */
export function listPersonas(root) {
  const marker = readMarker(root)
  if (!marker) return []
  return marker.personas.map((p) => ({
    ...p,
    active: p.id === marker.active,
    dirExists: isDir(path.join(root, P.personas, p.id)),
  }))
}

/** 当前激活人格。 */
export function activePersona(root) {
  const marker = readMarker(root)
  if (!marker) return null
  return marker.personas.find((p) => p.id === marker.active) ?? null
}

/** 新建人格。from 只复制骨架与规则，不复制记忆。 */
export function createPersona(root, id, name = id, { from = null } = {}) {
  if (!PERSONA_ID_RE.test(id)) {
    throw new Error(`人格 id 非法：${id}（要求 ${PERSONA_ID_RE}）`)
  }
  const marker = readMarker(root)
  if (!marker) throw new Error('根标记 yuanling.json 不存在或损坏，先跑 yuanling init')
  if (marker.personas.some((p) => p.id === id)) throw new Error(`人格「${id}」已存在`)

  const now = localIso()
  const pp = personaPaths(id)
  const dirs = [
    pp.base,
    pp.persona,
    pp.people,
    pp.groups,
    pp.spaces,
    pp.journal,
    pp.rules,
    pp.proposals,
    `${pp.base}/state`,
    pp.versions,
    pp.versionsBlobs,
    pp.snapshots,
  ]
  for (const d of dirs) fs.mkdirSync(path.join(root, d), { recursive: true })

  const template = {
    self: () => T.selfMd(name),
    lines: () => T.linesMd(),
    user: () => T.userMd(),
    style: () => T.styleMd(),
    globalRule: () => JSON.stringify(T.globalRuleJson(), null, 2) + '\n',
  }

  if (from) {
    if (!PERSONA_ID_RE.test(from)) throw new Error(`来源人格 id 非法：${from}`)
    const srcMarker = marker.personas.find((p) => p.id === from)
    if (!srcMarker) throw new Error(`来源人格「${from}」不存在`)
    const src = personaPaths(from)
    const copies = [
      [src.self, pp.self],
      [src.lines, pp.lines],
      [src.user, pp.user],
      [src.style, pp.style],
      [src.globalRule, pp.globalRule],
    ]
    for (const [fromAbs, toAbs] of copies) {
      const srcPath = path.join(root, fromAbs)
      if (exists(srcPath)) {
        fs.copyFileSync(srcPath, path.join(root, toAbs))
      }
    }
  }

  const files = [
    [pp.manifest, JSON.stringify(T.personaJson({ id, name, now }), null, 2) + '\n'],
    [pp.core, JSON.stringify(T.coreJson(), null, 2) + '\n'],
    [pp.interests, JSON.stringify({ _comment: '兴趣：四层信号 + 强度。', version: 1, items: [] }, null, 2) + '\n'],
    [pp.purposes, JSON.stringify({ _comment: '目的账本。每条必须能关。', version: 1, items: [] }, null, 2) + '\n'],
    [pp.weights, JSON.stringify({ _comment: '人工覆写的重要度与 pin。', version: 1, entries: {} }, null, 2) + '\n'],
    [pp.sessions, JSON.stringify({ _comment: '会话断点。', version: 1, sessions: {} }, null, 2) + '\n'],
    [pp.cursor, JSON.stringify({ _comment: '消费候选池的游标。', version: 1, extract: {}, promote: {} }, null, 2) + '\n'],
  ]
  for (const [rel, content] of files) {
    const abs = path.join(root, rel)
    if (exists(abs)) continue
    fs.mkdirSync(path.dirname(abs), { recursive: true })
    fs.writeFileSync(abs, content, 'utf8')
  }

  // 骨架里缺的，用模板补（--from 时只补缺，不覆盖拷来的）
  for (const [rel, make] of Object.entries(template)) {
    const abs = path.join(root, pp[rel])
    if (exists(abs)) continue
    fs.mkdirSync(path.dirname(abs), { recursive: true })
    fs.writeFileSync(abs, make(), 'utf8')
  }

  marker.personas.push({ id, name, created_at: now, from: from ?? null })
  writeMarker(root, marker)
  try {
    snapshotCurrent(root, P.marker, { actor: 'system:persona', reason: `create persona ${id}` })
  } catch {
    /* 版本记录失败不该挡住建人格 */
  }
  appendChange(root, { kind: 'persona_create', id, name, from: from ?? null })
  return { id, name, dir: path.join(root, pp.base) }
}

/** 切换激活人格。串行由调用方保证（P0 没有并发写）。 */
export function switchPersona(root, id) {
  const marker = readMarker(root)
  if (!marker) throw new Error('根标记 yuanling.json 不存在或损坏，先跑 yuanling init')
  const target = marker.personas.find((p) => p.id === id)
  if (!target) throw new Error(`人格「${id}」不存在。现有：${marker.personas.map((p) => p.id).join('、')}`)
  if (!isDir(path.join(root, P.personas, id))) {
    throw new Error(`人格「${id}」在注册表里，但目录不存在：personas/${id}/`)
  }
  const previous = marker.active
  if (previous === id) return { id, changed: false, previous }
  marker.active = id
  writeMarker(root, marker)
  try {
    snapshotCurrent(root, P.marker, { actor: 'system:persona', reason: `switch ${previous} → ${id}` })
  } catch {
    /* 同上 */
  }
  appendChange(root, { kind: 'persona_switch', from: previous, to: id })
  return { id, changed: true, previous }
}
