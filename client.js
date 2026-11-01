// 插件预检 —— 客户端半身
//
// 左侧栏「插件预检」：切换模式 + 高级设置 + 拦截统计。全部热生效，不需重启。
// 全部 React.createElement，无构建步骤；任何异常只影响本面板。
//
//   GET  /plugin-guard/api/state     → { mode, settings, lastBlock, stats, impl }
//   POST /plugin-guard/api/mode      → { ok, mode }
//   POST /plugin-guard/api/settings  → { ok, settings }  合并写入 runtime.json

window.__ModuleLoader__.load({
  id: 'dsh-plugin-preflight',
  factory: (require) => {
    const react = require('react')
    const h = react.createElement
    const PANEL_ID = 'plugin-guard'
    const ACCENT = '120, 167, 255'

    // 与 scripts/preflight.mjs 的 row id 一一对应
    const RULES = [
      { id: 'repo', label: '仓库与活跃度' },
      { id: 'installScripts', label: '安装即执行脚本' },
      { id: 'deprecated', label: '是否已弃用' },
      { id: 'aggregate', label: '依赖数量' },
      { id: 'compatibility', label: '宿主版本兼容' },
      { id: 'selfUpdate', label: '自更新痕迹' },
      { id: 'accounts', label: '第三方账号' },
      { id: 'provenance', label: 'provenance 签名' },
      { id: 'versionPin', label: '装后钉版本' },
    ]

    const THRESHOLDS = [
      { path: 'repo.maxIdleDays', label: '仓库空闲天数', fallback: 90 },
      { path: 'aggregate.warnAboveDeps', label: '依赖数·警告线', fallback: 1 },
      { path: 'aggregate.rejectAboveDeps', label: '依赖数·拒绝线', fallback: 8 },
    ]

    // 与 index.js 的 CUSTOM_FIELDS 保持一致；前端这份只用于即时提示，最终以服务端校验为准
    const FIELDS = [
      'repo.stars',
      'repo.idleDays',
      'repo.archived',
      'repo.found',
      'repo.slug',
      'repo.forks',
      'repo.openIssues',
      'repo.license',
      'depsCount',
      'deps',
      'scripts',
      'scriptsCount',
      'keywords',
      'keywordsCount',
      'hasInstallScript',
      'deprecated',
      'provenance',
      'npm.weeklyDownloads',
      'name',
      'version',
      'hostVersion',
      'license',
      'author',
      'description',
      'source',
    ]

    async function requestJson(url, init) {
      const response = await fetch(url, { headers: { accept: 'application/json', ...(init?.headers ?? {}) }, ...init })
      const text = await response.text()
      let body = null
      try {
        body = text === '' ? null : JSON.parse(text)
      } catch {
        body = null
      }
      // 服务端的 400 会带一句人话（例如「未知字段」），优先显示它而不是状态码
      if (!response.ok) throw new Error(body?.error ?? `HTTP ${response.status}`)
      return body
    }
    const loadState = () => requestJson('/plugin-guard/api/state')
    const saveSettings = (patch) =>
      requestJson('/plugin-guard/api/settings', {
        method: 'POST',
        // 写接口要求这个自定义头：挡住「简单请求」型的跨站提交
        headers: { 'content-type': 'application/json', 'x-plugin-guard': '1' },
        body: JSON.stringify(patch),
      })

    const s = {
      // 面板挂在宿主的固定高度容器里，必须自己撑满并允许纵向滚动，
      // 否则内容超出部分会被裁掉且滚不动。
      page: {
        padding: '28px 32px',
        maxWidth: '880px',
        lineHeight: 1.6,
        height: '100%',
        boxSizing: 'border-box',
        overflowY: 'auto',
        overflowX: 'hidden',
      },
      title: { fontSize: '19px', fontWeight: 600, margin: '0 0 2px', letterSpacing: '0.2px' },
      subtitle: { fontSize: '13px', opacity: 0.55, margin: '0 0 24px' },
      section: { marginBottom: '24px' },
      sectionHead: { margin: '0 0 10px', fontSize: '12px', letterSpacing: '0.08em', opacity: 0.5, textTransform: 'uppercase' },
      panel: { border: '1px solid rgba(255,255,255,0.07)', borderRadius: '14px', background: 'rgba(255,255,255,0.022)', overflow: 'hidden' },
      pad: { padding: '14px 16px' },
      divider: { borderTop: '1px solid rgba(255,255,255,0.06)' },
      grid: { display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: '1px', background: 'rgba(255,255,255,0.06)' },
      tile: { padding: '14px 16px', background: 'rgba(18,18,20,0.6)' },
      tileLabel: { fontSize: '11px', opacity: 0.5, marginBottom: '6px', letterSpacing: '0.04em' },
      tileValue: { fontSize: '22px', fontWeight: 600, fontVariantNumeric: 'tabular-nums', lineHeight: 1.1 },
      tileUnit: { fontSize: '12px', opacity: 0.45, marginLeft: '4px', fontWeight: 400 },
      bars: { display: 'flex', alignItems: 'flex-end', gap: '6px', padding: '16px 18px 12px', height: '96px' },
      barCol: { flex: '1 1 0', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'flex-end', gap: '6px', height: '100%' },
      bar: (ratio, active) => ({
        width: '100%',
        maxWidth: '38px',
        height: `${Math.max(ratio * 100, ratio > 0 ? 8 : 2)}%`,
        minHeight: '2px',
        borderRadius: '4px 4px 2px 2px',
        background: active ? `rgba(${ACCENT}, 0.85)` : 'rgba(255,255,255,0.16)',
        transition: 'height 160ms ease',
      }),
      barLabel: { fontSize: '10px', opacity: 0.4, fontVariantNumeric: 'tabular-nums' },
      optionWrap: { padding: '8px' },
      option: (active, disabled) => ({
        display: 'flex',
        gap: '12px',
        alignItems: 'flex-start',
        padding: '12px 14px',
        borderRadius: '10px',
        border: `1px solid ${active ? `rgba(${ACCENT}, 0.45)` : 'transparent'}`,
        background: active ? `rgba(${ACCENT}, 0.08)` : 'transparent',
        cursor: disabled ? 'default' : 'pointer',
        opacity: disabled ? 0.55 : 1,
      }),
      dot: (active) => ({
        width: '15px',
        height: '15px',
        marginTop: '3px',
        borderRadius: '50%',
        flex: '0 0 auto',
        border: `1px solid ${active ? `rgba(${ACCENT}, 0.95)` : 'rgba(255,255,255,0.28)'}`,
        background: active ? `rgba(${ACCENT}, 0.95)` : 'transparent',
        boxShadow: active ? 'inset 0 0 0 3px rgba(18,18,20,0.9)' : 'none',
      }),
      optionTitle: { fontSize: '14px' },
      optionDesc: { fontSize: '12px', opacity: 0.55, marginTop: '3px' },
      rowLabel: { fontSize: '13px', opacity: 0.85 },
      rowHint: { fontSize: '11px', opacity: 0.4, marginTop: '2px' },
      input: {
        background: 'rgba(255,255,255,0.05)',
        border: '1px solid rgba(255,255,255,0.12)',
        borderRadius: '8px',
        color: 'inherit',
        fontSize: '13px',
        padding: '6px 9px',
        fontFamily: 'inherit',
        outline: 'none',
      },
      btn: (disabled) => ({
        background: `rgba(${ACCENT}, 0.16)`,
        border: `1px solid rgba(${ACCENT}, 0.4)`,
        color: 'inherit',
        fontSize: '12px',
        padding: '6px 12px',
        borderRadius: '8px',
        cursor: disabled ? 'default' : 'pointer',
        opacity: disabled ? 0.5 : 1,
      }),
      chip: { fontSize: '11px', padding: '3px 8px', borderRadius: '999px', background: 'rgba(255,255,255,0.06)', display: 'inline-flex', gap: '6px', alignItems: 'center' },
      chipX: { cursor: 'pointer', opacity: 0.5 },
      toggle: (on) => ({
        width: '32px',
        height: '18px',
        borderRadius: '999px',
        background: on ? `rgba(${ACCENT}, 0.75)` : 'rgba(255,255,255,0.14)',
        position: 'relative',
        transition: 'background 140ms ease',
        flex: '0 0 auto',
        marginTop: '2px',
      }),
      knob: (on) => ({
        position: 'absolute',
        top: '2px',
        left: on ? '16px' : '2px',
        width: '14px',
        height: '14px',
        borderRadius: '50%',
        background: '#fff',
        transition: 'left 140ms ease',
      }),
      err: { fontSize: '12px', color: '#ff8f8f', marginTop: '10px' },
      foot: { fontSize: '11px', opacity: 0.35, marginTop: '16px' },
    }

    function Option({ label, desc, active, disabled, onPick }) {
      return h(
        'div',
        { style: s.option(active, disabled), onClick: disabled ? undefined : onPick, role: 'button' },
        h('div', { style: s.dot(active) }),
        h('div', null, h('div', { style: s.optionTitle }, label), desc ? h('div', { style: s.optionDesc }, desc) : null),
      )
    }

    function Tile({ label, value, unit }) {
      return h(
        'div',
        { style: s.tile },
        h('div', { style: s.tileLabel }, label),
        h('div', { style: s.tileValue }, String(value), unit ? h('span', { style: s.tileUnit }, unit) : null),
      )
    }

    function formatTime(iso) {
      if (typeof iso !== 'string' || iso.length < 16) return ''
      const date = new Date(iso)
      if (Number.isNaN(date.getTime())) return ''
      const pad = (n) => String(n).padStart(2, '0')
      return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
    }

    function formatBytes(bytes) {
      const value = Number(bytes) || 0
      if (value < 1024) return `${value} B`
      if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`
      return `${(value / 1024 / 1024).toFixed(1)} MB`
    }

    // 列表里的状态徽章：拦截 / 警告 / 通过 / 其它（跳过、无法验证）
    const BADGE = {
      blocked: { icon: '✗', color: '#ff8f8f', background: 'rgba(255,120,120,0.12)' },
      warn: { icon: '!', color: '#ffcf8f', background: 'rgba(255,190,100,0.12)' },
      pass: { icon: '✓', color: '#8fe0a8', background: 'rgba(120,220,150,0.10)' },
      other: { icon: '–', color: 'rgba(255,255,255,0.5)', background: 'rgba(255,255,255,0.06)' },
    }
    const badgeKey = (item) => {
      if (item.blocked === true) return 'blocked'
      if (item.verdict === 'pass' || item.verdict === 'reminder') return 'pass'
      if (item.verdict === 'warn' || item.verdict === 'reject' || item.verdict === 'manual') return 'warn'
      return 'other'
    }
    const badgeIcon = (item) => BADGE[badgeKey(item)].icon
    const badgeStyle = (item) => ({
      width: '18px',
      height: '18px',
      borderRadius: '50%',
      display: 'inline-flex',
      alignItems: 'center',
      justifyContent: 'center',
      fontSize: '11px',
      flex: '0 0 auto',
      marginTop: '2px',
      color: BADGE[badgeKey(item)].color,
      background: BADGE[badgeKey(item)].background,
    })
    const tabStyle = (active) => ({
      fontSize: '11px',
      padding: '3px 10px',
      borderRadius: '999px',
      cursor: 'pointer',
      border: `1px solid ${active ? 'rgba(120,167,255,0.5)' : 'rgba(255,255,255,0.10)'}`,
      background: active ? 'rgba(120,167,255,0.15)' : 'transparent',
      color: 'inherit',
    })

    function Panel() {
      const [state, setState] = react.useState(null)
      const [error, setError] = react.useState(null)
      const [busy, setBusy] = react.useState(false)
      const [allowDraft, setAllowDraft] = react.useState('')
      const [ruleDraft, setRuleDraft] = react.useState({ title: '', when: '', status: 'warn', detail: '' })
      const [helpOpen, setHelpOpen] = react.useState(false)
      const [settingsOpen, setSettingsOpen] = react.useState(false)
      const [filter, setFilter] = react.useState('all')
      const [showAllRecords, setShowAllRecords] = react.useState(false)

      const refresh = react.useCallback(() => {
        loadState()
          .then((next) => {
            setState(next)
            setError(null)
          })
          .catch((failure) => setError(`读取状态失败：${failure.message ?? failure}`))
      }, [])

      react.useEffect(() => {
        refresh()
      }, [refresh])

      const apply = async (patch) => {
        setBusy(true)
        try {
          await saveSettings(patch)
          refresh()
        } catch (failure) {
          setError(`保存失败：${failure.message ?? failure}`)
        } finally {
          setBusy(false)
        }
      }

      const mode = state?.mode ?? 'enforce'
      const settings = state?.settings ?? {}
      const disabled = new Set(settings.disabledRules ?? [])
      const allowlist = settings.allowlist ?? []
      const thresholds = settings.thresholds ?? {}
      const customRules = settings.customRules ?? []
      const stats = state?.stats ?? { total: 0, records: 0, last7: 0, packages: 0, days: [], topPackages: [], recent: [] }
      const days = stats.days ?? []
      const maxDay = Math.max(1, ...days.map((item) => item.count))
      const today = days.at(-1)?.day

      const toggleRule = (id) => {
        const next = new Set(disabled)
        if (next.has(id)) next.delete(id)
        else next.add(id)
        apply({ disabledRules: [...next] })
      }

      const setThreshold = (path, value) => {
        const number = Number(value)
        if (!Number.isFinite(number) || number < 0) return
        apply({ thresholds: { ...thresholds, [path]: number } })
      }

      const addAllow = () => {
        const name = allowDraft.trim()
        if (name === '' || allowlist.includes(name)) return
        setAllowDraft('')
        apply({ allowlist: [...allowlist, name] })
      }

      const removeAllow = (name) => apply({ allowlist: allowlist.filter((item) => item !== name) })

      const addRule = () => {
        if (!ruleReady) return
        const id = `custom-${Date.now().toString(36)}`
        const next = [...customRules, { id, ...ruleDraft, title: ruleDraft.title.trim(), when: ruleDraft.when.trim() }]
        setRuleDraft({ title: '', when: '', status: 'warn', detail: '' })
        apply({ customRules: next })
      }

      const removeRule = (id) => apply({ customRules: customRules.filter((item) => item.id !== id) })

      // 与 preflight.mjs 的 evalTerm 同一套语法：字段 比较符 值 / 字段 contains 值
      const TERM = /^([\w.]+)\s*(>=|<=|==|!=|>|<)\s*.+$/
      const TERM_CONTAINS = /^([\w.]+)\s+contains\s+.+$/
      const terms = ruleDraft.when
        .split('||')
        .flatMap((branch) => branch.split('&&'))
        .map((term) => term.trim())
        .filter((term) => term !== '')
      const badTerm = terms.find((term) => {
        const field = TERM_CONTAINS.exec(term)?.[1] ?? TERM.exec(term)?.[1]
        return field === undefined || !FIELDS.includes(field)
      })
      const conditionOk = terms.length > 0 && badTerm === undefined
      const ruleReady = conditionOk && ruleDraft.title.trim() !== ''

      return h(
        'div',
        { style: s.page },
        h('div', { style: s.title }, '插件预检'),
        h('div', { style: s.subtitle }, '安装前自动核对九项规则；判定为「拒绝」时中止安装，profile 不会被改动。'),
        state && state.impl === undefined
          ? h('div', { style: { ...s.pad, background: 'rgba(255,190,100,0.08)', borderRadius: '10px', marginBottom: '18px', fontSize: '12px' } }, '宿主代码仍是旧版本，设置项不可用。请完全退出应用再重启。')
          : null,
        (() => {
          const caps = state?.capabilities
          if (caps === undefined) return null
          const missing = [
            caps.installs === false ? '界面错误回显（installs）' : null,
            caps.emit === false ? '安装详情日志（install-log）' : null,
            caps.profile === false ? 'profile 路径' : null,
          ].filter(Boolean)
          if (missing.length === 0) return null
          return h(
            'div',
            { style: { ...s.warn, marginBottom: '18px' } },
            `兼容性降级：宿主缺少 ${missing.join('、')}。闸门仍会拦截，但这些提示可能不显示——建议更新插件或回退 DSH 版本。`,
          )
        })(),

        // ── 模式 ──
        h(
          'div',
          { style: s.section },
          h('div', { style: s.sectionHead }, '当前模式'),
          h(
            'div',
            { style: s.panel },
            h(
              'div',
              { style: s.optionWrap },
              h(Option, { label: '拦截（enforce）', desc: '预检不通过 → 停止安装，并在安装详情里给出原因', active: mode === 'enforce', disabled: busy, onPick: () => apply({ mode: 'enforce' }) }),
              h(Option, { label: '只记录（warn）', desc: '照常安装，只写审计日志 —— 放行后记得改回来', active: mode === 'warn', disabled: busy, onPick: () => apply({ mode: 'warn' }) }),
            ),
          ),
        ),

        // ── 高级设置（默认收起，避免面板越滚越长） ──
        h(
          'div',
          { style: s.section },
          h(
            'div',
            { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '12px', marginBottom: '10px' } },
            h('div', { style: { ...s.sectionHead, margin: 0 } }, '高级设置（立即生效）'),
            h('button', { style: s.btn(false), onClick: () => setSettingsOpen((open) => !open) }, settingsOpen ? '收起' : '展开'),
          ),
          settingsOpen
            ? h(
            'div',
            { style: s.panel },
            // 超时
            h(
              'div',
              { style: { ...s.pad, display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '16px' } },
              h('div', null, h('div', { style: s.rowLabel }, '预检超时'), h('div', { style: s.rowHint }, '超时按下方「预检跑不完时」的策略处置')),
              h('input', {
                key: `timeout-${settings.timeoutMs ?? 20000}`,
                type: 'number',
                min: 1,
                step: 1,
                defaultValue: Math.round((settings.timeoutMs ?? 20000) / 1000),
                style: { ...s.input, width: '84px' },
                onBlur: (event) => {
                  const seconds = Number(event.target.value)
                  if (Number.isFinite(seconds) && seconds >= 1) apply({ timeoutMs: Math.round(seconds * 1000) })
                },
                onKeyDown: (event) => {
                  if (event.key === 'Enter') event.currentTarget.blur()
                },
              }),
            ),
            // 无法验证时的策略
            h(
              'div',
              { style: { ...s.pad, ...s.divider } },
              h('div', { style: s.rowLabel }, '预检跑不完时'),
              h('div', { style: s.rowHint }, '断网、GitHub 限流或超时——这类情况下该不该放行'),
              h(
                'div',
                { style: { marginTop: '8px' } },
                h(Option, {
                  label: '拦截（推荐）',
                  desc: '验不了就不装。防止有人用「让网络卡住」的方式绕过检查',
                  active: (settings.onUnverified ?? 'block') === 'block',
                  disabled: busy,
                  onPick: () => apply({ onUnverified: 'block' }),
                }),
                h(Option, {
                  label: '放行',
                  desc: '照常安装，只在审计里记一条「无法验证」。离线环境需要这个',
                  active: settings.onUnverified === 'allow',
                  disabled: busy,
                  onPick: () => apply({ onUnverified: 'allow' }),
                }),
              ),
              h('div', { style: s.rowHint }, '30 分钟内验过的包会自动沿用上次结论，不受这里影响。'),
            ),
            // 审计上限
            h(
              'div',
              { style: { ...s.pad, ...s.divider, display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '16px' } },
              h('div', null,
                h('div', { style: s.rowLabel }, '审计上限'),
                h('div', { style: s.rowHint }, `超过后自动轮转，最多保留 3 份旧日志；当前 ${formatBytes(state?.auditBytes)}`)),
              h('input', {
                key: `audit-${settings.auditMaxBytes ?? 1048576}`,
                type: 'number',
                min: 1,
                step: 1,
                defaultValue: Math.round((settings.auditMaxBytes ?? 1048576) / 1048576),
                style: { ...s.input, width: '84px' },
                onBlur: (event) => {
                  const megabytes = Number(event.target.value)
                  if (Number.isFinite(megabytes) && megabytes >= 1) apply({ auditMaxBytes: Math.round(megabytes * 1024 * 1024) })
                },
                onKeyDown: (event) => {
                  if (event.key === 'Enter') event.currentTarget.blur()
                },
              }),
            ),
            // 规则开关
            h(
              'div',
              { style: { ...s.pad, ...s.divider } },
              h('div', { style: s.rowLabel }, '规则开关'),
              h('div', { style: s.rowHint }, '关掉的规则会显示为「已禁用」，不参与结论'),
              h(
                'div',
                { style: { display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: '6px 14px', marginTop: '10px' } },
                RULES.map((rule) =>
                  h(
                    'div',
                    {
                      key: rule.id,
                      style: { display: 'flex', gap: '8px', alignItems: 'flex-start', cursor: busy ? 'default' : 'pointer', padding: '4px 0' },
                      onClick: busy ? undefined : () => toggleRule(rule.id),
                    },
                    h('div', { style: s.toggle(!disabled.has(rule.id)) }, h('div', { style: s.knob(!disabled.has(rule.id)) })),
                    h('div', { style: { fontSize: '12px', opacity: disabled.has(rule.id) ? 0.4 : 0.85 } },
                      rule.label,
                      disabled.has(rule.id)
                        ? h('span', { style: { marginLeft: '6px', fontSize: '10px', padding: '1px 5px', borderRadius: '4px', background: 'rgba(255,255,255,0.10)' } }, '已禁用')
                        : null,
                    ),
                  ),
                ),
              ),
            ),
            // 阈值
            h(
              'div',
              { style: { ...s.pad, ...s.divider } },
              h('div', { style: s.rowLabel }, '阈值'),
              h(
                'div',
                { style: { display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: '12px', marginTop: '10px' } },
                THRESHOLDS.map((item) =>
                  h(
                    'div',
                    { key: item.path },
                    h('div', { style: s.rowHint }, item.label),
                    h('input', {
                      type: 'number',
                      min: 0,
                      defaultValue: thresholds[item.path] ?? item.fallback,
                      style: { ...s.input, width: '100%', marginTop: '4px' },
                      onBlur: (event) => setThreshold(item.path, event.target.value),
                      onKeyDown: (event) => {
                        if (event.key === 'Enter') event.currentTarget.blur()
                      },
                    }),
                  ),
                ),
              ),
            ),
            // 白名单
            h(
              'div',
              { style: { ...s.pad, ...s.divider } },
              h('div', { style: s.rowLabel }, '白名单（跳过全部检查）'),
              h('div', { style: { display: 'flex', gap: '8px', marginTop: '10px' } },
                h('input', {
                  value: allowDraft,
                  placeholder: '包名，例如 dsh-context',
                  style: { ...s.input, flex: '1 1 auto' },
                  onChange: (event) => setAllowDraft(event.target.value),
                  onKeyDown: (event) => {
                    if (event.key === 'Enter') addAllow()
                  },
                }),
                h('button', { style: s.btn(busy || allowDraft.trim() === ''), onClick: addAllow, disabled: busy }, '添加'),
              ),
              allowlist.length > 0
                ? h('div', { style: { display: 'flex', flexWrap: 'wrap', gap: '6px', marginTop: '10px' } },
                    allowlist.map((name) =>
                      h('span', { key: name, style: s.chip }, name, h('span', { style: s.chipX, onClick: () => removeAllow(name) }, '✕')),
                    ))
                : null,
            ),
            // 自定义规则
            h(
              'div',
              { style: { ...s.pad, ...s.divider } },
              h(
                'div',
                { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '12px' } },
                h('div', { style: s.rowLabel }, '自定义规则'),
                h('button', { style: s.btn(false), onClick: () => setHelpOpen(true) }, '详细说明'),
              ),
              h('div', { style: s.rowHint }, '命中即追加一条检查结果；不修改内置九条，也不会被内置规则覆盖'),
              customRules.length > 0
                ? h('div', { style: { marginTop: '10px', display: 'flex', flexDirection: 'column', gap: '6px' } },
                    customRules.map((rule) =>
                      h('div', { key: rule.id, style: { display: 'flex', gap: '10px', alignItems: 'center', fontSize: '12px' } },
                        h('span', { style: { ...s.chip, opacity: 0.9 } }, rule.status ?? 'warn'),
                        h('span', { style: { flex: '1 1 auto' } }, `${rule.title} — ${rule.when}`),
                        h('span', { style: s.chipX, onClick: () => removeRule(rule.id) }, '✕'),
                      ),
                    ))
                : null,
              h('div', { style: { display: 'grid', gridTemplateColumns: '1fr 1.4fr auto auto auto', gap: '6px', marginTop: '10px', alignItems: 'center' } },
                h('input', { value: ruleDraft.title, placeholder: '标题，如「仓库太冷清」', style: s.input, onChange: (e) => setRuleDraft({ ...ruleDraft, title: e.target.value }) }),
                h('input', { value: ruleDraft.when, placeholder: '条件，如 repo.stars < 100', style: s.input, onChange: (e) => setRuleDraft({ ...ruleDraft, when: e.target.value }) }),
                h('select', { value: ruleDraft.status, style: s.input, onChange: (e) => setRuleDraft({ ...ruleDraft, status: e.target.value }) },
                  h('option', { value: 'warn' }, '警告'),
                  h('option', { value: 'reject' }, '拒绝'),
                  h('option', { value: 'manual' }, '需人工'),
                ),
                h('input', { value: ruleDraft.detail, placeholder: '说明，如「只有 {repo.stars} star」', style: s.input, onChange: (e) => setRuleDraft({ ...ruleDraft, detail: e.target.value }) }),
                h('button', { style: s.btn(busy || !ruleReady), onClick: addRule, disabled: busy || !ruleReady }, '添加'),
              ),
              ruleDraft.when.trim() !== '' && !conditionOk
                ? h('div', { style: { fontSize: '11px', color: '#ffcf8f', marginTop: '6px' } }, '条件格式不对：应为「字段 比较符 值」，多个条件用 && 或 || 连接')
                : null,
            ),
          )
            : null,
        ),

        // ── 统计 ──
        h(
          'div',
          { style: s.section },
          h('div', { style: s.sectionHead }, '检查统计'),
          h(
            'div',
            { style: s.panel },
            h(
              'div',
              { style: s.grid },
              h(Tile, { label: '检查总数', value: stats.counts?.total ?? stats.records, unit: '次' }),
              h(Tile, { label: '拦截', value: stats.counts?.blocked ?? stats.total, unit: '次' }),
              h(Tile, { label: '警告放行', value: stats.counts?.warned ?? 0, unit: '次' }),
              h(Tile, { label: '通过', value: stats.counts?.passed ?? 0, unit: '次' }),
            ),
            h(
              'div',
              { style: s.bars },
              days.map((item) =>
                h(
                  'div',
                  { key: item.day, style: s.barCol, title: `${item.day}：${item.count} 次` },
                  h('div', { style: s.bar(item.count / maxDay, item.day === today && item.count > 0) }),
                  h('div', { style: s.barLabel }, item.day),
                ),
              ),
            ),
            stats.topPackages.length > 0
              ? h('div', { style: { display: 'flex', flexWrap: 'wrap', gap: '6px', padding: '14px 16px', ...s.divider } },
                  stats.topPackages.map((item) =>
                    h(
                      'span',
                      { key: item.name, style: s.chip, title: `检查 ${item.count} 次，其中拦截 ${item.blocked ?? 0} 次` },
                      `${item.name} × ${item.count}`,
                      item.blocked > 0
                        ? h('span', { style: { opacity: 0.55 } }, `（拦 ${item.blocked}）`)
                        : h('span', { style: { opacity: 0.55 } }, '（放行）'),
                    ),
                  ))
              : null,
          ),
        ),

        // ── 最近检查 ──
        h(
          'div',
          { style: s.section },
          h(
            'div',
            { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '12px', marginBottom: '10px' } },
            h('div', { style: { ...s.sectionHead, margin: 0 } }, '最近检查'),
            h(
              'div',
              { style: { display: 'flex', gap: '4px' } },
              h('button', { style: tabStyle(filter === 'all'), onClick: () => setFilter('all') }, '全部'),
              h('button', { style: tabStyle(filter === 'blocked'), onClick: () => setFilter('blocked') }, '只看拦截'),
            ),
          ),
          h(
            'div',
            { style: s.panel },
            (() => {
              const rows = (stats.recent ?? []).filter((item) => filter === 'all' || item.blocked === true)
              if (rows.length === 0) {
                return h('div', { style: { ...s.pad, textAlign: 'center', opacity: 0.45, fontSize: '13px' } },
                  filter === 'blocked' ? '没有拦截记录。' : '还没有检查记录。')
              }
              const shown = showAllRecords ? rows : rows.slice(0, 6)
              return [
                h(
                  'div',
                  { key: 'rows', style: { maxHeight: '300px', overflowY: 'auto' } },
                  shown.map((item, index) =>
                    h(
                      'div',
                      { key: `${item.ts}-${index}`, style: { display: 'flex', gap: '12px', alignItems: 'flex-start', padding: '12px 16px', ...(index === 0 ? {} : s.divider) } },
                      h('span', { style: badgeStyle(item) }, badgeIcon(item)),
                      h('div', { style: { minWidth: 0, flex: '1 1 auto' } },
                        h('div', { style: { fontSize: '13px', fontWeight: 500 } }, `${item.package}${item.version ? `@${item.version}` : ''}`),
                        item.reason ? h('div', { style: { fontSize: '12px', opacity: 0.55, marginTop: '3px' } }, item.reason) : null,
                      ),
                      h('div', { style: { fontSize: '11px', opacity: 0.38, flex: '0 0 auto', fontVariantNumeric: 'tabular-nums' } }, formatTime(item.ts)),
                    ),
                  ),
                ),
                rows.length > 6
                  ? h(
                      'div',
                      { key: 'more', style: { ...s.divider, padding: '10px 16px', display: 'flex', justifyContent: 'center' } },
                      h('button', { style: s.btn(false), onClick: () => setShowAllRecords((open) => !open) },
                        showAllRecords ? '收起' : `查看全部 ${rows.length} 条`),
                    )
                  : null,
              ]
            })(),
          ),
        ),

        error ? h('div', { style: s.err }, error) : null,
        h('div', { style: s.foot }, `所有设置写入 runtime.json，改完立即生效，不需要重启。审计 ${formatBytes(state?.auditBytes)}：${state?.auditFileDisplay ?? '~/.dsh/plugin-guard/audit/plugin-guard.jsonl'}`),
        helpOpen ? h(HelpDialog, { onClose: () => setHelpOpen(false) }) : null,
      )
    }

    /** 「详细说明」弹层：简要语法 + 字段 + 示例 + 注意事项。 */
    function HelpDialog({ onClose }) {
      const code = { fontFamily: 'ui-monospace, SFMono-Regular, Consolas, monospace', fontSize: '12px', opacity: 0.9 }
      const block = { background: 'rgba(255,255,255,0.04)', borderRadius: '10px', padding: '10px 12px', margin: '6px 0 12px' }
      const head = { fontSize: '12px', letterSpacing: '0.06em', opacity: 0.5, margin: '14px 0 4px' }
      return h(
        'div',
        {
          style: { position: 'fixed', inset: 0, zIndex: 9999, background: 'rgba(0,0,0,0.55)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '24px' },
          onClick: onClose,
        },
        h(
          'div',
          {
            style: {
              maxWidth: '640px',
              width: '100%',
              maxHeight: '80vh',
              overflowY: 'auto',
              background: '#1b1b1f',
              border: '1px solid rgba(255,255,255,0.10)',
              borderRadius: '14px',
              padding: '22px 24px 18px',
              lineHeight: 1.75,
              cursor: 'default',
            },
            onClick: (event) => event.stopPropagation(),
          },
          h('div', { style: { fontSize: '16px', fontWeight: 600, marginBottom: '2px' } }, '自定义规则：怎么用'),
          h('div', { style: { fontSize: '12px', opacity: 0.5, marginBottom: '10px' } }, '条件命中 → 追加一条检查结果；不命中就什么都不会发生。'),

          h('div', { style: head }, '语法'),
          h(
            'div',
            { style: block },
            h('div', { style: code }, '字段  比较符  值'),
            h('div', { style: { ...code, opacity: 0.7 } }, '比较符：<  >  <=  >=  ==  !=      多个条件用 &&（与）或 ||（或）连接'),
            h('div', { style: { ...code, opacity: 0.7 } }, '包含判断：deps contains "lodash"   （数组字段专用）'),
          ),

          h('div', { style: head }, '可用字段'),
          h(
            'div',
            { style: block },
            h('div', { style: { ...code, opacity: 0.6 } }, '仓库（GitHub）'),
            h('div', { style: code }, 'repo.stars · repo.idleDays · repo.archived · repo.found · repo.slug · repo.forks · repo.openIssues · repo.license'),
            h('div', { style: { ...code, opacity: 0.6, marginTop: '6px' } }, '包本身（npm）'),
            h('div', { style: code }, 'depsCount · deps · scripts · scriptsCount · keywords · keywordsCount'),
            h('div', { style: code }, 'deprecated · provenance · hasInstallScript'),
            h('div', { style: { ...code, opacity: 0.6, marginTop: '6px' } }, '元数据与外部'),
            h('div', { style: code }, 'name · version · hostVersion · license · author · description · source'),
            h('div', { style: code }, 'npm.weeklyDownloads（用到才查，多一次网络请求）'),
          ),

          h('div', { style: head }, '参考示例'),
          h(
            'div',
            { style: block },
            h('div', { style: code }, 'repo.stars < 50                                  → 仓库太冷清'),
            h('div', { style: code }, 'repo.idleDays > 180 && repo.stars < 100          → 长期没更新且没人用'),
            h('div', { style: code }, 'author == "someone"                              → 指定作者'),
            h('div', { style: code }, 'deprecated == true && provenance == false        → 弃用且无签名'),
            h('div', { style: code }, 'deps contains "axios"                            → 依赖里出现某库'),
            h('div', { style: code }, 'npm.weeklyDownloads < 100                        → 没人用'),
          ),

          h('div', { style: head }, '说明字段的写法'),
          h('div', { style: block }, h('div', { style: code }, '只有 {repo.stars} star，已 {repo.idleDays} 天没更新'), h('div', { style: { fontSize: '12px', opacity: 0.6 } }, '花括号里填上面的字段名，命中时会替换成实际值。')),

          h('div', { style: head }, '注意'),
          h(
            'div',
            { style: { ...block, fontSize: '12px', opacity: 0.75 } },
            h('div', null, '· 字段名写错会在保存时被拒绝——不会留下一条永远不命中的规则'),
            h('div', null, '· 不支持括号、in、正则；&& 优先于 ||'),
            h('div', null, '· 数组字段（keywords / deps / scripts）暂不支持比较'),
            h('div', null, '· 与内置规则是叠加关系：内置说拒绝，自定义说通过，结论仍是拒绝'),
          ),

          h('div', { style: { display: 'flex', justifyContent: 'flex-end', marginTop: '8px' } },
            h('button', { style: s.btn(false), onClick: onClose }, '知道了'),
          ),
        ),
      )
    }

    function Icon() {
      return h(
        'svg',
        { width: 18, height: 18, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.8, strokeLinecap: 'round', strokeLinejoin: 'round' },
        h('path', { d: 'M12 3l7 3v6c0 4.2-2.9 7.6-7 9-4.1-1.4-7-4.8-7-9V6l7-3z' }),
        h('path', { d: 'M9 12l2 2 4-4' }),
      )
    }

    const apply = (ctx) => {
      try {
        ctx.slots.inject('sidebar.panellist', () => {
          const offPanel = ctx.slots.register({ name: 'main', key: PANEL_ID }, Panel)
          const offRow = ctx.slots.register({ name: 'sidebar.panellist', id: PANEL_ID, order: 30, label: () => '插件预检' }, Icon)
          return () => {
            try {
              offRow()
            } catch {
              /* 卸载失败不影响其它入口 */
            }
            try {
              offPanel()
            } catch {
              /* 同上 */
            }
          }
        })
      } catch (error) {
        console.warn('[plugin-guard] 侧栏入口注册失败：', error)
      }
    }

    return { name: 'plugin-guard', apply, inject: ['slots'] }
  },
})
