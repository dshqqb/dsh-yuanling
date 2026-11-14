// web/modelview.js —— 状态页「推理等级」下拉该选哪一项。
//
// 这是纯函数，浏览器和 node --test 共用一份（这个 bug 复发过两次，必须有测试盯着）：
//   · 选中的是「模型对象」（只有 id / name / reasoning），**没有 provider 字段**；
//   · 曾经拿 `choice.provider` 去和保存的 provider 比，永远是 undefined，
//     于是每次刷新都判定"这不是同一个模型"，下拉一律回落到「自动」。
;(function (root) {
  function choiceFrom(catalog, pickedText) {
    let picked = null
    try {
      picked = JSON.parse(pickedText || 'null')
    } catch {
      picked = null
    }
    if (!picked || !picked.provider || !picked.model) return null
    const entry = (catalog?.providers ?? [])
      .find((p) => p.id === picked.provider)
      ?.models.find((m) => m.id === picked.model)
    return entry ? { provider: picked.provider, model: picked.model, entry } : null
  }

  /**
   * @returns {{visible:boolean, value:string, efforts:Array}}
   *   visible=false → 这个模型没有推理等级，整行藏起来；
   *   value → 应该选中的档位 id（空串 = 自动）。
   */
  function effortValue(catalog, pickedText) {
    const hit = choiceFrom(catalog, pickedText)
    const efforts = hit?.entry?.reasoning?.efforts ?? []
    if (!efforts.length) return { visible: false, value: '', efforts }
    const cur = catalog?.current
    const same = Boolean(cur && hit && cur.provider === hit.provider && cur.model === hit.model)
    const want = same ? String(cur.reasoningEffort ?? '') : ''
    return { visible: true, value: efforts.some((e) => e.id === want) ? want : '', efforts }
  }

  root.YLModelView = { choiceFrom, effortValue }
})(typeof window !== 'undefined' ? window : globalThis)
