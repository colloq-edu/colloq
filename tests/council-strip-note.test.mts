/**
 * Про общее ядро сказано там, где ручку включают, — и чужими словами.
 *
 * Попытки считаются в ОДНОМ ядре комнаты: данные каждая получает свои, а имена
 * и привязки сервер возвращает после неё (kernel/council-isolation.ts), но
 * файлы и состояние модулей остаются общими. Преподаватель ставит «верно» по
 * выводу, поэтому сказать это надо там, где он на вывод смотрит и где решает,
 * кому запускать.
 * Шапка `COUNCIL_SHARED_KERNEL_NOTE` называет три таких места: ручка «кто может
 * запускать», подсказка кнопки запуска у студента, README. Первое было в меню
 * замка, потом в полосе очереди пульта, теперь — в подвале листа регламента,
 * под всеми четырьмя правилами; второе и третье закрыты своими тестами
 * (notebook-craft, docs-promises), первое — здесь.
 *
 * Проверяется и то, что строка не переписана своими словами: копия одна, в
 * shared/notebook.ts, иначе ручка и строка разъедутся на первой же правке, — и
 * что она стоит текстом, а не подсказкой: пульт ведут с планшета, где наведения
 * нет вовсе.
 *
 * С листом регламента (PultRules.svelte) ручка переехала из подвала очереди
 * туда, где стоят все четыре правила ячейки, — и строка про общее ядро уехала
 * вместе с ней: она объясняет цену ИМЕННО этой ручки.
 *
 * Разметка читается прямо из компонента — тот же приём, что в panels-craft.
 */
import fs from 'node:fs'
import path from 'node:path'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { COUNCIL_SHARED_KERNEL_NOTE } from '../shared/notebook.js'

function read(rel: string): string {
  return fs.readFileSync(path.resolve(import.meta.dirname, '..', rel), 'utf8')
}

/** Разметка без комментариев: объяснение — не обещание. */
function code(source: string): string {
  return source.replace(/<!--[\s\S]*?-->/g, '').replace(/\/\*[\s\S]*?\*\//g, '')
}

const RULES = code(read('web/src/components/council/pult/PultRules.svelte'))

/** Лист регламента: ряд «Кто запускает» и подвал под всеми правилами. */
function knob(): string {
  const from = RULES.indexOf("PULT_RULES.map")
  assert.ok(from > 0, 'рядов регламента больше нет')
  return RULES.slice(from)
}

test('ручка запуска говорит про общее ядро — строкой из shared', () => {
  assert.match(RULES, /import \{ COUNCIL_SHARED_KERNEL_NOTE[^}]*\} from '@shared\/notebook'/)
  assert.match(knob(), /\{tr\(COUNCIL_SHARED_KERNEL_NOTE\)\}/, 'у ручки строки нет')

  // Своей копии нет: первые слова фразы в компоненте встретиться не должны.
  const opening = COUNCIL_SHARED_KERNEL_NOTE.slice(0, 24)
  assert.ok(!RULES.includes(opening), 'строка переписана копией')
})

test('строка видна без наведения — на планшете наведения нет', () => {
  assert.doesNotMatch(knob(), /title=\{COUNCIL_SHARED_KERNEL_NOTE\}/)
  assert.doesNotMatch(knob(), /title="\{COUNCIL_SHARED_KERNEL_NOTE\}"/)
})

test('в тетради ручки запуска не осталось: её место — пульт', () => {
  const cell = code(read('web/src/components/notebook/CellView.svelte'))
  assert.doesNotMatch(cell, /setStudentRun|studentRun \}/, 'ручка вернулась в меню замка')
  assert.doesNotMatch(cell, /tr\('room\.ui\.335'\)/, 'заголовок ручки остался в тетради')
})
