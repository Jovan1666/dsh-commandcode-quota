# Security Policy

## Supported versions

The latest commit on `main` is supported. Fixes land there; there are no backport
branches and no maintained older releases.

## Reporting a vulnerability

Report privately through GitHub: open the **Security** tab of
<https://github.com/Jovan1666/dsh-commandcode-quota> and choose **Report a
vulnerability**. If that channel is not available to you, open a normal issue that
says only that you have a security report and how to reach you — put no details in
the issue itself.

Say what you ran, what happened, and what you expected; a minimal reproduction is
worth more than a long description. This is a personal project maintained in spare
time, so expect an acknowledgement within a few days, and please hold public
disclosure until a fix is out.

## What this plugin does with your machine

| | |
|---|---|
| **Reads** | Your DSH config — the provider routes in `$DSH_HOME/settings.yaml` or a patch layer (`$DSH_HOME/cordis.patch.yml`, `$DSH_HOME/profiles/<name>/cordis.patch.yml`), and `$DSH_HOME/.credentials.yaml` for credential references — plus the official CLI's login state at `~/.commandcode/auth.json`, the credential environment variables listed below, and the public plan pages under `https://commandcode.ai/docs/` (the same pages a browser opens, with no credential attached). Nothing else. |
| **Writes** | Two files, both under `$DSH_HOME/dsh-commandcode-quota/` (directory `0700`, files `0600`): `last-report.json`, the snapshot the card shows, which carries a short non-reversible digest of the key so it can tell whether it belongs to the account currently configured; and `catalog.json`, the parsed per-model allowances, which holds no credential material at all. The key itself is never in either. Delete them any time; the plugin recreates them. |
| **Sends** | HTTPS to `https://api.commandcode.ai` with **your own** key, and to `https://commandcode.ai/docs/…` with no key at all. No other host appears in the code. |
| **Collects** | Nothing. No telemetry, no analytics, no error reporting, no identifiers. |
| **Install** | Runs nothing. No `postinstall` script, no downloaded code, no remote configuration. |

The API calls are four read-only GETs, all with your key: `/alpha/whoami`
(account name, org id), `/alpha/usage/summary` (credits used this period,
requests, tokens), `/alpha/billing/credits` (remaining credits, the 5-hour and
weekly windows) and `/alpha/billing/subscriptions` (plan id, billing period).
There is no other request and no public endpoint is read. Each endpoint degrades
on its own: a failure is recorded in the report and shown on the card instead of
being retried silently. Each endpoint also gets 30 seconds to answer —
`COMMANDCODE_QUOTA_TIMEOUT_MS` moves that, between 1 s and 120 s — and a reading
that misses the deadline is dropped and named in the report rather than replaced
with an older number. A `200` response that carries the vendor's own failure
envelope (`{"success":false,…}`) counts as a failed read too.

The per-model allowances in the settings panel come from those public docs pages, not from
your account: a check sends `HEAD` first and downloads a page only when its ETag says the
vendor changed it (about 200 KB, at most one check a day by default — `COMMANDCODE_CATALOG_TTL_MS`
moves that). Only the parsed numbers are stored, never the page.

### Host config

This plugin does **not** write any host config. It installs through DSH's own
plugin mechanism — `dsh plugin --profile web add …`, with the bundle patch at the
repository root registering the loader row — so the only thing that touches your
profile is the host itself. To remove it, `dsh plugin --profile web remove
dsh-commandcode-quota`; to clear the cached snapshot too, delete
`$DSH_HOME/dsh-commandcode-quota/`.

### The browser half

The card runs inside the host's renderer, so a bug here is a bug in a trusted
context. The client touches the DOM for exactly two things: injecting one
stylesheet keyed `.ccq-`, and rendering the card. It sends no request of its own —
it asks the host over the same-origin `/api` transport (fenced to loopback,
browser-session cookie required), and the host makes the upstream call. No
`localStorage`, no cookies, no direct network calls. Report anything that lets a
server response reach the DOM as markup rather than as text.

### Credentials

Your Command Code key is discovered in this order, and used for nothing except the
`Authorization` header of the four requests above:

1. An explicitly passed key — the CLI's `--key`.
2. **Discovered from your own DSH configuration**: any provider route whose
   `baseURL` points at `commandcode.ai`, read from `$DSH_HOME/settings.yaml` or a
   patch layer (`$DSH_HOME/cordis.patch.yml`, `$DSH_HOME/profiles/<name>/cordis.patch.yml`
   — the desktop app keeps its settings there). The plugin reads that route's literal
   `apiKey`, or its `apiKeyEnv` resolved through the environment and
   `$DSH_HOME/.credentials.yaml`.
3. Environment variables `COMMANDCODE_API_KEY`, `COMMAND_CODE_API_KEY`,
   `CMD_API_KEY`, then any variable whose name contains `commandcode`. The
   exceptions are this plugin's own `COMMANDCODE_QUOTA_TIMEOUT_MS` and
   `COMMANDCODE_CATALOG_TTL_MS`, which are millisecond counts and are never read
   as keys.
4. The same names inside `$DSH_HOME/.credentials.yaml` (`refs.<NAME>`).
5. `~/.commandcode/auth.json`, the official `command-code` CLI's login state.

A key is never written to a log, to the cache, or into anything the plugin
renders — the browser only ever receives the normalized report. Prefer the
environment variable over a literal in a config file that might get committed. If
you believe a key of yours is exposed, revoke it in your Command Code account
first — that is the only step that actually helps.

## Scope

In scope: anything in this repository that leaks a credential, sends data anywhere
other than `https://api.commandcode.ai`, writes outside the paths listed here, or
turns an untrusted input (a settings file, an API response, a config value) into
code execution.

Out of scope: the Command Code API itself; DeepSeek Harness and its plugin
mechanism; and anything that requires an attacker who already holds your key or
your shell.

## Requirements

The plugin requires `dsh >= 0.1.5-rc.1` and the **web** profile. On an older host
the plugin does not load, which is the intended failure — better a plugin that
refuses than a card that renders nothing.
