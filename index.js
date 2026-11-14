// index.js —— DSH 插件入口。
//
// 这个文件就是「插件」。src/core/** 是它调用的库，bin/ 是给人和脚本用的运维入口。
// 三者是同一份代码：CLI 调的是库，apply() 调的也是库。
//
// 职责：
//   ① 声明配置项（宿主按 schema 渲染，我们不写 UI）
//   ② 解析 root（四级），校验，失败即报错（不静默回落）
//   ③ 按配置决定是否起管理台服务（回环）
//   ④ 把状态打到日志里，方便排障

import { createRequire } from 'node:module'
import { execFile } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { resolveRoot, validateRoot } from './src/core/paths.js'
import { scaffold } from './src/core/scaffold.js'
import { readMarker, reconcilePersonas } from './src/core/persona.js'
import { checkFormat } from './src/core/manifest.js'
import { exists, localIso } from './src/core/fsx.js'
import { listEntries } from './src/core/memory.js'
import {
  API_PREFIX,
  NS,
  pickRow,
  applyPatch,
  readConsoleToken,
  folderPickerScript,
  pickPathFromStdout,
  unwrapConfigValue,
  describeConfigValue,
} from './src/core/settingsapi.js'
import { findProfiles, installMcp } from './src/core/mcpinstall.js'
import { ensurePolicy, runtimeConfig } from './src/core/policy.js'
import { startEvolution, EVOLVE_EVERY_HOURS } from './src/core/evolve.js'
import { startProactive, PROACTIVE_EVERY_MINUTES } from './src/core/proactive.js'
import { bindConsoleRoot, createConsoleChat, ensureConsoleMaster } from './src/core/console.js'

// ⚠️ 不能用 `import z from '@deepseek-ai/schemastery'`：
//    这个包只发布了 lib/index.cjs，package.json 的 import 条件指向不存在的
//    lib/index.mjs，纯 ESM import 会直接抛模块解析错误——而宿主只会报
//    "dsh-yuanling: import failed"，看不出根因。
//    必须用 createRequire 走 CJS 入口（surfcore 的 qq-mode.js 也踩过同一个坑）。
const require = createRequire(import.meta.url)
const z = require('@deepseek-ai/schemastery')

// 必须和包名、cordis.patch.yml 里的 id 一致：宿主按 id 去重，三处不一致会被当成
// 两个插件实例（客户端 bundle 会执行两次，直接把 Web 启动搞挂）。
export const name = 'dsh-yuanling'

/** 设置页要挂在宿主的 webServer 上，所以必须声明依赖。 */
export const inject = ['webServer']

const LOOPBACK = new Set(['127.0.0.1', 'localhost', '::1'])

export const Config = z.object({
  // ⚠️ `volatile` 不是装饰，是硬要求：DSH 的 settings.update 拒绝写入
  //    「entry 里没有任何 volatile 字段」的插件
  //    （报 Plugin entry "dsh-yuanling" has no volatile fields）。
  //    只有标了 volatile 的字段才允许在运行时热改——设置页能改的就是这两个。
  enabled: z
    .boolean()
    .default(true)
    .description('总开关。关闭后不写盘、不启动服务，数据原样保留。')
    .extra('volatile', true),
  dataDir: z
    .string()
    .default('')
    .description('数据目录的绝对路径，例如 D:\\yuanling。留空则用 ~/.dsh/yuanling。')
    .extra('volatile', true),
  consoleEnabled: z.boolean().default(true).description('管理台：是否启动原灵管理台。关闭后不启动服务，数据原样保留。'),
  consoleHost: z
    .string()
    .default('127.0.0.1')
    .description('管理台：监听地址。默认 127.0.0.1（只有本机能访问）。只有打开下面的「允许同一局域网内的其他设备访问」后，才允许填 127.0.0.1 之外的地址。'),
  consolePort: z.number().default(17777).description('管理台：端口（0 = 随机）。改动后需要重启 DSH。'),
  allowRemote: z
    .boolean()
    .default(false)
    .description('允许同一局域网内的其他设备访问。只有勾选后，监听地址才可以填 127.0.0.1 之外的地址；管理台含私人记忆，请确认局域网可信。'),
  autoApproveDays: z
    .number()
    .default(3)
    .description('**兜底默认值**：提案等几天自动采纳。人格规则（人格 → 规则）写了就以那边为准。'),
  dailyAutoLimit: z
    .number()
    .default(1)
    .description('**兜底默认值**：每天最多自动采纳几条。人格规则写了就以那边为准。'),
  evolveEveryHours: z
    .number()
    .default(EVOLVE_EVERY_HOURS)
    .description('**初值**：演化扫描周期（小时；0 = 关闭）。真值见 system/policy.json。'),
  proactiveEveryMinutes: z
    .number()
    .default(PROACTIVE_EVERY_MINUTES)
    .description('**初值**：主动开口周期（分钟；0 = 关闭）。真值见 system/policy.json。'),
  logLevel: z.string().default('info').description('**初值**：debug | info | warn | error。真值见 system/policy.json。'),
})

function log(level, cfg, ...args) {
  const order = { debug: 10, info: 20, warn: 30, error: 40 }
  if ((order[level] ?? 20) < (order[cfg?.logLevel] ?? 20)) return
  const tag = `[yuanling:${level}]`
  if (level === 'error') console.error(tag, ...args)
  else if (level === 'warn') console.warn(tag, ...args)
  else console.log(tag, ...args)
}

/**
 * @param {import('@deepseek-ai/cordis').Context} ctx
 */
function sendJson(res, status, body) {
  try {
    res.statusCode = status
    res.setHeader('content-type', 'application/json; charset=utf-8')
    res.end(JSON.stringify(body))
  } catch {
    res.statusCode = 500
    res.end('{}')
  }
}

function readBody(req, limit = 256 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks = []
    req.on('data', (c) => {
      size += c.length
      if (size > limit) {
        reject(new Error('请求体太大'))
        req.destroy()
        return
      }
      chunks.push(c)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

/** 改数据目录时同步 MCP 条目的 --root（幂等、有备份）。 */
function syncMcpRoot(dir) {
  const target = findProfiles()[0]
  if (!target) return { changed: false, skipped: 'no-profile' }
  try {
    const r = installMcp({ patchPath: target.patchPath, dataRoot: dir })
    return { changed: r.changed, patchPath: target.patchPath, backup: r.backup }
  } catch (error) {
    return { changed: false, error: String(error?.message ?? error) }
  }
}

function statusOf(root, consoleUrl) {
  const out = { root, rootOk: false, rootError: '', active: '', facts: 0, consoleUrl }
  try {
    if (!exists(root)) {
      out.rootError = '目录不存在（原灵不会自动创建它）'
      return out
    }
    const check = validateRoot(root)
    if (!check.ok) {
      const first = check.errors?.[0]
      out.rootError = `${first?.code ?? ''} ${first?.message ?? ''}`.trim()
      return out
    }
    out.rootOk = true
    const marker = readMarker(root)
    out.active = marker?.active ?? ''
    if (out.active) {
      try {
        out.facts = listEntries(root, out.active).reduce((n, e) => n + (e.facts?.length ?? 0), 0)
      } catch {
        out.facts = 0
      }
    }
  } catch (error) {
    out.rootError = String(error?.message ?? error)
  }
  return out
}

/** 设置页的同源 API：GET 读配置，POST 写配置（客户端拿不到 settings 服务，只能走这里）。 */
function registerSettingsApi(ctx, config, state) {
  const webServer = ctx?.webServer
  if (!webServer?.register) {
    log('warn', config, '宿主没有 webServer，设置页不可用')
    return
  }

  const handler = async (req, res) => {
    try {
      const conn = ctx.get?.('connection')
      if (conn && typeof conn.requestRejection === 'function') {
        const code = conn.requestRejection(req)
        if (code !== undefined && code !== null && code !== false) {
          res.statusCode = typeof code === 'number' ? code : 403
          res.end()
          return
        }
      }

      const settings = ctx.get?.('settings')
      const rows = typeof settings?.describe === 'function' ? settings.describe({ redactSecrets: true }) : []
      const row = pickRow(rows)
      const rawLive = row?.value ?? config
      // 同上：设置页读出来的值也可能被包过一层
      const live = { ...(rawLive ?? {}), dataDir: unwrapConfigValue(rawLive?.dataDir) }
      const url = new URL(String(req.url ?? '/'), 'http://localhost')

      // 一键复制令牌：只在这条同源路由上给出（已过 requestRejection，且只本机可访问）
      if (url.searchParams.get('token') === '1') {
        const { root: tokenRoot } = resolveRoot({ env: process.env, config: live })
        const token = readConsoleToken(tokenRoot)
        sendJson(
          res,
          token ? 200 : 404,
          token ? { ok: true, token } : { ok: false, error: '还没有令牌：先 yuanling init，或 yuanling token --reset' },
        )
        return
      }

      // 原生「选择目录」：浏览器拿不到绝对路径，只能由宿主进程弹 Windows 对话框
      if (url.searchParams.get('browse') === 'dir') {
        if (process.platform !== 'win32') {
          sendJson(res, 200, { ok: false, error: '只有 Windows 支持原生选择框，请手动填路径' })
          return
        }
        await new Promise((resolve) => {
          const child = execFile(
            'powershell.exe',
            ['-STA', '-NoProfile', '-Command', folderPickerScript()],
            { windowsHide: true, timeout: 180_000 },
            (error, stdout) => {
              const picked = pickPathFromStdout(stdout)
              if (error && !picked) sendJson(res, 200, { ok: false, error: `选择框打不开：${String(error.message ?? error).slice(0, 160)}` })
              else if (!picked) sendJson(res, 200, { ok: false, cancelled: true })
              else sendJson(res, 200, { ok: true, path: picked })
              resolve()
            },
          )
          child.on('error', () => {
            sendJson(res, 200, { ok: false, error: '无法启动 PowerShell（可能不在本机桌面）' })
            resolve()
          })
        })
        return
      }

      // 客户端探针已移除（2026-11-08）。
      // 曾经在这里把设置页 apply() 的调用落盘到 system/log/client.log，用来排查
      // "客户端到底跑没跑"——问题定位后它只剩副作用（每次打开设置页多两次 POST
      // 加一次写文件），所以删掉了。要再诊断，直接看 /root 的 meta 与浏览器报错。

      if (req.method === 'GET') {
        const { root } = resolveRoot({ env: process.env, config: live })
        sendJson(res, 200, {
          ok: true,
          config: {
            enabled: live?.enabled !== false,
            dataDir: live?.dataDir ?? '',
            consoleEnabled: live?.consoleEnabled !== false,
            consoleHost: String(live?.consoleHost ?? '127.0.0.1'),
            consolePort: Number(live?.consolePort ?? 17777),
            allowRemote: live?.allowRemote === true,
          },
          status: statusOf(root, state.consoleUrl),
        })
        return
      }

      if (req.method !== 'POST') {
        sendJson(res, 405, { ok: false, error: '只支持 GET / POST' })
        return
      }
      if (!String(req.headers['content-type'] ?? '').toLowerCase().includes('application/json')) {
        sendJson(res, 415, { ok: false, error: '写操作必须是 application/json' })
        return
      }

      const raw = await readBody(req)
      const body = raw ? JSON.parse(raw) : {}
      const r = await applyPatch({
        settings,
        body,
        current: live,
        // 写回时用实际命中的 ns：早期版本 id 是 `yuanling`，老 profile 里可能还留着
        ns: row?.ns ?? NS,
        validate: (dir) => validateRoot(dir),
        syncMcp: (dir) => syncMcpRoot(dir),
      })
      sendJson(res, 200, { ok: true, ...r })
    } catch (error) {
      sendJson(res, error?.status ?? 500, { ok: false, error: String(error?.message ?? error) })
    }
  }

  try {
    webServer.register({ kind: 'prefix', path: API_PREFIX, handler })
  } catch (error) {
    log('error', config, `注册设置页 API 失败：${error?.message ?? error}`)
  }
}

export function apply(ctx, config) {
  const state = { consoleUrl: '' }

  // 设置页的 API 必须**先挂上**，即便当前 enabled=false——
  // 否则用户在设置页关掉之后，就再也没有入口把它打开。
  registerSettingsApi(ctx, config, state)

  if (!config.enabled) {
    log('info', config, '已禁用（enabled=false），不写盘、不启动服务')
    return
  }

  // 宿主会把"被设置页改过"的字段包成惰性访问器（{ get: fn }），先解包再解析路径。
  // 不解包的后果：dataDir 变成 "[object Object]" / "" → 回落默认目录 →
  // 管理台换了另一份 console.token → 用户永远看到"令牌不匹配"。
  //
  // 双保险：优先用 settings 服务里的真值——那条路一直是好的（设置页能显示数据就是证据），
  // 而 apply() 收到的 config 可能是包装过的。
  const fromConfig = unwrapConfigValue(config?.dataDir)
  let fromSettings = ''
  try {
    const settingsSvc = ctx.get?.('settings')
    const rowsNow = typeof settingsSvc?.describe === 'function' ? settingsSvc.describe({ redactSecrets: true }) : []
    fromSettings = unwrapConfigValue(pickRow(rowsNow)?.value?.dataDir)
  } catch {
    /* settings 服务不可用就只用 config */
  }
  const cfg = { ...config, dataDir: fromSettings || fromConfig }
  const { root, source } = resolveRoot({ env: process.env, config: cfg })

  // 目录不存在时：
  //   · 走默认路径 → 可以自动建（首次运行的正常路径）
  //   · 显式指定（cli/env/config）→ 拒绝，绝不自动新建
  if (!exists(root)) {
    if (source === 'default') {
      try {
        scaffold(root, { personaId: 'yuanling', name: '原灵', now: localIso() })
        log('info', config, `首次运行，已在 ${root} 建立数据目录骨架`)
      } catch (err) {
        log('error', config, `初始化数据目录失败：${err?.message ?? err}`)
        return
      }
    } else {
      log(
        'error',
        config,
        `数据目录不存在：${root}（来源：${source}）。原灵不会自动创建它——请检查盘符是否插好，或先跑 yuanling init --root "${root}"。`,
      )
      return
    }
  }

  const check = validateRoot(root)
  if (!check.ok) {
    for (const e of check.errors) log('error', config, `${e.code}: ${e.message}`)
    return
  }
  for (const w of check.warnings) log('warn', config, `${w.code}: ${w.message}`)
  for (const s of check.skips) log('info', config, `skip ${s.id}: ${s.reason}`)

  const fmt = checkFormat(root)
  if (!fmt.ok) {
    for (const e of fmt.errors) log('error', config, `${e.code}: ${e.message}`)
    return
  }

  // 迁移靠「复制粘贴 personas/<id>/」，所以启动时先把目录里有、登记里没有的人格认领回来
  reconcilePersonas(root)
  const marker = readMarker(root)

  // 控制台专用人物卡：每个激活人格一张，app=dsh / account=master。
  // 固定 id 让它在新环境里天然是最小卡；旧数据里若已有更小 id，合并逻辑会优先保留它为主卡。
  bindConsoleRoot(root)
  for (const p of marker?.personas ?? []) {
    try {
      ensureConsoleMaster(root, p.id)
    } catch (err) {
      log('warn', config, `控制台人物卡初始化失败（${p.id}）：${err?.message ?? err}`)
    }
  }
  const consoleChat = createConsoleChat(ctx)

  // 运行设置的唯一真值在数据目录里（system/policy.json）：
  // DSH 设置页只在**没有这个文件**时提供初值；之后以数据目录为准，谁都不覆盖它。
  // 这样"复制数据目录到新机器"才算真的迁移——见 README 第一条。
  const policy = ensurePolicy(root, config)
  // 从这里开始，所有 config.xxx 读到的都是**真值**：policy 赢，DSH 设置页只是初值
  const rc = runtimeConfig(config, policy)
  config = { ...rc }

  log(
    'info',
    rc,
    `就绪：root=${root}（${source}） active=${marker?.active ?? '无'} personas=${marker?.personas?.length ?? 0}`,
  )

  // ── 管理台 ────────────────────────────────────────────────────────────
  if (!rc.consoleEnabled) {
    log('info', rc, '管理台未启用（consoleEnabled=false）')
    return
  }

  const host = String(rc.consoleHost || '127.0.0.1').trim()
  if (!LOOPBACK.has(host) && !rc.allowRemote) {
    log(
      'error',
      rc,
      `拒绝监听 ${host}：管理台默认只允许回环地址。确实要暴露，请同时打开 allowRemote。`,
    )
    return
  }
  if (!LOOPBACK.has(host)) {
    log('warn', rc, `管理台正在监听 ${host}——它会暴露你的私人记忆，确认这是你要的`)
  }

  // 关停有两个坑，都会让宿主等到 `graceful deadline exceeded`（更新失败）：
  //   ① `server.close()` 不销毁**已建立**的 keep-alive 连接——浏览器里开过管理台，
  //      那条 socket 会让事件循环一直活着，进程永远不退出。
  //   ② 动态 import 是异步的：dispose 可能先发生，那时 server 还是 null，
  //      等 import 回来又把服务启起来——关停之后才启动，再也没人关它。
  let server = null
  let closeServer = null
  let disposed = false

  const started = import('./src/core/server.js')
    .then((mod) => {
      closeServer = mod.closeServer
      return mod.listen(root, {
        port: Number(rc.consolePort) || 0,
        host,
        // 关键：插件跑在 DSH 宿主进程里，监听句柄不能钉住宿主的事件循环。
        // 只靠 dispose 不够——宿主关停时可能根本不会调我们的 dispose，
        // 那样更新会卡在 `graceful deadline exceeded`（管理台开着时必现）。
        unref: true,
        // v1.1：模型工具（跑在 mcp-server 进程）通过这条路由向模块要数据。
        // 模块进程只活在**这个**进程里，所以回调必须由这里注入，api.js 拿不到。
        onSourceFetch: async (payload) => {
          if (!modules) {
            throw Object.assign(new Error('模块宿主还没起来（插件刚启动或启动失败）'), { code: 'E_NO_ROUTE' })
          }
          return modules.fetchSource(payload)
        },
        // 装/授/启用之后顺手拉起它：模块进程只活在插件启动那一刻被拉起，
        // 用户在页面里装完时那个时机早过去了（页面显示"已停止"，日志都没有）。
        // 装/授/启用之后顺手拉起它：模块进程只活在插件启动那一刻被拉起，
        // 用户在页面里装完时那个时机早过去了（页面显示"已停止"，日志都没有）。
        onModuleChanged: async (id, opts = {}) => {
          if (!modules) return { skipped: 'no-host' }
          // 停用要真的停进程。只写注册表的话模块会一直跑着，页面看起来"没反应"。
          if (opts.enabled === false) return { stopped: (await modules.stop(id)).stopped }
          // 配置变更要重启：停掉再用新配置 spawn（协议 §3.1）
          return opts.restart ? modules.restart(id) : modules.start(id)
        },
        // v1.2：模块自定义 tab 只读数据（协议 ui.get）
        onUiGet: async (id, tab) => {
          if (!modules) {
            throw Object.assign(new Error('模块宿主还没起来'), { code: 'E_NO_ROUTE' })
          }
          return modules.uiGet(id, tab)
        },
        onConsoleTurn: (payload) => consoleChat.turn(payload),
        onConsoleStop: (payload) => consoleChat.stop(payload),
        onModelGet: () => consoleChat.models(),
        onModelSelect: (selection) => consoleChat.selectModel(selection),
        // 自证：/root 会把这段原样吐出来，用来排查"配置改了但进程还用旧值"
        meta: {
          source,
          dataDir: String(cfg.dataDir ?? ''),
          dataDirRaw: describeConfigValue(config?.dataDir),
          enabled: config.enabled !== false,
          envHome: process.env.YUANLING_HOME ?? null,
          pid: process.pid,
        },
      })
    })
    .then((s) => {
      // 已经进入关停流程了：起来也立刻关掉，绝不留下一个没人管的监听
      if (disposed) {
        closeServer?.(s.server)
        return
      }
      server = s.server
      state.consoleUrl = s.url
      log('info', config, `管理台：${s.url}`)
    })
    .catch((err) => {
      if (!disposed) log('error', config, `管理台启动失败：${err?.message ?? err}（端口被占？换个 consolePort）`)
    })

  // 插件卸载时把服务彻底关掉：先销毁连接，再关监听，不留孤儿 socket
  if (typeof ctx?.on === 'function') {
    ctx.on('dispose', async () => {
      disposed = true
      state.consoleUrl = ''
      try { await consoleChat.dispose() } catch { /* 会话关停不挡退出 */ }
      try {
        await started
      } catch {
        /* 启动失败就没有要关的东西 */
      }
      closeServer?.(server)

      // 模块进程也要一并停掉：它们和宿主同生共死，留着就是孤儿进程
      try {
        await modules?.stopAll()
      } catch {
        /* 关停阶段不抛 */
      }
    })
  }

  // ── 定时演化（记忆 → 提案 → 表达层）──────────────────────────────────
  // 以前 scan/sweep 只有人工触发，于是规则页里那些 auto_adopt / auto_approve_days
  // 其实是摆设。这里把它们接到定时器上：启动后先跑一次，之后每 evolveEveryHours 跑一次。
  // **只动提案与表达层，绝不碰 SELF.md**（骨架只有人能改）。
  const evolve = startEvolution(root, {
    everyHours: config.evolveEveryHours,
    onRun: (r) => {
      if (r?.created || r?.approved) {
        log('info', config, `自动演化：新提案 ${r.created} 条，自动采纳 ${r.approved} 条`)
      }
      const bad = (r?.personas ?? []).filter((p) => p.error)
      for (const p of bad) log('warn', config, `自动演化（${p.pid}）出错：${p.error}`)
    },
  })
  if (typeof ctx?.on === 'function') ctx.on('dispose', () => evolve.stop())

  // ── 主动开口（只算不发送）────────────────────────────────────────────
  // 动机 + 到期目的 + rules.action 闸门 → 待发队列；真发送留给模块。
  const proactive = startProactive(root, {
    everyMinutes: config.proactiveEveryMinutes,
    onRun: (r) => {
      if (r?.queued?.length) log('info', config, `想出 ${r.queued.length} 句主动的话（进待发队列，未发送）`)
      const reasons = r?.reasons ?? {}
      for (const [why, n] of Object.entries(reasons)) {
        if (why === 'error') log('warn', config, `主动开口计算失败：${n}`)
      }
    },
  })
  if (typeof ctx?.on === 'function') ctx.on('dispose', () => proactive.stop())

  // ── 模块 ───────────────────────────────────────────────────────────────
  // 只在宿主活着的时候拉起 enabled 的模块。**注册表里的 enabled 是持久意图**：
  // 停用过的模块即使 DSH 重启也不会自动起（用户明确要的行为）。
  startModules(ctx, config, root, marker?.active ?? null)
}

/** 启动模块服务。任何异常都不能让插件整体起不来——模块是可选能力。 */
function startModules(ctx, config, root, pid) {
  Promise.resolve()
    .then(async () => {
      const { ModuleService } = await import('./src/core/modules/service.js')
      const { moduleHandlers } = await import('./src/core/modules/wire.js')
      const { claimOutbox, ackOutbox } = await import('./src/core/proactive.js')
      const activePid = () => readMarker(root)?.active ?? pid
      const core = moduleHandlers({ root, pid })
      const svc = new ModuleService({
        root,
        pid,
        // 模块真正碰核心的四个口：收消息、提事实、取她要说的话、回报说没说出来。
        // 少接一个，模块就是"装上了但干不了活"——而且报错是"核心未配置处理器"，很难查。
        onIngest: core.onIngest,
        onPropose: core.onPropose,
        // v1.6：模块要发消息前必须先问过核心（规则 + 名单 + 配额），通过才允许投递
        onEgress: core.onEgress,
        // 协议 §13：媒体入库/出库（核心算 hash、决定存哪；模块只碰自己的临时目录）
        onMediaPut: core.onMediaPut,
        onMediaGet: core.onMediaGet,
        // v1.5：模块来取"她想说的话"，并回报说没说出来。
        // 队列由核心算（动机 + 目的 + 闸门），模块只负责投递——和 send 的分工一致。
        onOutboxFetch: ({ id: moduleId, data }) => ({
          version: 1,
          items: claimOutbox(root, activePid(), {
            limit: Number(data?.limit) || undefined,
            claimBy: moduleId,
          }),
        }),
        onOutboxAck: ({ id: moduleId, data }) =>
          ackOutbox(root, activePid(), String(data?.id ?? ''), {
            ok: data?.ok === true,
            code: data?.code ?? '',
            message: data?.message ?? '',
            claimBy: moduleId,
          }),
      })
      modules = svc

      const results = await svc.startEnabled()
      const started = results.filter((r) => r.started)
      const failed = results.filter((r) => r.error)
      if (started.length) log('info', config, `模块已启动 ${started.length} 个：${started.map((r) => r.id).join('、')}`)
      for (const f of failed) log('warn', config, `模块 ${f.id} 启动失败：${f.error}`)

      // 宿主关停时先停模块（unref 之后监听不挡退出，但子进程会）
      if (typeof ctx?.on === 'function') {
        ctx.on('dispose', async () => {
          try {
            await svc.stopAll()
          } catch {
            /* ignore */
          }
        })
      }
    })
    .catch((err) => {
      log('warn', config, `模块服务未启动：${err?.message ?? err}`)
    })
}

/** 模块服务实例（dispose 时用）。 */
let modules = null
