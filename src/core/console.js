// src/core/console.js —— 管理台「对话 / 对话测试」的数据层。
//
// 普通对话：source=dsh，user + assistant 都进 raw，和私聊一样自动提炼。
// 测试对话：只读上下文，不写 raw、不提炼；聊天记录单独存 console/test.jsonl。
// 两条会话的工作目录固定在 personas/<pid>/console/{chat,test} 下。
import fs from 'node:fs'
import path from 'node:path'

import { localIso } from './fsx.js'
import { P } from './paths.js'
import { listModelChoices, readConsoleModel, validateModelChoice, writeConsoleModel } from './model.js'
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

export function createConsoleChat(ctx) {
  const runs = new Map()
  async function subagentTurn({ p, mode, clean, master, turnId, prior, model, send }) {
    const root = rootFor(ctx)
    const sub = ctx.get?.('subagents')
    const svc = ctx.get?.('agents')
    const parent = svc?.roots?.().find((a) => !String(a.id).startsWith('yl-console-'))
    if (!sub?.startActivation) throw new Error('这个进程没有 DSH subagent 服务，控制台不可用')
    if (!parent) throw new Error('没有找到 DSH 主会话，无法建立控制台对话')
    const selected = model?.provider && model?.model
      ? model
      : (readConsoleModel(root) ?? parent.model?.current?.())
    if (!selected?.provider || !selected?.model) throw new Error('没有可用的控制台模型')
    const history = prior
      .filter((m) => (m.role === 'user' || m.role === 'assistant') && m.text)
      .slice(-20)
      .map((m) => `${m.role === 'user' ? '主人' : '原灵'}：${m.text}`)
      .join('\n')
    const prompt = [
      { type: 'text', text: consolePrompt(root, p, master, clean) },
      ...(history ? [{ type: 'text', text: `【最近对话】\n${history}` }] : []),
    ]
    const controller = new AbortController()
    const key = `${p}:${mode}`
    let handle = null
    let streamed = ''
    let off = null
    try {
      handle = await sub.startActivation({
        provider: 'spawn',
        label: `yuanling console ${mode}`,
        delivery: 'caller',
        signal: controller.signal,
        request: {
          parent,
          prompt,
          agentOptions: selected,
          agentPreset: mode === 'test' ? 'yuanling-console-test' : 'yuanling-console',
          cwd: consoleDir(root, p, mode),
          maxDepth: 1,
        },
      })
      runs.set(key, { handle, controller })
      const child = svc.get?.(handle.childId)
      if (child?.ctx?.on) {
        off = child.ctx.on('agent/assistant-stream', (event) => {
          const frame = event?.frame ?? event
          const delta = chunkText(frame)
          if (!delta) return
          streamed += delta
          send('delta', { text: delta })
        })
      }
      const result = await handle.result
      const text = (result?.output ?? []).filter((b) => b?.type === 'text').map((b) => b.text).join('') || streamed
      if (!text) throw new Error(`模型没有返回文本（stopReason=${result?.stopReason ?? 'unknown'}）`)
      if (!streamed) send('delta', { text })
      appendConsoleHistory(root, p, mode, { role: 'assistant', text, at: localIso(), turnId, test: mode === 'test' })
      if (mode === 'chat') {
        try { recordConsoleAssistant(root, p, master, { text, turnId }) } catch { /* raw 失败不挡回复 */ }
      }
      send('done', { text, turnId })
    } finally {
      try { off?.() } catch { /* ignore */ }
      runs.delete(key)
      try { await handle?.dispose?.() } catch { /* ignore */ }
    }
  }

  async function turn({ pid, mode, text, model = null, send }) {
    const p = requirePid(rootFor(ctx), pid)
    if (!CONSOLE_MODES.includes(mode)) throw new Error('mode 只有 chat / test')
    const clean = String(text ?? '').trim()
    if (!clean) throw new Error('消息为空')
    const master = ensureConsoleMaster(rootFor(ctx), p)
    const turnId = `turn_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`
    const ts = localIso()
    const prior = consoleHistory(rootFor(ctx), p, mode, { limit: 20 })
    ensureConsoleDirs(rootFor(ctx), p)
    appendConsoleHistory(rootFor(ctx), p, mode, { role: 'user', text: clean, at: ts, turnId, test: mode === 'test' })
    send('meta', { turnId, mode })
    if (mode === 'chat') {
      try { recordConsoleUser(rootFor(ctx), p, master, { text: clean, turnId, ts }) } catch { /* raw 失败不挡回复 */ }
    }

    try {
      await subagentTurn({ p, mode, clean, master, turnId, prior, model, send })
      return
    } catch (err) {
      appendConsoleHistory(rootFor(ctx), p, mode, { role: 'assistant', text: '', at: localIso(), turnId, test: mode === 'test', error: String(err?.message ?? err) })
      send('error', { message: String(err?.message ?? err) })
      return
    }
  }

  async function stop({ pid, mode }) {
    const key = `${pid}:${mode}`
    const run = runs.get(key)
    if (!run) return false
    try { run.controller.abort() } catch { /* 已经停了 */ }
    try { await run.handle?.dispose?.() } catch { /* ignore */ }
    runs.delete(key)
    return true
  }

  async function models() {
    const current = readConsoleModel(rootFor(ctx))
    const catalog = await listModelChoices(ctx)
    return { current, ...catalog }
  }

  async function selectModel(selection) {
    const root = rootFor(ctx)
    const clean = await validateModelChoice(ctx, selection)
    writeConsoleModel(root, clean)
    return { current: clean }
  }

  async function dispose() {
    for (const run of runs.values()) {
      try { run.controller.abort() } catch { /* ignore */ }
      try { await run.handle?.dispose?.() } catch { /* ignore */ }
    }
    runs.clear()
  }

  return { turn, stop, dispose, models, selectModel }
}

// createConsoleChat 需要 root；由 index.js 用闭包传 root 更直接，这里保留一个可替换的解析点。
let rootFor = () => {
  throw new Error('console root 未绑定')
}

export function bindConsoleRoot(root) {
  rootFor = () => root
}
