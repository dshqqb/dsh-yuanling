// test/p40.test.mjs —— 配置控件的扩展（v1.3 第一半）+ config 型 tab。
//
// 用户要的 10 个控件里，8 个本质是**配置项**（开关/勾选/单选/下拉/滑块/输入/多行/列表），
// 只有"按钮"和"浏览文件"是动作，等 ui.action。所以这里测的是：
//   · 控件推断对不对（schema 只描述数据，展示形态由 x-widget 或类型推断）
//   · 数组型配置（列表有 3 个字段、能增删改排序）的校验与结构
//   · config 型 tab 不需要模块进程
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import zlib from 'node:zlib'

import { describeFields, validateConfig, WIDGETS, SUPPORTED_TYPES } from '../src/core/modules/configschema.js'
import { validateManifest, summarizeErrors, UI_KINDS } from '../src/core/modules/manifest.js'
import { ModuleService } from '../src/core/modules/service.js'
import { moduleDetail, writeModuleConfig } from '../src/core/modules/manage.js'
import { scaffold } from '../src/core/scaffold.js'
import { installFromBytes } from '../src/core/modules/installer.js'
import { readRegistry } from '../src/core/modules/registry.js'

const RULES_SCHEMA = {
  type: 'object',
  properties: {
    rule1: { type: 'boolean', description: '规则1：开关' },
    rule2: { type: 'boolean', 'x-widget': 'checkbox', description: '规则2：勾选' },
    rule4: { type: 'number', minimum: 0, maximum: 100, 'x-step': 5, description: '规则4：滑块' },
    rule5: { type: 'string', enum: ['甲', '乙', '丙', '丁', '戊'], description: '规则5：五选一' },
    rule6: { type: 'string', description: '规则6：输入' },
    rule7: { type: 'string', enum: ['一', '二', '三', '四', '五', '六'], description: '规则7：下拉' },
    rule9: { type: 'string', 'x-widget': 'textarea', description: '规则9：多行' },
    rule10: {
      type: 'array',
      description: '规则10：列表，每行三个字段',
      items: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          enabled: { type: 'boolean' },
          weight: { type: 'number' },
        },
        required: ['name'],
      },
    },
  },
}

// ── 控件推断 ────────────────────────────────────────────────────────────

test('控件：布尔默认开关，声明 x-widget 就按声明画', () => {
  const byKey = byField(RULES_SCHEMA)
  assert.equal(byKey.rule1.widget, 'switch', '布尔默认开关')
  assert.equal(byKey.rule2.widget, 'checkbox', 'x-widget 优先')
})

test('控件：数字有量程就是滑块，没量程是数字输入', () => {
  const byKey = byField(RULES_SCHEMA)
  const f = byKey.rule4
  assert.equal(f.widget, 'slider')
  assert.equal(f.min, 0)
  assert.equal(f.max, 100)
  assert.equal(f.step, 5)
})

test('控件：枚举少用单选、多了用下拉', () => {
  const byKey = byField(RULES_SCHEMA)
  assert.equal(byKey.rule5.widget, 'radio', '5 个选项铺成单选')
  assert.equal(byKey.rule7.widget, 'select', '6 个选项用下拉')
  // 也能显式指定
  const forced = describeFields({ type: 'object', properties: { x: { type: 'string', enum: ['a', 'b'], 'x-enum-style': 'select' } } })
  assert.equal(forced[0].widget, 'select')
})

test('控件：默认是输入框，声明 textarea 或用 x-widget 才换', () => {
  const byKey = byField(RULES_SCHEMA)
  assert.equal(byKey.rule6.widget, 'input')
  assert.equal(byKey.rule9.widget, 'textarea')
})

test('控件：数组 → list，并带上每一行的字段定义', () => {
  const byKey = byField(RULES_SCHEMA)
  const f = byKey.rule10
  assert.equal(f.widget, 'list')
  assert.equal(f.type, 'array')
  assert.deepEqual(f.itemFields.map((x) => x.key), ['name', 'enabled', 'weight'])
  assert.equal(f.itemFields.find((x) => x.key === 'name').required, true)
  assert.equal(f.itemFields.find((x) => x.key === 'enabled').widget, 'switch')
})

test('控件：WIDGETS 是封闭词表，未知的 type 会被标出来', () => {
  // action / file 是占位控件（等 ui.action 协议），只画不提交
  assert.deepEqual(WIDGETS, ['input', 'textarea', 'switch', 'checkbox', 'radio', 'select', 'slider', 'list', 'action', 'file'])
  assert.deepEqual(SUPPORTED_TYPES, ['string', 'number', 'boolean', 'array'])
  const r = validateConfig({ type: 'object', properties: { x: { type: 'date' } } }, { x: '2026-01-01' })
  assert.ok(r.unsupported.some((u) => u.includes('date')))
})

test('控件：按钮/浏览文件是占位控件——不校验、不进配置', () => {
  const schema = {
    type: 'object',
    properties: {
      doIt: { type: 'string', 'x-widget': 'action', description: '规则3：按钮' },
      pick: { type: 'string', 'x-widget': 'file', description: '规则8：浏览文件' },
      keep: { type: 'string' },
    },
    required: ['doIt'], // 占位控件就算写了必填也不该卡住保存
  }
  const r = validateConfig(schema, { keep: 'v' })
  assert.equal(r.ok, true, '占位控件不参与校验')
  assert.deepEqual(r.value, { keep: 'v' }, '它们不会出现在保存的配置里')
})

// ── 校验 ────────────────────────────────────────────────────────────────

test('校验：数字超出量程要拒绝（滑块拖不出界，但接口能传进来）', () => {
  assert.equal(validateConfig(RULES_SCHEMA, { rule4: 50 }).ok, true)
  const low = validateConfig(RULES_SCHEMA, { rule4: -1 })
  assert.equal(low.ok, false)
  assert.match(low.errors[0].message, /不能小于 0/)
  const high = validateConfig(RULES_SCHEMA, { rule4: 101 })
  assert.match(high.errors[0].message, /不能大于 100/)
})

test('校验：列表型——每行按 items 的规则校验，必填缺失指出具体行与字段', () => {
  const ok = validateConfig(RULES_SCHEMA, {
    rule10: [
      { name: '第一条', enabled: true, weight: '3' },
      { name: '第二条', enabled: false, weight: 5 },
    ],
  })
  assert.equal(ok.ok, true, JSON.stringify(ok.errors))
  assert.equal(ok.value.rule10[0].weight, 3, '字符串数字要转成数字')
  assert.equal(ok.value.rule10[0].enabled, true)

  const bad = validateConfig(RULES_SCHEMA, { rule10: [{ enabled: true }] })
  assert.equal(bad.ok, false)
  assert.equal(bad.errors[0].field, 'rule10[0].name', '要指出是第几行的哪个字段')
})

test('校验：列表不是数组要拒；元素不是对象也要拒', () => {
  assert.equal(validateConfig(RULES_SCHEMA, { rule10: '不是数组' }).ok, false)
  const r = validateConfig(RULES_SCHEMA, { rule10: ['字符串'] })
  assert.equal(r.ok, false)
  assert.match(r.errors[0].message, /每一项必须是对象/)
})

test('校验：没给 items 的数组只要求"是数组"，内容原样收下', () => {
  const schema = { type: 'object', properties: { tags: { type: 'array' } } }
  const r = validateConfig(schema, { tags: ['a', 'b'] })
  assert.equal(r.ok, true)
  assert.deepEqual(r.value.tags, ['a', 'b'])
})

test('校验：展示提示（x-widget / x-*）不参与校验，也不算"不支持"', () => {
  const r = validateConfig(RULES_SCHEMA, { rule1: true, rule2: false })
  assert.equal(r.ok, true)
  assert.deepEqual(r.unsupported, [], 'x-widget 是我们自己的约定，不该被当成未知关键字')
})

// ── config 型 tab ───────────────────────────────────────────────────────

test('ui：kind 增加 config（模块可把某组设置单独开一页）', () => {
  assert.deepEqual(UI_KINDS, ['list', 'kv', 'text', 'config', 'records'])
  const r = validateManifest({
    id: 'demo',
    version: '0.1.0',
    api: '1.2',
    entry: { command: ['node', 'x.mjs'] },
    ui: { tabs: [{ id: 'rules', label: '规则', kind: 'config' }] },
  })
  assert.equal(r.ok, true, summarizeErrors(r.errors))
})

test('service：config 型 tab 由核心自己渲染，不需要模块进程', async () => {
  const root = tmpRoot()
  installRULES(root)
  const svc = new ModuleService({ root })

  // 注意：这里**没有**启动模块进程
  const r = await svc.uiGet('demo', 'rules')
  assert.equal(r.kind, 'config')
  assert.deepEqual(r.config, {})
  assert.ok(Array.isArray(r.fields) && r.fields.length === 8, `要带 8 个字段，实际 ${r.fields?.length}`)
  assert.equal(r.fields.find((f) => f.key === 'rule10').widget, 'list')

  // 存过配置之后读得出来
  writeModuleConfig(root, 'demo', { rule1: true, rule10: [{ name: 'x', enabled: true, weight: 1 }] })
  const r2 = await svc.uiGet('demo', 'rules')
  assert.equal(r2.config.rule1, true)
  assert.equal(r2.config.rule10.length, 1)
})

test('service：config 型 tab 也不走 ui.get（模块不会被问）', async () => {
  const root = tmpRoot()
  installRULES(root)
  const svc = new ModuleService({ root })
  let asked = false
  svc.procs.set('demo', {
    child: {},
    request: async () => {
      asked = true
      return { data: {} }
    },
  })
  await svc.uiGet('demo', 'rules')
  assert.equal(asked, false, 'config 页的数据在核心自己那儿，没必要问模块')
})

test('manifest：规则 tab 声明后，详情里能看到它', () => {
  const root = tmpRoot()
  installRULES(root)
  const d = moduleDetail(root, 'demo')
  assert.deepEqual(d.uiTabs.map((t) => [t.id, t.kind]), [['rules', 'config']])
})

// ── 工具 ────────────────────────────────────────────────────────────────

function byField(schema) {
  const out = {}
  for (const f of describeFields(schema)) out[f.key] = f
  return out
}

function tmpRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'yuanling-p40-'))
  scaffold(root, {})
  return root
}

function makeTar(files) {
  const blocks = []
  for (const [name, content] of Object.entries(files)) {
    const data = Buffer.from(content)
    const h = Buffer.alloc(512)
    h.write(name, 0, 'utf8')
    h.write(data.length.toString(8).padStart(11, '0'), 124, 'utf8')
    h.write('0', 156, 'utf8')
    blocks.push(h, data)
    const pad = (512 - (data.length % 512)) % 512
    if (pad) blocks.push(Buffer.alloc(pad))
  }
  blocks.push(Buffer.alloc(1024))
  return zlib.gzipSync(Buffer.concat(blocks))
}

const MANIFEST = {
  id: 'demo',
  name: '演示',
  version: '0.1.0',
  api: '1.2',
  kind: 'enricher',
  entry: { command: ['node', 'index.mjs'] },
  capabilities: ['provide.source'],
  config: { schema: RULES_SCHEMA },
  ui: { tabs: [{ id: 'rules', label: '规则', kind: 'config' }] },
}

function installRULES(root) {
  installFromBytes({
    root,
    bytes: makeTar({ 'yuanling.module.json': JSON.stringify(MANIFEST, null, 2), 'index.mjs': 'export default {}' }),
    source: 'test',
  })
  assert.ok(readRegistry(root).modules.demo, '模块要装进去')
}
