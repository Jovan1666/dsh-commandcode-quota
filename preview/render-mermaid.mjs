/**
 * Render every mermaid block from the READMEs in a real browser, so GitHub's
 * diagram rendering is verified locally instead of discovered broken.
 *
 * Run: node preview/render-mermaid.mjs   then screenshot preview/mermaid.html.
 */

import { readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.dirname(here)
const mermaidDist = path.join(root, '.devdeps', 'node_modules', 'mermaid', 'dist', 'mermaid.min.js')

/** Pull every ```mermaid block out of a README. */
function mermaidBlocks(markdown) {
  const blocks = []
  const pattern = /```mermaid\r?\n([\s\S]*?)```/g
  let match
  while ((match = pattern.exec(markdown)) !== null) blocks.push(match[1])
  return blocks
}

const blocks = [
  ...mermaidBlocks(readFileSync(path.join(root, 'README.md'), 'utf8')),
  ...mermaidBlocks(readFileSync(path.join(root, 'README.zh-CN.md'), 'utf8')),
]

const html = `<!doctype html>
<html><head><meta charset="utf-8"><title>mermaid check</title>
<style>body{margin:0;padding:12px;background:#fff;font-family:-apple-system,'Segoe UI',sans-serif}
h3{font:600 13px/1.5 sans-serif;margin:0 0 8px;color:#333}
section{margin-bottom:18px;padding-bottom:12px;border-bottom:1px solid #eee}
.err{color:#b00;font:12px/1.5 monospace;white-space:pre-wrap}</style>
</head><body>
${blocks.map((_, index) => `<section><h3>diagram ${String(index)}</h3><div id="d${String(index)}"></div></section>`).join('\n')}
<script src="file://${mermaidDist.replaceAll('\\', '/')}"></script>
<script>
  const SOURCES = ${JSON.stringify(blocks)}
  mermaid.initialize({ startOnLoad: false, theme: 'default' })
  ;(async () => {
    for (let i = 0; i < SOURCES.length; i += 1) {
      const target = document.getElementById('d' + i)
      try {
        const { svg } = await mermaid.render('svg' + i, SOURCES[i])
        target.innerHTML = svg
      } catch (error) {
        target.innerHTML = '<div class="err">RENDER FAILED\\n' + String(error && error.message || error) + '</div>'
      }
    }
    document.title = 'done'
  })()
</script>
</body></html>`

writeFileSync(path.join(here, 'mermaid.html'), html, 'utf8')
console.log(`wrote preview/mermaid.html with ${String(blocks.length)} diagram(s)`)
