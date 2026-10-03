/**
 * Smoke tests for the standalone CLI.
 *
 * The CLI is a separate entry point with its own argument parsing, its own exit
 * codes, and its own rendering — none of which the other suites touch. These run
 * it as a child process with an isolated DSH home, so they never reach the
 * network or a real credential.
 *
 * Run: node tests/cli.test.mjs
 */

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.dirname(here)
const cli = path.join(root, 'cli', 'cli.mjs')

let passed = 0
const check = (label, fn) => {
  fn()
  passed += 1
  console.log(`  ok  ${label}`)
}

/** Run the CLI with no credentials in sight. Pass a home to share one. */
function run(args, { home = mkdtempSync(path.join(os.tmpdir(), 'cc-quota-cli-')) } = {}) {
  const env = { ...process.env, DSH_HOME: home, USERPROFILE: home, HOME: home }
  for (const name of ['COMMANDCODE_API_KEY', 'COMMAND_CODE_API_KEY', 'CMD_API_KEY']) delete env[name]
  // Anything that matched the plugin's own discovery pattern would defeat the
  // point of the isolation, so the fallback scan gets nothing to find either.
  for (const name of Object.keys(env)) {
    if (/command_?code/i.test(name)) delete env[name]
  }
  return { ...spawnSync(process.execPath, [cli, ...args], { cwd: root, encoding: 'utf8', env }), output: '' }
}

console.log('standalone CLI')
{
  const help = run(['--help'])
  check('--help explains itself and exits cleanly', () => {
    assert.equal(help.status, 0)
    const text = `${help.stdout}${help.stderr}`
    assert.match(text, /cli\.mjs/)
    assert.match(text, /--json/)
    assert.match(text, /--watch/)
  })

  const missing = run([])
  check('no credential is a usage error with its own exit code', () => {
    const text = `${missing.stdout}${missing.stderr}`
    assert.equal(missing.status, 2, `exit code was ${String(missing.status)}`)
    assert.match(text, /MISSING_CREDENTIAL/)
  })

  const bogus = run(['--not-a-flag'])
  check('an unknown flag is rejected rather than ignored', () => {
    const text = `${bogus.stdout}${bogus.stderr}`
    assert.equal(bogus.status, 2)
    assert.match(text, /USAGE/)
  })

  const badTimeout = run(['--catalog-timeout', '0', '--models'])
  check('a nonsensical --catalog-timeout is refused, not silently defaulted', () => {
    const text = `${badTimeout.stdout}${badTimeout.stderr}`
    assert.equal(badTimeout.status, 2)
    assert.match(text, /--catalog-timeout/)
  })

  const helpFlags = run(['--help'])
  check('--help names every knob that bounds a network wait', () => {
    const text = `${helpFlags.stdout}${helpFlags.stderr}`
    assert.match(text, /--catalog-timeout/)
    // The usage text used to claim --models never touches the network; it does,
    // once, when there is no host snapshot to read the plan id from.
    assert.match(text, /--timeout/)
  })
}

console.log('catalog mode, offline')
{
  // `--plan` is what makes these deterministic: without it the CLI would ask the
  // API for the plan id before it can pick a table.
  const models = run(['--models', '--plan', 'individual-goat'])
  check('--models prints the shipped baseline table without a credential', () => {
    assert.equal(models.status, 0, `exit ${String(models.status)}: ${models.stderr}`)
    assert.match(models.stdout, /DeepSeek V4\.1 Flash/)
    // The figures are the vendor's own rounding, from the bundled seed.
    assert.match(models.stdout, /154,000/)
    assert.equal(models.stdout.includes('MISSING_CREDENTIAL'), false, 'catalog mode must not fail on a missing key')
  })

  const asJson = run(['--catalog-json', '--plan', 'individual-goat'])
  check('--catalog-json writes JSON and nothing else to stdout', () => {
    assert.equal(asJson.status, 0, `exit ${String(asJson.status)}: ${asJson.stderr}`)
    const parsed = JSON.parse(asJson.stdout)
    assert.equal(parsed.planId, 'individual-goat')
    assert.equal(parsed.planIdSource, 'flag')
    assert.ok(Array.isArray(parsed.models) && parsed.models.length > 0)
  })

  const allModels = run(['--models', '--all-models', '--plan', 'individual-goat'])
  check('--all-models includes rows the official table skips', () => {
    assert.equal(allModels.status, 0, `exit ${String(allModels.status)}: ${allModels.stderr}`)
    assert.match(allModels.stdout, /估算口径/)
  })

  const unknownPlan = run(['--models', '--plan', 'no-such-tier'])
  check('an unknown plan id is a usage error, exit 2', () => {
    assert.equal(unknownPlan.status, 2)
    assert.match(`${unknownPlan.stdout}${unknownPlan.stderr}`, /USAGE/)
  })
}

console.log(`\n${passed} checks passed`)
