/**
 * Лист консилиума глазами студента: одна ячейка, пять состояний, одна клавиша
 * на сдачу.
 *
 * Каждая проверка здесь — про обещание, которого разметка не держала.
 *
 * Первое — «одна ячейка». Над своим листом стоял общий текст только чтением
 * («Общая ячейка · видна всей группе»), а под листом — вывод ОБЩЕЙ ячейки: у
 * человека, который пишет свой ответ, на экране было два блока кода и два
 * вывода, и который из них его — приходилось решать по подписи.
 *
 * Второе — отметка. `CouncilMine.correct` приезжал автору с первого дня
 * консилиума и не рисовался нигде: преподаватель ставил галочку, она доезжала
 * и умирала в объекте. «Верно» и «есть ошибка» — это то, ради чего попытку и
 * сдают.
 *
 * Третье — клавиши. ⇧↵ на листе СДАВАЛ: запуска у студента тогда не было, и
 * пальцам, привыкшим к «выполнить и дальше», надо было куда-то попадать.
 * Запуск появился (ручка `studentRun`), и ⇧↵ остался сдающим — то есть каждый
 * второй запуск уходил преподавателю насовсем. Сдаёт теперь ровно одно
 * сочетание, и оно нарочно неудобное.
 *
 * Четвёртое — заготовка. Стёртый каркас преподавателя переставало быть где
 * взять: приходилось диктовать вслух.
 *
 * Разметка читается из компонента, как в `panels-craft.test.mts` и
 * `council-stack-craft.test.mts`: тесты про Svelte-шаблон здесь читают
 * шаблон, а не рендерят его.
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

const CELL = code(read('web/src/components/notebook/CellView.svelte'))
const EDITOR = code(read('web/src/components/notebook/CodeEditor.svelte'))

/** Свой лист — от `{#if ownSheet && sheet}` до общей ветки редактора. */
const SHEET = CELL.slice(CELL.indexOf('{#if ownSheet && sheet}'), CELL.indexOf('{:else if showEditor}'))

/* ------------------------------------------------------------ одна ячейка */

test('над листом нет второй ячейки: общий текст студенту не рисуется', () => {
  assert.notEqual(SHEET, '', 'лист вообще есть')
  assert.doesNotMatch(SHEET, /<Code\b/, 'общий код над листом остался')
  assert.doesNotMatch(CELL, /import Code from/, 'компонент импортируется впустую')
  // Ключи «Общая ячейка» и «видна всей группе» жили только в этом блоке: они
  // не должны просто перестать использоваться — их больше нет в каталоге.
  const catalog = read('shared/locales/room.ts')
  assert.doesNotMatch(catalog, /"room\.ui\.347"/)
  assert.doesNotMatch(catalog, /"room\.ui\.348"/)
})

test('вывод общей ячейки у студента в консилиуме не рисуется', () => {
  assert.match(
    CELL,
    /\{#if isCode && !ownSheet && \(outputs\.current\.length > 0 \|\| outputFloor > 0\)\}/,
    'общий вывод остался под своим листом',
  )
  // А свой — рисуется, и ровно один раз: из `attemptRun`, а не из `mine.run`
  // напрямую, иначе стёртый возвратом вывод возвращался бы сам.
  assert.equal(SHEET.match(/<CellOutputs\b/g)?.length, 1, 'вывод попытки рисуется не один раз')
  assert.match(SHEET, /outputs=\{attemptRun\.outputs\}/)
})

/* ---------------------------------------------------------------- клавиши */

test('⇧↵ на листе считает, сдаёт только ⌘⇧↵', () => {
  // В редакторе появилось отдельное сочетание — и только оно зовёт onsubmit.
  assert.match(EDITOR, /\{ key: 'Mod-Shift-Enter', preventDefault: true, run: \(\) => fire\(handlers\.onsubmit\) \}/)
  assert.match(EDITOR, /\{ key: 'Shift-Enter', preventDefault: true, run: \(\) => fire\(handlers\.onrunstep\) \}/)
  assert.match(EDITOR, /\{ key: 'Mod-Enter', preventDefault: true, run: \(\) => fire\(handlers\.onrun\) \}/)
  // На листе ⇧↵ и ⌘↵ ведут в одну функцию запуска, а сдача — в свою.
  assert.match(SHEET, /onrunstep=\{sheetRunKey\}/)
  assert.match(SHEET, /onrun=\{sheetRunKey\}/)
  assert.match(SHEET, /onsubmit=\{submitFromKey\}/)
  // Ни одна клавиша запуска не заведена на сдачу — та самая беда, с которой
  // всё началось.
  assert.doesNotMatch(SHEET, /onrunstep=\{[^}]*submitAttempt/)
  assert.doesNotMatch(SHEET, /onrun=\{[^}]*submitAttempt/)
  // Alt+Enter в листе не делает ничего: обработчик не передан вовсе, а
  // `preventDefault` в биндинге не даёт ему вставить перевод строки.
  assert.doesNotMatch(SHEET, /onrunandadd=/)
  // Сдача с клавиатуры видна: кнопка моргает, потому что «сдано» приезжает
  // эхом сервера и не мгновенно.
  const submit = CELL.slice(CELL.indexOf('function submitFromKey'), CELL.indexOf('function submitFromKey') + 500)
  assert.match(submit, /submitFlash = true/)
})

test('запуск и запрос — одна кнопка и одно ожидание', () => {
  const footer = SHEET.slice(SHEET.indexOf('<span class="ml-auto flex'))
  // Одна кнопка с одним словом на обе ручки — и та же функция, что у клавиши.
  assert.match(footer, /onclick=\{sheetRunKey\}/, 'кнопка и клавиша разошлись')
  assert.equal(footer.match(/tr\('room\.ui\.73'\)/g)?.length, 1, 'кнопок запуска в подвале не одна')
  // Про «запрос» студенту больше не рассказывают: ни кнопкой, ни часами, ни
  // словом «отправляю».
  for (const key of ['363', '362', '1237']) {
    assert.doesNotMatch(footer, new RegExp(`room\\.ui\\.${key}`), `в подвале осталось room.ui.${key}`)
    assert.doesNotMatch(read('shared/locales/room.ts'), new RegExp(`"room\\.ui\\.${key}"`), `ключ ${key} остался в каталоге`)
  }
  // Ожидание одно на обе ручки, и номер в нём — необязательный.
  assert.match(footer, /\{#if runWaiting\}/)
  assert.match(footer, /mine\?\.queue != null\s*\?\s*tr\('room\.ui\.1236', \{ p0: mine\.queue \}\)\s*:\s*tr\('room\.ui\.1260'\)/)
  assert.equal(translate('ru', 'room.ui.1260'), 'В очереди')
  // Отмена рисуется только там, где ей есть что снять: кадра «убрать из
  // очереди ядра» в протоколе нет, `council:run:cancel` снимает запрос.
  assert.match(CELL, /const mayCancelRun = \$derived\(requestPending && mayRequestRun\)/)
  assert.match(footer, /\{#if mayCancelRun\}/)
  assert.match(read('shared/protocol.ts'), /t: 'council:run:cancel'; cellId: string; requestId: string/)
  // Отказ говорит словами и не поминает запрос; разошедшийся текст молчит.
  assert.match(translate('ru', 'room.ui.364'), /^Преподаватель не запустил/)
  assert.doesNotMatch(footer, /room\.ui\.365/, 'о разошедшемся тексте снова говорят')
})

test('у черновика нет чипа, а подсказка под кнопками — только про сдачу', () => {
  const footer = SHEET.slice(SHEET.indexOf('<span class="ml-auto flex'))
  assert.match(footer, /\{#if sheetState !== 'draft'\}/, 'чип рисуется и в черновике')
  const catalog = read('shared/locales/room.ts')
  assert.doesNotMatch(catalog, /"room\.ui\.1223"/, '«Черновик · сохраняется» остался в каталоге')
  assert.doesNotMatch(catalog, /"room\.ui\.1253"/, 'короткий «Черновик» остался в каталоге')
  assert.equal(translate('ru', 'room.ui.357'), '⌘⇧↵ — сдать')
  // Счёт класса при этом остаётся — он в подписи под чипом, а не в подвале.
  const head = SHEET.slice(SHEET.indexOf("tr('room.ui.34')"), SHEET.indexOf('<CodeEditor'))
  assert.match(head, /countLine\(count\)/)
  assert.match(head, /tr\('room\.ui\.1222'\)/)
})

test('при выключенной ручке ⇧↵ не сдаёт, а говорит словами и гаснет', () => {
  const key = CELL.slice(CELL.indexOf('function sheetRunKey'), CELL.indexOf('$effect(() => () => window.clearTimeout(runHintTimer))'))
  assert.match(key, /requestAttemptRun\(\)/, 'по запросу — просит')
  assert.match(key, /runAttempt\(\)/, 'при включённой ручке — считает')
  assert.doesNotMatch(key, /submitAttempt/, 'клавиша запуска сдаёт')
  assert.match(key, /runHint = true/, 'молчит там, где ничего не делает')
  assert.match(CELL, /const RUN_HINT_MS = 2000/)
  assert.match(SHEET, /\{#if runHint\}/)
  assert.match(SHEET, /tr\('room\.ui\.1231'\)/)
  assert.match(translate('ru', 'room.ui.1231'), /запускает преподаватель/)
  // Подсказка стоит у подвала, а не в тосте: тост уезжает в угол экрана.
  assert.doesNotMatch(CELL.slice(CELL.indexOf('function sheetRunKey'), CELL.indexOf('function sheetRunKey') + 600), /showError/)
})

/* --------------------------------------------------------------- отметка */

test('«верно» и «есть ошибка» доходят до автора — цветом, словом и кнопкой', () => {
  const at = CELL.indexOf('const sheetState = $derived(')
  const state = CELL.slice(at, CELL.indexOf('const reviewedAt', at))
  assert.match(state, /mine\?\.correct === true/)
  assert.match(state, /mine\?\.correct === false/)
  // Три таблицы состояния — чип, полоса и слова — обязаны знать одни и те же
  // пять имён: разошлись бы, и состояние без цвета (или без слова) выглядело
  // бы как «ничего не произошло».
  for (const table of ['SHEET_CHIP', 'SHEET_RULE']) {
    const block = CELL.slice(CELL.indexOf(`const ${table} = {`), CELL.indexOf('} as const', CELL.indexOf(`const ${table} = {`)))
    for (const name of ['edited', 'correct', 'wrong', 'submitted', 'draft']) {
      assert.match(block, new RegExp(`\\b${name}:`), `${table} не знает ${name}`)
    }
  }
  // Черновик стоит в обеих таблицах пустой строкой: у него нет ни своего
  // цвета полосы, ни чипа, и обе таблицы обязаны это СКАЗАТЬ, а не умолчать —
  // иначе `SHEET_CHIP[sheetState]` однажды вернёт undefined в класс.
  for (const table of ['SHEET_CHIP', 'SHEET_RULE']) {
    const block = CELL.slice(CELL.indexOf(`const ${table} = {`), CELL.indexOf('} as const', CELL.indexOf(`const ${table} = {`)))
    assert.match(block, /draft: '',/, `${table} даёт черновику своё оформление`)
  }
  assert.match(CELL, /correct: 'border-positive'/)
  assert.match(CELL, /wrong: 'border-danger'/)
  assert.match(SHEET, /tr\('room\.ui\.1225'\)/)
  assert.match(SHEET, /tr\('room\.ui\.1226'\)/)
  assert.match(translate('ru', 'room.ui.1225'), /Верно/)
  assert.match(translate('ru', 'room.ui.1226'), /Есть ошибка/)
  // После «есть ошибки» второстепенная кнопка названа по делу — она ведёт к
  // выходу, а не повторяет беду.
  assert.match(SHEET, /sheetState === 'wrong'\s*\?\s*tr\('room\.ui\.1248'\)/)
  assert.match(translate('ru', 'room.ui.1248'), /Исправить/)
})

test('правка отменённой отметки оставляет её памятью, а не состоянием', () => {
  const at = CELL.indexOf('const sheetState = $derived(')
  const state = CELL.slice(at, CELL.indexOf('const reviewedAt', at))
  assert.match(state, /submittedAt === null && mine\?\.correct != null/, 'снятая отметка не возвращает в набор')
  assert.match(CELL, /edited: ''/, 'полоса правки берёт цвет отметки, которой больше нет')
  assert.match(SHEET, /tr\('room\.ui\.1247'\)/)
  assert.match(translate('ru', 'room.ui.1247'), /было:/)
})

test('у сданной попытки нет кнопок запуска, а текст не приглушён', () => {
  const footer = SHEET.slice(SHEET.indexOf('<span class="ml-auto flex'))
  assert.match(footer, /\{#if submittedAt === null\}[\s\S]*?tr\('room\.ui\.73'\)/, 'запуск не спрятан под сдачей')
  assert.doesNotMatch(SHEET, /opacity-60/, 'сданный код выцвел')
})

/* ---------------------------------------------------------------- подвал */

test('подвал держится одной полосой: счёт в подписи, действия одной группой', () => {
  // Счёт класса — сведение о комнате, и стоит он в шапке рядом с подписью, а
  // не в подвале: там он спорил за место с кнопками, и на узкой колонке вниз
  // уезжали они.
  const head = SHEET.slice(SHEET.indexOf("tr('room.ui.34')"), SHEET.indexOf('<CodeEditor'))
  assert.match(head, /countLine\(count\)/, 'счёт не переехал в шапку')
  const footer = SHEET.slice(SHEET.indexOf('<span class="ml-auto flex'))
  assert.doesNotMatch(footer, /countLine\(count\)/, 'в подвале осталась копия счёта')
  // Чип и кнопки — в одном флексе, который переносится целиком и вправо.
  assert.match(SHEET, /<span class="ml-auto flex flex-wrap items-center justify-end/)
  // И чип ужимается раньше, чем что-нибудь переносится.
  assert.match(SHEET, /tr\(tightFooter \? 'room\.ui\.1252' : 'room\.ui\.1224'/)
  assert.match(CELL, /const tightFooter = \$derived\(footerWidth > 0 && footerWidth < 460\)/)
  assert.match(CELL, /bind:clientWidth=\{footerWidth\}/)
  assert.match(translate('ru', 'room.ui.1252'), /^Сдано \{p0\}$/)
})

test('чужая каретка в общей ячейке не приписывается своему листу', () => {
  const at = CELL.indexOf('const editingHere = $derived.by(')
  const block = CELL.slice(at, at + 400)
  assert.match(block, /if \(ownSheet\) return null/, 'строка присутствия висит под чужим листом')
})

/* ------------------------------------------------------------- заготовка */

test('заготовку преподавателя можно вернуть — с переспросом на месте', () => {
  assert.match(CELL, /function stubText\(\): string \{\s*return mine\?\.seed \?\? liveText\.current/)
  assert.match(CELL, /const mayRestore = \$derived\(mayAttempt && submittedAt === null && sheetText !== stubText\(\)\)/)
  assert.match(SHEET, /onclick=\{\(\) => \(restoreAsking = true\)\}/)
  assert.match(SHEET, /\{#if restoreAsking\}/)
  assert.match(SHEET, /onclick=\{restoreStub\}/)
  assert.match(SHEET, /tr\('room\.ui\.1233'\)/)
  assert.match(SHEET, /tr\('room\.ui\.1234'\)/)
  assert.match(SHEET, /tr\('room\.ui\.1235'\)/)
  assert.match(translate('ru', 'room.ui.1233'), /Вернуть исходную ячейку\?/)
  // Окна браузера здесь нет: ответ виден в самом листе, который заменят.
  const restore = CELL.slice(CELL.indexOf('function restoreStub'), CELL.indexOf('function resubmitAttempt'))
  assert.doesNotMatch(restore, /window\.confirm/)
  // Возврат уезжает на сервер и ложится в отмену: происхождение обычное, а не
  // SEED — иначе у преподавателя остался бы стёртый текст.
  assert.match(restore, /current\.doc\.transact\(\(\) => replaceText\(current\.text, stubText\(\)\)\)/)
  assert.doesNotMatch(restore, /, SEED\)/)
  // И уносит вывод той попытки, текст которой заменили.
  assert.match(restore, /clearedRunAt = untrack\(\(\) => mine\?\.run\?\.startedAt \?\? null\)/)
})
