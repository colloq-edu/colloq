/**
 * «На экране»: у решения, которое видит класс, есть автор.
 *
 * «Показать классу» переписывало текст общей ячейки чужим решением от имени
 * преподавателя. Заготовка исчезала у всех, в истории документа автором правки
 * значился ведущий, отката не было, а на экране ничто не говорило, что это
 * чьё-то решение: ни имени, ни чипа, ни строки в событиях занятия. Проекторная
 * полоса при этом считала сдавших, будто показа не было вовсе, а ручка «имена
 * на проекторе» лежала в документе мёртвым полем.
 *
 * Теперь показ — приставка к той же ячейке: подписанная плашка под ней у ВСЕХ
 * (кадр `council:shown`), текст ячейки не трогается, снимается одним нажатием.
 * Здесь проверяется разметка этого обещания — тем же приёмом, что в
 * `council-sheet-craft` и `panels-craft`: шаблон читается, а не рисуется.
 */
import fs from 'node:fs'
import path from 'node:path'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { translate } from '../shared/i18n.js'

function read(rel: string): string {
  return fs.readFileSync(path.resolve(import.meta.dirname, '..', rel), 'utf8')
}

/** Разметка без комментариев: объяснение — не обещание. */
function code(source: string): string {
  return source.replace(/<!--[\s\S]*?-->/g, '').replace(/\/\*[\s\S]*?\*\//g, '')
}

const BLOCK = code(read('web/src/components/council/CouncilOnScreen.svelte'))
const CELL = code(read('web/src/components/notebook/CellView.svelte'))
const SCREEN = code(read('web/src/screens/SessionScreen.svelte'))
const COUNCIL = code(read('web/src/lib/council.svelte.ts'))

/** Свой лист студента — от `{#if ownSheet && sheet}` до общей ветки редактора. */
const SHEET = CELL.slice(CELL.indexOf('{#if ownSheet && sheet}'), CELL.indexOf('{:else if showEditor}'))

/* --------------------------------------------------------------- плашка */

test('плашка подписана: чип, автор, кто показал и когда', () => {
  // Полоса одна на весь блок и цвета positive: это один объект — подпись, код
  // и вывод, — а не три соседних.
  assert.match(BLOCK, /class="border-l-4 border-positive"/)
  assert.match(BLOCK, /tr\('room\.ui\.52'\)/, 'чипа «на экране» нет')
  assert.match(BLOCK, /<Avatar name=\{shown\.name\}/, 'автор без лица')
  assert.match(BLOCK, /\{shown\.name\}<\/span>/, 'имени автора в плашке нет')
  assert.match(BLOCK, /tr\('room\.ui\.1256'\)/, 'не сказано, кто показал')
  assert.match(BLOCK, /clock\(shown\.shownAt\)/, 'не сказано, когда показали')
  assert.match(translate('ru', 'room.ui.1256'), /^показал преподаватель$/)
  // Время — только настоящее: у показа, начатого до того, как его стали
  // подписывать, его нет, и выдуманный час хуже молчания.
  assert.match(BLOCK, /shown\.shownAt !== null/)
})

test('код показанной попытки — той же плитой, что и везде, и только чтением', () => {
  assert.match(BLOCK, /import Code from '@\/components\/ui\/Code\.svelte'/)
  assert.match(BLOCK, /<Code code=\{shown\.text\} \/>/)
  // Редактора здесь нет и быть не может: чужую попытку не правят.
  assert.doesNotMatch(BLOCK, /CodeEditor/)
})

test('вывод под плашкой — преподавательский, под волосяной линией и подписан', () => {
  assert.match(BLOCK, /\{#if shown\.run\}/)
  assert.match(BLOCK, /<CellOutputs outputs=\{shown\.run\.outputs\} \/>/)
  assert.match(BLOCK, /border-top-color="rgb\(var\(--line\)\)"/, 'линии между кодом и выводом нет')
  assert.match(BLOCK, /tr\('room\.ui\.61'\)/, 'вывод не подписан запуском преподавателя')
  assert.match(BLOCK, /spell\(shown\.run\.ranMs\)/, 'у запуска нет длительности')
  assert.match(translate('ru', 'room.ui.61'), /^запускал преподаватель$/)
})

test('«убрать с экрана» есть только у того, кто вправе нажать', () => {
  assert.match(BLOCK, /\{#if mayClear\}/)
  const link = BLOCK.slice(BLOCK.indexOf('{#if mayClear}'), BLOCK.indexOf('{/if}', BLOCK.indexOf('{#if mayClear}')))
  assert.match(link, /tr\('room\.ui\.1254'\)/)
  assert.match(link, /onclick=\{\(\) => onclear\?\.\(\)\}/)
  assert.match(translate('ru', 'room.ui.1254'), /^убрать с экрана$/)
})

test('имена выключены — «Вариант N» вместо имени, и лица нет тоже', () => {
  assert.match(BLOCK, /\{#if shown\.name !== null\}/)
  assert.match(BLOCK, /tr\('room\.ui\.1255', \{ p0: shown\.variant \}\)/)
  assert.match(translate('ru', 'room.ui.1255'), /^Вариант \{p0\}$/)
  // Ветка без имени идёт БЕЗ аватара: чужого лица при выключенных именах не
  // бывает, а дырка в строке хуже пустого кружка.
  const nameless = BLOCK.slice(BLOCK.indexOf('{:else}'), BLOCK.indexOf('{/if}', BLOCK.indexOf('{:else}')))
  assert.doesNotMatch(nameless, /<Avatar/)
})

/* ------------------------------------------------------------- в тетради */

test('плашка стоит под своей ячейкой — и у студента, и у преподавателя', () => {
  assert.match(CELL, /import CouncilOnScreen from '@\/components\/council\/CouncilOnScreen\.svelte'/)
  // У студента — внутри своего листа, ПОСЛЕ писем преподавателя и до подвала.
  assert.match(SHEET, /<CouncilOnScreen shown=\{onScreen\} \/>/)
  assert.ok(
    SHEET.indexOf('councilLetters') < SHEET.indexOf('<CouncilOnScreen') ||
      SHEET.indexOf('letters as letter') < SHEET.indexOf('<CouncilOnScreen'),
    'плашка встала выше писем преподавателя',
  )
  assert.ok(
    SHEET.indexOf('<CouncilOnScreen') < SHEET.indexOf('{#if restoreAsking}'),
    'плашка уехала ниже подвала',
  )
  // У преподавателя — под стопкой, и с ссылкой «убрать с экрана».
  const stack = CELL.slice(CELL.indexOf('<CouncilStack'))
  assert.match(stack, /\{#if leads && showsOnScreen && onScreen\}/)
  assert.match(stack, /mayClear\s+onclear=\{\(\) => session\.council\.clearShown\(id\)\}/)
})

test('автору второй плашки нет: у него горит «ваш вариант на экране»', () => {
  assert.match(
    CELL,
    /const showsOnScreen = \$derived\(\s*inCouncil && onScreen !== null && onScreen\.participantId !== session\.me\.id,\s*\)/,
  )
  // Зелёный чип автора остаётся на своём месте, в подвале листа.
  assert.match(SHEET, /\{#if mine\?\.shown\}/)
  assert.match(SHEET, /tr\('room\.ui\.1227'\)/)
  assert.match(translate('ru', 'room.ui.1227'), /Ваш вариант на экране/)
})

test('снятая плашка сворачивается высотой, а под reduced-motion — мгновенно', () => {
  const folds = CELL.match(/transition:slide=\{\{ duration: prefersReducedMotion\(\) \? 0 : 200/g) ?? []
  assert.equal(folds.length, 2, 'складка не у обеих плашек (студент и преподаватель)')
  assert.match(CELL, /import \{ slide \} from 'svelte\/transition'/)
})

/* ------------------------------------------------------------- проектор */

test('на проекторе у показанного та же подпись, что в тетради', () => {
  const strip = SCREEN.slice(SCREEN.indexOf('{#each councilsOnAir as council'))
  assert.match(strip, /\{#if council\.shown\}/)
  assert.match(strip, /<Avatar name=\{shown\.name\}/)
  assert.match(strip, /tr\('room\.ui\.1255', \{ p0: shown\.variant \}\)/, 'номера варианта нет')
  assert.match(strip, /tr\('room\.ui\.1256'\)/, 'не сказано, кто показал')
  assert.match(strip, /clock\(shown\.shownAt\)/)
  assert.match(strip, /\{shown\.text\}<\/pre>/, 'кода на проекторе нет')
  assert.match(strip, /shownOutputLines\(council\.shown\.run\)/, 'вывода на проекторе нет')
  // А пока не показывают — счёт и полоса, как было.
  assert.match(strip, /countLine\(council\.count\)/)
  assert.match(strip, /scaleX\(/)
})

test('вывод на проекторе — строками текста, без картинок и без хвоста', () => {
  assert.match(COUNCIL, /export function shownOutputLines\(/)
  const fn = COUNCIL.slice(COUNCIL.indexOf('export function shownOutputLines('))
  assert.match(fn, /lines\.slice\(0, limit\)/)
  assert.match(fn, /output\.data\['text\/plain'\]/)
  // Картинки в ленту внизу экрана не едут вовсе.
  assert.doesNotMatch(fn.slice(0, fn.indexOf('\n}')), /image\//)
})

/* ------------------------------------------------------------- ручка имён */

test('ручка «имена на проекторе» вернулась в меню замка — вместе с исполнением', () => {
  assert.match(CELL, /function setNamesOnProjector\(namesOnProjector: boolean\): void/)
  assert.match(CELL, /session\.council\.lock\(id, 'council', \{ namesOnProjector \}\)/)
  assert.match(CELL, /checked=\{councilSettings\.namesOnProjector\}/)
  assert.match(CELL, /tr\('room\.ui\.1258'\)/)
  assert.match(translate('ru', 'room.ui.1258'), /^Имена на проекторе$/)
})

test('переспрос о показе больше не обещает подмены текста', () => {
  for (const key of ['room.confirm.showNamed', 'room.confirm.showAnswer']) {
    for (const locale of ['ru', 'en'] as const) {
      const text = translate(locale, key)
      assert.doesNotMatch(text, /заменит|replace/i, `${key} (${locale}) обещает подмену`)
    }
  }
  assert.match(translate('ru', 'room.confirm.showNamed'), /плашкой под ячейкой/)
})
