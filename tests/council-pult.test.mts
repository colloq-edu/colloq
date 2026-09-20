/**
 * Мессенджер пульта консилиума — арифметика списка.
 *
 * Пульт живёт в отдельном окне и показывает ленту сдач: слева люди, справа
 * работа. Проверяется здесь ровно то, из-за чего такой список врёт молча.
 *
 *   порядок — по времени сдачи, свежие сверху, а НЕ по размеру группы (так
 *             ходила стопка под ячейкой, пока она была): два разных вопроса,
 *             и однажды они уже были одной функцией;
 *   группы  — их НЕТ: список не сворачивает одинаковые ответы и не прячет
 *             людей под чужим хвостом (убрано 20.09);
 *   курсор  — j и k перепрыгивают заголовки секций: строка, которой на экране
 *             нет, не должна оказываться под Enter «показать классу»;
 *   держать — новая сдача не двигает строку под курсором; полоса «ещё N сдали»
 *             появляется только когда список прокручен или курсор не наверху;
 *   клавиши — в поле ответа клавиши ЕГО, в поиске стрелки продолжают ходить по
 *             списку, Enter на кнопке нажимает кнопку.
 *
 * И окно: «открыт ли пульт» тетрадь узнаёт стуком, а не ссылкой на окно, —
 * ссылку теряет перезагрузка тетради, а окно при этом живо. По тому же стуку
 * решается, что делать с кнопкой «Пульт ↗»: открыть, поднять или перевести
 * единственное окно комнаты на эту ячейку. И место окна: геометрия во весь
 * экран — это след вкладки, а не пульта, и применять её нельзя.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { CouncilAttempt, CouncilBoard } from '../shared/protocol.js'
import {
  attemptRunLine,
  tabFilters,
  bySubmissionDesc,
  classBar,
  heldArrivals,
  holdsArrivals,
  kernelView,
  listRows,
  matchesFilter,
  moveCursor,
  pultCells,
  pultClock,
  pultKeyAction,
  pultRanFor,
  requestReason,
  rowMeaning,
  selectable,
  unreadIds,
  variantNumbers,
} from '../web/src/lib/council-pult.js'
import {
  PULT_HEIGHT,
  PULT_MIN_HEIGHT,
  PULT_MIN_WIDTH,
  PULT_STALE_MS,
  PULT_WIDTH,
  beatsAlive,
  fillsScreen,
  fitPlace,
  pultPath,
  pultReach,
  pultWindowName,
  savesPlace,
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
    // «Все» — прежний единый список с двумя секциями: эти проверки про него.
    tab: 'all',
    filter: 'all',
    search: '',
    unread: NONE,
    held: NONE,
    now: T,
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

test('одинаковые ответы НЕ сворачиваются: одна сдача — одна строка', () => {
  /*
   * Группировка стояла здесь с самого начала: от трёх одинаковых в ленте
   * показывался один, остальные уходили под хвост «ещё N с тем же ответом».
   * 20.09 владелец попросил убрать её целиком, и главное последствие проверяется
   * тут: человека из большой группы видно в списке, он выбирается курсором, и
   * Enter показывает классу именно его.
   */
  const same = (id: string, at: number) => attempt({ participantId: id, submittedAt: at, text: 'x = 1' })
  const three = [same('a', T + 1), same('b', T + 2), same('c', T + 3)]
  const built = rows(three)
  assert.deepEqual(
    built.map((row) => row.kind),
    ['section', 'attempt', 'attempt', 'attempt'],
    'ни свёрнутого хвоста, ни шапки группы',
  )
  assert.deepEqual(selectable(built), ['c', 'b', 'a'], 'все трое под курсором')
  // И восемьдесят семь одинаковых — тоже восемьдесят семь строк: список пульта
  // отвечает на «кто сдал», а не на «какие бывают ответы».
  const many = Array.from({ length: 87 }, (_, at) => same(`p${at}`, T + at))
  assert.equal(selectable(rows(many)).length, 87)
})

/* -------------------------------------------------------------- секции */

test('лента делится на «Сдали» и «Пишут», и заголовки считают людей, а не строки', () => {
  /*
   * «Лучше помечать сданные работы в пульте, а то нихуя не видно» — 19.09.
   * Порядок и так ставил сданных первыми, но границы между ними и пишущими в
   * списке не существовало: один ряд людей без отличий.
   */
  const list = [
    ...['a', 'b', 'c'].map((id, at) => attempt({ participantId: id, submittedAt: T + at, text: 'x = 1' })),
    attempt({ participantId: 'alone', submittedAt: T + 9, text: 'y = 2' }),
    attempt({ participantId: 'draft1', submittedAt: null, text: 'p' }),
    attempt({ participantId: 'draft2', submittedAt: null, text: 'q' }),
  ]
  const built = rows(list)
  const sections = built.filter((row) => row.kind === 'section')
  assert.deepEqual(sections.map((row) => row.kind === 'section' && row.section), ['submitted', 'writing'])
  assert.equal(sections[0].kind === 'section' && sections[0].count, 4)
  assert.equal(sections[1].kind === 'section' && sections[1].count, 2)
  // Заголовок стоит ПЕРЕД своей половиной.
  const at = built.findIndex((row) => row.kind === 'section' && row.section === 'writing')
  assert.equal(built[at + 1].kind === 'attempt' && built[at + 1].id, 'draft1')
  // И курсору не даётся: j и k их перепрыгивают, Enter на них ничего не значит.
  assert.deepEqual(selectable(built), ['alone', 'c', 'b', 'a', 'draft1', 'draft2'])
  assert.equal(moveCursor(built, 'alone', 1), 'c')
  assert.equal(moveCursor(built, 'a', 1), 'draft1', 'курсор застрял на заголовке секции')
})

test('пустая половина заголовка не получает, а отбор и поиск секций не знают вовсе', () => {
  const drafts = rows([attempt({ participantId: 'd', submittedAt: null })])
  assert.deepEqual(
    drafts.map((row) => row.kind),
    ['section', 'attempt'],
    'у одних черновиков должен быть один заголовок',
  )
  assert.equal(drafts[0].kind === 'section' && drafts[0].section, 'writing')
  const mixed = [
    attempt({ participantId: 'ok', submittedAt: T, text: 'a' }),
    attempt({ participantId: 'draft', submittedAt: null, text: 'b' }),
  ]
  // Под отбором заголовок «Сдали · 5» говорил бы о числе, которого в списке
  // нет: отбор уже разрезал ленту по другому признаку. Во вкладках их нет по
  // тому же доводу: половина ленты там и так одна.
  assert.ok(!rows(mixed, { tab: 'writing' }).some((row) => row.kind === 'section'))
  assert.ok(!rows(mixed, { tab: 'submitted' }).some((row) => row.kind === 'section'))
  assert.ok(!rows(mixed, { filter: 'new', unread: new Set(['ok']) }).some((row) => row.kind === 'section'))
  assert.ok(!rows(mixed, { search: 'ok' }).some((row) => row.kind === 'section'))
  assert.ok(rows(mixed).some((row) => row.kind === 'section'))
})

/* -------------------------------------------------------------- фильтры */

test('чипы отбирают то, что обещают, и у каждой вкладки свой набор', () => {
  const failed = attempt({ participantId: 'f', status: 'failed', run: { state: 'error', outputs: [], execCount: 1, ranMs: 10, startedAt: T, by: 'host' } })
  const wrong = attempt({ participantId: 'w', status: 'wrong', correct: false })
  const ran = attempt({
    participantId: 'r',
    status: 'ran',
    run: { state: 'ok', outputs: [], execCount: 1, ranMs: 10, startedAt: T, by: 'host' },
  })
  const draft = attempt({ participantId: 'd', submittedAt: null })
  const unread = new Set(['f'])

  assert.equal(matchesFilter(failed, 'error', unread), true)
  assert.equal(matchesFilter(wrong, 'error', unread), true, '«неверно» — тоже ошибка')
  assert.equal(matchesFilter(ran, 'error', unread), false)
  assert.equal(matchesFilter(ran, 'unrun', unread), false, 'запускали — значит не сюда')
  assert.equal(matchesFilter(failed, 'unrun', unread), false)
  assert.equal(matchesFilter(failed, 'new', unread), true)
  assert.equal(matchesFilter(ran, 'new', unread), false)
  // «Без оценки» — про руку преподавателя: сдано, а отметки нет. Черновик сюда
  // не попадает ни при каких условиях: его не оценивают.
  assert.equal(matchesFilter(ran, 'ungraded', unread), true)
  assert.equal(matchesFilter(wrong, 'ungraded', unread), false, 'отметка стоит — значит оценено')
  assert.equal(matchesFilter(draft, 'ungraded', unread), false)
  // Чипа «группы» больше нет — отбирать по невидимому нечем; «черновики» стали
  // вкладкой, а не чипом среди отборов внутри одной стопки.
  assert.equal(tabFilters('submitted').includes('groups' as never), false)
  assert.equal(tabFilters('submitted').includes('writing' as never), false)
  assert.deepEqual(tabFilters('submitted'), ['all', 'ungraded', 'new', 'error'])
  assert.deepEqual(tabFilters('writing'), ['all', 'silent', 'failed', 'asking'])
  assert.deepEqual(tabFilters('all'), ['all', 'new'])
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

test('j и k ходят по людям и перепрыгивают заголовки секций', () => {
  const list = [
    attempt({ participantId: 'top', submittedAt: T + 10, text: 'top' }),
    attempt({ participantId: 'mid', submittedAt: T, text: 'x = 1' }),
    attempt({ participantId: 'bottom', submittedAt: T - 10, text: 'bottom' }),
  ]
  const built = rows(list)
  assert.deepEqual(selectable(built), ['top', 'mid', 'bottom'])
  assert.equal(moveCursor(built, 'top', 1), 'mid')
  assert.equal(moveCursor(built, 'mid', 1), 'bottom')
  // На краях курсор стоит, а не заворачивается: список не карусель.
  assert.equal(moveCursor(built, 'bottom', 1), 'bottom')
  assert.equal(moveCursor(built, 'top', -1), 'top')
  // Курсора нет — первое нажатие обязано что-то выбрать.
  assert.equal(moveCursor(built, null, 1), 'top')
  assert.equal(moveCursor(built, null, -1), 'bottom')
  // Курсор на строке, которой в отборе больше нет, — к первой.
  assert.equal(moveCursor(built, 'gone', 1), 'top')
  assert.equal(moveCursor([], 'top', 1), null)
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
  // Пробел раскрывал группу; группировки нет — и клавиша ничего не делает.
  assert.equal(pultKeyAction({ key: ' ' }, 'list'), null)
  assert.equal(pultKeyAction({ key: 'Enter' }, 'list'), 'show')
  assert.equal(pultKeyAction({ key: 'Enter' }, 'actions'), null, 'иначе одно нажатие делает два дела')
  assert.equal(pultKeyAction({ key: 'R' }, 'list'), 'run')
  assert.equal(pultKeyAction({ key: '1' }, 'list'), 'correct')
  assert.equal(pultKeyAction({ key: '2' }, 'list'), 'wrong')
  assert.equal(pultKeyAction({ key: '3' }, 'list'), 'clearShown')
  // ← и → ходили по соседям внутри группы — некуда ходить.
  assert.equal(pultKeyAction({ key: 'ArrowRight' }, 'list'), null)
  assert.equal(pultKeyAction({ key: 'ArrowLeft' }, 'list'), null)
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

/* ------------------------------------------------------- время запуска */

test('строка запуска говорит, что случилось, сколько считалось и когда', () => {
  /*
   * Дословная просьба с пары 19.09: «в пульте консилиума показывать время
   * запуска». Без часа «Запуск выполнен» не отличает попытку, запущенную пять
   * минут назад, от запущенной только что, а решают по ним разное.
   */
  const at = new Date(2026, 8, 19, 17, 24, 5).getTime()
  const run = (over: Record<string, unknown>) => ({ state: 'ok', outputs: [], execCount: 1, ranMs: 1200, startedAt: at, by: 'host', ...over })
  const line = (over: Record<string, unknown>, now = at + 3400) =>
    attemptRunLine({ run: run(over) as never, runRequest: null }, now).label

  assert.equal(line({}), 'Запуск выполнен · 1,2 с · 17:24')
  assert.equal(line({ state: 'error', ranMs: 400 }), 'Ошибка запуска · 0,4 с · 17:24')
  assert.equal(line({ state: 'running', ranMs: null }), 'Считает 3 с', 'живой счётчик — целыми секундами')
  assert.equal(line({ state: 'queued', ranMs: null }), 'В очереди с 17:24')
  assert.equal(line({ state: 'error', timedOut: 30, ranMs: null }), 'Остановлен пределом 30 с · 17:24')
  // Прерванный руками длительности не имеет — и выдуманной не получает.
  assert.equal(line({ ranMs: null }), 'Запуск выполнен · 17:24')
  // Не запускали и просит запуск — там часа нет вовсе, слово прежнее.
  assert.equal(attemptRunLine({ run: null }, at).label, 'Не запускали')
  assert.equal(
    attemptRunLine({ run: null, runRequest: { status: 'pending' } }, at).label,
    'Просит запуск',
  )
  // Тон достаётся от attemptExecution: два места, называющие исход, разошлись
  // бы на первом же новом состоянии.
  assert.equal(attemptRunLine({ run: run({ state: 'error' }) as never }, at).tone, 'danger')
  assert.equal(attemptRunLine({ run: run({}) as never }, at).tone, 'positive')
})

test('час запуска — с секундами там, где по ним сличают запуски', () => {
  const at = new Date(2026, 8, 19, 7, 4, 9).getTime()
  assert.equal(pultClock(at), '07:04')
  assert.equal(pultClock(at, true), '07:04:09')
  // Короткие запуски — с десятой долей: `spell()` округлил бы весь класс в «0 с».
  assert.equal(pultRanFor(1200), '1,2 с')
  assert.equal(pultRanFor(400), '0,4 с')
  assert.equal(pultRanFor(9900), '9,9 с')
  // Дальше десятой доли никто не сравнивает — там общие слова регламента.
  assert.equal(pultRanFor(12_000), '12 с')
  assert.equal(pultRanFor(95_000), '1 мин 35 с')
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
  assert.match(fresh, /width=1120/)
  assert.match(fresh, /height=820/)
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
  // курсор и прочитанное, то есть весь способ смотреть.
  assert.equal(pultReach(here, 'c1', T + 100), 'focus')
  // Живо, но по другой ячейке — перевести его сюда: второе окно той же комнаты
  // было бы вторым местом с именами, ради чего окно и заводили.
  assert.equal(pultReach(here, 'c2', T + 100), 'navigate')
})


/* ------------------------------------------------------------ место окна */

const SCREEN = { width: 1512, height: 944 }

test('место во весь экран — это след вкладки, и оно не применяется', () => {
  /*
   * Жалоба 20.09: «пульт открывается вкладкой, а не окном». Половина её —
   * отравленная память. Пульт, открытый один раз по прямому адресу (ссылку
   * вставили в адресную строку), мерил собой ВЕСЬ браузер и записывал в
   * localStorage геометрию чужого окна. Следующий `window.open` просил попап
   * размером в экран из точки 0,0 — от вкладки неотличимый, — и каждое
   * открытие подтверждало память следующему.
   */
  const poison = { left: 0, top: 0, width: SCREEN.width, height: SCREEN.height }
  assert.equal(fillsScreen(poison, SCREEN), true)
  assert.equal(fitPlace(poison, SCREEN), null, 'такое место забывается целиком')
  // И записать его тоже нельзя — ни из вкладки, ни из своего окна.
  assert.equal(savesPlace(poison, SCREEN, true), false)
  assert.equal(savesPlace({ left: 40, top: 40, width: 1000, height: 800 }, SCREEN, false), false,
    'не наше окно — не его место')
  assert.equal(savesPlace({ left: 40, top: 40, width: 1000, height: 800 }, SCREEN, true), true)
})

test('запомненное место зажимается с двух сторон, а монитор слева остаётся', () => {
  // Не «во весь экран» (по высоте меньше), значит место живое, но ширину у
  // него подрезают: попап шире монитора браузер всё равно не даст.
  const big = fitPlace({ left: 10, top: 20, width: 9000, height: 700 }, SCREEN)
  assert.ok(big)
  assert.ok(big.width <= SCREEN.width && big.height <= SCREEN.height, 'шире экрана не просим')
  const small = fitPlace({ left: 10, top: 20, width: 200, height: 120 }, SCREEN)
  assert.equal(small?.width, PULT_MIN_WIDTH, 'щель в 200 px — это не пульт')
  assert.equal(small?.height, PULT_MIN_HEIGHT)
  // Отрицательная координата — второй монитор слева, а не мусор: `screen` о
  // нём ничего не знает, и зажимать её значило бы стаскивать окно обратно.
  assert.equal(fitPlace({ left: -1800, top: 40, width: 1000, height: 800 }, SCREEN)?.left, -1800)
  // Экран неизвестен (тест, старый браузер) — остаются только нижние пределы.
  assert.equal(fitPlace({ left: 0, top: 0, width: 4000, height: 3000 }, null)?.width, 4000)
})

test('размер в features стоит всегда: без него Chrome не уважает popup=yes', () => {
  for (const place of [null, { left: 10, top: 10, width: 900, height: 700 }]) {
    const features = windowFeatures(place)
    assert.match(features, /popup=yes/)
    assert.match(features, /width=\d+/)
    assert.match(features, /height=\d+/)
  }
  assert.match(windowFeatures(null), new RegExp(`width=${PULT_WIDTH}`))
  assert.match(windowFeatures(null), new RegExp(`height=${PULT_HEIGHT}`))
})

/* --------------------------------------------------------- список ячеек */

function board(over: Partial<CouncilBoard> = {}): CouncilBoard {
  return {
    lock: 'council',
    settings: { studentRun: 'free', runLimitSec: 30, rerunPauseSec: 0, namesOnProjector: true },
    counts: { attempts: 3, submitted: 2, writing: 1, groups: 1 },
    attempts: [],
    groups: [],
    oracle: null,
    ...over,
  } as CouncilBoard
}

test('список ячеек: порядок по тетради и номеру, числа и пометки', () => {
  const running = attempt({
    participantId: 'r',
    run: { state: 'running', outputs: [], execCount: 1, ranMs: null, startedAt: T, by: 'host' },
  })
  const list = pultCells([
    { cellId: 'c2', index: 7, book: 'lab.ipynb', lock: 'council', counts: board().counts,
      room: { submitted: 12, total: 25 }, attempts: [running], onScreen: false },
    { cellId: 'c1', index: 3, book: 'lab.ipynb', lock: 'council', counts: board().counts,
      room: { submitted: 4, total: 25 }, attempts: [], onScreen: true },
    { cellId: 'c3', index: 1, book: 'hw.ipynb', lock: 'open', counts: board().counts,
      room: null, attempts: [], onScreen: false },
  ])
  assert.deepEqual(list.map((cell) => cell.cellId), ['c3', 'c1', 'c2'], 'тетрадь, потом номер')
  // Ячейки из разных тетрадей — имя тетради печатается: номера уникальны
  // только внутри тетради, и две «ячейки 03» иначе не различить.
  assert.equal(list[0].book, 'hw.ipynb')
  assert.equal(list[1].submitted, 4)
  assert.equal(list[1].total, 25)
  assert.equal(list[1].onScreen, true)
  assert.equal(list[2].running, true, 'кто-то считается прямо сейчас')
  // Консилиум сняли, попытки остались: ячейка не уходит, у неё «просмотр».
  assert.equal(list[0].review, true)
  assert.equal(list[1].review, false)
  // Комнатный счёт не приехал — берётся счёт стопки, а не ноль.
  assert.equal(list[0].submitted, 2)
  assert.equal(list[0].total, 3)
})

test('имя тетради едет всегда — прячет его меню, а не сборка списка', () => {
  /*
   * 20.09.2026, просьба с пары: «в этом списке добавь название ноутбука — тут
   * вполне может быть две девятых ячейки из разных файлов». Номер уникален
   * только внутри тетради, поэтому имя обязано доезжать до меню в КАЖДОЙ
   * строке; показывать его в строках или один раз в шапке — решение меню
   * (PultCells.svelte · manyBooks), и оно проверяется отдельно.
   */
  const one = pultCells([
    { cellId: 'a', index: 2, book: 'lab.ipynb', lock: 'council', counts: board().counts, room: null, attempts: [], onScreen: false },
    { cellId: 'b', index: 5, book: 'lab.ipynb', lock: 'council', counts: board().counts, room: null, attempts: [], onScreen: false },
  ])
  assert.deepEqual(one.map((cell) => cell.book), ['lab.ipynb', 'lab.ipynb'])
  // Ячейку удалили из документа — она уходит в хвост, а не встаёт первой.
  const gone = pultCells([
    { cellId: 'a', index: null, book: '', lock: 'council', counts: board().counts, room: null, attempts: [], onScreen: false },
    { cellId: 'b', index: 5, book: '', lock: 'council', counts: board().counts, room: null, attempts: [], onScreen: false },
  ])
  assert.deepEqual(gone.map((cell) => cell.cellId), ['b', 'a'])
})
