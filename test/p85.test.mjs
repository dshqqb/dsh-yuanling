import { test, before } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { scaffold } from '../src/core/scaffold.js'
import { createCard, mergeCards, mainOf, groupOf } from '../src/core/accounts.js'
import { ensureConsoleMaster, consoleHistory, appendConsoleHistory, CONSOLE_MASTER_ID, consoleDir, recordConsoleUser, recordConsoleAssistant } from '../src/core/console.js'
import { listDays, readDay } from '../src/core/raw.js'

const PID = 'yuanling'
let root

before(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'yuanling-p85-'))
  scaffold(root, {})
})

test('master：app=dsh / account=master，固定最小 id', () => {
  const card = ensureConsoleMaster(root, PID)
  assert.equal(card.app, 'dsh')
  assert.equal(card.account, 'master')
  assert.equal(card.id, CONSOLE_MASTER_ID)
  assert.equal(ensureConsoleMaster(root, PID).id, card.id)
})

test('master：合并后仍是主卡，哪怕旧卡 id 字典序更小', () => {
  const old = createCard(root, PID, { app: 'qq', account: 'old-smaller', id: 'acct_00000000000000000000000000', nicknames: ['旧卡'] })
  const master = ensureConsoleMaster(root, PID)
  const r = mergeCards(root, PID, [old.id, master.id])
  assert.equal(r.main, master.id)
  assert.equal(mainOf(root, PID, old.id), master.id)
  assert.equal(groupOf(root, PID, old.id).length, 2)
})

test('history：chat/test 分开存，测试不经过 raw', () => {
  appendConsoleHistory(root, PID, 'chat', { role: 'user', text: '正常' })
  appendConsoleHistory(root, PID, 'test', { role: 'assistant', text: '测试', test: true })
  assert.equal(consoleHistory(root, PID, 'chat').at(-1).text, '正常')
  assert.equal(consoleHistory(root, PID, 'test').at(-1).test, true)
  assert.ok(fs.existsSync(path.join(consoleDir(root, PID, 'chat'), 'history.jsonl')))
  assert.ok(fs.existsSync(path.join(consoleDir(root, PID, 'test'), 'history.jsonl')))
})

test('raw：正常对话 user + assistant 都写 source=dsh，场景指向 master', () => {
  const master = ensureConsoleMaster(root, PID)
  recordConsoleUser(root, PID, master, { text: '你好', turnId: 't1', ts: '2026-11-14T09:00:00+08:00' })
  recordConsoleAssistant(root, PID, master, { text: '在', turnId: 't1', ts: '2026-11-14T09:00:01+08:00' })
  const day = listDays(root).at(-1)
  const rows = readDay(root, day).filter((r) => r.ext?.message_id?.startsWith('t1-'))
  assert.equal(rows.length, 2)
  assert.equal(rows[0].source, 'dsh')
  assert.equal(rows[0].channel, `private:${master.id}`)
  assert.equal(rows[0].role, 'user')
  assert.equal(rows[1].role, 'bot')
})
