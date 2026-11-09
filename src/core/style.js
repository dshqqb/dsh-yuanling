// src/core/style.js —— 表达层：**她可以自己改**的那一层。
//
// 和 SELF.md 的分工（这条是硬线，别混）：
//   · SELF.md（骨架/说话方式/价值观）= 她是谁。**只有人能改**，代码里没有模型可调的写路径。
//   · style.md（表达层）= 她最近养成的说话习惯。模型可以改，人也可以改，提案批准也写这里。
//
// 一条不变量：**写进去的每一条都会进上下文**。
// 注入 `[习惯]` 有字节预算（`EXPRESSION_BYTES`），所以这里在写入时就按同一个预算卡住：
// 超了直接拒绝并告诉她还剩多少，而不是让她写一堆、注入时被悄悄截掉——那是"以为改了"。
//
// 两条写路径共用一个文件：
//   · 她的工具 `yuanling_style`（actor `model:style`）
//   · 人批准提案（proposals.approve → actor `system:proposal:<by>`）
// 都要带原因、都进版本历史。**提案的 rollback 是整文件退回**，会把中间的直改一起覆盖，
// 这点在工具描述和页面上都写明了。
import fs from 'node:fs'
import path from 'node:path'
import { exists, textSha256 } from './fsx.js'
import { EXPRESSION_BYTES } from './memory.js'
import { writeTracked, history } from './version.js'
import { styleRel } from './proposals.js'

/** 表达层最多几条：多了她自己都记不住，注入也没预算。 */
export const STYLE_MAX_ITEMS = 8
/** 单条上限（字符）。一条习惯写成一段话，就不叫习惯了。 */
export const STYLE_LINE_MAX = 60

const BULLET = /^\s*-\s+(.+?)\s*$/

/** 读表达层：拆成「抬头（标题/说明）」+「条目」。 */
export function readStyle(root, pid) {
  const rel = styleRel(pid)
  const abs = path.join(root, rel)
  const raw = exists(abs) ? fs.readFileSync(abs, 'utf8') : ''
  const lines = raw.split('\n')
  const items = []
  const others = []
  for (const line of lines) {
    const m = BULLET.exec(line)
    if (m) {
      // 模板里那种 `<占位>` 不算条目（人格还没填过）
      if (!/^<.*>$/.test(m[1].trim())) items.push(m[1].trim())
      continue
    }
    others.push(line)
  }
  const head = others.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd()
  return {
    rel,
    text: raw,
    head,
    items,
    bytes: itemBytes(items),
    budget: EXPRESSION_BYTES,
    maxItems: STYLE_MAX_ITEMS,
    expect: exists(abs) ? textSha256(raw) : null,
  }
}

function itemBytes(items) {
  return Buffer.byteLength(items.join('；'), 'utf8')
}

function render(head, items) {
  const parts = [head.trimEnd()]
  if (items.length) parts.push(items.map((x) => `- ${x}`).join('\n'))
  return `${parts.filter(Boolean).join('\n\n')}\n`
}

function normalizeLine(line) {
  return String(line ?? '')
    .replace(/^\s*-\s*/, '')
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * 加一条习惯。
 *
 * @returns {{changed:boolean, added?:string, items:string[], bytes:number, budget:number, path:string}}
 */
export function addStyleLine(root, pid, { line, reason = '', actor = 'model:style' } = {}) {
  const want = normalizeLine(line)
  if (!want) throw new Error('要加什么？line 不能为空')
  if ([...want].length > STYLE_LINE_MAX) throw new Error(`一条最多 ${STYLE_LINE_MAX} 字；这条 ${[...want].length} 字，写短点或拆开`)
  if (!String(reason ?? '').trim()) throw new Error('reason 必填：为什么养成这个习惯（以后回看才知道该不该留着）')

  const cur = readStyle(root, pid)
  if (cur.items.includes(want)) {
    return { changed: false, added: want, items: cur.items, bytes: cur.bytes, budget: cur.budget, path: cur.rel }
  }
  if (cur.items.length >= STYLE_MAX_ITEMS) {
    throw new Error(`表达层最多 ${STYLE_MAX_ITEMS} 条，已经满了。先删一条（或把两条并成一条）再加`)
  }

  const next = [...cur.items, want]
  const bytes = itemBytes(next)
  if (bytes > EXPRESSION_BYTES) {
    throw new Error(
      `会超预算：表达层 ${EXPRESSION_BYTES} 字节，现在 ${cur.bytes}，加这条变 ${bytes}。` +
        `谁都不会读一条进不了上下文的习惯——先删一条，或把话写短`,
    )
  }

  const head = cur.head || '# 表达层'
  writeTracked(root, cur.rel, render(head, next), {
    actor,
    reason: String(reason).slice(0, 200),
  })
  return { changed: true, added: want, items: next, bytes, budget: EXPRESSION_BYTES, path: cur.rel }
}

/** 删一条习惯（按原文精确匹配，找不到就明确说没找到）。 */
export function removeStyleLine(root, pid, { line, reason = '', actor = 'model:style' } = {}) {
  const want = normalizeLine(line)
  if (!want) throw new Error('要删哪一条？line 不能为空')
  if (!String(reason ?? '').trim()) throw new Error('reason 必填：为什么去掉这个习惯')

  const cur = readStyle(root, pid)
  const idx = cur.items.indexOf(want)
  if (idx < 0) {
    throw new Error(`表达层里没有这一条：${want}。现有：${cur.items.join('；') || '（空）'}`)
  }
  const next = cur.items.filter((_, i) => i !== idx)
  const head = cur.head || '# 表达层'
  writeTracked(root, cur.rel, render(head, next), {
    actor,
    reason: String(reason).slice(0, 200),
  })
  return { changed: true, removed: want, items: next, bytes: itemBytes(next), budget: EXPRESSION_BYTES, path: cur.rel }
}

/** 表达层的历史（给"她怎么变成现在这样"用）。 */
export function styleHistory(root, pid, { limit = 20 } = {}) {
  return history(root, styleRel(pid)).slice(-limit)
}
