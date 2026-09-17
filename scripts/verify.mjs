/**
 * Run every offline check the repository has, in one pass, with one verdict.
 *
 * The suites are separate processes on purpose: each one boots the plugin
 * against its own isolated environment, so a leak between them would be a bug
 * in the tests themselves. This runner exists so that "verify the numbers" is a
 * single command that can be repeated — determinism is a property you check by
 * running the same thing again, not by reading the code once.
 *
 * Run: node scripts/verify.mjs [--live] [--quiet]
 *   --live   also hit a real account (needs real credentials)
 *   --quiet  print a one-line summary per suite instead of the full output
 * Exit code is non-zero if any check fails.
 */

import { spawnSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.dirname(here)
const live = process.argv.includes('--live')
const quiet = process.argv.includes('--quiet')

/** Order matters only for readability: cheapest and most isolated first. */
const SUITES = [
  { label: 'quota   (discovery contract)', file: 'tests/quota.test.mjs' },
  { label: 'host    (route, cache, concurrency)', file: 'tests/host.test.mjs' },
  { label: 'client  (rendering, boundaries)', file: 'tests/client.test.mjs' },
  { label: 'dynamic (drift, resets, bad payloads)', file: 'tests/dynamic.test.mjs' },
  { label: 'cli     (arguments, exit codes)', file: 'tests/cli.test.mjs' },
  { label: 'audit   (credentials, host paths)', file: 'scripts/audit.mjs' },
]

if (live) {
  SUITES.push(
    { label: 'live    (one real read, identity)', file: 'preview/e2e-live.mjs', informational: true, live: true },
    { label: 'drift   (repeated real reads)', file: 'preview/e2e-watch.mjs', args: ['3', '6'], informational: true, live: true },
  )
}

const results = []
let totalChecks = 0
for (const suite of SUITES) {
  const started = Date.now()
  const run = spawnSync(process.execPath, [path.join(root, suite.file), ...(suite.args ?? [])], {
    cwd: root,
    encoding: 'utf8',
    env: process.env,
  })
  const output = `${run.stdout ?? ''}${run.stderr ?? ''}`
  const counted = [...output.matchAll(/^(\d+) checks passed$/gm)].reduce((sum, match) => sum + Number(match[1]), 0)
  const verdict = [...output.matchAll(/^\s*(?:\[FAIL\]|FAIL)\s/gm)].length + [...output.matchAll(/^  FAIL\s/gm)].length
  const failed = run.status !== 0 || (verdict > 0 && suite.informational !== true)
  totalChecks += counted
  results.push({ label: suite.label, counted, status: run.status, failed, live: suite.live === true, ms: Date.now() - started })
  if (!quiet) {
    console.log(`\n──────── ${suite.label} ────────`)
    process.stdout.write(output)
  }
}

console.log(`\n${'═'.repeat(64)}`)
for (const result of results) {
  const mark = result.failed ? 'FAIL' : 'ok  '
  const counts = result.counted > 0 ? `${String(result.counted).padStart(3)} checks` : '   —   '
  console.log(`${mark}  ${result.label.padEnd(38)} ${counts}  ${String(result.ms).padStart(5)}ms`)
}
console.log(`${'═'.repeat(64)}`)
const failures = results.filter((result) => result.failed)
if (failures.length > 0) {
  console.log(`${failures.length} suite(s) FAILED`)
  process.exitCode = 1
} else {
  const offlineSuites = results.filter((result) => !result.live).length
  const liveSuites = results.length - offlineSuites
  console.log(`${totalChecks} checks passed in ${offlineSuites} offline suites${liveSuites > 0 ? `, plus ${liveSuites} live suite(s) against a real account` : ''}`)
  if (liveSuites === 0) console.log('Add --live to also hit a real account.')
}
