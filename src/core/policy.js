// src/core/policy.js —— 运行时设置：**唯一真值在数据目录里**。
//
// 为什么要有这个文件：README 第一句承诺是"所有数据+设置+模块都放置于该目录，复制粘贴就能迁移"。
// 在此之前，端口、演化周期、主动开口周期、日志级别这些都只存在 DSH 的插件配置里——
// 把数据目录搬到新机器，人格和记忆都在，但这些"她怎么运转"的旋钮全要重配一遍。
//
// 现在的分工：
//   · DSH 设置页 = **首个默认值**（安装时给的初值，也是没有 policy.json 时的兜底）；
//   · `system/policy.json` = **真值**。存在就以它为准，谁都不覆盖它。
//   · 唯一搬运不走的：`dataDir` 本身（它决定去哪找数据目录，鸡生蛋）
//     和 MCP 客户端配置（那是 DSH 的东西，不是原灵的数据）。
import path from 'node:path'
import { readJson, writeJsonAtomic, localIso } from './fsx.js'
import { P } from './paths.js'

/**
 * 每个字段都写清"要不要重启"：不标的话，人改了端口发现没反应，会以为坏掉了。
 */
export const POLICY_FIELDS = {
  consoleEnabled: { type: 'bool', def: true, restart: true, label: '管理台', hint: '关掉就连不上这个页面了（改回来只能改文件或 DSH 设置页）' },
  consoleHost: { type: 'string', def: '127.0.0.1', restart: true, label: '监听地址', hint: '默认只允许回环；改成 0.0.0.0 必须同时打开 allowRemote' },
  consolePort: { type: 'number', def: 17777, min: 0, max: 65535, restart: true, label: '端口', hint: '0 = 随机' },
  allowRemote: { type: 'bool', def: false, restart: true, label: '允许非回环', hint: '打开前先想清楚：这是你的私人记忆' },
  autoApproveDays: { type: 'number', def: 3, min: 0, max: 365, label: '提案等待天数', hint: '兜底默认值：人格规则里写了就以规则为准' },
  dailyAutoLimit: { type: 'number', def: 1, min: 0, max: 50, label: '每天自动采纳上限', hint: '兜底默认值；0 = 只手动采纳' },
  evolveEveryHours: { type: 'number', def: 6, min: 0, max: 168, label: '演化扫描周期（小时）', hint: '0 = 关掉自动扫描，只保留手动' },
  proactiveEveryMinutes: { type: 'number', def: 15, min: 0, max: 1440, label: '主动开口周期（分钟）', hint: '0 = 不自动算；只产出待发，不真发送' },
  logLevel: { type: 'enum', values: ['debug', 'info', 'warn', 'error'], def: 'info', label: '日志级别' },
}

export const POLICY_KEYS = Object.keys(POLICY_FIELDS)

function policyAbs(root) {
  return path.join(root, P.policy)
}

function coerce(key, value) {
  const spec = POLICY_FIELDS[key]
  if (spec.type === 'bool') {
    if (typeof value === 'boolean') return value
    if (value === 'true' || value === 1 || value === '1') return true
    if (value === 'false' || value === 0 || value === '0') return false
    throw new Error(`${spec.label ?? key} 要的是 true/false，收到：${JSON.stringify(value)}`)
  }
  if (spec.type === 'number') {
    const n = Number(value)
    if (!Number.isFinite(n)) throw new Error(`${spec.label ?? key} 要的是数字，收到：${JSON.stringify(value)}`)
    if (spec.min != null && n < spec.min) throw new Error(`${spec.label ?? key} 不能小于 ${spec.min}`)
    if (spec.max != null && n > spec.max) throw new Error(`${spec.label ?? key} 不能大于 ${spec.max}`)
    return Math.round(n)
  }
  if (spec.type === 'enum') {
    const s = String(value ?? '').trim()
    if (!spec.values.includes(s)) throw new Error(`${spec.label ?? key} 只能是：${spec.values.join(' / ')}`)
    return s
  }
  return String(value ?? '').trim()
}

/** 把任意来源的原始对象规整成一份完整 policy（缺的用默认值补）。 */
export function normalizePolicy(raw = {}) {
  const out = {}
  for (const [key, spec] of Object.entries(POLICY_FIELDS)) {
    const v = raw?.[key]
    if (v === undefined || v === null || v === '') {
      out[key] = spec.def
      continue
    }
    try {
      out[key] = coerce(key, v)
    } catch {
      out[key] = spec.def // 坏值不让整个插件起不来，下面是"改它"的地方
    }
  }
  return out
}

/** 读：永远返回一份完整可用的设置。 */
export function readPolicy(root) {
  return normalizePolicy(readJson(policyAbs(root), null) ?? {})
}

/**
 * 首次运行 / 老数据升级：把 DSH 设置页的初值灌进来。
 *
 * **只补缺，不覆盖**：文件里已经有的键一律保留——否则每次启动都会把人在数据目录里改过的值冲掉，
 * 那比"设置不在数据目录里"更糟。
 */
export function ensurePolicy(root, seed = {}) {
  const abs = policyAbs(root)
  const existing = readJson(abs, null)
  const base = existing && typeof existing === 'object' ? existing : {}
  const next = { ...base }
  let touched = false

  // 只把**文件里没有的**键用初值补上；不把默认值也写进去——
  // 否则"文件里是默认值"和"人特意设成默认值"就分不开了，以后 DSH 改了初值也传不进来。
  for (const key of POLICY_KEYS) {
    if (base[key] !== undefined) continue
    if (seed[key] === undefined) continue
    try {
      next[key] = coerce(key, seed[key])
      touched = true
    } catch {
      /* 初值是坏的就不写，读取时会回落到默认值 */
    }
  }

  if (touched || !existing) {
    next._comment = '运行设置的唯一真值；DSH 设置页只在没有这个键的时候提供初值。'
    next.updated_at = localIso()
    writeJsonAtomic(abs, next)
  }
  return readPolicy(root)
}

/**
 * 改设置。只接受已知字段，坏值直接抛（不静默兜底——"我明明填了"比报错更伤人）。
 */
export function writePolicy(root, patch = {}, { reason = '更新运行设置' } = {}) {
  const cur = readJson(policyAbs(root), null)
  const next = { ...(cur && typeof cur === 'object' ? cur : {}) }
  const changed = []
  for (const [key, value] of Object.entries(patch)) {
    if (!POLICY_FIELDS[key]) throw new Error(`不认识的设置项：${key}（可用：${POLICY_KEYS.join(' / ')}）`)
    const v = coerce(key, value)
    if (next[key] !== v) changed.push(key)
    next[key] = v
  }
  next._comment = '运行设置的唯一真值；DSH 设置页只在没有这个文件时提供初值。'
  next._reason = String(reason).slice(0, 200)
  next.updated_at = localIso()
  writeJsonAtomic(policyAbs(root), next)
  return { policy: normalizePolicy(next), changed }
}

/**
 * 把"DSH 传进来的配置"和"数据目录里的设置"合成真正生效的那一份。
 *
 * policy 赢：它是真值；config 只是初值与兜底。
 */
export function runtimeConfig(config = {}, policy = {}) {
  const p = normalizePolicy(policy)
  return {
    ...config,
    consoleEnabled: p.consoleEnabled,
    consoleHost: p.consoleHost,
    consolePort: p.consolePort,
    allowRemote: p.allowRemote,
    autoApproveDays: p.autoApproveDays,
    dailyAutoLimit: p.dailyAutoLimit,
    evolveEveryHours: p.evolveEveryHours,
    proactiveEveryMinutes: p.proactiveEveryMinutes,
    logLevel: p.logLevel,
  }
}

/** 给页面用：字段说明 + 当前值（不含敏感内容，这里本来也没有）。 */
export function policyView(root) {
  const cur = readPolicy(root)
  return POLICY_KEYS.map((key) => {
    const spec = POLICY_FIELDS[key]
    return {
      key,
      label: spec.label ?? key,
      hint: spec.hint ?? '',
      type: spec.type,
      values: spec.values ?? null,
      min: spec.min ?? null,
      max: spec.max ?? null,
      restart: Boolean(spec.restart),
      value: cur[key],
    }
  })
}
