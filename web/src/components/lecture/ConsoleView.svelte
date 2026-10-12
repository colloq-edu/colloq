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
     a reading strip under the slide (page, time, plan, and the lecture's
     thumbnails with "next" among them), and everything else is paper. The
     notes never cover the paper: in landscape
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
     The finger gestures on the sheet are two, the two-finger tap (Undo) and
     the pinch (the zoom, mirrored to the hall), and the layer tells them
     from each other and from the palm itself, handing `onundo` and `onzoom`
     over here.
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
  import {
    LASER_EVERY_MS,
    MAX_SHEETS,
    lectureSequence,
    readPaper,
    sameZoom,
    sheetNumber,
    sheetsFullSays,
    type InkStroke,
    type LectureZoom,
    type SheetPaper,
  } from '@shared/lecture'
  import { baseOf } from '@shared/paths'
  import {
    ARMREST,
    deckTitle,
    filmItems,
    fitBox,
    gridColumns,
    gridScroll,
    gridWindow,
    itemMark,
    itemName,
    menuPlace,
    nextMark,
    placeWords,
    ribbonStart,
    stripLayout,
    stripScroll,
    stripWindow,
    strokesOn,
    twoTiers,
    afterWords,
    uncovered,
    SHEET_PAD,
    TIERS_H,
    type Box,
    type FilmItem,
  } from './film'
  import InkLayer from './InkLayer.svelte'
  import LecturePage from './LecturePage.svelte'
  import NotesPad from './NotesPad.svelte'
  import NotesReader from './NotesReader.svelte'
  import SheetCard from './SheetCard.svelte'
  import SheetMenu from './SheetMenu.svelte'
  import ToolPalette from './ToolPalette.svelte'
  import { askInkPage } from './ink'
  import { LASER_RED } from './laser'
  import { budgetOf, firstLine, plannedSeconds } from './notes-script'
  import { slideTitle } from './slide-titles'
  import {
    INKS,
    MARKER_WIDTHS,
    MARKERS,
    PEN_WIDTHS,
    paperFor,
    stopwatch,
    zoomTimes,
  } from './pult'
  import { BLANK_KEYS, isClickerReload } from './remote'
  import {
    askTurn,
    hearTurn,
    sheetPlace,
    turnTarget,
    walkLength,
    walkStep,
    type AskedTurn,
  } from './walk'
  import { zoomAround, type ZoomHow, type ZoomView } from './zoom'
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
    }
  })

  /**
   * The turns we asked for that the projector has not answered yet, in the
   * order they went out (walk.ts · `askTurn`, `hearTurn`).
   *
   * Needed to tell OUR OWN echo on its way from SOMEONE ELSE'S move. Two
   * presses in a row ask for the seventh and the eighth; the echo of the
   * seventh arrives first, and without this list it would read as "someone
   * else took the page away". In ORDER, not as a set: "Next, Next, Back"
   * asks for 7, 8 and 7, and a set emptied by the first echo of 7 let the 8
   * behind it read as someone else's move: the console jumped to 8 and back
   * after the hand had stopped, dropping the sheet menu and cutting a stroke
   * begun in between. Not a rune: nobody draws it, it is only checked
   * against.
   */
  let asked: AskedTurn[] = []
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
    /*
     * Whether the server's page has changed since the last pass, and whether
     * that change is the echo of a turn we asked for (which settles it and
     * every request before it, walk.ts · `hearTurn`). Computed BEFORE all the
     * branches: each of them is an answer to these two questions.
     */
    const { moved, ours } = untrack(() => {
      const changed = seenPage !== null && seenPage !== at
      seenPage = at
      if (!changed || at === null) return { moved: changed, ours: false }
      const echo = hearTurn(asked, at, performance.now())
      asked = echo.left
      return { moved: true, ours: echo.ours }
    })
    if (at === null) {
      behind = false
      return
    }
    if (at === mine) {
      behind = false
      /*
       * Coming back to the server's page settles nothing by itself: after
       * "Back, Back, Next, Next" faster than a round trip the console stands
       * where the hall still is while the echoes of all four presses are on
       * their way, and with the list cleared here each of them read as
       * someone else's move. The console replayed the whole walk after the
       * hand had stopped, and dropped what hung from the page (the sheet's
       * menu). Only echoes take requests off the list (`hearTurn` above).
       */
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
    if (moved && !ours) {
      /*
       * Someone else's move. Follow the audience at once, not a second or so
       * later. The SERVER's own moves land here too, and must: "＋ Лист"
       * does not turn the console (the server picks the new sheet's number
       * and turns the hall to it), and deleting the sheet on screen moves the
       * hall back one step. Neither is a page this console asked for, so the
       * console follows it at once, and nothing is left to resend that could
       * take the hall back to where the press was made (`hearTurn` has
       * emptied the list).
       */
      behind = false
      untrack(() => (wanted = at))
      return
    }
    /*
     * OUR PAGE IS A SHEET THAT NO LONGER EXISTS: deleted while the turn to it
     * was on its way, or while the hall stood elsewhere. The server refuses
     * a turn to a deleted sheet, and ink on it, so waiting and resending can
     * only end in the give-up five tries later, with a pen that draws
     * nothing in between. Follow the hall now.
     */
    const listed = lecture?.sheets
    if (mine < 0 && listed && !listed.some((sheet) => sheet.page === mine)) {
      behind = false
      untrack(() => {
        wanted = at
        asked = []
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
      /*
       * Not while a "＋ Лист" is on its way: the server will turn the hall to
       * the new sheet, after the page we are waiting for, and a repeat that
       * left after the press would arrive after it and turn the hall back
       * off the sheet. On a relay slower than a repeat that is every other
       * press. A refused add (fifty sheets) frees the repeats when its wait
       * runs out (`addingUntil`).
       */
      if (performance.now() < addingUntil) return
      tries += 1
      if (tries > 5) {
        wanted = at
        asked = []
        return
      }
      /*
       * A repeat is remembered like the press it repeats: a page pressed
       * offline goes out only from here, and its echo, unremembered, read as
       * someone else's move the moment the hand had pressed on (`askTurn`
       * folds a repeat into the request it repeats).
       */
      asked = askTurn(asked, mine, performance.now())
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
     * The upper bound, also when our own copy of the document did not open.
     *
     * `pages` is zero then, and there was no bound at all: the NEXT key
     * drove the audience's page numbers past the end of the deck: the
     * projector shows nothing, and the console does not even show that,
     * because it has nothing to show with. The audience, meanwhile, opened
     * its copy and knows where the end is; we do not. So a step is allowed
     * exactly one page past the furthest slide anything here has seen: one
     * can page forward as far as one likes, but one press at a time and
     * following the server's confirmation, not as a queue of twenty pages
     * from a held button.
     *
     * That is the walk's own length (`deckLength`, walk.ts · `walkLength`),
     * the same the arrows and the strip are laid out by, and the same the
     * laptop bar bounds itself with. The bound used to be "the hall's page
     * plus one", and on a sheet the hall's page is negative: from "Л1" every
     * slide became page 0, which the server ignores (the console stood on
     * nothing for five resends), and from the third sheet on it became the
     * sheet numbered one higher, which the server turned the projector to.
     * A negative number is a sheet, and is not forced into the deck's
     * bounds (walk.ts · `turnTarget`).
     */
    const target = turnTarget(next, deckLength)
    if (target === wanted) return
    wanted = target
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
     *
     * A page is remembered as asked only when the request goes out: only a
     * request that went out can come back as an echo, and one kept for a
     * press that never left would pass someone else's move to that page off
     * as ours.
     */
    if (leading && !offline) {
      asked = askTurn(asked, target, performance.now())
      session.send({ t: 'lecture:page', page: target })
    }
  }

  /* --------------------------------------------------------- blank sheet */

  /*
   * A WHITE FIELD IN THE LECTURE, WHERE IT WAS MADE.
   *
   * The thing most often missing in class: the slide ended, but the
   * derivation of the formula did not. Until now the teacher either wrote
   * over the slide, covering what the audience is still reading, or walked
   * off to the chalkboard, that is, stopped showing anything at all, and
   * half the audience cannot see that board.
   *
   * A sheet is a page with a negative number (see shared/lecture.ts), so ink
   * and the pointer work on it by themselves. The SERVER keeps the sheets, in
   * deck order: "＋ Лист" asks for one right after the page on screen, and the
   * server picks its number, puts it there and turns the hall to it; the
   * console follows (the convergence effect above takes the server's turn as
   * someone else's move). The console used to make the numbers up itself and
   * count the sheets from the ink in its own tab: a reload lost the empty
   * ones, the 51st landed silently on the 50th, and the sheets stood in a
   * pile after the deck, walked in order of creation. Now there is one list
   * and one order, the one the laptop bar and the hall walk too.
   */

  /** Where the arrows go from a sheet the list does not know: the last slide we were on. */
  let lastSlide = $state(1)

  $effect(() => {
    const at = wanted
    untrack(() => {
      if (at > 0) lastSlide = at
    })
  })

  /**
   * The slide the HALL showed last: with our own copy of the deck unopened,
   * it is one of the bounds of how far the arrows may go (walk.ts ·
   * `walkLength`), together with the page on screen.
   */
  let hallSlide = $state(1)
  $effect(() => {
    const at = lecture?.page ?? null
    untrack(() => {
      if (at !== null && at > 0) hallSlide = at
    })
  })

  const onBoard = $derived(wanted < 0)

  /**
   * THE LECTURE IN THE ORDER IT IS WALKED: slides with their sheets in place
   * (shared/lecture.ts · `lectureSequence`), the same order the laptop bar
   * and the server walk (walk.ts). With the deck not opened here, as long as
   * one past the furthest slide anybody has seen: a held arrow must not
   * drive the hall past the end of a deck nobody here can see.
   */
  const deckLength = $derived(walkLength(pages, lecture?.sheets, lecture?.page ?? wanted, hallSlide))
  const sequence = $derived(lectureSequence(deckLength, lecture?.sheets))
  /** Where the arrows lead from our page, or `null` at an end: the keys go dark exactly there. */
  const backTo = $derived(walkStep(sequence, deckLength, wanted, -1, lastSlide))
  const nextTo = $derived(walkStep(sequence, deckLength, wanted, 1, lastSlide))
  /** And one step further: the "then" of the footers. */
  const thenTo = $derived(nextTo === null ? null : walkStep(sequence, deckLength, nextTo, 1, lastSlide))
  /** The sheet on screen as "sheet 2 of 3"; `null` on a slide or on a sheet the list does not know. */
  const place = $derived(sheetPlace(sequence, wanted))
  /** The sheet on screen as the server lists it (where it stands, its paper), or `null`. */
  const sheetHere = $derived(onBoard ? (lecture?.sheets?.find((sheet) => sheet.page === wanted) ?? null) : null)
  const sheetCount = $derived(lecture?.sheets?.length ?? 0)
  /** How far through the deck the page on screen is, for the pace ruler: a sheet counts as the slide it follows. */
  const deckShare = $derived.by(() => {
    if (pages <= 0) return 0
    const at = onBoard ? (sheetHere?.after ?? 0) : wanted
    return Math.min(1, Math.max(0, at / pages))
  })

  /**
   * A page's mark, as the readings and the chips write it: "14" for a slide,
   * "Л2" for a sheet by its PLACE among the sheets, never by its number (the
   * server hands numbers out and never reuses them, so the third sheet of a
   * lecture with deletions may be page −7). A sheet the list does not know
   * is the bare word "лист".
   */
  function pageMark(page: number): string {
    if (page > 0) return String(page)
    const n = sheetNumber(sequence, page)
    return n > 0 ? tr('room.ui.158', { p0: n }) : tr('room.ui.159')
  }

  /**
   * A step forward or back along the lecture: through the sheets where they
   * stand, the one meaning of "next" the laptop bar, the clicker and the
   * hall share (walk.ts · `walkStep`). The rail swipe, the arrows and the
   * keyboard, and the prompter's "Next" all come here.
   */
  function step(dir: -1 | 1): void {
    const next = walkStep(sequence, deckLength, wanted, dir, lastSlide)
    if (next !== null) goTo(next)
  }

  /*
   * "＋ ЛИСТ": a new sheet right after the page on screen. The press only
   * ASKS: the server picks the number, puts the sheet in its place and turns
   * the hall to it, and the console follows that turn (see the convergence
   * effect). It is not queued offline (session · `DISCARDED_OFFLINE`): a sheet
   * that appeared a minute later, when the Wi-Fi came back, would turn the
   * hall to a white field in the middle of something else.
   *
   * At fifty sheets the key stays lit and says why nothing happens, in the
   * server's own words (`sheetsFullSays`), instead of going grey without a
   * reason. A press is not repeated until the answer to the previous one is
   * back: a double tap would otherwise ask twice for "right after slide 14",
   * and the second sheet would stand BEFORE the first.
   *
   * WHILE THE ANSWER IS ON ITS WAY THE PEN IS HELD (`adding`, see `steady`).
   * The console stays on the slide for that round trip, and the press is
   * made mid-sentence by the hand that does not hold the pen: the thumb taps
   * the rail and the Pencil comes down to start the derivation at once. Its
   * first letters went onto the SLIDE, the rest of the motion was cut when
   * the sheet arrived, and the stray mark stayed on the slide for the rest of
   * the lecture, out of reach of Undo, which by then acted on the new sheet.
   * The sheet itself still waits for its picture like any page (`sheetReady`).
   * The key looks pressed meanwhile, so a second tap swallowed by the wait
   * is not a tap that "did nothing".
   */
  const ADD_WAIT_MS = 1500
  let addingUntil = 0
  /** A "＋ Лист" is on its way: the pen is held and the key looks pressed. */
  let adding = $state(false)
  let addingTimer: number | undefined

  function addAnswered(): void {
    addingUntil = 0
    adding = false
    window.clearTimeout(addingTimer)
    addingTimer = undefined
  }

  $effect(() => {
    // The answer is a list one sheet longer: the next press may go, and the pen.
    void sheetCount
    untrack(addAnswered)
  })

  function newSheet(): void {
    if (!leading) return
    if (offline) {
      say(tr('room.pult4.sheetsOffline'), 'refusal')
      return
    }
    if (sheetCount >= MAX_SHEETS) {
      say(sheetsFullSays(), 'refusal')
      return
    }
    const now = performance.now()
    if (now < addingUntil) return
    if (!session.addSheet(wanted)) {
      say(tr('room.pult4.sheetsOffline'), 'refusal')
      return
    }
    addingUntil = now + ADD_WAIT_MS
    adding = true
    window.clearTimeout(addingTimer)
    // A refusal (the fiftieth sheet, asked from two hands at once) or a lost
    // frame gives the pen back when the wait runs out.
    addingTimer = window.setTimeout(addAnswered, ADD_WAIT_MS)
  }

  function blank(on: boolean): void {
    if (!leading || offline) return
    session.send({ t: 'lecture:blank', on })
  }

  /* ----------------------------------------------------------------- tool */

  /*
   * EIGHT PENS, FIVE HIGHLIGHTERS AND THEIR WIDTHS. The sets themselves, and
   * the argument for which blue is in and which is out, live in `./pult`: the
   * lecture bar on the laptop draws the same ink for the same audience, and
   * there must be no second copy of these lists. A copy managed to drift
   * apart once: here blue was explained with measured numbers and removed,
   * yet it stood as the third circle and the pen's default.
   */

  /**
   * The tools of the hand. `zoom` is the magnifier: a frame dragged on the
   * sheet becomes the view, and the hand gets its previous tool back (see
   * `pressZoom`).
   */
  type Tool = 'pen' | 'marker' | 'eraser' | 'laser' | 'zoom'

  /**
   * There is ONE tool, and the pointer and the magnifier are part of it.
   * "Pen, black, medium" and the yellow highlighter of middle width on entry,
   * and none of it is stored: the tool is the state of the hand for this
   * class, not a setting.
   */
  let tool = $state<Tool>('pen')
  let inkColor = $state<string>(INKS[0].color)
  let penWidth = $state(PEN_WIDTHS[2].width)
  let markerColor = $state<string>(MARKERS[0].color)
  let markerWidth = $state(MARKER_WIDTHS[1].width)

  const strokeColor = $derived(tool === 'marker' ? markerColor : inkColor)
  const strokeWidth = $derived(tool === 'marker' ? markerWidth : penWidth)

  /**
   * A width as it lands on the glass, in px: the fraction of the page times
   * the page's real width on this screen (`fitWidth`, from LecturePage).
   *
   * It used to be multiplied by a fixed 1084, the sheet with the notes
   * folded; with the notes open (the default) the page is about 700 px wide,
   * and the palette drew every width half as thick again as the pen wrote.
   * Under a zoom the pen writes thinner by the zoom (ink.ts · `inkWidthAt`),
   * so on the glass a new stroke is this thick at any zoom, and the palette
   * stays true.
   */
  const onGlass = (width: number): number => width * (fitWidth > 0 ? fitWidth : 704)

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

  function markerIn(color: string): void {
    tool = 'marker'
    markerColor = color
  }

  function markerWide(width: number): void {
    tool = 'marker'
    markerWidth = width
  }

  /**
   * THE PEN PALETTE pops up on a tap on the ALREADY ACTIVE pen, as in any
   * note-taking app: the first tap takes the tool, the second opens its
   * settings. It closes on a second tap, a tap elsewhere, Escape and the very
   * first touch of the sheet (`busy`): a palette left hanging over a formula
   * is an extra object between the eye and what is being written.
   */
  /**
   * Which palette is open: the pen's, the highlighter's, the pointer's or
   * none.
   *
   * It was a `boolean` for the pen alone. The pointer and the highlighter
   * have something to choose too now, and a flag each would mean keeping in
   * one's head that no two of them can be open at once. One value makes this
   * a rule rather than an agreement.
   */
  let palette = $state<null | 'pen' | 'marker' | 'laser'>(null)

  function penKey(): void {
    if (tool === 'pen') palette = palette === 'pen' ? null : 'pen'
    else pick('pen')
  }

  /*
   * THE HIGHLIGHTER HAS A PALETTE NOW, opened the way the pen's is: the first
   * tap takes the tool, the second shows its colours and widths.
   *
   * It used to open nothing, on the argument that a highlight must be lighter
   * than the paper under the text and there is exactly one such colour. That
   * held while the highlighter lay OVER the writing and tinted it. It lies
   * UNDER the ink now, multiplied with the slide (InkLayer · `ink-mark`), so
   * any light colour leaves the text crisp, and a second colour is how one
   * tells "the definition" from "the example" on the same slide.
   */
  function markerKey(): void {
    if (tool === 'marker') palette = palette === 'marker' ? null : 'marker'
    else pick('marker')
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
   * without a connection. The magnifier stays armed offline (the view is the
   * console's own and goes to the hall on reconnect), but not past the
   * console stopping being ours: a watching teacher has no key to disarm it.
   */
  $effect(() => {
    const alive = leading && !offline
    const ours = leading || preparing
    untrack(() => {
      if (!ours) disarm()
      if (alive) return
      laserCancel()
      if (tool === 'laser') tool = 'pen'
    })
  })

  /* ----------------------------------------------------------------- zoom */

  /*
   * THE ZOOM, THE CONSOLE'S HALF. The view is magnified inside the page's
   * own frame, and every screen of the lecture shows the same region
   * (shared/lecture.ts · `LectureZoom`); LecturePage owns the motion and the
   * sharp redraw, the ink layer the gestures (the pinch, the magnifier's
   * frame). What is decided here is WHOSE view the sheet shows, and what
   * goes over the wire.
   *
   *  · While the console is ours (leading, or preparing with no lecture),
   *    the view is our own target, `zoomTarget`. The hall follows it, never
   *    the other way round: the echo of our own frames is ignored (the store
   *    calls it `zoomNow`), or a pinch would stutter back to where the
   *    fingers were a round trip ago. In preparation nothing is sent at all:
   *    there is no hall.
   *  · While another teacher leads, the sheet shows the hall's view
   *    (`zoomNow`) and glides after it, exactly as the projector does.
   *
   * The target is KEYED BY PAGE, `{page, zoom}`, and read only for the page
   * on the sheet: a turn must never pair the new page with the old zoom,
   * even for the one render between the turn and the reset below, or
   * LecturePage starts the new slide magnified at the old spot.
   */
  let zoomTarget = $state.raw<{ page: number; zoom: LectureZoom | null } | null>(null)
  /** How the sheet reaches the target: at once under the fingers, eased after a key or a frame. */
  let zoomHow = $state<ZoomHow>('ease')
  /** The fingers are moving the view: their frames are a stream, and the final one closes it. */
  let pinching = false
  /** The tool the magnifier was armed from: it comes back once the frame has been drawn. */
  let beforeZoom: Exclude<Tool, 'zoom'> = 'pen'

  /** Whether the view on the sheet is the console's own (and the hall's to follow). */
  const ownZoom = $derived(leading || preparing)
  /** The view the main sheet is asked for: ours, or the hall's while someone else leads. */
  const zoomShownTarget = $derived.by((): LectureZoom | null => {
    if (ownZoom) return zoomTarget !== null && zoomTarget.page === wanted ? zoomTarget.zoom : null
    const heard = session.zoomNow
    return heard !== null && heard.page === wanted ? heard.zoom : null
  })
  const zoomHowShown = $derived<ZoomHow>(ownZoom ? zoomHow : 'glide')
  /**
   * The view on the sheet as `x y z`, absent at the whole page: a marker for
   * the stands (`data-pult-zoom` on `.pult-sheet`), which compare it with the
   * hall's without reaching into the store.
   */
  const zoomMark = $derived(
    zoomShownTarget ? `${zoomShownTarget.x} ${zoomShownTarget.y} ${zoomShownTarget.z}` : undefined,
  )

  /**
   * What the HALL is shown of this page, by the server's word (`zoomNow`),
   * for the armrest's "the hall sees ×2.5". Not our own target: offline, or
   * for the round trip of a frame, the two differ, and the line under the
   * sheet is the one place that says what the audience really has.
   */
  const hallZoom = $derived.by((): LectureZoom | null => {
    if (lecture === null) return null
    const heard = session.zoomNow
    return heard !== null && heard.page === wanted ? heard.zoom : null
  })

  /**
   * The zoom the magnifier's key reads and offers to take away: our own
   * view, or, while ours is the whole slide, the hall's.
   *
   * A hall magnified while the console is not is a divergence: a frame lost
   * with a dropping connection, "Whole slide" pressed while the socket was
   * dead. The armrest said "the hall sees ×2" while the key offered only to
   * arm the magnifier, and on a tablet without a keyboard nothing short of a
   * page turn gave the audience the whole slide back. Now the key reads
   * "×2 / Whole slide" and says the whole slide to the hall (`aimZoom`).
   * Not offline: the hall's word is stale then, and the key must go on
   * arming the magnifier for the console's own view, which the hall gets on
   * reconnect anyway.
   */
  const keyZoom = $derived(zoomShownTarget ?? (leading && !offline ? hallZoom : null))
  const zoomed = $derived(keyZoom !== null)

  /*
   * A TURN RESETS THE ZOOM, at once and here as well: the server does the
   * same for the hall (`turnTo`), and the console turns before the server
   * hears about it. A frame still waiting for its tick belongs to the old
   * page, and the server would drop it anyway.
   */
  $effect(() => {
    const at = wanted
    untrack(() => {
      if (zoomTarget !== null && zoomTarget.page !== at) zoomTarget = null
      pinching = false
      window.clearTimeout(zoomTimer)
      zoomTimer = undefined
      zoomDue = null
    })
  })

  /*
   * ANOTHER DOCUMENT, OR ANOTHER LECTURE ON IT, STARTS AT THE WHOLE PAGE: a
   * view is a region of one page of one deck, and the target is keyed by the
   * page number alone. A deck switched from "Files" starts on page 1, and
   * when the lecture it replaced stood on page 1 too nothing above noticed:
   * the new deck's first slide came up at the old one's ×2 on the console
   * while the hall, started afresh by the server, showed it whole, and the
   * presenter pointed at a detail nobody else saw magnified. The same for a
   * prepared deck swapped for another, and for preparing right after a
   * lecture that ended zoomed. Before the take-over below: a console opened
   * on a running lecture first forgets, then adopts the hall's view.
   */
  let zoomDeck: string | null = null
  $effect(() => {
    const deck = `${file ?? ''}\n${lecture?.startedAt ?? ''}`
    untrack(() => {
      if (deck === zoomDeck) return
      zoomDeck = deck
      zoomTarget = null
      zoomHow = 'ease'
      pinching = false
      window.clearTimeout(zoomTimer)
      zoomTimer = undefined
      zoomDue = null
    })
  })

  /*
   * TAKING THE CONSOLE OVER KEEPS THE HALL'S VIEW: the new hands start where
   * the hall is, not at the whole page (the server keeps the zoom across a
   * take-over). The same on opening the console mid-lecture.
   */
  let ledBefore = false
  $effect(() => {
    const now = leading
    untrack(() => {
      if (now && !ledBefore) {
        const heard = session.zoomNow
        zoomTarget = heard !== null && heard.page === wanted ? { page: wanted, zoom: heard.zoom } : null
        zoomHow = 'ease'
        pinching = false
      }
      ledBefore = now
    })
  })

  /*
   * THE HALL MUST END UP WITH OUR VIEW, and two things can cost it a frame.
   * The zoom is never queued offline (session · `DISCARDED_OFFLINE`): a pinch
   * is twenty-five frames a second, and a region delivered a minute late
   * would magnify the hall at a spot nobody is talking about any more. And
   * the server drops a zoom for any page but the one it shows: a detail
   * framed right after "Next", while the turn itself was still on its way
   * (or being re-sent by the convergence above), magnified nothing in the
   * hall. So after a reconnect, and whenever the server arrives on our page,
   * the console compares its view with the server's word and, if they
   * differ, says its own once more, as final.
   */
  let wasOffline = false
  let heardPage: number | null = null
  let zoomOwed = $state(false)
  $effect(() => {
    const down = offline
    const at = lecture?.page ?? null
    const mine = wanted
    untrack(() => {
      if ((wasOffline && !down) || (at !== null && at === mine && at !== heardPage)) zoomOwed = true
      wasOffline = down
      heardPage = at
    })
  })
  /*
   * AFTER A RECONNECT, THE SERVER'S WORD IS THE WELCOME'S, not the echo heard
   * before the drop. The control socket says it is open before the welcome
   * batch is read, so the `zoomNow` in hand at that moment is the old one:
   * compared with it, a view the hall had lost while we were away (the
   * clicker turned away and back, which resets the zoom) read as delivered,
   * the debt was marked paid, and the welcome's own word, arriving a moment
   * later on an unchanged page, raised nothing. So the `lecture` frame in
   * hand when the socket opens is remembered, and the debt waits for a newer
   * one: the welcome always carries the lecture.
   */
  let zoomStale: typeof lecture | undefined
  let controlWas = session.controlConnected
  $effect(() => {
    const up = session.controlConnected
    untrack(() => {
      if (up && !controlWas) zoomStale = lecture
      controlWas = up
    })
  })
  $effect(() => {
    const frame = lecture
    if (!zoomOwed || !leading || offline || lecture?.page !== wanted || frame === zoomStale) return
    untrack(() => {
      zoomOwed = false
      const mine = zoomTarget !== null && zoomTarget.page === wanted ? zoomTarget.zoom : null
      const heard = session.zoomNow !== null && session.zoomNow.page === wanted ? session.zoomNow.zoom : null
      if (!sameZoom(mine, heard)) sendZoom(wanted, mine, true)
    })
  })

  /*
   * THE WIRE. A pinch's frames go at most once per pointer tick
   * (`LASER_EVERY_MS`, the rhythm the server relays the hall's motion at),
   * the latest one winning; the final one goes at once and cancels whatever
   * was waiting, so the hall settles exactly where the hand did.
   */
  let zoomSentAt = 0
  let zoomTimer: number | undefined
  let zoomDue: { page: number; zoom: LectureZoom | null } | null = null

  function sendZoom(page: number, zoom: LectureZoom | null, final: boolean): void {
    window.clearTimeout(zoomTimer)
    zoomTimer = undefined
    zoomDue = null
    if (!leading) return
    const now = performance.now()
    const wait = final ? 0 : zoomSentAt + LASER_EVERY_MS - now
    if (wait > 0) {
      zoomDue = { page, zoom }
      zoomTimer = window.setTimeout(() => {
        const due = zoomDue
        zoomDue = null
        zoomTimer = undefined
        if (due === null || !leading) return
        zoomSentAt = performance.now()
        session.zoomTo(due.page, due.zoom, false)
      }, wait)
      return
    }
    zoomSentAt = now
    session.zoomTo(page, zoom, final)
  }

  /**
   * The ink layer moved the view: a pinch (a stream of frames, then the
   * final one when a finger lifts) or the magnifier's frame (final at once).
   * The pinch is followed at once (`jump`): the view is under the fingers,
   * and any lag reads as dragging through syrup. The frame eases there, as
   * on every screen of the hall.
   */
  function onzoom(next: LectureZoom | null, final: boolean): void {
    // Said while the layer holds the pointer, it is a pinch's (see `pinchSpell`).
    if (busy) pinchSpell = true
    /*
     * A REPORT ABOUT A PAGE BEING LEFT says nothing about the page the
     * console goes to. A turn during a pinch (a clicker, the keyboard, the
     * pen on "Next" while two fingers still hold the view) takes the ink
     * layer's input away before the new picture arrives, and the layer ends
     * the pinch where it stands, as final. That view is the OLD slide's:
     * labelled with the page the console had already turned to, it went to
     * the hall as the new slide's zoom, and the next slide came up magnified
     * at the old one's spot on the console, the projector and every laptop.
     * Until the picture under the fingers is the page the console stays on
     * (`steady`), reports are dropped, and the turn's reset to the whole
     * page stands here and in the hall. The pinch caught by the turn says
     * its last word once the new picture is in: the whole page.
     */
    if (!steady) {
      if (final) pinching = false
      return
    }
    const page = wanted
    if (!final) pinching = true
    zoomHow = pinching ? 'jump' : 'ease'
    zoomTarget = { page, zoom: next }
    if (final) pinching = false
    sendZoom(page, next, final)
    // The magnifier did its job: the hand gets its tool back, to write on
    // the detail at once.
    if (final) disarm()
  }

  /**
   * A deliberate move of the view (a key, "Whole slide"): eased everywhere,
   * and said as final. A move to where the view already is says nothing
   * ("0" on the whole slide, "=" at ×4), unless the HALL is elsewhere: a
   * hall magnified while the console is whole is taken back by "0" and by
   * the key (`keyZoom`), where a check of our own view alone kept both
   * silent.
   */
  function aimZoom(next: LectureZoom | null): void {
    if (!ownZoom) return
    if (sameZoom(next, zoomShownTarget) && sameZoom(next, hallZoom)) return
    pinching = false
    zoomHow = 'ease'
    zoomTarget = { page: wanted, zoom: next }
    sendZoom(wanted, next, true)
  }

  /** Half as close again, or back by as much, about the middle of what is on the sheet. */
  function stepZoom(dir: 1 | -1): void {
    const now = zoomShownTarget
    aimZoom(zoomAround(now, 0.5, 0.5, (now?.z ?? 1) * (dir > 0 ? 1.5 : 1 / 1.5)))
  }

  /**
   * THE "MAGNIFIER" KEY has three states, and one press means one thing in
   * each. At ×1 it ARMS the magnifier: the next drag on the sheet draws a
   * frame, and the lift magnifies it (a tap without a drag, ×2 around the
   * point); a second press disarms it. Once zoomed, the key reads the zoom
   * itself ("×2.5", "Whole slide") and a press goes back to the whole page:
   * on a magnified slide the question in the hand is "how do I get out",
   * never "how do I zoom more" (the frame and the fingers do that). In the
   * prompter there is no sheet to frame on, and its row in "More" only ever
   * takes a zoom away.
   */
  function pressZoom(): void {
    if (!ownZoom) return
    if (zoomed || tele) {
      aimZoom(null)
      disarm()
      return
    }
    if (tool === 'zoom') {
      disarm()
      return
    }
    beforeZoom = tool
    tool = 'zoom'
    palette = null
  }

  /** The magnifier gives the hand its previous tool back; the pointer only while it can shine. */
  function disarm(): void {
    if (tool !== 'zoom') return
    tool = beforeZoom === 'laser' && (offline || !leading) ? 'pen' : beforeZoom
  }

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

  /*
   * THE MAGNIFIER'S KEY joined the rail, and the rail had no slack for it:
   * each step of `fit` is sized so that everything still fits at the step's
   * lower edge (800 and 690 along the rail). The side rail closes the gaps
   * around the tools a little (4 instead of 8 px) below `roomy`, the bottom
   * one gives its tools 52 px and shrinks its two notches before anything
   * else (they are the only parts of it that may shrink). A `tight` rail
   * keeps the key only while it fits; under that it moves into "More"
   * ("Magnifier"), and two fingers on the sheet zoom as ever. The lengths
   * below are the tight rail with the key and a hair to spare: it needs
   * 640 px down the side and 544 across the bottom.
   */
  const zoomOnRail = $derived(fit !== 'tight' || (portrait ? box.w >= 548 : box.h >= 644))
  /** The bottom rail's key widths, by `fit` (see the board "08 · portrait"). */
  const railTool = $derived(fit === 'roomy' ? 'h-full w-16' : 'h-full w-[52px]')
  const railZoom = $derived(
    fit === 'roomy' ? 'h-full w-[72px]' : fit === 'compact' ? 'h-full w-[60px]' : 'h-full w-14',
  )
  const railDeck = $derived(
    fit === 'roomy' ? 'h-full w-16' : fit === 'compact' ? 'h-full w-14' : 'h-full w-[60px]',
  )

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
    closeMenu()
  }

  /* --------------------------------------------------------- sheet menu */

  /*
   * THE SHEET MENU (SheetMenu.svelte): the sheet's paper, and deleting it,
   * for the sheet on screen only. It opens the same way everywhere: a tap on
   * the CURRENT sheet's tile, in the strip under the slide, on the portrait
   * ribbon or in "Pages", where a "⋯" on the tile says so; a tap on any other
   * tile goes to that page. It closes on a tap anywhere else, on Escape, and
   * when the page changes: it is about one sheet, and on another page it
   * would speak about the wrong one.
   */
  let menu = $state<'film' | 'ribbon' | 'grid' | null>(null)
  /** The delete question is open in the menu's place; the tile is ringed in danger meanwhile. */
  let menuAsking = $state(false)
  /** The tile the menu hangs from and the console's frame, measured on opening, scrolling and resizing. */
  let menuAt = $state.raw<{
    tile: Box
    aim: number
    frame: { left: number; top: number; width: number; height: number }
  } | null>(null)
  /** The menu's own height: it opens below its tile when there is no room above. */
  let menuH = $state(0)

  function openMenu(from: 'film' | 'ribbon' | 'grid'): void {
    if (!leading || sheetHere === null) return
    // The tile toggles its menu, as a tool key toggles its palette.
    if (menu === from) {
      closeMenu()
      return
    }
    menu = from
    menuAsking = false
    palette = null
    measureMenu()
  }

  function closeMenu(): void {
    menu = null
    menuAsking = false
    menuAt = null
  }

  /**
   * Measure the tile the menu hangs from: the current sheet's, marked
   * `data-pult-menu-key`. A tile that is gone (the prompter took the screen,
   * the tablet turned and the strip became the ribbon) takes the menu with
   * it: a menu left open with nothing to hang from would make the next tap on
   * the tile close it instead of opening it.
   */
  function measureMenu(): void {
    const frame = root
    const tile = menu === null ? null : frame?.querySelector<HTMLElement>(`[data-pult-menu-key="${menu}"]`)
    if (!frame || !tile) {
      closeMenu()
      return
    }
    const r = tile.getBoundingClientRect()
    const f = frame.getBoundingClientRect()
    // Scrolled out of its strip, the tile is nowhere to hang from either.
    const strip = tile.closest('[data-pult-film], [data-pult-ribbon], [data-pult-pages]')?.getBoundingClientRect()
    if (strip && (r.right <= strip.left || r.left >= strip.right || r.bottom <= strip.top || r.top >= strip.bottom)) {
      closeMenu()
      return
    }
    menuAt = {
      tile: { left: r.left, top: r.top, right: r.right, bottom: r.bottom },
      // The notch points at the "⋯" in the tile's corner, or at the chip's middle.
      aim: menu === 'ribbon' ? (r.left + r.right) / 2 : r.right - 14,
      frame: { left: f.left, top: f.top, width: f.width, height: f.height },
    }
  }

  /** The portrait card is the wider one, with the larger paper samples (board 08a). */
  const menuWide = $derived(portrait)
  const menuSpot = $derived(
    menuAt === null
      ? null
      : menuPlace(menuAt.tile, menuAt.aim, menuAt.frame, { w: menuWide ? 378 : 320, h: menuH > 0 ? menuH : 230 }),
  )
  /** The strokes the delete question names, counted as Undo counts them. */
  const menuStrokes = $derived(menu !== null ? strokesOn(session.ink, wanted) : 0)

  // Another page, another sheet: the menu was about the one that is gone.
  $effect(() => {
    void wanted
    untrack(closeMenu)
  })
  // The console stopped being ours, or the sheet was deleted from under the menu.
  $effect(() => {
    const able = leading && sheetHere !== null
    if (!able) untrack(() => menu !== null && closeMenu())
  })
  // The layout moved: the tile moved with it, or went.
  $effect(() => {
    void box.w
    void box.h
    void hand
    void notesOpen
    void tiers
    void tele
    void portrait
    untrack(() => menu !== null && measureMenu())
  })

  function paperHere(next: SheetPaper): void {
    if (!leading || sheetHere === null) return
    if (readPaper(sheetHere.paper) === next) return
    if (!session.setSheetPaper(wanted, next)) say(tr('room.pult4.sheetsOffline'), 'refusal')
  }

  /**
   * Delete the sheet on screen. The hall, if it was on it, moves back one
   * step along the lecture, and the console follows (the convergence effect).
   */
  function dropHere(): void {
    if (!leading || sheetHere === null) return
    if (!session.dropSheet(wanted)) {
      say(tr('room.pult4.sheetsOffline'), 'refusal')
      return
    }
    closeMenu()
  }

  /**
   * A tap on a tile of the strip, the ribbon or the grid: the slot adds a
   * sheet right there, the current sheet's tile opens its menu, any other
   * tile goes to its page. "Pages" closes once the hand has chosen.
   */
  function tapItem(item: FilmItem, from: 'film' | 'ribbon' | 'grid'): void {
    if (item.kind === 'add') {
      newSheet()
      if (from === 'grid') openPane(null)
      return
    }
    if (item.current) {
      if (item.kind === 'sheet') openMenu(from)
      else if (from === 'grid') openPane(null)
      return
    }
    if (!mayTurn) return
    goTo(item.page)
    if (from === 'grid') openPane(null)
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
  /**
   * The magnifier works in preparation too: a slide can be looked at closer
   * the day before, and nothing is sent (there is no lecture and no hall).
   * The pen does not: ink with no lecture has nowhere to go.
   */
  const canZoom = $derived((leading || preparing) && !failure && !paneOpen && !tele)
  /** What the ink layer is busy with right now. The spring swaps the tool for a while. */
  const liveTool = $derived(
    !canDraw ? (canZoom && tool === 'zoom' ? 'zoom' : 'off') : sprung ? 'laser' : tool,
  )

  /**
   * The ink layer's spell of holding the pointer is a PINCH: two fingers,
   * no pen. The layer reports the view while it holds the pointer for a
   * pinch alone (a magnifier's frame reports once the pointer is let go), so
   * a report inside the spell marks it (`onzoom`).
   *
   * A pinch is no reason for the palm guard below: its 600 ms after the ink
   * layer lets go are for the heel of the WRITING hand, which follows the
   * pen onto the rail. After a pinch there is no pen and no palm, and the
   * window swallowed the thumb's next tap: "Whole slide" or "Next" pressed
   * right after pinching back did nothing, without a word, and only the
   * second tap worked.
   */
  let pinchSpell = false

  function onbusy(next: boolean): void {
    busy = next
    if (next) {
      pinchSpell = false
      // The first touch of the sheet closes the palette: its job is done.
      palette = null
      return
    }
    if (!pinchSpell) lastBusyAt = performance.now()
    pinchSpell = false
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
      const target = event.target as Element | null
      if (palette !== null && !target?.closest('[data-pult-palette], [data-pult-tool]')) palette = null
      // The sheet menu the same way: its tile toggles it, a touch anywhere else closes it.
      if (menu !== null && !target?.closest('[data-pult-menu], [data-pult-menu-key]')) closeMenu()
    }
    node.addEventListener('pointerdown', away, true)
    return () => node.removeEventListener('pointerdown', away, true)
  })

  /*
   * WHERE A PALETTE OPENS: beside ITS OWN KEY, measured, not at a fixed
   * place. Level with the key's top and 12 px off the rail on the sheet's
   * side (mirrored for the left hand), or, in portrait, 12 px above the
   * bottom rail with its left edge on the key's, kept inside the screen. The
   * old palette stood at `left: 84px; top: 136px` whatever the key and
   * whatever the rail's size: under a compact rail it straddled the pen and
   * the highlighter, and the highlighter's and the pointer's palettes would
   * have opened at the pen's. The eye goes from the key to the palette; it
   * should not have to look for it.
   */
  let penNode = $state<HTMLElement | null>(null)
  let markerNode = $state<HTMLElement | null>(null)
  let laserNode = $state<HTMLElement | null>(null)
  /**
   * The open palette's key, its rail (the palette keeps 12 px off the rail's
   * outer edge, its border included), the console's frame and the sheet box,
   * measured on opening, on every resize and whenever the sheet box changes.
   */
  let anchor = $state.raw<{ key: DOMRect; rail: DOMRect; frame: DOMRect; sheet: DOMRect | null } | null>(null)
  /** The open palette's own height: it is kept inside the screen. */
  let paletteH = $state(0)
  const PALETTE_W = 304
  const PALETTE_GAP = 12
  /** How close a palette may come to the screen's edge. */
  const PALETTE_EDGE = 8

  $effect(() => {
    const kind = palette
    const key = kind === 'pen' ? penNode : kind === 'marker' ? markerNode : kind === 'laser' ? laserNode : null
    const frame = root
    // A resize moves the rail (and swaps it for the bottom one in portrait),
    // and the sheet box moves with the divider's share, the notes column
    // and the strip's tiers.
    void box.w
    void box.h
    void hand
    void portraitSheetH
    void notesOpen
    void tiers
    const rail = key?.closest('.pult-rail') ?? key
    const sheet = frame?.querySelector('.pult-sheet') ?? null
    anchor =
      key && rail && frame
        ? {
            key: key.getBoundingClientRect(),
            rail: rail.getBoundingClientRect(),
            frame: frame.getBoundingClientRect(),
            sheet: sheet?.getBoundingClientRect() ?? null,
          }
        : null
  })

  /**
   * Where the open palette stands: the CSS that puts it there, and its card
   * on the screen, the same numbers twice (`paletteGuard` needs the second).
   */
  const palettePlace = $derived.by((): { style: string; card: Box } | null => {
    if (anchor === null) return null
    const { key, rail, frame } = anchor
    if (portrait) {
      const left = Math.round(
        Math.max(PALETTE_EDGE, Math.min(key.left - frame.left, frame.width - PALETTE_W - PALETTE_EDGE)),
      )
      const bottom = Math.round(frame.bottom - rail.top + PALETTE_GAP)
      const under = frame.bottom - bottom
      return {
        style: `left:${left}px;bottom:${bottom}px`,
        card: { left: frame.left + left, top: under - paletteH, right: frame.left + left + PALETTE_W, bottom: under },
      }
    }
    const top = Math.round(Math.max(PALETTE_EDGE, Math.min(key.top - frame.top, frame.height - paletteH - PALETTE_EDGE)))
    if (hand === 'left') {
      const right = Math.round(frame.right - rail.left + PALETTE_GAP)
      const edge = frame.right - right
      return {
        style: `right:${right}px;top:${top}px`,
        card: { left: edge - PALETTE_W, top: frame.top + top, right: edge, bottom: frame.top + top + paletteH },
      }
    }
    const left = Math.round(rail.right - frame.left + PALETTE_GAP)
    return {
      style: `left:${left}px;top:${top}px`,
      card: {
        left: frame.left + left,
        top: frame.top + top,
        right: frame.left + left + PALETTE_W,
        bottom: frame.top + top + paletteH,
      },
    }
  })
  const paletteStyle = $derived(palettePlace?.style ?? '')

  /*
   * WHERE THE CARD IS NOT OVER THE SHEET, IT TAKES THE TOUCH ITSELF.
   *
   * The card's body is transparent to the pointer so that a pen landing in
   * its padding goes on to the sheet (and the palette folds away). Over the
   * sheet that is the point; anywhere else it is a trap. In portrait the
   * card opens over the docked notes, its lowest 36 px over the ribbon's
   * chips: a tap on the hint or the empty bottom of the card, made to be
   * done with it, reached a chip nobody could see, and the hall got a new
   * blank sheet or jumped two slides on. With a tall deck the card reaches
   * the dock's header too ("Prompter", the sizes, "More"). So the parts of
   * the card off the sheet, and in portrait the 12 px down to the rail with
   * the chips' slivers in it, get a guard UNDER the card's chips: a touch
   * there is the card's, and does nothing (film.ts · `uncovered`).
   */
  const paletteGuard = $derived(
    palettePlace === null
      ? []
      : uncovered(palettePlace.card, anchor?.sheet ?? null, portrait ? PALETTE_GAP : 0),
  )

  /**
   * SAFARI'S OWN pinch and double-tap zoom are suppressed at the console's
   * root, not on the document.
   *
   * WebKit's `gesture*` events are the only way to switch off page zoom in
   * Safari, and it must be switched off ONLY here: in the notebook and the
   * reader people need the pinch. On the console the pinch belongs to the
   * SHEET instead: two fingers there zoom the slide inside its frame (the ink
   * layer builds that pinch on pointer events, with the palm and Undo
   * guards), and the hall is shown the same region. That answers the old
   * objection to zooming here at all ("drawing on a magnified piece means
   * not knowing where the stroke will land on the projector"): the
   * projector shows the magnified piece too. What must still never happen is
   * the BROWSER magnifying the whole console: the rail and the notes swell,
   * the page slides under the pen, and none of it reaches the hall.
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
    window.clearTimeout(addingTimer)
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

  /*
   * THE LECTURE AT A GLANCE, in three places and one order (film.ts):
   *
   *  · THE STRIP under the slide (landscape): 96 × 54 thumbnails of the
   *    slides and the sheets in walking order, the slot for a new sheet right
   *    after the page on screen, and "next" on the item the arrow goes to;
   *  · THE RIBBON over the portrait rail: the same as 40 px chips, beside the
   *    "next" line;
   *  · "PAGES", raised from below: the same again, as a grid of 160 × 90.
   *
   * Pictures are drawn only for what is in view and a few more around it
   * (`stripWindow`, `gridWindow`). The canvas budget on iPad is one per
   * process, and when it overflows WebKit starts drawing canvases
   * TRANSPARENT, and not necessarily the ones that overflowed it: the lecture
   * sheet may be the one wiped. A sheet's picture is an SVG (SheetCard) and
   * costs no canvas at all.
   */
  const FILM_W = 96
  const FILM_H = 54
  const FILM_SLOT = 64
  const FILM_GAP = 10
  const FILM_PAD = 4
  /** Pictures drawn past each side of the view, so a flick does not uncover blanks. */
  const FILM_SPARE = 4

  /**
   * 160 × 90 in "Pages", not 120 × 68: 120 px wide is below the threshold of
   * recognising a slide, and an unrecognisable picture is worse than none.
   */
  const GRID_W = 160
  const GRID_H = 90
  const GRID_GAP = 28
  /** A grid row's step: the tile, its caption, and the gap under them. */
  const GRID_ROW = GRID_H + 6 + 14 + 22
  /** The grid's margins at the sides, as drawn. */
  const GRID_PAD = 40

  /** A ribbon chip and the gap after it. */
  const CHIP_STEP = 46

  /**
   * The items of all three, from the one sequence. The slot shows where
   * "＋ Лист" would put a sheet, so only to the hands that can add one.
   */
  const items = $derived(filmItems(sequence, wanted, nextTo, leading))
  /** Where the page on screen stands among them; −1 when the sequence does not have it. */
  const here = $derived(items.findIndex((item) => item.current))
  const slideCount = $derived(Math.max(0, pages))

  /** The proportions of a blank sheet: page 1's, as LecturePage gives one. */
  let deckAspect = $state(9 / 16)
  $effect(() => {
    const source = doc
    if (!source) return
    let alive = true
    void acquirePage(source, 1).then((first) => {
      if (!first) return
      try {
        const base = first.getViewport({ scale: 1 })
        if (alive && base.width > 0) deckAspect = base.height / base.width
      } finally {
        releasePage(source, 1)
      }
    })
    return () => {
      alive = false
    }
  })

  /** Whether a move of the view may glide: a scroll that jumps is kinder to a reduced-motion setting. */
  function glide(): ScrollBehavior {
    return window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth'
  }

  /* --- the strip */

  let film = $state<HTMLDivElement | null>(null)
  let filmView = $state(0)
  let filmScrolled = $state(0)
  const filmLayout = $derived(
    stripLayout(
      items.map((item) => item.kind),
      FILM_W,
      FILM_SLOT,
      FILM_GAP,
      FILM_PAD,
    ),
  )
  const filmRange = $derived(stripWindow(filmLayout, filmScrolled, filmView, FILM_SPARE))

  /*
   * THE CURRENT ITEM STAYS IN VIEW: on every turn the strip moves so that it
   * stands fourth, with the slot and "next" after it (`stripScroll`). Keyed
   * by the page and the strip's size, not by every lecture frame: a hand that
   * scrolled the strip to look further keeps it there until the page
   * changes. A strip that has just appeared is put in place at once; after
   * that it glides.
   */
  const filmKey = $derived(`${wanted}:${items.length}:${filmView}`)
  let filmPlaced: HTMLElement | null = null
  $effect(() => {
    void filmKey
    const node = film
    if (!node || filmView <= 0) return
    untrack(() => {
      if (here < 0) return
      const left = stripScroll(filmLayout, here, filmView, 3, FILM_PAD)
      node.scrollTo({ left, behavior: filmPlaced === node ? glide() : 'auto' })
      filmPlaced = node
      filmScrolled = left
      if (menu === 'film') measureMenu()
    })
  })

  function filmScroll(node: HTMLElement): void {
    filmScrolled = node.scrollLeft
    if (menu === 'film') measureMenu()
  }

  /* --- the ribbon */

  let ribbon = $state<HTMLDivElement | null>(null)
  /** More chips past the ribbon's right edge: the "…" after it says so. */
  let ribbonMore = $state(false)
  /**
   * How many chips the ribbon shows beside its "next" line: six, as drawn,
   * where the dock has the width; four in a narrow window; none in Slide
   * Over, where the line alone has barely the room.
   */
  const ribbonSlots = $derived(box.w >= 600 ? 6 : box.w >= 460 ? 4 : 0)
  const ribbonKey = $derived(`${wanted}:${items.length}:${ribbonSlots}`)
  let ribbonPlaced: HTMLElement | null = null
  $effect(() => {
    void ribbonKey
    const node = ribbon
    if (!node) return
    untrack(() => {
      // A sheet is shown with the slide it belongs to: two chips before it, one before a slide.
      const start = ribbonStart(here, items.length, ribbonSlots, onBoard ? 2 : 1)
      node.scrollTo({ left: start * CHIP_STEP, behavior: ribbonPlaced === node ? glide() : 'auto' })
      ribbonPlaced = node
      ribbonMore = start * CHIP_STEP + node.clientWidth < node.scrollWidth - 2
      if (menu === 'ribbon') measureMenu()
    })
  })

  function ribbonScroll(node: HTMLElement): void {
    ribbonMore = node.scrollLeft + node.clientWidth < node.scrollWidth - 2
    if (menu === 'ribbon') measureMenu()
  }

  /* --- "Pages" */

  let grid = $state<HTMLDivElement | null>(null)
  let gridW = $state(0)
  let gridH = $state(0)
  let gridScrolled = $state(0)
  const gridCols = $derived(gridColumns(gridW - GRID_PAD * 2, GRID_W, GRID_GAP))
  const gridRange = $derived(gridWindow(gridScrolled, gridH, GRID_ROW, gridCols, items.length, 1))
  /** The raised sheet's height: the board's 478 of 820, never the whole screen. */
  const pagesH = $derived(Math.max(280, Math.min(box.h - 96, Math.round(box.h * 0.583))))

  // "Pages" opens with the current item's row second from the top: the row
  // before it, where one came from, is in view as well.
  $effect(() => {
    const node = grid
    if (!node || pane !== 'pages' || gridW <= 0) return
    untrack(() => {
      const top = gridScroll(here, gridCols, GRID_ROW)
      node.scrollTop = top
      gridScrolled = top
    })
  })

  function gridScrollAt(node: HTMLElement): void {
    gridScrolled = node.scrollTop
    if (menu === 'grid') measureMenu()
  }

  /*
   * INK OF BLANK SHEETS: asked for when a sheet's picture comes into view.
   *
   * A sheet's thumbnail is its annotation and nothing else: it is by it that
   * one returns to a sheet ("the one where I derived the limit"). The welcome
   * batch carries one page, and there is no reason to hold every sheet's ink
   * for the whole class, so it is asked for as the strip or "Pages" shows the
   * sheet, once (ink.ts remembers the questions asked). Slides are not asked
   * for: their pictures come from the document.
   */
  $effect(() => {
    // The inventory arrives with the edit counter (ink.ts).
    void session.inkRevision
    const shown = filmOn && !portrait ? items.slice(filmRange.from, filmRange.to) : []
    const listed = pane === 'pages' ? items.slice(gridRange.from, gridRange.to) : []
    untrack(() => {
      for (const item of [...shown, ...listed]) {
        if (item.kind === 'sheet') askInkPage(session, item.page)
      }
    })
  })

  /*
   * THE SHEETS' INK FOR THEIR PICTURES, regrouped between strokes, not during
   * them. Every echo of a stroke being written bumps the ink counter twenty
   * times a second, and rebuilding the paths of every sheet in view that
   * often is work taken from the pen; a quarter of a second after the pen
   * lifts is soon enough for a thumbnail.
   */
  let cardRev = $state(0)
  $effect(() => {
    void session.inkRevision
    if (busy) return
    const timer = window.setTimeout(() => (cardRev += 1), 250)
    return () => window.clearTimeout(timer)
  })
  const sheetInk = $derived.by(() => {
    void cardRev
    const out = new Map<number, InkStroke[]>()
    for (const stroke of untrack(() => session.ink)) {
      if (stroke.page >= 0) continue
      const list = out.get(stroke.page)
      if (list) list.push(stroke)
      else out.set(stroke.page, [stroke])
    }
    return out
  })

  /** The paper a sheet of the list is ruled with. */
  function paperOf(page: number): SheetPaper {
    return readPaper(lecture?.sheets?.find((sheet) => sheet.page === page)?.paper)
  }

  /**
   * One slide's thumbnail, `w × h` at most, fitted by its own proportions. On
   * the way out it gives back its buffer: `width = height = 1` is the only way
   * to make WebKit release it; the garbage collector does not give it back
   * in time.
   *
   * And its page: taken from the shared cache (lib/pdf-pages.ts) and given
   * back when the render ends, so a strip scrolled through sixty slides does
   * not keep sixty slides decoded. A thumbnail scrolled out of the window
   * mid-render CANCELS that render: it used to run to the end into a 1×1
   * canvas, and a fast flick through the strip queued a dozen renders nobody
   * would see.
   */
  function thumb(node: HTMLCanvasElement, at: { page: number; w: number; h: number }) {
    let dropped = false
    let task: { cancel(): void } | null = null
    void (async () => {
      const source = doc
      if (!source) return
      const page = await acquirePage(source, at.page)
      if (!page) return
      try {
        if (dropped) return
        const base = page.getViewport({ scale: 1 })
        const ratio = Math.min(window.devicePixelRatio || 1, 2)
        const scale = Math.min(at.w / base.width, at.h / base.height)
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
        // Scrolled away or closed mid-render: business as usual.
      } finally {
        task = null
        releasePage(source, at.page)
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
   * The page under the hand is the one the console stays on: its picture has
   * arrived (`sheetReady`), and no "＋ Лист" is about to take the console to
   * a sheet the server has yet to name (`adding`). Until then the pen is
   * held, and what the ink layer says about the view belongs to a page being
   * left (see `onzoom`).
   */
  const steady = $derived(sheetReady && !adding)

  /*
   * THE ARMREST in portrait (film.ts · `ARMREST`) is held as padding UNDER
   * the page (see `sheet()`), so it survives the divider: a sheet box dragged
   * smaller shrinks the slide, never the armrest.
   */
  const RAIL_H = 64
  /** The divider between the slide and the notes in portrait. */
  const DIVIDER_H = 28
  /** Below this the docked notes are a clipped line: a header, two lines of talk, the "next" footer. */
  const NOTES_MIN = 200
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
      return Math.round((inner * fitHeight) / fitWidth) + SHEET_PAD * 2 + ARMREST
    }
    return Math.round(box.h * 0.45) + ARMREST
  })
  const SPLIT_STORED = Number(remembered(SPLIT_KEY))
  let split = $state<number | null>(SPLIT_STORED > 0 && SPLIT_STORED < 1 ? SPLIT_STORED : null)
  const portraitSheetH = $derived.by(() => {
    const most = Math.max(0, box.h - RAIL_H - DIVIDER_H - NOTES_MIN)
    const top = Math.min(naturalSheetH, most)
    const least = Math.min(top, Math.max(ARMREST + 160, Math.round((top - ARMREST) * 0.5) + ARMREST))
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
   * How far under the page the armrest's "the hall sees" line stands: 20 px,
   * as drawn, or less where the sheet box ends sooner (landscape with the
   * notes folded leaves a well of a few dozen pixels), so the line never
   * spills into the strip under the box.
   */
  function armrestGap(size: { h: number }): number {
    const room = sheetH - SHEET_PAD - size.h
    return Math.max(2, Math.min(20, room - 18))
  }

  /** What the blank sheet on screen is ruled with; nothing on a slide. */
  const sheetPaper = $derived(
    wanted < 0 ? readPaper(lecture?.sheets?.find((sheet) => sheet.page === wanted)?.paper) : 'plain',
  )

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
   * "WHAT COMES NEXT" IN WORDS: the next item of the lecture, the one the
   * arrow goes to (`nextTo`). A slide by its title from the PDF and the first
   * line of its note; a sheet by its name ("Лист 1"), since it has neither. On
   * slide 14 with a sheet after it, "next" is that sheet and "then" slide 15;
   * on the sheet, "next" is slide 15. It used to say "back to slide 14" on any
   * sheet, while "Next" went on to the following sheet.
   */
  const nextPage = $derived(nextTo)
  const thenPage = $derived(thenTo)
  let titles = $state<Record<number, string>>({})
  /** Whose titles `titles` holds. Not a rune: only checked against. */
  let titlesOf: PDFDocumentProxy | null = null
  /** The slides whose titles are on screen: this one, the next and the one after. */
  const titled = $derived(
    [...new Set([wanted, nextTo ?? 0, thenTo ?? 0])].filter((page) => page > 0).join(','),
  )

  $effect(() => {
    const source = doc
    const wantedTitles = titled
    if (source !== titlesOf) {
      titlesOf = source
      titles = {}
    }
    if (!source || wantedTitles === '') return
    let alive = true
    for (const index of wantedTitles.split(',').map(Number)) {
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

  const nextTitle = $derived(nextPage !== null && nextPage > 0 ? (titles[nextPage] ?? '') : '')
  const nextWords = $derived(nextPage !== null && nextPage > 0 ? firstLine(noteOf(nextPage)) : '')
  const thenTitle = $derived(thenPage !== null && thenPage > 0 ? (titles[thenPage] ?? '') : '')

  /**
   * A page in words, for "next": the slide's title, else the first line of
   * its note, else "Слайд 15"; a sheet by its name, "Лист 1".
   */
  function pageWords(page: number): string {
    if (page < 0) {
      const n = sheetNumber(sequence, page)
      return n > 0 ? tr('room.prompter.sheetNo', { n }) : tr('room.ui.168')
    }
    return titles[page] || firstLine(noteOf(page)) || tr('room.prompter.slideNo', { n: page })
  }

  /** "затем 15 · Рентген…", or "затем Л2" for a sheet, or "затем 16" for a slide without a title. */
  function thenWords(page: number): string {
    const title = page > 0 ? titles[page] : ''
    return title
      ? tr('room.prompter.thenLine', { n: page, title })
      : tr('room.pult4.then', { n: pageMark(page) })
  }

  /**
   * THE READING STRIP under the slide (landscape): page, time, plan, and the
   * strip of thumbnails.
   *
   * Its height is a constant of the window, not of the slide: a strip that
   * took "whatever the slide left" would feed back into the slide's fit.
   * The slide's box is what is left above it, so a 4:3 deck shrinks a
   * little instead of pushing the page number off the screen, and the
   * number, the clock and "next" are on screen whatever the deck.
   */
  const stripH = $derived(box.h >= 1000 ? 190 : box.h >= 800 ? 160 : 116)
  /** The strip of thumbnails is on screen: a document to draw them from, and a window wider than Slide Over. */
  const filmOn = $derived(file !== null && doc !== null && !tiny)
  /** The landscape column the sheet box shares with the strip under it. */
  let columnH = $state(0)
  /**
   * TWO TIERS under the slide (board 06): the readings, and the strip under
   * them across the slide's width. Only while the page keeps the size it has
   * anyway, fitted to the sheet box's width, above the two tiers and a 96 px
   * armrest (film.ts · `twoTiers`); otherwise one row, the strip beside the
   * readings where the "next" thumbnail used to be. The page is never made
   * smaller to make room for thumbnails. The aspect comes from LecturePage
   * (`onfit`): until the first fit, one row, today's layout.
   */
  const tiers = $derived(
    !portrait && filmOn && fitWidth > 0 && fitHeight > 0 && twoTiers(sheetW, columnH, fitHeight / fitWidth),
  )

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
      if (menu !== null) {
        // The sheet menu first: it hangs over "Pages" when opened from there.
        event.preventDefault()
        closeMenu()
      } else if (palette !== null) {
        event.preventDefault()
        palette = null
      } else if (pane !== null) {
        event.preventDefault()
        openPane(null)
      } else if (tool === 'zoom') {
        // The armed magnifier is a tool held for one gesture: Escape puts it down.
        event.preventDefault()
        disarm()
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
    } else if (event.metaKey || event.ctrlKey || event.altKey) {
      /*
       * Everything below is a bare key. With a modifier these are the
       * browser's own: ⌘= and ⌘0 zoom the page, ⌘1 picks a tab, and a
       * presenter reaching for them must get them.
       */
      return
    } else if (event.code === 'Equal' || event.code === 'NumpadAdd') {
      // "=" and "+" (the same key with Shift): half as close again, about the
      // middle of the view. Never blind: not from the prompter, and not over
      // our own copy that failed to open, with no sheet to see the zoom on.
      event.preventDefault()
      if (!tele && !failure) stepZoom(1)
    } else if (event.code === 'Minus' || event.code === 'NumpadSubtract') {
      event.preventDefault()
      if (!tele && !failure) stepZoom(-1)
    } else if (event.code === 'Digit0' || event.code === 'Numpad0') {
      // Zero for the whole slide, as in every viewer: always allowed, it only takes a zoom away.
      event.preventDefault()
      aimZoom(null)
    } else if (/^Digit[1-8]$/.test(event.code)) {
      // The eight pens in their palette order: the digit under the finger is the chip.
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
        data-pult-zoom={zoomMark}
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
      <div class="flex min-h-0 min-w-0 flex-1 flex-col" bind:clientHeight={columnH}>
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
          data-pult-zoom={zoomMark}
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

  {#if palette !== null && leading && anchor !== null}
    <!--
      THE PALETTE of the tool in hand, beside its key (see `paletteStyle`).
      There is no backdrop under it: a tap elsewhere closes it through the
      interceptor on the root (the effect at `palette`) and carries on, onto
      the sheet, onto a key, wherever it landed; a backdrop button across the
      whole console ate the first stroke.

      The palette's body is TRANSPARENT to the pointer; only its chips and
      rows can be pressed (ToolPalette): the palette hangs over the paper, and
      a pen that landed in its padding or a gap used to go into the body: the
      stroke was not drawn and the palette did not close. Off the paper the
      body holds the touch after all (`paletteGuard`): the guard lies under
      the chips (`z-index: -1` inside the palette's own layer), so they stay
      pressable, and over nothing it would let through.
    -->
    <div
      class="pointer-events-none absolute z-20"
      style={paletteStyle}
      data-pult-palette
      bind:offsetHeight={paletteH}
    >
      <ToolPalette
        kind={palette}
        ink={inkColor}
        {penWidth}
        {markerColor}
        {markerWidth}
        {laserShape}
        sheetWidth={fitWidth}
        onink={penIn}
        onpenwidth={penWide}
        onmarker={markerIn}
        onmarkerwidth={markerWide}
        onshape={(shape) => (laserShape = shape)}
      />
      {#each paletteGuard as part (`${part.left} ${part.top}`)}
        <span
          class="pointer-events-auto absolute"
          style={`z-index:-1;left:${part.left}px;top:${part.top}px;width:${part.right - part.left}px;height:${part.bottom - part.top}px`}
          data-pult-palette-guard
          aria-hidden="true"
        ></span>
      {/each}
    </div>
  {/if}

  {@render panes()}

  {#if menu !== null && menuSpot !== null && sheetHere !== null && place !== null}
    <!--
      THE SHEET MENU, hanging from the current sheet's tile (see `menuPlace`):
      over the strip and the ribbon like a palette, over "Pages" when it was
      opened from there. Guarded like the strip: a palm that lands on it right
      after the pen presses nothing.
    -->
    <div
      class="absolute {menu === 'grid' ? 'z-40' : 'z-20'}"
      style={`left:${Math.round(menuSpot.left)}px;${menuSpot.below
        ? `top:${Math.round(menuSpot.top ?? 0)}px`
        : `bottom:${Math.round(menuSpot.bottom ?? 0)}px`}`}
      bind:offsetHeight={menuH}
      data-pult-guard
    >
      <SheetMenu
        n={place.n}
        total={place.total}
        after={sheetHere.after}
        paper={readPaper(sheetHere.paper)}
        strokes={menuStrokes}
        wide={menuWide}
        {offline}
        {veil}
        notch={menuSpot.notch}
        below={menuSpot.below}
        bind:asking={menuAsking}
        onpaper={paperHere}
        ondrop={dropHere}
      />
    </div>
  {/if}

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
      style={behind ? undefined : `transform:scaleX(${deckShare})`}
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
          {pageMark(lecture.page)}&nbsp;→
        </span>
      {/if}
      <span
        class="absolute left-[10px] top-2 flex h-8 items-center font-mono text-gauge tabular-nums {watching ||
        preparing
          ? 'text-muted'
          : 'text-ink'}"
      >
        {pageMark(wanted)}
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
        {pageMark(wanted)}
      </span>
      {#if onBoard}
        <!-- "Л1" over "лист": the number alone could be read as a slide's. -->
        <span class="font-mono text-micro text-faint">{tr('room.ui.159')}</span>
      {:else}
        <span class="font-mono text-micro tabular-nums text-faint">/ {pages || '—'}</span>
      {/if}
    </button>
    {#if fit !== 'tight' && !tiny}
      <div class="flex w-[52px] flex-col items-start justify-center gap-0.5">
        {@render tempo('w-[44px]')}
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

{#snippet swatch(color: string, thick: number, paper: string)}
  <!--
    THE DAB UNDER THE ICON IS ON PAPER. The icon says which tool this is, the
    dab how it is writing right now. The key used to carry only the sample,
    and the pen differed from the marker by the shape of the stroke inside
    it, that is, one had to look closely; on the rail, which one reaches for
    without looking, there is no time to look closely.

    The paper under the dab is not decoration: the console's body is night,
    and the black pen (#101a33) on it gives 1.5:1, that is, invisible. That
    is exactly why the old chip stood here, and this argument survived the
    icon rework. The light pens (yellow, white) lie on dark paper instead
    (pult.ts · `paperFor`): a white dab on white paper shows nothing.

    The dab's height is the real stroke thickness on the glass, capped: a
    fourteen-pixel line on a forty-eight-pixel key would read as a slab, not
    a line.
  -->
  <span class="flex h-[11px] w-7 items-center justify-center" style={`background:${paper}`} aria-hidden="true">
    <span
      class="block w-5 rounded-full"
      style={`height:${Math.min(6, Math.max(2, Math.round(thick)))}px;background:${color}`}
    ></span>
  </span>
{/snippet}

{#snippet toolKeys(size: string, gap: string)}
  <!--
    THE TOOL PALETTE IS ONE ROW: pen, marker, eraser, pointer. Exactly as in
    note-taking apps: pick one, drop another. The pointer is right here, not
    a separate spring on another rail. The pen and the highlighter carry
    what they write with (`swatch`); a second tap on the pen, the
    highlighter or the pointer opens that tool's palette beside its key
    (`data-pult-tool`: the palette's outside-tap closer leaves these alone,
    each toggles its own palette).
  -->
  <button
    bind:this={penNode}
    type="button"
    class="{KEY} {size} flex-col {portrait ? 'gap-1.5' : 'gap-1'} {tool === 'pen' ? 'bg-raised' : ''}"
    data-pult-tool
    aria-label={tr('room.ui.161')}
    aria-pressed={tool === 'pen'}
    aria-expanded={palette === 'pen'}
    onclick={penKey}
  >
    {@render mark(tool === 'pen', false)}
    <Icon name="pencil" size={22} />
    {@render swatch(inkColor, onGlass(penWidth), paperFor(inkColor))}
  </button>
  <span class={gap} aria-hidden="true"></span>
  <button
    bind:this={markerNode}
    type="button"
    class="{KEY} {size} flex-col {portrait ? 'gap-1.5' : 'gap-1'} {tool === 'marker' ? 'bg-raised' : ''}"
    data-pult-tool
    aria-label={tr('room.ui.162')}
    aria-pressed={tool === 'marker'}
    aria-expanded={palette === 'marker'}
    onclick={markerKey}
  >
    {@render mark(tool === 'marker', false)}
    <Icon name="marker" size={22} />
    {@render swatch(markerColor, onGlass(markerWidth), '#ffffff')}
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
    bind:this={laserNode}
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
    <!--
      A COMET: a thin tail that tapers away and the red head the hall sees.
      Not a ringed dot: next to the magnifier's ring a ring with a handle and
      a ring with a tail read as one glyph at a glance, and the magnifier
      came onto the rail one key below.
    -->
    <svg width="24" height="24" viewBox="0 0 24 24" class="block shrink-0" aria-hidden="true">
      <path
        d="M3.6 20.6 L15.3 10.1 L13.9 8.7 Z"
        fill="currentColor"
        stroke="currentColor"
        stroke-width="0.6"
        stroke-linejoin="round"
      />
      <circle cx="16.6" cy="7.4" r="3" fill={LASER_RED} opacity={offline ? 0.4 : 1} />
    </svg>
  </button>
{/snippet}

{#snippet zoomKey(size: string, column: boolean)}
  <!--
    THE MAGNIFIER, three states on one key (see `pressZoom`): at ×1 a
    magnifier with a "+", raised with the inner bar while armed; once
    zoomed, the zoom itself in figures over "Whole slide", on the plain body:
    the key then is not a tool held but the way back, and a raised slab would
    claim a tool nobody holds. "Zoomed" is the console's view, or the hall's
    while the console is whole (`keyZoom`): the way back is offered wherever
    the audience is magnified.
  -->
  {#if zoomed}
    <button
      type="button"
      class="{KEY} {size} flex-col {column ? 'gap-0.5' : 'gap-[3px]'} text-ink"
      aria-label={tr('room.pult4.zoomWhole')}
      title={tr('room.pult4.zoomWhole')}
      onclick={pressZoom}
    >
      <span class="font-mono text-[16px] font-semibold leading-5 tracking-[-0.01em]">
        {zoomTimes(keyZoom?.z ?? 1)}
      </span>
      <span class="whitespace-nowrap text-[11px] leading-[14px] text-muted">{tr('room.pult4.zoomWhole')}</span>
    </button>
  {:else}
    <button
      type="button"
      class="{KEY} {size} {tool === 'zoom' ? 'bg-raised text-ink' : failure ? OFF : 'text-muted'}"
      aria-label={tr('room.pult4.zoom')}
      title={tr('room.pult4.zoom')}
      aria-pressed={tool === 'zoom'}
      disabled={failure}
      onclick={pressZoom}
    >
      {@render mark(tool === 'zoom', false)}
      <svg
        width="24"
        height="24"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        stroke-width="1.8"
        stroke-linecap="round"
        class="block shrink-0"
        aria-hidden="true"
      >
        <circle cx="10.5" cy="10.5" r="6.5" />
        <path d="M15.3 15.3 20.5 20.5" />
        <path d="M10.5 7.6v5.8M7.6 10.5h5.8" />
      </svg>
    </button>
  {/if}
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
      The keys go dark exactly where the lecture ends, by the one order of
      slides and sheets (`backTo`, `nextTo`): "Back" on the first page,
      "Next" on the last, whether that is a slide or a sheet after it. "Next"
      on a sheet no longer says "To slide": it goes wherever the sequence
      goes, and the strip and the footer say where.
    -->
    <button
      type="button"
      class="{KEY} {prevSize} text-muted disabled:text-faint/70"
      disabled={backTo === null}
      aria-label={tr('room.ui.174')}
      onclick={() => step(-1)}
    >
      <Icon name="chevron-left" size={24} />
    </button>
    {#if column}<span class="h-1 shrink-0" aria-hidden="true"></span>{/if}
    <!-- The biggest key: people page forward eight times more often than back. -->
    <button
      type="button"
      class="{KEY} {nextSize} {column ? 'flex-col gap-1' : 'gap-1.5'} text-ink disabled:text-faint/70"
      disabled={nextTo === null}
      aria-label={tr('room.ui.175')}
      onclick={() => step(1)}
    >
      <Icon name="chevron-right" size={28} />
      <span class="{CAP} {!column && fit === 'tight' ? 'sr-only' : ''}">{tr('room.ui.177')}</span>
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
      "＋ ЛИСТ": a new sheet right after the page on screen, wherever that is
      (`newSheet`). A blank sheet is started mid-sentence ("the slide ended,
      but the derivation did not"), and two presses for that are already a
      refusal, so it stays a key of its own. It used to be a toggle,
      "Sheet" on a slide and "Slide" on a sheet, which made a second sheet
      unreachable without the strip; going back is "Back" now, like any
      other page. In preparation there is no lecture to add a sheet to: the
      key is there, dark, and says so. While the server's answer is on its way
      the key stays pressed (`adding`): the pen is held for that moment, and a
      second tap waits for the first.
    -->
    <button
      type="button"
      class="{KEY} {size} gap-1 {CAP} {adding ? 'bg-raised text-ink' : leading && !offline ? 'text-muted' : OFF}"
      aria-label={tr('room.ui.207')}
      aria-busy={adding}
      title={preparing ? tr('room.pult4.sheetNeedsLecture') : tr('room.ui.207')}
      disabled={!leading || offline}
      onclick={newSheet}
    >
      <svg
        width={portrait ? 11 : 10}
        height={portrait ? 11 : 10}
        viewBox="0 0 12 12"
        fill="none"
        stroke="currentColor"
        stroke-width="1.6"
        stroke-linecap="round"
        class="block shrink-0"
        aria-hidden="true"
      >
        <path d="M6 1.5v9M1.5 6h9" />
      </svg>
      {tr('room.ui.168')}
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
    Top to bottom: the fader and "More", the tools, the magnifier and
    "Undo", a spacer, the deck keys and "Notes"; then the turn keys and the
    home indicator's reserve. The page number lives in the strip under the
    slide now, where the eye already is.

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
      <span class="{fit === 'roomy' ? 'h-2' : 'h-1'} shrink-0" aria-hidden="true"></span>
      <div class="flex h-11 shrink-0 items-center justify-center">
        {@render fader('rail')}
      </div>
      <span class="h-1 shrink-0" aria-hidden="true"></span>
      {@render moreKey('h-11 w-full')}
      <span class="{fit === 'roomy' ? 'h-4' : 'h-2'} shrink-0" aria-hidden="true"></span>

      {#if leading}
        {@render toolKeys(key, 'h-1 shrink-0')}
      {/if}
      {#if (leading || preparing) && zoomOnRail}
        <!-- The magnifier is a tool of the hand, the last of the row: it
             changes what the next drag on the sheet does. Preparation has it
             alone: there is no pen without a lecture, but a slide can be
             looked at closer. -->
        {#if leading}<span class="h-1 shrink-0" aria-hidden="true"></span>{/if}
        {@render zoomKey(key, true)}
      {/if}
      {#if leading && fit !== 'tight'}
        <span class="{fit === 'roomy' ? 'h-2' : 'h-1'} shrink-0" aria-hidden="true"></span>
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

      <span class="min-h-1 flex-1" aria-hidden="true"></span>

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
    The swipe on it runs along it, horizontally. Its widths follow `fit`
    (`railTool`, `railZoom`, `railDeck`): an iPad mini in portrait (744) and
    Split View (678) are narrower than the drawn keys, and the turn keys at
    the end were the ones that went off the edge. The two notches are the
    only parts that may shrink (to 4 px), so a window a little narrower than
    its step still fits.
  -->
  <div
    use:swipe={() => 'x'}
    class="pult-rail flex h-16 shrink-0 items-stretch border-t bg-surface {offline
      ? 'border-danger/40'
      : 'border-line'}"
  >
    {@render gaugeFlat()}
    <span class="{fit === 'roomy' ? 'w-4' : 'w-2'} min-w-1" aria-hidden="true"></span>
    {#if tele}
      {@render slideViewKey('h-full w-[104px]', false)}
    {:else}
      {#if leading}
        {@render toolKeys(railTool, 'w-0')}
      {/if}
      {#if (leading || preparing) && zoomOnRail}
        {@render zoomKey(railZoom, false)}
      {/if}
      {#if leading && fit !== 'tight'}
        {#if fit === 'roomy'}<span class="w-1 shrink-0" aria-hidden="true"></span>{/if}
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
    <span class="min-w-1 flex-1" aria-hidden="true"></span>
    {#if fit !== 'tight' && !tele}
      {@render sheetKey(railDeck)}
    {/if}
    {#if preparing || leading}
      {@render deckKey(railDeck)}
    {:else if watching}
      {@render grabKey('my-2 w-[104px]')}
    {/if}
    <span class="{fit === 'roomy' ? 'w-4' : 'w-2'} min-w-1" aria-hidden="true"></span>
    {@render turnKeys(
      fit === 'roomy' ? 'h-full w-14' : fit === 'compact' ? 'h-full w-12' : 'h-full w-[52px]',
      fit === 'roomy' ? 'h-full w-[108px]' : fit === 'compact' ? 'h-full w-[88px]' : 'h-full w-20',
      false,
    )}
  </div>
{/snippet}

<!-- =============================================================== sheet -->

{#snippet sheetOver(size: { w: number; h: number }, view: ZoomView)}
  <!--
    Everything that lies ON the sheet, in one place and in drawing order.

    1. The blanking veil: the canvas at 0.28, the ink at 1.0: a drawing is
       prepared under blanking and the pause is lifted with it already
       there. A well-coloured veil at 0.72 UNDER the ink layer gives exactly
       that frame.
    2. The ink: its canvases and the input layer, owner of all touches on
       the sheet. It is painted at the zoom the page is (`view`), so a
       stroke never slides off the formula it circles while the view moves.
       Here, and only here, it draws the ring that closes at the pen's tip
       while a held stroke is about to straighten (`holdRing`): the hand
       holding the pen needs to see it; the hall must not.
    3. The fader veil: over the sheet AND the ink, inside the sheet.
    4. Feathering: a 1 px `line` edge and 6 px of paper shadow on the well.
    5. The "the audience sees black" slab and a full-sheet target.
    6. Under the page, in the armrest: what part of it the hall sees.
  -->
  {#if lecture?.blank}
    <span class="pointer-events-none absolute inset-0 bg-canvas opacity-[0.72]" aria-hidden="true"
    ></span>
  {/if}

  <InkLayer
    page={shown ?? wanted}
    live={liveTool !== 'off' && (steady || liveTool === 'laser')}
    tool={liveTool}
    {laserShape}
    color={strokeColor}
    width={strokeWidth}
    finger={fingerOn}
    w={size.w}
    h={size.h}
    reach={inkReach(size)}
    zoom={view}
    onzoom={ownZoom ? onzoom : undefined}
    holdRing
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

  {#if hallZoom !== null}
    <!--
      "THE HALL SEES ×2.5", in the armrest under the page, by its left edge:
      the one reminder that the audience is not looking at the whole slide,
      where the eye passes between the page and the strip. A reading, not a
      control: the armrest is where the palm rests, and it presses nothing
      ("Whole slide" is on the magnifier's key). Only while a lecture runs:
      in preparation there is no hall to see anything.
    -->
    <span
      class="pointer-events-none absolute left-0 whitespace-nowrap {LABEL} text-accent-text"
      style={`top:calc(100% + ${armrestGap(size)}px)`}
      data-pult-hall-zoom={hallZoom.z}
    >
      {tr('room.pult4.hallSees', { n: zoomTimes(hallZoom.z) })}
    </span>
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
      style={portrait ? `padding-bottom:${ARMREST}px` : undefined}
    >
      <LecturePage
        {doc}
        page={wanted}
        bare
        align="top"
        {onfit}
        {onshown}
        zoom={zoomShownTarget}
        zoomHow={zoomHowShown}
        paper={sheetPaper}
      >
        {#snippet over(size, view)}
          {@render sheetOver(size, view)}
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
    THE READING STRIP under the slide: the page and the time, and the
    lecture's strip of thumbnails. The readings were the old rail gauge;
    under the slide they are where the eye already is between sentences, and
    the rail is left to the hand. The strip took the place of the single
    "next" thumbnail: it shows the same "next" (`data-pult-next`, captioned
    "15 · дальше"), and around it the slides and sheets in the order the
    arrows walk, with the slot for a new sheet right after the page on screen.

    Two tiers (board 06) when the slide keeps its full size above them
    (`tiers`), the readings over the strip across the slide's width; one
    row otherwise, the strip beside the readings. On a tight window the
    strip's heading goes first.

    Guarded (`data-pult-guard`): it lies under the slide's bottom edge, where
    the writing palm goes, and touches here are swallowed while the pen is
    busy or was lifted less than 600 ms ago.
  -->
  <div
    class="flex shrink-0 {tiers
      ? 'flex-col gap-7 px-3 pb-6'
      : `items-end ${fit === 'roomy' ? 'gap-12' : 'gap-8'} px-3 pb-5 pt-2`}"
    style={`height:${tiers ? TIERS_H : stripH}px`}
    data-pult-guard
    data-pult-strip
  >
    <div class="flex shrink-0 items-end {fit === 'roomy' || tiers ? 'gap-12' : 'gap-8'}">
      <button
        type="button"
        class="{PRESS} flex shrink-0 flex-col items-start gap-1.5 pl-1 text-left enabled:active:bg-line"
        aria-label={tr('room.ui.156')}
        onclick={() => openPane('pages')}
      >
        {#if onBoard}
          <!-- A sheet by its place, and where it stands: "Л2", "лист 2 из 3 · после слайда 14". -->
          <span class="font-mono text-gauge-lg tabular-nums {watching || preparing ? 'text-muted' : 'text-ink'}">
            {pageMark(wanted)}
          </span>
          <span class="flex h-4 items-center gap-2 whitespace-nowrap font-mono text-micro text-muted">
            {place ? placeWords(place, sheetHere?.after ?? null) : tr('room.ui.159')}
            {#if behind && lecture}
              <span class="tabular-nums">{pageMark(lecture.page)}&nbsp;→</span>
            {/if}
          </span>
        {:else}
          <span class="flex h-[14px] items-center gap-2 {LABEL} text-faint">
            {tr('room.prompter.slide')}
            {#if behind && lecture}
              <!-- What the audience sees while the projector catches up. -->
              <span class="font-mono text-code font-normal normal-case tracking-normal text-muted">
                {pageMark(lecture.page)}&nbsp;→
              </span>
            {/if}
          </span>
          <span class="flex items-baseline gap-2">
            <span class="font-mono text-gauge-lg tabular-nums {watching || preparing ? 'text-muted' : 'text-ink'}">
              {pageMark(wanted)}
            </span>
            <span class="font-mono text-title tabular-nums text-faint">/ {pages || '—'}</span>
          </span>
          <span class="flex h-4 items-center">{@render tempo('w-[112px]')}</span>
        {/if}
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
    </div>

    {#if filmOn}
      <div class="flex min-w-0 flex-col gap-1.5 {tiers ? '' : 'flex-1'}">
        {#if tiers || stripH >= 160}
          <span class="flex h-[14px] items-center truncate pl-1 {LABEL} text-faint">
            {deckTitle(tr('room.pult4.film'), slideCount, sheetCount)}
          </span>
        {/if}
        <!--
          THE STRIP: a tap on a thumbnail goes to that page; on the current
          sheet's, it opens the sheet's menu (the "⋯" says so); the dashed
          slot adds a sheet right there, as "＋ Лист" does. The current one
          is ringed (in danger while its delete question is open) and, when
          the hall sees a part of it, the part is framed. It scrolls under
          the finger and keeps the current one in view on every turn.
        -->
        <div
          bind:this={film}
          bind:clientWidth={filmView}
          class="pult-film flex items-start gap-2.5 overflow-x-auto overscroll-x-contain px-1 pt-1"
          onscroll={(event) => filmScroll(event.currentTarget)}
          data-pult-film
        >
          {#each items as item, index (item.kind === 'add' ? `add ${item.page}` : item.page)}
            {#if item.kind === 'add'}
              <button
                type="button"
                class="{PRESS} flex shrink-0 flex-col items-center gap-1.5"
                style={`width:${FILM_SLOT}px`}
                aria-label={itemName(item)}
                data-pult-add
                onclick={() => tapItem(item, 'film')}
              >
                <span
                  class="flex items-center justify-center border-[1.5px] border-dashed border-faint text-muted"
                  style={`width:${FILM_SLOT}px;height:${FILM_H}px`}
                >
                  <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8"
                    stroke-linecap="round" class="block" aria-hidden="true">
                    <path d="M8 2v12M2 8h12" />
                  </svg>
                </span>
                <span class="whitespace-nowrap font-mono text-[11px] leading-[14px] text-muted">
                  {tr('room.pult4.sheetHereShort')}
                </span>
              </button>
            {:else}
              {@const menuable = item.current && item.kind === 'sheet' && leading && sheetHere !== null}
              <button
                type="button"
                class="{PRESS} flex shrink-0 flex-col items-center gap-1.5"
                style={`width:${FILM_W}px`}
                aria-label={itemName(item)}
                aria-current={item.current ? 'page' : undefined}
                aria-haspopup={menuable ? 'dialog' : undefined}
                aria-expanded={menuable ? menu === 'film' : undefined}
                data-pult-page={item.page}
                data-pult-next={item.next ? '' : undefined}
                data-pult-menu-key={menuable ? 'film' : undefined}
                disabled={!item.current && !mayTurn}
                onclick={() => tapItem(item, 'film')}
              >
                {@render face(item, FILM_W, FILM_H, index >= filmRange.from && index < filmRange.to, menuable, 'canvas')}
                <span
                  class="whitespace-nowrap font-mono text-[11px] leading-[14px] {item.current
                    ? 'font-bold text-ink'
                    : item.next
                      ? 'text-muted'
                      : 'text-faint'}"
                >
                  {item.next ? nextMark(item) : itemMark(item)}
                </span>
              </button>
            {/if}
          {/each}
        </div>
      </div>
    {/if}
  </div>
{/snippet}

{#snippet face(item: FilmItem, w: number, h: number, live: boolean, menuable: boolean, ground: 'canvas' | 'surface')}
  <!--
    A tile's picture: a slide's thumbnail (drawn only inside the window, see
    `stripWindow`), or a sheet's paper and ink (SheetCard). The fader's veil
    lies over it as over the sheet: the strip is paper too, and in a dark
    hall a row of white thumbnails is a second light source. The current one
    is ringed: a 2 px gap of the ground, then 2 px of accent (danger while
    its delete question is open); the part the hall sees is framed in it.
  -->
  {@const fitted = fitBox(w, h, deckAspect)}
  {@const ring = menuable && menuAsking ? 'danger' : 'accent'}
  <span
    class="relative block shrink-0 overflow-hidden {item.kind === 'sheet' ? '' : 'bg-line'}"
    style={`width:${w}px;height:${h}px${item.current
      ? `;box-shadow:0 0 0 2px rgb(var(--${ground})),0 0 0 4px rgb(var(--${ring}))`
      : ''}`}
  >
    {#if item.kind === 'sheet'}
      <span
        class="absolute bg-[#f4f6fa]"
        style={`left:${fitted.x}px;top:${fitted.y}px;width:${fitted.w}px;height:${fitted.h}px`}
      >
        <SheetCard
          paper={paperOf(item.page)}
          strokes={live ? (sheetInk.get(item.page) ?? []) : null}
          w={fitted.w}
          h={fitted.h}
        />
      </span>
    {:else}
      <span class="absolute inset-0 flex items-center justify-center">
        {#if live && doc}
          <canvas use:thumb={{ page: item.page, w, h }} class="block"></canvas>
        {/if}
      </span>
    {/if}
    <span class="pult-veil pointer-events-none absolute inset-0 bg-canvas" style={`opacity:${veil}`} aria-hidden="true"></span>
    {#if item.current && zoomShownTarget}
      <span
        class="pointer-events-none absolute border-[1.5px] border-accent"
        style={`left:${fitted.x + zoomShownTarget.x * fitted.w}px;top:${fitted.y + zoomShownTarget.y * fitted.h}px;width:${fitted.w / zoomShownTarget.z}px;height:${fitted.h / zoomShownTarget.z}px`}
        aria-hidden="true"
      ></span>
    {/if}
    {#if menuable}
      <span class="absolute right-0 top-0 flex h-5 w-7 items-center justify-center bg-raised" aria-hidden="true">
        <svg width="16" height="4" viewBox="0 0 16 4" class="block">
          <circle cx="2" cy="2" r="1.6" class="fill-ink" />
          <circle cx="8" cy="2" r="1.6" class="fill-ink" />
          <circle cx="14" cy="2" r="1.6" class="fill-ink" />
        </svg>
      </span>
    {/if}
  </span>
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
    "NEXT" IN WORDS: the next item of the lecture, the one "Next" goes to. A
    slide by its title from the PDF and the first line of its note (a deck
    without text has no titles, and then the note's line speaks alone, or the
    number); a sheet by its name, and then what follows it. A thumbnail
    answers "what comes next" only for someone who looks at it long enough;
    the words are read in the glance the presenter has.

    In portrait the footer is THE RIBBON as well (board 08): the lecture as
    40 px chips, slides as numbers and sheets as paper with "Л1" on it, the
    current one ringed, the slot for a new sheet right after it, and then
    "ДАЛЬШЕ" in words. A tap on a chip goes there; on the current sheet's
    chip it opens the sheet's menu above the ribbon.
  -->
  {#if kind === 'column'}
    <div
      class="flex shrink-0 flex-col gap-2 border-t border-line bg-surface px-7 pb-6 pt-[18px]"
      data-pult-next
    >
      {#if nextPage === null}
        <span class="{LABEL} text-faint">{tr('room.prompter.last')}</span>
      {:else}
        <span class="flex items-center gap-2.5 {LABEL} text-faint">
          {tr('room.prompter.nextNo', { n: pageMark(nextPage) })}
          <Icon name="arrow-right" size={14} />
        </span>
        <span class="line-clamp-2 text-title font-semibold text-ink">{pageWords(nextPage)}</span>
        {#if nextPage < 0 && thenPage !== null}
          <span class="truncate text-[16px] leading-[22px] text-muted">{thenWords(thenPage)}</span>
        {:else if nextTitle && nextWords}
          <span class="truncate text-[16px] leading-[22px] text-muted">{nextWords}</span>
        {/if}
      {/if}
    </div>
  {:else}
    <div class="flex h-[57px] shrink-0 items-center gap-1.5 border-t border-line pl-8 pr-6" data-pult-next>
      {#if ribbonSlots > 0 && items.length > 0}
        <div
          bind:this={ribbon}
          class="pult-film flex shrink-0 items-center gap-1.5 overflow-x-auto overscroll-x-contain"
          style={`max-width:${ribbonSlots * CHIP_STEP - 6}px`}
          onscroll={(event) => ribbonScroll(event.currentTarget)}
          data-pult-ribbon
        >
          {#each items as item (item.kind === 'add' ? `add ${item.page}` : item.page)}
            {#if item.kind === 'add'}
              <button
                type="button"
                class="{PRESS} flex h-10 w-10 shrink-0 items-center justify-center border-[1.5px] border-dashed border-faint text-muted"
                aria-label={itemName(item)}
                data-pult-add
                onclick={() => tapItem(item, 'ribbon')}
              >
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"
                  stroke-linecap="round" class="block" aria-hidden="true">
                  <path d="M12 5v14M5 12h14" />
                </svg>
              </button>
            {:else if item.kind === 'sheet'}
              {@const menuable = item.current && leading && sheetHere !== null}
              <button
                type="button"
                class="{PRESS} relative flex h-10 w-10 shrink-0 items-center justify-center overflow-hidden bg-[#f4f6fa]"
                aria-label={itemName(item)}
                aria-current={item.current ? 'page' : undefined}
                aria-haspopup={menuable ? 'dialog' : undefined}
                aria-expanded={menuable ? menu === 'ribbon' : undefined}
                data-pult-page={item.page}
                data-pult-menu-key={menuable ? 'ribbon' : undefined}
                disabled={!item.current && !mayTurn}
                onclick={() => tapItem(item, 'ribbon')}
              >
                {@render chipPaper(paperOf(item.page))}
                <span class="relative font-mono text-[13px] font-semibold leading-4 text-[#101a33]">{itemMark(item)}</span>
                <span class="pult-veil pointer-events-none absolute inset-0 bg-canvas" style={`opacity:${veil}`} aria-hidden="true"></span>
                {#if item.current}
                  <span
                    class="pointer-events-none absolute inset-0 border-2 {menuable && menuAsking ? 'border-danger' : 'border-accent'}"
                    aria-hidden="true"
                  ></span>
                {/if}
              </button>
            {:else}
              <button
                type="button"
                class="{PRESS} flex h-10 w-10 shrink-0 items-center justify-center bg-raised font-mono text-[14px] leading-4 tabular-nums {item.current
                  ? 'font-semibold text-ink shadow-[inset_0_0_0_2px_rgb(var(--accent))]'
                  : 'font-medium text-muted'}"
                aria-label={itemName(item)}
                aria-current={item.current ? 'page' : undefined}
                data-pult-page={item.page}
                disabled={!item.current && !mayTurn}
                onclick={() => tapItem(item, 'ribbon')}
              >
                {itemMark(item)}
              </button>
            {/if}
          {/each}
        </div>
        {#if ribbonMore}
          <span class="flex h-10 w-6 shrink-0 items-center justify-center font-mono text-[14px] leading-4 text-faint" aria-hidden="true">…</span>
        {/if}
      {/if}
      <div
        class="flex h-10 min-w-0 flex-1 items-center gap-2.5 overflow-hidden {ribbonSlots > 0 && items.length > 0
          ? 'border-l border-line pl-4'
          : ''}"
      >
        {#if nextPage === null}
          <span class="{LABEL} text-muted">{tr('room.prompter.last')}</span>
        {:else}
          <span class="shrink-0 {LABEL} font-normal text-muted">{tr('room.prompter.next')}</span>
          <span class="min-w-0 shrink truncate text-[16px] font-semibold leading-5 text-ink">{pageWords(nextPage)}</span>
          {#if thenPage !== null && fit !== 'tight'}
            <span class="min-w-0 shrink-[3] truncate text-ui-lg text-faint">{thenWords(thenPage)}</span>
          {/if}
        {/if}
      </div>
    </div>
  {/if}
{/snippet}

{#snippet chipPaper(paper: SheetPaper)}
  <!-- A hint of the sheet's paper on its chip: two rules, a cross of them, or a few dots. -->
  {#if paper !== 'plain'}
    <svg width="40" height="40" viewBox="0 0 40 40" class="absolute inset-0 block" aria-hidden="true">
      {#if paper === 'dots'}
        {#each [10, 20, 30] as y (y)}
          {#each [10, 20, 30] as x (x)}
            <circle cx={x} cy={y} r="1" fill="#b4c1da" />
          {/each}
        {/each}
      {:else}
        <path
          d={paper === 'grid' ? 'M6 13.5H34M6 27.5H34M13.5 6V34M27.5 6V34' : 'M6 13.5H34M6 27.5H34'}
          fill="none"
          stroke="#c9d3e6"
        />
      {/if}
    </svg>
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
        <!-- On a sheet: "ЛИСТ 2 | ПОСЛЕ СЛАЙДА 14"; the count lives under the slide. -->
        <span class="shrink-0 whitespace-nowrap {LABEL} text-ink">
          {onBoard ? pageWords(wanted) : tr('room.prompter.slideNo', { n: wanted })}
        </span>
        {#if onBoard && sheetHere}
          <span class="h-3 w-0.5 shrink-0 bg-accent" aria-hidden="true"></span>
          <span class="min-w-0 truncate whitespace-nowrap {LABEL} text-muted">{afterWords(sheetHere.after)}</span>
        {:else if budgetLabel}
          <span class="h-3 w-0.5 shrink-0 bg-accent" aria-hidden="true"></span>
          <span class="shrink-0 whitespace-nowrap {LABEL} text-muted">{budgetLabel}</span>
        {/if}
        <span class="min-w-0 flex-1" aria-hidden="true"></span>
        {@render sizeKeys('boxed')}
        <!--
          An iPad mini's column has no room for it: "More" keeps it. Nor has a
          sheet's header at 1180, where "ПОСЛЕ СЛАЙДА 14" would be cut to
          "ПОСЛЕ СЛАЙ…" for its sake (board 06 draws it without the key).
        -->
        {#if columnW >= (onBoard ? 420 : 370)}{@render fullscreenKey()}{/if}
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
      {tr(onBoard ? 'room.pult4.onSheetShort' : 'room.prompter.onSlideShort', {
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
  {@const title = onBoard ? pageWords(wanted) : titles[wanted] || tr('room.prompter.slideNo', { n: wanted })}
  <div class="flex min-h-0 min-w-0 flex-1 flex-col bg-canvas" data-pult-notes data-pult-guard>
    {#if portrait}
      <div class="flex shrink-0 items-center gap-5 border-b border-line px-6 py-4">
        {@render teleThumb(160, 90)}
        <div class="flex min-w-0 flex-1 flex-col gap-1">
          <span class="font-mono text-gauge tabular-nums text-ink">{preparing ? '—' : stopwatch(runningFor)}</span>
          <span class="flex items-center gap-2.5">{@render slideClock(false, false)}</span>
          {@render teleHallZoom()}
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
            {@render teleHallZoom()}
            <div class="flex h-8 items-center justify-between pt-1">
              <span class="flex items-baseline gap-1.5 font-mono tabular-nums">
                <span class="text-head text-ink">{pageMark(wanted)}</span>
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
      {#if nextPage === null}
        <span class="{LABEL} text-muted">{tr('room.prompter.last')}</span>
      {:else}
        <!-- The next item of the lecture, a sheet included: "Next" goes there. -->
        <span class="w-[72px] shrink-0 {LABEL} font-normal text-muted">{tr('room.prompter.next')}</span>
        <span class="shrink-0 font-mono text-[15px] tabular-nums text-faint">{pageMark(nextPage)}</span>
        <span class="min-w-0 flex-1 truncate {portrait ? 'text-title' : 'text-[22px] leading-7'} font-semibold text-ink">
          {pageWords(nextPage)}
        </span>
        {#if thenPage !== null && !portrait}
          <div class="flex h-14 w-[272px] shrink-0 flex-col justify-center gap-1 border-l border-line pl-5">
            <span class="{LABEL} font-normal text-faint">{tr('room.prompter.thenNo', { n: pageMark(thenPage) })}</span>
            <span class="truncate text-[15px] leading-5 text-muted">
              {thenPage > 0 ? thenTitle || tr('room.prompter.slideNo', { n: thenPage }) : pageWords(thenPage)}
            </span>
          </div>
        {/if}
      {/if}
      {#if !portrait && mayTurn}
        <button
          type="button"
          class="{KEY} ml-auto h-full w-[88px] border-l border-line text-ink disabled:text-faint/70"
          disabled={nextTo === null}
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
  <!--
    The slide on the projector right now, small: the prompter's only picture.
    At the hall's zoom, gliding after it as the projector does: a zoom made on
    the slide stays in the hall while the presenter reads, and the picture
    used to show the whole slide over the words "on the projector", so the
    talk went on about what the hall could not see.
  -->
  <span class="pult-halo-sm relative flex shrink-0 bg-white" style={`width:${w}px;height:${h}px`}>
    {#if doc && !onBoard}
      <LecturePage {doc} page={wanted} bare zoom={hallZoom} zoomHow="glide" />
    {/if}
    <span class="pult-veil pointer-events-none absolute inset-0 bg-canvas" style={`opacity:${veil}`} aria-hidden="true"></span>
  </span>
{/snippet}

{#snippet teleHallZoom()}
  <!--
    "THE HALL SEES ×2.5" in the prompter, under its picture: the armrest's
    line, which lives on the sheet, and the prompter has no sheet. The way
    back is the "Magnifier" row in "More", or "0".
  -->
  {#if hallZoom !== null}
    <span class="whitespace-nowrap {LABEL} text-accent-text" data-pult-hall-zoom={hallZoom.z}>
      {tr('room.pult4.hallSees', { n: zoomTimes(hallZoom.z) })}
    </span>
  {/if}
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

      <div
        class="pult-drawer relative max-h-full border-t border-line bg-surface {pane === 'pages'
          ? 'flex flex-col overflow-hidden'
          : 'overflow-y-auto'}"
        style={pane === 'pages' ? `height:${pagesH}px` : undefined}
      >
        {#if pane === 'pages'}
          <!--
            "PAGES": the whole lecture as a grid of 160 × 90, in the order the
            arrows walk, a sheet at its slide, labelled "Л1". It opens with the
            current row second from the top; a tap goes to a page and lowers
            the sheet, the slot after the current page adds a sheet there and
            lowers it too, and the current sheet's tile opens its menu over
            the grid. Pictures are drawn for the rows in view and one row more
            each side (`gridWindow`).
          -->
          <div class="flex h-14 shrink-0 items-center justify-between pl-10 pr-7">
            <span class="{SECTION} min-w-0 truncate text-muted">
              {deckTitle(tr('room.ui.206'), slideCount, sheetCount)}
            </span>
            <button
              type="button"
              class="{PRESS} flex h-10 shrink-0 items-center px-3 {CAP} text-muted"
              onclick={() => openPane(null)}
            > {tr('room.ui.29')} </button>
          </div>
          <div
            bind:this={grid}
            bind:clientWidth={gridW}
            bind:clientHeight={gridH}
            class="min-h-0 flex-1 overflow-y-auto overscroll-contain px-10 pb-6 pt-1"
            onscroll={(event) => gridScrollAt(event.currentTarget)}
            data-pult-pages
          >
            <div
              class="grid items-start gap-x-7 gap-y-[22px]"
              style={`grid-template-columns:repeat(${gridCols}, ${GRID_W}px)`}
            >
              {#each items as item, index (item.kind === 'add' ? `add ${item.page}` : item.page)}
                {#if item.kind === 'add'}
                  <button
                    type="button"
                    class="{PRESS} flex flex-col items-center gap-1.5"
                    aria-label={itemName(item)}
                    data-pult-add
                    onclick={() => tapItem(item, 'grid')}
                  >
                    <span
                      class="flex flex-col items-center justify-center gap-2 border-[1.5px] border-dashed border-faint text-ink"
                      style={`width:${GRID_W}px;height:${GRID_H}px`}
                    >
                      <svg width="18" height="18" viewBox="0 0 18 18" fill="none" stroke="currentColor" stroke-width="1.8"
                        stroke-linecap="round" class="block" aria-hidden="true">
                        <path d="M9 2v14M2 9h14" />
                      </svg>
                      <span class="text-[13px] font-semibold leading-4">{tr('room.pult4.sheetHere')}</span>
                    </span>
                    <span class="h-[14px]" aria-hidden="true"></span>
                  </button>
                {:else}
                  {@const menuable = item.current && item.kind === 'sheet' && leading && sheetHere !== null}
                  <button
                    type="button"
                    class="{PRESS} flex flex-col items-center gap-1.5"
                    aria-label={itemName(item)}
                    aria-current={item.current ? 'page' : undefined}
                    aria-haspopup={menuable ? 'dialog' : undefined}
                    aria-expanded={menuable ? menu === 'grid' : undefined}
                    data-pult-page={item.page}
                    data-pult-menu-key={menuable ? 'grid' : undefined}
                    disabled={!item.current && !mayTurn}
                    onclick={() => tapItem(item, 'grid')}
                  >
                    {@render face(item, GRID_W, GRID_H, index >= gridRange.from && index < gridRange.to, menuable, 'surface')}
                    <span
                      class="h-[14px] whitespace-nowrap font-mono text-[11px] leading-[14px] {item.current
                        ? 'font-bold text-ink'
                        : item.kind === 'sheet'
                          ? 'text-muted'
                          : 'text-faint'}"
                    >
                      {itemMark(item)}
                    </span>
                  </button>
                {/if}
              {/each}
            </div>
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
          {#if (leading || preparing) && (tele ? zoomed : !zoomOnRail)}
            <!--
              The magnifier's home when a tight rail has no room for its key:
              the same three states in words. Arming it closes the sheet, so
              the next drag on the slide draws the frame.

              And the prompter's way back to the whole slide: its rail has no
              magnifier (there is no sheet to frame on), and a zoom made on
              the slide stays in the hall when the presenter goes to read the
              talk. While there is one, the row is here (and "0" works).

              Zoomed, the row is the way out, never dark: a copy of the deck
              that failed to open has no sheet to magnify, but the hall it
              left magnified must still get the whole slide back.
            -->
            <button
              type="button"
              class="{ROW} border-t border-line-soft text-ink"
              aria-pressed={zoomed ? undefined : tool === 'zoom'}
              disabled={failure && !zoomed}
              onclick={() => {
                pressZoom()
                openPane(null)
              }}
            >
              <span class="flex-1">{tr('room.pult4.zoom')}</span>
              <span class="{CAP} text-muted">
                {zoomed
                  ? tr('room.pult4.zoomBack', { n: zoomTimes(keyZoom?.z ?? 1) })
                  : tr('room.pult4.zoomArm')}
              </span>
            </button>
          {/if}
          {#if mayTurn}
            <!--
              "New sheet", right after the page on screen, as the rail's key: on
              a tight portrait rail this is its home. The count says how many
              the lecture has; going back is "Back", like any other page.
            -->
            <button
              type="button"
              class="{ROW} border-t border-line-soft text-ink disabled:text-faint/70"
              disabled={!leading || offline}
              title={preparing ? tr('room.pult4.sheetNeedsLecture') : undefined}
              onclick={() => {
                newSheet()
                openPane(null)
              }}
            >
              <span class="flex-1">{tr('room.ui.207')}</span>
              {#if sheetCount > 0}
                <span class="{CAP} text-muted">{tr('room.ui.218')} {sheetCount}</span>
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
   * The strip under the slide and the portrait ribbon scroll under the finger
   * and show no scrollbar: a bar under the thumbnails is a second, thinner
   * strip that says nothing the thumbnails do not, and on the night body it
   * is one more lit line.
   */
  .pult-film {
    scrollbar-width: none;
  }

  .pult-film::-webkit-scrollbar {
    display: none;
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
