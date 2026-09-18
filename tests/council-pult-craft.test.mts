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
const HEADER = code(read(`${PULT}/PultHeader.svelte`))
const RULES = code(read(`${PULT}/PultRules.svelte`))
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





test('сохранённый черновик не выдаётся за текущий набор', () => {
  assert.match(ROW, /attemptReview\(attempt\)/, 'оценка и черновик определяются отдельно от запуска')
  assert.doesNotMatch(ROW, /room\.ui\.1312/, 'нельзя ставить «сейчас» по наличию черновика')
  assert.match(ROW, /clock\(attempt\.submittedAt \?\? attempt\.updatedAt\)/)
  assert.match(ROW, /presence\s*===\s*'offline'/)
})

test('просьба о запуске вытесняет время кнопкой — не открывая работу', () => {
  assert.match(ROW, /\{#if onlet\}/, 'кнопка вместо времени')
  assert.match(ROW, /onclick=\{onlet\}/, 'просьба доступна прямо из списка')
  assert.match(ROW, /room\.ui\.1296/, '«Пустить»')
  assert.match(
    LIST,
    /row\.attempt\.runRequest\?\.status === 'pending' && !decisionsOff/,
    'кнопка есть ровно у ждущей и ровно когда решать можно',
  )
})


test('выбранная, наведённая и та, на которой фокус, различимы', () => {
  assert.match(ROW, /class:selected class:focused/)
  // Кольцо ВНУТРЬ и поверх полосы: строка не становится шире, соседи не съезжают.
  assert.match(ROW, /outline-offset:-2px/)
  // И только с клавиатуры: щелчок мышью кольца не рисует.
  assert.match(WINDOW, /keyboard = true/)
  assert.match(WINDOW, /keyboard = false/)
  assert.match(WINDOW, /keyboard=\{keyboard && focus !== 'reply'\}/)
})


test('отбор «новые» не тает под курсором', () => {
  // Точка гаснет на открытии; если бы чип читал живой набор, список вычёркивал
  // бы строку ровно тогда, когда её начали читать, и опустошал себя сам.
  assert.match(WINDOW, /let newPool = \$state\.raw<ReadonlySet<string>>/)
  assert.match(WINDOW, /unread: filter === 'new' \? newPool : unread/)
})

test('имена выключены — «Вариант N» в muted и серый диск, поиск не работает', () => {
  assert.match(ROW, /names \? attempt\.name : tr\('room\.ui\.1255'/)
  assert.match(ROW, /\{#if names\}<Avatar[\s\S]*?\{:else\}<span class="pult-anonymous"/)
  assert.match(WINDOW, /search: names \? search : ''/, 'искать нечего — поиск гасится у источника')
})

/* --------------------------------------- полоса действий · четыре состояния */





test('отметка доступно обозначена и снимается повторным нажатием', () => {
  assert.match(ACTIONS, /aria-pressed=\{correct === false\}/)
  assert.match(WINDOW, /current\.correct === correct \? null : correct/, 'второе нажатие снимает')
  assert.match(ACTIONS, /aria-pressed=\{correct === true\}/)
})

test('черновик классу не показывают ни кнопкой, ни клавишей', () => {
  assert.match(ACTIONS, /disabled=\{disabled \|\| \(!onScreen && writing\)\}/)
  assert.match(WINDOW, /if \(!attempt \|\| attempt\.submittedAt === null\) return/)
})

/* --------------------------------------------------------- окно целиком */


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
  assert.match(QUEUE, /room\.pult\.v2\.queue\.queuedTitle/, 'секция «В очереди» есть')
  assert.doesNotMatch(QUEUE, /draggable|room\.ui\.1348/, 'ни перетаскивания, ни «Убрать»')
})

test('предел виден там, где срабатывает: полосой под идущим запуском', () => {
  /*
   * Единственный вопрос к чужому запуску перед классом — ждать или прерывать,
   * и отвечает на него полоса, а не число в настройках. Она же ловит случай,
   * когда ждать бессмысленно: время вышло, а запуск идёт — остановка не взяла.
   */
  assert.match(QUEUE, /limitMs !== null/, 'без предела полосы нет')
  assert.match(QUEUE, /class="limit-fill" class:over=\{overLimit\}/)
  assert.match(QUEUE, /Math\.min\(100, \(elapsed \/ limitMs\) \* 100\)/, 'заливка вылезает за полосу')
  assert.match(QUEUE, /room\.pult\.v2\.queue\.limitStuck[\s\S]{0,120}room\.pult\.v2\.queue\.limitStops/)
  assert.match(QUEUE, /\.limit-fill\.over \{ background: rgb\(var\(--danger\)\)/)
})

test('остановленные пределом стоят отдельной секцией и подписаны по тому же правилу, что соседи', () => {
  // Их нет ни в очереди, ни среди ждущих, а вопрос «почему у половины класса
  // нет вывода» задают именно здесь. Имя — через who(): при выключенных именах
  // в очереди «Работа без имени», и в этой секции обязано быть то же.
  assert.match(QUEUE, /timedOutAttempts\(attempts\)/)
  assert.match(QUEUE, /\{#if stopped\.length > 0\}/, 'пустая секция не рисуется')
  assert.match(QUEUE, /class="stopped-limit">\{pultDuration\(timedOutLimit\(attempt\)!\)\}/)
  assert.match(QUEUE, /class="stopped-row" onclick=\{\(\) => onopen\(attempt\.participantId\)\}/)
  const rows = QUEUE.slice(QUEUE.indexOf('stopped-section'))
  assert.doesNotMatch(rows, /<(strong|span|code)[^>]*>\{attempt\.name\}/, 'имя в обход правила «имена на проекторе»')
  assert.match(rows, /who\(attempt\)/)
  assert.match(QUEUE, /\.stopped-limit \{[^}]*color: rgb\(var\(--danger\)\)/)
})

test('остановленный пределом не подписан общей «ошибкой запуска» ни в строке, ни в работе', () => {
  assert.match(ROW, /execution\.icon \?\?/, 'знак состояния подменён общим по тону')
  assert.match(WORK, /stoppedAt !== null/)
  assert.match(WORK, /room\.pult\.v2\.rules\.workTimedOut/)
  // И рядом — действующий предел той же кнопкой-значением, что в шапке.
  assert.match(WORK, /class="pult-value" onclick=\{\(event\) => onrules\('runLimit', event\.currentTarget\)\}/)
  assert.match(WORK, /room\.pult\.v2\.rules\.limitLink/)
})

test('все четыре правила ячейки живут на одном листе, и ни одного — в очереди или строке состояния', () => {
  /*
   * Настройка в подвале вкладки — это настройка, которую ищут. «Кто запускает»
   * стояло подвалом очереди, «имена на проекторе» — переключателем внизу
   * окна, а меняют их обе в одну и ту же секунду и по одному поводу: что
   * сейчас можно классу. Теперь они рядом, и каждое правило подписано.
   */
  for (const key of ['whoTeacher', 'whoEveryone', 'whoRequest', 'limitTitle', 'pauseTitle', 'screenTitle']) {
    assert.match(RULES, new RegExp(`room\\.pult\\.v2\\.rules\\.${key}`), `правила «${key}» на листе нет`)
  }
  assert.doesNotMatch(QUEUE, /policy|studentRun:/, 'ручка запуска вернулась в очередь')
  assert.doesNotMatch(STATUS, /role="switch"|namesOnProjector/, 'ручка имён вернулась в строку состояния')
  // Одно место отправки на все четыре: кадр тот же, что у замка ячейки.
  assert.match(WINDOW, /session\.council\.lock\(cellId, 'council', patch\)/)
  assert.match(WINDOW, /function setRule\(patch: Partial<CouncilSettings>\): void/)
})

test('правила применяются нажатием, а не кнопкой «Сохранить»', () => {
  // «Готово» закрывает лист и ничего не отправляет: между «поставил 1 мин» и
  // «действует 1 мин» не должно быть шага, на котором написанное — неправда.
  assert.match(RULES, /onclick=\{segment\.pick\}/)
  assert.doesNotMatch(RULES, /room\.ui\.\d+.*[Сс]охранить|onsave/)
  assert.match(RULES, /data-pult-rules-done onclick=\{onclose\}/)
})

test('регламент читается предложением в шапке, и каждое значение — дверь в лист', () => {
  assert.match(HEADER, /rulesSentence|rules: RulePart\[\]/, 'предложение собирают не в компоненте')
  assert.match(HEADER, /class="pult-value"[\s\S]{0,400}?onrules\(part\.rule, event\.currentTarget\)/)
  assert.match(HEADER, /aria-expanded=\{openRule === part\.rule\}/, 'не видно, о чём открыт лист')
  assert.doesNotMatch(HEADER, /room\.pult\.v2\.private/, 'строка «личный пульт» вернулась на место регламента')
  // Ниже 650 px от предложения остаётся имя — и оно же дверь.
  assert.match(HEADER, /@media\(max-width:650px\)[\s\S]*?\.pult-rules-line \{ display:none/)
})

test('лист забирает клавиатуру целиком: за ним не ходят по списку', () => {
  assert.match(WINDOW, /if \(rulesOpen\) \{[\s\S]{0,200}?event\.key === 'Escape'[\s\S]{0,120}?closeRules\(\)[\s\S]{0,40}?\}\s*\n\s*return/)
  assert.match(RULES, /event\.key !== 'Tab'/, 'Tab уходит за лист')
  assert.match(RULES, /aria-modal="true"/)
})

test('вывод, не поехавший со стопкой, пульт просит по открытой работе', () => {
  assert.match(WINDOW, /attempt\?\.run\?\.outputsOmitted/)
  assert.match(WINDOW, /wantOutputs\(cellId, attempt\.participantId\)/)
})

test('плита кода не растёт от чужого кода и честно говорит, сколько скрыла', () => {
  assert.match(WORK, /max-height: 240px; overflow: auto/)
  assert.match(WORK, /room\.pult\.codeLines/, 'полный счёт строк без выдуманного числа скрытых')
})

test('вывод подписан тем, кто запускал, и окрашен исходом', () => {
  assert.match(WORK, /data-tone=\{execution\?\.tone\}/)
  assert.match(WORK, /run\.by === 'host' \? tr\('room\.ui\.61'\) : tr\('room\.pult\.v2\.ranByAuthor'\)/)
  // «запускали вы» — строка автора; в пульте смотрит преподаватель, и «вы»
  // называло бы запускавшим его самого.
  assert.doesNotMatch(WORK, /room\.ui\.1061/)
  assert.match(WORK, /execution\?\.label/, 'явная подпись запуска')
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

test('удалить с занятия можно из работы видимой кнопкой и общим меню бана', () => {
  assert.match(WORK, /data-pult-remove/, 'кнопки «удалить» в пульте нет')
  assert.match(WORK, /data-pult-remove[^>]*>[\s\S]*?tr\('room\.ui\.78'\)[\s\S]*?<\/button>/)
  assert.match(WINDOW, /import \{ askToBan, banTargetOf \} from '@\/lib\/bans'/)
  assert.match(WINDOW, /askToBan\(banTargetOf\(attempt, event\)\)/)
})

test('удалить с занятия можно у выполняющегося, ждущего разрешения и стоящего в очереди', () => {
  assert.match(QUEUE, /onremove: \(attempt: CouncilAttempt, event: MouseEvent\) => void/)
  assert.equal(
    QUEUE.match(/data-pult-remove/g)?.length,
    3,
    'кнопка должна быть у каждого из трёх видов записи очереди',
  )
  assert.equal(
    QUEUE.match(/tr\('room\.ui\.78'\)/g)?.length,
    3,
    'все три кнопки должны быть подписаны, а не спрятаны под значком',
  )
  assert.match(WINDOW, /onremove=\{remove\}/)
})

test('шапка раскрытой группы называет группу, а не только считает её', () => {
  assert.match(LIST, /\{row\.label\}/, 'имя группы в шапке не печатается')
  const pult = code(read('web/src/lib/council-pult.ts'))
  assert.match(pult, /label: groupTitle\(group\)/, 'имя берётся не общей функцией')
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
