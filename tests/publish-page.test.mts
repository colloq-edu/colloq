/**
 * The public page: what is visible on it and what never appears there.
 *
 * The second notebook renderer (`server/src/publish/render.ts`) builds a file
 * that a student opens on a Wednesday evening without any server. Whatever it
 * lost or garbled is lost for good: there is nobody to fix this page and
 * nowhere to complain — it simply reads as unfinished.
 *
 * This is about three things, each of which reached the class broken: code in
 * a note, text/html output and the Russian numeral.
 */
import './_env.mts'
import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import * as Y from 'yjs'
import { renderCourse, renderStep, renderWithdrawn } from '../server/src/publish/render.js'
import { notebookFrom } from '../server/src/publish/notebook.js'
import { appendVersion, createSession } from '../server/src/db.js'
import { getSessionDoc, shutdownCollab } from '../server/src/collab/index.js'
import { mark } from '../server/src/collab/history.js'
import { createCell, getCells } from '../shared/notebook.js'
import { candidatesFor, candidatesForAsync } from '../server/src/publish/candidates.js'
import { buildPageAt, newBlobBag, pageAt, pageOfDoc } from '../server/src/publish/build.js'
import {
  addressHolder,
  createCourse,
  findCourse,
  formerSlugs,
  releaseFormerSlug,
  setCourseSlug,
  stepHeadings,
  writePublication,
} from '../server/src/publish/store.js'
import type { PublicCell, PublicCourseView } from '../shared/publish.js'

after(() => shutdownCollab())

const cell = (over: Partial<PublicCell> = {}): PublicCell => ({
  id: 'c1',
  type: 'code',
  source: 'df.head()',
  outputs: [],
  execCount: 1,
  ranMs: null,
  ...over,
})

function page(cells: PublicCell[], steps = 1): string {
  return renderStep({
    title: 'Деревья и леса',
    publishedAt: 1,
    course: null,
    steps: Array.from({ length: steps }, (_, i) => ({
      seq: i + 1,
      label: `шаг ${i + 1}`,
      at: 1,
      cellCount: 1,
    })),
    step: { seq: 1, label: 'шаг', at: 1, cells },
    depth: 1,
    base: 'https://colloq.ru',
  })
}

/* ------------------------------------------------------------ the note */

test('code in ``` stays code: a hash inside it is a comment, not a heading', () => {
  // The most common construct of a teaching notebook: the line "# load data"
  // inside an example turned into a big heading in the middle of the page, and a
  // blank line tore the example into paragraphs.
  const note = ['Разбор:', '', '```python', '# load data', '', 'x = 1', '- y', '```'].join('\n')
  const html = page([cell({ type: 'markdown', source: note })])
  assert.ok(!/<h[1-5]>load data/.test(html), 'a comment in the code became a heading')
  assert.ok(!/<li>y/.test(html), 'a subtraction in the code became a list item')
  assert.match(html, /<pre class="code"># load data\n\nx = 1\n- y<\/pre>/)
})

test('a numbered list is a list, and an image is a link, not a "!"', () => {
  const note = ['1. первый', '2. второй', '', '![схема](https://example.com/a.png)'].join('\n')
  const html = page([cell({ type: 'markdown', source: note })])
  assert.match(html, /<ol><li>первый<\/li><li>второй<\/li><\/ol>/)
  // An external image on a page opened from an archive is a broken frame.
  assert.ok(!/<img[^>]+example\.com/.test(html), 'an external image was embedded in the page')
  assert.match(html, /<a href="https:\/\/example\.com\/a\.png" rel="noreferrer">схема<\/a>/)
})

/* -------------------------------------------------------------- output */

test('a pandas table reaches the page, but its style and scripts do not', () => {
  /*
   * `df.style` gives text/html with its own `<style>`, and its text/plain is
   * "<pandas.io.formats.style.Styler object at 0x…>". The page used to show
   * either this repr or an empty space captioned "Out [1]".
   */
  const html = page([
    cell({
      outputs: [
        {
          kind: 'data',
          data: {
            'text/html':
              '<style>body{display:none}</style><table><tr><th scope="col" class="lvl">a</th>' +
              '<td colspan="2" onclick="steal()">1</td></tr></table>' +
              '<script>fetch("/api/admin")</script><div>хвост',
            'text/plain': '<pandas.io.formats.style.Styler object at 0x10>',
          },
          execCount: 1,
        },
      ],
    }),
  ])
  assert.match(html, /<table><tr><th scope="col">a<\/th><td colspan="2">1<\/td><\/tr><\/table>/)
  assert.ok(
    !/<style/i.test(html.split('<div class="rich">')[1] ?? ''),
    'the output style got into the page',
  )
  assert.ok(!/steal\(\)|fetch\("\/api/.test(html), 'a script from the output got into the page')
  assert.ok(!/Styler object/.test(html), 'a repr was printed instead of the table')
  // An unclosed tag is closed right here — otherwise it would drag the page layout along.
  assert.match(html, /<div>хвост<\/div>/)
})

test('a link from output is http(s) only', () => {
  const html = page([
    cell({
      outputs: [
        {
          kind: 'data',
          data: { 'text/html': '<a href="javascript:alert(1)">тык</a>' },
          execCount: 2,
        },
      ],
    }),
  ])
  assert.ok(!/javascript:/.test(html), 'a javascript link reached the page')
  assert.match(html, /<a>тык<\/a>/)
})

test('output that cannot be shown names itself instead of vanishing', () => {
  // An empty space under a cell captioned "Out [7]" reads as "the code printed
  // nothing" — but there was output.
  const html = page([
    cell({
      outputs: [{ kind: 'data', data: { 'application/vnd.bokehjs_exec.v0+json': '{}' }, execCount: 7 }],
    }),
  ])
  assert.match(html, /application\/vnd\.bokehjs_exec\.v0\+json/)
  assert.match(html, /не показывается/)
})

test('a plotly chart on an exported page is called a chart, not a format', () => {
  /*
   * A figure has a name, and it has a place where it IS SHOWN — the live class
   * page: there it is drawn in a sandbox frame (server/src/plotly-frame.ts). The
   * static directory lives without a server, and nobody there can serve the
   * frame with its header — but saying "output in the application/vnd.plotly.v1+json
   * format is not shown on this page" sends the reader off guessing.
   */
  const html = page([
    cell({
      outputs: [
        {
          kind: 'data',
          data: { 'application/vnd.plotly.v1+json': '{"data":[],"layout":{}}' },
          execCount: 7,
        },
      ],
    }),
  ])
  assert.match(html, /интерактивный график plotly/)
  assert.ok(!/application\/vnd\.plotly/.test(html), 'the type name tells the reader nothing')
  // And the figure itself does not go into the static page: foreign data plus
  // foreign code on an origin that holds other classes too.
  assert.ok(!/"layout"/.test(html), 'the figure JSON went into the exported page')
})

test('an empty plotly, bokeh or ipywidgets scaffold is not content', () => {
  /*
   * Three of the four producers of text/html draw not with markup but with a
   * script: the output holds a `<script>` and an empty `<div id=…>` that it fills
   * in the browser. The script does not go onto the page, and what remains is
   * `<div></div>` — a non-empty string. While the branch was chosen by its
   * length, the format note was never printed, and under the cell was exactly the
   * empty space captioned "Out [1]" that all of this was written to avoid.
   */
  const empty: Record<string, string> = {
    plotly:
      '<div>                        <script type="text/javascript">window.PlotlyConfig = {MathJaxConfig: \'local\'};</script>' +
      '<script charset="utf-8" src="https://cdn.plot.ly/plotly-2.27.0.min.js"></script>' +
      '<div id="e0c5a0f7-1" class="plotly-graph-div" style="height:525px; width:100%;"></div>' +
      '<script type="text/javascript">Plotly.newPlot("e0c5a0f7-1", [{"x":[1,2]}], {})</script></div>',
    bokeh:
      '<div id="p1001" data-root-id="1001" style="display: contents;"></div>\n' +
      '<script type="application/json" id="p1002">{"a":1}</script>\n' +
      '<script type="text/javascript">(function(){ Bokeh.embed(); })();</script>',
    ipywidgets: '<div id="a3f2" style="height:0">&nbsp;</div>',
  }
  for (const [maker, rich] of Object.entries(empty)) {
    const html = page([
      cell({
        outputs: [
          { kind: 'data', data: { 'application/x-thing+json': '{}', 'text/html': rich }, execCount: 1 },
        ],
      }),
    ])
    assert.ok(!/<div class="rich">/.test(html), `${maker}: an empty scaffold was passed off as output`)
    assert.match(html, /не показывается/, `${maker}: the output vanished without a note`)
  }
})

test('what is visible in text/html is shown, not replaced by a note', () => {
  // The other side of the same check: a table, a line of text and a rule are
  // content, and they must not be replaced by a "not shown" note.
  const seen: Record<string, string> = {
    таблица: '<table><tr><td>1</td></tr></table>',
    строка: '<div><span>ответ: 42</span></div>',
    линейка: '<div><hr></div>',
  }
  for (const [what, rich] of Object.entries(seen)) {
    const html = page([cell({ outputs: [{ kind: 'data', data: { 'text/html': rich }, execCount: 1 }] })])
    assert.match(html, /<div class="rich">/, `${what}: the visible output disappeared`)
    assert.ok(!/не показывается/.test(html), `${what}: the visible output was replaced by a note`)
  }
})

test('an empty scaffold gives way to text/plain rather than swallowing it', () => {
  // ipywidgets puts text/plain ("IntSlider(value=0)") next to the scaffold — that
  // is at least something, and it is more honest than a format note.
  const html = page([
    cell({
      outputs: [
        {
          kind: 'data',
          data: { 'text/html': '<div id="w1"></div>', 'text/plain': 'IntSlider(value=0)' },
          execCount: 3,
        },
      ],
    }),
  ])
  assert.match(html, /IntSlider\(value=0\)/)
  assert.ok(!/не показывается/.test(html), 'text/plain was replaced by a format note')
})

/* ---------------------------------------------------------- the numeral */

test('the numeral follows the rule, not a ternary', () => {
  // "5 шага" in the header and "21 шагов" in the course are what makes the page
  // read as unfinished. There is one rule for everyone, in shared/plural.ts.
  assert.match(page([cell()], 5), /· 5 шагов/)
  assert.match(page([cell()], 2), /· 2 шага/)
  assert.match(page([cell()], 21), /· 21 шаг/)

  const course = (steps: number): string => {
    const view: PublicCourseView = {
      id: 'c-1',
      slug: 'ml',
      name: 'Курс',
      blurb: null,
      items: [
        {
          kind: 'seminar',
          sessionId: '',
          name: 'Неделя 1',
          publication: { id: 'p1', slug: 'p1', publishedAt: 1, steps },
        },
      ],
    }
    return renderCourse(view, 'https://colloq.ru')
  }
  assert.match(course(21), /21 шаг</)
  assert.match(course(5), /5 шагов</)
  assert.match(course(1), /одна страница/)
})

/* -------------------------------------------------------- the tombstone */

test('a withdrawn page says it was withdrawn and leads to the course', () => {
  const html = renderWithdrawn(
    'Неделя 4',
    { name: 'Прикладной ML', handle: 'ml-strong' },
    'https://colloq.ru',
  )
  assert.match(html, /снял эту страницу/)
  assert.match(html, /https:\/\/colloq\.ru\/c\/ml-strong\//)
  assert.ok(!/<script/i.test(html), 'a script appeared on the tombstone')
})

/* --------------------------------------------------------------- .ipynb */

test('every cell in the .ipynb has an id: schema 4.5 requires it', () => {
  const notebook = JSON.parse(
    notebookFrom([cell({ id: 'c_ok' }), cell({ id: 'плохой id', type: 'markdown' })]),
  ) as { nbformat_minor: number; cells: { id: string }[] }
  assert.equal(notebook.nbformat_minor, 5)
  assert.deepEqual(
    notebook.cells.map((c) => c.id),
    ['c_ok', 'cell-2'],
  )
  for (const c of notebook.cells) assert.match(c.id, /^[a-zA-Z0-9-_]{1,64}$/)
})

/* --------------------------------------------------- moments and steps */

/** A room whose notebook changed its cells between named moments. */
function taught(id: string): Y.Doc {
  createSession(id, 'Счёт ячеек', null)
  const { doc } = getSessionDoc(id, 'Счёт ячеек')
  const cells = getCells(doc)
  mark(id, doc, 'checkpoint' as never, null, 'один', 'moment marked')
  doc.transact(() => cells.push([createCell('code', 'x = 1')]), 'server')
  mark(id, doc, 'checkpoint' as never, null, 'два', 'moment marked')
  // A snapshot of the whole document in the middle of the history: the unfolding
  // starts from it, and exactly there the "one document forward" count has to rebuild afresh.
  appendVersion({
    sessionId: id,
    update: Y.encodeStateAsUpdate(doc),
    kind: 'keyframe',
    authorId: null,
    createdAt: Date.now(),
    label: null,
    summary: '',
    added: 0,
    removed: 0,
    cells: [],
  })
  doc.transact(
    () => cells.push([createCell('code', 'y = 2'), createCell('code', 'z = 3')]),
    'server',
  )
  mark(id, doc, 'checkpoint' as never, null, 'три', 'moment marked')
  doc.transact(() => cells.delete(0, 1), 'server')
  mark(id, doc, 'checkpoint' as never, null, 'четыре', 'moment marked')
  return doc
}

test('counting cells with one document going forward gives the same as unfolding from scratch', () => {
  /*
   * The publish panel unfolded the document ANEW for every named row: the whole
   * snapshot plus deltas, up to four hundred times, synchronously, in the process
   * that holds the room sockets. Now the snapshot and each delta are applied once
   * for the whole pass — and that is legitimate exactly as long as the count
   * matches an honest unfolding of each row on its own (`pageAt`).
   */
  const id = 'cand-walk'
  const doc = taught(id)
  const named = candidatesFor(id).filter((c) => c.label)
  assert.deepEqual(
    named.map((c) => c.label),
    ['один', 'два', 'три', 'четыре'],
  )
  const bag = newBlobBag()
  for (const candidate of candidatesFor(id)) {
    const honest = pageAt(id, candidate.seq, bag)
    assert.equal(
      candidate.cellCount,
      honest?.length ?? 0,
      `row ${candidate.seq}: the count diverged`,
    )
  }
  // The cells changed between the moments — otherwise the check above would agree on nothing.
  const counts = named.map((c) => c.cellCount)
  assert.deepEqual(counts, [counts[0], counts[0] + 1, counts[0] + 3, counts[0] + 2])
  doc.destroy()
})

test('a second request for the moments answers the same and does not recount', async () => {
  const id = 'cand-memo'
  const doc = taught(id)
  const first = candidatesFor(id)
  const again = await candidatesForAsync(id)
  assert.deepEqual(again, first, 'the async pass diverged from the sync one')
  doc.destroy()
})

test('a step that failed to build names the reason instead of staying silent', () => {
  /*
   * Both an empty notebook and an unreadable history row used to give `null`,
   * the route silently skipped the step, and a teacher who had marked seven
   * moments got a page with six — without a word about which one was lost and why.
   */
  const id = 'build-broken'
  createSession(id, 'Испорченная', null)
  const empty = buildPageAt(id, 1, newBlobBag())
  assert.equal(empty.ok, false)
  assert.equal(empty.ok === false && empty.reason, 'empty')

  const seq = appendVersion({
    sessionId: id,
    update: new Uint8Array([255, 255, 255, 255, 255, 255, 255, 255]),
    kind: 'checkpoint',
    authorId: null,
    createdAt: Date.now(),
    label: 'мусор',
    summary: '',
    added: 0,
    removed: 0,
    cells: [],
  })
  const broken = buildPageAt(id, seq, newBlobBag())
  assert.equal(broken.ok, false)
  assert.equal(
    broken.ok === false && broken.reason,
    'broken',
    'breakage is indistinguishable from an empty notebook',
  )
})

/* ------------------------------------------------------------ addresses */

test('two steps with the same number do not bring the publication down with a 500', () => {
  /*
   * `publication_steps` is keyed by the pair (pub, seq): a duplicate inside the
   * transaction gave SQLITE_CONSTRAINT, that is, a 500 without a single word
   * about the reason. The last one wins — the route appends `seq: 0` at the end.
   */
  const id = 'pub-dup-seq'
  createSession(id, 'Дубли', null)
  const { doc } = getSessionDoc(id, 'Дубли')
  const bag = newBlobBag()
  const cells = pageOfDoc(doc, bag)
  const pub = writePublication({
    sessionId: id,
    title: 'Дубли',
    by: null,
    steps: [
      { seq: 5, label: 'первый', at: 1, cells },
      { seq: 5, label: 'второй', at: 2, cells },
      { seq: 0, label: 'сейчас', at: 3, cells },
    ],
    blobs: bag.all(),
  })
  assert.deepEqual(
    stepHeadings(pub.id).map((h) => [h.seq, h.label]),
    [
      [5, 'второй'],
      [0, 'сейчас'],
    ],
  )
})

test('a former name names its holder and is released by that holder', () => {
  /*
   * "Address 'ml-2025' is already taken" is a dead end: there is no course with
   * that address in the list, it was renamed. The holder has to be named, and the
   * former name has to be releasable, otherwise next year's course will never get it.
   */
  const a = createCourse('Курс года', null, 'Ада')
  const b = createCourse('Курс следующего года', null, 'Ада')
  assert.equal(setCourseSlug(a.id, 'ml-2025'), 'ok')
  assert.equal(setCourseSlug(a.id, 'ml-2025-fall'), 'ok')
  assert.equal(setCourseSlug(b.id, 'ml-2025'), 'taken')

  const holder = addressHolder('course', 'ml-2025')
  assert.deepEqual(holder, { kind: 'course', id: a.id, name: 'Курс года', former: true })
  assert.equal(addressHolder('course', 'ml-2025-fall')?.former, false)

  // Only the owner releases, and only a former name.
  assert.equal(releaseFormerSlug('course', b.id, 'ml-2025'), false, 'an address was released by someone who does not own it')
  assert.equal(releaseFormerSlug('course', a.id, 'ml-2025'), true)
  assert.deepEqual(formerSlugs('course', a.id), [])
  assert.equal(findCourse('ml-2025'), null)
  assert.equal(setCourseSlug(b.id, 'ml-2025'), 'ok')
})
