// src/core/migrate-accounts.js —— 旧 identities.json → 账户卡 + 人物卡（一次性）。
//
// 用户定（2026-11-13）：不做兼容，数据只有这一份；但 raw 只追加，不能重写。
// 所以迁移只新建 entities/accounts.json / persons.json / accounts/<acct>.json，
// 旧 identities.json 原样移到 entities/.migrated/ 留档。
import fs from 'node:fs'
import path from 'node:path'

import { exists, localIso, readJson, writeJsonAtomic } from './fsx.js'
import { P } from './paths.js'
import { personaFile, requirePid } from './scope.js'
import {
  createPersonRecord,
  ensureAccount,
  loadPersons,
  savePersons,
  setAccountDescription,
  setAccountFriend,
  setAccountNicknames,
  writeAccountCard,
  loadAccount,
} from './accounts.js'
import { refreshWeights } from './weights.js'

const MARK = '.accounts-v1'

function parseNative(text) {
  const t = String(text ?? '').trim()
  const m = /^(qq|wechat|weibo|bili|tieba|xhs|tg|github|dsh)\s*[:：]\s*([^\s]+)$/i.exec(t)
  return m ? { platform: m[1].toLowerCase(), id: m[2] } : null
}

/** 旧 account_texts 里除了“QQ：12345”这种重复信息之外的内容，挪进账户描述。 */
function extraTexts(person) {
  const rows = Array.isArray(person.account_texts) ? person.account_texts : []
  const out = []
  for (const row of rows) {
    const text = String(typeof row === 'string' ? row : (row?.text ?? '')).trim()
    if (!text) continue
    if (parseNative(text)) continue
    out.push(text)
  }
  return out
}

/**
 * @returns {{apply:boolean, ok:boolean, reason?:string, people:number, accounts:number, moved?:string, weights?:number}}
 */
export function migrateToAccounts(root, { apply = false } = {}) {
  const pid = requirePid(root)
  const base = path.join(root, P.personas, pid, 'entities')
  const oldPath = path.join(root, personaFile.identities(pid))
  const markPath = path.join(base, MARK)
  if (exists(markPath)) return { apply, ok: true, reason: 'already-migrated', people: 0, accounts: 0 }
  if (!exists(oldPath)) return { apply, ok: true, reason: 'no-old-identities', people: 0, accounts: 0 }

  const old = readJson(oldPath, null)
  const people = old?.people && typeof old.people === 'object' ? old.people : {}
  let accountCount = 0

  if (!apply) {
    for (const person of Object.values(people)) accountCount += (person.identities ?? []).length
    return { apply, ok: true, reason: 'dry-run', people: Object.keys(people).length, accounts: accountCount }
  }

  // 备份旧文件（不删）
  const backupDir = path.join(base, '.migrated')
  fs.mkdirSync(backupDir, { recursive: true })
  const stamp = localIso().replace(/[:.]/g, '-')
  const moved = path.join(backupDir, `identities.${stamp}.json`)
  fs.copyFileSync(oldPath, moved)

  for (const person of Object.values(people)) {
    const uid = person.uid
    const label = String(person.display ?? uid)
    // 没有账户的人也要留住（测试/手工建的空人物）
    if (!loadPersons(root, pid).persons[uid]) createPersonRecord(root, pid, { uid, label, tier: person.tier ?? null })
    const texts = extraTexts(person)
    let primary = null
    for (const identity of person.identities ?? []) {
      const platform = String(identity.platform ?? 'unknown')
      const nativeId = String(identity.id ?? '').trim()
      if (!nativeId) continue
      const r = ensureAccount(root, pid, {
        platform,
        nativeId,
        nickname: label,
        created: identity.linked_at ?? person.created ?? null,
      })
      const data = loadPersons(root, pid)
      const owner = data.persons[uid]
      if (!owner.accounts.includes(r.acct)) {
        owner.accounts = [...owner.accounts, r.acct]
        if (!owner.primary) owner.primary = r.acct
        savePersons(root, data, pid)
      }
      primary = primary ?? r.acct
      if (identity.friend) setAccountFriend(root, pid, r.acct, true)
      if (identity.remark) {
        const card = loadAccount(root, pid, r.acct)
        setAccountDescription(root, pid, r.acct, `好友备注：${identity.remark}${card?.description ? '\n' + card.description : ''}`)
      }
      accountCount += 1
    }
    if (texts.length) {
      const acct = primary ?? (loadPersons(root, pid).persons[uid]?.accounts ?? [])[0]
      if (acct) {
        const card = loadAccount(root, pid, acct)
        setAccountDescription(root, pid, acct, [card?.description, ...texts].filter(Boolean).join('\n'))
      }
    }
    // 昵称：旧 display 作为第一个昵称；空人物留 label
    const rec = loadPersons(root, pid).persons[uid]
    if (rec && rec.accounts?.length) {
      for (const acct of rec.accounts) setAccountNicknames(root, pid, acct, [label])
    }
    // tier 保留（admin / shadow）
    const data = loadPersons(root, pid)
    if (data.persons[uid]) {
      data.persons[uid].tier = person.tier ?? null
      savePersons(root, data, pid)
    }
  }

  // 账户权重从 raw 按 actor.id 重算
  refreshWeights(root, pid)
  writeJsonAtomic(markPath, { version: 1, at: localIso(), from: 'identities.json', people: Object.keys(people).length, accounts: accountCount })
  // 旧文件改名（copy 已留档）
  fs.rmSync(oldPath, { force: true })
  return { apply, ok: true, reason: 'migrated', people: Object.keys(people).length, accounts: accountCount, moved: path.relative(root, moved) }
}
