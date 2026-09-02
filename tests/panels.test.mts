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
import { Tabs } from '../web/src/lib/tabs.svelte.js'

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

/** Свой набор вкладок на каждый случай: хранилища у узла нет, имя роли не играет. */
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
