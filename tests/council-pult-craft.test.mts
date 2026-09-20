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
  assert.match(ROW, /pultClock\(attempt\.submittedAt \?\? attempt\.updatedAt\)/)
  // «Пишет · 14 строк» — это про набранное, а не про то, что пальцы на
  // клавишах прямо сейчас; сколько человек молчит, считается от времени правки.
  assert.match(ROW, /draftLine\(attempt, now\)/)
})

test('присутствие — точка на аватаре, а не подпись «не в сети» в каждой строке', () => {
  /*
   * Десять одинаковых подписей в списке из двадцати — это шум, сквозь который
   * ищут то, что отличается. Точка занимает угол картинки, которая и так
   * нарисована, и различает ТРИ состояния, а не два: неизвестно (связи нет,
   * ростер не доехал) — точки нет вовсе.
   */
  assert.doesNotMatch(ROW, /room\.pult\.offline/, '«не в сети» вернулось словом в строку списка')
  assert.match(ROW, /class="pult-face pult-avatar" data-presence=\{presence\}/)
  assert.match(ROW, /<span class="pult-face-dot">/)
  const css = read(`${PULT}/pult.css`)
  assert.match(css, /\.pult-face\[data-presence="unknown"\] \.pult-face-dot \{ display: none/)
  assert.match(css, /\.pult-face\[data-presence="offline"\][\s\S]{0,120}border-color: rgb\(var\(--faint\)\)/)
  // И в шапке работы — та же точка на том же аватаре, одним правилом.
  assert.match(WORK, /class="pult-face work-avatar" data-presence=\{presence\}/)
})

test('сданная работа отличается от черновика словом и формой, а не только цветом', () => {
  /*
   * Жалоба с пары 19.09: «лучше помечать сданные работы в пульте, а то нихуя
   * не видно». Сданная и не оценённая — залитая плашка акцентом, черновик —
   * контурная и приглушённая строка. Одним цветом такие вещи не различают:
   * строку читают краем глаза, посреди фразы к классу.
   */
  const pult = code(read('web/src/lib/council-pult.ts'))
  assert.match(pult, /room\.pult\.v3\.review\.waiting'\), tone: 'accent', shape: 'fill'/)
  assert.match(pult, /room\.pult\.v2\.review\.draft'\), tone: 'neutral', shape: 'outline'/)
  assert.match(ROW, /data-shape=\{review\.shape\}/, 'форма плашки не доезжает до разметки')
  assert.match(ROW, /data-draft=\{draft\?'yes':'no'\}/, 'черновик не помечен на строке')
  assert.match(ROW, /\[data-draft='yes'\][\s\S]{0,120}opacity:\.65/, 'черновик не приглушён')
  const css = read(`${PULT}/pult.css`)
  assert.match(css, /\.pult-badge\[data-shape="fill"\][\s\S]{0,140}background: rgb\(var\(--accent\)\)/)
  assert.match(css, /\.pult-badge\[data-shape="outline"\][\s\S]{0,160}background: transparent/)
})

test('время запуска стоит в строке списка и в открытой работе', () => {
  // «В пульте консилиума показывать время запуска» — дословная просьба с пары.
  // Строка списка: «Запуск выполнен · 1,2 с · 17:24». Работа: с секундами,
  // потому что за минуту запусков бывает три.
  assert.match(ROW, /attemptRunLine\(attempt, now\)/, 'строка запуска собирается не общей функцией')
  assert.match(WORK, /pultClock\(run\.startedAt, true\)/, 'в работе нет секунд в моменте запуска')
  assert.match(QUEUE, /room\.pult\.v3\.queueRunning/, 'в очереди не сказано, когда запущен идущий')
  assert.match(QUEUE, /room\.pult\.v3\.queueSince/, 'в очереди не сказано, с какого времени ждут')
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
  assert.match(branch, /<Pult\b[\s\S]*?cellId=\{councilCell\}/)
  // Ячейку переключают ВНУТРИ окна, адресом: пульт один на комнату.
  assert.match(branch, /onpick=\{\(next\) => onnavigate\?\.\(pultPath\(/)
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
  // Ниже 1200 px от предложения остаётся имя — и оно же дверь. Порог переехал
  // с 860 вместе с названием задания: в одной строке с заголовком, названием и
  // «ячейка 2 из 4 · ещё в N ждут оценки» предложение перестаёт помещаться
  // намного раньше, чем окно становится телефоном. Обрезаться посередине ему
  // нельзя — половина правила, по которой принимают решение, хуже его имени.
  assert.match(HEADER, /@media\(max-width:1200px\)[\s\S]*?\.pult-rules-line \{ display:none/)
  assert.match(HEADER, /\.pult-rules-line \{[^}]*flex-shrink:0/, 'предложение снова сжимается и рвётся посередине')
})

test('шапка окна — одна строка, а не три', () => {
  /*
   * Бюджет постоянной обвязки в окне 900×650: шапка ≤ 56 px. Было ~90 на одну
   * только шапку (заголовок 26/32, подпись, регламент отдельной строкой), и
   * вместе со вкладками и полосой «на экране» — 290 px из 650.
   */
  assert.match(HEADER, /\.pult-header \{[^}]*display:flex[^}]*align-items:center/)
  const height = HEADER.match(/\.pult-header \{[^}]*min-height:(\d+)px/)?.[1]
  assert.ok(height && Number(height) <= 56, `шапка обещает ${height ?? '?'} px`)
  // Заголовок — подпись окна, а не титул: 26/32 занимали высоту двух строк.
  const title = HEADER.match(/h1 \{[^}]*font-size:(\d+)px/)?.[1]
  assert.ok(title && Number(title) <= 20, `заголовок ${title ?? '?'} px`)
  const tab = WINDOW.match(/\.pult-view-tab \{[^}]*min-height:(\d+)px/)?.[1]
  assert.ok(tab && Number(tab) <= 48, `вкладки обещают ${tab ?? '?'} px`)
  const status = code(read(`${PULT}/PultStatusLine.svelte`))
  const line = status.match(/\.pult-status \{[^}]*min-height:(\d+)px/)?.[1]
  assert.ok(line && Number(line) <= 32, `строка состояния обещает ${line ?? '?'} px`)
  // Полоса «на экране» — одна строка и без переносов.
  const screen = code(read(`${PULT}/PultOnScreen.svelte`))
  assert.match(screen, /\.projection-banner \{[^}]*flex-wrap: nowrap/)
  const banner = screen.match(/\.projection-banner \{[^}]*min-height: (\d+)px/)?.[1]
  assert.ok(banner && Number(banner) <= 40, `полоса обещает ${banner ?? '?'} px`)
  // И когда она видна, строка состояния не повторяет то же имя.
  assert.match(WINDOW, /banner=\{shown !== null\}/)
  assert.match(status, /\{#if !banner\}/)
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

test('длинный код показан началом и кнопкой, а не окошком с прокруткой', () => {
  /*
   * Плита кода имела свою прокрутку на 240 px ВНУТРИ прокрутки панели: колесо
   * над кодом двигало код, чуть ниже — панель, и попасть в нужную было делом
   * наугад. Теперь первые сорок строк и кнопка «показать весь код»; вывод
   * идёт сразу под кодом в той же ленте, и своей вертикальной прокрутки у
   * него нет — только горизонтальная, ради широких таблиц.
   */
  assert.match(WORK, /const CODE_LINES = 40/)
  assert.match(WORK, /slice\(0, CODE_LINES\)/)
  assert.match(WORK, /room\.pult\.v3\.codeAll/, 'не сказано, сколько строк за кнопкой')
  assert.doesNotMatch(WORK, /\.work-code-scroll \{[^}]*max-height/, 'окошко с прокруткой вернулось')
  assert.match(WORK, /\.work-code-scroll \{ overflow-x: auto; \}/)
  assert.doesNotMatch(WORK, /\.work-output \{[^}]*max-height/, 'у вывода снова своя вертикальная прокрутка')
  assert.match(WORK, /\.work-output \{ overflow-x: auto; \}/)
})

test('панель работы не прокручивается целиком: три зоны и док, прибитый к низу', () => {
  /*
   * Главная жалоба владельца 19.09: «типа надо листать куда-то что-то, нет
   * фиксированной области общения». В невысоком окне вся правая панель
   * становилась длинной страницей (`@media(max-height:700px)` в окне и
   * `min-height:650px` у работы), и письма, поле ответа и четыре действия
   * лежали под сгибом.
   */
  assert.doesNotMatch(WINDOW, /max-height:700px[\s\S]{0,80}overflow-y:auto/, 'панель снова прокручивается целиком')
  assert.doesNotMatch(WORK, /\.work \{[^}]*min-height: 650px/, 'работа снова выше окна')
  assert.match(WORK, /\.work-content \{[^}]*flex: 1; min-height: 0; overflow-y: auto/, 'прокручивается не середина')
  assert.match(WORK, /\.work-dock \{[^}]*flex-shrink: 0/, 'док не прибит к низу')
  // Порядок зон: шапка, прокрутка, док. Письма уехали в док и в ленте их нет.
  const order = ['work-header', 'data-pult-work-scroll', 'data-pult-dock']
  let at = -1
  for (const mark of order) {
    const next = WORK.indexOf(mark)
    assert.ok(next > at, `${mark} стоит не на своём месте`)
    at = next
  }
  assert.ok(WORK.indexOf('<PultLetters') > WORK.indexOf('data-pult-dock'), 'письма остались в прокрутке')
  assert.ok(WORK.indexOf('<PultReply') > WORK.indexOf('data-pult-dock'))
  assert.ok(WORK.indexOf('<PultActions') > WORK.indexOf('data-pult-dock'))
  // Лента писем — со своей прокруткой, на последнем письме и без писем пустая.
  const letters = code(read(`${PULT}/PultLetters.svelte`))
  assert.match(letters, /\{#if letters\.length > 0\}/, 'пустая лента занимает место')
  assert.match(letters, /box\.scrollTop = box\.scrollHeight/, 'лента открывается не на последнем письме')
  assert.match(letters, /max-height: min\(30dvh, \d+px\); overflow-y: auto/)
})

test('удалить с занятия — не самая крупная кнопка в шапке работы', () => {
  // Самое разрушительное действие в окне стояло красной рамкой рядом с именем
  // и было заметнее всего остального. Меню «⋯», подтверждение — прежнее.
  assert.match(WORK, /aria-haspopup="menu"/)
  assert.match(WORK, /role="menu"/)
  assert.match(WORK, /data-pult-remove/, 'кнопки «удалить» в пульте нет')
  assert.doesNotMatch(WORK, /pult-button--danger[^>]*data-pult-remove/, 'красная кнопка вернулась в шапку')
})

test('вывод подписан тем, кто запускал, и окрашен исходом', () => {
  assert.match(WORK, /data-tone=\{execution\?\.tone\}/)
  assert.match(WORK, /run\.by === 'host' \? tr\('room\.ui\.61'\) : tr\('room\.pult\.v2\.ranByAuthor'\)/)
  // «запускали вы» — строка автора; в пульте смотрит преподаватель, и «вы»
  // называло бы запускавшим его самого.
  assert.doesNotMatch(WORK, /room\.ui\.1061/)
  assert.match(WORK, /execution\.label/, 'явная подпись запуска')
})

/* ------------------------------- что переехало из тетради вместе с консолью */

test('письмо пишут автору работы, и адресата у него больше нет другого', () => {
  /*
   * Рядом с полем стояла кнопка «Всем N»: то же письмо уходило всей группе
   * одинаковых ответов, и к ней прилагался черновик от оракула. 20.09
   * группировку убрали из пульта целиком, и письмо группе ушло вместе с ней —
   * замены ему не придумывали.
   */
  assert.match(WINDOW, /\{ participantId: current\.participantId \}/)
  assert.doesNotMatch(WINDOW, /groupKey/, 'адрес письма всё ещё знает про группы')
  assert.doesNotMatch(WINDOW, /toGroup/)
  assert.doesNotMatch(REPLY, /toGroup|groupSize|hasDraft/, 'переключатель группы остался в поле')
  assert.doesNotMatch(REPLY, /room\.ui\.1333/, '«Всем N» осталось кнопкой')
  // Строка под полем — что в поле стоит черновик оракула, а не своё: он уходит
  // от имени преподавателя, и палец обязан пройти через поле.
  assert.match(WINDOW, /fromOracle: true|replyFromOracle/)
  assert.match(REPLY, /\{#if fromOracle\}/)
  assert.match(REPLY, /tr\('room\.ui\.30'\)/, 'не сказано, чей это текст')
})

test('группировки в пульте нет нигде: ни в списке, ни в работе, ни в поле', () => {
  // «Эту группировку по типам решения я бы убрал к хуям собачьим» — 20.09.
  // Убрана она целиком, а не спрятана за настройку, и проверяется это по всем
  // четырём местам, где она была видна.
  const pult = code(read('web/src/lib/council-pult.ts'))
  assert.doesNotMatch(pult, /neighbourInGroup/, 'стрелки по группе остались')
  assert.doesNotMatch(pult, /kind: 'collapsed'|kind: 'header'/, 'строки группы остались в сборке')
  assert.doesNotMatch(pult, /'groups'/, 'чип отбора «группы» остался')
  assert.doesNotMatch(LIST, /row\.groupKey|row\.faces|ontoggle/, 'список всё ещё сворачивает')
  assert.doesNotMatch(read('web/src/components/council/pult/PultRow.svelte'), /same|inGroup/)
  assert.doesNotMatch(WORK, /groupIndex|room\.ui\.1323|workSame/)
  // Номера вариантов при выключенных именах остаются: это подпись человека, а
  // не признак группы, и она обязана совпадать с тем, что видит зал.
  assert.match(pult, /export function variantNumbers/)
})

// Recipient changes, retained drafts and actual sends are verified in the browser audit.

test('удалить с занятия можно из работы — меню «⋯» и общее меню бана', () => {
  assert.match(WORK, /data-pult-remove/, 'кнопки «удалить» в пульте нет')
  assert.match(WORK, /data-pult-remove[^>]*>[\s\S]*?tr\('room\.ui\.78'\)[\s\S]*?<\/button>/)
  assert.match(WINDOW, /import \{ askToBan, banTargetOf \} from '@\/lib\/bans'/)
  assert.match(WINDOW, /askToBan\(banTargetOf\(attempt, event\)\)/)
})

/**
 * Опасное действие ушло из строки очереди в меню «⋯» — и это решение владельца.
 *
 * «Я вижу только первые несколько строк и могу сразу убрать его с занятия, что
 * не совсем честно по отношению к участникам» (20.09). Раньше у чужой записи в
 * очереди стояла ровно одна кнопка, и та — «Удалить с занятия»: снять с пары
 * было ЛЕГЧЕ, чем прочитать код. Теперь строка целиком открывает работу, а
 * снятие человека лежит под «⋯» рядом со своим соразмерным соседом — «снять
 * запуск».
 */
test('в строке очереди нет кнопки «удалить»: она под «⋯» рядом со «снять запуск»', () => {
  assert.match(QUEUE, /onremove: \(attempt: CouncilAttempt, event: MouseEvent\) => void/)
  assert.match(QUEUE, /ondrop: \(attempt: CouncilAttempt\) => void/)
  assert.equal(
    QUEUE.match(/data-pult-remove/g)?.length,
    undefined,
    'опасная кнопка снова стоит в строке очереди',
  )
  // Меню — общее на всю комнату, а не своё: клавиатура, кромки окна и нижний
  // лист на пальце уже решены там один раз.
  assert.match(QUEUE, /import ContextMenu, \{ type ContextMenuItem \} from '@\/components\/ui\/ContextMenu\.svelte'/)
  assert.match(QUEUE, /label: tr\('room\.pult\.v3\.queue\.drop'\)/)
  assert.match(QUEUE, /label: tr\('room\.ui\.78'\),\s*icon: 'trash',\s*danger: true/)
  // Кнопка «⋯» — у каждого вида записи, где раньше стояло «удалить»: у просьбы
  // и у стоящего в очереди. У выполняющегося её нет: его строка — карточка с
  // «Прервать», и человека с неё не снимают.
  assert.equal(QUEUE.match(/data-pult-more/g)?.length, 2)
  assert.match(WINDOW, /onremove=\{remove\}/)
  assert.match(WINDOW, /ondrop=\{dropRun\}/)
})

/**
 * Строка очереди — кнопка, открывающая работу. По ней и просили: «не могу во
 * вкладке очереди посмотреть на каждый конкретный запуск, нажав просто на
 * него».
 */
test('по записи очереди можно нажать и перейти к работе', () => {
  assert.match(QUEUE, /data-pult-queued-open/)
  assert.match(QUEUE, /onclick=\{\(\) => onopen\(attempt\.participantId\)\}/)
  assert.match(QUEUE, /aria-label=\{tr\('room\.pult\.v3\.queue\.openRow', \{ name: who\(attempt\) \}\)\}/)
  // И сколько человек ждёт — числом: «в очереди 4» без движения не отвечает,
  // идёт ли она вообще.
  assert.match(QUEUE, /room\.pult\.v3\.queue\.waitingFor/)
  // Снять запуск умеет и состояние комнаты, и сервер.
  assert.match(read('web/src/lib/council.svelte.ts'), /dropRun\(cellId: string, participantId: string\)/)
  assert.match(read('server/src/control.ts'), /case 'council:run:drop': \{/)
})

/**
 * Очередь у ТЕТРАДИ, а не у ячейки: пульт обязан видеть чужую работу, которая
 * её держит, и уметь её прервать.
 */
test('пульт считает очередь тетради и прерывает то, что её держит', () => {
  assert.match(QUEUE, /kernelIsBusy|queuedInBook/)
  assert.match(QUEUE, /room\.pult\.v3\.queue\.countsBook/)
  assert.match(QUEUE, /room\.pult\.v3\.queue\.busyCell/)
  assert.match(QUEUE, /room\.pult\.v3\.queue\.busyOther/)
  // Кнопка «Прервать» — вне ветки «своя попытка»: она нужна ровно тогда, когда
  // очередь держит ЧУЖАЯ работа.
  assert.match(QUEUE, /\{#if busy\}/)
  assert.match(QUEUE, /data-pult-restart/)
  assert.match(QUEUE, /room\.pult\.v3\.queue\.stuck/)
  const pult = code(read('web/src/lib/council-pult.ts'))
  assert.match(pult, /export function queuedInBook/)
  assert.match(pult, /export function kernelIsBusy/)
  assert.match(read('shared/protocol.ts'), /export interface CouncilKernel/)
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

/* ------------------------------------------------------------ телефон */

test('на телефоне пульт — два экрана, а не две колонки', () => {
  /*
   * «Пульт на телефоне вообще полное говно неудобное, пролистать список всех
   * студентов невозможно» — 19.09. Две колонки в 390 px: под шапкой,
   * вкладками, полосой, счётчиками, поиском и чипами списку оставалось
   * полстроки. Теперь список во весь экран, нажатие открывает работу во весь
   * экран, системный «назад» возвращает к списку — и не закрывает пульт.
   */
  assert.match(WINDOW, /matchMedia\('\(max-width: 650px\)'\)/, 'порог узкого окна читается не из matchMedia')
  assert.match(WINDOW, /let phonePane = \$state<'list' \| 'work'>\('list'\)/)
  assert.match(WINDOW, /history\.pushState\(\{ \.\.\.\(history\.state \?\? \{\}\), pultPane: 'work' \}, '', location\.href\)/)
  assert.match(WINDOW, /addEventListener\('popstate'/, 'жест «назад» не слушают')
  assert.match(WINDOW, /history\.back\(\)/, '«‹ Работы» уходит мимо истории')
  // Экраны переключает разметка, а не перестроение: адрес пульта — ячейка.
  assert.match(WINDOW, /data-pult-pane=\{pane\}/)
  assert.match(WINDOW, /\[data-pult-pane='work'\] \.pult-sidebar \{ display:none; \}/)
  assert.match(WINDOW, /\[data-pult-pane='list'\] \.pult-work-pane \{ display:none; \}/)
  // Планка работы: назад, имя, место в ленте, стрелки к соседним работам.
  assert.match(WINDOW, /room\.pult\.v3\.backToList/)
  assert.match(WINDOW, /room\.pult\.v3\.prevWork/)
  assert.match(WINDOW, /room\.pult\.v3\.nextWork/)
  assert.match(WINDOW, /\.pult-root \{ height:100dvh; \}/, 'адресная строка браузера срежет док')
  // Список листается пальцем, а не колесом.
  assert.match(LIST, /overscroll-behavior: contain; -webkit-overflow-scrolling: touch/)
  // Подсказка о клавишах на телефоне не занимает места: клавиш там нет.
  const status = code(read(`${PULT}/PultStatusLine.svelte`))
  assert.match(status, /@media\(max-width:650px\) \{ \.pult-status \{ display:none; \} \}/)
})

test('четыре действия на телефоне — равной ширины и в палец высотой', () => {
  assert.match(ACTIONS, /min-height: 44px/, 'цель нажатия ниже пальца')
  assert.match(ACTIONS, /\.act-short \{ display: none; \}/, 'коротких подписей нет вовсе')
  for (const key of ['shortShow', 'shortClear', 'shortRun', 'shortCorrect', 'shortRevise']) {
    assert.match(ACTIONS, new RegExp(`room\\.pult\\.v3\\.${key}`), `короткой подписи «${key}» нет`)
  }
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

test('меню ячеек: одна тетрадь — имя в шапке, несколько — в каждой строке', () => {
  const cells = code(read('web/src/components/council/pult/PultCells.svelte'))
  // Две девятых ячейки из разных тетрадей неразличимы по номеру — значит имя
  // тетради обязано стоять в строке, как только тетрадей больше одной.
  assert.match(cells, /const manyBooks = \$derived\(books\.length > 1\)/)
  assert.match(cells, /\{#if manyBooks && cell\.book\}/)
  assert.match(cells, /class="pult-cells-book"/)
  // А пока тетрадь одна, имя стоит один раз в шапке и не шумит в строках.
  assert.match(cells, /const book = \$derived\(books\.length === 1 \? books\[0\] : ''\)/)
})
