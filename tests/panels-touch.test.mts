/**
 * Вход с пальца и с клавиатуры — там, где его до сих пор не было.
 *
 * `future.hoverOnlyWhenSupported` (tailwind.config.js) заворачивает каждую
 * `hover:` утилиту в `@media (hover: hover)`, и это правильно: тап на iPad
 * больше не оставляет «наведённую» кнопку висеть до следующего касания. Но у
 * флага есть цена — там, где hover был ЕДИНСТВЕННЫМ входом, с пальца теперь не
 * добраться вовсе. Здесь проверяется, что второй путь есть.
 *
 * И обратная сторона того же разговора: действие с клавиатуры анимировать
 * нельзя. Escape жмут затем, чтобы панель УБРАТЬ, а не чтобы посмотреть, как
 * она уезжает.
 *
 * Читается прямо из компонентов, как в `panels-craft.test.mts`: тест со своей
 * копией правила проходит вечно, пока файл уезжает.
 */
import fs from 'node:fs'
import path from 'node:path'
import { test } from 'node:test'
import assert from 'node:assert/strict'

function read(rel: string): string {
  return fs.readFileSync(path.resolve(import.meta.dirname, '..', rel), 'utf8')
}

/** Разметка без комментариев: объяснение — не обещание. */
function code(source: string): string {
  return source.replace(/<!--[\s\S]*?-->/g, '').replace(/\/\*[\s\S]*?\*\//g, '')
}

const FILES = 'web/src/components/panels/FilesPanel.svelte'
const BAN = 'web/src/components/panels/BanMenu.svelte'
const AI = 'web/src/components/panels/AiPanel.svelte'
const SESSION = 'web/src/screens/SessionScreen.svelte'
const TAILWIND = 'web/tailwind.config.js'

/* ------------------------------------------------------------------ палец */

test('флаг hover-гейта стоит: без него проверять второй путь незачем', () => {
  assert.match(code(read(TAILWIND)), /hoverOnlyWhenSupported:\s*true/)
})

/** Место, где раньше лежала полоса из трёх значков, а теперь стоит «⋯». */
function laneOf(files: string): string {
  const at = files.indexOf('absolute inset-y-0 right-0 flex items-center')
  assert.ok(at > 0, 'полоса действий в строке дерева не нашлась')
  return files.slice(at)
}

test('действия строки дерева открываются не только наведением', () => {
  const files = code(read(FILES))
  // Наведение осталось указателю, выделенная строка — пальцу; тот же ответ,
  // что у тулбара ячейки (CellView · `selected && opacity-100`).
  const lane = laneOf(files)
  assert.match(lane, /group-hover:opacity-100/, 'указателю — по наведению')
  assert.match(lane, /group-focus-within:opacity-100/, 'клавиатуре — по фокусу')
  assert.match(lane, /picked === entry\.path \? 'opacity-100'/, 'пальцу — по выделенной строке')

  // И выделяет строку то же нажатие, которым её открывают: отдельного жеста
  // «выделить» в дереве нет.
  assert.match(files, /let picked = \$state<string \| null>\(null\)/)
  assert.match(
    files.slice(files.indexOf('function pick(entry: FileEntry')),
    /picked = entry\.path/,
    'нажатие по имени выделяет строку',
  )
  assert.match(
    files.slice(files.indexOf('function toggle(path: string)'), files.indexOf('function pick(')),
    /picked = path/,
    'нажатие по стрелке папки — тоже',
  )
})

test('невидимая кнопка меню не ловит тап по правому краю строки', () => {
  const files = code(read(FILES))
  const lane = laneOf(files)
  // Кнопка лежит поверх размера файла: с `opacity-0`, но без этой строки
  // невидимая «⋯» принимала нажатие вместо строки под ней.
  assert.match(lane, /pointer-events-none opacity-0/, 'пока не видно — не нажимается')
  assert.match(lane, /group-hover:pointer-events-auto/)
  assert.match(lane, /group-focus-within:pointer-events-auto/)
})

test('в строке дерева одна кнопка «⋯», а не полоса значков', () => {
  /*
   * Полоса из трёх значков (строка для ячейки, скачать, убрать) занимала место
   * размера файла, умела ровно три вещи и на планшете доставалась только
   * выделенной строке. Всё, что она умела, ушло в меню; в строке осталась одна
   * кнопка, и четвёртое действие больше не требует от строки высотой 26
   * пикселей четвёртого значка.
   */
  const files = code(read(FILES))
  const lane = laneOf(files)
  const row = lane.slice(0, lane.indexOf('</span>'))
  assert.equal(
    [...row.matchAll(/<button/g)].length,
    1,
    'в полосе больше одной кнопки — полоса значков вернулась',
  )
  assert.match(row, /data-menu-button/, 'кнопка не помечена как открывающая меню')
  assert.match(row, /aria-haspopup="menu"/)
  assert.match(row, /name="more"/)
  // И ни одного прежнего значка: они обязаны жить только пунктами меню.
  for (const gone of ['name="trash"', 'name="download"', 'name="copy"']) {
    assert.ok(!row.includes(gone), `${gone} остался в строке вместо меню`)
  }
})

test('цель «⋯» под палец — сорок пикселей, а рисунок остаётся мелким', () => {
  // `after:-inset-2` растит зону нажатия на восемь пикселей с каждой стороны:
  // 24 + 16 = 40, и ни один пиксель раскладки при этом не двигается.
  const lane = laneOf(code(read(FILES)))
  const row = lane.slice(0, lane.indexOf('</span>'))
  assert.match(row, /h-6 w-6/, 'рисунок перестал быть 24×24')
  assert.match(row, /after:absolute after:-inset-2/, 'цель под палец не выросла')
})

test('на телефоне меню строки открывается долгим нажатием', () => {
  /*
   * Правой кнопки на телефоне нет вовсе, а «⋯» требует сперва попасть по
   * строке и только потом по значку. Без таймера на iOS меню не открывалось бы
   * ничем: `contextmenu` там не приходит.
   */
  const files = code(read(FILES))
  assert.match(files, /onpointerdown=\{\(event\) => onRowPointerDown\(event, entry\)\}/)
  const hold = files.slice(
    files.indexOf('function onRowPointerDown'),
    files.indexOf('function onRowPointerMove'),
  )
  assert.match(hold, /event\.pointerType !== 'touch'/, 'долгое нажатие ловится не только пальцем')
  assert.match(hold, /\}, 500\)/, 'планка долгого нажатия уехала с полусекунды')
  // Палец поехал — это прокрутка, а не нажатие.
  assert.match(
    files.slice(files.indexOf('function onRowPointerMove')),
    /endHold\(\)/,
    'движение пальца не отменяет долгое нажатие',
  )
  // И `click`, приходящий следом за долгим нажатием, не открывает файл.
  assert.match(files.slice(files.indexOf('function pick(entry: FileEntry')), /if \(heldOpen\)/)
})

test('меню строки открывается и с клавиатуры: Shift+F10 и клавиша «меню»', () => {
  const files = code(read(FILES))
  const keys = files.slice(
    files.indexOf('function onRowKeydown'),
    files.indexOf('function step('),
  )
  assert.match(keys, /event\.key === 'ContextMenu'/)
  assert.match(keys, /event\.key === 'F10' && event\.shiftKey/)
  assert.match(keys, /event\.key === 'F2'/, 'F2 не переименовывает')
  assert.match(keys, /'Delete' \|\| event\.key === 'Backspace'/, 'Delete не удаляет')
  assert.match(keys, /ArrowDown/, 'стрелки не ходят по строкам')
  // Обработчик висит на самой кнопке имени — том элементе, который получает фокус.
  assert.match(files, /onkeydown=\{\(event\) => onRowKeydown\(event, entry\)\}/)
  assert.match(files, /data-row-name/)
})

/* ------------------------------------------------------------- клавиатура */

test('меню бана и его окно уходят мгновенно: их закрывают Escape’ом', () => {
  const ban = code(read(BAN))
  // `transition:` двусторонняя — уход анимировался тоже, и Escape уводил
  // панель за 120 мс. То же решение, что у ящиков SessionScreen и словами в
  // admin/motion.css: exit is the one thing that must not exist.
  assert.doesNotMatch(ban, /transition:(fly|fade)/, 'двусторонних директив не осталось')
  assert.match(ban, /in:fly=/, 'вход у меню есть')
  assert.match(ban, /in:fade=/, 'и у подложки окна')
})

test('меню бана движется домашней кривой, а не svelte’овой', () => {
  const ban = read(BAN)
  // `--ease-out` = cubic-bezier(0.23, 1, 0.32, 1) (index.css); ближайшее из
  // svelte/easing — quintOut (1−(1−t)⁵). cubicOut заметно мягче и читается
  // как чужая среди всего остального движения продукта.
  assert.doesNotMatch(code(ban), /cubicOut/)
  assert.match(ban, /import \{ quintOut \} from 'svelte\/easing'/)
})

test('«Спросить оракула» с клавиатуры целится в само поле, а не в панель', () => {
  const ai = code(read(AI))
  const composer = ai.slice(ai.indexOf('<textarea'), ai.indexOf('</textarea>'))
  assert.match(composer, /bind:this=\{composer\}/, 'нашли строку ввода оракула')
  assert.match(composer, /data-oracle-composer/, 'и метку на ней самой')

  // Договор с другой стороны: ⌘/Ctrl+I и строка палитры ищут эту метку.
  // Запасной путь по панели держится на том, что textarea в ней ровно одна, —
  // метка на поле развязывает клавишу и вёрстку чужой панели.
  assert.match(code(read(SESSION)), /\[data-oracle-composer\]/)
})
