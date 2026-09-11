import './_env.mts'
import { after, test } from 'node:test'
import http from 'node:http'
import express from 'express'
import { EventEmitter } from 'node:events'
import { WebSocket } from 'ws'
import assert from 'node:assert/strict'
import { createSession, db, upsertParticipant } from '../server/src/db.js'
import { ACTIVITY_MAX_EVENTS, activitySummary, appendActivity, listActivity, trimActivity } from '../server/src/activity.js'
import { activityRoutes } from '../server/src/routes/activity.js'
import { signToken } from '../server/src/auth.js'
import { getSessionDoc, handleCollabSocket, shutdownCollab } from '../server/src/collab/index.js'
import { createCell, getCells } from '../shared/notebook.js'
import { dispatch } from '../server/src/control.js'

after(() => shutdownCollab())

function room(id: string) {
  createSession(id, 'Activity', null)
  upsertParticipant({ id: 'p_test', sessionId: id, name: 'Nina', avatar: null, role: 'participant' })
}

test('activity filters before pagination and preserves the recorded name without arbitrary data', () => {
  const id = 'activity-filter'
  room(id)
  appendActivity(id, 'p_test', 'oracle.asked', { action: 'ask', prompt: 'SECRET' } as any)
  appendActivity(id, 'p_test', 'presence.joined')
  appendActivity(id, 'p_test', 'execution.queued', { count: 2 })
  appendActivity(id, 'p_test', 'oracle.finished', { outcome: 'completed' })
  upsertParticipant({ id: 'p_test', sessionId: id, name: 'Renamed', avatar: null, role: 'participant' })
  const page = listActivity(id, { level: 'important', limit: 1 })
  assert.equal(page.events[0].kind, 'oracle.finished')
  assert.ok(page.nextBefore)
  const next = listActivity(id, { level: 'important', limit: 1, before: page.nextBefore! })
  assert.equal(next.events[0].kind, 'oracle.asked')
  assert.equal(next.events[0].actor?.name, 'Nina')
  assert.equal(next.nextBefore, null)
  assert.ok(!JSON.stringify(next).includes('SECRET'))
  assert.equal(listActivity(id, { level: 'normal' }).events.length, 3)
  assert.equal(listActivity(id, { level: 'detailed', category: 'presence' }).events.length, 1)
})

test('presence records people once across tabs, duplicate close callbacks and reconnects', () => {
  const id = 'activity-tabs'
  room(id)
  function socket() {
    const ws = Object.assign(new EventEmitter(), {
      readyState: WebSocket.OPEN as number, bufferedAmount: 0,
      send(_frame: unknown, _options: unknown, done?: () => void) { done?.() },
      ping() {}, terminate() {},
      close() { this.readyState = WebSocket.CLOSED; this.emit('close') },
    })
    handleCollabSocket(ws as unknown as WebSocket, id, 'participant', 'p_test')
    return ws
  }
  const first = socket(), second = socket()
  assert.deepEqual(listActivity(id).events.map(event => event.kind), ['presence.joined'])
  first.close()
  assert.equal(listActivity(id).events.length, 1)
  second.close()
  second.emit('error', new Error('late close'))
  assert.deepEqual(listActivity(id).events.map(event => event.kind), ['presence.left', 'presence.joined'])
  const reconnect = socket()
  assert.equal(listActivity(id).events[0].kind, 'presence.joined')
  reconnect.close()
})

test('activity endpoint enforces teacher access and room isolation with validated pagination', async () => {
  const id = 'activity-route'
  room(id)
  upsertParticipant({ id: 'teacher', sessionId: id, name: 'Teacher', avatar: null, role: 'host', tokenHost: true })
  appendActivity(id, 'p_test', 'oracle.asked')
  const app = express().use(activityRoutes())
  const server = http.createServer(app)
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`
  const request = (participantId?: string, query = '', tokenRoom = id) => fetch(`${base}/api/sessions/${id}/activity${query}`, {
    headers: participantId ? { authorization: `Bearer ${signToken({ sessionId: tokenRoom, participantId, role: 'host' })}` } : {},
  })
  try {
    assert.equal((await request()).status, 401)
    assert.equal((await request('p_test')).status, 403, 'claimed role in token must not grant host access')
    assert.equal((await request('teacher', '', 'another-room')).status, 401)
    const response = await request('teacher', '?level=detailed&category=oracle&limit=1')
    assert.equal(response.status, 200)
    assert.equal((await response.json()).events[0].kind, 'oracle.asked')
    for (const [participantId, status] of [['p_test', 403], ['teacher', 200]] as const) {
      const token = signToken({ sessionId: id, participantId, role: 'host' })
      const summary = await fetch(`${base}/api/sessions/${id}/activity/summary`, { headers: { authorization: `Bearer ${token}` } })
      assert.equal(summary.status, status)
      if (status === 200) assert.equal((await summary.json()).summaries[0].events, 1)
    }
    for (const query of ['?level=no', '?limit=101', '?before=-1', '?category=secrets', '?limit=1.5']) {
      assert.equal((await request('teacher', query)).status, 400)
    }
  } finally { server.close() }
})

test('automatic retention enforces the raw ceiling while cumulative totals retain every event', () => {
  const id = 'activity-auto-trim'
  room(id)
  db.transaction(() => {
    for (let index = 0; index < ACTIVITY_MAX_EVENTS + 5; index++) {
      appendActivity(id, 'p_test', 'execution.finished', { source: 'participant', outcome: 'completed', durationMs: 10 })
    }
  })()
  const count = (db.prepare('SELECT COUNT(*) AS n FROM session_activity WHERE session_id = ?').get(id) as { n: number }).n
  assert.ok(count <= ACTIVITY_MAX_EVENTS)
  assert.equal(listActivity(id).trimmed, true)
  const summary = activitySummary(id).summaries[0]
  assert.equal(summary.events, ACTIVITY_MAX_EVENTS + 5)
  assert.equal(summary.durationMs, (ACTIVITY_MAX_EVENTS + 5) * 10)
})

test('retention is bounded, reports lost history and deletion removes its rows', () => {
  const id = 'activity-trim'
  room(id)
  for (let i = 0; i < 5; i++) appendActivity(id, 'p_test', 'presence.joined')
  assert.equal(trimActivity(id, 2), 3)
  const page = listActivity(id)
  assert.equal(page.events.length, 2)
  assert.equal(page.trimmed, true)
  assert.equal(activitySummary(id).summaries[0].events, 5, 'retention must not erase semester totals')
  db.prepare('DELETE FROM sessions WHERE id = ?').run(id)
  assert.equal(listActivity(id).events.length, 0)
  assert.deepEqual(activitySummary(id).summaries, [])
  appendActivity(id, 'p_test', 'oracle.finished', { outcome: 'cancelled' })
  assert.equal(listActivity(id).events.length, 0, 'late completion must not resurrect a deleted room')
})

test('council submissions count accepted state changes and exclude drafts and duplicate clicks', () => {
  const id = 'activity-council'
  room(id)
  const cellId = 'activity-council-cell'
  const { doc } = getSessionDoc(id)
  const cell = createCell('code', '# Task', cellId)
  doc.transact(() => { getCells(doc).push([cell]); cell.set('open', 'council') })
  const ws = { readyState: WebSocket.OPEN, send() {} } as unknown as WebSocket
  const who = { sessionId: id, participantId: 'p_test', role: 'participant' as const }
  dispatch(ws, id, who, { t: 'council:submit', cellId })
  assert.equal(listActivity(id).events.length, 0, 'empty attempt is not a submission')
  dispatch(ws, id, who, { t: 'council:draft', cellId, text: 'PRIVATE SOLUTION' })
  assert.equal(listActivity(id).events.length, 0)
  dispatch(ws, id, who, { t: 'council:submit', cellId })
  dispatch(ws, id, who, { t: 'council:submit', cellId })
  assert.deepEqual(listActivity(id).events.map(event => event.kind), ['council.submitted'])
  dispatch(ws, id, who, { t: 'council:withdraw', cellId })
  dispatch(ws, id, who, { t: 'council:withdraw', cellId })
  assert.deepEqual(listActivity(id).events.map(event => event.kind), ['council.withdrawn', 'council.submitted'])
  assert.ok(!JSON.stringify(listActivity(id)).includes('PRIVATE SOLUTION'))
})
