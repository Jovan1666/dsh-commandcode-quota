/**
 * Documentation parity, and the one number the READMEs must not carry.
 *
 * README.md and README.zh-CN.md are translations of each other, so a change
 * made to one of them alone leaves the two languages saying different things.
 * That happened: a version requirement and a stale row count were corrected in
 * the Chinese file while the English one kept the old text, and nothing noticed
 * -- "the edit tool said it worked" is not a check. Every other suite reads
 * code; this one reads the two documents.
 *
 * It covers the mechanical half of parity: identical section structure,
 * identical examples, identical links, identical version claims. Whether two
 * paragraphs *mean* the same thing is not something a script can decide, so
 * prose is still a review matter -- but a paragraph added to one language and
 * not the other changes the section counts, and that is caught here.
 *
 * Run: node tests/docs.test.mjs
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.dirname(here)
const read = (name) => readFileSync(path.join(root, name), 'utf8')
const en = read('README.md')
const zh = read('README.zh-CN.md')

let passed = 0
const check = (label, fn) => {
  fn()
  passed += 1
  console.log(`  ok  ${label}`)
}

// Escapes rather than literals: this file stays ASCII so that no editor,
// console or shell in the chain can mangle the patterns it matches with.
const XIANG = '\u9879'
const LILIAN = '\u79bb\u7ebf'
const JIAOYAN = '\u6821\u9a8c'
const JIANCHA = '\u68c0\u67e5'

const headings = (t) => [...t.matchAll(/^(#{2,3})\s+\S/gm)].map((m) => m[1])
const fences = (t) => [...t.matchAll(/^```([A-Za-z]*)/gm)].map((m) => m[1] || 'plain')
const urls = (t) => new Set([...t.matchAll(/https?:\/\/[^\s)"'<>\]]+/g)].map((m) => m[0]))
const versions = (t) => new Set([...t.matchAll(/\d+\.\d+\.\d+(?:-[a-z0-9.]+)?/g)].map((m) => m[0]))

console.log('documentation parity (README.md vs README.zh-CN.md)')
{
  check('both READMEs describe the same sections, in the same shape', () => {
    const a = headings(en)
    const b = headings(zh)
    assert.ok(a.length >= 20, `expected at least 20 sections, found ${a.length}`)
    assert.equal(a.length, b.length, `${a.length} sections in English, ${b.length} in Chinese`)
    assert.equal(a.join(','), b.join(','), 'section levels differ between the two files')
  })

  check('both READMEs show the same examples', () => {
    const a = fences(en)
    const b = fences(zh)
    assert.equal(a.length, b.length, `${a.length} code blocks in English, ${b.length} in Chinese`)
    assert.deepEqual(a, b, 'the code blocks differ between the two files')
  })

  check('both READMEs link to the same places', () => {
    const a = urls(en)
    const b = urls(zh)
    const onlyEn = [...a].filter((u) => !b.has(u))
    const onlyZh = [...b].filter((u) => !a.has(u))
    assert.deepEqual(onlyEn, [], `links only in README.md: ${onlyEn.join(', ')}`)
    assert.deepEqual(onlyZh, [], `links only in README.zh-CN.md: ${onlyZh.join(', ')}`)
  })

  check('both READMEs make the same version claims', () => {
    const a = versions(en)
    const b = versions(zh)
    const onlyEn = [...a].filter((v) => !b.has(v))
    const onlyZh = [...b].filter((v) => !a.has(v))
    assert.deepEqual(onlyEn, [], `versions only in README.md: ${onlyEn.join(', ')}`)
    assert.deepEqual(onlyZh, [], `versions only in README.zh-CN.md: ${onlyZh.join(', ')}`)
  })

  check('neither README states an offline check count', () => {
    // It went 244 -> 280 -> 289 in a month and was wrong in every README that
    // quoted it, including one written while correcting the previous figure.
    // The count belongs to `node scripts/check.mjs`, which prints the one it
    // actually ran; see CHANGELOG 2026-10-26.
    const inEn = en.match(/\b\d{2,4}\s*(?:offline\s+)?checks?\b/i)
    assert.equal(inEn, null, `README.md quotes a check count: ${inEn?.[0]}`)
    const inZh = zh.match(new RegExp(`\\d{2,4}\\s*${XIANG}?\\s*(?:${LILIAN}\\s*)?(?:${JIAOYAN}|${JIANCHA})`))
    assert.equal(inZh, null, `README.zh-CN.md quotes a check count: ${inZh?.[0]}`)
  })
}

console.log(`\n${passed} checks passed`)