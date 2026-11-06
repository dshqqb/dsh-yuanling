// src/core/cli.js —— 命令行入口。返回退出码，便于测试直接调用。
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { resolveRoot, validateRoot, P } from './paths.js'
import { scaffold } from './scaffold.js'
import { readMarker, listPersonas, createPersona, switchPersona, appendChange } from './persona.js'
import { checkFormat } from './manifest.js'
import { doctor, doctorExitCode } from './doctor.js'
import { exists, localIso } from './fsx.js'
import { drain, healthReport } from './inbox.js'
import { sealDay, verifyDay, listDays, today, prevDate } from './raw.js'

const EXIT = { OK: 0, GENERAL: 1, CONFIG: 2, ROOT: 3, INTEGRITY: 4, LOCKED: 5 }

function parse(argv) {
  const out = { _: [], flags: {} }
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i]
    if (a.startsWith('--')) {
      const key = a.slice(2)
      const next = argv[i + 1]
      if (next !== undefined && !next.startsWith('--')) {
        out.flags[key] = next
        i += 1
      } else {
        out.flags[key] = true
      }
    } else {
      out._.push(a)
    }
  }
  return out
}

function out(text) {
  process.stdout.write(text + '\n')
}

function err(text) {
  process.stderr.write(text + '\n')
}

/**
 * @param {string[]} argv 不含 node 与脚本名
 * @param {{env?:object}} opts
 * @returns {number} 退出码
 */
export async function main(argv = process.argv.slice(2), { env = process.env } = {}) {
  const { _, flags } = parse(argv)
  const cmd = _[0]

  const resolved = resolveRoot({ cli: flags.root, env })
  const root = resolved.root

  try {
    if (!cmd || cmd === 'help' || flags.help) {
      out(`yuanling —— 原灵

用法:
  yuanling init [--root <path>] [--persona <id>] [--name <显示名>]
  yuanling status [--root <path>] [--port <n>]
  yuanling drain                     消费 system/inbox/ 里的投递
  yuanling seal [--date YYYY-MM-DD]  封存某天（默认昨天）
  yuanling health                    各来源心跳 / 沉默状态
  yuanling serve [--port <n>]        启动回环 HTTP（POST /inbox）
  yuanling verify [--root <path>] [--json] [--all]
  yuanling doctor [--root <path>] [--json] [--fast]
  yuanling persona list
  yuanling persona new <id> [--name <n>] [--from <id>]
  yuanling persona switch <id>
  yuanling token --reset

退出码: 0 成功 / 1 一般错误 / 2 配置非法 / 3 数据目录不可达 / 4 完整性失败 / 5 锁被占用
`)
      return EXIT.OK
    }

    if (cmd === 'init') {
      const personaId = String(flags.persona ?? 'yuanling')
      const name = String(flags.name ?? '原灵')
      // init 是显式命令：目录不存在时允许创建（这是它的职责）
      if (!exists(root)) fs.mkdirSync(root, { recursive: true })
      const check = validateRoot(root)
      if (!check.ok) {
        err('✗ 数据目录不可用：')
        for (const e of check.errors) err(`  · ${e.code}: ${e.message}`)
        return EXIT.ROOT
      }
      for (const w of check.warnings) err(`⚠ ${w.code}: ${w.message}`)
      for (const s of check.skips) err(`· skip ${s.id}: ${s.reason}`)

      const r = scaffold(root, { personaId, name, now: localIso() })
      out(`✓ 数据目录：${root}（来源：${resolved.source}）`)
      out(`  新建 ${r.created.length} 项，跳过已存在 ${r.skipped.length} 项`)
      if (r.created.length) {
        for (const c of r.created.slice(0, 40)) out(`  + ${c}`)
        if (r.created.length > 40) out(`  … 另有 ${r.created.length - 40} 项`)
      }
      for (const w of r.warnings) err(`⚠ ${w}`)
      out('')
      out('下一步：打开 第一条.md，照三步起第一条记忆。')
      return EXIT.OK
    }

    // 以下命令都要求 root 已经存在：不存在就拒绝，绝不自动新建
    const check = validateRoot(root)
    if (!check.ok) {
      err('✗ 数据目录不可用：')
      for (const e of check.errors) err(`  · ${e.code}: ${e.message}`)
      err('  提示：先运行 yuanling init，或检查 dataDir / YUANLING_HOME 是否指向了正确的盘。')
      return EXIT.ROOT
    }

    if (cmd === 'status') {
      const marker = readMarker(root)
      const port = flags.port ?? env.YUANLING_PORT ?? 17777
      out(`数据目录  ${root}`)
      out(`来源      ${resolved.source}`)
      out(`格式      ${marker?.format ?? '未知'}`)
      out(`激活人格  ${marker?.active ?? '（无）'}`)
      out(`人格数    ${marker?.personas?.length ?? 0}`)
      out(`管理台    http://127.0.0.1:${port}${Number(port) === 0 ? '（端口为 0，实际端口见启动日志）' : ''}`)
      return EXIT.OK
    }

    if (cmd === 'drain') {
      const r = drain(root)
      out(`消费 ${r.files} 个投递文件：新增 ${r.accepted}，去重 ${r.deduped}，跳过 ${r.skipped}`)
      for (const e of r.errors) err(`  ! ${e}`)
      return r.errors.length ? EXIT.GENERAL : EXIT.OK
    }

    if (cmd === 'seal') {
      const date = String(flags.date ?? prevDate(today()))
      const r = sealDay(root, date)
      if (!r.sealed) {
        out(`· ${date} 已经封存过，未重复处理`)
        return EXIT.OK
      }
      out(`✓ 已封存 ${date}：${Object.keys(r.day.files).length} 个文件`)
      return EXIT.OK
    }

    if (cmd === 'health') {
      const list = healthReport(root)
      if (!list.length) {
        out('（还没有任何来源写过心跳）')
        return EXIT.OK
      }
      for (const h of list) out(`${h.state.padEnd(7)} ${h.source}\t${h.at ?? '-'}`)
      return list.some((h) => h.state === 'silent') ? EXIT.INTEGRITY : EXIT.OK
    }

    if (cmd === 'serve') {
      const { listen } = await import('./server.js')
      const port = Number(flags.port ?? env.YUANLING_PORT ?? 17777)
      const r = await listen(root, { port })
      out(`✓ 管理台/接口：${r.url}`)
      out('  Ctrl+C 结束。')
      return EXIT.OK
    }
    if (cmd === 'verify') {
      const f = checkFormat(root)
      const d = doctor(root, { fast: true })
      // raw 链校验：默认只查最后一天，--all 查全部（天数多了会很慢）
      const days = listDays(root)
      const targets = flags.all ? days : days.slice(-1)
      const raw = targets.map((date) => ({ date, ...verifyDay(root, date) }))
      const rawOk = raw.every((r) => r.ok)
      if (flags.json) {
        out(JSON.stringify({ format: f, doctor: d, raw }, null, 2))
      } else {
        out(`format  ${f.ok ? '✓' : '✗'}`)
        for (const e of f.errors ?? []) err(`  · ${e.code}: ${e.message}`)
        out(`体检    ${d.ok ? '✓' : '✗'}（${d.summary.pass} pass / ${d.summary.warn} warn / ${d.summary.fail} fail / ${d.summary.skip} skip）`)
        for (const r of raw) {
          out(`raw     ${r.ok ? '✓' : '✗'} ${r.date}`)
          for (const e of r.errors) err(`  · ${e.code}: ${e.message}`)
          for (const w of r.warnings) err(`  ! ${w.code}: ${w.message}`)
        }
        if (!raw.length) out('raw     · 还没有已封存的日期')
      }
      return f.ok && d.ok && rawOk ? EXIT.OK : EXIT.INTEGRITY
    }

    if (cmd === 'doctor') {
      const d = doctor(root, { fast: Boolean(flags.fast) })
      if (flags.json) {
        out(JSON.stringify(d, null, 2))
      } else {
        for (const c of d.checks) {
          const mark = c.status === 'pass' ? '✓' : c.status === 'warn' ? '!' : c.status === 'skip' ? '·' : '✗'
          const extra = c.reason ? ` (${c.reason})` : ''
          out(`${mark} ${c.id}${extra}`)
        }
        out('')
        out(`summary: ${d.summary.pass} pass / ${d.summary.warn} warn / ${d.summary.fail} fail / ${d.summary.skip} skip`)
      }
      return doctorExitCode(d)
    }

    if (cmd === 'persona') {
      const sub = _[1]
      if (sub === 'list' || !sub) {
        const list = listPersonas(root)
        if (!list.length) out('（还没有人格，先跑 yuanling init）')
        for (const p of list) out(`${p.active ? '*' : ' '} ${p.id}\t${p.name}\t${p.dirExists ? '' : '（目录缺失！）'}`)
        return EXIT.OK
      }
      if (sub === 'new') {
        const id = _[2]
        if (!id) {
          err('用法：yuanling persona new <id> [--name <n>] [--from <id>]')
          return EXIT.CONFIG
        }
        const r = createPersona(root, id, String(flags.name ?? id), { from: flags.from ? String(flags.from) : null })
        out(`✓ 已创建人格 ${r.id}（${r.name}）`)
        return EXIT.OK
      }
      if (sub === 'switch') {
        const id = _[2]
        if (!id) {
          err('用法：yuanling persona switch <id>')
          return EXIT.CONFIG
        }
        const r = switchPersona(root, id)
        out(r.changed ? `✓ 已切换到「${r.id}」（原：${r.previous}）` : `· 已经是「${r.id}」，未变`)
        return EXIT.OK
      }
      err(`未知子命令：persona ${sub}`)
      return EXIT.CONFIG
    }

    if (cmd === 'token') {
      const p = path.join(root, P.consoleToken)
      if (!flags.reset) {
        out(`令牌文件：${p}`)
        out(`是否存在：${exists(p) ? '是' : '否'}`)
        out('重置：yuanling token --reset')
        return EXIT.OK
      }
      fs.mkdirSync(path.dirname(p), { recursive: true })
      const token = crypto.randomBytes(32).toString('hex')
      fs.writeFileSync(p, token + '\n', { encoding: 'utf8', mode: 0o600 })
      appendChange(root, { kind: 'token_reset' })
      out(`✓ 已重置控制台令牌（${p}）`)
      return EXIT.OK
    }

    err(`未知命令：${cmd}。用 yuanling help 看用法。`)
    return EXIT.CONFIG
  } catch (e) {
    err(`✗ ${e?.message ?? e}`)
    return EXIT.GENERAL
  }
}
