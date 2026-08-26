/**
 * What the model is told happened before.
 *
 * The oracle thread lives in the shared document, and the same `answer`
 * field carries two very different things: what the model said, and the
 * sentence explaining why it could not. Both were replayed as `role:
 * oracle`, so after one bad key or one timeout the model believed it had
 * said "The AI endpoint rejected the API key" — and answered accordingly, for
 * the rest of the seminar.
 */
import './_env.mts'
import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import * as Y from 'yjs'
import { getChat } from '../shared/notebook.js'
import { createSession } from '../server/src/db.js'
import { getSessionDoc, shutdownCollab } from '../server/src/collab/index.js'
import { recentTurns } from '../server/src/ai/index.js'

after(() => shutdownCollab())

let seq = 0
function room() {
  const id = `hist${seq++}`
  createSession(id, `History ${id}`)
  return getSessionDoc(id).doc
}

interface Turn {
  name?: string
  question?: string
  answer?: string
  state?: string
}

function say(doc: Y.Doc, turn: Turn): void {
  const chat = getChat(doc)
  const entry = new Y.Map<unknown>()
  entry.set('id', `q_${Math.random().toString(36).slice(2, 9)}`)
  entry.set('participantId', 'p_1')
  entry.set('name', turn.name ?? 'Maria')
  entry.set('color', '#7e82f0')
  entry.set('question', turn.question ?? '')
  entry.set('action', 'ask')
  entry.set('cellId', null)
  entry.set('createdAt', 1)
  entry.set('state', turn.state ?? 'done')
  const answer = new Y.Text()
  if (turn.answer) answer.insert(0, turn.answer)
  entry.set('answer', answer)
  doc.transact(() => chat.push([entry]))
}

test('an ordinary exchange is replayed as it happened', () => {
  const doc = room()
  say(doc, { question: 'why is the loss nan?', answer: 'The learning rate is too high.' })
  assert.deepEqual(recentTurns(doc), [
    { role: 'user', content: 'Maria asked: why is the loss nan?' },
    { role: 'assistant', content: 'The learning rate is too high.' },
  ])
})

test('a failed turn does not come back as something the model said', () => {
  const doc = room()
  say(doc, {
    question: 'why is the loss nan?',
    answer: 'The AI endpoint rejected the API key — check it in the admin panel.',
    state: 'error',
  })
  const turns = recentTurns(doc)
  assert.deepEqual(
    turns.filter((t) => t.role === 'assistant'),
    [],
    'the error sentence was replayed as an oracle turn',
  )
  // The question still happened, and is still worth the context.
  assert.deepEqual(turns, [{ role: 'user', content: 'Maria asked: why is the loss nan?' }])
})

test('a cancelled answer is still left out', () => {
  const doc = room()
  // '(stopped)' is what settle() writes when somebody presses Stop before a
  // single token arrived — it is the room's word for the empty answer.
  say(doc, { question: 'explain this', answer: '(stopped)', state: 'done' })
  const oracleTurns = recentTurns(doc).filter((t) => t.role === 'assistant')
  assert.deepEqual(oracleTurns, [], 'the stop marker was replayed as an answer')
})

test('one failure does not cost the exchanges around it', () => {
  const doc = room()
  say(doc, { name: 'Ana', question: 'what is a stride?', answer: 'How far the kernel steps.' })
  say(doc, { name: 'John', question: 'and padding?', answer: 'The endpoint timed out.', state: 'error' })
  say(doc, { name: 'Ana', question: 'so which is it?', answer: 'Padding adds a border.' })
  assert.deepEqual(recentTurns(doc), [
    { role: 'user', content: 'Ana asked: what is a stride?' },
    { role: 'assistant', content: 'How far the kernel steps.' },
    { role: 'user', content: 'John asked: and padding?' },
    { role: 'user', content: 'Ana asked: so which is it?' },
    { role: 'assistant', content: 'Padding adds a border.' },
  ])
})

test('an answer still streaming is carried, because it is real', () => {
  const doc = room()
  say(doc, { question: 'why?', answer: 'It returns cached blocks to the driver, so', state: 'streaming' })
  const oracleTurns = recentTurns(doc).filter((t) => t.role === 'assistant')
  assert.equal(oracleTurns.length, 1)
})

test('a question nobody typed carries no user turn', () => {
  const doc = room()
  say(doc, { question: '', answer: 'What are you stuck on?' })
  assert.deepEqual(recentTurns(doc), [{ role: 'assistant', content: 'What are you stuck on?' }])
})
