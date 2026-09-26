#!/usr/bin/env node
/**
 * 校验本仓库里「同步产物」没有被就地改动。
 *
 * 本仓库的实现代码与测试由 monorepo（见 .sync-source.json 的 source）分发而来：
 * 那里是唯一真源，这里的副本是产物。就地改副本会有一个很坏的后果——下次同步
 * 会**静默覆盖**你的修改，而且不会有任何报错。这个脚本把那种改动变成一次红构建。
 *
 *   node scripts/verify-core.mjs
 *
 * 退出码 0 表示全部一致；非 0 时逐条列出被改动的文件。
 */
import { createHash } from 'node:crypto'
import { readFileSync, existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const RECORD = path.join(ROOT, '.sync-source.json')

if (!existsSync(RECORD)) {
  console.error('.sync-source.json 不存在：这个仓库没有同步记录，无法校验。')
  process.exit(2)
}

const record = JSON.parse(readFileSync(RECORD, 'utf8'))
const files = record.files ?? {}
if (Object.keys(files).length === 0) {
  console.error('.sync-source.json 里没有记录任何文件。')
  process.exit(2)
}

const digest = (file) => createHash('sha256').update(readFileSync(file)).digest('hex')
const drifted = []
const missing = []

for (const [relative, expected] of Object.entries(files)) {
  const file = path.join(ROOT, relative)
  if (!existsSync(file)) {
    missing.push(relative)
    continue
  }
  const actual = digest(file)
  if (actual !== expected) drifted.push({ relative, expected, actual })
}

console.log(`同步产物校验（来源：${record.source} @ ${String(record.sourceCommit).slice(0, 10)}）`)
console.log(`  记录 ${Object.keys(files).length} 个文件，逐字节比对`)

if (missing.length > 0) {
  console.error('\n缺失：')
  for (const relative of missing) console.error(`  ${relative}`)
}
if (drifted.length > 0) {
  console.error('\n被就地改动（这里的是产物，改了会被下次同步覆盖）：')
  for (const item of drifted) {
    console.error(`  ${item.relative}`)
    console.error(`    期望 ${item.expected.slice(0, 16)}…  实际 ${item.actual.slice(0, 16)}…`)
  }
}
if (missing.length > 0 || drifted.length > 0) {
  console.error('\n要改实现，请改真源仓库；改完在真源跑一次分发，本仓库的副本会随之更新。')
  process.exit(1)
}

console.log('  全部一致 ✅')
