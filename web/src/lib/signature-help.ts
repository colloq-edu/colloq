import type { BriefValue } from '@shared/protocol'

/**
 * Kernel help split into parts: the signature separately, the docs separately.
 *
 * The kernel answers `inspect_request` with one chunk of text marked up with
 * IPython headers (`Signature:`, `Docstring:`, `Type:`, `File:` …). While the
 * tooltip showed the first six lines of that chunk, it honestly worked for
 * exactly `df.head(n=5)` and fell apart on everything else: for
 * `sns.lmplot(...)` the signature alone takes twenty-five lines, and the
 * person saw the stub
 *
 *     Signature:
 *     sns.lmplot(
 *         data,
 *         *,
 *         x=None,
 *
 * — that is, exactly the parameters they had already typed, and not one of
 * those they hovered for.
 *
 * The parser lives in its own file and knows nothing about CodeMirror or the
 * DOM: it is a pure function over a string, and it is checked against real
 * kernel answers (tests/signature-help.test.mts), not against how the window
 * looks.
 *
 * The same parser reads the answer of the STATIC path (server/src/kernel/
 * inspect-static.ts): jedi does not answer with the same text, but with the
 * same markup — IPython headers — and that is the condition of the whole
 * scheme. Two parsers for two roads would drift apart silently: the same
 * `sns.lmplot` would look different in the tooltip depending on whether a
 * cell with the import had been run in the room yet.
 */

/**
 * The headers IPython marks up its answer with (IPython/core/oinspect.py ·
 * `info_fields`) — and only those.
 *
 * A closed list, not "a word with a colon at the start of a line", because
 * the docs themselves contain any number of such lines: pandas examples
 * print tables, numpy has sections, and any `Warning:` in the middle of a
 * docstring would cut it in half. An unknown header here is no trouble: its
 * line simply stays part of the section it sits in.
 */
const SECTIONS = [
  'Signature',
  'Init signature',
  'Call signature',
  'Definition',
  /*
   * Four headers of our own — about the module (server/src/kernel/
   * inspect-static.ts · `_module_facts`). IPython does not write them, but the
   * markup is the same, so there is still a single parser. They close the
   * complaint of 21 Sep 2026: about pandas and seaborn the live kernel says
   * "Type: module" and `<no docstring>`, that is, nothing, while everything
   * substantial about the package lies next to it on disk.
   */
  'Module',
  'Package',
  'Summary',
  'Docs',
  'Docstring',
  'Init docstring',
  'Class docstring',
  'Call docstring',
  'Type',
  'Base Class',
  'String form',
  'Namespace',
  'Length',
  'File',
  'Source',
  'Subclasses',
  'Repr',
] as const

type Section = (typeof SECTIONS)[number]

const HEADER = new RegExp(`^(${SECTIONS.join('|')}):(.*)$`)

/**
 * Sections that hold SOMEONE ELSE'S text — that is, documentation.
 *
 * They have to be told apart because documentation can contain anything,
 * including the line `File:      example` from the example for `open()`. See
 * `PROSE` below: these are exactly the sections protected from headers in
 * their middle.
 */
const DOCS: readonly Section[] = [
  'Docstring',
  'Init docstring',
  'Class docstring',
  'Call docstring',
  'Source',
]

/**
 * Facts: one line each, "what this is and where it comes from".
 *
 * IPython puts them either BEFORE the docs (for modules and values) or as a
 * stuck-together tail at the very end (for functions and methods). That is
 * where the rule below comes from: in the middle of the docs such a line is
 * almost certainly part of them, not the end of the section.
 */
const FACTS: readonly Section[] = [
  'Module',
  'Package',
  'Summary',
  'Docs',
  'Type',
  'Base Class',
  'String form',
  'Namespace',
  'Length',
  'File',
  'Subclasses',
  'Repr',
]

const FACT_LINE = new RegExp(`^(${FACTS.join('|')}):`)

/**
 * The line where the stuck-together tail of facts begins.
 *
 * Counted from the end: blank lines, then consecutive `Type:`/`File:`/…
 * Everything above is text, even if a line looks like a header. Without this
 * count the docs of `open()` broke off at the line `File:      example` from
 * their own example, and half of the help simply vanished — silently, as
 * always in such cases.
 */
function tailStart(lines: readonly string[]): number {
  let at = lines.length
  while (at > 0 && lines[at - 1].trim() === '') at--
  while (at > 0 && FACT_LINE.test(lines[at - 1])) at--
  return at
}

/**
 * What IPython answers when it has nothing to say.
 *
 * The string arrives in place of the docs for modules and half of the values,
 * and showing it as docs would mean filling the window with the words "no
 * docstring" instead of not opening the window at all.
 */
const NOTHING = '<no docstring>'

export interface SignatureHelp {
  /** The WHOLE signature, as the kernel wrote it; `''` — there is none (a value, a module). */
  signature: string
  /** The whole documentation; `''` — there is none. */
  doc: string
  /** What it is: `function`, `method`, `module`, `DataFrame`. As a small label. */
  type: string
  /**
   * What the value looks like — the kernel's `String form`.
   *
   * Only for something NOT callable: for a function it is
   * `<function lmplot at 0x7f…>`, that is, an address in another process's
   * memory — noise taking up a line. But for `x = 42` or a built `df` it is
   * exactly the answer people hovered for.
   */
  form: string
  /** The value's `len()`, if the kernel reported it. */
  length: string
  /** Full module name: `pandas`, `matplotlib.pyplot`. Modules only. */
  module: string
  /** Package with version: `pandas 3.0.5` — as it is installed, not imported. */
  pkg: string
  /** One line on what the package does — from its own metadata. */
  summary: string
  /** Link to the package docs; whoever renders it checks it. */
  docs: string
  /**
   * Could not be parsed — show as is.
   *
   * Not every kernel is IPython: a room may run an R or Julia kernel, and its
   * markup is its own. Showing the foreign text whole is better than showing
   * nothing: the person will read it with their own eyes anyway, and we are
   * not obliged to understand every kernel in the world.
   */
  raw: string
}

const EMPTY: SignatureHelp = {
  signature: '',
  doc: '',
  type: '',
  form: '',
  length: '',
  module: '',
  pkg: '',
  summary: '',
  docs: '',
  raw: '',
}

/** Join a section's lines: the tail of the header line plus everything up to the next one. */
function joinSection(lines: string[]): string {
  const rows = [...lines]
  /*
   * The tail of the header line is special: for one-line values it is aligned
   * with spaces (`Type:      method`), and those spaces mean nothing. For
   * multi-line ones it is empty or all spaces. Inner lines are left alone:
   * they carry the indentation of code and examples, and trimming them would
   * break `>>>`.
   */
  if (rows.length > 0) rows[0] = rows[0].trim()
  while (rows.length > 0 && rows[0].trim() === '') rows.shift()
  while (rows.length > 0 && rows[rows.length - 1].trim() === '') rows.pop()
  // IPython is generous with trailing spaces; they are invisible in the
  // window, but a mouse selection picks them up along with the text.
  const text = rows.join('\n').replace(/[ \t]+$/gm, '')
  return text === NOTHING ? '' : text
}

/**
 * Split the kernel's answer into parts.
 *
 * Throws nothing and cuts nothing: there is nothing to trim — the window scrolls.
 */
export function parseSignatureHelp(text: string): SignatureHelp {
  if (typeof text !== 'string' || text.trim() === '') return { ...EMPTY }
  const lines = text.replace(/\r\n?/g, '\n').split('\n')
  const tail = tailStart(lines)
  const found = new Map<Section, string[]>()
  /** Lines before the first header — for a non-IPython kernel, the whole answer. */
  const preamble: string[] = []
  let current: string[] = preamble
  /** Whether we are now reading foreign text, which has no headers. */
  let prose = false
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    const header = HEADER.exec(line)
    const name = header ? (header[1] as Section) : null
    // A fact line in the middle of the docs is part of the docs; see `tailStart`.
    const real = name !== null && !(prose && i < tail && FACTS.includes(name))
    if (real && name !== null) {
      /*
       * The first section with a given name wins. A repeat can only happen
       * inside the docs, and appending its second occurrence to the section
       * would glue the help to a piece of a docstring.
       */
      if (found.has(name)) {
        current.push(line)
        continue
      }
      current = [header![2]]
      found.set(name, current)
      prose = DOCS.includes(name)
      continue
    }
    current.push(line)
  }

  if (found.size === 0) {
    return { ...EMPTY, raw: joinSection(preamble) }
  }

  const value = (name: Section) => {
    const rows = found.get(name)
    return rows ? joinSection(rows) : ''
  }

  /*
   * Order of preference — from the most precise to the most general. A class
   * has no signature at all, but it has `Init signature`, and that is what to
   * show: people hover over `pd.DataFrame` to find out what to pass to it.
   */
  const signature =
    value('Signature') || value('Init signature') || value('Call signature') || value('Definition')
  /*
   * A class's docs are TWO docs, and both are to the point: one for the class,
   * one for `__init__`. They are joined with a blank line, as the author would
   * separate them.
   */
  const doc = [value('Docstring'), value('Class docstring'), value('Init docstring'), value('Call docstring')]
    .filter((part) => part !== '')
    .join('\n\n')
  const lead = joinSection(preamble)
  const type = value('Type')
  const module = value('Module')
  /*
   * For a module, `String form` is `<module 'pandas' from '/usr/local/...'>`:
   * a path inside the container that tells the person in the room nothing.
   * Instead, a module has the package name, version and description.
   */
  const isModule = type === 'module' || module !== ''
  return {
    signature,
    doc: lead === '' ? doc : doc === '' ? lead : `${lead}\n\n${doc}`,
    type,
    // See `form`: for a callable it is the object's address in another process.
    form: signature === '' && !isModule ? value('String form') : '',
    length: value('Length'),
    module,
    pkg: value('Package'),
    summary: value('Summary'),
    docs: value('Docs'),
    raw: '',
  }
}

/** Whether there is anything to show: there is no point opening an empty tooltip. */
export function helpIsEmpty(help: SignatureHelp): boolean {
  return (
    help.signature === '' &&
    help.doc === '' &&
    help.type === '' &&
    help.form === '' &&
    help.length === '' &&
    help.module === '' &&
    help.pkg === '' &&
    help.summary === '' &&
    help.docs === '' &&
    help.raw === ''
  )
}

/**
 * A package split into name and version: `pandas 3.0.5` → `pandas` + `3.0.5`.
 *
 * The version is cut off only if the last word looks like one — starts with
 * a digit. A package name can consist of two words (`ruamel.yaml.clib`), and
 * cutting off the tail blindly would mean lying in the header.
 */
export function splitPackage(pkg: string): { name: string; version: string } {
  const at = pkg.lastIndexOf(' ')
  if (at === -1) return { name: pkg, version: '' }
  const tail = pkg.slice(at + 1)
  if (!/^\d/.test(tail)) return { name: pkg, version: '' }
  return { name: pkg.slice(0, at), version: tail }
}

/**
 * A link that is safe to let people click — or `null`.
 *
 * The string arrives from a third-party package's metadata, that is, it is
 * FOREIGN text in an `href` attribute. Nothing but http and https gets out of
 * here: `javascript:` in a link the person sees as "Documentation" means
 * running someone else's code on a click in the help.
 */
export function safeLink(url: string): string | null {
  return /^https?:\/\/\S+$/i.test(url.trim()) ? url.trim() : null
}

/* ---------------------------------------------------- signature in parts */

/**
 * How many characters of a signature fit on one line.
 *
 * Eighty is the width of the help window in 13 px monospace (640 px ≈ 82
 * characters) with room for padding. Anything shorter is shown as is, on one
 * line: there is nothing to split in `df.head(n=5)` and no reason to.
 */
export const SIGNATURE_ONE_LINE = 80

/**
 * A signature parameter split in two: the name and everything else.
 *
 * In two, because the eye looks for the NAME. In `x_estimator=None` a person
 * reads `x_estimator`, and `=None` is noise that must be visible but not
 * read; so the name is drawn in the text color and the annotation with the
 * default in a muted one. `*`, `/`, `*args` and `**kwargs` are all name:
 * there is nothing to split in them.
 */
export interface SignatureParam {
  name: string
  /** `: int = 5`, `=None`, `` — joined with the name, gives the parameter verbatim. */
  rest: string
}

export interface SignatureParts {
  /** `sns.lmplot(` — the callable together with the opening parenthesis. */
  head: string
  params: SignatureParam[]
  /** `)` and everything after it: `-> Self`. */
  tail: string
  /** The same signature on one line — exactly what gets copied from the window. */
  flat: string
}

const QUOTES = new Set(['"', "'"])
const OPEN = new Set(['(', '[', '{'])
const CLOSE = new Set([')', ']', '}'])

/**
 * Split a parameter list on TOP-LEVEL commas.
 *
 * Brackets and quotes are counted because a comma also lives inside
 * defaults: `b=(2, 3)`, `sep=", "`, `Dict[str, int]`. Splitting on every
 * comma would cut such a default in half — and show the person a parameter
 * that does not exist.
 *
 * The same job as `_split` in server/src/kernel/inspect-static.ts, and the
 * copy here is deliberate: there it sits inside Python source that is shipped
 * to the kernel, and the two cannot share a function — different languages
 * and different ends of the wire. Both are tested.
 */
function splitTopLevel(inner: string): string[] {
  const parts: string[] = []
  let depth = 0
  let quote = ''
  let start = 0
  for (let i = 0; i < inner.length; i++) {
    const ch = inner[i]
    if (quote) {
      if (ch === '\\') i++
      else if (ch === quote) quote = ''
      continue
    }
    if (QUOTES.has(ch)) quote = ch
    else if (OPEN.has(ch)) depth++
    else if (CLOSE.has(ch)) depth--
    else if (ch === ',' && depth === 0) {
      parts.push(inner.slice(start, i))
      start = i + 1
    }
  }
  parts.push(inner.slice(start))
  // A newline inside a parameter is IPython's layout, not part of the
  // parameter: it prints one per line, indented by four spaces.
  return parts.map((part) => part.replace(/\s+/g, ' ').trim()).filter((part) => part !== '')
}

/** The parameter name and everything attached to it — split at the first `:` or `=`. */
function splitParam(param: string): SignatureParam {
  let depth = 0
  let quote = ''
  for (let i = 0; i < param.length; i++) {
    const ch = param[i]
    if (quote) {
      if (ch === '\\') i++
      else if (ch === quote) quote = ''
      continue
    }
    if (QUOTES.has(ch)) quote = ch
    else if (OPEN.has(ch)) depth++
    else if (CLOSE.has(ch)) depth--
    else if (depth === 0 && (ch === ':' || ch === '=')) {
      return { name: param.slice(0, i).trimEnd(), rest: param.slice(i) }
    }
  }
  return { name: param, rest: '' }
}

/**
 * A signature split into the callable, the parameters and the tail — or
 * `null`.
 *
 * For the sake of layout, and layout here is not decoration. IPython prints a
 * long signature one parameter per line: for `sns.lmplot` that is forty-three
 * lines, i.e. the entire help window, and the docs end up three screens of
 * scrolling away. Yet people usually look for one thing in a signature —
 * whether such a parameter exists and what it is called. As a flow, wrapping
 * only between parameters, the same forty-two parameters take seven lines,
 * and the docstring is visible right away.
 *
 * `null` means "could not parse": the brackets do not match, there are no
 * brackets at all, it is not a signature. Then we show verbatim what the
 * kernel sent: foreign text is better shown as is than rebuilt by guesswork.
 */
export function splitSignature(text: string): SignatureParts | null {
  if (typeof text !== 'string') return null
  const src = text.replace(/\r/g, '')
  const open = src.indexOf('(')
  if (open === -1) return null
  let depth = 0
  let quote = ''
  let close = -1
  for (let i = open; i < src.length; i++) {
    const ch = src[i]
    if (quote) {
      if (ch === '\\') i++
      else if (ch === quote) quote = ''
      continue
    }
    if (QUOTES.has(ch)) quote = ch
    else if (OPEN.has(ch)) depth++
    else if (CLOSE.has(ch)) {
      depth--
      if (depth === 0) {
        close = i
        break
      }
    }
  }
  // The bracket never closed — this is not a whole signature but a fragment of one.
  if (close === -1) return null
  const head = src.slice(0, open + 1).replace(/\s+/g, ' ').trim()
  if (head === '(') return null
  const params = splitTopLevel(src.slice(open + 1, close)).map(splitParam)
  const tail = `)${src.slice(close + 1).replace(/\s+/g, ' ').trimEnd()}`
  const flat = head + params.map((param) => param.name + param.rest).join(', ') + tail
  return { head, params, tail, flat }
}

/* ------------------------------------------------------------------ memory */

/**
 * How long a kernel answer counts as fresh.
 *
 * A minute is "while the person is reading this cell". Holding it longer is
 * not allowed: between two hovers someone in the room will redefine `df`, and
 * the tooltip will start describing a long-gone object — lying more
 * confidently than staying silent would. Any shorter, and hovering the same
 * name again would go to the kernel again, which is exactly what the cache
 * exists to avoid: the help must appear instantly the second time.
 */
export const HELP_TTL_MS = 60_000

/** Memory cap: a notebook of eighty cells should not hoard them all. */
const HELP_MAX = 200

const remembered = new Map<string, { at: number; text: string }>()

/** The key is a name WITHIN a cell: the same `df` differs from cell to cell. */
export function helpKey(cellId: string | null, name: string): string {
  return `${cellId ?? ''} ${name}`
}

/** What the kernel already said about this name, if it said so recently. */
export function rememberedHelp(key: string, now = Date.now()): string | null {
  const row = remembered.get(key)
  if (!row) return null
  if (now - row.at > HELP_TTL_MS) {
    remembered.delete(key)
    return null
  }
  return row.text
}

/**
 * Remember a kernel answer — and only a FOUND one.
 *
 * Refusals are deliberately not remembered: "kernel is starting" and "kernel
 * is busy" are states that last a second, and remembering them for a minute
 * would mean showing a stale reason when the answer is already there. The
 * second hover must ask again.
 */
export function rememberHelp(key: string, text: string, now = Date.now()): void {
  if (remembered.size >= HELP_MAX) {
    const oldest = remembered.keys().next()
    if (!oldest.done) remembered.delete(oldest.value)
  }
  remembered.set(key, { at: now, text })
}

/**
 * Value summary lines have their own memory, with the same lifetime.
 *
 * A separate map, because the answer has a different shape (not kernel text
 * but a parsed object) and a different cost: it depends on what is in the
 * kernel RIGHT NOW and lives exactly until the next run. It is cleared in the
 * same stroke as the help.
 */
const briefs = new Map<string, { at: number; value: BriefValue }>()

export function rememberedBrief(key: string, now = Date.now()): BriefValue | null {
  const row = briefs.get(key)
  if (!row) return null
  if (now - row.at > HELP_TTL_MS) {
    briefs.delete(key)
    return null
  }
  return row.value
}

export function rememberBrief(key: string, value: BriefValue, now = Date.now()): void {
  if (briefs.size >= HELP_MAX) {
    const oldest = briefs.keys().next()
    if (!oldest.done) briefs.delete(oldest.value)
  }
  briefs.set(key, { at: now, value })
}

/**
 * Forget everything: something was just computed in the kernel.
 *
 * Running a cell is the only event after which a previous answer can turn out
 * false: `df` became different, a function was redefined, an import finally
 * ran. We clear everything, not name by name: a cell that ran changes the
 * KERNEL's namespace, that is, everything this memory holds.
 */
export function forgetHelp(): void {
  remembered.clear()
  /*
   * And the value lines — in the same stroke, and for them it matters most of
   * all: `df` after a cell run is a different `df`, and its "1460 × 81" may
   * no longer be the right number.
   */
  briefs.clear()
}
