# Changelog

All notable changes to this project are documented here.

## [Unreleased] — 2026-10-04

The section was slow to answer, and the reason was not the numbers: opening **Settings → Call counts**
awaited the vendor check inside the request, so the panel's first byte came after every docs-page round trip.
Measured with `NET_MS=300` per round trip: **1593 ms → 368 ms** on a cold profile, and a card poll's payload
**22 096 B → 1 056 B**.

### Fixed

- **The settings panel waited out the whole vendor check before drawing anything.** `catalogFor` awaited
  `syncCatalog` in the request path whenever the local copy was missing or a day old — 4 sequential round trips
  on a first run (HEAD+GET for two pages), 2 on every later check. The view is now built from local data and
  returned immediately, with `catalog.syncing: true` in it; the sync runs behind the answer, and only the
  explicit "check for updates" button waits (that is what pressing it means). The section shows
  *checking the official data in the background* and comes back for the result by itself — at most six times,
  then it stops asking rather than turning an open panel into a poll.
- **The check itself was four round trips where two will do.** Both pages' 0-byte ETag probes now go out
  together, and so do the two bodies, so a check that finds nothing new costs one round trip and a first sync
  costs two instead of four. `tests/catalog.test.mjs` proves the overlap with a fake server that will not answer
  the second probe until the first has arrived.
- **A failed check was retried on every single request, forever.** A round where no page parsed wrote no cache
  file at all — so `needsRevalidate` saw "no local copy" and asked again on the next request: three consecutive
  panel opens cost 4 catalog round trips each, and with a black-holed docs host one open took **80 s** (four
  20 s deadlines). The attempt is now recorded (`noData` + `checkedAt` + its failures) even when it produced
  nothing, and the host holds off for a few seconds before trying again.
- **A tier the vendor never published a page for was probed on every mount.** `individual-provider` and
  `teams-pro` can never appear in `plans`, so "the local copy has never carried this plan" stayed true no matter
  how often it was asked. The catalog now records those ids as `unpublished` and re-checks them on the TTL only.
- **Ultra could have been shown Max 10×'s figures.** The plan-level overview row was found by
  `label.startsWith(planName)`, and `Max 10×` is a prefix of `Max 20×` — so a row swap on the vendor's pricing
  page would have halved Ultra's plan-level allowance, plausibly and silently. The row is now looked up by plan
  id through `PLAN_LEVEL_LABELS`, which until now was dead code (Ultra, Provider and Teams Pro were getting no
  plan-level row at all).
- **A key pasted while the card was up could still see the previous account's numbers.** The snapshot path
  compares the credential fingerprint; the 15-second in-process cache did not, so switching keys (or plans)
  could be answered from the old account for the rest of the window. The cache entry carries its fingerprint now,
  and the fingerprint itself is memoized against a stat-based signature of the settings and credential files —
  cheaper per poll than the old path, and correct the moment a file or a candidate environment variable changes.
- **The card's poll carried a catalog it never reads** — 97 % of a 22 KB response, re-serialized and re-parsed
  every minute. The catalog is attached only when the caller asks for it (`catalog: true`, which is what the
  settings section sends).
- **`--refresh-catalog` could block for over a minute with no knob.** `syncCatalog` took no timeout, so the
  worst case was 4 × 20 s of docs-page deadlines on top of the plan probe's own `--timeout`. It takes
  `--catalog-timeout <ms>` now, and `--help` prints the value it will use. The same `--help` no longer claims
  `--models` never touches the network: with no host snapshot it asks the API once for the plan id (say `--plan`
  to avoid it).
- **A hot window that got a snapshot went quiet for a minute.** The snapshot branch took over the polling cadence
  outright, bypassing both the 15-second "close to the cap" rule and the 99.5 % ceiling; it now only replaces the
  *first* re-read.
- **The section could crash on a failed first read.** The error phase carries no catalog, and reading
  `catalog.syncing` off it threw during render — blanking the one screen that explains what went wrong, together
  with its retry button. Those reads are guarded now, so a failed first check leaves its error and the button
  visible.

### Tests

- 244 → 261 offline checks. The new ones are discriminating on purpose: the panel answers while the docs host is
  held open (so a blocking implementation cannot pass), two mounts join one check instead of starting another,
  an unreachable docs host is not re-probed by the next mount, a round that parsed nothing still writes its
  attempt, the two page probes provably overlap, Ultra reads Max 20× even when the rows are swapped, a key
  pasted inside the cache window is not served the old account, a first read that fails renders instead of
  throwing, and an endlessly "still checking" host is asked at most ten times. `tests/host.test.mjs` also had a
  check with an empty body (`the first read comes from upstream`) that could not fail; it asserts now.
- Verified on Node 18.20.4 and Node 24.13.0.
- The fixes were then merged back into the monorepo (`commandcode-usage`, `plugins/dsh`), which is the
  directory the live DSH profile actually loads this plugin from — the standalone repository is the
  distribution copy, and editing only that one changes nothing on screen. All 27 files on the release
  manifest are byte-identical between the two repositories again, and the suite is green in both.

## [Unreleased] — 2026-09-30

### Added

- **The plan's per-model allowances now live in Settings, not in a browser tab.** “What would this plan give
  me if I only ever called this model?” is answered by a new section in the host's settings dialog: every model
  the plan can call, with requests per 5 hours / week / month, the models the user configured first, and the
  plan-level headline kept visibly separate from the per-model figures. Models the plan page skips are filled in
  from the pricing page's own calculator (same vendor arithmetic, request shape derived from the provider like the
  site does, tagged *derived*), and the models the vendor gives away read `Free` rather than “not published”. The numbers are the vendor's own: the
  docs pages publish a per-model monthly budget, per-token rates and the request shape, then compute the counts
  client-side; `catalog.mjs` reproduces that arithmetic and rounds like the site, and the new `catalog` suite
  pins 244 rows across four plans against the numbers the vendor's own pages render.
- **The catalog checks for updates without downloading anything when nothing changed.** The docs pages ignore
  conditional requests (`If-None-Match` against an ETag the server just issued still answers `200`), so the sync
  sends `HEAD` for the page's ETag — 0 bytes — and fetches a body only when the ETag moved. One check a day at
  most, and only when the settings section is opened, plus a manual button; a baseline ships in the package so a
  first run or an offline host still has figures, marked as unsynced.
- **`node cli/cli.mjs --models`** prints the same table from the terminal, `--catalog-json` hands it to scripts,
  `--refresh-catalog` forces a check, and `/quota --models` does it in a conversation.

### Fixed

- **A slow Command Code cost the card three of its four readings, the monthly row
  among them, and all the card could say was `3 项数据这次没取到`.** The data layer
  gave every endpoint 15 seconds — a number chosen when a healthy read takes about
  one. While the vendor's data plane was degraded on 2026-09-30, its own
  `server-timing` header self-reported `total;dur=14018.0` for
  `/alpha/usage/summary`, against `dur=43.0` for `/alpha/billing/credits`: the
  15-second line sat *inside* the vendor's latency, so three readings were aborted
  locally while their data was seconds away. The default deadline is now 30 seconds
  — above the worst case measured, ~21 s — and `COMMANDCODE_QUOTA_TIMEOUT_MS` moves
  it (1 s–120 s) without waiting for a release.
- **A `200` response that reported a failure of its own was read as data,
  silently.** While degraded, `/alpha/billing/subscriptions` answers
  `200 {"success":false,"error":"write CONNECTION_CLOSED …"}`. The envelope parsed
  as a record with no `.data`, so the plan silently disappeared from the card *and*
  `failures` stayed empty — the one case the plugin's own "nothing silent" rule
  exists to prevent. A failure envelope is now a failed read: it is named in
  `failures` with the vendor's own message, and four of them classify as a service
  problem rather than a network one.

### Changed

- **The read deadline is a setting, not a constant.** `node cli/cli.mjs --timeout <ms>`
  still wins, `COMMANDCODE_QUOTA_TIMEOUT_MS` covers the no-flag case, and `--help`
  prints the value that will actually be used.

### Tests

- The catalog brought its own suite: 82 checks over the parser, the change detection (a 0-byte HEAD probe
  that must not download, an ETag that moved but whose body did not, a HEAD the gateway rejects), the seed's
  recomputability, and the view's honesty rules. The offline suite is now 244 checks. The earlier vendor-latency
  fix added five of them: a `200` failure envelope
  is a failed read, a slow endpoint that answers inside the deadline costs nothing,
  a reading past the deadline is dropped and named, the deadline can be moved
  through the environment, and the deadline variable is never mistaken for an API
  key.

## [Unreleased] — 2026-09-26

The plugin is back in this repository. Its content — which had continued to be
developed in the shared `commandcode-usage` repository after the move — is merged
back here, at the repository root, and this repository is the standalone source
again. `package.json` still says `0.1.0`: that number is the npm package identity
and the cordis loader id, not a document version, so it does not move.

### Fixed

- **The desktop app could never show the card, and said nothing about it.** The
  provider route was discovered by reading `$DSH_HOME/settings.yaml` only, but the
  Electron app migrates that file to `settings.yaml.imported` on first launch and
  writes user settings into the patch layers from then on
  (`$DSH_HOME/cordis.patch.yml`, `$DSH_HOME/profiles/<name>/cordis.patch.yml`). On
  every desktop install the host therefore answered `configured: false` — by design
  a card that renders nothing and reports no error, which is why "installed but
  invisible" had nothing to diagnose. Route discovery now scans both patch layers
  too; the indent scan already handled the shape, so only the candidate list grew.
- **A host without Command Code was asked exactly once, ever.** After
  `configured: false` the card went invisible and never polled again, so a provider
  added *after* the card mounted — the desktop migration above, a settings edit, a
  profile switch — stayed invisible for the rest of the session. It now re-checks
  every 5 minutes while absent (`ABSENT_MS`): still renders nothing, but a host that
  genuinely does not use Command Code pays one local round trip per 5 minutes.

### Added

- **A three-platform CI workflow**, `.github/workflows/check.yml`: Ubuntu, Windows
  and macOS × Node 18 and 22, `fail-fast: false`. It installs React 18 into
  `.devdeps/` (the component test and the preview page need it), runs
  `node scripts/check.mjs`, then smoke-tests the CLI's `--help` and the offline
  command paths.
- **`scripts/check.mjs`** — the release check this repository never had: every JSON
  file parses, every `.js`/`.mjs` passes `node --check`, no credential or
  machine-specific path is committed, the package identity is consistent across
  `package.json`, `package-lock.json`, `cordis.patch.yml` and `screenshots.json`,
  and then the 146 offline checks in `scripts/verify.mjs`.
- **`SECURITY.md`** — supported versions, private reporting, the exact list of what
  the plugin reads, writes and sends, and the credential-resolution order.
- **`package-lock.json`** — the React dependency tree, so CI installs what the
  manifest says.

### Changed

- **Merged everything the shared repository changed after the move.** The data
  layer grew 706 → 711 lines, the dynamic and client suites were extended, both
  READMEs were rewritten and expanded, and `package.json` gained `homepage`,
  `repository` and its `react`/`react-dom` dependencies.
- **The Pro plan's nominal allowance is `$80`, not `$30`.** The table in
  `quota.mjs` had it wrong, and the figure is not cosmetic: it feeds the
  sanity check that compares a freshly-read cap against the plan's nominal
  allowance. At `$30` a genuine `$80` cap sat 2.67× outside the ±25 % tolerance,
  and a Pro account lost its monthly percentage entirely. The Provider plan lost
  its `monthlyCredits` for the same class of reason — it is metered, `$15` is its
  price, not an allowance. The `dynamic` suite now tests the mixed-period refusal
  against a plan whose bands are far enough apart to be detectable.
- **`homepage` and `repository` point at this repository again** —
  `https://github.com/Jovan1666/dsh-commandcode-quota` — in `package.json`, the
  READMEs and the bundle patch's comment. The package name and the loader id are
  untouched.
- **The READMEs install from this repository.** The one-line install is
  `dsh plugin --profile web add github:Jovan1666/dsh-commandcode-quota`; the
  clone-based and the fully manual installs stay in the collapsed section.

### Fixed

- **Three documentation defects that came in with the merge.**
  The install block repeated the collapsed "From a local clone" section verbatim,
  so the one-line `github:` install is the primary again. The English README
  carried a whole Chinese section (`## 先确认 dsh 版本`) plus Chinese window labels
  in its table, while the Chinese README had that section missing entirely — it is
  now present in both languages. And the Chinese README listed the `$1` **Go** tier
  as supported, contradicting both the English text and the rest of the Chinese
  file, which say it has no API access.

### Kept

- **`screenshots.json`** (the storefront screenshot declaration) and
  **`.gitignore`** survived only here — the shared repository had neither — and
  both are back at the repository root, with the ignore rules written root-relative.

## [0.1.0] — 2026-09-19

Last published from this repository; tagged
[`v0.1.0-final`](https://github.com/Jovan1666/dsh-commandcode-quota/releases/tag/v0.1.0-final).
The work below ran 2026-09-17 → 2026-09-19.

### Added

- **The sidebar card.** 5-hour, weekly and monthly credit windows read live from
  Command Code's four read-only `/alpha` endpoints, rendered above the sidebar's
  Settings seat, with a percentage, a meter and a reset countdown per row.
- **The `/quota` command and the bilingual card.** The card follows the DSH
  interface language; a machine with no Command Code provider configured shows no
  card at all; `/quota` prints the same report as chat text, English, and never
  answers from a stale snapshot.
- **The storefront screenshot declaration** (`screenshots.json`), naming the image
  a marketplace should show.
- **Tests that assert the numbers stay right while they move** — a sampler that
  reads a real account repeatedly and checks the identity `used + remaining = cap`
  each time — and an assertion that the loader row keeps the package name.

### Changed

- **The cordis plugin name now matches the package name.** The loader row is
  `id: commandcode-quota`, `name: "dsh-commandcode-quota"`, so the troubleshooting
  URL `/plugins/<id>/client.js` and the install command point at the same string.
- **The card was cut back to what a user can act on.** Money is shown for the
  monthly allowance only; no pace verdict and no burn-rate forecast on the card
  (the host still exposes `projection` in its JSON for scripts).

### Performance

- **The card is on screen about 2 ms after a restart instead of about 1.4 s.** All
  four endpoints are now requested at once instead of awaiting `whoami` first, and
  the last good report is kept on disk so a cold start answers immediately —
  dimmed, labelled with its age — while a live read runs behind it.

### Fixed

- **The documented install path made dsh refuse to start.** The package declares a
  bundle patch, so `dsh plugin add` already registers the loader row; the README
  also told users to append that row to their profile, and two layers inserting one
  id fail at boot with `duplicate loader entry id`. The row now belongs to the
  manual install only, the `[]`-terminated profile file is described correctly, the
  uninstall steps actually remove the bundle, and `cli/` and `LICENSE` are in
  `files` so the documented CLI is installed.
- **The monthly figure no longer mixes two billing periods.** The cap is the sum of
  two figures from two endpoints; across a rollover they can describe different
  periods. The plan's nominal allowance is the sanity check, and when a read fails
  it the host reports no percentage at all and says why.
- **The data layer no longer states numbers the vendor never reported.** Window
  count, caps and percentages come from the API; a plan that reports no rolling
  windows renders no rows instead of plausible-looking zeros.
- **The plugin owns its route, and its snapshot belongs to one account.** The host
  half registers `cc-quota/report` on the shared `/api` transport itself instead of
  relying on host config, and the disk snapshot carries a short fingerprint of the
  credential so a snapshot from another account is not shown.
- **The card is readable at a glance, and honest about what it cannot say.** A row
  that disappears because its endpoint failed says so, and a total failure prints
  one readable line with the full diagnostic text on hover.
- **The READMEs' CLI sample no longer merges its bars into the line above** — the
  sample is shown with `--ascii`, whose glyphs do not depend on the font's block
  rendering.
- **The things a user would hit, found by walking through their day**: the
  troubleshooting table, the install/removal steps, the empty-panel state after a
  provider is removed, and the client-bundle 404 diagnosis.

### Docs and chores

- **The READMEs say which Command Code plan to buy and how to subscribe**, with
  the GOAT allowance, the peak-hour pricing caveat and the request-count estimate.
- **`.submission/` is ignored** — marketplace submission notes are working notes,
  not part of the plugin.
