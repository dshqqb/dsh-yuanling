// test/p13.test.mjs —— 人物权重：只算与 AI 的互动；自动分、手动覆写、幂等。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { scaffold } from '../src/core/scaffold.js'
import { appendRecord } from '../src/core/raw.js'
import { localIso, ulid } from '../src/core/fsx.js'
import { createPerson, linkIdentity, writeProfile, readProfile } from '../src/core/entities.js'
import {
  WEIGHT,
  interactionStats,
  computeWeight,
  refreshWeights,
  setManualWeight,
  clearManualWeight,
} from '../src/core/weights.js'
import { history } from '../src/core/version.js'
import { buildCard } from '../src/core/memory.js'

const PID = 'yuanling'

function tmpRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'yuanling-p13-'))
  scaffold(root, {})
  return root
}

function seedMsg(root, { id = '12345', channel = 'private:12345', ts = localIso(), role = 'user', text = null } = {}) {
  return appendRecord(root, {
    source: channel.startsWith('bili:') ? 'bili' : 'qq',
    acct: '10001',
    channel,
    actor: { kind: 'member', id, name: `用户${id}` },
    role,
    // 文本必须唯一：同秒同文会被 raw 的 h 去重吃掉，条数就对不上了
    text: text ?? `第${ulid()}条`,
    ts,
  })
}

const daysAgo = (n) => localIso(new Date(Date.now() - n * 86_400_000))

function mkPerson(root, { display = '张三', qq = '12345' } = {}) {
  const p = createPerson(root, { display })
  if (qq) linkIdentity(root, p.uid, { platform: 'qq', id: qq })
  writeProfile(root, PID, p.uid, { sketch: '测试' })
  return p.uid
}

test('stats：只算私聊，群聊里跟别人说话不算', () => {
  const root = tmpRoot()
  seedMsg(root, { channel: 'private:12345' })
  seedMsg(root, { channel: 'private:12345' })
  seedMsg(root, { channel: 'group:999' })
  seedMsg(root, { channel: 'group:999' })

  const person = { identities: [{ platform: 'qq', id: '12345' }] }
  const s = interactionStats(root, person)
  assert.equal(s.msgs, 2)
})

test('stats：她自己的话（role=bot）不算他的互动', () => {
  const root = tmpRoot()
  seedMsg(root, { role: 'user' })
  seedMsg(root, { role: 'bot' })

  const s = interactionStats(root, { identities: [{ platform: 'qq', id: '12345' }] })
  assert.equal(s.msgs, 1)
})

test('stats：活跃天数按不同日期数', () => {
  const root = tmpRoot()
  seedMsg(root, { ts: daysAgo(5) })
  seedMsg(root, { ts: daysAgo(5) })
  seedMsg(root, { ts: daysAgo(2) })
  seedMsg(root, { ts: daysAgo(0) })

  const s = interactionStats(root, { identities: [{ platform: 'qq', id: '12345' }] })
  assert.equal(s.msgs, 4)
  assert.equal(s.days, 3)
  assert.equal(s.recent, 4)
})

test('computeWeight：公式与封顶', () => {
  assert.equal(computeWeight({ msgs: 4, days: 3, recent: 4 }), Math.round(4 * 0.5 + 3 * 1 + 4 * 0.3))
  assert.equal(computeWeight({ msgs: 1000, days: 100, recent: 1000 }), WEIGHT.cap)
})

test('refresh：写入权重并标 auto；没变化就不写版本', () => {
  const root = tmpRoot()
  const uid = mkPerson(root)
  for (let i = 0; i < 3; i += 1) seedMsg(root, { ts: daysAgo(3 - i) })

  const first = refreshWeights(root, PID)
  const row = first.find((x) => x.uid === uid)
  assert.equal(row.source, 'auto')
  assert.equal(row.changed, true)
  assert.equal(readProfile(root, PID, uid).weight, row.weight)

  const rel = `personas/${PID}/entities/people/${uid}.json`
  const before = history(root, rel).length

  const second = refreshWeights(root, PID)
  assert.equal(second.find((x) => x.uid === uid).changed, false, '值没变不该再写')
  assert.equal(history(root, rel).length, before, '不该产生新版本')
})

test('manual：手动权重不会被自动分覆盖', () => {
  const root = tmpRoot()
  const uid = mkPerson(root)
  for (let i = 0; i < 10; i += 1) seedMsg(root)

  setManualWeight(root, PID, uid, 77)
  const rows = refreshWeights(root, PID)
  assert.equal(rows.find((x) => x.uid === uid).source, 'manual')
  assert.equal(readProfile(root, PID, uid).weight, 77)
})

test('manual：恢复自动后，下一次 refresh 会重算', () => {
  const root = tmpRoot()
  const uid = mkPerson(root)
  seedMsg(root)
  setManualWeight(root, PID, uid, 90)

  clearManualWeight(root, PID, uid)
  const rows = refreshWeights(root, PID)
  const row = rows.find((x) => x.uid === uid)
  assert.equal(row.source, 'auto')
  assert.ok(row.weight < 90, '应该按真实互动重算，而不是留着 90')
})

test('refresh：没有档案的人不参与（她还没认识他）', () => {
  const root = tmpRoot()
  const p = createPerson(root, { display: '没档案' })
  linkIdentity(root, p.uid, { platform: 'qq', id: '777' })

  const rows = refreshWeights(root, PID)
  assert.equal(rows.length, 0)
})

test('buildCard：权重高的人排在前面', () => {
  const root = tmpRoot()
  const a = createPerson(root, { display: '低权重' })
  linkIdentity(root, a.uid, { platform: 'qq', id: '111' })
  writeProfile(root, PID, a.uid, { sketch: '淡淡的', weight: 5 })

  const b = createPerson(root, { display: '高权重' })
  linkIdentity(root, b.uid, { platform: 'qq', id: '222' })
  writeProfile(root, PID, b.uid, { sketch: '很重要', weight: 95 })

  const line = buildCard(root, PID).split('\n').find((l) => l.startsWith('[人物]'))
  assert.ok(line.indexOf('高权重') < line.indexOf('低权重'))
})
