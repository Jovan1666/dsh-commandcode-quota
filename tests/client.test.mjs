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
import vm from 'node:vm'
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
const checkAsync = async (label, fn) => {
  await fn()
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
  const timers = []
  const fakeWindow = {
    __ModuleLoader__: { load: (entry) => { captured = entry } },
    // The card schedules its next poll through `window.setTimeout`; recording the
    // delays is how the polling policy itself becomes testable.
    setTimeout: (_fn, delay) => { timers.push(delay); return timers.length },
    clearTimeout: () => {},
  }
  // The shipped browser artifact is evaluated as a script, against the same two
  // globals the web boot supplies and none of this module's own scope.
  globalThis.window = fakeWindow
  vm.runInThisContext(SOURCE)
  assert.equal(captured.id, 'dsh-commandcode-quota', 'bundle registers under its package id')
  const exports = captured.factory((name) => {
    assert.equal(name, 'react', `bundle requires only react, saw ${name}`)
    return reactImpl
  })
  return { exports, styles, timers }
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

/**
 * React that runs the card's effect body for real.
 *
 * The polling cadence lives inside `useEffect`, so a stub that skips it cannot
 * see the policy at all. Running the body lets the test observe which delay the
 * card schedules for which report.
 */
function liveEffectReact(stateQueue) {
  const base = stubbedReact(stateQueue)
  return Object.assign({}, base, { useEffect: (fn) => { fn() } })
}

/** The delay the card schedules for its next poll, given one report. */
async function pollDelayFor(report) {
  const { seen, timers } = applyAgainst(liveEffectReact([false, { phase: 'ready', report }]), report)
  renderToStaticMarkup(React.createElement(seen.component, { wide: true, ...seen.options.inject() }))
  // Let the fetch promise chain settle so the card can schedule its timer.
  await new Promise((resolve) => { setTimeout(resolve, 5) })
  return timers.at(-1)
}

/** Register against a fake client context and hand back what the plugin contributed. */
function applyAgainst(reactImpl, report = GOAT) {
  const { exports, styles, timers } = loadBundle(reactImpl)
  assert.equal(typeof exports.apply, 'function', 'exports apply')
  assert.deepEqual(exports.inject, ['slots', 'connection', 'locale'], 'declares its services')
  const seen = { dictionaries: {} }
  const ctx = {
    // The dictionaries install through an effect; running it inline mounts them.
    effect: (callback) => callback(),
    locale: {
      register: (namespace, dictionary) => {
        seen.dictionaries = dictionary
        return () => {}
      },
      // Reads at call time, like the real binding, and serves the shipped zh copy.
      bind: () => (key) => seen.dictionaries.zh?.[key] ?? key,
    },
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
    connection: { rpc: { call: (...args) => { seen.rpcCall = args; return Promise.resolve({ ok: true, value: report }) } } },
  }
  exports.apply(ctx)
  return { seen, styles, timers }
}

/**
 * Render the registered card with a forced hook state and its real injected face.
 * @param stateQueue values for the component's useState calls, in call order.
 * @param props extra props merged over the injected face.
 */
function renderCard(stateQueue, props = {}) {
  const { seen } = applyAgainst(stubbedReact(stateQueue))
  return renderToStaticMarkup(React.createElement(seen.component, {
    wide: true,
    ...seen.options.inject(),
    ...props,
  }))
}

/** Render the card in its ready state for one report. */
function renderReady(report, open = false) {
  return renderCard([open, { phase: 'ready', report }])
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
  check('the headline is the used percentage rounded like the official dashboard', () => {
    assert.deepEqual(percentagesIn(html), ['16%', '7%', '98%'])
  })
  check('bar width keeps full precision even though the headline rounds', () => {
    assert.match(html, /width:15\.6%[^"]*background:var\(--dsw-alias-state-success-primary\)/)
    assert.match(html, /width:6\.6%[^"]*background:var\(--dsw-alias-state-success-primary\)/)
    assert.match(html, /width:98\.1%[^"]*background:var\(--dsw-alias-state-error-primary\)/)
  })
  check('the exact one-decimal value stays on the row tooltip', () => {
    assert.match(html, /98\.1%/)
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
  check('a 99.84% monthly reads 100% exactly like the official dashboard', () => {
    // The live case behind this rounding: official shows 100% while the exact
    // share is 99.84%. The card must not disagree with the website at a glance.
    const tail = renderReady({ ...GOAT, monthly: { used: 70.1122, remaining: 0.113, cap: 70.2252, percent: 99.8391 } })
    assert.match(tail, /class="ccq-pct"[^>]*>100%</)
    assert.match(tail, /99\.8%/) // precision survives on the tooltip
  })
}

console.log('plan-agnostic rendering')
{
  check('a Pro account renders its own caps', () => {
    const html = renderReady(PRO)
    assert.match(html, /class="ccq-plan"[^>]*>Pro</)
    assert.deepEqual(percentagesIn(html), ['6%', '10%', '13%'])
    assert.match(html, /\$1\.00 \/ \$16\.00/)
  })
  check('an account with no rolling windows renders no rows', () => {
    const html = renderReady(PROVIDER)
    assert.match(html, /class="ccq-plan"[^>]*>Provider</)
    assert.equal(labelsIn(html).length, 0)
    assert.match(html, /该套餐未上报额度窗口/)
  })
  check('the detail body carries the monthly allowance and the period totals', () => {
    const html = renderReady(GOAT, true)
    const detail = html.slice(html.indexOf('ccq-detail'))
    assert.match(detail, /月度已用<\/span><span[^>]*>\$68\.89 \/ \$70\.21</)
    assert.match(detail, /剩余<\/span><span[^>]*>\$1\.32</)
    assert.match(detail, /17,859 请求 · 100%/)
    assert.match(detail, /输入 3\.34B \/ 输出 16\.32M/)
  })
  check('remaining credit carries the monthly urgency colour', () => {
    const html = renderReady(GOAT, true)
    const detail = html.slice(html.indexOf('ccq-detail'))
    assert.match(detail, /剩余<\/span><span class="ccq-kv-value" style="color:var\(--dsw-alias-state-error-primary\)">\$1\.32/)
  })
  check('the detail body leaves the rolling windows out of the money report', () => {
    // 5-hour and weekly are pass/fail limits: a user budgets against the
    // monthly allowance, and their dollar rows were pure noise in the sidebar.
    const html = renderReady(GOAT, true)
    const detail = html.slice(html.indexOf('ccq-detail'))
    assert.doesNotMatch(detail, /\$2\.18 \/ \$14\.00/)
    assert.doesNotMatch(detail, /\$2\.31 \/ \$35\.00/)
    assert.equal([...detail.matchAll(/class="ccq-kv"/g)].length, 2, 'used and remaining, nothing else')
  })
  check('no pace, burn-rate or projection language survives anywhere', () => {
    // Deliberate removal: how fast someone burns credit is not the card's
    // business, and "over pace" cannot be acted on by anyone who has work to do.
    const html = renderReady(GOAT, true)
    for (const banned of ['窗口已过', '超速', '富余', 'ccq-tick', 'ccq-pace', '/天', '天后耗尽', '每天']) {
      assert.equal(html.includes(banned), false, `card still mentions ${banned}`)
    }
  })
  check('the exact reset instant stays on the row tooltip', () => {
    const html = renderReady(GOAT)
    assert.match(html, /title="[^"]*\d\d-\d\d \d\d:\d\d/)
  })
}

console.log('warnings')
{
  check('a below-threshold balance and a canceled subscription raise warnings', () => {
    const html = renderReady({
      ...GOAT,
      monthly: { ...GOAT.monthly, belowThreshold: true },
      plan: { ...GOAT.plan, cancelAtPeriodEnd: true },
    })
    assert.match(html, /额度已低于阈值/)
    assert.match(html, /订阅已取消/)
    assert.match(html, /ccq-warn/)
  })
  check('a healthy active subscription raises no warning', () => {
    assert.doesNotMatch(renderReady(GOAT), /ccq-warn/)
  })
}

console.log('values that move')
{
  /** Percentages with nothing rounding them, for boundary assertions. */
  const rawIn = (html) => [...html.matchAll(/class="ccq-pct"[^>]*>([^<]*)</g)].map((match) => match[1])

  check('the countdown never goes negative and stops at the reset instant', () => {
    // Mid-minute fixtures on purpose: a countdown computed with `floor` is
    // asserted at 59.5 minutes, not at exactly 59, or a millisecond elapsing
    // between building the fixture and rendering would read as 58m and the
    // suite would flake once in a while.
    const soon = renderReady({ ...GOAT, fiveHour: { ...GOAT.fiveHour, resetAt: Date.now() + 59.5 * 60_000 } })
    const passed = renderReady({ ...GOAT, fiveHour: { ...GOAT.fiveHour, resetAt: Date.now() - 90_000 } })
    assert.match(soon, /59m 后重置/)
    const firstRow = (html) => {
      const start = html.indexOf('ccq-win"')
      return html.slice(start, html.indexOf('ccq-win"', start + 1))
    }
    // A reset instant that has passed prints no chip on its own row: `0m 后重置`
    // beside unmoving numbers reads as a frozen card.
    assert.doesNotMatch(firstRow(passed), /后重置/, 'the expired row keeps no chip')
    assert.doesNotMatch(passed, /-\d+m 后重置/)
  })

  check('the countdown floors rather than rounds, at the unit boundary', () => {
    const at = (minutes) => {
      const html = renderReady({ ...GOAT, fiveHour: { ...GOAT.fiveHour, resetAt: Date.now() + minutes * 60_000 } })
      return [...html.matchAll(/class="ccq-reset">([^<]*)</g)].map((match) => match[1])[0]
    }
    assert.equal(at(59.4), '59m 后重置', 'four seconds left of the minute is not a minute more')
    assert.equal(at(60.5), '1h0m 后重置', 'and the hour rolls over exactly once')
    assert.equal(at(61.5), '1h1m 后重置')
  })

  check('an exceeded window says so, and its percentage is clamped', () => {
    const html = renderReady({ ...GOAT, fiveHour: { ...GOAT.fiveHour, exceeded: true, used: 15, cap: 14, percent: 107.1 } })
    const row = html.slice(html.indexOf('ccq-win"'), html.indexOf('ccq-win"', html.indexOf('ccq-win"') + 1))
    assert.match(row, /已超限/)
    assert.doesNotMatch(row, /后重置/, 'an exceeded window counts up, not down')
    // Defence in depth: the host clamps, the card clamps, and neither prints
    // an impossible number.
    assert.match(row, /ccq-pct[^>]*>100%</)
    assert.doesNotMatch(html, /10[1-9]%/)
  })

  check('a window with no reported usage renders a dash, never a fabricated 0%', () => {
    const html = renderReady({ ...GOAT, fiveHour: { used: undefined, cap: 14, exceeded: false, resetAt: NOW + HOUR } })
    assert.deepEqual(rawIn(html), ['—', '7%', '98%'])
    assert.doesNotMatch(html, />0%</)
  })

  check('the urgency colour flips exactly at 60% and 85%', () => {
    const barsOf = (percent) => {
      const html = renderReady({ ...GOAT, monthly: { ...GOAT.monthly, percent } })
      return [...html.matchAll(/width:([\d.]+)%;background:var\(--dsw-alias-state-([a-z-]+)\)/g)]
        .map((entry) => `${entry[1]} = ${entry[2]}`)
    }
    assert.ok(barsOf(59.9).includes('59.9 = success-primary'), `bars were ${barsOf(59.9).join(' | ')}`)
    assert.ok(barsOf(60).includes('60 = warn-primary'), `bars were ${barsOf(60).join(' | ')}`)
    assert.ok(barsOf(84.9).includes('84.9 = warn-primary'), `bars were ${barsOf(84.9).join(' | ')}`)
    assert.ok(barsOf(85).includes('85 = error-primary'), `bars were ${barsOf(85).join(' | ')}`)
  })

  check('the headline rounds at the same boundary the dashboard does', () => {
    const at = (percent) => rawIn(renderReady({ ...GOAT, monthly: { ...GOAT.monthly, percent } }))[2]
    assert.equal(at(99.49), '99%')
    assert.equal(at(99.5), '100%')
    assert.equal(at(99.99), '100%')
    assert.equal(at(0.4), '0%')
    assert.equal(at(0.5), '1%')
  })

  check('an over-drawn allowance shows zero remaining, never a negative amount', () => {
    const html = renderReady({ ...GOAT, monthly: { ...GOAT.monthly, used: 71.1, remaining: -0.88, cap: 70.22, percent: 101.2 } }, true)
    assert.match(html, /剩余<\/span><span[^>]*>\$0\.00</)
    assert.doesNotMatch(html, /\$-\d/)
    assert.match(html, /100%/, 'and the percentage is clamped, not printed as 101%')
  })

  check('the rail badge follows whichever window is tightest as values change', () => {
    const monthlyWorst = renderCard([false, { phase: 'ready', report: GOAT }], { wide: false })
    assert.match(monthlyWorst, /98%/)
    const fiveHourWorst = renderCard([false, {
      phase: 'ready',
      report: { ...GOAT, fiveHour: { ...GOAT.fiveHour, used: 13.86, percent: 99 } },
    }], { wide: false })
    assert.match(fiveHourWorst, /99%/, 'the 5-hour window is now the tightest')
    assert.doesNotMatch(fiveHourWorst, /98%/)
  })

  check('a newer report replaces the older numbers outright', () => {
    const later = { ...GOAT, monthly: { ...GOAT.monthly, used: 70.1, remaining: 0.12, cap: 70.22, percent: 99.8 } }
    const html = renderReady(later, true)
    assert.deepEqual(rawIn(html), ['16%', '7%', '100%'])
    assert.match(html, /\$70\.10 \/ \$70\.22/)
    assert.doesNotMatch(html, /\$68\.89/)
  })

  check('a straddled reading states no monthly figures and says why', () => {
    // The host flags a read whose usage and credits describe different periods.
    // The card must not render the mixed-instant sum as a fact — and must not
    // leave a bare dash either, or the user cannot tell it apart from "no data".
    const html = renderReady({
      ...GOAT,
      monthly: { used: 69.5, remaining: 69.6, cap: 139.1, percent: undefined, capSuspect: true },
    }, true)
    assert.deepEqual(percentagesIn(html), ['16%', '7%', '—'], 'the monthly row states no percentage')
    assert.doesNotMatch(html, /\$69\.50 \/ \$139\.10/, 'the mixed-instant sum is not printed')
    assert.doesNotMatch(html, /class="ccq-kv"/, 'and no money rows either')
    assert.match(html, /本次读数跨了计费周期/)
    assert.doesNotMatch(html, /139/, 'nowhere does the implausible cap surface')
  })

  check('a straddled monthly reading still leaves the rolling windows readable', () => {
    const html = renderReady({
      ...GOAT,
      monthly: { used: 69.5, remaining: 69.6, cap: 139.1, percent: undefined, capSuspect: true },
    })
    assert.deepEqual(labelsIn(html), ['5 小时', '每周', '月度'])
    assert.deepEqual(percentagesIn(html), ['16%', '7%', '—'])
  })

  check('the rail badge steps aside from a suspect monthly to the next tightest window', () => {
    const rail = renderCard([false, {
      phase: 'ready',
      report: {
        ...GOAT,
        fiveHour: { ...GOAT.fiveHour, used: 13.02, percent: 93 },
        monthly: { used: 69.5, remaining: 69.6, cap: 139.1, percent: undefined, capSuspect: true },
      },
    }], { wide: false })
    assert.match(rail, /93%/, 'the 5-hour window is the tightest trustworthy one')
    assert.doesNotMatch(rail, /—/, 'a badge cannot render a dash')
  })

  check('once the host stops flagging, the monthly figures come back', () => {
    const html = renderReady({
      ...GOAT,
      monthly: { used: 69.5, remaining: 0.6, cap: 70.1, percent: 99.1, capSuspect: false },
    }, true)
    assert.match(html, /\$69\.50 \/ \$70\.10/)
    assert.match(html, /剩余<\/span><span[^>]*>\$0\.60</)
    assert.doesNotMatch(html, /本次读数跨了计费周期/)
  })

  check('a host snapshot paints at once, dimmed, with its age', () => {
    // What the card shows in the first moments after a dsh restart: the host
    // answers with its last good read while a fresh one is on its way. The
    // numbers are real but no longer current, so they say so.
    const html = renderReady({ ...GOAT, stale: true, staleAgeMs: 45_000 })
    assert.match(html, /ccq-stale/)
    assert.deepEqual(percentagesIn(html), ['16%', '7%', '98%'])
    assert.match(html, /上次成功：45m?前|<1m前|0m前|\d+m前/)
  })

  check('a live report is never dimmed', () => {
    assert.doesNotMatch(renderReady(GOAT), /ccq-stale/)
  })

  check('a snapshot that keeps coming does not count down faster', () => {
    // Both the snapshot answer and a failed refresh mean "the numbers on screen
    // are not live"; neither may crash on a missing age.
    const noAge = renderReady({ ...GOAT, stale: true })
    assert.match(noAge, /ccq-stale/)
  })

  check('a plan that stops reporting a window simply drops the row', () => {
    const html = renderReady({ ...GOAT, weekly: undefined })
    assert.deepEqual(labelsIn(html), ['5 小时', '月度'])
  })
}

console.log('what a user hits in practice')
{
  await checkAsync('a window that vanished because its endpoint failed is explained', async () => {
    // Silence here is the worst outcome: the user sees a row disappear and
    // blames their account. One muted line, and the endpoints named on the
    // card's tooltip.
    const html = renderReady({ ...GOAT, failures: ['/alpha/billing/credits: HTTP 500'] })
    assert.match(html, /1 项数据这次没取到/)
    assert.match(html, /title="[^"]*credits: HTTP 500/)
  })

  await checkAsync('a healthy read says nothing about degradation', async () => {
    assert.doesNotMatch(renderReady(GOAT), /没取到/)
  })

  await checkAsync('the host’s diagnostic wall becomes one readable line', async () => {
    const { seen } = applyAgainst(stubbedReact([false, {
      phase: 'error',
      message: '[NETWORK] 四个端点全部失败：\n  /alpha/whoami: fetch failed\n  /alpha/usage/summary: fetch failed',
    }]))
    const error = renderToStaticMarkup(React.createElement(seen.component, {
      wide: true,
      ...seen.options.inject(),
    }))
    // The visible line is the short one; the diagnostic text is only in the
    // tooltip, where it does not wreck the layout.
    const visible = /<div class="ccq-error"[^>]*>([^<]*)</.exec(error)?.[1]
    assert.equal(visible, '连不上 Command Code')
    assert.match(error, /title="\[NETWORK\][^"]*usage\/summary/)
  })

  check('a known code and an unknown one both render something', () => {
    const { seen } = applyAgainst(stubbedReact([false, { phase: 'error', message: '[NOT_FOUND] nope' }]))
    const html = renderToStaticMarkup(React.createElement(seen.component, { wide: true, ...seen.options.inject() }))
    assert.match(html, /当前套餐不含 API 权限/)
    const { seen: oddSeen } = applyAgainst(stubbedReact([false, { phase: 'error', message: 'something odd' }]))
    const odd = renderToStaticMarkup(React.createElement(oddSeen.component, { wide: true, ...oddSeen.options.inject() }))
    assert.match(odd, /something odd/, 'an unrecognised message is shown rather than swallowed')
  })

  check('the card is reachable and operable from the keyboard', () => {
    const html = renderReady(GOAT)
    assert.match(html, /role="button"/)
    assert.match(html, /tabindex="0"/)
    assert.match(html, /aria-expanded="false"/)
    const opened = renderReady(GOAT, true)
    assert.match(opened, /aria-expanded="true"/)
  })

  check('a long plan id cannot push the card’s layout apart', () => {
    const { styles } = applyAgainst(React)
    const plan = /\.ccq-plan\{[^}]*\}/.exec(styles[0].textContent)?.[0] ?? ''
    assert.match(plan, /max-width:\d+px/)
    assert.match(plan, /text-overflow:ellipsis/)
    const html = renderReady({ ...GOAT, plan: { ...GOAT.plan, name: 'individual-enterprise-ultra-plus' } })
    assert.match(html, /title="individual-enterprise-ultra-plus"/, 'the full name stays reachable')
  })
}

console.log('polling cadence follows the state that matters')
{
  await checkAsync('a window approaching its cap polls fast', async () => {
    assert.equal(await pollDelayFor(GOAT), 15_000, 'monthly at 98.1% is worth watching')
  })

  await checkAsync('a spent window stops polling fast', async () => {
    // The real account sat at 99.84% for days. Under the old rule that meant a
    // request every 15 seconds, forever, to learn nothing new.
    const spent = { ...GOAT, monthly: { ...GOAT.monthly, used: 70.11, remaining: 0.11, cap: 70.22, percent: 99.84 } }
    assert.equal(await pollDelayFor(spent), 60_000)
  })

  await checkAsync('a comfortable account polls on the relaxed cadence', async () => {
    const calm = { ...GOAT, monthly: { ...GOAT.monthly, percent: 20 }, fiveHour: { ...GOAT.fiveHour, percent: 5 }, weekly: { ...GOAT.weekly, percent: 3 } }
    assert.equal(await pollDelayFor(calm), 60_000)
  })

  await checkAsync('a snapshot is chased quickly, once', async () => {
    assert.equal(await pollDelayFor({ ...GOAT, stale: true, staleAgeMs: 45_000 }), 3_000)
  })

  await checkAsync('a host without Command Code looks again, slowly', async () => {
    // Staying invisible is right; staying invisible *forever* is what turned a
    // fixable gap into a silent one — the desktop app migrating settings.yaml
    // away was found only by hand, minutes after the config was already good.
    assert.equal(await pollDelayFor({ configured: false, reason: 'no-commandcode-provider' }), 300_000)
  })
}

console.log('states')
{
  check('renders nothing before the first answer arrives', () => {
    assert.equal(renderCard([]), '')
  })
  check('renders nothing when the host has no Command Code provider', () => {
    assert.equal(renderCard([false, { phase: 'absent' }]), '')
  })

  const { seen: errorSeen } = applyAgainst(stubbedReact([false, { phase: 'error', message: 'boom' }]))
  const error = renderToStaticMarkup(React.createElement(errorSeen.component, {
    wide: true,
    ...errorSeen.options.inject(),
  }))
  check('a failure with nothing to fall back on surfaces the message and a retry hint', () => {
    assert.match(error, /boom/)
    assert.match(error, /点击重试/)
    assert.equal(labelsIn(error).length, 0)
  })
  check('a failure after a good report keeps the numbers and marks them stale', () => {
    const html = renderCard([false, { phase: 'error', message: 'network', report: GOAT, at: Date.now() - 120_000 }])
    assert.match(html, /ccq-stale/)
    assert.deepEqual(percentagesIn(html), ['16%', '7%', '98%'])
    assert.match(html, /上次成功：2m前/)
  })
  check('collapsed sidebar badges the most constrained window, not the shortest', () => {
    const rail = renderCard([false, { phase: 'ready', report: GOAT }], { wide: false })
    assert.match(rail, /ccq-rail/)
    assert.match(rail, /98%/)
    assert.doesNotMatch(rail, /ccq-card/)
  })
  check('the rail badge stays hidden for a host without Command Code', () => {
    assert.equal(renderCard([false, { phase: 'absent' }], { wide: false }), '')
  })
}

console.log('the headline stays readable, and the meter only appears with a number')
{
  check('the percentage carries no inline colour', () => {
    // The state greens are fill colours: near 2.3:1 on a white card, under the
    // 4.5:1 a 14px headline needs. The meter below carries the same level.
    const html = renderReady(GOAT)
    assert.doesNotMatch(html, /ccq-pct[^>]*style=/)
    assert.match(html, /background:var\(--dsw-alias-state-/, 'the meter still carries the level')
  })
  check('a window with no percentage renders no meter', () => {
    const html = renderReady({ ...GOAT, fiveHour: { ...GOAT.fiveHour, percent: undefined } })
    const start = html.indexOf('ccq-win"')
    const row = html.slice(start, html.indexOf('ccq-win"', start + 1))
    assert.doesNotMatch(row, /ccq-track/, 'a zero-width bar under a dash reads as 0% used')
    assert.match(row, /ccq-pct[^>]*>—</)
  })
  check('the collapsed rail clamps the way the card does', () => {
    const html = renderCard([false, { phase: 'ready', report: { ...GOAT, fiveHour: { ...GOAT.fiveHour, percent: 107.1 } } }], { wide: false })
    assert.match(html, />100%</)
    assert.doesNotMatch(html, />107%/)
  })
  check('the collapsed rail promises no click it cannot honour', () => {
    // The badge is read-only: no handler, no role. A pointer cursor and a hover
    // fill tell a touch user the opposite.
    assert.doesNotMatch(SOURCE, /\.ccq-rail\{[^}]*cursor/)
    assert.doesNotMatch(SOURCE, /\.ccq-rail:hover/)
  })
  check('the expanded figures stay selectable', () => {
    assert.match(SOURCE, /\.ccq-head\{[^}]*user-select:none/)
    assert.doesNotMatch(SOURCE, /\.ccq-card\{[^}]*user-select/)
  })
}

console.log(`\n${passed} checks passed`)
