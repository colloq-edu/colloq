/**
 * The board of a contest as one viewer sees it: the rows the database holds
 * fed to the shared rule (@shared/contests · computeStandings), the freeze
 * applied per viewer, and the names as this viewer may read them.
 *
 * WHO SEES WHAT. A participant during the freeze sees their own attempts
 * whole and everybody else's new ones as «?»; staff of the contest see
 * everything, unless they ask for the class's view (`?audience=class`, the
 * projector), which is exactly a stranger's. Names: whole to staff and to the
 * person themselves, an email shortened for everyone else
 * (@shared/competitions · maskEntrantName) — a classmate's mailbox is a
 * contact they were never given.
 *
 * THE NAMES ARE MASKED AFTER THE PLACES ARE COUNTED. The last tie-break of
 * the shared rule is the name itself; ranked by the masked names, two
 * viewers could see one board in two orders. Ranked by the real names, the
 * places are one for everybody who sees the same attempts.
 */
import { createHash } from 'node:crypto'
import { tr } from '@shared/i18n'
import { maskEntrantName } from '@shared/competitions'
import {
  boardFrozen,
  computeStandings,
  freezeAt,
  pointGroups,
  problemLetter,
  problemMaxPoints,
  type Contest,
  type ContestGroup,
  type ContestProblem,
  type ContestTest,
  type StandingCell,
  type StandingProblemTotals,
  type StandingRow,
} from '@shared/contests'
import { contestEntrants, listGroups, listProblems, listTests, standingAttempts } from './store.js'

export interface BoardViewer {
  /** The viewer's own entrant id: their row is never frozen and reads their whole name. */
  entrantId: string | null
  /** Staff of this contest, outside the class's view: nothing frozen, every name whole. */
  staff: boolean
}

export interface BoardProblem {
  id: string
  letter: string
  title: string
  maxScore: number
}

export interface Board {
  problems: BoardProblem[]
  rows: StandingRow[]
  totals: StandingProblemTotals[]
  /** The class's board is frozen now (whatever this viewer is let to see). */
  frozen: boolean
  freezeAt: number | null
  /** The viewer's own row, to highlight; null — not on the board. */
  me: string | null
}

/**
 * The most a problem gives on the board: under IOI what its groups add up to
 * (@shared/contests · pointGroups), under ICPC one — a problem is solved or
 * not, and the board's «score» is the count of solved ones.
 */
export function problemMaxScore(
  contest: Pick<Contest, 'rules'>,
  problem: Pick<ContestProblem, 'id' | 'points'>,
  tests: readonly ContestTest[] = listTests(problem.id),
  groups: readonly ContestGroup[] = listGroups(problem.id),
): number {
  if (contest.rules !== 'ioi') return 1
  return problemMaxPoints(pointGroups(tests, problem.points, groups))
}

/** The problems as the board heads its columns. */
export function boardProblems(contest: Contest, problems: readonly ContestProblem[] = listProblems(contest.id)): BoardProblem[] {
  return problems.map((problem) => ({
    id: problem.id,
    letter: problemLetter(problem.position),
    title: problem.title,
    maxScore: problemMaxScore(contest, problem),
  }))
}

/** The board for one viewer, now. */
export function contestBoard(contest: Contest, viewer: BoardViewer, now = Date.now()): Board {
  const problems = boardProblems(contest)
  const frozen = boardFrozen(contest, now)
  const entrants = contestEntrants(contest.id)
  const result = computeStandings({
    rules: contest.rules,
    startsAt: contest.startsAt,
    penaltyMinutes: contest.penaltyMinutes,
    frozenFrom: frozen && !viewer.staff ? freezeAt(contest) : null,
    problems: problems.map((problem) => ({ id: problem.id, maxScore: problem.maxScore })),
    entrants,
    attempts: standingAttempts(contest.id),
    viewerId: viewer.entrantId,
    seeAll: viewer.staff,
  })
  const rows = result.rows.map((row) => ({
    ...row,
    name: viewer.staff || row.entrantId === viewer.entrantId ? row.name : maskEntrantName(row.name),
  }))
  const me = viewer.entrantId !== null && rows.some((row) => row.entrantId === viewer.entrantId) ? viewer.entrantId : null
  return { problems, rows, totals: result.totals, frozen, freezeAt: freezeAt(contest), me }
}

/** A board's version for the streams: changes exactly when what this viewer sees does. */
export function boardVersion(board: Board): string {
  return createHash('sha1')
    .update(JSON.stringify([board.problems, board.rows, board.totals, board.frozen, board.freezeAt]))
    .digest('base64url')
    .slice(0, 16)
}

/* ----------------------------------------------------------------- CSV */

/** «1:05» — hours and minutes from the start, as the board writes an ICPC time. */
function clock(minutes: number): string {
  return `${Math.floor(minutes / 60)}:${String(minutes % 60).padStart(2, '0')}`
}

/** An ICPC cell as the board writes it: `+2 0:44`, `+ 0:12`, `-3`, `?` (waiting), or nothing. */
function icpcCell(cell: StandingCell): string {
  if (cell.solved) return `+${cell.attempts > 0 ? cell.attempts : ''}${cell.minutes !== null ? ` ${clock(cell.minutes)}` : ''}`
  if (cell.attempts > 0) return `-${cell.attempts}${cell.pending + cell.frozen > 0 ? '?' : ''}`
  if (cell.pending + cell.frozen > 0) return '?'
  return ''
}

/**
 * One CSV field: quoted always (RFC 4180, a doubled quote inside), and a
 * value a spreadsheet would take for a formula — starting with `=`, `+`,
 * `-`, `@`, a tab or a carriage return — led by an apostrophe (OWASP's CSV
 * injection rule). A name from before the handle rule can be anything, and a
 * table opened in Excel must not run it.
 */
function csvField(value: string | number): string {
  let text = String(value)
  if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`
  return `"${text.replace(/"/g, '""')}"`
}

/**
 * The final board as a table: what the teacher grades from. Staff's view —
 * unfrozen, every name whole — whatever the class sees now. UTF-8 with a byte
 * order mark (Excel reads Cyrillic headers only so), comma-separated, CRLF
 * line ends.
 */
export function standingsCsv(contest: Contest, now = Date.now()): string {
  const board = contestBoard(contest, { entrantId: null, staff: true }, now)
  const icpc = contest.rules === 'icpc'
  const header = [
    tr('contests.csv.place'),
    tr('contests.csv.name'),
    ...board.problems.map((problem) => problem.letter),
    ...(icpc ? [tr('contests.csv.solved'), tr('contests.csv.penalty')] : [tr('contests.csv.score')]),
  ]
  const lines = [header.map(csvField).join(',')]
  for (const row of board.rows) {
    const cells = row.cells.map((cell) => (icpc ? icpcCell(cell) : cell.score === null ? '' : String(cell.score)))
    lines.push([row.place, row.name, ...cells, ...(icpc ? [row.solved, row.penalty] : [row.score])].map(csvField).join(','))
  }
  return `﻿${lines.join('\r\n')}\r\n`
}
