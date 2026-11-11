// src/core/personacard.js —— 人格卡：把她是谁读成可编辑的块，再原样写回去。
//
// 三条纪律（改这里之前先读）：
//   ① **只有人能写**（`actor: 'human:editor'`）。代码里没有任何模型可调的路径写底稿，
//      这是 R1 那条"她可以长大，但不能变成另一个人"的保险丝。管理台加编辑入口不破它。
//   ② 每次写都走 `writeTracked`：带原因、进版本历史、能回滚。
//   ③ 保存是**原位替换**（见 mdtext.js）：没动过的段落一个字节都不重写。
//
// 四份底稿的生效面（2026-11-09 定，Q2=A / Q3=A）：
//   · `SELF.md`     → `[骨架] [说话] [在乎]`（三段，各带预算）
//   · `lines.md`    → `[硬线]` 200 字节。guardrails.json 是代码在拦、她看不见，这段是让她知道边界
//   · `style.md`    → `[习惯]` 160 字节。提案学到的说话习惯；不注入的话采纳提案等于什么都没发生
//   · `persona/user.md`（"用户画像"）**已废弃并删掉了**：它从未被任何代码读写，
//     而"关于你"这件事由**记忆事实 + 人物卡**覆盖。老数据目录里可能还留着那份文件，我们不删它。
//   · `core.json`   → **没人读**，纯死数据。所以卡上不出现它——不留没有作用的开关。
import fs from 'node:fs'
import path from 'node:path'
import { exists, readJson, textSha256, localIso } from './fsx.js'
import { P, personaPaths } from './paths.js'
import { writeTracked, snapshotCurrent } from './version.js'
import { parseMd, applySectionEdits, replaceTitle, trimBody } from './mdtext.js'
import { identityLines, personaExtraLines, SKELETON_BYTES, HARD_LINE_BYTES, EXPRESSION_BYTES } from './memory.js'
import { readMarker, writeMarker } from './persona.js'

/** 名字上限：注入里它是第一行，太长会把别的挤掉。 */
// 名称可以**有多个**（空格分隔），所以上限按"整串"放宽；单个名称的长度由 UI/校验各自管。
export const CARD_NAME_MAX = 64
/** 小节正文上限：底稿是散文，不是账本。超了几乎一定是贴错了地方。 */
export const CARD_SECTION_MAX = 8000

/**
 * 四份底稿各自是什么、进不进上下文、能不能直接改。
 * `tag` / `budget` 是**读代码读出来的事实**，和 memory.js 的注入函数一一对应；改注入时同步改这里。
 */
export const CARD_FILES = [
  {
    key: 'self',
    label: '骨架',
    path: (pid) => personaPaths(pid).self,
    editable: true,
    tag: null, // 分节各自有标签，见 SECTION_TAG
    budget: null,
    note: '她是谁。只有「核心身份 / 说话方式 / 价值观」三段进上下文，其余段是人看的。',
  },
  {
    key: 'lines',
    label: '硬线',
    path: (pid) => personaPaths(pid).lines,
    editable: true,
    tag: '[硬线]',
    budget: HARD_LINE_BYTES,
    note: '绝对不做的事。会整段进上下文——`guardrails.json` 是代码在拦，她看不见；这段是让她知道边界。',
  },
  {
    key: 'style',
    label: '表达层',
    path: (pid) => personaPaths(pid).style,
    editable: true,
    tag: '[习惯]',
    budget: EXPRESSION_BYTES,
    note: '她学到的说话习惯。采纳的提案写在这里，会进上下文。注意：回滚某条提案会把整个文件退回应用前那一版，手改也会一起被覆盖。',
  },
]

/** 进上下文的那三段：小节标题 → 注入标签。匹配规则和 memory.js 的 identityLines 一模一样。 */
const SECTION_TAG = { 核心身份: '[骨架]', 说话方式: '[说话]', 价值观: '[在乎]' }

function sectionKey(title) {
  if (title === '核心身份') return '核心身份'
  if (title.startsWith('说话方式')) return '说话方式'
  if (title.startsWith('价值观')) return '价值观'
  return null
}

function sectionBudget(key) {
  if (key === '核心身份') return SKELETON_BYTES.core
  if (key === '说话方式') return SKELETON_BYTES.speak
  if (key === '价值观') return SKELETON_BYTES.values
  return null
}

/**
 * 这一行实际产生了多少字节。
 *
 * 预算不能拿"这一节有多少字节"去比：`identityLines` 只抽其中几条（核心身份只取
 * 「名字」「存在的原因」），拿整节去比会把一段完全没超的内容标成超了。
 */
function lineOf(injected, tag) {
  if (!tag) return null
  const line = (injected ?? []).find((l) => String(l).startsWith(tag))
  if (!line) return null
  return { text: line, bytes: Buffer.byteLength(line.slice(tag.length).trimStart(), 'utf8') }
}

function absOf(root, rel) {
  return path.join(root, rel)
}

function readTextOrNull(p) {
  if (!exists(p)) return null
  try {
    return fs.readFileSync(p, 'utf8')
  } catch {
    return null
  }
}

function describeFile(root, pid, spec, injected) {
  const rel = spec.path(pid)
  const text = readTextOrNull(absOf(root, rel))
  const parsed = text === null ? null : parseMd(text)
  const whole = lineOf(injected, spec.tag)

  return {
    key: spec.key,
    label: spec.label,
    path: rel,
    exists: text !== null,
    editable: spec.editable !== false,
    // 进不进上下文：分节的文件看每一节，整篇的看自己
    injected: spec.key === 'self' ? true : Boolean(spec.tag),
    note: spec.note,
    budget: spec.budget ?? null,
    line: whole?.text ?? null,
    lineBytes: whole?.bytes ?? 0,
    sections: parsed
      ? parsed.sections.map((s) => {
          const key = sectionKey(s.title)
          const hit = key ? lineOf(injected, SECTION_TAG[key]) : null
          return {
            title: s.title,
            body: trimBody(s.body),
            bytes: Buffer.byteLength(trimBody(s.body), 'utf8'),
            injected: Boolean(key),
            budget: key ? sectionBudget(key) : null,
            line: hit?.text ?? null,
            lineBytes: hit?.bytes ?? 0,
          }
        })
      : [],
    hasSections: Boolean(parsed?.hasSections),
    title: parsed?.title ?? '',
    // 原文也给出去：切不出小节的文件（lines.md / style.md）在页面上按整篇展示
    text: text ?? '',
    // 整篇的指纹：保存时用它判断"你打开之后文件有没有被别人改过"
    expect: text === null ? null : textSha256(text),
    bytes: text === null ? 0 : Buffer.byteLength(text, 'utf8'),
  }
}

/**
 * 一次读全：这台机器上的人格清单 + 当前人格卡。
 *
 * @returns {{active:string|null, personas:Array, card:object|null}}
 */
export function readCard(root, pid) {
  const marker = readMarker(root)
  const personas = (marker?.personas ?? []).map((p) => ({
    id: p.id,
    name: p.name ?? p.id,
    active: p.id === pid,
    created_at: p.created_at ?? null,
    from: p.from ?? null,
    dirExists: exists(path.join(root, P.personas, p.id)),
  }))

  if (!pid) return { active: null, personas, card: null }

  const manifest = readJson(absOf(root, personaPaths(pid).manifest), null)

  // 注入实测：和模型真正读到的走同一个函数，页面上不放"差不多"的示意。
  // 先算它，再算文件——每一节都要拿"它实际被写成的那一行"来对预算。
  let injected = []
  try {
    injected = [...identityLines(root, pid), ...personaExtraLines(root, pid)]
  } catch {
    injected = []
  }

  const files = CARD_FILES.map((spec) => describeFile(root, pid, spec, injected))

  return {
    active: pid,
    personas,
    card: {
      id: pid,
      name: manifest?.name ?? personas.find((p) => p.id === pid)?.name ?? pid,
      dir: path.join(root, P.personas, pid),
      created_at: manifest?.created_at ?? null,
      updated_at: manifest?.updated_at ?? null,
      files,
      injected,
      budgets: { ...SKELETON_BYTES, hardLines: HARD_LINE_BYTES, expression: EXPRESSION_BYTES },
    },
  }
}

/**
 * 保存一份底稿（内部实现，不校验批量）。
 *
 * @param {object} opts
 * @param {'self'|'lines'|'style'} opts.file
 * @param {Array<{title:string, body:string}>} [opts.sections] 分节保存
 * @param {string} [opts.text] 整篇保存
 * @param {string} [opts.expect] 打开时的指纹；对不上就拒绝（409 语义）
 */
export function saveCardFile(root, pid, { file, sections, text, expect, reason } = {}) {
  const spec = CARD_FILES.find((f) => f.key === file)
  if (!spec) throw new Error(`不认识的文件：${file}`)
  if (spec.editable === false) throw new Error(`${spec.label} 不提供编辑入口（它不进上下文，改了不会有任何效果）`)

  const rel = spec.path(pid)
  const abs = absOf(root, rel)
  const before = readTextOrNull(abs)
  if (before === null) throw new Error(`文件不存在：${rel}（这个版本不会替你新建底稿）`)

  if (expect && expect !== textSha256(before)) {
    const err = new Error('文件在你打开之后被改过（可能有人在别处编辑了它），请刷新后再改')
    err.code = 'E_STALE'
    throw err
  }

  let next = before
  let touched = 0

  if (typeof text === 'string') {
    next = text
    touched = next === before ? 0 : 1
  } else if (Array.isArray(sections)) {
    const parsed = parseMd(before)
    if (!parsed.hasSections) throw new Error('这个文件没有 `## ` 小节，只能整篇保存')
    for (const s of sections) {
      if (String(s?.body ?? '').length > CARD_SECTION_MAX) {
        throw new Error(`小节「${s.title}」超过 ${CARD_SECTION_MAX} 字，底稿不该写这么长`)
      }
    }
    const r = applySectionEdits(parsed, sections)
    if (!r.ok) {
      const err = new Error(r.error)
      err.code = 'E_STALE'
      throw err
    }
    next = r.text
    touched = r.changed
  } else {
    throw new Error('需要 sections（分节）或 text（整篇）')
  }

  // 预算校验：**超了就拒绝保存**，而不是写进去再静默截断。
  //
  // 硬线与表达层是"必须进上下文"的两样东西：写进去却被裁掉，等于人以为改了、她其实没读到。
  // 以前硬线就是这么被砍的（278 字节 > 200 的预算，被 clipBytes 悄悄截掉一截）。
  if (spec.key === 'lines') {
    const bytes = hardLineBytes(next)
    if (bytes > HARD_LINE_BYTES) {
      throw new Error(
        `硬线超出预算：${bytes} 字节 > ${HARD_LINE_BYTES} 字节（约 ${Math.floor(HARD_LINE_BYTES / 3)} 汉字）。` +
          ' 硬线永不被裁剪，所以写超了不会生效——请删短一点再保存',
      )
    }
  }
  if (spec.key === 'style') {
    const bytes = styleItemsBytes(next)
    if (bytes > EXPRESSION_BYTES) {
      throw new Error(
        `表达层超出预算：${bytes} 字节 > ${EXPRESSION_BYTES} 字节（约 ${Math.floor(EXPRESSION_BYTES / 3)} 汉字）。` +
          ' 写超了不会生效——删一条或写短点',
      )
    }
  }

  const written = writeTracked(root, rel, next, {
    actor: 'human:editor',
    reason: reason || `管理台编辑人格底稿：${spec.label}`,
  })

  return { file: spec.key, path: rel, changed: written.changed, hash: written.hash, touched }
}

/**
 * 硬线文件里"真正会进注入"的字节数（只看 `- ` 开头的条目，和 memory.bulletLine 同一口径）。
 */
function hardLineBytes(text) {
  const items = []
  for (const line of String(text ?? '').split('\n')) {
    const m = /^\s*-\s+(.+?)\s*$/.exec(line)
    if (m && !/^<.*>$/.test(m[1].trim())) items.push(m[1].trim())
  }
  return Buffer.byteLength(items.join('；'), 'utf8')
}

/** 表达层同口径：只算条目，不算标题与说明。 */
function styleItemsBytes(text) {
  const items = []
  for (const line of String(text ?? '').split('\n')) {
    const m = /^\s*-\s+(.+?)\s*$/.exec(line)
    if (m && !/^<.*>$/.test(m[1].trim())) items.push(m[1].trim())
  }
  return Buffer.byteLength(items.join('；'), 'utf8')
}

/**
 * 批量保存：卡片上一个「保存」按钮会一次交上来几份文件。
 *
 * 先**全部校验**（存在 / 指纹 / 不认识的文件），再逐个写盘——不能出现
 * "骨架存进去了、硬线因为指纹过期没存"这种半截状态：那样人不知道哪份算数。
 *
 * @param {Array<{file:string, sections?:Array, text?:string, expect?:string}>} items
 */
export function saveCardFiles(root, pid, items, { reason } = {}) {
  const list = Array.isArray(items) ? items : []
  if (!list.length) throw new Error('没有要保存的内容')

  for (const it of list) {
    const spec = CARD_FILES.find((f) => f.key === it.file)
    if (!spec) throw new Error(`不认识的文件：${it.file}`)
    if (spec.editable === false) throw new Error(`${spec.label} 不提供编辑入口`)
    const before = readTextOrNull(absOf(root, spec.path(pid)))
    if (before === null) throw new Error(`文件不存在：${spec.path(pid)}`)
    if (it.expect && it.expect !== textSha256(before)) {
      const err = new Error('文件在你打开之后被改过（可能有人在别处编辑了它），请刷新后再改')
      err.code = 'E_STALE'
      throw err
    }
  }

  const out = []
  for (const it of list) {
    out.push(saveCardFile(root, pid, { ...it, reason: it.reason || reason }))
  }
  return { files: out, changed: out.filter((r) => r.changed).length }
}

/**
 * 改人格名。
 *
 * 一次动三处：`persona.json`（名字）、根标记 `yuanling.json`（清单里显示的名字）、
 * `SELF.md` 的一级标题（她自己读到的是那一行）。三处都进版本或变更记录。
 */
export function renameCard(root, pid, name, { expect } = {}) {
  const next = String(name ?? '').trim()
  if (!next) throw new Error('名字不能为空')
  if (next.length > CARD_NAME_MAX) throw new Error(`名字最多 ${CARD_NAME_MAX} 个字`)

  const marker = readMarker(root)
  if (!marker) throw new Error('根标记 yuanling.json 不存在或损坏')
  const entry = marker.personas.find((p) => p.id === pid)
  if (!entry) throw new Error(`人格「${pid}」不在注册表里`)

  const rel = personaPaths(pid).manifest
  const abs = absOf(root, rel)
  const manifest = readJson(abs, null) ?? { id: pid, name: pid }

  const changed = []

  if (manifest.name !== next) {
    // 用和建人格时同一套序列化参数，这样除了 name/updated_at，文件其余字节不变
    const text = JSON.stringify({ ...manifest, name: next, updated_at: localIso() }, null, 2) + '\n'
    const w = writeTracked(root, rel, text, {
      actor: 'human:editor',
      reason: `管理台改人格名：${manifest.name ?? pid} → ${next}`,
    })
    if (w.changed) changed.push(rel)
  }

  if (entry.name !== next) {
    entry.name = next
    writeMarker(root, marker)
    // 根标记是"共享骨架"的一部分，进根级版本库；snapshotCurrent 只记账、不重写盘
    try {
      snapshotCurrent(root, P.marker, { actor: 'human:editor', reason: `管理台改人格名：清单里的「${pid}」` })
    } catch {
      /* 记不上版本不该让改名失败 */
    }
    changed.push(P.marker)
  }

  // 一级标题跟着改（只改那一行，别的字节不动）
  const selfRel = personaPaths(pid).self
  const selfAbs = absOf(root, selfRel)
  const selfText = readTextOrNull(selfAbs)
  if (selfText !== null) {
    const r = replaceTitle(parseMd(selfText), next)
    if (r.ok && r.changed) {
      const w = writeTracked(root, selfRel, r.text, {
        actor: 'human:editor',
        reason: `管理台改人格名：标题同步为「${next}」`,
      })
      if (w.changed) changed.push(selfRel)
    }
  }

  // 骨架里的「名字：」那一行也要跟着改——她判断"是不是在叫我"读的就是这一行，
  // 只改标题不改这一行，改名之后她会认不出自己的新名字。
  // 注意：要**重新读一次**文件——上面刚改过标题，用旧文本覆盖会把标题改回去（踩过）
  const freshSelf = selfText === null ? null : readTextOrNull(selfAbs)
  if (freshSelf !== null) {
    const bullet = /^(\s*-\s*名字\s*[:：]\s*)(.*)$/m
    if (bullet.test(freshSelf)) {
      const nextText = freshSelf.replace(bullet, `$1${next}`)
      if (nextText !== freshSelf) {
        const w = writeTracked(root, selfRel, nextText, {
          actor: 'human:editor',
          reason: `管理台改人格名：骨架里的名字同步为「${next}」`,
        })
        if (w.changed) changed.push(selfRel)
      }
    }
  }

  return { id: pid, name: next, changed }
}

/**
 * 新建人格后把"卡上填的那几项"写进骨架。
 *
 * 只填空着的/模板里的段；调用方保证这是刚建出来的空白人格。
 * 空字段跳过——空字符串写进去会把模板的提示语顶掉，反而看不出还没填。
 */
export function seedCard(root, pid, { reason = '', tone = '', tic = '', avoid = '', values = [] } = {}) {
  const rel = personaPaths(pid).self
  const abs = absOf(root, rel)
  const before = readTextOrNull(abs)
  if (before === null) throw new Error(`骨架不存在：${rel}`)

  const keep = (s) => String(s ?? '').trim()
  const parsed = parseMd(before)
  const edits = []

  for (const s of parsed.sections) {
    const key = sectionKey(s.title)
    if (!key) continue

    if (key === '核心身份') {
      if (!keep(reason)) continue
      const lines = s.body.split('\n')
      const i = lines.findIndex((l) => /^\s*-\s*存在的原因\s*[:：]/.test(l))
      const line = `- 存在的原因：${keep(reason)}`
      if (i >= 0) lines[i] = line
      else lines.push(line)
      edits.push({ title: s.title, body: lines.join('\n') })
      continue
    }

    if (key === '说话方式') {
      const given = [
        ['语气', tone],
        ['口癖', tic],
        ['不做的表达', avoid],
      ].filter(([, v]) => keep(v))
      if (!given.length) continue
      const lines = s.body.split('\n')
      for (const [label, value] of given) {
        const i = lines.findIndex((l) => new RegExp(`^\\s*-\\s*${label}\\s*[:：]`).test(l))
        const line = `- ${label}：${keep(value)}`
        if (i >= 0) lines[i] = line
        else lines.push(line)
      }
      edits.push({ title: s.title, body: lines.filter((l) => l.trim()).join('\n') })
      continue
    }

    if (key === '价值观') {
      const list = (Array.isArray(values) ? values : []).map(keep).filter(Boolean)
      if (!list.length) continue
      edits.push({ title: s.title, body: list.map((v, i) => `${i + 1}. ${v}`).join('\n') })
    }
  }

  if (!edits.length) return { changed: false }

  const r = applySectionEdits(parsed, edits)
  if (!r.ok) throw new Error(r.error)
  const w = writeTracked(root, rel, r.text, {
    actor: 'human:editor',
    reason: '新建人格时填写人格卡',
  })
  return { changed: w.changed, path: rel }
}
