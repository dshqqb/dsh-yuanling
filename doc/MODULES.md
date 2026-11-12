# 写一个原灵模块

> 这是**教程**：从头做一个能装、能跑、能收消息的模块。
> 规范的唯一权威是 [`PROTOCOL.md`](PROTOCOL.md)（v1.0，已冻结）。本文与它冲突时，以协议为准。
>
> 读完这份你应该能：写一个 `yuanling.module.json`、用 stdio 说协议、在本地装上、看着它运行。

---

## 1. 模块是什么，不是什么

**是**：一个独立的操作系统进程。核心用 `spawn` 起它，通过 stdin/stdout 交换一行一条的 JSON。

**不是**：不是一个能被 `import` 进核心的库，也不是一个 DSH 插件。模块和核心之间**只有协议**这一条接触面——语言随便，Python、Go、Rust 都能写（只要会说 NDJSON）。

一句话记住三条：

1. **模块不碰核心的文件**。想写记忆 → 调 `propose.fact`；想入库原始消息 → 调 `ingest`。落盘永远是核心的事。
2. **模块不决定发什么**。核心发起 `send`，模块只负责投递。这是"她不会背着你说话"的落点。
3. **stdout 只能出协议帧**。你的日志必须走 stderr，或者用 `log` op 交给核心代写。往 stdout 打一行非 JSON，核心会判 `E_PROTO` 并断开——这是刻意的，因为"日志混进协议流"是这类桥接最常见的事故。

---

## 2. 包的形状

一个模块就是一个 `.tgz`（npm pack 的产物即可，也接受裸 tar）。解开之后：

```
yuanling.module.json     必须有：模块自述与校验依据
index.mjs                入口（命令由 manifest 指定，不一定是这个文件名）
package.json             可选，但要有就必须零运行时依赖
README.md                可选
```

**没有任何构建步骤**。核心不会跑 `npm install`、也不会跑 `postinstall`——这是安全底线（协议 §2.5）。所以：

- **不要声明运行时依赖**。需要 HTTP、JSON、gzip，用语言自带的。
- 真要第三方库，就把它打进来（vendored）。

---

## 3. `yuanling.module.json`

最小可用的一份：

```json
{
  "id": "echo",
  "version": "0.1.0",
  "api": "1.0",
  "kind": "gateway",
  "entry": { "command": ["node", "index.mjs"] },
  "capabilities": ["ingest.message"]
}
```

字段逐个说：

| 字段 | 必填 | 说明 |
|---|---|---|
| `id` | ✅ | 小写字母开头，`[a-z0-9-]`，2~32 字符。**它会成为 raw 的来源名**（`raw/<月>/<日>/<id>.ndjson`），所以 `system` / `raw` / `media` / `rules` 这些是保留字，撞了会被拒装 |
| `name` | ⬜ | **给人看的显示名，由你自己定**。管理台左侧菜单就显示它（超过 16 字会被截断加省略号，完整名在鼠标悬停提示里）。不写就回退到 `id`，并去掉 `dsh-yuanling-` / `yuanling-` 前缀（`dsh-yuanling-qq` → `qq`）。**核心不会从仓库名或 id 反推**——包名不等于你希望用户看到的名字 |
| `version` | ✅ | 完整 semver（`1.2.3`）。更新时用来判断新旧 |
| `api` | ✅ | 协议版本。核心实现 **1.1**（也接受 1.0）；**主版本必须相同**，次版本不能高于核心。声明 `sources` 就必须 ≥ `1.1` |
| `kind` | ⬜ | `gateway`（收消息，v1 唯一实现）/ `actuator`（由核心触发生成内容，v1 接口留、调用回 `E_UNSUPPORTED`）/ `enricher`（加工管道，语义未定） |
| `entry.command` | ✅ | 非空数组，`[0]` 是命令名，**不能含路径分隔符**。`"node"` 会被核心换成本机的 node 可执行文件；用别的命令就写裸名字 |
| `capabilities` | ⬜ | 封闭词表，见下节 |
| `sources` | ⬜ | v1.1：声明"我这儿有什么数据可以被要"（`id` / `title` / `params`）。`id` 必须形如 `<模块id>.<名字>` |
| `config` | ⬜ | 声明了就给 `schema`（JSON Schema 子集），**管理台据此渲染表单**（输入框 / 数字 / 开关 / 下拉），保存前核心会按 schema 校验，存进 `system/modules/<id>/config.json`，改完自动重启模块。名字像密钥的字段（`sessdata`/`token`/`cookie`…）会显示成密码框，也可以用 `"x-secret": true` 显式声明 |
| `routes` | ⬜ | **认领的频道前缀**（`group:*` / `group:<id>` 这两种写法），决定哪些频道的消息归你 `ingest`。它**不是** HTTP 路由、也不是管理台扩展点 |
| `ui` | ⬜ | v1.2：给管理台加**只读标签页**，`tabs: [{id, label, kind, fields?}]`；`kind` 只认 `kv` / `list` / `text` / `config`。**不能下发 HTML/JS**——模块只描述"画什么"，画法由核心定。`kind:"config"` 表示"这页就是我的配置表单"，用 `fields` 认领字段（v1.3） |

### 能力：申请什么，才可能拿到什么

| capability | 能做什么 | 风险 |
|---|---|---|
| `ingest.message` | 调 `ingest` 把消息落进 raw（单批 ≤100 条） | 低（核心盖章 `source`、做脱敏） |
| `propose.fact` | 调 `propose.fact` 提候选事实 | 低（入不入库由核心判） || `media.put.file` | 把临时文件交给核心归档 | 中（路径必须在自己 `$YUANLING_TMP` 内）**v1 核心尚未实现**：可以调用，但会收到"宿主不支持" |
| `media.read` | 通过指针读回媒体 | 中 —— 同样**v1 未实现** |
| `send` | 收到核心的 `send` 请求后**真的把消息发出去** | **高**：唯一能"往外说话"的能力 |
| `actuate` | 生成语音/视频/图片 | **v1 未实现**（接口形状冻结，调用回 `E_UNSUPPORTED`） |
| `provide.source` | 被核心调 `source.fetch` 时交出一次数据 | 中：数据会进 raw、进她的上下文；**v1.1 第二刀，⬜ 核心侧未实现** |

**声明 ≠ 授予**。你在 manifest 里声明 `send`，装完之后是否真的授予由人决定；未被授予时核心直接回 `E_NO_CAP`，你的请求会被拒。所以：**代码里要能优雅处理 `E_NO_CAP`**，不要假定自己有权限。

> 顺带一句：`ingest` 一条**群频道**（`group:123456` / `tieba:原神吧`）的消息时，核心会顺手把这个群体记下来（第一次见到就建卡，之后只推"最后一次见到"）。你不用、也没法替它建群——只把 `channel` 写对就行。私聊和 `module:xxx` 这类频道不算群体。

**v1.1 起装完是空授权**：安装时核心把声明的能力全部列给用户看一次，用户回一个 Y / n。所以你的模块"装上了但什么都没被授予"是完全正常的初始状态，不是装坏了。

---

## 4. 说话的方式

### 帧

stdout 与 stdin 上都是 **NDJSON**：一行一条 JSON，UTF-8 无 BOM，行尾 `\n`。单帧上限 **256KB**。

### 信封

```jsonc
// 核心 → 你：请求（带 id，你要回）
{ "op": "ingest", "id": "01JCV…", "data": { "v": 1, "source": "qq", "items": [ … ] } }

// 你 → 核心：成功
{ "id": "01JCV…", "ok": true, "result": { "accepted": 1 } }

// 你 → 核心：失败
{ "id": "01JCV…", "ok": false, "error": { "code": "E_RATE", "message": "…", "retry": true } }

// 你 → 核心：通知（无 id、不需回应）
{ "op": "log", "data": { "level": "info", "event": "连上了" } }
```

规则只有三条，但都要守：

- **响应必须回带同一个 `id`**。
- **允许乱序**：你可以在两个在途请求中先回后发的那个。
- **超时按 op 定**（`init` 30s / `ingest` 10s / `send` 30s / `actuate` 300s / 其余 10s）。超时只作废那一次请求，**不杀你的进程**；但连续 3 次超时会被当成崩溃。

### 你要处理的 op（核心 → 模块）

| op | 什么时候来 | 你要回什么 |
|---|---|---|
| `init` | 启动后第一次 | `{ ready: true }`，之后核心才认为你活着 |
| `ping` | 心跳 | `{ pong: true }` |
| `ingest` | 核心把消息交给你 | 见下（**模块一般不需要处理这个**——方向是模块调核心） |
| `send` | 核心要发一条消息 | `{ delivered: true }`，失败回错误带 `retry` |
| `config.get` | 极少；通常你主动问核心 | — |
| `shutdown` | 核心要停你 | 收到就直接退出（`process.exit(0)`） |

### 你可以调的 op（模块 → 核心）

`✅` = v1 已实现；`⬜` = 协议里定义了但核心还没做，调用会收到 "宿主不支持"。

| op | 用途 | 需要的能力 | v1 |
|---|---|---|---|
| `ingest` | 把收到的消息交给核心落盘（单批 ≤100） | `ingest.message` | ✅ |
| `propose.fact` | 提交一条候选事实 | `propose.fact` | ✅（需要宿主接处理器） |
| `config.get` | 取核心保管的配置（**不要自己读配置文件**） | — | ✅ |
| `log` | 让核心代写日志（4KB 上限，超限截断） | — | ✅ |
| `diag.report` | 报你自己的健康项（cookie 过期、上游限流…），并进核心的「诊断」页 | — | ✅ v1.4 |
| `media.put.file` | 交一个临时文件给核心归档 | `media.put.file` | ⬜ |
| `media.get` | 按指针读回媒体 | `media.read` | ⬜ |

**核心可以调的 op（核心 → 模块，v1.1）**

| op | 你要做什么 | 需要 | 状态 |
|---|---|---|---|
| `init` | 回 `{ready:true, api}` | — | ✅ |
| `ping` | 回 `{}` | — | ✅ |
| `send` | 真的把消息投出去 | `send` + 被授予 | ✅ |
| `source.fetch` | 按 `data.source` 交一批数据（**标准 inbox 信封**） | `provide.source` + `sources` + 被授予 | ✅ v1.1 |
| `ui.get` | 按 `data.tab` 交这个标签页的数据（`kv`/`list`/`text` 三选一） | `ui.tabs` 里声明过 | ✅ v1.2 |
| `actuate` | 生成语音/视频 | `actuate` | ⬜ 回 `E_UNSUPPORTED` |
| `shutdown` | 收尾退出 | — | ✅ |

`source.fetch` 的两条硬要求（协议 §5.2.2）：

1. **`items[].ext_id` 必填且稳定**（BV 号、消息 id、规范化 URL）。核心按 `sha256(模块id + source + ext_id)` 自己算 `h` 去重，**不收你自报的 `h`**——否则你能让核心"以为见过"而静默丢条。
2. 回的是**标准 inbox 信封**，核心会把它当普通投递走 `ingest()`：脱敏、`never_record`、分片、日链全部照常生效。所以别在 `text` 里塞 JSON 字符串，就当它是"这个来源说的一段话"。

**写模块时请先只依赖 ✅ 的那些。** 标 ⬜ 的在核心补齐之前，声明了能力也拿不到结果——协议冻结的是"形状"，不是"已实现"。

`ingest` 的入参与返回值：

```jsonc
// 你发
{ "op": "ingest", "id": "…", "data": {
    "v": 1,
    "source": "qq",                    // 核心会盖章成你的 id，不用纠结这里写什么
    "acct": "10001",
    "items": [ { "channel": "private:12345", "actor": { "kind": "member", "id": "12345", "name": "张三" }, "role": "user", "text": "在吗", "ts": "2026-11-08T16:00:00+08:00" } ]
} }

// 核心回（v1.7 起多一个 items：按入参顺序，给内部场景号与 directed）
{ "id": "…", "ok": true, "result": { "accepted": 1, "deduped": 0, "skipped": 0, "errors": [],
    "items": [ { "channel": "private:person_x", "native": "private:12345",
                 "directed": true, "deduped": false, "skipped": false,
                 "record": "raw/2026-11/12/qq.ndjson#01JCV…" } ] } }
```

- 单批 ≤ 100 条；
- 不保证按投递顺序落盘，需要顺序就自己串行；
- **`group_name`（可选，v1.7）**：群消息可以带这一条（`"group_name": "摸鱼群"`），核心第一次见到这个群时用它建群体卡；
  之后拿到也会补上，但**不会覆盖人写过的群名**。不带你也不会丢消息，群卡只是暂时没有名字。
- 群里说话的人第一次出现时，核心会自动建一张**影子人物卡**（`tier: shadow`，不进注入、人物页默认不显示）；
  名字取 `actor.name`（建议填群名片/昵称），没有就先用号码。
- **`actor.friend` / `actor.remark`（可选，v1.7）**：适配器能拿到好友列表时，把"这个号是不是好友 + 备注"带上。
  核心只把它记在身份条目上（同一个人的两个号可以一个是一个不是），**不写进 raw 正文**；
  拿不到就别带——核心不会猜。

**`diag.report` 的入参与返回值**（v1.4，可选但值得写）：

```jsonc
// 你发
{ "op": "diag.report", "id": "…", "data": { "items": [
    { "code": "cookie.expired", "level": "error", "hint": "到设置页重新登录一次" }
] } }

// 核心回
{ "id": "…", "ok": true, "result": { "accepted": 1, "truncated": false } }
```

- 一次 ≤20 条，`code` ≤60 字、`hint` ≤200 字；
- **整份替换**（每次都重算，别做增量）；
- **15 分钟没再报就自动撤掉**——所以你该在"发现问题"和"确认已恢复"时各报一次，恢复时传空数组；
- 不需要能力；没写它也照样有完整的日志/审计/诊断三页（那三页由核心提供）。

**防回环**（网关第一天就会用到，不是可选优化）：机器人自己发的消息必须标 `role: "bot"`；核心按 role 不触发候选事实、不计召回。

---

## 5. 一个能跑的完整例子

`scripts/make-demo-module.mjs` 会生成一个真的能装、能跑的模块包。它的 `index.mjs` 值得从头读一遍：

```js
const send = (o) => process.stdout.write(JSON.stringify(o) + '\n')
const log = (level, event) => send({ op: 'log', data: { level, event } })

process.stdin.on('data', (chunk) => {
  for (const line of chunk.toString().split('\n')) {
    if (!line.trim()) continue
    let f
    try { f = JSON.parse(line) } catch { continue }

    if (f.op === 'shutdown') { process.exit(0) }

    if (f.op === 'init') {
      log('info', 'init 收到')
      send({ id: f.id, ok: true, result: { ready: true } })
    } else if (f.op === 'ping') {
      send({ id: f.id, ok: true, result: { pong: true } })
    } else if (f.op === 'ingest') {
      const items = f.data?.items ?? []
      send({ id: f.id, ok: true, result: { accepted: items.length, deduped: 0, skipped: 0, errors: [] } })
    } else {
      send({ id: f.id, ok: false, error: { code: 'E_NOPE', message: '不支持：' + f.op } })
    }
  }
})
```

四个细节，都是"不这样做会出问题"的：

1. **按 `\n` 切行，不要假设一次 data 就是一条帧**。Node 会把多条帧合成一个 chunk，也会把一条帧切成两个 chunk。
2. **`try/parse` 包起来**：坏帧跳过，不要让异常把整个循环打断。
3. **未知 op 要回错误**（`E_NOPE`），不要沉默——沉默会让核心等到超时，看起来像你死了。
4. **`shutdown` 立刻退出**。核心会先给你 `deadline_ms`，超时会硬杀。

---

## 6. 在本地把它装上

```powershell
# 1. 造包（也可以用 npm pack <目录>）
node scripts/make-demo-module.mjs .

# 2. 装
node bin/yuanling.js module install --file ./demo-0.1.0.tgz --source manual

# 3. 看
node bin/yuanling.js module list
node bin/yuanling.js module show demo

# 4. 跑（重启 DSH 后核心会拉起 enabled 的模块）
#    或者用 CLI 起管理台看模块页：http://127.0.0.1:17777
```

调试时的三条命令：

```powershell
node bin/yuanling.js module show demo     # 状态、能力、配置、最近日志
node bin/yuanling.js module disable demo  # 停用（重启也不起），排查"是不是它在捣乱"
node bin/yuanling.js module export demo   # 导出 tgz，拷到另一台机器
```

日志在哪：

```
<数据目录>/system/log/modules/<id>.log
```

---

## 7. 自测清单（提交给用户之前）

| 项 | 怎么验 |
|---|---|
| 一次 `write` 两条帧、一条帧分两次 `write` | 都能正确处理 |
| 并发两个请求，倒序回应 | 两边都按 `id` 对上 |
| 收到 `ping` 秒回 | 别做慢活 |
| 收到不认识的 op | 回错误码，不沉默 |
| 收到 `shutdown` | 立刻退出，不留子进程 |
| **往 stdout 打日志**（故意） | 核心应当断开——说明协议在守边界，不是你写错了 |
| 没有 `send` 授予时调 `send` | 收到 `E_NO_CAP`，且你的代码不崩 |
| 路径含中文与空格的目录 | 能跑（Windows 上必测） |

---

## 8. 发布

打一个 release，附上 `.tgz` 与 sha256：

```
https://<你的仓库>/releases/download/v0.1.0/echo-0.1.0.tgz
```

用户可以**直接填库的网址**（省得自己去拼资产地址）：

```powershell
# 库的网址：核心会去它的发行版里找 .tgz 资产（Gitee / GitHub 都认）
yuanling module install --url https://gitee.com/<owner>/<repo>
yuanling module install --url https://github.com/<owner>/<repo>

# 指定版本：/releases/tag/<tag>
yuanling module install --url https://gitee.com/<owner>/<repo>/releases/tag/v0.1.0

# 直链也行（不给 --sha256 就只记下来，方便以后核对）
yuanling module install --url <tgz 直链> --sha256 <hash>
```

管理台的「模块」页有同一个输入框：填库网址或 tgz 直链都行，填本地路径也可以。

**只允许 https**（`http` 仅限本机回环）。

三条要知道的：

1. **资产必须是 `.tgz`**。两个平台都会把源码归档（`v1.0.0.tar.gz` / `.zip`）混进 assets，核心一律不认——它解出来是仓库源码，没有 `yuanling.module.json`。
2. **优先最新、非预发布**。想装预发布或用旧版本，就在地址后面加 `/releases/tag/<tag>`。
3. 没有发行版时，报错会告诉你下一步：先建 release、先传 tgz，而不是"安装失败"。

---

## 9. 三件不要做的事

1. **不要读核心的数据目录**。你只该通过 `config.get` 拿配置、通过 `media.get` 拿媒体。绕过协议去读 `raw/` 或 `personas/` 等于绕过所有边界。
2. **不要自己决定发什么**。核心的 `send` 带着已经批准的内容；你自作主张多发一条，就是"她背着你说话"。
3. **不要在 stdout 打日志**。用 stderr，或者 `log` op。混合流的桥接最后都会毁在"这条是日志还是协议"上。

---

## 附：文档地图

| 文件 | 是什么 |
|---|---|
| [`PROTOCOL.md`](PROTOCOL.md) | **规范**（v1.1 进行中；v1.0 的七条 spike 已冻结）：信封、方法表、错误码、能力协商、trace、§17 验收单 |
| 本文 | **教程**：怎么做一个模块 |
| [`SECURITY.md`](SECURITY.md) | 安全边界：暴露面、密钥、越权防护 |
| [`PURPOSE_ANALYSIS.md`](PURPOSE_ANALYSIS.md) | 「目的层」的设计来源与取舍（不是模块相关） |
| `../README.md` | 面向用户：安装、数据目录、管理台 |
