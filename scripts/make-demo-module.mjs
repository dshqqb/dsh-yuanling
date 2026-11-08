// 造一个可安装的模块 tgz，供 CLI 与真机验收用。
// 用法：node scripts/make-demo-module.mjs <输出目录>
import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'

const outDir = process.argv[2] ?? '.'
const manifest = {
  id: 'demo',
  name: '演示模块',
  description: '只用来验证安装链路：握手、ping、日志，不产生真实数据。',
  version: '0.1.0',
  api: '1.0',
  kind: 'gateway',
  entry: { command: ['node', 'index.mjs'] },
  capabilities: ['ingest.message'],
}

const MODULE = `
// demo 模块：只说协议，不干实事。
const send = (o) => process.stdout.write(JSON.stringify(o) + '\\n')
const log = (level, event) => send({ op: 'log', data: { level, event } })

let apiVersion = '1.0'

process.stdin.on('data', (chunk) => {
  for (const line of chunk.toString().split('\\n')) {
    if (!line.trim()) continue
    let f
    try { f = JSON.parse(line) } catch { continue }

    // 通知：shutdown
    if (f.op === 'shutdown') { process.exit(0) }

    if (f.op === 'init') {
      apiVersion = f.data?.api ?? apiVersion
      log('info', 'init 收到')
      send({ id: f.id, ok: true, result: { ready: true, api: apiVersion } })
    } else if (f.op === 'ping') {
      send({ id: f.id, ok: true, result: { pong: true } })
    } else if (f.op === 'ingest') {
      const items = f.data?.items ?? []
      log('info', 'ingest ' + items.length + ' 条')
      send({ id: f.id, ok: true, result: { accepted: items.length, deduped: 0, skipped: 0, errors: [] } })
    } else {
      send({ id: f.id, ok: false, error: { code: 'E_NOPE', message: '不支持：' + f.op } })
    }
  }
})
`

/** 写 512 字节 tar 头（size 用八进制，checksum 恰好 8 字节）。 */
function tarHeader(name, size) {
  const h = Buffer.alloc(512)
  h.write(String(name).slice(0, 100), 0, 'utf8')
  h.write('0000644\u0000', 100, 8)
  h.write('0000000\u0000', 108, 8)
  h.write('0000000\u0000', 116, 8)
  h.write(`${size.toString(8).padStart(10, '0')}\u0000`, 124, 11)
  h.write('00000000000\u0000', 136, 12)
  h.write('0', 156, 1)
  h.write('ustar\u0000', 257, 6)
  h.write('00', 263, 2)
  h.fill(0, 148, 156)
  let sum = 0
  for (let i = 0; i < 512; i += 1) sum += h[i]
  h.write(`${sum.toString(8).padStart(7, '0')}\u0000 `, 148, 8)
  return h
}

const files = {
  'yuanling.module.json': JSON.stringify(manifest, null, 2) + '\n',
  'index.mjs': MODULE,
  'README.md': '# 演示模块\n\n只用来验证安装链路。\n',
}

const blocks = []
for (const [name, content] of Object.entries(files)) {
  const data = Buffer.from(content, 'utf8')
  blocks.push(tarHeader(name, data.length), data)
  const pad = (512 - (data.length % 512)) % 512
  if (pad) blocks.push(Buffer.alloc(pad))
}
blocks.push(Buffer.alloc(1024))

const tgz = zlib.gzipSync(Buffer.concat(blocks))
const dest = path.join(outDir, 'demo-0.1.0.tgz')
fs.writeFileSync(dest, tgz)
console.log(`✓ ${dest}（${(tgz.length / 1024).toFixed(1)} KB）`)
