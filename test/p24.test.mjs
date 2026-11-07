// test/p24.test.mjs —— 关停：插件卸载时必须真的把管理台关死。
//
// 真机现象：装了插件之后 DSH 无法完成更新，报
//   desktop update: Host did not complete graceful task teardown
//   (exit null, signal SIGTERM, shutdown acknowledged true, graceful deadline exceeded true)
//
// 根因有三层：
//   ① 监听句柄把宿主的事件循环钉住 → 宿主永远不退出（最要命，靠 unref 解决）；
//   ② server.close() 不销毁已建立的 keep-alive 连接；
//   ③ 动态 import 与 dispose 存在竞态 → 服务可能在关停之后才起来。
// 这几个都不是"看起来对不对"的问题，而是进程能不能退出的问题，所以必须有测试钉住。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { closeServer } from '../src/core/server.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const REPO = path.join(HERE, '..')
const read = (rel) => fs.readFileSync(path.join(REPO, rel), 'utf8')

const flush = (ms = 20) => new Promise((r) => setTimeout(r, ms))

async function waitFor(predicate, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return true
    await flush(10)
  }
  return predicate()
}

test('closeServer：keep-alive 连接会被销毁（否则宿主关停超时）', async () => {
  const server = http.createServer((req, res) => res.end('ok'))
  const sockets = new Set()
  server.on('connection', (socket) => {
    sockets.add(socket)
    socket.on('close', () => sockets.delete(socket))
  })

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address()

  const agent = new http.Agent({ keepAlive: true, maxSockets: 1 })
  await new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port, agent }, (res) => {
      res.resume()
      res.on('end', resolve)
    })
    req.on('error', reject)
  })

  // 复用连接：一条 socket 实例上跑两次请求
  await new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port, agent }, (res) => {
      res.resume()
      res.on('end', resolve)
    })
    req.on('error', reject)
  })

  assert.equal(sockets.size, 1, `keep-alive 应复用同一条 socket，实际 ${sockets.size}`)

  closeServer(server)

  const closed = await waitFor(() => sockets.size === 0)
  assert.ok(closed, 'keep-alive 连接没被销毁 —— 事件循环不会退出，DSH 更新必然卡在 graceful teardown')
  assert.equal(server.listening, false, '监听没有关闭')
  agent.destroy()
})

test('closeServer：null / 重复关闭都不抛', () => {
  assert.doesNotThrow(() => closeServer(null))
  assert.doesNotThrow(() => closeServer(undefined))
})

test('index.js：dispose 必须 async 等待启动，且在关停后立刻关掉刚起来的服务', () => {
  const code = read('index.js')
  assert.match(code, /ctx\.on\('dispose',\s*async\s*\(\)/, 'dispose 要是 async，才能 await 动态 import')
  assert.match(code, /await started/, 'dispose 必须等 started 落定，否则竞态下关不到服务')
  assert.match(code, /closeServer\?\.\(s\.server\)/, '启动晚于关停时，必须立刻关掉刚起来的 server')
})

test('server.js：closeServer 先掐连接再关监听', () => {
  const code = read('src/core/server.js')
  const idle = code.indexOf('closeIdleConnections')
  const all = code.indexOf('closeAllConnections')
  // 注释里也会提到 `server.close()`，所以取最后一次出现（真正的调用）
  const close = code.lastIndexOf('server.close()')
  assert.ok(idle > 0 && all > idle, '要先 closeIdleConnections 再 closeAllConnections')
  assert.ok(close > all, '最后才 close()')
})

// 这是整条修复里最硬的一条：监听句柄不能把宿主钉住。
// 做法是起一个子进程，开 unref 监听后什么都不做——它必须自己退出。
// 如果 listen 忘了 unref，子进程会挂住，测试超时失败。
test('listen(unref)：不关闭也不会钉住进程，子进程能自己退出', async () => {
  const serverFile = pathToFileURL(path.join(REPO, 'src/core/server.js')).href
  const script = `
    const { listen } = await import(${JSON.stringify(serverFile)})
    const r = await listen(${JSON.stringify(REPO)}, {
      port: 0, host: '127.0.0.1', token: 'test-token', unref: true,
    })
    console.log('UP ' + r.port)
    // 故意不关闭：unref 生效时进程应当自己退
  `
  const child = spawn(process.execPath, ['--input-type=module', '-e', script], {
    stdio: ['ignore', 'pipe', 'pipe'],
  })

  let out = ''
  child.stdout.on('data', (d) => {
    out += d
  })
  child.stderr.on('data', (d) => {
    out += d
  })

  const result = await new Promise((resolve) => {
    const timer = setTimeout(() => resolve('timeout'), 5000)
    child.on('exit', (code) => {
      clearTimeout(timer)
      resolve(code === 0 ? 'ok' : `exit ${code}`)
    })
  })

  if (result === 'timeout') child.kill()
  assert.equal(result, 'ok', `子进程没有自己退出（${result}）：监听句柄把事件循环钉住了。输出：${out.trim()}`)
  assert.match(out, /UP \d+/, '应当先打印出监听端口')
})
