<!--
  THE SPEAKER-NOTES EDITOR: the whole surface, for writing a talk.

  The talk used to have one place to be written: a 28 % column of the
  presenter's laptop window, under a "next" thumbnail, only while a lecture
  was running (so only after putting the PDF on everyone's screen), only for
  whoever held the lecture, and only on a window wider than 1024 px. Its box
  opened two lines tall. A second browser of the same teacher had no editor
  at all. This is the place instead: opened by any host from the PDF in the
  room, before the lecture or during it, whoever leads.

  Three columns, the way a talk is prepared (Paper, page 10 · N3):

   · the slides, with the first line of each note and its state (written,
     empty, close to the ceiling), filterable to "no notes" for the last
     pass the evening before;
   · the slide large, how long the note takes to say, its neighbours, and
     the field: tall from the first frame, markdown with a toolbar for the
     four things a talk needs (bold, a remark, a list, "if asked");
   · the note exactly as the console will show it, at the console's sizes.

  Saving follows the old field's rules, which were right (see NotesPad):
  the whole text, by itself, 400 ms after typing stops, ALWAYS before a slide
  change, on close and when the tab goes to the background; and what comes
  from another device never moves the text under the caret. What is new is
  the ceiling: a note longer than the server takes is kept on screen, marked
  and NOT sent, instead of being cut. The old field cut the tail off on the
  first keystroke, so a note imported a little too long lost its end the
  moment someone fixed a typo in it.
-->
<script lang="ts">
  import { formatDate, formatNumber, tr } from '@shared/i18n'
  import { MAX_NOTE_CHARS } from '@shared/lecture'
  import { baseOf } from '@shared/paths'
  import {
    buildScript,
    countWords,
    speakingMinutes,
    WORDS_PER_MINUTE,
  } from '@shared/speaker-notes'
  import type { PDFDocumentProxy } from 'pdfjs-dist'
  import { onMount, tick, untrack } from 'svelte'
  import Icon from '@/components/ui/Icon.svelte'
  import { api } from '@/lib/api'
  import { loadPdf } from '@/lib/pdf.svelte'
  import { acquirePage, releasePage } from '@/lib/pdf-pages'
  import { getSessionState } from '@/lib/session.svelte'
  import LecturePage from './LecturePage.svelte'
  import NotesField from './NotesField.svelte'
  import NotesImport from './NotesImport.svelte'
  import NotesReader from './NotesReader.svelte'
  import { firstLine, readNote } from './notes-script'
  import { slideTitle } from './slide-titles'

  interface Props {
    /** The document the notes belong to. */
    file: string
    /** The page to open on. */
    page: number
    onclose: () => void
  }

  let { file, page: startPage, onclose }: Props = $props()

  const session = getSessionState()
  const host = $derived(session.me.role === 'host')

  /*
   * A ceiling a note may reach, and the line from which the counter warns.
   * 150 characters before the end is about two lines at the console's size:
   * the moment a sentence can still be finished shorter rather than cut.
   */
  const MAX = MAX_NOTE_CHARS
  const WARN = MAX - 150
  /* The old field's timings, and their reasons, are in NotesPad. */
  const SAVE_AFTER_MS = 400
  const ECHO_MS = 1500

  /* ---------------------------------------------------------- the notes */

  /*
   * Held, not opened: the room's lecture column may have another document's
   * notes open under this surface, and closing the editor gives them back.
   */
  $effect(() => session.holdNotes(file))
  const arrived = $derived(session.notesFile === file)
  const notes = $derived<Record<number, string>>(arrived ? session.notes : {})

  /* The editor is the teacher's: a role taken away mid-edit closes it. */
  $effect(() => {
    if (!host) untrack(() => onclose())
  })

  /* ------------------------------------------------------- the document */

  let doc = $state.raw<PDFDocumentProxy | null>(null)
  let docFailed = $state(false)
  let aspect = $state('16 / 9')
  const pages = $derived(doc?.numPages ?? 0)

  onMount(() => {
    let cancelled = false
    let opened: PDFDocumentProxy | null = null
    void loadPdf()
      .then((pdf) => pdf.open(api.fileRaw(session.session.id, file), session.token))
      .then(async (ready) => {
        opened = ready
        if (cancelled) return
        const first = await acquirePage(ready, 1)
        if (first) {
          const view = first.getViewport({ scale: 1 })
          aspect = `${Math.round(view.width)} / ${Math.round(view.height)}`
          releasePage(ready, 1)
        }
        if (!cancelled) doc = ready
      })
      .catch(() => {
        if (!cancelled) docFailed = true
      })
    return () => {
      cancelled = true
      void opened?.loadingTask.destroy()
    }
  })

  /*
   * How many slides the list shows. The document says; if it did not open,
   * the notes still can be written, for the pages they exist on and the one
   * that was asked for.
   */
  const count = $derived.by(() => {
    if (pages > 0) return pages
    const known = Object.keys(notes).map(Number)
    return Math.max(startPage, page, ...known, 1)
  })

  /* ----------------------------------------------------- the open slide */

  // svelte-ignore state_referenced_locally
  let page = $state(Math.max(1, startPage))
  const stored = $derived(notes[page] ?? '')

  /** The field's text right now: the current slide's note as it is being typed. */
  let draft = $state('')
  let typing = $state(false)
  /** The field is mounted once the notes have arrived, with the right text in it. */
  let ready = $state(false)
  let field = $state<NotesField | null>(null)

  /*
   * Mirrors read by the flush, outside any reactive context (a cleanup, the
   * tab going away), holding the page the text belongs to, not the page open
   * now. The same arrangement as NotesPad, and for the same reason: a
   * sentence typed a second before a slide change must land on its slide.
   */
  let held = ''
  // svelte-ignore state_referenced_locally
  let heldPage = page
  let pending = false
  /*
   * Typed into on this slide since it was opened. Until then the field
   * takes another device's text even with the caret in it: the editor
   * focuses the field on open, and the laptop column's last sentence, sent
   * the moment the editor was asked for, arrives a round trip later.
   */
  let touched = false
  let sentAt = Number.NEGATIVE_INFINITY
  let timer: number | undefined

  /*
   * Drafts the server would refuse: longer than the ceiling. Kept here, per
   * slide, until shortened: they are not sent, and turning to another slide
   * must not throw them away either. `overPages` is the reactive list of
   * them, for the slide list and for the question on closing.
   */
  const unsaved = new Map<number, string>()
  let overPages = $state<number[]>([])
  function syncOver(): void {
    overPages = [...unsaved.keys()].sort((a, b) => a - b)
  }

  /** The last edit sent, until its echo comes back from the server. */
  let awaiting = $state<{ page: number; text: string } | null>(null)
  /*
   * Typed and not sent yet (the 400 ms pause): the reactive twin of
   * `pending`, for the status line, which must not keep saying "Saved"
   * about text that has not left.
   */
  let dirty = $state(false)
  let savedAt = $state<number | null>(null)

  $effect(() => {
    if (!arrived || ready) return
    untrack(() => {
      const text = notes[page] ?? ''
      draft = text
      held = text
      heldPage = page
      ready = true
    })
  })

  /* The edit is saved when the server's echo says the same text. */
  $effect(() => {
    const wait = awaiting
    if (!wait) return
    if ((notes[wait.page] ?? '') === wait.text) {
      savedAt = Date.now()
      awaiting = null
    }
  })

  /*
   * Another device edited the open slide: taken only while nobody types
   * here, nothing is waiting to go out and our own echo window is over.
   *
   * Nor while this slide's own edit is still unanswered. Offline, the edit
   * sits in the outbox with no echo coming; the blur that follows re-ran
   * this and put the server's OLD text back into the field, and the next
   * keystroke on that old text replaced the queued edit (the outbox keeps
   * one save per slide), so what was typed offline was gone for good.
   */
  $effect(() => {
    const fresh = stored
    if (!ready || pending || (typing && touched)) return
    if (awaiting && awaiting.page === page) return
    if (performance.now() - sentAt < ECHO_MS) return
    untrack(() => {
      if (unsaved.has(page)) return
      if (fresh === held.trim()) return
      held = fresh
      draft = fresh
      field?.load(fresh, false)
    })
  })

  function commit(): void {
    if (timer !== undefined) {
      window.clearTimeout(timer)
      timer = undefined
    }
    if (!pending) return
    pending = false
    dirty = false
    // The same text the server stores, so its echo can be recognised.
    const text = held.trim()
    if (text.length > MAX) {
      unsaved.set(heldPage, held)
      syncOver()
      return
    }
    if (unsaved.delete(heldPage)) syncOver()
    sentAt = performance.now()
    awaiting = { page: heldPage, text }
    session.send({ t: 'notes:set', file, page: heldPage, text })
  }

  function onedit(text: string): void {
    draft = text
    held = text
    pending = true
    dirty = true
    touched = true
    if (timer !== undefined) window.clearTimeout(timer)
    timer = undefined
    if (text.trim().length > MAX) {
      // Over the ceiling: kept, marked, not sent. Never cut.
      unsaved.set(page, text)
      syncOver()
      pending = false
      dirty = false
      return
    }
    if (unsaved.delete(page)) syncOver()
    timer = window.setTimeout(commit, SAVE_AFTER_MS)
  }

  /** Open another slide: the current one's text goes out first. */
  function go(next: number): void {
    const target = Math.min(Math.max(1, Math.round(next)), count)
    if (target === page) return
    commit()
    page = target
    touched = false
    const text = unsaved.get(target) ?? notes[target] ?? ''
    held = text
    heldPage = target
    draft = text
    field?.load(text, true)
    closeAsked = false
    void tick().then(() => {
      list?.querySelector(`[data-slide="${target}"]`)?.scrollIntoView({ block: 'nearest' })
    })
  }

  /* Whatever was typed goes out when the tab goes to the background. */
  $effect(() => {
    const hide = () => {
      if (document.visibilityState === 'hidden') commit()
    }
    document.addEventListener('visibilitychange', hide)
    window.addEventListener('pagehide', commit)
    return () => {
      document.removeEventListener('visibilitychange', hide)
      window.removeEventListener('pagehide', commit)
      commit()
    }
  })

  /* ---------------------------------------------------------- closing */

  let closeAsked = $state(false)

  /*
   * A draft over the ceiling has not been saved anywhere, and closing would
   * lose it: the close asks once, the way "End" asks in the lecture bar.
   */
  function close(): void {
    commit()
    if (overPages.length > 0 && !closeAsked) {
      closeAsked = true
      return
    }
    onclose()
  }

  let importOpen = $state(false)

  /*
   * The editor's keys are taken in the CAPTURE phase on the window, before
   * anything else in the room hears them: Esc must close this surface and
   * not, say, the room's side panel under it, and ⌘↑ must turn the slide
   * rather than move the caret to the top of the note.
   */
  function onkey(event: KeyboardEvent): void {
    if (event.key === 'Escape') {
      event.preventDefault()
      event.stopPropagation()
      if (importOpen) importOpen = false
      else close()
      return
    }
    if (importOpen) return
    const mod = event.metaKey || event.ctrlKey
    if (mod && !event.altKey && (event.key === 'ArrowUp' || event.key === 'ArrowDown')) {
      event.preventDefault()
      event.stopPropagation()
      go(page + (event.key === 'ArrowUp' ? -1 : 1))
    }
  }

  $effect(() => {
    window.addEventListener('keydown', onkey, true)
    return () => window.removeEventListener('keydown', onkey, true)
  })

  /* The field takes the caret when it appears: the editor is opened to write. */
  $effect(() => {
    if (ready && field) untrack(() => field?.focus())
  })

  /* ------------------------------------------------------- the slide list */

  let filter = $state<'all' | 'empty'>('all')
  let list = $state<HTMLElement | null>(null)

  /** The note of a slide as the list shows it: the live draft for the open one. */
  function noteOf(at: number): string {
    if (at === page) return draft
    return unsaved.get(at) ?? notes[at] ?? ''
  }

  const slides = $derived(Array.from({ length: count }, (_, index) => index + 1))
  const filled = $derived(slides.filter((at) => noteOf(at).trim() !== '').length)
  const meta = $derived(
    [
      baseOf(file),
      pages > 0 ? tr('room.notesEditor.slides', { count: pages }) : '',
      pages > 0 ? tr('room.notesEditor.filled', { count: filled }) : '',
    ]
      .filter(Boolean)
      .join(' · '),
  )
  const filters = $derived([
    ['all', tr('room.notesEditor.all', { count })],
    ['empty', tr('room.notesEditor.empty', { count: count - filled })],
  ])
  const tabs = $derived([
    ['text', tr('room.notesEditor.tabText')],
    ['preview', tr('room.notesEditor.tabPreview')],
  ])
  const shown = $derived(
    filter === 'all' ? slides : slides.filter((at) => noteOf(at).trim() === ''),
  )

  /*
   * Thumbnails are drawn as the list scrolls to them, from the shared page
   * cache (lib/pdf-pages.ts): a deck of a hundred photos drawn at once is
   * the memory that reloads an iPad tab.
   */
  const THUMB_W = 120

  async function paint(node: HTMLCanvasElement, index: number): Promise<void> {
    const source = doc
    if (!source) return
    const sheet = await acquirePage(source, index)
    if (!sheet) return
    try {
      const base = sheet.getViewport({ scale: 1 })
      const ratio = Math.min(window.devicePixelRatio || 1, 2)
      const viewport = sheet.getViewport({ scale: (THUMB_W / base.width) * ratio })
      node.width = Math.round(viewport.width)
      node.height = Math.round(viewport.height)
      const context = node.getContext('2d')
      if (!context) return
      await sheet.render({ canvas: node, canvasContext: context, viewport }).promise
    } catch {
      // A thumbnail that could not be drawn stays a blank card: the number
      // and the note beside it are what the list is for.
    } finally {
      releasePage(source, index)
    }
  }

  function thumb(node: HTMLCanvasElement, index: number) {
    const watcher = new IntersectionObserver(
      (entries) => {
        if (!entries.some((entry) => entry.isIntersecting)) return
        watcher.disconnect()
        void paint(node, index)
      },
      { root: node.closest('[data-notes-list]'), rootMargin: '400px 0px' },
    )
    watcher.observe(node)
    return {
      destroy() {
        watcher.disconnect()
      },
    }
  }

  /* -------------------------------------------------- the open slide's facts */

  const script = $derived(readNote(draft))
  const words = $derived(
    countWords(
      script.blocks
        .filter((block) => block.kind === 'text')
        .map((block) => (block.kind === 'text' ? block.source : ''))
        .join('\n\n'),
    ),
  )
  /*
   * The teacher's own timing, when the note has one, outranks the estimate.
   * Under a minute the estimate is in seconds: a two-line note read as
   * "≈ 0 min" looked like a note that takes no time at all.
   */
  const minutes = $derived.by(() => {
    if (script.timing) return script.timing.label
    const estimate = speakingMinutes(words)
    if (words > 0 && estimate < 1) {
      // To five seconds: the estimate is a glance, not a stopwatch.
      const seconds = Math.max(5, Math.round(((words / WORDS_PER_MINUTE) * 60) / 5) * 5)
      return tr('room.notesEditor.seconds', { seconds })
    }
    return tr('room.notesEditor.minutes', { minutes: formatNumber(estimate) })
  })

  /* Neighbours are named by the slide's title from the PDF, or the note's first line. */
  let titles = $state<Record<number, string>>({})
  $effect(() => {
    const source = doc
    if (!source) return
    for (const at of [page - 1, page + 1]) {
      if (at < 1 || at > source.numPages || at in untrack(() => titles)) continue
      void slideTitle(source, at).then((title) => {
        titles = { ...titles, [at]: title }
      })
    }
  })
  function nameOf(at: number): string {
    return titles[at] || firstLine(noteOf(at)) || tr('room.notesEditor.slideTitle', { page: at })
  }

  /* ------------------------------------------------------ the preview */

  /* The console's ladder and its key: one choice per device (ConsoleView). */
  const SIZES = [18, 22, 28] as const
  const SIZE_KEY = 'colloq.pult.notesSize'
  let step = $state(readStep())
  function readStep(): number {
    try {
      const value = Number.parseInt(localStorage.getItem(SIZE_KEY) ?? '1', 10)
      return Number.isInteger(value) && value >= 0 && value < SIZES.length ? value : 1
    } catch {
      return 1
    }
  }
  function setStep(next: number): void {
    step = next
    try {
      localStorage.setItem(SIZE_KEY, String(next))
    } catch {
      /* the size holds for this visit */
    }
  }

  /*
   * How many screens of the console the note takes: the reader's text height
   * over the console's notes column (380 × 637 px in landscape on an 11"
   * iPad, Paper N1). The preview column is that wide, give or take its
   * padding, so the line breaks are the console's.
   */
  const CONSOLE_COLUMN_H = 637
  let previewBox = $state<HTMLElement | null>(null)
  let screens = $state(0)
  $effect(() => {
    const box = previewBox
    void draft
    void step
    if (!box) return
    const measure = () => {
      const reader = box.querySelector('.pult-reader')
      if (reader) screens = reader.scrollHeight / CONSOLE_COLUMN_H
    }
    void tick().then(measure)
    const watch = new ResizeObserver(measure)
    const inner = box.querySelector('.pult-prose')
    if (inner) watch.observe(inner)
    return () => watch.disconnect()
  })

  /*
   * Narrower than 1280 px there is no room for three columns: the preview
   * becomes a tab next to the text instead of disappearing.
   */
  let wide = $state(true)
  let tab = $state<'text' | 'preview'>('text')
  $effect(() => {
    const query = window.matchMedia('(min-width: 1280px)')
    const update = () => (wide = query.matches)
    update()
    query.addEventListener('change', update)
    return () => query.removeEventListener('change', update)
  })

  /* ------------------------------------------------------ status line */

  const length = $derived(draft.trim().length)
  const over = $derived(length > MAX)
  const status = $derived.by(() => {
    if (over) return 'over'
    if ((awaiting || dirty) && !session.controlConnected) return 'offline'
    if (awaiting || dirty) return 'saving'
    if (savedAt !== null) return 'saved'
    return 'idle'
  })
  let notice = $state<string | null>(null)
  let noticeTimer: number | undefined
  $effect(() => () => window.clearTimeout(noticeTimer))

  const live = $derived(session.lecture !== null && session.lecture.file === file)
  /* This tab leads a lecture: the clicker's keys in the field belong to it. */
  const leading = $derived(session.lecture !== null && session.lecture.by === session.me.id)

  /* ------------------------------------------------------ export */

  let exporting = $state(false)

  /**
   * Download the notes as a script the import reads back. Slide titles come
   * from the PDF where it has them; a deck that answers slowly is not waited
   * for past a few seconds: the headings then carry numbers only.
   */
  async function download(): Promise<void> {
    if (exporting) return
    commit()
    exporting = true
    try {
      const named: Record<number, string> = {}
      const source = doc
      if (source) {
        const asks = slides.map((at) =>
          slideTitle(source, at).then((title) => {
            if (title) named[at] = title
          }),
        )
        await Promise.race([
          Promise.all(asks),
          new Promise((resolve) => window.setTimeout(resolve, 6000)),
        ])
      }
      const merged: Record<number, string> = { ...notes }
      for (const [at, text] of unsaved) merged[at] = text
      const text = buildScript({
        notes: merged,
        pages: count,
        titles: named,
        heading: baseOf(file),
      })
      const blob = new Blob([text], { type: 'text/markdown;charset=utf-8' })
      const url = URL.createObjectURL(blob)
      const anchor = document.createElement('a')
      anchor.href = url
      anchor.download = `${baseOf(file).replace(/\.pdf$/i, '')}.notes.md`
      document.body.appendChild(anchor)
      anchor.click()
      anchor.remove()
      window.setTimeout(() => URL.revokeObjectURL(url), 1000)
    } finally {
      exporting = false
    }
  }

  /*
   * The script went in. The open slide takes its new text at once, from what
   * was written rather than from the socket's echo: the echo may still be on
   * its way, and the field would otherwise go on showing the old note, ready
   * to be typed over and sent back on top of the import. Drafts the import
   * replaced are dropped with it.
   */
  function imported(written: Record<number, string>): void {
    importOpen = false
    let dropped = false
    for (const key of Object.keys(written)) dropped = unsaved.delete(Number(key)) || dropped
    if (dropped) syncOver()
    // The import wrote over that slide: an older edit's echo will never match it now.
    if (awaiting && written[awaiting.page] !== undefined) awaiting = null
    const text = written[page]
    if (text !== undefined) {
      if (timer !== undefined) window.clearTimeout(timer)
      timer = undefined
      pending = false
      dirty = false
      touched = false
      held = text
      heldPage = page
      draft = text
      field?.load(text, true)
    }
    notice = tr('room.notesEditor.imported', { count: Object.keys(written).length })
    window.clearTimeout(noticeTimer)
    noticeTimer = window.setTimeout(() => (notice = null), 6000)
  }

  /* ------------------------------------------------------ toolbar */

  /*
   * Toolbar buttons do not take focus: a press on "B" must wrap the words
   * selected in the field, and focus moving to the button first would drop
   * the selection.
   */
  function keep(event: MouseEvent): void {
    event.preventDefault()
  }

  const TAP =
    'transition-[color,background-color,border-color,transform] duration-press ease-out ' +
    'active:scale-[0.97] focus-visible:outline-none focus-visible:ring-2 ' +
    'focus-visible:ring-inset focus-visible:ring-accent/40'
  const TOOL = `${TAP} flex h-8 shrink-0 items-center text-ui text-ink hover:bg-surface`

  /*
   * The night palette for the preview card, on the card alone: the room is
   * light, the console is always dark, and the preview must show the
   * console's colours whatever theme the room is in. The values are the
   * night set from index.css (`:root[data-pult]`).
   */
  const NIGHT =
    '--canvas:6 12 28;--surface:10 19 48;--raised:14 27 61;--line:22 36 75;' +
    '--line-soft:16 25 58;--ink:230 231 232;--muted:155 166 190;--faint:94 107 133;' +
    '--accent-text:15 160 215;--warning:242 163 60;--danger:242 73 95;color-scheme:dark'
</script>

<div
  class="fixed inset-0 z-[80] flex flex-col bg-canvas text-ink"
  role="dialog"
  aria-modal="true"
  aria-labelledby="notes-editor-title"
>
  <!-- ============================================================ header -->
  <header
    class="flex h-[76px] shrink-0 items-center justify-between gap-6 border-b border-line pl-5 pr-4
           md:pr-7"
  >
    <div class="flex min-w-0 flex-col gap-1.5">
      <div class="flex min-w-0 items-baseline gap-3.5">
        <h2
          id="notes-editor-title"
          class="shrink-0 text-head font-black tracking-[-0.02em] text-ink"
        >
          {tr('room.notesEditor.title')}
        </h2>
        <span class="min-w-0 truncate font-mono text-2xs text-muted">{meta}</span>
      </div>
      <div class="flex min-w-0 items-center gap-2">
        <span
          class="h-1.5 w-1.5 shrink-0 {live ? 'bg-accent' : 'bg-positive'}"
          aria-hidden="true"
        ></span>
        <span class="truncate text-2xs text-muted">
          {live ? tr('room.notesEditor.live') : tr('room.notesEditor.idle')}
        </span>
      </div>
    </div>
    <div class="flex shrink-0 items-center gap-2.5">
      <button
        type="button"
        class="{TAP} hidden h-9 items-center gap-2 border border-line px-3.5 text-ui text-ink
               hover:bg-surface sm:flex"
        onclick={() => {
          commit()
          importOpen = true
        }}
      >
        <Icon name="upload" size={14} />
        {tr('room.notesEditor.import')}
      </button>
      <button
        type="button"
        class="{TAP} hidden h-9 items-center gap-2 border border-line px-3.5 text-ui text-ink
               hover:bg-surface disabled:opacity-60 sm:flex"
        disabled={exporting || !arrived}
        onclick={() => void download()}
      >
        <Icon
          name={exporting ? 'spinner' : 'download'}
          size={14}
          class={exporting ? 'animate-spin' : ''}
        />
        {exporting ? tr('room.notesEditor.downloading') : tr('room.notesEditor.download')}
      </button>
      <span class="hidden h-6 w-px bg-line sm:block" aria-hidden="true"></span>
      <button
        type="button"
        class="{TAP} flex h-9 items-center gap-2.5 pl-2.5 pr-1 text-ui font-bold
               {closeAsked ? 'bg-danger/10 text-danger' : 'text-ink hover:bg-surface'}"
        title={tr('room.notesEditor.closeTitle')}
        onclick={close}
        onblur={() => (closeAsked = false)}
      >
        {closeAsked ? tr('room.notesEditor.closeUnsaved') : tr('room.notesEditor.close')}
        <kbd
          class="hidden border border-line px-1.5 py-px font-mono text-micro font-normal text-muted
                 md:inline"
        >
          Esc
        </kbd>
        <Icon name="x" size={16} />
      </button>
    </div>
  </header>

  <!-- ============================================================== body -->
  <div class="flex min-h-0 flex-1">
    <!-- ---------------------------------------------------- slide list -->
    <nav
      class="hidden w-[248px] shrink-0 flex-col border-r border-line md:flex xl:w-[296px]"
      aria-label={tr('room.notesEditor.list')}
    >
      <div class="flex h-[52px] shrink-0 items-center justify-between gap-3 border-b border-line px-5">
        <span class="hidden text-2xs font-black uppercase tracking-section text-ink xl:inline">
          {tr('room.notesEditor.list')}
        </span>
        <div class="flex items-center gap-3.5 whitespace-nowrap" role="group">
          {#each filters as [key, label] (key)}
            <button
              type="button"
              class="{TAP} border-b-2 pb-0.5 font-mono text-micro
                     {filter === key
                ? 'border-ink text-ink'
                : 'border-transparent text-muted hover:text-ink'}"
              aria-pressed={filter === key}
              onclick={() => (filter = key as 'all' | 'empty')}
            >
              {label}
            </button>
          {/each}
        </div>
      </div>
      <div class="min-h-0 flex-1 overflow-y-auto overscroll-contain" data-notes-list bind:this={list}>
        {#if !doc && !docFailed}
          <p class="flex items-center gap-2 px-5 py-4 text-2xs text-muted">
            <Icon name="spinner" size={14} class="shrink-0 animate-spin" />
            {tr('room.notesEditor.opening', { file: baseOf(file) })}
          </p>
        {:else}
          {#if docFailed}
            <p class="px-5 py-3 text-2xs text-muted">{tr('room.notesEditor.docFailed')}</p>
          {/if}
          {#if shown.length === 0}
            <p class="px-5 py-4 text-2xs text-muted">{tr('room.notesEditor.allFilled')}</p>
          {/if}
          {#each shown as at (at)}
            {@const text = noteOf(at)}
            {@const size = text.trim().length}
            {@const here = at === page}
            <button
              type="button"
              data-slide={at}
              class="flex w-full gap-3 border-b border-line py-3 pr-4 text-left transition-colors
                     duration-quick focus-visible:outline-none focus-visible:ring-2
                     focus-visible:ring-inset focus-visible:ring-accent/40
                     {here
                ? 'border-l-[3px] border-l-accent bg-surface pl-[17px]'
                : 'pl-5 hover:bg-surface/60'}"
              aria-current={here ? 'true' : undefined}
              onclick={() => go(at)}
            >
              <span
                class="relative block h-[68px] w-[120px] shrink-0 overflow-hidden border bg-white
                       {here ? 'border-ink' : 'border-line'}"
              >
                {#if doc}
                  <canvas
                    use:thumb={at}
                    class="absolute inset-0 m-auto block max-h-full max-w-full"
                    style={`aspect-ratio:${aspect}`}
                  ></canvas>
                {/if}
              </span>
              <span class="flex min-w-0 flex-1 flex-col gap-1">
                <span class="flex items-center justify-between">
                  <span class="font-mono text-micro text-ink {here ? 'font-bold' : ''}">{at}</span>
                  <span class="flex w-14 shrink-0 items-center justify-end gap-1.5">
                    {#if size > MAX}
                      <span
                        class="font-mono text-micro font-bold tabular-nums text-danger"
                        title={tr('room.notesEditor.overLimit', { count: size, max: MAX })}
                      >
                        {formatNumber(size)}
                      </span>
                      <span class="h-2 w-2 shrink-0 bg-danger" aria-hidden="true"></span>
                    {:else if size > WARN}
                      <span
                        class="font-mono text-micro font-bold tabular-nums text-warning"
                        title={tr('room.notesEditor.nearLimit', { count: size, max: MAX })}
                      >
                        {formatNumber(size)}
                      </span>
                      <span class="h-2 w-2 shrink-0 bg-warning" aria-hidden="true"></span>
                    {:else if size > 0}
                      <span class="h-2 w-2 shrink-0 bg-ink" aria-hidden="true"></span>
                    {:else}
                      <span
                        class="h-2 w-2 shrink-0 border-[1.5px] border-faint"
                        aria-hidden="true"
                      ></span>
                    {/if}
                  </span>
                </span>
                {#if size > 0}
                  <span
                    class="line-clamp-3 text-2xs leading-[17px] [overflow-wrap:anywhere]
                           {here ? 'text-ink' : 'text-muted'}"
                  >
                    {firstLine(text) || text.trim()}
                  </span>
                {:else}
                  <span class="text-2xs italic leading-[17px] text-faint">
                    {tr('room.notesEditor.noNote')}
                  </span>
                {/if}
              </span>
            </button>
          {/each}
        {/if}
      </div>
    </nav>

    <!-- ------------------------------------------------- slide and text -->
    <section class="flex min-w-0 flex-1 flex-col">
      <div class="flex shrink-0 gap-7 pb-6 pl-5 pr-5 pt-7 md:pl-9 md:pr-8">
        <div
          class="hidden h-[180px] w-[320px] shrink-0 overflow-hidden border border-line bg-white sm:flex
                 xl:h-[270px] xl:w-[480px]"
        >
          {#if doc}
            <LecturePage {doc} {page} bare />
          {/if}
        </div>
        <div class="flex min-w-0 flex-1 flex-col justify-between gap-4">
          <div class="flex flex-col gap-2.5">
            <div class="flex items-baseline gap-2">
              <span class="font-mono text-marquee font-medium tracking-[-0.03em] text-ink">{page}</span>
              <span class="font-mono text-ui-lg text-faint">/ {count}</span>
            </div>
            <span class="font-mono text-micro uppercase tracking-label text-accent-text">
              {minutes} · {tr('room.notesEditor.words', { count: words })}
            </span>
          </div>
          <div class="flex flex-col border-t border-line">
            {#each [-1, 1] as delta (delta)}
              {@const at = page + delta}
              {@const exists = at >= 1 && at <= count}
              <button
                type="button"
                class="flex gap-2.5 border-b border-line py-2.5 text-left transition-colors duration-quick
                       hover:bg-surface/60 focus-visible:outline-none focus-visible:ring-2
                       focus-visible:ring-inset focus-visible:ring-accent/40 disabled:hover:bg-transparent"
                disabled={!exists}
                onclick={() => go(at)}
              >
                <span
                  class="w-[26px] shrink-0 font-mono text-micro {delta > 0 ? 'text-ink' : 'text-muted'}"
                  aria-hidden="true"
                >
                  {delta > 0 ? '⌘↓' : '⌘↑'}
                </span>
                <span class="flex min-w-0 flex-col gap-0.5">
                  {#if exists}
                    <span
                      class="font-mono text-micro uppercase {delta > 0 ? 'text-accent-text' : 'text-faint'}"
                    >
                      {delta > 0
                        ? tr('room.notesEditor.next', { page: at })
                        : tr('room.notesEditor.prev', { page: at })}
                    </span>
                    <span
                      class="line-clamp-2 text-2xs leading-[17px]
                             {delta > 0 ? 'text-ink' : 'text-muted'}"
                    >
                      {nameOf(at)}
                    </span>
                  {:else}
                    <span class="text-2xs leading-[17px] text-faint">
                      {delta > 0 ? tr('room.notesEditor.lastSlide') : tr('room.notesEditor.firstSlide')}
                    </span>
                  {/if}
                </span>
              </button>
            {/each}
          </div>
        </div>
      </div>

      <!-- The text: a toolbar, then the field down to the status line. -->
      <div class="flex min-h-0 flex-1 flex-col pl-1 pr-5 md:pl-5 md:pr-8">
        {#if !wide}
          <!--
            Narrow: "text" and "as on the console" are tabs on a row of their
            own, so the toolbar below keeps the whole width for its buttons.
          -->
          <div class="ml-4 flex h-10 shrink-0 items-end gap-5" role="tablist">
            {#each tabs as [key, label] (key)}
              <button
                type="button"
                role="tab"
                aria-selected={tab === key}
                class="{TAP} whitespace-nowrap border-b-2 pb-1.5 text-2xs font-black uppercase
                       tracking-section
                       {tab === key
                  ? 'border-ink text-ink'
                  : 'border-transparent text-muted hover:text-ink'}"
                onclick={() => (tab = key as 'text' | 'preview')}
              >
                {label}
              </button>
            {/each}
          </div>
        {/if}
        <div
          class="ml-4 h-[46px] shrink-0 items-center justify-between gap-3 border-b-2 border-ink
                 {wide || tab === 'text' ? 'flex' : 'hidden'}"
        >
          <div class="flex min-w-0 items-baseline gap-2.5">
            {#if wide}
              <span class="shrink-0 text-2xs font-black uppercase tracking-section text-ink">
                {tr('room.notesEditor.text')}
              </span>
            {/if}
            <span class="hidden truncate text-ui text-muted lg:inline">
              {tr('room.notesEditor.textFor', { page })}
            </span>
          </div>
          {#if wide || tab === 'text'}
            <div
              class="flex min-w-0 items-center gap-0.5 overflow-x-auto"
              role="toolbar"
              aria-label={tr('room.notesEditor.text')}
            >
              <button
                type="button"
                class="{TOOL} w-8 justify-center text-[15px] font-black"
                title={tr('room.notesEditor.bold')}
                aria-label={tr('room.notesEditor.bold')}
                onmousedown={keep}
                onclick={() => field?.wrap('**')}
              >
                B
              </button>
              <button
                type="button"
                class="{TOOL} w-8 justify-center text-title italic"
                title={tr('room.notesEditor.italic')}
                aria-label={tr('room.notesEditor.italic')}
                onmousedown={keep}
                onclick={() => field?.wrap('*')}
              >
                I
              </button>
              <span class="mx-1 h-[18px] w-px shrink-0 bg-line" aria-hidden="true"></span>
              <button
                type="button"
                class="{TOOL} px-2.5 italic"
                title={tr('room.notesEditor.remarkTitle')}
                onmousedown={keep}
                onclick={() => field?.lineForm('remark')}
              >
                {tr('room.notesEditor.remark')}
              </button>
              <button
                type="button"
                class="{TOOL} gap-1.5 px-2.5"
                onmousedown={keep}
                onclick={() => field?.lineForm('list')}
              >
                <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true">
                  <path d="M5 3.5h8M5 7h8M5 10.5h8" stroke="currentColor" stroke-width="1.4" />
                  <rect x="1" y="2.75" width="1.6" height="1.6" fill="currentColor" />
                  <rect x="1" y="6.25" width="1.6" height="1.6" fill="currentColor" />
                  <rect x="1" y="9.75" width="1.6" height="1.6" fill="currentColor" />
                </svg>
                <span class="hidden lg:inline">{tr('room.notesEditor.listForm')}</span>
              </button>
              <button
                type="button"
                class="{TOOL} gap-1.5 px-2.5"
                onmousedown={keep}
                onclick={() => field?.lineForm('quote')}
              >
                <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true">
                  <rect x="1.5" y="2" width="1.6" height="10" fill="currentColor" />
                  <path d="M5.5 4h7M5.5 7h7M5.5 10h5" stroke="currentColor" stroke-width="1.4" />
                </svg>
                <span class="hidden lg:inline">{tr('room.notesEditor.quote')}</span>
              </button>
              <button
                type="button"
                class="{TAP} ml-0.5 flex h-8 shrink-0 items-center border-l-2 border-accent bg-raised
                       pl-2 pr-2.5 text-ui font-bold text-ink hover:bg-surface"
                title={tr('room.notesEditor.askTitle')}
                onmousedown={keep}
                onclick={() => field?.ask(tr('room.notesEditor.ask'))}
              >
                {tr('room.notesEditor.ask')}
              </button>
            </div>
          {/if}
        </div>

        <div class="relative flex min-h-0 flex-1 flex-col">
          {#if !ready}
            <p class="flex items-center gap-2 px-4 py-5 text-ui text-muted" aria-live="polite">
              <Icon name="spinner" size={14} class="shrink-0 animate-spin" />
              {tr('room.ui.196')}
            </p>
          {:else}
            <div class="flex min-h-0 flex-1 flex-col {wide || tab === 'text' ? '' : 'hidden'}">
              <NotesField
                bind:this={field}
                initial={draft}
                placeholder={tr('room.notesEditor.placeholder')}
                label={tr('room.notesEditor.field', { page })}
                {onedit}
                onfocus={() => (typing = true)}
                onblur={() => {
                  typing = false
                  commit()
                }}
                onneighbour={(delta) => go(page + delta)}
                onescape={close}
                clicker={leading}
              />
            </div>
          {/if}
          {#if !wide && tab === 'preview'}
            <div class="flex min-h-0 flex-1 justify-center py-4">
              {@render preview()}
            </div>
          {/if}
        </div>
      </div>
    </section>

    <!-- ---------------------------------------------------- the preview -->
    {#if wide}
      <aside class="flex w-[404px] shrink-0 flex-col gap-4 border-l border-line bg-surface px-6 py-5">
        {@render preview()}
      </aside>
    {/if}
  </div>

  <!-- ========================================================= status line -->
  <footer
    class="flex h-10 shrink-0 items-center justify-between gap-4 border-t border-line bg-canvas pl-5
           pr-4 md:pr-7"
  >
    <div class="flex min-w-0 items-center gap-5">
      <span class="flex min-w-0 items-center gap-2 text-2xs" aria-live="polite">
        {#if notice}
          <Icon name="check" size={12} class="shrink-0 text-positive" />
          <span class="truncate text-ink">{notice}</span>
        {:else if status === 'over'}
          <Icon name="alert" size={12} class="shrink-0 text-danger" />
          <span class="truncate text-danger">
            {tr('room.notesEditor.over', { max: formatNumber(MAX), count: formatNumber(length - MAX) })}
          </span>
        {:else if status === 'offline'}
          <Icon name="alert" size={12} class="shrink-0 text-warning" />
          <span class="truncate text-ink">{tr('room.notesEditor.offline')}</span>
        {:else if status === 'saving'}
          <Icon name="spinner" size={12} class="shrink-0 animate-spin text-muted" />
          <span class="truncate text-muted">{tr('room.notesEditor.saving')}</span>
        {:else if status === 'saved' && savedAt !== null}
          <Icon name="check" size={12} class="shrink-0 text-positive" />
          <span class="truncate text-ink">
            {tr('room.notesEditor.saved', {
              time: formatDate(savedAt, { hour: '2-digit', minute: '2-digit' }),
            })}
          </span>
        {:else}
          <span class="truncate text-muted">{tr('room.notesEditor.untouched')}</span>
        {/if}
      </span>
      <span class="h-4 w-px shrink-0 bg-line" aria-hidden="true"></span>
      <span class="flex shrink-0 items-center gap-2.5">
        <span
          class="font-mono text-micro tabular-nums
                 {over ? 'font-bold text-danger' : length > WARN ? 'font-bold text-warning' : 'text-ink'}"
        >
          {formatNumber(length)} / {formatNumber(MAX)}
        </span>
        <span class="relative hidden h-[3px] w-[72px] bg-line sm:block" aria-hidden="true">
          <span
            class="absolute inset-y-0 left-0 {over ? 'bg-danger' : length > WARN ? 'bg-warning' : 'bg-ink'}"
            style={`width:${Math.min(100, (length / MAX) * 100)}%`}
          ></span>
        </span>
      </span>
    </div>
    <div class="hidden items-center gap-6 lg:flex">
      {#if status !== 'idle' || notice}
        <span class="text-2xs text-muted">{tr('room.notesEditor.untouched')}</span>
      {/if}
      <span class="font-mono text-micro text-ink">{tr('room.notesEditor.neighbour')}</span>
    </div>
  </footer>

  {#if importOpen}
    <NotesImport
      {file}
      pages={pages > 0 ? pages : null}
      {notes}
      onclose={() => (importOpen = false)}
      onapplied={imported}
    />
  {/if}
</div>

{#snippet preview()}
  <div class="flex w-full max-w-[356px] min-h-0 flex-1 flex-col gap-4">
    <div class="flex h-7 shrink-0 items-center justify-between">
      <span class="text-2xs font-black uppercase tracking-section text-ink">
        {tr('room.notesEditor.preview')}
      </span>
      <span class="flex items-center gap-1.5">
        <span class="h-1.5 w-1.5 bg-accent" aria-hidden="true"></span>
        <span class="font-mono text-micro uppercase tracking-caps text-muted">
          {tr('room.notesEditor.livePreview')}
        </span>
      </span>
    </div>
    <div class="flex shrink-0 border border-line bg-canvas" role="group">
      {#each SIZES as px, index (px)}
        <button
          type="button"
          class="{TAP} flex h-11 flex-1 basis-0 items-baseline justify-center gap-2 pt-3
                 {index > 0 ? 'border-l border-line' : ''}
                 {step === index ? 'bg-brand font-bold text-white' : 'text-ink hover:bg-surface'}"
          aria-pressed={step === index}
          onclick={() => setStep(index)}
        >
          <span class={index === 2 ? 'text-title' : 'text-ui-lg'}>
            {index === 0
              ? tr('room.notesEditor.small')
              : index === 1
                ? tr('room.notesEditor.normal')
                : tr('room.notesEditor.large')}
          </span>
          <span
            class="font-mono text-micro font-normal {step === index ? 'text-white/70' : 'text-faint'}"
          >
            {px}
          </span>
        </button>
      {/each}
    </div>
    <!-- The console's card, in the console's colours whatever the room's theme. -->
    <div
      class="flex min-h-0 flex-1 flex-col overflow-hidden border border-line bg-canvas text-ink"
      style={NIGHT}
      bind:this={previewBox}
    >
      <div class="flex h-11 shrink-0 items-center gap-2 border-b border-line px-5">
        <span class="text-micro font-bold uppercase tracking-section text-muted">
          {tr('room.notesEditor.previewHead')}
        </span>
        <span class="h-3 w-0.5 shrink-0 bg-accent" aria-hidden="true"></span>
        <span class="font-mono text-micro text-muted">{page} / {count}</span>
        {#if script.timing}
          <span class="font-mono text-micro uppercase text-muted">· {script.timing.label}</span>
        {/if}
      </div>
      <NotesReader
        text={draft}
        arrived={ready}
        size={SIZES[step]}
        place={`${file}:${page}`}
        narrow
        ground="canvas"
        pad="px-5 pt-4"
        measure={356}
      />
    </div>
    <div class="flex shrink-0 flex-col gap-1">
      <span class="font-mono text-micro text-ink">
        {screens <= 1
          ? tr('room.notesEditor.fits', { size: SIZES[step] })
          : tr('room.notesEditor.screens', {
              size: SIZES[step],
              screens: formatNumber(Math.round(screens * 10) / 10),
            })}
      </span>
      {#if script.blocks.some((block) => block.kind === 'ask')}
        <span class="text-2xs text-muted">{tr('room.notesEditor.askHint')}</span>
      {/if}
    </div>
  </div>
{/snippet}
