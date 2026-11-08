// src/core/modules/configschema.js —— 模块配置的 schema 校验（协议 §3.1 的那个子集）。
//
// 为什么要单独一层：模块的 config 是**核心保管**的（模块自己不读文件），所以核心在写之前
// 必须能说"这份值合不合你的 schema"。不校验的后果很具体：用户把 ws 地址填成空串、
// 把 timeout 填成 "abc"，模块拿到手要么崩、要么静默用错值，而页面上什么提示都没有。
//
// 只支持协议承诺的子集：type / properties / required / enum / default / description，
// 外加 v1.3 的一组**展示提示**（`x-widget` / `x-min` / `x-max` / `x-step` / `x-enum-style`），
// 以及 `type: "array"` + `items`（列表型配置，比如规则列表）。
//
// 展示提示与校验分开：`x-*` 只影响画什么控件，**不参与校验**；校验只认 type/enum/required/min/max。
// 这样"把开关画成勾选框"不会改变存取语义。
export const SUPPORTED_TYPES = ['string', 'number', 'boolean', 'array']

/** 展示形态（`x-widget`）。不认识的写法退回按类型推断。
 *
 * `action` / `file` 是**占位控件**：只画出来、不提交、不校验。
 * 它们要等 v1.3 的 `ui.action` 协议（按钮触发动作）和核心侧文件选择器——
 * 现在先让模块能把"这里将来会有一个按钮"摆出来，而不是逼它假装成输入框。
 */
export const WIDGETS = ['input', 'textarea', 'switch', 'checkbox', 'radio', 'select', 'slider', 'list', 'action', 'file']

/** 只画不提交的控件。 */
export const UI_ONLY_WIDGETS = ['action', 'file']

/** schema 里我们真的会用的键。其余键只记进 unsupported 里。 */
const SUPPORTED_KEYS = new Set(['type', 'properties', 'required', 'description', 'items', 'minimum', 'maximum'])
const PRESENTATION_KEYS = new Set(['x-widget', 'x-min', 'x-max', 'x-step', 'x-enum-style', 'x-fields'])

/**
 * 校验并规范化一份配置值。
 *
 * 规范化的三件事，都是为了"写进磁盘的东西是干净的"：
 *   ① 未填的可选项**不写**（不塞空串，否则模块要区分"没配"和"配成空"）；
 *   ② 数字接受字符串输入（页面里 type=number 也可能给出 "20000"）；
 *   ③ 布尔接受 true/false/"true"/1 这类常见写法。
 *
 * @returns {{ok:boolean, value:object, errors:Array<{field:string,message:string}>, unknown:string[], unsupported:string[]}}
 */
export function validateConfig(schema, rawValue) {
  const errors = []
  const out = {}
  const unknown = []
  const unsupported = []

  if (!schema || typeof schema !== 'object' || Array.isArray(schema)) {
    // 没有 schema 就不校验：老模块可能声明了 config 却没给 schema
    return { ok: true, value: isPlainObject(rawValue) ? { ...rawValue } : {}, errors, unknown, unsupported }
  }

  for (const k of Object.keys(schema)) {
    if (k !== 'type' && !SUPPORTED_KEYS.has(k)) unsupported.push(k)
  }
  if (schema.type !== undefined && schema.type !== 'object') {
    unsupported.push(`type:${schema.type}`)
  }

  const props = isPlainObject(schema.properties) ? schema.properties : {}
  const required = Array.isArray(schema.required) ? schema.required.map(String) : []
  const raw = isPlainObject(rawValue) ? rawValue : {}

  // 未声明在 properties 里的键：不写入（免得模块配置里长出一堆没人认识的字段）
  for (const k of Object.keys(raw)) {
    if (!props[k]) unknown.push(k)
  }

  for (const [key, spec] of Object.entries(props)) {
    const decl = isPlainObject(spec) ? spec : {}
    const type = String(decl.type ?? 'string')

    // 占位控件（按钮 / 浏览文件）：不参与校验，也不会被存进配置——它们没有"值"
    if (UI_ONLY_WIDGETS.includes(String(decl['x-widget'] ?? ''))) continue

    if (!SUPPORTED_TYPES.includes(type)) {
      unsupported.push(`${key}.type=${type}`)
      continue
    }
    for (const k of Object.keys(decl)) {
      if (['type', 'description', 'default', 'enum', 'required', 'x-secret'].includes(k)) continue
      if (PRESENTATION_KEYS.has(k)) continue // 展示提示不影响校验
      if (!SUPPORTED_KEYS.has(k)) unsupported.push(`${key}.${k}`)
    }

    const v = raw[key]
    const isEmpty = v === undefined || v === null || (typeof v === 'string' && v.trim() === '')

    if (isEmpty) {
      if (required.includes(key)) {
        errors.push({ field: key, message: '必填' })
      } else if (decl.default !== undefined) {
        out[key] = decl.default
      }
      // 可选项留空 = 不写这个键（不是"写成空串"）
      continue
    }

    if (type === 'number') {
      const n = typeof v === 'number' ? v : Number(String(v).trim())
      if (!Number.isFinite(n)) {
        errors.push({ field: key, message: `不是合法数字：${String(v)}` })
        continue
      }
      // 范围用 minimum/maximum（标准 JSON Schema 键），滑块就用它定两端
      if (typeof decl.minimum === 'number' && n < decl.minimum) {
        errors.push({ field: key, message: `不能小于 ${decl.minimum}（收到 ${n}）` })
        continue
      }
      if (typeof decl.maximum === 'number' && n > decl.maximum) {
        errors.push({ field: key, message: `不能大于 ${decl.maximum}（收到 ${n}）` })
        continue
      }
      out[key] = n
      continue
    }

    if (type === 'array') {
      if (!Array.isArray(v)) {
        errors.push({ field: key, message: '必须是数组' })
        continue
      }
      const itemSpec = isPlainObject(decl.items) ? decl.items : null
      if (!itemSpec) {
        // 没给 items 就只要求"是数组"，元素原样收下
        out[key] = v
        continue
      }
      const itemProps = isPlainObject(itemSpec.properties) ? itemSpec.properties : {}
      const itemRequired = Array.isArray(itemSpec.required) ? itemSpec.required.map(String) : []
      const rows = []
      let bad = false
      v.forEach((row, i) => {
        if (!isPlainObject(row)) {
          errors.push({ field: `${key}[${i}]`, message: '每一项必须是对象' })
          bad = true
          return
        }
        const one = {}
        for (const [ik, ispec] of Object.entries(itemProps)) {
          const idecl = isPlainObject(ispec) ? ispec : {}
          const ival = row[ik]
          const empty = ival === undefined || ival === null || (typeof ival === 'string' && ival.trim() === '')
          if (empty) {
            if (itemRequired.includes(ik)) {
              errors.push({ field: `${key}[${i}].${ik}`, message: '必填' })
              bad = true
            } else if (idecl.default !== undefined) one[ik] = idecl.default
            continue
          }
          if (String(idecl.type) === 'number') {
            const n = Number(ival)
            if (!Number.isFinite(n)) {
              errors.push({ field: `${key}[${i}].${ik}`, message: `不是合法数字：${String(ival)}` })
              bad = true
              continue
            }
            one[ik] = n
          } else if (String(idecl.type) === 'boolean') {
            one[ik] = ival === true || ival === 'true' || ival === 1 || ival === '1'
          } else {
            one[ik] = String(ival)
          }
        }
        rows.push(one)
      })
      if (bad) continue
      out[key] = rows
      continue
    }

    if (type === 'boolean') {
      if (typeof v === 'boolean') out[key] = v
      else if (v === 1 || v === '1' || String(v).toLowerCase() === 'true') out[key] = true
      else if (v === 0 || v === '0' || String(v).toLowerCase() === 'false') out[key] = false
      else {
        errors.push({ field: key, message: `不是布尔值：${String(v)}` })
        continue
      }
      continue
    }

    const s = String(v)
    if (Array.isArray(decl.enum) && decl.enum.length && !decl.enum.map(String).includes(s)) {
      errors.push({ field: key, message: `只能填 ${decl.enum.join(' / ')}（收到「${s}」）` })
      continue
    }
    out[key] = s
  }

  return { ok: errors.length === 0, value: out, errors, unknown, unsupported }
}

/** 页面渲染用：把 schema 里的字段拍平成数组，省得前端再猜结构。 */
export function describeFields(schema) {
  const props = isPlainObject(schema?.properties) ? schema.properties : {}
  const required = Array.isArray(schema?.required) ? schema.required.map(String) : []
  return Object.entries(props).map(([key, spec]) => {
    const decl = isPlainObject(spec) ? spec : {}
    const type = SUPPORTED_TYPES.includes(String(decl.type)) ? String(decl.type) : 'string'
    const enumList = Array.isArray(decl.enum) ? decl.enum.map(String) : null
    return {
      key,
      type,
      label: key,
      description: String(decl.description ?? ''),
      enum: enumList,
      default: decl.default ?? null,
      required: required.includes(key),
      // 画什么控件：x-widget 优先，否则按类型/枚举推断
      widget: pickWidget(decl, type, enumList),
      // 滑块的量程（标准 JSON Schema 的 minimum/maximum，或 x-min/x-max）
      min: numOrNull(decl.minimum ?? decl['x-min']),
      max: numOrNull(decl.maximum ?? decl['x-max']),
      step: numOrNull(decl['x-step']) ?? 1,
      // 列表型配置：每一行有哪些字段、哪些必填
      itemFields: type === 'array' ? describeItemFields(decl) : null,
      // 密码类字段：schema 里没显式声明 x-secret 时，按字段名猜。
      // `jct` 也在这里——它是 B 站的 CSRF 凭证（bili_jct），和 sessdata 同级敏感。
      secret:
        decl['x-secret'] === true ||
        /(sessdata|jct|token|cookie|secret|password|passwd|api[-_]?key)/i.test(key),
    }
  })
}

function isPlainObject(v) {
  return Boolean(v) && typeof v === 'object' && !Array.isArray(v)
}

function numOrNull(v) {
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}

/**
 * 挑控件。顺序是：显式 `x-widget` → 按类型推断 → 兜底。
 * 推断规则尽量贴近直觉：有 enum 就是选择类，布尔就是开关，数字有量程就是滑块。
 */
function pickWidget(decl, type, enumList) {
  const explicit = String(decl['x-widget'] ?? '').trim()
  if (WIDGETS.includes(explicit)) return explicit

  if (enumList && enumList.length) {
    // 选项少用单选（看得全）、多了用下拉
    return String(decl['x-enum-style'] ?? (enumList.length <= 5 ? 'radio' : 'select'))
  }
  if (type === 'boolean') return 'switch'
  if (type === 'number') {
    const hasRange = typeof decl.minimum === 'number' && typeof decl.maximum === 'number'
    return hasRange ? 'slider' : 'input'
  }
  if (type === 'array') return 'list'
  const long = String(decl.description ?? '').length > 40 || decl['x-widget'] === 'textarea'
  return long ? 'textarea' : 'input'
}

/** 列表型配置的每行字段（只支持一层：数组里放对象）。 */
function describeItemFields(decl) {
  const items = isPlainObject(decl.items) ? decl.items : {}
  const props = isPlainObject(items.properties) ? items.properties : {}
  const required = Array.isArray(items.required) ? items.required.map(String) : []
  return Object.entries(props).map(([key, spec]) => {
    const d = isPlainObject(spec) ? spec : {}
    const type = SUPPORTED_TYPES.includes(String(d.type)) ? String(d.type) : 'string'
    return {
      key,
      type,
      label: key,
      enum: Array.isArray(d.enum) ? d.enum.map(String) : null,
      required: required.includes(key),
      widget: pickWidget(d, type, Array.isArray(d.enum) ? d.enum.map(String) : null),
    }
  })
}
