<!--
  The field a speaker note is written in: CodeMirror with markdown, set as
  prose.

  Not a textarea, and the reason is the owner's complaint about the old one:
  the box started two lines tall and measured itself before its text arrived,
  so a thirty-line note opened in a 50 px slot. Here the field IS the column:
  it fills the height it is given from the first frame and scrolls inside it,
  so there is nothing to measure and nothing to get wrong. And the markup is
  visible as what it does: `**` fades back, the bold is bold, a list marker
  and a quote bar are in the accent colour, an "if asked" paragraph carries
  the accent line down its side, as the console will fold it.

  CodeMirror comes as a separate chunk, as everywhere in the product. Until it
  lands (or if it never does, on a cut-off network) a plain textarea stands in
  that fills the same height: a note can always be written.
-->
<script lang="ts" module>
  import type { EditorView as View } from '@codemirror/view'
  import type { Extension } from '@codemirror/state'
  import { askOf } from './notes-script'

  async function importKit() {
    const [state, view, commands, language, md, highlight] = await Promise.all([
      import('@codemirror/state').then(
        ({ EditorSelection, EditorState, Prec, RangeSetBuilder }) => ({
          EditorSelection,
          EditorState,
          Prec,
          RangeSetBuilder,
        }),
      ),
      import('@codemirror/view').then(
        ({ Decoration, EditorView, ViewPlugin, keymap, placeholder }) => ({
          Decoration,
          EditorView,
          ViewPlugin,
          keymap,
          placeholder,
        }),
      ),
      import('@codemirror/commands').then(({ defaultKeymap, history, historyKeymap }) => ({
        defaultKeymap,
        history,
        historyKeymap,
      })),
      import('@codemirror/language').then(({ HighlightStyle, syntaxHighlighting, syntaxTree }) => ({
        HighlightStyle,
        syntaxHighlighting,
        syntaxTree,
      })),
      import('@codemirror/lang-markdown').then(({ markdown, markdownLanguage }) => ({
        markdown,
        markdownLanguage,
      })),
      import('@lezer/highlight').then(({ tags }) => ({ tags })),
    ])
    return { state, view, commands, language, md, highlight }
  }

  type Kit = Awaited<ReturnType<typeof importKit>>
  let kitInFlight: Promise<Kit> | null = null
  /* A failure is not cached: the next opening tries again (see render.svelte.ts). */
  function loadKit(): Promise<Kit> {
    return (kitInFlight ??= importKit().catch((err: unknown) => {
      kitInFlight = null
      throw err
    }))
  }

  /*
   * The prose look. Sizes are the design's: 17/28 is a page of a talk read at
   * a desk, larger than the working 13 and smaller than the console's 22,
   * which is read standing. The measure is held at 680 px: wider, a line no
   * longer comes back to the eye in one sweep.
   */
  function proseTheme(kit: Kit): Extension {
    const { EditorView } = kit.view
    return EditorView.theme({
      // `!important` against the global `.cm-editor` rule (index.css), which
      // sets the code font for every editor in the product: this one is prose.
      // The size needs it as much as the family: CodeMirror puts its own
      // styles FIRST in <head>, so at equal specificity the global 14 px won
      // and the field typed at 14 while the design and the preview said 17.
      '&': {
        height: '100%',
        fontFamily: 'inherit !important',
        fontSize: '17px !important',
        lineHeight: '28px !important',
      },
      '.cm-scroller': { fontFamily: 'inherit !important', lineHeight: '28px', overflowX: 'hidden' },
      '.cm-content': {
        maxWidth: '680px',
        padding: '20px 16px 40vh 16px',
        caretColor: 'rgb(var(--accent))',
      },
      '.cm-line': { padding: '0' },
      // The caret is the accent, two pixels: the first thing a person does
      // after clicking into a note is look for where they landed.
      '.cm-cursor, .cm-dropCursor': {
        borderLeftColor: 'rgb(var(--accent)) !important',
        borderLeftWidth: '2px',
      },
      '.cm-activeLine': { backgroundColor: 'transparent !important' },
      '.cm-placeholder': { color: 'rgb(var(--muted))', fontStyle: 'italic' },
      // Markup that does nothing on its own (the stars, the hashes) steps
      // back, a shade lighter than faint text: present, never read.
      '.cm-n-mark': { color: 'rgb(var(--faint) / 0.65)' },
      '.cm-n-lead': { color: 'rgb(var(--accent-text))' },
      '.cm-n-ask': {
        boxShadow: 'inset 2px 0 0 rgb(var(--accent))',
        // The bar sits 16 px out and the text stays on the paragraphs' left edge.
        paddingLeft: '16px !important',
        marginLeft: '-16px',
      },
      '.cm-n-ask-label, .cm-n-ask-label *': { color: 'rgb(var(--accent-text)) !important' },
      '.cm-n-gap': { lineHeight: '14px' },
    })
  }

  function proseHighlight(kit: Kit): Extension {
    const { HighlightStyle, syntaxHighlighting } = kit.language
    const t = kit.highlight.tags
    return syntaxHighlighting(
      HighlightStyle.define([
        { tag: t.emphasis, fontStyle: 'italic', color: 'rgb(var(--muted))' },
        { tag: t.strong, fontWeight: '700', color: 'rgb(var(--ink))' },
        { tag: t.quote, color: 'rgb(var(--muted))' },
        { tag: t.processingInstruction, class: 'cm-n-mark' },
        { tag: [t.heading1, t.heading2, t.heading3, t.heading4], fontWeight: '700' },
        { tag: t.monospace, fontFamily: 'var(--font-mono)', fontSize: '15px' },
        { tag: [t.link, t.url], color: 'rgb(var(--accent-text))' },
        { tag: t.strikethrough, textDecoration: 'line-through' },
      ]),
    )
  }

  /*
   * What a highlight style cannot say: lezer gives list markers, quote bars
   * and emphasis stars the same tag, and only the first two are signals
   * (accent), while the stars must fade. And an "if asked" paragraph is a
   * convention of ours, not of markdown, so the tree does not know it: its
   * lines get the accent line here, by the same rule the console folds by
   * (./notes-script.ts · askOf), so what is marked here is what folds there.
   */
  function dialect(kit: Kit): Extension {
    const { Decoration, ViewPlugin } = kit.view
    const { RangeSetBuilder } = kit.state
    const lead = Decoration.mark({ class: 'cm-n-lead' })
    const label = Decoration.mark({ class: 'cm-n-ask-label' })
    const askLine = Decoration.line({ class: 'cm-n-ask' })
    const gapLine = Decoration.line({ class: 'cm-n-gap' })
    const build = (view: View) => {
      const marks: { from: number; to: number; deco: typeof lead }[] = []
      const lines = new Set<number>()
      /*
       * The empty line between paragraphs is a half line, as in the design:
       * a full 28 px row of nothing after every paragraph spread a note to
       * twice its height and pushed the text under the fold. Not the line
       * the caret stands on: a blank line being typed into keeps a full-size
       * caret and does not jump when the first letter lands.
       */
      const caretLine = view.state.doc.lineAt(view.state.selection.main.head).number
      const gaps: number[] = []
      for (const { from, to } of view.visibleRanges) {
        for (let at = view.state.doc.lineAt(from).number; ; at += 1) {
          const line = view.state.doc.line(at)
          if (at !== caretLine && line.length === 0) gaps.push(line.from)
          if (line.to >= to || at >= view.state.doc.lines) break
        }
      }
      for (const { from, to } of view.visibleRanges) {
        kit.language.syntaxTree(view.state).iterate({
          from,
          to,
          enter(node) {
            if (node.name === 'ListMark' || node.name === 'QuoteMark') {
              marks.push({ from: node.from, to: node.to, deco: lead })
            } else if (node.name === 'Paragraph') {
              const first = view.state.doc.lineAt(node.from)
              if (!askOf(view.state.doc.sliceString(node.from, first.to))) return
              const last = view.state.doc.lineAt(node.to)
              for (let at = first.number; at <= last.number; at += 1) lines.add(at)
              const strong = node.node.getChild('StrongEmphasis')
              if (strong && strong.from === node.from) {
                marks.push({ from: strong.from, to: strong.to, deco: label })
              }
            }
          },
        })
      }
      const builder = new RangeSetBuilder<typeof lead>()
      const all = [
        ...[...lines].map((number) => {
          const at = view.state.doc.line(number).from
          return { from: at, to: at, deco: askLine as typeof lead }
        }),
        ...gaps.map((at) => ({ from: at, to: at, deco: gapLine as typeof lead })),
        ...marks,
      ].sort((a, b) => a.from - b.from || a.to - b.to)
      for (const one of all) builder.add(one.from, one.to, one.deco)
      return builder.finish()
    }
    return ViewPlugin.fromClass(
      class {
        decorations: ReturnType<typeof build>
        constructor(view: View) {
          this.decorations = build(view)
        }
        update(update: {
          docChanged: boolean
          viewportChanged: boolean
          selectionSet: boolean
          view: View
        }) {
          if (update.docChanged || update.viewportChanged || update.selectionSet) {
            this.decorations = build(update.view)
          }
        }
      },
      { decorations: (plugin) => plugin.decorations },
    )
  }
</script>

<script lang="ts">
  import { onMount } from 'svelte'

  interface Props {
    /** The text the field opens with; later changes come through `load`. */
    initial: string
    placeholder: string
    label: string
    /** Every edit, the whole text. */
    onedit: (text: string) => void
    onfocus?: () => void
    onblur?: () => void
    /** ⌘↑ / ⌘↓: the neighbouring slide. Taken before CodeMirror's "to the top". */
    onneighbour?: (step: -1 | 1) => void
    /** Esc: close the editor. */
    onescape?: () => void
    /**
     * This tab leads a lecture: PageUp/PageDown are the clicker's, and the
     * field leaves them to the lecture (LectureView turns the slide) instead
     * of moving the caret a screen.
     */
    clicker?: boolean
  }

  let {
    initial,
    placeholder,
    label,
    onedit,
    onfocus,
    onblur,
    onneighbour,
    onescape,
    clicker = false,
  }: Props = $props()

  let host = $state<HTMLDivElement | null>(null)
  let view: View | null = null
  let kit: Kit | null = null
  /** No CodeMirror (yet, or at all): the textarea stands in. */
  let plain = $state(true)
  let area = $state<HTMLTextAreaElement | null>(null)
  // svelte-ignore state_referenced_locally
  let text = initial

  /*
   * Blur is reported a microtask later. The browser fires it synchronously
   * when the focused field is REMOVED, and removal happens while Svelte is
   * tearing the editor down inside a template update, where writing state is
   * forbidden (state_unsafe_mutation): closing the editor with the caret in
   * the note threw. A microtask later the teardown is over, and the parent's
   * "left the field: send now" still runs.
   */
  function left(): void {
    queueMicrotask(() => onblur?.())
  }

  /** A key binding that did its job: CodeMirror stops looking for another. */
  function taken(job: () => void): boolean {
    job()
    return true
  }

  function stateFor(value: string) {
    if (!kit) throw new Error('no kit')
    const { EditorState, Prec } = kit.state
    const { EditorView, keymap, placeholder: hint } = kit.view
    const { defaultKeymap, history, historyKeymap } = kit.commands
    return EditorState.create({
      doc: value,
      extensions: [
        history(),
        Prec.highest(
          keymap.of([
            { key: 'Mod-ArrowUp', run: () => taken(() => onneighbour?.(-1)) },
            { key: 'Mod-ArrowDown', run: () => taken(() => onneighbour?.(1)) },
            { key: 'Escape', run: () => taken(() => onescape?.()) },
            { key: 'Mod-b', run: () => taken(() => wrap('**')) },
            { key: 'Mod-i', run: () => taken(() => wrap('*')) },
            { key: 'PageUp', run: () => clicker },
            { key: 'PageDown', run: () => clicker },
          ]),
        ),
        keymap.of([...defaultKeymap, ...historyKeymap]),
        kit.md.markdown({ base: kit.md.markdownLanguage }),
        proseHighlight(kit),
        dialect(kit),
        proseTheme(kit),
        EditorView.lineWrapping,
        EditorView.contentAttributes.of({ 'aria-label': label, 'data-notes': '' }),
        hint(placeholder),
        EditorView.updateListener.of((update) => {
          if (!update.docChanged) return
          text = update.state.doc.toString()
          onedit(text)
        }),
        EditorView.domEventHandlers({
          focus: () => onfocus?.(),
          blur: () => left(),
        }),
      ],
    })
  }

  onMount(() => {
    let dropped = false
    // Set once here, not through a `value=` attribute: a re-render with a new
    // prop would put the old text back under the person's fingers.
    if (area) area.value = text
    void loadKit()
      .then((loaded) => {
        if (dropped || !host) return
        /*
         * The swap carries the caret over: the editor focuses its field on
         * open, so the stand-in usually has focus by the time the chunk lands,
         * and the person may already be typing. The text is the stand-in's
         * latest (`text`), and the selection goes with it.
         */
        if (view) return
        const focused = area !== null && document.activeElement === area
        const from = area?.selectionStart ?? text.length
        const to = area?.selectionEnd ?? text.length
        kit = loaded
        view = new loaded.view.EditorView({ state: stateFor(text), parent: host })
        plain = false
        if (focused) {
          const end = view.state.doc.length
          view.dispatch({ selection: { anchor: Math.min(from, end), head: Math.min(to, end) } })
          view.focus()
        }
      })
      .catch(() => {
        /* the stand-in stays: a note can be written without highlighting */
      })
    return () => {
      dropped = true
      view?.destroy()
      view = null
    }
  })

  /**
   * Put new text in: another slide, or another device's edit to this one.
   *
   * A fresh state for a new slide, so undo does not walk back into the
   * previous slide's note; the same state with the text replaced for an edit
   * that came from elsewhere, keeping the caret where it can stay.
   */
  export function load(value: string, fresh: boolean): void {
    text = value
    if (area) area.value = value
    if (!view || !kit) return
    if (fresh) {
      view.setState(stateFor(value))
      return
    }
    if (view.state.doc.toString() === value) return
    const head = Math.min(view.state.selection.main.head, value.length)
    view.dispatch({
      changes: { from: 0, to: view.state.doc.length, insert: value },
      selection: { anchor: head },
    })
  }

  export function focus(): void {
    if (view) view.focus()
    else area?.focus()
  }

  /* ----------------------------------------------------------- toolbar */

  /** Bold, italic: wrap the selection, or open an empty pair at the caret. */
  export function wrap(mark: string): void {
    if (!view || !kit) return plainWrap(mark)
    const { EditorSelection } = kit.state
    const state = view.state
    view.dispatch(
      state.changeByRange((range) => {
        const inner = state.sliceDoc(range.from, range.to)
        const before = state.sliceDoc(range.from - mark.length, range.from)
        const after = state.sliceDoc(range.to, range.to + mark.length)
        // Pressing B on bold text takes the bold off: a toggle, not a pile of stars.
        if (before === mark && after === mark) {
          return {
            changes: [
              { from: range.from - mark.length, to: range.from },
              { from: range.to, to: range.to + mark.length },
            ],
            range: EditorSelection.range(range.from - mark.length, range.to - mark.length),
          }
        }
        return {
          changes: { from: range.from, to: range.to, insert: `${mark}${inner}${mark}` },
          range: EditorSelection.range(range.from + mark.length, range.to + mark.length),
        }
      }),
    )
    view.focus()
  }

  /**
   * List, quote, remark: a whole-line form. Applied to every line the
   * selection touches; pressed again, taken off.
   */
  export function lineForm(kind: 'list' | 'quote' | 'remark'): void {
    if (!view || !kit) return plainLineForm(kind)
    const state = view.state
    const lines = new Map<number, { from: number; text: string }>()
    for (const range of state.selection.ranges) {
      const last = state.doc.lineAt(range.to).number
      for (let at = state.doc.lineAt(range.from).number; at <= last; at += 1) {
        const line = state.doc.line(at)
        lines.set(at, { from: line.from, text: line.text })
      }
    }
    const all = [...lines.values()]
    const changes = formChanges(all, kind)
    view.dispatch({ changes })
    view.focus()
  }

  /** "If asked": a new paragraph that opens with the label, caret after it. */
  export function ask(labelText: string): void {
    const opener = `**${labelText}:** `
    if (!view || !kit) return plainAsk(opener)
    const state = view.state
    const line = state.doc.lineAt(state.selection.main.head)
    const blank = line.text.trim() === ''
    // On an empty line it starts right there; otherwise after the paragraph,
    // with the blank line that makes it a paragraph of its own.
    const at = blank ? line.from : line.to
    const insert = blank ? opener : `\n\n${opener}`
    view.dispatch({
      changes: { from: at, to: blank ? line.to : at, insert },
      selection: { anchor: at + insert.length },
    })
    view.focus()
  }

  function formChanges(
    lines: { from: number; text: string }[],
    kind: 'list' | 'quote' | 'remark',
  ): { from: number; to: number; insert: string }[] {
    const prefix = kind === 'list' ? '- ' : '> '
    const has = (line: string) =>
      kind === 'remark'
        ? /^\*(?!\*).*[^*]\*$/.test(line.trim())
        : line.startsWith(prefix)
    const content = lines.filter((line) => line.text.trim() !== '')
    const removing = content.length > 0 && content.every((line) => has(line.text))
    return content.map((line) => {
      const end = line.from + line.text.length
      if (kind === 'remark') {
        const inner = line.text.trim()
        const next = removing ? inner.slice(1, -1) : `*${inner.replace(/^\*+|\*+$/g, '')}*`
        return { from: line.from, to: end, insert: next }
      }
      return removing
        ? { from: line.from, to: line.from + prefix.length, insert: '' }
        : { from: line.from, to: line.from, insert: prefix }
    })
  }

  /* The same three forms on the stand-in textarea. */
  function applyPlain(next: string, caret: number): void {
    if (!area) return
    area.value = next
    area.setSelectionRange(caret, caret)
    text = next
    onedit(next)
    area.focus()
  }

  function plainWrap(mark: string): void {
    if (!area) return
    const { selectionStart: from, selectionEnd: to, value } = area
    const wrapped = `${value.slice(0, from)}${mark}${value.slice(from, to)}${mark}${value.slice(to)}`
    applyPlain(wrapped, to + mark.length)
  }

  function plainLineForm(kind: 'list' | 'quote' | 'remark'): void {
    if (!area) return
    const value = area.value
    const start = value.lastIndexOf('\n', area.selectionStart - 1) + 1
    const stop = value.indexOf('\n', area.selectionEnd)
    const end = stop < 0 ? value.length : stop
    const lines: { from: number; text: string }[] = []
    let at = start
    for (const piece of value.slice(start, end).split('\n')) {
      lines.push({ from: at, text: piece })
      at += piece.length + 1
    }
    let next = value
    for (const change of formChanges(lines, kind).reverse()) {
      next = next.slice(0, change.from) + change.insert + next.slice(change.to)
    }
    applyPlain(next, Math.min(next.length, end + (next.length - value.length)))
  }

  function plainAsk(opener: string): void {
    if (!area) return
    const value = area.value
    const stop = value.indexOf('\n', area.selectionEnd)
    const end = stop < 0 ? value.length : stop
    const insert = value.trim() ? `\n\n${opener}` : opener
    applyPlain(value.slice(0, end) + insert + value.slice(end), end + insert.length)
  }

  function plainKeys(event: KeyboardEvent): void {
    const mod = event.metaKey || event.ctrlKey
    if (mod && (event.key === 'ArrowUp' || event.key === 'ArrowDown')) {
      event.preventDefault()
      onneighbour?.(event.key === 'ArrowUp' ? -1 : 1)
    } else if (event.key === 'Escape') {
      event.preventDefault()
      onescape?.()
    } else if (mod && (event.key === 'b' || event.key === 'i')) {
      event.preventDefault()
      plainWrap(event.key === 'b' ? '**' : '*')
    }
  }
</script>

<!--
  The box fills its parent and scrolls inside: the parent hands it the whole
  height under the toolbar, and that is the size of the field from the first
  frame. `data-notes` marks it for the lecture's keyboard: a clicker's
  PageDown turns the slide even while the caret is in here (LectureView).
-->
<div class="relative min-h-0 flex-1 overflow-hidden" data-notes>
  <div bind:this={host} class="absolute inset-0 {plain ? 'hidden' : ''}"></div>
  {#if plain}
    <textarea
      bind:this={area}
      class="pult-caret absolute inset-0 h-full w-full max-w-[712px] resize-none overflow-y-auto
             bg-transparent px-4 pb-[40vh] pt-5 text-[17px] leading-[28px] text-ink
             placeholder:italic placeholder:text-muted focus-visible:outline-none"
      aria-label={label}
      {placeholder}
      oninput={(event) => {
        text = event.currentTarget.value
        onedit(text)
      }}
      onkeydown={plainKeys}
      onfocus={() => onfocus?.()}
      onblur={left}
    ></textarea>
  {/if}
</div>

<style>
  .pult-caret {
    caret-color: rgb(var(--accent));
  }
</style>
