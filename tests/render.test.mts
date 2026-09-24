/**
 * The static page: the paths inside it.
 *
 * A second notebook renderer, next to the room's Svelte components — and it
 * works without a server, without an API and without a single script. This
 * breaks quietly: the page opens, but an image is not found because the path
 * climbed one directory higher than it should. Exactly this is checked here —
 * relative addresses at both depths.
 */
import './_env.mts'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { renderCourse, renderRedirect, renderStep } from '../server/src/publish/render.js'
import { BLOB_PREFIX, type PublicCell, type PublicCourseView } from '../shared/publish.js'

const cellWithImage: PublicCell = {
  id: 'c1',
  type: 'code',
  source: 'plt.plot(xs)',
  outputs: [
    { kind: 'data', data: { 'image/png': `${BLOB_PREFIX}deadbeef` }, execCount: 7 },
  ],
  execCount: 7,
  ranMs: 1400,
}

const steps = [
  { seq: 3, label: 'перед упражнением', at: 1, cellCount: 2 },
  { seq: 5, label: 'решение', at: 2, cellCount: 2 },
]

function page(depth: 1 | 2, seq: number): string {
  return renderStep({
    title: 'Деревья и леса',
    publishedAt: 1,
    course: { name: 'Прикладной ML', handle: 'ml-strong' },
    steps,
    step: { seq, label: 'шаг', at: 1, cells: [cellWithImage] },
    depth,
    base: 'https://colloq.ru',
  })
}

test('an image is found from the first page of a publication', () => {
  // The first step is the publication root itself: there is nowhere to climb,
  // and an extra "../" would lead to a neighbouring publication.
  assert.match(page(1, 3), /src="blob\/deadbeef\.png"/)
})

test('and from any other step page', () => {
  assert.match(page(2, 5), /src="\.\.\/blob\/deadbeef\.png"/)
})

test('the first step in the rail is "./", not an empty link', () => {
  // An empty href means "the whole current address", querystring included: in an
  // archive and when a file is opened from disk, such a link behaves unpredictably.
  assert.ok(!page(1, 3).includes('href=""'))
  assert.match(page(1, 3), /href="\.\/"/)
})

test('the notebook on a step page is its own, not one per publication', () => {
  /*
   * The link was one for all steps, and the file behind it was built from the
   * LAST step: a reader comparing "before" and "after" at step 2 of 5 took away
   * the state of step 5 and learned of it only on opening the file. Now the
   * notebook lies next to the page of its step (export.ts), and
   * `p/<handle>/notebook.ipynb` stays the last step — the links handed out earlier point to it.
   */
  // The first step sits at the publication root, where the notebook is already
  // taken by the last step — so the link goes down into the step's directory.
  assert.match(page(1, 3), /href="3\/notebook\.ipynb"/)
  assert.match(page(2, 5), /href="notebook\.ipynb"/)
  assert.ok(
    !page(2, 5).includes('href="../notebook.ipynb"'),
    'a step page serves the notebook of the whole publication again',
  )
  // The captions are covered in tests/publish-step-notebook.test.mts; here it is the paths.
})

test('the page pulls in not a single external file', () => {
  /*
   * No scripts, no separate CSS: the page has to open on its own — from an
   * archive, from a USB stick, ten years from now. A separate .css is a second
   * request that one day will not arrive, and the text will fall apart.
   */
  const html = page(1, 3)
  assert.ok(!/<script/i.test(html), 'a script appeared on the page')
  assert.ok(!/<link[^>]+stylesheet/i.test(html), 'an external stylesheet appeared on the page')
  assert.match(html, /<style>/)
})

test('the page is not handed to search engines', () => {
  // The link is given to the class, not to an index: the page is open to whoever received it.
  assert.match(page(1, 3), /name="robots" content="noindex"/)
})

test('in a course the link to a seminar goes by name, if a name was given', () => {
  const course: PublicCourseView = {
    id: 'abcd1234',
    slug: 'ml-strong',
    name: 'Прикладной ML',
    blurb: null,
    items: [
      {
        kind: 'seminar',
        sessionId: '',
        name: 'Деревья и леса',
        publication: { id: 'zzzz1111', slug: 'derevya', publishedAt: 1, steps: 3 },
      },
      { kind: 'planned', name: 'Кросс-валидация', when: '1–7 мар' },
      { kind: 'gone', name: 'Регуляризация', at: 1 },
    ],
  }
  const html = renderCourse(course, 'https://colloq.ru')
  assert.match(html, /href="https:\/\/colloq\.ru\/p\/derevya\/"/)
  assert.ok(!html.includes('zzzz1111'), 'the id got into the link instead of the name')
  // Three row states: a link, a plan and a tombstone — all on the page.
  assert.match(html, /1–7 мар/)
  assert.match(html, /занятие удалено/)
})

test('the room id never appears on a public page', () => {
  // The eight characters of the room are the whole right to write to it.
  const course: PublicCourseView = {
    id: 'abcd1234',
    slug: null,
    name: 'Курс',
    blurb: null,
    items: [
      {
        kind: 'seminar',
        sessionId: 'k7m2xq4b',
        name: 'Семинар',
        publication: { id: 'p1', slug: null, publishedAt: 1, steps: 1 },
      },
    ],
  }
  assert.ok(!renderCourse(course, 'https://colloq.ru').includes('k7m2xq4b'))
})

test('note markup lets tags through, but not levers', () => {
  // Anyone in the room writes the cell text, and the page goes out to the class.
  const html = renderStep({
    title: 'x',
    publishedAt: 1,
    course: null,
    steps: [{ seq: 0, label: 'один', at: 1, cellCount: 1 }],
    step: {
      seq: 0,
      label: 'один',
      at: 1,
      cells: [
        { id: 'm', type: 'markdown', source: '# Заголовок\n<img src=x onerror=alert(1)>', outputs: [], execCount: null, ranMs: null },
      ],
    },
    depth: 1,
    base: 'https://colloq.ru',
  })
  /*
   * This used to check that the tag was absent altogether: the whole note went
   * through `esc()`. Now HTML in a note is rendered (see note-html.test.mts) —
   * but by an allowlist, per tag and per attribute, so what remains of this line
   * is an `<img>` without a single attribute: `onerror` is not listed anywhere,
   * and `src=x` is not a publication entry, not `https://` and not `data:image`.
   */
  assert.doesNotMatch(html, /onerror/i)
  assert.doesNotMatch(html, /alert/i)
  assert.doesNotMatch(html, /src=/i)
  assert.match(html, /<h2>Заголовок<\/h2>/)
})

test('kernel colours do not reach the page as garbage', () => {
  /*
   * The kernel prints escape sequences as they are, the room colours them on the
   * fly, but here there are no scripts at all: the escape itself is invisible,
   * and a student reads "[0;31m" in the middle of a traceback. IPython always colours tracebacks.
   */
  const html = renderStep({
    title: 'x',
    publishedAt: 1,
    course: null,
    steps: [{ seq: 0, label: 'один', at: 1, cellCount: 1 }],
    step: {
      seq: 0,
      label: 'один',
      at: 1,
      cells: [
        {
          id: 'c',
          type: 'code',
          source: '1 / 0',
          outputs: [
            { kind: 'stream', name: 'stdout', text: '\x1b[1;32mсобрано\x1b[0m\n' },
            {
              kind: 'error',
              ename: 'ZeroDivisionError',
              evalue: 'division by zero',
              traceback: [
                '\x1b[0;31m---------------------------------\x1b[0m',
                '\x1b[0;31mZeroDivisionError\x1b[0m       Traceback (most recent call last)',
                '\x1b[0;32mCell In[1]\x1b[0m, line 1',
                '\x1b[0;31mZeroDivisionError\x1b[0m: division by zero',
              ],
            },
          ],
          execCount: 1,
          ranMs: null,
        },
      ],
    },
    depth: 1,
    base: 'https://colloq.ru',
  })
  assert.ok(!html.includes('[0;31m'), 'escape codes reached the page')
  assert.ok(!html.includes('\x1b'), 'the escape itself stayed in the text')
  assert.match(html, /собрано/)
  assert.match(html, /Cell In\[1\], line 1/)
  // The error heading appears once, not three times: the room strips the frame,
  // the banner and the echo too (web/src/lib/traceback.ts).
  assert.equal(html.split('ZeroDivisionError').length - 1, 1)
})

test('SVG output is drawn instead of turning into an empty frame', () => {
  // The kernel gives SVG as XML text: `data:…;base64,<xml>` is a broken image.
  const svg = '<svg xmlns="http://www.w3.org/2000/svg"><rect width="2" height="2"/></svg>'
  const html = renderStep({
    title: 'x',
    publishedAt: 1,
    course: null,
    steps: [{ seq: 0, label: 'один', at: 1, cellCount: 1 }],
    step: {
      seq: 0,
      label: 'один',
      at: 1,
      cells: [
        {
          id: 'g',
          type: 'code',
          source: 'graph',
          outputs: [{ kind: 'data', data: { 'image/svg+xml': svg }, execCount: 1 }],
          execCount: 1,
          ranMs: null,
        },
      ],
    },
    depth: 1,
    base: 'https://colloq.ru',
  })
  assert.match(html, /src="data:image\/svg\+xml;charset=utf-8,/)
  assert.ok(!html.includes(';base64,'), 'the XML was served as base64')
  // As an image, not markup: a script from someone else's output does not run inside an `<img>`.
  assert.ok(!/<svg/i.test(html), 'the output markup got into the page')
})

test('a tombstone with a remaining reading is a link, not a dead end', () => {
  /*
   * "Delete the seminar, keep the reading" is the default. The page is alive,
   * and the course is the only address the class is given.
   */
  const course: PublicCourseView = {
    id: 'abcd1234',
    slug: null,
    name: 'Курс',
    blurb: null,
    items: [
      { kind: 'gone', name: 'Четвёртая неделя', at: 1, publication: { id: 'p7', slug: 'nedelya' } },
      { kind: 'gone', name: 'Пятая неделя', at: 2 },
    ],
  }
  const html = renderCourse(course, 'https://colloq.ru')
  assert.match(html, /href="https:\/\/colloq\.ru\/p\/nedelya\/"/)
  assert.match(html, /занятие удалено, материалы доступны/)
  // And where no page is left, the row stays a plain row.
  assert.match(html, /занятие удалено/)
})

test('times on the page are in the instance time zone, not the process one', () => {
  /*
   * The export is run on a server, where the zone is usually UTC, while the class
   * took place in a classroom: without an explicit zone the page labelled the
   * class three hours earlier, and nothing on a static page can check the label
   * — there is no browser here computing the time itself.
   */
  const noon = Date.UTC(2026, 8, 2, 12, 0)
  const at = (zone: string): string => {
    process.env.TZ = zone
    return renderStep({
      title: 'Деревья и леса',
      publishedAt: noon,
      course: null,
      steps: [
        { seq: 3, label: 'перед упражнением', at: noon, cellCount: 1 },
        { seq: 5, label: 'решение', at: noon, cellCount: 1 },
      ],
      step: { seq: 3, label: 'шаг', at: noon, cells: [cellWithImage] },
      depth: 1,
      base: 'https://colloq.ru',
    })
  }
  const was = process.env.TZ
  try {
    assert.match(at('UTC'), /12:00/)
    assert.match(at('Europe/Moscow'), /15:00/)
    // A typo in TZ does not bring the whole export down: the page is built on Moscow time.
    assert.match(at('МСК'), /15:00/)
  } finally {
    if (was === undefined) delete process.env.TZ
    else process.env.TZ = was
  }
})

test('an old address redirects to the current one', () => {
  // On a live server this is `WHERE id = ? OR slug = ?`; Pages has no routing.
  const html = renderRedirect('https://colloq.ru/c/ml-strong/', 'Прикладной ML')
  assert.match(html, /http-equiv="refresh" content="0; url=https:\/\/colloq\.ru\/c\/ml-strong\/"/)
  assert.match(html, /href="https:\/\/colloq\.ru\/c\/ml-strong\/"/)
  assert.ok(!/<script/i.test(html), 'a script appeared on the page')
})
