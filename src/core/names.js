// src/core/names.js —— 名字的唯一性与"撞名时加标识"。
//
// 用户定的（2026-11-11）：
//   · **名字永远唯一**——它是"直接定位一张卡"的唯一确定依据；
//   · **只有虚拟人格自动建卡时**才自动加标识（`(QQ) 张三`），因为那是她自己办事，不该卡住；
//   · **人建的/人改的**，撞名就失败并说清"重名了，请自己改成唯一的"——人不该被系统悄悄改名。
//
// 昵称不在这里：昵称可以重复、用自然语言写在描述里，由 aliases.js 从描述文本里认。

/** 平台 → 标识用的人话（短，能排序，一眼看出冲突源）。 */
export const PLATFORM_TAGS = {
  qq: 'QQ',
  wechat: '微信',
  weibo: '微博',
  bili: 'B站',
  xhs: '小红书',
  tieba: '贴吧',
  tg: 'TG',
  github: 'GitHub',
}

export function platformTag(platform) {
  const p = String(platform ?? '').trim().toLowerCase()
  if (!p) return '未知'
  return PLATFORM_TAGS[p] ?? p
}

/**
 * 自动生成一个**唯一**的名字。
 *
 * 顺序：原名 → `(平台) 原名` → `(平台 号) 原名` → `(平台 号-2) 原名` …
 * 最后那一步是兜底：同一个平台上两个同名的人（两个"张三"都只有 QQ），
 * 只加平台还是会撞，这时必须带上号才能唯一。
 *
 * @param {string} base 想要的原始名字
 * @param {{platform?:string|null, nativeId?:string|number|null, taken:(name:string)=>boolean}} opts
 */
export function autoUniqueName(base, { platform = null, nativeId = '', taken } = {}) {
  if (typeof taken !== 'function') throw new Error('autoUniqueName 需要一个 taken(name) 判断')
  const raw = String(base ?? '').trim()
  const plain = raw || `${platformTag(platform)}用户`
  if (!taken(plain)) return plain

  const tag = platformTag(platform)
  const withTag = `(${tag}) ${plain}`
  if (!taken(withTag)) return withTag

  const id = String(nativeId ?? '').trim()
  if (id) {
    const withId = `(${tag} ${id}) ${plain}`
    if (!taken(withId)) return withId
    for (let i = 2; i < 100; i += 1) {
      const candidate = `(${tag} ${id}-${i}) ${plain}`
      if (!taken(candidate)) return candidate
    }
  }
  for (let i = 2; i < 100; i += 1) {
    const candidate = `(${tag} ${i}) ${plain}`
    if (!taken(candidate)) return candidate
  }
  throw new Error(`取不出唯一的名字：${plain}（已经撞了上百次，先去看看是不是有脏数据）`)
}
