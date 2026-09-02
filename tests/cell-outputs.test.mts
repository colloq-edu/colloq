/**
 * Прогресс-бар — одна строка, а не двести.
 *
 * Возврат каретки в тетради не сворачивал никто: tqdm и `pip install` печатали
 * каждый кадр отдельной строкой, вывод перелезал через порог схлопывания и
 * прятался под «Show more». Свёртка фиддлится ровно в тех местах, которые в
 * глазок не видны: `\r\n`, кадр в конце строки, строка без `\r` вовсе.
 */
import './_env.mts'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { collapseCarriage } from '../web/src/lib/utils.js'

test('строка без возврата каретки не трогается', () => {
  assert.equal(collapseCarriage('hello\nworld\n'), 'hello\nworld\n')
  // Хвостовой перевод строки остаётся: он у ячейки значащий.
  assert.equal(collapseCarriage(''), '')
})

test('остаётся последний кадр каждой строки', () => {
  assert.equal(collapseCarriage('10%\r50%\r100%'), '100%')
  assert.equal(collapseCarriage('a\r1\nb\r2'), '1\n2')
})

test('кадр, оборванный на возврате каретки, не даёт пустой строки', () => {
  // tqdm заканчивает кадр возвратом каретки и ждёт следующего.
  assert.equal(collapseCarriage('50%\r'), '50%')
  assert.equal(collapseCarriage('\r\r30%\r\r'), '30%')
})

test('CRLF читается как перевод строки, а не как кадр', () => {
  assert.equal(collapseCarriage('one\r\ntwo\r\n'), 'one\ntwo\n')
})

test('свёртка не съедает строки без кадров', () => {
  const mixed = 'Collecting torch\n  0%\r 50%\r100%\nSuccessfully installed'
  assert.equal(collapseCarriage(mixed), 'Collecting torch\n100%\nSuccessfully installed')
})
