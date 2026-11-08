// src/core/modules/ui.js —— 模块自定义 tab 的数据：形状校验 + 限幅。
//
// 协议 v1.2：模块通过 `ui.get` 回一段**纯数据**，核心按声明的 kind 画。
// 这个文件做的事只有两件：
//   ① 把模块回来的东西整成一两种确定的形状（`kv` / `list` / `text`），不符就报错；
//   ② 限幅——列表条数、单行长度、总文本字节。
//
// 为什么要限幅：tab 是给人看的，不是数据传输通道。一个模块回一万行“状态”，
// 页面会卡、日志会炸，而它并没有做错什么，只是没想清楚边界。
export const UI_LIMITS = {
  rows: 200,
  textBytes: 16 * 1024,
  fieldChars: 500,
}

/** 一次 ui.get 的失败：带协议错误码。 */
export function uiError(code, message) {
  return Object.assign(new Error(message), { code })
}

function clip(s, max = UI_LIMITS.fieldChars) {
  const str = String(s ?? '')
  return str.length > max ? `${str.slice(0, max)}…` : str
}

/**
 * 校验并规整模块回来的数据。
 *
 * 只认三种形状（与 manifest 里声明的 kind 必须一致）：
 *   kv   → `{ "在线": "12", "队列": "3" }`（对象；也接受 [{k,v}]）
 *   list → `[{ title, sub? }]`（也接受纯字符串数组）
 *   text → `"一段文字"` 或 `{ text: "..." }`
 *
 * 形状不对**整块拒**——半截渲染的数据比不渲染更误导人。
 */
export function normalizeUiPayload(kind, payload) {
  const want = String(kind ?? 'text')

  if (want === 'kv') {
    const rows = normalizeKv(payload)
    if (!rows) throw uiError('E_BAD_REQUEST', 'kv 类型要回对象 { 键: 值 } 或 [{k,v}]')
    const clipped = rows.slice(0, UI_LIMITS.rows).map((r) => ({ k: clip(r.k), v: clip(r.v) }))
    return { kind: 'kv', rows: clipped, truncated: rows.length > clipped.length }
  }

  if (want === 'list') {
    const items = normalizeList(payload)
    if (!items) throw uiError('E_BAD_REQUEST', 'list 类型要回 [{title, sub?}] 或字符串数组')
    const clipped = items.slice(0, UI_LIMITS.rows).map((it) => ({ title: clip(it.title), sub: it.sub === null ? null : clip(it.sub) }))
    return { kind: 'list', items: clipped, truncated: items.length > clipped.length }
  }

  const text = normalizeText(payload)
  if (text === null) throw uiError('E_BAD_REQUEST', 'text 类型要回字符串或 { text }')
  const bytes = Buffer.byteLength(text, 'utf8')
  if (bytes <= UI_LIMITS.textBytes) return { kind: 'text', text, truncated: false }
  // 按字节裁会切坏 UTF-8：先按字符近似裁再回退到合法边界
  let cut = Math.floor((UI_LIMITS.textBytes - 16) / 3)
  let out = text.slice(0, cut)
  while (Buffer.byteLength(out, 'utf8') > UI_LIMITS.textBytes - 16 && cut > 0) {
    cut = Math.floor(cut * 0.9)
    out = text.slice(0, cut)
  }
  return { kind: 'text', text: `${out}\n…（超过 ${UI_LIMITS.textBytes} 字节上限，已截断）`, truncated: true }
}

function normalizeKv(payload) {
  if (Array.isArray(payload)) {
    const rows = []
    for (const it of payload) {
      if (!it || typeof it !== 'object') return null
      if (it.k === undefined && it.key === undefined) return null
      rows.push({ k: String(it.k ?? it.key), v: it.v ?? it.value ?? '' })
    }
    return rows
  }
  if (payload && typeof payload === 'object') {
    return Object.entries(payload).map(([k, v]) => ({ k, v }))
  }
  return null
}

function normalizeList(payload) {
  if (!Array.isArray(payload)) return null
  const items = []
  for (const it of payload) {
    if (typeof it === 'string' || typeof it === 'number') {
      items.push({ title: String(it), sub: null })
      continue
    }
    if (!it || typeof it !== 'object') return null
    if (it.title === undefined) return null
    items.push({ title: String(it.title), sub: it.sub === undefined ? null : String(it.sub) })
  }
  return items
}

function normalizeText(payload) {
  if (typeof payload === 'string') return payload
  if (typeof payload === 'number' || typeof payload === 'boolean') return String(payload)
  if (payload && typeof payload === 'object' && payload.text !== undefined) return String(payload.text)
  if (payload === undefined || payload === null) return ''
  return null
}
