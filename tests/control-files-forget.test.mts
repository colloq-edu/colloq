/**
 * Рассылка списка файлов забывает обе памяти — даже когда рассылать некому.
 *
 * `broadcastFiles` зовут ровно потому, что папка изменилась. Пока обе памяти
 * (кадр на комнату здесь и короткая память обхода в workspace.ts) сбрасывались
 * ПОСЛЕ проверки «в комнате есть сокеты», комната без единого слушателя
 * оставалась с прежним ответом: файлы кладут и до того, как кто-то вошёл —
 * преподаватель готовит семинар с вечера, — и тот же самый запрос следом
 * отвечал `listTree` без только что положенного файла.
 *
 * Проверяется здесь именно это: пустая комната — не «ничего не изменилось».
 */
import './_env.mts'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createSession } from '../server/src/db.js'
import { broadcastFiles, closeControlRoom } from '../server/src/control.js'
import { listTree, makeFile } from '../server/src/workspace.js'

test('комната без сокетов — не повод оставить старое дерево', () => {
  const id = 'forget-empty'
  createSession(id, 'Пустая', null)
  makeFile(id, 'model.py', 'x = 1')

  const first = listTree(id)
  assert.deepEqual(
    first.files.map((entry) => entry.path),
    ['model.py'],
  )

  // Ни одного `handleControlSocket` — рассылать некому.
  broadcastFiles(id)

  /*
   * Тот же список, но ДРУГИМ массивом: память обхода сброшена, дерево посчитано
   * заново. Равенство путей здесь ничего не доказало бы — оно сошлось бы и на
   * памяти; доказывает именно потеря тождества (см. tests/workspace-memo.test.mts,
   * «второй вопрос подряд не стоит второго обхода»).
   */
  const second = listTree(id)
  assert.notEqual(second.files, first.files, 'память обхода пережила рассылку в пустую комнату')
  assert.deepEqual(
    second.files.map((entry) => entry.path),
    ['model.py'],
  )
  closeControlRoom(id)
})
