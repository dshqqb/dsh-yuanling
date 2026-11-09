// test/p49.test.mjs —— 失败帧的信封：协议怎么说，核心就怎么读。
//
// 这条钉住的是一个真事故：模块把 `code` / `message` 摊在帧的顶层发出去，
// 而协议 §4.2 要求嵌套在 `error:{code,message,retry}` 里。核心只读嵌套那份，
// 于是**所有模块失败都被吞成 `E_MODULE 模块返回失败`** —— 真实错误码全丢，
// 用户看到的永远是一句没法排查的话。
//
// 处理原则：**照收（行为正确）但明确警告（否则作者永远不知道自己不合协议）**。
// 静默容忍才是最坏的：它让不合协议的模块一直"能跑"。
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { ModuleProcess } from '../src/core/modules/host.js'

/** 造一个不上进程的宿主，把 onLog 收集起来。 */
function hostWithLogs() {
  const logs = []
  const host = new ModuleProcess({
    id: 'fake',
    command: ['node', '-e', ''],
    onLog: (x) => logs.push(x),
    autoRestart: false,
  })
  return { host, logs }
}

/** 注册一个在途请求，返回能被 _dispatch 结算的 promise。 */
function pending(host, id) {
  return new Promise((resolve, reject) => {
    host.pending.set(id, { op: 'x', resolve, reject })
  })
}

test('失败帧（协议形状）：code / message / retry 原样传到调用方', async () => {
  const { host } = hostWithLogs()
  const p = pending(host, 'r1')
  host._dispatch({ id: 'r1', ok: false, error: { code: 'E_RATE', message: '被限流了', retry: true } })
  await assert.rejects(p, (e) => {
    assert.equal(e.code, 'E_RATE')
    assert.equal(e.message, '被限流了')
    assert.equal(e.retry, true)
    return true
  })
})

test('失败帧（扁平形状）：仍然照收错误码，但不静默——要留一条警告', async () => {
  const { host, logs } = hostWithLogs()
  const p = pending(host, 'r2')
  host._dispatch({ id: 'r2', ok: false, code: 'E_BAD_REQUEST', message: '缺少 q' })

  await assert.rejects(p, (e) => {
    assert.equal(e.code, 'E_BAD_REQUEST', '不能退化成 E_MODULE：那样错误码就丢了')
    assert.equal(e.message, '缺少 q')
    return true
  })
  const warn = logs.find((x) => x.level === 'warn' && /扁平/.test(x.message))
  assert.ok(warn, '扁平帧必须留下警告，否则作者永远不知道要改')
  assert.match(warn.message, /§4\.2/)
})

test('失败帧（什么都没有）：退化成 E_MODULE，但仍是一句能看懂的话', async () => {
  const { host } = hostWithLogs()
  const p = pending(host, 'r3')
  host._dispatch({ id: 'r3', ok: false })
  await assert.rejects(p, (e) => {
    assert.equal(e.code, 'E_MODULE')
    assert.match(e.message, /模块返回失败/)
    return true
  })
})

test('成功帧：result 原样给调用方，result 缺失时给空对象', async () => {
  const { host } = hostWithLogs()
  const p1 = pending(host, 's1')
  host._dispatch({ id: 's1', ok: true, result: { v: 1, items: [] } })
  assert.deepEqual(await p1, { v: 1, items: [] })

  const p2 = pending(host, 's2')
  host._dispatch({ id: 's2', ok: true })
  assert.deepEqual(await p2, {}, '没有 result 也不能给 undefined')
})

test('孤儿响应：不结算任何东西，只记一条警告（迟到的答复不该让进程等下去）', async () => {
  const { host, logs } = hostWithLogs()
  host._dispatch({ id: 'ghost', ok: true, result: {} })
  assert.ok(logs.some((x) => /孤儿响应/.test(x.message)))
})
