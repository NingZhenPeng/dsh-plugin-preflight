#!/usr/bin/env node
// 插件安装预检：输入 npm 包名，输出「通过 / 警告 / 拒绝 / 需人工」。
// 零依赖，只用内置 fetch。规则阈值全部来自 policy.json，脚本本身不含判断标准。
//
// 用法：
//   node preflight.mjs dsh-context
//   node preflight.mjs dsh-context --version 0.77.0
//   node preflight.mjs dsh-context --json
//   node preflight.mjs dsh-context --host 0.2.1-rc.3

import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const HERE = dirname(fileURLToPath(import.meta.url))
const POLICY_PATH = join(HERE, '..', 'policy.json')
const REGISTRY = 'https://registry.npmjs.org'

// ── 语义化版本（够用即可，不追求完整 semver 规范） ──────────────────────────

function parseVer(text) {
  const m = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(String(text).trim())
  if (!m) return null
  return { major: +m[1], minor: +m[2], patch: +m[3], pre: m[4] ? m[4].split('.') : [] }
}

function cmpPre(a, b) {
  if (a.length === 0 && b.length === 0) return 0
  if (a.length === 0) return 1 // 正式版 > 预发布版
  if (b.length === 0) return -1
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const x = a[i]
    const y = b[i]
    if (x === undefined) return -1
    if (y === undefined) return 1
    const xn = /^\d+$/.test(x)
    const yn = /^\d+$/.test(y)
    if (xn && yn) {
      if (+x !== +y) return +x < +y ? -1 : 1
    } else if (xn) {
      return -1 // 数字标识符 < 字母标识符
    } else if (yn) {
      return 1
    } else if (x !== y) {
      return x < y ? -1 : 1
    }
  }
  return 0
}

function cmpVer(a, b) {
  for (const key of ['major', 'minor', 'patch']) {
    if (a[key] !== b[key]) return a[key] < b[key] ? -1 : 1
  }
  return cmpPre(a.pre, b.pre)
}

function bump(v, part) {
  const out = { major: v.major, minor: v.minor, patch: v.patch, pre: [] }
  if (part === 'major') {
    out.major += 1
    out.minor = 0
    out.patch = 0
  } else if (part === 'minor') {
    out.minor += 1
    out.patch = 0
  } else {
    out.patch += 1
  }
  return out
}

function satisfy(range, version) {
  const ver = parseVer(version)
  if (!ver) return null
  const text = String(range).trim()
  if (text === '' || text === '*' || text === 'latest') return true
  // 任意一个 alternative 满足即可
  return text.split('||').some((alt) => {
    const parts = alt.trim().split(/\s+/).filter(Boolean)
    if (parts.length === 0) return true
    return parts.every((raw) => {
      const m = /^(>=|<=|>|<|=|\^|~)?\s*(.+)$/.exec(raw)
      if (!m) return false
      const op = m[1] ?? '='
      const target = parseVer(m[2])
      if (!target) return false
      const c = cmpVer(ver, target)
      switch (op) {
        case '>=': return c >= 0
        case '<=': return c <= 0
        case '>': return c > 0
        case '<': return c < 0
        case '=': return c === 0
        case '^': {
          if (target.major > 0) return c >= 0 && cmpVer(ver, bump(target, 'major')) < 0
          if (target.minor > 0) return c >= 0 && cmpVer(ver, bump(target, 'minor')) < 0
          return c >= 0 && cmpVer(ver, bump(target, 'patch')) < 0
        }
        case '~': return c >= 0 && cmpVer(ver, bump(target, 'minor')) < 0
        default: return false
      }
    })
  })
}

// ── 网络 ────────────────────────────────────────────────────────────────

async function getJson(url) {
  const res = await fetch(url, { headers: { accept: 'application/json', 'user-agent': 'dsh-plugin-guard/0.1' } })
  if (res.status === 404) return { ok: false, status: 404, body: null }
  if (!res.ok) return { ok: false, status: res.status, body: null }
  return { ok: true, status: res.status, body: await res.json() }
}

// ── 各项检查 ─────────────────────────────────────────────────────────────

function repoSlug(meta, doc, pkgName) {
  // npm 的版本对象经常省略 repository，仓库信息多在文档根上，因此逐级回退
  const candidates = [meta.repository, doc?.repository, meta.homepage, doc?.homepage, meta.bugs, doc?.bugs]
  for (const candidate of candidates) {
    const raw = typeof candidate === 'string' ? candidate : candidate?.url
    if (!raw) continue
    const m = /github\.com[/:]([^/#]+)\/([^/#.]+)/i.exec(raw)
    if (m) return `${m[1]}/${m[2].replace(/\.git$/, '')}`
  }
  return slugFromReadme(doc?.readme, pkgName)
}

/**
 * 元数据里没有仓库地址时，从 README 里找「同名仓库」。
 * 只认仓库名与包名一致的那个链接——README 里通常还有作者其它项目、star 徽章等干扰链接。
 */
function slugFromReadme(readme, pkgName) {
  if (!readme || !pkgName) return null
  const base = pkgName.includes('/') ? pkgName.split('/')[1] : pkgName
  const blocked = new Set(['topics', 'features', 'marketplace', 'sponsors', 'apps', 'about'])
  const found = []
  const re = /github\.com[/:]([A-Za-z0-9._-]+)\/([A-Za-z0-9._-]+)/g
  let m
  while ((m = re.exec(readme)) !== null) {
    const owner = m[1]
    const repo = m[2].replace(/\.git$/, '')
    if (blocked.has(repo.toLowerCase())) continue
    found.push({ owner, repo })
  }
  const sameName = found.find((f) => f.repo.toLowerCase() === base.toLowerCase())
  const pick = sameName ?? null
  return pick ? `${pick.owner}/${pick.repo}` : null
}

async function checkRepo(meta, rule, doc, pkgName) {
  const slug = repoSlug(meta, doc, pkgName)
  const noFacts = { found: false, slug: null, stars: 0, idleDays: null, archived: false, forks: 0, openIssues: 0, license: '' }
  if (!slug) {
    const result = rule.requireGithub
      ? { status: rule.severityMissing, detail: '未找到 GitHub 仓库地址' }
      : { status: 'pass', detail: '无仓库（策略允许）' }
    return { ...result, facts: noFacts }
  }
  const r = await getJson(`https://api.github.com/repos/${slug}`)
  if (!r.ok) {
    return {
      status: rule.severityUnknown,
      detail: `仓库 ${slug} 查询失败（HTTP ${r.status}），无法验证`,
      facts: { ...noFacts, slug },
    }
  }
  const repo = r.body
  const pushed = new Date(repo.pushed_at)
  const idleDays = Math.floor((Date.now() - pushed.getTime()) / 86400000)
  const facts = {
    found: true,
    slug,
    stars: repo.stargazers_count,
    idleDays,
    archived: Boolean(repo.archived),
    forks: repo.forks_count ?? 0,
    openIssues: repo.open_issues_count ?? 0,
    license: repo.license?.spdx_id ?? '',
  }
  const bits = [`${slug}`, `${repo.stargazers_count} star`, `最后推送 ${idleDays} 天前`]
  if (repo.archived) return { status: rule.severityArchived, detail: bits.join('，') + '，仓库已归档', facts }
  if (idleDays > rule.maxIdleDays) {
    return { status: rule.severityIdle, detail: bits.join('，') + `，超过 ${rule.maxIdleDays} 天阈值`, facts }
  }
  return { status: 'pass', detail: bits.join('，'), facts }
}

function checkInstallScripts(meta, rule, source) {
  const scripts = Object.keys(meta.scripts ?? {})
  const blocked = scripts.filter((s) => rule.blocked.includes(s))
  const soft = scripts.filter((s) => rule.warnOnly.includes(s))
  if (blocked.length > 0) {
    return { status: rule.severity, detail: `含安装即执行脚本：${blocked.join(', ')}` }
  }
  if (soft.length > 0) {
    // prepare 只在 git 源安装时执行；走 npm 时不跑，因此不算风险项
    return source === 'git'
      ? { status: 'warn', detail: `含 ${soft.join(', ')}，git 源安装会执行构建（需 devDependencies）` }
      : { status: 'pass', detail: `含 ${soft.join(', ')}，但 npm 安装不执行（仅 git 源触发）` }
  }
  return { status: 'pass', detail: '无 install / postinstall 类脚本' }
}

function checkDeprecated(meta, doc, rule) {
  const msg = meta.deprecated ?? doc.versions?.[doc['dist-tags'].latest]?.deprecated
  if (msg) return { status: rule.severity, detail: `已弃用：${String(msg).slice(0, 120)}` }
  return { status: 'pass', detail: '未弃用' }
}

function checkAggregate(meta, rule) {
  const deps = Object.keys(meta.dependencies ?? {})
  if (deps.length > rule.rejectAboveDeps) {
    return { status: 'reject', detail: `${deps.length} 个直接依赖，疑似聚合包：${deps.slice(0, 6).join(', ')}…` }
  }
  if (deps.length > rule.warnAboveDeps) {
    return { status: rule.severity, detail: `${deps.length} 个直接依赖：${deps.join(', ')}` }
  }
  return { status: 'pass', detail: deps.length === 0 ? '零运行时依赖' : `${deps.length} 个直接依赖：${deps.join(', ')}` }
}

function checkCompatibility(meta, hostVersion, rule) {
  const problems = []
  const notes = []

  // 1) 显式兼容声明
  const declared = meta.dsh?.compatibility?.dshReleases
  if (declared && typeof declared === 'object') {
    const keys = Object.keys(declared).filter((k) => declared[k] === 'compatible')
    const hostSeries = hostVersion.replace(/-.*$/, '')
    const hit = keys.some((k) => k === hostVersion || k.startsWith(hostSeries + '-'))
    if (hit) notes.push(`作者声明兼容 ${hostSeries} 线`)
    else problems.push(`声明兼容 ${keys.join('/')}，不覆盖 ${hostVersion}`)
  }

  // 2) engines.dsh
  if (rule.checkEnginesDsh && meta.engines?.dsh) {
    const ok = satisfy(meta.engines.dsh, hostVersion)
    if (ok === false) problems.push(`engines.dsh "${meta.engines.dsh}" 不覆盖 ${hostVersion}`)
    else if (ok) notes.push(`engines.dsh 覆盖当前版本`)
  }

  // 3) peer 依赖里的 @deepseek-ai/dsh-*
  if (rule.checkPeerDsh) {
    const peers = Object.entries(meta.peerDependencies ?? {}).filter(([k]) => k.startsWith('@deepseek-ai/dsh-'))
    const bad = peers.filter(([, range]) => satisfy(range, hostVersion) === false)
    if (bad.length > 0) {
      const detail = bad.map(([k, r]) => `${k.replace('@deepseek-ai/', '')} "${r}"`).join('；')
      if (problems.length === 0) return { status: rule.severityPeer, detail: `peer 范围不覆盖 ${hostVersion}：${detail}` }
      problems.push(`peer 范围不覆盖 ${hostVersion}：${detail}`)
    } else if (peers.length > 0) {
      notes.push('peer 范围覆盖当前版本')
    }
  }

  if (problems.length > 0) return { status: rule.severity, detail: problems.join('；') }
  if (notes.length > 0) return { status: 'pass', detail: notes.join('；') }
  return { status: 'warn', detail: '未声明任何兼容信息，无法验证' }
}

function checkSelfUpdate(meta, rule, doc) {
  const scripts = Object.keys(meta.scripts ?? {})
  const deps = [...Object.keys(meta.dependencies ?? {}), ...Object.keys(meta.peerDependencies ?? {})]
  const hitsS = scripts.filter((s) => rule.scriptPatterns.some((p) => s.toLowerCase().includes(p)))
  const hitsD = deps.filter((d) => rule.depPatterns.some((p) => d.toLowerCase().includes(p)))
  if (hitsS.length > 0 || hitsD.length > 0) {
    return { status: rule.severity, detail: `疑似自更新能力：${[...hitsS, ...hitsD].join(', ')}` }
  }
  // 有些插件把升级能力写死在代码里，元数据看不出来，只能从 README 找线索
  const readme = String(doc?.readme ?? '').toLowerCase()
  const readmeHits = (rule.readmePatterns ?? []).filter((p) => readme.includes(p.toLowerCase()))
  if (readmeHits.length > 0) {
    return {
      status: rule.severity,
      detail: `README 提及「${readmeHits.slice(0, 4).join('、')}」，可能内置升级/热重载，需人工确认`,
    }
  }
  return { status: 'pass', detail: '脚本、依赖与 README 中均未见 updater 类痕迹（非穷尽检查）' }
}

function checkAccounts(meta, rule) {
  const text = [meta.description ?? '', ...(meta.keywords ?? [])].join(' ').toLowerCase()
  const hits = rule.textPatterns.filter((p) => text.includes(p.toLowerCase()))
  if (hits.length > 0) {
    return { status: rule.severity, detail: `描述中出现「${hits.join('、')}」，需人工确认是否要求第三方账号` }
  }
  return { status: 'pass', detail: '描述未提及账号登录' }
}

function checkProvenance(meta) {
  const has = Boolean(meta.dist?.attestations?.provenance)
  return has
    ? { status: 'pass', detail: '有 provenance 签名（由 CI 发布，可追溯到仓库）' }
    : { status: 'warn', detail: '无 provenance 签名（由作者本机发布，来源不可验证）' }
}

function checkPin(meta, version, rule) {
  return rule.requireExact
    ? { status: 'reminder', detail: `装后请钉版本：${version}（不要用 ^）` }
    : { status: 'pass', detail: '无需钉版本' }
}

// ── 汇总 ────────────────────────────────────────────────────────────────

const ICON = { pass: '✓', warn: '!', reject: '✗', manual: '?', reminder: '·', bonus: '+', skip: '–' }

function verdictOf(rows) {
  if (rows.some((r) => r.status === 'reject')) return 'reject'
  if (rows.some((r) => r.status === 'manual')) return 'manual'
  if (rows.some((r) => r.status === 'warn')) return 'warn'
  return 'pass'
}

// ── 运行期覆盖：白名单、禁用的规则、阈值、自定义规则 ────────────────────────

/** 把 runtime.json 的 thresholds 深合并进规则表，支持 "repo.maxIdleDays" 这样的路径。 */
function applyThresholds(rules, thresholds) {
  for (const [path, value] of Object.entries(thresholds ?? {})) {
    const [ruleId, key, ...rest] = path.split('.')
    const rule = rules[ruleId]
    if (!rule) continue
    if (key === undefined) {
      rules[ruleId] = value
      continue
    }
    if (rest.length === 0) rule[key] = value
    else rule[key] = { ...(rule[key] ?? {}), [rest.join('.')]: value }
  }
  return rules
}

/** 把 facts 里的一条路径取出来，供声明式规则用。 */
function resolveFact(facts, path) {
  return String(path)
    .split('.')
    .reduce((value, key) => (value === undefined || value === null ? undefined : value[key]), facts)
}

/** 数字/字符串/布尔三种字面量。 */
function literalOf(raw) {
  const text = String(raw).trim().replace(/^['"]|['"]$/g, '')
  if (text === 'true') return true
  if (text === 'false') return false
  if (text !== '' && !Number.isNaN(Number(text))) return Number(text)
  return text
}

/** 单个比较项：`repo.stars < 100`。 */
/** 单个比较项：`repo.stars < 100`，或数组包含：`deps contains "lodash"`。 */
function evalTerm(term, facts) {
  const contains = /^([\w.]+)\s+contains\s+(.+)$/.exec(term.trim())
  if (contains !== null) {
    const left = resolveFact(facts, contains[1])
    const right = String(literalOf(contains[2]))
    if (Array.isArray(left)) return left.map(String).includes(right)
    if (typeof left === 'string') return left.includes(right)
    return false
  }
  const match = /^([\w.]+)\s*(>=|<=|==|!=|>|<)\s*(.+)$/.exec(term.trim())
  if (!match) return false
  const left = resolveFact(facts, match[1])
  const right = literalOf(match[3])
  if (left === undefined) return false
  switch (match[2]) {
    case '>':
      return Number(left) > Number(right)
    case '<':
      return Number(left) < Number(right)
    case '>=':
      return Number(left) >= Number(right)
    case '<=':
      return Number(left) <= Number(right)
    case '==':
      return left === right || String(left) === String(right)
    case '!=':
      return !(left === right || String(left) === String(right))
    default:
      return false
  }
}

/**
 * 声明式条件：`&&` 优先于 `||`，只支持「字段 + 比较符 + 字面量」。
 * 刻意不实现 eval——rule 来自用户可编辑的 JSON，不该有执行代码的能力。
 */
function evalCondition(expression, facts) {
  if (typeof expression !== 'string' || expression.trim() === '') return false
  return expression
    .split('||')
    .some((branch) => branch.split('&&').every((term) => evalTerm(term, facts)))
}

/** 把 {repo.stars} 这样的占位替换成实际值。 */
function renderTemplate(template, facts) {
  return String(template ?? '').replace(/\{([\w.]+)\}/g, (_all, path) => {
    const value = resolveFact(facts, path)
    return value === undefined || value === null ? '—' : String(value)
  })
}

/** 把预检收集到的事实摊平成一张表，供自定义规则引用。 */
function buildFacts({ pkg, version, meta, repoFacts, hostVersion, source }) {
  const deps = Object.keys(meta.dependencies ?? {})
  const scripts = Object.keys(meta.scripts ?? {})
  return {
    name: pkg,
    version,
    hostVersion,
    source,
    license: meta.license ?? '',
    author: typeof meta.author === 'string' ? meta.author : meta.author?.name ?? '',
    description: meta.description ?? '',
    keywords: meta.keywords ?? [],
    deprecated: Boolean(meta.deprecated),
    provenance: Boolean(meta.dist?.attestations?.provenance),
    depsCount: deps.length,
    deps,
    scripts,
    scriptsCount: scripts.length,
    keywordsCount: (meta.keywords ?? []).length,
    hasInstallScript: scripts.some((name) => ['preinstall', 'install', 'postinstall'].includes(name)),
    repo: repoFacts ?? { found: false, slug: null, stars: 0, idleDays: null, archived: false, forks: 0, openIssues: 0, license: '' },
  }
}

async function main() {
  const argv = process.argv.slice(2)
  const flags = new Set(argv.filter((a) => a.startsWith('--')))
  const json = flags.has('--json')
  const valueOf = (name) => {
    const i = argv.indexOf(name)
    return i >= 0 ? argv[i + 1] : undefined
  }
  const pkg = argv.find(
    (a) => !a.startsWith('--') && a !== valueOf('--version') && a !== valueOf('--host') && a !== valueOf('--config'),
  )
  const wantVersion = valueOf('--version')
  const hostVersion = valueOf('--host')
  const source = valueOf('--source') ?? 'npm'
  const configPath = valueOf('--config')

  if (!pkg) {
    console.error('用法：node preflight.mjs <包名> [--version x.y.z] [--host x.y.z] [--config runtime.json] [--json]')
    process.exit(2)
  }

  const policy = JSON.parse(await readFile(POLICY_PATH, 'utf8'))
  const host = hostVersion ?? policy.hostVersion

  // 运行期覆盖（来自侧栏面板）：白名单、禁用规则、阈值、自定义规则
  let overrides = {}
  if (configPath !== undefined) {
    try {
      overrides = JSON.parse(await readFile(configPath, 'utf8'))
    } catch {
      overrides = {}
    }
  }
  const rules = applyThresholds(policy.rules, overrides.thresholds)

  // 白名单：整包跳过检查
  const allowlist = Array.isArray(overrides.allowlist) ? overrides.allowlist : []
  if (allowlist.includes(pkg)) {
    const allowlisted = {
      package: pkg,
      version: wantVersion ?? '',
      hostVersion: host,
      verdict: 'pass',
      verdictLabel: '白名单',
      rows: [{ id: 'allowlist', title: '白名单', status: 'pass', detail: `${pkg} 在白名单内，跳过全部检查` }],
    }
    console.log(json ? JSON.stringify(allowlisted, null, 2) : `\n插件预检：${pkg}\n结论：白名单（跳过检查）\n`)
    return
  }

  const doc = await getJson(`${REGISTRY}/${encodeURIComponent(pkg).replace('%40', '@')}`)
  if (!doc.ok) {
    console.error(`预检失败：npm 上找不到 ${pkg}（HTTP ${doc.status}）`)
    process.exit(1)
  }
  const latest = doc.body['dist-tags'].latest
  const version = wantVersion ?? latest
  const meta = doc.body.versions[version]
  if (!meta) {
    console.error(`预检失败：${pkg} 没有版本 ${version}`)
    process.exit(1)
  }

  const repoCheck = await checkRepo(meta, rules.repo, doc.body, pkg)
  const facts = buildFacts({ pkg, version, meta, repoFacts: repoCheck.facts, hostVersion: host, source })

  // 自定义规则：声明式条件 + 模板化说明
  const custom = Array.isArray(overrides.customRules) ? overrides.customRules : []

  // 只有规则真的引用了 npm.* 才去查下载量——不为一个可能用不到的字段多打一次网络
  if (custom.some((rule) => typeof rule?.when === 'string' && rule.when.includes('npm.'))) {
    const downloads = await getJson(`https://api.npmjs.org/downloads/point/last-week/${encodeURIComponent(pkg)}`)
    facts.npm = { weeklyDownloads: downloads.ok ? (downloads.body?.downloads ?? 0) : 0 }
  }

  const rows = [
    { id: 'repo', title: rules.repo.title, status: repoCheck.status, detail: repoCheck.detail },
    { id: 'installScripts', title: rules.installScripts.title, ...checkInstallScripts(meta, rules.installScripts, source) },
    { id: 'deprecated', title: rules.deprecated.title, ...checkDeprecated(meta, doc.body, rules.deprecated) },
    { id: 'aggregate', title: rules.aggregate.title, ...checkAggregate(meta, rules.aggregate) },
    { id: 'compatibility', title: rules.compatibility.title, ...checkCompatibility(meta, host, rules.compatibility) },
    { id: 'selfUpdate', title: rules.selfUpdate.title, ...checkSelfUpdate(meta, rules.selfUpdate, doc.body) },
    { id: 'accounts', title: rules.thirdPartyAccounts.title, ...checkAccounts(meta, rules.thirdPartyAccounts) },
    { id: 'provenance', title: rules.provenance.title, ...checkProvenance(meta) },
    { id: 'versionPin', title: rules.versionPin.title, ...checkPin(meta, version, rules.versionPin) },
  ]

  // 禁用的规则：保留在输出里但标记跳过，不参与结论
  const disabled = new Set(Array.isArray(overrides.disabledRules) ? overrides.disabledRules : [])
  const marked = rows.map((row) => (disabled.has(row.id) ? { ...row, status: 'skip', detail: '已禁用' } : row))

  // 自定义规则：逐条求值，命中即追加一条结果
  for (const rule of custom) {
    if (!rule || typeof rule !== 'object' || typeof rule.when !== 'string') continue
    if (disabled.has(rule.id)) continue
    let hit = false
    try {
      hit = evalCondition(rule.when, facts)
    } catch {
      hit = false
    }
    if (!hit) continue
    marked.push({
      id: rule.id ?? 'custom',
      title: rule.title ?? '自定义规则',
      status: rule.status === 'reject' || rule.status === 'manual' ? rule.status : 'warn',
      detail: renderTemplate(rule.detail ?? '命中条件：{when}', { ...facts, when: rule.when }),
    })
  }

  const verdict = verdictOf(marked)
  const result = {
    package: pkg,
    version,
    hostVersion: host,
    verdict,
    verdictLabel: policy.verdicts[verdict],
    rows: marked,
    facts,
  }

  if (json) {
    console.log(JSON.stringify(result, null, 2))
    return
  }

  console.log('')
  console.log(`插件预检：${pkg}@${version}   宿主 ${host}   来源 ${source}`)
  console.log('─'.repeat(72))
  for (const r of marked) {
    console.log(`${ICON[r.status] ?? ' '} ${r.title}：${r.detail}`)
  }
  console.log('─'.repeat(72))
  console.log(`结论：${result.verdictLabel}`)
  if (verdict === 'reject') console.log('建议：不装。若确需安装，先确认上述 ✗ 项是否可接受。')
  if (verdict === 'warn') console.log('建议：可装，但装前逐条确认 ! 项，装后钉版本。')
  if (verdict === 'manual') console.log('建议：先人工确认 ? 项（是否要求账号、数据发往何处），再决定。')
  if (verdict === 'pass') console.log('建议：可以装。装后用精确版本，不用 ^。')
  console.log('')
}

main().catch((err) => {
  console.error(`预检异常：${err.message}`)
  process.exit(1)
})
