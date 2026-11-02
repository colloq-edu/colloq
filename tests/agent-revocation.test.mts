/**
 * An "Act" turn acts with its asker's rights only while the asker has them.
 *
 * A turn outlives the request that started it: the route answers 202 at
 * once, and the turn goes on writing files and running code for minutes on
 * the role that request had. In those minutes a teacher's staff account,
 * their link or their seat in the room can be taken away, and the room's
 * rules were the only thing re-read before each tool: a teacher deleted from
 * the staff list mid-turn went on writing files in a room where files and
 * "Act" are the teacher's alone.
 *
 * Everything goes the real way: the request through the route, the tools
 * through the turn. The model is a fake that takes the rights away while it
 * "thinks" (where a real model's answer is in flight), as the first of two
 * tools lands in the feed or while a run waits in the queue, and then asks
 * for one more write or run. A change made in this process arrives as an
 * event; one made by another process does not, and the check before the next
 * tool has to catch it by itself. One test holds the tool itself to the
 * same rule, for hands made before the rights went.
 */
import './_env.mts'
import { randomUUID } from 'node:crypto'
import http from 'node:http'
import express from 'express'
import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { STAFF_COOKIE } from '../shared/admin.js'
import { cellId, chatAnswer, chatSteps, createCell, findChatEntry, getCells, getChat, type YCell } from '../shared/notebook.js'
import { LECTURE_ROOM } from '../shared/rules.js'
import { listActivity } from '../server/src/activity.js'
import { addRoomTeacher, removeRoomTeacher } from '../server/src/admin/access.js'
import { staffCookieValue } from '../server/src/admin/auth.js'
import { getOracleSettings, updateOracleSettings } from '../server/src/admin/settings.js'
import { createTeacher, deleteTeacher, rotateLinkKey } from '../server/src/admin/store.js'
import { stopAll, useTool, type Hands } from '../server/src/ai/agent.js'
import { signToken } from '../server/src/auth.js'
import { grantOf } from '../server/src/authorization.js'
import { getSessionDoc, shutdownCollab } from '../server/src/collab/index.js'
import { createSession, db, setRules, upsertParticipant } from '../server/src/db.js'
import { aiRoutes } from '../server/src/routes/ai.js'
import { statPath } from '../server/src/workspace.js'

/** One answer of the fake: files to write (calls in one answer), a cell to run, or words that end the turn. */
type Reply = { write: string[] } | { run: string } | { text: string }

function callsOf(step: { write: string[] } | { run: string }, round: number) {
  const calls = 'run' in step
    ? [{ name: 'run_cell', args: { cell: step.run } }]
    : step.write.map((path) => ({ name: 'write_file', args: { path, content: `written in round ${round}` } }))
  return calls.map((call, i) => ({
    id: `call-${round}-${i}`,
    type: 'function',
    function: { name: call.name, arguments: JSON.stringify(call.args) },
  }))
}

let script: Reply[] = []
/** What happens to the world as the request of round N reaches the model. */
let meanwhile: Record<number, () => void> = {}
let round = 0
/** A change of the world that threw: the turn would wait for an answer that never comes, so `act` says it at once. */
let broken: unknown = null

let model: http.Server
let routes: http.Server
let base = ''
let was = getOracleSettings()

before(async () => {
  model = http.createServer((request, response) => {
    let body = ''
    request.on('data', (chunk) => (body += chunk))
    request.on('end', () => {
      round += 1
      try {
        meanwhile[round]?.()
      } catch (error) {
        broken = error
      }
      const step = script[round - 1] ?? { text: 'Готово' }
      const message =
        'text' in step
          ? { role: 'assistant', content: step.text }
          : { role: 'assistant', content: null, tool_calls: callsOf(step, round) }
      response.setHeader('content-type', 'application/json')
      response.end(JSON.stringify({ choices: [{ message }] }))
    })
  })
  await new Promise<void>((resolve) => model.listen(0, '127.0.0.1', resolve))
  was = getOracleSettings()
  updateOracleSettings({
    provider: 'custom',
    baseUrl: `http://127.0.0.1:${(model.address() as { port: number }).port}/v1`,
    apiKey: 'test-only',
    model: 'test-model',
    agentSteps: 0,
  })

  const app = express()
  app.use(express.json())
  app.use(aiRoutes())
  routes = http.createServer(app)
  await new Promise<void>((resolve) => routes.listen(0, '127.0.0.1', resolve))
  base = `http://127.0.0.1:${(routes.address() as { port: number }).port}`
})

after(() => {
  model?.closeAllConnections()
  model?.close()
  routes?.closeAllConnections()
  routes?.close()
  updateOracleSettings({ agentSteps: was.agentSteps })
  shutdownCollab()
})

/**
 * A lecture room, files and "Act" the teacher's alone, and its teacher in
 * their own browser: a participant token, host by the staff cookie.
 */
function lectureWithTeacher(id: string) {
  createSession(id, `Отзыв ${id}`, null)
  setRules(id, LECTURE_ROOM)
  const teacher = createTeacher({ name: `Учитель ${id}`, email: `${id}@test.local`, role: 'teacher' })
  assert.ok(teacher)
  addRoomTeacher(id, teacher.id, null)
  upsertParticipant({ id: 'p_teacher', sessionId: id, name: 'Учитель', avatar: null, role: 'participant' })
  const token = signToken({ sessionId: id, participantId: 'p_teacher', role: 'participant' })
  const headers = { authorization: `Bearer ${token}`, cookie: `${STAFF_COOKIE}=${staffCookieValue(teacher)}` }
  return { teacher, headers }
}

/** As the first step of the turn lands in the feed — between it and the next tool — do this. */
function afterFirstStep(id: string, then: () => void): void {
  const chat = getChat(getSessionDoc(id).doc)
  const steps = chatSteps(chat.get(chat.length - 1))
  const watch = () => {
    if (steps.length === 0) return
    steps.unobserve(watch)
    then()
  }
  steps.observe(watch)
}

/** Ask for a turn the way the room does, and wait for it to end. */
async function act(id: string, headers: Record<string, string>, plan: Reply[], world: Record<number, () => void> = {}) {
  script = plan
  meanwhile = world
  round = 0
  broken = null
  const asked = await fetch(`${base}/api/sessions/${id}/ai/ask`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify({ message: 'разложи файлы', mode: 'agent' }),
  })
  assert.equal(asked.status, 202, await asked.clone().text())
  const { entryId } = (await asked.json()) as { entryId: string }
  for (let waited = 0; waited < 500; waited++) {
    if (broken) throw broken
    const finished = listActivity(id).events.find((event) => event.kind === 'oracle.work_finished')
    if (finished) {
      const entry = findChatEntry(getSessionDoc(id).doc, entryId)
      return { outcome: finished.details.outcome, answer: entry ? chatAnswer(entry).toString() : '' }
    }
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  stopAll(id)
  throw new Error('the turn did not finish')
}

const written = (id: string, path: string) => statPath(id, path) !== null

/**
 * What rotateLinkKey writes, done the way another process would do it: on
 * the shared database, past this process's listeners. A fresh key each time:
 * the column is unique.
 */
function rotateElsewhere(staffId: string): void {
  db.prepare('UPDATE staff SET link_key = ?, auth_version = auth_version + 1 WHERE id = ?').run(`elsewhere-${randomUUID()}`, staffId)
}

/** A code cell in the room's notebook. Tests have no kernel: a queued run stays queued until taken back. */
function codeCell(id: string): YCell {
  const cell = createCell('code', 'print(1)')
  getCells(getSessionDoc(id).doc).push([cell])
  return cell
}

/** As this cell joins the run queue — while the turn waits for its output — do this. */
function whenQueued(cell: YCell, then: () => void): void {
  const watch = () => {
    if (cell.get('state') !== 'queued') return
    cell.unobserve(watch)
    then()
  }
  cell.observe(watch)
}

test('a teacher deleted while the model answers: the write that answer asks for is refused, and the turn ends cancelled', async () => {
  const id = 'revoke-deleted'
  const { teacher, headers } = lectureWithTeacher(id)
  const turn = await act(id, headers, [{ write: ['before.txt'] }, { write: ['after-revocation.txt'] }], {
    2: () => deleteTeacher(teacher.id),
  })
  assert.ok(written(id, 'before.txt'), 'the step before the revocation was not made')
  assert.equal(written(id, 'after-revocation.txt'), false, 'the turn wrote a file for a teacher who no longer exists')
  assert.equal(turn.outcome, 'cancelled')
  assert.match(turn.answer, /отозваны/)
})

test('a teacher unseated between two tools of one answer: the second is refused, and the turn ends cancelled', async () => {
  const id = 'revoke-unseated'
  const { teacher, headers } = lectureWithTeacher(id)
  const turn = await act(id, headers, [{ write: ['before.txt', 'after-revocation.txt'] }], {
    1: () => afterFirstStep(id, () => removeRoomTeacher(id, teacher.id)),
  })
  assert.ok(written(id, 'before.txt'), 'the step before the revocation was not made')
  assert.equal(written(id, 'after-revocation.txt'), false, 'the turn went on writing after the room was taken from its teacher')
  assert.equal(turn.outcome, 'cancelled')
})

test('a link rotated by another process, with no event here, is caught by the check before the next tool', async () => {
  const id = 'revoke-elsewhere'
  const { teacher, headers } = lectureWithTeacher(id)
  const turn = await act(id, headers, [{ write: ['before.txt'] }, { write: ['after-revocation.txt'] }], {
    2: () => rotateElsewhere(teacher.id),
  })
  assert.ok(written(id, 'before.txt'))
  assert.equal(written(id, 'after-revocation.txt'), false, 'the turn wrote a file on a link rotated elsewhere')
  assert.equal(turn.outcome, 'cancelled')
})

test('the run that answer asks for is refused the same way: the cell is never queued', async () => {
  const id = 'revoke-elsewhere-run'
  const { teacher, headers } = lectureWithTeacher(id)
  const cell = codeCell(id)
  const turn = await act(id, headers, [{ write: ['before.txt'] }, { run: cellId(cell) }], {
    2: () => rotateElsewhere(teacher.id),
  })
  assert.equal(cell.get('state') ?? 'idle', 'idle', 'the turn queued a run on a link rotated elsewhere')
  assert.equal(turn.outcome, 'cancelled')
})

test('a run the turn waits for is taken off the queue when its teacher is deleted', async () => {
  const id = 'revoke-waiting-run'
  const { teacher, headers } = lectureWithTeacher(id)
  const cell = codeCell(id)
  const turn = await act(id, headers, [{ run: cellId(cell) }, { write: ['after-revocation.txt'] }], {
    1: () => whenQueued(cell, () => deleteTeacher(teacher.id)),
  })
  assert.notEqual(cell.get('state'), 'queued', 'a run ordered on withdrawn rights stayed in the queue')
  assert.equal(written(id, 'after-revocation.txt'), false)
  assert.equal(turn.outcome, 'cancelled')
})

test('a tool on hands whose grant is gone refuses, whatever role the hands still carry', async () => {
  // The audit's probe, on the tool itself: hands made while the teacher taught the room.
  const id = 'revoke-hands'
  const { teacher } = lectureWithTeacher(id)
  const hands: Hands = {
    sessionId: id,
    entryId: 'e_hands',
    by: { name: 'Учитель', color: '#123456', participantId: 'p_teacher' },
    role: 'host',
    grant: grantOf(teacher, { sessionId: id, participantId: 'p_teacher' }),
  }
  const before = await useTool(hands, 'write_file', JSON.stringify({ path: 'before.txt', content: 'x' }))
  assert.equal(before.failed ?? false, false, before.said)
  deleteTeacher(teacher.id)
  const after = await useTool(hands, 'write_file', JSON.stringify({ path: 'after-revocation.txt', content: 'created with stale host rights' }))
  assert.equal(after.failed, true)
  assert.match(after.said, /отозваны/)
  assert.equal(written(id, 'after-revocation.txt'), false)
})

test('a tablet\'s turn ends with the link that handed it the console', async () => {
  const id = 'revoke-tablet'
  const { teacher } = lectureWithTeacher(id)
  // What /handoff/claim gives the tablet: host in the teacher's name, no cookie.
  const tablet = signToken({ sessionId: id, participantId: 'p_teacher', role: 'host', staff: teacher.id })
  const turn = await act(id, { authorization: `Bearer ${tablet}` }, [{ write: ['before.txt'] }, { write: ['after-revocation.txt'] }], {
    2: () => rotateLinkKey(teacher.id),
  })
  assert.ok(written(id, 'before.txt'))
  assert.equal(written(id, 'after-revocation.txt'), false, 'the tablet\'s turn outlived the link that made it the console')
  assert.equal(turn.outcome, 'cancelled')
})

test('a teacher who keeps the room keeps the turn, whatever else changes on the staff list', async () => {
  const id = 'revoke-none'
  const { teacher, headers } = lectureWithTeacher(id)
  createSession('revoke-none-other', 'Другая комната', null)
  addRoomTeacher('revoke-none-other', teacher.id, null)
  const colleague = createTeacher({ name: 'Коллега', email: 'revoke-none-colleague@test.local', role: 'teacher' })
  assert.ok(colleague)
  const turn = await act(id, headers, [{ write: ['before.txt'] }, { write: ['after.txt'] }], {
    // Another room taken from this teacher, and a colleague deleted: nothing of this room.
    2: () => {
      removeRoomTeacher('revoke-none-other', teacher.id)
      deleteTeacher(colleague.id)
    },
  })
  assert.ok(written(id, 'before.txt'))
  assert.ok(written(id, 'after.txt'), 'a change that took nothing from this room stopped the turn')
  assert.equal(turn.outcome, 'completed')
})
