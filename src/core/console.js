// src/core/console.js —— 管理台「对话 / 对话测试」的数据层。
//
// 普通对话：source=dsh，user + assistant 都进 raw，和私聊一样自动提炼。
// 测试对话：只读上下文，不写 raw、不提炼；聊天记录单独存 console/test.jsonl。
// 两条会话的工作目录固定在 personas/<pid>/console/{chat,test} 下。
import fs from 'node:fs'
import path from 'node:path'

import { localIso, readJson } from './fsx.js'
import { P } from './paths.js'
import { requirePid } from './scope.js'
import { cardByAccount, createCard, isConsoleMasterCard, readCard } from './accounts.js'
import { contextFor } from './memory.js'
import { ingest } from './inbox.js'

export const CONSOLE_MODES = ['chat', 'test']
export const CONSOLE_MASTER_ID = 'card_00000000000000000000000000'

export function consoleDir(root, pid, mode) {
  if (!CONSOLE_MODES.includes(mode)) throw new Error(`未知的对话模式：${mode}`)
  return path.join(root, P.personas, requirePid(root, pid), 'console', mode)
}

export function ensureConsoleMaster(root, pid = null) {
  const p = requirePid(root, pid)
  const hit = cardByAccount(root, p, 'dsh', 'master')
  if (hit) return readCard(root, p, hit)
  for (const id of [CONSOLE_MASTER_ID, 'card_00000000000000000000000001', 'card_00000000000000000000000002']) {
    if (readCard(root, p, id)) continue
    return createCard(root, p, {
      app: 'dsh',
      account: 'master',
      nicknames: ['主人'],
      description: '通过 DSH 管理台直接对话的管理员本人。',
      firstMet: localIso(),
      id,
    })
  }
  // 极少数情况下固定槽位都被占：仍然建一张，主卡优先规则会保证它排最前。
  return createCard(root, p, {
    app: 'dsh',
    account: 'master',
    nicknames: ['主人'],
    description: '通过 DSH 管理台直接对话的管理员本人。',
    firstMet: localIso(),
  })
}

export function consoleMaster(root, pid = null) {
  const p = requirePid(root, pid)
  const id = cardByAccount(root, p, 'dsh', 'master')
  return id ? readCard(root, p, id) : null
}

/** 可选：system/console-model.json 指定控制台 Agent 的模型路由。 */
export function consoleModelOverride(root) {
  const j = readJson(path.join(root, 'system', 'console-model.json'), null)
  if (!j || typeof j !== 'object') return null
  const provider = String(j.provider ?? '').trim()
  const model = String(j.model ?? '').trim()
  if (!provider || !model) return null
  return {
    provider,
    model,
    ...(j.reasoningEffort ? { reasoningEffort: String(j.reasoningEffort) } : {}),
  }
}

function historyFile(root, pid, mode) {
  return path.join(consoleDir(root, pid, mode), 'history.jsonl')
}

export function ensureConsoleDirs(root, pid = null) {
  const p = requirePid(root, pid)
  for (const mode of CONSOLE_MODES) fs.mkdirSync(consoleDir(root, p, mode), { recursive: true })
}

export function appendConsoleHistory(root, pid, mode, entry) {
  const dir = consoleDir(root, pid, mode)
  fs.mkdirSync(dir, { recursive: true })
  fs.appendFileSync(historyFile(root, pid, mode), JSON.stringify(entry) + '\n', 'utf8')
}

export function consoleHistory(root, pid, mode, { limit = 200 } = {}) {
  const file = historyFile(root, pid, mode)
  if (!fs.existsSync(file)) return []
  const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean)
  return lines.slice(-Math.max(1, Math.min(500, Number(limit) || 200))).map((line) => {
    try {
      return JSON.parse(line)
    } catch {
      return null
    }
  }).filter(Boolean)
}

export function consoleContext(root, pid, master) {
  return contextFor(root, pid, { channel: `private:${master.id}`, preview: false })
}

export function consolePrompt(root, pid, master, text) {
  const context = consoleContext(root, pid, master)
  return [
    '【这是原灵自己的系统上下文，不是用户发言；请把它当作你已经知道的记忆/人物信息】',
    context,
    '【系统上下文结束】',
    '',
    text,
  ].join('\n')
}

function ingestConsole(root, pid, master, { role, text, turnId, ts, source = 'dsh' }) {
  const isBot = role === 'bot'
  return ingest(root, {
    v: 1,
    source,
    acct: 'master',
    items: [{
      channel: `private:${master.id}`,
      kind: 'msg',
      role,
      ext_id: `${turnId}-${isBot ? 'a' : 'u'}`,
      ts,
      text,
      actor: isBot
        ? { kind: 'bot', id: 'master', name: '原灵' }
        : { kind: 'owner', id: 'master', name: '主人' },
    }],
  })
}

export function recordConsoleUser(root, pid, master, { text, turnId, ts = localIso() }) {
  return ingestConsole(root, pid, master, { role: 'user', text, turnId, ts })
}

export function recordConsoleAssistant(root, pid, master, { text, turnId, ts = localIso() }) {
  return ingestConsole(root, pid, master, { role: 'bot', text, turnId, ts })
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function waitForAssistantText(agent) {
  const deadline = Date.now() + 300_000
  let idleSince = 0
  for (;;) {
    const text = assistantTextOf(agent)
    if (text) return text
    if (Date.now() > deadline) throw new Error('对话超时（300 秒）')
    // followup 刚入队时 agent 可能还短暂处于 idle；先给它一个调度窗口。
    if (idleSince === 0) idleSince = Date.now()
    if (Date.now() - idleSince > 30_000) return ''
    await sleep(200)
  }
}

function lastAttemptFailure(agent) {
  try {
    const seq = Number(agent.session?.seq ?? 0)
    for (let i = seq - 1; i >= 0; i -= 1) {
      const ev = agent.session.eventAt(i)
      if (ev?.type !== 'assistant/attempt') continue
      const chunk = ev.data?.stream?.find?.((x) => x?.chunk?.type === 'finish')?.chunk
      const failure = chunk?.reason?.failure
      if (failure) return failure
    }
  } catch { /* ignore */ }
  return null
}

function assistantTextOf(agent) {
  try {
    const messages = agent.session?.deriveMessages?.() ?? []
    for (let i = messages.length - 1; i >= 0; i -= 1) {
      const m = messages[i]
      if (m.role !== 'assistant') continue
      const text = (m.content ?? []).filter((b) => b.type === 'text').map((b) => b.text).join('')
      if (text) return text
    }
  } catch {
    /* 读不到就回空 */
  }
  return ''
}

function chunkText(frame) {
  const chunk = frame?.chunk ?? frame
  if (!chunk || typeof chunk !== 'object') return ''
  if (typeof chunk.text === 'string' && (chunk.type === 'text-delta' || chunk.type === 'text')) return chunk.text
  if (typeof chunk.textDelta === 'string') return chunk.textDelta
  if (typeof chunk.delta === 'string') return chunk.delta
  return ''
}

const WRITE_TOOLS = [
  'mcp__yuanling__yuanling_remember',
  'mcp__yuanling__yuanling_observe',
  'mcp__yuanling__yuanling_purpose',
  'mcp__yuanling__yuanling_drive',
  'mcp__yuanling__yuanling_style',
  'mcp__yuanling__yuanling_account',
  'mcp__yuanling__yuanling_person_merge',
  'mcp__yuanling__yuanling_person_split',
  'mcp__yuanling__yuanling_group',
  'mcp__yuanling__yuanling_fetch',
]

export function createConsoleChat(ctx) {
  const live = new Map()
  const agents = () => ctx.get?.('agents')
  const presets = () => ctx.get?.('agentPresets')
  const defaults = () => ctx.get?.('agentDefaultModel')

  function sessionId(pid, mode) {
    return `yl-console-${String(pid).replace(/[^a-zA-Z0-9_-]/g, '_')}-${mode}`
  }

  async function getAgent(pid, mode, modelOverride = null) {
    const key = `${pid}:${mode}`
    const hit = live.get(key)
    if (hit) return hit
    const svc = agents()
    if (!svc) throw new Error('DSH Agent 运行时不可用（ctx.agents 没注入）')
    const presetSvc = presets()
    if (!presetSvc) throw new Error('DSH Agent preset 运行时不可用（ctx.agentPresets 没注入）')
    const dir = consoleDir(rootFor(ctx), pid, mode)
    fs.mkdirSync(dir, { recursive: true })

    const setup = (agentCtx) => {
      if (mode !== 'test') return
      if (!agentCtx.tools?.restrict) throw new Error('测试模式需要 DSH tools.restrict，但当前 Agent 没有工具服务')
      // MCP 工具是宿主级注册的，preset 不能“不挂”它们；在 Agent scope 里逐条 deny。
      // 逐条尝试而不是一次 deny 整组：某个工具没装时不要因为 unknown 让整条限制失效。
      for (const name of WRITE_TOOLS) {
        try {
          agentCtx.tools.restrict({ deny: [name] })
        } catch {
          /* 这个工具当前不存在，跳过 */
        }
      }
    }

    let agent = svc.get?.(sessionId(pid, mode)) ?? null
    let handle = null
    if (!agent) {
      const fallbackModel = defaults()?.currentSelection?.()
      if (fallbackModel) delete fallbackModel.reasoningEffort
      // 优先跟随当前 DSH 主会话的模型：控制台是“和主对话同一个她”，
      // 这样不会因为 agent-default-model 在插件进程里不可用而换一个坏路由。
      let rootModel = null
      try {
        const rootAgent = svc.roots?.().find((a) => !String(a.id).startsWith('yl-console-'))
        const cur = rootAgent?.model?.current?.()
        if (cur?.provider && cur?.model) rootModel = { provider: cur.provider, model: cur.model, ...(cur.reasoningEffort ? { reasoningEffort: cur.reasoningEffort } : {}) }
      } catch { /* 没有主会话就继续用默认 */ }
      const model = modelOverride?.provider && modelOverride?.model
        ? { provider: String(modelOverride.provider), model: String(modelOverride.model), ...(modelOverride.reasoningEffort ? { reasoningEffort: String(modelOverride.reasoningEffort) } : {}) }
        : (consoleModelOverride(rootFor(ctx)) ?? rootModel ?? fallbackModel)
      if (!model) throw new Error('没有可用的默认模型；先在 DSH 设置里选一个模型')
      let resumeError = null
      try {
        handle = await svc.resume({ resumeSessionId: sessionId(pid, mode), setup })
      } catch (err) {
        resumeError = err
        try {
          handle = await svc.create({
            sessionId: sessionId(pid, mode),
            meta: { cwd: dir },
            agentOptions: model,
            setup,
          })
        } catch (createError) {
          // 上一次 create 可能已经把 session 落盘、但 preset 失败；再 resume 一次。
          try {
            handle = await svc.resume({ resumeSessionId: sessionId(pid, mode), setup })
          } catch {
            throw new Error(`控制台会话启动失败：resume=${resumeError?.message ?? resumeError}；create=${createError?.message ?? createError}`)
          }
        }
      }
      agent = handle.agent
      if (!presetSvc.presetForSession?.(agent.session)) {
        await presetSvc.select(agent, mode === 'test' ? 'yuanling-console-test' : 'yuanling-console')
      }
    }
    const entry = { agent, handle, onFrame: null }
    try {
      agent.ctx?.on?.('agent/assistant-stream', (event) => {
        const frame = event?.frame ?? event
        if (frame?.type === 'start') entry.streamText = ''
        const t = chunkText(frame)
        if (t) {
          entry.streamText = (entry.streamText ?? '') + t
          entry.onFrame?.(t)
        }
      })
    } catch {
      /* 没有流事件就回退到最终文本 */
    }
    live.set(key, entry)
    return entry
  }

  async function turn({ pid, mode, text, model = null, send }) {
    const p = requirePid(rootFor(ctx), pid)
    if (!CONSOLE_MODES.includes(mode)) throw new Error('mode 只有 chat / test')
    const clean = String(text ?? '').trim()
    if (!clean) throw new Error('消息为空')
    const master = ensureConsoleMaster(rootFor(ctx), p)
    const entry = await getAgent(p, mode, model)
    const turnId = `turn_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`
    const ts = localIso()
    ensureConsoleDirs(rootFor(ctx), p)
    appendConsoleHistory(rootFor(ctx), p, mode, { role: 'user', text: clean, at: ts, turnId, test: mode === 'test' })
    send('meta', { turnId, mode })
    if (mode === 'chat') {
      try { recordConsoleUser(rootFor(ctx), p, master, { text: clean, turnId, ts }) } catch { /* raw 失败不挡回复 */ }
    }

    let streamed = ''
    entry.streamText = ''
    entry.onFrame = (delta) => {
      streamed += delta
      send('delta', { text: delta })
    }
    const seqBefore = Number(entry.agent.session?.seq ?? 0)
    try {
      entry.agent.followup({
        content: [{ type: 'text', text: consolePrompt(rootFor(ctx), p, master, clean) }],
        source: { kind: mode === 'test' ? 'yuanling-console-test' : 'yuanling-console' },
      })
      await sleep(150)
      let timeout = null
      try {
        await Promise.race([
          entry.agent.whenIdle(),
          new Promise((_, reject) => { timeout = setTimeout(() => reject(new Error('对话超时（300 秒）')), 300_000) }),
        ])
      } finally {
        if (timeout) clearTimeout(timeout)
      }
      const finalText = entry.streamText || (await waitForAssistantText(entry.agent))
      if (!finalText) {
        const failure = lastAttemptFailure(entry.agent)
        if (failure) {
          throw new Error(`模型请求失败：${failure.message || failure.code || '未知错误'}${failure.code ? `（${failure.code}）` : ''}`)
        }
        const types = []
        try {
          const seq = Number(entry.agent.session?.seq ?? 0)
          for (let i = Math.max(0, seqBefore); i < seq; i += 1) types.push(entry.agent.session.eventAt(i)?.type ?? '?')
        } catch { /* ignore */ }
        throw new Error(`模型没有返回文本（events=${types.join(',') || 'none'}；status=${JSON.stringify(entry.agent.status ?? null)}）`)
      }
      appendConsoleHistory(rootFor(ctx), p, mode, { role: 'assistant', text: finalText, at: localIso(), turnId, test: mode === 'test' })
      if (mode === 'chat') {
        try { recordConsoleAssistant(rootFor(ctx), p, master, { text: finalText, turnId }) } catch { /* raw 失败不挡回复 */ }
      }
      send('done', { text: finalText, turnId })
    } catch (err) {
      appendConsoleHistory(rootFor(ctx), p, mode, { role: 'assistant', text: '', at: localIso(), turnId, test: mode === 'test', error: String(err?.message ?? err) })
      send('error', { message: String(err?.message ?? err) })
    } finally {
      entry.onFrame = null
    }
  }

  async function stop({ pid, mode }) {
    const entry = live.get(`${pid}:${mode}`)
    if (!entry) return false
    try { entry.agent.cancel({ kind: 'user' }) } catch { /* 已经停了 */ }
    return true
  }

  async function dispose() {
    for (const entry of live.values()) {
      try { await entry.handle?.dispose?.() } catch { /* 关停失败不挡退出 */ }
    }
    live.clear()
  }

  return { turn, stop, dispose }
}

// createConsoleChat 需要 root；由 index.js 用闭包传 root 更直接，这里保留一个可替换的解析点。
let rootFor = () => {
  throw new Error('console root 未绑定')
}

export function bindConsoleRoot(root) {
  rootFor = () => root
}
