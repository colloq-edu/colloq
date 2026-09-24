import { tr } from '@shared/i18n'
/**
 * The oracle about the class: one look from above at how the task is going.
 *
 * One frame, one answer, one feed. There used to be two: the "summary of
 * solutions" read only what was SUBMITTED and sorted it into six groups of
 * identical texts, while the "question about the class" saw the whole class
 * and answered in prose. Both views went into one, and that is the owner's
 * decision, not simplification for its own sake:
 *
 *   — the teacher asked for the groups to be removed. Six nameless piles are
 *     not how a teacher thinks about the class; they think "Anya's works,
 *     Petya's fails", and the draft letter to a group thrown in on top turned
 *     out to be a letter to the wrong people;
 *   — asking is possible ALWAYS, including when nobody has submitted yet:
 *     "what is this task about and how should they best go at it" is a
 *     legitimate question at minute ten, and the frame carries the text of the
 *     shared cell and the markdown above it even when the cell is empty.
 *
 * The model sees NAMES. This is also the owner's choice, and it is written
 * down here honestly, because this header used to carry the opposite promise.
 * With labels S1…SN the model answered "S7 and S12 are stuck", the teacher
 * read a cipher, and when asked "whom to go to" the model made names up. Now
 * the frame carries the real names from the room's roster, and the model
 * refers to people the way a colleague would. One instance setting switches
 * this off ("Student names in model requests", OracleSettings.sendNames) —
 * then the labels come back, and the "label → person" mapping stays on the
 * server (`ClassFrame.people`). The key's owner decides: this is about what
 * goes to SOMEONE ELSE'S provider.
 *
 * Refreshed only by hand. A question costs a row from the room's limit, and
 * the class submits one per second: auto-refresh would spend the key on every
 * submission and rewrite paragraphs under the eyes of whoever is reading them.
 *
 * And the trip to the model has a watchdog. The shared one, from ai/watch.ts:
 * on 20 Sep 2026, in a live class, "Refresh summary" on thirty submissions
 * hung forever — no answer, no error, not a line in the log — and the entry in
 * the `reading` map kept the cell locked until the server was restarted. Now
 * the request has three deadlines, the map has a second lock, and intake and
 * outcome each get a line in the log.
 */
import type {
  CouncilOracle,
  CouncilOracleAnswer,
  CouncilRun,
  CouncilRunRequest,
  CouncilStatus,
} from '@shared/protocol'
import { attemptStatus } from '@shared/protocol'
import { COUNCIL_SILENCE_MS } from '@shared/notebook'
import type { ReasoningEffort } from '@shared/admin'
import { randomUUID } from 'node:crypto'
import { getOracleSettings } from '../admin/settings.js'
import { dropQuestion, noteTokens } from '../admin/usage.js'
import { streamChat, type ChatTurn } from './provider.js'
import { COUNCIL_WATCH, watchSilence, type WatchTimes } from './watch.js'
import {
  clip as clipTo,
  clipLine as cutLine,
  effortNote,
  flatten,
  people,
  seconds,
} from './text.js'

/** What the oracle needs from an attempt. The name, if the instance allows sending it. */
export interface OracleAttempt {
  participantId: string
  /**
   * The person's name as the room sees it.
   *
   * Optional: tests and old calls come without it, and the frame then calls the
   * person by a label — exactly as with the setting switched off. There is no
   * colour or avatar here and there will not be: they tell the model nothing,
   * and in someone else's provider's prompt they are extra data about a person.
   */
  name?: string | null
  text: string
  submittedAt: number | null
  run: CouncilRun | null
  correct: boolean | null
  /**
   * The run request, if runs go "on request": `pending` means the person is
   * waiting to be let through to the kernel.
   *
   * The oracle needs this exactly as one number in the summary ("waiting for
   * permission: 3") and one mark in the person's row: someone waiting for a run
   * is not stuck and has not failed, they hit the queue, and saying "did not
   * run" about them would be untrue.
   */
  runRequest?: CouncilRunRequest | null
  /**
   * When the attempt was last edited — silence is counted from it.
   *
   * Optional: an attempt that arrives without it counts as never silent (see
   * `silent`), because "no time" and "not touched for a long time" are
   * different things, and mixing them up means declaring the whole class stuck.
   */
  updatedAt?: number
}

/** The task as the model sees it: the text of the shared cell and what surrounds it. */
export interface OracleTask {
  /** The text of the shared cell — what the students are solving. */
  source: string
  /** The previous cell: the problem statement often sits in markdown above the code. */
  before: string | null
  /** The teacher's reference solution, if given. Nowhere to get one yet, so `null`. */
  reference: string | null
}

/** Where the oracle keeps its state — council.ts; replaced in tests. */
export interface OracleStore {
  oracleOf(sessionId: string, cellId: string): CouncilOracle | null
  setOracle(sessionId: string, cellId: string, oracle: CouncilOracle): void
}

const MAX_TASK_SOURCE = 4_000

/** How much of one sheet's code travels in the frame: a screen, not a file. */
const MAX_SHEET_SOURCE = 900

/**
 * Five minutes without a single edit means "stuck": the sheet is open, and
 * nothing is happening in it.
 *
 * The number comes from `@shared/notebook`: the same one colours the "silent
 * for 7 min" row and counts the "Silent N" chip in the console's "Writing" tab.
 * A copy of its own was kept here until 20 Sep 2026 — and any edit to one of
 * them pulled the oracle's summary apart from the list.
 */
const SILENCE_MS = COUNCIL_SILENCE_MS

/**
 * What share of the FREE space the per-person rows take.
 *
 * Half: in a class of five hundred people the list alone would eat the whole
 * frame, and the model would answer "who is stuck" from numbers alone, without
 * seeing a line of code. The other half goes to the sheets: first to those
 * where something happened, then to the rest of the submitted ones.
 */
const ROSTER_SHARE = 0.5

/* ----------------------------------------------------------------- words */

const STATUS_WORDS: Record<CouncilStatus, string> = {
  unrun: 'не запускали',
  ran: 'запуск прошёл без исключения',
  failed: 'запуск упал',
  correct: 'преподаватель отметил «верно»',
  wrong: 'преподаватель отметил «неверно»',
}

/**
 * The attempt's state in one word — as in `CouncilStatus`: the teacher's mark
 * outranks the run, because the decision about correctness is theirs.
 *
 * A thin wrapper over the shared `attemptStatus` (protocol.ts): a copy of the
 * same rule used to live here, the third one.
 */
export function statusOf(attempt: Pick<OracleAttempt, 'run' | 'correct'>): CouncilStatus {
  return attemptStatus({ run: attempt.run ?? null, correct: attempt.correct ?? null })
}

/**
 * The state of ONE sheet in words — the same rule as `statusOf`, plus two
 * things it lacks: a stop by the limit and waiting for permission.
 *
 * A stop by the limit is kept apart from a failure, because these are
 * different conversations: the one who failed made a mistake, while the one
 * who was stopped wrote an infinite loop or is waiting on `input()`, and the
 * teacher approaches them differently. They cannot be told apart by `ename` —
 * the server interrupts the run itself (`CouncilRun.timedOut`).
 */
function sheetStatus(attempt: OracleAttempt): string {
  const status = statusOf(attempt)
  if (status !== 'failed') return STATUS_WORDS[status]
  const run = attempt.run
  if (run?.timedOut !== undefined) return `запуск остановлен: дольше ${seconds(run.timedOut)}`
  const error = run?.outputs.find((o) => o.kind === 'error')
  return error
    ? `${STATUS_WORDS.failed}: ${error.ename}${error.evalue ? ` — ${clipLine(error.evalue, 120)}` : ''}`
    : STATUS_WORDS.failed
}

/**
 * Head and tail: the tail of code holds the return, the tail of a problem
 * statement holds the question.
 *
 * The shared clipping (text.ts · clip), only with the words in Russian: the
 * frame is written in Russian, and an English marker in the middle of it would
 * read as foreign.
 */
function clip(text: string, limit: number): string {
  return clipTo(text, limit, (dropped) => `\n… пропущено ${dropped} знаков …\n`)
}

/** On one line: a traceback in a person's row only reads this way. */
function clipLine(text: string, limit: number): string {
  return cutLine(flatten(text), limit)
}

/** "17:25", the submit time in a person's row; server clock, as everywhere in the frame. */
function hhmm(at: number): string {
  const when = new Date(at)
  return `${String(when.getHours()).padStart(2, '0')}:${String(when.getMinutes()).padStart(2, '0')}`
}

/** "just now", "3 min ago", "1 h 05 min ago" — how long since the sheet was edited. */
function ago(ms: number): string {
  const minutes = Math.floor(Math.max(ms, 0) / 60_000)
  if (minutes < 1) return 'только что'
  if (minutes < 60) return `${minutes} мин назад`
  return `${Math.floor(minutes / 60)} ч ${String(minutes % 60).padStart(2, '0')} мин назад`
}

/**
 * "1 строка", "3 строки", "12 строк" (line forms): a count that does not jar
 * the eye in the frame.
 */
function linesWord(n: number): string {
  return tr('server.ai.linesWord', { count: n })
}

/** Whether the person is waiting to be let through to the kernel. */
function waiting(attempt: OracleAttempt): boolean {
  return attempt.runRequest?.status === 'pending'
}

/**
 * A draft to which not a single character has been added for a long time.
 *
 * Without `updatedAt` it is not silent: the edit time is optional, and taking
 * "no time" for "not touched for a long time" would mean declaring the whole
 * class stuck on the very first frame without this field.
 */
function silent(attempt: OracleAttempt, now: number): boolean {
  if (attempt.submittedAt !== null || attempt.updatedAt === undefined) return false
  return now - attempt.updatedAt > SILENCE_MS
}

/* ----------------------------------------------------------------- frame */

/** The model's frame: what went out, and who appeared to it under which name (or label). */
export interface ClassFrame {
  turns: ChatTurn[]
  /**
   * CAPTION IN THE FRAME → participantId. The key is either a label `S7` or a
   * name exactly as it went to the model ("Anna Ivanova", "Anna Ivanova (2)").
   *
   * One field for both cases, and that is not a trifle: the console highlights
   * the keys of this dictionary in the answer and nothing else, so it needs
   * neither to know which mode is on nor to derive the same captions from the
   * room's roster a second time — and two derivations of one rule would one day
   * diverge on namesakes.
   */
  people: Record<string, string>
  /** What class the answer was based on — this pair is shown under the answer in the feed. */
  basedOn: { submitted: number; drafts: number }
  /** How many characters went to the model — one number in the intake log line. */
  chars: number
}

/** How people are called in the frame: by real names or by labels S1…SN. */
export interface FrameNaming {
  /** `true` for names, `false` for labels. The default comes from instance settings. */
  names: boolean
}

function systemFrame(names: boolean, effort: ReasoningEffort | undefined): string {
  const lines = [
    'Ты помогаешь преподавателю вести занятие: он спрашивает, как идут дела у класса',
    'и что делать с решениями.',
    'Тебе дано задание, числа по классу, строки по людям и их код.',
    '',
  ]
  if (names) {
    lines.push(
      'Людей зовут ИМЕНАМИ — ровно теми, что стоят в кадре. Ссылайся на них по имени',
      'и пиши имя ТОЧНО так, как оно написано здесь, без склонений в самой ссылке',
      '(«у Анны Белой падает запуск», а не «у Белой А.»): по этим именам преподаватель',
      'открывает работу нажатием. Людей, которых в кадре нет, не выдумывай.',
    )
  } else {
    lines.push(
      'Людей зовут метками S1…SN, и других имён у них нет — не выдумывай их и не',
      'придумывай новых меток. Метки перечисляй через запятую (S6, S7, S8) и никогда',
      // The console replaces a range "S6–S10" with two names with a dash in
      // the middle, and the phrase reads like someone's double surname:
      // "Aleksandr Yakovlev–Aleksandr".
      'не пиши их диапазоном вида S6–S10: преподаватель видит на месте метки имя.',
    )
  }
  lines.push(
    '',
    'Отвечай КОРОТКО и по делу, обычной прозой: преподаватель читает ответ прямо',
    'на паре, стоя у доски. Два-три предложения, если хватает; без JSON, без',
    'заголовков и без длинных списков. Если в данных ответа на вопрос нет — так и',
    'скажи одной строкой, не догадываясь.',
  )
  const note = effortNote(effort)
  if (note) lines.push('', note)
  return lines.join('\n') + '\n' + tr('server.ai.answerLanguage')
}

/** One person's row and their place in the queue for attention. */
interface Row {
  label: string
  attempt: OracleAttempt
  /** 0: probably needs help; 1: silent; 2: just working. */
  rank: number
  line: string
}

function rowOf(label: string, attempt: OracleAttempt, now: number): Row {
  const status = statusOf(attempt)
  const stuck = status === 'failed'
  const quiet = silent(attempt, now)
  const bits = [
    label,
    attempt.submittedAt === null ? 'пишет' : `сдал ${hhmm(attempt.submittedAt)}`,
    sheetStatus(attempt),
  ]
  if (waiting(attempt)) bits.push('ждёт разрешения на запуск')
  const lines = attempt.text.trim() ? attempt.text.split('\n').length : 0
  bits.push(lines === 0 ? 'лист пуст' : `${lines} ${linesWord(lines)}`)
  if (attempt.updatedAt !== undefined) bits.push(`правка ${ago(now - attempt.updatedAt)}`)
  return { label, attempt, rank: stuck ? 0 : quiet ? 1 : 2, line: bits.join(' · ') }
}

/**
 * Numbers for the class — what the model starts reading the frame with.
 *
 * A separate function, because the feed's `basedOn` and the order of rows are
 * built from it too: one place that decides who "failed", who is "silent" and
 * who is "waiting".
 */
function tally(attempts: readonly OracleAttempt[], now: number) {
  let submitted = 0
  let ran = 0
  let failed = 0
  let stopped = 0
  let unrun = 0
  let waits = 0
  let right = 0
  let wrong = 0
  let quiet = 0
  const errors = new Map<string, number>()
  for (const attempt of attempts) {
    if (attempt.submittedAt !== null) submitted += 1
    if (waiting(attempt)) waits += 1
    if (silent(attempt, now)) quiet += 1
    if (attempt.correct === true) right += 1
    if (attempt.correct === false) wrong += 1
    const run = attempt.run
    if (!run) {
      unrun += 1
    } else if (run.timedOut !== undefined) {
      stopped += 1
    } else if (run.state === 'error') {
      failed += 1
      const name = run.outputs.find((o) => o.kind === 'error')?.ename?.trim()
      if (name) errors.set(name, (errors.get(name) ?? 0) + 1)
    } else if (run.state === 'ok') {
      ran += 1
    }
  }
  return {
    total: attempts.length,
    submitted,
    drafts: attempts.length - submitted,
    ran,
    failed,
    stopped,
    unrun,
    waits,
    right,
    wrong,
    quiet,
    // Top exception names: three is already "a typical error", beyond that is the tail.
    errors: [...errors.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, 3),
  }
}

/**
 * The names by which people are called in the frame.
 *
 * With the setting on, the real name; a person without a name (the participant
 * is no longer in the database, the row is broken) still gets a label,
 * otherwise the frame row would start with emptiness. With it off, labels only.
 *
 * Labels are handed out by participantId, not by submission or edit time. Both
 * of those are alive: a neighbour submitted, changed their mind, added a comma
 * — and S7 in the next question would turn out to be a different person.
 *
 * Identical names are common in a class of a hundred people, and two "Anna
 * Ivanova"s in the frame would make the answer unresolvable: both get a number
 * appended ("Anna Ivanova (2)"), and the console finds the right submission by
 * it.
 */
function namesFor(
  attempts: readonly OracleAttempt[],
  names: boolean,
): { label: Map<string, string>; people: Record<string, string> } {
  const ordered = [...attempts].sort((a, b) => a.participantId.localeCompare(b.participantId))
  const label = new Map<string, string>()
  const people: Record<string, string> = {}
  const seen = new Map<string, number>()
  for (const [at, attempt] of ordered.entries()) {
    const own = names ? (attempt.name ?? '').trim() : ''
    let mark = `S${at + 1}`
    if (own) {
      const times = (seen.get(own) ?? 0) + 1
      seen.set(own, times)
      mark = times === 1 ? own : `${own} (${times})`
    }
    label.set(attempt.participantId, mark)
    people[mark] = attempt.participantId
  }
  return { label, people }
}

/**
 * The frame for the model — one for all questions.
 *
 * `now` is a parameter, not `Date.now()` inside: "silence" and "edited 3 min
 * ago" are counted from it, and a test with fake time checks the real numbers,
 * not whatever managed to pass between two lines.
 *
 * The budget is the instance's `contextChars`. It is spent in order: first the
 * system frame, the task and the numbers (they always go — a frame without them
 * is not a frame), then the per-person rows (no more than half of what is
 * left), then the sheets' code: first those where something happened, then the
 * rest of the submitted ones. In both places the tail folds into a count: the
 * model must know there is more class beyond the frame, otherwise it will say
 * "everyone else is fine" without having the right to.
 *
 * THE HEAD OF THE FRAME COUNTS TOWARDS THE BUDGET. It used to not count at all:
 * a task of four thousand characters went over the ceiling, and a teacher who
 * lowered contextChars for a small model got a request twice the size they
 * named.
 */
export function oraclePrompt(
  task: OracleTask,
  attempts: readonly OracleAttempt[],
  question: string,
  options: {
    now?: number
    budget?: number
    names?: boolean
    effort?: ReasoningEffort
  } = {},
): ClassFrame {
  const settings = getOracleSettings()
  const now = options.now ?? Date.now()
  const budget = options.budget ?? settings.contextChars
  const names = options.names ?? settings.sendNames
  const system = systemFrame(names, options.effort)

  const { label, people: who } = namesFor(attempts, names)
  const sum = tally(attempts, now)

  const head: string[] = []
  if (task.before) {
    head.push('КОНТЕКСТ (ячейка над заданием):', clip(task.before, MAX_TASK_SOURCE), '')
  }
  head.push('ЗАДАНИЕ (текст общей ячейки):', '```', clip(task.source, MAX_TASK_SOURCE), '```', '')
  if (task.reference) {
    head.push(
      'ЭТАЛОННОЕ РЕШЕНИЕ преподавателя:',
      '```python',
      clip(task.reference, MAX_TASK_SOURCE),
      '```',
      '',
    )
  }
  head.push(
    `СЕЙЧАС: ${hhmm(now)}.`,
    `КЛАСС: ${people(sum.total)} с листом — сдали ${sum.submitted}, ещё пишут ${sum.drafts}.`,
    `ЗАПУСКИ: без ошибки ${sum.ran}, с ошибкой ${sum.failed}` +
      (sum.errors.length > 0
        ? ` (${sum.errors.map(([name, n]) => `${name} — ${n}`).join(', ')})`
        : '') +
      `, остановлено пределом ${sum.stopped}, не запускали ${sum.unrun}, ждут разрешения ${sum.waits}.`,
    `ОТМЕТКИ преподавателя: верно ${sum.right}, неверно ${sum.wrong}, без отметки ${sum.total - sum.right - sum.wrong}.`,
    `ТИШИНА: черновиков без правки дольше 5 минут — ${sum.quiet}.`,
    '',
  )

  const rows = attempts
    .map((attempt) => rowOf(label.get(attempt.participantId) ?? attempt.participantId, attempt, now))
    // First those who more likely need help: failed, silent, everything else.
    // Within a rank, by caption, so that two identical frames match.
    .sort((a, b) => a.rank - b.rank || a.label.localeCompare(b.label, 'ru', { numeric: true }))

  let used = system.length + head.join('\n').length + question.length

  const roster: string[] = []
  if (rows.length > 0) {
    const title = names
      ? 'ПО ЛЮДЯМ:'
      : 'ПО ЛЮДЯМ (метки S — других имён у этих людей нет):'
    roster.push(title)
    used += title.length + 1
    const rosterCap = used + Math.max(0, budget - used) * ROSTER_SHARE
    let folded = 0
    let foldedQuiet = 0
    for (const row of rows) {
      if (used + row.line.length > rosterCap) {
        folded += 1
        if (row.rank === 2) foldedQuiet += 1
        continue
      }
      roster.push(row.line)
      used += row.line.length + 1
    }
    if (folded > 0) {
      const tail =
        folded === foldedQuiet
          ? `Ещё ${folded} без происшествий.`
          : `Ещё ${folded} в кадр не поместились (из них ${folded - foldedQuiet} с происшествиями).`
      roster.push(tail)
      used += tail.length + 1
    }
    roster.push('')
  }

  /*
   * Code in a second pass, and by name. There are no groups anymore: identical
   * solutions travel as they are, each with its own name, because the teacher
   * asks not "what is in group G2" but "what does Petya have".
   *
   * The order is the same as for the rows: first the failed and the silent
   * (they are what people ask about), then the rest of the submitted ones.
   * Drafts without incidents do not travel as code at all: a line and a half of
   * a started sheet costs the space where someone's real error would otherwise
   * fit, and the fact "writing, 3 lines" is already in the person's row.
   */
  const code: string[] = []
  const worth = rows.filter(
    (row) => row.attempt.text.trim().length > 0 && (row.rank < 2 || row.attempt.submittedAt !== null),
  )
  if (worth.length > 0) {
    const title = 'РЕШЕНИЯ ПОИМЁННО:'
    code.push(title)
    used += title.length + 1
    let hidden = 0
    for (const row of worth) {
      const block = [
        `### ${row.label} — ${row.line.slice(row.label.length + 3)}`,
        '```python',
        clip(row.attempt.text.trim(), MAX_SHEET_SOURCE),
        '```',
      ].join('\n')
      if (used + block.length > budget) {
        hidden += 1
        continue
      }
      code.push(block)
      used += block.length + 2
    }
    if (hidden > 0) code.push(`Ещё ${hidden} ${listsWord(hidden)} в кадр не поместились.`)
    code.push('')
  }

  const body = [...head, ...roster, ...code, 'ВОПРОС ПРЕПОДАВАТЕЛЯ:', question].join('\n')
  const turns: ChatTurn[] = [
    { role: 'system', content: system },
    { role: 'user', content: body },
  ]
  return {
    turns,
    people: who,
    basedOn: { submitted: sum.submitted, drafts: sum.drafts },
    chars: system.length + body.length,
  }
}

/** "1 лист", "3 листа", "5 листов" (sheet forms): the count of the folded tail. */
function listsWord(n: number): string {
  return tr('server.council.sheetsWord', { count: n })
}

/* -------------------------------------------------------------- state */

/**
 * How many feed turns the server keeps.
 *
 * Six is a conversation during a class: what was asked half an hour ago no
 * longer matters at the whiteboard. And it is the frame's ceiling: every answer
 * carries its own dictionary of labels, and a feed without a limit would grow
 * in EVERY `council:oracle` until the end of the class.
 */
export const MAX_ORACLE_ANSWERS = 6

export function idleOracle(): CouncilOracle {
  return {
    state: 'idle',
    askedAt: null,
    basedOn: 0,
    error: null,
    answers: [],
    pending: null,
  }
}

/**
 * An oracle read from the database, brought to today's shape.
 *
 * `council_oracle` rows are written as JSON and survive a server upgrade: those
 * written by the previous version carry fields that no longer exist
 * (`summary`, `groupLabels`, `drafts`) and lack the ones that appeared since.
 * Here the row is brought to the current form — otherwise a reader relying on a
 * field being present would crash the console on the very first class that was
 * started yesterday. The feed's ceiling is also held here.
 */
export function normalizeOracle(oracle: CouncilOracle): CouncilOracle {
  const answers = Array.isArray(oracle.answers) ? oracle.answers.slice(-MAX_ORACLE_ANSWERS) : []
  return {
    state: oracle.state ?? 'idle',
    askedAt: oracle.askedAt ?? null,
    basedOn: oracle.basedOn ?? 0,
    error: oracle.error ?? null,
    answers,
    pending: oracle.pending ?? null,
  }
}

type OracleListener = (sessionId: string, cellId: string, oracle: CouncilOracle) => void

let listener: OracleListener | null = null

/**
 * Whom to tell that the oracle changed state. Registered by control.ts — it has
 * the teachers' sockets; importing control.ts from here would tie the modules
 * into a loop, exactly like onRefusal in collab/index.ts.
 */
export function onCouncilOracle(next: OracleListener): void {
  listener = next
}

function announce(sessionId: string, cellId: string, oracle: CouncilOracle): void {
  listener?.(sessionId, cellId, oracle)
}

/**
 * The key is `${sessionId}:${cellId}`; an entry exists only while the model is
 * reading.
 *
 * An entry has TWO locks. The first is the `.finally()` of the same promise,
 * which removes it however the reading ends. The second is a deadline: if the
 * promise never settles at all (and that is exactly what happened on 20 Sep
 * 2026), the entry is removed by a timer, and the cell does not stay locked on
 * 409 until the server restarts. There was already one lock here, and it was
 * not enough.
 */
interface Reading {
  controller: AbortController
  /** The second lock: removes the entry even if the promise never settled. */
  latch: NodeJS.Timeout
}

const reading = new Map<string, Reading>()

/**
 * A margin on top of the request ceiling: the watchdog cuts off at 180 s, and
 * settling the promise and writing the state take fractions of a second more.
 * Half a minute is more than enough, and this is the emergency path, not the
 * working one.
 */
const LATCH_GRACE_MS = 30_000

function forget(key: string, entry: Reading): void {
  if (reading.get(key) !== entry) return
  clearTimeout(entry.latch)
  reading.delete(key)
}

export function isOracleReading(sessionId: string, cellId: string): boolean {
  return reading.has(`${sessionId}:${cellId}`)
}

export interface AskCouncilOracle {
  sessionId: string
  cellId: string
  task: OracleTask
  attempts: readonly OracleAttempt[]
  store: OracleStore
  /** The usage row the route created at intake: the tokens will be added to it. */
  usageId?: number
  /** The teacher's question. Empty means the route puts in its own default. */
  question: string
  /** The reasoning level for this request; empty means the instance default. */
  effort?: ReasoningEffort
  /**
   * The watchdog's deadlines. The route does not pass them — it has
   * `COUNCIL_WATCH`; the test puts them in, and there is no other way: checking
   * "a silent provider ends with an understandable error" on the real deadlines
   * would cost three minutes of waiting on every run, that is, the check would
   * not exist at all.
   */
  times?: WatchTimes
}

/**
 * Ask. Returns the "reading" state right away — the 202 is answered with it;
 * the answer arrives later through `onCouncilOracle`.
 */
export function askCouncilOracle(input: AskCouncilOracle): CouncilOracle {
  const { sessionId, cellId, store } = input
  const key = `${sessionId}:${cellId}`
  const previous = normalizeOracle(store.oracleOf(sessionId, cellId) ?? idleOracle())
  const question = input.question.trim()
  const now = Date.now()
  const submitted = input.attempts.filter((one) => one.submittedAt !== null).length
  const started: CouncilOracle = {
    ...previous,
    state: 'reading',
    askedAt: now,
    basedOn: submitted,
    error: null,
    pending: { question, askedAt: now },
  }
  store.setOracle(sessionId, cellId, started)
  announce(sessionId, cellId, started)

  const controller = new AbortController()
  const entry: Reading = {
    controller,
    latch: setTimeout(() => {
      // Only stuck ones get here: a normal reading removes the entry earlier.
      if (reading.get(key) !== entry) return
      reading.delete(key)
      console.warn(`[session ${sessionId}] council oracle: stuck reading on ${cellId}, freed by latch`)
      controller.abort()
      settleStuck(input, previous)
    }, ((input.times ?? COUNCIL_WATCH).capMs ?? 180_000) + LATCH_GRACE_MS),
  }
  entry.latch.unref?.()
  reading.set(key, entry)
  void read(input, previous, question, controller).finally(() => forget(key, entry))
  return started
}

/** A cell stuck in "reading": put it in order and tell the console. */
function settleStuck(input: AskCouncilOracle, previous: CouncilOracle): void {
  const current = input.store.oracleOf(input.sessionId, input.cellId)
  if (!current || current.state !== 'reading') return
  const settled = failedOracle(
    normalizeOracle(current),
    previous,
    tr('server.theOracleDidNotRespondCheckThe.e430c5'),
  )
  input.store.setOracle(input.sessionId, input.cellId, settled)
  announce(input.sessionId, input.cellId, settled)
}

/**
 * A refusal goes into the FEED, not only into a red banner.
 *
 * The teacher's question does not disappear on a refusal: the turn stays in
 * place with the reason instead of an answer. Before this, a "Refresh summary"
 * that ended in nothing erased the question itself too — there was nothing to
 * repeat, and no way to understand what had gone unanswered.
 */
function failedOracle(current: CouncilOracle, previous: CouncilOracle, reason: string): CouncilOracle {
  const asked = current.pending ?? previous.pending
  const answers = asked
    ? [
        ...current.answers,
        {
          id: randomUUID(),
          question: asked.question,
          text: '',
          failed: reason,
          askedAt: asked.askedAt,
          basedOn: { submitted: current.basedOn, drafts: 0 },
          people: {},
        } satisfies CouncilOracleAnswer,
      ].slice(-MAX_ORACLE_ANSWERS)
    : current.answers
  return {
    ...current,
    state: answers.length > 0 ? 'ready' : 'idle',
    error: reason,
    pending: null,
    answers,
  }
}

async function read(
  input: AskCouncilOracle,
  previous: CouncilOracle,
  question: string,
  controller: AbortController,
): Promise<void> {
  const { sessionId, cellId, store } = input
  const began = Date.now()
  const settle = (oracle: CouncilOracle) => {
    store.setOracle(sessionId, cellId, oracle)
    announce(sessionId, cellId, oracle)
  }
  /** Current state, not the one at entry: someone else may have added to the feed. */
  const nowState = () => normalizeOracle(store.oracleOf(sessionId, cellId) ?? previous)

  /*
   * A question spent for nothing must not eat the room's hourly limit.
   *
   * The usage row is created at INTAKE (the route), because the request to the
   * provider goes out however it ends. But a "Refresh" that hung for three
   * minutes and ended in a refusal is not a question but lost time, and paying
   * for it with a slot under the hourly ceiling is doubly unfair: that is
   * exactly when the teacher presses the button again. The row is removed only
   * if the provider named not a single token; if it did, the money is gone and
   * the count stays (admin/usage.ts · dropQuestion).
   */
  const wasted = () => {
    if (input.usageId !== undefined) dropQuestion(input.usageId)
  }

  const spend = (tokens: number) => {
    if (input.usageId !== undefined) noteTokens(input.usageId, tokens)
  }

  const guard = watchSilence(controller, input.times ?? COUNCIL_WATCH)
  try {
    const settings = getOracleSettings()
    const frame = oraclePrompt(input.task, input.attempts, question, { effort: input.effort })
    console.log(
      `[session ${sessionId}] council oracle: cell ${cellId}, ` +
        `${input.attempts.length} sheets, ${frame.chars} chars, ` +
        `effort ${input.effort ?? settings.reasoningEffort}, ` +
        `names ${settings.sendNames ? 'on' : 'off'}`,
    )
    const text = await streamChat(
      frame.turns,
      () => guard.heard(),
      controller.signal,
      spend,
      input.effort,
    )
    if (controller.signal.aborted) {
      /*
       * Three outcomes of one cancellation, and they are told apart in words.
       *
       * "Did not open the stream" is true only before the first frame: the
       * cure is a smaller contextChars, and the phrase about the allotted time
       * says so. "Went silent midway" is already a conversation with the
       * endpoint, and there the advice "retry" is appropriate. "Stop was
       * pressed" is not a refusal at all.
       */
      const why =
        guard.why === null
          ? null
          : guard.spoke
            ? tr('server.theModelStoppedSendingItsResponseTry.3aa75a')
            : tr('server.theModelDidNotRespondWithinThe.be1746')
      console.warn(
        `[session ${sessionId}] council oracle: ${guard.why ?? 'stopped by teacher'} ` +
          `after ${Date.now() - began} ms`,
      )
      wasted()
      settle(why === null ? stoppedOracle(nowState()) : failedOracle(nowState(), previous, why))
      return
    }
    if (!text.trim()) {
      wasted()
      settle(
        failedOracle(nowState(), previous, tr('server.theModelReturnedAnEmptyResponseTry.c365b1')),
      )
      return
    }
    const answer: CouncilOracleAnswer = {
      id: randomUUID(),
      question,
      text: text.trim(),
      failed: null,
      askedAt: Date.now(),
      basedOn: frame.basedOn,
      people: frame.people,
    }
    const current = nowState()
    settle({
      ...current,
      state: 'ready',
      error: null,
      pending: null,
      answers: [...current.answers, answer].slice(-MAX_ORACLE_ANSWERS),
    })
    console.log(
      `[session ${sessionId}] council oracle: ready in ${Date.now() - began} ms, ` +
        `${answer.text.length} chars`,
    )
  } catch (err) {
    if (controller.signal.aborted && guard.why === null) {
      settle(stoppedOracle(nowState()))
      wasted()
      return
    }
    const reason = err instanceof Error ? err.message.trim() : String(err)
    console.error(
      `[session ${sessionId}] council oracle: failed after ${Date.now() - began} ms — ${reason}`,
    )
    wasted()
    settle(
      failedOracle(
        nowState(),
        previous,
        reason || tr('server.theOracleDidNotRespondCheckThe.e430c5'),
      ),
    )
  } finally {
    guard.stop()
  }
}

/**
 * "Stop" is not a refusal: the turn simply leaves the feed together with the
 * wait.
 *
 * We do not set an error and we clear the previous one: a red banner after
 * your own press reads as a breakage.
 */
function stoppedOracle(current: CouncilOracle): CouncilOracle {
  return {
    ...current,
    state: current.answers.length > 0 ? 'ready' : 'idle',
    error: null,
    pending: null,
  }
}

/**
 * "Stop": abort the reading. Returns `true` if there was something to abort.
 *
 * And it puts the state in order even when there is nothing to abort. This is
 * the second lock on the same door as the entry's deadline: a cell stuck in
 * `reading` without a live reading answered 409 to every next question — that
 * is, "Stop" stopped working exactly when it was needed.
 */
export function stopCouncilOracle(sessionId: string, cellId: string, store?: OracleStore): boolean {
  const key = `${sessionId}:${cellId}`
  const entry = reading.get(key)
  if (entry) {
    entry.controller.abort()
    // The reading's `.finally()` removes the entry; the latch is in case it does not.
  }
  if (store) {
    const current = store.oracleOf(sessionId, cellId)
    if (current && current.state === 'reading' && !entry) {
      const settled = stoppedOracle(normalizeOracle(current))
      store.setOracle(sessionId, cellId, settled)
      announce(sessionId, cellId, settled)
    }
  }
  return entry !== undefined
}

/**
 * Abort all readings of the room — the seminar is being deleted.
 *
 * Called by `discardCouncil` (server/src/council.ts). Without this, an answer
 * arriving a minute after deletion went into `setOracle`, which created the
 * room's cache again and wrote a `council_oracle` row for a session that is no
 * longer on the list. Returns how many readings were aborted — for the log and
 * the test.
 */
export function stopRoomOracles(sessionId: string): number {
  const prefix = `${sessionId}:`
  let stopped = 0
  for (const [key, entry] of reading) {
    if (!key.startsWith(prefix)) continue
    entry.controller.abort()
    clearTimeout(entry.latch)
    reading.delete(key)
    stopped += 1
  }
  return stopped
}
