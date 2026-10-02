/**
 * What is left of the course pages in this repository: redirect stubs.
 *
 * `make site` used to export every course and class page into site/c and
 * site/p, and Pages served them from colloq.ru. That export is retired: a
 * class page now carries PDFs, data and student outputs, and a public
 * repository's history cannot be withdrawn. What stays under site/c is a
 * hand-written pointer per course that was ever dictated to a group, so the
 * old link still leads somewhere.
 *
 * Each one must stay a pointer and nothing more: noindex (the course is given
 * by link, not to search engines), a meta refresh and a canonical to the same
 * address on the instance, a line a person can read and follow when refresh
 * is blocked, and no script.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import assert from 'node:assert/strict'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const COURSES = resolve(ROOT, 'site/c')

const stubs = existsSync(COURSES)
  ? readdirSync(COURSES, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
  : []

test('every course under site/c is a noindex redirect to its instance, and nothing else', () => {
  assert.ok(stubs.length > 0, 'site/c is gone: links dictated to a group lead to a 404')
  for (const name of stubs) {
    const dir = resolve(COURSES, name)
    // An exported page set came with step folders and blobs; a stub is one file.
    assert.deepEqual(readdirSync(dir), ['index.html'], `site/c/${name} holds more than its stub`)
    const html = readFileSync(resolve(dir, 'index.html'), 'utf8')
    assert.match(html, /<meta name="robots" content="noindex">/, `site/c/${name} lets search engines in`)
    const refresh = /<meta http-equiv="refresh" content="0; url=(https:\/\/[^"]+)">/.exec(html)
    assert.ok(refresh, `site/c/${name} does not redirect`)
    const target = refresh[1]
    assert.match(target, new RegExp(`^https://[a-z0-9.-]+/c/${name}$`), `site/c/${name} points elsewhere`)
    assert.ok(!/^https:\/\/(www\.)?colloq\.(ru|cc)\//.test(target), `site/c/${name} redirects to itself`)
    assert.ok(html.includes(`<link rel="canonical" href="${target}">`), `site/c/${name} has no canonical`)
    // Without refresh (a reader mode, a blocked meta) the person still has the address.
    const shown = target.replace(/^https:\/\//, '')
    assert.ok(html.includes(`<a href="${target}">${shown}</a>`), `site/c/${name} shows no address`)
    assert.ok(!/<script/i.test(html), `site/c/${name} runs a script`)
    // The mirror rewrites `.addr` text to colloq.cc; this address is not on that domain.
    assert.ok(!/class="addr"/.test(html), `site/c/${name} would be rewritten by the mirror`)
  }
})

test('the old export does not come back', () => {
  assert.ok(!existsSync(resolve(ROOT, 'site/p')), 'class pages are exported into the public repository again')
  assert.ok(!existsSync(resolve(ROOT, 'scripts/publish-site.mts')))
  assert.ok(!existsSync(resolve(ROOT, 'server/src/publish/export.ts')))
  assert.ok(!existsSync(resolve(ROOT, 'server/src/publish/render.ts')))
  const make = readFileSync(resolve(ROOT, 'Makefile'), 'utf8')
  assert.doesNotMatch(make, /^site:/m, 'make site is back')
  // A noindex page in a sitemap contradicts itself.
  const map = readFileSync(resolve(ROOT, 'site/sitemap.xml'), 'utf8')
  assert.doesNotMatch(map, /\/c\//, 'the sitemap lists a course stub')
})
