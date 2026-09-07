/**
 * Записка об отказе: что человек прочитает после того, как вкладку пересобрали.
 *
 * Гейт отказывает КАДРУ ЦЕЛИКОМ, а кадр после обрыва связи — это всё, что
 * человек набрал без сети: печатать офлайн продукт разрешает намеренно. Дальше
 * вкладка стирает свой кэш и перезагружается, и всё, что не доехало до сервера,
 * исчезает — навсегда и без единого слова, если о нём не рассказать здесь.
 *
 * Пока в записку клалась ОДНА ячейка (та, где стоял курсор), правки в остальных
 * уходили молча. Проверяется поэтому не текст на экране, а решение: что попало
 * в снимок, что из него правда потеряно, и в каком случае про это вообще
 * показывают окно.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

/*
 * У узла нет sessionStorage — а записка живёт в нём. Подделка ровно того
 * размера, который читает модуль, плюс квота: без неё не проверить, что снимок,
 * который не влез, не уносит с собой и ту записку, что помещалась раньше.
 */
const store = new Map<string, string>()
let quota = Number.POSITIVE_INFINITY
;(globalThis as { sessionStorage?: unknown }).sessionStorage = {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => {
    if (v.length > quota) throw new Error('QuotaExceededError')
    store.set(k, v)
  },
  removeItem: (k: string) => void store.delete(k),
}

const { stashRefusal, takeRefusal, stillLost, refusalHasText } = await import(
  '../web/src/lib/refusal.js'
)

function note(over: Partial<Parameters<typeof stashRefusal>[0]> = {}) {
  return {
    sessionId: 'room1',
    kind: 'edit' as const,
    message: 'Эту правку не приняли.',
    text: 'печатал тут',
    cells: [
      { id: 'c03', text: 'df = read()' },
      { id: 'c07', text: 'print(df.head())' },
      { id: 'c12', text: 'plot(df)' },
    ],
    at: Date.now(),
    ...over,
  }
}

test('в записку кладётся весь набранный текст, а не одна ячейка под курсором', () => {
  store.clear()
  quota = Number.POSITIVE_INFINITY
  stashRefusal(note())
  const back = takeRefusal('room1')
  assert.ok(back)
  assert.equal(back.cells?.length, 3)
  assert.deepEqual(
    back.cells?.map((cell) => cell.id),
    ['c03', 'c07', 'c12'],
  )
})

test('после перезагрузки показывают только то, чего у сервера НЕ оказалось', () => {
  // Вкладка собралась заново из серверной копии: две ячейки там такие же, одну
  // сервер не принял, а ещё одну успели удалить.
  const server = new Map([
    ['c03', 'df = read()'],
    ['c07', 'print(df.head())'],
  ])
  const lost = stillLost(note(), (id) => server.get(id) ?? null)
  assert.deepEqual(
    lost.map((cell) => cell.id),
    ['c12'],
  )
})

test('расхождение в тексте — это тоже потеря, а не совпадение по имени', () => {
  const server = new Map([['c03', 'df = read()  # старая строка сервера']])
  const lost = stillLost(
    note({ cells: [{ id: 'c03', text: 'df = read()' }] }),
    (id) => server.get(id) ?? null,
  )
  assert.equal(lost.length, 1)
})

test('пустые ячейки в потери не идут: терять там нечего', () => {
  const lost = stillLost(
    note({
      cells: [
        { id: 'c01', text: '   \n' },
        { id: 'c02', text: '' },
      ],
    }),
    () => null,
  )
  assert.deepEqual(lost, [])
})

test('окно показывают и тогда, когда курсор стоял вне ячеек', () => {
  // Ровно тот случай, из-за которого офлайн-правки исчезали тихо: `text` пуст,
  // потому что якоря не было, а работа лежит в трёх других ячейках.
  assert.equal(refusalHasText(note({ text: '' })), true)
  assert.equal(refusalHasText(note({ text: '', cells: [] })), false)
  assert.equal(refusalHasText(note({ text: 'что-то', cells: [] })), true)
})

test('снимок, не влезший в хранилище, не уносит с собой саму записку', () => {
  store.clear()
  // Ровно столько, чтобы записка без снимка помещалась, а со снимком — нет.
  const small = JSON.stringify({ ...note(), cells: undefined })
  quota = small.length + 20
  stashRefusal(note())
  const back = takeRefusal('room1')
  assert.ok(back, 'записки не стало вовсе — человек остался без единого слова')
  assert.equal(back.message, 'Эту правку не приняли.')
  assert.deepEqual(back.cells, [], 'снимка нет — и это честнее, чем половина снимка')
  quota = Number.POSITIVE_INFINITY
})

test('записка прошлой сборки читается: снимка в ней нет, и это не мусор', () => {
  store.clear()
  quota = Number.POSITIVE_INFINITY
  store.set(
    'colloq.refused',
    JSON.stringify({
      sessionId: 'room1',
      kind: 'stale',
      message: 'Кэш этой вкладки разошёлся с сервером — она собрана заново.',
      text: '',
      at: Date.now(),
    }),
  )
  const back = takeRefusal('room1')
  assert.ok(back)
  assert.deepEqual(back.cells, [])
  assert.equal(refusalHasText(back), false)
  assert.deepEqual(
    stillLost(back, () => null),
    [],
  )
})
