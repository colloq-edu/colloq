/**
 * "Where is this defined": parsing Python exactly as far as a jump needs.
 *
 * A deliberately tiny subset, for the same reason as the markup of the
 * published page (server/src/publish/render.ts): a full grammar already
 * exists here (@codemirror/lang-python with its lezer tree), but it lives in
 * the browser and in the editor. The definition has to be searched for not in
 * the cell that was clicked but in ALL cells of the notebook and in the .py
 * files of the seminar folder, and the server does that: it has both the
 * document and the files at hand. Dragging CodeMirror into the server for
 * this means the same weight and a second copy of the grammar; measured on a
 * live notebook: eighty cells through lezer take 17 ms, line-by-line parsing
 * takes a fraction of a millisecond.
 *
 * What the subset knows: `def`, `async def`, `class`, assignment at the top
 * level and in a class body, `import` in all its forms. What it does NOT
 * know (and it is more honest to name this than to work around it):
 *
 * - The type of a variable. `df.head` arrives here as a chain of two names,
 *   and there is nothing to resolve it with: `df` is data, not a module. See
 *   `resolveChain` for why in that case it is better to find NOTHING than to
 *   lead into someone else's `def head`.
 * - Dynamics: `globals()[name] = ...`, `exec`, decorators that replace a name.
 * - Conditional definitions: `def f` in both branches of an `if` gives two
 *   definitions, and the choice between them is made by order, not by the
 *   condition.
 *
 * All of these are misses on the "not found" side, and such a miss is
 * visible to a person at once. The only miss that must not happen here is a
 * confident jump to the wrong place: the gesture worked, and the person reads
 * someone else's code thinking it is their own.
 */

/** A name and a dot: what a chain like `utils.helper` is made of. */
const WORD = /[A-Za-z0-9_]/

/** What was asked: a chain of dotted names and the bounds of the last link. */
export interface Question {
  /** Left to right: `['utils', 'helper']` for `utils.helper`. */
  chain: string[]
  /** Bounds of the CLICKED link in the source; the underline is drawn by them. */
  from: number
  to: number
  /**
   * To the left of the chain stands not a name but an EXPRESSION:
   * `df[["a"]].head`, `f(x).head`.
   *
   * The chain breaks at the bracket, and `head` looks like a bare name, while
   * it is a method of something not visible from here. Without this flag a
   * click on `.head(4)` found the first `def head` in the folder and
   * confidently led into it: the very miss a person does not notice.
   */
  viaExpression: boolean
}

/** What the name became in the source. */
export type DefKind = 'def' | 'class' | 'assign' | 'import'

/** A found definition: one name in one source. */
export interface Definition {
  name: string
  kind: DefKind
  /** Line, counting from one: that is how lines are shown to a person. */
  line: number
  /** Column where the NAME starts, counting from zero. */
  column: number
  /** The class in whose body it is declared, or `null` at the top level. */
  owner: string | null
  /** The line itself, trimmed: it is the caption of where the jump landed. */
  text: string
}

/** What bound this name to another module. */
export interface Import {
  /** The name it goes by in the code: after `as`, if there was one. */
  local: string
  /** The module as written: `numpy`, `pkg.sub`; empty for `from . import x`. */
  module: string
  /** The name INSIDE the module, or `null` for `import mod`. */
  member: string | null
  /** How many leading dots: 0 is an absolute import, 1 is next door, 2 is one up. */
  level: number
  line: number
  text: string
}

/** A parsed source. */
export interface Scan {
  defs: Definition[]
  imports: Import[]
  /** `from x import *`: modules from which who knows what arrived here. */
  stars: { module: string; level: number }[]
  /**
   * The whole cell is not Python: `%%bash`, `%%sql`, `%%writefile`.
   *
   * Such a cell must be skipped, not parsed: its content is another language,
   * and a `def` in a shell script is not a definition. Before this check
   * existed, `%%writefile utils.py` with a whole module inside produced
   * definitions whose jump led into a cell where they are not.
   */
  magic: boolean
}

const MAX_TEXT = 160

/**
 * Keywords: they occur under the pointer, but they have no definition and
 * cannot have one.
 *
 * Without this list `if`, `None`, `for` were underlined like names and
 * answered a click with "not found": a promise the feature will never keep,
 * and a noticeable share of all clicks in a live notebook.
 */
const KEYWORDS: ReadonlySet<string> = new Set(
  `False None True and as assert async await break class continue def del elif
   else except finally for from global if import in is lambda match nonlocal not
   or pass raise return try while with yield case`
    .trim()
    .split(/\s+/),
)

/** Letters with which Python marks a literal: r, b, u, f and their combinations. */
const PREFIX = /[A-Za-z]{1,3}$/

/**
 * The code of a line minus literals and comment.
 *
 * Literals are not cut out but PAINTED OVER with spaces: offsets inside the
 * line must stay the same, otherwise the definition's column drifts and
 * `questionAt` answers about a name standing further left. A triple quote is
 * carried between lines as state: a `def` inside a docstring is not a
 * definition, and this is not a rarity but an ordinary teaching notebook.
 *
 * Two exceptions, and both cost errors at a live lecture.
 *
 * THE LETTER BEFORE THE QUOTE is painted over together with the literal.
 * `f"{x}"` left a lone `f` hanging, and a click on it led into `def f(x)`
 * from a neighbouring cell: the gesture worked and confidently lied about a
 * place where there is no name at all.
 *
 * INSIDE AN f-STRING the content of `{…}` is CODE, and it must not be
 * painted over: `f"{cian_summary} rows"` is more common in a notebook than a
 * call, and half the names live exactly there. The doubled braces `{{` and
 * `}}` are literal, they stay painted over.
 */
function bareLine(line: string, triple: string | null): { code: string; triple: string | null } {
  let out = ''
  let open = triple
  let i = 0
  while (i < line.length) {
    if (open) {
      if (line.startsWith(open, i)) {
        out += ' '.repeat(open.length)
        i += open.length
        open = null
        continue
      }
      out += ' '
      i++
      continue
    }
    const ch = line[i]
    if (ch === '#') {
      out += ' '.repeat(line.length - i)
      break
    }
    if (ch === '"' || ch === "'") {
      // The literal's letter is on the left and already written: erase it retroactively.
      const mark = PREFIX.exec(out)
      const formatted = mark !== null && /f/i.test(mark[0])
      if (mark) out = out.slice(0, out.length - mark[0].length) + ' '.repeat(mark[0].length)
      const three = line.slice(i, i + 3)
      if (three === ch.repeat(3)) {
        out += '   '
        i += 3
        open = three
        continue
      }
      let j = i + 1
      let body = ' '
      while (j < line.length) {
        if (line[j] === '\\') {
          body += '  '
          j += 2
          continue
        }
        if (line[j] === ch) break
        /*
         * Inside an f-string `{…}` stays code. Depth is counted because the
         * substitution can contain dictionaries too: `f"{ {'a': 1}['a'] }"`.
         */
        if (formatted && line[j] === '{' && line[j + 1] !== '{') {
          let depth = 0
          const from = j
          while (j < line.length) {
            if (line[j] === '{') depth++
            else if (line[j] === '}') {
              depth--
              if (depth === 0) {
                j++
                break
              }
            } else if (line[j] === ch) break
            j++
          }
          body += ` ${line.slice(from + 1, Math.max(from + 1, j - 1))} `
          continue
        }
        body += ' '
        j++
      }
      /*
       * A literal not closed by the end of the line is continued by a
       * backslash.
       *
       * `sql = "select \\` continues on the next line, and a `def` in it is
       * part of the query text, not a definition. While the state was not
       * carried over, the parser invented `def fake` from the middle of the
       * SQL and confidently led to a line where there is no function.
       */
      if (j >= line.length && /\\$/.test(line)) {
        out += ' '.repeat(line.length - i)
        return { code: out, triple: ch }
      }
      const end = Math.min(j + 1, line.length)
      /*
       * The length must match the consumed piece, otherwise ALL offsets to
       * the right drift, and the definition's column with them. The closing
       * quote does not get into `body`, hence the padding with spaces; `body`
       * cannot be longer than needed, but if it ever is, it is more honest to
       * paint over the whole piece than to shift.
       */
      while (body.length < end - i) body += ' '
      out += body.length === end - i ? body : ' '.repeat(end - i)
      i = end
      continue
    }
    out += ch
    i++
  }
  return { code: out, triple: open }
}

const DEF = /^\s*(?:async\s+)?def\s+([A-Za-z_]\w*)/
const CLASS = /^\s*class\s+([A-Za-z_]\w*)/
const ASSIGN = /^\s*([A-Za-z_]\w*(?:\s*,\s*[A-Za-z_]\w*)*)\s*(?::[^=]+)?=(?!=)/
/** A field with an annotation and no value: that is how dataclass fields are declared. */
const FIELD = /^\s*([A-Za-z_]\w*)\s*:\s*[^=]+$/
/**
 * Names bound not by an assignment but by the statement itself.
 *
 * `for column in columns:` and `with open(path) as handle:` make up half of a
 * real seminar, and `column` and `handle` are defined in them just as truly as
 * in `x = 1`. Before they were here, a click on a loop variable's name
 * answered "not found", although it is declared one line above, in plain
 * sight.
 */
const FOR = /^\s*(?:async\s+)?for\s+([A-Za-z_]\w*(?:\s*,\s*[A-Za-z_]\w*)*)\s+in\b/
const AS = /\bas\s+([A-Za-z_]\w*)/g
const IMPORT = /^\s*import\s+(.+)$/
const FROM = /^\s*from\s+(\.*)([\w.]*)\s+import\s+(.+)$/

/** A trimmed line for the "where we jumped" caption. */
const shorten = (line: string): string => {
  const text = line.trim().replace(/\s+/g, ' ')
  return text.length > MAX_TEXT ? `${text.slice(0, MAX_TEXT - 1)}…` : text
}

/** `a.b.c as x, d`: the names this `import` binds. */
function importClause(clause: string): { local: string; module: string }[] {
  const out: { local: string; module: string }[] = []
  for (const piece of clause.split(',')) {
    const named = /^\s*([\w.]+)(?:\s+as\s+([A-Za-z_]\w*))?\s*$/.exec(piece)
    if (!named) continue
    const module = named[1]
    /*
     * Without `as` the TOP package is bound, not the whole path: `import
     * os.path` puts the name `os` into scope. The module then stays `os`:
     * "os.path" is reached by the chain (see `resolveChain`), which glues
     * `path` onto it by itself.
     */
    const local = named[2] ?? module.split('.')[0]
    out.push({ local, module: named[2] ? module : local })
  }
  return out
}

/** `from pkg import a as b, c`: the same for the second form. */
function fromClause(clause: string): { names: { local: string; member: string }[]; star: boolean } {
  const names: { local: string; member: string }[] = []
  let star = false
  for (const piece of clause.replace(/[()]/g, ' ').split(',')) {
    const trimmed = piece.trim()
    if (trimmed === '*') {
      star = true
      continue
    }
    const named = /^([A-Za-z_]\w*)(?:\s+as\s+([A-Za-z_]\w*))?$/.exec(trimmed)
    if (!named) continue
    names.push({ local: named[2] ?? named[1], member: named[1] })
  }
  return { names, star }
}

/**
 * Where in the source this name stands: line and column.
 *
 * It is searched for in the RAW lines of the statement, as a whole word and
 * not before its indentation. While the column was taken as
 * `raw.indexOf(name)`, the alias `import case_bpm as bpm` pointed inside
 * `case_bpm`: six misses out of eight in a real header; and an import wrapped
 * in parentheses has no name on its first line at all, and the column came
 * out as −1.
 */
function locate(
  lines: readonly string[],
  from: number,
  to: number,
  name: string,
): { line: number; column: number } {
  const word = new RegExp(`(?<![A-Za-z0-9_.])${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![A-Za-z0-9_])`)
  for (let n = from; n <= to && n < lines.length; n++) {
    const at = word.exec(lines[n])
    if (at) return { line: n + 1, column: at.index }
  }
  return { line: from + 1, column: 0 }
}

/** Cells whose `%%` is a wrapper around ordinary Python, not another language. */
const PYTHON_MAGICS = /^%%(time|timeit|capture|prun|debug|snakeviz|memit)\b/

/**
 * Parse a source: what it defines and what it brings in from outside.
 *
 * The work goes by LOGICAL statements, not lines, and this is not tidiness
 * but a fix for two live misses. A signature wrapped in parentheses,
 * `def loss(\n a,\n) -> X:` or `class Tables(\n Base,\n):`, gives a line `):`
 * at zero indentation, and line-by-line parsing decided the class body had
 * ended: methods became MODULE functions and were found by a bare name. And
 * a `;` in the middle of a line hid from parsing everything after it,
 * including the header's imports, that is, it broke not only its own
 * definitions but also chain resolution in the whole notebook.
 */
export function scanPython(code: string): Scan {
  const defs: Definition[] = []
  const imports: Import[] = []
  const stars: { module: string; level: number }[] = []
  const raw = code.split('\n')

  const firstCode = raw.find((line) => line.trim() !== '')
  /*
   * `%%bash` is another language, and parsing it as Python means inventing
   * definitions. But `%%time` and `%%capture` are wrappers around an ordinary
   * cell, and skipping them entirely meant losing everything written in them:
   * in a real notebook, under `%%time` sits model training with all its names.
   */
  if (firstCode !== undefined && firstCode.trimStart().startsWith('%%')) {
    if (!PYTHON_MAGICS.test(firstCode.trimStart())) return { defs, imports, stars, magic: true }
  }

  /** String-free versions of the lines: literals painted over, comments removed. */
  const bare: string[] = []
  let triple: string | null = null
  for (const line of raw) {
    const done = bareLine(line, triple)
    bare.push(done.code)
    triple = done.triple
  }

  /** Open scopes: a class gives an owner, a function hides everything inside it. */
  const scopes: { kind: 'class' | 'def'; name: string; indent: number }[] = []

  const depthOf = (line: string): number => {
    let depth = 0
    for (const ch of line) {
      if (ch === '(' || ch === '[' || ch === '{') depth++
      else if (ch === ')' || ch === ']' || ch === '}') depth--
    }
    return depth
  }

  for (let n = 0; n < bare.length; n++) {
    if (bare[n].trim() === '') continue

    // A logical statement: brackets and a backslash carry it onto the lines below.
    const start = n
    let depth = depthOf(bare[n])
    let joined = bare[n]
    while ((depth > 0 || /\\$/.test(joined.trimEnd())) && n + 1 < bare.length) {
      n++
      joined = `${joined.replace(/\\\s*$/, '')} ${bare[n].trim()}`
      depth += depthOf(bare[n])
    }
    const end = n

    const indent = /^\s*/.exec(bare[start])![0].length
    while (scopes.length > 0 && indent <= scopes[scopes.length - 1].indent) scopes.pop()
    /*
     * There are no module definitions inside a function. `helper = 1` in
     * someone else's function must not answer a click on `helper` in another
     * cell: it is a local name, and it lives exactly until `return`.
     */
    const inside = scopes.some((one) => one.kind === 'def')
    const owner = scopes.length > 0 && scopes[scopes.length - 1].kind === 'class'
      ? scopes[scopes.length - 1].name
      : null

    const klass = CLASS.exec(joined)
    if (klass) {
      if (!inside) {
        const where = locate(raw, start, end, klass[1])
        defs.push({ name: klass[1], kind: 'class', ...where, owner, text: shorten(joined) })
      }
      scopes.push({ kind: 'class', name: klass[1], indent })
      continue
    }

    const fn = DEF.exec(joined)
    if (fn) {
      if (!inside) {
        const where = locate(raw, start, end, fn[1])
        defs.push({ name: fn[1], kind: 'def', ...where, owner, text: shorten(joined) })
      }
      scopes.push({ kind: 'def', name: fn[1], indent })
      continue
    }

    if (inside) continue

    /*
     * Simple statements separated by `;`. They are written in the header
     * (`import os; import sys`) and in one-line worked examples, and until
     * this split existed, everything after the semicolon vanished together
     * with the first half.
     */
    for (const piece of splitSimple(joined)) {
      const from = FROM.exec(piece)
      if (from) {
        const parsed = fromClause(from[3])
        if (parsed.star) stars.push({ module: from[2], level: from[1].length })
        for (const one of parsed.names) {
          imports.push({
            local: one.local,
            module: from[2],
            member: one.member,
            level: from[1].length,
            line: start + 1,
            text: shorten(joined),
          })
          const where = locate(raw, start, end, one.local)
          defs.push({ name: one.local, kind: 'import', ...where, owner, text: shorten(joined) })
        }
        continue
      }

      const plain = IMPORT.exec(piece)
      if (plain) {
        for (const one of importClause(plain[1])) {
          imports.push({ ...one, member: null, level: 0, line: start + 1, text: shorten(joined) })
          const where = locate(raw, start, end, one.local)
          defs.push({ name: one.local, kind: 'import', ...where, owner, text: shorten(joined) })
        }
        continue
      }

      /*
       * Assignment at ANY depth, as long as it is not inside a function.
       *
       * The former rule "only zero indentation or a class body" lost
       * everything inside top-level `if`, `for`, `with` and `try`, and that is
       * exactly how half of a real seminar is written: `with open(...) as f:`
       * and `for column in columns:` are everywhere, and `column` answered
       * "not found" although it is defined one line above, before the
       * person's eyes. Function bodies do not reach here: they are cut off
       * above.
       */
      /*
       * `for x in …` and `… as x` come before assignment: such a line may
       * have no `=` sign at all, yet a name is bound in it.
       */
      const loop = FOR.exec(piece)
      if (loop) {
        for (const name of loop[1].split(',').map((part) => part.trim())) {
          if (!name || KEYWORDS.has(name)) continue
          const where = locate(raw, start, end, name)
          defs.push({ name, kind: 'assign', ...where, owner, text: shorten(joined) })
        }
        continue
      }
      if (/^\s*(?:async\s+)?(?:with|except)\b/.test(piece)) {
        AS.lastIndex = 0
        let bound: RegExpExecArray | null
        while ((bound = AS.exec(piece)) !== null) {
          if (KEYWORDS.has(bound[1])) continue
          const where = locate(raw, start, end, bound[1])
          defs.push({ name: bound[1], kind: 'assign', ...where, owner, text: shorten(joined) })
        }
        continue
      }

      const set = ASSIGN.exec(piece)
      if (set) {
        for (const name of set[1].split(',').map((part) => part.trim())) {
          if (!name || KEYWORDS.has(name)) continue
          const where = locate(raw, start, end, name)
          defs.push({ name, kind: 'assign', ...where, owner, text: shorten(joined) })
        }
        continue
      }

      /*
       * And a field with just an annotation: `train: pd.DataFrame` without a
       * value. That is how `@dataclass` fields are declared, and the course's
       * teaching modules have sixteen of them, and not one was found.
       */
      const field = FIELD.exec(piece)
      if (field && !KEYWORDS.has(field[1])) {
        const where = locate(raw, start, end, field[1])
        defs.push({ name: field[1], kind: 'assign', ...where, owner, text: shorten(joined) })
      }
    }
  }

  return { defs, imports, stars, magic: false }
}

/** Split on `;` outside brackets: `import os; import sys` is two statements. */
function splitSimple(line: string): string[] {
  if (!line.includes(';')) return [line]
  const out: string[] = []
  let depth = 0
  let from = 0
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]
    if (ch === '(' || ch === '[' || ch === '{') depth++
    else if (ch === ')' || ch === ']' || ch === '}') depth--
    else if (ch === ';' && depth === 0) {
      out.push(line.slice(from, i))
      from = i + 1
    }
  }
  out.push(line.slice(from))
  return out.filter((piece) => piece.trim() !== '')
}

/**
 * How many lines back to look to learn about an open triple quote.
 *
 * The quote state is honestly counted from the start of the source, and on a
 * cell this costs nothing. But the same parsing is called on EVERY mouse
 * move with the modifier held, and the file editor opens up to one and a half
 * megabytes: a full pass there is tens of milliseconds per pixel of pointer
 * travel.
 *
 * Two hundred lines is certainly more than any hand-written docstring, and
 * certainly cheap. The cost of a miss is small and one-sided: a name inside a
 * giant literal gets underlined and answers "not found".
 */
const LOOKBACK = 200

/**
 * The name under the caret, whole, together with whose it is.
 *
 * The chain stretches to the LEFT and includes the clicked link: clicking
 * `head` in `df.head.values` asks about `df.head`, not about the whole chain;
 * IDEs behave the same way, and that is how the intent reads.
 *
 * Inside a string or a comment there is no answer: `# def helper` is text,
 * and there is nothing to underline in it. Inside an f-string, on the
 * contrary, there is: `{cian_summary}` is code, and no fewer names live there
 * than outside.
 */
export function questionAt(code: string, cursor: number): Question | null {
  if (cursor < 0 || cursor > code.length) return null
  const before = code.lastIndexOf('\n', Math.max(0, cursor - 1))
  const start = before + 1
  const after = code.indexOf('\n', cursor)
  const end = after === -1 ? code.length : after
  const here = code.slice(start, end)

  /*
   * Exactly `LOOKBACK` lines are counted back, and only they are split.
   *
   * This used to be `code.slice(0, start).split('\n')`, that is, all the text
   * before the caret was split into lines for the sake of the last two
   * hundred. On a cell that costs nothing, but on a file it cost a lot and in
   * the wrong place: measured, one and a half megabytes took 12 ms, and they
   * are paid on EVERY mouse move with the modifier held.
   */
  let window = start
  for (let n = 0; n < LOOKBACK && window > 0; n++) {
    const prev = code.lastIndexOf('\n', window - 2)
    if (prev === -1) {
      window = 0
      break
    }
    window = prev + 1
  }
  let triple: string | null = null
  const above = code.slice(window, start).split('\n')
  above.pop()
  for (const line of above) triple = bareLine(line, triple).triple
  const { code: bare } = bareLine(here, triple)

  const at = cursor - start
  if (at > bare.length) return null
  let to = at
  while (to < bare.length && WORD.test(bare[to])) to++
  let from = at
  while (from > 0 && WORD.test(bare[from - 1])) from--
  if (from === to) return null
  // A name starting with a digit is a number: `2x` does not exist, and
  // `df.iloc[0]` puts `0` under the pointer, with nothing to ask about it.
  if (/^\d/.test(bare.slice(from, to))) return null

  const reach = /[A-Za-z_][A-Za-z0-9_.]*$/.exec(bare.slice(0, to))
  if (!reach) return null
  const chain = reach[0].split('.').filter(Boolean)
  if (chain.length === 0) return null
  /*
   * A bracket or a quote before the dot means an EXPRESSION on the left, not
   * a name.
   *
   * We look at the raw line, not the painted one: `"abc".upper` would
   * otherwise look like a bare `upper`, because the literal has been erased
   * by this point.
   */
  const viaExpression = /[)\]}'"]\s*\.\s*$/.test(here.slice(0, reach.index))
  /*
   * A keyword does not count as a name, neither as the first link nor as the
   * last. `if`, `None`, `for` were underlined like names and answered "not
   * found": a promise of a jump where, by the design of the language, there
   * is nowhere to jump.
   */
  if (KEYWORDS.has(chain[chain.length - 1]) || KEYWORDS.has(chain[0])) return null
  return { chain, from: start + from, to: start + to, viaExpression }
}

export function modulePaths(module: string, level: number, dir: string): string[] {
  let base = dir
  if (level === 0) base = ''
  else for (let up = 1; up < level; up++) base = base.includes('/') ? base.slice(0, base.lastIndexOf('/')) : ''
  const tail = module ? module.split('.').filter(Boolean).join('/') : ''
  const joined = [base, tail].filter(Boolean).join('/')
  if (!joined) return []
  return [`${joined}.py`, `${joined}/__init__.py`]
}

/** What to reduce the chain to, so as to know where to look. */
export type Target =
  | { kind: 'name'; name: string }
  | { kind: 'member'; module: string; level: number; name: string }
  /** A chain from data, not from a module: `df.head`. Nothing to look for. */
  | { kind: 'opaque'; owner: string; name: string }

/**
 * A chain turned into something that can be found.
 *
 * The whole honesty boundary of this feature runs here, and it rests on one
 * rule: `utils.helper` and `df.head` have the SAME parse tree but opposite
 * meanings. Only one thing tells them apart: what the name on the left is
 * bound by. An import means a module, and a module has something to look
 * for. Anything else (an assignment, a parameter, the result of a call)
 * means DATA, and there is no `def head` for it in the seminar folder.
 *
 * So an unclear chain answers `opaque`, not "let's look for the name `head`
 * somewhere". The temptation is great: a notebook almost certainly has some
 * `def head`, the jump would work and lead off to read someone else's class:
 * the one miss a person will not notice.
 */
export function resolveChain(question: Question, imports: readonly Import[]): Target {
  const chain = question.chain
  const name = chain[chain.length - 1]
  /*
   * An expression on the left means this is somebody's method, and whose
   * cannot be seen from here. An empty `owner` means "nothing to say": there
   * really is no name to talk about in `df[["a"]].head`.
   */
  if (question.viaExpression) return { kind: 'opaque', owner: '', name }
  if (chain.length === 1) return { kind: 'name', name }

  const root = chain[0]
  const bound = imports.find((one) => one.local === root)
  if (!bound) return { kind: 'opaque', owner: root, name }

  /*
   * The middle of the chain is glued onto the module: `import pkg` plus
   * `pkg.mod.f` means `pkg/mod.py` and `f` in it. In the form
   * `from pkg import mod` the module is already named in full, and the same
   * is glued onto it.
   */
  const head = bound.member ? `${bound.module}.${bound.member}` : bound.module
  const middle = chain.slice(1, -1)
  const module = [head, ...middle].filter(Boolean).join('.')
  return { kind: 'member', module, level: bound.level, name }
}

/**
 * The definition of a name in a parsed source: the one worth showing.
 *
 * The top level comes before a class body: a click on a bare `fit` asks
 * about the module function, not about a method of another class that
 * happens to have the same name. A method is returned only when it was asked
 * for, that is, when the owner is known.
 *
 * Among equal ones, the LAST: a notebook is read top to bottom, and a
 * redefinition below cancels what was above. That is exactly how Python
 * itself counts.
 */
export function pickDefinition(
  scan: Scan,
  name: string,
  owner: string | null = null,
): Definition | null {
  const all = scan.defs.filter((one) => one.name === name)
  if (all.length === 0) return null
  const wanted = owner === null ? all.filter((one) => one.owner === null) : all.filter((one) => one.owner === owner)
  const pool = wanted.length > 0 ? wanted : owner === null ? [] : all
  if (pool.length === 0) return null
  /*
   * An import is a definition only for want of a better one:
   * `from utils import f` in this same cell answers a click on `f`, but if a
   * real `def f` is nearby, that is what must be shown. Otherwise the jump
   * would lead to the import line, from which one has to jump further anyway.
   */
  const real = pool.filter((one) => one.kind !== 'import')
  const from = real.length > 0 ? real : pool
  return from[from.length - 1]
}
