<!--
  A source editor for contests: the participant's solution (K1, K5) and the
  teacher's reference solution and checker (A3).

  CodeMirror with the cell's colours, a line-number gutter and the language's
  grammar — Python from the room's chunk, C and C++ from a chunk of their own
  (vite.config.ts), so a room never downloads a grammar it has no use for.
  Not FileEditor: that one is bound to the room's shared document and its
  session, and a contest page has neither.

  Until the chunk lands (or if it never does, on a cut-off network) a plain
  monospace textarea stands in, the same height: a solution can always be
  typed and sent.

  ⌘↵ / Ctrl+↵ sends (`onsubmit`); Tab indents with spaces, as in a cell
  (lib/indent.ts).
-->
<script lang="ts" module>
  import type { EditorView as View } from '@codemirror/view'
  import type { ContestLanguage } from '@shared/contests'

  async function importKit() {
    const [state, view, commands, language, autocomplete, theme] = await Promise.all([
      import('@codemirror/state').then(({ Compartment, EditorSelection, EditorState, Prec }) => ({
        Compartment,
        EditorSelection,
        EditorState,
        Prec,
      })),
      import('@codemirror/view').then(
        ({ EditorView, highlightActiveLine, highlightActiveLineGutter, keymap, lineNumbers, placeholder }) => ({
          EditorView,
          highlightActiveLine,
          highlightActiveLineGutter,
          keymap,
          lineNumbers,
          placeholder,
        }),
      ),
      import('@codemirror/commands').then(({ defaultKeymap, history, historyKeymap, indentLess, indentMore }) => ({
        defaultKeymap,
        history,
        historyKeymap,
        indentLess,
        indentMore,
      })),
      import('@codemirror/language').then(({ bracketMatching, indentOnInput, indentUnit }) => ({
        bracketMatching,
        indentOnInput,
        indentUnit,
      })),
      import('@codemirror/autocomplete').then(({ closeBrackets, closeBracketsKeymap }) => ({
        closeBrackets,
        closeBracketsKeymap,
      })),
      import('./code-editor-theme').then(({ sourceTheme }) => ({ sourceTheme })),
    ])
    return { state, view, commands, language, autocomplete, theme }
  }

  type Kit = Awaited<ReturnType<typeof importKit>>
  let kitInFlight: Promise<Kit> | null = null
  function loadKit(): Promise<Kit> {
    const started = (kitInFlight ??= importKit())
    // A failed chunk is not cached: the next editor tries again.
    started.catch(() => {
      if (kitInFlight === started) kitInFlight = null
    })
    return started
  }

  /** The grammar of a language; C and C++ share one (lezer's cpp parses C well enough to colour it). */
  function grammarOf(language: ContestLanguage): Promise<unknown> {
    if (language === 'python3') return import('@codemirror/lang-python').then(({ python }) => python())
    return import('@codemirror/lang-cpp').then(({ cpp }) => cpp())
  }
</script>

<script lang="ts">
  import { onMount } from 'svelte'
  import { INDENT, tabKey } from '@/lib/indent'

  interface Props {
    /** The text the editor opens with; later replacements come through `load`. */
    initial: string
    language: ContestLanguage
    /** The field's accessible name. */
    label: string
    readonly?: boolean
    placeholder?: string
    /** Every edit, the whole text. */
    onchange?: (text: string) => void
    /** ⌘↵: send. */
    onsubmit?: () => void
    /** The editor's height; it scrolls inside. */
    height?: string
    /**
     * A line to scroll to and select, 1-based: «открыть код на строке 14»
     * under a compilation error (K2). Applied once the editor is up, and again
     * whenever it changes; null — leave the view where it is.
     */
    revealLine?: number | null
  }

  let {
    initial,
    language,
    label,
    readonly = false,
    placeholder = '',
    onchange,
    onsubmit,
    height = '392px',
    revealLine = null,
  }: Props = $props()

  let host = $state<HTMLDivElement | null>(null)
  let area = $state<HTMLTextAreaElement | null>(null)
  let plain = $state(true)
  let view: View | null = null
  let kit: Kit | null = null
  let grammarSlot: InstanceType<Kit['state']['Compartment']> | null = null
  let readonlySlot: InstanceType<Kit['state']['Compartment']> | null = null
  // svelte-ignore state_referenced_locally
  let text = initial

  function readonlyExtensions(loaded: Kit, locked: boolean) {
    return [loaded.state.EditorState.readOnly.of(locked), loaded.view.EditorView.editable.of(!locked)]
  }

  function stateFor(loaded: Kit, value: string, grammar: unknown) {
    const { EditorState, Prec, Compartment, EditorSelection } = loaded.state
    const { EditorView, keymap, lineNumbers, highlightActiveLine, highlightActiveLineGutter, placeholder: hint } = loaded.view
    const { defaultKeymap, history, historyKeymap, indentLess, indentMore } = loaded.commands
    grammarSlot = new Compartment()
    readonlySlot = new Compartment()
    return EditorState.create({
      doc: value,
      extensions: [
        lineNumbers(),
        highlightActiveLineGutter(),
        highlightActiveLine(),
        history(),
        loaded.language.bracketMatching(),
        loaded.autocomplete.closeBrackets(),
        loaded.language.indentOnInput(),
        loaded.language.indentUnit.of(INDENT),
        loaded.theme.sourceTheme,
        grammarSlot.of(grammar as never),
        readonlySlot.of(readonlyExtensions(loaded, readonly)),
        EditorView.contentAttributes.of({ 'aria-label': label, spellcheck: 'false', autocapitalize: 'off' }),
        placeholder ? hint(placeholder) : [],
        Prec.highest(
          keymap.of([
            {
              key: 'Mod-Enter',
              run: () => {
                onsubmit?.()
                return true
              },
            },
          ]),
        ),
        keymap.of([...loaded.autocomplete.closeBracketsKeymap, ...defaultKeymap, ...historyKeymap]),
        keymap.of([tabKey({ EditorSelection, indentMore, indentLess })]),
        EditorView.updateListener.of((update) => {
          if (!update.docChanged) return
          text = update.state.doc.toString()
          onchange?.(text)
        }),
      ],
    })
  }

  onMount(() => {
    let dropped = false
    if (area) area.value = text
    const mountedWith = language
    void Promise.all([loadKit(), grammarOf(mountedWith)])
      .then(([loaded, grammar]) => {
        if (dropped || !host || view) return
        const focused = area !== null && document.activeElement === area
        const from = area?.selectionStart ?? text.length
        const to = area?.selectionEnd ?? text.length
        kit = loaded
        view = new loaded.view.EditorView({ state: stateFor(loaded, text, grammar), parent: host })
        plain = false
        if (focused) {
          const end = view.state.doc.length
          view.dispatch({ selection: { anchor: Math.min(from, end), head: Math.min(to, end) } })
          view.focus()
        }
        reveal(revealLine)
        // The language changed while the chunk was on its way (the effect below
        // found no view to reconfigure): the grammar catches up now.
        if (shownLanguage !== mountedWith) {
          const wanted = shownLanguage
          void grammarOf(wanted).then((next) => {
            if (view && grammarSlot && shownLanguage === wanted) view.dispatch({ effects: grammarSlot.reconfigure(next as never) })
          })
        }
      })
      .catch(() => {
        /* the stand-in stays: a solution can be written without highlighting */
      })
    return () => {
      dropped = true
      view?.destroy()
      view = null
    }
  })

  /* Another language: the grammar is swapped in place, the text and the history stay. */
  // svelte-ignore state_referenced_locally
  let shownLanguage = language
  $effect(() => {
    const wanted = language
    if (wanted === shownLanguage) return
    shownLanguage = wanted
    void grammarOf(wanted).then((grammar) => {
      if (!view || !grammarSlot || shownLanguage !== wanted) return
      view.dispatch({ effects: grammarSlot.reconfigure(grammar as never) })
    })
  })

  $effect(() => {
    const locked = readonly
    if (!view || !kit || !readonlySlot) return
    view.dispatch({ effects: readonlySlot.reconfigure(readonlyExtensions(kit, locked)) })
  })

  /* The line asked for: selected and brought to the middle of the box. */
  function reveal(line: number | null): void {
    if (!view || !kit || line === null || !Number.isFinite(line)) return
    const doc = view.state.doc
    const target = doc.line(Math.min(Math.max(1, Math.floor(line)), doc.lines))
    view.dispatch({
      selection: { anchor: target.from, head: target.to },
      effects: kit.view.EditorView.scrollIntoView(target.from, { y: 'center' }),
    })
  }

  $effect(() => {
    reveal(revealLine)
  })

  /** Put a new text in: another problem, another language's draft, a file dropped in. */
  export function load(value: string): void {
    text = value
    if (area) area.value = value
    if (!view) return
    if (view.state.doc.toString() === value) return
    view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: value }, selection: { anchor: 0 } })
  }

  export function focus(): void {
    if (view) view.focus()
    else area?.focus()
  }

  /** The text as it is now — what «Отправить» sends. */
  export function current(): string {
    return view ? view.state.doc.toString() : (area?.value ?? text)
  }

  function typed(event: Event): void {
    text = (event.currentTarget as HTMLTextAreaElement).value
    onchange?.(text)
  }

  function plainKeys(event: KeyboardEvent): void {
    if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
      event.preventDefault()
      onsubmit?.()
    }
  }
</script>

<!-- The border takes the accent while the editor has the focus: CodeMirror's own outline is turned off by the cell theme, and a keyboard user must see where the keys go. -->
<div class="contest-code relative border border-line bg-canvas focus-within:border-accent" style:height>
  <div bind:this={host} class="h-full" class:hidden={plain}></div>
  {#if plain}
    <textarea
      bind:this={area}
      class="h-full w-full resize-none bg-transparent p-3 font-mono text-code leading-6 text-ink outline-none"
      aria-label={label}
      {placeholder}
      readonly={readonly}
      spellcheck="false"
      autocapitalize="off"
      oninput={typed}
      onkeydown={plainKeys}
    ></textarea>
  {/if}
</div>
