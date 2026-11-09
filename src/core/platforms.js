// src/core/platforms.js —— 频道种类与平台的对照表（纯常量，无依赖）。
//
// 为什么单独一个文件：`channels.js` 要用它，`groups.js` 也要用它。
// 放在任一边都会形成循环 import（channels → groups → entities → …），
// 所以纯常量归这里，两边都只读它。

/** 频道种类 → 平台。`group` / `private` 历史上只由 QQ 适配器用过。 */
export const CHANNEL_PLATFORM = {
  group: 'qq',
  private: 'qq',
  wechat: 'wechat',
  wx: 'wechat',
  tieba: 'tieba',
  bili: 'bili',
  discord: 'discord',
  telegram: 'tg',
  tg: 'tg',
}

/** 哪些频道种类算"一个地方"（群体）。私聊不算——人不是地方。 */
export const GROUP_KINDS = new Set(['group', 'tieba', 'wechat', 'wx', 'discord', 'telegram', 'tg'])
