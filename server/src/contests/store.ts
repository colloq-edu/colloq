/**
 * Contests: the queries over their tables (contests/schema.ts creates them).
 *
 * WHAT IS HERE AND WHAT IS NOT. Rows: contests, problems, the tests' marks
 * and sizes, IOI groups, who joined, submissions (which are also the judge's
 * queue), questions. The rules are @shared/contests', and this module CALLS
 * them rather than repeating them — which verdict spends an attempt, what a
 * test is worth — because the page computes the same things and a second copy
 * would quietly disagree. The disk is contests/storage.ts; the judging is
 * contests/pump.ts, which takes rows from here and writes outcomes back.
 *
 * THE PARTICIPANT IS THE COMPETITIONS' ENTRANT. The instance-level identity
 * (its key, its cookie, its one name) is competitions/store.ts's, and this
 * module calls its functions — createEntrant, getEntrant, renameEntrant —
 * rather than keeping a second copy of any of it. What is the contests' own is
 * the enrollment (contest_entrants) and the namesake rule inside a contest.
 * The other direction is kept too: the competitions' store deletes a person
 * only when no contest holds them either (its selectAnywhere), and the
 * removal here deletes one only when no competition does (stillHeld).
 *
 * EVERY WRITE SAYS WHAT IT TOUCHED (events.ts · noteContest), so the pages'
 * streams push instead of polling. The note is delivered after the write's
 * turn of the event loop, so a note from inside a transaction that rolls back
 * costs a recomputation that finds nothing new, never a lie.
 */
import { createHash, randomInt } from 'node:crypto'
import { tr } from '@shared/i18n'
import { db } from '../db.js'
import './schema.js'
import { BOOT, createEntrant, renameEntrant } from '../competitions/store.js'
import { LIMITS as COMPETITION_LIMITS, entrantNameKey, type MintedEntrant } from '@shared/competitions'
import {
  CHECKER_KINDS,
  CONTEST_LANGUAGES,
  CONTEST_LIMITS,
  MAX_PROBLEMS,
  spendsLimit,
  type CheckerKind,
  type Contest,
  type ContestGroup,
  type ContestLanguage,
  type ContestProblem,
  type ContestRules,
  type ContestState,
  type ContestSubmission,
  type ContestTest,
  type JudgeState,
  type StandingAttempt,
  type SubmissionKind,
  type TestReport,
  type Verdict,
} from '@shared/contests'
import { noteContest } from './events.js'

export { BOOT }

/* ------------------------------------------------------------------ names */

/** The competitions' alphabet, meant to be read aloud; the ids go into paths on disk, so their letters are plain. */
const ID_ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789'

function newId(length = 8): string {
  let out = ''
  for (let i = 0; i < length; i++) out += ID_ALPHABET[randomInt(0, ID_ALPHABET.length)]
  return out
}

function isUniqueViolation(error: unknown): boolean {
  const code = (error as { code?: string })?.code
  return code === 'SQLITE_CONSTRAINT_UNIQUE' || code === 'SQLITE_CONSTRAINT_PRIMARYKEY'
}

const clip = (value: unknown, max: number): string => (typeof value === 'string' ? value.slice(0, max) : '')

/** At most this many submissions of one person in one contest wait or run at once (the door's `in_flight`). */
export const MAX_PENDING = 2

/** How many starts cut short by restarts a judging gets before it ends as the judge's failure. */
export const MAX_STARTS = 3

/* --------------------------------------------------------------- contests */

interface ContestRow {
  id: string
  slug: string
  title: string
  blurb: string
  description: string
  state: string
  rules: string
  penalty_minutes: number
  freeze_minutes: number
  unfrozen_at: number | null
  attempts_per_problem: number
  languages: string
  environment: string
  starts_at: number | null
  ends_at: number | null
  upsolving: number
  board_visibility: string
  course_id: string | null
  created_by: string | null
  hidden_at: number | null
  revision: number
  created_at: number
  updated_at: number
}

/** The stored list, kept to the languages this build knows: a row a newer build wrote must still open. */
function parseLanguages(raw: string): ContestLanguage[] {
  try {
    const parsed = JSON.parse(raw) as unknown
    if (Array.isArray(parsed)) {
      const known = parsed.filter((id): id is ContestLanguage => CONTEST_LANGUAGES.includes(id as ContestLanguage))
      if (known.length > 0) return [...new Set(known)]
    }
  } catch {
    // A broken list reads as the default below.
  }
  return ['python3']
}

function toContest(row: ContestRow): Contest {
  return {
    id: row.id,
    slug: row.slug,
    title: row.title,
    blurb: row.blurb,
    description: row.description,
    state: (row.state === 'live' || row.state === 'finished' ? row.state : 'draft') as ContestState,
    rules: row.rules === 'ioi' ? 'ioi' : 'icpc',
    penaltyMinutes: row.penalty_minutes,
    freezeMinutes: row.freeze_minutes,
    unfrozenAt: row.unfrozen_at,
    attemptsPerProblem: row.attempts_per_problem,
    languages: parseLanguages(row.languages),
    environment: row.environment,
    startsAt: row.starts_at,
    endsAt: row.ends_at,
    upsolving: row.upsolving === 1,
    boardVisibility: row.board_visibility === 'entrants' ? 'entrants' : 'public',
    courseId: row.course_id ?? null,
    createdBy: row.created_by,
    hiddenAt: row.hidden_at ?? null,
    revision: row.revision,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

const insertContest = db.prepare(`
  INSERT INTO contests (id, slug, title, rules, course_id, created_by, created_at, updated_at)
  VALUES (@id, @slug, @title, @rules, @course_id, @created_by, @at, @at)
`)
const selectContest = db.prepare('SELECT * FROM contests WHERE id = ?')
const selectContestBySlug = db.prepare('SELECT * FROM contests WHERE slug = ?')
const selectContests = db.prepare('SELECT * FROM contests ORDER BY created_at DESC, id')

export interface NewContest {
  slug: string
  title: string
  rules?: ContestRules
  courseId?: string | null
  createdBy?: string | null
}

/**
 * A new contest, always a draft. `null` — the address is taken, decided by
 * the unique index rather than a look before the insert (two teachers saving
 * the same address in one second would both pass a look).
 */
export function createContest(input: NewContest, at = Date.now()): Contest | null {
  for (let attempt = 0; attempt < 8; attempt++) {
    const id = newId()
    if (selectContest.get(id)) continue
    try {
      insertContest.run({
        id,
        slug: input.slug,
        title: clip(input.title, CONTEST_LIMITS.title),
        rules: input.rules === 'ioi' ? 'ioi' : 'icpc',
        course_id: input.courseId ?? null,
        created_by: input.createdBy ?? null,
        at,
      })
    } catch (error) {
      if (isUniqueViolation(error)) return null
      throw error
    }
    noteContest(id, 'revision')
    return getContest(id)
  }
  throw new Error('Could not mint a unique contest id')
}

export function getContest(id: string): Contest | null {
  const row = selectContest.get(id) as ContestRow | undefined
  return row ? toContest(row) : null
}

/** By address or by id — the way `/a/<slug>` and the panel's `/:id` are opened. */
export function findContest(slugOrId: string): Contest | null {
  const key = String(slugOrId ?? '')
  const row = (selectContestBySlug.get(key) ?? selectContest.get(key)) as ContestRow | undefined
  return row ? toContest(row) : null
}

export function listContests(): Contest[] {
  return (selectContests.all() as ContestRow[]).map(toContest)
}

/** The fields the editor edits; anything not in the patch stays as it was. */
export type ContestFields = Partial<
  Pick<
    Contest,
    | 'slug'
    | 'title'
    | 'blurb'
    | 'description'
    | 'rules'
    | 'penaltyMinutes'
    | 'freezeMinutes'
    | 'attemptsPerProblem'
    | 'languages'
    | 'environment'
    | 'startsAt'
    | 'endsAt'
    | 'upsolving'
    | 'boardVisibility'
    | 'courseId'
  >
>

const CONTEST_COLUMN: Record<keyof ContestFields, string> = {
  slug: 'slug',
  title: 'title',
  blurb: 'blurb',
  description: 'description',
  rules: 'rules',
  penaltyMinutes: 'penalty_minutes',
  freezeMinutes: 'freeze_minutes',
  attemptsPerProblem: 'attempts_per_problem',
  languages: 'languages',
  environment: 'environment',
  startsAt: 'starts_at',
  endsAt: 'ends_at',
  upsolving: 'upsolving',
  boardVisibility: 'board_visibility',
  courseId: 'course_id',
}

/**
 * Edit a contest: one UPDATE over the fields that came, never «save the whole
 * form» (the editor's sections save apart). `null` — no such contest;
 * `'taken'` — the new address is another contest's. The values are the
 * door's to check (routes/admin-contests.ts · parseContestPatch); the text
 * fields are clipped here too, so no caller can store past the caps.
 */
export function updateContest(id: string, patch: ContestFields, at = Date.now()): Contest | null | 'taken' {
  const sets: string[] = []
  const params: Record<string, unknown> = { id, at }
  for (const [key, value] of Object.entries(patch) as [keyof ContestFields, unknown][]) {
    const column = CONTEST_COLUMN[key]
    if (!column || value === undefined) continue
    let stored: unknown = value
    if (key === 'title') stored = clip(value, CONTEST_LIMITS.title)
    else if (key === 'blurb') stored = clip(value, CONTEST_LIMITS.blurb)
    else if (key === 'description') stored = clip(value, CONTEST_LIMITS.description)
    else if (key === 'languages') stored = JSON.stringify(value)
    else if (typeof value === 'boolean') stored = value ? 1 : 0
    sets.push(`${column} = @${column}`)
    params[column] = stored
  }
  if (sets.length === 0) return getContest(id)
  try {
    const result = db.prepare(`UPDATE contests SET ${sets.join(', ')}, updated_at = @at WHERE id = @id`).run(params)
    if (result.changes === 0) return null
  } catch (error) {
    if (isUniqueViolation(error)) return 'taken'
    throw error
  }
  noteContest(id, 'revision')
  return getContest(id)
}

const updateContestState = db.prepare('UPDATE contests SET state = ?, updated_at = ? WHERE id = ?')
const updateContestHidden = db.prepare('UPDATE contests SET hidden_at = ? WHERE id = ?')
const updateContestUnfrozen = db.prepare('UPDATE contests SET unfrozen_at = ?, updated_at = ? WHERE id = ?')
const bumpRevision = db.prepare('UPDATE contests SET revision = revision + 1 WHERE id = ?')

export function setContestState(id: string, state: ContestState, at = Date.now()): boolean {
  const done = updateContestState.run(state, at, id).changes > 0
  if (done) noteContest(id, 'revision')
  return done
}

/**
 * «Снять с публикации» (a moment) and «Опубликовать снова» (null): only the
 * mark, so publishing again brings back exactly what was there.
 */
export function setContestHidden(id: string, hiddenAt: number | null): boolean {
  const done = updateContestHidden.run(hiddenAt, id).changes > 0
  if (done) noteContest(id, 'revision')
  return done
}

/** «Разморозить»: the moment the frozen board was revealed to the class. */
export function setContestUnfrozen(id: string, at: number | null): boolean {
  const done = updateContestUnfrozen.run(at, at ?? Date.now(), id).changes > 0
  if (done) noteContest(id, 'revision')
  return done
}

/** The clock moved the contest into another phase (pump.ts · watchPhases): pages that compare the revision reload. */
export function bumpContestRevision(id: string): void {
  if (bumpRevision.run(id).changes > 0) noteContest(id, 'revision')
}

/**
 * Delete a contest's rows — all of them, the identities of its people
 * excepted: a person lives on the instance, and their key must keep opening
 * the other contests and competitions. `'running'` — a judging of it is in a
 * container now, and nothing is touched (the door stops them first,
 * pump.ts · stopContestJudgings); the files are the caller's, after the
 * commit.
 */
export function deleteContestRows(id: string): boolean | 'running' {
  const outcome = db.transaction((contestId: string): number | 'running' => {
    if (db.prepare("SELECT 1 FROM contest_submissions WHERE contest_id = ? AND state = 'running' LIMIT 1").get(contestId)) {
      return 'running'
    }
    const problems = `SELECT id FROM contest_problems WHERE contest_id = ?`
    db.prepare(`DELETE FROM contest_tests WHERE problem_id IN (${problems})`).run(contestId)
    db.prepare(`DELETE FROM contest_groups WHERE problem_id IN (${problems})`).run(contestId)
    db.prepare('DELETE FROM contest_problems WHERE contest_id = ?').run(contestId)
    db.prepare('DELETE FROM contest_submissions WHERE contest_id = ?').run(contestId)
    db.prepare('DELETE FROM contest_questions WHERE contest_id = ?').run(contestId)
    db.prepare('DELETE FROM contest_seen WHERE contest_id = ?').run(contestId)
    db.prepare('DELETE FROM contest_entrants WHERE contest_id = ?').run(contestId)
    return db.prepare('DELETE FROM contests WHERE id = ?').run(contestId).changes
  })(id)
  if (outcome === 'running') return 'running'
  if (outcome > 0) noteContest(id, 'revision')
  return outcome > 0
}

/* --------------------------------------------------------------- problems */

interface ProblemRow {
  id: string
  contest_id: string
  position: number
  title: string
  statement: string
  time_limit_ms: number
  memory_mb: number
  checker: string
  checker_epsilon: number
  checker_code: string
  points: string
  reference_language: string
  reference_source: string
  tests_revision: number
  created_at: number
  updated_at: number
}

function toProblem(row: ProblemRow): ContestProblem {
  return {
    id: row.id,
    contestId: row.contest_id,
    position: row.position,
    title: row.title,
    statement: row.statement,
    timeLimitMs: row.time_limit_ms,
    memoryMb: row.memory_mb,
    checker: (CHECKER_KINDS.includes(row.checker as CheckerKind) ? row.checker : 'tokens') as CheckerKind,
    checkerEpsilon: row.checker_epsilon,
    checkerCode: row.checker_code,
    points: row.points === 'groups' ? 'groups' : 'tests',
    referenceLanguage: (CONTEST_LANGUAGES.includes(row.reference_language as ContestLanguage) ? row.reference_language : 'python3') as ContestLanguage,
    referenceSource: row.reference_source,
    testsRevision: row.tests_revision,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

const selectProblem = db.prepare('SELECT * FROM contest_problems WHERE id = ?')
const selectProblems = db.prepare('SELECT * FROM contest_problems WHERE contest_id = ? ORDER BY position, created_at, id')
const countProblems = db.prepare('SELECT COUNT(*) AS n FROM contest_problems WHERE contest_id = ?')
const insertProblem = db.prepare(`
  INSERT INTO contest_problems
    (id, contest_id, position, title, statement, time_limit_ms, memory_mb, checker, checker_epsilon,
     checker_code, points, reference_language, reference_source, tests_revision, created_at, updated_at)
  VALUES
    (@id, @contest_id, @position, @title, @statement, @time_limit_ms, @memory_mb, @checker, @checker_epsilon,
     @checker_code, @points, @reference_language, @reference_source, 0, @at, @at)
`)
const updatePosition = db.prepare('UPDATE contest_problems SET position = ? WHERE id = ?')

export function getProblem(id: string): ContestProblem | null {
  const row = selectProblem.get(id) as ProblemRow | undefined
  return row ? toProblem(row) : null
}

/** A problem of THIS contest, or null: an id from another contest is no problem here. */
export function problemOf(contestId: string, problemId: string): ContestProblem | null {
  const problem = getProblem(problemId)
  return problem && problem.contestId === contestId ? problem : null
}

export function listProblems(contestId: string): ContestProblem[] {
  return (selectProblems.all(contestId) as ProblemRow[]).map(toProblem)
}

/** The fields a problem's editor edits. */
export type ProblemFields = Partial<
  Pick<
    ContestProblem,
    | 'title'
    | 'statement'
    | 'timeLimitMs'
    | 'memoryMb'
    | 'checker'
    | 'checkerEpsilon'
    | 'checkerCode'
    | 'points'
    | 'referenceLanguage'
    | 'referenceSource'
  >
>

const PROBLEM_COLUMN: Record<keyof ProblemFields, string> = {
  title: 'title',
  statement: 'statement',
  timeLimitMs: 'time_limit_ms',
  memoryMb: 'memory_mb',
  checker: 'checker',
  checkerEpsilon: 'checker_epsilon',
  checkerCode: 'checker_code',
  points: 'points',
  referenceLanguage: 'reference_language',
  referenceSource: 'reference_source',
}

/**
 * A new problem at the end of the contest; `'full'` — it has its 26 already
 * (one letter each, A to Z). A title not given is the letter's own, «Задача
 * C», in the instance's language.
 */
export function addProblem(contestId: string, fields: ProblemFields = {}, at = Date.now()): ContestProblem | 'full' {
  const made = db.transaction((): ContestProblem | 'full' => {
    const position = (countProblems.get(contestId) as { n: number }).n
    if (position >= MAX_PROBLEMS) return 'full'
    let id = newId()
    while (selectProblem.get(id)) id = newId()
    insertProblem.run({
      id,
      contest_id: contestId,
      position,
      title: clip(fields.title?.trim() || tr('contests.problem.defaultTitle', { letter: String.fromCharCode(65 + position) }), CONTEST_LIMITS.problemTitle),
      statement: clip(fields.statement ?? '', CONTEST_LIMITS.statement),
      time_limit_ms: fields.timeLimitMs ?? CONTEST_LIMITS.timeLimitMs.default,
      memory_mb: fields.memoryMb ?? CONTEST_LIMITS.memoryMb.default,
      checker: fields.checker ?? 'tokens',
      checker_epsilon: fields.checkerEpsilon ?? CONTEST_LIMITS.epsilon.default,
      checker_code: clip(fields.checkerCode ?? '', CONTEST_LIMITS.checkerCode),
      points: fields.points ?? 'tests',
      reference_language: fields.referenceLanguage ?? 'python3',
      reference_source: fields.referenceSource ?? '',
      at,
    })
    return getProblem(id)!
  })()
  if (made !== 'full') noteContest(contestId, 'revision')
  return made
}

export function updateProblem(id: string, fields: ProblemFields, at = Date.now()): ContestProblem | null {
  const sets: string[] = []
  const params: Record<string, unknown> = { id, at }
  for (const [key, value] of Object.entries(fields) as [keyof ProblemFields, unknown][]) {
    const column = PROBLEM_COLUMN[key]
    if (!column || value === undefined) continue
    let stored = value
    if (key === 'title') stored = clip(value, CONTEST_LIMITS.problemTitle)
    else if (key === 'statement') stored = clip(value, CONTEST_LIMITS.statement)
    else if (key === 'checkerCode') stored = clip(value, CONTEST_LIMITS.checkerCode)
    sets.push(`${column} = @${column}`)
    params[column] = stored
  }
  const problem = getProblem(id)
  if (!problem) return null
  if (sets.length === 0) return problem
  db.prepare(`UPDATE contest_problems SET ${sets.join(', ')}, updated_at = @at WHERE id = @id`).run(params)
  noteContest(problem.contestId, 'revision')
  return getProblem(id)
}

/**
 * Remove a problem with its tests, groups and submissions, and close the gap
 * in the letters. `'running'` — a judging of it is in a container now: its
 * outcome would be written into nothing, and its files are about to go.
 * The files are the caller's, after the commit.
 */
export function deleteProblemRows(id: string): { contestId: string } | 'running' | null {
  const outcome = db.transaction((): { contestId: string } | 'running' | null => {
    const problem = getProblem(id)
    if (!problem) return null
    if (db.prepare("SELECT 1 FROM contest_submissions WHERE problem_id = ? AND state = 'running' LIMIT 1").get(id)) return 'running'
    db.prepare('DELETE FROM contest_tests WHERE problem_id = ?').run(id)
    db.prepare('DELETE FROM contest_groups WHERE problem_id = ?').run(id)
    db.prepare('DELETE FROM contest_submissions WHERE problem_id = ?').run(id)
    // A question about it stays a question, about the contest as a whole.
    db.prepare('UPDATE contest_questions SET problem_id = NULL WHERE problem_id = ?').run(id)
    db.prepare('DELETE FROM contest_problems WHERE id = ?').run(id)
    listProblems(problem.contestId).forEach((left, index) => {
      if (left.position !== index) updatePosition.run(index, left.id)
    })
    return { contestId: problem.contestId }
  })()
  if (outcome && outcome !== 'running') {
    noteContest(outcome.contestId, 'revision')
    noteContest(outcome.contestId, 'submission')
  }
  return outcome
}

/**
 * Put the problems in this order. `false` — `ids` is not exactly the
 * contest's problems (one missing, one twice, one of another contest), and
 * nothing moved: half a reorder renames letters nobody chose.
 */
export function reorderProblems(contestId: string, ids: readonly string[]): boolean {
  const current = listProblems(contestId).map((problem) => problem.id)
  if (ids.length !== current.length || new Set(ids).size !== ids.length || !ids.every((id) => current.includes(id))) return false
  db.transaction(() => {
    ids.forEach((id, index) => updatePosition.run(index, id))
  })()
  noteContest(contestId, 'revision')
  return true
}

/* ------------------------------------------------------------------ tests */

interface TestRow {
  problem_id: string
  ordinal: number
  sample: number
  test_group: number
  input_bytes: number
  answer_bytes: number | null
  answer_from: string
}

function toTest(row: TestRow): ContestTest {
  return {
    problemId: row.problem_id,
    ordinal: row.ordinal,
    sample: row.sample === 1,
    group: row.test_group,
    inputBytes: row.input_bytes,
    answerBytes: row.answer_bytes,
    answerFrom: row.answer_from === 'reference' ? 'reference' : 'upload',
  }
}

const selectTests = db.prepare('SELECT * FROM contest_tests WHERE problem_id = ? ORDER BY ordinal')
const deleteTestsOf = db.prepare('DELETE FROM contest_tests WHERE problem_id = ?')
const insertTest = db.prepare(`
  INSERT INTO contest_tests (problem_id, ordinal, sample, test_group, input_bytes, answer_bytes, answer_from)
  VALUES (@problem_id, @ordinal, @sample, @test_group, @input_bytes, @answer_bytes, @answer_from)
`)
const moveTestsRevision = db.prepare(
  'UPDATE contest_problems SET tests_revision = ?, updated_at = ? WHERE id = ? AND tests_revision = ?',
)

export function listTests(problemId: string): ContestTest[] {
  return (selectTests.all(problemId) as TestRow[]).map(toTest)
}

export interface TestRowInput {
  ordinal: number
  sample: boolean
  group: number
  inputBytes: number
  answerBytes: number | null
  answerFrom: 'upload' | 'reference'
}

/**
 * Move a problem to a tests revision that is already whole on disk
 * (storage.ts · writeRevision), with the rows that describe it — in one
 * transaction, and only from the revision the caller started from. `false`:
 * someone else moved it meanwhile, nothing changed, and the caller's new
 * directory is garbage (its to drop). A revision is never moved back.
 */
export const switchTests = db.transaction(
  (problemId: string, from: number, to: number, tests: readonly TestRowInput[], at = Date.now()): boolean => {
    if (to <= from) throw new Error('A tests revision only moves forward')
    if (moveTestsRevision.run(to, at, problemId, from).changes === 0) return false
    deleteTestsOf.run(problemId)
    for (const test of tests) {
      insertTest.run({
        problem_id: problemId,
        ordinal: test.ordinal,
        sample: test.sample ? 1 : 0,
        test_group: test.group,
        input_bytes: test.inputBytes,
        answer_bytes: test.answerBytes,
        answer_from: test.answerFrom,
      })
    }
    const problem = getProblem(problemId)
    if (problem) noteContest(problem.contestId, 'revision')
    return true
  },
)

interface GroupRow {
  problem_id: string
  test_group: number
  points: number
}

const selectGroups = db.prepare('SELECT * FROM contest_groups WHERE problem_id = ? ORDER BY test_group')
const deleteGroupsOf = db.prepare('DELETE FROM contest_groups WHERE problem_id = ?')
const insertGroup = db.prepare('INSERT INTO contest_groups (problem_id, test_group, points) VALUES (?, ?, ?)')

export function listGroups(problemId: string): ContestGroup[] {
  return (selectGroups.all(problemId) as GroupRow[]).map((row) => ({ group: row.test_group, points: row.points }))
}

/** The IOI groups' table, replaced as a whole (the editor saves the table, not a row). */
export function replaceGroups(problemId: string, groups: readonly ContestGroup[]): void {
  db.transaction(() => {
    deleteGroupsOf.run(problemId)
    for (const group of groups) insertGroup.run(problemId, group.group, group.points)
  })()
  const problem = getProblem(problemId)
  if (problem) noteContest(problem.contestId, 'revision')
}

/* --------------------------------------------------------------- entrants */

const insertEnrollment = db.prepare(`
  INSERT INTO contest_entrants (contest_id, entrant_id, name_key, joined_at) VALUES (?, ?, ?, ?)
  ON CONFLICT(contest_id, entrant_id) DO UPDATE SET name_key = excluded.name_key
`)
const updateContestNameKeys = db.prepare('UPDATE contest_entrants SET name_key = ? WHERE entrant_id = ?')
const updateOneNameKey = db.prepare('UPDATE contest_entrants SET name_key = ? WHERE contest_id = ? AND entrant_id = ?')
const selectEnrollmentNames = db.prepare(`
  SELECT ce.entrant_id AS entrant_id, ce.name_key AS name_key, e.name AS name
  FROM contest_entrants ce JOIN entrants e ON e.id = ce.entrant_id
  WHERE ce.contest_id = ?
`)
const selectNameHolder = db.prepare('SELECT entrant_id FROM contest_entrants WHERE contest_id = ? AND name_key = ?')
const selectJoinedAt = db.prepare('SELECT joined_at FROM contest_entrants WHERE contest_id = ? AND entrant_id = ?')
const selectMyContests = db.prepare('SELECT contest_id FROM contest_entrants WHERE entrant_id = ?')
const countEntrants = db.prepare('SELECT COUNT(*) AS n FROM contest_entrants WHERE contest_id = ?')
const selectBoardEntrants = db.prepare(`
  SELECT ce.entrant_id AS id, e.name AS name, ce.joined_at AS joined_at
  FROM contest_entrants ce JOIN entrants e ON e.id = ce.entrant_id
  WHERE ce.contest_id = ?
  ORDER BY ce.joined_at, ce.entrant_id
`)

/**
 * Bring this contest's namesake keys up to the people's current names.
 *
 * A person has one name per instance, and the competitions rename them (a
 * teacher's rename, a join under a new name there) keeping only their own
 * table's keys: a key here can go stale. Read back before any namesake is
 * judged in this contest, so the rule holds against the names the board
 * shows. A fresh key that would clash with another row's — a namesake made
 * through a competition, which only an owner's rename can untangle — is left
 * as it was rather than refusing everybody's join.
 */
function refreshNameKeys(contestId: string): void {
  for (const row of selectEnrollmentNames.all(contestId) as { entrant_id: string; name_key: string; name: string }[]) {
    const key = entrantNameKey(row.name)
    if (key === row.name_key) continue
    try {
      updateOneNameKey.run(key, contestId, row.entrant_id)
    } catch (error) {
      if (!isUniqueViolation(error)) throw error
    }
  }
}

/** Thrown inside a join's transaction to roll back a rename the namesake rule refused. */
class NameTaken extends Error {}

/*
 * A signed-in person joins (or joins again under another name). The name is
 * the person's one name on the instance, so the join renames them
 * everywhere — through the competitions' own rename, which holds their
 * tables to the rule — and then every contest of theirs is held to it by the
 * same unique index. A clash anywhere rolls the whole join back.
 */
const writeJoin = db.transaction((contestId: string, entrantId: string, name: string, at: number): void => {
  refreshNameKeys(contestId)
  const renamed = renameEntrant(entrantId, name)
  if (renamed === 'taken') throw new NameTaken()
  if (renamed === 'missing') throw new Error('The entrant is gone')
  const key = entrantNameKey(clip(name, COMPETITION_LIMITS.entrantName))
  updateContestNameKeys.run(key, entrantId)
  insertEnrollment.run(contestId, entrantId, key, at)
})

/**
 * Join a contest under this name; `'taken'` — a namesake is already in it (or
 * in another of the person's contests or competitions, which the rename
 * reaches too). Caught OUTSIDE the transaction, as the competitions catch
 * theirs: a refusal caught inside would commit the half already written.
 */
export function joinContest(contestId: string, entrantId: string, name: string, at = Date.now()): 'ok' | 'taken' {
  try {
    writeJoin(contestId, entrantId, name, at)
  } catch (error) {
    if (error instanceof NameTaken || isUniqueViolation(error)) return 'taken'
    throw error
  }
  noteContest(contestId, 'submission', entrantId)
  return 'ok'
}

/*
 * A newcomer: a new identity with its key (the competitions' createEntrant)
 * and the enrollment, or nothing at all. The namesake is looked up before
 * anything is minted — a clash is most likely the same person on a new
 * device, and an identity minted anyway is a second key nobody can remove.
 */
const writeNewcomer = db.transaction((contestId: string, name: string, at: number): MintedEntrant => {
  refreshNameKeys(contestId)
  const key = entrantNameKey(clip(name, COMPETITION_LIMITS.entrantName))
  if (selectNameHolder.get(contestId, key)) throw new NameTaken()
  const minted = createEntrant(name)
  insertEnrollment.run(contestId, minted.entrant.id, key, at)
  return minted
})

export function joinContestAsNewcomer(contestId: string, name: string, at = Date.now()): MintedEntrant | 'taken' {
  let minted: MintedEntrant
  try {
    minted = writeNewcomer(contestId, name, at)
  } catch (error) {
    if (error instanceof NameTaken || isUniqueViolation(error)) return 'taken'
    throw error
  }
  noteContest(contestId, 'submission', minted.entrant.id)
  return minted
}

/** When the person joined this contest; null — not joined. */
export function contestJoinedAt(contestId: string, entrantId: string): number | null {
  const row = selectJoinedAt.get(contestId, entrantId) as { joined_at: number } | undefined
  return row ? row.joined_at : null
}

export function myContestIds(entrantId: string): Set<string> {
  return new Set((selectMyContests.all(entrantId) as { contest_id: string }[]).map((row) => row.contest_id))
}

export function contestEntrantCount(contestId: string): number {
  return (countEntrants.get(contestId) as { n: number }).n
}

/** The people of a contest with their current names, in the order they joined: the board's rows. */
export function contestEntrants(contestId: string): { id: string; name: string; joinedAt: number }[] {
  return (selectBoardEntrants.all(contestId) as { id: string; name: string; joined_at: number }[]).map((row) => ({
    id: row.id,
    name: row.name,
    joinedAt: row.joined_at,
  }))
}

/*
 * Whether anything on the instance still holds a person: the competitions'
 * three (an enrollment, a submission, a competition's baseline notebook) and
 * the contests' two. The same question competitions/store.ts asks before it
 * deletes a person (selectAnywhere), asked from this side.
 */
const selectStillHeld = db.prepare(`
  SELECT 1 FROM competition_entrants WHERE entrant_id = @e
  UNION ALL SELECT 1 FROM submissions WHERE entrant_id = @e
  UNION ALL SELECT 1 FROM competitions WHERE baseline_entrant_id = @e
  UNION ALL SELECT 1 FROM contest_entrants WHERE entrant_id = @e
  UNION ALL SELECT 1 FROM contest_submissions WHERE entrant_id = @e
  LIMIT 1
`)
const deleteEntrantIdentity = db.prepare('DELETE FROM entrants WHERE id = ?')

export interface ContestEntrantRemoval {
  /** The removed submissions with their attempts: what is left of their runs on disk is the caller's. */
  submissions: { id: string; attempt: number }[]
  /** The identity and its key went too: nothing else on the instance held the person. */
  identityRemoved: boolean
}

/**
 * Remove one person from one contest: their submissions, their questions,
 * their read mark, their enrollment — and the person themselves with their
 * key when nothing else on the instance holds them. `'running'` — a judging
 * of theirs is in a container right now, and nothing was touched.
 *
 * A question of theirs the teacher answered to everyone stays as an
 * announcement, its asker and its wording gone: the class read the answer,
 * and the answer is the teacher's words, not the person's.
 */
export function removeContestEntrantRows(contestId: string, entrantId: string): ContestEntrantRemoval | 'running' {
  const outcome = db.transaction((): ContestEntrantRemoval | 'running' => {
    if (db.prepare("SELECT 1 FROM contest_submissions WHERE contest_id = ? AND entrant_id = ? AND state = 'running' LIMIT 1").get(contestId, entrantId)) {
      return 'running'
    }
    const submissions = db
      .prepare('SELECT id, attempt FROM contest_submissions WHERE contest_id = ? AND entrant_id = ?')
      .all(contestId, entrantId) as { id: string; attempt: number }[]
    db.prepare('DELETE FROM contest_submissions WHERE contest_id = ? AND entrant_id = ?').run(contestId, entrantId)
    db.prepare(`UPDATE contest_questions SET entrant_id = NULL, question = ''
      WHERE contest_id = ? AND entrant_id = ? AND public = 1 AND answer IS NOT NULL`).run(contestId, entrantId)
    db.prepare('DELETE FROM contest_questions WHERE contest_id = ? AND entrant_id = ?').run(contestId, entrantId)
    db.prepare('DELETE FROM contest_seen WHERE contest_id = ? AND entrant_id = ?').run(contestId, entrantId)
    db.prepare('DELETE FROM contest_entrants WHERE contest_id = ? AND entrant_id = ?').run(contestId, entrantId)
    const identityRemoved = selectStillHeld.get({ e: entrantId }) === undefined && deleteEntrantIdentity.run(entrantId).changes > 0
    return { submissions, identityRemoved }
  })()
  if (outcome !== 'running') {
    noteContest(contestId, 'submission', entrantId)
    noteContest(contestId, 'questions')
  }
  return outcome
}

/* ------------------------------------------------------------ submissions */

/** One test as the report keeps it: everything the judge said, and its group. */
export interface StoredTestReport extends TestReport {
  group: number
}

/**
 * A judging's report, as stored: every test, and for the teacher's reference
 * check the stamp of what it was checked against (referenceStamp), so a
 * changed limit or checker reads as «not checked» rather than as a pass.
 */
export interface StoredReport {
  tests: StoredTestReport[]
  stamp?: string
}

/** A submission with everything the panel may read; the doors cut it down for whoever asks. */
export interface StoredSubmission extends ContestSubmission {
  source: string
  compileLog: string
  report: StoredReport | null
  systemDetail: string | null
  attempt: number
  starts: number
  boot: string | null
  startedAt: number | null
}

interface SubmissionRow {
  id: string
  contest_id: string
  problem_id: string
  entrant_id: string | null
  kind: string
  number: number
  language: string
  source: string
  source_bytes: number
  submitted_at: number
  late: number
  state: string
  verdict: string | null
  failed_test: number | null
  passed: number | null
  total: number | null
  score: number | null
  time_ms: number | null
  memory_kb: number | null
  progress: number | null
  compile_log: string
  report: string | null
  system_detail: string | null
  tests_revision: number | null
  judged_at: number | null
  attempt: number
  starts: number
  boot: string | null
  started_at: number | null
}

function parseReport(raw: string | null): StoredReport | null {
  if (!raw) return null
  try {
    const parsed = JSON.parse(raw) as StoredReport
    return parsed && Array.isArray(parsed.tests) ? parsed : null
  } catch {
    return null
  }
}

function toSubmission(row: SubmissionRow): StoredSubmission {
  return {
    id: row.id,
    contestId: row.contest_id,
    problemId: row.problem_id,
    entrantId: row.entrant_id,
    kind: (row.kind === 'reference' || row.kind === 'answers' ? row.kind : 'entrant') as SubmissionKind,
    number: row.number,
    language: (CONTEST_LANGUAGES.includes(row.language as ContestLanguage) ? row.language : 'python3') as ContestLanguage,
    sourceBytes: row.source_bytes,
    submittedAt: row.submitted_at,
    late: row.late === 1,
    state: row.state as JudgeState,
    verdict: row.verdict as Verdict | null,
    failedTest: row.failed_test,
    passed: row.passed,
    total: row.total,
    score: row.score,
    timeMs: row.time_ms,
    memoryKb: row.memory_kb,
    progress: row.progress,
    judgedAt: row.judged_at,
    testsRevision: row.tests_revision,
    source: row.source,
    compileLog: row.compile_log,
    report: parseReport(row.report),
    systemDetail: row.system_detail,
    attempt: row.attempt,
    starts: row.starts,
    boot: row.boot,
    startedAt: row.started_at,
  }
}

const selectSubmission = db.prepare('SELECT * FROM contest_submissions WHERE id = ?')
const selectEntrantSubmissions = db.prepare(`
  SELECT * FROM contest_submissions
  WHERE contest_id = ? AND entrant_id = ? AND kind = 'entrant'
  ORDER BY submitted_at DESC, number DESC
`)
const selectEntrantProblemSubmissions = db.prepare(`
  SELECT * FROM contest_submissions
  WHERE contest_id = ? AND problem_id = ? AND entrant_id = ? AND kind = 'entrant'
  ORDER BY submitted_at, number
`)
const countPending = db.prepare(`
  SELECT COUNT(*) AS n FROM contest_submissions
  WHERE contest_id = ? AND entrant_id = ? AND kind = 'entrant' AND state IN ('queued', 'running')
`)
const selectNextNumber = db.prepare(
  "SELECT COALESCE(MAX(number), 0) + 1 AS n FROM contest_submissions WHERE contest_id = ? AND kind = 'entrant'",
)
const insertSubmission = db.prepare(`
  INSERT INTO contest_submissions
    (id, contest_id, problem_id, entrant_id, kind, number, language, source, source_bytes, submitted_at, late, state)
  VALUES
    (@id, @contest_id, @problem_id, @entrant_id, @kind, @number, @language, @source, @source_bytes, @at, @late, 'queued')
`)

export function getSubmission(id: string): StoredSubmission | null {
  const row = selectSubmission.get(id) as SubmissionRow | undefined
  return row ? toSubmission(row) : null
}

/** A person's submissions in a contest, newest first: «Мои посылки». */
export function listEntrantSubmissions(contestId: string, entrantId: string): StoredSubmission[] {
  return (selectEntrantSubmissions.all(contestId, entrantId) as SubmissionRow[]).map(toSubmission)
}

/** A person's submissions of one problem, oldest first: what the rail and the attempts limit read. */
export function listEntrantProblemSubmissions(contestId: string, problemId: string, entrantId: string): StoredSubmission[] {
  return (selectEntrantProblemSubmissions.all(contestId, problemId, entrantId) as SubmissionRow[]).map(toSubmission)
}

/** How many of this person's submissions in this contest wait or run. */
export function pendingCount(contestId: string, entrantId: string): number {
  return (countPending.get(contestId, entrantId) as { n: number }).n
}

/**
 * What a person has spent of a problem's attempts: their on-time
 * submissions, by the shared rule (@shared/contests · spendsLimit) — a
 * compilation error and the judge's own failure are free, a submission still
 * being judged is not. Upsolving is outside the limit, as it is outside the
 * board.
 */
export function attemptsUsed(contestId: string, problemId: string, entrantId: string): number {
  return listEntrantProblemSubmissions(contestId, problemId, entrantId).filter(
    (submission) => !submission.late && spendsLimit(submission.verdict, submission.state),
  ).length
}

export interface NewEntrantSubmission {
  contestId: string
  problemId: string
  entrantId: string
  language: ContestLanguage
  source: string
  late: boolean
  /** The contest's per-problem limit, 0 — none. */
  attemptsPerProblem: number
}

/**
 * Accept a participant's submission, or refuse it by the two rules that count
 * rows: two still being judged (`in_flight`), the problem's attempts spent
 * (`attempts`). In one transaction with the number it takes, so the door's
 * looks and the insert cannot be told apart by a second request.
 */
export const submitSolution = db.transaction(
  (input: NewEntrantSubmission, at = Date.now()): { submission: StoredSubmission } | { refusal: 'in_flight' | 'attempts' } => {
    if (pendingCount(input.contestId, input.entrantId) >= MAX_PENDING) return { refusal: 'in_flight' }
    if (input.attemptsPerProblem > 0 && !input.late
      && attemptsUsed(input.contestId, input.problemId, input.entrantId) >= input.attemptsPerProblem) {
      return { refusal: 'attempts' }
    }
    const number = (selectNextNumber.get(input.contestId) as { n: number }).n
    let id = newId(10)
    while (selectSubmission.get(id)) id = newId(10)
    insertSubmission.run({
      id,
      contest_id: input.contestId,
      problem_id: input.problemId,
      entrant_id: input.entrantId,
      kind: 'entrant',
      number,
      language: input.language,
      source: input.source,
      source_bytes: Buffer.byteLength(input.source, 'utf8'),
      at,
      late: input.late ? 1 : 0,
    })
    noteContest(input.contestId, 'submission', input.entrantId)
    return { submission: getSubmission(id)! }
  },
)

const selectQueuedTeacherRun = db.prepare(`
  SELECT * FROM contest_submissions WHERE problem_id = ? AND kind = ? AND state = 'queued'
  ORDER BY submitted_at DESC LIMIT 1
`)
const updateQueuedSource = db.prepare(`
  UPDATE contest_submissions SET language = ?, source = ?, source_bytes = ?, submitted_at = ?
  WHERE id = ? AND state = 'queued'
`)

/**
 * Queue the teacher's own run of a problem's reference: a check (`reference`)
 * or writing the answers (`answers`). One waiting run of each kind per
 * problem: a second press while the first still waits gives the waiting one
 * the latest source instead of a second run to wait behind.
 */
export function enqueueTeacherRun(problem: ContestProblem, kind: 'reference' | 'answers', at = Date.now()): StoredSubmission {
  const made = db.transaction((): StoredSubmission => {
    const waiting = selectQueuedTeacherRun.get(problem.id, kind) as SubmissionRow | undefined
    const bytes = Buffer.byteLength(problem.referenceSource, 'utf8')
    if (waiting) {
      updateQueuedSource.run(problem.referenceLanguage, problem.referenceSource, bytes, at, waiting.id)
      return getSubmission(waiting.id)!
    }
    let id = newId(10)
    while (selectSubmission.get(id)) id = newId(10)
    insertSubmission.run({
      id,
      contest_id: problem.contestId,
      problem_id: problem.id,
      entrant_id: null,
      kind,
      number: 0,
      language: problem.referenceLanguage,
      source: problem.referenceSource,
      source_bytes: bytes,
      at,
      late: 0,
    })
    return getSubmission(id)!
  })()
  noteContest(problem.contestId, 'submission', null)
  return made
}

const selectLatestTeacherRun = db.prepare(`
  SELECT * FROM contest_submissions WHERE problem_id = ? AND kind = ?
  ORDER BY submitted_at DESC, id DESC LIMIT 1
`)
const selectTeacherRunPending = db.prepare(`
  SELECT 1 FROM contest_submissions WHERE problem_id = ? AND kind = ? AND state IN ('queued', 'running') LIMIT 1
`)

/** The latest run of this kind of the teacher's for a problem. */
export function latestTeacherRun(problemId: string, kind: 'reference' | 'answers'): StoredSubmission | null {
  const row = selectLatestTeacherRun.get(problemId, kind) as SubmissionRow | undefined
  return row ? toSubmission(row) : null
}

export function teacherRunPending(problemId: string, kind: 'reference' | 'answers'): boolean {
  return selectTeacherRunPending.get(problemId, kind) !== undefined
}

/**
 * What a reference check was checked against, as one string: the source and
 * its language, and everything of the problem that changes a verdict without
 * changing the tests — the limits and the checker. The tests have their
 * revision, compared on its own.
 */
export function referenceStamp(problem: Pick<ContestProblem, 'referenceLanguage' | 'referenceSource' | 'timeLimitMs' | 'memoryMb' | 'checker' | 'checkerEpsilon' | 'checkerCode'>): string {
  return createHash('sha256')
    .update(JSON.stringify([
      problem.referenceLanguage,
      problem.referenceSource,
      problem.timeLimitMs,
      problem.memoryMb,
      problem.checker,
      problem.checker === 'float' ? problem.checkerEpsilon : null,
      problem.checker === 'custom' ? problem.checkerCode : null,
    ]))
    .digest('hex')
    .slice(0, 24)
}

/** The board's attempts: entrants' on-time submissions of a contest (upsolving and the teacher's runs never count). */
export function standingAttempts(contestId: string): StandingAttempt[] {
  const rows = db
    .prepare(`SELECT entrant_id, problem_id, submitted_at, state, verdict, score FROM contest_submissions
              WHERE contest_id = ? AND kind = 'entrant' AND late = 0 AND entrant_id IS NOT NULL`)
    .all(contestId) as { entrant_id: string; problem_id: string; submitted_at: number; state: string; verdict: string | null; score: number | null }[]
  return rows.map((row) => ({
    entrantId: row.entrant_id,
    problemId: row.problem_id,
    submittedAt: row.submitted_at,
    state: row.state as JudgeState,
    verdict: row.verdict as Verdict | null,
    score: row.score,
  }))
}

export interface SubmissionFilter {
  kind?: SubmissionKind | 'all'
  problemId?: string
  /** A verdict, or `pending` — waiting or being judged. */
  verdict?: Verdict | 'pending'
  entrantId?: string
  /** `#12` / `12` — the number; anything else — part of the entrant's name. */
  q?: string
  limit: number
  offset: number
}

/** The console's feed: newest first, filtered, one page of it and the count of all that match. */
export function listContestSubmissions(contestId: string, filter: SubmissionFilter): { rows: StoredSubmission[]; total: number } {
  const where = ['contest_id = @contest']
  const params: Record<string, unknown> = { contest: contestId, limit: filter.limit, offset: filter.offset }
  const kind = filter.kind ?? 'entrant'
  if (kind !== 'all') {
    where.push('kind = @kind')
    params.kind = kind
  }
  if (filter.problemId) {
    where.push('problem_id = @problem')
    params.problem = filter.problemId
  }
  if (filter.verdict === 'pending') where.push("state IN ('queued', 'running')")
  else if (filter.verdict) {
    where.push('verdict = @verdict')
    params.verdict = filter.verdict
  }
  if (filter.entrantId) {
    where.push('entrant_id = @entrant')
    params.entrant = filter.entrantId
  }
  const q = (filter.q ?? '').trim()
  if (q) {
    const number = /^#?(\d{1,9})$/.exec(q)
    if (number) {
      where.push('number = @number')
      params.number = Number(number[1])
    } else {
      where.push('entrant_id IN (SELECT id FROM entrants WHERE instr(lower(name), lower(@q)) > 0)')
      params.q = q
    }
  }
  const clause = where.join(' AND ')
  const rows = db
    .prepare(`SELECT * FROM contest_submissions WHERE ${clause} ORDER BY submitted_at DESC, number DESC, id LIMIT @limit OFFSET @offset`)
    .all(params) as SubmissionRow[]
  const { limit: _l, offset: _o, ...countParams } = params
  const total = (db.prepare(`SELECT COUNT(*) AS n FROM contest_submissions WHERE ${clause}`).get(countParams) as { n: number }).n
  return { rows: rows.map(toSubmission), total }
}

/** Per person: how many submissions, and the last one's moment — the «Участники» tab. */
export function entrantSubmissionStats(contestId: string): Map<string, { count: number; last: number | null }> {
  const rows = db
    .prepare(`SELECT entrant_id, COUNT(*) AS n, MAX(submitted_at) AS last FROM contest_submissions
              WHERE contest_id = ? AND kind = 'entrant' AND entrant_id IS NOT NULL GROUP BY entrant_id`)
    .all(contestId) as { entrant_id: string; n: number; last: number | null }[]
  return new Map(rows.map((row) => [row.entrant_id, { count: row.n, last: row.last }]))
}

/** A contest's sizes for its list row. */
export function contestCounts(contestId: string): { problems: number; entrants: number; submissions: number } {
  return {
    problems: (countProblems.get(contestId) as { n: number }).n,
    entrants: contestEntrantCount(contestId),
    submissions: (db.prepare("SELECT COUNT(*) AS n FROM contest_submissions WHERE contest_id = ? AND kind = 'entrant'").get(contestId) as { n: number }).n,
  }
}

/* ------------------------------------------------------------------ queue */

/*
 * The order the judge takes work in: the teacher's runs (a reference check,
 * the answers) first — they are what opens a contest, and there are few —
 * then the participants' by when they were sent, and never a second
 * judging of a person who has one running: with eight slots and one student
 * pressing «Отправить» five times, the class must not wait behind them.
 */
const selectNextQueued = db.prepare(`
  SELECT s.* FROM contest_submissions s
  WHERE s.state = 'queued'
    AND (s.entrant_id IS NULL OR NOT EXISTS (
      SELECT 1 FROM contest_submissions r WHERE r.entrant_id = s.entrant_id AND r.state = 'running'))
  ORDER BY CASE s.kind WHEN 'entrant' THEN 1 ELSE 0 END, s.submitted_at, s.id
  LIMIT 1
`)
const selectRunningOfEntrant = db.prepare(
  "SELECT 1 FROM contest_submissions WHERE entrant_id = ? AND state = 'running' LIMIT 1",
)
const markRunning = db.prepare(`
  UPDATE contest_submissions
  SET state = 'running', attempt = attempt + 1, starts = starts + 1, boot = @boot, started_at = @at,
      tests_revision = @revision, progress = NULL
  WHERE id = @id AND state = 'queued'
`)

/**
 * The submission the judge would take next, or null. `skip` — rows the pump
 * passes over this time (held back while their contest, problem or person is
 * being removed): the next in the same order instead.
 */
export function nextQueued(skip: readonly string[] = []): StoredSubmission | null {
  const row = (skip.length === 0
    ? selectNextQueued.get()
    : db.prepare(`
        SELECT s.* FROM contest_submissions s
        WHERE s.state = 'queued' AND s.id NOT IN (${skip.map(() => '?').join(', ')})
          AND (s.entrant_id IS NULL OR NOT EXISTS (
            SELECT 1 FROM contest_submissions r WHERE r.entrant_id = s.entrant_id AND r.state = 'running'))
        ORDER BY CASE s.kind WHEN 'entrant' THEN 1 ELSE 0 END, s.submitted_at, s.id
        LIMIT 1
      `).get(...skip)) as SubmissionRow | undefined
  return row ? toSubmission(row) : null
}

export interface StartedJudging {
  submission: StoredSubmission
  problem: ContestProblem
  /** The tests of the revision the judging is pinned to, read in the same transaction as the pin. */
  tests: ContestTest[]
  groups: ContestGroup[]
}

/**
 * Take a waiting submission into the judge: mark it running under this
 * process life, count the start, and pin it to the problem's current tests
 * revision — together, so the revision it reads is the one the rows were read
 * at, and the pruning of old revisions (which keeps every revision a running
 * row names) cannot take it from under the run. `null` — it is no longer
 * waiting, or its person has another one running.
 */
export const startJudging = db.transaction((id: string, boot: string = BOOT, at: number = Date.now()): StartedJudging | null => {
  const row = selectSubmission.get(id) as SubmissionRow | undefined
  if (!row || row.state !== 'queued') return null
  if (row.entrant_id !== null && selectRunningOfEntrant.get(row.entrant_id)) return null
  const problem = getProblem(row.problem_id)
  if (!problem) return null
  if (markRunning.run({ id, boot, at, revision: problem.testsRevision }).changes === 0) return null
  noteContest(row.contest_id, 'submission', row.entrant_id)
  return { submission: getSubmission(id)!, problem, tests: listTests(problem.id), groups: listGroups(problem.id) }
})

const updateProgress = db.prepare(`
  UPDATE contest_submissions SET progress = ? WHERE id = ? AND state = 'running' AND attempt = ?
`)

/** A running judging finished `progress` tests. The pump calls it at most once a second per run. */
export function noteProgress(id: string, attempt: number, progress: number): boolean {
  const row = selectSubmission.get(id) as SubmissionRow | undefined
  if (!row) return false
  const done = updateProgress.run(progress, id, attempt).changes > 0
  if (done) noteContest(row.contest_id, 'progress', row.entrant_id)
  return done
}

export interface JudgingResult {
  state: 'done' | 'failed'
  verdict: Verdict
  failedTest: number | null
  passed: number
  total: number
  score: number | null
  timeMs: number | null
  memoryKb: number | null
  compileLog: string
  report: StoredReport
  systemDetail: string | null
  judgedAt: number
}

/** Whether a row is still the judging that was started: running, under this attempt and this process life. */
export function stillJudging(id: string, attempt: number, boot: string = BOOT): boolean {
  const row = selectSubmission.get(id) as SubmissionRow | undefined
  return row !== undefined && row.state === 'running' && row.attempt === attempt && row.boot === boot
}

const writeResult = db.prepare(`
  UPDATE contest_submissions
  SET state = @state, verdict = @verdict, failed_test = @failed_test, passed = @passed, total = @total,
      score = @score, time_ms = @time_ms, memory_kb = @memory_kb, progress = NULL, compile_log = @compile_log,
      report = @report, system_detail = @system_detail, judged_at = @judged_at
  WHERE id = @id AND state = 'running' AND attempt = @attempt AND boot = @boot
`)

/**
 * Write a judging's outcome — only into the run that produced it: the same
 * row, still running, under the same attempt and the same process life. A
 * row removed meanwhile (the person was deleted, the problem too), or
 * requeued by a shutdown, takes nothing: `false`.
 */
export function finishJudging(id: string, attempt: number, result: JudgingResult, boot: string = BOOT): boolean {
  const row = selectSubmission.get(id) as SubmissionRow | undefined
  if (!row) return false
  const done = writeResult.run({
    id,
    attempt,
    boot,
    state: result.state,
    verdict: result.verdict,
    failed_test: result.failedTest,
    passed: result.passed,
    total: result.total,
    score: result.score,
    time_ms: result.timeMs,
    memory_kb: result.memoryKb,
    compile_log: result.compileLog,
    report: JSON.stringify(result.report),
    system_detail: result.systemDetail,
    judged_at: result.judgedAt,
  }).changes > 0
  if (done) noteContest(row.contest_id, 'submission', row.entrant_id)
  return done
}

const selectOrphans = db.prepare(
  "SELECT * FROM contest_submissions WHERE state = 'running' AND (boot IS NULL OR boot != ?)",
)
const markOrphanQueued = db.prepare(`
  UPDATE contest_submissions SET state = 'queued', boot = NULL, started_at = NULL, progress = NULL
  WHERE id = ? AND state = 'running'
`)
const markOrphanFailed = db.prepare(`
  UPDATE contest_submissions
  SET state = 'failed', verdict = 'SE', progress = NULL, system_detail = ?, judged_at = ?, boot = NULL
  WHERE id = ? AND state = 'running'
`)

/**
 * Pick up the previous life's judgings, once at startup: a row running under
 * another `boot` lost its process, and its container is gone or about to be
 * (the judge's sweep). Back to the queue — or, after MAX_STARTS starts cut
 * short, ended as the judge's failure (SE): the culprit is named correctly,
 * it costs the person no attempt, and the panel offers a rejudge. Returns the
 * rows as they were, so the caller can clear their run directories.
 */
export const requeueOrphans = db.transaction((boot: string = BOOT, at: number = Date.now()): { requeued: StoredSubmission[]; failed: StoredSubmission[] } => {
  const requeued: StoredSubmission[] = []
  const failed: StoredSubmission[] = []
  for (const row of (selectOrphans.all(boot) as SubmissionRow[]).map(toSubmission)) {
    if (row.starts >= MAX_STARTS) {
      markOrphanFailed.run(tr('contests.judge.restartAbandoned', { count: row.starts }), at, row.id)
      failed.push(row)
    } else {
      markOrphanQueued.run(row.id)
      requeued.push(row)
    }
    noteContest(row.contestId, 'submission', row.entrantId)
  }
  return { requeued, failed }
})

const markStoppedQueued = db.prepare(`
  UPDATE contest_submissions SET state = 'queued', starts = MAX(0, starts - 1), boot = NULL, started_at = NULL, progress = NULL
  WHERE id = ? AND state = 'running' AND attempt = ? AND boot = ?
`)

/**
 * A judging this process stops on purpose (a shutdown): back to the queue,
 * its start not counted — a deliberate stop is no failure of the submission's.
 */
export function requeueStopped(id: string, attempt: number, boot: string = BOOT): boolean {
  const row = selectSubmission.get(id) as SubmissionRow | undefined
  if (!row) return false
  const done = markStoppedQueued.run(id, attempt, boot).changes > 0
  if (done) noteContest(row.contest_id, 'submission', row.entrant_id)
  return done
}

const markRejudged = db.prepare(`
  UPDATE contest_submissions
  SET state = 'queued', verdict = NULL, failed_test = NULL, passed = NULL, total = NULL, score = NULL,
      time_ms = NULL, memory_kb = NULL, progress = NULL, compile_log = '', report = NULL, system_detail = NULL,
      tests_revision = NULL, judged_at = NULL, starts = 0, boot = NULL, started_at = NULL
  WHERE id = ? AND state IN ('done', 'failed')
`)

/**
 * Judge a submission again: its verdict is forgotten and it waits again, in
 * the place its sending time gives it. `'running'` — it is being judged now;
 * `'queued'` — it already waits (nothing to do); null — no such submission.
 */
export function rejudgeSubmission(id: string): 'requeued' | 'queued' | 'running' | null {
  const row = selectSubmission.get(id) as SubmissionRow | undefined
  if (!row) return null
  if (row.state === 'running') return 'running'
  if (row.state === 'queued') return 'queued'
  if (markRejudged.run(id).changes === 0) return null
  noteContest(row.contest_id, 'submission', row.entrant_id)
  return 'requeued'
}

/**
 * Judge again every participant's judged submission of the given problems
 * (`onlyStale` — only those judged on another tests revision than the
 * current one). Running and waiting ones are left as they are. Returns how
 * many went back to the queue.
 */
export function rejudgeProblems(problems: readonly ContestProblem[], onlyStale: boolean): number {
  let count = 0
  const touched = new Set<string>()
  db.transaction(() => {
    for (const problem of problems) {
      const rows = db
        .prepare(`SELECT id, entrant_id, contest_id, tests_revision FROM contest_submissions
                  WHERE problem_id = ? AND kind = 'entrant' AND state IN ('done', 'failed')`)
        .all(problem.id) as { id: string; entrant_id: string | null; contest_id: string; tests_revision: number | null }[]
      for (const row of rows) {
        if (onlyStale && row.tests_revision === problem.testsRevision) continue
        if (markRejudged.run(row.id).changes > 0) {
          count++
          touched.add(row.contest_id)
        }
      }
    }
  })()
  for (const contestId of touched) noteContest(contestId, 'submission')
  return count
}

/**
 * IOI points given again from the stored per-test verdicts, after the
 * groups' table changed: the tests did not change, so no program needs to run
 * again — only the arithmetic. Only the submissions judged on the current
 * revision: an older one's ordinals may mean other tests (it is stale, and a
 * rejudge is what it needs). Returns how many scores changed.
 */
export function rescoreProblem(problem: ContestProblem, score: (report: StoredReport) => number): number {
  let changed = 0
  db.transaction(() => {
    const rows = db
      .prepare(`SELECT id, report, score FROM contest_submissions
                WHERE problem_id = ? AND state = 'done' AND tests_revision = ? AND verdict != 'CE'`)
      .all(problem.id, problem.testsRevision) as { id: string; report: string | null; score: number | null }[]
    const write = db.prepare('UPDATE contest_submissions SET score = ? WHERE id = ?')
    for (const row of rows) {
      const report = parseReport(row.report)
      if (!report) continue
      const fresh = score(report)
      if (fresh !== row.score) {
        write.run(fresh, row.id)
        changed++
      }
    }
  })()
  if (changed > 0) noteContest(problem.contestId, 'submission')
  return changed
}

/**
 * The tests revisions of a problem something still reads: the current one,
 * and every one a waiting or running judging is pinned to. What the pruning
 * of old directories must keep (storage.ts · pruneRevisions).
 */
export function revisionsInUse(problemId: string): Set<number> {
  const problem = getProblem(problemId)
  const keep = new Set<number>(problem ? [problem.testsRevision] : [])
  const rows = db
    .prepare(`SELECT DISTINCT tests_revision FROM contest_submissions
              WHERE problem_id = ? AND state IN ('queued', 'running') AND tests_revision IS NOT NULL`)
    .all(problemId) as { tests_revision: number }[]
  for (const row of rows) keep.add(row.tests_revision)
  return keep
}

/** Running and waiting judgings on the whole instance: the judge's strip. */
export function queueCounts(): { running: number; queued: number } {
  const rows = db
    .prepare("SELECT state, COUNT(*) AS n FROM contest_submissions WHERE state IN ('queued', 'running') GROUP BY state")
    .all() as { state: string; n: number }[]
  return {
    running: rows.find((row) => row.state === 'running')?.n ?? 0,
    queued: rows.find((row) => row.state === 'queued')?.n ?? 0,
  }
}

/** One contest's submissions waiting and being judged: the console's «В ОЧЕРЕДИ». */
export function contestQueueCounts(contestId: string): { running: number; queued: number } {
  const rows = db
    .prepare("SELECT state, COUNT(*) AS n FROM contest_submissions WHERE contest_id = ? AND state IN ('queued', 'running') GROUP BY state")
    .all(contestId) as { state: string; n: number }[]
  return {
    running: rows.find((row) => row.state === 'running')?.n ?? 0,
    queued: rows.find((row) => row.state === 'queued')?.n ?? 0,
  }
}

/** Judgings finished since a moment (the start of the instance's day). */
export function judgedSince(at: number): number {
  return (db.prepare('SELECT COUNT(*) AS n FROM contest_submissions WHERE judged_at >= ?').get(at) as { n: number }).n
}

/** How long the latest judgings took, start to verdict, newest first. */
export function recentJudgingDurations(limit = 50): number[] {
  return (
    db
      .prepare(`SELECT judged_at - started_at AS ms FROM contest_submissions
                WHERE judged_at IS NOT NULL AND started_at IS NOT NULL ORDER BY judged_at DESC LIMIT ?`)
      .all(limit) as { ms: number }[]
  ).map((row) => Math.max(0, row.ms))
}

/** Whether a contest has a participant's submission at all: the rules cannot change under one. */
export function hasEntrantSubmissions(contestId: string): boolean {
  return db.prepare("SELECT 1 FROM contest_submissions WHERE contest_id = ? AND kind = 'entrant' LIMIT 1").get(contestId) !== undefined
}

/* -------------------------------------------------------------- questions */

export interface StoredQuestion {
  id: string
  contestId: string
  problemId: string | null
  entrantId: string | null
  question: string
  answer: string | null
  answeredBy: string | null
  public: boolean
  askedAt: number
  answeredAt: number | null
}

interface QuestionRow {
  id: string
  contest_id: string
  problem_id: string | null
  entrant_id: string | null
  question: string
  answer: string | null
  answered_by: string | null
  public: number
  asked_at: number
  answered_at: number | null
}

function toQuestion(row: QuestionRow): StoredQuestion {
  return {
    id: row.id,
    contestId: row.contest_id,
    problemId: row.problem_id,
    entrantId: row.entrant_id,
    question: row.question,
    answer: row.answer,
    answeredBy: row.answered_by,
    public: row.public === 1,
    askedAt: row.asked_at,
    answeredAt: row.answered_at,
  }
}

const selectQuestion = db.prepare('SELECT * FROM contest_questions WHERE id = ?')
const selectQuestions = db.prepare('SELECT * FROM contest_questions WHERE contest_id = ? ORDER BY asked_at DESC, id')
const insertQuestion = db.prepare(`
  INSERT INTO contest_questions (id, contest_id, problem_id, entrant_id, question, answer, answered_by, public, asked_at, answered_at)
  VALUES (@id, @contest_id, @problem_id, @entrant_id, @question, @answer, @answered_by, @public, @asked_at, @answered_at)
`)

function freshQuestionId(): string {
  let id = newId(10)
  while (selectQuestion.get(id)) id = newId(10)
  return id
}

export function getQuestion(id: string): StoredQuestion | null {
  const row = selectQuestion.get(id) as QuestionRow | undefined
  return row ? toQuestion(row) : null
}

/** Every question and announcement of a contest, newest first. */
export function listQuestions(contestId: string): StoredQuestion[] {
  return (selectQuestions.all(contestId) as QuestionRow[]).map(toQuestion)
}

export function askQuestion(contestId: string, entrantId: string, problemId: string | null, question: string, at = Date.now()): StoredQuestion {
  const id = freshQuestionId()
  insertQuestion.run({
    id,
    contest_id: contestId,
    problem_id: problemId,
    entrant_id: entrantId,
    question: clip(question, CONTEST_LIMITS.question),
    answer: null,
    answered_by: null,
    public: 0,
    asked_at: at,
    answered_at: null,
  })
  noteContest(contestId, 'questions')
  return getQuestion(id)!
}

/** Answer (or answer again): to the asker, or — `isPublic` — to everyone, which makes it an announcement. */
export function answerQuestion(id: string, answer: string, isPublic: boolean, by: string | null, at = Date.now()): StoredQuestion | null {
  const question = getQuestion(id)
  if (!question) return null
  db.prepare('UPDATE contest_questions SET answer = ?, public = ?, answered_by = ?, answered_at = ? WHERE id = ?')
    .run(clip(answer, CONTEST_LIMITS.answer), isPublic ? 1 : 0, by, at, id)
  noteContest(question.contestId, 'questions')
  return getQuestion(id)
}

/** An announcement: no question, no asker, public from birth. */
export function announce(contestId: string, problemId: string | null, text: string, by: string | null, at = Date.now()): StoredQuestion {
  const id = freshQuestionId()
  insertQuestion.run({
    id,
    contest_id: contestId,
    problem_id: problemId,
    entrant_id: null,
    question: '',
    answer: clip(text, CONTEST_LIMITS.answer),
    answered_by: by,
    public: 1,
    asked_at: at,
    answered_at: at,
  })
  noteContest(contestId, 'questions')
  return getQuestion(id)!
}

export function deleteQuestion(id: string): boolean {
  const question = getQuestion(id)
  if (!question) return false
  db.prepare('DELETE FROM contest_questions WHERE id = ?').run(id)
  noteContest(question.contestId, 'questions')
  return true
}

export function questionsSeenAt(contestId: string, entrantId: string): number | null {
  const row = db.prepare('SELECT questions_seen_at FROM contest_seen WHERE contest_id = ? AND entrant_id = ?').get(contestId, entrantId) as
    | { questions_seen_at: number }
    | undefined
  return row ? row.questions_seen_at : null
}

export function markQuestionsSeen(contestId: string, entrantId: string, at = Date.now()): void {
  db.prepare(`INSERT INTO contest_seen (contest_id, entrant_id, questions_seen_at) VALUES (?, ?, ?)
              ON CONFLICT(contest_id, entrant_id) DO UPDATE SET questions_seen_at = MAX(questions_seen_at, excluded.questions_seen_at)`)
    .run(contestId, entrantId, at)
}

/** Which questions one person reads: their own and the public ones. */
export function questionsVisibleTo(questions: readonly StoredQuestion[], entrantId: string | null): StoredQuestion[] {
  return questions.filter((question) => question.public || (entrantId !== null && question.entrantId === entrantId))
}

/**
 * What a person has not read yet: answers to their own questions and public
 * items given since they last opened the page.
 */
export function unreadFor(questions: readonly StoredQuestion[], entrantId: string, seenAt: number | null): number {
  return questionsVisibleTo(questions, entrantId).filter(
    (question) => question.answer !== null && question.answeredAt !== null && (seenAt === null || question.answeredAt > seenAt),
  ).length
}

