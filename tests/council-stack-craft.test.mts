/**
 * Пульт консилиума: три обещания карточки, которых она не держала.
 *
 * Первое — счёт. Полосу режима CouncilStack складывал руками, третьим способом
 * рядом с `councilStripText` и счётчиками сервера, и уже разошёлся с ними:
 * «· 0 разных ответов» в начале работы писал только он.
 *
 * Второе — «неверно». Статус `wrong` знает весь продукт: охряная черта под
 * сегментом группы, чип, отметка сильнее запуска у оракула, — а поставить его
 * было нечем: пульт слал только `true` и `null`. Мёртвая ветка в четырёх
 * файлах — это не «на будущее», это ложь про то, что умеет преподаватель.
 *
 * Третье — вывод, не поехавший со стопкой. Полный кадр режется по бюджету
 * (server/src/control.ts), и попытка сверх бюджета приезжает с пустым
 * `outputs` и `outputsOmitted`. Пустой вывод и «вывода в кадре нет» — разные
 * вещи: молча показав первый вместо второго, карточка сказала бы, что запуск
 * ничего не напечатал.
 *
 * Разметка читается из компонента (как в `panels-craft.test.mts`), а цепочка
 * «что кнопка шлёт → какой это статус → каким словом он выйдет» — настоящими
 * функциями.
 */
import fs from 'node:fs'
import path from 'node:path'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { attemptStatus } from '../shared/protocol.js'
import { statusLabel, toneOf } from '../web/src/lib/council-board.js'

function read(rel: string): string {
  return fs.readFileSync(path.resolve(import.meta.dirname, '..', rel), 'utf8')
}

/** Разметка без комментариев: объяснение — не обещание. */
function code(source: string): string {
  return source.replace(/<!--[\s\S]*?-->/g, '').replace(/\/\*[\s\S]*?\*\//g, '')
}

const STACK = code(read('web/src/components/council/CouncilStack.svelte'))
const PROTOCOL = read('shared/protocol.ts')

/* ------------------------------------------------------------------- счёт */

test('полоса режима считает одной функцией на весь клиент', () => {
  assert.match(STACK, /import \{ councilStripText \} from '@\/lib\/council\.svelte'/)
  // Второй довод — число групп НА ЭКРАНЕ: сервер считает их по всей комнате,
  // а человек пересчитывает глазами то, что доехало до стопки.
  assert.match(STACK, /councilStripText\(board\.counts, groups\.length\)/)
  assert.doesNotMatch(STACK, /plural\(board\.counts\.attempts/, 'своей копии не осталось')
  assert.doesNotMatch(STACK, /plural\(groups\.length/)
})

/* --------------------------------------------------------------- отметки */

test('преподаватель может сказать «неверно», а не только «верно»', () => {
  assert.match(STACK, /tr\('room\.ui\.77'\)/, 'кнопка есть')
  assert.match(
    STACK,
    /onmark\(attempt\.participantId, attempt\.correct === false \? null : false\)/,
    'она шлёт false и снимается собой же',
  )
  assert.match(
    STACK,
    /onmark\(attempt\.participantId, attempt\.correct === true \? null : true\)/,
    '«Верно» осталась однотактной: второе нажатие снимает, а не переворачивает',
  )
  assert.match(STACK, /aria-pressed=\{attempt\.correct === false\}/)
})

test('«неверно» доходит до чипа и до цвета черты тем же словом', () => {
  const wrong = attemptStatus({ run: null, correct: false })
  assert.equal(wrong, 'wrong')
  assert.equal(statusLabel({ status: wrong, run: null }), 'неверно')
  // Охра, а не красный: красным помечена упавшая ячейка, и путать «ядро не
  // смогло» с «преподаватель не согласен» нельзя.
  assert.equal(toneOf(wrong), 'error')
  // Отметка сильнее запуска — иначе «неверно» на прошедшем запуске пропало бы.
  assert.equal(
    attemptStatus({
      run: { state: 'ok', outputs: [], execCount: 1, ranMs: 12, startedAt: 0, by: 'host' },
      correct: false,
    }),
    'wrong',
  )
})

/* ------------------------------------------------------- вывод по запросу */

test('кадр «пришлите эту попытку целиком» объявлен обеими сторонами', () => {
  assert.match(PROTOCOL, /t: 'council:attempt'; cellId: string; participantId: string/)
  assert.match(PROTOCOL, /outputsOmitted\?: boolean/)
})

test('карточка даёт повод попросить вывод, а помнит просьбу стопка', () => {
  assert.match(STACK, /onneedoutputs\?: \(participantId: string\) => void/, 'просьба — колбэком')
  const effect = STACK.slice(STACK.indexOf('$effect(() => {'), STACK.indexOf('function go('))
  assert.match(effect, /attempt\?\.run\?\.outputsOmitted/, 'повод — только урезанная попытка')
  assert.match(effect, /onneedoutputs\?\.\(attempt\.participantId\)/)
  // Своей памяти о заданных вопросах у карточки нет: она в CouncilState, и
  // вторая копия разошлась бы с первой на первом же переподключении — полный
  // кадр стопки просьбы обнуляет.
  assert.doesNotMatch(effect, /new Set|asked\./, 'дедупликация — не здесь')

  const state = fs.readFileSync(
    path.resolve(import.meta.dirname, '..', 'web/src/lib/council.svelte.ts'),
    'utf8',
  )
  // Ключ с `startedAt`: попытку запускают повторно, и у НОВОГО запуска вывод
  // снова может не влезть в бюджет кадра.
  assert.match(state, /wantOutputs\(cellId: string, participantId: string\)/)
  assert.match(state, /\$\{cellId\}:\$\{participantId\}:\$\{run\.startedAt\}/)
  assert.match(state, /t: 'council:attempt', cellId, participantId/)
})

test('пустой вывод и «вывода в кадре нет» карточка называет по-разному', () => {
  assert.match(STACK, /\{:else if attempt\.run\.outputsOmitted\}/)
  assert.match(STACK, /onneedoutputs \? tr\('room\.ui\.63'\) : tr\('room\.ui\.64'\)/)
})

test('пульт ищет запросы во всей стопке и подтверждает точный запрос', () => {
  assert.match(STACK, /pendingRunRequests\(board\.attempts\)/)
  assert.match(STACK, /onapproverun\(attempt\.participantId, request\.id\)/)
  assert.match(STACK, /ondeclinerun\(attempt\.participantId, request\.id\)/)
  assert.match(STACK, /decideRun\(attempt, 'approve'\)/)
  assert.match(STACK, /decideRun\(attempt, 'decline'\)/)
  assert.match(STACK, /<select[\s\S]*?pendingRequests/)
  assert.match(STACK, /textarea, input, select, \[contenteditable\]/, 'стрелки списка не листают стопку')
})

test('ячейка связывает запрос, отмену и решения с клиентом, а режим выбирается явно', () => {
  const cell = code(read('web/src/components/notebook/CellView.svelte'))
  assert.match(cell, /<option value="false">\{tr\('room\.ui\.336'\)\}<\/option>/)
  assert.match(cell, /<option value="true">\{tr\('room\.ui\.337'\)\}<\/option>/)
  assert.match(cell, /<option value="request">\{tr\('room\.ui\.338'\)\}<\/option>/)
  assert.match(cell, /session\.council\.requestRun\(id\)/)
  assert.match(cell, /session\.council\.cancelRunRequest\(id, request\.id\)/)
  assert.match(cell, /onapproverun=\{\(participantId, requestId\) => session\.council\.approveRunRequest\(id, participantId, requestId\)\}/)
  assert.match(cell, /ondeclinerun=\{\(participantId, requestId\) => session\.council\.declineRunRequest\(id, participantId, requestId\)\}/)
  assert.match(cell, /tr\('room\.ui\.363'\)/)
  // Ожидание названо чипом «Запрошено 14:31 · отменить» (доска E), а не
  // строкой «Ожидает решения преподавателя»: время в нём — то, о чём спросят.
  assert.match(cell, /tr\('room\.ui\.1237', \{ p0: clock\(mine\.runRequest\.requestedAt\) \}\)/)
  assert.match(cell, /tr\('room\.ui\.364'\)/)
})
