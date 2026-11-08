// src/core/server.js —— 回环 HTTP：管理台静态页 + 只读 API + 生产者投递入口。
// 只绑 127.0.0.1；/api 与 /inbox 都要 token；静态页不要 token（页面自己会让你填）。
import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { exists, ensureDir, writeJsonAtomic, localIso } from './fsx.js'
import { P } from './paths.js'
import { ingest, healthReport } from './inbox.js'
import { handleApi, handleApiWrite, handleModuleInstallFromUrl } from './api.js'
const BODY_LIMIT = 4 * 1024 * 1024
const WEB_ROOT = fileURLToPath(new URL('../../web/', import.meta.url))

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
}

export function readToken(root) {
  const p = path.join(root, P.consoleToken)
  if (!exists(p)) return null
  return fs.readFileSync(p, 'utf8').trim()
}

function tokenOf(req) {
  const h = req.headers['x-yuanling-token']
  if (typeof h === 'string' && h) return h.trim()
  const auth = req.headers.authorization
  if (typeof auth === 'string' && auth.toLowerCase().startsWith('bearer ')) return auth.slice(7).trim()
  return null
}

function json(res, code, obj) {
  const body = JSON.stringify(obj)
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' })
  res.end(body)
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks = []
    req.on('data', (c) => {
      size += c.length
      if (size > BODY_LIMIT) {
        reject(Object.assign(new Error('请求体过大'), { code: 413 }))
        req.destroy()
        return
      }
      chunks.push(c)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

/** 静态页：不许穿越出 web/ 目录。 */
function serveStatic(res, pathname) {
  let rel
  try {
    rel = pathname === '/' ? 'index.html' : decodeURIComponent(pathname).replace(/^\/+/, '')
  } catch {
    return false // 非法编码：当作不存在
  }
  const rootAbs = path.resolve(WEB_ROOT)
  const abs = path.resolve(rootAbs, rel)
  if (abs !== rootAbs && !abs.startsWith(rootAbs + path.sep)) return false
  if (!exists(abs)) return false
  const ext = path.extname(abs).toLowerCase()
  res.writeHead(200, { 'content-type': MIME[ext] ?? 'application/octet-stream' })
  res.end(fs.readFileSync(abs))
  return true
}

/**
 * 把「控制台现在在哪个端口」写到数据目录里。
 *
 * 为什么要这个文件：控制台端口可以是 0（系统随机分配），而模型工具跑在
 * **另一个进程**（mcp-server）里，它没法知道随机端口。写一个自以为是的
 * "默认 17777" 只会在换了端口时静默连错地方。
 */
export function writeConsoleRuntime(root, { url, port, host }) {
  const p = path.join(root, P.consoleRuntime)
  ensureDir(path.dirname(p))
  writeJsonAtomic(p, { url, port, host, pid: process.pid, at: localIso() })
  return p
}

/** 关掉时清掉自己的那份记录；pid 不符就别动（不是我们写的）。 */
export function clearConsoleRuntime(root) {
  const p = path.join(root, P.consoleRuntime)
  try {
    if (!exists(p)) return
    const cur = JSON.parse(fs.readFileSync(p, 'utf8'))
    if (cur?.pid && cur.pid !== process.pid) return
    fs.unlinkSync(p)
  } catch {
    /* 清不掉不影响主流程，mcp-server 那边会拿到连接失败并如实说 */
  }
}

/**
 * @param {string} root
 * @param {{token?: string, meta?: object, onSourceFetch?: Function}} opts
 */
export function createServer(root, { token = readToken(root), meta = null, onSourceFetch = null } = {}) {
  if (!token) throw new Error('控制台令牌不存在，先跑 yuanling init 或 yuanling token --reset')

  return http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1')
    const given = tokenOf(req)

    // 1) 生产者投递
    if (url.pathname === '/inbox' && req.method === 'POST') {
      if (given !== token) return json(res, 401, { ok: false, error: 'bad token' })
      let text = ''
      try {
        text = await readBody(req)
      } catch (err) {
        return json(res, err.code ?? 400, { ok: false, error: String(err.message) })
      }
      let payload
      try {
        payload = JSON.parse(text || 'null')
      } catch {
        return json(res, 400, { ok: false, error: 'body 不是合法 JSON' })
      }
      const envelopes = Array.isArray(payload) ? payload : [payload]
      const total = { accepted: 0, deduped: 0, skipped: 0, errors: [] }
      for (const env of envelopes) {
        try {
          const r = ingest(root, env)
          total.accepted += r.accepted
          total.deduped += r.deduped
          total.skipped += r.skipped
          total.errors.push(...r.errors)
        } catch (err) {
          total.errors.push(String(err?.message ?? err))
        }
      }
      const code = total.errors.length && !total.accepted ? 400 : 200
      return json(res, code, { ok: code === 200, ...total })
    }

    // 2) 健康检查（给脚本用）
    // 免令牌的 /root：排查"管理台到底在服务哪个数据目录"。
    // 之前踩过：设置页改成 D:\yuanling 后没重启，控制台仍在服务旧目录，
    // 于是令牌永远对不上（两边是不同的 console.token），而界面上毫无提示。
    if (url.pathname === '/root') {
      // meta 里带着"这个进程以为自己拿到的配置"，用来分辨
      // 「设置页读的是新配置、进程还活在新配置上」到底哪一步没生效。
      return json(res, 200, { ok: true, service: 'yuanling', root, meta })
    }

    if (url.pathname === '/health') {
      if (given !== token) return json(res, 401, { ok: false, error: 'bad token' })
      return json(res, 200, { ok: true, service: 'yuanling', sources: healthReport(root) })
    }

    // 3) 管理台 API（GET 只读，POST 写入；都要 token）
    if (url.pathname.startsWith('/api/')) {
      if (given !== token) return json(res, 401, { ok: false, error: 'bad token' })

      if (req.method === 'POST') {
        let text = ''
        try {
          text = await readBody(req)
        } catch (err) {
          return json(res, err.code ?? 400, { ok: false, error: String(err.message) })
        }
        let body
        try {
          body = JSON.parse(text || '{}')
        } catch {
          return json(res, 400, { ok: false, error: 'body 不是合法 JSON' })
        }

        // 取数要跟**活着的模块进程**说话，而进程只存在于插件宿主里，
        // 所以这条路由不能走 api.js（那是无状态的）——它由宿主注入回调。
        if (url.pathname === '/api/sources/fetch') {
          if (!onSourceFetch) {
            return json(res, 503, {
              ok: false,
              error: '这个进程没有模块宿主（CLI 起的控制台不带取数能力）；用 DSH 里的插件时才有',
            })
          }
          try {
            const r = await onSourceFetch({
              source: String(body.source ?? ''),
              params: body.params && typeof body.params === 'object' ? body.params : {},
              limit: Number(body.limit) || undefined,
            })
            return json(res, 200, { ok: true, ...r })
          } catch (err) {
            const code = err?.code ?? ''
            const status = code === 'E_NO_ROUTE' ? 404 : code === 'E_NO_CAP' ? 403 : code === 'E_RATE' ? 429 : 400
            return json(res, status, { ok: false, code, error: String(err?.message ?? err) })
          }
        }

        // 从网址装模块：要联网（查发行版、下 tgz），所以必须 await。
        // 时间给足：Gitee/GitHub 查一次 + 下载一个 20KB 的包，但国内网络会慢。
        if (url.pathname === '/api/modules/install-url') {
          const w = await handleModuleInstallFromUrl(root, body)
          return json(res, w.status, w.body)
        }

        const w = handleApiWrite(root, url, body)
        return json(res, w.status, w.body)
      }

      const r = handleApi(root, url)
      return json(res, r.status, r.body)
    }

    // 4) 静态页
    if (req.method === 'GET' && serveStatic(res, url.pathname)) return

    return json(res, 404, { ok: false, error: 'not found' })
  })
}

/**
 * 启动并监听。port=0 时由系统分配。
 *
 * `unref` 是给「跑在别人进程里」的场景用的（DSH 插件）：监听句柄默认会把事件循环
 * 钉住，宿主关停时等不到进程退出 → `graceful deadline exceeded`。unref 之后句柄
 * 不参与「有没有活干」的判定，宿主可以随时退出，而服务在宿主活着时照常工作。
 * CLI（`yuanling serve`）不要开它，否则进程启动完就退出。
 *
 * @returns {Promise<{server:http.Server, port:number, url:string}>}
 */
export function listen(root, { port = 17777, host = '127.0.0.1', meta = null, token, unref = false, onSourceFetch = null } = {}) {
  const server = createServer(root, {
    meta,
    onSourceFetch,
    ...(token === undefined ? {} : { token }),
  })
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, host, () => {
      const addr = server.address()
      const p = typeof addr === 'object' && addr ? addr.port : port
      if (unref) {
        server.unref()
        // keep-alive 连接也是独立句柄，同样不能钉住宿主
        server.on('connection', (socket) => socket.unref?.())
      }
      const url = `http://${host}:${p}`
      try {
        writeConsoleRuntime(root, { url, port: p, host })
      } catch {
        /* 写不进去也要把服务起起来：取数找不到地址是可降级的，控制台起不来是硬故障 */
      }
      server.once('close', () => clearConsoleRuntime(root))
      resolve({ server, port: p, url })
    })
  })
}

/**
 * 彻底关掉一个管理台 server。
 *
 * `server.close()` 只停止接受**新**连接，不销毁已经建立的 keep-alive 连接。
 * 浏览器里开过管理台时，那条 socket 会一直让事件循环活着，宿主关停时等不到
 * 进程退出，就报 `graceful deadline exceeded`（DSH 更新的常见失败）。
 * 所以顺序是：先掐空闲连接 → 再掐全部连接 → 最后关监听。
 *
 * @param {import('node:http').Server | null | undefined} server
 */
export function closeServer(server) {
  if (!server) return
  try {
    server.closeIdleConnections?.()
  } catch {
    /* 老版本 node 没有这个方法 */
  }
  try {
    server.closeAllConnections?.()
  } catch {
    /* 同上 */
  }
  try {
    server.close()
  } catch {
    /* 已经关了 */
  }
}
