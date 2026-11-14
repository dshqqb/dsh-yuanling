// test/p87.test.mjs —— 控制台大模型目录/选择/推理等级。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import {
  listModelChoices,
  readConsoleModel,
  validateModelChoice,
  writeConsoleModel,
} from '../src/core/model.js'

function fakeCtx() {
  return {
    get(name) {
      if (name !== 'llm') return null
      return {
        listProviders: () => [
          { id: 'p1', name: 'Provider One' },
          { id: 'p2', name: 'Provider Two' },
        ],
        listModels: async (provider) => {
          if (provider === 'p1') return [{ id: 'm1', name: 'Model One' }, { id: 'm2', name: 'Model Two' }]
          throw new Error('provider two is broken')
        },
        resolveModelInfo: async (provider, model) => {
          if (provider !== 'p1') throw new Error('no provider')
          if (model === 'nope') throw new Error('missing model')
          if (model === 'm1') {
            return {
              provider,
              id: model,
              name: 'Model One',
              reasoning: { efforts: [{ id: 'low', name: '低' }, { id: 'high', name: '高' }], defaultEffort: 'low' },
            }
          }
          return { provider, id: model, name: 'Model Two' }
        },
      }
    },
  }
}

test('目录：坏 provider 不影响其他 provider，模型带推理等级', async () => {
  const d = await listModelChoices(fakeCtx())
  assert.equal(d.providers.length, 2)
  const p1 = d.providers.find((p) => p.id === 'p1')
  assert.equal(p1.models.length, 2)
  assert.deepEqual(p1.models[0].reasoning.efforts.map((x) => x.id), ['low', 'high'])
  assert.equal(p1.models[1].reasoning, null)
  const p2 = d.providers.find((p) => p.id === 'p2')
  assert.match(p2.error, /broken/)
})

test('选择：持久化，缺省不写 reasoningEffort', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'yuanling-p87-'))
  fs.mkdirSync(path.join(root, 'system'))
  writeConsoleModel(root, { provider: 'p1', model: 'm1' })
  assert.deepEqual(readConsoleModel(root), { provider: 'p1', model: 'm1' })
  writeConsoleModel(root, { provider: 'p1', model: 'm1', reasoningEffort: 'high' })
  assert.deepEqual(readConsoleModel(root), { provider: 'p1', model: 'm1', reasoningEffort: 'high' })
})

test('校验：模型存在才允许；推理等级必须在该模型能力里', async () => {
  const ctx = fakeCtx()
  assert.deepEqual(await validateModelChoice(ctx, { provider: 'p1', model: 'm1', reasoningEffort: 'high' }), {
    provider: 'p1',
    model: 'm1',
    reasoningEffort: 'high',
  })
  await assert.rejects(
    () => validateModelChoice(ctx, { provider: 'p1', model: 'm1', reasoningEffort: 'max' }),
    /不支持推理等级/,
  )
  await assert.rejects(
    () => validateModelChoice(ctx, { provider: 'p1', model: 'nope' }),
    /模型不可用/,
  )
})
