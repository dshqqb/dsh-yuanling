// src/core/diagnostics.js —— 诊断：把"模糊的不对劲"拆成可判定的项。
//
// 借鉴 surfcore 的做法（voice-diagnostics.js）：输出不是一段日志，而是
// `{ code, stage, level, hint }` —— 每条都有**能直接执行的下一步**。
// "诊断：一切正常"这种句子在这里是不允许的：说不清查了什么，就等于没查。
//
// 三层来源，合并成一张清单：
//   ① 核心自检（复用 doctor.js 的检查，映射成 code/stage/hint）
//   ② 模块事实（核心知道、模块自己不知道的那些）：
//      没握手 / 崩过 / 声明了能力却没授 / 配置过不了 schema / 自报项过期
//   ③ 模块自报（协议 v1.4 的 diag.report）：带 TTL，进程死了就不再算数
//
// 诊断只读，不改任何东西。它能给的最强建议是"跑某个命令"，而不会自己去修——
// 一个诊断功能顺手改数据，出事时你分不清是它修坏的还是本来就坏的。
import path from 'node:path'

import { exists, isDir, readJson, localIso } from './fsx.js'
import { doctor } from './doctor.js'
import { readRegistry, grantedOf, moduleDir, listIds } from './modules/registry.js'
import { validateConfig } from './modules/configschema.js'
import { eventsHealth } from './events.js'
import { tailModuleLog } from './modules/manage.js'
import { today, prevDate, verifyDay, relDayDir } from './raw.js'
import fsSync from 'node:fs'

export const DIAG_LEVELS = {
  pass: 'info',
  info: 'info',
  warn: 'warn',
  fail: 'error',
}

/**
 * doctor 的每个检查项 → 人话 + 下一步。
 * 这张表就是"诊断"和"体检"的区别：体检告诉你哪一项红了，诊断告诉你下一步做什么。
 */
const CHECK_HINTS = {
  root: {
    stage: 'env',
    hint: '数据目录不可写或是网络盘：换成普通本地磁盘路径（--root / YUANLING_HOME / DSH 设置里的 dataDir）',
  },
  format: {
    stage: 'format',
    hint: '格式版本对不上：数据目录可能被新版本写过（降级）或已损坏。先备份，再看 system/manifest.json',
  },
  marker: {
    stage: 'persona',
    hint: '人格注册表坏了：跑 `yuanling status` 看活动人格，必要时 `yuanling init --root <同路径>` 补缺失项',
  },
  persona_dirs: {
    stage: 'persona',
    hint: '人格目录缺文件：`yuanling init` 只补缺失、不覆盖已有，可以直接跑一遍',
  },
  token: {
    stage: 'console',
    hint: '管理台令牌不对：跑 `yuanling token --reset`，然后到页面上重新粘贴 system/secrets/console.token',
  },
  raw_layout: {
    stage: 'raw',
    hint: '原始层目录结构不对：确认 --root 指的是同一个数据目录，不要和别的项目混用',
  },
  fs_type: {
    stage: 'raw',
    hint: '这条检查还没实现（不是通过，是没查）：在 exFAT/FAT32 上只能靠 hash 链校验，不能靠权限位',
  },
  token_file_size: {
    stage: 'console',
    hint: '令牌文件体积异常：`yuanling token --reset` 重写一份',
  },
}

function item({ code, level = 'info', stage = 'core', hint = '', detail = null, module = null, source = 'core' }) {
  return {
    code: String(code),
    level: level === 'fail' ? 'error' : level,
    stage,
    hint: String(hint),
    module,
    source,
    ...(detail ? { detail } : {}),
  }
}

/** ① 核心自检 → 清单。onlyProblems=false 时把通过项也列出来（说明"查了什么"）。 */
function coreChecks(root, { fast = false, onlyProblems = true } = {}) {
  const out = []
  let result = null
  try {
    result = doctor(root, { fast })
  } catch (error) {
    return [
      item({
        code: 'doctor.crashed',
        level: 'error',
        stage: 'env',
        hint: `体检本身跑不起来（${error?.message ?? error}）：先确认数据目录还在、外层磁盘没掉线`,
      }),
    ]
  }

  for (const c of result.checks) {
    if (onlyProblems && c.status === 'pass') continue
    const meta = CHECK_HINTS[c.id] ?? { stage: 'core', hint: '看 detail 里的原始信息' }
    out.push(
      item({
        code: `check.${c.id}`,
        level: DIAG_LEVELS[c.status] ?? 'info',
        stage: meta.stage,
        hint: c.status === 'pass' ? '正常' : c.status === 'skip' ? `没查：${c.reason ?? '未说明'}` : meta.hint,
        detail: c.detail ?? null,
      }),
    )
  }

  // 原始层的完整性：日链 sha256 对不上，说明**盘上的 raw 被改过**。
  // 这条不做"自动修复"——raw 只追加，hash 不对就是被人动过，该让看见的人自己判断。
  out.push(...rawChainChecks(root, { fast }))
  return out
}

/**
 * 原始层日链校验（最近两天）。
 *
 * 为什么只查两天：一天一条 sha256 链，越久越贵；而"有人动了昨天的盘"是最该被发现的。
 * 为什么需要这条：raw 没有改/删代码，但"没有代码会改"不等于"盘上没被改"——
 * 没有校验就没人能发现，这跟"不可改"是两个概念。
 */
function rawChainChecks(root, { fast = false } = {}) {
  const out = []
  const todayStr = today(new Date())
  const days = [todayStr, prevDate(todayStr)].filter(Boolean)
  const span = fast ? days.slice(0, 1) : days

  for (const d of span) {
    // 这天一条 raw 都没有：没东西可校验，别报一条"没封存"的假警报
    const dir = path.join(root, relDayDir(d))
    const hasData =
      isDir(dir) &&
      fsSync.readdirSync(dir).some((f) => f.endsWith('.ndjson'))
    if (!hasData) continue

    const r = verifyDay(root, d)
    if (r.ok) continue

    // 有数据但没封存 → 可能是还没跑封存（提示即可）；哈希对不上 → 真的被改过（error）
    const unsealed = (r.errors ?? []).some((e) => e.code === 'NO_DAY_JSON')
    out.push(
      item({
        code: unsealed ? 'raw.not-sealed' : 'raw.chain-broken',
        level: unsealed ? 'warn' : 'error',
        stage: 'raw',
        hint: unsealed
          ? `这天有原始数据但还没封存（${d}）：跑 yuanling seal ${d} 生成日链；未封存期间没有完整性凭据`
          : `原始层日链对不上（${d}）：盘上的 raw 被改过。raw 只追加，这条不该出现——先备份，再对 ${d} 逐条核对`,
        detail: r,
      }),
    )
  }
  return out
}

/** ② 模块事实：核心知道、模块自己不知道的那些。 */
function moduleFacts(root) {
  const items = []
  // readRegistry 是容错的（坏了返回空表），所以"读不了"不是一个能出现的状态——
  // 不在这里编一条永远显示不出来的诊断项。
  const reg = readRegistry(root)

  for (const id of listIds(reg)) {
    const entry = reg.modules[id]
    const manifestPath = path.join(moduleDir(root, id), 'yuanling.module.json')
    const manifest = exists(manifestPath) ? readJson(manifestPath, null) : null

    if (!manifest) {
      items.push(
        item({
          code: 'module.manifest-missing',
          level: 'error',
          stage: 'module',
          module: id,
          hint: `注册表里有「${id}」但目录里没有 yuanling.module.json：卸载它再重装（yuanling module uninstall ${id} --yes）`,
        }),
      )
      continue
    }

    // 声明了能力却没授：不是故障，但一定会"看起来没反应"，所以要说出来
    const declared = Array.isArray(manifest.capabilities) ? manifest.capabilities : []
    const granted = grantedOf(entry)
    const pending = declared.filter((c) => !granted.includes(c))
    if (pending.length) {
      items.push(
        item({
          code: 'module.capability-pending',
          level: 'warn',
          stage: 'module',
          module: id,
          hint: `它声明了 ${pending.join('、')} 但没被授予：在模块页点开关授予，否则相关功能会被拒（E_NO_CAP）`,
          detail: { declared, granted },
        }),
      )
    }

    // 启用了却没跑起来 / 崩过
    const state = String(entry.state ?? '')
    if (entry.enabled !== false && state && !['ready', 'running', 'starting'].includes(state)) {
      const crash = entry.last_crash?.reason ? `（上次崩溃：${entry.last_crash.reason}）` : ''
      items.push(
        item({
          code: 'module.not-running',
          level: state === 'crashed' ? 'error' : 'warn',
          stage: 'module',
          module: id,
          hint: `状态是 ${state}${crash}：到模块页点「重启」，还不行就看它日志最后一屏${tailLastLine(root, id)}`,
          detail: { state, lastCrash: entry.last_crash ?? null },
        }),
      )
    }

    // 配置过不了 schema：模块自己不读文件，坏值会原样带到它里面
    const schema = manifest.config?.schema ?? null
    if (schema) {
      const value = readJson(path.join(moduleDir(root, id), 'config.json'), {}) ?? {}
      const v = validateConfig(schema, value)
      if (!v.ok) {
        const first = v.errors?.[0]
        items.push(
          item({
            code: 'module.config-invalid',
            level: 'error',
            stage: 'module',
            module: id,
            hint: `配置不合法（${first?.message ?? '见 detail'}）：到模块页的配置表单改掉并保存`,
            detail: { errors: v.errors ?? [] },
          }),
        )
      }
    }
  }
  return items
}

function tailLastLine(root, id) {
  try {
    const lines = tailModuleLog(root, id, { lines: 1 })
    return lines.length ? `（「${lines[0].replace(/^.*?\\s\\s/, '').slice(0, 120)}」）` : ''
  } catch {
    return ''
  }
}

/** ③ 事件流自身健康：写不进去就是"审计在瞎"，这本身必须是一条诊断。 */
function eventHealthItems(root) {
  const h = eventsHealth(root)
  const items = []
  if (!h.writable) {
    items.push(
      item({
        code: 'events.unwritable',
        level: 'error',
        stage: 'log',
        hint: `事件流写不进去（${h.lastError || '未知'}）：日志与审计会缺失。检查磁盘空间与 raw/system 目录权限`,
      }),
    )
  }
  return items
}

/**
 * 跑一次诊断。
 *
 * @param {string} root
 * @param {{onlyProblems?:boolean, fast?:boolean, moduleDiag?:(id:string)=>{items:Array,at:string|null,stale:boolean}}} opts
 *   `moduleDiag` 由调用方注入（管理台有 service 实例，能拿到自报项；CLI 只读文件）
 * @returns {{ok:boolean, ts:string, items:Array, summary:object, checked:number}}
 */
export function diagnose(root, { onlyProblems = true, fast = false, moduleDiag = null } = {}) {
  const items = [...coreChecks(root, { fast, onlyProblems }), ...moduleFacts(root), ...eventHealthItems(root)]

  // 模块自报（v1.4）：过期就不算数了
  if (typeof moduleDiag === 'function') {
    const reg = readRegistry(root)
    for (const id of listIds(reg)) {
      let r = null
      try {
        r = moduleDiag(id)
      } catch {
        continue
      }
      if (!r || !Array.isArray(r.items)) continue
      for (const x of r.items) {
        items.push(
          item({
            code: `module.${x.code ?? 'reported'}`,
            level: x.level ?? 'info',
            stage: 'module',
            module: id,
            hint: x.hint || '（模块没给建议）',
            detail: x.detail ?? null,
            source: 'module',
          }),
        )
      }
    }
  }

  const summary = { ok: 0, warn: 0, error: 0, info: 0 }
  for (const x of items) summary[DIAG_LEVELS[x.level] ?? x.level] = (summary[DIAG_LEVELS[x.level] ?? x.level] ?? 0) + 1

  return {
    ok: summary.error === 0,
    ts: localIso(),
    items,
    summary,
    checked: items.length,
  }
}

/** 渲染成 CLI 文本（诊断页和命令共用同一份措辞）。 */
export function renderDiagnostics(result) {
  const lines = [`诊断 ${result.ts}：${result.ok ? '没有硬故障' : '有硬故障'}（${result.summary.error} 错 / ${result.summary.warn} 警告 / ${result.summary.info} 提示）`]
  if (!result.items.length) {
    lines.push('（没有需要处理的事）')
    return lines.join('\n')
  }
  for (const x of result.items) {
    const tag = { error: '[错]', warn: '[警]', info: '[讯]' }[x.level] ?? '[讯]'
    const who = x.module ? ` ${x.module}` : ''
    lines.push(`${tag} ${x.code}${who} · ${x.stage}`)
    if (x.hint) lines.push(`    ${x.hint}`)
  }
  lines.push('')
  lines.push('诊断只读：它不会自己去修。给出的命令都可以自己跑一遍。')
  return lines.join('\n')
}
