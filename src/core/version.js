// src/core/version.js —— 版本与审计：内容寻址 blob + 追加式 journal + 回滚 + 外部编辑检测。
//
// 为什么不靠外部版本工具：写路径不能依赖别的进程；而且 journal 记「为什么改」，
// 这是 diff 给不了的。
//
// 两套版本库：
//   根级文件（yuanling.json / guardrails.json / rules/ingest.json）→ system/versions/
//   人格文件（personas/<id>/…）                                  → personas/<id>/versions/
// 这样只拷 personas/<id>/ 也能把它自己的历史一起带走。
import fs from 'node:fs'
import path from 'node:path'
import { exists, ensureDir, appendLine, writeFileAtomic, sha256, ulid, localIso } from './fsx.js'
import { P } from './paths.js'

const PERSONA_RE = /^personas\/([a-z0-9][a-z0-9_-]{1,31})\//

/** 归一化相对路径：统一斜杠、去掉开头的 ./。 */
export function normRel(rel) {
  return String(rel).replace(/\\/g, '/').replace(/^\.\//, '').replace(/^\/+/, '')
}

/** 判断这条路径属于哪套版本库。 */
export function scopeOf(rel) {
  const p = normRel(rel)
  const m = PERSONA_RE.exec(p)
  if (m) {
    const id = m[1]
    return { scope: id, versions: `${P.personas}/${id}/versions`, persona: id }
  }
  return { scope: 'root', versions: P.versions, persona: null }
}

function hexOf(hash) {
  return String(hash).replace(/^sha256:/, '')
}

export function blobPath(scopeInfo, hash) {
  const hex = hexOf(hash)
  return `${scopeInfo.versions}/blobs/${hex.slice(0, 2)}/${hex}`
}

export function journalPath(scopeInfo) {
  return `${scopeInfo.versions}/journal.ndjson`
}

/** 读某个版本库的 journal（坏行跳过）。 */
export function readJournal(root, scopeInfo) {
  const p = path.join(root, journalPath(scopeInfo))
  if (!exists(p)) return []
  const out = []
  for (const line of fs.readFileSync(p, 'utf8').split('\n')) {
    if (!line.trim()) continue
    try {
      out.push(JSON.parse(line))
    } catch {
      /* 坏行跳过 */
    }
  }
  return out
}

/** 某路径的最新一条记录（没有就 null）。 */
export function headFor(root, rel) {
  const p = normRel(rel)
  const sc = scopeOf(p)
  const entries = readJournal(root, sc)
  for (let i = entries.length - 1; i >= 0; i -= 1) {
    if (entries[i].path === p) return entries[i]
  }
  return null
}

/** 存 blob（内容寻址，已存在就不写）。 */
function putBlob(root, scopeInfo, buf) {
  const hash = sha256(buf)
  const rel = blobPath(scopeInfo, hash)
  const abs = path.join(root, rel)
  if (!exists(abs)) {
    ensureDir(path.dirname(abs))
    writeFileAtomic(abs, buf)
  }
  return hash
}

/** 读 blob。 */
export function readBlob(root, rel, hash) {
  const sc = scopeOf(rel)
  const abs = path.join(root, blobPath(sc, hash))
  if (!exists(abs)) return null
  return fs.readFileSync(abs)
}

function appendJournal(root, scopeInfo, entry) {
  ensureDir(path.join(root, scopeInfo.versions))
  appendLine(path.join(root, journalPath(scopeInfo)), entry)
}

/**
 * 写一个受跟踪的文件：写盘 + 存 blob + 记 journal。
 * 内容没变就什么都不做（幂等）。
 *
 * @returns {{changed:boolean, hash?:string, prev?:string|null}}
 */
export function writeTracked(root, rel, content, { actor = 'system:unknown', reason = '', kind = 'update' } = {}) {
  const p = normRel(rel)
  const buf = Buffer.isBuffer(content) ? content : Buffer.from(String(content), 'utf8')
  const hash = sha256(buf)
  const head = headFor(root, p)
  if (head && head.hash === hash) return { changed: false, hash, prev: head.hash }

  const abs = path.join(root, p)
  ensureDir(path.dirname(abs))
  writeFileAtomic(abs, buf)

  const sc = scopeOf(p)
  putBlob(root, sc, buf)
  appendJournal(root, sc, {
    ts: localIso(),
    op_id: ulid(),
    path: p,
    hash,
    prev: head?.hash ?? null,
    bytes: buf.length,
    actor,
    kind: head ? kind : 'create',
    reason,
  })
  return { changed: true, hash, prev: head?.hash ?? null }
}

/**
 * 把磁盘上现在的内容记一笔（用于接手已存在的文件，不重新写盘）。
 */
export function snapshotCurrent(root, rel, opts = {}) {
  const p = normRel(rel)
  const abs = path.join(root, p)
  if (!exists(abs)) throw new Error(`文件不存在：${p}`)
  const buf = fs.readFileSync(abs)
  const hash = sha256(buf)
  const head = headFor(root, p)
  if (head && head.hash === hash) return { changed: false, hash, prev: head.hash }

  const sc = scopeOf(p)
  putBlob(root, sc, buf)
  appendJournal(root, sc, {
    ts: localIso(),
    op_id: ulid(),
    path: p,
    hash,
    prev: head?.hash ?? null,
    bytes: buf.length,
    actor: opts.actor ?? 'human:editor',
    kind: head ? opts.kind ?? 'update' : 'create',
    reason: opts.reason ?? 'snapshot',
  })
  return { changed: true, hash, prev: head?.hash ?? null }
}

/** 某路径的历史（按时间正序）。 */
export function history(root, rel) {
  const p = normRel(rel)
  const sc = scopeOf(p)
  return readJournal(root, sc)
    .filter((e) => e.path === p)
    .sort((a, b) => String(a.ts).localeCompare(String(b.ts)))
}

/**
 * 回滚到某个版本。target 可以是完整 hash、hash 前缀，或时间戳前缀。
 * 回滚本身也是一次新版本（不擦掉后来的历史）。
 */
export function revertTo(root, rel, target, { actor = 'human:editor' } = {}) {
  const p = normRel(rel)
  const entries = history(root, p)
  if (!entries.length) throw new Error(`没有历史：${p}`)
  const hit =
    entries.find((e) => e.hash === target) ??
    [...entries].reverse().find((e) => String(e.hash).startsWith(target)) ??
    // 时间戳取「最早匹配」：同一秒内可能写了多次，取最早的那次更符合直觉
    entries.find((e) => String(e.ts).startsWith(target))
  if (!hit) throw new Error(`找不到版本：${target}`)
  const buf = readBlob(root, p, hit.hash)
  if (!buf) throw new Error(`blob 缺失（历史不完整）：${hit.hash}`)

  return writeTracked(root, p, buf, {
    actor,
    kind: 'revert',
    reason: `回滚到 ${hit.ts}（${String(hit.hash).slice(0, 19)}…）`,
  })
}

/** 列出被跟踪过的全部路径（根级 + 所有人格）。 */
export function trackedPaths(root) {
  const scopes = [{ scope: 'root', versions: P.versions, persona: null }]
  const pdir = path.join(root, P.personas)
  if (exists(pdir)) {
    for (const id of fs.readdirSync(pdir)) {
      if (!/^[a-z0-9][a-z0-9_-]{1,31}$/.test(id)) continue
      if (!exists(path.join(root, P.personas, id, 'versions', 'journal.ndjson'))) continue
      scopes.push({ scope: id, versions: `${P.personas}/${id}/versions`, persona: id })
    }
  }
  const set = new Set()
  for (const sc of scopes) for (const e of readJournal(root, sc)) set.add(e.path)
  return [...set].sort()
}

/**
 * 扫插件外的修改：文件 hash 与 journal 最后一条不符 → 记一条 external_edit。
 * 这让"记事本改文件"从隐患变成特性：改完自动进历史，且标成人手改的。
 *
 * @returns {Array<{path:string, from:string, to:string}>}
 */
export function scanExternalEdits(root) {
  const changed = []
  for (const rel of trackedPaths(root)) {
    const abs = path.join(root, rel)
    if (!exists(abs)) continue
    const head = headFor(root, rel)
    if (!head) continue
    const buf = fs.readFileSync(abs)
    const now = sha256(buf)
    if (now === head.hash) continue

    const sc = scopeOf(rel)
    putBlob(root, sc, buf)
    appendJournal(root, sc, {
      ts: localIso(),
      op_id: ulid(),
      path: rel,
      hash: now,
      prev: head.hash,
      bytes: buf.length,
      actor: 'human:editor',
      kind: 'external_edit',
      reason: '检测到插件外的修改（文件 hash 与 journal 最后一条不符）',
    })
    changed.push({ path: rel, from: head.hash, to: now })
  }
  return changed
}

/** 统计：某版本库里有多少 blob / 多少条记录。 */
export function stats(root) {
  const out = []
  const scopes = [{ scope: 'root', versions: P.versions, persona: null }]
  const pdir = path.join(root, P.personas)
  if (exists(pdir)) {
    for (const id of fs.readdirSync(pdir)) {
      if (/^[a-z0-9][a-z0-9_-]{1,31}$/.test(id)) {
        scopes.push({ scope: id, versions: `${P.personas}/${id}/versions`, persona: id })
      }
    }
  }
  for (const sc of scopes) {
    const entries = readJournal(root, sc)
    if (!entries.length) continue
    const blobDir = path.join(root, sc.versions, 'blobs')
    let blobs = 0
    if (exists(blobDir)) {
      for (const sub of fs.readdirSync(blobDir)) {
        const p = path.join(blobDir, sub)
        if (fs.statSync(p).isDirectory()) blobs += fs.readdirSync(p).length
      }
    }
    out.push({ scope: sc.scope, entries: entries.length, blobs })
  }
  return out
}
