/**
 * The feed says that it is not all there is.
 *
 * A room's history is limited in size: `trimHistory` (db.ts) removes the
 * beginning as a whole segment, up to the nearest snapshot. After that the
 * panel shows the remainder exactly as it would show the full feed of a short
 * class — and from the list one cannot tell "nothing was written here" from
 * "nothing before this point survived". And people usually look at the
 * history precisely when they have lost something.
 *
 * The server computes the flag, from state rather than from memory of an
 * event: the very first row of a room is always `opened`, and it will not
 * appear a second time (collab/history.ts · beginHistory). So "the oldest row
 * is not `opened`" is exactly "the beginning was cut off" — and the answer
 * survives a server restart.
 *
 * What is checked here is that the flag reaches the panel: computing it
 * correctly and leaving it in the database is exactly the same silent
 * incompleteness.
 *
 * It says nothing about the feed window: `MAX_VERSIONS` (routes/history.ts)
 * does not return all rows either, but those are in the database and open by
 * link — the two kinds of incompleteness must not be mixed in one word.
 */
import './_env.mts'
import http from 'node:http'
import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import type { VersionList } from '../shared/history.js'
import { signToken } from '../server/src/auth.js'
import {
  appendVersion,
  createSession,
  db,
  trimHistory,
  upsertParticipant,
} from '../server/src/db.js'
import { app } from '../server/src/app.js'
import { shutdownCollab } from '../server/src/collab/index.js'

let base = ''
let server: http.Server

before(async () => {
  server = http.createServer(app)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  base = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`
})

after(() => {
  server?.close()
  shutdownCollab()
})

/** A room with one participant who gets the feed by default. */
function room(id: string, title: string): void {
  createSession(id, title, null)
  upsertParticipant({
    id: 'p_nina',
    sessionId: id,
    name: 'Нина',
    avatar: null,
    role: 'participant',
  })
  // Rooms in tests live in one database: other rows with this id would throw
  // off the count.
  db.prepare('DELETE FROM doc_history WHERE session_id = ?').run(id)
}

/** A history row of the given weight; returns its seq. */
function line(sessionId: string, kind: string, bytes: number): number {
  return appendVersion({
    sessionId,
    update: new Uint8Array(bytes),
    kind,
    authorId: null,
    createdAt: Date.now(),
    label: null,
    summary: kind,
    added: 0,
    removed: 0,
    cells: [],
  })
}

async function history(id: string): Promise<VersionList> {
  const token = signToken({ sessionId: id, participantId: 'p_nina', role: 'participant' })
  const res = await fetch(`${base}/api/sessions/${id}/history`, {
    headers: { authorization: `Bearer ${token}` },
  })
  assert.equal(res.status, 200)
  return (await res.json()) as VersionList
}

test('a whole feed arrives without the trim flag', async () => {
  const id = 'hist-whole'
  room(id, 'Полная история')

  const body = await history(id)
  // The first read brings up the notebook, and with it the "opened" row: a
  // room where nothing has been written yet is not trimmed, and there is
  // nothing to tell it about that.
  assert.equal(body.trimmed, false, 'the panel was told the beginning was cut, but nobody cut it')
  assert.ok(body.versions.length >= 1, 'the feed does not even have the opening row')
})

test('after trimming by size the feed admits it is incomplete', async () => {
  const id = 'hist-cut'
  room(id, 'Длинная пара')

  line(id, 'opened', 4_000)
  line(id, 'edit', 4_000)
  const keyframe = line(id, 'keyframe', 64)
  line(id, 'edit', 64)

  // The ceiling is below what has piled up: the boundary lands exactly on the
  // snapshot, and "opened" goes away with everything that came before it.
  assert.ok(trimHistory(id, 1_000) > 0, 'the ceiling removed nothing — there was nothing to cut')
  const oldest = db
    .prepare('SELECT MIN(seq) AS seq FROM doc_history WHERE session_id = ?')
    .get(id) as { seq: number }
  assert.equal(oldest.seq, keyframe, 'the trim did not land on a snapshot')

  const body = await history(id)
  assert.equal(body.trimmed, true, 'the start of the history is gone, and the panel does not know it')
  // And the rows that remain arrive as usual: the flag is a note on the feed,
  // not a replacement for it.
  assert.ok(body.versions.length > 0, 'the feed itself disappeared along with the flag')
})
