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

import z from '@deepseek-ai/schemastery'
import { resolveRoot, validateRoot } from './src/core/paths.js'
import { scaffold } from './src/core/scaffold.js'
import { readMarker } from './src/core/persona.js'
import { checkFormat } from './src/core/manifest.js'
import { exists, localIso } from './src/core/fsx.js'

export const name = 'yuanling'

/** P9 起会加 tools / systemPrompt；现在只依赖宿主配置。 */
export const inject = []

const LOOPBACK = new Set(['127.0.0.1', 'localhost', '::1'])

export const Config = z.object({
  enabled: z.boolean().default(true).description('总开关。关闭后不写盘、不启动服务，数据原样保留。'),
  dataDir: z
    .string()
    .default('')
    .description('数据目录的绝对路径，例如 D:\\yuanling。留空则用 ~/.dsh/yuanling。'),
  consoleEnabled: z.boolean().default(true).description('是否启动管理台（http://127.0.0.1:<端口>）。'),
  consoleHost: z.string().default('127.0.0.1').description('监听地址。默认只允许回环；改成 0.0.0.0 必须同时打开 allowRemote。'),
  consolePort: z.number().default(17777).description('管理台端口（0 = 随机）。改动需重启。'),
  allowRemote: z.boolean().default(false).description('允许管理台监听非回环地址。打开前先想清楚：这是你的私人记忆。'),
  preset: z.boolean().default(true).description('是否注册 agent preset「yuanling」。'),
  logLevel: z.string().default('info').description('debug | info | warn | error'),
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
export function apply(ctx, config) {
  if (!config.enabled) {
    log('info', config, '已禁用（enabled=false），不写盘、不启动服务')
    return
  }

  const { root, source } = resolveRoot({ env: process.env, config })

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

  const marker = readMarker(root)
  log(
    'info',
    config,
    `就绪：root=${root}（${source}） active=${marker?.active ?? '无'} personas=${marker?.personas?.length ?? 0}`,
  )

  // ── 管理台 ────────────────────────────────────────────────────────────
  if (!config.consoleEnabled) {
    log('info', config, '管理台未启用（consoleEnabled=false）')
    return
  }

  const host = String(config.consoleHost || '127.0.0.1').trim()
  if (!LOOPBACK.has(host) && !config.allowRemote) {
    log(
      'error',
      config,
      `拒绝监听 ${host}：管理台默认只允许回环地址。确实要暴露，请同时打开 allowRemote。`,
    )
    return
  }
  if (!LOOPBACK.has(host)) {
    log('warn', config, `管理台正在监听 ${host}——它会暴露你的私人记忆，确认这是你要的`)
  }

  let server = null
  import('./src/core/server.js')
    .then(({ listen }) => listen(root, { port: Number(config.consolePort) || 0, host }))
    .then((started) => {
      server = started.server
      log('info', config, `管理台：${started.url}`)
    })
    .catch((err) => {
      log('error', config, `管理台启动失败：${err?.message ?? err}（端口被占？换个 consolePort）`)
    })

  // 插件卸载时把服务关掉，不留孤儿进程
  if (typeof ctx?.on === 'function') {
    ctx.on('dispose', () => {
      try {
        server?.close()
      } catch {
        /* ignore */
      }
    })
  }
}
