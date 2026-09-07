/**
 * Разбор постраничных кадров чернил во вкладке — вторая половина core-9.
 *
 * Приветственная пачка везла ВСЕ чернила лекции одним кадром: двадцать минут
 * письма — около мегабайта на сокет, а после сбоя Wi-Fi зал возвращается весь
 * сразу, и мегабайт умножается на пятьсот. Обрезать пачку сервер один не может
 * — пока вкладка считает кадр `ink` полным письмом лекции, обрезанная пачка
 * гасит у ведущего исписанные листы. Значит мера другая: текущая страница,
 * ОПИСЬ остальных (`ink:pages`) и страница по вопросу (`ink:page`).
 *
 * Опись, вопрос и замену держит lecture/ink.ts, и они проверены в
 * lecture-ink-page. Здесь — то, что стоит на входе провода: разбор трёх кадров
 * в `session.svelte.ts` и два места, где опись обязана погаснуть, иначе пульт
 * до конца пары считает листы прошлой лекции и рисует пустые эскизы стёртых.
 *
 * Разбор живёт в рунном классе, и без браузера его не позвать: обещания сняты
 * с исходника — ровно как в weblib-reconnect-storm, — а арифметика описи
 * проверена вживую теми же функциями, которые зовёт разбор.
 */
import fs from 'node:fs'
import path from 'node:path'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { InkStroke } from '../shared/lecture.js'
import { boardsInked } from '../web/src/components/lecture/pult.js'
import {
  askInkPage,
  forgetInkPages,
  inkedPages,
  noteInkedPages,
} from '../web/src/components/lecture/ink.js'

/* ------------------------------------------------------------- по исходнику */

/** Исходник без комментариев: объяснение — не обещание. */
function code(rel: string): string {
  const source = fs.readFileSync(path.resolve(import.meta.dirname, '..', rel), 'utf8')
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '')
}

const SESSION = code('web/src/lib/session.svelte.ts')

/** Одна ветка разбора: от `message.t === '…'` до следующей. */
function branch(t: string): string {
  const from = SESSION.indexOf(`message.t === '${t}'`)
  assert.notEqual(from, -1, `кадр ${t} вкладка не разбирает вовсе`)
  const rest = SESSION.slice(from)
  const to = rest.indexOf('} else if (message.t', 1)
  return to === -1 ? rest : rest.slice(0, to)
}

test('кадр страницы заменяет ЕЁ, а не всё письмо лекции', () => {
  assert.match(
    branch('ink:page'),
    /this\.ink = replaceInkPage\(this\.ink, message\.page, message\.strokes\)/,
    'страница легла поверх всего: соседние страницы пропали бы на первом же вопросе',
  )
  // И перерисовку заказывает тот же счётчик: холст рисует по нему, а не по массиву.
  assert.match(branch('ink:page'), /this\.inkRevision \+= 1/)
})

test('опись приезжает вместе со счётчиком правок', () => {
  const pages = branch('ink:pages')
  assert.match(pages, /noteInkedPages\(this, message\.pages\)/)
  // Без счётчика опись приехала бы молча: по нему пересчитываются и счёт
  // чистых листов, и лента эскизов, а меняет их ровно она.
  assert.match(pages, /this\.inkRevision \+= 1/)
})

test('кадр `ink` описью не считается — сколько страниц в нём, решает сервер', () => {
  // Обратное и есть та ошибка, ради которой опись заведена: приветственная
  // пачка с одной страницей объявила бы остальные чистыми, и пульт погасил бы
  // исписанные листы у ведущего посреди пары.
  assert.doesNotMatch(branch('ink'), /noteInkedPages/)
})

test('конец лекции и новая лекция гасят опись', () => {
  const lecture = branch('lecture')
  assert.match(lecture, /noteInkedPages\(this, \[\]\)/, 'опись пережила лекцию')
  // Признак новой — время начала: перезаход в ту же приходит с тем же.
  assert.match(lecture, /message\.state\.startedAt !== before\?\.startedAt/)
})

test('«стереть» вычёркивает страницу и из описи', () => {
  assert.match(branch('ink:clear'), /noteInkedPages\(this, \[\]\)/, 'стёрли всё — опись осталась')
  assert.match(branch('ink:clear'), /this\.#forgetInkedPage\(page\)/)
  // И ластик, снявший со страницы последний штрих, — но только если её чернила
  // у нас были: страница, которой на руках нет, после этого кадра всё равно
  // неизвестна.
  const drop = branch('ink:drop')
  assert.match(drop, /const had = this\.ink\.some\(\(stroke\) => stroke\.page === message\.page\)/)
  assert.match(drop, /this\.#forgetInkedPage\(message\.page\)/)
})

test('вопрос про страницу не встаёт в очередь офлайна', () => {
  // Очередь держит шестнадцать нажатий и выбрасывает старые: вопрос про
  // чернила, вытеснивший чужой запуск ячейки, — плохая мена. Спросят заново,
  // когда связь вернётся: пачка привезёт свежую опись.
  const offline = /DISCARDED_OFFLINE = new Set<[^>]+>\(\[([^\]]*)\]/.exec(SESSION)
  assert.ok(offline, 'список выброшенного в офлайне перестал читаться отсюда')
  assert.match(offline[1], /'ink:page'/)
})

/* ------------------------------------------------------------------ вживую */

function stroke(page: number, id: string): InkStroke {
  return { id, page, color: '#101a33', width: 0.004, points: [0, 0, 0.1, 0.1] }
}

/** Вкладка в том объёме, в каком её знают чернила: держит, шлёт, связана. */
function tab(ink: InkStroke[]) {
  const state = { ink, connected: true, send() {} }
  forgetInkPages()
  return { session: state as unknown as Parameters<typeof askInkPage>[0], state }
}

test('стёртая страница уходит из ленты — как и до постраничной выдачи', () => {
  // То же правило, что в session.svelte.ts · #forgetInkedPage: опись сервера и
  // страницы на руках складываются, и вычёркивается из суммы.
  const { session, state } = tab([stroke(-1, 'a'), stroke(-2, 'b')])
  noteInkedPages(session, [-2, -1, 3])
  assert.equal(boardsInked(inkedPages(session)), 2)

  // Ведущий стёр второй лист целиком: кадр `ink:clear` с его страницей.
  state.ink = state.ink.filter((known) => known.page !== -2)
  noteInkedPages(session, [...inkedPages(session)].filter((known) => known !== -2))

  assert.deepEqual(
    [...inkedPages(session)].sort((a, b) => a - b),
    [-1, 3],
    'страница осталась в описи: лента рисовала бы пустой эскиз, а пульт держал бы лишний лист',
  )
  assert.equal(boardsInked(inkedPages(session)), 1)
})

test('новая лекция не наследует листы прошлой', () => {
  const { session, state } = tab([stroke(-2, 'a')])
  noteInkedPages(session, [-2, -1])
  assert.equal(boardsInked(inkedPages(session)), 2)

  // Лекцию закончили и начали другую: сервер забыл чернила, вкладка — опись.
  state.ink = []
  noteInkedPages(session, [])
  assert.equal(
    boardsInked(inkedPages(session)),
    0,
    'два листа прошлой лекции стояли бы в ленте новой пустыми',
  )
})
