/**
 * Правила соревнований — те, что сервер и браузер обязаны считать одинаково.
 *
 * Разъехавшись, эти правила не падают: они тихо врут. Участник видит «осталось
 * 3 посылки», сервер отказывает четвёртой; страница показывает седьмое место,
 * панель — шестое. Поэтому здесь проверяется не «функция вернула число», а
 * ровно те частные случаи, на которых копии расходятся: граница суток, ничья в
 * лидерборде, молчание участника при правиле «выбирает сам», доля, которая
 * обязана дать непустые обе части.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { setLocaleResolver } from '../shared/i18n.js'
import {
  DIRECTION_ARROW,
  LIMITS,
  boardOf,
  compareScores,
  competitionWord,
  countedSubmission,
  countsTowardDailyQuota,
  dayStart,
  directionWord,
  entrantBadge,
  entrantKeyOk,
  isTerminal,
  metricFailedNote,
  normalizeEntrantKey,
  parseSlug,
  placeOf,
  placeShift,
  planSplit,
  privateBoardOpen,
  publicCompetition,
  publicRowCount,
  rankBoard,
  slugRefusal,
  splitByUsage,
  splitRows,
  stageWord,
  stagePosition,
  stateOfVerdict,
  submissionsLeftToday,
  teacherBadge,
  SUBMISSION_STAGES,
  SUBMISSION_STATES,
  type BoardEntry,
  type Competition,
  type QuotaEntry,
  type SubmissionState,
} from '../shared/competitions.js'

/* ----------------------------------------------------------------- адрес */

test('адрес соревнования: буквы те же, что у курсов, но «t» занят входом по ключу', () => {
  assert.equal(parseSlug(' Rohlik '), 'rohlik')
  assert.equal(parseSlug('s5e12'), 's5e12')
  assert.equal(parseSlug('bpm'), 'bpm')
  // Вход участника по ссылке живёт на /k/t/<key>: соревнование с адресом «t»
  // отняло бы у всех способ вернуться со второго устройства.
  assert.equal(parseSlug('t'), null)
  assert.equal(slugRefusal('t'), 'reserved')
  assert.equal(parseSlug('new'), null)
  assert.equal(parseSlug(''), null)
  assert.equal(slugRefusal(''), 'empty')
  assert.equal(parseSlug('ro hlik'), null)
  assert.equal(parseSlug('Rohlik/../etc'), null)
  assert.equal(slugRefusal('ro_hlik'), 'chars')
  assert.equal(slugRefusal('rohlik'), null)
  // Дефис по краям — не адрес: его не продиктуешь вслух без «а в начале минус».
  assert.equal(parseSlug('-rohlik'), null)
  assert.equal(parseSlug('rohlik-'), null)
})

/* ---------------------------------------------------------------- ключ */

test('ключ входа приводится к одному виду, а чужая буква ключом не становится', () => {
  assert.equal(normalizeEntrantKey('k7q m2x 9fd'), 'K7Q-M2X-9FD')
  assert.equal(normalizeEntrantKey('K7QM2X9FD'), 'K7Q-M2X-9FD')
  assert.equal(entrantKeyOk('K7Q-M2X-9FD'), true)
  assert.equal(entrantKeyOk('K7QM2X9FD'), false)
  // O, 0, I, 1 и L из алфавита выкинуты: ключ диктуют вслух, и «ноль или О»
  // стоит обращения за новым ключом.
  assert.equal(normalizeEntrantKey('K0Q-M2X-9FD'), null)
  assert.equal(normalizeEntrantKey('KIQ-M2X-9FD'), null)
  assert.equal(normalizeEntrantKey('K7Q-M2X-9F'), null)
})

/* ------------------------------------------------------- слова состояний */

test('одно и то же состояние называется участнику и преподавателю разными словами', () => {
  setLocaleResolver(() => 'ru')
  assert.equal(entrantBadge('notebookFailed')?.word, 'ОШИБКА В ТЕТРАДИ')
  assert.equal(teacherBadge('notebookFailed')?.word, 'УПАЛА ТЕТРАДЬ')
  assert.equal(entrantBadge('timedOut')?.word, 'ЛИМИТ ВРЕМЕНИ')
  assert.equal(teacherBadge('timedOut')?.word, 'ВЫШЛО ВРЕМЯ')
  assert.equal(entrantBadge('scored')?.word, 'ГОТОВО')
  assert.equal(teacherBadge('scored')?.word, 'ГОТОВО')
  // Упал код преподавателя — участнику не плашка, а фраза: плашка называла бы
  // виноватым его.
  assert.equal(entrantBadge('metricFailed'), null)
  assert.match(metricFailedNote(), /Проверяющий код упал/)
  assert.equal(teacherBadge('metricFailed')?.word, 'УПАЛА МЕТРИКА')
  // Единственная насыщенно-красная плашка продукта — и её видит только он.
  assert.equal(teacherBadge('metricFailed')?.form, 'strong')
  // Идущая и ждущая в таблице преподавателя не плашкой: они в блоке очереди.
  assert.equal(teacherBadge('running'), null)
  assert.equal(teacherBadge('queued'), null)
  assert.equal(entrantBadge('running')?.form, 'strong')
  assert.equal(entrantBadge('queued')?.form, 'outline')
  assert.equal(entrantBadge('rejected')?.tone, 'warning')
})

test('каждое состояние и каждый этап названы на обоих языках', () => {
  for (const locale of ['ru', 'en'] as const) {
    setLocaleResolver(() => locale)
    for (const state of SUBMISSION_STATES) {
      for (const badge of [entrantBadge(state), teacherBadge(state)]) {
        if (!badge) continue
        assert.ok(badge.word.length > 0, `${locale}/${state}`)
        assert.ok(!badge.word.includes('competitions.'), `${locale}/${state} остался ключом`)
      }
    }
    for (const stage of SUBMISSION_STAGES) {
      assert.ok(!stageWord(stage).includes('competitions.'), `${locale}/${stage}`)
    }
    for (const state of ['draft', 'live', 'finished'] as const) {
      assert.ok(!competitionWord(state).includes('competitions.'))
    }
    assert.ok(!directionWord('lower').includes('competitions.'))
  }
  setLocaleResolver(() => 'ru')
  assert.equal(competitionWord('live'), 'ИДЁТ')
  assert.equal(directionWord('lower'), 'меньше — лучше')
  setLocaleResolver(() => 'en')
  assert.equal(directionWord('higher'), 'higher is better')
  setLocaleResolver(() => 'ru')
  // Стрелка — знак, а не перевод: она одна на оба языка.
  assert.equal(DIRECTION_ARROW.lower, '↓')
  assert.equal(DIRECTION_ARROW.higher, '↑')
})

test('этапы: дошедшая до конца вся пройдена, упавшая стоит на том, где умерла', () => {
  assert.equal(stagePosition('scored', 'score', 'notebook'), 'done')
  assert.equal(stagePosition('scored', 'score', 'score'), 'done')
  assert.equal(stagePosition('running', 'notebook', 'accepted'), 'done')
  assert.equal(stagePosition('running', 'notebook', 'notebook'), 'current')
  assert.equal(stagePosition('running', 'notebook', 'check'), 'ahead')
  assert.equal(stagePosition('notebookFailed', 'notebook', 'notebook'), 'current')
  assert.equal(stagePosition('queued', 'queue', 'queue'), 'current')
})

test('слово прогонщика превращается в состояние по тому же порядку, что у прототипа', () => {
  // Убийство снаружи старше всего, что успела написать обвязка.
  assert.equal(stateOfVerdict('notebook', 'out-of-memory'), 'outOfMemory')
  assert.equal(stateOfVerdict('notebook', 'timeout'), 'timedOut')
  assert.equal(stateOfVerdict('notebook', 'cell_timeout'), 'timedOut')
  assert.equal(stateOfVerdict('notebook', 'cell_error'), 'notebookFailed')
  assert.equal(stateOfVerdict('notebook', 'kernel_died'), 'notebookFailed')
  assert.equal(stateOfVerdict('notebook', 'exit'), 'notebookFailed')
  // Тетрадь отработала, а ответа нет — это отказ участнику, а не падение.
  assert.equal(stateOfVerdict('notebook', 'no-submission'), 'rejected')
  assert.equal(stateOfVerdict('notebook', 'target_too_large'), 'rejected')
  // Виновата обвязка — разбирать преподавателю, а не обвинять участника.
  assert.equal(stateOfVerdict('notebook', 'harness_error'), 'metricFailed')
  assert.equal(stateOfVerdict('metric', 'ok'), 'scored')
  assert.equal(stateOfVerdict('metric', 'participant_error'), 'rejected')
  assert.equal(stateOfVerdict('metric', 'metric_error'), 'metricFailed')
  assert.equal(isTerminal('queued'), false)
  assert.equal(isTerminal('running'), false)
  assert.equal(isTerminal('scored'), true)
})

/* ------------------------------------------------------------ норма дня */

const MSK = 180

test('граница суток считается в поясе занятия, а не в UTC', () => {
  // 20.09.2026 23:59 МСК — это 20:59 UTC, и сутки по МСК начались в 21:00 UTC
  // предыдущего дня.
  const lateMsk = Date.UTC(2026, 8, 20, 20, 59)
  const earlyMsk = Date.UTC(2026, 8, 20, 21, 1)
  assert.notEqual(dayStart(lateMsk, MSK), dayStart(earlyMsk, MSK))
  // В UTC те же две отметки лежат в одном дне — ровно та ошибка, ради которой
  // пояс приходит числом.
  assert.equal(dayStart(lateMsk, 0), dayStart(earlyMsk, 0))
  assert.equal(dayStart(earlyMsk, MSK), Date.UTC(2026, 8, 20, 21, 0))
})

test('в счёт дня не идут снятые и не начавшиеся посылки', () => {
  const at = Date.UTC(2026, 8, 20, 12)
  const entry = (state: SubmissionState, cellsDone: number): QuotaEntry => ({
    acceptedAt: at,
    state,
    cellsDone,
  })
  assert.equal(countsTowardDailyQuota(entry('cancelled', 9)), false)
  // «Посылки с ошибкой в счёт дня не идут, если упали до первой ячейки».
  assert.equal(countsTowardDailyQuota(entry('notebookFailed', 0)), false)
  assert.equal(countsTowardDailyQuota(entry('notebookFailed', 1)), true)
  assert.equal(countsTowardDailyQuota(entry('rejected', 0)), false)
  assert.equal(countsTowardDailyQuota(entry('scored', 0)), true)
  // Стоящая в очереди тратит норму сразу, иначе один человек поставит сто.
  assert.equal(countsTowardDailyQuota(entry('queued', 0)), true)
  assert.equal(countsTowardDailyQuota(entry('running', 0)), true)
})

test('осталось сегодня: вчерашние не считаются, ноль означает «без предела»', () => {
  const now = Date.UTC(2026, 8, 20, 12)
  const yesterday = now - 24 * 60 * 60 * 1000
  const made = (acceptedAt: number): QuotaEntry => ({
    acceptedAt,
    state: 'scored',
    cellsDone: 3,
  })
  assert.equal(submissionsLeftToday(5, [made(now), made(now)], now, MSK), 3)
  assert.equal(submissionsLeftToday(5, [made(yesterday)], now, MSK), 5)
  assert.equal(submissionsLeftToday(0, [made(now)], now, MSK), null)
  // Норму опустили в середине дня — «осталось −2» участнику показывать нечего.
  assert.equal(submissionsLeftToday(1, [made(now), made(now), made(now)], now, MSK), 0)
  // Посылка ровно на границе суток уже считается сегодняшней.
  const start = dayStart(now, MSK)
  assert.equal(submissionsLeftToday(5, [made(start)], now, MSK), 4)
  assert.equal(submissionsLeftToday(5, [made(start - 1)], now, MSK), 5)
})

/* ------------------------------------------------------- зачёт и места */

const entry = (over: Partial<BoardEntry> & { id: string }): BoardEntry => ({
  number: 1,
  acceptedAt: 0,
  state: 'scored',
  publicScore: null,
  privateScore: null,
  chosen: false,
  ...over,
})

test('в зачёт идёт то, что выбрал участник; молчание — лучшая по публичной', () => {
  const entries = [
    entry({ id: 'a', number: 7, acceptedAt: 10, publicScore: 0.0502 }),
    entry({ id: 'b', number: 11, acceptedAt: 20, publicScore: 0.0455, chosen: true }),
    entry({ id: 'c', number: 12, acceptedAt: 30, publicScore: 0.0440 }),
  ]
  assert.equal(countedSubmission('chosen', entries, 'lower')?.id, 'b')
  // Молчание — тоже выбор, и он назван в макете: «Не выбрал — берётся лучшая
  // по публичной части».
  const silent = entries.map((e) => ({ ...e, chosen: false }))
  assert.equal(countedSubmission('chosen', silent, 'lower')?.id, 'c')
  assert.equal(countedSubmission('bestPublic', entries, 'lower')?.id, 'c')
  assert.equal(countedSubmission('last', entries, 'lower')?.id, 'c')
  // У метрики «больше — лучше» лучшая — другая.
  assert.equal(countedSubmission('bestPublic', entries, 'higher')?.id, 'a')
})

test('«последняя» — последняя ДОШЕДШАЯ до числа, а не последняя присланная', () => {
  const entries = [
    entry({ id: 'a', number: 7, acceptedAt: 10, publicScore: 0.05 }),
    entry({ id: 'fail', number: 8, acceptedAt: 99, state: 'notebookFailed' }),
  ]
  // Иначе одна неудачная посылка перед сном вычёркивала бы человека из таблицы.
  assert.equal(countedSubmission('last', entries, 'lower')?.id, 'a')
  assert.equal(countedSubmission('chosen', [entries[1]], 'lower'), null)
})

test('лидерборд: направление метрики решает порядок, ничью решает время', () => {
  const rows = [
    { entrantId: 'anna', submissionId: 's1', score: 0.0447, at: 300 },
    { entrantId: 'marfa', submissionId: 's2', score: 0.0441, at: 200 },
    { entrantId: 'daniil', submissionId: 's3', score: 0.0441, at: 100 },
  ]
  const lower = rankBoard(rows, 'lower')
  // «При одинаковом результате выше посылка, отправленная раньше» — сноска P3.
  assert.deepEqual(
    lower.map((r) => r.entrantId),
    ['daniil', 'marfa', 'anna'],
  )
  assert.deepEqual(
    lower.map((r) => r.place),
    [1, 2, 3],
  )
  const higher = rankBoard(rows, 'higher')
  assert.equal(higher[0].entrantId, 'anna')
  // Ничья и наверху таблицы разрешается тем же правилом, а не порядком строк.
  assert.equal(higher[1].entrantId, 'daniil')
  assert.equal(placeOf(lower, 'marfa'), 2)
  assert.equal(placeOf(lower, 'никого'), null)
  assert.ok(compareScores({ score: 1, at: 1 }, { score: 2, at: 0 }, 'lower') < 0)
  assert.ok(compareScores({ score: 1, at: 1 }, { score: 2, at: 0 }, 'higher') > 0)
})

test('итоговая таблица берёт приватное число ТОЙ посылки, которую выбрал человек', () => {
  const people = [
    {
      entrantId: 'timur',
      entries: [
        entry({ id: 'x', acceptedAt: 10, publicScore: 0.0412, privateScore: 0.0900 }),
        entry({ id: 'y', acceptedAt: 20, publicScore: 0.0455, privateScore: 0.0452, chosen: true }),
      ],
    },
    {
      entrantId: 'anna',
      entries: [entry({ id: 'z', acceptedAt: 15, publicScore: 0.0449, privateScore: 0.0447 })],
    },
    {
      entrantId: 'platon',
      entries: [entry({ id: 'p', acceptedAt: 5, publicScore: 0.0419, privateScore: 0.0489 })],
    },
  ]
  const pub = boardOf(people, 'chosen', 'lower', 'public')
  // Лучшее публичное у Тимура — 0.0412 («x»), но он выбрал «y», и в таблицу
  // идёт выбранная: иначе выбор участника ничего не значил бы.
  assert.deepEqual(
    pub.map((r) => r.entrantId),
    ['platon', 'anna', 'timur'],
  )
  assert.equal(pub[2].score, 0.0455)
  const priv = boardOf(people, 'chosen', 'lower', 'private')
  // В итог идёт приватное число ТОЙ ЖЕ посылки: 0.0452, а не 0.0900 от «x».
  assert.deepEqual(
    priv.map((r) => r.entrantId),
    ['anna', 'timur', 'platon'],
  )
  assert.equal(priv[1].score, 0.0452)
  assert.equal(priv[1].submissionId, 'y')
  assert.equal(placeShift(placeOf(pub, 'anna'), placeOf(priv, 'anna')), 1)
  assert.equal(placeShift(placeOf(pub, 'timur'), placeOf(priv, 'timur')), 1)
  assert.equal(placeShift(placeOf(pub, 'platon'), placeOf(priv, 'platon')), -2)
  assert.equal(placeShift(3, 3), 0)
  assert.equal(placeShift(null, 2), null)
  assert.equal(placeShift(2, null), null)
})

test('человек без единой дошедшей посылки в таблицу не попадает', () => {
  const rows = boardOf(
    [{ entrantId: 'lost', entries: [entry({ id: 'q', state: 'timedOut' })] }],
    'chosen',
    'lower',
    'public',
  )
  assert.equal(rows.length, 0)
})

/* ---------------------------------------------- приватный лидерборд */

const draft = (over: Partial<Competition>): Competition =>
  ({
    privateRelease: 'auto',
    deadlineAt: null,
    privateOpenedAt: null,
    ...over,
  }) as Competition

test('приватный лидерборд: сам после дедлайна или только рукой', () => {
  const deadline = Date.UTC(2026, 8, 27, 20, 59)
  assert.equal(privateBoardOpen(draft({ deadlineAt: deadline }), deadline - 1), false)
  assert.equal(privateBoardOpen(draft({ deadlineAt: deadline }), deadline), true)
  // «Открою вручную — на разборе»: никакой срок этого за преподавателя не сделает.
  const manual = draft({ privateRelease: 'manual', deadlineAt: deadline })
  assert.equal(privateBoardOpen(manual, deadline + 86_400_000), false)
  assert.equal(privateBoardOpen({ ...manual, privateOpenedAt: deadline }, deadline), true)
  // Дедлайн не назначен — открывать нечему.
  assert.equal(privateBoardOpen(draft({}), Date.now()), false)
})

/* --------------------------------------------------- деление строк */

test('доля даёт ровно то число строк, что обещано, и обе части непусты', () => {
  assert.equal(publicRowCount(397, 30), 119)
  assert.equal(publicRowCount(397, 50), 199)
  assert.equal(publicRowCount(2, 1), 1)
  assert.equal(publicRowCount(2, 99), 1)
  // Метрика на нуле строк либо падает, либо отдаёт NaN, а соревнование с пустой
  // приватной частью — это соревнование без итога.
  assert.equal(publicRowCount(100, 0), 1)
  assert.equal(publicRowCount(100, 100), 99)
  assert.equal(publicRowCount(0, 30), 0)
})

test('деление по зерну воспроизводимо и не зависит от порядка строк в файле', () => {
  const ids = Array.from({ length: 397 }, (_, i) => `id-${i}`)
  const first = splitRows(ids, 30, 'seed-one')
  const again = splitRows(ids, 30, 'seed-one')
  assert.deepEqual(first, again)
  assert.equal(first.filter((p) => p === 'public').length, 119)

  // Строку помнят по ключу, а не по месту: перетасованный файл ответов даёт то
  // же деление, иначе пересчёт после правки метрики менял бы половину теста.
  const shuffled = [...ids].reverse()
  const byShuffled = splitRows(shuffled, 30, 'seed-one')
  const where = new Map(shuffled.map((id, i) => [id, byShuffled[i]]))
  for (let i = 0; i < ids.length; i++) assert.equal(where.get(ids[i]), first[i])

  // Другое зерно — другое деление; иначе зерно ничего не решало бы.
  const other = splitRows(ids, 30, 'seed-two')
  assert.notDeepEqual(other, first)
  assert.equal(other.filter((p) => p === 'public').length, 119)
})

test('колонка Usage старше зерна, а негодная колонка не подменяет собой жребий', () => {
  assert.deepEqual(splitByUsage(['Public', 'private', 'PUBLIC']), ['public', 'private', 'public'])
  // Чужие слова — не деление.
  assert.equal(splitByUsage(['Public', 'train']), null)
  // Одна часть пуста — тоже не деление.
  assert.equal(splitByUsage(['Public', 'Public']), null)
  assert.equal(splitByUsage(['Private', 'Private']), null)

  const ids = ['a', 'b', 'c', 'd']
  const byUsage = planSplit({ ids, usage: ['Public', 'Private', 'Private', 'Private'] }, 30, 'seed')
  assert.equal(byUsage.by, 'usage')
  assert.deepEqual(byUsage.parts, ['public', 'private', 'private', 'private'])
  assert.equal(planSplit({ ids, usage: null }, 50, 'seed').by, 'seed')
  // Колонка не той длины — не колонка.
  assert.equal(planSplit({ ids, usage: ['Public'] }, 50, 'seed').by, 'seed')
})

/* -------------------------------------------------------------- прочее */

test('соревнование глазами участника не несёт ни кода метрики, ни зерна', () => {
  const full = {
    id: 'c1',
    slug: 'rohlik',
    title: 'Rohlik',
    blurb: '',
    description: '',
    state: 'live',
    metric: { name: 'MAPE', direction: 'lower', code: 'def score(): ...' },
    publicPercent: 30,
    splitSeed: 'секрет',
    limits: { wallSeconds: 600, memoryMb: 4096, cpus: 2, perDay: 5 },
    environment: 'base',
    startsAt: null,
    deadlineAt: null,
    privateRelease: 'auto',
    scoring: 'chosen',
    privateOpenedAt: null,
    baselineSubmissionId: null,
    createdBy: 'teacher-1',
    createdAt: 1,
    updatedAt: 1,
  } as Competition
  const seen = publicCompetition(full)
  const flat = JSON.stringify(seen)
  // Зная зерно и долю, ответ можно подогнать под скрытую часть, не решая задачу.
  assert.ok(!flat.includes('секрет'))
  assert.ok(!flat.includes('def score'))
  assert.ok(!flat.includes('teacher-1'))
  assert.equal(seen.metric.name, 'MAPE')
  assert.equal(seen.publicPercent, 30)
})

test('пределы названы одним местом и не противоречат сами себе', () => {
  assert.ok(LIMITS.publicPercent.min >= 1 && LIMITS.publicPercent.max <= 99)
  assert.ok(LIMITS.publicPercent.default > LIMITS.publicPercent.min)
  for (const range of [
    LIMITS.wallSeconds,
    LIMITS.memoryMb,
    LIMITS.cpus,
    LIMITS.perDay,
    LIMITS.publicPercent,
  ]) {
    assert.ok(range.min <= range.default && range.default <= range.max)
  }
  // Присланная тетрадь разбирается в памяти контейнера целиком, поэтому её
  // потолок ниже потолка ответа, который только копируется.
  assert.ok(LIMITS.notebookBytes < LIMITS.submissionBytes)
  assert.ok(LIMITS.participantError < LIMITS.teacherError)
})
