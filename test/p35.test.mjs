// test/p35.test.mjs —— 从"库的网址"装模块（协议 v1.1 的管理台入口）。
//
// 为什么要这么多用例：这一层要面对两个平台各一套 JSON、源码归档混在资产里、
// 以及"库是空的 / 没有发行版 / 资产只有 zip"这些真实会遇到的死路。
// 每条死路都必须给出**能照着做**的话，而不是"安装失败"。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import zlib from 'node:zlib'

import { scaffold } from '../src/core/scaffold.js'
import {
  parseRepoUrl,
  isTgzUrl,
  pickTgzAsset,
  latestRelease,
  resolveInstallUrl,
  fetchModuleBytes,
} from '../src/core/modules/installer.js'
import { handleModuleInstallFromUrl } from '../src/core/api.js'
import { readRegistry } from '../src/core/modules/registry.js'

function tmpRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'yuanling-p35-'))
  scaffold(root, {})
  return root
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

/** 造一个能被解包的 tgz。 */
function makeTgz(files = { 'yuanling.module.json': JSON.stringify(MANIFEST, null, 2), 'index.mjs': 'export default {}' }) {
  const blocks = []
  for (const [name, content] of Object.entries(files)) {
    const data = Buffer.from(content)
    const h = Buffer.alloc(512)
    h.write(name, 0, 'utf8')
    h.write(data.length.toString(8).padStart(11, '0'), 124, 'utf8')
    h.write('0', 156, 'utf8')
    h.write('ustar', 257, 'utf8')
    blocks.push(h, data)
    const pad = (512 - (data.length % 512)) % 512
    if (pad) blocks.push(Buffer.alloc(pad))
  }
  blocks.push(Buffer.alloc(1024))
  return zlib.gzipSync(Buffer.concat(blocks))
}

/** 假 fetch：按 URL 路由，返回预置 JSON 或字节。 */
function fakeFetch({ releases = {}, tgz = null, status = 200 } = {}) {
  const calls = []
  const impl = async (url) => {
    const u = String(url)
    calls.push(u)
    // 顺序要紧：资产的下载地址里也含 `releases/download`，所以先判 .tgz
    if (/\.tgz(?:\?|$)/i.test(u)) {
      if (!tgz) return jsonRes({}, 404)
      return {
        ok: true,
        status: 200,
        arrayBuffer: async () => tgz,
        json: async () => ({}),
      }
    }
    if (/releases/.test(u)) {
      for (const [key, val] of Object.entries(releases)) {
        if (u.includes(key)) return jsonRes(val, status)
      }
      return jsonRes([], 404)
    }
    return jsonRes({}, 404)
  }
  impl.calls = calls
  return impl
}

function jsonRes(obj, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => obj,
    text: async () => JSON.stringify(obj),
    arrayBuffer: async () => Buffer.from(''),
  }
}

// ── 地址解析 ────────────────────────────────────────────────────────────

test('url：认得 Gitee / GitHub 的库地址与常见变体', () => {
  assert.deepEqual(parseRepoUrl('https://gitee.com/dshqqb/dsh-yuanling-bili'), {
    host: 'gitee.com',
    owner: 'dshqqb',
    repo: 'dsh-yuanling-bili',
    tag: null,
  })
  assert.equal(parseRepoUrl('https://gitee.com/o/r.git').repo, 'r', '.git 后缀要去掉')
  assert.equal(parseRepoUrl('https://github.com/o/r/tree/main').repo, 'r', '带分支路径的也要认')
  assert.equal(parseRepoUrl('https://gitee.com/o/r/releases/tag/v0.1.0').tag, 'v0.1.0', '要能钉版本')
  assert.equal(parseRepoUrl('https://example.com/o/r'), null, '别的域名不自动猜')
  assert.equal(parseRepoUrl('not a url'), null)
  assert.equal(parseRepoUrl('https://gitee.com/onlyowner'), null, '只有 owner 不算库')
})

test('url：怎么判断是 tgz 直链', () => {
  assert.equal(isTgzUrl('https://x/a/b-0.1.0.tgz'), true)
  assert.equal(isTgzUrl('https://github.com/o/r/releases/download/v1/r-1.0.tgz'), true)
  assert.equal(isTgzUrl('https://x/a/b-0.1.0.tgz?x=1'), true, '带 query 也要认')
  assert.equal(isTgzUrl('https://x/a/b.zip'), false, '源码 zip 不是模块包')
  assert.equal(isTgzUrl('https://gitee.com/o/r'), false)
})

test('url：挑资产只认 tgz，源码归档必须排除', () => {
  const giteeAssets = [
    { name: 'v1.25.0.tar.gz', browser_download_url: 'https://gitee.com/o/r/archive/refs/tags/v1.25.0.tar.gz' },
    { name: 'v1.25.0.zip', browser_download_url: 'https://gitee.com/o/r/archive/refs/tags/v1.25.0.zip' },
    { name: 'r-1.25.0.tgz', browser_download_url: 'https://gitee.com/o/r/releases/download/v1.25.0/r-1.25.0.tgz' },
  ]
  const picked = pickTgzAsset(giteeAssets)
  assert.equal(picked.name, 'r-1.25.0.tgz')
  assert.match(picked.url, /\.tgz$/)
})

test('url：资产里只有源码包时返回 null（由上层报"没有 tgz 附件"）', () => {
  assert.equal(pickTgzAsset([{ name: 'v1.tar.gz', browser_download_url: 'https://x/v1.tar.gz' }]), null)
  assert.equal(pickTgzAsset([{ name: 'v1.zip', browser_download_url: 'https://x/v1.zip' }]), null)
  assert.equal(pickTgzAsset([]), null)
  assert.equal(pickTgzAsset(null), null)
})

test('url：多个 tgz 时优先带版本号的那个，保证结果可复现', () => {
  const picked = pickTgzAsset([
    { name: 'latest.tgz', browser_download_url: 'https://x/latest.tgz' },
    { name: 'demo-0.2.0.tgz', browser_download_url: 'https://x/demo-0.2.0.tgz' },
  ])
  assert.equal(picked.name, 'demo-0.2.0.tgz')
})

test('url：取最新发行版＝created_at 最新且非预发布', () => {
  const list = [
    { tag_name: 'v0.1.0', created_at: '2026-11-01T00:00:00Z', prerelease: false },
    { tag_name: 'v0.3.0-rc', created_at: '2026-11-05T00:00:00Z', prerelease: true },
    { tag_name: 'v0.2.0', created_at: '2026-11-03T00:00:00Z', prerelease: false },
  ]
  assert.equal(latestRelease(list).tag_name, 'v0.2.0', '预发布不该被当成最新版')

  const onlyPre = [{ tag_name: 'v1', created_at: '2026-11-01T00:00:00Z', prerelease: true }]
  assert.equal(latestRelease(onlyPre).tag_name, 'v1', '只有预发布时退而求其次，而不是说"没有发行版"')
  assert.equal(latestRelease([]), null)
})

// ── 解析整个地址 ────────────────────────────────────────────────────────

test('url：Gitee 库地址 → 找到发行版里的 tgz', async () => {
  const fetchImpl = fakeFetch({
    releases: {
      'gitee.com/api/v5/repos/o/r': [
        {
          tag_name: 'v0.1.0',
          created_at: '2026-11-08T00:00:00Z',
          prerelease: false,
          assets: [
            { name: 'r-0.1.0.tgz', browser_download_url: 'https://gitee.com/o/r/releases/download/v0.1.0/r-0.1.0.tgz' },
          ],
        },
      ],
    },
  })
  const r = await resolveInstallUrl('https://gitee.com/o/r', { fetchImpl })
  assert.equal(r.tgzUrl, 'https://gitee.com/o/r/releases/download/v0.1.0/r-0.1.0.tgz')
  assert.equal(r.ref, 'v0.1.0')
  assert.equal(r.source, 'gitee')
  assert.equal(r.repo, 'https://gitee.com/o/r')
  assert.ok(fetchImpl.calls.some((u) => u.includes('api/v5/repos/o/r/releases')))
})

test('url：GitHub 库地址走 api.github.com 的 releases', async () => {
  const fetchImpl = fakeFetch({
    releases: {
      'api.github.com': [
        {
          tag_name: 'v0.1.0',
          created_at: '2026-11-08T00:00:00Z',
          assets: [{ name: 'demo-0.1.0.tgz', browser_download_url: 'https://github.com/o/r/releases/download/v0.1.0/demo-0.1.0.tgz' }],
        },
      ],
    },
  })
  const r = await resolveInstallUrl('https://github.com/o/r', { fetchImpl })
  assert.equal(r.source, 'github')
  assert.equal(r.assetName, 'demo-0.1.0.tgz')
  assert.ok(fetchImpl.calls.some((u) => u.includes('api.github.com/repos/o/r/releases')))
})

test('url：钉版本时只认那个 tag', async () => {
  const fetchImpl = fakeFetch({
    releases: {
      'gitee.com/api/v5/repos/o/r': [
        { tag_name: 'v0.1.0', created_at: '2026-11-01T00:00:00Z', assets: [{ name: 'a-0.1.0.tgz', browser_download_url: 'https://g/v0.1.0/a.tgz' }] },
        { tag_name: 'v0.2.0', created_at: '2026-11-05T00:00:00Z', assets: [{ name: 'a-0.2.0.tgz', browser_download_url: 'https://g/v0.2.0/a.tgz' }] },
      ],
    },
  })
  const r = await resolveInstallUrl('https://gitee.com/o/r/releases/tag/v0.1.0', { fetchImpl })
  assert.equal(r.ref, 'v0.1.0')
  assert.match(r.tgzUrl, /v0\.1\.0/)
})

test('url：直链就原样用，不去查发行版（省一次请求）', async () => {
  const fetchImpl = fakeFetch()
  const r = await resolveInstallUrl('https://x/y/demo-0.1.0.tgz', { fetchImpl })
  assert.equal(r.tgzUrl, 'https://x/y/demo-0.1.0.tgz')
  assert.equal(r.source, 'url')
  assert.equal(fetchImpl.calls.length, 0, '直链不该触发任何查询')
})

test('url：库没发行版 / 资产没 tgz / 库不存在，三句话都要能照着做', async () => {
  const empty = await resolveInstallUrl('https://gitee.com/o/r', { fetchImpl: fakeFetch({ releases: { 'gitee.com': [] } }) }).catch((e) => e)
  assert.match(empty.message, /还没有发行版/)
  assert.match(empty.message, /pack\.mjs/, '要告诉人包怎么来')

  const noTgz = await resolveInstallUrl('https://gitee.com/o/r', {
    fetchImpl: fakeFetch({
      releases: {
        'gitee.com': [{ tag_name: 'v1', assets: [{ name: 'v1.tar.gz', browser_download_url: 'https://x/v1.tar.gz' }] }],
      },
    }),
  }).catch((e) => e)
  assert.match(noTgz.message, /没有 \.tgz 附件/)
  assert.match(noTgz.message, /源码/, '要说清源码包为什么不能装')

  const missing = await resolveInstallUrl('https://gitee.com/nosuch/nope', {
    fetchImpl: async () => jsonRes({}, 404),
  }).catch((e) => e)
  assert.equal(missing.code, 'E_NO_REPO')
  assert.match(missing.message, /404/)
})

test('url：http（非本机）/ 看不懂的地址都要在下载前就拒', async () => {
  await assert.rejects(() => resolveInstallUrl('http://evil.com/a.tgz', { fetchImpl: fakeFetch() }), /https/)
  await assert.rejects(() => resolveInstallUrl('https://example.com/o/r', { fetchImpl: fakeFetch() }), /看不懂/)
  await assert.rejects(() => resolveInstallUrl('   ', { fetchImpl: fakeFetch() }), /请填一个地址/)
})

// ── 端到端：内容 → 落盘 ──────────────────────────────────────────────────

test('end：解析 + 下载 + 安装，一条链路走完（管理台那个按钮）', async () => {
  const root = tmpRoot()
  const bytes = makeTgz()
  const fetchImpl = fakeFetch({
    releases: {
      'gitee.com/api/v5/repos/o/r': [
        {
          tag_name: 'v0.1.0',
          assets: [{ name: 'demo-0.1.0.tgz', browser_download_url: 'https://gitee.com/o/r/releases/download/v0.1.0/demo-0.1.0.tgz' }],
        },
      ],
    },
    tgz: bytes,
  })

  const w = await handleModuleInstallFromUrl(root, { url: 'https://gitee.com/o/r' }, { fetchImpl })
  assert.equal(w.status, 200, JSON.stringify(w.body))
  assert.equal(w.body.id, 'demo')
  assert.equal(w.body.ref, 'v0.1.0')
  assert.equal(w.body.repo, 'https://gitee.com/o/r')

  const reg = readRegistry(root)
  assert.equal(reg.modules.demo.version, '0.1.0')
  assert.equal(reg.modules.demo.repo, 'https://gitee.com/o/r', '注册表要记住来源，回滚/排查都靠它')
  assert.equal(reg.modules.demo.source, 'gitee')
  assert.deepEqual(reg.modules.demo.granted, [], 'v1.1：装完仍是空授权')
  assert.deepEqual(w.body.capabilities, ['ingest.message'])
})

test('end：下载失败时给 400，且不留下半个模块', async () => {
  const root = tmpRoot()
  const fetchImpl = fakeFetch({
    releases: { 'gitee.com/api/v5/repos/o/r': [{ tag_name: 'v1', assets: [{ name: 'a-1.0.0.tgz', browser_download_url: 'https://g/a.tgz' }] }] },
    tgz: null,
  })
  const w = await handleModuleInstallFromUrl(root, { url: 'https://gitee.com/o/r' }, { fetchImpl })
  assert.equal(w.status, 400)
  assert.deepEqual(readRegistry(root).modules, {}, '装失败不该写进注册表')
  assert.equal(fs.existsSync(path.join(root, 'system', 'modules', 'demo')), false)
})

test('end：直链安装也能走通（没有发行版时的退路）', async () => {
  const root = tmpRoot()
  const bytes = makeTgz()
  const fetchImpl = fakeFetch({ tgz: bytes })
  const w = await handleModuleInstallFromUrl(root, { url: 'https://x/demo-0.1.0.tgz' }, { fetchImpl })
  assert.equal(w.status, 200)
  assert.equal(w.body.source, undefined, 'body 里不该有 source 这个内部字段')
  assert.equal(readRegistry(root).modules.demo.source, 'url')
})

test('end：fetchModuleBytes 串起来不重复下载', async () => {
  const bytes = makeTgz()
  const fetchImpl = fakeFetch({
    releases: { 'gitee.com/api/v5/repos/o/r': [{ tag_name: 'v1', assets: [{ name: 'a-1.0.0.tgz', browser_download_url: 'https://g/a.tgz' }] }] },
    tgz: bytes,
  })
  const { bytes: got, resolved } = await fetchModuleBytes('https://gitee.com/o/r', { fetchImpl })
  assert.equal(got.length, bytes.length)
  assert.equal(resolved.assetName, 'a-1.0.0.tgz')
})
