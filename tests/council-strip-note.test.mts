/**
 * Полоса консилиума говорит про общее ядро — и говорит чужими словами.
 *
 * Попытки считаются в ОДНОМ ядре комнаты: имена, заведённые попыткой, сервер
 * снимает (kernel/index.ts · COUNCIL_SNAPSHOT_NAMES), а изменения существующих
 * объектов остаются общими. Преподаватель ставит «верно» по выводу, поэтому
 * сказать это надо там, где он на вывод смотрит. Шапка `COUNCIL_SHARED_KERNEL_NOTE`
 * называет три таких места: подсказка ручки studentRun, полоса консилиума,
 * README. Первое и третье закрыты своими тестами (notebook-craft, docs-promises),
 * второе — здесь.
 *
 * Проверяется и то, что строка не переписана своими словами: копия одна, в
 * shared/notebook.ts, иначе ручка и полоса разъедутся на первой же правке — и
 * не подсказкой на метке: пульт ведут с планшета, где наведения нет вовсе.
 *
 * Разметка читается прямо из компонента — тот же приём, что в panels-craft и
 * council-stack-craft.
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

const STACK = code(read('web/src/components/council/CouncilStack.svelte'))

/** Полоса режима: от счётчиков до первой ветки вида. */
function strip(): string {
  const from = STACK.indexOf('councilStripText(board.counts')
  const to = STACK.indexOf('{#if view ===', from)
  assert.ok(from > 0 && to > from, 'полосы режима в стопке больше нет')
  return STACK.slice(from, to)
}

test('полоса консилиума говорит про общее ядро — строкой из shared', () => {
  assert.match(STACK, /import \{ COUNCIL_SHARED_KERNEL_NOTE \} from '@shared\/notebook'/)
  assert.match(strip(), /\{tr\(COUNCIL_SHARED_KERNEL_NOTE\)\}/, 'в полосе режима строки нет')

  // Своей копии нет: первые слова фразы в компоненте встретиться не должны.
  const opening = COUNCIL_SHARED_KERNEL_NOTE.slice(0, 24)
  assert.ok(!STACK.includes(opening), 'строка переписана копией')
})

test('строка видна без наведения — на планшете наведения нет', () => {
  // Подсказка на метке «Консилиум» не доезжает до пульта на iPad, а именно там
  // его и ведут: предупреждение должно стоять текстом.
  assert.doesNotMatch(strip(), /title=\{COUNCIL_SHARED_KERNEL_NOTE\}/)
  assert.doesNotMatch(strip(), /title="\{COUNCIL_SHARED_KERNEL_NOTE\}"/)
})
