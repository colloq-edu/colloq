/**
 * Where a council attempt computed, and what it wrote (docs/architecture/
 * remote-classes.md §9.7, §9.8; Paper 18 · Z9): a card's footnote and its
 * files, the same words on the author's sheet (CellView) and in the console's
 * work (PultWork).
 *
 * A module of its own, apart from council-pult.ts, because the room reads it:
 * CellView is in the room's chunk, which every student downloads, and the
 * console's helpers — its rules, its keyboard, its strip — stay in the
 * console's chunk, loaded only when a teacher opens it (SessionScreen ·
 * councilChunk). council-pult.ts re-exports all of this for the console.
 *
 * Everything here reads the server's data into words: a run's place, epoch,
 * note and files (`CouncilRun.placed|epoch|note|files`). A card's note is the
 * server's own sentence, written in the instance's language and time zone
 * when the run went; the console shortens the ones Z9 drew a short line for,
 * says the time ones again on its own clock, and keeps the whole sentence for
 * a hover and the phone. Nothing here is guessed: a number the data does not
 * carry is not said.
 */
import { tr, translate, type Locale } from '@shared/i18n'
import type { CouncilRun, CouncilRunFile } from '@shared/protocol'
import { formatBytes } from '@/lib/utils'

/* ------------------------------------------------------------ the clock */

/**
 * Hour and minute — and seconds where things are matched by them.
 *
 * Our own, not `clock()` from lib/history: for two lines that module drags in
 * `./api` with the network and tokens, and this file is also read by tests
 * without a browser. The formatting rule is the same, to the character.
 *
 * Seconds are needed in the open work and in the queue: "started at 17:24:05"
 * is how the teacher matches their own run against someone else's when there
 * are three in a minute, and "17:24" for all three answers no question.
 */
export function pultClock(at: number, seconds = false): string {
  const date = new Date(at)
  const two = (value: number): string => String(value).padStart(2, '0')
  const hhmm = `${two(date.getHours())}:${two(date.getMinutes())}`
  return seconds ? `${hhmm}:${two(date.getSeconds())}` : hhmm
}

/* ------------------------------------------------- the server's sentences */

/** The languages a note may be in: a card keeps it from its run, whatever the room reads now. */
export const NOTE_LOCALES: readonly Locale[] = ['ru', 'en']

/** Whether the note is this sentence of the server's, in either language. */
export function sameSentence(note: string, key: string): boolean {
  return NOTE_LOCALES.some((locale) => translate(locale, key) === note)
}

/** A sentence's template as a pattern, by the template's own text: runStats reads every run's note on each frame. */
const SENTENCE_PATTERNS = new Map<string, { pattern: RegExp; names: string[] }>()

/**
 * The values a sentence of the server's was said with — `{ time: '14:05',
 * cells: '8–9' }` of «Состояние 14:05 — без ячеек 8–9.» — in either
 * language, or null for another sentence.
 */
export function sentenceParams(note: string, key: string, names: readonly string[]): Record<string, string> | null {
  for (const locale of NOTE_LOCALES) {
    const template = translate(locale, key, Object.fromEntries(names.map((name, at) => [name, `\u0000${at}\u0000`])))
    let known = SENTENCE_PATTERNS.get(template)
    if (!known) {
      const parts = template.split(/\u0000(\d+)\u0000/)
      const order = parts.filter((_, at) => at % 2 === 1).map((at) => names[Number(at)]!)
      // A dictionary without the key gives the key back: no value in it, no sentence to know.
      if (order.length === 0) continue
      const source = parts.map((part, at) => (at % 2 === 1 ? '([\\s\\S]+?)' : part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))).join('')
      known = { pattern: new RegExp(`^${source}$`), names: order }
      SENTENCE_PATTERNS.set(template, known)
    }
    const found = known.pattern.exec(note)
    if (found) return Object.fromEntries(known.names.map((name, at) => [name, found[at + 1]!]))
  }
  return null
}

/**
 * The name in "Run in the shared kernel: it uses conn, which cannot be
 * carried over." (§9.4, the server's eaf141), or null for another sentence.
 */
export function usedName(note: string): string | null {
  return sentenceParams(note, 'server.runInTheSharedKernelItUses.eaf141', ['name'])?.name ?? null
}

/** The server's sentences that name a snapshot's time, with what else they say. */
const TIMED_SENTENCES: ReadonlyArray<{ key: string; names: readonly string[] }> = [
  { key: 'server.stateAsOfWithoutCell.30d8e4', names: ['time', 'cells'] },
  { key: 'server.stateAsOfWithoutCells.44aa0a', names: ['time', 'cells'] },
  { key: 'server.theNewStateDoesNotFit.1c7533', names: ['time'] },
  { key: 'server.theNewStateCouldNotBeTaken.01b6b1', names: ['time'] },
]

/**
 * A sentence of the server's that names a snapshot's time, said again with
 * the console's own clock and in the room's language; any other sentence as
 * it came. The server writes the time in the instance's zone, the console
 * every time of its own in the browser's (pultClock): in another zone the
 * strip's «состояние 16:05» stood over «…на состоянии 14:05.» for one
 * snapshot. `at` is the moment the sentence names — its snapshot's, which
 * the data carries beside it (`CouncilRun.epoch`, `CouncilPool.epoch`).
 */
export function inConsoleClock(note: string, at: number | null | undefined): string {
  if (at === null || at === undefined) return note
  for (const { key, names } of TIMED_SENTENCES) {
    const params = sentenceParams(note, key, names)
    if (params) return tr(key, { ...params, time: pultClock(at) })
  }
  return note
}

/** A sentence as a card's short line: "State as of 14:05, without cells 8–9." → "state as of 14:05, without cells 8–9". */
function shortOf(note: string): string {
  const text = note.trim().replace(/\.$/, '')
  return text.charAt(0).toLocaleLowerCase() + text.slice(1)
}

/* ------------------------------------------------------------ footnotes */

/** A card's footnote (Z9): where and on what state the attempt computed. */
export interface AttemptFootnote {
  /** The card's line: "computed apart · state as of 14:05". */
  short: string
  /** The whole sentence: a hover's on a wide screen, the line itself on a phone. */
  full: string
  /**
   * Colour only for what needs attention (Z9): `warning` — the attempt did
   * not compute as meant (an older snapshot, the shared kernel, a rerun);
   * `muted` — as meant, or the pool's first seconds.
   */
  tone: 'muted' | 'warning'
}

/**
 * The footnote of a run, or null when there is nothing to say: a class
 * whose council is not on machines (no `placed`), a run not ended yet, a
 * shared run the server gave no reason for.
 *
 * Only an ended run has one. The footnote says where the attempt WAS
 * computed, and until it ends that may still change: a worker whose entry
 * finds the attempt reading a name its snapshot left behind gives it to the
 * shared kernel (§9.4), and a pool's machine lost mid-run reruns it there
 * (§9.10) — a card that said "computed apart" meanwhile would take it back.
 */
export function attemptFootnote(run: Pick<CouncilRun, 'state' | 'placed' | 'note' | 'epoch'> | null | undefined): AttemptFootnote | null {
  if (!run?.placed || (run.state !== 'ok' && run.state !== 'error')) return null
  const note = run.note?.trim() || null
  if (run.placed === 'pool') {
    // The only note a pool's run carries is its snapshot's age: "State as of 14:05, without cells 8–9." — on the console's clock, as the next card's "state as of 14:05" is.
    if (note) {
      const said = inConsoleClock(note, run.epoch?.at)
      return { short: shortOf(said), full: said, tone: 'warning' }
    }
    if (!run.epoch) return null
    const time = pultClock(run.epoch.at)
    return { short: tr('room.council.pool.apart', { time }), full: tr('room.council.pool.apartFull', { time }), tone: 'muted' }
  }
  if (!note) return null
  if (sameSentence(note, 'server.thePoolIsStillStartingThisAttempt.bf84be')) {
    return { short: tr('room.council.pool.starting'), full: note, tone: 'muted' }
  }
  if (sameSentence(note, 'server.theMachineWasLostInTheMiddle.b5f5c5')) {
    return { short: tr('room.council.pool.lost'), full: note, tone: 'warning' }
  }
  const name = usedName(note)
  if (name !== null) return { short: tr('room.council.pool.uses', { name }), full: note, tone: 'warning' }
  return { short: shortOf(note), full: note, tone: 'warning' }
}

/* ---------------------------------------------------------------- files */

/**
 * What of an attempt's files is brought here (shared/remote-kernels.ts ·
 * COUNCIL_ARTIFACTS): so many files, each up to so much, so much in all.
 * Repeated rather than imported: the room's bundle needs no contract module
 * for three numbers (tests/classes-ui-council.test.mts holds them equal).
 */
export const ATTEMPT_FILE_CAPS = { files: 20, fileBytes: 1024 * 1024, totalBytes: 5 * 1024 * 1024 } as const

/** The files an attempt wrote into its own folder (§9.7, D10), as its card lists them. */
export interface AttemptFiles {
  /**
   * Those this server brings, each with its size: "out.csv 12 KB" — here,
   * to take (`sha256`, GET …/council/:cellId/files), or (`coming`) still on
   * their way from the machine.
   */
  brought: Array<{ name: string; size: string; coming: boolean; sha256: string | null }>
  /** "3 more files not kept: over 1 MB"; null when none was left behind. */
  dropped: string | null
  /** The ones left behind by name and size: the hover of that line. */
  droppedNames: string
}

/**
 * A run's files, or null when it wrote none (or a server before the pool).
 *
 * The card says where each is (CouncilRunFile.kept): here (`true`), on its
 * way from the machine (`null` — the run's end names every one it brings
 * so, and each turns `true` as it lands, a sync or more later), or left
 * behind (`false` — past the caps, or its collection ended without it).
 *
 * The reason "over 1 MB" is said only when it is every left one's: a small
 * file is left behind past the count or the total, or because its machine
 * never sent it, and then no reason is better than a wrong one.
 */
export function attemptFiles(run: Pick<CouncilRun, 'files'> | null | undefined): AttemptFiles | null {
  const files: readonly CouncilRunFile[] = run?.files ?? []
  if (files.length === 0) return null
  const brought: AttemptFiles['brought'] = []
  const left: CouncilRunFile[] = []
  for (const file of files) {
    if (file.kept === false) {
      left.push(file)
      continue
    }
    const here = file.kept === true
    brought.push({ name: file.name, size: formatBytes(file.bytes), coming: !here, sha256: here ? (file.sha256 ?? null) : null })
  }
  let dropped: string | null = null
  if (left.length > 0) {
    const line = tr(brought.length > 0 ? 'room.council.pool.droppedMore' : 'room.council.pool.dropped', { count: left.length })
    dropped = left.every((file) => file.bytes > ATTEMPT_FILE_CAPS.fileBytes) ? tr('room.council.pool.droppedBig', { line }) : line
  }
  return {
    brought,
    dropped,
    droppedNames: left.map((file) => `${file.name} ${formatBytes(file.bytes)}`).join(', '),
  }
}
