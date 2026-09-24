<script lang="ts" module>
  import { tr, getLocale } from '@shared/i18n'
  import { editorPhrases } from '@/lib/editor-locale'
  /*
   * The file editor — the same CodeMirror as in the cells, assembled
   * differently.
   *
   * A cell has no height: it is exactly as tall as its text, and the page
   * scrolls. A file has a height — it takes up the whole centre and scrolls
   * itself — and every difference comes from that: its own scroller, line
   * numbers, search, and keys that are not about the neighbouring cell but
   * about the file itself.
   *
   * Each language's grammar loads as a separate chunk, not all at once: a
   * room where one .py was opened does not pay for parsing YAML and HTML.
   * The core is shared with the cells, and Vite puts it into one chunk for
   * both.
   */
  import type { Highlight } from '@shared/paths'
  import type { DecorationSet, EditorView } from '@codemirror/view'
  import { questionAt } from '@shared/python-defs'
  import { isJumpClick } from '@/lib/utils'

  async function importCore() {
    const [autocomplete, commands, language, search, state, view, collab, theme] =
      await Promise.all([
        import('@codemirror/autocomplete').then(
          ({ autocompletion, closeBrackets, closeBracketsKeymap }) => ({
            autocompletion,
            closeBrackets,
            closeBracketsKeymap,
          }),
        ),
        import('@codemirror/commands').then(({ defaultKeymap, indentLess, indentMore }) => ({
          defaultKeymap,
          indentLess,
          indentMore,
        })),
        import('@codemirror/language').then(
          ({ bracketMatching, foldGutter, indentOnInput, indentUnit }) => ({
            bracketMatching,
            foldGutter,
            indentOnInput,
            indentUnit,
          }),
        ),
        import('@codemirror/search').then(({ highlightSelectionMatches, search, searchKeymap, closeSearchPanel, openSearchPanel, searchPanelOpen }) => ({
          highlightSelectionMatches,
          closeSearchPanel, openSearchPanel, searchPanelOpen,
          search,
          searchKeymap,
        })),
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
            Decoration,
            EditorView,
            highlightActiveLine,
            highlightActiveLineGutter,
            keymap,
            lineNumbers,
            ViewPlugin,
          }) => ({
            Decoration,
            EditorView,
            highlightActiveLine,
            highlightActiveLineGutter,
            keymap,
            lineNumbers,
            ViewPlugin,
          }),
        ),
        import('y-codemirror.next').then(({ yCollab }) => ({ yCollab })),
        import('./editor-theme').then(({ fileTheme }) => ({ fileTheme })),
      ])
    return { autocomplete, commands, language, search, state, view, collab, theme }
  }

  type Core = Awaited<ReturnType<typeof importCore>>

  /** Both sides of "can I type" in one piece, so they cannot drift apart. */
  function writableExtensions(cm: Core, editable: boolean) {
    return [cm.state.EditorState.readOnly.of(!editable), cm.view.EditorView.editable.of(editable)]
  }

  let coreInFlight: Promise<Core> | null = null
  function loadCore(): Promise<Core> {
    return (coreInFlight ??= importCore())
  }

  /**
   * The grammar for a language — or nothing.
   *
   * JSON and YAML are parsed by their own grammars, not by JavaScript as
   * "close enough": in an `.ipynb` notebook the quotes inside strings and the
   * trailing commas are exactly what anyone opens it by hand for.
   */
  const grammars: Record<Highlight, () => Promise<{ extension: unknown }>> = {
    python: () => import('@codemirror/lang-python').then(({ python }) => python()),
    markdown: () => import('@codemirror/lang-markdown').then(({ markdown }) => markdown()),
    json: () => import('@codemirror/lang-json').then(({ json }) => json()),
    yaml: () => import('@codemirror/lang-yaml').then(({ yaml }) => yaml()),
    javascript: () => import('@codemirror/lang-javascript').then(({ javascript }) => javascript()),
    css: () => import('@codemirror/lang-css').then(({ css }) => css()),
    html: () => import('@codemirror/lang-html').then(({ html }) => html()),
  }

  const grammarCache = new Map<Highlight, Promise<{ extension: unknown }>>()
  function loadGrammar(name: Highlight | null): Promise<{ extension: unknown } | null> {
    if (!name) return Promise.resolve(null)
    const cached = grammarCache.get(name)
    if (cached) return cached
    const made = grammars[name]()
    grammarCache.set(name, made)
    return made
  }

  /** How long the bar under the line a jump led to stays lit. */
  const LANDED_MS = 2000

  /**
   * The number of the last applied landing — for the whole module, not per
   * instance.
   *
   * SessionScreen keeps this editor under `{#key activePath}`: leaving for a
   * neighbouring tab and coming back means a NEW CodeMirror and a new run of
   * the effect, while the mark in lib/goto.svelte.ts is still there and still
   * about this file (it is state, not an event — why is written there too).
   * A counter living in the instance would be reset along with it, and every
   * return to the tab would carry the caret off to the definition again —
   * even an hour after the jump itself.
   */
  let appliedSeq = 0

  /**
   * Go to definition: the underline under a held modifier, and the gesture
   * itself.
   *
   * A second copy of what the cell has (notebook/CodeEditor.svelte), for the
   * same reason this whole editor lives as a copy: the file has its own set
   * of extensions. What is shared sits where it belongs: the parsing in
   * shared/python-defs.ts, the answer to "where to go" on the server, and
   * the decision about what to do with the answer in lib/goto.svelte.ts.
   *
   * It is installed ONLY for Python (see where the editor is assembled):
   * `questionAt` parses Python, and an underlined name in YAML would promise
   * a jump that never comes.
   */
  function gotoGesture(cm: Core, jump: (code: string, cursor: number) => void) {
    const { Decoration, ViewPlugin } = cm.view
    const { Prec, StateEffect, StateField } = cm.state

    const mark = Decoration.mark({ class: 'cm-goto' })
    const setGoto = StateEffect.define<{ from: number; to: number } | null>()
    const underline = StateField.define<DecorationSet>({
      create: () => Decoration.none,
      update(deco, tr) {
        // The loop variable is called `sent`, not `effect`: svelte2tsx breaks
        // parsing of the WHOLE file on a local name `effect` next to runes
        // (verified — 34 errors out of nowhere, starting with `of` on the line
        // below).
        for (const sent of tr.effects) {
          if (sent.is(setGoto)) {
            const at = sent.value
            return at ? Decoration.set([mark.range(at.from, at.to)]) : Decoration.none
          }
        }
        // The text moved under the pointer — a neighbour is typing higher up
        // in the file, and the underlined name is no longer the right one.
        // The next mouse move sets it again.
        return tr.docChanged ? Decoration.none : deco
      },
      provide: (self) => cm.view.EditorView.decorations.from(self),
    })

    /*
     * The file's whole text — but not on every mouse move.
     *
     * `questionAt` reads the source from the start: there is no other way to
     * know the triple-quote state at the clicked line. Files up to 1.5 MB are
     * let into the editor (server/src/workspace.ts · MAX_TEXT_BYTES), and
     * `doc.toString()` on every pixel is a megabyte of garbage per second. A
     * CodeMirror document is immutable, so it can be compared by reference
     * instead of building the string again.
     */
    let lastDoc: unknown = null
    let lastText = ''
    const textOf = (view: EditorView): string => {
      if (view.state.doc !== lastDoc) {
        lastDoc = view.state.doc
        lastText = view.state.doc.toString()
      }
      return lastText
    }

    /** What is underlined right now, so nothing is dispatched on every pixel. */
    const shown = (view: EditorView): { from: number; to: number } | null => {
      const at = view.state.field(underline, false)?.iter()
      return at?.value ? { from: at.from, to: at.to } : null
    }

    const put = (view: EditorView, at: { from: number; to: number } | null): void => {
      const now = shown(view)
      if (!now && !at) return
      if (now && at && now.from === at.from && now.to === at.to) return
      view.dispatch({ effects: setGoto.of(at) })
    }

    const nameAt = (view: EditorView, event: MouseEvent) => {
      const pos = view.posAtCoords({ x: event.clientX, y: event.clientY })
      if (pos === null) return null
      const question = questionAt(textOf(view), pos)
      return question ? { from: question.from, to: question.to, pos } : null
    }

    const handlers = cm.view.EditorView.domEventHandlers({
      mousemove(event, view) {
        /*
         * Parsing happens only while the modifier is held, and that is not
         * saving for the sake of saving: `questionAt` on a 1.5 MB file costs
         * milliseconds, and there can be a hundred mouse moves a second. With
         * the key held there are only a handful, and even then a transaction
         * is dispatched only when the name has really changed.
         */
        if (!isJumpClick(event)) {
          put(view, null)
          return false
        }
        put(view, nameAt(view, event))
        return false
      },
      mouseleave(_event, view) {
        put(view, null)
        return false
      },
      keyup(_event, view) {
        // The modifier was released — there must be no underline, even if the
        // mouse has not moved since.
        put(view, null)
        return false
      },
      mousedown(event, view) {
        if (event.button !== 0 || !isJumpClick(event)) return false
        const found = nameAt(view, event)
        // Not a name under the pointer — the click stays an ordinary click.
        if (!found) return false
        /*
         * The editor's own behaviour is intercepted too: without this
         * CodeMirror would place the caret at the click, and a person who
         * comes back would not find it where they left it. Returning `true`
         * tells the editor the same thing.
         */
        event.preventDefault()
        put(view, null)
        jump(textOf(view), found.pos)
        return true
      },
    })

    /*
     * Cmd+Tab takes the `keyup` away with it: the modifier is released in
     * another window already, and the underline would stay hanging until the
     * next mouse move — and a person who came back would click it expecting
     * an ordinary click. So it is also cleared when the window loses focus
     * and when the tab is hidden.
     */
    const watch = ViewPlugin.fromClass(
      class {
        view: EditorView
        constructor(view: EditorView) {
          this.view = view
          window.addEventListener('blur', this.drop)
          document.addEventListener('visibilitychange', this.drop)
        }
        drop = () => {
          put(this.view, null)
        }
        destroy() {
          window.removeEventListener('blur', this.drop)
          document.removeEventListener('visibilitychange', this.drop)
        }
      },
    )

    return [underline, watch, Prec.highest(handlers)]
  }

  /**
   * The bar under the line a jump led to — and what lights it.
   *
   * A separate thing from the underline: the underline is about "you can go
   * here", while this is about "here is where I brought you", and it lives
   * for seconds, not for as long as a key is held.
   */
  function landingMark(cm: Core) {
    const { Decoration } = cm.view
    const { StateEffect, StateField } = cm.state
    const show = StateEffect.define<number>()
    const hide = StateEffect.define<null>()
    const row = Decoration.line({ class: 'cm-landed' })
    const field = StateField.define<DecorationSet>({
      create: () => Decoration.none,
      update(deco, tr) {
        for (const sent of tr.effects) {
          if (sent.is(show)) {
            return Decoration.set([row.range(tr.state.doc.lineAt(sent.value).from)])
          }
          if (sent.is(hide)) return Decoration.none
        }
        /*
         * The very first caret move of the person's own clears the bar: it
         * answers the question "where was I brought", and once the person has
         * placed the caret themselves, it is left as a puzzling bar in the
         * middle of the code. The landing's own transaction does not get here
         * — it carries `show`, and the loop above returns earlier, even though
         * it moves the caret too.
         */
        if (deco.size && (tr.selection || tr.docChanged)) return Decoration.none
        return deco.map(tr.changes)
      },
      provide: (self) => cm.view.EditorView.decorations.from(self),
    })
    return { field, show, hide }
  }
</script>

<script lang="ts">
  import { untrack } from 'svelte'
  import type { FileDoc } from '@/lib/filedoc.svelte'
  import { baseOf, highlightFor } from '@shared/paths'
  import { INDENT, tabKey } from '@/lib/indent'
  import { jumpToDefinition, landingInFile } from '@/lib/goto.svelte'
  import { getSessionState } from '@/lib/session.svelte'

  interface Props {
    file: FileDoc
    /** Whether this person edits or only reads. */
    readOnly: boolean
    /** Run the file — Cmd+Enter. Nothing if there is no runner for it. */
    onrun?: (() => void) | null
  }

  let { file, readOnly, onrun }: Props = $props()

  const session = getSessionState()

  let host = $state<HTMLDivElement | null>(null)
  let ready = $state(false)

  /*
   * Who I am here — for the cursors others see in this file.
   *
   * The file has its own presence, separate from the room's: the cursors
   * inside the text live in it, and they never reach the room at all. The
   * name and colour are the very same, otherwise one person would turn into
   * two different people in two places on the screen.
   */
  $effect(() => {
    const me = session.me
    file.setUser({
      id: me.id,
      name: me.name,
      avatar: me.avatar,
      color: me.color,
      role: me.role,
    })
  })

  /*
   * The handlers live in a holder instead of being read by the keymap
   * directly: otherwise the editor would depend on them, and a rebuild on
   * every press in the parent would throw away the cursor and the undo
   * history.
   */
  const handlers: { onrun?: (() => void) | null } = {}
  $effect(() => {
    handlers.onrun = onrun
  })

  let view: EditorView | null = null
  /**
   * Switch the rule in the live editor. `null` while there is no editor.
   *
   * `$state.raw`, because the second effect must also wake up when the editor
   * has been built anew (another file), not only when the rule has changed.
   */
  let setWritable = $state.raw<((editable: boolean) => void) | null>(null)
  /** What the live editor has now — so it is not reconfigured for nothing. */
  let writableNow = true
  let setLabels = $state.raw<(() => void) | null>(null)
  /**
   * Put the caret where the jump led and highlight the line.
   *
   * `null` while there is no editor at all — and that is no trifle: until the
   * text arrives there is a "reading the file…" placeholder here, while the
   * jump's mark may already be waiting. `$state.raw`, for the same reason as
   * with the neighbours above: the landing effect must also wake up when the
   * editor has been built anew.
   */
  let landOn = $state.raw<((line: number, column: number) => void) | null>(null)

  $effect(() => {
    const parent = host
    const doc = file
    /*
     * `readOnly` is NOT tracked here, and that is a load-bearing decision.
     *
     * While it was tracked, a teacher who changed the `files` rule in the
     * middle of a class tore down everyone's editor: `destroy` takes away the
     * focused `.cm-content` together with the cursor, the selection and the
     * scroll, and a person who was writing into the file ended up in
     * unfamiliar text scrolled to nowhere. Now the rule lives in a
     * compartment and changes in place — see the effect below; the cells do
     * the same (CodeEditor.svelte).
     */
    const editable = untrack(() => !readOnly)
    if (!parent) return

    let disposed = false
    let made: EditorView | null = null
    /** The timer that clears the landing bar. Removed along with the editor. */
    let fade: number | undefined

    void Promise.all([loadCore(), loadGrammar(highlightFor(doc.path))]).then(([cm, grammar]) => {
      if (disposed) return
      const { autocompletion, closeBrackets, closeBracketsKeymap } = cm.autocomplete
      const { bracketMatching, foldGutter, indentOnInput, indentUnit } = cm.language
      const { highlightSelectionMatches, search, searchKeymap } = cm.search
      const { EditorState, Prec } = cm.state
      const { EditorView, highlightActiveLine, highlightActiveLineGutter, keymap, lineNumbers } =
        cm.view

      const fileKeys = Prec.highest(
        keymap.of([
          {
            /*
             * Ctrl+S saves nothing — the file is on disk anyway a second
             * after the last keystroke. It is intercepted so that the "save
             * page" window does not open: a person who pressed it out of habit
             * should not get a browser dialog in return.
             */
            key: 'Mod-s',
            preventDefault: true,
            run: () => true,
          },
          {
            key: 'Mod-Enter',
            preventDefault: true,
            run: () => {
              if (!handlers.onrun) return false
              handlers.onrun()
              return true
            },
          },
        ]),
      )

      /*
       * Go to definition — only for Python.
       *
       * The language here is the same one the grammar was picked by: .py and
       * .pyi. Other files have no gesture at all — no underline, no click
       * interception — and Cmd+click on a .md stays an ordinary click.
       */
      const goto =
        highlightFor(doc.path) === 'python'
          ? gotoGesture(cm, (code, cursor) => {
              void jumpToDefinition(session, code, cursor, { path: doc.path })
            })
          : []
      const landed = landingMark(cm)

      const writable = new cm.state.Compartment()
      const localeSlot = new cm.state.Compartment()
      made = new EditorView({
        state: EditorState.create({
          doc: doc.text.toString(),
          extensions: [
            localeSlot.of(EditorState.phrases.of(editorPhrases())),
            lineNumbers(),
            highlightActiveLineGutter(),
            highlightActiveLine(),
            foldGutter(),
            bracketMatching(),
            closeBrackets(),
            indentOnInput(),
            // Four spaces: the files at a seminar are Python, and Python in
            // this product is written in cells, where the indent is already
            // that (lib/indent.ts).
            indentUnit.of(INDENT),
            autocompletion({ activateOnTyping: true, icons: false }),
            highlightSelectionMatches(),
            search({ top: true }),
            EditorView.lineWrapping,
            writable.of(writableExtensions(cm, editable)),
            cm.theme.fileTheme,
            grammar ? (grammar.extension as never) : [],
            goto,
            landed.field,
            // The shared text is the source of truth; the editor has no
            // history of its own, Mod-Z belongs to the shared UndoManager.
            cm.collab.yCollab(doc.text, doc.awareness, { undoManager: doc.undoManager }),
            fileKeys,
            keymap.of([...closeBracketsKeymap, ...searchKeymap, ...cm.commands.defaultKeymap]),
            /*
             * Tab is an indent, not a focus move.
             *
             * A soft one: spaces go in AT THE CURSOR, up to the next tab
             * stop, while whole lines are moved by a selection and by
             * Shift-Tab. The rule is shared with the cell — lib/indent.ts,
             * where the reasons are too.
             *
             * It comes last and so loses to everyone who has already claimed
             * Tab — the completer first of all. At the cost of a keyboard
             * trap: you cannot leave the editor with Tab, Escape is there for
             * that. For a field written in indents, that is the right trade.
             */
            keymap.of([
              tabKey({
                EditorSelection: cm.state.EditorSelection,
                indentMore: cm.commands.indentMore,
                indentLess: cm.commands.indentLess,
              }),
            ]),
          ],
        }),
        parent,
      })
      view = made
      const built = made
      setLabels = () => {
        const focused = document.activeElement instanceof HTMLElement ? document.activeElement : null
        const field = focused instanceof HTMLInputElement && focused.closest('.cm-search') ? focused : null
        const name = field?.name
        const start = field?.selectionStart ?? null
        const end = field?.selectionEnd ?? null
        const open = cm.search.searchPanelOpen(built.state)
        built.dispatch({ effects: localeSlot.reconfigure(EditorState.phrases.of(editorPhrases())) })
        // CodeMirror reads panel phrases on creation. Its search query lives in
        // editor state, so renewing just this panel preserves both query and editor.
        if (open) {
          cm.search.closeSearchPanel(built)
          cm.search.openSearchPanel(built)
          const next = name ? built.dom.querySelector<HTMLInputElement>(`.cm-search input[name="${name}"]`) : null
          if (next) {
            next.focus()
            if (start !== null && end !== null) next.setSelectionRange(start, end)
          } else focused?.focus()
        }
      }
      writableNow = editable
      setWritable = (next) =>
        built.dispatch({ effects: writable.reconfigure(writableExtensions(cm, next)) })
      landOn = (line, column) => {
        const text = built.state.doc
        /*
         * The line number came from the server and is about THE text it had
         * at hand: since then a neighbour editing the file alongside may have
         * shortened it. Missing to the end of the file is more honest than
         * crashing the editor with an exception on a line that does not
         * exist.
         */
        const row = text.line(Math.min(Math.max(1, line), text.lines))
        const pos = Math.min(row.from + column, row.to)
        built.dispatch({
          selection: cm.state.EditorSelection.cursor(pos),
          /*
           * The editor itself scrolls there, not the room's screen, and that
           * is exactly how a file differs from a cell: it has its own
           * scroller (`.cm-scroller` below), and there is nothing outside to
           * move it with. A cell, on the contrary, is scrolled to by the
           * notebook — see lib/goto.svelte.ts.
           */
          effects: [EditorView.scrollIntoView(pos, { y: 'center' }), landed.show.of(pos)],
        })
        built.focus()
        window.clearTimeout(fade)
        fade = window.setTimeout(
          () => built.dispatch({ effects: landed.hide.of(null) }),
          LANDED_MS,
        )
      }
      ready = true
    })

    return () => {
      disposed = true
      window.clearTimeout(fade)
      setWritable = null
      setLabels = null
      landOn = null
      made?.destroy()
      if (view === made) view = null
      ready = false
    }
  })

  /*
   * The `files` rule changes in the middle of a class, and the editor
   * survives it: one compartment changes, while focus, cursor and scroll stay
   * in place. The editor is built with the right value already, so the first
   * run does nothing.
   */
  $effect(() => {
    getLocale()
    setLabels?.()
  })

  $effect(() => {
    const apply = setWritable
    const editable = !readOnly
    if (!apply || editable === writableNow) return
    writableNow = editable
    apply(editable)
  })

  /* The file's first showing puts the cursor into the editor: the person
     opened it to read and edit, and an extra mouse click here settles
     nothing. */
  $effect(() => {
    if (!ready) return
    untrack(() => view)?.focus()
  })

  /** The "a jump led here" mark — or nothing. Lives in lib/goto.svelte.ts. */
  const landing = $derived(landingInFile(file.path))

  /*
   * The landing.
   *
   * It stands AFTER the focus effect on purpose: `view.focus()` brings the
   * browser back to the caret, and in a freshly built editor that is at the
   * start of the file — so if focus came second, it would carry the screen
   * away from the found line back to the top.
   *
   * It waits for `landOn`, not `ready`: until the text has arrived there is a
   * placeholder instead of the editor, and there is simply nowhere to land.
   * The mark survives this — it is state, not an event, and waits for the
   * built editor by itself.
   */
  $effect(() => {
    const land = landOn
    const mark = landing
    if (!land || !mark || !file.ready) return
    if (mark.seq <= appliedSeq) return
    appliedSeq = mark.seq
    land(mark.line, mark.column)
  })
</script>

<div class="flex min-h-0 flex-1 flex-col bg-canvas">
  {#if file.ready}
    <div bind:this={host} class="cm-file min-h-0 flex-1 overflow-hidden"></div>
  {:else}
    <!--
      Until the text arrives there is no editor at all.

      An empty document before `sync` means "not read yet", not "the file is
      empty" — and an editor that shows emptiness invites typing into it, all
      the more since it puts the cursor there itself. What was typed did not
      vanish: it merged with the arriving file and a second later went to
      disk for the whole room.
    -->
    <div class="flex min-h-0 flex-1 items-center justify-center text-ui text-muted"> {tr('room.ui.107')} {baseOf(file.path)}…
    </div>
  {/if}
</div>

<style>
  /* The editor takes up the whole column and scrolls itself: the page under
     it does not move, because moving it would take the tab row and the file
     panel out of view. */
  .cm-file :global(.cm-editor) {
    height: 100%;
  }
  .cm-file :global(.cm-scroller) {
    overflow: auto;
  }

  /*
   * The go-to-definition styling lives here, not in the theme.
   *
   * The file theme (editor-theme.ts) is assembled from the editor's shared
   * styling and what only the file has, and both halves are general styling,
   * as with the cell. These two classes are set by an extension declared
   * right in this component, and keeping them in a third place would split
   * the gesture and its look across different files.
   */
  .cm-file :global(.cm-goto) {
    text-decoration: underline;
    text-decoration-color: rgb(var(--accent-text));
    text-underline-offset: 3px;
    cursor: pointer;
  }
  /* The bar overrides the active line's background: after a jump the caret
     sits right on it, and without `!important` only the ordinary highlight of
     the line under the cursor would show — the same trick for the same reason
     as in editor-theme.ts. */
  .cm-file :global(.cm-landed) {
    background-color: rgb(var(--accent) / 0.14) !important;
    box-shadow: inset 2px 0 0 rgb(var(--accent-text));
  }
</style>
