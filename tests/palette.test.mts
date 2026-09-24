/**
 * The room's command palette: filtering rows and ordering the answer.
 *
 * Everything in the room that used to be reachable only with the mouse —
 * panels, tabs, jumping to a cell, the oracle line — now lives in one list
 * under ⌘K. It breaks silently and in exactly two places: people type in
 * fragments ("03 imp"), and if the words are searched as one substring, the
 * list is empty; and if "Run all" comes up as the eighth row for the query
 * "run", people stop using the palette by the second class.
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

test('an empty query returns the whole list in its original order', () => {
  assert.deepEqual(
    matchItems(ROOM, '   ').map((entry) => entry.id),
    ROOM.map((entry) => entry.id),
  )
})

test('words are searched separately and in any order', () => {
  // The cell number lives in the hint, the word from the code in the label.
  assert.deepEqual(
    matchItems(ROOM, '03 imp').map((entry) => entry.id),
    ['cell-3'],
  )
  assert.deepEqual(
    matchItems(ROOM, 'imp 03').map((entry) => entry.id),
    ['cell-3'],
  )
})

test('a match at the start of the label comes first', () => {
  const found = matchItems(ROOM, 'запустить')
  assert.equal(found[0].id, 'run-all')
})

test('matches on keywords rank below matches on the label', () => {
  // "Остановить выполнение" has "выполн" in its label, "Запустить всю
  // тетрадь" only in its keywords.
  const found = matchItems(ROOM, 'выполн').map((entry) => entry.id)
  assert.deepEqual(found, ['interrupt', 'run-all'])
})

test('case does not matter', () => {
  assert.deepEqual(
    matchItems(ROOM, 'MODEL').map((entry) => entry.id),
    matchItems(ROOM, 'model').map((entry) => entry.id),
  )
})

test('the group is searched too: the group name shows its cells', () => {
  const found = matchItems(ROOM, 'ячейки').map((entry) => entry.id)
  assert.deepEqual(found, ['cell-3', 'cell-4'])
})

test('nothing found gives an empty list, not the whole one', () => {
  assert.deepEqual(matchItems(ROOM, 'тензорное разложение'), [])
})

test('a group heading is printed once per run of items', () => {
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

test('headings are recomputed after filtering', () => {
  const found = matchItems(ROOM, 'cell')
  assert.deepEqual(groupHeads(found), ['Ячейки', null])
})
