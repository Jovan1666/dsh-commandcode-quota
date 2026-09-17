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
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))

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

/** Canned upstream payloads, keyed by endpoint path. */
const UPSTREAM = {
  '/alpha/whoami': { success: true, user: { id: 'u-1', name: 'Jovan', userName: 'Jovan1666' }, org: null },
  '/alpha/usage/summary': { totalCount: 17_641, totalCost: 67.68, successRate: 100, totalCredits: 67.68, periodBasis: 'billing-period' },
  '/alpha/billing/credits': {
    credits: { monthlyCredits: 2.4, purchasedCredits: 0, freeCredits: 0, belowThreshold: false },
    windowLimits: {
      fiveHour: { used: 2.18, cap: 14, exceeded: false, resetAt: 1_789_635_322_145 },
      weekly: { used: 2.31, cap: 35, exceeded: false, resetAt: 1_790_185_904_570 },
    },
  },
  '/alpha/billing/subscriptions': {
    success: true,
    data: { planId: 'individual-goat', status: 'active', currentPeriodStart: '2026-08-25T09:08:33.000Z', currentPeriodEnd: '2026-09-25T09:08:33.000Z' },
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
  process.env.COMMANDCODE_API_KEY = 'user_test_key'
  return import(`../index.js?t=${String(Date.now())}-${String(Math.random())}`)
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

console.log('upstream failure')
{
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
  // A discovered route makes the plugin applicable, so the failure must show.
  const settingsPath = path.join(ISOLATED_HOME, 'settings.yaml')
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
  rmSync(settingsPath, { force: true })
}

console.log(`\n${passed} checks passed`)
