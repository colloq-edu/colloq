/**
 * Два свойства вывода ячейки, которые ломались молча.
 *
 * Первое — «первый вывод не ждёт окна склейки». Механизм заведён ровно ради
 * пятидесяти миллисекунд, которые комната смотрит на пустое место после
 * нажатия, и в бою не работал: `runOne` зовёт `writer.clear()` в стартовой
 * транзакции ЕЩЁ ДО execute, а признак «уже писали» поднимался на любой записи,
 * включая стирание. Прежний тест этого не ловил, потому что `clear()` перед
 * первым выводом не делал — то есть проверял путь, которого в продукте нет.
 *
 * Второе — потолок картинок. Он на ячейку, а платит за него комната: вывод
 * уходит каждому открытому сокету, каждому в своей копии и со своим deflate.
 * Шесть мегабайт `imshow` на семинаре из тридцати — сто восемьдесят мегабайт;
 * те же шесть на потоке из пятисот — гигабайт исходящего, за которым у всех
 * встаёт очередь из собственного набора текста.
 */
import './_env.mts'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import * as Y from 'yjs'
import { cellId, createCell, getCells, readCell } from '../shared/notebook.js'
import { dataBudgetFor, OutputWriter } from '../server/src/kernel/outputs.js'

function cellIn(doc: Y.Doc): string {
  const cell = createCell('code', '')
  getCells(doc).push([cell])
  return cellId(cell)
}
const outputsOf = (doc: Y.Doc, id: string) => {
  const found = getCells(doc)
    .toArray()
    .find((c) => cellId(c) === id)
  return readCell(found!).outputs
}
const settle = () => new Promise((r) => setTimeout(r, 80))

test('первый вывод не ждёт окна склейки даже после clear() на старте', async () => {
  const doc = new Y.Doc()
  const id = cellIn(doc)
  const writer = new OutputWriter(doc, id)
  // Ровно то, что делает runOne в стартовой транзакции: гасит прошлый вывод.
  writer.clear()
  writer.stream('stdout', 'первая строка\n')
  assert.equal(outputsOf(doc, id).length, 1, 'первый вывод придержали на окно склейки')

  // А дальше — как было: соседние куски в одном тике едут одной записью.
  writer.stream('stdout', 'вторая\n')
  writer.stream('stdout', 'третья\n')
  await settle()
  const outs = outputsOf(doc, id)
  assert.equal(outs.length, 1)
  assert.ok(outs[0].kind === 'stream')
  assert.match(outs[0].text, /первая строка\nвторая\nтретья/)
  writer.dispose()
})

test('перерисовка прогресс-бара по-прежнему склеивается', async () => {
  // `clear()` признак не сбрасывает: иначе кадр виджета писался бы без склейки
  // двадцать раз в секунду — всей комнате.
  const doc = new Y.Doc()
  const id = cellIn(doc)
  const writer = new OutputWriter(doc, id)
  writer.stream('stdout', 'начало\n')
  await settle()
  writer.clear()
  writer.stream('stdout', 'кадр 1\n')
  writer.stream('stdout', 'кадр 2\n')
  assert.equal(outputsOf(doc, id).length, 0, 'после первой записи склейка должна держать')
  await settle()
  assert.equal(outputsOf(doc, id).length, 1)
  writer.dispose()
})

test('потолок картинок падает вместе с ростом зала, но не в ноль', () => {
  const seminar = dataBudgetFor(30)
  const lecture = dataBudgetFor(500)
  assert.equal(dataBudgetFor(1), seminar, 'обычному семинару потолок не меняли')
  assert.ok(lecture < seminar, 'на пятистах человек бюджет обязан быть меньше')
  assert.ok(lecture >= 512 * 1024, 'одну картинку matplotlib должно пропускать всегда')
  // И монотонно: чем больше зал, тем меньше кадр — без ступенек вверх.
  let previous = seminar
  for (const viewers of [50, 100, 200, 500, 1000]) {
    const now = dataBudgetFor(viewers)
    assert.ok(now <= previous, `бюджет вырос на ${viewers} зрителях`)
    previous = now
  }
})

test('на потоке ячейка упирается в картинки раньше, чем на семинаре', () => {
  const doc = new Y.Doc()
  const id = cellIn(doc)
  const writer = new OutputWriter(doc, id, dataBudgetFor(500))
  // Три «картинки» по мегабайту: на семинаре прошли бы все, здесь — не все.
  for (let i = 0; i < 3; i++) writer.data({ 'image/png': 'x'.repeat(1024 * 1024) }, null)
  writer.dispose()

  const outs = outputsOf(doc, id)
  const images = outs.filter((o) => o.kind === 'data')
  assert.ok(images.length < 3, 'бюджет потока не сработал вовсе')
  const notice = outs.find((o) => o.kind === 'stream' && /images/.test(o.text))
  assert.ok(notice, `про отказ должно быть сказано словами: ${JSON.stringify(outs)}`)
})
