import { tr } from '@shared/i18n'
/**
 * What this person may do in this room — in one place.
 *
 * A rule that stops you must say that it is a rule, and say it where the press
 * happens, and before the press. Spreading `allows(rules.edit, role)` across
 * twenty components is a sure way to get a room where half the buttons go dark
 * and half silently do nothing; the latter read as a breakage and come back as
 * a bug report.
 *
 * The phrases live here too, next to the right: `controls.ts` already knows how
 * to combine them with "no connection" and knows the connection matters more
 * than the rule.
 */
import {
  actsAfterClass,
  allows,
  allowsAgent,
  allowsRun,
  allowsStructure,
  bookRefusal,
  CLASS_IS_OVER,
  mayEditCell,
  mayLeadCouncil,
  mayRunCell,
  mayRunCouncil,
  mayWriteCouncil,
  readRules,
  rulesAfterClass,
  rulesForBook,
  type Asker,
  type RoomRules,
} from '@shared/rules'
import type { ParticipantRole } from '@shared/protocol'

export interface Permits {
  /**
   * The rules the room lives by right now — with the end of class applied.
   *
   * Not what is chosen in the settings: those are taken straight from
   * `session.session.rules` where the settings themselves are drawn. Here is
   * what the buttons go dark by.
   */
  rules: RoomRules
  /** The class is over: a participant reads, the teacher acts. */
  finished: boolean
  /**
   * Who is asking.
   *
   * All the fields below are ready answers, with the role melted into them. It
   * stays here for rights that cannot be computed in advance, because they
   * also depend on the cell: see `mayEditThisCell` at the end of the file.
   */
  role: ParticipantRole
  /**
   * What THE NOTEBOOK ITSELF refuses with — or `null` when the notebook has
   * nothing to do with it.
   *
   * Needed in two places where the room would otherwise speak instead of the
   * notebook: the "Lecture" strip above the notebook and the line under a
   * locked cell. Both are written about the ROOM ("the teacher edits and runs
   * the cells"), and in someone else's personal notebook that is untrue: its
   * author edits it, not the teacher, and a person who read the strip would
   * go the wrong way.
   */
  bookWhy: string | null
  /**
   * This notebook has access of its own — any, except "as in the room".
   *
   * For whoever draws the "Lecture" strip: it speaks about the ROOM, and it
   * must not be shown above a notebook with its own access to either a student
   * or the teacher — the notebook does not live by that rule, and the mark on
   * the tab speaks about it. Separate from `bookWhy`, because for someone the
   * notebook forbids nothing (the author, the teacher) there is no refusal
   * phrase, and the strip is superfluous all the same.
   */
  bookRuled: boolean
  /** Type in cells. */
  edit: boolean
  editWhy: string
  /** Run: a cell, a file above the editor, a command in the shared shell. */
  run: boolean
  runWhy: string
  /** Run the whole sheet: Run All, Run Above, formatting. */
  bulk: boolean
  bulkWhy: string
  /** Add a cell. */
  add: boolean
  /** Remove a cell. */
  remove: boolean
  /** Move or duplicate. */
  move: boolean
  structureWhy: string
  /** Wipe everything at once: the board, the terminal, the oracle feed. */
  wipe: boolean
  wipeWhy: string
  /** Restart the kernel. */
  restart: boolean
  restartWhy: string
  /** See the version feed. */
  history: boolean
  /** Create and edit the seminar's files. */
  files: boolean
  filesWhy: string
  /**
   * Start ONE'S OWN notebook in the room — empty or by bringing in an .ipynb
   * placed in the folder.
   *
   * Separate from `files`, and this is no duplication: `files` is about the
   * class's shared folder, while one's own notebook is about the participant's
   * own work, whose file the server writes as a projection. So "files are the
   * teacher's, own notebooks allowed" is an ordinary pair, and the reverse too
   * (shared/rules.ts · ownBooks).
   */
  ownBook: boolean
  ownBookWhy: string
  /** Ask the oracle not to answer but to act: to edit files itself. */
  agent: boolean
  agentWhy: string
  /** Put a document on the room's shared screen. Anyone may view one for themselves. */
  board: boolean
  boardWhy: string
  /**
   * Ask the oracle.
   *
   * The rules have no such field: `oracle` describes the level of detail of
   * answers for the whole room, the teacher included. Only the end of class
   * takes the right to ask away — and the same border stands on the server
   * (routes/ai.ts).
   */
  ask: boolean
  askWhy: string
  /**
   * Lead a council: switch the lock and the knobs, page through the stack,
   * show to the class, reply, mark, remove, ask the oracle about solutions.
   *
   * The rules have no such field: the council is exactly the way to let the
   * class write where `edit` belongs to the teacher. The teacher leads it —
   * after the bell too: submitted work stays for review (shared/rules.ts ·
   * mayLeadCouncil).
   */
  council: boolean
  councilWhy: string
  /**
   * Write one's own attempt in a council — one's own, not the shared
   * notebook, so `edit` has nothing to do with it. Only the end of class takes
   * it away; "the council on this cell is closed" is a second factor, and it
   * depends on the cell: see `mayWriteThisCouncil` below.
   */
  attempt: boolean
  attemptWhy: string
}

const HOSTS = "В этом семинаре это делает преподаватель"

/**
 * Which notebook is being asked about — and who is asking.
 *
 * A single notebook can have access of its own (shared/rules.ts ·
 * RoomRules.books), and then `run`, `edit` and `structure` in it are
 * different. Who exactly is asking matters here for exactly one question:
 * whether this personal notebook is theirs.
 */
export interface InBook {
  /** The notebook's root in the document; `null` — the question is not about a notebook. */
  root: string | null
  /** One's own participantId; `null` — the asker did not identify themselves. */
  participantId: string | null
}

/**
 * @param finished — whether the class is over. A third required argument, not
 * a field with a default: a forgotten argument must be a type error, not a
 * quietly open button in a room where the class has already ended.
 *
 * @param book — the notebook being asked about. Without it the answer is the
 * room's, and that is the right answer for everything unrelated to notebooks:
 * the terminal, the board, files, the kernel. The notebook and the cell pass
 * their own (Notebook.svelte, CellView.svelte), and then `run`, `edit` and
 * `structure` are computed BY IT — with the same `rulesForBook` the server
 * answers with.
 */
export function permitsIn(
  rules: unknown,
  role: ParticipantRole,
  finished: boolean,
  book: InBook | null = null,
): Permits {
  const stored = readRules(rules)
  const room = finished ? rulesAfterClass(stored) : stored
  const who: Asker = { role, participantId: book?.participantId ?? null }
  /*
   * The end of class is the FIRST factor, the same order as on the server
   * (db.ts · getRules): `rulesAfterClass` does not carry the notebook map
   * over, so after the bell `rulesForBook` finds no overrides and opens
   * nothing.
   */
  const read = rulesForBook(room, book?.root ?? null, who)
  const acts = actsAfterClass(finished, role)
  const refusedByBook = bookRefusal(room, book?.root ?? null, who)
  // One phrase instead of all the others: the rule that stopped the person does
  // not interest them now — what matters to them is that the class has ended.
  const why = (own: string): string => (acts ? own : tr(CLASS_IS_OVER))
  /*
   * When the NOTEBOOK closed it, the notebook speaks, not the room.
   *
   * "In this seminar the teacher types", said about someone else's personal
   * notebook, sends the person looking for a teacher who forbade nothing: the
   * notebook closed, and its author closed it. The same words the server
   * refuses with (collab/gate.ts · permits).
   */
  const whyHere = (own: string): string =>
    why(refusedByBook ? tr(refusedByBook.key, { p0: refusedByBook.name }) : own)
  const structure = (verb: 'add' | 'remove' | 'move'): boolean =>
    allowsStructure(read.structure, role, verb)
  return {
    rules: read,
    finished,
    role,
    bookWhy: acts && refusedByBook ? tr(refusedByBook.key, { p0: refusedByBook.name }) : null,
    bookRuled: (room.books?.[book?.root ?? '']?.access ?? 'room') !== 'room',
    edit: allows(read.edit, role),
    editWhy: whyHere(tr('room.ui.1092')),
    run: allowsRun(read.run, role, 'one'),
    // One phrase for three places — the cell button, "Run" above a file and the
    // terminal input line — and the same words the server refuses with
    // (control.ts, term:run): one rule, so one explanation.
    runWhy: whyHere(tr('room.ui.1093')),
    bulk: allowsRun(read.run, role, 'bulk'),
    bulkWhy: whyHere(
      read.run === 'single' && role !== 'host'
        ? tr('room.ui.1094')
        : tr('room.ui.1095'),
    ),
    add: structure('add'),
    remove: structure('remove'),
    move: structure('move'),
    structureWhy: whyHere(
      read.structure === 'add' && role !== 'host'
        ? tr('room.ui.1096')
        : tr('room.ui.1097'),
    ),
    wipe: allows(read.wipe, role),
    wipeWhy: why(tr('room.ui.1098')),
    restart: allows(read.restart, role),
    restartWhy: why(tr('room.ui.1099')),
    history: allows(read.history, role),
    files: allows(read.files, role),
    // One phrase for two places — the files panel and the strip above the
    // editor: "adds" does not fit where the talk is about editing, and "edits"
    // does not fit where it is about dragging.
    filesWhy: why(tr('room.ui.1100')),
    /*
     * The room's rules, not the notebook's: the question "may I start ONE
     * MORE" belongs to no notebook. The ceiling on own notebooks
     * (MAX_OWN_BOOKS) is counted by the server — over a map the browser may not
     * have in full; its refusal arrives as a line and is visible right where
     * the press happened.
     */
    ownBook: role === 'host' || (acts && room.ownBooks === 'on'),
    ownBookWhy: why(tr('room.ui.ownBooksOff')),
    agent: allowsAgent(read.agent, role),
    agentWhy: why(
      read.agent === 'off'
        ? tr('room.ui.1101')
        : tr('room.ui.1102'),
    ),
    board: allows(read.board, role),
    boardWhy: why(tr('room.ui.1103')),
    ask: acts,
    askWhy: tr(CLASS_IS_OVER),
    council: mayLeadCouncil(role),
    get councilWhy() { return tr('room.ui.1104') },
    attempt: mayWriteCouncil(role, finished, false),
    attemptWhy: tr(CLASS_IS_OVER),
  }
}

/* ---------------------------------------------------- the lock on a cell */

/**
 * One phrase for everything a closed cell says: the line under the code, the
 * hint on a dimmed button, the refusal on Cmd+Enter.
 *
 * Written about the class, not about the right: for a person who has just
 * pressed, what matters is not which field in the rules stopped them but that
 * the notebook is being led right now. The same argument as for
 * `CLASS_IS_OVER`.
 */
export const LECTURE_CELL = "Эту ячейку редактирует и запускает только преподаватель"
/**
 * The council's shared cell — not one's own.
 *
 * It holds the task, and the teacher edits it: rewriting it for oneself would
 * mean rewriting the task for the whole class. The participant's own sheet is
 * right next to it meanwhile, and it is entirely theirs.
 */
export const COUNCIL_SHARED_CELL = 'room.ui.1266'

/**
 * Rights that cannot be computed without the cell.
 *
 * Thin wrappers over `mayEditCell`/`mayRunCell` from shared/rules.ts — the
 * very ones the server answers with (gate.ts and control.ts). A component does
 * not combine the rule with the lock by itself: what is combined twice will
 * sooner or later come out differently, and it will not be two buttons that
 * diverge but a button and the server.
 *
 * `may.rules` here already has the end of class applied, and `finished` is
 * passed once more on purpose: the helper applies the same thing again, which
 * changes nothing, but the call then reads the same here and on the server.
 */
export function mayEditThisCell(may: Permits, open: boolean): boolean {
  return mayEditCell(may.rules, may.role, open, may.finished)
}

/** The same for running: in a lecture the teacher runs a closed cell. */
export function mayRunThisCell(may: Permits, open: boolean): boolean {
  return mayRunCell(may.rules, may.role, open, may.finished)
}

/**
 * One phrase for a closed council: the line under the attempt and the hint on
 * the dimmed "Submit". The student's text stays as a draft, and the phrase
 * must say so — otherwise it reads as "your work is gone".
 */
export const COUNCIL_CLOSED = "Консилиум закрыт. Ваш текст доступен в черновике"

/**
 * Council rights that cannot be computed without the cell — thin wrappers
 * over shared/rules.ts, the same ones the server answers with (control.ts ·
 * council:*).
 *
 * `closed` — no council is running on THIS cell (`cellLock(cell) !== 'council'`).
 */
export function mayWriteThisCouncil(may: Permits, closed: boolean): boolean {
  return mayWriteCouncil(may.role, may.finished, closed)
}

/** Run an attempt: the teacher — any, a student — their own and only with the knob on. */
export function mayRunThisCouncil(may: Permits, studentRun: boolean | 'request'): boolean {
  return mayRunCouncil(may.role, studentRun, may.finished)
}

/**
 * Whether the lock means anything at all in this room.
 *
 * The question is asked about the PARTICIPANT, not about whoever is looking:
 * the teacher may do anything under any lock, and "it changes nothing for me"
 * is the wrong answer to "is the lock worth drawing", since it is the teacher
 * who opens the cell.
 *
 * A room where a participant types and runs anyway shows no lock at all: an
 * icon that decides nothing is decoration, and decoration next to a rule
 * reads as a rule. For the same reason the lock disappears after the bell:
 * there is nothing left to open there, and `CLASS_IS_OVER` must be the one to
 * say so.
 */
export function cellLockMatters(may: Permits): boolean {
  const swings = (
    ask: (rules: RoomRules, role: ParticipantRole, open: boolean, finished: boolean) => boolean,
  ): boolean =>
    ask(may.rules, 'participant', true, may.finished) !==
    ask(may.rules, 'participant', false, may.finished)
  return swings(mayEditCell) || swings(mayRunCell)
}

export { HOSTS }
