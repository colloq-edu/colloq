/**
 * Пульт v3: три места, которые владелец утвердил по макетам 20.09.
 *
 * Paper 05d, артборды «11 · v3 · Работы» и «12 · v3 · детали». Меняются три
 * вещи, и каждая из них ломается молча:
 *
 *  1. ШАПКА РАБОТЫ. В ряд стояли четыре разнородных куска — залитая плашка
 *     «СДАНО 15:19», голый текст «не в сети», плашка оценки и «2 / 13», причём
 *     «сдано» звучало дважды. Ролей должно быть три: кто · что с работой · где
 *     я в стопке, и у состояния ровно ЧЕТЫРЕ значения.
 *  2. ВЫБОР ЯЧЕЙКИ. «Ячейка 60» и «ячейка 65» в меню неразличимы; название
 *     задания выводится из текста ячейки правилом, которое проверяется здесь,
 *     а не глазами на стенде.
 *  3. ВКЛАДКИ СПИСКА. У сдавших и пишущих разные вопросы, разные отборы и
 *     разный ПОРЯДОК: у первых лента сдач, у вторых — список тревог.
 *
 * И четвёртое, пришедшее тем же днём: пульт на перезагрузке мигал «ячейка не в
 * консилиуме» между заставкой и собой, потому что `board === null` означал
 * сразу «жду» и «нет».
 */
import fs from 'node:fs'
import path from 'node:path'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { CouncilAttempt, CouncilBoard } from '../shared/protocol.js'
import { COUNCIL_SILENCE_MS } from '../shared/notebook.js'
import {
  attemptReview,
  byAlarm,
  cellHeadline,
  cellNotes,
  cellTaskTitle,
  draftAlarm,
  draftLine,
  filterCounts,
  filterInTab,
  listRows,
  markdownHeadline,
  neighbourCell,
  othersWaiting,
  pultCells,
  pultKeyAction,
  pultShortcutAllowed,
  selectable,
  tabCounts,
  tabFilters,
} from '../web/src/lib/council-pult.js'
import { boardPhase, WELCOME_WAIT_MS } from '../web/src/lib/council.svelte.js'

function read(rel: string): string {
  return fs.readFileSync(path.resolve(import.meta.dirname, '..', rel), 'utf8')
}
/** Разметка без комментариев: объяснение — не обещание. */
function code(source: string): string {
  return source.replace(/<!--[\s\S]*?-->/g, '').replace(/\/\*[\s\S]*?\*\//g, '')
}
const PULT = 'web/src/components/council/pult'
const WORK = code(read(`${PULT}/PultWork.svelte`))
const WINDOW = code(read(`${PULT}/PultWindow.svelte`))
const FILTERS = code(read(`${PULT}/PultFilters.svelte`))
const CELLS = code(read(`${PULT}/PultCells.svelte`))
const KEYS = code(read(`${PULT}/PultKeys.svelte`))

const T = 1_700_000_000_000
const NONE = new Set<string>()

function attempt(over: Partial<CouncilAttempt> & { participantId: string }): CouncilAttempt {
  const text = over.text ?? 'print(1)'
  return {
    participantId: over.participantId,
    name: over.name ?? over.participantId,
    color: '#4C7FE0',
    avatar: null,
    text,
    submittedAt: over.submittedAt === undefined ? T : over.submittedAt,
    updatedAt: over.updatedAt ?? T,
    status: over.status ?? 'unrun',
    run: over.run ?? null,
    reply: null,
    replies: over.replies,
    correct: over.correct ?? null,
    shown: over.shown ?? false,
    groupKey: over.groupKey ?? text.replace(/\s+/g, ''),
    runRequest: over.runRequest ?? null,
  }
}

/* ------------------------------------------------- 1 · шапка работы */

test('состояние работы — одна плашка и ровно четыре значения', () => {
  /*
   * Было две плашки на одну мысль: «СДАНО 15:19» акцентом и рядом оценка
   * «Сдано · ждёт оценки». Слово «сдано» стояло дважды, а различить сданное от
   * черновика всё равно приходилось по наличию второй плашки.
   */
  const waiting = attemptReview({ submittedAt: T, correct: null })
  const right = attemptReview({ submittedAt: T, correct: true })
  const revise = attemptReview({ submittedAt: T, correct: false })
  const draft = attemptReview({ submittedAt: null, correct: null })
  const all = [waiting, right, revise, draft]
  assert.equal(new Set(all.map((one) => one.label)).size, 4, 'четыре состояния — четыре разных слова')
  // Залита ровно одна — та, что требует руки преподавателя. Заливка в этом окне
  // значит «от вас чего-то ждут», и двух таких быть не может.
  assert.deepEqual(all.map((one) => one.shape ?? null), ['fill', null, null, 'outline'])
  assert.deepEqual(all.map((one) => one.tone), ['accent', 'positive', 'warning', 'neutral'])
  // «Сдано» из слова ушло: время сдачи теперь в тихой строке под именем.
  assert.doesNotMatch(waiting.label, /сдано/i)

  // И в шапке она одна: прежние `.work-state` + `.work-review` слились.
  assert.match(WORK, /class="pult-badge work-state" data-tone=\{review\?\.tone\} data-shape=\{review\?\.shape\}/)
  assert.doesNotMatch(WORK, /data-pult-review/, 'вторая плашка в шапке вернулась')
  assert.doesNotMatch(WORK, /room\.pult\.v3\.workSubmitted/, '«СДАНО 15:19» вернулось отдельной плашкой')
  assert.match(WORK, /<span class="pult-badge-dot"/, 'точки слева в плашке нет')
})

test('тихая строка под именем: время без рода и присутствие без выдуманного часа', () => {
  /*
   * Род глагола по имени в продукте не выводится нигде, и здесь тоже: «сдано в
   * 15:19» верно для всех. Часа ухода из сети у клиента НЕТ: присутствие
   * приезжает живым набором Yjs (session.peersById), `participants.last_seen`
   * живёт в базе сервера, `presence.left` — запись журнала активности. Поэтому
   * «не в сети», а не «не в сети с 15:24».
   */
  assert.match(WORK, /room\.pult\.v3\.head\.submitted/)
  assert.match(WORK, /presence !== 'unknown'/, 'неизвестное присутствие обязано молчать')
  const ru = read('shared/locales/room.ts')
  assert.match(ru, /"room\.pult\.v3\.head\.submitted": \{"ru": "сдано в \{time\}"/)
  assert.doesNotMatch(ru, /"ru": "не в сети с \{/, 'времени ухода клиенту не везут — выдумывать его нечем')
  for (const word of ['сдал(а)', 'сдала', 'правила ']) {
    assert.ok(!ru.includes(`"ru": "${word}`), `род по имени: ${word}`)
  }
})

test('листалка ходит по видимому списку и гаснет на краях', () => {
  // Кнопки обязаны делать ровно то же, что j / k: тот же `step`, тот же
  // `moveCursor` по тем же строкам. Иначе «1 из 13» считает одно, а стрелка
  // ведёт в другое.
  assert.match(WINDOW, /function step\(delta: 1 \| -1\): void \{\s*const next = moveCursor\(rows, cursor, delta\)/)
  assert.match(WINDOW, /onstep=\{step\}/)
  assert.match(WORK, /disabled=\{index <= 1\} onclick=\{\(\) => onstep\(-1\)\}/)
  assert.match(WORK, /disabled=\{index >= total\} onclick=\{\(\) => onstep\(1\)\}/)
  // На телефоне листалки нет: там по ленте ходят стрелками планки экрана
  // работы, а возврат к списку — жестом.
  assert.match(WORK, /\{#if !phone\}\s*<div class="work-pager"/)
})

test('счётчик листалки считает в пределах текущей вкладки и отбора', () => {
  const list = [
    attempt({ participantId: 'a', submittedAt: T + 3 }),
    attempt({ participantId: 'b', submittedAt: T + 2, correct: true }),
    attempt({ participantId: 'c', submittedAt: T + 1, correct: false }),
    attempt({ participantId: 'd1', submittedAt: null, updatedAt: T }),
    attempt({ participantId: 'd2', submittedAt: null, updatedAt: T }),
  ]
  const shown = (tab: 'submitted' | 'writing' | 'all', filter: 'all' | 'ungraded' = 'all'): string[] =>
    selectable(listRows({ attempts: list, tab, filter, search: '', unread: NONE, held: NONE, now: T }))
  assert.equal(shown('all').length, 5)
  assert.equal(shown('submitted').length, 3)
  assert.equal(shown('writing').length, 2)
  // Отбор режет дальше: «1 из 1», а не «1 из 5».
  assert.deepEqual(shown('submitted', 'ungraded'), ['a'])
  // Именно из этого списка пульт и берёт числа шапки.
  assert.match(WINDOW, /const ids = \$derived\(selectable\(rows\)\)/)
  assert.match(WINDOW, /const place = \$derived\(cursor === null \? 0 : ids\.indexOf\(cursor\) \+ 1\)/)
  assert.match(WINDOW, /index=\{place\}\s*total=\{ids\.length\}/)
})

/* ------------------------------------------------- 2 · выбор ячейки */

test('название задания: комментарий с декором, код с заголовком выше, и пусто', () => {
  // Комментарий: решётки и рамка снимаются, служебный префикс тоже.
  assert.equal(cellHeadline('# Важность признаков\nimp = clf.feature_importances_'), 'Важность признаков')
  assert.equal(cellHeadline('# ═══════════════\n# Важность признаков\n# ═══════════════\ncode()'), 'Важность признаков')
  assert.equal(cellHeadline('#### ---- Важность признаков ----'), 'Важность признаков')
  assert.equal(cellHeadline('# ЯЧЕЙКА СТУДЕНТА · Важность признаков'), 'Важность признаков')
  // Одно слово капсом перед точкой — это НАЗВАНИЕ, а не префикс: «S5E12 ·
  // минимум» в меню обязано остаться собой.
  assert.equal(cellHeadline('# S5E12 · минимум'), 'S5E12 · минимум')
  // Первая непустая строка кодом — названия в ячейке нет, и выдумывать его из
  // кода нельзя: «imp = clf.feature_importances_» хуже честной «ячейки 03».
  assert.equal(cellHeadline('\n\nimp = clf.feature_importances_\n# поздний комментарий'), '')
  assert.equal(cellHeadline(''), '')
  // Тогда подписью служит ЗАГОЛОВОК markdown-ячейки над этой — и только он.
  assert.equal(markdownHeadline('## Важность признаков\n\nПосчитайте…'), 'Важность признаков')
  // Живая ячейка семинара: абзац, а под ним заголовок задания. Название —
  // второе, и берётся последний заголовок: он ближе всего к коду под ним.
  assert.equal(
    markdownHeadline('Остались пропуски только в числовых признаках (`GarageYrBlt`).\n\n### Задача 1\n\nИсследуйте…'),
    'Задача 1',
  )
  // Заголовка нет — названия нет: абзац в роли названия хуже честной «ячейки NN».
  assert.equal(markdownHeadline('\nПросто абзац без заголовка'), '')
  assert.equal(markdownHeadline('   '), '')
  // И запасное слово — прежняя «ячейка NN», а без номера общее имя.
  assert.equal(cellTaskTitle({ title: 'Важность признаков', index: 3 }), 'Важность признаков')
  assert.equal(cellTaskTitle({ title: '  ', index: 3 }), 'ячейка 03')
  assert.equal(cellTaskTitle({ title: '', index: null }), 'Консилиум')
  // Пульт собирает это в одном месте — там же, где номер и тетрадь.
  assert.match(WINDOW, /title: cellHeadline\(text\) \|\| above/)
  assert.match(WINDOW, /const heading = markdownHeadline\(text\)/)
  assert.match(CELLS, /cellTaskTitle\(cell\)/)
})

function board(over: Partial<CouncilBoard> = {}): CouncilBoard {
  return {
    cellId: 'c',
    lock: 'council',
    settings: { studentRun: 'free', runLimitSec: 30, rerunPauseSec: 0, namesOnProjector: true },
    counts: { attempts: 3, submitted: 2, writing: 1, groups: 1 },
    attempts: [],
    groups: [],
    oracle: null,
    ...over,
  } as CouncilBoard
}

test('строка меню считает то, за чем в ячейку идут, — из досок, без сервера', () => {
  const running = attempt({
    participantId: 'r',
    run: { state: 'running', outputs: [], execCount: 1, ranMs: null, startedAt: T, by: 'host' },
  })
  const queued = attempt({
    participantId: 'q',
    run: { state: 'queued', outputs: [], execCount: 1, ranMs: null, startedAt: T, by: 'host' },
  })
  const asking = attempt({
    participantId: 'a',
    submittedAt: null,
    runRequest: { id: '1', status: 'pending', requestedAt: T },
  })
  const graded = attempt({ participantId: 'g', correct: true })
  const cells = pultCells([
    { cellId: 'busy', index: 5, title: 'S5E12 · минимум', book: '', lock: 'council', counts: board().counts,
      room: { submitted: 6, total: 19 }, attempts: [running, queued, asking, graded], onScreen: true },
    { cellId: 'calm', index: 2, title: 'Rohlik · минимум', book: '', lock: 'council', counts: board().counts,
      room: { submitted: 22, total: 24 }, attempts: [graded], onScreen: false },
    { cellId: 'shut', index: 1, title: 'Разминка', book: '', lock: 'open', counts: board().counts,
      room: { submitted: 24, total: 24 }, attempts: [attempt({ participantId: 'x' })], onScreen: false },
  ])
  const busy = cells.find((cell) => cell.cellId === 'busy')!
  assert.equal(busy.waiting, 2, 'сданные без отметки: running и queued')
  assert.equal(busy.asking, 1)
  assert.equal(busy.queued, 1)
  assert.equal(busy.running, true)
  assert.deepEqual(
    cellNotes(busy).map((note) => note.text),
    ['2 ждут оценки', '1 просит запуск', 'идёт запуск · 1 в очереди', 'на экране'],
  )
  assert.equal(cellNotes(busy)[0].tone, 'accent', 'ждут оценки — единственное, что требует руки')
  assert.equal(cellNotes(busy).at(-1)?.chip, true, '«на экране» — плашка, а не счёт')
  // Разобранная ячейка говорит об этом словом: пустая строка читалась бы как
  // «не догрузилось».
  assert.deepEqual(cellNotes(cells.find((cell) => cell.cellId === 'calm')!).map((one) => one.text), ['все сданные оценены'])
  // Закрытый консилиум — одним куском и вместо всего остального.
  assert.deepEqual(
    cellNotes(cells.find((cell) => cell.cellId === 'shut')!).map((one) => one.text),
    ['консилиум закрыт · только просмотр'],
  )
  // И сколько ДРУГИХ ячеек ждут оценки — подпись рядом с кнопкой; ноль не
  // пишется вовсе. Закрытая не считается: её строка в меню чисел не показывает,
  // и звать туда подписью, которой в меню не соответствует ничего, нельзя.
  assert.equal(othersWaiting(cells, 'calm'), 1)
  assert.equal(othersWaiting(cells, 'busy'), 0)
  assert.equal(othersWaiting(cells, 'shut'), 1)
})

test('клавиши [ и ] ведут по тому же порядку, что меню, и не заворачивают', () => {
  const cells = pultCells([
    { cellId: 'b', index: 5, book: '', lock: 'council', counts: board().counts, room: null, attempts: [], onScreen: false },
    { cellId: 'a', index: 2, book: '', lock: 'council', counts: board().counts, room: null, attempts: [], onScreen: false },
    { cellId: 'c', index: 9, book: '', lock: 'council', counts: board().counts, room: null, attempts: [], onScreen: false },
  ])
  assert.deepEqual(cells.map((one) => one.cellId), ['a', 'b', 'c'])
  assert.equal(neighbourCell(cells, 'a', 1), 'b')
  assert.equal(neighbourCell(cells, 'b', -1), 'a')
  assert.equal(neighbourCell(cells, 'c', 1), null, 'на краю круг не замыкается')
  assert.equal(neighbourCell(cells, 'a', -1), null)
  assert.equal(neighbourCell(cells, 'ghost', 1), null)

  assert.equal(pultKeyAction({ key: '[' }, 'list'), 'prevCell')
  assert.equal(pultKeyAction({ key: ']' }, 'list'), 'nextCell')
  // Русская раскладка — те же клавиши.
  assert.equal(pultKeyAction({ key: 'х' }, 'list'), 'prevCell')
  assert.equal(pultKeyAction({ key: 'ъ' }, 'list'), 'nextCell')
  // В поле ответа набирают текст, и скобка там — скобка.
  assert.equal(pultKeyAction({ key: '[' }, 'reply'), null)
  // Ячейка — правило окна, а не открытой работы: из очереди и от оракула
  // переключаются так же часто.
  assert.equal(pultShortcutAllowed('nextCell', 'queue', false), true)
  assert.equal(pultShortcutAllowed('prevCell', 'oracle', false), true)
  assert.equal(pultShortcutAllowed('nextCell', 'work', false, true), false, 'за открытым меню клавиш нет')
  // Переход — адресом, тем же, что выбор из меню.
  assert.match(WINDOW, /const next = neighbourCell\(cells, cellId, action === 'nextCell' \? 1 : -1\)\s*\n\s*if \(next !== null\) onpick\(next\)/)
  // И в справке по клавишам о них сказано.
  assert.match(KEYS, /keys: \['\[', '\]'\]/)
  assert.match(KEYS, /room\.pult\.v3\.keys\.cells/)
})

test('косая открывает поиск, и лупа делает то же самое', () => {
  assert.equal(pultKeyAction({ key: '/' }, 'list'), 'search')
  assert.equal(pultKeyAction({ key: '/' }, 'reply'), null, 'в письме косая — знак')
  assert.match(FILTERS, /data-pult-search-open/)
  assert.match(FILTERS, /room\.pult\.v3\.openSearch/)
})

/* ------------------------------------------------- 3 · вкладки списка */

test('вкладка «Пишут» стоит по тревоге: молчат, упало, просят запуск, остальные', () => {
  const silent = attempt({ participantId: 'silent', submittedAt: null, updatedAt: T - COUNCIL_SILENCE_MS - 60_000 })
  const older = attempt({ participantId: 'older', submittedAt: null, updatedAt: T - COUNCIL_SILENCE_MS - 600_000 })
  const failed = attempt({
    participantId: 'failed',
    submittedAt: null,
    updatedAt: T - 10_000,
    run: { state: 'error', outputs: [], execCount: 1, ranMs: 30, startedAt: T - 20_000, by: 'author' },
  })
  const asking = attempt({
    participantId: 'asking',
    submittedAt: null,
    updatedAt: T - 5_000,
    runRequest: { id: '1', status: 'pending', requestedAt: T - 40_000 },
  })
  const typing = attempt({ participantId: 'typing', submittedAt: null, updatedAt: T - 1_000 })
  const list = [typing, asking, failed, silent, older]

  assert.equal(draftAlarm(silent, T), 'silent')
  assert.equal(draftAlarm(failed, T), 'failed')
  assert.equal(draftAlarm(asking, T), 'asking')
  assert.equal(draftAlarm(typing, T), 'writing')
  // Попросивший запуск НЕ «молчит»: его лист стоит потому, что он ждёт нас.
  const quietAsker = attempt({
    participantId: 'q',
    submittedAt: null,
    updatedAt: T - COUNCIL_SILENCE_MS - 60_000,
    runRequest: { id: '2', status: 'pending', requestedAt: T - 30_000 },
  })
  assert.equal(draftAlarm(quietAsker, T), 'asking')

  assert.deepEqual(
    [...list].sort(byAlarm(T)).map((one) => one.participantId),
    ['older', 'silent', 'failed', 'asking', 'typing'],
    'внутри тревоги первым тот, кто ждёт дольше',
  )
  // И это порядок именно вкладки: «Сдали» остаётся лентой сдач.
  const sorted = (tab: 'writing' | 'all'): string[] =>
    selectable(listRows({ attempts: list, tab, filter: 'all', search: '', unread: NONE, held: NONE, now: T }))
  assert.deepEqual(sorted('writing'), ['older', 'silent', 'failed', 'asking', 'typing'])
  // В общем списке порядок прежний — лента сдач: несданные в хвосте и по id,
  // потому что времени сдачи у них нет и сортировать их по нему нечем.
  assert.deepEqual(sorted('all'), ['asking', 'failed', 'older', 'silent', 'typing'])
})

test('строка пишущего говорит одно из четырёх и не повторяет слово «Черновик»', () => {
  const silent = attempt({ participantId: 's', submittedAt: null, updatedAt: T - 7 * 60_000, text: 'a\nb' })
  const line = draftLine(silent, T)
  assert.match(line.label, /молчит 7 мин · 2 строки/)
  assert.equal(line.tone, 'warning')
  // Возраст называется одним разрядом, самым крупным: «1646 мин 28 с» — это то,
  // что стояло в списке до правки, и прочитать его нельзя.
  assert.match(draftLine(attempt({ participantId: 'n', submittedAt: null, updatedAt: T - 3 * 3600_000 }), T).label, /молчит 3 ч/)
  assert.match(draftLine(attempt({ participantId: 'd', submittedAt: null, updatedAt: T - 50 * 3600_000 }), T).label, /молчит 2 дн/)
  const failed = draftLine(
    attempt({
      participantId: 'f',
      submittedAt: null,
      run: { state: 'error', outputs: [{ kind: 'error', ename: 'KeyError', evalue: 'x', traceback: [] }], execCount: 1, ranMs: 1, startedAt: T, by: 'author' },
    }),
    T,
  )
  assert.match(failed.label, /KeyError/)
  assert.equal(failed.tone, 'danger')
  const asking = draftLine(
    attempt({ participantId: 'a', submittedAt: null, runRequest: { id: '1', status: 'pending', requestedAt: T - 40_000 } }),
    T,
  )
  assert.match(asking.label, /^просит запуск · ждёт 40 с$/, 'строка списка набирается со строчной, как соседние')
  assert.match(draftLine(attempt({ participantId: 'w', submittedAt: null, text: 'a\nb\nc' }), T).label, /пишет · 3 строки/)
})

test('порог молчания — одно число на оракула и на пульт', () => {
  // Разойдясь, две копии дали бы человека, который в сводке застрял, а в
  // списке пишет, — и спор был бы о том, какая цифра настоящая.
  assert.equal(COUNCIL_SILENCE_MS, 5 * 60_000)
  const server = read('server/src/ai/council.ts')
  assert.match(server, /const SILENCE_MS = COUNCIL_SILENCE_MS/)
  assert.doesNotMatch(server, /const SILENCE_MS = \d/, 'вторая копия порога вернулась на сервер')
})

test('счётчики вкладок и чипов считают ровно то, что в них попадёт', () => {
  const unread = new Set(['fresh'])
  const list = [
    attempt({ participantId: 'fresh', submittedAt: T + 5 }),
    attempt({ participantId: 'graded', submittedAt: T + 4, correct: true }),
    attempt({ participantId: 'wrong', submittedAt: T + 3, correct: false }),
    attempt({ participantId: 'silent', submittedAt: null, updatedAt: T - COUNCIL_SILENCE_MS - 1000 }),
    attempt({ participantId: 'typing', submittedAt: null, updatedAt: T }),
  ]
  assert.deepEqual(tabCounts(list), { submitted: 3, writing: 2, all: 5 })
  const submitted = filterCounts(list, 'submitted', unread, T)
  assert.equal(submitted.all, 3)
  assert.equal(submitted.ungraded, 1, 'оценены двое, ждёт один')
  assert.equal(submitted.new, 1)
  assert.equal(submitted.error, 1, '«неверно» — тоже ошибка')
  const writing = filterCounts(list, 'writing', unread, T)
  assert.equal(writing.all, 2)
  assert.equal(writing.silent, 1)
  assert.equal(writing.failed, 0)
  assert.equal(writing.asking, 0)
  // Число чипа и длина списка под ним — одно и то же.
  for (const [tab, chips] of [['submitted', submitted], ['writing', writing]] as const) {
    for (const filter of tabFilters(tab)) {
      const rows = selectable(listRows({ attempts: list, tab, filter, search: '', unread, held: NONE, now: T }))
      assert.equal(rows.length, chips[filter], `${tab}/${filter}: чип обещает не то, что в списке`)
    }
  }
})

test('чужой чип при смене вкладки молча становится «Все»', () => {
  assert.equal(filterInTab('writing', 'ungraded'), 'all')
  assert.equal(filterInTab('submitted', 'silent'), 'all')
  assert.equal(filterInTab('submitted', 'error'), 'error')
  // Отбор помнится по вкладкам, а вкладка переживает перемонтаж окна.
  assert.match(WINDOW, /let filters = \$state<Record<PultTab, PultFilter>>/)
  assert.match(WINDOW, /let lastTab: 'submitted' \| 'writing' \| 'all' = 'submitted'/)
  assert.match(WINDOW, /let listTab = \$state<PultTab>\(lastTab\)/)
})

test('ряд чипов — одна строка на любой ширине, и в нём четыре чипа', () => {
  /*
   * Перенос ряда на вторую строку стоит списку одной работы, а в окне 900×650
   * их видно три. Поэтому `nowrap` без оговорок, а лишний чип («не запущены»)
   * из набора убран: в колонке 280 px он не помещался.
   */
  const css = read(`${PULT}/PultFilters.svelte`)
  assert.match(css, /\.pult-chips \{[^}]*flex-wrap:nowrap/)
  assert.doesNotMatch(css, /\.pult-chips \{[^}]*flex-wrap:wrap/)
  for (const tab of ['submitted', 'writing', 'all'] as const) {
    assert.ok(tabFilters(tab).length <= 4, `${tab}: чипов стало больше четырёх`)
    assert.equal(tabFilters(tab).includes('unrun'), false, 'чип «не запущены» вернулся в набор')
  }
})

/* --------------------------------------- 4 · «жду» против «здесь нет» */

test('пульт отличает «стопка ещё едет» от «консилиума тут нет»', () => {
  const ready = board()
  const settled = { settled: true, connected: true, council: false }
  assert.equal(boardPhase({ board: ready, ...settled }), 'ready')
  // Консилиум сняли и попыток не осталось — показывать нечего, и это «нет».
  assert.equal(
    boardPhase({ board: board({ lock: 'open', counts: { attempts: 0, submitted: 0, writing: 0, groups: 0 } }), ...settled }),
    'missing',
  )
  // Консилиум сняли, но попытки остались: их смотрят до конца занятия.
  assert.equal(boardPhase({ board: board({ lock: 'open' }), ...settled }), 'ready')
  // Пачка ещё едет — молчание не ответ.
  assert.equal(boardPhase({ board: null, settled: false, connected: true, council: false }), 'waiting')
  assert.equal(boardPhase({ board: null, ...settled }), 'missing')
  // Документ уже знает про консилиум, сокет ещё молчит: CRDT и сокет — разные
  // каналы, и «нет» тут было бы неправдой.
  assert.equal(boardPhase({ board: null, settled: true, connected: true, council: true }), 'waiting')
  // …но не вечно: без связи приехать ей неоткуда.
  assert.equal(boardPhase({ board: null, settled: true, connected: false, council: true }), 'missing')
})

test('пустое состояние больше не опирается на один board === null', () => {
  assert.match(WINDOW, /\{:else if board === null \|\| phase !== 'ready'\}/)
  assert.match(WINDOW, /\{#if phase === 'waiting'\}[\s\S]{0,200}<Splash size="pane"/, 'загрузка — та же заставка, что у комнаты')
  assert.doesNotMatch(WINDOW, /board === null \|\| \(board\.lock !== 'council'/, 'старая развилка вернулась')
  // Сторож: признак так и не пришёл — ждать перестаём и показываем что есть.
  assert.ok(WELCOME_WAIT_MS >= 5_000 && WELCOME_WAIT_MS <= 8_000)
  assert.match(WINDOW, /setTimeout\(\(\) => \(waited = true\), WELCOME_WAIT_MS\)/)
  assert.match(WINDOW, /settled: session\.council\.welcomed \|\| waited/)
  // И заставка приложения держится, пока пульт не знает, что рисовать.
  const screen = code(read('web/src/screens/SessionScreen.svelte'))
  assert.match(screen, /if \(councilPult && !councilKnown\) return\s*\n\s*firstScreenReady\(\)/)
  assert.match(screen, /session\.council\.welcomed/)
  // Признак поднимается кадром сервера и НЕ гаснет на разрыве: иначе вспышка
  // вернулась бы посреди занятия, у пульта, потерявшего сеть на секунду.
  const client = read('web/src/lib/council.svelte.ts')
  assert.match(client, /if \(message\.t === 'council:ready'\) \{\s*\n\s*this\.welcomed = true/)
  assert.doesNotMatch(client, /this\.welcomed = false/)
  assert.match(read('server/src/control.ts'), /send\(ws, \{ t: 'council:ready' \}\)/)
})
