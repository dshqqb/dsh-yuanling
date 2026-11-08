#!/usr/bin/env node
// yuanling MCP server —— 把记忆暴露成工具，让 DSH 里的模型自己"想起来"。
//
// 为什么是 MCP 而不是插件钩子：DSH 给插件的入口只有「排队一个回合」
// （sessionController.prompt），那会把 [惦记] 变成一条"用户说的话"。
// MCP 是干净的读通道：模型按需调用，对话记录不污染。
//
// 协议：stdio + 换行分隔的 JSON-RPC 2.0（MCP 基础协议），零依赖。
// stdout 只能出协议帧；所有日志走 stderr。
import readline from 'node:readline'
import fs from 'node:fs'
import path from 'node:path'

import { resolveRoot, validateRoot, P } from './src/core/paths.js'
import { readMarker } from './src/core/persona.js'
import { contextFor, recall } from './src/core/memory.js'
import { loadIdentities, createPerson, setIdentityText } from './src/core/entities.js'
import { readGroup, writeGroup, ensureGroup, gidForChannel } from './src/core/groups.js'
import { listSources, readConsoleRuntime, renderFetched, clipText } from './src/core/modules/sources.js'

const SERVER_INFO = { name: 'yuanling', version: '0.2.0' }
const MAX_IDENTITY_TEXT = 2000

/** 数据根目录：--root 参数 > YUANLING_HOME > 默认位置。 */
function rootFromArgv(argv = process.argv.slice(2)) {
  const i = argv.indexOf('--root')
  if (i >= 0 && argv[i + 1]) return argv[i + 1]
  const eq = argv.find((a) => a.startsWith('--root='))
  return eq ? eq.slice('--root='.length) : null
}

function openRoot() {
  const { root } = resolveRoot({ cli: rootFromArgv() }) // 注意：返回 { root, source }，不是字符串
  const check = validateRoot(root)
  if (!check.ok) {
    const first = check.errors?.[0]
    throw new Error(`数据目录不可用：${first?.code ?? ''} ${first?.message ?? ''}`.trim())
  }
  return root
}

function activePersona(root) {
  const marker = readMarker(root)
  return marker?.active ?? null
}

const TOOLS = [
  {
    name: 'yuanling_context',
    description:
      '【每轮必调】读取原灵的长期记忆：记忆卡 + 惦记着的事 + 当前在场人物卡。\n' +
      '规则：每次开始新一轮对话、或对方提到过去的人/事时，**先调用本工具再开口**——不调用就等于失忆。\n' +
      '不需要对方要求，这是你的常规动作。返回纯文本，直接当作背景信息使用。',
    inputSchema: {
      type: 'object',
      properties: {
        channel: {
          type: 'string',
          description: '会话频道，如 private:10001 或 group:123456。私聊/群聊都应尽量传，这样才能带出对应的人物卡。',
        },
        participants: {
          type: 'array',
          description: '这一轮在场的人（uid 或 {platform,id}）。不传则群聊按最近发言人自动判断。',
          items: { type: ['string', 'object'] },
        },
        budget: { type: 'number', description: '字节预算，默认 8192。' },
      },
    },
  },
  {
    name: 'yuanling_recall',
    description:
      '按关键词检索原灵的长期记忆，返回命中的事实与其证据指针。\n' +
      '当需要确认某件具体的事、或想在回答里说明"我为什么记得"时调用；比 yuanling_context 更细。',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '要找的词' },
        limit: { type: 'number', description: '最多返回几条，默认 8' },
      },
      required: ['query'],
    },
  },
  {
    name: 'yuanling_person_identity',
    description:
      '把学到的身份信息写回人物档案（账号归属）。**只在对方自述、或有明确证据时调用**——别从一句玩笑里推断账号。\n' +
      'text 用自然语言写整句话（例："QQ 号是 12345，b站叫老张"），解析由核心负责；原文才是正本，解析结果只是派生。\n' +
      '已经属于别人的账号不会被抢，只会报冲突。',
    inputSchema: {
      type: 'object',
      properties: {
        uid: { type: 'string', description: '人物 id（person_xxx）。和 display 二选一，优先 uid。' },
        display: { type: 'string', description: '显示名；没有对应人物时会新建一个。' },
        text: { type: 'string', description: '自然语言身份描述，≤2000 字' },
        autoLink: { type: 'boolean', description: '是否自动绑定未被占用的账号，默认 true' },
      },
      required: ['text'],
    },
  },
  {
    name: 'yuanling_group',
    description:
      '看 / 写一个"群体"的档案：一个 QQ 群、一个贴吧、一个粉丝群，各是一个群体（**不跨平台合并**）。\n' +
      '在群里说话时，当前群体的卡已经自动出现在 yuanling_context 里；这个工具用来主动补写她的理解' +
      '（这个群是什么地方、氛围怎样、主要在聊什么），或者查一个别人刚提到的群。\n' +
      '只写自然语言描述，别编成员——成员由核心从原始层归集（谁在这个群说过话）。',
    inputSchema: {
      type: 'object',
      properties: {
        gid: { type: 'string', description: '群体 id，形如 qq:123456。不传则用 channel 对应的群。' },
        channel: { type: 'string', description: '当前会话频道，如 group:123456，用来推断是哪个群。' },
        name: { type: 'string', description: '群名（只在写入时用）' },
        feature: { type: 'string', description: '这个群是什么地方、什么氛围——自然语言，≤2000 字' },
        topics: { type: 'string', description: '这里主要在聊什么——自然语言，≤2000 字' },
        aliases: { type: 'array', items: { type: 'string' }, description: '别名/简称，最多 10 个' },
      },
    },
  },
  {
    name: 'yuanling_sources',
    description:
      '看看她**现在能主动向哪些模块要数据**（v1.1）：已装模块声明的数据来源、能查什么、要什么参数。\n' +
      '当话题需要"现查"而不是"回忆"时先看一眼这张表，再用 yuanling_fetch 查。返回纯文本。',
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'yuanling_fetch',
    description:
      '向一个模块要一次数据（比如搜 B 站视频、抓一个网页）。\n' +
      '**取回的内容会先落进原始层**，所以她下次能 recall 到——不是查完就忘。返回带来源与指针的条目。\n' +
      '一次只查一个 source，最多 20 条；别当搜索框连发，先想清楚要什么再查。',
    inputSchema: {
      type: 'object',
      properties: {
        source: { type: 'string', description: 'source id（来自 yuanling_sources，形如 bili.search_video）' },
        params: { type: 'object', description: '按该 source 声明的参数传，如 { "q": "原灵" }' },
        limit: { type: 'number', description: '最多要几条，默认与上限都是 20' },
      },
      required: ['source'],
    },
  },
]

// ── v1.1：向模块要数据 ──────────────────────────────────────────────────

/**
 * 模型工具跑在**这个进程**里，而模块进程只活在插件宿主里。
 * 所以取数要绕一圈：读 `system/console.json` 找到控制台 → 带 token POST。
 * 找不到控制台就如实报"没在运行"，不假装"没有数据"。
 */
async function consoleCall(root, { method = 'GET', pathname, body = null }) {
  const rt = readConsoleRuntime(root)
  if (!rt) {
    throw new Error('控制台没在运行——取数要靠它跟模块说话。确认原灵插件在 DSH 里启用着。')
  }
  const tokenFile = path.join(root, P.consoleToken)
  if (!fs.existsSync(tokenFile)) throw new Error('找不到 system/secrets/console.token，先跑 yuanling init')
  const token = fs.readFileSync(tokenFile, 'utf8').trim()

  const ac = new AbortController()
  const timer = setTimeout(() => ac.abort(), 40_000)
  try {
    const res = await fetch(new URL(pathname, rt.url), {
      method,
      headers: { 'content-type': 'application/json', 'x-yuanling-token': token },
      body: body ? JSON.stringify(body) : undefined,
      signal: ac.signal,
    })
    const data = await res.json().catch(() => ({}))
    if (!res.ok || data.ok === false) {
      throw new Error(data.error ?? `控制台返回 ${res.status}`)
    }
    return data
  } catch (error) {
    if (error?.name === 'AbortError') throw new Error('模块超时没回（40s）——它可能在等网络，也可能卡住了')
    // 端口不对/进程已经死了：给一句人话，别把 ECONNREFUSED 甩给模型
    if (/fetch failed|ECONNREFUSED|EHOSTUNREACH/i.test(String(error?.message ?? ''))) {
      throw new Error('连不上控制台（它可能已经退出，只是留下了旧的 system/console.json）')
    }
    throw error
  } finally {
    clearTimeout(timer)
  }
}

function formatSources(list) {
  if (!list.length) {
    return (
      '没有可用的数据来源。\n' +
      '（要么没装带 sources 的模块，要么模块没被授予 provide.source——前者去装，后者去管理台点「全部授予」。）'
    )
  }
  const lines = ['可主动取数的来源：']
  for (const m of list) {
    const st = !m.enabled ? '已停用' : m.state === 'ready' || m.state === 'running' ? '运行中' : `状态 ${m.state}`
    const cap = m.granted ? '已授权' : '**未授权，现在取不到**'
    lines.push(`▸ 模块 ${m.module}（${m.moduleName}）· ${st} · ${cap}`)
    for (const s of m.sources) {
      const params = s.params?.properties
        ? Object.entries(s.params.properties)
            .map(([k, v]) => `${k}(${v.type}${(s.params.required ?? []).includes(k) ? '，必填' : ''})`)
            .join(' ')
        : '无参数'
      lines.push(`  - ${s.id}  「${s.title}」  参数：${params}`)
    }
  }
  lines.push('')
  lines.push('要用哪个就调 yuanling_fetch {source, params}。取回的内容会先落进原始层——所以她以后记得，不是白查一趟。')
  return lines.join('\n')
}

function formatFacts(rows) {
  if (!rows.length) return '（没有命中）'
  // recall 返回的是 { topic, fact, retention, band, ... }：正文和指针都在 fact 里
  return rows
    .map((r, i) => `${i + 1}. 〔${r.topic}〕${r.fact?.text ?? ''}\n   证据：${r.fact?.src ?? ''}`)
    .join('\n')
}

function formatIdentityResult(uid, display, r) {
  const lines = [`✓ 已写入 ${display ?? uid}（${uid}）的身份描述`]
  if (r.parsed.items.length) lines.push(`识别：${r.parsed.items.map((x) => `${x.platform}:${x.id}`).join('、')}`)
  if (r.linked.length) lines.push(`新绑定：${r.linked.map((x) => `${x.platform}:${x.id}`).join('、')}`)
  for (const c of r.conflicts) lines.push(`冲突：${c.platform}:${c.id} 已属于 ${c.owner}，没有抢`)
  if (r.parsed.unparsed.length) lines.push(`没认出：${r.parsed.unparsed.join(' / ')}`)
  if (!r.parsed.items.length) lines.push('（这段话里没识别出账号）')
  return lines.join('\n')
}

/** 群体的 id：显式 gid 优先，其次从频道推（group:123 → qq:123）。推不出来就返回空。 */
function resolveGroupGid(args) {
  const raw = String(args.gid ?? '').trim()
  if (raw) return raw.includes(':') ? raw : `qq:${raw}`
  const ch = String(args.channel ?? '').trim()
  if (ch) return gidForChannel(ch) ?? ''
  return ''
}

function formatGroupDetail(root, pid, g) {
  const people = loadIdentities(root).people ?? {}
  const lines = [`${g.name || '（未命名）'}  ${g.gid}`]
  lines.push(`权重 ${g.weight}（${g.weightSource === 'manual' ? '手动' : '自动'}）${g.tier === 'important' ? '  〔重要群体〕' : ''}`)
  if (g.feature) lines.push(`特征：${g.feature}`)
  if (g.topics) lines.push(`话题：${g.topics}`)
  if (g.members.length) {
    const names = g.members.slice(0, 10).map((uid) => people[uid]?.display ?? uid)
    lines.push(`常出现的人（${g.memberCount}）：${names.join('、')}${g.members.length > 10 ? ' …' : ''}`)
  } else {
    lines.push('常出现的人：还没归集（管理台点「重新归集成员」，或 yuanling group members）')
  }
  if (g.lastSeen) lines.push(`最后一次见到：${g.lastSeen}`)
  return lines.join('\n')
}

async function callTool(root, name, args = {}) {
  const pid = activePersona(root)
  if (!pid) throw new Error('还没有激活的人格')

  if (name === 'yuanling_context') {
    const text = contextFor(root, pid, {
      channel: args.channel ?? null,
      participants: Array.isArray(args.participants) ? args.participants : null,
      budget: Number(args.budget) > 0 ? Number(args.budget) : undefined,
    })
    const bytes = Buffer.byteLength(text, 'utf8')
    return { text, bytes }
  }

  if (name === 'yuanling_recall') {
    const query = String(args.query ?? '').trim()
    if (!query) throw new Error('缺少 query')
    const limit = Math.max(1, Math.min(50, Number(args.limit) || 8))
    const rows = recall(root, pid, query, { limit })
    return { text: formatFacts(rows), count: rows.length }
  }

  if (name === 'yuanling_person_identity') {
    const text = String(args.text ?? '').trim()
    if (!text) throw new Error('缺少 text（用一句自然语言写清楚账号）')
    if (text.length > MAX_IDENTITY_TEXT) throw new Error(`身份描述太长（≤${MAX_IDENTITY_TEXT} 字）`)

    let uid = String(args.uid ?? '').trim() || null
    let display = null
    if (!uid && args.display) {
      display = String(args.display).trim()
      const hit = Object.values(loadIdentities(root).people ?? {}).find((p) => p.display === display)
      uid = hit ? hit.uid : createPerson(root, { display }).uid
    }
    if (!uid) throw new Error('需要 uid 或 display')

    const data = loadIdentities(root)
    if (!data.people?.[uid]) throw new Error(`人物不存在：${uid}`)
    display = display ?? data.people[uid].display ?? uid

    const r = setIdentityText(root, uid, text, { autoLink: args.autoLink !== false })
    return { text: formatIdentityResult(uid, display, r), linked: r.linked.length, conflicts: r.conflicts.length }
  }

  if (name === 'yuanling_group') {
    const gid = resolveGroupGid(args)
    if (!gid) throw new Error('需要 gid（qq:123456）或 channel（group:123456）')

    const patch = {}
    if (typeof args.name === 'string' && args.name.trim()) patch.name = args.name.trim().slice(0, 60)
    if (typeof args.feature === 'string' && args.feature.trim()) patch.feature = args.feature.trim().slice(0, 2000)
    if (typeof args.topics === 'string' && args.topics.trim()) patch.topics = args.topics.trim().slice(0, 2000)
    if (Array.isArray(args.aliases)) {
      patch.aliases = args.aliases
        .map((x) => String(x).trim())
        .filter(Boolean)
        .slice(0, 10)
    }
    const writing = Object.keys(patch).length > 0

    if (!writing) {
      const g = readGroup(root, pid, gid)
      if (!g) {
        return {
          text: `（${gid} 还没有档案。在这个群说过话、或有人提到它之后才会有；第一次写描述时，传 feature / topics 就会顺手建。）`,
        }
      }
      return { text: formatGroupDetail(root, pid, g) }
    }

    ensureGroup(root, pid, gid, {})
    const g = writeGroup(root, pid, gid, patch, { actor: 'model:group', reason: '模型补写群体理解' })
    return { text: `✓ 已写入群体 ${g.gid}\n\n${formatGroupDetail(root, pid, g)}` }
  }

  if (name === 'yuanling_sources') {
    const list = listSources(root)
    return { text: formatSources(list), count: list.length }
  }

  if (name === 'yuanling_fetch') {
    const source = String(args.source ?? '').trim()
    if (!source) throw new Error('缺少 source（先调 yuanling_sources 看有哪些）')
    const params = args.params && typeof args.params === 'object' ? args.params : {}
    const limit = Number(args.limit) > 0 ? Number(args.limit) : undefined

    const data = await consoleCall(root, {
      method: 'POST',
      pathname: '/api/sources/fetch',
      body: { source, params, limit },
    })
    const rendered = renderFetched({
      sourceId: data.sourceId ?? source,
      records: data.records ?? [],
      truncated: Boolean(data.truncated),
      total: Number(data.total) || (data.records ?? []).length,
    })
    const { text } = clipText(rendered)
    return { text, count: (data.records ?? []).length }
  }

  throw new Error(`未知工具：${name}`)
}

// ── JSON-RPC ─────────────────────────────────────────────────────────────

function send(obj) {
  // 异步工具（取数要等模块回话）可能在 stdin 已经关掉之后才准备好结果。
  // 那时 stdout 已经 end，再写会抛 ERR_STREAM_WRITE_AFTER_END 把进程打死——
  // 对端都走了，这条响应本来也没人要，丢掉即可。
  if (!process.stdout.writable) return
  try {
    process.stdout.write(`${JSON.stringify(obj)}\n`)
  } catch {
    /* 同上：对端已断开 */
  }
}

function ok(id, result) {
  send({ jsonrpc: '2.0', id, result })
}

function fail(id, code, message) {
  send({ jsonrpc: '2.0', id, error: { code, message: String(message) } })
}

async function handle(req) {
  const id = req?.id
  const method = String(req?.method ?? '')

  // 通知（无 id）不回应
  if (id === undefined || id === null) return

  try {
    if (method === 'initialize') {
      // 回显客户端要的协议版本；不认识就退到常用值
      const requested = req?.params?.protocolVersion
      ok(id, {
        protocolVersion: typeof requested === 'string' && requested ? requested : '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: SERVER_INFO,
        instructions:
          '这是原灵（yuanling）的长期记忆。**每轮对话开始时先调用 yuanling_context**——不调用就等于失忆；' +
          '需要具体细节时再用 yuanling_recall；对方自述账号时用 yuanling_person_identity 写回档案；' +
          '对某个群有了新理解（它是什么地方、在聊什么）就用 yuanling_group 写回去。',
      })
      return
    }

    if (method === 'ping') {
      ok(id, {})
      return
    }

    if (method === 'tools/list') {
      ok(id, { tools: TOOLS })
      return
    }

    if (method === 'tools/call') {
      const name = String(req?.params?.name ?? '')
      const args = req?.params?.arguments ?? {}
      const root = openRoot()
      const r = await callTool(root, name, args)
      ok(id, {
        content: [{ type: 'text', text: r.text }],
        isError: false,
      })
      return
    }

    fail(id, -32601, `未知方法：${method}`)
  } catch (error) {
    // 工具执行失败也要按 MCP 约定返回结果，而不是把整条连接打断
    if (method === 'tools/call') {
      ok(id, {
        content: [{ type: 'text', text: `执行失败：${error?.message ?? error}` }],
        isError: true,
      })
      return
    }
    fail(id, -32603, String(error?.message ?? error))
  }
}

const rl = readline.createInterface({ input: process.stdin })
/** 在途请求。stdin 关掉时要等它们回完，不能直接结束 stdout。 */
const inflight = new Set()
rl.on('line', (line) => {
  const text = line.trim()
  if (!text) return
  let req = null
  try {
    req = JSON.parse(text)
  } catch {
    // 坏帧：不崩，回一条协议错误（有 id 才回）
    process.stderr.write('[yuanling] 收到非法 JSON 帧\n')
    return
  }
  // handle 现在是 async（取数要等模块回话）；响应按 id 对应，乱序不影响 MCP。
  // 记在册是为了 stdin 关掉时**等它们回完再退出**——否则管道用法下最后一条响应会被吞掉。
  const p = handle(req).catch((error) => {
    fail(req?.id ?? null, -32603, String(error?.message ?? error))
  })
  inflight.add(p)
  p.finally(() => inflight.delete(p))
})

rl.on('close', () => {
  // 还有没回完的请求就先等它们（管道/单次调用时最后一条响应全靠这个）
  Promise.allSettled([...inflight]).finally(() => process.stdout.end?.())
})

process.stderr.write('[yuanling] MCP server 就绪\n')
