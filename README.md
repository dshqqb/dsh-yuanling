# 原灵 yuanling

DSH 的长期记忆与人格底座。

- **P0（已完成）**：数据目录骨架、root 四级解析、fail-closed 校验、多人格注册、体检。
- **P1（本版）**：L0 原始层 —— 日目录 / NDJSON / 双通道 inbox / 单写者 / `day.json` / 封存 / 32MB 分片 / 心跳。

设计文档：上一级目录 `yuanling_ds4.1f_0.1.0.md`。**代码与文档冲突时，以文档为准，然后改代码或改文档——不能两边都算数。**

## 装进 DSH

**它已经是 DSH 插件**：`index.js` 导出 `name / inject / Config / apply`，`package.json` 里有 `dsh.bundle.patch`，`cordis.patch.yml` 负责把自己挂进 profile。`src/core/**` 是插件调用的库，`bin/` 是同一套库的运维入口——不是两个程序。

```powershell
# 开发期：从本地目录装（profile 用你实际的，例如 desktop / web / tui）
dsh plugin --profile <profile> add "D:\path\to\yuanling"
```

三种装法，按"确定能成"排序：

| 方式 | 命令 | 前提 |
|---|---|---|
| **本地目录**（最稳） | `git clone https://github.com/dshqqb/dsh-yuanling.git D:\dsh-plugins\dsh-yuanling`<br>`dsh plugin --profile <p> add "D:\dsh-plugins\dsh-yuanling"` | 只需要 git |
| **tarball** | `add "D:\path\dsh-yuanling-0.1.0.tgz"` | 从 Release 下载，或本地 `npm pack` |
| **npm 包名** | `dsh plugin --profile <p> add dsh-yuanling` | 需要先 `npm publish` |
| **git URL** | `add https://github.com/dshqqb/dsh-yuanling` | **取决于 `dsh plugin add` 是否把参数转给 npm**，未验证 |

装完**必须重启 DSH**：插件在启动时加载，没有热加载。

一句话安装（在对话框里说"装这个插件"）能不能成，取决于三件宿主侧的事：agent 有没有 shell 权限、`add` 认不认远程地址、谁来重启。**仓库这边只能做到"装得上"，做不到"自己装自己"。**

装完重启 DSH，设置页会出现这些项（宿主按 schema 渲染，插件没有自己的设置界面代码）：

| 配置 | 默认 | 说明 |
|---|---|---|
| `enabled` | true | 总开关 |
| `dataDir` | 空 → `~/.dsh/yuanling` | 数据目录；默认路径首次运行会自动建骨架 |
| `consoleEnabled` | true | 是否启动管理台 |
| `consoleHost` | `127.0.0.1` | 只允许回环；改非回环必须同时开 `allowRemote` |
| `consolePort` | 17777 | 0 = 随机 |
| `allowRemote` | false | 打开前想清楚：这是你的私人记忆 |
| `preset` | true | 是否注册 agent preset |
| `autoApproveDays` | 3 | 提案无人理会几天后自动批准 |
| `dailyAutoLimit` | 1 | 每天最多自动采纳几条 |
| `logLevel` | info | debug / info / warn / error |

## 快速开始（CLI）

```powershell
# 建数据目录（默认 ~/.dsh/yuanling，可用 --root 指到 D 盘）
node bin/yuanling.js init --root D:\yuanling

node bin/yuanling.js status  --root D:\yuanling
node bin/yuanling.js doctor  --root D:\yuanling
node bin/yuanling.js verify  --root D:\yuanling

# 人格
node bin/yuanling.js persona list   --root D:\yuanling
node bin/yuanling.js persona new ling2 --name 灵二 --from yuanling --root D:\yuanling
node bin/yuanling.js persona switch ling2 --root D:\yuanling

# 原始层
node bin/yuanling.js drain            # 消费 system/inbox/ 的投递
node bin/yuanling.js seal             # 封存昨天（--date 指定具体日期）
node bin/yuanling.js health           # 各来源心跳 / 沉默
node bin/yuanling.js serve            # 回环 HTTP：POST /inbox
```

## 怎么把数据喂进来

**方式一：写文件（跨进程最稳）**

投递到 `system/inbox/<任意名>.ndjson`，一行一个信封：

```json
{"v":1,"source":"qq","acct":"10001","items":[
  {"ts":"2026-11-05T14:32:10+08:00","channel":"group:123",
   "actor":{"kind":"member","id":"20002","name":"张三"},
   "role":"user","kind":"msg","text":"今天备份脚本跑到一半断了"}
]}
```

然后 `yuanling drain`（或让宿主定期 drain）。

**方式二：HTTP（低延迟）**

```powershell
$token = Get-Content D:\yuanling\system\secrets\console.token
Invoke-RestMethod -Method Post -Uri http://127.0.0.1:17777/inbox `
  -Headers @{ 'x-yuanling-token' = $token } -ContentType 'application/json' -Body $json
```

## 目录契约

```
<root>/
├── yuanling.json        根标记（format / personas / active）
├── guardrails.json      硬线          ← 人改的
├── rules/ingest.json    入库规则
├── 第一条.md             引导
├── raw/YYYY-MM/DD/<source>.ndjson + day.json
├── raw-archive/  media/
├── personas/<id>/                     ← 每个人格的全部私有内容
├── system/                            ← 机器自己管的
└── web/
```

## 五条不可动的规矩

1. **目录不存在时绝不自动创建**（除默认路径的首次运行）。外置盘没插就建空目录，会让人以为记忆全丢了。
2. **`init` 只补缺失，不覆盖已有文件。**
3. **raw 只追加。** 没有 update / delete；"删掉"是追加一条 `redact`，再在派生层屏蔽。
4. **体检的 `skip` 必须带 `reason`。** 静默跳过 = 那一格永远绿。
5. **超长单行 256KB 截断，并留痕**（`flags:["truncated"]` + 原长）。

## 实现与文档的两处已知差异

| 项 | 文档 | 实现 | 处理 |
|---|---|---|---|
| `h` 的算法 | 示例写 `sha1:…` | 用 `sha256:…` | 下一版文档更正；只是幂等键，不影响契约 |
| 分片阈值 | 32MB | 32MB（可传参覆盖，测试用） | 一致 |

## 版本与审计（P2）

写记忆之前先有"能退回去"的能力。两套版本库，跟着各自的迁移单元走：

```
system/versions/                    根级文件（yuanling.json / guardrails.json / rules/ingest.json）
personas/<id>/versions/             该人格的全部文件（拷走人格时历史一起走）
  ├── blobs/<ab>/<sha256>           内容寻址：同一内容只存一份
  └── journal.ndjson                每写一次一行（带 prev 链、actor、reason）
```

```powershell
yuanling versions                   版本库统计
yuanling history guardrails.json    看历史
yuanling track   personas/yuanling/persona/SELF.md   把当前内容记一笔
yuanling revert  guardrails.json --to 2026-11-06    回滚（hash 或时间戳前缀）
yuanling scan                       检测插件外的修改（记事本改过也能抓到）
```

**回滚也是新版本**——后来的历史不会被擦掉。这条很重要：一次"退回去"本身也需要能被追溯。

`scan` 让"记事本改文件"从隐患变成特性：改完自动进历史，并标成 `human:editor`。

## 记忆层（P3）

```powershell
# 先造一条原始记录，拿到指针
#   raw/2026-11/06/qq.ndjson#01JCV8K3M2QH7X9ABCDEFGH

yuanling memory save --topic 备份 --text "备份脚本的定时任务被宿主收走了" `
  --src "raw/2026-11/06/qq.ndjson#01JCV8K3M2QH7X9ABCDEFGH" --slot 备份方案 --imp 80

yuanling memory recall 备份        # 按词命中，带指针
yuanling memory recall npm --all   # --all 才看已失效的旧值
yuanling memory open 备份          # 全文：active + 曾经
yuanling memory list
yuanling card                      # 本轮会注入的卡片（800 字节预算）
```

**硬规则**：没有 `@src` 的事实不写；`@src` 指不到真实记录也不写。查重三档（完全相同 / 包含 ≥0.45 / 二元组 Jaccard ≥0.78）在写入时生效。

条目与人物档案用 **JSON**（机器写机器读的结构化数据）；人设骨架仍是 Markdown（人写的散文）。这是对文档 v0.1.0 的一处有意偏差，下版文档更正。

## 墓碑（P4）

"删掉刚才那条"在这里不是删除，是**追加一条屏蔽**，再在所有出口隔离。

```powershell
yuanling shield --last 1                 # 先预览（默认不执行）
yuanling shield --last 3 --yes           # 确认后执行
yuanling shield list                     # 谁被屏蔽过、为什么、是否已撤销
yuanling unshield <id>                   # 撤销（误删比删不掉更常见）
yuanling shield rebuild                  # 登记簿丢了，从 raw 重建
yuanling memory why <factId>             # 这条凭什么存在：指针 + 变更史
```

**三条规矩**：

1. **raw 一个字节不动。** 屏蔽只是往当天 `system.ndjson` 追加一条 `redact` 事件。
2. **全局生效。** raw 是共享的，所以级联隔离会跨所有人格——A 人格屏蔽的，B 人格也看不到。
3. **可撤销。** `unredact` 是对称事件；登记簿 `system/shields.json` 只是索引，真相在 raw 里，随时可重建。

## 三条记忆带（P5）

卡片不再按单一分数排序，而是**三条带各自排序、按配额混装**：

| 带 | 判定 | 衰减 | 配额 |
|---|---|---|---|
| 最初 | 条目最早两条事实里，按 id 确定性抽签（0–10 天 90% → 递减） | **不衰减** | 2 行 |
| 最深刻 | `imp ≥ 80` 或 `emotional ≥ 20`，且被召回 ≥ 3 次 | 半衰期长（k=0.12） | 3 行 |
| 最新 | 14 天内发生 | 半衰期短（k=0.35） | 5 行 |

**为什么配额而不是加权**：新事的 `lastSeenAt` 永远是今天。只按分数排，「最初」必然饿死——而人格连续性恰恰靠那几条不被挤掉。

**裁剪顺序固定**：先砍「最新」，再砍「最深刻」，**永不动「最初」**。

`retention = imp + min(12, recall×2) + 近期加成(18/8) − 时间惩罚`。
召回次数记在 `state/access.ndjson`（只追加），**读路径不产生写放大**——不为了记一次"看过"去重写整个条目文件。

## 实体档案（P6）

```powershell
yuanling person new 张三 --platform qq --id 12345
yuanling person link person_xxx --platform bili --id 998877
yuanling person candidates            # 疑似同一人（只提，不自动并）
yuanling person confirm 0
yuanling person merge person_b person_a
yuanling person split person_a --platform bili --id 998877
yuanling person profile person_a --sketch "说话短，爱用草"
yuanling group set 123456 --name "XX 游戏群" --intro "折腾 mod 的人"
yuanling catchup                      # 切入补跑（单次 ≤200）
```

**客观 / 主观分家**：`system/identities.json` 存"哪个号是同一个人"（跨人格共用）；`personas/<p>/entities/` 存"这个角色认识的 TA"（按人格隔离）。合并/拆分只改映射，各人格的记忆文件零改动。

**关于某人的第一条事实自动进「最初」带**——比"某个主题的第一条"更有意义。之后的事实不会重复算最初。

**按对象注入**：`contextFor(channel)` 在卡片后面追加 `[这个人]` 或 `[这个群]` 一行。人格不变，变的是"这一轮想起谁"。

## 规则层（P7）

```powershell
yuanling rule show [--channel group:123]     # 合并后的有效规则 + 来源链
yuanling rule check proactive --channel group:123
yuanling rule guardrails                     # 根级硬线
yuanling rule refusals                       # 最近的拒绝记录
```

**三级继承**：`private-<uid>` 30 > `qq/group-<gid>` 20 > `global` 10；`guardrails.json` 是 ∞，不参与合并、单独硬拦。

| 维度 | 管什么 | 生效范围 |
|---|---|---|
| `ingest` | 写不写 raw | **全局**（raw 共享，只能有一个答案） |
| `recall` | 给不给、给多少 | 人格 |
| `action` | 动不动、何时动 | 人格 |
| `persona` | 准不准演化 | 人格 |

**合并规则**：普通字段深合并（数组整体替换）；`deny`/`allow` **取并集**——下层不许悄悄放宽上层；要放宽 `deny` 必须显式 `override_deny: true`，且只放开本层 `allow` 里写明的那条。

**每次拒绝都留痕**（`system/log/changes.ndjson` 的 `rule_refusal`）。否则"她为什么没回我"永远查不出来。

## 管理台（P8）

```powershell
yuanling serve --port 17777
# 打开 http://127.0.0.1:17777
```

第一次打开会让你粘贴 `system/secrets/console.token` 的内容——令牌存本机 localStorage，只发给回环服务，不进 URL、不上传。

页面：状态 / **注入预览** / 记忆搜索 / 条目 / 规则 / 来源健康 / 拒绝记录。

**注入预览**是这一版最值钱的东西：它直接显示"这一轮她要读到的 800 字节原文"。记忆系统最大的问题不是不记得，是**你以为它记得**——能看见就能调。

API 是只读的（`/api/status|card|memory|entries|entry|rules|sources|refusals`），写操作仍走 CLI，避免在 UI 里误点一下就改了记忆。

## 身份主张（P9）

身份不是配置项，是**带证据的主张**——所以它进记忆层，不进规则层。

```powershell
# 有人告诉你他的号（owner 私聊自述 → 直接确认）
yuanling identity claim --platform bili --id abc123 --channel private:10001 `
  --src "raw/2026-11/06/qq.ndjson#01JCV..." --text "我的b站是 abc123"

# 别人转述 / 群聊自述 → 只进候选，不自动合并
yuanling identity claim --platform bili --id zzz999 --speaker member ... 

# 从 raw 推断跨平台同名（只看，不写）
yuanling identity infer
yuanling identity infer --apply     # 写入候选，仍然不合并

# 发现绑错了：拆出去，并关闭旧主张（不删）
yuanling identity correct person_xxx --platform bili --id abc123 --reason "本人说那不是他的号"
```

**三条保守规则**：

1. **只有 owner 私聊里的自述自动确认**——群聊里说"这是我小号"可能是冒充；
2. **推断只提候选**，永不自动合并（合并错了拆起来很痛）；
3. **纠错走 split + 关闭旧主张**：旧主张补 `until` 不删——"当时确实这么说过"也是事实。

**为什么"谁不喜欢被问家里的事"不在规则里**：那是关于人的判断，会淡、会错、会变，所以它是一条普通事实（`person=<uid>`、`slot=禁忌`、带 `src`），自动继承槽位覆盖、屏蔽、衰减。**规则层只放机器可执行的策略**（能不能说话、给不给、准不准演化），少而可审计。

## 演化提案（P10）

**设计前提**：记忆与人格共同塑造灵魂，记忆在潜移默化地改变人格；规则只限定权限，不塑造人格。
所以演化只有一条路——**重复的主张 → 提案 → 人批准 → 改表达层 → 7 天可回滚**；人不理会，到期自动批准（除非被否决）。

```powershell
yuanling proposal scan              # 把"反复出现"的主张变成提案
yuanling proposal list              # 待定 + 已生效
yuanling proposal show <id>         # 看依据与将要追加的那一行
yuanling proposal approve <id>      # 采纳（写进 style.md）
yuanling proposal reject <id>       # 否决（永不自动批准）
yuanling proposal rollback <id>     # 7 天内退回
yuanling proposal sweep             # 到期自动批准（受每周上限约束）
```

**为什么查重要改成"记次数"**：如果重复的话被查重直接吞掉，"反复出现"这个信号就消失了。所以现在重复不新增事实，但 `repeat +1`、追加一条证据、刷新 `last_seen`——这既是演化的燃料，也是"她为什么这么想"的依据。

**阈值**：重复 ≥5 次、跨度 ≥3 天、且不与硬线冲突。**到期 3 天自动批准，每天最多 1 条**——两个旋钮都在 DSH 设置页（`autoApproveDays` / `dailyAutoLimit`），改完立刻对已有提案生效（到期时间按当前设置现算，不用等下一轮重新生成）。

**只改表达层**：提案只往 `style.md` 追加一行，`SELF.md` 的骨架永不自动改——她可以长大，不能变成另一个人。

## 测试

```powershell
cd yuanling
node --test
```

- `test/p0.test.mjs`：22 个（目录 / 校验 / 人格 / 完整性）
- `test/p1.test.mjs`：16 个（追加 / 去重 / 分片 / 封存 / 链 / 脱敏 / 投递 / 心跳 / HTTP）
- `test/p2.test.mjs`：12 个（blob / prev 链 / 幂等 / 回滚 / 外部编辑 / 作用域）
- `test/p3.test.mjs`：21 个（指针 / 写入 / 查重 / 槽位 / 检索 / 卡片 / 裁剪）
- `test/p4.test.mjs`：13 个（屏蔽 / 级联 / 跨人格 / 撤销 / 重建 / why）
- `test/p5.test.mjs`：22 个（衰减 / 清晰度 / 三带 / 抽签 / 召回计数 / 卡片裁剪）
- `test/p6.test.mjs`：17 个（身份映射 / 合并拆分 / 候选 / 档案隔离 / 按对象注入 / 补跑）
- `test/p7.test.mjs`：16 个（继承 / deny 并集 / override / 静默时段 / 入库硬线 / 留痕）
- `test/p8.test.mjs`：10 个（静态页 / Token 门 / 只读 API / 目录穿越）
- `test/p9.test.mjs`：14 个（主张抽取 / 自述确认 / 转述候选 / 推断 / 纠错）
- `test/p10.test.mjs`：19 个（重复计数 / 提案 / 批准 / 否决 / 自动到期 / 每日配额 / 回滚）

当前：**182 个全绿**。

## 首次推送到 GitHub

```powershell
cd yuanling
git init
git add .
git status --short          # 自查：不该出现 *.ndjson / *.token / raw/ / personas/ / system/
git commit -m "P2: 版本与审计"
git branch -M main
git remote add origin https://github.com/<你的用户名>/dsh-yuanling.git
git push -u origin main
```

`package.json` 里的 `repository` 字段**故意留空**——等你建好仓再补，避免写死一个错误的地址。

## 已实现 / 未实现

| 模块 | 状态 |
|---|---|
| root 四级解析 + 校验 | ✅ |
| `init` 骨架 + 令牌 | ✅ |
| 人格注册表 | ✅ |
| `doctor` 基础检查 | ✅ |
| raw 追加 / 去重 / 分片 / 封存 / 链校验 | ✅ |
| 三档黑名单 + 硬脱敏 | ✅ |
| inbox 文件 + HTTP 双通道 + 心跳 | ✅ |
| 版本：blob / journal / 回滚 / 外部编辑检测 | ✅ |
| 记忆：条目 / 事实 / 指针校验 / 查重 / 槽位 | ✅ |
| 记忆：检索 / 卡片（800 字节） | ✅ |
| 墓碑：屏蔽 / 级联隔离 / 撤销 / 重建 / why | ✅ |
| 三带 / 衰减 / 清晰度 / 召回计数 / 卡片配额 | ✅ |
| 实体档案 / 身份合并 / 按对象注入 / 切入补跑 | ✅ |
| 规则层：三级继承 / deny 优先 / 静默时段 / 拒绝留痕 | ✅ |
| 管理台：静态页 + 只读 API + 注入预览 | ✅ |
| 身份主张：自述确认 / 转述候选 / 推断 / 纠错 | ✅ |
| 演化提案：重复 → 提案 → 批准 / 否决 / 自动 / 回滚 | ✅ |
| 管理台写操作（屏蔽/回滚/编辑） | ⬜ 后续 |
| QQ / B站 适配器 | ⬜ P3.5 / P12 |
