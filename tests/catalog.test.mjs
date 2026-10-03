/**
 * Offline test for the docs catalog in `../catalog.mjs`.
 *
 * The catalog answers "how many times can I call each model on my plan" from
 * `GET <plan page> + RSC: 1`, and the second half of that sentence is the part
 * worth testing: it must not re-download a 199 KB page that has not changed, and
 * it must never invent a number the docs did not publish.
 *
 * The fixtures under `fixtures/` are real captures. Two are verbatim slices of the
 * official pages; three re-deliver that same captured record in the failure shapes a
 * proxy or CDN can produce (split across a line break, junk lines interleaved, flight
 * chunks of a whole HTML page). Each file's header names its source URL and date, and
 * the assertions are the numbers the page itself rendered (154,000 / 76,900 / 30,800
 * for DeepSeek V4.1 Flash on GOAT).
 *
 * Offline by construction: the only fetch implementation is the fake one below,
 * and every clock is injected. Nothing here touches the network, a real DSH home,
 * or the wall clock.
 *
 * Run: node tests/catalog.test.mjs
 */

import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const catalog = await import('../catalog.mjs')

const FIXTURES = path.join(here, 'fixtures')
const fixtureText = (name) => readFileSync(path.join(FIXTURES, name), 'utf8')
const goatFixture = fixtureText('plan-goat.rsc.txt')
const pricingFixture = fixtureText('pricing-limits.rsc.txt')

const GOAT_URL = catalog.PLAN_DOC_URLS['individual-goat'].url
/** The moment the fixtures were captured: every assertion is relative to this, never to `Date.now()`. */
const NOW = Date.parse('2026-10-01T18:25:06Z')
const HOUR = 3_600_000
const iso = (ms) => new Date(ms).toISOString()

let passed = 0
const failures = []
const ok = (label) => {
  passed += 1
  console.log(`  ok  ${label}`)
}
const report = (label, error) => {
  failures.push(label)
  console.log(`  FAIL ${label}`)
  for (const line of String(error?.message ?? error).split('\n').slice(0, 4)) console.log(`       ${line}`)
}
const check = (label, fn) => {
  try {
    fn()
  } catch (error) {
    report(label, error)
    return
  }
  ok(label)
}
const checkAsync = async (label, fn) => {
  try {
    await fn()
  } catch (error) {
    report(label, error)
    return
  }
  ok(label)
}

const tmpRoot = mkdtempSync(path.join(os.tmpdir(), 'cc-catalog-test-'))
const tmpFile = (...parts) => path.join(tmpRoot, ...parts)

/* ---------------------------------------------------------------- helpers */

const RECORD = /^([0-9a-f]*):(.*)$/

/** Every `id:JSON` line in a flight stream, the same way the module reads it. */
function records(text) {
  const found = []
  text.split('\n').forEach((line) => {
    const match = RECORD.exec(line)
    if (match === null || match[2] === '' || (match[2][0] !== '[' && match[2][0] !== '{')) return
    try {
      found.push({ id: match[1], value: JSON.parse(match[2]) })
    } catch {
      // truncated record: not data
    }
  })
  return found
}

const propsOf = (value) => (Array.isArray(value) && value.length >= 4 && value[3] !== null && typeof value[3] === 'object' && !Array.isArray(value[3]) ? value[3] : undefined)

/** The per-model allowance table from a plan page. */
const isEstimates = (props) => Array.isArray(props.rows) && props.rows.length > 0
  && typeof props.fiveHourFraction === 'number' && typeof props.weeklyFraction === 'number'
  && props.rows.some((row) => row !== null && typeof row === 'object' && typeof row.budgetUsd === 'number')

/** The model availability table from the pricing page. */
const isAvailability = (props) => Array.isArray(props.rows) && props.rows.length > 0
  && props.rows.every((row) => row !== null && typeof row === 'object' && typeof row.id === 'string' && row.availability !== null && typeof row.availability === 'object')

/** Rewrite the single record matching a structural signature, leaving every other line untouched. */
function rewriteRecord(text, predicate, transform) {
  const lines = text.split('\n')
  for (let index = 0; index < lines.length; index += 1) {
    const match = RECORD.exec(lines[index])
    if (match === null) continue
    let value
    try {
      value = JSON.parse(match[2])
    } catch {
      continue
    }
    const props = propsOf(value)
    if (props === undefined || !predicate(props)) continue
    lines[index] = transform({ id: match[1], value, props, line: lines[index] })
    return lines.join('\n')
  }
  throw new Error('the fixture no longer matches the structural signature this test edits')
}

/** Damage the real GOAT table in memory — the "site redesigned the page" simulation. */
const editedEstimates = (edit) => rewriteRecord(goatFixture, isEstimates, ({ id, value, props }) => {
  edit(props)
  return `${id}:${JSON.stringify(value)}`
})

/** A page shell around the records: upstream bodies really do carry this, and none of it may be cached. */
const HTML_PROLOGUE = '<!DOCTYPE html><html><head><script>self.__next_f.push([1,"page shell"])</script></head><body>\n'

function response({ status = 200, etag, url, body } = {}) {
  const bytes = body === undefined ? undefined : Buffer.from(body, 'utf8')
  return {
    status,
    url,
    headers: { get: (name) => (name.toLowerCase() === 'etag' ? (etag ?? null) : null) },
    async arrayBuffer() {
      if (bytes === undefined) throw new Error('a response without a body must never be read as one')
      return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)
    },
  }
}

/**
 * The fake docs server. `head`/`get` per page; a route value may be an `Error`
 * to make that hop fail, and HEAD handlers never hand out a body.
 */
function docsFetch({ goat = {}, pricing = {} } = {}) {
  const routes = {
    [GOAT_URL]: { head: { status: 200, etag: '"goat-v1"' }, get: { status: 200, etag: '"goat-v1"', body: HTML_PROLOGUE + goatFixture }, ...goat },
    [catalog.PRICING_DOC_URL]: { head: { status: 200, etag: '"pricing-v1"' }, get: { status: 200, etag: '"pricing-v1"', body: HTML_PROLOGUE + pricingFixture }, ...pricing },
  }
  const calls = []
  const fetchImpl = async (url, options = {}) => {
    const method = options.method ?? 'GET'
    calls.push({ url, method, headers: { ...(options.headers ?? {}) } })
    const route = routes[url]
    if (route === undefined) throw new Error(`fake fetch: unexpected url ${url}`)
    const spec = method === 'HEAD' ? route.head : route.get
    if (spec instanceof Error) throw spec
    if (method === 'HEAD') return response({ status: spec.status, etag: spec.etag, url })
    if (spec.body === undefined) throw new Error('fake fetch: this GET route has no body')
    return response({ status: spec.status, etag: spec.etag, url, body: spec.body })
  }
  const hops = (url) => calls.filter((call) => call.url === url).map((call) => call.method)
  return {
    fetchImpl,
    calls,
    plan: () => hops(GOAT_URL),
    pricing: () => hops(catalog.PRICING_DOC_URL),
    gets: () => calls.filter((call) => call.method === 'GET').length,
  }
}

const sync = (file, fake, now, extra = {}) => catalog.syncCatalog({ planId: 'individual-goat', file, fetchImpl: fake.fetchImpl, now, env: {}, ...extra })

/** The numbers a row contributes, without the fields that only describe provenance. */
const numbersOf = (model) => ({
  name: model?.name,
  monthly: model?.monthly,
  fiveHour: model?.fiveHour,
  week: model?.week,
  free: model?.free,
  budgetUsd: model?.budgetUsd,
})

/* ------------------------------------------------------- paths, constants */

console.log('paths and constants')
{
  check('catalogCachePath puts catalog.json in the plugin folder under $DSH_HOME', () => {
    const dshHome = path.join(tmpRoot, 'dsh-home')
    assert.equal(
      catalog.catalogCachePath({ env: { DSH_HOME: dshHome }, home: path.join(tmpRoot, 'elsewhere') }),
      path.join(dshHome, 'dsh-commandcode-quota', 'catalog.json'),
    )
  })
  check('catalogCachePath falls back to <home>/.dsh when DSH_HOME is unset', () => {
    const home = path.join(tmpRoot, 'somebody')
    assert.equal(catalog.catalogCachePath({ env: {}, home }), path.join(home, '.dsh', 'dsh-commandcode-quota', 'catalog.json'))
  })
  check('catalogSeedPath points at the baseline shipped next to catalog.mjs, and it exists', () => {
    const seed = catalog.catalogSeedPath()
    assert.equal(path.basename(seed), 'catalog.seed.json')
    assert.equal(path.dirname(seed), path.resolve(here, '..'), 'the seed ships in the package root, next to catalog.mjs')
    assert.ok(existsSync(seed), `${seed} is missing: an offline install would have nothing to show`)
    assert.ok(statSync(seed).size > 0)
  })
  check('the policy constants are the documented ones', () => {
    assert.equal(catalog.CATALOG_TTL_MS, 24 * HOUR)
    assert.equal(catalog.CATALOG_MIN_RETRY_MS, 6 * HOUR)
    assert.equal(catalog.CATALOG_TTL_ENV_NAME, 'COMMANDCODE_CATALOG_TTL_MS')
    assert.equal(catalog.CATALOG_KIND, 'commandcode-catalog')
    assert.equal(catalog.CATALOG_VERSION, 1)
    // v2 added the pricing-calculator fallback, the Free state and per-planId Go
    // window fractions; a bump is what forces old caches to be recomputed.
    assert.equal(catalog.CATALOG_SCHEMA, 2)
    assert.deepEqual(catalog.CATALOG_REQUEST_HEADERS, { RSC: '1' })
  })
  check('Go window fractions come from the plan id, never from the shared calculator tier', () => {
    // The vendor's short tier `go` covers two generations with different windows
    // ($2/$5 → 0.2/0.5 and $3/$6 → 0.3/0.6). Indexing the fractions by tier instead
    // of by planId would hand a new-Go user windows 50% too generous — and the panel
    // would look perfectly plausible while saying it.
    const go = catalog.parsePlanCatalog('individual-go', goatFixture, { now: NOW })
    const goV1 = catalog.parsePlanCatalog('individual-go-v1', goatFixture, { now: NOW })
    assert.deepEqual(go.entry.fractions, { fiveHourFraction: 0.2, weeklyFraction: 0.5 })
    assert.deepEqual(goV1.entry.fractions, { fiveHourFraction: 0.3, weeklyFraction: 0.6 })
    assert.equal(catalog.PLAN_CALCULATOR_TIERS['individual-go'], 'go')
    assert.equal(catalog.PLAN_CALCULATOR_TIERS['individual-go-v1'], 'go')
    // 0.3 / 0.2 is 1.4999999999999998 in IEEE754; compare with a tolerance.
    assert.ok(Math.abs(goV1.entry.fractions.fiveHourFraction / go.entry.fractions.fiveHourFraction - 1.5) < 1e-9)
  })
  check('the pricing-calculator fallback stops at go/goat/pro, where the vendor publishes allowances', () => {
    for (const planId of ['individual-max', 'individual-ultra', 'individual-provider', 'teams-pro']) {
      assert.equal(catalog.PLAN_CALCULATOR_TIERS[planId], undefined, `${planId} must not be derivable from the calculator`)
    }
    for (const planId of ['individual-go', 'individual-go-v1', 'individual-goat', 'individual-pro', 'individual-pro-v1']) {
      assert.equal(typeof catalog.PLAN_CALCULATOR_TIERS[planId], 'string')
    }
  })
  check('a model is available when its availability says so, not when a plan name does', () => {
    // `minPlanName` in the vendor's payload is "cheapest plan that includes this model",
    // and Go's count happens to equal the individual-go availability count — close
    // enough that reaching for it instead of `availability[planId]` looks harmless.
    const pricingText = [
      `2f:["$","$L4f",null,{"rows":${JSON.stringify([
        { id: 'only-on-go', name: 'Only On Go', minPlanName: 'Go', availability: { 'individual-go': true } },
      ])}}]`,
      `2a:["$","$L4e",null,{"models":${JSON.stringify([
        { id: 'only-on-go', name: 'Only On Go', provider: 'DeepSeek', inputCost: 0.1, outputCost: 0.2, cacheReadCost: 0.01, planAllowanceUsd: { go: 10, goat: 70, pro: 80 } },
      ])}}]`,
    ].join('\n')
    const availability = catalog.parsePricingCatalog(pricingText).models
    assert.deepEqual(availability[0].availableIn, ['individual-go'])
    // Available and derivable on Go…
    const onGo = catalog.parsePlanCatalog('individual-go', goatFixture, { now: NOW, availability }).entry
    const derived = onGo.models.find((model) => model.key === 'only-on-go')
    assert.equal(derived.source, 'derived')
    // …and simply absent on Max, which the calculator cannot price either.
    const onMax = catalog.parsePlanCatalog('individual-max', goatFixture, { now: NOW, availability }).entry
    assert.equal(onMax.models.find((model) => model.key === 'only-on-go'), undefined)
  })
  check('only the four published plan pages are mapped; the rest stay undefined', () => {
    assert.equal(catalog.PRICING_DOC_URL, 'https://commandcode.ai/docs/resources/pricing-limits')
    assert.equal(catalog.PLAN_DOC_URLS['individual-goat'].url, 'https://commandcode.ai/docs/plans/goat')
    assert.equal(catalog.PLAN_DOC_URLS['individual-ultra'].url, catalog.PLAN_DOC_URLS['individual-max'].url)
    assert.equal(catalog.PLAN_DOC_URLS['individual-ultra'].inferred, 'Max')
    assert.equal(catalog.PLAN_DOC_URLS['teams-pro'], undefined)
    assert.equal(catalog.PLAN_DOC_URLS['individual-provider'], undefined)
  })
  check('resolveCatalogTtlMs prefers an explicit value, then the env knob, then the default', () => {
    const env = { [catalog.CATALOG_TTL_ENV_NAME]: '3600000' }
    assert.equal(catalog.resolveCatalogTtlMs({ ttlMs: 300_000, env }), 300_000)
    assert.equal(catalog.resolveCatalogTtlMs({ env }), 3_600_000)
    for (const raw of ['', '   ', 'abc', 'NaN', '0', '59999', '2592000001']) {
      assert.equal(catalog.resolveCatalogTtlMs({ env: { [catalog.CATALOG_TTL_ENV_NAME]: raw } }), catalog.CATALOG_TTL_MS, `raw=${JSON.stringify(raw)} was accepted`)
    }
  })
}

/* --------------------------------------------- parsing the real captures */

console.log('the real GOAT page, row by row')
{
  check('parseEstimates reads the real flight stream and keeps both window fractions', () => {
    const estimates = catalog.parseEstimates(goatFixture)
    assert.ok(estimates !== undefined, 'the fixture table was not recognised at all')
    assert.equal(estimates.rows.length, 51)
    assert.equal(estimates.fiveHourFraction, 0.2)
    assert.equal(estimates.weeklyFraction, 0.5)
    for (const row of estimates.rows) {
      assert.equal(typeof row.budgetUsd, 'number')
      assert.equal(typeof row.shape.inputTokens, 'number')
      assert.equal(typeof row.rates.inputCost, 'number')
    }
  })
  check('a record id never has to be guessed: comment lines and junk lines are skipped', () => {
    // The fixture leads with its provenance header, and real streams carry module
    // references and half-written lines. None of that may break the table lookup.
    const noisy = `9:not json at all\nzz:{"skipped":true}\n:[\n${goatFixture}\n0:{"trailing":true}\n`
    const estimates = catalog.parseEstimates(noisy)
    assert.equal(estimates?.rows.length, 51)
  })
  check('DeepSeek V4.1 Flash reproduces the numbers the page rendered', () => {
    const entry = catalog.parsePlanCatalog('individual-goat', goatFixture, { now: NOW }).entry
    const flash = entry.models.find((model) => model.key === 'deepseek-v4-1-flash')
    assert.ok(flash !== undefined, 'DeepSeek V4.1 Flash is missing from the parsed table')
    assert.equal(flash.name, 'DeepSeek V4.1 Flash')
    assert.equal(flash.budgetUsd, 60)
    assert.equal(catalog.formatCount(flash.monthly), '154,000')
    assert.equal(catalog.formatCount(flash.week), '76,900')
    assert.equal(catalog.formatCount(flash.fiveHour), '30,800')
    assert.equal(flash.free, false)
    assert.equal(flash.source, 'plan-doc')
  })
  check('normalizeModelKey folds every spelling the two official pages use for one model', () => {
    const key = catalog.normalizeModelKey('DeepSeek V4.1 Flash')
    assert.equal(key, 'deepseek-v4-1-flash')
    assert.equal(catalog.normalizeModelKey('deepseek/deepseek-v4.1-flash'), key)
    assert.equal(catalog.normalizeModelKey('DeepSeek V4.1 Flash (latest)'), key)
    assert.equal(catalog.normalizeModelKey('  DeepSeek   V4.1   FLASH  '), key)
    assert.equal(catalog.normalizeModelKey('Kimi K2.7 Code'), 'kimi-k2-7-code')
    assert.equal(catalog.normalizeModelKey(''), undefined)
    assert.equal(catalog.normalizeModelKey(undefined), undefined)
  })
  check('computeAllowance is the published formula: budget divided by the per-request cost', () => {
    const estimates = catalog.parseEstimates(goatFixture)
    const row = estimates.rows.find((candidate) => candidate.name === 'DeepSeek V4.1 Flash')
    const allowance = catalog.computeAllowance(row, estimates, NOW)
    const perRequest = (800 / 1e6) * 0.15 + (200 / 1e6) * 0.6 + (50_000 / 1e6) * 0.003
    assert.ok(Math.abs(allowance.monthly - 60 / perRequest) < 1e-6)
    assert.equal(allowance.fiveHour, allowance.monthly * 0.2)
    assert.equal(allowance.week, allowance.monthly * 0.5)
    assert.equal(allowance.free, false)
  })
  check('computeAllowance follows the page clock, not the wall clock', () => {
    const estimates = catalog.parseEstimates(goatFixture)
    const row = estimates.rows.find((candidate) => candidate.name === 'DeepSeek V4.1 Flash')
    // The row carries timeOfDay{effective, peak, offPeak}: the headline number is the
    // off-peak one (same as base here), and the peak tooltip only exists after `effective`.
    const before = catalog.computeAllowance(row, estimates, Date.parse('2026-08-01T00:00:00Z'))
    const after = catalog.computeAllowance(row, estimates, NOW)
    assert.equal(before.peak, undefined)
    assert.ok(after.peak !== undefined)
    assert.ok(Math.abs(after.peak.monthly - after.monthly / 2) < 1e-6, 'peak rates are exactly double the off-peak ones')
    assert.equal(after.monthly, before.monthly)
  })
  check('the peak column is the page peak rate, not a copy of the headline', () => {
    // Discriminating on purpose: the headline column would pass even if the code
    // ignored timeOfDay entirely. Only reading `timeOfDay.peak` yields 76,900 here.
    const estimates = catalog.parseEstimates(goatFixture)
    const row = estimates.rows.find((candidate) => candidate.name === 'DeepSeek V4.1 Flash')
    const allowance = catalog.computeAllowance(row, estimates, NOW)
    assert.equal(catalog.formatCount(allowance.peak?.monthly), '76,900')
    assert.equal(catalog.formatCount(allowance.peak?.week), '38,500')
    assert.equal(catalog.formatCount(allowance.peak?.fiveHour), '15,400')
    assert.notEqual(allowance.peak.monthly, allowance.monthly, 'the peak column repeated the off-peak numbers')
  })
  check('an off-peak change moves the headline column, and the peak column keeps its own rates', () => {
    // Synthetic row built from the real one: `effective` in the future means the base
    // rates still apply; once it has passed and off-peak differs from the base rates,
    // the headline column has to follow off-peak while peak keeps its own numbers.
    const synthetic = editedEstimates((props) => {
      const row = props.rows.find((candidate) => candidate.name === 'DeepSeek V4.1 Flash')
      row.rates = { inputCost: 0.15, outputCost: 0.6, cacheReadCost: 0.003 }
      row.timeOfDay = {
        effective: '2026-12-01T00:00:00Z',
        offPeak: { inputCost: 0.2, outputCost: 0.8, cacheReadCost: 0.004 },
        peak: { inputCost: 0.3, outputCost: 1.2, cacheReadCost: 0.006 },
      }
    })
    const estimates = catalog.parseEstimates(synthetic)
    const row = estimates.rows.find((candidate) => candidate.name === 'DeepSeek V4.1 Flash')
    const before = catalog.computeAllowance(row, estimates, Date.parse('2026-11-01T00:00:00Z'))
    const after = catalog.computeAllowance(row, estimates, Date.parse('2027-01-01T00:00:00Z'))
    assert.equal(catalog.formatCount(before.monthly), '154,000', 'before `effective` the base rates apply')
    assert.equal(before.peak, undefined, 'the peak column must not exist before the switch')
    assert.equal(catalog.formatCount(after.monthly), '115,000', 'after `effective` the off-peak rates apply')
    assert.equal(catalog.formatCount(after.peak.monthly), '76,900')
    assert.equal(catalog.formatCount(after.fiveHour), '23,100')
    assert.equal(catalog.formatCount(after.week), '57,700')
  })
  check('formatCount matches the site number formatting at its edges', () => {
    assert.equal(catalog.formatCount(Number.POSITIVE_INFINITY), 'Free')
    assert.equal(catalog.formatCount(0), '0')
    assert.equal(catalog.formatCount(undefined), '—')
    assert.equal(catalog.formatCount(null), '—')
    assert.equal(catalog.formatCount(154_000), '154,000')
    assert.equal(catalog.formatCount(2_070), '2,070')
    assert.equal(catalog.formatCount(999), '999')
    assert.equal(catalog.formatCount(1_234_567), '1,230,000')
  })
  check('stripWeak lets a weak and a strong ETag compare equal', () => {
    assert.equal(catalog.stripWeak('W/"abc"'), '"abc"')
    assert.equal(catalog.stripWeak('"abc"'), '"abc"')
    assert.equal(catalog.stripWeak('  W/"abc"  '), '"abc"')
    assert.equal(catalog.stripWeak(undefined), undefined)
  })
  check('contentDigest is a plain sha256 of the bytes', () => {
    assert.equal(catalog.contentDigest(Buffer.from('', 'utf8')), 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855')
    assert.equal(catalog.contentDigest(Buffer.from('abc', 'utf8')), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad')
    const bytes = Buffer.from(goatFixture, 'utf8')
    assert.equal(catalog.contentDigest(bytes), catalog.contentDigest(Buffer.from(goatFixture, 'utf8')))
    assert.notEqual(catalog.contentDigest(bytes), catalog.contentDigest(Buffer.from(`${goatFixture} `, 'utf8')))
  })
}

/* ---------------------------------------------------- parsing the pricing */

console.log('the real pricing/limits page')
{
  check('parseAvailability keeps every row it validates', () => {
    const table = catalog.parseAvailability(pricingFixture)
    assert.ok(table !== undefined)
    assert.equal(table.rows.length, 15)
    const planIds = new Set(table.rows.flatMap((row) => Object.keys(row.availability)))
    for (const planId of ['individual-goat', 'individual-max', 'teams-pro']) assert.ok(planIds.has(planId), planId)
    assert.equal(table.rows.filter((row) => row.availability['individual-goat'] === true).length, 12)
    assert.equal(table.rows.filter((row) => row.deprecated === true).length, 2)
  })
  check('parsePlanLevel reads the overview table and unescapes the dollars the JSX doubles', () => {
    const rows = catalog.parsePlanLevel(pricingFixture)
    assert.equal(rows.length, 8)
    const byLabel = new Map(rows.map((row) => [row.label, row]))
    assert.deepEqual(byLabel.get('GOAT'), { label: 'GOAT', price: '$10', credits: '$70', usageText: '~75K requests', requests: 75_000 })
    assert.equal(byLabel.get('Go').credits, '$10')
    assert.equal(byLabel.get('Max 20×').credits, '$300')
    assert.equal(byLabel.get('Provider').usageText, 'Provider API access')
    // The two overview tables live in two records; both must be found.
    assert.equal(byLabel.get('Team Pro').price, '$40')
    assert.equal(byLabel.get('Enterprise').price, '$5,000+')
  })
  check('parseApproxCount only answers when the page actually published a count', () => {
    assert.equal(catalog.parseApproxCount('~75K requests'), 75_000)
    assert.equal(catalog.parseApproxCount('~9K requests'), 9_000)
    assert.equal(catalog.parseApproxCount('~230K requests'), 230_000)
    assert.equal(catalog.parseApproxCount('~1.5M requests'), 1_500_000)
    assert.equal(catalog.parseApproxCount('~35K requests'), 35_000)
    assert.equal(catalog.parseApproxCount('Provider API access'), undefined)
    assert.equal(catalog.parseApproxCount('Custom'), undefined)
    assert.equal(catalog.parseApproxCount(''), undefined)
  })
  check('parsePricingCatalog joins the availability table with the overview table', () => {
    const parsed = catalog.parsePricingCatalog(pricingFixture)
    assert.equal(parsed.error, undefined)
    assert.equal(parsed.models.length, 15)
    assert.equal(parsed.planLevel.length, 8)
    const flash = parsed.models.find((model) => model.id === 'deepseek-v4.1-flash')
    assert.ok(flash.availableIn.includes('individual-goat'))
    assert.ok(!parsed.models.find((model) => model.id === 'claude-opus-5').availableIn.includes('individual-goat'))
    assert.equal(parsed.models.find((model) => model.id === 'claude-sonnet-4-5').deprecated, true)
    // `all` is not a plan id: it must never leak into the availability list.
    assert.ok(!flash.availableIn.includes('all'))
  })
  check('parsePlanCatalog attaches the official model id so a configured model can be matched', () => {
    const withAvailability = catalog.parsePlanCatalog('individual-goat', goatFixture, { now: NOW, availability: catalog.parsePricingCatalog(pricingFixture).models }).entry
    const flash = withAvailability.models.find((model) => model.key === 'deepseek-v4-1-flash')
    assert.equal(flash.modelId, 'deepseek-v4.1-flash')
    assert.equal(withAvailability.publishedModels, 51)
    assert.equal(withAvailability.availableModels, 56)
    // Models the official table skipped are listed with no numbers -- never with a 0.
    const extras = withAvailability.models.filter((model) => model.source === 'availability-only')
    assert.deepEqual(extras.map((model) => model.name), ['GLM-5.1', 'Kimi K2.6', 'Tencent Hy4 Preview'])
    for (const model of extras) {
      assert.equal(model.monthly, undefined)
      assert.equal(model.fiveHour, undefined)
      assert.equal(model.week, undefined)
      assert.equal(model.free, false)
      assert.equal(typeof model.modelId, 'string')
    }
    // A model the vendor gives away is not "unpriced": it is Free, and it says so.
    const free = withAvailability.models.filter((model) => model.source === 'free')
    assert.deepEqual(free.map((model) => model.name), ['Ling 3.0 Flash Sante', 'Space Bunny Alpha'])
    for (const model of free) {
      assert.equal(model.free, true)
      assert.equal(model.monthly, undefined, 'Free must not be encoded as a number')
      assert.equal(typeof model.modelId, 'string')
    }
  })
  check('a model the plan page skipped is priced from the pricing calculator, by provider shape', () => {
    // The plan page enumerates 51 models; the pricing page's calculator carries the rest.
    // The vendor derives a missing request shape from the provider — MiniMax bills 125
    // output tokens, an unmapped provider falls back to 200 — and that difference is
    // what makes this check discriminating: both models share one $70 allowance and one
    // set of rates, so only a real provider lookup can produce two different counts.
    const rates = { inputCost: 0.3, outputCost: 1.2, cacheReadCost: 0.03 }
    const planAllowanceUsd = { go: 10, goat: 70, pro: 80 }
    const pricingText = [
      `2f:["$","$L4f",null,{"rows":${JSON.stringify([
        { id: 'MiniMaxAI/MiniMax-M2.5', name: 'MiniMax M2.5', availability: { 'individual-goat': true } },
        { id: 'unknown/x', name: 'Unknown X', availability: { 'individual-goat': true } },
      ])}}]`,
      `2a:["$","$L4e",null,{"models":${JSON.stringify([
        { id: 'minimax-m2-5', name: 'MiniMax M2.5', provider: 'MiniMax', ...rates, planAllowanceUsd },
        { id: 'x', name: 'Unknown X', provider: 'Unmapped', ...rates, planAllowanceUsd },
      ])}}]`,
    ].join('\n')
    const availability = catalog.parsePricingCatalog(pricingText).models
    const entry = catalog.parsePlanCatalog('individual-goat', goatFixture, { now: NOW, availability }).entry
    const derived = entry.models.filter((model) => model.source === 'derived')
    assert.deepEqual(derived.map((model) => model.name), ['MiniMax M2.5', 'Unknown X'])
    const [minimax, unknown] = derived
    assert.equal(minimax.shape.outputTokens, 125)
    assert.equal(unknown.shape.outputTokens, 200)
    assert.equal(minimax.shapeSource, 'derived-from-provider')
    assert.equal(catalog.formatCount(minimax.monthly), '37,000')
    assert.equal(catalog.formatCount(unknown.monthly), '35,400')
    // Derived figures are recomputable too: the inputs are stored with them.
    assert.equal(catalog.computeAllowance(minimax, entry.fractions, NOW).monthly, minimax.monthly)
    assert.equal(entry.availableModels, 53)
  })
  check('parsePlanCatalog carries the plan identity and the window basis', () => {
    const entry = catalog.parsePlanCatalog('individual-goat', goatFixture, { now: NOW }).entry
    assert.equal(entry.planId, 'individual-goat')
    assert.equal(entry.planName, 'GOAT')
    assert.equal(entry.docUrl, GOAT_URL)
    assert.equal(entry.inferredFrom, undefined)
    assert.deepEqual(entry.fractions, { fiveHourFraction: 0.2, weeklyFraction: 0.5 })
    assert.equal(entry.basis.inputTokens, 800)
    assert.equal(entry.basis.cacheReadTokens, 50_000)
    // The class the docs publish is `individual-ultra` sharing Max's page: it must say so.
    assert.equal(catalog.parsePlanCatalog('individual-ultra', goatFixture, { now: NOW }).entry.inferredFrom, 'Max')
  })
}

/* ------------------------------------------------------- layout drift */

console.log('a site redesign must fail loudly, never silently')
{
  const damaged = [
    ['rows deleted', () => editedEstimates((props) => { delete props.rows })],
    ['fiveHourFraction turned into a string', () => editedEstimates((props) => { props.fiveHourFraction = '0.2' })],
    ['an empty rows array', () => editedEstimates((props) => { props.rows = [] })],
  ]
  for (const [what, build] of damaged) {
    check(`a GOAT table with ${what} reports PARSE_MISMATCH instead of throwing`, () => {
      let result
      assert.doesNotThrow(() => { result = catalog.parsePlanCatalog('individual-goat', build(), { now: NOW }) })
      assert.equal(result.entry, undefined)
      assert.equal(result.error?.code, 'PARSE_MISMATCH')
      assert.ok(typeof result.error.message === 'string' && result.error.message.length > 0)
    })
  }
  check('a page with no table at all reports PARSE_MISMATCH', () => {
    for (const text of ['', '<html><body>maintenance</body></html>', '1:["$","div",null,{}]']) {
      let result
      assert.doesNotThrow(() => { result = catalog.parsePlanCatalog('individual-goat', text, { now: NOW }) })
      assert.equal(result.error?.code, 'PARSE_MISMATCH', JSON.stringify(text))
    }
  })
  check('a body where only the field names survived is diagnosed as a split record', () => {
    // Nothing parsed at all, while the table's own field names are plainly in the
    // body: the delivery was cut, the page was not redesigned. That distinction is
    // the difference between "wait for a fix" and "the site changed".
    const halfWritten = rewriteRecord(goatFixture, isEstimates, ({ line }) => line.slice(0, 400))
    const clippedObject = '1c:["$","$L1c",null,{"budgetUsd":'
    for (const text of [halfWritten, clippedObject]) {
      assert.equal(catalog.parseEstimates(text), undefined)
      let result
      assert.doesNotThrow(() => { result = catalog.parsePlanCatalog('individual-goat', text, { now: NOW }) })
      assert.equal(result.error?.code, 'PARSE_SPLIT_RECORD', text.slice(0, 40))
    }
  })
  check('a record the site split over a line break is recovered, not merely diagnosed', () => {
    const split = fixtureText('plan-goat.split-record.rsc.txt')
    assert.equal(records(split).length, 0, 'the split fixture still parses line by line')
    const recovered = catalog.parseEstimates(split)
    assert.equal(recovered?.rows.length, 51)
    assert.deepEqual(recovered.rows, catalog.parseEstimates(goatFixture).rows)
    const entry = catalog.parsePlanCatalog('individual-goat', split, { now: NOW }).entry
    assert.equal(entry.models.length, 51)
    const flash = entry.models.find((model) => model.key === 'deepseek-v4-1-flash')
    assert.equal(catalog.formatCount(flash.monthly), '154,000')
    assert.equal(catalog.formatCount(flash.week), '76,900')
    assert.equal(catalog.formatCount(flash.fiveHour), '30,800')
  })
  check('the non-record lines a stream interleaves are skipped, not parsed and not losses', () => {
    const noisy = fixtureText('plan-goat.noisy-lines.rsc.txt')
    assert.deepEqual(catalog.parseFlightRecords(noisy), catalog.parseFlightRecords(goatFixture))
    assert.deepEqual(catalog.parseEstimates(noisy).rows, catalog.parseEstimates(goatFixture).rows)
    assert.deepEqual(catalog.parsePlanCatalog('individual-goat', noisy, { now: NOW }), catalog.parsePlanCatalog('individual-goat', goatFixture, { now: NOW }))
  })
  check('a whole HTML page whose RSC header was eaten still yields the same table', () => {
    // A proxy or CDN can drop the `RSC: 1` header, leaving us with the full page.
    // The table is in there, chunked by Next.js -- that must not be a blind spot.
    const page = fixtureText('plan-goat.chunked.html.txt')
    assert.equal(records(page).length, 0, 'the page fixture parses line by line')
    const recordLine = goatFixture.split('\n').find((line) => line.includes('"budgetUsd"'))
    const decoded = catalog.decodeNextFlight(page)
    assert.ok(decoded.includes(recordLine), 'the chunks were not rejoined byte for byte')
    assert.deepEqual(catalog.parseEstimates(decoded).rows, catalog.parseEstimates(goatFixture).rows)
    const entry = catalog.parsePlanCatalog('individual-goat', page, { now: NOW }).entry
    assert.equal(entry.models.length, 51)
    const flash = entry.models.find((model) => model.key === 'deepseek-v4-1-flash')
    assert.equal(catalog.formatCount(flash.monthly), '154,000')
    assert.equal(catalog.formatCount(flash.fiveHour), '30,800')
  })
  check('plans the official site never published say so by name', () => {
    for (const planId of ['teams-pro', 'individual-provider', 'individual-never-heard-of-it']) {
      let result
      assert.doesNotThrow(() => { result = catalog.parsePlanCatalog(planId, goatFixture, { now: NOW }) })
      assert.equal(result.error?.code, 'PLAN_NOT_PUBLISHED', planId)
      assert.match(result.error.message, new RegExp(planId))
    }
  })
  check('a pricing page that lost both of its tables reports PARSE_MISMATCH', () => {
    for (const text of ['', '<html><body>maintenance</body></html>', '1:["$","div",null,{}]']) {
      let result
      assert.doesNotThrow(() => { result = catalog.parsePricingCatalog(text) })
      assert.equal(result.error?.code, 'PARSE_MISMATCH', JSON.stringify(text))
    }
  })
  check('parseAvailability refuses a table where one row lost its availability map', () => {
    const broken = rewriteRecord(pricingFixture, isAvailability, ({ id, value, props }) => {
      delete props.rows[3].availability
      return `${id}:${JSON.stringify(value)}`
    })
    assert.equal(catalog.parseAvailability(broken), undefined)
  })
  check('the overview table is only accepted under the header that names it', () => {
    const renamed = rewriteRecord(pricingFixture, (props) => JSON.stringify(props).includes('Included LLM Usage'), ({ id, value }) => `${id}:${JSON.stringify(value).replace('Included LLM Usage', 'Monthly usage')}`)
    assert.deepEqual(catalog.parsePlanLevel(renamed).map((row) => row.label), ['Team Pro', 'Enterprise'])
  })
}

/* ------------------------------------------------------ change detection */

console.log('change detection: HEAD first, GET only when the ETag moved')
const changeFile = tmpFile('change.json')
{
  const firstFetch = docsFetch()
  const first = await sync(changeFile, firstFetch, NOW)

  await checkAsync('the first sync downloads both pages and stores one validator per URL', async () => {
    assert.equal(first.changed, true)
    assert.deepEqual(firstFetch.pricing(), ['HEAD', 'GET'])
    assert.deepEqual(firstFetch.plan(), ['HEAD', 'GET'])
    assert.equal(first.catalog.validators[catalog.PRICING_DOC_URL].etag, '"pricing-v1"')
    assert.equal(first.catalog.validators[GOAT_URL].etag, '"goat-v1"')
    assert.match(first.catalog.validators[GOAT_URL].digest, /^[0-9a-f]{64}$/)
    assert.equal(first.catalog.checkedAt, iso(NOW))
    assert.equal(first.catalog.updatedAt, iso(NOW))
    assert.equal(first.catalog.fetchMode, 'etag')
    assert.equal(first.catalog.plans['individual-goat'].models.length, 56)
    assert.equal(first.catalog.plans['individual-goat'].publishedModels, 51)
    assert.equal(first.catalog.pricing.models.length, 15)
    assert.equal(first.catalog.planLevel.rows.length, 8)
  })
  await checkAsync('every request asks for the flight stream and never for a conditional response', async () => {
    for (const call of firstFetch.calls) assert.deepEqual(call.headers, { RSC: '1' }, call.url)
    assert.equal(firstFetch.calls.filter((call) => Object.keys(call.headers).some((name) => name.toLowerCase().startsWith('if-'))).length, 0)
  })

  const sameEtag = docsFetch()
  const second = await sync(changeFile, sameEtag, NOW + HOUR)
  await checkAsync('an unchanged ETag costs one HEAD per page: zero GETs, no body read, nothing re-parsed', async () => {
    assert.deepEqual(sameEtag.pricing(), ['HEAD'])
    assert.deepEqual(sameEtag.plan(), ['HEAD'])
    assert.equal(sameEtag.gets(), 0)
    assert.equal(second.changed, false)
    assert.equal(second.catalog.updatedAt, first.catalog.updatedAt)
    assert.equal(second.catalog.checkedAt, iso(NOW + HOUR))
    assert.equal(second.catalog.plans['individual-goat'].fetchedAt, iso(NOW))
  })

  const movedEtag = docsFetch({ goat: { head: { etag: '"goat-v2"' }, get: { etag: '"goat-v2"', body: HTML_PROLOGUE + goatFixture } } })
  const third = await sync(changeFile, movedEtag, NOW + 2 * HOUR)
  await checkAsync('a moved ETag whose body digest is identical is still "unchanged": one GET, no re-parse', async () => {
    assert.deepEqual(movedEtag.pricing(), ['HEAD'])
    assert.deepEqual(movedEtag.plan(), ['HEAD', 'GET'])
    assert.equal(movedEtag.gets(), 1)
    assert.equal(third.changed, false)
    assert.equal(third.catalog.updatedAt, first.catalog.updatedAt)
    assert.equal(third.catalog.plans['individual-goat'].fetchedAt, iso(NOW), 'the entry was re-parsed even though the body was identical')
    assert.equal(third.catalog.planLevel.fetchedAt, iso(NOW))
    // The validator is refreshed, so the next check can go back to the 0-byte probe.
    assert.equal(third.catalog.validators[GOAT_URL].etag, '"goat-v2"')
    assert.equal(third.catalog.validators[GOAT_URL].digest, first.catalog.validators[GOAT_URL].digest)
  })

  const newBody = editedEstimates((props) => { props.rows.find((row) => row.name === 'DeepSeek V4.1 Flash').budgetUsd = 120 })
  const rewritten = docsFetch({ goat: { head: { etag: '"goat-v3"' }, get: { etag: '"goat-v3"', body: HTML_PROLOGUE + newBody } } })
  const fourth = await sync(changeFile, rewritten, NOW + 3 * HOUR)
  await checkAsync('a changed body replaces the entry and moves updatedAt', async () => {
    assert.equal(fourth.changed, true)
    assert.equal(fourth.catalog.updatedAt, iso(NOW + 3 * HOUR))
    assert.equal(fourth.catalog.plans['individual-goat'].fetchedAt, iso(NOW + 3 * HOUR))
    const flash = fourth.catalog.plans['individual-goat'].models.find((model) => model.key === 'deepseek-v4-1-flash')
    assert.equal(catalog.formatCount(flash.monthly), '308,000')
    // The pricing page did not move, so it was not re-fetched or re-parsed.
    assert.equal(fourth.catalog.planLevel.fetchedAt, iso(NOW))
  })

  const noEtag = docsFetch({
    goat: { head: { status: 200, etag: undefined }, get: { etag: '"goat-v4"', body: HTML_PROLOGUE + newBody } },
    pricing: { head: { status: 200, etag: undefined } },
  })
  const fifth = await sync(changeFile, noEtag, NOW + 4 * HOUR)
  await checkAsync('a HEAD that carries no ETag falls back to GET + digest without failing the page', async () => {
    assert.deepEqual(noEtag.pricing(), ['HEAD', 'GET'])
    assert.deepEqual(noEtag.plan(), ['HEAD', 'GET'])
    assert.deepEqual(fifth.failures, [])
    assert.equal(fifth.changed, false)
    assert.equal(fifth.catalog.fetchMode, 'hash')
    assert.equal(fifth.catalog.updatedAt, iso(NOW + 3 * HOUR))
  })

  const refusesHead = docsFetch({ goat: { head: { status: 405 }, get: { body: HTML_PROLOGUE + newBody } }, pricing: { head: { status: 405 } } })
  const sixth = await sync(changeFile, refusesHead, NOW + 5 * HOUR)
  await checkAsync('a HEAD the server refuses (405) falls back to GET instead of failing the page', async () => {
    assert.deepEqual(refusesHead.pricing(), ['HEAD', 'GET'])
    assert.deepEqual(refusesHead.plan(), ['HEAD', 'GET'])
    assert.deepEqual(sixth.failures, [])
    assert.equal(sixth.changed, false)
    assert.equal(sixth.catalog.fetchMode, 'hash')
  })
}

/* ---------------------------------------------------- failure handling */

console.log('a failed refresh never empties the catalog')
const failureFile = tmpFile('failure.json')
{
  const baselineFetch = docsFetch()
  const baseline = await sync(failureFile, baselineFetch, NOW)
  const baselineFlash = baseline.catalog.plans['individual-goat'].models.find((model) => model.key === 'deepseek-v4-1-flash')

  const down = docsFetch({ goat: { head: { etag: '"goat-down"' }, get: new Error('socket hang up') } })
  const afterDown = await sync(failureFile, down, NOW + HOUR)
  await checkAsync('a GET that dies keeps every number from the last good read', async () => {
    assert.equal(afterDown.changed, false)
    const flash = afterDown.catalog.plans['individual-goat'].models.find((model) => model.key === 'deepseek-v4-1-flash')
    assert.deepEqual(numbersOf(flash), numbersOf(baselineFlash))
    assert.equal(afterDown.catalog.plans['individual-goat'].fetchedAt, iso(NOW))
    assert.equal(afterDown.catalog.updatedAt, iso(NOW))
  })
  await checkAsync('and the failure is reported as CATALOG_NETWORK with the page that failed', async () => {
    assert.equal(afterDown.failures.length, 1)
    assert.equal(afterDown.failures[0].code, 'CATALOG_NETWORK')
    assert.equal(afterDown.failures[0].url, GOAT_URL)
    assert.match(afterDown.failures[0].message, /socket hang up/)
    assert.equal(afterDown.catalog.failures[0].code, 'CATALOG_NETWORK')
  })
  check('the cache on disk is still a whole, parseable catalog with the old numbers', () => {
    const onDisk = JSON.parse(readFileSync(failureFile, 'utf8'))
    assert.equal(onDisk.kind, catalog.CATALOG_KIND)
    assert.equal(onDisk.version, catalog.CATALOG_VERSION)
    assert.equal(onDisk.schema, catalog.CATALOG_SCHEMA)
    assert.equal(onDisk.validators[GOAT_URL].etag, '"goat-v1"')
    const reread = catalog.readCatalogCache({ file: failureFile })
    assert.equal(numbersOf(reread.plans['individual-goat'].models.find((model) => model.key === 'deepseek-v4-1-flash')).monthly, baselineFlash.monthly)
  })

  const redesigned = docsFetch({ goat: { head: { etag: '"goat-redesign"' }, get: { etag: '"goat-redesign"', body: '1:["$","div",null,{}]' } } })
  const afterRedesign = await sync(failureFile, redesigned, NOW + 2 * HOUR)
  await checkAsync('a page that stops parsing keeps the old entry and blames the redesign', async () => {
    assert.equal(afterRedesign.failures.length, 1)
    assert.equal(afterRedesign.failures[0].code, 'PARSE_MISMATCH')
    assert.equal(afterRedesign.failures[0].planId, 'individual-goat')
    assert.equal(afterRedesign.changed, false)
    const flash = afterRedesign.catalog.plans['individual-goat'].models.find((model) => model.key === 'deepseek-v4-1-flash')
    assert.deepEqual(numbersOf(flash), numbersOf(baselineFlash))
  })

  const recoveredBody = fixtureText('plan-goat.split-record.rsc.txt')
  const recovered = docsFetch({ goat: { head: { etag: '"goat-split"' }, get: { etag: '"goat-split"', body: recoveredBody } } })
  const afterRecovery = await sync(failureFile, recovered, NOW + 3 * HOUR)
  await checkAsync('a body whose record arrived split over a line is recovered and replaces the entry', async () => {
    assert.deepEqual(afterRecovery.failures, [])
    assert.equal(afterRecovery.changed, true)
    const entry = afterRecovery.catalog.plans['individual-goat']
    assert.equal(entry.models.length, 56)
    assert.equal(catalog.formatCount(entry.models.find((model) => model.key === 'deepseek-v4-1-flash').monthly), '154,000')
  })

  const unrecoverable = rewriteRecord(goatFixture, isEstimates, ({ line }) => line.replace(/"name":"([^"]{1})/, '"name":"$1\n'))
  const broken = docsFetch({ goat: { head: { etag: '"goat-broken"' }, get: { etag: '"goat-broken"', body: unrecoverable } } })
  const afterBroken = await sync(failureFile, broken, NOW + 4 * HOUR)
  await checkAsync('a body that cannot be recovered keeps the old entry and reports the split', async () => {
    assert.equal(afterBroken.changed, false)
    assert.equal(afterBroken.failures.length, 1)
    assert.equal(afterBroken.failures[0].code, 'PARSE_SPLIT_RECORD')
    const flash = afterBroken.catalog.plans['individual-goat'].models.find((model) => model.key === 'deepseek-v4-1-flash')
    assert.deepEqual(numbersOf(flash), numbersOf(baselineFlash))
  })

  const notFound = docsFetch({ goat: { head: { etag: '"goat-404"' }, get: { status: 404, body: 'not found' } } })
  const after404 = await sync(failureFile, notFound, NOW + 5 * HOUR)
  await checkAsync('a 404 is reported as CATALOG_HTTP_404 with its status and the URL it ended on', async () => {
    assert.equal(after404.failures.length, 1)
    assert.equal(after404.failures[0].code, 'CATALOG_HTTP_404')
    assert.equal(after404.failures[0].status, 404)
    assert.equal(after404.failures[0].finalUrl, GOAT_URL)
    assert.equal(after404.failures[0].url, GOAT_URL)
  })
  const serverError = docsFetch({ goat: { head: { etag: '"goat-500"' }, get: { status: 500, body: 'boom' } } })
  const after500 = await sync(failureFile, serverError, NOW + 6 * HOUR)
  await checkAsync('any other non-200 stays CATALOG_NETWORK with its status', async () => {
    assert.equal(after500.failures.length, 1)
    assert.equal(after500.failures[0].code, 'CATALOG_NETWORK')
    assert.equal(after500.failures[0].status, 500)
  })
}

/* ------------------------------- a failure must not become the new truth */

console.log('a page that failed to parse is not remembered as the current page')
const validatorFile = tmpFile('validator.json')
{
  const baseline = await sync(validatorFile, docsFetch(), NOW)
  const stored = (value) => JSON.stringify(JSON.parse(JSON.stringify(value)))
  const badBody = '1:["$","div",null,{}]' // HTTP 200 all the way: the table is simply gone
  const structural = docsFetch({ goat: { head: { etag: '"goat-bad"' }, get: { etag: '"goat-bad"', body: badBody } } })
  const firstBad = await sync(validatorFile, structural, NOW + HOUR)
  const secondBad = await sync(validatorFile, structural, NOW + 2 * HOUR)
  await checkAsync('a body that lost the table reports PARSE_MISMATCH on every round, not only the first', async () => {
    assert.equal(firstBad.failures[0]?.code, 'PARSE_MISMATCH')
    // If the failed round stored the body as a validator, the next round would see a
    // matching ETag and go silent -- the page would look "unchanged" forever.
    assert.equal(secondBad.failures[0]?.code, 'PARSE_MISMATCH')
    assert.equal(secondBad.changed, false)
    assert.equal(secondBad.catalog.validators[GOAT_URL].etag, '"goat-v1"', 'the unparsed body became the validator')
  })
  await checkAsync('and it never replaces the catalog with an empty one', async () => {
    assert.equal(Object.keys(secondBad.catalog.plans).length, 1)
    assert.equal(stored(secondBad.catalog.plans), stored(baseline.catalog.plans), 'the last good catalog was lost')
    assert.equal(stored(JSON.parse(readFileSync(validatorFile, 'utf8')).plans), stored(baseline.catalog.plans))
    assert.equal(secondBad.catalog.plans['individual-goat'].publishedModels, 51)
    assert.equal(secondBad.catalog.pricing.models.length, 15)
  })
  const parsesAgain = docsFetch({ goat: { head: { etag: '"goat-good"' }, get: { etag: '"goat-good"', body: HTML_PROLOGUE + goatFixture } } })
  const afterFix = await sync(validatorFile, parsesAgain, NOW + 3 * HOUR)
  await checkAsync('once the page parses again the failures clear and the entry is back', async () => {
    assert.deepEqual(afterFix.failures, [])
    assert.equal(afterFix.catalog.plans['individual-goat'].models.length, 56)
    assert.equal(catalog.formatCount(afterFix.catalog.plans['individual-goat'].models.find((model) => model.key === 'deepseek-v4-1-flash').monthly), '154,000')
  })
  const raisedBody = editedEstimates((props) => { props.rows.find((row) => row.name === 'DeepSeek V4.1 Flash').budgetUsd = 120 })
  const changedAgain = docsFetch({ goat: { head: { etag: '"goat-good-2"' }, get: { etag: '"goat-good-2"', body: HTML_PROLOGUE + raisedBody } } })
  const afterChange = await sync(validatorFile, changedAgain, NOW + 4 * HOUR)
  await checkAsync('and a real change hiding behind the failure is picked up again', async () => {
    assert.deepEqual(afterChange.failures, [])
    assert.equal(afterChange.changed, true)
    assert.equal(catalog.formatCount(afterChange.catalog.plans['individual-goat'].models.find((model) => model.key === 'deepseek-v4-1-flash').monthly), '308,000')
  })
}

/* ------------------------------------------------------ revalidation */

console.log('when to ask the docs again')
{
  const catalogAt = (checkedAt, extra = {}) => ({ kind: catalog.CATALOG_KIND, version: catalog.CATALOG_VERSION, schema: catalog.CATALOG_SCHEMA, checkedAt, plans: {}, failures: [], ...extra })
  check('no cache asks; a fresh check does not', () => {
    assert.equal(catalog.needsRevalidate({ catalog: undefined, now: NOW }), true)
    assert.equal(catalog.needsRevalidate({ catalog: catalogAt(iso(NOW)), now: NOW }), false)
    assert.equal(catalog.needsRevalidate({ catalog: catalogAt(iso(NOW - HOUR)), now: NOW }), false)
  })
  check('the TTL is the whole day the policy promises', () => {
    assert.equal(catalog.needsRevalidate({ catalog: catalogAt(iso(NOW - catalog.CATALOG_TTL_MS + 1000)), now: NOW }), false)
    assert.equal(catalog.needsRevalidate({ catalog: catalogAt(iso(NOW - catalog.CATALOG_TTL_MS)), now: NOW }), true)
    assert.equal(catalog.needsRevalidate({ catalog: catalogAt(iso(NOW - catalog.CATALOG_TTL_MS - 1)), now: NOW }), true)
  })
  check('after a failed round it waits the 6-hour floor instead of a whole day', () => {
    const failing = (hours) => catalogAt(iso(NOW - hours * HOUR), { failures: [{ code: 'CATALOG_NETWORK', url: GOAT_URL }] })
    assert.equal(catalog.needsRevalidate({ catalog: failing(7), now: NOW }), true)
    assert.equal(catalog.needsRevalidate({ catalog: failing(5.9), now: NOW }), false)
    // Without a failure the same 7 hours are still fresh: the floor only applies after a failure.
    assert.equal(catalog.needsRevalidate({ catalog: catalogAt(iso(NOW - 7 * HOUR)), now: NOW }), false)
  })
  check('an unreadable checkedAt asks again instead of assuming freshness', () => {
    assert.equal(catalog.needsRevalidate({ catalog: catalogAt('not a timestamp'), now: NOW }), true)
    assert.equal(catalog.needsRevalidate({ catalog: catalogAt(undefined), now: NOW }), true)
    assert.equal(catalog.needsRevalidate({ catalog: { failures: [] }, now: NOW }), true)
  })
  check('a plan the local copy has never carried asks immediately, without waiting for the TTL', () => {
    const fresh = catalogAt(iso(NOW), { plans: { 'individual-goat': { planId: 'individual-goat' } } })
    assert.equal(catalog.needsRevalidate({ catalog: fresh, planId: 'individual-goat', now: NOW }), false)
    assert.equal(catalog.needsRevalidate({ catalog: fresh, planId: 'individual-max', now: NOW }), true)
    assert.equal(catalog.needsRevalidate({ catalog: fresh, now: NOW }), false)
  })
}

/* ------------------------------------------------------------- on disk */

console.log('what lands on disk')
{
  check('writeCatalogAtomic replaces the file in place and leaves no temp file behind', () => {
    const dir = tmpFile('atomic')
    const file = path.join(dir, 'catalog.json')
    catalog.writeCatalogAtomic({ kind: catalog.CATALOG_KIND, version: 1, schema: 1, plans: {} }, { file })
    catalog.writeCatalogAtomic({ kind: catalog.CATALOG_KIND, version: 1, schema: 1, plans: { 'individual-goat': 1 } }, { file })
    assert.deepEqual(readdirSync(dir), ['catalog.json'])
    assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')).plans, { 'individual-goat': 1 })
  })
  check('on POSIX the cache keeps the private 0700/0600 modes', () => {
    const dir = tmpFile('modes')
    const file = path.join(dir, 'catalog.json')
    catalog.writeCatalogAtomic({ kind: catalog.CATALOG_KIND, version: 1, schema: 1 }, { file })
    if (process.platform === 'win32') {
      // Windows ignores POSIX mode bits; the mode arguments still matter on the other platforms.
      assert.ok(statSync(dir).isDirectory())
      assert.ok(statSync(file).isFile())
      return
    }
    assert.equal(statSync(dir).mode & 0o777, 0o700)
    assert.equal(statSync(file).mode & 0o777, 0o600)
  })
  await checkAsync('the cache stores parsed numbers only -- never the page body it came from', async () => {
    const file = tmpFile('hygiene.json')
    await sync(file, docsFetch(), NOW)
    const raw = readFileSync(file, 'utf8')
    for (const marker of ['<html', '<script', 'self.__next_f', '__next_f.push', '"$L']) {
      assert.ok(!raw.includes(marker), `the cache stored upstream markup: ${marker}`)
    }
    assert.ok(raw.includes('individual-goat'))
    assert.ok(raw.includes('deepseek-v4.1-flash'))
  })
  check('a corrupt or foreign cache file is ignored, never crashed on', () => {
    const file = tmpFile('corrupt.json')
    for (const body of ['{ not json', 'null', '[]', '{"kind":"something-else"}']) {
      writeFileSync(file, body, 'utf8')
      assert.equal(catalog.readCatalogCache({ file }), undefined, body)
    }
    for (const parsed of [{ kind: catalog.CATALOG_KIND, version: 2, schema: 1 }, { kind: catalog.CATALOG_KIND, version: 1, schema: 99 }]) {
      writeFileSync(file, JSON.stringify(parsed), 'utf8')
      assert.equal(catalog.readCatalogCache({ file }), undefined, JSON.stringify(parsed))
    }
    const missing = tmpFile('nothing-here.json')
    assert.equal(catalog.readCatalogCache({ file: missing }), undefined)
    assert.equal(catalog.readCatalogSeed({ file: missing }), undefined)
  })
  await checkAsync('a cache this module wrote is a cache this module reads', async () => {
    const file = tmpFile('roundtrip.json')
    const synced = await sync(file, docsFetch(), NOW)
    const reread = catalog.readCatalogCache({ file })
    assert.equal(reread.kind, synced.catalog.kind)
    assert.equal(reread.schema, synced.catalog.schema)
    assert.equal(reread.checkedAt, synced.catalog.checkedAt)
    assert.deepEqual(Object.keys(reread.plans), ['individual-goat'])
    assert.equal(reread.validators[GOAT_URL].etag, '"goat-v1"')
    assert.equal(reread.planLevel.rows.length, 8)
  })
}

/* --------------------------------------------------------------- view */

console.log('the view the panel renders')
const viewFile = tmpFile('view.json')
{
  const synced = await sync(viewFile, docsFetch(), NOW)
  const syncedCatalog = synced.catalog
  const view = (extra = {}) => catalog.catalogView({
    catalog: syncedCatalog,
    bundled: false,
    planId: 'individual-goat',
    configuredModels: ['deepseek/deepseek-v4.1-flash', 'kimi-k2.6'],
    now: NOW + HOUR,
    ...extra,
  })

  check('the plan identity, the window basis and the coverage come back with the numbers', () => {
    const result = view()
    assert.equal(result.origin, 'network')
    assert.equal(result.verified, true)
    assert.equal(result.neverSynced, false)
    assert.equal(result.stale, false)
    assert.equal(result.planId, 'individual-goat')
    assert.equal(result.planName, 'GOAT')
    assert.equal(result.docUrl, GOAT_URL)
    assert.deepEqual(result.windows, { fiveHourFraction: 0.2, weeklyFraction: 0.5 })
    assert.equal(result.basis.inputTokens, 800)
    assert.deepEqual(result.coverage, { published: 51, derived: 0, available: 56 })
    assert.equal(result.models.length, 56)
  })
  check('your configured models come first, then the priced ones, then the rest by name', () => {
    const models = view().models
    assert.equal(models[0].key, 'deepseek-v4-1-flash')
    assert.equal(models[0].configured, true)
    assert.equal(models[1].key, 'kimi-k2-6')
    assert.equal(models[1].configured, true)
    assert.equal(models[1].estimated, false)
    const rank = (model) => (model.configured ? 0 : model.estimated ? 1 : 2)
    for (let index = 1; index < models.length; index += 1) {
      const previous = models[index - 1]
      const current = models[index]
      assert.ok(rank(previous) <= rank(current), `${previous.name} (rank ${rank(previous)}) came before ${current.name} (rank ${rank(current)})`)
      if (rank(previous) === rank(current)) assert.ok(previous.name <= current.name, `${previous.name} came before ${current.name}`)
    }
  })
  check('a model the docs never priced shows no numbers, not zero', () => {
    const unestimated = view().models.filter((model) => !model.estimated)
    assert.equal(unestimated.length, 5)
    const priced = unestimated.filter((model) => model.free !== true)
    for (const model of priced) {
      assert.equal(model.monthly, undefined, `${model.name} invented a monthly count`)
      assert.equal(model.fiveHour, undefined)
      assert.equal(model.week, undefined)
      assert.equal(model.free, false)
      assert.equal(catalog.formatCount(model.monthly), '—')
    }
    // Kimi K2.6 leads because it is one of the configured models; then the rest by name.
    assert.deepEqual(priced.map((model) => model.name), ['Kimi K2.6', 'GLM-5.1', 'Tencent Hy4 Preview'])
    // The other two are free, and Free is not the same statement as "no figure".
    const free = unestimated.filter((model) => model.free === true)
    assert.deepEqual(free.map((model) => model.name), ['Ling 3.0 Flash Sante', 'Space Bunny Alpha'])
  })
  check('a configured model is matched through normalizeModelKey, whatever spelling the config uses', () => {
    const result = catalog.catalogView({ catalog: syncedCatalog, bundled: false, planId: 'individual-goat', configuredModels: ['DeepSeek V4.1 Flash', 'Kimi K2.6 (latest)'], now: NOW + HOUR })
    assert.deepEqual(result.configuredModels, ['deepseek-v4-1-flash', 'kimi-k2-6'])
    assert.deepEqual(result.models.filter((model) => model.configured).map((model) => model.key), ['deepseek-v4-1-flash', 'kimi-k2-6'])
  })
  /** The site prices some models at 0 and then shows "Free"; the same row must survive unedited. */
  const freeEntry = () => catalog.parsePlanCatalog('individual-goat', editedEstimates((props) => {
    const row = props.rows.find((candidate) => candidate.name === 'DeepSeek V4.1 Flash')
    row.rates = { inputCost: 0, outputCost: 0, cacheReadCost: 0 }
    delete row.timeOfDay
  }), { now: NOW }).entry
  const viewedFree = (entry) => catalog.catalogView({
    catalog: { kind: catalog.CATALOG_KIND, version: catalog.CATALOG_VERSION, schema: catalog.CATALOG_SCHEMA, checkedAt: iso(NOW), updatedAt: iso(NOW), plans: { 'individual-goat': entry }, failures: [] },
    bundled: false,
    planId: 'individual-goat',
    now: NOW,
  }).models.find((model) => model.key === 'deepseek-v4-1-flash')

  check('a free model is Free, not a made-up number', () => {
    const entry = freeEntry()
    assert.equal(entry.models.find((model) => model.key === 'deepseek-v4-1-flash').free, true)
    const free = viewedFree(entry)
    assert.equal(free.free, true)
    assert.equal(Number.isFinite(free.monthly), false)
    assert.equal(catalog.formatCount(free.monthly), 'Free')
  })
  check('a free row survives the JSON round-trip as free:true plus a null count', () => {
    // JSON has no Infinity: the stored/transmitted form is `monthly: null` with
    // `free: true`, and every consumer must branch on `free` rather than on the number.
    const stored = JSON.parse(JSON.stringify(freeEntry()))
    const model = stored.models.find((candidate) => candidate.key === 'deepseek-v4-1-flash')
    assert.equal(model.free, true)
    assert.equal(model.monthly, null)
    assert.equal(viewedFree(stored).free, true)
  })
  check('bundled data is never presented as verified, and it says why', () => {
    const result = view({ bundled: true })
    assert.equal(result.origin, 'bundled')
    assert.equal(result.verified, false)
    assert.ok(result.warnings.includes('catalog-bundled-baseline'))
  })
  check('a plan with no per-model page still gets its name and its plan-level headline', () => {
    // Teams publishes one number, not a table: the overview row is what it has,
    // and it is also the only place this plan's display name comes from.
    const result = view({ planId: 'teams-pro' })
    assert.deepEqual(result.models, [])
    assert.deepEqual(result.coverage, { published: 0, derived: 0, available: 0 })
    assert.equal(result.planName, 'Team Pro')
    assert.equal(result.docUrl, null)
    assert.equal(result.planLevel.label, 'Team Pro')
    assert.equal(result.planLevel.requests, 35_000)
    assert.ok(result.warnings.includes('catalog-plan-not-listed:teams-pro'))
  })
  check('the failures of the last round are surfaced in the view', () => {
    const result = view({ catalog: { ...syncedCatalog, failures: [{ code: 'CATALOG_NETWORK', url: GOAT_URL, at: iso(NOW) }] } })
    assert.equal(result.failures.length, 1)
    assert.equal(result.failures[0].code, 'CATALOG_NETWORK')
  })
  check('freshness is judged against the injected clock, and an empty catalog says it never synced', () => {
    assert.equal(view({ now: NOW + HOUR }).stale, false)
    assert.equal(view({ now: NOW + 25 * HOUR }).stale, true)
    const blank = catalog.catalogView({ catalog: undefined, bundled: true, planId: 'individual-goat', now: NOW })
    assert.equal(blank.neverSynced, true)
    assert.equal(blank.stale, true)
    assert.equal(blank.origin, 'bundled')
    assert.equal(blank.verified, false)
    assert.deepEqual(blank.models, [])
    assert.equal(blank.updatedAt, null)
  })
  check('the plan-level overview row is joined onto the plan entry', () => {
    const result = view()
    assert.deepEqual(result.planLevel, {
      label: 'GOAT',
      credits: '$70',
      requestsText: '~75K requests',
      requests: 75_000,
      sourceUrl: catalog.PRICING_DOC_URL,
    })
  })
}

/* ------------------------------------------------------- resolveCatalogView */

console.log('resolveCatalogView is a local read')
{
  check('with no cache it serves the bundled baseline and says so', () => {
    const home = tmpFile('empty-home')
    mkdirSync(home, { recursive: true })
    const result = catalog.resolveCatalogView({ home, dshHome: path.join(home, '.dsh'), env: {}, planId: 'individual-goat', now: NOW, configuredModels: ['deepseek/deepseek-v4.1-flash'] })
    assert.equal(result.origin, 'bundled')
    assert.equal(result.verified, false)
    assert.equal(result.neverSynced, false)
    assert.ok(result.warnings.includes('catalog-bundled-baseline'))
    assert.equal(result.planName, 'GOAT')
    assert.ok(result.models.length > 0, 'the bundled baseline carries no models for individual-goat')
    assert.ok(result.coverage.published > 0)
    assert.ok(result.coverage.available >= result.coverage.published)
    assert.equal(result.models.find((model) => model.key === 'deepseek-v4-1-flash').configured, true)
  })
  check('with a cache it reports network origin and never touches fetch', () => {
    const file = tmpFile('resolve.json')
    catalog.writeCatalogAtomic(catalog.readCatalogCache({ file: viewFile }), { file })
    const realFetch = globalThis.fetch
    let calls = 0
    globalThis.fetch = () => {
      calls += 1
      throw new Error('resolveCatalogView must not reach the network')
    }
    try {
      const result = catalog.resolveCatalogView({ file, env: {}, planId: 'individual-goat', now: NOW + HOUR, configuredModels: ['kimi-k2.6'] })
      assert.equal(result.origin, 'network')
      assert.equal(result.verified, true)
      assert.equal(result.models.length, 56)
      assert.equal(result.models.find((model) => model.key === 'kimi-k2-6').configured, true)
    } finally {
      globalThis.fetch = realFetch
    }
    assert.equal(calls, 0)
  })
  check('and it hands back a plain view, not a promise', () => {
    const file = tmpFile('resolve-sync.json')
    catalog.writeCatalogAtomic(catalog.readCatalogCache({ file: viewFile }), { file })
    const result = catalog.resolveCatalogView({ file, env: {}, planId: 'individual-goat', now: NOW })
    assert.ok(!(result instanceof Promise))
    assert.equal(typeof result.then, 'undefined')
    assert.equal(result.planName, 'GOAT')
  })
}

/* -------------------------------------------------- the bundled baseline */

console.log('the bundled baseline')
{
  check('every model in the seed recomputes from the inputs the seed itself stores', () => {
    // The seed is what an offline or first-run install shows, so it must be
    // self-consistent: whatever formula the panel uses to explain a number has to
    // reproduce that number from `budgetUsd` + `rates` + `shape` alone.
    const seed = catalog.readCatalogSeed()
    assert.ok(seed !== undefined, 'catalog.seed.json is missing or unreadable')
    assert.equal(seed.kind, catalog.CATALOG_KIND)
    assert.equal(seed.version, catalog.CATALOG_VERSION)
    assert.equal(seed.schema, catalog.CATALOG_SCHEMA)
    assert.ok(Object.keys(seed.plans).length > 0)
    const finite = (value) => (value === null ? Number.POSITIVE_INFINITY : value)
    let recomputed = 0
    for (const [planId, entry] of Object.entries(seed.plans)) {
      assert.ok(entry.fractions !== undefined, `${planId} carries no window fractions`)
      for (const model of entry.models) {
        if (model.source !== 'plan-doc') continue
        const allowance = catalog.computeAllowance(
          { budgetUsd: model.budgetUsd, rates: model.rates, shape: model.shape ?? entry.basis },
          entry.fractions,
          NOW,
        )
        assert.equal(allowance.monthly, finite(model.monthly), `${planId}/${model.key} monthly`)
        assert.equal(allowance.fiveHour, finite(model.fiveHour), `${planId}/${model.key} fiveHour`)
        assert.equal(allowance.week, finite(model.week), `${planId}/${model.key} week`)
        assert.equal(allowance.free, model.free === true, `${planId}/${model.key} free`)
        recomputed += 1
      }
    }
    // 437 today (go 41 + goat 51 + pro 65 + pro-v1 65 + max 87 + ultra 87 ...): the
    // floor is a floor so that regenerating the seed cannot silently empty it.
    assert.ok(recomputed >= 400, `only ${recomputed} models carry counts`)
  })
  check('the seed carries parsed results only -- no page markup, paths or credentials', () => {
    const raw = readFileSync(catalog.catalogSeedPath(), 'utf8')
    for (const marker of ['<html', '<script', '__next_f', '"$L']) {
      assert.ok(!raw.includes(marker), `the seed stored upstream markup: ${marker}`)
    }
    assert.ok(!/[A-Za-z]:\\+Users/.test(raw), 'the seed carries a machine path')
    assert.ok(!/\/Users\/[A-Za-z0-9._-]+/.test(raw), 'the seed carries a machine path')
    assert.ok(!/user_[A-Za-z0-9_-]{20,}|sk-[A-Za-z0-9]{20,}|gh[pousr]_[A-Za-z0-9]{20,}/.test(raw), 'the seed carries a credential')
  })
}

/* ------------------------------------------------------------ fixtures */

console.log('the committed fixtures')
{
  const names = readdirSync(FIXTURES).sort()
  check('carry no upstream markup beyond what they are, and document where they came from', () => {
    assert.ok(names.length >= 2, `expected fixtures, found ${names.length} file(s)`)
    for (const name of names) {
      const text = readFileSync(path.join(FIXTURES, name), 'utf8')
      const header = text.slice(0, 900)
      assert.ok(header.includes('Fixture:'), `${name} does not say what it is`)
      assert.match(header, /Source: GET https:\/\/commandcode\.ai\/docs\//, `${name} does not name its source URL`)
      if (name.endsWith('.html.txt')) {
        // A page shell: the flight chunks are the point, the record is inside them.
        assert.ok(text.includes('self.__next_f.push'), `${name} is not a flight-chunk page`)
      } else {
        assert.ok(!text.includes('<script'), `${name} carries an upstream script tag`)
        assert.ok(!text.includes('__next_f'), `${name} carries the Next.js flight push`)
        // A record line has to be in there -- it need not parse alone (the split fixture
        // is exactly the case where it does not).
        assert.match(text, /(?:^|\n)[0-9a-f]+:[[{]/, `${name} carries no flight record`)
      }
    }
    assert.equal(records(goatFixture).length, 1)
    assert.equal(records(pricingFixture).length, 3)
  })
  check('the whole fixture directory stays small enough to ship', () => {
    const total = names.reduce((sum, name) => sum + statSync(path.join(FIXTURES, name)).size, 0)
    assert.ok(total > 0)
    assert.ok(total <= 120 * 1024, `fixtures total ${total} bytes, over the 120 KB budget`)
  })
}

/* ------------------------------------------------------------------ tail */

/** A catalog object with everything a view needs and nothing else. */
const stubCatalog = (checkedAt, extra = {}) => ({
  kind: catalog.CATALOG_KIND,
  version: catalog.CATALOG_VERSION,
  schema: catalog.CATALOG_SCHEMA,
  checkedAt,
  plans: {},
  failures: [],
  ...extra,
})

console.log('the plan-level row is picked by plan id, not by a name prefix')
{
  /**
   * The pricing page's overview table and its row order are the vendor's, and
   * `Max 10×` is a prefix of `Max 20×`. Matching by "label starts with the plan
   * name" therefore hands the Ultra user Max 10×'s figures the moment the two
   * rows swap places — plausible-looking and wrong by half.
   */
  const rows = [
    { label: 'Max 20×', credits: 300, usageText: '~370K requests', requests: 370_000 },
    { label: 'Max 10×', credits: 150, usageText: '~150K requests', requests: 150_000 },
    { label: 'Provider', credits: 0, usageText: 'pay as you go', requests: undefined },
  ]
  const priced = stubCatalog(iso(NOW), {
    planLevel: { rows, fetchedAt: iso(NOW), sourceUrl: catalog.PRICING_DOC_URL },
  })
  const levelFor = (planId) => catalog.catalogView({ catalog: priced, bundled: false, planId, now: NOW }).planLevel

  check('Ultra reads the Max 20× row even when it is listed first', () => {
    assert.equal(levelFor('individual-ultra')?.label, 'Max 20×')
    assert.equal(levelFor('individual-ultra')?.credits, 300)
  })
  check('Max reads the 10× row it is actually sold as', () => {
    assert.equal(levelFor('individual-max')?.label, 'Max 10×')
    assert.equal(levelFor('individual-max')?.credits, 150)
  })
  check('a plan the pricing table does not price says so instead of borrowing a row', () => {
    assert.equal(levelFor('teams-pro'), null)
    assert.equal(levelFor('individual-go'), null, 'Go has no row in this fixture, so nothing may be returned')
  })
}

console.log('a plan the vendor never published a page for')
{
  /**
   * `individual-provider` and `teams-pro` have no docs page at all. Every check
   * of them used to re-send a full round of requests, forever, because that plan
   * can never appear in `plans` — so "the local copy has never carried this plan"
   * stayed true no matter how often it was asked.
   */
  const withPage = stubCatalog(iso(NOW), {
    plans: { 'individual-goat': { planId: 'individual-goat' } },
    unpublished: ['individual-provider'],
  })
  check('an unpublished tier is not re-asked on every mount', () => {
    assert.equal(catalog.needsRevalidate({ catalog: withPage, planId: 'individual-provider', now: NOW + HOUR }), false)
    // …while a plan that merely is not in the local copy yet is still immediate.
    assert.equal(catalog.needsRevalidate({ catalog: withPage, planId: 'individual-max', now: NOW + HOUR }), true)
    // …and once the day is up, even the unpublished tier is re-checked.
    assert.equal(catalog.needsRevalidate({ catalog: withPage, planId: 'individual-provider', now: NOW + 25 * HOUR }), true)
  })

  const noCache = stubCatalog(iso(NOW), { plans: {}, noData: true })
  check('a check that changed nothing is not retried on every request', () => {
    // No cache file exists after a round where every page failed, so `failures`
    // alone cannot express the backoff: `noData` has to.
    assert.equal(catalog.needsRevalidate({ catalog: noCache, now: NOW + 1_000 }), false)
    assert.equal(catalog.needsRevalidate({ catalog: noCache, now: NOW + catalog.CATALOG_MIN_RETRY_MS }), true)
  })

  const unpublishedView = catalog.catalogView({
    catalog: withPage, bundled: false, planId: 'individual-provider', now: NOW,
  })
  check('the panel is told the vendor publishes nothing for this tier', () => {
    assert.ok(unpublishedView.warnings.includes('catalog-plan-unpublished:individual-provider'))
  })
}

console.log('the probe hop is one round trip, not one per page')
{
  /**
   * Both pages' 0-byte ETag probes have to be in flight together. Counting
   * requests cannot tell the difference — a sequential implementation makes
   * exactly the same two — so the fake server here *proves* the overlap: the
   * pricing probe does not answer until the plan page's probe has arrived. A
   * sequential implementation never gets there and the wait below fails it.
   */
  const overlap = []
  let releasePricing
  const pricingHeld = new Promise((resolve) => { releasePricing = resolve })
  const fetchImpl = async (url, options = {}) => {
    const method = options.method ?? 'GET'
    const page = url === GOAT_URL ? 'plan' : 'pricing'
    overlap.push(`${method} ${page}`)
    if (page === 'pricing') await pricingHeld
    else if (overlap.some((entry) => entry === 'HEAD pricing')) releasePricing()
    return response({ status: 200, etag: `"${page}-v1"`, url, body: method === 'HEAD' ? undefined : HTML_PROLOGUE + goatFixture })
  }

  const raced = await Promise.race([
    sync(tmpFile('concurrent.json'), { fetchImpl, calls: [], plan: () => [], pricing: () => [], gets: () => 0 }, NOW),
    new Promise((resolve) => { setTimeout(() => resolve('timeout'), 3_000) }),
  ])
  check('both page probes go out together instead of one after the other', () => {
    assert.notEqual(raced, 'timeout', 'the probes were serialized: the second page was never asked while the first waited')
    // Both probes were in flight at once: the pricing one could only answer after
    // the plan one had arrived, and it did answer. (A first sync also downloads
    // both bodies, which is why this counts probes rather than all requests.)
    assert.equal(overlap.filter((entry) => entry === 'HEAD plan').length, 1)
    assert.equal(overlap.filter((entry) => entry === 'HEAD pricing').length, 1)
  })
}

/** A round where every page failed must still leave a cache behind: it is the
 * only place the next call can learn that the attempt happened at all. */
console.log('a check that produced nothing still records the attempt')
{
  const file = tmpFile('no-data.json')
  const dead = docsFetch({
    goat: { head: new Error('socket hang up'), get: new Error('socket hang up') },
    pricing: { head: new Error('socket hang up'), get: new Error('socket hang up') },
  })
  const result = await sync(file, dead, NOW)
  check('the attempt is written down with its failures and no data', () => {
    assert.equal(result.catalog.noData, true)
    assert.equal(result.failures.length, 2)
    assert.ok(existsSync(file), 'nothing was written, so nothing rate-limits the next attempt')
    const stored = catalog.readCatalogCache({ file })
    assert.equal(stored?.noData, true)
    assert.equal(stored?.failures.length, 2)
  })
}

rmSync(tmpRoot, { recursive: true, force: true })

if (failures.length === 0) {
  console.log(`\n${passed} checks passed`)
} else {
  console.log(`\n${passed} checks passed, ${failures.length} FAILED`)
  process.exitCode = 1
}
