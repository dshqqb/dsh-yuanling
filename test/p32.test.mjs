// test/p32.test.mjs —— CLI 的 module 子命令。
//
// 用临时数据目录跑真实的 main()，验的是"命令行这一层"的契约：
// 命令能不能装上、能不能拒掉危险操作、输出是否把话说清。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import zlib from 'node:zlib'

import { main } from '../src/core/cli.js'
import { scaffold } from '../src/core/scaffold.js'
import { readRegistry } from '../src/core/modules/registry.js'

function tmpRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'yuanling-p32-'))
  scaffold(root, {})
  return root
}

function makeTar(files) {
  const blocks = []
  for (const [name, content] of Object.entries(files)) {
    const data = Buffer.from(content)
    const header = Buffer.alloc(512)
    header.write(name, 0, 'utf8')
    header.write(data.length.toString(8).padStart(11, '0'), 124, 'utf8')
    header.write('0', 156, 'utf8')
    blocks.push(header, data)
    const pad = (512 - (data.length % 512)) % 512
    if (pad) blocks.push(Buffer.alloc(pad))
  }
  blocks.push(Buffer.alloc(1024))
  return zlib.gzipSync(Buffer.concat(blocks))
}

const MANIFEST = {
  id: 'demo',
  name: '演示',
  version: '0.1.0',
  api: '1.0',
  kind: 'gateway',
  entry: { command: ['node', 'index.mjs'] },
  capabilities: ['ingest.message'],
}

function makePkg(dir, manifest = MANIFEST) {
  const p = path.join(dir, `${manifest.id}-${manifest.version}.tgz`)
  fs.writeFileSync(
    p,
    makeTar({
      'yuanling.module.json': JSON.stringify(manifest, null, 2),
      'index.mjs': 'export default {}',
    }),
  )
  return p
}

/** 跑 main()，把输出收起来（不打印到测试日志里）。 */
async function run(argv) {
  const logs = []
  const errs = []
  const origOut = process.stdout.write.bind(process.stdout)
  const origErr = process.stderr.write.bind(process.stderr)
  process.stdout.write = (s) => {
    logs.push(String(s))
    return true
  }
  process.stderr.write = (s) => {
    errs.push(String(s))
    return true
  }
  try {
    const code = await main(argv)
    return { code, out: logs.join(''), err: errs.join('') }
  } finally {
    process.stdout.write = origOut
    process.stderr.write = origErr
  }
}

test('CLI：module list 空表时给安装提示，不报错', async () => {
  const root = tmpRoot()
  const r = await run(['module', 'list', '--root', root])
  assert.equal(r.code, 0)
  assert.match(r.out, /还没有安装模块/)
  assert.match(r.out, /module install --url/)
})

test('CLI：install --file 走通，注册表里有记录', async () => {
  const root = tmpRoot()
  const tgz = makePkg(root)

  const r = await run(['module', 'install', '--file', tgz, '--root', root])
  assert.equal(r.code, 0)
  assert.match(r.out, /已安装 demo v0\.1\.0/)
  assert.match(r.out, /sha256/)

  const reg = readRegistry(root)
  assert.equal(reg.modules.demo.version, '0.1.0')
})

test('CLI：install 缺参数时报用法，不崩', async () => {
  const root = tmpRoot()
  const r = await run(['module', 'install', '--root', root])
  assert.equal(r.code, 2)
  assert.match(r.err, /--url|--file/)
})

test('CLI：install --file 指向不存在的文件 → 明确报错', async () => {
  const root = tmpRoot()
  const r = await run(['module', 'install', '--file', path.join(root, 'nope.tgz'), '--root', root])
  assert.equal(r.code, 2)
  assert.match(r.err, /找不到文件/)
})

test('CLI：show 给出关键字段；不存在的 id 报错', async () => {
  const root = tmpRoot()
  await run(['module', 'install', '--file', makePkg(root), '--root', root])

  const ok = await run(['module', 'show', 'demo', '--root', root])
  assert.equal(ok.code, 0)
  assert.match(ok.out, /v0\.1\.0/)
  assert.match(ok.out, /ingest\.message/)

  const bad = await run(['module', 'show', 'nope', '--root', root])
  assert.equal(bad.code, 2)
  assert.match(bad.err, /没有这个模块/)
})

test('CLI：grant 只能给声明过的能力（send 不在声明里 → 拒）', async () => {
  const root = tmpRoot()
  await run(['module', 'install', '--file', makePkg(root), '--root', root])

  const r = await run(['module', 'grant', 'demo', 'send', 'off', '--root', root])
  assert.notEqual(r.code, 0)
  assert.match(r.err, /没有声明/)
})

test('CLI：export 产出 tgz 并给出可用的安装命令', async () => {
  const root = tmpRoot()
  await run(['module', 'install', '--file', makePkg(root), '--root', root])

  const r = await run(['module', 'export', 'demo', '--root', root])
  assert.equal(r.code, 0)
  const m = /已导出 ([^（\n]+)/.exec(r.out)
  assert.ok(m, '应该打印导出路径')
  assert.ok(fs.existsSync(m[1].trim()), '导出的文件要真的存在')
  assert.match(r.out, /module install --file/)
})

test('CLI：disable 写进注册表（持久停用）', async () => {
  const root = tmpRoot()
  await run(['module', 'install', '--file', makePkg(root), '--root', root])

  const r = await run(['module', 'disable', 'demo', '--root', root])
  assert.equal(r.code, 0)
  assert.equal(readRegistry(root).modules.demo.enabled, false)
  assert.match(r.out, /重启 DSH 也不会自动启动/)
})

test('CLI：uninstall 不给 --yes 时拒绝并说明后果', async () => {
  const root = tmpRoot()
  await run(['module', 'install', '--file', makePkg(root), '--root', root])

  const r = await run(['module', 'uninstall', 'demo', '--root', root])
  assert.equal(r.code, 2)
  assert.match(r.err, /加 --yes/)

  // 加 --yes 才真的删
  const ok = await run(['module', 'uninstall', 'demo', '--yes', '--root', root])
  assert.equal(ok.code, 0)
  assert.deepEqual(readRegistry(root).modules, {})
})
