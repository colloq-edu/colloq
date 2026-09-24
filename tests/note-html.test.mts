/**
 * HTML in a text cell — on the exported page.
 *
 * There are two note renderers, and that is a deliberate trade-off (see the
 * header of server/src/publish/render.ts): in the room it is marked with
 * DOMPurify, on the static page a subset of our own without a single script.
 * They can drift apart, and one day they will; what is checked here is the
 * half that until now drifted silently.
 *
 * And it drifted entirely: the note went into `esc()`, and a
 * `<div style="…">` from a course notebook reached the student as printed
 * tags, while in the room the same cell was rendered.
 */
import './_env.mts'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { renderStep } from '../server/src/publish/render.js'
import type { PublicCell } from '../shared/publish.js'

/** A one-step page with a single note. */
function note(source: string, depth: 1 | 2 = 1): string {
  const cell: PublicCell = { id: 'n1', type: 'markdown', source, outputs: [], execCount: null, ranMs: null }
  const page = renderStep({
    title: 'Деревья и леса',
    publishedAt: 1,
    course: { name: 'Прикладной ML', handle: 'ml-strong' },
    steps: [{ seq: 3, label: 'шаг', at: 1, cellCount: 1 }],
    step: { seq: 3, label: 'шаг', at: 1, cells: [cell] },
    depth,
    base: 'https://colloq.ru',
  })
  const start = page.indexOf('<div class="note">')
  assert.notEqual(start, -1, 'there is no note on the page at all')
  const end = page.indexOf('\n<div class="take">', start)
  return page.slice(start, end === -1 ? undefined : end)
}

test('inline markup is rendered, not printed', () => {
  const html = note('текст <b>жирный</b> и <i>курсив</i>')
  assert.match(html, /<b>жирный<\/b>/)
  assert.match(html, /<i>курсив<\/i>/)
  assert.doesNotMatch(html, /&lt;b&gt;/)
})

test('a "Note" callout arrives with its styling', () => {
  const html = note('<div style="background:#eef;padding:8px">\nВажно\n</div>')
  assert.match(html, /<div style="background: #eef; padding: 8px">/)
  assert.match(html, /Важно/)
})

test('a markup block is not cut into paragraphs', () => {
  // While there was no block here, every line of the div was wrapped in <p>,
  // and the browser fixed `<p><div …></p>` its own way — the callout fell
  // apart.
  const html = note('<div class="x">\nпервая\nвторая\n</div>')
  assert.doesNotMatch(html, /<p><div/)
})

test('centering across a blank line stays one block', () => {
  // The most common way to center a heading in a notebook. Blank lines cut it
  // into three pieces, and the heading must stay INSIDE the div.
  const html = note('<div align="center">\n\n# Заголовок\n\n</div>')
  const div = html.indexOf('<div align="center">')
  const head = html.indexOf('<h2>Заголовок</h2>')
  const close = html.indexOf('</div>', div + 1)
  assert.ok(div !== -1 && head !== -1, 'the div or the heading got lost')
  assert.ok(div < head && head < close, 'the heading did not end up inside the div')
})

test('a table and details — as written', () => {
  // Line breaks stay in place: the layout does not read them, but comparing
  // the exported page with the previous version does.
  const html = note('<table>\n<tr><th>a</th><td>1</td></tr>\n</table>')
  assert.match(html, /<table>\n<tr><th>a<\/th><td>1<\/td><\/tr>\n<\/table>/)
  assert.match(note('<details><summary>подсказка</summary>ответ</details>'), /<summary>подсказка<\/summary>/)
})

test('a note image becomes a publication record, at any depth', () => {
  const sha = 'a'.repeat(64)
  assert.match(note(`<img src="blob:${sha}.png" alt="схема">`, 1), new RegExp(`src="blob/${sha}\\.png"`))
  assert.match(note(`<img src="blob:${sha}.png" alt="схема">`, 2), new RegExp(`src="\\.\\./blob/${sha}\\.png"`))
})

test('a full-page overlay cannot be assembled here either', () => {
  const html = note('<div style="position:fixed;inset:0;background:#000;z-index:9999">×</div>')
  assert.doesNotMatch(html, /position/)
  assert.doesNotMatch(html, /z-index/)
  assert.match(html, /<div style="background: #000">/)
})

test('a script and a style sheet are thrown out along with their contents', () => {
  const html = note('<script>alert(1)</script><style>* { display: none }</style>текст')
  assert.doesNotMatch(html, /alert/)
  assert.doesNotMatch(html, /display: ?none/)
  assert.match(html, /текст/)
})

test('a link address is only one that opens as a page', () => {
  assert.doesNotMatch(note('<a href="javascript:alert(1)">жми</a>'), /javascript:/)
  assert.match(note('<a href="https://colloq.ru">сюда</a>'), /href="https:\/\/colloq\.ru"/)
})

test('an unclosed div does not drag the page layout along', () => {
  const html = note('<div style="padding:8px">начал и забыл')
  assert.equal((html.match(/<div/g) ?? []).length, (html.match(/<\/div>/g) ?? []).length)
})

test('an unclosed bold does not outlive its paragraph', () => {
  // Each line has ITS OWN tag stack: otherwise `<p><b>text</p>…</b>` — and the
  // whole rest of the note turns bold.
  const html = note('<b>начал\n\nобычный абзац')
  assert.match(html, /<p><b>начал<\/b><\/p>/)
})

test('a class from a note does not reach the page rules', () => {
  // The page has its own `.err`, `.quiet`, `.code`: a note with a borrowed
  // class would read as an execution error.
  assert.doesNotMatch(note('<div class="err">обычный текст</div>'), /class="err"/)
})

test('ordinary markdown is not broken', () => {
  const html = note('# Заголовок\n\n- раз\n- два\n\n**жирно** и `код`\n\n```\nx = 1\n```')
  assert.match(html, /<h2>Заголовок<\/h2>/)
  assert.match(html, /<ul><li>раз<\/li><li>два<\/li><\/ul>/)
  assert.match(html, /<strong>жирно<\/strong>/)
  assert.match(html, /<code>код<\/code>/)
  assert.match(html, /<pre class="code">x = 1<\/pre>/)
})

test('a lone angle bracket stays text', () => {
  assert.match(note('если a < b, то'), /a &lt; b/)
})

test('display(Markdown(…)) is rendered as words, not as a class name', () => {
  /*
   * The kernel sends two representations: the markup itself and `text/plain`
   * with the repr `<IPython.core.display.Markdown object>`. While markdown was
   * not chosen, the repr won, and in place of the output a person read a class
   * name — the output was sort of there and sort of missing.
   */
  const cell: PublicCell = {
    id: 'c1',
    type: 'code',
    source: 'display(Markdown("**Решение**: брать медиану"))',
    outputs: [
      {
        kind: 'data',
        data: {
          'text/markdown': '**Решение**: брать медиану',
          'text/plain': '<IPython.core.display.Markdown object>',
        },
        execCount: 4,
      },
    ],
    execCount: 4,
    ranMs: null,
  }
  const page = renderStep({
    title: 'T',
    publishedAt: 1,
    course: { name: 'C', handle: 'c' },
    steps: [{ seq: 3, label: 'шаг', at: 1, cellCount: 1 }],
    step: { seq: 3, label: 'шаг', at: 1, cells: [cell] },
    depth: 1,
    base: 'https://colloq.ru',
  })
  assert.match(page, /<strong>Решение<\/strong>/)
  assert.doesNotMatch(page, /IPython\.core\.display/)
})
