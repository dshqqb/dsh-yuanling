// src/core/inbox.js —— 生产者投递区：文件 + HTTP 两个入口，同一套规范化。
//
// 契约（文档 §6.1）：
//   { v:1, source:"qq", acct:"10001", items:[{ ts, channel, actor, role, kind, text, ... }] }
// 只有本进程写 raw；生产者只投递。
import fs from 'node:fs'
import path from 'node:path'
import { exists, ensureDir, readJson, appendLine, localIso } from './fsx.js'
import { P } from './paths.js'
import { appendRecord } from './raw.js'
import { applyIngestPolicy, loadIngestRules } from './redact.js'
import { canIngest, logRefusal } from './rules.js'
import { readMarker } from './persona.js'
import { ensureGroup, gidForChannel, noteGroupMember } from './groups.js'
import { ensureSenderPerson, isShadow, canonicalChannelForIngest, platformFromSource } from './channels.js'
import { appendEvent } from './events.js'
import { noteDriveHits } from './drives.js'
import { extractFacts, shouldExtract, EXTRACT_IMPORTANCE } from './extract.js'
import { noteGroupMessage, herNames, isReplyToHer } from './engage.js'
import { noteSelfNameCandidate, herPlatformIds, addressesHer } from './selfname.js'
import { addFact } from './memory.js'
import { parseChannel } from './channels.js'
import { ensurePersonProfile, findByIdentity, noteFriendship } from './entities.js'
/**
 * 从一条刚入库的消息里提炼事实。
 *
 * 判据（用户定）：
 *   · 私聊：**所有**私聊都提炼——不管说话的是不是管理员，私聊本身就是跟她说话；
 *   · 群聊：只有"跟她有关"的才提炼。她没被提到、也没开口，那这个群聊跟她无关，
 *     不记（哪怕说话的是管理员）；
 *   · 她自己的话不是事实（role=bot 跳过），但她说话会开启"在场"。
 */
function extractFromRecord(root, pid, { text, role, channel, actorId = '', source, pointer, now, replyTo = '' }) {
  const isBot = String(role ?? 'user') === 'bot'
  const { kind, id } = parseChannel(channel)
  let allowed = false

  if (kind === 'private') {
    allowed = !isBot
  } else if (kind === 'group') {
    // 群里说话的人：用 `<平台>:<原生号>` 当键。**不用 person uid**——
    // 群里大多数成员没有人物卡，硬查要么查不到、要么逼着给每个群友建影子卡。
    const actorKey = actorId ? `${source || 'qq'}:${String(actorId)}` : ''
    // 引用回复她 = 在叫她：正文里往往没有名字（「你觉得呢」），只靠关键词会漏
    const replyToHer = isReplyToHer(root, replyTo)
    const r = noteGroupMessage(root, { gid: id, text, actorKey, isBot, replyToHer, now, names: herNames(root, pid) })
    allowed = r.engaged
  }

  if (!allowed) return []
  if (!shouldExtract({ role, text })) return []

  const facts = extractFacts(text)
  const written = []
  for (const f of facts) {
    try {
      addFact(root, pid, {
        topic: f.topic,
        text: f.text,
        src: pointer,
        kind: 'extracted',
        imp: EXTRACT_IMPORTANCE,
        person: null,
      })
      written.push(f)
    } catch {
      /* 单条失败不拖垮整批 */
    }
  }
  return written
}

export const INBOX_VERSION = 1

/** 规范化并校验信封。未知版本拒收；未知字段忽略。 */
export function normalizeEnvelope(env) {
  if (!env || typeof env !== 'object') throw new Error('信封必须是对象')
  const v = Number(env.v ?? 0)
  if (v !== INBOX_VERSION) throw new Error(`不支持的 inbox 版本：${env.v}（本插件支持 ${INBOX_VERSION}）`)
  const source = String(env.source ?? '').trim()
  if (!source) throw new Error('信封缺少 source')
  const acct = String(env.acct ?? 'default')
  const items = Array.isArray(env.items) ? env.items : []
  if (!items.length) throw new Error('信封里没有任何 items')
  return { v, source, acct, items }
}

/**
 * 摄入一个信封。
 *
 * `withRecords` 是给 v1.1 的 `source.fetch` 用的：那条链路要把「刚落进哪一行」
 * 回给调用方（模型看到的是指针，不是计数）。默认不带，是因为 /inbox 的响应
 * 不该因为内部多了个需求就变大。
 *
 * @returns {{accepted:number, deduped:number, skipped:number, errors:string[], records?:Array}}
 */
export function ingest(root, env, { now, maxBytes, withRecords = false, withItems = false } = {}) {
  const { source, acct, items } = normalizeEnvelope(env)
  const rules = loadIngestRules(root)
  const out = { accepted: 0, deduped: 0, skipped: 0, errors: [] }
  if (withRecords) out.records = []
  // v1.7：按入参顺序回执每一条的 canonical channel（模块拿它去 egress / 开 DSH 回合）。
  // 只有 ingest 走模块通道时才带，HTTP /inbox 的响应不该因此变大。
  if (withItems) out.items = new Array(items.length).fill(null)

  for (let i = 0; i < items.length; i += 1) {
    const item = items[i]
    try {
      const channelIn = String(item.channel ?? 'unknown')

      // 频道一律换成内部编号（private:<person_uid> / group:<gid>）。
      // 外部号码不进频道——但必须留痕，所以下面写 raw 时同时给 channel_native。
      // 私聊来源还没有人物卡时，这里会建一张影子卡（tier=shadow，不进注入）。
      let canonical = { channel: channelIn, native: null, personUid: null, gid: null }
      try {
        canonical = canonicalChannelForIngest(root, {
          channel: channelIn,
          source,
          actorName: item.actor?.name ?? '',
          // 她自己的话不建人物卡（协议 §5.1.1 的 role:"bot"）
          createPerson: String(item.role ?? 'user') !== 'bot',
        })
      } catch {
        // 归人失败（比如缺 id）不该丢这条消息：退回原频道，让它带着老形状进 raw
        canonical = { channel: channelIn, native: null, personUid: null, gid: null }
      }
      const channel = canonical.channel
      const rawText = String(item.text ?? '')

      // v1.7：这句是不是**冲她说的**。模块拿它决定群聊要不要开 DSH 回合；
      // 顺便给"建路人卡"用，不再算第二遍。私聊恒为真；她说的话恒为假。
      const isBot = String(item.role ?? 'user') === 'bot'
      const kind = parseChannel(channel).kind
      let directed = false
      if (!isBot) {
        if (kind === 'private') directed = true
        else if (kind === 'group') {
          directed = directedAtHer(root, readMarker(root)?.active, rawText, {
            replyTo: item.reply_to ?? item.replyTo ?? '',
            selfIds: [acct],
          })
        }
      }
      const report = withItems
        ? { channel, native: canonical.native || '', directed, deduped: false, skipped: false, record: null }
        : null
      if (withItems) out.items[i] = report

      // 私聊：适配器说"这个号是好友"就记在身份上（群聊的在下面建完影子卡再记）。
      if (item.actor?.friend && canonical.personUid && item.actor?.id) {
        try {
          noteFriendship(root, canonical.personUid, platformFromSource(source) ?? 'qq', String(item.actor.id), {
            remark: item.actor.remark ?? '',
          })
        } catch {
          /* 好友关系写不进去不该挡消息 */
        }
      }

      // 硬线：guardrails.never_record 命中的内容，连 raw 都不进。
      const guard = canIngest(root, channel, rawText)
      if (!guard.ok) {
        countSkip(root, source)
        logRefusal(root, null, { dim: 'ingest', action: 'record', channel, reason: guard.reason })
        appendEvent(root, {
          kind: 'refusal',
          level: 'warn',
          actor: `source:${source}`,
          text: `摄入被硬线拦下（${channel}）：${guard.reason}`,
          data: { channel, dim: 'ingest' },
        })
        out.skipped += 1
        continue
      }

      const policy = applyIngestPolicy(rawText, {
        channel,
        channelNative: canonical.native || '',
        gid: canonical.gid || '',
        rules,
      })

      if (policy.skip) {
        // 完全不入 raw，只留计数。计数写进当天的 day.json 之外的一个小账本，
        // 避免为了"记一条被跳过"反而把内容写进去。
        countSkip(root, source)
        out.skipped += 1
        continue
      }

      const r = appendRecord(
        root,
        {
          ...item,
          // inbox 用 kind，raw 用 type：msg → message，其余原样传
          type: item.kind === 'msg' ? 'message' : String(item.kind ?? 'message'),
          source,
          acct: item.acct ?? acct,
          channel,
          // 适配器原话（`private:10001` / `group:123555`）。没有它就再也查不回真实号码了。
          channel_native: canonical.native || undefined,
          text: policy.text,
          // 平台侧消息 id 存在 ext 里：回复判定要靠它把"被引用的那条"认回来
          ext: {
            ...(item.ext && typeof item.ext === 'object' ? item.ext : {}),
            ...(item.ext_id ? { message_id: String(item.ext_id) } : {}),
          },
          flags: [...new Set([...(Array.isArray(item.flags) ? item.flags : []), ...policy.flags])],
        },
        { now, maxBytes },
      )
      if (r.deduped) out.deduped += 1
      else out.accepted += 1
      if (report) {
        report.record = `${r.file}#${r.id}`
        report.deduped = Boolean(r.deduped)
      }

      // 消息里出现她自定义动机的关键词 → 那条动机升温。
      // 放在入库这一处（不是每轮读时算）：一条消息只到一次，热量也就只加一次。
      if (!r.deduped && typeof item.text === 'string' && item.text) {
        try {
          noteDriveHits(root, readMarker(root)?.active, item.text)
        } catch {
          /* 动机升温失败不该让入库失败 */
        }
      }

      // 群消息进来就顺手把这个"地方"记下来：第一条消息建卡，之后的只推 lastSeen。
      // 群名由适配器带上来（NapCat get_group_info）——没带就留空，以后拿到再补。
      if (!r.deduped) {
        touchGroup(root, channel, item.ts ? String(item.ts) : null, item.group_name)
        // 有人用**新称呼**叫她（@她 / 喊了个没见过的名字）：攒够了写进她自己的名称。
        // 只写"名称"，不另建昵称字段——见 selfname.js 的三道闸门。
        try {
          const pid = readMarker(root)?.active
          if (pid && parseChannel(channel).kind === 'group') {
            const actorKey = item.actor?.id ? (source || 'qq') + ':' + String(item.actor.id) : ''
            noteSelfNameCandidate(root, pid, {
              text: policy.text,
              actorKey,
              names: herNames(root, pid),
              selfIds: herPlatformIds(root),
              now: item.ts ? Date.parse(String(item.ts)) || Date.now() : Date.now(),
            })
          }
        } catch {
          /* 名称发现失败不该让一条消息丢掉 */
        }
        // 顺手记"这个人在这个群里"：提及时用成员名单裁决重名昵称，不能等页面点一次归集
        try {
          const pid = readMarker(root)?.active
          const gid = gidForChannel(root, channel)
          const actorId = item.actor?.id
          if (pid && gid && actorId && !isBot) {
            const platform = platformFromSource(source) ?? 'qq'
            // 群里说话的人也要有卡：第一次见就建一张**影子卡**（tier=shadow）——
            // 不进注入、人物页默认不显示，但"这个号是谁"从此查得到。
            // 名字取群名片/昵称（适配器从 NapCat 拿），拿不到就用号。
            const uid = ensureSenderPerson(root, {
              platform,
              nativeId: String(actorId),
              display: item.actor?.name ? String(item.actor.name) : '',
            })
            // 成员名单只收"认识的人"：影子卡不是认识，塞进名单只会让重名裁决拿路人当依据
            if (!isShadow(root, uid)) noteGroupMember(root, pid, gid, uid)
            // 好友关系是平台事实：群里说话的人也可能是她的好友
            if (item.actor?.friend) {
              try {
                noteFriendship(root, uid, platform, String(actorId), { remark: item.actor.remark ?? '' })
              } catch {
                /* 同上：写不进去不挡消息 */
              }
            }
          }
        } catch {
          /* 记成员失败不该让一条消息丢掉 */
        }
        // 跟她**直接说过话**的人，建第一份档案（影子卡 → 路人卡）。
        // 口径（用户 2026-11-12 定）：私聊每条都算；群聊只有 @ 她 / 引用回复她才算。
        // 群里旁听的人仍然只有影子卡——不然一个 500 人群一天能长出几十张路人卡。
        try {
          const pid = readMarker(root)?.active
          const actorId = item.actor?.id
          if (pid && actorId && !isBot && directed) {
            const platform = platformFromSource(source) ?? 'qq'
            const hit = findByIdentity(root, platform, String(actorId))
            if (hit) {
              ensurePersonProfile(root, pid, hit.uid, {
                display: item.actor?.name ? String(item.actor.name) : '',
                firstMet: item.ts ? String(item.ts) : null,
              })
            }
          }
        } catch {
          /* 建路人卡失败不该让一条消息丢掉 */
        }
      }

      // ── 记忆自动成长：从这条消息里提炼事实 ──────────────────────────────
      // 私聊：全部提炼（谁说的都算，私聊天然是跟她说话）。
      // 群聊：只提炼"跟她有关"的（见 engage.js 的 4 分钟滑动 / 20 分钟封顶）。
      // 事实必须挂 raw 指针——没有指针的事实不写（addFact 里强制的）。
      if (!r.deduped) {
        try {
          const pid = readMarker(root)?.active
          if (pid) extractFromRecord(root, pid, {
            text: policy.text,
            role: item.role ?? 'user',
            channel,
            actorId: item.actor?.id ?? '',
            source,
            pointer: `${r.file}#${r.id}`,
            replyTo: item.reply_to ?? item.replyTo ?? '',
            now: item.ts ? Date.parse(String(item.ts)) : Date.now(),
          })
        } catch {
          /* 提炼失败不该让入库失败 */
        }
      }
      if (withRecords) {
        out.records.push({
          id: r.id,
          file: r.file,
          deduped: Boolean(r.deduped),
          // 显示用的字段取"写进去的那份"：policy.text 是脱敏后的正文
          ts: item.ts ? String(item.ts) : (now ?? localIso()),
          actor: item.actor ?? null,
          text: policy.text,
        })
      }
    } catch (err) {
      out.errors.push(String(err?.message ?? err))
    }
  }
  if (out.errors.length === 0 && out.accepted > 0) beat(root, source, { ok: true })

  // 一批记一条事件（不是一条消息一条）：日志页要的是"这批投递发生了什么"，
  // 每句话都记一条会让事件流比消息本身还大，而且没人看得完。
  if (out.accepted > 0 || out.deduped > 0 || out.skipped > 0 || out.errors.length) {
    appendEvent(root, {
      kind: out.errors.length ? 'error' : 'ingest',
      level: out.errors.length ? 'error' : out.skipped ? 'warn' : 'info',
      actor: `source:${source}`,
      text: `接收 ${out.accepted} 条（去重 ${out.deduped}、跳过 ${out.skipped}）${out.errors.length ? `，${out.errors.length} 条出错` : ''}`,
      data: { accepted: out.accepted, deduped: out.deduped, skipped: out.skipped, errors: out.errors.slice(0, 3) },
    })
  }
  return out
}

/**
 * 群消息 → 群体档案的一笔。这里只做"记账"，不判断内容：
 * 是不是群体场景由 `gidForChannel` 说了算（私聊、module:、bili:video: 都不算）。
 * 记失败也不该挡住摄入——所以整个吞掉异常。
 */
function touchGroup(root, channel, seenAt, groupName = '') {
  try {
    const pid = readMarker(root)?.active
    if (!pid) return
    const gid = gidForChannel(root, channel)
    if (!gid) return
    const name = String(groupName ?? '').trim().slice(0, 100)
    ensureGroup(root, pid, gid, { seenAt: seenAt ?? localIso(), name })
  } catch {
    /* 群体记账失败不该让一条消息丢掉 */
  }
}

/**
 * 这句话是不是**冲着她**说的：引用回复了她，或 @ 她 / 叫了她的名字。
 *
 * 只在群聊里用来决定"要不要把这个人从影子卡升成路人卡"。
 * 私聊不需要这个判断——私聊每条都是冲她说的。
 */
function directedAtHer(root, pid, text, { replyTo = '', selfIds = [] } = {}) {
  try {
    if (isReplyToHer(root, replyTo)) return true
  } catch {
    /* raw 读不到就当没有引用 */
  }
  try {
    return addressesHer(text, {
      names: herNames(root, pid),
      selfIds: new Set([...selfIds, ...herPlatformIds(root)].map(String).filter(Boolean)),
    })
  } catch {
    return false
  }
}

function skipLedgerPath(root) {
  return path.join(root, P.inbox, '.skipped.ndjson')
}

function countSkip(root, source) {
  try {
    appendLine(skipLedgerPath(root), { ts: localIso(), source, n: 1 })
  } catch {
    /* 计数失败不该阻塞摄入 */
  }
}

/** 读被跳过的计数（只报数，不含内容）。 */
export function skipStats(root) {
  const p = skipLedgerPath(root)
  if (!exists(p)) return {}
  const out = {}
  for (const line of fs.readFileSync(p, 'utf8').split('\n')) {
    if (!line.trim()) continue
    try {
      const r = JSON.parse(line)
      out[r.source] = (out[r.source] ?? 0) + (r.n ?? 1)
    } catch {
      /* 坏行 */
    }
  }
  return out
}

/** 扫一遍 inbox 目录，消费所有投递文件后删除。 */
export function drain(root, { now, maxBytes } = {}) {
  const dir = path.join(root, P.inbox)
  if (!fs.existsSync(dir)) return { files: 0, ...emptyResult() }
  const total = { files: 0, accepted: 0, deduped: 0, skipped: 0, errors: [] }
  const names = fs
    .readdirSync(dir)
    .filter((n) => n.endsWith('.ndjson') && !n.startsWith('.'))
    .sort()

  for (const name of names) {
    const abs = path.join(dir, name)
    let text = ''
    try {
      text = fs.readFileSync(abs, 'utf8')
    } catch (err) {
      total.errors.push(`${name}: ${err?.message ?? err}`)
      continue
    }
    for (const line of text.split('\n')) {
      if (!line.trim()) continue
      try {
        const env = JSON.parse(line)
        const r = ingest(root, env, { now, maxBytes })
        total.accepted += r.accepted
        total.deduped += r.deduped
        total.skipped += r.skipped
        total.errors.push(...r.errors)
      } catch (err) {
        total.errors.push(`${name}: ${err?.message ?? err}`)
      }
    }
    try {
      fs.unlinkSync(abs)
      total.files += 1
    } catch (err) {
      total.errors.push(`${name}: 消费后删除失败 ${err?.message ?? err}`)
    }
  }
  return total
}

function emptyResult() {
  return { accepted: 0, deduped: 0, skipped: 0, errors: [] }
}

// ── 心跳 ────────────────────────────────────────────────────────────────

export function healthPath(root, source) {
  return path.join(root, P.health, `${source}.json`)
}

/** 写心跳。来源只要活着就每分钟写一次。 */
export function beat(root, source, { ok = true, lastEvent } = {}) {
  ensureDir(path.join(root, P.health))
  const p = healthPath(root, source)
  const prev = readJson(p, null)
  const now = localIso()
  const next = {
    source,
    at: now,
    ok,
    last_event: lastEvent ?? prev?.last_event ?? null,
  }
  fs.writeFileSync(p, JSON.stringify(next, null, 2) + '\n', 'utf8')
  return next
}

/**
 * 静默判定（文档 §6.5）：
 *   ok     心跳新鲜 + 最近有事件
 *   quiet  心跳新鲜但很久没事件 —— 正常，不报警
 *   silent 心跳过期 —— 可能挂了，报警
 *   absent 从没心跳 —— 来源未接入，提示
 */
export function classifyHealth(record, { now = Date.now(), staleMs = 5 * 60_000, quietMs = 60 * 60_000 } = {}) {
  if (!record?.at) return 'absent'
  const at = Date.parse(record.at)
  if (Number.isNaN(at)) return 'absent'
  if (now - at > staleMs) return 'silent'
  const last = record.last_event ? Date.parse(record.last_event) : null
  if (last === null || Number.isNaN(last)) return 'quiet'
  if (now - last > quietMs) return 'quiet'
  return 'ok'
}

/** 列出所有来源健康状态。 */
export function healthReport(root, opts = {}) {
  const dir = path.join(root, P.health)
  if (!exists(dir)) return []
  return fs
    .readdirSync(dir)
    .filter((n) => n.endsWith('.json'))
    .sort()
    .map((n) => {
      const rec = readJson(path.join(dir, n), null)
      return { source: rec?.source ?? n.replace(/\.json$/, ''), state: classifyHealth(rec, opts), at: rec?.at ?? null }
    })
}
