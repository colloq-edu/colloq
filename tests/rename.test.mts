/**
 * A seminar has one name.
 *
 * It lives in two places — the sessions row the admin list reads, and
 * `meta.title` in the shared document the room's header shows and the host can
 * edit in place. They used to drift in both directions, so one seminar quietly
 * had two names: the panel said one thing and the people inside saw another.
 *
 * The document is the source of truth and the row mirrors it.
 */
import './_env.mts'
import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import { getMeta } from '../shared/notebook.js'
import { createSession, getSession } from '../server/src/db.js'
import { getSessionDoc, shutdownCollab } from '../server/src/collab/index.js'

after(() => shutdownCollab())

let seq = 0
function room(name: string) {
  const id = `rename${seq++}`
  createSession(id, name)
  const { doc } = getSessionDoc(id)
  return { id, meta: getMeta(doc) }
}

test('renaming the room renames the seminar', () => {
  const { id, meta } = room('Week 1')
  meta.set('title', 'Week 1 — Convolutions')
  assert.equal(getSession(id)?.name, 'Week 1 — Convolutions')
})

test('clearing the title does not wipe the seminar name', () => {
  const { id, meta } = room('Week 2')
  meta.set('title', 'Week 2 — Pooling')
  // A host who selects all and deletes before retyping passes through empty.
  // The list must not be left with a nameless seminar.
  meta.set('title', '')
  assert.equal(getSession(id)?.name, 'Week 2 — Pooling')
  meta.set('title', '   ')
  assert.equal(getSession(id)?.name, 'Week 2 — Pooling')
})

test('typing a name letter by letter settles on what was typed', () => {
  const { id, meta } = room('x')
  for (const step of ['W', 'We', 'Wee', 'Week', 'Week 3']) meta.set('title', step)
  assert.equal(getSession(id)?.name, 'Week 3')
})

test('a title that is not a string is ignored rather than stored', () => {
  const { id, meta } = room('Week 4')
  meta.set('title', 'Week 4 — Attention')
  // The document is shared; a client could put anything in here.
  meta.set('title', 42 as unknown as string)
  assert.equal(getSession(id)?.name, 'Week 4 — Attention')
  meta.set('title', null as unknown as string)
  assert.equal(getSession(id)?.name, 'Week 4 — Attention')
})

test('setting the same title again does not disturb the row', () => {
  const { id, meta } = room('Week 5')
  meta.set('title', 'Week 5 — RNNs')
  const first = getSession(id)?.name
  meta.set('title', 'Week 5 — RNNs')
  assert.equal(getSession(id)?.name, first)
})

test('other meta changes leave the name alone', () => {
  const { id, meta } = room('Week 6')
  meta.set('title', 'Week 6 — Transformers')
  meta.set('kernelStatus', 'busy')
  meta.set('runningCell', 'c_1')
  assert.equal(getSession(id)?.name, 'Week 6 — Transformers')
})
