// 闸门自测：用假的 ctx、假的 pluginManager、假的预检结果驱动 apply()。
// 全程不联网、不起子进程——真实预检已由 preflight.mjs 自己的回归测试覆盖。
//
// 运行：node scripts/selftest.mjs
//
// 注意：本文件在 DSH 沙箱内运行时，任何 spawn + 管道都会 EPERM（沙箱不允
// 许子进程开命名管道），所以预检必须注入桩函数，不能真起子进程。

import { mkdir, mkdtemp, readFile, readdir, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply, formatReport, validateCustomRules, admitRequest } from '../index.js'

const results = []
const check = (label, ok, detail = '') => {
  results.push({ label, ok })
  console.log(`${ok ? '✓' : '✗'} ${label}${detail ? ` — ${detail}` : ''}`)
}

const workspaceRoot = await mkdtemp(join(tmpdir(), 'guard-selftest-'))
const calls = []
const manager = {
  // 界面靠这个 Map 按 requestId 取安装结果，闸门必须能往里写「明确失败」
  installs: new Map(),
  installBundle: async (spec) => {
    calls.push(spec)
    return { ok: true, spec }
  },
}

// 桩：复刻 preflight.mjs 的 JSON 形态
const stub = async (pkg) => {
  if (pkg === 'dsh-our-free-model') {
    return {
      ok: true,
      data: {
        verdict: 'reject',
        verdictLabel: '拒绝',
        version: '2.1.0',
        rows: [{ status: 'reject', title: '是否已弃用', detail: '已弃用：no longer maintained' }],
      },
    }
  }
  if (pkg.startsWith('dsh-context')) {
    return { ok: true, data: { verdict: 'pass', verdictLabel: '通过', version: '0.77.0', rows: [] } }
  }
  if (pkg === 'dsh-warn-me') {
    return { ok: true, data: { verdict: 'warn', verdictLabel: '警告', version: '1.0.0', rows: [] } }
  }
  return { ok: false, reason: 'stub: 无法验证' }
}

const disposers = []
const logs = []
const events = []
const ctx = {
  logger: { info: (m) => logs.push(m), warn: (m) => logs.push(`WARN ${m}`) },
  get: (key) => (key === 'pluginManager' ? manager : undefined),
  effect: (factory) => disposers.push(factory()),
  emit: (name, payload) => events.push({ name, payload }),
}

const runtimeFile = join(workspaceRoot, 'runtime.json')
apply(ctx, { workspaceRoot, mode: 'enforce', preflight: stub, runtimeFile })

// 1) 通过预检 → 放行
try {
  await manager.installBundle('dsh-context@0.77.0')
  check('通过项放行', calls.includes('dsh-context@0.77.0'))
} catch (error) {
  check('通过项放行', false, error.message)
}

// 2) 拒绝 → 拦截，且原方法不被调用
const before = calls.length
try {
  await manager.installBundle('dsh-our-free-model', { requestId: 'req-blocked-1' })
  check('拒绝项拦截', false, '未抛错')
} catch (error) {
  check('拒绝项拦截', calls.length === before && /已拦截安装/.test(error.message), error.message.slice(0, 50))
}

// 2b) 拦截必须给界面留下可读的失败结果（形状必须是安装结果对象，不是 RPC 信封）
const stuck = await manager.installs.get('req-blocked-1')?.result
check(
  '写入任务失败结果',
  stuck?.application === 'failed' && /已拦截安装/.test(stuck.error?.message ?? ''),
  `application=${stuck?.application} code=${stuck?.error?.code}`,
)

// 2c) 还要往安装详情面板补一条 stderr 日志，且必须是结构化报告
const logEvent = events.find((e) => e.name === 'plugin-manager/install-log' && e.payload.requestId === 'req-blocked-1')
const detail = logEvent?.payload?.text ?? ''
check(
  '发送安装日志事件',
  logEvent?.payload?.stream === 'stderr' && detail.includes('插件预检未通过'),
  logEvent?.payload?.jobId,
)
check(
  '报告结构化：列出不满足项',
  detail.includes('不满足的条件（1 项）') && detail.includes('✗ 是否已弃用') && detail.includes('其余 0 项通过'),
  detail.split('\n')[2] ?? '',
)

// 3) 警告 → 放行（只拦明确拒绝）
try {
  await manager.installBundle('dsh-warn-me')
  check('警告项放行', calls.includes('dsh-warn-me'))
} catch (error) {
  check('警告项放行', false, error.message)
}

// 4) 预检跑不成 → 默认策略是「拦截」，不让「卡住网络」变成绕过手段
try {
  await manager.installBundle('dsh-unknown-pkg')
  check('无法验证默认拦截', false, '未抛错')
} catch (error) {
  check('无法验证默认拦截', /无法完成/.test(error.message), error.message.slice(0, 30))
}

// 4b) 显式改成放行后，同一个包应通过
await writeFile(runtimeFile, JSON.stringify({ onUnverified: 'allow' }), 'utf8')
try {
  await manager.installBundle('dsh-unknown-pkg')
  check('策略放行时通过', calls.includes('dsh-unknown-pkg'))
} catch (error) {
  check('策略放行时通过', false, error.message)
}

// 5) 本地路径规格 → 跳过预检
try {
  await manager.installBundle('E:/tmp/some-local-plugin')
  check('本地路径跳过预检', calls.includes('E:/tmp/some-local-plugin'))
} catch (error) {
  check('本地路径跳过预检', false, error.message)
}

// 5b) 运行期开关：把 runtime.json 改成 warn，同一个包应立即放行（无需重启）
await writeFile(runtimeFile, JSON.stringify({ mode: 'warn' }), 'utf8')
try {
  await manager.installBundle('dsh-our-free-model')
  check('warn 模式热切换放行', calls.includes('dsh-our-free-model'))
} catch (error) {
  check('warn 模式热切换放行', false, error.message)
}

// 5c) 改回 enforce，同一个包应再次被拦（证明是读文件、不是读启动配置）
await writeFile(runtimeFile, JSON.stringify({ mode: 'enforce' }), 'utf8')
try {
  await manager.installBundle('dsh-our-free-model')
  check('enforce 模式恢复拦截', false, '未抛错')
} catch (error) {
  check('enforce 模式恢复拦截', /已拦截安装/.test(error.message))
}

// 6) 卸载还原：放在最后做——一旦还原，manager 就不再被闸门包裹，
//    后续用例会静默绕过闸门（这正是这条用例最初放太早造成的坑）。

// 7) 审计落盘
await new Promise((r) => setTimeout(r, 200))
const auditPath = join(workspaceRoot, 'docs', 'audit', 'plugin-guard.jsonl')
const records = (await readFile(auditPath, 'utf8'))
  .trim()
  .split('\n')
  .filter(Boolean)
  .map((l) => JSON.parse(l))
check('审计日志落盘', records.length >= 3, `${records.length} 条`)
check('拦截记录 blocked=true', records.some((r) => r.blocked === true && r.verdict === 'reject'))
check('跳过记录 verdict=skipped', records.some((r) => r.verdict === 'skipped'))
check('无法验证记录 verdict=unknown', records.some((r) => r.verdict === 'unknown'))
check('拦截时写入了原因', records.some((r) => r.blocked && r.reason.includes('已弃用')))

// 8) 拦截时写人可读通知：界面拿不到原因，这是唯一的兜底告知渠道
const notice = await readFile(join(workspaceRoot, 'docs', 'audit', 'last-block.md'), 'utf8')
check('拦截通知落盘', notice.includes('dsh-our-free-model') && notice.includes('已弃用'))

// 9) 报告必须显式列出被禁用的规则，否则「为什么这条没拦住」会变成悬案
const report = formatReport(
  {
    rows: [
      { id: 'deprecated', title: '是否已弃用', status: 'reject', detail: '已弃用：x' },
      { id: 'compatibility', title: '宿主版本兼容', status: 'skip', detail: '已禁用' },
      { id: 'provenance', title: 'provenance 签名', status: 'pass', detail: '有签名' },
    ],
  },
  'demo-pkg',
  '1.0.0',
)
check('报告列出已禁用规则', report.includes('已禁用（1 项') && report.includes('宿主版本兼容'), report.split('\n').slice(-4).join(' / '))

// 10) 自定义规则保存期校验：字段名写错必须当场拒绝，不能留一条永不命中的规则
check('合法规则通过校验', validateCustomRules([{ title: '冷门', when: 'repo.stars < 50', status: 'warn' }]) === null)
check(
  '未知字段被拒绝',
  String(validateCustomRules([{ title: '写错了', when: 'repo.star > 1' }])).includes('未知字段'),
  String(validateCustomRules([{ title: '写错了', when: 'repo.star > 1' }])).slice(0, 28),
)
check('语法错误被拒绝', String(validateCustomRules([{ title: 'x', when: 'repo.stars' }])).includes('无法解析'))
check('非法等级被拒绝', String(validateCustomRules([{ title: 'x', when: 'repo.stars < 1', status: 'block' }])).includes('等级'))
check('缺失标题被拒绝', String(validateCustomRules([{ when: 'repo.stars < 1' }])).includes('缺少标题'))
check('contains 语法通过校验', validateCustomRules([{ title: 'x', when: 'deps contains "lodash"' }]) === null)
check('新字段通过校验', validateCustomRules([{ title: 'x', when: 'repo.forks > 10' }]) === null)
check(
  'contains 的未知字段被拒绝',
  String(validateCustomRules([{ title: 'x', when: 'depsx contains "a"' }])).includes('未知字段'),
)

// 11) 降级：宿主没有 emit、也没有 installs 时，拦截必须仍然生效且不崩
const bareManager = { installBundle: async () => ({ ok: true }) }
const bareCtx = {
  logger: { info: () => {}, warn: () => {} },
  get: (key) => (key === 'pluginManager' ? bareManager : undefined),
  effect: (factory) => factory(),
}
apply(bareCtx, { workspaceRoot, mode: 'enforce', preflight: stub, runtimeFile })
try {
  await bareManager.installBundle('dsh-our-free-model')
  check('降级时仍然拦截', false, '未抛错')
} catch (error) {
  check('降级时仍然拦截', /已拦截安装/.test(error.message))
}

// 12) 请求准入：挡住 DNS rebinding / 局域网直连，放行本机与桌面自定义协议
const req = (host, origin) => ({ headers: { host, origin } })
check('本机 Host 放行', admitRequest(req('127.0.0.1:23322', 'http://127.0.0.1:23322')) === undefined)
check('localhost 放行', admitRequest(req('localhost:23322', '')) === undefined)
check('桌面 dsh-app 放行', admitRequest(req('dsh-app', 'dsh-app://x')) === undefined)
check('外部域名被拒（rebinding）', admitRequest(req('evil.example.com', '')) === 403)
check('局域网 IP 被拒', admitRequest(req('192.168.1.9:23322', '')) === 403)
check('外部 Origin 被拒', admitRequest(req('127.0.0.1:23322', 'https://evil.example.com')) === 403)

// 13) 审计轮转：超过上限自动改名成 .1，主文件继续写
await writeFile(runtimeFile, JSON.stringify({ auditMaxBytes: 400 }), 'utf8')
const sizeBefore = (await stat(auditPath).catch(() => ({ size: -1 }))).size
const runtimeNow = await readFile(runtimeFile, 'utf8').catch(() => '(读不到)')
for (const name of ['pkg-a', 'pkg-b', 'pkg-c', 'pkg-d', 'pkg-e', 'pkg-f']) {
  try {
    await manager.installBundle(name)
  } catch {
    // 这些包会走「无法验证」分支，抛错是预期的；记录仍然写入
  }
}
const rotated = await readFile(`${auditPath}.1`, 'utf8').catch(() => '')
const auditDirFiles = (await readdir(join(workspaceRoot, 'docs', 'audit')).catch(() => [])).join(',')
check('审计轮转生成 .1', rotated.length > 0, `轮转前 ${sizeBefore}B | 配置 ${runtimeNow.trim()} | 目录: ${auditDirFiles} | 日志: ${logs.filter((l) => l.includes('轮转')).join(' / ') || '无'}`)

// 15) 运行期配置默认落在数据目录（docs/runtime.json），不再写进安装目录
await mkdir(join(workspaceRoot, 'docs'), { recursive: true })
await writeFile(join(workspaceRoot, 'docs', 'runtime.json'), JSON.stringify({ mode: 'warn' }), 'utf8')
const manager2 = { installs: new Map(), installBundle: async () => ({}) }
apply(
  { logger: { info: () => {}, warn: () => {} }, get: () => manager2, effect: (factory) => factory(), emit: () => {} },
  { workspaceRoot, preflight: stub },
)
try {
  await manager2.installBundle('dsh-our-free-model')
  check('默认读 docs/runtime.json', calls.includes('dsh-our-free-model'))
} catch (error) {
  check('默认读 docs/runtime.json', false, error.message.slice(0, 30))
}

// 14) 卸载还原（必须最后执行：还原后 manager 不再经过闸门）
const wrapped = manager.installBundle
for (const dispose of disposers) dispose()
check('卸载还原原方法', manager.installBundle !== wrapped)

const failed = results.filter((r) => !r.ok)
console.log('')
console.log(`结果：${results.length - failed.length}/${results.length} 通过`)
if (failed.length > 0) process.exit(1)
