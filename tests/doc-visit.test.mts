/**
 * Гость тетради: поднять документ ради одной строки — и уйти, ничего не унеся.
 *
 * Переименование в панели, чтение ленты, публикация, импорт и сводка
 * консилиума поднимают документ комнаты, в которой никого нет. Раньше он
 * оставался в памяти до перезапуска, теперь его отпускает `visitSessionDoc`
 * (server/src/routes/doc-visit.ts) — и отпускает выселением без закрытий,
 * `releaseSessionDoc`. Дверь удаления (`dropSessionDoc`) здесь звалась раньше,
 * и всякий шаг, добавленный туда «по случаю удаления», уезжал и в
 * переименование прошлогоднего семинара, и в чтение его ленты — то есть по
 * живому.
 *
 * Здесь прибито то, чего визит делать не должен ни при какой правке соседнего
 * модуля: терять записанное, сносить строки семинара, трогать файлы комнаты на
 * диске и выселять документ у тех, кто в комнате сидит.
 */
import './_env.mts'
import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { createSession, getSession, listVersions } from '../server/src/db.js'
import { sessionDir } from '../server/src/workspace.js'
import { getSessionDoc, peekSessionDoc, shutdownCollab } from '../server/src/collab/index.js'
import { visitSessionDoc } from '../server/src/routes/doc-visit.js'
import { cellSource, createCell, getCells, getMeta } from '../shared/notebook.js'

after(() => shutdownCollab())

test('визит в пустую комнату дописывает, отпускает и ничего не сносит', () => {
  const id = 'visit-cold'
  createSession(id, 'Прошлогодний семинар', null)

  // Работа класса: ячейка в тетради и файл рядом с ней.
  {
    const { doc } = getSessionDoc(id)
    const cells = getCells(doc)
    cells.delete(0, cells.length)
    const cell = createCell('code', '')
    cells.push([cell])
    cellSource(cell).insert(0, 'x = 1')
    // Холодный путь: ровно то состояние, в котором комната встречает
    // перезапуск сервера — на диске всё, в памяти ничего.
    shutdownCollab()
  }
  const file = path.join(sessionDir(id), 'utils.py')
  const text = 'def f():\n    return 1\n'
  fs.writeFileSync(file, text)
  assert.equal(peekSessionDoc(id), null, 'комната осталась в памяти — тест ничего не проверяет')

  const before = listVersions(id, 100).length

  // Ровно то, что делает переименование в панели (routes/admin-instance.ts).
  visitSessionDoc(id, (doc) => getMeta(doc).set('title', 'Семинар 3'))

  assert.equal(peekSessionDoc(id), null, 'визит поселил тетрадь в памяти')
  assert.ok(getSession(id), 'визит снёс сам семинар')
  assert.equal(fs.readFileSync(file, 'utf8'), text, 'визит тронул файлы комнаты')
  assert.ok(listVersions(id, 100).length >= before, 'визит потерял строки ленты')

  /*
   * И записанное доехало до диска: следующий вошедший видит и новое имя, и
   * старую работу. Без сброса снимка перед выселением визит уходил бы вхолостую
   * — правка была, а после перезапуска её нет.
   */
  const { doc } = getSessionDoc(id)
  assert.equal(getMeta(doc).get('title'), 'Семинар 3')
  const cells = getCells(doc)
  assert.equal(cells.length, 1, 'тетрадь поднялась не из своего снимка')
  assert.equal(cellSource(cells.get(0)).toString(), 'x = 1')
})

test('визит в живую комнату не выселяет её документ', () => {
  const id = 'visit-live'
  createSession(id, 'Идущая пара', null)
  // Комната открыта: документ поднят теми, кто в ней сидит.
  const { doc } = getSessionDoc(id)

  const seen = visitSessionDoc(id, (inside) => inside)

  assert.equal(seen, doc, 'гость взял не тот документ, что открыт у комнаты')
  assert.equal(peekSessionDoc(id)?.doc, doc, 'визит выселил комнату, в которой сидят')

  // Тот же объект, а не поднятый заново из снимка двойник: правка, сделанная
  // после визита, видна там, куда пишут все остальные.
  getCells(doc).push([createCell('code', 'y = 2')])
  const cells = getCells(peekSessionDoc(id)?.doc ?? doc)
  assert.equal(cellSource(cells.get(cells.length - 1)).toString(), 'y = 2')
})
