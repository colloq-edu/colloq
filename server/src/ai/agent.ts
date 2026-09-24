import { tr, translate } from '@shared/i18n'
import { appendActivity } from '../activity.js'
import type { ActivityOutcome } from '@shared/activity'
/**
 * The oracle that does not answer but acts.
 *
 * An ordinary turn is a question and an answer: the model speaks in words, and
 * the hands stay with the person. Here the model itself reads the seminar
 * folder, edits files and runs scripts, and the room watches the feed of steps
 * while this happens.
 *
 * Four decisions that everything rests on.
 *
 * **Edits are applied at once, not proposed.** In "Ask" mode the oracle
 * proposes — a patch has an "accept" button; here it does not, and that is not
 * inconsistency. An agent has to look at its own error: wrote, ran, saw the
 * traceback, fixed. A mode where every edit waits for a click cannot do that —
 * it is not an agent but the same answer in a different wrapper. In exchange
 * there is a way back, and it differs for each: files get a snapshot from
 * before the turn and an undo button under the turn, the room's notebook gets a
 * mark in the version history, other notebooks get a copy of the file next to
 * them, because they have no history at all (see `safety`).
 *
 * **A notebook is edited by cells, not as a file.** The .ipynb file is a
 * projection: a write into it would come back a second and a half later and
 * vanish silently. So the notebook has its own tools, and they write into the
 * room's document — the same way a person writes, and on behalf of whoever
 * asked for the turn: by their rights (`edit`, `structure`, the lock on the
 * cell) and with their name on the version in the history. The oracle here is
 * the person's hands, not a separate party with rights of its own.
 *
 * **We do not forbid the bypass, we name it out loud.** `write_file` on a
 * notebook will refuse, but `run_file` with a Python script will not: this mode
 * is allowed to run scripts, and taking that away would take away half the
 * work. So we catch it not with a ban: a fingerprint of every notebook's file
 * is taken before a step and after it, and a file rewritten past the room is
 * named on the same step — to the model and in the turn's answer. Otherwise you
 * get exactly what this was written against: "cleared cells in the notebook",
 * while nothing in the notebook changed.
 *
 * **No streaming.** Tool arguments arrive in a stream as pieces of incomplete
 * JSON, and reassembling them has to be done differently for different
 * providers — exactly the dependence on a specific endpoint that this product
 * avoids. Progress is shown by the feed of steps, and "read src/model.py" is
 * more useful than half a sentence.
 *
 * **No deleting.** Neither a file nor a folder. Deleting in this product is a
 * teacher's right under any rules, and giving it to the model would mean giving
 * it what even the room does not have. It can empty a file — and that can be
 * undone.
 *
 * A cell is the exception, and it is paid for: `remove_cell` asks the same
 * `structure` rule as a person's hand, and what was there before the turn lies
 * either in the version history or in a copy of the file next to it. Every cell
 * has a way back — the whole difference is whether it is one button or manual
 * work.
 */
import { createHash } from 'node:crypto'
import type * as Y from 'yjs'
import {
  addStep,
  allBooks,
  allCellArrays,
  bookAt,
  bookCells,
  bookList,
  cellId,
  cellOutputs,
  cellSource,
  cellType,
  CELLS_KEY,
  chatAnswer,
  createCell,
  createChatEntry,
  DEFAULT_BOOK,
  findCell,
  findChatEntry,
  getChat,
  isCellOpen,
  replaceText,
  type AgentStep,
  type Book,
  type CellState,
  type CellType,
  type ChatState,
  type UndoState,
  type YCell,
  type YChatEntry,
} from '@shared/notebook'
import { baseOf, kindOf, normalizePath, parentOf, runnerFor } from '@shared/paths'
import {
  actsAfterClass,
  agentStepsIn,
  allows,
  allowsRun,
  allowsAgent,
  allowsStructure,
  bookRefusal,
  mayEditCell,
  rulesForBook,
  runQueueCap,
  CLASS_IS_OVER,
  type Asker,
  type RoomRules,
} from '@shared/rules'
import { applyOnBehalf, getSessionDoc, peekSessionDoc } from '../collab/index.js'
import { currentText, flushSessionFiles, putText } from '../collab/files.js'
import { bookText, createBook, isBookFile, projectBooks } from '../collab/books.js'
import { mark } from '../collab/history.js'
import { rememberDeleted } from '../collab/ops.js'
import { getRules, isFinished, onRulesChanged } from '../db.js'
import { MAX_TEXT_BYTES, freeName, listFiles, makeFile, readText, statPath } from '../workspace.js'
import {
  interruptTerminal,
  openTerminal,
  runCommand,
  dropPendingOf,
  terminalBusy,
  typedRunningCommand,
} from '../kernel/terminal.js'
import { cancelRun, requestRun } from '../kernel/index.js'
import { getOracleSettings } from '../admin/settings.js'
import { noteTokens } from '../admin/usage.js'
import { completeWithTools, type ChatTurn, type ToolSpec } from './provider.js'
import { cellsWord, describe as reason, effortNote, pad } from './text.js'
import type { ReasoningEffort } from '@shared/admin'
import { buildContext, renderOutputs } from './context.js'
import { recentTurns } from './index.js'

const ORIGIN = 'server'

/** What to tell the room about an error that has no words of its own: students read it. */
const WENT_WRONG = () => tr("server.private.wentWrong")

/** How long to wait for one run. Longer is not "slow" but "hung". */
const RUN_TIMEOUT_MS = 90_000

/**
 * How much of a file's text we give the model at a time — and why it is not
 * one number.
 *
 * It used to be sixty thousand characters — a ceiling taken for a big window.
 * The trouble is that what was read does not go away: it stays in the
 * conversation and is repeated in EVERY following step of the turn, many
 * times. One `read_file` was enough for an 8k-token window to overflow on the
 * second step, `completeWithTools` threw 400 and the turn broke off — while
 * the edits made before that already sat in the files, and there was nobody to
 * explain them.
 *
 * So the ceiling is counted from `contextChars`: a quarter of the budget the
 * teacher set for their model. A quarter so that three more such reads fit
 * into the same conversation, and after that `budgetTools` cleans them up.
 * With an instance ceiling of 100 000 that is up to 25 000 characters at a
 * time; with the default of 20 000, five thousand, that is, a hundred and
 * thirty lines: about as much as people read by eye when they ask "why does it
 * fail here".
 */
const MIN_READ = 12_000

function maxRead(): number {
  return Math.max(MIN_READ, Math.floor(getOracleSettings().contextChars / 2))
}

/** Read text up to the ceiling; the cut is stated so the model does not make up the end. */
function clipRead(text: string): string {
  const room = maxRead()
  return text.length > room ? text.slice(0, room) + tr("server.truncated.fdb0c3") : text
}

/**
 * How many characters of conversation the turn carries with it — separately
 * from the frame.
 *
 * `contextChars` is the budget of the FRAME: notebooks, files, cell output,
 * everything `buildContext` packs into one system block. Tool replies were
 * counted with the same number, and so one and the same number stood in two
 * places and meant different things: with a ceiling of 20 000 the frame ate
 * twenty thousand and the tool replies another twenty, and "stayed within the
 * budget" was untrue by a factor of two. Here it is named with its own number:
 * the conversation lives longer than the frame (every step of the turn reads
 * it in a row), so its budget is twice as large, and the turn's overall bound
 * is three `contextChars`, not two of who knows what.
 */
function toolChars(): number {
  return getOracleSettings().contextChars * 2
}

/**
 * A piece of text by lines — and words about what is left.
 *
 * The read ceiling used to be one per file: "the first N characters, the rest
 * truncated", and beyond that the model had no road at all — it either wrote
 * the end of the file itself or called `read_file` again and got the same
 * beginning. Pages are cheaper than a big ceiling: eight hundred lines of a log
 * cost one step of a hundred lines where the tail is needed, not the whole
 * file.
 */
interface Page {
  /** What goes to the model. */
  text: string
  /** A line for the feed of steps. */
  note: string
  /** What was shown and how to get the rest; empty when everything was shown. */
  rest: string
}

function pageOfLines(text: string, args: Record<string, unknown>, path: string): Page {
  const lines = text.split('\n')
  const total = lines.length
  const room = maxRead()
  const asked = intArg(args.offset, 0)
  const wanted = intArg(args.limit, 0)
  /*
   * A negative offset counts from the end.
   *
   * That is how exactly one thing is read: the tail of a log and the tail of a
   * traceback, that is, the place where the breakage lies. Without it the model
   * read the file from the start page by page to the end — six steps of the
   * turn for the last thirty lines.
   */
  const from = asked < 0 ? Math.max(0, total + asked) : Math.min(Math.max(0, asked), total)
  let to = wanted > 0 ? Math.min(total, from + wanted) : total
  /*
   * We cut by lines, not by characters: half a line in the answer is a line the
   * model will finish by guesswork and get wrong, and `edit_file`'s `find` will
   * silently miss it.
   */
  let used = 0
  let kept = 0
  for (let i = from; i < to; i++) {
    used += lines[i].length + 1
    if (used > room && kept > 0) break
    kept += 1
  }
  to = from + kept
  /*
   * And a hard ceiling by characters on top of the lines.
   *
   * One line always stays, otherwise a page can be empty — and one line can be
   * two hundred kilobytes: JSON collapsed into a line, a dataset on one line, a
   * minified file. Without this cut such a file would slip past any budget and
   * overflow the window on the very first step. The cut is stated out loud — in
   * the same words as before.
   */
  const page = lines.slice(from, to).join('\n')
  const shown = page.length > room ? page.slice(0, room) + tr("server.truncated.fdb0c3") : page
  const note = tr('server.agent.linesShown', { p0: from + 1, p1: to, p2: total })
  return {
    text: shown,
    note,
    rest:
      to >= total
        ? from > 0
          ? `\n\n[${note}]`
          : ''
        : `\n\n[${note}; ${tr('server.agent.linesRest', { p0: path, p1: to })}]`,
  }
}

function intArg(value: unknown, fallback: number): number {
  if (typeof value === 'number' && Number.isFinite(value)) return Math.trunc(value)
  // Models send numbers as strings more often than one would like: refusing
  // "offset": "130" means spending a turn step on parsing quotes.
  if (typeof value === 'string' && value.trim() && Number.isFinite(Number(value))) {
    return Math.trunc(Number(value))
  }
  return fallback
}

/**
 * Fit the turn's conversation into the model's window.
 *
 * The frame (`buildContext`) fits into `contextChars`, but tool replies do not:
 * they pile up step by step and go to the provider in full on every step. So
 * the excess has to be removed from the conversation — the only question is
 * how exactly.
 *
 * WHOLE batches are removed from the start, not contents in the middle. The old
 * code rewrote the i-th message into a single line "(contents omitted)", and
 * that broke two things at once. The first is the prompt cache: on every
 * endpoint that supports it, it is keyed by prefix, and an edit in the middle
 * of the conversation invalidates the whole tail after it, in a new place on
 * every step; a turn of twenty steps paid the full price twenty times. The
 * second is the shape of the request: the tool reply was emptied while the
 * call it answers remained, so the model saw its call without an answer and
 * called the same thing again. A batch goes together with its call — the
 * conversation stays coherent, and every surviving message has exactly the
 * same text it had.
 *
 * The last batch is never touched: it is exactly what the model just asked
 * for, and without it the turn would go in circles. Refusals are not touched
 * either — see `keep`: a rule the turn has learned ("that is not allowed, do it
 * differently") is worth more than a file that was read, because a forgotten
 * refusal is one the model breaks again.
 */
const OMITTED =
  () => tr("server.private.omitted")

function budgetTools(messages: ChatTurn[], budget: number, keep: ReadonlySet<string>): void {
  const weigh = (): number =>
    messages.reduce(
      (sum, turn) =>
        sum + (turn.callId !== undefined || (turn.calls?.length ?? 0) > 0 ? turn.content.length : 0),
      0,
    )
  let used = weigh()
  if (used <= budget) return
  // One marker for the whole conversation: two in a row say the same thing and cost space.
  let marked = messages.some(
    (turn) => turn.callId === undefined && !turn.calls && turn.content === OMITTED(),
  )
  let i = 0
  while (i < messages.length && used > budget) {
    const turn = messages[i]
    if (!turn.calls || turn.calls.length === 0) {
      i += 1
      continue
    }
    const ids = new Set(turn.calls.map((call) => call.id))
    let end = i + 1
    while (end < messages.length && messages[end].callId && ids.has(messages[end].callId!)) end += 1
    // A batch that reaches the end of the conversation is the last one: we leave it alone.
    if (end >= messages.length) break
    if (turn.calls.some((call) => keep.has(call.id))) {
      i = end
      continue
    }
    let freed = turn.content.length
    for (let j = i + 1; j < end; j++) freed += messages[j].content.length
    messages.splice(
      i,
      end - i,
      ...(marked ? [] : [{ role: 'user' as const, content: OMITTED() }]),
    )
    marked = true
    used -= freed
  }
}

/**
 * How many entries of the room's thread a turn takes — and why fewer than a
 * question takes.
 *
 * The thread (`recentTurns`) was not counted at all: it was put into the
 * conversation whole and lived there for all twenty steps of the turn, next to
 * the tool replies that the budget is already fighting over. A turn needs it
 * less than a question does: a question continues a conversation, while a
 * turn gets a task and works on the notebook that is right in front of it in
 * the frame. The last three exchanges are "how we got here"; beyond that is
 * someone else's walkthrough from a week ago.
 */
const THREAD_TURNS_IN_WORK = 3

function threadForWork(history: ChatTurn[]): ChatTurn[] {
  const room = Math.max(500, Math.floor(getOracleSettings().contextChars / 8))
  return history
    .slice(-THREAD_TURNS_IN_WORK * 2)
    .map((turn) =>
      turn.content.length > room
        ? { ...turn, content: turn.content.slice(0, room) + tr("server.truncated.fdb0c3") }
        : turn,
    )
}

/** How much of the output's tail we put into the feed of steps and give the model. */
const MAX_OUTPUT = 4_000

/**
 * How many lines of the file tree go to the model.
 *
 * `listFiles` holds two thousand lines — that is the ceiling for the panel,
 * which draws the tree once. Here the list goes into the conversation and is
 * repeated in EVERY following step of the turn, many times: an unpacked
 * dataset would cost more than all the rest of the work and would overflow a
 * small model's window on the third step. Each folder sends its beginning, and
 * the rest is stated as a number.
 */
const MAX_TREE_LINES = 200
const MAX_PER_DIR = 20

/* ----------------------------------------------------------------- undo */

/** What a file was like before the turn and how the turn left it. */
interface Snapshot {
  /** Text before the turn. `null` means there was no file: undo will empty it. */
  was: string | null
  /**
   * The text the turn finished with.
   *
   * Thanks to this field undo stopped being blind: if the file now holds
   * something else, a person edited the file after the turn — and "put it back
   * as it was" would erase their work. `null` means the write failed, and there
   * is nothing to put back.
   */
  left: string | null
}

/**
 * What was in the files before the turn — so there is somewhere to go back to.
 *
 * In process memory, not in the database, and that is a named price: a server
 * restart takes the ability to undo along with the run queue and the shared
 * screen. A turn that was already looked at and kept does not suffer from
 * this; the one who suffers is whoever went for tea exactly at the moment of
 * the restart.
 */
const before = new Map<string, Map<string, Snapshot>>()

/** Turns per room; beyond that the oldest are forgotten. */
const MAX_REMEMBERED_TURNS = 20

function remember(sessionId: string, entryId: string, path: string, text: string | null): void {
  const key = `${sessionId}\u0000${entryId}`
  let files = before.get(key)
  if (!files) {
    files = new Map()
    before.set(key, files)
    const mine = [...before.keys()].filter((other) => other.startsWith(`${sessionId}\u0000`))
    while (mine.length > MAX_REMEMBERED_TURNS) before.delete(mine.shift()!)
  }
  // Only the first time: undo has to go back to what was there BEFORE the
  // turn, not before the last of its edits.
  if (!files.has(path)) files.set(path, { was: text, left: null })
}

/** What the turn left this file with — undo checks against this. */
function leftBehind(sessionId: string, entryId: string, path: string, text: string): void {
  const seen = before.get(`${sessionId}\u0000${entryId}`)?.get(path)
  if (seen) seen.left = text
}

/**
 * Return the files to what they were before the turn.
 *
 * Returns the number of files touched, or `null` if there is nothing to put
 * back — for example, the server was restarted.
 *
 * Only files that nobody has touched since the turn are put back. The button
 * lives in the thread until the end of the class, and an hour-old turn would
 * otherwise overwrite everything the person wrote after it — silently and
 * irreversibly: files in the working folder have no version history. Next
 * door, for a cell proposal, exactly this check exists and is called by the
 * same word: changed since.
 */
export function undoTurn(sessionId: string, entryId: string, by: string): number | null {
  const key = `${sessionId}\u0000${entryId}`
  const files = before.get(key)
  const doc = peekSessionDoc(sessionId)?.doc
  const entry = doc ? findChatEntry(doc, entryId) : null
  if (!files || !doc || !entry) return null
  if ((entry.get('undo') as UndoState) !== 'available') return null
  let touched = 0
  const skipped: string[] = []
  const failed: string[] = []
  for (const [path, snapshot] of files) {
    /*
     * `null` means the file is no longer at this path: it was renamed or
     * removed. Then there is nothing to put back and no reason to: a write
     * would create a ghost next to the real file, and if a new one was already
     * created under the old name, it would erase it. Someone else's text in
     * place of ours means the same thing: the file was edited after the turn,
     * and undo would erase that edit.
     */
    const now = currentText(sessionId, path)
    if (now === null || snapshot.left === null || now !== snapshot.left) {
      skipped.push(path)
      files.delete(path)
      continue
    }
    // There was no file before the turn: the oracle created it. Removing it
    // entirely is not our right (deleting in this room is the teacher's and
    // goes through the tree), so it stays empty — and that is visible.
    if (!putText(sessionId, path, snapshot.was ?? '')) {
      failed.push(path)
      continue
    }
    files.delete(path)
    touched += 1
  }
  if (files.size === 0) before.delete(key)
  doc.transact(() => {
    if (skipped.length > 0) {
      // The thread says "the files are back to what they were"; about the ones
      // that did not come back we have to say it here, or the caption under
      // the turn will lie.
      const answer = chatAnswer(entry)
      answer.insert(
        answer.length,
        tr("server.notRestored.7d302f", { p0: answer.length > 0 ? '\n\n' : '', p1: skipped.join(', ') }) +
          tr("server.theFilesWereChangedOrDeletedAfter.0aad9d"),
      )
    }
    if (failed.length > 0) {
      const answer = chatAnswer(entry)
      answer.insert(answer.length, `\n\n${tr("server.couldNotCompleteTheActionTryAgain.234540")} (${failed.join(', ')})`)
    }
    entry.set('undo', (failed.length > 0 ? 'available' : 'done') as UndoState)
    if (failed.length === 0) entry.set('undoBy', by)
  }, ORIGIN)
  return touched
}

/**
 * The room is no longer in memory — nothing to remember and nobody to work
 * for.
 *
 * Called from `dropSessionDoc`, which is all about making deletion final. A
 * running turn is aborted right here: without that it would spend another
 * dozen steps writing files and starting up the container of a room that no
 * longer exists.
 *
 * The second caller is `evictRoom` in `collab/index.ts`, and there the room was
 * not deleted but released from memory after ten minutes of emptiness: the "as
 * it was before the turn" snapshot goes with it, so the button in the thread
 * stays, but there is nothing left to undo — the refusal for it is written in
 * words in `ai:undo` (`control.ts`).
 */
export function forgetUndo(sessionId: string): void {
  for (const key of [...before.keys()]) {
    if (key.startsWith(`${sessionId}\u0000`)) before.delete(key)
  }
  for (const key of [...inBook.keys()]) {
    if (key.startsWith(`${sessionId}\u0000`)) inBook.delete(key)
  }
  stopAll(sessionId)
}

/* ------------------------------------------------------------ tools */

/**
 * Tools — as a list built for every turn.
 *
 * Not a constant: the descriptions go to the model, and the instance language
 * changes on the fly (`tr` reads it on every call). A constant computed at
 * import would hold the language that was set when the server started — the
 * very mismatch that gave an English instance Russian hints.
 */
function fileTools(): ToolSpec[] {
  return [
    {
      name: 'list_files',
      description: tr('server.agent.tool.listFiles'),
      parameters: { type: 'object', properties: {}, required: [] },
    },
    {
      name: 'read_file',
      description: tr('server.agent.tool.readFile'),
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: tr('server.agent.arg.path') },
          offset: { type: 'integer', description: tr('server.agent.arg.offset') },
          limit: { type: 'integer', description: tr('server.agent.arg.limit') },
        },
        required: ['path'],
      },
    },
    {
      name: 'write_file',
      description: tr('server.agent.tool.writeFile'),
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string' },
          content: { type: 'string' },
        },
        required: ['path', 'content'],
      },
    },
    {
      name: 'edit_file',
      description: tr('server.agent.tool.editFile'),
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string' },
          find: { type: 'string', description: tr('server.agent.arg.find') },
          replace: { type: 'string', description: tr('server.agent.arg.replace') },
        },
        required: ['path', 'find', 'replace'],
      },
    },
    {
      name: 'run_file',
      description: tr('server.agent.tool.runFile'),
      parameters: {
        type: 'object',
        properties: { path: { type: 'string' } },
        required: ['path'],
      },
    },
  ]
}

/**
 * Cell tools — the ones that edit the notebook.
 *
 * A separate list, because not everyone gets them: they go to whoever may edit
 * the notebook with their own hands in this room. A participant in a lecture
 * does not see them at all — offering a tool that will answer with a refusal
 * means spending a turn step on learning a rule known in advance.
 */
function cellTools(): ToolSpec[] {
  return [
    {
      name: 'edit_cell',
      description: tr('server.agent.tool.editCell'),
      parameters: {
        type: 'object',
        properties: {
          cellId: { type: 'string', description: tr('server.agent.arg.cellId') },
          source: { type: 'string', description: tr('server.agent.arg.source') },
        },
        required: ['cellId', 'source'],
      },
    },
    {
      name: 'add_cell',
      description: tr('server.agent.tool.addCell'),
      parameters: {
        type: 'object',
        properties: {
          after: { type: 'string', description: tr('server.agent.arg.after') },
          path: { type: 'string', description: tr('server.agent.arg.bookPath') },
          type: { type: 'string', enum: ['code', 'markdown'] },
          source: { type: 'string' },
        },
        required: ['type', 'source'],
      },
    },
    {
      name: 'remove_cell',
      description: tr('server.agent.tool.removeCell'),
      parameters: {
        type: 'object',
        properties: { cellId: { type: 'string' } },
        required: ['cellId'],
      },
    },
  ]
}

/**
 * Create a notebook.
 *
 * What this tool was written for did not exist in the mode at all: someone
 * asked to "make the simplest notebook", and there was nothing to create it
 * with. The model did the only thing left — wrote an .ipynb through
 * `write_file`, got a quiet success (the file did get written) and then ran
 * into `add_cell`, which knows nothing about that file: a room notebook is an
 * entry in the document, not JSON on disk. One call closes this whole dead end.
 *
 * The right is not one but two, and the person next door already has both:
 * `files` (create a file) and `structure` with the `add` measure (add to the
 * notebook). There is no point in creating a notebook that cells cannot then
 * be added to.
 */
function createNotebookTool(): ToolSpec {
  return {
    name: 'create_notebook',
    description: tr('server.agent.tool.createNotebook'),
    parameters: {
      type: 'object',
      properties: { path: { type: 'string', description: tr('server.agent.arg.newBookPath') } },
      required: ['path'],
    },
  }
}

/**
 * Run one cell and see what came of it.
 *
 * Without it the turn had no way to check the notebook's code: `run_file` runs
 * a script, and a model told to "run it and make sure" rewrote the notebook's
 * code into a .py — that is, made a second copy of the same code, checked it
 * and reported on the notebook. The cell is put into the same queue the same
 * way a person puts it with the Run button: on behalf of the asker, by their
 * `run` rule, with their place in the queue.
 */
function runCellTool(): ToolSpec {
  return {
    name: 'run_cell',
    description: tr('server.agent.tool.runCell'),
    parameters: {
      type: 'object',
      properties: { cell: { type: 'string', description: tr('server.agent.arg.cellId') } },
      required: ['cell'],
    },
  }
}

/** Reading notebooks: for anyone given a turn at all — the room sees the notebook anyway. */
function readNotebookTool(): ToolSpec {
  return {
    name: 'read_notebook',
    description: tr('server.agent.tool.readNotebook'),
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: tr('server.agent.arg.bookPath') },
        from: { type: 'integer', description: tr('server.agent.arg.from') },
        count: { type: 'integer', description: tr('server.agent.arg.count') },
        outputs: { type: 'boolean', description: tr('server.agent.arg.outputs') },
      },
      required: [],
    },
  }
}

/**
 * What this person works with in this turn.
 *
 * Computed once per turn, not per step: the rules can change in the middle of
 * the work, and for that case every tool asks for them again on its own — the
 * list is for the model, not for checking.
 *
 * Exported for the test: "a participant in a lecture sees no tools" is about
 * the list, and there is no way to check it other than asking.
 */
export function toolsFor(hands: Hands): ToolSpec[] {
  const doc = peekSessionDoc(hands.sessionId)?.doc
  const rights = doc ? anyCellRights(hands, doc) : { edit: false, add: false, remove: false }
  const cells = cellTools().filter((tool) =>
    tool.name === 'edit_cell' ? rights.edit : tool.name === 'add_cell' ? rights.add : rights.remove,
  )
  /*
   * Files and running — by the same room rules as the asker's own fingers.
   *
   * The list is cut for the same reason as with cells: a tool that will answer
   * with a refusal costs a turn step spent learning a rule known in advance.
   * Looking is always allowed — `list_files` and `read_file` edit nothing, and
   * the `files` rule in this product is about writing.
   */
  const rules: RoomRules = getRules(hands.sessionId)
  const mayWrite = allows(rules.files, hands.role)
  // Running a cell — "anywhere at all": one's own notebook runs even in a
  // lecture. Running a FILE stays at room level: a script from the tree is the
  // room's kernel, not somebody's notebook, and a personal notebook does not
  // open it.
  const mayRun = allowsRun(rules.run, hands.role, 'one')
  const mayRunCells = mayRunAnyBook(hands, doc)
  const files = fileTools().filter((tool) =>
    tool.name === 'write_file' || tool.name === 'edit_file'
      ? mayWrite
      : tool.name === 'run_file'
        ? mayRun
        : true,
  )
  return [
    ...files,
    // Creating a notebook is both a file and structure: without the second
    // right the new notebook would stay empty forever.
    ...(mayWrite && rights.add ? [createNotebookTool()] : []),
    readNotebookTool(),
    ...(mayRunCells ? [runCellTool()] : []),
    ...cells,
  ]
}

export interface Ran {
  /** What to show in the feed of steps. */
  step: AgentStep
  /** What to tell the model. */
  said: string
  /**
   * The tool refused or failed.
   *
   * Needed in exactly one place — `budgetTools`: a refusal is not thrown out of
   * the conversation. The model will re-read a file it read in one step, but a
   * forgotten rule ("a notebook is not edited as a file") it will break again —
   * and spend on it not a step but the whole rest of the turn, twice in a row.
   */
  failed?: boolean
  /**
   * One more step in the feed — next to the first, not instead of it.
   *
   * Needed in two places, and in both for one reason: a step has what the tool
   * DID and what happened past it along the way. "Ran train.py, exit code 0"
   * and "the script wiped data.csv" are two different lines in the feed, and
   * glued into one they read as a detail of the run rather than as the thing
   * this check was written for.
   */
  also?: AgentStep
}

export interface Hands {
  sessionId: string
  entryId: string
  by: { name: string; color: string; participantId: string }
  /**
   * The role of whoever asked for the turn — the same one they press buttons
   * with themselves.
   *
   * Comes from the route rather than being asked of the database: the table
   * holds the role the person entered the room with, while they act with the
   * EFFECTIVE one (see `roleFor` in routes/sessions.ts). A teacher who opened
   * their own lecture from a link in a chat is a participant in the table — and
   * their own notebook would turn out to be someone else's for their own
   * oracle.
   */
  role: 'host' | 'participant'
}

/**
 * Run one tool — and check whether it rewrote a notebook past the room.
 *
 * Exported for the test: all the boundaries of the "Act" mode live here — what
 * is allowed, what is not and what to say when it is not — and checking them
 * through a live model would mean checking the model.
 *
 * `signal` is needed by one tool: a run takes minutes, and "Stop" in the
 * middle of it must stop the script, not only the loop of steps.
 */
export async function useTool(
  hands: Hands,
  name: string,
  rawArgs: string,
  signal?: AbortSignal,
): Promise<Ran> {
  const prints = bookPrints(hands.sessionId)
  const ran = await runTool(hands, name, rawArgs, signal)
  const faked = rewrittenBooks(hands.sessionId, prints)
  if (faked.length === 0) return ran
  const work = bookWork(hands)
  for (const path of faked) work.faked.add(path)
  // In addition to what the tool already said, not instead of it: the script
  // may well have computed something useful, and the model needs its output —
  // only the part about the notebook is untrue.
  return {
    step: ran.step,
    said: `${ran.said}\n\n${sayFaked(faked)}`,
    failed: ran.failed,
    also: ran.also ?? note(tr('server.agent.rewrotePastTheRoom'), faked.join(', ')),
  }
}

async function runTool(
  hands: Hands,
  name: string,
  rawArgs: string,
  signal?: AbortSignal,
): Promise<Ran> {
  if (signal?.aborted || !allowsAgent(getRules(hands.sessionId).agent, hands.role)) {
    const said = !actsAfterClass(isFinished(hands.sessionId), hands.role)
      ? tr(CLASS_IS_OVER)
      : getRules(hands.sessionId).agent === 'host'
        ? tr("server.onlyTheTeacherMayAskTheOracle.441f53")
        : tr("server.oracleFileEditingIsDisabledInThis.9b1999")
    return { step: note(said, name), failed: true, said }
  }
  const known = toolsFor(hands)
  let args: Record<string, unknown> = {}
  try {
    args = JSON.parse(rawArgs || '{}') as Record<string, unknown>
  } catch {
    /*
     * With the schema, not just "retry".
     *
     * "The arguments did not come as JSON" is a dead end: the model does not
     * know what exactly is wrong with its JSON and sends the same one again.
     * The schema in the reply is the same thing it got in the tool
     * description, but here and now, next to the refusal; small models fix
     * themselves from this point on the first try.
     */
    const spec = known.find((tool) => tool.name === name)
    return {
      step: note(tr("server.couldNotReadTheArguments.375da2"), name),
      failed: true,
      said: spec
        ? tr('server.agent.badJsonArgs', { p0: name, p1: JSON.stringify(spec.parameters) })
        : tr("server.theArgumentsAreNotValidJsonRetry.a91ada"),
    }
  }
  /*
   * The tool name — before anything else.
   *
   * A miss in the name (`readNotebook` instead of `read_notebook`) reached the
   * path check and got "such a path is impossible in this room": a refusal
   * about the path for a call that has no path at all. The model fixed the
   * path, missed the name again and spent turn steps on it.
   */
  if (!ALL_TOOLS.has(name)) return unknownTool(name, known)
  const wanted = typeof args.path === 'string' ? normalizePath(args.path) : null

  if (name === 'list_files') {
    return {
      step: { kind: 'read', target: tr("server.seminarFolder.8c9abd"), added: 0, removed: 0, exit: null, note: '' },
      said: describeTree(hands.sessionId),
    }
  }

  // Before the file path check: in a notebook a cell is addressed by name, and
  // the path, if there is one, is optional.
  if (
    name === 'read_notebook' ||
    name === 'edit_cell' ||
    name === 'add_cell' ||
    name === 'remove_cell'
  ) {
    return useCellTool(hands, name, args)
  }

  if (name === 'run_cell') return runCell(hands, args, signal)

  if (!wanted) {
    return {
      step: note(tr("server.invalidPath.4b91a9"), typeof args.path === 'string' ? args.path : '—'),
      failed: true,
      said: tr("server.thisPathIsNotAllowedPathsAre.47da6e"),
    }
  }

  if (name === 'create_notebook') return createNotebook(hands, wanted)

  if (name === 'read_file') {
    // For a notebook the truth is in the room and the file lags a second: read the room.
    const text = bookText(hands.sessionId, wanted) ?? currentText(hands.sessionId, wanted)
    if (text === null) {
      /*
       * `currentText` stays equally silent about three different cases, and
       * they tell the model different things. "No such file" in place of a
       * six-megabyte dataset is an invitation to create it anew, that is,
       * exactly the loss of the tail that the ceiling was set up against. So a
       * large file is spoken of separately — and its beginning is shown after
       * all: it tells what kind of file it is, and editing it is not possible
       * anyway.
       */
      const disk = readText(hands.sessionId, wanted)
      if (disk?.binary) {
        return {
          step: note(tr("server.notATextFile.51f9b2"), wanted),
          failed: true,
          said: tr("server.isNotATextFileAndCannot.e4e032", { p0: wanted }),
        }
      }
      if (disk?.truncated) {
        const head = pageOfLines(disk.text, args, wanted)
        return {
          step: {
            kind: 'read',
            target: wanted,
            added: 0,
            removed: 0,
            exit: null,
            note: tr("server.onlyTheBeginning.cac2a9"),
          },
          said: tr("server.theRestWasNotRead.2d3e0c", { p0: head.text, p1: tooBig(wanted) }),
        }
      }
      return {
        step: note(tr("server.nothingToRead.8741a9"), wanted),
        failed: true,
        said: tr("server.doesNotExistOrIsNotA.e25c4a", { p0: wanted }),
      }
    }
    const page = pageOfLines(text, args, wanted)
    return {
      step: {
        kind: 'read',
        target: wanted,
        added: 0,
        removed: 0,
        exit: null,
        note: page.note,
      },
      said: page.text + page.rest,
    }
  }

  if (name === 'write_file' || name === 'edit_file') {
    /*
     * The `files` rule — here too.
     *
     * The header of this file promises that a turn edits "by the rights of
     * whoever asked", and for cells that held (`rightsFor`, `mayEditCell`), but
     * for files it did not: entry into the mode was opened by `agent` alone,
     * and a participant in a lecture with `files: 'host'` wrote any file of the
     * seminar folder through the oracle. A room rule that one button bypasses
     * is not a rule.
     */
    if (!allows(getRules(hands.sessionId).files, hands.role)) {
      return {
        step: note(tr("server.onlyTheTeacherMayEditFilesHere.7af6f1"), wanted),
        failed: true,
        said: refuseCells(
          hands,
          tr("server.onlyTheTeacherMayEditFilesIn.067d2a", { p0: wanted }) +
            tr("server.explainWhatShouldBeChangedInIt.b5147e"),
        ),
      }
    }
    /*
     * A notebook is not a text file, whatever its extension says.
     *
     * The refusal checks the EXTENSION, not the room's list of notebooks. It
     * used to check the list (`isBookFile`), and that was a hole in exactly the
     * place it was written for: the notebook is NOT YET in the room, so the
     * path is not on the list, so the write is allowed — and `write_file` with
     * a ready-made .ipynb answered "done". The file landed on disk, the room
     * knew nothing about it, `add_cell` on it refused with "not a notebook of
     * this room", and the turn ran into a wall it had built itself. Now an
     * .ipynb is never written as a file: a known notebook is edited by cells,
     * an unknown one is created with `create_notebook`.
     */
    if (kindOf(wanted) === 'notebook') {
      const doc = peekSessionDoc(hands.sessionId)?.doc
      const rights = doc ? anyCellRights(hands, doc) : null
      const mine = isBookFile(hands.sessionId, wanted)
      const mayEditCells = Boolean(rights && (rights.edit || rights.add || rights.remove))
      return {
        step: note(tr("server.thisIsARoomNotebook.50864d"), wanted),
        failed: true,
        said: mine
          ? tr("server.isARoomNotebookItsCellsLive.c322d1", { p0: wanted }) +
            tr("server.soOverwritingItWouldBeLostShortly.f6c799") +
            tr("server.theRoomDoesNotReadChangesFrom.df48b1") +
            (mayEditCells
              ? tr("server.editTheCellsUseReadNotebookThen.e64989")
              : tr("server.youCanViewItWithReadNotebook.a0da1e") +
                tr("server.isNotAllowedForYouExplainWhat.1333b4"))
          : tr('server.agent.notebookIsNotAFile', { p0: wanted }) +
            (mayEditCells && allowsStructure(getRules(hands.sessionId).structure, hands.role, 'add')
              ? tr('server.agent.useCreateNotebook', { p0: wanted })
              : tr('server.agent.askTeacherForNotebook')),
      }
    }
    const existed = statPath(hands.sessionId, wanted) !== null
    /*
     * A file the editor does not take, the oracle does not take either.
     *
     * `currentText` returns the first megabyte and a half of a large file as
     * its whole text, and writing a truncated copy over the whole is a lost
     * tail nobody will learn about: no exit code, no line in the feed, no way
     * back (undo would put back the same truncated copy). Exactly this ceiling
     * applies to a person too — `isEditable`, and above `MAX_TEXT_BYTES` it is
     * described in the same words. A binary file is the same story:
     * `write_file` would overwrite it with text.
     */
    const disk = existed ? readText(hands.sessionId, wanted) : null
    if (existed && (!disk || disk.binary || disk.truncated)) {
      return {
        step: note(disk?.truncated ? tr("server.fileTooLarge.83ae5f") : tr("server.notATextFile.51f9b2"), wanted),
        said: disk?.truncated
          ? tooBig(wanted)
          : tr("server.isNotATextFileAndCannot.c00c49", { p0: wanted }),
      }
    }
    const was = currentText(hands.sessionId, wanted)
    /*
     * The file is there but has no text: between two reads it stopped being
     * editable — the kernel appended a log to it, a pickle landed on top.
     * Writing `null` into the snapshot would tell undo that the file did not
     * exist before the turn, and it would empty someone else's file instead of
     * restoring it.
     */
    if (existed && was === null) {
      return {
        step: note(tr("server.theFileChangedDuringTheOperation.ea0571"), wanted),
        said:
          tr("server.canNoLongerBeReadInFull.90290a", { p0: wanted }) +
          tr("server.readItAgainOrExplainWhatShould.5109a7"),
      }
    }
    let next: string
    if (name === 'write_file') {
      if (typeof args.content !== 'string') {
        return { step: note(tr("server.nothingToWrite.bee7a2"), wanted), said: tr("server.contentMustBeAString.4670e8") }
      }
      next = args.content
    } else {
      if (was === null) {
        return {
          step: note(tr("server.nothingToEdit.1a3cb2"), wanted),
          said: tr("server.doesNotExistOrIsNotA.e25c4a", { p0: wanted }),
        }
      }
      const find = typeof args.find === 'string' ? args.find : ''
      const replace = typeof args.replace === 'string' ? args.replace : ''
      if (!find) {
        return { step: note(tr("server.emptySearch.b04728"), wanted), said: tr("server.findCannotBeEmpty.7314f5") }
      }
      const first = was.indexOf(find)
      if (first === -1) {
        return {
          step: note(tr("server.textNotFound.0daf2b"), wanted),
          said: tr("server.thatTextIsNotInReadThe.0f7d35", { p0: wanted }),
        }
      }
      if (was.indexOf(find, first + 1) !== -1) {
        return {
          step: note(tr("server.textAppearsMoreThanOnce.cb7a0e"), wanted),
          said:
            tr("server.thatTextAppearsMoreThanOnceIn.3d90f9", { p0: wanted }) +
            tr("server.useALongerMatchingFragment.48a5a8"),
        }
      }
      next = was.slice(0, first) + replace + was.slice(first + find.length)
    }

    /*
     * What does not open, the oracle does not write itself either. A file over
     * the ceiling will be taken neither by the editor nor by the next step of
     * this same turn, and saving the open document will fail silently — after
     * "done" has already been written in the feed.
     */
    if (next.length > MAX_TEXT_BYTES) {
      return {
        step: note(tr("server.tooMuchContentToSave.c88960"), wanted),
        said:
          tr("server.cannotWriteMoreThanMbToThe.236b64", { p0: wanted }) +
          tr("server.editReduceItsSizeOrWriteIt.287901"),
      }
    }

    /*
     * A write can also THROW rather than return `false`: something other than
     * a folder turned up under the path, the disk refused, permissions changed.
     * Before, such an error flew out of the tool and brought down the whole
     * turn — instead of a "could not write" step after which the model can say
     * so in words and carry on.
     */
    let wrote = false
    try {
      wrote = putText(hands.sessionId, wanted, next)
    } catch (err) {
      console.error(`[session ${hands.sessionId}] could not write ${wanted}:`, reason(err, WENT_WRONG()))
    }
    if (!wrote) {
      /*
       * A refusal comes in two kinds. A file that crossed the ceiling while we
       * were reading it cannot be edited at all — and there is no point in
       * retrying; everything else ("the file is gone", "the disk refused") is
       * worth the model trying another way.
       */
      const now = statPath(hands.sessionId, wanted)
      const over = now !== null && !now.dir && now.size > MAX_TEXT_BYTES
      return {
        step: note(over ? tr("server.fileTooLarge.83ae5f") : tr("server.couldNotWrite.610d26"), wanted),
        said: over ? tooBig(wanted) : tr("server.couldNotWrite.09a8f1", { p0: wanted }),
      }
    }
    /*
     * The snapshot comes AFTER a successful write, not before it.
     *
     * `was` was read above, before any write, so what is remembered is still
     * what was there before the turn. The order matters for something else: a
     * snapshot taken before `putText` stayed around even when the write failed
     * — the disk refused, the ceiling moved — and a turn that touched not a
     * single file got an "undo" button, and pressing it answered "did not
     * touch: X — the file was changed or removed after this turn". Nobody
     * touched the file, and the turn changed nothing.
     */
    remember(hands.sessionId, hands.entryId, wanted, was)
    leftBehind(hands.sessionId, hands.entryId, wanted, next)
    const counts = countChanges(was ?? '', next)
    return {
      step: {
        kind: existed ? 'write' : 'new',
        target: wanted,
        added: counts.added,
        removed: counts.removed,
        exit: null,
        note: firstAdded(was ?? '', next),
      },
      said: tr("server.done.97d5c8", { p0: wanted, p1: counts.added, p2: counts.removed }),
    }
  }

  if (name === 'run_file') {
    /*
     * The `run` rule — for the same reason as `files` above.
     *
     * The measure is one cell (`'one'`), not Run All: running a script at a
     * person's request costs exactly as much as running their cell, and the
     * `single` rule ("one at a time") does not forbid running.
     */
    if (!allowsRun(getRules(hands.sessionId).run, hands.role, 'one')) {
      return {
        step: note(tr("server.onlyTheTeacherMayRunCode.59bbe2"), wanted),
        said: refuseCells(
          hands,
          tr("server.onlyTheTeacherMayRunCodeIn.fbd734", { p0: wanted }) +
            tr("server.explainWhatShouldBeCheckedInYour.9855be"),
        ),
      }
    }
    const runner = runnerFor(wanted)
    if (!runner) {
      return {
        step: note(tr("server.cannotRunThisFile.94cb27"), wanted),
        said: tr("server.isNotAScriptOnlyPyAnd.9d1397", { p0: baseOf(wanted) }),
      }
    }
    if (!statPath(hands.sessionId, wanted)) {
      return { step: note(tr("server.fileNotFound.f1ab8a"), wanted), said: tr("server.fileDoesNotExist.5febf3", { p0: wanted }) }
    }
    /*
     * The room has one shell, and its queue belongs to people: a command put
     * into it now will start who knows when, and the agent has nothing to wait
     * for it with — the queue does not keep callbacks. It is more honest to say
     * the run did not work out than to stand for a minute and a half and
     * declare the shell dead while someone else's `pip install` goes on its
     * way.
     *
     * Busyness is judged by the live command line (`terminalBusy`), not by the
     * phase. The phase lies in two ordinary cases listed above `runCommand`: a
     * dropped socket to Jupyter sets `starting` although the pty keeps
     * computing, and `Clear` in the middle of someone else's command. Exactly
     * through these two gaps the agent's run used to end up in a queue it
     * cannot wait in.
     */
    if (terminalBusy(hands.sessionId)) {
      return {
        step: note(tr("server.terminalBusy.97ab05"), wanted),
        said:
          tr("server.anotherCommandIsRunningInTheRoom.89c451") +
          tr("server.mentionThisInYourReplyOrTry.a9d49e"),
      }
    }
    /*
     * First — to disk, everything that is not there yet.
     *
     * For an open file the truth lives in the room's document, and it goes to
     * disk 700 ms after the last keystroke. A script, though, reads the disk:
     * both `train.py` itself and the `open('data.csv')` inside it would reach
     * the run without the last second of typing — the oracle would explain to
     * the room an error that is no longer in the file. The kernel does the same
     * before running a cell (`flushToDisk` in kernel/index.ts), and for the
     * same reason.
     *
     * Only this room is flushed: a run here knows nothing about other rooms'
     * open files, and they will reach the disk on their own the same seven
     * hundred milliseconds later.
     */
    try {
      projectBooks(hands.sessionId)
      flushSessionFiles(hands.sessionId)
    } catch (err) {
      // The run happens anyway — just on what is already on disk.
      console.error(`[session ${hands.sessionId}] could not flush files before the run:`, err)
    }
    const quoted = `'${wanted.replace(/'/g, `'\\''`)}'`
    const command = `${runner === 'python' ? 'python -u' : 'bash'} ${quoted}; echo "[${tr(EXIT_CODE)} $?]"`
    // Snapshot of the tree BEFORE the run: the script edits the disk past the
    // tools, and that can only be named by comparing. See `sayMoved`.
    const treeWas = treePrint(hands.sessionId)
    const result = await runInRoom(hands, command, signal)
    const shown = tail(result.output)
    const moved = movedFiles(hands.sessionId, treeWas)
    return {
      step: {
        kind: 'run',
        target: `${runner === 'python' ? 'python -u' : 'bash'} ${wanted}`,
        added: 0,
        removed: 0,
        exit: result.exit,
        note:
          result.cut === 'waiting'
            ? tr("server.didNotStartTheShellIsRunning.93c619")
            : result.cut === 'timeout'
              ? tr("server.exceededSeconds.cfeb9f", { p0: RUN_TIMEOUT_MS / 1000, p1: shown })
              : shown,
      },
      said: sayRun(result, shown) + (moved ? `\n\n${moved}` : ''),
      failed: result.exit !== 0 && result.exit !== null,
      ...(moved ? { also: note(moved, wanted) } : {}),
    }
  }

  return unknownTool(name, known)
}

function note(what: string, target: string): AgentStep {
  return { kind: 'note', target, added: 0, removed: 0, exit: null, note: what }
}

/**
 * A refusal that names what exists.
 *
 * "There is no tool X" is a dead end out of nothing: the model missed the name
 * and without the list misses it again, spending turn steps on it. It had the
 * list anyway — in the tool descriptions — but next to the refusal it costs
 * less than another round trip to the provider.
 */
/**
 * All tool names that exist at all — not only those available to this person.
 *
 * The difference matters: a tool the person was not given answers with ITS OWN
 * refusal ("the teacher edits cells here"), and replacing it with "there is no
 * such tool" would mean lying about how the room is set up. Only a real miss
 * in the name is caught here.
 */
const ALL_TOOLS = new Set([
  'list_files',
  'read_file',
  'write_file',
  'edit_file',
  'run_file',
  'create_notebook',
  'read_notebook',
  'run_cell',
  'edit_cell',
  'add_cell',
  'remove_cell',
])

function unknownTool(name: string, known: ToolSpec[]): Ran {
  return {
    step: note(tr("server.unknownTool.2e118e"), name),
    failed: true,
    said: tr('server.agent.toolMissing', {
      p0: name,
      p1: known.map((tool) => tool.name).join(', '),
    }),
  }
}

/* ------------------------------------------------------------ new notebook */

/**
 * Create a notebook at the model's request — with the same call a person
 * creates it with.
 *
 * `createBook` is what stands behind "new .ipynb file" in the room's tree
 * (control.ts · tree:new): the file on disk and the entry in the document are
 * created together, otherwise you get exactly the half that this tool was
 * written against.
 *
 * The extension is added silently. "Make a notebook called Review" is an
 * ordinary request, and a refusal "the path must end in .ipynb" would cost a
 * turn step on something the server knows itself. The list of cells is
 * returned right away: the notebook is empty, but the model needs the first
 * cell's name already now — otherwise its next step is `read_notebook` for one
 * line.
 */
function createNotebook(hands: Hands, wanted: string): Ran {
  const rules = getRules(hands.sessionId)
  if (!allows(rules.files, hands.role) || !allowsStructure(rules.structure, hands.role, 'add')) {
    return {
      step: note(tr('server.agent.mayNotCreateNotebook'), wanted),
      failed: true,
      said: refuseCells(hands, tr('server.agent.onlyTheTeacherCreatesNotebooks')),
    }
  }
  const path = kindOf(wanted) === 'notebook' ? wanted : `${wanted}.ipynb`
  /*
   * The author is whoever asked for the turn, not the oracle: a notebook created
   * at a student's request belongs to the student exactly as if they had
   * pressed "new file" themselves. `createBook` filters out the teacher by role.
   */
  const made = createBook(hands.sessionId, path, {
    participantId: hands.by.participantId,
    name: hands.by.name,
    role: hands.role,
  })
  if (!made.ok) {
    return {
      step: note(made.why, path),
      failed: true,
      said: `${made.why} ${tr('server.agent.createNotebookFailed')}`,
    }
  }
  /*
   * The notebook is NOT put into the undo snapshot, and that is a choice, not
   * forgetfulness.
   *
   * Undoing a turn gives files back their previous text (`undoTurn`), and a
   * created notebook has no previous text: "put it back as it was" would mean
   * emptying its file while leaving the entry in the room alive — that is,
   * pulling the disk and the room apart exactly the way this module does not
   * let anything else do. Removing the notebook entirely is the teacher's right
   * and goes through the tree; that is what the answer says.
   */
  bookWork(hands).made.add(path)
  const doc = peekSessionDoc(hands.sessionId)?.doc
  const listed = doc ? listCells(doc, { path }, hands.sessionId, hands.role) : null
  return {
    step: { kind: 'new', target: path, added: 0, removed: 0, exit: null, note: tr('server.agent.notebookCreated') },
    said: tr('server.agent.createdNotebook', { p0: path }) + (listed ? `\n\n${listed.said}` : ''),
  }
}

/* --------------------------------------------------------- running a cell */

/** How often we ask the document whether the cell has finished computing. */
const RUN_POLL_MS = 200

/**
 * Run a cell and wait for its output.
 *
 * The same road as a person's Run button: `requestRun` puts the cell into the
 * room's shared queue on behalf of the asker and with their place in it
 * (`runQueueCap`). The oracle has no road of its own to the kernel and must not
 * have one — otherwise its run would bypass the queue, the ceiling and the
 * "who ran it" mark in the document.
 *
 * We wait by polling the document, not with a callback: the queue does not
 * keep callbacks, and the cell's state is exactly what the room looks at. The
 * waiting ceiling is the same as for a script: longer is not "slow" but "hung".
 */
async function runCell(
  hands: Hands,
  args: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<Ran> {
  const doc = peekSessionDoc(hands.sessionId)?.doc
  if (!doc) {
    return {
      step: note(tr("server.theRoomNoLongerExists.dd5d47"), tr("server.notebook.02497c")),
      failed: true,
      said: tr("server.thisRoomNoLongerExists.a43862"),
    }
  }
  const id = typeof args.cell === 'string' ? args.cell.trim() : ''
  const found = findCell(doc, id)
  if (!found) return { ...missingCell(id), failed: true }
  const home = bookOfCells(doc, found.cells)
  if (!home) return { ...missingCell(id), failed: true }
  const label = tr("server.cell.47aead", { p0: home.path, p1: pad(found.index + 1) })

  if (cellType(found.cell) !== 'code') {
    return {
      step: note(tr('server.agent.cellIsNotCode'), id),
      failed: true,
      said: tr('server.agent.onlyCodeCellsRun', { p0: label }),
    }
  }
  /*
   * The rules of THE notebook where the cell lies: in their own notebook a
   * student runs code even in the middle of a lecture, and in someone else's
   * personal one does not run it even in an open room. The kernel, though, is
   * one for everyone, and its queue is shared: the queue ceiling (`runQueueCap`)
   * stays at room level.
   */
  const rules = rulesForBook(getRules(hands.sessionId), home.root, askerOf(hands))
  /*
   * The measure is one cell (`'one'`), the same as for `run_file`: running a
   * cell at a person's request costs exactly as much as their own press.
   */
  if (!allowsRun(rules.run, hands.role, 'one')) {
    return {
      step: note(tr("server.onlyTheTeacherMayRunCode.59bbe2"), id),
      failed: true,
      said: refuseCells(hands, tr("server.onlyTheTeacherRunsCellsInThis.21ec54"), home.root),
    }
  }
  /*
   * Already computing or waiting in the queue — we do not queue it a second
   * time.
   *
   * The same check as in `remove_cell`, and for the same reason: a second
   * queueing of the same cell will be silently skipped by the queue
   * (`requestRun` filters it out), while the turn would sit waiting for output
   * it did not order — and take someone else's as its own.
   */
  const state = (found.cell.get('state') as CellState) ?? 'idle'
  if (state === 'running' || state === 'queued') {
    return {
      step: note(tr("server.theCellIsRunning.ff6251"), id),
      failed: true,
      said: tr('server.agent.cellAlreadyRunning', { p0: label }),
    }
  }
  const refused = requestRun(
    hands.sessionId,
    [id],
    hands.by.name,
    hands.by.participantId,
    runQueueCap(rules.run, hands.role),
  )
  if (refused > 0) {
    return {
      step: note(tr("server.youMayRunOneCellAtA.35e7c7"), id),
      failed: true,
      said: tr("server.youMayRunOneCellAtA.35e7c7"),
    }
  }

  const ended = await waitForCell(hands.sessionId, id, signal)
  const now = findCell(peekSessionDoc(hands.sessionId)?.doc ?? doc, id)
  const shown = now ? tail(renderOutputs(now.cell, MAX_OUTPUT).join('\n')) : ''
  if (!ended) {
    // The cell is still queued or computing: we take ours off the queue and
    // leave someone else's computation alone — interrupting the kernel in the
    // middle of someone else's cell is not this turn's right.
    cancelRun(hands.sessionId, [id], hands.by.participantId, hands.role === 'host')
    return {
      step: {
        kind: 'run',
        target: label,
        added: 0,
        removed: 0,
        exit: null,
        note: tr("server.exceededSeconds.cfeb9f", { p0: RUN_TIMEOUT_MS / 1000, p1: shown }),
      },
      failed: true,
      said: tr('server.agent.cellDidNotFinish', { p0: label, p1: RUN_TIMEOUT_MS / 1000 }),
    }
  }
  const failed = ended === 'error'
  return {
    step: {
      kind: 'run',
      target: label,
      added: 0,
      removed: 0,
      exit: failed ? 1 : 0,
      note: shown || tr('server.agent.noOutput'),
    },
    failed,
    said:
      (failed
        ? tr('server.agent.cellFailed', { p0: label })
        : tr('server.agent.cellRan', { p0: label })) +
      (shown ? `\n\n${shown}` : `\n\n${tr('server.agent.noOutput')}`),
  }
}

/** How the cell ended — or `null` if it did not finish in the allotted time. */
async function waitForCell(
  sessionId: string,
  cellId: string,
  signal?: AbortSignal,
): Promise<'ok' | 'error' | null> {
  const deadline = Date.now() + RUN_TIMEOUT_MS
  for (;;) {
    const doc = peekSessionDoc(sessionId)?.doc
    const found = doc ? findCell(doc, cellId) : null
    // The cell is gone or the room closed: nothing to wait for, and no one to wait for.
    if (!found) return null
    const state = (found.cell.get('state') as CellState) ?? 'idle'
    if (state === 'ok') return 'ok'
    if (state === 'error') return 'error'
    if (state === 'idle') return null
    if (signal?.aborted || Date.now() >= deadline) return null
    await new Promise((resolve) => {
      const timer = setTimeout(resolve, RUN_POLL_MS)
      timer.unref?.()
    })
  }
}

/* --------------------------------------------- edits past the tools */

/**
 * A fingerprint of the room's tree: path → size and modification time.
 *
 * Taken around every `run_file` for the same reason a fingerprint of the
 * notebooks is taken around every step (`bookPrints`): this mode is allowed to
 * run scripts, and forbidding them to touch the disk is impossible without
 * taking away half the work. So we catch it not with a ban but by naming it —
 * "the script wiped data.csv" on the same step where it happened, not in
 * silence.
 *
 * Size and mtime, not contents: walking the tree already costs a readdir+lstat
 * per entry, and reading all of the room's files twice on every run means a
 * dataset in memory for the sake of one line in an answer.
 */
export function treePrint(sessionId: string): Map<string, string> {
  const print = new Map<string, string>()
  try {
    for (const entry of listFiles(sessionId)) {
      if (!entry.dir) print.set(entry.path, `${entry.size}:${entry.modifiedAt}`)
    }
  } catch {
    /* tree unreadable: nothing to compare, which is more honest than inventing */
  }
  return print
}

/** Paths named one by one; the rest as a number: a list in an answer, not a report. */
const MAX_MOVED_NAMED = 12

/**
 * What the script did to files past the tools — or an empty string.
 *
 * Created files are named too, and that is not nitpicking: a script that put
 * `_archive.py` or `out.csv` next to the others did work the turn owes the room
 * a report about — otherwise the teacher finds them a week later and does not
 * know whose they are.
 *
 * Exported together with `treePrint` for the test — for the same reason as
 * `useTool`: checking this through a live shell would mean checking the shell.
 */
export function movedFiles(sessionId: string, was: Map<string, string>): string {
  if (was.size === 0) return ''
  const now = treePrint(sessionId)
  const gone: string[] = []
  const rewritten: string[] = []
  const added: string[] = []
  for (const [path, print] of was) {
    const fresh = now.get(path)
    if (fresh === undefined) gone.push(path)
    else if (fresh !== print) rewritten.push(path)
  }
  for (const path of now.keys()) if (!was.has(path)) added.push(path)
  const parts: string[] = []
  if (gone.length > 0) parts.push(tr('server.agent.movedDeleted', { p0: named(gone) }))
  if (rewritten.length > 0) parts.push(tr('server.agent.movedRewritten', { p0: named(rewritten) }))
  if (added.length > 0) parts.push(tr('server.agent.movedAdded', { p0: named(added) }))
  if (parts.length === 0) return ''
  return tr('server.agent.movedHead', { p0: parts.join('; ') })
}

function named(paths: string[]): string {
  if (paths.length <= MAX_MOVED_NAMED) return paths.join(', ')
  return `${paths.slice(0, MAX_MOVED_NAMED).join(', ')} ${tr('server.agent.andMore', { p0: paths.length - MAX_MOVED_NAMED })}`
}

/* ---------------------------------------------------------- notebook cells */

/** How much of one cell's source goes into the list. */
const MAX_CELL_SOURCE = 4_000

/** The name of the mark the turn sets before its first edit of the notebook. */
const CHECKPOINT_LABEL = () => tr("server.private.checkpoint")

/** What the turn has already done to notebooks. */
interface BookWork {
  /**
   * The mark in the history is already set.
   *
   * Once per turn, not per cell: "remove the solutions from five cells" is one
   * decision of a person, and going back from it should lead to one point. Five
   * marks in a row would push out of the panel's window the very thing people
   * go into the history for.
   *
   * One per turn, not per notebook: the version history writes to the `cells`
   * root, hard-wired (collab/history.ts · restoreInto), that is, it marks
   * exactly one notebook of the room. The rest get `copies`.
   */
  marked: boolean
  /** Notebook without history → where the copy of its file went before the first edit. */
  copies: Map<string, string>
  /**
   * Notebooks this very turn created.
   *
   * A copy "as it was before the turn" is neither needed nor possible for them:
   * before the turn they did not exist. The very first real piece of work by
   * this tool put an empty `Тревога_Сириус.before-oracle.ipynb` next to the
   * brand-new notebook, and the turn honestly added to its answer that it could
   * not remove it — that is for the teacher. The room got junk and an apology
   * instead of a result.
   */
  made: Set<string>
  /** Cell name → what was done to it and where. The order is the order it was done in. */
  touched: Map<string, { book: string; what: 'edited' | 'added' | 'removed' }>
  /** Notebooks whose file was rewritten past the room during the turn. */
  faked: Set<string>
}

/**
 * What the turn did to a notebook — until the end of the turn, and not needed
 * after that.
 *
 * The line "edited 03 and 05" in the answer is taken from here; the end of the
 * turn — successful or failed — composes it and removes the entry. The way back
 * does not live here but in the version history: a notebook, unlike the files
 * of the working folder, survives a server restart together with its restore
 * point.
 */
const inBook = new Map<string, BookWork>()

function bookWork(hands: Hands): BookWork {
  const key = `${hands.sessionId}\u0000${hands.entryId}`
  let work = inBook.get(key)
  if (!work) {
    work = { marked: false, copies: new Map(), touched: new Map(), faked: new Set(), made: new Set() }
    inBook.set(key, work)
    const mine = [...inBook.keys()].filter((other) => other.startsWith(`${hands.sessionId}\u0000`))
    while (mine.length > MAX_REMEMBERED_TURNS) inBook.delete(mine.shift()!)
  }
  return work
}

/** This person's rights on cells — the same questions the gate and the browser ask. */
interface CellRights {
  edit: boolean
  add: boolean
  remove: boolean
}

/**
 * What this person may do to the notebook with their own hands.
 *
 * The oracle in "Act" mode gets no rights beyond the person's own: the `agent`
 * rule says whether they may start a turn at all, and what that turn does to
 * the notebook is decided by the same `edit` and `structure` as for their
 * fingers. The rules arrive as effective ones (`db.ts · getRules`), that is,
 * after the bell they are the teacher's — the end of the class adds only the
 * words of the refusal here.
 *
 * The lock counts as open if AT LEAST ONE cell is open: this answers the
 * question "is there anything for them to edit at all", from which the list of
 * tools is assembled. The question "this particular cell" is answered by
 * `mayEditCell` at the cell itself, before the write.
 */
function rightsFor(hands: Hands, doc: Y.Doc, root: string | null = null): CellRights {
  /*
   * The rules of THE notebook in question — with the same function as
   * everywhere (shared/rules.ts · rulesForBook). The oracle here is the asker's
   * hands, and those hands in a personal notebook are the same as the asker's
   * own: they edit their own even in a lecture, and do not edit someone else's
   * even in an open room.
   *
   * `root` defaults to `null` — "no notebook named", the room's rules. Such an
   * answer is needed in exactly one place: the tool list, and that one does not
   * ask with this but with `anyCellRights` below.
   */
  const rules: RoomRules = rulesForBook(getRules(hands.sessionId), root, askerOf(hands))
  const finished = isFinished(hands.sessionId)
  return {
    edit: mayEditCell(rules, hands.role, hasOpenCell(doc), finished),
    add: allowsStructure(rules.structure, hands.role, 'add'),
    remove: allowsStructure(rules.structure, hands.role, 'remove'),
  }
}

/** Who is asking — in the form the notebook rules read it. */
function askerOf(hands: Hands): Asker {
  return { role: hands.role, participantId: hands.by.participantId }
}

/**
 * Whether this person has anything to edit IN AT LEAST ONE notebook of the
 * room.
 *
 * A question for the tool list, not for checking: a tool that will always
 * refuse is not worth a turn step to learn a rule known in advance — but hiding
 * `edit_cell` from a student who was given their own notebook means leaving
 * them without the oracle exactly where they work. Hence an "or" over all
 * notebooks, and "this one?" is decided by `rightsFor` at the cell itself,
 * before the write.
 */
function anyCellRights(hands: Hands, doc: Y.Doc): CellRights {
  const out = rightsFor(hands, doc)
  for (const book of bookList(doc)) {
    if (out.edit && out.add && out.remove) break
    const here = rightsFor(hands, doc, book.root)
    out.edit ||= here.edit
    out.add ||= here.add
    out.remove ||= here.remove
  }
  return out
}

/** The same for running: is there at least one notebook where this person runs code. */
function mayRunAnyBook(hands: Hands, doc: Y.Doc | undefined): boolean {
  const rules = getRules(hands.sessionId)
  if (allowsRun(rules.run, hands.role, 'one')) return true
  if (!doc) return false
  const who = askerOf(hands)
  return bookList(doc).some((book) =>
    allowsRun(rulesForBook(rules, book.root, who).run, hands.role, 'one'),
  )
}

function hasOpenCell(doc: Y.Doc): boolean {
  for (const cells of allCellArrays(doc)) {
    for (const cell of cells.toArray()) if (isCellOpen(cell)) return true
  }
  return false
}

/**
 * The words of a refusal — its own while the class is on, and the general ones
 * once it is over.
 *
 * Exactly as in the gate: by the rules alone "the teacher closed the notebook"
 * and "the class is over" are indistinguishable, and the person needs to be
 * told the second — otherwise they will go looking for a teacher who changed
 * nothing.
 */
function refuseCells(hands: Hands, own: string, root: string | null = null): string {
  if (!actsAfterClass(isFinished(hands.sessionId), hands.role)) return tr(CLASS_IS_OVER)
  /*
   * And the words of THE NOTEBOOK ITSELF, when it is the notebook that closed,
   * not the room: "the teacher types in this seminar" about someone else's
   * personal notebook sends the model to explain the wrong thing to the person
   * — and the person to a teacher who forbade nothing.
   */
  const book = bookRefusal(getRules(hands.sessionId), root, askerOf(hands))
  return book ? tr(book.key, { p0: book.name }) : own
}

/** The room's notebook — the one on the `cells` root that has version history. */
function roomBook(doc: Y.Doc): Book | null {
  return bookList(doc).find((book) => book.root === CELLS_KEY) ?? null
}

/**
 * The notebook this list of cells belongs to. One root, one `Y.Array`.
 *
 * `null` for a document without a notebook list — the very one where
 * `allCellArrays` returns the bare `cells` root. Such a document belongs to a
 * room opened for the first time since several notebooks appeared: the list
 * will be added to it in a moment, and until then there is exactly one list
 * and it is the room's notebook.
 */
function bookOfCells(doc: Y.Doc, cells: Y.Array<YCell>): Book | null {
  const found = bookList(doc).find((book) => bookCells(doc, book.root) === cells)
  if (found) return found
  return bookList(doc).length === 0 ? { path: DEFAULT_BOOK, root: CELLS_KEY } : null
}

/**
 * The notebook in question: named by path or, if none was named, the room's
 * notebook.
 *
 * One place for all tools: the refusal "there is no such notebook" must sound
 * the same wherever it is reached from, and list what exists — otherwise the
 * model will miss with the same name a second time.
 */
function bookAsked(
  doc: Y.Doc,
  raw: unknown,
  sessionId: string,
  role: 'host' | 'participant',
): Book | Ran {
  const asked = typeof raw === 'string' && raw.trim() ? raw.trim() : null
  const path = asked ? normalizePath(asked) : null
  if (asked && !path) {
    return {
      step: note(tr("server.invalidPath.4b91a9"), asked),
      failed: true,
      said: tr("server.thisPathIsNotAllowedPathsAre.47da6e"),
    }
  }
  const book = path ? bookAt(doc, path) : (roomBook(doc) ?? bookList(doc)[0] ?? null)
  if (book) return book
  const known = bookList(doc).map((one) => one.path)
  /*
   * A refusal with a way out, not a wall.
   *
   * "There is no such notebook in the room", full stop, is the dead end the
   * turn used to drive into: a notebook the model had just put down as a file
   * was not on the list, and all that was left was to call the same `add_cell`
   * again or to go writing an .ipynb with a script. The way out is named right
   * here and differs by rights: those who may create notebooks get
   * `create_notebook`, those who may not get words for the teacher, because the
   * teacher can create it.
   */
  const remedy = allowsStructure(getRules(sessionId).structure, role, 'add')
    ? tr('server.agent.useCreateNotebook', { p0: path ?? tr("server.roomNotebook.05515c") })
    : tr('server.agent.askTeacherForNotebook')
  return {
    step: note(tr("server.noNotebookWithThatName.c07b5d"), path ?? tr("server.roomNotebook.05515c")),
    failed: true,
    said:
      (path
        ? tr("server.isNotANotebookInThisRoom.fe1f0a", { p0: path }) +
          (known.length > 0
            ? tr("server.open.0c252d", { p0: known.join(', ') })
            : tr("server.thereAreNoOpenNotebooksInIt.b3a67e"))
        : tr("server.thisRoomHasNoOpenNotebook.1f9148")) + remedy,
  }
}

function useCellTool(hands: Hands, name: string, args: Record<string, unknown>): Ran {
  /*
   * Peek, do not create: a turn that reached a deleted room would raise it
   * again — with timers, a line in the history and a folder on disk.
   */
  const doc = peekSessionDoc(hands.sessionId)?.doc
  if (!doc) {
    return {
      step: note(tr("server.theRoomNoLongerExists.dd5d47"), tr("server.notebook.02497c")),
      failed: true,
      said: tr("server.thisRoomNoLongerExists.a43862"),
    }
  }
  if (name === 'read_notebook') return listCells(doc, args, hands.sessionId, hands.role)
  if (name === 'edit_cell') return editCell(hands, doc, args)
  if (name === 'add_cell') return addCell(hands, doc, args)
  return removeCell(hands, doc, args)
}

/**
 * The cells of the live notebook — what is not in the file.
 *
 * A cell's name is not stored in the .ipynb and is not shown to the person: a
 * cell in the room can be addressed only by it, and there is nowhere else to
 * get it. The output is not included in full — it has already gone into the
 * question's context, and the list only needs to know it exists: that shows
 * what to rerun.
 */
function listCells(
  doc: Y.Doc,
  args: Record<string, unknown>,
  sessionId: string,
  role: 'host' | 'participant',
): Ran {
  const book = bookAsked(doc, args.path, sessionId, role)
  if ('step' in book) return book

  const cells = bookCells(doc, book.root)
  /*
   * In pages — for the same two reasons as with a file.
   *
   * First: a notebook of a hundred cells does not fit under the read ceiling,
   * and a cut "up to N characters" chops it in the middle of a source — and so
   * in the middle of the next cell's name, which is exactly what the model
   * needs. Second: this sheet arrives in the turn ONCE, but goes to the
   * provider on every following step. `from`/`count` is "show me the twentieth
   * through the fortieth", exactly the request people come back here for.
   */
  const asked = intArg(args.from, 1)
  const from = Math.max(0, (asked < 0 ? cells.length + asked + 1 : asked) - 1)
  const wanted = intArg(args.count, 0)
  const upTo = wanted > 0 ? Math.min(cells.length, from + wanted) : cells.length
  /*
   * Outputs — on request, not always.
   *
   * The cell list is called to learn names and see code; outputs are as much
   * text again, and usually they already went to the model in the question's
   * frame. But after `run_cell` and after someone else's run in the room they
   * are exactly what is needed, and until now there was nowhere to get them:
   * "has output" is not output.
   */
  const withOutputs = args.outputs === true || args.outputs === 'true'
  const lines: string[] = [
    `${book.path} — ${cells.length} ${cellsWord(cells.length)}. ` +
      tr("server.editACellByItsIdentifierNot.d19277"),
  ]
  let to = from
  let used = 0
  const room = maxRead()
  cells.slice(from, upTo).forEach((cell: YCell, offset: number) => {
    const at = from + offset
    if (used > room && to > from) return
    const head = [`[${pad(at + 1)}]`, cellId(cell), cellType(cell)]
    if (cellOutputs(cell).length > 0) head.push(tr("server.hasOutput.113f1b"))
    if (isCellOpen(cell)) head.push(tr("server.openToTheRoom.467c85"))
    const source = cellSource(cell).toString()
    const block: string[] = ['', head.join(' · ')]
    if (!source.trim()) block.push(tr("server.empty.9a3a4f"))
    else {
      block.push('```' + (cellType(cell) === 'code' ? 'python' : 'markdown'))
      block.push(
        source.length > MAX_CELL_SOURCE
          ? source.slice(0, MAX_CELL_SOURCE) + tr("server.truncated.fdb0c3")
          : source,
      )
      block.push('```')
    }
    if (withOutputs) block.push(...renderOutputs(cell, MAX_CELL_SOURCE))
    for (const line of block) used += line.length + 1
    lines.push(...block)
    to = at + 1
  })
  if (to < cells.length) {
    lines.push('')
    lines.push(
      tr('server.agent.cellsShown', { p0: from + 1, p1: to, p2: cells.length, p3: book.path, p4: to + 1 }),
    )
  }
  /*
   * About the neighbouring notebooks — right here.
   *
   * A room has several notebooks, and the tool without a path shows one: by not
   * naming the others we leave the model sure it has seen everything — and
   * "remove the solutions" goes past the very notebook the turn was started
   * for.
   */
  const others = bookList(doc)
    .map((one) => one.path)
    .filter((path) => path !== book.path)
  if (others.length > 0) {
    lines.push('')
    lines.push(tr("server.otherNotebooksInTheRoomUseThe.e01136", { p0: others.join(', ') }))
  }
  const said = lines.join('\n')
  return {
    step: {
      kind: 'read',
      target: book.path,
      added: 0,
      removed: 0,
      exit: null,
      note: `${cells.length} ${cellsWord(cells.length)}`,
    },
    /*
     * No `clipRead`: the list is already fitted under the same ceiling page by
     * page, and clipping again by characters would cut exactly the tail — the
     * line "cells 3–4 of 10 shown, next — from: 5", that is, the only hint on
     * how to read on. A cut that eats the explanation of the cut is a dead end.
     */
    said,
  }
}

function editCell(hands: Hands, doc: Y.Doc, args: Record<string, unknown>): Ran {
  const id = typeof args.cellId === 'string' ? args.cellId : ''
  if (typeof args.source !== 'string') {
    return {
      step: note(tr("server.nothingToWrite.bee7a2"), id || tr("server.cell.4d4b88")),
      said: tr("server.sourceMustBeAString.88cd6f"),
    }
  }
  const found = findCell(doc, id)
  if (!found) return missingCell(id)
  const home = bookOfCells(doc, found.cells)
  if (!home) return missingCell(id)

  /*
   * By the rules of THE notebook the cell lies in, and by the lock of THIS
   * cell.
   *
   * Not through `rightsFor`: that one answers the tool-list question — "is
   * there anything to edit at all", and its lock is shared across the document.
   * Here the question is about one cell, and it has a lock of its own.
   */
  if (
    !mayEditCell(
      rulesForBook(getRules(hands.sessionId), home.root, askerOf(hands)),
      hands.role,
      isCellOpen(found.cell),
      isFinished(hands.sessionId),
    )
  ) {
    return {
      step: note(tr("server.onlyTheTeacherMayEditCells.9b2337"), id),
      said: refuseCells(
        hands,
        tr("server.onlyTheTeacherMayEditThisSeminar.91645c") +
          tr("server.explainWhatShouldBeChangedInYour.c7378b"),
        home.root,
      ),
    }
  }

  const text = cellSource(found.cell)
  const was = text.toString()
  const label = tr("server.cell.47aead", { p0: home.path, p1: pad(found.index + 1) })
  if (was === args.source) {
    return { step: note(tr("server.alreadyMatches.2ef8ba"), label), said: tr("server.alreadyContainsExactlyThisText.adb3e8", { p0: label }) }
  }
  const stop = safety(hands, doc, home)
  if (stop) return stop

  const next = args.source
  // On behalf of whoever asked for the turn: a version in the history must have
  // an author, not "the room" — the same path by which the server applies an
  // accepted oracle patch.
  applyOnBehalf(hands.sessionId, hands.by.participantId, () => replaceText(text, next))
  bookWork(hands).touched.set(id, { book: home.path, what: 'edited' })

  const counts = countChanges(was, next)
  /*
   * The output stays. Editing the source by hand does not erase it either: the
   * output is evidence of what the cell showed, and it honestly becomes stale.
   * This has to be said, otherwise the teacher will not know what to rerun.
   */
  const stale =
    cellOutputs(found.cell).length > 0
      ? tr("server.itsExistingOutputIsNowStale.da45eb") + tr('server.agent.rerunWithRunCell')
      : ''
  return {
    step: {
      kind: 'write',
      target: label,
      added: counts.added,
      removed: counts.removed,
      exit: null,
      note: firstAdded(was, next),
    },
    said: tr("server.done.ac3049", { p0: label, p1: counts.added, p2: counts.removed, p3: stale }),
  }
}

function addCell(hands: Hands, doc: Y.Doc, args: Record<string, unknown>): Ran {
  const type: CellType | null =
    args.type === 'code' ? 'code' : args.type === 'markdown' ? 'markdown' : null
  if (!type) {
    return { step: note(tr("server.chooseACellType.e7d810"), tr("server.notebook.02497c")), said: tr("server.typeMustBeCodeOrMarkdown.74ff56") }
  }
  const source = typeof args.source === 'string' ? args.source : ''
  const after = typeof args.after === 'string' && args.after.trim() ? args.after.trim() : null

  /*
   * The neighbour decides where to stand — the path only when no neighbour was
   * named.
   *
   * `after` is more precise: it shows a place, not a notebook, and there is
   * nothing for it to argue about with `path`. Resolving a disagreement between
   * two arguments would mean inventing a third rule where order is enough.
   */
  let home: Book
  let cells: Y.Array<YCell>
  let at: number
  if (after) {
    const found = findCell(doc, after)
    if (!found) return missingCell(after)
    const of = bookOfCells(doc, found.cells)
    if (!of) return missingCell(after)
    home = of
    cells = found.cells
    at = found.index + 1
  } else {
    const asked = bookAsked(doc, args.path, hands.sessionId, hands.role)
    if ('step' in asked) return asked
    home = asked
    cells = bookCells(doc, home.root)
    at = cells.length
  }

  if (!rightsFor(hands, doc, home.root).add) {
    return {
      step: note(tr("server.onlyTheTeacherMayAddCells.264967"), home.path),
      said: refuseCells(
        hands,
        tr("server.onlyTheTeacherMayAddCellsIn.423ddc"),
        home.root,
      ),
    }
  }
  const stop = safety(hands, doc, home)
  if (stop) return stop

  const cell = createCell(type, source)
  applyOnBehalf(hands.sessionId, hands.by.participantId, () => cells.insert(at, [cell]))
  const id = cellId(cell)
  bookWork(hands).touched.set(id, { book: home.path, what: 'added' })

  const label = tr("server.cell.47aead", { p0: home.path, p1: pad(at + 1) })
  return {
    step: {
      kind: 'new',
      target: label,
      added: source ? source.split('\n').length : 0,
      removed: 0,
      exit: null,
      note: firstAdded('', source),
    },
    said: tr("server.doneIdentifier.d397dc", { p0: label, p1: id }),
  }
}

function removeCell(hands: Hands, doc: Y.Doc, args: Record<string, unknown>): Ran {
  const id = typeof args.cellId === 'string' ? args.cellId : ''
  const found = findCell(doc, id)
  if (!found) return missingCell(id)
  const home = bookOfCells(doc, found.cells)
  if (!home) return missingCell(id)

  if (!rightsFor(hands, doc, home.root).remove) {
    return {
      step: note(tr("server.onlyTheTeacherMayRemoveCells.d98982"), id),
      said: refuseCells(
        hands,
        tr("server.onlyTheTeacherMayRemoveCellsIn.6cf98f"),
        home.root,
      ),
    }
  }
  const label = tr("server.cell.47aead", { p0: home.path, p1: pad(found.index + 1) })
  /*
   * A cell waiting in the kernel queue is not removed by the turn.
   *
   * When a person removes it, the server immediately takes it off the queue
   * (`onCellsRemoved` in control.ts) — the turn has no such road, and a cell
   * removed during the turn would catch its output into the void while the
   * queue considered it alive. The turn cannot wait for the computation to end
   * either, so it is more honest to refuse.
   */
  const state = (found.cell.get('state') as CellState) ?? 'idle'
  if (state === 'running' || state === 'queued') {
    return {
      step: note(tr("server.theCellIsRunning.ff6251"), id),
      said: tr("server.isQueuedForTheKernelSoI.d94674", { p0: label }),
    }
  }
  const stop = safety(hands, doc, home)
  if (stop) return stop

  /*
   * Remember BEFORE deleting: after it there is nothing left to read, and
   * Ctrl+Z in the room brings the cell back as a copy — its output comes from
   * this server record. The same order as a deletion by hand
   * (collab/index.ts · rememberDeleted).
   */
  rememberDeleted(hands.sessionId, doc, [id])
  const cells = found.cells
  const index = found.index
  applyOnBehalf(hands.sessionId, hands.by.participantId, () => cells.delete(index, 1))
  bookWork(hands).touched.set(id, { book: home.path, what: 'removed' })

  return {
    step: { kind: 'write', target: label, added: 0, removed: 1, exit: null, note: tr("server.cellRemoved.d30a05") },
    said: tr("server.removedFollowingCellPositionsChangedIdentifiersDid.365725", { p0: label }),
  }
}

function missingCell(id: string): Ran {
  return {
    step: note(tr("server.cellNotFound.418523"), id || '—'),
    said:
      tr("server.cellIsNotInTheRoomGet.861a57", { p0: id || '—' }) +
      tr("server.theNumberOnTheScreenIsNot.1bea60"),
  }
}

/**
 * Where to go back to if the edit is not liked — and before making it.
 *
 * For the room's notebook it is a mark in the version history: one button, and
 * the notebook is as it was before the turn. Other notebooks have no history at
 * all — restoring writes to the `cells` root, hard-wired (collab/history.ts ·
 * restoreInto) — and so they used to be simply refused. The refusal turned out
 * worse than the hole: the model, having got it, went around the tools and
 * rewrote the .ipynb with a script, and the room did not see it.
 *
 * Hence a copy of the file next to it. It is more honest than the promise "one
 * button brings it back", which these notebooks do not have: restoring from a
 * copy means opening it in the room and carrying things over by hand, that is,
 * longer and more carefully than a click. This price is named in the turn's
 * answer, not left for later.
 *
 * If the copy could not be saved, we do not edit at all: an edit without a
 * restore point is exactly what this mode is not given.
 */
function safety(hands: Hands, doc: Y.Doc, book: Book): Ran | null {
  if (book.root === CELLS_KEY) return checkpoint(hands, doc)
  const work = bookWork(hands)
  // This very turn created the notebook: there is nowhere to go back to, and a
  // copy would be an empty file next to the real one — with a name that
  // promises a way back.
  if (work.made.has(book.path)) return null
  if (work.copies.has(book.path)) return null
  /*
   * The copy is taken from the cells, not from the file: the file lags a second
   * and a half behind, and it would lack exactly what the person typed just
   * before asking for the turn.
   */
  const text = bookText(hands.sessionId, book.path)
  if (text === null) {
    return {
      step: note(tr("server.nothingToBackUp.06ac82"), book.path),
      said:
        tr("server.cannotBeReadAsANotebookSo.d3da28", { p0: book.path }) +
        tr("server.iWillNotEditItWithoutA.3b0423"),
    }
  }
  // Next to it and with a number, not on top: two attempts in a row are two
  // different "as it was", and the second must not overwrite the first.
  const where = freeName(hands.sessionId, copyName(book.path))
  if (makeFile(hands.sessionId, where, text) !== 'ok') {
    return {
      step: note(tr("server.couldNotSaveABackup.382cce"), book.path),
      said:
        tr("server.couldNotSaveABackupCopyOf.73e179", { p0: book.path }) +
        tr("server.throughVersionHistoryIWillNotEdit.292ce9"),
    }
  }
  work.copies.set(book.path, where)
  return null
}

/** `review/Seminar.ipynb` → `review/Seminar.before-oracle.ipynb`. */
function copyName(path: string): string {
  const dir = parentOf(path)
  const base = baseOf(path)
  const dot = base.lastIndexOf('.')
  const named =
    dot > 0 ? `${base.slice(0, dot)}.before-oracle${base.slice(dot)}` : `${base}.before-oracle`
  return dir ? `${dir}/${named}` : named
}

/**
 * Mark the notebook in the history — once per turn and before the first edit.
 *
 * This is exactly what the oracle's right to touch cells rests on: one button
 * in the history panel returns the notebook exactly to what it was before the
 * turn. Set with the same call as a manual checkpoint (routes/history.ts), and
 * on behalf of whoever asked for the turn — a line in the feed must not belong
 * to nobody.
 *
 * If it could not be marked, we do not edit at all: an edit without a restore
 * point is exactly what this mode is not given.
 */
function checkpoint(hands: Hands, doc: Y.Doc): Ran | null {
  const work = bookWork(hands)
  if (work.marked) return null
  try {
    mark(
      hands.sessionId,
      doc,
      'checkpoint',
      hands.by.participantId,
      CHECKPOINT_LABEL(),
      CHECKPOINT_LABEL(),
    )
  } catch (err) {
    console.error(`[session ${hands.sessionId}] could not mark the notebook before editing:`, err)
    return {
      step: note(tr("server.couldNotMarkHistory.6777c1"), tr("server.notebook.02497c")),
      said:
        tr("server.couldNotCreateANotebookHistoryCheckpoint.1934aa") +
        tr("server.explainWhatShouldBeChanged.1d6c33"),
    }
  }
  work.marked = true
  return null
}

/* ------------------------------------------------- writes past the room */

/**
 * A fingerprint of every room notebook's file — before a step and after it.
 *
 * Two reads per notebook per step, and that is the whole price: a room has a
 * handful of notebooks, and the file gets one source without outputs. Cheaper
 * than working out what exactly someone else's script did, and more reliable
 * than trusting its words.
 */
function bookPrints(sessionId: string): Map<string, string> {
  const doc = peekSessionDoc(sessionId)?.doc
  const prints = new Map<string, string>()
  if (!doc) return prints
  for (const book of bookList(doc)) prints.set(book.path, printOf(sessionId, book.path))
  return prints
}

function printOf(sessionId: string, path: string): string {
  const read = readText(sessionId, path)
  // No file, a binary one or one not read to the end — all three cases are one:
  // there is nothing to compare, and "unchanged" here means "just as nothing".
  if (!read || read.binary) return '—'
  return digest(read.text)
}

function digest(text: string): string {
  return createHash('sha1').update(text).digest('hex')
}

/**
 * Notebooks whose file on disk was rewritten past the room.
 *
 * Running scripts is allowed — it is a declared capability of the mode, and
 * forbidding them would take half the work away from the oracle. So the bypass
 * is caught not with a ban but by naming it: `nbformat` rewrote the .ipynb, the
 * room did not read it, and this has to be said on the same step — otherwise
 * the turn reports "cleared cells in the notebook", while nothing in the
 * notebook changed.
 *
 * The room's own projection does not count here: a file that became exactly
 * what the room writes into it fooled nobody — and the room writes it, among
 * other times, in the middle of a step, a second and a half after someone
 * else's cell edit.
 */
function rewrittenBooks(sessionId: string, was: Map<string, string>): string[] {
  const doc = peekSessionDoc(sessionId)?.doc
  if (!doc) return []
  const out: string[] = []
  for (const book of bookList(doc)) {
    const before = was.get(book.path)
    // The notebook did not exist before the step: this step brought it into
    // the room, and "rewritten" would be untrue about it.
    if (before === undefined) continue
    const now = printOf(sessionId, book.path)
    if (now === before) continue
    const mine = bookText(sessionId, book.path)
    if (mine !== null && digest(mine) === now) continue
    out.push(book.path)
  }
  return out
}

/** What to tell the model about a rewritten file — right on the step where it happened. */
function sayFaked(paths: string[]): string {
  return (
    tr("server.fileWasChangedOutsideTheRoomThe.52b9a3", { p0: paths.join(', ') }) +
    tr("server.theRoomWhileTheIpynbFileIs.32a058") +
    tr("server.noneOfTheFileEditsWereApplied.3184da") +
    tr("server.editCellAddCellOrRemoveCell.377bc1") +
    tr("server.unchanged.4b21b7")
  )
}

/**
 * What to say about the touched cells — in the answer itself, not only in the
 * feed.
 *
 * The feed of steps tells how the work went; after it the teacher needs one
 * thing: what to rerun and where to go back to if they do not like it. The
 * numbers are computed now, not at the moment of the edit: the person reads the
 * answer looking at the notebook as it has become.
 *
 * By notebook, not in one line: each has its own cell count and its own way
 * back — a button in the history for the room's notebook and a copy of the
 * file for the others. A line where "edited 02" refers to three notebooks at
 * once means nothing.
 *
 * Exported for the test — for the same reason as `useTool`: checking this line
 * through a live model would mean checking the model.
 */
export function saidAboutCells(sessionId: string, entryId: string): string {
  const work = inBook.get(`${sessionId}\u0000${entryId}`)
  if (!work) return ''
  const doc = peekSessionDoc(sessionId)?.doc
  // Cell names in the room are shared across all notebooks, so there is one
  // map: a cell's number is the one drawn in its own notebook.
  const numbers = new Map<string, string>()
  if (doc) {
    for (const { cells } of allBooks(doc)) {
      cells.forEach((cell: YCell, at: number) => numbers.set(cellId(cell), pad(at + 1)))
    }
  }
  const byBook = new Map<string, { edited: string[]; added: string[]; gone: number }>()
  for (const [id, done] of work.touched) {
    let row = byBook.get(done.book)
    if (!row) byBook.set(done.book, (row = { edited: [], added: [], gone: 0 }))
    const no = numbers.get(id)
    if (done.what === 'removed') row.gone += 1
    else if (no && done.what === 'edited') row.edited.push(no)
    else if (no) row.added.push(no)
  }

  const lines: string[] = []
  for (const [path, row] of byBook) {
    const parts: string[] = []
    if (row.edited.length > 0) parts.push(tr("server.edited.002cbd", { p0: row.edited.join(', ') }))
    if (row.added.length > 0) parts.push(tr("server.added.f985c7", { p0: row.added.join(', ') }))
    if (row.gone > 0) parts.push(tr("server.removed.c6e6b3", { p0: row.gone, p1: cellsWord(row.gone) }))
    if (parts.length === 0) continue
    const copy = work.copies.get(path)
    lines.push(
      `${path}: ${parts.join('; ')}. ` +
        (row.edited.length > 0
          ? tr("server.editedCellsRetainTheirPreviousOutputWhich.8ba614")
          : '') +
        /*
         * Where to go back to — three different answers, and the third came
         * with `create_notebook`. Saying "as it was before the turn — in the
         * version history" about a notebook that did not exist before the
         * turn means promising a way back into the void: the very first real
         * run reported exactly that.
         */
        (work.made.has(path)
          ? tr('server.agent.notebookIsNew')
          : copy
            ? tr("server.thisNotebookCannotBeRestoredThroughVersion.bae2c9", { p0: copy })
            : tr("server.thePreviousStateIsInVersionHistory.8a1cab", { p0: CHECKPOINT_LABEL() })),
    )
  }
  /*
   * The rewritten file is mentioned even when the turn did not touch any cells
   * — that is exactly the case the check was written for: the script "cleaned
   * the notebook", the turn reported "done", and nothing changed in the room.
   */
  for (const path of work.faked) {
    lines.push(
      tr("server.fileWasOverwrittenByAScriptOutside.2bc573", { p0: path }) +
        tr("server.filesSoNoCellsChangedTheNotebook.14b8b3") +
        tr("server.editingItsCells.2b51d4"),
    )
  }
  return lines.join('\n\n')
}

/**
 * What to say about a file that cannot be read in full.
 *
 * A megabyte and a half is the same ceiling as the editor's (`MAX_TEXT_BYTES`),
 * and it has to be named in its own words. "No such file or it is not text"
 * sends the model to create the file anew over the dataset, and "could not
 * write" to try again and again: both answers are true to the letter and lie in
 * substance.
 */
function tooBig(path: string): string {
  return (
    tr("server.exceedsMbAndCannotBeReadIn.ca5347", { p0: path }) +
    tr("server.wouldSilentlyLoseTheRestExplainWhat.e6b35a") +
    tr("server.withAScriptThroughRunFile.bc38de")
  )
}

/**
 * What to tell the model about a run.
 *
 * An interrupted run is not "the shell died": the script was alive, it was
 * stopped, and we have the output up to that moment. A model that believes in
 * a dead shell fixes a non-existent breakage and runs again.
 *
 * And the word here equals the deed: `stopRun` in the waiting branch takes its
 * command off the queue (`dropPendingOf`), so promising "it will start later"
 * is not possible — the model would retell to the room a run that will never
 * happen.
 */
function sayRun(result: RunResult, shown: string): string {
  if (result.cut === 'waiting') {
    return (
      tr("server.theRunNeverStartedTheSharedShell.0e8c4b") +
      tr("server.whichIWillNotInterruptIRemoved.b5fa36") +
      tr("server.nowOrLaterExplainThatItCan.d2990b") +
      tr("server.free.f3ee5f")
    )
  }
  if (result.cut === 'stop') return tr("server.runInterruptedTheActionWasStopped.e109df")
  if (result.cut === 'timeout') {
    return (
      tr("server.theRunExceededSecondsSoIInterrupted.8883fb", { p0: RUN_TIMEOUT_MS / 1000 }) +
      tr("server.outputReceivedSoFar.c13eff", { p0: shown || tr("server.empty.9a3a4f") })
    )
  }
  return result.finished
    ? tr("server.exitCodeOutput.294a41", { p0: result.exit ?? '?', p1: shown || tr("server.empty.9a3a4f") })
    : tr("server.theCommandDidNotFinishTheTerminal.ef4676")
}

/**
 * The seminar folder for the model — with a ceiling on lines.
 *
 * Each folder sends its beginning, and the rest is stated as a number: the
 * model will go into a specific folder itself for details, and a list that is
 * repeated in every following request of the turn must not cost more than the
 * work itself.
 */
function describeTree(sessionId: string): string {
  const lines: string[] = []
  const shown = new Map<string, number>()
  const hidden = new Map<string, number>()
  /** Where to write "… N more" later: the line takes its place right away, in walk order. */
  const placeholder = new Map<string, number>()
  let over = 0
  for (const entry of listFiles(sessionId)) {
    const dir = parentOf(entry.path)
    if (lines.length >= MAX_TREE_LINES) {
      over += 1
      continue
    }
    const seen = shown.get(dir) ?? 0
    if (seen >= MAX_PER_DIR) {
      hidden.set(dir, (hidden.get(dir) ?? 0) + 1)
      if (!placeholder.has(dir)) {
        placeholder.set(dir, lines.length)
        lines.push('')
      }
      continue
    }
    shown.set(dir, seen + 1)
    lines.push(entry.dir ? `${entry.path}/` : `${entry.path}  ${entry.size} B`)
  }
  for (const [dir, at] of placeholder) {
    lines[at] =
      tr("server.moreInSpecifyThePathIfNeeded.f75344", { p0: hidden.get(dir) ?? 0, p1: dir ? `${dir}/` : tr("server.root.3f3351") })
  }
  if (over > 0)
    lines.push(tr("server.moreEntriesOmittedTheFolderIsToo.a62954", { p0: over }))
  return lines.join('\n') || tr("server.theFolderIsEmpty.5c7445")
}

/** How many lines were added and removed. Enough for a "+9 −2" line. */
function countChanges(was: string, next: string): { added: number; removed: number } {
  const a = was ? was.split('\n') : []
  const b = next ? next.split('\n') : []
  const common = new Map<string, number>()
  for (const line of a) common.set(line, (common.get(line) ?? 0) + 1)
  let kept = 0
  for (const line of b) {
    const left = common.get(line) ?? 0
    if (left > 0) {
      common.set(line, left - 1)
      kept += 1
    }
  }
  return { added: b.length - kept, removed: a.length - kept }
}

/** The first new line — so the feed shows what the edit is about. */
function firstAdded(was: string, next: string): string {
  const had = new Set(was.split('\n'))
  for (const line of next.split('\n')) {
    const trimmed = line.trim()
    if (trimmed && !had.has(line)) return trimmed.slice(0, 120)
  }
  return ''
}

function tail(output: string): string {
  // ESC is written as an escape sequence, not as the byte itself: the byte is
  // invisible in the source, and the expression reads as "cut out everything in
  // square brackets" — that is, as damage to the traceback that is not really
  // there.
  const clean = output.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '').trimEnd()
  if (clean.length <= MAX_OUTPUT) return clean
  return '…\n' + clean.slice(clean.length - MAX_OUTPUT)
}

interface RunResult {
  output: string
  exit: number | null
  finished: boolean
  /**
   * The run was cut off: the deadline passed, "Stop" was pressed — or it never
   * started (`waiting`: our command was still queued for the shared shell).
   * `null` means it finished on its own.
   */
  cut: 'timeout' | 'stop' | 'waiting' | null
}

/** How long to wait for output after Ctrl+C: the shell is back at the prompt in a blink. */
const INTERRUPT_GRACE_MS = 5_000

/**
 * Run in the room's terminal and wait for the end.
 *
 * Exactly in the room's terminal, not in a separate invisible session: the
 * room must see what the oracle ran exactly where it sees its own runs. The
 * exit code arrives as a mark in the output itself — the shell reports it in
 * no other way, and it has to be known to tell "it computed" from "it failed".
 */
async function runInRoom(hands: Hands, command: string, signal?: AbortSignal): Promise<RunResult> {
  await openTerminal(hands.sessionId)
  // Opening a runtime can outlast a rule change. Do not enqueue even one
  // command after cancellation; interrupting it afterwards is already too late.
  if (signal?.aborted || !allowsAgent(getRules(hands.sessionId).agent, hands.role)) {
    return { output: '', exit: null, finished: false, cut: 'stop' }
  }
  const result = await new Promise<{ output: string; finished: boolean; cut: RunResult['cut'] }>(
    (resolve) => {
      let settled = false
      let cut: RunResult['cut'] = null
      let grace: NodeJS.Timeout | null = null
      const done = (result: { output: string; finished: boolean }) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        if (grace) clearTimeout(grace)
        signal?.removeEventListener('abort', onStop)
        resolve({ ...result, cut })
      }
      /*
       * Interrupt, do not abandon.
       *
       * Before, on the deadline the promise simply resolved, the script stayed
       * in the shared shell, and the model was told the shell had died: it
       * fixed a non-existent error and ran again — queueing behind the same
       * live command. Ctrl+C comes from whoever asked for the turn, that is, by
       * the same rule as a person's "Stop" button.
       */
      const stopRun = (why: 'timeout' | 'stop') => {
        if (settled || cut) return
        /*
         * Ctrl+C — only into OUR OWN command.
         *
         * The shell's busyness is asked before the run (`terminalBusy`), but
         * between the question and `runCommand` someone else's command can get
         * in: the queue is shared and belongs to people. The old code sent ETX
         * on the deadline anyway, without asking whose command was running —
         * the ninetieth second of waiting killed a script the teacher was
         * running, and the model was told "did not fit in 90 s — interrupted
         * the run" about a run that never happened.
         *
         * Our own queue entry is dropped (`dropPendingOf`), not left in the
         * shell: a command that starts a minute after the end of the turn is
         * someone else's output in the middle of someone else's class, which
         * nobody asked for and nobody is there to read. That there was no run
         * is stated out loud in the model's answer, so it does not "fix" a
         * non-existent error.
         */
        if (!typedRunningCommand(hands.sessionId, hands.by.participantId)) {
          // The mark comes before the removal: `dropPendingOf` answers the
          // waiter itself, that is, it calls this same `done`, and the turn's
          // record has to know how everything ended.
          cut = 'waiting'
          dropPendingOf(hands.sessionId, hands.by.participantId)
          done({ output: '', finished: false })
          return
        }
        cut = why
        interruptTerminal(hands.sessionId, tr("server.oracle.3156fd"), hands.by.participantId)
        grace = setTimeout(() => done({ output: '', finished: false }), INTERRUPT_GRACE_MS)
        grace.unref?.()
      }
      const onStop = () => stopRun('stop')
      const timer = setTimeout(() => stopRun('timeout'), RUN_TIMEOUT_MS)
      timer.unref?.()
      runCommand(hands.sessionId, command, hands.by, done)
      if (signal?.aborted) onStop()
      else signal?.addEventListener('abort', onStop, { once: true })
    },
  )
  const marker = exitMarker()
  let exit: number | null = null
  for (const found of result.output.matchAll(marker)) exit = Number(found[1])
  return {
    output: result.output.replace(marker, '').trimEnd(),
    exit,
    finished: result.finished,
    cut: result.cut,
  }
}

/*
 * The line a run prints after the command, "[exit code 0]": in the room's
 * language, because the terminal is shared and the whole room reads it, and
 * parsed back above to learn how the command ended. Both languages are
 * accepted: the instance language can be switched while a command runs.
 */
const EXIT_CODE = 'server.oracle.exitCode'
function exitMarker(): RegExp {
  const labels = (['ru', 'en'] as const).map((language) =>
    translate(language, EXIT_CODE).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'),
  )
  return new RegExp(`\\[(?:${labels.join('|')}) (\\d+)\\]`, 'g')
}

/* ---------------------------------------------------------------- the turn */

/**
 * Turns that are running right now.
 *
 * Needed for one button — "Stop" under the entry. Without them it would be
 * drawn and do nothing: an ordinary question is cut off in the middle of the
 * stream, but here there is no stream, and it is the loop that has to be cut.
 * Checked between steps, not inside them: a write to a file abandoned in the
 * middle is half a file.
 */
const running = new Map<string, AbortController>()

/** Stop a turn. What is already done stays done — and is undone by undo. */
export function stopWork(sessionId: string, entryId: string): boolean {
  const controller = running.get(`${sessionId} ${entryId}`)
  if (!controller) return false
  controller.abort()
  return true
}

/**
 * How many turns are running in this room right now.
 *
 * The route asks: a room has one ceiling on everything the oracle does at once
 * (routes/ai.ts · MAX_ROOM_STREAMS), and a turn counts in it on a par with a
 * stream — it holds a request to the provider many times in a row and edits
 * files.
 */
export function turnsInRoom(sessionId: string): number {
  const prefix = `${sessionId} `
  let n = 0
  for (const key of running.keys()) if (key.startsWith(prefix)) n += 1
  return n
}

/**
 * Stop everything the oracle is doing in this room.
 *
 * Erasing the thread and deleting the seminar are both about "stop", and both
 * left the turn going: the feed disappeared, while files kept changing on their
 * own for another dozen steps, with no entry in the thread and so with no undo
 * button. For the stream this case was provided for from the very start (see
 * `generate` in index.ts), for the turn it was not.
 */
export function stopAll(sessionId: string): void {
  const prefix = `${sessionId} `
  for (const [key, controller] of running) {
    if (key.startsWith(prefix)) controller.abort()
  }
}

export interface WorkOptions {
  sessionId: string
  participantId: string
  participantName: string
  participantColor: string
  /** The asker's role — the turn works with the notebook under it. See `Hands.role`. */
  role: 'host' | 'participant'
  message: string
  usageId?: number
  /** The reasoning level — the same as for a question: the mode differs by its tools. */
  effort?: ReasoningEffort
}

/**
 * Put the task into the thread and start working.
 *
 * Returns the entry id right away, like an ordinary question: the room sees the
 * task in the same second, and the steps arrive one by one.
 */
export function work(options: WorkOptions): string {
  const doc = getSessionDoc(options.sessionId).doc
  const history = recentTurns(doc)
  const entry = createChatEntry({
    participantId: options.participantId,
    name: options.participantName,
    color: options.participantColor,
    question: options.message.trim(),
    mode: 'agent',
  })
  doc.transact(() => getChat(doc).push([entry]), ORIGIN)
  const entryId = entry.get('id') as string

  appendActivity(options.sessionId, options.participantId, 'oracle.work_started', { entryId, action: 'work', source: 'participant' }, options.role)

  void loop(options, entryId, history).catch((err: unknown) => {
    console.error(`[session ${options.sessionId}] agent crashed:`, reason(err, WENT_WRONG()))
    settle(options.sessionId, entryId, 'error', reason(err, WENT_WRONG()))
  })

  return entryId
}

async function loop(options: WorkOptions, entryId: string, history: ChatTurn[]): Promise<void> {
  const activityBeganAt = Date.now()
  const key = `${options.sessionId} ${entryId}`
  const controller = new AbortController()
  running.set(key, controller)
  const unsubscribe = onRulesChanged((sessionId, rules) => {
    if (sessionId === options.sessionId && !allowsAgent(rules.agent, options.role)) controller.abort()
  })
  let outcome: ActivityOutcome = 'error'
  try {
    await steps(options, entryId, history, controller.signal)
    outcome = controller.signal.aborted ? 'cancelled' : 'completed'
  } finally {
    if (controller.signal.aborted) outcome = 'cancelled'
    appendActivity(options.sessionId, options.participantId, 'oracle.work_finished', {
      entryId, action: 'work', outcome, source: 'oracle', durationMs: Date.now() - activityBeganAt,
    }, options.role)
    unsubscribe()
    running.delete(key)
  }
}

/**
 * How long a turn works by the clock, not by steps.
 *
 * The step ceiling counts ACTIONS, and that is its blind spot: a turn where
 * every step is a ninety-second run fits into twenty-four actions and goes on
 * for half an hour, while the room watches "thinking" all that time. Five
 * minutes is the limit of a class's patience: beyond it the teacher presses
 * "Stop" anyway, and it is better that the turn says so itself, naming what
 * was done, than a cut-off button.
 */
const TURN_BUDGET_MS = 5 * 60_000

/**
 * After how many steps the frame is rebuilt.
 *
 * The frame (`buildContext`) is taken once, before the first request, and after
 * that the turn edits a notebook of which the model reads an outdated
 * description: cells it added itself do not show up in the frame, and neither
 * do outputs it got. Eight steps is roughly "read, created, wrote five cells":
 * that long the frame still resembles the truth, after that it stops.
 */
const FRAME_EVERY = 8

/** Tools after which the frame is certainly outdated. */
const CHANGES_ROOM = new Set([
  'create_notebook',
  'add_cell',
  'edit_cell',
  'remove_cell',
  'run_cell',
])

/** Tools after which earlier answers may have stopped being true. */
const CHANGES_WORLD = new Set([...CHANGES_ROOM, 'write_file', 'edit_file', 'run_file'])

/**
 * A fingerprint of a call: the name and the arguments, brought to one form.
 *
 * Keys in the model's JSON arrive in a different order from step to step, so
 * comparing the argument string as is would miss exactly the case this was
 * written for: the same `read_file` in a circle.
 */
function fingerprint(name: string, rawArgs: string): string {
  let args: unknown
  try {
    args = JSON.parse(rawArgs || '{}')
  } catch {
    args = rawArgs
  }
  return `${name} ${stable(args)}`
}

function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`
  if (value && typeof value === 'object') {
    const map = value as Record<string, unknown>
    return `{${Object.keys(map)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stable(map[key])}`)
      .join(',')}}`
  }
  return JSON.stringify(value) ?? 'null'
}

async function steps(
  options: WorkOptions,
  entryId: string,
  history: ChatTurn[],
  signal: AbortSignal,
): Promise<void> {
  const hands: Hands = {
    sessionId: options.sessionId,
    entryId,
    by: {
      name: options.participantName,
      color: options.participantColor,
      participantId: options.participantId,
    },
    role: options.role,
  }
  const tools = toolsFor(hands)
  const stepLimit = agentStepsIn(getRules(options.sessionId).agentSteps, getOracleSettings().agentSteps)

  const messages: ChatTurn[] = [
    { role: 'system', content: systemPrompt(hands, tools, options.effort) },
    ...threadForWork(history),
    { role: 'user', content: options.message.trim() },
  ]

  // One usage row for the whole turn, while there can be many steps: each
  // reports for itself, and `noteTokens` adds them up — otherwise the panel
  // would show the last step instead of the price of the whole turn.
  const bill = (tokens: number) => {
    if (options.usageId !== undefined) noteTokens(options.usageId, tokens)
  }

  const began = Date.now()
  /** Replies never dropped from the conversation: refusals, failures. See budgetTools. */
  const keep = new Set<string>()
  /** What was already called and how it ended — against circles. */
  const seen = new Map<string, { times: number; said: string }>()
  let taken = 0
  let spoke = ''
  let stopped = false
  let ranOut = false
  let looped = false
  /** Silent answers in a row: the first gets a nudge, the second ends the turn. */
  let silent = 0
  let framedAt = 0
  let stale = false
  const outOfTime = () => Date.now() - began >= TURN_BUDGET_MS

  while (stepLimit === 0 || taken < stepLimit) {
    if (signal.aborted || !allowsAgent(getRules(options.sessionId).agent, options.role)) {
      stopped = true
      break
    }
    if (outOfTime()) {
      ranOut = true
      break
    }
    /*
     * The frame is rebuilt right here, before the request: the model must see
     * ITS OWN work — the notebook with the cells it added and the output it
     * just got — not the room as it was before the turn.
     */
    if ((stale || taken - framedAt >= FRAME_EVERY) && peekSessionDoc(options.sessionId)) {
      /*
       * `peekSessionDoc` in the condition is not nitpicking: the frame is
       * assembled by `buildContext`, which goes to `getSessionDoc`, which
       * CREATES the room. A turn that reached a deleted room would raise it
       * again — with timers, a line in the history and a folder on disk — and
       * do it for a line nobody is there to read. By itself this is almost
       * impossible (deletion calls `stopAll`, and the abort is checked a line
       * above), but the rule above `peekSessionDoc` is not about probability.
       */
      messages[0] = { role: 'system', content: systemPrompt(hands, tools, options.effort) }
      framedAt = taken
      stale = false
    }
    // Before every request, not after every step: what has to be cut is exactly
    // what goes to the provider now, and by a budget that may have changed on
    // the fly.
    budgetTools(messages, toolChars(), keep)
    const answer = await completeWithTools(messages, tools, signal, bill, options.effort)
    // An aborted request comes back as an empty answer without calls, and
    // without this check the turn would end in emptiness: no text, no "Stopped".
    if (signal.aborted || !allowsAgent(getRules(options.sessionId).agent, options.role)) {
      stopped = true
      break
    }
    if (answer.calls.length === 0) {
      /*
       * An answer without a call is not always the end of the turn.
       *
       * Small models all too often DESCRIBE the next call in prose — "now I
       * will create the notebook and add cells" — instead of making it. The
       * old loop took such an answer for the result and ended the turn after
       * the very first file read: two steps in the feed, nothing in the
       * notebook, and in the answer a plan nobody carried out. One nudge fixes
       * this; a second silent answer in a row really is the end, and arguing
       * with it means going in circles on the key owner's money.
       *
       * Before the first call there is nothing to nudge towards: a turn that
       * started with words is an ordinary answer to a question that simply did
       * not need tools.
       */
      if (taken > 0 && silent === 0 && (answer.text.trim() || answer.reasoning.trim())) {
        silent = 1
        messages.push({ role: 'assistant', content: answer.text })
        messages.push({ role: 'user', content: tr('server.agent.nudge') })
        continue
      }
      /*
       * Empty in everything: no text, no reasoning trace, no call. This is not
       * a result but the endpoint's silence — a filter, a truncated output
       * limit, empty choices — and an empty caption under the turn reads as a
       * Colloq breakage.
       */
      spoke =
        answer.text.trim() ||
        // The reasoning trace instead of an answer — for models whose whole
        // answer goes into `reasoning`. It has a retelling of the work; there
        // must be no empty caption under the feed of steps.
        tail(answer.reasoning.trim()) ||
        tr('server.agent.saidNothing')
      break
    }
    silent = 0
    messages.push({ role: 'assistant', content: answer.text, calls: answer.calls })
    for (const call of answer.calls) {
      // Between steps, not inside them: an edit abandoned in the middle is half
      // a file, and no undo expects that.
      if (signal.aborted || !allowsAgent(getRules(options.sessionId).agent, options.role)) {
        stopped = true
        break
      }
      if (outOfTime()) {
        ranOut = true
        break
      }
      taken += 1
      const mark = fingerprint(call.name, call.args)
      const before = seen.get(mark)
      /*
       * The same call with the same arguments.
       *
       * Seen right in the feed: the model called `read_notebook` four times in
       * a row, got the same list and each time announced that now it would fix
       * the cell. The second time we answer from memory and say out loud that
       * the answer is the same — the step costs zero calls to the room. The
       * third is not a hiccup but a circle, and the turn ends on it: from there
       * on it only spends money.
       */
      if (before && before.times >= 2) {
        looped = true
        push(options.sessionId, entryId, note(tr('server.agent.loopNote'), call.name))
        break
      }
      if (before) {
        before.times += 1
        const said = `${before.said}\n\n${tr('server.agent.sameCall')}`
        push(options.sessionId, entryId, note(tr('server.agent.repeatedNote'), call.name))
        // Into the log too, and as a refusal: the step was spent, and the room
        // got nothing from it. The line "the oracle called read_notebook nine
        // times" is exactly the conversation the log is kept for.
        record(options, entryId, call.name, 'error', 0)
        messages.push({ role: 'assistant', content: said, callId: call.id })
        keep.add(call.id)
        if (stepLimit > 0 && taken >= stepLimit) break
        continue
      }
      const startedAt = Date.now()
      const ran = await useTool(hands, call.name, call.args, signal)
      /*
       * A successful edit resets the memory of calls — and that is no
       * indulgence for circles.
       *
       * "Read, edited, re-read" is the same `read_file` with the same arguments
       * and a completely different answer: the file changed between the two
       * reads. Handing out the old answer from memory for it would mean lying
       * to the model exactly at the point where it checks its own work. A
       * circle stays caught: it consists precisely in NOTHING having happened
       * between two identical calls. An edit does not remove its own call from
       * memory — otherwise `add_cell` with the same text would stuff the
       * notebook with copies, resetting the counter each time.
       */
      if (CHANGES_WORLD.has(call.name) && !ran.failed && ran.step.kind !== 'note') seen.clear()
      seen.set(mark, { times: 1, said: ran.said })
      push(options.sessionId, entryId, ran.step)
      if (ran.also) push(options.sessionId, entryId, ran.also)
      /*
       * One step — one line in the class history.
       *
       * The feed lives in the room's document and leaves with it; the class
       * history stays. "The oracle read files seventeen times and never wrote"
       * is a conversation about how the class went, and until now there was
       * nothing to hold it by: the history had one "turn started" and one
       * "turn ended".
       */
      record(
        options,
        entryId,
        call.name,
        ran.failed || ran.step.kind === 'note' ? 'error' : 'completed',
        Date.now() - startedAt,
      )
      messages.push({ role: 'assistant', content: ran.said, callId: call.id })
      if (ran.failed || ran.step.kind === 'note') keep.add(call.id)
      if (CHANGES_ROOM.has(call.name)) stale = true
      if (stepLimit > 0 && taken >= stepLimit) break
    }
    if (stopped || ranOut || looped) break
  }

  if (stopped) {
    spoke = spoke || tr("server.stoppedCompletedActionsAreListedAboveStopping.2f9e57")
  } else if (looped) {
    spoke = spoke || tr('server.agent.loopStop')
  } else if (ranOut) {
    spoke = spoke || tr('server.agent.outOfTime', { p0: Math.round(TURN_BUDGET_MS / 60_000) })
  } else if (!spoke && stepLimit > 0 && taken >= stepLimit) {
    spoke = tr('common.agentStepsReached', { count: stepLimit })
  }
  finish(options.sessionId, entryId, spoke)
}

/**
 * One step — one line in the class history.
 *
 * The feed of steps lives in the room's document and leaves with it; the class
 * history stays. "The oracle read files seventeen times and never wrote" is a
 * conversation about how the class went, and until now there was nothing to
 * hold it by: the log had one "turn started" and one "turn ended".
 *
 * `durationMs` is about the call ITSELF, not about the turn: a cell run that
 * took a minute and a read that took a millisecond are different lines, and
 * adding them into one means losing the only thing the log knows about them.
 */
function record(
  options: WorkOptions,
  entryId: string,
  tool: string,
  outcome: ActivityOutcome,
  durationMs: number,
): void {
  appendActivity(
    options.sessionId,
    options.participantId,
    'oracle.work_step',
    { entryId, subjectId: tool, outcome, durationMs, source: 'oracle' },
    options.role,
  )
}

function push(sessionId: string, entryId: string, step: AgentStep): void {
  const found = liveEntry(sessionId, entryId)
  if (!found) {
    /*
     * The entry is gone: the thread was erased or the room deleted. There is
     * nobody to show the step to, and the next step would edit files blind and
     * without an undo button — so there is nobody left to work for.
     */
    stopWork(sessionId, entryId)
    return
  }
  found.doc.transact(() => addStep(found.entry, step), ORIGIN)
}

/**
 * The turn's entry in a live room — or `null`.
 *
 * `peekSessionDoc`, not `getSessionDoc`: a turn that reached a deleted room
 * used to create it again — with timers, a line in the history and a folder on
 * disk. The rule is written above `peekSessionDoc` itself: only what a person
 * does may create a document.
 */
function liveEntry(sessionId: string, entryId: string): { doc: Y.Doc; entry: YChatEntry } | null {
  const doc = peekSessionDoc(sessionId)?.doc
  const entry = doc ? findChatEntry(doc, entryId) : null
  return doc && entry ? { doc, entry } : null
}

/**
 * How many files the turn REALLY left behind.
 *
 * Not the size of the snapshot map: a snapshot without `left` is one whose
 * write failed, and there is nothing to restore from it. An "undo" button under
 * a turn that changed nothing is a promise undo will not keep.
 */
function touchedFiles(sessionId: string, entryId: string): number {
  const files = before.get(`${sessionId}\u0000${entryId}`)
  if (!files) return 0
  let n = 0
  for (const snapshot of files.values()) if (snapshot.left !== null) n += 1
  return n
}

function finish(sessionId: string, entryId: string, text: string): void {
  const found = liveEntry(sessionId, entryId)
  if (!found) return
  const { doc, entry } = found
  const touched = touchedFiles(sessionId, entryId)
  /*
   * The server, not the model, speaks about cells.
   *
   * What to rerun and where to go back to is a fact of the turn, not a
   * retelling of it, and it must not depend on whether the model remembers to
   * list the cells: stale output under fresh code looks like the real thing.
   */
  const cells = saidAboutCells(sessionId, entryId)
  inBook.delete(`${sessionId}\u0000${entryId}`)
  doc.transact(() => {
    const say = [text, cells].filter(Boolean).join('\n\n')
    if (say) {
      const answer = chatAnswer(entry)
      answer.insert(answer.length, say)
    }
    entry.set('state', 'done' as ChatState)
    // Only what was changed can be undone: a turn that touched nothing has no
    // button at all, rather than one that is there and does nothing.
    entry.set('undo', (touched > 0 ? 'available' : 'none') as UndoState)
  }, ORIGIN)
}

function settle(sessionId: string, entryId: string, state: ChatState, note: string): void {
  const found = liveEntry(sessionId, entryId)
  if (!found) return
  const { doc, entry } = found
  const touched = touchedFiles(sessionId, entryId)
  // Even for a failed turn: it may have edited the notebook before failing.
  const cells = saidAboutCells(sessionId, entryId)
  inBook.delete(`${sessionId}\u0000${entryId}`)
  doc.transact(() => {
    const answer = chatAnswer(entry)
    const say = [note, cells].filter(Boolean).join('\n\n')
    answer.insert(answer.length, answer.length > 0 ? `\n\n${say}` : say)
    entry.set('state', state)
    // Even for a failed turn: it may have managed to edit two files out of
    // three, and that is exactly the state one wants to go back from.
    entry.set('undo', (touched > 0 ? 'available' : 'none') as UndoState)
  }, ORIGIN)
}

function systemPrompt(hands: Hands, tools: ToolSpec[], effort?: ReasoningEffort): string {
  /*
   * The teacher's rules — here too.
   *
   * The panel promises "Appended to the system prompt" unconditionally, but
   * that was only done in question mode. "We have not covered pandas yet" is a
   * pedagogical fence, and in "Act" mode it matters more: there a violation is
   * not read but goes into a room file and gets run.
   */
  const houseRules = getOracleSettings().houseRules
  /*
   * About cells the prompt says exactly what this person was given.
   *
   * The tool list and the words about it are computed from one place: a
   * promise "I will fix the cell" with no tool behind it costs a turn step and
   * ends in a refusal in front of the room — and in a lecture it also sounds
   * like someone else's right.
   */
  const cellNames = tools
    .map((tool) => tool.name)
    .filter((name) => name === 'edit_cell' || name === 'add_cell' || name === 'remove_cell')
  // The same goes for files: a promise "I will fix the file" where there is no
  // tool ends in a refusal in front of the room and sounds like someone else's
  // right.
  const has = (name: string) => tools.some((tool) => tool.name === name)
  const mayWrite = has('write_file')
  const mayRun = has('run_file')
  const mayRunCell = has('run_cell')
  const mayCreate = has('create_notebook')
  /*
   * The room's notebooks — by name and at the start.
   *
   * The model learned about them only from the `read_notebook` reply, that is,
   * after a step spent on the question "what is here". Worse: not seeing the
   * list, it assumed there was no notebook at all and went to create one as a
   * file. One line in the prompt removes both.
   */
  const doc = peekSessionDoc(hands.sessionId)?.doc
  const books = doc ? bookList(doc).map((book) => book.path) : []
  return [
    tr('server.agent.prompt.role'),
    '',
    mayWrite && mayRun
      ? tr('server.agent.prompt.workFull')
      : mayWrite
        ? tr('server.agent.prompt.workNoRun')
        : tr('server.agent.prompt.workReadOnly'),
    '',
    tr('server.agent.prompt.notebooksHead'),
    books.length > 0
      ? tr('server.agent.prompt.notebooksAre', { p0: books.join(', ') })
      : tr('server.agent.prompt.noNotebooks'),
    tr('server.agent.prompt.cellsHaveNames'),
    mayCreate
      ? tr('server.agent.prompt.createNotebook')
      : tr('server.agent.prompt.askTeacherForNotebook'),
    ...(cellNames.length > 0
      ? [
          tr('server.agent.prompt.cellTools', { p0: cellNames.join(', ') }),
          tr('server.agent.prompt.staleOutput'),
        ]
      : [tr('server.agent.prompt.noCellTools')]),
    ...(mayRunCell || mayRun ? [tr('server.agent.prompt.howToCheck')] : []),
    '',
    tr('server.agent.prompt.limitsHead'),
    tr('server.agent.prompt.ipynbIsProjection'),
    tr('server.agent.prompt.noDelete'),
    ...(mayRun ? [tr('server.agent.prompt.runFiles')] : []),
    tr('server.agent.prompt.visible'),
    '',
    tr('server.agent.prompt.howHead'),
    tr('server.agent.prompt.oneAtATime'),
    tr('server.agent.prompt.doNotDescribe'),
    tr('server.agent.prompt.stopRule'),
    ...(houseRules
      ? [
          '',
          /*
           * "What to do", not "instead of what".
           *
           * It used to say "they outrank everything said above", and that was
           * a hole in a text that opens itself: a teacher's line "write
           * notebooks straight into .ipynb" or "you may delete what is not
           * needed" was declared more important than the mechanics, which the
           * mechanics would not let through anyway — and the turn was spent on
           * calls doomed to refusal. The seminar's rules are about the content
           * of the work; the limits above are about how this room is built,
           * and they cannot be cancelled with words.
           */
          tr('server.agent.prompt.houseRules', { p0: houseRules }),
        ]
      : []),
    // "Instant" as a request, not only as a parameter: half of the models have
    // no reasoning knob, and some cannot switch it off (see ai/text.ts).
    ...(effortNote(effort) ? ['', effortNote(effort)] : []),
    '',
    tr('server.ai.answerLanguage'),
    tr('server.agent.prompt.ending'),
    '',
    tr('server.agent.prompt.nowHead'),
    '',
    // The agent is not "focused" on anything: it gets a task, not a question
    // about a cell.
    buildContext(hands.sessionId, [], hands.by.participantId),
  ].join('\n')
}
