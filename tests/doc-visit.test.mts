/**
 * A notebook guest: bring up the document for the sake of one line — and
 * leave without taking anything away.
 *
 * A rename in the panel, reading the feed, publishing, an import and the
 * council summary bring up the document of a room with nobody in it. It used
 * to stay in memory until a restart; now `visitSessionDoc`
 * (server/src/routes/doc-visit.ts) lets it go — and lets it go by eviction
 * without closing anything, `releaseSessionDoc`. The deletion door
 * (`dropSessionDoc`) used to be called here, and every step added there "for
 * the occasion of deletion" also went into renaming last year's seminar and
 * reading its feed — that is, into the living.
 *
 * Pinned here is what the visit must not do under any edit of the
 * neighbouring module: lose what was written, delete the seminar's rows,
 * touch the room's files on disk, or evict the document from those sitting
 * in the room.
 */
import './_env.mts'
import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { createSession, getSession, listVersions } from '../server/src/db.js'
import { sessionDir } from '../server/src/workspace.js'
import { getSessionDoc, peekSessionDoc, shutdownCollab } from '../server/src/collab/index.js'
import { visitSessionDoc } from '../server/src/routes/doc-visit.js'
import { cellSource, createCell, getCells, getMeta } from '../shared/notebook.js'

after(() => shutdownCollab())

test('a visit to an empty room writes, lets go and deletes nothing', () => {
  const id = 'visit-cold'
  createSession(id, 'Прошлогодний семинар', null)

  // The class's work: a cell in the notebook and a file next to it.
  {
    const { doc } = getSessionDoc(id)
    const cells = getCells(doc)
    cells.delete(0, cells.length)
    const cell = createCell('code', '')
    cells.push([cell])
    cellSource(cell).insert(0, 'x = 1')
    // The cold path: exactly the state in which a room meets a server
    // restart — everything on disk, nothing in memory.
    shutdownCollab()
  }
  const file = path.join(sessionDir(id), 'utils.py')
  const text = 'def f():\n    return 1\n'
  fs.writeFileSync(file, text)
  assert.equal(peekSessionDoc(id), null, 'the room stayed in memory — the test checks nothing')

  const before = listVersions(id, 100).length

  // Exactly what a rename in the panel does (routes/admin-instance.ts).
  visitSessionDoc(id, (doc) => getMeta(doc).set('title', 'Семинар 3'))

  assert.equal(peekSessionDoc(id), null, 'the visit settled the notebook in memory')
  assert.ok(getSession(id), 'the visit deleted the seminar itself')
  assert.equal(fs.readFileSync(file, 'utf8'), text, 'the visit touched the room\'s files')
  assert.ok(listVersions(id, 100).length >= before, 'the visit lost feed rows')

  /*
   * And what was written reached the disk: the next person to come in sees
   * both the new name and the old work. Without flushing the snapshot before
   * eviction the visit would go idle — the edit was made, and after a
   * restart it is gone.
   */
  const { doc } = getSessionDoc(id)
  assert.equal(getMeta(doc).get('title'), 'Семинар 3')
  const cells = getCells(doc)
  assert.equal(cells.length, 1, 'the notebook came up not from its own snapshot')
  assert.equal(cellSource(cells.get(0)).toString(), 'x = 1')
})

test('a visit to a live room does not evict its document', () => {
  const id = 'visit-live'
  createSession(id, 'Идущая пара', null)
  // The room is open: the document was brought up by those sitting in it.
  const { doc } = getSessionDoc(id)

  const seen = visitSessionDoc(id, (inside) => inside)

  assert.equal(seen, doc, 'the guest took a different document from the one open in the room')
  assert.equal(peekSessionDoc(id)?.doc, doc, 'the visit evicted a room people are sitting in')

  // The same object, not a twin brought up again from the snapshot: an edit
  // made after the visit is visible where everyone else writes.
  getCells(doc).push([createCell('code', 'y = 2')])
  const cells = getCells(peekSessionDoc(id)?.doc ?? doc)
  assert.equal(cellSource(cells.get(cells.length - 1)).toString(), 'y = 2')
})
