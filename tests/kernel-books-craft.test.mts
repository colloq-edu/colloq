/**
 * Тетрадь = ядро — со стороны экрана.
 *
 * Сервер считает каждую тетрадь в своём Python (server/src/kernel/index.ts), и
 * всё, что от этого видно, легко потерять молча: плашка «ГОТОВО» над
 * считающей тетрадью, счётчик очереди соседнего листа, «Перезапустить»,
 * уносящий переменные не той тетради. Ни одно из этих трёх не падает в
 * тестах — каждое просто показывает неправду, и заметить её можно только на
 * паре, где две тетради заняты разным.
 *
 * Читается прямо из компонентов — тот же приём, что в panels-craft: тест со
 * своей копией правила проходит вечно, пока файл уезжает.
 */
import './_env.mts'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { tr } from '../shared/i18n.js'
import { COUNCIL_SHARED_KERNEL_NOTE } from '../shared/notebook.js'

function read(rel: string): string {
  return fs.readFileSync(path.resolve(import.meta.dirname, '..', rel), 'utf8')
}

/** Разметка и стили без комментариев: объяснение — не обещание. */
function code(source: string): string {
  return source.replace(/<!--[\s\S]*?-->/g, '').replace(/\/\*[\s\S]*?\*\//g, '')
}

const NOTEBOOK = read('web/src/components/notebook/Notebook.svelte')
const CELL = read('web/src/components/notebook/CellView.svelte')
const SCREEN = read('web/src/screens/SessionScreen.svelte')
const TABS = read('web/src/components/reader/TabStrip.svelte')
const YREACTIVE = read('web/src/lib/yreactive.svelte.ts')

/* ------------------------------------------------------ полоса тетради */

test('полоса тетради читает ядро СВОЕЙ тетради, а не комнаты', () => {
  const bar = code(NOTEBOOK)
  assert.match(
    bar,
    /const notebook = watchBookKernel\(session\.doc, \(\) => root\)/,
    'полоса вернулась к общему на комнату состоянию',
  )
  assert.doesNotMatch(bar, /watchNotebookMeta/, 'комнатное состояние вернулось в полосу тетради')
  // Через него же считаются плашка и счётчик — чтобы они не разъехались.
  assert.match(bar, /const kernel = \$derived\(notebook\.current\.kernelStatus\)/)
  assert.match(bar, /const queued = \$derived\(notebook\.current\.queue\.length\)/)
})

test('«Перезапустить» и «Прервать» из полосы называют свой лист', () => {
  const bar = code(NOTEBOOK)
  const restarts = [...bar.matchAll(/send\(\{ t: 'restart'[^}]*\}\)/g)].map((m) => m[0])
  assert.ok(restarts.length >= 2, `перезапусков в полосе: ${restarts.length}`)
  for (const one of restarts) {
    assert.match(one, /book/, `перезапуск без имени листа: ${one}`)
  }
  /*
   * Interrupt без листа сервер понимает как «тетрадь комнаты» и разбирает её
   * очередь — соседнюю, до которой этой кнопке дела нет.
   */
  const stop = bar.slice(bar.indexOf('function interruptMessage'))
  const body = stop.slice(0, stop.indexOf('\n  }'))
  // Оба выхода из функции называют лист — и её тип его знает.
  assert.equal(body.match(/return \{ t: 'interrupt'[^}]*book/g)?.length, 2, body)
  assert.doesNotMatch(body, /\{ t: 'interrupt' \}/, 'безымянное «Прервать» вернулось')
})

test('очередь у ячейки считается в её тетради', () => {
  const cell = code(CELL)
  assert.match(cell, /watchBookKernel\(session\.doc, \(\) => bookRoot\)/)
  assert.match(cell, /queuePosition = \$derived\(notebook\.current\.queue\.indexOf\(id\)\)/)
})

/* --------------------------------------------------------- шапка и вкладки */

test('индикатор в шапке говорит про ОТКРЫТУЮ тетрадь', () => {
  const screen = code(SCREEN)
  assert.match(screen, /const openKernel = watchBookKernel\(session\.doc, \(\) => openRoot\)/)
  assert.match(screen, /const kernel = \$derived\(KERNEL\[openKernel\.current\.kernelStatus\]\)/)
  assert.doesNotMatch(
    screen,
    /KERNEL\[meta\.current\.kernelStatus\]/,
    'шапка снова показывает состояние комнаты вместо открытой тетради',
  )
  // Совет про неподнявшееся ядро — про ту же тетрадь, а не про соседнюю.
  assert.match(screen, /openKernel\.current\.kernelProblem/)
  /*
   * Корень считается ПОСЛЕ списка тетрадей и вкладок: он их читает, и
   * переставленный выше он взял бы пустоту на первом кадре.
   */
  assert.ok(
    screen.indexOf('const openRoot = $derived(') > screen.indexOf('const books = watchBooks('),
    'открытая тетрадь считается раньше, чем известен их список',
  )
})

test('на вкладке есть точка занятости, и она не подпись', () => {
  const tabs = code(TABS)
  assert.match(tabs, /const busyOf = \(key: string\): boolean => bookOf\(key\)\?\.busy === true/)
  const dot = tabs.slice(tabs.indexOf('{#if busyOf(key)}'))
  const block = dot.slice(0, dot.indexOf('{/if}'))
  assert.match(block, /rounded-full/, 'точка перестала быть точкой')
  assert.match(block, /room\.book\.busy/, 'у точки нет слов для тех, кто её не видит')
  assert.match(block, /prefersReducedMotion\(\)/, 'точка мигает и там, где движение выключено')
  // Строка вкладок получает занятость извне: сама она документа не читает.
  assert.match(code(SCREEN), /busy: bookBusy\.busy\(book\.root\)/)
})

/* ------------------------------------------------- реактивный слой */

test('состояние ядер в браузере читается по тетрадям и будит только своих', () => {
  const lib = code(YREACTIVE)
  assert.match(lib, /export function watchBookKernel/)
  assert.match(lib, /export function watchBookBusy/)
  /*
   * Коробка на ПОЛЕ, внутри — карта «корень → значение», и все четыре заведены
   * конструктором. Коробки на тетрадь, заводившиеся по первому спросу, стоили
   * 20.09 целой жалобы: первый спрос приходит из `$derived` шапки, состояние,
   * созданное внутри реакции, этой реакцией и владеется, и последующие записи
   * её не будят — плашка ядра показывала «ЗАПУСК» у поднявшегося ядра вечно.
   * Довод целиком — у `bookView`.
   */
  assert.match(lib, /readonly bookStatus = box<Record<string, KernelStatus>>\(\{\}\)/)
  assert.match(lib, /#views = new Map<string, BookKernelView>\(\)/)
  assert.doesNotMatch(lib, /BookKernelBoxes/, 'вернулись коробки на тетрадь')
  // Прочитать заранее просит тот, кто может, — из тела компонента.
  assert.match(lib, /fields\.prime\(root\(\)\)/)
  // А отложенное чтение не пишет в состояние во время счёта производной.
  assert.match(lib, /queueMicrotask\(\(\) => this\.#readBooks\(root\)\)/)
  /*
   * Запасной ответ для тетради комнаты — по прежним ключам: комната со старым
   * снимком и вкладка, пришедшая раньше первого запуска, обязаны показать
   * правду, а не «запускается» навсегда.
   */
  assert.match(lib, /bookKernel\(this\.#doc, root\)/)
})

/* ------------------------------------ ресурсы личных тетрадей в правилах */

test('ресурсы личных тетрадей раскрываются под правилом, и только когда оно включено', () => {
  const rows = code(read('web/src/components/RoomRulesRows.svelte'))
  /*
   * Вопрос «можно ли» и вопрос «сколько» человек задаёт себе подряд, одним
   * движением. Блок на отдельном экране означал бы, что на второй вопрос
   * большинство не ответит никогда — а умолчание «столько же» на машине стоит
   * вдвое.
   */
  assert.match(rows, /\{#if row\.key === 'ownBooks' && rules\.ownBooks === 'on'\}/)
  assert.match(rows, /ownMemoryMb: event\.currentTarget\.value === '' \? null : Number/)
  assert.match(rows, /ownCpus: event\.currentTarget\.value === '' \? null : Number/)
  // «Как у занятия» — пустая строка выбора, то есть `null`: отдельного
  // выключателя у неё нет, и заводить его было бы вторым способом сказать то же.
  assert.match(rows, /<option value="">\{asClassMemory\}<\/option>/)
  assert.match(rows, /room\.rules\.ownRes\.noGpu/)
  assert.match(rows, /room\.rules\.ownRes\.note/)
  // Телефон: выбор растёт до пальца, как соседние сегменты.
  assert.match(rows, /@media \(max-width: 640px\)[\s\S]*?\.rule-pick \{\s*height: 44px/)
})

test('слова правил называют вещи так, как их называет преподаватель', () => {
  // Два режима замка зовутся ОДИНАКОВО везде, где о них говорят.
  assert.equal(tr('room.ui.1130'), 'Пишут вместе')
  assert.equal(tr('room.ui.1131'), 'Каждый отвечает сам')
  assert.match(tr('room.ui.1079'), /пишут вместе/)
  // Правило про личные тетради называет ядро и потолок в три строки.
  assert.match(tr('room.rules.ownBooks.note'), /своё ядро/)
  assert.match(tr('room.rules.ownBooks.note'), /трёх/)
  assert.equal(tr('room.rules.ownBooks.on'), 'Можно')
  // «По одной» — про тетрадь, а не про комнату: очередей столько же, сколько
  // тетрадей (server/src/kernel/index.ts · requestRun).
  assert.match(tr('room.ui.1135'), /в тетради не больше одной ячейки/)
  // Очистка вывода теперь тоже по тетради.
  assert.match(tr('room.ui.1162'), /ячеек тетради/)
  assert.match(tr('room.ui.1160'), /личной тетради/)
})

/* --------------------------------------------------------------- слова */

test('слова про ядро говорят про тетрадь, а не про комнату', () => {
  // Обещание консилиума — одной строкой каталога, а не копией в разметке.
  assert.match(tr(COUNCIL_SHARED_KERNEL_NOTE), /ядре этой тетради/)
  assert.match(tr(COUNCIL_SHARED_KERNEL_NOTE), /по очереди/)
  assert.doesNotMatch(tr(COUNCIL_SHARED_KERNEL_NOTE), /в общем ядре/)
  /*
   * Подсказка правила называет ядро; про GPU говорит блок ресурсов под ней —
   * там, где выбирают, сколько отсыпать, и где «без GPU» и есть ответ на
   * вопрос «а карту они заберут?».
   */
  assert.match(tr('room.rules.ownBooks.note'), /своё ядро/)
  assert.match(tr('room.rules.ownRes.noGpu'), /GPU/)
})
