/**
 * Build a local preview page that renders the plugin's card inside a mock of
 * the real sidebar, so the layout can be inspected in a headless browser
 * without restarting the running dsh web server.
 *
 * The page loads the real `client.js` bundle, feeds it the fixture report below
 * through the same injected callback the host route satisfies, and shows three
 * columns: light collapsed (rail), light expanded, dark expanded.
 *
 * Run: node preview/build.mjs   then screenshot index.html with Chrome.
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.dirname(here)
const devdeps = path.join(root, '.devdeps', 'node_modules')

/**
 * Locate the installed ui-theme bundle that owns the design tokens.
 *
 * The theme ships inside the dsh installation, not this repo, so resolve it
 * through the profile (whose package.json anchors the profile's node_modules)
 * and then through the global install. `DSH_THEME_BUNDLE` overrides both.
 *
 * @returns the absolute path of the theme's client bundle.
 * @throws {Error} when no candidate exists, naming every path tried.
 */
function findThemeBundle() {
  const home = os.homedir()
  const dshHome = process.env.DSH_HOME ?? path.join(home, '.dsh')
  const appData = process.env.APPDATA ?? path.join(home, 'AppData', 'Roaming')
  const anchors = [
    path.join(dshHome, 'profiles', 'web', 'package.json'),
    path.join(appData, 'npm', 'node_modules', '@deepseek-ai', 'dsh', 'package.json'),
  ]
  const tried = []
  for (const anchor of anchors) {
    if (!existsSync(anchor)) {
      tried.push(`${anchor} (missing)`)
      continue
    }
    try {
      const resolved = createRequire(anchor).resolve('@deepseek-ai/dsh-client-ui-theme/package.json')
      const bundle = path.join(path.dirname(resolved), 'lib', 'client.js')
      if (existsSync(bundle)) return bundle
      tried.push(`${bundle} (missing)`)
    } catch (error) {
      tried.push(`${anchor} → ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  throw new Error(`preview: cannot locate the ui-theme bundle. Set DSH_THEME_BUNDLE. Tried:\n  ${tried.join('\n  ')}`)
}

const THEME_BUNDLE = process.env.DSH_THEME_BUNDLE ?? findThemeBundle()

/**
 * Collect the declarations of every `selector{...}` block in the theme bundle.
 *
 * The theme layers several `body{}` blocks (static palette, then alias
 * overrides), so all of them must be merged in source order — taking only the
 * last one drops `--dsw-alias-state-*` and silently turns every `var()` that
 * references it into an invalid (transparent) value.
 *
 * @param source - the theme bundle's text.
 * @param selector - exact selector text, e.g. `body`.
 * @returns the concatenated declaration bodies, in source order.
 */
function declarationsOf(source, selector) {
  const bodies = []
  let from = 0
  for (;;) {
    const start = source.indexOf(`${selector}{`, from)
    if (start === -1) break
    let depth = 0
    let end = start + selector.length
    for (; end < source.length; end += 1) {
      if (source[end] === '{') depth += 1
      else if (source[end] === '}') { depth -= 1; if (depth === 0) break }
      else if (source[end] === '"') break
    }
    bodies.push(source.slice(start + selector.length + 1, end))
    from = end + 1
  }
  return bodies.join(';')
}

const themeSource = readFileSync(THEME_BUNDLE, 'utf8')
const tokens = [
  `body{${declarationsOf(themeSource, 'body')}}`,
  // The shipped dark rule targets `body`; the preview hosts light and dark side
  // by side, so scope it to the attribute instead.
  `[data-ds-dark-theme]{${declarationsOf(themeSource, 'body[data-ds-dark-theme]')}}`,
].join('\n')

/**
 * Fixture shaped exactly like the host route's report.
 *
 * A representative mid-cycle state rather than a corner case: the monthly bar
 * sits in its red band (so the colour scale is visible) without tripping the
 * threshold warning, which stays covered by the client unit tests. Warning
 * bands, stale markers and the absent state all have dedicated test coverage;
 * this fixture exists so the common card can be looked at.
 */
const REPORT = {
  fetchedAt: new Date().toISOString(),
  plan: {
    planId: 'individual-goat',
    name: 'GOAT',
    nominalMonthlyCredits: 70,
    status: 'active',
    currentPeriodStart: new Date(Date.now() - 22.9 * 86_400_000).toISOString(),
    currentPeriodEnd: new Date(Date.now() + 8.1 * 86_400_000).toISOString(),
  },
  monthly: { used: 61.8, remaining: 8.42, cap: 70.22, percent: 88.0, freeCredits: 0, purchasedCredits: 0, periodBasis: 'billing-period', belowThreshold: false },
  fiveHour: { used: 3.49, cap: 14, percent: 24.9, exceeded: false, resetAt: Date.now() + 3_600_000 },
  weekly: { used: 3.63, cap: 35, percent: 10.4, exceeded: false, resetAt: Date.now() + 6.4 * 86_400_000 },
  totals: { requests: 17_928, successRate: 100, tokensIn: 3_410_000_000, tokensOut: 16_600_000 },
  projection: { elapsedDays: 22.9, totalDays: 31, dailyRate: 2.7, runsOutInDays: 3.1 },
  failures: [],
}

/** One sidebar column: the real shell's padding, fill, and foot order. */
const column = (id, dark, ) => `
  <div class="app ${dark ? 'app-dark' : ''}" ${dark ? 'data-ds-dark-theme' : ''} id="${id}">
    <div class="sidebar">
      <div class="grow"></div>
      <div class="footerActions"><div class="mount" data-mount="${id}"></div></div>
      <div class="settingsRow">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8">
          <circle cx="12" cy="12" r="3"></circle>
          <path d="M19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-2.9 1.2v.2a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.6 1.7 1.7 0 0 0-1.9.4l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0-1.2-2.9H2a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.6-1.1 1.7 1.7 0 0 0-.4-1.9l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 2.9-1.2V2a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 2.9 1.2l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0 1.2 2.9H22a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"></path>
        </svg>
        <span>设置</span>
      </div>
    </div>
  </div>`

/** `--with-snapshot` adds a column showing the state right after a restart. */
const withSnapshot = process.argv.includes('--with-snapshot')

const html = `<!doctype html>
<html lang="zh-CN"><head>
<meta charset="utf-8">
<title>cc-quota preview</title>
<style>${tokens}</style>
<style>
  html,body{margin:0;background:#c9ccd1;font-family:var(--dsw-font-family);}
  .strip{display:flex;gap:18px;padding:18px;align-items:flex-start;}
  .app{background:var(--dsw-specific-sidebar-fill);border-radius:10px;overflow:hidden;
       box-shadow:0 6px 24px rgba(0,0,0,.18);}
  .sidebar{box-sizing:border-box;width:248px;height:430px;padding:6px 12px;
           display:flex;flex-direction:column;
           background:var(--dsw-specific-sidebar-fill);color:var(--dsw-alias-label-primary)}
  .grow{flex:1}
  .footerActions{display:flex;flex:none;min-width:0;width:100%}
  .footerActions>*{min-width:0;width:100%}
  .settingsRow{display:flex;align-items:center;gap:8px;height:36px;margin-top:4px;
               padding:0 6px;font-size:14px;color:var(--dsw-alias-label-primary)}
  .settingsRow svg{color:var(--dsw-alias-label-secondary)}
  .caption{color:#fff;font:12px/1.6 ui-monospace,monospace;padding:0 4px 10px;text-align:center}
</style>
</head><body>
<div class="strip">
  ${column('light', false)}
  ${column('lightopen', false)}
  ${column('dark', true)}
  ${withSnapshot ? column('snapshot', false) : ''}
</div>
<script>
  window.__ModuleLoader__ = { load: (entry) => { window.__entry = entry } }
  window.__withSnapshot = ${withSnapshot ? 'true' : 'false'}
</script>
<script src="../client.js"></script>
<script src="file://${path.join(devdeps, 'react', 'umd', 'react.development.js').replaceAll('\\', '/')}"></script>
<script src="file://${path.join(devdeps, 'react-dom', 'umd', 'react-dom.development.js').replaceAll('\\', '/')}"></script>
<script>
  const REPORT = ${JSON.stringify(REPORT)}
  // The last column shows what the host answers with immediately after a dsh
  // restart: its own last good report, marked stale and carrying its age, while
  // a live read runs behind it.
  const reportFor = (id) => id === 'snapshot'
    ? Object.assign({}, REPORT, { stale: true, staleAgeMs: 45000 })
    : REPORT
  const fetched = () => Promise.resolve({ ok: true, value: REPORT })
  const React = window.React

  // Drive the bundle exactly the way the client runtime does: register against a
  // fake slot service, then mount the component it contributed.
  let contributed
  const mod = window.__entry.factory((name) => {
    if (name === 'react') return React
    throw new Error('unexpected require: ' + name)
  })
  const dictionaries = {}
  mod.apply({
    // The dictionaries install through an effect; running it inline mounts them.
    effect: (callback) => callback(),
    locale: {
      register: (namespace, dictionary) => { dictionaries[namespace] = dictionary; return () => {} },
      bind: (namespace) => (key) => (dictionaries[namespace] || {}).zh[key] || key,
    },
    slots: {
      inject: (_key, callback) => callback(),
      register: (options, component) => { contributed = { options, component }; return () => {} },
    },
    connection: { rpc: { call: () => fetched() } },
  })

  const columns = ['light', 'lightopen', 'dark'].concat(window.__withSnapshot ? ['snapshot'] : [])
  for (const id of columns) {
    const mount = document.querySelector('[data-mount="' + id + '"]')
    const wide = id !== 'light'
    const face = Object.assign({}, contributed.options.inject(), {
      fetchQuota: () => Promise.resolve({ ok: true, value: reportFor(id) }),
    })
    ReactDOM.createRoot(mount).render(
      React.createElement(contributed.component, Object.assign({ wide }, face))
    )
  }

  // Effects settle asynchronously; the expanded column is clicked afterwards so
  // the screenshot shows both the resting and the opened card.
  setTimeout(() => {
    const card = document.querySelector('[data-mount="lightopen"] .ccq-card')
    if (card) card.click()
  }, 400)
</script>
</body></html>
`

const target = path.join(here, 'index.html')
writeFileSync(target, html, 'utf8')
console.log('wrote', target)
