// src/core/extract.js —— 从消息里提炼"事实"（规则表，不调模型）。
//
// 为什么是规则而不是让模型提炼：README 的硬约定是"核心不调用模型、零 API 调用"。
// 规则提炼的代价是覆盖率有限，收益是**每条事实都能翻回原话**，而且便宜到可以每条消息都跑。
//
// 纪律：
//   · 只提炼"跟她有关"的消息（私聊全部；群里靠 engage.js 判定），过滤在调用方做；
//   · 单条消息最多提炼 3 条事实，避免一段话炸出十条；
//   · 句子原样存（截断到 120 字），topic 用类别名——人能一眼看懂"她为什么记这句"。
//
// 表是数据，不是逻辑：想多认几种说法，往 RULES 里加一行就行。

export const EXTRACT_MAX_PER_MESSAGE = 3
export const EXTRACT_MAX_CHARS = 120
/** 提炼出来的事实：重要度先给低一点，让人能靠"重要度"把它们和手动写的区分开。 */
export const EXTRACT_IMPORTANCE = 30

/**
 * 句式表。每条：
 *   · re      命中即算（对整句文本跑）
 *   · topic   归到哪个主题（也是记忆页里显示的分类）
 *   · kind    事实类型（都标 extracted，方便筛）
 */
export const RULES = [
  { topic: '喜好', re: /我(?:很|挺|最|特别|尤其)?(?:喜欢|爱|讨厌|不喜欢|受不了|爱吃|爱看|爱玩)[^，。！？!?\n]{1,20}/ },
  { topic: '身份', re: /我叫[^\s，。！？!?\n]{1,20}/ },
  { topic: '身份', re: /我(?:是|住在|在)[^，。！？!?\n]{1,24}/ },
  { topic: '打算', re: /我(?:要|准备|打算|计划)[^，。！？!?\n]{1,24}/ },
  { topic: '打算', re: /(?:明天|后天|下周|下个月|最近)[^，。！？!?\n]{0,20}(?:去|要|准备|打算)[^，。！？!?\n]{0,20}/ },
  { topic: '关系', re: /我(?:老婆|老公|妈|爸|妈妈|爸爸|儿子|女儿|同事|老板|朋友|室友)[^，。！？!?\n]{0,20}/ },
  { topic: '情绪', re: /我[^，。！？!?\n]{0,4}(?:很|特别|有点|太|真的)(?:累|难过|开心|烦|压力(?:很)?大|焦虑|失望|兴奋|委屈|生气)/ },
  { topic: '情绪', re: /我(?:累|难过|开心|烦|焦虑|失望|委屈|生气)(?:了|死了|坏了)/ },
  { topic: '叮嘱', re: /(?:记得|帮我记一下|帮我记住|别忘(?:了)?)[^。！？!?\n]{1,30}/ },
]

function clean(s) {
  return String(s ?? '')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[，,、；;：:]+$/, '')
    .slice(0, EXTRACT_MAX_CHARS)
}

/**
 * 提炼一条消息里的事实。
 * @param {string} text
 * @returns {Array<{topic:string, text:string}>} 最多 EXTRACT_MAX_PER_MESSAGE 条，去重
 */
export function extractFacts(text) {
  const src = String(text ?? '')
  if (!src.trim()) return []
  const out = []
  const seen = new Set()

  for (const rule of RULES) {
    const m = rule.re.exec(src)
    if (!m) continue
    const fact = clean(m[0])
    if (!fact || fact.length < 3) continue
    const key = `${rule.topic}|${fact}`
    if (seen.has(key)) continue
    seen.add(key)
    out.push({ topic: rule.topic, text: fact })
    if (out.length >= EXTRACT_MAX_PER_MESSAGE * 2) break
  }

  // 同一句里被两条规则分别认出（"明天我要去面试" → "我要去面试" + "明天我要去面试"）：
  // 短的那条是长的那条的子串，留长的就够了，别让一句话变成两条事实。
  const pruned = out.filter((a, i) => !out.some((b, j) => i !== j && b.topic === a.topic && b.text.includes(a.text)))
  return pruned.slice(0, EXTRACT_MAX_PER_MESSAGE)
}

/**
 * 这条记录值不值得提炼。
 * 她自己的话不是"事实"（那是她的表达），所以 role=bot 一律跳过。
 */
export function shouldExtract(record) {
  if (!record) return false
  if (String(record.role ?? 'user') === 'bot') return false
  if (!String(record.text ?? '').trim()) return false
  return true
}
