// test/p81.test.mjs —— 人物卡（每账户一张 + 主卡成员表）。
import { test, before } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { scaffold } from '../src/core/scaffold.js'
import {
  createCard,
  setCardDescription,
  setCardNicknames,
  mergeCards,
  splitCard,
  listCards,
  mainOf,
  groupOf,
  personDescription,
  personWeight,
  labelOfPerson,
  CARD_DESC_MAX_CHARS,
} from '../src/core/accounts.js'
import { listPeopleForUi, setPinned, currentAdmin } from '../src/core/entities.js'
import { ensureConsoleMaster } from '../src/core/console.js'

const PID = 'yuanling'
let root

before(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'yuanling-p81-'))
  scaffold(root, {})
})

test('卡：一个 app+account 一张，昵称多个', () => {
  const c = createCard(root, PID, { app: 'qq', account: '10001', nicknames: ['老王', '老老王'], description: '爱喝茶' })
  assert.deepEqual(c.nicknames, ['老王', '老老王'])
  assert.equal(c.description, '爱喝茶')
  assert.equal(labelOfPerson(root, PID, c.id), '老王 / 老老王')
  assert.throws(() => createCard(root, PID, { app: 'qq', account: '10001' }), /已经有卡/)
})

test('描述：2000 字符上限', () => {
  const c = createCard(root, PID, { app: 'qq', account: '10002', nicknames: ['甲'] })
  setCardDescription(root, PID, c.id, '啊'.repeat(CARD_DESC_MAX_CHARS))
  assert.throws(() => setCardDescription(root, PID, c.id, '啊'.repeat(CARD_DESC_MAX_CHARS + 1)), /2000/)
})

test('合并：成员表写在 id 最小的卡上；列表只显示主卡', () => {
  const qq = createCard(root, PID, { app: 'qq', account: '20001', nicknames: ['大甲'], description: 'QQ 描述' })
  const bili = createCard(root, PID, { app: 'bilibili', account: '20002', nicknames: ['大甲B'], description: 'B 描述' })
  const r = mergeCards(root, PID, [qq.id, bili.id])
  assert.equal(r.main, [qq.id, bili.id].sort()[0])
  const main = listCards(root, PID).find((c) => c.id === r.main)
  assert.deepEqual(main.members.sort(), [qq.id, bili.id].sort())
  assert.equal(groupOf(root, PID, bili.id).length, 2)
  assert.equal(personDescription(root, PID, qq.id), 'QQ 描述\nB 描述')
  const rows = listPeopleForUi(root, PID)
  assert.ok(rows.some((x) => x.uid === r.main))
  assert.ok(!rows.some((x) => x.uid === (r.main === qq.id ? bili.id : qq.id)))
})

test('权重：账户各自记，人物 = 求和封顶 100', () => {
  const a = createCard(root, PID, { app: 'qq', account: '21001', nicknames: ['甲'] })
  const b = createCard(root, PID, { app: 'bilibili', account: '21002', nicknames: ['乙'] })
  const r = mergeCards(root, PID, [a.id, b.id])
  for (const c of groupOf(root, PID, r.main)) {
    const card = c
    card.weight = 60
    fs.writeFileSync(path.join(root, 'personas', PID, 'entities', 'cards', `${card.id}.json`), JSON.stringify(card, null, 2))
  }
  assert.equal(personWeight(root, PID, r.main), 100)
})

test('拆分：移除成员后两张独立卡', () => {
  const a = createCard(root, PID, { app: 'qq', account: '22001', nicknames: ['甲'] })
  const b = createCard(root, PID, { app: 'bilibili', account: '22002', nicknames: ['乙'] })
  mergeCards(root, PID, [a.id, b.id])
  const r = splitCard(root, PID, b.id)
  assert.equal(mainOf(root, PID, b.id), b.id)
  assert.equal(groupOf(root, PID, r.main).length, 1)
  assert.equal(groupOf(root, PID, a.id).length, 1)
})

test('管理员固定是 dsh:master：不能换成别人，也不能设为重要人物', () => {
  const master = ensureConsoleMaster(root, PID)
  const a = createCard(root, PID, { app: 'qq', account: '30001', nicknames: ['甲'] })
  const b = createCard(root, PID, { app: 'bilibili', account: '30002', nicknames: ['乙'] })

  assert.equal(currentAdmin(root).id, master.id, '管理员就是 dsh:master 那张卡')
  assert.throws(() => setPinned(root, PID, master.id, true), /管理员不能设为重要人物/)

  // 别人被标了重要，合并到管理员之后：管理员那一格不是"重要人物"，标记丢弃
  setPinned(root, PID, a.id, true)
  mergeCards(root, PID, [b.id, a.id, master.id])
  const main = mainOf(root, PID, a.id)
  assert.equal(main, master.id, '管理员永远是主卡，哪怕 id 不是最小的')
  assert.equal(currentAdmin(root).id, master.id)
  const merged = listCards(root, PID).find((c) => c.id === master.id)
  assert.equal(merged.pinned, false, '管理员不占"重要人物"那一格')
  assert.equal(listCards(root, PID).find((c) => c.id === a.id).pinned, false, '成员卡上的标记清掉')
})

test('昵称修改只影响该卡', () => {
  const c = createCard(root, PID, { app: 'qq', account: '40001', nicknames: ['阿四'] })
  setCardNicknames(root, PID, c.id, ['阿四', '四哥'])
  assert.deepEqual(listCards(root, PID).find((x) => x.id === c.id).nicknames, ['阿四', '四哥'])
})
