<script lang="ts" module>
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
          ({ autocompletion, closeBrackets, closeBracketsKeymap, completionStatus }) => ({
            autocompletion,
            closeBrackets,
            closeBracketsKeymap,
            completionStatus,
          }),
        ),
        import('@codemirror/commands').then(({ defaultKeymap }) => ({ defaultKeymap })),
        import('@codemirror/lang-markdown').then(({ markdown }) => ({ markdown })),
        import('@codemirror/lang-python').then(({ python }) => ({ python })),
        import('@codemirror/language').then(({ bracketMatching, indentOnInput }) => ({
          bracketMatching,
          indentOnInput,
        })),
        import('@codemirror/state').then(({ Compartment, EditorState, Prec }) => ({
          Compartment,
          EditorState,
          Prec,
        })),
        import('@codemirror/view').then(
          ({ EditorView, highlightActiveLine, keymap, placeholder }) => ({
            EditorView,
            highlightActiveLine,
            keymap,
            placeholder,
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
  import type { Compartment } from '@codemirror/state'
  import type { EditorView } from '@codemirror/view'

  interface Props {
    text: Y.Text
    awareness: Awareness
    undoManager: Y.UndoManager
    language: 'python' | 'markdown'
    readOnly?: boolean
    autoFocus?: boolean
    onfocus?: () => void
    onrun?: () => void
    /** Run, then move on — Shift+Enter. See CellView.runAndStep. */
    onrunstep?: () => void
    onrunandadd?: () => void
    onescape?: () => void
    ondeleteempty?: () => void
    onarrowout?: (direction: -1 | 1) => void
    placeholder?: string
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
    undoManager,
    language,
    readOnly = false,
    autoFocus = false,
    onfocus,
    onrun,
    onrunstep,
    onrunandadd,
    onescape,
    ondeleteempty,
    onarrowout,
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
    'onfocus' | 'onrun' | 'onrunstep' | 'onrunandadd' | 'onescape' | 'ondeleteempty' | 'onarrowout'
  > = {}

  $effect(() => {
    handlers.onfocus = onfocus
    handlers.onrun = onrun
    handlers.onrunstep = onrunstep
    handlers.onrunandadd = onrunandadd
    handlers.onescape = onescape
    handlers.ondeleteempty = ondeleteempty
    handlers.onarrowout = onarrowout
  })

  function fire(callback: (() => void) | undefined): boolean {
    if (!callback) return false
    callback()
    return true
  }

  interface ViewOptions {
    parent: HTMLElement
    ytext: Y.Text
    peers: Awareness
    undo: Y.UndoManager
    lang: Props['language']
    editable: boolean
    hint: string
    /** Отсек, через который правило edit меняют, не разбирая редактор. */
    writable: Compartment
  }

  /** Обе стороны «можно ли печатать» — одним куском, чтобы их нельзя было развести. */
  function writableExtensions(cm: CodeMirror, editable: boolean) {
    return [cm.state.EditorState.readOnly.of(!editable), cm.view.EditorView.editable.of(editable)]
  }

  function createView(cm: CodeMirror, options: ViewOptions): EditorView {
    const { autocompletion, closeBrackets, closeBracketsKeymap, completionStatus } = cm.autocomplete
    const { bracketMatching, indentOnInput } = cm.language
    const { EditorState, Prec } = cm.state
    const { highlightActiveLine, keymap, placeholder: placeholderExt } = cm.view
    const { parent, ytext, peers, undo, lang, editable, hint, writable } = options

    /** Leave the cell only from its outer edge, and never out from under a popup. */
    function arrowOut(view: EditorView, direction: -1 | 1): boolean {
      if (!handlers.onarrowout) return false
      if (completionStatus(view.state) === 'active') return false
      const range = view.state.selection.main
      if (!range.empty) return false
      const line = view.state.doc.lineAt(range.head)
      const atEdge = direction === -1 ? line.number === 1 : line.number === view.state.doc.lines
      if (!atEdge) return false
      handlers.onarrowout(direction)
      return true
    }

    const cellKeymap = Prec.highest(
      keymap.of([
        { key: 'Shift-Enter', preventDefault: true, run: () => fire(handlers.onrunstep) },
        { key: 'Mod-Enter', preventDefault: true, run: () => fire(handlers.onrun) },
        { key: 'Alt-Enter', preventDefault: true, run: () => fire(handlers.onrunandadd) },
        {
          key: 'Escape',
          run: (view) => {
            // Let the completion popup have Escape first.
            if (completionStatus(view.state) === 'active') return false
            return fire(handlers.onescape)
          },
        },
        {
          key: 'Backspace',
          run: (view) => (view.state.doc.length === 0 ? fire(handlers.ondeleteempty) : false),
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
          autocompletion({ activateOnTyping: true, icons: false }),
          indentOnInput(),
          highlightActiveLine(),
          cm.view.EditorView.lineWrapping,
          writable.of(writableExtensions(cm, editable)),
          hint ? placeholderExt(hint) : [],
          cm.theme.colloqTheme,
          cm.view.EditorView.contentAttributes.of({ 'aria-label': label }),
          // Yjs is the single source of truth for the text; no local history
          // extension, because the shared UndoManager already owns Mod-Z.
          cm.collab.yCollab(ytext, peers, { undoManager: undo }),
          cellKeymap,
          keymap.of([...closeBracketsKeymap, ...cm.commands.defaultKeymap]),
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
   * Переконфигурировать живой редактор под новое правило edit — или null, пока
   * редактора нет.
   *
   * `$state.raw`, потому что второй эффект должен проснуться, когда редактор
   * построился заново (другая тетрадь, другой язык), а не только когда правило
   * поменялось.
   */
  let setWritable = $state.raw<((editable: boolean) => void) | null>(null)
  /** Что стоит в живом редакторе сейчас — чтобы не переконфигурировать впустую. */
  let writableNow = true

  $effect(() => {
    const parent = host
    const ytext = text
    const peers = awareness
    const undo = undoManager
    const lang = language
    if (!parent) return

    const hint = untrack(() => placeholder)
    const focusOnReady = untrack(() => autoFocus)
    /*
     * `readOnly` здесь НЕ отслеживается, и это несущее решение.
     *
     * Пока отслеживался, преподаватель, переключивший «Печатать в ячейках» на
     * «только преподаватель» посреди пары, разбирал редактор у всех: destroy
     * уносит сфокусированный .cm-content, `holdingFocus` считается уже после
     * него и врёт, autoFocus у кодовой ячейки нет — фокус не возвращался
     * никому. Следующие буквы уходили в командный режим тетради, где «a»
     * вставляет ячейку всей комнате, а «d d» удаляет выбранную. Теперь правило
     * живёт в отсеке и меняется на месте — см. эффект ниже.
     */
    const editable = untrack(() => !readOnly)

    let view: EditorView | null = null
    let disposed = false

    void loadCodeMirror().then((cm) => {
      if (disposed) return
      // Asked at the last moment rather than tracked: whatever the shim did
      // with focus, this is the one question that matters.
      const holdingFocus = parent.contains(document.activeElement)
      const writable = new cm.state.Compartment()
      view = createView(cm, { parent, ytext, peers, undo, lang, editable, hint, writable })
      /*
       * Order matters, and nothing paints between these three statements. The
       * editor goes in first so focus can move straight from the shim into it:
       * a note commits itself the moment focus leaves the cell, and a moment
       * with nothing focused at all counts as leaving.
       */
      if (focusOnReady || holdingFocus) view.focus()
      ready = true
      const built = view
      writableNow = editable
      setWritable = (next) =>
        built.dispatch({ effects: writable.reconfigure(writableExtensions(cm, next)) })
      flushSync()
    })

    return () => {
      disposed = true
      setWritable = null
      view?.destroy()
      view = null
      ready = false
    }
  })

  /*
   * Правило edit меняется посреди пары, и редактор его переживает: меняется
   * один отсек, фокус, курсор, прокрутка и открытая подсказка остаются на
   * месте. Строится редактор уже с верным значением, так что первый прогон
   * этого эффекта — обычно холостой.
   */
  $effect(() => {
    const apply = setWritable
    const editable = !readOnly
    if (!apply || editable === writableNow) return
    writableNow = editable
    apply(editable)
  })
</script>

<!-- No height, no overflow: the editor is as tall as its content and the page scrolls. -->
<div bind:this={host} class="cm-cell text-ink">
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
      aria-label="Cell editor, loading"
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
  .cm-cell :global(.cm-scroller) {
    overflow-y: hidden;
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
