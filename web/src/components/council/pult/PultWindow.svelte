<script module lang="ts">
  /**
   * The list tab survives the window's remount — and only the tab does.
   *
   * Switching cells mounts the console anew ({#key councilCell} in
   * SessionScreen), and on purpose: the remount clears nine window states at
   * once — what was read, letter drafts, the "new" set, held submissions, the
   * freeze moment, the list snapshot, the moment of opening, what was
   * expanded, and the cursor. Everything listed is TIED TO THE PEOPLE of this
   * cell, and dragging it into the next one would mean writing a letter to
   * the wrong person.
   *
   * The tab is the only thing not tied to the cell: "I am reviewing what was
   * submitted now" or "I am watching those who are writing" is a way of
   * running a class, not a property of a cell, and choosing it anew on every
   * switch means losing the place you are looking at. So it lives in a
   * module variable: that survives the remount and dies with the window,
   * which is what was wanted.
   *
   * The filter (chips) stays resettable, as it was: its numbers are counted
   * for THIS cell ("Ungraded 9"), and carried into a neighbouring cell it
   * would promise a filter that nobody there may match.
   */
  let lastTab: 'submitted' | 'writing' | 'all' = 'submitted'
</script>

<script lang="ts">
  import { tr } from '@shared/i18n'
  import './pult.css'
  /** Private teacher console: work, execution queue and class summary share
   * the room connection. Only explicit projection actions change the class screen. */
  import { tick, untrack } from 'svelte'
  import {
    DEFAULT_COUNCIL,
    allBooks,
    allCellArrays,
    cellId as idOf,
    cellLock,
    cellType,
    rootOfCell,
    type CouncilSettings,
  } from '@shared/notebook'
  import { baseOf } from '@shared/paths'
  import type { CouncilAttempt } from '@shared/protocol'
  import type { ReasoningEffort } from '@shared/admin'
  import { api } from '@/lib/api'
  import { askToBan, banTargetOf } from '@/lib/bans'
  import { OFFLINE_REASON } from '@/lib/controls'
  import {
    cellHeadline,
    filterCounts,
    filterInTab,
    heldArrivals,
    holdsArrivals,
    kernelView,
    listRows,
    markdownHeadline,
    moveCursor,
    neighbourCell,
    pultCells,
    pultKeyAction,
    pultShortcutAllowed,
    type PultView,
    pultPresence,
    rulesSentence,
    runStats,
    selectable,
    tabCounts,
    unreadIds,
    variantNumbers,
    type PultCellRow,
    type PultFilter,
    type PultFocus,
    type PultRule,
    type PultTab,
  } from '@/lib/council-pult'
  import { boardPhase, WELCOME_WAIT_MS } from '@/lib/council.svelte'
  import { announcePult, availScreen, savePultPlace, savesPlace } from '@/lib/council-pult-window'
  import { getSessionState } from '@/lib/session.svelte'
  import { cn, spell } from '@/lib/utils'
  import Splash from '@/components/ui/Splash.svelte'
  import PultFilters from './PultFilters.svelte'
  import PultHeader from './PultHeader.svelte'
  import PultKeys from './PultKeys.svelte'
  import PultList from './PultList.svelte'
  import PultOnScreen from './PultOnScreen.svelte'
  import PultOracleTab from './PultOracleTab.svelte'
  import PultQueueStrip from './PultQueueStrip.svelte'
  import PultRules from './PultRules.svelte'
  import PultStatusLine from './PultStatusLine.svelte'
  import PultWork from './PultWork.svelte'

  interface Props {
    cellId: string
    /**
     * Go to another council cell — IN THIS SAME WINDOW.
     *
     * By address, not by assignment: there is one window per room
     * (`pultWindowName`), and its address must name the cell that is visible
     * — otherwise the "to phone" link would lead to another one, and
     * reloading the window would return somewhere other than where you were.
     * As a bonus, "back" returns to the previous cell without knowing
     * anything about it.
     */
    onpick: (cellId: string) => void
    /** Back to the notebook: close the separate window or go to the room's address. */
    onexit: () => void
  }

  let { cellId, onpick, onexit }: Props = $props()

  const session = getSessionState()
  const host = $derived(session.me.role === 'host')
  let rosterReady = $state(false)
  $effect(() => {
    const provider = session.provider
    const sync = (ready: boolean): void => { rosterReady = ready }
    sync(provider.synced)
    provider.on('sync', sync)
    return () => provider.off('sync', sync)
  })
  const presenceKnown = $derived(session.connected && rosterReady)

  /* ---------------------------------------------------------- window */

  // A knock to the neighbouring window: by it the button under the cell knows
  // that the window is alive.
  $effect(() => announcePult(session.session.id, cellId))

  /**
   * The window's place — per room, on a best-effort basis.
   *
   * The browser has no "window moved" event; `resize` catches only the size,
   * and a move to a second monitor catches nothing. Once a second is
   * accurate enough to open in the same place the second time, and cheap:
   * four reads.
   *
   * BUT ONLY FROM OUR OWN WINDOW. The console is opened not only by the
   * button: its link is pasted into the address bar, sent to one's phone,
   * left in a tab. In such a console `outerWidth/Height` is the size of
   * SOMEONE ELSE'S whole window, and once written it asked the next
   * `window.open` for a full-screen popup from point 0,0 — that is, a window
   * indistinguishable from a tab. One such visit poisoned the memory for
   * good: every following opening confirmed it.
   *
   * The sign of our own window is `window.opener`: it is set by the same
   * `window.open` that asked for this place. A second barrier (a full-screen
   * place) sits inside `savePultPlace` — for when the window is ours but was
   * maximised by hand.
   */
  const ownWindow = (): boolean => {
    try {
      return Boolean(window.opener)
    } catch {
      // An opener from another origin cannot be read — but it is there.
      return true
    }
  }
  $effect(() => {
    const id = session.session.id
    if (!ownWindow()) return
    const timer = setInterval(() => {
      const place = {
        left: window.screenX,
        top: window.screenY,
        width: window.outerWidth,
        height: window.outerHeight,
      }
      if (savesPlace(place, availScreen(), ownWindow())) savePultPlace(id, place)
    }, 1000)
    return () => clearInterval(timer)
  })

  /** The window's live clock: the "running 3.1 s" and "in frame 1:40" counters. */
  let now = $state(Date.now())
  $effect(() => {
    const timer = setInterval(() => (now = Date.now()), 1000)
    return () => clearInterval(timer)
  })

  /* ------------------------------------------------------------- phone */

  /**
   * A narrow window — two screens instead of two columns.
   *
   * The console was tried from a phone in the 19 Sep 2026 class: "it is
   * impossible to scroll the list of all students". Two columns 390 px wide
   * are a list half a row tall under the header, the tabs, the strip, the
   * counters, the search and the chips. A messenger is built the same way
   * everywhere here, and for a reason: first a full-screen list, a press
   * opens a full-screen conversation, back returns to the list.
   *
   * The threshold is the same as for the other narrow-window rules (650 px),
   * and it is read through matchMedia, not from the width in resize:
   * `matchMedia` has the same threshold as the CSS, and the two cannot drift
   * apart.
   */
  let phone = $state(false)
  $effect(() => {
    const query = window.matchMedia('(max-width: 650px)')
    const sync = (): void => { phone = query.matches }
    sync()
    query.addEventListener('change', sync)
    return () => query.removeEventListener('change', sync)
  })
  let phonePane = $state<'list' | 'work'>('list')

  /**
   * The system "back" returns to the list rather than closing the console.
   *
   * The address does not change: the console's route is the cell
   * (routes.ts), not what is being looked at in it, and giving the work
   * screen a second address would mean the console link sometimes opens as
   * the list and sometimes as someone's work. So the history entry is our
   * own, with the same address and a mark in the state; the "back" gesture
   * removes it, and `popstate` brings the list back.
   */
  function toWork(): void {
    if (!phone || phonePane === 'work') return
    phonePane = 'work'
    history.pushState({ ...(history.state ?? {}), pultPane: 'work' }, '', location.href)
  }
  function toList(): void {
    if (phonePane !== 'work') return
    // Through history, not by assignment: otherwise the work entry would stay
    // in the stack, and the next "back" would leave the console via an empty
    // step.
    history.back()
  }
  $effect(() => {
    const back = (): void => { phonePane = 'list' }
    window.addEventListener('popstate', back)
    return () => window.removeEventListener('popstate', back)
  })

  /* ------------------------------------------------------------ room */

  const board = $derived(session.council.boards[cellId] ?? null)
  const shown = $derived(session.council.shown[cellId] ?? null)
  const settings = $derived<CouncilSettings>(board?.settings ?? DEFAULT_COUNCIL)
  const names = $derived(settings.namesOnProjector)
  const attempts = $derived(board?.attempts ?? [])
  const variants = $derived(variantNumbers(attempts))
  // The pile answers for THIS cell, the kernel frame for the queue of the
  // whole notebook: without the latter the console wrote "nothing is running
  // here" next to "in the queue: 12".
  const kernel = $derived(kernelView(attempts, session.council.kernels[cellId] ?? null))
  const counts = $derived(board?.counts ?? { attempts: 0, submitted: 0, writing: 0, groups: 0 })
  const offline = $derived(!session.connected)
  const disabled = $derived(offline || !host)


  /**
   * Where the cells stand in the document: number and notebook, by id.
   *
   * The number is live — cells are reordered and deleted right during a
   * council — and the notebook is needed by the picker: numbers are unique
   * WITHIN a notebook, and two "cell 03"s from different files could not
   * otherwise be told apart.
   *
   * The walk is coalesced: `afterTransaction` arrives on every keystroke in
   * the room, and walking all the notebooks means all their cells. A delay
   * of a third of a second in a cell number is visible to nobody, and thirty
   * walks a second with a full class do not happen.
   */
  interface CellPlace {
    index: number
    book: string
    /** The task name — the cell's first line or the markdown heading above it. */
    title: string
    /**
     * The cell's lock in the DOCUMENT: it arrives by its own channel, before
     * or after the socket.
     */
    council: boolean
  }
  let places = $state.raw<ReadonlyMap<string, CellPlace>>(new Map())
  $effect(() => {
    const doc = session.doc
    const build = (): void => {
      const next = new Map<string, CellPlace>()
      const books = allBooks(doc)
      const lists =
        books.length > 0
          ? books.map(({ book, cells }) => ({ name: baseOf(book.path), cells }))
          : allCellArrays(doc).map((cells) => ({ name: '', cells }))
      for (const { name, cells } of lists) {
        const all = cells.toArray()
        /*
         * The heading of the nearest markdown cell ABOVE — for when a cell
         * starts with code. A task statement in a notebook more often stands
         * as a separate cell above the code than as a comment inside it, and
         * "imp = clf.feature_importances_" in the menu is worse than an
         * honest "cell 03".
         *
         * The text is read for all cells, not only council ones: which of
         * them are council cells is known not by the document but by the
         * piles, and asking them from here would mean rebuilding this walk on
         * every network frame. The walk is already thinned to once every
         * third of a second, and the first lines are what Y.Text keeps in
         * memory anyway.
         */
        let above = ''
        for (let at = 0; at < all.length; at += 1) {
          const cell = all[at]
          const text = String(cell.get('source') ?? '')
          const council = cellLock(cell) === 'council'
          if (cellType(cell) === 'markdown') {
            const heading = markdownHeadline(text)
            if (heading) above = heading
            next.set(idOf(cell), { index: at + 1, book: name, title: heading, council })
            continue
          }
          next.set(idOf(cell), { index: at + 1, book: name, title: cellHeadline(text) || above, council })
        }
      }
      places = next
    }
    let timer: ReturnType<typeof setTimeout> | null = null
    const refresh = (): void => {
      if (timer !== null) return
      timer = setTimeout(() => {
        timer = null
        build()
      }, 300)
    }
    build()
    doc.on('afterTransaction', refresh)
    return () => {
      if (timer !== null) clearTimeout(timer)
      doc.off('afterTransaction', refresh)
    }
  })
  /**
   * The room's council cells — the list behind the number in the header.
   *
   * The source is the piles (`session.council.boards`): the server sends the
   * teacher a pile for EVERY cell where a council is going on or where
   * attempts remain (control.ts · councilWelcome), and everything a menu row
   * needs is already here. A cell whose council was taken off does not leave
   * the list — it gets a "review only" mark: submitted work is looked at
   * until the end of the class.
   */
  const cells = $derived<PultCellRow[]>(
    pultCells(
      Object.entries(session.council.boards).map(([id, one]) => ({
        cellId: id,
        index: places.get(id)?.index ?? null,
        title: places.get(id)?.title ?? '',
        book: places.get(id)?.book ?? '',
        lock: one.lock,
        counts: one.counts,
        room: session.council.counts[id] ?? null,
        attempts: one.attempts,
        onScreen: (session.council.shown[id] ?? null) !== null,
      })),
    ),
  )

  /**
   * A watchman for the welcome batch: wait for the first frame — but not
   * forever.
   *
   * The signal might not arrive at all (a server older than the
   * `council:ready` frame, a lost frame), and then the console would stand
   * under the splash until a reload. After WELCOME_WAIT_MS the wait ends,
   * and the window shows what it knows.
   */
  let waited = $state(false)
  $effect(() => {
    const timer = setTimeout(() => (waited = true), WELCOME_WAIT_MS)
    return () => clearTimeout(timer)
  })
  /**
   * Waiting · not there · here it is — instead of a single `board === null`.
   *
   * The window is drawn before the pile's first frame, and `null` meant two
   * different facts at once: "the frame is still on its way" and "there is
   * no council here". The console chose the latter and on every reload
   * managed to flash "the cell is not in a council" right between the app's
   * splash and itself. The whole rule is in council.svelte.ts · boardPhase;
   * its four inputs meet here, including the lock from the DOCUMENT: the
   * CRDT and the socket are different channels, and a document that already
   * knows about the council argues with the socket's silence.
   */
  const phase = $derived(
    boardPhase({
      board,
      settled: session.council.welcomed || waited,
      connected: session.connected,
      council: places.get(cellId)?.council === true,
    }),
  )

  /* ------------------------------------------------------ screen state */

  /**
   * The list tab and the filter within it.
   *
   * EACH tab has its OWN filter: "Ungraded" and "Silent" answer different
   * questions, and one chip for three piles would mean that switching tabs
   * silently changes the filter too. The tab starts from the one it was left
   * on in the previous cell (the `lastTab` module variable above), the
   * filter always from "All".
   */
  let listTab = $state<PultTab>(lastTab)
  $effect(() => {
    lastTab = listTab
  })
  let filters = $state<Record<PultTab, PultFilter>>({ submitted: 'all', writing: 'all', all: 'all' })
  const filter = $derived(filterInTab(listTab, filters[listTab]))
  let search = $state('')
  let searching = $state(false)
  let cursor = $state<string | null>(null)
  /** Came from the keyboard: only then does a row get a focus ring. */
  let keyboard = $state(false)
  /** Whose rows have been opened: the unread dot goes out and does not come back. */
  let seen = $state.raw<ReadonlySet<string>>(new Set())
  let tab = $state<PultView>('work')
  /**
   * Which screen is shown on a phone; on a wide window both are visible.
   *
   * The queue and the oracle are drawn over the whole "list/work" layer, so
   * outside the work tab the screen is always "list": otherwise coming back
   * from the queue would open someone's work without the bar it is closed
   * with.
   */
  const pane = $derived(!phone ? 'both' : tab === 'work' ? phonePane : 'list')
  let helpOpen = $state(false)
  /**
   * The rules sheet: which rule it is open on and where to return focus.
   *
   * The rule is stored together with the "open" flag, because the sheet is
   * always opened FOR a rule — from the sentence in the header, from the run
   * line, from a key; that rule's row is highlighted, and focus stands on
   * it. The element to return to is remembered by whoever opens it: the
   * button in the header and the "limit 30 s" link in the work are
   * different places, and "return focus to where it was" means exactly
   * there, not to the first one that comes along.
   */
  let rulesOpen = $state(false)
  let rulesRule = $state<PultRule>('studentRun')
  /** The header sentence and limit stats — on demand: the sheet is mostly closed. */
  const sentence = $derived(rulesSentence(settings))
  const stats = $derived(runStats(attempts))
  let rulesBack: HTMLElement | null = null
  /**
   * The header's height: the sheet drops from its bottom. It changes with
   * the window width and the length of the name.
   */
  let headHeight = $state(0)
  let focus = $state<PultFocus>('list')
  type ReplyDraft = { text: string; fromOracle: boolean }
  // A draft belongs to its recipient, even when filters or live arrivals move the cursor.
  let oracleError = $state('')
  let replyDrafts = $state<Record<string, ReplyDraft>>({})
  const reply = $derived(cursor ? (replyDrafts[cursor]?.text ?? '') : '')
  const replyFromOracle = $derived(Boolean(cursor && replyDrafts[cursor]?.fromOracle))

  function updateReply(patch: Partial<ReplyDraft>): void {
    if (!cursor || !current) return
    replyDrafts[cursor] = { text: reply, fromOracle: replyFromOracle, ...patch }
  }
  /** When the console opened: anything submitted earlier does not count as unread. */
  const openedAt = Date.now()

  /**
   * Held submissions.
   *
   * `frozenAt` is the moment from which the list stopped letting new ones
   * in: it is set not by a timer but by the very first arrival that happens
   * while the person is reading. `null` — the list is open, everything goes
   * in at once.
   */
  let frozenAt = $state<number | null>(null)
  let held = $state.raw<ReadonlySet<string>>(new Set())

  const unread = $derived(unreadIds(attempts, openedAt, seen))

  /**
   * The set of rows for the "new" filter — the one that does NOT MELT under
   * the cursor.
   *
   * The unread dot goes out as soon as a row is opened. If the "new" filter
   * read the live set, it would strike out a row exactly when someone began
   * reading it: the cursor moves to the next one and puts that out too — and
   * the list empties itself within a second while the person looks at the
   * first piece of work. So while the chip is pressed the set only grows,
   * and it is cleared on leaving the filter: back in "new", it is again
   * those who submitted since then.
   */
  let newPool = $state.raw<ReadonlySet<string>>(new Set())
  $effect(() => {
    const live = unread
    const at = filter
    untrack(() => {
      if (at !== 'new') {
        if (newPool.size > 0) newPool = new Set()
        return
      }
      const next = new Set(newPool)
      let grew = false
      for (const id of live) if (!next.has(id)) (next.add(id), (grew = true))
      if (grew) newPool = next
    })
  })

  const rows = $derived(
    listRows({
      attempts,
      tab: listTab,
      filter,
      search: names ? search : '',
      unread: filter === 'new' ? newPool : unread,
      held,
      now,
    }),
  )
  /** Numbers on the tabs and chips — by the same sieve the list filters with. */
  const tabs = $derived(tabCounts(attempts))
  const chips = $derived(filterCounts(attempts, listTab, filter === 'new' ? newPool : unread, now))
  const ids = $derived(selectable(rows))
  const current = $derived<CouncilAttempt | null>(
    attempts.find((attempt) => attempt.participantId === cursor) ?? null,
  )
  const place = $derived(cursor === null ? 0 : ids.indexOf(cursor) + 1)

  /**
   * The cursor always stands on a live row.
   *
   * The filter changed, the author was removed from the room, a group was
   * collapsed — the row under the cursor is gone, and the right column would
   * show a piece of work not visible in the list. Move to the first one; an
   * empty list leaves an empty cursor.
   */
  $effect(() => {
    const list = ids
    const at = untrack(() => cursor)
    if (at !== null && list.includes(at)) return
    cursor = list[0] ?? null
  })

  /** Only a work actually visible to the teacher counts as read. */
  $effect(() => {
    if (tab !== 'work') return
    const at = cursor
    if (at === null) return
    untrack(() => {
      if (seen.has(at)) return
      seen = new Set(seen).add(at)
    })
  })

  /**
   * Whether to hold new submissions.
   *
   * The strip appears when the list is scrolled or the cursor is not on the
   * first row. The row under the cursor never moves — even if its author
   * submitted again.
   */
  let scrolled = $state(false)
  let standing = $state.raw<ReadonlySet<string>>(new Set())
  $effect(() => {
    const atTop = cursor === ids[0]
    const away = scrolled || tab !== 'work'
    untrack(() => {
      if (!holdsArrivals(away, atTop)) {
        frozenAt = null
        return
      }
      if (frozenAt === null) {
        // Capture BEFORE the next board frame. Reading live ids after an arrival
        // would already include that arrival and could never hold it back.
        standing = new Set(attempts.filter((attempt) => attempt.submittedAt !== null && ids.includes(attempt.participantId)).map((attempt) => attempt.participantId))
        frozenAt = Date.now()
      }
    })
  })
  $effect(() => {
    const list = attempts
    const since = frozenAt
    const snapshot = standing
    untrack(() => {
      const next = since === null ? new Set<string>() : heldArrivals(list, since, snapshot, cursor)
      if (next.size !== held.size || [...next].some((id) => !held.has(id))) held = next
    })
  })

  function release(): void {
    frozenAt = null
    held = new Set()
    document.querySelector('[data-pult-scroll]')?.scrollTo({ top: 0 })
    scrolled = false
  }

  /**
   * The open work's output that did not come with the pile — ask for it
   * separately.
   *
   * The memory of what has already been asked for lives in
   * `CouncilState.wantOutputs`: a full pile frame resets it, and a second
   * copy of the rule would diverge from the first on the very first
   * reconnect.
   */
  $effect(() => {
    const attempt = current
    if (attempt?.run?.outputsOmitted) session.council.wantOutputs(cellId, attempt.participantId)
  })

  /* ------------------------------------------------------------ actions */

  function open(participantId: string): void {
    cursor = participantId
    keyboard = false
    tab = 'work'
    // On a phone, opening a piece of work means going to its full screen.
    toWork()
  }

  /** The ‹ › arrows on a phone: through the feed, like j and k on a keyboard. */
  function step(delta: 1 | -1): void {
    const next = moveCursor(rows, cursor, delta)
    if (next !== null) cursor = next
  }

  function show(participantId: string | null = cursor): void {
    if (disabled || participantId === null) return
    const attempt = attempts.find((one) => one.participantId === participantId)
    // A draft is not shown to the class: the person is still writing, and the
    // wall would get half a thought they do not answer for.
    if (!attempt || attempt.submittedAt === null) return
    session.council.show(cellId, participantId)
  }

  function clearShown(): void {
    if (disabled) return
    session.council.clearShown(cellId)
  }

  function run(participantId: string | null = cursor): void {
    if (disabled || participantId === null) return
    session.council.run(cellId, participantId)
  }

  function interrupt(): void {
    if (disabled) return
    session.send({ t: 'interrupt', cellId })
  }

  /**
   * Restarting the kernel — the kernel of THE notebook this cell is in.
   *
   * A kernel per notebook, not per room (kernel/index.ts), and a restart
   * from the console must hit the same one that runs this cell's attempts:
   * otherwise it would wipe the variables of a neighbouring notebook that
   * nothing was wrong with.
   */
  function restartKernel(): void {
    if (disabled) return
    session.send({ t: 'restart', book: rootOfCell(session.doc, cellId) ?? undefined })
  }

  /** Take a waiting run out of the queue — not touching the person or their text. */
  function dropRun(attempt: CouncilAttempt): void {
    if (disabled || attempt.run?.state !== 'queued') return
    session.council.dropRun(cellId, attempt.participantId)
  }

  function mark(correct: boolean): void {
    if (disabled || !current) return
    session.council.mark(cellId, current.participantId, current.correct === correct ? null : correct)
  }

  function letThrough(attempt: CouncilAttempt): void {
    const request = attempt.runRequest
    if (disabled || request?.status !== 'pending') return
    session.council.approveRunRequest(cellId, attempt.participantId, request.id)
  }

  function declineRun(attempt: CouncilAttempt): void {
    const request = attempt.runRequest
    if (disabled || request?.status !== 'pending') return
    session.council.declineRunRequest(cellId, attempt.participantId, request.id)
  }

  function approveAll(): void {
    if (disabled) return
    for (const attempt of kernel.pending) letThrough(attempt)
  }

  /**
   * A rules setting — in the same frame as the cell's lock.
   *
   * There is no "council setting" frame and there will not be one: the
   * controls travel in `cell:lock` together with the lock position
   * (council.svelte.ts · lock), and the server puts them into the same
   * history version. Pressing an already chosen value again is not sent: it
   * is not an event but an extra version on every click.
   */
  function setRule(patch: Partial<CouncilSettings>): void {
    if (disabled) return
    const changed = Object.entries(patch).some(
      ([key, value]) => settings[key as keyof CouncilSettings] !== value,
    )
    if (!changed) return
    session.council.lock(cellId, 'council', patch)
  }

  function openRules(rule: PultRule, from: HTMLElement | null = null): void {
    rulesBack = from
    rulesRule = rule
    rulesOpen = true
  }

  function closeRules(): void {
    rulesOpen = false
    const back = rulesBack
    rulesBack = null
    // The button may have disappeared together with its piece of the
    // sentence: students were forbidden to run — "repeat …" left the line.
    // Then focus goes to the rules' name: it is there at any width and in any
    // state.
    void tick().then(() =>
      (back?.isConnected ? back : document.querySelector<HTMLElement>('[data-pult-rules-open]'))?.focus(),
    )
  }

  /**
   * A letter goes to THE AUTHOR OF THE OPEN WORK, and it has no other
   * recipient any more.
   *
   * There used to be an "Everyone N" button next to it: the same letter went
   * to the whole group of identical answers, with an oracle draft attached.
   * Grouping left the console entirely (20 Sep 2026), and the group letter
   * went with it: no replacement was invented.
   */
  function sendReply(): void {
    const text = reply.trim()
    if (disabled || !text || text.length > 3000 || !current) return
    session.council.reply(cellId, { participantId: current.participantId }, text)
    updateReply({ text: '', fromOracle: false })
  }

  /**
   * Remove the author of a piece of work or of a queue entry from the class.
   *
   * The shared ban menu asks (components/panels/BanMenu.svelte) — it lives
   * in this same window and lists the consequences. The name and id are
   * taken from the attempt even with names off: "Answer 12" cannot be
   * removed, a person is.
   */
  function remove(attempt: CouncilAttempt, event: MouseEvent): void {
    if (disabled) return
    askToBan(banTargetOf(attempt, event))
  }

  /**
   * The oracle about the class — through the same route as in the notebook.
   *
   * `question` is a free-form question about the state of the class;
   * without it the server prepares the old summary of solutions
   * (server/src/routes/council.ts).
   */
  async function askOracle(
    stop: boolean,
    question?: string,
    effort?: ReasoningEffort,
  ): Promise<void> {
    oracleError = ''
    try {
      if (stop) await api.councilStopOracle(session.session.id, session.token, cellId)
      else await api.councilAsk(session.session.id, session.token, cellId, question, effort)
    } catch (error) {
      oracleError = error instanceof Error ? error.message : tr('room.pult.oracleError')
    }
  }

  /* ------------------------------------------------------------- keys */

  /**
   * Where the focus is, by the element under it: the reply field — its own
   * keys; the search — the arrows keep moving through the list; a button —
   * Enter presses the button.
   */
  function where(target: EventTarget | null): PultFocus {
    const node = target instanceof HTMLElement ? target : null
    if (!node) return 'list'
    if (node.closest('[data-pult-reply], [data-pult-work-scroll] [role=region]')) return 'reply'
    if (node.closest('[data-pult-row]') && node.hasAttribute('data-pult-select')) return 'list'
    if (node.closest('[data-pult-search]')) return 'search'
    if (node.matches('input, textarea, select') || node.isContentEditable) return 'reply'
    if (node.tagName === 'BUTTON' || node.closest('[data-pult-actions]')) return 'actions'
    return 'list'
  }

  function onkeydown(event: KeyboardEvent): void {
    if (event.defaultPrevented || event.isComposing) return
    if (helpOpen) {
      if (event.key === 'Escape' || event.key === '?') {
        event.preventDefault()
        helpOpen = false
      }
      return
    }
    /*
     * An open sheet takes the keyboard entirely.
     *
     * Otherwise j and k would move through the list behind the dimming, and
     * Esc would close the search along with the sheet. Inside the sheet life
     * is its own: Tab cycles, space presses a button.
     */
    if (rulesOpen) {
      if (event.key === 'Escape') {
        event.preventDefault()
        closeRules()
      }
      return
    }
    const at = where(event.target)
    focus = at
    const action = pultKeyAction(
      { key: event.key, shift: event.shiftKey, meta: event.metaKey, ctrl: event.ctrlKey, alt: event.altKey, composing: event.isComposing },
      at,
    )
    const inNavigation = event.target instanceof HTMLElement && Boolean(event.target.closest('[data-pult-nav]'))
    const inOverlay = event.target instanceof HTMLElement && Boolean(event.target.closest('[role=menu], [role=dialog], [role=alertdialog]'))
    if (action === null || !pultShortcutAllowed(action, tab, inNavigation, inOverlay)) return
    if (action === 'send') {
      // Sending is handled by the field itself: ⌘↵ inside the textarea is
      // already caught there.
      return
    }
    event.preventDefault()
    if (event.repeat && !['next', 'prev'].includes(action)) return
    switch (action) {
      case 'next':
      case 'prev':
        cursor = moveCursor(rows, cursor, action === 'next' ? 1 : -1)
        keyboard = true
        tab = 'work'
        void scrollToCursor(at !== 'search')
        return
      /*
       * A neighbouring cell — by THE SAME transition as a choice from the
       * menu.
       *
       * That is, by address (`onpick`), not by assignment: there is one
       * window per room, and its address must name the cell that is visible
       * — otherwise the "to phone" link would lead to another one, and a
       * reload would return somewhere other than where you were. The order
       * is the same as in the menu (`cells`), and nothing happens at the
       * edges: wrapping around would take the console from the first cell to
       * the last without saying so.
       */
      case 'nextCell':
      case 'prevCell': {
        const next = neighbourCell(cells, cellId, action === 'nextCell' ? 1 : -1)
        if (next !== null) onpick(next)
        return
      }
      case 'search':
        tab = 'work'
        searching = true
        void tick().then(() => document.querySelector<HTMLInputElement>('[data-pult-search]')?.focus())
        return
      case 'show':
        show()
        return
      case 'run':
        run()
        return
      case 'correct':
        mark(true)
        return
      case 'wrong':
        mark(false)
        return
      case 'clearShown':
        clearShown()
        return
      case 'help':
        helpOpen = !helpOpen
        return
      case 'rules':
        // From a key, always from the first rule: "g" has no value it was
        // pressed on, and "somewhere around where we were last time" is not
        // an answer.
        openRules('studentRun')
        return
      case 'escape':
        if (helpOpen) helpOpen = false
        else if (searching) {
          searching = false
          search = ''
        } else if (at === 'reply') (event.target as HTMLElement).blur()
        return
    }
  }

  /** The row under the cursor must not end up at the very edge of the list. */
  async function scrollToCursor(moveFocus = true): Promise<void> {
    await tick()
    if (cursor === null) return
    const row = document.querySelector(`[data-pult-row="${CSS.escape(cursor)}"]`)
    row?.scrollIntoView({ block: 'nearest' })
    if (moveFocus) row?.querySelector<HTMLButtonElement>('[data-pult-select]')?.focus({ preventScroll: true })
  }

</script>

<svelte:window on:keydown={onkeydown} />

{#if !host}
  <!--
    A refusal, not an empty console. A link to the window goes into a chat as
    easily as any other, and behind it lie other people's work in full.
  -->
  <div class="flex h-full w-full flex-col items-center justify-center gap-2 bg-canvas px-10 text-center">
    <p class="text-title font-bold text-ink">{tr('room.ui.1357')}</p>
    <p class="text-ui text-muted">{tr('room.ui.1358')}</p>
  </div>
{:else if board === null || phase !== 'ready'}
  <!--
    "Waiting" and "no" are two different pictures, and the second used to
    stand in place of both. While the pile is on its way, the same splash as
    the room's (Splash) stands here, not the verdict "the cell is not in a
    council": the window is drawn before the first network frame, and the
    verdict managed to flash on every reload of the console.
  -->
  {#if phase === 'waiting'}
    <div class="flex h-full w-full bg-canvas"><Splash size="pane" label={tr('room.pult.v3.loading')} /></div>
  {:else}
    <div class="flex h-full w-full flex-col items-center justify-center gap-2 bg-canvas px-10 text-center">
      <p class="text-title font-bold text-ink">{tr('room.ui.1359')}</p>
      <p class="text-ui text-muted">{tr('room.ui.1360')}</p>
    </div>
  {/if}
{:else}
  <div class="pult-root relative flex h-full min-h-0 w-full flex-col bg-canvas text-ink" data-council-pult={cellId} data-pult-pane={pane}>
    <div class="pult-head" bind:clientHeight={headHeight}>
      <PultHeader
        {cellId}
        {cells}
        title={session.session.name}
        rules={sentence}
        openRule={rulesOpen ? rulesRule : null}
        onrules={openRules}
        {onpick}
        {onexit}
      />
    </div>
    {#if offline}<p class="border-b border-warning px-4 py-2 text-ui text-warning" role="status">{tr(OFFLINE_REASON)}</p>{/if}
    {#if oracleError}<p class="border-b border-danger px-4 py-2 text-ui text-danger" role="alert">{oracleError}</p>{/if}

    <nav class="pult-nav" data-pult-nav aria-label={tr('room.pult.v2.navigation')}>
      <button type="button" class="pult-view-tab" aria-pressed={tab === 'work'} onclick={() => (tab = 'work')}>
        {tr('room.pult.v2.workTab')} <span class="pult-tab-count">{counts.attempts}</span>
      </button>
      <button type="button" class="pult-view-tab" aria-pressed={tab === 'queue'} onclick={() => (tab = 'queue')}>
        {tr('room.pult.v2.queueTab')} <span class="pult-tab-count" class:needs-attention={kernel.pending.length > 0}>{kernel.pending.length + kernel.queued.length}</span>
      </button>
      <button type="button" class="pult-view-tab" aria-pressed={tab === 'oracle'} onclick={() => (tab = 'oracle')}>
        <span aria-hidden="true">✦</span> {tr('room.pult.v2.oracleTab')}
      </button>
      {#if kernel.pending.length > 0 && tab !== 'queue'}
        <button type="button" class="pult-pending-link" onclick={() => (tab = 'queue')}>{tr('room.pult.v2.pending', {count:kernel.pending.length})}</button>
      {:else if !kernel.running && kernel.queued.length === 0 && kernel.pending.length === 0}
        <span class="pult-nav-status">{tr('room.pult.v2.queueEmpty')}</span>
      {/if}
    </nav>

    {#if shown}
      <PultOnScreen {shown} {now} {disabled} onclear={clearShown} />
    {/if}

    <section class="pult-work-layout" hidden={tab !== 'work'} aria-label={tr('room.pult.v2.workTab')}>
      <aside class="pult-sidebar">
    <PultFilters
      tab={listTab}
      {filter}
      {tabs}
      {chips}
      {search}
      {searching}
      {names}
      {counts}
      ontab={(next) => (listTab = next)}
      onfilter={(next) => (filters = { ...filters, [listTab]: next })}
      onsearch={(text) => (search = text)}
      onclose={() => { searching = false; search = '' }}
      onopensearch={() => (searching = true)}
    />
      <PultList
        people={session.peersById}
        connected={presenceKnown}
        filtered={filter !== 'all' || search.trim() !== ''}
        tab={listTab}
        {rows}
        {cursor}
        keyboard={keyboard && focus !== 'reply'}
        {names}
        shown={shown?.participantId ?? null}
        {now}
        onscroll={(at) => (scrolled = at > 0)}
        held={held.size}
        decisionsOff={disabled || settings.studentRun !== 'request'}
        onopen={open}
        onlet={letThrough}
        onrelease={release}
      />
      </aside>
      <div class="pult-work-pane">
          {#if phone && phonePane === 'work'}
            <!--
              The work screen's bar: back to the list, whose it is, and arrows
              through the feed. The name stands here, not in the work header:
              at 390 px two names in a row are a line taken away from the code.
            -->
            <div class="phone-bar">
              <button type="button" class="phone-back" onclick={toList}>
                <span aria-hidden="true">‹</span> {tr('room.pult.v3.backToList')}
              </button>
              <span class="phone-title">{current === null ? '' : names ? current.name : tr('room.ui.1255', { p0: variants.get(current.participantId) ?? 0 })}</span>
              <span class="phone-place">{tr('room.pult.v3.place', { index: place, total: ids.length })}</span>
              <button type="button" class="phone-step" aria-label={tr('room.pult.v3.prevWork')}
                disabled={place <= 1} onclick={() => step(-1)}><span aria-hidden="true">‹</span></button>
              <button type="button" class="phone-step" aria-label={tr('room.pult.v3.nextWork')}
                disabled={place >= ids.length} onclick={() => step(1)}><span aria-hidden="true">›</span></button>
            </div>
          {/if}
          <PultWork
            attempt={current}
            phone={phone && phonePane === 'work'}
            presence={current ? pultPresence(presenceKnown, session.peersById, current.participantId) : 'unknown'}
            index={place}
            total={ids.length}
            onstep={step}
            variant={current ? (variants.get(current.participantId) ?? 0) : 0}
            {names}
            {now}
            onScreen={shown?.participantId === current?.participantId && shown !== null}
            shownAt={shown?.shownAt ?? null}
            {disabled}
            limit={settings.runLimitSec}
            onrules={openRules}
            {reply}
            {replyFromOracle}
            onshow={() => show()}
            onclear={clearShown}
            onrun={() => run()}
            oninterrupt={interrupt}
            onmark={mark}
            onremove={remove}
            onreplychange={(text) => {
              updateReply({ text, ...(text.trim() === '' ? { fromOracle: false } : {}) })
            }}
            onreplysend={sendReply}
            onreplyfocus={() => (focus = 'reply')}
            onreplyblur={() => (focus = 'list')}
          />
      </div>
    </section>
    {#if tab === 'queue'}
      <PultQueueStrip {kernel} {settings} {attempts} {names} {now} open={true} {disabled}
        ontoggle={() => {}} oninterrupt={interrupt} onrestart={restartKernel} onapprove={letThrough}
        ondecline={declineRun} onapproveall={approveAll} onopen={open} ondrop={dropRun} onremove={remove} />
    {:else if tab === 'oracle'}
      <PultOracleTab oracle={board.oracle} {attempts} submitted={counts.submitted} {names} {variants}
        askWhy={offline ? tr(OFFLINE_REASON) : null}
        onask={(question, effort) => void askOracle(false, question, effort)}
        onstop={() => void askOracle(true)} onopen={open} />
    {/if}

    <PultStatusLine
      onScreen={shown === null ? null : (shown.name ?? tr('room.ui.1255', { p0: shown.variant }))}
      inFrame={shown?.shownAt ? spell(Math.max(now - shown.shownAt, 0)) : ''}
      index={place}
      total={ids.length}
      banner={shown !== null}
      onclear={clearShown}
      onhelp={() => (helpOpen = true)}
    />

    {#if rulesOpen}
      <PultRules
        {settings}
        rule={rulesRule}
        pending={kernel.pending.length}
        {stats}
        cellLimit={session.session.rules.cellLimitSec}
        {disabled}
        top={headHeight}
        onchange={setRule}
        onclose={closeRules}
      />
    {/if}

    {#if helpOpen}
      <PultKeys onclose={() => (helpOpen = false)} />
    {/if}
  </div>
{/if}

<style>
  /*
   * The budget for the permanent frame is 176 px of 650.
   *
   * It was 290: a three-line header, 48 px tabs with 12 px padding, a
   * two-row "on screen" strip and the status line. In a 900×650 window that
   * is almost half the height for what does not change during a class —
   * while what changes in it is the list on the left and the work on the
   * right, and they were left two and a half rows and a panel sliding below
   * the fold.
   */
  .pult-root { overflow:hidden; }
  .pult-head { flex-shrink:0; }
  .pult-nav { display:flex; align-items:center; flex-wrap:nowrap; gap:6px; flex-shrink:0; min-height:44px; padding:5px var(--pult-pad); background:rgb(var(--surface)); border-bottom:1px solid rgb(var(--line)); }
  .pult-view-tab { display:inline-flex; align-items:center; justify-content:center; gap:8px; min-height:34px; padding:6px 12px; border:1px solid rgb(var(--line)); background:rgb(var(--canvas)); font-size:14px; font-weight:600; line-height:20px; white-space:nowrap; cursor:pointer; }
  .pult-view-tab[aria-pressed="true"] { background:rgb(var(--primary)); border-color:rgb(var(--primary)); color:rgb(var(--primary-ink)); font-weight:700; }
  .pult-tab-count { min-width:20px; text-align:center; padding:0 3px; font-variant-numeric:tabular-nums; }
  .pult-tab-count.needs-attention { background:rgb(var(--warning)); color:rgb(var(--canvas)); }
  .pult-pending-link { min-height:32px; padding:6px 10px; margin-left:auto; background:rgb(var(--warning)/.1); border:1px solid rgb(var(--warning)/.35); color:rgb(var(--warning)); font-size:13px; font-weight:600; white-space:nowrap; cursor:pointer; }
  .pult-nav-status { margin-left:auto; font-size:13px; color:rgb(var(--muted)); white-space:nowrap; }
  .pult-work-layout { display:flex; min-height:0; flex:1; }
  /* 336 is the width at which the Russian "Execution completed · 1.2 s ·
     17:24" fits in the row whole: the list was widened for the sake of this
     third line. */
  .pult-sidebar { display:flex; flex-direction:column; min-height:0; width:336px; flex-shrink:0; border-right:1px solid rgb(var(--line)); background:rgb(var(--surface)); }
  /*
   * The work panel NEVER scrolls as a whole.
   *
   * There used to be `@media(max-height:700px){ overflow-y:auto }` together
   * with `min-height:650px` on the work itself — that is, in a short window
   * the panel became a long page, and the reply field with the four actions
   * lay below the fold. Exactly one zone scrolls — the code with its output
   * (PultWork · .work-content), while the author header and the
   * communication dock are pinned to their edges.
   */
  .pult-work-pane { display:flex; flex-direction:column; min-height:0; min-width:0; flex:1; }
  /*
   * The only height at which the three zones do not fit together: a window
   * under 480 px is half a laptop screen, and there is physically no room
   * for the dock with the code and the header. Here the panel becomes a page
   * again — scrolling is better than buttons crushed to nothing.
   */
  @media(max-height:479px) { .pult-work-pane { overflow-y:auto; } }
  /* The work screen's bar on a phone: back, name, place in the feed, arrows. */
  .phone-bar { display:none; align-items:center; gap:8px; flex-shrink:0; min-height:44px; padding:4px 8px 4px 4px; border-bottom:1px solid rgb(var(--line)); background:rgb(var(--surface)); }
  .phone-back { display:flex; align-items:center; gap:4px; flex-shrink:0; min-height:40px; padding:6px 8px; color:rgb(var(--primary)); font-size:15px; font-weight:600; cursor:pointer; }
  .phone-title { min-width:0; flex:1; overflow:hidden; white-space:nowrap; text-overflow:ellipsis; font-size:15px; font-weight:700; }
  .phone-place { flex-shrink:0; color:rgb(var(--muted)); font-size:13px; font-variant-numeric:tabular-nums; }
  .phone-step { display:flex; align-items:center; justify-content:center; width:40px; min-height:40px; flex-shrink:0; border:1px solid rgb(var(--line)); background:rgb(var(--canvas)); font-size:18px; cursor:pointer; }
  .phone-step:disabled { opacity:.4; cursor:default; }
  /* The same air as the header's: on a big monitor the density of a
     650-pixel window looks stingy, and there is height to spare there. */
  @media(min-width:1200px) and (min-height:800px) {
    .pult-nav { min-height:52px; padding-block:8px; }
    .pult-view-tab { min-height:38px; padding:8px 14px; font-size:15px; }
  }
  @media(max-width:1000px) { .pult-sidebar { width:324px; } }
  @media(max-width:860px) { .pult-sidebar { width:280px; } .pult-view-tab { padding:6px 9px; } }
  @media(max-width:650px) {
    /*
     * Phone: two screens, not two columns.
     *
     * A full-screen list, a full-screen work view, and between them a press
     * and the "back" gesture. While a piece of work is open, the header, the
     * tabs and the "on screen" strip go away: their room is exactly the
     * height the communication dock and the code were missing. Getting back
     * to them is one gesture.
     */
    .pult-root { height:100dvh; }
    .pult-nav-status, .pult-pending-link { display:none; }
    .pult-view-tab { flex:1; min-height:44px; font-size:14px; padding:6px 8px; }
    .pult-work-layout { flex-direction:row; }
    .pult-sidebar { width:100%; border-right:0; }
    .phone-bar { display:flex; }
    [data-pult-pane='work'] .pult-sidebar { display:none; }
    [data-pult-pane='list'] .pult-work-pane { display:none; }
    [data-pult-pane='work'] .pult-head,
    [data-pult-pane='work'] .pult-nav { display:none; }
    [data-pult-pane='work'] :global(.projection-banner) { display:none; }
  }
</style>
