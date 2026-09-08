/**
 * Отступ в ячейке и в файле: Tab, его размер и что именно он двигает.
 *
 * Своего Tab у CodeMirror нет — нажатие достаётся браузеру, и фокус уезжает из
 * ячейки на ближайшую кнопку тулбара. В тетради, где пишут Python, это значит,
 * что отступ набрать нечем: набранное после Tab уходит мимо кода, а человек
 * видит только, что «таб не работает».
 *
 * Готовый `indentWithTab` из комплекта CodeMirror эту дырку закрывает не тем:
 * он двигает СТРОКУ ЦЕЛИКОМ. Tab, нажатый посреди набранной строки, уносил
 * вправо всё, что уже написано, — то есть вместо отступа получалось
 * перестроение чужого кода. Нужен мягкий таб: пробелы в курсор, до следующей
 * отметки; строки целиком двигают выделение и Shift-Tab.
 *
 * И размер. Без `indentUnit` CodeMirror берёт свои два пробела: Enter после
 * `def f():` отбивал два, а код из файла или из ответа оракула приходил на
 * четырёх, и в одной функции оказывалось два разных отступа — IndentationError
 * в месте, которое глазами не отличить.
 *
 * Правило одно на два редактора (lib/indent.ts) как раз потому, что уже
 * расходилось: в файле биндинг был, в ячейке — нет. Чистая половина проверяется
 * вызовами, привязка — чтением компонентов, как в panels-craft. Живьём (Chrome
 * по CDP) проверено, что Tab не двигает строку, Shift-Tab снимает отступ, фокус
 * остаётся в ячейке, а на выделении двигаются все строки.
 */
import './_env.mts'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { INDENT, columnOf, tabInsert } from '../web/src/lib/indent.js'

function read(rel: string): string {
  return fs.readFileSync(path.resolve(import.meta.dirname, '..', rel), 'utf8')
}

/** Без комментариев: объяснение — не обещание. */
function code(source: string): string {
  return source.replace(/<!--[\s\S]*?-->/g, '').replace(/\/\*[\s\S]*?\*\//g, '')
}

const CELL_EDITOR = code(read('web/src/components/notebook/CodeEditor.svelte'))
const FILE_EDITOR = code(read('web/src/components/editor/FileEditor.svelte'))

/* ----------------------------------------------------------------- правило */

test('отступ — четыре пробела', () => {
  assert.equal(INDENT, '    ')
})

test('на пустом месте Tab отбивает целый отступ', () => {
  assert.equal(tabInsert('', 4), '    ')
  assert.equal(tabInsert('    ', 4), '    ')
  assert.equal(tabInsert('def f():', 4), '    ')
})

test('посреди строки Tab добивает до следующей отметки, а не отбивает четыре', () => {
  // `x=` — вторая колонка: до отметки два пробела, а не четыре.
  assert.equal(tabInsert('x=', 4), '  ')
  assert.equal(tabInsert('    return', 4), '  ')
  assert.equal(tabInsert('a', 4), '   ')
})

test('чужой таб в строке считается до отметки, а не за один знак', () => {
  // Своих табов редакторы не ставят, но вставить чужой текст никто не мешает.
  assert.equal(columnOf('\t', 4), 4)
  assert.equal(columnOf('ab\t', 4), 4)
  assert.equal(columnOf('\tx', 4), 5)
  assert.equal(tabInsert('\t', 4), '    ')
})

test('размер таба в документе не меняет размера отступа', () => {
  // tabSize — это ШИРИНА чужого таба на экране; отбиваем всё равно свои четыре.
  assert.equal(tabInsert('', 8), '    ')
  assert.equal(columnOf('\t', 8), 8)
})

/* --------------------------------------------------------------- редакторы */

test('оба редактора вешают на Tab общее правило, а не indentWithTab', () => {
  for (const [what, source] of [
    ['ячейка', CELL_EDITOR],
    ['файл', FILE_EDITOR],
  ] as const) {
    assert.match(source, /keymap\.of\(\[\s*tabKey\(\{/, `${what}: Tab отдан браузеру`)
    assert.doesNotMatch(source, /indentWithTab/, `${what}: вернулся сдвиг строки целиком`)
    // Строки целиком двигают выделение и Shift-Tab — обе команды правилу нужны.
    assert.match(source, /indentMore: cm\.commands\.indentMore/, `${what}: нечем двигать строки`)
    assert.match(source, /indentLess: cm\.commands\.indentLess/, `${what}: нечем снимать отступ`)
  }
})

test('размер отступа в обоих редакторах — один и тот же, из общего правила', () => {
  assert.match(CELL_EDITOR, /indentUnit\.of\(INDENT\)/, 'ячейка вернулась к двум пробелам')
  assert.match(FILE_EDITOR, /indentUnit\.of\(INDENT\)/, 'файл вернулся к двум пробелам')
})

test('Tab стоит последним и потому проигрывает тем, кто его уже занял', () => {
  for (const [what, source] of [
    ['ячейка', CELL_EDITOR],
    ['файл', FILE_EDITOR],
  ] as const) {
    const general = source.indexOf('cm.commands.defaultKeymap')
    const tab = source.indexOf('tabKey({')
    assert.ok(general > 0 && tab > 0, `${what}: одного из двух keymap нет вовсе`)
    // Раньше в списке — старше: подсказчик и командные клавиши забирают Tab
    // первыми, отступ достаётся тому нажатию, которое никому больше не нужно.
    assert.ok(tab > general, `${what}: отступ обошёл по старшинству общие клавиши`)
  }
})

test('выйти из ячейки есть чем и без Tab', () => {
  // Ловушка для клавиатуры — цена отступа, и расплачивается за неё Escape:
  // он уводит в командный режим и стоит выше по старшинству (Prec.highest).
  assert.match(CELL_EDITOR, /key: 'Escape'/)
  assert.match(CELL_EDITOR, /handlers\.onescape/)
})
