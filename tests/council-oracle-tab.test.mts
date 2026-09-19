/**
 * Вкладка оракула о классе — обещания разметки, которых не видно из типов.
 *
 * Четыре из них ломаются молча, и каждое стоило бы паре отдельной жалобы.
 *
 * Панель ввода вне прокрутки: спросить можно, только если поле под рукой, а не
 * в конце ленты, которую сперва надо промотать. Стоит ей уехать внутрь области
 * прокрутки — и в окне 900×650 её не будет видно ровно после второго ответа.
 *
 * Пустое состояние больше НЕ говорит «ждём сданных работ». В этом и была
 * жалоба с живого семинара 19.09: на десятой минуте половина класса ещё пишет,
 * двое застряли, а вкладка предлагает подождать.
 *
 * Метка человека — кнопка, а не жирный текст: на неё нажимают, чтобы открыть
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
  assert.match(empty, /ask\.noSheets/, 'нет случая «в ячейке вообще нет листов»')
  assert.match(empty, /attempts\.length === 0/, 'пустота считается по сдачам, а не по листам')
  // Пусто — это «нет ни ответов, ни сводки, и никто сейчас не читает».
  assert.match(TAB, /const empty = \$derived\(\s*answers\.length === 0 && pending === null && !hasSummary/)
})

test('быстрый чип «Сводка по решениям» гаснет без сдач и говорит почему', () => {
  const chip = TAB.slice(TAB.indexOf('onclick={askSummary}') - 400, TAB.indexOf('onclick={askSummary}'))
  assert.match(chip, /disabled=\{!canSend \|\| submitted === 0\}/)
  assert.match(chip, /title=\{submitted === 0 \? tr\('room\.pult\.v2\.oracle\.ask\.summaryWhy'\)/)
  // И сам он шлёт запрос БЕЗ вопроса — это и отличает сводку от разговора.
  assert.match(TAB, /function askSummary\(\)[\s\S]{0,200}onask\(\)/)
})

test('метка в ответе — кнопка, открывающая работу; без имён подписана вариантом', () => {
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
