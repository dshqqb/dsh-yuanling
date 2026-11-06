// src/core/server.js —— 回环 HTTP：生产者可以 POST /inbox，而不是写文件。
// 只绑 127.0.0.1；每次请求都要 token。P1 只有两个端点。
import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import { exists } from './fsx.js'
import { P } from './paths.js'
import { ingest, healthReport } from './inbox.js'

const BODY_LIMIT = 4 * 1024 * 1024

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

/**
 * 建服务。不监听，交给 listen()。
 * @param {string} root
 * @param {{token?: string}} opts
 */
export function createServer(root, { token = readToken(root) } = {}) {
  if (!token) throw new Error('控制台令牌不存在，先跑 yuanling init 或 yuanling token --reset')

  return http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1')
    const given = tokenOf(req)

    if (url.pathname === '/health' || url.pathname === '/') {
      if (given !== token) return json(res, 401, { ok: false, error: 'bad token' })
      return json(res, 200, { ok: true, service: 'yuanling', sources: healthReport(root) })
    }

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

    return json(res, 404, { ok: false, error: 'not found' })
  })
}

/**
 * 启动并监听。port=0 时由系统分配，返回值里带真实端口。
 * @returns {Promise<{server:http.Server, port:number, url:string}>}
 */
export function listen(root, { port = 17777, host = '127.0.0.1' } = {}) {
  const server = createServer(root)
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, host, () => {
      const addr = server.address()
      const p = typeof addr === 'object' && addr ? addr.port : port
      resolve({ server, port: p, url: `http://${host}:${p}` })
    })
  })
}
