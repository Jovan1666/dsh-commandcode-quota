/**
 * Offline contract test for `plugin/client.js`.
 *
 * The bundle is a browser artifact, so this harness supplies the two globals it
 * actually touches (`window.__ModuleLoader__`, `document`) plus a `require` that
 * returns React, then drives the module exactly as the web boot does: capture
 * the factory, call `apply(ctx)` against a fake client context, and render the
 * registered component with `react-dom/server`.
 *
 * Run: node test-client.mjs
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const devRequire = createRequire(path.join(here, '..', '.devdeps', 'package.json'))
const React = devRequire('react')
const { renderToStaticMarkup } = devRequire('react-dom/server')

const SOURCE = readFileSync(path.join(here, '..', 'client.js'), 'utf8')

let passed = 0
const check = (label, fn) => {
  fn()
  passed += 1
  console.log(`  ok  ${label}`)
}

/** The used percentages, in document order. */
const percentagesIn = (html) => [...html.matchAll(/class="ccq-pct"[^>]*>([^<]*)</g)].map((match) => match[1])

/** The window labels, in document order. */
const labelsIn = (html) => [...html.matchAll(/class="ccq-winlabel">([^<]*)</g)].map((match) => match[1])

const DAY = 86_400_000
const HOUR = 3_600_000
/** Fixture clock: every reset instant is relative, so the test never goes stale. */
const NOW = Date.now()

/** GOAT: every window present, monthly nearly exhausted. */
const GOAT = {
  fetchedAt: '2026-09-17T06:00:00.000Z',
  plan: {
    planId: 'individual-goat',
    name: 'GOAT',
    nominalMonthlyCredits: 70,
    status: 'active',
    currentPeriodStart: new Date(NOW - 22.9 * DAY).toISOString(),
    currentPeriodEnd: new Date(NOW + 8.1 * DAY).toISOString(),
  },
  monthly: { used: 68.89, remaining: 1.32, cap: 70.21, percent: 98.1, freeCredits: 0, purchasedCredits: 0, periodBasis: 'billing-period' },
  fiveHour: { used: 2.18, cap: 14, percent: 15.6, exceeded: false, resetAt: NOW + 3 * HOUR + 25 * 60_000 },
  weekly: { used: 2.31, cap: 35, percent: 6.6, exceeded: false, resetAt: NOW + 6 * DAY + 30 * 60_000 },
  totals: { requests: 17_859, successRate: 100, tokensIn: 3_340_000_000, tokensOut: 16_320_000 },
  projection: { elapsedDays: 22.9, totalDays: 31, dailyRate: 3, runsOutInDays: 0.44 },
  failures: [],
}

/** Pro: different caps, all reported by the account rather than assumed. */
const PRO = {
  ...GOAT,
  plan: { ...GOAT.plan, planId: 'individual-pro-v1', name: 'Pro', nominalMonthlyCredits: 80 },
  monthly: { ...GOAT.monthly, used: 10, remaining: 70, cap: 80, percent: 12.5 },
  fiveHour: { used: 1, cap: 16, percent: 6.4, exceeded: false, resetAt: NOW + 2 * HOUR + 5 * 60_000 },
  weekly: { used: 4, cap: 40, percent: 10, exceeded: false, resetAt: NOW + 2 * DAY + 30 * 60_000 },
}

/** Provider: pay-as-you-go, so no rolling windows are reported at all. */
const PROVIDER = {
  ...GOAT,
  plan: { ...GOAT.plan, planId: 'individual-provider', name: 'Provider', nominalMonthlyCredits: 15 },
  monthly: { used: undefined, remaining: undefined, cap: undefined, percent: undefined, freeCredits: 0, purchasedCredits: 25.5 },
  fiveHour: undefined,
  weekly: undefined,
  projection: undefined,
}

/**
 * Evaluate the bundle against a fake browser and return its exports.
 * @param reactImpl module handed to the bundle's `require('react')`.
 * @returns module exports plus the injected-stylesheet sink.
 */
function loadBundle(reactImpl) {
  const styles = []
  globalThis.document = {
    getElementById: () => null,
    createElement: () => ({ id: '', textContent: '' }),
    head: { appendChild: (element) => { styles.push(element) } },
  }
  let captured
  const fakeWindow = {
    __ModuleLoader__: { load: (entry) => { captured = entry } },
    setInterval: () => 0,
    clearInterval: () => {},
  }
  // eslint-disable-next-line no-new-func -- evaluating the shipped browser artifact is the point.
  new Function('window', SOURCE)(fakeWindow)
  assert.equal(captured.id, 'dsh-commandcode-quota', 'bundle registers under its package id')
  const exports = captured.factory((name) => {
    assert.equal(name, 'react', `bundle requires only react, saw ${name}`)
    return reactImpl
  })
  return { exports, styles }
}

/** React with the three hooks the card uses replaced by deterministic stubs. */
function stubbedReact(stateQueue) {
  let index = 0
  return Object.assign({}, React, {
    useState: (initial) => {
      const value = index < stateQueue.length
        ? stateQueue[index]
        : (typeof initial === 'function' ? initial() : initial)
      index += 1
      return [value, () => {}]
    },
    useEffect: () => {},
    useCallback: (fn) => fn,
  })
}

/** Register against a fake client context and hand back what the plugin contributed. */
function applyAgainst(reactImpl) {
  const { exports, styles } = loadBundle(reactImpl)
  assert.equal(typeof exports.apply, 'function', 'exports apply')
  assert.deepEqual(exports.inject, ['slots', 'connection'], 'declares its services')
  const seen = {}
  const ctx = {
    slots: {
      inject: (key, callback) => {
        seen.injectKey = key
        seen.dispose = callback()
      },
      register: (options, component) => {
        seen.options = options
        seen.component = component
        return () => {}
      },
    },
    connection: { rpc: { call: (...args) => { seen.rpcCall = args; return Promise.resolve({ ok: true, value: GOAT }) } } },
  }
  exports.apply(ctx)
  return { seen, styles }
}

/** Render the registered component with a forced state. */
function render(component, props) {
  return renderToStaticMarkup(React.createElement(component, {
    fetchQuota: () => Promise.resolve({ ok: true, value: GOAT }),
    ...props,
  }))
}

/** Render the card in its ready state for one report. */
function renderReady(report, open = false) {
  const { seen } = applyAgainst(stubbedReact([open, { phase: 'ready', report }]))
  return render(seen.component, { wide: true })
}

console.log('bundle contract')
{
  const { seen, styles } = applyAgainst(React)
  check('registers into the sidebar footer action slot', () => {
    assert.equal(seen.injectKey, 'sidebar.footer.action')
    assert.equal(seen.options.name, 'sidebar.footer.action')
  })
  check('carries a list-slot id and order', () => {
    assert.equal(seen.options.id, 'cc-quota')
    assert.equal(seen.options.order, 0)
  })
  check('injects a transport callback bound to the host route', () => {
    const face = seen.options.inject()
    assert.equal(typeof face.fetchQuota, 'function')
    face.fetchQuota('signal')
    assert.deepEqual(seen.rpcCall.slice(0, 3), ['/api', 'cc-quota/report', {}])
    assert.equal(seen.rpcCall[3], 'signal')
  })
  check('injects its stylesheet exactly once, using harness design tokens', () => {
    assert.equal(styles.length, 1)
    assert.equal(styles[0].id, 'dsh-commandcode-quota-style')
    assert.match(styles[0].textContent, /--dsw-alias-border-l2/)
    assert.match(styles[0].textContent, /--dsw-alias-label-caption/)
    // The level colours are inline (they depend on the value), so assert the
    // stylesheet stays free of literal colours instead.
    assert.doesNotMatch(styles[0].textContent, /#[0-9a-f]{3,8}\b/i)
  })
}

console.log('window order and percentage-first values')
{
  const html = renderReady(GOAT)
  check('rows run 5 hours, weekly, monthly top to bottom', () => {
    assert.deepEqual(labelsIn(html), ['5 小时', '每周', '月度'])
  })
  check('the used percentage is the row value', () => {
    assert.deepEqual(percentagesIn(html), ['15.6%', '6.6%', '98.1%'])
  })
  check('bar width and colour both track the used percentage', () => {
    assert.match(html, /width:15\.6%[^"]*background:var\(--dsw-alias-state-success-primary\)/)
    assert.match(html, /width:6\.6%[^"]*background:var\(--dsw-alias-state-success-primary\)/)
    assert.match(html, /width:98\.1%[^"]*background:var\(--dsw-alias-state-error-primary\)/)
  })
  check('each row carries its own reset chip', () => {
    const chips = [...html.matchAll(/class="ccq-reset">([^<]*)</g)].map((match) => match[1])
    assert.equal(chips.length, 3)
    assert.match(chips[0], /^\d+h\d+m 后重置$/, `5-hour chip was ${chips[0]}`)
    assert.match(chips[1], /^\d+d\d+h 后重置$/, `weekly chip was ${chips[1]}`)
    assert.match(chips[2], /^\d+d\d+h 后重置$/, `monthly chip was ${chips[2]}`)
  })
  check('the warning band applies between 60% and 85%', () => {
    const warn = renderReady({ ...GOAT, fiveHour: { ...GOAT.fiveHour, used: 10, cap: 14, percent: 71.4 } })
    assert.match(warn, /width:71\.4%[^"]*background:var\(--dsw-alias-state-warn-primary\)/)
  })
}

console.log('plan-agnostic rendering')
{
  check('a Pro account renders its own caps', () => {
    const html = renderReady(PRO)
    assert.match(html, /class="ccq-plan">Pro</)
    assert.deepEqual(percentagesIn(html), ['6.4%', '10.0%', '12.5%'])
    assert.match(html, /\$1\.00 \/ \$16\.00/)
  })
  check('an account with no rolling windows renders no rows', () => {
    const html = renderReady(PROVIDER)
    assert.match(html, /class="ccq-plan">Provider</)
    assert.equal(labelsIn(html).length, 0)
    assert.match(html, /该套餐未上报额度窗口/)
  })
  check('numbers in the detail body match the report', () => {
    const html = renderReady(GOAT, true)
    assert.match(html, /\$68\.89 \/ \$70\.21 · 剩 \$1\.32/)
    assert.match(html, /\$2\.18 \/ \$14\.00/)
    assert.match(html, /本周期 17,859 请求 · 100%/)
    assert.match(html, /\$3\.00\/天 · 约 0\.4 天后耗尽/)
  })
  check('the monthly reset shown is the subscription period end', () => {
    const html = renderReady(GOAT)
    // The reset instant rides the row tooltip, so it costs no row height.
    assert.match(html, /title="[^"]*重置（8 天 \d+ 小时后）/)
  })
}

console.log('states')
{
  const { seen } = applyAgainst(stubbedReact([]))
  const loading = render(seen.component, { wide: true })
  check('loading state renders three placeholder rows', () => {
    assert.deepEqual(labelsIn(loading), ['5 小时', '每周', '月度'])
    assert.deepEqual(percentagesIn(loading), ['—', '—', '—'])
  })

  const { seen: errorSeen } = applyAgainst(stubbedReact([false, { phase: 'error', message: '[MISSING_CREDENTIAL] 未找到 key' }]))
  const error = render(errorSeen.component, { wide: true })
  check('error state surfaces the host message and a retry hint', () => {
    assert.match(error, /\[MISSING_CREDENTIAL\]/)
    assert.match(error, /点击重试/)
    assert.equal(labelsIn(error).length, 0)
  })

  const rail = (() => {
    const { seen: railSeen } = applyAgainst(stubbedReact([false, { phase: 'ready', report: GOAT }]))
    return render(railSeen.component, { wide: false })
  })()
  check('collapsed sidebar renders the rail badge for the shortest window', () => {
    assert.match(rail, /ccq-rail/)
    assert.match(rail, /16%/)
    assert.doesNotMatch(rail, /ccq-card/)
  })
}

console.log(`\n${passed} checks passed`)
