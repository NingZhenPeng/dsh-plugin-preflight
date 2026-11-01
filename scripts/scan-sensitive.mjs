// 敏感内容扫描器：出库、提交前、推送前三处共用同一份规则。
//
// 规则只写在这里。分散成三份的结果一定是慢慢漂移，最后某一道门形同虚设。
//
// 用法（CLI）：
//   node scripts/scan-sensitive.mjs <文件或目录> [...]
//   命中任意一条即打印位置并以 exit 1 结束；未命中 silent + exit 0。
//
// 用法（模块）：
//   import { scanPaths, scanTree, PATTERNS } from './scan-sensitive.mjs'

import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

export const PATTERNS = [
  { name: '本机绝对路径', re: /[A-Za-z]:\\{1,2}(?:Users|workerSoftwareDir)\\/i },
  { name: 'npm token', re: /npm_[A-Za-z0-9]{20,}/ },
  // 收紧要避免把 `pkg@1.2.3` 当成邮箱：域名以字母开头，顶级域至少两位字母
  { name: '邮箱地址', re: /[\w.+-]+@[A-Za-z][\w-]*\.[A-Za-z]{2,}/ },
  { name: '私钥', re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
]

const TEXT_FILE = /\.(js|mjs|cjs|json|md|yml|yaml|svg|txt|sh|ps1|html|css)$/i

/** 扫描单个文件，返回命中列表。 */
export function scanFile(file) {
  const hits = []
  let text
  try {
    text = readFileSync(file, 'utf8')
  } catch {
    return hits // 读不了就跳过，不因为一个怪文件让整道门失效
  }
  text.split('\n').forEach((line, index) => {
    for (const { name, re } of PATTERNS) {
      const match = re.exec(line)
      if (match !== null) hits.push({ file, line: index + 1, label: name, text: match[0].slice(0, 60) })
    }
  })
  return hits
}

/** 扫描给定路径列表（文件或目录，目录会递归）。 */
export function scanPaths(paths) {
  const hits = []
  const walk = (target) => {
    let info
    try {
      info = statSync(target)
    } catch {
      return
    }
    if (info.isDirectory()) {
      for (const name of readdirSync(target)) {
        if (name === '.git' || name === 'node_modules') continue
        walk(join(target, name))
      }
      return
    }
    if (!TEXT_FILE.test(target)) return
    hits.push(...scanFile(target))
  }
  for (const target of paths) walk(target)
  return hits
}

/** 扫描整个目录树。 */
export function scanTree(dir) {
  return scanPaths([dir])
}

// ── CLI ────────────────────────────────────────────────────────────────
// 用 pathToFileURL 比较：Windows 上手拼 file:// 会少斜杠，导致 CLI 分支永远不进
const invokedDirectly = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href
if (invokedDirectly) {
  const targets = process.argv.slice(2)
  const hits = scanPaths(targets.length > 0 ? targets : ['.'])
  if (hits.length === 0) {
    console.log('✓ 未发现敏感内容')
    process.exit(0)
  }
  console.error('✗ 发现疑似敏感内容：')
  for (const hit of hits) console.error(`  ${hit.file}:${hit.line}  [${hit.label}]  ${hit.text}`)
  process.exit(1)
}
