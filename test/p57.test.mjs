// test/p57.test.mjs —— 名字唯一：人物在全局唯一，群体在同一人格内唯一。
//
// 为什么要这条：重名会让人物页、群体页和注入都分不清谁是谁。
// 遇到重名**不静默改名**——把冲突的人/群告诉调用方，让它自己按描述另起一个。
import { test, before } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { scaffold } from '../src/core/scaffold.js'
import { createPersona } from '../src/core/persona.js'
import {
  createPerson,
  writeProfile,
  readProfile,
  createPersonWithCard,
  personNameOwner,
} from '../src/core/entities.js'
import { createGroupWithCard, writeGroup, readGroup, groupNameOwner } from '../src/core/groups.js'

const PID = 'yuanling'
let root

before(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'yuanling-p57-'))
  scaffold(root, {})
})

test('人物：重名会被拒绝，并指出是谁占了', () => {
  createPerson(root, { display: '张三' })
  assert.throws(() => createPerson(root, { display: '张三' }), /已经有人用了/)
  assert.throws(() => createPerson(root, { display: ' 张三 ' }), /已经有人用了/, '前后空格算同一个名字')
  assert.throws(() => createPerson(root, { display: 'Zhang San' }) && createPerson(root, { display: 'zhang san' }), /已经有人用了/)

  const owner = personNameOwner(root, '张三')
  assert.ok(owner)
  assert.throws(() => createPerson(root, { display: '张三' }), new RegExp(owner.uid))
})

test('人物：改名撞到别人会被拒绝；改回自己的名字 / 大小写不算改', () => {
  const a = createPerson(root, { display: '李四' })
  createPerson(root, { display: '王五' })

  writeProfile(root, PID, a.uid, { sketch: '话少' })
  assert.throws(() => writeProfile(root, PID, a.uid, { display: '王五' }), /已经有人用了/)

  // 改成自己现在这个名字（或只差大小写）不该拦
  writeProfile(root, PID, a.uid, { display: '李四' })
  assert.equal(readProfile(root, PID, a.uid).display, '李四')
})

test('人物：改名成功之后，旧名字可以给别人用', () => {
  const p = createPerson(root, { display: '旧名' })
  writeProfile(root, PID, p.uid, { display: '新名' })
  createPerson(root, { display: '旧名' }) // 不该抛
})

test('人物：影子卡不参与唯一性（只见过、还没认识的人没有名字可占）', () => {
  // 影子卡是核心按账号自动建的，不是人起的名字
  const identitiesPath = path.join(root, 'personas', PID, 'entities', 'identities.json')
  const data = JSON.parse(fs.readFileSync(identitiesPath, 'utf8'))
  data.people.person_shadow_1 = {
    uid: 'person_shadow_1',
    display: '10001',
    aliases: [],
    identities: [{ platform: 'telegram', id: '10001' }],
    created: new Date().toISOString(),
    tier: 'shadow',
  }
  fs.writeFileSync(identitiesPath, JSON.stringify(data, null, 2), 'utf8')

  assert.equal(personNameOwner(root, '10001'), null, '影子卡不占名字')
  const p = createPerson(root, { display: '10001' })
  assert.equal(readProfile(root, PID, p.uid), null)
})

test('人物：新增时重名，创建流程会失败且不留下半张卡', () => {
  createPerson(root, { display: '赵六' })
  const before = Object.keys(JSON.parse(fs.readFileSync(path.join(root, 'personas', PID, 'entities', 'identities.json'), 'utf8')).people).length
  assert.throws(
    () => createPersonWithCard(root, PID, { display: '赵六', identityText: 'QQ 号是 70001' }),
    /已经有人用了/,
  )
  const after = Object.keys(JSON.parse(fs.readFileSync(path.join(root, 'personas', PID, 'entities', 'identities.json'), 'utf8')).people).length
  assert.equal(after, before, '不能留下一个只有名字的空卡')
})

test('群体：同一人格内重名被拒绝', () => {
  createGroupWithCard(root, PID, { name: '摸鱼群', accountText: 'QQ群 111111' })
  assert.throws(
    () => createGroupWithCard(root, PID, { name: '摸鱼群', accountText: 'QQ群 222222' }),
    /已经有人用了/,
  )
  // 差一个空格也算重名
  assert.throws(
    () => createGroupWithCard(root, PID, { name: ' 摸鱼群 ', accountText: 'QQ群 333333' }),
    /已经有人用了/,
  )
})

test('群体：不同人格各叫各的（群体卡按人格存）', () => {
  createPersona(root, 'other', '另一个人格')
  // PID 里已经有「摸鱼群」；另一个 人格里用同一个名字应该可以
  const g = createGroupWithCard(root, 'other', { name: '摸鱼群', accountText: 'QQ群 444444' })
  assert.equal(g.name, '摸鱼群')
  assert.equal(groupNameOwner(root, 'other', '摸鱼群')?.gid, g.gid)
})

test('群体：改名撞到同人格里别的群会被拒绝；改成自己原名不算改', () => {
  const a = createGroupWithCard(root, PID, { name: '甲群', accountText: 'QQ群 555555' })
  createGroupWithCard(root, PID, { name: '乙群', accountText: 'QQ群 666666' })

  assert.throws(() => writeGroup(root, PID, a.gid, { name: '乙群' }), /已经有人用了/)
  writeGroup(root, PID, a.gid, { name: '甲群' })
  assert.equal(readGroup(root, PID, a.gid).name, '甲群')

  // 改成新名字之后，旧名字可以给别人
  writeGroup(root, PID, a.gid, { name: '甲群（新）' })
  createGroupWithCard(root, PID, { name: '甲群', accountText: 'QQ群 777777' })
})

test('人物与群体可以同名（两个不同的类别）', () => {
  createPerson(root, { display: '原神' })
  createGroupWithCard(root, PID, { name: '原神', accountText: '贴吧 原神吧' })
})
