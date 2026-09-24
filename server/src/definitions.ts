/**
 * "Where is this defined": a search over the room's document and the seminar's
 * files.
 *
 * Python parsing lives separately and knows nothing about the room or the disk
 * (shared/python-defs.ts). Here is the second half: the ORDER in which we look.
 * And that order is not an optimisation but the feature itself: in a live room
 * there are usually several answers to "where is `helper` defined" (in your
 * own cell, in a neighbouring notebook, in `utils.py`), and the point is not
 * to find at least one but to pick THE one the person meant.
 *
 * Hence the rules, each written down in the code below as a separate step:
 *
 * - Own before others'. The clicked source, then its notebook, then the other
 *   notebooks, then the folder's .py files. The nearest definition is the one
 *   being asked about.
 * - Above before below. Inside a notebook the NEAREST cell above is taken: a
 *   notebook is read and run top to bottom, and a redefinition above is what
 *   is in effect at the moment of the click. We look below only when there is
 *   nothing above at all.
 * - A chain from data is NEVER looked up. `df.head` is `opaque`, and not a
 *   single read is spent on it here: a `def head` will almost certainly turn
 *   up in the notebook, the jump will work, and the person will go off to read
 *   someone else's class thinking they are reading their own. Of all the
 *   misses this one alone is invisible; see the argument at `resolveChain`.
 *
 * Why the server and not the browser, which already has both the grammar and
 * the text of the open cell: it does not have the text of the OTHER cells. The
 * notebook builds editors only near the screen (Notebook.svelte ·
 * data-cell-deferred), a seminar file is read only once it has been opened in
 * a tab, and another notebook may not be loaded at all. On the server both the
 * document and the folder are at hand, and that is exactly why ceilings are
 * needed here: see MAX_FILES_READ.
 */
import * as Y from 'yjs'
import {
  allBooks,
  allCellArrays,
  cellId as idOfCell,
  cellType,
  type YCell,
} from '@shared/notebook'
import type { DefinitionHit, DefinitionMiss } from '@shared/protocol'
import {
  modulePaths,
  pickDefinition,
  questionAt,
  resolveChain,
  scanPython,
  type Definition,
  type Import,
  type Scan,
} from '@shared/python-defs'
import { currentText } from './collab/files.js'
import { getSessionDoc } from './collab/index.js'
import { listFiles } from './workspace.js'

/** Where to go, or why there is nowhere to. Exactly one of the two. */
export interface DefineAnswer {
  hit?: DefinitionHit
  miss?: DefinitionMiss
}

/**
 * How many .py files one click may read.
 *
 * A seminar folder is not a dozen course modules: a single `pip install` line
 * in a cell brings thousands of files into it (workspace.ts · MAX_ENTRIES is
 * about the same thing). A full search by name without a ceiling would mean
 * thousands of disk reads on EVERY Cmd-click, and eighty of them are already
 * more than a seminar ever has modules of its own. Eighty files read is the
 * top; an ordinary click does not get to even one, because the name is found
 * earlier, in the notebook.
 */
const MAX_FILES_READ = 80

/**
 * And how large a file is still worth parsing.
 *
 * Half a megabyte of .py is fifteen thousand lines: someone else's build, a
 * data dump in the form of code, anything but what was written by hand in a
 * seminar. The size comes from the folder walk, i.e. BEFORE reading: a large
 * file is not read at all, rather than read and thrown away.
 */
const MAX_FILE_BYTES = 512 * 1024

/** The same signature ceiling as `Definition.text`: a line, not a paragraph. */
const MAX_TEXT = 160

/** A name is fit for the prefilter only if it really is a name. */
const NAME = /^[A-Za-z_]\w*$/

/**
 * The prefilter: does the name occur in the text as a WORD.
 *
 * Mandatory, and this is measured: eighty notebook cells parsed in a row cost
 * tens of milliseconds per click; the same eighty with this check cost
 * fractions of a millisecond, because only one or two of them get parsed.
 * `\b` instead of `includes` is not nitpicking: `helper` occurs inside
 * `my_helper_util`, and without word boundaries the filter would let almost
 * everything through.
 */
function wordOf(name: string): RegExp | null {
  if (!NAME.test(name)) return null
  return new RegExp(`\\b${name}\\b`)
}

/** The folder this path lies in. The root is an empty string. */
function folderOf(path: string): string {
  const cut = path.lastIndexOf('/')
  return cut === -1 ? '' : path.slice(0, cut)
}

/** A module named the way the code wrote it: with the relative dots. */
function named(module: string, level: number, fallback: string): string {
  return `${'.'.repeat(level)}${module || fallback}`
}

/** A file's first non-empty line: the label of a jump "to the module's top". */
function firstLine(code: string): string {
  for (const line of code.split('\n')) {
    const text = line.trim()
    if (text === '') continue
    return text.length > MAX_TEXT ? `${text.slice(0, MAX_TEXT - 1)}…` : text
  }
  return ''
}

/**
 * A cell's text, WITHOUT a side write into the document.
 *
 * `cellSource` from shared/notebook.ts creates a `Y.Text` if there is none,
 * and that is right for someone about to type. Here the path only reads: a
 * click on a name has no right to give birth to a document edit and broadcast
 * it to the whole room, all the more so on a cell whose schema is off somehow.
 */
function sourceOf(cell: YCell): string {
  const raw: unknown = cell.get('source')
  if (raw instanceof Y.Text) return raw.toString()
  return typeof raw === 'string' ? raw : ''
}

/** A document sheet: the cells and the path of the notebook they belong to. */
interface Sheet {
  /** The notebook file's path; it labels the jump when there are several. */
  path: string | undefined
  cells: Y.Array<YCell>
}

/**
 * The room's notebooks, in order.
 *
 * The fallback through `allCellArrays` is for a document that has no list of
 * notebooks yet: a room opened for the first time since multiple notebooks
 * appeared, and a test document built from a single root. Both must behave
 * like a room with one notebook, otherwise jumping across neighbouring cells
 * silently stops working (the same argument sits at `allCellArrays` itself).
 */
function sheetsOf(doc: Y.Doc): Sheet[] {
  const books = allBooks(doc)
  if (books.length > 0) return books.map(({ book, cells }) => ({ path: book.path, cells }))
  return allCellArrays(doc).map((cells) => ({ path: undefined, cells }))
}

/**
 * The imports in effect in this cell, i.e. the imports of its WHOLE notebook.
 *
 * The scope in a notebook is not the cell but the kernel: `import case_cian as
 * cian` sits in the third cell and is in effect until the end of class. While
 * only the clicked cell's imports were read here, `cian.fig_range_audit(...)`
 * in the sixteenth cell answered "what cian is cannot be seen from here", so
 * the feature fell apart on exactly the most common layout of a course
 * notebook: a header of imports at the top, the work below.
 *
 * Order matters: the cell's own first, then the others from top to bottom.
 * `resolveChain` takes the FIRST match by name, and if the person redefined
 * `np` in their own cell, theirs is in effect.
 *
 * The prefilter on the word `import` avoids parsing eighty cells for the sake
 * of a three-line header: most cells of a notebook have no imports at all.
 */
function importsAround(
  own: Scan,
  sheets: readonly Sheet[],
  book: string | undefined,
): { imports: Import[]; stars: Scan['stars'] } {
  const imports = [...own.imports]
  const stars = [...own.stars]
  for (const sheet of sheets) {
    if (book !== undefined && sheet.path !== book) continue
    for (let i = 0; i < sheet.cells.length; i++) {
      const cell = sheet.cells.get(i)
      if (cellType(cell) !== 'code') continue
      const text = sourceOf(cell)
      if (!text.includes('import')) continue
      const scan = scanPython(text)
      if (scan.magic) continue
      imports.push(...scan.imports)
      stars.push(...scan.stars)
    }
  }
  return { imports, stars }
}

/** One search: what we look for, the base of relative imports, the reads left. */
interface Hunt {
  sessionId: string
  /** The folder relative imports are counted from: the file's or the notebook's. */
  dir: string
  /** The name being looked for; it also goes into the answer. */
  name: string
  /** Prefilter on this name; `null` means the name does not fit into a regex. */
  word: RegExp | null
  /** The clicked cell's name: `inSheet` works out what "above" means from it. */
  from: string | undefined
  /** The folder walk: one per request, and only if it comes to files. */
  files: Map<string, number> | null
  /** How many more files may be read. See MAX_FILES_READ. */
  budget: number
}

/** Seminar folder files, path to size. The walk is lazy: notebooks are cheaper. */
function tree(hunt: Hunt): Map<string, number> {
  if (hunt.files) return hunt.files
  const known = new Map<string, number>()
  for (const entry of listFiles(hunt.sessionId)) if (!entry.dir) known.set(entry.path, entry.size)
  hunt.files = known
  return known
}

/**
 * The text of a seminar folder file, live, with unsaved edits.
 *
 * `null`: there is no file, it is larger than the ceiling, or this request's
 * read ceiling is already used up. Through `currentText`, not from disk: a file
 * open in a tab is being edited right now, and a definition added a minute ago
 * must be found.
 */
function readFile(hunt: Hunt, path: string): string | null {
  const size = tree(hunt).get(path)
  if (size === undefined || size > MAX_FILE_BYTES) return null
  return readExact(hunt, path)
}

/**
 * The same, but WITHOUT the folder walk: the path is already known exactly.
 *
 * The walk is expensive, and for nothing. Measured on a course room: a jump
 * into your own module costs 41.9 ms in total, of which 41.4 ms is a cold
 * `listFiles`, i.e. 99 % of the price goes on a census of the whole folder for
 * the sake of two names known in advance (`eda_tools.py` and
 * `eda_tools/__init__.py`). `currentText` itself answers `null` if there is no
 * file, so there is no need to ask the walk for permission.
 *
 * The walk stays where it is warranted: in the full pass, which needs the LIST
 * of files, and in the size check before reading someone else's large file.
 */
function readExact(hunt: Hunt, path: string): string | null {
  if (hunt.budget <= 0) return null
  hunt.budget -= 1
  const text = currentText(hunt.sessionId, path)
  if (text === null) return null
  if (text.length > MAX_FILE_BYTES) return null
  return text
}

function hitInFile(path: string, def: Definition, name: string): DefinitionHit {
  return { where: 'file', path, line: def.line, column: def.column, text: def.text, name }
}

function hitInCell(id: string, book: string | undefined, def: Definition, name: string): DefinitionHit {
  return {
    where: 'cell',
    cellId: id,
    ...(book ? { path: book } : {}),
    line: def.line,
    column: def.column,
    text: def.text,
    name,
  }
}

/** The module's top: the target when asked about the module, not a name in it. */
function hitAtTop(hunt: Hunt, path: string, known?: string | null): DefinitionHit {
  // `known` is text the caller has already read: reading the same file a
  // second time for one first line cost both time and a unit of the ceiling.
  const text = known === undefined ? readExact(hunt, path) : known
  return { where: 'file', path, line: 1, column: 0, text: text === null ? '' : firstLine(text), name: hunt.name }
}

/** The module's file in the seminar folder, or `null` if the seminar has none. */
function moduleFile(hunt: Hunt, module: string, level: number): string | null {
  for (const cand of modulePaths(module, level, hunt.dir)) {
    if (currentText(hunt.sessionId, cand) !== null) return cand
  }
  return null
}

/** A name INSIDE a module: `utils.py` or `utils/__init__.py`, top level. */
function inModule(hunt: Hunt, module: string, level: number, member: string): DefinitionHit | null {
  for (const cand of modulePaths(module, level, hunt.dir)) {
    const text = readExact(hunt, cand)
    if (text === null) continue
    const def = pickDefinition(scanPython(text), member)
    if (def) return hitInFile(cand, def, hunt.name)
  }
  return null
}

/**
 * An import, turned into a jump.
 *
 * One road for two entrances: the chain `utils.helper` (where `resolveChain`
 * named the module itself) and a bare name bound by an import in this same
 * cell. The import forms differ, and there is exactly one difference between
 * them: whether they ask about the MODULE or about a name in it:
 *
 *   import utils            -> the module; lead to the top of the file
 *   from utils import f     -> the name `f` in `utils.py`
 *   from . import util      -> `util` is a SUBMODULE alongside, not a name in a module
 *   from pkg import sub     -> the same, if `pkg` has no name `sub`
 *
 * The last two are the very case the second pass here exists for: the module
 * named is a package, and what is sought is a file inside it. The order
 * between them is name first, then submodule: `from pkg import sub`, where
 * `pkg/__init__.py` has `sub = ...`, means exactly that variable.
 */
function throughImport(hunt: Hunt, module: string, level: number, member: string | null): DefineAnswer {
  if (member === null) {
    const file = moduleFile(hunt, module, level)
    if (file) return { hit: hitAtTop(hunt, file) }
    return { miss: { why: 'outside', name: hunt.name, module: named(module, level, hunt.name) } }
  }

  const found = inModule(hunt, module, level, member)
  if (found) return { hit: found }

  const sub = moduleFile(hunt, [module, member].filter(Boolean).join('.'), level)
  if (sub) return { hit: hitAtTop(hunt, sub) }

  /*
   * Not a single candidate file in the folder, so the module is someone
   * else's: `numpy`, `sklearn.metrics`, anything from the environment. This is
   * NOT "not found": saying "numpy is not in the seminar folder" explains,
   * while "could not find where it is defined" accuses the person of a typo
   * they did not make.
   */
  if (moduleFile(hunt, module, level) === null) {
    return { miss: { why: 'outside', name: hunt.name, module: named(module, level, member) } }
  }
  // The module file is ours but the name is not in it: a typo, or not written
  // yet.
  return { miss: { why: 'unknown', name: hunt.name } }
}

/**
 * A definition in one sheet: the nearest one ABOVE the clicked cell.
 *
 * `at` is the clicked cell's place in this sheet; if it is not here (another
 * notebook, a click in a file), the whole sheet counts as lying above, and its
 * last definition is taken: the same rule as inside a single source
 * (`pickDefinition`: the last redefinition wins).
 *
 * Two passes rather than one with memory: the walk up from the caret stops at
 * the very first hit, and that is not cosmetics, since every cell passed costs
 * turning a `Y.Text` into a string.
 */
function inSheet(hunt: Hunt, sheet: Sheet): DefinitionHit | null {
  const word = hunt.word
  if (word === null) return null
  const cells = sheet.cells
  let at = cells.length

  const look = (index: number): DefinitionHit | null => {
    const cell = cells.get(index)
    if (cellType(cell) !== 'code') return null
    const source = sourceOf(cell)
    if (!word.test(source)) return null
    const scan = scanPython(source)
    // A cell in another language: a `def` in `%%bash` is not a definition.
    if (scan.magic) return null
    const def = pickDefinition(scan, hunt.name)
    /*
     * An import line in SOMEONE ELSE'S cell does not count as a landing.
     *
     * A click on `load_dataset` led to the header, to `from eda_tools import
     * load_dataset`, i.e. to a line you have to jump from a second time. The
     * search has already gone through this header's import above (step 4b)
     * and, if the module belongs to the seminar, led there; and if not, it is
     * more honest to say "from a library" than to show a line the person has
     * seen anyway.
     */
    if (!def || def.kind === 'import') return null
    return hitInCell(idOfCell(cell), sheet.path, def, hunt.name)
  }

  if (hunt.from !== undefined) {
    for (let i = 0; i < cells.length; i++) {
      if (idOfCell(cells.get(i)) === hunt.from) {
        at = i
        break
      }
    }
  }
  // The clicked cell is skipped in both directions: its LIVE text has already
  // been parsed separately (step 4a), the text that arrived in the frame, not
  // whatever had reached the document by then.
  for (let i = at - 1; i >= 0; i--) {
    const hit = look(i)
    if (hit) return hit
  }
  for (let i = at + 1; i < cells.length; i++) {
    const hit = look(i)
    if (hit) return hit
  }
  return null
}

/**
 * A bare name: through its own source, the notebooks, the files.
 *
 * The order of steps is the one described in the module header, and each step
 * costs more than the one before. An ordinary click ends at the first or
 * second: the clicked name is most often defined right here or a couple of
 * cells above.
 */
function byName(
  hunt: Hunt,
  own: Scan,
  scope: { imports: readonly Import[]; stars: Scan['stars'] },
  sheets: Sheet[],
  cellId: string | undefined,
  path: string | undefined,
  book: string | undefined,
): DefineAnswer {
  const name = hunt.name

  // 4a. The own source, the one that arrived in the frame.
  const mine = pickDefinition(own, name)
  if (mine && mine.kind !== 'import') {
    if (cellId) return { hit: hitInCell(cellId, book, mine, name) }
    if (path) return { hit: hitInFile(path, mine, name) }
    // Neither a cell nor a file: the answer would have no address. Search on,
    // where it does have one.
  }

  /*
   * 4b. The name is bound by an import in this same cell.
   *
   * A refusal here is NOT final, and this is not overcaution: `from utils
   * import *` next to `import numpy as np` is an ordinary notebook header, and
   * a name that came from a library may well be redefined below by one of your
   * own. So the reason is remembered and the search goes on; and only
   * `outside` is remembered, since "not found" stands as the last answer
   * anyway.
   */
  /*
   * Own import before others', and this is not a small matter of order.
   *
   * `lastImport` takes the LAST in the list, and the list now runs over the
   * whole notebook, so "last" came to mean "in the lowest cell". The cell said
   * `from case_cian import load` in plain sight, yet the jump led into
   * `case_rohlik.py` only because that import sits lower in the notebook. We
   * ask the clicked cell first.
   */
  let outside: DefinitionMiss | null = null
  const bound = lastImport(own.imports, name) ?? lastImport(scope.imports, name)
  if (bound) {
    const through = throughImport(hunt, bound.module, bound.level, bound.member)
    if (through.hit) return through
    if (through.miss?.why === 'outside') outside = through.miss
  }

  /*
   * And the module's very NAME in an import line: `pandas` in `import pandas
   * as pd`.
   *
   * There is no bound name here at all: `import pandas as pd` puts `pd` into
   * scope, and the word `pandas` means nothing. Because of that a click on it
   * fell to the end of the search and answered "not found in the notebooks or
   * in the files": true, but not the truth that matters, since a module was
   * being looked for, and the person needs to know it is FROM A LIBRARY, not
   * that it is nowhere. A seminar's own module opens with the same click: in
   * `import eda_tools` the word is the bound name, and the road there was
   * already found above.
   *
   * The first segment of the path is taken: in `import os.path` a click on
   * `os` is `os`, and a click on `path` comes here as a chain and never reaches
   * this branch.
   */
  if (!mine) {
    const asModule = scope.imports.find((one) => one.module.split('.')[0] === name)
    if (asModule) {
      const through = throughImport(hunt, name, asModule.level, null)
      if (through.hit) return through
      if (through.miss?.why === 'outside') outside = through.miss
    }
  }

  // 4c–4d. Own notebook before the others; inside each, the nearest above.
  const mineFirst = book
    ? [...sheets.filter((one) => one.path === book), ...sheets.filter((one) => one.path !== book)]
    : sheets
  for (const sheet of mineFirst) {
    const hit = inSheet(hunt, sheet)
    if (hit) return { hit }
  }

  /*
   * 4e. `from x import *`, and that is a NAMED module, not a guess.
   *
   * This step used to come last, after the full pass over all .py files, and
   * almost nothing depended on it: the pass finds `def figure` wherever it
   * lies anyway. But it finds the FIRST by alphabetical path, while a star
   * import names outright which module the name came from. When `def figure`
   * is in both `plotstyle.py` and `case_cian.py`, only the line `from
   * plotstyle import *` knows the right answer, and knows it for sure.
   *
   * Stars are taken over the whole notebook, like ordinary imports: the header
   * sits in the third cell and is in effect until the end of class.
   */
  for (const star of scope.stars) {
    const hit = inModule(hunt, star.module, star.level, name)
    if (hit) return { hit }
  }

  // 4f. Only now a full pass over the folder's .py files: here it is a guess.
  const inFiles = sweepFiles(hunt, path)
  if (inFiles) return { hit: inFiles }

  return { miss: outside ?? { why: 'unknown', name } }
}

/** Last import that bound this name: lower in the source, so it is in effect. */
function lastImport(imports: readonly Import[], local: string): Import | null {
  for (let i = imports.length - 1; i >= 0; i--) if (imports[i].local === local) return imports[i]
  return null
}

/**
 * A top-level definition in the folder's .py files, by alphabetical path.
 *
 * Here knowledge ends and guessing begins: the file where the name turned up
 * may have nothing to do with the clicked cell; nobody imported it. So the step
 * comes last, and so the order is ALPHABETICAL rather than the folder walk
 * order: the walk changes from one `pip install` to the next, and the answer to
 * the same click would change with it. A guess, if it has to be a guess, must
 * at least be the same one every time.
 *
 * Top level only (`owner === null`, which is how `pickDefinition` works
 * without an owner): a method of someone else's class that happens to have
 * the same name is exactly that confident jump to the wrong place.
 *
 * The prefilter here saves not the reading but the parsing: to learn whether a
 * file has the name, the file has to be read. The reading itself is held by
 * the two ceilings above, the number of files and the size of each.
 */
/**
 * Folders holding someone else's code rather than class materials.
 *
 * A single `!pip install -t .` line in a cell brings thousands of .py files
 * into the folder, and the full pass, sorted alphabetically, used up the read
 * ceiling on them before reaching the first module of our own: `use_style`
 * stopped being found at all, and the click itself went from 8 to 63 ms. The
 * pass looks for what was written in class, and installed code came with a
 * ready definition that is out of reach anyway.
 */
const NOT_OURS = new Set([
  'site-packages',
  'dist-packages',
  '__pycache__',
  'node_modules',
  'venv',
  'env',
  'build',
  'dist',
  'lib',
  'lib64',
  'bin',
])

function ours(path: string): boolean {
  return !path
    .split('/')
    .slice(0, -1)
    .some((part) => NOT_OURS.has(part) || part.startsWith('.'))
}

function sweepFiles(hunt: Hunt, clicked: string | undefined): DefinitionHit | null {
  if (hunt.word === null) return null
  /*
   * Closer to the root comes first: a seminar's own modules lie next to the
   * notebook, other people's deep inside. Sorted by depth, then alphabetically:
   * the alphabet alone will not do, it would change from one package install
   * to the next, and the answer to the same click would change with it.
   */
  const paths = [...tree(hunt).keys()]
    .filter((p) => p.endsWith('.py') && p !== clicked && ours(p))
    .sort((a, b) => a.split('/').length - b.split('/').length || (a < b ? -1 : a > b ? 1 : 0))
  for (const path of paths) {
    const text = readFile(hunt, path)
    if (text === null) continue
    if (!hunt.word.test(text)) continue
    const def = pickDefinition(scanPython(text), hunt.name)
    /*
     * An import line in another file does not count, by the same argument as
     * in a cell: `import numpy as np` in `case_bpm.py` pretended that `np` was
     * defined there, and a click on `np` in a lecture's header opened someone
     * else's module. The full pass is a guess already; guessing by other
     * files' imports as well means guessing twice.
     */
    if (def && def.kind !== 'import') return hitInFile(path, def, hunt.name)
  }
  return null
}

/**
 * Where the name under the caret leads, or why nowhere.
 *
 * `cellId` and `path` say where the question comes from: a cell's name or a
 * file's path. Both are optional and both are about the same thing, the WHERE
 * FROM: they set both the search order (own notebook before others) and the
 * folder of relative imports (`from . import util` is next to THIS file, not
 * next to the seminar root).
 *
 * Synchronous and without a kernel: everything the answer needs already lies
 * in the process's memory, the room document and the seminar folder. So the
 * jump works even for someone who has just opened the notebook and has not
 * run anything.
 */
export function defineIn(
  sessionId: string,
  code: string,
  cursor: number,
  cellId?: string,
  path?: string,
  cut = 0,
): DefineAnswer {
  /*
   * The window that was sent is not yet the source, and it is the source that
   * has to be parsed.
   *
   * The frame ceiling is 24 KB, while a live course's `case_cian.py` is
   * 886 KB: a click in a large file arrives here as a PIECE (session.svelte.ts
   * · windowAroundCursor reports how much was cut off on the left). Counting by
   * the piece is wrong twice over: its lines are its own, and the landing went
   * hundreds of lines off; and a definition left beyond the edge of the window
   * was "not found", so the search went on into other files where the name
   * matched.
   *
   * The server has the whole text: `currentText` gives the file, the room
   * document gives the cell. Matching is by content, not by a single number:
   * between sending and answering the person may have typed something, and
   * then it is more honest to find the window anew than to trust the offset.
   */
  if (cut > 0) {
    const whole = wholeSource(sessionId, cellId, path)
    const at = whole === null ? -1 : whole.startsWith(code, cut) ? cut : whole.indexOf(code)
    if (whole !== null && at !== -1) {
      code = whole
      cursor += at
    } else {
      /*
       * The whole text was not found. Then with the piece we search ONLY
       * outside it: a landing of our own from the window would give a
       * confidently wrong line, and that is worse than a refusal. `cellId` and
       * `path` are not passed on, so the "own cell/own file" step is skipped,
       * and the name is looked up among the neighbours.
       */
      cellId = undefined
      path = undefined
    }
  }

  const question = questionAt(code, cursor)
  if (!question) return { miss: { why: 'nothing' } }

  const own = scanPython(code)
  /*
   * A cell in another language, and silence instead of an answer.
   *
   * `%%bash` with `python train.py` inside: there is a word under the pointer,
   * but no Python name in it. Answering "not found" would be a half-truth, and
   * searching for `train` through the notebook would be that very confident
   * jump to the wrong place. `nothing` here means exactly what it means: there
   * was no name under the pointer.
   */
  if (own.magic) return { miss: { why: 'nothing' } }

  /*
   * The document is taken for one call and not held: `holdRoom` is for whoever
   * works with a `Y.Doc` longer than one access (collab/index.ts), and here all
   * the reading fits into this synchronous pass. There is nothing to release
   * either: the frame came over a live socket, so at least the person who
   * clicked is sitting in the room.
   */
  const doc = getSessionDoc(sessionId).doc
  const sheets = sheetsOf(doc)
  const book = cellId ? bookOfCell(sheets, cellId) : undefined
  const home = path ?? book

  /*
   * The chain is resolved AFTER the document, and only because of that does it
   * resolve.
   *
   * A file's scope is the file itself, a cell's is the whole notebook: see
   * `importsAround`. Splitting this into two branches could not be done more
   * neatly than one list, which for a file equals its own imports.
   */
  const scope = cellId ? importsAround(own, sheets, book) : { imports: own.imports, stars: own.stars }
  const target = resolveChain(question, scope.imports)
  if (target.kind === 'opaque') {
    return { miss: { why: 'opaque', name: target.name, owner: target.owner } }
  }

  const hunt: Hunt = {
    sessionId,
    dir: folderOf(home ?? ''),
    name: target.name,
    word: wordOf(target.name),
    files: null,
    budget: MAX_FILES_READ,
    from: cellId,
  }

  if (target.kind === 'member') return throughImport(hunt, target.module, target.level, target.name)
  return byName(hunt, own, scope, sheets, cellId, path, book)
}

/**
 * The whole source of where the click happened, a file or a cell.
 *
 * `null`: there is nowhere to get it from; the file is gone, the cell was
 * deleted, no name was given.
 */
function wholeSource(
  sessionId: string,
  cellId: string | undefined,
  path: string | undefined,
): string | null {
  if (path) return currentText(sessionId, path)
  if (!cellId) return null
  for (const sheet of sheetsOf(getSessionDoc(sessionId).doc)) {
    for (let i = 0; i < sheet.cells.length; i++) {
      const cell = sheet.cells.get(i)
      if (idOfCell(cell) === cellId) return sourceOf(cell)
    }
  }
  return null
}

/** The path of the notebook this cell lies in. */
function bookOfCell(sheets: readonly Sheet[], id: string): string | undefined {
  for (const sheet of sheets) {
    for (let i = 0; i < sheet.cells.length; i++) {
      if (idOfCell(sheet.cells.get(i)) === id) return sheet.path
    }
  }
  return undefined
}
