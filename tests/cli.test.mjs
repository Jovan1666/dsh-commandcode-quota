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

/** Run the CLI with no credentials in sight. */
function run(args) {
  const home = mkdtempSync(path.join(os.tmpdir(), 'cc-quota-cli-'))
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
}

console.log(`\n${passed} checks passed`)
