/**
 * Offline contract test for `plugin/index.js` (the host half).
 *
 * Boots the plugin against a fake host context and a stubbed `fetch`, then
 * drives the exact Fetch route the browser half posts to: the report path, the
 * cache, a mismatched method, the HTTP guards, and upstream/credential
 * failures.
 *
 * Run: node test-host.mjs
 */

import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const { credentialFingerprint } = await import(`../quota.mjs?t=${String(Date.now())}`)

// Isolate credential discovery from the machine running the test. Pointing both
// home anchors at an empty directory means no settings.yaml and no credential
// store are reachable, so each case can only be satisfied by the environment
// variable it sets — never by the developer's real Command Code key.
const ISOLATED_HOME = mkdtempSync(path.join(os.tmpdir(), 'cc-quota-host-'))
process.env.DSH_HOME = ISOLATED_HOME
process.env.USERPROFILE = ISOLATED_HOME

let passed = 0
const check = (label, fn) => {
  fn()
  passed += 1
  console.log(`  ok  ${label}`)
}

/**
 * The billing period is relative for the same reason the reset instants below
 * are: a pinned date turns a countdown assertion into a time bomb that goes off
 * the day the fixture expires.
 */
const PERIOD_START = new Date(Date.now() - 25 * 86_400_000).toISOString()
const PERIOD_END = new Date(Date.now() + 6.5 * 86_400_000).toISOString()

/** Canned upstream payloads, keyed by endpoint path. */
const UPSTREAM = {
  '/alpha/whoami': { success: true, user: { id: 'u-1', name: 'Jovan', userName: 'Jovan1666' }, org: null },
  '/alpha/usage/summary': { totalCount: 17_641, totalCost: 67.68, successRate: 100, totalCredits: 67.68, periodBasis: 'billing-period' },
  '/alpha/billing/credits': {
    credits: { monthlyCredits: 2.4, purchasedCredits: 0, freeCredits: 0, belowThreshold: false },
    windowLimits: {
      fiveHour: { used: 2.18, cap: 14, exceeded: false, resetAt: Date.now() + 3.4 * 3_600_000 },
      weekly: { used: 2.31, cap: 35, exceeded: false, resetAt: Date.now() + 4.4 * 86_400_000 },
    },
  },
  '/alpha/billing/subscriptions': {
    success: true,
    data: { planId: 'individual-goat', status: 'active', currentPeriodStart: PERIOD_START, currentPeriodEnd: PERIOD_END },
  },
}

/** Install a `fetch` answering the four endpoints, and count its calls. */
function stubFetch() {
  const calls = []
  globalThis.fetch = (url) => {
    calls.push(url)
    const body = UPSTREAM[new URL(url).pathname]
    if (body === undefined) return Promise.resolve(new Response('not found', { status: 404 }))
    return Promise.resolve(Response.json(body))
  }
  return calls
}

/**
 * Import the host half as a distinct module instance, so the plugin's
 * module-level cache never leaks between checks.
 * @returns the plugin module namespace.
 */
function loadHostHalf() {
  process.env.COMMANDCODE_API_KEY = 'demo-test-key'
  return import(`../index.js?t=${String(Date.now())}-${String(Math.random())}`)
}

/**
 * Point this process at a fresh DSH home and return it.
 *
 * Blocks share one process, so anything a block persists — the last-report
 * snapshot in particular — would otherwise leak into the next block and change
 * which code path it exercises. Each block that reads the route for its own
 * reasons gets its own home.
 *
 * @returns the isolated home directory.
 */
function isolatedHome() {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'cc-quota-home-'))
  process.env.DSH_HOME = dir
  process.env.USERPROFILE = dir
  return dir
}

/** The path the plugin registers; also the URL the browser posts to. */
const ROUTE_URL = 'http://dsh.internal/api/cc-quota/report'

/**
 * A fake host context that captures the exact Fetch route registration and,
 * when a command runtime is composed, the `/quota` definition.
 * @param options.withCommands - false simulates a profile without a command runtime.
 */
function makeCtx({ withCommands = true } = {}) {
  const seen = { effects: [] }
  const ctx = {
    connection: {
      fetch: {
        register: (route) => {
          seen.route = route
        },
      },
    },
    logger: { info: () => {} },
    // Effects run inline, like the client test does; their disposers are kept
    // so a check can assert the command unregisters with the plugin.
    effect: (callback) => {
      const dispose = callback()
      if (typeof dispose === 'function') seen.effects.push(dispose)
    },
  }
  if (withCommands) {
    ctx.get = (serviceName) => (serviceName === 'commands' ? {
      register: (definition) => {
        seen.command = definition
        return () => {}
      },
    } : undefined)
  } else {
    // A profile may compose no command runtime at all: the reflection layer is
    // always there, but the name resolves to nothing.
    ctx.get = () => undefined
  }
  return { ctx, seen }
}

/**
 * Drive the captured route the way the Connection bridge does: POST one JSON
 * client-request envelope and read the server-response envelope back.
 * @param route - the captured route registration.
 * @param method - the endpoint the caller claims.
 * @param payload - the request payload.
 * @returns the RPC result the browser caller would receive.
 */
async function callRoute(route, method, payload) {
  const response = await route.fetch(new Request(ROUTE_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ type: 'client-request', rpcId: 'r-probe', method, payload }),
  }))
  assert.equal(response.status, 200)
  const full = await response.json()
  assert.equal(full.type, 'server-response')
  assert.equal(full.rpcId, 'r-probe')
  return full.result
}

console.log('host half contract')
{
  const plugin = await loadHostHalf()
  check('exports a cordis function-plugin face', () => {
    assert.equal(plugin.name, 'commandcode-quota')
    assert.deepEqual(plugin.inject, ['connection'])
    assert.equal(typeof plugin.apply, 'function')
  })

  const calls = stubFetch()
  const { ctx, seen } = makeCtx()
  plugin.apply(ctx)

  check('registers one buffered POST route under the authenticated transport', () => {
    assert.equal(seen.route.path, '/api/cc-quota/report')
    assert.deepEqual(seen.route.methods, ['POST'])
    assert.equal(seen.route.requestBody, 'buffered')
  })

  const result = await callRoute(seen.route, 'cc-quota/report', {})
  check('report endpoint returns the normalized quota report', () => {
    assert.equal(result.ok, true)
    assert.equal(result.value.plan.name, 'GOAT')
    assert.equal(result.value.monthly.used, 67.68)
    assert.equal(result.value.monthly.remaining, 2.4)
    // used + remaining is a float sum; compare the derived capacity with tolerance.
    assert.ok(Math.abs(result.value.monthly.cap - 70.08) < 1e-9, `cap was ${String(result.value.monthly.cap)}`)
    assert.equal(result.value.fiveHour.cap, 14)
    assert.equal(result.value.weekly.used, 2.31)
    assert.deepEqual(result.value.failures, [])
    assert.equal(calls.length, 4, 'four upstream requests on a cold cache')
  })

  check('a repeat inside the cache window does not re-request upstream', async () => {
    const again = await callRoute(seen.route, 'cc-quota/report', {})
    assert.equal(again.ok, true)
    assert.equal(calls.length, 4)
  })

  const unknown = await callRoute(seen.route, 'nope', {})
  check('a mismatched method is a bad-request RPC error', () => {
    assert.equal(unknown.ok, false)
    // Must be a code the transport's discriminated-union error schema accepts,
    // or the browser's response validation fails before it can read the error.
    assert.equal(unknown.error.code, 'bad-request')
    assert.match(unknown.error.message, /does not match endpoint/)
    assert.deepEqual(unknown.error.details.issues, [])
  })

  const wrongType = await seen.route.fetch(new Request(ROUTE_URL, {
    method: 'POST',
    headers: { 'content-type': 'text/plain' },
    body: '{}',
  }))
  check('a non-JSON content type is refused before the envelope', () => {
    assert.equal(wrongType.status, 415)
  })

  const badJson = await seen.route.fetch(new Request(ROUTE_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: 'not json',
  }))
  check('a body that is not JSON is refused', () => {
    assert.equal(badJson.status, 400)
  })
}

console.log('/quota slash command')
{
  isolatedHome()
  const plugin = await loadHostHalf()
  stubFetch()
  const { ctx, seen } = makeCtx()
  plugin.apply(ctx)

  check('registers an optional /quota command when a command runtime exists', () => {
    assert.equal(seen.command.name, 'quota')
    assert.match(seen.command.description, /Command Code/)
    assert.equal(typeof seen.command.handler, 'function')
  })

  const outcome = await seen.command.handler({ rawInput: '' })
  check('the command answers from the same cached report the card reads', async () => {
    assert.equal(outcome.kind, 'success')
    assert.match(outcome.text, /^Command Code · GOAT \(active\)\n/)
    // Money is printed for the monthly allowance only, matching the card.
    assert.match(outcome.text, /Monthly 96\.6% used · \$67\.68 \/ \$70\.08 · \$2\.40 left · resets in \d+d\d+h/)
    assert.match(outcome.text, /5-hour 15\.6% used · resets in /)
    assert.match(outcome.text, /Weekly 6\.6% used · resets in /)
    assert.equal(outcome.text.includes('$2.18'), false, 'rolling windows carry no money')
    assert.equal(outcome.text.includes('$2.31'), false, 'rolling windows carry no money')
    assert.match(outcome.text, /17,641 requests · 100% success · in .+ \/ out .+/)
  })

  const dispose = seen.effects.at(-1)
  check('the command registration disposes with the plugin', () => {
    assert.equal(typeof dispose, 'function')
  })
}

console.log('/quota on a profile without a command runtime')
{
  isolatedHome()
  const plugin = await loadHostHalf()
  stubFetch()
  const { ctx, seen } = makeCtx({ withCommands: false })
  plugin.apply(ctx)

  check('the card route still registers and nothing throws', () => {
    assert.equal(seen.route.path, '/api/cc-quota/report')
    assert.equal(seen.command, undefined)
  })
}

console.log('/quota when no Command Code provider is configured')
{
  isolatedHome()
  const plugin = await loadHostHalf()
  delete process.env.COMMANDCODE_API_KEY
  delete process.env.COMMAND_CODE_API_KEY
  delete process.env.CMD_API_KEY
  const { ctx, seen } = makeCtx()
  plugin.apply(ctx)

  const outcome = await seen.command.handler({ rawInput: '' })
  check('absence is a readable error, not a crash or an empty card', () => {
    assert.equal(outcome.kind, 'error')
    assert.match(outcome.text, /No Command Code provider is configured/)
  })
}

console.log('freshness while the account keeps burning credit')
{
  isolatedHome()
  const plugin = await loadHostHalf()
  const calls = []
  const state = { used: 67.68, requests: 17_641 }
  globalThis.fetch = (url) => {
    calls.push(url)
    const pathname = new URL(url).pathname
    if (pathname === '/alpha/usage/summary') {
      return Promise.resolve(Response.json({
        ...UPSTREAM[pathname],
        totalCredits: state.used,
        totalCount: state.requests,
      }))
    }
    return Promise.resolve(Response.json(UPSTREAM[pathname]))
  }

  // Time travel: the route caches for 15s, so a test that wants to observe a
  // refresh has to move the clock rather than sleep.
  const realNow = Date.now
  let clock = realNow()
  Date.now = () => clock
  try {
    const { ctx, seen } = makeCtx()
    plugin.apply(ctx)

    const first = await callRoute(seen.route, 'cc-quota/report', {})
    assert.equal(first.value.monthly.used, 67.68)
    assert.equal(calls.length, 4)
    check('the first read comes from upstream', () => {})

    state.used = 68.4
    state.requests = 17_700
    clock += 5_000
    const cached = await callRoute(seen.route, 'cc-quota/report', {})
    check('inside the cache window the report is served unchanged, without new upstream calls', () => {
      assert.equal(cached.value.monthly.used, 67.68, 'the cached value, not the drifted one')
      assert.equal(calls.length, 4, 'no upstream request was made')
    })

    clock += 11_000
    const refreshed = await callRoute(seen.route, 'cc-quota/report', {})
    check('past the cache window the drifted numbers come through', () => {
      assert.equal(refreshed.value.monthly.used, 68.4)
      assert.equal(refreshed.value.totals.requests, 17_700)
      assert.equal(calls.length, 8, 'one fresh read costs four upstream requests')
      // The identity must hold on the refresh too: a drifted `used` with a
      // stale `remaining` would silently move the percentage's denominator.
      assert.ok(Math.abs(refreshed.value.monthly.used + refreshed.value.monthly.remaining - refreshed.value.monthly.cap) < 1e-9)
    })
  } finally {
    Date.now = realNow
  }
}

console.log('concurrent readers')
{
  isolatedHome()
  // Two callers wanting a report at the same instant — the card polling and a
  // /quota invocation, say. They must share one snapshot: a slow first read
  // finishing after a fast second one would otherwise cache the older numbers
  // and serve them for the next 15 seconds.
  const plugin = await loadHostHalf()
  const calls = []
  let releaseSlow
  const slowGate = new Promise((resolve) => { releaseSlow = resolve })
  globalThis.fetch = async (url) => {
    calls.push(url)
    const pathname = new URL(url).pathname
    // The first report's usage endpoint dawdles; everything after it is instant.
    if (pathname === '/alpha/usage/summary' && calls.length <= 4) await slowGate
    return Response.json(UPSTREAM[pathname])
  }
  const { ctx, seen } = makeCtx()
  plugin.apply(ctx)

  const both = Promise.all([
    callRoute(seen.route, 'cc-quota/report', {}),
    callRoute(seen.route, 'cc-quota/report', {}),
  ])
  await new Promise((resolve) => { setTimeout(resolve, 10) })
  releaseSlow()
  const [first, second] = await both

  check('two simultaneous readers share one upstream read', () => {
    assert.equal(calls.length, 4, 'four upstream requests total, not eight')
    assert.deepEqual(first, second, 'and they receive the identical snapshot')
  })

  check('the shared snapshot is the one that got cached', async () => {
    const after = await callRoute(seen.route, 'cc-quota/report', {})
    assert.equal(after.value.monthly.used, 67.68)
    assert.equal(calls.length, 4, 'still no further upstream work inside the cache window')
  })
}

console.log('cold start with a snapshot on disk')
{
  const home = isolatedHome()
  // The case that made the card feel slow: a restarted dsh has no cache, and the
  // panel's first paint otherwise waits out a full upstream round trip.
  const snapshotFile = path.join(home, 'dsh-commandcode-quota', 'last-report.json')
  const previous = {
    fetchedAt: new Date(Date.now() - 45_000).toISOString(),
    apiBase: 'https://api.commandcode.ai',
    credentialSource: 'test',
    plan: {
      planId: 'individual-goat',
      name: 'GOAT',
      status: 'active',
      currentPeriodStart: PERIOD_START,
      currentPeriodEnd: PERIOD_END,
    },
    monthly: { used: 66.1, remaining: 4.1, cap: 70.2, percent: 94.2, capSuspect: false },
    fiveHour: { used: 1, cap: 14, percent: 7.1, exceeded: false, resetAt: Date.now() + 3_600_000 },
    weekly: { used: 2, cap: 35, percent: 5.7, exceeded: false, resetAt: Date.now() + 86_400_000 },
    totals: { requests: 17_000, successRate: 100 },
    failures: [],
  }
  const plugin = await loadHostHalf()
  // The snapshot is keyed to the credential it was taken with, so the test has
  // to write it the way the host does: with the fingerprint of the key in play.
  const writeSnapshot = (report) => {
    mkdirSync(path.dirname(snapshotFile), { recursive: true })
    writeFileSync(snapshotFile, JSON.stringify({
      version: 1,
      fingerprint: credentialFingerprint(),
      report,
    }), 'utf8')
  }
  writeSnapshot(previous)

  const calls = stubFetch()
  const { ctx, seen } = makeCtx()
  plugin.apply(ctx)

  const started = Date.now()
  const first = await callRoute(seen.route, 'cc-quota/report', {})
  const elapsed = Date.now() - started
  check('the first answer is the snapshot, without waiting for upstream', () => {
    assert.equal(first.ok, true)
    assert.equal(first.value.stale, true, 'marked as a snapshot rather than a live read')
    assert.ok(first.value.staleAgeMs >= 44_000 && first.value.staleAgeMs < 120_000, `age was ${first.value.staleAgeMs}`)
    assert.equal(first.value.monthly.used, 66.1, 'and it carries the snapshot numbers')
    assert.ok(elapsed < 250, `answered in ${elapsed}ms — the whole point is not waiting`)
  })

  await new Promise((resolve) => { setTimeout(resolve, 30) })
  const second = await callRoute(seen.route, 'cc-quota/report', {})
  check('a live read was already running behind it, and lands next', () => {
    assert.equal(second.value.stale, undefined, 'a live answer carries no stale marker')
    assert.equal(second.value.monthly.used, 67.68, 'the honest, current number')
    assert.equal(calls.length, 4, 'the snapshot answered without spending an upstream request of its own')
  })

  check('the fresh report is what gets persisted for the next cold start', () => {
    const persisted = JSON.parse(readFileSync(snapshotFile, 'utf8'))
    assert.equal(persisted.version, 1)
    assert.equal(persisted.report.monthly.used, 67.68)
    assert.ok(Date.parse(persisted.report.fetchedAt) > Date.parse(previous.fetchedAt))
  })

  const commandOutcome = await seen.command.handler({ rawInput: '' })
  check('the /quota command never answers from a snapshot', () => {
    // Somebody who typed a command wants the current answer, not a labelled
    // guess: the command path takes the blocking read.
    assert.match(commandOutcome.text, /\$67\.68/, 'the live figure')
    assert.doesNotMatch(commandOutcome.text, /\$66\.10/)
  })
}

console.log('a snapshot too old to stand in for the present')
{
  const home = isolatedHome()
  isolatedHome()
  const snapshotFile = path.join(home, 'dsh-commandcode-quota', 'last-report.json')
  const ancient = {
    fetchedAt: new Date(Date.now() - 7 * 3_600_000).toISOString(),
    plan: { planId: 'individual-goat', name: 'GOAT', status: 'active', currentPeriodEnd: PERIOD_END },
    monthly: { used: 10, remaining: 60, cap: 70, percent: 14.3 },
    fiveHour: { used: 0.5, cap: 14, percent: 3.6, exceeded: false, resetAt: Date.now() + 3_600_000 },
    weekly: { used: 1, cap: 35, percent: 2.9, exceeded: false, resetAt: Date.now() + 86_400_000 },
    totals: { requests: 100, successRate: 100 },
    failures: [],
  }
  const plugin = await loadHostHalf()
  mkdirSync(path.dirname(snapshotFile), { recursive: true })
  writeFileSync(snapshotFile, JSON.stringify({
    version: 1,
    fingerprint: credentialFingerprint(),
    report: ancient,
  }), 'utf8')
  stubFetch()
  const { ctx, seen } = makeCtx()
  plugin.apply(ctx)

  const result = await callRoute(seen.route, 'cc-quota/report', {})
  check('a seven-hour-old snapshot is discarded, and a real read happens instead', () => {
    assert.equal(result.value.stale, undefined)
    assert.equal(result.value.monthly.used, 67.68)
  })
}

console.log('a snapshot that outlives its configuration')
{
  // The snapshot exists to make the card appear instantly, not to outlive the
  // setup it belongs to. Somebody who just removed their Command Code provider
  // must get "not applicable here" — and so no card — rather than a reading from
  // an account they no longer have wired up.
  const home = isolatedHome()
  const snapshotFile = path.join(home, 'dsh-commandcode-quota', 'last-report.json')
  mkdirSync(path.dirname(snapshotFile), { recursive: true })
  writeFileSync(snapshotFile, JSON.stringify({
    fetchedAt: new Date().toISOString(),
    plan: { planId: 'individual-goat', name: 'GOAT', status: 'active', currentPeriodEnd: PERIOD_END },
    monthly: { used: 68, remaining: 2, cap: 70, percent: 97.1 },
    totals: { requests: 1, successRate: 100 },
    failures: [],
  }), 'utf8')

  const plugin = await loadHostHalf()
  delete process.env.COMMANDCODE_API_KEY
  delete process.env.COMMAND_CODE_API_KEY
  delete process.env.CMD_API_KEY
  stubFetch()
  const { ctx, seen } = makeCtx()
  plugin.apply(ctx)

  const result = await callRoute(seen.route, 'cc-quota/report', {})
  check('the absence marker wins over a snapshot from a removed provider', () => {
    assert.equal(result.ok, true)
    assert.equal(result.value.configured, false, 'no card for a host that no longer uses Command Code')
    assert.equal(result.value.stale, undefined)
    assert.equal(result.value.monthly, undefined)
  })
}

console.log('a snapshot belonging to a different account')
{
  // The same `refs.NAME` can hold a different key tomorrow: switch plans, paste a
  // new key, or run a second dsh against another account, and a snapshot taken
  // with the old key would describe an account this machine no longer uses.
  const home = isolatedHome()
  const snapshotFile = path.join(home, 'dsh-commandcode-quota', 'last-report.json')
  mkdirSync(path.dirname(snapshotFile), { recursive: true })
  writeFileSync(snapshotFile, JSON.stringify({
    version: 1,
    // A fingerprint that cannot match the test key, standing in for "another key".
    fingerprint: 'ffffffffffffffff',
    report: {
      fetchedAt: new Date().toISOString(),
      plan: { planId: 'individual-max', name: 'Max', status: 'active', currentPeriodEnd: PERIOD_END },
      monthly: { used: 5, remaining: 145, cap: 150, percent: 3.3 },
      fiveHour: { used: 1, cap: 30, percent: 3.3, exceeded: false, resetAt: Date.now() + 3_600_000 },
      weekly: { used: 2, cap: 80, percent: 2.5, exceeded: false, resetAt: Date.now() + 86_400_000 },
      totals: { requests: 1, successRate: 100 },
      failures: [],
    },
  }), 'utf8')

  const plugin = await loadHostHalf()
  stubFetch()
  const { ctx, seen } = makeCtx()
  plugin.apply(ctx)

  const result = await callRoute(seen.route, 'cc-quota/report', {})
  check('another account’s snapshot is ignored, not shown', () => {
    assert.equal(result.value.stale, undefined, 'no snapshot answer')
    assert.equal(result.value.plan.name, 'GOAT', 'this account’s own live read')
    assert.equal(result.value.monthly.used, 67.68)
  })
}

console.log('the snapshot file carries its account fingerprint')
{
  const home = isolatedHome()
  const plugin = await loadHostHalf()
  stubFetch()
  const { ctx, seen } = makeCtx()
  plugin.apply(ctx)

  await callRoute(seen.route, 'cc-quota/report', {})
  const written = JSON.parse(readFileSync(path.join(home, 'dsh-commandcode-quota', 'last-report.json'), 'utf8'))
  check('what lands on disk is versioned and fingerprinted, never the bare key', () => {
    assert.equal(written.version, 1)
    assert.equal(typeof written.fingerprint, 'string')
    assert.equal(written.fingerprint.length, 16)
    assert.equal(written.report.monthly.used, 67.68)
    assert.equal(JSON.stringify(written).includes('demo-test-key'), false, 'the key itself is never written')
  })
}

console.log('upstream failure')
{
  isolatedHome()
  const plugin = await loadHostHalf()
  globalThis.fetch = () => Promise.reject(new Error('ECONNREFUSED'))
  const { ctx, seen } = makeCtx()
  plugin.apply(ctx)

  const result = await callRoute(seen.route, 'cc-quota/report', {})
  check('a transport failure becomes an internal RPC error, not a throw', () => {
    assert.equal(result.ok, false)
    assert.equal(result.error.code, 'internal')
    assert.deepEqual(result.error.details, {})
    assert.match(result.error.message, /\[NETWORK\]/)
  })
}

console.log('no Command Code on this host')
{
  isolatedHome()
  const plugin = await loadHostHalf()
  delete process.env.COMMANDCODE_API_KEY
  delete process.env.COMMAND_CODE_API_KEY
  delete process.env.CMD_API_KEY
  const { ctx, seen } = makeCtx()
  plugin.apply(ctx)

  const result = await callRoute(seen.route, 'cc-quota/report', {})
  check('absence travels as a success marker, not an error', () => {
    // An invented error code would fail the transport's union schema in the
    // browser and surface as a transport failure — the opposite of hiding.
    assert.equal(result.ok, true)
    assert.equal(result.value.configured, false)
    assert.equal(result.value.reason, 'no-commandcode-provider')
  })
}

console.log('Command Code configured but the key resolves to nothing')
{
  const home = isolatedHome()
  // A discovered route makes the plugin applicable, so the failure must show.
  const settingsPath = path.join(home, 'settings.yaml')
  writeFileSync(
    settingsPath,
    'llm-pi-ai:\n  providers:\n    cc:\n      apiKeyEnv: NOT_SET_ANYWHERE\n      baseURL: https://api.commandcode.ai/provider/v1\n',
    'utf8',
  )
  const plugin = await loadHostHalf()
  // loadHostHalf seeds an env key; this case needs the route to be the *only*
  // thing pointing at Command Code, so the reference resolves to nothing.
  delete process.env.COMMANDCODE_API_KEY
  delete process.env.COMMAND_CODE_API_KEY
  delete process.env.CMD_API_KEY
  const { ctx, seen } = makeCtx()
  plugin.apply(ctx)

  const result = await callRoute(seen.route, 'cc-quota/report', {})
  check('a discovered route with an unresolvable key surfaces MISSING_CREDENTIAL', () => {
    assert.equal(result.ok, false)
    assert.match(result.error.message, /\[MISSING_CREDENTIAL\]/)
  })
  // The home is a throwaway directory; no cleanup needed.
}

console.log('the route and the snapshot are owned by the plugin')
{
  const home = isolatedHome()
  stubFetch()
  const plugin = await loadHostHalf()
  const { ctx, seen } = makeCtx()
  let disposed = 0
  // The real registry hands back a disposer. A registration no effect owns
  // outlives the plugin and collides with the next one on reload.
  ctx.connection.fetch.register = (route) => {
    seen.route = route
    return () => { disposed += 1 }
  }
  plugin.apply(ctx)
  check('registering the Fetch route through an effect', () => {
    // Two effects own this plugin's registrations: the route and the /quota
    // command. Neither may outlive the fiber it was mounted on.
    assert.equal(seen.effects.length, 2, `effects collected: ${seen.effects.length}`)
    seen.effects.forEach((dispose) => dispose())
    assert.equal(disposed, 1)
  })

  await callRoute(seen.route, 'cc-quota/report', {})
  const snapshotFile = path.join(home, 'dsh-commandcode-quota', 'last-report.json')
  check('writing the snapshot in one piece, for its owner only', () => {
    const dir = path.dirname(snapshotFile)
    assert.deepEqual(
      readdirSync(dir).filter((name) => name !== 'last-report.json'),
      [],
      'a temp file survived the write, so a reader could have caught it half-written',
    )
    // NTFS reports a mode Windows never set, so the permission assertion binds
    // only where the mode means something.
    if (process.platform !== 'win32') {
      assert.equal(statSync(snapshotFile).mode & 0o077, 0, 'the snapshot is readable beyond its owner')
      assert.equal(statSync(dir).mode & 0o077, 0, 'the snapshot directory is reachable beyond its owner')
    }
  })
}

console.log(`\n${passed} checks passed`)
