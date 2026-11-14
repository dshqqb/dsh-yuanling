// test/p91.test.mjs —— 状态页「推理等级」下拉记不记得住（2026-11-14 修）。
//
// 这个 bug 复发过两次：保存了 high，刷新变回「自动」。根因是拿**模型对象**去比 provider
// （模型对象只有 id/name/reasoning，没有 provider 字段），比较永远失败。
// 现在这段判断只有一个实现（web/modelview.js），浏览器和这里共用。
import { test } from 'node:test'
import assert from 'node:assert/strict'

import '../web/modelview.js'

const { effortValue } = globalThis.YLModelView

const catalog = {
  current: { provider: 'deepseek-account', model: 'deepseek-flash', reasoningEffort: 'high' },
  providers: [
    {
      id: 'deepseek-account',
      name: 'DeepSeek',
      models: [
        { id: 'deepseek-flash', reasoning: { efforts: [{ id: 'off' }, { id: 'low' }, { id: 'high' }, { id: 'max' }], defaultEffort: 'off' } },
        { id: 'plain', reasoning: null },
      ],
    },
    { id: 'ark', name: 'Ark', models: [{ id: 'deepseek-v4.1-flash', reasoning: { efforts: [{ id: 'low' }, { id: 'high' }], defaultEffort: 'low' } }] },
  ],
}

const picked = (provider, model) => JSON.stringify({ provider, model })

test('保存过 high：刷新后下拉还是 high', () => {
  const v = effortValue(catalog, picked('deepseek-account', 'deepseek-flash'))
  assert.equal(v.visible, true)
  assert.equal(v.value, 'high')
  assert.deepEqual(v.efforts.map((e) => e.id), ['off', 'low', 'high', 'max'])
})

test('没有存过等级：选「自动」', () => {
  const v = effortValue({ ...catalog, current: { provider: 'deepseek-account', model: 'deepseek-flash' } }, picked('deepseek-account', 'deepseek-flash'))
  assert.equal(v.value, '')
})

test('存的是别的模型：这个模型的下拉该是「自动」', () => {
  const v = effortValue({ ...catalog, current: { provider: 'ark', model: 'deepseek-v4.1-flash', reasoningEffort: 'high' } }, picked('deepseek-account', 'deepseek-flash'))
  assert.equal(v.value, '')
})

test('同一个模型 id 挂在两个 provider 下：按 provider + model 一起认', () => {
  const dup = {
    current: { provider: 'ark', model: 'deepseek-flash', reasoningEffort: 'max' },
    providers: [
      { id: 'deepseek-account', models: [{ id: 'deepseek-flash', reasoning: { efforts: [{ id: 'high' }] } }] },
      { id: 'ark', models: [{ id: 'deepseek-flash', reasoning: { efforts: [{ id: 'high' }, { id: 'max' }] } }] },
    ],
  }
  assert.equal(effortValue(dup, picked('deepseek-account', 'deepseek-flash')).value, '')
  assert.equal(effortValue(dup, picked('ark', 'deepseek-flash')).value, 'max')
})

test('模型没有推理等级：整行藏起来', () => {
  const v = effortValue(catalog, picked('deepseek-account', 'plain'))
  assert.equal(v.visible, false)
})

test('存了一个现在不支持的等级：回落「自动」而不是硬选一个不存在的档位', () => {
  const v = effortValue({ ...catalog, current: { provider: 'deepseek-account', model: 'deepseek-flash', reasoningEffort: 'ultra' } }, picked('deepseek-account', 'deepseek-flash'))
  assert.equal(v.value, '')
})

test('还没选模型 / 选项坏掉：不崩，按「自动」处理', () => {
  assert.equal(effortValue(catalog, '').visible, false)
  assert.equal(effortValue(catalog, 'not-json').visible, false)
  assert.equal(effortValue(null, picked('deepseek-account', 'deepseek-flash')).visible, false)
})
