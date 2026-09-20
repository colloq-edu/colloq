/**
 * Хранилище соревнований: строки, очередь и файлы на диске.
 *
 * Проверяется то, что ломается тихо. Номер посылки, выданный дважды. Норма
 * дня, посчитанная в чужом поясе. Две отметки «в зачёт» у одного человека.
 * Очередь, которая после перезапуска сервера держит посылку «выполняется» до
 * конца соревнования. И ответы, оставшиеся на диске от удалённого
 * соревнования, — единственная ошибка из этого списка, которую вообще некому
 * заметить.
 */
import './_env.mts'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { dayStart } from '../shared/competitions.js'
import {
  BOOT,
  acceptSubmission,
  chooseSubmission,
  competitionSummary,
  createCompetition,
  createEntrant,
  deleteCompetition,
  dropFile,
  enqueue,
  entrantByKey,
  finishRun,
  findCompetition,
  getCompetition,
  getEntrant,
  getSubmission,
  leaderboard,
  leaveQueue,
  leftToday,
  listCompetitionEntrants,
  listCompetitions,
  listEntrantSubmissions,
  listFiles,
  listRuns,
  liveCompetitionIds,
  openFileBytes,
  openPrivateBoard,
  orphanedRuns,
  pruneCompetitionFiles,
  putFile,
  queueRows,
  queuePaused,
  reclaimQueue,
  rotateEntrantKey,
  setCompetitionState,
  setQueuePaused,
  startRun,
  takeNext,
  updateCompetition,
  updateSubmission,
  usedToday,
  waitingCount,
} from '../server/src/competitions/store.js'
import {
  competitionsDir,
  openDir,
  putOpenFile,
  putSecretFile,
  putSubmissionNotebook,
  readSecretFile,
  removeSubmission,
  secretDir,
  sweepOrphans,
  hostPathOf,
} from '../server/src/competitions/storage.js'
import { config } from '../server/src/config.js'

const MSK = 180
const bytes = (text: string) => new TextEncoder().encode(text)

/**
 * Очередь — одна на инстанс, и это не обстоятельство теста, а устройство
 * продукта: исполнитель у машины один на все соревнования. Поэтому проверки
 * очереди начинают с чистого листа, иначе в ней лежат посылки предыдущих.
 */
function drainQueue(): void {
  for (const row of queueRows()) leaveQueue(row.submissionId)
  setQueuePaused(false)
}

function freshCompetition(slug: string) {
  const made = createCompetition({
    slug,
    title: `Соревнование ${slug}`,
    metric: { name: 'MAPE', direction: 'lower', code: 'def score(): ...' },
  })
  assert.ok(made, `не удалось завести ${slug}`)
  return made
}

/* ---------------------------------------------------------- соревнования */

test('соревнование рождается черновиком, и адрес у него один на всех', () => {
  const made = freshCompetition('rohlik')
  assert.equal(made.state, 'draft')
  assert.equal(made.metric.direction, 'lower')
  assert.equal(made.limits.perDay, 5)
  // Зерно деления выдаётся при рождении: без него нечем воспроизвести, какие
  // строки были публичными.
  assert.ok(made.splitSeed.length > 0)

  // Единственность держит база, а не проверка перед вставкой: два
  // преподавателя, сохранившие черновик в одну секунду, прошли бы её оба.
  assert.equal(createCompetition({ slug: 'rohlik', title: 'Другое' }), null)

  assert.equal(findCompetition('rohlik')?.id, made.id)
  assert.equal(findCompetition(made.id)?.slug, 'rohlik')
  assert.equal(findCompetition('нет такого'), null)
  assert.ok(listCompetitions().some((c) => c.id === made.id))
})

test('правка трогает только те поля, что пришли, а занятый адрес говорит об этом словом', () => {
  const one = freshCompetition('s5e12')
  freshCompetition('bpm')
  const patched = updateCompetition(one.id, {
    title: 'Диабет S5E12',
    metric: { direction: 'higher' },
    limits: { perDay: 3 },
  })
  assert.ok(patched && patched !== 'taken')
  assert.equal(patched.title, 'Диабет S5E12')
  assert.equal(patched.metric.direction, 'higher')
  // Код метрики в патч не приходил — и остался прежним.
  assert.equal(patched.metric.code, 'def score(): ...')
  assert.equal(patched.limits.perDay, 3)
  assert.equal(patched.limits.memoryMb, 4096)
  assert.ok(patched.updatedAt >= one.updatedAt)

  assert.equal(updateCompetition(one.id, { slug: 'bpm' }), 'taken')
  assert.equal(getCompetition(one.id)?.slug, 's5e12')
  assert.equal(updateCompetition('нет такого', { title: 'x' }), null)

  assert.equal(setCompetitionState(one.id, 'live'), true)
  assert.equal(getCompetition(one.id)?.state, 'live')
  const at = Date.now()
  assert.equal(openPrivateBoard(one.id, at), true)
  assert.equal(getCompetition(one.id)?.privateOpenedAt, at)
})

/* ------------------------------------------------------------------ файлы */

test('файлы соревнования знают, кто их видит, и открытые считаются отдельно', () => {
  const c = freshCompetition('files')
  putFile({ competitionId: c.id, name: 'train.csv', bytes: 4_100_000, rows: 7340, visibility: 'open' })
  putFile({ competitionId: c.id, name: 'test.csv', bytes: 212_000, rows: 397, visibility: 'open' })
  putFile({
    competitionId: c.id,
    name: 'solution.csv',
    bytes: 9000,
    rows: 397,
    visibility: 'hidden',
  })
  assert.equal(listFiles(c.id).length, 3)
  assert.deepEqual(
    listFiles(c.id, 'open').map((f) => f.name),
    ['test.csv', 'train.csv'],
  )
  assert.deepEqual(
    listFiles(c.id, 'hidden').map((f) => f.name),
    ['solution.csv'],
  )
  // Потолок «до 200 МБ на соревнование» считается по открытым: ответы в него
  // не входят, их кладёт преподаватель и не он же качает.
  assert.equal(openFileBytes(c.id), 4_312_000)
  // Повторная загрузка того же имени — замена, а не второй файл.
  putFile({ competitionId: c.id, name: 'train.csv', bytes: 10, rows: 1, visibility: 'open' })
  assert.equal(listFiles(c.id, 'open').length, 2)
  assert.equal(openFileBytes(c.id), 212_010)
  assert.equal(dropFile(c.id, 'train.csv'), true)
  assert.equal(dropFile(c.id, 'train.csv'), false)
})

/* --------------------------------------------------------------- участники */

test('ключ входа возвращает человека, а новый ключ отбирает силу у старого', () => {
  const minted = createEntrant('Тимур Ахметов')
  const person = minted.entrant
  assert.match(minted.key, /^[A-Z0-9]{3}-[A-Z0-9]{3}-[A-Z0-9]{3}$/)
  assert.equal(entrantByKey(minted.key)?.id, person.id)
  assert.equal(person.disabled, false)

  const rotated = rotateEntrantKey(person.id)
  assert.ok(rotated)
  assert.notEqual(rotated.key, minted.key)
  // Розданную строку иначе не отобрать: старый ключ перестаёт быть входом.
  assert.equal(entrantByKey(minted.key), null)
  assert.equal(entrantByKey(rotated.key)?.id, person.id)
  assert.equal(getEntrant(person.id)?.name, 'Тимур Ахметов')
  assert.equal(rotateEntrantKey('нет такого'), null)

  // Ключи разных людей не совпадают — за этим следит уникальный индекс.
  const keys = new Set([rotated.key])
  for (let i = 0; i < 20; i++) keys.add(createEntrant(`Участник ${i}`).key)
  assert.equal(keys.size, 21)
})

/* ---------------------------------------------------------------- посылки */

test('номер посылки свой в каждом соревновании и не выдаётся дважды', () => {
  const one = freshCompetition('numbers-one')
  const two = freshCompetition('numbers-two')
  const anna = createEntrant('Анна Ким').entrant
  const timur = createEntrant('Тимур').entrant

  const first = acceptSubmission({
    competitionId: one.id,
    entrantId: anna.id,
    fileName: 'a.ipynb',
    bytes: 100,
  })
  const second = acceptSubmission({
    competitionId: one.id,
    entrantId: timur.id,
    fileName: 'b.ipynb',
    bytes: 100,
  })
  const other = acceptSubmission({
    competitionId: two.id,
    entrantId: anna.id,
    fileName: 'c.ipynb',
    bytes: 100,
  })
  assert.equal(first.number, 1)
  assert.equal(second.number, 2)
  // «#12» — номер в пределах соревнования, а не сквозной по инстансу.
  assert.equal(other.number, 1)
  assert.equal(first.state, 'queued')
  assert.equal(first.stage, 'accepted')

  assert.deepEqual(
    listEntrantSubmissions(one.id, anna.id).map((s) => s.id),
    [first.id],
  )
  assert.deepEqual(
    listCompetitionEntrants(one.id)
      .map((e) => e.id)
      .sort(),
    [anna.id, timur.id].sort(),
  )
  // В соседнем соревновании Тимура нет вовсе.
  assert.deepEqual(
    listCompetitionEntrants(two.id).map((e) => e.id),
    [anna.id],
  )
})

test('норма дня считается в поясе занятия и не трогает вчерашние посылки', () => {
  const c = freshCompetition('quota')
  const person = createEntrant('Марфа').entrant
  const now = Date.UTC(2026, 8, 20, 12)
  const startOfDay = dayStart(now, MSK)

  // Ровно на границе суток по МСК — уже сегодня; секундой раньше — вчера.
  acceptSubmission({
    competitionId: c.id,
    entrantId: person.id,
    fileName: 'today.ipynb',
    bytes: 1,
    at: startOfDay,
  })
  acceptSubmission({
    competitionId: c.id,
    entrantId: person.id,
    fileName: 'yesterday.ipynb',
    bytes: 1,
    at: startOfDay - 1,
  })
  assert.equal(usedToday(c.id, person.id, now, MSK), 1)
  assert.equal(leftToday(c, person.id, now, MSK), 4)

  // Упавшая ДО первой ячейки нормы не тратит — так обещано в макете.
  const dead = acceptSubmission({
    competitionId: c.id,
    entrantId: person.id,
    fileName: 'dead.ipynb',
    bytes: 1,
    at: now,
  })
  updateSubmission(dead.id, { state: 'notebookFailed', cellsDone: 0 })
  assert.equal(leftToday(c, person.id, now, MSK), 4)
  updateSubmission(dead.id, { state: 'notebookFailed', cellsDone: 7 })
  assert.equal(leftToday(c, person.id, now, MSK), 3)

  // Ноль — «без предела», и это не то же самое, что «нисколько».
  const open = updateCompetition(c.id, { limits: { perDay: 0 } })
  assert.ok(open && open !== 'taken')
  assert.equal(leftToday(open, person.id, now, MSK), null)
})

test('в зачёт идёт ровно одна посылка человека, и только дошедшая до числа', () => {
  const c = freshCompetition('counted')
  const person = createEntrant('Анна').entrant
  const other = createEntrant('Платон').entrant
  const make = (name: string, score: number | null) => {
    const s = acceptSubmission({
      competitionId: c.id,
      entrantId: person.id,
      fileName: name,
      bytes: 1,
    })
    if (score !== null) {
      updateSubmission(s.id, { state: 'scored', stage: 'score', publicScore: score })
    } else {
      updateSubmission(s.id, { state: 'notebookFailed', cellsDone: 3 })
    }
    return s
  }
  const good = make('good.ipynb', 0.05)
  const better = make('better.ipynb', 0.04)
  const failed = make('failed.ipynb', null)

  assert.equal(chooseSubmission(c.id, person.id, good.id), true)
  assert.equal(getSubmission(good.id)?.chosen, true)
  // Вторая отметка снимает первую: две отметки «в зачёт» — это лидерборд,
  // который не сходится сам с собой.
  assert.equal(chooseSubmission(c.id, person.id, better.id), true)
  assert.equal(getSubmission(good.id)?.chosen, false)
  assert.equal(getSubmission(better.id)?.chosen, true)
  // У упавшей нет числа, которое можно поставить в таблицу.
  assert.equal(chooseSubmission(c.id, person.id, failed.id), false)
  // Чужую выбрать нельзя — и это проверяет хранилище, а не экран.
  assert.equal(chooseSubmission(c.id, other.id, better.id), false)
})

test('лидерборд берёт по одной посылке на человека и знает направление метрики', () => {
  const c = freshCompetition('board')
  const marfa = createEntrant('Марфа Соколова').entrant
  const anna = createEntrant('Анна Ким').entrant
  const score = (who: string, at: number, pub: number, priv: number, chosen = false) => {
    const s = acceptSubmission({
      competitionId: c.id,
      entrantId: who,
      fileName: 's.ipynb',
      bytes: 1,
      at,
    })
    updateSubmission(s.id, {
      state: 'scored',
      stage: 'score',
      publicScore: pub,
      privateScore: priv,
    })
    if (chosen) chooseSubmission(c.id, who, s.id)
    return s
  }
  score(marfa.id, 100, 0.0412, 0.0441)
  score(anna.id, 200, 0.0449, 0.0447)
  const annaSecond = score(anna.id, 300, 0.0460, 0.0430, true)

  const pub = leaderboard(c.id, 'public')
  // У Анны две посылки, в таблице одна — выбранная ею самой.
  assert.deepEqual(
    pub.map((r) => r.entrantId),
    [marfa.id, anna.id],
  )
  assert.equal(pub[1].submissionId, annaSecond.id)
  const priv = leaderboard(c.id, 'private')
  assert.deepEqual(
    priv.map((r) => r.entrantId),
    [anna.id, marfa.id],
  )

  const summary = competitionSummary(c.id)
  assert.equal(summary.submissions, 3)
  assert.equal(summary.scored, 3)
  assert.equal(summary.entrants, 2)
  assert.equal(summary.bestPublic, 0.0412)

  // Метрика «больше — лучше» переворачивает и таблицу, и «лучший публичный».
  assert.ok(updateCompetition(c.id, { metric: { direction: 'higher' } }))
  assert.equal(leaderboard(c.id, 'public')[0].entrantId, anna.id)
  assert.equal(competitionSummary(c.id).bestPublic, 0.0460)
})

/* ---------------------------------------------------------------- прогоны */

test('прогоны копятся по одному на заход, и пересчёт метрики не трогает тетрадь', () => {
  const c = freshCompetition('runs')
  const person = createEntrant('Платон').entrant
  const s = acceptSubmission({
    competitionId: c.id,
    entrantId: person.id,
    fileName: 'p.ipynb',
    bytes: 1,
  })
  const first = startRun({ submissionId: s.id, kind: 'notebook', container: 'zz-comp-1' })
  assert.equal(first.seq, 1)
  finishRun(first.id, { verdict: 'ok', finishedAt: Date.now(), cellsDone: 14, cellsTotal: 14 })
  const metric = startRun({ submissionId: s.id, kind: 'metric' })
  assert.equal(metric.seq, 2)
  finishRun(metric.id, { verdict: 'metric_error', teacherError: 'ZeroDivisionError', oom: false })
  // Пересчёт после правки метрики — ещё один прогон вида metric, а тетрадь
  // второй раз не запускается.
  const again = startRun({ submissionId: s.id, kind: 'metric' })
  assert.equal(again.seq, 3)
  finishRun(again.id, { verdict: 'ok', publicScore: 0.041, privateScore: 0.044 })

  const runs = listRuns(s.id)
  assert.deepEqual(
    runs.map((r) => r.kind),
    ['notebook', 'metric', 'metric'],
  )
  assert.equal(runs.filter((r) => r.kind === 'notebook').length, 1)
  assert.equal(runs[1].teacherError, 'ZeroDivisionError')
  assert.equal(runs[2].publicScore, 0.041)
  assert.equal(finishRun('нет такого', { verdict: 'ok' }), null)
})

/* ---------------------------------------------------------------- очередь */

test('очередь честная по людям: своя вторая посылка ждёт за чужой первой', () => {
  drainQueue()
  const c = freshCompetition('queue-fair')
  const timur = createEntrant('Тимур').entrant
  const anna = createEntrant('Анна').entrant
  const at = Date.now()
  const t1 = acceptSubmission({ competitionId: c.id, entrantId: timur.id, fileName: '1', bytes: 1, at })
  const t2 = acceptSubmission({
    competitionId: c.id,
    entrantId: timur.id,
    fileName: '2',
    bytes: 1,
    at: at + 1,
  })
  const a1 = acceptSubmission({
    competitionId: c.id,
    entrantId: anna.id,
    fileName: '3',
    bytes: 1,
    at: at + 2,
  })
  assert.equal(waitingCount(), 3)

  // Первым — тот, кто пришёл раньше.
  const first = takeNext()
  assert.equal(first?.submissionId, t1.id)
  assert.equal(first?.state, 'running')
  assert.equal(first?.boot, BOOT)
  // Одна посылка за раз: второй заход ничего не отдаёт, пока первая идёт.
  assert.equal(takeNext(), null)
  leaveQueue(t1.id)

  // Вторая посылка Тимура стоит ЗА первой посылкой Анны, хотя пришла раньше:
  // иначе один человек занимает исполнителя на полчаса.
  const second = takeNext()
  assert.equal(second?.submissionId, a1.id)
  leaveQueue(a1.id)
  assert.equal(takeNext()?.submissionId, t2.id)
  leaveQueue(t2.id)
  assert.equal(takeNext(), null)
})

test('у кого уже что-то исполняется, тот пропускает остальных вперёд', () => {
  drainQueue()
  const c = freshCompetition('queue-busy')
  const busy = createEntrant('Занятый').entrant
  const fresh = createEntrant('Свежий').entrant
  const at = Date.now()
  const running = acceptSubmission({
    competitionId: c.id,
    entrantId: busy.id,
    fileName: '1',
    bytes: 1,
    at,
  })
  assert.equal(takeNext()?.submissionId, running.id)
  // Его же вторая пришла раньше чужой, но исполнитель отдан не ему.
  acceptSubmission({ competitionId: c.id, entrantId: busy.id, fileName: '2', bytes: 1, at: at + 1 })
  const theirs = acceptSubmission({
    competitionId: c.id,
    entrantId: fresh.id,
    fileName: '3',
    bytes: 1,
    at: at + 2,
  })
  assert.equal(takeNext({ slots: 2 })?.submissionId, theirs.id)
})

test('приостановленная очередь не начинает новых прогонов', () => {
  drainQueue()
  const c = freshCompetition('queue-pause')
  const person = createEntrant('Кто-то').entrant
  const s = acceptSubmission({ competitionId: c.id, entrantId: person.id, fileName: '1', bytes: 1 })
  setQueuePaused(true, 'teacher-1')
  assert.equal(queuePaused(), true)
  assert.equal(takeNext(), null)
  setQueuePaused(false)
  assert.equal(queuePaused(), false)
  assert.equal(takeNext()?.submissionId, s.id)
  leaveQueue(s.id)
})

test('перезапуск сервера: чужая жизнь процесса видна, работа поднимается заново', () => {
  drainQueue()
  const c = freshCompetition('queue-restart')
  const person = createEntrant('Переживший').entrant
  const s = acceptSubmission({ competitionId: c.id, entrantId: person.id, fileName: '1', bytes: 1 })
  // Прогон начала ПРОШЛАЯ жизнь процесса — ровно то, что видно после `make stop`.
  const taken = takeNext({ boot: 'жизнь-прошлая' })
  assert.equal(taken?.submissionId, s.id)
  assert.equal(taken?.attempts, 1)

  assert.deepEqual(
    orphanedRuns(BOOT).map((r) => r.submissionId),
    [s.id],
  )
  // Своя работа осиротевшей не считается.
  assert.equal(orphanedRuns('жизнь-прошлая').length, 0)

  const first = reclaimQueue(BOOT)
  assert.equal(first.requeued.length, 1)
  assert.equal(first.abandoned.length, 0)
  assert.equal(queueRows().find((r) => r.submissionId === s.id)?.state, 'waiting')

  // Второй перезапуск на той же посылке: дальше её крутить значит занимать
  // исполнителя тем, что не считается.
  takeNext({ boot: 'жизнь-прошлая-2' })
  const second = reclaimQueue(BOOT)
  assert.equal(second.requeued.length, 0)
  assert.deepEqual(
    second.abandoned.map((r) => r.submissionId),
    [s.id],
  )
  // Помечена как беда преподавателя, а не как ошибка участника: он тут ни при чём.
  assert.equal(getSubmission(s.id)?.state, 'metricFailed')
  assert.match(getSubmission(s.id)?.teacherError ?? '', /перезапуском сервера/)
  assert.equal(queueRows().find((r) => r.submissionId === s.id), undefined)
})

test('пересчёт возвращает посылку в очередь, а не заводит новую', () => {
  drainQueue()
  const c = freshCompetition('queue-requeue')
  const person = createEntrant('Пересчитываемый').entrant
  const s = acceptSubmission({ competitionId: c.id, entrantId: person.id, fileName: '1', bytes: 1 })
  takeNext()
  leaveQueue(s.id)
  enqueue({
    submissionId: s.id,
    competitionId: c.id,
    entrantId: person.id,
    kind: 'metric',
  })
  const row = queueRows().find((r) => r.submissionId === s.id)
  assert.equal(row?.kind, 'metric')
  assert.equal(row?.state, 'waiting')
  assert.equal(row?.attempts, 0)
  // Та же посылка, а не вторая: номер «#1» не должен появляться дважды.
  assert.equal(listEntrantSubmissions(c.id, person.id).length, 1)
  leaveQueue(s.id)
})

/* ------------------------------------------------------------------ диск */

test('ответы лежат в DATA_DIR и никогда в WORKSPACE_DIR', () => {
  const c = freshCompetition('disk-secret')
  putSecretFile(c.id, 'solution.csv', bytes('id,orders\n1,5\n'))
  putOpenFile(c.id, 'train.csv', bytes('id,orders\n1,5\n'))

  const secret = path.join(secretDir(c.id), 'solution.csv')
  assert.ok(fs.existsSync(secret))
  // Единственная проверка этого файла, ради которой он написан: рабочая папка
  // занятий монтируется в контейнеры комнат, и всё, что там лежит, читает
  // любой студент из Python (SECURITY.md).
  assert.ok(secret.startsWith(config.dataDir))
  assert.ok(!secret.startsWith(config.workspaceDir))
  assert.ok(openDir(c.id).startsWith(config.dataDir))
  // Ответы лежат РЯДОМ с открытыми файлами, а не внутри них: открытый каталог
  // уезжает в контейнер участника целиком.
  assert.ok(!secretDir(c.id).startsWith(openDir(c.id)))
  assert.equal(readSecretFile(c.id, 'solution.csv')?.toString(), 'id,orders\n1,5\n')

  // Имя файла едет в путь, и строка «../../colloq.db» путём не становится.
  assert.throws(() => putOpenFile(c.id, '../escape.csv', bytes('x')))
  assert.throws(() => putSecretFile(c.id, '/etc/passwd', bytes('x')))
})

test('каталог посылки не переиспользуется: тот же идентификатор второй раз — отказ', () => {
  const c = freshCompetition('disk-submission')
  const person = createEntrant('Присылающий').entrant
  const s = acceptSubmission({ competitionId: c.id, entrantId: person.id, fileName: 'n.ipynb', bytes: 3 })
  const dirs = putSubmissionNotebook(c.id, s.id, bytes('{"cells":[]}'))
  assert.ok(fs.existsSync(path.join(dirs.input, 'notebook.ipynb')))
  assert.ok(fs.existsSync(dirs.result))
  // На colima путь, у которого сменился inode, продолжает отдаваться
  // контейнеру старым — и посылка молча не видит своей тетради.
  assert.throws(() => putSubmissionNotebook(c.id, s.id, bytes('{}')))
  assert.equal(removeSubmission(c.id, s.id), true)
  assert.equal(fs.existsSync(dirs.input), false)
})

test('удаление соревнования уносит строки и файлы, включая ответы', () => {
  const c = freshCompetition('disk-delete')
  const person = createEntrant('Уходящий').entrant
  const s = acceptSubmission({ competitionId: c.id, entrantId: person.id, fileName: 'x.ipynb', bytes: 1 })
  const run = startRun({ submissionId: s.id, kind: 'notebook' })
  putFile({ competitionId: c.id, name: 'train.csv', bytes: 10, rows: 1, visibility: 'open' })
  putOpenFile(c.id, 'train.csv', bytes('id\n1\n'))
  putSecretFile(c.id, 'solution.csv', bytes('id\n1\n'))
  putSubmissionNotebook(c.id, s.id, bytes('{}'))
  const root = path.join(competitionsDir, c.id)
  assert.ok(fs.existsSync(root))

  assert.equal(deleteCompetition(c.id), true)
  assert.equal(getCompetition(c.id), null)
  assert.equal(getSubmission(s.id), null)
  assert.equal(listRuns(s.id).length, 0)
  assert.equal(listFiles(c.id).length, 0)
  assert.equal(queueRows().find((r) => r.submissionId === s.id), undefined)
  // Ответы, оставшиеся на диске от удалённого соревнования, — единственная
  // ошибка из этой проверки, которую вообще некому заметить.
  assert.equal(fs.existsSync(root), false)
  assert.equal(run.seq, 1)
  assert.equal(deleteCompetition(c.id), false)
})

test('уборка снимает каталоги соревнований, которых больше нет в базе', () => {
  const c = freshCompetition('disk-sweep')
  putOpenFile(c.id, 'train.csv', bytes('id\n1\n'))
  // Каталог без строки — след пути удаления, который про это хранилище не знал.
  putOpenFile('zz-orphan', 'train.csv', bytes('id\n1\n'))
  assert.ok(fs.existsSync(path.join(competitionsDir, 'zz-orphan')))
  const dropped = sweepOrphans(liveCompetitionIds())
  assert.ok(dropped >= 1)
  assert.equal(fs.existsSync(path.join(competitionsDir, 'zz-orphan')), false)
  // Живое соревнование уборка не трогает.
  assert.ok(fs.existsSync(path.join(competitionsDir, c.id)))
})

test('тяжёлое от старых посылок уходит, а числа остаются в базе', () => {
  const c = freshCompetition('disk-prune')
  const person = createEntrant('Настойчивый').entrant
  const made = []
  for (let i = 0; i < 4; i++) {
    const s = acceptSubmission({
      competitionId: c.id,
      entrantId: person.id,
      fileName: `n${i}.ipynb`,
      bytes: 1,
      at: Date.now() + i,
    })
    putSubmissionNotebook(c.id, s.id, bytes('{}'))
    updateSubmission(s.id, { state: 'scored', stage: 'score', publicScore: i })
    made.push(s)
  }
  const dropped = pruneCompetitionFiles(c.id, 2)
  assert.equal(dropped, 2)
  // Две свежие остались на диске, две старые ушли…
  assert.ok(fs.existsSync(path.join(competitionsDir, c.id, 's', made[3].id)))
  assert.equal(fs.existsSync(path.join(competitionsDir, c.id, 's', made[0].id)), false)
  // …а лидерборд обязан сойтись и через год, поэтому числа на месте.
  assert.equal(listEntrantSubmissions(c.id, person.id).length, 4)
  assert.equal(getSubmission(made[0].id)?.publicScore, 0)
})

test('путь для docker переводится через DATA_HOST_DIR и только при нём', () => {
  const inside = path.join(competitionsDir, 'abc', 'data')
  assert.equal(hostPathOf(inside), inside)
  const was = process.env.DATA_HOST_DIR
  process.env.DATA_HOST_DIR = '/host/data'
  try {
    // Под `make up` сервер сам в контейнере: путь, по которому файл видит он,
    // демону docker неизвестен, и посылка молча получила бы пустой каталог.
    assert.equal(hostPathOf(inside), path.join('/host/data', 'competitions', 'abc', 'data'))
  } finally {
    if (was === undefined) delete process.env.DATA_HOST_DIR
    else process.env.DATA_HOST_DIR = was
  }
})
