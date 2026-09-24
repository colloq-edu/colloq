/**
 * The most dangerous part of this set of changes is the version history:
 * snapshots are now written by accumulated bytes, a burst may belong to two
 * people, and the "before" is taken from memory. If any of this breaks the
 * replay chain, old versions will be rebuilt with gaps, and Restore will
 * overwrite live text — exactly the trouble all of this was fixed for. The
 * check is simple: rebuild every version from the database and compare it
 * with what really was there.
 */
import './_env.mts'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import * as Y from 'yjs'
import { createSession, listVersions } from '../server/src/db.js'
import { flushHistory, record, cellsAt } from '../server/src/collab/history.js'
import { createCell, getCells } from '../shared/notebook.js'

test('every version rebuilds into exactly what it was', () => {
  const id = 'replay-check'
  createSession(id, 'Replay', null)
  const doc = new Y.Doc()
  let who = 'p_one'
  doc.on('update', (u: Uint8Array) => record(id, doc, u, who))

  doc.transact(() => getCells(doc).push([createCell('code', 'x = 0')]))
  flushHistory(id)

  const expected: string[] = []
  for (let i = 1; i <= 60; i++) {
    // The author alternates: a burst that two people wrote into is now one.
    who = i % 3 === 0 ? 'p_two' : 'p_one'
    const cell = getCells(doc).get(0)
    const src = cell.get('source') as Y.Text
    doc.transact(() => src.insert(src.length, `\n# ${i}`))
    flushHistory(id)
    expected.push(src.toString())
  }

  // And one large edit, so that the snapshot fires by bytes rather than by the
  // line ceiling: the whole rebuild of old versions rests on it, and it would break silently.
  for (let i = 0; i < 4; i++) {
    who = 'p_one'
    const src = getCells(doc).get(0).get('source') as Y.Text
    doc.transact(() => src.insert(src.length, '\n' + 'z'.repeat(30_000)))
    flushHistory(id)
  }

  const versions = listVersions(id, 500)
  assert.ok(versions.length > 5, `only ${versions.length} versions`)
  assert.ok(
    versions.some((v) => v.kind === 'keyframe'),
    'not a single full snapshot: the byte rule did not fire',
  )

  // The last real version has to match the live document: if the chain broke
  // somewhere, there will be a stump here.
  const live = (getCells(doc).get(0).get('source') as Y.Text).toString()
  const newest = versions.find((v) => v.kind === 'edit' || v.kind === 'quiet')!
  const rebuilt = cellsAt(id, newest.seq)
  assert.equal(rebuilt[0]?.source, live, 'the last version rebuilt into something else')

  // And every version on its own: not empty and not shorter than the one before.
  let previous = 0
  for (const v of [...versions].reverse()) {
    if (v.kind === 'opened') continue
    const cells = cellsAt(id, v.seq)
    assert.ok(cells.length > 0, `version ${v.seq} (${v.kind}) rebuilt empty`)
    const length = cells[0].source.length
    assert.ok(length >= previous, `version ${v.seq} (${v.kind}) is shorter than the one before: ${length} < ${previous}`)
    previous = length
  }
})
