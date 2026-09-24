/**
 * The competition store: rows, the queue and files on disk.
 *
 * What is checked is what breaks quietly. A submission number handed out
 * twice. A daily quota counted in the wrong time zone. Two "counted" marks on
 * one person. A queue that after a server restart keeps a submission
 * "running" until the end of the competition. And answer files left on disk
 * by a deleted competition — the one mistake on this list that nobody would
 * ever notice.
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
 * There is one queue per instance, and that is not a circumstance of the test
 * but the design of the product: the machine has one executor for all
 * competitions. So queue checks start from a clean slate, otherwise the
 * previous tests' submissions are sitting in it.
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
  assert.ok(made, `could not create ${slug}`)
  return made
}

/* ---------------------------------------------------------- competitions */

test('a competition is born as a draft, and its address is unique across all of them', () => {
  const made = freshCompetition('rohlik')
  assert.equal(made.state, 'draft')
  assert.equal(made.metric.direction, 'lower')
  assert.equal(made.limits.perDay, 5)
  // The split seed is issued at birth: without it there is no way to
  // reproduce which rows were public.
  assert.ok(made.splitSeed.length > 0)

  // Uniqueness is held by the database, not by a check before the insert: two
  // teachers saving a draft in the same second would both pass such a check.
  assert.equal(createCompetition({ slug: 'rohlik', title: 'Другое' }), null)

  assert.equal(findCompetition('rohlik')?.id, made.id)
  assert.equal(findCompetition(made.id)?.slug, 'rohlik')
  assert.equal(findCompetition('нет такого'), null)
  assert.ok(listCompetitions().some((c) => c.id === made.id))
})

test('an edit touches only the fields that came in, and a taken address says so in a word', () => {
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
  // The metric code was not in the patch, and it stayed as it was.
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

/* ------------------------------------------------------------------ files */

test('competition files know who sees them, and open ones are counted separately', () => {
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
  // The "up to 200 MB per competition" ceiling counts open files: the answers
  // do not count, since the teacher uploads them and nobody downloads them.
  assert.equal(openFileBytes(c.id), 4_312_000)
  // Uploading the same name again is a replacement, not a second file.
  putFile({ competitionId: c.id, name: 'train.csv', bytes: 10, rows: 1, visibility: 'open' })
  assert.equal(listFiles(c.id, 'open').length, 2)
  assert.equal(openFileBytes(c.id), 212_010)
  assert.equal(dropFile(c.id, 'train.csv'), true)
  assert.equal(dropFile(c.id, 'train.csv'), false)
})

/* ---------------------------------------------------------------- entrants */

test('a sign-in key brings a person back, and a new key takes the power from the old one', () => {
  const minted = createEntrant('Тимур Ахметов')
  const person = minted.entrant
  assert.match(minted.key, /^[A-Z0-9]{3}-[A-Z0-9]{3}-[A-Z0-9]{3}$/)
  assert.equal(entrantByKey(minted.key)?.id, person.id)
  assert.equal(person.disabled, false)

  const rotated = rotateEntrantKey(person.id)
  assert.ok(rotated)
  assert.notEqual(rotated.key, minted.key)
  // There is no other way to take back a string that has been handed out: the
  // old key stops being a way in.
  assert.equal(entrantByKey(minted.key), null)
  assert.equal(entrantByKey(rotated.key)?.id, person.id)
  assert.equal(getEntrant(person.id)?.name, 'Тимур Ахметов')
  assert.equal(rotateEntrantKey('нет такого'), null)

  // Different people's keys never coincide — a unique index sees to that.
  const keys = new Set([rotated.key])
  for (let i = 0; i < 20; i++) keys.add(createEntrant(`Участник ${i}`).key)
  assert.equal(keys.size, 21)
})

/* ------------------------------------------------------------ submissions */

test('a submission number is per competition and is never handed out twice', () => {
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
  // "#12" is a number within the competition, not one running across the
  // instance.
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
  // Timur is not in the neighbouring competition at all.
  assert.deepEqual(
    listCompetitionEntrants(two.id).map((e) => e.id),
    [anna.id],
  )
})

test("the daily quota is counted in the class's time zone and leaves yesterday's submissions alone", () => {
  const c = freshCompetition('quota')
  const person = createEntrant('Марфа').entrant
  const now = Date.UTC(2026, 8, 20, 12)
  const startOfDay = dayStart(now, MSK)

  // Exactly on the MSK day boundary is already today; a second earlier is
  // yesterday.
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

  // One that failed BEFORE the first cell does not use the quota — the mockup
  // promises that.
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

  // Zero means "no limit", which is not the same as "none at all".
  const open = updateCompetition(c.id, { limits: { perDay: 0 } })
  assert.ok(open && open !== 'taken')
  assert.equal(leftToday(open, person.id, now, MSK), null)
})

test("exactly one of a person's submissions is counted, and only one that reached a score", () => {
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
  // The second mark removes the first: two "counted" marks make a leaderboard
  // that disagrees with itself.
  assert.equal(chooseSubmission(c.id, person.id, better.id), true)
  assert.equal(getSubmission(good.id)?.chosen, false)
  assert.equal(getSubmission(better.id)?.chosen, true)
  // A failed one has no score to put in the table.
  assert.equal(chooseSubmission(c.id, person.id, failed.id), false)
  // Someone else's cannot be chosen — and it is the store that checks this,
  // not the screen.
  assert.equal(chooseSubmission(c.id, other.id, better.id), false)
})

test("the leaderboard takes one submission per person and knows the metric's direction", () => {
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
  // Anna has two submissions; the table has one, the one she chose herself.
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

  // A "higher is better" metric flips both the table and the "best public".
  assert.ok(updateCompetition(c.id, { metric: { direction: 'higher' } }))
  assert.equal(leaderboard(c.id, 'public')[0].entrantId, anna.id)
  assert.equal(competitionSummary(c.id).bestPublic, 0.0460)
})

/* ------------------------------------------------------------------- runs */

test('runs accumulate one per attempt, and a metric rescore does not touch the notebook', () => {
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
  // A rescore after a metric fix is one more run of kind metric, and the
  // notebook is not run a second time.
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

/* ------------------------------------------------------------------ queue */

test("the queue is fair per person: one's own second submission waits behind someone else's first", () => {
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

  // Whoever came earlier goes first.
  const first = takeNext()
  assert.equal(first?.submissionId, t1.id)
  assert.equal(first?.state, 'running')
  assert.equal(first?.boot, BOOT)
  // One submission at a time: a second take returns nothing while the first
  // is running.
  assert.equal(takeNext(), null)
  leaveQueue(t1.id)

  // Timur's second submission stands BEHIND Anna's first although it came
  // earlier: otherwise one person occupies the executor for half an hour.
  const second = takeNext()
  assert.equal(second?.submissionId, a1.id)
  leaveQueue(a1.id)
  assert.equal(takeNext()?.submissionId, t2.id)
  leaveQueue(t2.id)
  assert.equal(takeNext(), null)
})

test('whoever already has something running lets the others go first', () => {
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
  // His own second one came before the other person's, but the executor is
  // not given to him.
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

test('a paused queue starts no new runs', () => {
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

test("server restart: another process lifetime's work is visible and gets picked up again", () => {
  drainQueue()
  const c = freshCompetition('queue-restart')
  const person = createEntrant('Переживший').entrant
  const s = acceptSubmission({ competitionId: c.id, entrantId: person.id, fileName: '1', bytes: 1 })
  // The run was started by a PREVIOUS process lifetime — exactly what is seen
  // after `make stop`.
  const taken = takeNext({ boot: 'жизнь-прошлая' })
  assert.equal(taken?.submissionId, s.id)
  assert.equal(taken?.attempts, 1)

  assert.deepEqual(
    orphanedRuns(BOOT).map((r) => r.submissionId),
    [s.id],
  )
  // One's own work does not count as orphaned.
  assert.equal(orphanedRuns('жизнь-прошлая').length, 0)

  const first = reclaimQueue(BOOT)
  assert.equal(first.requeued.length, 1)
  assert.equal(first.abandoned.length, 0)
  assert.equal(queueRows().find((r) => r.submissionId === s.id)?.state, 'waiting')

  // A second restart on the same submission: spinning it further would occupy
  // the executor with something that does not count.
  takeNext({ boot: 'жизнь-прошлая-2' })
  const second = reclaimQueue(BOOT)
  assert.equal(second.requeued.length, 0)
  assert.deepEqual(
    second.abandoned.map((r) => r.submissionId),
    [s.id],
  )
  // Marked as the teacher's trouble, not as the entrant's error: the entrant
  // has nothing to do with it.
  assert.equal(getSubmission(s.id)?.state, 'metricFailed')
  assert.match(getSubmission(s.id)?.teacherError ?? '', /перезапуском сервера/)
  assert.equal(queueRows().find((r) => r.submissionId === s.id), undefined)
})

test('a rescore puts the submission back into the queue instead of creating a new one', () => {
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
  // The same submission, not a second one: the number "#1" must not appear
  // twice.
  assert.equal(listEntrantSubmissions(c.id, person.id).length, 1)
  leaveQueue(s.id)
})

/* ------------------------------------------------------------------ disk */

test('answer files live in DATA_DIR and never in WORKSPACE_DIR', () => {
  const c = freshCompetition('disk-secret')
  putSecretFile(c.id, 'solution.csv', bytes('id,orders\n1,5\n'))
  putOpenFile(c.id, 'train.csv', bytes('id,orders\n1,5\n'))

  const secret = path.join(secretDir(c.id), 'solution.csv')
  assert.ok(fs.existsSync(secret))
  // The one check this file was written for: the classes' workspace folder is
  // mounted into the room containers, and anything lying there can be read by
  // any student from Python (SECURITY.md).
  assert.ok(secret.startsWith(config.dataDir))
  assert.ok(!secret.startsWith(config.workspaceDir))
  assert.ok(openDir(c.id).startsWith(config.dataDir))
  // The answers lie NEXT TO the open files, not inside them: the open
  // directory goes into the entrant's container whole.
  assert.ok(!secretDir(c.id).startsWith(openDir(c.id)))
  assert.equal(readSecretFile(c.id, 'solution.csv')?.toString(), 'id,orders\n1,5\n')

  // The file name goes into a path, and the string "../../colloq.db" does not
  // become a path.
  assert.throws(() => putOpenFile(c.id, '../escape.csv', bytes('x')))
  assert.throws(() => putSecretFile(c.id, '/etc/passwd', bytes('x')))
})

test('a submission directory is not reused: the same id a second time is refused', () => {
  const c = freshCompetition('disk-submission')
  const person = createEntrant('Присылающий').entrant
  const s = acceptSubmission({ competitionId: c.id, entrantId: person.id, fileName: 'n.ipynb', bytes: 3 })
  const dirs = putSubmissionNotebook(c.id, s.id, bytes('{"cells":[]}'))
  assert.ok(fs.existsSync(path.join(dirs.input, 'notebook.ipynb')))
  assert.ok(fs.existsSync(dirs.result))
  // On colima a path whose inode changed keeps being served to the container
  // as the old one — and the submission silently does not see its notebook.
  assert.throws(() => putSubmissionNotebook(c.id, s.id, bytes('{}')))
  assert.equal(removeSubmission(c.id, s.id), true)
  assert.equal(fs.existsSync(dirs.input), false)
})

test('deleting a competition removes its rows and files, answers included', () => {
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
  // Answers left on disk by a deleted competition are the one mistake in this
  // check that nobody would ever notice.
  assert.equal(fs.existsSync(root), false)
  assert.equal(run.seq, 1)
  assert.equal(deleteCompetition(c.id), false)
})

test('the sweep removes directories of competitions that are no longer in the database', () => {
  const c = freshCompetition('disk-sweep')
  putOpenFile(c.id, 'train.csv', bytes('id\n1\n'))
  // A directory without a row is the trace of a deletion path that did not
  // know about this store.
  putOpenFile('zz-orphan', 'train.csv', bytes('id\n1\n'))
  assert.ok(fs.existsSync(path.join(competitionsDir, 'zz-orphan')))
  const dropped = sweepOrphans(liveCompetitionIds())
  assert.ok(dropped >= 1)
  assert.equal(fs.existsSync(path.join(competitionsDir, 'zz-orphan')), false)
  // The sweep leaves a live competition alone.
  assert.ok(fs.existsSync(path.join(competitionsDir, c.id)))
})

test('the heavy parts of old submissions go away, while the scores stay in the database', () => {
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
  // Two fresh ones stayed on disk, two old ones went away…
  assert.ok(fs.existsSync(path.join(competitionsDir, c.id, 's', made[3].id)))
  assert.equal(fs.existsSync(path.join(competitionsDir, c.id, 's', made[0].id)), false)
  // …and the leaderboard must add up even a year later, so the scores stay.
  assert.equal(listEntrantSubmissions(c.id, person.id).length, 4)
  assert.equal(getSubmission(made[0].id)?.publicScore, 0)
})

test('the path for docker is translated through DATA_HOST_DIR, and only when it is set', () => {
  const inside = path.join(competitionsDir, 'abc', 'data')
  assert.equal(hostPathOf(inside), inside)
  const was = process.env.DATA_HOST_DIR
  process.env.DATA_HOST_DIR = '/host/data'
  try {
    // Under `make up` the server is itself in a container: the path by which it
    // sees a file is unknown to the docker daemon, and the submission would
    // silently get an empty directory.
    assert.equal(hostPathOf(inside), path.join('/host/data', 'competitions', 'abc', 'data'))
  } finally {
    if (was === undefined) delete process.env.DATA_HOST_DIR
    else process.env.DATA_HOST_DIR = was
  }
})
