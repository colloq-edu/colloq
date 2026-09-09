import './_env.mts'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createSession, db } from '../server/src/db.js'
import * as council from '../server/src/council.js'
import type { CouncilRun } from '../shared/protocol.js'

const CELL = 'c_task'
const PERSON = 'p_author'
let sequence = 0
function room(): string {
  const id = `council-request-store-${++sequence}`
  createSession(id, 'Council requests', null)
  return id
}
function draft(id: string, cell = CELL, person = PERSON): void {
  council.saveDraft(id, cell, person, 'print(1)', 100)
}
const queued: CouncilRun = {
  state: 'queued', outputs: [], execCount: null, ranMs: null, startedAt: 200, by: 'host',
}

test('a repeated pending request keeps its identity and timestamp in both snapshots', () => {
  assert.equal(typeof council.requestAttemptRun, 'function', 'store must accept run requests')
  const id = room()
  draft(id)
  const request = council.requestAttemptRun(id, CELL, PERSON, 200)
  assert.ok(request)
  assert.ok(request.id.length > 0)
  assert.equal(request.status, 'pending')
  assert.equal(request.requestedAt, 200)
  assert.deepEqual(council.requestAttemptRun(id, CELL, PERSON, 300), request)
  assert.deepEqual(council.mineFor(id, CELL, PERSON, false)?.runRequest, request)
  assert.deepEqual(council.attemptFor(id, CELL, PERSON)?.runRequest, request)
  assert.equal(council.attemptOf(id, CELL, PERSON)?.submittedAt, null)
})

test('decline survives reload and retry rejects decisions for the previous request', () => {
  const id = room()
  draft(id)
  const first = council.requestAttemptRun(id, CELL, PERSON, 200)!
  assert.equal(council.resolveRunRequest(id, CELL, PERSON, first.id, 'decline'), true)
  council.resetCouncilCache(id)
  assert.deepEqual(council.mineFor(id, CELL, PERSON, false)?.runRequest, {
    ...first, status: 'declined',
  })
  assert.equal(council.resolveRunRequest(id, CELL, PERSON, first.id, 'clear'), false)
  const next = council.requestAttemptRun(id, CELL, PERSON, 400)!
  assert.notEqual(next.id, first.id)
  assert.equal(next.requestedAt, 400)
  assert.equal(next.status, 'pending')
  assert.equal(council.resolveRunRequest(id, CELL, PERSON, first.id, 'decline'), false)
  assert.equal(council.resolveRunRequest(id, CELL, PERSON, first.id, 'clear'), false)
  assert.deepEqual(council.attemptOf(id, CELL, PERSON)?.runRequest, next)
  assert.equal(council.resolveRunRequest(id, CELL, PERSON, next.id, 'clear'), true)
  assert.equal(council.attemptOf(id, CELL, PERSON)?.runRequest, null)
})

test('pending requests survive the cache being discarded and keep idempotency', () => {
  const id = room()
  draft(id)
  const request = council.requestAttemptRun(id, CELL, PERSON, 200)
  council.resetCouncilCache(id)
  assert.deepEqual(council.attemptOf(id, CELL, PERSON)?.runRequest, request)
  assert.deepEqual(council.requestAttemptRun(id, CELL, PERSON, 500), request)
})

test('only a change of draft text invalidates a request, including a declined request', () => {
  const id = room()
  draft(id)
  const request = council.requestAttemptRun(id, CELL, PERSON, 200)!
  council.saveDraft(id, CELL, PERSON, 'print(1)', 300)
  assert.deepEqual(council.attemptOf(id, CELL, PERSON)?.runRequest, request)
  council.saveDraft(id, CELL, PERSON, 'print(2)', 400)
  assert.equal(council.attemptOf(id, CELL, PERSON)?.runRequest, null)
  assert.equal(council.resolveRunRequest(id, CELL, PERSON, request.id, 'decline'), false)
  const next = council.requestAttemptRun(id, CELL, PERSON, 500)!
  council.resolveRunRequest(id, CELL, PERSON, next.id, 'decline')
  council.saveDraft(id, CELL, PERSON, 'print(3)', 600)
  council.resetCouncilCache(id)
  assert.equal(council.attemptOf(id, CELL, PERSON)?.runRequest, null)
})

test('missing, whitespace-only, queued and running attempts cannot request a run', () => {
  const id = room()
  assert.equal(council.requestAttemptRun(id, CELL, PERSON, 200), null)
  council.saveDraft(id, CELL, PERSON, ' \n\t ', 100)
  assert.equal(council.requestAttemptRun(id, CELL, PERSON, 200), null)
  draft(id)
  council.recordRun(id, CELL, PERSON, queued)
  assert.equal(council.requestAttemptRun(id, CELL, PERSON, 300), null)
  council.recordRun(id, CELL, PERSON, { ...queued, state: 'running' })
  assert.equal(council.requestAttemptRun(id, CELL, PERSON, 400), null)
  council.recordRun(id, CELL, PERSON, { ...queued, state: 'ok' })
  assert.equal(council.requestAttemptRun(id, CELL, PERSON, 500)?.status, 'pending')
})

test('submission and withdrawal leave the independent run request intact', () => {
  const id = room()
  draft(id)
  const request = council.requestAttemptRun(id, CELL, PERSON, 200)
  council.submitAttempt(id, CELL, PERSON, 300)
  assert.deepEqual(council.attemptOf(id, CELL, PERSON)?.runRequest, request)
  council.withdrawAttempt(id, CELL, PERSON)
  council.resetCouncilCache(id)
  assert.equal(council.attemptOf(id, CELL, PERSON)?.submittedAt, null)
  assert.deepEqual(council.attemptOf(id, CELL, PERSON)?.runRequest, request)
})

test('a generic teacher launch clears pending and declined requests persistently', () => {
  for (const decline of [false, true]) {
    const id = room()
    draft(id)
    const request = council.requestAttemptRun(id, CELL, PERSON, 200)!
    if (decline) council.resolveRunRequest(id, CELL, PERSON, request.id, 'decline')
    assert.equal(council.recordRun(id, CELL, PERSON, queued), true)
    assert.equal(council.attemptOf(id, CELL, PERSON)?.runRequest, null)
    council.resetCouncilCache(id)
    assert.equal(council.attemptOf(id, CELL, PERSON)?.runRequest, null)
  }
})

test('bulk clearing is scoped to the selected cell or room and returns affected authors', () => {
  const id = room()
  const otherRoom = room()
  for (const [session, cell, person] of [
    [id, CELL, PERSON], [id, CELL, 'p_other'], [id, 'c_other', PERSON],
    [otherRoom, CELL, PERSON],
  ]) {
    draft(session, cell, person)
    council.requestAttemptRun(session, cell, person, 200)
  }
  draft(id, CELL, 'p_no_request')
  const declined = council.attemptOf(id, CELL, 'p_other')!.runRequest!
  council.resolveRunRequest(id, CELL, 'p_other', declined.id, 'decline')
  assert.deepEqual(council.clearRunRequests(id, CELL), [
    { cellId: CELL, participantId: PERSON }, { cellId: CELL, participantId: 'p_other' },
  ])
  assert.deepEqual(council.clearRunRequests(id, CELL), [])
  council.resetCouncilCache(id)
  assert.equal(council.attemptOf(id, CELL, PERSON)?.runRequest, null)
  assert.equal(council.attemptOf(id, CELL, 'p_other')?.runRequest, null)
  assert.equal(council.attemptOf(id, 'c_other', PERSON)?.runRequest?.status, 'pending')
  assert.deepEqual(council.clearRunRequests(id), [{ cellId: 'c_other', participantId: PERSON }])
  assert.equal(council.attemptOf(otherRoom, CELL, PERSON)?.runRequest?.status, 'pending')
})

test('snapshots omit absent requests for older clients and old schemas gain the column safely', () => {
  const id = room()
  draft(id)
  db.exec('ALTER TABLE council_attempts DROP COLUMN run_request_json')
  council.ensureCouncilSchema()
  council.ensureCouncilSchema()
  council.resetCouncilCache(id)
  assert.equal(council.attemptOf(id, CELL, PERSON)?.text, 'print(1)')
  assert.equal(council.attemptOf(id, CELL, PERSON)?.runRequest, null)
  assert.equal('runRequest' in council.mineFor(id, CELL, PERSON, false)!, false)
  assert.equal('runRequest' in council.attemptFor(id, CELL, PERSON)!, false)
  const request = council.requestAttemptRun(id, CELL, PERSON, 200)
  council.resetCouncilCache(id)
  assert.deepEqual(council.attemptOf(id, CELL, PERSON)?.runRequest, request)
})

test('a legacy writer cannot leave a valid approval attached to different persisted code', () => {
  const id=room();draft(id)
  const request=council.requestAttemptRun(id,CELL,PERSON,200)!
  // An older release does not know the new request column and may update only text.
  db.prepare('UPDATE council_attempts SET text = ? WHERE session_id = ?').run('print("changed elsewhere")',id)
  council.resetCouncilCache(id)
  assert.equal(council.attemptOf(id,CELL,PERSON)?.runRequest,null)
  assert.equal(council.resolveRunRequest(id,CELL,PERSON,request.id,'clear'),false)
})
