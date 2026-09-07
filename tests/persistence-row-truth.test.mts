/**
 * Последняя преграда перед воскресшим семинаром спрашивает строку, а не память.
 *
 * Строка комнаты теперь отвечает из кэша (db.ts · roomCache) — так рукопожатие
 * пятисот вкладок перестало стоить тысячу SELECT. Но `write` в
 * collab/persistence.ts спрашивает то же самое ради другого: «есть ли ещё этот
 * семинар» — единственное, что мешает вкладке, забытой на удалённой комнате,
 * положить её тетрадь обратно на диск. Снимок без строки семинара — файл, до
 * которого не ведёт ни одна дверь: его не открыть и не удалить из панели.
 *
 * Если бы эта проверка шла через кэш, она держалась бы на том, что КАЖДЫЙ путь
 * удаления помнит про инвалидацию. Сегодня такой путь один
 * (routes/admin-instance.ts), и он помнит; завтра появится второй. Здесь
 * воспроизведён именно тот случай — строки нет, память о ней цела, — и снимок
 * всё равно не должен уехать.
 */
import './_env.mts'
import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import { createCell, getCells } from '../shared/notebook.js'
import { createSession, db, getSession, loadDocSnapshot } from '../server/src/db.js'
import { dropSessionDoc, getSessionDoc, shutdownCollab } from '../server/src/collab/index.js'

after(() => shutdownCollab())

test('удалённая комната не пишет снимок, даже если кэш о ней не забыли', () => {
  const id = 'persist-row-truth'
  createSession(id, 'Забытая инвалидация')

  const { doc } = getSessionDoc(id)
  getCells(doc).push([createCell('code', 'x = 1')])
  shutdownCollab()
  assert.ok(loadDocSnapshot(id), 'ничего не записалось — тест ничего не доказывает')

  // Кэш прогрет до удаления: это и есть исходное состояние живой комнаты.
  assert.ok(getSession(id), 'строки нет ещё до удаления — тест собран неверно')

  // Путь удаления, который забыл сказать db.ts о кэше: строки на диске больше
  // нет, а `getSession` про это не знает.
  dropSessionDoc(id)
  db.prepare('DELETE FROM doc_snapshots WHERE session_id = ?').run(id)
  db.prepare('DELETE FROM sessions WHERE id = ?').run(id)
  assert.ok(
    getSession(id),
    'кэш уже забыт — тест не воспроизводит забытую инвалидацию, и проверка ниже ничего не стоит',
  )

  // Вкладка, оставленная открытой, возвращается и печатает дальше.
  const { doc: ghost } = getSessionDoc(id)
  getCells(ghost).push([createCell('code', 'still here?')])
  shutdownCollab()

  assert.equal(loadDocSnapshot(id), null, 'снимок удалённого семинара уехал на диск')
})

test('живой комнате честный SELECT ничего не запрещает', () => {
  /*
   * Обратная сторона той же проверки: она стоит на пути КАЖДОГО снимка, и
   * ошибка в ней стоила бы не воскресшего семинара, а всех сразу — сервер
   * молча перестал бы сохранять живые комнаты.
   */
  const id = 'persist-row-alive'
  createSession(id, 'Живая комната')

  const { doc } = getSessionDoc(id)
  getCells(doc).push([createCell('code', 'answer = 42')])
  shutdownCollab()

  assert.ok(loadDocSnapshot(id), 'живая комната перестала сохраняться')
})
