# Changelog

All notable changes to this project are documented here.

## [Unreleased] — 2026-09-26

The plugin is back in this repository. Its content — which had continued to be
developed in the shared `commandcode-usage` repository after the move — is merged
back here, at the repository root, and this repository is the standalone source
again. `package.json` still says `0.1.0`: that number is the npm package identity
and the cordis loader id, not a document version, so it does not move.

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
  and then the 141 offline checks in `scripts/verify.mjs`.
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
