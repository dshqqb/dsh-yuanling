# 原灵 yuanling

DSH 的长期记忆与人格底座。

- **P0（已完成）**：数据目录骨架、root 四级解析、fail-closed 校验、多人格注册、体检。
- **P1（本版）**：L0 原始层 —— 日目录 / NDJSON / 双通道 inbox / 单写者 / `day.json` / 封存 / 32MB 分片 / 心跳。

设计文档：上一级目录 `yuanling_ds4.1f_0.1.0.md`。**代码与文档冲突时，以文档为准，然后改代码或改文档——不能两边都算数。**

## 快速开始

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

当前：**84 个全绿**。

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
| 管理台 UI | ⬜ P8 |
| QQ / B站 适配器 | ⬜ P3.5 / P12 |
