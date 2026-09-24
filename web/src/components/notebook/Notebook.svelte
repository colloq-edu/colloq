<script lang="ts">
  import Splash from '@/components/ui/Splash.svelte'
  import { firstScreenReady } from '@/lib/boot'
  import { tr } from '@shared/i18n'
  import { tick } from 'svelte'
  import { cellType, findCell, isCellOpen, type CellType } from '@shared/notebook'
  import { isLectureRoom } from '@shared/rules'
  import Icon from '@/components/ui/Icon.svelte'
  import { controlDisabled, controlTitle } from '@/lib/controls'
  import {
    cellLockMatters,
    LECTURE_CELL,
    mayEditThisCell,
    mayRunThisCell,
    permitsIn,
  } from '@/lib/may'
  import { selectionHere, stepPlan } from './command-mode'
  import { deleteCell, insertCell, setCellType } from '@/lib/notebook-ops'
  import { getSessionState } from '@/lib/session.svelte'
  import {
    afterRun,
    anchorShift,
    measurable,
    nearestTarget,
    TOOLBAR_FALLBACK,
    type Frame,
    type HeightChange,
  } from '@/lib/cell-scroll'
  import { cn, isJumpClick, modKey, prefersReducedMotion } from '@/lib/utils'
  import { watchBookKernel, watchBooks, watchCellIds } from '@/lib/yreactive.svelte'
  import CellView from './CellView.svelte'
  import { nextBuiltCells } from './first-mount'

  interface Props {
    /**
     * The notebook's path: it is a file just like everything else in the
     * seminar folder.
     *
     * The root in the document is derived from the path rather than passed
     * here: the path is what a person sees in the tree and on the tab, and the
     * root is an internal name that the first notebook kept unchanged for the
     * sake of history and the cache.
     */
    book: string
    /**
     * This notebook is shown, not hidden behind another tab.
     *
     * The room's keyboard is one for the whole window
     * (`<svelte:window onkeydown>`), and as many notebooks are mounted as there
     * are open tabs: hidden ones are hidden by a class, not unmounted, so as
     * not to lose the cursor. Without this check pressing "a" inserted a cell
     * into EVERY open notebook, and Shift+Enter sent two runs — both into
     * different sheets.
     */
    active: boolean
  }

  let { book, active }: Props = $props()

  const session = getSessionState()
  const books = watchBooks(session.doc)
  const root = $derived(books.current.find((entry) => entry.path === book)?.root ?? '')
  const ids = watchCellIds(session.doc, () => root)
  /*
   * The kernel of THIS notebook, not of the room.
   *
   * Every notebook has its own Python and its own queue
   * (server/src/kernel/index.ts), and the bar talks about the one that is open:
   * a lecture may be computing for a minute and a half while the seminar is
   * idle, and one pill for the two would lie to both. The root is a function:
   * the list of notebooks arrives with the document, and until it arrives the
   * list is empty.
   */
  const notebook = watchBookKernel(session.doc, () => root)

  /*
   * $derived, not a plain const: the control socket reports the role the server
   * will actually act on as soon as it opens, and a teacher whose token was
   * minted before they signed in arrives here as a participant and is corrected
   * a moment later. A value captured at init would never hear about it.
   */
  const isHost = $derived(session.me.role === 'host')
  const kernel = $derived(notebook.current.kernelStatus)
  const queued = $derived(notebook.current.queue.length)

  /*
   * Whoever started the running cell may stop it, teacher or not: only one cell
   * runs at a time, and a seminar with nobody senior in the room otherwise has
   * no way to end a loop. The server enforces the same rule from its own record
   * of the queue; this only decides how the control is drawn.
   */
  const runningIsMine = $derived.by(() => {
    const running = notebook.current.runningCellId
    if (!running) return false
    const found = findCell(session.doc, running)
    /*
     * The cell may have been deleted while it was running: the client allows
     * deleting a running cell, meta keeps naming the vanished id, and the
     * "stop" on the cell itself went away with it. The server remembers who
     * started it, the document no longer does; dimming the only remaining
     * button out of ignorance would leave a room without a teacher with an
     * infinite loop and no way out. The server will check the permission; here
     * we only do not stand in the way of pressing.
     */
    if (!found) return true
    return (found.cell.get('runById') as string | null) === session.me.id
  })
  const canInterrupt = $derived(isHost || runningIsMine)

  /**
   * What "Interrupt" from the bar sends.
   *
   * The server understands an unnamed press as "clear the whole queue" and
   * refuses a participant while other people's cells are in it — while the
   * button is lit and promises to stop the running one. A non-host names the
   * target, and then the branch about other people's queue does not fire at
   * all: they stop exactly their own cell. For the teacher the press stays
   * unnamed — that is what distinguishes the room button from the button on a
   * cell.
   */
  function interruptMessage(): { t: 'interrupt'; cellId?: string; book?: string } {
    const running = notebook.current.runningCellId
    // The sheet is always named: without it the server would take the press as
    // "the room's notebook" and clear someone else's queue — the neighbouring
    // one, which this button has nothing to do with.
    if (isHost || !running) return { t: 'interrupt', book }
    return { t: 'interrupt', cellId: running, book }
  }

  /* --------------------------------------------------------- navigation */

  /**
   * The notebook's column — and through it the scroll container.
   *
   * What scrolls is not the window and not the notebook itself but the `<main>`
   * above it (one per tab, see SessionScreen): as many notebooks are mounted as
   * there are open tabs, and each has its own scrolling ancestor. So it is
   * looked for upward from our own node, rather than taking
   * `document.scrollingElement`.
   */
  let column = $state<HTMLDivElement | null>(null)
  let scrollBox: HTMLElement | null = null

  function scrollerFrom(node: HTMLElement | null): HTMLElement | null {
    for (let up = node?.parentElement ?? null; up; up = up.parentElement) {
      const overflow = getComputedStyle(up).overflowY
      if (overflow === 'auto' || overflow === 'scroll') return up
    }
    return null
  }

  function scroller(): HTMLElement | null {
    if (scrollBox?.isConnected) return scrollBox
    scrollBox = scrollerFrom(column)
    return scrollBox
  }

  /*
   * Where we are steering the screen right now — and to which cell.
   *
   * A move takes frames, and in exactly those frames something above the target
   * is still changing height: a deferred cell straightens out, an image reports
   * its size. A target computed at the start is stale by exactly that growth by
   * the end of the move — and the anchor (see settle) corrects it by exactly
   * that amount.
   *
   * The cell's name is kept not for recomputing (a jump has one target and it
   * is computed once) but for the "is this cell still alive" check: it may have
   * been deleted while the screen was moving.
   */
  let steering: { id: string; top: number } | null = null

  /**
   * How long we hold the target.
   *
   * Exactly for the move, no longer. While the target is alive, any height
   * change above it RETARGETS the screen; once it is cleared, the same change
   * merely holds the screen in place (the anchor below). The first is right for
   * a move, the second for a person who has already arrived: output that comes
   * a second later must not pull the sheet from under their eyes. Seven hundred
   * milliseconds is a smooth scroll with room to spare.
   */
  const STEER_MS = 700

  function steerTo(box: HTMLElement, id: string, top: number): void {
    steering = { id, top }
    box.scrollTo({ top, behavior: prefersReducedMotion() ? 'auto' : 'smooth' })
    // The end of a smooth scroll has no event of its own everywhere we need it
    // (`scrollend` is young). A person cuts the move short earlier — with the
    // wheel or a press, see the handlers on the column: their scrolling always
    // outranks ours.
    window.setTimeout(() => {
      if (steering?.id === id && steering.top === top) steering = null
    }, STEER_MS)
  }

  /**
   * The window minus the sticky bar.
   *
   * The mode bar is pinned to the top of the container and covers its first 40
   * px. A cell brought to the "top of the screen" literally arrived with its
   * toolbar UNDER the bar — that is, exactly where it cannot be seen, and all
   * the computed space went to something else.
   */
  function frameOf(box: HTMLElement): Frame {
    const rect = box.getBoundingClientRect()
    const bar = column?.querySelector<HTMLElement>('[data-notebook-bar]')
    const under = bar ? bar.getBoundingClientRect().height : 0
    return { top: rect.top + under, bottom: rect.bottom, scrollTop: box.scrollTop }
  }

  /** Geometry of a cell and its toolbar, in the form cell-scroll expects. */
  function boxOf(cell: HTMLElement) {
    const rect = cell.getBoundingClientRect()
    const bar = cell.querySelector<HTMLElement>('[data-cell-toolbar]')
    return {
      top: rect.top,
      bottom: rect.bottom,
      toolbar: bar ? bar.getBoundingClientRect().height : TOOLBAR_FALLBACK,
    }
  }

  /**
   * Show a cell if it is not visible — and not a pixel more.
   *
   * ONLY jumps call this: the arrow, `j`/`k`, extending the selection, a step
   * out of the editor's last line. A run does not call it at all — see `select`
   * and lib/cell-scroll.ts: the output appears under the code, and at that
   * moment the person is looking at the code.
   *
   * We compute rather than ask the browser: see the analysis in
   * lib/cell-scroll.ts. The toolbar is measured in place, because it is not
   * always there (a parked and a deferred cell have none in the DOM at all) and
   * because a number in CSS and a number in code drift apart silently.
   */
  function reveal(id: string) {
    const cell = document.querySelector<HTMLElement>(`[data-cell-id="${id}"]`)
    const box = scroller()
    if (!cell) return
    if (!box) {
      // A notebook without a scrolling ancestor happens only in a test and in
      // print.
      cell.scrollIntoView({ block: 'nearest' })
      return
    }
    const target = nearestTarget(frameOf(box), boxOf(cell))
    if (target === null) return
    steerTo(box, id, target)
  }

  /**
   * The person moved the sheet themselves — we stop steering.
   *
   * A request from a class, and a fair one: in the middle of "Run all" people
   * go to look at a cell above, and a sheet that pulls back to the queue argues
   * with the person. The person always loses that argument — but wins every
   * other frame, and exactly that reads as "twitching".
   *
   * ONLY scrolling counts as moving away: the wheel and the finger. A press is
   * not moving away: one can select a cell during a run without giving up on
   * being shown the rest. That is why `onpointerdowncapture` below still has a
   * single concern — cutting the current move short — and it does not set the
   * flag.
   *
   * It is cleared at the end of the work, not at the start: "Run all" goes as
   * one piece, and within it the person's intention does not change. Once the
   * queue is done, the next run steers again.
   */
  let handedOver = false

  const busy = $derived(notebook.current.runningCellId !== null || queued > 0)
  $effect(() => {
    if (!busy) handedOver = false
  })

  /**
   * A cell has finished — show its output if it is not visible.
   *
   * Where exactly, and why not always, is in cell-scroll.ts · afterRun: two
   * opposite complaints from classes are reconciled there, and the condition
   * "move only if the bottom is not visible" was born from both of them.
   *
   * Here is the third: "Run all twitches". It was first fixed with careful
   * steering — requests were merged per frame, moves were made instant, the
   * last move was softened — and it still came out wrong. The solution turned
   * out to be not in HOW to steer but in not steering behind a batch run at
   * all.
   *
   * The argument is simple. A single run is a question: the person pressed and
   * is looking at the answer; showing the answer if it is not visible is a
   * service. "Run all" is not a question but work: forty cells, minutes of
   * time, and meanwhile the person is busy with their own thing — reading
   * above, editing below, simply waiting. A sheet that moves by itself during
   * those minutes argues with them even when it guesses right.
   *
   * We tell them apart by the height of the queue during the run: a single run
   * puts one cell into it, "Run all" many. What counts is the PEAK, not the
   * current length: by the end of the run the queue is empty, and by it the
   * last cell is indistinguishable from a single one. The decision is made at
   * the same instant as the transition — before the peak is reset.
   *
   * Merging requests per frame has stayed: single runs can come often
   * (Shift+Enter in a row), and two moves in one frame would stumble just the
   * same.
   */
  let pending: string | null = null
  let pendingFrame = 0

  function follow(id: string): void {
    if (handedOver || !active) return
    pending = id
    if (pendingFrame) return
    pendingFrame = requestAnimationFrame(() => {
      pendingFrame = 0
      const want = pending
      pending = null
      if (want && !handedOver) show(want)
    })
  }

  function show(id: string): void {
    const cell = document.querySelector<HTMLElement>(`[data-cell-id="${id}"]`)
    const box = scroller()
    if (!cell || !box) return
    const target = afterRun(frameOf(box), boxOf(cell))
    if (target === null) return
    // Already heading exactly there: a second `scrollTo` would only break the
    // acceleration.
    if (steering && Math.abs(steering.top - target) < 2) return
    steerTo(box, id, target)
  }

  /*
   * Who finished last. A plain field, not `$state`: it is read and written by
   * one and the same effect, and as a reactive value it would trigger itself.
   */
  let ranLast: string | null = null

  /*
   * The move is made on the CHANGE of the running cell, not at its end.
   *
   * A cell's end is not a separate event — there is `runningCellId`, which
   * stops being that cell: it goes to null (one cell finished) or to the
   * neighbouring one ("Run all" is in progress). The second case is exactly
   * that "as it runs": the screen goes down after the queue by itself, cell by
   * cell.
   *
   * `tick()` — to measure the output that has already been drawn, not what was
   * there before it.
   */
  /** The longest queue during this run: that is how "Run all" is told apart. */
  let peak = 0

  $effect(() => {
    const now = notebook.current.runningCellId
    const was = ranLast
    ranLast = now
    if (queued > peak) peak = queued
    if (!was || was === now) return
    /*
     * We decide HERE, synchronously, and only then forget the peak: the move is
     * deferred to a tick and a frame, and by that time the queue is long
     * empty — by it the last cell of a run would look like a single one, and
     * "Run all" would pull the sheet exactly once, at the very end. That is
     * exactly the case that people asked to remove.
     */
    const batch = peak >= 2
    if (now === null) peak = 0
    if (batch) return
    void tick().then(() => follow(was))
  })

  /*
   * A note has "run" — that is, it has been rendered (CellView · run). It has
   * no kernel and no `runningCellId`, so the effect above does not learn about
   * it; it speaks for itself. The move is the same and by the same rules: after
   * `tick`, to measure the already rendered text rather than the source that
   * stood in its place.
   */
  $effect(() => {
    const onSettled = (event: Event): void => {
      const cellId = (event as CustomEvent<{ cellId?: string }>).detail?.cellId
      // The event is window-wide, and there can be two notebooks on screen
      // (tabs): is it ours?
      if (!cellId || !ids.current.includes(cellId)) return
      void tick().then(() => follow(cellId))
    }
    window.addEventListener('colloq:cell-settled', onSettled)
    return () => window.removeEventListener('colloq:cell-settled', onSettled)
  })

  $effect(() => () => {
    if (pendingFrame) cancelAnimationFrame(pendingFrame)
  })

  /* ------------------------------------------------------------ anchor */

  /**
   * Our own scroll anchoring: a cell above the screen changes height — the
   * screen stays put.
   *
   * Scrolling down through the notebook was smooth, scrolling up twitched "to
   * the start of the previous cell". The cause was measured on the test bench,
   * and it is our own: a deferred cell stands as a 240 px placeholder, while a
   * built one can be 809, and the swap happens exactly when the cell approaches
   * the edge of the screen. Going down this is not visible — the growth goes
   * BELOW the screen. Going up, the cell arrives with its top already past the
   * edge, straightens downwards, and everything visible shifts by 569 px at
   * once; a single climb up the notebook collected two dozen such jerks.
   *
   * The browser's scroll anchoring is supposed to fix this and does not:
   * measured — a cell above the screen grows by 569 px, `scrollTop` does not
   * change by a single pixel. So the anchor is our own, and the browser's is
   * explicitly switched off (see the column's markup).
   *
   * It also covers everything that is measured late and by itself: an image
   * without dimensions, a KaTeX formula, a DataFrame table — because it looks
   * not at the cause but at the height.
   */
  const slotHeights = new Map<string, number>()

  /**
   * Reconcile the heights and put the screen back in place.
   *
   * Computed over all slots at once, not one at a time: several neighbours
   * change within a single frame, and their shift is shared.
   */
  function settle(): void {
    const box = scroller()
    if (!box || !column) return
    /*
     * The notebook is hidden by a neighbouring tab — leave WITHOUT touching
     * slotHeights.
     *
     * The analysis is in cell-scroll.ts · measurable, together with the
     * complaint it grew out of. In short: under `display: none` all heights
     * read as zeros, and the visibility observer declares the cells invisible
     * at exactly that moment and wakes the anchor. Writing zeros would mean
     * seeing "the whole sheet grew" on return and carrying the screen down by
     * the sum of all cells.
     *
     * Precisely a `return` before the first measurement, not "compute and do
     * not apply": what poisons things is not the correction but the memory of
     * heights.
     */
    if (!measurable(frameOf(box))) return
    const frameTop = box.getBoundingClientRect().top
    const at = box.scrollTop
    /*
     * A move to a cell is under way — shift the TARGET, not the screen.
     *
     * `scrollTop` cannot be corrected in the middle of a smooth scroll: the
     * browser treats that as outside interference and cuts the move short. And
     * height growth above the target makes the target itself stale by exactly
     * its size — so that is what has to be added to it, leaving the move to go
     * on. The growth is computed relative to the TARGET, not to the current
     * `scrollTop`: where the screen will be in this frame depends on the frame,
     * and where it is heading does not.
     */
    if (steering) {
      const aim = steering.top
      const moved: HeightChange[] = []
      for (const node of column.querySelectorAll<HTMLElement>('[data-cell-slot]')) {
        const id = node.dataset.cellSlot
        if (!id) continue
        const rect = node.getBoundingClientRect()
        const was = slotHeights.get(id)
        slotHeights.set(id, rect.height)
        if (was === undefined || Math.abs(rect.height - was) < 0.5) continue
        moved.push({ top: rect.top - frameTop + at, delta: rect.height - was })
      }
      // The cell may have been deleted while the screen was moving: there is
      // nowhere to go any more.
      if (!document.querySelector(`[data-cell-id="${steering.id}"]`)) {
        steering = null
        return
      }
      const shift = anchorShift(moved, aim)
      if (Math.abs(shift) < 1) return
      steerTo(box, steering.id, Math.max(0, aim + shift))
      return
    }
    const changes: HeightChange[] = []
    for (const node of column.querySelectorAll<HTMLElement>('[data-cell-slot]')) {
      const id = node.dataset.cellSlot
      if (!id) continue
      const rect = node.getBoundingClientRect()
      const was = slotHeights.get(id)
      slotHeights.set(id, rect.height)
      if (was === undefined || Math.abs(rect.height - was) < 0.5) continue
      changes.push({ top: rect.top - frameTop + at, delta: rect.height - was })
    }
    // The first VISIBLE pixel, not the first pixel of the container: whatever
    // stands under the sticky bar is also "above the screen" to the eye.
    const shift = anchorShift(changes, frameOf(box).top - frameTop + at)
    if (Math.abs(shift) < 1) return
    box.scrollTop = at + shift
  }

  /*
   * Our own swap is caught BEFORE the frame, anyone else's — after.
   *
   * Almost the whole jerk is our own work: a 240 px placeholder turns into an
   * 809 px cell, and that happens in an ordinary DOM update. A Svelte effect
   * runs right after that update and LONG before the browser starts laying out
   * the frame — a correction from here lands in the same frame, and nothing on
   * screen twitches. A correction from ResizeObserver does NOT land in the same
   * frame (checked on the test bench: for one frame the screen stands shifted
   * and comes back on the next), and that is why the observer here is only a
   * fallback — for what gets measured by itself and later: an image without
   * dimensions, a formula, a table.
   */
  $effect(() => {
    void built
    void ruling
    settle()
  })

  const anchoring =
    typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(() => settle())

  $effect(() => () => anchoring?.disconnect())

  /**
   * Select a cell — and show it if we got here by a jump.
   *
   * `show: false` means a run. Shift+Enter selects the next cell, and the
   * selection ends there: the screen stays where it was, because after a run
   * one should look at the output of the cell that ran, and it grows right
   * under it. Selection and scrolling used to be one action, and the second
   * could not be separated from the first — hence the "throws me down".
   */
  function select(id: string, show = true) {
    session.selectCell(id)
    if (!show) return
    // Keyboard navigation must not walk the selection off screen — and the
    // target may have been parked, so let it take its real height first.
    void tick().then(() => reveal(id))
  }

  function enter(id: string) {
    // Selection can construct a previously unseen cell. Its window listener
    // must exist before handing focus to it (including Shift+Enter handoffs).
    void tick().then(() => {
      window.dispatchEvent(new CustomEvent('colloq:enter-cell', { detail: { cellId: id } }))
    })
  }

  async function addAt(index: number, type: CellType, show = true) {
    /*
     * Out loud, not silently — on the key too. A refusal nobody mentioned reads
     * as a breakage, not as the teacher's decision; and without this check
     * pressing "a" went into the shared document, the server refused the frame,
     * and the person was left with the cursor in a cell nobody has.
     */
    if (!may.add) {
      session.showError(may.structureWhy + '.')
      return
    }
    const created = insertCell(session.doc, root, type, index)
    select(created, show)
    // The new cell has to exist in the DOM before it can take focus.
    await tick()
    enter(created)
  }

  /**
   * A cell was clicked — alone, or added to the selected ones.
   *
   * Cmd on a Mac and Ctrl elsewhere — the same modifier used for scattered
   * selection everywhere; Shift is a range, including from another cell's code
   * field. In an already active editor, Shift keeps selecting text. The body
   * handler is called in the capture phase: the editor must not intercept this
   * gesture or take focus and reset the selection in its onfocus.
   */
  function pick(id: string, event?: MouseEvent | PointerEvent): void {
    if (event && event.button !== 0) return
    /*
     * The jump modifier inside a code field is someone else's gesture: let it
     * through.
     *
     * There it is used to go to a definition (CodeEditor.svelte · jump), and
     * intercepting it in the capture phase is exactly why NOTHING reached the
     * editor: preventDefault, stopPropagation and blur fired before CodeMirror
     * learned about the press. So here it is not "do not select" but precisely
     * return without touching the event.
     *
     * This is a trade-off, not an oversight, and exactly one of four places is
     * given up. Scattered selection across CODE on a Mac is left to the second
     * modifier — Ctrl+click; that is why lib/utils · isJumpClick tells the
     * platforms apart instead of reading "either of the two". Nothing changed
     * outside the code: the cell number, the margins and the output select the
     * cell as before, and the number became a target recently and on purpose —
     * it is marked with `data-cell-pick` (CellView.svelte), because that is
     * exactly what people aim at when they want the cell.
     *
     * The gesture is given up only in a cell with CODE: in a text cell there is
     * nowhere to go, people write prose there, and a silently swallowed click
     * would be a pure loss. Walking the list of cells for the sake of one press
     * costs exactly as much as `convertCell` below pays for the same knowledge.
     */
    if (event && isJumpClick(event) && (event.target as Element | null)?.closest('.cm-editor')) {
      const found = findCell(session.doc, id)
      if (found && cellType(found.cell) === 'code') return
    }
    if (event?.shiftKey && !event.metaKey && !event.ctrlKey) {
      const editor = (event.target as Element | null)?.closest('.cm-editor')
      if (editor?.contains(document.activeElement)) return
    }
    if (event && (event.metaKey || event.ctrlKey || event.shiftKey)) {
      event.preventDefault()
      event.stopPropagation()
      // Keep subsequent notebook shortcuts out of the previously focused editor.
      const focused = document.activeElement
      if (focused instanceof HTMLElement && focused.closest('.cm-editor')) focused.blur()
    }
    if (event && (event.metaKey || event.ctrlKey)) {
      session.toggleCell(id)
      return
    }
    if (event?.shiftKey && session.selectedCellId) {
      session.extendTo(id, ids.current)
      return
    }
    session.selectCell(id)
  }

  /** A cell handing off to its neighbour; only this component knows the order. */
  $effect(() => {
    const onStep = (event: Event) => {
      const detail = (
        event as CustomEvent<{
          cellId: string
          direction: -1 | 1
          focus?: boolean
          fallback?: boolean
          /** Make a cell when there is none to step to; Shift+Enter only. */
          grow?: boolean
          /** A run passes `false`: the selection moves, the screen stays. */
          scroll?: boolean
        }>
      ).detail
      if (!detail) return
      const list = ids.current
      // Shift+Enter on the last cell has nowhere to go, so it makes somewhere:
      // that is how a notebook grows while somebody types down the page, and
      // it is what the same key does in the tool this room already knows.
      // Without the right to add, it simply stays in place: see stepPlan.
      const plan = stepPlan(list, detail.cellId, detail.direction, {
        fallback: detail.fallback,
        grow: detail.grow,
        mayAdd: may.add,
      })
      if (plan.kind === 'stay') return
      if (plan.kind === 'grow') {
        void addAt(plan.at, 'code', detail.scroll !== false)
        return
      }
      select(plan.cellId, detail.scroll !== false)
      if (detail.focus !== false) enter(plan.cellId)
    }
    window.addEventListener('colloq:step-cell', onStep)
    return () => window.removeEventListener('colloq:step-cell', onStep)
  })

  /* --------------------------------------------------------- cold frame */

  /**
   * The notebook has not been read yet — neither from disk nor from the
   * network.
   *
   * `hydrated` speaks only about the replayed copy from IndexedDB, and a
   * student who opened the link for the first time has none at all: the
   * notebook was drawn empty, with live "+ Code / + Text" and a "0 cells"
   * counter, until the first frame arrived over the socket. With five hundred
   * simultaneous entries that is seconds — and a press in those seconds
   * inserted a cell into an empty document, which after the merge appeared for
   * the whole room next to the real ones.
   *
   * "Not read" and "empty" are different things, and the provider's `synced`
   * tells them apart: the server has said that our document is complete. An
   * empty notebook after `synced` is a genuinely empty notebook, and it is
   * drawn as before.
   */
  let collabSynced = $state(session.provider.synced)
  $effect(() => {
    const onSync = (isSynced: boolean) => (collabSynced = isSynced)
    session.provider.on('sync', onSync)
    // It may have synced before this notebook mounted.
    collabSynced = session.provider.synced
    return () => session.provider.off('sync', onSync)
  })
  /*
   * An empty notebook with no answer from the server — but only while an answer
   * is being AWAITED. A dropped connection is all we are going to learn: the
   * person is working offline there, and a skeleton instead of the notebook
   * would be a second lie in place of the first.
   */
  const cold = $derived(
    ids.current.length === 0 && !collabSynced && (!session.hydrated || session.connected),
  )

  /*
   * The room has something to show once the notebook is no longer unread.
   *
   * This is the last thing the splash from index.html waits for: the header,
   * the rails and the tabs are drawn from what the browser knows anyway, and
   * the centre of the screen is empty until the first socket frame. Any
   * notebook reports, including a second one opened in a tab: the splash is
   * removed once (lib/boot.ts), and the first report comes from the one the
   * person is waiting for. A dropped connection also clears `cold`: there is
   * nothing to show there, but nothing more to wait for either.
   */
  $effect(() => {
    if (!cold) firstScreenReady()
  })

  /* ----------------------------------------------------------- viewport */

  /**
   * Every mounted code cell is a CodeMirror instance, and a seminar notebook is
   * tens of them. Defer the full cell component until it is near the viewport,
   * selected, or running. Constructing hundreds of offscreen components and
   * their subscriptions took longer than the entire download on cold entry.
   * Once visited, cells keep their component and editing state; CellView only
   * parks the editor and output body at its measured height.
   *
   * A cell the observer has not ruled on yet falls back to its position, which
   * is what keeps a cold start from building forty editors before the first
   * IntersectionObserver callback lands.
   */
  const EAGER = 10
  const NEAR_MARGIN = '1200px 0px'

  let ruling = $state.raw(new Map<string, boolean>())
  let built = $state.raw<ReadonlySet<string>>(new Set())

  const watching = typeof IntersectionObserver !== 'undefined'

  /*
   * The observer is created from the very first slot — and here is why that
   * matters.
   *
   * `rootMargin` without `root` is measured from the WINDOW, and what scrolls
   * the notebook is not the window but the `<main>` above it. The window does
   * not see a cell past the edge of `<main>` at all — an ancestor clipped it —
   * and no 1200 px margin cancels that: the promised lead-in was not there by a
   * single pixel, and a cell was built exactly at the moment it touched the
   * edge of the screen. Going down this went unnoticed (what grows is below),
   * going up the cell arrived with its top already PAST the edge and
   * straightened from 240 px to its 809, carrying the whole screen down by 570.
   * That is the "jump to the start of the previous cell".
   *
   * `root` is learned from the node, not from `column`: the order in which
   * Svelte assigns `bind:this` to an ancestor and runs an action on a
   * descendant is not something worth relying on.
   */
  let viewport: IntersectionObserver | null = null

  function ensureViewport(node: HTMLElement): IntersectionObserver | null {
    if (viewport || !watching) return viewport
    viewport = new IntersectionObserver(
      (entries) => {
        let next: Map<string, boolean> | null = null
        for (const entry of entries) {
          const id = (entry.target as HTMLElement).dataset.cellSlot
          if (!id || ruling.get(id) === entry.isIntersecting) continue
          next ??= new Map(ruling)
          next.set(id, entry.isIntersecting)
        }
        if (next) ruling = next
      },
      { root: scrollerFrom(node), rootMargin: NEAR_MARGIN },
    )
    return viewport
  }

  $effect(() => () => viewport?.disconnect())

  function isNear(id: string, index: number): boolean {
    return !watching || (ruling.get(id) ?? index < EAGER)
  }

  function needsCell(id: string, index: number): boolean {
    return (active && isNear(id, index)) || session.selection.includes(id) ||
      session.selectedCellId === id || notebook.current.runningCellId === id
  }

  $effect(() => {
    built = nextBuiltCells(built, ids.current, needsCell)
  })

  function slot(node: HTMLElement, id: string) {
    node.dataset.cellSlot = id
    ensureViewport(node)?.observe(node)
    anchoring?.observe(node)
    return {
      destroy() {
        viewport?.unobserve(node)
        anchoring?.unobserve(node)
        slotHeights.delete(id)
        // In place on purpose: a ruling for a cell that no longer exists cannot
        // change anything on screen and must not schedule a render.
        ruling.delete(id)
      },
    }
  }

  /* ----------------------------------------------------------- keyboard */

  /** Two taps of D delete; the chord expires so a stray D is never destructive. */
  const CHORD_MS = 700
  let armedDeleteAt = 0

  /** True when the keystroke already belongs to whatever has focus. */
  function claimedByFocus(target: EventTarget | null, key: string): boolean {
    const element = target as HTMLElement | null
    if (!element || typeof element.closest !== 'function') return false
    if (element.isContentEditable) return true
    const tag = element.tagName
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true
    if (element.closest('.cm-editor')) return true
    // A focused control activates on Enter/Space; navigation must not eat that.
    return (key === 'Enter' || key === ' ') && element.closest('button, a, [role="button"]') !== null
  }

  /**
   * Run a cell by its own rules.
   *
   * There are deliberately no checks here: all of them are done by
   * `CellView.run` — the same function that stands behind the button on the
   * cell and behind Cmd+Enter in the editor — and it also says the words of
   * refusal. A copy of the checks in this file already drifted from the
   * original once and lied about an open cell in a lecture.
   */
  function runCell(cellId: string, step: boolean): void {
    window.dispatchEvent(new CustomEvent('colloq:run-cell', { detail: { cellId, step } }))
  }

  /**
   * Change a cell's type — by the rights ON IT, lock included, as the toolbar
   * and the server do.
   */
  function convertCell(cellId: string, to: CellType): void {
    const found = findCell(session.doc, cellId)
    if (!found) return
    const open = isCellOpen(found.cell)
    if (mayEditThisCell(may, open)) {
      setCellType(session.doc, cellId, to)
      return
    }
    // The same words as the cell itself uses: a locked cell talks about the
    // class, not about a field in the rules (see CellView · editWhy).
    const shut = cellLockMatters(may) && !mayRunThisCell(may, open)
    session.showError((shut ? tr(LECTURE_CELL) : may.editWhy) + '.')
  }

  function onkeydown(event: KeyboardEvent) {
    if (!active) return
    if (event.defaultPrevented) return
    if (claimedByFocus(event.target, event.key)) return

    /*
     * Undo, from the notebook rather than from inside a cell.
     *
     * The undo manager existed and nothing was ever bound to it: inside a cell
     * CodeMirror handles Mod+Z through yCollab, and in command mode — which is
     * where cells are DELETED, by D-D or by the trash — Ctrl+Z did nothing at
     * all. The one action the room cannot get back any other way was the one
     * action without an undo.
     *
     * Checked before the modifier guard below, which exists to let the browser
     * keep its own shortcuts and would otherwise swallow this one. By code,
     * not by key: on a Russian layout the letter is я.
     */
    if ((event.metaKey || event.ctrlKey) && !event.altKey && event.code === 'KeyZ') {
      event.preventDefault()
      if (event.shiftKey) session.undoManager.redo()
      else session.undoManager.undo()
      return
    }
    /*
     * A run from command mode — through the cell itself, not with checks of our
     * own.
     *
     * A copy of the `CellView.run` checks used to live here — and it had
     * already drifted from the original: here `may.run` was asked (the ROOM's
     * rule), while the cell and the server ask `mayRunThisCell` (the rule PLUS
     * the lock). In a lecture the teacher opens a cell: the button on it is
     * live, Cmd+Enter in the editor works, while Shift+Enter from here answered
     * with a toast about the rule — about a cell that is open. And second: from
     * a note, a `run` went out from here that the server silently throws away.
     *
     * Now the cell decides: all the checks, all the refusal words and the step
     * are in one place (CellView · colloq:run-cell). As a bonus, Cmd+Enter
     * works from here too — the notebook footer promises it in its hint line,
     * and the modifier guard below used to swallow it whole.
     */
    if (
      event.key === 'Enter' &&
      (event.metaKey || event.ctrlKey) &&
      !event.altKey &&
      !event.shiftKey
    ) {
      const { id: only } = selectionHere(session.selectedCellId, ids.current)
      if (!only) return
      event.preventDefault()
      runCell(only, false)
      return
    }
    if (event.metaKey || event.ctrlKey || event.altKey) return

    const list = ids.current
    if (list.length === 0) return
    /*
     * The selection is shared by all notebooks and is not reset when the tab
     * changes: a selection elsewhere counts as empty, otherwise `d d` would
     * delete a cell from another notebook. See command-mode.ts · selectionHere.
     */
    const { id: current, at } = selectionHere(session.selectedCellId, list)

    if (event.key === 'Enter' && event.shiftKey) {
      if (!current) return
      event.preventDefault()
      runCell(current, true)
      return
    }
    /*
     * Shift with an arrow extends the selection — before the general ban on
     * Shift below.
     *
     * The selection is extended FROM THE ANCHOR: it does not move while Shift
     * is held, and that is the same behaviour as in a file list in any system.
     * A plain arrow below collapses the selection — also as everywhere.
     */
    if (event.shiftKey && (event.key === 'ArrowUp' || event.key === 'ArrowDown')) {
      event.preventDefault()
      const edge = session.selection.length > 0 ? session.selection : current ? [current] : []
      const step = event.key === 'ArrowUp' ? -1 : 1
      /*
       * The tip is the edge by which the selection moved AWAY from the anchor,
       * not the one that matches the arrow's direction. Otherwise Shift+↑ after
       * two Shift+↓ did not shrink the range from the bottom but pulled a new
       * one upward from the anchor: 3,4,5 → 2,3, and the question to the oracle
       * went out about the wrong cells.
       *
       * The edges are taken as the minimum and the maximum, not as the first
       * and last element: with Cmd-click the selection is collected in the
       * order of the clicks.
       */
      let low = list.length
      let high = -1
      for (const id of edge) {
        const seat = list.indexOf(id)
        if (seat === -1) continue
        if (seat < low) low = seat
        if (seat > high) high = seat
      }
      const tip = high === -1 ? -1 : at === -1 ? (step === -1 ? low : high) : high !== at ? high : low
      const next = list[Math.max(0, Math.min(list.length - 1, (tip === -1 ? at : tip) + step))]
      if (next) {
        session.extendTo(next, list)
        reveal(next)
      }
      return
    }
    if (event.shiftKey) return

    /*
     * By code, not by key.
     *
     * `event.key` on a Russian layout is ф, и, ь, н, в — so every command-mode
     * shortcut simply stopped existing for anybody typing in Russian, which in
     * this product is most of the room. The physical key is what the shortcut
     * was ever about; Ctrl+` was already done this way.
     */
    switch (event.code === 'Escape' || event.key.startsWith('Arrow') || event.key === 'Enter' ? event.key : LETTERS[event.code] ?? event.key) {
      case 'ArrowUp':
        event.preventDefault()
        select(list[at <= 0 ? 0 : at - 1])
        break
      case 'ArrowDown':
        event.preventDefault()
        select(list[at < 0 ? 0 : Math.min(at + 1, list.length - 1)])
        break
      case 'Enter':
        if (!current) return
        event.preventDefault()
        enter(current)
        break
      case 'Escape':
        /*
         * There was no way at all to leave the "selected" state:
         * `selectCell(null)` was not called anywhere in the whole app, and the
         * selection lived until the page was reloaded. Escape in command mode
         * fell through to `default`.
         */
        if (session.selection.length === 0) return
        event.preventDefault()
        session.selectCell(null)
        break
      case 'a':
        event.preventDefault()
        void addAt(at < 0 ? 0 : at, 'code')
        break
      case 'b':
        event.preventDefault()
        void addAt(at < 0 ? list.length : at + 1, 'code')
        break
      /*
       * M and Y asked `may.edit` — the ROOM's rule — while the cell toolbar and
       * the server ask `mayEditThisCell`, that is, the rule plus the lock. On
       * an open lecture cell the "Convert" button was enabled, while the key
       * answered "The notebook belongs to the teacher". The refusal words come
       * from the same place the cell takes them from.
       */
      case 'm':
        if (!current) return
        event.preventDefault()
        convertCell(current, 'markdown')
        break
      case 'y':
        if (!current) return
        event.preventDefault()
        convertCell(current, 'code')
        break
      case 'd': {
        if (!current) return
        event.preventDefault()
        if (!may.remove) {
          session.showError(may.structureWhy + '.')
          break
        }
        const now = Date.now()
        if (now - armedDeleteAt < CHORD_MS) {
          armedDeleteAt = 0
          const next = list[at + 1] ?? list[at - 1] ?? null
          deleteCell(session.doc, current)
          if (next) select(next)
        } else {
          armedDeleteAt = now
        }
        break
      }
      default:
        return
    }
    if ((LETTERS[event.code] ?? event.key) !== 'd') armedDeleteAt = 0
  }

  /* --------------------------------------------------- hold to restart */

  /*
   * Restart throws away every variable in the room, and it used to be a plain
   * click on a button the same size and the same voice as Clear, two slots
   * away, in a strip the host sweeps through all seminar. The file has already
   * made this exact judgement once, on the other input path: deleting a cell by
   * keyboard is two taps of D inside CHORD_MS above, "so a stray D is never
   * destructive". The pointer path of the control that wipes the WHOLE room
   * never got it. This is that reasoning, applied where the damage is larger.
   *
   * 900ms is picked over CHORD_MS's 700 rather than being a round number: the
   * pointer is not allowed to be more forgiving than the keyboard, so 700 is
   * the floor, and a host restarting in front of twenty people should not have
   * to stand on a button for the two seconds a hold-to-delete usually takes.
   * 900 clears the floor and is still four times the longest stray click.
   *
   * Scope: the second Restart, in the kernel-dead pill below, stays an instant
   * click. The kernel is already gone there, so there is nothing left to
   * protect, and that button is the way back — slowing down the one press the
   * room is desperate to make would be theatre.
   */
  const HOLD_MS = 900

  /*
   * Letting go, and the fade after the send. WAAPI takes numbers, not custom
   * properties, so these two spell out index.css's --speed-quick (0.1s) and
   * --ease-out instead of inventing a third speed and a fourth curve. Release
   * is feedback and belongs in the 100-160ms tier; the curve is ease-out
   * because a release is something leaving.
   */
  const RELEASE_MS = 100
  const EASE_OUT = 'cubic-bezier(0.23, 1, 0.32, 1)'

  /** Physical keys the command mode uses, so the layout does not matter. */
  const LETTERS: Record<string, string> = {
    KeyA: 'a',
    KeyB: 'b',
    KeyM: 'm',
    KeyY: 'y',
    KeyD: 'd',
  }

  /*
   * Permissions — by THIS notebook, not by the room.
   *
   * A single notebook can have access of its own (shared/rules.ts ·
   * RoomRules.books): one's own personal notebook works in the middle of a
   * lecture, someone else's does not work even in an open room. This is
   * computed by the same function the server answers with — otherwise the
   * product would have two answers to "may I type here", and what would drift
   * apart would not be buttons but a button and the gate.
   */
  const may = $derived(
    permitsIn(session.session.rules, session.me.role, session.finished, {
      root,
      participantId: session.me.id,
    }),
  )
  const rules = $derived(may.rules)
  /*
   * The room follows the lecture preset.
   *
   * Not "I am not allowed anything here" but a property of the room: the bar is
   * needed by the teacher too — it explains why everything is live for them
   * alone, and why twenty people next to them are looking at a grey notebook.
   *
   * A council counts here: by permissions it is the same lecture, and "how a
   * cell opens" is not a permission, and `isLectureRoom` does not compare it. A
   * stream of five hundred people without this bar would see a grey notebook
   * without a single explanation.
   *
   * `may.rules` already has the end of class applied, and a finished class
   * reads from here as a lecture (this is said at `isLectureRoom` itself). That
   * is not a mistake, but also not something worth saying twice: after the bell
   * the room is described by its own indicator, so the bar gives way to it.
   */
  /*
   * And only where the grey notebook is explained by the ROOM.
   *
   * A notebook can have access of its own, and then it is grey not because a
   * lecture is on: the bar cannot explain "Akim's personal notebook", and what
   * it says — "the teacher edits and runs" — sends the reader looking for a
   * teacher who forbade nothing. In that case the mark on the tab and the line
   * under the cell itself (`may.bookWhy`) speak, and the bar is silent.
   *
   * What is asked is `bookRuled`, not "I am not allowed here": the teacher sees
   * the bar too — it explains to them why the class has a grey notebook — and
   * above someone else's personal notebook it is wrong for them in exactly the
   * same way.
   */
  const lecture = $derived(!may.finished && !may.bookRuled && isLectureRoom(rules))
  /*
   * In a room with a lock the margin to the left of a cell is wider — the lock
   * itself stands there — and two things lined up under the cells shift by the
   * same amount: the line to insert at and the bottom row of "Code / Text". It
   * is a property of the room, not of a cell, so it is computed here once per
   * notebook; CellView.svelte holds the width.
   */
  const gutter = $derived(cellLockMatters(may) ? '4.5rem' : '3rem')
  const mayRun = $derived(may.run)
  /* Run All and Run Above are a separate right: with "one at a time" there is
     one kernel, and that is exactly the difference between "twenty people are
     computing" and "twenty people have clogged the queue with eight hundred
     cells". */
  const mayRunAll = $derived(may.bulk)
  const restartDisabled = $derived(controlDisabled(session.connected, may.restart))
  /*
   * The room's own rule, read where the button is drawn.
   *
   * The server has enforced this since rules existed; the interface never
   * asked. A seminar set to "teacher runs the cells" showed everybody a live
   * Run button whose every press came back refused — and Shift+Enter went
   * further, stepping down the sheet and adding an empty cell at the end of
   * the shared document for a run that never happened.
   */

  let holdFill = $state<HTMLElement | null>(null)
  let holdAnim: Animation | null = null

  /** Back to a cold overlay: no fill left applied, no restart still armed. */
  function clearHold(): void {
    holdAnim = null
    for (const running of holdFill?.getAnimations() ?? []) running.cancel()
  }

  /*
   * One clock, not two. The obvious build is a CSS transition on the overlay
   * plus a setTimeout that sends the restart — and then the bar and the timer
   * agree only by luck. A throttled tab, or any rule that shortens the
   * transition, makes the bar read "done" while the send is still pending: a
   * progress indicator lying about a destructive control. Here `finished` and
   * the pixels come off the same animation, so the frame the bar fills is the
   * frame the message goes. It is also why nothing here waits on `transitionend`,
   * which a backgrounded tab never delivers at all.
   *
   * The information here is the CLOCK, not the 90px of travel, so reduced
   * motion takes the travel and keeps the clock: the tint ramps its opacity in
   * place over the same 900ms instead of sweeping across the button. A hold
   * with no visible progress is worse for that reader than one that moves —
   * they would be standing on a destructive button with no way to know how much
   * longer — and an opacity ramp reports elapsed time just as honestly while
   * displacing nothing. Being scripted rather than declarative puts this out of
   * reach of every CSS override, which is what makes this the only place the
   * preference can be honoured at all, not a reason to skip it.
   */
  /** The two ends of the fill, in whichever property this reader gets it. */
  function holdFrames(from: number, to: number): Keyframe[] {
    return prefersReducedMotion()
      ? [
          { opacity: from, transform: 'scaleX(1)' },
          { opacity: to, transform: 'scaleX(1)' },
        ]
      : [{ transform: `scaleX(${from})` }, { transform: `scaleX(${to})` }]
  }

  function startHold(): void {
    const el = holdFill
    if (!el || holdAnim || restartDisabled) return
    clearHold()
    const anim = el.animate(holdFrames(0, 1), {
      duration: HOLD_MS,
      // linear: constant motion reporting elapsed time. An eased fill would
      // misreport how much of the hold is left, and this is not an entrance.
      easing: 'linear',
      fill: 'forwards',
    })
    holdAnim = anim
    // cancel() rejects this promise, and a hold somebody let go of is not an
    // error — swallow it rather than letting it surface as an unhandled one.
    void anim.finished.then(
      () => {
        if (holdAnim === anim) fireRestart(el)
      },
      () => {},
    )
  }

  /** Every way out of a hold: fingers, keys, a dead socket, a hidden tab. */
  function cancelHold(): void {
    const anim = holdAnim
    if (!anim) return
    holdAnim = null
    // Where the fill actually is, read before the cancel wipes it: the
    // snap-back has to leave from there, not from a full bar it never reached.
    const progress = anim.effect?.getComputedTiming().progress ?? 0
    anim.cancel()
    holdFill?.animate(holdFrames(progress, 0), {
      duration: RELEASE_MS,
      easing: EASE_OUT,
      fill: 'forwards',
    })
  }

  function fireRestart(el: HTMLElement): void {
    holdAnim = null
    // A restart takes away the variables of THE notebook in whose bar it was
    // pressed.
    session.send({ t: 'restart', book })
    // The send is the one moment in this interaction that must read, and a bar
    // that simply sits full until the finger lifts hides it. The overlay
    // leaves; the `restarting…` pill at the end of this bar takes it from here.
    el.animate([{ opacity: 1 }, { opacity: 0 }], {
      duration: RELEASE_MS,
      easing: EASE_OUT,
      fill: 'forwards',
    })
  }

  /*
   * Keyboard parity, not an afterthought: the onclick this button used to carry
   * is gone, and a native <button> turns Enter into a click on keydown and
   * Space into one on keyup — leaving it would have handed the keyboard an
   * instant restart straight past the hold. So the keys drive the same hold.
   */
  function onRestartKeyDown(event: KeyboardEvent): void {
    // A finger aborts by sliding off the button; a key has nowhere to slide,
    // so Escape is its way out.
    if (event.key === 'Escape') {
      cancelHold()
      return
    }
    if (event.key !== 'Enter' && event.key !== ' ') return
    // A held key repeats; only the first one starts the clock.
    if (event.repeat) return
    // Space scrolls the page, and both keys synthesise the click removed above.
    event.preventDefault()
    startHold()
  }

  function onRestartKeyUp(event: KeyboardEvent): void {
    if (event.key === 'Enter' || event.key === ' ') cancelHold()
  }

  /*
   * The hold has to survive the room, not just the button. A tab sent to the
   * background stops painting the fill while the hold is still nominally live,
   * which is the one case where a restart could land with no visible frame of
   * warning behind it. Tearing down mid-hold is the same story from the other
   * end: the animation would outlive the notebook and resolve into a room
   * nobody is in.
   */
  $effect(() => {
    const onHidden = () => {
      if (document.hidden) cancelHold()
    }
    document.addEventListener('visibilitychange', onHidden)
    return () => {
      document.removeEventListener('visibilitychange', onHidden)
      clearHold()
    }
  })

  /*
   * And the third way the button can go quiet under the finger: CAP carries
   * `disabled:pointer-events-none`, so if the socket drops mid-hold no
   * pointerup, pointerleave or pointercancel will ever arrive, and the timer
   * would fire a restart into a session that cannot hear it.
   */
  $effect(() => {
    if (restartDisabled) cancelHold()
  })

  /* Both adders speak the artboard's caps voice; the inline one sits on a
     raised ground because it lands on top of the hairline it interrupts. */
  const ADD_LABEL = 'text-2xs font-bold uppercase tracking-label'
  const ADD =
    `inline-flex h-6 items-center gap-1.5 border border-line bg-canvas px-2.5 ${ADD_LABEL} ` +
    'text-muted transition-colors duration-[var(--speed-quick)] enabled:hover:text-ink ' +
    'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50 ' +
    // The notebook's make-up is closed — and the button shows it, as the
    // neighbouring buttons of the cell toolbar ("up", "down", "remove") do. A
    // button that can be pressed but answers with a toast reads as a breakage,
    // not as the teacher's decision.
    'disabled:pointer-events-none disabled:opacity-40'

  /*
   * Whether the run bar has more to the right than the window is showing. Only
   * true on a screen too narrow for the whole strip — a laptop never sees it.
   */
  let runBar = $state<HTMLElement | null>(null)
  let runBarMore = $state(false)
  function measureRunBar(): void {
    const el = runBar
    if (!el) return
    runBarMore = el.scrollWidth - el.clientWidth - el.scrollLeft > 4
  }
  /*
   * One read per frame, not one per event. scrollWidth, clientWidth and
   * scrollLeft each force a synchronous layout — on the only device that ever
   * sees the overflow state, a phone mid-touch-scroll, that was the frame
   * budget being spent to answer the same question twenty times between two
   * paints. (The bar's ground is opaque, not blurred: see the note on its
   * class list.)
   */
  let measureFrame = 0
  function scheduleRunBarMeasure(): void {
    if (measureFrame) return
    measureFrame = requestAnimationFrame(() => {
      measureFrame = 0
      measureRunBar()
    })
  }
  $effect(() => {
    const el = runBar
    if (!el) return
    measureRunBar()
    // Re-measure when the window changes, and when the strip itself does: the
    // terminal tab appears and disappears with the drawer.
    const observer = new ResizeObserver(scheduleRunBarMeasure)
    observer.observe(el)
    for (const child of el.children) observer.observe(child)
    return () => {
      observer.disconnect()
      if (measureFrame) cancelAnimationFrame(measureFrame)
      measureFrame = 0
    }
  })

  /*
   * The bar's width, not the window's width.
   *
   * The cell counter used to hide on `xl:` — a media query about the window.
   * But the bar is narrowed not only by a narrow screen: the panels on the
   * sides of the notebook take space from it, and browser zoom (Cmd-+) narrows
   * the CSS pixel without touching the window at all. As a result the counter
   * disappeared on a wide screen with the terminal open and stayed on a narrow
   * one where the panels were closed. We measure the space that is actually
   * there.
   */
  let barWidth = $state(0)

  /** Number of pills on the right: kernel unwell, queue non-empty, or both. */
  const chipCount = $derived(
    (kernel === 'dead' || kernel === 'off' || kernel === 'starting' || kernel === 'restarting' ? 1 : 0) +
      (queued > 0 ? 1 : 0),
  )

  /*
   * The order of retreat in the right corner — decided, not "whatever did not
   * fit gets cut off".
   *
   * The state pill matters more than the counter: it is about what is happening
   * to the kernel right now, while how many cells the notebook has can be seen
   * by scrolling. So the counter gives way, and it does so in steps: the full
   * line → a single number with a hint → nothing. The pill never gives way — it
   * is taken out of the scrolling part of the bar and stands at the right edge.
   *
   * The thresholds are the bar's width in CSS pixels, computed from the
   * content: five buttons on the left take about 650, a pill up to 160, the
   * counter about 70. Each pill raises the threshold by its own width: the
   * counter frees the space for it in advance, rather than giving it up after
   * the fact, when the pill is already being cut.
   */
  const countMode = $derived.by(() => {
    if (barWidth >= 560 + 160 * chipCount) return 'full'
    if (barWidth >= 400 + 120 * chipCount) return 'short'
    return 'none'
  })

  /*
   * The run bar is four caps-tracked words, and only the first one is filled.
   * The artboard runs each button the full height of the bar with no rounding
   * and no border, so the hover ground is the whole slot rather than a pill
   * floating inside it.
   */
  /*
   * shrink-0: the strip scrolls when the window is too narrow for it, so a
   * button that gave way would be squeezed to nothing rather than moving out of
   * view where it can be scrolled back to.
   */
  /*
   * The transition is spelled out rather than `transition-colors` plus the
   * `.press` helper, and this is the trap JoinScreen.svelte:428-441 documents:
   * a Tailwind `transition-*` utility is emitted after @layer components and
   * rewrites `transition-property` wholesale, so the helper's `transform` would
   * never be in the list and the 0.97 would snap in and snap back. Listing the
   * three properties together is the only way one control can both settle a
   * colour and travel under the finger. border-color is in the list because
   * `transition-colors` carried it and the terminal tab toggles its underline
   * with it — the point is to add the transform, not to drop a property.
   *
   * It lives in CAP rather than on one button because the strip is one strip:
   * Interrupt, Restart, Clear, Format and the terminal tab all press with the
   * same 3% and the same curve, or none of them should.
   */
  const CAP =
    'inline-flex h-full shrink-0 items-center px-3 text-2xs font-semibold uppercase tracking-wide ' +
    'text-ink transition-[color,background-color,border-color,transform] duration-press ease-out ' +
    'enabled:active:scale-[0.97] hover:bg-raised ' +
    'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset ' +
    'focus-visible:ring-accent/50 disabled:pointer-events-none disabled:opacity-40'

  /**
   * Bordered, square, mono: the voice every status readout in the sheet uses.
   *
   * It bends rather than holds firm: `shrink-0` is appropriate where there is
   * something next to it that can give way, and in the right corner of the bar
   * there is nothing to give way — a pill that would not bend poked out past
   * the edge, where `contain: paint` clipped it. The box shrinks, the word
   * inside goes into an ellipsis and remains whole in `title`: there is no such
   * thing as a truncated kernel state.
   */
  const PILL = 'inline-flex h-6 min-w-0 items-center gap-2 border px-2.5 font-mono text-2xs'

  /** Same button, at the foot of the sheet, where nothing needs to hide a rule. */
  const ADD_FOOT =
    `inline-flex h-6 items-center gap-1.5 border border-line px-2.5 ${ADD_LABEL} text-muted ` +
    'transition-colors duration-[var(--speed-quick)] enabled:hover:text-ink ' +
    'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50 ' +
    'disabled:pointer-events-none disabled:opacity-40'

  /**
   * Why a cell cannot be added — or what happens if it can.
   *
   * The reason comes from the same place as the refusal on the `a` key
   * (`addAt`) and the grey buttons of the cell toolbar: `may.structureWhy`
   * knows about the notebook's rules, the room's rules and the end of class. A
   * second copy of this question must not be set up here — once it drifted, it
   * would produce a grey button where the right exists.
   */
  const addTitle = (can: string): string => (may.add ? can : may.structureWhy)
</script>

<svelte:window {onkeydown} />

{#snippet adder(index: number)}
  <div class="group/add relative flex h-6 items-center justify-center">
    <div
      style:left={gutter}
      class="pointer-events-none absolute right-0 top-1/2 h-px bg-line-soft opacity-0
             transition-opacity duration-[var(--speed-quick)] group-hover/add:opacity-100"
    ></div>
    <!--
      Transparent means unclickable.

      `opacity-0` removes the buttons from sight, but not from hit-testing: on a
      tablet hover and press arrive in a single touch, so a tap right on the
      seam between two cells "revealed" the button and pressed it at once — a
      cell was inserted for the whole room (or, in a lecture, a refusal toast
      flew in) without a single visible warning. `pointer-events` is removed by
      the same condition that brings visibility back, so exactly what can be
      seen can be pressed; this does not get in the keyboard's way — focus moves
      to an element without a pointer too, and `focus-within` brings both back.
    -->
    <div
      class="pointer-events-none relative flex items-center gap-1 opacity-0 transition-opacity
             duration-[var(--speed-quick)] focus-within:pointer-events-auto focus-within:opacity-100
             group-hover/add:pointer-events-auto group-hover/add:opacity-100"
    >
      <button
        type="button"
        class={ADD}
        disabled={!may.add}
        title={addTitle(tr('room.ui.440'))}
        onclick={() => addAt(index, 'code')}
      >
        <Icon name="plus" size={11} /> {tr('room.ui.441')} </button>
      <button
        type="button"
        class={ADD}
        disabled={!may.add}
        title={addTitle(tr('room.ui.442'))}
        onclick={() => addAt(index, 'markdown')}
      >
        <Icon name="plus" size={11} /> {tr('room.ui.443')} </button>
    </div>
  </div>
{/snippet}

<!--
  The notebook fills its column. It used to be capped at 900px and centred, which
  on anything wider than a laptop left the cells and the whole toolbar stranded in
  the middle with empty gutters either side — the artboard shows the strip running
  edge to edge and the cells using the room they are given. The panels beside it
  are what bound the measure; this element should not bound it a second time.
-->
<!--
  `overflow-anchor: none` is not switching anchoring off but declining a SECOND
  one.

  The notebook now has its own anchor (see `settle` above), and it is precise:
  it knows which cell grew and by how much. The browser's did not fire in this
  container anyway — measured: a cell above the screen grew by 569 px,
  `scrollTop` did not change — but one cannot rely on it staying silent in the
  future: should it fire once, both would correct, and the screen would move
  twice as far.
-->
<!-- svelte-ignore a11y_no_static_element_interactions -->
<div
  bind:this={column}
  class="w-full pb-40 [overflow-anchor:none]"
  onwheelcapture={() => {
    steering = null
    handedOver = true
  }}
  ontouchmovecapture={() => {
    steering = null
    handedOver = true
  }}
  onpointerdowncapture={() => (steering = null)}
>
  <!--
    The mode bar is above the notebook and NOT sticky, unlike the row of buttons
    under it.

    It is not a state that is watched but a condition people work under: it is
    read once, on entering the room. Pinned to the top, it would take a line of
    the screen from every cell until the end of class; scrolled away, it leaves
    in its place the locks on the cells themselves, which say the same thing
    right where people press.

    Warm, not alarming: nothing has broken in a lecture. That is what sets it
    apart from the yellow warnings in this product: it has neither an
    "attention" icon nor a button — only a lock, a word and an explanation.
  -->
  {#if lecture}
    <div
      class="flex flex-wrap items-center gap-x-2.5 gap-y-1 border-b border-line
             bg-warning/[0.07] px-4 py-2"
    >
      <Icon name="lock" size={13} class="shrink-0 text-warning" />
      <span class="text-ui font-semibold text-ink">{tr('room.ui.444')}</span>
      <span class="text-ui text-muted"> {tr('room.ui.445')} </span>
    </div>
  {/if}
  <!--
    The bar is two slots, not one scrolling row.

    The buttons and the state lay in one `overflow-x-auto`, and the right edge
    of the bar belonged to it too: on a narrow screen — or with zoom, which
    narrows the CSS pixel just as narrowing the window does — the kernel state
    slid off the edge together with "Format", and the fade placed there to hint
    at scrolling dimmed exactly the spot where that state is written. Now the
    actions scroll; the state stays put and does not fade.
  -->
  <!-- A marker for the scroll computation: the bar is sticky and covers the top
       of the screen, so the "top of the screen" for a cell starts below it. -->
  <div
    data-notebook-bar
    bind:clientWidth={barWidth}
    class="sticky top-0 z-30 mb-4 flex h-11 items-stretch border-b border-line bg-canvas
           [contain:paint] min-[651px]:h-10"
  >
    <!--
      An opaque backdrop, not a blurred one.

      The bar is sticky and hangs over a notebook of two hundred cells, and
      `backdrop-blur` makes the browser recompute the backdrop blur on EVERY
      scroll frame — on the integrated graphics of a student's laptop that is an
      expensive layer for the whole session. People look at the bar for the
      buttons, not for what is under it; `contain: paint` on the bar cuts its
      painting off from the rest of the page.
    -->
    <div
      bind:this={runBar}
      onscroll={scheduleRunBarMeasure}
      class={cn(
        `flex min-w-0 flex-1 items-center overflow-x-auto overflow-y-hidden
         [scrollbar-width:none] [&::-webkit-scrollbar]:hidden`,
        // A phone fits Run all, Interrupt, Restart and Clear and no more, and the
        // bar cut off flush with the screen edge: the terminal was still there,
        // one swipe away, with nothing on screen to say so. The fade is the only
        // thing that says the row continues. It covers only the actions: the
        // state stands further to the right and takes no part in the scrolling.
        runBarMore && '[mask-image:linear-gradient(to_right,#000_calc(100%-40px),transparent)]',
      )}
    >
      <button
        type="button"
        class="inline-flex h-full shrink-0 items-center gap-2 bg-primary px-5 text-2xs font-bold uppercase
               tracking-label text-primary-ink transition-[opacity,transform] duration-press ease-out
               enabled:active:scale-[0.97] hover:opacity-90 focus-visible:outline-none focus-visible:ring-2
               focus-visible:ring-inset focus-visible:ring-primary-ink/60
               disabled:pointer-events-none disabled:opacity-40"
        disabled={controlDisabled(session.connected, mayRun && mayRunAll)}
        title={controlTitle(
          session.connected,
          !mayRun ? may.runWhy : mayRunAll ? tr('room.extra.177') : may.bulkWhy,
        )}
        onclick={() => session.send({ t: 'runAll', book })}
      >
        <Icon name="play" size={12} /> {tr('room.ui.446')} </button>
      <button
        type="button"
        class={CAP}
        disabled={controlDisabled(session.connected, canInterrupt)}
        title={controlTitle(
          session.connected,
          canInterrupt ? tr('room.extra.151') : tr('room.extra.152'),
        )}
        onclick={() => session.send(interruptMessage())}
      > {tr('room.ui.395')} </button>
      <!--
        Hold, not click — the reasoning and the 900ms are at HOLD_MS above. This
        is the one place in the notebook where slow is right: the user is
        deciding, so the press takes its time, while everything the system
        answers with stays fast. The press comes from CAP, which carries it for
        the whole strip: the `.press` helper cannot be used beside a Tailwind
        `transition-*` utility, because the utility rewrites transition-property
        and leaves the helper's transform out of it.
      -->
      <button
        type="button"
        class={cn(CAP, 'relative select-none overflow-hidden')}
        disabled={restartDisabled}
        aria-label={tr('room.ui.447')}
        title={controlTitle(
          session.connected,
          may.restart
            ? tr('room.extra.180')
            : may.restartWhy,
        )}
        onpointerdown={(event) => {
          // A secondary button opens a context menu instead of pressing, and must
          // not arm a restart on its way there.
          if (event.button === 0) startHold()
        }}
        onpointerup={cancelHold}
        onpointerleave={cancelHold}
        onpointercancel={cancelHold}
        onblur={cancelHold}
        onkeydown={onRestartKeyDown}
        onkeyup={onRestartKeyUp}
      >
        <!--
          Scaled, not clipped and not resized: the vocabulary is the upload bar's
          in FilesPanel, where a width transition would relayout on every progress
          event and only transform is allowed to move. It is the first child so
          the label, which is positioned, keeps painting on top of the tint.
        -->
        <span
          bind:this={holdFill}
          aria-hidden="true"
          class="pointer-events-none absolute inset-0 origin-left bg-danger/[0.18]"
          style="transform: scaleX(0)"
        ></span>
        <span class="relative">{tr('room.ui.448')}</span>
      </button>
      <button
        type="button"
        class={CAP}
        disabled={controlDisabled(session.connected, may.wipe)}
        title={controlTitle(session.connected, may.wipe ? tr('room.extra.181') : may.wipeWhy)}
        onclick={() => session.send({ t: 'clearOutputs', book })}
      > {tr('room.ui.449')} </button>
      <!--
        Formatting sits here, not in the cell menu: it is about the whole
        notebook. A cell that black cannot read — magic, a line with !, or code
        that is being written right now — it leaves as is and moves on, and that
        is exactly why there is one button for the whole panel rather than one
        per cell.
      -->
      <button
        type="button"
        class={CAP}
        disabled={controlDisabled(session.connected, may.edit && may.bulk)}
        title={controlTitle(
          session.connected,
          !may.edit
            ? may.editWhy
            : !may.bulk
              ? may.bulkWhy
              : tr('room.extra.182'),
        )}
        onclick={() => session.send({ t: 'format', book })}
      > {tr('room.ui.450')} </button>
    </div>

    <!--
      The artboard's run bar carries the queue and the cell count and nothing
      else — a healthy kernel is reported in the masthead. An unhealthy one is
      not reported anywhere else yet, so it keeps its pill here.

      The corner does not scroll and is pinned to the right: a pill comes and
      goes, but it grows to the left, towards the scrolling buttons — the
      counter at the right edge does not move by a pixel, and nothing in the bar
      jumps. 70% is the ceiling: on a phone two pills at once need about 240 px,
      and that is exactly enough for both to read in full while the buttons
      still have something to pull the bar by.
    -->
    <div class="flex max-w-[70%] shrink-0 items-center gap-2.5 pl-2.5 pr-5">
      {#if kernel === 'dead'}
        <!-- animate-fade-up is the product's "appeared"; under
             prefers-reduced-motion index.css leaves only a fade-in without
             movement from it. -->
        <span
          class={cn(PILL, 'animate-fade-up border-danger/40 bg-danger/[0.05] text-danger')}
          title={tr('room.ui.451')}
        >
          <span class="h-1.5 w-1.5 shrink-0 rounded-full bg-danger"></span>
          <span class="truncate">{tr('room.ui.451')}</span>
          <!-- By the rule, not by the role: the button in the bar listens to
               may.restart, and in an open lab without a teacher a pill without
               a button left students guessing that Restart was somewhere up
               there.

               At the narrowest step it is not here: it stands 110 px next to
               the word the pill is read for, and right there, two fingers to
               the left, is its twin in the bar itself. The duplicate gives way,
               not the state; shrink-0 is so that where the button is present,
               the word shrinks rather than the way out. -->
          {#if may.restart && countMode !== 'none'}
            <button
              type="button"
              class="shrink-0 text-2xs font-bold uppercase tracking-label text-ink
                     transition-opacity duration-[var(--speed-quick)] hover:opacity-70
                     focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-danger/40
                     disabled:pointer-events-none disabled:opacity-40"
              disabled={controlDisabled(session.connected)}
              title={controlTitle(session.connected, tr('room.extra.184'))}
              onclick={() => session.send({ t: 'restart', book })}
            > {tr('room.ui.448')} </button>
          {/if}
        </span>
      {:else if kernel === 'off'}
        <!-- The kernel is started lazily, and "not started" is not a trouble
             but a fact: no pulse, no alarm colour. The hint says how to start
             it. -->
        <span class={cn(PILL, 'border-line text-faint')} title={tr('room.kernel.state.offWhy')}>
          <span class="h-1.5 w-1.5 shrink-0 rounded-full bg-faint/60"></span>
          <span class="truncate">{tr('room.kernel.state.off')}</span>
        </span>
      {:else if kernel === 'starting' || kernel === 'restarting'}
        <!-- Opacity, not a background sweep: the same information for one
             composited property instead of a repaint every frame. A pulse here
             instead of an entrance: two animations on one element fight over
             animation, and a breathing pill already says "something is
             happening". -->
        {@const label =
          kernel === 'starting' ? tr('room.kernel.starting') : tr('room.kernel.restarting')}
        <span class={cn(PILL, 'animate-pulse border-line text-muted')} title={label}>
          <span class="h-1.5 w-1.5 shrink-0 rounded-full bg-faint"></span>
          <span class="truncate">{label}</span>
        </span>
      {/if}

      {#if queued > 0}
        <span
          class={cn(PILL, 'animate-fade-up border-line text-muted')}
          title={`${queued} ${tr('room.ui.453')} — ${tr('room.ui.452')}`}
        >
          <span class="h-1.5 w-1.5 shrink-0 rounded-full bg-muted"></span>
          <span class="truncate">{queued} {tr('room.ui.453')}</span>
        </span>
      {/if}
      <!-- The least load-bearing thing in the strip, and the first to go when
           there is not room for all of it: how many cells there are is visible
           by scrolling the notebook. The steps belong to countMode: first the
           line shrinks to a single number and the word goes into the hint, and
           only then does the number disappear altogether. -->
      <!-- Until the notebook has been read there is no counter at all: "0
           cells" on a cold frame is not a number, it is a lie. -->
      {#if !cold && countMode !== 'none'}
        {@const count = ids.current.length}
        <span
          class="shrink-0 pl-0.5 font-mono text-2xs tabular-nums text-muted"
          title={countMode === 'short'
            ? tr('room.notebook.cellCount', { count })
            : undefined}
        >
          {countMode === 'short' ? count : tr('room.notebook.cellCount', { count })}
        </span>
      {/if}
    </div>
  </div>
  <!-- 24px, the artboard's: its cells are 822 wide in an 868 column, while the
       run bar above them is the full 868 and touches both panels. -->
  <div class="px-6">

  {#if cold}
    <!--
      A splash, not a skeleton of cells: grey "cells" promised a notebook nobody
      had seen yet — how many there are, what they are like, and whether there
      are any at all. A splash promises only waiting, and that is the only thing
      known here. A cold entry usually does not show it at all: the shell from
      index.html hangs until the notebook has been read (lib/boot.ts) — this one
      remains for switching tabs and for a second notebook opened on a live
      screen.
    -->
    <Splash size="pane" label={tr('room.ui.454')} />
  {:else}
  {#each ids.current as id, index (id)}
    {@const showCell = built.has(id) || needsCell(id, index)}
    {#if showCell}
      {@render adder(index)}
    {:else}
      <div class="h-6" aria-hidden="true"></div>
    {/if}
    <div use:slot={id}>
      {#if showCell}
      <CellView
        {id}
        {index}
        bookRoot={root}
        last={index === ids.current.length - 1}
        selected={session.selection.includes(id)}
        anchor={session.selectedCellId === id}
        near={isNear(id, index)}
        onselect={(event) => pick(id, event)}
      />
      {:else}
        <!-- Keep jump/selection targets and an estimated scroll position even
             before the cell's subscriptions and toolbar have been built. -->
        <div data-cell-id={id} data-cell-deferred class="h-[240px]" aria-hidden="true"></div>
      {/if}
    </div>
  {/each}

  {@render adder(ids.current.length)}

  <div
    style:padding-left={gutter}
    class={cn('mt-1 flex flex-wrap items-center gap-3', ids.current.length === 0 && 'mt-8')}
  >
    <button
      type="button"
      class={ADD_FOOT}
      disabled={!may.add}
      title={addTitle(tr('room.ui.455'))}
      onclick={() => addAt(ids.current.length, 'code')}
    >
      <Icon name="plus" size={11} /> {tr('room.ui.441')} </button>
    <button
      type="button"
      class={ADD_FOOT}
      disabled={!may.add}
      title={addTitle(tr('room.ui.456'))}
      onclick={() => addAt(ids.current.length, 'markdown')}
    >
      <Icon name="text" size={11} /> {tr('room.ui.443')} </button>
    <div class="h-px flex-1 bg-line-soft"></div>
    <!-- Shift+Enter and the platform's own modifier now mean different things —
         run and move on, run and stay — so the hint says both. `modKey` reads
         ⌘ on a Mac and Ctrl everywhere else. -->
    <span class="hidden min-w-0 flex-[1_1_300px] whitespace-normal font-mono text-2xs text-muted sm:inline"> {tr('room.ui.457')} {modKey}{tr('room.ui.458')} </span>
  </div>
  {/if}
  </div>
</div>
