/**
 * Мелочи тетради, которые видно только глазами, — и одно слово, без которого
 * консилиум врёт.
 *
 * Три правила, каждое откатывается одной строкой и каждое об этом молчит:
 * кнопка «Запустить» над файлом переводит переход шорткатом `transition` (все
 * свойства, включая кольцо фокуса) вместо позиционного списка; «кто запускал»
 * ищется перебором по всем вкладкам комнаты в КАЖДОЙ ячейке с выводом; про
 * общее ядро попыток не сказано там, где ручку включают.
 *
 * Читается прямо из компонентов — тот же приём, что в panels-craft: тест со
 * своей копией правила проходит вечно, пока файл уезжает.
 */
import './_env.mts'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { COUNCIL_SHARED_KERNEL_NOTE } from '../shared/notebook.js'

function read(rel: string): string {
  return fs.readFileSync(path.resolve(import.meta.dirname, '..', rel), 'utf8')
}

/** Разметка и стили без комментариев: объяснение — не обещание. */
function code(source: string): string {
  return source.replace(/<!--[\s\S]*?-->/g, '').replace(/\/\*[\s\S]*?\*\//g, '')
}

const CELL = read('web/src/components/notebook/CellView.svelte')
const FILEBAR = read('web/src/components/editor/FileBar.svelte')

/* ------------------------------------------------------------- переходы */

test('«Запустить» над файлом переводит два свойства, а не все подряд', () => {
  const bar = code(FILEBAR)
  // `transition` без списка переводит и border-color, и box-shadow: кольцо
  // фокуса приезжало вслед за клавишей вместо того, чтобы появиться сразу.
  assert.doesNotMatch(bar, /class="[^"]*\btransition\s/, 'шорткат `transition` вернулся')
  assert.match(bar, /transition-\[filter,transform\]/, 'список свойств — позиционный')
  // Лестница скоростей и кривых (index.css) существует ровно чтобы литералов
  // вроде «100ms ease-out» тут не было.
  assert.match(bar, /duration-press ease-out/, 'скорость и кривая — из лестницы')
  // Нажимаемое отвечает пальцу: тот же press, что у близнеца этой кнопки —
  // «На общий экран» в SessionScreen.
  assert.match(bar, /enabled:active:scale-\[0\.97\]/, 'кнопка не прессуется')
})

/* --------------------------------------------------------- присутствие */

test('«кто запускал» спрашивается по карте, а не перебором по всей комнате', () => {
  const at = CELL.indexOf('const runner = $derived.by')
  assert.ok(at > 0, 'лица запускавшего в ячейке больше нет')
  const runner = CELL.slice(at, at + 300)
  assert.match(runner, /session\.peersById\.get\(who\)/)
  // Двести ячеек на пятьсот вкладок — сто тысяч сравнений на кадр присутствия.
  assert.doesNotMatch(code(CELL), /session\.peers\.find\(/, 'перебор по вкладкам вернулся')
})

/* ------------------------------------------------------------ общее ядро */

test('про общее ядро сказано там, где ручку включают, и у кнопки попытки', () => {
  // Одна копия на весь продукт: строка живёт в shared, а не переписана здесь
  // своими словами — иначе подсказка кнопки и ручка разъедутся.
  assert.match(CELL, /COUNCIL_SHARED_KERNEL_NOTE/)
  assert.doesNotMatch(CELL, /Попытки считаются в общем ядре/, 'строка переписана копией')

  const knob = CELL.indexOf('Запуск студентам')
  assert.ok(knob > 0, 'ручки studentRun больше нет')
  assert.match(
    CELL.slice(knob, knob + 1200),
    /\{COUNCIL_SHARED_KERNEL_NOTE\}/,
    'у ручки сказано только про очередь',
  )

  const run = CELL.indexOf('Запустить свою попытку — в очередь, по одному')
  assert.ok(run > 0, 'кнопки запуска попытки больше нет')
  assert.match(
    CELL.slice(run - 200, run + 300),
    /\$\{COUNCIL_SHARED_KERNEL_NOTE\}/,
    'подсказка кнопки — про очередь, а не про состояние',
  )
})

test('строка про общее ядро говорит и про снятые имена, и про общие данные', () => {
  // Сервер снимает имена, заведённые попыткой (kernel/index.ts ·
  // COUNCIL_SNAPSHOT_NAMES), но изменённые данные остаются общими — фраза
  // описывает ровно это, иначе она обещала бы изоляцию, которой нет.
  assert.match(COUNCIL_SHARED_KERNEL_NOTE, /по очереди/)
  assert.match(COUNCIL_SHARED_KERNEL_NOTE, /удаляются после запуска/)
  assert.match(COUNCIL_SHARED_KERNEL_NOTE, /общих объектов и файлов сохраняются/)
})
