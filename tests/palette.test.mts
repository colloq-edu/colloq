/**
 * Палитра команд комнаты: отбор строк и порядок ответа.
 *
 * Всё, до чего в комнате раньше можно было дотянуться только мышью — панели,
 * вкладки, переход к ячейке, строка оракула, — теперь живёт одним списком под
 * ⌘K. Ломается он молча и ровно в двух местах: человек печатает обрывками
 * («03 imp»), и если слова ищутся одной подстрокой, список пуст; и если
 * «Run all» на запрос «run» оказывается восьмой строкой, палитрой перестают
 * пользоваться на второй паре.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { groupHeads, matchItems, type PaletteItem } from '../web/src/components/ui/palette.js'

const item = (id: string, group: string, label: string, hint?: string, keywords?: string): PaletteItem => ({
  id,
  group,
  label,
  hint,
  keywords,
  run: () => {},
})

const ROOM: PaletteItem[] = [
  item('run-all', 'Комната', 'Запустить всю тетрадь', undefined, 'run all выполнить'),
  item('interrupt', 'Комната', 'Остановить выполнение', undefined, 'interrupt stop прервать'),
  item('panel-files', 'Комната', 'Панель файлов и людей', '⌘B', 'files people'),
  item('tab', 'Вкладки', 'Тетрадь.ipynb', 'Ctrl1', 'Тетрадь.ipynb'),
  item('file', 'Файлы', 'src/model.py'),
  item('cell-3', 'Ячейки', 'import numpy as np', '03', 'ячейка cell 3'),
  item('cell-4', 'Ячейки', 'model.fit(x, y)', '04', 'ячейка cell 4'),
]

test('пустой запрос отдаёт весь список в исходном порядке', () => {
  assert.deepEqual(
    matchItems(ROOM, '   ').map((entry) => entry.id),
    ROOM.map((entry) => entry.id),
  )
})

test('слова ищутся по отдельности и в любом порядке', () => {
  // Номер ячейки живёт в подсказке, слово из кода — в подписи.
  assert.deepEqual(
    matchItems(ROOM, '03 imp').map((entry) => entry.id),
    ['cell-3'],
  )
  assert.deepEqual(
    matchItems(ROOM, 'imp 03').map((entry) => entry.id),
    ['cell-3'],
  )
})

test('совпадение с начала подписи идёт первым', () => {
  const found = matchItems(ROOM, 'запустить')
  assert.equal(found[0].id, 'run-all')
})

test('найденное по ключевым словам стоит ниже найденного по подписи', () => {
  // «Остановить выполнение» содержит «выполн» в подписи, «Запустить всю
  // тетрадь» — только в ключевых словах.
  const found = matchItems(ROOM, 'выполн').map((entry) => entry.id)
  assert.deepEqual(found, ['interrupt', 'run-all'])
})

test('регистр не имеет значения', () => {
  assert.deepEqual(
    matchItems(ROOM, 'MODEL').map((entry) => entry.id),
    matchItems(ROOM, 'model').map((entry) => entry.id),
  )
})

test('раздел тоже ищется — «ячейки» показывает ячейки', () => {
  const found = matchItems(ROOM, 'ячейки').map((entry) => entry.id)
  assert.deepEqual(found, ['cell-3', 'cell-4'])
})

test('ничего не нашлось — пустой список, а не весь', () => {
  assert.deepEqual(matchItems(ROOM, 'тензорное разложение'), [])
})

test('заголовок раздела печатается один раз на серию', () => {
  assert.deepEqual(groupHeads(ROOM), [
    'Комната',
    null,
    null,
    'Вкладки',
    'Файлы',
    'Ячейки',
    null,
  ])
})

test('после отбора заголовки считаются заново', () => {
  const found = matchItems(ROOM, 'cell')
  assert.deepEqual(groupHeads(found), ['Ячейки', null])
})
