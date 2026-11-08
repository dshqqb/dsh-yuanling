// test/p39.test.mjs —— 启用/停用必须真的动进程。
//
// 这条 bug 的表现很隐晦：点「停用」，注册表 enabled 变了、按钮文字也变了，
// 但**进程还在跑**（因为只管写注册表）。再点「启用」时 start() 看到进程已在 →
// skipped: already-running → 两次点击都"没反应"。
//
// 所以这里测的不是"返回值对不对"，是**进程真的被停了 / 真的被起了**。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import zlib from 'node:zlib'

import { scaffold } from '../src/core/scaffold.js'
import { installFromBytes } from '../src/core/modules/installer.js'
import { ModuleService } from '../src/core/modules/service.js'
import { readRegistry } from '../src/core/modules/registry.js'
import { kickModule } from '../src/core/server.js'

const MANIFEST = {
  id: 'demo',
  name: '演示',
  version: '0.1.0',
  api: '1.1',
  kind: 'enricher',
  entry: { command: ['node', 'index.mjs'] },
}

const SRC = `
import readline from 'node:readline'
const send = (o) => process.stdout.write(JSON.stringify(o) + '\\n')
const rl = readline.createInterface({ input: process.stdin })
rl.on('line', (l) => {
  if (!l.trim()) return
  let q; try { q = JSON.parse(l) } catch { return }
  if (q.id == null) return
  if (q.op === 'init') return send({ id: q.id, ok: true, result: { ready: true, api: '1.1' } })
  if (q.op === 'ping') return send({ id: q.id, ok: true, result: { pong: true } })
  if (q.op === 'shutdown') { send({ id: q.id, ok: true, result: {} }); process.exit(0) }
  send({ id: q.id, ok: true, result: {} })
})
`

function makeTar(files) {
  const blocks = []
  for (const [name, content] of Object.entries(files)) {
    const data = Buffer.from(content)
    const h = Buffer.alloc(512)
    h.write(name, 0, 'utf8')
    h.write(data.length.toString(8).padStart(11, '0'), 124, 'utf8')
    h.write('0', 156, 'utf8')
    blocks.push(h, data)
    const pad = (512 - (data.length % 512)) % 512
    if (pad) blocks.push(Buffer.alloc(pad))
  }
  blocks.push(Buffer.alloc(1024))
  return zlib.gzipSync(Buffer.concat(blocks))
}

function withModule() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'yuanling-p39-'))
  scaffold(root, {})
  installFromBytes({
    root,
    bytes: makeTar({ 'yuanling.module.json': JSON.stringify(MANIFEST, null, 2), 'index.mjs': SRC }),
    source: 'test',
  })
  return root
}

/**
 * 等条件成立，而不是睡固定毫秒。
 * 全量并行跑时机器一慢，"起进程 + 握手"就可能超过 500ms——固定 sleep 会变成看运气。
 */
async function waitFor(pred, timeoutMs, what) {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    if (pred()) return
    await new Promise((r) => setTimeout(r, 50))
  }
  throw new Error(`等「${what}」超时（${timeoutMs}ms）`)
}

// ── 纯逻辑：三种语义各自透传什么 ────────────────────────────────────────

test('kick：停用传 enabled:false（宿主据此真停进程）', async () => {
  const calls = []
  const r = await kickModule({ ok: true, id: 'demo', enabled: false }, async (id, opts) => {
    calls.push({ id, opts })
    return { stopped: true }
  }, { enabled: false })
  assert.deepEqual(calls, [{ id: 'demo', opts: { enabled: false } }])
  assert.deepEqual(r.runtime, { stopped: true })
})

test('kick：启用不带停用标志', async () => {
  const calls = []
  await kickModule({ ok: true, id: 'demo', enabled: true }, async (id, opts) => {
    calls.push({ id, opts })
    return { started: true }
  }, { enabled: true })
  assert.deepEqual(calls, [{ id: 'demo', opts: { enabled: true } }])
})

// ── 真进程：停用要真的停 ────────────────────────────────────────────────

test('service：setEnabled(false) 之后进程真的不在了', async () => {
  const root = withModule()
  const svc = new ModuleService({ root })
  try {
    await svc.start('demo')
    await waitFor(() => Boolean(svc.procs.get('demo')?.child), 3000, '进程起来')

    // 这是"停用"该做的事：写注册表 + 停进程。只做前一半就是那个 bug
    svc.setEnabled('demo', false)
    await waitFor(() => !svc.procs.get('demo')?.child, 3000, '进程被停掉')

    assert.equal(readRegistry(root).modules.demo.enabled, false)
    assert.equal(svc.procs.get('demo')?.child ?? null, null, '进程必须真的停了，不只是改注册表')
    assert.equal(readRegistry(root).modules.demo.state, 'stopped')
  } finally {
    await svc.stopAll().catch(() => {})
  }
})

test('service：停用后再启用能真的重新起来（这才是"点两次都没反应"的回归）', async () => {
  const root = withModule()
  const svc = new ModuleService({ root })
  try {
    await svc.start('demo')
    await waitFor(() => Boolean(svc.procs.get('demo')?.child), 3000, '进程起来')

    svc.setEnabled('demo', false)
    await waitFor(() => !svc.procs.get('demo')?.child, 3000, '进程被停掉')

    svc.setEnabled('demo', true)
    await waitFor(() => Boolean(svc.procs.get('demo')?.child), 5000, '重新起来')
    await waitFor(() => readRegistry(root).modules.demo.state === 'ready', 5000, '握手完成')
  } finally {
    await svc.stopAll().catch(() => {})
  }
})

test('service：停用一个本来就没跑的模块不算错', async () => {
  const root = withModule()
  const svc = new ModuleService({ root })
  svc.setEnabled('demo', false)
  assert.equal(readRegistry(root).modules.demo.enabled, false)
})

test('service：停用的模块不会因为 restart 被偷偷起来', async () => {
  const root = withModule()
  const svc = new ModuleService({ root })
  svc.setEnabled('demo', false)
  const r = await svc.restart('demo')
  assert.equal(r.skipped, 'disabled', '配置变更也不该把停用的模块弄起来')
})
