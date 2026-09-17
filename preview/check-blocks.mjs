/**
 * Reproduce how GitHub renders the README's CLI and `/quota` samples, to check
 * them against the browser's monospace font stack.
 *
 * The samples carry no box-drawing characters on purpose — a bar built from
 * full-height block glyphs sits flush against the neighbouring line of text in
 * many code fonts, which is exactly how this README looked before — so what is
 * worth checking here is wrapping, and that the columns still line up without
 * depending on the font's idea of a cell.
 *
 * Run: node preview/check-blocks.mjs   then screenshot preview/blocks.html.
 */

import { readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.dirname(here)

/** Pull every fenced block out of a README. */
function fencedBlocks(markdown) {
  const blocks = []
  const pattern = /```[a-z]*\r?\n([\s\S]*?)```/g
  let match
  while ((match = pattern.exec(markdown)) !== null) blocks.push(match[1].replace(/\n$/, ''))
  return blocks
}

// Both READMEs: checking only the English one left the Chinese samples — which
// are the ones a Chinese-speaking user reads — entirely unverified.
const sources = ['README.md', 'README.zh-CN.md'].map((name) => ({
  name,
  blocks: fencedBlocks(readFileSync(path.join(root, name), 'utf8'))
    // Matched by content rather than by the characters they used to contain: the
    // samples are plain text now, and a filter for box glyphs would match nothing.
    .filter((block) => /^Command Code · /m.test(block)),
}))
const blocks = sources.flatMap((source) => source.blocks.map((block) => ({ name: source.name, block })))

// A checker that finds nothing to check must not report success: on a CRLF
// checkout the fence pattern used to match zero blocks and say so quietly, which
// reads exactly like a pass. (It also has to tolerate CRLF, since that is what a
// Windows checkout produces.)
if (blocks.length === 0) {
  console.error('check-blocks: found no CLI sample in README.md / README.zh-CN.md — nothing was checked.')
  process.exit(1)
}

const html = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><title>code block check</title>
<style>
  body{margin:0;padding:16px;background:#fff;width:1000px}
  h2{font:600 14px/1.4 -apple-system,'Segoe UI',sans-serif;margin:0 0 6px}
  pre{
    /* GitHub's code font stack, verbatim. */
    font-family:ui-monospace,SFMono-Regular,"SF Mono",Menlo,Consolas,"Liberation Mono",monospace;
    font-size:12px;line-height:1.45;margin:0 0 20px;padding:16px;background:#f6f8fa;
    border-radius:6px;overflow-x:auto;white-space:pre;color:#1f2328;
  }
  .ruler{position:relative;height:0;border-top:1px dashed #d00;margin:-4px 0 20px}
</style></head><body>
${blocks.map((entry, index) => `<h2>${entry.name} · block ${String(index)} — ${String(entry.block.split('\n').length)} lines</h2><pre>${entry.block.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c])}</pre>`).join('\n')}
</body></html>`

writeFileSync(path.join(here, 'blocks.html'), html, 'utf8')
console.log(`wrote preview/blocks.html with ${String(blocks.length)} block(s)`)
