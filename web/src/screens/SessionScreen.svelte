<script lang="ts">
  import Skeleton from '@/components/ui/Skeleton.svelte'
  import { tr, getLocale } from '@shared/i18n'
  /**
   * The seminar itself: the room, and the three things around it.
   *
   * The layout is one decision repeated — the notebook is the page, and Files,
   * People and the oracle are what it is surrounded by. Below about 1100px
   * the oracle folds into a button in the top bar and below about 700px the
   * left rail follows it, each opening as a panel over the room that closes on
   * Escape, on a click outside, or on the button that opened it. Nothing here
   * scrolls the page sideways at any width.
   *
   * This screen owns no seminar state. Everything it draws — the title, who is
   * here, the kernel's mood, the queue — is read from the shared document or
   * from awareness, so what it shows is what everybody else is looking at.
   */
  import { onDestroy, untrack } from 'svelte'
  import { quintOut } from 'svelte/easing'
  import { fade, fly, slide } from 'svelte/transition'
  import { peopleInRoom } from '@/lib/room'
  import { faceOf, namesLine, sameFaces, type Face } from '@/screens/roster'
  import { ruleRefusal } from '@/lib/rule-refusal'
  import { REVEAL_EVENT, revealCell, type RevealTarget } from '@/lib/reveal'
  import { gridFaviconHref } from '@/lib/logo'
  import { firstScreenReady } from '@/lib/boot'
  import Avatar from '@/components/ui/Avatar.svelte'
  import AvatarStack from '@/components/ui/AvatarStack.svelte'
  import Icon from '@/components/ui/Icon.svelte'
  import Notebook from '@/components/notebook/Notebook.svelte'
  import AiPanel from '@/components/panels/AiPanel.svelte'
  import BanMenu from '@/components/panels/BanMenu.svelte'
  import BannedScreen from '@/components/BannedScreen.svelte'
  import FilesPanel from '@/components/panels/FilesPanel.svelte'
  import PeoplePanel from '@/components/panels/PeoplePanel.svelte'
  import TerminalDrawer from '@/components/panels/TerminalDrawer.svelte'
  import PdfReader from '@/components/reader/PdfReader.svelte'
  import LectureView from '@/components/lecture/LectureView.svelte'
  import { fullscreenPossible, goFullscreen, leaveFullscreen } from '@/lib/fullscreen'
  import { keepAwake } from '@/lib/wakelock'
  import ImageView from '@/components/reader/ImageView.svelte'
  import ThemeSwitch from '@/components/ui/ThemeSwitch.svelte'
  import Wordmark from '@/components/ui/Wordmark.svelte'
  import type { StoredIdentity } from '@/lib/identity'
  import { SessionState, setSessionState } from '@/lib/session.svelte'
  import { cn, modKey, prefersReducedMotion } from '@/lib/utils'
  import { onLanguageChange } from '@/lib/i18n.svelte'
  import type { PaletteItem } from '@/components/ui/palette'
  import {
    watchBookBusy,
    watchBookKernel,
    watchBooks,
    watchCellNumbers,
    watchNotebookMeta,
  } from '@/lib/yreactive.svelte'
  import { kernelProblemAdvice } from '@shared/kernel-problem'
  import {
    CELLS_KEY,
    cellLock,
    cellSource,
    findCell,
    getMeta,
    rootOfCell,
    type KernelStatus,
  } from '@shared/notebook'
  import { countLine, shownOutputLines, type CouncilCount } from '@/lib/council.svelte'
  import { pultPath } from '@/lib/council-pult-window'
  import { clock } from '@/lib/history'
  import type { CouncilShown, SessionInfo } from '@shared/protocol'
  import { copyText } from '@/lib/clipboard'
  import {
    beginVisit,
    refusalHasText,
    reloadByHand,
    stillLost,
    takeRefusal,
    type RefusedCell,
  } from '@/lib/refusal'
  import { permitsIn } from '@/lib/may'
  import { accessPatch } from '@/lib/book-access'
  import { controlDisabled, controlTitle } from '@/lib/controls'
  import TabStrip from '@/components/reader/TabStrip.svelte'
  import FileEditor from '@/components/editor/FileEditor.svelte'
  import FileBar from '@/components/editor/FileBar.svelte'
  import { leaderFor, sameLead, type Lead } from '@/lib/follow'
  import { loadPdf } from '@/lib/pdf.svelte'
  import { Tabs } from '@/lib/tabs.svelte'
  import { holdFile, releaseFile, type FileDoc } from '@/lib/filedoc.svelte'
  import { baseOf, kindOf, runnerFor } from '@shared/paths'
  import { api } from '@/lib/api'
  import {
    actsAfterClass,
    CLASS_IS_OVER,
    readRules,
    type BookAccess,
    type OracleLimits,
    type RoomRules,
  } from '@shared/rules'
  import RoomRulesRows from '@/components/RoomRulesRows.svelte'

  interface Props {
    session: SessionInfo
    identity: StoredIdentity
    /**
     * Which of the room's screens is drawn.
     *
     * `room` is the seminar as everyone sees it; `screen` is the projection
     * for the projector (`/s/:id/screen`); `pult` is the lecture console in
     * the teacher's hands (`/s/:id/pult`); `council` is the council console
     * for a single cell in a separate window (`/s/:id/council/:cell`). One
     * prop, not a set of flags: the screens are mutually exclusive, and a pair
     * of booleans could mean things that never happen.
     *
     * They all live in ONE component because they live on one connection:
     * `SessionState` is created once below, and switching screens does not
     * touch it — the sockets, the document and presence stay in place.
     */
    mode?: 'room' | 'screen' | 'pult' | 'council'
    /** The council console's cell; meaningful only with `mode: 'council'`. */
    councilCell?: string | null
    /** Go to another address without rebuilding the room. */
    onnavigate?: (to: string) => void
    /**
     * The place in the room stopped working — return the person to the name
     * form.
     *
     * The room cannot do that itself: the join screen lives higher up, and the
     * saved identity has already been wiped by this moment (see `#diagnose`).
     */
    onexpired?: () => void
  }

  let {
    session: info,
    identity,
    mode = 'room',
    councilCell = null,
    onnavigate,
    onexpired,
  }: Props = $props()

  const projection = $derived(mode === 'screen')
  const pult = $derived(mode === 'pult')
  /**
   * The council console is a separate window, and the room is not drawn under
   * it for the same reason as under the lecture console, only turned a third
   * way: the notebook is mirrored to the projector, while the console holds
   * names, drafts and marks. One window — one viewer.
   */
  const councilPult = $derived(mode === 'council')

  /*
   * The console arrives on demand — for the same reason as the panel in App.
   *
   * ConsoleView with its palettes and speaker notes is several thousand lines
   * that are drawn on one tablet for one person. As a static import they sat
   * in the room chunk, so EVERY student downloaded and parsed them on entry —
   * including the one watching the projection. A dynamic import is the only
   * thing that really defers the bytes: moving a static import into another
   * file just moves them along with it.
   *
   * It is memoised so that the `{#await}` block gets the same promise on every
   * redraw and the console is not rebuilt under the teacher's hand. InkLayer
   * and LectureView stay static: the hall draws them.
   */
  let pultChunk: Promise<typeof import('@/components/lecture/ConsoleView.svelte').default> | null =
    null
  const consoleView = () =>
    (pultChunk ??= import('@/components/lecture/ConsoleView.svelte').then((m) => m.default))
  /**
   * The council console is a second chunk, by the same argument and at the
   * same price: it is drawn in one window for one person, and it would
   * otherwise sit in the room chunk of every student.
   */
  function exitCouncil(): void {
    try {
      if (window.opener && !window.opener.closed) {
        window.opener.focus()
        window.close()
        return
      }
    } catch { /* An opener may no longer be accessible. */ }
    onnavigate?.(`/s/${session.session.id}`)
  }

  let councilChunk: Promise<
    typeof import('@/components/council/pult/PultWindow.svelte').default
  > | null = null
  const councilWindow = () =>
    (councilChunk ??= import('@/components/council/pult/PultWindow.svelte').then((m) => m.default))
  // Start downloading as soon as the console address is on screen, not when we
  // reach the markup: for a tablet that opened a key link this wins a whole
  // round trip.
  $effect(() => {
    if (pult) void consoleView()
    if (councilPult) void councilWindow()
  })

  // Context can only be written during initialisation, so the live session is
  // built here rather than in the router — by now both the room and the person
  // are known, and every panel below reads it with getSessionState().
  // Reading the props once is the point: rebuilding SessionState would drop the
  // local CRDT and every keystroke that has not synced yet. The router remounts
  // this component when the room or the person actually changes.
  // svelte-ignore state_referenced_locally
  const session = new SessionState(info, identity)

  /*
   * The line about a rules change lives six seconds and goes away by itself:
   * it is read once, and closing it with a cross would be asking for work in
   * exchange for an announcement.
   */
  /*
   * An edit was not accepted — and here it is.
   *
   * A browser that got refused rebuilds the document with a reload (see
   * `lib/refusal.ts`), and without this panel that would be a silent erasure
   * of someone's work, no better than a browser silently gone mute.
   */
  // Once on mount, like SessionState above: a note about the visit that just
  // ended in a refusal, and the router recreates this component when the room
  // really changes.
  // svelte-ignore state_referenced_locally
  beginVisit()
  // svelte-ignore state_referenced_locally
  const refusal = takeRefusal(info.id)
  /*
   * The window is about lost text. A cache refusal at entry after which no
   * text went missing is a line at the bottom for a few seconds: the tab has
   * already rebuilt itself, and all the person needs here is to know why it
   * blinked.
   *
   * A snapshot of cells does not prove a loss by itself: it holds the whole
   * notebook, untouched parts included. What really did not get through is
   * visible only after the server has handed over its copy (`lostCells`
   * below) — so a CACHE refusal with a snapshot starts as a line and is
   * raised to a window if the comparison finds anything. Without a snapshot
   * (a note from an older build or one that did not fit in the quota) we
   * judge by what there is — `refusalHasText`.
   */
  const refusedSnapshot = refusal !== null && (refusal.cells?.length ?? 0) > 0
  const refusedWindow =
    refusal !== null && (refusal.kind !== 'stale' || (!refusedSnapshot && refusalHasText(refusal)))
  let refusalShown = $state(refusedWindow)
  let staleNotice = $state(refusal !== null && refusal.kind === 'stale' && !refusedWindow)
  if (staleNotice) setTimeout(() => (staleNotice = false), 9000)
  let refusalCopied = $state(false)

  /**
   * What from the note really did not get through — by comparison with the
   * copy the server handed over.
   *
   * `null` while there is nothing to compare with: before the server sync
   * the document is empty, and emptiness means "not read yet", not "the
   * server did not accept this" — counting here would be too early and would
   * declare the whole notebook lost. Counted once: after that the person is
   * editing the document themselves, and a second comparison would declare
   * their own new line a loss.
   */
  let lostCells = $state<RefusedCell[] | null>(null)
  if (refusal) {
    const settle = (isSynced: boolean): void => {
      if (!isSynced || lostCells !== null) return
      lostCells = stillLost(refusal, (id) => {
        const found = findCell(session.doc, id)
        return found ? cellSource(found.cell).toString() : null
      })
      // Something lost was found — this is no longer "the tab blinked" but
      // "here is what you wrote": the line at the bottom gives way to the
      // window.
      if (lostCells.length > 0 && !refusalShown) {
        refusalShown = true
        staleNotice = false
      }
      session.provider.off('sync', settle)
    }
    session.provider.on('sync', settle)
    onDestroy(() => session.provider.off('sync', settle))
    // The socket may have synced before the screen mounted.
    if (session.provider.synced) settle(true)
  }

  /**
   * What to show in the window.
   *
   * There may be no snapshot at all — a note from an older build or one that
   * did not fit in the tab's quota (see `stashRefusal`); then what remains is
   * the only thing it holds — the cell under the cursor, as before.
   */
  const refusedCells = $derived.by((): RefusedCell[] => {
    if (!refusal) return []
    if (!refusedSnapshot) return refusal.text === '' ? [] : [{ id: '', text: refusal.text }]
    return lostCells ?? []
  })
  /** Snapshot in hand, server silent so far: nothing to say, and nothing to lie with. */
  const refusedChecking = $derived(refusedSnapshot && lostCells === null)

  async function copyRefused(): Promise<void> {
    const list = refusedCells
    if (list.length === 0) return
    // A blank line between cells: a separator that pretends to be neither a
    // Python comment nor a markdown heading — a notebook can be either, and
    // people see the numbers on screen anyway.
    await copyText(list.map((cell) => cell.text).join('\n\n'))
    refusalCopied = true
    setTimeout(() => (refusalCopied = false), 1600)
  }

  /* ------------------------------------------------------- room rules panel */

  let rulesOpen = $state(false)
  let rulesBusy = $state(false)
  const roomRules = $derived(readRules(session.session.rules))

  /**
   * The Oracle caps in force on the instance.
   *
   * Two rows of the panel set THEIR OWN caps under the instance ones, and
   * without a number next to it "as on the instance" tells the person
   * nothing: they do not know whether they are tightening now or writing the
   * same thing. Asked once and only when the panel is opened: the teacher
   * needs the line for ten seconds, and the room lives on without it as
   * before.
   */
  let oracleLimits = $state<OracleLimits | null>(null)
  $effect(() => {
    if (!rulesOpen || !isHost || oracleLimits) return
    let alive = true
    api
      .aiStatus()
      .then((status) => {
        if (alive) {
          oracleLimits = {
            questionsPerHour: status.questionsPerHour,
            slowModeSeconds: status.slowModeSeconds,
            agentSteps: status.agentSteps,
          }
        }
      })
      // Silently: the panel can be set up without the hint, and a red line over
      // the rules would point at something other than what broke.
      .catch(() => {})
    return () => {
      alive = false
    }
  })

  /**
   * One switch — one request.
   *
   * What is sent is laid over the current rules on the server, not replacing
   * them: a screen touching one row must not be able to silently reset the
   * other seven to defaults. The answer comes both here and to the whole room
   * — broadcast over the control socket, so one's own change flies back by the
   * same path as anyone else's.
   *
   * The refusal reason is named by `ruleRefusal` (lib/rule-refusal.ts), not by
   * `err.message`: an `ApiError`'s phrase is English on both sides — both the
   * fallback ("Could not reach the server…") and the route body ("join the
   * session first") — while the room is entirely Russian. There is
   * deliberately no copy of the rule here: the words live in one piece next
   * to `api.ts`, which produces them.
   */
  async function setRule(patch: Partial<RoomRules>) {
    rulesBusy = true
    try {
      const body = await api.setRoomRules(session.session.id, identity.token, patch)
      session.session = { ...session.session, rules: body.rules }
    } catch (err) {
      session.showError(ruleRefusal(err))
    } finally {
      rulesBusy = false
    }
  }

  const RULES_NOTICE_MS = 6000
  let rulesNoticeUp = $state(false)
  $effect(() => {
    if (session.rulesChangedAt === 0) return
    rulesNoticeUp = true
    const timer = window.setTimeout(() => (rulesNoticeUp = false), RULES_NOTICE_MS)
    return () => window.clearTimeout(timer)
  })

  /* -------------------------------------------------------- end of class */

  /**
   * Finish the class — and open it back up.
   *
   * Through the control socket, not a request: the room learns the rules from
   * a broadcast over it, and the end of class must arrive by the same road and
   * in the same order. One's own press comes back here as a `class` frame,
   * like anyone else's — so nothing is written here ahead of the server.
   */
  function setClassOver(over: boolean): void {
    session.send({ t: over ? 'class:finish' : 'class:resume' })
  }

  /**
   * When the class was finished — in digits a person remembers.
   *
   * The hour while it is today, and the day when it is not: the room is
   * opened a week later too, and "finished at 15:40" in such a tab lies about
   * the day. The full date stays in the tooltip.
   */
  const finishedStamp = $derived.by(() => {
    const at = session.session.finishedAt
    if (at === null) return ''
    const when = new Date(at)
    const pad = (value: number) => String(value).padStart(2, '0')
    return when.toDateString() === new Date().toDateString()
      ? `${pad(when.getHours())}:${pad(when.getMinutes())}`
      : `${pad(when.getDate())}.${pad(when.getMonth() + 1)}`
  })
  const finishedLong = $derived.by(() => {
    const at = session.session.finishedAt
    if (at === null) return ''
    return tr('room.ui.957', { p0: new Date(at).toLocaleString(getLocale(), { day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit', }) })
  })

  /*
   * The transition — as one line, and it leaves by itself.
   *
   * Modelled on the rules line, and driven by a stamp rather than a comparison
   * with a local variable: twenty people's buttons go dark at once, and
   * without a single phrase that reads as a broken laptop, not as the end of
   * the class.
   *
   * The stamp is set by the frame parser (`session.classChangedAt`) and stays
   * silent on the connection's first frame — so the line does not pop up for
   * someone entering a room finished long ago: the chip in the status bar
   * says so. A comparison of its own cannot hold here: two flag changes in a
   * row killed the timer in the effect cleanup and did not start a new one,
   * and the line stayed hanging until the end of the class.
   */
  const CLASS_NOTICE_MS = 6000
  let classNoticeUp = $state(false)
  $effect(() => {
    if (session.classChangedAt === 0) return
    classNoticeUp = true
    const timer = window.setTimeout(() => (classNoticeUp = false), CLASS_NOTICE_MS)
    return () => window.clearTimeout(timer)
  })
  setSessionState(session)
  onDestroy(() => session.destroy())

  /*
   * The room no longer recognises this browser's key — we give way to the
   * name form. In one line and without questions: the sockets will never come
   * up from here again, and "Reconnecting" in front of a person who has
   * nothing to wait for is an eternal spinner.
   */
  $effect(() => {
    if (session.expired) onexpired?.()
  })

  const meta = watchNotebookMeta(session.doc)
  const storedTitle = $derived(meta.current.title)
  const title = $derived(storedTitle || info.name)
  const isHost = $derived(session.me.role === 'host')

  /**
   * Where the mark in the header leads — and whether it leads anywhere.
   *
   * `/` is the teacher's panel, and only the teacher needs to go there. For a
   * participant, the way up is the course page, if there is one: it is the
   * only public address where their seminar stands among others. Neither —
   * the mark is not a link.
   */
  const homeHref = $derived(
    isHost ? '/' : session.session.course ? `/c/${session.session.course.id}` : null,
  )

  $effect(() => {
    document.title = `${title} · Colloq`
    return () => {
      document.title = 'Colloq'
    }
  })

  /* ------------------------------------------------------------- masthead */

  // DD.MM beside the seminar name, as the artboard sets it: in a room you are
  // standing in the year is noise. The full date stays in the tooltip.
  // Read once, like the session above: the router remounts this component when
  // the room changes, so a room's start date cannot change under it.
  // svelte-ignore state_referenced_locally
  const started = new Date(info.createdAt)
  const dateShort = `${String(started.getDate()).padStart(2, '0')}.${String(
    started.getMonth() + 1,
  ).padStart(2, '0')}`
  const dateLong = $derived(started.toLocaleDateString(getLocale(), {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  }))

  /*
   * People, not sockets. Keyed on the client id this counted a second tab as a
   * second student, so the bar could say "4 in the room" above a list of three
   * — with one of them printed twice. The participant id is also the steadier
   * face: it survives a reconnect, where the client id does not.
   */
  /*
   * A mark per seminar, in the tab bar.
   *
   * The grid is derived from the session id, so it is the same for everybody in
   * the room and the same next week; a teacher with back-to-back seminars open
   * can tell the tabs apart at 16px, which is the whole reason a logo is
   * allowed to change at all. Restored on the way out so the join screen and
   * the panel keep the brand's own mark.
   */
  $effect(() => {
    const link = document.querySelector<HTMLLinkElement>('link[rel="icon"]')
    if (!link) return
    const brand = link.getAttribute('href')
    link.setAttribute('href', gridFaviconHref(session.session.id))
    return () => {
      if (brand) link.setAttribute('href', brand)
    }
  })

  const inRoom = $derived(peopleInRoom(session.peers))
  /*
   * The faces in the bar — the same array while there is nothing new to draw.
   *
   * `yCollab` announces the cursor position through presence on every
   * selection move: a hundred people typing make hundreds of frames a second,
   * and each of them rebuilt here the array of everyone in the room, joined
   * their names into `title` and woke the avatar stack. Nothing drawn here
   * changes with a cursor: name, mark, colour and "(you)".
   *
   * The comparison makes not a single allocation (screens/roster.ts), and on
   * a match THE SAME array is returned: Svelte compares a derived result by
   * reference, so everything downstream simply does not wake up. A presence
   * frame still costs one pass over the list — only coalescing in
   * `#readPeers` itself can remove that (see the handoff).
   */
  let faces: Face[] = []
  const room = $derived.by(() => {
    const people = inRoom
    return untrack(() => {
      if (!sameFaces(faces, people)) faces = people.map(faceOf)
      return faces
    })
  })
  /** The stack's tooltip: computed from `room`, i.e. only when the people change. */
  const roomNames = $derived(namesLine(room))

  /*
   * The live state of the machine, in the words the states sheet uses.
   *
   * The dot is the only coloured thing here: on the brand ground the label has
   * to stay white in both themes, because `danger` and `warning` are tuned for
   * the canvas and neither clears AA against navy. So the colour signals and
   * the word informs — which is also why a dead kernel gets a plate rather than
   * red type.
   */
  const KERNEL: Record<KernelStatus, { label: string; dot: string; alarm: boolean; why?: string }> = {
    /*
     * "NOT RUNNING" is neither an alarm nor a promise.
     *
     * The kernel starts lazily: a room that was just opened has none, and
     * nobody is starting one. Until 20 Sep 2026 this state was shown as
     * "STARTING" — the chip promised for hours something that was not
     * happening. The dot is dimmer than the others, there is no border, and
     * `title` says what to do: run a cell or hover over a name for help —
     * both gestures start the kernel.
     */
    off: {
      get label() { return tr('room.kernel.state.off') },
      dot: 'bg-white/25',
      alarm: false,
      get why() { return tr('room.kernel.state.offWhy') },
    },
    starting: { get label() { return tr('room.kernel.state.starting') }, dot: 'bg-white/35', alarm: false },
    restarting: { get label() { return tr('room.kernel.state.restarting') }, dot: 'bg-white/35', alarm: false },
    idle: { get label() { return tr('room.kernel.state.idle') }, dot: 'bg-white/50', alarm: false },
    busy: { get label() { return tr('room.kernel.state.busy') }, dot: 'bg-accent', alarm: false },
    dead: { get label() { return tr('room.kernel.state.dead') }, dot: 'bg-danger', alarm: true },
  }


  /* ------------------------------------------------------------- layout */

  const PANELS_KEY = 'colloq.panels.v1'

  /*
   * The header lives in the same box as the panels, and that is on purpose.
   *
   * A folded header is the same room-layout setting as a closed files panel:
   * it is chosen once on one's own machine and expected to survive F5. A
   * separate key would mean a second record of the same thing and a second
   * place where someone forgets to clean it up. The field is optional: for
   * someone who closed panels before this change there is no `head` in the
   * box at all, and they get the header unfolded — that is, exactly what it
   * was.
   */
  function loadPanels(): { left: boolean; right: boolean; head: boolean } {
    try {
      const raw = localStorage.getItem(PANELS_KEY)
      if (raw) {
        const saved = JSON.parse(raw) as { left?: boolean; right?: boolean; head?: boolean }
        return { left: saved.left !== false, right: saved.right !== false, head: saved.head !== false }
      }
    } catch {
      /* private browsing; the default layout is fine */
    }
    return { left: true, right: true, head: true }
  }

  const panels = loadPanels()
  let leftOpen = $state(panels.left)
  let rightOpen = $state(panels.right)
  let headOpen = $state(panels.head)
  let leftDrawer = $state(false)
  let rightDrawer = $state(false)

  // Narrow windows keep the notebook full width and show panels over it, so a
  // student on half a laptop screen still has somewhere to type.
  const AI_COLUMN = '(min-width: 1100px)'
  const SIDEBAR_COLUMN = '(min-width: 820px)'

  // Measured before the first paint so a narrow window never flashes columns.
  let wideEnough = $state(window.matchMedia(AI_COLUMN).matches)
  let roomyEnough = $state(window.matchMedia(SIDEBAR_COLUMN).matches)

  $effect(() => {
    const forAi = window.matchMedia(AI_COLUMN)
    const forSidebar = window.matchMedia(SIDEBAR_COLUMN)
    const sync = () => {
      wideEnough = forAi.matches
      roomyEnough = forSidebar.matches
    }
    sync()
    forAi.addEventListener('change', sync)
    forSidebar.addEventListener('change', sync)
    return () => {
      forAi.removeEventListener('change', sync)
      forSidebar.removeEventListener('change', sync)
    }
  })

  const leftIsDrawer = $derived(!roomyEnough)
  const rightIsDrawer = $derived(!wideEnough)

  /* -------------------------------------------------------------- reader */

  const may = $derived(permitsIn(session.session.rules, session.me.role, session.finished))

  /**
   * What is open in the middle — the notebook and the files that were opened.
   *
   * The list of one's own tabs lives here, not in each component: a tab
   * survives a trip to the notebook and back, while the place in the document
   * and the cursor in the editor are lost on unmount. The room's shared
   * document comes in from the side — from the server — and takes its place
   * in the same row.
   */
  // svelte-ignore state_referenced_locally
  const tabs = new Tabs(info.id)
  const row = $derived(tabs.row(session.board, session.lecture?.file ?? null))
  /*
   * The tabs pinned by the room — the same ones `row` is made of.
   *
   * The tab row uses them to decide what can be moved: the order of the pinned
   * ones is set by the room, and rearranging them for oneself would give one
   * person their own order of the shared screen.
   */
  const roomPinned = $derived(
    [session.board, session.lecture?.file ?? null].filter((path): path is string => !!path),
  )
  const activePath = $derived(typeof tabs.active === 'string' ? tabs.active : null)
  const activeKind = $derived(activePath ? kindOf(activePath) : null)

  /*
   * Time for the splash from index.html to go — except in two cases.
   *
   * The room is drawn from what the browser knows without the network: the
   * header, the rails, the tabs. What is worth waiting for under the splash
   * is the notebook — it is empty until the socket's first frame, and the
   * notebook reports on itself (Notebook.svelte · cold) — and the council
   * console, see below. The projection and an open file wait for nothing of
   * the kind, and holding the splash over them would be a lie (lib/boot.ts).
   */
  /**
   * The council console is the second one here with something to wait for.
   *
   * It is drawn from the stack, which arrives over the socket, and until the
   * first frame it does not know whether a council is running on this cell
   * at all. Reporting readiness earlier would mean removing the app splash
   * and showing "the cell is not in the council" for a second — exactly what
   * the owner saw on every reload. So for the console "ready" means "the
   * stack is known, or it is known there is none"; the index.html splash just
   * stays longer, and there is no intermediate frame between it and the
   * console. It never lives longer than SCREEN_WAIT in any case
   * (lib/boot.ts).
   */
  const councilKnown = $derived(
    !councilPult ||
      councilCell === null ||
      session.council.welcomed ||
      (session.council.boards[councilCell] ?? null) !== null,
  )
  $effect(() => {
    if (mode === 'room' && activeKind === 'notebook') return
    if (councilPult && !councilKnown) return
    firstScreenReady()
  })

  /** The room's notebooks: the list lives in the document and reaches everyone. */
  const books = watchBooks(session.doc)

  /**
   * Notebooks together with their access — what the tab row draws its label
   * from and fills the "Access" menu with.
   *
   * The notebook list lives in the DOCUMENT (it is shared and survives a
   * reload), while access lives in the room's RULES (it is a permission, and
   * permissions are not carried in a CRDT, where anyone could rewrite them).
   * They are put together here, by root: a file path gets renamed, a root
   * does not.
   */
  const bookBusy = watchBookBusy(session.doc)
  const bookTabs = $derived(
    books.current.map((book) => ({
      path: book.path,
      root: book.root,
      rule: roomRules.books?.[book.root] ?? null,
      // Each notebook has its own kernel: the dot on the tab says the
      // neighbouring sheet is computing right now — otherwise one would have
      // to switch there to find out whether it is still running.
      busy: bookBusy.busy(book.root),
    })),
  )

  /**
   * The notebook whose kernel the header indicator talks about — the OPEN one.
   *
   * Each notebook has its own kernel (server/src/kernel/index.ts), and "IDLE"
   * over the seminar while the lecture is computing is the truth about the
   * seminar, not an oversight. When what is open is not a notebook (the
   * board, a .py, the lecture), the header talks about the room's notebook:
   * the indicator is about the class, not the tab, and it must not go silent.
   *
   * It stands AFTER the notebook and tab lists on purpose: it reads them.
   */
  const openRoot = $derived(
    (activeKind === 'notebook' && activePath
      ? books.current.find((entry) => entry.path === activePath)?.root
      : books.current[0]?.root) ?? CELLS_KEY,
  )
  const openKernel = watchBookKernel(session.doc, () => openRoot)
  const kernel = $derived(KERNEL[openKernel.current.kernelStatus])

  /*
   * Why the room's Python did not come up — advice for the presenter, and for
   * them alone.
   *
   * A room's pod on k3s does not start when the node has nothing to give: each
   * room's memory is reserved in full. A student sees a short "no room on the
   * server, the teacher sees the reason" in the cell and the kernel log, and
   * only whoever changes room memory can fix it — they are told here exactly
   * what to reduce. It stays up while the kernel is dead for this reason; once
   * closed with the cross it comes back only with new advice (a different
   * number, a different resource).
   */
  const kernelAdvice = $derived(
    isHost && openKernel.current.kernelStatus === 'dead' && openKernel.current.kernelProblem
      ? kernelProblemAdvice(openKernel.current.kernelProblem)
      : null,
  )
  let adviceDismissed = $state<string | null>(null)
  const adviceUp = $derived(kernelAdvice !== null && kernelAdvice !== adviceDismissed)

  /**
   * Change the access to one notebook.
   *
   * By the same path all other room rules change (`setRule` above, that is,
   * PATCH /api/sessions/:id/rules): notebook access LIVES in the rules, and it
   * has no second door — which means no second place where someone forgets to
   * check the role. The server checks it itself anyway.
   */
  function setBookAccess(root: string, access: BookAccess): void {
    void setRule(accessPatch(roomRules, root, access))
  }

  /** What the reader reports outwards: the tab row shows it for the reader. */
  let readerPage = $state(1)
  let readerPages = $state(0)
  /**
   * Whether we are following the presenter right now — in the reader's own
   * opinion.
   *
   * A page number alone is not enough for the tab row: one can fall behind
   * without changing the page, just by scrolling within a sheet. While this
   * flag did not reach here, the row said "Following Anna" to someone who had
   * already fallen behind by choice — while the reader one line below
   * honestly said "look for yourself".
   */
  let readerFollowing = $state(true)
  let lead = $state<Lead | null>(null)
  /** The presenter was here and vanished — not the same as "no presenter". */
  let orphaned = $state(false)
  /** Whom we followed so far: while they stay, the presenter is not switched. */
  let sticky = $state<number | null>(null)

  /**
   * The document that has anyone to follow at all.
   *
   * The one open now — or, if the person went to the notebook, the room's
   * shared document: the "teacher on p. 4" label on the tab must stay alive
   * from the notebook too, otherwise you learn the lecture has moved on only
   * by switching.
   */
  const followFile = $derived(
    activeKind === 'pdf'
      ? activePath
      : session.board && kindOf(session.board) === 'pdf'
        ? session.board
        : null,
  )

  /*
   * The presenter is recomputed on every presence change — but written only
   * if it really changed: `leaderFor` builds a new object every time, and the
   * effect writes the same state it reads.
   */
  $effect(() => {
    const peers = session.peers
    const file = followFile
    if (!file) {
      // Nothing to look at — and "the teacher left" here would report an
      // event that never happened.
      if (untrack(() => lead) !== null) lead = null
      if (untrack(() => sticky) !== null) sticky = null
      if (untrack(() => orphaned)) orphaned = false
      return
    }
    const next = leaderFor(
      peers,
      file,
      untrack(() => sticky),
    )
    if (sameLead(untrack(() => lead), next)) return
    lead = next
    if (next) sticky = next.clientId
    // "Was there and vanished" — not "is not there".
    orphaned = next === null && untrack(() => sticky) !== null
  })
  /** "Catch up" presses — as a counter: one can catch up twice in a row. */
  let catchUp = $state(0)

  /* ------------------------------------------------------------ lecture */

  /**
   * Whether a lecture is running on what is open now.
   *
   * A lecture always stands on the shared screen too — it is one and the same
   * decision made by the server (see `lecture:start`) — so everyone has a tab
   * for it, and nobody needs to open it specially.
   */
  const lecture = $derived(session.lecture)
  const leading = $derived(lecture !== null && lecture.by === session.me.id)
  const lectureHere = $derived(lecture !== null && lecture.file === activePath)

  /**
   * "Read on my own".
   *
   * A lecture shows everyone one page — the one the presenter is on. But a
   * room where a student cannot page back and reread a formula is a screen
   * broadcast, not a seminar, and the whole product is built the other way
   * around: people FOLLOW the teacher, they are not tied to them. So stepping
   * out into the ordinary reader takes one press — and so does coming back.
   *
   * Reset when the lecture changes: the next one starts shared by everyone.
   */
  let soloRead = $state(false)
  $effect(() => {
    void lecture?.file
    untrack(() => (soloRead = false))
  })

  /**
   * Go to the projection and back.
   *
   * By address, not by flag: the projection is opened on the machine at the
   * projector, its link is bookmarked, and it must survive a reload.
   * Fullscreen is requested right here, from a live press — from an effect
   * after navigation the browser does not grant it.
   */
  /**
   * To the projector — as a SEPARATE window, not in this same tab.
   *
   * The projection used to go into the same tab, and the room on this
   * computer came to an end: to show a cell, the teacher had to leave the
   * projector. A window is what gets put on the second monitor and shared in
   * Zoom as "a screen" while work goes on in the first window. The window
   * name is there so that a second press finds the one already open instead
   * of breeding projections. Fullscreen in the new window is requested by
   * that window itself on the first press in it: a gesture from this window
   * does not carry over, and without a gesture the browser does not grant
   * fullscreen.
   *
   * Pop-ups may be blocked — then, as before, we leave ourselves.
   */
  function toProjection(): void {
    const url = `/s/${session.session.id}/screen`
    const opened = window.open(url, `colloq-screen-${session.session.id}`, 'popup=yes,width=1280,height=720')
    if (opened) {
      opened.focus()
      return
    }
    void goFullscreen(document.documentElement)
    onnavigate?.(url)
  }

  function fromProjection(): void {
    void leaveFullscreen()
    // A window opened from the room closes; a tab that arrived by the address
    // goes back to the room.
    if (window.opener) window.close()
    if (!window.closed) onnavigate?.(`/s/${session.session.id}`)
  }

  /*
   * Escape leaves the projection. On the first press the browser closes
   * fullscreen itself and does not pass the event to the page — so on the
   * projector Escape is pressed twice, and that is exactly what is needed: a
   * stray press does not kill the lecture.
   */
  $effect(() => {
    if (!projection) return
    const onEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') fromProjection()
    }
    window.addEventListener('keydown', onEscape)
    return () => window.removeEventListener('keydown', onEscape)
  })

  /* -------------------------------------------------------------- console */

  /**
   * The screen does not go dark while the console or the projection is up.
   *
   * iPad auto-lock defaults to two minutes, and a teacher talks longer; a
   * laptop at the projector has the same trouble under another name — the
   * screensaver. Both screens exist precisely to be looked at without
   * pressing anything — that is, precisely for the case the system counts as
   * inactivity.
   *
   * Held by mode, not by press: this API needs no gesture, and taking the lock
   * on entry and forgetting to release it would mean keeping the screen on in
   * a room where it is not needed. Released by the effect's return, that is,
   * on leaving the screen and on unmount.
   *
   * A refusal is silent here: only the console has someone to tell — it has
   * its own line in the top strip for that, and the console requests the
   * lock itself (two locks on one document are independent, the screen stays
   * on while at least one is held). The projection has twenty readers, and a
   * "the screen may go dark" warning for the whole hall is noise that nobody
   * in the hall will fix anyway.
   */
  $effect(() => {
    if (mode === 'room') return
    return keepAwake(() => {})
  })

  /**
   * Leave the console.
   *
   * This does NOT stop the lecture and must not: the console is the hands,
   * not the lecture itself, and someone who glanced at the notebook to show a
   * cell has not finished the class. But a vanished console has to be
   * explained — otherwise whoever missed a button will go looking for where
   * the lecture went instead of coming back with one press.
   */
  const PULT_NOTICE_MS = 6000
  let pultNoticeUp = $state(false)

  function leavePult(): void {
    if (lecture !== null && leading) pultNoticeUp = true
    onnavigate?.(`/s/${session.session.id}`)
  }

  function toPult(): void {
    pultNoticeUp = false
    onnavigate?.(`/s/${session.session.id}/pult`)
  }

  $effect(() => {
    if (!pultNoticeUp) return
    const timer = window.setTimeout(() => (pultNoticeUp = false), PULT_NOTICE_MS)
    return () => window.clearTimeout(timer)
  })

  /*
   * A swipe from the left edge is "back" in Safari's history, and nothing can
   * turn it off on an iPad. For the console the left edge is the hand holding
   * the tablet: paging the lecture back by one wrong millimetre and ending up
   * in the room with tabs and the Oracle is a matter of time.
   *
   * So on `popstate` we return to the console — but only in one case: THIS
   * person is running the lecture from THIS device, and we left for our own
   * room. Beyond the room we do not hold anyone at all. A trap you cannot
   * leave with "back" costs more than an accidental exit, and a real exit
   * exists and is visible — "Go to room" under "More".
   *
   * App's listener fires before ours and has already set the new path;
   * `onnavigate` puts the console entry on top of it, so the next "back" also
   * leads here.
   */
  $effect(() => {
    if (!pult || lecture === null || !leading) return
    const room = `/s/${session.session.id}`
    const back = () => {
      if (location.pathname === room || location.pathname === `${room}/`) {
        onnavigate?.(`${room}/pult`)
      }
    }
    window.addEventListener('popstate', back)
    return () => window.removeEventListener('popstate', back)
  })

  /*
   * A document appeared on the shared screen — the room is watching it: that
   * is what "the lecture started" means. It disappeared — everyone goes back
   * to the notebook, because there is nothing left to watch. A comparison
   * with the previous value, not a plain read: otherwise switching by tab
   * would be undone right away by this same effect.
   */
  let lastBoard: string | null = null
  $effect(() => {
    const now = session.board
    if (now === lastBoard) return
    const was = lastBoard
    lastBoard = now
    if (now) tabs.show(now)
    else if (untrack(() => tabs.active) === was) tabs.show(null)
  })

  /*
   * The place in a document lives as long as the document is open at all —
   * not as long as someone is looking at it.
   *
   * The difference shows in exactly one case, and it is the most common one:
   * the teacher went to the notebook to show a cell. They did not "leave" the
   * lecture, and the room should still see "Ada on p. 4" on the tab —
   * otherwise you learn the lecture has moved on only by switching. The
   * reader cannot do this: it unmounts together with the tab switch.
   */
  $effect(() => {
    if (!followFile) session.setViewing(null)
  })

  /*
   * While a lecture is running, "who is where" in this document is not
   * computed at all.
   *
   * A place in a document is needed so that one can FOLLOW a person; during a
   * lecture there is nowhere to go — the page is one for everyone and comes
   * from the presenter. A "teacher on p. 4" label next to the lecture would
   * be a second source of the same truth, and it would lie: the presenter has
   * no reader, and the last thing they managed to report is the page they
   * were on before the lecture started. The counter in the tab row goes out
   * too: during a lecture the number lives in its strip.
   */
  $effect(() => {
    if (!lectureHere || soloRead) return
    session.setViewing(null)
    readerPage = 1
    readerPages = 0
  })

  /*
   * How to show a cell, wherever it lies.
   *
   * Set once: links to cells come from the people panel and from the Oracle
   * thread, and neither knows about tabs or notebooks.
   */
  session.showCell = (cellId: string) => {
    const root = rootOfCell(session.doc, cellId)
    if (!root) return
    const book = books.current.find((entry) => entry.root === root)
    /*
     * Open, not show: a room has several notebooks, and the one holding the
     * cell may not be open for this person at all — the teacher added it, and
     * they themselves never touched it. `show` in this case made active a tab
     * that is not in the row: the centre of the screen went empty, no tab was
     * highlighted, and "show where they are" turned out to be a button that
     * lies.
     */
    if (book) tabs.open(book.path)
  }

  /*
   * The selection outlived its own cells.
   *
   * A cell can be deleted — one's own or someone else's — and the selection
   * still kept pointing at it: the Oracle chip went out, and Shift+Enter sent
   * a run of a dead cell. Checked across all the room's notebooks at once,
   * because there is one selection per person, and several notebooks.
   */
  const everyCell = watchCellNumbers(session.doc)

  /**
   * The councils running now — for the projector: while the class is writing,
   * the count "N of M submitted"; as soon as the teacher puts someone's
   * variant on screen — that variant, with a caption.
   *
   * Other people's attempts are still not here: only the teacher sees the
   * stack. EXACTLY ONE goes onto the strip — the one the teacher decided to
   * show the hall (the `council:shown` frame, which also reaches the whole
   * room as a plate under the cell). Before, what was shown went into the
   * cell's shared text and ended up anonymous on screen: the hall read the
   * solution without knowing whose it was; the strip under it counted
   * submissions as if nothing had been shown.
   *
   * The name in the caption is decided by the `namesOnProjector` knob — and
   * decided on the SERVER: when it is off the frame carries no name at all,
   * and the caption says "Variant N" (shared/protocol.ts · CouncilShown).
   * Here it is simply drawn.
   *
   * The lock is read from the document on every recompute, and recomputes
   * are ordered by the counters (the socket) and the cell numbering (the
   * document): a council that was closed leaves the strip with the next
   * counter frame. The projector does not set up an observer of its own for
   * each cell — that is above both its rank and its budget.
   */
  const councilsOnAir = $derived.by(() => {
    const out: {
      cellId: string
      ordinal: string
      count: CouncilCount
      shown: CouncilShown | null
    }[] = []
    const numbers = everyCell.current
    for (const [cellId, count] of Object.entries(session.council.counts)) {
      const found = findCell(session.doc, cellId)
      if (!found || cellLock(found.cell) !== 'council') continue
      const number = numbers.get(cellId)
      out.push({
        cellId,
        ordinal: number === undefined ? '' : String(number).padStart(2, '0'),
        count,
        shown: session.council.shown[cellId] ?? null,
      })
    }
    return out
  })
  $effect(() => {
    const alive = everyCell.current
    untrack(() => {
      const kept = session.selection.filter((id) => alive.has(id))
      if (kept.length !== session.selection.length) {
        session.selection = kept
        if (session.selectedCellId && !alive.has(session.selectedCellId)) {
          session.selectCell(kept.at(-1) ?? null)
        }
      }
    })
  })

  /*
   * The file this person is editing — to the room. The files panel draws the
   * "who is here" dots from it, and the strip above the editor draws names.
   */
  $effect(() => {
    // The notebook too: "who is here" in the tree answers one question — is
    // someone else editing this file right now — and for a notebook it is the
    // same question.
    session.setEditing(activeKind === 'text' || activeKind === 'notebook' ? activePath : null)
  })

  /*
   * The room answered — the tabs take their places.
   *
   * The first run returns the person to where they were before the reload
   * (or opens the notebook for someone here for the first time), after that
   * it is weeding: a tab for a file that no longer exists is an empty area
   * without explanation, and the file may have been removed by the teacher or
   * by an `os.remove` in a cell. `Tabs.settle` decides everything; here we
   * only gather what it decides from.
   */
  $effect(() => {
    /*
     * And only when the list has really arrived.
     *
     * "Not asked yet" and "no files" are different things, but on the first
     * frame they looked the same: `files` is empty until the server answers,
     * the document has not been replayed from disk yet, and the very first run
     * of this effect threw away all remembered tabs and wrote an empty list to
     * storage. The promise "your own tabs survive a reload" was not kept even
     * once: every F5 of every participant left an empty centre.
     */
    if (!session.filesArrived || !session.hydrated) return
    const alive = new Set(session.files.filter((file) => !file.dir).map((file) => file.path))
    /*
     * Notebooks — by the room's list, not by the file list.
     *
     * A notebook's file is written by the projection a second after an edit,
     * while the notebook itself exists in the room at once. Until the file list
     * caught up, the tab for it would be closed for everyone — and first of all
     * for someone who just joined: their notebook opens before its file
     * appears on disk.
     */
    for (const book of books.current) alive.add(book.path)
    // The shared screen is read right here: it arrives over the same socket as
    // the file list, and which of them comes first is anyone's guess. If it
    // comes later, the board effect below picks it up; if it came earlier, the
    // room is watching it, and going back to one's own notebook does not take
    // the screen away from it.
    const board = session.board
    const firstBook = books.current[0]?.path ?? null
    /*
     * And the truncation flag — together with the list.
     *
     * "The file is not in the list" and "the file did not fit in the list"
     * look the same from here but mean opposite things: the folder walk hits
     * the cap (server/src/workspace.ts · MAX_ENTRIES), and a student who
     * unpacked a three-thousand-file dataset would close tabs for the whole
     * room. Weeding happens only against the full list — `Tabs` decides that,
     * here we only pass along what it decides from.
     */
    const truncated = session.filesTruncated
    untrack(() => tabs.settle({ alive, firstBook, board, truncated }))
  })

  /*
   * Warming up on demand, not on every entry into a room: the library and the
   * worker are a megabyte and a half, and whoever really has something to
   * open should be the one paying for them.
   */
  $effect(() => {
    if (session.files.some((file) => !file.dir && kindOf(file.path) === 'pdf')) {
      void loadPdf()
    }
  })

  /* ----------------------------------------------------- file documents */

  /**
   * The documents of open text files.
   *
   * Held for ALL open tabs, not only the current one: a connection comes up
   * in a hundred milliseconds, but the undo history is rebuilt along with it,
   * and switching back and forth between two files would wipe Ctrl+Z in
   * both. Five open files — five sockets; a seminar where nobody opened any
   * holds exactly the two it always held.
   */
  let docs = $state<Record<string, FileDoc>>({})

  $effect(() => {
    const want = new Set(
      row.filter(
        (key): key is string => typeof key === 'string' && kindOf(key) === 'text',
      ),
    )
    untrack(() => {
      for (const path of want) {
        if (!docs[path]) docs[path] = holdFile(session.session.id, path, session.token)
      }
      for (const path of Object.keys(docs)) {
        if (want.has(path)) continue
        releaseFile(session.session.id, path)
        delete docs[path]
      }
    })
  })

  onDestroy(() => {
    for (const path of Object.keys(docs)) releaseFile(session.session.id, path)
    docs = {}
  })

  const activeDoc = $derived(activePath && activeKind === 'text' ? docs[activePath] : undefined)

  /*
   * A file the server closed with 4404 vanished from disk between the list
   * and the opening — a narrow race and a perfectly ordinary one: the teacher
   * removed the file in the very second a student clicked on it.
   */
  $effect(() => {
    const doc = activeDoc
    if (doc?.missing && activePath) {
      // With the same pinned tabs as are drawn: the left neighbour is counted
      // by the row, and a row without the lecture would shift the person to
      // the wrong place.
      tabs.close(activePath, session.board, session.lecture?.file ?? null)
    }
  })

  /**
   * Close a tab.
   *
   * Anyone closes their own; a document standing on the shared screen is
   * removed by whoever is allowed to — and removed for everyone at once. If
   * there is no permission and the document is shared, one can still move
   * away from it to the notebook: nobody is forced to watch, and the tab
   * stays where it is.
   *
   * While a lecture is running, the cross removes the document for nobody:
   * a lecture is ended with an explicit "End", and the server rejects
   * `board:close` in words at that time anyway. The cross on its tab means
   * "leave here", and forty minutes of annotation on the projector must not
   * depend on a click that missed the neighbouring tab.
   */
  function closeTab(path: string): void {
    if (path === session.board && may.board && lecture === null) {
      session.send({ t: 'board:close' })
      tabs.show(null)
      return
    }
    tabs.close(path, session.board, session.lecture?.file ?? null)
  }

  /**
   * Put a document on the room's shared screen.
   *
   * A separate action, not a side effect of opening a file: the `board`
   * permission is about the shared screen, not about reading ("anyone can
   * always look and page through on their own", see `rule-rows.ts` and the
   * handler on the server).
   *
   * The strip with the button stays until the shared document arrives rather
   * than going out on the press: the answer takes a round trip, and the
   * server can refuse too ("no such file in the room"). A button that
   * vanished before the answer would leave the person without a second try.
   *
   * Only a tab already drawn in the row becomes active. A file one does not
   * have yet arrives as a tab together with the answer — in the same frame as
   * for everyone; making it active earlier would mean showing an empty centre
   * for a network round trip, and forever on a refusal.
   */
  function showToRoom(path: string): void {
    session.send({ t: 'board:open', name: path })
    if (row.includes(path)) tabs.show(path)
  }

  /**
   * Open a file from the panel.
   *
   * For the teacher a PDF goes to the room's shared screen — it is a lecture,
   * people watch it together. Everything else opens for oneself: a script has
   * no "shared screen", it is edited and run, and who is nearby shows as dots
   * in the tree.
   *
   * For the teacher — and only for them. In a room where the `board` rule is
   * given to everyone (a seminar where students take turns showing their
   * work), any student's click on the handout took the screen away from
   * thirty people: the tab jumped for everyone, and reading anything on one's
   * own was impossible — so the permission did not add an ability but took
   * one away. A student opens for themselves, and can show it to the room
   * with the button above the reader.
   *
   * And not during a lecture: while it runs, the shared screen is taken by
   * it, the server rejects a document change in words ("A lecture on '…' is
   * running — finish it first"), and a click on a file in the panel would
   * turn into a refusal out of nowhere. Opening for oneself is always
   * possible — with this same click.
   */
  function openFile(path: string): void {
    if (kindOf(path) === 'pdf' && may.board && isHost && lecture === null) {
      showToRoom(path)
      return
    }
    /*
     * An .ipynb that is not yet a notebook has to be brought into the room
     * first: the cells move from the file into the document, and the server
     * does that once, not twenty browsers racing each other. The tab opens at
     * once and says "opening" until the notebook arrives — more honest than
     * not reacting to the press.
     */
    if (kindOf(path) === 'notebook' && !books.current.some((book) => book.path === path)) {
      /*
       * And only if it can be brought in at all: bringing in means ADDING a
       * notebook to the room, which has its own rule (shared/rules.ts ·
       * ownBooks), and the server would answer that with a refusal too.
       * Without the check the tab would stay open forever with "opening": the
       * notebook would never appear, and there would be nothing to close.
       */
      if (!may.ownBook) {
        session.showError(may.ownBookWhy)
        return
      }
      session.send({ t: 'book:open', path })
    }
    tabs.open(path)
  }

  function runFile(path: string): void {
    session.send({ t: 'file:run', path })
    // The output goes to the terminal, and opening it is part of the run:
    // otherwise the press looks as if it did nothing.
    terminalOpen = true
    drawerTab = 'terminal'
  }

  const leftShown = $derived(leftIsDrawer ? leftDrawer : leftOpen)
  const rightShown = $derived(rightIsDrawer ? rightDrawer : rightOpen)

  // Returning to a wide window must not leave a stale overlay hanging around.
  $effect(() => {
    if (!leftIsDrawer) leftDrawer = false
  })
  $effect(() => {
    if (!rightIsDrawer) rightDrawer = false
  })

  function persistPanels(): void {
    try {
      localStorage.setItem(
        PANELS_KEY,
        JSON.stringify({ left: leftOpen, right: rightOpen, head: headOpen }),
      )
    } catch {
      /* ignore */
    }
  }

  /**
   * Fold and unfold the header's top strip.
   *
   * Without an "on a narrow screen it is different" branch like the panels
   * have: the header never becomes a sliding drawer — it is simply there or
   * not, and on a phone that matters most, because 110 px out of 640 cost
   * more there.
   */
  function toggleHead(): void {
    headOpen = !headOpen
    persistPanels()
  }

  function toggleLeft(): void {
    if (leftIsDrawer) {
      leftDrawer = !leftDrawer
      return
    }
    leftOpen = !leftOpen
    persistPanels()
  }

  function toggleRight(): void {
    if (rightIsDrawer) {
      rightDrawer = !rightDrawer
      return
    }
    rightOpen = !rightOpen
    persistPanels()
  }

  /* ------------------------------------------------------------ terminal */

  let terminalOpen = $state(false)
  /*
   * Which surface the drawer is showing. Lives here rather than in the drawer
   * because the drawer is unmounted when it closes, and a teacher who closes
   * the panel to look at a cell should come back to what they were reading.
   */
  let drawerTab = $state<'terminal' | 'kernel' | 'history'>('terminal')
  // The session holds the unread count; only this screen knows whether anybody
  // is looking at the transcript.
  $effect(() => session.setTerminalOpen(terminalOpen))

  /*
   * "Show where they are" from the people list.
   *
   * The line about a person had long known where they were — "editing cell
   * 04", "in the terminal" — but led nowhere: one could see, but not get
   * there. Handled here because two thirds of the places are panels, and
   * this screen and nobody else is in charge of the panels.
   */
  $effect(() => {
    const onReveal = (event: Event) => {
      const target = (event as CustomEvent<RevealTarget>).detail
      if (!target) return
      // On a narrow screen the left panel lies over the notebook: not removing
      // it would mean leading the person to a cell they will not see.
      if (leftIsDrawer) leftDrawer = false
      if (target.where === 'cell') {
        revealCell(session, target.cellId)
        return
      }
      if (target.where === 'file') {
        /*
         * As a tab, not through `openFile`.
         *
         * `openFile` is a gesture from the files panel, and it is about the
         * ROOM: for the teacher a PDF goes from there to the shared screen, and
         * an .ipynb is first brought into the room with a `book:open` frame.
         * Going to a definition is reading for oneself: it must neither take
         * the screen away from the hall nor create a notebook in the room
         * because someone clicked a name with Cmd held down.
         *
         * A definition only ever lives in a .py, so the PDF branch would not
         * fire anyway — but the rule "a jump shows nothing to the room" must
         * rest on a decision here, not on the server happening to answer only
         * about .py files today.
         *
         * `Tabs.open` just makes an already open tab current: no second copy
         * appears in the row, and the place in the file is not lost — it is
         * remembered by lib/goto.svelte.ts and read by the file editor itself.
         *
         * The file may be gone already — removed between the server's answer
         * and the click. There is deliberately no separate check here: "does
         * such a file exist" is decided by this screen once and in one place
         * (`tabs.settle` above and `doc.missing` next to it), and a second,
         * weaker copy of the same judgement would lie on a truncated file list
         * (`filesTruncated`) — that is, it would close the jump for someone
         * with three thousand files in a folder.
         */
        tabs.open(target.path)
        return
      }
      if (target.where === 'terminal') {
        drawerTab = 'terminal'
        if (!terminalOpen) toggleTerminal()
        return
      }
      if (rightIsDrawer) rightDrawer = true
      else if (!rightOpen) {
        rightOpen = true
        persistPanels()
      }
    }
    window.addEventListener(REVEAL_EVENT, onReveal)
    return () => window.removeEventListener(REVEAL_EVENT, onReveal)
  })

  /*
   * "Ask the Oracle" from a cell when the Oracle panel is not on screen.
   *
   * The only listener for this event lives inside AiPanel, and the panel
   * exists only when the right column is open — that is, on a screen wider
   * than 1100px or in the sliding drawer. Under a zoomed projector the "Fix
   * with AI" button under a traceback was pressed into the void: no spinner,
   * no error, no question.
   *
   * This listener opens the panel and forwards the event to it — once it is
   * mounted. It stands ahead of it in the queue only when the panel is not
   * there.
   */
  $effect(() => {
    const onAsk = (event: Event) => {
      if (rightShown) return
      const detail = (event as CustomEvent).detail
      if (rightIsDrawer) rightDrawer = true
      else {
        rightOpen = true
        persistPanels()
      }
      // On the next frame: the panel has to mount and attach its listener,
      // otherwise the question goes into the void again.
      requestAnimationFrame(() =>
        window.dispatchEvent(new CustomEvent('colloq:ask-ai', { detail })),
      )
    }
    window.addEventListener('colloq:ask-ai', onAsk)
    return () => window.removeEventListener('colloq:ask-ai', onAsk)
  })

  function toggleTerminal(): void {
    terminalOpen = !terminalOpen
    // The shell belongs to the room, so ask for one only when nobody has
    // started it yet; reopening my own drawer must never restart a live shell.
    const status = session.terminalStatus
    /*
     * The drawer always opens — the feed is shared, and people come to read
     * it after class precisely — but a participant must not wake the shell
     * after the class is over. A rule cannot express that, so it is the same
     * `actsAfterClass` the server decides by: it will not fulfil such a
     * request and will not send a refusal. Without this check a drawer opened
     * for reading would wake a dormant container — silently and on behalf of
     * someone who asked for nothing.
     */
    if (
      terminalOpen &&
      (status === 'closed' || status === 'dead') &&
      actsAfterClass(may.finished, session.me.role)
    ) {
      session.send({ t: 'term:open' })
    }
  }

  /* ------------------------------------------------- palette and keyboard */

  /**
   * The Oracle line — under the cursor, not under the mouse.
   *
   * The panel may be closed or lying as a drawer; opening it is not enough —
   * there is still nowhere to ask until the focus is in the field. The field
   * is marked with an attribute in AiPanel (see the handoff): finding it by
   * `aside textarea` would tie us to the layout of someone else's panel.
   */
  function focusOracle(): void {
    if (rightIsDrawer) rightDrawer = true
    else if (!rightOpen) {
      rightOpen = true
      persistPanels()
    }
    // On the next frame: the panel is still mounting.
    requestAnimationFrame(() => {
      const line =
        document.querySelector<HTMLTextAreaElement>('[data-oracle-composer]') ??
        // Until the field itself carries the marker — by the column this
        // screen draws: there is exactly one input line in the Oracle panel.
        document.querySelector<HTMLTextAreaElement>('[data-oracle-panel] textarea')
      line?.focus()
    })
  }

  /**
   * The command palette — on demand and as a snapshot.
   *
   * A separate chunk for the same reason as the console: the list is needed
   * by whoever pressed ⌘K, not by everyone who entered the room. The list is
   * built at the moment of opening and does not live on: while a person is
   * reading it, someone else's Run must not reshuffle the rows under the
   * selection cursor.
   */
  let paletteOpen = $state(false)
  // raw: the list is replaced wholesale and never edited in place, while a
  // deep $state would wrap each of hundreds of rows in a proxy for that.
  let paletteList = $state.raw<PaletteItem[]>([])
  let paletteChunk: Promise<
    typeof import('@/components/ui/CommandPalette.svelte').default
  > | null = null
  const paletteView = () =>
    (paletteChunk ??= import('@/components/ui/CommandPalette.svelte').then((m) => m.default))

  /** The cell's first non-empty line — what it is recognised by in the list. */
  function cellLine(cellId: string): string {
    const found = findCell(session.doc, cellId)
    if (!found) return ''
    // `cell.get`, not `cellSource`: the latter creates an empty Y.Text if
    // there is none — that is, edits the shared document for a caption in a
    // list.
    const source = found.cell.get('source') as { toString(): string } | undefined
    const text = source ? source.toString() : ''
    for (const line of text.split('\n')) {
      const trimmed = line.trim()
      if (trimmed) return trimmed.length > 80 ? `${trimmed.slice(0, 79)}…` : trimmed
    }
    return ''
  }

  $effect(() => onLanguageChange(() => { if (paletteOpen) paletteList = paletteItems() }))

  function paletteItems(): PaletteItem[] {
    const out: PaletteItem[] = []
    const live = session.connected
    const book = activeKind === 'notebook' && activePath ? activePath : (books.current[0]?.path ?? null)
    /*
     * Permissions — by THE notebook that "Run all", "Clear outputs" and
     * "Format" will go to: it may have its own access, and the room's answer
     * here would either hide actions in the student's own notebook or offer
     * them in someone else's personal one — only for the server to refuse.
     */
    const here = permitsIn(session.session.rules, session.me.role, session.finished, {
      root: books.current.find((entry) => entry.path === book)?.root ?? null,
      participantId: session.me.id,
    })

    /* Actions first: they are searched by word, cells by number. */
    const act = (
      id: string,
      label: string,
      allowed: boolean,
      run: () => void,
      hint?: string,
      keywords?: string,
    ) => {
      if (allowed) out.push({ id, get group() { return tr('room.ui.960') }, label, hint, keywords, run })
    }
    act(
      'run-all',
      tr('room.ui.961'),
      live && here.run && here.bulk && book !== null,
      () => session.send({ t: 'runAll', book: book ?? undefined }),
      undefined,
      "run all выполнить",
    )
    act(
      'interrupt',
      tr('room.ui.964'),
      live && may.run,
      // The sheet is named, as in the neighbouring rows: there are as many
      // queues as notebooks, and a nameless press would hit someone else's.
      () => session.send({ t: 'interrupt', book: book ?? undefined }),
      undefined,
      "interrupt stop прервать",
    )
    act(
      'clear',
      tr('room.ui.966'),
      live && may.wipe && book !== null,
      () => session.send({ t: 'clearOutputs', book: book ?? undefined }),
      undefined,
      "clear outputs очистить",
    )
    act(
      'format',
      tr('room.ui.969'),
      live && here.bulk && here.edit && book !== null,
      () => session.send({ t: 'format', book: book ?? undefined }),
      undefined,
      'format black',
    )
    /*
     * Restarting the kernel is deliberately absent here. In the toolbar it is
     * done by HOLDING, and that is a decision: it loses all of the room's
     * variables and cannot be undone. A list row firing on Enter at the first
     * press would bypass exactly the second step the hold was written for.
     */
    act('panel-files', tr('room.ui.971'), true, toggleLeft, `${modKey}B`, 'files people')
    // The header folds from the keyboard too: it deliberately has no hotkey —
    // it is a per-class setting, not something one yanks mid-work.
    act(
      'head',
      headOpen ? tr('room.head.fold') : tr('room.head.unfold'),
      true,
      toggleHead,
      undefined,
      'header шапка',
    )
    act('panel-oracle', tr('room.ui.973'), true, focusOracle, `${modKey}I`, "ai oracle ии")
    act('panel-terminal', tr('room.ui.679'), true, toggleTerminal, `${modKey}J`, "terminal shell консоль")
    act('copy-link', tr('room.ui.976'), true, () => void copyLink(), undefined, 'link')
    act('rules', tr('room.ui.900'), isHost, () => (rulesOpen = true), undefined, "правила rules")
    act('projection', tr('room.ui.301'), isHost, toProjection, undefined, "screen проекция")
    act('pult', tr('room.ui.979'), isHost, toPult, undefined, "пульт console лекция")
    act(
      'class',
      session.finished ? tr('room.ui.909') : tr('room.ui.933'),
      isHost && live,
      () => setClassOver(!session.finished),
      undefined,
      "class занятие",
    )

    /* Tabs that are already open — and files that are not yet. */
    row.forEach((key, index) => {
      if (typeof key !== 'string') return
      out.push({
        id: `tab:${key}`,
        get group() { return tr('room.ui.982') },
        label: baseOf(key),
        hint: index < 9 ? `Ctrl${index + 1}` : undefined,
        keywords: key,
        run: () => tabs.show(key),
      })
    })
    const open = new Set(row.filter((key): key is string => typeof key === 'string'))
    for (const file of session.files) {
      if (file.dir || open.has(file.path)) continue
      out.push({
        id: `file:${file.path}`,
        get group() { return tr('room.ui.586') },
        label: file.path,
        run: () => openFile(file.path),
      })
    }

    /* Cells — of all the room's notebooks at once: each has its own number,
       and "show where it is" can open the notebook it lives in. */
    for (const [cellId, number] of everyCell.current) {
      const line = cellLine(cellId)
      out.push({
        id: `cell:${cellId}`,
        get group() { return tr('room.ui.984') },
        label: line || tr('room.ui.985'),
        hint: String(number).padStart(2, '0'),
        keywords: `ячейка cell ${number}`,
        run: () => revealCell(session, cellId),
      })
    }
    return out
  }

  function openPalette(): void {
    paletteList = paletteItems()
    paletteOpen = true
    void paletteView()
  }

  function onKeydown(event: KeyboardEvent): void {
    /*
     * The room's keyboard — only in the room.
     *
     * `<svelte:window>` sits outside the mode branches, and until now these
     * keys reached state that is not drawn on the projection or the console:
     * Ctrl+` set `terminalOpen = true` under an invisible drawer, reset this
     * tab's unread count and, with a sleeping container, sent `term:open` —
     * that is, woke the shell with a key press on the laptop at the
     * projector. The console has its own keyboard (ConsoleView), the
     * projection has none except Escape, and that lives in its own effect
     * above.
     */
    if (mode !== 'room') return
    // While the palette is open, it handles the keys.
    if (paletteOpen) return

    const mod = (event.metaKey || event.ctrlKey) && !event.altKey
    // Ctrl+` reaches the terminal from anywhere, including a focused cell.
    if (event.ctrlKey && !event.metaKey && !event.altKey && event.code === 'Backquote') {
      event.preventDefault()
      toggleTerminal()
      return
    }
    if (mod && !event.shiftKey) {
      /*
       * Four combinations and one list. Everything they do is also in the
       * palette, captioned with the same combination: a key nobody can read
       * about anywhere is a key used by one person — whoever wrote it.
       */
      if (event.code === 'KeyK') {
        event.preventDefault()
        openPalette()
        return
      }
      if (event.code === 'KeyB') {
        event.preventDefault()
        toggleLeft()
        return
      }
      if (event.code === 'KeyJ') {
        event.preventDefault()
        toggleTerminal()
        return
      }
      if (event.code === 'KeyI') {
        event.preventDefault()
        focusOracle()
        return
      }
    }
    /*
     * Ctrl+1…9 — a tab by position, as in the browser and in editors. Ctrl,
     * not ⌘: ⌘1…9 on a MacBook switches the tabs of the BROWSER ITSELF, and
     * taking them away from it would break something people use more often.
     */
    if (event.ctrlKey && !event.metaKey && !event.altKey && !event.shiftKey) {
      const digit = /^Digit([1-9])$/.exec(event.code)
      if (digit) {
        const key = row[Number(digit[1]) - 1]
        if (typeof key === 'string') {
          event.preventDefault()
          tabs.show(key)
        }
        return
      }
    }
    if (event.key !== 'Escape') return
    /*
     * Escape closes what was opened last — the rules panel too.
     *
     * It had its own `onkeydown` on the background `<div role="presentation">`
     * without a tabindex: such an element never receives keys, that is, Escape
     * there was written and never worked once.
     */
    if (rulesOpen) {
      rulesOpen = false
      event.preventDefault()
    } else if (rightDrawer) {
      rightDrawer = false
      event.preventDefault()
    } else if (leftDrawer) {
      leftDrawer = false
      event.preventDefault()
    }
  }

  /* -------------------------------------------------------------- header */

  let copied = $state(false)
  let copyTimer: number | undefined
  onDestroy(() => window.clearTimeout(copyTimer))

  function rename(next: string): void {
    getMeta(session.doc).set('title', next)
  }

  // The field shows the link the way a person would read it out; the clipboard
  // gets the one a browser can open. Read once, for the same reason as above.
  // svelte-ignore state_referenced_locally
  const shareUrl = `${location.host}/s/${info.id}`

  async function copyLink(): Promise<void> {
    try {
      await copyText(`${location.origin}/s/${info.id}`)
    } catch {
      // The link is the whole point of the press, and silently doing nothing
      // is the worst thing here: the person is sure they copied it and pastes
      // the previous one into the chat.
      session.showError(tr('room.ui.991', { p0: location.origin, p1: info.id }))
      return
    }
    copied = true
    window.clearTimeout(copyTimer)
    copyTimer = window.setTimeout(() => (copied = false), 1600)
  }

  /*
   * Everything on the brand band dims by opacity rather than by swapping a
   * colour: opacity is the only property allowed to animate, and on navy a
   * translucent white reads as the same ink turned down instead of a second
   * grey that has to be picked to work in both themes.
   */
  // No colour here on purpose: `text-white` and `text-brand` land in the same
  // Tailwind bucket, so a caller that inverts to the white ground has to be the
  // only one naming an ink.
  /**
   * The box of one notification in the stack at the bottom.
   *
   * One for all five lines: they stand in one column one under another, and a
   * box differing from its neighbours in border or ground would read as two
   * different things. The paddings are their own — some have a button
   * inside, some a cross, some nothing.
   */
  const TOAST =
    'pointer-events-auto flex max-w-lg gap-2 border border-line bg-raised shadow-pop'

  const BAND_BTN =
    'flex shrink-0 items-center justify-center focus-visible:outline-none ' +
    'focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-white ' +
    'transition-opacity duration-quick ease-out hover:opacity-100'

  /*
   * The two panel toggles, and the one place on the band where opacity alone is
   * not enough.
   *
   * They used to differ by nothing but 55% ink versus 100%, which reads as
   * "this one is dimmer", not as "this one is switched on" — and the shared
   * `hover:opacity-100` above did literally nothing to the open button, since
   * it was already at 100. So both of them answered the pointer with silence,
   * and the state they were reporting was invisible unless you compared the two
   * against each other.
   *
   * A ground fixes both at once. Open is a white wash the button keeps whether
   * or not the pointer is near it; hover is half that wash, so a closed button
   * says "press me" and an open one still says "already on". White rather than
   * the accent on purpose: the accent is this band's one signal colour and it
   * belongs to the kernel's state, not to which column is showing.
   *
   * The press is the house one — 3% under the finger, bound to :active rather
   * than to a state, so it cannot arrive late. index.css keeps it under reduced
   * motion for the same reason it keeps every other press: 3% that never
   * travels is feedback, not decoration.
   *
   * Three per cent means three: there used to be 0.95 here, and on a 28 px
   * button that reads as a flinch (index.css: "0.95 reads as a flinch at this
   * size"), and the product keeps exactly one press scale. The lists are
   * positional, as for `.btn` in the same place: colour answers the POINTER
   * and takes `ease` at click speed, transform answers the PRESS and takes
   * --ease-out at its own, 120 ms. With one duration for three properties the
   * transform ran at 100 ms — the wrong rung of the ladder.
   */
  const bandIcon = (on: boolean) =>
    cn(
      'flex h-7 w-7 shrink-0 items-center justify-center text-white',
      'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-white',
      'transition-[background-color,opacity,transform]',
      'duration-[var(--speed-quick),var(--speed-quick),var(--speed-press)]',
      'ease-[ease,ease,var(--ease-out)] enabled:active:scale-[0.97]',
      on
        ? 'bg-white/15 opacity-100 hover:bg-white/20'
        : 'opacity-60 hover:bg-white/10 hover:opacity-100',
    )
</script>

<svelte:window onkeydown={onKeydown} />

{#if projection}
  <!--
    The screen on the projector. The room is not drawn under it at all — no
    tabs, no panels, no notebook: it is the only place in the product that
    twenty people look at at once, and anything superfluous on it is what
    they will see. The connection is the same, though: SessionState lives in
    this same component, and switching here does not touch it.
  -->
  <!--
    The insets for the notch are on the container, not in every row: with
    `viewport-fit=cover` (see index.html) the page takes the whole physical
    screen, and on a tablet standing in for a projector "Screen ready" would
    end up under the notch. On the laptop at the projector all four are
    zeros, and the rule costs nothing.
  -->
  <div
    class="fixed inset-0 z-[90] flex flex-col bg-black
           pb-[env(safe-area-inset-bottom)] pl-[env(safe-area-inset-left)]
           pr-[env(safe-area-inset-right)] pt-[env(safe-area-inset-top)]"
  >
    <!--
      Connection status on the projection — in a line of its own, because the
      others do not reach here.

      The "Reconnecting" strip lives in the room header, and there is no room
      here at all; LectureView knows nothing about the connection. Yet the
      projector is the most dangerous of the three surfaces: the last page
      hangs, the teacher pages on the tablet, the hall sees a frozen slide and
      not a word about why it is frozen. A corner, not a plate: one person at
      the projector reads it, and for the other twenty a plate would just be
      litter on the screen.
    -->
    {#if !session.connected && !session.stuck && !session.gone}
      <div
        class="pointer-events-none absolute right-[max(1.5rem,env(safe-area-inset-right))]
               top-[max(1.5rem,env(safe-area-inset-top))] z-10 flex items-center gap-2 text-white/60"
        role="status"
      >
        <Icon name="spinner" size={12} class="animate-spin" />
        <span class="text-2xs font-bold uppercase tracking-label">{tr('room.ui.890')}</span>
      </div>
    {/if}
    {#if lecture}
      <LectureView {lecture} role="projection" onleave={fromProjection} />
    {:else}
      <!--
        No lecture yet. That is normal: the projector is switched on before
        class and the link opened in advance — the screen must say that it is
        ready and what it is waiting for, not show a black rectangle where
        "waiting" cannot be told from "broken".
      -->
      <div class="flex flex-1 flex-col items-center justify-center gap-3 px-8 text-center">
        <span class="text-2xs font-bold uppercase tracking-institution text-white/40"> {tr('room.ui.891')} </span>
        <p class="text-marquee-sm font-black text-white">{title}</p>
        <p class="max-w-md text-ui text-white/50"> {tr('room.ui.892')} </p>
        <div class="mt-4 flex items-center gap-2">
          {#if fullscreenPossible()}
            <button
              type="button"
              class="border border-white/20 px-3 py-1.5 text-2xs font-bold uppercase tracking-label text-white/70 transition-colors duration-100 hover:border-white/40 hover:text-white"
              onclick={() => void goFullscreen(document.documentElement)}
            > {tr('room.ui.193')} </button>
          {/if}
          <button
            type="button"
            class="px-3 py-1.5 text-2xs font-bold uppercase tracking-label text-white/40 transition-colors duration-100 hover:text-white/70"
            onclick={fromProjection}
          > {tr('room.ui.893')} </button>
        </div>
      </div>
    {/if}
    <!--
      A council on the projector — a counter while people are writing, and a
      captioned variant once it has been put on screen.

      The class works on its own machines, and the hall has to see that work
      is going on: how many have submitted out of how many. Other people's
      attempts are not here — except one, the one the teacher decided to show:
      then the counter gives way to it, because that is what everyone is
      looking at in that minute. And it is captioned the same way as the plate
      in everyone's notebook: the same name (or "Variant N"), the same time,
      the same output — one showing, one caption for the whole hall.

      Over the lecture, not in the flow: the document's page must not fidget
      because one more person submitted.
    -->
    {#if councilsOnAir.length > 0}
      <div
        class="pointer-events-none absolute inset-x-0 bottom-0 flex flex-col gap-2 bg-black/70 px-8 pb-[max(1.25rem,env(safe-area-inset-bottom))] pt-4"
        aria-live="polite"
      >
        {#each councilsOnAir as council (council.cellId)}
          <div class="flex flex-col gap-1.5">
            <div class="flex items-baseline gap-4">
              <span class="text-2xs font-bold uppercase tracking-institution text-white/50"> {tr('room.ui.34')}{council.ordinal ? tr('room.ui.894', { p0: council.ordinal }) : ''}
              </span>
              {#if council.shown}
                <!-- On the right — the state of what is shown: "on screen", and
                     the teacher's mark next to it if it is already set. The
                     count of submissions goes away: at this minute the hall is
                     not looking at it. -->
                <span
                  class={cn(
                    'ml-auto text-2xs font-bold uppercase tracking-institution',
                    council.shown.correct === false ? 'text-warning' : 'text-positive',
                  )}
                >
                  {tr('room.ui.52')}{council.shown.correct === null
                    ? ''
                    : ` · ${council.shown.correct ? tr('room.ui.1225') : tr('room.ui.1226')}`}
                </span>
              {:else}
                <span class="font-mono text-ui-lg tabular-nums text-white">
                  {countLine(council.count)}
                </span>
              {/if}
            </div>
            {#if council.shown}
              {@const shown = council.shown}
              {@const lines = shownOutputLines(council.shown.run)}
              <div class="flex flex-wrap items-center gap-x-3 gap-y-1">
                {#if shown.name !== null}
                  <Avatar name={shown.name} color={shown.color ?? '#888888'} avatar={shown.avatar} size="sm" />
                  <span class="text-prompt-sm font-bold text-white">{shown.name}</span>
                {:else}
                  <!-- Names on the projector are off: the variant number
                       instead of a name and an empty circle instead of a face
                       — the same frame as in the notebook. -->
                  <span class="h-6 w-6 shrink-0 rounded-full bg-white/15" aria-hidden="true"></span>
                  <span class="text-prompt-sm font-bold text-white">
                    {tr('room.ui.1255', { p0: shown.variant })}
                  </span>
                {/if}
                <span class="text-ui text-white/50">
                  {tr('room.ui.1256')}{shown.shownAt === null ? '' : ` · ${clock(shown.shownAt)}`}{shown.alsoWrote >
                  0
                    ? ` · ${tr('room.ui.1257', { count: shown.alsoWrote })}`
                    : ''}
                </span>
              </div>
              <!--
                Code in plain monospace, without highlighting: the notebook's
                colours are set for a white sheet, and on black half of them
                dissolve. The hall reads the shape of the solution, not the
                colour of its literals.
              -->
              <pre
                class="overflow-x-auto whitespace-pre font-mono text-prompt-sm text-white">{shown.text}</pre>
              {#if lines.length > 0}
                <pre
                  class="overflow-x-auto whitespace-pre font-mono text-ui-lg text-white/50">{lines.join('\n')}</pre>
              {/if}
            {:else}
              <!--
                The strip grows by scale, not by width.

                The only place in the room where geometry was animated: width
                costs layout on every frame of the transition, and it did that
                on the projector, over the lecture page, every time someone
                submitted. `scaleX` from the left edge gives the same picture
                on the compositor — the upload strip in the files panel is done
                the same way. The tier is the panel's (220 ms): 300 is above
                anything the product allows itself.
              -->
              <div class="h-1 w-full bg-white/15">
                <div
                  class="h-full w-full origin-left bg-white transition-transform duration-panel ease-out"
                  style:transform={`scaleX(${council.count.total > 0 ? council.count.submitted / council.count.total : 0})`}
                ></div>
              </div>
            {/if}
          </div>
        {/each}
      </div>
    {/if}
  </div>
{:else if councilPult && councilCell}
  <!--
    The council console. No notebook, no panels: the window is open precisely
    so that names, drafts, errors and marks do NOT reach the projector, and
    anything drawn next to them defeats that purpose.
    The connection is the same — the same `SessionState`, the same identity
    from localStorage, the same control socket. The console prints the
    refusal to a non-teacher itself, in its own words: it alone knows what
    exactly is not allowed.
  -->
  <div class="fixed inset-0 z-[95] bg-canvas">
    {#await councilWindow() then Pult}
      <!--
        Remounting on a cell change is deliberate.

        It costs one redraw, and it clears nine pieces of window state: what
        was read, message drafts, the set of "new" ones, held-back
        submissions, the freeze moment, the list snapshot, the opening
        moment, what is expanded and the cursor. Clearing them by hand means
        nine places where one day someone forgets one, and then the second
        cell gets a message written to a person from the first.
      -->
      {#key councilCell}
        <Pult
          cellId={councilCell}
          onpick={(next) => onnavigate?.(pultPath(session.session.id, next))}
          onexit={exitCouncil}
        />
      {/key}
    {/await}
  </div>
{:else if pult}
  <!--
    The console. The room is not drawn under it at all — for the same reason
    as under the projection, only turned the other way: twenty people look at
    the projection and must not see anything superfluous, while the console is
    held in the hands mid-sentence, and anything superfluous there is an extra
    second of silence in the lecture hall. No tabs, no files panel, no Oracle,
    no terminal.
    The connection is the same: `SessionState` lives in this same component,
    and arriving here does not touch it — not the sockets, not the document,
    not presence.
    The wrapper gives the console only a place and a backing: the touch rules
    (a magnifier on long press, a grey flash on every tap) and the notch
    insets sit inside ConsoleView — it knows which edge is taken by what, and
    that is also where they end, touching neither the notebook nor the reader.
  -->
  <!-- No pending branch, as with the panel in App: the ground is already
       drawn, and a spinner over it would be a second wait for the same thing. -->
  <div class="fixed inset-0 z-[95] bg-canvas">
    {#await consoleView() then Console}
      <Console onexit={leavePult} />
    {/await}
  </div>
{:else}
<!--
  `clip`, not `hidden`: the room has no sideways scroll with any content.

  `overflow-hidden` creates a scrollable box — invisible, but real: as soon as
  the browser shows focus on a button that slid past the right edge (a panel,
  a drawer, someone else's strip), it scrolls that box by itself. After that
  the whole room stays shifted to the left — with the mark and the class name
  past the edge — and there is no way to bring it back: there is no
  scrollbar, and no gesture exists for a hidden box. `clip` cuts exactly the
  same way but creates no box, and such a shift becomes impossible, whatever
  overflows inside.
-->
<div class="flex h-full min-h-0 flex-col overflow-clip bg-canvas">
  <!--
    Two bands, one brand ground. The navy is the printed object the room is
    held in — the same in both themes, like the join poster — so nothing in
    here reads a theme token that flips. White, translucent white, `brand-2`
    and `accent` are the entire palette above the workspace, and every one of
    them resolves to the same value on either side of the switch.
  -->
  <header class="shrink-0 bg-brand">
    <!--
      The mark leads where the person has something to do — or nowhere.

      The Colloq root is the teacher's panel (see App), and EVERYONE had a link
      to it: a student who tapped the logo in the middle of a class left the
      room with a full navigation to the "paste the setup token" form. Now the
      way up exists for whoever has one: the panel for the presenter, the
      course page for a participant, if the seminar belongs to a course.
      Nowhere else to go — and then the mark is just a sign, not a promise.
    -->
    <!--
      The whole top strip of the header is one folding block.

      The fold is measured in height, and it is the only place in the room
      where geometry is animated on purpose: folding the header means GIVING
      its place to the notebook, and a place is given only as real height.
      `slide` runs it on its own element.animate() and can reverse from
      halfway — a press in mid-travel does not start over but goes back from
      the frame it caught. 200 ms is the panel tier (--speed-panel), quintOut
      is the same curve as the side drawers use.

      The content fades faster than the fold (120 ms): by mid-travel there is
      nothing left to read, and the title does not get to ride right up to the
      status bar — it goes under the edge whole, not squashed.

      Under `prefers-reduced-motion` both durations are zero, and this is the
      rare case where the index.css rule ("opacity stays") does not fit: the
      block leaves the DOM only after its LAST transition, and a 0 ms fold next
      to a 120 ms fade left the header standing at full height for those 120
      ms and then cut it off with a jump. Measured on the test bench: the
      height 35 ms after the press was the old 157. Zero on both is truly
      instant. The crossfade of the two marks below survives: it moves
      nothing.
    -->
    {#if headOpen}
      <div transition:slide={{ duration: prefersReducedMotion() ? 0 : 200, easing: quintOut }}>
        <div
          class="px-4 pt-4 sm:px-7"
          transition:fade={{ duration: prefersReducedMotion() ? 0 : 120 }}
        >
          {#if homeHref}
            <a
              href={homeHref}
              aria-label={isHost ? tr('room.extra.401') : tr('room.extra.402', { p0: session.session.course?.name ?? '' })}
              class="block max-w-full transition-opacity duration-100 hover:opacity-85
                     focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white"
            >
              <Wordmark institution={session.session.institution} tone="onDark" />
            </a>
          {:else}
            <div class="block max-w-full">
              <Wordmark institution={session.session.institution} tone="onDark" />
            </div>
          {/if}
        </div>

        <!-- The loudest thing on the screen. Black rather than bold: HSE Sans Black
             is what the artboard is drawn in, and Inter at 700 reads thin here. -->
        <div
          class="flex items-end gap-3 px-4 pb-4 pt-2 sm:gap-4 sm:px-7 sm:pb-5 sm:pt-3"
          transition:fade={{ duration: prefersReducedMotion() ? 0 : 120 }}
        >
          {#if !title}
            <div role="status" aria-label={tr('common.loading')} aria-busy="true" class="min-w-0 flex-1 text-marquee-sm sm:text-marquee">
              <Skeleton width="min(80%, 32rem)" height="0.85em" tone="onDark" />
            </div>
          {:else if isHost}
            <!-- Renaming writes into the shared doc, so the room sees it immediately. -->
            <input
              class="name-field -mx-1.5 min-w-0 truncate bg-transparent px-1.5 text-marquee-sm
                     font-black text-white hover:bg-white/5 focus:bg-white/10 sm:text-marquee"
              value={storedTitle}
              oninput={(event) => rename(event.currentTarget.value)}
              aria-label={tr('room.ui.895')}
              maxlength={80}
              spellcheck="false"
            />
          {:else}
            <h1 class="-mx-1.5 min-w-0 truncate px-1.5 text-marquee-sm font-black text-white sm:text-marquee">
              {title}
            </h1>
          {/if}

          <time
            datetime={started.toISOString()}
            title={dateLong}
            class="shrink-0 pb-1 font-mono text-ui-lg text-white/60">{dateShort}</time
          >
          <!-- Holds the pair to the left when the name is short. -->
          <span class="min-w-0 flex-1"></span>
        </div>
      </div>
    {/if}

    <!-- The live state of the room: who is here, what the machine is doing, and
         the two controls that are about this room rather than about the
         notebook inside it. -->
    <!--
      45, not 44: the rule on top eats a pixel from the content box, and in the
      remaining 43 any child of even height is centred on half a pixel. That
      blurred circles around the ring, and on 1x noticeably so.
    -->
    <!--
      The strip WRAPS rather than pushing its content off screen.

      On a phone it holds eight organs at once: people, kernel, connection
      state, four toggles, theme and link — about 520 px in a 360 window.
      While it was a single line without wrapping, the excess slid right under
      the root's `overflow-hidden`: the "Copy" button stood past the edge
      entirely, and "Reconnecting" pushed it there along with the theme — that
      is, a dropped connection took off screen exactly the two buttons one
      answers it with. Wrapping puts the button group on a second line exactly
      when it did not fit, and costs not a pixel where it did.

      No breakpoint on purpose: the strip overflows not at a "phone" width but
      when it holds a lot of CONTENT — four people in the room, and the Russian
      "KERNEL STOPPED" and "Reconnecting" together take 500 px even on a 768
      tablet. Wrapping in place fixes that case too, and on a laptop it never
      happens.

      The height is as before: 45 − 1 (the rule on top) = 44, minus py-1.5 on
      both sides = 32 per line, and a 28 child is still centred on whole
      pixels.
    -->
    <!--
      The rule on top — while there is something on top.

      It separates the strip from the class name, and a folded header has
      nothing to separate: the strip stands as the first line of the screen,
      and a rule on its top edge would read as an unfinished window frame.
    -->
    <div
      class={cn(
        'flex min-h-[45px] flex-wrap items-center gap-x-3 gap-y-1.5 px-4 py-1.5 sm:gap-x-4 sm:px-7',
        headOpen && 'border-t border-brand-2',
      )}
    >
      <!--
        The mark of the folded header is the same one, and it stands in the
        same column.

        The strip and the header have the same left inset (px-4 / sm:px-7), so
        the sign does not move horizontally: while the fold closes, the strip
        itself rises to it, and the two marks — the one leaving in the header
        and the one arriving here — converge on one point. The crossfade along
        that path reads as ONE sign MOVING, not as one replaced by another; a
        real shared element would give the same picture at the cost of
        measuring on every frame.

        The heading leaves together with the fold, and without an `h1` the page
        would be nameless for a screen reader: `sr-only` returns the class name
        to where it was, and the `title` on the sign serves those who hover.
      -->
      {#if !headOpen}
        <h1 class="sr-only">{title}</h1>
        <!-- The same door as the mark in the unfolded header: folding the strip
             does not lose the way to the panel (or to the course page). -->
        {#if homeHref}
          <a
            href={homeHref}
            aria-label={isHost ? tr('room.extra.401') : tr('room.extra.402', { p0: session.session.course?.name ?? '' })}
            class="flex shrink-0 items-center text-white transition-opacity duration-100 hover:opacity-85
                   focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white"
            in:fade={{ duration: 160, delay: 40 }}
            out:fade={{ duration: 100 }}
          >
            <Icon name="logo" size={16} />
          </a>
        {:else}
          <span
            class="flex shrink-0 items-center text-white"
            title={title}
            in:fade={{ duration: 160, delay: 40 }}
            out:fade={{ duration: 100 }}
          >
            <Icon name="logo" size={16} />
          </span>
        {/if}
      {/if}
      {#if room.length > 0}
        <div class="flex shrink-0 items-center gap-4" title={roomNames}>
          <!-- 28, as on the join screen: 24 read small in this strip, and a
               person in the room is the only thing here about people. -->
          <AvatarStack people={room} max={4} size={28} ring="rgb(var(--brand))" tone="onDark" />
          <span
            class="hidden shrink-0 text-2xs font-bold uppercase tracking-label text-white/80 sm:inline"
          >
            {room.length} {tr('room.ui.896')} </span>
        </div>
        <span class="hidden h-3.5 w-px shrink-0 bg-brand-2 sm:block" aria-hidden="true"></span>
      {/if}

      <!-- Kernel. `python3` is the runtime this product runs and nothing else,
           so naming it is a fact rather than a field we do not have. -->
      <!--
        Dimmed while the socket is down. What the pill holds then is the last
        thing the server said, not what the kernel is doing now — nobody knows
        that — and a live-looking "IDLE" beside a spinner marked RECONNECTING is
        two claims that cannot both be true. Half opacity says "last known"
        without adding a word to a bar that is already full.
      -->
      <div
        class={cn(
          'flex h-7 shrink-0 items-center gap-2 transition-opacity duration-quick',
          kernel.alarm && 'bg-danger/20 px-2.5 ring-1 ring-inset ring-danger',
          !session.connected && 'opacity-50',
        )}
        title={session.connected ? kernel.why : tr('room.extra.405')}
        role="status"
      >
        <span class={cn('h-1.5 w-1.5 shrink-0 rounded-full', kernel.dot)} aria-hidden="true"></span>
        <span class="text-2xs font-bold uppercase tracking-label text-white">{kernel.label}</span>
        {#if !kernel.alarm}
          <span class="hidden font-mono text-2xs text-white/60 lg:inline">python3</span>
        {/if}
      </div>

      <!--
        Both status lines SHRINK rather than grow.

        The Russian "Reconnecting", letter-spaced in upper case, is 185 px, and
        `shrink-0` on them meant that a dropped connection carried off past
        the right edge everything standing to the right: the theme and "Copy".
        The icon never shrinks (`shrink-0` on it), the word shrinks with an
        ellipsis, and `title` holds it in full — together with the strip
        wrapping above, that is enough for the phrase to read in full in a
        room of four.
      -->
      {#if session.stuck}
        <!-- Not "Reconnecting": the tab no longer tries, and a spinner would lie. -->
        <div
          class="flex min-w-0 shrink items-center gap-2 text-white"
          role="status"
          title={tr('room.ui.898')}
        >
          <Icon name="alert" size={12} class="shrink-0" />
          <span class="truncate text-2xs font-bold uppercase tracking-label">{tr('room.ui.898')}</span>
        </div>
      {:else if !session.connected}
        <div
          class="flex min-w-0 shrink items-center gap-2 text-white"
          role="status"
          title={tr('room.ui.899')}
          transition:fade={{ duration: 120 }}
        >
          <Icon name="spinner" size={12} class="shrink-0 animate-spin" />
          <span class="truncate text-2xs font-bold uppercase tracking-label">{tr('room.ui.899')}</span>
        </div>
      {/if}

      <span class="min-w-0 flex-1"></span>

      <!--
        The room's buttons — as ONE group, and they wrap together too.

        Separately, wrapping tore them apart: the toggles stayed on the first
        line, the theme and "Copy" went to the second, and one strip read as
        two different ones. The group wraps as a whole and hugs the right on
        the line it lands on (`ml-auto`) — on a wide window the same spacer as
        before pushes it right, and the strip's drawing does not change.
      -->
      <div class="ml-auto flex shrink-0 items-center gap-3 sm:gap-4">
        <!-- Panels are not on the artboard, which draws both columns open; they
             stay because on a narrow window they are the only way to reach the
             files, the people and the oracle. -->
        <div class="flex shrink-0 items-center gap-0.5">
          {#if isHost}
            <!--
              The rules panel lives here, not only in the admin panel.

              Lecture, lab and consultation are three phases of one class, and
              a rule that can be reached only from the admin panel and only
              when creating a seminar is a rule the teacher cannot reach in the
              minute it is needed.
            -->
            <button
              class={bandIcon(rulesOpen)}
              onclick={() => (rulesOpen = !rulesOpen)}
              aria-pressed={rulesOpen}
              aria-label={tr('room.ui.900')}
              title={tr('room.ui.900')}
            >
              <Icon name="lock" size={16} />
            </button>
          {/if}
          <!--
            The header is as much a room surface as the panels and the drawer,
            and it is toggled in the same place. The left-to-right order
            repeats the screen: header on top, files on the left, drawer at the
            bottom, Oracle on the right.

            `aria-expanded`, not `aria-pressed` like its neighbours: they turn a
            panel on and off, while this one expands and folds what stands
            right above it — it is a disclosure, and a screen reader must call
            it that. The label changes with the state: "fold" on an unfolded
            header is what will happen, not what is.
          -->
          <button
            class={bandIcon(headOpen)}
            onclick={toggleHead}
            aria-expanded={headOpen}
            aria-label={headOpen ? tr('room.head.fold') : tr('room.head.unfold')}
            title={headOpen ? tr('room.head.fold') : tr('room.head.unfold')}
          >
            <Icon name="masthead" size={16} />
          </button>
          <button
            class={bandIcon(leftShown)}
            onclick={toggleLeft}
            aria-pressed={leftShown}
            aria-label={tr('room.ui.901')}
            title={tr('room.extra.407', { p0: modKey })}
          >
            <Icon name="file" size={16} />
          </button>
          <!--
            The bottom drawer is as much a room surface as the side panels,
            and it is toggled where they are. Until now it stood in the
            notebook toolbar, among Run All and Restart — that is, among the
            things that RUN, not the things that open and close. The
            left-to-right order repeats the screen: files on the left, drawer
            at the bottom, Oracle on the right.
          -->
          <button
            class={cn(bandIcon(terminalOpen), 'relative')}
            onclick={toggleTerminal}
            aria-pressed={terminalOpen}
            aria-label={tr('room.ui.902')}
            title={tr('room.extra.408', { p0: modKey })}
          >
            <Icon name="prompt" size={16} />
            {#if session.terminalStatus === 'busy'}
              <span
                class="absolute right-1 top-1 h-1.5 w-1.5 animate-blink rounded-full bg-accent"
              ></span>
            {:else if session.terminalUnread > 0}
              <!--
                The kernel's own news — why Run All stopped, who restarted it —
                is written to the feed, and the feed is behind this button.
                Without the badge the room had the reason at hand and not a
                single cause to look for it.
              -->
              <span
                class="absolute -right-0.5 -top-0.5 inline-flex h-4 min-w-4 items-center
                       justify-center rounded-full bg-accent px-1 font-mono text-micro
                       font-bold text-white"
                title={tr('room.extra.409', { p0: session.terminalUnread })}
              >
                {session.terminalUnread > 9 ? '9+' : session.terminalUnread}
              </span>
            {/if}
          </button>
          <button
            class={bandIcon(rightShown)}
            onclick={toggleRight}
            aria-pressed={rightShown}
            aria-label={tr('room.ui.903')}
            title={tr('room.oracle.shortcut', { key: modKey })}
          >
            <Icon name="sparkles" size={16} />
          </button>
        </div>

        <ThemeSwitch tone="onDark" />

        <!--
          The link, readable and attached to the button that takes it.

          Shown from 1024px, not from 1280: before, the address was hidden on
          any 13" laptop, that is, on most of the machines seminars are run
          from. And the address on screen is the fallback when the clipboard
          does not work: it can be read out or copied by hand. Hiding it
          exactly where it is needed most is exactly backwards.

          `select-all`, so that one press selects it whole.
        -->
        <div class="flex h-7 min-w-0 shrink items-center">
          <span
            class="hidden h-full min-w-0 select-all items-center truncate border border-r-0
                   border-brand-2 px-3 font-mono text-2xs text-white/80 lg:flex"
            title={shareUrl}
          >
            {shareUrl}
          </span>
          <button
            class={cn(BAND_BTN, 'h-full shrink-0 gap-2 bg-white px-3 text-brand opacity-100')}
            onclick={copyLink}
            title={tr('room.ui.904')}
          >
            <Icon name={copied ? 'check' : 'copy'} size={12} />
            <!--
              The word goes into `sr-only`, not under `hidden`: a button with
              a single icon must stay named. The Russian "COPY" is 108 px out
              of 360, and for its sake the strip used to push the button itself
              past the screen edge: on a phone two letters of it remained. The
              name for the screen reader and the `title` for the pointer say the
              same thing, and from `sm` the word returns (`not-sr-only`).
            -->
            <span class="sr-only text-2xs font-bold uppercase tracking-label sm:not-sr-only">
              {copied ? tr('room.ui.905') : tr('room.ui.906')}
            </span>
          </button>
        </div>
      </div>
    </div>
  </header>

  <!--
    The class is over — as a strip, not an icon.

    It is the state of the whole room, and it lasts for days: an icon in the
    header says it in a whisper, and a person for whom nothing can be pressed
    goes looking for a breakage. The strip stands where the work begins,
    covers none of it and does not scroll away — and the warm tone tells "it
    was decided so" from a red "it broke".

    For everyone, not just participants: for the teacher it explains why for
    them alone everything is alive, and keeps the resume button at hand — so
    they do not have to hunt for it in the rules panel mid-class.
  -->
  {#if session.finished}
    <div
      class="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-1.5 border-b border-line
             bg-warning/[0.08] px-4 py-2"
      role="status"
      transition:fade={{ duration: 140 }}
    >
      <Icon name="lock" size={14} class="shrink-0 text-warning" />
      <p class="text-ui font-semibold text-ink"> {tr('room.ui.843')} <span class="ml-1 font-mono text-2xs font-normal text-muted" title={finishedLong}>
          {finishedStamp}
        </span>
      </p>
      <!-- What remains, not what was taken away: people come here to reread
           the review, and the first thing a person must learn is that it is
           all in place. -->
      <!-- `basis-56`, like the rules panel footer: `flex-1` with a zero basis
           took the 30 px left on the line on a phone and set the phrase in a
           column, one word per line. Two hundred and twenty-four is the width
           below which the line wraps whole onto a line of its own. -->
      <p class="min-w-0 flex-1 basis-56 text-2xs leading-snug text-muted">
        {isHost
          ? tr('room.ui.907')
          : tr('room.ui.908')}
      </p>
      {#if isHost}
        <button
          type="button"
          class="btn-outline h-[26px] shrink-0 text-2xs font-semibold"
          disabled={controlDisabled(session.connected)}
          title={controlTitle(
            session.connected,
            tr('room.extra.411'),
          )}
          onclick={() => setClassOver(false)}
        > {tr('room.ui.909')} </button>
      {/if}
    </div>
  {/if}

  <!-- Positioned, so the panel drawers below cover the workspace and stop at
       the masthead without anyone hard-coding how tall the masthead is. -->
  <div class="relative flex min-h-0 flex-1">
    {#if leftShown && !leftIsDrawer}
      <aside class="flex w-60 shrink-0 flex-col border-r border-line bg-surface">
        {@render leftPanels()}
      </aside>
    {/if}

    <!-- The drawer sits inside the notebook column, not under the whole app:
         it is the same machine the cells run on. -->
    <div class="flex min-w-0 flex-1 flex-col">
      {#if row.length > 0}
        <!--
          Tabs appear only when there is something to switch: in a room where
          no file was opened this row does not exist at all and costs not a
          pixel of height.
        -->
        <TabStrip
          tabs={row}
          active={tabs.active}
          board={session.board}
          mayBoard={may.board}
          {lead}
          {orphaned}
          following={readerFollowing}
          page={readerPage}
          pages={readerPages}
          pinned={roomPinned}
          books={bookTabs}
          mayAccess={isHost}
          meId={session.me.id}
          onaccess={setBookAccess}
          onshow={(key) => tabs.show(key)}
          onclose={closeTab}
          onreorder={(dragged, onto) => tabs.reorder(dragged, onto)}
          oncatchup={() => (catchUp += 1)}
        />
      {/if}

      {#if activePath && activeKind === 'text'}
        <FileBar
          path={activePath}
          mayRun={may.run && runnerFor(activePath) !== null}
          mayEdit={may.files}
          whyReadOnly={may.filesWhy}
          refused={activeDoc?.refused ?? false}
          onrun={() => runFile(activePath)}
        />
      {/if}

      <!--
        The notebook is hidden, not unmounted: it holds the cursor, the scroll
        and a dozen and a half CodeMirror editors, and rebuilding them on every
        tab switch means losing one's place in the text. There are as many
        hidden notebooks as open tabs — not one per room.
      -->
      {#each row as path (path)}
        {#if kindOf(path) === 'notebook'}
          <!--
            A press outside a cell clears the selection.

            Until now there was no way at all to leave the "selected" state:
            there was one way to select — press a cell — and no way to
            unselect. The handler sits on the column, not on the notebook
            itself: below the last cell there is empty space, and it is
            "outside" too. What is checked is the press target, not the
            coordinate: a toolbar button is outside a cell too, and rightly so,
            it belongs to the whole notebook.
          -->
          <!-- svelte-ignore a11y_no_static_element_interactions -->
          <!-- svelte-ignore a11y_click_events_have_key_events -->
          <main
            class="min-h-0 flex-1 overflow-y-auto"
            class:hidden={activePath !== path}
            aria-hidden={activePath !== path}
            onclick={(event) => {
              // By what is pressed, not by the cell root: the body and the
              // number itself carry `data-cell-pick` and select, while empty
              // space in the margin next to the number is already outside, and
              // that is where the selection is cleared.
              if ((event.target as HTMLElement | null)?.closest('[data-cell-pick]')) return
              if (session.selection.length > 0) session.selectCell(null)
            }}
          >
            {#if books.current.some((book) => book.path === path)}
              <Notebook book={path} active={activePath === path} />
            {:else}
              <div class="flex h-full items-center justify-center text-ui text-muted"> {tr('room.ui.107')} {baseOf(path)}…
              </div>
            {/if}
          </main>
        {/if}
      {/each}

      {#if activePath === null}
        <!--
          Nothing open is a state, not a breakage: it did not exist before,
          because the notebook could not be closed.

          There used to be two lines of text centred in an empty rectangle, and
          they read as an error message about something nobody did. Now the
          centre holds a watermark: the same mark as in the room header and on
          the join poster, only in one tone and almost transparent. An empty
          place should look empty — but one's own, not broken.

          The mark is STACKED, not in a row as everywhere else: a row at
          820×830 reads as a heading someone forgot to finish, while a stack
          reads as a sign on paper. This is not the lockup from the header (it
          is one on all screens and does not change size); it is its shadow,
          and it has a different shape on purpose.

          Nine per cent — enough for the sign to be visible on white and not
          argue with the panels at the edges; in the dark theme the same token
          gives the same ratio by itself.
        -->
        <div
          class="flex min-h-0 flex-1 select-none flex-col items-center justify-center gap-7 px-6"
        >
          <div
            class="flex flex-col items-center gap-5 text-ink opacity-[0.09]"
            aria-hidden="true"
          >
            <Icon name="logo" size={104} />
            <!-- A negative margin on the right exactly the size of the
                 tracking: 0.22em is added AFTER the last Q too, and without
                 this the word stands half a step to the left of the sign above
                 it. At 11 pixels in the header that is invisible, at forty-two
                 it shows. -->
            <span
              class="-mr-[0.22em] text-[42px] font-bold uppercase leading-none tracking-wordmark"
            >
              Colloq
            </span>
          </div>
          <!-- The state is still named in the screen reader's voice: the sign
               does not pronounce it, and it is exactly those who do not see
               the sign who need to know. -->
          <p class="sr-only">{tr('room.ui.910')}</p>
          <p class="text-2xs text-muted">{tr('room.ui.911')}</p>
        </div>
      {:else if activeKind === 'pdf'}
        {#if lecture && lectureHere && !soloRead}
          <LectureView
            {lecture}
            role={leading ? 'presenter' : 'audience'}
            onproject={toProjection}
            onsolo={leading ? undefined : () => (soloRead = true)}
          />
        {:else}
          {#if may.board && lecture === null && activePath !== session.board}
            <!--
              "Share screen" — that very separate action for whose sake opening
              a file stopped taking the screen away from the room. A strip
              under the tab, as for a script: every tab has its own actions,
              and they are always under it.

              The transition is a list of properties, not the `transition`
              shorthand: that one transitions ALL properties, including the
              focus ring's border-color and box-shadow, that is, the ring would
              arrive after the key. Exactly two things move here — brightness
              under the pointer and scale under the finger; the strip is drawn
              by hand and does not fit into `.btn` (see index.css · .btn, where
              the same list stands positionally).
            -->
            <div class="flex h-[34px] shrink-0 items-stretch border-b border-line bg-canvas">
              <button
                type="button"
                class="flex shrink-0 items-center gap-2 bg-primary px-4 text-2xs font-bold
                       uppercase tracking-label text-primary-ink
                       transition-[filter,transform] duration-press ease-out
                       enabled:active:scale-[0.97] hover:brightness-110 active:brightness-95
                       focus-visible:outline-none
                       focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent/40"
                title={tr('room.ui.912')}
                onclick={() => showToRoom(activePath)}
              >
                <Icon name="board" size={11} /> {tr('room.ui.913')} </button>
              <span class="flex-1"></span>
              {#if session.board}
                <!-- The file name shrinks: "following" with a long name pushed
                   the "Share screen" button itself past a phone's right
                   edge. -->
              <span class="flex min-w-0 shrink items-center px-3 text-2xs text-muted sm:px-5">
                <span class="truncate"> {tr('room.ui.914')} {baseOf(session.board)} </span>
              </span>
              {/if}
            </div>
          {/if}
          <!--
            Per file, not one branch for all PDFs: the reader opens the document
            once on mount, and changing the file within the same branch left the
            previous one's pages on screen — under the new tab name, with its own
            page counter, and "following …" matched by numbers, because everyone
            was looking at the same wrong document.
          -->
          {#key activePath}
            <PdfReader
              file={activePath}
              shared={activePath === session.board}
              mayLead={may.board && lecture === null}
              backToLecture={lectureHere ? () => (soloRead = false) : null}
              {catchUp}
              {lead}
              bind:page={readerPage}
              bind:pages={readerPages}
              bind:following={readerFollowing}
            />
          {/key}
        {/if}
      {:else if activePath && activeKind === 'text'}
        {#if activeDoc?.tooBig}
          <!--
            The file exists, it is just too big for the editor. The tab stays:
            "no such file" closes it, but here there is nothing to close — the
            person clicked a live file and needs an answer, not a vanished tab.
          -->
          <div class="flex min-h-0 flex-1 flex-col items-center justify-center gap-2 px-6 text-center">
            <p class="text-ui text-ink">{baseOf(activePath)} {tr('room.ui.915')}</p>
            <p class="text-2xs text-muted"> {tr('room.ui.916')} </p>
          </div>
        {:else if activeDoc}
          {#key activePath}
            <FileEditor
              file={activeDoc}
              readOnly={!may.files || activeDoc.refused}
              onrun={runnerFor(activePath) && may.run ? () => runFile(activePath) : null}
            />
          {/key}
        {:else}
          <div class="flex min-h-0 flex-1 items-center justify-center text-ui text-muted"> {tr('room.ui.107')} {baseOf(activePath)}…
          </div>
        {/if}
      {:else if activePath && activeKind === 'image'}
        <!-- An image is looked at, not edited. Downloading is in the tree,
             where it is for all the other files. -->
        <ImageView path={activePath} />
      {:else if activePath && activeKind !== 'notebook'}
        <!--
          The notebook does not get here: it is drawn above, in its own `main`.
          Without this condition "not text" was printed under an open notebook
          — the branch reached it last and was formally right.
        -->
        <div class="flex min-h-0 flex-1 flex-col items-center justify-center gap-2 px-6 text-center">
          <p class="text-ui text-ink">{baseOf(activePath)} {tr('room.ui.917')}</p>
          <p class="text-2xs text-muted"> {tr('room.ui.918')} </p>
        </div>
      {/if}

      {#if terminalOpen}
        <TerminalDrawer bind:tab={drawerTab} onclose={() => (terminalOpen = false)} />
      {/if}
    </div>

    {#if rightShown && !rightIsDrawer}
      <aside
        class="flex w-[380px] shrink-0 flex-col border-l border-line bg-surface"
        data-oracle-panel
      >
        <AiPanel />
      </aside>
    {/if}

    <!--
      The travel below is gated here rather than in index.css, and it has to be:
      Svelte runs transition:fly through element.animate(), which no media query
      can reach — the reduced-motion block in index.css names what CSS owns, and
      these ±140px are the largest movement in the product. Reduced is a
      reduction, not a blackout: the panel still arrives over 140ms and still
      fades, it simply stops sliding.

      `in:`, not `transition:` — the same decision admin/motion.css made for
      the panel's menus, and for the same reason. The drawer is closed with
      Escape (onKeydown below), and an action from the keyboard must not be
      animated: the key is pressed to GET RID of the panel, and 140 ms of
      sliding away is 140 ms in which it is still visible. Leaving is instant
      on all three roads — Escape, a click outside, the same button — because
      a panel that leaves differently depending on how it was closed reads as
      different panels.

      quintOut, not cubicOut: 1−(1−t)⁵ is the closest in svelte/easing to
      --ease-out, which index.css prescribes for everything that moves.
      cubicOut is noticeably softer, and the panel arrived with a different
      motion than all the neighbouring surfaces.
    -->
    {#if leftIsDrawer && leftDrawer}
      <div class="absolute inset-0 z-40 flex">
        <button
          class="absolute inset-0 bg-canvas/70"
          aria-label={tr('room.ui.919')}
          onclick={() => (leftDrawer = false)}
          in:fade={{ duration: 120 }}
        ></button>
        <aside
          class="relative flex w-60 max-w-[85vw] flex-col border-r border-line bg-surface shadow-pop"
          in:fly={{ x: prefersReducedMotion() ? 0 : -140, duration: 140, easing: quintOut }}
        >
          {@render leftPanels()}
        </aside>
      </div>
    {/if}

    {#if rightIsDrawer && rightDrawer}
      <div class="absolute inset-0 z-40 flex justify-end">
        <button
          class="absolute inset-0 bg-canvas/70"
          aria-label={tr('room.ui.920')}
          onclick={() => (rightDrawer = false)}
          in:fade={{ duration: 120 }}
        ></button>
        <aside
          class="relative flex w-[380px] max-w-[92vw] flex-col border-l border-line bg-surface shadow-pop"
          data-oracle-panel
          in:fly={{ x: prefersReducedMotion() ? 0 : 140, duration: 140, easing: quintOut }}
        >
          <AiPanel />
        </aside>
      </div>
    {/if}
  </div>
</div>
{/if}

<!--
  A room that no longer exists.

  The server closes the socket with 1001 and a reason, and nobody used to
  read it: the browser simply reconnected, got a refusal and spun
  "RECONNECTING" until the end of the day in front of a person whose seminar
  no longer exists. This is not a strip at the bottom but the end of work —
  hence full screen.
-->
<!--
  A layer above the projection (z-90) and the console (z-95): under them this
  plate was drawn and invisible, and both surfaces kept looking alive — the
  last lecture page on the projector, the sheet with keys on the tablet. A
  "dead but alive-looking" surface is the worst case of all, and here it was.

  Not on the console: there ConsoleView itself speaks about the deleted room,
  in its own words and about the ink that has nowhere to be saved any more.
-->
{#if session.gone && !pult}
  <div class="fixed inset-0 z-[100] flex items-center justify-center bg-canvas/95 px-6">
    <div class="w-full max-w-sm text-center">
      <span
        class="mx-auto flex h-10 w-10 items-center justify-center border border-line bg-surface text-faint"
      >
        <Icon name="link" size={16} />
      </span>
      <h1 class="mt-4 text-title font-semibold tracking-tight text-ink">{tr('room.ui.145')}</h1>
      <p class="mt-2 text-ui text-muted"> {tr('room.ui.921')} </p>
    </div>
  </div>
{/if}

<!--
  You were removed from the class — in the middle of the class.

  Over the room and full screen, like "seminar deleted": working here is no
  longer possible, and a strip at the bottom, under a live-looking notebook,
  would promise the opposite. The room itself is intact — that is how this
  case differs from a deleted one — but there is no point saying so on
  screen: the person needs to know until what hour and whom to go to.
-->
{#if session.banned !== null}
  <!-- The same tier as "seminar deleted" above, and for the same reason: the
       console and the projection must not survive their person's removal
       silently. -->
  <div class="fixed inset-0 z-[100] flex items-center justify-center bg-canvas/95 px-6">
    <BannedScreen until={session.banned} />
  </div>
{/if}

<!-- One menu for both places bans come from — see BanMenu.svelte. Only for
     the presenter: for a student it would open nothing, and drawn it would
     lie. -->
{#if isHost && !session.gone && session.banned === null}
  <BanMenu />
{/if}

<!--
  The palette — the room's entire keyboard in one list.

  Only in the room: the console has its own keyboard, the projection has
  none. No pending branch — the chunk is small and arrives in one request,
  and a spinner flashing where someone is about to type costs more.
-->
{#if paletteOpen && mode === 'room' && !session.gone && session.banned === null}
  {#await paletteView() then Palette}
    <Palette items={paletteList} onclose={() => (paletteOpen = false)} />
  {/await}
{/if}

{#if refusal && refusalShown && !projection}
  <!--
    Modal, not a line: the person has just lost a few seconds of work, and
    text they do not manage to read is the same lost text.
  -->
  <!--
    On the console too — but not on the projection.

    Console: a refusal is cured by a reload, and a reload from `/s/:id/pult`
    returns to `/s/:id/pult` (lib/refusal.ts · reloadByHand). While the window
    lay at z-[60] under the console's opaque wrapper (z-[95] below), the
    teacher on the tablet got their sheet back and not a word about the edit
    not being accepted and about what exactly of the typed text did not get
    through. ConsoleView deliberately writes no text of its own here: the
    window is not an announcement but the only copy of what was lost, and
    there must be no second such copy in the product ("deleted" and
    "diverged" have exactly enough words for a plate, which is why they are
    said there in their own words).

    Projection: the hall looks at the projector, and someone's notebook full
    screen in the middle of a class is the worst thing that can be drawn
    there. There is nothing to type with on the projection, so a note gets
    here only as an echo (the cache of the same tab that had been in the
    room). It does not get lost: `refusal` and `refusedCells` live in this
    same component, and a mode change does not recreate it (App keeps
    `{#key}` on the token, not on the mode) — the window waits until one
    leaves the projection for the room.
  -->
  <!--
    Typed in the second the bell rang — and that has to be told as a bell,
    not as an edit.

    The gate refused in the same words as everything else after the end of
    class (CLASS_IS_OVER, server/src/collab/gate.ts) — that is how the window
    recognises its case. The title "Edit not saved" lies about the cause
    here: the edit was not accepted not because it was bad, and not because
    someone changed a rule, but because the class ended exactly between two
    key presses.
  -->
  {@const overClass = refusal.message === CLASS_IS_OVER || refusal.message === tr(CLASS_IS_OVER)}
  <!--
    A tier of its own between the console and the terminal plates: above the
    console wrapper (z-[95]) and the projection (z-[90]), but below
    "deleted" / "you were removed" / "diverged" (z-[100]). The order matters
    both ways here: under the console the window was invisible, and ABOVE the
    deleted-room plate it would offer to copy text to where it can no longer
    be returned.
  -->
  <div
    role="dialog"
    aria-modal="true"
    aria-labelledby="refused-title"
    class="fixed inset-0 z-[97] flex items-center justify-center bg-brand/40 p-6"
  >
    <div class="flex max-h-full w-full max-w-[520px] flex-col border border-line bg-canvas shadow-pop">
      <div class="border-b border-line px-5 py-3.5">
        <h2 id="refused-title" class="text-title font-semibold text-ink">
          {overClass ? tr('room.ui.843') : tr('room.ui.922')}
        </h2>
        <p class="mt-1 text-ui leading-snug text-muted">
          {#if overClass} {tr('room.ui.923')} {:else}
            {refusal.message}
          {/if}
        </p>
      </div>
      <!--
        All cells, not one.

        The gate refuses a WHOLE FRAME, and a frame after a dropped connection
        is everything the person typed offline, in all cells at once. While
        there was one here (the one with the cursor), the rest went away with
        the cache silently.

        Only what the server really does not have is shown: a reload builds
        the tab from the server's copy, and forty cells of which thirty-nine
        are in place hide the one everything was for
        (lib/refusal.ts · stillLost).
      -->
      {#if refusedChecking}
        <div class="border-b border-line bg-surface px-5 py-3">
          <p class="text-ui text-muted">{tr('room.ui.924')}</p>
        </div>
      {:else if refusedCells.length > 0}
        <div class="min-h-0 flex-1 overflow-y-auto border-b border-line bg-surface px-5 py-3">
          <p class="pb-1.5 text-2xs font-bold uppercase tracking-caps text-muted">
            {refusedCells.length === 1 ? tr('room.ui.925') : tr('room.ui.926')}
          </p>
          <div class="flex flex-col gap-3">
            {#each refusedCells as cell (cell.id || 'cursor')}
              {@const number = cell.id ? everyCell.current.get(cell.id) : undefined}
              <div class="flex flex-col gap-1">
                {#if number !== undefined}
                  <p class="font-mono text-2xs text-muted"> {tr('room.ui.927')} {String(number).padStart(2, '0')}
                  </p>
                {/if}
                <pre
                  class="whitespace-pre-wrap break-words font-mono text-code leading-relaxed text-ink">{cell.text}</pre>
              </div>
            {/each}
          </div>
        </div>
      {/if}
      <!-- On the console this is read from a tablet and pressed with a finger:
           the same buttons in the same row, but as tall as the console's other
           buttons (h-11, see ConsoleView) — 30 px is too little for a finger
           at the bottom edge. -->
      <div class="flex items-center gap-2 px-5 py-3">
        {#if refusedCells.length > 0}
          <button
            type="button"
            class={cn('btn-ghost', pult && 'h-11 px-5')}
            onclick={() => void copyRefused()}
          >
            {refusalCopied
              ? tr('room.ui.138')
              : refusedCells.length === 1
                ? tr('room.ui.139')
                : tr('room.ui.928')}
          </button>
        {/if}
        <span class="flex-1"></span>
        <button
          type="button"
          class={cn('btn-primary', pult && 'h-11 px-6')}
          onclick={() => (refusalShown = false)}
        > {tr('room.ui.929')} </button>
      </div>
    </div>
  </div>
{/if}

<!--
  The rules panel: the same list as in the admin panel, in the same words.

  It lies over the status bar rather than opening as a separate page: it is a
  tool picked up in the middle of a class for ten seconds, not a screen one
  goes to.
-->
<!--
  Only in the room, like the palette next to it. It can be opened only from
  here (the status bar and the palette are both in the room), but `rulesOpen`
  survives a mode change: this component is one for all three (`mode` is a
  prop, App keeps `{#key}` on the token). A rules panel left open lay under
  the projection (z-[90]) and under the console (z-[95]) — drawn, clickable
  and invisible; Escape does not reach it there either (`onKeydown` returns
  on its very first line). The state is kept: back in the room — the panel
  is in place.
-->
{#if rulesOpen && isHost && mode === 'room' && !session.gone}
  <!-- Only a click outside. Escape is handled by the window handler
       (`onKeydown`): here it hung on an unfocusable `div` and never fired. -->
  <!-- svelte-ignore a11y_click_events_have_key_events -->
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div class="fixed inset-0 z-40" role="presentation" onclick={() => (rulesOpen = false)}></div>
  <!--
    Height is LIMITED by the screen, not by the content.

    The limit sat on the rules list (60vh), while the title, "End class" and
    the note counted as free — and in a phone's landscape orientation (390 px
    tall) 104 on top plus 60vh plus these three strips went past the bottom
    edge together with the most important button. One could not scroll down
    to it: the list scrolled INSIDE, not the sheet. Now the sheet is no
    taller than the window, and the list still scrolls — the title and the
    button are always in view.
  -->
  <div
    class="fixed right-3 top-[104px] z-50 flex max-h-[calc(100dvh-7.5rem)] flex-col
           w-[min(30rem,calc(100vw-1.5rem))] border border-line bg-raised shadow-pop sm:right-6"
    role="dialog"
    aria-label={tr('room.ui.900')}
    in:fly={{ y: prefersReducedMotion() ? 0 : -6, duration: 140, easing: quintOut }}
  >
    <div class="flex shrink-0 items-center gap-2 border-b border-line px-4 py-2.5">
      <h2 class="min-w-0 truncate text-2xs font-bold uppercase tracking-section text-muted"> {tr('room.ui.900')} </h2>
      <span class="h-px flex-1 bg-line" aria-hidden="true"></span>
      <button
        class="btn-ghost h-6 w-6 shrink-0 px-0"
        onclick={() => (rulesOpen = false)}
        aria-label={tr('room.ui.141')}
      >
        <Icon name="x" size={14} />
      </button>
    </div>
    <!-- The LIST scrolls, not the whole sheet: the title and "End class" under
         it must stay in view. -->
    <div class="min-h-0 flex-1 overflow-y-auto px-4 sm:max-h-[min(60vh,32rem)]">
      <RoomRulesRows
        rules={roomRules}
        busy={rulesBusy}
        instance={oracleLimits}
        ownKernels={session.ownKernels}
        onchange={setRule}
      />
    </div>
    <!--
      The end of class — here, under the rules, not as an eighth row among
      them.

      A rule answers "who may", and this answers "is the class on": it covers
      all eight at once and is lifted by the same press, and the chosen rules
      stay in place meanwhile, to come back when the class resumes.
    -->
    <div class="flex shrink-0 flex-wrap items-center gap-x-4 gap-y-2 border-t border-line px-4 py-3">
      <div class="min-w-0 flex-1 basis-56">
        <p class="text-ui font-semibold text-ink">
          {session.finished ? tr('room.ui.843') : tr('room.ui.930')}
        </p>
        <p class="mt-0.5 text-2xs leading-snug text-muted">
          {#if session.finished} {tr('room.ui.931')} {:else} {tr('room.ui.932')} {/if}
        </p>
      </div>
      <!-- Like "Restart kernel": without a connection the press goes nowhere,
           and a button that pretended it went costs more here than the others —
           half the room would keep typing in a class that seems to have been
           ended. -->
      <button
        type="button"
        class="btn-outline h-[30px] shrink-0 text-2xs font-semibold"
        disabled={controlDisabled(session.connected)}
        title={controlTitle(
          session.connected,
          session.finished
            ? tr('room.extra.411')
            : tr('room.extra.412'),
        )}
        onclick={() => setClassOver(!session.finished)}
      >
        {session.finished ? tr('room.ui.909') : tr('room.ui.933')}
      </button>
    </div>
    <!--
      On the second line — what is visible from the hall.

      Tightening a rule takes effect before other browsers learn about it: a
      frame that left before the broadcast is no longer accepted by the gate,
      and such a tab has to rebuild the document with a reload (see
      `lib/refusal.ts`). Whoever was typing in that very second falls into this
      window — and they will see the "Edit not saved" window. Promising them
      otherwise means explaining to them later what broke.
    -->
    <p class="shrink-0 border-t border-line px-4 py-2 text-2xs text-muted"> {tr('room.ui.934')} </p>
  </div>
{/if}

<!--
  The tab has diverged from the server and no longer tries by itself — see
  SessionState.stuck.
  A strip, not a toast: a toast gets closed with the cross, and one is left
  with a dead notebook that looks alive. The only action is a reload by hand,
  and it starts the reload count anew.

  Not on the console: there ConsoleView itself speaks about the divergence —
  in its own words, in its own finger-sized type and with the promise that
  the lecture has not been interrupted. Otherwise the same thing would be
  said twice: its sheet inside the console wrapper and this strip over it.
-->
{#if session.stuck && !session.gone && !pult}
  <!-- And over the projection too (z-90). Until now it lay under it: after the
       second cache refusal the projector was left with a frozen page and no
       reason on screen. A strip at the bottom, not a full-screen plate: the
       room under it is still readable, and the lecture on the projector is
       still visible to the hall. -->
  <div
    class="fixed inset-x-0 bottom-0 z-[100] flex justify-center border-t border-line bg-raised px-4 py-3
           pb-[max(0.75rem,env(safe-area-inset-bottom))]"
    role="alert"
  >
    <div class="flex w-full max-w-2xl items-center gap-3">
      <span class="h-1.5 w-1.5 shrink-0 rounded-full bg-danger"></span>
      <p class="min-w-0 flex-1 text-ui leading-snug text-ink">{session.stuck}</p>
      <button type="button" class="btn-primary shrink-0" onclick={() => reloadByHand()}> {tr('room.ui.151')} </button>
    </div>
  </div>
{/if}

<!--
  ONE notification stack per room.

  There used to be five independent `{#if}`s here with the same coordinates —
  bottom-4, centred — and two at once overlapped letter over letter. Not a
  rare case, and the worst possible one: the teacher tightened a rule (the
  line lives six seconds), a student pressed Run in the same second and got a
  red refusal line — right over the explanation of why they were refused.

  The order in the column is bottom-up by importance: the error at the very
  edge, where it was when it stood alone; calm announcements stack above it.
  Each line arrives and leaves with its own animation, the stack only keeps
  them in a row.

  Below — the same bottom insets: with `viewport-fit=cover` (index.html) four
  pixels under the home indicator mean the cross ends up under the system
  swipe. And the same lift over the "diverged from the server" strip: it
  takes the whole edge, and the stack has nowhere to sit on it.

  The console and the projection draw their lines themselves and in their
  own way: the console has its own, in Russian and without a cross under the
  palm, and on the projector any plate that pops up is a plate the whole
  hall reads.
-->
{#if !session.gone && !pult && !projection}
  <div
    class={cn(
      'pointer-events-none fixed inset-x-0 z-50 flex flex-col items-center gap-2 px-4',
      'pb-[env(safe-area-inset-bottom)]',
      session.stuck ? 'bottom-[4.75rem]' : 'bottom-4',
    )}
  >
    <!--
      The console was closed while the lecture goes on.

      Leaving the console is not the end of the class, and it has to be
      announced exactly once: without the line, a person who missed a button
      looks for the vanished lecture, not for the way back. The button sits
      next to the phrase, because one needs to return HERE and NOW — there is
      no other way from the room to the console: nobody remembers its address,
      and the key link would have to be requested again.
    -->
    {#if pultNoticeUp}
      <div
        role="status"
        class={cn(TOAST, 'items-center py-1.5 pl-3 pr-1.5')}
        transition:fly={{ y: prefersReducedMotion() ? 0 : 8, duration: 140, easing: quintOut }}
      >
        <span class="h-1.5 w-1.5 shrink-0 rounded-full bg-accent"></span>
        <p class="min-w-0 flex-1 text-ui leading-snug text-muted">{tr('room.ui.935')}</p>
        <button
          class="btn-ghost h-6 px-2 text-2xs font-bold uppercase tracking-label"
          onclick={toPult}
        > {tr('room.ui.936')} </button>
      </div>
    {/if}

    <!--
      The rules changed — one line, and it leaves by itself.

      Twenty people whose editors suddenly became "read only" without a single
      phrase will decide their laptops broke. The line is calm, not like an
      error: it is not a breakage but the teacher's decision, and it is said
      exactly once.
    -->
    {#if rulesNoticeUp}
      <div
        role="status"
        class={cn(TOAST, 'items-center px-3 py-1.5')}
        transition:fly={{ y: prefersReducedMotion() ? 0 : 8, duration: 140, easing: quintOut }}
      >
        <span class="h-1.5 w-1.5 shrink-0 rounded-full bg-accent"></span>
        <p class="min-w-0 flex-1 text-ui leading-snug text-muted"> {tr('room.ui.937')} </p>
      </div>
    {/if}

    <!--
      The class ended — or started again. With the same six seconds and the
      same calm tone as the rules line: it is not a breakage but the teacher's
      decision, and it has to be said exactly once. What there was and still
      is — the notebook, the files, the feed — is in the phrase itself: the
      buttons go dark, not the room.
    -->
    {#if classNoticeUp}
      <div
        role="status"
        class={cn(TOAST, 'items-center px-3 py-1.5')}
        transition:fly={{ y: prefersReducedMotion() ? 0 : 8, duration: 140, easing: quintOut }}
      >
        <span class="h-1.5 w-1.5 shrink-0 rounded-full bg-accent"></span>
        <p class="min-w-0 flex-1 text-ui leading-snug text-muted">
          {#if session.finished} {tr('room.ui.938')} {:else} {tr('room.ui.939')} {/if}
        </p>
      </div>
    {/if}

    <!-- The kernel did not start and the presenter can fix it: error tone, until closed. -->
    {#if adviceUp}
      <div
        role="status"
        class={cn(TOAST, 'items-start py-2 pl-3 pr-1.5')}
        transition:fly={{ y: prefersReducedMotion() ? 0 : 8, duration: 140, easing: quintOut }}
      >
        <span class="mt-[7px] h-1.5 w-1.5 shrink-0 rounded-full bg-danger"></span>
        <p class="min-w-0 flex-1 break-words py-0.5 text-ui leading-snug text-muted">{kernelAdvice}</p>
        <button
          class="btn-ghost h-6 w-6 shrink-0 px-0"
          onclick={() => (adviceDismissed = kernelAdvice)}
          aria-label={tr('room.ui.941')}
        >
          <Icon name="x" size={14} />
        </button>
      </div>
    {/if}

    <!-- The cache was older than the server, the tab rebuilt itself, no text was lost. -->
    {#if staleNotice}
      <div
        role="status"
        class={cn(TOAST, 'items-start py-2 pl-3 pr-1.5')}
        transition:fly={{ y: prefersReducedMotion() ? 0 : 8, duration: 140, easing: quintOut }}
      >
        <span class="mt-[7px] h-1.5 w-1.5 shrink-0 rounded-full bg-faint"></span>
        <p class="min-w-0 flex-1 break-words py-0.5 text-ui leading-snug text-muted"> {tr('room.ui.940')} </p>
        <button
          class="btn-ghost h-6 w-6 shrink-0 px-0"
          onclick={() => (staleNotice = false)}
          aria-label={tr('room.ui.941')}
        >
          <Icon name="x" size={14} />
        </button>
      </div>
    {/if}

    <!-- The error sits at the very edge: it is the only line saying that a
         press did NOT work, and it has to be read first. -->
    {#if session.lastError}
      <div
        role="status"
        class={cn(TOAST, 'items-start py-2 pl-3 pr-1.5')}
        transition:fly={{ y: prefersReducedMotion() ? 0 : 8, duration: 140, easing: quintOut }}
      >
        <span class="mt-[7px] h-1.5 w-1.5 shrink-0 rounded-full bg-danger"></span>
        <p class="min-w-0 flex-1 break-words py-0.5 text-ui leading-snug text-muted">
          {tr(session.lastError)}
        </p>
        <button
          class="btn-ghost h-6 w-6 shrink-0 px-0"
          onclick={() => session.dismissError()}
          aria-label={tr('room.ui.941')}
        >
          <Icon name="x" size={14} />
        </button>
      </div>
    {/if}
  </div>
{/if}

<!-- One scrolling rail: the artboards stack both groups at the top of the
     column, and each brings its own header rule, so there is nothing between
     them but the 24px the panels already carry. -->
{#snippet leftPanels()}
  <div class="flex min-h-0 flex-1 flex-col overflow-y-auto">
    <FilesPanel
      onopen={openFile}
      active={activePath}
      onrename={(from, to) => tabs.rename(from, to)}
      onrun={runFile}
    />
    <PeoplePanel />
  </div>
{/snippet}

<style>
  /*
   * The seminar name is a heading that happens to be editable, so it has to be
   * exactly as wide as its text — a field at its default width would leave the
   * date stranded in the middle of the band. Chrome sizes it from the content;
   * anywhere else the input keeps the old behaviour and takes the row, which
   * still reads correctly, just with the date at the far edge.
   */
  .name-field {
    field-sizing: content;
    max-width: 100%;
  }

  @supports not (field-sizing: content) {
    .name-field {
      flex: 1 1 auto;
    }
  }
</style>
