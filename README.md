# 原灵 yuanling

松耦合，模块化，核心只保留最基本的记忆相关设置，对接QQ、B站、桌宠等功能都采用模块化的方式，每个模块是单独的项目

原始层（保留最原始的记忆，写过一次之后只读，不改），记忆层，人格层（骨架由人设定，不能自改，其余可以演化）



---



**给 DSH 的长期记忆与人格底座。** 纯文件、纯 JSON，没有数据库，没有向量库，没有后台服务依赖。

它的目标不是"记住更多"，而是**记住的东西能被解释、被纠正、被忘掉**。

---

## 它站在谁的肩膀上

设计这块的时候读了七个现成项目（都是 DSH 生态里的记忆/人格插件），逐个拆开看哪些机制经得起推敲、哪些是过度设计。下面这张表就是当时的结论——**左边是拿走的，右边是明确不要的**。

| 项目 | 采纳的 | 放弃的 |
|---|---|---|
| [dsh-memory-dict](https://github.com/Sleepless256/dsh-memory-dict) | 文件夹 + 纯文本 + JSON 的存储形态；**扁平词条**（一个主题写透，不拆碎、不建层级）；槽位（同槽位新值关闭旧值）；三层查重（全同 → 包含 → bigram ≥ 0.78）；原子写（临时文件 + rename）；常驻预算硬上限 | **全人工写**——每条记忆都得手动敲，用三天就没人写了；**没有时间线**——只知道"现在是这样"，不知道"从什么时候起、到什么时候止" |
| [surfcore](https://github.com/Mieksido/surfcore) | 拟人遗忘（四级清晰度）；**「最初」机制**（30 天窗口 + 确定性散列，不是随机抽签）；单一写者模型；scope 隐私隔离；回环 + 令牌的管理台；摘要与全量分离；B站只读的边界姿态 | **把 `clarity` 存成字段**、每天降一档——某天定时任务没跑，就永远不降了。原灵改成**纯函数派生**：不存在"漏跑"这回事 |
| [dsh-soul](https://github.com/icyaaaww/dsh-soul) | 作废不删行；`valid_to / supersedes` 双时间线；变更计划（先列变更、再落盘） | 多档状态机；把"整理"做成一套需要人伺候的流程 |
| [dsh-agent-soul（ECHO）](https://github.com/cyanwell/dsh-agent-soul) | **没有指针不许进长期层**——这条被原灵当成第一硬规则；只追加账本（append-only） | 全量卡注入——把整本记忆塞进上下文，token 烧得比聊得还快。原灵默认 **8 KB**（1M 上下文下占 0.5%），并且明写裁剪顺序 |
| [canyueY/dsh-mnemosyne](https://github.com/canyueY/dsh-mnemosyne) | 观察 → 证据 → 记忆的认知链；事实与推断分离；**好评/自评不作晋升依据**；每次结构变更有日志 | **Claim 九态**（提议/支持/合格/已验证/争议…）——一个人自己的记忆不需要九个状态，三档 + 证据 + 时间线足够；**23 个 migration**——迁移脚本比功能还多，说明模型没想清楚 |
| [DSH-Raising-Plan/dsh-mnemosyne](https://github.com/DSH-Raising-Plan/dsh-mnemosyne) | 兴趣信号分层（被动 / 注意 / 投入 / 明说）；**单次观察永不晋升**；`oppose_discount < 1`（一次反驳抹不掉大量一致证据，但明确否定可触发复核）；内容哈希做幂等键；删除级联 | 重 schema 与强状态机——原灵的状态就是一个字段（`until` 有没有值），其余用时间线和证据表达 |
| [xiaoman-memory](https://github.com/yunkong-134/xiaoman-memory) | **沉底**：离开常驻与默认检索，权重随时间衰减，但不删 | 用"沉底"替代遗忘语义——沉底只解决"别占位置"，不解决"该不该记得" |

### 刻意不学的三件事

1. **不用向量库 / 嵌入。** 检索靠 bigram 相似 + 重要度 + 时间，几百条事实完全够用；上了向量就要解释"为什么召回这条"，而原灵要求**可解释**。
2. **不用数据库。** SQLite 也能用，但换机器、备份、人肉查看、git diff 全都变麻烦。文件夹 + JSON 的代价是性能，收益是**你能用记事本打开它**。
3. **不调用模型。** 提取、评分、演化全在本地算，零 API 调用。所以"她为什么记得这个"永远能答——不需要再问一次模型。

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
buildCard()  ≤8 KB（默认，可配）—— 只装记忆，不含人物
  [骨架]     SELF.md 里的身份句（永不裁剪）
  [最初]     3 条，不衰减、不淘汰
  [最深刻]   6 条（重要 + 被反复召回）
  [最新]     10 条（14 天内）
  [索引]     N 条事实 / M 个主题 / K 条已隔离

contextFor(channel) —— 按"这一轮谁在场"追加人物卡
  [惦记]    最多 2 条、每条 ≤120 字节（想提就提，不想提就别提）
  私聊：对方那一张（每人 ≤600 字节）
  群聊：[这个群] 群档案 + [人物] 被 @ 的人、最近发言人（最多 8 张）
```

**「惦记」是什么**：她的目的账本里到期的那几件事，比如"你上次说面试，后来怎么样了"。每条目的都带 `origin` 指针，能翻回 raw 里那句话——所以被问"你怎么突然问这个"时答得出。它不是日程提醒，是**没说完的话**；写得明确可选，因为尬聊最伤"像不像人"。

人物卡是**本地档案库，数量无上限**；进上下文的只是"现在在说话的那几个人"。权重不参与这里的选择——它只决定管理台里怎么排。如果群里有 20 个熟人，她这一轮也只会带上正在说话的 8 个。

预算不够时**从后往前裁**：先砍「最新」，再砍「最深刻」，再砍「人物」，**永不动「最初」**。

所以预算是**软上限**：如果「骨架 + 最初 + 索引」本身就超了，卡片会超预算而不是继续裁——「最初」是她最早认识你的那几件事，宁可多几十字节，也不能把它们挤掉。

> 为什么是 8 KB 而不是 80 KB：1M 上下文下 8 KB 只占 0.5%，放得下；但**放得下不等于该放**——注入 100 条平庸记忆，比 10 条关键的更容易让她说错话。预算是用来逼出取舍的。

---

## 数据目录

默认 `~/.dsh/yuanling`，也可以用 `--root` / `YUANLING_HOME` / DSH 设置里的 `dataDir` 指到别处。

```
D:\yuanling\
├─ yuanling.json                 根标记：格式版本、当前人格、人格列表
├─ guardrails.json               硬线：never_record / never_inject / never_do
├─ 第一条.md                     写给"第一次启动的她"的话
├─ README.md  .gitignore          数据目录自带的说明与忽略规则（别把这里提交进 git）
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
├─ media\                        ② 媒体层（与 raw 平级：内容不可重建，所以不进 system）
│  ├─ sha256\ab\cd\<hash>.png    二进制本体，按内容寻址，天然去重
│  ├─ thumbs\ab\cd\<hash>.webp   派生缩略图（可随时删、可重建）
│  └─ index\2026-11.ndjson       按月只追加：put / archive / delete 事件
│
├─ media-archive\                一年以上的媒体，同样的 hash 布局，可整体删除
│
├─ personas\                     ③ 人格层（多个人格，共用上面那份 raw）
│  └─ yuanling\
│     ├─ persona.json            人格标记（id / 名字 / 创建时间）
│     ├─ persona\
│     │  ├─ SELF.md              骨架：名字、存在的原因（**永不自动修改**）
│     │  ├─ lines.md             口吻样例
│     │  └─ user.md              关于主人的设定
│     ├─ core.json               核心档案：身份、边界、说话习惯
│     ├─ style.md                表达层（演化提案只落这里）
│     ├─ entities\
│     │  ├─ people\person_x.json 她对这个人的认识：素描、weight、first_met、身份描述原文
│     │  └─ groups\123456.json   她对这个群的印象（名称、氛围、语气）
│     ├─ spaces\
│     │  └─ 日常\
│     │     └─ entries\备份.json   一个主题一个文件：facts[] + summary（space 与 entries 都是目录层）
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
├─ raw-archive\                  冷归档：raw 的早期分片按月移入，链仍可校验
├─ web\                          管理台静态页（仓库自带一份；这里可放覆盖版，预留）
│
└─ system\                       ④ 机器自有（人可以读，但不该手改）
   ├─ manifest.json              格式版本（太新就拒绝启动）
   ├─ identities.json            **客观**身份映射：哪个号是同一个人（跨人格共用）
   ├─ shields.json              墓碑登记簿（可从 raw 重建，不是真相）
   ├─ policy.json                设置页同步下来的两个旋钮（到期天数 / 每日配额）
   ├─ secrets\console.token      管理台令牌（64 位 hex）
   ├─ inbox\                     文件投递（<source>.ndjson + .health 心跳）
   ├─ versions\                  根级文件的版本库（blobs + journal）
   ├─ log\
   │  ├─ changes.ndjson          变更、拒绝、纠错、身份主张——一条流水账
   │  └─ modules\qq.ndjson       每个模块一个日志文件（核心代写：stderr + 关键事件）
   ├─ modules\                   已安装的模块（独立子进程，每模块一目录一版本；目前为空）
   │  └─ qq\1.2.0\
   ├─ modules.json               模块注册表：id / repo / version / api / enabled / permissions
   ├─ candidates\  index\  backups\  imports\  trash\   预留
   └─ （其余按需出现，核心不依赖）
```

**哪些能删**：`system/shields.json` 删了可以从 raw 重建；`system/modules.json` 删了重扫 `modules/` 就能还原；`personas/*/versions` 删了只是丢掉回滚能力；`media/index.ndjson` 删了能从 `media/` 与 raw 里的引用重建。
**不能删**：`raw/` 和 `media/`——删了就没有任何东西能证明事实从哪来、那句话长什么样。`raw/` 是文本的真相，`media/` 是二进制的真相。

**媒体的生命周期**（`media/` 唯一的清理规则）：

- **全留。** 不按年龄删、不按配额删——几十 G 的空间换"她记得的那张图还在"，值。
- **去重是自动的**：同内容同 hash 同路径，群里转发的重复文件不占第二份空间。
- **满一年移入 `media-archive/`**：同样的 hash 布局，位置变了但指针不变（核心按指针解析时两处都找）。
- **删不删由人决定**：`media-archive/` 是一个可以整体删掉的目录，删之前会先给你一份"多少文件、多大、最老到哪年"的清单。

---

## 模块

**核心只做四件事**：原始层、记忆层、人格层、规则与版本。对外的每一种能力——QQ、B站、桌宠、语音、视频——都是**模块**，各自独立仓库、独立进程。

| 约定 | 内容 |
|---|---|
| 命名 | `dsh-yuanling-<name>`（推荐，不强制；身份以 manifest 的 `id` 为准） |
| 形态 | 独立子进程 + stdio JSON-RPC，跨语言（Python 的语音/视频模型也能接） |
| 自描述 | 仓库根 `yuanling.module.json`：`id / api / kind / transport / capabilities / permissions` |
| 安装位置 | `system/modules/<id>/<version>/`，注册表 `system/modules.json` |
| 日志 | `system/log/modules/<id>.ndjson`，由核心代写（stderr + 关键事件） |

**四条硬边界**（模块再强也越不过去）：

1. 不能直接读 `raw/` —— 只能调 `ingest()`，落盘与脱敏由核心决定；
2. 不能直接写记忆 —— 只能提交候选事实，由核心决定入不入库；
3. 不能决定媒体存哪 —— 只能 `media.put()`，拿回一个内容寻址的指针；
4. **不能自己决定发什么** —— 发送由核心发起，模块只做投递；发送前核心执行 `rules/action` 与 `guardrails.never_do`。这是 `never_do` 唯一的执行点。

自带模块：`qq`（OneBot v11）、`bili`（只读采集），都会是独立仓库。

> 协议全文（消息格式、能力协商、错误码、trace 规则）会写成 `PROTOCOL.md`；在那之前，只有上面这些约定算数。

---

## 人物

她认识的人分两处存，因为这是两件事：

| 问题 | 存在哪 | 为什么 |
|---|---|---|
| **他是谁**（哪个 QQ、哪个 B站 号是同一个人；谁是管理员） | `system/identities.json` | 客观事实，跨人格共用；错一次全库错 |
| **她多在意他**（素描、权重、重要人物、第一次见面） | `personas/<p>/entities/people/<uid>.json` | 感情，本来就该因人而异 |

排序三档：**管理员 → 重要人物 → 其余按权重**，可切换成按时间。权重随聊天次数与活跃度自动上涨，也能手动覆写——覆写后 `weight_source` 变成 `manual`，自动计分不再覆盖它，界面上会标出来。

> 这套排序**只作用于管理台的列表**，不决定谁进上下文。上下文里出现谁，看的是"这一轮谁在场"。

管理台的人物页分三段：**管理员（1 格）→ 重要人物（拖进来即置顶，无上限）→ 其余**，右上角可切「按权重 / 按时间」。`admin` 存在 `system/identities.json`（客观、全库唯一、换人要显式卸任），`pinned` 存在人格档案（主观、你随时能拖出来）。

**权重的口径**：只算**和你 AI 的互动**——私聊里跟她说的话算，群里跟别人说的话不算（那是别人的社交，不是她与这个人的关系）。公式：`消息数×0.5 + 活跃天数×1.0 + 近30天消息数×0.3`，封顶 100，手动覆写优先。

身份描述用**自然语言**写（"QQ 号是 12345，b站叫老张"），**原文是正本、解析结果是派生**——以后加新平台只改解析器，不用改表结构，也不用让用户重填。解析出来的账号，**没被别人占用的自动绑上**；已被占用的只报冲突，绝不抢。

这段描述也可以由**模型自己写**：它在聊天和记忆里看到"我 b 站是 xxx"时，把整句写进描述，核心负责解析与绑定。允许它判错——解析视图和原文都留着，错了改描述、或者手工拆号就行。

角色不是人手工建卡的：**由模型在对话中观察到线索后调用工具建档、合并、修改**，每条变更都带证据指针。允许它判错，但错了能拆、能解释、反复错会被降级回候选。

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

`http://127.0.0.1:17777` —— 顶栏可切「核心 / 模块」与明暗主题；左侧竖菜单：状态 / **注入预览** / 记忆 / 条目 / 提案 / 人物 / 规则 / 用量 / 来源 / 拒绝记录。窄屏时侧栏收成图标条，不隐藏功能。

视觉骨架参考了一套 Figma 管理台：靠底色分层（浅色卡片浮在灰底上、暗色卡片浮在近黑底上）、20px 圆角、不做 1px 描边、只有主数字卡用高饱和渐变。图表的装饰一件没抄——没有真实时序数据，画假图比空着更糟。

第一次打开要粘贴 `system/secrets/console.token`（存本机 localStorage，只发给回环服务）。写操作都要 token，服务端不返回 CORS 头，别的网页发不进来。

**注入预览**是最有用的那一页：它显示"这一轮她到底读到了什么"。记忆系统最大的问题不是不记得，是**你以为它记得**。

「用量」页只报**能算准的东西**：每天真实的消息条数与字节、当前卡片体积、按字节换算的估算 token（±30%）。费用一栏明写"未接入"——模型侧的真实用量要宿主给，猜出来的数字比没有更糟。

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
