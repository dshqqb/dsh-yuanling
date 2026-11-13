// src/core/paths.js —— root 四级解析 + fail-closed 校验。
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'

/** 默认 root：<DSH_HOME>/yuanling，没有 DSH_HOME 就用 ~/.dsh/yuanling。 */
export function defaultRoot(env = process.env) {
  const dshHome = String(env.DSH_HOME ?? '').trim() || path.join(os.homedir(), '.dsh')
  return path.join(dshHome, 'yuanling')
}

/**
 * 四级解析，前者覆盖后者：
 *   ① --root  ② YUANLING_HOME  ③ config.dataDir  ④ 默认
 * @returns {{root: string, source: 'cli'|'env'|'config'|'default'}}
 */
export function resolveRoot({ cli, env = process.env, config } = {}) {
  const pick = (v) => (typeof v === 'string' && v.trim() ? v.trim() : null)

  const fromCli = pick(cli)
  if (fromCli) return { root: path.resolve(fromCli), source: 'cli' }

  const fromEnv = pick(env.YUANLING_HOME)
  if (fromEnv) return { root: path.resolve(fromEnv), source: 'env' }

  const fromConfig = pick(config?.dataDir)
  if (fromConfig) return { root: path.resolve(fromConfig), source: 'config' }

  return { root: defaultRoot(env), source: 'default' }
}

const UNC_RE = /^(\\\\|\/\/)/
const SYNC_RE = /(onedrive|dropbox|nutstore|坚果云|googledrive|google drive|icloud)/i
const PROGRAM_FILES_RE = /[\\/]program files( \(x86\))?[\\/]/i
const MAX_PATH_WARN = 180

/**
 * 校验数据目录是否可用。**只报告，不创建。**
 * 目录不存在时绝不自动新建——外置盘没插时自动建一个空目录，会让用户以为记忆全丢了。
 *
 * @returns {{ok:boolean, root:string, errors:Array, warnings:Array, skips:Array}}
 */
export function validateRoot(root, { appDir } = {}) {
  const errors = []
  const warnings = []
  const skips = []
  const abs = path.resolve(root)

  // ① 网络路径：直接拒。rename 在 SMB 上不保证原子，断线会丢写。
  if (UNC_RE.test(root) || UNC_RE.test(abs)) {
    errors.push({
      code: 'UNC_PATH',
      message: '数据目录不能是网络路径（rename 不原子、断线可能丢写）',
    })
    return { ok: false, root: abs, errors, warnings, skips }
  }

  // ② 存在性
  let st = null
  try {
    st = fs.statSync(abs)
  } catch {
    errors.push({
      code: 'ROOT_MISSING',
      message: '数据目录不存在。原灵不会自动创建它——外置盘未挂载时自动新建空目录，会让你以为记忆全丢了。',
    })
    return { ok: false, root: abs, errors, warnings, skips }
  }

  if (!st.isDirectory()) {
    errors.push({ code: 'NOT_A_DIR', message: `数据目录不是一个目录：${abs}` })
    return { ok: false, root: abs, errors, warnings, skips }
  }

  // ③ 可写（真写一次再删，不信权限位）
  const probe = path.join(abs, `.yuanling-probe-${process.pid}`)
  try {
    fs.writeFileSync(probe, 'ok')
    fs.unlinkSync(probe)
  } catch (err) {
    errors.push({
      code: 'NOT_WRITABLE',
      message: `数据目录不可写：${err?.message ?? err}`,
    })
  }

  // ④ 应用安装目录内：升级会覆盖，直接拒
  if (appDir) {
    const rel = path.relative(path.resolve(appDir), abs)
    if (rel && !rel.startsWith('..') && !path.isAbsolute(rel)) {
      errors.push({
        code: 'INSIDE_APP_DIR',
        message: '数据目录不能放在插件安装目录里（升级会覆盖）',
      })
    }
  } else if (PROGRAM_FILES_RE.test(abs)) {
    warnings.push({
      code: 'PROGRAM_FILES',
      message: '数据目录在 Program Files 下，写入大概率被 UAC 拦，建议换到用户可写的位置',
    })
  }

  // ⑤ 路径长度：Windows 260 字符限制，留出 blobs/<64位hash> 的余量
  if (abs.length >= MAX_PATH_WARN) {
    warnings.push({
      code: 'LONG_PATH',
      message: `数据目录路径长度 ${abs.length}，接近 Windows 260 字符限制，建议换短一点的路径`,
    })
  }

  // ⑥ 同步盘：tmp→rename 与同步锁会打架
  if (SYNC_RE.test(abs)) {
    warnings.push({
      code: 'SYNC_DIR',
      message: '数据目录在同步盘（OneDrive/Dropbox/坚果云等）内，批量写入时可能与同步锁冲突',
    })
  }

  // ⑦ 文件系统类型：纯 JS 无法可靠判定，如实标 skip 而不是假装通过
  skips.push({
    id: 'fs_type',
    reason: 'fs-type-check-not-implemented',
    detail: 'exFAT/FAT32 无只读属性与权限位，封存会降级为只靠 hash 链',
  })

  return { ok: errors.length === 0, root: abs, errors, warnings, skips }
}

/** 数据目录内部的标准相对路径。集中在这里，避免各处拼字符串。 */
export const P = {
  marker: 'yuanling.json',
  guardrails: 'guardrails.json',
  ingestRules: 'rules/ingest.json',
  firstDoc: '第一条.md',
  raw: 'raw',
  rawArchive: 'raw-archive',
  media: 'media',
  personas: 'personas',
  web: 'web',
  system: 'system',
  manifest: 'system/manifest.json',
  // 身份登记**按人格**，不在这里：见 scope.js 的 personaFile（personas/<p>/entities/）。
  // 留着这两个常量只会让人以为 system/ 里还有一份，所以删掉。
  shields: 'system/shields.json',
  inbox: 'system/inbox',
  health: 'system/inbox/.health',
  candidates: 'system/candidates',
  index: 'system/index',
  versions: 'system/versions',
  versionsBlobs: 'system/versions/blobs',
  versionsJournal: 'system/versions/journal.ndjson',
  changes: 'system/log/changes.ndjson',
  /** 统一事件流：日志页读它，审计 = 其中带 actor/reason/ref 的写入事件（v1.4）。 */
  events: 'system/log/events.ndjson',
  backups: 'system/backups',
  imports: 'system/imports',
  secrets: 'system/secrets',
  consoleToken: 'system/secrets/console.token',
  /** 控制台运行时的自我描述（url/port/pid），供同机其他进程找它。 */
  consoleRuntime: 'system/console.json',
  policy: 'system/policy.json',
  modules: 'system/modules',
  modulesRegistry: 'system/modules.json',
  modulesLog: 'system/log/modules',
  exports: 'system/exports',
  mediaIndex: 'media/index.ndjson',
  trash: 'system/trash',
}

/** 人格目录内部的标准相对路径。 */
export function personaPaths(id) {
  const base = `${P.personas}/${id}`
  return {
    base,
    manifest: `${base}/persona.json`,
    persona: `${base}/persona`,
    self: `${base}/persona/SELF.md`,
    lines: `${base}/persona/lines.md`,
    // 曾经的 `persona/user.md`（"用户画像"）已废弃（2026-11-09）：它从未被任何代码读写，
    // 而"关于你"这件事由记忆事实 + 人物卡覆盖。老数据目录里可能还留着那份文件，我们不删它。
    core: `${base}/core.json`,
    style: `${base}/style.md`,
    interests: `${base}/self/interests.json`,
    purposes: `${base}/self/purposes.json`,
    actions: `${base}/self/actions.ndjson`,
    groups: `${base}/entities/groups`,
    spaces: `${base}/spaces`,
    journal: `${base}/journal`,
    rules: `${base}/rules`,
    globalRule: `${base}/rules/global.json`,
    proposals: `${base}/proposals`,
    weights: `${base}/state/weights.json`,
    access: `${base}/state/access.ndjson`,
    sessions: `${base}/state/sessions.json`,
    cursor: `${base}/state/cursor.json`,
    versions: `${base}/versions`,
    versionsBlobs: `${base}/versions/blobs`,
    versionsJournal: `${base}/versions/journal.ndjson`,
    snapshots: `${base}/snapshots`,
    changes: `${base}/changes.ndjson`,
  }
}
