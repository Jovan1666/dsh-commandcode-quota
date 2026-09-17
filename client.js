/**
 * dsh-cc-quota browser half.
 *
 * Registers one card into the sidebar-owned `sidebar.footer.action` list slot,
 * which the sidebar shell renders directly above the Settings seat in both
 * sidebar widths. The card asks the host for a quota report over the exact Fetch
 * route this plugin's host half registers on the shared `/api` transport
 * (`/api/cc-quota/report`), and renders every credit window the account reports.
 *
 * Presentation rules:
 *
 * - Windows run shortest first (5 hours, weekly, monthly), so the tightest
 *   constraint sits where the eye lands first.
 * - The used *percentage* is the row's value and the bar repeats it
 *   graphically; credit amounts are secondary and live in the expanded body,
 *   because a user rarely knows their plan's totals but reads "98.6%" instantly.
 * - Each window is a two-line block — a label/percentage line, then a full-width
 *   bar with the reset countdown on the following line — so the meter reads as a
 *   meter instead of an underline, and nothing competes for the same line.
 *
 * Written as a hand-authored bundle: no build step, so the component uses
 * `React.createElement` rather than JSX, and styling is one injected stylesheet
 * keyed on the `.ccq-` prefix using the harness's own design tokens. Literal
 * colours appear only as the terminal fallback of a `var()`.
 */

window.__ModuleLoader__.load({
  id: 'dsh-commandcode-quota',
  factory: (require) => {
    const React = require('react')
    const h = React.createElement

    const module = { exports: {} }
    const exports = module.exports

    /** Panel auto-refresh interval; the host caches for 15s on its side. */
    const REFRESH_MS = 60_000
    /** Shared browser transport; the host registers its exact route under this channel. */
    const CHANNEL = '/api'
    /** Endpoint the host half registers inside that channel. */
    const ENDPOINT = 'cc-quota/report'
    const STYLE_ID = 'dsh-commandcode-quota-style'

    /** Used-percentage thresholds; above each, the bar takes the next colour. */
    const LEVELS = [
      { below: 60, token: 'var(--dsw-alias-state-success-primary)' },
      { below: 85, token: 'var(--dsw-alias-state-warn-primary)' },
      { below: Number.POSITIVE_INFINITY, token: 'var(--dsw-alias-state-error-primary)' },
    ]

    /** Display order: the shortest window first, the monthly budget last. */
    const WINDOWS = [
      { key: 'fiveHour', label: '5 小时' },
      { key: 'weekly', label: '每周' },
      { key: 'monthly', label: '月度' },
    ]

    const CSS = `
.ccq-card{box-sizing:border-box;width:100%;margin:0 0 6px;padding:11px 13px 12px;border-radius:12px;
  border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-button-elevated-fill);
  color:var(--dsw-alias-label-primary);font-family:inherit;text-align:left;
  cursor:pointer;-webkit-user-select:none;user-select:none}
.ccq-card:hover{background:var(--dsw-alias-button-floating-hover)}
.ccq-head{display:flex;align-items:center;gap:6px;padding-bottom:9px;margin-bottom:10px;
  border-bottom:1px solid var(--dsw-alias-border-l1)}
.ccq-title{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;
  font-size:13px;font-weight:600;line-height:18px}
.ccq-plan{flex:none;padding:1px 6px;border-radius:6px;font-size:10px;line-height:14px;font-weight:500;
  background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-tertiary)}
.ccq-chevron{flex:none;color:var(--dsw-alias-label-caption);font-size:9px;line-height:18px;
  transition:transform 150ms ease}
.ccq-chevron.ccq-open{transform:rotate(180deg)}
.ccq-win+.ccq-win{margin-top:11px}
.ccq-winhead{display:flex;align-items:baseline;gap:8px}
.ccq-winlabel{flex:none;font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary)}
.ccq-spacer{flex:1;min-width:0}
.ccq-pct{flex:none;font-size:14px;font-weight:600;line-height:18px;font-variant-numeric:tabular-nums}
.ccq-reset{flex:none;padding:1px 6px;border-radius:6px;font-size:10px;line-height:14px;
  background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-tertiary);
  font-variant-numeric:tabular-nums;white-space:nowrap}
.ccq-track{height:6px;margin-top:7px;border-radius:3px;overflow:hidden;
  background:var(--dsw-alias-interactive-bg-hover)}
.ccq-fill{display:block;height:100%;border-radius:3px;transition:width 240ms ease,background 240ms ease}
.ccq-detail{margin-top:12px;padding-top:10px;border-top:1px solid var(--dsw-alias-border-l1)}
.ccq-kv{display:flex;align-items:baseline;justify-content:space-between;gap:10px;
  font-size:11px;line-height:19px;color:var(--dsw-alias-label-secondary)}
.ccq-kv-label{flex:none;white-space:nowrap}
.ccq-kv-value{min-width:0;text-align:right;color:var(--dsw-alias-label-primary);
  font-variant-numeric:tabular-nums}
.ccq-note{margin-top:7px;padding-top:7px;border-top:1px solid var(--dsw-alias-border-l1);
  font-size:10px;line-height:16px;color:var(--dsw-alias-label-caption);
  font-variant-numeric:tabular-nums}
.ccq-note+.ccq-note{margin-top:1px;padding-top:0;border-top:none}
.ccq-error{font-size:11px;line-height:18px;color:var(--dsw-alias-state-error-primary)}
.ccq-rail{box-sizing:border-box;width:36px;height:36px;border-radius:50%;display:flex;
  align-items:center;justify-content:center;font-size:11px;font-weight:600;
  font-variant-numeric:tabular-nums;border:none;background:transparent;cursor:pointer}
.ccq-rail:hover{background:var(--dsw-alias-interactive-bg-hover)}
`

    /** Inject the panel stylesheet once per document. */
    function ensureStyles() {
      if (document.getElementById(STYLE_ID) !== null) return
      const style = document.createElement('style')
      style.id = STYLE_ID
      style.textContent = CSS
      document.head.appendChild(style)
    }

    /** Native colour token for a used percentage; unknown reads as the healthy level. */
    function levelToken(percent) {
      const level = LEVELS.find((entry) => (percent === undefined ? 0 : percent) < entry.below)
      return level === undefined ? LEVELS[LEVELS.length - 1].token : level.token
    }

    function money(value) {
      return typeof value === 'number' && Number.isFinite(value) ? `$${value.toFixed(2)}` : '—'
    }

    function percentText(value) {
      return typeof value === 'number' && Number.isFinite(value) ? `${value.toFixed(1)}%` : '—'
    }

    function tokens(value) {
      if (typeof value !== 'number' || !Number.isFinite(value)) return undefined
      if (value >= 1e9) return `${(value / 1e9).toFixed(2)}B`
      if (value >= 1e6) return `${(value / 1e6).toFixed(2)}M`
      if (value >= 1e3) return `${(value / 1e3).toFixed(1)}K`
      return String(value)
    }

    /** Local wall clock for one epoch-millisecond instant. */
    function when(timestamp) {
      if (typeof timestamp !== 'number' || !Number.isFinite(timestamp)) return undefined
      const target = new Date(timestamp)
      const pad = (value) => String(value).padStart(2, '0')
      return `${pad(target.getMonth() + 1)}-${pad(target.getDate())} ${pad(target.getHours())}:${pad(target.getMinutes())}`
    }

    /**
     * Short countdown for the row chip: `42m`, `3h12m`, `6d10h`. Deliberately
     * terse — it sits beside the percentage, and the absolute reset time and the
     * long form are one hover (or one click) away.
     */
    function shortCountdown(timestamp) {
      if (typeof timestamp !== 'number' || !Number.isFinite(timestamp)) return undefined
      const minutes = Math.floor((timestamp - Date.now()) / 60_000)
      if (minutes <= 0) return '即将重置'
      if (minutes < 60) return `${minutes}m 后重置`
      const hours = Math.floor(minutes / 60)
      if (hours < 24) return `${hours}h${minutes % 60}m 后重置`
      return `${Math.floor(hours / 24)}d${hours % 24}h 后重置`
    }

    /** Verbose countdown for the detail panel. */
    function longCountdown(timestamp) {
      if (typeof timestamp !== 'number' || !Number.isFinite(timestamp)) return undefined
      const minutes = Math.floor((timestamp - Date.now()) / 60_000)
      if (minutes <= 0) return '即将重置'
      const days = Math.floor(minutes / 1440)
      const hours = Math.floor((minutes % 1440) / 60)
      if (days > 0) return `${days} 天 ${hours} 小时后`
      if (hours > 0) return `${hours} 小时 ${minutes % 60} 分后`
      return `${minutes} 分后`
    }

    /**
     * Normalize the report's windows into one render shape.
     *
     * The host derives `percent` and the caps from the account's own plan, so
     * this stays plan-agnostic: a plan that reports no window (the
     * pay-as-you-go Provider plan, say) simply yields no row. The monthly reset
     * comes from the subscription period rather than a window limit.
     *
     * @param report - the host's normalized quota report.
     * @returns one row per window the account actually reports.
     */
    function windowsOf(report) {
      const periodEnd = report?.plan?.currentPeriodEnd === undefined
        ? undefined
        : Date.parse(report.plan.currentPeriodEnd)
      const rows = []
      for (const { key, label } of WINDOWS) {
        const source = key === 'monthly' ? report?.monthly : report?.[key]
        if (source === undefined || source === null) continue
        const percent = typeof source.percent === 'number' ? source.percent : undefined
        const used = typeof source.used === 'number' ? source.used : undefined
        const cap = typeof source.cap === 'number' && source.cap > 0 ? source.cap : undefined
        if (percent === undefined && cap === undefined) continue
        rows.push({
          key,
          label,
          percent,
          used,
          cap,
          remaining: used !== undefined && cap !== undefined ? cap - used : undefined,
          resetAt: key === 'monthly' ? periodEnd : source.resetAt,
          exceeded: source.exceeded === true,
        })
      }
      return rows
    }

    /** On-demand balance for accounts that buy credits instead of holding an allowance. */
    function balanceOf(report) {
      const free = report?.monthly?.freeCredits
      const purchased = report?.monthly?.purchasedCredits
      if ((free ?? 0) === 0 && (purchased ?? 0) === 0) return undefined
      return { free: free ?? 0, purchased: purchased ?? 0 }
    }

    function describeError(result) {
      if (result !== null && typeof result === 'object' && typeof result.error?.message === 'string') {
        return result.error.message
      }
      return '额度接口返回了无法识别的结果'
    }

    /**
     * Fetch the report once, then on an interval, for as long as the card is
     * mounted. One AbortController covers the effect's lifetime so unmount and
     * manual refresh both cancel whatever is in flight.
     */
    function useQuota(fetchQuota) {
      const [state, setState] = React.useState({ phase: 'loading' })
      const [nonce, setNonce] = React.useState(0)

      React.useEffect(() => {
        const controller = new AbortController()
        const settle = (next) => { if (!controller.signal.aborted) setState(next) }
        const load = () => {
          // Promise.resolve() turns a synchronous throw from the transport into
          // a rejection, so the card reports it instead of unmounting.
          Promise.resolve()
            .then(() => fetchQuota(controller.signal))
            .then(
              (result) => {
                if (result !== null && typeof result === 'object' && result.ok === true) {
                  settle({ phase: 'ready', report: result.value, at: Date.now() })
                } else {
                  settle({ phase: 'error', message: describeError(result) })
                }
              },
              (error) => { settle({ phase: 'error', message: String(error?.message ?? error) }) },
            )
        }
        load()
        const timer = window.setInterval(load, REFRESH_MS)
        return () => {
          window.clearInterval(timer)
          controller.abort()
        }
      }, [fetchQuota, nonce])

      const refresh = React.useCallback(() => { setNonce((value) => value + 1) }, [])
      return { state, refresh }
    }

    /**
     * One credit window: label and percentage on the first line, the meter and
     * its reset countdown on the next. Nothing shares a line with the meter.
     */
    function WindowRow({ row }) {
      const tips = [
        row.used !== undefined && row.cap !== undefined ? `已用 ${money(row.used)} / ${money(row.cap)}` : undefined,
        row.remaining !== undefined ? `剩余 ${money(row.remaining)}` : undefined,
        row.resetAt === undefined ? undefined : `${when(row.resetAt) ?? '—'} 重置（${longCountdown(row.resetAt) ?? '—'}）`,
      ].filter((part) => part !== undefined)
      const fill = Math.max(0, Math.min(100, row.percent ?? 0))
      const color = levelToken(row.percent)
      const reset = row.exceeded ? '已超限' : shortCountdown(row.resetAt)
      return h('div', { className: 'ccq-win', title: tips.join(' · ') },
        h('div', { className: 'ccq-winhead' },
          h('span', { className: 'ccq-winlabel' }, row.label),
          h('span', { className: 'ccq-spacer' }),
          reset === undefined ? null : h('span', { className: 'ccq-reset' }, reset),
          h('span', { className: 'ccq-pct', style: { color } }, percentText(row.percent)),
        ),
        h('div', { className: 'ccq-track' },
          h('span', { className: 'ccq-fill', style: { width: `${fill}%`, background: color } })),
      )
    }

    /** One label/value detail line; the label never shrinks, the value wraps. */
    function Detail({ label, value, danger }) {
      return h('div', { className: 'ccq-kv' },
        h('span', { className: 'ccq-kv-label' }, label),
        h('span', {
          className: 'ccq-kv-value',
          style: danger === true ? { color: 'var(--dsw-alias-state-error-primary)' } : undefined,
        }, value),
      )
    }

    /**
     * Expanded body: the amounts behind each percentage, then the period totals
     * as plain muted lines — no label column, so nothing gets squeezed.
     */
    function detailRows(report, rows) {
      const body = []
      for (const row of rows) {
        if (row.used === undefined || row.cap === undefined) continue
        body.push(h(Detail, {
          key: `${row.key}-amount`,
          label: row.label,
          value: `${money(row.used)} / ${money(row.cap)}${row.remaining === undefined ? '' : ` · 剩 ${money(row.remaining)}`}`,
        }))
      }
      const balance = balanceOf(report)
      if (balance !== undefined) {
        body.push(h(Detail, {
          key: 'balance',
          label: '额外额度',
          value: `赠送 ${money(balance.free)} · 已购 ${money(balance.purchased)}`,
        }))
      }

      const notes = []
      const totals = report?.totals
      if (totals?.requests !== undefined) {
        notes.push(`本周期 ${totals.requests.toLocaleString('en-US')} 请求${totals.successRate === undefined ? '' : ` · ${totals.successRate}%`}`)
        const tokenIn = tokens(totals?.tokensIn)
        if (tokenIn !== undefined) notes.push(`in ${tokenIn} / out ${tokens(totals?.tokensOut) ?? '—'}`)
      }
      const projection = report?.projection
      if (projection?.runsOutInDays !== undefined) {
        const daysLeft = projection.totalDays - projection.elapsedDays
        notes.push(
          `$${projection.dailyRate.toFixed(2)}/天${
            projection.runsOutInDays < daysLeft ? ` · 约 ${projection.runsOutInDays.toFixed(1)} 天后耗尽` : ''
          }`,
        )
      }
      if (Array.isArray(report?.failures) && report.failures.length > 0) {
        notes.push(`${report.failures.length} 个端点降级`)
      }
      for (const [index, note] of notes.entries()) {
        body.push(h('div', { key: `note-${String(index)}`, className: 'ccq-note' }, note))
      }
      return body
    }

    /** Tooltip / rail summary: the percentages, which are the card's own headline. */
    function summaryTitle(report, rows) {
      return rows
        .map((row) => `${row.label} ${percentText(row.percent)}${row.remaining === undefined ? '' : `（剩 ${money(row.remaining)}）`}`)
        .join(' · ')
    }

    /** The 36px rail badge shown while the sidebar is collapsed. */
    function RailBadge({ state }) {
      if (state.phase !== 'ready') {
        return h('div', { className: 'ccq-rail', title: state.phase === 'error' ? state.message : '正在读取额度…' }, '…')
      }
      const rows = windowsOf(state.report)
      const headline = rows[0]
      if (headline === undefined) return h('div', { className: 'ccq-rail', title: '该账号未上报额度窗口' }, '—')
      return h('div', {
        className: 'ccq-rail',
        title: summaryTitle(state.report, rows),
        style: { color: levelToken(headline.percent) },
      }, `${(headline.percent ?? 0).toFixed(0)}%`)
    }

    /** The sidebar-foot card. */
    function QuotaCard(props) {
      const [open, setOpen] = React.useState(false)
      const { state, refresh } = useQuota(props.fetchQuota)
      const wide = props.wide !== false

      if (!wide) return h(RailBadge, { state })

      const report = state.phase === 'ready' ? state.report : undefined
      const rows = report === undefined ? [] : windowsOf(report)
      const planName = report?.plan?.name ?? 'Command Code'

      let body
      if (state.phase === 'error') {
        body = [
          h('div', { key: 'error', className: 'ccq-error' }, state.message),
          h('div', { key: 'hint', className: 'ccq-error' }, '点击重试'),
        ]
      } else if (report === undefined) {
        body = WINDOWS.map(({ key, label }) => h(WindowRow, {
          key,
          row: { key, label, percent: undefined, used: undefined, cap: undefined, remaining: undefined, resetAt: undefined },
        }))
      } else if (rows.length === 0) {
        body = [h('div', { key: 'none', className: 'ccq-error' }, '该套餐未上报额度窗口')]
      } else {
        body = rows.map((row) => h(WindowRow, { key: row.key, row }))
      }

      return h('div', {
        className: 'ccq-card',
        title: report === undefined ? undefined : summaryTitle(report, rows),
        onClick: () => {
          if (state.phase === 'error') { refresh(); return }
          setOpen((value) => !value)
        },
      },
        h('div', { className: 'ccq-head' },
          h('span', { className: 'ccq-title' }, 'Command Code'),
          h('span', { className: 'ccq-plan' }, planName),
          h('span', { className: `ccq-chevron${open ? ' ccq-open' : ''}` }, '▾'),
        ),
        ...body,
        open && report !== undefined ? h('div', { className: 'ccq-detail' }, ...detailRows(report, rows)) : null,
      )
    }

    /**
     * Register the card once the sidebar declares the footer-action hole.
     * @param ctx - client plugin context.
     */
    function apply(ctx) {
      ensureStyles()
      ctx.slots.inject('sidebar.footer.action', () => ctx.slots.register({
        name: 'sidebar.footer.action',
        id: 'cc-quota',
        order: 0,
        inject: () => ({
          fetchQuota: (signal) => ctx.connection.rpc.call(CHANNEL, ENDPOINT, {}, signal),
        }),
      }, QuotaCard))
    }

    exports.apply = apply
    exports.inject = ['slots', 'connection']
    return module.exports
  },
})
