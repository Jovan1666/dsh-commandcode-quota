/**
 * Offline test for the credential and route discovery in `plugin/quota.mjs`.
 *
 * This is the "does it work for someone else" suite: every case builds a fresh
 * temp DSH home with its own settings and credential files, then asserts the
 * lookup follows *that* user's naming rather than ours.
 *
 * Run: node test-quota.mjs
 */

import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const { resolveApiKey, discoverRoutes, subscriptionPlanInfo } = await import(
  `../quota.mjs?t=${String(Date.now())}`
)

let passed = 0
const check = (label, fn) => {
  fn()
  passed += 1
  console.log(`  ok  ${label}`)
}

/** Build a throwaway DSH home. */
function makeHome({ settings, credentials } = {}) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'cc-quota-test-'))
  if (settings !== undefined) writeFileSync(path.join(dir, 'settings.yaml'), settings, 'utf8')
  if (credentials !== undefined) writeFileSync(path.join(dir, '.credentials.yaml'), credentials, 'utf8')
  return dir
}

/** An isolated `home` that never resolves a real user profile. */
const NO_HOME = path.join(os.tmpdir(), 'cc-quota-no-such-home')

const SETTINGS_ONE_ROUTE = `ui-onboarding:
  welcomeNoticeVersion: 2026-08-13.1
llm-pi-ai:
  providers:
    command-code-goat:
      displayName: 我的 Command Code
      apiKeyEnv: MY_CUSTOM_KEY
      api: openai-completions
      baseURL: https://api.commandcode.ai/provider/v1
      models:
        - id: deepseek/deepseek-v4-flash
          name: DeepSeek V4 Flash
agent-loop:
  maxParallelToolCalls: 1000
`

console.log('route discovery')
{
  check('finds a commandcode route and keeps its sibling fields', () => {
    const routes = discoverRoutes(SETTINGS_ONE_ROUTE)
    assert.equal(routes.length, 1)
    assert.equal(routes[0].baseURL, 'https://api.commandcode.ai/provider/v1')
    assert.equal(routes[0].keyRef, 'MY_CUSTOM_KEY')
    assert.equal(routes[0].apiKey, undefined)
  })
  check('ignores routes pointing somewhere else', () => {
    const routes = discoverRoutes(`llm-pi-ai:
  providers:
    deepseek-official:
      apiKeyEnv: DEEPSEEK_API_KEY
      baseURL: https://api.deepseek.com
    cc:
      apiKeyEnv: CC_KEY
      baseURL: https://api.commandcode.ai
`)
    assert.equal(routes.length, 1)
    assert.equal(routes[0].keyRef, 'CC_KEY')
  })
  check('a nested models list does not end the block', () => {
    const routes = discoverRoutes(`llm-pi-ai:
  providers:
    cc:
      baseURL: https://api.commandcode.ai/provider/v1
      models:
        - id: a/b
          name: A
          apiKeyEnv: NOT_THIS_ONE
      apiKeyEnv: REAL_KEY
`)
    assert.equal(routes.length, 1)
    assert.equal(routes[0].keyRef, 'REAL_KEY')
  })
  check('a later sibling route terminates the previous block', () => {
    const routes = discoverRoutes(`llm-pi-ai:
  providers:
    one:
      apiKeyEnv: FIRST
      baseURL: https://api.commandcode.ai
    two:
      apiKeyEnv: SECOND
      baseURL: https://api.commandcode.ai/provider/v1
`)
    assert.deepEqual(routes.map((route) => route.keyRef), ['FIRST', 'SECOND'])
  })
}

console.log('credential resolution follows the user config, not our naming')
{
  check('resolves the apiKeyEnv the user configured, from the credential store', () => {
    const home = makeHome({
      settings: SETTINGS_ONE_ROUTE,
      credentials: 'version: 1\nrefs:\n  MY_CUSTOM_KEY: user_from_store\n',
    })
    const hit = resolveApiKey({ env: {}, dshHome: home, home: NO_HOME })
    assert.equal(hit.key, 'user_from_store')
    assert.match(hit.source, /refs\.MY_CUSTOM_KEY/)
    // The provider baseURL carries a path, but `/alpha/*` lives at the host root.
    assert.equal(hit.apiBase, 'https://api.commandcode.ai')
    rmSync(home, { recursive: true, force: true })
  })
  check('keeps the host the user chose but drops its path', () => {
    const home = makeHome({
      settings: `llm-pi-ai:
  providers:
    cc:
      apiKeyEnv: STAGING_KEY
      baseURL: https://staging.commandcode.ai/provider/v1
`,
    })
    const hit = resolveApiKey({ env: { STAGING_KEY: 'user_staging' }, dshHome: home, home: NO_HOME })
    assert.equal(hit.apiBase, 'https://staging.commandcode.ai')
    rmSync(home, { recursive: true, force: true })
  })
  check('prefers the environment over the credential store for that same name', () => {
    const home = makeHome({
      settings: SETTINGS_ONE_ROUTE,
      credentials: 'version: 1\nrefs:\n  MY_CUSTOM_KEY: user_from_store\n',
    })
    const hit = resolveApiKey({ env: { MY_CUSTOM_KEY: 'user_from_env' }, dshHome: home, home: NO_HOME })
    assert.equal(hit.key, 'user_from_env')
    assert.match(hit.source, /环境变量 MY_CUSTOM_KEY/)
    rmSync(home, { recursive: true, force: true })
  })
  check('accepts a literal apiKey written into the provider row', () => {
    const home = makeHome({
      settings: `llm-pi-ai:
  providers:
    cc:
      apiKey: user_literal
      baseURL: https://api.commandcode.ai
`,
    })
    const hit = resolveApiKey({ env: {}, dshHome: home, home: NO_HOME })
    assert.equal(hit.key, 'user_literal')
    rmSync(home, { recursive: true, force: true })
  })
  check('a route for another host does not shadow the generic fallbacks', () => {
    const home = makeHome({
      settings: `llm-pi-ai:
  providers:
    deepseek-official:
      apiKeyEnv: DEEPSEEK_API_KEY
      baseURL: https://api.deepseek.com
`,
    })
    const hit = resolveApiKey({ env: { COMMANDCODE_API_KEY: 'user_generic' }, dshHome: home, home: NO_HOME })
    assert.equal(hit.key, 'user_generic')
    assert.equal(hit.apiBase, undefined, 'no discovered base when the route is not Command Code')
    rmSync(home, { recursive: true, force: true })
  })
  check('any environment variable named after Command Code is accepted', () => {
    const hit = resolveApiKey({ env: { SOMETHING_COMMANDCODE_TOKEN: 'user_named' }, dshHome: NO_HOME, home: NO_HOME })
    assert.equal(hit.key, 'user_named')
    assert.match(hit.source, /SOMETHING_COMMANDCODE_TOKEN/)
  })
  check('falls back to the official CLI login file', () => {
    const home = mkdtempSync(path.join(os.tmpdir(), 'cc-quota-test-'))
    mkdirSync(path.join(home, '.commandcode'), { recursive: true })
    writeFileSync(path.join(home, '.commandcode', 'auth.json'), JSON.stringify({ apiKey: 'user_cli_login' }), 'utf8')
    const hit = resolveApiKey({ env: {}, dshHome: NO_HOME, home })
    assert.equal(hit.key, 'user_cli_login')
    rmSync(home, { recursive: true, force: true })
  })
  check('nothing configured names the fix instead of failing silently', () => {
    assert.throws(
      () => resolveApiKey({ env: {}, dshHome: NO_HOME, home: NO_HOME }),
      (error) => error.code === 'MISSING_CREDENTIAL' && /provider/.test(error.message),
    )
  })
  check('an explicit key still wins over everything', () => {
    const home = makeHome({ settings: SETTINGS_ONE_ROUTE, credentials: 'version: 1\nrefs:\n  MY_CUSTOM_KEY: user_store\n' })
    const hit = resolveApiKey({ apiKey: 'user_explicit', env: { MY_CUSTOM_KEY: 'user_env' }, dshHome: home, home: NO_HOME })
    assert.equal(hit.key, 'user_explicit')
    rmSync(home, { recursive: true, force: true })
  })
}

console.log('plan table covers every published tier')
{
  check('resolves each shipped planId, longest prefix first', () => {
    assert.equal(subscriptionPlanInfo('individual-go')?.name, 'Go')
    assert.equal(subscriptionPlanInfo('individual-goat')?.name, 'GOAT')
    assert.equal(subscriptionPlanInfo('individual-pro')?.name, 'Pro')
    assert.equal(subscriptionPlanInfo('individual-pro-v1')?.name, 'Pro')
    assert.equal(subscriptionPlanInfo('individual-pro-v1')?.monthlyCredits, 80)
    assert.equal(subscriptionPlanInfo('individual-provider')?.name, 'Provider')
    assert.equal(subscriptionPlanInfo('individual-max')?.name, 'Max')
    assert.equal(subscriptionPlanInfo('individual-ultra')?.name, 'Ultra')
    assert.equal(subscriptionPlanInfo('teams-pro')?.name, 'Teams Pro')
  })
  check('an unknown planId degrades to the raw id rather than guessing', () => {
    assert.equal(subscriptionPlanInfo('individual-something-new'), undefined)
  })
}

console.log('a credential reference that is not a variable name')
{
  // `apiKeyEnv` is interpolated into the credential-file pattern. A regex
  // metacharacter there would match the first unrelated row and hand *that*
  // provider's key to Command Code.
  const home = makeHome({
    settings: 'llm-pi-ai:\n  providers:\n    cc:\n      apiKeyEnv: .*\n      api: openai-completions\n      baseURL: https://api.commandcode.ai/provider/v1\n',
    credentials: 'refs:\n  OTHER_PROVIDER_KEY: sk-not-yours\n',
  })
  check('is refused rather than matching another provider key', () => {
    assert.throws(
      () => resolveApiKey({ env: {}, home, dshHome: home }),
      (error) => error.code === 'MISSING_CREDENTIAL' && /apiKeyEnv/.test(error.message),
    )
  })
  rmSync(home, { recursive: true, force: true })
}

console.log('a plan id the table does not carry')
{
  check('matches no entry, so it sets no allowance baseline', () => {
    // Prefix matching let `individual-pro-v2` inherit `individual-pro`'s 30 and
    // then veto its own percentage for the whole period.
    assert.equal(subscriptionPlanInfo('individual-pro-v2'), undefined)
    assert.equal(subscriptionPlanInfo('individual-goat')?.monthlyCredits, 70)
  })
}

console.log(`\n${passed} checks passed`)
