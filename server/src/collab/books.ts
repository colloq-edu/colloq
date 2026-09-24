import { tr } from '@shared/i18n'
/**
 * Notebooks and the seminar folder: how one becomes visible in the other.
 *
 * A notebook lives in the room's document — with a snapshot in the database,
 * version history and a cache in the browsers. The file on disk is its
 * PROJECTION: it is written from the document and never read back while the
 * notebook is open. There is one direction, and that is a decision, not
 * unfinished work.
 *
 * Why not both ways, as with text files. For text, merging two edits is gluing
 * by the common head and tail, and it is harmless. For a notebook, "merging"
 * would mean working out which cell corresponds to which, while a cell carries
 * a name, output, an execution number and other people's cursors inside. A
 * wrongly guessed correspondence erases work silently — and there is nothing to
 * guess right with: an .ipynb on disk does not store cell names.
 *
 * Hence two consequences, named out loud in the interface:
 * — writing over a notebook file is impossible, either by upload or by the
 *   oracle: the projection would bring its own back within a second anyway,
 *   and that would look like a loss;
 * — opening an .ipynb that was put into the folder means BRINGING it into the
 *   room: the cells move into the document, and from then on the truth is
 *   there.
 */
import * as Y from 'yjs'
import {
  addBook,
  allBooks,
  allCellArrays,
  bookAt,
  bookCells,
  bookList,
  BOOKS_KEY,
  CELLS_KEY,
  createCell,
  getMeta,
  readCell,
  removeBook,
  renameBook,
  rootForNewBook,
  type Book,
} from '@shared/notebook'
import { parseIpynb, writeIpynb, type FlatCell } from '@shared/ipynb'
import { baseOf, isInside, kindOf } from '@shared/paths'
import { MAX_BOOK_OWNER_NAME, MAX_OWN_BOOKS, type BookRule } from '@shared/rules'
import { shelveCellImages, withInlinedImages } from '../notebook-images.js'
import { getRules, isFinished, setRules, storedRules } from '../db.js'
import { getSessionDoc, peekSessionDoc } from './index.js'
import { makeFile, readText, statPath, writeText } from '../workspace.js'

const ORIGIN = 'server'

/**
 * How long to wait after the last edit before rewriting the file.
 *
 * A second and a half, not seven hundred milliseconds as for text: a notebook
 * is serialized whole, and in a class where twenty people type into different
 * cells, that is noticeable work on every keystroke. The file is needed not by
 * whoever types but by whoever later downloads it or reads it from a cell.
 */
const WRITE_AFTER_MS = 1_500

/** Cells in a notebook we agree to bring into the room. */
const MAX_IMPORT_CELLS = 500

/**
 * Bytes in a notebook file we agree to parse.
 *
 * A measure of its own, larger than the editor's (`MAX_TEXT_BYTES`, a megabyte
 * and a half). That one applies where a file is edited character by character,
 * and a megabyte and a half is already the limit for CodeMirror. Nobody edits a
 * notebook character by character: it is parsed ONCE, only the type and text of
 * cells are taken from it, and the outputs — that is, almost all of its weight
 * — are dropped on import. A notebook with a dozen matplotlib images weighs a
 * few megabytes and is a perfectly ordinary teacher's notebook; the editor's
 * ceiling refused it with the words "does not look like an .ipynb".
 *
 * The price is named: thirty-two megabytes is about half a second of
 * `JSON.parse` blocking the event loop, once per click in the tree. More than
 * that is no longer a notebook for a class, and that is said out loud.
 */
const MAX_BOOK_BYTES = 32 * 1024 * 1024

const pending = new Map<string, NodeJS.Timeout>()

/**
 * The notebook's flat cells — what goes into the file.
 *
 * The id travels with them: schema 4.5 requires it for every cell, and without
 * it `writeIpynb` substitutes a sequence number — and a file rewritten after
 * two cells were swapped would change the names of everyone below them.
 */
function flatten(cells: Y.Array<any>): FlatCell[] {
  return cells.map((cell) => {
    const read = readCell(cell)
    return { id: read.id, type: read.type, source: read.source }
  })
}

/**
 * The same, but for the FILE: note images come back as attachments.
 *
 * In the document they are a link to the room's shelf (shared/images.ts) — that
 * is what the link is for — while a file is taken away and opened with
 * anything. Without this, a notebook with picture problem statements would
 * reach the student as empty frames.
 *
 * A separate function, not a flag on `flatten`, because the second reader of a
 * notebook is the oracle (`bookText`), and a model request does not need a
 * decoded megabyte of image; one was never sent.
 */
function flattenForFile(sessionId: string, cells: Y.Array<any>): FlatCell[] {
  return withInlinedImages(sessionId, flatten(cells))
}

/**
 * Rewrite the files of all the room's notebooks.
 *
 * All of them, not the one that changed: comparing with what is already on disk
 * is cheaper than parsing the event, and a room has a handful of notebooks. A
 * file that did not change is not rewritten — otherwise its modification time
 * would twitch on every keystroke and the file panel would blink all class
 * long.
 */
export function projectBooks(sessionId: string): boolean {
  // Peek, do not create: the room may have been closed while the timer waited,
  // and rebuilding it to write a file would mean resurrecting what was deleted.
  const open = peekSessionDoc(sessionId)
  if (!open) return false
  const { doc } = open
  let wrote = false
  for (const { book, cells } of allBooks(doc)) {
    const text = writeIpynb(flattenForFile(sessionId, cells))
    const now = readText(sessionId, book.path)
    if (now && !now.binary && now.text === text) continue
    if (writeText(sessionId, book.path, text)) wrote = true
  }
  return wrote
}

function schedule(sessionId: string): void {
  if (pending.has(sessionId)) return
  const timer = setTimeout(() => {
    pending.delete(sessionId)
    try {
      /*
       * The room is told only about what really landed on disk.
       *
       * `filesChanged` is a walk over the whole folder (readdir + lstat per
       * entry) and the full file tree into EVERY socket of the room. Sending
       * it after a projection that compared the text and rewrote nothing
       * means paying that for every keystroke in the notebook: in a class of
       * five hundred the tree went out to everyone every second and a half
       * while the disk did not change.
       */
      if (projectBooks(sessionId)) filesChanged?.(sessionId)
    } catch (err) {
      console.error(`[books] could not write the notebook for ${sessionId}:`, err)
    }
  }, WRITE_AFTER_MS)
  timer.unref?.()
  pending.set(sessionId, timer)
}

let filesChanged: ((sessionId: string) => void) | null = null

/** Whom to tell that the files changed. Registered by control.ts. */
export function onBooksWritten(listener: (sessionId: string) => void): void {
  filesChanged = listener
}

/**
 * Watch this room's notebooks and keep their files in order.
 *
 * Called once per room, from `getSessionDoc`. One observer on the whole
 * document, not one per root: notebooks come and go, and resubscribing on every
 * appearance is one more place where one can forget to unsubscribe.
 */
export function watchBooks(sessionId: string, doc: Y.Doc): () => void {
  const onUpdate = (
    _update: Uint8Array,
    _origin: unknown,
    _doc: Y.Doc,
    transaction: Y.Transaction,
  ) => {
    if (!touchesBooks(doc, transaction)) return
    schedule(sessionId)
  }
  doc.on('update', onUpdate)
  // The first write happens right away: a room opened after a server restart
  // must show the notebook's file in the tree without waiting for someone to
  // type something in it.
  schedule(sessionId)
  return () => {
    doc.off('update', onUpdate)
    const timer = pending.get(sessionId)
    if (timer) clearTimeout(timer)
    pending.delete(sessionId)
  }
}

/**
 * Whether this update changed WHAT IS IN THE notebook's FILE.
 *
 * The file holds only the set of notebooks, the cell type and its text
 * (`writeIpynb`). Everything else that lives in the same document does not get
 * there: a cell's output, the run state, the `In[]` number, terminal lines, the
 * oracle's answer, presence.
 *
 * Before, there was `if (origin === PROJECTION) return` here with the promise
 * "our own projection does not wake itself" — an unreachable branch (the
 * projection writes to disk, not to the document, and nobody creates
 * transactions with that origin), so NOTHING was filtered out. A cell printing
 * in a loop triggered a notebook write every second and a half, and with it a
 * folder walk and the file tree for the whole room, although output does not
 * change a byte on disk.
 *
 * The check is structural, not by origin: a list of other origins would drift
 * from the code at the very first new write into the document, and drift
 * silently — towards "the file did not update".
 */
function touchesBooks(doc: Y.Doc, transaction: Y.Transaction): boolean {
  const meta: unknown = getMeta(doc)
  const books = getMeta(doc).get(BOOKS_KEY)
  const sheets = new Set<unknown>(allCellArrays(doc))
  let hit = false
  transaction.changed.forEach((keys, type) => {
    if (hit) return
    // A cell was added, removed or moved; a notebook was opened or closed.
    if (sheets.has(type) || type === books) hit = true
    else if (type === meta) hit = keys.has(BOOKS_KEY)
    // The cell type is a key in its own map; the text is a `Y.Text` inside it.
    else if (type instanceof Y.Map) hit = sheets.has(type.parent) && keys.has('type')
    else if (type instanceof Y.Text) hit = sheets.has(type.parent?.parent)
  })
  return hit
}

/* ------------------------------------------------- who created this notebook */

/**
 * Who creates a notebook — in case it is not the teacher.
 *
 * Not `TokenPayload` and not a participant from the database: exactly as much
 * arrives here as the author record needs, and not a line more. The name is
 * taken AS OF THIS MOMENT — see `BookRule.ownerName`, which explains why it is
 * not looked up later.
 */
export interface BookAuthor {
  participantId: string
  name: string
  role: 'host' | 'participant'
}

let rulesChanged: ((sessionId: string) => void) | null = null

/**
 * Whom to tell that the room's rules changed by themselves.
 *
 * Registered by control.ts — the same way as `onBooksWritten` above, and for
 * the same reason: broadcasting lives in control.ts, and control.ts imports
 * this module. A direct call would close an import loop.
 */
export function onBookRulesChanged(listener: (sessionId: string) => void): void {
  rulesChanged = listener
}

/**
 * One door for all the ways to create a notebook in a room.
 *
 * There are four ways — an empty notebook from the tree, bringing in an .ipynb
 * put into the folder, the same by the oracle's hands, and import — and they
 * have one rule: students' own notebooks are either allowed or not
 * (shared/rules.ts · ownBooks). The check lives here, not at each door, for
 * exactly that reason: four copies of one question are three places where
 * someone will one day forget to ask.
 *
 * Returns the REASON for a refusal, or `null` if allowed. The reason is human:
 * a button that silently does nothing reads as a breakage.
 *
 * The teacher passes straight through: the rules are about what the CLASS may
 * do.
 */
function whyNotAddBook(sessionId: string, doc: Y.Doc, by: BookAuthor): string | null {
  if (by.role === 'host') return null
  /*
   * Effective rules, not stored ones: after the bell `ownBooks` arrives
   * switched off (shared/rules.ts · rulesAfterClass), and there is no separate
   * end-of-class check here on purpose — it would be a second copy of the same
   * boundary. The words are its own, though: it matters to the person that the
   * class is over.
   */
  if (isFinished(sessionId)) return tr('server.classOverPeriod')
  if (getRules(sessionId).ownBooks !== 'on') return tr('server.ownBooksAreOff')
  const mine = ownBooksOf(sessionId, doc, by.participantId)
  if (mine >= MAX_OWN_BOOKS) {
    return tr('server.ownBooksLimit', { p0: MAX_OWN_BOOKS })
  }
  return null
}

/**
 * How many of their OWN notebooks this person has in the room right now.
 *
 * By live entries: a notebook that was removed does not take up the ceiling —
 * otherwise three drafts a semester would lock a student out forever. Counted
 * by the rules map, not by files: the author lives there (`BookRule.owner`),
 * and only there.
 */
export function ownBooksOf(sessionId: string, doc: Y.Doc, participantId: string): number {
  const books = liveBookRules(doc, storedRules(sessionId).books)
  return Object.values(books).filter((rule) => rule.owner === participantId).length
}

/**
 * Record the author of a notebook just CREATED (createBook), not of any
 * notebook brought into the room.
 *
 * The SERVER writes it, and only for a non-teacher: a notebook created by the
 * teacher is not signed with an author — they can do everything in it anyway,
 * and a "personal notebook: Ivan Petrovich" line in the menu would be an offer
 * to take the notebook away from themselves. Such a notebook stays "as in the
 * room", and the same goes for notebooks students created before this record
 * appeared.
 *
 * The access of a student's own notebook is `owner` right away, and it has no
 * other value: "own notebook" and "personal" are one and the same right,
 * `ownBooks` allows it, and we get here already allowed (`whyNotAddBook`). The
 * teacher later changes the access of any notebook from the menu.
 *
 * Along the way the map is cleaned of roots that are no longer in the
 * document: a notebook is removed from the room by a click on the file, while
 * the rules live in the database and will not learn about it by themselves.
 * The cleaning is exactly here and in `dropBook` — that is, in both places
 * where the map and the list of notebooks drift apart.
 */
function rememberAuthor(sessionId: string, doc: Y.Doc, root: string, by: BookAuthor): void {
  if (by.role === 'host') return
  const stored = storedRules(sessionId)
  const rule: BookRule = {
    access: 'owner',
    owner: by.participantId,
    ownerName: by.name.trim().slice(0, MAX_BOOK_OWNER_NAME) || null,
  }
  setRules(sessionId, { ...stored, books: { ...liveBookRules(doc, stored.books), [root]: rule } })
  rulesChanged?.(sessionId)
}

/**
 * Whether this is one's own personal notebook — and whether this person may
 * remove it.
 *
 * Removing notebooks from the room is the teacher's right, and it stays so;
 * here is one exception, without which "own notebook" would be a half-truth: a
 * draft you created yourself, which counts against your own ceiling, must be
 * removable by you. Someone else's personal one — no; the room's notebook — no.
 */
export function ownsBookAt(sessionId: string, path: string, participantId: string): boolean {
  const doc = peekSessionDoc(sessionId)?.doc
  if (!doc) return false
  const book = bookAt(doc, path)
  if (!book) return false
  const rule = storedRules(sessionId).books?.[book.root]
  return rule?.access === 'owner' && rule.owner === participantId
}

/** Map entries whose notebook still exists in the document. */
function liveBookRules(
  doc: Y.Doc,
  books: Record<string, BookRule> | undefined,
): Record<string, BookRule> {
  if (!books) return {}
  const alive = new Set(bookList(doc).map((book) => book.root))
  const out: Record<string, BookRule> = {}
  for (const [root, rule] of Object.entries(books)) if (alive.has(root)) out[root] = rule
  return out
}

/* ------------------------------------------------------- bring into the room */

export type OpenBookResult =
  | { ok: true; book: Book; imported: boolean }
  | { ok: false; why: string }

/**
 * Open an .ipynb as a room notebook.
 *
 * One already brought in is returned as is. One not yet brought in is read
 * from disk, moves into the document and from then on lives there: the file
 * becomes its projection. This is a one-way door, and in the interface it is
 * called opening — which is what it is for the person.
 */
export function openBook(
  sessionId: string,
  path: string,
  by?: BookAuthor,
  /**
   * The notebook was CREATED by this person just now (`createBook`), not
   * brought in from a file that was already in the folder.
   *
   * The difference decides whose the notebook becomes. "Students' own
   * notebooks" is about a draft a student created for themselves; about a
   * teacher's handout lying in the shared folder this rule says nothing. On
   * 20 Sep 2026, in a live class, a student clicked `seminar.ipynb` in the
   * folder — and the whole group's seminar became their personal notebook:
   * only they could edit and run it. Bringing in someone else's file now leaves
   * the notebook as the room's.
   */
  fresh = false,
): OpenBookResult {
  const { doc } = getSessionDoc(sessionId)
  const known = bookAt(doc, path)
  // One already brought in simply opens: the right is asked of whoever ADDS a
  // notebook to the room, not of whoever looks at one already added.
  if (known) return { ok: true, book: known, imported: false }
  if (by) {
    const why = whyNotAddBook(sessionId, doc, by)
    if (why) return { ok: false, why }
  }
  if (kindOf(path) !== 'notebook') return { ok: false, why: tr("server.isNotANotebook.084f7a", { p0: baseOf(path) }) }

  const source = readBookText(sessionId, path)
  if ('why' in source) return { ok: false, why: source.why }
  /*
   * An empty file is a NEW notebook, not a broken one.
   *
   * "New file" in the tree creates an empty file; by naming it `.ipynb`, the
   * person asks for a notebook. Parsing emptiness as JSON and refusing would be
   * formally correct and practically useless.
   */
  const flat = source.text.trim().length === 0 ? [] : parseIpynb(source.text)
  if (flat === null) return { ok: false, why: tr("server.containsInvalidIpynbData.6292e4", { p0: baseOf(path) }) }
  if (flat.length > MAX_IMPORT_CELLS) {
    return {
      ok: false,
      why: tr("server.containsCellsTheLimitIs.0fbfa5", { p0: baseOf(path), p1: flat.length, p2: MAX_IMPORT_CELLS }),
    }
  }

  let made: Book | null = null
  /*
   * The root as a separate variable, not through `made`: the type checker does
   * not believe the transaction callback has already run, and narrows `made` to
   * `never` right after `if (!made) return`. This shows on the line below too,
   * where `made` goes into the response as is.
   */
  let root = ''
  doc.transact(() => {
    /*
     * A new notebook gets its own root, and it is no longer derived from the
     * path: a path gets freed — someone renamed the walkthrough, put a new one
     * under the same name — and someone else's notebook sat on the freed root.
     *
     * The emptiness check stayed and is still needed: a file's cells are not
     * appended onto an occupied root. Otherwise one notebook in the room stops
     * being one file on disk, and that is the only thing the projection rests
     * on.
     */
    const book = addBook(doc, path, rootForNewBook(doc))
    made = book
    root = book.root
    const cells = bookCells(doc, book.root)
    if (cells.length === 0) {
      /*
       * Images go to the room's shelf, and a link to them into the cell's
       * text.
       *
       * A lecture notebook with picture problem statements weighs megabytes,
       * and before this line all that base64 moved into the room's document,
       * that is, to everyone who joined and into every snapshot
       * (server/src/notebook-images.ts).
       */
      const shelved = flat.map((cell) => shelveCellImages(sessionId, cell))
      cells.push(
        shelved.length > 0
          ? shelved.map((cell) => createCell(cell.type, cell.source))
          : [createCell('code', '')],
      )
    }
  }, ORIGIN)
  if (!made) return { ok: false, why: tr("server.couldNotOpenTheNotebook.be7a27") }
  /*
   * The author is recorded HERE, not in the file tree, because the root is
   * known here: access to a notebook lives by root, and there is no other place
   * in the product where it is born. A notebook already brought in does not get
   * here (the return above), so a second person who opens the same file does
   * not overwrite the author.
   */
  if (by && fresh) rememberAuthor(sessionId, doc, root, by)
  schedule(sessionId)
  return { ok: true, book: made, imported: true }
}

/**
 * Read a notebook file WHOLE — or say why it cannot be done.
 *
 * `readText` protects the editor: a file larger than a megabyte and a half it
 * returns as its beginning and sets `truncated`. Here that flag used to be
 * overlooked, and JSON cut off in the middle of base64 went into `parseIpynb`,
 * which honestly returned `null`, and the room got "<name> does not look like
 * an .ipynb" — about a perfectly normal notebook with images. The screen named
 * the wrong reason, and there was no way to get around it from inside the
 * room.
 *
 * So a notebook is read with its own measure (`MAX_BOOK_BYTES`), and a refusal
 * by size talks about size.
 */
function readBookText(sessionId: string, path: string): { text: string } | { why: string } {
  const file = readText(sessionId, path, MAX_BOOK_BYTES)
  if (!file || file.binary) return { why: tr("server.couldNotBeReadAsANotebook.03f997", { p0: baseOf(path) }) }
  if (!file.truncated) return { text: file.text }
  if (file.size > MAX_BOOK_BYTES) {
    const mb = (file.size / (1024 * 1024)).toFixed(0)
    return {
      why:
        tr("server.isMbExceedingTheSizeLimit.72c414", { p0: baseOf(path), p1: mb }) +
        tr("server.mbSaveTheNotebookWithoutOutputs.bf2200", { p0: MAX_BOOK_BYTES / (1024 * 1024) }),
    }
  }
  return { why: tr("server.couldNotBeReadAsANotebook.03f997", { p0: baseOf(path) }) }
}

/** Create an empty notebook at this path: the file and the entry in the room. */
export function createBook(sessionId: string, path: string, by?: BookAuthor): OpenBookResult {
  /*
   * The right is checked BEFORE the file, not after. `openBook` below will ask
   * the same thing, but by then an empty .ipynb would already be on disk: a
   * refusal that leaves a file behind is worse than a refusal.
   */
  if (by) {
    const why = whyNotAddBook(sessionId, getSessionDoc(sessionId).doc, by)
    if (why) return { ok: false, why }
  }
  if (statPath(sessionId, path)) return { ok: false, why: tr("server.alreadyExists.e348cc", { p0: baseOf(path) }) }
  const made = makeFile(sessionId, path, writeIpynb([]))
  if (made !== 'ok') return { ok: false, why: tr("server.couldNotCreate.0cfbaa", { p0: baseOf(path) }) }
  // Created here and now, so it is theirs: this is where personal notebooks come from.
  return openBook(sessionId, path, by, true)
}

/**
 * What moved together with this path: the file itself and everything under it.
 *
 * Not only files are renamed and removed but also FOLDERS, and a notebook
 * inside a folder was matched by exact path and stayed in the room with the old
 * one: a second and a half later the projection wrote it back — together with
 * the folder that had just been removed — and the tab edited a ghost at an
 * address that does not exist on disk.
 */
function booksUnder(doc: Y.Doc, path: string): string[] {
  return allBooks(doc)
    .map(({ book }) => book.path)
    .filter((known) => isInside(known, path))
}

/** The notebook moved together with its file — or with the folder it was in. */
export function moveBook(sessionId: string, from: string, to: string): void {
  const doc = peekSessionDoc(sessionId)?.doc
  if (!doc) return
  const moved = booksUnder(doc, from)
  if (moved.length === 0) return
  doc.transact(() => {
    for (const path of moved) renameBook(doc, path, to + path.slice(from.length))
  }, ORIGIN)
  schedule(sessionId)
}

/** The file is gone — and so is the notebook. Folders go with all notebooks inside. */
export function dropBook(sessionId: string, path: string): void {
  const doc = peekSessionDoc(sessionId)?.doc
  if (!doc) return
  const gone = booksUnder(doc, path)
  if (gone.length === 0) return
  doc.transact(() => {
    for (const known of gone) removeBook(doc, known)
  }, ORIGIN)
  forgetBookRules(sessionId, doc)
}

/**
 * Whether this is a notebook in this room.
 *
 * By the room's list, not by extension: an .ipynb that just lies in the folder
 * and has not been opened yet is an ordinary file, and it may be written over.
 */
export function isBookFile(sessionId: string, path: string): boolean {
  const doc = peekSessionDoc(sessionId)?.doc
  return doc ? bookAt(doc, path) !== null : false
}

/**
 * Notebooks whose files someone removed past the tree — for example `os.remove`
 * in a cell.
 *
 * Returns the paths that are gone. The room learns about it from one message
 * about the file list; tabs close by themselves, because the file is not in the
 * list.
 */
export function forgetMissingBooks(sessionId: string): string[] {
  const doc = peekSessionDoc(sessionId)?.doc
  if (!doc) return []
  /*
   * Each path is checked separately, not looked up in the tree.
   *
   * `listFiles` is what the panel draws: a depth-first walk with a ceiling of
   * two thousand entries and a depth limit. A notebook that did not fit under
   * the ceiling drops out of the list while the file is on disk — and the room
   * would remove a live notebook for everyone. One `lstat` per notebook, and a
   * room has a handful of them.
   */
  const missing = allBooks(doc)
    .map(({ book }) => book)
    .filter((book) => statPath(sessionId, book.path)?.dir !== false)
  if (missing.length === 0) return []

  /*
   * The ROOM's notebook is not removed from the list — its file is written
   * again.
   *
   * This check runs after every cell run, and removing the room's notebook
   * means erasing its cells (`removeBook` does that only for its root — the
   * only one history can bring back). `os.remove('Notebook.ipynb')` in
   * somebody's cell is not the room agreeing to part with what it has been
   * writing all hour: the file here is a projection, and the projection is
   * restored.
   *
   * The room's notebook can still be removed — by a click on the file in the
   * tree, and that is `dropBook`, that is, something said out loud.
   */
  const gone = missing.filter((book) => book.root !== CELLS_KEY).map((book) => book.path)
  if (gone.length > 0) {
    doc.transact(() => {
      for (const path of gone) removeBook(doc, path)
    }, ORIGIN)
    forgetBookRules(sessionId, doc)
  }
  if (gone.length < missing.length) schedule(sessionId)
  return gone
}

/**
 * Remove access entries for notebooks that are no longer in the room.
 *
 * A notebook was removed — "Akim's personal notebook" goes with it: an `nb:`
 * root is never issued a second time (shared/notebook.ts · rootForNewBook), so
 * a left-over entry would go to nobody but would just lie in the database and
 * travel into every socket of the room until the end of the semester.
 *
 * Silent when there is nothing to remove: `setRules` is a write to SQLite and a
 * rules cache reset, and `dropBook` is called both for an ordinary file and for
 * a folder.
 */
function forgetBookRules(sessionId: string, doc: Y.Doc): void {
  const stored = storedRules(sessionId)
  if (!stored.books) return
  const live = liveBookRules(doc, stored.books)
  if (Object.keys(live).length === Object.keys(stored.books).length) return
  setRules(sessionId, { ...stored, books: live })
  rulesChanged?.(sessionId)
}

/** The text of a notebook's cells — for the oracle and anything that reads it as text. */
export function bookText(sessionId: string, path: string): string | null {
  const doc = peekSessionDoc(sessionId)?.doc
  if (!doc) return null
  const book = bookAt(doc, path)
  if (!book) return null
  return writeIpynb(flatten(bookCells(doc, book.root)))
}
