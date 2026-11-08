// test/p33.test.mjs —— 协议 §17 第 1 条与第 7 条（真进程端到端）。
//
// 第 1 条：Windows spawn，路径含空格与中文，不炸。
// 第 7 条：模块 ingest 一条消息 → 落 raw/<月>/<日>/<source>.ndjson → 回 {accepted:1} → shutdown 干净退出。
//
// 这两条只有在真起进程时才有意义，所以沙箱禁止管道 spawn 时整体跳过（并写明原因）。
//
// ⚠️ 目录名里的中文与空格是刻意的：Windows + 中文路径是本项目最容易出事的地方。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'

import { scaffold } from '../src/core/scaffold.js'
import { listDays, readDay, appendRecord } from '../src/core/raw.js'
import { ModuleService } from '../src/core/modules/service.js'
import { readRegistry } from '../src/core/modules/registry.js'
import { installFromBytes } from '../src/core/modules/installer.js'
import { localIso } from '../src/core/fsx.js'

const require = createRequire(import.meta.url)

function canSpawnWithPipes() {
  return new Promise((resolve) => {
    let done = false
    const finish = (ok) => {
      if (done) return
      done = true
      resolve(ok)
    }
    try {
      const { spawn } = require('node:child_process')
      const child = spawn(process.execPath, ['-e', '0'], { stdio: ['pipe', 'pipe', 'pipe'] })
      child.on('error', () => finish(false))
      child.on('exit', (code) => finish(code === 0))
      setTimeout(() => finish(false), 5000).unref?.()
    } catch {
      finish(false)
    }
  })
}

const SPAWN_OK = await canSpawnWithPipes()
const skip = SPAWN_OK ? {} : { skip: '当前环境不允许给子进程开管道（spawn EPERM），端到端用例跳过' }

/**
 * 建一个"路径含中文与空格"的数据目录（§17 第 1 条的要求）。
 */
function trickyRoot() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'yuanling-p33-'))
  const dir = path.join(base, '原灵 数据 目录')
  scaffold(dir, {})
  return dir
}

/** 装一个只会说协议、会回 ingest 的模块。 */
function installDemoModule(root) {
  const manifest = {
    id: 'demo',
    name: '演示',
    version: '0.1.0',
    api: '1.0',
    kind: 'gateway',
    entry: { command: ['node', 'index.mjs'] },
    capabilities: ['ingest.message'],
  }
  const code = `
const send = (o) => process.stdout.write(JSON.stringify(o) + '\\n')
process.stdin.on('data', (chunk) => {
  for (const line of chunk.toString().split('\\n')) {
    if (!line.trim()) continue
    let f
    try { f = JSON.parse(line) } catch { continue }
    if (f.op === 'shutdown') { process.exit(0) }
    if (f.op === 'init') send({ id: f.id, ok: true, result: { ready: true } })
    else if (f.op === 'ping') send({ id: f.id, ok: true, result: { pong: true } })
    else if (f.op === 'ingest') {
      const n = (f.data?.items ?? []).length
      send({ id: f.id, ok: true, result: { accepted: n, deduped: 0, skipped: 0, errors: [] } })
    }
    else send({ id: f.id, ok: false, error: { code: 'E_NOPE', message: 'no ' + f.op } })
  }
})
`
  const blocks = []
  const files = {
    'yuanling.module.json': JSON.stringify(manifest, null, 2),
    'index.mjs': code,
  }
  for (const [name, content] of Object.entries(files)) {
    const data = Buffer.from(content, 'utf8')
    const h = Buffer.alloc(512)
    h.write(name, 0, 'utf8')
    h.write(data.length.toString(8).padStart(11, '0'), 124, 'utf8')
    h.write('0', 156, 'utf8')
    blocks.push(h, data)
    const pad = (512 - (data.length % 512)) % 512
    if (pad) blocks.push(Buffer.alloc(pad))
  }
  blocks.push(Buffer.alloc(1024))
  const zlib = require('node:zlib')
  const bytes = zlib.gzipSync(Buffer.concat(blocks))

  return installFromBytes({ root, bytes, source: 'test' })
}

test('§17-1：路径含中文与空格的目录里，spawn 模块不炸', skip, async () => {
  const root = trickyRoot()
  installDemoModule(root)

  const svc = new ModuleService({ root })
  await svc.start('demo')
  const pong = await svc.procs.get('demo').ping()
  assert.equal(pong.pong, true, '中文/空格路径下 ping 应该能通')
  await svc.stopAll()
})

test('§17-7：ingest 一条 → 落 raw → 回 accepted:1 → shutdown 干净退出', skip, async () => {
  const root = trickyRoot()
  installDemoModule(root)

  // 核心侧的 ingest 处理器：写进 raw，返回统计
  const svc = new ModuleService({
    root,
    onIngest: ({ id, data }) => {
      const items = Array.isArray(data?.items) ? data.items : []
      const accepted = []
      for (const item of items) {
        appendRecord(root, {
          source: id, // **source 以核心盖章为准**（协议 §5.1）
          acct: String(item.acct ?? 'unknown'),
          channel: String(item.channel ?? 'private:unknown'),
          actor: { kind: 'member', id: String(item.actorId ?? '0'), name: String(item.actorName ?? '') },
          role: String(item.role ?? 'user'),
          text: String(item.text ?? ''),
          ts: String(item.ts ?? localIso()),
        })
        accepted.push(item)
      }
      return { accepted: accepted.length, deduped: 0, skipped: 0, errors: [] }
    },
  })

  await svc.start('demo')

  const res = await svc.handleModuleRequest('demo', {
    op: 'ingest',
    data: { items: [{ text: '这条消息应该落进 raw', ts: localIso() }] },
  })
  assert.equal(res.accepted, 1, '应该接受 1 条')

  // 落盘验证：raw/<月>/<日>/demo.ndjson 里能读到
  const days = listDays(root)
  assert.ok(days.length >= 1, '应该有当天的 raw')
  const recs = readDay(root, days[days.length - 1], { source: 'demo' })
  assert.equal(recs.length, 1, 'raw 里应该有这条记录')
  assert.match(recs[0].text, /应该落进 raw/)
  assert.equal(recs[0].source, 'demo', 'source 由核心盖章')

  // 干净退出：shutdown 之后进程不再活着
  await svc.stopAll()
  assert.equal(svc.procs.size, 0)
})

test('§17-7b：进程被外部弄死 → 记崩溃（不报 stopped）', skip, async () => {
  const root = trickyRoot()
  installDemoModule(root)

  // 关掉自动重启，这样状态会稳定停在 crashed，便于断言
  const svc = new ModuleService({ root })
  await svc.start('demo')

  const proc = svc.procs.get('demo')
  // kill() 的语义是"意外中断"（不设 stopping），所以会走 crash 流程。
  // 用 stop() 才是主动停 → 报 stopped。这两个别混（踩过）。
  proc.autoRestart = false
  proc.kill()
  await new Promise((r) => setTimeout(r, 300))

  const state = readRegistry(root).modules.demo.state
  assert.equal(state, 'crashed', `意外死亡要记成 crashed，实际 ${state}`)
  assert.ok(readRegistry(root).modules.demo.last_crash, '要留下 last_crash 记录')

  await svc.stopAll().catch(() => {})
})

test('§17-7c：主动 stop() 报 stopped，不记崩溃', skip, async () => {
  const root = trickyRoot()
  installDemoModule(root)

  const svc = new ModuleService({ root })
  await svc.start('demo')
  await svc.stop('demo')

  const entry = readRegistry(root).modules.demo
  assert.equal(entry.state, 'stopped')
  assert.equal(entry.last_crash, null, '正常停止不该留下崩溃记录')
})
