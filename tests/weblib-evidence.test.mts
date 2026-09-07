/**
 * Косвенный признак, принятый за факт: обрезанный список и голый статус.
 *
 * Две половины одной привычки — решать необратимое по данным, которые этого не
 * доказывают. Первая: обрезанный список файлов читался как «файла нет».
 * Вторая: любой отказ в рукопожатии читался как «ключ протух», а любой 404 —
 * как «комнаты больше нет».
 *
 * Обход папок на сервере упирается в потолок (server/src/workspace.ts ·
 * MAX_ENTRIES), и по обрезанному списку клиент делал необратимое: гасил общий
 * экран у ВСЕЙ комнаты и закрывал людям их вкладки. На паре это выглядит так:
 * студент распаковал датасет на три тысячи картинок — `slides/lecture.pdf` не
 * влез в обход, — и зал вылетел из лекции в пустой центр, а каждый входящий с
 * этого момента лекции не видел вовсе (приветственная пачка шлёт `board`, а
 * следом `files`).
 *
 * Сервер эту же ошибку у себя уже исправил и о настоящей пропаже объявляет
 * кадром `board`. Здесь проверяется клиентская половина правила: полный список
 * — свидетельство, обрезанный — нет.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { boardGone } from '../web/src/lib/board.js'
import { restore, type Room } from '../web/src/lib/tabs.svelte.js'
import { verdictOf, verdictOnFailure } from '../web/src/lib/identity.js'
import { ApiError } from '../web/src/lib/api.js'
import { SESSION_MISSING, type FileEntry } from '../shared/protocol.js'

function file(path: string, dir = false): FileEntry {
  return { path, name: path.split('/').pop() ?? path, dir, size: 10, modifiedAt: 0 }
}

const BOARD = 'slides/lecture.pdf'

test('полный список без документа — документа правда нет', () => {
  assert.equal(boardGone(BOARD, [file('utils.py')], false), true)
})

test('обрезанный список без документа ничего не доказывает', () => {
  assert.equal(
    boardGone(BOARD, [file('images/0001.png'), file('images/0002.png')], true),
    false,
    'лекция погасла у всей комнаты из-за потолка обхода',
  )
})

test('документ на месте — ни при полном списке, ни при обрезанном ничего не гасится', () => {
  assert.equal(boardGone(BOARD, [file(BOARD), file('utils.py')], false), false)
  assert.equal(boardGone(BOARD, [file(BOARD)], true), false)
})

test('папка с тем же именем — не документ', () => {
  assert.equal(boardGone(BOARD, [file(BOARD, true)], false), true)
})

test('комната ни на что не смотрит — гасить нечего', () => {
  assert.equal(boardGone(null, [], false), false)
})

/* ------------------------------------------------------------- вкладки */

function room(alive: string[], truncated = false): Room {
  return { alive: new Set(alive), firstBook: 'разбор.ipynb', board: null, truncated }
}

test('по обрезанному списку вкладки не пропалываются', () => {
  const saved = { open: ['разбор.ipynb', 'utils.py'], active: 'utils.py' }
  assert.deepEqual(restore(saved, room(['разбор.ipynb'], true)), saved)
})

test('по полному списку вкладка на исчезнувший файл уходит', () => {
  const saved = { open: ['разбор.ipynb', 'utils.py'], active: 'utils.py' }
  assert.deepEqual(restore(saved, room(['разбор.ipynb'])), {
    open: ['разбор.ipynb'],
    active: 'разбор.ipynb',
  })
})

test('потолок памяти вкладок выше того, что человек откроет руками', () => {
  // Здесь стояло двенадцать, и тринадцатая вкладка после F5 исчезала молча:
  // в живой комнате она была, а после перезагрузки её не было.
  const many = Array.from({ length: 30 }, (_, i) => `файл${i}.py`)
  const back = restore({ open: many, active: many[29] }, room(many))
  assert.deepEqual(back.open, many)
  assert.equal(back.active, many[29])
})

/* ------------------------------------------- почему нас не пускают в комнату */

test('забаненный слышит про бан, а не про истёкшее место', () => {
  const until = Date.now() + 86_400_000
  assert.deepEqual(
    verdictOf({ tokenValid: false, ban: { until }, participantId: 'p1', role: null }),
    {
      why: 'banned',
      until,
    },
  )
  // И даже с годным ключом: бан старше ключа, и путать их — значит увести
  // человека на форму имени, то есть предложить обойти бан переименованием.
  assert.equal(
    verdictOf({ tokenValid: true, ban: { until }, participantId: 'p1', role: 'participant' }).why,
    'banned',
  )
})

test('годный ключ при закрытом сокете — это обрыв, а не протухший ключ', () => {
  assert.deepEqual(
    verdictOf({ tokenValid: true, ban: null, participantId: 'p1', role: 'participant' }),
    { why: 'unknown' },
  )
})

test('негодный ключ без бана — назваться заново', () => {
  assert.deepEqual(verdictOf({ tokenValid: false, ban: null, participantId: null, role: null }), {
    why: 'expired',
  })
})

test('комнаты нет только по нашим словам: любой другой 404 — «не знаю»', () => {
  assert.deepEqual(verdictOnFailure(new ApiError(SESSION_MISSING, 404)), { why: 'gone' })
  // Ретранслятор без подключённого frpc, статика на весь путь, сборка сервера
  // без этой двери — всё это 404 без наших слов, и по нему стирался офлайн-набор.
  assert.deepEqual(verdictOnFailure(new ApiError('Not found (404)', 404)), { why: 'unknown' })
  assert.deepEqual(verdictOnFailure(new ApiError('not found', 404)), { why: 'unknown' })
  assert.deepEqual(verdictOnFailure(new ApiError('связи нет', 0)), { why: 'unknown' })
  assert.deepEqual(verdictOnFailure(new ApiError('The server failed (502)', 502)), {
    why: 'unknown',
  })
})

test('отказ со сроком — тоже бан: дверь могли повесить за общую проверку', () => {
  const until = Date.now() + 3600_000
  assert.deepEqual(
    verdictOnFailure(new ApiError('преподаватель закрыл вам доступ', 403, null, until)),
    {
      why: 'banned',
      until,
    },
  )
  // А 403 без срока — правило комнаты, а не бан: это «не знаю».
  assert.deepEqual(verdictOnFailure(new ApiError('Not allowed (403)', 403)), { why: 'unknown' })
})
