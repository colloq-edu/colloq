/**
 * The landing page is opened from places where Google does not answer.
 *
 * The colloq.ru page is the only thing people read before signing in at all,
 * and they read it from a university network with no way out and from Russia,
 * where external CDNs have been blocked before. While the monospace font came
 * from fonts.googleapis.com, the terminal in the hero was drawn in a system
 * font with different widths — the command stopped fitting on its line, and
 * this could not be seen from the author's machine.
 *
 * What is checked is not "it got faster" but a fact: the page no longer goes
 * anywhere for fonts, everything it preloads it actually has and actually sets
 * text in, and the fallback font is split into two DIFFERENT names and named
 * by face names — otherwise there is no fallback at all and the terminal in
 * the hero shifts its line exactly where people read it. Comments are cut out
 * along the way — they name these addresses out loud, and a ban on the word
 * would ban the explanation.
 */
import { existsSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import assert from 'node:assert/strict'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const read = (rel: string) =>
  readFileSync(resolve(ROOT, rel), 'utf8').replace(/<!--[\s\S]*?-->/g, '')
const html = read('site/index.html')
/**
 * The English page lies one level deeper, and its addresses are root-relative.
 * Both must be checked: forgetting crossorigin or referring to a nonexistent
 * file can happen exactly on the one that was not opened this time.
 */
const pages: Array<[string, string]> = [
  ['ru', html],
  ['en', read('site/en/index.html')],
]
/** "/fonts/x.woff2" and "fonts/x.woff2" are the same file in site/. */
const inSite = (href: string) => href.replace(/^\//, '')
const css = readFileSync(resolve(ROOT, 'site/styles.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '')

test('the landing page goes nowhere for fonts', () => {
  for (const host of ['fonts.googleapis.com', 'fonts.gstatic.com']) {
    for (const [name, page] of pages) {
      assert.ok(
        !page.includes(host),
        `${name}: the font is pulled from ${host} again: on an isolated network the page ` +
          'will be set in the system monospace font, which has different widths',
      )
    }
    assert.ok(!css.includes(host), `the stylesheet pulls the font from ${host} again`)
  }
  // And no font from another domain at all: ours lie next door, in
  // site/fonts.
  for (const src of css.matchAll(/url\(['"]?([^'")]+)['"]?\)/g)) {
    assert.match(src[1], /^fonts\//, `${src[1]} is a font not from site/fonts`)
    assert.ok(existsSync(resolve(ROOT, 'site', src[1])), `${src[1]} is declared, but the file is missing`)
  }
})

test('exactly what the page is set in gets preloaded', () => {
  for (const [name, page] of pages) {
    const preloads = [...page.matchAll(/<link[^>]*rel="preload"[^>]*>/g)].map((m) => m[0])
    assert.ok(preloads.length > 0, `${name}: not a single font preload is left`)
    for (const tag of preloads) {
      const href = /href="([^"]+)"/.exec(tag)?.[1]
      assert.ok(href, `${name}: a preload without an address`)
      const rel = inSite(href)
      assert.ok(existsSync(resolve(ROOT, 'site', rel)), `${name}: ${href} is preloaded, but the file is missing`)
      // A file that is in no @font-face is an extra request on the way to the
      // first frame and a warning in the console, not care for speed.
      assert.ok(css.includes(rel), `${name}: ${href} is preloaded, but no @font-face sets text in it`)
      // Without crossorigin the font is downloaded twice: it is requested in
      // CORS mode.
      assert.match(
        tag,
        /crossorigin/,
        `${name}: ${href} is preloaded without crossorigin — that is a second request`,
      )
    }
  }
})

/** Every @font-face of the landing page: the family name and its descriptors. */
type Face = { family: string; body: string; get(d: string): string | undefined }
const faces: Face[] = [...css.matchAll(/@font-face\s*\{([^}]*)\}/g)].map((m) => {
  const body = m[1]
  const get = (d: string) =>
    new RegExp(`(?:^|;)\\s*${d}\\s*:\\s*([^;]+)`, 'i').exec(body)?.[1].trim()
  return { family: (get('font-family') ?? '').replace(/['"]/g, ''), body, get }
})
/** The names listed by one face's `src: local(...)`. */
const localsOf = (f: Face) =>
  [...(f.get('src') ?? '').matchAll(/local\(\s*['"]?([^'")]+)['"]?\s*\)/g)].map((m) => m[1].trim())

test('one name, one face: the fallback families are kept apart', () => {
  /*
   * Two @font-face rules under ONE name, both without unicode-range and with
   * the same style, are a bet on implementation behaviour: the spec does not
   * promise that a browser that picked a face and found none of its local()
   * will try the other faces of the same family rather than drop the family
   * entirely. That is exactly how the fallback could vanish on Windows.
   * Different names are the ordinary family fallback, which is promised.
   */
  const seen = new Set<string>()
  for (const f of faces) {
    const key = [
      f.family.toLowerCase(),
      f.get('font-weight') ?? 'normal',
      f.get('font-style') ?? 'normal',
      f.get('unicode-range') ?? '*',
    ].join(' | ')
    assert.ok(
      !seen.has(key),
      `"${f.family}" is declared twice with the same matching keys (${key}) — ` +
        'which of the two the browser takes, and what happens if it finds none ' +
        'of its local(), is decided by the implementation, not by us',
    )
    seen.add(key)
  }
})

test('local() is named by the face name, not the family', () => {
  /*
   * `local()` looks for a FACE — by its full or PostScript name — not a
   * family. Measured in Chrome on macOS by the width of a line of 80 "M"s:
   * local('Menlo') does not match at all, local('Menlo-Regular') and
   * local('Menlo Regular') do. While the rule had only 'Menlo', there was no
   * fallback on a Mac at all: the family stayed empty, the stack fell through
   * to the uncorrected ui-monospace, and a 16px terminal line lost 2px against
   * the real font.
   */
  const TRAPS: Record<string, string[]> = { menlo: ['Menlo-Regular', 'Menlo Regular'] }
  for (const f of faces) {
    const names = localsOf(f)
    for (const [family, faceNames] of Object.entries(TRAPS)) {
      if (!names.some((n) => n.toLowerCase() === family)) continue
      assert.ok(
        names.some((n) => faceNames.includes(n)),
        `${f.family}: local('${family}') names a family, not a face, and is not found — ` +
          `at least one of ${faceNames.join(', ')} must stand next to it`,
      )
    }
  }
})

test('the page stack knows about both fallback families', () => {
  const stack = /--mono:\s*([^;]+);/.exec(css)?.[1].replace(/\s+/g, ' ').trim()
  assert.ok(stack, 'site/styles.css no longer declares --mono')
  assert.match(stack!, /^'JetBrains Mono',/, 'the real font must come first')
  assert.match(stack!, /monospace$/, 'the stack has no generic system tail')
  const fallbacks = faces.filter((f) => /Fallback/i.test(f.family))
  assert.equal(fallbacks.length, 2, 'there must be two fallback faces: Consolas-like and Menlo-like')
  for (const f of fallbacks) {
    assert.ok(stack!.includes(`'${f.family}'`), `${f.family} is declared, but did not make it into --mono`)
  }
  // A name in the stack that nobody declares is a silent skip of the family:
  // there is no fallback, yet the list looks as if there were.
  for (const quoted of stack!.matchAll(/'([^']+)'/g)) {
    assert.ok(
      faces.some((f) => f.family === quoted[1]),
      `'${quoted[1]}' is in the stack, but no @font-face declares it`,
    )
  }
  // Both fallbacks stand between the real font and the system tail, back to
  // back: after ui-monospace they no longer help, because nothing gets to
  // them.
  const names = stack!.split(', ')
  const first = names.findIndex((n) => /Fallback/.test(n))
  assert.equal(names[0], "'JetBrains Mono'", 'the real font must come first')
  assert.ok(
    /Fallback/.test(names[first + 1] ?? ''),
    'the fallback families are not back to back — a font without metric overrides got between them',
  )
  assert.match(
    names[first + 2] ?? '',
    /^ui-monospace/,
    'the system tail must come after both fallbacks, not before',
  )
})

test('the self-hosted font has its license next to it', () => {
  // JetBrains Mono is under SIL OFL 1.1: it may be hosted and subset, but the
  // license text must travel with the files.
  assert.ok(
    existsSync(resolve(ROOT, 'site/fonts/JetBrainsMono-OFL.txt')),
    'the font was added, but the license was not',
  )
})
