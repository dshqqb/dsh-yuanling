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

import { resolveRoot, validateRoot } from './src/core/paths.js'
import { readMarker } from './src/core/persona.js'
import { contextFor, recall } from './src/core/memory.js'
import { loadIdentities, createPerson, setIdentityText } from './src/core/entities.js'

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
]

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

function callTool(root, name, args = {}) {
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

  throw new Error(`未知工具：${name}`)
}

// ── JSON-RPC ─────────────────────────────────────────────────────────────

function send(obj) {
  process.stdout.write(`${JSON.stringify(obj)}\n`)
}

function ok(id, result) {
  send({ jsonrpc: '2.0', id, result })
}

function fail(id, code, message) {
  send({ jsonrpc: '2.0', id, error: { code, message: String(message) } })
}

function handle(req) {
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
          '需要具体细节时再用 yuanling_recall；对方自述账号时用 yuanling_person_identity 写回档案。',
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
      const r = callTool(root, name, args)
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
  handle(req)
})

rl.on('close', () => {
  process.stdout.end?.()
})

process.stderr.write('[yuanling] MCP server 就绪\n')
