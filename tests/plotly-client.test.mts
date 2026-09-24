/**
 * The notebook side: what it chooses to show and what goes into the frame.
 *
 * Three failures, each visible only by eye and only at a seminar:
 *
 *  — the choice of representation does not know about the figure, and the cell
 *    is silently empty (that is how it was: the MIME bundle from plotly has
 *    neither text nor an image);
 *  — not only the figure goes into the frame but also its `config` — that is,
 *    somebody else's settings for our toolbar, up to a foreign server address;
 *  — output with nothing left after the sanitizer is again drawn as an empty
 *    space instead of words.
 *
 * And one rule about the build: five megabytes of plotly.js must not end up in
 * the chunk that everyone who opens a class link downloads.
 */
import './_env.mts'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import {
  PLOTLY_DEFAULT_HEIGHT,
  PLOTLY_MAX_HEIGHT,
  PLOTLY_MIME,
  PLOTLY_MSG,
  figureHeight,
  isPlotlyMessage,
  normalizeFigure,
} from '../shared/plotly.js'
import {
  asImage,
  hasVisibleMarkup,
  isPicture,
  pickMime,
  withBlobs,
} from '../web/src/components/notebook/output-mimes.js'
import type { CellOutput } from '../shared/notebook.js'

const read = (rel: string): string =>
  fs.readFileSync(path.resolve(import.meta.dirname, '..', rel), 'utf8')

/* ----------------------------------------------- choosing the representation */

test('the figure is chosen even when the bundle has nothing else', () => {
  // Exactly the bundle ipykernel sends with current plotly: one key. Until it
  // was here, `pickMime` returned null, and null is an empty space.
  assert.equal(pickMime({ [PLOTLY_MIME]: '{}' }, true), PLOTLY_MIME)
  assert.equal(pickMime({ [PLOTLY_MIME]: '{}' }, false), PLOTLY_MIME, 'before the renderer too')
  // And it outranks a snapshot of the same chart: only a figure can be played with.
  assert.equal(pickMime({ [PLOTLY_MIME]: '{}', 'image/png': 'iVBOR' }, true), PLOTLY_MIME)
  // The old order is untouched.
  assert.equal(pickMime({ 'image/png': 'iVBOR', 'text/plain': 'x' }, true), 'image/png')
  assert.equal(pickMime({ 'text/html': '<b>1</b>', 'text/plain': 'x' }, true), 'text/html')
})

test('a figure is not drawn as an image, neither by type nor by address', () => {
  // An offloaded figure arrives as an address, just like an offloaded image. The
  // address holds JSON: an `<img>` would show a broken frame where the chart should be.
  assert.equal(asImage(PLOTLY_MIME, '/api/sessions/x/blobs/abc'), false)
  assert.equal(asImage('image/png', '/api/sessions/x/blobs/abc'), true)
  assert.equal(asImage('image/png', 'iVBORw0KGgo='), true)
})

test('a chart is not clipped by the "Show more" edge', () => {
  // Under the edge would be the chart's bottom axis and labels, and the button
  // would promise more output that is not there. The same reason as for images.
  const output: CellOutput = { kind: 'data', data: { [PLOTLY_MIME]: '{}' }, execCount: 1 }
  assert.equal(isPicture(output, true), true)
})

test('an offloaded figure gets its address by the same mechanism as an image', () => {
  const output: CellOutput = {
    kind: 'data',
    data: {},
    blobs: [{ sha: 'abc', mime: PLOTLY_MIME, bytes: 900_000 }],
    execCount: 3,
  }
  const shown = withBlobs(output, (blob) => `/api/sessions/room/blobs/${blob.sha}`)
  assert.equal(shown.kind, 'data')
  if (shown.kind !== 'data') return
  assert.equal(shown.data[PLOTLY_MIME], '/api/sessions/room/blobs/abc')
})

/* ------------------------------------------------ the figure for the frame */

test('only data, layout and frames go into the frame', () => {
  const figure = normalizeFigure({
    data: [{ type: 'bar', x: [1], y: [2] }],
    layout: { height: 300 },
    frames: [{ name: 'a' }],
    // Everything below is somebody else's settings for OUR toolbar and who knows
    // what else. None of it goes into the frame.
    config: { plotlyServerURL: 'https://chart-studio.example', showSendToCloud: true },
    somethingNew: { x: 1 },
  })
  assert.ok(figure)
  assert.deepEqual(Object.keys(figure).sort(), ['data', 'frames', 'layout'])
  assert.equal((figure as Record<string, unknown>).config, undefined)
})

test('not a figure means nothing to show, and that is said in words', () => {
  assert.equal(normalizeFigure(null), null)
  assert.equal(normalizeFigure('строка'), null)
  assert.equal(normalizeFigure([1, 2]), null)
  assert.equal(normalizeFigure({ layout: {} }), null, 'without data it is not a figure')
  // A malformed layout does not cancel the figure: there is still something to draw.
  assert.deepEqual(normalizeFigure({ data: [], layout: 'нет' }), { data: [], layout: {} })
})

test('the height comes from the figure, within reasonable limits', () => {
  assert.equal(figureHeight({ data: [], layout: {} }), PLOTLY_DEFAULT_HEIGHT)
  assert.equal(figureHeight({ data: [], layout: { height: 620 } }), 620)
  // Anyone can write a number into layout: `height: 1e9` is a page that cannot
  // be scrolled through, and `height: 1` is a chart one line tall.
  assert.equal(figureHeight({ data: [], layout: { height: 1e9 } }), PLOTLY_MAX_HEIGHT)
  assert.equal(figureHeight({ data: [], layout: { height: 1 } }), 180)
  assert.equal(figureHeight({ data: [], layout: { height: 'высокий' } }), PLOTLY_DEFAULT_HEIGHT)
})

test('a frame message is recognised by its tag, not by guessing at its shape', () => {
  assert.ok(isPlotlyMessage({ colloq: PLOTLY_MSG, kind: 'ready' }))
  assert.ok(!isPlotlyMessage({ kind: 'ready' }))
  assert.ok(!isPlotlyMessage({ colloq: 'webpackHotUpdate', kind: 'ready' }))
  assert.ok(!isPlotlyMessage('ready'))
  assert.ok(!isPlotlyMessage(null))
})

/* ---------------------------------------- words instead of an empty space */

test('output with nothing left after the sanitizer is recognised', () => {
  // Bokeh, folium, altair without an image, ipywidgets, plotly with the old
  // renderer: all the work is in `<script>`, and we do not execute scripts from output.
  assert.equal(hasVisibleMarkup('<div id="bk-1" class="bk-root"></div>'), false)
  assert.equal(hasVisibleMarkup('  \n  '), false)
  assert.equal(hasVisibleMarkup('<div><span> </span></div>'), false)
  // But real output markup remains.
  assert.equal(hasVisibleMarkup('<table><tr><td>1</td></tr></table>'), true)
  assert.equal(hasVisibleMarkup('<div>Решение</div>'), true)
  // An image is visible without a single letter inside.
  assert.equal(hasVisibleMarkup('<p><img src="data:image/png;base64,iVBOR"></p>'), true)
  assert.equal(hasVisibleMarkup('<svg><circle r="1"/></svg>'), true)
})

test('an empty text/plain string stays a legitimate emptiness', () => {
  // `print("")` and `display("")` are output that REALLY is empty, and a line
  // about interactivity here would be a lie. The choice does reach it.
  assert.equal(pickMime({ 'text/plain': '' }, true), 'text/plain')
})

test('exactly one place draws the line about interactive output', () => {
  const source = read('web/src/components/notebook/CellOutputs.svelte')
  const uses = source.match(/room\.output\.interactive/g) ?? []
  assert.equal(uses.length, 2, 'there are two branches: scrubbed markup and an unknown bundle')
  assert.ok(source.includes('hasVisibleMarkup('), 'the output markup is no longer weighed')
})

/* ---------------------------------------------------------- the build */

test('plotly.js does not get into the app bundle, not into any chunk', () => {
  /*
   * Five megabytes (1.1 MB brotli) load ONLY inside the frame and only when a
   * chart is on screen. There is exactly one way this is ensured: no frontend
   * source imports the package — it is copied into `public/` by a build step
   * and attached by a script inside the frame.
   *
   * It is checked by the sources, not by the build output: a build in the tests
   * takes half a minute, while an import added by accident, `import Plotly from
   * …` for the types, can be seen by reading.
   */
  const offenders: string[] = []
  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(path.resolve(import.meta.dirname, '..', dir), { withFileTypes: true })) {
      const rel = `${dir}/${entry.name}`
      if (entry.isDirectory()) walk(rel)
      else if (/\.(ts|svelte|js)$/.test(entry.name) && /from ['"]plotly\.js|require\(['"]plotly\.js/.test(read(rel))) {
        offenders.push(rel)
      }
    }
  }
  for (const dir of ['web/src', 'shared', 'server/src']) walk(dir)
  assert.deepEqual(offenders, [], `plotly.js is imported by:\n  ${offenders.join('\n  ')}`)

  // And the copy for the frame really is laid out by a build step — otherwise the
  // address in the policy would lead to a 404, and the chart would be a placeholder forever.
  const web = JSON.parse(read('web/package.json')) as { scripts: Record<string, string> }
  assert.match(web.scripts['plotly:dist'], /plotly\.js-strict-dist-min/)
  assert.match(web.scripts['plotly:dist'], /public\/plotly\/plotly\.min\.js/)
  for (const script of ['dev', 'build']) {
    assert.match(web.scripts[script], /assets/, `${script} does not lay the copies out into public/`)
  }
  assert.match(web.scripts.assets, /plotly:dist/)
})

test('the strict build is used: without it the frame policy would need unsafe-eval', () => {
  const web = JSON.parse(read('web/package.json')) as { dependencies: Record<string, string> }
  assert.ok(web.dependencies['plotly.js-strict-dist-min'], 'the strict build is not among the dependencies')
  assert.equal(web.dependencies['plotly.js-dist-min'], undefined, 'the regular build drags eval along')
})
