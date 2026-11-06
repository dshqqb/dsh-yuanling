# 原灵 yuanling

**给 DSH 的长期记忆与人格底座。** 纯文件、纯 JSON，没有数据库，没有向量库，没有后台服务依赖。

它的目标不是"记住更多"，而是**记住的东西能被解释、被纠正、被忘掉**。

---

## 它解决什么

| 问题 | 常见做法 | 原灵的做法 |
|---|---|---|
| 记不住 | 只保留最近 N 轮 | 原始层永久留档，记忆层按重要性分层衰减 |
| **记错了却改不掉** | 摘要越摞越多，错的一直在 | 每条事实必须挂一个 `raw/…#ULID` 指针，可回查、可回滚 |
| **该忘的忘不了** | 删除即破坏，或者根本删不干净 | 墓碑：不动 raw，只在所有出口隔离，可撤销 |

一句话：**没有指针，就不许成为事实。**

---

## 设计框架

```
┌─────────────────────────────────────────────────────────┐
│  L0 原始层  raw/YYYY-MM/DD/<source>.ndjson               │
│  只追加、不改写、按天封存、sha256 日链                    │
└───────────────┬─────────────────────────────────────────┘
                │  证据指针（唯一入口）
┌───────────────▼─────────────────────────────────────────┐
│  L1 记忆层  personas/<id>/spaces/**/<主题>.json           │
│  事实 = 文本 + 指针 + 重要度 + 槽位 + 人生周期             │
│  三带：最初 / 最深刻 / 最新                               │
└───────────────┬─────────────────────────────────────────┘
                │  反复出现 → 提案
┌───────────────▼─────────────────────────────────────────┐
│  L2 人格层  SELF.md（骨架，不许自动改） / style.md（可演化）│
│  实体档案  entities/people|groups                         │
└─────────────────────────────────────────────────────────┘
```

两条线**贯穿所有层**：

- **版本线**：任何写盘都进内容寻址的 blob + append-only journal，回滚是"生成新版本"，不是"抹掉过去"。
- **规则线**：`guardrails.json`（硬线）→ `rules/ingest.json`（入库）→ 人格级 `rules/`（recall / action / persona）。

**边界很硬**：规则只管"能不能做"，从不塑造人格。人格靠记忆与表达层慢慢长出来。

---

## 一轮对话发生了什么

### 写入

```
QQ / B站 / 桌宠 / DSH
   │  ① 投递（NDJSON 文件 或 回环 HTTP + token）
   ▼
inbox  →  ② 硬线检查（guardrails.never_record 命中就丢弃，只计数）
   →  ③ 脱敏（密钥无条件打码；软黑名单入库但标 hidden；显式 skip 不落盘）
   →  ④ 追加 raw（补齐 v / id / h，32MB 自动分片，单行 256KB 截断）
   →  ⑤ 封存（day.json：行数 / 字节 / sha256 / 前一日哈希）
```

### 记成事实（由模型或人显式调用）

```
addFact({ topic, text, src: "raw/2026-11/07/qq.ndjson#01JCV..." })
   │  ① 指针必须能解析到真实记录   ← 硬规则，不满足直接抛错
   │  ② 查重：完全相同 / 包含 / 双字 bigram ≥0.78  → 命中则只 +1 重复次数
   │  ③ 槽位：同槽位新值关闭旧值（写 until，不删）
   │  ④ 重要度：规则表打分（承诺 > 事实 > 闲聊）
   │  ⑤ 情绪浓度、是否「最初」
   ▼
personas/<id>/spaces/日常/<主题>.json  +  版本历史一条
```

### 注入（每一轮）

```
buildCard()  ≤800 字节
  [骨架]     SELF.md 里的身份句（永不裁剪）
  [最初]     2 行，不衰减、不淘汰
  [最深刻]   3 行（重要 + 被反复召回）
  [最新]     5 行（14 天内）
  [索引]     N 条事实 / M 个主题 / K 条已隔离
contextFor(channel)
  [这个人]   私聊时带上对方素描
  [这个群]   群里带上群档案
```

预算不够时**从后往前裁**：先砍「最新」，再砍「最深刻」，**永不动「最初」**。

---

## 数据目录

默认 `~/.dsh/yuanling`，也可以用 `--root` / `YUANLING_HOME` / DSH 设置里的 `dataDir` 指到别处。

```
D:\yuanling\
├─ yuanling.json                 根标记：格式版本、当前人格、人格列表
├─ guardrails.json               硬线：never_record / never_inject / never_do
├─ 第一条.md                     写给"第一次启动的她"的话
├─ rules\
│  └─ ingest.json                入库策略：软黑名单、跳过频道（raw 共享，只有一份）
│
├─ raw\                          ① 原始层（只追加，永不改写）
│  └─ 2026-11\07\
│     ├─ qq.ndjson               一条消息一行 JSON（v/id/h/ts/channel/actor/text…）
│     ├─ qq-p2.ndjson            超过 32MB 自动分片
│     ├─ bili.ndjson             同一套格式，不同来源各一个文件
│     ├─ system.ndjson           系统事件：墓碑、纠错（也进链）
│     └─ day.json                封存：行数 / 字节 / sha256 / prev（日链）
│
├─ personas\                     ② 人格层（多个人格，共用上面那份 raw）
│  └─ yuanling\
│     ├─ persona.json            人格标记（id / 名字 / 创建时间）
│     ├─ persona\
│     │  ├─ SELF.md              骨架：名字、存在的原因（**永不自动修改**）
│     │  ├─ lines.md             口吻样例
│     │  └─ user.md              关于主人的设定
│     ├─ core.json               核心档案：身份、边界、说话习惯
│     ├─ style.md                表达层（演化提案只落这里）
│     ├─ entities\
│     │  ├─ people\person_x.json 对某个人的主观认识（素描、first_met）
│     │  └─ groups\123456.json   对某个群的印象（名称、氛围、语气）
│     ├─ spaces\
│     │  └─ 日常\备份.json        一个主题一个文件：facts[] + summary
│     ├─ rules\
│     │  ├─ global.json          人格级默认（recall / action / persona）
│     │  ├─ qq\group-123.json    群覆盖（20）
│     │  └─ private-10001.json   私聊覆盖（30，最具体）
│     ├─ proposals\prop_x.json   演化提案：主张、证据、状态、回滚锚点
│     ├─ state\
│     │  ├─ access.ndjson        召回流水（只追加，用于算"被想起过几次"）
│     │  └─ cursor.json          切入补跑游标
│     ├─ versions\               人格自己的版本库（blobs + journal，可随人格拷走）
│     └─ snapshots\              导出用的快照
│
└─ system\                       ③ 机器自有（人可以读，但不该手改）
   ├─ manifest.json              格式版本（太新就拒绝启动）
   ├─ identities.json            **客观**身份映射：哪个号是同一个人（跨人格共用）
   ├─ shields.json              墓碑登记簿（可从 raw 重建，不是真相）
   ├─ policy.json                设置页同步下来的两个旋钮（到期天数 / 每日配额）
   ├─ secrets\console.token      管理台令牌（64 位 hex）
   ├─ inbox\                     文件投递（<source>.ndjson + .health 心跳）
   ├─ versions\                  根级文件的版本库（blobs + journal）
   ├─ log\changes.ndjson         变更、拒绝、纠错、身份主张——一条流水账
   ├─ candidates\  index\  backups\  imports\  trash\   预留
   └─ media\  raw-archive\       （与 system 同级）外置媒体与冷归档，用到才出现
```

**哪些能删**：`system/shields.json` 删了可以从 raw 重建；`personas/*/versions` 删了只是丢掉回滚能力；`raw/` **永远不能删**——删了就没有任何东西能证明事实从哪来。

---

## 遗忘与纠错

| 动作 | 命令 | 说明 |
|---|---|---|
| 屏蔽一条原始记录 | `shield` / 管理台「屏蔽这条」 | raw 不动，只追加 redact 事件；所有人格、所有事实级联隔离 |
| 撤销屏蔽 | `unshield` | 追加 unredact，登记簿回滚 |
| 让它自然淡忘 | 无操作 | 重要度 + 召回 + 时间 → 清晰度从 vivid 一路掉到 gone |
| 纠正身份 | `identity correct` | 账号拆到新人物，旧主张写 `until`（不删），留 `identity_correction` |
| 撤销一次人格演化 | `proposal rollback` | 7 天内可用，按采纳前的 hash 退回 style.md |

---

## 安装

**它已经是 DSH 插件**：`index.js` 导出 `name / inject / Config / apply`，`package.json` 带 `dsh.bundle.patch`，`cordis.patch.yml` 负责挂进 profile。

```powershell
# 本地目录（最稳）
git clone https://github.com/dshqqb/dsh-yuanling.git D:\dsh-plugins\dsh-yuanling
dsh plugin --profile <profile> add "D:\dsh-plugins\dsh-yuanling"
```

装完**必须重启 DSH**。设置页会出现这些项：

| 配置 | 默认 | 说明 |
|---|---|---|
| `enabled` | true | 总开关 |
| `dataDir` | 空 → `~/.dsh/yuanling` | 默认路径首次运行会自动建骨架；显式路径必须先 `init` |
| `consoleEnabled` | true | 是否起管理台 |
| `consoleHost` | `127.0.0.1` | 只允许回环；要暴露必须同时开 `allowRemote` |
| `consolePort` | 17777 | 0 = 随机 |
| `autoApproveDays` | 3 | 提案无人理会几天后自动批准 |
| `dailyAutoLimit` | 1 | 每天最多自动采纳几条 |
| `preset` / `logLevel` | true / info | 是否注册 preset、日志级别 |

---

## 常用命令

```powershell
yuanling init --root D:\yuanling          # 建骨架 + 令牌（只补缺失，不覆盖）
yuanling status --root D:\yuanling        # 一眼看根、人格、计数
yuanling doctor --root D:\yuanling        # 体检：格式/标记/令牌/目录/权限
yuanling verify --root D:\yuanling        # 校验 raw 的 sha256 日链
yuanling last --root D:\yuanling          # 最近消息（带可直接用的指针）
yuanling memory save --topic 备份 --text "…" --src-last 1
yuanling memory recall --topic 备份 [--all]
yuanling memory why <factId>              # 这条凭什么存在
yuanling shield --last 1 [--yes]          # 屏蔽刚才那条
yuanling proposal scan|list|approve|reject|rollback|sweep
yuanling person new 张三 --platform qq --id 12345
yuanling identity claim --platform bili --id abc123 --src-last 1 --channel private:10001
yuanling serve --root D:\yuanling         # 管理台
```

## 管理台

`http://127.0.0.1:17777` —— 状态 / **注入预览** / 记忆 / 条目 / 提案 / 人物 / 规则 / 来源 / 拒绝记录。

第一次打开要粘贴 `system/secrets/console.token`（存本机 localStorage，只发给回环服务）。写操作都要 token，服务端不返回 CORS 头，别的网页发不进来。

**注入预览**是最有用的那一页：它显示"这一轮她到底读到了什么"。记忆系统最大的问题不是不记得，是**你以为它记得**。

## 安全边界

- 只听 `127.0.0.1`；非回环必须显式 `allowRemote`，且启动时打警告。
- 控制台令牌独立于 DSH，重装数据目录即失效。
- 不联网、不引第三方运行依赖（只有宿主提供的 `@deepseek-ai/schemastery`）。
- `system/identities.json` 视为敏感：不导出、不进注入。

## 开发

```powershell
node --test                      # 全部单元测试
node scripts/seed-demo.mjs D:\yuanling   # 造一份干净的演示数据（UTF-8 直写，绕开终端编码）
```

进度与待办见 `WORKLIST.md`（不入库）。

## 许可

MIT。
