// src/core/doctor.js —— 体检。每一项都"真去取一次"，不许读配置下结论。
// skip 必须带 reason：静默跳过 = 那一格永远绿，是最坏的一种绿。
import fs from 'node:fs'
import path from 'node:path'
import { exists, isDir, localIso } from './fsx.js'
import { P, personaPaths } from './paths.js'
import { validateRoot } from './paths.js'
import { checkFormat } from './manifest.js'
import { readMarker } from './persona.js'

const TOKEN_RE = /^[0-9a-f]{64}$/

function check(id, fn) {
  const t0 = Date.now()
  try {
    const r = fn() ?? {}
    return { id, status: r.status ?? 'pass', elapsed_ms: Date.now() - t0, ...(r.detail ? { detail: r.detail } : {}), ...(r.reason ? { reason: r.reason } : {}) }
  } catch (err) {
    return { id, status: 'fail', elapsed_ms: Date.now() - t0, detail: { error: String(err?.message ?? err) } }
  }
}

/**
 * @param {string} root
 * @param {{ fast?: boolean, appDir?: string }} opts
 * @returns {{ok:boolean, ts:string, elapsed_ms:number, root:string, checks:Array, summary:object}}
 */
export function doctor(root, { fast = false, appDir } = {}) {
  const t0 = Date.now()
  const checks = []

  checks.push(
    check('root', () => {
      const v = validateRoot(root, { appDir })
      if (!v.ok) return { status: 'fail', detail: { errors: v.errors } }
      if (v.warnings.length) return { status: 'warn', detail: { warnings: v.warnings } }
      return { status: 'pass', detail: { source_note: 'root 可写且非网络路径' } }
    }),
  )

  checks.push(
    check('format', () => {
      const f = checkFormat(root)
      if (!f.ok) return { status: 'fail', detail: { errors: f.errors } }
      return { status: 'pass', detail: { format: f.marker.format, schema_version: f.manifest.schema_version } }
    }),
  )

  checks.push(
    check('marker', () => {
      const m = readMarker(root)
      if (!m) return { status: 'fail', detail: { error: 'yuanling.json 缺失或结构不对' } }
      if (!m.personas?.length) return { status: 'fail', detail: { error: '注册表里没有任何人格' } }
      if (!m.personas.some((p) => p.id === m.active)) {
        return { status: 'fail', detail: { error: `active=${m.active} 不在注册表里` } }
      }
      return { status: 'pass', detail: { active: m.active, personas: m.personas.map((p) => p.id) } }
    }),
  )

  checks.push(
    check('persona_dirs', () => {
      const m = readMarker(root)
      if (!m) return { status: 'skip', reason: 'no-marker' }
      const missing = m.personas.filter((p) => !isDir(path.join(root, P.personas, p.id))).map((p) => p.id)
      if (missing.length) return { status: 'fail', detail: { missing } }
      const active = personaPaths(m.active)
      // 只查"真的有一份底稿必须存在"的那几个。`user.md` 已废弃（2026-11-09），
      // `core.json` 目前没人读——把它们列进必检项，等于保证全新数据目录体检不过。
      const required = [active.self, active.lines, active.core]
      const absent = required.filter((rel) => !exists(path.join(root, rel)))
      if (absent.length) return { status: 'fail', detail: { missing_files: absent } }
      return { status: 'pass', detail: { checked: required.length } }
    }),
  )

  checks.push(
    check('token', () => {
      const p = path.join(root, P.consoleToken)
      if (!exists(p)) return { status: 'fail', detail: { error: `${P.consoleToken} 不存在` } }
      const token = fs.readFileSync(p, 'utf8').trim()
      if (!TOKEN_RE.test(token)) return { status: 'fail', detail: { error: '令牌格式不对（应为 64 位 hex）' } }
      let mode = null
      try {
        mode = fs.statSync(p).mode & 0o777
      } catch {
        /* ignore */
      }
      if (mode !== null && (mode & 0o077) !== 0) {
        return { status: 'warn', detail: { mode: mode.toString(8), note: '令牌文件权限过宽' } }
      }
      return { status: 'pass', detail: { mode: mode === null ? 'unknown' : mode.toString(8) } }
    }),
  )

  checks.push(
    check('raw_layout', () => {
      const rawDir = path.join(root, P.raw)
      if (!isDir(rawDir)) return { status: 'fail', detail: { error: 'raw/ 不存在' } }
      const months = fs.readdirSync(rawDir).filter((n) => /^\d{4}-\d{2}$/.test(n))
      if (!months.length) return { status: 'pass', detail: { months: 0, note: '还没有任何原始记录' } }
      return { status: 'pass', detail: { months } }
    }),
  )

  checks.push(
    check('fs_type', () => ({
      status: 'skip',
      reason: 'fs-type-check-not-implemented',
      detail: { note: 'exFAT/FAT32 无只读属性与权限位，封存会降级为只靠 hash 链' },
    })),
  )

  if (!fast) {
    checks.push(
      check('token_file_size', () => {
        const st = fs.statSync(path.join(root, P.consoleToken))
        return st.size >= 64 ? { status: 'pass', detail: { bytes: st.size } } : { status: 'warn', detail: { bytes: st.size } }
      }),
    )
  }

  const summary = { pass: 0, warn: 0, fail: 0, skip: 0 }
  for (const c of checks) summary[c.status] = (summary[c.status] ?? 0) + 1
  return {
    ok: summary.fail === 0,
    ts: localIso(),
    elapsed_ms: Date.now() - t0,
    root,
    checks,
    summary,
  }
}

/** 退出码：0 ok；4 完整性失败。 */
export function doctorExitCode(result) {
  return result.ok ? 0 : 4
}
