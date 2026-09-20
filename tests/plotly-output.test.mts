/**
 * Интерактивный график: что именно доезжает от ядра до комнаты.
 *
 * Отказ здесь выглядит не как поломка, а как пустое место: ячейка с
 * `px.histogram(...)` отчитывается «выполнена», а под ней НИЧЕГО. Так оно и
 * было до этой работы, и причина ровно одна — набор от ipykernel с нынешним
 * plotly состоит из ОДНОГО ключа `application/vnd.plotly.v1+json`: ни
 * `text/plain`, ни картинки в нём нет, и выбору представления было не за что
 * зацепиться.
 *
 * Поэтому проверяется не «видно ли график» (это работа браузера и рамки), а
 * что лежит в документе: строка JSON — а у крупной фигуры ссылка вместо неё, —
 * и что мёртвая разметка plotly туда не попадает ни при каких условиях.
 */
import './_env.mts'
import { beforeEach, test } from 'node:test'
import { setLocaleResolver } from '../shared/i18n.js'
beforeEach(() => setLocaleResolver(() => 'ru'))
import assert from 'node:assert/strict'
import * as Y from 'yjs'
import {
  cellId,
  cellOutputs,
  createCell,
  getCells,
  readCell,
  writeOutput,
  type CellOutput,
  type YCell,
} from '../shared/notebook.js'
import { renderOutputs } from '../server/src/ai/context.js'
import { renderStep } from '../server/src/publish/render.js'
import { OutputWriter } from '../server/src/kernel/outputs.js'
import { CouncilOutputBuffer, MAX_ATTEMPT_DATA_CHARS } from '../server/src/kernel/council.js'
import { MAX_FIGURE_CHARS, withoutDeadPlotlyHtml } from '../server/src/kernel/figures.js'
import { PLOTLY_MIME, figureShape, normalizeFigure } from '../shared/plotly.js'
import { SPILL_MIMES, spillContentType, spillEncoding } from '../shared/publish.js'
import { createSession } from '../server/src/db.js'
import { readBlob, sniffMime } from '../server/src/blobs.js'

const FLUSH_MS = 80
const settle = () => new Promise((r) => setTimeout(r, FLUSH_MS))

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

/** Фигура нужного веса: точки настоящие, чтобы разбор её признал. */
function figure(points: number, kind = 'scatter'): string {
  const x = Array.from({ length: points }, (_, i) => i)
  return JSON.stringify({
    data: [{ type: kind, x, y: x }],
    layout: { title: { text: 'проба' }, height: 420 },
  })
}

/* ------------------------------------------------------- набор от ядра */

test('фигура доезжает строкой JSON и лежит в документе как есть', async () => {
  const doc = new Y.Doc()
  const id = cellIn(doc)
  const writer = new OutputWriter(doc, id)
  const body = figure(20)
  writer.data({ [PLOTLY_MIME]: body }, 1)
  writer.dispose()
  await settle()

  const [output] = outputsOf(doc, id)
  assert.equal(output.kind, 'data')
  if (output.kind !== 'data') return
  assert.equal(output.data[PLOTLY_MIME], body, 'строка фигуры изменилась по дороге')
  // Именно строкой: JSON.parse от неё обязан дать ту же фигуру.
  const parsed = normalizeFigure(JSON.parse(output.data[PLOTLY_MIME]))
  assert.ok(parsed, 'из документа не читается фигура')
  assert.equal(parsed.data.length, 1)
})

test('мёртвая разметка plotly в документ не кладётся', async () => {
  const doc = new Y.Doc()
  const id = cellIn(doc)
  const writer = new OutputWriter(doc, id)
  // Рендерер `plotly_mimetype+notebook` шлёт оба: фигуру и сотни килобайт
  // скрипта, который мы всё равно не исполняем.
  const html = `<div id="x" class="plotly-graph-div"></div><script>${'/*'.repeat(5000)}</script>`
  writer.data({ [PLOTLY_MIME]: figure(5), 'text/html': html }, 1)
  writer.dispose()
  await settle()

  const [output] = outputsOf(doc, id)
  assert.equal(output.kind, 'data')
  if (output.kind !== 'data') return
  assert.ok(output.data[PLOTLY_MIME], 'фигуру потеряли вместе с разметкой')
  assert.equal(output.data['text/html'], undefined, 'мёртвый скриптовый HTML попал в документ')
})

test('бутстрап рендерера notebook — пять мегабайт скрипта — не попадает никуда', () => {
  // Отдельный кадр: в нём ОДИН ключ, фигуры рядом нет, и узнаётся он только
  // по подписи самого plotly. Без этого он ложился бы в документ целиком и
  // съедал весь бюджет вывода ячейки, ради которой всё затевалось.
  const bootstrap = `<script>window.PlotlyConfig = {MathJaxConfig: 'local'};${'x'.repeat(200 * 1024)}</script>`
  const kept = withoutDeadPlotlyHtml({ 'text/html': bootstrap })
  assert.deepEqual(kept, {}, 'бутстрап plotly остался в наборе')

  // А обычная разметка — таблица pandas — не трогается ничем.
  const table = '<table><tr><td>1</td></tr></table>'
  assert.deepEqual(withoutDeadPlotlyHtml({ 'text/html': table }), { 'text/html': table })
})

/* ------------------------------------------------------------- вынос */

test('крупная фигура уезжает на полку, в документе остаётся ссылка', async () => {
  const room = 'plotlyblob1'
  createSession(room, 'График')
  const doc = new Y.Doc()
  const id = cellIn(doc)
  const body = figure(20_000)
  assert.ok(body.length > 100 * 1024, 'проба слишком лёгкая, вынос не сработает')

  const writer = new OutputWriter(doc, id, undefined, room)
  writer.data({ [PLOTLY_MIME]: body }, 1)
  writer.dispose()
  await settle()

  const [output] = outputsOf(doc, id)
  assert.equal(output.kind, 'data')
  if (output.kind !== 'data') return
  assert.equal(output.data[PLOTLY_MIME], undefined, 'мегабайты фигуры остались в документе')
  const blob = (output.blobs ?? []).find((b) => b.mime === PLOTLY_MIME)
  assert.ok(blob, 'ссылки на вынесенную фигуру нет')
  // Байты на полке — тот же JSON, слово в слово: фигура хранится ТЕКСТОМ, а
  // не base64, и разобрать её как base64 значило бы положить туда мусор.
  const stored = readBlob(room, blob.sha)
  assert.ok(stored)
  assert.equal(stored.toString('utf8'), body)
  // И отдаётся она не тем, что сказало ядро, а безобидным application/json.
  assert.equal(sniffMime(stored), 'application/json')
  assert.equal(spillContentType(PLOTLY_MIME), 'application/json')
})

test('маленькая фигура на полку не уезжает: за ней был бы второй запрос', async () => {
  const room = 'plotlyblob2'
  createSession(room, 'График')
  const doc = new Y.Doc()
  const id = cellIn(doc)
  const body = figure(20)
  assert.ok(body.length < 16 * 1024)

  const writer = new OutputWriter(doc, id, undefined, room)
  writer.data({ [PLOTLY_MIME]: body }, 1)
  writer.dispose()
  await settle()

  const [output] = outputsOf(doc, id)
  if (output.kind !== 'data') return assert.fail('не запись данных')
  assert.equal(output.data[PLOTLY_MIME], body)
  assert.equal(output.blobs, undefined)
})

test('вынос и кодировка перечислены одним набором на продукт', () => {
  assert.ok(SPILL_MIMES.has(PLOTLY_MIME))
  assert.ok(SPILL_MIMES.has('image/png'))
  // Картинка приходит base64, фигура — текстом. Перепутать их значит положить
  // на полку мусор и показать пустую рамку.
  assert.equal(spillEncoding('image/png'), 'base64')
  assert.equal(spillEncoding(PLOTLY_MIME), 'utf8')
  // SVG не выносится: он и так легче картинки, ради которой вынос заведён.
  assert.ok(!SPILL_MIMES.has('image/svg+xml'))
})

/* ------------------------------------------------------------- потолок */

test('фигура сверх потолка — честная строка, а не обрезанный JSON', async () => {
  const room = 'plotlyhuge1'
  createSession(room, 'Много точек')
  const doc = new Y.Doc()
  const id = cellIn(doc)
  // Не строим настоящий миллион точек: потолок считает знаки, и строка из них
  // ровно такая же длинная, а тест — на секунду, а не на минуту.
  const body = JSON.stringify({
    data: [{ type: 'scattergl', x: [1, 2], y: [1, 2], text: 'z'.repeat(MAX_FIGURE_CHARS) }],
    layout: {},
  })

  const writer = new OutputWriter(doc, id, undefined, room)
  writer.data({ [PLOTLY_MIME]: body }, 1)
  writer.dispose()
  await settle()

  const outs = outputsOf(doc, id)
  assert.equal(outs.length, 1, 'кроме строки в документ легло что-то ещё')
  assert.equal(outs[0].kind, 'stream')
  if (outs[0].kind !== 'stream') return
  assert.equal(outs[0].name, 'stderr')
  assert.match(outs[0].text, /слишком большой/)
  // Совет в строке — настоящий выход, а не отговорка.
  assert.match(outs[0].text, /write_html/)
})

test('потолок фигуры не отменяет остального набора', async () => {
  const room = 'plotlyhuge2'
  createSession(room, 'Много точек')
  const doc = new Y.Doc()
  const id = cellIn(doc)
  const body = JSON.stringify({ data: [{ x: 'z'.repeat(MAX_FIGURE_CHARS) }], layout: {} })

  const writer = new OutputWriter(doc, id, undefined, room)
  writer.data({ [PLOTLY_MIME]: body, 'text/plain': 'Figure({...})' }, 1)
  writer.dispose()
  await settle()

  const outs = outputsOf(doc, id)
  assert.equal(outs.length, 2)
  assert.equal(outs[0].kind, 'stream')
  assert.equal(outs[1].kind, 'data')
  if (outs[1].kind !== 'data') return
  assert.equal(outs[1].data['text/plain'], 'Figure({...})')
  assert.equal(outs[1].data[PLOTLY_MIME], undefined)
})

/* ---------------------------------------------------------- консилиум */

test('попытка консилиума: фигура до потолка целиком, сверх — та же строка', () => {
  const small = new CouncilOutputBuffer()
  const body = figure(50)
  small.data({ [PLOTLY_MIME]: body, 'text/html': '<div></div><script>x</script>' }, 1)
  const kept = small.snapshot()
  assert.equal(kept.length, 1)
  assert.equal(kept[0].kind, 'data')
  if (kept[0].kind !== 'data') return
  assert.equal(kept[0].data[PLOTLY_MIME], body, 'фигуру попытки порезали')
  assert.equal(kept[0].data['text/html'], undefined, 'мёртвый скрипт уехал на карточку')

  // Полки записей у попытки нет и быть не может: её вывод живёт в памяти и
  // едет хосту сокетом. Значит — либо целиком, либо строкой.
  const big = new CouncilOutputBuffer()
  const huge = JSON.stringify({
    data: [{ x: 'z'.repeat(MAX_ATTEMPT_DATA_CHARS) }],
    layout: {},
  })
  big.data({ [PLOTLY_MIME]: huge }, 1)
  const outs = big.snapshot()
  assert.equal(outs.length, 1)
  assert.equal(outs[0].kind, 'stream')
  if (outs[0].kind !== 'stream') return
  assert.match(outs[0].text, /слишком большой|too large/)
})

/* ----------------------------------------------------------- пересказ */

test('пересказ фигуры: тип, число трасс и число точек', () => {
  const one = normalizeFigure(JSON.parse(figure(37, 'histogram')))
  assert.ok(one)
  assert.deepEqual(figureShape(one), { kind: 'histogram', traces: 1, points: 37 })

  // plotly.py с шестой версии кладёт массивы двоичными: `{dtype, bdata}`.
  // Длину у них `.length` не спросишь, а оракулу число точек нужно.
  const packed = normalizeFigure({
    data: [{ type: 'scattergl', x: { dtype: 'f8', bdata: 'A'.repeat(800) } }],
    layout: {},
  })
  assert.ok(packed)
  assert.equal(figureShape(packed).points, 75, '800 знаков base64 — это 600 байт, то есть 75 чисел f8')
})

/* ------------------------------------------------------------- оракул */

/** Ячейка внутри документа: без него у неё нет массива выводов. */
function cellWith(output: CellOutput): YCell {
  const doc = new Y.Doc()
  const cell = createCell('code', 'px.histogram(df, x="t")')
  getCells(doc).push([cell])
  cellOutputs(cell).push([writeOutput(output)])
  return cell
}

test('оракулу едет пометка о графике, а не мегабайты координат', () => {
  const cell = cellWith(
    { kind: 'data', data: { [PLOTLY_MIME]: figure(2400, 'histogram') }, execCount: 7 },
  )
  const [rendered] = renderOutputs(cell, 4000)
  assert.match(rendered, /\[plotly figure: histogram, 1 trace, 2400 points\]/)
  // И ни одной координаты: сто тысяч точек — это два мегабайта, то есть весь
  // бюджет контекста за одну ячейку.
  assert.ok(!rendered.includes('"x"'), 'JSON фигуры уехал модели целиком')
  assert.ok(rendered.length < 200, `пометка на ${rendered.length} знаков — это не пометка`)
})

test('вынесенная фигура в контексте — график, а не картинка', () => {
  const cell = cellWith({
    kind: 'data',
    data: {},
    blobs: [{ sha: 'a'.repeat(64), mime: PLOTLY_MIME, bytes: 1_600_000 }],
    execCount: 9,
  })
  const [rendered] = renderOutputs(cell, 4000)
  // Не «KB image»: оракул подсказывал бы про `plt.savefig` там, где plotly.
  assert.match(rendered, /\[plotly figure, ~1563 KB\]/)
})

/* -------------------------------------------------- опубликованная страница */

test('в выгруженном каталоге на месте графика — строка, а не пустота и не JSON', () => {
  const html = renderStep({
    title: 'Занятие',
    publishedAt: 0,
    course: null,
    steps: [{ seq: 1, label: 'Шаг', at: 0, cellCount: 1 }],
    step: {
      seq: 1,
      label: 'Шаг',
      at: 0,
      cells: [
        {
          id: 'c1',
          type: 'code',
          source: 'px.line(df, x="d", y="n")',
          outputs: [{ kind: 'data', data: { [PLOTLY_MIME]: figure(10) }, execCount: 1 }],
          execCount: 1,
          ranMs: 12,
        },
      ],
    },
    depth: 1,
    base: '',
  })
  /*
   * Статический каталог живёт без сервера, а рамка — это ответ с особым
   * заголовком. Рисовать фигуру прямо в странице нельзя тем более: чужие
   * данные и чужой код на origin, где лежат и другие занятия.
   */
  assert.match(html, /интерактивный график plotly/)
  assert.ok(!html.includes('"scatter"'), 'JSON фигуры уехал в статическую страницу')
  assert.ok(!html.includes('<iframe'), 'рамка на статической странице не работает и не ставится')
})
