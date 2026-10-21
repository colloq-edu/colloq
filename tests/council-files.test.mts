/**
 * A pool attempt's own files at their door (server/src/routes/council.ts ·
 * files, docs/architecture/remote-classes.md §9.7, D10): what the attempt
 * wrote into its folder on the machine, kept here by its sha256 and named on
 * its card. Its author and the teachers take it; nobody else — another
 * student, a link forwarded without its five-minute ticket, a ticket for
 * another file — and a file the card does not say is here is no file at all.
 *
 * The room is real (the db's session and people, the artifacts' folder under
 * the test's data directory); the attempt's run is the test's, handed to the
 * route as the store would (`runOf`).
 */
import './_env.mts'
import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import { createHash } from 'node:crypto'
import express from 'express'
import type { CouncilRun } from '../shared/protocol.js'
import { signToken } from '../server/src/auth.js'
import { shutdownCollab } from '../server/src/collab/index.js'
import { createSession, upsertParticipant } from '../server/src/db.js'
import { artifactPath } from '../server/src/kernel/remote/epochs.js'
import { councilRoutes } from '../server/src/routes/council.js'

after(() => shutdownCollab())

test('an attempt\'s kept file goes to its author and the teachers, by the header or a ticket for that one file; to nobody else, and nothing not kept', async (t) => {
  const id = 'council-files-1'
  createSession(id, 'Консилиум', null)
  upsertParticipant({ id: 'p_teacher', sessionId: id, name: 'Ада', avatar: null, role: 'host', tokenHost: true })
  upsertParticipant({ id: 'p_anya', sessionId: id, name: 'Аня', avatar: null, role: 'participant', tokenHost: false })
  upsertParticipant({ id: 'p_petya', sessionId: id, name: 'Петя', avatar: null, role: 'participant', tokenHost: false })
  const body = 'id,v\n1,2\n'
  const sha = createHash('sha256').update(body).digest('hex')
  const runId = 'a'.repeat(32)
  const target = artifactPath(id, runId, sha)
  fs.mkdirSync(path.dirname(target), { recursive: true })
  fs.writeFileSync(target, body)
  const run: CouncilRun = {
    state: 'ok', outputs: [], execCount: 1, ranMs: 1, startedAt: 0, by: 'host', placed: 'pool', runId,
    files: [
      { name: 'results/out.csv', bytes: body.length, kept: true, sha256: sha },
      { name: 'coming.csv', bytes: 3, kept: null, sha256: 'b'.repeat(64) },
      { name: 'big.bin', bytes: 2_000_000, kept: false },
    ],
  }
  const app = express()
  app.use(councilRoutes({
    attemptsOf: () => [],
    oracleOf: () => null,
    setOracle: () => undefined,
    runOf: (sessionId, cellId, participantId) => (sessionId === id && cellId === 'c1' && participantId === 'p_anya' ? run : null),
  }))
  const server = http.createServer(app)
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done))
  t.after(() => {
    server.closeAllConnections()
    server.close()
  })
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}/api/sessions/${id}/council/c1`
  const as = (who: string) => ({ authorization: `Bearer ${signToken({ sessionId: id, participantId: who, role: who === 'p_teacher' ? 'host' : 'participant' })}` })
  const query = (name: string) => `participant=p_anya&name=${encodeURIComponent(name)}`

  // Its author, by the header: the bytes as kept, under the file's own name.
  const mine = await fetch(`${base}/files?${query('results/out.csv')}`, { headers: as('p_anya') })
  assert.equal(mine.status, 200)
  assert.equal(await mine.text(), body)
  assert.match(mine.headers.get('content-disposition') ?? '', /attachment; filename="out\.csv"/)
  // The teacher too.
  const teacher = await fetch(`${base}/files?${query('results/out.csv')}`, { headers: as('p_teacher') })
  assert.deepEqual([teacher.status, await teacher.text()], [200, body])
  // Another student: refused in words.
  const other = await fetch(`${base}/files?${query('results/out.csv')}`, { headers: as('p_petya') })
  assert.equal(other.status, 403)
  assert.equal(((await other.json()) as { error: string }).error, 'Файлы попытки берут её автор и преподаватели.')
  assert.equal((await fetch(`${base}/files/ticket?${query('results/out.csv')}`, { headers: as('p_petya') })).status, 403)
  // A link with no credential: refused; with the ticket the author asked for this file: the file.
  assert.equal((await fetch(`${base}/files?${query('results/out.csv')}`)).status, 401)
  const asked = await fetch(`${base}/files/ticket?${query('results/out.csv')}`, { headers: as('p_anya') })
  assert.equal(asked.status, 200)
  const { token } = (await asked.json()) as { token: string }
  const anchor = await fetch(`${base}/files?${query('results/out.csv')}&token=${encodeURIComponent(token)}`)
  assert.deepEqual([anchor.status, await anchor.text()], [200, body])
  // That ticket opens that file alone, and buys no other ticket.
  assert.equal((await fetch(`${base}/files?${query('coming.csv')}&token=${encodeURIComponent(token)}`)).status, 401)
  assert.equal((await fetch(`${base}/files/ticket?${query('results/out.csv')}&token=${encodeURIComponent(token)}`)).status, 401)
  // A file on its way, one left behind, one never named, another cell: no file.
  for (const name of ['coming.csv', 'big.bin', 'nothing.txt']) {
    assert.equal((await fetch(`${base}/files?${query(name)}`, { headers: as('p_anya') })).status, 404, name)
  }
  assert.equal((await fetch(`${base.replace(/c1$/, 'c2')}/files?${query('results/out.csv')}`, { headers: as('p_anya') })).status, 404)
  // Its stored copy gone (the class deleted under it): no file, never an error of the server's.
  fs.rmSync(target)
  assert.equal((await fetch(`${base}/files?${query('results/out.csv')}`, { headers: as('p_anya') })).status, 404)
})
