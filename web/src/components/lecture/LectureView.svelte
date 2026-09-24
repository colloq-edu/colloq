<!--
  The lecture: three screens from one component.

  THE PROJECTION is what the audience sees: the page full screen, a black
  background, nothing else. It lives on the computer at the projector, and
  everything that happens on it arrives over the network from the tablet in
  the teacher's hands. No screen casting: the wire carries a page number and
  points, not a picture.

  THE CONSOLE is what the presenter sees: the same page, the next one beside
  it, a clock and tools. Pages are turned from here, and drawing is done from
  here.

  THE AUDIENCE is what a student sees on their own screen: the same page and
  the same ink, but without the console. They can go off to the notebook and
  come back: the lecture does not hold them.

  One component rather than three, for the same reason one piece of code
  draws the ink: if they drifted apart, they would show the presenter one
  thing and the audience another, and nobody could notice it anywhere but in
  the lecture hall.
-->
<script lang="ts">
  import { tr } from '@shared/i18n'
  import { untrack } from 'svelte'
  import type { PDFDocumentProxy } from 'pdfjs-dist'
  import Icon from '@/components/ui/Icon.svelte'
  import { api } from '@/lib/api'
  import { fullscreenNow, fullscreenPossible, goFullscreen } from '@/lib/fullscreen'
  import { loadPdf } from '@/lib/pdf.svelte'
  import { getSessionState } from '@/lib/session.svelte'
  import type { LectureState } from '@shared/lecture'
  import { baseOf } from '@shared/paths'
  import { actsAfterClass } from '@shared/rules'
  import ConsoleLink from './ConsoleLink.svelte'
  import InkLayer from './InkLayer.svelte'
  import LecturePage from './LecturePage.svelte'
  import NotesPad from './NotesPad.svelte'
  import { INKS } from './pult'

  interface Props {
    /*
     * Not `state`: runes live nearby, and `$state` in a component body that
     * has a variable of that name reads as a subscription to a `$state`
     * store. The compiler says so unclearly, and the name was worse anyway.
     */
    lecture: LectureState
    /** In which role this screen looks at the lecture. */
    role: 'presenter' | 'audience' | 'projection'
    /** Leave the projection, back to the room. */
    onleave?: () => void
    /** Send THIS screen to the projector. */
    onproject?: () => void
    /** Leave the shared page for one's own reader. Not offered to the presenter. */
    onsolo?: () => void
  }

  let { lecture, role, onleave, onproject, onsolo }: Props = $props()

  const session = getSessionState()

  let doc = $state<PDFDocumentProxy | null>(null)
  let failureRender = $state<() => string | null>(() => null)
  const failure = $derived(failureRender())
  let pages = $state(0)

  /**
   * The document's path as a SEPARATE value, not a read from `lecture` inside
   * the effect.
   *
   * `lecture` arrives from the server as a whole object and is replaced on
   * every change of state, every page turn included. An effect that read
   * `lecture.file` inside itself thereby subscribed to the whole object: the
   * page changed, the effect restarted, the previous document was destroyed
   * (`loadingTask.destroy()`), and the new one downloaded from scratch. That
   * is, every press of "forward" downloaded and parsed the WHOLE deck again,
   * and the page itself came half a second later on an empty test bench; at
   * a live lecture with thirty megabytes through the relay, that is exactly
   * the "five seconds, or it never catches up".
   *
   * A `$derived` of the path string lets through only a real change of
   * document: the value is compared, not the reference.
   */
  const file = $derived(lecture.file)

  /** Counter of open attempts: "Try again" and the retry on the projection. */
  let attempt = $state(0)

  $effect(() => {
    const path = file
    void attempt
    /*
     * We reset EVERYTHING, not just `doc`.
     *
     * `failure` was never cleared, anywhere, by anything: one failed load
     * pinned the screen to the error branch for good; even changing the
     * lecture document did not bring the picture back, because the new PDF
     * arrived in `doc` while the markup kept showing the error. It hurt most
     * on the projection: there are no buttons there on purpose, and until the
     * end of class the audience reads "Could not open the lecture document."
     * instead of the slides. `pages` from the previous deck, on top of that,
     * kept a wrong upper bound for the step.
     */
    doc = null
    pages = 0
    failureRender = () => (null)
    let dropped = false
    let opened: PDFDocumentProxy | null = null
    void loadPdf()
      .then((pdf) => pdf.open(api.fileRaw(session.session.id, path), session.token))
      .then((ready) => {
        opened = ready
        // A document that arrives after we have left holds on to a pdf.js
        // worker and its buffers: without `destroy`, every exit mid-load is a
        // live worker until the end of class.
        if (dropped) {
          void ready.loadingTask.destroy()
          return
        }
        doc = ready
        pages = ready.numPages
      })
      .catch(() => {
        if (!dropped) failureRender = () => (tr('room.ui.303'))
      })
    return () => {
      dropped = true
      void opened?.loadingTask.destroy()
    }
  })

  /**
   * The projection retries by itself.
   *
   * It has not a single button, and that is a decision, not an omission: a
   * button on the projection is seen by the audience. So there is nobody to
   * retry for it either: the laptop at the projector stands open before
   * class, the network blinks at the moment of start, and without this timer
   * the lecture runs from the console while the audience spends forty
   * minutes looking at an error line.
   */
  const RETRY_MS = 5000
  $effect(() => {
    if (failure === null || role !== 'projection') return
    const again = window.setTimeout(() => (attempt += 1), RETRY_MS)
    return () => window.clearTimeout(again)
  })

  /* ---------------------------------------------------------- console */

  /*
   * The pen colours are the same four as on the console, and from one place
   * (`./pult`). A copy here has already drifted from the console once: there
   * the blue pen was explained with measured numbers and removed, here it
   * stood as the second circle. Yet the audience is the same, and so is the
   * projector.
   */
  let tool = $state<'pen' | 'laser' | 'off'>('off')
  let ink = $state(INKS[0].color)

  const presenting = $derived(role === 'presenter')
  const page = $derived(lecture.page)
  /** Host-only here: just the notes and the key link; a student may present too. */
  const host = $derived(session.me.role === 'host')

  /**
   * The class is over: the console became the teacher's.
   *
   * The bell does NOT put out the lecture: forty minutes of annotation live
   * only in the server's memory, they have no history, and the end of class
   * must not erase them. But the student who presented it can no longer run
   * it: the server will not accept a page, ink or pause from them anymore
   * (control.ts), so the whole console goes dark here at once: the bar, the
   * pen and the keyboard. A button that stays silent reads as a breakage,
   * and a dab the audience cannot see reads as a breakage twice over.
   *
   * The `board` rule does not express this: it is about who puts a document
   * on the shared screen, not about who presents a lecture already started.
   * Hence the same `actsAfterClass` as on the server.
   */
  const acts = $derived(actsAfterClass(session.finished, session.me.role))
  const pult = $derived(presenting && acts)

  /**
   * "Erase" and "End" have asked and are waiting for a second press.
   *
   * Cleared by a page change: a question left hanging on the next slide
   * turns the very first press into erasing without a question.
   *
   * Two questions never hang at once: there would then be two buttons
   * glowing red in the bar, and the "yes" would go to the wrong one.
   */
  let wipeAsked = $state(false)
  let stopAsked = $state(false)
  $effect(() => {
    void page
    untrack(() => {
      wipeAsked = false
      stopAsked = false
    })
  })

  /**
   * DESTRUCTIVE ACTIONS DO NOT GO INTO THE QUEUE WITHOUT A CONNECTION.
   *
   * `session.send` on a closed socket puts the frame into the control queue,
   * and it will get there half a minute later, when the Wi-Fi comes back.
   * For "Undo", "Erase" and "End" that is the worst of outcomes: on screen
   * everything stayed in place, the person moved on, and in the middle of
   * the next slide the audience's ink vanished by itself, without a single
   * press. Deferred destruction is worse than a refusal; the console is
   * protected from this by the same argument (see `undoStroke` in
   * ConsoleView).
   */
  function destructive(): boolean {
    if (session.connected) return true
    refuse(tr('room.ui.304'))
    return false
  }

  function askWipe(): void {
    if (!destructive()) {
      wipeAsked = false
      return
    }
    if (!wipeAsked) {
      stopAsked = false
      wipeAsked = true
      return
    }
    wipeAsked = false
    session.send({ t: 'ink:clear', page })
  }

  function undoStroke(): void {
    if (!destructive()) return
    session.send({ t: 'ink:undo', page })
  }

  /**
   * "End" takes a second press, like "Erase", and for the same reason.
   *
   * On `lecture:stop` the server deletes the lecture room entirely: the
   * projection goes dark, and the ink of ALL pages is erased for everyone,
   * irrecoverably: it has no history. Meanwhile the button stood right next
   * to "Project", that is, the one the presenter presses on the laptop at
   * the start of class: missing by one button took forty minutes of
   * annotation with it. On the console the same act asks with a separate row
   * in the "More" sheet.
   */
  function askStop(): void {
    if (!session.connected) {
      // Its own words: "nothing was erased" would say the wrong thing here.
      stopAsked = false
      refuse(tr('room.ui.255'))
      return
    }
    if (!stopAsked) {
      wipeAsked = false
      stopAsked = true
      return
    }
    stopAsked = false
    session.send({ t: 'lecture:stop' })
  }

  /**
   * Where we have already asked to go.
   *
   * Counting the next page from `lecture.page`, that is, from what the
   * server HAS ALREADY confirmed, works under exactly one condition: the
   * socket has time to make a round trip between two presses. On the test
   * bench seven arrow presses gave one page instead of seven: all seven
   * reached the window, all seven computed "current plus one" from the same
   * current page, and the server, told the same number six times in a row,
   * honestly replied "I'm already there". In class this looks like a stuck
   * arrow: you press ten times, the projector moves by one.
   *
   * So the step is counted from OUR OWN intention, not from someone else's
   * confirmation. The intention lives until the server catches up with it or
   * until someone else changes the page; the effect below watches for that.
   */
  let wanted = $state<number | null>(null)
  /**
   * Pages we managed to ask for while the intention had not come true.
   *
   * Without this list "the server stopped on a page other than the one we
   * want" reads as "someone else is turning pages", and most often it is our
   * own step along the way: two presses in a row ask for the sixth and the
   * seventh, the echo of the sixth arrives first, and the intention for the
   * seventh would have to be thrown away without waiting. Not a rune: nobody
   * draws it, it is only checked against.
   */
  let asked = new Set<number>()

  /*
   * The intention is cleared when the server has confirmed it, and when
   * someone else took the page away. The second matters more than the
   * first: if the presenter turns pages from the tablet while this window
   * remembers its old "I want the sixth", the next arrow will step from the
   * sixth, not from the one the audience sees, and the two screens will
   * drift apart silently. Someone else's move always outranks our intention.
   */
  $effect(() => {
    const at = lecture.page
    untrack(() => {
      if (wanted === null) return
      if (at === wanted) {
        // Caught up: the intention came true.
        wanted = null
        asked.clear()
      } else if (!asked.has(at)) {
        /*
         * A page we did not ask for, so someone else is turning pages: a
         * second teacher or the same person's tablet. Someone else's move
         * always outranks our intention; otherwise the next arrow would step
         * from our forgotten seventh, not from the one the audience sees, and
         * the two screens would drift apart silently, that is, exactly what
         * must not happen in a lecture would happen.
         */
        wanted = null
        asked.clear()
      }
    })
  })

  /**
   * AN INTENTION IS NOT FOREVER: we repeat the request and then give up.
   *
   * The effect above clears `wanted` only on the server's echo, and the echo
   * may never come: the socket closed right after `send` (which checks only
   * readyState), or the server rejected the frame in the window between the
   * bell and the arrival of "class is over". Then the intention hangs
   * forever, `turn()` counts from it, and the next arrow asks for
   * `wanted + 1`: the audience jumps over a slide.
   *
   * So here we do the same as the console (ConsoleView): every 600 ms we
   * repeat the request (`lecture:page` is idempotent, and a server already on
   * that page will simply stay silent), and after five unanswered attempts
   * the intention is dropped and the step is counted again from what the
   * audience sees. Without a connection, attempts are neither counted nor
   * sent: spending them on a closed socket would mean giving up exactly when
   * there is nothing to give up over.
   *
   * `wanted` is read HERE as tracked (unlike the effect above): the timer
   * must start on the intention itself, not only on the server's answer.
   */
  const AGAIN_MS = 600
  const AGAIN_MAX = 5
  $effect(() => {
    const at = lecture.page
    const mine = wanted
    if (mine === null || mine === at) return
    let tries = 0
    const again = window.setInterval(() => {
      if (!session.connected) return
      tries += 1
      if (tries > AGAIN_MAX) {
        wanted = null
        asked.clear()
        return
      }
      session.send({ t: 'lecture:page', page: mine })
    }, AGAIN_MS)
    return () => window.clearInterval(again)
  })

  /**
   * The slide we return to from a blank sheet: the last one the audience saw.
   *
   * There is no sheet count of our own here (the console keeps it), so
   * "where to go back" is remembered from the lecture itself: one, for the
   * case when this screen was opened already on a sheet.
   */
  let lastSlide = $state(1)
  $effect(() => {
    const at = lecture.page
    untrack(() => {
      if (at > 0) lastSlide = at
    })
  })

  /**
   * A step forward or back. Knows about blank sheets: pages with a NEGATIVE
   * number (see shared/lecture.ts).
   *
   * "±1" arithmetic is dead on them in both directions: from sheet −1
   * "forward" gives 0, "back" gives −2, and both were silently dropped,
   * together with the arrows, the space bar and the presentation clicker
   * plugged into the computer at the projector. There was no way at all to
   * bring the audience back to the slides from the room.
   *
   * Sheets are ordered by creation (−1 first), as in the console's strip.
   * "Forward" from any sheet returns to the slide: only the console knows
   * how many sheets have been started, and starting a new one silently would
   * put a white field in front of the audience mid-sentence.
   */
  function turn(step: -1 | 1): void {
    const from = wanted ?? page
    if (from < 0) {
      go(step === -1 && from < -1 ? from + 1 : lastSlide)
      return
    }
    const next = from + step
    /*
     * The upper bound when our own copy did not open (`pages === 0`): one
     * page past the one ALREADY on the audience's screen. Without it a held
     * arrow drove the audience's page numbers past the end of the deck (the
     * server accepts any positive one), and getting back took sixty presses.
     * The same bound, for the same reason, stands in the console
     * (ConsoleView.goTo).
     */
    const top = pages > 0 ? pages : Math.max(page, 1) + 1
    if (next < 1 || next > top) return
    go(next)
  }

  function go(next: number): void {
    if (next === (wanted ?? page)) return
    wanted = next
    asked.add(next)
    session.send({ t: 'lecture:page', page: next })
  }

  /*
   * The console keyboard: the arrows and the space bar turn pages, B blanks
   * the screen, Z removes the last stroke, E asks about erasing the page.
   * Exactly what is pressed without looking, and what a presentation clicker
   * sends if you plug it into the computer at the projector.
   *
   * Z and E are the same letters as on the console (ConsoleView), and by
   * `code`, not by `key`: on a Russian layout `key` is "я" and "у". They
   * used to be missing here entirely, while the comment and the button label
   * talked about them: a person on the laptop read "— Z on the console",
   * pressed Z on this very screen and got nothing.
   */
  /**
   * Whether these are our own slides. The projection stands on the computer
   * at the projector, and usually it is the same teacher who presents from
   * the tablet (the tablet signs in by key as the same participant); then
   * the keyboard and the clicker plugged into this computer turn the
   * lecture's pages. The projection does not turn someone else's lecture:
   * the server would drop that, and a silent press is better than turning
   * someone else's slide.
   */
  const mine = $derived(lecture.by === session.me.id)

  /* Projection full screen: on the first gesture in its window, see SessionScreen. */
  let full = $state(fullscreenNow())
  $effect(() => {
    const sync = () => (full = fullscreenNow())
    document.addEventListener('fullscreenchange', sync)
    document.addEventListener('webkitfullscreenchange', sync)
    return () => {
      document.removeEventListener('fullscreenchange', sync)
      document.removeEventListener('webkitfullscreenchange', sync)
    }
  })

  function fillScreen(): void {
    if (fullscreenPossible() && !fullscreenNow()) void goFullscreen(document.documentElement)
  }

  /**
   * An ink layer refusal: one line for six seconds.
   *
   * There is only one refusal: the page has collected its six hundred
   * strokes, and the server will not accept the next one. Nobody used to say
   * so: the line appeared, lived for four seconds on resends and vanished,
   * while the audience never had it at all. The room's banners do not fit
   * here: they are about the network and the kernel, while this is an answer
   * to a stroke, and it must stand where the stroke is: at the sheet.
   */
  let refusal = $state<string | null>(null)
  let refusalTimer: number | undefined
  function refuse(says: string): void {
    refusal = says
    window.clearTimeout(refusalTimer)
    refusalTimer = window.setTimeout(() => (refusal = null), 6000)
  }
  $effect(() => () => window.clearTimeout(refusalTimer))

  function onkeydown(event: KeyboardEvent): void {
    if (role === 'projection' && event.code === 'KeyF') {
      event.preventDefault()
      fillScreen()
      return
    }
    // `acts` on the projection too: the keyboard at the projector turns the
    // lecture's pages just like the console, and after the bell the server
    // will ignore it just the same.
    if (!pult && !(role === 'projection' && mine && acts)) return
    // The target may not be an element (document, window): no `closest` there.
    const target = event.target instanceof Element ? event.target : null
    if (target?.closest('input, textarea, [contenteditable]')) return
    if (event.key === 'Escape' && (wipeAsked || stopAsked)) {
      // A pending question is dismissed the way any question is dismissed.
      event.preventDefault()
      wipeAsked = false
      stopAsked = false
      return
    }
    if (event.key === 'ArrowRight' || event.key === 'PageDown' || event.key === ' ') {
      event.preventDefault()
      turn(1)
    } else if (event.key === 'ArrowLeft' || event.key === 'PageUp') {
      event.preventDefault()
      turn(-1)
    } else if (event.code === 'KeyB') {
      event.preventDefault()
      session.send({ t: 'lecture:blank', on: !lecture.blank })
    } else if (event.code === 'KeyZ' && !event.metaKey && !event.ctrlKey && !event.altKey) {
      // Only from the console: the tablet draws the ink, while the keyboard
      // at the projector turns pages. There is no reason to undo someone
      // else's stroke from there.
      if (!pult) return
      event.preventDefault()
      undoStroke()
    } else if (event.code === 'KeyE' && !event.metaKey && !event.ctrlKey && !event.altKey) {
      if (!pult) return
      event.preventDefault()
      /*
       * Auto-repeat arrives here by the dozen, and without this line a held E
       * asked the question and answered it itself, that is, erased the page
       * by holding the key.
       */
      if (event.repeat) return
      askWipe()
    }
  }

  /*
   * There are exactly two trackings here, and the difference between them
   * carries meaning: 0.14em (`tracking-label`) names an ACTION, something
   * pressed, while 0.2em (`tracking-section`) names a PLACE: "next",
   * "pause". The same 11-pixel caps used to carry four different trackings
   * (0.08 on buttons, 0.16 on the projection state, 0.2 on area names); a
   * reader cannot tell them apart, nobody can keep them consistent, and
   * within a month they drift apart.
   */
  /*
   * The press is spelled out as properties, not the `.press` helper: a
   * `transition-*` utility rewrites `transition-property` entirely, and the
   * helper's transform would not make it into that list; the same trap as
   * with the cell lock and the console keys. The lecture bar is the
   * presenter's only control on the laptop, "Next" on it is pressed some
   * fifty times per class, and the page does not arrive instantly: 3 % under
   * the finger is exactly the confirmation that the press was heard, which
   * it lacked while it carried a lone `transition-colors`.
   */
  const TOOL =
    'flex h-8 items-center gap-1.5 px-2.5 text-2xs font-bold uppercase tracking-label ' +
    'transition-[color,background-color,border-color,transform] duration-press ease-out ' +
    'enabled:active:scale-[0.97] focus-visible:outline-none focus-visible:ring-2 ' +
    'focus-visible:ring-inset focus-visible:ring-accent/40'
</script>

<svelte:window {onkeydown} />

{#if role === 'projection'}
  <!--
    The projection. A black background, nothing but the page, and not a
    single button: everything that may be needed in the lecture hall is
    already in the presenter's hands. The exit is hidden under Escape and a
    click in the corner: a stray mouse click on the projection must not
    interrupt the lecture.
  -->
  <!--
    A click on the projection means full screen. The projection now opens as
    a separate window, and full screen cannot be requested for another
    window: the browser grants it only on a gesture in that window itself.
    The first thing people do with a new window is click into it, and that is
    enough. There is no button on purpose: any button on the projection is a
    button the audience sees.
  -->
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <!-- svelte-ignore a11y_click_events_have_key_events -->
  <div class="fixed inset-0 z-[100] flex flex-col bg-black" onclick={fillScreen}>
    {#if lecture.blank}
      <div class="flex flex-1 items-center justify-center">
        <span class="text-2xs uppercase tracking-section text-white/30">{tr('room.ui.276')}</span>
      </div>
    {:else if failure}
      <div class="flex flex-1 items-center justify-center px-8 text-center text-ui text-white/70">
        {failure}
      </div>
    {:else}
      <div class="flex min-h-0 flex-1 p-4">
        <LecturePage {doc} {page}>
          {#snippet over(size)}
            <InkLayer
              {page}
              live={false}
              tool="off"
              color={lecture.color}
              width={0.004}
              w={size.w}
              h={size.h}
            />
          {/snippet}
        </LecturePage>
      </div>
    {/if}
    <button
      type="button"
      class="absolute right-0 top-0 h-12 w-12 text-white/0 transition-colors duration-100 hover:text-white/40 focus-visible:outline-none"
      title={tr('room.ui.277')}
      aria-label={tr('room.ui.278')}
      onclick={(event) => {
        event.stopPropagation()
        onleave?.()
      }}
    >
      <Icon name="x" size={16} />
    </button>
    {#if !full && fullscreenPossible()}
      <!--
        The hint lives only WHILE the window is not full screen, that is,
        while the projection is still being set up rather than shown to the
        audience. The arrows are mentioned only to the owner of the slides: it
        does not turn anyone else's.
      -->
      <p class="pointer-events-none absolute bottom-4 right-5 text-2xs uppercase tracking-label text-white/35">
        {mine ? tr('room.ui.279') : ''}{tr('room.ui.280')} </p>
    {/if}
  </div>
{:else}
  <section class="flex min-h-0 flex-1 flex-col bg-surface">
    {#if pult}
      <!--
        The console. The bar under the tabs, where the notebook has Run All:
        each tab has its own, and it is always under it.
      -->
      <div class="flex h-[34px] shrink-0 items-stretch border-b border-line bg-canvas">
        <button
          type="button"
          class="{TOOL} w-10 justify-center text-muted hover:text-ink disabled:opacity-30"
          disabled={page > 0 && page <= 1}
          aria-label={tr('room.ui.174')}
          onclick={() => turn(-1)}
        >
          <Icon name="chevron-left" size={14} />
        </button>
        <span class="flex items-center px-1 font-mono text-2xs tabular-nums text-ink">
          {#if page < 0}{tr('room.ui.159')}{:else}{page} / {pages || '—'}{/if}
        </span>
        <button
          type="button"
          class="{TOOL} w-10 justify-center text-muted hover:text-ink disabled:opacity-30"
          disabled={page > 0 && pages > 0 && page >= pages}
          aria-label={tr('room.ui.175')}
          onclick={() => turn(1)}
        >
          <Icon name="chevron-right" size={14} />
        </button>

        <span class="my-2 w-px bg-line" aria-hidden="true"></span>

        <!-- The pen. The colour is chosen by the same press as the pen itself:
             two separate switches for four colours would be two questions
             where the person asks one. -->
        {#each INKS as choice (choice.color)}
          <button
            type="button"
            class="press flex w-8 items-center justify-center focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent/40"
            title={tr('room.extra.83', { p0: choice.short })}
            aria-label={tr('room.extra.83', { p0: choice.short })}
            aria-pressed={tool === 'pen' && ink === choice.color}
            onclick={() => {
              tool = 'pen'
              ink = choice.color
            }}
          >
            <!--
              The circle grows from STATE, and grows instantly: the state
              arrives by itself, and animating it means drawing it later than
              it happened (the same reason the "on" bar on a console key is
              not animated). Transform is given to the finger: `press` on the
              button itself, taken by name; there are no other transition
              utilities on it, so nothing rewrites `transition-property`.
            -->
            <span
              class="h-4 w-4 rounded-full border-2 {tool === 'pen' && ink === choice.color
                ? 'scale-110 border-ink'
                : 'border-transparent'}"
              style={`background:${choice.color}`}
            ></span>
          </button>
        {/each}

        <button
          type="button"
          class="{TOOL} {tool === 'laser' ? 'bg-raised text-ink' : 'text-muted hover:text-ink'}"
          aria-pressed={tool === 'laser'}
          title={tr('room.ui.282')}
          onclick={() => (tool = tool === 'laser' ? 'off' : 'laser')}
        >
          <Icon name="bolt" size={12} /> {tr('room.ui.165')} </button>
        <button
          type="button"
          class="{TOOL} {tool === 'off' ? 'bg-raised text-ink' : 'text-muted hover:text-ink'}"
          aria-pressed={tool === 'off'}
          title={tr('room.ui.283')}
          onclick={() => (tool = 'off')}
        > {tr('room.ui.284')} </button>

        <span class="my-2 w-px bg-line" aria-hidden="true"></span>

        <button
          type="button"
          class="{TOOL} text-muted hover:text-ink"
          title={tr('room.ui.285')}
          aria-label={tr('room.ui.166')}
          onclick={undoStroke}
        >
          <Icon name="undo" size={12} /> {tr('room.ui.286')} </button>
        <!--
          "Erase" asks, and not out of politeness: it stands in one row with
          "Pause", and a mouse miss by one button to the left took away all of
          the slide's annotation for the audience and on the projector,
          instantly and irrecoverably: lecture ink lives only in the server's
          memory, it has no history. On the console the same operation is
          protected by holding the eraser and by a separate question.
        -->
        <button
          type="button"
          class="{TOOL} {wipeAsked ? 'bg-danger/10 text-danger' : 'text-muted hover:text-ink'}"
          title={tr('room.ui.287')}
          onclick={askWipe}
          onblur={() => (wipeAsked = false)}
        >
          <Icon name="eraser" size={12} />
          {wipeAsked ? tr('room.ui.288') : tr('room.ui.221')}
        </button>
        <button
          type="button"
          class="{TOOL} {lecture.blank ? 'bg-ink text-canvas' : 'text-muted hover:text-ink'}"
          aria-pressed={lecture.blank}
          title={tr('room.ui.290')}
          onclick={() => session.send({ t: 'lecture:blank', on: !lecture.blank })}
        > {tr('room.ui.291')} </button>

        <span class="flex-1"></span>

        <!--
          The console is handed over by the TEACHER. A student may present a
          lecture too (the `board: 'room'` rule allows it), but `/handoff`
          answers them 403, and a button whose only outcome is a refusal does
          not belong here.
        -->
        {#if host}
          <ConsoleLink class="{TOOL} text-muted hover:text-ink" />
        {/if}
        {@render projectButton()}
        <!--
          The hairline between "Project" and "End" is not decoration: these
          are two neighbouring buttons, the first pressed at the start of
          class and the second irreversible. The second-press question is the
          main protection; the gap holds back the finger.
        -->
        <span class="my-2 w-px bg-line" aria-hidden="true"></span>
        <button
          type="button"
          class="{TOOL} {stopAsked ? 'bg-danger/10 text-danger' : 'text-danger hover:bg-danger/10'}"
          title={tr('room.ui.293')}
          onclick={askStop}
          onblur={() => (stopAsked = false)}
        >
          {stopAsked ? tr('room.ui.294') : tr('room.ui.230')}
        </button>
      </div>
    {:else if presenting}
      <!--
        They presented the lecture, and the bell has already rung. One line
        instead of the bar: the lecture stayed on screen (both the page and
        the ink), and the console became the teacher's. Keys removed silently
        would read as the tablet breaking down in the middle of the lecture
        hall.
      -->
      <div
        class="flex h-[34px] shrink-0 items-center gap-2 border-b border-line bg-canvas px-4 text-2xs text-muted"
      >
        <!-- A calm dot, not an alarming one: this is the teacher's decision,
             not a breakage, and the lecture on screen stays as it was. -->
        <span class="h-1.5 w-1.5 shrink-0 rounded-full bg-accent"></span>
        <span class="min-w-0 flex-1 truncate"> {tr('room.ui.295')} </span>
        <span class="shrink-0 font-mono tabular-nums">
          {#if page < 0}{tr('room.ui.296')}{:else}{page} / {pages || '—'}{/if}
        </span>
        {@render projectButton()}
      </div>
    {:else}
      <!-- One line for the audience: who presents and what is on. No controls at all. -->
      <div
        class="flex h-[34px] shrink-0 items-center gap-2 border-b border-line bg-canvas px-4 text-2xs text-muted"
      >
        <span class="h-1.5 w-1.5 shrink-0 rounded-full" style={`background:${lecture.color}`}></span>
        <!--
          Who presents and what is on, as one shrinking group.

          The name and the file stood as bare text right in the flex, that is,
          nothing let them shrink: on a phone "lecture by Aleksandra
          Konstantinopolskaya · lecture-07.pdf" pushed both the page counter
          and "Share screen" off the right edge. What shrinks is what gets
          read; the counter and the buttons stay whole.
        -->
        <span class="flex min-w-0 flex-1 items-center gap-2">
          <span class="truncate"> {tr('room.ui.297')} {lecture.byName} </span>
          <span class="shrink-0 text-faint">·</span>
          <span class="truncate font-mono">{baseOf(lecture.file)}</span>
        </span>
        <span class="shrink-0 font-mono tabular-nums">
          {#if page < 0}{tr('room.ui.296')}{:else}{page} / {pages || '—'}{/if}
        </span>
        {#if onsolo}
          <!--
            Step away from the shared page, and come back. In this product the
            teacher is FOLLOWED, not tied to: a student who needs to reread
            the previous slide must not have to wait for the end of the
            lecture to do it.
          -->
          <button
            type="button"
            class="{TOOL} -my-2 text-muted hover:text-ink"
            title={tr('room.ui.298')}
            onclick={() => onsolo?.()}
          > {tr('room.ui.299')} </button>
        {/if}
        {@render projectButton()}
      </div>
    {/if}

    {#if failure}
      <!--
        The document did not open ON OUR SIDE: an expired token, a broken
        network, a corrupt cache. At the projector it is most likely open, and
        the lecture can be carried through with the buttons and the notes.
        Taking away from the presenter what still works because of our own
        failure is the worst thing this screen can do.
      -->
      <div class="flex min-h-0 flex-1 gap-3 p-3">
        <div class="flex min-w-0 flex-1 flex-col items-start gap-3">
          <p class="text-ui text-muted">{failure}</p>
          <!-- A manual retry: a network that blinked at the moment of start
               is no reason to get through the class without slides on your
               own screen. -->
          <button type="button" class="btn-outline h-8 px-3 text-2xs" onclick={() => (attempt += 1)}> {tr('room.ui.191')} </button>
        </div>
        {#if presenting && host}
          <aside class="hidden w-[28%] shrink-0 flex-col lg:flex">
            <NotesPad file={lecture.file} {page} compact />
          </aside>
        {/if}
      </div>
    {:else}
      <div class="relative flex min-h-0 flex-1 gap-3 p-3">
        <LecturePage {doc} {page}>
          {#snippet over(size)}
            <InkLayer
              {page}
              live={pult}
              tool={pult ? tool : 'off'}
              color={ink}
              width={0.004}
              w={size.w}
              h={size.h}
              onrefuse={refuse}
            />
          {/snippet}
        </LecturePage>
        {#if refusal}
          <!-- By the bottom edge on the left: nobody looks there while
               drawing, and everybody looks there when the drawing failed. -->
          <div
            class="pointer-events-none absolute bottom-4 left-4 z-10 flex h-7 items-center bg-ink px-3"
            aria-live="polite"
          >
            <span class="text-2xs font-bold uppercase tracking-label text-canvas">{refusal}</span>
          </div>
        {/if}

        {#if pult && (host || (page > 0 && pages > page))}
          <!--
            The presenter's column is the Speaker View: what comes next and
            what to say about it. Knowing this without peeking ahead on the
            projector.

            "Next" is shown only when there is a next page, while the notes
            are always shown: on the last slide there is still talking to do,
            and a strip that vanished exactly there would read as a breakage.
            The notes get the lower, larger half of the column: they are read
            with the head raised from the screen, while the thumbnail is
            glanced at from the corner of the eye.

            Neither the audience nor the projection gets the notes in any
            form, neither empty nor collapsed: what is "just empty" will one
            day turn out not to be, and the whole audience will see it.
          -->
          <aside class="hidden w-[28%] shrink-0 flex-col gap-2 lg:flex">
            {#if page > 0 && pages > page}
              <span class="text-micro font-bold uppercase tracking-section text-muted"> {tr('room.ui.197')} </span>
              <div class="flex min-h-0 basis-[42%]">
                <LecturePage {doc} page={page + 1} dim />
              </div>
            {/if}
            <NotesPad file={lecture.file} {page} compact />
          </aside>
        {/if}
      </div>
    {/if}
  </section>
{/if}

<!--
  "Project" is one button for two places: both the presenter and the
  audience have it, and that is not generosity. The projection is opened on
  SOMEONE ELSE'S machine, the one plugged into the projector, and the person
  at it is most often not the presenter: a lab assistant, a student, anyone
  who entered the room by the same link. Requiring the console for this
  would mean requiring the teacher to walk over to the department laptop.
-->
{#snippet projectButton()}
  {#if onproject}
    <button
      type="button"
      class="{TOOL} text-muted hover:text-ink"
      title={tr('room.ui.300')}
      onclick={() => onproject?.()}
    >
      <Icon name="board" size={12} /> {tr('room.ui.301')} </button>
  {/if}
{/snippet}
