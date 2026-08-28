/**
 * Историю комнаты должно быть можно развернуть обратно в тетрадь.
 *
 * Это ломалось молча и полностью. Базовая строка снималась с документа ДО
 * засева стартовых ячеек, а наблюдатель обновлений вешался ещё позже — так что
 * ячейки не попадали в историю вовсе. Каждая следующая строка была дельтой к
 * документу, которого история никогда не видела: Yjs складывал такие в
 * pending, и ЛЮБАЯ версия разворачивалась в пустую тетрадь. Вкладка «История»
 * показывала ноль ячеек и не жаловалась.
 *
 * На живой базе у семинара с двадцатью одной строкой все двадцать одна давали
 * ноль ячеек. Поэтому здесь две проверки: что новая комната пишет свои ячейки
 * первой же версией, и что комната, испорченная старой сборкой, чинится при
 * следующем открытии.
 */
import './_env.mts'
import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import * as Y from 'yjs'
import { appendVersion, createSession, db } from '../server/src/db.js'
import { dropSessionDoc, getSessionDoc, shutdownCollab } from '../server/src/collab/index.js'
import { cellsAt } from '../server/src/collab/history.js'

after(() => shutdownCollab())

const latestSeq = (id: string): number =>
  (db.prepare('SELECT MAX(seq) AS s FROM doc_history WHERE session_id = ?').get(id) as { s: number })
    .s

test('первая же версия новой комнаты разворачивается в её тетрадь', () => {
  const id = 'hist-fresh'
  createSession(id, 'Свежий', null)
  getSessionDoc(id, 'Свежий')
  const cells = cellsAt(id, latestSeq(id))
  assert.ok(cells.length > 0, 'история новой комнаты разворачивается в пустую тетрадь')
})

test('комната со сломанной базой чинится при следующем открытии', () => {
  const id = 'hist-broken'
  createSession(id, 'Сломанный', null)

  /*
   * Ровно то, что оставляла старая сборка: строка `opened`, снятая с пустого
   * документа. Она есть, `hasHistoryBase` довольна — и не разворачивается
   * ни во что.
   */
  const empty = new Y.Doc()
  appendVersion({
    sessionId: id,
    update: Y.encodeStateAsUpdate(empty),
    kind: 'opened',
    authorId: null,
    createdAt: Date.now(),
    label: null,
    summary: 'opened the seminar',
    added: 0,
    removed: 0,
    cells: [],
  })
  empty.destroy()
  assert.equal(cellsAt(id, latestSeq(id)).length, 0, 'подделка сломанной базы не удалась')

  // Открытие комнаты — единственный момент, когда это можно заметить и починить.
  getSessionDoc(id, 'Сломанный')
  assert.ok(
    cellsAt(id, latestSeq(id)).length > 0,
    'история осталась неразворачиваемой после открытия комнаты',
  )
})

test('здоровую историю починка не трогает', () => {
  // Лишняя строка на каждое открытие комнаты — это история, растущая от того,
  // что на неё смотрят.
  const id = 'hist-fine'
  createSession(id, 'Целый', null)
  getSessionDoc(id, 'Целый')
  const after = latestSeq(id)
  dropSessionDoc(id)
  getSessionDoc(id, 'Целый')
  assert.equal(latestSeq(id), after, 'открытие здоровой комнаты дописало версию')
})
