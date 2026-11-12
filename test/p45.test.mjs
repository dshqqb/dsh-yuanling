// test/p45.test.mjs —— 印象：人物和群体共用一套"描述"规则。
//
// 用户拍的三条：整段覆盖、旧版本只留在版本历史里（能回滚）、每次必须记下为什么改，
// 而且**人物和群体走同一套逻辑**（不是两边各写一份像不像的代码）。
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import readline from 'node:readline'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

import { scaffold } from '../src/core/scaffold.js'
import { appendRecord } from '../src/core/raw.js'
import { createPerson, linkIdentity, personProfileRel, readProfile, writeProfile } from '../src/core/entities.js'
import { writeGroup, readGroup, groupRel, ensureGroupScene, ensureGroup } from '../src/core/groups.js'
import { setImpression, readImpression, impressionHistory, renderImpression, IMPRESSION_MAX_BYTES } from '../src/core/impressions.js'
import { history } from '../src/core/version.js'

const PID = 'yuanling'
const HERE = path.dirname(fileURLToPath(import.meta.url))
const SERVER = path.join(HERE, '..', 'mcp-server.mjs')

function tmpRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'yuanling-p45-'))
  scaffold(root, {})
  return root
}

let seedSeq = 0

/** 造一条真实 raw 记录，返回可直接当证据用的指针。 */
function seedRaw(root) {
  const r = appendRecord(root, {
    type: 'message',
    source: 'qq',
    acct: 'demo',
    channel: 'group:123456',
    actor: { kind: 'user', id: '111', name: '张三' },
    role: 'user',
    text: `第 ${++seedSeq} 条观察`,
    ts: '2026-11-01T10:00:00+08:00',
  })
  return { pointer: `${r.file}#${r.id}`, rel: r.file }
}

// ── 人物 ────────────────────────────────────────────────────────────────

test('人物：写印象 → 整段落到 sketch，带原因', () => {
  const root = tmpRoot()
  const p = createPerson(root, { display: '张三' })
  writeProfile(root, PID, p.uid, { sketch: '旧印象：爱聊备份' })

  const r = setImpression(root, PID, 'person', p.uid, {
    text: '做运维，说话短，先给结论再补理由；不喜欢被安慰',
    reason: '这几轮他一直在讲线上事故，语气也证明了他要结论',
  })
  assert.equal(r.changed, true)
  assert.equal(readProfile(root, PID, p.uid).sketch, '做运维，说话短，先给结论再补理由；不喜欢被安慰')
})

test('人物：第二版是覆盖，不是拼接（旧话不会留在新印象里）', () => {
  const root = tmpRoot()
  const p = createPerson(root, { display: '张三' })
  writeProfile(root, PID, p.uid, { sketch: '' })
  setImpression(root, PID, 'person', p.uid, { text: '爱聊备份', reason: '第一次印象' })
  setImpression(root, PID, 'person', p.uid, { text: '最近在折腾键盘', reason: '话题变了' })

  const cur = readProfile(root, PID, p.uid).sketch
  assert.equal(cur, '最近在折腾键盘')
  assert.ok(!cur.includes('备份'), '印象是"现在怎么看他"，不是日记')
})

test(`人物：超过 ${IMPRESSION_MAX_BYTES} 字节直接拒，且不写盘`, () => {
  const root = tmpRoot()
  const p = createPerson(root, { display: '张三' })
  writeProfile(root, PID, p.uid, { sketch: '原样' })

  const tooLong = '啊'.repeat(IMPRESSION_MAX_BYTES) // 中文 3 字节/字，肯定超
  assert.throws(() => setImpression(root, PID, 'person', p.uid, { text: tooLong, reason: '想写长一点' }), /太长/)
  assert.equal(readProfile(root, PID, p.uid).sketch, '原样', '拒掉的时候不能留下半截内容')
})

test('人物：不写 reason 就拒绝——没理由的改动以后没法解释', () => {
  const root = tmpRoot()
  const p = createPerson(root, { display: '张三' })
  writeProfile(root, PID, p.uid, { sketch: '原样' })
  assert.throws(() => setImpression(root, PID, 'person', p.uid, { text: '新印象' }), /reason/)
  assert.equal(readProfile(root, PID, p.uid).sketch, '原样')
})

test('人物：证据指针要真能解析；有效时写进原因里', () => {
  const root = tmpRoot()
  const p = createPerson(root, { display: '张三' })
  writeProfile(root, PID, p.uid, { sketch: '' })
  seedRaw(root)

  assert.throws(
    () => setImpression(root, PID, 'person', p.uid, { text: 'x', reason: 'y', evidence: 'raw/2026-11/07/qq.ndjson#nope' }),
    /证据/,
  )

  const good = seedRaw(root)
  const r = setImpression(root, PID, 'person', p.uid, {
    text: '他说话喜欢先给结论',
    reason: '这几轮都是先下判断再解释',
    evidence: good.pointer,
  })
  assert.match(r.reason, /证据：raw\//)
})

test('人物：只改已有档案的人，不凭空造卡', () => {
  const root = tmpRoot()
  assert.throws(() => setImpression(root, PID, 'person', 'person_nobody', { text: 'x', reason: 'y' }), /还没有/)
})

test('人物：内容没变就不产生新版本', () => {
  const root = tmpRoot()
  const p = createPerson(root, { display: '张三' })
  writeProfile(root, PID, p.uid, { sketch: '' })
  setImpression(root, PID, 'person', p.uid, { text: '稳定的一句话', reason: '第一次' })
  const n = history(root, personProfileRel(PID, p.uid)).length

  const r = setImpression(root, PID, 'person', p.uid, { text: '稳定的一句话', reason: '又写了一遍' })
  assert.equal(r.changed, false)
  assert.equal(history(root, personProfileRel(PID, p.uid)).length, n)
})

// ── 历史：她怎么变成现在这么看他的 ──────────────────────────────────────

test('历史：每一版都带时间、谁写的、为什么，以及那一版的原文', () => {
  const root = tmpRoot()
  const p = createPerson(root, { display: '张三' })
  writeProfile(root, PID, p.uid, { sketch: '' })
  setImpression(root, PID, 'person', p.uid, { text: '一版：话少', reason: '刚认识，他说话很短' })
  setImpression(root, PID, 'person', p.uid, { text: '二版：话少但爱讲事故', reason: '聊了几次，主题都是线上事故' })

  const h = impressionHistory(root, PID, 'person', p.uid, { limit: 10 })
  assert.ok(h.total >= 2)
  const last = h.entries.at(-1)
  assert.equal(last.text, '二版：话少但爱讲事故')
  assert.match(last.reason, /线上事故/)
  assert.equal(last.actor, 'model:observe')
  assert.ok(last.at, '历史必须带时间')
})

test('历史：渲染出来的文本里既有现在的印象，也有变化过程', () => {
  const root = tmpRoot()
  const p = createPerson(root, { display: '张三' })
  writeProfile(root, PID, p.uid, { sketch: '' })
  setImpression(root, PID, 'person', p.uid, { text: '当前这一版', reason: '因为他最近只聊这件事' })

  const text = renderImpression(root, PID, 'person', p.uid, { withHistory: true })
  assert.match(text, /当前这一版/)
  assert.match(text, /印象的变化/)
  assert.match(text, /因为他最近只聊这件事/)
})

// ── 群体：同一套逻辑 ────────────────────────────────────────────────────

test('群体：写描述也是整段覆盖 + 记原因', () => {
  const root = tmpRoot()
  writeGroup(root, PID, 'qq:555', { name: '摸鱼群', feature: '旧描述' })

  const r = setImpression(root, PID, 'group', 'qq:555', {
    text: '一群下班后还在聊技术的人，嘴上说摸鱼，实际都在折腾项目',
    reason: '连着看了几天，话题从没离开过项目和键盘',
  })
  assert.equal(r.changed, true)
  assert.match(readGroup(root, PID, 'qq:555').feature, /下班后/)
})

test('群体：历史同样能读回来（和人物一个形状）', () => {
  const root = tmpRoot()
  writeGroup(root, PID, 'qq:555', { name: '摸鱼群', feature: '' })
  setImpression(root, PID, 'group', 'qq:555', { text: '一版', reason: '刚进来' })
  setImpression(root, PID, 'group', 'qq:555', { text: '二版', reason: '看了几天，改主意了' })

  const h = impressionHistory(root, PID, 'group', 'qq:555')
  assert.equal(h.entries.at(-1).text, '二版')
  assert.match(h.entries.at(-1).reason, /改主意/)
  assert.ok(history(root, groupRel(PID, 'qq:555')).length >= 2)
})

test('kind 写错直接报错，不猜', () => {
  const root = tmpRoot()
  assert.throws(() => setImpression(root, PID, 'persona', 'x', { text: 'a', reason: 'b' }), /kind/)
})

// ── MCP 工具 ────────────────────────────────────────────────────────────

let root
let child
let call
let nextId = 1
let uid

function makeClient(proc) {
  const pending = new Map()
  const rl = readline.createInterface({ input: proc.stdout })
  rl.on('line', (line) => {
    let msg = null
    try {
      msg = JSON.parse(line)
    } catch {
      return
    }
    const waiter = msg?.id !== undefined ? pending.get(msg.id) : null
    if (waiter) {
      pending.delete(msg.id)
      waiter.resolve(msg)
    }
  })
  return (method, params) => {
    const id = nextId++
    proc.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`)
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject })
      setTimeout(() => {
        if (!pending.has(id)) return
        pending.delete(id)
        reject(new Error(`MCP 无响应：${method}`))
      }, 8000).unref?.()
    })
  }
}

const tool = (name, args) => call('tools/call', { name, arguments: args })
const toolText = (res) => {
  assert.equal(res?.result?.isError, false, `工具不该报错：${res?.result?.content?.[0]?.text ?? ''}`)
  return res.result.content.map((c) => c.text).join('\n')
}

before(async () => {
  root = tmpRoot()
  const p = createPerson(root, { display: '张三' })
  uid = p.uid
  linkIdentity(root, uid, { platform: 'qq', id: '111' })
  writeProfile(root, PID, uid, { sketch: '还没什么印象' })
  writeGroup(root, PID, 'qq:555', { name: '摸鱼群' })

  child = spawn(process.execPath, [SERVER, '--root', root], {
    env: { ...process.env, YUANLING_HOME: '' },
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  call = makeClient(child)
  await call('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test' } })
})

after(() => {
  child?.kill()
})

test('tools/list 里有 yuanling_observe', async () => {
  const res = await call('tools/list', {})
  const names = res.result.tools.map((t) => t.name).sort()
  assert.deepEqual(names, [
    'yuanling_context',
    'yuanling_drive',
    'yuanling_fetch',
    'yuanling_group',
    'yuanling_observe',
    'yuanling_person_account',
    'yuanling_purpose',
    'yuanling_recall',
    'yuanling_remember',
    'yuanling_sources',
    'yuanling_style',
  ])
})

test('observe：写人物的印象，再读回来', async () => {
  const w = toolText(
    await tool('yuanling_observe', {
      kind: 'person',
      id: uid,
      text: '写代码的人，喜欢先看日志再猜原因',
      reason: '他连着三次都是先要日志',
    }),
  )
  assert.match(w, /已更新/)

  const r = toolText(await tool('yuanling_observe', { kind: 'person', id: uid }))
  assert.match(r, /先看日志/)
})

test('observe：withHistory 能看到自己的印象是怎么变的', async () => {
  toolText(await tool('yuanling_observe', { kind: 'person', id: uid, text: '第二版印象：更安静了', reason: '这周他几乎不说话' }))
  const r = toolText(await tool('yuanling_observe', { kind: 'person', id: uid, withHistory: true }))
  assert.match(r, /第二版印象/)
  assert.match(r, /印象的变化/)
  assert.match(r, /这周他几乎不说话/)
})

test('observe：群体走同一套（写 feature）', async () => {
  // 先让这个群存在（收到过群消息 / 回填过才会有卡）
  const gid = ensureGroupScene(root, { platform: 'qq', nativeId: '555' })
  ensureGroup(root, 'yuanling', gid, {})

  toolText(
    await tool('yuanling_observe', {
      kind: 'group',
      id: gid,
      text: '一群下班后还在折腾项目的人',
      reason: '连着几天都是这类话题',
    }),
  )
  const r = toolText(await tool('yuanling_group', { gid }))
  assert.match(r, /下班后/)
})

test('observe：缺 reason / 超长 → 明确报错，不静默截断', async () => {
  const noReason = await tool('yuanling_observe', { kind: 'person', id: uid, text: '没写原因' })
  assert.equal(noReason.result.isError, true)
  assert.match(noReason.result.content.map((c) => c.text).join('\n'), /reason/)

  const tooLong = await tool('yuanling_observe', { kind: 'person', id: uid, text: '啊'.repeat(300), reason: '想写长点' })
  assert.equal(tooLong.result.isError, true)
  assert.match(tooLong.result.content.map((c) => c.text).join('\n'), /太长/)
})
