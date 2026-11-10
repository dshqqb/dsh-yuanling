// src/core/modules/manifest.js —— yuanling.module.json 的校验（协议 §3）。
//
// 纯函数，不碰文件系统：给它一个已解析的对象，回 {ok, errors[]}。
// 校验规则逐条对应 §3.3，宁可拒装，也不让一个坏的 manifest 进注册表。
export const API_MAJOR = 1
export const API_MINOR = 5

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
  // v1.5：取 / 回执"她主动想说的话"。和 send 都是"往外说话"，但单独一个词：
  // 只做投递的模块可以只申请 send，不必拿到队列。
  'outbox',
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

/** §3.4（v1.2）：`ui.tabs` 的渲染形态。**封闭三选一**，模块不能自带 HTML。 */
export const UI_KINDS = ['list', 'kv', 'text', 'config', 'records']
/** 最多几个自定义 tab：管理台的 tab 条再长就没法用了。 */
export const UI_MAX_TABS = 5
/**
 * 核心保留的 tab id：模块详情页的前四个永远是核心的（概况 / 日志 / 审计 / 诊断）。
 *
 * v1.4 加了后两个。不挡的话，模块声明同 id 的 tab 能过校验，点开却被静默顶成
 * 核心那页——模块自己的页面永远打不开，还不报错（这种"能用但看不到"最难查）。
 */
export const UI_RESERVED = ['brief', 'log', 'audit', 'diag']
/** 这些 tab 名也归核心，模块别用（同名会让人分不清点的是哪个）。 */
export const UI_RESERVED_LABELS = ['概况', '日志', '审计', '诊断']

/**
 * v1.2 §3.5：`ui` 的形状。
 *
 * 为什么只允许三种 kind、且只传数据不传标记：管理台持有 console.token，
 * 能读全部记忆、改规则、卸模块。模块一旦能下发 HTML/JS，等于拿到整个库的钥匙。
 * 所以这里的原则是——**模块只说"给我画一个列表/键值对/一段文字"**，画法由核心定。
 */
function validateUi(raw, err) {
  const ui = raw.ui
  if (!ui || typeof ui !== 'object' || Array.isArray(ui)) {
    err('ui', 'BAD_FORMAT', 'ui 必须是对象')
    return null
  }
  if (ui.tabs === undefined) return { tabs: [] }
  if (!Array.isArray(ui.tabs)) {
    err('ui.tabs', 'BAD_FORMAT', 'ui.tabs 必须是数组')
    return null
  }
  if (ui.tabs.length > UI_MAX_TABS) {
    err('ui.tabs', 'TOO_MANY', `最多 ${UI_MAX_TABS} 个自定义 tab（收到 ${ui.tabs.length} 个）`)
  }

  const seen = new Set()
  const tabs = []
  ui.tabs.forEach((t, i) => {
    const at = `ui.tabs[${i}]`
    if (!t || typeof t !== 'object' || Array.isArray(t)) {
      err(at, 'BAD_FORMAT', '每项必须是对象')
      return
    }
    if (!isString(t.id)) err(`${at}.id`, 'MISSING', 'id 必填')
    else if (!/^[a-z][a-z0-9-]{1,23}$/.test(t.id)) {
      err(`${at}.id`, 'BAD_FORMAT', 'id 只能是小写字母/数字/连字符（2~24 字符，首字母是字母）')
    } else if (UI_RESERVED.includes(t.id)) {
      err(`${at}.id`, 'RESERVED', `「${t.id}」是核心保留的 tab id`)
    } else if (seen.has(t.id)) {
      err(`${at}.id`, 'DUPLICATE', `tab id 重复：${t.id}`)
    }
    if (!isString(t.label)) err(`${at}.label`, 'MISSING', 'label 必填（tab 上显示的名字）')
    else if (String(t.label).length > 16) err(`${at}.label`, 'TOO_LONG', 'label 最多 16 个字')
    else if (UI_RESERVED_LABELS.includes(String(t.label))) {
      err(`${at}.label`, 'RESERVED', `「${UI_RESERVED_LABELS.join('」「')}」是核心的 tab 名`)
    }
    if (t.kind !== undefined && !UI_KINDS.includes(String(t.kind))) {
      err(`${at}.kind`, 'UNKNOWN', `kind 只能是 ${UI_KINDS.join(' / ')}`)
    }
    // config 型 tab 可以只认领一组字段（不写就表示"没被别的 tab 认领的全部"）。
    // 不认领的话，"规则"这种页会把 cookie 一起铺进去——那显然不是想要的。
    let fields = null
    if (t.fields !== undefined) {
      if (!Array.isArray(t.fields) || t.fields.some((k) => !isString(k))) {
        err(`${at}.fields`, 'BAD_FORMAT', 'fields 必须是非空字符串数组')
      } else if (String(t.kind ?? '') !== 'config' && t.kind !== undefined) {
        err(`${at}.fields`, 'BAD_FORMAT', '只有 config 型 tab 能认领字段')
      } else {
        fields = t.fields.map(String)
      }
    }
    if (isString(t.id)) seen.add(t.id)
    // records 型：模块声明"看我自己产生的哪类记录"，核心查 raw 渲染（模块不读原始层）
    let records = null
    if (String(t.kind ?? '') === 'records') {
      const spec = t.records
      if (!spec || typeof spec !== 'object' || Array.isArray(spec)) {
        err(`${at}.records`, 'MISSING', 'records 型 tab 必须给 records: { type, limit? }')
      } else if (!isString(spec.type) || !/^[a-z][a-z0-9._-]{0,31}$/.test(String(spec.type))) {
        err(`${at}.records.type`, 'BAD_FORMAT', 'records.type 必须是小写字母开头的短标识（如 like）')
      } else {
        let limit = 50
        if (spec.limit !== undefined) {
          const n = Number(spec.limit)
          if (!Number.isInteger(n) || n < 1 || n > 200) err(`${at}.records.limit`, 'BAD_FORMAT', 'records.limit 必须是 1~200 的整数')
          else limit = n
        }
        records = { type: String(spec.type), limit }
      }
    }
    tabs.push({ id: t.id, label: t.label, kind: String(t.kind ?? 'text'), fields, records })
  })

  return { tabs }
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

  // ui（v1.2）：模块能往管理台加只读的标签页。它**不进 §2.2 的 diff 清单**——
  // 调整一个 tab 的名字不该让人重新确认一次安装。但正因为"改了不提示"，这里要卡得很紧：
  // 只允许固定的三种渲染形态，不允许任何 HTML/JS/样式。
  let ui = null
  if (raw.ui !== undefined) {
    const s = parseSemver(raw.api)
    if (s && s.minor < 2) {
      err('api', 'INCOMPATIBLE', '声明了 ui 就必须写 api "1.2" 或更高（ui.get 是 v1.2 的 op）')
    }
    ui = validateUi(raw, err)
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
      ui,
      config: raw.config ?? null,
    },
  }
}

/** 把 errors 压成一行，给 CLI / 页面显示。 */
export function summarizeErrors(errors) {
  return (errors ?? []).map((e) => `${e.field}: ${e.message}`).join('；')
}
