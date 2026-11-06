#!/usr/bin/env node
// scripts/seed-demo.mjs —— 造一份干净的演示数据，专供手动验收管理台。
//
// 为什么要有它：用 PowerShell 往 /inbox 发中文，很容易在命令行那一层被降级成 `?`
// （和原灵无关，是控制台编码的锅）。这个脚本直接用库写盘，源码是 UTF-8，
// 中间不经过任何终端编码转换，写进去的字节就是文件里的字节。
//
// 用法：
//   node scripts/seed-demo.mjs D:\yuanling
// 然后：
//   node bin/yuanling.js serve --root D:\yuanling
//   浏览器打开 http://127.0.0.1:17777

import fs from 'node:fs'
import path from 'node:path'
import { appendRecord } from '../src/core/raw.js'
import { addFact } from '../src/core/memory.js'
import { readMarker } from '../src/core/persona.js'
import { scan } from '../src/core/proposals.js'
import { localIso } from '../src/core/fsx.js'
import { createPerson, findByIdentity, linkIdentity, readProfile, writeProfile } from '../src/core/entities.js'

const arg = process.argv[2] ?? process.env.YUANLING_HOME
if (!arg) {
  console.error('用法：node scripts/seed-demo.mjs <数据目录>')
  process.exit(1)
}

const root = path.resolve(arg)
if (!fs.existsSync(root)) {
  console.error(`数据目录不存在：${root}`)
  console.error('先跑：node bin/yuanling.js init --root "' + root + '"')
  process.exit(1)
}

const marker = readMarker(root)
const pid = marker?.active
if (!pid) {
  console.error('没有激活人格，先跑 yuanling init')
  process.exit(1)
}

const daysAgo = (n) => localIso(new Date(Date.now() - n * 86_400_000))

function post(text, channel = 'private:10001') {
  const r = appendRecord(root, {
    source: 'qq',
    acct: 'demo',
    channel,
    actor: { kind: 'owner', id: '10001', name: '主人' },
    role: 'user',
    text,
    ts: localIso(),
  })
  return `${r.file}#${r.id}`
}

// ── 1) 一条普通事实（用来试"屏蔽"）──────────────────────────────────
const p1 = post('今天备份脚本跑到一半断了')
const a = addFact(root, pid, { topic: '备份', text: '备份脚本的定时任务被宿主收走了', src: p1 })
console.log(`✓ 事实 ${a.fact.id}${a.added ? '' : '（已存在）'}`)
console.log(`  证据 ${p1}`)

// ── 2) 一句反复说了 5 天的话（用来试"提案"）──────────────────────────
const p2 = post('原文：别用颜文字')
for (let i = 0; i < 5; i += 1) {
  addFact(root, pid, { topic: '说话方式', text: '别用颜文字', src: p2, now: daysAgo(4 - i) })
}

const created = scan(root, pid)
if (created.length) {
  for (const p of created) console.log(`✓ 提案 ${p.id}：${p.claim}（${p.count} 次 / ${p.days} 天）`)
} else {
  console.log('· 没有新提案（可能已经提过了）')
}

// ── 3) 一个人物（用来试"编辑素描"）──────────────────────────────────
let person = findByIdentity(root, 'qq', '12345')
if (!person) {
  const p = createPerson(root, { display: '张三' })
  linkIdentity(root, p.uid, { platform: 'qq', id: '12345' })
  person = { uid: p.uid }
  console.log(`✓ 人物 ${p.uid}（张三 · qq:12345）`)
} else {
  console.log(`· 人物已存在：${person.uid}`)
}

if (!readProfile(root, pid, person.uid)?.sketch) {
  writeProfile(root, pid, person.uid, {
    sketch: '说话短，爱用草，晚上活跃；不爱被问家里的事',
    __reason: '演示数据',
  })
  console.log('✓ 人物素描（可以在页面上改）')
}

console.log('')
console.log('下一步：')
console.log(`  node bin/yuanling.js serve --root "${root}"`)
console.log('  打开 http://127.0.0.1:17777')
