/**
 * A page's former address: the page moves, the downloads stay put.
 *
 * A student copies «Скачать» as a link and opens it directly, and after the
 * page was renamed that link from the group chat must still download the
 * same file. The server resolves every address a page has had
 * (publish_addresses), so a download, a notebook tab, the ZIP and the 0.12
 * notebook link all work under a former name; the page itself answers with
 * its canonical address, from which the reader builds further links.
 */
import './_env.mts'
import http from 'node:http'
import express from 'express'
import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { createSession } from '../server/src/db.js'
import { shutdownCollab } from '../server/src/collab/index.js'
import { notebookMaterial } from '../server/src/publish/materials.js'
import {
  deletePublication,
  formerSlugs,
  setPublicationSlug,
  writePublication,
} from '../server/src/publish/store.js'
import { courseRoutes } from '../server/src/routes/courses.js'
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

let base = ''
let server: http.Server

before(async () => {
  const app = express()
  app.use(courseRoutes())
  server = http.createServer(app)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`
})

after(() => {
  server?.close()
  shutdownCollab()
})

/** One notebook page, the way a build writes it. */
function publish(
  sessionId: string,
  title: string,
  cells: PublicCell[],
  blobs: { hash: string; mime: string; body: Buffer }[] = [],
) {
  const byHash = new Map(blobs.map((b) => [b.hash, b]))
  const material = notebookMaterial({
    key: 'notebook',
    name: title,
    path: 'notebook.ipynb',
    cells,
    blob: (hash) => byHash.get(hash) ?? null,
  })
  return writePublication({ sessionId, title, by: 'Ада', materials: [material], blobs })
}

test('the notebook downloads from every address the page has had', async () => {
  const id = 'pub-former-notebook'
  createSession(id, 'Переезд тетради', null)
  const pub = publish(id, 'Переезд тетради', [cell('c2', 'after = 2')])
  // Two renames in a row: a page can have more than one former name.
  assert.equal(setPublicationSlug(pub.id, 'nedelya-02'), 'ok')
  assert.equal(setPublicationSlug(pub.id, 'nedelya-03'), 'ok')
  assert.equal(setPublicationSlug(pub.id, 'nedelya-04'), 'ok')
  assert.deepEqual(formerSlugs('publication', pub.id), ['nedelya-02', 'nedelya-03'])

  const code = async (route: string): Promise<string> => {
    const res = await fetch(`${base}${route}`)
    assert.equal(res.status, 200, route)
    return ((await res.json()) as { cells: { source: string[] }[] }).cells
      .map((c) => c.source.join(''))
      .join('\n')
  }
  for (const was of ['nedelya-04', 'nedelya-02', 'nedelya-03', pub.id]) {
    assert.equal(
      await code(`/api/p/${was}/m/notebook/download`),
      'after = 2',
      `«Скачать» at the address "${was}" leads nowhere, and the link was copied before the rename`,
    )
    // The 0.12 link too: it hops to the canonical address.
    const hop = await fetch(`${base}/api/p/${was}/notebook.ipynb`, { redirect: 'manual' })
    assert.equal(hop.headers.get('location'), '/api/p/nedelya-04/m/notebook/download')
    // And the page answers with the address it lives at now.
    const page = (await (await fetch(`${base}/api/p/${was}`)).json()) as { page: { address: string } }
    assert.equal(page.page.address, 'nedelya-04')
    const zip = await fetch(`${base}/api/p/${was}/zip`)
    assert.equal(zip.status, 200)
    assert.match(zip.headers.get('content-disposition') ?? '', /nedelya-04\.zip/)
    await zip.arrayBuffer()
  }

  // Erased for good: no address of it leads anywhere any more.
  deletePublication(pub.id)
  for (const was of ['nedelya-04', 'nedelya-02']) {
    assert.equal((await fetch(`${base}/api/p/${was}/m/notebook/download`)).status, 404)
  }
})

test('images ride inside the downloaded notebook, not next to it', async () => {
  const id = 'pub-former-blob'
  createSession(id, 'Переезд с картинкой', null)
  const hash = 'f'.repeat(32)
  const body = Buffer.from('картинка на сотни килобайт')
  const pub = publish(
    id,
    'Переезд с картинкой',
    [cell('c1', 'plt.show()', [{ kind: 'data', data: { 'image/png': `${BLOB_PREFIX}${hash}` }, execCount: 1 }])],
    [{ hash, mime: 'image/png', body }],
  )
  assert.equal(setPublicationSlug(pub.id, 'grafik-01'), 'ok')
  assert.equal(setPublicationSlug(pub.id, 'grafik-02'), 'ok')

  // The page's tab keeps the reference, drawn from the blob route under any address.
  const tab = (await (await fetch(`${base}/api/p/grafik-01/m/notebook`)).json()) as {
    notebook: { cells: PublicCell[] }
  }
  const output = tab.notebook.cells[0].outputs[0]
  assert.equal(output.kind === 'data' && output.data['image/png'], `${BLOB_PREFIX}${hash}`)
  assert.equal((await fetch(`${base}/api/p/grafik-01/blob/${hash}`)).status, 200)

  // The download carries the bytes themselves: opened offline, it has its plots.
  const nb = (await (await fetch(`${base}/api/p/grafik-01/m/notebook/download`)).json()) as {
    cells: { outputs: { data: Record<string, string> }[] }[]
  }
  assert.equal(nb.cells[0].outputs[0].data['image/png'], body.toString('base64'))
})
