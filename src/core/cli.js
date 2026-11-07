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
import { sealDay, verifyDay, listDays, today, prevDate, recentMessages } from './raw.js'
import { history, revertTo, scanExternalEdits, snapshotCurrent, stats as versionStats } from './version.js'
import { addFact, recall, openEntry, buildCard, listEntries, why as memoryWhy, DEFAULT_SPACE, CARD_BUDGET_BYTES } from './memory.js'
import { shield, unshield, listShields, recentRecordIds, rebuildShields } from './shield.js'
import {
  loadIdentities,
  createPerson,
  linkIdentity,
  findByIdentity,
  listCandidates,
  confirmCandidate,
  rejectCandidate,
  mergePeople,
  splitIdentity,
  readProfile,
  writeProfile,
  readGroup,
  writeGroup,
} from './entities.js'
import { catchUp, catchUpStatus } from './catchup.js'
import { loadEffectiveRules, checkAction, loadGuardrails, recentRefusals } from './rules.js'
import { claimIdentity, extractClaims, inferIdentityCandidates, applyInferredCandidates, correctIdentity } from './identity.js'
import { refreshWeights, setManualWeight, clearManualWeight } from './weights.js'
import { findProfiles, mcpStatus, installMcp, uninstallMcp, defaultNodeCmd, defaultServerPath } from './mcpinstall.js'
import { setIdentityText } from './entities.js'
import { refreshDrives } from './drives.js'
import { readPurposes, writePurposes, minePurposes, closePurpose, duePurposes, expirePurposes, purposesPath } from './purposes.js'
import { scan as scanProposals, listProposals, findProposal, approve, reject, rollback, sweep, readPolicy } from './proposals.js'

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
  yuanling last [--limit 5] [--source qq] [--json]   最近的消息（带可直接用的指针）
  yuanling seal [--date YYYY-MM-DD]  封存某天（默认昨天）
  yuanling health                    各来源心跳 / 沉默状态
  yuanling serve [--port <n>]        启动回环 HTTP（POST /inbox）
  yuanling versions                  版本库统计
  yuanling history <路径> [--json]   看某文件的历史
  yuanling track <路径>              把当前内容记一笔
  yuanling revert <路径> --to <x>    回滚（x = hash / 时间戳前缀）
  yuanling scan                      检测插件外的修改
  yuanling memory save --topic <t> --text <内容> (--src <指针> | --src-last 1) [--slot s] [--imp n]
  yuanling memory recall <查询> [--limit 5] [--all]
  yuanling memory open <主题>
  yuanling memory why <factId>       这条凭什么存在（指针 + 变更史）
  yuanling memory list
  yuanling shield [--last N] [--channel c] [--yes]   屏蔽"刚才"（默认只预览）
  yuanling shield list | shield rebuild
  yuanling unshield <id...>          撤销屏蔽
  yuanling person list|new|show|link|merge|split|profile
  yuanling person candidates|confirm <n>|reject <n>
  yuanling person weight [refresh] | set <uid> <0-100> | auto <uid>
  yuanling person identity <uid> [--text "QQ 号是 12345，b站叫老张"] [--no-link]
  yuanling identity claim --platform bili --id 123 --src <指针> [--channel private:10001]
  yuanling identity infer [--apply]   从 raw 推断跨平台同名（只提候选）
  yuanling identity correct <uid> --platform bili --id 123
  yuanling proposal scan             把"反复出现的主张"变成提案
  yuanling purpose list|mine|drives|close <id>   目的账本（惦记）
  yuanling mcp status|install|uninstall         把记忆登记成 DSH 的 MCP 工具
  yuanling proposal list|show|approve|reject|rollback|sweep|policy
  yuanling group show|set <群号> [--name --intro --tone]
  yuanling catchup [--limit 200]     切入补跑（把游标追平）
  yuanling rule show [--channel c]    看合并后的有效规则与来源
  yuanling rule check <action> [--channel c]
  yuanling rule guardrails            看根级硬线
  yuanling rule refusals [--limit n]  最近的拒绝记录
  yuanling card                      打印本轮会注入的卡片
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
      const missing = check.errors.some((e) => e.code === 'ROOT_MISSING')
      if (missing) {
        err('')
        err('  这个路径还没有被初始化。先运行：')
        err(`    yuanling init --root "${root}"`)
        err('  （如果它本该已经存在，检查盘符是否插好、dataDir 是否指错——原灵不会替你新建目录）')
      } else {
        err('')
        err('  提示：检查目录权限，或换一个当前用户可写的位置。')
      }
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

    if (cmd === 'last') {
      const list = recentMessages(root, {
        limit: Number(flags.limit ?? 5),
        source: flags.source ? String(flags.source) : null,
      })
      if (!list.length) {
        out('（还没有任何原始消息）')
        return EXIT.OK
      }
      if (flags.json) {
        out(JSON.stringify(list.map((r) => ({ pointer: r.pointer, ts: r.ts, channel: r.channel, text: r.text })), null, 2))
        return EXIT.OK
      }
      for (const r of list) {
        const t = String(r.text ?? '').slice(0, 50)
        out(`${r.pointer}  ${r.channel}  ${t}`)
      }
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

    if (cmd === 'history') {
      const rel = _[1]
      if (!rel) {
        err('用法：yuanling history <相对路径> [--json]')
        return EXIT.CONFIG
      }
      const list = history(root, rel)
      if (flags.json) out(JSON.stringify(list, null, 2))
      else if (!list.length) out('（没有历史：这个文件从没被跟踪过）')
      else {
        for (const e of list) {
          out(`${e.ts}  ${String(e.hash).slice(0, 19)}…  ${String(e.kind).padEnd(13)} ${e.actor}  ${e.reason ?? ''}`)
        }
      }
      return EXIT.OK
    }

    if (cmd === 'track') {
      const rel = _[1]
      if (!rel) {
        err('用法：yuanling track <相对路径>')
        return EXIT.CONFIG
      }
      const r = snapshotCurrent(root, rel, { reason: 'manual track' })
      out(r.changed ? `✓ 已记录 ${rel}` : '· 内容没变，未新增版本')
      return EXIT.OK
    }

    if (cmd === 'revert') {
      const rel = _[1]
      if (!rel || !flags.to) {
        err('用法：yuanling revert <相对路径> --to <hash|时间戳>')
        return EXIT.CONFIG
      }
      const r = revertTo(root, rel, String(flags.to))
      if (!r.changed) {
        out(`· 目标版本与当前内容一致，未产生新版本：${rel}`)
        return EXIT.OK
      }
      out(`✓ 已回滚 ${rel}（新版本 ${String(r.hash).slice(0, 19)}…）`)
      out('  回滚本身也是一次新版本，后来的历史没有被擦掉。')
      return EXIT.OK
    }

    if (cmd === 'scan') {
      const changed = scanExternalEdits(root)
      if (!changed.length) {
        out('· 没有检测到插件外的修改')
        return EXIT.OK
      }
      for (const c of changed) out(`! ${c.path}  ${String(c.from).slice(0, 14)}… → ${String(c.to).slice(0, 14)}…`)
      return EXIT.OK
    }

    if (cmd === 'versions') {
      const list = versionStats(root)
      if (!list.length) {
        out('（还没有任何版本记录）')
        return EXIT.OK
      }
      for (const s of list) out(`${s.scope.padEnd(10)} ${String(s.entries).padStart(4)} 条  ${String(s.blobs).padStart(4)} blob`)
      return EXIT.OK
    }

    if (cmd === 'memory') {
      const marker = readMarker(root)
      const pid = flags.persona ? String(flags.persona) : marker?.active
      if (!pid) {
        err('没有激活人格，先跑 yuanling init')
        return EXIT.CONFIG
      }
      const sub = _[1]

      if (sub === 'save') {
        const text = flags.text
        let src = flags.src

        // --src-last [N]：直接用最近第 N 条消息当证据，省掉复制粘贴
        if (!src && flags['src-last'] !== undefined) {
          const n = Math.max(1, Number(flags['src-last']) || 1)
          const rows = recentMessages(root, { limit: n, source: flags.source ? String(flags.source) : null })
          src = rows[n - 1]?.pointer
          if (!src) {
            err('没有可用的原始消息：先投递一条，或去掉 --src-last 改用 --src')
            return EXIT.CONFIG
          }
          out(`· 用最近第 ${n} 条作证据：${src}`)
        }

        if (src && (/[<>]/.test(String(src)) || String(src).includes('粘贴'))) {
          err(`这看起来是占位符，不是真指针：${src}`)
          err('真指针形如 raw/2026-11/07/qq.ndjson#01M6RT...，可用 `yuanling last` 查看，或用 --src-last 1 自动取')
          return EXIT.CONFIG
        }

        if (!text || !src) {
          err('用法：yuanling memory save --topic <主题> --text <内容> (--src <指针> | --src-last 1) [--slot <槽位>] [--imp 0-100]')
          return EXIT.CONFIG
        }
        const r = addFact(root, pid, {
          topic: String(flags.topic ?? '未分类'),
          space: String(flags.space ?? DEFAULT_SPACE),
          text: String(text),
          slot: flags.slot ? String(flags.slot) : null,
          src: String(src),
          imp: flags.imp !== undefined ? Number(flags.imp) : null,
        })
        if (!r.added) {
          out(`· 未写入：${r.reason}（已有 ${r.fact.id}：${r.fact.text}）`)
          return EXIT.OK
        }
        out(`✓ 已写入 ${r.entry.topic}：${r.fact.text}`)
        out(`  重要度 ${r.fact.imp}${r.closed.length ? `，关闭旧值 ${r.closed.length} 条` : ''}`)
        return EXIT.OK
      }

      if (sub === 'recall') {
        const q = _[2] ? _[2] : flags.q ? String(flags.q) : ''
        const hits = recall(root, pid, String(q), {
          space: flags.space ? String(flags.space) : null,
          limit: Number(flags.limit ?? 5),
          includeExpired: Boolean(flags.all),
        })
        if (!hits.length) {
          out('（没有命中。可能：没记过 / 换个说法 / 补一条别名）')
          return EXIT.OK
        }
        for (const h of hits) {
          out(`${h.score.toFixed(3)}  〔${h.topic}〕${h.fact.text}${h.fact.until ? '（已失效）' : ''}`)
          out(`         ${h.fact.src}`)
        }
        return EXIT.OK
      }

      if (sub === 'open') {
        const topic = _[2]
        if (!topic) {
          err('用法：yuanling memory open <主题> [--space 日常]')
          return EXIT.CONFIG
        }
        const e = openEntry(root, pid, String(topic), String(flags.space ?? DEFAULT_SPACE))
        if (!e) {
          err(`没有这个主题：${topic}`)
          return EXIT.CONFIG
        }
        out(`〔${e.space} / ${e.topic}〕${e.summary}`)
        for (const f of e.active) out(`  - [${f.slot ?? '-'}] ${f.text}  @since ${f.since}  imp=${f.imp}`)
        if (e.expired.length) {
          out('  曾经：')
          for (const f of e.expired) out(`  - [${f.slot ?? '-'}] ${f.text}  @until ${f.until}`)
        }
        return EXIT.OK
      }

      if (sub === 'why') {
        const id = _[2]
        if (!id) {
          err('用法：yuanling memory why <factId>')
          return EXIT.CONFIG
        }
        const w = memoryWhy(root, pid, String(id))
        if (!w) {
          err(`没有这条事实：${id}`)
          return EXIT.CONFIG
        }
        out(`〔${w.topic}〕${w.fact.text}`)
        out(`  指针  ${w.src.pointer}`)
        out(`        ${w.src.ok ? '✓ 可达' : `✗ ${w.src.reason}`}`)
        out(`  重要度 ${w.fact.imp}   创建 ${w.fact.created}${w.fact.until ? `   失效 ${w.fact.until}` : ''}`)
        if (w.shielded) out('  状态：已屏蔽（证据被用户撤回）')
        out('  变更史：')
        for (const h of w.history.slice(-6)) out(`    ${h.ts}  ${h.kind.padEnd(13)} ${h.reason ?? ''}`)
        return EXIT.OK
      }

      if (sub === 'list' || !sub) {
        const list = listEntries(root, pid)
        if (!list.length) out('（还没有任何条目）')
        for (const e of list) out(`${e.space}/${e.topic}  ${e.facts.length} 条  ${e.summary || e.facts[0]?.text || ''}`)
        return EXIT.OK
      }

      err(`未知子命令：memory ${sub}`)
      return EXIT.CONFIG
    }

    if (cmd === 'card') {
      const marker = readMarker(root)
      const pid = marker?.active
      if (!pid) {
        err('没有激活人格')
        return EXIT.CONFIG
      }
      const text = buildCard(root, pid)
      out(text || '（卡片为空：还没有事实）')
      out('')
      out(`—— ${Buffer.byteLength(text, 'utf8')} 字节 / 预算 ${CARD_BUDGET_BYTES}`)
      return EXIT.OK
    }

    if (cmd === 'shield') {
      const sub = _[1]

      if (sub === 'list') {
        const list = listShields(root)
        if (!list.length) out('（还没有任何屏蔽登记）')
        for (const r of list) {
          const state = r.revoked_at ? '已撤销' : '生效中'
          out(`${r.at}  ${state}  ${r.targets.length} 条  ${r.reason || ''}`)
          for (const t of r.targets) out(`    ${t}`)
        }
        return EXIT.OK
      }

      if (sub === 'rebuild') {
        const r = rebuildShields(root)
        out(`✓ 已按 raw 重建登记簿：${r.events} 个事件 / ${r.redactions} 条登记`)
        return EXIT.OK
      }

      // 默认：屏蔽"刚才"
      const last = Number(flags.last ?? 1)
      const cands = recentRecordIds(root, { last, channel: flags.channel ? String(flags.channel) : null })
      if (!cands.length) {
        out('· 没有找到可屏蔽的记录')
        return EXIT.OK
      }
      for (const c of cands) {
        const t = c.text.length > 40 ? c.text.slice(0, 40) + '…' : c.text
        out(`${c.id}  ${c.ts}  ${c.channel}  ${t}`)
      }
      if (!flags.yes) {
        out('')
        out('以上是预览。确认无误后加 --yes 执行屏蔽。')
        out('（raw 不会被删除，只会追加一条 redact，并在所有出口隔离）')
        return EXIT.OK
      }
      const r = shield(root, cands.map((c) => c.id), { reason: String(flags.reason ?? '用户要求删除') })
      out(`✓ 已屏蔽 ${cands.length} 条原始记录`)
      out(`  级联隔离记忆 ${r.cascaded.length} 条${r.already ? `，其中 ${r.already} 条本来就已屏蔽` : ''}`)
      return EXIT.OK
    }

    if (cmd === 'unshield') {
      const ids = _.slice(1)
      if (!ids.length) {
        err('用法：yuanling unshield <id...>')
        return EXIT.CONFIG
      }
      const r = unshield(root, ids, { reason: String(flags.reason ?? '用户撤销') })
      if (!r.redaction) {
        out('· 这些记录本来就没有被屏蔽')
        return EXIT.OK
      }
      out(`✓ 已撤销屏蔽；恢复记忆 ${r.restored.length} 条`)
      return EXIT.OK
    }

    if (cmd === 'mcp') {
      const sub = _[1] ?? 'status'
      const profiles = findProfiles()

      const pick = () => {
        if (flags.dir) {
          const dir = String(flags.dir)
          return { name: '(dir)', dir, patchPath: path.join(dir, 'cordis.patch.yml') }
        }
        if (flags.profile) {
          const hit = profiles.find((p) => p.name === String(flags.profile))
          if (!hit) {
            err(`没有这个 profile：${flags.profile}（可用：${profiles.map((p) => p.name).join('、') || '无'}）`)
            return null
          }
          return hit
        }
        if (profiles.length === 1) return profiles[0]
        if (!profiles.length) {
          err('没找到任何 profile（~/.dsh/profiles/*/cordis.patch.yml）；可用 --dir 指定目录')
          return null
        }
        err(`有多个 profile，请用 --profile 指定：${profiles.map((p) => p.name).join('、')}`)
        return null
      }

      const target = pick()
      if (!target) return EXIT.CONFIG

      if (sub === 'status') {
        const st = mcpStatus({ patchPath: target.patchPath })
        out(`profile    ${target.name}`)
        out(`配置文件   ${target.patchPath}`)
        out(`已登记     ${st.installed ? '是' : '否'}`)
        if (st.installed) {
          out(`命令       ${st.nodeCmd}`)
          out(`服务器     ${st.serverPath}`)
        } else {
          out('跑 `yuanling mcp install` 即可登记，无需手改 YAML')
        }
        return EXIT.OK
      }

      if (sub === 'install') {
        const r = installMcp({
          patchPath: target.patchPath,
          nodeCmd: flags.node ? String(flags.node) : defaultNodeCmd(),
          serverPath: flags.server ? String(flags.server) : defaultServerPath(),
          dryRun: Boolean(flags['dry-run']),
        })
        if (!r.changed) {
          out('✓ 已经登记过，内容没变（幂等）')
          return EXIT.OK
        }
        out(flags['dry-run'] ? '（dry-run）将要写入：' : `✓ 已写入 ${target.patchPath}`)
        if (r.backup) out(`  备份：${r.backup}`)
        out('  重启 DSH 后生效。')
        return EXIT.OK
      }

      if (sub === 'uninstall') {
        const r = uninstallMcp({ patchPath: target.patchPath, dryRun: Boolean(flags['dry-run']) })
        if (!r.changed) {
          out('✓ 本来就没登记，不用卸')
          return EXIT.OK
        }
        out(flags['dry-run'] ? '（dry-run）将会摘掉登记块' : '✓ 已摘掉登记块（其余配置原样保留）')
        out('  重启 DSH 后生效。')
        return EXIT.OK
      }

      err('用法：yuanling mcp status|install|uninstall [--profile <名字>] [--dir <目录>] [--node <path>] [--server <path>] [--dry-run]')
      return EXIT.CONFIG
    }

    if (cmd === 'purpose') {
      const sub = _[1] ?? 'list'
      const marker = readMarker(root)
      const pid = flags.persona ? String(flags.persona) : marker?.active

      const loadFacts = () =>
        listEntries(root, pid).flatMap((e) => (e.facts ?? []).map((f) => ({ ...f, topic: e.topic })))

      if (sub === 'mine') {
        const doc = readPurposes(root, pid)
        const mined = minePurposes(doc, loadFacts())
        if (mined.added.length) writePurposes(root, pid, mined)
        out(`✓ 新挖到 ${mined.added.length} 条惦记`)
        for (const p of mined.added) out(`  ${p.id}  [${p.need}] ${p.text}`)
        return EXIT.OK
      }

      if (sub === 'drives') {
        const drives = refreshDrives(root, pid)
        for (const [k, v] of Object.entries(drives)) out(`${k.padEnd(10)} ${v.toFixed(2)}`)
        return EXIT.OK
      }

      if (sub === 'close') {
        const id = _[2]
        if (!id) {
          err('用法：yuanling purpose close <id>')
          return EXIT.CONFIG
        }
        const doc = readPurposes(root, pid)
        const r = closePurpose(doc, id, { reason: String(flags.reason ?? '') })
        if (!r.changed) {
          err(`没有这个目的：${id}`)
          return EXIT.CONFIG
        }
        writePurposes(root, pid, { version: doc.version, items: r.items })
        out(`✓ 已关闭 ${id}`)
        return EXIT.OK
      }

      // list
      const doc = readPurposes(root, pid)
      const expired = expirePurposes(doc)
      if (expired) writePurposes(root, pid, doc)
      const open = doc.items.filter((p) => p.status === 'open')
      const done = doc.items.filter((p) => p.status !== 'open')
      if (!doc.items.length) out('（还没有目的。先跑 yuanling purpose mine）')
      for (const p of open) out(`○ ${p.id}  [${p.need}] ${p.text}${p.hits ? `  (提过 ${p.hits} 次)` : ''}`)
      for (const p of done) out(`× ${p.id}  [${p.status}] ${p.text}`)
      if (flags.due) {
        const drives = refreshDrives(root, pid)
        for (const p of duePurposes(doc.items, drives, { limit: 2 })) out(`→ ${p.text}`)
      }
      out(`\n账本 ${purposesPath(root, pid)}`)
      return EXIT.OK
    }

    if (cmd === 'proposal') {
      const sub = _[1]
      const marker = readMarker(root)
      const pid = flags.persona ? String(flags.persona) : marker?.active

      if (sub === 'scan') {
        const list = scanProposals(root, pid, {
          minRepeat: Number(flags.repeat ?? 5),
          minDays: Number(flags.days ?? 3),
        })
        if (!list.length) out('· 没有新的提案（重复次数或跨度还不够）')
        for (const p of list) out(`+ ${p.id}  ${p.claim}  （${p.count} 次 / ${p.days} 天）`)
        return EXIT.OK
      }

      if (sub === 'list' || !sub) {
        const all = listProposals(root, pid)
        const list = flags.all ? all : all.filter((p) => p.status === 'pending' || p.status === 'approved')
        if (!list.length) out('（没有提案）')
        for (const p of list) {
          const tag = p.status === 'approved' ? '已生效' : p.status === 'rejected' ? '已否决' : p.status === 'rolled_back' ? '已回滚' : '待定'
          out(`${p.id}  [${tag}]  ${p.claim}  （${p.count} 次 / ${p.days} 天）`)
        }
        return EXIT.OK
      }

      if (sub === 'show') {
        const id = _[2]
        if (!id) {
          err('用法：yuanling proposal show <id>')
          return EXIT.CONFIG
        }
        const p = findProposal(root, pid, id)
        if (!p) {
          err(`没有这个提案：${id}`)
          return EXIT.CONFIG
        }
        out(`${p.id}  [${p.status}]`)
        out(`主张：${p.claim}`)
        out(`依据：重复 ${p.count} 次，跨度 ${p.days} 天，主题「${p.topic}」`)
        out(`将追加到 style.md：${p.line}`)
        out(`证据：`)
        for (const e of p.evidence) out(`  ${e.src}`)
        if (p.status === 'pending') out(`\n批准：proposal approve ${p.id}   否决：proposal reject ${p.id}`)
        return EXIT.OK
      }

      if (sub === 'approve') {
        const id = _[2]
        if (!id) {
          err('用法：yuanling proposal approve <id>')
          return EXIT.CONFIG
        }
        const r = approve(root, pid, id, { by: 'human' })
        out(r.changed ? `✓ 已采纳并写入 style.md：${r.proposal.line}` : '· 已经生效过了')
        out(`  回滚窗口至 ${String(r.proposal.rollback_until).slice(0, 10)}`)
        return EXIT.OK
      }

      if (sub === 'reject') {
        const id = _[2]
        if (!id) {
          err('用法：yuanling proposal reject <id> [--reason "..."]')
          return EXIT.CONFIG
        }
        reject(root, pid, id, { reason: String(flags.reason ?? '') })
        out(`✓ 已否决 ${id}（不会再被自动批准）`)
        return EXIT.OK
      }

      if (sub === 'rollback') {
        const id = _[2]
        if (!id) {
          err('用法：yuanling proposal rollback <id>')
          return EXIT.CONFIG
        }
        rollback(root, pid, id)
        out(`✓ 已回滚 ${id}（style.md 退回采纳前）`)
        return EXIT.OK
      }

      if (sub === 'policy') {
        const policy = readPolicy(root)
        if (!policy) out('（还没同步过，使用默认：3 天后自动批准 / 每天 1 条）')
        else out(JSON.stringify(policy, null, 2))
        out('在 DSH 设置页改 autoApproveDays / dailyAutoLimit，或直接改 system/policy.json')
        return EXIT.OK
      }

      if (sub === 'sweep') {
        const r = sweep(root, pid)
        if (r.skipped) out(`· 跳过：${r.skipped}`)
        else if (!r.approved.length) out(`· 没有到期的提案（到期 ${r.days} 天 / 每日上限 ${r.dailyLimit}）`)
        for (const id of r.approved) out(`✓ 自动采纳 ${id}`)
        if (!r.skipped) out(`  到期 ${r.days} 天，每日上限 ${r.dailyLimit}，今日剩余 ${r.budgetLeft}`)
        return EXIT.OK
      }

      err(`未知子命令：proposal ${sub}`)
      return EXIT.CONFIG
    }

    if (cmd === 'identity') {
      const sub = _[1]
      const marker = readMarker(root)
      const pid = flags.persona ? String(flags.persona) : marker?.active

      if (sub === 'claim') {
        if (!flags.platform || !flags.id || !flags.src) {
          err('用法：yuanling identity claim --platform bili --id 123 --src <指针> [--channel private:10001] [--speaker owner|member]')
          return EXIT.CONFIG
        }
        const r = claimIdentity(root, pid, {
          platform: String(flags.platform),
          id: String(flags.id),
          channel: flags.channel ? String(flags.channel) : null,
          speakerKind: String(flags.speaker ?? 'owner'),
          text: String(flags.text ?? ''),
          src: String(flags.src),
        })
        if (r.state === 'confirmed') {
          out(`✓ 已确认并绑定 → ${r.uid}${r.changed === false ? '（原本就绑过）' : ''}`)
        } else {
          out(`· 已记为候选（${r.added ? '新增' : '已存在'}）。非本人私聊自述不自动合并。`)
        }
        return EXIT.OK
      }

      if (sub === 'extract') {
        const text = _[2] ? _.slice(2).join(' ') : String(flags.text ?? '')
        const claims = extractClaims(text)
        if (!claims.length) out('（没识别出身份主张）')
        for (const c of claims) out(`${c.platform}:${c.id}`)
        return EXIT.OK
      }

      if (sub === 'infer') {
        if (flags.apply) {
          const r = applyInferredCandidates(root, pid, { limit: Number(flags.limit ?? 50) })
          out(`✓ 推断出 ${r.proposals} 组，写入候选 ${r.added} 条（仍未合并）`)
          return EXIT.OK
        }
        const list = inferIdentityCandidates(root, { limit: Number(flags.limit ?? 50) })
        if (!list.length) out('（没有发现明显的跨平台同名）')
        for (const c of list) {
          out(`${c.display}：${c.identities.map((i) => `${i.platform}:${i.id}`).join('、')}  — ${c.reason}`)
        }
        if (list.length) out('\n加 --apply 才写入候选（仍然不会自动合并）')
        return EXIT.OK
      }

      if (sub === 'correct') {
        const uid = _[2]
        if (!flags.platform || !flags.id) {
          err('用法：yuanling identity correct <uid> --platform bili --id 123 --reason "..."')
          return EXIT.CONFIG
        }
        const r = correctIdentity(root, pid, {
          uid: uid ? String(uid) : null,
          platform: String(flags.platform),
          id: String(flags.id),
          reason: String(flags.reason ?? ''),
        })
        out(`✓ 已把 ${flags.platform}:${flags.id} 从 ${r.from} 拆到 ${r.to}`)
        out(`  关闭旧身份主张 ${r.closedFacts.length} 条（不删，只写 until）`)
        return EXIT.OK
      }

      err(`未知子命令：identity ${sub}`)
      return EXIT.CONFIG
    }

    if (cmd === 'person') {
      const sub = _[1]
      const marker = readMarker(root)
      const pid = flags.persona ? String(flags.persona) : marker?.active

      if (sub === 'list' || !sub) {
        const data = loadIdentities(root)
        const list = Object.values(data.people)
        if (!list.length) out('（还没有任何人物）')
        for (const p of list) {
          const ids = (p.identities ?? []).map((x) => `${x.platform}:${x.id}`).join('、') || '（无账号）'
          out(`${p.uid}  ${p.display}  [${ids}]`)
        }
        if (data.pending.length) out(`\n有 ${data.pending.length} 个待确认的疑似同一人（yuanling person candidates）`)
        return EXIT.OK
      }

      if (sub === 'new') {
        const display = _[2] || String(flags.name ?? '')
        if (!display) {
          err('用法：yuanling person new <显示名> [--platform qq --id 12345]')
          return EXIT.CONFIG
        }
        const p = createPerson(root, { display })
        if (flags.platform && flags.id) linkIdentity(root, p.uid, { platform: flags.platform, id: flags.id })
        out(`✓ 已建立人物 ${p.uid}（${p.display}）`)
        return EXIT.OK
      }

      if (sub === 'link') {
        const uid = _[2]
        if (!uid || !flags.platform || !flags.id) {
          err('用法：yuanling person link <uid> --platform qq --id 12345')
          return EXIT.CONFIG
        }
        const r = linkIdentity(root, uid, { platform: flags.platform, id: flags.id })
        out(r.changed ? `✓ 已绑定 ${flags.platform}:${flags.id} → ${uid}` : '· 已经绑过了，未变')
        return EXIT.OK
      }

      if (sub === 'show') {
        const uid = _[2]
        if (!uid) {
          err('用法：yuanling person show <uid> [--persona <id>]')
          return EXIT.CONFIG
        }
        const data = loadIdentities(root)
        const p = data.people[uid]
        if (!p) {
          err(`没有这个人物：${uid}`)
          return EXIT.CONFIG
        }
        out(`${p.uid}  ${p.display}`)
        for (const i of p.identities ?? []) out(`  ${i.platform}:${i.id}  ${i.state}  置信 ${i.confidence}`)
        if (pid) {
          const prof = readProfile(root, pid, uid)
          if (prof) {
            out(`  档案（${pid}）：${prof.sketch || '（无素描）'}`)
            if (prof.first_met) out(`  第一次：${String(prof.first_met).slice(0, 19)}`)
          } else {
            out(`  档案（${pid}）：还没有——说明这个角色还没跟 TA 打过交道`)
          }
        }
        return EXIT.OK
      }

      if (sub === 'profile') {
        const uid = _[2]
        if (!uid) {
          err('用法：yuanling person profile <uid> --sketch "..." [--first-meet]')
          return EXIT.CONFIG
        }
        const patch = { __reason: '手动编辑人物档案' }
        if (flags.sketch) patch.sketch = String(flags.sketch)
        if (flags.display) patch.display = String(flags.display)
        if (flags['first-meet']) patch.first_met = localIso()
        const prof = writeProfile(root, pid, uid, patch)
        out(`✓ 已更新 ${uid} 的档案（${pid}）`)
        if (prof.sketch) out(`  素描：${prof.sketch}`)
        return EXIT.OK
      }

      if (sub === 'merge') {
        const from = _[2]
        const into = _[3]
        if (!from || !into) {
          err('用法：yuanling person merge <fromUid> <intoUid>')
          return EXIT.CONFIG
        }
        const r = mergePeople(root, from, into)
        out(`✓ 已把 ${r.absorbed} 并进 ${r.uid}（原记录里保留了 merges，可追溯）`)
        return EXIT.OK
      }

      if (sub === 'split') {
        const uid = _[2]
        if (!uid || !flags.platform || !flags.id) {
          err('用法：yuanling person split <uid> --platform qq --id 12345')
          return EXIT.CONFIG
        }
        const r = splitIdentity(root, uid, flags.platform, flags.id)
        out(`✓ 已把 ${flags.platform}:${flags.id} 拆到新人物 ${r.uid}`)
        return EXIT.OK
      }

      if (sub === 'identity') {
        const uid = _[2]
        if (!uid) {
          err('用法：yuanling person identity <uid> [--text "QQ 号是 12345，b站叫老张"]')
          return EXIT.CONFIG
        }
        const text = flags.text === undefined ? null : String(flags.text)
        if (text === null) {
          const data = loadIdentities(root)
          const person = data.people[uid]
          if (!person) {
            err(`没有这个人物：${uid}`)
            return EXIT.CONFIG
          }
          out(person.identity_text || '（还没有身份描述）')
          for (const it of person.identity_parsed ?? []) out(`  解析：${it.platform}:${it.id}`)
          for (const s of person.identity_unparsed ?? []) out(`  没认出：${s}`)
          return EXIT.OK
        }
        const r = setIdentityText(root, uid, text, { autoLink: !flags['no-link'] })
        out(`✓ 已保存身份描述（解析出 ${r.parsed.items.length} 个账号）`)
        for (const it of r.parsed.items) out(`  ${it.platform}:${it.id}`)
        for (const it of r.linked) out(`  + 已绑定 ${it.platform}:${it.id}`)
        for (const c of r.conflicts) out(`  ! ${c.platform}:${c.id} 已属于 ${c.owner}，没有抢`)
        for (const s of r.parsed.unparsed) out(`  没认出：${s}`)
        return EXIT.OK
      }

      if (sub === 'weight') {
        const action = _[2]
        if (action === 'set') {
          const uid = _[3]
          const w = _[4]
          if (!uid || w === undefined) {
            err('用法：yuanling person weight set <uid> <0-100>')
            return EXIT.CONFIG
          }
          const prof = setManualWeight(root, pid, uid, Number(w))
          out(`✓ ${uid} 权重 = ${prof.weight}（手动，自动分不再覆盖）`)
          return EXIT.OK
        }
        if (action === 'auto') {
          const uid = _[3]
          if (!uid) {
            err('用法：yuanling person weight auto <uid>')
            return EXIT.CONFIG
          }
          clearManualWeight(root, pid, uid)
          out(`✓ ${uid} 已恢复自动计分（下次 refresh 重算）`)
          return EXIT.OK
        }

        const list = refreshWeights(root, pid)
        if (!list.length) out('（还没有人物档案）')
        for (const x of list) {
          const tag = x.source === 'manual' ? '手动' : '自动'
          out(`${String(x.weight).padStart(3)}  ${tag}  ${x.uid}${x.changed ? '  ·已更新' : ''}`)
        }
        return EXIT.OK
      }

      if (sub === 'candidates') {
        const list = listCandidates(root)
        if (!list.length) out('（没有待确认的候选）')
        for (let i = 0; i < list.length; i += 1) {
          const c = list[i]
          out(`#${i}  ${c.platform}:${c.id} → ${c.uid}  ${c.reason || ''}`)
        }
        if (list.length) out('\n确认：yuanling person confirm <n>   拒绝：yuanling person reject <n>')
        return EXIT.OK
      }

      if (sub === 'confirm') {
        const n = Number(_[2])
        confirmCandidate(root, n)
        out(`✓ 已确认 #${n}`)
        return EXIT.OK
      }

      if (sub === 'reject') {
        const n = Number(_[2])
        rejectCandidate(root, n)
        out(`✓ 已拒绝 #${n}`)
        return EXIT.OK
      }

      err(`未知子命令：person ${sub}`)
      return EXIT.CONFIG
    }

    if (cmd === 'group') {
      const sub = _[1]
      const marker = readMarker(root)
      const pid = flags.persona ? String(flags.persona) : marker?.active
      const gid = _[2]
      if (!gid) {
        err('用法：yuanling group show|set <群号> [--name n] [--intro s] [--tone s]')
        return EXIT.CONFIG
      }
      if (sub === 'show' || !sub) {
        const g = readGroup(root, pid, gid)
        if (!g) {
          out('（这个群还没有档案）')
          return EXIT.OK
        }
        out(`${g.name || g.gid}  ${g.intro || ''}`)
        if (g.tone) out(`  语气：${g.tone}`)
        return EXIT.OK
      }
      if (sub === 'set') {
        const patch = { __reason: '手动编辑群档案' }
        if (flags.name) patch.name = String(flags.name)
        if (flags.intro) patch.intro = String(flags.intro)
        if (flags.tone) patch.tone = String(flags.tone)
        const g = writeGroup(root, pid, gid, patch)
        out(`✓ 已更新群 ${gid} 的档案（${pid}）：${g.name || ''}`)
        return EXIT.OK
      }
      err(`未知子命令：group ${sub}`)
      return EXIT.CONFIG
    }

    if (cmd === 'catchup') {
      const marker = readMarker(root)
      const pid = flags.persona ? String(flags.persona) : marker?.active
      const before = catchUpStatus(root, pid)
      const r = catchUp(root, pid, { limit: Number(flags.limit ?? 200) })
      out(`切入补跑：处理 ${r.processed} 条，剩余 ${r.remaining} 条${r.done ? '（已追平）' : ''}`)
      out(`  补跑前待处理 ${before.pending} 条；游标 ${r.tail ?? '（空）'}`)
      return EXIT.OK
    }

    if (cmd === 'rule') {
      const sub = _[1]
      const marker = readMarker(root)
      const pid = flags.persona ? String(flags.persona) : marker?.active
      const channel = flags.channel ? String(flags.channel) : null

      if (sub === 'show' || !sub) {
        const { rules, sources, missing } = loadEffectiveRules(root, pid, { channel })
        out(JSON.stringify(rules, null, 2))
        out('')
        out(`来源：${sources.length ? sources.join(' → ') : '（无规则文件，全部取默认）'}`)
        if (missing.length) out(`未命中：${missing.join('、')}`)
        if (channel) out(`频道：${channel}`)
        return EXIT.OK
      }

      if (sub === 'check') {
        const action = _[2]
        if (!action) {
          err('用法：yuanling rule check <proactive|send|recall|evolve> [--channel group:123]')
          return EXIT.CONFIG
        }
        const { rules } = loadEffectiveRules(root, pid, { channel })
        const r = checkAction(rules, action, { channel })
        out(r.allowed ? `✓ 允许 ${action}` : `✗ 拒绝 ${action}：${r.reason}`)
        if (channel) out(`  频道 ${channel}`)
        return r.allowed ? EXIT.OK : EXIT.INTEGRITY
      }

      if (sub === 'guardrails') {
        out(JSON.stringify(loadGuardrails(root), null, 2))
        return EXIT.OK
      }

      if (sub === 'refusals') {
        const list = recentRefusals(root, { limit: Number(flags.limit ?? 20) })
        if (!list.length) out('（还没有任何拒绝记录）')
        for (const r of list) out(`${r.ts}  ${r.dim}/${r.action}  ${r.channel ?? '-'}  ${r.reason}`)
        return EXIT.OK
      }

      err(`未知子命令：rule ${sub}`)
      return EXIT.CONFIG
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
