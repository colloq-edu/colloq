/**
 * The panel never scrolls past its bottom (0.25, the owner's fourth request:
 * on a competition's page, with the pointer over the left menu, the wheel
 * scrolled on below the footer).
 *
 * Two causes, both in the frame every panel screen is drawn in, and both
 * invisible until the wheel is over the rail, which scrolls nothing itself:
 *
 *  - the competition's settings hold visually hidden file inputs (`sr-only`,
 *    absolutely placed). With no positioned box above them inside the page,
 *    they took the whole document as their box and sat at their place in the
 *    content, far below the window: the document grew to 1555 px in a 900 px
 *    window (3731 px at 390 px), and the wheel over the rail scrolled the whole
 *    panel up by the difference. The page's scrolling body is their box now.
 *  - a rail taller than the window (a short laptop window, a phone held
 *    sideways) ran past it and grew the document the same way. It scrolls
 *    within itself now, and so its rows draw their focus ring inside
 *    themselves: a scrolling box clips whatever is drawn past its edge.
 *
 * Measured live in headless Chrome (the scratchpad's xc/check-panel.mts):
 * the document's height is the window's at 1440×900, 390×844 and 844×390,
 * and the wheel over the rail moves nothing but the rail.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const read = (file: string) => readFileSync(new URL(`../web/src/${file}`, import.meta.url), 'utf8')

/** The class list of the first element in `source` whose opening tag matches `tag`. */
function classesOf(source: string, tag: RegExp): string[] {
  const markup = source.slice(source.lastIndexOf('</script>'))
  const opening = tag.exec(markup)?.[0]
  assert.ok(opening, `no element matching ${tag}`)
  return /class="([^"]*)"/.exec(opening)?.[1].split(/\s+/) ?? []
}

test('a panel page’s scrolling body is the box of what is absolutely placed inside it', () => {
  const body = classesOf(read('admin/ui/AdminPage.svelte'), /<div class="[^"]*\boverflow-auto\b[^"]*">/)
  assert.ok(body.includes('overflow-auto'))
  assert.ok(body.includes('relative'), 'without it a hidden input deep in the page grows the whole document')
})

test('the panel’s rail scrolls within itself when it is taller than the window', () => {
  const rail = classesOf(read('admin/AdminShell.svelte'), /<nav class="[^"]*">/)
  assert.ok(rail.includes('overflow-y-auto'), 'a rail taller than the window grows the document')
})

test('every focus ring in the scrolling rail is drawn inside its row, where the rail’s clip cannot take it', () => {
  const shell = read('admin/AdminShell.svelte')
  const markup = shell.slice(shell.lastIndexOf('</script>'))
  const rail = markup.slice(markup.indexOf('{#snippet section('), markup.indexOf('</nav>'))
  // Each class list in the rail and its row snippet that draws a ring: the rows, the logo.
  const rings = [...rail.matchAll(/class=(?:\{cn\(([\s\S]*?)\)\}|"([^"]*)")/g)]
    .map((match) => (match[1] ?? match[2]).replace(/\s+/g, ' '))
    .filter((classes) => /focus-visible:ring-\d/.test(classes))
  assert.ok(rings.length >= 2, 'the rows and the logo draw a focus ring')
  for (const classes of rings) assert.match(classes, /focus-visible:ring-inset/, classes)
})
