// src/core/scaffold.js —— 建数据目录骨架。只补缺失，绝不覆盖。
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { ensureDir, exists, writeFileAtomic, writeJsonAtomic, ulid, localIso } from './fsx.js'
import { P, personaPaths } from './paths.js'
import * as T from './templates.js'

export const PERSONA_ID_RE = /^[a-z0-9][a-z0-9_-]{1,31}$/

/** 目录清单（相对 root）。 */
export function dirList(personaId) {
  const pp = personaPaths(personaId)
  return [
    P.raw,
    P.rawArchive,
    P.media,
    P.personas,
    pp.base,
    pp.persona,
    pp.self.replace(/\/SELF\.md$/, ''),
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
    P.system,
    P.inbox,
    P.health,
    P.candidates,
    P.index,
    P.versions,
    P.versionsBlobs,
    P.backups,
    P.imports,
    P.secrets,
    P.trash,
    'system/log',
    'rules',
    P.web,
  ]
}

/** 文件清单（相对 root → 内容）。 */
export function fileList({ personaId, name, now }) {
  const pp = personaPaths(personaId)
  return [
    [P.marker, () => JSON.stringify(T.markerJson({ active: personaId, now, rootId: ulid() }), null, 2) + '\n'],
    [P.guardrails, () => JSON.stringify(T.guardrailsJson(), null, 2) + '\n'],
    [P.ingestRules, () => JSON.stringify(T.ingestJson(), null, 2) + '\n'],
    [P.firstDoc, () => T.firstDoc()],
    ['.gitignore', () => T.dataGitignore()],
    ['README.md', () => T.dataReadme()],
    [P.manifest, () => JSON.stringify(manifestStub(now), null, 2) + '\n'],
    [P.identities, () => JSON.stringify({ _comment: '账号 → person_uid 的客观映射。敏感：禁明文导出，不进任何注入。', version: 1, people: {}, pending: [] }, null, 2) + '\n'],
    [P.shields, () => JSON.stringify({ _comment: '墓碑登记。全局生效，可撤销。', version: 1, redactions: [] }, null, 2) + '\n'],
    [pp.manifest, () => JSON.stringify(T.personaJson({ id: personaId, name, now }), null, 2) + '\n'],
    [pp.self, () => T.selfMd(name)],
    [pp.lines, () => T.linesMd()],
    [pp.user, () => T.userMd()],
    [pp.core, () => JSON.stringify(T.coreJson(), null, 2) + '\n'],
    [pp.style, () => T.styleMd()],
    [pp.globalRule, () => JSON.stringify(T.globalRuleJson(), null, 2) + '\n'],
    [pp.interests, () => JSON.stringify({ _comment: '兴趣：四层信号 + 强度。单次被动暴露永不确认。', version: 1, items: [] }, null, 2) + '\n'],
    [pp.purposes, () => JSON.stringify({ _comment: '目的账本。每条必须能关（close），否则只增不减。', version: 1, items: [] }, null, 2) + '\n'],
    [pp.weights, () => JSON.stringify({ _comment: '人工覆写的重要度与 pin。', version: 1, entries: {} }, null, 2) + '\n'],
    [pp.sessions, () => JSON.stringify({ _comment: '会话断点：上次聊到哪。', version: 1, sessions: {} }, null, 2) + '\n'],
    [pp.cursor, () => JSON.stringify({ _comment: '本人物消费候选池的游标。', version: 1, extract: {}, promote: {} }, null, 2) + '\n'],
  ]
}

function manifestStub(now) {
  return {
    schema_version: T.SCHEMA_VERSION,
    format: T.FORMAT,
    created_at: now,
    updated_at: now,
    migrations: [],
    health: { last_check: null, last_ok: null },
  }
}

/** 生成控制台令牌（32 字节 hex）。已存在则不覆盖。 */
export function ensureToken(root) {
  const p = path.join(root, P.consoleToken)
  if (exists(p)) return { created: false, path: p }
  const token = crypto.randomBytes(32).toString('hex')
  writeFileAtomic(p, token + '\n', { mode: 0o600 })
  try {
    fs.chmodSync(p, 0o600)
  } catch {
    // Windows 上 chmod 语义有限，失败不影响使用
  }
  return { created: true, path: p }
}

/**
 * 建骨架。只在缺失时创建，绝不覆盖已有文件。
 * @returns {{root:string, created:string[], skipped:string[], warnings:string[]}}
 */
export function scaffold(root, { personaId = 'yuanling', name = '原灵', now = localIso() } = {}) {
  if (!PERSONA_ID_RE.test(personaId)) {
    throw new Error(`人格 id 非法：${personaId}（要求 ${PERSONA_ID_RE}）`)
  }

  const created = []
  const skipped = []
  const warnings = []

  for (const rel of dirList(personaId)) {
    const abs = path.join(root, rel)
    if (exists(abs)) continue
    ensureDir(abs)
    created.push(rel + '/')
  }

  for (const [rel, make] of fileList({ personaId, name, now })) {
    const abs = path.join(root, rel)
    if (exists(abs)) {
      skipped.push(rel)
      continue
    }
    const content = make()
    if (rel.endsWith('.json')) {
      // 已经是格式化好的字符串，直接原子写
      writeFileAtomic(abs, content)
    } else {
      writeFileAtomic(abs, content)
    }
    created.push(rel)
  }

  const token = ensureToken(root)
  if (token.created) created.push(P.consoleToken)
  else skipped.push(P.consoleToken)

  // 兜底：manifest 与 marker 的 format 必须一致，否则后面会拒绝启动
  const marker = JSON.parse(fs.readFileSync(path.join(root, P.marker), 'utf8'))
  if (marker.format !== T.FORMAT) {
    warnings.push(`yuanling.json 的 format=${marker.format} 与模板 ${T.FORMAT} 不一致`)
  }

  return { root, created, skipped, warnings }
}
