/**
 * Latency probe: where does the card's first paint time actually go?
 *
 * Times each upstream endpoint separately, then the whole report, so the
 * optimisations are aimed at a measured cost instead of a guess. Run it before
 * and after a change to the fetch path.
 *
 * Run: node preview/latency.mjs [rounds]
 */

import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const { fetchQuotaReport, resolveApiKey, DEFAULT_API_BASE, DEFAULT_TIMEOUT_MS } = await import(
  pathToFileURL(path.join(here, '..', 'quota.mjs')).href
)

const ROUNDS = Number(process.argv[2] ?? 3)
const { key, apiBase } = resolveApiKey()
const base = (apiBase ?? DEFAULT_API_BASE).replace(/\/+$/, '')
const headers = {
  Authorization: `Bearer ${key}`,
  'x-command-code-version': '1.54.2',
  'x-cli-environment': 'production',
  'User-Agent': 'commandcode-quota/latency',
}

const time = async (label, url) => {
  const started = performance.now()
  try {
    const response = await fetch(url, { headers, signal: AbortSignal.timeout(DEFAULT_TIMEOUT_MS) })
    const ms = performance.now() - started
    await response.json().catch(() => undefined)
    return { label, ms, status: response.status }
  } catch (error) {
    return { label, ms: performance.now() - started, status: `ERR ${error?.name ?? error}` }
  }
}

console.log(`probe: ${base}  rounds=${ROUNDS}\n`)
const totals = []

for (let round = 1; round <= ROUNDS; round += 1) {
  // One round as the layer does it today (whoami first, then the rest), timed
  // end to end, plus a round where all four go out together.
  const startedSequential = performance.now()
  const whoami = await time('whoami', `${base}/alpha/whoami`)
  const rest = await Promise.all([
    time('usage', `${base}/alpha/usage/summary`),
    time('credits', `${base}/alpha/billing/credits`),
    time('subscription', `${base}/alpha/billing/subscriptions`),
  ])
  const sequentialMs = performance.now() - startedSequential

  const startedParallel = performance.now()
  const all = await Promise.all([
    time('whoami', `${base}/alpha/whoami`),
    time('usage', `${base}/alpha/usage/summary`),
    time('credits', `${base}/alpha/billing/credits`),
    time('subscription', `${base}/alpha/billing/subscriptions`),
  ])
  const parallelMs = performance.now() - startedParallel

  for (const result of [whoami, ...rest]) {
    console.log(`  round ${round}  ${result.label.padEnd(13)} ${result.ms.toFixed(0).padStart(5)}ms  ${result.status}`)
  }
  console.log(`  round ${round}  ${'sequential'.padEnd(13)} ${sequentialMs.toFixed(0).padStart(5)}ms   (what the card waits for today)`)
  console.log(`  round ${round}  ${'all parallel'.padEnd(13)} ${parallelMs.toFixed(0).padStart(5)}ms   (slowest endpoint + one hop)`)
  console.log(
    `  round ${round}  ${'fastest'.padEnd(13)} ${Math.min(...all.map((r) => r.ms)).toFixed(0).padStart(5)}ms   ` +
    `slowest ${Math.max(...all.map((r) => r.ms)).toFixed(0).padStart(5)}ms`,
  )
  console.log('')
  totals.push({ sequentialMs, parallelMs })
}

const wholeReport = []
for (let round = 1; round <= ROUNDS; round += 1) {
  const started = performance.now()
  await fetchQuotaReport()
  wholeReport.push(performance.now() - started)
}

const mean = (values) => values.reduce((sum, value) => sum + value, 0) / values.length
const pct = (values, p) => [...values].sort((a, b) => a - b)[Math.min(values.length - 1, Math.floor((values.length - 1) * p))]

console.log('─'.repeat(64))
console.log(`report today (whoami, then three in parallel): mean ${mean(totals.map((t) => t.sequentialMs)).toFixed(0)}ms`)
console.log(`if all four went out together:                   mean ${mean(totals.map((t) => t.parallelMs)).toFixed(0)}ms`)
console.log(`fetchQuotaReport end to end:                     mean ${mean(wholeReport).toFixed(0)}ms  p50 ${pct(wholeReport, 0.5).toFixed(0)}ms  max ${Math.max(...wholeReport).toFixed(0)}ms`)

// ── what the card's first paint waits for ────────────────────────────────────
// The question the panel actually poses: how long between the browser asking for
// a report and getting an answer? Measured twice, against the real host half:
// once with the snapshot on disk (a restart after the plugin has run before) and
// once without it (a first-ever run).
const { readFileSync, rmSync, writeFileSync } = await import('node:fs')
const { quotaSnapshotPath } = await import(pathToFileURL(path.join(here, '..', 'quota.mjs')).href)
const snapshotFile = quotaSnapshotPath()

/** Boot the host half against a throwaway context and time the first answer. */
const timeFirstAnswer = async () => {
  const seen = {}
  const ctx = {
    connection: { fetch: { register: (route) => { seen.route = route } } },
    logger: { info: () => {} },
    effect: (callback) => { callback() },
    get: () => undefined,
  }
  // Fresh module instance per measurement: the in-process cache must not carry
  // over, or the second measurement would be measuring the first one.
  const module = await import(`${pathToFileURL(path.join(here, '..', 'index.js')).href}?t=${String(Date.now())}-${String(Math.random())}`)
  module.apply(ctx)
  const started = performance.now()
  const response = await seen.route.fetch(new Request('http://dsh.internal/api/cc-quota/report', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ type: 'client-request', rpcId: 'latency', method: 'cc-quota/report', payload: {} }),
  }))
  const body = await response.json()
  return { ms: performance.now() - started, value: body.result?.value }
}

const hadSnapshot = (() => {
  try {
    return readFileSync(snapshotFile, 'utf8').length > 0
  } catch {
    return false
  }
})()

console.log('')
console.log('─'.repeat(64))
console.log('first paint after a dsh restart (the host route\'s first answer)')
if (hadSnapshot) {
  const warm = await timeFirstAnswer()
  console.log(`  with the snapshot on disk   ${warm.ms.toFixed(0).padStart(5)}ms   stale=${String(warm.value?.stale === true)}`)
  const after = await timeFirstAnswer()
  console.log(`  second answer (cache)       ${after.ms.toFixed(0).padStart(5)}ms   stale=${String(after.value?.stale === true)}`)
  console.log('  → the card has numbers on screen immediately; the live read lands behind it')
} else {
  console.log('  no snapshot yet — run this once while the plugin is working, then again to see the difference')
}
rmSync(snapshotFile, { force: true })
const cold = await timeFirstAnswer()
console.log(`  snapshot deleted (cold)     ${cold.ms.toFixed(0).padStart(5)}ms   stale=${String(cold.value?.stale === true)}`)
const restored = await timeFirstAnswer()
writeFileSync(snapshotFile, JSON.stringify(restored.value ?? {}), 'utf8')
console.log('  → and the snapshot is written back, so the next restart is instant again')

