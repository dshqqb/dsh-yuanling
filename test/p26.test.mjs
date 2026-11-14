// test/p26.test.mjs —— 模块宿主之一：manifest 校验 + tar 解包。
//
// 这两层是安装链的第一道门：manifest 坏了当场拒；tar 解错会把文件装到错地方，
// 而且"装上了但缺文件"极难排查。所以都按纯函数测。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import zlib from 'node:zlib'

import { validateManifest, checkApi, CAPABILITIES, RESERVED_IDS, summarizeErrors } from '../src/core/modules/manifest.js'
import { untar, stripPackagePrefix } from '../src/core/modules/untar.js'

const GOOD = {
  id: 'qq',
  version: '0.1.0',
  api: '1.0',
  kind: 'gateway',
  entry: { command: ['node', 'index.mjs'] },
  capabilities: ['ingest.message', 'send'],
}

// ── manifest ────────────────────────────────────────────────────────────

test('manifest：正常的一份通过，字段被规整', () => {
  const r = validateManifest(GOOD)
  assert.equal(r.ok, true)
  assert.equal(r.manifest.id, 'qq')
  assert.equal(r.manifest.kind, 'gateway')
  assert.deepEqual(r.manifest.entry.command, ['node', 'index.mjs'])
})

test('manifest：id 保留字被拒（会撞 raw 的来源名）', () => {
  const r = validateManifest({ ...GOOD, id: 'raw' })
  assert.equal(r.ok, false)
  assert.match(summarizeErrors(r.errors), /保留字/)
  assert.ok(RESERVED_IDS.includes('raw'))
})

test('manifest：id 格式不对被拒', () => {
  for (const id of ['QQ', '1qq', 'q q', 'a', '-x']) {
    const r = validateManifest({ ...GOOD, id })
    assert.equal(r.ok, false, `「${id}」不该通过`)
  }
})

test('manifest：api 主版本不符 → 拒；次版本高于核心 → 拒', () => {
  assert.equal(checkApi('2.0').ok, false, '主版本变了就是不兼容')
  assert.equal(checkApi('0.9').ok, false, '主版本 0 也不行')
  assert.equal(checkApi('1.10').ok, false, '次版本高于核心实现的不行')
  assert.equal(checkApi('1.9').ok, true, 'v1.9 是当前实现（manifest.accountSource）')
  assert.equal(checkApi('1.8').ok, true, 'v1.8 的模块仍然兼容（manifest.app）')
  assert.equal(checkApi('1.6').ok, true, 'v1.6 的模块仍然兼容（egress.request）')
  assert.equal(checkApi('1.0').ok, true)
  assert.match(validateManifest({ ...GOOD, api: '2.0' }).errors[0].message, /主版本/)
})

test('manifest：未知能力被拒（词表是封闭的）', () => {
  const r = validateManifest({ ...GOOD, capabilities: ['ingest.message', 'presence'] })
  assert.equal(r.ok, false)
  assert.match(summarizeErrors(r.errors), /未知能力/)
  assert.ok(!CAPABILITIES.includes('presence'), 'presence 在协议里已被删除')
})

test('manifest：entry.command 不能含路径分隔符', () => {
  const r = validateManifest({ ...GOOD, entry: { command: ['./run.sh'] } })
  assert.equal(r.ok, false)
  assert.match(summarizeErrors(r.errors), /路径分隔符/)
})

test('manifest：缺 version / 空 command 都拒', () => {
  assert.equal(validateManifest({ ...GOOD, version: undefined }).ok, false)
  assert.equal(validateManifest({ ...GOOD, entry: { command: [] } }).ok, false)
  assert.equal(validateManifest({ ...GOOD, entry: undefined }).ok, false)
})

test('manifest：不是对象时明确报错，不抛', () => {
  for (const bad of [null, [], 'x', 123]) {
    const r = validateManifest(bad)
    assert.equal(r.ok, false)
    assert.equal(r.errors[0].code, 'NOT_OBJECT')
  }
})

// ── sources（v1.1）────────────────────────────────────────────────────

const SRC = {
  id: 'qq.search_video',
  title: '按关键词搜视频',
  params: {
    type: 'object',
    properties: { q: { type: 'string', description: '关键词' } },
    required: ['q'],
  },
}

test('manifest：sources 需要 api 1.1（只认 1.0 的核心装不上它）', () => {
  const r = validateManifest({ ...GOOD, capabilities: ['provide.source'], sources: [SRC] })
  assert.equal(r.ok, false)
  assert.match(summarizeErrors(r.errors), /api "1\.1"/)
})

test('manifest：api 1.1 + sources 正常通过，字段被规整', () => {
  const r = validateManifest({ ...GOOD, api: '1.1', capabilities: ['provide.source'], sources: [SRC] })
  assert.equal(r.ok, true, summarizeErrors(r.errors))
  assert.deepEqual(r.manifest.sources, [SRC])
  assert.ok(CAPABILITIES.includes('provide.source'))
})

test('manifest：source id 必须以「模块id.」开头（模型只看到 id，靠它追来源）', () => {
  const r = validateManifest({ ...GOOD, api: '1.1', sources: [{ ...SRC, id: 'other.search' }] })
  assert.equal(r.ok, false)
  assert.match(summarizeErrors(r.errors), /必须以「qq\.」开头/)
})

test('manifest：source id 重复、title 缺失都拒', () => {
  const dup = validateManifest({ ...GOOD, api: '1.1', sources: [SRC, SRC] })
  assert.equal(dup.ok, false)
  assert.match(summarizeErrors(dup.errors), /重复/)

  const noTitle = validateManifest({ ...GOOD, api: '1.1', sources: [{ id: 'qq.a' }] })
  assert.equal(noTitle.ok, false)
  assert.match(summarizeErrors(noTitle.errors), /title 必填/)
})

test('manifest：params 只收 string/number/boolean；required 必须已声明', () => {
  const badType = validateManifest({
    ...GOOD,
    api: '1.1',
    sources: [{ id: 'qq.a', title: 'x', params: { type: 'object', properties: { n: { type: 'array' } } } }],
  })
  assert.equal(badType.ok, false)
  assert.match(summarizeErrors(badType.errors), /只支持/)

  const badReq = validateManifest({
    ...GOOD,
    api: '1.1',
    sources: [{ id: 'qq.a', title: 'x', params: { type: 'object', properties: {}, required: ['q'] } }],
  })
  assert.equal(badReq.ok, false)
  assert.match(summarizeErrors(badReq.errors), /没有在 properties 里声明/)
})

// ── tar ────────────────────────────────────────────────────────────────

/** 造一个最小 tar（普通文件）。注意 size 字段是**八进制**，写十进制会解出错误的长度。 */
function makeTar(files) {
  const blocks = []
  for (const [name, content] of Object.entries(files)) {
    const data = Buffer.from(content)
    const header = Buffer.alloc(512)
    header.write(name, 0, 'utf8')
    header.write(data.length.toString(8).padStart(11, '0'), 124, 'utf8')
    header.write('0', 156, 'utf8') // 普通文件
    header.write('ustar', 257, 'utf8')
    blocks.push(header, data)
    // 内容补齐到 512
    const pad = (512 - (data.length % 512)) % 512
    if (pad) blocks.push(Buffer.alloc(pad))
  }
  blocks.push(Buffer.alloc(1024)) // 结束标记
  return Buffer.concat(blocks)
}

test('untar：普通 tar 能解出文件内容', () => {
  const tar = makeTar({ 'index.mjs': 'console.log("hi")', 'yuanling.module.json': '{"id":"x"}' })
  const { entries } = untar(tar)
  assert.equal(entries.length, 2)
  const json = entries.find((e) => e.name === 'yuanling.module.json')
  assert.ok(json)
  assert.equal(json.data.toString('utf8'), '{"id":"x"}')
  assert.equal(json.type, 'file')
})

test('untar：gzip 的 .tgz 也能解', () => {
  const gz = zlib.gzipSync(makeTar({ 'a.txt': 'hello' }))
  const { entries } = untar(gz)
  assert.equal(entries.length, 1)
  assert.equal(entries[0].data.toString('utf8'), 'hello')
})

test('untar：剥掉 npm pack 的 package/ 前缀', () => {
  const gz = zlib.gzipSync(makeTar({ 'package/index.mjs': 'x', 'package/package.json': '{}' }))
  const entries = stripPackagePrefix(untar(gz).entries)
  assert.deepEqual(entries.map((e) => e.name).sort(), ['index.mjs', 'package.json'])
})

test('untar：目录穿越路径被拒（不许装到外面去）', () => {
  const tar = makeTar({ '../evil.txt': 'x' })
  assert.throws(() => untar(tar), /非法路径/)
})

test('untar：特殊成员（符号链接）被拒，不静默跳过', () => {
  const tar = makeTar({ 'real.mjs': 'x' })
  const header = Buffer.alloc(512)
  header.write('link.mjs', 0, 'utf8')
  header.write('0'.padStart(11, '0'), 124, 'utf8')
  header.write('2', 156, 'utf8') // symlink
  const patched = Buffer.concat([tar.subarray(0, tar.length - 1024), header, Buffer.alloc(1024)])
  assert.throws(() => untar(patched), /特殊成员/)
})

test('untar：空归档不抛，返回空列表', () => {
  const { entries } = untar(Buffer.alloc(1024))
  assert.deepEqual(entries, [])
})

test('manifest：app 只允许小写字母和数字（v1.8）', () => {
  const ok = validateManifest({ ...GOOD, app: 'milan' })
  assert.equal(ok.ok, true)
  assert.equal(ok.manifest.app, 'milan')

  assert.equal(validateManifest({ ...GOOD, app: 'MiLan' }).ok, false, '大写不行')
  assert.equal(validateManifest({ ...GOOD, app: 'mi-lan' }).ok, false, '连字符不行')
  assert.equal(validateManifest({ ...GOOD, app: '米聊' }).ok, false, '中文不行')
  assert.equal(validateManifest({ ...GOOD, app: 'a' }).ok, false, '至少 2 字符')
  assert.equal(validateManifest({ ...GOOD, app: 'a'.repeat(25) }).ok, false, '最多 24 字符')
})
