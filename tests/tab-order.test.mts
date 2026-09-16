/**
 * Порядок вкладок: что делает перетаскивание.
 *
 * Решение отдельно от мыши — тот же приём, что у перетаскивания в дереве
 * файлов (web/src/lib/tree-move.ts): проверять стоит одно — КУДА встала
 * вкладка, — и для этого не нужен ни браузер, ни событие.
 *
 * Правило, ради которого всё это и написано: вставка со СТОРОНЫ, с которой
 * тянут. Тянут влево — вкладка встаёт перед целью, вправо — после неё. Возьми
 * одно «всегда перед», и жест наполовину перестаёт работать: вкладку тянут на
 * соседа справа, она возвращается на своё же место, и человек тянет снова.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { reordered, Tabs, type Room } from '../web/src/lib/tabs.svelte.js'

/*
 * Те же две подделки, что и в panels.test.mts, и по тем же доводам: компилятора
 * Svelte здесь нет, и `$state` остаётся обычным вызовом; хранилища у узла нет, а
 * без него не проверить главного — что порядок переживает перезагрузку.
 */
;(globalThis as { $state?: unknown }).$state = <T,>(value: T): T => value
const store = new Map<string, string>()
;(globalThis as { localStorage?: unknown }).localStorage = {
  getItem: (key: string) => store.get(key) ?? null,
  setItem: (key: string, value: string) => void store.set(key, value),
  removeItem: (key: string) => void store.delete(key),
}

const ROW = ['a.py', 'b.py', 'c.py', 'd.py']

test('тянут вправо — встаёт ПОСЛЕ цели', () => {
  assert.deepEqual(reordered(ROW, 'a.py', 'c.py'), ['b.py', 'c.py', 'a.py', 'd.py'])
})

test('тянут влево — встаёт ПЕРЕД целью', () => {
  assert.deepEqual(reordered(ROW, 'd.py', 'b.py'), ['a.py', 'd.py', 'b.py', 'c.py'])
})

test('соседи меняются местами одним движением', () => {
  // Самый частый жест, и он обязан работать в обе стороны.
  assert.deepEqual(reordered(ROW, 'a.py', 'b.py'), ['b.py', 'a.py', 'c.py', 'd.py'])
  assert.deepEqual(reordered(ROW, 'b.py', 'a.py'), ['b.py', 'a.py', 'c.py', 'd.py'])
})

test('бросок в пустоту справа — в конец ряда', () => {
  assert.deepEqual(reordered(ROW, 'a.py', null), ['b.py', 'c.py', 'd.py', 'a.py'])
  // И вкладка, уже стоящая последней, никуда не едет.
  assert.deepEqual(reordered(ROW, 'd.py', null), ROW)
})

test('бросок на самого себя ничего не меняет', () => {
  assert.deepEqual(reordered(ROW, 'c.py', 'c.py'), ROW)
})

test('чужая вкладка целью быть может, а вкладкой — нет', () => {
  // Приколотые комнатой (общий экран, лекция) в своих не лежат. Бросок НА них
  // означает «первым среди своих», сразу за приколотыми.
  assert.deepEqual(reordered(ROW, 'c.py', 'лекция.pdf'), ['c.py', 'a.py', 'b.py', 'd.py'])
  // А саму приколотую переставить нечем: её в ряду своих нет.
  assert.deepEqual(reordered(ROW, 'лекция.pdf', 'a.py'), ROW)
})

test('порядок переживает перезагрузку вкладки', () => {
  /*
   * Ради этого порядок и меняют: разложив файлы под себя, человек не должен
   * разкладывать их заново после F5. Запись идёт тем же путём, что у открытия
   * и закрытия, — `#remember`.
   */
  const room: Room = { alive: new Set(['a.py', 'b.py', 'c.py']), firstBook: 'a.py', board: null }
  const first = new Tabs('order-room')
  first.settle(room)
  first.open('b.py')
  first.open('c.py')
  assert.deepEqual(first.row(null), ['a.py', 'b.py', 'c.py'])
  first.reorder('c.py', 'a.py')
  assert.deepEqual(first.row(null), ['c.py', 'a.py', 'b.py'])

  const again = new Tabs('order-room')
  again.settle(room)
  assert.deepEqual(again.row(null), ['c.py', 'a.py', 'b.py'], 'после перезагрузки порядок сбросился')
})

test('перестановка не переключает вкладку', () => {
  // Человек раскладывает вкладки, а не ходит по ним: увести его с той, что он
  // читает, значит сделать за него второе действие, которого он не просил.
  const room: Room = { alive: new Set(['a.py', 'b.py', 'c.py']), firstBook: 'a.py', board: null }
  const tabs = new Tabs('order-stay')
  tabs.settle(room)
  tabs.open('b.py')
  tabs.open('c.py')
  tabs.show('b.py')
  tabs.reorder('a.py', null)
  assert.equal(tabs.active, 'b.py')
})

test('приколотая комнатой вкладка не двигается даже просьбой', () => {
  const room: Room = { alive: new Set(['a.py', 'общий.pdf']), firstBook: 'a.py', board: 'общий.pdf' }
  const tabs = new Tabs('order-pinned')
  tabs.settle(room)
  assert.deepEqual(tabs.row('общий.pdf'), ['общий.pdf', 'a.py'])
  tabs.reorder('общий.pdf', 'a.py')
  assert.deepEqual(tabs.row('общий.pdf'), ['общий.pdf', 'a.py'], 'общий экран переставили себе')
})
