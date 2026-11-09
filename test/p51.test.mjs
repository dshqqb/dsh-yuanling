// test/p51.test.mjs —— 人格卡（框架 / 人格 / 模块 三分的第一个落点）。
//
// 验三件事：
//   ① mdtext 的切节与原位拼回：**没改的段落字节必须一个不动**（否则版本历史全是假 diff）；
//   ② personacard 的写路径：带版本、带 actor=human、expect 对不上就拒绝；
//   ③ 新接口：/api/persona（读卡）、save / rename / create / switch、/api/motive。
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { scaffold } from '../src/core/scaffold.js'
import { personaPaths } from '../src/core/paths.js'
import { readToken, listen } from '../src/core/server.js'
import { parseMd, applySectionEdits, replaceTitle } from '../src/core/mdtext.js'
import { readCard, saveCardFile, saveCardFiles, renameCard, seedCard } from '../src/core/personacard.js'
import { contextFor } from '../src/core/memory.js'
import { createPersona } from '../src/core/persona.js'
import { createPerson, linkIdentity, writeProfile } from '../src/core/entities.js'
import { readPurposes, writePurposes } from '../src/core/purposes.js'
import { appendRecord, listScenes } from '../src/core/raw.js'
import { localIso } from '../src/core/fsx.js'
import { history } from '../src/core/version.js'
import { textSha256 } from '../src/core/fsx.js'

const PID = 'yuanling'
let root
let server
let url
let token

const SAMPLE = `# 原灵 · 骨架

> 这一页是「我是谁」。只有人能动它。

## 核心身份

- 名字：原灵
- 存在的原因：陪一个人把话说清楚

## 说话方式

- 语气：短句
- 口癖：偶尔「嗯」

## 演化区

- 最近在意的事：<留空，让她自己长>
`

function post(pathname, body) {
  return fetch(`${url}${pathname}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-yuanling-token': token },
    body: JSON.stringify(body ?? {}),
  })
}

async function get(pathname) {
  return (await fetch(`${url}${pathname}`, { headers: { 'x-yuanling-token': token } })).json()
}

before(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'yuanling-p51-'))
  scaffold(root, {})

  // 换成一份结构完整的骨架：模板里的值都是 `<占位符>`，那样 identityLines 什么都不抽
  fs.writeFileSync(path.join(root, personaPaths(PID).self), SAMPLE, 'utf8')

  token = readToken(root)
  const started = await listen(root, { port: 0 })
  server = started.server
  url = started.url
})

after(async () => {
  await new Promise((res) => server.close(res))
})

// ── mdtext ────────────────────────────────────────────────────────────

test('parseMd：切出标题、引言与三个小节', () => {
  const p = parseMd(SAMPLE)
  assert.equal(p.title, '原灵 · 骨架')
  assert.match(p.preamble, /这一页是「我是谁」/)
  assert.deepEqual(
    p.sections.map((s) => s.title),
    ['核心身份', '说话方式', '演化区'],
  )
  assert.equal(p.hasSections, true)
  // 每节的 body 都要能原位还原：用区间切出来的必须等于记录下来的 body
  for (const s of p.sections) assert.equal(SAMPLE.slice(s.start, s.end), s.body)
})

test('parseMd：没有 ## 小节的文件就是"整篇"', () => {
  const p = parseMd('# 硬线\n\n- 不伪造记忆\n')
  assert.equal(p.hasSections, false)
  assert.equal(p.title, '硬线')
})

test('applySectionEdits：只改一节时，其余字节一个不动', () => {
  const p = parseMd(SAMPLE)
  const r = applySectionEdits(p, [{ title: '说话方式', body: '- 语气：更短\n- 口癖：偶尔「行」' }])
  assert.equal(r.ok, true)
  assert.equal(r.changed, 1)
  // 演化区往后一字不差
  assert.ok(r.text.endsWith('## 演化区\n\n- 最近在意的事：<留空，让她自己长>\n'))
  // 标题与引言也不动
  assert.ok(r.text.startsWith('# 原灵 · 骨架\n\n> 这一页是「我是谁」。只有人能动它。\n'))
  assert.match(r.text, /## 说话方式\n\n- 语气：更短\n- 口癖：偶尔「行」/)
})

test('applySectionEdits：小节之间保持一个空行（不因为 trim 越过越紧）', () => {
  const p = parseMd(SAMPLE)
  // 文本域会交出 trim 过的值，这里模拟那种情况
  const r = applySectionEdits(p, [{ title: '核心身份', body: '- 名字：原灵' }])
  assert.equal(r.ok, true)
  assert.match(r.text, /- 名字：原灵\n\n## 说话方式/)
})

test('applySectionEdits：内容没变就一句都不改', () => {
  const p = parseMd(SAMPLE)
  const same = p.sections.map((s) => ({ title: s.title, body: s.body }))
  const r = applySectionEdits(p, same)
  assert.equal(r.ok, true)
  assert.equal(r.changed, 0)
  assert.equal(r.text, SAMPLE)
})

test('applySectionEdits：标题对不上时明确报错，不默默跳过', () => {
  const p = parseMd(SAMPLE)
  const r = applySectionEdits(p, [{ title: '不存在的节', body: 'x' }])
  assert.equal(r.ok, false)
  assert.match(r.error, /找不到小节/)
})

test('replaceTitle：换名字但保住「· 骨架」后缀', () => {
  const r = replaceTitle(parseMd(SAMPLE), '小语')
  assert.equal(r.ok, true)
  assert.match(r.text, /^# 小语 · 骨架\n/)
})

// ── readCard / saveCardFile ───────────────────────────────────────────

test('readCard：三份底稿都在，且全部可编辑（user.md 已废弃）', () => {
  const { card, personas } = readCard(root, PID)
  assert.equal(personas.length, 1)
  assert.equal(personas[0].active, true)
  const byKey = Object.fromEntries(card.files.map((f) => [f.key, f]))
  assert.deepEqual(Object.keys(byKey).sort(), ['lines', 'self', 'style'])
  assert.equal(byKey.self.injected, true)
  // Q2=A：硬线与表达层接进注入了
  assert.equal(byKey.lines.injected, true)
  assert.equal(byKey.style.injected, true)
})

test('readCard：注入实测和真注入同源（[骨架] 里有名字）', () => {
  const { card } = readCard(root, PID)
  assert.ok(card.injected.length >= 1)
  assert.match(card.injected[0], /^\[骨架\]/)
  assert.match(card.injected[0], /原灵/)
})

test('注入：硬线进 [硬线]、表达层进 [习惯]', () => {
  // 表达层平时由提案写入；这里手写一条，等于模拟"提案采纳之后她真的读得到"
  fs.writeFileSync(path.join(root, personaPaths(PID).style), '# 表达层\n\n- 不用颜文字\n', 'utf8')

  const ctx = contextFor(root, PID, { channel: 'private:10001', preview: true })
  assert.match(ctx, /\[硬线\] /)
  assert.match(ctx, /\[习惯\] 不用颜文字/)
  // 硬线是"绝对不做"，必须排在记忆前面（记忆先被裁，硬线不该被挤掉）
  assert.ok(ctx.indexOf('[硬线]') < ctx.indexOf('[索引]'))
})

test('注入：硬线按整条装，不在句子中间截断', () => {
  const ctx = contextFor(root, PID, { preview: true })
  const line = ctx.split('\n').find((l) => l.startsWith('[硬线] '))
  assert.ok(line)
  // 200 字节装不下四条，那就装三条，末条必须是完整的
  assert.match(line, /不泄露凭据.*一律不进记忆$/)
})

test('注入：硬线永不因为超预算被裁掉', () => {
  // 预算压到很小：最新/最深刻/习惯都会被裁，硬线必须留着
  const ctx = contextFor(root, PID, { budget: 300, preview: true })
  assert.match(ctx, /\[硬线\] /)
})

test('readCard：每节带自己的预算，超出预算的节看得出来', () => {
  const { card } = readCard(root, PID)
  const self = card.files.find((f) => f.key === 'self')
  const core = self.sections.find((s) => s.title === '核心身份')
  assert.equal(core.injected, true)
  assert.equal(core.budget, card.budgets.core)
  const evo = self.sections.find((s) => s.title === '演化区')
  assert.equal(evo.injected, false)
})

// 真数据的坑：真 SELF.md 里那一节叫「价值观（按优先级）」，注入是用前缀匹配认它的。
// 页面上如果按全名匹配，就会把一段**真的进上下文**的节标成"不进"——那是最坏的一种错。
test('readCard：小节名带后缀（价值观（按优先级））也算进上下文', () => {
  createPersona(root, 'prefixed', '带后缀')
  fs.writeFileSync(
    path.join(root, personaPaths('prefixed').self),
    '# 带后缀 · 骨架\n\n## 价值观（按优先级）\n\n1. 不编造\n',
    'utf8',
  )
  const { card } = readCard(root, 'prefixed')
  const sec = card.files.find((f) => f.key === 'self').sections[0]
  assert.equal(sec.title, '价值观（按优先级）')
  assert.equal(sec.injected, true)
  assert.equal(sec.budget, card.budgets.values)
})

test('saveCardFile：写盘 + 进版本历史 + actor 是人', () => {
  const { card } = readCard(root, PID)
  const self = card.files.find((f) => f.key === 'self')
  const r = saveCardFile(root, PID, {
    file: 'self',
    sections: self.sections.map((s) => (s.title === '核心身份' ? { ...s, body: '- 名字：原灵\n- 存在的原因：把话记住' } : s)),
    expect: self.expect,
  })
  assert.equal(r.changed, true)

  const h = history(root, personaPaths(PID).self)
  assert.ok(h.length >= 1)
  assert.equal(h[h.length - 1].actor, 'human:editor')
  assert.match(h[h.length - 1].reason, /人格底稿/)

  const after = fs.readFileSync(path.join(root, personaPaths(PID).self), 'utf8')
  assert.match(after, /存在的原因：把话记住/)
})

test('saveCardFile：expect 对不上就拒绝（409 的来源）', () => {
  assert.throws(
    () => saveCardFile(root, PID, { file: 'self', text: 'x', expect: textSha256('别的东西') }),
    (err) => err.code === 'E_STALE',
  )
})

test('saveCardFile：不认识的文件名直接拒，不猜', () => {
  assert.throws(() => saveCardFile(root, PID, { file: 'core', text: '{}' }), /不认识的文件/)
})

test('saveCardFile：不进上下文的文件不给编辑入口', () => {
  // user.md 已经整个废弃（不再是卡上的一员），但仍然不许从这个入口被写
  assert.throws(() => saveCardFile(root, PID, { file: 'user', text: 'x' }), /不认识的文件/)
})

test('saveCardFiles：一份指纹过期，整批都不写（不留半截状态）', () => {
  const card = readCard(root, PID).card
  const self = card.files.find((f) => f.key === 'self')
  const lines = card.files.find((f) => f.key === 'lines')
  const beforeLines = fs.readFileSync(path.join(root, lines.path), 'utf8')

  assert.throws(
    () =>
      saveCardFiles(root, PID, [
        { file: 'self', sections: self.sections.map((s) => ({ title: s.title, body: s.body })), expect: self.expect },
        { file: 'lines', text: '被污染的内容\n', expect: 'sha256:deadbeef' },
      ]),
    (err) => err.code === 'E_STALE',
  )
  // 第二份没写进去
  assert.equal(fs.readFileSync(path.join(root, lines.path), 'utf8'), beforeLines)
})

test('saveCardFiles：正常一批就都写进去，并逐份回执', () => {
  const card = readCard(root, PID).card
  const self = card.files.find((f) => f.key === 'self')
  const lines = card.files.find((f) => f.key === 'lines')
  const r = saveCardFiles(root, PID, [
    {
      file: 'self',
      sections: self.sections.map((s) => (s.title === '演化区' ? { ...s, body: '- 最近在意的事：把话说短' } : s)),
      expect: self.expect,
    },
    { file: 'lines', text: `${lines.text.trimEnd()}\n- 不替人做重大决定\n`, expect: lines.expect },
  ])
  assert.equal(r.changed, 2)
  assert.deepEqual(r.files.map((x) => x.file).sort(), ['lines', 'self'])
  assert.match(fs.readFileSync(path.join(root, lines.path), 'utf8'), /不替人做重大决定/)
})

test('seedCard：新建人格时填的那几项落进骨架，空字段不覆盖模板', () => {
  createPersona(root, 'seeded', '播种')
  seedCard(root, 'seeded', { reason: '帮人把事记下来', tone: '短句', values: ['不编造', '先问再做'] })
  const text = fs.readFileSync(path.join(root, personaPaths('seeded').self), 'utf8')
  assert.match(text, /存在的原因：帮人把事记下来/)
  assert.match(text, /说话方式\n\n- 语气：短句/)
  assert.match(text, /1\. 不编造\n2\. 先问再做/)
  // 没给的字段保持模板原样
  assert.match(text, /口癖：<例：偶尔说/)
})

test('renameCard：三处一起改（persona.json / 根标记 / 骨架标题）', () => {
  const r = renameCard(root, PID, '小语')
  assert.ok(r.changed.includes(personaPaths(PID).manifest))
  const manifest = JSON.parse(fs.readFileSync(path.join(root, personaPaths(PID).manifest), 'utf8'))
  assert.equal(manifest.name, '小语')
  const marker = JSON.parse(fs.readFileSync(path.join(root, 'yuanling.json'), 'utf8'))
  assert.equal(marker.personas[0].name, '小语')
  const self = fs.readFileSync(path.join(root, personaPaths(PID).self), 'utf8')
  assert.match(self, /^# 小语 · 骨架\n/)
  // 改回来，后面的接口测试还指望它叫原灵
  renameCard(root, PID, '原灵')
})

// ── 接口 ──────────────────────────────────────────────────────────────

test('GET /api/persona：给清单也给卡', async () => {
  const d = await get('/api/persona')
  assert.equal(d.ok, true)
  assert.equal(d.active, PID)
  assert.equal(d.card.id, PID)
  assert.ok(d.card.files.length === 3)
})

test('POST /api/persona/save：保存后读回来是新内容', async () => {
  const card = (await get('/api/persona')).card
  const self = card.files.find((f) => f.key === 'self')
  const res = await post('/api/persona/save', {
    file: 'self',
    sections: self.sections.map((s) => (s.title === '说话方式' ? { ...s, body: '- 语气：短句，先结论后理由' } : s)),
    expect: self.expect,
  })
  assert.equal(res.status, 200)
  const body = await res.json()
  assert.equal(body.ok, true)
  assert.equal(body.card.files.find((f) => f.key === 'self').sections.find((s) => s.title === '说话方式').body, '- 语气：短句，先结论后理由')
})

test('POST /api/persona/save：过期指纹 → 409，并说清原因', async () => {
  const res = await post('/api/persona/save', { file: 'self', text: 'x', expect: 'sha256:deadbeef' })
  assert.equal(res.status, 409)
  const body = await res.json()
  assert.match(body.error, /被改过/)
})

test('POST /api/persona/create：在 personas 下开新目录，且默认是空白模板', async () => {
  const res = await post('/api/persona/create', {
    id: 'xiaoyu',
    name: '小语',
    card: { reason: '陪人说话', tone: '短句，先结论后理由', values: ['不谄媚'] },
  })
  assert.equal(res.status, 200)
  const body = await res.json()
  assert.equal(body.id, 'xiaoyu')
  assert.ok(fs.existsSync(path.join(root, 'personas', 'xiaoyu', 'persona', 'SELF.md')))
  // 弹窗里填的内容写进骨架（空白模板满是 <占位符>，不填就一句也读不到）
  const self = fs.readFileSync(path.join(root, 'personas', 'xiaoyu', 'persona', 'SELF.md'), 'utf8')
  assert.match(self, /^# 小语 · 骨架/)
  assert.match(self, /存在的原因：陪人说话/)
  assert.match(self, /1\. 不谄媚/)
})

test('POST /api/persona/create：id 非法时报错，不建目录', async () => {
  const res = await post('/api/persona/create', { id: '坏 id', name: 'x' })
  assert.equal(res.status, 400)
  assert.ok(!fs.existsSync(path.join(root, 'personas', '坏 id')))
})

test('POST /api/persona/switch：切过去之后 /api/persona 认的是新人格', async () => {
  const res = await post('/api/persona/switch', { id: 'xiaoyu' })
  assert.equal(res.status, 200)
  const body = await res.json()
  assert.equal(body.active, 'xiaoyu')
  assert.equal(body.card.id, 'xiaoyu')

  const d = await get('/api/persona')
  assert.equal(d.active, 'xiaoyu')
  assert.equal(d.card.name, '小语')
  // 换回来，别影响后面的用例
  await post('/api/persona/switch', { id: PID })
})

// 预览是照镜子，不是照做：多次打开管理台不该把一件事"摆"成她不想提的。
test('GET /api/card：连着看两次预览，账本一个字节都不动', async () => {
  const old = new Date(Date.now() - 8 * 3_600_000).toISOString()
  writePurposes(root, PID, {
    version: 1,
    items: [
      { id: 'pur_preview', need: 'care', text: '你上次说的事，后来怎么样了？', status: 'open', created: old, due: old, hits: 0, offered: 0 },
    ],
  })

  const first = await get('/api/card')
  const second = await get('/api/card')
  // 预览得看得见这条，否则"不改状态"就成了"什么都不算"的借口
  assert.match(first.text, /\[惦记\]/)
  assert.equal(first.text, second.text)

  const after = readPurposes(root, PID)
  assert.equal(after.items[0].offered, 0, '预览不该记 offered')
  assert.equal(after.items[0].hits, 0)
  assert.equal(after.items[0].status, 'open')
})

// 选了场景却和通用预览一模一样时，接口必须能说清为什么——
// 否则人会以为"选了没用"，或者以为功能坏了。
test('GET /api/card：旧格式场景（private:10001）不算人物编号，明确说明原因', async () => {
  const d = await get(`/api/card?scene=${encodeURIComponent('private:10001')}`)
  assert.equal(d.ok, true)
  assert.equal(d.sceneInfo.resolved, false)
  assert.match(d.sceneInfo.reason, /编号必须是人物编号/)
  // 通用预览（不带场景）也要有说明
  const generic = await get('/api/card')
  assert.equal(generic.sceneInfo.resolved, false)
  assert.match(generic.sceneInfo.reason, /通用预览/)
})

test('GET /api/card：场景解析到人物、但这个人还没档案时，如实说', async () => {
  const p = createPerson(root, { display: '没写过素描的人' })
  linkIdentity(root, p.uid, { platform: 'qq', id: '10002' })

  // 场景里用的是**人物编号**，不是他的 QQ 号
  const d = await get(`/api/card?scene=${encodeURIComponent(`private:${p.uid}`)}`)
  assert.equal(d.ok, true)
  assert.equal(d.sceneInfo.resolved, true)
  assert.equal(d.sceneInfo.personUid, p.uid)
  assert.match(d.sceneInfo.reason, /没有档案/)
})

test('GET /api/card：场景编号不是 QQ 号——挂不同 QQ 也指向同一个人', async () => {
  const p = createPerson(root, { display: '两个号的人' })
  linkIdentity(root, p.uid, { platform: 'qq', id: '11111' })
  linkIdentity(root, p.uid, { platform: 'qq', id: '22222' })
  writeProfile(root, PID, p.uid, { sketch: '爱用短句' })

  // 用编号 → 带上他的画像
  const byId = await get(`/api/card?scene=${encodeURIComponent(`private:${p.uid}`)}`)
  assert.equal(byId.sceneInfo.personUid, p.uid)
  assert.match(byId.text, /爱用短句/)

  // 用他的 QQ 号当场景 → 不是编号，不认（这就是这次纠正的语义）
  const byAccount = await get(`/api/card?scene=${encodeURIComponent('private:11111')}`)
  assert.equal(byAccount.sceneInfo.resolved, false)
})

test('GET /api/card：场景解析到人物且有档案 → 注入里出现人物卡', async () => {
  const p = createPerson(root, { display: '有素描的人' })
  linkIdentity(root, p.uid, { platform: 'qq', id: '10003' })
  writeProfile(root, PID, p.uid, { sketch: '说话很快，爱用短句' })

  const d = await get(`/api/card?scene=${encodeURIComponent(`private:${p.uid}`)}`)
  assert.equal(d.sceneInfo.resolved, true)
  assert.match(d.sceneInfo.reason, /画像/)
  assert.match(d.text, /\[人物\].*有素描的人/)
  assert.match(d.text, /说话很快/)
})

// ── 注入预览的频道 ────────────────────────────────────────────────────

test('listScenes：从原始层数出真实场景（注入预览只让人挑存在的）', () => {
  const ptr = appendRecord(root, {
    source: 'qq',
    acct: '10001',
    channel: 'group:qq:123555',
    actor: { kind: 'member', id: '10002', name: '群友' },
    role: 'user',
    text: '群里说一句',
    ts: localIso(),
  })
  assert.ok(ptr?.id)

  const list = listScenes(root, { days: 30 })
  const g = list.find((sc) => sc.scene === 'group:qq:123555')
  assert.ok(g, '刚写进去的群体场景应该被数出来')
  assert.ok(g.messages >= 1)
  // 这是旧格式（群号当编号用）：列表里要标出来，它没有对应卡片
  assert.ok(g.legacy >= 1, '旧格式场景应标记 legacy')
  // 排序：最近活动的在前
  for (let i = 1; i < list.length; i += 1) {
    assert.ok(String(list[i - 1].lastAt) >= String(list[i].lastAt))
  }
})

test('GET /api/scenes：返回场景清单（手打名字打错了看不出来，所以只列真的）', async () => {
  const d = await get('/api/scenes?days=90')
  assert.equal(d.ok, true)
  assert.ok(Array.isArray(d.scenes))
  assert.ok(d.scenes.some((sc) => sc.scene === 'group:qq:123555'))
  assert.ok(d.scenes.every((sc) => /^(private|group):/.test(sc.scene)))
  // 老名字仍然给同一份数据（旧页面/脚本还在用）
  assert.ok(Array.isArray(d.channels))
  assert.equal(d.channels.length, d.scenes.length)
})

test('GET /api/motive：给五股劲和账本，且读页面不写盘', async () => {  const p = path.join(root, personaPaths(PID).purposes)
  const before = fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : null

  const d = await get('/api/motive')
  assert.equal(d.ok, true)
  assert.deepEqual(d.drives.needs, ['connect', 'care', 'curiosity', 'share', 'identity'])
  assert.equal(typeof d.drives.values.connect, 'number')
  assert.ok(Array.isArray(d.items))
  assert.equal(d.rules.limit, 2)

  const after = fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : null
  assert.equal(after, before, 'GET 不该让她的状态动一下')
})
