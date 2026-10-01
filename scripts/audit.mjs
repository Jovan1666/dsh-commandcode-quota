/**
 * Pre-publish audit: fail loudly if any credential-shaped string, personal
 * absolute path, or inconsistent catalog artifact is about to be committed.
 *
 * Run from the repo root: node scripts/audit.mjs
 */

import { spawnSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
/** The plugin directory -- not just `scripts/`: tests, client and catalog live one level up. */
const ROOT = path.resolve(HERE, '..')
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
const walk = (dir, onFile) => {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (SKIP_DIRS.has(entry.name)) continue
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) { walk(full, onFile); continue }
    if (!EXTENSIONS.test(entry.name)) continue
    onFile(full)
  }
}

walk(ROOT, (file) => {
  const text = readFileSync(file, 'utf8')
  for (const [pattern, label] of [...SECRETS, ...PERSONAL]) {
    const matches = text.match(pattern)
    if (matches !== null) {
      found.push({ file: path.relative(ROOT, file), label, count: matches.length, sample: matches[0] })
    }
  }
})

const credentials = found.filter((hit) => SECRETS.some(([, label]) => label === hit.label))
const personal = found.filter((hit) => !credentials.includes(hit))

console.log('=== 凭据 ===')
console.log(credentials.length === 0 ? '  干净' : credentials.map((h) => `  !! ${h.file} → ${h.label} ×${String(h.count)}`).join('\n'))
console.log('=== 个人绝对路径 / 邮箱 ===')
console.log(personal.length === 0 ? '  干净' : personal.map((h) => `  -  ${h.file} → ${h.label} ×${String(h.count)}`).join('\n'))

/* ------------------------------------------------------- 目录数据层 */

/**
 * The catalog ships two artifacts: a generated baseline (`catalog.seed.json`) and
 * the real captures its tests assert against. Both are data the panel trusts, so
 * both get audited here:
 *
 *   1. the seed exists, parses, carries the right kind/version/schema and stays
 *      under 384 KB (bigger means upstream page bodies leaked into it);
 *   2. `scripts/catalog-seed.mjs --check` recomputes every count in the seed from
 *      the inputs the seed stores -- CI goes red when the formula moves and
 *      nobody regenerates the baseline;
 *   3. fixture captures keep their provenance and their shape: a pure flight slice
 *      must not smuggle in a page shell, and an HTML fallback slice must really
 *      carry flight chunks.
 */

const SEED_FILE = path.join(ROOT, 'catalog.seed.json')
const FIXTURES_DIR = path.join(ROOT, 'tests', 'fixtures')
const MAX_SEED_BYTES = 384 * 1024
const catalogProblems = []
const problem = (message) => catalogProblems.push(message)

if (!existsSync(SEED_FILE)) {
  problem('catalog.seed.json 不存在：首次运行 / 离线安装将没有基线可显示')
} else {
  const size = statSync(SEED_FILE).size
  if (size > MAX_SEED_BYTES) problem(`catalog.seed.json 有 ${String(size)} 字节，超过 ${String(MAX_SEED_BYTES)} 上限（多半把上游正文也塞了进来）`)
  const raw = readFileSync(SEED_FILE, 'utf8')
  let seed
  try {
    seed = JSON.parse(raw)
  } catch (error) {
    problem(`catalog.seed.json 不是合法 JSON：${error.message}`)
  }
  if (seed !== undefined && seed !== null && typeof seed === 'object') {
    for (const [key, expected] of [['kind', 'commandcode-catalog'], ['version', 1], ['schema', 2]]) {
      if (seed[key] !== expected) problem(`catalog.seed.json 的 ${key} 应为 ${JSON.stringify(expected)}，实际 ${JSON.stringify(seed[key])}`)
    }
    if (seed.plans === null || typeof seed.plans !== 'object' || Object.keys(seed.plans).length === 0) {
      problem('catalog.seed.json 里一个档位都没有')
    }
    for (const marker of ['<html', '<script', '__next_f']) {
      if (raw.includes(marker)) problem(`catalog.seed.json 里混进了上游正文（${marker}）：seed 只应存解析结果`)
    }
    for (const [pattern, label] of [...SECRETS, ...PERSONAL]) {
      const hit = raw.match(pattern)
      if (hit !== null) problem(`catalog.seed.json 里出现${label}：${hit[0].slice(0, 24)}…`)
    }
  }
}

if (existsSync(SEED_FILE)) {
  const run = spawnSync(process.execPath, [path.join(HERE, 'catalog-seed.mjs'), '--check'], {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: 120_000,
  })
  const output = `${run.stdout ?? ''}${run.stderr ?? ''}`
  if (run.status !== 0) {
    problem(`catalog-seed.mjs --check 未通过（退出码 ${String(run.status)}）：${output.trim().split('\n').slice(-2).join(' | ')}`)
  } else if (!output.includes('seed 校验通过')) {
    problem('catalog-seed.mjs --check 没有打印「seed 校验通过」')
  }
}

if (!existsSync(FIXTURES_DIR)) {
  problem('tests/fixtures 不存在：catalog 的离线测试没有真实素材')
} else {
  walk(FIXTURES_DIR, (file) => {
    const name = path.relative(FIXTURES_DIR, file)
    if (!/\.txt$/.test(name)) return
    const text = readFileSync(file, 'utf8')
    if (!text.includes('Fixture:')) problem(`${name} 没有说明自己是什么（缺少文件头注释）`)
    if (!/Source: GET https:\/\/commandcode\.ai\/docs\//.test(text.slice(0, 900))) problem(`${name} 的文件头没有写明来源 URL`)
    if (name.endsWith('.html.txt')) {
      if (!text.includes('self.__next_f.push')) problem(`${name} 是 HTML 兜底切片，却没有任何 __next_f 分块`)
    } else if (text.includes('<script') || text.includes('__next_f')) {
      problem(`${name} 是 RSC 切片，却混进了页面外壳（<script / __next_f）`)
    }
  })
}

console.log('=== 目录数据（catalog / seed / fixtures）===')
console.log(catalogProblems.length === 0 ? '  干净' : catalogProblems.map((message) => `  !! ${message}`).join('\n'))

process.exitCode = credentials.length === 0 && catalogProblems.length === 0 ? 0 : 1
