/**
 * dsh-commandcode-quota browser half.
 *
 * Registers one card into the sidebar-owned `sidebar.footer.action` list slot,
 * which the sidebar shell renders directly above the Settings seat in both
 * sidebar widths. The card asks the host for a quota report over the exact Fetch
 * route this plugin's host half registers on the shared `/api` transport, and
 * renders every credit window the account reports.
 *
 * It also registers one section into the settings panel's `settings.section`
 * list slot: the plan × model call-count table. That answers a different
 * question — roughly how many calls each model allows — which belongs where a
 * user goes to think about configuration, not in the always-visible sidebar.
 * Both halves read the same report; only the section looks at its `catalog`
 * field, and it hides itself when the host is too old to send one.
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
    /**
     * Cadence after the host answers with a snapshot instead of a live read.
     *
     * The host serves its last good report immediately on a cold start so the
     * card can paint at once; a refresh is already running behind that answer.
     * Waiting the usual minute for it would waste the one moment the user is
     * actually looking at the card.
     */
    const REVALIDATE_MS = 3_000
    /**
     * Cadence while the host says a catalog check is still running.
     *
     * The settings section paints from local data at once and the host does the
     * official check behind that answer, so the page the user is looking at is
     * real but one check behind. This is how often it comes back to see whether
     * the check landed. It is bounded: see {@link SYNCING_MAX_TRIES}.
     */
    const SYNCING_MS = 2_000
    /**
     * How many times the settings section will come back for a running check.
     *
     * Each re-read also asks the host "is a check due?", so a host that keeps
     * answering `syncing: true` — a docs site that cannot be reached, a check
     * stuck behind its own timeout — must not turn an open settings page into a
     * poll. Six tries is about half a minute of waiting, which is longer than a
     * healthy check takes and short enough that a broken one stops asking; the
     * button below stays available for anyone who wants to try again by hand.
     */
    const SYNCING_MAX_TRIES = 6
    /**
     * Cadence while the host answers `configured: false` — it has no Command Code
     * provider, so the card stays invisible but still looks again, slowly.
     *
     * The alternative (never asking again) turns a fixable configuration gap into
     * a permanent one: a provider added after this component mounted — the
     * desktop app's first-run migration of `settings.yaml`, a settings edit, a
     * profile switch — would leave the card hidden for the rest of the session,
     * with nothing in the UI to explain why, since an absent card renders no
     * error either. Five minutes costs one local IPC round trip when the host
     * really does not use Command Code.
     */
    const ABSENT_MS = 5 * 60_000
    /** Used percentage at which a window counts as "hot" for polling purposes. */
    const HOT_PERCENT = 85
    /**
     * Above this, a window is spent rather than approaching.
     *
     * Polling faster cannot change what the card would say: an exhausted
     * allowance only moves when someone consumes credit, and the remaining
     * movement is the reset, which the countdown already covers. Without this
     * ceiling an account sitting at 99.8 % — a state that lasts for days near the
     * end of a period — would poll every 15 seconds indefinitely.
     */
    const SPENT_PERCENT = 99.5
    /** Where to send someone who needs more credit. */
    const BILLING_URL = 'https://commandcode.ai/pricing'

    const LEVELS = [
      { below: 60, color: 'var(--dsw-alias-state-success-primary)' },
      { below: 85, color: 'var(--dsw-alias-state-warn-primary)' },
      { below: Number.POSITIVE_INFINITY, color: 'var(--dsw-alias-state-error-primary)' },
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
        straddle: '本次读数跨了计费周期，下次刷新会校正',
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
        degraded: '{count} 项数据这次没取到，稍后自动重试',
        retry: '点击重试',
        stale: '上次成功：{age}前',
        errNetwork: '连不上 Command Code',
        errAuth: 'API key 被拒绝了',
        errRate: '请求太频繁，稍后自动重试',
        errNotFound: '当前套餐不含 API 权限',
        errGeneric: '读取失败',

        // Settings-panel section: the plan-level overview, the per-model table,
        // and every line that qualifies them. Nothing here may imply a number
        // the official site never published — see formatCount().
        nav: '调用次数',
        title: '模型调用次数',
        intro: '当前套餐下，每个模型大概还能调用多少次。数字按官方的模型额度、单价和一次典型请求的用量换算，仅供参考。',
        loading: '正在读取官方次数表…',
        planFallback: '当前套餐',
        planLevel: '套餐级额度',
        planLevelNote: '套餐额度是所有模型共享的总额；单模型次数是「这个模型单独用满额度」的换算值。两者官方口径不同（算法不同），不能互相推算。',
        basis: '换算基准：一次请求约 输入 {in} / 输出 {out} / 缓存读 {cache} tokens。',
        inferred: '官方没有这一档的专页，按 {from} 的数据推断。',
        colModel: '模型',
        colMonthly: '每月',
        colFiveHour: '5 小时',
        colWeek: '每周',
        notGiven: '官方未给',
        dashNote: '「—」表示官方没有公布这个模型的次数，不是 0 次。',
        freeNote: '「Free」是官方标注的免费/不限量，不是我们算出来的数字。',
        derivedNote: '按官方 provider 默认形状推算',
        peak: '峰时：每月 {monthly} · 5 小时 {fiveHour} · 每周 {week}',
        requestsFallback: '约 {count} 次请求',
        expand: '展开全部 {count} 个模型',
        collapse: '收起，只看你配置的模型',
        noConfigured: '没能识别出你配置的模型，下面是这个套餐的全部 {count} 个模型。',
        coverage: '官方次数表覆盖 {published} 个模型，这个套餐可用 {available} 个。',
        empty: '这个套餐暂时没有可显示的模型次数。',
        statusBundled: '内置基线，尚未同步：这些次数来自插件自带的快照，可能已经落后于官方。',
        statusNever: '从未核对过官方数据。',
        statusStale: '已超过 24 小时未核对（上次核对 {time}）。',
        statusChecked: '上次核对 {time}。',
        statusSyncing: '正在后台核对官方数据…（页面先显示本地已有的一份）',
        statusUpdated: '官方数据更新于 {time}。',
        fetchModeHash: '本机用不了官方的 HEAD 校验，改用整篇比对（仍然只在内容变了时重新解析）。',
        failureHead: '{count} 项这次没核对成功：',
        errRefresh: '检查更新失败：{message}',
        refresh: '检查更新',
        refreshing: '正在检查…',
        docLink: '查看官方套餐与限额文档',
        warnPlanMissing: '官方目录里没有这个套餐的条目。',
        warnPlanNotListed: '官方目录里没有 {planId} 这一档。',
      },
      en: {
        fiveHour: '5-hour',
        weekly: 'Weekly',
        monthly: 'Monthly',
        left: 'left',
        remainingLabel: 'Remaining',
        straddle: 'this reading straddles a billing boundary; the next refresh corrects it',
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
        degraded: '{count} reading(s) unavailable this time; retrying shortly',
        retry: 'click to retry',
        stale: 'last success {age} ago',
        errNetwork: 'cannot reach Command Code',
        errAuth: 'the API key was rejected',
        errRate: 'too many requests; retrying shortly',
        errNotFound: 'this plan has no API access',
        errGeneric: 'could not read the account',

        // Settings-panel section; see the zh block for the reasoning.
        nav: 'Call counts',
        title: 'Model call counts',
        intro: 'Roughly how many calls each model allows on the current plan. Estimated from the official model allowance, token prices, and one typical request — a reference, not a limit.',
        loading: 'Reading the official call table…',
        planFallback: 'Current plan',
        planLevel: 'Plan allowance',
        planLevelNote: 'The plan allowance is shared by every model; a per-model count is what that model alone would get from it. The official site computes the two differently, so neither can be derived from the other.',
        basis: 'Basis: one request ≈ {in} in / {out} out / {cache} cache-read tokens.',
        inferred: 'There is no official page for this tier; these numbers are inferred from the {from} data.',
        colModel: 'Model',
        colMonthly: 'Monthly',
        colFiveHour: '5-hour',
        colWeek: 'Weekly',
        notGiven: 'not published',
        dashNote: '“—” means the official table publishes no figure for this model. It does not mean zero.',
        freeNote: '“Free” is the site’s own wording for a free/unlimited model, not a number we computed.',
        derivedNote: 'derived from the provider default shape',
        peak: 'Peak: {monthly} monthly · {fiveHour} 5-hour · {week} weekly',
        requestsFallback: '~{count} requests',
        expand: 'Show all {count} models',
        collapse: 'Collapse to your configured models',
        noConfigured: 'Could not tell which models you configured, so all {count} models on this plan are shown.',
        coverage: 'The official table covers {published} models; {available} are available on this plan.',
        empty: 'This plan has no model counts to show right now.',
        statusBundled: 'Bundled baseline, not synced yet: these counts come from the snapshot shipped with the plugin and may already lag behind the official site.',
        statusNever: 'Never checked against the official data.',
        statusStale: 'Not checked for more than 24 hours (last check {time}).',
        statusChecked: 'Last checked {time}.',
        statusSyncing: 'Checking the official data in the background… (showing the local copy meanwhile)',
        statusUpdated: 'Official data updated {time}.',
        fetchModeHash: 'This machine cannot use the site’s HEAD check, so the host compares whole documents (it still re-parses only when the content changed).',
        failureHead: '{count} item(s) failed this check:',
        errRefresh: 'Check failed: {message}',
        refresh: 'Check for updates',
        refreshing: 'Checking…',
        docLink: 'View the official plans and limits docs',
        warnPlanMissing: 'The official catalog has no entry for this plan.',
        warnPlanNotListed: 'The official catalog has no {planId} tier.',
      },
    }

    const CSS = `
.ccq-card{box-sizing:border-box;width:100%;margin:0 0 6px;padding:11px 13px 12px;border-radius:12px;
  border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-button-elevated-fill);
  color:var(--dsw-alias-label-primary);font-family:inherit;text-align:left;
  cursor:pointer}
.ccq-card:hover{background:var(--dsw-alias-button-floating-hover)}
.ccq-card.ccq-stale{opacity:.62}
/* Selection stays off the toggle target only: a drag across the header should not
   read as a click, while the expanded figures must remain copyable into a ticket. */
.ccq-head{display:flex;align-items:center;gap:6px;padding-bottom:8px;margin-bottom:10px;
  -webkit-user-select:none;user-select:none;
  border-bottom:1px solid var(--dsw-alias-border-l1)}
.ccq-title{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;
  font-size:13px;font-weight:600;line-height:18px}
.ccq-plan{flex:none;max-width:104px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;
  padding:1px 6px;border-radius:6px;font-size:12px;line-height:16px;font-weight:500;
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
  font-variant-numeric:tabular-nums;border:none;background:transparent}
/* --- settings section ---
   The sidebar card's rules above are sized for a 200px column. The settings
   panel is wide with 24px padding, so this block sets its own scale and caps
   the line length: a table stretched across a 1600px window is worse to read
   than one at 760px, and the numbers stay paired with their model name. */
.ccq-sec{box-sizing:border-box;width:100%;text-align:left;
  color:var(--dsw-alias-label-primary);font-family:inherit;font-size:13px;line-height:20px}
.ccq-sec-title{margin:0;font-size:16px;font-weight:500;line-height:24px}
.ccq-sec-intro{margin:4px 0 0;font-size:14px;line-height:22px;color:var(--dsw-alias-label-tertiary)}
.ccq-panel{margin-top:12px;padding:12px 14px;border-radius:var(--dsw-radius-xl);
  border:.5px solid var(--dsw-alias-settings-card-stroke);background:var(--dsw-alias-settings-card-fill)}
.ccq-sec .ccq-note{margin-top:8px}
.ccq-sec .ccq-warn{margin-top:8px}
/* The settings nav draws its own icon before the section label, picked from a
   hard-coded table of built-in ids; a plugin's own mark therefore arrives as the
   label's first child, and the built-in fallback has to be hidden — otherwise the
   row shows a gear and an hourglass side by side. */
.ccq-navmark{display:inline-flex;align-items:center;gap:6px;vertical-align:-3px}
button:has(.ccq-navmark)>svg:first-child{display:none}
.ccq-table-wrap{margin-top:10px;overflow-x:auto}
.ccq-table{width:100%;border-collapse:collapse;font-size:13px;line-height:18px}
.ccq-table th,.ccq-table td{padding:7px 8px;border-bottom:.5px solid var(--dsw-alias-border-l2)}
.ccq-table thead th{font-size:12px;font-weight:500;color:var(--dsw-alias-label-caption);white-space:nowrap}
.ccq-table tbody tr:last-child th,.ccq-table tbody tr:last-child td{border-bottom:none}
.ccq-table .ccq-num{text-align:right;white-space:nowrap;font-variant-numeric:tabular-nums}
.ccq-th-model{text-align:left}
.ccq-model{text-align:left;font-weight:500;color:var(--dsw-alias-label-primary)}
.ccq-tag{margin-left:6px;padding:1px 6px;border-radius:6px;font-size:11px;line-height:15px;
  font-weight:400;background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-tertiary)}
.ccq-actions{display:flex;align-items:center;gap:12px;flex-wrap:wrap;margin-top:12px}
.ccq-btn{appearance:none;box-sizing:border-box;padding:6px 12px;border-radius:8px;
  border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-button-elevated-fill);
  color:var(--dsw-alias-label-primary);font:inherit;font-size:12px;line-height:16px;cursor:pointer}
.ccq-btn:hover:not(:disabled){background:var(--dsw-alias-button-floating-hover)}
.ccq-btn:disabled{opacity:.6;cursor:default}
.ccq-fold{appearance:none;margin-top:10px;padding:0;border:none;background:none;
  color:var(--dsw-alias-link);font:inherit;font-size:12px;line-height:18px;cursor:pointer;text-align:left}
.ccq-fold:hover{text-decoration:underline}
.ccq-sec .ccq-link{margin-top:0}
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
      return level === undefined ? LEVELS[LEVELS.length - 1].color : level.color
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
      // A reset instant that has already passed leaves nothing to count down to.
      // `0m 后重置` beside unmoving numbers reads as a frozen card, so the chip
      // goes away; the tooltip still carries the absolute instant.
      const minutes = Math.floor((timestamp - Date.now()) / 60_000)
      if (minutes <= 0) return undefined
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
          // Set by the host when the two endpoints behind the monthly figures
          // cannot both describe the same instant. The figures are forwarded
          // as-is, but nothing built from them may be presented as fact.
          capSuspect: key === 'monthly' && source.capSuspect === true,
        })
      }
      return rows
    }

    /**
     * True when some window is close enough to its cap to poll faster.
     *
     * "Close to" excludes "past": see {@link SPENT_PERCENT}.
     */
    function anyHot(report) {
      return windowsOf(report).some((row) => {
        const percent = percentOf(row.percent)
        return percent !== undefined && percent >= HOT_PERCENT && percent < SPENT_PERCENT
      })
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
     * Turn a host error message into something readable in a 200 px sidebar.
     *
     * The host's message is diagnostic — it names endpoints and status codes —
     * which is right for a log and wrong for a card: a wall of stacked lines in a
     * narrow column reads as a rendering bug. Known codes become one short line,
     * the full text stays one hover away, and an unknown code falls back to the
     * message itself, because a card that says nothing is worse than one that says
     * something clumsy.
     */
    function errorText(message, t) {
      const code = /^\[([A-Z_]+)\]/.exec(String(message ?? ''))?.[1]
      const keys = {
        NETWORK: 'errNetwork',
        SERVICE: 'errNetwork',
        AUTH: 'errAuth',
        RATE_LIMIT: 'errRate',
        NOT_FOUND: 'errNotFound',
        BAD_RESPONSE: 'errGeneric',
        MISSING_CREDENTIAL: 'errGeneric',
      }
      const key = keys[code]
      return key === undefined ? String(message ?? '') : t(key)
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
        // How many answers in a row have been snapshots. The first one earns a
        // quick re-read — a live report is already on its way, and this is the
        // moment the user is actually looking at the card. If they keep coming,
        // the host is having trouble upstream and hammering it every few seconds
        // would help nobody.
        let staleStreak = 0
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
                  // This host does not use Command Code: stay invisible, but ask
                  // again on a slow cadence rather than never — see ABSENT_MS.
                  setState({ phase: 'absent' })
                  timer = window.setTimeout(load, ABSENT_MS)
                  return
                }
                setState({ phase: 'ready', report: value, at: Date.now() })
                const isSnapshot = value.stale === true
                staleStreak = isSnapshot ? staleStreak + 1 : 0
                // A window that is burning keeps its cadence even when the report
                // is a snapshot: the snapshot branch used to win outright, so a
                // hot account could sit a whole minute on stale numbers after one
                // snapshot, and the spent-window ceiling was skipped entirely.
                const settled = anyHot(value) ? FAST_MS : SLOW_MS
                timer = window.setTimeout(
                  load,
                  isSnapshot
                    ? (staleStreak === 1 ? REVALIDATE_MS : settled)
                    : settled,
                )
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
        row.capSuspect ? t('straddle') : undefined,
        !row.capSuspect && row.used !== undefined && row.cap !== undefined
          ? `${format(t('usedOf'), { label: t(row.label) })} ${money(row.used)} / ${money(row.cap)}`
          : undefined,
        !row.capSuspect && row.remaining !== undefined ? `${t('left')} ${money(row.remaining)}` : undefined,
        // The exact reset instant stays one hover away even though the row chip
        // only carries the countdown.
        row.resetAt === undefined ? undefined : when(row.resetAt),
      ].filter((part) => part !== undefined)
      const chip = row.exceeded ? t('overLimit') : countdown === undefined ? undefined : format(t('reset'), { time: countdown })
      // Each row carries its own tooltip: exact amounts, remaining credit, and
      // the absolute reset instant, none of which cost a line in the sidebar.
      return h('div', { className: 'ccq-win', title: tips.join(' · ') },
        h('div', { className: 'ccq-winhead' },
          h('span', { className: 'ccq-winlabel' }, t(row.label)),
          h('span', { className: 'ccq-spacer' }),
          chip === undefined ? null : h('span', { className: 'ccq-reset' }, chip),
          // The number keeps the card's text colour. The state greens and ambers
          // are fill colours — on a white card the green lands near 2.3:1, under
          // the 4.5:1 a 14px headline needs — and the meter below shows the level.
          h('span', { className: 'ccq-pct' }, headlinePercent(percent)),
        ),
        // A zero-width meter under `—` reads as "0% used", so no percentage means
        // no meter.
        percent === undefined ? null : h('div', { className: 'ccq-track' },
          h('span', {
            className: 'ccq-fill',
            style: { width: `${Math.max(0, Math.min(100, percent))}%`, background: color },
          }),
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
      const trustMonthly = monthly !== undefined && monthly.capSuspect !== true
      if (trustMonthly && monthly.used !== undefined && monthly.cap !== undefined) {
        body.push(h(Detail, {
          key: 'monthly-used',
          label: format(t('usedOf'), { label: t(monthly.label) }),
          value: `${money(monthly.used)} / ${money(monthly.cap)}`,
        }))
      }
      if (trustMonthly && monthly?.remaining !== undefined) {
        body.push(h(Detail, {
          key: 'monthly-left',
          label: t('remainingLabel'),
          value: money(monthly.remaining),
          // The number that decides whether the month still works carries the
          // same colour as the monthly bar.
          tone: levelToken(percentOf(monthly.percent)),
        }))
      }
      if (monthly !== undefined && monthly.capSuspect === true) {
        // Say why the numbers went away instead of leaving a bare dash: the
        // read straddled a period boundary, and the next poll will fix it.
        body.push(h('div', { key: 'straddle', className: 'ccq-note' }, t('straddle')))
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
        .map((row) => (row.capSuspect
          ? `${t(row.label)} ${t('straddle')}`
          : `${t(row.label)} ${percentText(row.percent)}${row.remaining === undefined ? '' : ` (${t('left')} ${money(row.remaining)})`}`))
        .join(' · ')
    }

    /** The 36px rail badge shown while the sidebar is collapsed. */
    function RailBadge({ state, t }) {
      if (state.report === undefined) return null
      const rows = windowsOf(state.report)
      // The most constrained window, not the shortest one: a collapsed rail has
      // room for a single number and the alarming one is the useful one. Rounded
      // before comparing, so two rows that both read `60%` cannot make the badge
      // flip colour between refreshes.
      const headline = rows.reduce(
        (worst, row) => (worst === undefined || Math.round(row.percent ?? 0) > Math.round(worst.percent ?? 0) ? row : worst),
        undefined,
      )
      if (headline === undefined) return null
      return h('div', {
        className: 'ccq-rail',
        title: summaryTitle(rows, t),
        style: { color: levelToken(headline.percent) },
      }, headlinePercent(headline.percent))
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
      // Two ways to be showing something other than a live reading: an answer
      // the host marked as its last snapshot, and a failed refresh after a good
      // one. Both dim the numbers and say how old they are — never silently.
      const stale = state.phase === 'error' ? report !== undefined : report?.stale === true
      const staleAt = report?.stale === true && typeof report.staleAgeMs === 'number'
        ? Date.now() - report.staleAgeMs
        : state.at
      const planName = report?.plan?.name ?? 'Command Code'

      let body
      if (report === undefined) {
        // The short line is what a user can act on; the host's own diagnostic
        // message stays on the tooltip for whoever is debugging.
        body = [
          h('div', { key: 'error', className: 'ccq-error', title: state.message }, errorText(state.message, t)),
          h('div', { key: 'hint', className: 'ccq-error' }, t('retry')),
        ]
      } else if (rows.length === 0) {
        body = [h('div', { key: 'none', className: 'ccq-note' }, t('none'))]
      } else {
        const degraded = Array.isArray(report.failures) ? report.failures.length : 0
        body = [
          ...rows.map((row) => h(WindowRow, { key: row.key, row, t })),
          ...warningsOf(report, t).map((warning, index) => h('div', {
            key: `warn-${String(index)}`,
            className: 'ccq-warn',
          }, warning)),
          // A window that silently disappears because its endpoint failed is a
          // bug the user would blame on their account. Say it happened.
          degraded === 0 ? null : h('div', { key: 'degraded', className: 'ccq-note' }, format(t('degraded'), { count: degraded })),
        ].filter((part) => part !== null)
      }

      const toggle = () => {
        if (report === undefined) { refresh(); return }
        setOpen((value) => !value)
      }

      return h('div', {
        className: `ccq-card${stale ? ' ccq-stale' : ''}`,
        title: [rows.length === 0 ? undefined : summaryTitle(rows, t)]
          .concat(report?.failures?.length > 0 ? [`⚠ ${report.failures.join(' · ')}`] : [])
          .filter((part) => part !== undefined)
          .join('\n'),
        role: 'button',
        tabIndex: 0,
        'aria-expanded': report !== undefined && open,
        onClick: toggle,
        onKeyDown: (event) => {
          if (event.key !== 'Enter' && event.key !== ' ') return
          event.preventDefault()
          toggle()
        },
      },
        h('div', { className: 'ccq-head' },
          h('span', { className: 'ccq-title' }, 'Command Code'),
          h('span', { className: 'ccq-plan', title: planName }, planName),
          h('span', { className: `ccq-chevron${open ? ' ccq-open' : ''}` }, '▾'),
        ),
        ...body,
        stale ? h('div', { className: 'ccq-note' }, format(t('stale'), { age: ageOf(staleAt) ?? '—' })) : null,
        open && report !== undefined ? h('div', { className: 'ccq-detail' }, ...detailRows(report, rows, t)) : null,
      )
    }

    /**
     * The site's own number formatting, copied from the host half's `catalog.mjs`.
     *
     * A browser half cannot import a Node module, so this is a deliberate copy
     * rather than a shared helper: **keep it in sync with `formatCount` in
     * `catalog.mjs`** — `toPrecision(3)` through `toLocaleString('en-US')`, `Free`
     * for a model the site prices as unlimited, and `—` for a count the official
     * table never published. Printing `0` where the table is silent would claim a
     * model cannot be called at all. A free model's counts arrive as `null` —
     * JSON has no `Infinity` — and reach this function as `Infinity` through
     * {@link countOf}.
     *
     * @param value - a raw count from the host's catalog view.
     * @returns the display text.
     */
    function formatCount(value) {
      if (value === undefined || value === null) return '—'
      if (!Number.isFinite(value)) return 'Free'
      if (value <= 0) return '0'
      return Number(value.toPrecision(3)).toLocaleString('en-US')
    }

    /**
     * Translator for the settings section.
     *
     * The settings shell owns the props it hands a section — `close`, `t`,
     * `renderSlot`, `useStore` and `actions` are its names, never ours — so the
     * section reads this binding to the plugin's own `cc-quota` namespace instead
     * of claiming a prop. `apply()` installs it before registering the section,
     * and it stays the live reader the locale service returned, so the panel
     * follows a language switch like the sidebar card does.
     */
    let sectionT = (key) => key

    /** The first argument that is a non-empty string, or undefined. */
    function firstString(...values) {
      return values.find((value) => typeof value === 'string' && value !== '')
    }

    /** Timestamps arrive as ISO strings from the catalog and as epoch ms elsewhere. */
    function whenValue(value) {
      const ms = typeof value === 'number' ? value : typeof value === 'string' ? Date.parse(value) : Number.NaN
      return Number.isFinite(ms) ? when(ms) : undefined
    }

    /**
     * True when the official table publishes no count for this model.
     *
     * `estimated === false` is the host's own signal (a model the plan can use
     * but the call table does not cover); the data check behind it is only a
     * fallback for a host that predates that field. A free model is never
     * "missing" — see {@link countOf}.
     */
    function noCount(model) {
      if (model === null || typeof model !== 'object') return false
      if (model.estimated === false) return true
      if (model.estimated !== undefined) return false
      const absent = (value) => value === undefined || value === null
      return model.free !== true && absent(model.monthly) && absent(model.fiveHour) && absent(model.week)
    }

    /**
     * One count as `formatCount` should see it.
     *
     * A free model's counts arrive as `null` — JSON has no `Infinity` — with the
     * model's own `free` flag carrying the meaning. `formatCount` owns the `Free`
     * wording, so the substitution happens here rather than in a second copy of
     * that function.
     */
    function countOf(model, key) {
      if (model?.free === true) return Number.POSITIVE_INFINITY
      return model?.[key]
    }

    /**
     * Normalize one host answer for the settings section.
     *
     * Three answers must never be presented as "your plan has no models": a host
     * whose report predates the catalog field (`hidden`), a host with no Command
     * Code provider at all (`absent`), and a failure (`error`, keeping whatever
     * the section already had). Everything else renders.
     *
     * @param result - the `server-response` envelope the host returns.
     * @param previous - the catalog already on screen, carried across failures.
     * @returns the section's next state.
     */
    function catalogState(result, previous) {
      if (result === null || typeof result !== 'object' || result.ok !== true) {
        return { phase: 'error', message: describeError(result), catalog: previous }
      }
      const value = result.value
      if (value !== null && typeof value === 'object' && value.configured === false) {
        return { phase: 'absent' }
      }
      const catalog = value !== null && typeof value === 'object' ? value.catalog : undefined
      if (catalog === null || typeof catalog !== 'object') {
        // Older host: the report carries no catalog. Hiding is the one honest
        // answer — an empty panel would look like a statement about the plan.
        return { phase: 'hidden' }
      }
      return { phase: 'ready', catalog }
    }

    /**
     * Catalog reads for the settings section.
     *
     * Deliberately not the sidebar card's poll. A settings page is opened on
     * purpose and can be left open for a long time, and every catalog read costs
     * upstream requests against the same account the user is coding on: one read
     * when the section mounts, one per explicit "check for updates" — plus, while
     * the host says a check is still running (`catalog.syncing`), a local re-read
     * every couple of seconds so the fresh numbers appear on their own instead of
     * the user having to guess when to press the button.
     *
     * @param props - the section's injected face (`fetchQuota`, `refreshQuota`).
     * @returns the current state, whether a check is running, and the trigger.
     */
    function useCatalog(props) {
      const [state, setState] = React.useState({ phase: 'loading' })
      const [refreshing, setRefreshing] = React.useState(false)
      // The transport lives in a ref: a shell that hands over a fresh injected
      // face on every render must not make the mount read run again.
      const transport = React.useRef(props)
      transport.current = props
      // A user-pressed check outlives a single render, so its cancellation token
      // lives with the component: unmounting the section must not leave the
      // request running with nothing left to receive its answer.
      const refreshController = React.useRef(null)

      React.useEffect(() => {
        const controller = new AbortController()
        // Shared by the initial read and every "the host is still checking"
        // re-read, so unmounting cancels whichever one is pending.
        let timer
        // How many answers in a row have said a check is still running. Bounded
        // on purpose: every re-read asks the host whether a check is due, so an
        // unbounded loop here would be a request loop, not a wait.
        let syncingStreak = 0
        const read = () => {
          // Promise.resolve() turns a synchronous throw from the transport into
          // a rejection, so a broken face reports itself instead of unmounting.
          Promise.resolve()
            .then(() => transport.current.fetchQuota(controller.signal))
            .then(
              (result) => {
                if (controller.signal.aborted) return
                setState((previous) => catalogState(result, previous.catalog))
                // The host answered from local data while its check runs behind
                // that answer: come back for the result rather than leave the
                // page one check behind for as long as it stays open.
                const catalog = result !== null && typeof result === 'object' && result.ok === true
                  ? result.value?.catalog
                  : undefined
                const running = catalog !== null && typeof catalog === 'object' && catalog.syncing === true
                syncingStreak = running ? syncingStreak + 1 : 0
                if (running && syncingStreak <= SYNCING_MAX_TRIES) {
                  timer = window.setTimeout(read, SYNCING_MS)
                }
              },
              (error) => {
                if (controller.signal.aborted) return
                setState((previous) => ({
                  phase: 'error',
                  message: String(error?.message ?? error),
                  catalog: previous.catalog,
                }))
              },
            )
        }
        read()
        return () => {
          window.clearTimeout(timer)
          controller.abort()
          refreshController.current?.abort()
        }
      }, [])

      const refresh = React.useCallback(() => {
        refreshController.current = new AbortController()
        setRefreshing(true)
        Promise.resolve()
          .then(() => transport.current.refreshQuota(refreshController.signal))
          .then(
            (result) => {
              if (refreshController.signal.aborted) return
              setState((previous) => catalogState(result, previous.catalog))
              setRefreshing(false)
            },
            (error) => {
              if (refreshController.signal.aborted) return
              // A failed check keeps the numbers: they are still the last thing
              // the official table said, and blanking them would destroy the only
              // information the user came for.
              setState((previous) => ({ ...previous, refreshError: String(error?.message ?? error) }))
              setRefreshing(false)
            },
          )
      }, [])

      return { state, refreshing, refresh }
    }

    /** Human wording for one warning code from the host's catalog view. */
    function warningText(code, t) {
      if (typeof code !== 'string' || code === '') return undefined
      // Already stated by the provenance line, in full sentences.
      if (code === 'catalog-bundled-baseline') return undefined
      if (code === 'catalog-plan-missing') return t('warnPlanMissing')
      if (code.startsWith('catalog-plan-not-listed:')) {
        return format(t('warnPlanNotListed'), { planId: code.slice('catalog-plan-not-listed:'.length) })
      }
      // An unrecognised code is still a fact; show it rather than swallow it.
      return code
    }

    /**
     * Everything that qualifies the numbers, in the order a reader needs it:
     * where the data came from, how fresh it is, then what this check could not
     * read. Nothing here may be skipped — a silent gap is what makes a user
     * blame their own account.
     */
    function catalogStatus(catalog, t) {
      const lines = []
      // A check is running behind this answer: say so first, because it explains
      // why the numbers below may be one check old and why they may change by
      // themselves in a moment.
      if (catalog.syncing === true) {
        lines.push({ key: 'syncing', tone: 'note', text: t('statusSyncing') })
      }
      const checked = whenValue(catalog.checkedAt)
      if (catalog.origin === 'bundled' || catalog.verified !== true) {
        lines.push({ key: 'bundled', tone: 'warn', text: t('statusBundled') })
      }
      if (catalog.neverSynced === true) {
        lines.push({ key: 'never', tone: 'warn', text: t('statusNever') })
      } else if (catalog.stale === true) {
        lines.push({
          key: 'stale',
          tone: 'warn',
          text: checked === undefined ? t('statusNever') : format(t('statusStale'), { time: checked }),
        })
      } else if (checked !== undefined) {
        lines.push({ key: 'checked', tone: 'note', text: format(t('statusChecked'), { time: checked }) })
      }
      const updated = whenValue(catalog.updatedAt)
      if (updated !== undefined) {
        lines.push({ key: 'updated', tone: 'note', text: format(t('statusUpdated'), { time: updated }) })
      }
      // A host whose machine cannot use the site's conditional HEAD request falls
      // back to comparing whole documents. That is a working mode, not a failure:
      // one quiet line, no warning colour.
      if (catalog.fetchMode === 'hash') {
        lines.push({ key: 'fetch-mode', tone: 'note', text: t('fetchModeHash') })
      }
      if (firstString(catalog.inferredFrom) !== undefined) {
        lines.push({
          key: 'inferred',
          tone: 'note',
          text: format(t('inferred'), { from: catalog.inferredFrom }),
        })
      }
      const failures = Array.isArray(catalog.failures) ? catalog.failures : []
      if (failures.length > 0) {
        lines.push({ key: 'failures', tone: 'warn', text: format(t('failureHead'), { count: failures.length }) })
        for (const [index, failure] of failures.entries()) {
          // Name the item: "something failed" is not actionable, a URL and a
          // status code are.
          const code = firstString(failure?.code) ?? t('errGeneric')
          const message = firstString(failure?.message) ?? ''
          const url = firstString(failure?.url)
          lines.push({
            key: `failure-${String(index)}`,
            tone: 'warn',
            text: url === undefined ? `${code}: ${message}` : `${code}: ${message} — ${url}`,
          })
        }
      }
      for (const [index, code] of (Array.isArray(catalog.warnings) ? catalog.warnings : []).entries()) {
        const text = warningText(code, t)
        if (text !== undefined) lines.push({ key: `warning-${String(index)}`, tone: 'note', text })
      }
      return lines
    }

    /** One model row: the name, then the three counts, right-aligned. */
    function ModelRow({ model, t }) {
      const name = firstString(model?.name, model?.key) ?? '—'
      const tips = []
      const modelId = firstString(model?.modelId)
      if (modelId !== undefined) tips.push(modelId)
      const peak = model?.peak
      // A free model has no peak/off-peak distinction to draw: every hour is free.
      if (peak !== null && typeof peak === 'object' && model?.free !== true) {
        // Peak-time pricing only ever reaches a tooltip: the site shows the
        // off-peak shape by default and this section follows the site.
        tips.push(format(t('peak'), {
          monthly: formatCount(peak.monthly),
          fiveHour: formatCount(peak.fiveHour),
          week: formatCount(peak.week),
        }))
      }
      return h('tr', { title: tips.length === 0 ? undefined : tips.join(' · ') },
        h('th', { scope: 'row', className: 'ccq-model' },
          name,
          noCount(model) ? h('span', { className: 'ccq-tag' }, t('notGiven')) : null,
          model.derived === true ? h('span', { className: 'ccq-tag', title: t('derivedNote') }, t('derivedNote')) : null,
        ),
        h('td', { className: 'ccq-num' }, formatCount(countOf(model, 'monthly'))),
        h('td', { className: 'ccq-num' }, formatCount(countOf(model, 'fiveHour'))),
        h('td', { className: 'ccq-num' }, formatCount(countOf(model, 'week'))),
      )
    }

    /** The per-model table: what one model alone would get out of the plan. */
    function ModelTable({ models, t }) {
      return h('div', { className: 'ccq-table-wrap' },
        h('table', { className: 'ccq-table' },
          h('thead', null,
            h('tr', null,
              h('th', { scope: 'col', className: 'ccq-th-model' }, t('colModel')),
              h('th', { scope: 'col', className: 'ccq-num' }, t('colMonthly')),
              h('th', { scope: 'col', className: 'ccq-num' }, t('colFiveHour')),
              h('th', { scope: 'col', className: 'ccq-num' }, t('colWeek')),
            ),
          ),
          h('tbody', null, ...models.map((model, index) => h(ModelRow, {
            key: firstString(model?.key) ?? `model-${String(index)}`,
            model,
            t,
          }))),
        ),
      )
    }

    /**
     * This section's own mark: an hourglass, at the size and stroke the built-in
     * icons use (16px box, 1.3 stroke, single `currentColor`, no fill).
     *
     * It reads as "how much of the allowance is left to spend", which is what the
     * section is about, and it is the one shape in this icon set that nothing else
     * uses — the alternative the host offers is a fallback gear, and borrowing a
     * built-in id would put the wrong label next to someone else's picture.
     */
    function CcqCallsMark({ size = 16 }) {
      return h('svg', {
        width: size,
        height: size,
        viewBox: '0 0 16 16',
        fill: 'none',
        xmlns: 'http://www.w3.org/2000/svg',
        'aria-hidden': 'true',
        strokeWidth: 1.3,
      },
        h('path', { d: 'M3.9 2.5H12.1L8 7L3.9 2.5Z', stroke: 'currentColor' }),
        h('path', { d: 'M3.9 13.5H12.1L8 9L3.9 13.5Z', stroke: 'currentColor' }),
        h('circle', { cx: 8, cy: 5.6, r: 1.15, fill: 'currentColor', stroke: 'none' }),
      )
    }

    /**
     * The settings-panel section: what the current plan allows per model.
     *
     * The shell gives its body vertical scroll and 24px of padding and draws no
     * heading of its own, so this component brings its own title. The default
     * view is the models the user configured; the official table also covers
     * models they do not use, which stay one click away rather than in the way.
     */
    function QuotaSettingsSection(props) {
      const t = sectionT
      const [expanded, setExpanded] = React.useState(false)
      const { state, refreshing, refresh } = useCatalog(props)

      if (state.phase === 'loading') {
        return h('section', { className: 'ccq-sec' },
          h('h2', { className: 'ccq-sec-title' }, t('title')),
          h('div', { className: 'ccq-note' }, t('loading')),
        )
      }
      if (state.phase === 'hidden' || state.phase === 'absent') return null

      const catalog = state.catalog
      // A first read can fail outright, in which case there is no catalog to read
      // flags off — and the section still has to render its error line and the
      // retry button, so nothing below may assume one exists.
      const syncing = catalog?.syncing === true
      const rows = Array.isArray(catalog?.models) ? catalog.models : []
      const configured = rows.filter((model) => model?.configured === true)
      // Only the configured models are hidden, so the fold is worth offering
      // exactly when there is something else to show.
      const foldable = configured.length > 0 && configured.length < rows.length
      const visible = expanded || configured.length === 0 ? rows : configured
      const level = catalog?.planLevel
      const basis = catalog?.basis
      const doc = firstString(catalog?.docUrl, level?.sourceUrl)
      const errorMessage = state.phase === 'error' ? state.message : state.refreshError
      const planName = firstString(catalog?.planName, catalog?.planId) ?? t('planFallback')

      const levelParts = []
      if (level !== null && typeof level === 'object') {
        const label = firstString(level.label)
        const credits = typeof level.credits === 'number' && Number.isFinite(level.credits)
          ? `$${level.credits.toLocaleString('en-US')}`
          : firstString(level.credits)
        const requests = firstString(level.requestsText)
          ?? (typeof level.requests === 'number' && Number.isFinite(level.requests)
            ? format(t('requestsFallback'), { count: formatCount(level.requests) })
            : undefined)
        // The pricing table's own label is usually the plan name again; printing
        // "GOAT · GOAT" reads as a rendering bug, not as emphasis.
        levelParts.push(
          ...[label === planName ? undefined : label, credits, requests].filter((part) => part !== undefined),
        )
      }

      const coverage = catalog?.coverage
      const published = typeof coverage?.published === 'number' ? coverage.published : 0
      const available = typeof coverage?.available === 'number' ? coverage.available : 0

      // A failed first read has no catalog to describe: the error line and the
      // button are then the whole story. A plan panel, a provenance line or a
      // "no counts" note would describe data nobody has.
      const panels = catalog === undefined ? [] : [
        // Plan-level first, and explicitly labelled as a different measurement:
        // the two numbers on this page are the two the site refuses to convert.
        h('div', { key: 'plan', className: 'ccq-panel' },
          h(Detail, {
            label: t('planLevel'),
            value: levelParts.length === 0 ? planName : `${planName} · ${levelParts.join(' · ')}`,
          }),
          h('div', { key: 'level-note', className: 'ccq-note' }, t('planLevelNote')),
          basis === null || typeof basis !== 'object' ? null : h('div', { key: 'basis', className: 'ccq-note' },
            format(t('basis'), {
              in: formatCount(basis.inputTokens),
              out: formatCount(basis.outputTokens),
              cache: formatCount(basis.cacheReadTokens),
            })),
        ),
        ...catalogStatus(catalog, t).map((line) => h('div', {
          key: line.key,
          className: line.tone === 'warn' ? 'ccq-warn' : 'ccq-note',
        }, line.text)),
        h('div', { key: 'models', className: 'ccq-panel' },
          // An empty table is still an explanation, never a blank block.
          rows.length === 0
            ? h('div', { className: 'ccq-note' }, t('empty'))
            : h(ModelTable, { models: visible, t }),
          configured.length === 0 && rows.length > 0
            ? h('div', { key: 'no-config', className: 'ccq-note' }, format(t('noConfigured'), { count: rows.length }))
            : null,
          foldable ? h('button', {
            key: 'fold',
            type: 'button',
            className: 'ccq-fold',
            'aria-expanded': expanded,
            onClick: () => setExpanded((value) => !value),
          }, expanded ? t('collapse') : format(t('expand'), { count: rows.length })) : null,
          visible.some(noCount) ? h('div', { key: 'dash', className: 'ccq-note' }, t('dashNote')) : null,
          visible.some((model) => model?.free === true)
            ? h('div', { key: 'free', className: 'ccq-note' }, t('freeNote'))
            : null,
          published + available === 0 ? null : h('div', { key: 'coverage', className: 'ccq-note' },
            format(t('coverage'), { published: String(published), available: String(available) })),
        ),
      ]

      return h('section', { className: 'ccq-sec' },
        h('h2', { className: 'ccq-sec-title' }, t('title')),
        h('p', { className: 'ccq-sec-intro' }, t('intro')),
        ...panels,
        errorMessage === undefined ? null : h('div', { className: 'ccq-error', title: errorMessage },
          state.phase === 'error'
            ? errorText(errorMessage, t)
            : format(t('errRefresh'), { message: errorText(errorMessage, t) })),
        state.phase === 'error' ? h('div', { className: 'ccq-note' }, t('retry')) : null,
        h('div', { className: 'ccq-actions' },
          h('button', {
            type: 'button',
            className: 'ccq-btn ccq-refresh',
            // Also held while a background check is running: the host refuses to
            // start a second one, so an enabled button would look like it did
            // nothing.
            disabled: refreshing || syncing,
            onClick: refresh,
          }, refreshing || syncing ? t('refreshing') : t('refresh')),
          doc === undefined ? null : h('a', {
            className: 'ccq-link',
            href: doc,
            target: '_blank',
            rel: 'noreferrer',
          }, t('docLink')),
        ),
      )
    }

    /**
     * Register this plugin's UI dictionaries, its settings section, and the card
     * itself — the latter once the sidebar declares the footer-action hole.
     * @param ctx - client plugin context.
     */
    function apply(ctx) {
      ensureStyles()
      ctx.effect(() => ctx.locale.register(NS, DICT), 'cc-quota: dictionaries')
      const t = ctx.locale.bind(NS)
      // The settings section reads this binding instead of a `t` prop: see sectionT.
      sectionT = t

      // Settings panel: one section on the same ledger as the built-in sections,
      // ordered after every one of them (account -10 … agent-presets 20).
      //
      // The nav row renders `navIcon(id)` first and the label after it, and the icon
      // lookup is a hard-coded table that only knows the built-in ids — a plugin has
      // no `icon` option and gets the fallback gear. The label, however, is rendered
      // as a React child, so it is the one channel a plugin has for its own mark:
      // the node below carries our icon, and the stylesheet hides the gear.
      ctx.slots.inject('settings.section', () => ctx.slots.register({
        name: 'settings.section',
        id: 'commandcode-quota',
        order: 100,
        label: () => h('span', { className: 'ccq-navmark' }, h(CcqCallsMark, { size: 16 }), t('nav')),
        locale: NS,
        inject: () => ({
          // `payload` is optional; the default `{ catalog: true }` lets the host
          // decide whether the catalog has aged out and needs a re-check, and the
          // answer carries the resulting view. Without it a section mount would
          // return the cache forever: the card's own poll never re-validates.
          fetchQuota: (signal, payload) => ctx.connection.rpc.call(CHANNEL, ENDPOINT, payload ?? { catalog: true }, signal),
          refreshQuota: (signal) => ctx.connection.rpc.call(CHANNEL, ENDPOINT, { catalogRefresh: true }, signal),
        }),
      }, QuotaSettingsSection))

      // The sidebar card registers last on purpose: the offline client suite reads
      // the most recent registration as "the card" and asserts its slot contract.
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
