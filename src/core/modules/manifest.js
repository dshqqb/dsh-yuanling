// src/core/modules/manifest.js —— yuanling.module.json 的校验（协议 §3）。
//
// 纯函数，不碰文件系统：给它一个已解析的对象，回 {ok, errors[]}。
// 校验规则逐条对应 §3.3，宁可拒装，也不让一个坏的 manifest 进注册表。
export const API_MAJOR = 1
export const API_MINOR = 1

/** §3.2 id 保留字：模块 id 会成为 raw 的来源名，撞名会污染原始层。 */
export const RESERVED_IDS = [
  'system', 'dsh', 'console', 'web', 'raw', 'media', 'personas', 'rules', 'test', 'dev', 'null',
]

/** §5.3 / §12 的能力词表——**封闭**：一处不多一处不少。 */
export const CAPABILITIES = [
  'ingest.message',
  'propose.fact',
  'media.put.file',
  'media.read',
  'send',
  'actuate',
  // v1.1：模块可以被核心按需要数据（配合 manifest.sources 与 op source.fetch）。
  // 与 send 方向相反——send 是往外说话，这个是往里取数，所以是独立的一个词。
  'provide.source',
]

/** §3.4（v1.1）：`sources[].params` 只允许这个子集，超出的类型一律拒装。 */
const PARAM_TYPES = ['string', 'number', 'boolean']

export const KINDS = ['gateway', 'actuator', 'enricher']

const SEMVER_RE = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/
/** id 要能当目录名与文件名，且不能是保留字。 */
const ID_RE = /^[a-z][a-z0-9-]{1,31}$/

function isString(v) {
  return typeof v === 'string' && v.trim() !== ''
}

/**
 * 解析 semver。**api 允许只写 `1.0`**（协议 §3.3 只要求主/次版本），
 * 所以补丁号与预发布后缀都可选。version / minCore 仍按三段严格校验（见 SEMVER_RE）。
 */
export function parseSemver(v) {
  const m = /^(\d+)\.(\d+)(?:\.(\d+))?(?:-[0-9A-Za-z.-]+)?$/.exec(String(v ?? '').trim())
  if (!m) return null
  return { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3] ?? 0) }
}

/** `api` 能否被当前核心接受：主版本必须相同，次版本不能比核心高。 */
export function checkApi(api) {
  const s = parseSemver(api)
  if (!s) return { ok: false, reason: `api 不是合法 semver：${api}` }
  if (s.major !== API_MAJOR) {
    return { ok: false, reason: `api 主版本 ${s.major} 与核心 ${API_MAJOR} 不符（主版本变了就是不兼容）` }
  }
  if (s.minor > API_MINOR) {
    return { ok: false, reason: `模块要求 api ${s.major}.${s.minor}，核心只实现到 ${API_MAJOR}.${API_MINOR}` }
  }
  return { ok: true }
}

/**
 * v1.1 §3.4：`sources[]` 的形状。
 *
 * 为什么 id 必须带模块前缀：source 出现在模型工具参数里（`yuanling_fetch` 的 source），
 * 全局唯一才不会两个模块抢同一个名字；前缀由模块自己的 id 定，不需要第二张注册表。
 */
function validateSources(raw, moduleId, err) {
  if (!Array.isArray(raw.sources)) {
    err('sources', 'BAD_FORMAT', 'sources 必须是数组')
    return []
  }
  const out = []
  const seen = new Set()
  raw.sources.forEach((s, i) => {
    const at = `sources[${i}]`
    if (!s || typeof s !== 'object' || Array.isArray(s)) {
      err(at, 'BAD_FORMAT', '每项必须是对象')
      return
    }
    if (!isString(s.id)) err(`${at}.id`, 'MISSING', 'id 必填')
    else if (!/^[a-z][a-z0-9._-]{2,63}$/.test(s.id)) {
      err(`${at}.id`, 'BAD_FORMAT', 'id 只能是小写字母/数字/点/下划线/连字符（3~64 字符，首字符是字母）')
    } else if (!String(s.id).startsWith(`${moduleId}.`)) {
      // 前缀不是排版洁癖：模型只看到 source id，看不到模块，靠前缀才追得回是谁给的
      err(`${at}.id`, 'BAD_PREFIX', `source id 必须以「${moduleId}.」开头`)
    } else if (seen.has(s.id)) {
      err(`${at}.id`, 'DUPLICATE', `source id 重复：${s.id}`)
    }
    if (isString(s.id)) seen.add(s.id)
    if (!isString(s.title)) err(`${at}.title`, 'MISSING', 'title 必填（给模型看的一句话说明）')

    if (s.params !== undefined) {
      const p = s.params
      if (!p || typeof p !== 'object' || Array.isArray(p)) {
        err(`${at}.params`, 'BAD_FORMAT', 'params 必须是对象')
      } else {
        if (p.type !== 'object') err(`${at}.params.type`, 'BAD_FORMAT', 'params.type 只能是 "object"')
        const props = p.properties ?? {}
        if (typeof props !== 'object' || Array.isArray(props)) {
          err(`${at}.params.properties`, 'BAD_FORMAT', 'properties 必须是对象')
        } else {
          for (const [k, v] of Object.entries(props)) {
            if (!v || typeof v !== 'object') err(`${at}.params.properties.${k}`, 'BAD_FORMAT', '每个属性必须是对象')
            else if (!PARAM_TYPES.includes(v.type)) {
              err(`${at}.params.properties.${k}.type`, 'UNSUPPORTED', `参数类型只支持 ${PARAM_TYPES.join(' / ')}`)
            }
          }
          if (Array.isArray(p.required)) {
            for (const k of p.required) {
              if (!Object.hasOwn(props, String(k))) {
                err(`${at}.params.required`, 'BAD_FORMAT', `required 里的「${k}」没有在 properties 里声明`)
              }
            }
          } else if (p.required !== undefined) {
            err(`${at}.params.required`, 'BAD_FORMAT', 'required 必须是数组')
          }
        }
      }
    }

    out.push({
      id: s.id,
      title: s.title,
      params: s.params ?? null,
    })
  })
  return out
}

/**
 * @param {object} raw 已 JSON.parse 的 manifest
 * @returns {{ok:boolean, errors:Array<{field:string,code:string,message:string}>, manifest?:object}}
 */
export function validateManifest(raw) {
  const errors = []
  const err = (field, code, message) => errors.push({ field, code, message })

  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    err('*', 'NOT_OBJECT', 'manifest 必须是一个 JSON 对象')
    return { ok: false, errors }
  }

  // id
  if (!isString(raw.id)) err('id', 'MISSING', 'id 必填')
  else if (!ID_RE.test(raw.id)) err('id', 'BAD_FORMAT', 'id 只能是小写字母/数字/连字符，2~32 字符，首字母必须是字母')
  else if (RESERVED_IDS.includes(raw.id)) err('id', 'RESERVED', `id「${raw.id}」是保留字（会撞 raw 的来源名）`)

  // version / minCore
  if (!isString(raw.version) || !SEMVER_RE.test(raw.version)) err('version', 'BAD_SEMVER', 'version 必须是合法 semver')
  if (raw.minCore !== undefined && !SEMVER_RE.test(String(raw.minCore))) {
    err('minCore', 'BAD_SEMVER', 'minCore 必须是合法 semver')
  }

  // api
  const api = checkApi(raw.api)
  if (!api.ok) err('api', 'INCOMPATIBLE', api.reason)

  // kind
  if (raw.kind !== undefined && !KINDS.includes(raw.kind)) {
    err('kind', 'UNKNOWN', `kind 只能是 ${KINDS.join(' / ')}`)
  }

  // entry.command
  const cmd = raw.entry?.command
  if (!Array.isArray(cmd) || cmd.length === 0) {
    err('entry.command', 'MISSING', 'entry.command 必须是非空数组')
  } else {
    if (!isString(cmd[0])) err('entry.command', 'BAD_FORMAT', 'entry.command[0] 必须是非空字符串')
    else if (/[/\\]/.test(cmd[0])) {
      err('entry.command', 'ABSOLUTE', 'entry.command[0] 不能含路径分隔符（用 $YUANLING_NODE 或裸命令名）')
    }
    if (cmd.some((x) => typeof x !== 'string')) err('entry.command', 'BAD_FORMAT', 'entry.command 每项都必须是字符串')
  }

  // capabilities：封闭词表
  if (raw.capabilities !== undefined) {
    if (!Array.isArray(raw.capabilities)) err('capabilities', 'BAD_FORMAT', 'capabilities 必须是数组')
    else {
      for (const c of raw.capabilities) {
        if (typeof c !== 'string' || !CAPABILITIES.includes(c)) {
          err('capabilities', 'UNKNOWN', `未知能力「${String(c)}」（合法值：${CAPABILITIES.join(' / ')}）`)
        }
      }
    }
  }

  // sources（v1.1）：声明"我这儿有什么数据可以被要"。带它就必须声明 api 1.1，
  // 不然一个只认 1.0 的核心装上去，模块会等一个永远不会来的 source.fetch。
  let sources = []
  if (raw.sources !== undefined) {
    const s = parseSemver(raw.api)
    if (s && s.minor < 1) {
      err('api', 'INCOMPATIBLE', '声明了 sources 就必须写 api "1.1" 或更高（source.fetch 是 v1.1 的 op）')
    }
    sources = validateSources(raw, raw.id, err)
  }

  // routes：两种语法（前缀 / 精确），且不能与别人的重叠 —— 重叠检查需要外部信息，这里只验形状
  if (raw.routes !== undefined) {
    if (!Array.isArray(raw.routes)) err('routes', 'BAD_FORMAT', 'routes 必须是数组')
    else {
      for (const r of raw.routes) {
        if (!r || typeof r !== 'object') err('routes', 'BAD_FORMAT', '每项必须是对象')
        else if (!isString(r.path) || !String(r.path).startsWith('/')) {
          err('routes', 'BAD_PATH', 'route.path 必须以 / 开头')
        }
      }
    }
  }

  // config.schema 只允许 JSON Schema 子集
  if (raw.config !== undefined) {
    if (raw.config?.schema === undefined) err('config.schema', 'MISSING', '声明了 config 就必须给 schema')
    else if (typeof raw.config.schema !== 'object') err('config.schema', 'BAD_FORMAT', 'config.schema 必须是对象')
  }

  if (errors.length) return { ok: false, errors }

  return {
    ok: true,
    errors: [],
    manifest: {
      id: raw.id,
      version: raw.version,
      minCore: raw.minCore ?? null,
      api: raw.api,
      kind: raw.kind ?? 'gateway',
      entry: { command: cmd },
      capabilities: raw.capabilities ?? [],
      permissions: raw.permissions ?? [],
      routes: raw.routes ?? [],
      sources,
      config: raw.config ?? null,
    },
  }
}

/** 把 errors 压成一行，给 CLI / 页面显示。 */
export function summarizeErrors(errors) {
  return (errors ?? []).map((e) => `${e.field}: ${e.message}`).join('；')
}
