// 推送前全量检查。由 githooks/pre-push 调用，也可手动运行：
//   node scripts/prepush-check.mjs
//
// 四件事，任何一项失败即 exit 1：
//   1. 敏感内容扫描（全量，不只改动）
//   2. 提交身份必须是 noreply
//   3. package.json 版本与 CHANGELOG 最新小节一致
//   4. 没有私有目录被跟踪

import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { scanTree } from './scan-sensitive.mjs'

const root = process.cwd()
const problems = []

// ── 1. 敏感内容 ─────────────────────────────────────────────────────────
const hits = scanTree(root)
for (const hit of hits) problems.push(`敏感内容 ${hit.file}:${hit.line} [${hit.label}] ${hit.text}`)

// ── 2. 提交身份 ─────────────────────────────────────────────────────────
const identities = execFileSync('git', ['log', '--all', '--format=%ae%n%ce'], { encoding: 'utf8' })
  .split('\n')
  .map((line) => line.trim())
  .filter((line) => line !== '')
const offenders = [...new Set(identities.filter((email) => !email.endsWith('@users.noreply.github.com')))]
for (const email of offenders) {
  problems.push(`提交身份不是 noreply：${email}（会公开真实邮箱）`)
}

// ── 3. 版本一致 ─────────────────────────────────────────────────────────
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
const changelog = readFileSync(join(root, 'CHANGELOG.md'), 'utf8')
const latest = /^##\s+(\d+\.\d+\.\d+)/m.exec(changelog)
if (latest === null) {
  problems.push('CHANGELOG 里找不到形如 "## 1.2.3" 的小节')
} else if (latest[1] !== pkg.version) {
  problems.push(`版本不一致：package.json=${pkg.version}，CHANGELOG=${latest[1]}`)
}

// ── 4. 私有目录 ─────────────────────────────────────────────────────────
for (const forbidden of ['docs', 'dsh-rules', 'node_modules', 'runtime.json', 'AGENTS.md']) {
  if (existsSync(join(root, forbidden))) problems.push(`不该存在于公开仓库：${forbidden}`)
}

// ── 结论 ────────────────────────────────────────────────────────────────
if (problems.length === 0) {
  console.log(`✓ 推送前检查通过（版本 ${pkg.version}，提交身份 ${identities.length / 2} 条）`)
  process.exit(0)
}
console.error('✗ 推送前检查未通过：')
for (const problem of problems) console.error(`  - ${problem}`)
console.error('\n修完再推。确实需要跳过时用 git push --no-verify，但 GitHub 侧的 Push Protection 仍会拦 token。')
process.exit(1)
