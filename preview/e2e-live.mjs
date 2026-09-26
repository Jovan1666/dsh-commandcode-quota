// One-shot live end-to-end check: boot the host half against a fake ctx and
// invoke the /quota command handler with the real credentials and API.
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const seen = {}
const ctx = {
  connection: { fetch: { register: (route) => { seen.route = route } } },
  logger: { info: () => {} },
  effect: (cb) => { const d = cb(); if (typeof d === 'function') seen.dispose = d },
  get: (n) => (n === 'commands' ? { register: (def) => { seen.command = def; return () => {} } } : undefined),
}
const plugin = await import(pathToFileURL(path.join(here, '..', 'index.js')).href)
plugin.apply(ctx)
const outcome = await seen.command.handler({ rawInput: '' })
console.log('--- /quota output ---')
console.log(outcome.kind === 'success' ? outcome.text : `ERROR: ${outcome.text}`)
console.log('--- cross-check against live report ---')
const response = await seen.route.fetch(new Request('http://x/api/cc-quota/report', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ type: 'client-request', rpcId: 'e2e', method: 'cc-quota/report', payload: {} }),
}))
const body = await response.json()
const m = body.result.value.monthly
const sum = m.used + m.remaining
console.log(`monthly exact: used=${m.used} remaining=${m.remaining} cap=${m.cap} percent=${m.percent.toFixed(4)}%`)
console.log(`sum check: used+remaining=${sum.toFixed(10)} vs cap=${m.cap.toFixed(10)} -> ${Math.abs(sum - m.cap) < 1e-9 ? 'MATCH' : 'MISMATCH'}`)
console.log(`headline rounding: ${Math.round(m.percent)}% (official dashboard displays the integer)`)
