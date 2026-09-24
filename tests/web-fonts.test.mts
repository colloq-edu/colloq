/**
 * The code font: where it comes from and why the fallback does not move lines.
 *
 * Half of this check is the same as the landing page's (tests/site-fonts):
 * the app no longer goes anywhere for fonts, otherwise on a university network
 * with no way out the notebook would be set in the system monospace font. The
 * other half is about what the landing page does not have:
 * `font-display: swap` changes the font on the fly, and until the fallback's
 * metrics are brought to those of JetBrains Mono, lines in cells and outputs
 * jump while people are reading.
 *
 * What is checked is not "pretty" but arithmetic and wiring:
 *  — the metric overrides add up: after size-adjust the line and the glyph
 *    land exactly where they are with the real font;
 *  — there are two fallback families and their names differ, because trying
 *    FACES within one family when a local() does not match is not promised by
 *    the spec, while trying FAMILIES is;
 *  — the stack lives in one place (--font-mono) and reaches every surface, not
 *    just the `font-mono` utility.
 *
 * The real font's numbers were measured with fontTools on web/public/fonts/
 * jetbrains-mono-latin.woff2: upm 1000, hhea 1020/-300, lineGap 0, advance 600.
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import assert from 'node:assert/strict'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const read = (rel: string) => readFileSync(resolve(ROOT, rel), 'utf8')
/** An explanation is not a promise: comments are cut out, they name these addresses out loud. */
const nocss = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '')
const html = nocss(read('web/index.html').replace(/<!--[\s\S]*?-->/g, ''))
const appCss = read('web/src/index.css')
const tailwind = nocss(read('web/tailwind.config.js').replace(/^\s*\/\/.*$/gm, ''))

/** The names listed by one face's `src: local(...)`. */
const localsOf = (f: Face) =>
  [...(f.get('src') ?? '').matchAll(/local\(\s*['"]?([^'")]+)['"]?\s*\)/g)].map((m) => m[1].trim())

/** Every @font-face of the shell: the family name and its descriptors. */
type Face = { family: string; body: string; get(d: string): string | undefined }
const faces: Face[] = [...html.matchAll(/@font-face\s*\{([^}]*)\}/g)].map((m) => {
  const body = m[1]
  const get = (d: string) =>
    new RegExp(`(?:^|;)\\s*${d}\\s*:\\s*([^;]+)`, 'i').exec(body)?.[1].trim()
  return { family: (get('font-family') ?? '').replace(/['"]/g, ''), body, get }
})

test('the app goes nowhere for fonts', () => {
  for (const host of ['fonts.googleapis.com', 'fonts.gstatic.com']) {
    assert.ok(
      !html.includes(host),
      `the font is pulled from ${host} again: in class this is the only external ` +
        'dependency on the way to the first frame, and an isolated network does not have it',
    )
  }
  for (const src of html.matchAll(/url\(['"]?([^'")]+)['"]?\)/g)) {
    assert.match(src[1], /^\/fonts\//, `${src[1]} is a font not from web/public/fonts`)
    assert.ok(
      existsSync(resolve(ROOT, 'web/public', src[1].slice(1))),
      `${src[1]} is declared, but the file is missing`,
    )
  }
  // JetBrains Mono is under SIL OFL 1.1: it may be hosted and subset, but the
  // license text must lie next to the files.
  assert.ok(
    existsSync(resolve(ROOT, 'web/public/fonts/JetBrainsMono-OFL.txt')),
    'the font was added, but the license was not',
  )
})

test('exactly what the shell is set in gets preloaded', () => {
  const preloads = [...html.matchAll(/<link[^>]*rel="preload"[^>]*>/g)].map((m) => m[0].replace(/\s+/g, ' '))
  assert.ok(preloads.length > 0, 'not a single font preload is left')
  for (const tag of preloads) {
    const href = /href="([^"]+)"/.exec(tag)?.[1]
    assert.ok(href, 'a preload without an address')
    assert.ok(
      existsSync(resolve(ROOT, 'web/public', href!.slice(1))),
      `${href} is preloaded, but the file is missing`,
    )
    assert.ok(html.includes(`url('${href}')`), `${href} is preloaded, but no @font-face sets text in it`)
    assert.match(tag, /crossorigin/, `${href} is preloaded without crossorigin — that is a second request`)
  }
  // Latin — all code is set in it, and it is what waits at the entrance;
  // Cyrillic arrives by unicode-range only if such letters are actually drawn.
  assert.ok(
    preloads.some((t) => t.includes('/fonts/jetbrains-mono-latin.woff2')),
    'the main subset of the code font is not preloaded',
  )
})

test('one name, one face: two rules of one family could differ only by unicode-range', () => {
  /*
   * Two @font-face rules under ONE name, both without unicode-range and with
   * the same style, are a bet on implementation behaviour: the spec does not
   * promise that a browser that picked a face and found none of its local()
   * will try the other faces of the same family rather than drop the family
   * entirely. That is exactly how the fallback could vanish on Windows.
   */
  const seen = new Map<string, string>()
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
    seen.set(key, f.body)
  }
})

test('the metric overrides bring the fallback font to JetBrains Mono', () => {
  // The real one: a line of 1.02 + 0.30 = 1.32em, a glyph of 0.6em (see the
  // file header).
  const REAL = { ascent: 1.02, descent: 0.3, advance: 0.6 }
  // The system fonts the overrides apply to: glyph width in fractions of an
  // em.
  const SYSTEM: Record<string, number> = {
    consolas: 1126 / 2048,
    menlo: 1233 / 2048,
  }
  const pct = (v: string | undefined) => {
    assert.ok(v, 'the fallback face lacks a required metric override')
    return Number.parseFloat(v!) / 100
  }
  const fallbacks = faces.filter((f) => /Fallback/i.test(f.family))
  assert.equal(fallbacks.length, 2, 'there must be two fallback faces: Consolas-like and Menlo-like')

  for (const f of fallbacks) {
    const names = localsOf(f)
    // A width override fits exactly the font it was computed for: that font
    // comes first, followed only by other spellings of its own name and
    // relatives with the same widths.
    const base = names
      .map((n) => n.toLowerCase().replace(/[- ](regular|book)$/, '').replace(/[^a-z]/g, ''))
      .find((n) => n in SYSTEM)
    assert.ok(base, `${f.family}: among local() there is no font whose width I know (${names})`)
    const size = pct(f.get('size-adjust'))
    const near = (got: number, want: number, what: string) =>
      assert.ok(
        Math.abs(got - want) < 0.005,
        `${f.family}: ${what} after the overrides = ${got.toFixed(4)}em, while JetBrains Mono has ${want}em — ` +
          'lines will jump by exactly this difference',
      )
    near(size * SYSTEM[base!], REAL.advance, 'glyph width')
    near(size * pct(f.get('ascent-override')), REAL.ascent, 'line top')
    near(size * pct(f.get('descent-override')), REAL.descent, 'line bottom')
    assert.equal(f.get('line-gap-override'), '0%', `${f.family}: the real font has lineGap = 0`)
  }
})

test('local() is named by the face name, not the family', () => {
  /*
   * `local()` looks for a FACE — by its full or PostScript name — not a
   * family. Measured in Chrome on macOS by the width of a line of 80 "M"s:
   * local('Menlo') does not match at all, local('Menlo-Regular') and
   * local('Menlo Regular') do; 'Monaco' and 'Courier New' match because there
   * the family name coincides with the name of the regular face. While the
   * rule had only 'Menlo', on a Mac — the machine the class is run from — there
   * was no fallback at all: the family stayed empty, the stack fell through to
   * the uncorrected ui-monospace, and a 16px line lost 2px against the real
   * font.
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

test('the code stack is declared once and knows about the fallback families', () => {
  const stack = /--font-mono:\s*([^;]+);/.exec(nocss(appCss))?.[1].replace(/\s+/g, ' ').trim()
  assert.ok(stack, 'web/src/index.css no longer declares --font-mono')
  assert.match(stack!, /^'JetBrains Mono',/, 'the real font must come first')
  assert.match(stack!, /monospace$/, 'the stack has no generic system tail')
  for (const f of faces.filter((x) => /Fallback/i.test(x.family))) {
    assert.ok(stack!.includes(`'${f.family}'`), `${f.family} is declared in the shell, but did not make it into the stack`)
  }
  // The flip side: a name in the stack that nobody declares is a silent skip
  // of the family, that is, there is no fallback, yet the list looks as if
  // there were.
  for (const quoted of stack!.matchAll(/'([^']+)'/g)) {
    assert.ok(
      faces.some((f) => f.family === quoted[1]),
      `'${quoted[1]}' is in the stack, but no @font-face declares it`,
    )
  }
  // The font-mono utility has no copy of the stack of its own: otherwise the
  // notebook and the terminal diverge exactly the way they already did.
  assert.match(
    tailwind,
    /mono:\s*\['var\(--font-mono\)'\]/,
    'tailwind.config.js keeps its own family list again',
  )
})

test('no surface sets its own monospace bypassing --font-mono', () => {
  /*
   * The migration debt is closed, and there are no exemptions here any more.
   * There were two copies of the stack of their own — the terminal drawer's
   * `--tm-mono` (HistoryTab reads it too) and the stack inside the shadow root
   * of the kernel's html output; both were set in the uncorrected ui-monospace
   * until the woff2 arrived and moved lines on swap. Both read
   * var(--font-mono), the list is empty, and any new copy fails the test right
   * away.
   */
  const walk = (dir: string): string[] =>
    readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
      e.isDirectory() ? walk(join(dir, e.name)) : [join(dir, e.name)],
    )
  const offenders: string[] = []
  for (const file of walk(resolve(ROOT, 'web/src'))) {
    if (!/\.(svelte|ts|css)$/.test(file)) continue
    const rel = relative(ROOT, file)
    const text = nocss(readFileSync(file, 'utf8'))
    for (const m of text.matchAll(/(--[\w-]+|font-family)\s*:\s*([^;{}]*monospace[^;{}]*)/g)) {
      if (rel === 'web/src/index.css' && m[1] === '--font-mono') continue
      if (m[2].trim() === 'var(--font-mono)') continue
      offenders.push(`${rel}: ${m[1]}: ${m[2].replace(/\s+/g, ' ').trim()}`)
    }
  }
  assert.deepEqual(
    offenders,
    [],
    'its own family list instead of var(--font-mono): the fallback faces with metric ' +
      'overrides will not get there, and lines will shift on swap',
  )
})
