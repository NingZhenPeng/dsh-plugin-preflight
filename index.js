// 插件安装预检闸门（host 半身）
//
// 职责只有一件：在 pluginManager.installBundle 真正执行之前，跑一次预检脚本；
// 判定为「拒绝」就抛错中止安装，并把每次尝试写进审计日志。
//
// 设计原则：
// 1. **不改安装实现**，只包一层；预检通过就原样调用原方法。
// 2. **fail-open**：脚本超时、网络失败、输出无法解析时一律放行并告警。
//    否则离线环境下会把整个插件安装能力锁死——那比漏检更糟。
// 3. **只拦「明确拒绝」**：警告与需人工不拦，交给人判断。
// 4. apply 里绝不抛错，避免把一个守门插件变成启动故障源。

import { execFile } from 'node:child_process'
import { readFileSync, renameSync, statSync } from 'node:fs'
import { appendFile, mkdir, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/** Cordis 插件名。 */
export const name = 'plugin-guard'

/** 需要插件管理器服务。缺了它本插件就不激活，也不会影响其它插件。 */
export const inject = ['pluginManager']

/** 能预检的规格：npm 包名，可带版本。 */
const REGISTRY_SPEC = /^(?:@[a-z0-9][a-z0-9._~-]*\/)?[a-z0-9][a-z0-9._~-]*(?:@[^\s]+)?$/

/** 把安装规格里的包名剥出来；本地路径、git 地址、tarball 一律返回 null。 */
function packageNameOf(spec) {
  const text = String(spec ?? '').trim()
  if (text === '') return null
  if (/^(?:\.{1,2}[\\/]|[a-zA-Z]:[\\/]|\/)/.test(text)) return null
  if (/^(?:file|link|github|gitlab|bitbucket|gist):/i.test(text)) return null
  if (/^git\+|^git@|^https?:/i.test(text)) return null
  if (!REGISTRY_SPEC.test(text)) return null
  const at = text.indexOf('@', 1)
  return at === -1 ? text : text.slice(0, at)
}

/**
 * 跑一次预检脚本，永不抛错。
 *
 * 解释器按顺序尝试多个候选：
 *   1. 配置里指定的（或探测出的）解释器；
 *   2. 若它是 Electron（桌面壳），再用 `ELECTRON_RUN_AS_NODE=1` 跑自己——
 *      这条在 macOS / Linux 上很关键：宿主可能根本没把 `node` 放进 PATH。
 * 只有「可执行文件不存在」才换下一个候选；脚本自己报错不重试。
 */
function runPreflight({ nodePath, scriptPath, timeoutMs, runtimeFile, hostVersion }, pkgName) {
  const args = [scriptPath, pkgName, '--json']
  if (runtimeFile !== undefined) args.push('--config', runtimeFile)
  if (hostVersion !== undefined && hostVersion !== '') args.push('--host', hostVersion)

  const candidates = [{ command: nodePath, env: {} }]
  const electron = process.execPath
  if (electron !== undefined && electron !== nodePath && /[\\/]electron(?:\.exe)?$/i.test(electron)) {
    candidates.push({ command: electron, env: { ELECTRON_RUN_AS_NODE: '1' } })
  }

  const attempt = (index) => {
    const candidate = candidates[index]
    if (candidate === undefined) {
      return Promise.resolve({ ok: false, reason: '找不到可用的 node 解释器' })
    }
    return new Promise((resolve) => {
      execFile(
        candidate.command,
        args,
        {
          timeout: timeoutMs,
          windowsHide: true,
          maxBuffer: 4 * 1024 * 1024,
          env: { ...process.env, ...candidate.env },
        },
        (error, stdout) => {
          if (error) {
            // 只有「解释器不存在 / 不可执行」才换候选；脚本跑失败原样上报
            const missing = error.code === 'ENOENT' || error.code === 'EACCES'
            if (missing) return resolve(attempt(index + 1))
            return resolve({ ok: false, reason: error.message })
          }
          try {
            return resolve({ ok: true, data: JSON.parse(String(stdout)) })
          } catch {
            return resolve({ ok: false, reason: '预检输出无法解析为 JSON' })
          }
        },
      )
    })
  }

  return attempt(0)
}

/** 从预检结果里挑出被拒的条目，拼成一句人话。 */
function rejectReason(data) {
  const bad = (data.rows ?? []).filter((r) => r.status === 'reject')
  if (bad.length === 0) return data.verdictLabel ?? '拒绝'
  return bad.map((r) => `${r.title}：${r.detail}`).join('；')
}

/**
 * 面向「安装详情」终端面板的多行报告：先列不满足的条件，再列需要注意的，
 * 最后一行给处置建议。用符号而不是表格对齐——终端等宽字体下 CJK 宽度不可控，
 * 空格对齐必然歪。
 */
export function formatReport(data, pkgName, version) {
  const rows = data.rows ?? []
  const bad = rows.filter((r) => r.status === 'reject')
  const warn = rows.filter((r) => r.status === 'warn')
  const manual = rows.filter((r) => r.status === 'manual')
  const passed = rows.filter((r) => r.status === 'pass' || r.status === 'reminder')
  const skipped = rows.filter((r) => r.status === 'skip')

  const lines = [`插件预检未通过：${pkgName}@${version}`, '']

  if (bad.length > 0) {
    lines.push(`不满足的条件（${bad.length} 项）`)
    for (const row of bad) {
      lines.push(`  ✗ ${row.title}`)
      lines.push(`      ${row.detail}`)
    }
    lines.push('')
  }

  const attention = [...warn, ...manual]
  if (attention.length > 0) {
    lines.push(`需要注意（${attention.length} 项）`)
    for (const row of attention) {
      lines.push(`  ${row.status === 'manual' ? '?' : '!'} ${row.title}：${row.detail}`)
    }
    lines.push('')
  }

  // 被关闭的规则必须显式列出来——否则「为什么这条没拦住」会变成悬案
  if (skipped.length > 0) {
    lines.push(`已禁用（${skipped.length} 项，不参与结论）：${skipped.map((row) => row.title).join('、')}`)
    lines.push('')
  }

  lines.push(`其余 ${passed.length} 项通过`)
  lines.push('')
  lines.push('处置：换一个兼容版本，或装完后把版本钉死；确需强行安装，')
  lines.push('      把 plugins/dsh-plugin-guard/runtime.json 的 mode 改成 "warn"（立即生效，无需重启）。')
  return lines.join('\n')
}

/** 能跑 .mjs 的解释器：宿主若是 Electron，process.execPath 是 electron.exe，必须回退到 PATH 上的 node。 */
function defaultNodePath() {
  const executable = process.execPath ?? 'node'
  return /[\\/]electron(?:\.exe)?$/i.test(executable) ? 'node' : executable
}

// ── 自定义规则的保存期校验 ────────────────────────────────────────────────
// 必须和 scripts/preflight.mjs 里 buildFacts 暴露的字段保持一致；
// 少列一个字段的后果是「规则永远静默不命中」，那比报错更难查。
const CUSTOM_FIELDS = [
  'name',
  'version',
  'hostVersion',
  'source',
  'license',
  'author',
  'description',
  'deprecated',
  'provenance',
  'depsCount',
  'deps',
  'scripts',
  'scriptsCount',
  'keywords',
  'keywordsCount',
  'hasInstallScript',
  'repo.found',
  'repo.slug',
  'repo.stars',
  'repo.idleDays',
  'repo.archived',
  'repo.forks',
  'repo.openIssues',
  'repo.license',
  'npm.weeklyDownloads',
]

const CONDITION_COMPARE = /^([\w.]+)\s*(>=|<=|==|!=|>|<)\s*(.+)$/
const CONDITION_CONTAINS = /^([\w.]+)\s+contains\s+(.+)$/

/** 校验一条条件表达式；合法返回 null，否则返回人话原因。 */
function conditionProblem(when) {
  const terms = String(when ?? '')
    .split('||')
    .flatMap((branch) => branch.split('&&'))
    .map((term) => term.trim())
    .filter((term) => term !== '')
  if (terms.length === 0) return '条件不能为空'
  for (const term of terms) {
    const field = CONDITION_CONTAINS.exec(term)?.[1] ?? CONDITION_COMPARE.exec(term)?.[1]
    if (field === undefined) return `无法解析的条件「${term}」，应为「字段 比较符 值」或「字段 contains 值」`
    if (!CUSTOM_FIELDS.includes(field)) {
      return `未知字段「${field}」，可用字段：${CUSTOM_FIELDS.join('、')}`
    }
  }
  return null
}

/** 校验整份自定义规则列表；合法返回 null。 */
export function validateCustomRules(list) {
  if (!Array.isArray(list)) return null
  for (const [index, rule] of list.entries()) {
    const label = typeof rule?.title === 'string' && rule.title.trim() !== '' ? `「${rule.title}」` : `第 ${index + 1} 条`
    if (rule === null || typeof rule !== 'object' || Array.isArray(rule)) return `${label}：必须是对象`
    if (typeof rule.title !== 'string' || rule.title.trim() === '') return `${label}：缺少标题`
    const problem = conditionProblem(rule.when)
    if (problem !== null) return `${label}：${problem}`
    if (rule.status !== undefined && !['warn', 'reject', 'manual'].includes(rule.status)) {
      return `${label}：等级只能是 warn / reject / manual`
    }
  }
  return null
}

/**
 * 最小请求准入：只放行本机来源。
 *
 * 挡的不是本机进程（它能直接改 runtime.json，挡不住），而是两类远程入口：
 *   1. 把服务暴露到局域网 / 隧道后，外部主机直接调接口；
 *   2. DNS rebinding：浏览器把恶意域名解析到 127.0.0.1，Host 仍是那个域名。
 * 因此判据是 Host / Origin —— 这两个头攻击者页面无法伪造。
 *
 * 返回 undefined 表示放行，否则返回要回给调用方的 HTTP 状态码。
 */
export function admitRequest(request) {
  const headers = request?.headers ?? {}
  const host = String(headers.host ?? '').toLowerCase().trim()
  const origin = String(headers.origin ?? '').toLowerCase().trim()

  // 不含点的主机名（localhost、dsh-app 等自定义 scheme）视为本机
  const hostOk = host === '' || !host.includes('.') || /^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/.test(host)
  if (!hostOk) return 403

  const originOk =
    origin === '' ||
    origin.startsWith('dsh-app://') ||
    /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/.test(origin)
  if (!originOk) return 403

  return undefined
}

export function apply(ctx, config = {}) {
  const here = dirname(fileURLToPath(import.meta.url))
  const options = {
    workspaceRoot: config.workspaceRoot ?? process.cwd(),
    dataDir: config.dataDir,
    scriptPath: config.scriptPath ?? join(here, 'scripts', 'preflight.mjs'),
    nodePath: config.nodePath ?? defaultNodePath(),
    mode: config.mode === 'warn' ? 'warn' : 'enforce',
    timeoutMs: Number.isFinite(config.timeoutMs) ? config.timeoutMs : 20000,
  }

  // 实现版本号取自 package.json，避免手写常量随发版漂移
  const packageVersion = (() => {
    try {
      return JSON.parse(readFileSync(join(here, 'package.json'), 'utf8')).version ?? '0.0.0'
    } catch {
      return '0.0.0'
    }
  })()

  // 数据目录解析顺序：
  //   1. dataDir（显式指定，产品态推荐）
  //   2. workspaceRoot/docs/audit（老配置沿用，保证历史数据不丢）
  //   3. ~/.dsh/plugin-guard/audit（默认，与具体工作空间无关）
  const auditDir = options.dataDir
    ? resolve(options.dataDir)
    : config.workspaceRoot
      ? join(options.workspaceRoot, 'docs', 'audit')
      : join(homedir(), '.dsh', 'plugin-guard', 'audit')

  const auditFile = join(auditDir, 'plugin-guard.jsonl')
  const blockNoticeFile = join(auditDir, 'last-block.md')
  // 同目录的结构化副本，给界面面板读
  const lastBlockJson = join(auditDir, 'last-block.json')
  // 运行期开关：改这个文件立刻生效，不用重启（cordis.patch.yml 里的 mode 只是启动默认值）
  const runtimeFile = config.runtimeFile ?? join(here, 'runtime.json')

  /** 读运行期配置（整份）。 */
  const readOverrides = () => {
    try {
      const raw = JSON.parse(readFileSync(runtimeFile, 'utf8'))
      return raw !== null && typeof raw === 'object' ? raw : {}
    } catch {
      return {}
    }
  }

  /** 当前模式：runtime.json 优先，缺失或非法时回退到 bundle 配置。 */
  const currentMode = () => {
    const raw = readOverrides()
    if (raw?.mode === 'warn' || raw?.mode === 'enforce') return raw.mode
    return options.mode
  }

  /** 合并写入运行期配置，返回写入后的整份配置。 */
  const writeOverrides = async (patch) => {
    const next = { ...readOverrides(), ...(patch ?? {}) }
    if (next.mode !== 'warn' && next.mode !== 'enforce') next.mode = options.mode
    if (next.timeoutMs !== undefined && !(Number.isFinite(Number(next.timeoutMs)) && Number(next.timeoutMs) >= 1000)) {
      delete next.timeoutMs
    }
    if (!Array.isArray(next.disabledRules)) delete next.disabledRules
    if (!Array.isArray(next.allowlist)) delete next.allowlist
    if (!Array.isArray(next.customRules)) delete next.customRules
    if (next.thresholds !== undefined && (next.thresholds === null || typeof next.thresholds !== 'object')) {
      delete next.thresholds
    }
    // 预检跑不成时的策略：拦截（默认）或放行
    if (next.onUnverified !== 'allow' && next.onUnverified !== 'block') delete next.onUnverified
    // 审计上限：太小会让轮转过于频繁，下限 64 KiB
    if (next.auditMaxBytes !== undefined) {
      const bytes = Number(next.auditMaxBytes)
      if (!Number.isFinite(bytes) || bytes < 64 * 1024) delete next.auditMaxBytes
      else next.auditMaxBytes = Math.round(bytes)
    }
    // 只在真的带了自定义规则时校验：避免旧数据里一条坏规则把整份配置写死
    if (Object.hasOwn(patch ?? {}, 'customRules')) {
      const problem = validateCustomRules(next.customRules)
      if (problem !== null) throw new Error(problem)
    }
    await writeFile(runtimeFile, `${JSON.stringify(next, null, 2)}\n`, 'utf8')
    return next
  }

  /** 写运行期模式，返回写入后的值。 */
  const writeMode = async (mode) => {
    if (mode !== 'warn' && mode !== 'enforce') throw new Error('mode 只能是 enforce 或 warn')
    await writeOverrides({ mode })
    return mode
  }

  /** 面板用的状态快照：模式 + 最近拦截 + 从审计日志算出来的统计。 */
  const buildState = () => {
    const records = []
    try {
      for (const line of readFileSync(auditFile, 'utf8').split('\n')) {
        if (line.trim() === '') continue
        try {
          records.push(JSON.parse(line))
        } catch {
          // 单行损坏就跳过，不影响整体统计
        }
      }
    } catch {
      // 还没有审计文件
    }

    const blockedRecords = records.filter((item) => item.blocked === true)

    // 最近一次拦截：优先读 JSON 副本，缺失时从日志里回退
    let lastBlock = null
    try {
      lastBlock = JSON.parse(readFileSync(lastBlockJson, 'utf8'))
    } catch {
      const latest = blockedRecords.at(-1)
      lastBlock = latest
        ? { ts: latest.ts, spec: latest.spec, package: latest.package, version: latest.version, reason: latest.reason }
        : null
    }

    // 最近 7 天（含今天）的拦截次数
    const days = []
    const today = new Date()
    for (let offset = 6; offset >= 0; offset -= 1) {
      const day = new Date(today.getFullYear(), today.getMonth(), today.getDate() - offset)
      const key = `${day.getFullYear()}-${String(day.getMonth() + 1).padStart(2, '0')}-${String(day.getDate()).padStart(2, '0')}`
      days.push({ day: key.slice(5), count: 0 })
    }
    const dayIndex = new Map(days.map((item, index) => [item.day, index]))
    for (const item of blockedRecords) {
      const stamp = typeof item.ts === 'string' ? item.ts.slice(5, 10) : ''
      const index = dayIndex.get(stamp)
      if (index !== undefined) days[index].count += 1
    }

    // 按包聚合（全部检查，不只拦截）——否则「警告着装进来」的包在界面上彻底隐形
    const perPackage = new Map()
    for (const item of records) {
      const key = item.package ?? item.spec ?? '未知'
      const entry = perPackage.get(key) ?? { count: 0, blocked: 0 }
      entry.count += 1
      if (item.blocked === true) entry.blocked += 1
      perPackage.set(key, entry)
    }
    const topPackages = [...perPackage.entries()]
      .sort((left, right) => right[1].count - left[1].count)
      .slice(0, 6)
      .map(([name, entry]) => ({ name, count: entry.count, blocked: entry.blocked }))

    const recent = records
      .slice(-30)
      .reverse()
      .map((item) => ({
        ts: item.ts,
        package: item.package ?? item.spec,
        version: item.version ?? null,
        verdict: item.verdict ?? 'unknown',
        blocked: item.blocked === true,
        reason: item.reason ?? '',
      }))

    // 按判定分类计数：拦截只是其中一类，通过/警告同样要能被看到
    const counts = { total: records.length, blocked: 0, rejected: 0, warned: 0, passed: 0, other: 0 }
    for (const item of records) {
      if (item.blocked === true) counts.blocked += 1
      switch (item.verdict) {
        case 'reject':
          counts.rejected += 1
          break
        case 'warn':
          counts.warned += 1
          break
        case 'pass':
          counts.passed += 1
          break
        default:
          counts.other += 1
      }
    }

    return {
      mode: currentMode(),
      configuredMode: options.mode,
      // 面板据此判断宿主代码是否是新版；不一致说明改了代码还没重启
      impl: `guard-${packageVersion}`,
      // 宿主结构探测结果：面板据此显示「降级」提示
      capabilities,
      // 运行期配置整份回给面板，面板直接把它当表单初值
      settings: {
        timeoutMs: Number(readOverrides().timeoutMs) || options.timeoutMs,
        onUnverified: readOverrides().onUnverified === 'allow' ? 'allow' : 'block',
        auditMaxBytes: Number(readOverrides().auditMaxBytes) || 1024 * 1024,
        disabledRules: readOverrides().disabledRules ?? [],
        allowlist: readOverrides().allowlist ?? [],
        thresholds: readOverrides().thresholds ?? {},
        customRules: readOverrides().customRules ?? [],
      },
      lastBlock,
      // 审计文件位置（家目录缩成 ~，避免面板显示一长串绝对路径）
      auditFileDisplay: auditFile.startsWith(homedir()) ? `~${auditFile.slice(homedir().length)}` : auditFile,
      // 审计文件体积：面板据此提示何时会轮转
      auditBytes: (() => {
        try {
          return statSync(auditFile).size
        } catch {
          return 0
        }
      })(),
      stats: {
        total: blockedRecords.length,
        records: records.length,
        counts,
        last7: days.reduce((sum, item) => sum + item.count, 0),
        packages: perPackage.size,
        days,
        topPackages,
        recent,
      },
    }
  }

  // 拦截时安装任务根本不会被创建，界面的错误通道拿不到原因。
  // 因此每次拦截额外写一份人可读通知，作为可靠的告知渠道。
  const writeBlockNotice = async ({ spec, pkgName, version, reason }) => {
    const text = [
      '# 插件安装已被拦截',
      '',
      `- 时间：${new Date().toISOString()}`,
      `- 规格：\`${spec}\``,
      `- 包名：\`${pkgName}\``,
      `- 版本：${version ?? '未知'}`,
      `- 原因：${reason}`,
      '',
      '## 界面为什么只显示「后端当前没有此安装任务」',
      '',
      '预检在安装任务创建之前就中止了，界面拿不到任务记录，只能回退到这条通用错误。',
      '**拦截是生效的——profile 没有被修改。**',
      '',
      '## 如果确实要装',
      '',
      '1. 把 `plugins/dsh-plugin-guard/runtime.json` 的 `mode` 改成 `"warn"`——**立即生效，不用重启**；',
      '2. 闸门随后只记录、不拦截；',
      '3. 装完记得改回 `"enforce"`。',
      '',
      '## 完整历史',
      '',
      '见同目录 `plugin-guard.jsonl`，每行一条 JSON。',
      '',
    ].join('\n')
    try {
      await mkdir(dirname(blockNoticeFile), { recursive: true })
      await writeFile(blockNoticeFile, text, 'utf8')
      // 结构化副本：面板按 JSON 读，避免解析 Markdown
      await writeFile(
        lastBlockJson,
        `${JSON.stringify({ ts: new Date().toISOString(), spec, package: pkgName, version: version ?? null, reason }, null, 2)}\n`,
        'utf8',
      )
    } catch (error) {
      ctx.logger?.warn?.(`plugin-guard: 拦截通知写入失败（${error.message}）`)
    }
  }

  // 预检如何执行：默认走子进程；测试或嵌入场景可以注入一个函数替换它
  // 宿主版本：优先用宿主注入的版本号，避免 policy.json 里的 hostVersion 过期失真
  const hostVersionOf = () => process.env.DSH_CLIENT_VERSION ?? process.env.DSH_VERSION ?? ''

  const preflight =
    typeof config.preflight === 'function'
      ? config.preflight
      : (pkgName) => {
          const timeout = Number(readOverrides().timeoutMs) || options.timeoutMs
          return runPreflight({ ...options, timeoutMs: timeout, runtimeFile, hostVersion: hostVersionOf() }, pkgName)
        }

  // 同一个包在同一秒被市场「安装 + 复核」各触发一次时，只记一条——
  // 否则界面上会出现两条一模一样的记录，看起来像出了两次问题。
  let lastAuditKey = ''
  let lastAuditAt = 0

  /**
   * 审计轮转：超过上限就把当前文件改名成 `.1`，旧的依次后移，最多保留 3 份。
   * 不轮转的话，一年下来这个文件会涨到几 MB，界面读取也会变慢。
   */
  const rotateAuditIfNeeded = () => {
    const limit = Number(readOverrides().auditMaxBytes) || 1024 * 1024
    let size = -1
    try {
      size = statSync(auditFile).size
    } catch {
      return // 文件还不存在
    }
    if (size < limit) return
    try {
      for (let index = 3; index >= 1; index -= 1) {
        try {
          renameSync(`${auditFile}.${index}`, `${auditFile}.${index + 1}`)
        } catch {
          // 目标不存在，继续
        }
      }
      renameSync(auditFile, `${auditFile}.1`)
      ctx.logger?.info?.('plugin-guard: 审计日志已轮转')
    } catch (error) {
      ctx.logger?.warn?.(`plugin-guard: 审计轮转失败（${error.message}）`)
    }
  }

  const writeAudit = async (record) => {
    const key = `${record.package ?? ''}|${record.version ?? ''}|${record.verdict}|${record.blocked}`
    const now = Date.now()
    if (key === lastAuditKey && now - lastAuditAt < 60_000) return    lastAuditKey = key
    lastAuditAt = now
    rotateAuditIfNeeded()
    try {
      await mkdir(dirname(auditFile), { recursive: true })
      await appendFile(auditFile, `${JSON.stringify({ ts: new Date().toISOString(), ...record })}\n`, 'utf8')
    } catch (error) {
      // 审计写不进去不能影响安装流程，只告警
      ctx.logger?.warn?.(`plugin-guard: 审计日志写入失败（${error.message}）`)
    }
  }

  let manager
  try {
    manager = ctx.get('pluginManager')
  } catch {
    manager = undefined
  }
  if (!manager || typeof manager.installBundle !== 'function') {
    ctx.logger?.warn?.('plugin-guard: 未找到 pluginManager.installBundle，闸门未启用')
    return
  }

  const original = manager.installBundle

  // ── 宿主能力探测 ──────────────────────────────────────────────────────
  // 本插件有三处依赖宿主未公开的内部结构。宿主升级后它们可能消失，
  // 而「消失」的表现是静默失效（不报错、不拦截提示），所以启动时先探一遍，
  // 探不到就降级并显式告警——宁可少一个提示，也不能让你以为它在守。
  const capabilities = {
    // 让界面显示「安装失败 + 原因」依赖这个 Map
    installs: manager.installs instanceof Map,
    // 把原因写进「安装详情」依赖这个事件
    emit: typeof ctx.emit === 'function',
    // 读 profile 目录只用于展示，缺了不影响判断
    profile: typeof manager.profile?.dir === 'string',
  }
  const degraded = Object.entries(capabilities)
    .filter(([, ok]) => ok === false)
    .map(([key]) => key)
  if (degraded.length > 0) {
    ctx.logger?.warn?.(
      `plugin-guard: 宿主结构探测到 ${degraded.length} 项不可用（${degraded.join('、')}）。` +
        '闸门仍会拦截，但界面可能拿不到原因；请把 DSH 升级到插件声明支持的版本，或更新插件。',
    )
  }

  // ── 判定结果缓存 ──────────────────────────────────────────────────────
  // 预检失败（断网、GitHub 限流、超时）时，如果 30 分钟内刚验过同一个包，
  // 就复用那份结论——比「一律放行」安全，也比「一律拦截」可用。
  const cacheFile = join(auditDir, 'verdict-cache.json')
  const CACHE_TTL_MS = 30 * 60 * 1000
  const readCache = () => {
    try {
      const raw = JSON.parse(readFileSync(cacheFile, 'utf8'))
      return raw !== null && typeof raw === 'object' ? raw : {}
    } catch {
      return {}
    }
  }
  const writeCache = async (pkgName, data) => {
    try {
      const cache = readCache()
      cache[pkgName] = { at: Date.now(), data }
      await writeFile(cacheFile, `${JSON.stringify(cache)}\n`, 'utf8')
    } catch {
      // 缓存写不进去不影响主流程
    }
  }
  const readFreshCache = (pkgName) => {
    const entry = readCache()[pkgName]
    if (entry === undefined || typeof entry.at !== 'number') return null
    if (Date.now() - entry.at > CACHE_TTL_MS) return null
    return entry.data ?? null
  }

  /** 拦截收尾：写通知、发安装日志、留失败结果，然后抛错。 */
  const blockInstall = async ({ spec, pkgName, version, reason, message, reportText, requestId, code }) => {
    ctx.logger?.warn?.(`plugin-guard: ${message}`)
    await writeBlockNotice({ spec, pkgName, version, reason })

    // 安装详情的「输出」区渲染的是 plugin-manager/install-log（stderr 变终端块）
    if (requestId !== undefined && capabilities.emit) {
      try {
        ctx.emit('plugin-manager/install-log', {
          requestId,
          jobId: 'plugin-guard',
          argv: ['plugin-guard', 'preflight'],
          cwd: manager.profile?.dir ?? '',
          stream: 'stderr',
          exitCode: 1,
          text: `${reportText}\n`,
        })
      } catch (error) {
        ctx.logger?.warn?.(`plugin-guard: 安装日志事件发送失败（${error.message}）`)
      }
    }

    // 界面按 requestId 轮询结果；这里存的是安装结果对象（application/error），
    // 不是 RPC 信封——存错会被当成「已安装」。
    // error.diagnostic 才是界面渲染的失败原因（failureOf 取的就是它）。
    if (requestId !== undefined && capabilities.installs && manager.installs instanceof Map) {
      manager.installs.set(requestId, {
        abort: new AbortController(),
        phase: 'failed',
        result: Promise.resolve({
          application: 'failed',
          error: { code: code ?? 'plugin-guard-blocked', diagnostic: message, message },
        }),
      })
    }

    throw new Error(message)
  }

  const guarded = async function installBundleWithPreflight(spec, installOptions) {
    const pkgName = packageNameOf(spec)
    const requestId = installOptions?.requestId

    // 非 registry 规格（本地目录、git、tarball）无法预检，原样放行并留痕
    if (pkgName === null) {
      void writeAudit({ spec: String(spec ?? ''), package: null, verdict: 'skipped', blocked: false, reason: '非 registry 规格，未预检' })
      return original.call(manager, spec, installOptions)
    }

    const result = await preflight(pkgName)

    // ── 预检本身没跑成：先看缓存，再按 onUnverified 策略处置 ──────────────
    if (!result.ok) {
      const cached = readFreshCache(pkgName)
      const policyOnUnverified = readOverrides().onUnverified === 'allow' ? 'allow' : 'block'

      if (cached !== null) {
        ctx.logger?.warn?.(`plugin-guard: ${pkgName} 预检失败（${result.reason}），沿用 30 分钟内的结论`)
        void writeAudit({
          spec,
          package: pkgName,
          version: cached.version ?? null,
          verdict: cached.verdict ?? 'unknown',
          blocked: false,
          reason: `预检失败，沿用缓存（${result.reason}）`,
        })
        if (cached.verdict === 'reject' && currentMode() === 'enforce') {
          const reason = rejectReason(cached)
          await blockInstall({
            spec,
            pkgName,
            version: cached.version,
            reason,
            message: `插件预检无法重跑，沿用 30 分钟内的结论：拒绝。包：${pkgName}@${cached.version}。原因：${reason}。`,
            reportText: formatReport(cached, pkgName, cached.version),
            requestId,
          })
        }
        return original.call(manager, spec, installOptions)
      }

      if (policyOnUnverified === 'block') {
        const reason = `预检无法完成：${result.reason}`
        void writeAudit({ spec, package: pkgName, verdict: 'unverified', blocked: true, reason })
        await blockInstall({
          spec,
          pkgName,
          version: null,
          reason,
          message:
            `插件预检无法完成，已按「无法验证即拦截」策略中止安装：${pkgName}。原因：${result.reason}。` +
            `可在侧栏「插件预检 → 高级设置」把「无法验证时」改为放行，或稍后重试。`,
          reportText: [
            `插件预检无法完成：${pkgName}`,
            '',
            `原因：${result.reason}`,
            '',
            '处置：',
            '  1. 检查网络 / 代理后重试；GitHub API 限流通常 1 小时后恢复',
            '  2. 或把「无法验证时」改为「放行」（面板 → 高级设置）',
            '  3. 或用白名单单独放行这个包',
          ].join('\n'),
          requestId,
          code: 'plugin-guard-unverified',
        })
      }

      ctx.logger?.warn?.(`plugin-guard: ${pkgName} 预检失败，按策略放行（${result.reason}）`)
      void writeAudit({ spec, package: pkgName, verdict: 'unknown', blocked: false, reason: result.reason })
      return original.call(manager, spec, installOptions)
    }

    const { verdict, verdictLabel, version } = result.data
    void writeCache(pkgName, result.data)

    const mode = currentMode()
    const blocking = verdict === 'reject' && mode === 'enforce'

    void writeAudit({
      spec,
      package: pkgName,
      version,
      verdict,
      blocked: blocking,
      reason: blocking ? rejectReason(result.data) : '',
    })

    if (blocking) {
      const reason = rejectReason(result.data)
      await blockInstall({
        spec,
        pkgName,
        version,
        reason,
        message: `插件预检未通过，已拦截安装：${pkgName}@${version}。原因：${reason}。`,
        reportText: formatReport(result.data, pkgName, version),
        requestId,
      })
    }

    if (verdict === 'reject') {
      ctx.logger?.warn?.(`plugin-guard: ${pkgName} 预检为拒绝，但当前是 warn 模式，已放行`)
    }
    return original.call(manager, spec, installOptions)
  }

  manager.installBundle = guarded

  // 面板用的只读状态 + 写模式的接口。挂在 bare webServer 上，精确路径，
  // 与内核 /api 前缀互不影响；写操作只接受两个合法值。
  // 没有 ctx.inject（单测、极简 composition）时跳过，闸门本身照常工作。
  if (typeof ctx.inject !== 'function') {
    ctx.logger?.warn?.('plugin-guard: 当前上下文没有 inject，设置面板接口未启用')
  } else
  ctx.inject(['webServer'], (webCtx) => {
    const server = webCtx.webServer ?? webCtx.get?.('webServer')
    if (!server || typeof server.register !== 'function') {
      ctx.logger?.warn?.('plugin-guard: 未找到 webServer，设置面板接口未启用')
      return
    }
    const sendJson = (response, status, payload) => {
      try {
        response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
        response.end(JSON.stringify(payload))
      } catch (error) {
        ctx.logger?.warn?.(`plugin-guard: 响应写入失败（${error.message}）`)
      }
    }
    const readBody = (request) =>
      new Promise((resolve) => {
        let raw = ''
        request.on('data', (chunk) => {
          raw += chunk
          if (raw.length > 8192) request.destroy()
        })
        request.on('end', () => resolve(raw))
        request.on('error', () => resolve(''))
      })

    /** 每个路由的第一道关：来源准入 + 写操作必须带自定义头（挡简单请求型 CSRF）。 */
    const guardRequest = (request, response, { mutating }) => {
      const rejected = admitRequest(request)
      if (rejected !== undefined) {
        sendJson(response, rejected, { error: 'refused: request is not from this machine' })
        return false
      }
      if (mutating && String(request.headers['x-plugin-guard'] ?? '') !== '1') {
        sendJson(response, 400, { error: 'missing x-plugin-guard header' })
        return false
      }
      return true
    }

    const disposers = [
      server.register({
        kind: 'exact',
        path: '/plugin-guard/api/state',
        handler: (request, response) => {
          if (request.method !== 'GET') return sendJson(response, 405, { error: 'method not allowed' })
          if (!guardRequest(request, response, { mutating: false })) return
          sendJson(response, 200, buildState())
        },
      }),
      server.register({
        kind: 'exact',
        path: '/plugin-guard/api/mode',
        handler: async (request, response) => {
          if (request.method !== 'POST') return sendJson(response, 405, { error: 'method not allowed' })
          if (!guardRequest(request, response, { mutating: true })) return
          let parsed
          try {
            parsed = JSON.parse(await readBody(request))
          } catch {
            return sendJson(response, 400, { error: 'body must be JSON' })
          }
          try {
            const next = await writeOverrides(parsed)
            ctx.logger?.info?.('plugin-guard: 运行期配置已更新')
            return sendJson(response, 200, { ok: true, settings: next })
          } catch (error) {
            return sendJson(response, 400, { error: error.message })
          }
        },
      }),
      server.register({
        kind: 'exact',
        path: '/plugin-guard/api/settings',
        handler: async (request, response) => {
          if (request.method === 'GET') {
            if (!guardRequest(request, response, { mutating: false })) return
            return sendJson(response, 200, buildState().settings)
          }
          if (request.method !== 'POST') return sendJson(response, 405, { error: 'method not allowed' })
          if (!guardRequest(request, response, { mutating: true })) return
          let parsed
          try {
            parsed = JSON.parse(await readBody(request))
          } catch {
            return sendJson(response, 400, { error: 'body must be JSON' })
          }
          if (parsed === null || typeof parsed !== 'object') {
            return sendJson(response, 400, { error: 'body must be an object' })
          }
          try {
            const next = await writeOverrides(parsed)
            ctx.logger?.info?.('plugin-guard: 运行期配置已更新')
            return sendJson(response, 200, { ok: true, settings: next })
          } catch (error) {
            return sendJson(response, 400, { error: error.message })
          }
        },
      }),
    ]
    ctx.effect(() => () => {
      for (const dispose of disposers) {
        try {
          dispose?.()
        } catch {
          // 释放失败不影响卸载
        }
      }
    })
  })

  // 插件卸载时还原原方法，避免留下悬挂的包装
  ctx.effect(() => () => {
    if (manager.installBundle === guarded) manager.installBundle = original
  })

  ctx.logger?.info?.(`plugin-guard: 闸门已启用（mode=${options.mode}）`)
}
