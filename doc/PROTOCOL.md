# PROTOCOL · 原灵模块协议（v1.5）

> 状态：**v1.5 已实现**。v1.0 于 2026-11-08 冻结，七条 spike 全过。
> v1.5：⑧ `outbox` 能力 + `outbox.fetch` / `outbox.ack`——把她主动想说的话交给模块，并听它回报结果（见 §5.1.3）。
> v1.1：① `sources` 声明、`provide.source` 能力、安装即空授权；② `source.fetch` 与模型工具 `yuanling_sources` / `yuanling_fetch`。
> v1.2：③ manifest 增 `ui.tabs`，新增只读 op `ui.get`——模块能给管理台加标签页，但**只能给数据，不能给标记**（见 §3.5 / §5.2.3）。
> 谱系：glm v0.1 → ds v0.2 → glm v0.3 → ds v0.3-ds → **本文（合并定稿）**。三方评审的全部结论已并入正文，修订史见文末附录；`PROTOCOL_glm.md`、`PROTOCOL_ds.md`、`PROTOCOL_ds_0.3.md` 为历史评审稿，已归档。
> spike 逼出来的东西优先于本文任何一段推演。
>
> 冻结的含义：**改这段协议要升次版本**（`api` 的 minor 加一），并且核心要同时接受新旧两个 minor。加字段可以，改语义不行。
>
> 本文遵守项目一贯立场：**能不建的机制就不建；建了的必须能解释。** 每个字段都要能回答"删掉它会坏什么"。

---

## §0 三句话总则

1. 模块不 import 核心代码，只通过协议说话；**协议是唯一的接触面**。
2. 核心是唯一的写者：raw、记忆、媒体、日志，全部只有核心进程落盘。
3. 协议面前人人平等：`qq`、`bili` 与第三方模块走**完全相同**的路径，核心不认亲儿子。

### 0.1 原始层语义（其余所有约定都建立在它上面）

**raw 只保证一件事：记下来的，跟你收到的，一致且没丢。**

1. **不做真伪判断。** 群友说"我昨天去了北京"就是一条记录，不是一条待核实的论断。谎言也是交流的一部分；将来她判断这句话可不可信，靠的是上下文与人，不是原始层盖的章。
2. **不做可信度分级。** 对原灵来说，**所有**原始层数据都是外部来的——QQ 是外部，B 站是外部，按需抓回来的网页也是外部。给某几类盖"外部数据"等于给整个记忆库降级。
3. **只对保真负责**：单行超长截断要留痕（`flags: ["truncated"]`）、脱敏要留痕、去重不改内容——凡是"我改过它"的地方，都必须能在记录本身看出来。
4. **不丢**：写失败就是失败，不静默跳过；被规则挡下的条数进 `system/inbox/.skipped.ndjson` 计数（只记数、不记内容）。

由此推出两条实现约束：

- 提炼层（`propose.fact` / 候选事实）**只记"谁在什么时候说的"**，不写"已证实/存疑"这类判决。真假判断留给读到注入的模型。
- 任何新的数据入口（模块 `ingest`、v1.1 的 `source.fetch` 回填）都必须复用同一条落盘路径，不经捷径写 raw——否则上面四条会在某个入口失效，而且没人知道是哪个。

## §1 四条硬边界

| # | 边界 | 执行点 |
|---|---|---|
| 1 | 不能直接读 `raw/`，只能 `ingest()` | 落盘、脱敏、分片全在核心；**`source` 由核心按连接身份盖章，模块自报无效** |
| 2 | 不能直接写记忆，只能 `propose.fact`（需 capability `propose.fact`） | 走查重 / 槽位 / 重要度全流程，事实带 `origin_module` |
| 3 | 不能决定媒体存哪，只能 `media.put.file`，拿回内容寻址指针 | 路径由核心分配，模块只拿指针 |
| 4 | **不能自己决定发什么**：发送由核心发起，模块只投递 | 核心在 `send` 之前跑 `rules/action` 与 `guardrails.never_do`；被拒只记 refusal，**内容不透传给模块** |

> 第 4 条是 `guardrails.never_do` 的**唯一执行点**。没有它，那条规则只是文档里的装饰。

## §2 模块生命周期

> **代码放哪（已定，2026-11-08）**：模块装在**数据目录内**——`<数据目录>/system/modules/<id>/`。
> 理由：① 备份/迁移是一件事（备份数据目录 = 连模块一起备份）；② 实例隔离天然成立（多个 profile / 多个数据目录各装各的）；
> ③ 切源换版本才成立（在同一位置换一份代码）；④ 与 §16 注册表"repo/installedRef 是唯一权威"自洽。
> 代价要说清：数据目录里开始混有可执行代码。缓解：模块只跑在独立子进程、不 import 进宿主；安装必须过校验与能力授予。

### 2.1 安装

**装的是发行包，不是仓库。**（2026-11-08 修订，原 `git clone` 方案作废）

```
输入：库的网址（Gitee / GitHub） | release 里的 .tgz 直链 | 本地 .tgz 路径
  → 若给的是**库的网址**：查它的发行版（Gitee `api/v5` / GitHub `api.github.com`），
    取最新非预发布那条，从 assets 里挑 `.tgz` 附件（**源码 .zip/.tar.gz 一律不认**）
  → 下载字节（只允许 https；http 仅限 127.0.0.1 / localhost）
  → 校验 sha256（若给了期望值）
  → 解包到内存，按 §4.1 的清单检查：拒绝对路径、`..`、符号链接/设备文件
  → 读 yuanling.module.json，跑 §3.3 校验
  → 检查 routes 与已装模块无重叠
  → 先写 <id>.installing-<rand>/，再把旧目录改名备份、整体替换
  → 写 VERSION（version/api/sha256/source/repo/ref/at）
  → 写 system/modules.json（granted 为空）
  → 把 manifest 声明的全部能力列一次，问一次"是否全部授予"
```

**"给个库网址就能装"是 2026-11-08 加的**（管理台 + CLI 同一套解析，实现见 `installer.js` 的 `resolveInstallUrl`）。

理由：模块的常识是"从某个仓库发出来的"，要人自己拼 `https://gitee.com/x/y/releases/download/v1/y-1.0.0.tgz` 等于让他先学会 release 的目录规则。代价是核心多了一次外部 API 调用，所以：

- 解析只发生在**库网址**这一种输入上；`.tgz` 直链直接用，不多打一次请求；
- 发行版只能提供**包**，不能提供"指令"：资产名必须是 `.tgz`，而且解包后仍要过 §3.3 的 manifest 校验；
- 拿不到资产时报的是**下一步怎么做**（"去建一个发行版，把 pack.mjs 打出来的 tgz 传上去"），不是"安装失败"。

**默认不授予（v1.1 改定）**：装完 `granted: []`，模块是"装着但不干活"。

为什么改：v1.0 实现里是"装完即授予声明的一切"，而文档写的是"`send` 由人点"——两边打架，实际生效的是代码那边，等于任何第三方包装上就能用你的名义说话。

确认的粒度是**一次决定，不是逐条勾选**：把全部能力连同中文说明列清，人回答 Y / n。逐条勾选只会让人闭眼按回车，反而更不安全。答 n 也不拦安装——装上空转，随时能补授（`yuanling module grant-all <id> --yes` 或管理台的「全部授予」）。非交互环境（管道、CI）默认按 n 处理，要放行必须显式 `--grant`。

为什么不用 `git clone`：

1. **不依赖 git**——很多用户机器上没有；
2. **不执行构建脚本**——clone 之后总要 `npm install`，那等于让远程仓库在你机器上跑代码（§2.5 正警惕这个）；发行包可以要求"零依赖、无 postinstall"；
3. **可回滚**——出问题是"换回上一个 tgz"，而 `pull` 回来的是"某个 commit"，退不回去。

安全底线：

- 安装/更新记录**精确版本与 sha256**，**永不跟踪 HEAD 自动更新**。
- 解包出来的内容一律视为不可信数据：不执行安装脚本（我们根本不跑 npm）、不信任其中任何路径。
- 同 `id` 已安装时，安装 = 升级，走 §2.2。

### 2.1.1 整体导出

`yuanling module export <id>` → `<数据目录>/system/exports/<id>-<version>.tgz`。

换机器/备份时拷一个文件比拷一棵目录树可靠；导出包能被 `installFromBytes` 直接装回来（往返 sha256 一致，有测试钉住）。

### 2.2 更新

以下任一变化 → **回到人工确认**，等价于重新安装：

`kind` / `permissions` / `capabilities` / `routes` / `sources` / `media.send` / `media.receive` / `entry.command` / `entry.env` / `entry.os` / `entry.install` / `config.schema`

其余字段（description、name）变化静默通过。注册表记 `installedRef` 与 `version`；旧版本目录保留，回滚 = 把注册表指回去。核心**永不**因模块崩溃而自动更新。

**`ui` 也静默通过**（v1.2）：标签页的名称、顺序、增删都属于"展示"，不该让用户为改个名字重新走一遍安装确认。代价是它不能承载任何能力语义——`ui.tabs` 里只能声明渲染形态，做不了别的事（§3.5）。

更新时的授权：**取交集**（新 manifest 里已不声明的能力自动失效），**不自动扩权**——新增的能力仍需人再点一次。

### 2.3 切换模块网址

- **视同全新安装**，权限重新过目。
- 同 `id` 换 URL 是最高危操作，确认页必须并排显示"旧仓库 → 新仓库"与两份 manifest 的 diff。
- 注册表记 `previousRepo`，原版本目录不删。

### 2.4 停用 / 卸载

- 停用：不 spawn，目录与配置保留。
- 卸载：目录移入 `system/trash/`（可恢复），注册表除名，记 changes。
- **raw 与日志永不删**——那是核心的账本，不是模块的。

### 2.5 安装期代码执行

`entry.install` 与模块自带的 `package.json` 脚本**都是任意代码执行**，且发生在运行之前。规定：

- 默认 `["npm","ci","--ignore-scripts"]`；需要脚本的模块必须声明 `permissions: ["install.scripts"]`，确认页单独一行红字。
- 强烈建议提交 lockfile；有 lockfile 时记其 sha256 进注册表。
- 安装命令在模块版本目录内执行，stdout/stderr 全收进 `system/log/modules/<id>.ndjson`，超时 10 分钟中止。

### 2.6 单例约束

**一个 `id` 同时只允许一个进程。** 多账号 = 装多个模块（id 不同），不是同一个模块起多份。将来若需要实例化，升次版本引入 `instances`，不在 v1 偷跑。

## §3 `yuanling.module.json`

```jsonc
{
  "id": "qq",                              // 必填，^[a-z][a-z0-9-]{1,31}$，保留字见 §3.2
  "version": "1.2.0",                      // 必填，semver；更新比对用
  "api": "1.0",                            // 主.次；主版本不符 → 拒装；次版本高于核心 → 拒装
  "minCore": "0.1.0",                      // 可选，模块要求的最低核心版本
  "kind": "gateway",                       // gateway | enricher | actuator（v1 无 ui）
  "transport": "stdio",                    // v1 只实现 stdio；http 见 §14
  "entry": {
    "command": ["node", "dist/main.js"],   // argv 数组；.cmd/.bat 必须写成 ["cmd","/c","x.cmd"]
    "cwd": ".",                            // 相对模块版本目录
    "env": {},                             // 追加环境变量；YUANLING_* 不可覆盖，见 §15
    "os": ["win32", "linux"],              // 可选，process.platform 白名单
    "install": ["npm", "ci", "--ignore-scripts"]  // 可选，仅安装期执行一次
  },
  "capabilities": ["ingest.message", "egress.text", "egress.media", "media.read"],
  "permissions": ["net.out"],
  "config": {
    "schema": {
      "type": "object",
      "properties": {
        "wsUrl": { "type": "string", "description": "NapCat WebSocket 地址" },
        "selfId": { "type": "number" }
      },
      "required": ["wsUrl", "selfId"]
    }
  },
  "media": { "send": ["text", "image", "audio"], "receive": ["image", "audio"] },
  "routes": ["private:*", "group:*"],      // 认领的频道前缀；语法见 §7
  "name": "QQ 网关",
  "description": "OneBot v11 网关",
  "author": "yuanling contributors",
  "license": "MIT",
  "homepage": "https://github.com/dshqqb/dsh-yuanling-qq"
}
```

actuator 模块示例（capabilities 用 `actuate.<kind>` 声明产出能力，见 §5.3）：

```jsonc
{ "id": "tts", "kind": "actuator", "capabilities": ["actuate.speech"], "routes": [] }
```

v1.1 新增：`sources`——声明"我这儿有什么数据可以被要"（需 `api: "1.1"` 且声明 `provide.source`）。

```jsonc
"sources": [
  {
    "id": "bili.search_video",   // 必须 "<模块id>.<名字>"；模型只看到这个 id，靠前缀追得回来源
    "title": "按关键词搜 B 站视频",   // 必填，给模型看的一句话
    "params": {                   // 可选；只允许 string / number / boolean + required
      "type": "object",
      "properties": { "q": { "type": "string", "description": "关键词" } },
      "required": ["q"]
    }
  }
]
```

`sources` 是**声明**不是目录：核心不猜它能干什么，模型也不知道它的存在，除非有人调 `source.fetch`。不声明 `sources` 的模块（绝大多数）完全不受 v1.1 影响。

### 3.1 config：配置归核心

- 模块只声明 schema（JSON Schema 子集：`type / properties / required / enum / default / description`）。
- 实际值存 `system/modules/<id>/config.json`，由管理台按 schema 渲染——**是表单，不是一段 JSON**（v1.1 落地）。
- 模块通过 `config.get` 取值，**不自己读文件**；cookie / token 一类只存在核心侧。
- `config.schema` 是版本 diff 的一部分：新增必填项 → 更新时要求人补。
- **配置变更的生效方式只有一种**：核心发 `shutdown`，再按新配置重新 spawn + `init`。模块永不热更新。
- **核心在写盘前按 schema 校验**（v1.1 落地，`modules/configschema.js`）：
  - 必填项缺失/空白 → 拒绝，并指出是哪个字段；
  - 类型可转换（`"123"` → `123`、`"true"` → `true`），转不了就报错，**不静默变 NaN**；
  - `enum` 之外的值拒绝；
  - 未在 `properties` 里声明的键**丢弃并如实报告**（否则用户会以为存上了）；
  - 子集外的关键字（`pattern`、`oneOf`…）**忽略并标出来**，不假装支持。
- 设置密码类字段（`sessdata` / `token` / `cookie`…）时页面用密码框；schema 里可用 `"x-secret": true` 显式声明。
- 保存成功 → 核心**重启该模块**（停用状态的不重启，等启用时再读）。启动失败不算保存失败：配置已经落盘，失败只在响应里多一个 `runtime.error`。

### 3.2 id 保留字

`system`、`dsh`、`console`、`web`、`raw`、`media`、`personas`、`rules`、`test`、`dev`、`null`。

原因：模块 id 会成为 raw 记录的来源名——raw 按 `raw/<月>/<日>/<source>.ndjson` 分文件（`src/core/raw.js:28`），`source: "system"` 已被核心系统事件占用（如封存记录），撞名会污染原始层与健康心跳。两个已安装模块同 id → 拒绝。

### 3.3 校验规则

1. JSON 可解析，必填齐全，类型正确；
2. `id` 格式合法且不在保留字表；
3. `version` / `minCore` 是合法 semver；
4. `api` 主版本 == 核心支持的，次版本 ≤ 核心实现的；
5. `entry.command` 非空数组，首元素不含路径分隔符；
6. `capabilities` / `permissions` 无未知值——合法值集合是**封闭的**，就是 §5.3 与 §12 那两张表（含 `actuate.<kind>` 模式），一处不多一处不少；
7. `media.send/receive` 的 mime 在白名单内；
8. `routes` 与已安装模块无重叠；`actuate.<kind>` 同 kind 与已安装模块无重叠（重叠 → 拒装并提示冲突模块）；
9. `sources`（v1.1）：数组；每项 `id` 形如 `<模块id>.<名字>` 且不重复、`title` 非空；`params` 只允许 `type: "object"` + `properties` 里的 `string/number/boolean` + `required` 必须是已声明的键；**声明了 `sources` 就必须写 `api` ≥ `1.1`**。

### 3.4 kind 的 v1 语义

| kind | 含义 | v1 |
|---|---|---|
| `gateway` | 收消息 → `ingest`；接收 `send` | ✅ 实现 |
| `actuator` | 由核心触发产出媒体（TTS / 绘图 / 视频） | ⬜ **接口写死，调用返回 `E_UNSUPPORTED`**（§5.2.1） |
| `enricher` | 加工管道（转写 / 翻译 / 摘要） | ⬜ 只保留类型名，顺序语义未定 |
| `ui` | 管理台扩展 UI | ❌ 删除。UI 走 v1.2 的 `ui.tabs`——**模块出 JSON，核心渲染**（§3.5） |

`presence` capability 一并删除——语义没想清楚的能力不该存在。

### 3.5 `ui`：模块能给管理台加只读标签页（v1.2）

```jsonc
"api": "1.2",
"ui": {
  "tabs": [
    { "id": "stats", "label": "统计", "kind": "kv"   },   // 键值对
    { "id": "queue", "label": "待办", "kind": "list" },   // 列表
    { "id": "notes", "label": "说明", "kind": "text" }    // 一段文字
  ]
}
```

**核心只认三种 `kind`**（封闭词表，v1.3 起加 `config`）：`kv` / `list` / `text` / `config`。模块**给不出** HTML、JS、CSS、样式或布局——它只能表达"给我画一个键值对/列表/一段文字/我的配置表单"，画法由核心定。

为什么这么死：管理台握着 `console.token`，能读全部记忆、改规则、卸模块。模块一旦能在页面里执行脚本，等于拿到整个记忆库的钥匙。这条线不值得为了"界面灵活"让路。

约束：

| 项 | 规则 |
|---|---|
| `id` | `^[a-z][a-z0-9-]{1,23}$`，不可重复，**不能是 `brief` / `log`**（核心保留） |
| `label` | 必填，≤16 字，不能叫「概况」「日志」 |
| `kind` | `kv` / `list` / `text` / `config` / `records`，缺省 `text` |
| `fields` | 仅 `config` 型可用：认领 `config.schema` 里的哪些字段（不写＝没被别的 tab 认领的全部）。同一份配置不该有两个编辑入口 |
| `records` | 仅 `records` 型必填：`{ type, limit? }`。声明"看我自己产生的哪类记录"，核心查 raw 渲染 |
| 数量 | 最多 **5 个** |
| 位置 | 固定排在「概况」「日志」之后 |

**`ui` 不进 §2.2 的 diff 清单**：调整一个 tab 的名字，不该让人重新确认一次安装。正因为它"改了不提示"，校验才卡得这么紧（kind 封闭、不许占核心 tab、不许内嵌标记）。

`ui` 需要 `api ≥ "1.2"`，与 `sources` 需要 `1.1` 同理——旧核心装上去只会得到一个永远不会来的 `ui.get`。

#### `kind: "config"`：把一组配置单独开一页（v1.3）

模块想让「规则」「连接」「通知」这类设置单独占一页时，声明一个 config 型 tab 即可：

```jsonc
"ui": { "tabs": [{ "id": "rules", "label": "规则", "kind": "config", "fields": ["rule1", "rule2"] }] }
```

- 内容是**核心按 `config.schema` 渲染的表单**，不是模块给的数据——所以 `ui.get` 不会发给模块；
- 因此它在**模块停用时照样能看**（记录和配置都在核心这边）；
- 被认领的字段不会在「概况」里重复出现。

**控件**由 `config.schema` 的 `x-widget` 决定（不写就按类型推断）：`switch` / `checkbox` / `radio` / `select` / `slider` / `input` / `textarea` / `list`。
其中 `action`（按钮）与 `file`（浏览文件）是**占位控件**：只画、不校验、不落盘——它们要等 `ui.action` 协议与核心侧文件选择器，现在故意不让模块借它们做动作。

#### `kind: "records"`：把"我自己产生的记录"摆出来（v1.3）

```jsonc
"ui": { "tabs": [{ "id": "likes", "label": "点赞记录", "kind": "records",
                    "records": { "type": "like", "limit": 50 } }] }
```

这一型**模块不回任何数据**——它只声明"我要看我自己产生的 `like` 类记录"，**核心查自己的原始层并渲染**。

为什么必须这样：点赞记录本来就在 `raw/` 里（模块点赞时通过 `ingest` 报给核心）。如果让模块再通过 `ui.get` 读出来返回，等于让模块读原始层——那违反第一硬边界。方向反过来之后：

1. **零数据流过来**，不存在越权读 raw；
2. **核心强制按 `source = <声明它的模块 id>` 过滤**——模块借这个页看不到别人的记录；
3. **模块停着也能看**：记录已经在 raw 里，不依赖进程活着。

`type` 是记录类型（小写、点/下划线/连字符，如 `like` / `comment.reply`），必须精确匹配，**不支持通配**；`limit` 1~200，默认 50；扫描上限 30 天 / 32MB，超了标 `partial`。

## §4 传输与帧

### 4.1 帧

- stdio 上跑 **NDJSON**：一行一条，UTF-8 无 BOM，行尾 `\n`。
- **单帧上限 256KB**。超限 = `E_PROTO`，断开并按崩溃处理。
- **大对象不进帧**：媒体走 §13 的文件交接。

### 4.2 信封

```jsonc
{ "op": "ingest", "id": "01JCV…", "data": { … } }                                  // 请求
{ "id": "01JCV…", "ok": true,  "result": { … } }                                    // 成功
{ "id": "01JCV…", "ok": false, "error": { "code": "E_RATE", "message": "…", "retry": true } }  // 失败
{ "op": "log", "data": { … } }                                                      // 通知：无 id、无响应
```

- `id` 由发起方生成（ULID），响应必须回带同一个 `id`。
- 不用 JSON-RPC 2.0：`params/result/error` 的嵌套没有增量收益。
- **凡是需要判断"对方回没回"的，必须是请求**（带 id）；通知只用于不需要应答的单向上报。
- **失败帧必须是嵌套的** `error: {code, message, retry}`，`code` / `message` **不要摊在顶层**。摊在顶层的话，核心读不到真实错误码，会一律记成 `E_MODULE` + "模块返回失败"——单测里消息清楚，一过核心就只剩一句废话（v1.4 前 bili 模块就踩了这个）。核心现在是**照收但记警告**：不合协议也能跑，但日志里会明确指出你不合 §4.2。

### 4.3 并发与超时

- 双方都可同时有多个在途请求，**响应允许乱序**，靠 `id` 关联。
- `ingest` **不保证按投递顺序落盘**；需要顺序的模块自己串行。
- 超时**按 op 定**，不是全局一刀切：

| op | 超时 | 理由 |
|---|---|---|
| 默认（`ping` / `config.get` / `log` 等） | 10s | — |
| `init`（等 `ready`） | 30s | 冷启动含依赖初始化 |
| `ingest` / `media.put.file` / `media.get` / `propose.fact` | 10s | 核心侧是本地写 |
| `send` | 30s | 平台 API 慢是常态；按 10s 误判 undelivered 会真丢回复 |
| `ui.get`（v1.2） | 15s | 允许模块现查一次自己的状态；比默认 10s 宽一点，又不至于卡住页面 |
| `source.fetch`（v1.1） | 30s | 模块这一侧会去联网（B 站 / 网页），按 send 那一档，不能套 10s 默认 |
| `actuate` | 300s | 语音/视频生成轻松超过 10s，一刀切会杀掉正常生成 |
| `shutdown` | `deadline_ms` 自带 | 核心关停前预告 |

- 超时 = 该请求作废（迟到响应按孤儿丢弃并记日志），不算死亡；**同一模块连续 3 次超时**按崩溃处理。

## §5 方法表

### 5.1 模块 → 核心

| op | 入参 | 出参 | 说明 |
|---|---|---|---|
| `ingest` | 复用 inbox 信封 `{v, source, acct, items[]}` | `{accepted, deduped, skipped, errors[]}` | 需 `ingest.message`；**`source` 以核心盖章为准**；单批 `items ≤ 100`；返回值即重试依据 |
| `propose.fact` | `{topic, text, src, imp?}` | `{status: accepted\|deduped\|rejected, factId?}` | 需 `propose.fact`；`src` 必须可解析（先 `ingest` 再 `propose`）；落库带 `origin_module` |
| `media.put.file` | `{path, mime, size?}` | `{ptr, hash, size, mime}` | 路径须在 `$YUANLING_TMP/` 内；≤20MB；mime 需在 `media.receive` ∩ 白名单；默认 20 次/分钟 |
| `media.get` | `{ptr}` | `{path, mime, size, expires_at}` | 需 `media.read`；**不回字节**，返回临时文件路径；每次读取记模块日志 |
| `config.get` | `{}` | `{ … }` | 模块不读配置文件 |
| `log` | `{level, event, data}` | — | 核心代写；`data` 过 ingest 同款脱敏；**上限 4KB**，超限截断并打标记 |
| `diag.report` | `{items:[{code, level, hint, detail?}]}` | `{accepted, truncated}` | **v1.4**：让核心的「诊断」页带上模块的专业判断。见 §5.1.2 |
| `outbox.fetch` | `{limit?}` | `{version:1, items:[{id, channel, target, text, need, why, created}]}` | **v1.5**：取"她主动想说的话"。需 `outbox`；取出即 `claimed`；见 §5.1.3 |
| `outbox.ack` | `{id, ok, code?, message?}` | `{id, status:'sent'\|'pending'\|'dropped'}` | **v1.5**：回报说没说出来。`ok:false` 会重试，连续失败到上限自动放弃 |

#### 5.1.3 `outbox.*`：把她"主动想说的话"交给模块（v1.5）

§1 第 4 条说"发送由核心发起"。主动开口仍然遵守它：**内容与对象都由核心算**（动机 + 目的 + 规则闸门），
模块只是来取走并投递。取用与投递分开，是因为**说没说出去只有模块知道**——核心不能假设。

```jsonc
// 模块 → 核心：取
{ "op":"outbox.fetch", "id":"…", "data":{ "limit":5 } }
// 核心 → 模块
{ "ok":true, "result":{ "version":1, "items":[
  { "id":"out_…", "channel":"private:person_x", "target":null,
    "text":"你上次说「我妈住院了」，后来怎么样了？",
    "need":"care", "why":"pur_…", "created":"2026-11-10T18:00:00+08:00" }
]}}

// 模块 → 核心：回执（说成了 / 没成）
{ "op":"outbox.ack", "id":"…", "data":{ "id":"out_…", "ok":true } }
{ "op":"outbox.ack", "id":"…", "data":{ "id":"out_…", "ok":false, "code":"rate_limited", "message":"被上游限流" } }
```

纪律（四条，都是硬性）：

1. **取出即 `claimed`，不直接标 `sent`**。核心不知道消息有没有真的出去；只有 `ack` 才算数。
2. **交给模块之前重新过闸门**：静默时段、黑白名单、主动开关、每小时/每天配额——排队时合法不代表现在合法。
3. **`ok:false` 不立刻重试**：回 `pending`，由模块按自己的退避再来取；连续失败 **3 次**自动 `dropped`
   （与 `send` 的 at-most-once 同一个理由：宁可少一条，不能在真人群里复读）。
4. **领了不 ack 会超时回收**（5 分钟）：模块崩了，队列不能永久卡在 `claimed`。

`target` 是平台侧投递地址的原始字符串（群号/QQ 号），语义与 `send` 的 `target` 完全一致。

#### 5.1.2 `diag.report`：让模块的专业判断进同一张诊断清单（v1.4）

诊断页不是"贴日志"，而是每项给 `{code, stage, level, hint}` —— 错在哪、哪一步、下一步做什么。可核心只知道**它自己能看到的事实**（进程在不在、握手成没成、配置过没过 schema、崩溃了几次），**看不到模块自己的世界**：cookie 过期了、上游限流了、语音引擎没起来。`diag.report` 就是把这一半交回来。

```jsonc
// 模块 → 核心
{ "op": "diag.report", "id": "01JCV…", "data": {
  "items": [
    { "code": "cookie.expired", "level": "error",
      "hint": "到「B站」页重新登录一次，cookie 过期了",
      "detail": { "checkedAt": "2026-11-09T10:20:00+08:00" } }
  ]
}}
// 核心 → 模块
{ "id": "01JCV…", "ok": true, "result": { "accepted": 1, "truncated": false } }
```

四条纪律（都是硬性，超了**核心直接截断**而不是放行）：

1. **不需要能力**。这是"报告"，不是"动作"——能力门控管的是能做/不能做的事，报告不在其列。
2. **一次最多 20 条**；`code` ≤ 60 字、`hint` ≤ 200 字。一个模块不能靠诊断把页面刷满。
3. **整份替换**，不是累加。模块每次都重算一遍、整份报上来——核心帮它做增量合并只会产生它自己都不认识的残留项。
4. **15 分钟 TTL**。超过 15 分钟没再报，核心就当它不再成立、从清单里撤掉。

> 第 4 条是最重要的一条：**假绿比不绿更糟**。模块进程崩了、或者卡住了不再回报，它上一次报的「一切正常」如果还挂在页面上，比没有诊断更害人。

模块报的项会和核心自己的项**并进同一张清单**，标 `source: "module"` 与所属 `module` id——不各开一页。这样"这个模块现在到底怎么了"是一个列表能答完的问题。


#### 5.1.1 防回环（不可省）

- 平台回流的**机器人自身消息**必须投 `role: "bot"`；核心按 role 不触发候选事实、不计召回。
- 模块不得把核心 `send` 给它的内容再次 `ingest`——核心在 egress 侧记内容哈希，**10 分钟内命中即丢弃并计 skipped**。
- 这两条是网关上线第一天就会用到的规则，不是可选优化。

> `media.put` 的 base64 版本已取消（20MB base64 = 27MB，撞 256KB 帧上限）。分块方案连同占位一并砍掉。

### 5.2 核心 → 模块

| op | 入参 | 出参 | 说明 |
|---|---|---|---|
| `init` | `{api, coreVersion, config, tmp}` | `{ready:true, api}` | 握手；`tmp` 是**字符串**路径 |
| `send` | `{channel, target, text, media?, trace}` | `{ok, delivered_at, external_id?}` \| `{ok:false, code, message, retriable?}` | 唯一出站通道；`rules/action` 与 `never_do` 已跑完 |
| `ping` | `{}` | `{}`（同一 id 的普通响应） | 心跳，见 §8.1 |
| `actuate` | `{kind, input, trace}` | `{path, mime, size}` | **v1 一律 `E_UNSUPPORTED`**；形状见 §5.2.1 |
| `source.fetch` | `{source, params, limit, trace}` | 标准 inbox 信封 `{v:1, source, acct, items[]}` | **v1.1 已实现**；需模块声明 `provide.source` + `sources`；见 §5.2.2 |
| `ui.get` | `{tab}` | `{data}`（按 manifest 声明的 kind） | **v1.2 已实现**；只读；需 manifest 声明 `ui.tabs`；见 §5.2.3 |
| `shutdown` | `{reason, deadline_ms}` | — | 预告关停；超时强杀 |

**`send` 的字段语义**：

- `channel`：`private:10001` 这种，**只用于路由与规则**；
- `target`：平台侧投递地址的**原始字符串**（QQ 号 / 群号 / UID），模块直接用它投递；
- 两者都由核心给出，模块不得改写、不得从 `channel` 反推 `target`（两者恰好相同只是巧合）；
- `media` 元素是 `{path, mime, size, expires_at}`，**帧里不出现 ptr**——核心已把指针解析为临时文件，模块直接读路径。

**投递语义 at-most-once**：模块崩溃导致响应未回，核心**不重发**，记 refusal（undelivered），管理台可见。显式 `ok:false` 在 v1 **也不自动重试**——重试与否由模块在 `retriable` 里表态，核心只记录。宁可少一条回复，不能在真人群里复读。

配置变更、persona 切换通知等其余方向 **v1 一律不做**：配置变更 = `shutdown` + 重新 `init`（§3.1）。

#### 5.2.1 `actuate` 的形状（v1 预留）

```jsonc
// 核心 → actuator 模块
{ "op":"actuate", "id":"…", "data":{ "kind":"speech", "input":{ "text":"…" }, "trace":"01JCV…" } }
// 成功：产物已落在 $YUANLING_TMP 里（模块自己的临时目录），核心负责收走入库
{ "id":"…", "ok":true, "result":{ "path":"…", "mime":"audio/wav", "size":12345 } }
```

**寻址**：核心按 `kind` 查找声明了 `actuate.<kind>` capability 的模块（§5.3）；无认领者 → `E_NO_ROUTE`。同一 kind 两个模块声明 → 安装时已拒（§3.3 第 8 条）。

链路示意（v1.1 实现）：

```
core ──actuate(speech)──▶ tts 模块（声明 actuate.speech）
     ◀── {path} ─────────┘
core: 收走产物，入库 media，得 ptr
core ──send{channel, target, media:[{path,…}]}──▶ qq 模块
```

v1 里这个 op 直接回 `E_UNSUPPORTED`，但**名字、形状与寻址规则现在冻结**，避免三个模块各写一套。

#### 5.2.2 `source.fetch` 的形状（v1.1，已实现）

```jsonc
// 核心 → 模块：按需向它要一次数据
{ "op":"source.fetch", "id":"…", "data":{
    "source":"bili.search_video",      // 必须是该模块 manifest.sources 里声明过的 id
    "params":{ "q":"原灵" },           // 按 manifest 里的 params 子集校验
    "limit":10,                        // 可选，核心封顶
    "trace":"01JCV…"
} }
// 模块 → 核心：标准 inbox 信封（和 gateway 收消息时投的一模一样）
{ "id":"…", "ok":true, "result":{ "v":1, "source":"bili", "acct":"default", "items":[
    { "ext_id":"BV1xx411c7mD", "ts":"2026-11-06T21:04:00+08:00",
      "kind":"material", "text":"…", "actor":{ "kind":"system", "id":"bili", "name":"B站" } }
] } }
```

三条不能省：

1. **回填必须走 `ingest()`**，不另写落盘路径。脱敏、`never_record`、去重、分片、日链全都挂在 `ingest()` 上；另开一条路，就等于这些规则"对某类数据不生效"，而且没人拦得住。
2. **`items[].ext_id` 必填且稳定**（视频 BV 号、消息 id、网页 URL 的规范化形式）。核心按 `sha256(模块id + ext_id)` 生成 `h`，**不接受模块自带 `h`**——模块若能自定指纹，就能让核心"以为见过"而静默丢条（`raw.js` 的 `h` 由输入决定这件事，对 `ingest` 保留，对 `source.fetch` 禁用）。
3. **`source` 必须在该模块 manifest 的 `sources` 里**，否则 `E_BAD_REQUEST`。核心不猜模块能力，模块也不许临时发明 source。

调用结束后核心把**落库后的条目**（带指针）回给调用方——所以"查过"这件事本身留在原始层，下次 `recall` 得到的是同一批记录，不是重新编的。

失败语义：`E_NO_ROUTE`（没有模块声明这个 source，**或那个模块此刻没在运行**——不返回空结果冒充"确实没有"）/ `E_NO_CAP`（模块没被授予 `provide.source`）/ `E_RATE`（超频：每模块每分钟 10 次）/ `E_PROTO`（信封版本不对）/ `E_UNSUPPORTED`（模块没实现）。**一律不重试、不猜**；取不到就是取不到。

**模型这一侧的实现约束**（v1.1 落地时的选择）：模块进程只活在被 DSH 加载的那个插件进程里，而模型工具跑在独立的 MCP 进程里。所以取数走一条内网回环：MCP 进程读 `system/console.json` 拿到控制台地址（端口可以是随机分配的，不能假定 17777）→ 带 `console.token` POST `/api/sources/fetch` → 插件宿主把它转成 `source.fetch`。控制台没在跑时**如实报"控制台没在运行"**，不假装"没有数据"。

#### 5.2.3 `ui.get` 的形状（v1.2，已实现）

```jsonc
// 核心 → 模块：把某个自定义 tab 的数据给我
{ "op":"ui.get", "id":"…", "data":{ "tab":"stats" } }

// 模块 → 核心：按 manifest 里声明的 kind 回数据，**只回数据**
{ "id":"…", "ok":true, "result":{ "data":{ "在线":7, "队列":2 } } }          // kind: kv
{ "id":"…", "ok":true, "result":{ "data":[{ "title":"任务一", "sub":"排队中" }] } } // kind: list
{ "id":"…", "ok":true, "result":{ "data":{ "text":"一段说明" } } }            // kind: text
```

规则：

1. **`tab` 必须是 manifest 里声明过的 id**，否则 `E_NO_ROUTE`；核心不信模块临时发明的 tab。
2. **kind 由 manifest 决定，不由响应决定**：声明 `kv` 却回数组 → `E_BAD_REQUEST`，整块拒。半截渲染的数据比不渲染更误导人。
3. **限幅**：`list`/`kv` 最多 200 行、单字段 500 字、`text` 最多 16KB，超了截断并在响应里标 `truncated`。tab 是给人看的，不是数据传输通道。
4. **只读**：`ui.get` 不改变任何状态。模块要"被点一下做点什么"是 v1.3 的事（`ui.action`，必须白名单 action id + 每次记审计），现在没有。
5. 模块没在跑 → `E_NO_ROUTE`，**不返回空内容**：页面显示"这个 tab 是空的"会让人以为模块坏了。
6. 超时 15s：这个 op 允许模块现查一次状态（比如读自己的队列），比默认的 10s 宽一点。

### 5.3 capability：封闭词表

| capability | 允许的 op |
|---|---|
| `ingest.message` | `ingest` |
| `propose.fact` | `propose.fact` |
| `egress.text` / `egress.media` | 接收 `send` 的 text / media 形态 |
| `media.read` | `media.get` |
| `actuate.<kind>`（如 `actuate.speech`） | 接收 `actuate` 的对应 kind；kind 词表：`speech` \| `image` \| `video` |
| `provide.source`（v1.1） | 接收 `source.fetch`；须同时在 manifest 里声明 `sources` |
| `outbox`（v1.5） | `outbox.fetch` / `outbox.ack`：取"她主动想说的话"并回执 |
| `enrich.*` | v1 只保留名，不实现 |

- 不在表内的 capability → 拒装（§3.3 第 6 条）。
- `raw.write` 已删除：与 `ingest.message` 重复，一把锁不配两把钥匙。
- capability 是**声明**不是授权：能不能发，由核心 rules 每次 `send` 时决定；能不能被取数，由 `granted` 里有没有 `provide.source` 决定（**默认没有**，见 §2.1）。

> ⚠️ 已知不一致（留给 v1.1 第二刀收口）：代码里 `CAPABILITIES` 用的是扁平词 `send` / `actuate`，本文表格写的是 `egress.text` / `egress.media` / `actuate.<kind>`。这是 v1.0 时代"文档先行、实现简化"留下的差口，**本轮不动语义**，只把 `provide.source` 两边都补上；收口要单独一轮改代码 + 迁注册表，不能在补功能时顺手改。

**`E_NO_CAP` 双向生效**：

- 模块收到自己未声明的形态（只声明 `egress.text` 却收到 media）→ 回 `E_NO_CAP`；
- 模块调用自己未声明 capability 的 op（没有 `media.read` 却调 `media.get`）→ 核心回 `E_NO_CAP`。

## §6 握手

```
核心 spawn(entry.command)
  → {op:"init", id, data:{api:"1.0", coreVersion, config, tmp}}
  → {id, ok:true, result:{ready:true, api:"1.0"}}
  → 之后双向可发请求
```

- 30s 内无 `ready` = 启动失败。
- **以 `init` 返回的 `api` 为准**校验版本，不信 manifest 自述。
- 模块 stdout **只走协议**；往 stdout 打调试日志 = `E_PROTO`。调试输出走 stderr。
- `shutdown` 后未完成的在途请求按孤儿处理。

## §7 路由

1. manifest 的 `routes` 声明认领的频道前缀；**语法只有两种**：`kind:*`（如 `group:*`）与 `kind:<id>`（如 `group:12345`）。
2. 频道字符串与该模块 `ingest` 的 `item.channel` 同源，不需要第二套词表。
3. 安装时校验无重叠，冲突拒装并列出冲突模块。
4. `routes` 是 §2.2 的 diff 触发字段：变更必须回到人工确认。
5. 运行时按**字面量更长者优先**匹配（`group:12345` 胜过 `group:*`），匹配不到 → `E_NO_ROUTE`（不广播、不猜）。
6. 路由表写入 `system/modules.json`，管理台**只读**——编辑发生在模块仓库的 manifest 里，不发生在注册表。

## §8 运行时管理

### 8.1 心跳

每 60s 发 `ping`（标准请求，带 id），10s 内无响应；连续 2 次 = 假死，按崩溃处理。

### 8.2 背压

- 每模块 `ingest` 上限默认 **100 条/分钟**，超限 `E_RATE`（`retry:true`）。
- 核心侧队列有界（默认 1000）；满时 `E_BUSY`（`retry:true`）。
- `send` 进队列后不丢；但模块处于 crashed / 停用态时，`send` **直接记 refusal 不排队**——无界队列等死进程是内存炸弹。
- "不丢"指队列里的不丢；投递中断的处理见 §5.2 的 at-most-once。

### 8.3 崩溃与重启

- 退出 / 超时 / 假死 → 记 crash（附最后 50 行 stderr），指数退避 1s→2s→4s…封顶 60s，**累计 5 次后停止**，注册表标 `crashed`。
- **crashed 不会自动恢复**：只能由人在管理台点「启动」或 CLI 触发。核心不得因为"来了新消息"就偷偷重启——否则持续崩溃的模块变成定时炸弹。
- 重启后重走握手；崩溃前未确认的消息不代为重发（ingest 由模块按幂等自决重试；send 按 at-most-once 记 refusal）。

### 8.4 幂等

- 请求层：同一 `id` 在 5 分钟窗口内返回缓存结果，不重复执行。
- 数据层：raw 的 `h` 内容哈希兜底。
- **明示**：B站补跑历史时 `ts` 会乱序，那不是 bug——`ts` 是事件时间，核心另记 ingest 时间，两者都落 raw。

## §9 错误码（封闭表）

| code | 含义 | retry | 处理 |
|---|---|---|---|
| `E_BAD_REQUEST` | 参数不合法 | 否 | 记日志 |
| `E_UNSUPPORTED` | op / api 不支持（含 v1 的 `actuate`） | 否 | 记日志 |
| `E_NO_CAP` | 消息形态/能力与声明不符（双向，见 §5.3） | 否 | 记日志 |
| `E_RATE` | 速率超限 | 是 | 计数 |
| `E_BUSY` | 队列满 | 是 | 计数 |
| `E_MEDIA_TOO_LARGE` / `E_MEDIA_TYPE` | 媒体超限 / mime 不在白名单 | 否 | 计数 |
| `E_TMP_PATH` | 媒体路径不在分配的临时目录内 | 否 | 记日志 + 拒绝 |
| `E_PTR` | 指针解析失败 | 否 | 记日志 |
| `E_NO_ROUTE` | 没有模块认领该频道 / actuate kind | 否 | 记 refusal |
| `E_SEND_FAIL` | 平台侧投递失败 | 看 `retriable` | 记 refusal + 模块日志 |
| `E_PROTO` | 帧格式/超限/孤儿/版本不符 | — | 断开，按崩溃处理 |

新增错误码必须升协议次版本。**`E_NO_CAP` 与 `actuate` 在本版一起冻结，不留到上线再加。**

## §10 日志

- 每模块一个文件 `system/log/modules/<id>.ndjson`，核心代写；三路来源：stderr、`log` 上报、核心侧事件（spawn / crash / restart / refusal / media.get / install）。
- stderr **过与 ingest 相同的脱敏管线**再落盘——模块把聊天原文打进 stderr 是大概率事件，不能成为脱敏旁路。
- 超 10MB 轮转为 `<id>.<n>.ndjson`，保留最近 5 个。
- crash 记录内嵌最后 50 行 stderr。

## §11 trace

一条消息从 `ingest` 起携带 `trace`（ULID，**核心生成**，模块自带被忽略），贯穿：raw 记录 → 候选事实 → `send` / `actuate`。

管理台据此回答："这句话她为什么记得 / 这条回复为什么发出去"。协议层不埋，后面补不上。

## §12 权限模型（诚实版）

permissions 是**封闭的知情同意声明**，合法值就此两枚：

| 值 | 声明的含义 |
|---|---|
| `net.out` | 模块会主动对外联网 |
| `install.scripts` | 安装期需要执行 npm 脚本 |

| 栏 | 内容 | 强制力 |
|---|---|---|
| **核心强制** | 不 import 核心代码、只能调 §5.1 的方法（capability 词表见 §5.3） | 真边界：API 表面没有的能力，模块拿不到 |
| **知情同意** | `net.out`、`install.scripts` | **只是声明，不是沙箱**。子进程想联网，操作系统层面拦不住 |

确认页原话：*"本系统不隔离进程的网络与文件系统。权限声明来自模块作者的自述，安装即信任。"*

## §13 媒体

- **入站**：模块写进 `$YUANLING_TMP/`（就是它自己的临时目录，别再拼 `<id>`）→ `media.put.file {path, mime}` → 核心校验路径/大小/类型 → 存 `media/sha256/ab/cd/<hash>.<ext>` → 追加 `media/index.ndjson` → 返回 `ptr`；核心随即收走源文件（复制后删除；删不掉只记日志，不阻断——媒体已入库，临时文件清理不是正确性问题）。
- **出站**：核心把指针解析为临时文件，`send.media[]` 给 `{path, mime, size, expires_at}`，帧里不出现 ptr。
- 上限：单文件 20MB；mime 取 `media.receive` ∩ 白名单；`media.put.file` 默认 20 次/分钟。
- 去重：内容哈希天然去重；同内容不同 mime 以 `index` 区分。
- **临时目录生命周期**：`YUANLING_TMP` 本身就是该模块的独立子目录，落在核心侧的 `system/tmp/<id>/`；核心每 5 分钟清扫，超 `expires_at`（默认 10 分钟）的文件直接删；模块必须在过期前用完，过期后读不到不是错误。
- `media` 参与冷归档；引用计数从 raw 里的 `media:` 指针算出。
- **生命周期归核心，不经协议暴露**：满一年移入 `media-archive/`（同 hash 布局），删除由人决定。模块既收不到归档通知，也不该假设"文件还在热库"——`media.get` 必须**跨两处解析**（`media/` 找不到就去 `media-archive/`），这是它唯一需要知道的事。
- 指针因此**永不过期**：归档不是失效，只是搬家；`E_PTR` 只在两处都找不到时返回。
- **重复到达**：`media.put.file` 命中了一个已归档的 hash，就把它移回 `media/`（同一份文件，不复制第二份），索引记一条 `put` 事件。归档目录里不会留下"已复活"的副本。

## §14 http transport（占位，v1 不实现）

将来若做：端口由核心分配并注入 `YUANLING_PORT`；每模块独立 token，经 `YUANLING_TOKEN` 注入；只允许 `127.0.0.1`。除传输层外，信封、方法表、错误码与 stdio **完全一致**——transport 换了，协议不换。

## §15 注入给模块的环境变量

| 名称 | 形态 | 说明 |
|---|---|---|
| `YUANLING_API` | `"1.0"` | 协议版本 |
| `YUANLING_CORE_VERSION` | `"0.1.0"` | 核心版本，模块可据此降级 |
| `YUANLING_MODULE_ID` | `"qq"` | 与 manifest 的 `id` 一致，模块可自检装错没 |
| `YUANLING_TMP` | 绝对路径 | 该模块专属临时子目录，等价于 `init.tmp`（字符串） |

`entry.env` 可以追加，但 `YUANLING_*` 不可覆盖。**不注入数据目录路径**——模块对它没有任何合法用途（该用的只有 tmp），主动递过去等于邀请它扫。

## §16 `system/modules.json`（注册表）

```jsonc
{
  "version": 1,
  "modules": {
    "qq": {
      "id": "qq", "version": "1.2.0", "api": "1.0",
      "repo": "https://github.com/dshqqb/dsh-yuanling-qq",
      "installedRef": "9f2c…",              // commit SHA
      "previousRepo": null,
      "routes": ["private:*", "group:*"],
      "sources": [],                        // v1.1：manifest.sources 的 id 快照
      "capabilities": ["ingest.message", "egress.text", "egress.media"],
      "granted": ["ingest.message"],        // 实际授权；声明 ≠ 授予
      "permissions": ["net.out"],
      "enabled": true,
      "state": "running",                   // running | stopped | crashed
      "installed_at": "2026-11-07T10:00:00+08:00",
      "last_crash": null
    }
  }
}
```

- **注册表是 `repo` / `installedRef` / `previousRepo` / `installed_at` / `last_crash` / `enabled` 的唯一权威**——这些字段不在 manifest 里，重扫 `system/modules/` 恢复不出来；审计线索在 `changes.ndjson`。
- `granted` 是**授权**的唯一权威（manifest 只声明"我想要什么"）。v1.1 起新装默认是空数组；更新时与旧值取交集，不自动扩权。删掉这个字段会让"声明即授权"回来——那正是 §2.1 要避免的。
- 其余字段（id / version / api / routes / sources / capabilities / permissions）与 manifest 一致，以 manifest 为准。
- `state` 是**运行时快照**（advisory）：核心重启后所有 enabled 模块重新 spawn，`state` 重置；它不是持久事实，只是管理台展示"上次已知状态"。
- 写入走原子替换（与核心其他 JSON 一致）。

## §17 spike 验收单（冻结之前必须全绿）

核心 spawn 一个 ~30 行的 echo 模块，只验这七件事：

| # | 验收项 | 状态 | 测试 |
|---|---|---|---|
| 1 | **Windows spawn**：路径含空格与中文不炸 | ⬜ 待真机 | `p33` §17-1（受限环境跳过） |
| 2 | **分帧**：一次 write 两条、一条分两次 write | ✅ | `p28` frame 4 条 |
| 3 | **并发与乱序**：同时发两个请求，倒序回应不乱 | ✅ | `p28` 慢/快乱序 |
| 4 | **超时**：不回响应 10s 作废、进程不误杀 | ✅ | `p28` 超时用例 |
| 5 | **崩溃识别**：`exit(1)` → 记 crash → 退避重启 → 用尽后 `crashed` 不再拉起 | ✅ | `p28` 两条 |
| 6 | **stdout 污染**：打一行非 JSON → `E_PROTO` 断开 | ✅ | `p28` 污染用例 |
| 7 | **端到端**：`ingest` → 落 `raw/…/<source>.ndjson` → `{accepted:1}` → `shutdown` 干净退出 | ⬜ 待真机 | `p33` §17-7 |

已实现的部分（2026-11-08）：`src/core/modules/` 下 `manifest.js`（§3.3 校验）、`untar.js`（零依赖解包，拒目录穿越与特殊成员）、`registry.js`（§16）、`installer.js`（下载/校验/落盘/导出）、`frame.js`（§4.1）、`host.js`（§6/§8）、`service.js`（门面 + 能力门控）、`manage.js`（管理台视图），以及 CLI `yuanling module …` 与模块页。

第 1、7 条由人在桌面环境跑（`node test/p33.test.mjs`，4 条用例）。受限沙箱里子进程不能开管道，那两条会**跳过而不是假通过**——这是刻意的。

**七条全过，协议冻结为 v1.0**（2026-11-08）。


---

## 附：修订史（三方评审合并记录）

| 版本 | 关键修订 |
|---|---|
| glm v0.1 | 初稿：四条硬边界（补 egress）、manifest 完整字段表、方法表、错误码、心跳/背压/重启、trace、诚实权限模型、spike 先行 |
| ds v0.2 | `media.put` 改文件交接（base64 撞帧上限）；`propose.fact` 加 capability 门控 + `origin_module`；新增路由 `routes`；`--ignore-scripts` 默认；删 `presence`、`kind:"ui"` |
| glm v0.3 | 恢复防回环（role:"bot" + egress 哈希）；`source` 核心盖章；`send.media` 定为路径不出 ptr；at-most-once 投递语义；diff 清单补 `routes`/`media`；封闭词表落地；`ping` 信封修正；`YUANLING_TMP` 生命周期；raw 路径对齐代码 |
| ds v0.3 | `send.target` 定死；`actuate` 冻结形状；单例约束；环境变量清单；并发/乱序；`ingest` 批量 ≤100；`E_NO_CAP`；`modules.json` 结构；crashed 人工恢复；routes 两种语法；`log.data` 4KB |
| **本文（合并稿）** | `actuate.<kind>` capability 与寻址；超时按 op 分表（send 30s / actuate 300s）；`E_NO_CAP` 双向定义；砍 `YUANLING_ROOT` 注入；修正注册表"可重建"声明（repo/ref 等以注册表为唯一权威，state 为运行时快照） |
| 合并稿 + ds 校订 | ① `YUANLING_TMP` 语义统一：它就是模块自己的临时目录（`system/tmp/<id>/`），删掉三处 `YUANLING_TMP/<id>/` 的自相矛盾写法；② §2.2 的 diff 触发清单补 `kind` 与 `entry.os`（改 kind 等于改行为，改 os 等于改能否启动）；③ 全篇去引文，只留规范正文与修订史 |
| **v1.0 冻结（2026-11-08）** | 实现落地后回填的三处：① §2.1 安装方式从 `git clone` 改为**发行包 tgz**（不依赖 git、不跑构建脚本、可回滚），并写明"模块装在数据目录内"的决策与代价；② 新增 §2.1.1 整体导出；③ §17 改为逐条状态表，标注每条由哪个测试验证、哪两条必须有人在桌面环境跑。七条 spike 全过，去掉"候选稿"标记 |
| **v1.1（2026-11-08）** | ① 新增 §0.1 **原始层语义**：raw 只保证"记录与收到一致、不丢"，不做真伪判断与可信度分级；② manifest 增 `sources`（带 `api ≥ 1.1` 约束），能力词表增 `provide.source`，新增 core→module 的 `source.fetch`（§5.2.2）；③ **安装即空授权**：装完 `granted: []`，一次列出全部能力、一次确认，非 TTY 默认拒绝——修掉 v1.0 "文档说要点、代码闭眼给"的差口；④ 注册表补 `granted` / `sources` 两个字段的权威说明；⑤ 顺带修掉一个真 bug：raw 去重时回的指针指向**新生成的 id**（那个 id 根本没有落盘），现在回的是原来那条的 id；⑥ §2.1 **支持填"库的网址"直接安装**（查发行版 → 挑 .tgz 资产），源码归档（.zip/.tar.gz）不认 |
| **v1.2（2026-11-08）** | ① 新增 §3.5 `ui`：模块能给管理台加**只读标签页**（`kv` / `list` / `text` 三种封闭形态，最多 5 个，不许占核心的「概况」「日志」）；② 新增 core→module 的 `ui.get`（§5.2.3，15s，限幅 200 行 / 16KB）；③ 明确 **`ui` 不进 §2.2 的 diff 清单**——改个标签名不该让人重新确认安装，所以校验反而卡得更紧；④ 明确"模块只能给数据、不能给标记"：拒绝任何 HTML/JS/CSS 下发（管理台握着 console.token，这条线不能松）；⑤ 管理台按 `config.schema` 渲染**真表单**并保存后自动重启模块（§3.1 补充） |
| **v1.3（2026-11-08）** | ① `ui.tabs` 增 `kind:"config"`——模块可把一组配置单独开一页，内容由**核心**按 `config.schema` 渲染，不经 `ui.get`、模块停用时也能看；② 新增 `fields`（认领配置字段，避免同一份配置有两个编辑入口）；③ `config.schema` 支持 `array` + `items`（列表型配置，可增删改排序），数字支持 `minimum`/`maximum`（滑块量程）；④ 新增展示提示 `x-widget` / `x-step` / `x-enum-style`——只影响画什么控件，**不参与校验**；⑤ `action`（按钮）与 `file`（浏览文件）明确为**占位控件**：只画不提交，等 v1.4 的 `ui.action` 与核心侧文件选择器；⑥ `ui.tabs` 增 `kind:"records"`——模块只声明"看我自己产生的哪类记录"，**核心查 raw 渲染**（模块不读原始层，强制按模块 id 过滤） |
| **v1.4（2026-11-09）** | ① 新增 §5.1.2 `diag.report`：模块可把**自己的专业判断**（cookie 过期、上游限流、引擎没起来）报给核心，并进「诊断」页同一张清单（`source:"module"`）；不需能力、≤20 条、整份替换、**15 分钟 TTL**（进程死了，它上次报的"正常"必须消失——假绿比不绿更糟）。② 模块的「日志 / 审计 / 诊断」三页由**核心统一提供**，不靠协议自报：日志是它的 stderr + 核心写的生命周期；审计是它造成的写入（从版本 journal 派生，带 actor/reason/可回滚）；诊断是核心事实 + 上面这条自报。③ 因此 `api ≥ 1.4` 的模块只是**可以**多给一层专业诊断，不给也照样有完整三页——协议不强迫任何人实现它。④ §4.2 澄清**失败帧必须嵌套** `error:{code,message,retry}`：此前 bili 把 `code/message` 摊在顶层，核心读不到，所有模块失败都被吞成 `E_MODULE`；核心现在照收但记警告，`UI_RESERVED` 同时补上 `audit` / `diag` 两个新基础 tab 的保留位 |
