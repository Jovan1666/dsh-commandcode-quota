/**
 * dsh-cc-quota host half: one exact Fetch route on Connection's shared `/api`
 * transport that serves the Command Code account quota report to this plugin's
 * browser half, plus an optional `/quota` slash command that prints the same
 * report into a conversation.
 *
 * The browser cannot call Command Code itself — the API key lives on the host
 * and the Provider API is not browser-CORS reachable — so the panel asks the
 * host for a normalized report. Registering the route through Connection's
 * exact Fetch registry (rather than `connection.rpc.handle`) is deliberate:
 * `handle` mounts the channel with `owner.webServer`, whose resolution walks
 * the Connection plugin's own fiber chain — where `webServer` is never in scope
 * — so it throws `cannot get property "webServer" without inject` for every
 * caller outside that package, no matter what the caller injects (dsh
 * 0.1.5-rc.1). An exact route is served by the same `/api` transport as the rest
 * of the GUI, so it inherits the Host/Origin fence and the browser-session
 * cookie: only a same-origin browser holding this process's cookie reaches it.
 *
 * @module dsh-cc-quota
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import path from 'node:path'

import { credentialFingerprint, configuredModelIds, fetchQuotaReport, quotaSnapshotPath } from './quota.mjs'
import {
  needsRevalidate,
  readCatalogCache,
  resolveCatalogTtlMs,
  resolveCatalogView,
  syncCatalog,
} from './catalog.mjs'

/** Plugin name shown in the Loader inventory. */
export const name = 'commandcode-quota'

/** The exact Fetch registry lives on the host Connection service. */
export const inject = ['connection']
/** Shared browser transport; routes under it inherit its fence and session. */
const CHANNEL = '/api'

/** Absolute endpoint; the browser posts to `/api/cc-quota/report`. */
const ENDPOINT = 'cc-quota/report'

/** Path the exact Fetch registry matches, channel included. */
const ROUTE_PATH = `${CHANNEL}/${ENDPOINT}`

/**
 * Serve a cached report for this long. The panel polls, and every miss costs
 * four upstream requests against the same account the user is coding on.
 */
const CACHE_MS = 15_000

/**
 * How old a snapshot on disk may be and still be worth showing.
 *
 * The panel's first paint waits for an upstream round trip — measured at ~1.3 s
 * against the live API, of which the two slowest endpoints are each over a
 * second — and a freshly started dsh has nothing cached. That is exactly the
 * "the card takes a moment to appear" case. Serving the previous snapshot
 * immediately, dimmed and labelled with its age, turns the wait into no wait;
 * the fresh report lands about a second later and replaces it.
 *
 * Past this age the numbers stop being a useful stand-in (the 5-hour window
 * alone rolls over several times a day), so the panel starts blank instead of
 * guessing.
 */
const SNAPSHOT_MAX_MS = 6 * 3_600_000

/**
 * Wrap one result in the `server-response` envelope the browser caller checks.
 * @param rpcId - the caller's correlation id, echoed back verbatim.
 * @param result - `{ ok: true, value }` or `{ ok: false, error }`.
 * @returns the HTTP response carrying that envelope.
 */
function envelope(rpcId, result) {
  return Response.json({ type: 'server-response', rpcId, result })
}

/**
 * Read the last good snapshot from disk.
 *
 * The file wraps the report with the fingerprint of the credential it was taken
 * with, so a snapshot cannot be served to a different account than the one it
 * describes. A missing, unreadable, malformed or unrecognised-version file
 * simply means there is nothing to show early — never an error the user sees.
 *
 * @param file - the snapshot path.
 * @returns `{ fingerprint, report }`, or undefined.
 */
function readSnapshot(file) {
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8'))
    if (parsed === null || typeof parsed !== 'object' || parsed.version !== 1) return undefined
    const report = parsed.report
    const fingerprint = parsed.fingerprint
    if (typeof fingerprint !== 'string' || report === null || typeof report !== 'object') return undefined
    if (typeof report.fetchedAt !== 'string') return undefined
    return { fingerprint, report }
  } catch {
    return undefined
  }
}

/**
 * Persist the last good snapshot. Best effort: a read-only home directory must
 * not break the panel; it only costs the next cold start its head start.
 *
 * @param file - the snapshot path.
 * @param report - the report that was just fetched.
 * @param fingerprint - the credential fingerprint it belongs to.
 */
function writeSnapshot(file, report, fingerprint) {
  try {
    // The snapshot carries the account name and its spend, so it gets the same
    // modes dsh's own credential store uses. Written beside the target and
    // renamed, so a second dsh reading during this write never sees a
    // half-written report, and the per-pid name keeps two writers apart.
    mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
    const temp = `${file}.${process.pid}.tmp`
    writeFileSync(temp, JSON.stringify({ version: 1, fingerprint, report }), { encoding: 'utf8', mode: 0o600 })
    renameSync(temp, file)
  } catch {
    // Ignored on purpose: see above.
  }
}

/**
 * An RPC error result, in the same shape the Connection transport uses.
 * @param rpcId - the caller's correlation id.
 * @param code - stable machine-readable code.
 * @param message - human-readable detail.
 * @param details - structured extras; `issues` matches the transport's shape.
 * @returns the HTTP response carrying that error.
 */
function failure(rpcId, code, message, details = {}) {
  return envelope(rpcId, { ok: false, error: { code, message, details } })
}

/** Compact money text for the `/quota` command output. */
function money(value) {
  return typeof value === 'number' && Number.isFinite(value) ? `$${value.toFixed(2)}` : '—'
}

/** Short token counts (`3.49B`) for the `/quota` command output. */
function shortTokens(value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return '—'
  if (value >= 1e9) return `${(value / 1e9).toFixed(2)}B`
  if (value >= 1e6) return `${(value / 1e6).toFixed(2)}M`
  if (value >= 1e3) return `${(value / 1e3).toFixed(1)}K`
  return String(value)
}

/** Human countdown to a reset instant, coarse enough to stay stable in chat. */
function countdown(resetAt) {
  if (typeof resetAt !== 'number' || !Number.isFinite(resetAt)) return undefined
  const minutes = Math.floor((resetAt - Date.now()) / 60_000)
  // A passed instant is not "now": the next refresh replaces the window, and a
  // line claiming it resets in this second reads as a stalled report.
  if (minutes <= 0) return undefined
  if (minutes < 60) return `${minutes}m`
  if (minutes < 1_440) return `${Math.floor(minutes / 60)}h${minutes % 60}m`
  return `${Math.floor(minutes / 1_440)}d${Math.floor((minutes % 1_440) / 60)}h`
}

/**
 * One `/quota` output line for a credit window. Absent windows (pay-as-you-go
 * plans) produce no line at all rather than a placeholder.
 *
 * Money is printed for the monthly allowance only: the rolling windows are
 * pass/fail limits, so their dollar figures would be noise — the same reason
 * the card omits them.
 */
function commandWindowLine(label, source, resetAt, withMoney = false) {
  if (source === undefined || source === null) return undefined
  // A read that straddles a billing boundary cannot state a percentage: the two
  // endpoints behind it describe different periods.
  if (withMoney && source.capSuspect === true) {
    const reset = countdown(resetAt)
    return `${label} reading straddles a billing boundary${reset === undefined ? '' : ` · resets in ${reset}`}`
  }
  const percent = typeof source.percent === 'number' ? `${source.percent.toFixed(1)}% used` : 'usage unavailable'
  const span = withMoney && source.used !== undefined && source.cap !== undefined
    ? ` · ${money(source.used)} / ${money(source.cap)} · ${money(Math.max(0, source.cap - source.used))} left`
    : ''
  const reset = countdown(resetAt)
  return `${label} ${percent}${span}${reset === undefined ? '' : ` · resets in ${reset}`}`
}

/**
 * Render the normalized report as the `/quota` command's chat text.
 *
 * Plain lines on purpose: chat surfaces wrap freely, so nothing here depends
 * on column alignment (the lesson the README's CLI block learned the hard way).
 */
function formatReportText(report) {
  const lines = []
  const plan = report?.plan
  lines.push(`Command Code · ${plan?.name ?? plan?.planId ?? 'account'}${plan?.status === undefined ? '' : ` (${plan.status})`}`)

  const periodEnd = plan?.currentPeriodEnd === undefined ? undefined : Date.parse(plan.currentPeriodEnd)
  const rows = [
    commandWindowLine('5-hour', report?.fiveHour, report?.fiveHour?.resetAt),
    commandWindowLine('Weekly', report?.weekly, report?.weekly?.resetAt),
    commandWindowLine('Monthly', report?.monthly, periodEnd, true),
  ].filter((line) => line !== undefined)
  if (rows.length === 0) {
    lines.push('No credit windows reported for this plan.')
  } else {
    lines.push(...rows)
  }

  const totals = report?.totals
  if (totals?.requests !== undefined) {
    lines.push(`${totals.requests.toLocaleString('en-US')} requests · ${totals.successRate ?? '—'}% success · in ${shortTokens(totals.tokensIn)} / out ${shortTokens(totals.tokensOut)}`)
  }
  if (report?.failures?.length > 0) {
    lines.push(`Degraded endpoints: ${report.failures.join('; ')}`)
  }
  return lines.join('\n')
}

/**
 * Register the quota route on the host Connection service.
 *
 * The report path never throws: every upstream failure is converted into the
 * RPC error result so the browser half can render a message instead of a
 * transport failure. A malformed request or a mismatched method is a
 * programming error on the caller side and is reported as `bad-request`.
 *
 * @param ctx - host plugin context carrying the `connection` service.
 */
export function apply(ctx) {
  /** @type {{ at: number, report: unknown } | undefined} */
  let cache

  /** Where the last good report is kept between process lifetimes. */
  const snapshotFile = quotaSnapshotPath()
  /**
   * The snapshot read once at startup. Read lazily-adjacent to the first call
   * rather than on every call: it exists for the first paint, and after that the
   * in-process cache is what answers.
   */
  let snapshot = readSnapshot(snapshotFile)

  /**
   * Whether this machine still points at Command Code, and with which key.
   *
   * The snapshot exists to make the card appear instantly, not to outlive the
   * configuration it belongs to. Somebody who just removed their Command Code
   * provider must get the "not applicable here" answer (and so no card) rather
   * than a reading from an account they no longer have wired up — and somebody
   * who switched accounts must not see the previous account's numbers. The
   * first question is a resolve-or-not check, the second is the fingerprint
   * match against the snapshot. Both are a few small file reads plus a digest,
   * and only run on the cold path.
   *
   * @returns the current credential fingerprint, or undefined when nothing resolves.
   */
  const currentFingerprint = () => credentialFingerprint()
  /**
   * The read currently in progress, if any.
   *
   * Two callers can want a report at the same moment — the card's poll and a
   * `/quota` invocation, say. Without this, both would fetch, and the slower
   * response would land last and overwrite the cache with the older snapshot,
   * which is exactly the kind of quietly-wrong number a drifting account makes
   * hard to spot. Joining the in-flight read keeps one snapshot per window and
   * one upstream cost per snapshot.
   *
   * @type {Promise<object> | undefined}
   */
  let inFlight

  /**
   * The catalog sync in progress, if any.
   *
   * The catalog is a second, slow-moving dataset: what each model in the plan can
   * call. It never rides the quota read's critical path — the view is served from
   * local data (cache, else the bundled seed) and the revalidation runs behind it.
   *
   * @type {Promise<unknown> | undefined}
   */
  let catalogInFlight

  /**
   * Ensure a catalog view is available, revalidating only when asked.
   *
   * A plain poll (the sidebar card) never spends a request on the catalog: the
   * settings panel is the surface that asks for it, and it says so
   * (`catalog: true`) — which is also the moment the "overdue for a check?"
   * question is evaluated. `catalogRefresh: true`, the check-update button,
   * forces one whatever the TTL says.
   *
   * "Changed only" is enforced upstream: the sync probes each page with a
   * 0-byte HEAD and reuses the cache when the vendor's ETag is unchanged, so a
   * check that finds nothing new costs no body download and no re-parse.
   *
   * @param planId - the account's plan, or undefined when it is not known yet.
   * @param options.check - whether this caller wants the "is it time?" question asked.
   * @param options.refresh - force a check and wait for it.
   * @returns the catalog view for this plan.
   */
  const catalogFor = async (planId, { check = false, refresh = false } = {}) => {
    const ttlMs = resolveCatalogTtlMs()
    const cached = readCatalogCache()
    const due = (check || refresh) && needsRevalidate({ catalog: cached, planId, ttlMs })
    if ((due || refresh) && catalogInFlight === undefined) {
      // Failures are recorded inside the catalog itself, so a rejected promise
      // here has nothing left to report.
      catalogInFlight = syncCatalog({ planId, ttlMs })
        .catch(() => undefined)
        .finally(() => { catalogInFlight = undefined })
    }
    if ((due || refresh) && catalogInFlight !== undefined) await catalogInFlight
    // Cache first, bundled seed second, an honest "nothing yet" last.
    return resolveCatalogView({
      planId,
      configuredModels: configuredModelIds(),
      ttlMs,
    })
  }

  /**
   * Attach the catalog view to a report result.
   *
   * The browser half renders the plan's per-model allowances from it. A missing
   * catalog never fails the report: the worst case is a view that says it has not
   * synced yet.
   *
   * @param result - the RPC result for the quota report.
   * @param options.check - ask whether the catalog is overdue for a check.
   * @param options.refresh - wait for a real revalidation before answering.
   * @returns the result with `value.catalog` added.
   */
  const withCatalog = async (result, { check = false, refresh = false } = {}) => {
    if (result?.ok !== true) return result
    const value = result.value
    // A report whose plan block failed still has a plan id worth using: the
    // previous read persisted it.
    const planId = value?.plan?.planId ?? cache?.report?.plan?.planId ?? snapshot?.report?.plan?.planId
    const catalog = await catalogFor(planId, { check, refresh })
    return { ...result, value: { ...value, catalog } }
  }

  /**
   * Read once from upstream, then cache and persist the result.
   * @returns the RPC result for this read; never throws.
   */
  const fetchOnce = async () => {
    try {
      const value = await fetchQuotaReport()
      cache = { at: Date.now(), report: value }
      // Keep the last good report on disk — and in memory — so the next cold
      // start (a dsh restart, a page reload after the host recycled) can paint
      // instantly instead of waiting out another upstream round trip. Refreshing
      // the in-memory copy matters too: otherwise the stale path would go on
      // serving whatever was on disk at startup, which is older than the report
      // already fetched.
      const fingerprint = currentFingerprint()
      snapshot = fingerprint === undefined ? undefined : { fingerprint, report: value }
      if (fingerprint !== undefined) writeSnapshot(snapshotFile, value, fingerprint)
      return { ok: true, value }
    } catch (error) {
      const code = error !== null && typeof error === 'object' && 'code' in error ? String(error.code) : 'UNKNOWN'
      // Nothing on this machine points at Command Code, so the plugin has no job
      // here. This travels as a *successful* response carrying a marker rather
      // than an RPC error: the transport's error schema is a discriminated union
      // of known codes, so an invented code fails the browser's validation and
      // surfaces as a transport failure — the opposite of hiding.
      if (code === 'MISSING_CREDENTIAL' && error.configured === false) {
        return { ok: true, value: { configured: false, reason: 'no-commandcode-provider' } }
      }
      return {
        ok: false,
        error: {
          code: 'internal',
          message: `[${code}] ${error instanceof Error ? error.message : String(error)}`,
          details: {},
        },
      }
    }
  }

  /**
   * Serve a report, preferring the cheapest source that can answer honestly.
   *
   * Order: the in-process cache (≤15 s old, no marker), then — only on a true
   * cold start — the snapshot on disk, labelled `stale` and served *while* a
   * refresh runs behind it, then a blocking upstream read.
   *
   * The snapshot is deliberately restricted to the case where nothing has been
   * read successfully in this process yet. Serving it whenever the 15 s cache
   * lapsed would mean answering every poll with a dimmed, ageing snapshot while
   * a live read was already on its way — the panel would visibly grey out every
   * few seconds for no gain, since the numbers it is already showing are just as
   * old as the snapshot's. Once one live read has landed, waiting ~1.3 s for the
   * next one is invisible to a user looking at a card that is already painted.
   *
   * @param options.allowStale - whether a snapshot may be served early. The
   *   browser route says yes because its first paint is the whole point; the
   *   `/quota` command says no, because somebody who typed a command wants a
   *   current answer, not a labelled guess.
   * @returns the RPC result for this call.
   */
  const report = async ({ allowStale = false } = {}) => {
    const now = Date.now()
    if (cache !== undefined && now - cache.at < CACHE_MS) {
      return { ok: true, value: cache.report }
    }

    // Start (or join) the refresh either way: the snapshot must never become a
    // reason to stop asking upstream.
    if (inFlight === undefined) {
      inFlight = fetchOnce().finally(() => { inFlight = undefined })
    }

    if (allowStale && cache === undefined) {
      const fingerprint = currentFingerprint()
      // Only this account's own snapshot: see `currentFingerprint`.
      const belongsHere = fingerprint !== undefined && snapshot !== undefined && snapshot.fingerprint === fingerprint
      const age = Date.parse(snapshot?.report?.fetchedAt ?? '')
      const ageMs = now - age
      if (belongsHere && Number.isFinite(ageMs) && ageMs >= 0 && ageMs < SNAPSHOT_MAX_MS) {
        // Forwarded whole, plus the two fields that make the fallback honest:
        // that it is one, and how old it is.
        return { ok: true, value: { ...snapshot.report, stale: true, staleAgeMs: ageMs } }
      }
    }

    return inFlight
  }

  /**
   * Read one client-request envelope and answer it.
   * @param request - the Fetch request the Connection bridge composed.
   * @returns the response; never throws.
   */
  const serve = async (request) => {
    if (request.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase() !== 'application/json') {
      return new Response('content type must be application/json', { status: 415 })
    }

    let body
    try {
      body = await request.json()
    } catch {
      return new Response('body is not JSON', { status: 400 })
    }

    const message = body !== null && typeof body === 'object' ? body : undefined
    const rpcId = typeof message?.rpcId === 'string' ? message.rpcId : 'invalid-request'
    if (message?.type !== 'client-request' || typeof message.method !== 'string') {
      return failure(rpcId, 'bad-request', 'invalid client-request message', { issues: [] })
    }
    if (message.method !== ENDPOINT) {
      return failure(rpcId, 'bad-request', `method ${JSON.stringify(message.method)} does not match endpoint ${JSON.stringify(ENDPOINT)}`, { issues: [] })
    }

    // The catalog is a second dataset with its own cadence. It rides along with
    // every answer, but a check only happens when the settings panel asks for one
    // (`catalog: true`), or when the button forces it (`catalogRefresh: true`) —
    // the card's minute-by-minute poll never spends a request on it.
    const payload = message.payload !== null && typeof message.payload === 'object' ? message.payload : undefined
    const result = await report({ allowStale: true })
    const catalogOptions = {
      check: payload?.catalog === true,
      refresh: payload?.catalogRefresh === true,
    }
    return envelope(rpcId, await withCatalog(result, catalogOptions))
  }

  ctx.effect(() => ctx.connection.fetch.register({
    path: ROUTE_PATH,
    methods: ['POST'],
    requestBody: 'buffered',
    fetch: serve,
  }))

  registerQuotaCommand(ctx, report, withCatalog, catalogFor)

  ctx.logger.info(`cc-quota: serving quota reports on ${ROUTE_PATH}`)
}

/**
 * Register the optional `/quota` slash command on the human-command registry.
 *
 * `commands` is deliberately *not* declared in `inject`: it is an optional
 * service here (the card works in profiles that compose no command runtime),
 * and the repo convention is `ctx.get(name)` for exactly that. The handler
 * reuses the route's cached `report()` so a slash invocation never costs more
 * upstream requests than the card would have spent anyway.
 *
 * @param ctx - host plugin context.
 * @param report - the cached report producer shared with the Fetch route.
 * @param withCatalog - attaches the catalog view to a report result.
 * @param catalogFor - local catalog view producer, for the `--models` argument.
 */
function registerQuotaCommand(ctx, report, withCatalog, catalogFor) {
  const commands = ctx.get('commands')
  if (commands === undefined) {
    ctx.logger.info('cc-quota: no command runtime composed; /quota not registered')
    return
  }
  ctx.effect(() => commands.register({
    name: 'quota',
    description: 'Show Command Code plan credit usage (--models for per-model allowances)',
    handler: async ({ rawInput } = {}) => {
      const input = String(rawInput ?? '')
      const wantsModels = /(^|\s)--models(\s|$)/.test(input)
      const wantsRefresh = /(^|\s)--refresh(\s|$)/.test(input)
      const result = await report()
      if (!result.ok) {
        return { kind: 'error', text: result.error.message }
      }
      if (result.value !== null && typeof result.value === 'object' && result.value.configured === false) {
        return { kind: 'error', text: 'No Command Code provider is configured on this host.' }
      }
      if (!wantsModels) {
        return { kind: 'success', text: formatReportText(result.value) }
      }
      // The catalog is local data; `--refresh` is the only form that spends a
      // request, and it spends it on a 0-byte ETag probe when nothing changed.
      const withCatalogView = await withCatalog(result, { refresh: wantsRefresh })
      return { kind: 'success', text: formatCatalogText(withCatalogView.value.catalog) }
    },
  }), 'cc-quota: /quota command')
}

/**
 * Render the per-model allowance catalog as chat text.
 *
 * One model per line with labelled figures rather than columns: chat surfaces
 * wrap freely, and the README already learned that aligned columns only look
 * aligned in the font they were written in.
 *
 * @param catalog - the catalog view attached to the report.
 * @returns the text, or a sentence saying why there is nothing to show.
 */
function formatCatalogText(catalog) {
  if (catalog === null || typeof catalog !== 'object') {
    return 'Model allowances are unavailable: this host has no catalog support.'
  }
  const lines = []
  const plan = catalog.planName ?? catalog.planId ?? 'this plan'
  lines.push(`Command Code · ${plan} · per-model request allowances`)
  if (typeof catalog.docUrl === 'string') lines.push(`source ${catalog.docUrl}`)
  if (catalog.inferredFrom !== undefined) {
    lines.push(`note: the vendor publishes no page for this plan; figures are taken from ${catalog.inferredFrom}`)
  }
  const state = catalog.verified === true
    ? `synced ${catalog.updatedAt ?? '—'}`
    : 'not synced yet — showing the baseline shipped with the plugin'
  lines.push(`${state}${catalog.stale === true ? ' (overdue for a check)' : ''}`)

  const models = Array.isArray(catalog.models) ? catalog.models : []
  if (models.length === 0) {
    lines.push('No model allowances for this plan.')
  } else {
    if (catalog.basis !== null && catalog.basis !== undefined) {
      lines.push(`basis: the vendor's own estimate, ${catalog.basis.inputTokens} in / ${catalog.basis.outputTokens} out / ${catalog.basis.cacheReadTokens} cached tokens per request`)
    }
    const estimated = models.filter((model) => model.estimated === true)
    lines.push('')
    for (const model of estimated) {
      lines.push(`${model.configured === true ? '* ' : ''}${model.name} · 5h ${volume(model, 'fiveHour')} · week ${volume(model, 'week')} · month ${volume(model, 'monthly')}`)
    }
    const withoutNumbers = models.length - estimated.length
    if (withoutNumbers > 0) {
      lines.push(`(${withoutNumbers} more model(s) are available on this plan without a published allowance)`)
    }
  }
  if (catalog.planLevel !== null && catalog.planLevel !== undefined) {
    // Two different figures, two different methods: never mixed into one number.
    lines.push(`plan-level estimate (a different basis, not comparable): ${catalog.planLevel.requestsText}`)
  }
  for (const failure of catalog.failures ?? []) {
    lines.push(`unavailable: ${failure.code}${failure.message === undefined ? '' : ` (${failure.message})`}`)
  }
  return lines.join('\n')
}

/**
 * One figure from a catalog model row.
 *
 * Free models have no finite count — the vendor prints "Free" — and JSON cannot
 * carry `Infinity`, so a row read back from disk or over the RPC has `null` where
 * the live value was infinite. `free` is the field that says so; never render a
 * bare `—` for a model the vendor lists as free.
 */
function volume(model, key) {
  if (model?.free === true) return 'Free'
  return count(model?.[key])
}

/** Same rendering rule as the card: the vendor's own three-significant-digit rounding. */
function count(value) {
  if (value === null || value === undefined) return '—'
  if (typeof value !== 'number' || !Number.isFinite(value)) return 'Free'
  return Number(value.toPrecision(3)).toLocaleString('en-US')
}
