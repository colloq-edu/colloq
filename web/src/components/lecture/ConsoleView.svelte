<!--
  THE CONSOLE is a separate app for the tablet in the teacher's hands.

  Not "the room squeezed down to a tablet": there are no tabs, no files
  panel, no oracle and no terminal here at all. A person speaking in front of
  an audience has exactly four questions (what is on screen now, what comes
  next, what to say, how much time has passed), and every extra control is
  an extra second of silence in the lecture hall.

  THE BENCHMARK IS GOODNOTES, NOT A PAGE IN A BROWSER. The first try on iPad
  ended with the verdict "much too bad": the sheet stood as a little window
  in the top third, a palm on its margins started system selection, a second
  palm contact dropped the stroke, and the pointer lived as a separate spring
  that the pen did not release. Four rules were derived from this, and the
  file is built on them.

  1. THE SHEET IS THE WHOLE REST OF THE SCREEN, AND NOTHING LIES ON IT. One
     rail (72 px in landscape, 64 at the bottom in portrait), 12 px margins,
     a reading strip under the slide (page, time, plan, "next"), and
     everything else is paper. The notes never cover the paper: in landscape
     they are a column beside it (the slide refits to what is left, as
     Keynote's presenter view does), in portrait the docked remainder under
     it with a divider the hand can drag, and "Prompter" gives the whole
     screen to the notes when the slide is not needed. The notes used to be
     a translucent 400 px sheet over the bottom third of the slide: the pen
     drew where the presenter could not see, and the slide's text bled
     through the talk.
  2. TOUCHES ON THE SHEET HAVE ONE OWNER: the ink layer. The console listens
     to not a single pointer event on `.pult-sheet`: the palm is not a
     gesture, there is no swipe on the sheet, a second finger drops nothing.
     The only finger gesture on the sheet is the two-finger tap, and the
     layer handles it itself, handing `onundo` over here.
  3. THE POINTER IS A PALETTE TOOL, in one row with the pen, the marker and
     the eraser. Pick up the pen and the pointer is released by itself, as in
     any note-taking app. The spring remains only where it is held
     physically: the L key and holding a rail key longer than 300 ms.
  4. THE WHOLE CONSOLE IS WITHOUT SELECTION AND WITHOUT SYSTEM GESTURES:
     `user-select: none` on the root, `touch-action: none` on the sheet with
     its margins. Text is selected only in a notes field, and there is a
     field only while preparing (no ink then, so no palm to fear); the
     reader is not selectable, it lies where a right hand's palm rests.

  LIGHT. The only source is the sheet. Everything else lives on the night
  body. The console DOES NOT FOLLOW THE ROOM'S THEME: a dark hall is a fact
  about the world, not a setting, and in the light theme (the OS default for
  most people) a person would get a white 1180×820 slab in their hands in a
  dark lecture hall. We borrow the theme through `borrowTheme`.

  THE CONSOLE DOES NOT WAIT FOR THE SERVER. It turns the page locally at once
  and shows the divergence from the projector with a pace ruler rather than
  by swapping the number: the number that arrives is the number being waited
  for.
-->
<script lang="ts">
  import { getLocale, tr } from '@shared/i18n'
  import type { PDFDocumentProxy } from 'pdfjs-dist'
  import { untrack } from 'svelte'
  import Icon from '@/components/ui/Icon.svelte'
  import { api } from '@/lib/api'
  import { OFFLINE_REASON } from '@/lib/controls'
  import { fullscreenNow, fullscreenPossible, goFullscreen, leaveFullscreen } from '@/lib/fullscreen'
  import { loadPdf } from '@/lib/pdf.svelte'
  import { acquirePage, releasePage } from '@/lib/pdf-pages'
  import { reloadByHand } from '@/lib/refusal'
  import { getSessionState } from '@/lib/session.svelte'
  import { borrowTheme } from '@/lib/theme.svelte'
  import { canKeepAwake, keepAwake, type WakeState } from '@/lib/wakelock'
  import { baseOf } from '@shared/paths'
  import InkLayer from './InkLayer.svelte'
  import LecturePage from './LecturePage.svelte'
  import NotesPad from './NotesPad.svelte'
  import NotesReader from './NotesReader.svelte'
  import { askInkPage, inkedPages } from './ink'
  import { budgetOf, firstLine, plannedSeconds } from './notes-script'
  import { slideTitle } from './slide-titles'
  import { boardsInked, INKS, stopwatch } from './pult'
  import { BLANK_KEYS, isClickerReload } from './remote'
  import {
    agoWords,
    clockOf,
    deviceOn,
    deviceWord,
    handheld,
    holderOf,
    lostHands,
    takeMessage,
    type Lost,
  } from './takeover'

  interface Props {
    /**
     * Leave for the room. Does NOT stop the lecture: leaving the console and
     * ending the lecture are different decisions, and the second deserves a
     * separate row with a confirmation.
     */
    onexit: () => void
  }

  let { onexit }: Props = $props()

  const session = getSessionState()

  /* ---------------------------------------------------- who we are here */

  const lecture = $derived(session.lecture)
  /** The right to the console is the host's. The key link may end up with a student. */
  const host = $derived(session.me.role === 'host')
  const leading = $derived(lecture !== null && lecture.by === session.me.id)
  /** ANOTHER teacher presents the lecture: we watch but do not control. */
  const watching = $derived(lecture !== null && !leading)
  const offline = $derived(!session.connected)
  /**
   * Who holds it while we watch: a colleague, or this very teacher in
   * another browser (the same staff account), and whether they are still
   * connected. The take-over sheet and the rail say it in those words.
   */
  const holder = $derived(lecture ? holderOf(lecture, session.person) : null)

  /**
   * The document notes are written for while there is no lecture.
   *
   * Notes are prepared the day before, and the right to them is "host", not
   * "presents the lecture". Preparation is the same layout, only nothing is
   * broadcast.
   */
  let prep = $state<string | null>(null)
  const preparing = $derived(lecture === null && prep !== null)
  /** The document on screen: the lecture's, or the one being prepared. */
  const file = $derived(lecture?.file ?? prep)
  /** Pages can be turned when the console is ours: in a lecture or in preparation. */
  const mayTurn = $derived(leading || preparing)

  /* --------------------------------------------------------- document */

  let doc = $state<PDFDocumentProxy | null>(null)
  let pages = $state(0)
  let failure = $state(false)
  /** Counter of open attempts: "Try again" restarts the effect. */
  let attempt = $state(0)

  /**
   * The PDF is opened HERE rather than taken from the room.
   *
   * The console is a separate app and lives on another device: there is no
   * reader and no tabs under it, and there would be nobody to ask for the
   * document.
   */
  $effect(() => {
    const path = file
    void attempt
    doc = null
    pages = 0
    failure = false
    if (!path) return
    let dropped = false
    let opened: PDFDocumentProxy | null = null
    void loadPdf()
      .then((pdf) => pdf.open(api.fileRaw(session.session.id, path), session.token))
      .then((ready) => {
        opened = ready
        if (dropped) {
          void ready.loadingTask.destroy()
          return
        }
        doc = ready
        pages = ready.numPages
      })
      .catch(() => {
        if (!dropped) failure = true
      })
    return () => {
      dropped = true
      void opened?.loadingTask.destroy()
    }
  })

  /* ---------------------------------------------------------------- page */

  /**
   * The page we want to show: our own, not the server's.
   *
   * The "Next" button must move the sheet in the same frame it was
   * pressed in: on the relay through the VPS the answer comes a hundred
   * milliseconds later, and a sheet waiting for that answer feels stuck. We
   * show the divergence (see `behind`) rather than hide it.
   */
  let wanted = $state(1)
  /** The projector has lagged longer than a human-scale delay. */
  let behind = $state(false)
  /** File whose page was already taken from the server. Not a rune: just for checks. */
  let settledFile: string | null = null

  $effect(() => {
    const path = file
    const at = lecture?.page ?? 1
    // A document change is the only reason to take the page from the
    // server: in everything else the owner of the number is here, on the
    // tablet.
    if (path !== settledFile) {
      settledFile = path
      wanted = at
      /*
       * The sheets this tab started belong to the previous document's
       * lecture. A document switch no longer passes through "no lecture"
       * (the server replaces it in one step), so nothing else would forget
       * them, and the new deck's strip would end in empty sheets of the old
       * one.
       */
      untrack(() => (boardsHere = 0))
    }
  })

  /**
   * Pages we managed to ask for before the projector caught up with us.
   *
   * Needed to tell OUR OWN echo on its way from SOMEONE ELSE'S move. Two
   * presses in a row ask for the seventh and the eighth; the echo of the
   * seventh arrives first, and without this list it would read as "someone
   * else took the page away". Not a rune: nobody draws it, it is only
   * checked against.
   */
  let askedPages = new Set<number>()
  /**
   * The page the server showed last time. Not a rune: only checked against.
   *
   * Without it "someone else's move" was defined as "the server's page is
   * not in the list of requested ones", and that is what it is right after
   * our own press too, until the echo returns: we ask for the seventh, the
   * server is still on the sixth, and we did not ask for the sixth. The
   * console obediently went back to the sixth, and a hundred milliseconds
   * later the echo of the seventh arrived and it went there "as if following
   * someone else's move". The number managed to blink there and back on
   * every press, the pace ruler never lit up, and without a connection
   * (where there is no echo at all) the sheet rolled back and stayed put,
   * that is, the console stopped turning pages altogether.
   *
   * Someone else's move is when the server's page CHANGED to one we did not
   * ask for. An unchanged server page means nothing except "the echo is
   * still on its way".
   */
  let seenPage: number | null = null

  /*
   * CONVERGING WITH THE PROJECTOR.
   *
   * The console and the audience must never diverge at all: the presenter
   * talks about the seventh page while the audience reads the sixth, and
   * people find out through a question from the hall, if they find out. So
   * divergence here is not a "state" one can wait out but a position with
   * exactly two exits, and both are chosen at once, by WHOSE page is on the
   * server.
   *
   * A page we did not ask for is someone else's: a second teacher is
   * turning pages, or the same person from the laptop. We follow immediately
   * and silently: the console has nothing to argue with against what the
   * audience already sees.
   *
   * The page is ours but on its way: we wait. After 600 ms we show the
   * divergence with the pace ruler (`behind`) and REPEAT the request: the
   * message may have been lost, and `lecture:page` is idempotent: a server
   * already on that page will simply stay silent. Instead of repeating, we
   * used to give up after 1200 ms and roll the sheet back to the server's
   * page. That honestly removed the divergence, but at the cost of the
   * intention: a presenter who had paged forward got the sheet back and
   * pressed again, not understanding why.
   */
  $effect(() => {
    const at = lecture?.page ?? null
    const mine = wanted
    // Whether the server's page has changed since the last pass. Computed
    // BEFORE all the branches: each of them is an answer to this question.
    const moved = untrack(() => {
      const changed = seenPage !== null && seenPage !== at
      seenPage = at
      return changed
    })
    if (at === null) {
      behind = false
      return
    }
    if (at === mine) {
      behind = false
      untrack(() => askedPages.clear())
      return
    }
    /*
     * Only the one turning pages can diverge. Someone watching another
     * teacher's lecture has nothing to catch up with: they have no page of
     * their own, only the server's.
     */
    if (!mayTurn) {
      behind = false
      // The effect reads `wanted` and writes it right here: without
      // `untrack` this is that very loop that brings the app down
      // (effect_update_depth_exceeded), as soon as `at !== wanted` lasts
      // longer than one repeat.
      untrack(() => (wanted = at))
      return
    }
    if (moved && !untrack(() => askedPages.has(at))) {
      // Someone else's move. Follow the audience at once, not a second or so later.
      behind = false
      untrack(() => {
        wanted = at
        askedPages.clear()
      })
      return
    }
    const late = window.setTimeout(() => (behind = true), 600)
    /*
     * Repeats are not forever. If five requests in a row changed nothing,
     * the problem is not a lost frame: the audience does not have the page
     * we are asking for. Then the console goes to the server's page, because
     * a divergence that lasts is worse than any intention, and it is exactly
     * what we promised would not happen.
     */
    let tries = 0
    const again = window.setInterval(() => {
      /*
       * Without a connection attempts are NOT COUNTED. They used to be, and
       * the counter spun by itself: not a single request went out, yet after
       * three seconds the console "gave up" and rolled the sheet back to the
       * server's page. A presenter who paged forward on a blinking Wi-Fi got
       * the number back without pressing anything.
       */
      if (!leading || offline) return
      tries += 1
      if (tries > 5) {
        wanted = at
        askedPages.clear()
        return
      }
      session.send({ t: 'lecture:page', page: mine })
    }, 600)
    return () => {
      window.clearTimeout(late)
      window.clearInterval(again)
    }
  })

  function goTo(next: number): void {
    if (!mayTurn) return
    /*
     * The upper bound when our own copy of the document did not open.
     *
     * `pages` is zero then, and there was no bound at all: the NEXT key
     * drove the audience's page numbers past the end of the deck: the
     * projector shows nothing, and the console does not even show that,
     * because it has nothing to show with. The audience, meanwhile, opened
     * its copy and knows where the end is; we do not. So a step is allowed
     * exactly one page past what the audience IS ALREADY showing: one can
     * page forward as far as one likes, but one press at a time and
     * following the server's confirmation, not as a queue of twenty pages
     * from a held button.
     */
    /*
     * The `Math.max(next, …)` here was a mistake and cancelled the bound
     * itself: it let through ANY `next`, including page nine hundred from a
     * held key. The bound is now what the paragraph above describes: one
     * page past the one the audience is already showing.
     */
    const top = pages > 0 ? pages : (lecture?.page ?? 1) + 1
    // A negative number is a blank sheet, and it is not forced into the document's bounds.
    const target = next < 0 ? next : Math.min(Math.max(1, next), top)
    if (target === wanted) return
    wanted = target
    askedPages.add(target)
    /*
     * WITHOUT A CONNECTION A PRESS DOES NOT GO INTO THE QUEUE, and that is
     * not a refusal to turn pages.
     *
     * The console's sheet is its own and moves here and now; the server
     * needs only the LAST number, and the convergence effect will deliver it
     * as soon as the connection returns. The queue, meanwhile, holds sixteen
     * messages, deduplicates by content and throws out old ones: ten presses
     * without a connection took ten places in it (pushing out the presses it
     * exists for), and then fired in a row, driving the projector through all
     * the intermediate pages. And each of them lit up "Offline", even though
     * the rail's red seam already speaks of the connection.
     */
    if (leading && !offline) session.send({ t: 'lecture:page', page: target })
  }

  /* --------------------------------------------------------- blank sheet */

  /**
   * A white field over the lecture.
   *
   * The thing most often missing in class: the slide ended, but the
   * derivation of the formula did not. Until now the teacher either wrote
   * over the slide, covering what the audience is still reading, or walked
   * off to the chalkboard, that is, stopped showing anything at all, and
   * half the audience cannot see that board.
   *
   * A sheet is a page with a negative number (see shared/lecture.ts), so
   * ink, the strip and "next" work on it by themselves. Every press starts a
   * NEW one: an inked sheet is not erased for the sake of the next; one
   * returns to it through the page strip, where started sheets stand behind
   * the notch after the last slide.
   */
  /** How many sheets THIS tab has started. Its own memory, and a short one. */
  let boardsHere = $state(0)
  /**
   * How many sheets have really been started.
   *
   * The tab's count is only half the answer. iPad Safari unloads background
   * tabs regularly, and going to the room and back restarts the console
   * too: after that `boardsHere` is zero, while the inked sheets have not
   * gone anywhere: they sit in the server's memory and arrive with the
   * welcome batch. While the count went only by the tab, a reload mid-class
   * removed the sheets from the page strip, the arrows could not reach them,
   * and "Sheet" opened an OLD sheet with ink under the label "new": instead
   * of a white field the presenter got their own earlier derivation.
   *
   * So the second source is the ink itself: a sheet with ink proves that it
   * was started (`boardsInked`). A blank sheet started and untouched by the
   * pen is known only to the tab, and that is exactly the case where losing
   * it is no pity.
   *
   * Counted by the INVENTORY, not by the ink on hand. The welcome batch no
   * longer has to carry all of the lecture's writing: it carries the current
   * page and the numbers of the other inked ones (`ink:pages`), while a
   * sheet's ink itself arrives when it is asked for, by the thumbnail strip
   * below. If the console counted by what it holds, after a reload it would
   * count zero sheets exactly where counting by ink was the whole point.
   */
  const boards = $derived.by(() => {
    // The inventory arrives together with the edit counter (ink.ts): without
    // it the strip would learn about it only with the next stroke.
    void session.inkRevision
    return Math.max(boardsHere, boardsInked(inkedPages(session)))
  })
  /** Where to return to from a sheet: the last slide we were on. */
  let lastSlide = $state(1)

  $effect(() => {
    const at = wanted
    untrack(() => {
      if (at > 0) lastSlide = at
      if (at < 0 && -at > boards) boardsHere = -at
    })
  })

  const onBoard = $derived(wanted < 0)

  function newBoard(): void {
    if (!mayTurn) return
    const next = boards + 1
    boardsHere = next
    goTo(-next)
  }

  function backToSlides(): void {
    goTo(lastSlide)
  }

  /**
   * A step forward or back: the only move that knows about the sheet
   * boundary.
   *
   * There is no page zero: between the last blank sheet and the slides there
   * is a boundary, and it must be crossed in the direction one came from:
   * "forward" from the LAST sheet returns to the slide it was started on,
   * not into emptiness. Back from the oldest sheet goes there too: in the
   * page strip the slides stand BEFORE the sheets, and a step against the
   * strip must lead to the same place the strip itself leads to.
   */
  function step(dir: -1 | 1): void {
    /*
     * On blank sheets a step goes IN ORDER OF CREATION, not by number.
     *
     * Sheet numbers are negative, and a naive "+1" took you from sheet 2 to
     * sheet 1, that is, BACKWARDS in time, while the page strip drew them
     * left to right from first to last. An arrow that drives the highlight
     * against the strip is an arrow nobody trusts. Forward past the last
     * sheet returns to the slide: there is nothing further, and a sheet must
     * not be started silently.
     */
    if (onBoard) {
      const at = -wanted
      const nextBoard = at + dir
      if (nextBoard < 1 || nextBoard > boards) {
        backToSlides()
        return
      }
      goTo(-nextBoard)
      return
    }
    const next = wanted + dir
    if (next === 0) {
      backToSlides()
      return
    }
    goTo(next)
  }

  /**
   * Forward from the last sheet returns to the deck, and the key says so.
   *
   * IN ORDER OF CREATION, the way `step` moves, not by number: the label was
   * left over from the old numbering (`wanted === -1`) and with two or more
   * sheets lied out loud: on Sheet 1 it promised "To slide 5", and the press
   * brought Sheet 2 up for the audience.
   */
  const forwardReturns = $derived(onBoard && -wanted === boards)

  function blank(on: boolean): void {
    if (!leading || offline) return
    session.send({ t: 'lecture:blank', on })
  }

  /* ----------------------------------------------------------------- tool */

  /*
   * FOUR COLOURS AND A MARKER. The set itself and the argument for why there
   * is no blue pen in it live in `./pult`: the lecture bar on the laptop
   * draws the same ink for the same audience, and there must be no second
   * copy of this list. A copy managed to drift apart once: here blue was
   * explained with measured numbers and removed, yet it stood as the third
   * circle and the pen's default.
   */
  /**
   * The marker is one colour, and that is a decision, not an unfinished job.
   *
   * A highlight must be lighter than the paper under the text, and there is
   * exactly one such colour. The transparency travels IN the colour itself
   * (eight digits), so that the stroke lands as one `stroke()` and the alpha
   * does not double at self-intersections. That is why a second tap on
   * "Marker" opens nothing: there is nothing to choose there.
   */
  const MARKER = '#ffd60a80'
  const MARKER_WIDTH = 0.022
  /**
   * Five pen thicknesses as fractions of the page width.
   *
   * There used to be three, and between "Fine" and "Medium" fitted all the
   * small formula work, while between "Medium" and "Thick" fitted every
   * heading: a step of one and a half times is too coarse to hit what you
   * need. The five steps go up by about √2 each: that is the step at which
   * neighbours are still distinguishable by eye, but one no longer has to
   * choose between "thin" and "too thick".
   *
   * The dot in the palette is now not a "shape" but a SCALE: its diameter is
   * the real stroke thickness on the sheet, converted into palette pixels.
   * Previously 4/6/10 drew the difference larger than it is, and what was
   * chosen in the palette did not match what landed on the paper.
   *
   * The middle names are kept: they are a contract with the interface check.
   */
  const WIDTHS = [
    { width: 0.0025, get name() { return tr('room.ui.236') } },
    { width: 0.0035, get name() { return tr('room.ui.237') } },
    { width: 0.005, get name() { return tr('room.ui.238') } },
    { width: 0.008, get name() { return tr('room.ui.239') } },
    { width: 0.012, get name() { return tr('room.ui.240') } },
  ]
  /**
   * The dot's diameter in the palette: a fraction of the page width times
   * the width of the console's sheet. The sheet on a tablet is about
   * 1084 px, so 0.005 gives the same 5–6 px as on paper: the palette shows
   * the stroke, not an icon of a stroke.
   */
  const dotOf = (width: number) => Math.max(3, Math.round(width * 1084))

  type Tool = 'pen' | 'marker' | 'eraser' | 'laser'

  /**
   * There is ONE tool, and the pointer is part of it. "Pen, black, medium"
   * on entry, and this is not stored: the tool is the state of the hand for
   * this class, not a setting.
   */
  let tool = $state<Tool>('pen')
  let inkColor = $state<string>(INKS[0].color)
  let penWidth = $state(WIDTHS[2].width)

  const strokeColor = $derived(tool === 'marker' ? MARKER : inkColor)
  const strokeWidth = $derived(tool === 'marker' ? MARKER_WIDTH : penWidth)

  /**
   * Any choice is an assignment. The pointer is released by itself: in
   * GoodNotes, Notability and Freeform the pointer is a tool just like the
   * pen, and picking up the pen puts it away. The old "pointer on top of the
   * chosen pen" scheme needed a separate switch-off and left a red dot
   * wandering across the projector.
   */
  function pick(next: Tool): void {
    tool = next
    palette = null
  }

  /*
   * A CHOICE DOES NOT CLOSE THE PALETTE.
   *
   * It used to: every press on a colour or a thickness hid it, and trying a
   * thicker blue meant opening it again twice. And that is exactly how
   * people try things: by fitting, looking at the sheet, not by choosing
   * blindly from memory. Four things close the palette, and all of them mean
   * "I'm done": a second tap on the pen, a tap elsewhere, Escape and the
   * first touch of the sheet (`busy`).
   */
  function penIn(color: string): void {
    tool = 'pen'
    inkColor = color
  }

  function penWide(width: number): void {
    tool = 'pen'
    penWidth = width
  }

  /**
   * THE PEN PALETTE pops up on a tap on the ALREADY ACTIVE pen, as in any
   * note-taking app: the first tap takes the tool, the second opens its
   * settings. It closes on a choice, a tap elsewhere, Escape and the very
   * first touch of the sheet (`busy`): a palette left hanging over a formula
   * is an extra object between the eye and what is being written.
   */
  /**
   * Which palette is open: the pen's, the pointer's or none.
   *
   * It was a `boolean` for the pen alone. The pointer now has something to
   * choose too (dot or line), and giving it a second flag would mean keeping
   * in one's head that they cannot both be open. One value makes this a rule
   * rather than an agreement.
   */
  let palette = $state<null | 'pen' | 'laser'>(null)

  function penKey(): void {
    if (tool === 'pen') palette = palette === 'pen' ? null : 'pen'
    else pick('pen')
  }

  /**
   * THE POINTER: DOT OR LINE.
   *
   * Two different gestures. With a line one circles ("this area"), and the
   * trail must stay while the circled thing is being talked about. With a
   * dot one points ("right here"), and then a trail gets in the way: in half
   * a minute of explanation the slide gets covered with a red web. The line
   * stays the default: the console started with it, and it is also needed
   * more often.
   */
  let laserShape = $state<'dot' | 'line'>('line')
  /** The same red InkLayer burns: the palette must show the real colour. */
  const LASER_RED = '#ff2b1d'

  /*
   * A second tap on the pointer opens ITS palette rather than bringing the
   * pen back.
   *
   * Just as with the pen: the first tap takes the tool, the second shows
   * what can be chosen for it. The second tap used to put the pointer out,
   * which was handy while there was nothing to choose; now it has two
   * shapes, and hiding them behind a third gesture would mean creating a
   * control nobody would ever discover. The pointer is put out the way the
   * eraser is: by picking up the pen.
   */
  function laserKey(): void {
    if (!leading || offline) return
    if (tool === 'laser') palette = palette === 'laser' ? null : 'laser'
    else pick('laser')
  }

  /**
   * THE POINTER SPRING is a temporary tool swap, not a mode.
   *
   * Hold the L key or the "Pointer" key on the rail longer than 300 ms, and
   * it shines; let go, and the previous tool is back. A tap shorter than
   * 300 ms is an ordinary tool choice. The argument about a forgotten
   * pointer has not gone away: while it is selected, the key glows as a slab
   * on the rail, a red dot lives on the sheet, and the very first pen
   * releases it.
   */
  let sprung = $state(false)
  const SPRING_MS = 300
  let springTimer: number | undefined
  /** The rail key is pressed and not yet released. */
  let laserKeyDown = false

  function laserDown(): void {
    if (!leading || offline) return
    laserKeyDown = true
    window.clearTimeout(springTimer)
    springTimer = window.setTimeout(() => {
      if (laserKeyDown) sprung = true
    }, SPRING_MS)
  }

  function laserUp(): void {
    if (!laserKeyDown) return
    laserKeyDown = false
    window.clearTimeout(springTimer)
    if (sprung) {
      sprung = false
      return
    }
    laserKey()
  }

  function laserCancel(): void {
    laserKeyDown = false
    window.clearTimeout(springTimer)
    sprung = false
  }

  /*
   * A dropped connection and losing the console release the pointer: there
   * is nowhere to shine, and a glowing key would then promise what it does
   * not do. We return to the pen, the tool one keeps working with even
   * without a connection.
   */
  $effect(() => {
    const alive = leading && !offline
    untrack(() => {
      if (alive) return
      laserCancel()
      if (tool === 'laser') tool = 'pen'
    })
  })

  /*
   * Undo and "erase page" only over a live connection.
   *
   * Without a connection a press goes into the queue: everything stays in
   * place on the sheet, the screen says "page cleared", and thirty seconds
   * later, when the Wi-Fi returns, the page really does get cleared, by
   * itself, with nobody doing it, in the middle of the next slide. Deferred
   * destruction is worse than a refusal.
   */
  function undoStroke(): void {
    if (!leading) return
    if (offline) {
      say(tr('room.ui.241'), 'refusal')
      return
    }
    session.send({ t: 'ink:undo', page: wanted })
  }

  function wipePage(): void {
    if (!leading) return
    if (offline) {
      say(tr('room.ui.242'), 'refusal')
      return
    }
    session.send({ t: 'ink:clear', page: wanted })
    say(tr('room.ui.243'))
  }

  /*
   * "Erase page" is a half-second hold of the eraser.
   *
   * The only protection that costs the right gesture nothing: pressing the
   * eraser key is a tool switch, while erasing a whole page in the middle of
   * a lecture is not something done in passing. There is no modal for it: it
   * would stand across the very thing it was opened for.
   */
  const HOLD_MS = 500
  let holdTimer: number | undefined
  let wiped = false
  /**
   * The eraser key is pressed and not yet released, like `laserKeyDown` for
   * the pointer.
   *
   * Without this flag `pointerup` fired WITHOUT its pair: the palm
   * interceptor swallows `pointerdown` but lets the lift through (otherwise
   * a hold could not be released), and the heel of the palm, landing on
   * "Eraser" mid-letter and lifting again, took the eraser: with the next
   * pen movement the teacher erased what had been written.
   */
  let eraserKeyDown = false

  function eraserDown(): void {
    wiped = false
    eraserKeyDown = true
    window.clearTimeout(holdTimer)
    holdTimer = window.setTimeout(() => {
      wiped = true
      wipePage()
    }, HOLD_MS)
  }

  function eraserUp(): void {
    window.clearTimeout(holdTimer)
    holdTimer = undefined
    if (!eraserKeyDown) return
    eraserKeyDown = false
    if (!wiped) pick('eraser')
    wiped = false
  }

  function eraserCancel(): void {
    window.clearTimeout(holdTimer)
    holdTimer = undefined
    eraserKeyDown = false
  }

  /* --------------------------------------------------------------- clock */

  /**
   * Ticks once a second, and only for the sake of two numbers in the
   * instrument.
   *
   * A second, not a frame: lecture clocks are read with the head raised, not
   * watched; redrawing the instrument sixty times a second for that means
   * waking the layout next to pen drawing.
   */
  let tick = $state(Date.now())
  $effect(() => {
    const id = window.setInterval(() => (tick = Date.now()), 1000)
    return () => window.clearInterval(id)
  })

  /** LECTURE time, not tab time: server timestamp, server clock correction. */
  const runningFor = $derived(
    lecture ? Math.max(0, tick - session.clockSkewMs - lecture.startedAt) : 0,
  )

  /*
   * The stopwatch comes from `./pult`, one copy for the console and for the
   * notes header. There were two, word for word, with the remark "same as in
   * the instrument": a remark is not how two functions in different files
   * are kept in agreement.
   */

  /*
   * The wall clock is assembled by hand, not with `toLocaleTimeString`: in a
   * lecture hall time is read in the twenty-four-hour form regardless of the
   * tablet's language, and "2:36 PM" under the page number takes twice as
   * long to read.
   */
  function hhmm(ms: number): string {
    const at = new Date(ms)
    return `${String(at.getHours()).padStart(2, '0')}:${String(at.getMinutes()).padStart(2, '0')}`
  }

  const wall = $derived(hhmm(tick))

  /**
   * When the console arrived on the page it shows: "0:48 on this slide".
   *
   * Local, not the server's. "How long have I been on this slide" is a
   * question about this hand and this sheet, and it is asked against the
   * slide's budget in the note (`*≈ 1.2 мин*`): a slide turned back to
   * starts its count again, as a slide reached for the first time does.
   */
  let pageSince = $state(Date.now())
  $effect(() => {
    void wanted
    pageSince = Date.now()
  })
  const onPageFor = $derived(Math.max(0, tick - pageSince))

  /* --------------------------------------------------------------- layout */

  let root = $state<HTMLDivElement | null>(null)
  let box = $state({ w: 0, h: 0 })

  /**
   * The orientation is read by a size observer, not by a media query.
   *
   * On iPadOS the window changes size continuously (Split View, windowed
   * multitasking), `orientationchange` arrives before the layout settles,
   * and "portrait" is not a rotation but the window's proportions. The
   * observer answers the question we are actually asking.
   */
  $effect(() => {
    const node = root
    if (!node) return
    let seen = { w: 0, h: 0 }
    const measure = (): void => {
      const rect = node.getBoundingClientRect()
      const next = { w: Math.round(rect.width), h: Math.round(rect.height) }
      if (next.w === seen.w && next.h === seen.h) return
      seen = next
      box = next
    }
    measure()
    const watch = new ResizeObserver(measure)
    watch.observe(node)
    return () => watch.disconnect()
  })

  /**
   * Two layouts of one logic, not "wide and a degradation". Portrait: the
   * rail at the bottom under the thumb of the holding hand, the notes docked
   * under the sheet; landscape: the rail on the side, the notes slide out.
   * There is no "wide" threshold anymore: it was a measure of one 1180×820
   * screen, while people have tablets of three sizes and two orientations.
   */
  const portrait = $derived(box.h > box.w)
  /** Slide Over: the console stays alive but stops being a console. */
  const tiny = $derived(box.w > 0 && box.w < 420)

  /**
   * HOW MUCH THE RAIL HAS TO GIVE UP TO FIT, measured along it: the window's
   * height in landscape, its width in portrait.
   *
   * The rail was a column of fixed keys about 816 px long, and the only
   * flexible thing in it was a spacer. Full screen is now only on request, so
   * an 11" iPad in ordinary Safari gives 746 px (706 with the tab bar), and
   * the 96 px "Next" key sat half below the edge, the key pressed most in a
   * lecture. iPad mini cut it even in full screen, and Split View cut "Back"
   * too. Three steps instead of one size:
   *
   *  · roomy (≥ 800): the drawn sizes, 52–56 px keys and a 96 px "Next";
   *  · compact (≥ 690): 44 px keys, an 80 px "Next", narrower notches;
   *  · tight: "Undo" leaves the rail (two fingers on the sheet and Z still
   *    undo), and in portrait "Sheet" and the fader move into "More".
   *
   * Page turning is never what gives way: "Back" and "Next" sit in a
   * footer that does not shrink, and only the middle of the rail may clip.
   */
  const fit = $derived.by((): 'roomy' | 'compact' | 'tight' => {
    const along = portrait ? box.w : box.h
    if (along === 0 || along >= 800) return 'roomy'
    return along >= 690 ? 'compact' : 'tight'
  })

  const HAND_KEY = 'colloq.pult.hand'
  const NOTES_KEY = 'colloq.pult.notes'
  const LAMP_KEY = 'colloq.pult.lamp'
  const FINGER_KEY = 'colloq.pult.finger'
  const VIEW_KEY = 'colloq.pult.view'
  const SPLIT_KEY = 'colloq.pult.split'
  /* The same key as the laptop editor's size: one choice per device. */
  const SIZE_KEY = 'colloq.pult.notesSize'
  const TELE_SIZE_KEY = 'colloq.pult.teleSize'

  function remembered(key: string): string | null {
    try {
      return localStorage.getItem(key)
    } catch {
      // Private browsing throws even on reads: the default will do as well.
      return null
    }
  }

  function remember(key: string, value: string): void {
    try {
      localStorage.setItem(key, value)
    } catch {
      // Not remembered: the setting still works for this class.
    }
  }

  /** Left-handed: the whole rail moves to the right edge, palette included. */
  let hand = $state<'right' | 'left'>(remembered(HAND_KEY) === 'left' ? 'left' : 'right')

  function setHand(next: 'right' | 'left'): void {
    hand = next
    remember(HAND_KEY, next)
  }

  /**
   * Whether the notes column is open (landscape). The key is the old
   * sheet's: `folded` means the person put the notes away, anything else is
   * open.
   *
   * The default is OPEN now, and it used to be closed for a reason that no
   * longer exists: the notes were a sheet over the bottom third of the
   * slide, and open on entry it hid what the console was opened for. The
   * column takes width from the slide instead of covering it, so a first
   * lecture starts with the talk in sight, and a person who wants the slide
   * at full width folds it once and the console remembers.
   */
  let notesOpen = $state(remembered(NOTES_KEY) !== 'folded')

  function setNotes(open: boolean): void {
    notesOpen = open
    remember(NOTES_KEY, open ? 'open' : 'folded')
  }

  /**
   * THE PROMPTER: the whole screen for the notes, no slide and no pen.
   *
   * For the lecture given from the laptop at the projector, or one where
   * the slides change rarely and the talk is long: the tablet becomes a
   * prompter at 28–40 px, with the current slide as a thumbnail and the next
   * one in words. Remembered per device: a person who presents this way
   * presents this way every time, and the "Slide" key is the first thing on
   * the rail.
   */
  let view = $state<'slide' | 'tele'>(remembered(VIEW_KEY) === 'tele' ? 'tele' : 'slide')
  const tele = $derived(view === 'tele')

  function setView(next: 'slide' | 'tele'): void {
    view = next
    palette = null
    remember(VIEW_KEY, next)
  }

  /*
   * NOTE SIZES, A− and A+, remembered per device. Two ladders: the column
   * and the portrait dock read at 18/22/28 (22 is a real paragraph at the
   * column's measure), the prompter at 22–40, read from arm's length.
   */
  const NOTE_SIZES = [18, 22, 28] as const
  const TELE_SIZES = [22, 28, 34, 40] as const

  function stepFrom(raw: string | null, count: number, fallback: number): number {
    const value = raw === null ? fallback : Number.parseInt(raw, 10)
    return Number.isInteger(value) && value >= 0 && value < count ? value : fallback
  }

  let noteStep = $state(stepFrom(remembered(SIZE_KEY), NOTE_SIZES.length, 1))
  let teleStep = $state(stepFrom(remembered(TELE_SIZE_KEY), TELE_SIZES.length, 1))
  const noteSize = $derived(NOTE_SIZES[noteStep])
  const teleSize = $derived(TELE_SIZES[teleStep])

  function resize(delta: -1 | 1): void {
    if (tele) {
      teleStep = Math.max(0, Math.min(TELE_SIZES.length - 1, teleStep + delta))
      remember(TELE_SIZE_KEY, String(teleStep))
    } else {
      noteStep = Math.max(0, Math.min(NOTE_SIZES.length - 1, noteStep + delta))
      remember(SIZE_KEY, String(noteStep))
    }
  }

  /**
   * DRAW WITH A FINGER. The default is yes: someone who opened the console
   * without a Pencil otherwise has no way to put a single line on a slide.
   * The very first pen on this screen turns the finger off (`onpen` from the
   * ink layer) and says so in a toast: from that moment a finger on the
   * sheet is the palm, not a tool. A row in "More" brings it back if the
   * Pencil dies mid-class.
   */
  let fingerOn = $state(remembered(FINGER_KEY) !== 'off')

  function setFinger(on: boolean): void {
    fingerOn = on
    remember(FINGER_KEY, on ? 'on' : 'off')
  }

  function penFound(): void {
    if (!fingerOn) return
    setFinger(false)
    say(tr('room.ui.244'))
  }

  /* -------------------------------------------------------------- fader */

  /**
   * THE SHEET FADER, the control of the only light source on this screen.
   *
   * The sheet is the console's only bright spot, and in a dark lecture hall
   * in the second half of a class it blinds: 1084×610 of white in one's
   * hands while the hall sits in the dark. Going to the system brightness
   * for this is not an option: it also dims the notes, which are exactly
   * what needs reading, and it costs three touches in Control Centre.
   *
   * Three detents, not a cycling button: a fader always shows its current
   * position. It works as a veil OVER the sheet and the ink, and does not
   * touch the rail, the notes or the projector at all: the audience sees its
   * projection as it did.
   */
  const LAMPS = [
    { get name() { return tr('room.ui.245') }, veil: 0, bar: 4 },
    { get name() { return tr('room.ui.246') }, veil: 0.28, bar: 9 },
    { get name() { return tr('room.ui.247') }, veil: 0.55, bar: 14 },
  ]
  /*
   * The default is "Room light": full light in a dark lecture hall is of no
   * use to anyone.
   *
   * An empty storage is read EXPLICITLY, not through `Number(null)`: zero is
   * "full light", that is, exactly the step the fader was introduced to get
   * away from, and the first launch would hand it to everyone.
   */
  const LAMP_STORED = remembered(LAMP_KEY)
  let lamp = $state(
    LAMP_STORED !== null && LAMPS[Number(LAMP_STORED)] !== undefined ? Number(LAMP_STORED) : 1,
  )
  const veil = $derived(LAMPS[lamp].veil)

  function setLamp(next: number): void {
    lamp = next
    remember(LAMP_KEY, String(next))
  }

  /**
   * A finger sliding across the fader sets the detent it is over, as on a
   * real fader: the cells are 17–22 px wide, and a press that lands between
   * two of them is corrected by moving, not by lifting and aiming again.
   *
   * The press stops here: on the bottom rail a horizontal drag of 48 px is a
   * page swipe (`swipe` above), and adjusting the light must not turn the
   * audience's page.
   */
  function faderSlide(node: HTMLElement) {
    let held: number | null = null
    const detentAt = (x: number): number | null => {
      for (const cell of node.querySelectorAll<HTMLElement>('[data-lamp]')) {
        const r = cell.getBoundingClientRect()
        if (x >= r.left && x < r.right) return Number(cell.dataset.lamp)
      }
      return null
    }
    const press = (event: PointerEvent): void => {
      event.stopPropagation()
      if (event.pointerType === 'mouse') return
      held = event.pointerId
      /*
       * The detent is set on the press itself: with the pointer captured by
       * the group, the lift's `click` goes to the group, not to the cell
       * under the finger. The cells' own `onclick` stays for the mouse, the
       * keyboard and VoiceOver.
       */
      const at = detentAt(event.clientX)
      if (at !== null && at !== lamp) setLamp(at)
      node.setPointerCapture?.(event.pointerId)
    }
    const slide = (event: PointerEvent): void => {
      if (held !== event.pointerId) return
      const at = detentAt(event.clientX)
      if (at !== null && at !== lamp) setLamp(at)
    }
    const release = (event: PointerEvent): void => {
      if (held === event.pointerId) held = null
    }
    node.addEventListener('pointerdown', press)
    node.addEventListener('pointermove', slide)
    node.addEventListener('pointerup', release)
    node.addEventListener('pointercancel', release)
    return {
      destroy() {
        node.removeEventListener('pointerdown', press)
        node.removeEventListener('pointermove', slide)
        node.removeEventListener('pointerup', release)
        node.removeEventListener('pointercancel', release)
      },
    }
  }

  /* -------------------------------------------------------------- sheets */

  /**
   * What is raised from below over everything. One sheet at a time: two is
   * already an interface, not a console. While such a sheet is open, the pen
   * does not draw on the slide: the sheet covers the sheet.
   */
  let pane = $state<'pages' | 'more' | 'grab' | 'files' | null>(null)
  /** The "erase page" confirmation: inside the row of the "More" sheet. */
  let wipeAsked = $state(false)
  /** The "end lecture" confirmation: in the same place, as the last row. */
  let stopAsked = $state(false)
  /**
   * The document the running lecture is asked to switch to, before
   * confirmation.
   *
   * Switching the document on the server is a NEW lecture: page one, every
   * last stroke of ink gone, the clock restarted, and there is nothing to
   * restore them with. A file row in the sheet is an 88 px button, and one
   * stray touch made "to see which file is running" took forty minutes of
   * annotation away from the whole audience. The neighbouring destructive
   * actions ("Erase page", "End lecture") ask; this one did not.
   */
  let switchTo = $state<string | null>(null)

  function openPane(next: typeof pane): void {
    pane = next
    palette = null
    wipeAsked = false
    stopAsked = false
    switchTo = null
  }

  /* ------------------------------------------------------- pen and palm */

  /** The ink layer holds the pointer: a stroke, an erase, or the laser is shining. */
  let busy = $state(false)
  let lastBusyAt = 0
  /*
   * There is no "notes have focus" flag anymore: on the console the notes
   * are nailed down, there is no input field there at all, and nothing is
   * left to switch the pen off for. The talk is edited on the laptop, where
   * it belongs; see `readonly` in NotesPad.
   */

  const paneOpen = $derived(pane !== null)
  /**
   * The notes do NOT change `canDraw`: they lie beside the paper, never on
   * it. Only a sheet raised over everything (`paneOpen`) switches the pen
   * off, and the prompter, which shows no paper at all.
   */
  const canDraw = $derived(leading && !failure && !paneOpen && !tele)
  /** What the ink layer is busy with right now. The spring swaps the tool for a while. */
  const liveTool = $derived(!canDraw ? 'off' : sprung ? 'laser' : tool)

  function onbusy(next: boolean): void {
    busy = next
    if (!next) lastBusyAt = performance.now()
    // The first touch of the sheet closes the palette: its job is done.
    else palette = null
  }

  /**
   * A palm resting on the rail.
   *
   * The ink layer ignores a palm on the sheet itself; the rail buttons do
   * not. A left-hander rests the hand at the top right, exactly where "Pen"
   * lives. So an interceptor sits on the console's root: while the pen is
   * busy or was released less than 600 ms ago, finger touches do not reach
   * the RAIL KEYS.
   *
   * 600 ms is a heuristic: shorter, and the palm has time to press
   * "Pointer"; longer, and the thumb stops working right after a word is
   * finished.
   *
   * ONLY `pointerdown` and `click` are swallowed; `pointerup` and
   * `pointercancel` always pass, otherwise a key with a hold (eraser,
   * pointer) would stay pressed with no lift and erase the page on a timer.
   * `preventDefault` on `pointerdown` does NOT cancel the following `click`,
   * so the interceptor remembers the pointer: a press belongs to the touch
   * as a whole, and a swallowed touch is swallowed to the end, its `click`
   * included.
   *
   * THE SECOND RULE IS BY CONTACT SIZE, and it applies to the whole console,
   * not just the rail: a touch 40 px wide or more is the heel of the palm,
   * and it presses nothing. A fingertip on glass is 15–20 px, the heel
   * 40–60. The first rule is silent until the pen has touched the sheet,
   * while the heel lands 100–300 ms BEFORE the tip, right on "Next"
   * (right-handed) or on "Pointer" (left-handed, rail on the right), and on
   * the notes field in portrait, where it moved focus into the textarea and
   * raised the keyboard mid-sentence. The browser does not report the size
   * everywhere (older WebKit gives 1×1), so this is a second lock, not a
   * replacement for the first.
   */
  const PALM_MS = 600
  const PALM_PX = 40

  $effect(() => {
    const node = root
    if (!node) return
    const swallowed = new Set<number>()
    const watch = (event: Event): void => {
      const pointer = event as PointerEvent
      if (!('pointerType' in pointer) || pointer.pointerType !== 'touch') return
      const id = pointer.pointerId
      const known = swallowed.has(id)
      const heel =
        event.type === 'pointerdown' && (pointer.width >= PALM_PX || pointer.height >= PALM_PX)
      /*
       * The rail, and everything marked `data-pult-guard`: the reading strip
       * under the slide and the notes column beside it. Both lie where the
       * writing hand's palm goes (under the slide's bottom edge, to the right
       * of a right-hander's pen), and both have something to press.
       */
      const onRail = !!(event.target as Element | null)?.closest('.pult-rail, [data-pult-guard]')
      if (!known && !heel && !(onRail && (busy || performance.now() - lastBusyAt < PALM_MS))) return
      if (event.type === 'pointerdown') {
        swallowed.add(id)
        // `click` comes after `pointerup`, and we do not touch `pointerup`:
        // we forget the pointer on a timer long enough for any tap.
        setTimeout(() => swallowed.delete(id), 1500)
      }
      event.stopPropagation()
      if (event.cancelable) event.preventDefault()
    }
    node.addEventListener('pointerdown', watch, true)
    node.addEventListener('click', watch, true)
    return () => {
      node.removeEventListener('pointerdown', watch, true)
      node.removeEventListener('click', watch, true)
    }
  })

  /**
   * The palette closes on the FIRST touch outside it, and the touch carries
   * on.
   *
   * There used to be a backdrop button under the palette across the whole
   * console, on top of the input layer: the first stroke went into the
   * backdrop and was not drawn, and the palette itself stayed open: the pen,
   * starting on the backdrop, lifted on the sheet, and `click` never came.
   * Now there is no backdrop: we listen to `pointerdown` on the root in the
   * capture phase, close the palette and do NOT stop the event, as in
   * GoodNotes, where the popup goes away and the stroke goes on. A touch on
   * the palette itself and on the "Pen" key (which toggles the palette) does
   * not count.
   */
  $effect(() => {
    const node = root
    if (!node) return
    const away = (event: Event): void => {
      if (palette === null) return
      const target = event.target as Element | null
      if (target?.closest('[data-pult-palette], [data-pult-tool]')) return
      palette = null
    }
    node.addEventListener('pointerdown', away, true)
    return () => node.removeEventListener('pointerdown', away, true)
  })

  /**
   * Pinch and double tap are suppressed at the console's root, not on the
   * document.
   *
   * WebKit's `gesture*` events are the only way to switch off page zoom in
   * Safari, and it must be switched off ONLY here: in the notebook and the
   * reader people need the pinch. The console shows exactly what the
   * audience sees; drawing on a magnified piece means not knowing where the
   * stroke will land on the projector.
   */
  $effect(() => {
    const node = root
    if (!node) return
    const stop = (event: Event): void => event.preventDefault()
    const names = ['gesturestart', 'gesturechange', 'gestureend']
    for (const name of names) node.addEventListener(name, stop)
    return () => {
      for (const name of names) node.removeEventListener(name, stop)
    }
  })

  /**
   * SWIPING PAGES IS ON THE RAIL, not on the sheet.
   *
   * The swipe on the sheet was removed entirely: the palm of the writing
   * hand arrives as an ordinary `touch` and travels with the hand exactly
   * those 64 px, and the slide flipped mid-formula for the whole audience.
   * The palm does not touch the rail, and the thumb rests on it anyway.
   * A key under the finger is not pressed after a shift of more than 12 px:
   * its `click` is swallowed on lift.
   *
   * ALONG THE RAIL, NOT ACROSS IT. The swipe used to be measured across:
   * horizontal on the 72 px side rail, vertical on the 64 px bottom one,
   * with a 64 px threshold and the lift required inside the rail. The
   * longest movement possible was the rail's own thickness, so on the stand
   * a swipe turned the page only edge to edge in landscape and never in
   * portrait. Now it runs along the rail's long side: vertical on the side
   * rail (up is forward), horizontal on the bottom one (left is forward).
   * The lift-inside-the-rail check then costs nothing and still stops a
   * palm carried from the rail onto the sheet.
   */
  const SWIPE_MIN = 48
  const SWIPE_SLOP = 12

  function swipe(node: HTMLElement, axis: () => 'x' | 'y') {
    let start: { id: number; x: number; y: number } | null = null
    let moved = false
    /** When the moved finger lifted: only the click that lift produces is swallowed. */
    let liftedAt = 0
    const down = (event: PointerEvent): void => {
      /*
       * Any new press forgets the last swipe, a pen's or a mouse's included.
       * A finger that moved lifts WITHOUT a click, so `moved` used to stay
       * set until the next click came, and that click was a Pencil tap on
       * "Notes" or "Next" a minute later, swallowed for no visible reason.
       */
      if (start === null) moved = false
      if (event.pointerType !== 'touch' || start !== null) return
      start = { id: event.pointerId, x: event.clientX, y: event.clientY }
    }
    const move = (event: PointerEvent): void => {
      if (!start || start.id !== event.pointerId) return
      const d = axis() === 'x' ? event.clientX - start.x : event.clientY - start.y
      if (Math.abs(d) > SWIPE_SLOP) moved = true
    }
    const up = (event: PointerEvent): void => {
      if (!start || start.id !== event.pointerId) return
      const along = axis() === 'x' ? event.clientX - start.x : event.clientY - start.y
      const across = axis() === 'x' ? event.clientY - start.y : event.clientX - start.x
      start = null
      liftedAt = performance.now()
      if (event.type === 'pointercancel') return
      /*
       * The lift must also be on the rail, and the pen must not be in play
       * at that moment. A touch started on the rail and carried onto the
       * sheet is a left-hander's palm that landed on the right rail and moved
       * with the hand: a long enough drift reads as a swipe, and the
       * audience's page turned mid-formula.
       */
      const under = document.elementFromPoint(event.clientX, event.clientY)
      if (!under || !node.contains(under)) return
      if (busy) return
      if (Math.abs(along) >= SWIPE_MIN && Math.abs(along) > Math.abs(across) * 1.6) {
        // Up (side rail) or left (bottom rail) means forward: the deck is
        // pushed along the rail, as a page strip is.
        if (mayTurn) step(along < 0 ? 1 : -1)
      }
    }
    const click = (event: Event): void => {
      if (!moved) return
      moved = false
      if (performance.now() - liftedAt > 500) return
      event.stopPropagation()
      event.preventDefault()
    }
    node.addEventListener('pointerdown', down)
    node.addEventListener('pointermove', move)
    node.addEventListener('pointerup', up)
    node.addEventListener('pointercancel', up)
    node.addEventListener('click', click, true)
    return {
      destroy() {
        node.removeEventListener('pointerdown', down)
        node.removeEventListener('pointermove', move)
        node.removeEventListener('pointerup', up)
        node.removeEventListener('pointercancel', up)
        node.removeEventListener('click', click, true)
      },
    }
  }

  /* ------------------------------------------------ full screen and sleep */

  let full = $state(false)

  $effect(() => {
    const sync = (): void => {
      full = fullscreenNow()
    }
    sync()
    document.addEventListener('fullscreenchange', sync)
    document.addEventListener('webkitfullscreenchange', sync)
    return () => {
      document.removeEventListener('fullscreenchange', sync)
      document.removeEventListener('webkitfullscreenchange', sync)
    }
  })

  function toggleFullscreen(): void {
    if (full) void leaveFullscreen()
    else if (root) void goFullscreen(root)
  }

  /**
   * FULL SCREEN ONLY ON REQUEST.
   *
   * The console used to expand by itself: "Present" and "Take control"
   * requested full screen with the same live gesture, and someone arriving
   * by the key link was shown a "touch to take the console" backdrop solely
   * to get a gesture and expand. That is, a person who opened the console to
   * look, fix notes or prepare for class ended up every time on a screen
   * without an address bar and had to leave it by hand.
   *
   * Now only the "Fullscreen" key expands it: in the notes header (the
   * column in landscape, the dock in portrait) and in the "More" sheet, the
   * one place it can always be reached from. Never on the sheet itself: in
   * its corner the key covered the notes peek and sat in the portrait
   * armrest, where the writing palm lands. There is no first-touch backdrop
   * at all.
   */

  /**
   * The screen does not go dark while the console is at work.
   *
   * iPad's auto-lock defaults to two minutes, and a teacher talks longer.
   * The lock is released by itself as soon as the tab goes to the
   * background, and does not come back: reacquiring lives inside
   * `keepAwake`.
   */
  let wake = $state<WakeState | null>(null)
  const awakeWanted = $derived(leading || preparing)

  $effect(() => {
    if (!awakeWanted) {
      wake = null
      return
    }
    const release = keepAwake((next) => (wake = next))
    return () => {
      release()
    }
  })

  /** Silence is not an option here: this happens at every lecture. */
  const mayGoDark = $derived(
    awakeWanted && (!canKeepAwake() || wake === 'refused' || wake === 'unavailable'),
  )

  const AUTOLOCK = $derived(tr('room.ui.250'))
  /**
   * Guided Access is the only thing that removes the "home" gesture and the
   * pull-down panels from iPad, and without it a palm that slid to the
   * bottom edge minimises the console mid-lecture. This is a device setting,
   * and the console can only mention it.
   */
  const GUIDED =
    tr('room.ui.251')

  /*
   * The console is always dark, and that is not taste but the physics of the
   * lecture hall: see borrowTheme. The person's theme is not touched: they
   * will return to the room with their own.
   */
  $effect(() => {
    /*
     * `untrack` is mandatory here, and not out of caution.
     *
     * `borrowTheme` reads the current theme to return it later, and writes
     * the new one. An effect reading and writing one rune subscribes to
     * itself: Svelte dutifully spins it until effect_update_depth_exceeded,
     * after which the whole app falls over. On the console this looks like
     * "no connection and no documents" mid-lecture, and from that picture
     * the cause cannot be found.
     */
    const release = untrack(() => borrowTheme('dark'))
    return release
  })

  /* ------------------------------------------------------------- toast */

  /**
   * One line for six seconds, instead of a modal.
   *
   * It lives in the bottom left corner of the sheet, not as a white banner
   * from the bottom: `bg-ink text-canvas` on the dark branch is a light
   * #E6E7E8 chip flashing for six seconds in a dark hall.
   */
  let notice = $state<string | null>(null)
  let noticeKind = $state<'note' | 'refusal'>('note')
  let noticeTimer: number | undefined

  function say(text: string, kind: 'note' | 'refusal' = 'note'): void {
    notice = text
    noticeKind = kind
    window.clearTimeout(noticeTimer)
    noticeTimer = window.setTimeout(() => (notice = null), 6000)
  }

  /*
   * A server refusal, in the same line as everything else.
   *
   * The room's common banner is not drawn on the console (see
   * SessionScreen): it speaks English and brings a cross that on a tablet
   * gets pressed by a palm. But a refusal must not go unsaid: "Only the
   * teacher may take over the presenter controls." is an answer to a press,
   * and without it the press looks broken. We take the message for ourselves
   * and dismiss it in the room.
   *
   * Two exceptions, and both are about the toast being an answer to a press,
   * not a diagnosis. The end of work (the room is gone, the key expired)
   * speaks through a screen: six seconds of English followed by a dead
   * console with no explanation are worse than silence. And
   * `OFFLINE_REASON` is the room's common phrase about Run and the kernel.
   *
   * Its words are honest now. "The press did not go out" was untrue: what
   * lands here sits in the control queue and will go as soon as the
   * connection returns, and a person who read "did not go out" presses
   * again. Page turns and destructive presses no longer land here at all:
   * the first moves the sheet locally and is delivered by convergence, the
   * second refuses in its own words.
   */
  const OFF_LINE = $derived(tr('room.ui.252'))
  $effect(() => {
    const trouble = session.lastError
    if (!trouble) return
    untrack(() => {
      session.dismissError()
      if (session.gone || session.expired) return
      say(trouble === OFFLINE_REASON || trouble === tr(OFFLINE_REASON) ? OFF_LINE : tr(trouble), 'refusal')
    })
  })

  let hadLecture = false
  $effect(() => {
    const live = lecture !== null
    if (hadLecture && !live) {
      // Ended by us or by someone else, it makes no difference to the screen:
      // the console returns to the document picker and says so in one line.
      prep = null
      say(tr('room.ui.253'))
    }
    hadLecture = live
  })

  /*
   * Screen sleep is mentioned ONCE, in a toast. After that the note lives as
   * text in "More".
   */
  let darkTold = false
  $effect(() => {
    const dark = mayGoDark
    untrack(() => {
      if (!dark || darkTold) return
      darkTold = true
      say(tr('room.ui.254'), 'refusal')
    })
  })

  $effect(() => () => {
    window.clearTimeout(noticeTimer)
    window.clearTimeout(holdTimer)
    window.clearTimeout(springTimer)
  })

  /* ------------------------------------------------------------ lecture */

  const slides = $derived(
    session.files
      .filter((entry) => !entry.dir && entry.path.toLowerCase().endsWith('.pdf'))
      .sort((a, b) => b.modifiedAt - a.modifiedAt),
  )

  /**
   * Start a lecture, and with the same live press ask for full screen.
   *
   * Full screen is granted only from a person's gesture: a call from an
   * effect after navigation is silently rejected by the browser.
   */
  function start(path: string): void {
    session.send({ t: 'lecture:start', file: path, device: session.device() })
    if (preparing && wanted > 1) session.send({ t: 'lecture:page', page: wanted })
    /*
     * `prep` is kept until the server answers.
     *
     * Clearing it here leaves the console without a file for an instant, and
     * it draws the document picker over what the person has just chosen. On
     * the relay through the VPS that instant stretches to a second, and on a
     * broken connection to forever: the press went into the queue, while the
     * screen shows the list of files as if nothing had been pressed. The
     * lecture's arrival clears it.
     */
    prep = path
    pane = null
  }

  function grab(): void {
    if (!lecture) return
    /*
     * Now or never, like "End": a take-over queued without a connection used
     * to reach the server after the lecture had ended and start a new one
     * for the whole hall, or take the console from whoever took it in
     * between. The message names the lecture and the holder it was pressed
     * against (takeover.ts · takeMessage), and it is never queued.
     */
    if (offline) {
      openPane(null)
      say(tr('room.takeover.offline'), 'refusal')
      return
    }
    session.send(takeMessage(lecture, session.device()))
    lost = null
    pane = null
  }

  /*
   * THIS CONSOLE WAS TAKEN OVER (takeover.ts · lostHands).
   *
   * On the next frame the pen, the marker, the eraser and Undo used to
   * vanish from the rail without a word, mid-stroke, and the presenter
   * decided the tablet had broken. Now a notice says who took it, from
   * where and when, and offers it back. Read from the state, not a message
   * of its own, so an iPad that slept through the take-over says so when it
   * wakes.
   */
  let lost = $state<Lost | null>(null)
  let seen: typeof lecture = null
  $effect(() => {
    const next = lecture
    untrack(() => {
      const gone = lostHands(seen, next, session.me.id, session.person)
      if (gone) {
        lost = gone
        openPane(null)
      } else if (next === null || next.by === session.me.id) {
        lost = null
      }
      seen = next
    })
  })
  const lostMeta = $derived.by(() => {
    if (lost === null) return ''
    const where = deviceWord(lost.device)
    const who = lost.self ? (where ?? lost.name) : where ? `${lost.name} · ${where}` : lost.name
    return `${who} · ${clockOf(lost.at, session.clockSkewMs, getLocale())}`
  })

  /**
   * The words of the take-over sheet: oneself on another device, a holder
   * who is gone (and for how long), or a colleague at work.
   */
  const grabWords = $derived.by(() => {
    if (!lecture || !holder) return ''
    if (holder.self) return tr('room.takeover.grabSelf', { on: deviceOn(holder.device) })
    if (holder.awaySince !== null) {
      const gone = Math.max(0, Date.now() - session.clockSkewMs - holder.awaySince)
      return tr('room.takeover.grabAway', { name: lecture.byName, ago: agoWords(gone) })
    }
    return `${tr('room.ui.208')} ${lecture.byName}${tr('room.ui.209')}`
  })

  function stop(): void {
    /*
     * The same argument as for "Undo" and "Erase page": without a connection
     * the press goes into the queue, the screen says "Lecture ended", and
     * half a minute later, when the Wi-Fi returns, it really does end, by
     * itself, with nobody doing it, in the middle of the next slide, taking
     * the ink of every page with it. Deferred destruction is worse than a
     * refusal.
     */
    if (offline) {
      // Close the sheet: the toast lives on the lecture sheet, and under a
      // raised one it cannot be seen.
      openPane(null)
      say(tr('room.ui.255'), 'refusal')
      return
    }
    session.send({ t: 'lecture:stop' })
    pane = null
  }

  /* ---------------------------------------------------------- page strip */

  /**
   * A 160×90 thumbnail, not 120×68.
   *
   * 120 px wide is below the threshold of recognising a slide: in such a
   * picture only coloured blotches can be made out, and an unrecognisable
   * picture is worse than none. The price is named out loud: every
   * thumbnail is now 1.76 times more expensive, and the ±4 render window has
   * to be kept all the stricter.
   */
  const THUMB_W = 160
  const THUMB_H = 90
  const THUMB_STEP = THUMB_W + 8

  let strip = $state<HTMLDivElement | null>(null)
  let stripFrom = $state(1)
  let stripTo = $state(0)

  const pageList = $derived(Array.from({ length: pages }, (_, i) => i + 1))
  /** Started blank sheets: "SHEET 1", "SHEET 2"…, the oldest first. */
  const boardList = $derived(Array.from({ length: boards }, (_, i) => i + 1))

  /**
   * Only visible thumbnails are drawn, plus four in reserve.
   *
   * The canvas memory budget on iPad is one per process, and when it
   * overflows WebKit starts drawing canvases TRANSPARENT, and not
   * necessarily the ones that overflowed it. The lecture sheet may be the
   * one that gets wiped.
   */
  function scanStrip(node: HTMLElement): void {
    const first = Math.floor(node.scrollLeft / THUMB_STEP) + 1
    const last = Math.ceil((node.scrollLeft + node.clientWidth) / THUMB_STEP)
    stripFrom = Math.max(1, first - 4)
    stripTo = Math.min(pages, last + 4)
  }

  $effect(() => {
    const node = strip
    if (!node || pane !== 'pages') return
    // Open it scrolled so that the current page stands in the left third: the
    // neighbours on the right are where one is going, and they must be
    // visible at once.
    const at = wanted > 0 ? wanted : pages + -wanted
    node.scrollLeft = Math.max(0, (at - 1) * THUMB_STEP - node.clientWidth / 3)
    scanStrip(node)
  })

  /*
   * INK OF BLANK SHEETS: ask for it when the strip is opened.
   *
   * A sheet's thumbnail is its annotation and nothing else (`boardInk`
   * below): it is precisely by it that one returns to a sheet, "the one
   * where I derived the limit". There is no reason to hold it on hand for
   * the whole class: the strip is opened a few times per class, and the
   * welcome batch carries one page, so the sheets are asked for here, all at
   * once and once (ink.ts remembers the questions asked).
   *
   * Slides are not asked for: their thumbnails are drawn by the document,
   * not by the ink.
   */
  $effect(() => {
    if (pane !== 'pages') return
    void session.inkRevision
    const list = boardList
    untrack(() => {
      for (const index of list) askInkPage(session, -index)
    })
  })

  /**
   * One thumbnail. On the way out it gives back its buffer:
   * `width = height = 1` is the only way to make WebKit release it; the
   * garbage collector does not give it back in time.
   *
   * And its page: taken from the shared cache (lib/pdf-pages.ts) and given
   * back when the render ends, so a strip scrolled through sixty slides does
   * not keep sixty slides decoded. A thumbnail scrolled out of the window
   * mid-render CANCELS that render: it used to run to the end into a 1×1
   * canvas, and a fast flick through the strip queued a dozen renders nobody
   * would see.
   */
  function thumb(node: HTMLCanvasElement, index: number) {
    let dropped = false
    let task: { cancel(): void } | null = null
    void (async () => {
      const source = doc
      if (!source) return
      const page = await acquirePage(source, index)
      if (!page) return
      try {
        if (dropped) return
        const base = page.getViewport({ scale: 1 })
        const ratio = Math.min(window.devicePixelRatio || 1, 2)
        const scale = Math.min(THUMB_W / base.width, THUMB_H / base.height)
        const viewport = page.getViewport({ scale: scale * ratio })
        node.width = Math.round(viewport.width)
        node.height = Math.round(viewport.height)
        node.style.width = `${Math.round(viewport.width / ratio)}px`
        node.style.height = `${Math.round(viewport.height / ratio)}px`
        const paint = node.getContext('2d')
        if (!paint || dropped) return
        const running = page.render({ canvas: node, canvasContext: paint, viewport })
        task = running
        await running.promise
      } catch {
        // The sheet was closed mid-render: business as usual.
      } finally {
        task = null
        releasePage(source, index)
      }
    })()
    return {
      destroy() {
        dropped = true
        task?.cancel()
        node.width = 1
        node.height = 1
      },
    }
  }

  /**
   * A blank sheet's ink goes into the thumbnail, and NOT as a canvas.
   *
   * A started sheet without annotation cannot be told from any other white
   * rectangle, and it is precisely by its annotation that one returns to it
   * ("the one where I derived the limit"). A canvas cannot be spent on this:
   * the budget is one per process and already allotted to the slides. The
   * points are stored as page fractions, so converting to 160×90 is a
   * multiplication.
   */
  function boardInk(index: number): { d: string; color: string; width: number }[] {
    return session.ink
      .filter((stroke) => stroke.page === -index && stroke.points.length >= 4)
      .map((stroke) => {
        let d = ''
        for (let at = 0; at + 1 < stroke.points.length; at += 2) {
          const x = (stroke.points[at] * THUMB_W).toFixed(1)
          const y = (stroke.points[at + 1] * THUMB_H).toFixed(1)
          d += `${at === 0 ? 'M' : 'L'}${x} ${y}`
        }
        return { d, color: stroke.color, width: Math.max(0.6, stroke.width * THUMB_W) }
      })
  }

  /* ------------------------------------------------------ sheet and notes */

  /**
   * The size LecturePage gave the page. Arrives through `onfit`; only its
   * ASPECT is used (the portrait split's natural height, `naturalSheetH`):
   * the remainder under the page no longer decides anything, since the strip
   * and the notes have places of their own.
   */
  let fitHeight = $state(0)
  let fitWidth = $state(0)

  function onfit(size: { w: number; h: number; rest: number }): void {
    fitHeight = size.h
    fitWidth = size.w
  }

  /**
   * The page whose picture is on the sheet right now (LecturePage ·
   * `onshown`). The console turns locally and at once, but the picture
   * arrives one render later, on a heavy slide over the relay a second or
   * more. The ink layer shows the ink of THIS page, and the pen stays off
   * until the picture catches up with `wanted`: a stroke circling a formula
   * of the old slide must not land on the new page at the same coordinates.
   * The pointer is not held back: it draws nothing, and the hand that holds
   * it across a page turn must not have to lift and touch again.
   */
  let shown = $state<number | null>(null)
  function onshown(at: number | null): void {
    shown = at
  }
  const sheetReady = $derived(shown === wanted)

  /**
   * THE ARMREST in portrait: 96 px of the well under the sheet that belong
   * to the sheet box, not to the notes. The notes began 53 px below the
   * paper's bottom edge, and the heel of a palm writing on the bottom third
   * of a slide landed in them. The input layer covers the armrest together
   * with the paper (`reach`), and a palm on it is nothing. It is held as
   * padding UNDER the page (see `sheet()`), so it survives the divider:
   * a sheet box dragged smaller shrinks the slide, never the armrest.
   */
  const PALM_REST = 96
  const RAIL_H = 64
  /** The divider between the slide and the notes in portrait. */
  const DIVIDER_H = 28
  /** Below this the docked notes are a clipped line: a header, two lines of talk, the "next" footer. */
  const NOTES_MIN = 200
  const SHEET_PAD = 12
  let sheetW = $state(0)
  let sheetH = $state(0)

  /**
   * THE PORTRAIT SPLIT: by the slide, and then by the hand.
   *
   * The natural height of the sheet box is the slide fitted by width, its
   * margins and the armrest. It is computed from the page's ASPECT
   * (`fitWidth / fitHeight`) and the box's width, never from the height the
   * page happened to get: the old scheme fed the fitted height back into the
   * box and needed a ceiling against an eight-round loop on A4 pages. The
   * aspect does not depend on the box, so there is nothing to loop.
   *
   * The divider moves the split between that natural height (down: "more
   * slide", it cannot grow past fitting the width) and half of it (up: "more
   * notes", the slide shrinks and stays whole). The choice is a share of the
   * window, remembered per device; a double tap on the divider gives the
   * slide back its natural height.
   */
  const naturalSheetH = $derived.by(() => {
    const inner = (sheetW || box.w) - SHEET_PAD * 2
    if (fitWidth > 0 && fitHeight > 0 && inner > 0) {
      return Math.round((inner * fitHeight) / fitWidth) + SHEET_PAD * 2 + PALM_REST
    }
    return Math.round(box.h * 0.45) + PALM_REST
  })
  const SPLIT_STORED = Number(remembered(SPLIT_KEY))
  let split = $state<number | null>(SPLIT_STORED > 0 && SPLIT_STORED < 1 ? SPLIT_STORED : null)
  const portraitSheetH = $derived.by(() => {
    const most = Math.max(0, box.h - RAIL_H - DIVIDER_H - NOTES_MIN)
    const top = Math.min(naturalSheetH, most)
    const least = Math.min(top, Math.max(PALM_REST + 160, Math.round((top - PALM_REST) * 0.5) + PALM_REST))
    const want = split === null ? top : Math.round(split * box.h)
    return Math.max(least, Math.min(top, want))
  })

  /** Drag the divider: the pointer is captured, and the split follows it. */
  function dividerDown(event: PointerEvent): void {
    if (busy || box.h === 0) return
    const handle = event.currentTarget as HTMLElement
    handle.setPointerCapture?.(event.pointerId)
    const startY = event.clientY
    const startH = portraitSheetH
    const move = (next: PointerEvent): void => {
      if (next.pointerId !== event.pointerId) return
      split = (startH + next.clientY - startY) / box.h
    }
    const up = (next: PointerEvent): void => {
      if (next.pointerId !== event.pointerId) return
      handle.removeEventListener('pointermove', move)
      handle.removeEventListener('pointerup', up)
      handle.removeEventListener('pointercancel', up)
      // Remember what was actually shown, not where the finger overshot.
      split = portraitSheetH / box.h
      remember(SPLIT_KEY, split.toFixed(3))
    }
    handle.addEventListener('pointermove', move)
    handle.addEventListener('pointerup', up)
    handle.addEventListener('pointercancel', up)
  }

  function dividerKey(event: KeyboardEvent): void {
    const delta = event.key === 'ArrowUp' ? -24 : event.key === 'ArrowDown' ? 24 : 0
    if (delta === 0 || box.h === 0) return
    event.preventDefault()
    split = (portraitSheetH + delta) / box.h
    remember(SPLIT_KEY, (portraitSheetH / box.h).toFixed(3))
  }

  function dividerReset(): void {
    split = null
    try {
      localStorage.removeItem(SPLIT_KEY)
    } catch {
      // Not forgotten: the slide still gets its height for this class.
    }
  }

  /**
   * The size of the sheet box, for the ink input layer.
   *
   * The input layer covers the whole box, not just one page: the margins
   * are where the heel of the palm goes and the edge a stroke starts from
   * (InkLayer, `reach`). The page lies centred in the box by width and is
   * pinned to its top under a 12 margin; the remainder under it (the
   * portrait armrest, the landscape well above the strip) is box too.
   */
  function inkReach(size: { w: number; h: number }): { top: number; right: number; bottom: number; left: number } {
    const side = Math.max(0, (sheetW - size.w) / 2)
    return { top: SHEET_PAD, right: side, bottom: Math.max(0, sheetH - SHEET_PAD - size.h), left: side }
  }

  /**
   * The notes are requested BY THE CONSOLE ITSELF, whichever view is on
   * screen: the strip's plan and the footer's "next" need them even with the
   * column folded. The latch by file name inside `openNotes` makes a
   * repeated call free.
   */
  $effect(() => {
    const path = file
    if (!host || path === null) return
    untrack(() => session.openNotes(path))
  })

  /** This document's notes have arrived: empty and "never asked" are different. */
  const notesHere = $derived(session.notesFile === file)
  const noteOf = (page: number): string => (notesHere && page > 0 ? (session.notes[page] ?? '') : '')
  /** The note on screen. A blank sheet never has one. */
  const note = $derived(noteOf(wanted))
  /** Where the note belongs: a change scrolls the reader back to the top. */
  const notePlace = $derived(`${file ?? ''}:${wanted}`)

  /**
   * The slide's budget: the timing written in its note (`*≈ 1.2 мин*`), or
   * the speaking estimate when there is none. The header says it, and the
   * "on this slide" clock counts against it.
   */
  const budget = $derived(onBoard ? null : budgetOf(note))
  const budgetLabel = $derived(
    !budget || budget.seconds === 0
      ? ''
      : budget.written
        ? budget.written.label
        : tr('room.prompter.minutes', { n: (budget.seconds / 60).toFixed(1) }),
  )
  /** The plan at the end of this page, when the script is timed (see `plannedSeconds`). */
  const plan = $derived(notesHere && !onBoard && wanted > 0 ? plannedSeconds(session.notes, wanted) : null)
  /** Elapsed past the plan: the plan line turns amber, the only warning the strip gives. */
  const late = $derived(plan !== null && lecture !== null && runningFor > plan * 1000)

  /*
   * "WHAT COMES NEXT" IN WORDS: the next slide's title from the PDF and the
   * first line of its note. On a blank sheet the next step is the slide the
   * sheet was started from.
   */
  const nextPage = $derived(!onBoard && pages > 0 && wanted < pages ? wanted + 1 : null)
  const thenPage = $derived(nextPage !== null && nextPage < pages ? nextPage + 1 : null)
  let titles = $state<Record<number, string>>({})
  /** Whose titles `titles` holds. Not a rune: only checked against. */
  let titlesOf: PDFDocumentProxy | null = null

  $effect(() => {
    const source = doc
    const at = wanted
    if (source !== titlesOf) {
      titlesOf = source
      titles = {}
    }
    if (!source || at < 1) return
    let alive = true
    for (const index of [at, at + 1, at + 2]) {
      if (index > source.numPages) continue
      void slideTitle(source, index).then((title) => {
        if (!alive || untrack(() => titles[index]) === title) return
        titles = { ...untrack(() => titles), [index]: title }
      })
    }
    return () => {
      alive = false
    }
  })

  const nextTitle = $derived(nextPage !== null ? (titles[nextPage] ?? '') : '')
  const nextWords = $derived(nextPage !== null ? firstLine(noteOf(nextPage)) : '')
  const thenTitle = $derived(thenPage !== null ? (titles[thenPage] ?? '') : '')

  /**
   * THE READING STRIP under the slide (landscape): page, time, plan, "next".
   *
   * Its height is a constant of the window, not of the slide: a strip that
   * took "whatever the slide left" would feed back into the slide's fit.
   * The slide's box is what is left above it, so a 4:3 deck shrinks a
   * little instead of pushing the page number off the screen, and the
   * number, the clock and "next" are on screen whatever the deck.
   */
  const stripH = $derived(box.h >= 1000 ? 190 : box.h >= 800 ? 160 : 116)
  /** The "next" thumbnail in the strip: as tall as the strip allows, 16:9, at most 240 × 135. */
  const thumbH = $derived(Math.min(135, stripH - 50))
  const thumbW = $derived(Math.round((thumbH * 16) / 9))

  /** The notes column's width: about a third of the window, a measure of ~40 characters at 22 px. */
  const columnW = $derived(Math.max(340, Math.min(440, Math.round(box.w * 0.32))))

  /* ------------------------------------------------------------ keyboard */

  /*
   * The keyboard is for a clicker plugged into the laptop at the projector,
   * and for whoever presents from a laptop. Not a single key that ends the
   * lecture or erases the page: they are too easy to hit blindly. Letters
   * are read by `code`, not by `key`: on a Russian layout `key` is "и", "м"
   * and "д".
   */
  function onkeydown(event: KeyboardEvent): void {
    const target = event.target as HTMLElement | null
    const typing = target?.closest('input, textarea, [contenteditable]') != null
    if (event.key === 'Escape') {
      if (palette !== null) {
        event.preventDefault()
        palette = null
      } else if (pane !== null) {
        event.preventDefault()
        openPane(null)
      } else if (!portrait && notesOpen && !tele) {
        event.preventDefault()
        setNotes(false)
      }
      return
    }
    /*
     * F5 is the clicker's "start slideshow" key (the R400 kind alternates it
     * with Escape), and in a browser it reloads the page: the console lost
     * its tool and its place mid-class. Here it means what it means in a
     * slideshow: full screen, from a live key press.
     */
    if (isClickerReload(event)) {
      event.preventDefault()
      if (!full && root && fullscreenPossible()) void goFullscreen(root)
      return
    }
    if (typing || !mayTurn) return
    if (event.key === 'ArrowRight' || event.key === 'PageDown' || event.key === ' ') {
      event.preventDefault()
      step(1)
    } else if (event.key === 'ArrowLeft' || event.key === 'PageUp') {
      event.preventDefault()
      step(-1)
    } else if (BLANK_KEYS.has(event.code) && !event.metaKey && !event.ctrlKey && !event.altKey) {
      // B, as before, and what clickers send for "black screen": '.', ','
      // and W (PowerPoint's black and white screen keys).
      event.preventDefault()
      blank(!lecture?.blank)
    } else if (event.code === 'KeyZ') {
      event.preventDefault()
      undoStroke()
    } else if (event.code === 'KeyE') {
      event.preventDefault()
      pick('eraser')
    } else if (event.code === 'KeyM') {
      event.preventDefault()
      pick('marker')
    } else if (event.code === 'KeyL') {
      // The pointer on the keyboard is a spring: held, it shines. Auto-repeat
      // arrives here by the dozen, and each repeat merely confirms `true`.
      event.preventDefault()
      if (leading && !offline) sprung = true
    } else if (event.code === 'KeyN') {
      event.preventDefault()
      if (!portrait && !tele) setNotes(!notesOpen)
    } else if (event.code === 'KeyT') {
      // T for the prompter, and back: the same key both ways, like N.
      event.preventDefault()
      setView(tele ? 'slide' : 'tele')
    } else if (/^Digit[1-3]$/.test(event.code)) {
      event.preventDefault()
      penIn(INKS[Number(event.code.slice(5)) - 1].color)
    }
  }

  function onkeyup(event: KeyboardEvent): void {
    if (event.code === 'KeyL') sprung = false
  }

  /* ------------------------------------------------------------ classes */

  /*
   * The buttons are assembled by hand, so the list of transition properties
   * is written out in full: the `transition-colors` utility would rewrite
   * `transition-property` and throw `transform` out of it, that is, the
   * press itself.
   *
   * The press is the only proof that a touch was heard, on a screen that
   * may not change at all. So it stays even under `prefers-reduced-motion`.
   */
  const PRESS =
    'transition-[color,background-color,border-color,transform] duration-press ease-out ' +
    'enabled:active:scale-[0.97] focus-visible:outline-none focus-visible:ring-2 ' +
    'focus-visible:ring-inset focus-visible:ring-accent/40'

  /*
   * THE KEY.
   *
   * At rest there is no fill at all, only a label or a glyph on the body: a
   * toolbar at rest is lettering on the body of an object, not twelve boxes.
   * Under a finger, `bg-line`. When on, `bg-raised` plus a 3 px bar on the
   * INNER edge, see `mark()`.
   */
  const KEY = `relative flex shrink-0 items-center justify-center ${PRESS} enabled:active:bg-line`
  /** An action label: 0.14em names an ACTION. The console has exactly two trackings. */
  const CAP = 'text-2xs font-semibold tracking-normal'
  /** A place name: 0.2em names a PLACE (a strip, an area). */
  const SECTION = 'text-micro font-bold uppercase tracking-section'
  /**
   * A reading's caption in the strip, the notes header and the prompter
   * ("SLIDE", "TIME", "NEXT · 15"): mono, like the numbers it captions, so the
   * caption and its reading are one object.
   */
  const LABEL = 'font-mono text-micro font-bold uppercase tracking-label'
  /** A row of a raised sheet. */
  const ROW = `flex h-16 w-full items-center gap-3 px-6 text-left text-answer ${PRESS} enabled:active:bg-line`

  /**
   * A disabled key's label: `faint` at 70 % is ABSENCE, not information.
   * `disabled:text-faint/70` is spelled out letter by letter in the markup:
   * Tailwind's scanner looks for classes as text and will not see a glued
   * string.
   */
  const OFF = 'text-faint/70'

  /** The side of a key's "inner" edge: the one facing the sheet. */
  const inner = $derived<'left' | 'right' | 'top'>(
    portrait ? 'top' : hand === 'left' ? 'left' : 'right',
  )
</script>

<svelte:window {onkeydown} {onkeyup} onblur={laserCancel} />

<!--
  Insets under the notch and the home indicator are on the root, in one
  place. Not a single `vh`: the `height: 100%` chain depends neither on
  Safari's panels nor on which window the tablet is living in right now.

  The root's ground is the well (`canvas`): the middle sinks, and the rail's
  body (`surface`) comes forward. The step between them is ~1.5 %: it is not
  read, it is felt.
-->
<div
  bind:this={root}
  class="pult-root relative flex h-full w-full flex-col overflow-hidden bg-canvas text-ink"
  style="padding-top: env(safe-area-inset-top); padding-left: env(safe-area-inset-left); padding-right: env(safe-area-inset-right); padding-bottom: env(safe-area-inset-bottom)"
>
  {#if session.gone}
    <!--
      THE ROOM IS GONE, and the console itself must say so.

      The room's banner is not drawn on the console at all (SessionScreen:
      `session.gone && !pult`), hence its own words here: the banner used to
      lie UNDER the console's opaque wrapper, and on the tablet all that was
      left was an English toast for six seconds, and after it a lecture with
      the rail's red seam and keys that stay silent.

      The refusal window ("This edit was not accepted") is another matter: it
      is raised above the wrapper and is drawn here too. A second copy of it
      is deliberately not created here: it holds the only copy of the lost
      text (tests/refusal-layer).
    -->
    <div class="flex h-full flex-col items-center justify-center gap-4 p-8 text-center">
      <p class="text-ui-lg text-ink">{tr('room.ui.145')}</p>
      <p class="max-w-[440px] text-answer text-muted"> {tr('room.ui.146')} </p>
    </div>
  {:else if !host}
    <!--
      The key link may end up with a student, and they will land here. The
      console says so and offers the only thing they need here.
    -->
    <div class="flex h-full flex-col items-center justify-center gap-5 p-8 text-center">
      <p class="text-ui-lg text-ink">{tr('room.ui.147')}</p>
      <button type="button" class="btn-outline h-11 px-6" onclick={onexit}>{tr('room.ui.148')}</button>
    </div>
  {:else if session.stuck}
    <!--
      THE TAB HAS DRIFTED FROM THE SERVER, and the console itself must say
      that too.

      The room's bar (SessionScreen) is built for a window with a mouse: a
      text-ui line and a button 30 px tall at the tablet's bottom edge. And
      before it there was nothing left here but the rail's red seam: the keys
      are dimmed (`offline`), the sheet hangs, and not a word as to why. The
      argument is the same as for the deleted room above: our own words and
      our own finger-sized targets.

      There is exactly one action: a reload by hand rebuilds the document and
      starts the reload count over (see lib/refusal.ts). The tab no longer
      retries by itself, hence a button here, not a spinner.
    -->
    <div class="flex h-full flex-col items-center justify-center gap-4 p-8 text-center">
      <p class="text-ui-lg text-ink">{tr('room.ui.149')}</p>
      <p class="max-w-[440px] text-answer text-muted">{session.stuck}</p>
      {#if lecture}
        <!-- The presenter's first thought is whether the class is lost. It is
             not: the page and the ink live on the server, not in this tab. -->
        <p class="max-w-[440px] text-answer text-muted"> {tr('room.ui.150')} </p>
      {/if}
      <button type="button" class="btn-primary h-11 px-6" onclick={() => reloadByHand()}> {tr('room.ui.151')} </button>
    </div>
  {:else if lecture === null && prep === null}
    {@render chooser()}
  {:else if tele}
    <!--
      THE PROMPTER: the rail keeps only what a talk without a pen needs
      (the gauge, "Slide", "Hide", page turning), and the rest of the screen
      is the note. In portrait the bottom rail stays where the thumb is.
    -->
    {#if portrait}
      <div class="flex min-h-0 flex-1 flex-col">
        {@render teleBody()}
        {@render bottomRail()}
      </div>
    {:else}
      <div class="flex min-h-0 flex-1 {hand === 'left' ? 'flex-row-reverse' : ''}">
        {@render teleRail()}
        {@render teleBody()}
      </div>
    {/if}
  {:else if portrait}
    <!--
      PORTRAIT. The sheet on top with 12 margins and the armrest under it,
      the divider, the notes docked across the remainder, the rail at the
      bottom under the thumb of the holding hand. There is no "Notes" key:
      the notes are on screen anyway, and the divider decides how much.
    -->
    <div class="flex min-h-0 flex-1 flex-col">
      <div
        class="pult-sheet relative shrink-0 p-3"
        style={`height:${portraitSheetH}px`}
        role="group"
        aria-label={tr('room.ui.152')}
        bind:clientWidth={sheetW}
        bind:clientHeight={sheetH}
      >
        {@render sheet()}
      </div>
      {#if file !== null}
        {@render divider()}
        <div class="flex min-h-0 flex-1 flex-col" data-pult-notes data-pult-guard>
          {@render dock()}
        </div>
      {/if}
      {@render bottomRail()}
    </div>
  {:else}
    <!--
      LANDSCAPE. One 72 px rail at the edge, the slide with its reading strip,
      and the notes column on the far side. The edge follows the hand: with
      "left hand" the rail moves to the right edge together with the palette,
      and the notes to the left.
    -->
    <div class="flex min-h-0 flex-1 {hand === 'left' ? 'flex-row-reverse' : ''}">
      {@render sideRail()}
      <div class="flex min-h-0 min-w-0 flex-1 flex-col">
        <!--
          The sheet box has 12 px MARGINS, as in portrait: the margins belong
          to the sheet, not to the well. The heel of the palm rests on them
          and strokes start from them, and the ink input layer covers them
          together with the paper, down to the strip.
        -->
        <div
          class="pult-sheet relative min-h-0 flex-1 p-3"
          role="group"
          aria-label={tr('room.ui.152')}
          bind:clientWidth={sheetW}
          bind:clientHeight={sheetH}
        >
          {@render sheet()}
        </div>
        {#if file !== null}
          {@render readingStrip()}
        {/if}
      </div>
      {#if file !== null && notesOpen}
        {@render notesColumn()}
      {/if}
    </div>
  {/if}

  {#if palette === 'pen' && leading}
    {@render palettePop()}
  {:else if palette === 'laser' && leading}
    {@render laserPop()}
  {/if}

  {@render panes()}

  {#if lost && lecture && !session.gone}
    {@render takenNotice(lost)}
  {/if}
</div>

<!--
  "THE LECTURE WAS TAKEN OVER": the old console's notice, on the night card.
  Over the whole console, not a toast: the rail has just lost its pen, and a
  line that disappears in six seconds would leave the presenter looking at a
  tablet that "broke". Two answers, the size of the turn keys: take it back
  (the same take-over, the other way) or watch.
-->
{#snippet takenNotice(gone: Lost)}
  <div
    class="absolute inset-0 z-50 flex items-center justify-center bg-canvas/75 p-4"
    role="alertdialog"
    aria-modal="true"
    aria-labelledby="pult-taken-title"
    aria-describedby="pult-taken-body"
    data-taken
  >
    <div class="flex w-[540px] max-w-full flex-col border border-line bg-surface px-10 pb-8 pt-9 shadow-pop">
      <svg width="112" height="36" viewBox="0 0 112 36" fill="none" aria-hidden="true" class="shrink-0">
        <rect x="1" y="3" width="22" height="30" rx="3" class="text-faint" stroke="currentColor" stroke-width="1.6" />
        <path d="M9.5 28.5h5" class="text-faint" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" />
        <path d="M34 18h30" class="text-accent" stroke="currentColor" stroke-width="1.6" stroke-dasharray="3 4" />
        <path d="M60 13l5 5-5 5" class="text-accent" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" />
        {#if handheld(gone.device)}
          <rect x="80" y="3" width="22" height="30" rx="3" class="text-ink" stroke="currentColor" stroke-width="1.6" />
          <path d="M88.5 28.5h5" class="text-ink" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" />
        {:else}
          <rect x="77" y="8" width="28" height="19" rx="2" class="text-ink" stroke="currentColor" stroke-width="1.6" />
          <path d="M72 31h38" class="text-ink" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" />
        {/if}
      </svg>
      <div class="flex flex-col gap-3.5 pt-6">
        <div class="flex flex-col gap-1.5">
          <h2 id="pult-taken-title" class="text-gauge font-bold text-ink">{tr('room.takeover.taken')}</h2>
          <p class="font-mono text-ui-lg text-muted">{lostMeta}</p>
        </div>
        <p id="pult-taken-body" class="text-title text-muted">{tr('room.takeover.takenBody')}</p>
      </div>
      <div class="flex gap-3 pt-7">
        <button
          type="button"
          class="{PRESS} flex h-14 flex-1 items-center justify-center border text-2xs font-bold uppercase tracking-label {offline
            ? 'border-line text-faint/70'
            : 'border-accent text-accent'} enabled:active:bg-line"
          disabled={offline}
          data-give-back
          onclick={grab}
        >
          {tr('room.takeover.giveBack')}
        </button>
        <button
          type="button"
          class="{PRESS} flex h-14 flex-1 items-center justify-center border border-line text-2xs font-bold uppercase tracking-label text-ink enabled:active:bg-line"
          onclick={() => (lost = null)}
        >
          {tr('room.takeover.watchOnly')}
        </button>
      </div>
      <p class="pt-4 text-ui text-faint">
        {offline ? tr('room.takeover.offline') : tr('room.takeover.takenInk')}
      </p>
    </div>
  </div>
{/snippet}

<!-- =========================================================== instrument -->

{#snippet fader(kind: 'rail' | 'flat' | 'row')}
  <!--
    Three detents, not a cycling button: a fader always shows its current
    position. The bars grow 4 / 9 / 14: the position is read by shape, not
    by label, and the hand finds it by feel in one glance.

    THE TARGET IS 44 px TALL whatever the bars are: the cells used to be the
    bars' own 22×24 (16×20 in portrait), with no gaps between them, and a
    finger hit the neighbouring detent. The bars stay small, the cell around
    them is a finger's height, and a finger sliding across the group sets the
    detent it is over (`faderSlide`), so a narrow cell is forgiving too. In
    "More" the same fader is a full-width row with names.
  -->
  {@const cell = kind === 'rail' ? 'h-11 w-[22px]' : kind === 'flat' ? 'h-11 w-[17px]' : 'h-14 flex-1 gap-3'}
  <div
    class="flex {kind === 'row' ? 'w-full' : ''}"
    role="radiogroup"
    aria-label={tr('room.ui.153')}
    use:faderSlide
  >
    {#each LAMPS as level, index (level.name)}
      {@const on = lamp === index}
      <button
        type="button"
        role="radio"
        aria-checked={on}
        aria-label={level.name}
        data-lamp={index}
        class="{PRESS} flex {cell} items-center justify-center {kind === 'row' && on ? 'bg-raised' : ''}"
        onclick={() => setLamp(index)}
      >
        <span
          class="flex items-end justify-center pb-1 {kind === 'flat' ? 'h-5 w-4' : 'h-6 w-[22px]'} {on &&
          kind !== 'row'
            ? 'bg-raised'
            : ''}"
          aria-hidden="true"
        >
          <span
            class="block {kind === 'flat' ? 'w-3' : 'w-[14px]'} {on ? 'bg-ink' : 'bg-faint/70'}"
            style={`height:${Math.round((level.bar * (kind === 'flat' ? 12 : 14)) / 14)}px`}
          ></span>
        </span>
        {#if kind === 'row'}
          <span class="text-ui-lg {on ? 'text-ink' : 'text-muted'}">{level.name}</span>
        {/if}
      </button>
    {/each}
  </div>
{/snippet}

{#snippet tempo(width: string)}
  <!--
    THE PACE RULER: the share of the deck as a shape, not as arithmetic:
    where we are in this pile. When diverging from the projector it turns
    cyan and crawls in a 1.2 s loop: "we are still waiting". It is a
    footnote, not a replacement for the number: the big number shows what
    you DECIDED and must stand still.
  -->
  <span class="block h-[2px] {width} bg-line" aria-hidden="true">
    <span
      class="block h-full w-full origin-left {behind
        ? 'pult-catchup bg-accent'
        : 'bg-muted transition-transform duration-[160ms] ease-out'}"
      style={behind ? undefined : `transform:scaleX(${pages > 0 ? Math.min(1, wanted / pages) : 0})`}
    ></span>
  </span>
{/snippet}

{#snippet gauge()}
  <!--
    THE 72×128 INSTRUMENT of the prompter's rail. Not a button by nature but
    a READING: number, share of the deck, wall clock, brightness. The slab
    can be pressed (it opens the page strip), but nobody counts on that. In
    the slide view the same readings live in the strip under the slide, and
    the rail keeps only the fader and "More" on top.

    The number is flush left with a −2 px correction: tabular digits carry
    side bearings, and without the correction the number looks shifted
    right relative to the column.
  -->
  <div class="relative h-[128px] w-full shrink-0">
    <button
      type="button"
      class="{PRESS} absolute inset-x-0 top-0 h-[84px] enabled:active:bg-line"
      aria-label={tr('room.ui.156')}
      onclick={() => openPane('pages')}
    >
      {#if behind && lecture}
        <!--
          WHAT THE AUDIENCE SEES, when the projector has fallen behind. Small,
          on the right and FIRST: the footnote answers "where are they", the
          big number "where am I". It appears only after 600 ms of divergence,
          together with the loop.
        -->
        <span
          class="absolute right-1.5 top-1.5 flex h-[13px] items-center font-mono text-code tabular-nums text-muted"
        >
          {lecture.page < 0 ? tr('room.ui.157', { p0: -lecture.page }) : lecture.page}&nbsp;→
        </span>
      {/if}
      <span
        class="absolute left-[10px] top-2 flex h-8 items-center font-mono text-gauge tabular-nums {watching ||
        preparing
          ? 'text-muted'
          : 'text-ink'}"
      >
        {onBoard ? tr('room.ui.158', { p0: -wanted }) : wanted}
      </span>
      {#if onBoard}
        <span class="absolute left-3 top-[44px] flex h-[13px] items-center {SECTION} text-muted"> {tr('room.ui.159')} </span>
      {:else}
        <!-- The denominator on its own line: otherwise it shifts on the 9 → 10 step. -->
        <span
          class="absolute left-3 top-[44px] flex h-[13px] items-center font-mono text-code tabular-nums text-muted"
        >
          / {pages || '—'}
        </span>
        <span class="absolute left-3 top-[62px]">{@render tempo('w-[52px]')}</span>
      {/if}
      <span
        class="absolute left-3 top-[68px] flex h-[13px] items-center font-mono text-code tabular-nums text-muted"
      >
        {preparing ? tr('room.ui.160') : wall}
      </span>
    </button>

    <div class="absolute bottom-0 left-[3px]">
      {@render fader('rail')}
    </div>
  </div>
{/snippet}

{#snippet gaugeFlat()}
  <!--
    The bottom rail's instrument, 104×64: the number on the left, the pace
    and the fader in a column on the right. The same hierarchy, laid on its
    side. When the rail is tight the column goes (the fader lives in "More"
    as well) and the number keeps 64 px.
  -->
  <div class="relative flex h-full {fit === 'tight' ? 'w-16' : 'w-[104px]'} shrink-0">
    <button
      type="button"
      class="{PRESS} relative flex h-full w-[52px] flex-col items-start justify-center pl-2 enabled:active:bg-line"
      aria-label={tr('room.ui.156')}
      onclick={() => openPane('pages')}
    >
      <span
        class="font-mono text-gauge tabular-nums {watching || preparing ? 'text-muted' : 'text-ink'}"
      >
        {onBoard ? tr('room.ui.158', { p0: -wanted }) : wanted}
      </span>
      {#if !onBoard}
        <span class="font-mono text-micro tabular-nums text-faint">/ {pages || '—'}</span>
      {/if}
    </button>
    {#if fit !== 'tight' && !tiny}
      <div class="flex w-[52px] flex-col items-start justify-center gap-0.5">
        {#if !onBoard}
          {@render tempo('w-[44px]')}
        {/if}
        <span class="-ml-px">{@render fader('flat')}</span>
      </div>
    {/if}
  </div>
{/snippet}

<!-- ================================================================ rail -->

{#snippet toast()}
  <!--
    One line for six seconds. A 2 px bar on the left names the kind: accent
    for a message, danger for a refusal.
  -->
  {#if notice}
    <div class="pointer-events-none relative flex h-8 items-center bg-raised px-4" aria-live="polite">
      <span
        class="absolute inset-y-0 left-0 w-[2px] {noticeKind === 'refusal' ? 'bg-danger' : 'bg-accent'}"
        aria-hidden="true"
      ></span>
      <span class="{CAP} text-ink">{notice}</span>
    </div>
  {/if}
{/snippet}

{#snippet mark(on: boolean, amber: boolean)}
  <!--
    The "on" bar on the INNER edge, the one facing the sheet. The direction
    carries meaning: "this is what the pen does over there". Not animated:
    the state arrives instantly.
  -->
  {#if on}
    <span
      class="absolute {inner === 'top'
        ? 'inset-x-0 top-0 h-[3px]'
        : inner === 'left'
          ? 'inset-y-0 left-0 w-[3px]'
          : 'inset-y-0 right-0 w-[3px]'} {amber ? 'bg-warning' : 'bg-ink'}"
      aria-hidden="true"
    ></span>
  {/if}
{/snippet}

{#snippet swatch(color: string, thick: number)}
  <!--
    THE DAB UNDER THE ICON IS ON PAPER. The icon says which tool this is, the
    dab how it is writing right now. The key used to carry only the sample,
    and the pen differed from the marker by the shape of the stroke inside
    it, that is, one had to look closely; on the rail, which one reaches for
    without looking, there is no time to look closely.

    The paper under the dab is not decoration: the console's body is night,
    and the black pen (#101a33) on it gives 1.5:1, that is, invisible. That
    is exactly why the old chip stood here, and this argument survived the
    icon rework.

    The dab's height is the real stroke thickness, capped from above: a
    fourteen-pixel line on a forty-eight-pixel key would read as a slab, not
    a line.
  -->
  <span class="flex h-[11px] w-7 items-center justify-center bg-white" aria-hidden="true">
    <span
      class="block w-5 rounded-full"
      style={`height:${Math.min(6, Math.max(2, thick))}px;background:${color}`}
    ></span>
  </span>
{/snippet}

{#snippet toolKeys(size: string, gap: string)}
  <!--
    THE TOOL PALETTE IS ONE ROW: pen, marker, eraser, pointer. Exactly as in
    note-taking apps: pick one, drop another. The pointer is right here, not
    a separate spring on another rail.
  -->
  <button
    type="button"
    class="{KEY} {size} flex-col gap-1 {tool === 'pen' ? 'bg-raised' : ''}"
    data-pult-tool
    aria-label={tr('room.ui.161')}
    aria-pressed={tool === 'pen'}
    aria-expanded={palette === 'pen'}
    onclick={penKey}
  >
    {@render mark(tool === 'pen', false)}
    <Icon name="pencil" size={22} />
    {@render swatch(inkColor, dotOf(penWidth))}
  </button>
  <span class={gap} aria-hidden="true"></span>
  <button
    type="button"
    class="{KEY} {size} flex-col gap-1 {tool === 'marker' ? 'bg-raised' : ''}"
    aria-label={tr('room.ui.162')}
    aria-pressed={tool === 'marker'}
    onclick={() => pick('marker')}
  >
    {@render mark(tool === 'marker', false)}
    <Icon name="marker" size={22} />
    {@render swatch(MARKER, 10)}
  </button>
  <span class={gap} aria-hidden="true"></span>
  <!--
    The eraser erases by STROKES, not pixels: the wire only has "remove a
    stroke by id". Holding for half a second erases the whole page.
  -->
  <button
    type="button"
    class="{KEY} {size} {tool === 'eraser' ? 'bg-raised text-ink' : 'text-muted'}"
    aria-label={tr('room.ui.164')}
    aria-pressed={tool === 'eraser'}
    onpointerdown={eraserDown}
    onpointerup={eraserUp}
    onpointerleave={eraserCancel}
    onpointercancel={eraserCancel}
    onclick={(event) => {
      // From the keyboard `click` arrives with detail === 0 and without the
      // pointerdown/pointerup pair; otherwise the button would be unreachable
      // without a finger.
      if (event.detail === 0) pick('eraser')
    }}
  >
    {@render mark(tool === 'eraser', false)}
    <Icon name="eraser" size={24} />
  </button>
  <span class={gap} aria-hidden="true"></span>
  <button
    type="button"
    class="{KEY} {size} {tool === 'laser' || sprung ? 'bg-raised' : ''} {offline
      ? OFF
      : tool === 'laser' || sprung
        ? 'text-ink'
        : 'text-muted'}"
    data-pult-tool
    aria-label={tr('room.ui.165')}
    aria-pressed={tool === 'laser'}
    disabled={offline}
    onpointerdown={laserDown}
    onpointerup={laserUp}
    onpointercancel={laserCancel}
    onpointerleave={laserCancel}
    onclick={(event) => {
      // A press WITHOUT the pointerdown/pointerup pair: keyboard, VoiceOver,
      // automated checks. Their `click` arrives with detail === 0.
      if (event.detail === 0) laserKey()
    }}
  >
    {@render mark(tool === 'laser' || sprung, false)}
    <Icon name="laser" size={22} />
  </button>
{/snippet}

{#snippet moreKey(size: string)}
  <!--
    "More" (⋯): the way into everything done once per class or once in a
    lifetime. It lives ON THE RAIL now, next to the fader: it used to live
    only in the header of the notes sheet, and with the notes closed (the old
    default) ending the lecture, leaving for the room or turning finger
    drawing back on after the Pencil died meant guessing to open "Notes"
    first.
  -->
  <button
    type="button"
    class="{KEY} {size} text-muted"
    aria-label={tr('room.ui.312')}
    title={tr('room.ui.313')}
    onclick={() => openPane('more')}
  >
    <Icon name="more" size={22} />
  </button>
{/snippet}

{#snippet turnKeys(prevSize: string, nextSize: string, column: boolean)}
  {#if mayTurn}
    <!--
      On sheets "Back" is always alive: from sheet N it leads to N−1, from
      the first to the slides. It used to go dark on `-wanted >= boards`, a
      rule from the old numbering, because of which on the last sheet (that
      is, the one people most often stand on) the key was grey, and the
      previous sheet could be reached only through the page strip.
    -->
    <button
      type="button"
      class="{KEY} {prevSize} text-muted disabled:text-faint/70"
      disabled={!onBoard && wanted <= 1}
      aria-label={tr('room.ui.174')}
      onclick={() => step(-1)}
    >
      <Icon name="chevron-left" size={24} />
    </button>
    {#if column}<span class="h-1 shrink-0" aria-hidden="true"></span>{/if}
    <!-- The biggest key: people page forward eight times more often than back. -->
    <button
      type="button"
      class="{KEY} {nextSize} {column ? 'flex-col gap-1' : 'gap-2'} text-ink disabled:text-faint/70"
      disabled={!onBoard && pages > 0 && wanted >= pages}
      aria-label={tr('room.ui.175')}
      onclick={() => step(1)}
    >
      <Icon name="chevron-right" size={28} />
      <span class="{CAP} {!column && fit === 'tight' ? 'sr-only' : ''}">
        {forwardReturns ? tr('room.ui.176') : tr('room.ui.177')}
      </span>
      {#if forwardReturns && column}
        <span class="font-mono text-code tabular-nums text-muted">{lastSlide}</span>
      {/if}
    </button>
  {:else}
    <!--
      Who holds it, where the turn keys would be: the device when it is this
      teacher's other screen ("PRESENTING · MAC"), the name otherwise. A
      faint dot when they are gone: the lock is stale and the take-over key
      above goes through without waiting.
    -->
    <span
      class="flex {column ? 'w-full flex-col gap-0.5 py-2' : 'w-[112px] flex-col gap-0.5'} shrink-0 items-center justify-center px-1 text-center"
      data-pult-holder
    >
      <span class="{SECTION} text-faint">{tr('room.takeover.leadsRail')}</span>
      <span class="flex max-w-full items-center gap-1 {SECTION} text-muted">
        {#if holder?.awaySince !== null && holder?.awaySince !== undefined}
          <span class="h-1.5 w-1.5 shrink-0 rounded-full bg-faint" aria-hidden="true"></span>
        {/if}
        <span class="truncate">
          {holder?.self ? (deviceWord(holder.device) ?? lecture?.byName) : lecture?.byName}
        </span>
      </span>
    </span>
  {/if}
{/snippet}

{#snippet deckKey(size: string)}
  {#if preparing}
    <!-- In place of BLANK, preparation has "PRESENT": the only filled cyan
         slab on the console, with exactly one action behind it. -->
    <button
      type="button"
      class="{KEY} {size} bg-accent text-accent-ink {CAP}"
      onclick={() => prep && start(prep)}
    > {tr('room.ui.169')} </button>
  {:else if leading}
    <!--
      BLANK. The state of light is shown by light itself: the console has
      light taken away, not added. Amber has its only place on the console
      here; there is no red, because a pause is not a refusal. The word is
      short not out of poverty: "ЗАТЕМНИТЬ" ("DIM") in nine spaced small
      capitals is wider than a 72 px key and crept past the rail on both
      sides.
    -->
    <button
      type="button"
      class="{KEY} {size} {CAP} {lecture?.blank ? 'bg-raised' : ''} {offline
        ? OFF
        : lecture?.blank
          ? 'text-warning'
          : 'text-muted'}"
      aria-label={lecture?.blank ? tr('room.extra.55') : tr('room.extra.56')}
      aria-pressed={lecture?.blank}
      disabled={offline}
      onclick={() => blank(!lecture?.blank)}
    >
      {@render mark(lecture?.blank === true, true)}
      {lecture?.blank ? tr('room.ui.170') : tr('room.ui.171')}
    </button>
  {/if}
{/snippet}

{#snippet sheetKey(size: string)}
  {#if mayTurn}
    <!--
      SHEET stays a key: a blank sheet is started mid-sentence ("the slide
      ended, but the derivation did not"), and two presses for that are
      already a refusal. It is also in the page strip, as the last tile.
    -->
    <button
      type="button"
      class="{KEY} {size} {onBoard ? 'bg-raised text-ink' : 'text-muted'} {CAP}"
      aria-label={onBoard ? tr('room.extra.53') : tr('room.extra.54')}
      aria-pressed={onBoard}
      onclick={() => (onBoard ? backToSlides() : newBoard())}
    >
      {@render mark(onBoard, false)}
      {onBoard ? tr('room.ui.167') : tr('room.ui.168')}
    </button>
  {/if}
{/snippet}

{#snippet grabKey(size: string)}
  {#if watching}
    <!--
      Someone else presents. The only key: an outline without fill; a filled
      slab would glow for all forty minutes of someone else's lecture for the
      sake of one press.
    -->
    <button
      type="button"
      class="{PRESS} flex {size} shrink-0 items-center justify-center border px-1 text-center {CAP} {offline
        ? 'border-line text-faint/70'
        : 'border-accent text-accent-text'} enabled:active:bg-line"
      disabled={offline}
      data-grab
      onclick={() => openPane('grab')}
    >
      {holder?.self ? tr('room.takeover.grabHere') : tr('room.ui.172')}
    </button>
  {/if}
{/snippet}

{#snippet sideRail()}
  <!--
    ONE RAIL, 72 px, in two parts. There are no dividing hairlines between
    keys: the body divides them: a 4 gap means "neighbours in a family", a 16
    notch means "a border between families".

    The MIDDLE may clip, the FOOTER never does: page turning sits in a
    footer that does not shrink, so whatever the window, "Back" and "Next"
    are on screen (see `fit` for how the middle makes itself smaller first).
    Top to bottom: the fader and "More", the tools and "Undo", a spacer, the
    deck keys and "Notes"; then the turn keys and the home indicator's
    reserve. The page number lives in the strip under the slide now, where
    the eye already is.

    The inner edge turns red when the connection drops: a thin red seam
    along the side of a glowing window is visible in peripheral vision and
    takes up not a single pixel of layout.
  -->
  {@const key = fit === 'roomy' ? 'h-[52px] w-full' : 'h-11 w-full'}
  <div
    use:swipe={() => 'y'}
    class="pult-rail flex w-[72px] shrink-0 flex-col bg-surface {hand === 'left'
      ? 'border-l'
      : 'border-r'} {offline ? 'border-danger/40' : 'border-line'}"
  >
    <div class="flex min-h-0 flex-1 flex-col overflow-hidden">
      <span class="h-2 shrink-0" aria-hidden="true"></span>
      <div class="flex h-11 shrink-0 items-center justify-center">
        {@render fader('rail')}
      </div>
      <span class="h-1 shrink-0" aria-hidden="true"></span>
      {@render moreKey('h-11 w-full')}
      <span class="{fit === 'roomy' ? 'h-4' : 'h-2'} shrink-0" aria-hidden="true"></span>

      {#if leading}
        {@render toolKeys(key, 'h-1 shrink-0')}
        {#if fit !== 'tight'}
          <span class="h-2 shrink-0" aria-hidden="true"></span>
          <!--
            UNDO sits under the tools: a bad stroke is made by the pen, and
            the hand is already over the sheet next to the rail. A tight rail
            gives it up first: two fingers on the sheet and Z still undo.
          -->
          <button
            type="button"
            class="{KEY} h-11 w-full text-muted"
            onclick={undoStroke}
            aria-label={tr('room.ui.166')}
          >
            <Icon name="undo" size={22} />
          </button>
        {/if}
      {/if}

      <span class="min-h-2 flex-1" aria-hidden="true"></span>

      {#if mayTurn}
        {@render sheetKey(key)}
        <span class="h-1 shrink-0" aria-hidden="true"></span>
      {/if}
      {#if preparing || leading}
        {@render deckKey(key)}
        <span class="h-1 shrink-0" aria-hidden="true"></span>
      {:else if watching}
        {@render grabKey('mx-1 h-[112px]')}
        <span class="h-1 shrink-0" aria-hidden="true"></span>
      {/if}
      {#if file !== null}
        <button
          type="button"
          class="{KEY} {key} {CAP} {notesOpen ? 'bg-raised text-ink' : 'text-muted'}"
          aria-label={tr('room.ui.173')}
          aria-pressed={notesOpen}
          onclick={() => setNotes(!notesOpen)}
        >
          {@render mark(notesOpen, false)} {tr('room.ui.173')} </button>
      {/if}
    </div>

    <div class="flex shrink-0 flex-col">
      <!-- The notch: the border between the "deck" and "page turning" families. -->
      <span class="{fit === 'roomy' ? 'h-4' : 'h-2'} shrink-0" aria-hidden="true"></span>
      {@render turnKeys(fit === 'roomy' ? 'h-[52px] w-full' : 'h-11 w-full', fit === 'roomy' ? 'h-24 w-full' : 'h-20 w-full', true)}
      <!-- Reserved for the home indicator: no key reaches in here. -->
      <span class="h-5 shrink-0" aria-hidden="true"></span>
    </div>
  </div>
{/snippet}

{#snippet teleRail()}
  <!--
    THE PROMPTER'S RAIL: no tools, because there is no paper. The gauge is
    back on top (the strip under the slide is not on screen), "Slide" gives
    the paper back, and the turn keys grow: in a prompter they are the only
    thing the thumb does.
  -->
  {@const roomy = fit === 'roomy'}
  <div
    use:swipe={() => 'y'}
    class="pult-rail flex w-[72px] shrink-0 flex-col bg-surface {hand === 'left'
      ? 'border-l'
      : 'border-r'} {offline ? 'border-danger/40' : 'border-line'}"
  >
    <div class="flex min-h-0 flex-1 flex-col overflow-hidden">
      {@render gauge()}
      {@render moreKey('h-11 w-full')}
      <span class="{roomy ? 'h-4' : 'h-2'} shrink-0" aria-hidden="true"></span>
      {@render slideViewKey(roomy ? 'h-[112px] w-full' : 'h-20 w-full', true)}
      <span class="min-h-2 flex-1" aria-hidden="true"></span>
      {#if preparing || leading}
        {@render deckKey(roomy ? 'h-14 w-full' : 'h-11 w-full')}
        <span class="h-1 shrink-0" aria-hidden="true"></span>
      {:else if watching}
        {@render grabKey('mx-1 h-[112px]')}
        <span class="h-1 shrink-0" aria-hidden="true"></span>
      {/if}
      <button
        type="button"
        class="{KEY} {roomy ? 'h-14' : 'h-11'} w-full bg-raised {CAP} text-ink"
        aria-label={tr('room.prompter.teleAria')}
        aria-pressed="true"
        onclick={() => setView('slide')}
      >
        {@render mark(true, false)}
        {tr('room.prompter.tele')}
      </button>
    </div>
    <div class="flex shrink-0 flex-col">
      <span class="{roomy ? 'h-4' : 'h-2'} shrink-0" aria-hidden="true"></span>
      {@render turnKeys(roomy ? 'h-[104px] w-full' : 'h-16 w-full', roomy ? 'h-[176px] w-full' : 'h-28 w-full', true)}
      <span class="h-5 shrink-0" aria-hidden="true"></span>
    </div>
  </div>
{/snippet}

{#snippet slideViewKey(size: string, column: boolean)}
  <!--
    Back from the prompter to the slide. A tiny slide is drawn on the key,
    not a word alone: it is the thing the key brings back.
  -->
  <button
    type="button"
    class="{KEY} {size} {column ? 'flex-col gap-2.5' : 'gap-2'} text-ink"
    aria-label={tr('room.prompter.slideAria')}
    onclick={() => setView('slide')}
  >
    <span class="pult-mini flex h-7 w-12 shrink-0 flex-col gap-[3px] bg-faint/60 p-1.5" aria-hidden="true">
      <span class="block h-[3px] w-[26px] bg-canvas"></span>
      <span class="block h-[2px] w-[30px] bg-canvas/60"></span>
      <span class="block h-[2px] w-[22px] bg-canvas/60"></span>
    </span>
    <span class="{CAP}">{tr('room.ui.167')}</span>
  </button>
{/snippet}

{#snippet bottomRail()}
  <!--
    THE BOTTOM RAIL in portrait, 64 px: the same sequence, laid on its side.
    The swipe on it runs along it, horizontally. Its widths follow `fit`: an
    iPad mini in portrait (744) and Split View (678) are narrower than the
    816 px the drawn keys need, and the turn keys at the end were the ones
    that went off the edge.
  -->
  {@const tool = fit === 'roomy' ? 'h-full w-[72px]' : fit === 'compact' ? 'h-full w-14' : 'h-full w-[52px]'}
  {@const deck = fit === 'roomy' ? 'h-full w-[72px]' : 'h-full w-[60px]'}
  <div
    use:swipe={() => 'x'}
    class="pult-rail flex h-16 shrink-0 items-stretch border-t bg-surface {offline
      ? 'border-danger/40'
      : 'border-line'}"
  >
    {@render gaugeFlat()}
    <span class="{fit === 'tight' ? 'w-2' : 'w-4'} shrink-0" aria-hidden="true"></span>
    {#if tele}
      {@render slideViewKey('h-full w-[104px]', false)}
    {:else if leading}
      {@render toolKeys(tool, 'w-0')}
      {#if fit !== 'tight'}
        <span class="w-2 shrink-0" aria-hidden="true"></span>
        <button
          type="button"
          class="{KEY} h-full {fit === 'roomy' ? 'w-12' : 'w-11'} text-muted"
          onclick={undoStroke}
          aria-label={tr('room.ui.166')}
        >
          <Icon name="undo" size={22} />
        </button>
      {/if}
    {/if}
    <span class="min-w-2 flex-1" aria-hidden="true"></span>
    {#if fit !== 'tight' && !tele}
      {@render sheetKey(deck)}
    {/if}
    {#if preparing || leading}
      {@render deckKey(deck)}
    {:else if watching}
      {@render grabKey('my-2 w-[104px]')}
    {/if}
    <span class="{fit === 'tight' ? 'w-2' : 'w-4'} shrink-0" aria-hidden="true"></span>
    {@render turnKeys(
      fit === 'roomy' ? 'h-full w-16' : 'h-full w-[52px]',
      fit === 'roomy' ? 'h-full w-[112px]' : fit === 'compact' ? 'h-full w-[88px]' : 'h-full w-20',
      false,
    )}
  </div>
{/snippet}

<!-- ============================================================= palette -->

{#snippet laserPop()}
  <!--
    The pointer palette. The same box as the pen's, and the same measure: one
    form of choice for the whole console. Two rows, because there are exactly
    two things to choose from here, and each has its own name and its own
    picture, not a label under an obscure icon.
  -->
  <div
    class="pointer-events-none absolute z-20 flex w-[268px] flex-col border border-line bg-surface p-3"
    style={portrait
      ? `left: calc(120px + env(safe-area-inset-left)); bottom: calc(76px + env(safe-area-inset-bottom))`
      : hand === 'left'
        ? `right: calc(84px + env(safe-area-inset-right)); top: calc(136px + env(safe-area-inset-top))`
        : `left: calc(84px + env(safe-area-inset-left)); top: calc(136px + env(safe-area-inset-top))`}
    data-pult-palette
  >
    <div class="flex flex-col" role="radiogroup" aria-label={tr('room.ui.165')}>
      {#each [{ id: 'line', name: tr('room.ui.180'), says: tr('room.ui.181') }, { id: 'dot', name: tr('room.ui.182'), says: tr('room.ui.183') }] as choice (choice.id)}
        {@const on = laserShape === choice.id}
        <button
          type="button"
          role="radio"
          aria-checked={on}
          aria-label={choice.name}
          class="{PRESS} pointer-events-auto flex h-12 items-center gap-3 px-2 {on ? 'bg-raised' : ''} active:bg-line"
          onclick={() => (laserShape = choice.id as 'dot' | 'line')}
        >
          <!-- The picture draws exactly what will happen on the sheet: a line
               with a fading tail, or a single dot. -->
          <svg width="40" height="20" viewBox="0 0 40 20" class="block shrink-0" aria-hidden="true">
            {#if choice.id === 'line'}
              <path
                d="M4 14 C 12 4, 20 18, 36 7"
                fill="none"
                stroke={LASER_RED}
                stroke-width="3"
                stroke-linecap="round"
                opacity="0.45"
              />
              <circle cx="36" cy="7" r="3.4" fill={LASER_RED} />
            {:else}
              <circle cx="20" cy="10" r="3.4" fill={LASER_RED} />
              <circle cx="20" cy="10" r="7.5" fill={LASER_RED} opacity="0.22" />
            {/if}
          </svg>
          <span class="{on ? 'text-ink' : 'text-muted'} text-ui-lg">{choice.name}</span>
          <span class="{CAP} ml-auto text-muted">{choice.says}</span>
        </button>
      {/each}
    </div>
  </div>
{/snippet}

{#snippet palettePop()}
  <!--
    THE PEN PALETTE: colour and thickness, 232×120. It stands next to the
    "Pen" key (to the right of the rail at its height in landscape, or above
    the rail in portrait) rather than as a sheet from below: this is a tool
    setting, and the eye must not leave the hand. There is no backdrop under
    it: a tap elsewhere closes it through the interceptor on the root (see
    the effect at `palette`) and carries on, onto the sheet, onto a key,
    wherever it landed; a backdrop button across the whole console ate the
    first stroke.

    The palette's body is TRANSPARENT to the pointer; only its buttons can be
    pressed: the palette hangs over the paper, and a pen that landed in its
    padding or a gap used to go into the body: the stroke was not drawn and
    the palette did not close. Now such a pen reaches the input layer, and
    the interceptor closes the palette.
  -->
  <div
    class="pointer-events-none absolute z-20 flex w-[268px] flex-col gap-2.5 border border-line bg-surface p-3"
    style={portrait
      ? `left: calc(120px + env(safe-area-inset-left)); bottom: calc(76px + env(safe-area-inset-bottom))`
      : hand === 'left'
        ? `right: calc(84px + env(safe-area-inset-right)); top: calc(136px + env(safe-area-inset-top))`
        : `left: calc(84px + env(safe-area-inset-left)); top: calc(136px + env(safe-area-inset-top))`}
    data-pult-palette
  >
    <!--
      Colours as circles in one row, as in any note-taking app: a colour is
      shown by colour, not by a label. The chosen one is outlined with a ring
      of ink rather than filled with a slab: a slab under a coloured circle
      argues with the circle itself, and at a glance it is unclear what is
      chosen here, the colour or the tile.
    -->
    <div class="flex justify-between" role="radiogroup" aria-label={tr('room.ui.184')}>
      {#each INKS as choice (choice.color)}
        {@const on = inkColor === choice.color}
        <button
          type="button"
          role="radio"
          aria-checked={on}
          aria-label={choice.name}
          class="{PRESS} pointer-events-auto flex h-11 w-11 items-center justify-center"
          onclick={() => penIn(choice.color)}
        >
          <span
            class="block h-7 w-7 rounded-full {on ? 'ring-2 ring-ink ring-offset-2 ring-offset-surface' : ''}"
            style={`background:${choice.color}`}
            aria-hidden="true"
          ></span>
        </button>
      {/each}
    </div>
    <span class="h-px bg-line" aria-hidden="true"></span>
    <!--
      Thickness as dots of real size, left to right in increasing order. The
      ring is the same as for colour: one form of choice for the whole
      palette.
    -->
    <div class="flex items-center justify-between" role="radiogroup" aria-label={tr('room.ui.186')}>
      {#each WIDTHS as choice (choice.width)}
        {@const on = penWidth === choice.width}
        <button
          type="button"
          role="radio"
          aria-checked={on}
          aria-label={choice.name}
          class="{PRESS} pointer-events-auto flex h-11 w-11 items-center justify-center"
          onclick={() => penWide(choice.width)}
        >
          <!-- The dot is ink-coloured, NOT the pen's colour: this row is about
               size, the colour is stated next to it. A coloured dot on the
               night body also drowns: the black pen would give five invisible
               circles. -->
          <span
            class="block rounded-full {on
              ? 'bg-ink ring-2 ring-ink ring-offset-[6px] ring-offset-surface'
              : 'bg-muted'}"
            style={`width:${dotOf(choice.width)}px;height:${dotOf(choice.width)}px`}
            aria-hidden="true"
          ></span>
        </button>
      {/each}
    </div>
  </div>
{/snippet}

<!-- =============================================================== sheet -->

{#snippet sheetOver(size: { w: number; h: number })}
  <!--
    Everything that lies ON the sheet, in one place and in drawing order.

    1. The blanking veil: the canvas at 0.28, the ink at 1.0: a drawing is
       prepared under blanking and the pause is lifted with it already
       there. A well-coloured veil at 0.72 UNDER the ink layer gives exactly
       that frame.
    2. The ink: three canvases and the input layer, owner of all touches on
       the sheet.
    3. The fader veil: over the sheet AND the ink, inside the sheet.
    4. Feathering: a 1 px `line` edge and 6 px of paper shadow on the well.
    5. The "the audience sees black" slab and a full-sheet target.
  -->
  {#if lecture?.blank}
    <span class="pointer-events-none absolute inset-0 bg-canvas opacity-[0.72]" aria-hidden="true"
    ></span>
  {/if}

  <InkLayer
    page={shown ?? wanted}
    live={canDraw && (sheetReady || liveTool === 'laser')}
    tool={liveTool}
    {laserShape}
    color={strokeColor}
    width={strokeWidth}
    finger={fingerOn}
    w={size.w}
    h={size.h}
    reach={inkReach(size)}
    {onbusy}
    onundo={undoStroke}
    onpen={penFound}
    onrefuse={(says) => say(says, 'refusal')}
  />

  <!--
    `data-pult-veil` is a marker for the interface check: TWO well-coloured
    veils lie over the sheet, and the marker is on exactly the one the fader
    controls. 320 ms: theatre faders do not click.
  -->
  <span
    class="pult-veil pointer-events-none absolute inset-0 bg-canvas"
    style={`opacity:${veil}`}
    data-pult-veil
    aria-hidden="true"
  ></span>

  <span class="pult-halo pointer-events-none absolute inset-0" aria-hidden="true"></span>

  {#if lecture?.blank}
    <!--
      The target is a 320×56 SLAB at the bottom of the sheet, not the whole
      sheet. It used to be full-sheet "so it can be hit without looking", and
      that cancelled the very reason for blanking: hide from the audience,
      prepare a derivation with the pen, show it; the first pen touch brought
      the projection back and drew nothing, and a stray palm lifted the
      blanking. Bottom centre: neither a right-hander's nor a left-hander's
      heel lands there, and that is where people look when searching for
      "restore".
    -->
    <button
      type="button"
      class="{PRESS} absolute bottom-6 left-1/2 z-10 flex h-[56px] w-[320px] -translate-x-1/2 flex-col items-center justify-center gap-1 border border-line bg-surface/[0.88]"
      onclick={() => blank(false)}
      disabled={!leading || offline}
    >
      <span class="{CAP} text-warning">{tr('room.ui.188')}</span>
      <span class="{SECTION} text-muted">{tr('room.ui.189')}</span>
    </button>
  {/if}
{/snippet}

{#snippet sheet()}
  {#if failure}
    <!--
      YOUR copy did not open (an expired token, a broken network, a corrupt
      cache), while at the projector the document is most likely open. So
      the rail, the number and the notes keep working: taking away control
      because of our own failure is the worst thing the console can do.
    -->
    <div class="flex h-full flex-col items-center justify-center gap-3 p-6 text-center">
      <Icon name="alert" size={24} class="text-danger" />
      <p class="text-answer text-ink">{tr('room.ui.190')}</p>
      <p class="font-mono text-code text-muted">{file}</p>
      <div class="mt-3 flex gap-3">
        <button
          type="button"
          class="{PRESS} flex h-12 w-[176px] items-center justify-center border border-line {CAP} text-muted"
          onclick={() => (attempt += 1)}
        > {tr('room.ui.191')} </button>
        <button
          type="button"
          class="{PRESS} flex h-12 w-[176px] items-center justify-center border border-line {CAP} text-muted"
          onclick={() => openPane('files')}
        > {tr('room.ui.192')} </button>
      </div>
    </div>
  {:else}
    <!--
      The sheet is pinned to the TOP of the box, not the centre: the
      remainder under it is one armrest for the palm, not two identical gaps.
      In portrait the armrest is held as padding, so a box made smaller by
      the divider shrinks the page and keeps the armrest.
    -->
    <div
      class="flex h-full min-h-0 min-w-0 flex-col"
      style={portrait ? `padding-bottom:${PALM_REST}px` : undefined}
    >
      <LecturePage {doc} page={wanted} bare align="top" {onfit} {onshown}>
        {#snippet over(size)}
          {@render sheetOver(size)}
        {/snippet}
      </LecturePage>
    </div>
  {/if}

  <!-- The toast is in the bottom left corner of the sheet box, where neither a
       palm nor a pen lands, and it lets every touch through. -->
  <div class="pointer-events-none absolute bottom-2 left-2 z-10">
    {@render toast()}
  </div>
{/snippet}

<!-- ============================================================ reading -->

{#snippet readingStrip()}
  <!--
    THE READING STRIP under the slide: the page, the time and the plan, and
    "next" as a picture. These were the old rail gauge and the notes peek;
    under the slide they are where the eye already is between sentences, and
    the rail is left to the hand.

    Guarded (`data-pult-guard`): it lies under the slide's bottom edge, where
    the writing palm goes, and touches here are swallowed while the pen is
    busy or was lifted less than 600 ms ago. Only the page block can be
    pressed (it opens the page strip, as the gauge did); the rest is reading.
  -->
  <div
    class="flex shrink-0 items-end {fit === 'roomy' ? 'gap-12' : 'gap-8'} px-3 pb-5 pt-2"
    style={`height:${stripH}px`}
    data-pult-guard
    data-pult-strip
  >
    <button
      type="button"
      class="{PRESS} flex shrink-0 flex-col items-start gap-1.5 pl-1 text-left enabled:active:bg-line"
      aria-label={tr('room.ui.156')}
      onclick={() => openPane('pages')}
    >
      <span class="flex h-[14px] items-center gap-2 {LABEL} text-faint">
        {onBoard ? tr('room.ui.159') : tr('room.prompter.slide')}
        {#if behind && lecture}
          <!-- What the audience sees while the projector catches up. -->
          <span class="font-mono text-code font-normal normal-case tracking-normal text-muted">
            {lecture.page < 0 ? tr('room.ui.157', { p0: -lecture.page }) : lecture.page}&nbsp;→
          </span>
        {/if}
      </span>
      <span class="flex items-baseline gap-2">
        <span class="font-mono text-gauge-lg tabular-nums {watching || preparing ? 'text-muted' : 'text-ink'}">
          {onBoard ? tr('room.ui.158', { p0: -wanted }) : wanted}
        </span>
        {#if !onBoard}
          <span class="font-mono text-title tabular-nums text-faint">/ {pages || '—'}</span>
        {/if}
      </span>
      <span class="flex h-4 items-center">
        {#if !onBoard}{@render tempo('w-[112px]')}{/if}
      </span>
    </button>

    <div class="flex min-w-0 shrink-0 flex-col gap-1.5">
      <span class="flex h-[14px] items-center {LABEL} text-faint">{tr('room.prompter.time')}</span>
      <span class="font-mono text-gauge-lg tabular-nums {preparing ? 'text-muted' : 'text-ink'}">
        {preparing ? '—' : stopwatch(runningFor)}
      </span>
      <span class="flex h-4 items-center font-mono text-code tabular-nums {late ? 'text-warning' : 'text-muted'}">
        {#if preparing}
          {tr('room.ui.160')}
        {:else if plan !== null}
          {tr('room.prompter.plan', { time: stopwatch(plan * 1000) })}
        {:else}
          {tr('room.prompter.now', { time: wall })}
        {/if}
      </span>
    </div>

    <span class="min-w-0 flex-1" aria-hidden="true"></span>

    {#if doc && nextPage !== null && !tiny && thumbH >= 56}
      <!-- "What comes next" is a reading, like the number; it cannot be pressed. -->
      <div class="pointer-events-none flex shrink-0 flex-col gap-1.5" data-pult-next aria-hidden="true">
        <span class="relative flex bg-white" style={`width:${thumbW}px;height:${thumbH}px`}>
          <LecturePage {doc} page={nextPage} bare />
          <span
            class="pult-veil pointer-events-none absolute inset-0 bg-canvas"
            style={`opacity:${veil}`}
            aria-hidden="true"
          ></span>
        </span>
        <span class="flex h-4 items-center {LABEL} text-faint">{tr('room.prompter.nextNo', { n: nextPage })}</span>
      </div>
    {/if}
  </div>
{/snippet}

{#snippet sizeKeys(kind: 'boxed' | 'flat' | 'big')}
  <!--
    A− and A+, remembered per device. Two keys instead of the old cycling
    "A↕": a cycle that wraps from the largest size to the smallest is a jump
    nobody asked for, in the middle of a sentence.
  -->
  {@const steps = tele ? TELE_SIZES.length : NOTE_SIZES.length}
  {@const at = tele ? teleStep : noteStep}
  {@const cell =
    kind === 'boxed' ? 'h-9 w-11' : kind === 'flat' ? 'h-12 w-12' : 'h-14 w-16 border border-line'}
  <div class="flex shrink-0 items-center {kind === 'boxed' ? 'border border-line' : kind === 'big' ? 'gap-1' : ''}">
    <button
      type="button"
      class="{PRESS} flex {cell} items-center justify-center font-bold text-muted enabled:active:bg-line disabled:text-faint/60 {kind ===
      'big'
        ? 'text-title'
        : 'text-ui-lg'}"
      aria-label={tr('room.prompter.smaller')}
      disabled={at <= 0}
      onclick={() => resize(-1)}
    >A−</button>
    {#if kind === 'boxed'}<span class="h-9 w-px bg-line" aria-hidden="true"></span>{/if}
    <button
      type="button"
      class="{PRESS} flex {cell} items-center justify-center font-bold text-ink enabled:active:bg-line disabled:text-faint/60 {kind ===
      'big'
        ? 'text-head'
        : 'text-[19px]'}"
      aria-label={tr('room.prompter.bigger')}
      disabled={at >= steps - 1}
      onclick={() => resize(1)}
    >A+</button>
  </div>
{/snippet}

{#snippet fullscreenKey()}
  <!--
    Full screen from the notes header: a 44 px key at the far end, away from
    the slide. Never on the sheet: in its corner the key covered the peek and
    sat in the portrait armrest, where the writing palm lands.
  -->
  {#if fullscreenPossible() && !full}
    <button
      type="button"
      class="{KEY} h-11 w-11 text-muted"
      aria-label={tr('room.ui.193')}
      title={tr('room.ui.193')}
      onclick={toggleFullscreen}
    >
      <Icon name="expand" size={18} />
    </button>
  {/if}
{/snippet}

{#snippet nextFooter(kind: 'column' | 'dock')}
  <!--
    "NEXT" IN WORDS: the next slide's title from the PDF and the first line
    of its note. A thumbnail answers "what comes next" only for someone who
    looks at it long enough; the title is read in the glance the presenter
    has. A deck without text (scans) has no titles, and then the note's line
    speaks alone, or the number.
  -->
  {@const main = nextPage === null ? '' : nextTitle || nextWords || tr('room.prompter.slideNo', { n: nextPage })}
  {@const sub = nextTitle ? nextWords : ''}
  {#if kind === 'column'}
    <div
      class="flex shrink-0 flex-col gap-2 border-t border-line bg-surface px-7 pb-6 pt-[18px]"
      data-pult-next
    >
      {#if onBoard}
        <span class="{LABEL} text-faint">{tr('room.prompter.back', { n: lastSlide })}</span>
      {:else if nextPage === null}
        <span class="{LABEL} text-faint">{tr('room.prompter.last')}</span>
      {:else}
        <span class="flex items-center gap-2.5 {LABEL} text-faint">
          {tr('room.prompter.nextNo', { n: nextPage })}
          <Icon name="arrow-right" size={14} />
        </span>
        <span class="line-clamp-2 text-title font-semibold text-ink">{main}</span>
        {#if sub}
          <span class="truncate text-[16px] leading-[22px] text-muted">{sub}</span>
        {/if}
      {/if}
    </div>
  {:else}
    <div class="flex h-14 shrink-0 items-center gap-3.5 border-t border-line px-8" data-pult-next>
      {#if onBoard}
        <span class="{LABEL} text-muted">{tr('room.prompter.back', { n: lastSlide })}</span>
      {:else if nextPage === null}
        <span class="{LABEL} text-muted">{tr('room.prompter.last')}</span>
      {:else}
        <span class="shrink-0 {LABEL} text-muted">{tr('room.prompter.next')}</span>
        <span class="shrink-0 font-mono text-ui tabular-nums text-faint">{nextPage}</span>
        <span class="min-w-0 flex-1 truncate text-title font-semibold text-ink">{main}</span>
        {#if thenPage !== null && thenTitle && fit === 'roomy'}
          <span class="max-w-[40%] shrink truncate text-ui-lg text-faint">
            {tr('room.prompter.thenLine', { n: thenPage, title: thenTitle })}
          </span>
        {/if}
      {/if}
    </div>
  {/if}
{/snippet}

{#snippet notesColumn()}
  <!--
    THE NOTES COLUMN (landscape), about a third of the window: a header with
    the slide's number and budget, the reader with its own scroll, and "next"
    in words at the bottom. Opaque and beside the paper: the old sheet was
    96 % opaque over the bottom third of the slide, and the slide's text bled
    through the talk.

    While preparing there is no lecture and no ink, so the column is the
    editor: Scribble and the keyboard are welcome there, and notes for
    tomorrow are written on the device they will be read from.
  -->
  <aside
    class="flex min-h-0 shrink-0 flex-col bg-canvas {hand === 'left' ? 'border-r' : 'border-l'} border-line"
    style={`width:${columnW}px`}
    aria-label={tr('room.ui.173')}
    data-pult-notes
    data-pult-guard
  >
    {#if preparing}
      <NotesPad file={file ?? ''} page={wanted} folded={false} docked />
    {:else}
      <header class="flex h-16 shrink-0 items-center gap-2.5 pl-7 pr-3">
        <span class="shrink-0 whitespace-nowrap {LABEL} text-ink">
          {onBoard ? tr('room.prompter.sheetNo', { n: -wanted }) : tr('room.prompter.slideNo', { n: wanted })}
        </span>
        {#if budgetLabel}
          <span class="h-3 w-0.5 shrink-0 bg-accent" aria-hidden="true"></span>
          <span class="shrink-0 whitespace-nowrap {LABEL} text-muted">{budgetLabel}</span>
        {/if}
        <span class="min-w-0 flex-1" aria-hidden="true"></span>
        {@render sizeKeys('boxed')}
        <!-- An iPad mini's column has no room for it: "More" keeps it. -->
        {#if columnW >= 370}{@render fullscreenKey()}{/if}
      </header>
      <NotesReader
        text={note}
        arrived={notesHere}
        {onBoard}
        size={noteSize}
        place={notePlace}
        narrow
        pad="pl-7 pr-9"
      />
      {@render nextFooter('column')}
    {/if}
  </aside>
{/snippet}

{#snippet divider()}
  <!--
    THE DIVIDER between the slide and the notes in portrait: drag it up for
    more notes, down for more slide (up to the slide's natural height), a
    double tap gives the slide its height back. 28 px tall, the whole width:
    a target found without looking. Guarded like the rail: it lies right
    under the armrest, and a palm sliding off the slide must not drag it.

    A focusable separator with a value is the ARIA window-splitter widget
    (arrows move it), which the linter takes for a plain non-interactive one.
  -->
  <!-- svelte-ignore a11y_no_noninteractive_tabindex, a11y_no_noninteractive_element_interactions -->
  <div
    class="relative flex h-7 shrink-0 cursor-row-resize items-center justify-center border-t border-line"
    role="separator"
    aria-orientation="horizontal"
    aria-label={tr('room.prompter.divider')}
    aria-valuemin={0}
    aria-valuemax={100}
    aria-valuenow={box.h > 0 ? Math.round((portraitSheetH / box.h) * 100) : 0}
    tabindex="0"
    style="touch-action: none"
    data-pult-guard
    onpointerdown={dividerDown}
    onkeydown={dividerKey}
    ondblclick={dividerReset}
  >
    {#if fit !== 'tight'}
      <span class="absolute right-[calc(50%+40px)] flex items-center gap-1.5 font-mono text-micro uppercase tracking-label text-faint">
        <Icon name="chevron-up" size={12} />
        {tr('room.prompter.up')}
      </span>
    {/if}
    <span class="flex flex-col gap-1" aria-hidden="true">
      <span class="block h-0.5 w-10 bg-muted"></span>
      <span class="block h-0.5 w-10 bg-muted"></span>
    </span>
    {#if fit !== 'tight'}
      <span class="absolute left-[calc(50%+40px)] flex items-center gap-1.5 font-mono text-micro uppercase tracking-label text-faint">
        {tr('room.prompter.down')}
        <Icon name="chevron-down" size={12} />
      </span>
    {/if}
  </div>
{/snippet}

{#snippet slideClock(compact: boolean, withClass: boolean)}
  <!-- "24:07 · on slide 0:48 / 1:12": the class and this slide against its budget. -->
  {#if withClass}
    <span class="font-mono text-ui tabular-nums text-ink">{preparing ? tr('room.ui.160') : stopwatch(runningFor)}</span>
  {/if}
  {#if !preparing && !compact}
    <span class="truncate font-mono text-code tabular-nums text-faint">
      {tr('room.prompter.onSlideShort', {
        spent: budget && budget.seconds > 0
          ? `${stopwatch(onPageFor)} / ${stopwatch(budget.seconds * 1000)}`
          : stopwatch(onPageFor),
      })}
    </span>
  {/if}
{/snippet}

{#snippet dock()}
  <!--
    THE DOCKED NOTES in portrait: a 48 header (name, the class clock and this
    slide's, the size keys, the prompter, "More"), the reader, and "next" in
    one line. "More" is here and not on the bottom rail: the dock is always
    on screen in portrait, and the rail has no width to spare.
  -->
  {#if preparing}
    <NotesPad file={file ?? ''} page={wanted} folded={false} docked onmore={() => openPane('more')} />
  {:else}
    <header class="flex h-12 shrink-0 items-center gap-2.5 pl-8 pr-3">
      <span class="{SECTION} text-muted">{tr('room.ui.194')}</span>
      <span class="h-3 w-0.5 shrink-0 bg-accent" aria-hidden="true"></span>
      {@render slideClock(fit === 'tight', true)}
      <span class="min-w-0 flex-1" aria-hidden="true"></span>
      {@render sizeKeys('flat')}
      <span class="h-5 w-px shrink-0 bg-line" aria-hidden="true"></span>
      <button
        type="button"
        class="{KEY} h-12 gap-2 px-3 {CAP} text-muted"
        aria-label={tr('room.prompter.teleAria')}
        aria-pressed="false"
        onclick={() => setView('tele')}
      >
        <!--
          Arrows apart along the diagonal, as in the drawing: "this grows to
          the whole screen". Not the `expand` corners, which are the
          fullscreen key next to it: two keys with one glyph are one key
          pressed by mistake.
        -->
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"
          stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <path d="M14 4h6v6M10 20H4v-6M20 4l-7 7M4 20l7-7" />
        </svg>
        {#if fit !== 'tight'}{tr('room.prompter.tele')}{/if}
      </button>
      {@render fullscreenKey()}
      {@render moreKey('h-12 w-11')}
    </header>
    <NotesReader
      text={note}
      arrived={notesHere}
      {onBoard}
      size={noteSize}
      place={notePlace}
      timing={budgetLabel}
      pad="px-8"
    />
    {@render nextFooter('dock')}
  {/if}
{/snippet}

{#snippet teleBody()}
  <!--
    THE PROMPTER'S PAGE. The text column with the current slide's title on
    top; beside it (landscape) the slide as a thumbnail, the class clock and
    this slide's against its budget, and the size keys; under it "next" and
    "then" in words. In portrait the side column becomes a row on top.
  -->
  {@const title = onBoard ? tr('room.prompter.sheetNo', { n: -wanted }) : titles[wanted] || tr('room.prompter.slideNo', { n: wanted })}
  <div class="flex min-h-0 min-w-0 flex-1 flex-col bg-canvas" data-pult-notes data-pult-guard>
    {#if portrait}
      <div class="flex shrink-0 items-center gap-5 border-b border-line px-6 py-4">
        {@render teleThumb(160, 90)}
        <div class="flex min-w-0 flex-1 flex-col gap-1">
          <span class="font-mono text-gauge tabular-nums text-ink">{preparing ? '—' : stopwatch(runningFor)}</span>
          <span class="flex items-center gap-2.5">{@render slideClock(false, false)}</span>
        </div>
        {@render sizeKeys('flat')}
        {@render moreKey('h-12 w-11')}
      </div>
    {/if}
    <div class="flex min-h-0 flex-1">
      <div class="flex min-h-0 min-w-0 flex-1 flex-col {portrait ? 'pt-6' : 'pt-9'}">
        <p class="shrink-0 truncate pb-3 {portrait ? 'px-8' : 'pl-16 pr-12'} text-[17px] font-semibold leading-5 text-muted">
          {title}
        </p>
        <NotesReader
          text={note}
          arrived={notesHere}
          {onBoard}
          size={teleSize}
          place={notePlace}
          timing={budgetLabel}
          asksOpen
          pad={portrait ? 'px-8' : 'pl-16 pr-12'}
          measure={760}
        />
      </div>
      {#if !portrait}
        <div class="flex w-[304px] shrink-0 flex-col gap-7 p-6">
          <div class="flex shrink-0 flex-col gap-2.5">
            {@render teleThumb(256, 144)}
            <div class="flex h-8 items-center justify-between pt-1">
              <span class="flex items-baseline gap-1.5 font-mono tabular-nums">
                <span class="text-head text-ink">{onBoard ? tr('room.ui.158', { p0: -wanted }) : wanted}</span>
                {#if !onBoard}<span class="text-ui text-faint">/ {pages || '—'}</span>{/if}
              </span>
              <button
                type="button"
                class="{PRESS} flex h-11 items-center gap-1.5 px-2 {CAP} text-ink enabled:active:bg-line"
                aria-label={tr('room.prompter.slideAria')}
                onclick={() => setView('slide')}
              >
                <Icon name="undo" size={16} />
                {tr('room.ui.176')}
              </button>
            </div>
          </div>
          <div class="flex shrink-0 flex-col gap-1.5 border-t border-line pt-5">
            <span class="{LABEL} font-normal text-muted">{preparing ? tr('room.ui.160') : tr('room.ui.214')}</span>
            <span class="font-mono text-gauge-lg tabular-nums text-ink">{preparing ? '—' : stopwatch(runningFor)}</span>
            {#if !preparing}
              <div class="flex items-baseline justify-between pt-1.5">
                <span class="text-[15px] leading-5 text-muted">{tr('room.prompter.onSlide')}</span>
                <span class="font-mono text-ui-lg tabular-nums text-ink">
                  {stopwatch(onPageFor)}{budget && budget.seconds > 0 ? ` / ${stopwatch(budget.seconds * 1000)}` : ''}
                </span>
              </div>
              {#if budget && budget.seconds > 0}
                <span class="block h-0.5 w-full bg-line" aria-hidden="true">
                  <span
                    class="block h-full {onPageFor > budget.seconds * 1000 ? 'bg-warning' : 'bg-muted'}"
                    style={`width:${Math.min(100, (onPageFor / (budget.seconds * 1000)) * 100)}%`}
                  ></span>
                </span>
              {/if}
              {#if plan !== null}
                <span class="pt-1 font-mono text-code tabular-nums {late ? 'text-warning' : 'text-muted'}">
                  {tr('room.prompter.plan', { time: stopwatch(plan * 1000) })}
                </span>
              {/if}
            {/if}
          </div>
          <span class="min-h-2 flex-1" aria-hidden="true"></span>
          <div class="flex shrink-0 items-center">
            {@render sizeKeys('big')}
            <div class="flex flex-col gap-0.5 pl-3">
              <span class="{LABEL} font-normal text-faint">{tr('room.prompter.size')}</span>
              <span class="font-mono text-ui-lg tabular-nums text-muted">
                {teleSize} / {TELE_SIZES[TELE_SIZES.length - 1]}
              </span>
            </div>
          </div>
        </div>
      {/if}
    </div>
    <div
      class="flex {portrait ? 'h-14 px-8' : 'h-[104px] pl-16'} shrink-0 items-center gap-5 border-t border-line bg-surface"
      data-pult-next
    >
      {#if onBoard}
        <span class="{LABEL} text-muted">{tr('room.prompter.back', { n: lastSlide })}</span>
      {:else if nextPage === null}
        <span class="{LABEL} text-muted">{tr('room.prompter.last')}</span>
      {:else}
        <span class="w-[72px] shrink-0 {LABEL} font-normal text-muted">{tr('room.prompter.next')}</span>
        <span class="shrink-0 font-mono text-[15px] tabular-nums text-faint">{nextPage}</span>
        <span class="min-w-0 flex-1 truncate {portrait ? 'text-title' : 'text-[22px] leading-7'} font-semibold text-ink">
          {nextTitle || nextWords || tr('room.prompter.slideNo', { n: nextPage })}
        </span>
        {#if thenPage !== null && !portrait}
          <div class="flex h-14 w-[272px] shrink-0 flex-col justify-center gap-1 border-l border-line pl-5">
            <span class="{LABEL} font-normal text-faint">{tr('room.prompter.thenNo', { n: thenPage })}</span>
            <span class="truncate text-[15px] leading-5 text-muted">
              {thenTitle || tr('room.prompter.slideNo', { n: thenPage })}
            </span>
          </div>
        {/if}
      {/if}
      {#if !portrait && mayTurn}
        <button
          type="button"
          class="{KEY} ml-auto h-full w-[88px] border-l border-line text-ink disabled:text-faint/70"
          disabled={!onBoard && pages > 0 && wanted >= pages}
          aria-label={tr('room.ui.175')}
          onclick={() => step(1)}
        >
          <Icon name="chevron-right" size={32} />
        </button>
      {/if}
    </div>
  </div>
{/snippet}

{#snippet teleThumb(w: number, h: number)}
  <!-- The slide on the projector right now, small: the prompter's only picture. -->
  <span class="pult-halo-sm relative flex shrink-0 bg-white" style={`width:${w}px;height:${h}px`}>
    {#if doc && !onBoard}
      <LecturePage {doc} page={wanted} bare />
    {/if}
    <span class="pult-veil pointer-events-none absolute inset-0 bg-canvas" style={`opacity:${veil}`} aria-hidden="true"></span>
  </span>
{/snippet}

<!-- ===================================================== document picker -->

{#snippet fileList(onpick: (path: string) => void, withNotes: boolean)}
  {#if slides.length === 0}
    <p class="px-1 py-6 text-answer text-muted"> {tr('room.ui.198')} </p>
  {:else}
    <ul>
      {#each slides as entry (entry.path)}
        {@const going = lecture?.file === entry.path}
        <li class="relative flex items-stretch border-b border-line-soft">
          {#if going}
            <!-- The running lecture is the only coloured thing on this screen. -->
            <span class="absolute inset-y-0 left-0 w-[4px] bg-accent" aria-hidden="true"></span>
          {/if}
          <!--
            A press on the running lecture reads as "make sure the right
            document is open". The server does not carry out such a press at
            all, but a silent refusal looks like a breakage, so the row itself
            says that it is already open and there is no need to press it.
          -->
          <button
            type="button"
            class="{PRESS} flex h-[88px] min-w-0 flex-1 flex-col justify-center gap-1 px-4 text-left disabled:opacity-60"
            disabled={going}
            onclick={() => onpick(entry.path)}
          >
            <span class="truncate text-head font-semibold text-ink">{entry.name}</span>
            <span class="truncate font-mono text-code text-muted">
              {going ? tr('room.ui.199') : entry.path}
            </span>
          </button>
          {#if withNotes}
            <button
              type="button"
              class="{PRESS} flex h-[88px] w-[88px] shrink-0 items-center justify-center border-l border-line-soft {CAP} text-muted"
              onclick={() => (prep = entry.path)}
            > {tr('room.ui.173')} </button>
          {/if}
        </li>
      {/each}
    </ul>
  {/if}
{/snippet}

{#snippet chooser()}
  <!--
    THERE IS NO LECTURE. The rail is not drawn at all: an empty rail looks
    like a broken console. The ground stays night: people come here from a
    lit corridor, and let the eyes adapt during setup, not on the first
    slide.
  -->
  <div class="flex min-h-0 flex-1 justify-center overflow-y-auto px-6 pb-10 pt-12">
    <div class="w-full max-w-[720px]">
      <h2 class="pb-3 {SECTION} text-muted">{tr('room.ui.200')}</h2>
      <div class="border-t border-line-soft">
        {@render fileList(start, true)}
      </div>

      <!--
        Settings that must not exist during a lecture. The hand is chosen
        before the tablet is picked up, not from a sheet mid-class.
      -->
      <div class="mt-8 flex items-stretch border-y border-line-soft">
        <button
          type="button"
          class="{PRESS} flex h-16 flex-1 items-center gap-3 px-4 {CAP} text-muted"
          aria-pressed={hand === 'left'}
          onclick={() => setHand(hand === 'left' ? 'right' : 'left')}
        >
          <span class="flex-1 text-left">{tr('room.ui.201')}</span>
          <span class={hand === 'left' ? 'text-ink' : 'text-muted'}>
            {hand === 'left' ? tr('room.ui.202') : tr('room.ui.203')}
          </span>
        </button>
        {#if fullscreenPossible()}
          <button
            type="button"
            class="{PRESS} flex h-16 w-[200px] shrink-0 items-center justify-center border-l border-line-soft {CAP} text-muted"
            aria-pressed={full}
            onclick={toggleFullscreen}
          >
            {full ? tr('room.ui.204') : tr('room.ui.193')}
          </button>
        {/if}
      </div>

      <p class="pt-6 {CAP} text-muted">{tr('room.ui.205')}</p>

      <div class="pt-6">{@render toast()}</div>
    </div>
  </div>
{/snippet}

<!-- ============================================================== sheets -->

{#snippet panes()}
  {#if pane !== null}
    <!--
      The backdrop swallows a press outside the sheet: it can close the sheet
      as well as Escape. The colour is the well at 0.72; the old `bg-ink/28`
      on the dark branch BRIGHTENED the screen when a sheet was raised,
      because `ink` there is #E6E7E8.
    -->
    <div class="absolute inset-0 z-30 flex flex-col justify-end">
      <button
        type="button"
        class="pult-scrim absolute inset-0 bg-canvas/[0.72]"
        aria-label={tr('room.ui.141')}
        onclick={() => openPane(null)}
      ></button>

      <div class="pult-drawer relative max-h-full overflow-y-auto border-t border-line bg-surface">
        {#if pane === 'pages'}
          <div class="flex h-10 items-center justify-between px-6">
            <span class="{SECTION} text-muted">{tr('room.ui.206')}</span>
            <button
              type="button"
              class="{PRESS} h-10 px-2 {CAP} text-muted"
              onclick={() => openPane(null)}
            > {tr('room.ui.29')} </button>
          </div>
          <div
            bind:this={strip}
            class="flex items-start gap-2 overflow-x-auto px-6 pb-6"
            onscroll={(event) => scanStrip(event.currentTarget)}
          >
            {#each pageList as index (index)}
              <button
                type="button"
                class="{PRESS} flex shrink-0 flex-col items-center gap-1 border-b-[3px] {index ===
                wanted
                  ? 'border-ink'
                  : 'border-transparent'}"
                onclick={() => {
                  goTo(index)
                  openPane(null)
                }}
              >
                <!-- The thumbnails' backing is not white: twenty-four white
                     rectangles in a strip are 195,000 px² of pure white while
                     the strip is open. The thumbnails themselves follow the
                     fader. -->
                <span
                  class="relative flex items-center justify-center bg-line"
                  style={`width:${THUMB_W}px;height:${THUMB_H}px`}
                >
                  {#if index >= stripFrom && index <= stripTo && doc}
                    <canvas use:thumb={index} class="block"></canvas>
                  {/if}
                  <span
                    class="pult-veil pointer-events-none absolute inset-0 bg-canvas"
                    style={`opacity:${veil}`}
                    aria-hidden="true"
                  ></span>
                </span>
                <span
                  class="pb-1 font-mono text-2xs tabular-nums {index === wanted
                    ? 'text-ink'
                    : 'text-faint'}"
                >
                  {index}
                </span>
              </button>
            {/each}

            <!--
              Beyond the notch are the STARTED BLANK SHEETS: otherwise an inked
              sheet could be returned to only by pressing "Back" the right
              number of times.
            -->
            <span class="h-[90px] w-4 shrink-0" aria-hidden="true"></span>
            <span class="h-[90px] w-px shrink-0 bg-line" aria-hidden="true"></span>
            <span class="h-[90px] w-4 shrink-0" aria-hidden="true"></span>

            {#each boardList as index (index)}
              <button
                type="button"
                class="{PRESS} flex shrink-0 flex-col items-center gap-1 border-b-[3px] {-wanted ===
                index
                  ? 'border-ink'
                  : 'border-transparent'}"
                onclick={() => {
                  goTo(-index)
                  openPane(null)
                }}
              >
                <span class="relative block bg-white" style={`width:${THUMB_W}px;height:${THUMB_H}px`}>
                  <svg width={THUMB_W} height={THUMB_H} class="block">
                    {#each boardInk(index) as line, at (at)}
                      <path
                        d={line.d}
                        fill="none"
                        stroke={line.color}
                        stroke-width={line.width}
                        stroke-linecap="round"
                        stroke-linejoin="round"
                      />
                    {/each}
                  </svg>
                  <span
                    class="pult-veil pointer-events-none absolute inset-0 bg-canvas"
                    style={`opacity:${veil}`}
                    aria-hidden="true"
                  ></span>
                </span>
                <span
                  class="pb-1 font-mono text-2xs tabular-nums {-wanted === index
                    ? 'text-ink'
                    : 'text-faint'}"
                > {tr('room.ui.168')} {index}
                </span>
              </button>
            {/each}

            {#if mayTurn}
              <button
                type="button"
                class="{PRESS} flex shrink-0 flex-col items-center gap-1 border-b-[3px] border-transparent"
                onclick={() => {
                  newBoard()
                  openPane(null)
                }}
              >
                <span
                  class="flex items-center justify-center border border-line text-muted"
                  style={`width:${THUMB_W}px;height:${THUMB_H}px`}
                >
                  <Icon name="plus" size={24} />
                </span>
                <span class="pb-1 {CAP} text-muted">{tr('room.ui.207')}</span>
              </button>
            {/if}
          </div>
        {:else if pane === 'grab'}
          <div class="p-6">
            <p class="text-answer text-ink">{grabWords}</p>
            <div class="mt-4 flex gap-2">
              <button type="button" class="btn-primary h-12 flex-1" disabled={offline} onclick={grab}>
                {holder?.self ? tr('room.takeover.grabHere') : tr('room.ui.172')}
              </button>
              <button type="button" class="btn-outline h-12 flex-1" onclick={() => openPane(null)}> {tr('room.ui.29')} </button>
            </div>
          </div>
        {:else if pane === 'files'}
          {#if switchTo !== null}
            <!-- A question instead of the list, not on top of it: the list is
                 six 88 px targets, and "Cancel" next to them would be the
                 seventh. -->
            <div class="p-6">
              <p class="text-answer text-ink"> {tr('room.ui.210')} {baseOf(switchTo)}{tr('room.ui.211')} </p>
              <div class="mt-4 flex gap-2">
                <button
                  type="button"
                  class="{PRESS} h-12 flex-1 border border-danger/40 {CAP} text-danger"
                  onclick={() => {
                    const path = switchTo
                    switchTo = null
                    if (path !== null) start(path)
                  }}
                > {tr('room.ui.212')} </button>
                <button
                  type="button"
                  class="btn-outline h-12 flex-1"
                  onclick={() => (switchTo = null)}
                > {tr('room.ui.29')} </button>
              </div>
            </div>
          {:else}
            <div class="flex h-10 items-center px-6">
              <span class="{SECTION} text-muted">{tr('room.ui.213')}</span>
            </div>
            <!-- Pixels, not `vh`: the window height unit on iPad lives a life
                 of its own between Safari's panels and Split View. -->
            <div class="max-h-[360px] overflow-y-auto border-t border-line-soft px-6">
              <!-- A lecture is running: the question comes first, see
                   `switchTo`. Preparation breaks nothing, and its "Present"
                   goes through at once. -->
              {@render fileList(
                lecture === null ? start : (path) => (switchTo = path),
                false,
              )}
            </div>
          {/if}
        {:else if pane === 'more'}
          <!--
            THE "MORE" SHEET is the only way into everything done once per
            class or once in a lifetime. "End lecture" lives here too, and
            lives AS THE LAST ROW: red in a dark hall is the loudest thing
            there is. There is not a single glyph in the rows: on the left the
            action's name, on the right its value.
          -->
          {#if lecture}
            <div class="flex h-12 items-center justify-between px-6">
              <span class="{SECTION} text-muted">{tr('room.ui.214')}</span>
              <span class="font-mono text-gauge tabular-nums text-ink">{stopwatch(runningFor)}</span>
            </div>
          {/if}
          <button type="button" class="{ROW} border-t border-line-soft text-ink" onclick={onexit}> {tr('room.ui.148')} </button>
          {#if fullscreenPossible()}
            <button
              type="button"
              class="{ROW} border-t border-line-soft text-ink"
              aria-pressed={full}
              onclick={() => {
                toggleFullscreen()
                openPane(null)
              }}
            >
              <span class="flex-1">{tr('room.ui.193')}</span>
              <span class="{CAP} text-muted">{full ? tr('room.ui.202') : tr('room.ui.203')}</span>
            </button>
          {/if}
          {#if file !== null}
            <!-- The prompter from here too: in landscape its key is not on the rail. -->
            <button
              type="button"
              class="{ROW} border-t border-line-soft text-ink"
              aria-pressed={tele}
              onclick={() => {
                setView(tele ? 'slide' : 'tele')
                openPane(null)
              }}
            >
              <span class="flex-1">{tr('room.prompter.teleAria')}</span>
              <span class="{CAP} text-muted">{tele ? tr('room.ui.202') : tr('room.ui.203')}</span>
            </button>
          {/if}
          <!--
            Brightness as a full-width row: the same three detents as on the
            rail, at a finger's height and with their names. On a tight
            portrait rail this is the fader's only home.
          -->
          <div class="border-t border-line-soft px-4 py-1">
            {@render fader('row')}
          </div>
          <button
            type="button"
            class="{ROW} border-t border-line-soft text-ink"
            aria-pressed={hand === 'left'}
            onclick={() => setHand(hand === 'left' ? 'right' : 'left')}
          >
            <span class="flex-1">{tr('room.ui.201')}</span>
            <span class="{CAP} text-muted">{hand === 'left' ? tr('room.ui.202') : tr('room.ui.203')}</span>
          </button>
          {#if leading}
            <button
              type="button"
              class="{ROW} border-t border-line-soft text-ink"
              aria-label={tr('room.ui.215')}
              aria-pressed={fingerOn}
              onclick={() => setFinger(!fingerOn)}
            >
              <span class="flex-1">{tr('room.ui.215')}</span>
              <span class="{CAP} text-muted">{fingerOn ? tr('room.ui.202') : tr('room.ui.203')}</span>
            </button>
          {/if}
          {#if mayTurn}
            <button
              type="button"
              class="{ROW} border-t border-line-soft text-ink"
              onclick={() => {
                if (onBoard) backToSlides()
                else newBoard()
                openPane(null)
              }}
            >
              <span class="flex-1">{onBoard ? tr('room.ui.216') : tr('room.ui.217')}</span>
              {#if boards > 0 && !onBoard}
                <span class="{CAP} text-muted">{tr('room.ui.218')} {boards}</span>
              {/if}
            </button>
            <button
              type="button"
              class="{ROW} border-t border-line-soft text-ink"
              onclick={() => openPane('files')}
            >
              <span class="shrink-0">{tr('room.ui.219')}</span>
              <span class="min-w-0 flex-1 truncate text-right font-mono text-code text-muted">
                {file ? baseOf(file) : ''}
              </span>
            </button>
          {/if}
          {#if leading}
            <div class="flex items-center border-t border-line-soft">
              {#if wipeAsked}
                <span class="flex-1 px-6 text-answer text-ink"> {tr('room.ui.220')} </span>
                <button
                  type="button"
                  class="{PRESS} h-16 px-4 {CAP} text-danger"
                  onclick={() => {
                    wipePage()
                    openPane(null)
                  }}
                > {tr('room.ui.221')} </button>
                <button
                  type="button"
                  class="{PRESS} h-16 px-6 {CAP} text-muted"
                  onclick={() => (wipeAsked = false)}
                > {tr('room.ui.29')} </button>
              {:else}
                <button type="button" class="{ROW} text-danger" onclick={() => (wipeAsked = true)}> {tr('room.ui.222')} </button>
              {/if}
            </div>
          {/if}

          <div class="h-px w-full bg-line-soft" aria-hidden="true"></div>
          <div class="px-6 py-4">
            <p class="text-answer text-ink">{tr('room.ui.223')}</p>
            <p class="pt-1 text-2xs text-muted">
              {#if wake === 'on'} {tr('room.ui.224')} {:else if wake === 'refused'} {tr('room.ui.225')} {AUTOLOCK}
              {:else if !canKeepAwake()} {tr('room.ui.226')} {AUTOLOCK}
              {:else}
                {AUTOLOCK}
              {/if}
            </p>
            <p class="pt-3 text-answer text-ink">{tr('room.ui.227')}</p>
            <p class="pt-1 text-2xs text-muted">{GUIDED}</p>
          </div>
          <div class="h-px w-full bg-line-soft" aria-hidden="true"></div>

          {#if leading}
            {#if stopAsked}
              <div class="px-6 py-4">
                <p class="text-answer text-ink"> {tr('room.ui.228')} <b class="font-semibold">{tr('room.ui.229')}</b>
                </p>
                <div class="mt-4 flex gap-2">
                  <!-- The dangerous one on the left, "Cancel" on the right:
                       under the thumb of the hand holding the tablet. -->
                  <button
                    type="button"
                    class="{PRESS} h-12 flex-1 border border-danger/40 {CAP} text-danger"
                    onclick={stop}
                  > {tr('room.ui.230')} </button>
                  <button type="button" class="btn-outline h-12 flex-1" onclick={() => (stopAsked = false)}> {tr('room.ui.29')} </button>
                </div>
              </div>
            {:else}
              <button type="button" class="{ROW} text-danger" onclick={() => (stopAsked = true)}> {tr('room.ui.231')} </button>
            {/if}
          {:else if preparing}
            <!-- Preparation has nothing to end: the same last row leads back
                 to the document picker, and there is no red here. -->
            <button
              type="button"
              class="{ROW} text-muted"
              onclick={() => {
                prep = null
                openPane(null)
              }}
            > {tr('room.ui.232')} </button>
          {/if}
        {/if}
      </div>
    </div>
  {/if}
{/snippet}

<style>
  /*
   * THE WHOLE CONSOLE IS WITHOUT SELECTION AND WITHOUT SYSTEM GESTURES:
   * `.pult-root`, `.pult-sheet` and the notes field are described in
   * `index.css` under `[data-pult]`; the address marker guarantees that the
   * bans do not reach the notebook. What remains here is the rail: pages
   * are swiped on it, and it must not be given to the browser.
   */
  .pult-rail {
    touch-action: none;
  }

  /*
   * FEATHERING AROUND THE SHEET instead of a shadow: a 1 px edge in `line`
   * colour and 6 px of paper shadow on the well. In steps, not a gradient: a
   * gradient on IPS in a dark room breaks into Mach bands. #131b31 is the
   * only bare hex: it is the paper's shadow, matched to the well's code
   * values, not an interface paint; the product has no "two steps lighter
   * than the well" token, and there is no point creating one for a single
   * place.
   */
  .pult-halo {
    box-shadow:
      0 0 0 1px rgb(var(--line)),
      0 0 0 7px #131b31;
  }

  /* The same feathering for the prompter's thumbnail, at its scale. */
  .pult-halo-sm {
    box-shadow:
      0 0 0 1px rgb(var(--line)),
      0 0 0 5px #131b31;
  }

  /*
   * The fader veil. Opacity, and only opacity: two things can be animated
   * for free, and this is one of them. 320 ms: theatre faders do not click.
   */
  .pult-veil {
    transition: opacity 320ms var(--ease-out);
  }

  /*
   * THE PULL-OUT SHEET IS A TRANSITION, NOT KEYFRAMES.
   *
   * The sheet comes from under the tablet's edge, like any sheet on iPad:
   * 220 ms (the panel tier) on the door curve. It used to be a named
   * animation: keyframes do not retarget and start from zero on every
   * reopening, and the sheet gets raised and dropped faster than it
   * arrives. A transition under the same conditions picks up from wherever
   * it was caught.
   *
   * `@starting-style` is what makes a transition possible at all on an
   * element that was not in the markup a second ago: it sets the position
   * BEFORE the first frame, and the sheet slides from the edge rather than
   * appearing in place. A browser that does not know the rule shows the
   * sheet at once: that is not a breakage, just an absence of motion.
   *
   * The exit stays instant: the sheet is removed with Escape, a tap
   * elsewhere and by choosing a row, and all three mean "I'm done", not
   * "watch it slide away".
   */
  .pult-drawer {
    transform: translateY(0);
    transition: transform var(--speed-panel) var(--ease-drawer);
  }

  @starting-style {
    .pult-drawer {
      transform: translateY(100%);
    }
  }

  /*
   * THE BACKDROP FADES IN TOGETHER WITH THE SHEET, not before it. It used to
   * appear instantly, while the sheet was still travelling, and the raise
   * read as two events in a row: first it darkened, then it arrived. The
   * same tier and the same entry curve.
   */
  .pult-scrim {
    opacity: 1;
    transition: opacity var(--speed-panel) var(--ease-out);
  }

  @starting-style {
    .pult-scrim {
      opacity: 0;
    }
  }

  /*
   * The convergence loop is the ONLY one on the console, and it is honest:
   * "we are still waiting". It crawls by scaleX, not width: width is layout.
   *
   * The curve is `linear`, and that is not a detail: `ease-out` slowed down
   * towards the end of the lap, and at 100 % the frame jumped back to
   * scaleX(0.1). The result was not "crawls" but "twitches and tears", that
   * is, the loop looked like a breakage exactly when it was supposed to say
   * "we are waiting". Constant motion takes an even curve; the entry and
   * exit tokens have nothing to do with it.
   */
  .pult-catchup {
    animation: catchup 1.2s linear infinite;
    transform-origin: left center;
  }

  @keyframes catchup {
    from {
      transform: scaleX(0.1);
    }
    to {
      transform: scaleX(1);
    }
  }

  /*
   * Reduction, not a switch: motion goes, appearance stays. The press
   * (`scale(0.97)`) always stays: on a screen that may not change at all it
   * is the only proof that a touch was heard.
   */
  @media (prefers-reduced-motion: reduce) {
    .pult-catchup {
      animation-duration: 1ms;
    }

    .pult-veil {
      transition-duration: 1ms;
    }

    /*
     * The sheet slides out over its full height: that is travel, and travel
     * goes. It cannot be replaced with a fade-in: the sheet is translucent
     * and lies on the paper, and a half-second fade-in over a slide would
     * read as a projector glitch. So it is in place at once. The backdrop
     * meanwhile keeps fading in: opacity is not motion, and without it the
     * sheet would arrive on a flash.
     */
    .pult-drawer {
      transition-duration: 1ms;
    }
  }
</style>
