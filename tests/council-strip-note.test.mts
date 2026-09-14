/**
 * Про общее ядро сказано там, где ручку включают, — и чужими словами.
 *
 * Попытки считаются в ОДНОМ ядре комнаты: имена, заведённые попыткой, сервер
 * снимает (kernel/index.ts · COUNCIL_SNAPSHOT_NAMES), а изменения существующих
 * объектов остаются общими. Преподаватель ставит «верно» по выводу, поэтому
 * сказать это надо там, где он на вывод смотрит и где решает, кому запускать.
 * Шапка `COUNCIL_SHARED_KERNEL_NOTE` называет три таких места: ручка «кто может
 * запускать», подсказка кнопки запуска у студента, README. Первое было в меню
 * замка и уехало в полосу очереди пульта вместе с самой ручкой; второе и
 * третье закрыты своими тестами (notebook-craft, docs-promises), первое — здесь.
 *
 * Проверяется и то, что строка не переписана своими словами: копия одна, в
 * shared/notebook.ts, иначе ручка и строка разъедутся на первой же правке, — и
 * что она стоит текстом, а не подсказкой: пульт ведут с планшета, где наведения
 * нет вовсе.
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

const QUEUE = code(read('web/src/components/council/pult/PultQueueStrip.svelte'))

/** Панель ручки: от заголовка «кто может запускать» до списка ждущих. */
function knob(): string {
  const from = QUEUE.indexOf("tr('room.ui.1286')")
  const to = QUEUE.indexOf('{#if kernel.pending.length > 0}', from)
  assert.ok(from > 0 && to > from, 'ручки запуска в полосе очереди больше нет')
  return QUEUE.slice(from, to)
}

test('ручка запуска говорит про общее ядро — строкой из shared', () => {
  assert.match(QUEUE, /import \{ COUNCIL_SHARED_KERNEL_NOTE[^}]*\} from '@shared\/notebook'/)
  assert.match(knob(), /\{tr\(COUNCIL_SHARED_KERNEL_NOTE\)\}/, 'у ручки строки нет')

  // Своей копии нет: первые слова фразы в компоненте встретиться не должны.
  const opening = COUNCIL_SHARED_KERNEL_NOTE.slice(0, 24)
  assert.ok(!QUEUE.includes(opening), 'строка переписана копией')
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
