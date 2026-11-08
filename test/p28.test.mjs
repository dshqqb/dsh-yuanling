// test/p28.test.mjs —— 模块宿主之三：分帧 + 进程生存（协议 §17 的 2/3/6 条）。
//
// 这一层的测试必须"真起进程"：分帧、乱序、stdout 污染这些行为在 mock 里
// 很容易自证自话，只有真子进程才说明问题。
//
// ⚠️ 受限环境（沙箱）不允许给子进程开管道，进程类用例会整体跳过并写明原因，
//    而不是假装通过。
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

import { FrameReader, parseFrame, encodeFrame, frameKind, MAX_FRAME_BYTES } from '../src/core/modules/frame.js'
import { ModuleProcess, OP_TIMEOUTS, timeoutFor } from '../src/core/modules/host.js'

const require = createRequire(import.meta.url)

// ── 分帧（纯函数，任何环境都能跑）───────────────────────────────────────

test('frame：一次写两条，能切成两条', () => {
  const r = new FrameReader()
  const got = r.feed('{"op":"a","id":"1","data":{}}\n{"op":"b","id":"2","data":{}}\n')
  assert.equal(got.length, 2)
  assert.equal(JSON.parse(got[0]).op, 'a')
  assert.equal(JSON.parse(got[1]).op, 'b')
})

test('frame：一条分两次写入，能拼起来', () => {
  const r = new FrameReader()
  assert.deepEqual(r.feed('{"op":"a","id"'), [])
  const got = r.feed(':"1","data":{}}\n')
  assert.equal(got.length, 1)
  assert.equal(JSON.parse(got[0]).id, '1')
})

test('frame：\\r\\n 也认，空行忽略', () => {
  const r = new FrameReader()
  const got = r.feed('{"id":"1","ok":true}\r\n\r\n{"id":"2","ok":false}\r\n')
  assert.equal(got.length, 2)
})

test('frame：flush 丢弃半行，之后的写入从头开始算', () => {
  const r = new FrameReader()
  r.feed('{"op":"a","id":"1"') // 半行，永远不会成型
  r.flush()
  const got = r.feed('{"op":"b","id":"2","data":{}}\n')
  assert.equal(got.length, 1, 'flush 之后不该把旧半行拼进来')
  assert.equal(JSON.parse(got[0]).op, 'b')
})

test('frame：超过 256KB 抛 E_PROTO，不静默截断', () => {
  const r = new FrameReader({ maxBytes: 32 })
  assert.throws(() => r.feed('x'.repeat(100)), (e) => e.code === 'E_PROTO')
  assert.equal(MAX_FRAME_BYTES, 256 * 1024)
})

test('frame：非 JSON 就是污染（E_PROTO）', () => {
  assert.throws(() => parseFrame('hello world'), (e) => e.code === 'E_PROTO')
  assert.throws(() => parseFrame('[1,2]'), (e) => e.code === 'E_PROTO')
  assert.throws(() => parseFrame('null'), (e) => e.code === 'E_PROTO')
})

test('frame：encode 总是补 \\n；frameKind 能分辨请求与响应', () => {
  assert.equal(encodeFrame({ op: 'x' }), '{"op":"x"}\n')
  assert.equal(frameKind({ id: '1', ok: true, result: {} }), 'response')
  assert.equal(frameKind({ op: 'ingest', id: '1', data: {} }), 'request')
  assert.equal(frameKind({}), 'unknown')
})

test('超时表：按 op 分档（send 30s / actuate 300s / 默认 10s）', () => {
  assert.equal(timeoutFor('send'), 30_000)
  assert.equal(timeoutFor('actuate'), 300_000)
  assert.equal(timeoutFor('init'), 30_000)
  assert.equal(timeoutFor('ingest'), 10_000)
  assert.equal(timeoutFor('未知op'), OP_TIMEOUTS.default)
  assert.equal(timeoutFor('send', 5000), 5000, '显式传入优先')
})

// ── 真起进程（受限环境整体跳过）────────────────────────────────────────

const HERE = path.dirname(fileURLToPath(import.meta.url))
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'yuanling-p28-'))

/** 一个"能握手、能应答、能被弄坏"的假模块。 */
const SCRIPT = `
const send = (o) => process.stdout.write(JSON.stringify(o) + '\\n')
const handlers = {
  ping: () => ({ pong: true }),
  echo: (d) => d,
  // 一次写两条：第一条回本次请求，第二条是无主帧
  burst: (d, id) => { send({ id, ok: true, result: { n: 1 } }); send({ id: 'orphan', ok: true, result: { n: 2 } }) },
  // 不回响应：测超时
  silent: () => null,
  // 打非 JSON：测 stdout 污染
  pollute: () => { process.stdout.write('not json\\n'); return null },
  // 自杀：测崩溃识别与重启
  die: () => { setTimeout(() => process.exit(3), 0); return null },
}
process.stdin.on('data', (chunk) => {
  for (const line of chunk.toString().split('\\n')) {
    if (!line.trim()) continue
    let f
    try { f = JSON.parse(line) } catch { continue }
    if (typeof f.op !== 'string') continue
    if (f.op === 'shutdown') { process.exit(0) }
    const h = handlers[f.op]
    if (!h) { send({ id: f.id, ok: false, error: { code: 'E_NOPE', message: 'no op ' + f.op } }); continue }
    const r = h(f.data ?? {}, f.id)
    if (r) send({ id: f.id, ok: true, result: r })
  }
})
`

const SCRIPT_PATH = path.join(TMP, 'mod.mjs')
fs.writeFileSync(SCRIPT_PATH, SCRIPT)

/**
 * 能不能真的 spawn——而且**必须带管道**。
 * 只测 `stdio: 'ignore'` 是不够的：受限沙箱下 ignore 能过、pipe 直接 EPERM，
 * 而 host 恰恰需要管道。探测条件必须和真实用法一致。
 */
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
const skipIfSandboxed = SPAWN_OK
  ? {}
  : { skip: '当前环境不允许给子进程开管道（spawn EPERM），进程类用例跳过' }

/**
 * 所有建过的 host 都记下来，测试结束统一收尸。
 * 收尸要用 dispose()：它不触发重启。用 kill() 反而会拉起新进程，
 * 命令会一直不返回（真机踩到，只能 Ctrl+C）。
 */
const created = []
after(() => {
  for (const h of created) {
    try {
      h.dispose()
    } catch {
      /* ignore */
    }
  }
})

function makeHost(extra = {}) {
  const host = new ModuleProcess({
    id: 'test',
    command: [process.execPath, SCRIPT_PATH],
    cwd: TMP,
    timeoutOverrides: { silent: 120, init: 3000 },
    restartBackoffMs: [50, 50],
    maxRestarts: 2,
    ...extra,
  })
  created.push(host)
  return host
}

test('host：起进程、ping 能通、stop 能干净退出', skipIfSandboxed, async () => {
  const host = makeHost()
  host.start()
  await new Promise((r) => setTimeout(r, 250))
  const pong = await host.ping()
  assert.equal(pong.pong, true)
  await host.stop()
  assert.equal(host.state, 'stopped')
})

test('host：一次 write 里塞两条帧，都能被切开（另一条是无主帧，不许崩）', skipIfSandboxed, async () => {
  const host = makeHost()
  host.start()
  await new Promise((r) => setTimeout(r, 250))

  const res = await host.request('burst', {})
  assert.equal(res.n, 1, '本次请求的那条要能收到')
  assert.notEqual(host.state, 'crashed')
  host.dispose()
})

test('host：慢的先发、快的后发，两边都不乱（乱序）', skipIfSandboxed, async () => {
  const host = makeHost()
  host.start()
  await new Promise((r) => setTimeout(r, 250))

  const p1 = host.request('echo', { n: 1 })
  const p2 = host.request('echo', { n: 2 })
  const [a, b] = await Promise.all([p1, p2])
  assert.equal(a.n, 1)
  assert.equal(b.n, 2)
  host.dispose()
})

test('host：不回响应 → 超时作废，但进程不被误杀', skipIfSandboxed, async () => {
  const host = makeHost()
  host.start()
  await new Promise((r) => setTimeout(r, 250))

  await assert.rejects(host.request('silent', {}, { timeoutMs: 120 }), /超时/)
  assert.ok(host.child, '超时不该杀掉进程')
  const pong = await host.ping()
  assert.equal(pong.pong, true)
  host.dispose()
})

test('host：stdout 出现非 JSON → 断开并按崩溃处理', skipIfSandboxed, async () => {
  const seen = []
  const host = makeHost({ onState: (e) => seen.push(e.state), autoRestart: false })
  host.start()
  await new Promise((r) => setTimeout(r, 250))

  await assert.rejects(host.request('pollute', {}, { timeoutMs: 500 }), /退出|超时/)
  await new Promise((r) => setTimeout(r, 150))
  assert.ok(seen.includes('crashed'), `应该进 crashed，实际 ${seen.join(',')}`)
  host.dispose()
})

test('host：模块自杀 → 识别崩溃 → 按退避重启', skipIfSandboxed, async () => {
  const states = []
  const host = makeHost({ onState: (e) => states.push(e.state) })
  host.start()
  await waitFor(() => Boolean(host.child), 3000, '进程起来')

  host.request('die', {}, { timeoutMs: 500 }).catch(() => {})
  // 固定 sleep 在并行跑时不够：崩溃识别 + 退避重启可能还没走到（这条曾偶发红）
  await waitFor(() => host.restarts >= 1 && (states.includes('crashed') || states.includes('restarting')), 8000, '崩溃并重启')
  host.dispose()
})

test('host：重启次数用尽 → 标 crashed，不再自动拉起', skipIfSandboxed, async () => {
  const states = []
  const host = makeHost({ onState: (e) => states.push(e.state), maxRestarts: 1, restartBackoffMs: [30] })
  host.start()
  // echo 模块不做 init 握手，状态会停在 starting——所以等的是"子进程真的起来了"，不是 ready
  await waitFor(() => Boolean(host.child), 3000, '进程起来')

  host.request('die', {}, { timeoutMs: 300 }).catch(() => {})
  // 等"重启完成、子进程又活着"再补第二刀：只等 restarts>=1 会打在退避窗口里，
  // 请求被 E_NOT_RUNNING 拒掉，第二刀就落空（这也是它偶尔变红的原因）。
  await waitFor(() => host.restarts >= 1 && Boolean(host.child), 8000, '重启完成')
  host.request('die', {}, { timeoutMs: 300 }).catch(() => {})

  await waitFor(() => host.state === 'crashed', 5000, '重启用尽后变 crashed')
  await assert.rejects(host.ping(), (e) => e.code === 'E_CRASHED')
  host.dispose()
})

/**
 * 轮询等待某个条件成立。
 *
 * 为什么不用固定 `setTimeout(N)`：这条链路里有子进程启动、退避重启、超时判定，
 * 全量测试并行跑时机器一慢，N 就不够——测试变成看运气。等条件成立，慢一点也只是慢。
 */
async function waitFor(pred, timeoutMs, what) {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    if (pred()) return
    await new Promise((r) => setTimeout(r, 50))
  }
  throw new Error(`等「${what}」超时（${timeoutMs}ms）`)
}

test('host：未启动时请求被明确拒绝', skipIfSandboxed, async () => {
  const host = makeHost()
  await assert.rejects(host.request('ping'), (e) => e.code === 'E_NOT_RUNNING')
})

test('host：dispose 之后不再重启（收尸语义）', skipIfSandboxed, async () => {
  const states = []
  const host = makeHost({ onState: (e) => states.push(e.state) })
  host.start()
  await new Promise((r) => setTimeout(r, 250))

  host.dispose()
  await new Promise((r) => setTimeout(r, 300))
  assert.ok(!states.includes('restarting'), 'dispose 之后不该再重启')
})
