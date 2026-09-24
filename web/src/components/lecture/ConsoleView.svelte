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

  1. THE SHEET IS THE WHOLE REST OF THE SCREEN. One rail (72 px in
     landscape, 64 at the bottom in portrait), 12 px margins, and everything
     else is paper. The sheet area used to have a constant height of 584,
     fitted to a single iPad 11", with a 236 px notes strip and a "next"
     column under it: on a 12.9" and in portrait the sheet drowned. Now the
     notes are a pull-out sheet from below over the paper (landscape) or the
     docked remainder under it (portrait), and "next" is a thumbnail in the
     peek strip.
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
     its margins. The only place where text is selected is the notes field.

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
  import { tr } from '@shared/i18n'
  import type { PDFDocumentProxy } from 'pdfjs-dist'
  import { untrack } from 'svelte'
  import Icon from '@/components/ui/Icon.svelte'
  import { api } from '@/lib/api'
  import { OFFLINE_REASON } from '@/lib/controls'
  import { fullscreenNow, fullscreenPossible, goFullscreen, leaveFullscreen } from '@/lib/fullscreen'
  import { loadPdf } from '@/lib/pdf.svelte'
  import { reloadByHand } from '@/lib/refusal'
  import { getSessionState } from '@/lib/session.svelte'
  import { borrowTheme } from '@/lib/theme.svelte'
  import { canKeepAwake, keepAwake, type WakeState } from '@/lib/wakelock'
  import { baseOf } from '@shared/paths'
  import InkLayer from './InkLayer.svelte'
  import LecturePage from './LecturePage.svelte'
  import NotesPad from './NotesPad.svelte'
  import { askInkPage, inkedPages } from './ink'
  import { boardsInked, INKS, stopwatch } from './pult'

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

  const HAND_KEY = 'colloq.pult.hand'
  const NOTES_KEY = 'colloq.pult.notes'
  const LAMP_KEY = 'colloq.pult.lamp'
  const FINGER_KEY = 'colloq.pult.finger'

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
   * Whether the pull-out notes sheet is open (landscape). The key is the
   * same as the old strip's: `open` means the person wants to see the notes
   * from the first second, anything else is closed. The default is closed,
   * because the sheet lies OVER the paper: open on entry, it would hide
   * exactly what the console was opened for. The note does not vanish
   * meanwhile: its first lines are visible in the peek strip under the
   * sheet.
   */
  let notesOpen = $state(remembered(NOTES_KEY) === 'open')

  function setNotes(open: boolean): void {
    notesOpen = open
    remember(NOTES_KEY, open ? 'open' : 'folded')
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
   * An open notes sheet does NOT change `canDraw`: it takes the lower half,
   * and the upper half remains paper one writes on. Only a sheet raised to
   * full screen (`paneOpen`) switches the pen off: the sheet covers the
   * sheet.
   */
  const canDraw = $derived(leading && !failure && !paneOpen)
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
      const onRail = !!(event.target as Element | null)?.closest('.pult-rail')
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
   * Horizontal in landscape (rail on the side), vertical in portrait (rail
   * at the bottom). A key under the finger is not pressed after a shift of
   * more than 12 px: its `click` is swallowed on lift.
   */
  const SWIPE_MIN = 64
  const SWIPE_SLOP = 12

  function swipe(node: HTMLElement, axis: () => 'x' | 'y') {
    let start: { id: number; x: number; y: number } | null = null
    let moved = false
    const down = (event: PointerEvent): void => {
      if (event.pointerType !== 'touch' || start !== null) return
      start = { id: event.pointerId, x: event.clientX, y: event.clientY }
      moved = false
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
      if (event.type === 'pointercancel') return
      /*
       * The lift must also be on the rail, and the pen must not be in play
       * at that moment. A touch started on the rail and carried onto the
       * sheet is a left-hander's palm that landed on the right rail and moved
       * left with the hand: the same 64 px as a swipe, and the audience's
       * page turned mid-formula.
       */
      const under = document.elementFromPoint(event.clientX, event.clientY)
      if (!under || !node.contains(under)) return
      if (busy) return
      if (Math.abs(along) >= SWIPE_MIN && Math.abs(along) > Math.abs(across) * 1.6) {
        // Left or up means forward: the sheet is "dragged" along.
        if (mayTurn) step(along < 0 ? 1 : -1)
      }
    }
    const click = (event: Event): void => {
      if (!moved) return
      moved = false
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

  /*
   * THE SWIPE DOWN ON THE NOTES SHEET'S HEADER lives in NotesPad itself, and
   * only there.
   *
   * There used to be two on the same sheet: NotesPad caught `pointermove` on
   * the header (48 px threshold, `touch-action: pan-x`), while here
   * `sheetSwipe` was attached to the same sheet: the top 48 px, a 40 px
   * threshold on lift. The first one always fired: the sheet unmounted
   * before `pointerup` arrived. That is, the second gesture did nothing
   * except promise to drift apart from the first at the next threshold
   * edit.
   */

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
   * Now only the "Fullscreen" key expands it: in the corner of the sheet, in
   * the bottom strip and in the "More" sheet. There is no first-touch
   * backdrop at all.
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
    session.send({ t: 'lecture:start', file: path })
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
    // The same `lecture:start` with the same file: on the server that is a
    // handover of the console, not a new lecture: page, ink and clock stay
    // in place.
    session.send({ t: 'lecture:start', file: lecture.file })
    pane = null
  }

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
   */
  function thumb(node: HTMLCanvasElement, index: number) {
    let dropped = false
    void (async () => {
      const source = doc
      if (!source) return
      const page = await source.getPage(index).catch(() => null)
      if (!page || dropped) return
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
      try {
        await page.render({ canvas: node, canvasContext: paint, viewport }).promise
      } catch {
        // The sheet was closed mid-render: business as usual.
      }
    })()
    return {
      destroy() {
        dropped = true
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
   * What LecturePage left under the sheet (landscape) and how much it took
   * (portrait). Arrives through `onfit`; the peek strip and the height of
   * the sheet box in portrait are built on it.
   */
  let fitRest = $state(0)
  let fitHeight = $state(0)

  function onfit(size: { w: number; h: number; rest: number }): void {
    fitRest = size.rest
    fitHeight = size.h
  }

  /**
   * The height of the sheet box in portrait is BY THE SHEET, not "half the
   * screen".
   *
   * Before the first measurement we give 45 % of the height: a 16:9 slide on
   * 834 fits by width and takes 456, not 537, and `onfit` reports the
   * remainder. Shrinking the box to the sheet plus margins, we get the same
   * fit (by width nothing changes, by height exactly the height it had
   * remains), that is, the scheme converges in one step and does not swing,
   * as long as the sheet is bounded by WIDTH. For a portrait page this is
   * not so, and the ceiling below holds the loop.
   */
  /**
   * THE ARMREST in portrait: 96 px of the well under the sheet that belong
   * to the sheet box, not to the notes. The notes field began 53 px below
   * the paper's bottom edge, and the heel of a palm writing on the bottom
   * third of a slide landed in the textarea: focus went to the notes, the
   * input layer went dark, the keyboard popped up over half of the iPad
   * screen, and a Pencil that strayed onto the field started Scribble. The
   * input layer covers the armrest together with the paper (`reach`), and a
   * palm on it is nothing.
   */
  const PALM_REST = 96
  /**
   * THE BOX CEILING: otherwise the scheme converges not always, but only on
   * slides.
   *
   * The convergence proof above holds exactly for a sheet bounded by WIDTH:
   * 16:9 on 834 gives 456 and stays. A page taller than it is wide (A4,
   * Letter, 3:4, any handout) runs into the HEIGHT: `fitHeight` then equals
   * the whole height of the box, the box gets +96, the sheet grows with it,
   * and so on for eight rounds in a row until the sheet becomes bounded by
   * width. For A4 on an 11″ that is a 1266 px box on a 1194 screen: the
   * bottom rail slides entirely under the edge (the root is
   * `overflow-hidden`), the notes shrink to zero, and in portrait there is
   * no "Next", no tools and no way out left.
   *
   * The ceiling makes the loop impossible: having hit it, the box stops
   * growing, the sheet fits into it by height, and the next round changes
   * nothing.
   */
  const RAIL_H = 64
  /** Below this the notes are a clipped line: a 40 header and three lines of talk. */
  const NOTES_MIN = 132
  const portraitSheetH = $derived.by(() => {
    const want = fitHeight > 0 ? fitHeight + 24 + PALM_REST : Math.round(box.h * 0.45) + PALM_REST
    const top = box.h - RAIL_H - NOTES_MIN
    return top > 0 ? Math.min(want, top) : want
  })

  /**
   * The size of the sheet box, for the ink input layer.
   *
   * The input layer covers the whole box, not just one page: the margins
   * are where the heel of the palm goes and the edge a stroke starts from
   * (InkLayer, `reach`). The page lies centred in the box by width and is
   * pinned to its top under a 12 margin; the remainder under it is box too.
   */
  const SHEET_PAD = 12
  let sheetW = $state(0)
  let sheetH = $state(0)
  function inkReach(size: { w: number; h: number }): { top: number; right: number; bottom: number; left: number } {
    const side = Math.max(0, (sheetW - size.w) / 2)
    return { top: SHEET_PAD, right: side, bottom: Math.max(0, sheetH - SHEET_PAD - size.h), left: side }
  }

  /**
   * The notes are requested BY THE CONSOLE ITSELF, not only by the notes
   * sheet.
   *
   * `openNotes` was called by NotesPad alone, and in landscape that is
   * mounted only while the sheet is open, while the default is "collapsed",
   * and it lives in localStorage. Until the sheet had been opened once,
   * `notesFile` stayed null, and the peek strip on EVERY page drew "What to
   * say on this page…" without a marker, exactly contrary to the promise
   * about the peek (see `notesOpen`) and exactly where the teacher expects
   * to see yesterday's twenty lines. The latch by file name inside
   * `openNotes` makes a repeated call free.
   */
  $effect(() => {
    const path = file
    if (!host || path === null) return
    untrack(() => session.openNotes(path))
  })

  /** This document's notes have arrived: empty and "never asked" are different. */
  const notesHere = $derived(session.notesFile === file)
  /** The note for this page, for the peek: only once they have arrived. */
  const peekNote = $derived(notesHere ? (session.notes[wanted] ?? '') : '')
  /** The peek strip lives when there are at least 110 px under the sheet. */
  const peekShown = $derived(!portrait && !notesOpen && fitRest >= 110 && file !== null)

  /** Width of the pull-out notes sheet by size: 400 on 820, 480 on 12.9". */
  const notesSheetH = $derived(box.h >= 1000 ? 480 : 400)

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
      } else if (!portrait && notesOpen) {
        event.preventDefault()
        setNotes(false)
      }
      return
    }
    if (typing || !mayTurn) return
    if (event.key === 'ArrowRight' || event.key === 'PageDown' || event.key === ' ') {
      event.preventDefault()
      step(1)
    } else if (event.key === 'ArrowLeft' || event.key === 'PageUp') {
      event.preventDefault()
      step(-1)
    } else if (event.code === 'KeyB') {
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
      if (!portrait) setNotes(!notesOpen)
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
  {:else if portrait}
    <!--
      PORTRAIT. The sheet on top with 12 margins, the notes docked across the
      whole remainder, the rail at the bottom under the thumb of the holding
      hand. There is no "Notes" key: the notes are on screen anyway.
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
        <div class="flex min-h-0 flex-1 flex-col border-t border-line" data-pult-notes>
          <!-- readonly: the talk is written at a desk and read on the console. See NotesPad. -->
          <NotesPad {file} page={wanted} folded={false} docked readonly onmore={() => openPane('more')} />
        </div>
      {/if}
      {@render bottomRail()}
    </div>
  {:else}
    <!--
      LANDSCAPE. One 72 px rail at the edge, and the edge follows the hand:
      with "left hand" it moves to the right edge together with the palette.
    -->
    <div class="flex min-h-0 flex-1 {hand === 'left' ? 'flex-row-reverse' : ''}">
      {@render sideRail()}
      <div class="relative min-h-0 min-w-0 flex-1">
        <!--
          The sheet box has 12 px MARGINS, as in portrait: the margins belong
          to the sheet, not to the well. The heel of the palm rests on them
          and strokes start from them, and the ink input layer covers them
          together with the paper.
        -->
        <div
          class="pult-sheet absolute inset-0 p-3"
          role="group"
          aria-label={tr('room.ui.152')}
          bind:clientWidth={sheetW}
          bind:clientHeight={sheetH}
        >
          {@render sheet()}
          {#if peekShown}
            {@render peek()}
          {/if}
        </div>
        {#if file !== null && notesOpen}
          {@render notesSheet()}
        {/if}
      </div>
    </div>
  {/if}

  {#if palette === 'pen' && leading}
    {@render palettePop()}
  {:else if palette === 'laser' && leading}
    {@render laserPop()}
  {/if}

  {@render panes()}

</div>

<!-- =========================================================== instrument -->

{#snippet fader(cell: string, tall: number)}
  <!--
    Three detents, not a cycling button: a fader always shows its current
    position. The bars grow 4 / 9 / 14: the position is read by shape, not
    by label, and the hand finds it by feel in one glance.
  -->
  <div class="flex" role="radiogroup" aria-label={tr('room.ui.153')}>
    {#each LAMPS as level, index (level.name)}
      <button
        type="button"
        role="radio"
        aria-checked={lamp === index}
        aria-label={level.name}
        class="{PRESS} flex {cell} items-end justify-center pb-1 {lamp === index ? 'bg-raised' : ''}"
        onclick={() => setLamp(index)}
      >
        <span
          class="block w-[14px] {lamp === index ? 'bg-ink' : 'bg-faint/70'}"
          style={`height:${Math.round((level.bar * tall) / 14)}px`}
          aria-hidden="true"
        ></span>
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
    THE 72×120 INSTRUMENT. Not a button by nature but a READING: number,
    share of the deck, wall clock, brightness. The slab can be pressed (it
    opens the page strip), but nobody counts on that. The stopwatch moved
    from here to the notes header and to "More": in 72 px it cannot stand
    next to the number, and it is looked at less often than the number.

    The number is flush left with a −2 px correction: tabular digits carry
    side bearings, and without the correction the number looks shifted
    right relative to the column.
  -->
  <div class="relative h-[120px] w-full shrink-0">
    <button
      type="button"
      class="{PRESS} absolute inset-x-0 top-0 h-[92px] enabled:active:bg-line"
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
        class="absolute left-3 top-[70px] flex h-[13px] items-center font-mono text-code tabular-nums text-muted"
      >
        {preparing ? tr('room.ui.160') : wall}
      </span>
    </button>

    <div class="absolute left-[3px] top-[94px]">
      {@render fader('h-6 w-[22px]', 14)}
    </div>
  </div>
{/snippet}

{#snippet gaugeFlat()}
  <!--
    The bottom rail's instrument, 104×64: the number on the left, the
    denominator, the pace and the fader in a column on the right. The same
    hierarchy, laid on its side.
  -->
  <div class="relative flex h-full w-[104px] shrink-0">
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
    <div class="flex w-[52px] flex-col items-start justify-center gap-1">
      {#if !onBoard}
        {@render tempo('w-[44px]')}
      {/if}
      {#if !tiny}
        {@render fader('h-5 w-4', 12)}
      {/if}
    </div>
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

{#snippet sideRail()}
  <!--
    ONE RAIL, 72 px. There are no dividing hairlines between keys: the body
    divides them: a 4 gap means "neighbours in a family", a 16 notch means "a
    border between families". Top to bottom: instrument, tools, "Undo", a
    spacer, deck navigation, page turning. The top of the rail is for the
    eye, the bottom for the finger.

    The inner edge turns red when the connection drops: a thin red seam
    along the side of a glowing window is visible in peripheral vision and
    takes up not a single pixel of layout.
  -->
  <div
    use:swipe={() => 'x'}
    class="pult-rail flex w-[72px] shrink-0 flex-col bg-surface {hand === 'left'
      ? 'border-l'
      : 'border-r'} {offline ? 'border-danger/40' : 'border-line'}"
  >
    {@render gauge()}
    <span class="h-4 shrink-0" aria-hidden="true"></span>

    {#if leading}
      {@render toolKeys('h-14 w-full', 'h-1 shrink-0')}
      <span class="h-2 shrink-0" aria-hidden="true"></span>
      <!--
        UNDO sits under the tools: a bad stroke is made by the pen, and the
        hand is already over the sheet next to the rail.
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

    <span class="min-h-6 flex-1" aria-hidden="true"></span>

    {#if mayTurn}
      <!--
        SHEET stays a key: a blank sheet is started mid-sentence ("the slide
        ended, but the derivation did not"), and two presses for that are
        already a refusal. It is also in the page strip, as the last tile.
      -->
      <button
        type="button"
        class="{KEY} h-14 w-full {onBoard ? 'bg-raised text-ink' : 'text-muted'} {CAP}"
        aria-label={onBoard ? tr('room.extra.53') : tr('room.extra.54')}
        aria-pressed={onBoard}
        onclick={() => (onBoard ? backToSlides() : newBoard())}
      >
        {@render mark(onBoard, false)}
        {onBoard ? tr('room.ui.167') : tr('room.ui.168')}
      </button>
      <span class="h-1 shrink-0" aria-hidden="true"></span>
    {/if}

    {#if preparing}
      <!-- In place of BLANK, preparation has "PRESENT": the only filled cyan
           slab on the console, with exactly one action behind it. -->
      <button
        type="button"
        class="{KEY} h-14 w-full bg-accent text-accent-ink {CAP}"
        onclick={() => prep && start(prep)}
      > {tr('room.ui.169')} </button>
      <span class="h-1 shrink-0" aria-hidden="true"></span>
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
        class="{KEY} h-14 w-full {CAP} {lecture?.blank ? 'bg-raised' : ''} {offline
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
      <span class="h-1 shrink-0" aria-hidden="true"></span>
    {:else if watching}
      <!--
        Someone else presents. The only key: an outline without fill; a
        filled slab would glow for all forty minutes of someone else's
        lecture for the sake of one press.
      -->
      <button
        type="button"
        class="{PRESS} mx-1 flex h-[112px] shrink-0 items-center justify-center border border-accent px-1 text-center {CAP} text-accent-text active:bg-line"
        onclick={() => openPane('grab')}
      > {tr('room.ui.172')} </button>
      <span class="h-1 shrink-0" aria-hidden="true"></span>
    {/if}

    {#if file !== null}
      <button
        type="button"
        class="{KEY} h-14 w-full {CAP} {notesOpen ? 'bg-raised text-ink' : 'text-muted'}"
        aria-label={tr('room.ui.173')}
        aria-pressed={notesOpen}
        onclick={() => setNotes(!notesOpen)}
      >
        {@render mark(notesOpen, false)} {tr('room.ui.173')} </button>
    {/if}

    <!-- A 16 NOTCH: the border between the "deck" and "page turning" families. -->
    <span class="h-4 shrink-0" aria-hidden="true"></span>

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
        class="{KEY} h-14 w-full text-muted disabled:text-faint/70"
        disabled={!onBoard && wanted <= 1}
        aria-label={tr('room.ui.174')}
        onclick={() => step(-1)}
      >
        <Icon name="chevron-left" size={24} />
      </button>
      <span class="h-1 shrink-0" aria-hidden="true"></span>
      <!-- The biggest key: people page forward eight times more often than back. -->
      <button
        type="button"
        class="{KEY} h-24 w-full flex-col gap-1 text-ink disabled:text-faint/70"
        disabled={!onBoard && pages > 0 && wanted >= pages}
        aria-label={tr('room.ui.175')}
        onclick={() => step(1)}
      >
        <Icon name="chevron-right" size={28} />
        <span class="{CAP}">{forwardReturns ? tr('room.ui.176') : tr('room.ui.177')}</span>
        {#if forwardReturns}
          <span class="font-mono text-code tabular-nums text-muted">{lastSlide}</span>
        {/if}
      </button>
    {:else}
      <span class="flex h-14 shrink-0 items-center justify-center px-1 {SECTION} text-muted">
        <span class="truncate">{tr('room.ui.178')} {lecture?.byName}</span>
      </span>
    {/if}

    <!-- Reserved for the home indicator: no key reaches in here. -->
    <span class="h-5 shrink-0" aria-hidden="true"></span>
  </div>
{/snippet}

{#snippet bottomRail()}
  <!--
    THE BOTTOM RAIL in portrait, 64 px: the same sequence, laid on its side.
    The swipe on it is vertical.
  -->
  <div
    use:swipe={() => 'y'}
    class="pult-rail flex h-16 shrink-0 items-stretch border-t bg-surface {offline
      ? 'border-danger/40'
      : 'border-line'}"
  >
    {@render gaugeFlat()}
    <span class="w-4 shrink-0" aria-hidden="true"></span>
    {#if leading}
      {@render toolKeys('h-full w-[72px]', 'w-0')}
      <span class="w-2 shrink-0" aria-hidden="true"></span>
      <button
        type="button"
        class="{KEY} h-full w-12 text-muted"
        onclick={undoStroke}
        aria-label={tr('room.ui.166')}
      >
        <Icon name="undo" size={22} />
      </button>
    {/if}
    <span class="min-w-4 flex-1" aria-hidden="true"></span>
    {#if mayTurn}
      <button
        type="button"
        class="{KEY} h-full w-[72px] {onBoard ? 'bg-raised text-ink' : 'text-muted'} {CAP}"
        aria-label={onBoard ? tr('room.extra.53') : tr('room.extra.54')}
        aria-pressed={onBoard}
        onclick={() => (onBoard ? backToSlides() : newBoard())}
      >
        {@render mark(onBoard, false)}
        {onBoard ? tr('room.ui.167') : tr('room.ui.168')}
      </button>
    {/if}
    {#if preparing}
      <button
        type="button"
        class="{KEY} h-full w-[72px] bg-accent text-accent-ink {CAP}"
        onclick={() => prep && start(prep)}
      > {tr('room.ui.169')} </button>
    {:else if leading}
      <button
        type="button"
        class="{KEY} h-full w-[72px] {CAP} {lecture?.blank ? 'bg-raised' : ''} {offline
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
    {:else if watching}
      <button
        type="button"
        class="{PRESS} my-2 flex w-[104px] shrink-0 items-center justify-center border border-accent px-1 text-center {CAP} text-accent-text active:bg-line"
        onclick={() => openPane('grab')}
      > {tr('room.ui.172')} </button>
    {/if}
    <span class="w-4 shrink-0" aria-hidden="true"></span>
    {#if mayTurn}
      <button
        type="button"
        class="{KEY} h-full w-16 text-muted disabled:text-faint/70"
        disabled={!onBoard && wanted <= 1}
        aria-label={tr('room.ui.174')}
        onclick={() => step(-1)}
      >
        <Icon name="chevron-left" size={24} />
      </button>
      <button
        type="button"
        class="{KEY} h-full w-[112px] gap-2 text-ink disabled:text-faint/70"
        disabled={!onBoard && pages > 0 && wanted >= pages}
        aria-label={tr('room.ui.175')}
        onclick={() => step(1)}
      >
        <Icon name="chevron-right" size={28} />
        <span class="{CAP}">{forwardReturns ? tr('room.ui.176') : tr('room.ui.177')}</span>
      </button>
    {:else}
      <span class="flex w-[112px] shrink-0 items-center justify-center px-1 {SECTION} text-muted">
        <span class="truncate">{tr('room.ui.178')} {lecture?.byName}</span>
      </span>
    {/if}
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
    page={wanted}
    live={canDraw}
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
      remainder under it is the place for the notes peek and the "next"
      thumbnail, not two identical gaps.
    -->
    <div class="flex h-full min-h-0 min-w-0 flex-col">
      <LecturePage {doc} page={wanted} bare align="top" {onfit}>
        {#snippet over(size)}
          {@render sheetOver(size)}
        {/snippet}
      </LecturePage>
    </div>
  {/if}

  {#if fullscreenPossible() && !full && !lecture?.blank}
    <!--
      The 200×44 "Fullscreen" key sits IN THE BOTTOM LEFT CORNER of the sheet
      box, where the toast is: the only place where neither a palm nor a pen
      lands. It used to be a 400-wide strip at the top centre, on the first
      line of the slide, over the input layer, and a stroke across a heading
      went into the button; under the sheet at the centre, exactly where a
      stroke from the bottom margin starts. Full screen can be requested only
      from a gesture, and the key is a gesture. When blanked, its place is
      taken by the "The audience sees black" slab.
    -->
    <button
      type="button"
      class="{PRESS} absolute bottom-2 left-2 z-10 flex h-11 w-[200px] items-center justify-center gap-2 border border-line bg-surface/[0.88] {CAP} text-accent-text"
      aria-label={tr('room.ui.193')}
      onclick={toggleFullscreen}
    > {tr('room.ui.193')} <Icon name="chevron-right" size={16} />
    </button>
  {/if}

  <!-- The toast is in the bottom left corner of the sheet, where neither a palm
       nor a pen lands; above the "Fullscreen" key, if there is one. -->
  <div class="absolute left-2 z-10 {fullscreenPossible() && !full && !lecture?.blank ? 'bottom-14' : 'bottom-2'}">
    {@render toast()}
  </div>
{/snippet}

{#snippet peek()}
  <!--
    THE PEEK under the sheet: the first lines of this page's note and the
    "next" thumbnail on the right. A READING, NOT A BUTTON: the strip lies
    exactly where a right-hander's heel of the palm is, and while it was the
    way into the notes sheet, the palm opened that sheet over the lower half
    of the paper mid-writing, and a stroke started from the bottom margin
    went into the button. Note-taking apps have nothing pressable under the
    paper; the way into the notes is the "Notes" key on the rail and N.
    `pointer-events: none`: touches go to the input layer, which ignores the
    palm. It lives only when there are ≥110 px under the sheet; less than
    that is a bare well, where a two-line strip would read as clipped text.
  -->
  <div
    class="pointer-events-none absolute inset-x-3 bottom-3 flex gap-3"
    style={`height:${Math.max(0, fitRest - 12)}px`}
    data-pult-notes
    aria-hidden="true"
  >
    <div
      class="flex min-w-0 flex-1 flex-col items-start overflow-hidden px-3 py-2 text-left"
    >
      <span class="flex items-center gap-2">
        <span class="{SECTION} text-muted">{tr('room.ui.194')}</span>
        {#if peekNote.trim()}
          <span class="h-3 w-0.5 shrink-0 bg-accent" aria-hidden="true"></span>
        {/if}
        <span class="font-mono text-code tabular-nums text-muted">
          {preparing ? '' : stopwatch(runningFor)}
        </span>
      </span>
      <!--
        "Not here yet" and "empty" are different things, and the difference
        costs the same here as in the notes sheet itself: an invitation in
        place of yesterday's talk reads as lost work.
      -->
      <span class="mt-1 line-clamp-3 whitespace-pre-line text-prompt-sm text-ink">
        {notesHere ? peekNote.trim() || tr('room.ui.195') : tr('room.ui.196')}
      </span>
    </div>
    {#if doc && !onBoard && pages > wanted && !tiny}
      <!-- "What comes next" is a reading, like the number; it cannot be pressed. -->
      <div class="relative flex w-40 shrink-0 flex-col">
        <span class="relative flex h-[90px] w-40 bg-white">
          <LecturePage {doc} page={wanted + 1} bare />
          <span
            class="pult-veil pointer-events-none absolute inset-0 bg-canvas"
            style={`opacity:${veil}`}
            aria-hidden="true"
          ></span>
        </span>
        <span class="mt-1 flex justify-end font-mono text-code tabular-nums text-muted"> {tr('room.ui.197')} {wanted + 1}
        </span>
      </div>
    {/if}
  </div>
{/snippet}

{#snippet notesSheet()}
  <!--
    THE PULL-OUT NOTES SHEET, from below, over the paper, 400 tall (480 on a
    12.9"). The body is at 0.96: the sheet shows through it faintly, so one
    does not lose track of where one is. The upper half of the paper stays
    usable: the pen draws there while focus is not in the field. The lecture
    stopwatch is in the header, driven by NotesPad itself: people raise
    their eyes here between sentences, and "how much has passed" is read in
    the same glance.
  -->
  <div
    class="pult-drawer absolute inset-x-0 bottom-0 z-10 flex flex-col border-t border-line bg-surface/[0.96]"
    style={`height:${notesSheetH}px`}
    data-pult-notes
  >
    <div class="flex min-h-0 flex-1 flex-col">
      <NotesPad
        file={file ?? ''}
        page={wanted}
        folded={false}
        readonly
        onfold={() => setNotes(false)}
        onmore={() => openPane('more')}
      />
    </div>
  </div>
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
            <p class="text-answer text-ink"> {tr('room.ui.208')} {lecture?.byName}{tr('room.ui.209')} </p>
            <div class="mt-4 flex gap-2">
              <button type="button" class="btn-primary h-12 flex-1" onclick={grab}> {tr('room.ui.172')} </button>
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
