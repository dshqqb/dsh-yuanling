// src/core/templates.js —— init 时写进数据目录的模板内容。
// 纪律：示例只用占位符（<用户> / 示例人物），绝不放真实姓名。
// 这些模板会随插件分发，所以它们本身必须是"干净的"。

export const FORMAT = 1
export const SCHEMA_VERSION = 1

export function markerJson({ active, now, rootId }) {
  return {
    format: FORMAT,
    root_id: rootId,
    created_at: now,
    active,
    personas: [{ id: active, name: '原灵', created_at: now }],
    _comment: '本文件是数据目录的根标记。删掉它 yuanling 会拒绝启动（避免误把别的目录当数据目录）。',
  }
}

export function guardrailsJson() {
  return {
    _comment:
      '插件级硬线：任何人格、任何规则都不能越过这里。改这里等于改底线，请谨慎。',
    version: 1,
    // 这些内容永远不进 raw（连计数都不留）。给"绝对不想让它存在"的东西。
    never_record: [],
    // 这些内容永远不进任何注入（但可以留在 raw 里）。
    never_inject: [],
    // 永不执行的动作。
    never_do: ['修改自身规则', '读写数据目录以外的文件', '自主付费'],
  }
}

export function ingestJson() {
  return {
    _comment:
      '全局入库规则。因为 raw 是所有人格共用的，"记不记"只能有一个答案，所以这一维放在全局。',
    version: 1,
    soft_blacklist: [],
    hard_redact: [],
    skip_channels: [],
  }
}

export function firstDoc() {
  return `# 第一条

装好了，但这里还是空的——这是故意的。它记你的事，不是模板。

## 三步起第一条

1. 打开 \`记忆库\` 目录下的 \`people/\` 或 \`spaces/日常/词条/\`，新建一个 \`.md\`。
2. 照下面的格式写一条真事：

\`\`\`markdown
## 事实

- [称呼] 叫我「<称呼>」 @since 2026-11 @src raw/2026-11/05/dsh.ndjson#<id>
\`\`\`

3. 或者直接跟她说一句「记一下：……」，她照格式起一条，你看一眼改。

## 三条规矩

- **没有 \`@src\` 的记忆不写**：指不回原始记录的，是断言，不是记忆。
- **旧的不删，只标 \`@until\`**：想不起"以前是什么样"，比想不起现在更麻烦。
- **人设的骨架只能人改**：她可以长大，但不能变成另一个人。

## 常用命令

\`\`\`powershell
yuanling status          # 看数据目录、端口、当前人格
yuanling doctor          # 体检
yuanling persona list    # 有哪些人格
\`\`\`
`
}

export function dataGitignore() {
  return `# 这是【数据目录】自带的 .gitignore。
#
# 它存在的唯一目的：万一有人把数据目录误放进代码仓库，也不会泄漏。
# 所以默认全忽略，只放行 README。
#
# 如果你的确想版本化自己的记忆（例如只备份人设），
# 请复制这个目录到别处操作，不要在这里放行。

*
!.gitignore
!README.md
`
}

export function dataReadme() {
  return `# 原灵数据目录

这个目录是你的，不属于代码仓库。

- 想备份：整个目录拷走即可。
- 想迁移：关掉 DSH → 拷目录 → 改 \`dataDir\` → \`yuanling verify --root <新路径>\`。
- 想分享：**不要直接打包**，用 \`yuanling export --sanitize <目录>\`，它会剔除身份映射、屏蔽项与凭据引用。

本目录自带 \`.gitignore\`，默认拒绝一切版本控制。这是有意的。
`
}

export function selfMd(name = '原灵') {
  return `# ${name} · 骨架

> 这一页是「我是谁」。**只有人能动它。**
> 她可以长大一点，但不能变成另一个人——这条是保险丝。

## 核心身份

- 名字：${name}
- 存在的原因：<一句话，别写套话>
- 与用户的关系：<怎么称呼、什么位置>

## 说话方式

- 语气：<例：短句、少用感叹号、不用颜文字>
- 口癖：<例：偶尔说"嗯"、"行"、不说"当然可以">
- 不做的表达：<例：不卖萌、不堆排比、不说"作为一个 AI">

## 价值观（按优先级）

1. <最重要的一条>
2. <其次>
3. <再次>

## 演化区

> 这一段可以由阈值内的自动演化改写（周 ≤1 次，7 天回滚窗）。
> 上面三段不会。

- 最近在意的事：<留空，让她自己长>
`
}

export function linesMd() {
  return `# 硬线

> 这些是"绝对不做"。任何规则都不能越过，任何演化都不能改写。

- 不伪造记忆：没有原始记录的事，不说"我记得"。
- 不冒充他人：不用别人的口吻说话。
- 不泄露凭据：看到密钥、口令、证件号，一律不进记忆。
- 不越过规则破例：需要破例时，明确说出来，而不是悄悄做。
`
}

export function userMd() {
  return `# 用户画像

> 每轮注入，整体预算 8 KB（含记忆与人物段）。写"稳定成立"的事，不写今天吃了什么。

- 称呼：<TA 希望你叫什么>
- 作息：<例：凌晨活跃，早上不回消息>
- 在意的事：<例：备份、写小说、猫>
- 不喜欢：<例：被追问私事、被说教>
- 健康/禁忌：<如果 TA 说过，写在这里>
`
}

export function coreJson() {
  return {
    _comment: '全局基本记忆：400 字预算，每轮注入，只放"任何时候都成立"的底线。',
    budget_chars: 400,
    facts: [],
  }
}

export function personaJson({ id, name, now }) {
  return {
    id,
    name,
    created_at: now,
    updated_at: now,
    budget: { SELF: 12000, lines: 400, user: 800, core: 400 },
    version: {},
  }
}

export function styleMd() {
  return `# 表达层

> 这一段可以在阈值内自动演化（周 ≤1 次），但改了什么会记进 \`changes.ndjson\`，7 天内可回滚。

- 句长：<short / medium / long>
- 语气词：<有 / 无>
- 用不用表情：<不用 / 偶尔 / 常用>
`
}

export function globalRuleJson() {
  return {
    _comment: '人格级全局规则。ingest 维度不在这里（它必须是全局的，见根级 rules/ingest.json）。',
    schema: 1,
    recall: { max_inject: 800, hidden_kinds: [], min_importance: 0 },
    action: {
      proactive: 'on',
      quiet_hours: ['01:00-08:00'],
      max_per_hour: 3,
      max_per_day: 20,
      per_target: true,
      group_proactive: false,
    },
    persona: { evolve: true, auto_adopt: true, daily_auto_limit: 1, auto_approve_days: 3, rollback_days: 7 },
    deny: [],
    allow: [],
  }
}

export function emptyJson(shape) {
  return shape
}
