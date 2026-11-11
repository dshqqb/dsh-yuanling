// test/p70.test.mjs —— 人格隔离的最后一刀：除原始层外，所有人格数据都在 personas/<id>/
//
// 用户定的（2026-11-11，Q33=B）：
//   · 人物 ↔ 账号、群体 ↔ 群号，都是**这个角色的认知**（会有误差），所以跟人格走；
//   · 名称唯一性也只在人格内成立；
//   · 目标：**复制粘贴 personas/<id>/ 就能迁移人格**，不需要再搬 system/。
import { test, before } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { scaffold } from '../src/core/scaffold.js'
import { createPersona, switchPersona, readMarker } from '../src/core/persona.js'
import {
  createPerson,
  linkIdentity,
  writeProfile,
  loadIdentities,
  findByIdentity,
  personNameOwner,
  addCandidate,
} from '../src/core/entities.js'
import { ensureGroupScene, readGroupIdentity } from '../src/core/channels.js'
import { ensureGroup, readGroup } from '../src/core/groups.js'
import { noteGroupMember } from '../src/core/groups.js'
import { ingest } from '../src/core/inbox.js'
import { localIso } from '../src/core/fsx.js'

let root

before(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'yuanling-p70-'))
  scaffold(root, {})
})

const idPath = (r, pid) => path.join(r, 'personas', pid, 'entities', 'identities.json')
const groupIdPath = (r, pid) => path.join(r, 'personas', pid, 'entities', 'group-identities.json')

test('骨架：身份登记在人格目录里，system/ 不再有', () => {
  assert.ok(fs.existsSync(idPath(root, 'yuanling')))
  assert.ok(fs.existsSync(groupIdPath(root, 'yuanling')))
  assert.equal(fs.existsSync(path.join(root, 'system', 'identities.json')), false)
  assert.equal(fs.existsSync(path.join(root, 'system', 'groups.json')), false)
})

test('不同人格的账号认知互不干扰：同一个 QQ 号是两张不同的人物卡', () => {
  const uidA = (() => {
    const p = createPerson(root, { display: '张三个人' })
    linkIdentity(root, p.uid, { platform: 'qq', id: '55555' })
    writeProfile(root, 'yuanling', p.uid, { sketch: 'A 眼里的他' })
    return p.uid
  })()

  createPersona(root, 'other', '另一个人格')
  switchPersona(root, 'other')

  assert.equal(findByIdentity(root, 'qq', '55555'), null, '新人格里还没有这个号')
  const pB = createPerson(root, { display: '张三个人' })
  linkIdentity(root, pB.uid, { platform: 'qq', id: '55555' })
  writeProfile(root, 'other', pB.uid, { sketch: 'B 眼里的他' })
  assert.notEqual(pB.uid, uidA, '两个人格各自给同一个号建卡，编号互不相干')

  // 切回去，A 的认知还在
  switchPersona(root, 'yuanling')
  assert.equal(findByIdentity(root, 'qq', '55555')?.uid, uidA)
  assert.equal(loadIdentities(root).people[pB.uid], undefined, 'A 不认识 B 建的那张卡')
})

test('名称唯一只在人格内成立（不同人格可以有同名人物）', () => {
  const other = readMarker(root).personas.find((p) => p.id === 'other')
  assert.ok(other)
  switchPersona(root, 'other')
  // other 里已经有一个「张三个人」，同人格内再建同名要失败
  assert.throws(() => createPerson(root, { display: '张三个人' }), /已经有人用了/)
  switchPersona(root, 'yuanling')
  // yuanling 里也有一个「张三个人」——两个人格各有一张，互不冲突
  assert.ok(personNameOwner(root, '张三个人'))
})

test('群体：同一个 QQ 群在不同人格里是不同编号（各叫各的）', () => {
  const gidA = ensureGroupScene(root, { platform: 'qq', nativeId: '666666' })
  assert.match(gidA, /^grp_/)
  assert.equal(readGroupIdentity(root, gidA)?.nativeId, '666666')

  switchPersona(root, 'other')
  const gidB = ensureGroupScene(root, { platform: 'qq', nativeId: '666666' })
  assert.notEqual(gidB, gidA, '人格之间的群体编号不共享')
  assert.equal(readGroupIdentity(root, gidB)?.nativeId, '666666')
  switchPersona(root, 'yuanling')
  assert.equal(readGroupIdentity(root, gidA)?.nativeId, '666666', 'A 的登记没被 B 改掉')
})

test('候选身份也按人格存（不多不少地跟着目录走）', () => {
  switchPersona(root, 'other')
  addCandidate(root, { platform: 'bili', id: 'cand-in-other', reason: '测试' })
  switchPersona(root, 'yuanling')
  assert.equal(loadIdentities(root).pending.length, 0, 'A 不该看到 B 的候选')
  switchPersona(root, 'other')
  assert.ok(loadIdentities(root).pending.some((c) => String(c.id) === 'cand-in-other'))
  switchPersona(root, 'yuanling')
})

test('迁移：把 personas/<id>/ 整个拷到新数据目录，人物/群体的认知都还在', () => {
  // 新目录：只建骨架（同一个人格 id），然后把人格目录整个覆盖过去
  const target = fs.mkdtempSync(path.join(os.tmpdir(), 'yuanling-p70-copy-'))
  scaffold(target, {})
  const src = path.join(root, 'personas', 'yuanling')
  fs.rmSync(path.join(target, 'personas', 'yuanling'), { recursive: true, force: true })
  fs.cpSync(src, path.join(target, 'personas', 'yuanling'), { recursive: true })

  const ids = loadIdentities(target)
  assert.equal(findByIdentity(target, 'qq', '55555')?.uid, findByIdentity(root, 'qq', '55555')?.uid)
  assert.equal(Object.keys(ids.people).length, Object.keys(loadIdentities(root).people).length)

  const gid = Object.keys(JSON.parse(fs.readFileSync(groupIdPath(target, 'yuanling'), 'utf8')).groups)[0]
  assert.ok(gid, '群体登记也一起带过去了')
  assert.equal(readGroupIdentity(target, gid)?.platform, 'qq')
})

test('成员名单：入库时按"当前人格"记，不会串到别人格', () => {
  const gid = ensureGroupScene(root, { platform: 'qq', nativeId: '777777' })
  ensureGroup(root, 'yuanling', gid, { name: '成员群A' })
  const p = createPerson(root, { display: '本群群友' })
  linkIdentity(root, p.uid, { platform: 'qq', id: '88888' })
  writeProfile(root, 'yuanling', p.uid, { sketch: 'x' })
  noteGroupMember(root, 'yuanling', gid, p.uid)

  assert.ok((readGroup(root, 'yuanling', gid)?.members ?? []).includes(p.uid))

  switchPersona(root, 'other')
  const gidB = ensureGroupScene(root, { platform: 'qq', nativeId: '777777' })
  assert.equal(readGroup(root, 'other', gidB), null, 'B 还没收到过这个消息，不该有卡')
  switchPersona(root, 'yuanling')

  // 走一次真实入库，确认不串人格
  ingest(root, {
    v: 1,
    source: 'qq',
    acct: '1',
    items: [{ ts: localIso(), channel: `group:${gid}`, kind: 'msg', role: 'user', actor: { kind: 'member', id: '88888', name: '本群群友' }, text: '我来了' }],
  })
  assert.ok((readGroup(root, 'yuanling', gid)?.members ?? []).includes(p.uid))
})
