import './_env.mts'
import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { app } from '../server/src/app.js'
import { createSession, upsertParticipant } from '../server/src/db.js'
import { appendActivity } from '../server/src/activity.js'
import { signToken } from '../server/src/auth.js'

const id = 'activity-app'
createSession(id, 'Activity integration')
upsertParticipant({ sessionId: id, id: 'teacher', name: 'Teacher', role: 'host', avatar: null, tokenHost: true })
upsertParticipant({ sessionId: id, id: 'student', name: 'Student', role: 'participant', avatar: null })
const server = http.createServer(app)
await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`
after(() => server.close())

test('real app exposes private activity and cumulative statistics only to the teacher', async () => {
  appendActivity(id, 'student', 'oracle.asked', { action: 'ask', source: 'participant' })
  for (const suffix of ['', '/summary']) {
    const url = `${base}/api/sessions/${id}/activity${suffix}`
    const teacher = signToken({ sessionId: id, participantId: 'teacher', role: 'host' })
    const response = await fetch(url, { headers: { authorization: `Bearer ${teacher}` } })
    assert.equal(response.status, 200)
    assert.match(response.headers.get('cache-control') ?? '', /private/)
    assert.match(response.headers.get('cache-control') ?? '', /no-store/)
    const body = await response.json()
    assert.equal((suffix ? body.summaries : body.events).length, 1)
    const student = signToken({ sessionId: id, participantId: 'student', role: 'participant' })
    assert.equal((await fetch(url, { headers: { authorization: `Bearer ${student}` } })).status, 403)
    assert.equal((await fetch(url)).status, 401)
  }
})
