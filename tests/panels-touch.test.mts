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

test('действия строки дерева открываются не только наведением', () => {
  const files = code(read(FILES))
  // Полоса действий: строка для ячейки, скачать, убрать. Наведение осталось
  // указателю, выделенная строка — пальцу; тот же ответ, что у тулбара ячейки
  // (CellView · `selected && opacity-100`).
  const lane = files.slice(files.indexOf('absolute inset-y-0 right-0 flex items-center gap-0.5'))
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

test('невидимая полоса действий не ловит тап по правому краю строки', () => {
  const files = code(read(FILES))
  const lane = files.slice(files.indexOf('absolute inset-y-0 right-0 flex items-center gap-0.5'))
  // Полоса лежит поверх размера файла: с `opacity-0`, но без этой строки
  // невидимая «Убрать» принимала нажатие вместо строки под ней.
  assert.match(lane, /pointer-events-none opacity-0/, 'пока не видно — не нажимается')
  assert.match(lane, /group-hover:pointer-events-auto/)
  assert.match(lane, /group-focus-within:pointer-events-auto/)
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
