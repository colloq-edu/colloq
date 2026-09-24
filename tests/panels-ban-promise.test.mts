import { translate, tr } from '../shared/i18n.js'
import './_env.mts'
/**
 * What the ban dialog promises — and what the room can do.
 *
 * A ban erases the person's questions from the shared feed, and that is a
 * consequence nobody would guess on their own. So the interface talks about
 * it — and in two places it said too much: "restoring a version brings the
 * questions back" (the confirmation dialog) and "restoring a version in the
 * history brings them back" (the caption under the list of removed people).
 * Neither is true: the room's history keeps the notebook's CELLS, and
 * restoring a version does not touch the feed at all. The teacher pressed
 * "Delete" sure that the move was reversible, and after "Restore notebook" at
 * the "before the ban" mark got an untouched notebook and the same empty feed.
 *
 * The test holds both sides: that the history really is not about the feed
 * (otherwise the promise could simply be kept), and that the caption in the
 * panel no longer promises it.
 */
import fs from 'node:fs'
import path from 'node:path'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import * as Y from 'yjs'
import { createCell, createChatEntry, getChat, CELLS_KEY } from '../shared/notebook.js'
import { cellsOf } from '../server/src/collab/history.js'

test('a version snapshot is the notebook cells, and the question feed is not in it', () => {
  const doc = new Y.Doc()
  doc.getArray<Y.Map<any>>(CELLS_KEY).push([createCell('code', 'print(1)')])
  getChat(doc).push([
    createChatEntry({
      participantId: 'p1',
      name: 'Нина',
      color: '#000',
      question: 'почему тут ошибка?',
    }),
  ])

  /*
   * `cellsAt(seq)` is the only source of what a restore puts back, and it comes
   * down to `cellsOf`. As long as that holds, "restoring a version brings the
   * questions back" is a promise at someone else's expense, however many marks the ban sets.
   */
  const restored = cellsOf(doc)
  assert.equal(restored.length, 1, 'there is one cell in the snapshot')
  assert.equal(restored[0].source, 'print(1)')
  const said = JSON.stringify(restored)
  assert.doesNotMatch(said, /почему тут ошибка/, 'the question does not get into the version snapshot')
  assert.ok(
    !Object.prototype.hasOwnProperty.call(restored[0], 'chat'),
    'a historical cell has no feed',
  )
})

test('the people panel no longer promises that restoring a version brings the questions back', () => {
  const source = fs.readFileSync(
    path.resolve(import.meta.dirname, '../web/src/components/panels/PeoplePanel.svelte'),
    'utf8',
  )
  // The caption under the list of removed people, without the comments around it.
  const markup = source.slice(source.indexOf('</script>')).replace(/<!--[\s\S]*?-->/g, '')
  assert.match(markup, /tr\('room\.ui\.667'\)/, 'the erased questions are mentioned')
  assert.match(translate('ru', 'room.ui.667'), /не восстанавливает удалённые вопросы и ответы оракула/)
  assert.doesNotMatch(
    translate('ru', 'room.ui.667'),
    /их возвращает восстановление/,
    'nor does it say that restoring a version brings them back',
  )
})
