/**
 * Две модели центра экрана: предохранитель от перезагрузок и ряд вкладок.
 *
 * Предохранитель от вечной перезагрузки после отказа в правке.
 *
 * Отказ (4403) лечится перезагрузкой вместе с очисткой кэша. Если очистка не
 * удалась — приватное окно, запрет на хранилище — или если отказанную структуру
 * возвращает соседняя вкладка по BroadcastChannel, круг замыкается: заход,
 * отказ, перезагрузка, снова отказ. Серия обрывается на второй попытке, и
 * проверяется здесь именно ПОРЯДОК, из-за которого она раньше не обрывалась:
 * соединение объявляет себя живым РАНЬШЕ, чем приходит отказ, — сервер отвечает
 * на наш SyncStep1 до того, как разберёт наш SyncStep2.
 */
import { test, mock } from 'node:test'
import assert from 'node:assert/strict'
import { mayReload, refusalHealed } from '../web/src/lib/refusal.js'
import { restore, Tabs, type Room } from '../web/src/lib/tabs.svelte.js'

/*
 * У узла нет sessionStorage — а счёт попыток живёт в нём. Подделка ровно того
 * размера, который читает модуль.
 */
const store = new Map<string, string>()
;(globalThis as { sessionStorage?: unknown }).sessionStorage = {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => void store.set(k, v),
  removeItem: (k: string) => void store.delete(k),
}

test('соединение, ожившее за мгновение до отказа, не обнуляет серию', () => {
  store.clear()
  mock.timers.enable({ apis: ['Date'], now: 0 })
  try {
    // Три захода круга подряд: sync, через полсекунды отказ, перезагрузка.
    refusalHealed()
    mock.timers.tick(400)
    assert.equal(mayReload(), true)

    refusalHealed()
    mock.timers.tick(400)
    assert.equal(mayReload(), true)

    refusalHealed()
    mock.timers.tick(400)
    assert.equal(mayReload(), false, 'третья перезагрузка подряд — это круг')
  } finally {
    mock.timers.reset()
  }
})

test('соединение, прожившее полминуты, начинает счёт заново', () => {
  store.clear()
  mock.timers.enable({ apis: ['Date'], now: 0 })
  try {
    refusalHealed()
    assert.equal(mayReload(), true)
    refusalHealed()
    assert.equal(mayReload(), true)
    refusalHealed()
    assert.equal(mayReload(), false)

    // Комната работала полминуты — значит отказ, случившийся сейчас, не имеет
    // отношения к тому, что было до перезагрузки, и он снова первый.
    refusalHealed()
    mock.timers.tick(30_000)
    assert.equal(mayReload(), true)
  } finally {
    mock.timers.reset()
  }
})

/* --------------------------------------------------------------- вкладки */

/*
 * Ряд вкладок — обычный класс, но живёт в `.svelte.ts` и держит своё состояние
 * рунами. Компилятора здесь нет, и `$state` остаётся обычным вызовом: подделка
 * возвращает значение как есть. Она ставится до первого `new Tabs`, а не до
 * импорта, и этого хватает: руна зовётся при создании, а не при загрузке
 * модуля. Реактивность здесь не проверяется — проверяется арифметика ряда, из-за
 * которой закрытая вкладка уводила не туда.
 */
;(globalThis as { $state?: unknown }).$state = <T,>(value: T): T => value

/*
 * Хранилища вкладок у узла тоже нет, а без него половина модели не проверяется:
 * ряд помнит и сами вкладки, и открытую из них, и именно этой памяти стоила
 * пустая комната после F5.
 */
const tabStore = new Map<string, string>()
;(globalThis as { localStorage?: unknown }).localStorage = {
  getItem: (k: string) => tabStore.get(k) ?? null,
  setItem: (k: string, v: string) => void tabStore.set(k, v),
  removeItem: (k: string) => void tabStore.delete(k),
}

/** Свой набор вкладок на каждый случай: ключ у каждого свой, имя роли не играет. */
function opened(...paths: string[]) {
  const tabs = new Tabs('t' + Math.random())
  for (const path of paths) tabs.open(path)
  return tabs
}

test('закрыв третий файл из четырёх, попадаешь во второй, а не в первый', () => {
  const tabs = opened('a.py', 'b.py', 'c.py')
  const board = 'Тетрадь.ipynb'
  assert.deepEqual(tabs.row(board), [board, 'a.py', 'b.py', 'c.py'])

  assert.equal(tabs.close('c.py', board), false)
  // Человек занимается файлами: выкидывать его в тетрадь — лишний путь обратно.
  assert.equal(tabs.active, 'b.py')
})

test('закрытая не своя вкладка не уводит с текущей', () => {
  const tabs = opened('a.py', 'b.py')
  tabs.show('a.py')
  tabs.close('b.py', null)
  assert.equal(tabs.active, 'a.py')
})

test('сосед считается по тому же ряду, что нарисован: лекция в нём есть', () => {
  const tabs = opened('a.py', 'b.py')
  const lecture = 'лекция.pdf'
  tabs.show('a.py')
  // Без лекции слева от a.py ничего нет, и уйти пришлось бы вправо, в b.py.
  tabs.close('a.py', null, lecture)
  assert.equal(tabs.active, lecture)
})

test('общий документ у себя не закрывается — от него только уходят', () => {
  const tabs = opened('a.py')
  const board = 'разбор.py'
  tabs.show(board)
  assert.equal(tabs.close(board, board), true, 'вкладка остаётся в ряду')
  assert.equal(tabs.active, null)
  assert.deepEqual(tabs.row(board), [board, 'a.py'])
})

/* --------------------------------------------- возвращение в комнату */

/*
 * Куда человек попадает, перезагрузив страницу посреди пары.
 *
 * Жалоба с живой пары была ровно про это: тетрадь открыта, F5 — и пустая
 * комната, а тетрадь ищи заново в панели файлов, всей группой и одновременно.
 * Решение целиком в чистой функции, потому что ломается оно молча и тремя
 * разными способами: памятью, которой нет; файлом, которого больше нет; и залом,
 * который смотрит лекцию.
 */

const BOOK = 'Тетрадь.ipynb'

function room(alive: string[], board: string | null = null, firstBook: string | null = BOOK): Room {
  return { alive: new Set(alive), firstBook, board }
}

test('перезагрузка возвращает туда же, где человек был', () => {
  assert.deepEqual(
    restore({ open: [BOOK, 'разбор.py'], active: 'разбор.py' }, room([BOOK, 'разбор.py'])),
    { open: [BOOK, 'разбор.py'], active: 'разбор.py' },
  )
})

test('открытого файла больше нет — уходим на соседнюю вкладку, а не в пустой центр', () => {
  // Файл убрали, пока человека не было: воскрешать его вкладкой нечем и незачем.
  assert.deepEqual(restore({ open: [BOOK, 'разбор.py'], active: 'разбор.py' }, room([BOOK])), {
    open: [BOOK],
    active: BOOK,
  })
})

test('зал смотрит лекцию — это сильнее сохранённого выбора', () => {
  /*
   * Опоздавший приходит туда же, куда смотрит комната. Своя тетрадь при этом
   * остаётся вкладкой: экран у комнаты не отбирают, но и память не выбрасывают.
   */
  assert.deepEqual(
    restore({ open: [BOOK], active: BOOK }, room([BOOK, 'слайды.pdf'], 'слайды.pdf')),
    { open: [BOOK], active: 'слайды.pdf' },
  )
})

test('первый заход открывает тетрадь комнаты — и не отнимает у неё экран', () => {
  assert.deepEqual(restore(null, room([BOOK, 'разбор.py'])), { open: [BOOK], active: BOOK })
  assert.deepEqual(restore(null, room([BOOK, 'слайды.pdf'], 'слайды.pdf')), {
    open: [BOOK],
    active: 'слайды.pdf',
  })
})

test('закрыл всё — заход не открывает тетрадь заново', () => {
  // Пустой список в хранилище — это решение человека, а не отсутствие памяти.
  assert.deepEqual(restore({ open: [], active: null }, room([BOOK])), { open: [], active: null })
})

test('вкладки и открытая из них переживают перезагрузку', () => {
  tabStore.clear()
  const first = new Tabs('kf3n8q2p')
  first.settle(room([BOOK]))
  first.open('разбор.py')
  first.show(BOOK)

  const again = new Tabs('kf3n8q2p')
  assert.deepEqual(again.mine, [BOOK, 'разбор.py'], 'ряд рисуется до ответа сервера')
  assert.equal(again.active, BOOK, 'центр экрана — тетрадь, а не водяной знак')
})

test('память своя у каждой комнаты', () => {
  tabStore.clear()
  new Tabs('room-a').open('разбор.py')
  assert.deepEqual(new Tabs('room-b').mine, [], 'вкладки соседнего семинара сюда не приезжают')
  assert.deepEqual(new Tabs('room-a').mine, ['разбор.py'])
})

test('первый заход ничего не решает, пока тетрадь комнаты не приехала', () => {
  /*
   * Список файлов идёт с управляющего сокета, тетради — из документа, и в
   * свежей комнате файлы приходят первыми. Записать в этот промежуток «человек
   * всё закрыл» значило бы отменить решение, которого он не принимал, — навсегда,
   * потому что «впервые» бывает один раз.
   */
  tabStore.clear()
  const tabs = new Tabs('fresh')
  tabs.settle(room([], null, null))
  assert.deepEqual(tabs.mine, [])
  assert.equal(tabs.active, null)

  tabs.settle(room([BOOK]))
  assert.deepEqual(tabs.mine, [BOOK])
  assert.equal(tabs.active, BOOK)
})

test('пропавший файл уносит свою вкладку и на следующем списке — уже после возвращения', () => {
  tabStore.clear()
  const tabs = new Tabs('weed')
  tabs.settle(room([BOOK, 'разбор.py']))
  tabs.open('разбор.py')
  tabs.settle(room([BOOK]))
  assert.deepEqual(tabs.mine, [BOOK])
  assert.notEqual(tabs.active, 'разбор.py', 'вкладка на файл, которого нет, не остаётся открытой')
})

test('запись прошлой версии читается, а мусор — это «ничего не помним»', () => {
  tabStore.clear()
  // Раньше помнили один список путей; такие записи уже лежат в браузерах.
  tabStore.set('colloq.tabs.old', JSON.stringify([BOOK, 'разбор.py']))
  const old = new Tabs('old')
  assert.deepEqual(old.mine, [BOOK, 'разбор.py'])
  old.settle(room([BOOK, 'разбор.py']))
  assert.equal(old.active, BOOK, 'какая была открыта — неизвестно, открывается самая левая')

  /*
   * Битое значение — не «человек всё закрыл»: второму оставляют пустой центр, а
   * этого надо вернуть в тетрадь, а не высадить в ту самую пустую комнату.
   */
  tabStore.set('colloq.tabs.junk', '{not json')
  const junk = new Tabs('junk')
  assert.deepEqual(junk.mine, [])
  junk.settle(room([BOOK]))
  assert.equal(junk.active, BOOK)
})
