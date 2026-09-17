/**
 * dsh-commandcode-quota browser half.
 *
 * Registers one card into the sidebar-owned `sidebar.footer.action` list slot,
 * which the sidebar shell renders directly above the Settings seat in both
 * sidebar widths. The card asks the host for a quota report over the exact Fetch
 * route this plugin's host half registers on the shared `/api` transport, and
 * renders every credit window the account reports.
 *
 * Presentation rules:
 *
 * - Windows run shortest first (5 hours, weekly, monthly), so the tightest
 *   constraint sits where your eye lands first.
 * - The used *percentage* is the row's value and the bar repeats it graphically,
 *   because that is the whole question this card answers: how deep into the
 *   window am I? The headline rounds to a whole percent — the same rounding the
 *   official dashboard uses — so the card and the website can be compared
 *   without a mental conversion; the exact one-decimal value and the dollar
 *   amounts stay one hover away.
 * - Space is deliberately scarce: the sidebar is narrow and laptop screens make
 *   small type smaller still. Only the monthly allowance is shown in money —
 *   it is the one total a user actually budgets against — while the rolling
 *   windows stay percentage-only, because the API reports them as pass/fail
 *   limits rather than as something to track in dollars.
 * - Nothing is deduced about *pace*. How fast a user burns credit is their
 *   business; a card that editorialises about "over pace" tells someone who
 *   simply has work to do something they cannot act on.
 * - The card renders nothing at all when this host has no Command Code provider,
 *   so installing the plugin cannot park an error box in the sidebar of somebody
 *   who does not use the service.
 *
 * Written as a hand-authored bundle: no build step, so the component uses
 * `React.createElement` rather than JSX, and styling is one injected stylesheet
 * keyed on the `.ccq-` prefix using the harness's own design tokens.
 */

window.__ModuleLoader__.load({
  id: 'dsh-commandcode-quota',
  factory: (require) => {
    const React = require('react')
    const h = React.createElement

    const module = { exports: {} }
    const exports = module.exports

    /** Channel and endpoint the host half registers. */
    const CHANNEL = '/api'
    const ENDPOINT = 'cc-quota/report'
    const STYLE_ID = 'dsh-commandcode-quota-style'
    /** Locale namespace this plugin owns. */
    const NS = 'cc-quota'
    /** Poll cadence: relaxed normally, tight once any window is near its cap. */
    const SLOW_MS = 60_000
    const FAST_MS = 15_000
    /** Used percentage at which a window counts as "hot" for polling purposes. */
    const HOT_PERCENT = 85
    /** Where to send someone who needs more credit. */
    const BILLING_URL = 'https://commandcode.ai/pricing'

    const LEVELS = [
      { below: 60, token: 'var(--dsw-alias-state-success-primary)' },
      { below: 85, token: 'var(--dsw-alias-state-warn-primary)' },
      { below: Number.POSITIVE_INFINITY, token: 'var(--dsw-alias-state-error-primary)' },
    ]

    /** Display order: the shortest window first, the monthly budget last. */
    const WINDOWS = [
      { key: 'fiveHour', label: 'fiveHour' },
      { key: 'weekly', label: 'weekly' },
      { key: 'monthly', label: 'monthly' },
    ]

    /** Every string this plugin renders, in both shipped UI languages. */
    const DICT = {
      zh: {
        fiveHour: '5 小时',
        weekly: '每周',
        monthly: '月度',
        left: '剩',
        remainingLabel: '剩余',
        reset: '{time} 后重置',
        overLimit: '已超限',
        usedOf: '{label}已用',
        requests: '{count} 请求 · {rate}%',
        tokens: '输入 {in} / 输出 {out}',
        balance: '额外额度',
        belowThreshold: '额度已低于阈值',
        subCanceled: '订阅已取消，{date} 到期',
        subStatus: '订阅状态：{status}',
        billing: '查看套餐与额度',
        none: '该套餐未上报额度窗口',
        retry: '点击重试',
        stale: '上次成功：{age}前',
      },
      en: {
        fiveHour: '5-hour',
        weekly: 'Weekly',
        monthly: 'Monthly',
        left: 'left',
        remainingLabel: 'Remaining',
        reset: 'resets in {time}',
        overLimit: 'over limit',
        usedOf: '{label} used',
        requests: '{count} requests · {rate}%',
        tokens: 'in {in} / out {out}',
        balance: 'Extra credit',
        belowThreshold: 'credit is below the configured threshold',
        subCanceled: 'Subscription canceled, ends {date}',
        subStatus: 'Subscription: {status}',
        billing: 'View plans and credits',
        none: 'this plan reports no credit windows',
        retry: 'click to retry',
        stale: 'last success {age} ago',
      },
    }

    const CSS = `
.ccq-card{box-sizing:border-box;width:100%;margin:0 0 6px;padding:11px 13px 12px;border-radius:12px;
  border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-button-elevated-fill);
  color:var(--dsw-alias-label-primary);font-family:inherit;text-align:left;
  cursor:pointer;-webkit-user-select:none;user-select:none}
.ccq-card:hover{background:var(--dsw-alias-button-floating-hover)}
.ccq-card.ccq-stale{opacity:.62}
.ccq-head{display:flex;align-items:center;gap:6px;padding-bottom:8px;margin-bottom:10px;
  border-bottom:1px solid var(--dsw-alias-border-l1)}
.ccq-title{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;
  font-size:13px;font-weight:600;line-height:18px}
.ccq-plan{flex:none;padding:1px 6px;border-radius:6px;font-size:12px;line-height:16px;font-weight:500;
  background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-tertiary)}
.ccq-chevron{flex:none;color:var(--dsw-alias-label-caption);font-size:12px;line-height:18px;
  transition:transform 150ms ease}
.ccq-chevron.ccq-open{transform:rotate(180deg)}
.ccq-win+.ccq-win{margin-top:10px}
.ccq-winhead{display:flex;align-items:baseline;gap:8px}
.ccq-winlabel{flex:none;font-size:13px;line-height:18px;color:var(--dsw-alias-label-secondary)}
.ccq-spacer{flex:1;min-width:0}
.ccq-pct{flex:none;font-size:14px;font-weight:600;line-height:18px;font-variant-numeric:tabular-nums}
.ccq-reset{flex:none;padding:2px 7px;border-radius:6px;font-size:12px;line-height:16px;
  background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-tertiary);
  font-variant-numeric:tabular-nums;white-space:nowrap}
.ccq-track{position:relative;height:6px;margin-top:7px;border-radius:3px;overflow:hidden;
  background:var(--dsw-alias-interactive-bg-hover)}
.ccq-fill{display:block;height:100%;border-radius:3px;transition:width 240ms ease,background 240ms ease}
.ccq-warn{display:flex;align-items:center;gap:6px;margin-top:10px;padding:6px 8px;border-radius:7px;
  font-size:12px;line-height:17px;background:var(--dsw-alias-interactive-bg-hover-danger);
  color:var(--dsw-alias-state-error-primary)}
.ccq-detail{margin-top:11px;padding-top:9px;border-top:1px solid var(--dsw-alias-border-l1)}
.ccq-kv{display:flex;align-items:baseline;justify-content:space-between;gap:10px;
  font-size:12px;line-height:20px;color:var(--dsw-alias-label-secondary)}
.ccq-kv-label{flex:none;white-space:nowrap}
.ccq-kv-value{min-width:0;text-align:right;color:var(--dsw-alias-label-primary);
  font-variant-numeric:tabular-nums}
.ccq-note{margin-top:6px;padding-top:6px;border-top:1px solid var(--dsw-alias-border-l1);
  font-size:12px;line-height:18px;color:var(--dsw-alias-label-caption);
  font-variant-numeric:tabular-nums}
.ccq-note+.ccq-note{margin-top:1px;padding-top:0;border-top:none}
.ccq-link{display:inline-block;margin-top:8px;font-size:12px;line-height:17px;
  color:var(--dsw-alias-link);text-decoration:none}
.ccq-link:hover{text-decoration:underline}
.ccq-error{font-size:12px;line-height:18px;color:var(--dsw-alias-state-error-primary)}
.ccq-rail{box-sizing:border-box;width:36px;height:36px;border-radius:50%;display:flex;
  align-items:center;justify-content:center;font-size:12px;font-weight:600;
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

    /** Substitute `{name}` placeholders; the locale service owns the wording only. */
    function format(template, params) {
      return Object.entries(params ?? {})
        .reduce((text, [key, value]) => text.split(`{${key}}`).join(String(value)), String(template))
    }

    /** Native colour token for a used percentage; unknown reads as neutral. */
    function levelToken(percent) {
      if (percent === undefined) return 'var(--dsw-alias-label-caption)'
      const level = LEVELS.find((entry) => percent < entry.below)
      return level === undefined ? LEVELS[LEVELS.length - 1].token : level.token
    }

    function money(value) {
      return typeof value === 'number' && Number.isFinite(value) ? `$${value.toFixed(2)}` : '—'
    }

    /**
     * A percentage straight from the report, clamped into range.
     *
     * The host clamps too, but the card does not assume it: an over-drawn
     * window must never render as "107%", and a nonsensical negative must never
     * render as "-3%". The "over limit" chip carries that fact instead.
     */
    function percentOf(value) {
      if (typeof value !== 'number' || !Number.isFinite(value)) return undefined
      return Math.max(0, Math.min(100, value))
    }

    function percentText(value) {
      const clamped = percentOf(value)
      return clamped === undefined ? '—' : `${clamped.toFixed(1)}%`
    }

    /**
     * Glance value for the row headline: a whole percent, rounded the way the
     * official dashboard rounds. The underlying report keeps full precision, so
     * a card showing "100%" and a tooltip showing "99.8%" are the same truth at
     * two roundings — and the card never disagrees with the website's number.
     */
    function headlinePercent(value) {
      const clamped = percentOf(value)
      return clamped === undefined ? '—' : `${Math.round(clamped)}%`
    }

    function tokens(value) {
      if (typeof value !== 'number' || !Number.isFinite(value)) return '—'
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

    /** Terse countdown for the row chip: `59m`, `3h25m`, `6d9h`. */
    function shortCountdown(timestamp) {
      if (typeof timestamp !== 'number' || !Number.isFinite(timestamp)) return undefined
      const minutes = Math.floor((timestamp - Date.now()) / 60_000)
      if (minutes <= 0) return '0m'
      if (minutes < 60) return `${minutes}m`
      const hours = Math.floor(minutes / 60)
      if (hours < 24) return `${hours}h${minutes % 60}m`
      return `${Math.floor(hours / 24)}d${hours % 24}h`
    }

    /** Coarse age of a timestamp, for the stale marker. */
    function ageOf(timestamp) {
      if (typeof timestamp !== 'number' || !Number.isFinite(timestamp)) return undefined
      const minutes = Math.max(0, Math.floor((Date.now() - timestamp) / 60_000))
      if (minutes < 1) return '<1m'
      if (minutes < 60) return `${minutes}m`
      const hours = Math.floor(minutes / 60)
      return hours < 24 ? `${hours}h` : `${Math.floor(hours / 24)}d`
    }

    /**
     * Normalize the report's windows into one render shape.
     *
     * The host derives caps and percentages from the account's own plan, so a
     * plan that reports no window (pay-as-you-go Provider, say) yields no row.
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
          // Clamped at zero: the report keeps the vendor's raw figure, but a
          // negative "remaining" reads as a rendering bug on a plan card. An
          // overdrawn allowance is already saying "nothing left" through the
          // red bar and the 100% headline.
          remaining: used !== undefined && cap !== undefined ? Math.max(0, cap - used) : undefined,
          resetAt: key === 'monthly' ? periodEnd : source.resetAt,
          exceeded: source.exceeded === true,
        })
      }
      return rows
    }

    /** True when any reported window is close enough to its cap to poll faster. */
    function anyHot(report) {
      return windowsOf(report).some((row) => (row.percent ?? 0) >= HOT_PERCENT)
    }

    /** On-demand balance, for accounts that buy credit instead of holding an allowance. */
    function balanceOf(report) {
      const free = report?.monthly?.freeCredits
      const purchased = report?.monthly?.purchasedCredits
      if ((free ?? 0) === 0 && (purchased ?? 0) === 0) return undefined
      return { free: free ?? 0, purchased: purchased ?? 0 }
    }

    /** Everything worth warning about, in priority order. */
    function warningsOf(report, t) {
      const warnings = []
      if (report?.monthly?.belowThreshold === true) warnings.push(t('belowThreshold'))
      const plan = report?.plan
      if (plan?.cancelAtPeriodEnd === true) {
        warnings.push(format(t('subCanceled'), { date: when(Date.parse(plan.currentPeriodEnd)) ?? '—' }))
      } else if (plan?.status !== undefined && plan.status !== 'active') {
        warnings.push(format(t('subStatus'), { status: plan.status }))
      }
      return warnings
    }

    function describeError(result) {
      if (result !== null && typeof result === 'object' && typeof result.error?.message === 'string') {
        return result.error.message
      }
      return 'unrecognized response'
    }

    /**
     * Fetch the report, then keep fetching on a cadence that tightens while any
     * window is close to its cap. The last good report survives failures, so a
     * transient error dims the numbers instead of blanking the card.
     *
     * @param fetchQuota - transport callback injected by this plugin's apply.
     * @returns the current state plus a manual refresh.
     */
    function useQuota(fetchQuota) {
      const [state, setState] = React.useState({ phase: 'idle' })
      const [nonce, setNonce] = React.useState(0)

      React.useEffect(() => {
        const controller = new AbortController()
        let timer
        const load = () => {
          const fail = (message) => {
            setState((previous) => ({ phase: 'error', message, report: previous.report, at: previous.at }))
            timer = window.setTimeout(load, SLOW_MS)
          }
          // Promise.resolve() turns a synchronous throw from the transport into
          // a rejection, so the card reports it instead of unmounting.
          Promise.resolve()
            .then(() => fetchQuota(controller.signal))
            .then(
              (result) => {
                if (controller.signal.aborted) return
                if (result === null || typeof result !== 'object' || result.ok !== true) {
                  fail(describeError(result))
                  return
                }
                const value = result.value
                if (value !== null && typeof value === 'object' && value.configured === false) {
                  // This host does not use Command Code: stay invisible.
                  setState({ phase: 'absent' })
                  return
                }
                setState({ phase: 'ready', report: value, at: Date.now() })
                timer = window.setTimeout(load, anyHot(value) ? FAST_MS : SLOW_MS)
              },
              (error) => {
                if (controller.signal.aborted) return
                fail(String(error?.message ?? error))
              },
            )
        }
        load()
        return () => {
          window.clearTimeout(timer)
          controller.abort()
        }
      }, [fetchQuota, nonce])

      const refresh = React.useCallback(() => { setNonce((value) => value + 1) }, [])
      return { state, refresh }
    }

    /** One credit window: label, percentage, the meter, and the reset chip. */
    function WindowRow({ row, t }) {
      const percent = percentOf(row.percent)
      const color = levelToken(percent)
      const countdown = shortCountdown(row.resetAt)
      const tips = [
        row.used !== undefined && row.cap !== undefined
          ? `${format(t('usedOf'), { label: t(row.label) })} ${money(row.used)} / ${money(row.cap)}`
          : undefined,
        row.remaining !== undefined ? `${t('left')} ${money(row.remaining)}` : undefined,
        // The exact reset instant stays one hover away even though the row chip
        // only carries the countdown.
        row.resetAt === undefined ? undefined : when(row.resetAt),
      ].filter((part) => part !== undefined)
      const fill = Math.max(0, Math.min(100, percent ?? 0))
      const chip = row.exceeded ? t('overLimit') : countdown === undefined ? undefined : format(t('reset'), { time: countdown })
      // Each row carries its own tooltip: exact amounts, remaining credit, and
      // the absolute reset instant, none of which cost a line in the sidebar.
      return h('div', { className: 'ccq-win', title: tips.join(' · ') },
        h('div', { className: 'ccq-winhead' },
          h('span', { className: 'ccq-winlabel' }, t(row.label)),
          h('span', { className: 'ccq-spacer' }),
          chip === undefined ? null : h('span', { className: 'ccq-reset' }, chip),
          h('span', { className: 'ccq-pct', style: { color } }, headlinePercent(percent)),
        ),
        h('div', { className: 'ccq-track' },
          h('span', { className: 'ccq-fill', style: { width: `${fill}%`, background: color } }),
        ),
      )
    }

    /**
     * One label/value detail line; the label never shrinks, the value wraps.
     * @param props.tone - optional colour token for the value, used to let the
     * remaining credit carry the same urgency as the bar it belongs to.
     */
    function Detail({ label, value, tone }) {
      return h('div', { className: 'ccq-kv' },
        h('span', { className: 'ccq-kv-label' }, label),
        h('span', { className: 'ccq-kv-value', style: tone === undefined ? undefined : { color: tone } }, value),
      )
    }

    /**
     * Expanded body: the monthly allowance in money, then the period totals.
     *
     * Only the monthly window gets money. The rolling windows are pass/fail
     * limits, not budgets — their dollar figures tell a user nothing they can
     * act on, and the sidebar has no space to spend on decoration.
     *
     * Used and remaining are separate rows on purpose: the sidebar's content
     * width is about 200px, so a single "used / total · left" line wraps into
     * two ragged lines anyway — stating them as two rows reads as a deliberate
     * pair instead of as a broken line.
     */
    function detailRows(report, rows, t) {
      const body = []
      const monthly = rows.find((row) => row.key === 'monthly')
      if (monthly !== undefined && monthly.used !== undefined && monthly.cap !== undefined) {
        body.push(h(Detail, {
          key: 'monthly-used',
          label: format(t('usedOf'), { label: t(monthly.label) }),
          value: `${money(monthly.used)} / ${money(monthly.cap)}`,
        }))
      }
      if (monthly?.remaining !== undefined) {
        body.push(h(Detail, {
          key: 'monthly-left',
          label: t('remainingLabel'),
          value: money(monthly.remaining),
          // The number that decides whether the month still works carries the
          // same colour as the monthly bar.
          tone: levelToken(percentOf(monthly.percent)),
        }))
      }

      const balance = balanceOf(report)
      if (balance !== undefined) {
        body.push(h(Detail, {
          key: 'balance',
          label: t('balance'),
          value: `${money(balance.free)} · ${money(balance.purchased)}`,
        }))
      }

      const notes = []
      const totals = report?.totals
      if (totals?.requests !== undefined) {
        notes.push(format(t('requests'), {
          count: totals.requests.toLocaleString('en-US'),
          rate: totals.successRate ?? '—',
        }))
        notes.push(format(t('tokens'), { in: tokens(totals.tokensIn), out: tokens(totals.tokensOut) }))
      }
      for (const [index, note] of notes.entries()) {
        body.push(h('div', { key: `note-${String(index)}`, className: 'ccq-note' }, note))
      }
      body.push(h('a', {
        key: 'billing',
        className: 'ccq-link',
        href: BILLING_URL,
        target: '_blank',
        rel: 'noreferrer',
        onClick: (event) => { event.stopPropagation() },
      }, t('billing')))
      return body
    }

    /** Tooltip / rail summary: the percentages, which are the card's own headline. */
    function summaryTitle(rows, t) {
      return rows
        .map((row) => `${t(row.label)} ${percentText(row.percent)}${row.remaining === undefined ? '' : ` (${t('left')} ${money(row.remaining)})`}`)
        .join(' · ')
    }

    /** The 36px rail badge shown while the sidebar is collapsed. */
    function RailBadge({ state, t }) {
      if (state.report === undefined) return null
      const rows = windowsOf(state.report)
      // The most constrained window, not the shortest one: a collapsed rail has
      // room for a single number and the alarming one is the useful one.
      const headline = rows.reduce(
        (worst, row) => (worst === undefined || (row.percent ?? 0) > (worst.percent ?? 0) ? row : worst),
        undefined,
      )
      if (headline === undefined) return null
      return h('div', {
        className: 'ccq-rail',
        title: summaryTitle(rows, t),
        style: { color: levelToken(headline.percent) },
      }, `${(headline.percent ?? 0).toFixed(0)}%`)
    }

    /** The sidebar-foot card. */
    function QuotaCard(props) {
      const [open, setOpen] = React.useState(false)
      const { state, refresh } = useQuota(props.fetchQuota)
      const t = props.t

      // Nothing to say: this host does not use Command Code, or the first answer
      // has not arrived. Rendering nothing avoids an error box for non-users and
      // a flash of skeleton for everyone else.
      if (state.phase === 'absent' || state.phase === 'idle') return null
      if (props.wide === false) return h(RailBadge, { state, t })

      const report = state.report
      const rows = report === undefined ? [] : windowsOf(report)
      const stale = state.phase === 'error' && report !== undefined
      const planName = report?.plan?.name ?? 'Command Code'

      let body
      if (report === undefined) {
        body = [
          h('div', { key: 'error', className: 'ccq-error' }, state.message),
          h('div', { key: 'hint', className: 'ccq-error' }, t('retry')),
        ]
      } else if (rows.length === 0) {
        body = [h('div', { key: 'none', className: 'ccq-note' }, t('none'))]
      } else {
        body = [
          ...rows.map((row) => h(WindowRow, { key: row.key, row, t })),
          ...warningsOf(report, t).map((warning, index) => h('div', {
            key: `warn-${String(index)}`,
            className: 'ccq-warn',
          }, warning)),
        ]
      }

      return h('div', {
        className: `ccq-card${stale ? ' ccq-stale' : ''}`,
        title: rows.length === 0 ? undefined : summaryTitle(rows, t),
        onClick: () => {
          if (report === undefined) { refresh(); return }
          setOpen((value) => !value)
        },
      },
        h('div', { className: 'ccq-head' },
          h('span', { className: 'ccq-title' }, 'Command Code'),
          h('span', { className: 'ccq-plan' }, planName),
          h('span', { className: `ccq-chevron${open ? ' ccq-open' : ''}` }, '▾'),
        ),
        ...body,
        stale ? h('div', { className: 'ccq-note' }, format(t('stale'), { age: ageOf(state.at) ?? '—' })) : null,
        open && report !== undefined ? h('div', { className: 'ccq-detail' }, ...detailRows(report, rows, t)) : null,
      )
    }

    /**
     * Register this plugin's UI dictionaries and the card itself, the latter once
     * the sidebar declares the footer-action hole.
     * @param ctx - client plugin context.
     */
    function apply(ctx) {
      ensureStyles()
      ctx.effect(() => ctx.locale.register(NS, DICT), 'cc-quota: dictionaries')
      const t = ctx.locale.bind(NS)
      ctx.slots.inject('sidebar.footer.action', () => ctx.slots.register({
        name: 'sidebar.footer.action',
        id: 'cc-quota',
        order: 0,
        inject: () => ({
          fetchQuota: (signal) => ctx.connection.rpc.call(CHANNEL, ENDPOINT, {}, signal),
          t,
        }),
      }, QuotaCard))
    }

    exports.apply = apply
    exports.inject = ['slots', 'connection', 'locale']
    return module.exports
  },
})
