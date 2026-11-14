// guard.js —— 测试 preset 的只读工具闸门。
//
// 测试对话必须“只读上下文、不写记忆”。核心不调用 ingest 只挡住后端写盘，
// 但模型仍可能主动调用 MCP 的记忆写工具；这个 preset 插件在 Agent scope
// 内直接 deny 掉这些工具，保证测试模式没有写入口。
export const name = 'yuanling-console-guard'
export const inject = ['tools']

const DENY = [
  'mcp__yuanling__yuanling_remember',
  'mcp__yuanling__yuanling_observe',
  'mcp__yuanling__yuanling_purpose',
  'mcp__yuanling__yuanling_drive',
  'mcp__yuanling__yuanling_style',
  'mcp__yuanling__yuanling_account',
  'mcp__yuanling__yuanling_person_merge',
  'mcp__yuanling__yuanling_person_split',
  'mcp__yuanling__yuanling_group',
  'mcp__yuanling__yuanling_fetch',
]

export function apply(ctx) {
  // 用 guard 而不是 restrict：MCP 工具在 preset apply 时可能还没注册，
  // restrict 会因“未知工具名”直接报错；guard 在每次调用时按名字拦截，
  // 工具后来才出现也能挡住。
  ctx.tools.guard((call) => {
    const name = String(call?.name ?? call?.tool ?? '')
    return DENY.includes(name) ? '测试模式禁止写入记忆/人物/群体' : undefined
  })
}
