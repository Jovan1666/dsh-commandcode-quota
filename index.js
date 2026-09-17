/**
 * dsh-cc-quota host half: one exact Fetch route on Connection's shared `/api`
 * transport that serves the Command Code account quota report to this plugin's
 * browser half.
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

import { fetchQuotaReport } from './quota.mjs'

/** Plugin name shown in the Loader inventory. */
export const name = 'cc-quota'

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
 * Wrap one result in the `server-response` envelope the browser caller checks.
 * @param rpcId - the caller's correlation id, echoed back verbatim.
 * @param result - `{ ok: true, value }` or `{ ok: false, error }`.
 * @returns the HTTP response carrying that envelope.
 */
function envelope(rpcId, result) {
  return Response.json({ type: 'server-response', rpcId, result })
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

  /**
   * Serve the cached report, or fetch and cache a fresh one.
   * @returns the RPC result for this call.
   */
  const report = async () => {
    const now = Date.now()
    if (cache !== undefined && now - cache.at < CACHE_MS) {
      return { ok: true, value: cache.report }
    }

    try {
      const value = await fetchQuotaReport()
      cache = { at: now, report: value }
      return { ok: true, value }
    } catch (error) {
      const code = error !== null && typeof error === 'object' && 'code' in error ? String(error.code) : 'UNKNOWN'
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
      return failure(rpcId, 'gateway/bad-request', 'invalid client-request message', { issues: [] })
    }
    if (message.method !== ENDPOINT) {
      return failure(rpcId, 'gateway/bad-request', `method ${JSON.stringify(message.method)} does not match endpoint ${JSON.stringify(ENDPOINT)}`, { issues: [] })
    }

    return envelope(rpcId, await report())
  }

  ctx.connection.fetch.register({
    path: ROUTE_PATH,
    methods: ['POST'],
    requestBody: 'buffered',
    fetch: serve,
  })

  ctx.logger.info(`cc-quota: serving quota reports on ${ROUTE_PATH}`)
}
