<script lang="ts" module>
  import { tr, getLocale, formatNumber } from '@shared/i18n'
  import { editorPhrases } from '@/lib/editor-locale'
  /*
   * CodeMirror, its two language modes and the Yjs binding are the largest
   * thing Colloq ships, and no screen before the notebook can use a line of it.
   * It is fetched the first time a cell mounts, never at app start, and one
   * shared promise means a notebook with forty cells still fetches it once.
   *
   * Every import narrows inside the .then PARAMETER rather than after the fact.
   * That is the only shape Rollup can follow into a dynamic namespace: hand it
   * the module object whole — and `.then((m) => m.EditorView)` counts as whole
   * — and every export of every package has to be assumed live, which measured
   * 28 KB of CodeMirror this editor never calls.
   */
  async function importCodeMirror() {
    const [autocomplete, commands, md, py, language, state, view, collab, theme] = await Promise.all(
      [
        import('@codemirror/autocomplete').then(
          ({
            acceptCompletion,
            autocompletion,
            closeBrackets,
            closeBracketsKeymap,
            completionStatus,
            startCompletion,
          }) => ({
            acceptCompletion,
            autocompletion,
            closeBrackets,
            closeBracketsKeymap,
            completionStatus,
            startCompletion,
          }),
        ),
        import('@codemirror/commands').then(({ defaultKeymap, indentLess, indentMore }) => ({
          defaultKeymap,
          indentLess,
          indentMore,
        })),
        import('@codemirror/lang-markdown').then(({ markdown }) => ({ markdown })),
        /*
         * Parsing the cell's own text — as a fallback source of completion.
         *
         * `localCompletionSource` knows exactly one thing: the words already
         * written in this cell. Against the kernel that is nothing — the kernel
         * knows the real methods of a real DataFrame — but there may be no
         * kernel at all (nobody has pressed "run" yet), it may be computing
         * someone else's cell and not answer, and the room rule may not allow
         * asking. In all three cases a list made of the cell's own words is
         * better than emptiness.
         */
        import('@codemirror/lang-python').then(({ localCompletionSource, python }) => ({
          localCompletionSource,
          python,
        })),
        import('@codemirror/language').then(
          ({ bracketMatching, indentOnInput, indentUnit, syntaxTree }) => ({
            bracketMatching,
            indentOnInput,
            indentUnit,
            syntaxTree,
          }),
        ),
        import('@codemirror/state').then(
          ({ Compartment, EditorSelection, EditorState, Prec, StateEffect, StateField }) => ({
            Compartment,
            EditorSelection,
            EditorState,
            Prec,
            StateEffect,
            StateField,
          }),
        ),
        import('@codemirror/view').then(
          ({
            closeHoverTooltips,
            Decoration,
            EditorView,
            highlightActiveLine,
            hoverTooltip,
            keymap,
            placeholder,
            showTooltip,
            ViewPlugin,
          }) => ({
            closeHoverTooltips,
            Decoration,
            EditorView,
            highlightActiveLine,
            hoverTooltip,
            keymap,
            placeholder,
            showTooltip,
            ViewPlugin,
          }),
        ),
        import('y-codemirror.next').then(({ yCollab }) => ({ yCollab })),
        import('./cm-theme').then(({ colloqTheme }) => ({ colloqTheme })),
      ],
    )
    return { autocomplete, commands, md, py, language, state, view, collab, theme }
  }

  type CodeMirror = Awaited<ReturnType<typeof importCodeMirror>>

  let inFlight: Promise<CodeMirror> | null = null

  function loadCodeMirror(): Promise<CodeMirror> {
    return (inFlight ??= importCodeMirror())
  }
</script>

<script lang="ts">
  import { flushSync, untrack } from 'svelte'
  import type * as Y from 'yjs'
  import type { Awareness } from 'y-protocols/awareness'
  import type { Completion, CompletionContext, CompletionResult } from '@codemirror/autocomplete'
  import type { Compartment } from '@codemirror/state'
  import type {
    Decoration as Deco,
    DecorationSet,
    EditorView,
    Tooltip,
    ViewUpdate,
  } from '@codemirror/view'
  import type { BriefValue, InspectMiss } from '@shared/protocol'
  import { questionAt, type Question } from '@shared/python-defs'
  import { INDENT, tabKey } from '@/lib/indent'
  import { caretTarget, hoverTarget, moduleAliases } from '@/lib/hover-target'
  import {
    helpIsEmpty,
    helpKey,
    parseSignatureHelp,
    rememberBrief,
    rememberedBrief,
    rememberHelp,
    rememberedHelp,
    safeLink,
    splitPackage,
    splitSignature,
    SIGNATURE_ONE_LINE,
    type SignatureHelp,
    type SignatureParts,
  } from '@/lib/signature-help'
  import { isJumpClick } from '@/lib/utils'
  import { backspaceRemovesCell } from './cell-keys'
  import { changeFits } from './cell-paste'
  import { cellAwareness, type CellAwareness } from './cell-awareness'

  /**
   * What the kernel answered to "what can be written here".
   *
   * The shape deliberately repeats the protocol frame (`complete:reply`) rather
   * than introducing its own: there is only one call between the socket and the
   * editor anyway, and an extra translation from one record to another is an
   * extra place where `start` will get lost one day.
   */
  interface KernelCompletions {
    matches: Array<{ text: string; type?: string }>
    /** The replaced span, in characters from the start of the code. */
    start: number
    end: number
  }

  /**
   * What the kernel answered to "what is this". The same shape as
   * `inspect:reply`.
   *
   * `reason` says why there is no help: the kernel is still starting, the
   * kernel is busy, the name was not found (protocol.ts · `InspectMiss`). The
   * field is optional because it is optional on the wire too: an old server
   * does not send it, and then the refusal stays silent, as it used to.
   */
  /** The answer about a value — the same shape as `inspect:reply.brief`. */
  interface KernelBrief {
    found: boolean
    brief?: BriefValue
  }

  interface KernelSignature {
    found: boolean
    text?: string
    reason?: InspectMiss
  }

  interface Props {
    text: Y.Text
    awareness: Awareness
    /**
     * Whose caret this editor draws — the cell's id, if the editor belongs to a
     * cell.
     *
     * Without it the whole room's presence goes into `yCollab`, and a single
     * remote cursor costs a transaction in EVERY mounted editor with a walk
     * over all states (see cell-awareness.ts). One's own council sheet and a
     * file give no id: the first has its own, empty presence, the second its
     * own per document.
     */
    cellId?: string | null
    undoManager: Y.UndoManager
    language: 'python' | 'markdown'
    readOnly?: boolean
    autoFocus?: boolean
    onfocus?: () => void
    onrun?: () => void
    /** Run, then move on — Shift+Enter. See CellView.runAndStep. */
    onrunstep?: () => void
    onrunandadd?: () => void
    /**
     * Submit what has been written — ⌘⇧↵, and only that.
     *
     * It is set on the council sheet: ⇧↵ there RUNS, as in any notebook, while
     * submitting is a move after which the text goes to the teacher and cannot
     * be taken back. It must not come in the way of fingers used to "run and
     * move on", so the combination is deliberately awkward: three keys against
     * two for running. The only one that submits.
     */
    onsubmit?: () => void
    onescape?: () => void
    ondeleteempty?: () => void
    onarrowout?: (direction: -1 | 1) => void
    /**
     * The character ceiling above which the editor does not accept a PASTE — or
     * null.
     *
     * It is set on one's own council sheet: the server does not accept a
     * snapshot over `MAX_ATTEMPT_CHARS`, and pasting twelve thousand characters
     * from an IDE is one move after which the sheet stops going out. The
     * ceiling does not forbid typing by hand: the counter under the sheet talks
     * about it, and the person decides what to cut.
     */
    maxChars?: number | null
    /** A paste was refused: its size in characters, for the refusal message. */
    onoverflow?: (chars: number) => void
    placeholder?: string
    /**
     * Ask the kernel what to write at this place in the code — or nothing.
     *
     * Passed in as a call rather than taken from the room's global state, and
     * that is a load-bearing decision. The same component draws the council
     * sheet and the draft — texts that mean nothing in the room's kernel — and
     * the file editor (FileEditor) lives with no room at all. Whoever wants
     * hints from the kernel passes them in; the rest stay silent and get
     * completion from the words of the cell itself.
     */
    complete?: ((code: string, cursor: number) => Promise<KernelCompletions | null>) | null
    /** Help about what is under the caret — for the hint above the bracket. */
    inspect?: ((code: string, cursor: number) => Promise<KernelSignature | null>) | null
    /**
     * What this value is — in one line; `null` if there is nobody to ask.
     *
     * A separate call from `inspect`, because it is a different question at a
     * different price: help can start the kernel and go to jedi, while the line
     * about a value asks about an object that is already in the kernel, and
     * stays silent if it is not there.
     */
    brief?: ((code: string, cursor: number) => Promise<KernelBrief | null>) | null
    /**
     * The texts of THIS notebook's code cells — to know what was imported here.
     *
     * The help uses them to decide whether to ask about `px` in `px.scatter(`
     * (yes: it is an import alias) and about `df` in `df.groupby(` (no: what
     * `df` is only the kernel knows, and people hover over it mostly in
     * passing) — see lib/hover-target.ts. A call, not a list: there is no
     * reason to read eighty cells on every redraw; they are asked for only on
     * hover, that is, no more often than once every third of a second and only
     * where help is possible at all.
     *
     * Not passed — the rule works without the third point: imports and calls
     * are asked about as before, and access through a dot stays silent. That is
     * just what the council sheet and the file editor need, since they have no
     * notebook.
     */
    sources?: (() => readonly string[]) | null
    /**
     * Go to where this name is defined — ⌘/Ctrl-click on it. Or nothing.
     *
     * Passed in as a call by the same argument as `complete` and `inspect`:
     * finding a definition is something the room server can do, while the same
     * component draws the council sheet, the draft and the file editor, where
     * there is nowhere and nobody to search. Whoever can take you there passes
     * it in; for the rest ⌘-click stays what it was in CodeMirror, that is, a
     * second caret.
     *
     * No answer is returned here: whoever asked takes the screen to what was
     * found (lib/goto.svelte.ts), and `mark` comes back.
     */
    jump?: ((code: string, cursor: number) => void) | null
    /**
     * Where we were taken: the line (from one), the column (from zero) and the
     * jump number.
     *
     * State, not an event, and that is not a matter of taste: the notebook may
     * not have built the cell being led to yet — for distant cells it keeps a
     * placeholder (Notebook.svelte · data-cell-deferred) — and an event sent to
     * such a cell has nobody to listen to it. The mark simply lies there, and
     * the editor reads it as soon as it is built itself.
     *
     * `seq` is why this is not just a pair of numbers: a second jump TO THE
     * SAME line would otherwise not be visible at all, and leaving, coming back
     * and clicking again is routine.
     */
    mark?: { line: number; column: number; seq: number } | null
    /**
     * What a screen reader announces on arriving here.
     *
     * CodeMirror's editable surface is a bare contenteditable: in the
     * accessibility tree it was the one interactive node on the whole screen
     * with no name at all, so somebody tabbing through a notebook was told
     * "edit text, multiline" thirty times with nothing to tell the cells apart.
     */
    label?: string
  }

  let {
    text,
    awareness,
    cellId = null,
    undoManager,
    language,
    readOnly = false,
    autoFocus = false,
    onfocus,
    onrun,
    onrunstep,
    onrunandadd,
    onsubmit,
    onescape,
    ondeleteempty,
    onarrowout,
    maxChars = null,
    onoverflow,
    complete = null,
    inspect = null,
    brief = null,
    sources = null,
    jump = null,
    mark = null,
    placeholder = '',
    label = '',
  }: Props = $props()

  let host = $state<HTMLDivElement | null>(null)

  /*
   * The name has to follow the cell as the notebook is reordered around it, and
   * rebuilding a CodeMirror to change one attribute would throw away focus, the
   * cursor and the undo history — so it is set on the node instead. The facet
   * above covers the first paint; this covers every move after it.
   */
  $effect(() => {
    const node = host?.querySelector('.cm-content')
    if (node && label) node.setAttribute('aria-label', label)
  })
  let ready = $state(false)
  /* Seeded here rather than left to the effect below: the shim has to be right
     in the very first render pass, not one flush later. The effect is what
     keeps it current afterwards, so the initial read is deliberately untracked. */
  let shimText = $state(untrack(() => text.toString()))

  const shimLines = $derived(shimText.split('\n'))

  /*
   * Callbacks are fresh closures on nearly every render of the parent. If the
   * keymap read them directly the editor would be a dependency of them, and
   * rebuilding CodeMirror mid-keystroke would throw away focus, the cursor and
   * any open completion. The keymap closes over this holder instead, and a
   * separate effect keeps the holder current.
   */
  const handlers: Pick<
    Props,
    | 'onfocus'
    | 'onrun'
    | 'onrunstep'
    | 'onrunandadd'
    | 'onsubmit'
    | 'onescape'
    | 'ondeleteempty'
    | 'onarrowout'
    | 'onoverflow'
    | 'complete'
    | 'inspect'
    | 'brief'
    | 'sources'
    | 'jump'
  > = {}

  $effect(() => {
    handlers.onfocus = onfocus
    handlers.onrun = onrun
    handlers.onrunstep = onrunstep
    handlers.onrunandadd = onrunandadd
    handlers.onsubmit = onsubmit
    handlers.onescape = onescape
    handlers.ondeleteempty = ondeleteempty
    handlers.onarrowout = onarrowout
    handlers.onoverflow = onoverflow
    handlers.complete = complete
    handlers.inspect = inspect
    handlers.brief = brief
    handlers.sources = sources
    handlers.jump = jump
  })

  function fire(callback: (() => void) | undefined): boolean {
    if (!callback) return false
    callback()
    return true
  }

  /**
   * Backspace auto-repeat — and why it is a separate flag here.
   *
   * The `Backspace` binding fires on every keydown, including the repeats while
   * the key is held. As soon as the document went empty, the next repeat (~30
   * ms later) called `ondeleteempty`, the cell left the shared notebook, focus
   * moved synchronously to the previous one, and the remaining repeats set
   * about erasing ITS tail and, once it was empty, deleted it too. Someone
   * holding Backspace to erase `print(x)` lost one or two other people's cells
   * along with their output and could not tell what had happened.
   *
   * The listener is in the capture phase on the wrapper: it arrives before
   * CodeMirror's handlers on `.cm-content`, so by the time the binding runs the
   * flag is already correct, and nothing needs to be known about the order of
   * the editor's extensions.
   */
  let repeating = false

  interface ViewOptions {
    parent: HTMLElement
    ytext: Y.Text
    peers: Awareness | CellAwareness
    undo: Y.UndoManager
    lang: Props['language']
    editable: boolean
    hint: string
    /** The character ceiling for a paste — or null if there is none here. */
    ceiling: number | null
    /** Compartment to change the edit rule without rebuilding the editor. */
    hintSlot: Compartment
    localeSlot: Compartment
    writable: Compartment
    /** The "you landed here" highlight field and the effect that sets it. */
    landing: ReturnType<typeof makeLanding>
  }

  /**
   * What jedi calls what it found — and what CodeMirror calls the same thing.
   *
   * Two vocabularies, and translation has to be done by hand: ipykernel gives
   * Python words ("instance", "statement", "param"), while the icons and
   * colours in the list are drawn for the editor's vocabulary. Anything
   * unfamiliar becomes "text": a nameless row in the list is better than a list
   * that failed to build because of one word we did not anticipate.
   */
  const COMPLETION_TYPE: Record<string, string> = {
    function: 'function',
    method: 'function',
    class: 'class',
    module: 'namespace',
    instance: 'variable',
    statement: 'variable',
    param: 'variable',
    keyword: 'keyword',
  }

  /**
   * How long the pointer has to rest on a name before the kernel is asked.
   *
   * A third of a second is "the person stopped and is looking", not "the mouse
   * passed along the line". Without the delay, one pass of the pointer along
   * `df.groupby('a').sum()` would cost the room five requests to the shared
   * kernel in a row.
   */
  const HOVER_MS = 300
  /**
   * How long the highlight of the line a jump led to lasts.
   *
   * Two seconds is "had time to look up", not "now there is always a yellow
   * stripe here": the mark answers the question "where have I been taken", and
   * after the answer it gets in the way of reading. The fade in cm-theme.ts
   * (`colloq-landed`) lasts just as long, and the numbers must match: here the
   * decoration is removed, there it fades.
   */
  const LANDING_MS = 2000
  /**
   * How far to the right of the end of a line the pointer still counts as
   * standing ON the line.
   *
   * Half a character with some margin: `posAtCoords` already snaps the pointer
   * to the nearest position to within half a character, and a smaller tolerance
   * would switch off the underline on the last letter of a line.
   */
  const PAST_LINE = 6

  /**
   * How long a parameter must be to stop being unbreakable.
   *
   * A parameter being unbreakable is the whole point of the layout:
   * `x_estimator=None` must not break in the middle of the name. But a
   * parameter wider than the window cannot be unbreakable: it would poke out
   * past the edge and start a SECOND scrollbar, a horizontal one — the very
   * thing this whole layout was set up to avoid. Seventy-two characters is the
   * window's width (640 px of 13 px monospace) with some margin; anything
   * longer wraps inside itself, like ordinary text.
   */
  /** No notebook — the third rule simply does not fire; see `sources`. */
  const EMPTY_ALIASES: ReadonlySet<string> = new Set<string>()

  const PARAM_NOWRAP = 72

  /**
   * The reasons the hint does NOT settle on — and how often it asks again.
   *
   * All three are temporary: the kernel is starting, the kernel is busy with
   * someone else's cell, jedi did not manage to parse the library within its
   * budget. There will be an answer for them — the only question is when — and
   * making a person move the mouse away and back again for that would be
   * shameful: they have already made the gesture and are looking at the window.
   * So the hint asks by itself and replaces the reason line with the help in
   * place.
   *
   * A second for starting and for parsing, two for a busy kernel: a busy cell
   * runs for seconds and minutes, and there is no point in pestering it —
   * especially since every question to a busy kernel is refused at once anyway.
   * One question per second does not bother the bucket on the server (ten
   * questions per second per socket).
   */
  const WAITING = new Map<InspectMiss, number>([
    ['starting', 1000],
    ['thinking', 1000],
    ['busy', 2000],
  ])

  /**
   * How long to wait in total before leaving the reason line as it is.
   *
   * For a kernel start — a minute and a half: that is what a cold container
   * costs, and it is a measured number, not a round one
   * (server/src/kernel/index.ts · environment start). For the rest, twenty
   * seconds: a busy cell can run for an hour, and a window that keeps asking
   * for an hour is no longer a hint but background work nobody asked for.
   * Having given up, the hint simply stops asking; hover again and it will
   * start over.
   */
  const WAIT_CEILING_MS: Record<string, number> = { starting: 90_000 }
  const WAIT_CEILING_DEFAULT_MS = 20_000

  /**
   * The signature as a flow: parameters separated by commas, a break only
   * BETWEEN them.
   *
   * IPython prints a long signature as a column, one parameter per line. For
   * `sns.lmplot` that is forty-three lines — the whole help window — and the
   * documentation ends up three screens of scrolling away. Yet in a signature
   * people look for one thing: whether such a parameter exists and how it is
   * spelled. As a flow, the same forty-two parameters take seven lines, and the
   * docstring is visible at once, without a single turn of the wheel.
   *
   * Each parameter is its own `<span>` with `nowrap`: a break is possible only
   * at the space BETWEEN parameters, and `x_estimator=None` is never torn in
   * half. The comma lies INSIDE the parameter, and an ordinary space serves as
   * the separator — then what is selected with the mouse and copied stays a
   * normal line `sns.lmplot(data, *, x=None, …)`, not a set of pieces.
   *
   * The parameter name is in the text colour, the annotation and the default
   * are muted: see `SignatureParam`. The hanging indent of wrapped lines is in
   * the theme.
   */
  function signatureFlow(parts: SignatureParts): HTMLElement {
    const box = document.createElement('div')
    box.className = 'cm-signature-sig cm-signature-flow'
    box.appendChild(document.createTextNode(parts.head))
    parts.params.forEach((param, index) => {
      const last = index === parts.params.length - 1
      const span = document.createElement('span')
      // A long parameter is not made unbreakable — see PARAM_NOWRAP.
      if (param.name.length + param.rest.length <= PARAM_NOWRAP) {
        span.className = 'cm-signature-param'
      }
      span.appendChild(document.createTextNode(param.name))
      if (param.rest !== '') {
        const rest = document.createElement('span')
        rest.className = 'cm-signature-default'
        rest.textContent = param.rest
        span.appendChild(rest)
      }
      if (!last) span.appendChild(document.createTextNode(','))
      box.appendChild(span)
      // The separating space is the only place where the line can wrap.
      if (!last) box.appendChild(document.createTextNode(' '))
    })
    box.appendChild(document.createTextNode(parts.tail))
    return box
  }

  /**
   * The signature for the window: as a flow, as one line, or verbatim.
   *
   * Three cases and exactly three. Parsed and long — a flow. Parsed and short —
   * one line, already joined from the parts (for `df.head` the kernel answers
   * with one line anyway, and for a class with three, and joining them is more
   * honest than leaving a twenty-character staircase). Not parsed — verbatim:
   * the brackets did not match, it is someone else's kernel or not a signature
   * at all, and the text must not be rebuilt by guesswork.
   */
  function signatureBlock(signature: string): HTMLElement {
    const parts = splitSignature(signature)
    if (parts && parts.flat.length > SIGNATURE_ONE_LINE) return signatureFlow(parts)
    const pre = document.createElement('pre')
    pre.className = 'cm-signature-sig'
    pre.textContent = parts ? parts.flat : signature
    return pre
  }

  /**
   * The help window — the signature on top, the documentation under it, one
   * scroll for both.
   *
   * ONE, and this is a load-bearing decision. Putting them into two
   * compartments would be prettier on the mockup and worse in life:
   * `sns.lmplot` has forty-odd parameters, that is, the signature alone is
   * longer than the whole window, and a scroll of its own would make the
   * documentation unreachable — to get to it one would first have to scroll
   * through the signature and then find the second scrollbar. A shared scroll
   * turns the help into what it is: one text from top to bottom.
   *
   * The signature's `<pre>` wraps (`pre-wrap` in cm-theme.ts): a long pandas
   * line is wider than a monitor, and a horizontal bar here would be the second
   * scroll we have just avoided.
   *
   * The gradient at the bottom is the only hint that the text has not ended. On
   * macOS the scrollbar is invisible until it is touched, and without this
   * shadow the window would look finished exactly where it was cut off.
   */
  function signatureDom(help: SignatureHelp): HTMLElement {
    const root = document.createElement('div')
    root.className = 'cm-signature'
    const body = document.createElement('div')
    body.className = 'cm-signature-body'
    if (help.raw !== '') {
      const pre = document.createElement('pre')
      pre.className = 'cm-signature-sig'
      pre.textContent = help.raw
      body.appendChild(pre)
    } else if (help.module !== '' || help.pkg !== '') {
      /*
       * The module card — only when there is something to say about the module.
       * A bare "Type: module" from IPython (the note about the package did not
       * arrive: the kernel was busy, the package is not on disk) is drawn the
       * old way: a small note and the documentation, if there is any.
       */
      body.appendChild(moduleHead(help))
    } else {
      if (help.signature !== '') body.appendChild(signatureBlock(help.signature))
      const notes = [help.type, help.length === '' ? '' : `len ${help.length}`, help.form]
        .filter((note) => note !== '')
        .join(' · ')
      if (notes !== '') {
        const row = document.createElement('div')
        row.className = 'cm-signature-note'
        row.textContent = notes
        body.appendChild(row)
      }
      if (help.doc !== '') {
        const pre = document.createElement('pre')
        pre.className = 'cm-signature-doc'
        pre.textContent = help.doc
        body.appendChild(pre)
      }
    }
    root.appendChild(body)
    const more = document.createElement('div')
    more.className = 'cm-signature-more'
    root.appendChild(more)
    /*
     * The "there is more" flag lives on the node itself, not in the editor's
     * state: scrolling inside a tooltip is not a document change, and waking
     * CodeMirror with it (and other people's carets along with it) would be
     * costly and pointless.
     */
    const mark = () => {
      const left = body.scrollHeight - body.scrollTop - body.clientHeight
      root.classList.toggle('cm-signature-cut', left > 2)
    }
    body.addEventListener('scroll', mark)
    // The height can only be learned after the node has been inserted into the
    // document.
    requestAnimationFrame(mark)
    return root
  }

  /**
   * The module header: what it is, not where it lies.
   *
   * "module · <module pandas>" is what a person saw on 21 Sep when hovering
   * over `pd`: a kind and an address, from which nothing follows. A module has
   * a better answer, and it lies in the package's metadata next to it on disk:
   * under what name it is installed, what version it is, what it does and where
   * its documentation is (server/src/kernel/inspect-static.ts · `_package`).
   *
   * A submodule is named in full and next to the package it comes from:
   * "matplotlib.pyplot · module of matplotlib 3.11.1". A person hovers over
   * `plt` but installed `matplotlib`, and connecting one with the other is part
   * of the answer.
   */
  function moduleHead(help: SignatureHelp): HTMLElement {
    const box = document.createElement('div')
    box.className = 'cm-signature-module'
    const { name, version } = splitPackage(help.pkg)
    const title = document.createElement('div')
    title.className = 'cm-signature-title'
    const shown = help.module !== '' ? help.module : name
    const strong = document.createElement('b')
    strong.textContent = shown
    title.appendChild(strong)
    const note = document.createElement('span')
    note.className = 'cm-signature-kind'
    if (name !== '' && shown !== name) {
      // A submodule: the package name goes in the note, because that is what
      // gets installed.
      note.textContent = ` · ${tr('room.signature.submodule', { p0: name, p1: version })}`
    } else if (version !== '') {
      strong.textContent = `${shown} ${version}`
      note.textContent = ` · ${tr('room.signature.module')}`
    } else {
      note.textContent = ` · ${tr('room.signature.module')}`
    }
    title.appendChild(note)
    box.appendChild(title)
    if (help.summary !== '') {
      const line = document.createElement('div')
      line.className = 'cm-signature-summary'
      line.textContent = help.summary
      box.appendChild(line)
    }
    if (help.docs !== '') {
      const line = document.createElement('div')
      line.className = 'cm-signature-docs'
      line.append(document.createTextNode(`${tr('room.signature.docs')} `))
      /*
       * The link comes from SOMEONE ELSE'S package metadata, that is, it is
       * foreign text in an `href` attribute. Only http(s) may be clicked —
       * `javascript:` in a line that a person reads as "Documentation" means
       * running someone else's code on a click in the help. Whatever fails the
       * check stays as text.
       */
      const safe = safeLink(help.docs)
      if (safe === null) {
        line.append(document.createTextNode(help.docs))
      } else {
        const link = document.createElement('a')
        link.target = '_blank'
        link.rel = 'noopener noreferrer'
        link.textContent = safe
        link.href = safe
        line.appendChild(link)
      }
      box.appendChild(line)
    }
    if (help.doc !== '') {
      const pre = document.createElement('pre')
      pre.className = 'cm-signature-doc'
      pre.textContent = help.doc
      box.appendChild(pre)
    }
    return box
  }

  /**
   * Numbers in the line about a value — the human way: 1 460, not 1460.
   *
   * Digit groups are separated by the room's language itself (`Intl`): in
   * Russian it is a narrow space, in English a comma. Sizes like `(100, 3)` and
   * `1460 × 81` come from the kernel as a string, and the numbers in them are
   * found here — otherwise one would have to either format on the server (where
   * the room's language is not known) or parse the tuple on the client (where
   * nobody promised its form).
   */
  function withGroups(text: string): string {
    return text.replace(/\d{4,}/g, (digits) => formatNumber(Number(digits)))
  }

  /**
   * A value — in one line: the name, the type, the size, sometimes the value
   * itself.
   *
   * "It would be interesting to see small pop-up hints: at least the variable's
   * data type, a quick type and the dimensions" — the owner's request of 21
   * Sep, and its second half matters no less: "it also added a ton of more
   * detailed text there, that's not much fun". So here there is a pill of the
   * same layer and size as the reason line, not a scrolling window: no
   * documentation, no signature, no links — the type and the size, and the
   * person decides the rest.
   *
   * The name is muted, the type stands out: people ask "what is it", not "what
   * is it called".
   */
  function briefDom(name: string, brief: BriefValue): HTMLElement {
    const dom = document.createElement('div')
    dom.className = 'cm-signature cm-signature-brief'
    const said = document.createElement('span')
    said.className = 'cm-signature-name'
    said.textContent = name
    dom.appendChild(said)
    const type = document.createElement('b')
    type.textContent = ` · ${brief.type}`
    dom.appendChild(type)
    const tail: string[] = []
    if (brief.dtype) tail.push(brief.dtype)
    if (brief.dims) tail.push(withGroups(brief.dims))
    if (brief.value) tail.push(brief.value)
    if (brief.note) tail.push(brief.note)
    if (tail.length > 0) {
      const rest = document.createElement('span')
      rest.className = 'cm-signature-facts'
      const joined = tail.join(' · ')
      // Sixty characters is the width at which the line can still be read whole
      // and does not start competing with the code under it.
      rest.textContent = ` · ${joined.length > 60 ? `${joined.slice(0, 59)}…` : joined}`
      dom.appendChild(rest)
    }
    return dom
  }

  /**
   * Ask the kernel about a value — and stay silent if there is no answer.
   *
   * No reasons, no retries, no kernel start: for a variable there is either an
   * instant answer (the object lies in the kernel's memory) or nothing. Before
   * the cell's first run the variable does not exist — and the right answer is
   * silence, not a "run the cell" line.
   */
  async function askBrief(view: EditorView, at: number, name: string): Promise<HTMLElement | null> {
    const ask = handlers.brief
    if (!ask) return null
    const key = helpKey(cellId, `=${name}`)
    const kept = rememberedBrief(key)
    if (kept) return briefDom(name, kept)
    const answer = await ask(view.state.doc.toString(), at)
    if (!answer?.found || !answer.brief) return null
    rememberBrief(key, answer.brief)
    return briefDom(name, answer.brief)
  }

  /**
   * Why there is no help — in one muted line.  /**
   * Why there is no help — in one muted line.
   *
   * Silence does not work here: hovering is a deliberate gesture, and "nothing"
   * as an answer reads as a breakage. Three of the four reasons are temporary
   * ("about to start", "about to finish"), and it matters to the person to know
   * that waiting makes sense. `refused` is the only one that is not mentioned:
   * where the server refused because of the question bucket, the gesture was
   * right and there is nothing to explain.
   */
  function signatureMiss(reason: InspectMiss | undefined): HTMLElement | null {
    if (!reason || reason === 'refused') return null
    const words: Record<Exclude<InspectMiss, 'refused'>, string> = {
      'no-kernel': tr('room.signature.noKernel'),
      starting: tr('room.signature.starting'),
      busy: tr('room.signature.busy'),
      thinking: tr('room.signature.thinking'),
      unknown: tr('room.signature.unknown'),
    }
    const dom = document.createElement('div')
    dom.className = 'cm-signature cm-signature-miss'
    dom.append(document.createTextNode(words[reason]))
    /*
     * A temporary reason gets a waiting sign, a final one does not.
     *
     * Three dots, and they breathe through opacity: a stopped indicator is a
     * lie about the system (the same policy as for the product's spinners,
     * index.css), and opacity is exactly what this product's
     * `prefers-reduced-motion` rule leaves untouched: what goes is MOVEMENT,
     * not colour or opacity. The dots are the promise itself: "I will come back
     * with an answer, waiting makes sense".
     */
    if (WAITING.has(reason)) {
      const wait = document.createElement('span')
      wait.className = 'cm-signature-wait'
      wait.setAttribute('aria-hidden', 'true')
      for (let i = 0; i < 3; i++) wait.appendChild(document.createElement('i'))
      dom.appendChild(wait)
    }
    return dom
  }

  /**
   * Names bound by an import in this notebook — memoized until the next edit.
   *
   * Computed from the cells' text (lib/hover-target.ts · `moduleAliases`), not
   * from the kernel: the rule has to work before the first run too — where help
   * is needed most. Cells without the word `import` are not read at all, so an
   * ordinary notebook is three or four short lines to parse.
   *
   * The memo goes by a fingerprint: how many cells and how many characters in
   * them. An edit of the text changes it, and the list is rebuilt; replacing a
   * character with a character at the same length (`np` renamed to `nq`) does
   * not move the fingerprint, and until the next edit the list stays as it was.
   * The price of this imprecision is one extra or one missing name in the list
   * of allowed ones, that is, a window that for a second appeared or did not
   * appear where it could have.
   */
  let aliasMemo: { stamp: string; names: Set<string> } | null = null

  function aliasesNow(): ReadonlySet<string> {
    const read = handlers.sources
    if (!read) return EMPTY_ALIASES
    let sources: readonly string[]
    try {
      sources = read()
    } catch {
      // The notebook may have been closed between the hover and the answer —
      // stay silent.
      return EMPTY_ALIASES
    }
    let chars = 0
    for (const one of sources) chars += one.length
    const stamp = `${sources.length}:${chars}`
    if (aliasMemo?.stamp === stamp) return aliasMemo.names
    const names = moduleAliases(sources)
    aliasMemo = { stamp, names }
    return names
  }

  /**
   * What the help is about and what it is not about is decided by the PARSE
   * TREE, not by neighbouring characters.
   *
   * The rule and its arguments are entirely in lib/hover-target.ts; here there
   * is only the road to it. A regex over the line used to stand in this place —
   * "any word under the pointer" — and at the class of 21 Sep that turned out
   * to be unbearable: the window popped up over a column name in quotes, over
   * `x=` in an argument list, over one's own variable and over a word in a
   * comment. And every such hover cost a socket frame and a question to the
   * room's shared kernel.
   *
   * `syntaxTree` returns what the editor has already parsed for highlighting:
   * there is no parse of our own here, and none is being introduced.
   */
  function hoverSpot(
    cm: CodeMirror,
    view: EditorView,
    at: number,
  ): { from: number; to: number; ask: string; kind: 'help' | 'value' } | null {
    const answer = cm.language.syntaxTree(view.state)
    return hoverTarget({
      tree: answer,
      doc: view.state.doc.toString(),
      at,
      aliases: aliasesNow(),
    }).target
  }

  /**
   * What Shift+Tab at the caret asks about — or `null`, and then it is an
   * unindent.
   *
   * Wider than hover, and on purpose: the key is pressed deliberately and once.
   * Besides the names allowed for hover, the main Jupyter case is added here —
   * a caret INSIDE the brackets of a call (`px.scatter(apartments, x=|`) shows
   * the signature of what is being called (lib/hover-target.ts ·
   * `caretTarget`).
   *
   * `null` means the press goes to whoever took Shift+Tab earlier
   * (lib/indent.ts · unindent). That is the price of habit: the key had to be
   * shared, and it is shared by whether there is something under the caret to
   * ask about. In an empty line, in the middle of the indentation and on a
   * selection, Shift+Tab works as it did.
   */
  function caretSpot(
    cm: CodeMirror,
    view: EditorView,
    at: number,
  ): { from: number; to: number; ask: string; kind: 'help' | 'value' } | null {
    return caretTarget({
      tree: cm.language.syntaxTree(view.state),
      doc: view.state.doc.toString(),
      at,
      aliases: aliasesNow(),
    }).target
  }

  /**
   * The name under a screen point — exactly the one the server will be asked
   * about.
   *
   * One for two gestures, and that is not saving lines: the underline and the
   * opening show one and the same answer. Should they diverge, one day an
   * underlined name will not open while a neighbouring one does, that is, the
   * person will go off to read code other than what they aimed at.
   *
   * The end-of-line check is about `posAtCoords` pulling a pointer that has
   * gone to the RIGHT of the text back to the line's last character: without it
   * the empty field to the right of `import numpy as np` would underline `np`
   * across the whole width of the cell.
   */
  function questionAtPoint(view: EditorView, x: number, y: number): Question | null {
    const pos = view.posAtCoords({ x, y })
    if (pos === null) return null
    const line = view.state.doc.lineAt(pos)
    if (pos === line.to) {
      const end = view.coordsAtPos(line.to)
      if (end && x > end.right + PAST_LINE) return null
    }
    return questionAt(view.state.doc.toString(), pos)
  }

  /**
   * While the modifier is held, the name under the pointer is underlined, and
   * the pointer is a hand.
   *
   * Permission is NOT asked meanwhile: ANY name is underlined, and whether
   * there is a definition behind it is found out only by the click. The
   * argument is measured and written down next to the parse itself
   * (shared/python-defs.ts): a notebook of eighty cells is parsed in 17 ms, and
   * those milliseconds must not be hung on every mouse movement — and asking
   * the server the same thing even less so. The price of honesty is an
   * underlined name that sometimes answers "not found"; it is cheaper than an
   * editor that stumbles under the pointer.
   *
   * The keys are listened to on `view.dom`, not on the window, and that is a
   * trade-off too: a notebook has forty editors, and forty keyup listeners on
   * the window are forty calls on EVERY keypress while typing. On its own node
   * the handler wakes up only in the editor being worked in right now; the rest
   * learn about the modifier from mouse movement, whose event records it.
   *
   * `Decoration` arrives in the constructor rather than being taken from the
   * module: CodeMirror is loaded lazily here, and it is not there yet at the
   * top level of the file.
   */
  class JumpHint {
    view: EditorView
    deco: typeof Deco
    /** The underline itself — one per editor. */
    underline: Deco
    marks: DecorationSet
    /** What is underlined now, so the same thing does not wake the editor. */
    at: { from: number; to: number } | null = null
    /** Where the pointer was last seen; `null`: no mouse here. */
    x: number | null = null
    y = 0

    constructor(view: EditorView, deco: typeof Deco) {
      this.view = view
      this.deco = deco
      this.underline = deco.mark({ class: 'cm-goto' })
      this.marks = deco.none
      view.dom.addEventListener('mousemove', this.onMove)
      view.dom.addEventListener('mouseleave', this.onOff)
      view.dom.addEventListener('keydown', this.onKey)
      view.dom.addEventListener('keyup', this.onKey)
      /*
       * And the third reason to remove the underline — a window whose focus was
       * taken away. ⌘+Tab takes the keyup away with it: the key is released
       * already in another application, neither keyup nor mouse movement
       * arrives here, and the underline stays hanging forever — until the next
       * accidental entry of the mouse into this same cell. The same cure is
       * used for holding the restart button (Notebook.svelte ·
       * visibilitychange): a tab that went into the background has to let go of
       * what it was holding.
       */
      window.addEventListener('blur', this.onOff)
      document.addEventListener('visibilitychange', this.onOff)
    }

    /** Show or remove the underline — and wake the editor if it changed. */
    show(question: Question | null): void {
      const now = question ? { from: question.from, to: question.to } : null
      if (now?.from === this.at?.from && now?.to === this.at?.to) return
      this.at = now
      this.marks = now ? this.deco.set([this.underline.range(now.from, now.to)]) : this.deco.none
      /*
       * An empty transaction is the only way to show a decoration that the
       * plugin holds ITSELF: the editor re-reads its decorations only in an
       * update cycle, and an update cycle is started by a transaction.
       *
       * That is also why it stands behind the check above. While the pointer
       * travels along one name, not a single one goes out: each wakes the
       * remote carets from y-codemirror too, which are recomputed on any view
       * update.
       */
      this.view.dispatch({})
    }

    onMove = (event: MouseEvent): void => {
      this.x = event.clientX
      this.y = event.clientY
      const live = handlers.jump && isJumpClick(event)
      this.show(live ? questionAtPoint(this.view, event.clientX, event.clientY) : null)
    }

    onKey = (event: KeyboardEvent): void => {
      if (this.x === null) return
      const live = handlers.jump && isJumpClick(event)
      this.show(live ? questionAtPoint(this.view, this.x, this.y) : null)
    }

    /** Mouse gone, window blurred, tab hidden — nothing to hold. */
    onOff = (): void => {
      this.x = null
      this.show(null)
    }

    update(update: ViewUpdate): void {
      // The text moved — the name's bounds are no longer the same. Removed
      // silently, WITHOUT a transaction: we are inside an update cycle, and
      // starting another one from here is not allowed.
      if (update.docChanged && this.at) {
        this.at = null
        this.marks = this.deco.none
      }
    }

    destroy(): void {
      const dom = this.view.dom
      dom.removeEventListener('mousemove', this.onMove)
      dom.removeEventListener('mouseleave', this.onOff)
      dom.removeEventListener('keydown', this.onKey)
      dom.removeEventListener('keyup', this.onKey)
      window.removeEventListener('blur', this.onOff)
      document.removeEventListener('visibilitychange', this.onOff)
    }
  }

  /** Both sides of "can one type" in one piece, so they cannot drift apart. */
  function writableExtensions(cm: CodeMirror, editable: boolean) {
    return [cm.state.EditorState.readOnly.of(!editable), cm.view.EditorView.editable.of(editable)]
  }

  /**
   * The highlight of the line a jump led to: a state field and an effect for
   * it.
   *
   * The field holds a POSITION, and the decoration is computed from it on the
   * spot. A ready set of decorations cannot be stored: a line decoration lives
   * only at the start of a line, and a neighbour's edit higher up in the cell
   * moves the text under it — a mapped mark would end up in the middle of a
   * line, where it has nowhere to stand. A position, on the other hand, is
   * mapped and brought back to the start of its line again.
   */
  function makeLanding(cm: CodeMirror) {
    const { Decoration, EditorView } = cm.view
    const { StateEffect, StateField } = cm.state
    /** Landing position in the document; `null` turns the highlight off. */
    const landed = StateEffect.define<number | null>()
    const row = Decoration.line({ class: 'cm-landed' })
    const field = StateField.define<number | null>({
      create: () => null,
      update(at, tr) {
        for (const effect of tr.effects) if (effect.is(landed)) return effect.value
        if (at === null) return null
        /*
         * It goes out on the first OWN movement: the person placed the caret or
         * started typing — and the highlight turns from "this is where I
         * brought you" into an incomprehensible stripe in the middle of the
         * code. Typing gets here too: a typing transaction has its selection
         * set.
         *
         * Someone else's edit in the same cell does NOT turn the highlight off:
         * the position travels together with the text, and a neighbour who
         * finishes a line above a second later must not erase the answer to
         * someone else's question.
         */
        if (tr.selection) return null
        return tr.changes.mapPos(at)
      },
      provide: (f) =>
        EditorView.decorations.compute([f], (state) => {
          const at = state.field(f)
          if (at === null) return Decoration.none
          return Decoration.set([row.range(state.doc.lineAt(at).from)])
        }),
    })
    return { landed, field }
  }

  function createView(cm: CodeMirror, options: ViewOptions): EditorView {
    const { acceptCompletion, autocompletion, closeBrackets, closeBracketsKeymap, completionStatus, startCompletion } =
      cm.autocomplete
    const { bracketMatching, indentOnInput, indentUnit } = cm.language
    const { EditorState, Prec } = cm.state
    const { Decoration, highlightActiveLine, keymap, placeholder: placeholderExt, ViewPlugin } = cm.view
    const { parent, ytext, peers, undo, lang, editable, hint, writable, ceiling, hintSlot, localeSlot, landing } = options

    /**
     * Completion through the eyes of the room's kernel.
     *
     * It is asked not on every keypress but where a person really expects
     * something: after a letter or a dot. Otherwise `complete_request` would go
     * out on a space, a bracket and a newline too — a dozen per second from
     * everyone in the room, into the one kernel shared by all. `validFor`
     * completes what has been started right here, on the client: while the
     * person types `he` towards `head`, the list is filtered in place and the
     * kernel is not asked at all.
     */
    async function kernelCompletions(context: CompletionContext): Promise<CompletionResult | null> {
      const ask = handlers.complete
      // A cell that is not being typed in is not completed: someone else's
      // locked sheet and a finished class are for reading, not typing.
      if (!ask || context.state.readOnly) return null
      const before = context.state.sliceDoc(Math.max(0, context.pos - 1), context.pos)
      if (!context.explicit && !/[\w.]/.test(before)) return null
      const answer = await ask(context.state.doc.toString(), context.pos)
      if (!answer || answer.matches.length === 0) return null
      const from = Math.max(0, Math.min(answer.start, context.pos))
      /*
       * `df.head` or just `head` — decided by WHERE the kernel said to replace
       * from.
       *
       * Kernels answer differently: some return the whole name with the prefix,
       * others only the tail, while their `cursor_start` stands after the dot
       * in the same way. Showing the first as it is would mean drawing
       * `df.head` in the list and inserting `df.df.head` into the text.
       */
      const dotted = from > 0 && context.state.sliceDoc(from - 1, from) === '.'
      const options: Completion[] = []
      const seen = new Set<string>()
      for (const match of answer.matches) {
        const label =
          dotted && match.text.includes('.')
            ? match.text.slice(match.text.lastIndexOf('.') + 1)
            : match.text
        if (label === '' || seen.has(label)) continue
        seen.add(label)
        options.push({
          label,
          detail: match.type ?? undefined,
          type: match.type ? (COMPLETION_TYPE[match.type] ?? 'text') : 'text',
        })
      }
      if (options.length === 0) return null
      return { from, options, validFor: /^[\w]*$/ }
    }

    /* ------------------------------------- help for what is under the
       pointer */

    /**
     * Ask the kernel about one name — and assemble what we will show.
     *
     * One road for both gestures: hovering with the mouse and Shift+Tab at the
     * caret. There must not be a second such function here — once the two
     * diverged, they would give different answers to one and the same question,
     * and there would be no way to explain it.
     *
     * The memory (lib/signature-help.ts) stands BEFORE the question: a second
     * hover over the same name has to open instantly, rather than going to the
     * shared kernel for what it already knows. Only what was found is
     * remembered; refusal reasons are never remembered — they live for a
     * second, and yesterday's "the kernel is starting" would be a lie exactly
     * when the answer is finally there.
     */
    async function askSignature(view: EditorView, at: number, name: string): Promise<HTMLElement | null> {
      const ask = handlers.inspect
      if (!ask) return null
      const key = helpKey(cellId, name)
      const kept = rememberedHelp(key)
      if (kept !== null) {
        const help = parseSignatureHelp(kept)
        return helpIsEmpty(help) ? null : signatureDom(help)
      }
      /*
       * The caret for the kernel is put at the END of the name:
       * `inspect_request` answers about what stands before it. In the middle of
       * a word it would answer about `he`.
       */
      const answer = await ask(view.state.doc.toString(), at)
      // `null` means the socket is closed or the three seconds ran out: there
      // is nothing to say, and this is the only case when the help still stays
      // silent.
      if (!answer) return null
      if (!answer.found || !answer.text) {
        const dom = signatureMiss(answer.reason)
        // The reason is temporary — we wait for the answer ourselves, without
        // sending the person to move the mouse back and forth (see
        // `keepAsking`).
        if (dom && answer.reason && WAITING.has(answer.reason)) {
          keepAsking(view, at, key, dom, answer.reason)
        }
        return dom
      }
      const help = parseSignatureHelp(answer.text)
      if (helpIsEmpty(help)) return signatureMiss('unknown')
      rememberHelp(key, answer.text)
      return signatureDom(help)
    }

    /**
     * Ask again while the window is open, and replace the reason with the help
     * in place.
     *
     * "It is unclear why I have to move the cursor away and back again for the
     * signature to appear" — a complaint from the class of 20 Sep, and a fair
     * one: the person read the answer "the kernel is starting", the kernel came
     * up two seconds later, and the window kept showing yesterday's news,
     * because only hovering asks it.
     *
     * It stops on three signs, and all three mean "the window is gone or is no
     * longer about this place": the node was detached (the mouse left, Escape,
     * the caret moved off a pinned one), the cell's text changed (the question
     * was about something else), the wait ceiling ran out. No timers are left
     * behind: the next tick is started only from the previous one and only
     * after the checks.
     *
     * The answer is put INTO THE SAME node, not next to it: the node belongs to
     * CodeMirror (`create: () => ({ dom })`), and replacing it would leave the
     * tooltip without content. The class and the children change — and
     * CodeMirror is asked to re-measure: a one-line window turns into a
     * six-hundred-pixel one, and without re-measuring it would stay at its old
     * size, running over the line or hanging in the air.
     */
    function keepAsking(
      view: EditorView,
      at: number,
      key: string,
      dom: HTMLElement,
      first: InspectMiss,
    ): void {
      const ask = handlers.inspect
      if (!ask) return
      const doc = view.state.doc
      const until = Date.now() + (WAIT_CEILING_MS[first] ?? WAIT_CEILING_DEFAULT_MS)
      let reason: InspectMiss = first
      const again = () => {
        const wait = WAITING.get(reason)
        if (wait === undefined) return
        const timer = setTimeout(tick, wait)
        // A question about a tooltip has no right to keep the tab alive.
        ;(timer as unknown as { unref?: () => void }).unref?.()
      }
      const tick = async () => {
        if (!dom.isConnected || view.state.doc !== doc || Date.now() > until) return
        const answer = await ask(view.state.doc.toString(), at)
        // While we were away, the window may have been closed or the text
        // rewritten.
        if (!dom.isConnected || view.state.doc !== doc) return
        if (!answer) return
        if (!answer.found || !answer.text) {
          const next = answer.reason
          if (!next || !WAITING.has(next)) {
            // The reason has become final ("not found"): we say it and fall
            // silent.
            const said = signatureMiss(next)
            if (said) {
              dom.className = said.className
              dom.replaceChildren(...said.childNodes)
              view.requestMeasure()
            }
            return
          }
          if (next !== reason) {
            const said = signatureMiss(next)
            if (said) dom.replaceChildren(...said.childNodes)
            reason = next
          }
          again()
          return
        }
        const help = parseSignatureHelp(answer.text)
        if (helpIsEmpty(help)) return
        rememberHelp(key, answer.text)
        const built = signatureDom(help)
        dom.className = built.className
        dom.replaceChildren(...built.childNodes)
        view.requestMeasure()
      }
      again()
    }

    /**
     * Where the help window hangs — a rule shared by both gestures.
     *
     * UNDER the line, not above it. Above the line hangs the cell toolbar —
     * "run", "stop", "format" — and a tooltip that slid upward covered it
     * exactly when the person was reaching for a button. The stack of layers
     * takes the same rule to its end: the tooltip's z-index is below the
     * toolbar's, so even from below it cannot cover it (see cm-theme.ts ·
     * .cm-tooltip.cm-signature).
     */
    function signatureTooltip(from: number, to: number, dom: HTMLElement): Tooltip {
      return {
        pos: from,
        end: to,
        above: false,
        create: (view) => {
          /*
           * Escape closes the help even when the editor is no longer being
           * typed in.
           *
           * Having selected a line INSIDE the window with the mouse, a person
           * takes the focus away from the cell — and the editor's keymap goes
           * with it, that is, Escape stops reaching anything at all. Measured
           * on the test bench: the window stayed hanging until the pointer was
           * moved away.
           *
           * Only when there is NO focus in the editor: while it is there,
           * Escape works through its own order — the completion list, then the
           * help, then command mode — and interfering with it from here would
           * break that order.
           */
          const onKey = (event: KeyboardEvent) => {
            if (event.key !== 'Escape' || view.hasFocus) return
            closeSignature(view)
          }
          document.addEventListener('keydown', onKey, true)
          return { dom, destroy: () => document.removeEventListener('keydown', onKey, true) }
        },
      }
    }

    /** Remove the help — both at once, whichever is hanging right now. */
    function closeSignature(view: EditorView): void {
      view.dispatch({ effects: [cm.view.closeHoverTooltips, pinned.of(null)] })
    }

    /**
     * The same help called up by Shift+Tab — and it does not go out until
     * people leave.
     *
     * The key is the same as in Jupyter, and that is the only argument for it:
     * people come to the notebook with a ready-made habit. But Shift+Tab in
     * this editor is taken — it unindents — so the help answers it ONLY where
     * there is nothing to unindent: the caret is on a name or anywhere inside
     * the brackets of a call, and there is no selection (see `caretSpot` and
     * lib/hover-target.ts). In all other cases the press goes on and unindents,
     * as it did.
     *
     * A field of its own, not `hoverTooltip`: with hover the window lives while
     * the mouse is over it, and a key has no mouse at all. The pin is removed
     * by three things — Escape, a caret that moved away, and any edit of the
     * text: after each of them the help tells about a place where the person no
     * longer is.
     */
    const pinned = cm.state.StateEffect.define<Tooltip | null>()
    const pinnedField = cm.state.StateField.define<Tooltip | null>({
      create: () => null,
      update(value, tr) {
        for (const effect of tr.effects) if (effect.is(pinned)) return effect.value
        if (value && (tr.docChanged || tr.selection)) return null
        return value
      },
      provide: (field) => cm.view.showTooltip.from(field),
    })

    async function openPinned(
      view: EditorView,
      spot: { from: number; to: number; ask: string; kind: 'help' | 'value' },
    ): Promise<void> {
      const head = view.state.selection.main.head
      const dom =
        spot.kind === 'value'
          ? await askBrief(view, spot.to, spot.ask)
          : await askSignature(view, spot.to, spot.ask)
      // While we went to the kernel, the caret may have moved away — then there
      // is nothing to pin: the window would stand at a name the person is no
      // longer looking at.
      if (!dom || view.state.selection.main.head !== head) return
      // And at the same time remove the one that already slid out on hover:
      // while we went to the kernel, the pointer stood on the same name and
      // managed to call its own.
      view.dispatch({
        effects: [cm.view.closeHoverTooltips, pinned.of(signatureTooltip(spot.from, spot.to, dom))],
      })
    }

    /**
     * Hovered over a name — saw the signature. And nothing on a keypress.
     *
     * The tooltip used to pop up on a typed `(`. That is a mistake in the very
     * idea: a bracket is typed by someone who KNOWS what they are writing, and
     * a panel sliding out at that moment covers the line the person is typing
     * at that second. Hovering is the opposite gesture: it is made when
     * something is NOT known, and made on purpose.
     *
     * `hoverTime` is that very third of a second that separates "I am looking
     * here" from "I am moving the mouse past". The tooltip is closed by
     * CodeMirror itself when the pointer has left BOTH the name and the window:
     * while the mouse is over the window, it is alive, and the help can be
     * scrolled with the wheel and selected — that is what "reachable" means.
     */
    const signatureHover = cm.view.hoverTooltip(
      async (view, pos) => {
        const ask = handlers.inspect
        // In a cell that may not be edited there is no help: someone else's
        // locked sheet and a finished class are for reading, and the state of
        // the shared kernel must not be read through them (the same rule as for
        // completion).
        if (!ask || view.state.readOnly) return null
        /*
         * One help per screen.
         *
         * While a pinned one hangs (Shift+Tab), hover stays silent. Otherwise
         * there were two: having pressed Shift+Tab, a person does not take the
         * hand off the mouse, and a third of a second later a second window
         * slid out under the pinned one — with the same text, but its own.
         * Taken from the test bench, not invented. The pinned one goes away on
         * Escape, on a caret that moved away and on the first edit, and hover
         * works again right away.
         */
        if (view.state.field(pinnedField, false)) return null
        /*
         * And nothing if what is under the pointer is not what people ask
         * about: a string, a comment, an argument, one's own variable. A
         * refusal here costs exactly zero — not a single socket frame, not a
         * question to the room's kernel (the rule and its arguments:
         * lib/hover-target.ts).
         */
        const spot = hoverSpot(cm, view, pos)
        if (!spot) return null
        /*
         * Two different hints for two different questions. About a name that
         * was imported or is being called, people ask "what does it do" — and
         * the window with the help answers. About a variable they ask "what is
         * it and how big" — and a single line answers (lib/hover-target.ts ·
         * `kind`).
         */
        const dom =
          spot.kind === 'value'
            ? await askBrief(view, spot.to, spot.ask)
            : await askSignature(view, spot.to, spot.ask)
        return dom ? signatureTooltip(spot.from, spot.to, dom) : null
      },
      { hoverTime: HOVER_MS },
    )

    /* ------------------------------------------- go to definition */

    /**
     * ⌘/Ctrl-click on a name — go to where it is defined.
     *
     * `Prec.highest`, to get ahead of CodeMirror's own mousedown: for it a
     * click with a modifier adds a SECOND caret, and without precedence the
     * gesture would first tear the selection in two and then take one out of
     * the cell.
     *
     * If what is under the pointer is not a name, the handler declines, and the
     * press goes to the editor in full: ⌘-click on an empty place still puts a
     * second caret, as it did. In exactly the same way it declines where there
     * is nobody to take you (`jump` was not passed): there is no underline in
     * such a cell, and nothing to promise the click.
     *
     * What travels as the caret is the END of the found link, not the position
     * the pixel landed on. The answer does not change because of that —
     * `questionAt` from any point inside the name answers the same — but the
     * server gets exactly the name that was underlined, rather than whatever
     * the coordinate rounds to while the question is on its way.
     */
    const jumpClick = Prec.highest(
      cm.view.EditorView.domEventHandlers({
        mousedown(event, view) {
          const go = handlers.jump
          // The left button only: ⌘ with the right one on a Mac is also the
          // context menu, and taking one out of the cell along with it is not
          // allowed.
          if (!go || event.button !== 0 || !isJumpClick(event)) return false
          const question = questionAtPoint(view, event.clientX, event.clientY)
          if (!question) return false
          event.preventDefault()
          go(view.state.doc.toString(), question.to)
          return true
        },
      }),
    )

    /*
     * The underline under a held modifier is kept by `JumpHint` — it lives at
     * the top level of the file, because a class declared inside a function
     * would have to be born anew on every editor build. Everything it needs
     * from the lazily loaded CodeMirror it gets in the constructor.
     */
    const jumpHint = ViewPlugin.define((view) => new JumpHint(view, Decoration), {
      decorations: (plugin) => plugin.marks,
    })

    /** Leave the cell only from its outer edge, and never out from under a popup. */
    /*
     * The edge is the VISIBLE one, not the logical one.
     *
     * It used to be computed by line number (`line.number === 1`), but the
     * editor wraps long lines: in a note with a paragraph spanning three screen
     * lines, ArrowUp from the second of them jumped into the previous cell
     * instead of moving up a line. For markdown that is almost every paragraph.
     *
     * We ask for coordinates: the caret is on the top SCREEN line if it stands
     * at the same height as the start of the document. A pixel of tolerance is
     * for subpixel rounding under screen scaling. While the editor has not been
     * measured there are no coordinates at all, and then the old rule by line
     * number remains: a press in the very first millisecond matters more than
     * precision.
     */
    function atVisualEdge(view: EditorView, direction: -1 | 1): boolean {
      const range = view.state.selection.main
      const here = view.coordsAtPos(range.head)
      const edge = view.coordsAtPos(direction === -1 ? 0 : view.state.doc.length)
      if (!here || !edge) {
        const line = view.state.doc.lineAt(range.head)
        return direction === -1 ? line.number === 1 : line.number === view.state.doc.lines
      }
      return direction === -1 ? here.top <= edge.top + 1 : here.bottom >= edge.bottom - 1
    }

    function arrowOut(view: EditorView, direction: -1 | 1): boolean {
      if (!handlers.onarrowout) return false
      if (completionStatus(view.state) === 'active') return false
      const range = view.state.selection.main
      if (!range.empty) return false
      if (!atVisualEdge(view, direction)) return false
      handlers.onarrowout(direction)
      return true
    }

    const cellKeymap = Prec.highest(
      keymap.of([
        /*
         * ⌘⇧↵ stands BEFORE ⇧↵ and ⌘↵ only for readability: a binding's set of
         * modifiers is exact, and "Shift-Enter" with Cmd held matches nothing
         * except this line. The order here is the order of the story: first
         * what submits, then what runs.
         */
        { key: 'Mod-Shift-Enter', preventDefault: true, run: () => fire(handlers.onsubmit) },
        { key: 'Shift-Enter', preventDefault: true, run: () => fire(handlers.onrunstep) },
        { key: 'Mod-Enter', preventDefault: true, run: () => fire(handlers.onrun) },
        { key: 'Alt-Enter', preventDefault: true, run: () => fire(handlers.onrunandadd) },
        {
          key: 'Escape',
          run: (view) => {
            // Let the completion popup have Escape first.
            if (completionStatus(view.state) === 'active') return false
            /*
             * Then — the hover help, and only then command mode.
             *
             * The order reads as "remove the nearest thing": first the list,
             * then the help, and only when nothing extra is left on screen does
             * Escape take one out of the cell. Otherwise one and the same
             * Escape would throw the person out of typing along with closing
             * the tooltip.
             *
             * Whether it is open is asked of the DOM, not of the state: hover
             * tooltips live in their own plugin, which shows only the node
             * itself to the outside. There is no way to get this wrong — the
             * node is ours and named by us.
             */
            if (view.dom.querySelector('.cm-signature')) {
              // Both kinds at once: the hover one and the one pinned by
              // Shift+Tab. Escape does not sort out which of them is on screen
              // right now — it removes what is extra.
              closeSignature(view)
              return true
            }
            return fire(handlers.onescape)
          },
        },
        {
          /*
           * Shift+Tab — help at the caret. Or an unindent, if there is no help
           * here.
           *
           * A refusal here (`false`) is not a refusal of the gesture but
           * passing the press on: below it in precedence stands the unindent
           * (lib/indent.ts), and that is exactly what should fire in a line
           * where the caret is not on a name. The rule and its price are at
           * `caretSpot`.
           */
          key: 'Shift-Tab',
          run: (view) => {
            if (!handlers.inspect || view.state.readOnly) return false
            const range = view.state.selection.main
            // A selection is about whole lines: there Shift+Tab shifts them,
            // and that case must not be taken away from it.
            if (!range.empty) return false
            const spot = caretSpot(cm, view, range.head)
            if (!spot) return false
            void openPinned(view, spot)
            return true
          },
        },
        {
          // A held Backspace does not delete the cell: see `repeating` above
          // and cell-keys.ts, where this rule is checked by a test.
          key: 'Backspace',
          run: (view) =>
            backspaceRemovesCell({ empty: view.state.doc.length === 0, repeat: repeating })
              ? fire(handlers.ondeleteempty)
              : false,
        },
        { key: 'ArrowUp', run: (view) => arrowOut(view, -1) },
        { key: 'ArrowDown', run: (view) => arrowOut(view, 1) },
      ]),
    )

    return new cm.view.EditorView({
      state: EditorState.create({
        doc: ytext.toString(),
        extensions: [
          lang === 'python' ? cm.py.python() : cm.md.markdown(),
          bracketMatching(),
          closeBrackets(),
          /*
           * Completion: the kernel first, then the words of the cell itself.
           *
           * `override` is the whole list of sources, and it deliberately has no
           * parse of the language tree: in Python the tree knows only keywords
           * and knows nothing at all about the name of a variable living in the
           * kernel. The kernel, on the other hand, knows both `df.head` and
           * `df.описание`, if the person named a column that way — that is the
           * difference between a hint from the text and a hint from what has
           * really been computed in the room.
           *
           * In a markdown cell there is neither one nor the other: people write
           * prose there, and a list of words popping up on every letter gets in
           * the way.
           */
          lang === 'python'
            ? [
                autocompletion({
                  override: [kernelCompletions, cm.py.localCompletionSource],
                  activateOnTyping: true,
                  icons: false,
                }),
                signatureHover,
                // The pinned help (Shift+Tab) is a field of its own, next to
                // it: see `pinnedField`.
                pinnedField,
                /*
                 * Go to definition — only in code. A note has no definitions at
                 * all, and underlining words in prose means promising a gesture
                 * that does not exist there.
                 */
                jumpClick,
                jumpHint,
              ]
            : autocompletion({ activateOnTyping: true, icons: false }),
          indentOnInput(),
          /*
           * Four spaces — the indent size in a cell.
           *
           * Without this line CodeMirror takes its own two, and Python in the
           * notebook is typed differently than everywhere else: Enter after
           * `def f():` put in two spaces, while code pasted from a file or from
           * someone's answer came in with four — one function ended up with two
           * different indents, and the kernel answered IndentationError at a
           * spot that cannot be told apart by eye. The file editor (FileEditor)
           * sets the same.
           */
          indentUnit.of(INDENT),
          highlightActiveLine(),
          /*
           * The highlight of the line a jump led to — in both languages,
           * although jumps lead only into code: an empty field costs nothing,
           * and a branch by language here would be one more place where the
           * rule and the gesture drift apart one day.
           */
          landing.field,
          cm.view.EditorView.lineWrapping,
          writable.of(writableExtensions(cm, editable)),
          hintSlot.of(hint ? placeholderExt(hint) : []),
          localeSlot.of(EditorState.phrases.of(editorPhrases())),
          cm.theme.colloqTheme,
          cm.view.EditorView.contentAttributes.of({ 'aria-label': label }),
          /*
           * The sheet's ceiling: a paste that does not fit is refused as a
           * whole, and with words; typing by hand is not forbidden meanwhile —
           * the rule and its arguments are in cell-paste.ts.
           *
           * Exactly two user events count as a paste — ⌘V and a mouse drop. The
           * transactions by which y-codemirror applies Y.Text edits (other
           * people's and our own SEED) have no userEvent at all, so their
           * `pasted` is false and there is nothing to refuse them by: a refusal
           * would pull the editor apart from the document.
           */
          ceiling === null
            ? []
            : EditorState.changeFilter.of((tr) => {
                if (!tr.docChanged) return true
                const pasted = tr.isUserEvent('input.paste') || tr.isUserEvent('input.drop')
                if (changeFits({ chars: tr.newDoc.length, ceiling, pasted })) return true
                handlers.onoverflow?.(tr.newDoc.length)
                return false
              }),
          // Yjs is the single source of truth for the text; no local history
          // extension, because the shared UndoManager already owns Mod-Z.
          cm.collab.yCollab(ytext, peers, { undoManager: undo }),
          cellKeymap,
          keymap.of([...closeBracketsKeymap, ...cm.commands.defaultKeymap]),
          /*
           * Tab accepts a completion — and only when the list is open.
           *
           * It stands ABOVE the indent on purpose: below it, it would never
           * fire, because `tabKey` always handles the press and does not let it
           * go further. When there is no list on screen, `acceptCompletion`
           * answers false, and the press goes on and puts in spaces, as it did.
           *
           * Ctrl-Space is the same list on demand, even in the middle of an
           * empty line. It is also in the keymap of `autocompletion` itself; it
           * is named here once more so that the promise "the hint can be called
           * up by hand" does not depend on the default of someone else's
           * package.
           */
          keymap.of([
            { key: 'Tab', run: acceptCompletion },
            { key: 'Mod-Space', preventDefault: true, run: startCompletion },
            { key: 'Ctrl-Space', preventDefault: true, run: startCompletion },
          ]),
          /*
           * Tab is an indent, not a focus move.
           *
           * CodeMirror has no Tab of its own: the press goes to the browser,
           * and the focus leaves the cell — in a notebook where people write
           * Python, that means there is nothing to type an indent with except
           * spaces by hand.
           *
           * Soft, not a line shift: the spaces go IN AT THE CURSOR, up to the
           * next tab stop. The ready-made `indentWithTab` shifts the whole
           * line, and Tab in the middle of typed text carried everything
           * already written to the right — the rule and its arguments are in
           * lib/indent.ts.
           *
           * It stands last and therefore loses to everyone who has already
           * taken Tab. At the cost of a keyboard trap: one cannot leave the
           * cell with Tab — Escape is for that, it also takes one into command
           * mode, and it is higher in precedence too. In a cell that may not be
           * edited (someone else's under a lock, a finished class), Tab still
           * moves the focus away: the rule declines on readOnly, and the press
           * goes to the browser.
           *
           * The same trade-off and the same line are in the file editor
           * (FileEditor).
           */
          keymap.of([
            tabKey({
              EditorSelection: cm.state.EditorSelection,
              indentMore: cm.commands.indentMore,
              indentLess: cm.commands.indentLess,
            }),
          ]),
          cm.view.EditorView.updateListener.of((update) => {
            if (update.focusChanged && update.view.hasFocus) handlers.onfocus?.()
          }),
        ],
      }),
      parent,
    })
  }

  /*
   * The shim tracks the document rather than snapshotting it, so a cell whose
   * text arrives from the server while the chunk is still in flight is already
   * showing the right lines when CodeMirror takes over.
   */
  $effect(() => {
    if (ready) return
    const ytext = text
    const sync = () => (shimText = ytext.toString())
    sync()
    ytext.observe(sync)
    return () => ytext.unobserve(sync)
  })

  /**
   * Reconfigure the live editor for a new edit rule — or null while there is no
   * editor.
   *
   * `$state.raw`, because the second effect has to wake up when the editor has
   * been rebuilt (another notebook, another language), not only when the rule
   * has changed.
   */
  let setWritable = $state.raw<((editable: boolean) => void) | null>(null)
  /** What is in the live editor now — so as not to reconfigure for nothing. */
  let writableNow = true
  let setLabels = $state.raw<((hint: string) => void) | null>(null)
  /**
   * Show in the live editor where a jump led — or null while there is no
   * editor.
   *
   * `$state.raw` by the same argument as for `setWritable`: the effect with the
   * mark has to wake up also when the editor has ONLY JUST been built. For a
   * jump this is not a rare case but the usual one: the notebook keeps a
   * distant cell as a placeholder and builds it only after scrolling, that is,
   * later than the answer arrived.
   */
  let setLanding = $state.raw<((spot: { line: number; column: number }) => void) | null>(null)
  /** The number of the last shown jump — so as not to show it twice. */
  let landedSeq = 0
  /**
   * The live editor — not for redrawing, but to ask about focus.
   *
   * A plain `let`, not `$state`: only the handlers read it, and a reactive one
   * would mean re-running the effect on every editor build.
   */
  let live: EditorView | null = null

  $effect(() => {
    const parent = host
    const ytext = text
    const scope = cellId
    /*
     * A cell's editor sees only its own cell's presence — otherwise a single
     * remote cursor wakes all mounted editors at once (see cell-awareness.ts).
     * One's own cursor is still announced into the real presence meanwhile: the
     * view only reads.
     */
    const scoped = scope ? cellAwareness(awareness, scope) : null
    const peers = scoped ?? awareness
    const undo = undoManager
    const lang = language
    if (!parent) {
      scoped?.destroy()
      return
    }

    const hint = untrack(() => placeholder)
    const focusOnReady = untrack(() => autoFocus)
    // The ceiling of one's own sheet is one for its whole life — like the
    // placeholder: tracking it would mean tearing down the editor under the
    // fingers for the sake of a number that does not change.
    const ceiling = untrack(() => maxChars)
    /*
     * `readOnly` is NOT tracked here, and that is a load-bearing decision.
     *
     * While it was tracked, a teacher who switched "Type in cells" to "Teacher
     * only" in the middle of a class tore down the editor for everyone: destroy
     * takes away the focused .cm-content, `holdingFocus` is computed after it
     * and lies, a code cell has no autoFocus — focus came back to nobody. The
     * next letters went into the notebook's command mode, where "a" inserts a
     * cell for the whole room and "d d" deletes the selected one. Now the rule
     * lives in a compartment and changes in place — see the effect below.
     */
    const editable = untrack(() => !readOnly)

    let view: EditorView | null = null
    let disposed = false
    /** The highlight's fade clock — one per editor, a jump restarts it. */
    let fading: ReturnType<typeof setTimeout> | null = null

    void loadCodeMirror().then((cm) => {
      if (disposed) return
      // Asked at the last moment rather than tracked: whatever the shim did
      // with focus, this is the one question that matters.
      const holdingFocus = parent.contains(document.activeElement)
      const writable = new cm.state.Compartment()
      const hintSlot = new cm.state.Compartment()
      const localeSlot = new cm.state.Compartment()
      const landing = makeLanding(cm)
      view = createView(cm, { parent, ytext, peers, undo, lang, editable, hint, writable, ceiling, hintSlot, localeSlot, landing })
      /*
       * Order matters, and nothing paints between these three statements. The
       * editor goes in first so focus can move straight from the shim into it:
       * a note commits itself the moment focus leaves the cell, and a moment
       * with nothing focused at all counts as leaving.
       */
      if (focusOnReady || holdingFocus) view.focus()
      ready = true
      const built = view
      live = built
      setLabels = (nextHint) => built.dispatch({ effects: [
        hintSlot.reconfigure(nextHint ? cm.view.placeholder(nextHint) : []),
        localeSlot.reconfigure(cm.state.EditorState.phrases.of(editorPhrases())),
      ] })
      writableNow = editable
      setWritable = (next) =>
        built.dispatch({ effects: writable.reconfigure(writableExtensions(cm, next)) })
      /**
       * Show where we were taken: highlight the line and — if typing is allowed
       * here — put the caret in it.
       *
       * Exactly in this order, and the highlight is the main thing here, the
       * caret secondary. In a cell that may not be edited, `focus()` does
       * NOTHING: a closed editor has `contenteditable=false`, and such a node
       * does not take focus at all — this was written down after a live failure
       * in CellView.svelte (a locked note that there was no way out of, because
       * the way out hung on losing focus). A jump, though, has to work there
       * too: someone else's notebook and a finished class are read more often
       * than edited. So "where we were taken" is said by the line decoration,
       * not by the caret.
       *
       * There is deliberately no scrolling here. `EditorView.scrollIntoView`
       * would go looking for a scroller up the ancestors — the cell has none of
       * its own (`.cm-scroller { overflow: visible }` further down in this
       * file) — that is, it would move the `<main>` in the middle of the
       * notebook's smooth move, and the browser treats such a change of
       * `scrollTop` as outside interference and cuts the move short
       * (Notebook.svelte · steering). The notebook takes one to the cell; the
       * editor only highlights the line.
       */
      setLanding = (spot) => {
        const doc = built.state.doc
        // The line may have moved: the answer was computed from text that has
        // been edited since. Missing inside the document is better than an
        // exception.
        const row = doc.line(Math.min(Math.max(1, Math.round(spot.line)), doc.lines))
        const pos = Math.min(row.from + Math.max(0, spot.column), row.to)
        const mayType = !built.state.readOnly
        built.dispatch({
          effects: landing.landed.of(row.from),
          selection: mayType ? cm.state.EditorSelection.cursor(pos) : undefined,
        })
        if (mayType) built.focus()
        if (fading !== null) clearTimeout(fading)
        fading = setTimeout(() => built.dispatch({ effects: landing.landed.of(null) }), LANDING_MS)
      }
      flushSync()
    })

    return () => {
      disposed = true
      setWritable = null
      setLabels = null
      setLanding = null
      if (fading !== null) clearTimeout(fading)
      if (live === view) live = null
      view?.destroy()
      view = null
      // After the editor: the plugin's `destroy` will still remove its listener
      // from the view.
      scoped?.destroy()
      ready = false
    }
  })

  /*
   * The edit rule changes in the middle of a class, and the editor survives it:
   * one compartment changes, while focus, the cursor, the scroll and an open
   * completion stay in place. The editor is built with the right value from the
   * start, so the first run of this effect is usually idle.
   */
  // Display language changes reconfigure labels in place; the editor, undo, and selection survive.
  $effect(() => {
    getLocale()
    setLabels?.(placeholder)
  })

  $effect(() => {
    const apply = setWritable
    const editable = !readOnly
    if (!apply || editable === writableNow) return
    writableNow = editable
    /*
     * The right to type was taken away from under the cursor — take the cursor
     * away too.
     *
     * `yCollab` announces the cursor position to the whole room while the
     * editor has focus, and that is right up to the moment the teacher closes
     * the cell. After that the `cursor` field in presence stays standing in it:
     * the neighbours have a caret with the person's name hanging until the end
     * of class where they are no longer typing anything. It will not go away by
     * itself — `yCollab` clears the field only for an editor IN FOCUS, and a
     * closed one does not take focus at all (`contenteditable=false`).
     *
     * We ask BEFORE reconfiguring, while the focus is still here: that is the
     * proof that the cursor in presence is ours and not another cell's.
     */
    if (!editable && live?.hasFocus) awareness.setLocalStateField('cursor', null)
    apply(editable)
  })

  /*
   * A jump has arrived — show it in the LIVE editor, without tearing it down.
   *
   * The same technique as for the edit rule and the label language above: the
   * mark is never read when the view is built, because it can arrive both
   * earlier than the view and much later. Earlier — when the notebook is still
   * building the cell; later — when the person came back and clicked the same
   * name a second time, and by the mark's fields this is the same jump. `seq`
   * tells them apart, and comparing with it is exactly what keeps one jump from
   * showing twice.
   */
  $effect(() => {
    const show = setLanding
    const spot = mark
    if (!show || !spot || spot.seq === landedSeq) return
    landedSeq = spot.seq
    show(spot)
  })
</script>

<!-- No height, no overflow: the editor is as tall as its content and the page scrolls. -->
<div
  bind:this={host}
  class="cm-cell text-ink"
  onkeydowncapture={(event) => (repeating = event.repeat)}
>
  {#if !ready}
    <!--
      Stands in for CodeMirror at CodeMirror's own metrics. It wears two of
      CodeMirror's class names deliberately: .cm-content is what the cell's
      focus handling reaches for, and .cm-editor is both where index.css keeps
      the type scale and what the notebook checks before deciding a keystroke
      belongs to it and not to the cell — without it, typing here would move the
      selection or delete the cell. Read-only on purpose: replaying keystrokes
      into a CRDT after the fact is a good way to lose one, so focus follows the
      user into the real editor instead.
    -->
    <div
      class="cm-shim cm-editor cm-content"
      role="textbox"
      tabindex="0"
      aria-multiline="true"
      aria-readonly="true"
      aria-busy="true"
      aria-label={tr('room.ui.435')}
      onpointerdown={(event) => event.currentTarget.focus()}
    >
      {#each shimLines as line, index}
        <span class="cm-shim-line"
          >{line}{#if index === 0 && placeholder && shimText === ''}<span class="cm-placeholder"
              >{placeholder}</span
            >{/if}</span
        >
      {/each}
    </div>
  {/if}
</div>

<style>
  .cm-cell :global(.cm-editor) {
    height: auto;
  }
  /*
   * The cell scrolls nothing and clips nothing.
   *
   * The editor's height follows its content, and the page scrolls — but
   * `overflow-x: auto` from index.css made the scroller clip vertically too
   * (with `overflow-x: auto` the second axis cannot be `visible`), and
   * `overflow-y: hidden` here cemented that. And what got clipped was the only
   * thing that goes beyond a line at all: the pill with a neighbour's name — it
   * hangs ABOVE the line, and on the first line of the cell only nine pixels of
   * fourteen were left of it, that is, letters cut off at the horizon.
   *
   * This costs scrolling nothing: lines in a cell wrap
   * (`EditorView.lineWrapping`), and a horizontal scrollbar has nowhere to come
   * from here.
   */
  .cm-cell :global(.cm-scroller) {
    overflow: visible;
  }

  /*
   * Every number below is CodeMirror's own, verified by measuring both against
   * each other: the swap moves no pixel and wraps at the same columns. The type
   * scale arrives with .cm-editor from index.css; the rest is CodeMirror's base
   * theme and cm-theme.ts. Grid rather than two columns because a wrapped line
   * has to push its own line number down, which is what CodeMirror does by
   * measuring every block — and what a grid row does for free.
   */
  .cm-shim {
    display: grid;
    grid-template-columns: minmax(0, 1fr);
    /* CodeMirror's base theme pads .cm-content by 4px and outranks index.css's
       rule for the real editor, so 4px is what the swap has to land on. */
    padding: 4px 0;
    outline: none;
  }
  .cm-shim-line {
    /* An empty line has no text to give it height; one line box, as in the editor. */
    min-height: 1.65em;
    padding: 0 8px 0 4px;
    white-space: pre-wrap;
    overflow-wrap: anywhere;
    tab-size: 4;
  }
</style>
