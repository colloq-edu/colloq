/**
 * Мессенджер пульта консилиума — арифметика списка.
 *
 * Пульт живёт в отдельном окне и показывает ленту сдач: слева люди, справа
 * работа. Проверяется здесь ровно то, из-за чего такой список врёт молча.
 *
 *   порядок — по времени сдачи, свежие сверху, а НЕ по размеру группы (так
 *             ходила стопка под ячейкой, пока она была): два разных вопроса,
 *             и однажды они уже были одной функцией;
 *   группы  — от трёх одинаковых в списке стоит ОДИН, остальные за хвостом;
 *   курсор  — j и k перепрыгивают свёрнутое целиком: строка, которой на экране
 *             нет, не должна оказываться под Enter «показать классу»;
 *   держать — новая сдача не двигает строку под курсором; полоса «ещё N сдали»
 *             появляется только когда список прокручен или курсор не наверху;
 *   клавиши — в поле ответа клавиши ЕГО, в поиске стрелки продолжают ходить по
 *             списку, Enter на кнопке нажимает кнопку.
 *
 * И окно: «открыт ли пульт» тетрадь узнаёт стуком, а не ссылкой на окно, —
 * ссылку теряет перезагрузка тетради, а окно при этом живо. По тому же стуку
 * решается, что делать с кнопкой «Пульт ↗»: открыть, поднять или перевести
 * единственное окно комнаты на эту ячейку.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { groupAttempts } from '../shared/protocol.js'
import type { CouncilAttempt } from '../shared/protocol.js'
import {
  GROUP_MIN,
  bySubmissionDesc,
  classBar,
  heldArrivals,
  holdsArrivals,
  kernelView,
  listRows,
  matchesFilter,
  moveCursor,
  neighbourInGroup,
  pultKeyAction,
  requestReason,
  rowMeaning,
  selectable,
  unreadIds,
  variantNumbers,
} from '../web/src/lib/council-pult.js'
import {
  PULT_STALE_MS,
  beatsAlive,
  pultPath,
  pultReach,
  pultWindowName,
  windowFeatures,
} from '../web/src/lib/council-pult-window.js'

const T = 1_700_000_000_000

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

const NONE = new Set<string>()

function rows(attempts: CouncilAttempt[], over: Partial<Parameters<typeof listRows>[0]> = {}) {
  return listRows({
    attempts,
    groups: groupAttempts(attempts, {}),
    filter: 'all',
    search: '',
    unread: NONE,
    expanded: NONE,
    held: NONE,
    ...over,
  })
}

/* -------------------------------------------------------------- порядок */

test('лента идёт по времени сдачи, свежие сверху, пишущие — в конце', () => {
  const list = [
    attempt({ participantId: 'a', submittedAt: T + 1000, text: 'a' }),
    attempt({ participantId: 'b', submittedAt: T + 3000, text: 'b' }),
    attempt({ participantId: 'draft', submittedAt: null, text: 'c' }),
    attempt({ participantId: 'c', submittedAt: T + 2000, text: 'd' }),
  ]
  assert.deepEqual(
    [...list].sort(bySubmissionDesc).map((one) => one.participantId),
    ['b', 'c', 'a', 'draft'],
  )
  // И тот же порядок в собранных строках — сборка не пересортировывает своё.
  assert.deepEqual(selectable(rows(list)), ['b', 'c', 'a', 'draft'])
})

/* --------------------------------------------------------------- группы */

test('одинаковые ответы сворачиваются с трёх, и в ленте стоит один', () => {
  const same = (id: string, at: number) => attempt({ participantId: id, submittedAt: at, text: 'x = 1' })
  const pair = [same('a', T + 1), same('b', T + 2)]
  // Двое — это ещё не группа: сворачивать нечего, оба стоят в ленте.
  assert.equal(GROUP_MIN, 3)
  assert.deepEqual(selectable(rows(pair)), ['b', 'a'])

  const three = [...pair, same('c', T + 3)]
  const built = rows(three)
  assert.deepEqual(
    built.map((row) => row.kind),
    ['attempt', 'collapsed'],
    'в ленте один человек и хвост',
  )
  assert.equal(built[0].kind === 'attempt' && built[0].id, 'c', 'стоит самый свежий')
  assert.equal(built[1].kind === 'collapsed' && built[1].rest, 2)
  // Свёрнутые под курсор не попадают вовсе.
  assert.deepEqual(selectable(built), ['c'])
})

test('раскрытая группа даёт шапку и членов с отступом, и все они выбираются', () => {
  const list = ['a', 'b', 'c'].map((id, at) =>
    attempt({ participantId: id, submittedAt: T + at, text: 'x = 1' }),
  )
  const built = rows(list, { expanded: new Set(['x=1']) })
  assert.deepEqual(
    built.map((row) => row.kind),
    ['attempt', 'header', 'attempt', 'attempt'],
  )
  const header = built[1]
  assert.equal(header.kind === 'header' && header.count, 3)
  assert.equal(built[2].kind === 'attempt' && built[2].inGroup, true, 'член группы с отступом')
  assert.deepEqual(selectable(built), ['c', 'b', 'a'])
})

/* -------------------------------------------------------------- фильтры */

test('шесть чипов отбирают то, что обещают', () => {
  const grouped = new Set(['x=1'])
  const failed = attempt({ participantId: 'f', status: 'failed', run: null })
  const wrong = attempt({ participantId: 'w', status: 'wrong' })
  const ran = attempt({
    participantId: 'r',
    status: 'ran',
    run: { state: 'ok', outputs: [], execCount: 1, ranMs: 10, startedAt: T, by: 'host' },
  })
  const draft = attempt({ participantId: 'd', submittedAt: null })
  const inGroup = attempt({ participantId: 'g', text: 'x = 1' })
  const unread = new Set(['f'])

  assert.equal(matchesFilter(failed, 'error', unread, grouped), true)
  assert.equal(matchesFilter(wrong, 'error', unread, grouped), true, '«неверно» — тоже ошибка')
  assert.equal(matchesFilter(ran, 'error', unread, grouped), false)
  assert.equal(matchesFilter(ran, 'unrun', unread, grouped), false, 'запускали — значит не сюда')
  assert.equal(matchesFilter(failed, 'unrun', unread, grouped), true)
  assert.equal(matchesFilter(draft, 'writing', unread, grouped), true)
  assert.equal(matchesFilter(ran, 'writing', unread, grouped), false)
  assert.equal(matchesFilter(failed, 'new', unread, grouped), true)
  assert.equal(matchesFilter(ran, 'new', unread, grouped), false)
  assert.equal(matchesFilter(inGroup, 'groups', unread, grouped), true)
  assert.equal(matchesFilter(ran, 'groups', unread, grouped), false)
})

test('поиск идёт по имени и не путает регистр', () => {
  const list = [
    attempt({ participantId: 'a', name: 'Аня Соколова', text: 'a' }),
    attempt({ participantId: 'b', name: 'Марат Идрисов', text: 'b' }),
  ]
  assert.deepEqual(selectable(rows(list, { search: 'сокол' })), ['a'])
  assert.deepEqual(selectable(rows(list, { search: 'МАРАТ' })), ['b'])
  assert.deepEqual(selectable(rows(list, { search: '   ' })), ['a', 'b'], 'пробелы — не поиск')
})

/* ------------------------------------------------------ непрочитанное */

test('точка непрочитанного — только про сдавших после открытия окна и не про открытых', () => {
  const list = [
    attempt({ participantId: 'old', submittedAt: T - 1000 }),
    attempt({ participantId: 'new', submittedAt: T + 1000 }),
    attempt({ participantId: 'read', submittedAt: T + 2000 }),
    attempt({ participantId: 'draft', submittedAt: null }),
  ]
  const unread = unreadIds(list, T, new Set(['read']))
  assert.deepEqual([...unread], ['new'])
})

/* ---------------------------------------------------------- курсор */

test('j и k ходят по людям и перепрыгивают свёрнутую группу целиком', () => {
  const list = [
    attempt({ participantId: 'top', submittedAt: T + 10, text: 'top' }),
    ...['a', 'b', 'c'].map((id, at) => attempt({ participantId: id, submittedAt: T + at, text: 'x = 1' })),
    attempt({ participantId: 'bottom', submittedAt: T - 10, text: 'bottom' }),
  ]
  const built = rows(list)
  assert.deepEqual(selectable(built), ['top', 'c', 'bottom'])
  assert.equal(moveCursor(built, 'top', 1), 'c')
  assert.equal(moveCursor(built, 'c', 1), 'bottom')
  // На краях курсор стоит, а не заворачивается: список не карусель.
  assert.equal(moveCursor(built, 'bottom', 1), 'bottom')
  assert.equal(moveCursor(built, 'top', -1), 'top')
  // Курсора нет — первое нажатие обязано что-то выбрать.
  assert.equal(moveCursor(built, null, 1), 'top')
  assert.equal(moveCursor(built, null, -1), 'bottom')
  // Курсор на строке, которой в отборе больше нет, — к первой.
  assert.equal(moveCursor(built, 'a', 1), 'top')
  assert.equal(moveCursor([], 'top', 1), null)
})

test('стрелки ходят внутри одной группы и из неё не выводят', () => {
  const list = [
    ...['a', 'b', 'c'].map((id, at) => attempt({ participantId: id, submittedAt: T + at, text: 'x = 1' })),
    attempt({ participantId: 'alone', submittedAt: T + 9, text: 'y = 2' }),
  ]
  assert.equal(neighbourInGroup(list, 'c', 1), 'b')
  assert.equal(neighbourInGroup(list, 'b', 1), 'a')
  // Кольцом: последний ведёт к первому той же группы, а не наружу.
  assert.equal(neighbourInGroup(list, 'a', 1), 'c')
  assert.equal(neighbourInGroup(list, 'c', -1), 'a')
  assert.equal(neighbourInGroup(list, 'alone', 1), null, 'соседа у одиночки нет')
  assert.equal(neighbourInGroup(list, null, 1), null)
})

/* -------------------------------------------------- придержанные сдачи */

test('новые сдачи держатся, только когда есть что сдвинуть', () => {
  assert.equal(holdsArrivals(false, true), false, 'верх списка, курсор на первой — впускаем')
  assert.equal(holdsArrivals(true, true), true, 'список прокручен')
  assert.equal(holdsArrivals(false, false), true, 'курсор не на первой')
})

test('придержанное не трогает ни стоящих в списке, ни строку под курсором', () => {
  const list = [
    attempt({ participantId: 'standing', submittedAt: T + 5000, text: 'a' }),
    attempt({ participantId: 'cursor', submittedAt: T + 6000, text: 'b' }),
    attempt({ participantId: 'fresh', submittedAt: T + 7000, text: 'c' }),
    attempt({ participantId: 'old', submittedAt: T - 5000, text: 'd' }),
  ]
  const held = heldArrivals(list, T, new Set(['standing']), 'cursor')
  assert.deepEqual([...held], ['fresh'])
  // И придержанного в ленте нет — он и есть число на полосе.
  assert.deepEqual(selectable(rows(list, { held })), ['cursor', 'standing', 'old'])
})

/* -------------------------------------------------------------- клавиши */

test('в поле ответа клавиши его, а ⌘↵ отправляет', () => {
  assert.equal(pultKeyAction({ key: 'j' }, 'reply'), null)
  assert.equal(pultKeyAction({ key: 'Enter' }, 'reply'), null, 'голый Enter — перенос строки')
  assert.equal(pultKeyAction({ key: 'Enter', meta: true }, 'reply'), 'send')
  assert.equal(pultKeyAction({ key: 'Escape' }, 'reply'), 'escape')
  assert.equal(pultKeyAction({ key: '1' }, 'reply'), null, 'цифра в письме остаётся цифрой')
})

test('в поиске стрелки продолжают ходить по списку, а буквы набираются', () => {
  assert.equal(pultKeyAction({ key: 'ArrowDown' }, 'search'), 'next')
  assert.equal(pultKeyAction({ key: 'ArrowUp' }, 'search'), 'prev')
  assert.equal(pultKeyAction({ key: 'j' }, 'search'), null)
  assert.equal(pultKeyAction({ key: 'r' }, 'search'), null)
  assert.equal(pultKeyAction({ key: 'Enter' }, 'search'), 'show')
  assert.equal(pultKeyAction({ key: 'Escape' }, 'search'), 'escape')
})

test('буквы пульта работают в списке, а Enter на кнопке нажимает кнопку', () => {
  assert.equal(pultKeyAction({ key: 'j' }, 'list'), 'next')
  assert.equal(pultKeyAction({ key: 'k' }, 'list'), 'prev')
  assert.equal(pultKeyAction({ key: ' ' }, 'list'), 'toggleGroup')
  assert.equal(pultKeyAction({ key: 'Enter' }, 'list'), 'show')
  assert.equal(pultKeyAction({ key: 'Enter' }, 'actions'), null, 'иначе одно нажатие делает два дела')
  assert.equal(pultKeyAction({ key: 'R' }, 'list'), 'run')
  assert.equal(pultKeyAction({ key: '1' }, 'list'), 'correct')
  assert.equal(pultKeyAction({ key: '2' }, 'list'), 'wrong')
  assert.equal(pultKeyAction({ key: '3' }, 'list'), 'clearShown')
  assert.equal(pultKeyAction({ key: 'ArrowRight' }, 'list'), 'neighbourNext')
  assert.equal(pultKeyAction({ key: 'ArrowLeft' }, 'list'), 'neighbourPrev')
  assert.equal(pultKeyAction({ key: '?' }, 'list'), 'help')
  assert.equal(pultKeyAction({ key: 'f', meta: true }, 'list'), 'search')
  // Русская раскладка — те же клавиши: пульт держат в аудитории, где её никто
  // не переключает ради двух букв.
  assert.equal(pultKeyAction({ key: 'о' }, 'list'), 'next')
  assert.equal(pultKeyAction({ key: 'л' }, 'list'), 'prev')
  assert.equal(pultKeyAction({ key: 'а', meta: true }, 'list'), 'search')
  // Системные сочетания пульту не принадлежат: ⌘W закрывает окно.
  assert.equal(pultKeyAction({ key: 'w', meta: true }, 'list'), null)
})

/* ---------------------------------------------------------------- слова */

test('полоса смысла говорит, что требуется, а не что случилось', () => {
  const plain = attempt({ participantId: 'a' })
  const asking = attempt({
    participantId: 'b',
    runRequest: { id: 'r1', requestedAt: T, status: 'pending' },
  })
  assert.equal(rowMeaning(plain, null, null), 'none')
  assert.equal(rowMeaning(plain, 'a', null), 'cursor')
  assert.equal(rowMeaning(plain, 'a', 'a'), 'screen', 'зал важнее курсора')
  assert.equal(rowMeaning(asking, 'b', 'b'), 'asking', 'просьба важнее всего')
})

test('native button activation and modified arrows are not council shortcuts', () => {
  assert.equal(pultKeyAction({ key: ' ' }, 'actions'), null)
  assert.equal(pultKeyAction({ key: 'ArrowLeft', alt: true }, 'list'), null)
  assert.equal(pultKeyAction({ key: 'ArrowDown', ctrl: true }, 'list'), null)
  assert.equal(pultKeyAction({ key: 'r', composing: true }, 'list'), null)
})

test('повод для просьбы выводится из прошлого запуска и не сочиняется', () => {
  const clean = attempt({ participantId: 'a' })
  assert.equal(requestReason(clean), null)
  const failed = attempt({
    participantId: 'b',
    run: {
      state: 'error',
      outputs: [{ kind: 'error', ename: 'TypeError', evalue: 'bad', traceback: [] }],
      execCount: 1,
      ranMs: null,
      startedAt: T,
      by: 'author',
    },
  })
  assert.equal(requestReason(failed), 'TypeError в прошлый раз')
  // Упало без имени исключения — молчим: повод, по которому принимают решение,
  // выдумывать нельзя.
  const nameless = attempt({
    participantId: 'c',
    run: { state: 'error', outputs: [], execCount: 1, ranMs: null, startedAt: T, by: 'author' },
  })
  assert.equal(requestReason(nameless), null)
})

test('номер варианта идёт по времени сдачи и совпадает с подписью в зале', () => {
  const list = [
    attempt({ participantId: 'late', submittedAt: T + 200 }),
    attempt({ participantId: 'early', submittedAt: T + 100 }),
    attempt({ participantId: 'draft', submittedAt: null }),
  ]
  const numbers = variantNumbers(list)
  assert.equal(numbers.get('early'), 1)
  assert.equal(numbers.get('late'), 2)
  assert.equal(numbers.get('draft'), 3, 'пишущие — в хвосте нумерации, без дырок')
})

/* ----------------------------------------------------------- ядро и полоса */

test('полоса очереди читает стопку: кто считает, кто в очереди, кто просит', () => {
  const run = (state: 'running' | 'queued', at: number) => ({
    state,
    outputs: [],
    execCount: null,
    ranMs: null,
    startedAt: at,
    by: 'host' as const,
  })
  const list = [
    attempt({ participantId: 'now', run: run('running', T) }),
    attempt({ participantId: 'q2', run: run('queued', T + 20) }),
    attempt({ participantId: 'q1', run: run('queued', T + 10) }),
    attempt({ participantId: 'ask', runRequest: { id: 'r', requestedAt: T, status: 'pending' } }),
    attempt({ participantId: 'no', runRequest: { id: 'r2', requestedAt: T, status: 'declined' } }),
  ]
  const view = kernelView(list)
  assert.equal(view.running?.participantId, 'now')
  assert.deepEqual(view.queued.map((one) => one.participantId), ['q1', 'q2'], 'по времени постановки')
  assert.deepEqual(view.pending.map((one) => one.participantId), ['ask'], 'отклонённая не ждёт')
})

test('полоса «весь класс одной строкой» считает по статусам, а пишущих — отдельно', () => {
  const bar = classBar([
    attempt({ participantId: 'a', status: 'correct' }),
    attempt({ participantId: 'b', status: 'correct' }),
    attempt({ participantId: 'c', status: 'wrong' }),
    attempt({ participantId: 'd', status: 'failed' }),
    attempt({ participantId: 'e', submittedAt: null, status: 'correct' }),
  ])
  assert.equal(bar.correct, 2)
  assert.equal(bar.wrong, 1)
  assert.equal(bar.failed, 1)
  assert.equal(bar.writing, 1, 'черновик считается пишущим, что бы ни стояло в статусе')
})

/* ------------------------------------------------------------------ окно */

test('«пульт открыт» живёт стуком, а не ссылкой на окно', () => {
  const beat = { sessionId: 'kf3n8q2p', cellId: 'c1', at: T }
  assert.equal(beatsAlive(beat, T + 100), true)
  assert.equal(beatsAlive(beat, T + PULT_STALE_MS), false, 'молчание дольше трёх секунд — закрыт')
  assert.equal(beatsAlive({ ...beat, closed: true }, T), false, 'прощание не ждёт затухания')
  assert.equal(beatsAlive(null, T), false)
})

test('окно открывается по имени комнаты, всплывающим и заданного размера', () => {
  assert.equal(pultWindowName('kf3n8q2p'), 'colloq-council-pult-kf3n8q2p')
  assert.equal(pultPath('kf3n8q2p', 'cell-04'), '/s/kf3n8q2p/council/cell-04')
  const fresh = windowFeatures(null)
  // popup=yes обязателен: без него Chrome открывает ВКЛАДКУ и молча забывает
  // размеры, а пульт во вкладке — это второй раз та же тетрадь.
  assert.match(fresh, /popup=yes/)
  assert.match(fresh, /width=900/)
  assert.match(fresh, /height=700/)
  assert.doesNotMatch(fresh, /left=/, 'места ещё не знаем — координат в строке нет')
  const remembered = windowFeatures({ left: 120, top: 40, width: 1000, height: 800 })
  assert.match(remembered, /left=120/)
  assert.match(remembered, /top=40/)
  assert.match(remembered, /width=1000/)
})

test('кнопка «Пульт»: открыть, поднять или перевести — по последнему стуку', () => {
  const here = { sessionId: 'kf3n8q2p', cellId: 'c1', at: T }
  // Не стучится вовсе — окна нет, открываем.
  assert.equal(pultReach(null, 'c1', T), 'open')
  // Стучится, но давно: окно закрыли, а последняя весть осталась.
  assert.equal(pultReach(here, 'c1', T + PULT_STALE_MS), 'open')
  assert.equal(pultReach({ ...here, closed: true }, 'c1', T), 'open', 'попрощалось — значит закрыто')
  // Живо и по этой ячейке — поднять, не перезагружая: иначе стёрся бы отбор,
  // курсор и раскрытые группы, то есть весь способ смотреть.
  assert.equal(pultReach(here, 'c1', T + 100), 'focus')
  // Живо, но по другой ячейке — перевести его сюда: второе окно той же комнаты
  // было бы вторым местом с именами, ради чего окно и заводили.
  assert.equal(pultReach(here, 'c2', T + 100), 'navigate')
})

test('шапка раскрытой группы несёт её имя, а не только номер и счёт', () => {
  const list = [
    attempt({ participantId: 'a', text: 'x = 1', submittedAt: T + 3 }),
    attempt({ participantId: 'b', text: 'x = 1', submittedAt: T + 2 }),
    attempt({ participantId: 'c', text: 'x = 1', submittedAt: T + 1 }),
  ]
  const built = rows(list, { expanded: new Set([groupAttempts(list)[0].key]) })
  const header = built.find((row) => row.kind === 'header')
  assert.ok(header && header.kind === 'header')
  assert.equal(header.count, 3)
  assert.equal(header.label, 'x = 1', 'шапка не говорит, ЧТО написали эти трое')
})
