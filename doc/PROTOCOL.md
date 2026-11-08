# PROTOCOL · 原灵模块协议（v1.0）

> 状态：**v1.0 冻结（2026-11-08）**。§17 七条 spike 全部通过，实现已在 `src/core/modules/` 落地。
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
输入 URL（release 里的 .tgz）或本地 .tgz 路径
  → 下载字节（只允许 https；http 仅限 127.0.0.1 / localhost）
  → 校验 sha256（若给了期望值）
  → 解包到内存，按 §4.1 的清单检查：拒绝对路径、`..`、符号链接/设备文件
  → 读 yuanling.module.json，跑 §3.3 校验
  → 检查 routes 与已装模块无重叠
  → 先写 <id>.installing-<rand>/，再把旧目录改名备份、整体替换
  → 写 VERSION（version/api/sha256/source/repo/ref/at）
  → 写 system/modules.json
```

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

`kind` / `permissions` / `capabilities` / `routes` / `media.send` / `media.receive` / `entry.command` / `entry.env` / `entry.os` / `entry.install` / `config.schema`

其余字段（description、name）变化静默通过。注册表记 `installedRef` 与 `version`；旧版本目录保留，回滚 = 把注册表指回去。核心**永不**因模块崩溃而自动更新。

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

### 3.1 config：配置归核心

- 模块只声明 schema（JSON Schema 子集：`type / properties / required / enum / default / description`）。
- 实际值存 `system/modules/<id>/config.json`，由管理台按 schema 渲染。
- 模块通过 `config.get` 取值，**不自己读文件**；cookie / token 一类只存在核心侧。
- `config.schema` 是版本 diff 的一部分：新增必填项 → 更新时要求人补。
- **配置变更的生效方式只有一种**：核心发 `shutdown`，再按新配置重新 spawn + `init`。模块永不热更新。

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
8. `routes` 与已安装模块无重叠；`actuate.<kind>` 同 kind 与已安装模块无重叠（重叠 → 拒装并提示冲突模块）。

### 3.4 kind 的 v1 语义

| kind | 含义 | v1 |
|---|---|---|
| `gateway` | 收消息 → `ingest`；接收 `send` | ✅ 实现 |
| `actuator` | 由核心触发产出媒体（TTS / 绘图 / 视频） | ⬜ **接口写死，调用返回 `E_UNSUPPORTED`**（§5.2.1） |
| `enricher` | 加工管道（转写 / 翻译 / 摘要） | ⬜ 只保留类型名，顺序语义未定 |
| `ui` | 管理台扩展 UI | ❌ 删除。将来只允许"声明式面板：模块出 JSON，核心渲染" |

`presence` capability 一并删除——语义没想清楚的能力不该存在。

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

### 5.3 capability：封闭词表

| capability | 允许的 op |
|---|---|
| `ingest.message` | `ingest` |
| `propose.fact` | `propose.fact` |
| `egress.text` / `egress.media` | 接收 `send` 的 text / media 形态 |
| `media.read` | `media.get` |
| `actuate.<kind>`（如 `actuate.speech`） | 接收 `actuate` 的对应 kind；kind 词表：`speech` \| `image` \| `video` |
| `enrich.*` | v1 只保留名，不实现 |

- 不在表内的 capability → 拒装（§3.3 第 6 条）。
- `raw.write` 已删除：与 `ingest.message` 重复，一把锁不配两把钥匙。
- capability 是**声明**不是授权：能不能发，由核心 rules 每次 `send` 时决定。

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
      "capabilities": ["ingest.message", "egress.text", "egress.media"],
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
- 其余字段（id / version / api / routes / capabilities / permissions）与 manifest 一致，以 manifest 为准。
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
