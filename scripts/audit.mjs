/**
 * Pre-publish audit: fail loudly if any credential-shaped string or personal
 * absolute path is about to be committed.
 *
 * Run from the repo root: node .audit.mjs
 */

import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'

const ROOT = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'))
const SKIP_DIRS = new Set(['node_modules', '.devdeps', '.git'])
const EXTENSIONS = /\.(mjs|js|json|md|yml|yaml|cmd|txt|html)$/

const SECRETS = [
  [/user_[A-Za-z0-9_-]{20,}/g, 'Command Code API key'],
  [/sk-[A-Za-z0-9]{20,}/g, 'DeepSeek API key'],
  [/gh[pousr]_[A-Za-z0-9]{20,}/g, 'GitHub token'],
]

const PERSONAL = [
  [/C:\\+Users\\+[A-Za-z0-9._-]+/g, 'Windows home path'],
  [/\/Users\/[A-Za-z0-9._-]+/g, 'macOS home path'],
  [/3071058281@qq\.com/g, 'personal email'],
]

const found = []
const walk = (dir) => {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (SKIP_DIRS.has(entry.name)) continue
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) { walk(full); continue }
    if (!EXTENSIONS.test(entry.name)) continue
    const text = readFileSync(full, 'utf8')
    for (const [pattern, label] of [...SECRETS, ...PERSONAL]) {
      const matches = text.match(pattern)
      if (matches !== null) {
        found.push({ file: path.relative(ROOT, full), label, count: matches.length, sample: matches[0] })
      }
    }
  }
}

walk(ROOT)

const credentials = found.filter((hit) => SECRETS.some(([, label]) => label === hit.label))
const personal = found.filter((hit) => !credentials.includes(hit))

console.log('=== 凭据 ===')
console.log(credentials.length === 0 ? '  干净' : credentials.map((h) => `  !! ${h.file} → ${h.label} ×${String(h.count)}`).join('\n'))
console.log('=== 个人绝对路径 / 邮箱 ===')
console.log(personal.length === 0 ? '  干净' : personal.map((h) => `  -  ${h.file} → ${h.label} ×${String(h.count)}`).join('\n'))

process.exitCode = credentials.length === 0 ? 0 : 1
