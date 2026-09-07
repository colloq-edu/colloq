/**
 * Задание консилиума — то, чем засевается пустой лист.
 *
 * Лист сеялся общим текстом ячейки, а после «Показать классу» общий текст —
 * уже чьё-то решение: опоздавший получал его стартовым текстом своего листа и
 * одним нажатием сдавал как своё. Поэтому текст ячейки снимается один раз, на
 * переходе замка в консилиум (control.ts · cell:lock зовёт `rememberSeed`), и
 * едет каждому в `CouncilMine.seed`.
 *
 * Здесь — половина сервера: хранение, обе ветки `mineFor`, перезапуск и снос
 * комнаты. Что с этим полем делает лист, проверяет tests/notebook-council-seed.
 */
import './_env.mts'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createSession } from '../server/src/db.js'
import {
  discardCouncil,
  mineFor,
  rememberSeed,
  resetCouncilCache,
  saveDraft,
  seedOf,
} from '../server/src/council.js'

const TASK = '# Посчитайте среднее по группам\ndf = pd.read_csv("marks.csv")'
const SHOWN = 'df.groupby("group")["mark"].mean()'

let n = 0

/** Своя комната на тест: попытки живут в общей таблице по ключу семинара. */
function room(): { id: string; cell: string } {
  n += 1
  const id = `seed-${n}`
  createSession(id, `Семинар ${n}`)
  return { id, cell: `cell-${n}` }
}

test('пустой лист приезжает с заданием, а не с тем, что в ячейке сейчас', () => {
  const at = room()
  rememberSeed(at.id, at.cell, TASK)
  // «Показать классу» переписало общий текст — задание от этого не меняется:
  // его снимали один раз, на открытии консилиума.
  const mine = mineFor(at.id, at.cell, 'late', false)
  assert.equal(mine?.text, '')
  assert.equal(mine?.seed, TASK)
  assert.notEqual(mine?.seed, SHOWN)
})

test('задание едет и тому, у кого попытка уже есть', () => {
  const at = room()
  rememberSeed(at.id, at.cell, TASK)
  saveDraft(at.id, at.cell, 'ada', 'df.head()', 1000)
  const mine = mineFor(at.id, at.cell, 'ada', false)
  assert.equal(mine?.text, 'df.head()')
  assert.equal(mine?.seed, TASK)
})

test('задания не помнят — поля нет вовсе, и клиент сеет по-старому', () => {
  const at = room()
  const mine = mineFor(at.id, at.cell, 'ada', false)
  assert.equal(mine?.text, '')
  // Не `undefined` в поле, а отсутствие поля: пустая строка здесь значит
  // «консилиум открыли на пустой ячейке», и спутать их нельзя.
  assert.equal('seed' in (mine as object), false)
})

test('пустая ячейка — законное задание: пустой лист у всех', () => {
  const at = room()
  rememberSeed(at.id, at.cell, '')
  const mine = mineFor(at.id, at.cell, 'ada', false)
  assert.equal('seed' in (mine as object), true)
  assert.equal(mine?.seed, '')
})

test('задание переживает перезапуск сервера', () => {
  const at = room()
  rememberSeed(at.id, at.cell, TASK)
  // То же, что перезапуск: кэш комнаты забыт, правда осталась в SQLite.
  resetCouncilCache(at.id)
  assert.equal(seedOf(at.id, at.cell), TASK)
  assert.equal(mineFor(at.id, at.cell, 'late', false)?.seed, TASK)
})

test('семинар снесли — задание ушло с ним', () => {
  const at = room()
  rememberSeed(at.id, at.cell, TASK)
  discardCouncil(at.id)
  resetCouncilCache(at.id)
  assert.equal(seedOf(at.id, at.cell), null)
})

test('второе открытие консилиума на той же ячейке ставит новое задание', () => {
  const at = room()
  rememberSeed(at.id, at.cell, TASK)
  // Замок закрыли и открыли снова — в ячейке другое задание, и снимается оно.
  rememberSeed(at.id, at.cell, SHOWN)
  assert.equal(seedOf(at.id, at.cell), SHOWN)
})
