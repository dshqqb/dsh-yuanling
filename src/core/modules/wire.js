// src/core/modules/wire.js —— 把"模块 → 核心"的请求接到核心真正的处理函数上。
//
// 为什么单独一个文件：`index.js` 是插件入口（依赖宿主包，单测跑不起来），
// 而这一层需要能单独测——它是模块唯一能碰 Core 的地方，接错了就是"模块装上了但收不进消息"。
//
// 协议 §1 第 1 条：`source` 由**核心按连接身份盖章**，模块自报无效。
// 所以这里不信任 `data.source`，一律用模块 id 覆盖。
import { ingest } from '../inbox.js'
import { addFact } from '../memory.js'
import { readMarker } from '../persona.js'

/**
 * 造一组 handler 交给 ModuleService。
 *
 * @param {{root:string, pid?:string|null, now?:()=>number}} opts
 */
export function moduleHandlers({ root, pid = null } = {}) {
  const activePid = () => pid ?? readMarker(root)?.active ?? null

  return {
    /**
     * `ingest`：模块把收到的消息交进来。
     * 走后门就完了——脱敏、硬线、去重、分片、日链全在 ingest() 上，另开一条路等于那些规则对它失效。
     */
    onIngest: ({ id, data }) => {
      const env = { ...(data && typeof data === 'object' ? data : {}), source: String(id) }
      const r = ingest(root, env)
      return { accepted: r.accepted, deduped: r.deduped, skipped: r.skipped, errors: r.errors }
    },

    /**
     * `propose.fact`：模块提议一条事实。
     * 指针必须能解析（`src` 指向 raw 里真实存在的记录），事实会记 `origin_module`。
     */
    onPropose: ({ id, data }) => {
      const p = activePid()
      if (!p) throw new Error('还没有激活人格')
      const r = addFact(root, p, {
        topic: data?.topic,
        text: data?.text,
        src: data?.src,
        imp: Number.isFinite(Number(data?.imp)) ? Number(data.imp) : null,
        slot: typeof data?.slot === 'string' && data.slot.trim() ? data.slot.trim() : null,
        originModule: id,
      })
      return {
        status: r.added ? 'accepted' : r.repeated ? 'deduped' : 'rejected',
        factId: r.fact?.id ?? null,
      }
    },
  }
}
