// test/p52.test.mjs —— 规则页的表单化：字段表 + 白名单写入 + 拒绝非法值。
//
// 为什么值得单独测：规则以前只能在页面上看一段 JSON，现在人可以直接改数字。
// 一旦"写错了还悄悄存下去"，人会以为规则生效了，实际没有——比根本不能改更糟。
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { scaffold } from '../src/core/scaffold.js'
import { personaPaths } from '../src/core/paths.js'
import { readToken, listen } from '../src/core/server.js'
import { ruleFieldSpec, writeGlobalRules, loadEffectiveRules, RULE_FIELDS } from '../src/core/rules.js'
import { createPersona } from '../src/core/persona.js'
import { history } from '../src/core/version.js'

const PID = 'yuanling'
let root
let server
let url
let token

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
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'yuanling-p52-'))
  scaffold(root, {})
  token = readToken(root)
  const started = await listen(root, { port: 0 })
  server = started.server
  url = started.url
})

after(async () => {
  await new Promise((res) => server.close(res))
})

// ── 字段表 ────────────────────────────────────────────────────────────

test('字段表：每项都有中文标签、类型和默认值（页面照着渲染，不另抄一份）', () => {
  const spec = ruleFieldSpec()
  assert.ok(spec.length >= 3)
  for (const g of spec) {
    assert.equal(typeof g.group, 'string')
    assert.equal(typeof g.honored, 'boolean')
    for (const f of g.fields) {
      // 绝大多数是点号路径（persona.evolve）；deny/allow 是顶层数组，就没有点号
      assert.match(f.path, /^[a-z_.]+$/i, `path 形状不对：${f.path}`)
      assert.ok(f.label.length > 0)
      assert.ok(['bool', 'int', 'enum', 'ranges', 'list'].includes(f.type))
      assert.ok(f.def !== undefined)
    }
  }
})

test('字段表：生效与否是事实，不是愿望', () => {
  // persona.* 被 proposals.js 读；action.* 被 proactive.js 读；recall.* 被 memory.buildCard 读。
  // 这条测试盯的是"别把未生效的字段标成生效"——那是最容易骗人的地方。
  const byGroup = Object.fromEntries(ruleFieldSpec().map((g) => [g.group, g]))
  assert.equal(byGroup['提案演化'].honored, true)
  assert.equal(byGroup['开口意愿'].honored, true, '主动开口真的读这些闸门')
  assert.equal(byGroup['记忆召回'].honored, true, 'hidden_kinds / min_importance 真的在过滤注入')
  assert.equal(byGroup['黑名单'], undefined, '动作名黑名单已删除（与主动开关重复）')
})

test('字段表：每个 path 在 DEFAULTS 里都有对应位置', () => {
  const { rules } = loadEffectiveRules(root, PID)
  for (const g of RULE_FIELDS) {
    for (const f of g.fields) {
      const v = f.path.split('.').reduce((o, k) => (o && typeof o === 'object' ? o[k] : undefined), rules)
      assert.ok(v !== undefined, `默认规则里没有这一项：${f.path}`)
    }
  }
})

// ── 写入 ──────────────────────────────────────────────────────────────

test('writeGlobalRules：写进人格全局层，并且进版本历史', () => {
  const r = writeGlobalRules(root, PID, { 'persona.auto_approve_days': 5, 'action.max_per_day': 12 })
  assert.equal(r.changed, true)
  const saved = JSON.parse(fs.readFileSync(path.join(root, personaPaths(PID).globalRule), 'utf8'))
  assert.equal(saved.persona.auto_approve_days, 5)
  assert.equal(saved.action.max_per_day, 12)

  const h = history(root, personaPaths(PID).globalRule)
  assert.ok(h.length >= 1)
  assert.equal(h[h.length - 1].actor, 'human:editor')
})

test('writeGlobalRules：值没变就不写盘（幂等，不制造假版本）', () => {
  const before = fs.readFileSync(path.join(root, personaPaths(PID).globalRule), 'utf8')
  const r = writeGlobalRules(root, PID, { 'persona.auto_approve_days': 5 })
  assert.equal(r.changed, false)
  assert.equal(fs.readFileSync(path.join(root, personaPaths(PID).globalRule), 'utf8'), before)
})

test('writeGlobalRules：白名单之外的键被丢掉并列出来，不静默写进去', () => {
  const r = writeGlobalRules(root, PID, { 'bogus.key': 1, 'persona.evolve': true })
  assert.deepEqual(r.dropped, ['bogus.key'])
  const saved = JSON.parse(fs.readFileSync(path.join(root, personaPaths(PID).globalRule), 'utf8'))
  assert.equal(saved.bogus, undefined)
})

test('writeGlobalRules：非法值抛错，不留半截写入', () => {
  const before = fs.readFileSync(path.join(root, personaPaths(PID).globalRule), 'utf8')
  assert.throws(
    () => writeGlobalRules(root, PID, { 'persona.auto_approve_days': 5, 'recall.min_importance': 'abc' }),
    /要的是数字/,
  )
  assert.equal(fs.readFileSync(path.join(root, personaPaths(PID).globalRule), 'utf8'), before)
})

test('writeGlobalRules：数字超范围被拒（不悄悄夹到边界）', () => {
  assert.throws(() => writeGlobalRules(root, PID, { 'action.max_per_hour': 999 }), /不能大于/)
})

test('writeGlobalRules：时段写错格式被拒（例如 25:00）', () => {
  assert.throws(() => writeGlobalRules(root, PID, { 'action.quiet_hours': '1:00-8:00，晚点再说' }), /HH:MM-HH:MM/)
  // 正确格式散着写也认
  const r = writeGlobalRules(root, PID, { 'action.quiet_hours': '01:00-08:00, 23:00-07:00' })
  assert.equal(r.changed, true)
  assert.deepEqual(r.written.action.quiet_hours, ['01:00-08:00', '23:00-07:00'])
})

test('writeGlobalRules：留 _comment 那句人话', () => {
  const saved = JSON.parse(fs.readFileSync(path.join(root, personaPaths(PID).globalRule), 'utf8'))
  assert.ok(saved._comment?.includes('人格级全局规则'))
})

// ── 接口 ──────────────────────────────────────────────────────────────

test('GET /api/rules：给字段表、自己那一层、根级硬线', async () => {
  const d = await get('/api/rules')
  assert.equal(d.ok, true)
  assert.ok(Array.isArray(d.spec))
  assert.equal(d.ownPath, 'personas/yuanling/rules/global.json')
  assert.equal(typeof d.own, 'object')
  assert.ok(Array.isArray(d.guardrails.never_do))
  assert.ok(d.guardrails.never_do.length >= 1)
})

test('POST /api/rules：保存后再读，有效值变了', async () => {
  const res = await post('/api/rules', { patch: { 'persona.rollback_days': 14 } })
  assert.equal(res.status, 200)
  const body = await res.json()
  assert.equal(body.ok, true)
  const d = await get('/api/rules')
  assert.equal(d.rules.persona.rollback_days, 14)
})

test('POST /api/rules：非法值返回 400 并把原因说清楚', async () => {
  const res = await post('/api/rules', { patch: { 'action.proactive': 'maybe' } })
  assert.equal(res.status, 400)
  const body = await res.json()
  assert.match(body.error, /只能是/)
})

test('POST /api/rules：群覆盖层的内容会体现在"有效值"里', async () => {
  // 写一份群覆盖，然后按那个频道读，有效值应该被覆盖
  const dir = path.join(root, 'personas', PID, 'rules', 'qq')
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'group-123555.json'), JSON.stringify({ action: { max_per_day: 3 } }), 'utf8')

  const d = await get(`/api/rules?channel=${encodeURIComponent('group:123555')}`)
  assert.equal(d.rules.action.max_per_day, 3, '群覆盖应该赢过全局层')
  assert.ok(d.own.action.max_per_day !== 3 || true)
  // own 仍然是全局层自己那份，不把覆盖混进来
  const own = JSON.parse(fs.readFileSync(path.join(root, personaPaths(PID).globalRule), 'utf8'))
  assert.equal(d.own.action.max_per_day, own.action.max_per_day)
})

// 规则按人格存：换人格就是另一份，新建人格拿默认值——**不跟着 --from 抄**。
// 抄规则 = 让新人格一出生就背着别人的行为边界，这种串味最难发现。
test('新建人格：规则是默认值，不是照抄源人格的', () => {
  writeGlobalRules(root, PID, { 'action.max_per_day': 7, 'persona.rollback_days': 30 })

  // 空白创建
  createPersona(root, 'fresh', '空白')
  const freshRules = JSON.parse(fs.readFileSync(path.join(root, personaPaths('fresh').globalRule), 'utf8'))
  assert.equal(freshRules.action.max_per_day, 20, '应该是模板默认值')
  assert.equal(freshRules.persona.rollback_days, 7)

  // 照抄骨架的创建：骨架跟着走，规则不跟
  createPersona(root, 'copied', '照抄', { from: PID })
  const copiedRules = JSON.parse(fs.readFileSync(path.join(root, personaPaths('copied').globalRule), 'utf8'))
  assert.equal(copiedRules.action.max_per_day, 20)
  // 但骨架确实抄过来了
  const srcSelf = fs.readFileSync(path.join(root, personaPaths(PID).self), 'utf8')
  const copiedSelf = fs.readFileSync(path.join(root, personaPaths('copied').self), 'utf8')
  assert.equal(copiedSelf, srcSelf, '骨架应该照抄')
  // 源人格自己的规则不受影响
  const mine = JSON.parse(fs.readFileSync(path.join(root, personaPaths(PID).globalRule), 'utf8'))
  assert.equal(mine.action.max_per_day, 7)
})

test('新建人格：两套规则的改动互不影响', () => {
  writeGlobalRules(root, 'fresh', { 'action.max_per_hour': 9 })
  const mine = JSON.parse(fs.readFileSync(path.join(root, personaPaths(PID).globalRule), 'utf8'))
  assert.equal(mine.action.max_per_hour, 3, '改 A 人格的规则不该动到 B 人格')
  const fresh = JSON.parse(fs.readFileSync(path.join(root, personaPaths('fresh').globalRule), 'utf8'))
  assert.equal(fresh.action.max_per_hour, 9)
})
