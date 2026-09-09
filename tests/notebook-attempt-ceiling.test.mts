import { translate, tr } from '../shared/i18n.js'
/**
 * Потолок попытки консилиума глазами тетради: лист, счётчик и «сдано».
 *
 * Чистая половина потолка — число в shared и три функции в council.svelte.ts —
 * проверена в tests/weblib-council-limit.test.mts. Здесь вторая половина, та,
 * что на экране: редактор листа знает потолок и отказывает ВСТАВКЕ (а не
 * набору), «Сдать» не отправляет то, чего у сервера нет, и «сдано» не рисуется
 * под текстом, который до сервера не доехал.
 *
 * Читается прямо из компонентов, как в panels-craft: тест со своей копией
 * правила проходит вечно, пока файл уезжает.
 */
import './_env.mts'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { changeFits } from '../web/src/components/notebook/cell-paste.js'
import { MAX_ATTEMPT_CHARS } from '../shared/notebook.js'

function read(rel: string): string {
  return fs.readFileSync(path.resolve(import.meta.dirname, '..', rel), 'utf8')
}

const CELL = read('web/src/components/notebook/CellView.svelte')
const EDITOR = read('web/src/components/notebook/CodeEditor.svelte')

/* ------------------------------------------------------------- правило */

test('набор руками потолок не запрещает, а вставку сверх него — да', () => {
  const ceiling = MAX_ATTEMPT_CHARS
  // Ровно потолок влезает — и вставкой тоже.
  assert.equal(changeFits({ chars: ceiling, ceiling, pasted: true }), true)
  // Буква сверх потолка: набравший её видит счётчик и сам решает, что резать.
  assert.equal(changeFits({ chars: ceiling + 1, ceiling, pasted: false }), true)
  // Двенадцать тысяч знаков одним движением — вот этому отказ.
  assert.equal(changeFits({ chars: 12_400, ceiling, pasted: true }), false)
})

test('там, где потолка нет, не отказывают ничему', () => {
  assert.equal(changeFits({ chars: 1_000_000, ceiling: null, pasted: true }), true)
})

/* --------------------------------------------------------------- редактор */

test('фильтр редактора отказывает только пользовательской вставке', () => {
  const at = EDITOR.indexOf('EditorState.changeFilter.of')
  assert.ok(at > 0, 'фильтра нет вовсе')
  const filter = EDITOR.slice(at, at + 500)
  // Вставкой считаются ровно два события. У транзакций, которыми y-codemirror
  // применяет правки Y.Text (чужие и наши SEED), userEvent нет вовсе — отказ им
  // развёл бы редактор с документом.
  assert.match(filter, /isUserEvent\('input\.paste'\)/)
  assert.match(filter, /isUserEvent\('input\.drop'\)/)
  assert.match(filter, /changeFits\(\{ chars: tr\.newDoc\.length, ceiling, pasted \}\)/)
  // Отказ не молчит: у отказавшей вставки есть слова.
  assert.match(filter, /handlers\.onoverflow\?\.\(tr\.newDoc\.length\)/)
})

test('потолок редактору называет лист, и берёт он его из общей земли', () => {
  assert.match(CELL, /import \{[\s\S]*?MAX_ATTEMPT_CHARS,[\s\S]*?\} from '@shared\/notebook'/)
  const at = CELL.indexOf("label={tr('room.extra.132'")
  assert.ok(at > 0, 'своего листа в тетради больше нет')
  const sheet = CELL.slice(at, at + 900)
  assert.match(sheet, /maxChars=\{MAX_ATTEMPT_CHARS\}/, 'лист не знает потолка')
  assert.match(sheet, /onoverflow=\{/, 'отказавшая вставка молчит')
})

/* ------------------------------------------------------- счётчик и «сдано» */

test('про потолок говорит счётчик под листом, а не тост на каждую паузу', () => {
  // Снимок отдаётся очереди как есть: сверх потолка его не берёт `draft`
  // (council.svelte.ts), и никакого отказа на каждую паузу в наборе тут нет.
  assert.match(CELL, /session\.council\.draft\(id, sheetText\)/)
  assert.match(CELL, /const attemptCount = \$derived\(attemptCounter\(sheetText\.length\)\)/)
  assert.match(CELL, /const attemptOver = \$derived\(attemptTooLong\(sheetText\)\)/)
  assert.match(CELL, /\{#if attemptCount\}/, 'счётчика под листом нет')
})

test('«Сдать» не отправляет то, чего у сервера нет', () => {
  const at = CELL.indexOf('function submitAttempt()')
  const submit = CELL.slice(at, CELL.indexOf('function withdrawAttempt', at))
  assert.match(submit, /if \(attemptOver\) \{/, 'сдача сверх потолка уходит молча')
  assert.match(submit, /session\.showError\(/, 'отказ без слов')
  // Отказ раньше отправки: иначе сдан был бы прошлый, короткий снимок.
  assert.ok(
    submit.indexOf('if (attemptOver)') < submit.indexOf('session.council.submit(id)'),
    'проверка стоит после отправки — она ничего не спасает',
  )
})

test('«сдано» не рисуется под текстом, которого у преподавателя нет', () => {
  assert.match(CELL, /const attemptSynced = \$derived\(attemptInSync\(mine, sheetText\)\)/)
  const at = CELL.indexOf('{:else if submittedAt !== null')
  const line = CELL.slice(at, at + 700)
  assert.match(line, /submittedAt !== null && !attemptSynced/, 'расхождение не различается')
  // Ветка расхождения идёт ПЕРВОЙ: иначе «сдано» перехватит её всегда.
  assert.ok(
    line.indexOf('!attemptSynced') < line.indexOf("tr('room.ui.50')"),
    '«сдано» стоит раньше проверки и выигрывает у неё',
  )
  assert.match(line, /tr\('room\.ui\.351'\)/, 'словам о расхождении нечего сказать')
  assert.match(translate('ru', 'room.ui.351'), /После сдачи текст изменился/)
})
