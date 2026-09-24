/**
 * Format at the wrong moment: a refusal in words — both to the person who
 * pressed it and to the room.
 *
 * Formatting goes to the kernel past the queue, and it must not be started
 * under a running cell: behind a cell waiting in `input()` the black request
 * would stand until the end of class. So the refusal is instant — but it was
 * instant and MUTE for everyone except the person who pressed: the line
 * "Formatting failed: …" was written only by the path after the kernel, and
 * early refusals returned before it. The room's notebook did not change, and
 * why was said nowhere.
 *
 * No kernel is needed here at all: the reason is visible before it would be
 * needed — that is the whole point of the refusal.
 */
import './_env.mts'
import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import type * as Y from 'yjs'
import { createSession } from '../server/src/db.js'
import { getSessionDoc, shutdownCollab } from '../server/src/collab/index.js'
import { getCells, getTerminal } from '../shared/notebook.js'
import { formatSession, requestRun, shutdownKernels } from '../server/src/kernel/index.js'

after(async () => {
  await shutdownKernels()
  shutdownCollab()
})

/** The room's kernel log — read by the whole room, not only by whoever pressed. */
function notes(doc: Y.Doc): string[] {
  return getTerminal(doc)
    .toArray()
    .filter((line) => line.get('kind') === 'system')
    .map((line) => String(line.get('text')))
}

test('Format on top of a queue refuses in words, and the same words go to the log', async () => {
  const id = 'fmt-refused'
  createSession(id, 'Formatting')
  const { doc } = getSessionDoc(id)
  // The second cell of a new notebook is code; the first is markdown, and Run
  // does not take it.
  const cellId = getCells(doc).get(1).get('id') as string

  // There is no kernel and there will be none (JUPYTER_URL in tests is a port
  // known to be dead), but the queue becomes non-empty right here,
  // synchronously: the pump goes off to wait for the kernel before it manages
  // to take anything from it.
  requestRun(id, [cellId], 'Ада', 'p_ada')
  const outcome = await formatSession(id)

  assert.match(
    outcome.error ?? '',
    /В очереди есть ячейки/,
    'the refusal must name the reason, not stay silent',
  )
  assert.equal(outcome.changed, 0, 'a refusal rewrites nothing')
  assert.ok(
    notes(doc).includes(`Форматирование не удалось: ${outcome.error}`),
    `the room did not get the reason: ${JSON.stringify(notes(doc))}`,
  )
})
