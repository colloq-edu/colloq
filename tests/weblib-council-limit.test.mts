/**
 * Потолок попытки консилиума — одним числом на обе стороны.
 *
 * Ломалось это молча и по-крупному. Клиент числа не знал: снимок листа уезжал
 * на каждую паузу в наборе, сервер отвечал отказом по длине — и человек,
 * дописывающий длинную попытку, получал тост раз в секунду, из которого не
 * следует ни сколько набрано, ни сколько можно. А дальше хуже: снимок сверх
 * потолка не доезжает, и «Сдать» отправляет ТО, ЧТО ЛЕЖИТ У СЕРВЕРА, — у
 * студента на экране длинный текст помечен сданным, а в стопке преподавателя
 * лежит прошлый, короткий. Узнаётся это на разборе, когда переписывать поздно.
 *
 * Здесь проверяется чистая половина: число одно (`MAX_ATTEMPT_CHARS` из
 * shared), счётчик появляется до потолка, а не после, и «то ли лежит у сервера,
 * что на листе» — отдельный вопрос, на который есть чем ответить.
 */
import fs from 'node:fs'
import path from 'node:path'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { MAX_ATTEMPT_CHARS } from '../shared/notebook.js'
import {
  attemptCounter,
  attemptInSync,
  attemptTooLong,
} from '../web/src/lib/council.svelte.js'
import type { CouncilMine } from '../shared/protocol.js'

function mine(text: string): CouncilMine {
  return {
    text,
    submittedAt: 1,
    updatedAt: 1,
    shown: false,
    correct: null,
    reply: null,
    run: null,
    queue: null,
    closed: false,
  }
}

/* --------------------------------------------------------------- потолок */

test('потолок один и тот же, и он из общей земли', () => {
  assert.equal(MAX_ATTEMPT_CHARS, 8000)
  assert.equal(attemptTooLong('x'.repeat(MAX_ATTEMPT_CHARS)), false, 'ровно потолок — влезает')
  assert.equal(attemptTooLong('x'.repeat(MAX_ATTEMPT_CHARS + 1)), true)
  // Пустой лист — не «слишком длинный»: у попытки, которой ещё нет, длины нет.
  assert.equal(attemptTooLong(''), false)
})

test('счётчик молчит, пока до потолка далеко, и говорит разрядами', () => {
  assert.equal(attemptCounter(0), null)
  assert.equal(attemptCounter(3000), null, 'над каждым листом с первой буквы — это шум')
  // Девять десятых: место, где счётчик ещё предупреждение, а не приговор.
  assert.equal(attemptCounter(MAX_ATTEMPT_CHARS * 0.9 - 1), null)
  const near = attemptCounter(MAX_ATTEMPT_CHARS * 0.9)
  assert.ok(near !== null, 'у порога — появился')
  const over = attemptCounter(9012)
  assert.ok(over !== null)
  // Неразрывный пробел в разрядах: «9 012» не должно ломаться посреди числа.
  assert.match(over, /^9 012 из 8 000$/)
})

/* ----------------------------------------------------- «сдано» — чего? */

test('«то ли лежит у сервера, что на листе» — отдельный вопрос', () => {
  assert.equal(attemptInSync(mine('print(1)'), 'print(1)'), true)
  assert.equal(attemptInSync(mine('print(1)'), 'print(2)'), false, 'разошлись — «сдано» врёт')
  // Попытки на сервере ещё нет вовсе: пустой лист ей равен, а любой текст — нет.
  assert.equal(attemptInSync(undefined, ''), true)
  assert.equal(attemptInSync(null, 'x'), false)
})

/* ------------------------------------------- то, что рунами не проверить */

const STATE = fs.readFileSync(
  path.resolve(import.meta.dirname, '..', 'web/src/lib/council.svelte.ts'),
  'utf8',
)

test('снимок сверх потолка не уезжает вовсе — тоста на каждую паузу больше нет', () => {
  const at = STATE.indexOf('  draft(cellId: string')
  const draft = STATE.slice(at, at + 200)
  assert.match(draft, /if \(attemptTooLong\(text\)\) return/)
  assert.match(draft, /#outbox\.hold\(cellId, text\)/)
})

test('вывод сверх бюджета просится один раз на запуск, а не на каждый кадр', () => {
  const at = STATE.indexOf('  wantOutputs(')
  const want = STATE.slice(at, STATE.indexOf('  /** Запустить:', at))
  // Повод — только урезанная попытка: пустой вывод настоящего запуска ничего
  // не просит.
  assert.match(want, /if \(!run\?\.outputsOmitted\) return/)
  assert.match(want, /\$\{cellId\}:\$\{participantId\}:\$\{run\.startedAt\}/, 'ключ с запуском')
  assert.match(want, /#askedOutputs\.has\(key\)/)
  assert.match(want, /t: 'council:attempt', cellId, participantId/)
  // Полная стопка приезжает заново и режется заново — память о просьбах по
  // этой ячейке снимается, иначе карточка навсегда осталась бы без вывода.
  assert.match(STATE, /startsWith\(`\$\{message\.cellId\}:`\)\) this\.#askedOutputs\.delete\(key\)/)
})
