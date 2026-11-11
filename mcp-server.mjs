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
import { contextFor, recall, addFact } from './src/core/memory.js'
import { loadIdentities, createPerson, setIdentityText } from './src/core/entities.js'
import { readGroupLive, writeGroup, ensureGroup, gidForChannel, ensureGroupScene, findGidByNative, CHANNEL_PLATFORM, GROUP_KINDS } from './src/core/groups.js'
import { resolveChannel } from './src/core/channels.js'
import { readStyle, addStyleLine, removeStyleLine } from './src/core/style.js'
import { setImpression, renderImpression, IMPRESSION_MAX_BYTES } from './src/core/impressions.js'
import { readPurposes, writePurposes, markHit, closePurpose, SELECT_MAX_HITS, SELECT_MAX_OFFERED } from './src/core/purposes.js'
import { refreshDrives, readDrives, driveName, addDrive, adjustDrive, removeDrive } from './src/core/drives.js'
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
      '【每轮必调】读取原灵的长期记忆：记忆卡 + 惦记着的事 + 当前在场人物卡 + 当前群体卡。\n' +
      '规则：每次开始新一轮对话、或对方提到过去的人/事时，**先调用本工具再开口**——不调用就等于失忆。\n' +
      '不需要对方要求，这是你的常规动作。返回纯文本，直接当作背景信息使用。\n' +
      '读完如果对某个人/某个群有了新印象，用 yuanling_observe 写回去（整段覆盖，必须带 reason）；' +
      '真的把 [惦记] 里某件事问出来了，用 yuanling_purpose 回报（不然系统会以为你没提，摆满几次就自己放下）。',
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
      '在群里说话时，当前群体的卡已经自动出现在 yuanling_context 里；这个工具用来查一个群、' +
      '或者改它的名字。\n' +
      '**群体是怎么一种地方**（`feature`）请用 yuanling_observe 写——那里有覆盖、上限与历史；' +
      '这个工具改 description 类字段时也要带 reason。别编成员：成员由核心从原始层归集（谁在这个群说过话）。',
    inputSchema: {
      type: 'object',
      properties: {
        gid: { type: 'string', description: '群体 id，形如 qq:123456。不传则用 channel 对应的群。' },
        channel: { type: 'string', description: '当前会话频道，如 group:123456，用来推断是哪个群。' },
        name: { type: 'string', description: '群名（只在写入时用）' },
        feature: { type: 'string', description: '这个群是什么地方、什么氛围——自然语言，≤2000 字' },
      },
    },
  },
  {
    name: 'yuanling_remember',
    description:
      '**写一条事实**进记忆层（她"记住"的东西），用于规则提炼抓不到、但值得长期记住的事。\n' +
      '**必须给 src 指针** —— 指向 raw 里真实存在的那条记录（形如 `raw/2026-11/10/qq.ndjson#01J...`，' +
      '可以用 yuanling_context / yuanling_recall 里看到的 @指针，或 CLI `yuanling last`）。' +
      '没有指针的事实一律拒绝：她记得的事必须能翻回原话。\n' +
      '重复的表述不会写第二条，只会让原事实的「重复次数」+1（那正是人格演化的原料）。',
    inputSchema: {
      type: 'object',
      properties: {
        text: { type: 'string', description: '事实本身，一句话，≤120 字' },
        topic: { type: 'string', description: '归到哪个主题（记忆页按主题分文件），例如「喜好」「工作」' },
        src: { type: 'string', description: '证据指针 raw/…ndjson#ULID —— 必填' },
        slot: { type: 'string', description: '可选槽位：同槽位的新事实会关闭旧事实（例如「住处」）' },
        imp: { type: 'number', description: '可选重要度 1–100；不填由核心估' },
      },
      required: ['text', 'topic', 'src'],
    },
  },
  {
    name: 'yuanling_drive',
    description:
      '看 / 改"动机层"——她**想要什么**的强度（陪 / 关心 / 好奇 / 分享 / 自我，以及她自己加的动机）。\n' +
      '动机按半衰期回落到基线，所以"最近更想要"要她自己去调，或者等关键词在聊天里出现自动升温。\n' +
      '**她可以自己加新动机**：加的时候必须给一组关键词（"听到什么会更有劲"），记忆/消息里撞上就会升温，' +
      '并且能生成属于它的「惦记」——所以关键词要选她真会遇到的说法。\n' +
      '限制：内置五个不能删；自定义最多 3 个（总共 8）；名字 ≤12 字；单次调整 ≤±0.2、一天最多 6 次；' +
      '每次都要写 reason，全部进版本历史、可回滚。',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['list', 'adjust', 'add', 'remove'], description: 'list 只读（默认）；adjust 调权重；add 加新动机；remove 删自定义动机' },
        need: { type: 'string', description: '动机 id 或名字（adjust/remove 用）。内置：connect/care/curiosity/share/identity' },
        delta: { type: 'number', description: 'adjust 的增量：正数=更想要，负数=淡一点，绝对值 ≤0.2' },
        name: { type: 'string', description: 'add 的动机名（≤12 字）' },
        keywords: { type: 'array', items: { type: 'string' }, description: 'add 的关键词：听到这些词就会更想要（≤8 个，每个 ≤12 字）' },
        base: { type: 'number', description: 'add 的基线（默认 0.25）：静下来之后回落到多少' },
        reason: { type: 'string', description: 'adjust/add/remove 必填：这次为什么动它' },
      },
    },
  },
  {
    name: 'yuanling_style',
    description:
      '改 / 看"表达层"——她**可以自己改**的那一层：最近养成的说话习惯、口癖、口味。\n' +
      '和骨架的区别：骨架（SELF.md 的核心身份/说话方式/价值观）只有人能改，永远不在这里；' +
      '表达层是人、提案、和你三方都能改的那一层——她"怎么说话"的演化就落在这里。\n' +
      '**写进去的每一条都会进上下文**（[习惯]，预算 240 字节、最多 8 条），所以写入时就按预算卡住：\n' +
      '超了会被拒绝，并告诉你现在还剩多少——不会让你写一堆却在注入时被悄悄截掉。\n' +
      '每次改动都要写 reason（为什么养成/去掉这个习惯），进版本历史、可回滚。\n' +
      '注意：人批准某条提案时是**整文件退回**语义，回滚那条提案会把中间的直改一起覆盖。',
    inputSchema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['list', 'add', 'remove'],
          description: 'list 看现在有哪些（默认）；add 加一条；remove 删一条',
        },
        line: { type: 'string', description: '要加/删的那一条（不用写前导 "- "）' },
        reason: { type: 'string', description: 'add/remove 必填：为什么' },
      },
    },
  },
  {
    name: 'yuanling_observe',
    description:
      '写 / 读"她对某人或某个地方的印象"。人物和群体用同一套规则：**整段覆盖**（印象是"现在怎么看他"，不是日记）、' +
      '旧版本只留在版本历史里（随时能回滚）、每次写必须带一句 reason、上限 600 字节（就是注入预算，超了页面上也只会被截断）。\n' +
      '不传 text 就是只读；加 withHistory 能看到这份印象一路是怎么变的（每一版的时间、原因、原文）——' +
      '想知道"我为什么现在这么看他"，就读这个，别自己编。',
    inputSchema: {
      type: 'object',
      properties: {
        kind: { type: 'string', enum: ['person', 'group'], description: '写谁/哪里：person 或 group' },
        id: { type: 'string', description: '人物 uid（person_xxx）或群体 gid（qq:123456）' },
        text: { type: 'string', description: '整段印象（≤600 字节）。不传就只读' },
        reason: { type: 'string', description: '这次为什么改——会写进版本历史，以后能回看' },
        evidence: { type: 'string', description: '可选：raw/2026-11/07/qq.ndjson#01JCV…，必须真能解析到' },
        withHistory: { type: 'boolean', description: '连历史一起返回（默认最近 10 版）' },
        limit: { type: 'number', description: '历史条数，默认 10' },
      },
      required: ['kind', 'id'],
    },
  },
  {
    name: 'yuanling_purpose',
    description:
      '看 / 回报"她心里惦记着的事"。这些条目由核心从记忆里自动挖出来（"你上次说 X，后来怎么样了"），' +
      '每轮对话时最多摆 2 条在 [惦记] 里给你挑。\n' +
      '**说没说出口只有你知道**：真的把某条问出来了，用 action:"mentioned" 回报；决定不提了，用 action:"drop"。\n' +
      '不回报也能跑，但系统会以为你一直没提——摆够 5 次它就自己放下了。',
    inputSchema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['list', 'mentioned', 'drop'],
          description: 'list 看账本（默认）；mentioned 回报"我问过了"；drop 回报"这条不提了"',
        },
        ids: { type: 'array', items: { type: 'string' }, description: '条目 id（pur_xxx）；mentioned 可一次报多条' },
        id: { type: 'string', description: '单条 id（drop 用）' },
        reason: { type: 'string', description: 'drop 时可选：为什么放下' },
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

/**
 * 群体的 id：显式 gid 优先，其次从场景推。
 *
 * 群体编号现在是纯内部编号（`grp_xxx`）。模型如果还按老习惯传 `qq:123456`，
 * 就把它当"平台:原生号"去登记表里换一个编号——不假装没看见，也不直接报错。
 */
function resolveGroupGid(root, args) {
  const raw = String(args.gid ?? '').trim()
  if (raw) {
    if (/^grp_/.test(raw)) return raw
    if (raw.includes(':')) {
      const [platform, ...rest] = raw.split(':')
      const gid = findGidByNative(root, platform, rest.join(':'))
      if (gid) return gid
      // 登记表里没有：这是个还没见过的群，现在登记一个（第一次写描述就顺手建档）
      return ensureGroupScene(root, { platform, nativeId: rest.join(':') })
    }
    const gid = findGidByNative(root, 'qq', raw)
    return gid ?? ensureGroupScene(root, { platform: 'qq', nativeId: raw })
  }
  const ch = String(args.channel ?? '').trim()
  if (ch) {
    const gid = gidForChannel(root, ch)
    if (gid) return gid
    // 场景还没登记过（例如第一次给这个群写描述）：按场景里的平台与号登记一个。
    // 认不出平台的场景（私聊、module:、bili:video:）返回空——那些根本不是"一个地方"。
    const c = resolveChannel(root, ch)
    if (!GROUP_KINDS.has(c.kind)) return ''
    const platform = c.id.includes(':') ? c.id.split(':')[0] : CHANNEL_PLATFORM[c.kind] ?? c.kind
    const nativeId = c.id.includes(':') ? c.id.split(':').slice(1).join(':') : c.id
    return ensureGroupScene(root, { platform, nativeId })
  }
  return ''
}

function formatGroupDetail(root, pid, g) {
  const people = loadIdentities(root).people ?? {}
  const lines = [`${g.name || '（未命名）'}  ${g.gid}`]
  lines.push(`权重 ${g.weight}${g.tier === 'important' ? '  〔重要群体〕' : ''}`)
  if (g.feature) lines.push(`特征：${g.feature}`)
  if (g.members.length) {
    const names = g.members.slice(0, 10).map((uid) => people[uid]?.display ?? uid)
    lines.push(`常出现的人（${g.memberCount}）：${names.join('、')}${g.members.length > 10 ? ' …' : ''}`)
  } else {
    lines.push('常出现的人：还没归集（管理台点「重新归集成员」，或 yuanling group members）')
  }
  if (g.lastSeen) lines.push(`最后一次见到：${g.lastSeen}`)
  return lines.join('\n')
}

/**
 * 动机的渲染：按强度从高到低，标出哪些是她自己加的。
 * 强调"关键词"——那是它唯一会自己升温的来源，也是她能预见后果的地方。
 */
function formatDrives(root, pid) {
  const d = readDrives(root, pid)
  const rows = Object.entries(d.values).sort((a, b) => Number(b[1]) - Number(a[1]))
  const lines = ['动机（她想要什么；括号是强度，按半衰期自动回落）']
  for (const [need, v] of rows) {
    const custom = d.custom?.find((x) => x.id === need)
    const label = custom ? `${custom.name}（自定义）` : driveName(d, need)
    const kws = custom?.keywords?.length ? `  关键词：${custom.keywords.join('、')}` : ''
    lines.push(`  ${String(Math.round(Number(v) * 100)).padStart(3)}%  ${label}${kws}`)
  }
  lines.push('')
  lines.push('调权重用 adjust（≤±0.2/次，6 次/天）；加新动机用 add，必须给关键词——听到那些词它才会涨。')
  return lines.join('\n')
}

/**
 * 表达层的渲染。故意把"预算用了多少"摆在最前面：她要知道还剩多少空间，
 * 才能决定是加一条还是先删一条。
 */
function formatStyle(s) {
  const lines = [`表达层（她可以自己改的那一层）：${s.bytes}/${s.budget} 字节 · ${s.items.length}/${s.maxItems} 条`]
  if (s.items.length) {
    for (const it of s.items) lines.push(`  - ${it}`)
  } else {
    lines.push('（还空着：她还没养成什么固定的说话习惯。可以加一条，比如"拿不准的时候说「我猜」"）')
  }
  lines.push('')
  lines.push('写进来的每一条都会进上下文（[习惯]）。骨架不在这层——那是"她是谁"，只有人能改。')
  if (s.items.length && s.bytes >= s.budget * 0.9) {
    lines.push('⚠ 快到预算上限了：再加一条之前先删一条，或把话写短。')
  }
  return lines.join('\n')
}

/**
 * 账本渲染。**只读**：这里不刷新 drives、不挖新条目——
 * 一个"看一眼"的动作不该顺手改盘（挖/清是 contextFor 每轮在做的事）。
 */
function formatPurposes(root, pid, doc) {
  const items = Array.isArray(doc.items) ? doc.items : []
  if (!items.length) {
    return [
      '（账本还是空的）',
      '',
      '这不是坏了：目的由核心从记忆里自动挖出来，条件比较严——',
      '只有"带情绪（≥8）或带槽位（会变的事）"、而且发生在 6 小时~7 天前的记忆才会被惦记。',
      '现在没有够格的素材，所以一条都没有。',
    ].join('\n')
  }

  const open = items.filter((p) => p.status === 'open')
  const rest = items.filter((p) => p.status !== 'open')
  const lines = []

  const tag = { care: '关心', curiosity: '好奇', share: '分享', connect: '陪' }
  if (open.length) {
    lines.push(`还惦记着 ${open.length} 条：`)
    for (const p of open) {
      const seen = Number(p.offered ?? 0)
      const said = Number(p.hits ?? 0)
      lines.push(`  · ${p.id}  [${tag[p.need] ?? p.need}]  ${p.text}`)
      lines.push(`    说过 ${said} 次 / 摆到面前 ${seen} 次${seen >= 1 && said === 0 ? '（摆了没接，摆满 5 次会自己放下）' : ''}`)
    }
  } else {
    lines.push('眼下没有还惦记着的事。')
  }

  if (rest.length) {
    lines.push('', '已了结：')
    for (const p of rest.slice(-5)) {
      lines.push(`  · [${p.status}] ${p.text}${p.close_reason ? `（${p.close_reason}）` : ''}`)
    }
  }

  lines.push('')
  lines.push('真把某条问出来了：action:"mentioned" + ids。决定不提了：action:"drop" + id。')
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
    const gid = resolveGroupGid(root, args)
    if (!gid) throw new Error('需要 gid（群体编号 grp_xxx 或 平台:号）或 channel（group:<编号>）')

    const patch = {}
    if (typeof args.name === 'string' && args.name.trim()) patch.name = args.name.trim().slice(0, 60)
    // 描述统一走 impressions：整段覆盖、要写原因、进版本历史。
    // 这里不再自己拼 patch，免得同一段描述有两条写路径。
    const wantFeature = typeof args.feature === 'string' && args.feature.trim()
    const reason = String(args.reason ?? '').trim()
    if (wantFeature && !reason) throw new Error('改群体描述要带 reason：这次为什么这么改')

    const writing = Object.keys(patch).length > 0 || wantFeature

    if (!writing) {
      const g = readGroupLive(root, pid, gid)
      if (!g) {
        return {
          text: `（${gid} 还没有档案。在这个群说过话、或有人提到它之后才会有；第一次写描述时，传 feature 就会顺手建。）`,
        }
      }
      return { text: formatGroupDetail(root, pid, g) }
    }

    ensureGroup(root, pid, gid, {})
    if (Object.keys(patch).length) {
      writeGroup(root, pid, gid, { ...patch, __reason: reason || '模型更新群体元信息' }, { actor: 'model:group' })
    }
    if (wantFeature) {
      setImpression(root, pid, 'group', gid, { text: args.feature, reason, evidence: args.evidence ?? null })
    }

    const g = readGroupLive(root, pid, gid)
    return { text: `✓ 已写入群体 ${g.gid}\n\n${formatGroupDetail(root, pid, g)}` }
  }

  if (name === 'yuanling_remember') {
    const text = String(args.text ?? '').trim()
    const topic = String(args.topic ?? '').trim()
    const src = String(args.src ?? '').trim()
    if (!text) throw new Error('text 不能为空：要记住的那句话')
    if (!topic) throw new Error('topic 不能为空：归到哪个主题（例如「喜好」）')
    if (!src) throw new Error('src 必填：指向 raw 里那条原话（没有指针的事实不写）')
    if ([...text].length > 120) throw new Error(`事实太长（${[...text].length} 字 > 120），摘一句就够`)

    const r = addFact(root, pid, {
      topic,
      text,
      src,
      slot: typeof args.slot === 'string' && args.slot.trim() ? args.slot.trim() : null,
      imp: Number.isFinite(Number(args.imp)) ? Number(args.imp) : null,
    })
    if (r.repeated) {
      return { text: `· 这句话已经记过了（累计 ${r.fact.repeat} 次）：${r.fact.text}\n  重复本身就是信号，不用再写一条` }
    }
    return { text: `✓ 已记住：${r.fact.text}\n  主题：${topic}｜重要度 ${r.fact.imp}｜出处 ${src}` }
  }

  if (name === 'yuanling_drive') {
    const action = String(args.action ?? 'list').trim() || 'list'
    if (action === 'list') return { text: formatDrives(root, pid) }
    if (action === 'adjust') {
      const r = adjustDrive(root, pid, { need: args.need, delta: args.delta, reason: args.reason })
      return {
        text: `✓ ${r.name}：${Math.round(r.before * 100)}% → ${Math.round(r.after * 100)}%\n\n${formatDrives(root, pid)}`,
      }
    }
    if (action === 'add') {
      addDrive(root, pid, { name: args.name, keywords: args.keywords, reason: args.reason, base: args.base })
      return { text: `✓ 加了一个新动机\n\n${formatDrives(root, pid)}` }
    }
    if (action === 'remove') {
      removeDrive(root, pid, { need: args.need, reason: args.reason })
      return { text: `✓ 已删掉这个自定义动机\n\n${formatDrives(root, pid)}` }
    }
    throw new Error(`不认识的 action：${action}（list / adjust / add / remove）`)
  }

  if (name === 'yuanling_style') {
    const action = String(args.action ?? 'list').trim() || 'list'

    if (action === 'list') {
      return { text: formatStyle(readStyle(root, pid)) }
    }
    if (action === 'add') {
      const r = addStyleLine(root, pid, { line: args.line, reason: args.reason })
      const head = r.changed ? '✓ 已加进表达层（会进上下文）' : '· 这一条已经在表达层里了，没有重复写'
      return { text: `${head}\n\n${formatStyle(readStyle(root, pid))}` }
    }
    if (action === 'remove') {
      const r = removeStyleLine(root, pid, { line: args.line, reason: args.reason })
      return { text: `✓ 已去掉「${r.removed}」\n\n${formatStyle(readStyle(root, pid))}` }
    }
    throw new Error(`不认识的 action：${action}（list / add / remove）`)
  }

  if (name === 'yuanling_observe') {
    const kind = String(args.kind ?? '').trim()
    const id = String(args.id ?? '').trim()
    if (!kind || !id) throw new Error('需要 kind（person | group）和 id（人物 uid 或群体 gid）')
    const withHistory = args.withHistory === true
    const limit = Number(args.limit) > 0 ? Number(args.limit) : 10
    const text = typeof args.text === 'string' ? args.text.trim() : ''

    if (!text) {
      // 只读：把"现在的印象"和"它是怎么变的"一起给出来
      const body = renderImpression(root, pid, kind, id, { withHistory, limit })
      return { text: body }
    }

    const r = setImpression(root, pid, kind, id, {
      text,
      reason: args.reason,
      evidence: args.evidence ?? null,
      actor: 'model:observe',
    })
    const head = r.changed
      ? `✓ 已更新${kind === 'person' ? '人物' : '群体'}印象（${Buffer.byteLength(r.after, 'utf8')}/${IMPRESSION_MAX_BYTES} 字节，旧版留在版本历史里）`
      : `· 内容没变，没有产生新版本`
    const tail = withHistory ? `\n\n${renderImpression(root, pid, kind, id, { withHistory: true, limit })}` : ''
    return { text: `${head}\n原因：${r.reason}${tail}` }
  }

  if (name === 'yuanling_purpose') {
    const action = String(args.action ?? 'list')
    const doc = readPurposes(root, pid)

    if (action === 'list') return { text: formatPurposes(root, pid, doc), count: doc.items.filter((p) => p.status === 'open').length }

    const ids = (Array.isArray(args.ids) ? args.ids : args.id ? [args.id] : []).map(String).filter(Boolean)
    if (!ids.length) throw new Error(`action:"${action}" 需要 id 或 ids（先 action:"list" 看一遍）`)

    if (action === 'mentioned') {
      if (!markHit(doc, ids)) throw new Error(`没找到这些条目：${ids.join('、')}`)
      writePurposes(root, pid, doc)
      return { text: `✓ 记下 ${ids.length} 条"已经问过了"（每条真提满 ${SELECT_MAX_HITS} 次就自动放下）` }
    }

    if (action === 'drop') {
      const why = String(args.reason ?? '模型判断不值得再提')
      let n = 0
      for (const id of ids) {
        const r = closePurpose(doc, id, { reason: `模型放下：${why}` })
        if (r.changed) n += 1
      }
      if (!n) throw new Error(`没找到这些条目：${ids.join('、')}`)
      writePurposes(root, pid, doc)
      return { text: `✓ 放下 ${n} 条（${why}）` }
    }

    throw new Error(`未知 action：${action}（只能是 list / mentioned / drop）`)
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
          '对某个人或某个群有了新印象，用 yuanling_observe 整段写回去（必须带 reason，旧版能回滚）。\n' +
          '把 [惦记] 里的事真的问出来了，用 yuanling_purpose {action:"mentioned"} 回报——不回报系统会以为你没提。',
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
