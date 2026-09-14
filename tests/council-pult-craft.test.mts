/**
 * Пульт консилиума — обещания разметки, которых не видно из типов.
 *
 * Ради чего окно заводили: тетрадь зеркалится на проектор, и приватная стопка
 * под ячейкой показывала залу имена, черновики, ошибки и отметки. Поэтому
 * первая проверка здесь — не про красоту: пока окно открыто, консоль под
 * ячейкой НЕ РИСУЕТСЯ, и в оставшейся строке нет ни одного имени.
 *
 * Дальше — то, что в мессенджере ломается молча: строка, меняющая высоту от
 * состояния (соседи перестают читаться колонками), пустой слот, схлопнувшийся
 * вместо того чтобы занять место, полоса действий, у которой кнопки переезжают
 * под пальцем, и вторая заливка в окне, где заливка означает «это увидит зал».
 *
 * Разметка читается из компонентов, как в panels-craft.test.mts.
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

const PULT = 'web/src/components/council/pult'
const ROW = code(read(`${PULT}/PultRow.svelte`))
const LIST = code(read(`${PULT}/PultList.svelte`))
const WORK = code(read(`${PULT}/PultWork.svelte`))
const ACTIONS = code(read(`${PULT}/PultActions.svelte`))
const WINDOW = code(read(`${PULT}/PultWindow.svelte`))
const QUEUE = code(read(`${PULT}/PultQueueStrip.svelte`))
const STATUS = code(read(`${PULT}/PultStatusLine.svelte`))
const CELL = code(read('web/src/components/notebook/CellView.svelte'))

/* ------------------------------------------- утечка на проектор закрыта */

test('пока пульт открыт, приватная консоль под ячейкой не рисуется', () => {
  // Ветка `{#if pultOpen}` стоит ПЕРЕД стопкой и забирает её место: две ветки
  // одного `{#if}` не могут быть нарисованы обе.
  const at = CELL.indexOf('{#if pultOpen}')
  assert.ok(at > 0, 'ветка «пульт открыт» есть')
  const stack = CELL.indexOf('<CouncilStack')
  assert.ok(at < stack, 'она стоит перед стопкой')
  const branch = CELL.slice(at, stack)
  assert.match(branch, /\{:else if leads && \(inCouncil/, 'стопка — это ИНАЧЕ, а не соседний блок')
  // В оставшейся строке — только числа, которые зал и так видит на проекторе.
  assert.match(branch, /room\.ui\.1364/, '«Пульт открыт в отдельном окне»')
  assert.match(branch, /countLine\(/, 'сдали N из M')
  assert.doesNotMatch(branch, /attempt\.name|\.name\}/, 'ни одного имени')
})

test('«открыт» решает стук, а не ссылка на окно', () => {
  // Ссылку на окно теряет перезагрузка тетради — окно при этом живо, и стопка
  // осталась бы скрытой навсегда.
  assert.match(CELL, /watchPult\(session\.session\.id/)
  assert.match(CELL, /beatsAlive\(pultBeat, pultNow\)/)
  assert.match(CELL, /pultBeat\?\.cellId === id/, 'стук чужой ячейки эту не трогает')
  assert.match(CELL, /setInterval\(\(\) => \(pultNow = Date\.now\(\)\), 1000\)/, 'своё затухание')
})

test('плашка «на экране» под ячейкой остаётся: это не приватное', () => {
  assert.match(CELL, /<CouncilOnScreen/)
})

test('пульт открывают из замка — строкой, а не четвёртым положением', () => {
  const menu = CELL.slice(CELL.indexOf('data-lock-menu'), CELL.indexOf('{#if !inCouncil}'))
  assert.match(menu, /\{#if inCouncil\}/, 'строка только в консилиуме')
  assert.match(menu, /openCouncilPult/)
  assert.match(menu, /room\.ui\.1366/, '«Открыть пульт»')
  assert.match(menu, /room\.ui\.1367/, '«окно 900×700 · помнит место»')
})

/* ------------------------------------------------ строка списка · 12 состояний */

test('строка всегда 50 и всегда с полосой смысла в три пикселя', () => {
  assert.match(ROW, /h-\[50px\]/)
  assert.match(ROW, /border-l-\[3px\]/)
  // Высота не обсуждается ни в одной ветке: второго роста у строки нет.
  assert.equal(ROW.match(/h-\[\d+px\]/g)?.filter((one) => one === 'h-[50px]').length, 1)
})

test('четыре цвета полосы — и ни один из них не двигает строку', () => {
  for (const tone of ['border-l-warning', 'border-l-positive', 'border-l-accent', 'border-l-transparent']) {
    assert.match(ROW, new RegExp(tone.replace('-', '-')), tone)
  }
  // Полоса прозрачная, а не отсутствующая: `{#if}` сдвинул бы содержимое на 3px.
  assert.doesNotMatch(ROW, /\{#if[^}]*\}\s*border-l/)
})

test('пустые слоты занимают место: точка, аватар и хвост', () => {
  assert.match(ROW, /h-\[7px\] w-\[7px\][^"]*rounded-full/, 'точка 7')
  assert.match(ROW, /unread \? 'bg-accent' : 'bg-transparent'/, 'слот занят и когда точки нет')
  assert.match(ROW, /h-\[22px\] w-\[22px\]/, 'аватар 22')
  assert.match(ROW, /w-\[30px\] shrink-0 text-right font-mono/, 'время — колонка 30, а не «сколько влезет»')
})

test('имя 13/700, отметка капителью 10, уточнение 11', () => {
  assert.match(ROW, /truncate text-ui font-bold/, 'имя 13/700 в одну строку')
  assert.match(ROW, /text-micro font-bold uppercase tracking-caps/, 'капитель 10 / 0.08em')
  assert.match(ROW, /min-w-0 truncate text-2xs/, 'уточнение 11 — и оно уступает место кнопке')
})

test('пишущий помечен словом и временем «сейчас», а не пустотой', () => {
  assert.match(ROW, /room\.ui\.1311/, '«пишет…»')
  assert.match(ROW, /room\.ui\.1312/, '«сейчас»')
  assert.match(ROW, /if \(writing\) return \{ text: tr\('room\.ui\.1311'\), tone: 'text-accent' \}/)
})

test('просьба о запуске вытесняет время кнопкой 24 — не открывая работу', () => {
  assert.match(ROW, /\{#if onlet\}/, 'кнопка вместо времени')
  assert.match(ROW, /h-6 shrink-0 bg-warning/, 'кнопка 24 в цвете просьбы')
  assert.match(ROW, /room\.ui\.1296/, '«Пустить»')
  assert.match(
    LIST,
    /row\.attempt\.runRequest\?\.status === 'pending' && !decisionsOff/,
    'кнопка есть ровно у ждущей и ровно когда решать можно',
  )
})

test('«на экране» — залитый чип, а не ещё одно слово', () => {
  assert.match(ROW, /meaning === 'screen'/)
  assert.match(ROW, /bg-positive px-1\.5 py-px text-canvas/)
})

test('выбранная, наведённая и та, на которой фокус, различимы', () => {
  assert.match(ROW, /selected \? 'bg-raised' : 'hover:bg-surface'/)
  // Кольцо ВНУТРЬ и поверх полосы: строка не становится шире, соседи не съезжают.
  assert.match(ROW, /focused && 'outline outline-2 -outline-offset-2 outline-accent'/)
  // И только с клавиатуры: щелчок мышью кольца не рисует.
  assert.match(WINDOW, /keyboard = true/)
  assert.match(WINDOW, /keyboard = false/)
  assert.match(WINDOW, /keyboard=\{keyboard && focus !== 'reply'\}/)
})

test('группа: свёрнутая 40 без полосы, шапка 28 на surface, члены с отступом', () => {
  assert.match(LIST, /kind === 'collapsed'/)
  assert.match(LIST, /h-10 w-full shrink-0/, 'хвост 40')
  assert.match(LIST, /room\.ui\.1315/, '«Раскрыть»')
  assert.match(LIST, /h-7 shrink-0 items-center[^"]*bg-surface/, 'шапка 28 на surface')
  assert.match(LIST, /room\.ui\.1316/, '«Свернуть»')
  assert.match(ROW, /inGroup \? 'pl-\[21px\]' : 'pl-\[9px\]'/, 'отступ 12 сверх обычных 9')
})

test('отбор «новые» не тает под курсором', () => {
  // Точка гаснет на открытии; если бы чип читал живой набор, список вычёркивал
  // бы строку ровно тогда, когда её начали читать, и опустошал себя сам.
  assert.match(WINDOW, /let newPool = \$state\.raw<ReadonlySet<string>>/)
  assert.match(WINDOW, /unread: filter === 'new' \? newPool : unread/)
})

test('имена выключены — «Вариант N» в muted и серый диск, поиск не работает', () => {
  assert.match(ROW, /names \? attempt\.name : tr\('room\.ui\.1255'/)
  assert.match(ROW, /names \? 'text-ink' : 'text-muted'/)
  assert.match(ROW, /names \? attempt\.color : 'rgb\(var\(--line\)\)'/)
  assert.match(WINDOW, /search: names \? search : ''/, 'искать нечего — поиск гасится у источника')
})

/* --------------------------------------- полоса действий · четыре состояния */

test('порядок кнопок в полосе действий не меняется никогда', () => {
  const order = [...ACTIONS.matchAll(/room\.ui\.(1254|1336|1339|1337|1338|1343|1284|1340|1341)/g)].map(
    (m) => m[1],
  )
  // Показать/убрать — первыми, запустить/соседняя/считает — вторыми, хвост — последним.
  assert.deepEqual(order.slice(0, 2), ['1254', '1336'], 'первая кнопка — дверь в зал')
  assert.ok(order.indexOf('1284') > order.indexOf('1337'), '«Прервать» — в хвосте, не среди кнопок')
})

test('по умолчанию: «Убрать» нет вовсе, заливка одна', () => {
  assert.match(ACTIONS, /\{#if onScreen\}/)
  assert.match(ACTIONS, /bg-accent text-accent-ink/)
  // Единственная заливка в окне, кроме нажатой отметки: из пульта наружу ведёт
  // ровно одна дверь, и она обязана быть видна с одного взгляда.
  const fills = new Set([...ACTIONS.matchAll(/bg-(accent|positive|danger|warning)\b/g)].map((m) => m[1]))
  assert.deepEqual([...fills].sort(), ['accent', 'danger', 'positive'], 'показать + нажатые ✓ и ✗')
})

test('эта работа на экране: кромка зеленеет, первая кнопка переворачивается', () => {
  assert.match(ACTIONS, /onScreen \? 'border-t-positive' : 'border-t-line'/)
  assert.match(ACTIONS, /border border-danger text-danger/, '«Убрать с экрана» — рамка danger')
  assert.match(ACTIONS, /room\.ui\.1254/)
  assert.match(ACTIONS, /onScreen && hasNeighbour/)
  assert.match(ACTIONS, /room\.ui\.1339/, '«Соседнюю →»')
  assert.match(ACTIONS, /room\.ui\.1341/, '«в кадре N»')
})

test('работа считается: вместо кнопки показание, а в хвосте «Прервать»', () => {
  assert.match(ACTIONS, /\{#if running\}/)
  assert.match(ACTIONS, /room\.ui\.1343/, '«Считает»')
  assert.match(ACTIONS, /<span class=\{cn\(BTN, 'gap-2 border border-accent'\)\}/, 'это не кнопка — нажимать нечего')
  assert.match(ACTIONS, /room\.ui\.1284/, '«Прервать» на месте соседа')
})

test('отметка — единственная кнопка, которая заливается нажатой, и снимается собой', () => {
  assert.match(ACTIONS, /correct === true \? 'border-positive bg-positive text-canvas'/)
  assert.match(ACTIONS, /correct === false \? 'border-danger bg-danger text-canvas'/)
  assert.match(WINDOW, /current\.correct === correct \? null : correct/, 'второе нажатие снимает')
  assert.match(ACTIONS, /aria-pressed=\{correct === true\}/)
})

test('черновик классу не показывают ни кнопкой, ни клавишей', () => {
  assert.match(ACTIONS, /disabled=\{disabled \|\| writing\}/)
  assert.match(WINDOW, /if \(!attempt \|\| attempt\.submittedAt === null\) return/)
})

/* --------------------------------------------------------- окно целиком */

test('пояса окна стоят в объявленной высоте', () => {
  assert.match(read(`${PULT}/PultHeader.svelte`), /h-\[34px\]/, 'шапка 34')
  assert.match(QUEUE, /h-11 items-center gap-3 px-4/, 'полоса очереди 44')
  assert.match(read(`${PULT}/PultFilters.svelte`), /h-9 shrink-0/, 'фильтры 36')
  assert.match(STATUS, /h-\[26px\]/, 'строка состояния 26')
  assert.match(ACTIONS, /h-14 shrink-0/, 'полоса действий 56')
  assert.match(LIST, /w-\[308px\]/, 'список 308')
  assert.match(LIST, /min-\[1100px\]:w-\[360px\]/, 'и 360 там, где экран это позволяет')
})

test('в пульте нет ни тетради, ни панелей — только он сам', () => {
  const screen = code(read('web/src/screens/SessionScreen.svelte'))
  assert.match(screen, /\{:else if councilPult && councilCell\}/)
  const branch = screen.slice(screen.indexOf('{:else if councilPult'), screen.indexOf('{:else if pult}'))
  assert.match(branch, /<Pult cellId=\{councilCell\}/)
  assert.doesNotMatch(branch, /<Notebook|<FilesPanel|<OraclePanel/)
})

test('не-преподавателю пульт отвечает отказом, а не пустым списком', () => {
  assert.match(WINDOW, /\{#if !host\}/)
  assert.match(WINDOW, /room\.ui\.1357/)
  assert.match(WINDOW, /room\.ui\.1358/)
})

test('очередь показана на просмотр: переставлять её нечем, и рука об этом не просит', () => {
  // Кадра «переставить» или «убрать из очереди» в протоколе нет — рисовать
  // кнопку, которой не на что нажать, значит обещать несуществующее.
  assert.match(QUEUE, /room\.ui\.1300/, 'секция «В очереди» есть')
  assert.doesNotMatch(QUEUE, /draggable|room\.ui\.1348/, 'ни перетаскивания, ни «Убрать»')
})

test('ручка запуска — три положения настроек консилиума, и все три подписаны', () => {
  assert.match(QUEUE, /value: false, label: tr\('room\.ui\.1287'\)/)
  assert.match(QUEUE, /value: true, label: tr\('room\.ui\.1289'\)/)
  assert.match(QUEUE, /value: 'request', label: tr\('room\.ui\.1291'\)/)
  assert.match(WINDOW, /session\.council\.lock\(cellId, 'council', \{ studentRun \}\)/)
})

test('ручка имён живёт рядом с показом, а не в настройках комнаты', () => {
  assert.match(STATUS, /role="switch"/)
  assert.match(STATUS, /aria-checked=\{names\}/)
  assert.match(WINDOW, /session\.council\.lock\(cellId, 'council', \{ namesOnProjector \}\)/)
})

test('вывод, не поехавший со стопкой, пульт просит по открытой работе', () => {
  assert.match(WINDOW, /attempt\?\.run\?\.outputsOmitted/)
  assert.match(WINDOW, /wantOutputs\(cellId, attempt\.participantId\)/)
})

test('плита кода не растёт от чужого кода и честно говорит, сколько скрыла', () => {
  assert.match(WORK, /max-h-\[76px\] overflow-y-auto/)
  assert.match(WORK, /room\.ui\.1334/, '«ещё N строк — прокрутить»')
})

test('вывод подписан тем, кто запускал, и окрашен исходом', () => {
  assert.match(WORK, /run\.state === 'error' \? 'border-danger' : run\.state === 'ok' \? 'border-positive'/)
  assert.match(WORK, /run\.by === 'host' \? tr\('room\.ui\.61'\) : tr\('room\.ui\.1061'\)/)
  assert.match(WORK, /room\.ui\.1335/, '«не запускали» вместо пустой плиты')
})
