/**
 * Постраничные чернила лекции: опись, вопрос и замена одной страницы.
 *
 * Чернила ездили одной мерой — ВСЕ страницы одним кадром в приветственной
 * пачке. Лекция с двадцатью минутами письма — это около мегабайта на сокет, а
 * смотрят в этот момент одну страницу; после сбоя Wi-Fi зал возвращается весь
 * сразу, и мегабайт умножается на пятьсот (аудит · core-9). Сервер обрезать
 * пачку сам не может: пульт считает по чернилам, сколько чистых листов
 * заведено, и рисует их разметкой в ленте эскизов, — обрезав, он погасил бы
 * листы у ведущего посреди пары. Поэтому мера теперь другая: текущая страница,
 * ОПИСЬ остальных (`ink:pages`) и страница по вопросу (`ink:page`).
 *
 * Здесь проверяется вкладка: что она считает листы по описи, а не по тому, что
 * держит; что спрашивает недостающее ровно один раз и молчит, когда спросить
 * нечего или некому. Что кадры эти умеет собирать сервер — его половина
 * правки, и проверять её здесь нечем: пока он шлёт всё, вкладка обязана вести
 * себя ровно как раньше, и первый тест ниже про это.
 *
 * Браузера здесь нет: это арифметика и договорённости, как в lecture-pult.
 */
import fs from 'node:fs'
import path from 'node:path'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { inkPagesOf, type InkStroke } from '../shared/lecture.js'
import { boardsInked } from '../web/src/components/lecture/pult.js'
import {
  askInkPage,
  forgetInkPages,
  inkedPages,
  noteInkedPages,
  replaceInkPage,
} from '../web/src/components/lecture/ink.js'

/* ------------------------------------------------------------- поддельная вкладка */

type Session = Parameters<typeof askInkPage>[0]

function stroke(page: number, id: string): InkStroke {
  return { id, page, color: '#101a33', width: 0.004, points: [0, 0, 0.1, 0.1] }
}

/** Вкладка ровно в том объёме, в каком её знают чернила: держит, шлёт, связана. */
function tab(ink: InkStroke[], connected = true) {
  const asked: number[] = []
  const state = {
    ink,
    connected,
    send(message: { t: string; page?: number }) {
      if (message.t === 'ink:page' && typeof message.page === 'number') asked.push(message.page)
    },
  }
  forgetInkPages()
  return { session: state as unknown as Session, asked, state }
}

/* ------------------------------------------------------------------- опись */

test('опись — страницы с хотя бы одним штрихом, по возрастанию и без повторов', () => {
  assert.deepEqual(inkPagesOf([]), [])
  assert.deepEqual(
    inkPagesOf([stroke(3, 'a'), stroke(-1, 'b'), stroke(3, 'c'), stroke(1, 'd')]),
    [-1, 1, 3],
  )
})

test('без описи исписано ровно то, что на руках, — и спрашивать нечего', () => {
  // Сервер, который ещё шлёт всё письмо лекции одним кадром: вкладка держит
  // все страницы, ни одного лишнего кадра в провод не уходит.
  const { session, asked } = tab([stroke(-2, 'a'), stroke(5, 'b')])
  assert.deepEqual([...inkedPages(session)].sort((a, b) => a - b), [-2, 5])
  askInkPage(session, -1)
  askInkPage(session, 5)
  assert.deepEqual(asked, [], 'вкладка спросила чернила, которых у неё и так все')
})

test('опись и чернила на руках складываются: ни один из двух источников не полон', () => {
  // Опись — снимок на момент приветственной пачки; штрих на новой странице
  // приезжает эхом и в описи не значится.
  const { session } = tab([stroke(4, 'live')])
  noteInkedPages(session, [-2, 1])
  assert.deepEqual([...inkedPages(session)].sort((a, b) => a - b), [-2, 1, 4])
})

test('листы в ленте считаются по описи, а не по тому, что вкладка держит', () => {
  // Ровно та потеря, ради которой счёт листов и переехал из памяти вкладки в
  // чернила: пульт перезагрузили посреди пары, чернил на руках — одна текущая
  // страница, а листов заведено три.
  const { session } = tab([stroke(7, 'now')])
  noteInkedPages(session, [-3, -1, 7])
  assert.equal(boardsInked(inkedPages(session)), 3)
})

/* ------------------------------------------------------------------ вопрос */

test('страница из описи, которой нет на руках, спрашивается ровно один раз', () => {
  const { session, asked } = tab([stroke(1, 'now')])
  noteInkedPages(session, [-2, 1])
  askInkPage(session, -2)
  askInkPage(session, -2)
  assert.deepEqual(asked, [-2], 'вопрос повторился: перо на соседней странице будит это двадцать раз в секунду')
})

test('пустой ответ — это «страница чистая», и второй раз про неё не спрашивают', () => {
  const { session, asked, state } = tab([stroke(1, 'now')])
  noteInkedPages(session, [-2, 1])
  askInkPage(session, -2)
  // Сервер ответил «на этой странице ничего»: чернил не прибавилось, но и
  // вопрос больше не задаётся — иначе вкладка спрашивала бы до конца лекции.
  state.ink = replaceInkPage(state.ink, -2, [])
  askInkPage(session, -2)
  assert.deepEqual(asked, [-2])
})

test('в офлайне не спрашиваем: очередь управления держит шестнадцать сообщений', () => {
  const { session, asked } = tab([stroke(1, 'now')], false)
  noteInkedPages(session, [-2, 1])
  askInkPage(session, -2)
  assert.deepEqual(asked, [], 'вопрос про чернила вытеснил бы из очереди чужой штрих')
})

test('новая опись забывает заданные вопросы: после переподключения их задают заново', () => {
  const { session, asked } = tab([stroke(1, 'now')])
  noteInkedPages(session, [-2, 1])
  askInkPage(session, -2)
  // Связь оборвалась и вернулась: приветственная пачка привезла свежую опись,
  // а ответы на прошлые вопросы уже не придут.
  noteInkedPages(session, [-2, 1])
  askInkPage(session, -2)
  assert.deepEqual(asked, [-2, -2])
})

/* ------------------------------------------------------------------ замена */

test('кадр страницы заменяет её целиком и не трогает остальные', () => {
  const before = [stroke(1, 'a'), stroke(-2, 'b'), stroke(-2, 'c')]
  const after = replaceInkPage(before, -2, [stroke(-2, 'd')])
  assert.deepEqual(
    after.map((known) => known.id).sort(),
    ['a', 'd'],
    'слияние по именам оставило бы стёртое на странице',
  )
  // Пустой список стирает страницу начисто, соседние — на месте.
  assert.deepEqual(replaceInkPage(after, -2, []).map((known) => known.id), ['a'])
  // Чужая страница не трогается вовсе.
  assert.deepEqual(replaceInkPage(before, 9, []).length, before.length)
})

/* ------------------------------------------------- кто просит на самом деле */

function code(rel: string): string {
  const source = fs.readFileSync(path.resolve(import.meta.dirname, '..', rel), 'utf8')
  // Разметка без комментариев: объяснение — не обещание.
  return source.replace(/<!--[\s\S]*?-->/g, '').replace(/\/\*[\s\S]*?\*\//g, '')
}

test('чернила показываемой страницы просит слой чернил — один на все три экрана', () => {
  // Проекция, зал и лист под пером собраны из одного InkLayer: спрошенное там
  // доедет до всех троих, а спрошенное на пульте — только до пульта.
  const layer = code('web/src/components/lecture/InkLayer.svelte')
  assert.match(layer, /askInkPage\(session, now\)/, 'слой чернил перестал просить свою страницу')
  // И не сразу: страницу, на которую перевели зал, сервер досылает сам, а
  // пятьсот вопросов в ту же секунду — ровно тот круг рассылки, ради которого
  // приветственную пачку и обрезали.
  assert.match(layer, /setTimeout\(\(\) => untrack\(\(\) => askInkPage/)
})

test('пульт считает листы по описи и просит их разметку, когда открыл ленту', () => {
  const pult = code('web/src/components/lecture/ConsoleView.svelte')
  assert.match(
    pult,
    /boardsInked\(inkedPages\(session\)\)/,
    'счёт листов вернулся к чернилам на руках — после перезагрузки их не будет',
  )
  assert.doesNotMatch(pult, /boardsInked\(session\.ink\)/)
  assert.match(pult, /askInkPage\(session, -index\)/, 'лента эскизов перестала просить разметку листов')
})

test('вопрос, ответ и опись стоят в общем словаре — по ним и пишется вторая половина', () => {
  const protocol = code('shared/protocol.ts')
  // Клиент → сервер: вопрос про одну страницу.
  assert.match(protocol, /\{ t: 'ink:page'; page: number \}/)
  // Сервер → клиент: ответ и опись.
  assert.match(protocol, /\{ t: 'ink:page'; page: number; strokes: InkStroke\[\] \}/)
  assert.match(protocol, /\{ t: 'ink:pages'; pages: number\[\] \}/)
})
