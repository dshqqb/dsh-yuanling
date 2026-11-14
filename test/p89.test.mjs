// test/p89.test.mjs —— 几千个好友时的读路径（2026-11-14 定）：
//
//   · 每轮上下文只点查在场的那几个人，**读盘次数与卡数无关**（用 I/O 计数断言，不看毫秒，
//     免得机器快慢让测试飘）；
//   · 写一张卡只让那一张缓存失效，不是整表重读；
//   · 点查出来的那一行和人物页列表里的那一行是**同一份**装配逻辑（不许漂移）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { scaffold } from '../src/core/scaffold.js'
import {
  cardByAccount,
  cardIoStats,
  cardRel,
  createCard,
  loadCardRegistry,
  mainOf,
  mergeCards,
  newCardUid,
  noteCardMessage,
  resetCardIoStats,
  saveCardRegistry,
  setCardDescription,
} from '../src/core/accounts.js'
import { listPeopleForUi, personRow } from '../src/core/entities.js'
import { contextFor } from '../src/core/memory.js'
import { personMentionIndex } from '../src/core/aliases.js'
import { appendRecord } from '../src/core/raw.js'
import { localIso } from '../src/core/fsx.js'

const PID = 'yuanling'

function mkRoot(tag) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `yuanling-p89-${tag}-`))
  scaffold(root, {})
  return root
}

/**
 * 造 n 张好友卡。
 *
 * 这里**直接写盘**而不是一张张走 createCard：createCard 每次都要重写整张注册表（那是给
 * "一个人一张"的正常节奏用的），造 800 张卡会把这一个测试拖成 40 秒。测试要测的是读路径。
 */
function bulk(root, n, start = 1) {
  const ids = []
  const reg = loadCardRegistry(root, PID)
  const dir = path.join(root, 'personas', PID, 'entities', 'cards')
  fs.mkdirSync(dir, { recursive: true })
  for (let i = 0; i < n; i += 1) {
    const no = start + i
    const id = newCardUid()
    const card = {
      id,
      app: 'qq',
      account: String(900000 + no),
      nicknames: [`人${no}`],
      description: `第 ${no} 个群友，聊过几次，人还行。`,
      weight: 10,
      firstMet: '2026-10-01T10:00:00+08:00',
      members: [],
      tier: null,
      pinned: false,
      pinRank: 0,
      stats: { messages: 1, activeDays: 1, last30: 1, dayCounts: {}, updatedAt: null },
      created: '2026-10-01T10:00:00+08:00',
      updated_at: '2026-10-01T10:00:00+08:00',
    }
    fs.writeFileSync(path.join(dir, `${id}.json`), JSON.stringify(card, null, 2) + '\n', 'utf8')
    reg.cards[id] = { id, app: 'qq', account: card.account, created: card.created }
    reg.byAccount[`qq:${card.account}`] = id
    ids.push(id)
  }
  saveCardRegistry(root, reg, PID)
  return ids
}

/** 一轮上下文的读盘次数：先预热，再写一张卡（模拟群里又来了一条消息），然后数这一轮读了几次盘。 */
function readsPerTurn(root, uid, otherUid) {
  contextFor(root, PID, { participants: [uid] }) // 预热：第一次必然要建索引
  noteCardMessage(root, PID, otherUid, { ts: localIso() }) // 一条消息 → 写一张卡
  resetCardIoStats()
  const ctx = contextFor(root, PID, { participants: [uid] })
  return { reads: cardIoStats().reads, ctx }
}

test('读盘次数与卡数无关：300 张和 800 张都是个位数', () => {
  const small = mkRoot('small')
  const sIds = bulk(small, 300)
  const s = readsPerTurn(small, sIds[0], sIds[5])
  assert.match(s.ctx, /\[人物\]/)
  assert.ok(s.reads <= 20, `300 张卡时一轮读了 ${s.reads} 次盘`)

  const big = mkRoot('big')
  const bIds = bulk(big, 800)
  const b = readsPerTurn(big, bIds[0], bIds[500])
  assert.match(b.ctx, /\[人物\]/)
  assert.ok(b.reads <= 20, `800 张卡时一轮读了 ${b.reads} 次盘`)
  assert.ok(b.reads <= s.reads + 5, `卡数翻了 2.6 倍，读盘次数不该跟着涨：${s.reads} → ${b.reads}`)
})

test('写一张卡只丢一条缓存：下一轮立刻看到新内容', () => {
  const root = mkRoot('dirty')
  const ids = bulk(root, 50)
  const uid = ids[0]

  assert.ok(!contextFor(root, PID, { participants: [uid] }).includes('改过的描述'))
  setCardDescription(root, PID, uid, '改过的描述，就在这一轮生效。', { actor: 'human:editor', reason: '测试' })
  assert.ok(contextFor(root, PID, { participants: [uid] }).includes('改过的描述'))

  // 新建的卡也在下一轮就能按账号查到（注册表缓存跟着更新）
  const fresh = createCard(root, PID, { app: 'qq', account: '777777', nicknames: ['新来的'], description: '刚认识。' })
  assert.equal(cardByAccount(root, PID, 'qq', '777777'), fresh.id)
  assert.match(contextFor(root, PID, { participants: [fresh.id] }), /新来的/)
})

test('新建的卡：权重 0、初识为空，但下一轮上下文就能带上', () => {
  const root = mkRoot('fresh')
  const card = createCard(root, PID, { app: 'qq', account: '666666', nicknames: ['好友甲'], description: '聊过。' })
  assert.equal(card.weight, 0, '没互动就是 0')
  assert.equal(card.firstMet, null, '手动/自动建卡都没有初识')

  const ctx = contextFor(root, PID, { participants: [card.id] })
  assert.match(ctx, /好友甲/)
})

test('点查的那一行 = 人物页列表那一行（合并后也一致）', () => {
  const root = mkRoot('row')
  const a = createCard(root, PID, { app: 'qq', account: '555501', nicknames: ['甲'], description: '甲在 QQ。' })
  const b = createCard(root, PID, { app: 'bili', account: '555502', nicknames: ['甲甲'], description: '甲在 B 站。' })
  mergeCards(root, PID, [a.id, b.id])

  const main = mainOf(root, PID, b.id)
  const fromList = listPeopleForUi(root, PID).find((r) => r.uid === main)
  const fromPoint = personRow(root, PID, b.id)
  assert.ok(fromList && fromPoint)
  assert.deepEqual(fromPoint, fromList)
  assert.equal(fromPoint.uid, main)
  assert.equal(fromPoint.accounts.length, 2)

  // 调用方同时给了成员卡和主卡：只带一行
  const lines = contextFor(root, PID, { participants: [a.id, b.id] }).split('\n').filter((l) => l.startsWith('[人物]'))
  assert.equal(lines.length, 1)
})

test('称呼索引：一遍建好，「提到谁」照旧能用', () => {
  const root = mkRoot('mention')
  const card = createCard(root, PID, { app: 'qq', account: '444401', nicknames: ['老周'], description: '大家都叫他老周。' })
  const index = personMentionIndex(root, PID)
  assert.deepEqual(index.get('老周')?.uids, [card.id])
  assert.equal(personMentionIndex(root, PID), index, '写代数没变就该复用同一个 Map')

  // 写一条群消息让它以"被提到的人"进上下文
  appendRecord(root, {
    source: 'qq',
    acct: '1',
    channel: 'group:grp_test_mention',
    type: 'message',
    role: 'user',
    actor: { kind: 'member', id: '444401', name: '老周' },
    text: '老周说他明天不来',
    ts: localIso(),
  })
  const ctx = contextFor(root, PID, { channel: 'group:grp_test_mention' })
  assert.match(ctx, /老周/)
})
