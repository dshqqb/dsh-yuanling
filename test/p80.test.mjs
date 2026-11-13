// test/p80.test.mjs —— ingest 回执 v1.7：按条给 canonical channel / directed（2026-11-12）
//
// 模块靠它开 DSH 回合、做 egress：外部号（private:3206104913）→ 内部账户号（private:acct_…），
// 以及"这句是不是冲她说的"（群聊要不要回）。
import { test, before } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { scaffold } from '../src/core/scaffold.js'
import { ingest } from '../src/core/inbox.js'
import { moduleHandlers } from '../src/core/modules/wire.js'
import { localIso } from '../src/core/fsx.js'

const PID = 'yuanling'
let root

before(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'yuanling-p80-'))
  scaffold(root, {})
})

let seq = 0
function env(items) {
  seq += 1
  return { v: 1, source: 'qq', acct: '2823503286', items: items(seq) }
}

test('私聊：回执带内部场景号 + directed=true + raw 指针', () => {
  const r = ingest(
    root,
    env((n) => [
      {
        channel: 'private:90001',
        kind: 'msg',
        role: 'user',
        ext_id: `p1-${n}`,
        ts: localIso(),
        text: '在吗',
        actor: { kind: 'owner', id: '90001', name: '小李' },
      },
    ]),
    { withItems: true },
  )
  assert.equal(r.items.length, 1)
  const it = r.items[0]
  assert.match(it.channel, /^private:acct_/)
  assert.equal(it.native, 'private:qq:90001')
  assert.equal(it.directed, true)
  assert.equal(it.deduped, false)
  assert.equal(it.skipped, false)
  assert.match(it.record, /^raw\/.*#/)
})

test('群聊：没被叫到 directed=false；@ 她 / 引用她才是 true', () => {
  const plain = ingest(
    root,
    env((n) => [
      {
        channel: 'group:91001',
        kind: 'msg',
        role: 'user',
        ext_id: `g1-${n}`,
        ts: localIso(),
        text: '今天谁值班',
        actor: { kind: 'member', id: '11111', name: '路人' },
      },
    ]),
    { withItems: true },
  )
  assert.match(plain.items[0].channel, /^group:grp_/)
  assert.equal(plain.items[0].directed, false)

  const at = ingest(
    root,
    env((n) => [
      {
        channel: 'group:91001',
        kind: 'msg',
        role: 'user',
        ext_id: `g2-${n}`,
        ts: localIso(),
        text: '@2823503286 在吗',
        actor: { kind: 'member', id: '11111', name: '路人' },
      },
    ]),
    { withItems: true },
  )
  assert.equal(at.items[0].directed, true)
})

test('她自己说的话：directed=false（不能自己回自己）', () => {
  const r = ingest(
    root,
    env((n) => [
      {
        channel: 'group:91001',
        kind: 'msg',
        role: 'bot',
        ext_id: `b1-${n}`,
        ts: localIso(),
        text: '我在',
        actor: { kind: 'member', id: '2823503286', name: '原灵' },
      },
    ]),
    { withItems: true },
  )
  assert.equal(r.items[0].directed, false)
})

test('重复投递：items 仍然给 channel，但 deduped=true（模块据此不回）', () => {
  const mk = (n) => ({
    channel: 'private:90002',
    kind: 'msg',
    role: 'user',
    ext_id: 'same-id-1',
    ts: localIso(),
    text: '同一句',
    actor: { kind: 'owner', id: '90002', name: '小张' },
  })
  const first = ingest(root, env((n) => [mk(n)]), { withItems: true })
  const second = ingest(root, env((n) => [mk(n)]), { withItems: true })
  assert.equal(first.items[0].deduped, false)
  assert.equal(second.items[0].deduped, true)
  assert.equal(second.items[0].channel, first.items[0].channel)
})

test('一条消息都没收：items 按入参顺序对齐（两条都在）', () => {
  const r = ingest(
    root,
    env((n) => [
      {
        channel: 'private:90003',
        kind: 'msg',
        role: 'user',
        ext_id: `p3a-${n}`,
        ts: localIso(),
        text: '一',
        actor: { kind: 'owner', id: '90003', name: '甲' },
      },
      {
        channel: 'group:92001',
        kind: 'msg',
        role: 'user',
        ext_id: `g3a-${n}`,
        ts: localIso(),
        text: '二',
        actor: { kind: 'member', id: '22222', name: '乙' },
      },
    ]),
    { withItems: true },
  )
  assert.equal(r.items.length, 2)
  assert.match(r.items[0].channel, /^private:acct_/)
  assert.match(r.items[1].channel, /^group:grp_/)
})

test('模块通道：wire.onIngest 把 items 原样交回（模块靠它拿场景号）', () => {
  const h = moduleHandlers({ root })
  const r = h.onIngest({
    id: 'qq',
    data: env((n) => [
      {
        channel: 'private:90004',
        kind: 'msg',
        role: 'user',
        ext_id: `p4-${n}`,
        ts: localIso(),
        text: '喂',
        actor: { kind: 'owner', id: '90004', name: '丙' },
      },
    ]),
  })
  assert.equal(r.accepted, 1)
  assert.equal(r.items.length, 1)
  assert.match(r.items[0].channel, /^private:acct_/)
  assert.equal(r.items[0].directed, true)
})
