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
  import { getLocale, tr } from '@shared/i18n'
  import { untrack } from 'svelte'
  import type { PDFDocumentProxy } from 'pdfjs-dist'
  import Icon from '@/components/ui/Icon.svelte'
  import { api } from '@/lib/api'
  import { fullscreenNow, fullscreenPossible, goFullscreen } from '@/lib/fullscreen'
  import { loadPdf } from '@/lib/pdf.svelte'
  import { getSessionState } from '@/lib/session.svelte'
  import { lectureSequence, readPaper, type LectureState } from '@shared/lecture'
  import { baseOf } from '@shared/paths'
  import { actsAfterClass } from '@shared/rules'
  import ConsoleLink from './ConsoleLink.svelte'
  import InkLayer from './InkLayer.svelte'
  import LecturePage from './LecturePage.svelte'
  import NotesPad from './NotesPad.svelte'
  import { LASER_RED } from './laser'
  import { notesEditor, openNotesEditor } from '@/lib/notes-editor.svelte'
  import { luminance } from '@/lib/utils'
  import { INKS, zoomTimes, type Ink } from './pult'
  import { BLANK_KEYS } from './remote'
  import { nextMarkOf, nextWordsOf, roomNext } from './room-next'
  import { slideTitle } from './slide-titles'
  import { sheetPlace, walkLength, walkStep } from './walk'
  import {
    actedAgo,
    agoWords,
    clockOf,
    deviceLong,
    deviceOn,
    deviceWord,
    handheld,
    holderOf,
    lostHands,
    takeAsks,
    takeMessage,
    type Lost,
  } from './takeover'

  interface Props {
    /*
     * Not `state`: runes live nearby, and `$state` in a component body that
     * has a variable of that name reads as a subscription to a `$state`
     * store. The compiler says so unclearly, and the name was worse anyway.
     */
    lecture: LectureState
    /**
     * In which role this screen looks at the lecture. `cohost` is a teacher
     * who does not hold the console: a colleague, or the same teacher in
     * another browser. They see who leads and can take the lecture over.
     */
    role: 'presenter' | 'cohost' | 'audience' | 'projection'
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
   * The pen colours are the console's eight, from one place (`./pult`). A
   * copy here has already drifted from the console once: there the blue pen
   * was explained with measured numbers and removed, here it stood as the
   * second circle. Yet the audience is the same, and so is the projector.
   */
  let tool = $state<'pen' | 'laser' | 'off'>('off')
  let ink = $state(INKS[0].color)
  /** The pen in hand, or the one the next press of the pen key takes. */
  const pen = $derived(INKS.find((choice) => choice.color === ink) ?? INKS[0])

  const presenting = $derived(role === 'presenter')
  const page = $derived(lecture.page)
  /** Host-only here: just the notes and the key link; a student may present too. */
  const host = $derived(session.me.role === 'host')

  /**
   * The zoom the hall is shown on this page (session · `zoomNow`), on every
   * screen of this component: the projector, the students, a teacher
   * watching and the presenter's own laptop show the same region of the
   * slide, or the presenter circles a detail half the room cannot see. A
   * zoom made for another page means nothing here: the whole page.
   *
   * It arrives as targets over the wire, `glide` (LecturePage · `zoomHow`):
   * a lone one, the magnifier or "whole slide", eases there; a live pinch,
   * twenty-five of them a second, is chased as one motion rather than
   * stepped through.
   */
  const zoom = $derived(session.zoomNow !== null && session.zoomNow.page === page ? session.zoomNow.zoom : null)
  /** What the blank sheet on screen is ruled with; nothing on a slide. */
  const paper = $derived(
    page < 0 ? readPaper(lecture.sheets?.find((sheet) => sheet.page === page)?.paper) : 'plain',
  )

  /* --------------------------------------------------------- take-over */

  /*
   * A teacher in the room who does not hold the console used to get the
   * students' one-liner: "presented by Ada", said to Ada herself in her
   * second browser, with no way to take the lecture back and no notes. If
   * the laptop that held it died mid-class, the lecture stayed "presented"
   * by nobody who could still press anything. Now the room says who leads
   * and from where, whether they are still there, offers the take-over, and
   * keeps the notes one press away whoever leads.
   */
  const cohost = $derived(role === 'cohost')
  const holder = $derived(holderOf(lecture, session.person))

  /** A one-second tick for "last action 12 s ago"; only while someone else leads. */
  let now = $state(Date.now())
  $effect(() => {
    if (!cohost && lost === null) return
    now = Date.now()
    const tick = window.setInterval(() => (now = Date.now()), 1000)
    return () => window.clearInterval(tick)
  })
  const acted = $derived(
    cohost ? actedAgo(lecture, session.lectureHeardAt, session.clockSkewMs, now) : null,
  )
  /** How long the holder has been gone, by the server's clock; `null` while connected. */
  const awayFor = $derived(
    holder.awaySince === null ? null : Math.max(0, now - session.clockSkewMs - holder.awaySince),
  )

  /**
   * The console this screen held and lost (takeover.ts · `lostHands`).
   *
   * Read from the state rather than a message: the state is what every tab
   * already gets, again on reconnect, so a laptop that slept through the
   * take-over still says so when it wakes. The previous presenter used to
   * learn about it from the bar silently changing to someone else's name.
   */
  let lost = $state<Lost | null>(null)
  let seen: LectureState | null = null
  $effect(() => {
    const next = lecture
    untrack(() => {
      const gone = lostHands(seen, next, session.me.id, session.person)
      if (gone) {
        lost = gone
        hallView = false
      } else if (next.by === session.me.id) {
        lost = null
      }
      seen = next
    })
  })

  /*
   * The hands that took it went away too: what matters now is the stale
   * lock and the take-over that does not wait, not who took it at 21:14.
   */
  $effect(() => {
    if (lost !== null && holder.awaySince !== null) untrack(() => (lost = null))
  })

  /**
   * "Watch as the hall": the banner folds into the audience's one line.
   * Not remembered: the next lecture starts with the question in view.
   */
  let hallView = $state(false)
  /** The notes column beside the slide, for a teacher watching. */
  let notesShown = $state(true)
  /**
   * Whether the lecture area is wide enough for that column next to a slide
   * still worth looking at. Measured on the area, not the window: the room's
   * side panels take half of a tablet's width.
   *
   * 800, not the 640 it was: the column is never narrower than 280 (a line
   * of notes worth reading, see `NOTES_W_MIN`), and at 640 that left the
   * slide 336 px, a stamp beside a column of scraps. From 800 the slide keeps
   * 484 and more; below it "Notes" opens the full editor (`notesPress`).
   */
  let areaW = $state(0)
  const notesRoom = $derived(areaW >= 800)
  /** The take-over row of keys, measured: taller than one 40 px key means it broke into two rows. */
  let takeRowH = $state(0)
  const TAKE_ROW_PX = 48

  /**
   * "Take over" asks a second time only when it interrupts somebody: a
   * colleague who is connected (takeover.ts · `takeAsks`). The question is
   * dropped when the holder changes and after a few seconds, so a press
   * made later does not count as the answer to an old question.
   */
  let takeAsked = $state(false)
  $effect(() => {
    void lecture.by
    untrack(() => (takeAsked = false))
  })
  $effect(() => {
    if (!takeAsked) return
    const timer = window.setTimeout(() => (takeAsked = false), 6000)
    return () => window.clearTimeout(timer)
  })

  function takeOver(): void {
    /*
     * Now or never: a take-over is not queued without a connection
     * (session.svelte.ts · DISCARDED_OFFLINE), and a press that silently goes
     * nowhere would read as a refusal from the holder.
     */
    if (!session.connected) {
      takeAsked = false
      refuse(tr('room.takeover.offline'))
      return
    }
    if (lost === null && takeAsks(holder) && !takeAsked) {
      takeAsked = true
      return
    }
    takeAsked = false
    session.send(takeMessage(lecture, session.device()))
  }

  /** A space no line breaks at (`glue`, `leadState`). */
  const NBSP = '\u00A0'
  /** A phrase read as one: "page 14", "2 min ago", "online". */
  function glue(text: string): string {
    return text.replace(/ /g, NBSP)
  }

  const holderLong = $derived(deviceLong(holder.device))
  const leadTitle = $derived(
    holder.self
      ? holderLong
        ? tr('room.takeover.leadsSelfFrom', { name: lecture.byName, device: holderLong })
        : tr('room.takeover.leadsSelf', { name: lecture.byName })
      : holderLong
        ? tr('room.takeover.leadsFrom', { name: lecture.byName, device: holderLong })
        : tr('room.takeover.leads', { name: lecture.byName }),
  )
  /**
   * THE STATE LINE BREAKS BETWEEN ITS PARTS, NOT INSIDE THEM.
   *
   * On a middle the room's panels narrow, the keys stand beside this line
   * and it takes two rows; it used to break wherever a space fell: "page" at
   * the end of one row and "14" alone under it, "2 min" cut from its "ago",
   * the dot opening the second row. Now each part is glued with no-break
   * spaces, the dot sticks to the part before it, and the row breaks only
   * after a dot; the one long part, "last action 2 min ago", may also break
   * before its "2 min ago", so a narrow column takes two rows rather than
   * three.
   */
  const leadState = $derived.by(() => {
    const parts = [
      glue(
        awayFor !== null
          ? tr('room.takeover.away', { ago: agoWords(awayFor) })
          : tr('room.takeover.online'),
      ),
    ]
    if (acted !== null) {
      const ago = agoWords(acted)
      const said = tr('room.takeover.acted', { ago })
      const at = said.indexOf(ago)
      parts.push(at > 0 ? `${glue(said.slice(0, at).trimEnd())} ${glue(said.slice(at))}` : glue(said))
    }
    parts.push(glue(page < 0 ? sheetWords(tr('room.takeover.sheet')) : tr('room.takeover.page', { n: page })))
    return parts.join(`${NBSP}· `)
  })
  const takeHint = $derived(
    awayFor !== null
      ? tr('room.takeover.hintAway')
      : holder.self
        ? tr('room.takeover.hintSelf', { on: deviceOn(holder.device) })
        : takeAsked
          ? tr('room.takeover.hintOther', { name: lecture.byName })
          : tr('room.takeover.hintOtherIdle', { name: lecture.byName }),
  )
  const lostMeta = $derived.by(() => {
    if (lost === null) return ''
    const where = deviceWord(lost.device)
    const who = lost.self ? (where ?? lost.name) : where ? `${lost.name} · ${where}` : lost.name
    return `${who} · ${clockOf(lost.at, session.clockSkewMs, getLocale())}`
  })
  /** "pages turned on the iPad" under the slide: whose hand the hall follows. */
  const turnedBy = $derived(
    holder.device
      ? tr('room.takeover.turnedBy', { on: deviceOn(holder.device) })
      : tr('room.takeover.turnedByName', { name: lecture.byName }),
  )

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
   * The slide the audience saw last: where a sheet the list does not know
   * goes back to (walk.ts · `walkStep`), and one of the bounds of a deck
   * this screen has not opened. One, for a screen opened on a sheet.
   */
  let lastSlide = $state(1)
  $effect(() => {
    const at = lecture.page
    untrack(() => {
      if (at > 0) lastSlide = at
    })
  })

  /**
   * THE LECTURE IN THE ORDER IT IS WALKED: slides with their sheets in
   * place (shared/lecture.ts · `lectureSequence`), the same order as the
   * console's, from the same list the server keeps.
   *
   * Counted from the page the audience SEES, like the bound it replaces:
   * with the deck unopened, one past the page on screen
   * (walk.ts · `walkLength`). The same bound, for the same reason, stands in
   * the console (ConsoleView.goTo).
   */
  const deckLength = $derived(walkLength(pages, lecture.sheets, page, lastSlide))
  const sequence = $derived(lectureSequence(deckLength, lecture.sheets))
  /** Where the arrows lead from the page on screen: what the bar's keys can still do. */
  const backTo = $derived(walkStep(sequence, deckLength, page, -1, lastSlide))
  const nextTo = $derived(walkStep(sequence, deckLength, page, 1, lastSlide))
  /** The sheet on screen as "sheet 2 of 3", or `null` on a slide. */
  const sheetAt = $derived(sheetPlace(sequence, page))

  /**
   * WHAT COMES NEXT, wherever the room says it (room-next.ts): the item the
   * bar's ›, Space and the clicker go to from the page on screen, by the
   * same walk as `nextTo`. On slide 14 with a sheet after it that is the
   * sheet, "Л1"; on the sheet, slide 15. It used to be page + 1, so the
   * column showed slide 15 while the arrow beside it put the blank sheet on
   * the projector, and on a sheet the room named nothing at all.
   */
  const nextUp = $derived(roomNext(sequence, deckLength, pages, page, lastSlide))
  /** The slide that comes next, by number, or 0 for a sheet or nothing: the one title read for it. */
  const nextSlideNo = $derived(nextUp !== null && nextUp.sheet === null ? nextUp.page : 0)

  /**
   * The next slide's title, read from the PDF: for the strip under the slide
   * of a teacher watching, and for the presenter whose middle has no room for
   * the "next" thumbnail (the notes header and the caption say it in words
   * instead, see `stacked`). A sheet has no title; its words are its place
   * (room-next.ts · `nextWordsOf`).
   *
   * Keyed by the number, not by `nextUp`: that object is made anew with
   * every frame of the lecture's state, and the title would blink out and
   * back in.
   */
  let nextTitle = $state('')
  $effect(() => {
    const source = doc
    const at = nextSlideNo
    nextTitle = ''
    if (!(cohost || presenting) || !source || at < 1 || at > source.numPages) return
    let alive = true
    void slideTitle(source, at).then((title) => {
      if (alive) nextTitle = title
    })
    return () => {
      alive = false
    }
  })
  /*
   * "Л1" or "15", what the header, the column and the captions write after
   * "next", and the words after it: the slide's title, or the sheet's place.
   * Functions, like `sheetWords`, so `tr` runs at render time and a live
   * language switch reaches them.
   */
  function nextMark(): string {
    return nextUp === null ? '' : nextMarkOf(nextUp)
  }
  function nextWords(): string {
    return nextUp === null ? '' : nextWordsOf(nextUp, nextTitle)
  }
  /** What a sheet that is "next" is ruled with: its thumbnail draws that paper. */
  const nextPaper = $derived(
    nextUp !== null && nextUp.page < 0
      ? readPaper(lecture.sheets?.find((sheet) => sheet.page === nextUp.page)?.paper)
      : 'plain',
  )

  /**
   * A sheet in words: "sheet 2 of 3" where the list knows it, the given bare
   * word where it does not (an older server, a sheet deleted a moment ago).
   * A function, so `tr` runs at render time and a live language switch
   * reaches it.
   */
  function sheetWords(bare: string): string {
    return sheetAt ? tr('room.lecture4.sheetOf', { n: sheetAt.n, total: sheetAt.total }) : bare
  }

  /**
   * A step forward or back along the lecture's order (walk.ts · `walkStep`).
   *
   * "±1" arithmetic is dead on sheets, pages with a NEGATIVE number, in both
   * directions: from sheet −1 "forward" gave 0, "back" gave −2, and both
   * were silently dropped, together with the arrows, the space bar and the
   * presentation clicker plugged into the computer at the projector. Then
   * "forward" from any sheet went back to the slides, while the console
   * went on to the next sheet: the same press took the hall to two places
   * depending on which hand made it. Now both walk the one order the server
   * keeps. The bar walks the sheets that exist and never starts a new one:
   * a white field put in front of the audience mid-sentence by a clicker is
   * not a sheet anybody asked for.
   */
  function turn(step: -1 | 1): void {
    const next = walkStep(sequence, deckLength, wanted ?? page, step, lastSlide)
    if (next !== null) go(next)
  }

  function go(next: number): void {
    if (next === (wanted ?? page)) return
    wanted = next
    asked.add(next)
    session.send({ t: 'lecture:page', page: next })
  }

  /*
   * The console keyboard: the arrows and the space bar turn pages, B blanks
   * the screen, Z removes the last stroke, E asks about erasing the page, 0
   * gives the hall back the whole slide. Exactly what is pressed without
   * looking, and what a presentation clicker sends if you plug it into the
   * computer at the projector.
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
   * THE SETUP HINT LIVES FOR SECONDS, NOT FOR THE WHOLE LECTURE.
   *
   * It used to stand whenever the window was not full screen, and that is
   * not only "while the projection is being set up": a window shared into
   * Zoom or Teams, a window on the second display, any reload (full screen
   * needs a click in that window) all project the corner line to the hall
   * for the rest of the class. Now it shows for eight seconds after the
   * projection opens and for three after the mouse moves in its window,
   * that is, exactly while someone at the laptop is looking at it.
   */
  const HINT_FIRST_MS = 8000
  const HINT_AGAIN_MS = 3000
  let hintUp = $state(false)
  $effect(() => {
    if (role !== 'projection') return
    let timer = 0
    const raise = (ms: number): void => {
      hintUp = true
      window.clearTimeout(timer)
      timer = window.setTimeout(() => (hintUp = false), ms)
    }
    raise(HINT_FIRST_MS)
    const moved = (): void => raise(HINT_AGAIN_MS)
    window.addEventListener('mousemove', moved)
    return () => {
      window.clearTimeout(timer)
      window.removeEventListener('mousemove', moved)
    }
  })

  /**
   * The page whose picture each sheet actually holds (LecturePage ·
   * `onshown`), so the ink follows the picture rather than the number: on a
   * heavy slide the previous picture stays up for the length of a render,
   * and the new page's ink must not be painted over it. One value serves
   * the projection, the audience and the laptop console: this component
   * draws exactly one of those sheets at a time.
   */
  let shown = $state<number | null>(null)
  function onshown(at: number | null): void {
    shown = at
  }
  /**
   * BLANKING IS FOR THE HALL, NOT ONLY FOR THE PROJECTOR.
   *
   * "Pause" exists to hide the slide while the presenter prepares a
   * derivation with the pen; students following on their own laptops and
   * phones kept seeing every stroke and the pointer, and the reveal was
   * spoiled for them (and for everyone joining remotely). The audience role
   * goes dark with the projector; the presenter and other teachers keep the
   * page, as the console does.
   */
  const hidden = $derived(lecture.blank && role === 'audience' && !host)
  /*
   * A dark screen has no sheet, so nothing is shown on it. Forgotten here,
   * the sheet that comes back would carry the page from before the pause
   * (the presenter may have turned meanwhile) until its first render.
   */
  $effect(() => {
    if (hidden || (role === 'projection' && lecture.blank)) untrack(() => (shown = null))
  })

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

  /**
   * THE WAY BACK FROM A ZOOMED HALL, from the laptop.
   *
   * The zoom outlives a take-over (the server keeps it), and every screen of
   * the room shows it, yet only the console could change it. A teacher who
   * took the lecture over on the laptop after the iPad died at ×4 on a
   * detail had the projector and every student stuck on that detail: no key,
   * no letter, nothing but "next" and "back" again, which nobody in front of
   * a hall thinks of. Now the bar carries the zoom and "whole slide" while
   * the hall is zoomed (`zoomBack`), and 0 does the same from the keyboard
   * of the laptop and of the projector, as it does on the console.
   *
   * Not while the console's hands hold it. The server notes the device of
   * the presenter's last act (lecture.ts · `noteAct`), and a zoom is an act.
   * A console opened in a second window of this same browser is the same
   * participant, so this screen leads too, and a press here would leave that
   * console magnified over a whole hall: it keeps its own view while it
   * leads. After a take-over from the laptop, or a page turned or a stroke
   * drawn here, the hands are the laptop's, and so is the key.
   */
  const consoleHands = $derived(lecture.device?.console === true)
  const zoomBack = $derived(pult && zoom !== null && !consoleHands ? zoom : null)

  function wholeSlide(): void {
    if (zoom === null) return
    // Never queued (session · `DISCARDED_OFFLINE`): a press that went nowhere says so.
    if (!session.zoomTo(page, null, true)) refuse(tr('room.lecture5.zoomOffline'))
  }

  function onkeydown(event: KeyboardEvent): void {
    // The clicker's F5 and Escape on the projection live in SessionScreen:
    // they must work on the "waiting for a lecture" screen too.
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
    /*
     * A presentation clicker sends PageUp/PageDown, and the laptop it is
     * plugged into is also where notes get fixed mid-lecture. With the caret
     * in a notes field (marked `data-notes`) those two keys still turn the
     * slide: they are not keys anyone writing needs there, while arrows and
     * Space are, and stay with the field. Before this the clicker went dead,
     * with no sign why, until someone clicked outside the note.
     */
    const clicker =
      (event.key === 'PageDown' || event.key === 'PageUp') &&
      !event.metaKey &&
      !event.ctrlKey &&
      !event.altKey
    if (clicker && target?.closest('[data-notes]')) {
      event.preventDefault()
      turn(event.key === 'PageDown' ? 1 : -1)
      return
    }
    /*
     * The notes editor lies over the room: its list and its buttons are not
     * the lecture, and Space or an arrow pressed there must not turn the
     * hall's slide. Only the clicker reaches through.
     */
    if (notesEditor() && !clicker) return
    if (target?.closest('input, textarea, [contenteditable]')) return
    if (event.key === 'Escape' && (wipeAsked || stopAsked || penOpen)) {
      // A pending question is dismissed the way any question is dismissed,
      // and an open pen palette the way any popover is.
      event.preventDefault()
      wipeAsked = false
      stopAsked = false
      closePens()
      return
    }
    if (event.key === 'ArrowRight' || event.key === 'PageDown' || event.key === ' ') {
      event.preventDefault()
      turn(1)
    } else if (event.key === 'ArrowLeft' || event.key === 'PageUp') {
      event.preventDefault()
      turn(-1)
    } else if (BLANK_KEYS.has(event.code) && !event.metaKey && !event.ctrlKey && !event.altKey) {
      // B, and the clicker's "black screen" key: '.', ',' or W (see ./remote).
      event.preventDefault()
      if (event.repeat) return
      session.send({ t: 'lecture:blank', on: !lecture.blank })
    } else if (
      (event.code === 'Digit0' || event.code === 'Numpad0') &&
      !event.metaKey &&
      !event.ctrlKey &&
      !event.altKey &&
      !event.shiftKey
    ) {
      // The whole slide back for the hall, the console's 0 (`wholeSlide`);
      // with a modifier it stays the browser's own zoom reset. Not over the
      // console's hands (`consoleHands`), as the key.
      if (zoom === null || consoleHands) return
      event.preventDefault()
      if (event.repeat) return
      wholeSlide()
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
  /*
   * The take-over row's keys: 40 px tall, the same press as the bar. They
   * are pressed once a class at most, but at the worst moment of it.
   */
  const BANNER =
    'flex h-10 shrink-0 items-center justify-center whitespace-nowrap ' +
    'transition-[color,background-color,filter,transform] duration-press ease-out ' +
    'enabled:active:scale-[0.97] focus-visible:outline-none focus-visible:ring-2 ' +
    'focus-visible:ring-accent/40'

  /**
   * "Notes" for a teacher watching: the column beside the slide where there
   * is room for it, the full editor where there is not.
   */
  function notesPress(): void {
    if (notesRoom) notesShown = !notesShown
    else openNotesEditor(lecture.file, page > 0 ? page : 1)
  }

  const TOOL =
    'flex h-8 items-center gap-1.5 px-2.5 text-2xs font-bold uppercase tracking-label ' +
    'transition-[color,background-color,border-color,transform] duration-press ease-out ' +
    'enabled:active:scale-[0.97] focus-visible:outline-none focus-visible:ring-2 ' +
    'focus-visible:ring-inset focus-visible:ring-accent/40'

  /* ------------------------------------------------ the room's layout */

  /**
   * WHERE THE PRESENTER'S COLUMN GOES: BY THE MIDDLE'S WIDTH, NOT THE
   * WINDOW'S.
   *
   * The column of "next" and the notes used to be switched on by the window
   * (`lg:`), while what narrows the middle is the room's panels: a 1440
   * window with the files and the Oracle open leaves the lecture 820, which
   * `lg` still called wide. The column stood at 28 % of that, 220 px: "next"
   * floating in empty space, the notes a word per line, the slide shrunk
   * beside them and hanging in the middle of the height.
   *
   * Now the column stands only where 28 % of the inner width is at least
   * 280 (`NOTES_W_MIN`): (1024 − 24) × 0.28. Below that the notes go UNDER
   * the slide, as wide as it, and "next" becomes a line in their header
   * (NotesPad · `next`). At 820 that is a slide 796 wide instead of 561, at
   * 916 805 instead of 630; at 1108 stacking would gain the slide 5 % and
   * lose the thumbnail, so the column stays there.
   *
   * By width alone: the room's header folds and unfolds the height under the
   * presenter's hands, and a layout that flipped with it would move the notes
   * mid-sentence. The height only caps the slide (`slideH`).
   *
   * ONE NOTES FIELD FOR BOTH PLACES (`notesBox`). The width still flips under
   * the presenter's hands: ⌘B on the files panel while typing a note, the
   * Oracle opened, the browser's zoom. The column and the card under the
   * slide used to be two components behind two `{#if}`s, so the flip took
   * the field away with the caret in it, and the keys the presenter went on
   * typing reached this screen's shortcuts instead of the note: Space turned
   * the hall's slide, B blanked the projector, "E E" erased the page's ink
   * for the whole hall. Now one box holds the field in both places, and the
   * flip moves it by its classes: the area turns from a row into a column,
   * and the field keeps its caret, an IME composition and a draft over the
   * ceiling.
   */
  const SIDE_PX = 1024
  const sideRoom = $derived(areaW >= SIDE_PX)
  /** No column of notes is narrower: below it a line holds three words. */
  const NOTES_W_MIN = 280

  /** The presenter's notes: the teacher's own, never those of a student who presents. */
  const speaker = $derived(pult && host)
  /** The column beside the slide: "next" and the notes, where there is room and something to put in it. */
  const column = $derived(pult && sideRoom && (host || nextUp !== null))
  /** The notes under the slide, on a middle with no room for the column. */
  const stacked = $derived(speaker && !sideRoom)
  /**
   * The line under the slide: the watching teacher's ("14 / 50 · pages
   * turned on the Mac … next 15 · Title"), and the "next" of a student who
   * presents (no notes to stand under the slide) on a middle with no column
   * for the thumbnail.
   */
  const caption = $derived(cohost || (pult && !host && !sideRoom && nextUp !== null))
  /**
   * The box beside the slide ("next" and the notes) or under it (the notes
   * alone): one element for both places, so the field in it outlives the
   * flip at `SIDE_PX`. For the teacher who presents it is there at every
   * width; for a student who presents, only as the column with "next".
   */
  const notesBox = $derived(column || stacked)

  /**
   * THE SLIDE'S BOX, WHEN SOMETHING STANDS UNDER IT.
   *
   * A sheet alone fills its column and is pinned to the top of it
   * (LecturePage · `align`), 12 px under the bar on every screen of the
   * room: centred in the height, it hung between two empty bands with the
   * bar above them. With the notes or the caption under it, the box is sized
   * here, so that they stand right under the sheet's edge rather than at the
   * bottom of the column: height = min(width × the page's shape, the column
   * less what goes under it).
   *
   * The notes keep at least 180 px under it, their header and five lines of
   * 18/26, and the caption its one line. Only on a window too short for
   * both does the slide keep half the height and the notes take the rest:
   * an eight-pixel slide over a roomy note is no lecture.
   *
   * From the column's own size and the page's shape, never from the sheet
   * fitted into the box: a box sized by its own content never grows back
   * when the window does, since the sheet is fitted to the box.
   */
  const NOTES_MIN_PX = 180
  /** `gap-3` between the slide and the notes card. */
  const NOTES_GAP_PX = 12
  /** The caption's one line (`text-code`) and `gap-2.5` above it. */
  const CAPTION_PX = 20
  const CAPTION_GAP_PX = 10
  /**
   * Below this width the watching teacher's caption keeps its first half
   * only: "14 / 50 · pages turned on the Mac" takes some 260 px, and what
   * would be left of "next 15 · Title" is "next 1…".
   */
  const CAPTION_NEXT_PX = 420

  /** The slide's column, measured: everything below is counted from it. */
  let colW = $state(0)
  /**
   * The height the slide shares with what stands under it: the content
   * area's, inside its `p-3`. Measured on the area rather than on the slide's
   * column: with the notes under the slide that column holds the slide alone
   * (`notesBox`), and a box sized by what is in it never grows back.
   */
  let areaH = $state(0)
  /** The content area's `p-3`. */
  const AREA_PAD_PX = 12
  const colH = $derived(Math.max(0, areaH - 2 * AREA_PAD_PX))
  /** The page's height over its width (LecturePage · `onfit`); a slide's 16:9 until the first fit. */
  let shape = $state(9 / 16)
  /**
   * The sheet's width as LecturePage fitted it: what stands under the sheet
   * takes it, so as to end exactly at its edges (the box is measured there in
   * whole pixels, and the sheet may come out a fraction narrower than
   * counted here). Zero until the first fit.
   */
  let fitW = $state(0)
  function fitted(size: { w: number; h: number }): void {
    if (size.w <= 0) return
    fitW = size.w
    // Rounded: a fit by width and a fit by height give the same shape a float apart.
    shape = Math.round((size.h / size.w) * 1e4) / 1e4
  }
  const under = $derived(
    stacked ? NOTES_MIN_PX + NOTES_GAP_PX : caption ? CAPTION_PX + CAPTION_GAP_PX : 0,
  )
  /*
   * Not rounded: a box of 447.75 is what a 796-wide 16:9 sheet fills
   * exactly, and a floored 447 shaved a pixel and a third off the sheet's
   * width, and so off everything stacked under it.
   */
  const slideH = $derived(Math.min(colW * shape, Math.max(colH - under, colH / 2)))
  /** How wide what stands under the sheet is: the fitted sheet's width, the counted one until there is one. */
  const slideW = $derived(fitW > 0 ? fitW : slideH / shape)
  /** The stack's width: the slide's, and never a notes card under 280 (a portrait page). */
  const stackW = $derived(Math.max(slideW, Math.min(colW, NOTES_W_MIN)))

  /**
   * The next page's shape, width over height: the thumbnail's box takes it,
   * so it hugs the thumbnail instead of holding a fixed share of the column
   * with the picture floating in it.
   */
  let nextRatio = $state(16 / 9)
  function nextFitted(size: { w: number; h: number }): void {
    if (size.h > 0) nextRatio = Math.round((size.w / size.h) * 1e4) / 1e4
  }
  /**
   * The thumbnail's box is never taller than a 4:3 slide's. A portrait deck
   * (lecture notes in A4) made it 304 × 430 in a 1108 middle and left the
   * notes their bare 180: the picture glanced at from the corner of the eye
   * took the height of the text read with the head raised. A portrait page
   * now stands in the middle of a 4:3 box; 16:9 and 4:3 still fill theirs.
   */
  const THUMB_RATIO_MIN = 4 / 3

  /* ------------------------------------------------------- the bar */

  /**
   * HOW MUCH THE PRESENTER'S BAR SPELLS OUT: BY ITS OWN WIDTH, NOT THE
   * WINDOW'S.
   *
   * The bar is narrowed by the room around it more than by the screen: the
   * file panel and the Oracle leave it 660 of a 1280 window, 820 of a 1440
   * one, 784 of a 1024 one (the Oracle is a drawer there). Every key with
   * its word and eight pens in a row come to 1175; four pens came to 1117,
   * so on every laptop with the panels open "Project" and "End" stood
   * past the right edge, out of reach, and what still fitted was squeezed
   * into its keys: "1 / 12" in three lines, "Project" in two, the pens
   * touching.
   *
   * So the bar gives way in a decided order instead, at widths computed
   * from the content (measured in Russian, the longer of the two languages,
   * with the longest page reading on top: "sheet 12 of 50" is 31 px over the
   * counter's own box, which always holds "888 / 888"):
   *
   *  • first the keys with an unmistakable glyph keep only the glyph:
   *    pointer, undo, erase, the tablet link, the projector. The word stays
   *    their name (`aria-label` or an `sr-only` word: screen readers and the
   *    stands press the same names), and the title says the rest. Pause,
   *    Hand and End keep their words: a state that must be read, a tool
   *    without a glyph, and the one key nobody may press by guessing;
   *  • then the pens fold into the pen in hand and a caret that opens the
   *    rest (`penOpen`): 636 px in all;
   *  • below that, on a phone or half a window, the strip scrolls sideways
   *    under a fade, the keys of the start of class going under it first,
   *    and End stays whole at the edge.
   */
  /** Every key but the pens: with their words, and with glyphs where they have them. */
  const KEYS_SPELLED_PX = 998
  const KEYS_GLYPHS_PX = 589
  /** The pens in a row: 24 px a key (`w-6`) and 4 px of air at each end. */
  const PENS_ROW_PX = INKS.length * 24 + 8
  /** The longest page reading over the counter's own box: "sheet 12 of 50" over "888 / 888". */
  const READING_PX = 31
  const spelled = $derived(areaW >= KEYS_SPELLED_PX + PENS_ROW_PX + READING_PX)
  const pensOut = $derived(areaW >= KEYS_GLYPHS_PX + PENS_ROW_PX + READING_PX)
  /**
   * The way back from a zoomed hall (`zoomBack`) comes and goes with the
   * zoom, so the steps above are counted without it: a bar that refolded
   * every key whenever the console zoomed would move what the presenter is
   * about to press. It takes the slack the spelled bar has instead: its
   * words only where they fit beside every other word, its figure alone
   * (the words its name) elsewhere, and past the slack the strip scrolls.
   * Measured in Russian, as the sums above are: the key with its hairline
   * and the figure "×2,5", 72.2; the words "весь слайд" and their gap, 108.
   */
  const ZOOM_KEY_PX = 73
  const ZOOM_WORDS_PX = 108
  const zoomWords = $derived(
    spelled && areaW >= KEYS_SPELLED_PX + PENS_ROW_PX + READING_PX + ZOOM_KEY_PX + ZOOM_WORDS_PX,
  )

  /**
   * HOW MUCH THE AUDIENCE'S LINE SPELLS OUT: the bar's rule, for the line a
   * student and a teacher watching as the hall get instead of it.
   *
   * Notes and Project keep only their glyphs where their words would leave
   * who presents less than `LINE_NAME_PX`: the name is what the line is
   * for, and a key's word stays its title and its name. Counted from the
   * keys this line carries, measured in Russian: "Read on my own" 156,
   * "Take over" 129 and its caret 32, "Notes" 112, "Project" 150, `gap-2`
   * between them; the frame is the padding, the dot, three gaps and a
   * counter of "120 / 120". Where even the glyphs do not leave room (a
   * teacher watching as the hall on a phone), the keys scroll under the
   * bar's fade (`strip`).
   */
  const LINE_FRAME_PX = 32 + 6 + 3 * 8 + 70
  const LINE_NAME_PX = 200
  const lineWords = $derived(
    (onsolo ? 156 + 8 : 0) + (cohost ? 129 + 8 + 32 + 8 : 0) + (host ? 112 + 8 : 0) + (onproject ? 150 : 0),
  )
  const lineGlyphs = $derived(areaW < LINE_FRAME_PX + lineWords + LINE_NAME_PX)
  /**
   * What is left for who presents and the file once the keys stand as they
   * do. Both used to shrink together to a letter each, "Л… · l…": now the
   * file goes first (its tab, right above, names it anyway), then the name,
   * and the line keeps the page and the keys rather than scraps of words.
   */
  const lineRoom = $derived(
    areaW -
      LINE_FRAME_PX -
      (lineGlyphs ? lineWords - (host ? 112 - 32 : 0) - (onproject ? 150 - 32 : 0) : lineWords),
  )
  /** Below this the name would be a letter and an ellipsis. */
  const LINE_WHO_PX = 72
  /** The file only beside a whole name: "Lecture by Ada Lovelace · Mac" is some 200 of it. */
  const LINE_FILE_PX = 280

  /**
   * Whether the strip runs on past its right edge: then a fade says so, as
   * on the notebook's run bar. Not for the last key's own padding
   * (`STRIP_SLACK`, TOOL's px-2.5): a fade laid over a whole key because ten
   * pixels of air were cut would hide what is still there.
   *
   * An overlay, not `mask-image`: a mask paints over every descendant, the
   * pen palette (`position: fixed`) included, and would erase it outside the
   * strip.
   *
   * One strip at a time: the presenter's bar, or the audience's line (see
   * `lineGlyphs`); the two are never on screen together.
   *
   * The strip is `relative` itself: a key that keeps its word only for
   * screen readers (`sr-only`, absolutely placed) had the strip's wrapper
   * for its containing block, so the words of the keys scrolled out of
   * view stood past the bar's right edge and made the whole lecture area
   * some twenty pixels wider than the room's middle on a narrow one.
   */
  const STRIP_SLACK = 10
  let strip = $state<HTMLDivElement | null>(null)
  let stripMore = $state(false)
  function stripMeasure(): void {
    if (strip) stripMore = strip.scrollWidth - strip.clientWidth - strip.scrollLeft > STRIP_SLACK
  }
  $effect(() => {
    const box = strip
    if (!box) return
    stripMeasure()
    const watch = new ResizeObserver(stripMeasure)
    watch.observe(box)
    if (box.firstElementChild) watch.observe(box.firstElementChild)
    return () => watch.disconnect()
  })

  /**
   * THE FOLDED PENS: the pen in hand is a key of its own, and the caret
   * beside it opens all eight, two rows of four.
   *
   * Two keys, not one with a second press (the console's rule for its Pen):
   * with a mouse, "draw with the pen I had" is the press made every few
   * slides, and a palette that opened with it would hang over the slide's
   * corner until the next stroke. A colour from the palette is taken with
   * the pen, as the circles in the row take it, and the palette closes: a
   * colour is the whole question here, there are no widths to try after it.
   *
   * The palette stays in the document while closed (`hidden`): a pen named
   * by its colour ("Pen, red") is then always there to be pressed, whatever
   * the width, by a stand or by a script.
   */
  let penOpen = $state(false)
  let penKey = $state<HTMLElement | null>(null)
  let penCaret = $state<HTMLButtonElement | null>(null)
  let penPalette = $state<HTMLElement | null>(null)
  let penAt = $state({ left: 0, top: 0 })
  /** The palette's border and padding: its pens start this far in. */
  const PALETTE_INSET = 1 + 8
  /** The palette's width: four 24-pixel pens, the gaps between them, the inset on both sides. */
  const PALETTE_W = 4 * 24 + 3 * 4 + 2 * PALETTE_INSET
  const PALETTE_GAP = 12

  /** Closes the palette; a focus left inside it goes back to the caret, not to the page. */
  function closePens(): void {
    if (penOpen && penPalette?.contains(document.activeElement)) penCaret?.focus()
    penOpen = false
  }

  function takePen(color: string): void {
    tool = 'pen'
    ink = color
    closePens()
  }

  function togglePens(): void {
    if (penOpen) {
      closePens()
      return
    }
    const box = (penKey?.firstElementChild ?? penKey)?.getBoundingClientRect()
    if (!box) return
    // Under the key, its first column of pens right under the pen in hand
    // (the palette's border and padding to the left of it), and inside the window.
    penAt = {
      left: Math.max(PALETTE_GAP, Math.min(box.left - PALETTE_INSET, window.innerWidth - PALETTE_W - PALETTE_GAP)),
      top: box.bottom + 4,
    }
    penOpen = true
  }

  /* A press anywhere else closes it; the stroke that press starts still draws. */
  $effect(() => {
    if (!penOpen) return
    const away = (event: PointerEvent): void => {
      const target = event.target instanceof Node ? event.target : null
      if (target && (penPalette?.contains(target) || penKey?.contains(target))) return
      penOpen = false
    }
    window.addEventListener('pointerdown', away, true)
    return () => window.removeEventListener('pointerdown', away, true)
  })
  /* It was placed for this width and this bar: a resize or an unfolded row closes it. */
  $effect(() => {
    void areaW
    void pensOut
    void pult
    untrack(() => (penOpen = false))
  })

  /** Below this luminance a pen is lost on the night bar: black #101a33 is 0.011, purple 0.13. */
  const DEEP_INK = 0.03

  /**
   * The edge a pen's circle needs to be seen at all on the bar's ground: the
   * light pens (pult.ts · `light`, the ones for dark slides) vanish on the
   * day bar, white entirely, and the near-black one on the night bar. A
   * hairline in the ink colour, dark by day and light by night, exactly
   * where the circle would otherwise merge with the ground.
   */
  function edge(choice: Ink): string {
    if (choice.light) return 'border-ink/25'
    return luminance(choice.color) < DEEP_INK ? 'border-transparent dark:border-ink/35' : 'border-transparent'
  }
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
      <!-- Pure black: a word in the middle of a dark projector is read by the
           whole hall, and the presenter already has "Projection dimmed" on
           the console. The state stays for screen readers. -->
      <div class="flex flex-1" role="status">
        <span class="sr-only">{tr('room.ui.276')}</span>
      </div>
    {:else if failure}
      <div class="flex flex-1 items-center justify-center px-8 text-center text-ui text-white/70">
        {failure}
      </div>
    {:else}
      <div class="flex min-h-0 flex-1 p-4">
        <LecturePage {doc} {page} {onshown} {zoom} zoomHow="glide" {paper} projector>
          {#snippet over(size, view)}
            <InkLayer
              page={shown ?? page}
              live={false}
              tool="off"
              color={lecture.color}
              width={0.004}
              w={size.w}
              h={size.h}
              zoom={view}
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
    {#if !full && fullscreenPossible() && !lecture.blank}
      <!--
        The hint lives only WHILE the window is not full screen, and even
        then only for a few seconds (see `hintUp`): a window shared into a
        call is never full screen, and the hall would read this corner for
        the whole class. Never on a blanked screen: black means black. The
        arrows are mentioned only to the owner of the slides: it does not
        turn anyone else's.
      -->
      <p
        class="pointer-events-none absolute bottom-4 right-5 text-2xs uppercase tracking-label text-white/35 transition-opacity duration-300 {hintUp
          ? 'opacity-100'
          : 'opacity-0'}"
        aria-hidden={!hintUp}
      >
        {mine ? tr('room.ui.279') : ''}{tr('room.ui.280')} </p>
    {/if}
  </div>
{:else}
  <section class="flex min-h-0 flex-1 flex-col bg-surface" bind:clientWidth={areaW}>
    {#if pult}
      <!--
        The console. The bar under the tabs, where the notebook has Run All:
        each tab has its own, and it is always under it.

        One strip and one key. The strip holds the lecture in the order of
        how often it is pressed: pages, pens, pointer, undo, erase, pause,
        then (pushed to the right where there is room) what is pressed at
        the start of class: notes, the tablet, the projector. It is the part
        that gives way (see `spelled`) and, at the last, scrolls, so what
        goes under the fade first is the projector, not the pause. "End"
        stays whole at the edge, outside the strip: a question that widens
        it squeezes the strip instead, and the key never moves from under
        the pointer that is about to press it a second time.
      -->
      <div class="flex h-[34px] shrink-0 items-stretch border-b border-line bg-canvas" data-lecture-bar>
        <div class="relative flex min-w-0 flex-1">
          <div
            bind:this={strip}
            class="min-w-0 flex-1 overflow-x-auto overflow-y-hidden [scrollbar-width:none] [&::-webkit-scrollbar]:hidden relative"
            onscroll={() => {
              stripMeasure()
              penOpen = false
            }}
          >
            <!--
              `w-max`, so no key is squeezed and none wraps its word; not
              `whitespace-nowrap`, which the tablet link's panel would inherit
              and run its sentences off its own edge.
            -->
            <div class="flex h-full w-max min-w-full items-stretch">
              <!-- The arrows go dark where the lecture's order ends, sheets
                   included: slide 1 with a sheet before it still has a "back". -->
              <button
                type="button"
                class="{TOOL} w-8 justify-center text-muted hover:text-ink disabled:opacity-30"
                disabled={backTo === null}
                aria-label={tr('room.ui.174')}
                onclick={() => turn(-1)}
              >
                <Icon name="chevron-left" size={14} />
              </button>
              <!--
                The counter keeps a box of "888 / 888" whatever it reads, the
                slash pinned in it: the page right-aligned in three digits,
                the total left-aligned in three. It used to be as wide as its
                reading, so the "next" arrow stepped right under the pointer at
                page 10, and in a squeezed bar "14 / 50" stood in a column. A
                sheet's reading ("sheet 12 of 50") is centred and may grow it:
                the bar's sums are counted for it (`READING_PX`).
              -->
              <span
                class="flex min-w-[calc(9ch+0.5rem)] items-center justify-center whitespace-nowrap px-1 font-mono text-2xs tabular-nums text-ink"
              >
                {#if page < 0}
                  {sheetWords(tr('room.ui.159'))}
                {:else}
                  <!-- One run of text, so the spaces around the slash are not
                       trimmed off as the ends of a flex item's line. -->
                  <span
                    ><span class="inline-block min-w-[3ch] text-right">{page}</span> / <span
                      class="inline-block min-w-[3ch]">{pages || '—'}</span
                    ></span>
                {/if}
              </span>
              <button
                type="button"
                class="{TOOL} w-8 justify-center text-muted hover:text-ink disabled:opacity-30"
                disabled={nextTo === null}
                aria-label={tr('room.ui.175')}
                onclick={() => turn(1)}
              >
                <Icon name="chevron-right" size={14} />
              </button>

              <span class="my-2 w-px bg-line" aria-hidden="true"></span>

              {#if pensOut}
                <span class="flex items-stretch px-1">{@render pens()}</span>
              {:else}
                <!--
                  The pens folded (see `penOpen`): the one in hand, taken by
                  its own press as a circle of the row is, and the caret to
                  the other seven.
                -->
                <span bind:this={penKey} class="flex items-stretch pl-1">
                  <button
                    type="button"
                    class="press flex w-6 items-center justify-center focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent/40"
                    title={tr('room.extra.83', { p0: pen.short })}
                    aria-label={tr('room.extra.83', { p0: pen.short })}
                    aria-pressed={tool === 'pen'}
                    onclick={() => takePen(pen.color)}
                  >
                    <span
                      class="h-3.5 w-3.5 rounded-full border {edge(pen)} {tool === 'pen'
                        ? 'scale-110 ring-[1.5px] ring-ink ring-offset-[1.5px] ring-offset-canvas'
                        : ''}"
                      style={`background:${pen.color}`}
                    ></span>
                  </button>
                  <button
                    type="button"
                    bind:this={penCaret}
                    class="press flex w-5 items-center justify-center text-muted hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent/40 {penOpen
                      ? 'text-ink'
                      : ''}"
                    title={tr('room.ui.184')}
                    aria-label={tr('room.ui.184')}
                    aria-expanded={penOpen}
                    aria-controls="lecture-pens"
                    onclick={togglePens}
                  >
                    <Icon name="chevron-down" size={10} />
                  </button>
                </span>
                <!-- `fixed`: the scrolling strip it lives in would clip it. -->
                <div
                  bind:this={penPalette}
                  id="lecture-pens"
                  class="fixed z-40 grid-cols-[repeat(4,24px)] auto-rows-[28px] gap-x-1 border border-line bg-canvas p-2 shadow-pop {penOpen
                    ? 'grid'
                    : 'hidden'}"
                  style={`left:${penAt.left}px; top:${penAt.top}px`}
                  role="group"
                  aria-label={tr('room.ui.184')}
                >
                  {@render pens()}
                </div>
              {/if}

              <button
                type="button"
                class="{TOOL} {tool === 'laser' ? 'bg-raised text-ink' : 'text-muted hover:text-ink'}"
                aria-pressed={tool === 'laser'}
                title={tr('room.ui.282')}
                onclick={() => (tool = tool === 'laser' ? 'off' : 'laser')}
              >
                <!--
                  The console's comet: a tapering tail and the red head the
                  hall sees. Not the bolt it used to wear (a bolt reads as
                  brightness, and "Pause" darkens two keys away), and not
                  the ringed dot of the icon set, which at this size is a
                  magnifier.
                -->
                <svg width="14" height="14" viewBox="0 0 24 24" class="shrink-0" aria-hidden="true">
                  <path
                    d="M3.6 20.6 L15.3 10.1 L13.9 8.7 Z"
                    fill="currentColor"
                    stroke="currentColor"
                    stroke-width="0.6"
                    stroke-linejoin="round"
                  />
                  <circle cx="16.6" cy="7.4" r="3" fill={LASER_RED} />
                </svg>
                <span class={spelled ? '' : 'sr-only'}>{tr('room.ui.165')}</span>
              </button>
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
                <Icon name="undo" size={12} /> <span class={spelled ? '' : 'sr-only'}>{tr('room.ui.286')}</span> </button>
              <!--
                "Erase" asks, and not out of politeness: it stands in one row
                with "Pause", and a mouse miss by one button to the left took
                away all of the slide's annotation for the audience and on the
                projector, instantly and irrecoverably: lecture ink lives only
                in the server's memory, it has no history. On the console the
                same operation is protected by holding the eraser and by a
                separate question. The question is always spelled out, even
                where the key at rest is a glyph: it has to be read.
              -->
              <button
                type="button"
                class="{TOOL} {wipeAsked ? 'bg-danger/10 text-danger' : 'text-muted hover:text-ink'}"
                title={tr('room.ui.287')}
                onclick={askWipe}
                onblur={() => (wipeAsked = false)}
              >
                <Icon name="eraser" size={12} />
                <span class={spelled || wipeAsked ? '' : 'sr-only'}>{wipeAsked ? tr('room.ui.288') : tr('room.ui.221')}</span>
              </button>
              <button
                type="button"
                class="{TOOL} {lecture.blank ? 'bg-ink text-canvas' : 'text-muted hover:text-ink'}"
                aria-pressed={lecture.blank}
                title={tr('room.ui.290')}
                onclick={() => session.send({ t: 'lecture:blank', on: !lecture.blank })}
              > {tr('room.ui.291')} </button>

              {#if zoomBack}
                <!--
                  The way back from a zoomed hall (`zoomBack`), there only
                  while the hall is zoomed: a magnifier with a minus and the
                  zoom in figures, as the console's key shows it, and "whole
                  slide" where the bar has the room (`zoomWords`). After
                  "Pause", so nothing to its left moves when it comes; on a
                  bar with no room left the strip scrolls under the fade, the
                  keys of the start of class going under it first. In the
                  accent, the colour the console says "the hall sees ×2.5" in:
                  it is the hall's state as much as a key.
                -->
                <span class="my-2 w-px bg-line" aria-hidden="true"></span>
                <button
                  type="button"
                  class="{TOOL} text-accent-text hover:text-ink"
                  title={tr('room.lecture5.zoomBack', { n: zoomTimes(zoomBack.z) })}
                  aria-label={tr('room.pult4.zoomWhole')}
                  onclick={wholeSlide}
                >
                  <svg
                    width="14"
                    height="14"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    stroke-width="2"
                    stroke-linecap="round"
                    class="shrink-0"
                    aria-hidden="true"
                  >
                    <circle cx="10.5" cy="10.5" r="6.5" />
                    <path d="M15.3 15.3 20.5 20.5" />
                    <path d="M7.6 10.5h5.8" />
                  </svg>
                  <span class="font-mono tabular-nums tracking-normal">{zoomTimes(zoomBack.z)}</span>
                  <span class={zoomWords ? '' : 'sr-only'}>{tr('room.pult4.zoomWhole')}</span>
                </button>
              {/if}

              <span class="flex-1"></span>

              <!--
                The console is handed over by the TEACHER. A student may
                present a lecture too (the `board: 'room'` rule allows it),
                but `/handoff` answers them 403, and a button whose only
                outcome is a refusal does not belong here.
              -->
              <!--
                A glyph, not a word, on this bar: it is already the most
                crowded line in the room, and the notes column beside the
                slide carries its own way into the editor (NotesPad ·
                onexpand).
              -->
              {@render notesButton('', true)}
              {#if host}
                <ConsoleLink class="{TOOL} text-muted hover:text-ink" caption={spelled} />
              {/if}
              {@render projectButton(!spelled)}
            </div>
          </div>
          {#if stripMore}
            <span
              class="pointer-events-none absolute inset-y-0 right-0 w-10 bg-gradient-to-l from-canvas"
              aria-hidden="true"
            ></span>
          {/if}
        </div>

        <div class="flex shrink-0 items-stretch whitespace-nowrap">
          <!--
            The hairline between "Project" and "End" is not decoration: these
            are two neighbouring buttons, the first pressed at the start of
            class and the second irreversible. The second-press question is
            the main protection; the gap holds back the finger.
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
          {#if page < 0}{sheetWords(tr('room.ui.296'))}{:else}{page} / {pages || '—'}{/if}
        </span>
        {@render notesButton('-my-2')}
        {@render projectButton()}
      </div>
    {:else if cohost && !hallView}
      <!--
        A TEACHER WHO DOES NOT HOLD THE CONSOLE: who leads, from where, are
        they still there, and the take-over. A full row, not the audience's
        line: this is the screen a teacher lands on when their laptop died
        mid-class, and the way back has to be the first thing they see.

        Right after a take-over of THIS screen's console the same row says so
        ("taken over · iPad · 21:14") and offers it back: the presenter used
        to learn about it from the bar silently changing to another name.
      -->
      <div
        class="flex shrink-0 flex-wrap items-center gap-x-[18px] gap-y-3 border-b border-line bg-canvas py-4 pl-5 pr-4"
        data-takeover
        role="region"
        aria-label={lost ? tr('room.takeover.taken') : leadTitle}
      >
        {@render deviceGlyph(lost ? lost.device : holder.device, lost ? true : awayFor === null)}
        <!--
          The words claim the width of their state line (26rem, its Russian
          length) before the keys may stand beside them. With a quarter of
          that they shared a 1280 window's middle with the Oracle open and
          broke into two rows each: "Mac" alone under the name, "page" at the
          end of a row and "14" under it. Below that width the keys go under
          the words, as they already did on narrower middles. A fixed basis
          rather than the words' own width: "1 min ago" grows a digit every
          few seconds, and the banner must not jump with it. Never more than
          the row beside the glyph (its 40 and the 18 gap, and a pixel against
          rounding), or on a phone the words would leave the glyph alone in a
          row of its own.
        -->
        <div class="flex min-w-0 flex-1 basis-[min(26rem,calc(100%_-_59px))] flex-col gap-1">
          <p class="text-title font-semibold text-ink" aria-live="polite">
            {lost ? tr('room.takeover.taken') : leadTitle}
          </p>
          <p class="font-mono text-code text-muted">
            {#if lost}{lostMeta} · {tr('room.takeover.takenBody')}{:else}{leadState}{/if}
          </p>
        </div>
        <!--
          The keys and the hint as one group pushed to the right edge: beside
          the words on a wide room, under them (still at the right, where the
          hand already is) when the room's panels leave the middle narrow.
        -->
        <div class="ml-auto flex max-w-full shrink-0 flex-col items-end gap-2">
          <div class="flex flex-wrap items-center justify-end gap-2" bind:clientHeight={takeRowH}>
            <button
              type="button"
              class="{BANNER} border border-line bg-canvas px-4 text-ui-lg text-ink hover:bg-surface"
              onclick={() => {
                lost = null
                takeAsked = false
                hallView = true
              }}
            >
              {lost ? tr('room.takeover.watchOnly') : tr('room.takeover.watch')}
            </button>
            <button
              type="button"
              class="{BANNER} px-5 text-code font-bold uppercase tracking-label {takeAsked
                ? 'bg-danger text-white'
                : 'bg-primary text-primary-ink hover:brightness-110'}"
              data-take
              aria-describedby="take-hint"
              onclick={takeOver}
              onblur={() => (takeAsked = false)}
            >
              {lost
                ? tr('room.takeover.giveBack')
                : takeAsked
                  ? tr('room.takeover.takeSure')
                  : tr('room.takeover.take')}
            </button>
            {#if host}
              <!--
                The hairline parts the take-over from the notes in one row;
                when the row breaks, "Notes" goes under alone and the row
                parts them, so the hairline would stand at the end of the
                first row parting nothing. Made invisible, not removed: its
                width stays, so the row cannot fit again without it and break
                again with it, back and forth.
              -->
              <span class="mx-2 h-6 w-px bg-line {takeRowH > TAKE_ROW_PX ? 'invisible' : ''}" aria-hidden="true"></span>
              <button
                type="button"
                class="{BANNER} gap-2 px-3.5 text-ui-lg font-semibold text-ink {notesShown && notesRoom
                  ? 'bg-raised'
                  : 'bg-canvas hover:bg-surface'}"
                aria-pressed={notesShown && notesRoom}
                title={tr('room.notesEditor.openTitle')}
                data-notes-open
                onclick={notesPress}
              >
                <Icon name="file" size={14} />
                {tr('room.notesEditor.open')}
              </button>
            {/if}
          </div>
          <!--
            As wide as the row of keys above it, not a fixed 392: `w-0` keeps
            it out of the group's own width, `min-w-full` stretches it to what
            the keys made. The idle hint was folded into two lines under a
            row with room for it in one, and the banner was a line taller on
            every narrow middle for it.
          -->
          <p id="take-hint" class="w-0 min-w-full text-balance text-right text-code text-muted">
            {lost ? tr('room.takeover.takenInk') : takeHint}
          </p>
        </div>
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
          {#if lineRoom >= LINE_WHO_PX}
            <span class="truncate">
              {#if cohost}{leadTitle}{:else}{tr('room.ui.297')} {lecture.byName}{/if}
            </span>
          {/if}
          {#if lineRoom >= LINE_FILE_PX}
            <span class="shrink-0 text-faint">·</span>
            <span class="truncate font-mono">{baseOf(lecture.file)}</span>
          {/if}
        </span>
        <span class="shrink-0 font-mono tabular-nums">
          {#if page < 0}{sheetWords(tr('room.ui.296'))}{:else}{page} / {pages || '—'}{/if}
        </span>
        <!--
          The keys give way as the presenter's bar does (see `lineGlyphs`):
          `w-max`, so none is squeezed into two rows of its word, Notes and
          Project down to their glyphs where the line is short, and at the
          last the keys scroll under the bar's fade. They used to be bare
          items of the line: on a phone, and in a middle the room's panels
          narrowed, "Read on my own" and "Project" each stood in two rows
          while the presenter's name was cut to its first letter.
        -->
        <div class="relative flex min-w-0 self-stretch">
          <div
            bind:this={strip}
            class="relative min-w-0 overflow-x-auto overflow-y-hidden [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
            onscroll={stripMeasure}
          >
            <div class="flex h-full w-max items-center gap-2">
              {#if onsolo}
                <!--
                  Step away from the shared page, and come back. In this
                  product the teacher is FOLLOWED, not tied to: a student who
                  needs to reread the previous slide must not have to wait for
                  the end of the lecture to do it.
                -->
                <button
                  type="button"
                  class="{TOOL} text-muted hover:text-ink"
                  title={tr('room.ui.298')}
                  onclick={() => onsolo?.()}
                > {tr('room.ui.299')} </button>
              {/if}
              {#if cohost}
                <!-- Folded by "Watch as the hall": the take-over stays one press away. -->
                <button
                  type="button"
                  class="{TOOL} {takeAsked ? 'bg-danger/10 text-danger' : 'text-accent-text hover:text-ink'}"
                  data-take
                  title={takeHint}
                  onclick={takeOver}
                  onblur={() => (takeAsked = false)}
                >
                  {takeAsked ? tr('room.takeover.takeSure') : tr('room.takeover.takeShort')}
                </button>
                <button
                  type="button"
                  class="{TOOL} text-muted hover:text-ink"
                  title={tr('room.takeover.unwatch')}
                  aria-label={tr('room.takeover.unwatch')}
                  onclick={() => (hallView = false)}
                >
                  <Icon name="chevron-down" size={12} />
                </button>
              {/if}
              {@render notesButton('', lineGlyphs)}
              {@render projectButton(lineGlyphs)}
            </div>
          </div>
          {#if stripMore}
            <span
              class="pointer-events-none absolute inset-y-0 right-0 w-10 bg-gradient-to-l from-canvas"
              aria-hidden="true"
            ></span>
          {/if}
        </div>
      </div>
    {/if}

    {#if failure}
      <!--
        The document did not open ON OUR SIDE: an expired token, a broken
        network, a corrupt cache. At the projector it is most likely open, and
        the lecture can be carried through with the buttons and the notes.
        Taking away from the presenter what still works because of our own
        failure is the worst thing this screen can do.

        The notes follow the rule they follow beside a slide (`sideRoom`): a
        column where the middle has room for one, the same card under the
        message where it has not. They used to be hidden below the window's
        `lg`, that is, on every laptop with the room's panels open, exactly
        when the slides were gone too.
      -->
      <div class="flex min-h-0 flex-1 gap-3 p-3 {sideRoom ? '' : 'flex-col'}">
        <div class="flex min-w-0 flex-col items-start gap-3 {sideRoom ? 'flex-1' : 'shrink-0'}">
          <p class="text-ui text-muted">{failure}</p>
          <!-- A manual retry: a network that blinked at the moment of start
               is no reason to get through the class without slides on your
               own screen. -->
          <button type="button" class="btn-outline h-8 px-3 text-2xs" onclick={() => (attempt += 1)}> {tr('room.ui.191')} </button>
        </div>
        {#if presenting && host}
          <aside
            class="flex min-h-0 flex-col border border-line bg-canvas {sideRoom ? 'w-[28%] shrink-0' : 'flex-1'}"
          >
            <NotesPad
              file={lecture.file}
              {page}
              compact
              onexpand={() => openNotesEditor(lecture.file, page > 0 ? page : 1)}
            />
          </aside>
        {/if}
      </div>
    {:else}
      <!--
        The content area: a row where the middle has room for a column beside
        the slide (the presenter's "next" and notes, or the notes of a teacher
        watching), a column where it has not, the slide over the notes
        (`stacked`). The notes box is the same element either way
        (`notesBox`): the flip moves it, it never swaps it for another.
      -->
      <div class="relative flex min-h-0 flex-1 gap-3 p-3 {stacked ? 'flex-col' : ''}" bind:clientHeight={areaH}>
        <!--
          The slide's own column. The sheet is pinned to its top and centred
          across it (LecturePage · `align`); its box fills the column, or, with
          the notes or the caption under it, takes the height counted for it
          (`slideH`), so that they stand under the sheet's edge. Over the
          notes the column is the slide alone, as tall as its box.
        -->
        <div class="flex min-w-0 flex-col gap-2.5 {stacked ? 'shrink-0' : 'min-h-0 flex-1'}" bind:clientWidth={colW}>
          <div
            class="flex min-w-0 {under > 0 ? 'shrink-0' : 'min-h-0 flex-1'}"
            style:height={under > 0 ? `${slideH}px` : null}
          >
            {#if hidden}
              <!-- The hall's screen is dark: so is this one, with a word, since
                   it is the student's own screen and black alone reads as broken.
                   No page, no ink, no pointer underneath. -->
              <div class="flex min-w-0 flex-1 items-center justify-center bg-black" role="status">
                <span class="text-2xs uppercase tracking-section text-white/40">{tr('room.ui.276')}</span>
              </div>
            {:else}
              <LecturePage {doc} {page} {onshown} {zoom} zoomHow="glide" {paper} align="top" onfit={fitted}>
                {#snippet over(size, view)}
                  <!-- The pen waits for the picture (see `shown`); the pointer
                       does not, it draws nothing. -->
                  <InkLayer
                    page={shown ?? page}
                    live={pult && (shown === page || tool === 'laser')}
                    tool={pult ? tool : 'off'}
                    color={ink}
                    width={0.004}
                    w={size.w}
                    h={size.h}
                    zoom={view}
                    onrefuse={refuse}
                  />
                {/snippet}
              </LecturePage>
            {/if}
          </div>
          {#if caption}
            <!--
              Whose hand the hall follows, and what comes next: the watching
              teacher reads the lecture's pace without a console of their own.
              Ten pixels under the sheet and exactly as wide, rather than at
              the bottom of the area under a band of nothing; muted, not
              faint, since it is read. A student who presents gets the "next"
              half alone: they have no notes to stand there.
            -->
            <div
              class="flex shrink-0 items-center gap-4 self-center font-mono text-code text-muted {cohost
                ? 'justify-between'
                : 'justify-end'}"
              style:width="{slideW}px"
            >
              {#if cohost}
                <span class="max-w-full shrink-0 truncate">
                  {#if page < 0}{sheetWords(tr('room.takeover.sheet'))}{:else}{page} / {pages || '—'}{/if} · {turnedBy}
                </span>
              {/if}
              {#if nextUp !== null && (!cohost || slideW >= CAPTION_NEXT_PX)}
                {@const words = nextWords()}
                <span class="min-w-0 truncate">
                  {tr('room.takeover.next', { n: nextMark() })}{words ? ` · ${words}` : ''}
                </span>
              {/if}
            </div>
          {/if}
        </div>
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

        {#if notesBox}
          <!--
            The presenter's column is the Speaker View: what comes next and
            what to say about it. Knowing this without peeking ahead on the
            projector. It stands only where the middle has room for it
            (`sideRoom`); elsewhere the same box goes under the slide
            (`stacked`), a card as wide as the slide, from 12 px under it down
            to the bottom, never under 180 (`slideH`), and "next" turns into a
            line in its header: the thumbnail would take the height the notes
            need.

            "Next" is what the arrow goes to (`nextUp`): a slide by its picture,
            a sheet by its paper and its place, "Л1 · лист 1 из 2", since blank
            paper alone says nothing. It is shown only when something comes,
            while the notes are always shown: on the last slide there is still
            talking to do, and a strip that vanished exactly there would read
            as a breakage. The thumbnail's box takes the page's own shape (no
            taller than 4:3, `THUMB_RATIO_MIN`), so the picture fills it and
            the notes card starts 12 px under it; it held 42 % of the column
            before, the picture floating in the middle of it. On a short
            window the thumbnail gives way (`min-h-0`) before the notes go
            under 180: they are read with the head raised from the screen,
            while the thumbnail is glanced at from the corner of the eye.

            Neither the audience nor the projection gets the notes in any
            form, neither empty nor collapsed: what is "just empty" will one
            day turn out not to be, and the whole audience will see it.
          -->
          <aside
            class="flex flex-col {stacked ? 'min-h-0 flex-1 self-center' : 'w-[28%] shrink-0 gap-3'}"
            style:width={stacked ? `${stackW}px` : null}
          >
            {#if column && nextUp !== null}
              <div class="flex min-h-0 flex-col gap-2">
                <span class="flex min-w-0 items-center gap-2">
                  <span class="shrink-0 text-micro font-bold uppercase tracking-section text-muted"> {tr('room.ui.197')} </span>
                  {#if nextUp.sheet}
                    <span class="shrink-0 font-mono text-code leading-4 tabular-nums text-ink">{nextMark()}</span>
                    <span class="min-w-0 truncate text-ui leading-4 text-muted">{nextWords()}</span>
                  {/if}
                </span>
                <div class="flex min-h-0 w-full" style:aspect-ratio={Math.max(nextRatio, THUMB_RATIO_MIN)}>
                  <LecturePage {doc} page={nextUp.page} paper={nextPaper} dim align="top" onfit={nextFitted} />
                </div>
              </div>
            {/if}
            {#if speaker}
              <div class="flex flex-1 flex-col border border-line bg-canvas {stacked ? 'min-h-0' : 'min-h-[180px]'}">
                <NotesPad
                  file={lecture.file}
                  {page}
                  compact
                  next={stacked && nextUp !== null ? { mark: nextMark(), title: nextWords() } : null}
                  onexpand={() => openNotesEditor(lecture.file, page > 0 ? page : 1)}
                />
              </div>
            {/if}
          </aside>
        {/if}
        {#if cohost && host && notesShown && notesRoom}
          <!--
            The notes beside the slide for a teacher who does not lead: they
            are written by whoever has a keyboard, whoever holds the console.
            In a narrow middle (the room's panels open on a tablet) the column
            would squeeze the slide to a stamp, so there the "Notes" key opens
            the full editor instead (`notesRoom`, `notesPress`). 36 % of the
            middle, never under 280 (a line of notes worth reading) nor over
            360 (the slide matters more than a longer line).
          -->
          <aside
            class="flex w-[clamp(280px,36%,360px)] shrink-0 flex-col border border-line bg-canvas"
            data-cohost-notes
          >
            <NotesPad
              file={lecture.file}
              {page}
              compact
              onexpand={() => openNotesEditor(lecture.file, page > 0 ? page : 1)}
              roomColumn={{ onclose: () => (notesShown = false) }}
            />
          </aside>
        {/if}
      </div>
    {/if}
  </section>
{/if}

<!--
  The holder's device, drawn: a tablet or a laptop, a pen when it is the
  console, and a dot for "connected" (positive) or "gone" (faint, never red:
  an absent presenter is a fact to act on, not an error).
-->
{#snippet deviceGlyph(device: LectureState['device'], online: boolean)}
  {@const tablet = handheld(device)}
  <span class="relative flex h-10 w-10 shrink-0 items-center justify-center bg-surface text-ink" aria-hidden="true">
    {#if tablet}
      <svg width="26" height="30" viewBox="0 0 26 30" fill="none">
        <rect x="2" y="2" width="18" height="26" rx="2.5" stroke="currentColor" stroke-width="1.6" />
        <path d="M9 24.5h4" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" />
        {#if device?.console}
          <path
            d="M23.5 6v15l-1.25 3-1.25-3V6z"
            class="text-brand-2"
            stroke="currentColor"
            stroke-width="1.3"
            stroke-linejoin="round"
          />
        {/if}
      </svg>
    {:else}
      <svg width="28" height="24" viewBox="0 0 28 24" fill="none">
        <rect x="5" y="4" width="18" height="12" rx="2" stroke="currentColor" stroke-width="1.6" />
        <path d="M2 20h24" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" />
      </svg>
    {/if}
    <span
      class="absolute -right-[3px] -top-[3px] h-2.5 w-2.5 rounded-full border-2 border-canvas {online
        ? 'bg-positive'
        : 'bg-faint'}"
    ></span>
  </span>
{/snippet}

<!--
  "Project" is one button for two places: both the presenter and the
  audience have it, and that is not generosity. The projection is opened on
  SOMEONE ELSE'S machine, the one plugged into the projector, and the person
  at it is most often not the presenter: a lab assistant, a student, anyone
  who entered the room by the same link. Requiring the console for this
  would mean requiring the teacher to walk over to the department laptop.
-->
<!--
  "Notes" opens the speaker-notes editor over the room, for any teacher:
  the one leading, a second teacher watching, and the same teacher in a
  second browser, who used to get no editor anywhere. It opens at the page
  on screen; a blank sheet has no notes, so that opens the first slide.
-->
{#snippet notesButton(extra: string, compact = false)}
  {#if host}
    <button
      type="button"
      class="{TOOL} {extra} text-muted hover:text-ink"
      title={tr('room.notesEditor.openTitle')}
      aria-label={compact ? tr('room.notesEditor.open') : undefined}
      data-notes-open
      onclick={() => openNotesEditor(lecture.file, page > 0 ? page : 1)}
    >
      <Icon name="file" size={12} />
      {#if !compact}{tr('room.notesEditor.open')}{/if}
    </button>
  {/if}
{/snippet}

{#snippet projectButton(glyph = false)}
  {#if onproject}
    <button
      type="button"
      class="{TOOL} text-muted hover:text-ink"
      title={tr('room.ui.300')}
      onclick={() => onproject?.()}
    >
      <Icon name="board" size={12} /> <span class={glyph ? 'sr-only' : ''}>{tr('room.ui.301')}</span> </button>
  {/if}
{/snippet}

<!--
  The pens of the presenter's bar: in the row where it has the room, in the
  palette under the caret where it does not (see `pensOut`). One set of keys
  either way, so the two can never disagree about which pen is in hand.

  The pen is taken by pressing its colour: two separate switches, "pen" and
  "colour", would be two questions where the person asks one.
-->
{#snippet pens()}
  {#each INKS as choice (choice.color)}
    <button
      type="button"
      class="press flex w-6 items-center justify-center focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent/40"
      title={tr('room.extra.83', { p0: choice.short })}
      aria-label={tr('room.extra.83', { p0: choice.short })}
      aria-pressed={tool === 'pen' && ink === choice.color}
      onclick={() => takePen(choice.color)}
    >
      <!--
        The circle grows from STATE, and grows instantly: the state arrives
        by itself, and animating it means drawing it later than it happened
        (the same reason the "on" bar on a console key is not animated).
        Transform is given to the finger: `press` on the button itself, taken
        by name; there are no other transition utilities on it, so nothing
        rewrites `transition-property`.

        The chosen one is ringed with a gap of the bar's own ground: a ring
        laid straight on the circle vanished around the black pen by day and
        the white one by night, and only the 10 % of growth was left to tell
        which pen was in hand.
      -->
      <span
        class="h-3.5 w-3.5 rounded-full border {edge(choice)} {tool === 'pen' && ink === choice.color
          ? 'scale-110 ring-[1.5px] ring-ink ring-offset-[1.5px] ring-offset-canvas'
          : ''}"
        style={`background:${choice.color}`}
      ></span>
    </button>
  {/each}
{/snippet}
