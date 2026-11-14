// src/core/model.js —— 原灵控制台使用的大模型选择。
//
// 模型目录来自 DSH 的 llm 服务：只列已经注册/配置好的 provider，
// 以及它们当前愿意 advertise 的模型。选择存 system/console-model.json，
// 属于数据目录，跟着人格数据走；换机器后如果 provider 不存在，UI 会提示，
// 下一次对话会明确报 “provider 不可用”，而不是偷偷回落到另一个模型。
import path from 'node:path'

import { readJson, writeJsonAtomic } from './fsx.js'

export const CONSOLE_MODEL_FILE = 'system/console-model.json'

function cleanSelection(raw) {
  if (!raw || typeof raw !== 'object') return null
  const provider = String(raw.provider ?? '').trim()
  const model = String(raw.model ?? '').trim()
  if (!provider || !model) return null
  const out = { provider, model }
  const effort = String(raw.reasoningEffort ?? '').trim()
  if (effort) out.reasoningEffort = effort
  return out
}

export function readConsoleModel(root) {
  return cleanSelection(readJson(path.join(root, CONSOLE_MODEL_FILE), null))
}

export function writeConsoleModel(root, selection) {
  const clean = cleanSelection(selection)
  if (!clean) throw new Error('模型选择缺少 provider 或 model')
  writeJsonAtomic(path.join(root, CONSOLE_MODEL_FILE), { ...clean, updated_at: new Date().toISOString() })
  return readConsoleModel(root)
}

function providerId(p) {
  return String(p?.id ?? p?.provider ?? '').trim()
}

function providerName(p, id) {
  return String(p?.name ?? p?.title ?? id).trim() || id
}

function modelName(m, id) {
  return String(m?.name ?? id).trim() || id
}

/**
 * 读 DSH 当前的模型目录。
 *
 * 单个 provider 取列表失败不影响其他 provider：模型配置坏掉时，
 * 页面仍应能看到其余可用模型，并看到具体哪个 provider 坏了。
 */
export async function listModelChoices(ctx) {
  const llm = ctx?.get?.('llm')
  if (!llm || typeof llm.listProviders !== 'function' || typeof llm.listModels !== 'function') {
    return { providers: [], error: '这个进程没有 DSH 的 llm 服务，无法列出模型' }
  }
  const routes = llm.listProviders() ?? []
  const providers = []
  for (const route of routes) {
    const id = providerId(route)
    if (!id) continue
    const item = { id, name: providerName(route, id), models: [] }
    try {
      const models = await llm.listModels(id)
      for (const model of models ?? []) {
        const mid = String(model?.id ?? '').trim()
        if (!mid) continue
        let info = null
        let error = ''
        try {
          info = await llm.resolveModelInfo(id, mid)
        } catch (e) {
          error = String(e?.message ?? e)
        }
        item.models.push({
          id: mid,
          name: modelName(model, mid),
          description: typeof model?.description === 'string' ? model.description : '',
          reasoning: info?.reasoning?.efforts?.length
            ? { efforts: info.reasoning.efforts, defaultEffort: info.reasoning.defaultEffort ?? '' }
            : null,
          error,
        })
      }
    } catch (e) {
      item.error = String(e?.message ?? e)
    }
    providers.push(item)
  }
  return { providers }
}

/** 校验一个选择确实指向当前 llm 服务里存在的模型/推理等级。 */
export async function validateModelChoice(ctx, selection) {
  const clean = cleanSelection(selection)
  if (!clean) throw new Error('模型选择缺少 provider 或 model')
  const llm = ctx?.get?.('llm')
  if (!llm || typeof llm.resolveModelInfo !== 'function') throw new Error('这个进程没有 DSH 的 llm 服务')
  let info
  try {
    info = await llm.resolveModelInfo(clean.provider, clean.model)
  } catch (e) {
    throw new Error(`模型不可用：${clean.provider} / ${clean.model}（${String(e?.message ?? e)}）`)
  }
  if (clean.reasoningEffort) {
    const efforts = info?.reasoning?.efforts ?? []
    if (!efforts.some((x) => x.id === clean.reasoningEffort)) {
      throw new Error(`模型 ${clean.model} 不支持推理等级 ${clean.reasoningEffort}`)
    }
  }
  return clean
}
