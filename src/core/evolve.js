// src/core/evolve.js —— 把"记忆 → 提案 → 表达层"这条传动轴接上。
//
// 两个动作，都是**每人格各跑一遍**（规则是按人格存的：auto_adopt / auto_approve_days /
// daily_auto_limit 各人格可以不一样）：
//   · scan()  从重复记忆里长出新提案（只产申请单，不改任何东西）
//   · sweep() 把过了 auto_approve_days 还没人理的提案自动采纳 → 写表达层
//
// 纪律：
//   ① 只读记忆、只写提案与表达层；绝不碰 SELF.md（骨架只有人能改）。
//   ② 任何人格失败都不影响别人格，也不影响插件本身。
//   ③ 每次跑都留一条事件，否则"它到底跑没跑"没法查。
//   ④ 采纳仍受 sweep 自己的闸门约束（auto_adopt=false 就整天不动；一天最多 daily_auto_limit 条）。
import { readMarker } from './persona.js'
import { scan, sweep, mayEvolve } from './proposals.js'
import { appendEvent } from './events.js'
import { localIso } from './fsx.js'

/** 默认多久跑一次（小时）。配置里可以改。 */
export const EVOLVE_EVERY_HOURS = 6
/** 启动后延迟多久第一次跑：别和启动抢资源。 */
export const EVOLVE_FIRST_DELAY_MS = 15_000

/**
 * 跑一轮：对每个已注册人格 scan + sweep。
 *
 * @returns {{
 *   ok:boolean, at:string, reason?:string,
 *   personas:Array<{pid:string, created:string[], approved:string[], skipped:string|null, error:string|null}>,
 *   created:number, approved:number
 * }}
 */
export function evolveOnce(root, { now = Date.now() } = {}) {
  const marker = readMarker(root)
  if (!marker) return { ok: false, at: localIso(new Date(now)), reason: 'no-marker', personas: [], created: 0, approved: 0 }

  const iso = localIso(new Date(now))
  const personas = []

  for (const entry of marker.personas ?? []) {
    const pid = String(entry.id ?? '')
    if (!pid) continue
    const row = { pid, created: [], approved: [], skipped: null, error: null }

    try {
      // 「允许演化」= 真的闸门：关掉就整天不扫描（sweep 仍然跑——
      // 已经存在的提案该到期还是到期，否则关掉演化会把她积压的申请单永远冻住）
      if (!mayEvolve(root, pid)) {
        row.skipped = 'evolve=false'
      } else {
        const created = scan(root, pid, { now: iso })
        row.created = (created ?? []).map((p) => p?.id ?? String(p))
      }
    } catch (err) {
      row.error = `scan: ${String(err?.message ?? err)}`
    }

    try {
      const r = sweep(root, pid, { now: iso })
      row.approved = r?.approved ?? []
      // 只有前面没写过跳过原因时才记 sweep 的（别把 evolve=false 冲掉）
      if (!row.skipped && r?.skipped) row.skipped = r.skipped
    } catch (err) {
      row.error = row.error ? `${row.error}；sweep: ${String(err?.message ?? err)}` : `sweep: ${String(err?.message ?? err)}`
    }

    personas.push(row)
  }

  const created = personas.reduce((n, p) => n + p.created.length, 0)
  const approved = personas.reduce((n, p) => n + p.approved.length, 0)

  // 只在真的发生了什么时写事件：每 6 小时一条"什么都没发生"会淹掉日志。
  // 但"跑过"这件事本身要能查——所以 error 也写。
  const errored = personas.filter((p) => p.error)
  if (created || approved || errored.length) {
    try {
      appendEvent(root, {
        kind: 'proposal.evolve',
        level: errored.length ? 'warn' : 'info',
        actor: 'core',
        text:
          `自动演化：新提案 ${created} 条，自动采纳 ${approved} 条` +
          (errored.length ? `；${errored.length} 个人格出错` : ''),
        data: { at: iso, created, approved, personas },
      })
    } catch {
      /* 事件写不进去不该让演化失败 */
    }
  }

  return { ok: true, at: iso, personas, created, approved }
}

/**
 * 起一个定时器，按固定间隔跑 evolveOnce。
 *
 * 返回 `stop()`；调用方（插件）要在 dispose 时停掉，否则宿主关了它还在跑。
 * 用 `unref()`：定时器不该把进程钉住（DSH 关停时会等不到退出）。
 */
export function startEvolution(root, { everyHours = EVOLVE_EVERY_HOURS, firstDelayMs = EVOLVE_FIRST_DELAY_MS, onRun = null } = {}) {
  // 0 = 关掉自动跑（用户可能只想手动点「扫描新提案」）
  if (Number(everyHours) <= 0) {
    return { stop() {}, runNow() {}, disabled: true }
  }
  const everyMs = Math.max(10 * 60_000, Number(everyHours || EVOLVE_EVERY_HOURS) * 3_600_000)
  let stopped = false
  let timer = null

  const run = () => {
    if (stopped) return
    let result = null
    try {
      result = evolveOnce(root)
    } catch (err) {
      result = { ok: false, reason: String(err?.message ?? err), personas: [], created: 0, approved: 0 }
    }
    try {
      onRun?.(result)
    } catch {
      /* 回调出错不影响下一轮 */
    }
  }

  const first = setTimeout(() => {
    run()
    timer = setInterval(run, everyMs)
    timer.unref?.()
  }, Math.max(0, Number(firstDelayMs) || 0))
  first.unref?.()

  return {
    stop() {
      stopped = true
      clearTimeout(first)
      if (timer) clearInterval(timer)
    },
    runNow: run,
  }
}
