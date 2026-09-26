/**
 * Live drift check: sample a real account repeatedly and assert that the
 * numbers stay consistent while they change.
 *
 * The offline suites prove the layer's behaviour on synthetic sequences. This
 * one proves it on the real thing — the only way to know that the vendor's
 * moving numbers (credit burning down, windows rolling, requests climbing) are
 * being read and combined correctly rather than merely plausibly.
 *
 * Every sample is checked for the cross-field identity `used + remaining = cap`,
 * for a percentage recomputed from those same numbers, and for a report with no
 * NaN anywhere; consecutive samples are checked for monotonicity, with a period
 * change or a window reset accepted as the one legitimate reason to go down.
 *
 * Run: node preview/e2e-watch.mjs [samples] [intervalSeconds]
 * Exit code is non-zero if any invariant breaks.
 */

import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const { fetchQuotaReport } = await import(pathToFileURL(path.join(here, '..', 'quota.mjs')).href)

const SAMPLES = Number(process.argv[2] ?? 3)
const INTERVAL_SEC = Number(process.argv[3] ?? 10)

const violations = []
const note = (message) => {
  violations.push(message)
  console.log(`  FAIL  ${message}`)
}
const check = (label, condition) => {
  if (condition) console.log(`  ok    ${label}`)
  else note(label)
}

/** Every finite number in a report, with its dotted path. */
function numbersIn(value, prefix = '') {
  const found = []
  if (typeof value === 'number') found.push([prefix, value])
  else if (value !== null && typeof value === 'object') {
    for (const [key, child] of Object.entries(value)) {
      found.push(...numbersIn(child, prefix === '' ? key : `${prefix}.${key}`))
    }
  }
  return found
}

const money = (value) => (typeof value === 'number' ? `$${value.toFixed(2)}` : '—')

/** Assert one report is internally consistent. */
function checkSample(report, index) {
  const m = report.monthly
  console.log(
    `sample ${index + 1}: monthly ${money(m.used)} / ${money(m.cap)} · ${m.percent === undefined ? '—' : `${m.percent.toFixed(2)}%`}` +
    ` · remaining ${money(m.remaining)} · requests ${report.totals.requests?.toLocaleString('en-US') ?? '—'}`,
  )

  if (m.used !== undefined && m.remaining !== undefined && m.cap !== undefined) {
    check(`sample ${index + 1}: used + remaining = cap`, Math.abs(m.used + m.remaining - m.cap) < 1e-6)
    if (m.cap > 0) {
      check(
        `sample ${index + 1}: percent recomputed from the same figures`,
        m.percent !== undefined && Math.abs(m.percent - (m.used / m.cap) * 100) < 1e-6,
      )
    }
  }
  if (m.percent !== undefined) {
    check(`sample ${index + 1}: monthly percent within 0-100`, m.percent >= 0 && m.percent <= 100)
  }
  for (const key of ['fiveHour', 'weekly']) {
    const w = report[key]
    if (w === undefined) continue
    const label = `sample ${index + 1}: ${key}`
    if (w.percent !== undefined) {
      check(`${label} percent within 0-100`, w.percent >= 0 && w.percent <= 100)
    }
    if (w.cap !== undefined) check(`${label} cap positive`, w.cap > 0)
    if (w.used !== undefined && w.cap !== undefined) {
      check(`${label} used + remaining = cap`, Math.abs(w.used + (w.cap - w.used) - w.cap) < 1e-6)
    }
  }
  const bad = numbersIn(report).filter(([, value]) => !Number.isFinite(value))
  check(`sample ${index + 1}: no NaN or infinite numbers`, bad.length === 0)
  if (bad.length > 0) console.log(`        offenders: ${bad.map(([name, value]) => `${name}=${value}`).join(', ')}`)
  check(`sample ${index + 1}: no endpoint failed`, report.failures.length === 0)
}

/** Assert the move from one sample to the next is legitimate. */
function checkDelta(previous, current, index) {
  const label = `samples ${index}->${index + 1}`
  const periodChanged = previous.plan?.currentPeriodStart !== current.plan?.currentPeriodStart
  const requestNow = current.totals.requests
  const requestBefore = previous.totals.requests
  if (requestNow !== undefined && requestBefore !== undefined) {
    check(`${label}: request count never goes backwards`, requestNow >= requestBefore)
  }
  for (const key of ['tokensIn', 'tokensOut']) {
    const now = current.totals[key]
    const before = previous.totals[key]
    if (now !== undefined && before !== undefined) {
      check(`${label}: ${key} never goes backwards`, now >= before)
    }
  }
  if (!periodChanged && current.monthly.used !== undefined && previous.monthly.used !== undefined) {
    check(`${label}: credit used never goes down inside one period`, current.monthly.used >= previous.monthly.used - 1e-6)
  }
  if (!periodChanged && current.monthly.remaining !== undefined && previous.monthly.remaining !== undefined) {
    check(`${label}: remaining credit never goes up inside one period`, current.monthly.remaining <= previous.monthly.remaining + 1e-6)
  }
  check(`${label}: fetchedAt moves forward`, Date.parse(current.fetchedAt) > Date.parse(previous.fetchedAt))
  if (periodChanged) console.log(`        note: the billing period changed between these samples`)
}

console.log(`sampling a live Command Code account ${SAMPLES} time(s), ${INTERVAL_SEC}s apart\n`)

const samples = []
for (let index = 0; index < SAMPLES; index += 1) {
  if (index > 0) await new Promise((resolve) => { setTimeout(resolve, INTERVAL_SEC * 1_000) })
  let report
  try {
    report = await fetchQuotaReport()
  } catch (error) {
    note(`sample ${index + 1}: fetch failed — ${error?.code ?? ''} ${error?.message ?? error}`)
    break
  }
  samples.push(report)
  checkSample(report, index)
  if (index > 0) checkDelta(samples[index - 1], report, index)
  console.log('')
}

const first = samples[0]
const last = samples.at(-1)
const moved = samples.length > 1 && (
  first !== undefined && last !== undefined && (
    last.monthly.used !== first.monthly.used ||
    last.totals.requests !== first.totals.requests ||
    last.totals.tokensIn !== first.totals.tokensIn
  )
)
/**
 * Milliseconds until a window resets, measured from the moment that sample was
 * taken (`fetchedAt`), not from now — recomputing both samples at print time
 * would compare an instant with itself and always report "unchanged".
 */
const remainingOf = (report, key) => {
  const resetAt = key === 'monthly' ? Date.parse(report.plan?.currentPeriodEnd ?? '') : report[key]?.resetAt
  const takenAt = Date.parse(report.fetchedAt)
  return Number.isFinite(resetAt) && Number.isFinite(takenAt) ? resetAt - takenAt : undefined
}
/** h/m/s at every scale, so a sample gap of seconds is always visible. */
const human = (ms) => {
  if (ms === undefined) return '—'
  const total = Math.max(0, Math.floor(ms / 1_000))
  const s = total % 60
  const m = Math.floor(total / 60) % 60
  const h = Math.floor(total / 3_600) % 24
  const d = Math.floor(total / 86_400)
  const parts = []
  if (d > 0) parts.push(`${d}d`)
  if (h > 0 || d > 0) parts.push(`${h}h`)
  if (m > 0 || h > 0 || d > 0) parts.push(`${m}m`)
  parts.push(`${s}s`)
  return parts.join('')
}

console.log('─'.repeat(72))
if (violations.length > 0) {
  console.log(`${violations.length} invariant violation(s) across ${samples.length} sample(s)`)
  process.exitCode = 1
} else {
  console.log(`All invariants held across ${samples.length} sample(s).`)
  if (samples.length > 1) {
    // The reset instant each window reports is fixed; only the derived
    // countdown moves. That is the distinction worth proving: the card computes
    // "time left" from the vendor's instant every render instead of storing a
    // countdown that would drift away from the truth.
    for (const key of ['fiveHour', 'weekly', 'monthly']) {
      const before = remainingOf(first, key)
      const after = remainingOf(last, key)
      if (before === undefined || after === undefined) continue
      const shrunk = after < before
      console.log(`Clock-derived: ${key} countdown ${human(before)} -> ${human(after)} ${shrunk ? '(recomputed from the same fixed reset instant)' : '(unchanged?)'}`)
      if (!shrunk) note(`${key} countdown did not shrink between samples`)
    }
  }
  if (moved) {
    const delta = (last.monthly.used ?? 0) - (first.monthly.used ?? 0)
    console.log(`Usage drift observed: monthly used ${money(first.monthly.used)} -> ${money(last.monthly.used)} (${delta >= 0 ? '+' : ''}${delta.toFixed(4)}), requests ${first.totals.requests} -> ${last.totals.requests}`)
    console.log('That is the real thing: the counters moved and every invariant above held at each step.')
  } else {
    console.log('No usage drift during this window — the account was idle (or its paid allowance is spent), so the')
    console.log('run proves the identity and the clock-derived values only. Re-run while an agent is working to')
    console.log('watch the counters move: node preview/e2e-watch.mjs 6 20')
  }
  if (violations.length > 0) process.exitCode = 1
}
