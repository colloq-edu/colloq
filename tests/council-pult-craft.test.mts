/**
 * Пульт консилиума — обещания разметки, которых не видно из типов.
 *
 * Ради чего окно заводили: тетрадь зеркалится на проектор, и приватная консоль
 * под ячейкой показывала залу имена, черновики, ошибки и отметки. Консоли в
 * тетради больше нет ВОВСЕ — ни запасным путём, ни при закрытом окне, — и
 * первые проверки здесь про это: под ячейкой у преподавателя одна строка чисел
 * и кнопка «Пульт ↗», в меню замка три положения и ничего больше, а ячейка,
 * которую сделали консилиумной, открывает окно тем же нажатием.
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
const REPLY = code(read(`${PULT}/PultReply.svelte`))
const LIST = code(read(`${PULT}/PultList.svelte`))
const WORK = code(read(`${PULT}/PultWork.svelte`))
const ACTIONS = code(read(`${PULT}/PultActions.svelte`))
const WINDOW = code(read(`${PULT}/PultWindow.svelte`))
const QUEUE = code(read(`${PULT}/PultQueueStrip.svelte`))
const STATUS = code(read(`${PULT}/PultStatusLine.svelte`))
const CELL = code(read('web/src/components/notebook/CellView.svelte'))

/* ------------------------------------------- утечка на проектор закрыта */

test('под ячейкой у преподавателя — строка чисел и кнопка, и больше ничего', () => {
  const at = CELL.indexOf('data-council-host')
  assert.ok(at > 0, 'блока консилиума под ячейкой нет вовсе')
  const block = CELL.slice(CELL.lastIndexOf('{#if leads', at), CELL.indexOf('{#if leads && showsOnScreen', at))
  // Ровно те числа, что зал и так видит на проекторе.
  assert.match(block, /countLine\(/, 'сдали N из M')
  assert.match(block, /room\.ui\.1056/, '«N ещё пишут»')
  assert.match(block, /data-council-pult-button/, 'двери в пульт нет')
  assert.match(block, /room\.ui\.1400/, '«Пульт»')
  assert.match(block, /room\.ui\.1401/, '«Пульт открыт» — когда окно живо')
  assert.doesNotMatch(block, /attempt\.name|\.name\}/, 'ни одного имени')
})

test('приватной консоли в тетради не осталось ни одной — даже запасным путём', () => {
  for (const dead of ['CouncilStack', 'CouncilSummary', 'CouncilStrip', 'CouncilOracle', 'CouncilReplyDraft']) {
    assert.ok(
      !fs.existsSync(path.resolve(import.meta.dirname, '..', `web/src/components/council/${dead}.svelte`)),
      `${dead} вернулся: второе место с именами — это и есть утечка`,
    )
    assert.doesNotMatch(CELL, new RegExp(dead), `${dead} снова монтируется под ячейкой`)
  }
  // И проводов к нему: показать, запустить, отметить, ответить — всё это пульт.
  assert.doesNotMatch(CELL, /session\.council\.(show|mark|reply)\(/, 'ячейка снова ведёт консилиум')
  assert.doesNotMatch(CELL, /council\.view/, 'переключатель «стопка/сводка» пережил стопку')
})

test('«открыт» решает стук, а не ссылка на окно', () => {
  // Ссылку на окно теряет перезагрузка тетради — окно при этом живо.
  assert.match(CELL, /watchPult\(session\.session\.id/)
  assert.match(CELL, /beatsAlive\(pultBeat, pultNow\)/)
  assert.match(CELL, /pultBeat\?\.cellId === id/, 'стук чужой ячейки эту не трогает')
  assert.match(CELL, /setInterval\(\(\) => \(pultNow = Date\.now\(\)\), 1000\)/, 'своё затухание')
})

test('плашка «на экране» под ячейкой остаётся: это не приватное', () => {
  assert.match(CELL, /<CouncilOnScreen/)
})

test('меню замка — три положения и ничего больше', () => {
  const menu = CELL.slice(CELL.indexOf('data-lock-menu'), CELL.indexOf('{:else}', CELL.indexOf('data-lock-menu')))
  assert.match(menu, /\{#each LOCKS as item/, 'положения рисуются перебором')
  assert.doesNotMatch(menu, /room\.ui\.335|<select/, 'ручка «запуск студентам» вернулась в меню')
  assert.doesNotMatch(menu, /room\.ui\.1258|checkbox/, 'ручка имён вернулась в меню')
  assert.doesNotMatch(menu, /room\.ui\.1366|openCouncilPult/, '«Открыть пульт» снова спрятан в меню')
  // Три положения — те же три, что знает сервер.
  assert.match(CELL, /\{ state: 'closed'/)
  assert.match(CELL, /\{ state: 'open'/)
  assert.match(CELL, /\{ state: 'council'/)
})

test('окно открывает только кнопка под ячейкой — ни замок, ни кадр из сети', () => {
  /*
   * Перевести ячейку в консилиум и открыть пульт — два разных решения, и
   * второе принимает преподаватель: замок, открывающий окно сам, отнимает у
   * него выбор посреди фразы. Да и технически иначе нельзя: `window.open`
   * живёт только внутри пользовательского жеста, и открыть окно позже, по
   * кадру с сервера, не вышло бы вовсе — молча.
   */
  const press = CELL.slice(CELL.indexOf('function pressLock('), CELL.indexOf('function startHold('))
  assert.doesNotMatch(press, /reachPult\(|openPult\(/, 'щелчок по замку открывает окно')
  const setLock = CELL.slice(CELL.indexOf('function setLock('), CELL.indexOf('// Меню закрывается снаружи'))
  assert.doesNotMatch(setLock, /reachPult\(|openPult\(/, '«Консилиум» из меню открывает окно')
  const effects = [...CELL.matchAll(/\$effect\(\(\) => \{[\s\S]*?\n  \}\)/g)].map((m) => m[0])
  for (const effect of effects) {
    assert.doesNotMatch(effect, /reachPult\(|openPult\(/, 'окно открывается само, вне жеста')
  }
  // Единственный вызов — обработчик кнопки под ячейкой.
  assert.equal(CELL.match(/onclick=\{reachPult\}/g)?.length, 1)
})

test('браузер заблокировал окно — кнопка говорит об этом словом', () => {
  assert.match(CELL, /pultBlocked = opened === null/)
  assert.match(CELL, /room\.ui\.1402/, 'причина отказа не названа')
  assert.match(CELL, /blockedTimer = window\.setTimeout/, 'строка про одно нажатие не гаснет')
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
  assert.match(ROW, /if \(writing\) return \{ text: tr\('room\.ui\.1311'\), tone: 'text-accent-text' \}/)
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
  assert.match(ACTIONS, /room\.pult\.running/, '«Считает»')
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
  assert.match(QUEUE, /min-h-11 flex-wrap items-center gap-3 px-4/, 'полоса очереди 44')
  assert.match(read(`${PULT}/PultFilters.svelte`), /min-h-10 shrink-0 flex-wrap/, 'фильтры могут переноситься')
  assert.match(STATUS, /min-h-\[32px\]/, 'строка состояния доступна в небольшом окне')
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
  assert.match(WORK, /max-h-\[240px\] overflow-auto/)
  assert.match(WORK, /room\.pult\.codeLines/, 'полный счёт строк без выдуманного числа скрытых')
})

test('вывод подписан тем, кто запускал, и окрашен исходом', () => {
  assert.match(WORK, /run\.state === 'error' \? 'border-danger' : run\.state === 'ok' \? 'border-positive'/)
  assert.match(WORK, /run\.by === 'host' \? tr\('room\.ui\.61'\) : tr\('room\.ui\.1061'\)/)
  assert.match(WORK, /room\.ui\.1335/, '«не запускали» вместо пустой плиты')
})

/* ------------------------------- что переехало из тетради вместе с консолью */

test('черновик оракула правят в поле, а не подтверждают кнопкой', () => {
  // Письмо уйдёт от имени преподавателя, поэтому палец обязан пройти через
  // поле: черновик встаёт текстом и только в пустое поле — своё не затирает.
  assert.match(WINDOW, /board\?\.oracle\?\.drafts\[group\.key\]/, 'черновик группы не читается')
  assert.match(WINDOW, /toGroup && reply\.trim\(\) === '' && groupDraft/)
  assert.match(WINDOW, /fromOracle: true/)
  assert.doesNotMatch(WINDOW, /отправить как есть/)
  // Пометка на «Всем N» — что черновик для этой группы есть; строка под полем
  // — что в поле стоит именно он.
  assert.match(REPLY, /hasDraft \? tr\('room\.ui\.41'\) : ''/, 'пометки о черновике нет')
  assert.match(REPLY, /\{#if fromOracle\}/)
  assert.match(REPLY, /tr\('room\.ui\.30'\)/, 'не сказано, чей это текст')
})

// Recipient changes, retained drafts and actual sends are verified in the browser audit.

test('удалить с занятия можно из пульта — тихой кнопкой и общим меню бана', () => {
  assert.match(WORK, /data-pult-remove/, 'кнопки «удалить» в пульте нет')
  assert.match(WORK, /tr\('room\.ui\.78'\)/)
  // Тихая до наведения: единственное наказание в продукте не стоит рядом с
  // «показать классу» одинаково громко.
  assert.match(WORK, /text-faint hover:text-danger/)
  assert.match(WINDOW, /import \{ askToBan \} from '@\/lib\/bans'/)
  assert.match(WINDOW, /askToBan\(\{[\s\S]*?id: current\.participantId/)
  // Имя в вопросе настоящее и при выключенных именах: «Вариант 12» не удаляют.
  assert.match(WINDOW, /name: current\.name/)
})

test('шапка раскрытой группы называет группу, а не только считает её', () => {
  assert.match(LIST, /\{row\.label\}/, 'имя группы в шапке не печатается')
  const pult = code(read('web/src/lib/council-pult.ts'))
  assert.match(pult, /label: groupTitle\(group\)/, 'имя берётся не общей функцией')
})

test('полоса отбора несёт счёт одной функцией на весь клиент', () => {
  const filters = code(read(`${PULT}/PultFilters.svelte`))
  assert.match(filters, /councilStripText\(counts, groups\)/)
  assert.doesNotMatch(filters, /plural\(/, 'своя копия счёта вернулась')
})

/* --------------------------- обещания, пережившие консоль в тетради */

test('вывод по просьбе: кадр объявлен, пульт просит, стопка помнит, сервер отвечает', () => {
  assert.match(WINDOW, /attempt\?\.run\?\.outputsOmitted/, 'повод — только урезанная попытка')
  assert.match(WINDOW, /wantOutputs\(cellId, attempt\.participantId\)/)
  const protocol = read('shared/protocol.ts')
  assert.match(protocol, /t: 'council:attempt'; cellId: string; participantId: string/)
  assert.match(protocol, /outputsOmitted\?: boolean/)
  const state = read('web/src/lib/council.svelte.ts')
  // Ключ с `startedAt`: попытку запускают повторно, и у НОВОГО запуска вывод
  // снова может не влезть в бюджет кадра.
  assert.match(state, /wantOutputs\(cellId: string, participantId: string\)/)
  assert.match(state, /\$\{cellId\}:\$\{participantId\}:\$\{run\.startedAt\}/)
  assert.match(read('server/src/control.ts'), /case 'council:attempt': \{/, 'сервер его разбирает')
})

test('просьбу о запуске студент шлёт из листа, а решают её в пульте', () => {
  assert.match(CELL, /session\.council\.requestRun\(id\)/)
  assert.match(CELL, /session\.council\.cancelRunRequest\(id, request\.id\)/)
  // Запуск и запрос для студента — одна кнопка: про механику запроса он ничего
  // не знает и знать не должен.
  assert.match(CELL, /tr\('room\.ui\.73'\)/)
  assert.match(CELL, /tr\('room\.ui\.1260'\)/)
  assert.match(WINDOW, /session\.council\.approveRunRequest\(cellId, attempt\.participantId, request\.id\)/)
  assert.match(WINDOW, /session\.council\.declineRunRequest\(cellId, attempt\.participantId, request\.id\)/)
})

/* --------------------------------------------------------------- тема */

test('пульт одет в тему комнаты — светлую или тёмную, а не в ночную', () => {
  /*
   * Лекционный пульт одалживает тёмную по физике зала; этот держат рядом с
   * тетрадью, вторым окном на том же мониторе, и тёмная плита возле светлой
   * комнаты читается как вторая программа. Своей темы у окна нет: цвета названы
   * смыслом, а оба набора им отвечают.
   */
  const files = fs.readdirSync(path.resolve(import.meta.dirname, '..', PULT))
  assert.ok(files.length > 10, 'компоненты пульта не нашлись')
  for (const file of files) {
    const source = code(read(`${PULT}/${file}`))
    assert.doesNotMatch(source, /night-/, `${file}: ночной токен`)
    assert.doesNotMatch(source, /borrowTheme/, `${file}: тема одолжена силой`)
    assert.doesNotMatch(source, /\bdark:/, `${file}: класс темы прибит в разметке`)
    assert.doesNotMatch(source, /classList\.toggle\('dark'/, `${file}: окно красит себя само`)
  }
  assert.match(WINDOW, /bg-canvas text-ink/, 'подложка и текст — не токенами темы')
})

test('переключили тему в тетради — пульт рядом перекрасился, а не ждёт перезагрузки', () => {
  // Выбор хранится на браузер, а не на вкладку: второе окно слушает тот же
  // ключ. `storage` приходит только в ДРУГИЕ документы — писавший уже перекрашен.
  const theme = code(read('web/src/lib/theme.svelte.ts'))
  assert.match(theme, /window\.addEventListener\('storage', onStorage\)/)
  assert.match(theme, /event\.key !== STORAGE_KEY/)
  assert.match(theme, /if \(!borrowed\) apply\(next\)/, 'одолжённый экран слушается чужого выбора')
})
