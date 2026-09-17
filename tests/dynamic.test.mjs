/**
 * Dynamic-data tests for the quota data layer.
 *
 * The offline suites next door prove the *shape* of a report. This one proves
 * the numbers stay correct while the numbers themselves move: credit burning
 * down, windows resetting, caps drifting, endpoints failing one at a time, and
 * upstream payloads that change shape mid-flight.
 *
 * Everything here runs against an injected `fetch`, so a sample sequence is
 * exact and the suite never touches the network or a real account.
 *
 * Run: node tests/dynamic.test.mjs
 */

import assert from 'node:assert/strict'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const { fetchQuotaReport } = await import(`../quota.mjs?t=${String(Date.now())}`)

let passed = 0
const check = (label, fn) => {
  fn()
  passed += 1
  console.log(`  ok  ${label}`)
}
const checkAsync = async (label, fn) => {
  await fn()
  passed += 1
  console.log(`  ok  ${label}`)
}

const HOUR = 3_600_000
const PERIOD_START = '2026-08-25T09:08:33.000Z'
const PERIOD_END = '2026-09-25T09:08:33.000Z'

/**
 * One account state. Only the fields a case cares about need to be set; the
 * rest fall back to a healthy GOAT mid-cycle account.
 */
function sample(overrides = {}) {
  return {
    used: 40,
    remaining: 30,
    planId: 'individual-goat',
    periodStart: PERIOD_START,
    periodEnd: PERIOD_END,
    status: 'active',
    belowThreshold: false,
    freeCredits: 0,
    purchasedCredits: 0,
    requests: 10_000,
    successRate: 100,
    tokensIn: 1_000_000_000,
    tokensOut: 10_000_000,
    fiveHour: { used: 1, cap: 14, exceeded: false, resetAt: Date.now() + 2 * HOUR },
    weekly: { used: 3, cap: 35, exceeded: false, resetAt: Date.now() + 3 * 86_400_000 },
    degraded: [],
    ...overrides,
  }
}

/**
 * Serve one payload per *report*, not per request: every report costs four
 * requests, and the four must agree on which instant they belong to.
 *
 * @param samples successive account states; the last one repeats forever.
 * @returns `{ fetchImpl, calls }` where `calls` counts upstream requests.
 */
function sampler(samples) {
  const calls = []
  let index = 0
  let seenWhoami = false
  const fetchImpl = (url) => {
    const pathname = new URL(url).pathname
    calls.push(pathname)
    if (pathname === '/alpha/whoami') {
      if (seenWhoami) index = Math.min(index + 1, samples.length - 1)
      seenWhoami = true
    }
    const state = samples[Math.min(index, samples.length - 1)]
    if (state.degraded.includes(pathname)) return Promise.resolve(new Response('nope', { status: 500 }))

    switch (pathname) {
      case '/alpha/whoami':
        return Promise.resolve(Response.json({ user: { id: 'u-1', name: 'Jovan', userName: 'Jovan1666' }, org: null }))
      case '/alpha/usage/summary':
        return Promise.resolve(Response.json({
          totalCount: state.requests,
          successRate: state.successRate,
          totalCredits: state.used,
          totalTokensIn: state.tokensIn,
          totalTokensOut: state.tokensOut,
          periodBasis: 'billing-period',
        }))
      case '/alpha/billing/credits':
        return Promise.resolve(Response.json({
          credits: {
            monthlyCredits: state.remaining,
            purchasedCredits: state.purchasedCredits,
            freeCredits: state.freeCredits,
            belowThreshold: state.belowThreshold,
          },
          windowLimits: {
            ...(state.fiveHour === undefined ? {} : { fiveHour: state.fiveHour }),
            ...(state.weekly === undefined ? {} : { weekly: state.weekly }),
          },
        }))
      case '/alpha/billing/subscriptions':
        return Promise.resolve(Response.json({
          data: {
            planId: state.planId,
            status: state.status,
            currentPeriodStart: state.periodStart,
            currentPeriodEnd: state.periodEnd,
          },
        }))
      default:
        return Promise.resolve(new Response('missing', { status: 404 }))
    }
  }
  return { fetchImpl, calls }
}

/** Pull one report from a state sequence. */
function report(samples, index = 0) {
  const { fetchImpl } = sampler(Array.isArray(samples) ? samples : [samples])
  return fetchQuotaReport({ apiKey: 'test-key', fetchImpl, apiBase: 'https://api.commandcode.ai' })
}

/** Every finite number in a report, with its dotted path, for NaN sweeps. */
function numbersIn(value, prefix = '') {
  const found = []
  if (typeof value === 'number') {
    found.push([prefix, value])
  } else if (value !== null && typeof value === 'object') {
    for (const [key, child] of Object.entries(value)) {
      found.push(...numbersIn(child, prefix === '' ? key : `${prefix}.${key}`))
    }
  }
  return found
}

/** Deterministic PRNG so a failure can be re-run and land on the same sample. */
function mulberry32(seed) {
  return () => {
    seed = (seed + 0x6D2B79F5) | 0
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296
  }
}

console.log('credit burning down within one period')
{
  await checkAsync('percent rises and remaining falls as credits burn', async () => {
    const states = [
      sample({ used: 10, remaining: 60 }),
      sample({ used: 35.5, remaining: 34.5 }),
      sample({ used: 69.9, remaining: 0.1 }),
    ]
    const { fetchImpl } = sampler(states)
    const seen = []
    for (let i = 0; i < states.length; i += 1) {
      seen.push(await fetchQuotaReport({ apiKey: 'k', fetchImpl, apiBase: 'https://api.commandcode.ai' }))
    }
    const percents = seen.map((r) => r.monthly.percent)
    const remainings = seen.map((r) => r.monthly.remaining)
    for (let i = 1; i < percents.length; i += 1) {
      assert.ok(percents[i] > percents[i - 1], `percent must climb: ${percents.join(' -> ')}`)
      assert.ok(remainings[i] < remainings[i - 1], `remaining must shrink: ${remainings.join(' -> ')}`)
    }
    assert.deepEqual(percents.map((p) => Number(p.toFixed(4))), [14.2857, 50.7143, 99.8571])
  })

  await checkAsync('cap stays put while used and remaining move against each other', async () => {
    const { fetchImpl } = sampler([
      sample({ used: 5, remaining: 65 }),
      sample({ used: 40.25, remaining: 29.75 }),
      sample({ used: 61.8, remaining: 8.2 }),
    ])
    const caps = []
    for (let i = 0; i < 3; i += 1) {
      caps.push((await fetchQuotaReport({ apiKey: 'k', fetchImpl, apiBase: 'https://api.commandcode.ai' })).monthly.cap)
    }
    // The cap is derived as used + remaining, so a drifting pair must still land
    // on one number; a drifting cap would mean the two endpoints disagree and
    // the percentage is being computed against the wrong denominator.
    for (const cap of caps) assert.ok(Math.abs(cap - 70) < 1e-9, `cap drifted to ${cap}`)
  })

  await checkAsync('used + remaining = cap holds on every sample of a long drift', async () => {
    const random = mulberry32(20_260_917)
    const states = []
    let used = 0
    for (let i = 0; i < 60; i += 1) {
      used += random() * 1.2
      states.push(sample({ used, remaining: 70 - used }))
    }
    const { fetchImpl } = sampler(states)
    for (let i = 0; i < states.length; i += 1) {
      const r = await fetchQuotaReport({ apiKey: 'k', fetchImpl, apiBase: 'https://api.commandcode.ai' })
      const { used: u, remaining: rem, cap, percent } = r.monthly
      assert.ok(Math.abs(u + rem - cap) < 1e-9, `identity broke at sample ${i}: ${u} + ${rem} != ${cap}`)
      assert.ok(Math.abs(percent - (u / cap) * 100) < 1e-9, `percent not recomputed at sample ${i}`)
      assert.ok(percent > 0 && percent <= 100)
    }
  })

  await checkAsync('no numeric field is ever NaN or infinite across 60 drifting samples', async () => {
    const random = mulberry32(7)
    const states = Array.from({ length: 60 }, (_, i) => sample({
      used: random() * 70,
      remaining: random() * 70,
      requests: 10_000 + i,
      tokensIn: random() * 4e9,
      tokensOut: random() * 2e7,
    }))
    const { fetchImpl } = sampler(states)
    for (let i = 0; i < states.length; i += 1) {
      const r = await fetchQuotaReport({ apiKey: 'k', fetchImpl, apiBase: 'https://api.commandcode.ai' })
      for (const [name, value] of numbersIn(r)) {
        assert.ok(Number.isFinite(value), `${name} was ${value} at sample ${i}`)
      }
    }
  })
}

console.log('windows rolling over')
{
  await checkAsync('a reset window reports its new, small usage rather than the old one', async () => {
    const before = sample({ fiveHour: { used: 13.9, cap: 14, exceeded: false, resetAt: Date.now() - 60_000 } })
    const after = sample({ fiveHour: { used: 0.2, cap: 14, exceeded: false, resetAt: Date.now() + 5 * HOUR } })
    const { fetchImpl } = sampler([before, after])
    const first = await fetchQuotaReport({ apiKey: 'k', fetchImpl, apiBase: 'https://api.commandcode.ai' })
    const second = await fetchQuotaReport({ apiKey: 'k', fetchImpl, apiBase: 'https://api.commandcode.ai' })
    assert.ok(first.fiveHour.percent > 99)
    assert.ok(second.fiveHour.percent < 5, `after the reset the window must read low, got ${second.fiveHour.percent}`)
    assert.ok(second.fiveHour.resetAt > Date.now(), 'the new window resets in the future')
  })

  await checkAsync('an elapsed reset instant is reported as-is, never as a negative countdown', async () => {
    const stale = sample({ fiveHour: { used: 14, cap: 14, exceeded: true, resetAt: Date.now() - 3 * HOUR } })
    const r = await report(stale)
    assert.equal(r.fiveHour.exceeded, true)
    assert.ok(r.fiveHour.resetAt < Date.now(), 'the data layer reports the instant it was given')
    assert.equal(r.fiveHour.percent, 100, 'a spent window reads exactly 100%, not more')
  })

  await checkAsync('a plan that stops reporting windows yields no windows, not stale ones', async () => {
    const rolling = sample()
    const payAsYouGo = sample({
      used: undefined,
      remaining: undefined,
      planId: 'individual-provider',
      fiveHour: undefined,
      weekly: undefined,
      purchasedCredits: 25.5,
    })
    const { fetchImpl } = sampler([rolling, payAsYouGo])
    const first = await fetchQuotaReport({ apiKey: 'k', fetchImpl, apiBase: 'https://api.commandcode.ai' })
    const second = await fetchQuotaReport({ apiKey: 'k', fetchImpl, apiBase: 'https://api.commandcode.ai' })
    assert.ok(first.fiveHour !== undefined && first.weekly !== undefined)
    assert.equal(second.fiveHour, undefined)
    assert.equal(second.weekly, undefined)
    assert.equal(second.monthly.percent, undefined)
    assert.equal(second.monthly.purchasedCredits, 25.5, 'the on-demand balance still comes through')
    assert.equal(second.plan.name, 'Provider')
  })

  await checkAsync('over-consumption clamps the percentage at 100 instead of exceeding it', async () => {
    const over = sample({ used: 71.5, remaining: 0, fiveHour: { used: 15.2, cap: 14, exceeded: true, resetAt: Date.now() + HOUR } })
    const r = await report(over)
    assert.equal(r.monthly.percent, 100)
    assert.equal(r.fiveHour.percent, 100)
    assert.equal(r.fiveHour.exceeded, true)
  })

  await checkAsync('a fully exhausted allowance reports 0 remaining and exactly 100%', async () => {
    const r = await report(sample({ used: 70, remaining: 0 }))
    assert.equal(r.monthly.remaining, 0)
    assert.equal(r.monthly.percent, 100)
    assert.equal(r.monthly.cap, 70)
  })

  await checkAsync('a new billing period resets the percentage even if the card is mid-poll', async () => {
    const endOfPeriod = sample({ used: 69.5, remaining: 0.5 })
    const newPeriod = sample({
      used: 0.4,
      remaining: 69.6,
      periodStart: '2026-09-25T09:08:33.000Z',
      periodEnd: '2026-10-25T09:08:33.000Z',
    })
    const { fetchImpl } = sampler([endOfPeriod, newPeriod])
    const first = await fetchQuotaReport({ apiKey: 'k', fetchImpl, apiBase: 'https://api.commandcode.ai' })
    const second = await fetchQuotaReport({ apiKey: 'k', fetchImpl, apiBase: 'https://api.commandcode.ai' })
    assert.ok(first.monthly.percent > 99)
    assert.ok(second.monthly.percent < 1, `new period must read low, got ${second.monthly.percent}`)
    assert.equal(second.plan.currentPeriodEnd, '2026-10-25T09:08:33.000Z')
  })
}

console.log('upstream payloads changing shape')
{
  await checkAsync('missing and unusable fields become undefined, never NaN', async () => {
    const broken = sample({
      used: 'sixty',           // wrong type
      remaining: null,         // null
      requests: Number.NaN,    // NaN
      tokensIn: -1,            // nonsensical but finite
      successRate: '100',      // string number
      fiveHour: { used: 'x', cap: null, resetAt: 'soon' },
    })
    const r = await report(broken)
    assert.equal(r.monthly.used, undefined)
    assert.equal(r.monthly.remaining, undefined)
    assert.equal(r.totals.requests, undefined)
    assert.equal(r.totals.successRate, undefined)
    // No usable numbers at all: the window counts as not reported rather than
    // as a window that is 0% used.
    assert.equal(r.fiveHour, undefined)
    for (const [name, value] of numbersIn(r)) {
      assert.ok(Number.isFinite(value), `${name} was ${value}`)
    }
  })

  await checkAsync('a window missing only its usage never fabricates 0% used', async () => {
    // The dangerous halfway case: a cap the vendor did report, a usage it did
    // not. Defaulting the missing side to zero would render a reassuring 0%
    // green bar for an account that may well be at its limit. (The rendering
    // half of this rule is asserted in tests/client.test.mjs.)
    const half = sample({ fiveHour: { used: null, cap: 14, exceeded: false, resetAt: Date.now() + HOUR } })
    const r = await report(half)
    assert.notEqual(r.fiveHour, undefined, 'the window itself is reported')
    assert.equal(r.fiveHour.used, undefined, 'usage stays unknown')
    assert.equal(r.fiveHour.cap, 14, 'the cap comes through')
    assert.equal(r.fiveHour.percent, undefined, 'and no percentage is invented')
  })

  await checkAsync('empty 200 bodies produce a structurally valid report', async () => {
    const empty = (url) => {
      const pathname = new URL(url).pathname
      return Promise.resolve(pathname === '/alpha/whoami' ? Response.json({}) : Response.json({}))
    }
    const r = await fetchQuotaReport({ apiKey: 'k', fetchImpl: empty, apiBase: 'https://api.commandcode.ai' })
    assert.equal(r.monthly.used, undefined)
    assert.equal(r.plan, undefined)
    assert.equal(r.fiveHour, undefined)
    assert.deepEqual(r.failures, [], 'empty bodies are not failures')
  })

  await checkAsync('a malformed period end does not throw and leaves the row without a reset', async () => {
    const r = await report(sample({ periodEnd: 'not-a-date' }))
    assert.equal(r.plan.currentPeriodEnd, 'not-a-date')
    assert.equal(r.monthly.percent > 0, true, 'the percentage still computes from the credits')
  })

  await checkAsync('one failing endpoint degrades only itself while the others move on', async () => {
    const healthy = sample({ used: 20, remaining: 50 })
    const creditsDown = sample({ used: 30, remaining: 40, degraded: ['/alpha/billing/credits'] })
    const { fetchImpl } = sampler([healthy, creditsDown])
    const first = await fetchQuotaReport({ apiKey: 'k', fetchImpl, apiBase: 'https://api.commandcode.ai' })
    const second = await fetchQuotaReport({ apiKey: 'k', fetchImpl, apiBase: 'https://api.commandcode.ai' })
    assert.deepEqual(first.failures, [])
    assert.equal(second.failures.length, 1)
    assert.match(second.failures[0], /\/alpha\/billing\/credits: HTTP 500/)
    assert.equal(second.monthly.used, 30, 'the usage endpoint still reports')
    assert.equal(second.monthly.remaining, undefined, 'the credits endpoint did not')
    // The rolling windows live on the failed endpoint, so they are gone rather
    // than carried over from the previous read.
    assert.equal(second.fiveHour, undefined)
  })

  await checkAsync('an endpoint recovering later restores the missing fields', async () => {
    const down = sample({ used: 31, remaining: 39, degraded: ['/alpha/billing/credits'] })
    const up = sample({ used: 32, remaining: 38 })
    const { fetchImpl } = sampler([down, up])
    const broken = await fetchQuotaReport({ apiKey: 'k', fetchImpl, apiBase: 'https://api.commandcode.ai' })
    const fixed = await fetchQuotaReport({ apiKey: 'k', fetchImpl, apiBase: 'https://api.commandcode.ai' })
    assert.equal(broken.monthly.remaining, undefined)
    assert.deepEqual(fixed.failures, [])
    assert.equal(fixed.monthly.remaining, 38)
    assert.equal(fixed.monthly.cap, 70)
  })

  await checkAsync('each report is a fresh read, never a carried-over one', async () => {
    const a = sample({ used: 10, remaining: 60, requests: 100 })
    const b = sample({ used: 11, remaining: 59, requests: 101 })
    const { fetchImpl, calls } = sampler([a, b])
    const first = await fetchQuotaReport({ apiKey: 'k', fetchImpl, apiBase: 'https://api.commandcode.ai' })
    const second = await fetchQuotaReport({ apiKey: 'k', fetchImpl, apiBase: 'https://api.commandcode.ai' })
    assert.equal(calls.length, 8, 'two reports cost eight upstream requests')
    assert.equal(first.totals.requests, 100)
    assert.equal(second.totals.requests, 101)
    assert.ok(Date.parse(second.fetchedAt) >= Date.parse(first.fetchedAt), 'fetchedAt never goes backwards')
  })
}

console.log('an account with nothing configured')
{
  await checkAsync('the absence marker is stable across repeated reads', async () => {
    for (let i = 0; i < 3; i += 1) {
      await assert.rejects(
        fetchQuotaReport({ env: {}, home: path.join(process.cwd(), 'no-such-home'), dshHome: path.join(process.cwd(), 'no-such-home') }),
        (error) => error.code === 'MISSING_CREDENTIAL' && error.configured === false,
      )
    }
  })
}

console.log(`\n${passed} checks passed`)
