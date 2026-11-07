/**
 * yuanling —— 客户端半边：DSH 设置里的「原灵」窗口。
 *
 * 只有五件事，其余全在管理台（http://127.0.0.1:<端口>）里做：
 *   ① 总开关（开 = 注入 + 写记忆 + 起管理台；关 = 全关）
 *   ② 数据目录（可改，改完同步 MCP 的 --root，需重启）
 *   ③ 管理台地址（只读）
 *   ④ 一键打开管理台
 *   ⑤ 状态摘要（目录体检 / 激活人格 / 事实数）
 *
 * 写法说明：这是**预打包**的浏览器模块，由 DSH 的 __ModuleLoader__ 加载，
 * 只能 require('react')，没有 JSX、没有构建步骤——所以下面全是手写的 h()。
 */
// 宿主可能把同一个 bundle 执行两次（profile.bundles 与 cordis.patch.yml 各引用一次，
// id 不同时不会去重）。重复注册会让 DSH 抛 duplicate factory，整个 Web 启动失败。
//
// ⚠️ 这里**不能声明任何顶层 const/let**：宿主是按经典脚本、在同一个作用域里执行两次，
//    第二次执行会报 "Identifier 'x' has already been declared"。只能用 window 上的标记。
if (!window.__yuanlingClientLoaded) {
  window.__yuanlingClientLoaded = true
  window.__ModuleLoader__.load({
  // ⚠️ id **必须等于包名**（dsh-yuanling）。宿主按这个 id 认领客户端，
  //    对不上只会报 "import failed"，renderer 里一行都不打印（踩了三次）。
  id: 'dsh-yuanling',
  factory: (require) => {
    const module = { exports: {} }
    const exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    const React = require('react')
    const { createElement: h, useCallback, useEffect, useState } = React

    const API = '/dsh-yuanling/api'

    /** 复制到剪贴板。dsh-app:// 不一定是安全上下文，clipboard API 可能没有 → 退回 execCommand。 */
    async function copyText(text) {
      if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
        await navigator.clipboard.writeText(text)
        return
      }
      const ta = document.createElement('textarea')
      ta.value = text
      ta.style.position = 'fixed'
      ta.style.opacity = '0'
      document.body.appendChild(ta)
      ta.select()
      document.execCommand('copy')
      ta.remove()
    }

    async function api(method = 'GET', body = null) {
      const init = { method, headers: {} }
      if (body) {
        init.headers['content-type'] = 'application/json'
        init.body = JSON.stringify(body)
      }
      const res = await fetch(API, init)
      const data = await res.json().catch(() => ({ ok: false, error: `HTTP ${res.status}` }))
      if (!res.ok || data.ok === false) throw new Error(data?.error || `HTTP ${res.status}`)
      return data
    }

    // ── 样式：只用内联，不引 CSS（客户端拿不到样式文件） ─────────────────
    const S = {
      wrap: { display: 'flex', flexDirection: 'column', gap: '18px', padding: '4px 0 8px' },
      row: { display: 'flex', alignItems: 'center', gap: '12px', flexWrap: 'wrap' },
      label: { minWidth: '96px', fontSize: '13px', opacity: 0.75 },
      hint: { fontSize: '12px', opacity: 0.6, marginTop: '6px', lineHeight: 1.5 },
      input: {
        flex: 1,
        minWidth: '260px',
        padding: '7px 10px',
        borderRadius: '10px',
        border: '1px solid rgba(128,128,128,0.35)',
        background: 'transparent',
        color: 'inherit',
        font: 'inherit',
      },
      btn: {
        padding: '7px 14px',
        borderRadius: '10px',
        border: '1px solid rgba(128,128,128,0.35)',
        background: 'transparent',
        color: 'inherit',
        cursor: 'pointer',
        font: 'inherit',
      },
      card: {
        border: '1px solid rgba(128,128,128,0.28)',
        borderRadius: '14px',
        padding: '14px 16px',
        display: 'flex',
        flexDirection: 'column',
        gap: '10px',
      },
      ok: { color: '#2f9e44', fontSize: '12px' },
      bad: { color: '#e03131', fontSize: '12px' },
    }

    function Radio({ checked, onChange, children }) {
      return h(
        'label',
        { style: { display: 'inline-flex', alignItems: 'center', gap: '6px', cursor: 'pointer', fontSize: '13px' } },
        h('input', { type: 'radio', checked, onChange }),
        children,
      )
    }

    function YuanlingSection() {
      const [state, setState] = useState(null)
      const [dirDraft, setDirDraft] = useState('')
      const [busy, setBusy] = useState(false)
      const [msg, setMsg] = useState('')

      const load = useCallback(async () => {
        try {
          const d = await api()
          setState(d)
          setDirDraft(d.config?.dataDir ?? '')
        } catch (error) {
          setMsg(`读取失败：${String(error?.message ?? error)}`)
        }
      }, [])

      useEffect(() => {
        load()
      }, [load])

      const save = useCallback(
        async (patch) => {
          setBusy(true)
          setMsg('')
          try {
            const d = await api('POST', patch)
            const bits = ['已保存']
            if (d.mcp?.changed) bits.push('MCP 条目已同步数据目录')
            if (d.restartRequired) bits.push('需重启 DSH 生效')
            setMsg(bits.join(' · '))
            await load()
          } catch (error) {
            setMsg(`保存失败：${String(error?.message ?? error)}`)
          } finally {
            setBusy(false)
          }
        },
        [load],
      )

      if (!state) {
        return h('div', { style: S.wrap }, h('div', { style: S.hint }, msg || '读取中…'))
      }

      const cfg = state.config ?? {}
      const st = state.status ?? {}
      const consoleUrl = st.consoleUrl || ''

      return h(
        'div',
        { style: S.wrap },
        // ① 总开关
        h(
          'div',
          { style: S.card },
          h('div', { style: { fontSize: '14px', fontWeight: 600 } }, '总开关'),
          h(
            'div',
            { style: S.row },
            h(Radio, { checked: cfg.enabled === true, onChange: () => save({ enabled: true }) }, '开启'),
            h(Radio, { checked: cfg.enabled !== true, onChange: () => save({ enabled: false }) }, '关闭'),
          ),
          h(
            'div',
            { style: S.hint },
            cfg.enabled === true
              ? '正在工作：会注入记忆、写记忆，并启动管理台。'
              : '已关停：不注入、不写记忆、不起管理台；数据原样保留。',
          ),
        ),

        // ② 数据目录
        h(
          'div',
          { style: S.card },
          h('div', { style: { fontSize: '14px', fontWeight: 600 } }, '数据目录'),
          h(
            'div',
            { style: S.row },
            h('input', {
              style: S.input,
              value: dirDraft,
              placeholder: 'D:\\yuanling（留空 = ~/.dsh/yuanling）',
              onChange: (e) => setDirDraft(e.target.value),
              disabled: busy,
            }),
            h(
              'button',
              { style: S.btn, disabled: busy, onClick: () => save({ dataDir: dirDraft }) },
              '保存',
            ),
            h(
              'button',
              {
                style: { ...S.btn, opacity: busy ? 0.5 : 1 },
                disabled: busy,
                onClick: async () => {
                  setMsg('正在打开选择框…')
                  try {
                    const r = await fetch(API + '?browse=dir').then((x) => x.json())
                    if (r.ok && r.path) {
                      setDirDraft(r.path)
                      setMsg('已选中，点「保存」生效')
                    } else setMsg(r.cancelled ? '已取消' : `打开失败：${r.error ?? ''}`)
                  } catch (error) {
                    setMsg(`打开失败：${String(error?.message ?? error)}`)
                  }
                },
              },
              '选择…',
            ),
          ),
          h(
            'div',
            { style: st.rootOk === false ? S.bad : S.ok },
            st.rootOk === false
              ? `不可用：${st.rootError || '目录不存在或不可写'}`
              : `${st.root || cfg.dataDir || '默认位置'} · ${st.facts ?? 0} 条事实 · 人格 ${st.active || '无'}`,
          ),
          h('div', { style: S.hint }, '换目录会同时同步 MCP 条目的 --root；改完需要重启 DSH。'),
        ),

        // ③④ 管理台
        h(
          'div',
          { style: S.card },
          h('div', { style: { fontSize: '14px', fontWeight: 600 } }, '管理台'),
          h(
            'div',
            { style: S.row },
            h('div', { style: { ...S.label, minWidth: 'auto', opacity: 0.9 } }, consoleUrl || '未启动'),
            h(
              'button',
              {
                style: { ...S.btn, cursor: consoleUrl ? 'pointer' : 'not-allowed', opacity: consoleUrl ? 1 : 0.5 },
                disabled: !consoleUrl,
                onClick: () => consoleUrl && window.open(consoleUrl, '_blank', 'noopener'),
              },
              '打开管理台',
            ),
            h(
              'button',
              {
                style: S.btn,
                onClick: async () => {
                  try {
                    const r = await fetch(API + '?token=1').then((x) => x.json())
                    if (!r.ok || !r.token) {
                      setMsg(`取令牌失败：${r.error ?? '未知原因'}`)
                      return
                    }
                    await copyText(r.token)
                    setMsg('✓ 令牌已复制，粘贴到管理台的输入框里')
                  } catch (error) {
                    setMsg(`复制失败：${String(error?.message ?? error)}`)
                  }
                },
              },
              '复制令牌',
            ),
          ),
          h('div', { style: S.hint }, '地址与端口目前只读（改它们属于危险操作，后期再开口子）。记忆、人物、规则、提案都在管理台里改。'),
        ),

        msg ? h('div', { style: S.hint }, msg) : null,
      )
    }

    const inject = ['slots']
    const NS = 'dsh-yuanling'

    function apply(ctx) {
      // 探针①：apply 有没有被调用（服务端会把它写进 system/log/client.log）
      try {
        fetch('/dsh-yuanling/api?ping=1', { method: 'POST' }).catch(() => {})
      } catch {
        /* 忽略 */
      }

      const register = () => {
        // 探针②：注册前后的状态，用同一通道落盘，方便判断卡在哪一步
        try {
          fetch('/dsh-yuanling/api?ping=2&hasSlots=' + (ctx && ctx.slots ? 1 : 0), { method: 'POST' }).catch(() => {})
        } catch {}
        return ctx.slots.inject('settings.section', () =>
          ctx.slots.register(
            { name: 'settings.section', id: NS, order: 6, label: () => '原灵' },
            YuanlingSection,
          ),
        )
      }
      if (typeof ctx.effect === 'function') ctx.effect(register, 'yuanling: settings section')
      else register()
    }

    exports.apply = apply
    exports.inject = inject
    exports.YuanlingSection = YuanlingSection
    return module.exports
  },
  })
}
