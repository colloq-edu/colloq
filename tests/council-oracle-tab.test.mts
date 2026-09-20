/**
 * Вкладка оракула о классе — обещания разметки, которых не видно из типов.
 *
 * Пять из них ломаются молча, и каждое стоило бы паре отдельной жалобы.
 *
 * Панель ввода вне прокрутки: спросить можно, только если поле под рукой, а не
 * в конце ленты, которую сперва надо промотать. Стоит ей уехать внутрь области
 * прокрутки — и в окне 900×650 её не будет видно ровно после второго ответа.
 *
 * Пустое состояние НЕ говорит «ждём сданных работ» и НЕ ставит условий: с
 * 20.09 спросить можно всегда, в том числе на ячейке, где не написано ещё ни
 * строки. Ждать сдач, чтобы спросить «что это за задание», — и была жалоба.
 *
 * Отказ остаётся в ленте вместе со своим вопросом: иначе повторить нечего.
 *
 * Подпись человека — кнопка, а не жирный текст: на неё нажимают, чтобы открыть
 * работу. И подпись у неё двойная: имя, когда имена включены, «Вариант N»,
 * когда выключены. Одна забытая ветка здесь — это имя студента в окне, где
 * преподаватель нарочно выключил имена.
 *
 * Разметка читается из компонента, как в council-pult-craft.test.mts.
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

const TAB = code(read('web/src/components/council/pult/PultOracleTab.svelte'))
const WINDOW = code(read('web/src/components/council/pult/PultWindow.svelte'))

test('панель ввода стоит вне области прокрутки — её видно всегда', () => {
  const body = TAB.indexOf('<div class="oracle-body"')
  const ask = TAB.indexOf('<footer class="oracle-ask"')
  assert.ok(body > 0 && ask > body, 'панели ввода нет или она выше тела')
  // Между концом тела и панелью — только закрывающий тег: панель ей не вложена.
  assert.match(TAB.slice(TAB.indexOf('</div>', TAB.lastIndexOf('{/if}', ask)), ask), /^<\/div>\s*$/)
  assert.match(TAB, /\.oracle-body \{[^}]*overflow-y: auto/, 'тело не прокручивается')
  assert.match(TAB, /\.oracle-ask \{[^}]*flex-shrink: 0/, 'панель ввода сжимается вместе с лентой')
})

test('пустое состояние зовёт спрашивать, а не ждать сданных работ', () => {
  const empty = TAB.slice(TAB.indexOf('{#if empty}'), TAB.indexOf('{#if answers.length > 0'))
  assert.ok(empty.length > 0, 'пустого состояния нет вовсе')
  assert.ok(!empty.includes('noSubmissions'), 'вкладка снова просит дождаться сдач')
  assert.ok(!empty.includes('noSheets'), 'вкладка снова ставит условие «нужен хотя бы лист»')
  assert.match(empty, /ask\.emptyHint/)
  // Пусто — это «ни одного хода в ленте, и никто сейчас не читает». Сводки по
  // группам здесь больше нет, и условия «дождитесь сдач» — тоже.
  assert.match(TAB, /const empty = \$derived\(answers\.length === 0 && pending === null\)/)
})

test('ни одного быстрого вопроса не ждёт сдач: спрашивать можно всегда', () => {
  const quick = TAB.slice(TAB.indexOf('<div class="quick-row">'), TAB.indexOf('<div class="ask-field">'))
  assert.match(quick, /disabled=\{!canSend\}/)
  assert.ok(!quick.includes('submitted === 0'), 'чип снова гаснет без сдач')
  assert.ok(!TAB.includes('summaryWhy'), 'в разметке осталось объяснение «дождитесь сдачи»')
  // `room.pult.v2.oracle.drafts` в шапке — это «сколько ещё пишут», а не
  // черновик письма группе: групповых остались только эти два имени.
  assert.ok(!TAB.includes('groupLabels') && !TAB.includes('oracle.drafts['), 'группы вернулись')
  assert.ok(!TAB.includes('summary'), 'сводка по группам вернулась во вкладку')
})

test('неудача видна в ленте вместе со своим вопросом', () => {
  const thread = TAB.slice(TAB.indexOf('{#each answers as answer'), TAB.indexOf('{#if pending}'))
  assert.match(thread, /class="turn-question"/, 'вопрос исчезает при отказе')
  assert.match(thread, /\{#if answer\.failed\}/)
  assert.match(thread, /\{answer\.failed\}/)
  // И повторить его можно тем же нажатием, ничего не перепечатывая.
  assert.match(thread, /onclick=\{\(\) => ask\(answer\.question\)\}/)
})

test('уровень размышлений стоит у поля и помнится в браузере', () => {
  assert.match(TAB, /data-pult-oracle-effort/)
  assert.match(TAB, /rememberedEffort\(\)/, 'выбор не восстанавливается при открытии пульта')
  assert.match(TAB, /rememberEffort\(effort\)/, 'выбор не запоминается')
  // «Как на инстансе» возвращается повторным нажатием: иначе снять его нечем.
  assert.match(TAB, /effort = effort === next \? null : next/)
  // И уезжает он вместе с вопросом, а не отдельной настройкой.
  assert.match(TAB, /onask\(text, effort \?\? undefined\)/)
})

test('подпись в ответе — кнопка, открывающая работу; без имён подписана вариантом', () => {
  const snippet = TAB.slice(TAB.indexOf('{#snippet answerText'), TAB.indexOf('{/snippet}'))
  assert.match(snippet, /class="answer-person"/)
  assert.match(snippet, /onclick=\{\(\) => onopen\(piece\.participantId\)\}/)
  // Метка, за которой в стопке никого нет, остаётся обычным текстом.
  assert.match(snippet, /\{:else\}\{piece\.label\}/)
  assert.match(
    TAB,
    /if \(names && attempt\.name\.trim\(\)\) return attempt\.name[\s\S]{0,200}tr\('room\.ui\.1255', \{ p0: no \}\)/,
    'подпись чипа не различает включённые и выключенные имена',
  )
  // Открывает — та же функция, что и строка списка: пульт знает одно «открыть».
  assert.match(WINDOW, /<PultOracleTab[\s\S]{0,400}onopen=\{open\}/)
  assert.match(WINDOW, /<PultOracleTab[\s\S]{0,400}\{variants\}/)
})

test('Enter отправляет, Shift+Enter переносит, длина режется на вводе', () => {
  const field = TAB.slice(TAB.indexOf('<textarea class="ask-text"'), TAB.indexOf('</textarea>'))
  assert.match(field, /maxlength=\{MAX_ORACLE_QUESTION\}/, 'потолок длины свой, а не переписанное число')
  assert.match(field, /event\.key !== 'Enter' \|\| event\.shiftKey \|\| event\.isComposing/)
  assert.match(field, /event\.preventDefault\(\)[\s\S]{0,80}sendDraft\(\)/)
  // Во время чтения на месте отправки — «Стоп», и он работает для обоих видов.
  assert.match(TAB, /\{#if reading\}[\s\S]{0,300}onclick=\{onstop\}/)
})
