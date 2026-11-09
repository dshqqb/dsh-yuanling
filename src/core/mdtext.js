// src/core/mdtext.js —— 把「# 标题 + 引言 + 若干 ## 小节」的 Markdown 切成可编辑的块。
//
// 为什么需要它：人格底稿（SELF.md 们）是人写的散文，不是表单。想做"分节编辑"就得
// 先切节；切完还得能**原位拼回去**——不能因为保存了一次，就把没人碰过的段落整体
// 重排一遍。那种改写会在版本历史里留下满屏假 diff，回滚时根本看不出改了什么。
//
// 所以这里记的不是"格式化后的规范文本"，而是**原始字节区间**（start/end）。保存时
// 只把改过的那几段替换进原串，其余字节一个不动。
//
// 只认两种标题：`# ` 一级（当标题）与 `## ` 二级（当小节）。更深层的不动——它们是正文。

const HEAD1 = /^#\s+(.+?)\s*$/
const HEAD2 = /^##\s+(.+?)\s*$/

/**
 * 切分。行偏移自己算，因为它们要能直接用于 `String.slice`。
 *
 * @returns {{
 *   text: string, title: string, titleStart: number, titleEnd: number,
 *   preamble: string, preambleStart: number, preambleEnd: number,
 *   sections: Array<{title:string, body:string, start:number, end:number}>,
 *   hasSections: boolean
 * }}
 */
export function parseMd(text) {
  const src = String(text ?? '')
  const lines = src.split('\n')

  // 每行起始偏移。末行没换行时 at 会多算 1，但我们只用**已存在行**的偏移，不影响。
  const starts = []
  let at = 0
  for (const line of lines) {
    starts.push(at)
    at += line.length + 1
  }
  const lineEnd = (i) => starts[i] + lines[i].length

  const heads = []
  let title = ''
  let titleIdx = -1

  for (let i = 0; i < lines.length; i += 1) {
    if (titleIdx < 0) {
      const h1 = HEAD1.exec(lines[i])
      if (h1) {
        title = h1[1]
        titleIdx = i
        continue
      }
    }
    const h2 = HEAD2.exec(lines[i])
    if (h2) heads.push({ title: h2[1], idx: i })
  }

  // 引言：标题行之后、第一个小节之前。没有标题时从头算。
  let preambleStart = 0
  if (titleIdx >= 0) preambleStart = Math.min(lineEnd(titleIdx) + 1, src.length)
  const preambleEnd = heads.length ? starts[heads[0].idx] : src.length
  const preamble = src.slice(Math.min(preambleStart, preambleEnd), preambleEnd)

  const sections = heads.map((h, k) => {
    const start = Math.min(lineEnd(h.idx) + 1, src.length)
    const end = k + 1 < heads.length ? starts[heads[k + 1].idx] : src.length
    return {
      title: h.title,
      body: src.slice(Math.min(start, end), end),
      start: Math.min(start, end),
      end,
    }
  })

  return {
    text: src,
    title,
    titleStart: titleIdx >= 0 ? starts[titleIdx] : -1,
    titleEnd: titleIdx >= 0 ? lineEnd(titleIdx) : -1,
    preamble,
    preambleStart,
    preambleEnd,
    sections,
    hasSections: sections.length > 0,
  }
}

/**
 * 去掉两端"排版用的空白"，但不动行首缩进。
 *
 * 小节的 body 从标题行**换行之后**开始，所以它天然以一个换行开头（标题与正文之间
 * 那行空行）。这个前导换行不能进文本域——那会让每个框看起来都从第二行开始写。
 */
export function trimBody(text) {
  return String(text ?? '')
    .replace(/^\n+/, '')
    .replace(/\s+$/, '')
}

/**
 * 按小节标题把新正文拼回去。只替换**内容真的变了**的小节。
 *
 * 首尾空白单独处理：文本域显示的是 trim 过的值，如果直接拿它覆盖，小节之间的
 * 空行会一次比一次少，几次保存之后 `## 说话方式` 就紧贴在上一段的行尾了。
 * 所以首尾空白一律从**原小节**里取，只换中间那截正文。
 *
 * @returns {{ok:true, text:string, changed:number} | {ok:false, error:string}}
 */
export function applySectionEdits(parsed, edits) {
  const want = Array.isArray(edits) ? edits : []
  const spans = []

  for (const e of want) {
    const title = String(e?.title ?? '')
    const target = parsed.sections.find((s) => s.title === title)
    if (!target) return { ok: false, error: `找不到小节「${title}」——文件可能在你打开之后被改过，刷新一下` }

    const lead = /^\n*/.exec(target.body)?.[0] ?? ''
    const tail = /\s*$/.exec(target.body)?.[0] ?? ''
    const next = lead + trimBody(e?.body) + tail
    if (next === target.body) continue
    spans.push({ start: target.start, end: target.end, body: next })
  }

  // 从后往前替换，前面几段的偏移就不会被打乱
  spans.sort((a, b) => b.start - a.start)
  let out = parsed.text
  for (const s of spans) out = out.slice(0, s.start) + s.body + out.slice(s.end)
  return { ok: true, text: out, changed: spans.length }
}

/**
 * 换一级标题里的名字，保留「· 骨架」这类后缀。
 * 文件没有一级标题时返回 ok:false——**不硬插一行**（那会改变文件结构）。
 */
export function replaceTitle(parsed, name) {
  if (parsed.titleStart < 0) return { ok: false, error: '这个文件没有一级标题（`# ` 开头那行）' }
  const old = parsed.text.slice(parsed.titleStart, parsed.titleEnd)
  const m = HEAD1.exec(old)
  const suffix = m ? /\s·\s(.+)$/.exec(m[1])?.[1] : null
  const next = `# ${suffix ? `${name} · ${suffix}` : name}`
  if (next === old) return { ok: true, text: parsed.text, changed: false }
  return { ok: true, text: parsed.text.slice(0, parsed.titleStart) + next + parsed.text.slice(parsed.titleEnd), changed: true }
}
