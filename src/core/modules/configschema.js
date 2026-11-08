// src/core/modules/configschema.js —— 模块配置的 schema 校验（协议 §3.1 的那个子集）。
//
// 为什么要单独一层：模块的 config 是**核心保管**的（模块自己不读文件），所以核心在写之前
// 必须能说"这份值合不合你的 schema"。不校验的后果很具体：用户把 ws 地址填成空串、
// 把 timeout 填成 "abc"，模块拿到手要么崩、要么静默用错值，而页面上什么提示都没有。
//
// 只支持协议承诺的子集：type / properties / required / enum / default / description。
// 遇到子集外的东西（oneOf、pattern 之类）**不猜**：忽略它，并在结果里标出来，
// 免得用户以为"我写了校验规则但它没生效"。
export const SUPPORTED_TYPES = ['string', 'number', 'boolean']

/** schema 里我们真的会用的键。其余键只记进 unsupported 里。 */
const SUPPORTED_KEYS = new Set(['type', 'properties', 'required', 'description'])

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
    if (!SUPPORTED_TYPES.includes(type)) {
      unsupported.push(`${key}.type=${type}`)
      continue
    }
    for (const k of Object.keys(decl)) {
      if (!['type', 'description', 'default', 'enum', 'required', 'x-secret'].includes(k)) unsupported.push(`${key}.${k}`)
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
      out[key] = n
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
    return {
      key,
      type: SUPPORTED_TYPES.includes(String(decl.type)) ? String(decl.type) : 'string',
      label: key,
      description: String(decl.description ?? ''),
      enum: Array.isArray(decl.enum) ? decl.enum.map(String) : null,
      default: decl.default ?? null,
      required: required.includes(key),
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
