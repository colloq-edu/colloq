<!--
  SPEAKER NOTES — what to say on this page.

  One page, one note. They are written the day before, going through the
  deck, and edited right in class, between two sentences; that is why there
  is no "Save" button here and no edit mode: the field is always live, and
  the text goes out by itself.

  Three decisions without which this thing does harm rather than good.

  FIRST. The draft goes to the server not only on a timer but also, ALWAYS,
  before a page change and on unmount. The most common sequence in a lecture
  hall is: wrote half a sentence and flipped the page right away; the timer
  is still ticking at that moment, and without the flush in cleanup that half
  sentence would be lost every time, and silently. The page number for the
  write is the one the FIELD had, not the current one: otherwise the sentence
  lands on the wrong slide.

  SECOND. What comes from the server does not move the text under the caret.
  The laptop and the tablet are one and the same person with one
  participantId, the echo of one's own edit comes back to both screens, and
  if it were accepted as is, the caret would jump to the end on every fourth
  character. While the field has focus, while the draft has not gone out and
  while the own-echo window has not expired, incoming text for this page is
  ignored. For every other page it is accepted at once.

  THIRD. "There are no notes" and "the notes have not arrived yet" are
  different screens. A teacher who sees emptiness where yesterday they wrote
  twenty lines will decide mid-class that they lost them. We tell the two
  apart by `session.notesFile`.

  One component, three homes: a pull-out sheet over the page on the tablet
  console in landscape, a block docked under the sheet in portrait
  (`docked`), and a narrow column under "next" on the laptop (`compact`). If
  they drifted apart, they would show the presenter different text in
  different places, and the presenter would notice it in the lecture hall.

  What is not here: markdown (a talk is written in lines, not as a
  document), a thumbnail of the next page (that is the sheet's job, not the
  text's) and showing it to anyone but the host: not to the audience, not to
  the projection, under no circumstances.
-->
<script lang="ts">
  import { tr } from '@shared/i18n'
  import { untrack } from 'svelte'
  import Icon from '@/components/ui/Icon.svelte'
  import { getSessionState } from '@/lib/session.svelte'
  import { MAX_NOTE_CHARS } from '@shared/lecture'
  import { stopwatch } from './pult'

  interface Props {
    /** The lecture document: notes are tied to the file, not to the lecture. */
    file: string
    /** The current page. Changing it commits the previous page's draft. */
    page: number
    /**
     * The narrow home: the presenter's column on the laptop, under "next".
     *
     * Not "a smaller font" but a different measure of space: in a 300 px
     * column the third size step gives eleven characters per line, that is,
     * a column of scraps instead of a paragraph. The console no longer uses
     * this flag (its notes sheet is always the full width of the screen), but
     * the LectureView column has stayed exactly as wide as it was, and its
     * measure has not changed.
     */
    compact?: boolean
    /**
     * Docked: tablet portrait, where the notes lie under the sheet across the
     * rest of the screen and do not slide anywhere. There is nothing to
     * "Collapse" here (the block is not over the sheet but beside it, and
     * collapsing it would leave a bare well half the screen tall), and there
     * is no swipe on the header either.
     */
    docked?: boolean
    /** Is the sheet collapsed. The parent owns the state and remembers it too. */
    folded?: boolean
    /** Collapse or expand. Not passed: no chevron in the header at all. */
    onfold?: (folded: boolean) => void
    /**
     * Open the "More" sheet: full screen, "End", changing the document, left
     * hand, the note on screen sleep and Guided Access.
     *
     * The button lives HERE, not on the rail: there is one rail, and each of
     * its keys is something pressed without looking ten times per class;
     * there is no room there for the rare. The notes header is the only
     * horizontal left on the console, and the "⋯" in its right corner is
     * where one reaches for the rare without looking. Not passed: no ellipsis
     * in the header at all (in the presenter's column on the laptop there is
     * nothing to open).
     */
    onmore?: () => void
    /**
     * READ ONLY. This is how notes live on the console.
     *
     * The talk is written while preparing for class: at a desk, with a
     * keyboard, looking at the whole document at once. On the console it is
     * read, and at exactly that moment editing is not a help but a
     * hindrance: the tablet is held in the hand under the palm, the input
     * field catches a stray touch, iPad raises the keyboard over half the
     * screen, and a Pencil brushing the field starts turning the stroke into
     * text. None of this happens because the person wants it; all three
     * happen INSTEAD of what they were doing.
     *
     * So on the console the notes are nailed down: text is shown as text,
     * there is no field at all, no character counter, no "Edit note". They
     * can be edited where there is a desk for it: in the presenter's column
     * on the laptop.
     */
    readonly?: boolean
  }

  let {
    file,
    page,
    compact = false,
    docked = false,
    folded = false,
    onfold,
    onmore,
    readonly = false,
  }: Props = $props()

  const session = getSessionState()

  /**
   * A blank sheet is a page with a negative number (see shared/lecture.ts),
   * and it NEVER HAS a note: the server answers "A note must belong to a
   * document page." and the text vanishes at the very first page flip. The
   * field used to be drawn here as if nothing were wrong, labelled "Notes for
   * page −1".
   */
  const onBoard = $derived(page < 1)

  /*
   * The note length ceiling is ONE for both ends, from `@shared/lecture`.
   *
   * It is not here for looks: a frame longer than the control socket's
   * ceiling is dropped by the server SILENTLY (no error, not a line in the
   * log), and a page of the talk that vanished without a word is the worst
   * thing this screen can do. While the number stood as a copy both here and
   * in control.ts, any edit to one copy would silently cut the talk at the
   * other. The comment meanwhile derived the margin from an 8192-byte frame
   * ceiling that has not existed since the frame was raised to 32 KB for the
   * council snapshot.
   */
  const MAX = MAX_NOTE_CHARS
  /*
   * From here on we count out loud. It used to be 300 characters: that is
   * half a note, and the number hung before the presenter's eyes for the
   * whole second half of every long page, telling them nothing. 150 is about
   * two lines at the default size: exactly the moment when a sentence can
   * still be finished shorter rather than rewritten.
   */
  const WARN = 2850
  /*
   * 400 ms after the last keystroke is a pause between words, not between
   * sentences. Less, and every word travels as a separate frame to two
   * screens; more, and a pause "to think" has time to become lost work if
   * the battery dies or the Wi-Fi blinks at that moment. Edits are not lost
   * either way: the draft goes out on blur, before a page change and when
   * the tab goes to the background; the timer only spares a frame per letter.
   */
  const SAVE_AFTER_MS = 400
  /*
   * A second and a half for our own echo to return. All that time incoming
   * text for the edited page does not touch the field: our text is newer
   * than anything that could have arrived. The window is temporary, not an
   * "I'm in charge here" flag: if the echo never returns (a dropped
   * connection), the field will accept the other text itself on the next
   * change.
   */
  const ECHO_MS = 1500
  /*
   * A swipe down on the header collapses the sheet. The 48 px threshold is
   * more than a finger's jitter when pressing "⋯" (a finger slides 3–8 px as
   * it lands) and less than the header's own height with a margin: the
   * gesture ends without leaving it. A swipe UP means nothing: the sheet is
   * already open.
   */
  const SWIPE_PX = 48

  /*
   * Size steps. The only place in the product where LETTERS grow rather than
   * boxes, and deliberately so: all other text is read with one's nose in
   * the screen, while a note is read with the head raised, in snatches
   * between glances at the audience.
   *
   * There are three steps, and the smallest is already large (18/26 against
   * the working 13/19): the choice is between "I read", "I read without
   * looking" and "I read across the hall", not between six point sizes of
   * which five are small.
   */
  const SIZES = ['text-prompt-sm', 'text-prompt', 'text-prompt-lg'] as const
  /*
   * The default is the MIDDLE step, not the bottom one.
   *
   * The ladder used to start at the bottom, and a person opening the console
   * for the first time a minute before class got the smallest point size: to
   * read their own note they had to lean towards the tablet, and there is no
   * time to lean in mid-sentence, nor to look for the size button. The
   * default must be a size with which a lecture can be given without ever
   * setting anything.
   */
  const DEFAULT_STEP = 1
  /*
   * In the presenter's narrow column the default is different: the BOTTOM
   * step.
   *
   * The middle step is justified by the measure of the notes sheet: 22 px on
   * 660 px is sixty characters per line, a real paragraph of speech. In the
   * laptop column the measure is three times shorter, and the same 22 px
   * give fifteen characters, that is, a column of scraps, which is exactly
   * why the top step was removed from this home. The same step means
   * different things on different measures, so each home picks the start of
   * its ladder itself. What a person picked explicitly is respected in both
   * homes: the choice is stored once per device.
   */
  const DEFAULT_COMPACT_STEP = 0
  const SIZE_KEY = 'colloq.pult.notesSize'

  const host = $derived(session.me.role === 'host')
  /** This document's notes have arrived. `false` is not "there are none" but "none yet". */
  const arrived = $derived(session.notesFile === file)
  const stored = $derived(arrived ? (session.notes[page] ?? '') : '')

  let draft = $state('')
  let typing = $state(false)
  let field = $state<HTMLTextAreaElement | null>(null)
  let step = $state(readStep())
  /** Grows when the field is reloaded not by typing: a cue to recompute the height. */
  let reloads = $state(0)

  /*
   * Plain mirrors of the draft, not runes: they are read by the flush, which
   * happens OUTSIDE a reactive context, in an effect's cleanup and in the
   * handler for the tab going to the background. And they hold the page the
   * text belongs to, not the one open right now.
   */
  let held = ''
  // The initial value is exactly what is needed: from then on these two
  // mirrors are driven by the reload effect, lagging one page behind, and
  // that is their whole job.
  // svelte-ignore state_referenced_locally
  let heldFile = file
  // svelte-ignore state_referenced_locally
  let heldPage = page
  let pending = false
  /*
   * Minus infinity, not zero: `performance.now()` counts from page load, and
   * with zero the first second and a half of the tab's life would look like
   * "we were just writing": notes arriving in that window would be rejected
   * and the pad would stay empty until the next change.
   */
  let sentAt = Number.NEGATIVE_INFINITY
  let timer: number | undefined

  /*
   * The presenter's narrow column has no top step: 28 px in a 300 px column
   * is eleven characters per line, that is, a column of scraps instead of a
   * paragraph. The ladder there ends at the default, and that is more honest
   * than letting someone press a button that makes the text worse.
   */
  const ladder = $derived(compact ? SIZES.slice(0, 2) : SIZES)
  const size = $derived(ladder[Math.min(step, ladder.length - 1)])
  const left = $derived(MAX - draft.length)

  /*
   * THE LECTURE STOPWATCH sits in the notes header, not only in the
   * instrument on the rail.
   *
   * Notes are opened exactly when one thinks "what to say and how much time
   * there is for it", and at that moment the eyes are on the sheet's header,
   * while the instrument is on the other edge of the tablet. It ticks once a
   * second and only while the sheet is expanded: a collapsed header carries
   * no stopwatch, and there is no reason to wake the layout next to the pen
   * for digits nobody can see. The timestamp comes from the server, and so
   * does the clock correction: a stopwatch counting from "when the tab was
   * opened" would lie about the class.
   */
  let tick = $state(Date.now())
  const lecture = $derived(session.lecture)
  const showClock = $derived(!compact && !folded && lecture !== null)
  $effect(() => {
    if (!showClock) return
    tick = Date.now()
    const id = window.setInterval(() => (tick = Date.now()), 1000)
    return () => window.clearInterval(id)
  })
  const runningFor = $derived(
    lecture ? Math.max(0, tick - session.clockSkewMs - lecture.startedAt) : 0,
  )

  /*
   * The stopwatch comes from `./pult`, the same function as in the instrument
   * on the rail. There used to be a word-for-word copy with the remark "same
   * as in the instrument": a remark is not how two functions in different
   * files are kept in agreement.
   */

  /*
   * The reload counter is read OUTSIDE tracking. Writing `reloads += 1` right
   * in the effect is not possible: a compound assignment reads first, the
   * effect subscribes to what it writes itself, and Svelte goes into a loop
   * ending in effect_update_depth_exceeded.
   */
  function refit(): void {
    reloads = untrack(() => reloads) + 1
  }

  function readStep(): number {
    const fallback = compact ? DEFAULT_COMPACT_STEP : DEFAULT_STEP
    try {
      const raw = localStorage.getItem(SIZE_KEY)
      const value = raw === null ? fallback : Number.parseInt(raw, 10)
      return Number.isFinite(value) && value >= 0 && value < SIZES.length ? value : fallback
    } catch {
      /* private mode: just start from this home's default */
      return fallback
    }
  }

  function bigger(): void {
    step = (Math.min(step, ladder.length - 1) + 1) % ladder.length
    try {
      localStorage.setItem(SIZE_KEY, String(step))
    } catch {
      /* the size lasts through the class even without being stored */
    }
  }

  /** Send the draft of the page it belongs to. */
  function commit(): void {
    if (timer !== undefined) {
      clearTimeout(timer)
      timer = undefined
    }
    if (!pending) return
    // The server rejects a note on a blank sheet: we stay quiet here so that
    // the refusal does not fly in as a banner from cleanup out of nowhere.
    if (heldPage < 1) {
      pending = false
      return
    }
    pending = false
    sentAt = performance.now()
    /*
     * We send the WHOLE text, not a diff. On a dropped connection the client
     * queue holds sixteen messages and throws out the old ones: with the full
     * text the one surviving message is the right one, with a diff what
     * survived would be a meaningless tail.
     */
    session.send({ t: 'notes:set', file: heldFile, page: heldPage, text: held })
  }

  function onInput(event: Event): void {
    const el = event.currentTarget as HTMLTextAreaElement
    /*
     * The ceiling is held by `maxlength`, both when typing and when pasting.
     * This line is for when it did not work (IME composition of a character,
     * pasting through the system menu in Safari): we cannot send more than is
     * visible in the field, the frame would be dropped silently anyway.
     */
    if (el.value.length > MAX) el.value = el.value.slice(0, MAX)
    draft = el.value
    held = el.value
    pending = true
    // The height is fixed right here, synchronously: through an effect it
    // would arrive a frame later, and a line wrapping onto the next one would
    // have time to flicker under the caret.
    fit(el)
    if (timer !== undefined) clearTimeout(timer)
    timer = window.setTimeout(commit, SAVE_AFTER_MS)
  }

  /*
   * The browser computes the height itself: first "how much is needed", then
   * we hit the box's max-height and from there the field scrolls. That way
   * the field grows with the text in the column where there is room, and
   * does not spill out of the sheet where there is none.
   */
  function fit(el: HTMLTextAreaElement | null): void {
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${el.scrollHeight}px`
  }

  /*
   * SWIPE DOWN ON THE HEADER to collapse.
   *
   * The sheet slides in from below, and the hand that summoned it pulls it
   * back with the same movement: that is how any sheet on iPad is closed,
   * and the finger looks for this gesture before the eye finds the "⌄". The
   * gesture lives on the header, not on the whole sheet: the body is an
   * input field, and vertical drift there is scrolling the text.
   *
   * Finger only: a pen on the header is a miss beside the field, and a mouse
   * on the test bench presses buttons. The gesture does not cancel the header
   * buttons: their `click` comes on lift, and a lift after a 48 px shift no
   * longer lands on the button.
   */
  let swipe: { id: number; y: number } | null = null

  function headDown(event: PointerEvent): void {
    if (docked || !onfold || folded || event.pointerType !== 'touch') return
    swipe = { id: event.pointerId, y: event.clientY }
  }

  function headMove(event: PointerEvent): void {
    if (!swipe || swipe.id !== event.pointerId) return
    if (event.clientY - swipe.y < SWIPE_PX) return
    swipe = null
    onfold?.(true)
  }

  function headUp(event: PointerEvent): void {
    if (swipe && swipe.id === event.pointerId) swipe = null
  }

  /* We ask for the notes ourselves: the parent need not know about them. */
  $effect(() => {
    if (host) session.openNotes(file)
  })

  /*
   * A page or document change. The previous page's draft goes out in
   * cleanup (Svelte calls it BEFORE the effect body, while the mirrors still
   * hold the old page), and then the field is reloaded with the new page's
   * note. The same cleanup runs on unmount, and it is the only protection
   * against "closed the console without letting go of the key".
   */
  $effect(() => {
    const nextFile = file
    const nextPage = page
    heldFile = nextFile
    heldPage = nextPage
    held = untrack(() => stored)
    draft = held
    refit()
    return () => commit()
  })

  /*
   * Incoming from the server. Accepted only when nobody is typing in the
   * field, our own draft has already left and our own echo window has
   * expired: the rest of the time the text under the caret does not move
   * under any circumstances.
   */
  $effect(() => {
    const fresh = stored
    if (typing || pending) return
    if (performance.now() - sentAt < ECHO_MS) return
    if (fresh === untrack(() => held)) return
    held = fresh
    draft = fresh
    refit()
  })

  /* Recompute the height after the field is reloaded or resized. */
  $effect(() => {
    void reloads
    void folded
    void size
    fit(field)
  })

  /*
   * The tab went to the background: on a tablet that is switching apps,
   * locking the screen or a swipe into Split View, and it may come back with
   * a dead socket. Whatever was typed is sent right here, without waiting for
   * the timer.
   */
  $effect(() => {
    const hide = () => {
      if (document.visibilityState === 'hidden') commit()
    }
    document.addEventListener('visibilitychange', hide)
    window.addEventListener('pagehide', commit)
    return () => {
      document.removeEventListener('visibilitychange', hide)
      window.removeEventListener('pagehide', commit)
    }
  })

  /*
   * The field is gone, but focus did not leave it.
   *
   * `typing` is cleared only by `onblur`, while the field is removed from the
   * markup on its own: by the sheet being collapsed, and by the layout
   * switching to the narrow one when the tablet is opened in Split View. The
   * browser is not obliged to send `blur` to an element removed from the
   * document, and in that case the console is left with the "editing a note"
   * flag raised: the pen stops drawing altogether, with not a line of
   * explanation on screen. The only cure is entering the field again, and
   * the field is no longer there.
   */
  $effect(() => {
    const gone = folded || !arrived
    untrack(() => {
      if (!gone || !typing) return
      commit()
      typing = false
    })
  })

  /*
   * The press is assembled by hand: the `transition-colors` utility rewrites
   * transition-property entirely and throws transform out of it, that is, it
   * silently cancels that very press. This product has been burned by this
   * before.
   */
  const TAP =
    'transition-[color,background-color,transform] duration-press ease-out ' +
    'active:scale-[0.97] focus-visible:outline-none focus-visible:ring-2 ' +
    'focus-visible:ring-inset focus-visible:ring-accent/40'

  /*
   * The sheet's padding. 24 px on the tablet, like any iOS sheet, not 30
   * like the old strip: that one stood on one vertical with the paper's
   * edge, while the sheet now LIES ON the paper and has nothing to line up
   * with. In the laptop column, 8: there every pixel of width is a character
   * in the line.
   */
  const PAD = $derived(compact ? 'px-2' : 'px-6')
  /*
   * Header targets are 44 px, the minimum finger target, and 40 tall, the
   * whole header. On the laptop, 32: there it is a mouse.
   */
  const CELL = $derived(compact ? 'h-8 w-8' : 'h-10 w-11')
</script>

{#if host}
  <!--
    The sheet does NOT DRAW the hairline on top. The edge of the pull-out
    sheet and the seam in portrait are held by the parent: only it knows
    whether the sheet lies over the paper (then the edge is the sheet's
    border) or is docked under it (then it is a seam of the layout). While the
    hairline was here, there came out two of them above the notes.

    The background on the console is transparent: the pull-out sheet is
    translucent (`bg-surface/[0.96]`) so that the paper shows faintly through
    it, and the ground is set by it, not by this section. In the laptop
    column the ground is still its own: canvas.
  -->
  <section class="flex min-h-0 flex-1 flex-col overflow-hidden {compact ? 'bg-canvas' : ''}">
    <!--
      A 40 header: on the left the section name, the mark and the stopwatch,
      on the right a cluster of targets. There is no hairline between them:
      on the night console a glowing full-width line reads as a scar, and
      there is nothing to separate here: the name and the cluster are set
      apart by empty space.

      The dot-bar next to the name is the only sign that THIS page has a
      note: when collapsed there is no other way to know. The bar is 2×12,
      not a circle: this product has no rounded corners at all, and a round
      disc of paint on the sheet would read as a pigment sample, which it is
      not.

      `touch-action: pan-x` on the header: vertical finger drift is our
      gesture (collapse), and it must not be given away to scrolling;
      horizontal drift means nothing, and the system may have it. The header
      has no role and needs none: the swipe here is a second way to press the
      "Collapse notes" button, which stands in the same header and is
      reachable from the keyboard; announcing an "interactive region" to a
      screen reader would be a lie.
    -->
    <!-- svelte-ignore a11y_no_static_element_interactions -->
    <header
      class="flex shrink-0 items-center gap-2 {PAD} {compact ? 'h-8' : 'h-10'}"
      style="touch-action: pan-x"
      onpointerdown={headDown}
      onpointermove={headMove}
      onpointerup={headUp}
      onpointercancel={headUp}
    >
      <span class="text-micro font-bold uppercase tracking-section text-muted">{tr('room.ui.194')}</span>
      {#if arrived && draft.trim()}
        <span class="h-3 w-0.5 shrink-0 bg-accent" title={tr('room.ui.307')}></span>
      {/if}
      {#if showClock}
        <span class="ml-2 font-mono text-code tabular-nums text-muted" aria-label={tr('room.ui.308')}>
          {stopwatch(runningFor)}
        </span>
      {/if}
      <span class="flex-1" aria-hidden="true"></span>
      <!--
        The cluster has NO gaps between targets: a finger lands here without
        taking the eyes off the audience, and a gap between neighbouring
        targets is a strip where a press does nothing at all. They are told
        apart by size and glyph, as on the rail, where there is not a single
        hairline between keys of one family.

        Order: size, "More", and in the very corner, "Collapse". The corner is
        where a finger lands without aiming, and collapsing the sheet is what
        people want most often.
      -->
      <div class="flex items-center">
        {#if arrived}
          <!--
            The size step. The word "larger" is no longer here: it is read
            once in a lifetime, yet it glows every second of the lecture, so
            the glyph takes over the label's job. The "A" and the arrow are
            drawn separately: the arrow is drawn by SVG rather than the ↕
            character from the font, because HSE Sans does not carry it and
            the system would substitute another typeface: on the console that
            looks like a part from a different kit.
          -->
          <button
            type="button"
            class="{TAP} {CELL} flex items-center justify-center gap-px text-muted hover:text-ink"
            aria-label={tr('room.ui.309')}
            title={tr('room.ui.310')}
            onclick={bigger}
          >
            <span class="text-title font-bold leading-none" aria-hidden="true">A</span>
            <svg
              width="7"
              height="12"
              viewBox="0 0 7 12"
              fill="none"
              stroke="currentColor"
              stroke-width="1.25"
              stroke-linecap="round"
              stroke-linejoin="round"
              aria-hidden="true"
            >
              <path d="M3.5 1v10M1 3.5 3.5 1 6 3.5M1 8.5 3.5 11 6 8.5" />
            </svg>
          </button>
        {/if}
        {#if onmore}
          <button
            type="button"
            class="{TAP} {CELL} flex items-center justify-center text-muted hover:text-ink"
            aria-label={tr('room.ui.312')}
            title={tr('room.ui.313')}
            onclick={() => onmore?.()}
          >
            <Icon name="more" size={16} />
          </button>
        {/if}
        {#if onfold && !docked}
          <button
            type="button"
            class="{TAP} {CELL} flex items-center justify-center text-muted hover:text-ink"
            aria-label={folded ? tr('room.extra.89') : tr('room.extra.90')}
            aria-pressed={folded}
            title={folded ? tr('room.extra.89') : tr('room.extra.90')}
            onclick={() => onfold?.(!folded)}
          >
            <Icon name={folded ? 'chevron-up' : 'chevron-down'} size={16} />
          </button>
        {/if}
      </div>
    </header>

    {#if !folded}
      <!--
        The indent is held by the BOX, not the field: the text measure is
        exactly 660 px, and if the padding went to the field, thirty-two of
        those pixels would be eaten by the padding itself and the measure
        would drift after it. Wider than 660 a line no longer comes back to
        the eye in one glance, and it is read in one glance, head raised. On
        12.9" (1366 px and wider) the measure is 900: the same sixty
        characters, but on a tablet held further from the eyes.
      -->
      <div class="relative min-h-0 flex-1 overflow-hidden {PAD}">
        {#if !arrived}
          <!--
            Not "empty" but "not here yet". That one-line difference is worth
            more here than the rest of the file: an empty field instead of
            yesterday's twenty lines reads as lost work.
          -->
          <p class="flex items-center gap-2 py-2 text-2xs text-muted" aria-live="polite">
            <Icon name="spinner" size={14} class="shrink-0 animate-spin" /> {tr('room.ui.196')} </p>
        {:else}
          <!--
            The field is always open, not "double-click to edit": on a tablet
            a double tap is the system zoom, and in class an extra movement is
            an extra second of silence in the lecture hall. The placeholder is
            muted, not faint: in an empty note the invitation is the whole
            content, and faint never carries information in this code.

            `pult-prompt` is the only place on the console where text can be
            selected: the rule is in index.css, because the ban at the console
            root (`.pult-root { user-select: none }`) lives there too, and the
            permission must stand next to the ban, not in another file.
          -->
          {#if readonly || onBoard}
            <!--
              A nailed-down note. Not a button: there is nothing to press, and
              a button that does nothing is a promise the console will not
              keep. It scrolls on its own: a long talk on a page must be
              readable to the end, and that is the only movement allowed here.
            -->
            <div
              class="{size} pult-prompt block max-h-full w-full max-w-[660px] overflow-y-auto
                     overscroll-contain whitespace-pre-line pb-6 text-ink
                     min-[1300px]:max-w-[900px] {draft.trim() ? '' : 'text-muted'}"
            >
              {onBoard
                ? tr('room.ui.314')
                : draft.trim() || tr('room.ui.315')}
            </div>
          {:else}
          <textarea
            bind:this={field}
            bind:value={draft}
            rows="1"
            maxlength={MAX}
            aria-label={tr('room.notes.page', { count: page })}
            placeholder={tr('room.ui.195')}
            class="{size} pult-prompt pult-caret block max-h-full w-full max-w-[660px] resize-none
                   overscroll-contain bg-transparent pb-6 text-ink placeholder:text-muted
                   focus-visible:outline-offset-0 min-[1300px]:max-w-[900px]
                   {compact ? 'min-h-[3rem]' : 'min-h-[4rem]'}"
            oninput={onInput}
            onfocus={() => (typing = true)}
            onblur={() => {
              typing = false
              // Left the field: the sentence goes out at once, without
              // waiting out the timer.
              commit()
            }}
          ></textarea>
          {/if}

          {#if !readonly && left <= MAX - WARN}
            <!--
              The counter stands at the RIGHT EDGE OF THE MEASURE, not in the
              header: it is about the text, and one should look at it where
              one writes. In the header it took the place of a cluster target
              and shifted the neighbours exactly when they are reached for
              without looking.

              The ground under the number is the home's ground: the box
              scrolls together with the text, and without a backing the last
              line would ride through the digits. The notes sheet on the
              console lies on surface, the laptop column on canvas.
            -->
            <span
              class="pointer-events-none absolute bottom-0 max-w-[660px] text-right min-[1300px]:max-w-[900px]
                     {compact ? 'left-2 right-2' : 'left-6 right-6'}"
            >
              <span
                class="pl-2 font-mono text-2xs tabular-nums text-faint {compact ? 'bg-canvas' : 'bg-surface'}"
              > {tr('room.ui.316')} {left}
              </span>
            </span>
          {/if}
        {/if}
      </div>
    {/if}
  </section>
{/if}

<style>
  /*
   * The caret is in the accent colour, not the text colour.
   *
   * The product's global caret is `ink` coloured, that is, almost white on
   * the console: on a dark sheet it cannot be seen at all, and the first
   * thing a person does after tapping into a note is look for where they
   * landed. There is one accent on this screen, and this is exactly its job:
   * "you are writing here".
   */
  .pult-caret {
    caret-color: rgb(var(--accent));
  }
</style>
