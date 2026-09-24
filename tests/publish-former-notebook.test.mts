/**
 * A publication's former address: the page moves, the notebook stays put.
 *
 * The page under the old name is redirected by a pointer file, and through it
 * the reader gets where they need to. "Download notebook" does not work that
 * way: a student copies that address as a link and opens it directly — the
 * browser downloads the file rather than showing a page — and after the
 * publication was renamed, the link from the group chat answered 404, even
 * though the page itself opened at the same old address. So `notebook.ipynb`
 * is written under every former address too.
 *
 * The second assertion here is about what is NOT duplicated. Images are not
 * kept under the old address on purpose: the pointer does not show them (it
 * has not a single `<img>`), and a copy would cost hundreds of kilobytes × the
 * number of former names. The test keeps both halves of the decision side by
 * side, so the next reader sees a choice rather than an omission — and, on
 * changing their mind, removes the assertion together with the argument.
 */
import './_env.mts'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createSession } from '../server/src/db.js'
import { exportSite } from '../server/src/publish/export.js'
import { formerSlugs, setPublicationSlug, writePublication } from '../server/src/publish/store.js'
import { BLOB_PREFIX } from '../shared/publish.js'
import type { PublicCell } from '../shared/publish.js'

const cell = (id: string, source: string, outputs: PublicCell['outputs'] = []): PublicCell => ({
  id,
  type: 'code',
  source,
  outputs,
  execCount: 1,
  ranMs: null,
})

/** An export directory that gets cleaned up afterwards. */
function exported(t: { after(fn: () => void): void }): {
  at: (...parts: string[]) => string
  read: (...parts: string[]) => string
} {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'colloq-site-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  exportSite(root, 'https://colloq.ru')
  const at = (...parts: string[]): string => path.join(root, ...parts)
  return { at, read: (...parts: string[]) => fs.readFileSync(at(...parts), 'utf8') }
}

test('the notebook downloads from every address the publication has had', (t) => {
  const id = 'pub-former-notebook'
  createSession(id, 'Переезд тетради', null)
  const pub = writePublication({
    sessionId: id,
    title: 'Переезд тетради',
    by: 'Ада',
    steps: [
      { seq: 2, label: 'перед упражнением', at: 1, cells: [cell('c1', 'before = 1')] },
      { seq: 0, label: 'сейчас', at: 2, cells: [cell('c2', 'after = 2')] },
    ],
    blobs: [],
  })
  // Two renames in a row: a publication can have more than one former name.
  assert.equal(setPublicationSlug(pub.id, 'nedelya-02'), 'ok')
  assert.equal(setPublicationSlug(pub.id, 'nedelya-03'), 'ok')
  assert.equal(setPublicationSlug(pub.id, 'nedelya-04'), 'ok')
  assert.deepEqual(formerSlugs('publication', pub.id), ['nedelya-02', 'nedelya-03'])

  const { at, read } = exported(t)
  const code = (...parts: string[]): string =>
    (JSON.parse(read(...parts)) as { cells: { source: string[] }[] }).cells
      .map((c) => c.source.join(''))
      .join('\n')

  // The current address: the root notebook is the last step, as it was.
  assert.equal(code('p', 'nedelya-04', 'notebook.ipynb'), 'after = 2')
  // And the same file under every address this page has already been given out at.
  for (const was of ['nedelya-02', 'nedelya-03', pub.id]) {
    assert.ok(
      fs.existsSync(at('p', was, 'notebook.ipynb')),
      `"Download notebook" at the address "${was}" leads to a 404 — ` +
        'and the link was copied before the rename',
    )
    assert.equal(code('p', was, 'notebook.ipynb'), 'after = 2')
    // The page at the same address is a pointer, not a copy: they must not drift apart.
    assert.match(read('p', was, 'index.html'), /https:\/\/colloq\.ru\/p\/nedelya-04\//)
  }
})

test('there are no images under the former address — a decision, not an omission', (t) => {
  const id = 'pub-former-blob'
  createSession(id, 'Переезд с картинкой', null)
  const hash = 'f'.repeat(32)
  const pub = writePublication({
    sessionId: id,
    title: 'Переезд с картинкой',
    by: 'Ада',
    steps: [
      {
        seq: 0,
        label: 'сейчас',
        at: 1,
        cells: [
          cell('c1', 'plt.show()', [
            { kind: 'data', data: { 'image/png': `${BLOB_PREFIX}${hash}` }, execCount: 1 },
          ]),
        ],
      },
    ],
    blobs: [{ hash, mime: 'image/png', body: Buffer.from('картинка на сотни килобайт') }],
  })
  assert.equal(setPublicationSlug(pub.id, 'grafik-01'), 'ok')
  assert.equal(setPublicationSlug(pub.id, 'grafik-02'), 'ok')

  const { at, read } = exported(t)
  // Under the current address the image is there and the page links to it.
  assert.ok(fs.existsSync(at('p', 'grafik-02', 'blob', `${hash}.png`)), 'the page has no image')
  assert.match(read('p', 'grafik-02', 'index.html'), new RegExp(`blob/${hash}\\.png`))

  const pointer = read('p', 'grafik-01', 'index.html')
  /*
   * The argument the decision rests on: the pointer draws nothing. As long as
   * that holds, a copy of the images under the old address is bytes nobody will
   * request; once it starts drawing, the assertion fails before the page goes
   * out to a class with empty frames.
   */
  assert.ok(!pointer.includes('<img'), 'the pointer started drawing images: it needs its own')
  assert.match(pointer, /https:\/\/colloq\.ru\/p\/grafik-02\//)
  assert.equal(
    fs.existsSync(at('p', 'grafik-01', 'blob')),
    false,
    'images were copied under the former address: there is nobody there to show them to, ' +
      'and they weigh hundreds of kilobytes per former name',
  )
  // The notebook is the opposite: its address is opened directly, and it has to be there.
  assert.ok(fs.existsSync(at('p', 'grafik-01', 'notebook.ipynb')))
})
