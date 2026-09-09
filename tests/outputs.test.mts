/**
 * Kernel messages becoming cell outputs.
 *
 * This is the narrowest place where a bug is invisible: the cell runs, Python is
 * fine, and the room simply never sees the answer. The coalescing and the caps
 * exist because the document is shared — every write here fans out to everyone —
 * so the properties worth pinning are "nothing is lost" and "one runaway cell
 * cannot make the notebook unloadable for the whole seminar".
 */
import './_env.mts'
import { beforeEach, test } from 'node:test'
import { setLocaleResolver } from '../shared/i18n.js'
// Existing diagnostic expectations intentionally exercise English; bilingual behavior has its own tests.
beforeEach(() => setLocaleResolver(() => 'en'))
import assert from 'node:assert/strict'
import * as Y from 'yjs'
import { cellId, createCell, getCells, readCell } from '../shared/notebook.js'
import { OutputWriter } from '../server/src/kernel/outputs.js'

const FLUSH_MS = 80

function cellIn(doc: Y.Doc): string {
  const cell = createCell('code', '')
  getCells(doc).push([cell])
  return cellId(cell)
}
const settle = () => new Promise((r) => setTimeout(r, FLUSH_MS))
const outputsOf = (doc: Y.Doc, id: string) => {
  const found = getCells(doc)
    .toArray()
    .find((c) => cellId(c) === id)
  return readCell(found!).outputs
}

test('a loop that prints a line at a time arrives as one block, in order', async () => {
  const doc = new Y.Doc()
  const id = cellIn(doc)
  const writer = new OutputWriter(doc, id)
  for (let i = 0; i < 200; i++) writer.stream('stdout', `line ${i}\n`)
  await settle()
  writer.dispose?.()

  const outs = outputsOf(doc, id)
  assert.equal(outs.length, 1, `coalescing produced ${outs.length} outputs`)
  assert.ok(outs[0].kind === 'stream')
  const lines = outs[0].text.trimEnd().split('\n')
  assert.equal(lines.length, 200, 'lines went missing')
  assert.equal(lines[0], 'line 0')
  assert.equal(lines[199], 'line 199')
})

test('stdout and stderr stay apart and stay in order', async () => {
  const doc = new Y.Doc()
  const id = cellIn(doc)
  const writer = new OutputWriter(doc, id)
  writer.stream('stdout', 'before\n')
  writer.stream('stderr', 'warning\n')
  writer.stream('stdout', 'after\n')
  await settle()
  writer.dispose?.()

  const outs = outputsOf(doc, id)
  // A warning in the middle must not be reordered to the end, or the student
  // reads it as being about the wrong line.
  const shape = outs.map((o) => (o.kind === 'stream' ? `${o.name}:${o.text.trim()}` : o.kind))
  assert.deepEqual(shape, ['stdout:before', 'stderr:warning', 'stdout:after'])
})

test('a result is written after the printing that came before it', async () => {
  const doc = new Y.Doc()
  const id = cellIn(doc)
  const writer = new OutputWriter(doc, id)
  writer.stream('stdout', 'computing\n')
  writer.data({ 'text/plain': '42' }, 1)
  await settle()
  writer.dispose?.()

  const outs = outputsOf(doc, id)
  assert.equal(outs[0].kind, 'stream')
  assert.equal(outs[1].kind, 'data')
  assert.ok(outs[1].kind === 'data' && outs[1].data['text/plain'] === '42')
})

test('an error carries the name, the value and the traceback', async () => {
  const doc = new Y.Doc()
  const id = cellIn(doc)
  const writer = new OutputWriter(doc, id)
  writer.error('RuntimeError', 'CUDA out of memory', ['frame one', 'frame two'])
  await settle()
  writer.dispose?.()

  const outs = outputsOf(doc, id)
  assert.equal(outs.length, 1)
  assert.ok(outs[0].kind === 'error')
  assert.equal(outs[0].ename, 'RuntimeError')
  assert.equal(outs[0].evalue, 'CUDA out of memory')
  assert.deepEqual(outs[0].traceback, ['frame one', 'frame two'])
})

test('a thousand-frame traceback is cut down before it reaches the room', async () => {
  const doc = new Y.Doc()
  const id = cellIn(doc)
  const writer = new OutputWriter(doc, id)
  // RecursionError really does produce thousands of identical frames, and every
  // one of them would be sent to every browser in the seminar.
  writer.error('RecursionError', 'maximum recursion depth exceeded', Array.from({ length: 3000 }, (_, i) => `frame ${i}`))
  await settle()
  writer.dispose?.()

  const outs = outputsOf(doc, id)
  assert.ok(outs[0].kind === 'error')
  assert.ok(outs[0].traceback.length < 3000, 'the whole traceback was kept')
  assert.ok(outs[0].traceback.length > 0, 'the traceback was thrown away entirely')
  // The tail is where the actual error is; keeping only the head would be worse
  // than useless.
  assert.match(outs[0].traceback.join('\n'), /frame 2999|truncated|omitted|…/i)
})

test('a runaway cell is capped, and says so instead of going quiet', async () => {
  const doc = new Y.Doc()
  const id = cellIn(doc)
  const writer = new OutputWriter(doc, id)
  const chunk = 'x'.repeat(64 * 1024)
  for (let i = 0; i < 20; i++) writer.stream('stdout', chunk)
  await settle()
  writer.dispose?.()

  const outs = outputsOf(doc, id)
  const total = outs.reduce((n, o) => n + (o.kind === 'stream' ? o.text.length : 0), 0)
  assert.ok(total < 20 * 64 * 1024, 'nothing was capped')
  // Silence would read as a broken cell. There has to be a line saying why.
  const said = outs.map((o) => (o.kind === 'stream' ? o.text : JSON.stringify(o))).join('\n')
  assert.match(said, /truncat|cut|limit|too much|stopped/i)
})

test('большая картинка доходит, и печать после неё не глохнет', async () => {
  /*
   * Раньше картинки считались из того же кошелька, что и текст: один
   * `plt.imshow` при dpi=200 не влезал в 400 КБ целиком, вместо графика в
   * ячейке появлялся совет «write to a file instead of printing», а весь
   * дальнейший вывод этой ячейки глох до конца выполнения. На семинаре по
   * зрению это ровно та ячейка, ради которой всё и запускали.
   */
  const doc = new Y.Doc()
  const id = cellIn(doc)
  const writer = new OutputWriter(doc, id)
  const png = 'i'.repeat(1_200_000)
  writer.data({ 'image/png': png }, 1)
  writer.stream('stdout', 'после картинки\n')
  await settle()
  writer.dispose?.()

  const outs = outputsOf(doc, id)
  const image = outs.find((o) => o.kind === 'data')
  assert.ok(image, `картинку не показали: ${JSON.stringify(outs.map((o) => o.kind))}`)
  const said = outs.map((o) => (o.kind === 'stream' ? o.text : '')).join('\n')
  assert.match(said, /после картинки/, 'печать после картинки пропала')
  assert.doesNotMatch(said, /instead of printing/, 'про картинку сказали не то')
})

test('картинки всё же не безграничны, и отказ говорит про них, а не про print', async () => {
  const doc = new Y.Doc()
  const id = cellIn(doc)
  const writer = new OutputWriter(doc, id)
  // Двадцать кадров по мегабайту — это анимация, а не результат: столько
  // уедет каждому в комнате, в снимок и в историю.
  for (let i = 0; i < 20; i++) writer.data({ 'image/png': 'i'.repeat(1_000_000) }, i + 1)
  await settle()
  writer.dispose?.()

  const outs = outputsOf(doc, id)
  const images = outs.filter((o) => o.kind === 'data').length
  assert.ok(images > 0, 'не показали ни одной картинки')
  assert.ok(images < 20, 'бюджета на картинки нет вовсе')
  const said = outs.map((o) => (o.kind === 'stream' ? o.text : '')).join('\n')
  assert.match(said, /MB image output limit/, 'про предел картинок не сказали')
})

test('прогресс-бар остаётся одной строкой и между окнами склейки', async () => {
  /*
   * tqdm и pip рисуют прогресс возвратом каретки, по кадру в окно склейки.
   * Раньше каждый кадр уезжал в документ отдельной строкой: тысячи кадров за
   * десять минут обучения — это и трафик всей комнате, и потолок вывода
   * ячейки, набранный прогресс-баром, из-за которого обрезался настоящий
   * результат.
   */
  const doc = new Y.Doc()
  const id = cellIn(doc)
  const writer = new OutputWriter(doc, id)
  writer.stream('stdout', 'Training\n')
  for (let i = 0; i <= 100; i += 10) {
    writer.stream('stdout', `\r${i}% [${'#'.repeat(i / 10)}]`)
    await settle()
  }
  writer.stream('stdout', '\ndone\n')
  await settle()
  writer.dispose?.()

  const outs = outputsOf(doc, id)
  assert.ok(outs[0].kind === 'stream')
  const lines = outs[0].text.split('\n')
  assert.deepEqual(
    lines.slice(0, 3),
    ['Training', '100% [##########]', 'done'],
    `в документ уехало ${JSON.stringify(lines)}`,
  )
})

test('CRLF — это перевод строки, а не новый кадр', async () => {
  const doc = new Y.Doc()
  const id = cellIn(doc)
  const writer = new OutputWriter(doc, id)
  // Строку могут прислать двумя кусками, и второй закрывает её по-windows'ски.
  writer.stream('stdout', 'Collecting')
  await settle()
  writer.stream('stdout', ' torch\r\nDone\r\n')
  await settle()
  writer.dispose?.()

  const outs = outputsOf(doc, id)
  assert.ok(outs[0].kind === 'stream')
  assert.equal(outs[0].text, 'Collecting torch\nDone\n')
})

test('огромное сообщение об ошибке обрезается, а не уезжает в документ целиком', async () => {
  /*
   * `assert len(rows) == 0, rows` на списке из миллиона элементов кладёт
   * мегабайты и в `evalue`, и в последнюю строку трейсбека. Запись идёт мимо
   * потолка ячейки (трейсбек — причина запуска), но «мимо потолка» не значит
   * «сколько угодно»: это уходит всем тридцати браузерам, в снимок и в каждый
   * ключевой кадр истории.
   */
  const doc = new Y.Doc()
  const id = cellIn(doc)
  const writer = new OutputWriter(doc, id)
  const huge = 'r'.repeat(7_000_000)
  writer.error('AssertionError', huge, ['Traceback:', `  assert rows == [], ${huge}`])
  await settle()
  writer.dispose?.()

  const outs = outputsOf(doc, id)
  assert.ok(outs[0].kind === 'error')
  const size = JSON.stringify(outs[0]).length
  assert.ok(size < 400 * 1024, `ошибка заняла ${size} символов`)
  // Начало сообщения всё же на месте: по нему и понимают, что упало.
  assert.match(outs[0].evalue, /^rrrr/)
  assert.match(outs[0].evalue + outs[0].traceback.join(''), /more characters cut/)
})

test('writing to a disposed writer is a no-op, not a crash', async () => {
  const doc = new Y.Doc()
  const id = cellIn(doc)
  const writer = new OutputWriter(doc, id)
  writer.stream('stdout', 'before\n')
  await settle()
  writer.dispose?.()
  // A cell interrupted mid-run keeps receiving messages for a moment after.
  assert.doesNotThrow(() => {
    writer.stream('stdout', 'after dispose\n')
    writer.data({ 'text/plain': 'late' }, 2)
    writer.error('LateError', 'late', ['late'])
  })
  await settle()
  const said = outputsOf(doc, id)
    .map((o) => (o.kind === 'stream' ? o.text : JSON.stringify(o)))
    .join('\n')
  assert.ok(!said.includes('after dispose'), 'a disposed writer still wrote')
})

/* ------------------------------- отложенное стирание (clear_output wait=True) */

test('обещание заменить ничего не трогает, пока замены нет', async () => {
  const doc = new Y.Doc()
  const id = cellIn(doc)
  const writer = new OutputWriter(doc, id)
  writer.stream('stdout', 'кадр 1\n')
  await settle()
  assert.equal(outputsOf(doc, id).length, 1)

  // `clear_output(wait=True)` — «сотри, когда будет чем заменить».
  writer.supersede()
  await settle()
  assert.equal(outputsOf(doc, id).length, 1, 'стёрли раньше времени')

  writer.stream('stdout', 'кадр 2\n')
  await settle()
  const outs = outputsOf(doc, id)
  assert.equal(outs.length, 1)
  assert.match(JSON.stringify(outs), /кадр 2/)
  assert.doesNotMatch(JSON.stringify(outs), /кадр 1/)
})

test('новый кадр не подклеивается в хвост старого', async () => {
  /*
   * Стереть после mutate, а не до, значит дать append() слить оба кадра в один
   * Y.Text: получилась бы строка «кадр 1\nкадр 2» без границы — и она поехала
   * бы и в снимок, и в экспорт. Не устаревший кадр, а порча.
   */
  const doc = new Y.Doc()
  const id = cellIn(doc)
  const writer = new OutputWriter(doc, id)
  writer.stream('stdout', 'кадр 1\n')
  await settle()
  writer.supersede()
  writer.stream('stdout', 'кадр 2\n')
  await settle()

  const outs = outputsOf(doc, id)
  assert.equal(outs.length, 1, `записей ${outs.length}, а должна быть одна`)
  assert.equal(outs[0].kind, 'stream')
  assert.equal(outs[0].text, 'кадр 2\n')
})

test('обещание, за которым ничего не пришло, выполняется в конце', async () => {
  // Иначе стёртый кадр виджета не вернулся бы никогда: на экране осталась бы
  // картинка, которую ядро уже отменило.
  const doc = new Y.Doc()
  const id = cellIn(doc)
  const writer = new OutputWriter(doc, id)
  writer.stream('stdout', 'кадр 1\n')
  await settle()
  writer.supersede()
  writer.dispose()
  assert.equal(outputsOf(doc, id).length, 0, 'отменённый кадр остался на экране')
})

test('немедленное стирание снимает отложенное', async () => {
  const doc = new Y.Doc()
  const id = cellIn(doc)
  const writer = new OutputWriter(doc, id)
  writer.stream('stdout', 'кадр 1\n')
  await settle()
  writer.supersede()
  writer.clear()
  writer.stream('stdout', 'a')
  await settle()

  const outs = outputsOf(doc, id)
  assert.equal(outs.length, 1)
  assert.equal(outs[0].kind, 'stream')
  assert.equal(outs[0].text, 'a', 'отложенное стирание съело то, что уже написали')
})

test('упёршаяся в потолок ячейка всё же принимает замену', async () => {
  /*
   * Раньше `stream` отказывал каждому куску после переполнения — включая тот,
   * который должен был выполнить отложенное стирание и сбросить бюджет. Ячейка
   * держала прошлый вывод до конца выполнения, и в коротком тесте этого не
   * видно вовсе.
   */
  const doc = new Y.Doc()
  const id = cellIn(doc)
  const writer = new OutputWriter(doc, id)
  writer.stream('stdout', 'x'.repeat(600_000))
  await settle()
  assert.ok(outputsOf(doc, id).length > 0)

  writer.supersede()
  writer.stream('stdout', 'после переполнения\n')
  await settle()

  const outs = outputsOf(doc, id)
  assert.equal(outs.length, 1, `записей ${outs.length}`)
  assert.equal(outs[0].kind, 'stream')
  assert.equal(outs[0].text, 'после переполнения\n')
})

test('первый вывод не ждёт окна склейки', async () => {
  // Окно существует, чтобы двести записей не стали двумястами обновлениями. На
  // первом байте оно не экономит ничего и стоит тех миллисекунд, которые
  // комната смотрит на пустое место.
  const doc = new Y.Doc()
  const id = cellIn(doc)
  const writer = new OutputWriter(doc, id)
  // Как в бою: runOne гасит прошлый вывод в стартовой транзакции, ещё до
  // execute. Без этой строки тест проверял путь, которого в продукте нет.
  writer.clear()
  writer.stream('stdout', 'первая строка\n')
  assert.equal(outputsOf(doc, id).length, 1, 'первый вывод придержали')

  // А дальше — как было: два куска в одном тике склеиваются.
  writer.stream('stdout', 'вторая\n')
  writer.stream('stdout', 'третья\n')
  await settle()
  const outs = outputsOf(doc, id)
  assert.equal(outs.length, 1)
  assert.equal(outs[0].kind, 'stream')
  assert.match(outs[0].text, /первая строка\nвторая\nтретья/)
})
