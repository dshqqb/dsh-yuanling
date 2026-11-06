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

## 测试

```powershell
cd yuanling
node --test
```

- `test/p0.test.mjs`：22 个（目录 / 校验 / 人格 / 完整性）
- `test/p1.test.mjs`：16 个（追加 / 去重 / 分片 / 封存 / 链 / 脱敏 / 投递 / 心跳 / HTTP）

当前：**38 个全绿**。

## 首次推送到 GitHub

```powershell
cd yuanling
git init
git add .
git status --short          # 自查：不该出现 *.ndjson / *.token / raw/ / personas/ / system/
git commit -m "P1: 原始层与双通道 inbox"
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
| 墓碑（redact） | 数据结构已定，写入接口 P4 |
| 记忆层 / 检索 / 卡片 | ⬜ P3 |
| 管理台 UI | ⬜ P8 |
| QQ / B站 适配器 | ⬜ P3.5 / P12 |
