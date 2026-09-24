<script lang="ts" module>
  import { tr, getLocale } from '@shared/i18n'
  import { api } from '@/lib/api'
  import { actionAllowedIn, councilLetters } from '@shared/protocol'

  /**
   * "Fix with AI" is drawn only where there is an oracle that will take a
   * 'fix'. An oracle in hints mode is on, and would refuse this button — so
   * `enabled` alone is the wrong question and actionAllowedIn is the right one,
   * asked with the same function the route refuses with.
   *
   * Every failing cell asks the same question, so the answer is fetched once
   * per tab and shared: a status request per cell would be one request per
   * traceback.
   */
  let oracle: Promise<{ enabled: boolean; mode: 'off' | 'hints' | 'full' }> | null = null

  /**
   * What the instance allows, once per tab.
   *
   * Narrowing to this room happens at the call site: the instance's answer
   * knows nothing about a seminar, and a room may be stricter than it. Asked
   * here it would draw "Fix with AI" in a hints-only seminar and every press
   * would come back 403.
   */
  function oracleStatus(): Promise<{ enabled: boolean; mode: 'off' | 'hints' | 'full' }> {
    oracle ??= api
      .aiStatus()
      .then((status) => ({ enabled: status.enabled, mode: status.mode }))
      .catch((cause: unknown) => {
        /*
         * A refusal is not remembered. It used to turn into a stub "there is
         * no oracle", and a tab opened at the moment of a server restart drew
         * no "Fix with AI" under any traceback until the end of class, even
         * though the oracle panel next to it asks for the status again and
         * shows the model.
         */
        oracle = null
        throw cause
      })
    return oracle
  }
</script>

<script lang="ts">
  import { onMount, tick, untrack } from 'svelte'
  import { slide } from 'svelte/transition'
  import { quintOut } from 'svelte/easing'
  import * as Y from 'yjs'
  import { Awareness } from 'y-protocols/awareness'
  import {
    bookCells,
    cellSource,
    cellType,
    COUNCIL_SHARED_KERNEL_NOTE,
    DEFAULT_COUNCIL,
    MAX_ATTEMPT_CHARS,
    patchIsStale,
    replaceText,
    type CellLock,
  } from '@shared/notebook'
  import { diffCounts, diffLines } from '@shared/diff'
  import type { AiAction } from '@shared/protocol'
  import { actsAfterClass, CLASS_IS_OVER, oracleModeIn, readRules } from '@shared/rules'
  import {
    cellLockMatters,
    COUNCIL_CLOSED,
    COUNCIL_SHARED_CELL,
    LECTURE_CELL,
    mayEditThisCell,
    mayRunThisCell,
    mayRunThisCouncil,
    mayWriteThisCouncil,
    permitsIn,
  } from '@/lib/may'
  import {
    attemptCounter,
    attemptInSync,
    attemptTooLong,
    countLine,
    queueWords,
    ranByLine,
    sheetSeed,
    watchCellLock,
  } from '@/lib/council.svelte'
  import { pauseClock, pauseLeftMs } from '@/lib/council-pause'
  import { clock } from '@/lib/history'
  import CouncilOnScreen from '@/components/council/CouncilOnScreen.svelte'
  import {
    beatsAlive,
    focusPult,
    looksFullscreen,
    openPult,
    pultReach,
    watchPult,
    type PultBeat,
  } from '@/lib/council-pult-window'
  import Avatar from '@/components/ui/Avatar.svelte'
  import Icon, { type IconName } from '@/components/ui/Icon.svelte'
  import CodeLine from '@/components/ui/CodeLine.svelte'
  import {
    deleteCell,
    hasPendingRun,
    insertCellAfter,
    ONE_AT_A_TIME,
    setCellType,
  } from '@/lib/notebook-ops'
  import { controlDisabled, controlTitle } from '@/lib/controls'
  import { lockHint, lockLabel, lockPress } from '@/lib/lock-button'
  import { getSessionState } from '@/lib/session.svelte'
  import { jumpToDefinition, landingInCell } from '@/lib/goto.svelte'
  import { cn, elapsed, NOTICED_MS, prefersReducedMotion, spell } from '@/lib/utils'
  import { copyText } from '@/lib/clipboard'
  import { diffTokens, loadSyntax, syntax } from '@/lib/syntax.svelte'
  import {
    watchCell,
    watchCellMeta,
    watchCellPeers,
    watchBookKernel,
    watchOutputs,
    watchOracleBusy,
    watchPatchFor,
    watchText,
  } from '@/lib/yreactive.svelte'
  import { runSlot } from '@/lib/run-slot'
  import {
    nextHeld,
    NO_HELD,
    outputSeat,
    runMark,
    unnumberedResult,
    type Held,
  } from '@/lib/output-seat'
  import { emptyCellIsRemovable } from './cell-keys'
  import CellOutputs from './CellOutputs.svelte'
  import CodeEditor from './CodeEditor.svelte'
  import Markdown from './Markdown.svelte'

  interface Props {
    id: string
    /** The root of the notebook this cell is in: see Notebook.svelte. */
    bookRoot: string
    index: number
    /** Last in the notebook: there is no "down" for it, and the button shows that. */
    last: boolean
    /** The cell is part of the selection; there may be several. */
    selected: boolean
    /**
     * The very one the keyboard and the caret work with.
     *
     * Separate from `selected`, because when several cells are selected
     * exactly one of them stays the anchor: the range is measured from it,
     * Enter goes into it, and the room sees it as "editing cell 04".
     */
    anchor?: boolean
    /** False while the cell sits far outside the viewport; see Notebook.svelte. */
    near?: boolean
    onselect: (event?: MouseEvent | PointerEvent) => void
  }

  let {
    id,
    bookRoot,
    index,
    last,
    selected,
    anchor = false,
    near = true,
    onselect,
  }: Props = $props()

  /**
   * The texts of this notebook's code cells, for the help, so that it knows
   * the notebook's imports.
   *
   * A call, not a value: there is no point reading eighty `Y.Text`s on every
   * re-render of a cell, and the help asks for them only on hover, no more
   * than once every third of a second and only where the window can appear
   * at all (lib/hover-target.ts). Cells of other notebooks do not get in
   * here: `np` in a lecture and `np` in a seminar are different kernels and
   * different imports.
   */
  function codeSources(): string[] {
    const out: string[] = []
    const cells = bookCells(session.doc, bookRoot)
    for (let i = 0; i < cells.length; i++) {
      const cell = cells.get(i)
      if (cellType(cell) !== 'code') continue
      out.push(cellSource(cell).toString())
    }
    return out
  }

  const session = getSessionState()
  const cell = watchCell(session.doc, () => id)
  const meta = watchCellMeta(() => cell.current)
  /**
   * The oracle is busy with THIS cell right now.
   *
   * The gesture is made with a button above the cell, and the answer comes
   * into the panel, and when the panel is collapsed there is nothing at all
   * between the press and the appearance of a suggestion: whether it took
   * the task, whether it is queued, whether the server refused, none of it
   * can be read from the screen. The flag clears itself however the turn
   * ended: `state` leaves `streaming` both on an answer and on an error.
   */
  const oracleAt = watchOracleBusy(session.doc, () => id)
  const oracleBusy = $derived(oracleAt.current)

  const isCode = $derived(meta.current.type === 'code')
  // The room's own rule, read where the button is drawn — the server has
  // enforced it since rules existed and the interface never asked.
  /*
   * What is allowed in this room, in one place. A rule that stops something
   * must say so where people press, and BEFORE the press: a button that
   * silently does nothing reads as a breakage and comes back as a bug
   * report.
   */
  const may = $derived(
    // By the rules of THE NOTEBOOK the cell lives in: a personal notebook has
    // its own answer to "who types and runs here" (shared/rules.ts ·
    // rulesForBook), and the server answers the same. The root comes as a
    // prop: looking it up from the cell would mean walking the document on
    // every re-render of every cell.
    permitsIn(session.session.rules, session.me.role, session.finished, {
      root: bookRoot,
      participantId: session.me.id,
    }),
  )
  /*
   * The lock on this cell, and the three derivatives the whole component
   * lives on.
   *
   * Permissions are computed by shared/rules.ts with the same functions as
   * on the server: the component does not combine the room rule with the
   * cell's field itself. Otherwise the product would have two answers to the
   * question "may I type here", and they would start to diverge not at the
   * button but at the gate that silently rejects the edit.
   *
   * `lock` is whether to draw the lock at all. In a room where a participant
   * types and runs anyway, there is nothing to open, and an icon there would
   * be decoration; after the bell all the more so: there it has its own
   * reason and its own words.
   */
  const cellOpen = $derived(meta.current.open)
  const lock = $derived(cellLockMatters(may))
  const mayEdit = $derived(mayEditThisCell(may, cellOpen))
  const mayRun = $derived(mayRunThisCell(may, cellOpen))
  /** Closed for YOU: for the teacher the lock hangs there but locks nothing. */
  const shut = $derived(lock && !mayEdit && !mayRun)
  /*
   * One phrase instead of the room rule, by the same argument as
   * `CLASS_IS_OVER` in may.ts: hearing "the notebook belongs to the teacher"
   * where a cell is opened with one press means going off to look for the
   * wrong thing.
   */
  /*
   * The notebook's words come before the room's.
   *
   * `LECTURE_CELL` is written about a lecture ("only the teacher edits and
   * runs this cell"), and in someone else's personal notebook it is untrue:
   * its author edits it. `may.bookWhy` is non-empty exactly when the
   * NOTEBOOK closed it, and then the notebook speaks, in the same words the
   * server answers with (collab/gate.ts).
   */
  const editWhy = $derived(may.bookWhy ?? (shut ? tr(LECTURE_CELL) : may.editWhy))
  /*
   * Whether this person acts after the bell, for what has no rule: answering
   * `input()`, declining an oracle suggestion. The same `actsAfterClass` the
   * server answers with.
   */
  const acts = $derived(actsAfterClass(may.finished, session.me.role))

  /* -------------------------------------------------------------- council */

  /*
   * The lock's third position is the council: a sheet for everyone.
   *
   * `meta.current.open` does not know about it on purpose (for the gate and
   * `mayEditCell` the council is a closed cell), so the position as a whole
   * is read by its own watcher. From there, three roles in one cell: a
   * student writes THEIR OWN sheet (`ownSheet`), the teacher sees the shared
   * text as the reference and the console under it (`leads`), and
   * everything else is as for a closed cell.
   */
  const lockView = watchCellLock(() => cell.current)
  const lockState = $derived(lockView.current.lock)
  const inCouncil = $derived(lockState === 'council')
  const councilSettings = $derived(lockView.current.settings ?? DEFAULT_COUNCIL)
  /** The teacher runs the council, after the bell too (may.ts · council). */
  const leads = $derived(may.council)
  /** The body is one's own editor, not the shared one: a student in an open council. */
  const ownSheet = $derived(inCouncil && !leads)
  const mine = $derived(session.council.mine[id] ?? null)
  /**
   * The teacher's letters, separately and in the order they were sent.
   *
   * There are at most two: a personal one and a message to the group, and
   * they live side by side without overwriting each other
   * (shared/protocol · councilLetters). The glued version in `mine.reply`
   * remains only for older clients: in one paragraph two letters read as
   * one: "Check the sign Everyone: a correction".
   */
  const letters = $derived(councilLetters(mine))
  const count = $derived(session.council.counts[id] ?? null)
  const board = $derived(session.council.boards[id] ?? null)
  /**
   * What the teacher put on screen for this cell; it arrives for the WHOLE
   * room.
   *
   * Showing no longer rewrites the cell's shared text: it arrives as a
   * signed banner under the same cell (shared/protocol.ts · CouncilShown),
   * and the teacher's starter text stays in place for everyone.
   */
  const onScreen = $derived(session.council.shown[id] ?? null)
  /**
   * The author gets no second banner: their code is in front of them anyway,
   * and two identical blocks in a row read as a mistake. The author learns
   * about it before anyone else, from the green "Your answer is on screen"
   * in the footer of their own sheet.
   */
  /*
   * And the lock has nothing to do with it: this is a request from the class
   * of 20 Sep 2026.
   *
   * The teacher closes the council to stop the work: so that people stop
   * editing sheets, submitting and taking places in the queue. The shown
   * solution used to vanish for the whole class at that point, together
   * with the discussion it had been put up for. Showing lives a life of its
   * own: the server stores it and removes it only on "take off the screen"
   * (control.ts · council:show:clear, which does not ask about the lock), so
   * the condition here was superfluous, not protective.
   */
  const showsOnScreen = $derived(
    onScreen !== null && onScreen.participantId !== session.me.id,
  )
  /*
   * The council on this cell is closed, by the lock or by the server's word.
   * The lock arrives as a CRDT frame, `mine.closed` over the socket; which of
   * the two gets here first is unknown, and either one closes it.
   */
  const councilClosed = $derived(!inCouncil || (mine?.closed ?? false))
  const mayAttempt = $derived(mayWriteThisCouncil(may, councilClosed))
  const mayRunAttempt = $derived(mayRunThisCouncil(may, councilSettings.studentRun))
  const mayRequestRun = $derived(mayAttempt && councilSettings.studentRun === 'request')
  const attemptRunning = $derived(mine?.run?.state === 'queued' || mine?.run?.state === 'running')
  const submittedAt = $derived(mine?.submittedAt ?? null)
  const attemptWhy = $derived(inCouncil ? may.attemptWhy : tr(COUNCIL_CLOSED))

  /**
   * One's own sheet: a local Yjs document, connected to nothing.
   *
   * The same CodeEditor as the cell's, which only knows Y.Text with presence
   * and undo, so instead of a second editor there is a second document here:
   * its own Y.Doc, its own presence (going nowhere), its own undo. Not a
   * single edit to the shared Y.Text comes from here, nor can it: there is
   * no shared text in this document.
   *
   * It lives until unmount, not until the council closes: a closed council
   * leaves the text to the person as a draft, and the draft is this.
   */
  interface Sheet {
    doc: Y.Doc
    text: Y.Text
    awareness: Awareness
    undo: Y.UndoManager
  }
  /** The origin of edits that came from the server, not from the keyboard. */
  const SEED = 'council:seed'

  function openSheet(seed: string): Sheet {
    const doc = new Y.Doc()
    const text = doc.getText('attempt')
    if (seed) doc.transact(() => text.insert(0, seed), SEED)
    return {
      doc,
      text,
      awareness: new Awareness(doc),
      undo: new Y.UndoManager(text, { trackedOrigins: new Set([null]), captureTimeout: 400 }),
    }
  }

  let sheet = $state.raw<Sheet | null>(null)
  /**
   * Whether the person has typed in their sheet even once.
   *
   * A plain `let`, not `$state`: it is read by effects that write into the
   * Y.Text, and a signal here would mean an effect depending on its own
   * consequence.
   */
  let typed = false
  /**
   * What is on the sheet right now, as a string, for the sake of two
   * questions about it.
   *
   * A signal, unlike `typed`: the character counter under the sheet is drawn
   * from it and "submitted" is checked against it. The string is not an
   * extra copy here: the observer does `toString()` on every edit anyway, to
   * hand the snapshot to the queue.
   */
  let sheetText = $state('')
  /** How many characters the attempt has, or null while the ceiling is far off. */
  const attemptCount = $derived(attemptCounter(sheetText.length))
  /** The sheet is too long: the server would reject its snapshot, so none is sent. */
  const attemptOver = $derived(attemptTooLong(sheetText))
  /**
   * The teacher holds exactly what the person sees on the sheet.
   *
   * Checked only for the sake of "submitted": what gets submitted is WHAT
   * THE SERVER HOLDS, and after a snapshot that did not go out (a sheet over
   * the ceiling, a refusal, a lost draft), "submitted" under a long text
   * would be untrue in what matters.
   */
  const attemptSynced = $derived(attemptInSync(mine, sheetText))

  $effect(() => {
    if (!ownSheet) return
    if (untrack(() => sheet)) return
    /*
     * The initial text is one's own attempt, if the server has already sent
     * it, otherwise the task (sheetSeed: an empty string from the server is
     * not an attempt). The task is `mine.seed`, the cell's text at the moment
     * the lock was switched to council, not what is in the cell now: after
     * "Show to class" someone else's solution is there. Until the server
     * sends a seed, the old behaviour stays. Read without tracking: the sheet
     * is started once, not on every letter of the reference.
     */
    const seed = untrack(() => sheetSeed(mine?.text, mine?.seed ?? liveText.current))
    sheet = openSheet(seed)
  })

  /*
   * The attempt arrived after the sheet had already been started from the
   * shared text, and the person has not typed anything yet: replace. If they
   * typed, their text outranks any snapshot, including the echo of their own
   * snapshot.
   *
   * An empty text from the server is not an attempt but "no attempt yet"
   * (the welcome batch for a cell with an open council): it must not be
   * used to wipe the task off the sheet.
   */
  /*
   * And the same for the task: `mine.seed` may arrive after the sheet has
   * already been started from the shared text (the welcome batch and the
   * CRDT frame arrive in any order). While the person has not typed, the
   * task outranks the snapshot of the shared cell.
   */
  $effect(() => {
    const current = sheet
    // The same rule as `sheetSeed`: one's own attempt outranks the task. The
    // difference from the old code is in the check: `undefined` means "the
    // server said nothing" (an old server, no field), while an empty string
    // means "the task is empty", and that is exactly what the sheet must be
    // cleared with: otherwise the shown solution would remain in it.
    const text = mine?.text || mine?.seed
    if (!current || text === undefined || typed) return
    if (current.text.toString() === text) return
    current.doc.transact(() => replaceText(current.text, text), SEED)
  })

  /*
   * A snapshot on a pause in typing. An observer on the Y.Text, not on key
   * presses: that way pasting, undo and autocompletion are caught too. Edits
   * with the SEED origin are not typing and do not go out: otherwise a
   * snapshot's echo would spawn the next snapshot.
   */
  $effect(() => {
    const current = sheet
    if (!current) return
    const onChange = (_event: Y.YTextEvent, transaction: Y.Transaction) => {
      // The mirror comes before every exit: the counter under the sheet must
      // count both what arrived as the task and what will no longer go out as
      // a snapshot.
      sheetText = current.text.toString()
      if (transaction.origin === SEED) return
      typed = true
      if (!mayAttempt) return
      // Over the ceiling `draft` neither takes nor sends a snapshot
      // (council.svelte.ts): the server rejects it in words, that is, with a
      // toast on every pause in typing. Instead of a toast, the counter under
      // the sheet: a single one, silent while it does not matter.
      session.council.draft(id, sheetText)
    }
    sheetText = current.text.toString()
    current.text.observe(onChange)
    return () => current.text.unobserve(onChange)
  })

  // Presence holds a timer, the document holds memory; both leave with the cell.
  $effect(() => () => {
    const current = untrack(() => sheet)
    if (!current) return
    current.undo.destroy()
    current.awareness.destroy()
    current.doc.destroy()
  })

  /*
   * "Submit" and "Edit" wait for the server's echo, and until then the
   * button shows it.
   *
   * The attempt's look is changed only by `council:mine` from the server,
   * and between the press and that there was nothing: no dimmed button, no
   * word. With five hundred simultaneous submissions on a loaded network a
   * person presses again and again, and every press is one more
   * `council:submit`. The flag is local and honest: it says "sent", not
   * "submitted", and it is cleared EITHER by the echo or by its own
   * deadline: eight seconds of silence do not happen without a reason, and
   * that reason must be put into words.
   */
  let awaitingMine = $state<'submit' | 'withdraw' | null>(null)
  let awaitTimer: number | undefined
  const MINE_WAIT_MS = 8000

  function awaitMine(what: 'submit' | 'withdraw'): void {
    window.clearTimeout(awaitTimer)
    awaitingMine = what
    awaitTimer = window.setTimeout(() => {
      awaitingMine = null
      session.showError(
        what === 'submit'
          ? tr('room.ui.407')
          : tr('room.ui.408'),
      )
    }, MINE_WAIT_MS)
  }

  $effect(() => {
    const now = submittedAt
    const want = untrack(() => awaitingMine)
    if (want === null) return
    if (want === 'submit' ? now === null : now !== null) return
    awaitingMine = null
    window.clearTimeout(awaitTimer)
  })

  $effect(() => () => window.clearTimeout(awaitTimer))

  /** "Submit". Returns whether it got as far as sending, for the keys. */
  function submitAttempt(): boolean {
    if (!mayAttempt) {
      session.showError(attemptWhy + '.')
      return false
    }
    // A second press while the first is on its way is a second
    // `council:submit`, and that is exactly what people press when "nothing
    // happened".
    if (awaitingMine !== null || submittedAt !== null) return false
    /*
     * What the server does not have cannot be submitted.
     *
     * Over the ceiling the snapshot does not go out, while `council:submit`
     * submits WHAT THE SERVER HOLDS: the press would mark the previous, short
     * text as submitted: the student has one sheet on screen, the teacher
     * another in the stack, and this comes out at the review, when it is too
     * late to rewrite. A refusal in words and with a number: from it one can
     * see how much to cut.
     */
    if (attemptOver) {
      session.showError(
        tr('room.ui.409', { p0: attemptCount ?? '' }),
      )
      return false
    }
    onselect()
    awaitMine('submit')
    session.council.submit(id)
    return true
  }

  function withdrawAttempt(): void {
    if (!mayAttempt) {
      session.showError(attemptWhy + '.')
      return
    }
    if (awaitingMine !== null || submittedAt === null) return
    awaitMine('withdraw')
    session.council.withdraw(id)
  }

  /** Run one's own attempt: only when the setting allows it; refusal in words. */
  function runAttempt(): void {
    if (councilClosed || attemptRunning || attemptOver || !session.connected) return
    if (!mayRunAttempt) {
      session.showError(
        may.finished
          ? tr(CLASS_IS_OVER) + '.'
          : councilSettings.studentRun === 'request'
            ? tr('room.ui.410')
            : tr('room.ui.411'),
      )
      return
    }
    session.council.run(id)
  }

  let requestSending = $state<{ action: 'request' | 'cancel'; previousId: string | null; text: string } | null>(null)
  let requestTimer: number | undefined

  function awaitRequest(action: 'request' | 'cancel'): void {
    window.clearTimeout(requestTimer)
    requestSending = { action, previousId: mine?.runRequest?.id ?? null, text: sheetText }
    requestTimer = window.setTimeout(() => {
      requestSending = null
      session.showError(tr('room.ui.412'))
    }, MINE_WAIT_MS)
  }

  $effect(() => {
    const request = mine?.runRequest
    const text = mine?.text
    const closed = councilClosed || councilSettings.studentRun !== 'request'
    const sending = untrack(() => requestSending)
    if (!sending) return
    const confirmed = sending.action === 'cancel'
      ? request?.id !== sending.previousId || request?.status !== 'pending'
      : request?.status === 'pending' && request.id !== sending.previousId && text === sending.text
    if (!closed && !confirmed) return
    requestSending = null
    window.clearTimeout(requestTimer)
  })
  $effect(() => () => window.clearTimeout(requestTimer))

  function requestAttemptRun(): void {
    if (!mayRequestRun || attemptRunning || attemptOver || requestSending || !session.connected || !sheetText.trim()) return
    if (mine?.runRequest?.status === 'pending' && attemptSynced) return
    // Including an untouched task: it may not be among the attempts yet.
    if (!attemptSynced) session.council.draft(id, sheetText)
    awaitRequest('request')
    session.council.requestRun(id)
  }

  function cancelAttemptRunRequest(): void {
    const request = mine?.runRequest
    if (!mayRequestRun || requestSending || !session.connected || request?.status !== 'pending') return
    awaitRequest('cancel')
    session.council.cancelRunRequest(id, request.id)
  }

  /* ---- the sheet: state in words, the starter at hand, and keys */

  /**
   * The teacher's starter: what the sheet started from.
   *
   * The same pair as in `sheetSeed`: `mine.seed` (the shared text at the
   * moment the lock was switched to council) outranks the current shared
   * text, because after "Show to class" the shared one already holds
   * somebody's solution. An old server does not send the field: then the
   * shared text remains, as when seeding the sheet.
   */
  /*
   * A function, not a rune: `liveText` is declared further down the file (it
   * is about the cell's SHARED text and lives among the rest of its
   * household), and a rune reading it from here would access a variable
   * before its declaration. The function body runs when read, that is,
   * afterwards, and dependencies are tracked right where they are read.
   */
  function stubText(): string {
    return mine?.seed ?? liveText.current
  }

  /**
   * The sheet's state in ONE word: the chip in the footer and the colour of
   * the bar on the left.
   *
   * The order follows what the person has to do next. "Unsent edits" comes
   * before the mark: the teacher holds something other than what is on
   * screen, and while that is so, any mark refers to the previous text.
   * Until now the author never saw the mark at all: the teacher set it in
   * the stack, it arrived in `council:mine` and died there.
   */
  const sheetState = $derived(
    (submittedAt !== null && !attemptSynced) || (submittedAt === null && mine?.correct != null)
      ? 'edited'
      : submittedAt === null
        ? 'draft'
        : mine?.correct === true
          ? 'correct'
          : mine?.correct === false
            ? 'wrong'
            : 'submitted',
  )
  /**
   * Reviewed: when? The mark has no time of its own in the protocol
   * (`CouncilMine.correct` is a bare flag), and inventing one for the sake
   * of a label would mean changing the frame to suit the styling. So the
   * time of the last letter is taken: the review and the letter are written
   * in the same minute, and if there is no letter, the label says
   * "reviewed" without a clock, and that is the truth.
   */
  const reviewedAt = $derived(letters.length > 0 ? letters[letters.length - 1].at : null)

  /**
   * The attempt's output, wiped by going back to the starter.
   *
   * There is nothing to wipe it with on the server: `council:*` has no
   * "forget this run" frame, and adding one for a single button would mean
   * changing the protocol to suit the styling. So we remember the START
   * MOMENT of the run whose output the person removed together with the
   * text: the next run will come with its own `startedAt` and draw itself.
   */
  let clearedRunAt = $state<number | null>(null)
  const attemptRun = $derived(
    mine?.run && mine.run.startedAt !== clearedRunAt ? mine.run : null,
  )

  /**
   * "Restore": bring the sheet back to the starter.
   *
   * A wiped scaffold used to cease to exist: there was nobody to ask for it,
   * and the teacher dictated it aloud. Not allowed for a submitted sheet (a
   * submitted one is edited after "Edit") and not when the sheet already
   * equals the starter: there is nothing to bring back.
   */
  const mayRestore = $derived(mayAttempt && submittedAt === null && sheetText !== stubText())

  /**
   * Run and request are one button, because for a student this is one
   * movement.
   *
   * The `studentRun` setting is the TEACHER's rule about whose turn it is:
   * on one's own or with permission. To the student it explained itself
   * with three extra phrases ("Request a run", "Requested 14:31", "Sending
   * the request…"), that is, it made them know about mechanics they do not
   * control. There is one press, "Run", and after it in both cases one
   * waits: in one case for the kernel, in the other for the teacher and the
   * kernel. The waiting is called the same too.
   */
  const mayPressRun = $derived(
    councilSettings.studentRun === 'request'
      ? mayRequestRun && sheetText.trim() !== '' && requestSending === null
      : mayRunAttempt,
  )
  /** The request is with the teacher and refers to the text that is on screen. */
  const requestPending = $derived(
    councilSettings.studentRun === 'request' &&
      attemptSynced &&
      mine?.runRequest?.status === 'pending',
  )
  /**
   * The press has been made and is waiting: for the kernel's queue or for
   * the teacher.
   *
   * `requestSending` is here too: between the press and the server's echo
   * the button must be dimmed, otherwise on a bad network it gets pressed a
   * second time.
   */
  const runWaiting = $derived(
    mine?.queue != null ||
      attemptRunning ||
      requestPending ||
      requestSending?.action === 'request',
  )
  /**
   * What can be cancelled is the REQUEST, and only that: there is nothing to
   * cancel the kernel queue with: `council:run:cancel` withdraws the request
   * (server/src/control.ts · resolveRunRequest), and the protocol has no
   * "remove from queue" frame. So the link next to "Queued" is drawn only
   * where it has something to do.
   */
  const mayCancelRun = $derived(requestPending && mayRequestRun)

  /**
   * "Ask the oracle" is for ONE'S OWN failed attempt, and only for it.
   *
   * The button appears exactly when there is something to ask about: the
   * run ended in an error. Without a traceback the question would
   * degenerate into "look at my code and tell me whether it's right", that
   * is, into solving for the student, which is exactly what the council is
   * protected from.
   *
   * It has its own route, not `/ai/ask`: that one writes the question and
   * answer into the shared feed, while council texts are private. The answer
   * arrives as a letter in the attempt itself (`council:hint` in
   * control.ts), and it is visible to the same two people who see its text.
   *
   * A run stopped by the limit gets no button at all (`run.timedOut`). It
   * did not fail on the code: the server interrupted it by the cell's rules,
   * there is no traceback, only one translated line about the limit, and
   * the model would be left guessing from the attempt's text, that is,
   * solving for the student. On top of that, the question costs a place in
   * the room's limit, and the person has already read the answer to it in
   * the output: make the computation shorter and run again.
   */
  const hint = $derived(session.council.hints[id] ?? null)
  const mayHint = $derived(
    !councilClosed &&
      mine?.run?.state === 'error' &&
      !mine.run.timedOut &&
      mayAttempt &&
      session.connected,
  )
  /** The "restore?" question: in place of the button, with no browser dialog. */
  let restoreAsking = $state(false)
  /**
   * The footer's width, so that the chip shrinks before the line wraps.
   *
   * The footer lives in the notebook column, and its width is decided by
   * the side panels, not the window: at 636 px with both panels open
   * "SUBMITTED 14:32 · AWAITING REVIEW" together with two buttons did not
   * fit, and the buttons slid down, that is, the main thing did. A media
   * query cannot see this, so the element itself is measured.
   */
  let footerWidth = $state(0)
  /** Zero means not measured yet: until then the chip is full, not trimmed. */
  const tightFooter = $derived(footerWidth > 0 && footerWidth < 460)
  $effect(() => {
    if (!mayRestore) restoreAsking = false
  })

  function restoreStub(): void {
    const current = untrack(() => sheet)
    restoreAsking = false
    if (!current || !mayRestore) return
    /*
     * The origin is the ordinary one (null), not SEED, and that is a
     * load-bearing decision: the snapshot must go to the server like any
     * typing (otherwise the teacher would be left with the wiped text), and
     * the restore itself must land in undo, so that Cmd+Z brings back what
     * was written. SEED does exactly the opposite: it neither goes out nor
     * gets undone.
     */
    clearedRunAt = untrack(() => mine?.run?.startedAt ?? null)
    current.doc.transact(() => replaceText(current.text, stubText()))
  }

  /**
   * "Submit again": the teacher holds something other than what the person
   * sees on the sheet.
   *
   * `submitAttempt` is no good here: it deliberately does not let a second
   * press through on an already submitted sheet (otherwise on a bad network
   * that is five hundred `council:submit`s in a row). Here the second press
   * is the whole point: send the snapshot and submit once more. The chip
   * will return to "Submitted" with the same echo it diverged with.
   */
  function resubmitAttempt(): void {
    if (!mayAttempt) {
      session.showError(attemptWhy + '.')
      return
    }
    if (attemptOver) {
      session.showError(tr('room.ui.409', { p0: attemptCount ?? '' }))
      return
    }
    session.council.draft(id, sheetText)
    // A withdrawn attempt is submitted again for real (the server will set a
    // time), and then we wait for the echo, as with an ordinary submission.
    // For a submitted one the server does not move the time: there is
    // nothing to wait for, and the chip returns to "Submitted" as soon as
    // the fresh snapshot arrives.
    if (submittedAt === null) awaitMine('submit')
    session.council.submit(id)
  }

  /**
   * ⇧↵ on one's own sheet RUNS rather than submits.
   *
   * It used to submit: the student had no run at all, and fingers used to
   * "run and move on" had to land somewhere. Running appeared, and with it
   * the notebook's usual convention came back: ⇧↵ runs, ⌘↵ runs without
   * moving, and only ⌘⇧↵ submits. With the setting off the key does not
   * scold and submits nothing: it says in words who runs here and fades
   * after two seconds. A toast would be out of place here: this is not a
   * refusal but the cell's rule.
   */
  let runHint = $state(false)
  let runHintTimer: number | undefined
  const RUN_HINT_MS = 2000

  function sheetRunKey(): void {
    // The pause comes before every branch: while the countdown runs (below ·
    // runPaused), the key sends nothing, because the server would reject it
    // anyway, and a refusal here would cost a toast on every press. The
    // answer is a flash of the chip, and it ends by itself.
    if (runPaused) {
      nudgePause()
      return
    }
    if (councilSettings.studentRun === 'request' && mayRequestRun) {
      requestAttemptRun()
      return
    }
    if (mayRunAttempt) {
      runAttempt()
      return
    }
    window.clearTimeout(runHintTimer)
    runHint = true
    runHintTimer = window.setTimeout(() => (runHint = false), RUN_HINT_MS)
  }

  $effect(() => () => window.clearTimeout(runHintTimer))

  /**
   * Submitting from the keyboard, and the button blinks in response.
   *
   * The combination is awkward on purpose, and an awkward press must be
   * visible: without the flash ⌘⇧↵ is indistinguishable from a miss on ⌘↵,
   * because "submitted" arrives as the server's echo and not instantly.
   */
  let submitFlash = $state(false)
  let flashTimer: number | undefined
  const FLASH_MS = 260

  function submitFromKey(): void {
    window.clearTimeout(flashTimer)
    submitFlash = true
    flashTimer = window.setTimeout(() => (submitFlash = false), FLASH_MS)
    if (sheetState === 'edited') resubmitAttempt()
    else void submitAttempt()
  }

  $effect(() => () => window.clearTimeout(flashTimer))

  /* ---- the pause between runs: a countdown in place of the button */

  /**
   * Its own tick, and only while there is something to count down.
   *
   * The cell's stopwatch (`now` below) is no good for this twice over: it
   * beats every fifth of a second and lives exactly as long as the CELL is
   * running, while the pause comes precisely after everything has finished.
   * So it is started from the pause itself and removed as soon as the pause
   * is over: otherwise a notebook with forty council cells would keep forty
   * intervals running for nothing until the end of class.
   *
   * Half a second, not a second: the interval is not started on a second
   * boundary, and with a whole-second step the digit would change up to a
   * second late; a countdown lagging behind the clock reads as frozen.
   */
  let pauseNow = $state(Date.now())
  const pauseLeft = $derived(
    pauseLeftMs(mine?.nextRunAt, pauseNow, session.clockSkewMs, councilSettings.rerunPauseSec),
  )
  const pauseTicking = $derived(pauseLeft > 0)
  $effect(() => {
    if (!pauseTicking) return
    const id = window.setInterval(() => (pauseNow = Date.now()), 500)
    return () => window.clearInterval(id)
  })

  /**
   * The countdown STANDS IN PLACE OF THE BUTTON, and only where the button
   * would be.
   *
   * For a submitted attempt and for one already waiting in the queue the
   * place is taken by something more important; where the teacher runs
   * things there is no pause at all: the rule is about repeating ONE'S OWN
   * run. Zero in `pauseLeft` brings the button back by itself, on a tick:
   * there is nobody to ask the server about the end of the pause, and no
   * reason to: it sent that very number.
   */
  const runPaused = $derived(
    pauseLeft > 0 && submittedAt === null && !runWaiting && (mayRunAttempt || mayRequestRun),
  )

  /**
   * ⇧↵ during a pause flashes the countdown rather than sending a request
   * that will be rejected.
   *
   * The key must agree with the button: there is no button on screen, so
   * there is no message to the server either. Otherwise every press would
   * cost a refusal (a toast over the typing and a line in the log), all for
   * a rule already written out in words in the footer. The countdown itself
   * blinks, with the same movement as the submit button on ⌘⇧↵: that is
   * where to look.
   */
  let pauseNudge = $state(false)
  let nudgeTimer: number | undefined

  function nudgePause(): void {
    window.clearTimeout(nudgeTimer)
    pauseNudge = true
    nudgeTimer = window.setTimeout(() => (pauseNudge = false), FLASH_MS)
  }

  $effect(() => () => window.clearTimeout(nudgeTimer))

  /* ---- the three-position lock */

  /**
   * The lock menu: three positions and two council settings.
   *
   * A click stays a click: closed ↔ open, without a menu and without a
   * dialog, by the argument in the lock's markup. Where exactly a click
   * opens to is decided by the room rule `opens` (shared text or a sheet
   * for everyone), and the same rule is read by the hints and the second
   * press (lib/lock-button.ts). The menu is opened by holding, by the right
   * button, or by a click on the lock in a position a click never led to:
   * there a single press does not know where to go back to.
   */
  let lockMenu = $state(false)

  /* ----------------------------------------- the council console window */

  /**
   * Whether this cell's console is open: one button under the cell answers
   * to that.
   *
   * There is no private console in the notebook anymore at all: the council
   * is run in the console window, and there must be no second place in the
   * product with names, drafts and marks: the notebook is mirrored to the
   * audience. So "open" decides only the button's label: open, we raise the
   * window; closed, we open it.
   *
   * We find out by a knock over BroadcastChannel
   * (lib/council-pult-window.ts), not through a reference to the window: a
   * notebook reload loses the reference while the window lives on. Silence
   * longer than three seconds means closed.
   */
  let pultBeat = $state.raw<PultBeat | null>(null)
  let pultNow = $state(Date.now())
  /** A reference to the window, if it was opened from this tab, to raise it. */
  let pultWindow: Window | null = null
  const pultOpen = $derived(
    leads && inCouncil && pultBeat?.cellId === id && beatsAlive(pultBeat, pultNow),
  )

  $effect(() => {
    if (!leads || !inCouncil) return
    const stop = watchPult(session.session.id, (beat) => {
      pultBeat = beat
      pultNow = Date.now()
    })
    // Our own fade-out: no more messages, and "open" must go out by itself.
    const timer = setInterval(() => (pultNow = Date.now()), 1000)
    return () => {
      stop()
      clearInterval(timer)
    }
  })

  /**
   * The window was blocked by the browser: say so in words rather than stay
   * silent.
   *
   * `window.open` from a click handler gets through everywhere, but not
   * always: in Safari with "block pop-up windows" and in Chrome under an
   * enterprise policy it returns `null`. A silent button reads as broken,
   * while the teacher at that moment stands in front of an audience; the
   * line fades by itself, because it is about one press, not about the
   * room's state.
   */
  let pultBlocked = $state(false)
  let blockedTimer: number | undefined
  const BLOCKED_MS = 6000

  /**
   * "It opens as a tab" is the part of the complaint that code does not fix.
   *
   * In full-screen Chrome and Safari on macOS a pop-up window lands as a tab
   * in the same space, whatever `features` says: the system does not let a
   * second window out of full-screen mode. Staying silent about it is not an
   * option (the owner shares one window and expects a second one beside
   * it), and drawing the line always is not an option either: it lies in
   * normal mode. So it appears on a press and exactly when it is true, and
   * fades by itself, like the refusal above.
   */
  let pultFullscreen = $state(false)
  let fullscreenTimer: number | undefined

  $effect(() => () => {
    window.clearTimeout(blockedTimer)
    window.clearTimeout(fullscreenTimer)
  })

  /**
   * Reach this cell's console: open it, raise it or switch it.
   *
   * One door, and ONLY THE BUTTON UNDER THE CELL opens it. The lock does not
   * open windows: switching a cell to council and opening the console are
   * two different decisions, and the second is the teacher's, not the
   * notebook's. What to do with the window (open, raise, or switch it to
   * this cell) is decided by `pultReach` from the last knock
   * (lib/council-pult-window.ts); only the windows and the refusal remain
   * here.
   *
   * Call it ONLY FROM A CLICK HANDLER: the browser does not let
   * `window.open` through outside a user gesture, and on a frame from the
   * network the window would never open, silently.
   */
  function reachPult(): void {
    lockMenu = false
    if (pultReach(pultBeat, id, Date.now()) === 'focus') {
      try {
        if (pultWindow && !pultWindow.closed) {
          pultWindow.focus()
          return
        }
      } catch {
        // Cross-window focus can refuse; the window is still alive.
      }
      const raised = focusPult(session.session.id)
      if (raised) {
        pultWindow = raised
        return
      }
    }
    // Open, or switch an already open window to this cell: the window name is
    // one per room, and a second `open` does not double it but leads it here.
    const opened = openPult(session.session.id, id)
    if (opened) pultWindow = opened
    window.clearTimeout(blockedTimer)
    pultBlocked = opened === null
    if (opened === null) blockedTimer = window.setTimeout(() => (pultBlocked = false), BLOCKED_MS)
    window.clearTimeout(fullscreenTimer)
    pultFullscreen = opened !== null && looksFullscreen()
    if (pultFullscreen) fullscreenTimer = window.setTimeout(() => (pultFullscreen = false), BLOCKED_MS)
  }

  let holdTimer: number | undefined
  /**
   * When a hold opened the menu: the click that follows the release does
   * not count. A timestamp, not a flag: on a touch screen there may be no
   * click after a long press at all, and a flag would eat the next honest
   * press.
   */
  let heldAt = 0
  const HOLD_MS = 450

  const LOCKS: { state: CellLock; icon: IconName; label: string; hint: string }[] = [
    { state: 'closed', icon: 'lock', label: tr('room.ui.415'), hint: tr('room.ui.416') },
    { state: 'open', icon: 'unlock', label: tr('room.ui.417'), hint: tr('room.ui.418') },
    { state: 'council', icon: 'users', label: tr('room.ui.34'), hint: tr('room.ui.419') },
  ]
  const lockIcon = $derived<IconName>(inCouncil ? 'users' : cellOpen ? 'unlock' : 'lock')
  // The room's rule, not the cell's position: what "open" means here.
  const opens = $derived(may.rules.opens)

  /*
   * The press was heard: a local flag until the frame comes back.
   *
   * The lock predicts nothing: the icon changes exactly when it changes for
   * the whole room, and that is right. But on the relay a frame takes
   * 100–300 ms, and during them a teacher mid-sentence saw EXACTLY NOTHING,
   * pressed a second time and put the lock back. The flag does not lie about
   * the position: it only says "sent", goes out on any arriving frame and on
   * its own deadline: the network may not answer, and it must not hang
   * until the end of class.
   */
  let lockSending = $state(false)
  /** Plain `let`s: only code reads them, and no effect needs to depend on them. */
  let sentFrom: CellLock | null = null
  let sentTimer: number | undefined
  const SENT_MS = 2000

  function markSending(): void {
    window.clearTimeout(sentTimer)
    sentFrom = lockState
    lockSending = true
    sentTimer = window.setTimeout(() => {
      sentFrom = null
      lockSending = false
    }, SENT_MS)
  }

  $effect(() => {
    const now = lockState
    if (sentFrom === null || now === sentFrom) return
    sentFrom = null
    window.clearTimeout(sentTimer)
    lockSending = false
  })

  $effect(() => () => window.clearTimeout(sentTimer))

  function pressLock(): void {
    if (Date.now() - heldAt < HOLD_MS * 2) return
    const press = lockPress(lockState, opens)
    if (press.kind === 'menu') {
      lockMenu = !lockMenu
      return
    }
    // Two positions, with the old message: the server reads it as cell:lock
    // and decides by the room rule itself whether it is shared text or a
    // council.
    markSending()
    session.send({ t: 'cell:open', cellId: id, open: press.open })
  }

  function startHold(): void {
    window.clearTimeout(holdTimer)
    holdTimer = window.setTimeout(() => {
      heldAt = Date.now()
      lockMenu = true
    }, HOLD_MS)
  }

  function endHold(): void {
    window.clearTimeout(holdTimer)
  }

  function setLock(state: CellLock): void {
    lockMenu = false
    if (state === lockState) return
    markSending()
    session.council.lock(id, state)
  }

  // The menu closes from outside: a click elsewhere, Escape, losing the lock.
  $effect(() => {
    if (!lockMenu) return
    const away = (event: PointerEvent) => {
      const target = event.target as Node | null
      if (target && root?.querySelector('[data-lock-menu]')?.contains(target)) return
      if (target && root?.querySelector('[data-lock-button]')?.contains(target)) return
      lockMenu = false
    }
    const escape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') lockMenu = false
    }
    window.addEventListener('pointerdown', away, true)
    window.addEventListener('keydown', escape, true)
    return () => {
      window.removeEventListener('pointerdown', away, true)
      window.removeEventListener('keydown', escape, true)
      window.clearTimeout(holdTimer)
    }
  })

  /*
   * The cell hid its lock (the rules changed, the bell): it has no use for
   * the menu. `lock` is read here and `lockMenu` written: there is no loop.
   */
  $effect(() => {
    if (!lock || may.role !== 'host') lockMenu = false
  })

  /** Show the draft of a closed council; collapsed by default. */
  let showDraft = $state(false)

  /*
   * The cell stopped inside input().
   *
   * This is the only state in which the kernel waits for a PERSON, not a
   * machine. That the cell is waiting for an answer is seen by the whole
   * room: the input prompt lives in the document. But the answer comes from
   * whoever's cell is asking, or from the teacher: so the server decides
   * (`control.ts`, case 'input', with the same `startedTheRunningCell` as
   * "stop"), and a password `input()` is exactly why seeing and answering
   * are not the same thing.
   *
   * The field and the focus follow this right. Until they did, the label
   * called the whole room to answer, the caret jumped out of someone else's
   * cell in every browser, and the typed answer was wiped together with the
   * server's refusal.
   */
  const stdin = $derived(meta.current.stdin)
  let answer = $state('')
  let answerField = $state<HTMLInputElement | null>(null)

  /*
   * Focus goes only to the one WHOSE cell is asking.
   *
   * `canAnswer` is true for the teacher on ANY cell, so in a lab with
   * `run: room` every `input()` of any student yanked the caret out of the
   * cell the teacher was typing in, and (through a focus without
   * `preventScroll`) carried the screen off to someone else's cell two
   * hundred lines below. The teacher still gets the field drawn: they have
   * the right to answer, but they come to it themselves.
   *
   * `preventScroll` plus a separate `scrollIntoView` is not the same as a
   * plain `focus()`: the browser scrolls ANY ancestor to the field,
   * horizontally too, while here exactly "bring the cell into view if it is
   * not visible" is needed.
   */
  $effect(() => {
    if (stdin && canAnswer && mineIsRunning) {
      answerField?.focus({ preventScroll: true })
      root?.scrollIntoView({ block: 'nearest' })
    } else if (!stdin) answer = ''
  })

  function sendAnswer(event: SubmitEvent): void {
    event.preventDefault()
    if (!stdin) return
    session.send({ t: 'input', value: answer, cellId: id })
    // The field is cleared by the effect above when the kernel stops
    // waiting. Wiping it here would mean losing what was typed along with
    // any refusal.
  }
  const cellState = $derived(meta.current.state)

  /*
   * An instant cell does not blink.
   *
   * `print(1)` passes the queue and execution in tens of milliseconds, and
   * in those tens of milliseconds the interface managed to show everything:
   * the bar flashed with the accent, the ordinal changed colour, a status
   * line appeared and disappeared at the bottom, the toolbar button turned
   * into a square and back. The result was blinking out of nowhere, and the
   * faster the cell, the more noticeable.
   *
   * So the busy state is not shown at once: if execution finished before
   * the threshold, there was nothing to show and nobody saw anything. If it
   * lives longer, everything appears at once, and appears for a while.
   *
   * The threshold is local and does not get into the document: it is about
   * how things are drawn, not about what is happening. Two hundred
   * milliseconds is the usual boundary beyond which a person starts to
   * notice waiting; below it the pointer only has time to blink.
   */
  const BUSY_VISIBLE_MS = 200
  const busy = $derived(cellState === 'running' || cellState === 'queued')
  let showBusy = $state(false)
  $effect(() => {
    if (!busy) {
      showBusy = false
      return
    }
    const id = window.setTimeout(() => (showBusy = true), BUSY_VISIBLE_MS)
    return () => window.clearTimeout(id)
  })

  /**
   * The state as drawn, against the state as it is.
   *
   * They differ only in the two hundred milliseconds while the busy state is
   * not shown yet. Decisions are made by the real `cellState` (see `run`);
   * drawing goes by this one.
   */
  const shownState = $derived(busy && !showBusy ? 'idle' : cellState)
  const running = $derived(cellState === 'running')
  /** Same for the markup: the bar, status line and button face await the threshold. */
  const shownRunning = $derived(running && showBusy)

  let editing = $state(false)
  /** Only true when edit mode was entered deliberately, so a peer cannot steal focus. */
  let focusOnEdit = $state(false)
  let focusWithin = $state(false)

  const showEditor = $derived(isCode || editing)

  const outputs = watchOutputs(() => cell.current)
  const peersHere = watchCellPeers(session.awareness, () => id)
  // The queue is of ITS OWN notebook: each has its own kernel and its own
  // queue, and "third in the queue" from a neighbouring sheet has nothing to
  // do with this cell.
  const notebook = watchBookKernel(session.doc, () => bookRoot)

  const ytext = $derived(cell.current ? cellSource(cell.current) : null)

  /**
   * The cell's text to the clipboard: the only thing the copy slot in the
   * toolbar does.
   *
   * A clipboard refusal (a browser setting) stays silent: the text remains
   * selectable.
   */
  let copied = $state(false)
  let copiedTimer: number | undefined
  async function copySource(): Promise<void> {
    try {
      await copyText(ytext?.toString() ?? '')
      copied = true
      window.clearTimeout(copiedTimer)
      copiedTimer = window.setTimeout(() => (copied = false), NOTICED_MS)
    } catch {
      // see above
    }
  }
  $effect(() => () => window.clearTimeout(copiedTimer))
  const queuePosition = $derived(notebook.current.queue.indexOf(id))
  const hasError = $derived(
    cellState === 'error' || outputs.current.some((output) => output.kind === 'error'),
  )

  /** 01, 02, 03 — the ordinal the artboard leads the gutter with. */
  const ordinal = $derived(String(index + 1).padStart(2, '0'))

  /*
   * One signal, two marks: the ordinal in the gutter and the rule down the left
   * edge of the body. Running and error outrank selection deliberately — a cell
   * you have clicked on is still, first, a cell that failed.
   */
  /*
   * An open cell ranks ABOVE a selected one for the same reason the running
   * and the failed ones rank above it: this is a fact about the room, not
   * about your cursor. It is what the bar is coloured for: "open" must read
   * from the middle of the lecture hall, not on close inspection; the
   * selection meanwhile stays marked by the ordinal, as on a running cell.
   */
  const tone = $derived(
    shownRunning
      ? 'running'
      : hasError
        ? 'error'
        : shownState === 'queued'
          ? 'queued'
          : lock && (cellOpen || inCouncil)
            ? 'open'
            : selected
              ? 'selected'
              : 'idle',
  )

  /*
   * A resting cell has nothing to announce, so the ordinal is quiet — but it is
   * also how the room refers to a cell out loud ("look at four"), so quiet has a
   * floor. faint/70 measured 2.1:1 on the dark ground, which is not quiet, it is
   * gone; and the error ordinal at danger/50 was the dimmest thing on the one
   * cell everybody is looking at.
   */
  const ORDINAL = {
    running: 'text-accent-text',
    error: 'text-danger',
    queued: 'text-accent-text/80',
    open: 'text-accent-text',
    selected: 'text-ink',
    idle: 'text-muted',
  } as const

  /*
   * The vertical bar left of the cell body is the only state marker that
   * EVERY cell has: code, rendered text, and collapsed cells alike. So the
   * selection speaks through it.
   *
   * Selected is in ink colour, that is, the darkest thing on the sheet: it
   * must differ from a resting one (a thin grey line) at projector distance,
   * not on close inspection.
   */
  const RULE = {
    /*
     * Running is muted, and that is not a typo: on top of it lies a breathing
     * bar of the same width in the same place (see the markup below). The
     * pair gives a line that moves between the full accent and 55 %: the
     * brightest thing on the sheet at the top and close to queued at the
     * bottom. What tells them apart is not brightness but that one of them
     * moves: the kernel executes one cell at a time, so exactly one thing
     * moves in the notebook.
     *
     * Apart, these two values are meaningless: without the bar a running
     * cell would be paler than a queued one. They can only be changed
     * together.
     */
    running: 'border-accent/40',
    error: 'border-danger',
    queued: 'border-accent/50',
    /*
     * Open is in the full accent and without the breathing bar on top: it is
     * not running, it is allowed. It is the only calm state that is given a
     * colour, and it is given one precisely so that in a closed notebook the
     * eye can find the one cell.
     */
    open: 'border-accent',
    selected: 'border-ink',
    idle: 'border-line',
  } as const

  /*
   * Whose run this is only matters when it tells you something you did not
   * already know: that a cell is busy, or that a finished result came from
   * somebody else's keyboard.
   */
  const runBy = $derived(meta.current.runBy)
  /*
   * Stopping your own runaway loop should not require a teacher in the room.
   * The server decides this too, from its own record of the queue — this only
   * decides whether the control is drawn as usable.
   */
  const mineIsRunning = $derived(meta.current.runById === session.me.id)
  const canInterrupt = $derived(session.me.role === 'host' || mineIsRunning)
  /*
   * Answering input() is the same circle of people and the same server
   * check as "stop". A separate name, because it is a different question to
   * the room: not "whose work are you interrupting" but "whose cell is
   * asking".
   *
   * And the end of class: no rule expresses this (there are no rules about
   * `input()`), so here it is the same `actsAfterClass` the server answers
   * with. The case is rare and real: class is ended while someone's cell is
   * waiting for input, and a field the server would refuse is better not
   * drawn.
   */
  const canAnswer = $derived(canInterrupt && acts)
  /*
   * A queued cell can be taken back; the running one cannot, that is Interrupt.
   * It matters most in the case the control is for: somebody else's long cell
   * holds the kernel, you pressed Run All behind it, and Interrupt is not yours
   * to press. The server checks this again against its own queue.
   */
  const canCancel = $derived(session.me.role === 'host' || meta.current.runById === session.me.id)
  /*
   * Two expressions that look the same are deliberately not merged into one:
   * the server answers them from different records ("stop" from the
   * execution environment, "remove from queue" from the queue), and they
   * coincide by today's rule, not by design.
   */

  /*
   * The first place in the toolbar: run, cancel or stop, depending on what
   * the cell is doing.
   *
   * There used to be a run button here always, and on a running cell it was
   * enabled and did nothing: `requestRun` on the server lets through both
   * what is already running and what is already queued. The decision lives
   * in a separate module, and that is where tests check it.
   */
  /*
   * The stopwatch tick lives here, not in the document.
   *
   * A fifth of a second, not a whole one: the tenth of a second is exactly
   * the digit that shows whether a cell is working or hanging. The interval
   * is started only for the duration of execution and removed in cleanup,
   * so with the kernel off nothing ticks in the notebook.
   *
   * The kernel executes one cell at a time, so no more than one such
   * interval lives in the whole tab, however many cells the notebook has,
   * and without any coordination between them: the effect looks at its own
   * cell's `running`, and that is enough.
   */
  let now = $state(Date.now())
  $effect(() => {
    if (!running) return
    const id = window.setInterval(() => (now = Date.now()), 200)
    return () => window.clearInterval(id)
  })

  /* ------------------------------------------ jump to definition */

  /**
   * "You were brought here": a mark for THIS cell, or nothing.
   *
   * Not an event but a state, hence `$derived`: the notebook often builds
   * the cell a jump leads to only AFTER the server has answered (distant
   * ones stand as stubs, see Notebook.svelte · data-cell-deferred), and
   * there would be nobody to listen to an event sent to it. A cell built a
   * frame after the scroll reads the mark itself: see lib/goto.svelte.ts.
   *
   * A one-off value instead of a signal will not do either: `landingInCell`
   * reads `$state`, and what was passed to the editor once would stay
   * forever as it was on the first render, that is, empty.
   */
  const landing = $derived(landingInCell(id))

  /* ------------------------------------------------- room for output */

  /** How much the area measures itself now; written onto the inner node. */
  let outputsMeasured = $state(0)
  /** How much it took the last time it held something, and what that was. */
  let heldOutput = $state<Held>(NO_HELD)
  /** How many images have not reported their size yet; comes from CellOutputs. */
  let outputsPending = $state(0)

  const outputFloor = $derived(
    outputSeat({
      running,
      outputs: outputs.current.length,
      pendingImages: outputsPending,
      held: heldOutput,
    }),
  )

  const unnumbered = $derived(
    isCode &&
      unnumberedResult({
        state: cellState,
        execCount: meta.current.execCount,
        outputs: outputs.current.length,
      }),
  )

  // Remembering the height. Both checks inside nextHeld are load-bearing: see the module.
  /*
   * Remembering the height, and two Svelte traps I have already fallen into.
   *
   * The effect reads the previous value and writes a new one, and `nextHeld`
   * returns an OBJECT. So even when nothing has changed, a new reference is
   * assigned: the effect depends on what it writes itself and restarts
   * forever. Svelte catches this and brings down the whole app:
   * effect_update_depth_exceeded, the notebook stops rendering, cells get
   * doubled. The first time this went unnoticed precisely because the
   * function used to return a number, and 900 === 900 stopped the loop by
   * itself.
   *
   * Hence: the previous value is read through untrack (the effect depends
   * only on its inputs), and the assignment happens only when something
   * really became different. Either of these two tricks closes the hole;
   * both are here, because the price of the mistake is not "twitches a
   * little" but "the app does not work".
   */
  $effect(() => {
    const input = {
      running,
      outputs: outputs.current.length,
      pendingImages: outputsPending,
      measured: outputsMeasured,
      hasError,
    }
    const previous = untrack(() => heldOutput)
    const next = nextHeld(previous, input)
    if (next.px !== previous.px || next.fromError !== previous.fromError) heldOutput = next
  })

  const slot = $derived(
    runSlot(shownState, {
      connected: session.connected,
      mayRun,
      canCancel,
      canInterrupt,
    }),
  )
  /**
   * The run mark in the gutter: `[ ]`, `[7]`, `[*]`, `[—]`. See lib/output-seat.
   *
   * One column under the ordinal answers "has it been run", and answers for
   * every cell, not only for one that printed something.
   */
  const mark = $derived(
    runMark({
      type: meta.current.type,
      state: shownState,
      execCount: meta.current.execCount,
      outputs: outputs.current.length,
      running: shownRunning,
    }),
  )
  /*
   * The mark's colour speaks the same language as the bar and the ordinal:
   * accent for a running one, red for a failed one, ochre for one whose
   * number was lost. A calm mark is muted and does not argue with the cell
   * ordinal, which is one and a half sizes larger.
   */
  const MARK = {
    /*
     * Empty brackets and brackets with a number share one tone, and that is
     * a decision, not an oversight: muting "not run" would make quiet
     * exactly the case the mark was introduced for. Jupyter does the same:
     * the content tells them apart, not the brightness.
     */
    idle: 'text-muted',
    busy: 'text-accent-text',
    done: 'text-muted',
    error: 'text-danger',
    lost: 'text-warning',
  } as const

  /*
   * "Someone else's" and "whose face" go by the participant id, not by the
   * participant's own name.
   *
   * Names in a room are not unique, and the server knows it: two "Anna"s
   * are two people. While they were compared as strings, the second Anna did
   * not get "Ran by Anna" drawn under her own cell, and under a running one
   * hung the avatar of whichever Anna got into `session.peers` first. The
   * name stays what people READ; the decision is made by `runById`, which
   * lives in the same meta and is already used next to it.
   */
  const ranByOther = $derived(
    runBy &&
      meta.current.runById !== session.me.id &&
      (cellState === 'ok' || cellState === 'error')
      ? tr('room.ui.421', { p0: runBy })
      : null,
  )

  /**
   * The runner's face, when the person who pressed Run is still in the room.
   *
   * By a map, not a search through a list: every cell with output asks this
   * question, and iterating over all the room's tabs in each of them is work
   * that grows as a product (two hundred cells times five hundred tabs is a
   * hundred thousand comparisons per presence frame). The map is computed
   * once per tick, next to the list (lib/peers.ts · peersById).
   */
  const runner = $derived.by(() => {
    const who = meta.current.runById
    if (!who) return null
    return session.peersById.get(who) ?? null
  })

  /** 1st, 2nd, 3rd: the queue chip reads as a place in line, not as a count. */
  function place(n: number): string {
    const teens = n % 100
    const suffix = teens >= 11 && teens <= 13 ? 'th' : (['th', 'st', 'nd', 'rd'][n % 10] ?? 'th')
    return `${n}${suffix}`
  }

  /*
   * Who is editing THIS cell, and why there is no line under one's own
   * sheet.
   *
   * Presence here is about the shared Y.Text: in a council the teacher edits
   * it while preparing the reference. The student meanwhile has only their
   * own sheet on screen, and the line "Maria Kuznetsova is editing here"
   * read under it as "she is sitting in your sheet". That the teacher sees
   * the text, the sheet says with a label in the header; there is nothing
   * more to say about other people's carets: they are physically not here
   * (one's own document, one's own empty presence).
   */
  const editingHere = $derived.by(() => {
    if (ownSheet) return null
    const names = peersHere.current.map((peer) => peer.user.name)
    if (names.length === 0) return null
    if (names.length === 1) return tr('room.ui.422', { p0: names[0] })
    if (names.length === 2) return tr('room.ui.423', { p0: names[0], p1: names[1] })
    return tr('room.ui.424', { p0: names[0], p1: names[1], p2: names.length - 2 })
  })

  let aiReady = $state(false)

  // Asked only where the answer changes what is drawn, so a notebook that never
  // fails never asks. The promise behind it is shared across every cell.
  $effect(() => {
    if (!hasError) return
    // The rules are read synchronously, not inside .then: from a promise the
    // effect does not track them, and a seminar switched from hints to full
    // mid-class did not redraw the button until the cell's state changed.
    const rules = readRules(session.session.rules)
    let alive = true
    void oracleStatus().then(
      ({ enabled, mode }) => {
        // Narrowed to this room: an instance on `full` still has to obey a
        // seminar set to hints, and this button is exactly what hints refuses.
        const here = oracleModeIn(rules, mode)
        if (alive) aiReady = enabled && actionAllowedIn(here, 'fix')
      },
      // Ask again with the next traceback: the cache did not keep the refusal.
      () => {
        if (alive) aiReady = false
      },
    )
    return () => {
      alive = false
    }
  })

  /*
   * "Ask the oracle to rewrite the cell", and the same trap as with "Fix
   * with AI".
   *
   * The button went dark only on `may.ask` (that is, at the end of class).
   * But `edit` is an action the `hints` mode does not accept at all
   * (protocol.ts · actionAllowedIn), let alone `off`: a student opened the
   * line, wrote a sentence, pressed "Ask for a rewrite" and got 403 after
   * the work was done. The header of this file describes exactly this trap
   * and closes it, but closed it only for `fix`.
   *
   * We ask with the same tab-wide promise and the same pair of functions as
   * the route that refuses.
   */
  const REWRITE_OFF = $derived(tr('room.ui.425'))
  const REWRITE_HINTS = $derived(tr('room.ui.426'))
  let rewriteReady = $state(false)
  let rewriteWhy = $state<string | null>(null)

  $effect(() => {
    // After the bell there is nothing to ask with anyway: `mayRewrite` is
    // already false, and there is no reason to bother the instance with two
    // hundred promises over one dimmed button.
    if (!may.ask) return
    const rules = readRules(session.session.rules)
    let alive = true
    void oracleStatus().then(
      ({ enabled, mode }) => {
        if (!alive) return
        const here = enabled ? oracleModeIn(rules, mode) : 'off'
        rewriteReady = actionAllowedIn(here, 'edit')
        rewriteWhy = rewriteReady ? null : here === 'hints' ? REWRITE_HINTS : REWRITE_OFF
      },
      // Ask again on the next render: the cache did not keep the refusal.
      () => {
        if (!alive) return
        rewriteReady = false
        rewriteWhy = tr('room.ui.427')
      },
    )
    return () => {
      alive = false
    }
  })

  /**
   * And only where this cell can be changed at all.
   *
   * "Ask the oracle to change the cell" ends in a suggestion with an "Apply"
   * button: that is an edit of the notebook, not an answer. In a lecture
   * (`edit: host`) and in a locked cell a participant cannot edit it, yet
   * they were drawn the question line, wrote a sentence, spent a question
   * from the room's limit and got a suggestion they themselves could not
   * accept. The refusal would then be silent twice over: about the rule and
   * about the spent question.
   *
   * The council is a separate term, and that is not nit-picking. The `edit`
   * rule in an open room allows a participant to edit cells, but the shared
   * council cell is not theirs: it holds the task, and rewriting it for
   * oneself would mean rewriting the task for the whole class. They do have
   * their own sheet, and the sheet has its own oracle hint: personal and
   * without editing someone else's text.
   *
   * The teacher keeps the action everywhere, the council included: the
   * reference in the shared cell is their text.
   */
  const mayPatchHere = $derived(mayEdit && (leads || !inCouncil))
  /** One refusal for both presses: asking for an edit and accepting it. */
  const patchWhy = $derived(inCouncil && !leads ? tr(COUNCIL_SHARED_CELL) : editWhy)
  /** The question line is live exactly when it will be accepted. */
  const mayRewrite = $derived(may.ask && rewriteReady && mayPatchHere)
  const rewriteRefusal = $derived(
    !may.ask
      ? may.askWhy
      : !mayPatchHere
        ? patchWhy
        : (rewriteWhy ?? tr('room.ui.427')),
  )

  // The right vanished under the hands: close the open line, otherwise it
  // promises what is no longer there (the same argument as for leaving a
  // note's source).
  $effect(() => {
    if (!mayRewrite) asking = false
  })

  let root = $state<HTMLDivElement | null>(null)

  /* ------------------------------------------------------------- parking */

  /**
   * A cell nobody can see renders a box the size of what it last measured
   * instead of a CodeMirror instance and its outputs. It stays mounted, so its
   * subscriptions and its edit state survive and coming back is a render rather
   * than a rebuild.
   */
  const PARK_ESTIMATE = 180

  let contentHeight = $state(0)
  let parkHeight = $state(PARK_ESTIMATE)

  $effect(() => {
    if (contentHeight > 0) parkHeight = contentHeight
  })

  /*
   * Never park a cell that is running, selected, or holding the local cursor.
   * Queued is deliberately not on that list: Run All queues the whole notebook
   * at once, and pinning on it would build forty editors at the exact moment
   * the machine has the least to spare. The gutter ordinal and the queue chip
   * live outside the parked region, so a parked cell still shows its place.
   */
  /*
   * The anchor, not the whole selection.
   *
   * A selected cell is not parked, otherwise the screen would jump under the
   * cursor. But now there can be many selected ones: having selected forty
   * cells to ask about them at once, a person would build forty CodeMirror
   * editors, exactly the work parking was written to get rid of. The cursor
   * is in one of them anyway.
   */
  const pinned = $derived(anchor || focusWithin || editing || running)
  const mounted = $derived(near || pinned)

  onMount(() => {
    /*
     * A note with nothing in it has nothing to render; drop straight into edit.
     *
     * Only for whoever created it. The cell arrives empty over the CRDT and
     * mounts for the whole room at the same instant, and a viewer has no way
     * out of the editor: `editing` is reset only by one's own blur, Escape
     * and a change of view, and in a lecture room the editor does not even
     * take focus. Thirty people stared at the markdown source instead of
     * prose until the end of class, and at a live CodeMirror that, because of
     * `editing`, does not get parked.
     *
     * `selected` is exactly "I created it": inserting selects the cell in the
     * same synchronous pair that creates it (see addAt in Notebook.svelte).
     */
    if (!selected) return
    // And only if one may type in it: an empty closed note is the dead end
    // from the analysis above, only opened not by a click but by the cell's
    // appearance.
    if (!mayEdit) return
    if (meta.current.type === 'markdown' && liveText.current.trim() === '') {
      focusOnEdit = true
      editing = true
    }
  })

  async function focusEditor() {
    await tick()
    const find = () => root?.querySelector<HTMLElement>('.cm-content') ?? null
    const node = find()
    /*
     * `preventScroll` because the notebook drives the screen, not the focus.
     *
     * A bare `focus()` scrolls EVERY scrollable ancestor so that the field
     * becomes visible "somehow", and does so with the minimal move. That is
     * exactly what left Shift+Enter in the middle of the next cell: the
     * notebook was already taking the screen to its top with room for the
     * toolbar, and the focus immediately broke off the move and brought it
     * to the first line at the very edge. Where to go is decided in one
     * place (`reveal` in Notebook.svelte); here only the caret is taken.
     */
    if (node) {
      node.focus({ preventScroll: true })
      return
    }
    // The cell was inserted or unparked a moment ago and CodeMirror has not
    // been built yet.
    requestAnimationFrame(() => find()?.focus({ preventScroll: true }))
  }

  function enter() {
    onselect()
    if (isCode) {
      void focusEditor()
    } else {
      /*
       * For a closed cell the source does not open at all.
       *
       * A note has two views, rendered and source, and the second exists
       * precisely for typing in it. While everyone was let in here, a student
       * with a double click (or Enter from command mode) took the seminar's
       * prose apart into raw markdown and stayed in it: there was no way out.
       * The exit hangs on the editor (Escape inside CodeMirror and focus
       * leaving), and a closed editor does not take focus:
       * `contenteditable=false` is not focusable, so neither of the two
       * events ever happens.
       *
       * Out loud, not silently: people arrive here with a deliberate
       * gesture, and a gesture that did nothing reads as a breakage. The
       * words are the same as for the "edit" button in the toolbar and the
       * refusal on Cmd+Enter.
       */
      if (!mayEdit) {
        session.showError(editWhy + '.')
        return
      }
      focusOnEdit = true
      editing = true
    }
  }

  function commitMarkdown() {
    editing = false
    focusOnEdit = false
  }

  /*
   * And if the person is already in the source, they must be able to leave
   * in any case.
   *
   * The right vanishes underfoot: the teacher closes the cell, changes the
   * rule, or the bell rings, and a note opened honestly turns into the same
   * dead end with no Escape. Going back to the rendered view is the way out
   * here, and it does not ask how one got in.
   */
  $effect(() => {
    if (!isCode && editing && !mayEdit) commitMarkdown()
  })

  /**
   * Run, and say whether it worked.
   *
   * We fixed the toolbar button, but the keys went around it: Cmd+Enter on
   * an already running cell sent `run`, the server silently threw it out,
   * and the person was left feeling that the press did not get through. The
   * return value is needed by the two callers that call `run` before doing
   * something to the notebook: stepping and inserting a cell on behalf of
   * an execution that did not happen is an edit of the document for the
   * whole room at someone else's expense.
   */
  function run(): boolean {
    if (!isCode) {
      /*
       * A text cell is "executed" by turning into text.
       *
       * Returning false here is not an option, even though there is nothing
       * to run: Shift+Enter and Alt+Enter depend on this value, and with
       * false the note rendered but the caret went nowhere and no new cell
       * appeared. This does not touch the execution state: there simply is
       * none here.
       */
      commitMarkdown()
      /*
       * And the screen follows it just as it follows a code cell.
       *
       * For code the sheet is driven by Notebook, on the kernel's change of
       * running cell. A note has no kernel, and there was no event at all: a
       * person went down the notebook with Shift+Enter, the sheet followed
       * every code cell and stopped at the first text one: the caret moved
       * on, the screen did not (19 Sep 2026). We tell Notebook ourselves;
       * where to go and whether to go is decided by the same rule
       * (cell-scroll.ts · afterRun): only down, and only if the bottom is not
       * visible.
       */
      window.dispatchEvent(new CustomEvent('colloq:cell-settled', { detail: { cellId: id } }))
      return true
    }
    if (!mayRun) {
      // In the server's words, verbatim. A button that stays silent is an
      // error message; a button that explains is a rule.
      /*
       * From `may`, not a literal: an English phrase about the room rule
       * stood here, and after the bell it talked about a rule nobody had
       * changed: the person went looking for the teacher instead of learning
       * that class was over. The same thing was already fixed in command
       * mode (Notebook.svelte); it remained in the editor.
       */
      // The notebook speaks before the room: the same argument as `editWhy` above.
      session.showError((may.bookWhy ?? (shut ? tr(LECTURE_CELL) : may.runWhy)) + '.')
      return false
    }
    // Silently: the cell itself shows what it is doing, with the bar, the
    // status line and the button's face. A banner about what is visible
    // anyway is noise.
    if (cellState === 'running' || cellState === 'queued') return false
    /*
     * "One at a time": the server will take one cell at a time from a
     * participant and refuse the second, while Shift+Enter and Alt+Enter
     * will by then have stepped and appended an empty cell to the shared
     * notebook. We check with the same count and the same words.
     */
    if (
      may.rules.run === 'single' &&
      session.me.role !== 'host' &&
      hasPendingRun(session.doc, session.me.id)
    ) {
      session.showError(tr(ONE_AT_A_TIME))
      return false
    }
    onselect()
    session.send({ t: 'run', cellId: id })
    return true
  }

  async function runAndAdd() {
    if (!run()) return
    // Alt+Enter appends a cell, and appending may not be allowed in this
    // room. Then the run happened but the cell does not appear, and that is
    // right: without the check it would appear for the author and be
    // refused by the server.
    if (!may.add) {
      session.showError(may.structureWhy + '.')
      return
    }
    const created = insertCellAfter(session.doc, bookRoot, id, meta.current.type)
    session.selectCell(created)
    await tick()
    window.dispatchEvent(new CustomEvent('colloq:enter-cell', { detail: { cellId: created } }))
  }

  /**
   * Run, then go on — the pair everyone's fingers already know.
   *
   * Shift+Enter and Cmd+Enter both used to do exactly the same thing, so half
   * of a convention this notebook otherwise imitates down to `In [3]` was
   * missing: there was no way to run a cell and move on without also inserting
   * one. Shift+Enter now steps to the next cell and makes one only when there
   * is no next cell; Cmd/Ctrl+Enter runs and stays; Alt+Enter runs and inserts.
   */
  function runAndStep() {
    if (!run()) return
    step(1, true, false, true, false)
  }

  /**
   * Only Notebook knows the cell order, so hand-offs go through it.
   *
   * `scroll` is separate from `focus` because these are different questions.
   * After Shift+Enter the caret moves to the next cell (fingers expect this),
   * while the screen stays on the output of the one that was run: "I run a
   * cell and want to look at its output, and it throws me down". Moving
   * with an arrow from the last line is the opposite: it must bring the cell
   * into view, otherwise the caret goes past the edge.
   */
  function step(direction: -1 | 1, focus = true, fallback = false, grow = false, scroll = true) {
    window.dispatchEvent(
      new CustomEvent('colloq:step-cell', {
        detail: { cellId: id, direction, focus, fallback, grow, scroll },
      }),
    )
  }

  /**
   * Backspace on an emptied cell, but not on one that has output under it.
   *
   * The text was erased, but the output stayed: a chart, a table, a
   * traceback, the very reason the cell is kept. Deleting takes it away from
   * the whole room and without history, while the gesture that led here is
   * erasing the last letter, not a decision. It can still be removed for
   * real, with the bin in the toolbar and `d d`, and both places say so.
   */
  function deleteIfEmpty() {
    if (!emptyCellIsRemovable(outputs.current.length)) {
      session.showError(tr('room.ui.428'))
      return
    }
    removeSelf(true)
  }

  function removeSelf(focus: boolean) {
    if (!may.remove) {
      session.showError(may.structureWhy + '.')
      return
    }
    // Hand the selection on first, while this cell is still in the list. `fallback`
    // covers deleting the very first cell, which has no cell above it to land on.
    step(-1, focus, true)
    deleteCell(session.doc, id)
  }

  function askAi(action: AiAction) {
    session.selectCell(id)
    window.dispatchEvent(new CustomEvent('colloq:ask-ai', { detail: { cellId: id, action } }))
  }

  /* ------------------------------------------------------ asking for an edit */

  /*
   * The oracle button used to fire 'explain' and open the panel — one canned
   * question, and the answer arrived somewhere else on the screen. What a person
   * actually wants at a cell is to say what is wrong with it in their own words
   * and get the corrected cell back where the cell is.
   *
   * So the button opens a line to type on, right under the cell, and the answer
   * comes back as a diff over that same cell. The thread still gets everything —
   * the question, the reasoning, the code — because the room is entitled to know
   * why the notebook it is reading changed.
   */
  let asking = $state(false)
  let prompt = $state('')
  let sending = $state(false)
  let askError = $state<string | null>(null)
  let promptBox = $state<HTMLTextAreaElement | null>(null)

  async function sendEdit(): Promise<void> {
    const message = prompt.trim()
    if (!message || sending) return
    sending = true
    askError = null
    try {
      await api.aiAsk(session.session.id, session.token, { message, action: 'edit', cellId: id })
      prompt = ''
      asking = false
    } catch (cause) {
      askError = cause instanceof Error ? tr(cause.message) : tr('room.ui.429')
    } finally {
      sending = false
    }
  }

  /*
   * The proposal is read from the shared document, not held here: it belongs to
   * the room. Two people looking at this cell see the same offer, and when one
   * of them decides, the other watches it resolve.
   */
  const patch = watchPatchFor(session.doc, () => id)
  const proposal = $derived(patch.current)
  /**
   * The cell's text: ONE watcher, and only where the text is really read.
   *
   * There used to be two: `source` watched notes (the rendered view is drawn
   * from it), and this one watched every cell in a row, for the sake of a
   * suggestion diff that usually does not exist. On a note they duplicated
   * each other, and on a code cell the second broke exactly the rule the
   * yreactive header warns about: `Y.Text.toString()` rebuilds the whole
   * string on EVERY keystroke, one's own and others', for all five hundred,
   * and restarts `proposedLines`, `proposedCounts` and `proposedTokens`
   * after it.
   *
   * A code cell's text lives in CodeMirror and is not drawn from here. It is
   * needed in exactly two cases: while an oracle suggestion is open (the
   * diff), and in a council, where the student is shown the shared cell as
   * the reference. Outside them there is no subscription at all, and
   * `current` returns an empty string that nobody reads.
   */
  const liveText = watchText(() => (!isCode || proposal || ownSheet ? cell.current : null))

  const proposedLines = $derived.by(() => {
    const proposed = proposal?.get('patch')
    if (typeof proposed !== 'string') return []
    return diffLines(liveText.current, proposed)
  })
  const proposedCounts = $derived(diffCounts(proposedLines))
  // Painted by the editor's own rules, so the proposal reads like the cell it
  // is offering to replace rather than like a quotation of it.
  $effect(() => {
    if (proposal) void loadSyntax()
  })
  const proposedTokens = $derived(
    diffTokens(proposedLines, liveText.current, (proposal?.get('patch') as string) ?? '', syntax()),
  )
  const proposalStale = $derived(proposal ? patchIsStale(session.doc, proposal) : false)

  /*
   * The server decides, not this tab. See ChatTurn.decide: two tabs, each
   * reading `'open'` in its own copy, wrote the patch into the cell twice.
   */
  function accept(): void {
    const id = proposal?.get('id')
    if (typeof id !== 'string') return
    if (!mayPatchHere) {
      session.showError(patchWhy + '.')
      return
    }
    session.send({ t: 'ai:decide', entryId: id, accept: true })
  }

  function decline(): void {
    const id = proposal?.get('id')
    if (typeof id !== 'string') return
    /*
     * After the bell declining is not allowed, although there is no rule
     * about it.
     *
     * While class is on, "Decline" breaks nothing: did not like it, asked
     * again. After the end of class there is nothing to ask with, the oracle
     * answers only the teacher, and a removed banner takes someone else's
     * work with it forever. The same boundary stands on the server.
     */
    if (!acts) {
      session.showError(tr(CLASS_IS_OVER) + '.')
      return
    }
    session.send({ t: 'ai:decide', entryId: id, accept: false })
  }

  $effect(() => {
    if (asking) promptBox?.focus()
  })

  function convert() {
    if (!mayEdit) {
      session.showError(editWhy + '.')
      return
    }
    setCellType(session.doc, id, isCode ? 'markdown' : 'code')
    // Whichever way it went, the cell re-renders in its resting form.
    focusOnEdit = false
    editing = false
  }

  $effect(() => {
    const onEnterCell = (event: Event) => {
      const detail = (event as CustomEvent<{ cellId: string }>).detail
      if (detail?.cellId === id) enter()
    }
    window.addEventListener('colloq:enter-cell', onEnterCell)
    return () => window.removeEventListener('colloq:enter-cell', onEnterCell)
  })

  /*
   * Running from command mode comes here, not through checks of its own in
   * the notebook.
   *
   * Notebook.svelte asked `may.run`, the ROOM's rule, while here and on the
   * server the rule is combined with the lock (`mayRunThisCell`). In a
   * lecture the teacher opens a cell: the button on it is live, Cmd+Enter in
   * the editor works, and Shift+Enter from command mode answered with a
   * toast about the rule, about a cell that is open. A second trouble goes
   * away with it: command-mode Shift+Enter sent `run` for a note too, which
   * the server silently throws out.
   *
   * `focus: false` for the step, because we came from the keyboard in
   * command mode and do not enter the editor.
   */
  $effect(() => {
    const onRunCell = (event: Event) => {
      const detail = (event as CustomEvent<{ cellId: string; step?: boolean }>).detail
      if (detail?.cellId !== id) return
      if (!run()) return
      if (detail.step) step(1, false, false, true, false)
    }
    window.addEventListener('colloq:run-cell', onRunCell)
    return () => window.removeEventListener('colloq:run-cell', onRunCell)
  })

  const TOOL_BASE =
    // 24px square: WCAG 2.5.8's floor, and the difference between hitting
    // "move cell up" and hitting the cell above it on a trackpad.
    'inline-flex h-6 w-6 items-center justify-center text-muted transition-colors ' +
    'duration-[var(--speed-quick)] focus-visible:outline-none focus-visible:ring-2 ' +
    'disabled:opacity-30 disabled:hover:bg-transparent'
  const TOOL = `${TOOL_BASE} hover:bg-line hover:text-ink focus-visible:ring-accent/50`
  const TOOL_DANGER = `${TOOL_BASE} hover:bg-danger/15 hover:text-danger focus-visible:ring-danger/40`

  /** The strip under a cell body: aligned to the code, not to the rule. */
  const FOOTER = 'mt-2.5 flex items-center gap-2 pl-5'
  /**
   * Caps voice for every small label in the sheet: cell state, run credits,
   * the cell's own actions. 11px rather than 10 — see the note on the two
   * smallest steps in tailwind.config.js. This one constant is most of the
   * 525 runs of 10px the workspace was carrying.
   */
  const CAPS = 'text-2xs font-bold uppercase tracking-label'
  /**
   * The state chip and the bar on the left say the same thing in two ways:
   * in words and in colour. Apart they are meaningless (colour without a
   * word survives neither a projector nor colour blindness, a word without
   * colour cannot be read from the middle of the lecture hall), so both
   * tables stand side by side and change together.
   */
  const SHEET_CHIP = {
    edited: 'bg-warning/15 text-warning',
    correct: 'bg-positive/15 text-positive',
    wrong: 'bg-danger/10 text-danger',
    submitted: 'bg-brand/10 text-brand-2',
    /* A draft gets no chip at all (see the footer): there is nothing to say about it. */
    draft: '',
  } as const
  /**
   * The bar runs the full height of the sheet: the code, the output and the
   * teacher's letter stand under one colour, because all of it is one
   * attempt.
   *
   * Rest and edited take no colour at all and hand the bar to the ordinary
   * cell: while a person writes, it matters more that the cell is selected,
   * queued or failed. The old mark meanwhile stops being true: it moves into
   * the word "was:" next to the chip rather than staying as a colour.
   */
  const SHEET_RULE = {
    edited: '',
    correct: 'border-positive',
    wrong: 'border-danger',
    submitted: 'border-brand',
    draft: '',
  } as const
</script>

{#snippet openMark()}
  <!--
    "Open to everyone" is a mark, not a second control: the same cell is
    closed with the same lock on the left. It stands inside the body, above
    the first line: it is a property of the CODE below, and must be read
    together with it, not as a separate banner above the cell.
  -->
  {#if lock && cellOpen}
    <p class={cn(CAPS, 'pb-1 pt-0.5 text-accent-text')}>{tr('room.ui.333')}</p>
  {:else if inCouncil && leads}
    <!--
      For the teacher in a council the shared text is the reference: what
      they show will land here. The label says what this text is, because
      under it stands the console with other people's attempts, and without
      words they are easy to mix up.
    -->
    <p class={cn(CAPS, 'flex flex-wrap items-center gap-x-2 pb-1 pt-0.5 text-accent-text')}>
      <span>{tr('room.ui.34')}</span>
      <span class="font-normal normal-case tracking-normal text-muted"> {tr('room.ui.334')} </span>
    </p>
  {/if}
{/snippet}

{#if cell.current && ytext}
  <div
    bind:this={root}
    role="group"
    aria-label={selected ? tr('room.extra.98', { p0: index + 1 }) : tr('room.extra.99', { p0: index + 1 })}
    data-cell-id={id}
    onfocusin={() => (focusWithin = true)}
    onfocusout={(event) => {
      const next = event.relatedTarget as Node | null
      focusWithin = next !== null && event.currentTarget.contains(next)
    }}
    class="group flex gap-4"
  >
    <!-- Gutter: one ordinal, coloured by state. It stays put on hover — the
         artboard draws the toolbar over a cell whose number is still legible,
         and Run lives in that toolbar rather than under the number. -->
    <!-- The ordinal is pushed right by flex, not by `text-align` on a
         full-width block: the filled selection mark must hug two digits, not
         paint the whole gutter from edge to edge. -->
    <!--
      The lock stands in the gutter on the left, next to the ordinal, and only
      where it decides something (see `lock`). The gutter in this room is
      wider for ALL cells, not just locked ones: otherwise the lock would
      appear and disappear as a single cell opened, and the whole notebook
      would slide sideways on every press of the teacher's.
    -->
    <div
      class={cn(
        'flex h-7 shrink-0 select-none items-start justify-end gap-1.5',
        // 3.5rem together with the neighbour's `gap-4` gives 4.5rem to the
        // cell body: the same number by which Notebook.svelte pushes its line
        // and the bottom row of buttons. Change one, change the other too:
        // otherwise the insertion line would hang to the left of the cells it
        // leads under.
        lock ? 'w-14' : 'w-8',
      )}
    >
      {#if lock}
        <!--
          It can be pressed by the teacher, and only by them: the server
          accepts `cell:open` from the host. The check here is by role, not by
          permissions on this cell; otherwise a participant who had JUST been
          given the cell would get a live "close" button and a refusal in
          response to pressing it.
        -->
        {#if may.role === 'host'}
          <!--
            For the teacher the lock can be pressed, and a second press puts
            everything back. There is no dialog on purpose: a cell is opened
            mid-sentence without taking one's eyes off the audience, and a
            confirmation here would cost more than any mistake: a mistake is
            fixed by the same press.

            The field is set by the server and comes back as an ordinary CRDT
            frame; nothing is predicted here, so the icon changes exactly when
            it changes for the whole room.
          -->
          <!--
            The third position is behind the menu: holding, the right button,
            or a click on the lock in a position a click never led to. Where a
            click leads is decided by the room rule `opens`: in a lecture, the
            shared text; in a council, a sheet for everyone, and then it is
            the council that a second press fixes, while a menu on every click
            would cost a second of silence mid-sentence. The hint must promise
            exactly what will happen: the words are computed by
            lib/lock-button.ts by the same rule.
          -->
          <div class="relative">
            <button
              type="button"
              data-lock-button
              class={cn(
                /*
                 * 24×24 is the WCAG 2.5.8 floor, the very one for which all the
                 * neighbouring toolbar buttons were made 24 pixels (TOOL_BASE
                 * below). The lock was 20×20, even though it is the teacher's
                 * most frequent button in a lecture and the only one with a
                 * hold. Negative margins give the target back its old PLACE in
                 * the layout (20 px, same centre), so the ordinal column does
                 * not move.
                 *
                 * The transition is listed as properties, not
                 * `transition-colors` plus `.press`: the Tailwind utility
                 * rewrites transition-property entirely, and the helper's
                 * transform would not make it into the list: exactly the trap
                 * described at CAP in Notebook.svelte.
                 */
                'mt-0.5 -mx-0.5 inline-flex h-6 w-6 items-center justify-center',
                'transition-[color,background-color,transform] duration-press ease-out',
                'enabled:active:scale-[0.97]',
                'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50',
                'disabled:pointer-events-none disabled:opacity-40',
                cellOpen || inCouncil
                  ? 'bg-accent/15 text-accent-text'
                  : 'text-faint hover:bg-line hover:text-ink',
              )}
              disabled={controlDisabled(session.connected)}
              aria-pressed={cellOpen || inCouncil}
              aria-haspopup="menu"
              aria-expanded={lockMenu}
              aria-label={lockLabel(lockState, opens)}
              title={controlTitle(session.connected, lockHint(lockState, opens))}
              onclick={pressLock}
              onpointerdown={startHold}
              onpointerup={endHold}
              onpointerleave={endHold}
              onpointercancel={endHold}
              oncontextmenu={(event) => {
                event.preventDefault()
                endHold()
                lockMenu = true
              }}
            >
              <!-- A dimmed icon = "the press went out, the frame has not come
                   yet". Not a predicted position but a sign of sending: see
                   markSending. -->
              <Icon
                name={lockIcon}
                size={13}
                class={cn('transition-opacity duration-press ease-out', lockSending && 'opacity-60')}
              />
            </button>
            {#if lockMenu}
              <!--
                There is no room to the left of the notebook, so the menu opens
                to the right, over the cell body. The menu has ONLY THE THREE
                LOCK POSITIONS: no council settings, no "open console" row:
                everything the council is run with lives in the console window,
                and the menu answers one question: whose cell is this now. The
                console is opened with the button under the cell, where one can
                see how many have already submitted.
              -->
              <div
                role="menu"
                tabindex="-1"
                data-lock-menu
                class="absolute left-0 top-full z-30 mt-1 w-64 border border-line bg-canvas p-1 shadow-pop"
              >
                {#each LOCKS as item (item.state)}
                  {@const current = lockState === item.state}
                  <button
                    role="menuitemradio"
                    type="button"
                    aria-checked={current}
                    class={cn(
                      'flex w-full items-start gap-2 px-2.5 py-1.5 text-left text-ui',
                      'transition-colors duration-100',
                      current ? 'bg-raised text-ink' : 'text-ink hover:bg-raised',
                    )}
                    onclick={() => setLock(item.state)}
                  >
                    <Icon
                      name={item.icon}
                      size={13}
                      class={cn('mt-0.5 shrink-0', current ? 'text-accent-text' : 'text-muted')}
                    />
                    <span class="flex min-w-0 flex-1 flex-col">
                      <span>{item.label}</span>
                      <span class="text-2xs text-muted">{item.hint}</span>
                    </span>
                    {#if current}
                      <Icon name="check" size={12} class="mt-1 shrink-0 text-accent-text" />
                    {/if}
                  </button>
                {/each}
              </div>
            {/if}
          </div>
        {:else}
          <!-- For someone who cannot open it, the lock only shows. It is still
               needed: otherwise it is unclear why the cell does not take
               typing. -->
          <span
            class={cn(
              'mt-1 inline-flex h-5 w-5 items-center justify-center',
              cellOpen || inCouncil ? 'text-accent-text' : 'text-faint',
            )}
            title={inCouncil
              ? tr('room.extra.109')
              : cellOpen
                ? tr('room.extra.110')
                : tr('room.extra.111')}
          >
            <Icon name={lockIcon} size={13} />
          </span>
        {/if}
      {/if}
      <!--
        The ordinal's colour changes instantly, and that is not economy but a
        rule: `tone` is switched by the arrow keys, Enter and j/k, that is,
        hundreds of times per class. The mark "this cell is the live one now"
        is the only thing by which twenty people in the room understand where
        to look; a 100ms transition shifts it a hundred milliseconds after the
        press, and when flipping through cells quickly the colour keeps
        chasing the cursor instead of standing under it.

        The same argument as twenty lines below about the focus ring: a cue
        that arrives late is worse than one that arrives abruptly.
      -->
      <!--
        The label on the ordinal is the only place where a cell without output
        can say something about time: the "Out [n]" line is drawn only under
        output, and a text cell has none at all.
      -->
      <div
        class="flex flex-col items-end gap-[3px]"
        title={[
          mark?.tone === 'idle' ? tr('room.extra.112') : null,
          mark?.tone === 'lost' ? tr('room.extra.113') : null,
          meta.current.execCount === null ? null : tr('room.extra.114', { p0: meta.current.execCount }),
          meta.current.ranMs !== null && meta.current.ranMs >= NOTICED_MS
            ? spell(meta.current.ranMs)
            : null,
        ]
          .filter(Boolean)
          .join(' · ') || undefined}
      >
      <!--
        The ordinal can be pressed and selects its cell, with the same handler
        and the same Shift and Cmd as the body: a range and deselecting one of
        several work from here just as from the code.

        The marker and the handler hang on the ordinal itself, not on the
        column: the empty space under it is already "outside the cell", and
        must still clear the selection. Two digits are a small target, but on
        a selected cell it is a filled rectangle, that is, exactly what people
        aim at.
      -->
      <!-- svelte-ignore a11y_no_static_element_interactions -->
      <span
        data-cell-pick
        onpointerdown={(event) => onselect(event)}
        class={cn(
          'text-head font-black tabular-nums tracking-tight',
          /*
           * A selected cell is marked by the ORDINAL, not by a background,
           * and it is the only mark that survives every state.
           *
           * The background goes out on a running and a failed cell: they have
           * their own colours, and painting over them would be a lie. And the
           * oracle is asked most often precisely about the failed one: not
           * seeing whether it is in the selection is a question asked blind.
           *
           * The state colour is NOT added meanwhile: `cn` is clsx, it does
           * not resolve classes, and `text-ink` from `ORDINAL.selected`
           * together with `text-canvas` gave digits of the background colour
           * on a background of the same colour: a dark rectangle instead of
           * an ordinal.
           */
          selected ? 'bg-ink px-1 text-canvas' : ORDINAL[tone],
        )}
      >
        {ordinal}
      </span>
      <!--
        The run mark is under the ordinal, monospaced, exactly three characters.
        
        Three characters make a vertical: `[ ]`, `[7]` and `[*]` line up under
        one another, and the sheet reads as one column from top to bottom. For
        its sake, too, the mark stands in the gutter and not under the output:
        under the output it would be missing for cells without output, and
        that is half the notebook.
      -->
      <!--
        The oracle has taken this cell, and says so in the ORDINAL's gutter.
        
        The place is the same as the run mark's: it is the "what is being done
        to this cell right now" slot, and the oracle is a worker just like the
        kernel. While it is busy, the mark gives way: `[7]` is about the
        previous run, while the asterisk is about what is happening now, and
        now matters more. The mark comes back by itself as soon as the turn
        ends.
        
        The kernel outranks it: if both took the cell, the slot stays with
        `[*]`. The kernel CHANGES this cell, while the oracle so far only reads
        it, and they must not be confused in one sign. That the oracle is busy
        meanwhile is said by the line under the cell.
        
        The asterisk itself twinkles, its two halves in turn (index.css ·
        cell-sparkle). This is not a running bar and not a second breathing
        next to the kernel's: people look at the ordinal gutter anyway when
        asking "what about this cell", and the oracle's sign is recognised
        there without explanation: the button above the cell and the panel
        are marked with it too.
      -->
      {#if oracleBusy && !shownRunning}
        <Icon name="sparkles" size={12} class="cell-sparkle shrink-0 text-accent-text" />
      {:else if mark}
        <span class={cn('font-mono text-2xs leading-none', MARK[mark.tone])}>{mark.label}</span>
      {/if}
      <!--
        How long it took, right here, and only when it took a noticeable time.
        Under two seconds the number reports that the computer coped quickly,
        and by the end of class a notebook has forty such cells.
      -->
      {#if meta.current.ranMs !== null && meta.current.ranMs >= NOTICED_MS && !shownRunning}
        <span class="font-mono text-micro leading-none text-faint">{spell(meta.current.ranMs)}</span>
      {/if}
      </div>
    </div>

    <!--
      A cell is pressed where a person sees the cell.

      The press used to be caught by the outer block, and it is wider than
      what counts as the cell: it includes the gutter with the ordinal, the
      empty space under it and the gap to the body. A click into the void on
      the left selected the cell, and it looked like an interface miss, not a
      choice: people aimed past it and hit the cell.

      Now the press is listened to by the body column (code, output, the input
      form, the toolbar above them), and the gaps around stay neutral: they do
      not select.

      And they clear the selection too. Half the job was not enough: the
      ordinal column stopped selecting, but for clearing it still counted as
      the cell (the check went by `data-cell-id`, and that is on the root),
      and a click on the white space under the ordinal did nothing: one had to
      aim at the notebook's margins. So the marker sits not on the root but on
      what gets pressed: `data-cell-pick` says where the cell ends to the
      touch.

      THE ORDINAL ITSELF is the exception, and it carries this marker too (see
      below). A selected cell is marked precisely by its ordinal, a filled
      rectangle, so people aim at the selection mark, and missed: a press on
      it CLEARED the selection. The empty gutter under the ordinal still
      clears it, as the notebook's margins around ask.
    -->
    <!-- svelte-ignore a11y_no_static_element_interactions -->
    <div
      class="relative min-w-0 flex-1"
      data-cell-pick
      onpointerdowncapture={(event) => onselect(event)}
      oncontextmenucapture={(event) => {
        // Chrome on macOS emits contextmenu after Ctrl+left-click even when
        // pointerdown was cancelled. Keep CodeMirror from taking focus back.
        if (event.ctrlKey && event.button === 0) {
          event.preventDefault()
          event.stopPropagation()
        }
      }}
    >
      <!-- Out of flow and above the body: a toolbar that appeared in flow would
           push the cell down the moment the pointer arrived. -->
      <!-- A marker for the notebook: it measures this row to leave room for it
           above the cell the screen leads to (see lib/cell-scroll.ts). The
           row stands out of flow, and without the measurement Shift+Enter
           carried it past the top edge: the toolbar ended up exactly where
           nobody looks. -->
      <div
        data-cell-toolbar
        class={cn(
          'absolute bottom-full right-0 z-10 flex items-center gap-0.5 bg-raised px-1.5 py-0.5',
          'opacity-0 group-hover:opacity-100 focus-within:opacity-100',
          // The transition lives only on an unselected cell, and so it goes
          // exactly to hover: the mouse is moved slowly and a smooth fade-in
          // helps it. A selected cell has no transition, so an arrow key
          // opens the toolbar in the same frame it is pressed in. Leaving the
          // cell brings the transition back, and the neighbour's toolbar
          // settles down rather than vanishing.
          !selected && 'transition-opacity duration-[var(--speed-quick)]',
          selected && 'opacity-100',
        )}
      >
        <!--
          A locked cell has no first slot at all: neither "run" nor a dimmed
          "run". Usually things are dimmed here rather than hidden (the
          layout argument below), but in a lecture the WHOLE row goes dark for
          a participant: they may not move, duplicate, edit or delete either,
          and nothing moves under the cursor. Promising with a button an
          action this room does not have costs more.
        -->
        {#if isCode && !shut}
          <!--
            One place, three faces: run, remove from the queue, stop.

            We dim rather than hide, in every refusal, including someone
            else's queued cell, where below "cancel" is exactly what gets
            hidden. The asymmetry is deliberate and about layout: below it is
            the last button in the row and its disappearance moves nothing,
            while here losing the first slot would shift "up" and "down" under
            a cursor that was aiming at one of them. For the same reason a
            refusal phrase for "cancel" had to be invented in run-slot.ts,
            which the product did not have.

            There is no transition on the change of face. `transition-colors`
            in TOOL answers the cursor, not the state, and the colour lives on
            the icon itself. The face here changes with the kernel state that
            arrived over the network: a smooth blend would draw a button half
            "start", half "stop" exactly at the moment the person decides
            whether to press.
          -->
          <button
            type="button"
            class={TOOL}
            disabled={slot.disabled}
            title={slot.title}
            aria-label={slot.label}
            onclick={() => {
              if (slot.action === 'run') run()
              else if (slot.action === 'cancel') session.send({ t: 'cancel', cellId: id })
              else session.send({ t: 'interrupt', cellId: id })
            }}
          >
            <Icon name={slot.icon} size={slot.size} class={slot.tint} />
          </button>
        {:else if !isCode && !editing}
          <button
            type="button"
            class={TOOL}
            title={mayEdit ? tr('room.extra.120') : editWhy}
            aria-label={tr('room.ui.340')}
            disabled={!mayEdit}
            onclick={() => enter()}
          >
            <Icon name="text" size={13} />
          </button>
        {/if}
        <button
          type="button"
          class={TOOL}
          title={may.move ? tr('room.extra.121') : may.structureWhy}
          aria-label={tr('room.ui.341')}
          disabled={index === 0 || !may.move}
          onclick={() => session.send({ t: 'cells:move', cellId: id, direction: -1 })}
        >
          <Icon name="chevron-up" size={13} />
        </button>
        <button
          type="button"
          class={TOOL}
          title={may.move ? tr('room.extra.122') : may.structureWhy}
          aria-label={tr('room.ui.342')}
          disabled={last || !may.move}
          onclick={() => session.send({ t: 'cells:move', cellId: id, direction: 1 })}
        >
          <Icon name="chevron-down" size={13} />
        </button>
        <!--
          This slot copies the cell's text to the clipboard, for everyone,
          always.

          It used to create a copy of the cell in the shared notebook for
          those allowed to add cells, and the icon for a copy is the same as
          for "copy". On 19 Sep 2026, in class, three students wanting to take
          the code with them pressed it six to nine times each: stacks of
          identical cells with imports grew in the shared notebook, and the
          teacher removed them by hand mid-class. A copy of a cell is "copy,
          add a cell, paste"; there is no separate button for it on purpose.
        -->
        <button
          type="button"
          class={TOOL}
          title={copied ? tr('room.ui.1268') : tr('room.ui.1900')}
          aria-label={tr('room.ui.1900')}
          data-cell-copy
          onclick={() => void copySource()}
        >
          <Icon name={copied ? 'check' : 'copy'} size={13} />
        </button>
        <button
          type="button"
          class={TOOL}
          title={mayEdit ? (isCode ? tr('room.extra.124') : tr('room.extra.125')) : editWhy}
          aria-label={isCode ? tr('room.extra.126') : tr('room.extra.127')}
          disabled={!mayEdit}
          onclick={convert}
        >
          <Icon name={isCode ? 'text' : 'code'} size={13} />
        </button>
        <!-- Asking is an action too: after the end of class the oracle answers
             only the teacher (may.ask), and a line in which a person manages
             to write a sentence is a refusal received after the work is done.
             The same with the oracle mode: `hints` refuses to rewrite a cell,
             and one must know that BEFORE typing the sentence (see
             `rewriteReady`). -->
        <!--
          Where the cell cannot be edited (a lecture, the shared council
          cell), the icon stays in place but dimmed, with the reason in the
          tooltip. It does not disappear: all cells have one toolbar, and a
          missing button reads as a breakage, not as a rule. Asking ABOUT the
          cell is still possible: the question lives in the panel, not here.
        -->
        <button
          type="button"
          class={TOOL}
          title={mayRewrite ? tr('room.extra.128') : rewriteRefusal}
          aria-label={tr('room.ui.344')}
          aria-pressed={asking}
          disabled={!mayRewrite}
          onclick={() => (asking = !asking)}
        >
          <Icon name="sparkles" size={13} class="text-accent-text" />
        </button>
        {#if isCode}
          <!--
            Clean up after yourself in your own cell.

            The "wipe shared" rule is about the whole board, and the server
            tells the difference (`clearOutputs` with a cell name asks for the
            right to type, not the right to wipe). In a room with `wipe: host`
            the hint under the rule promised that a person can always clear
            their own cell, yet there was nothing to press: the client could
            only wipe the whole notebook at once.
          -->
          <button
            type="button"
            class={TOOL}
            title={controlTitle(session.connected, mayEdit ? tr('room.extra.129') : editWhy)}
            aria-label={tr('room.ui.345')}
            disabled={!mayEdit || controlDisabled(session.connected)}
            onclick={() => session.send({ t: 'clearOutputs', cellId: id })}
          >
            <Icon name="eraser" size={13} />
          </button>
        {/if}
        <button
          type="button"
          class={TOOL_DANGER}
          title={may.remove ? tr('room.extra.131') : may.structureWhy}
          aria-label={tr('room.ui.346')}
          disabled={!may.remove}
          onclick={() => removeSelf(false)}
        >
          <Icon name="trash" size={13} />
        </button>
      </div>

      <!--
        A wrapper for the sake of one breathing bar lying over the left edge.

        Just a block around block siblings, so the layout does not change, and
        `bind:clientHeight` stays on the same inner div: parking is not
        affected. The bar stands outside `{#if mounted}` on purpose: a running
        cell is never parked now (`pinned` includes `running`), but if that
        rule ever changes, a parked running cell will get a lit edge rather
        than a bar paler than the queue.
      -->
      <div class="relative">
      {#if mounted}
        <div bind:clientHeight={contentHeight}>
          {#if ownSheet && sheet}
            <!--
              A student's own sheet in a council, and it is the WHOLE cell.

              The same CodeMirror, but bound to a local document (see
              `openSheet`): not a single letter goes from here into the shared
              Y.Text. The snapshot goes out by itself on a pause in typing and
              when focus leaves; the button on the right and the single
              combination ⌘⇧↵ submit.

              There is no second cell above the sheet anymore. The shared text
              stood here read-only ("Shared cell, visible to the whole group"),
              and the price of it was a second block of code on the screen of
              a person writing their own. The task is read above anyway, in
              the markdown cell over this one, and what was shown to the class
              is visible on the projector; it has no place in the student's
              notebook. The shared cell's output is not drawn at all for the
              same reason (see the output area below): under the sheet lies
              the output of ONE'S OWN attempt, and two different outputs in a
              row read as one.

              There is one bar here for everything: the sheet, the output and
              the teacher's letter stand under one edge of one colour, because
              this is one attempt, not three neighbouring blocks. The footer
              comes out from under the edge: it is about what can be DONE with
              the attempt, and is aligned to the code, as in an ordinary cell.
            -->
            <div
              onfocusout={(event) => {
                const next = event.relatedTarget as Node | null
                if (!next || !event.currentTarget.contains(next)) session.council.flush(id)
              }}
            >
              <div class={cn('border-l-4 px-3 py-1', SHEET_RULE[sheetState] || RULE[tone], 'bg-surface')}>
                <!--
                  The sheet's header: what sets this cell apart from its
                  neighbours (the chip) and what has already happened to the
                  attempt (the label). The chip never changes: the cell is
                  recognised by it; the label changes with the state and says
                  exactly what does not fit into the one word of the chip in
                  the footer.
                -->
                <div class="flex flex-wrap items-center gap-x-2 gap-y-0.5 pb-1 pt-0.5">
                  <span class={cn(CAPS, 'bg-accent/10 px-1.5 py-px text-accent-text')}>
                    {tr('room.ui.34')}
                  </span>
                  <span class="text-2xs text-muted">
                    {#if councilClosed} {tr(COUNCIL_CLOSED)} {:else if sheetState === 'edited'}
                      {mine?.correct != null ? tr('room.ui.1245') : tr('room.ui.1246')}
                    {:else if sheetState === 'correct' || sheetState === 'wrong'}
                      {reviewedAt === null
                        ? tr('room.ui.1243', { p0: clock(submittedAt ?? 0) })
                        : tr('room.ui.1242', { p0: clock(submittedAt ?? 0), p1: clock(reviewedAt) })}
                    {:else if sheetState === 'submitted'}
                      {letters.length > 0 ? tr('room.ui.1244') : tr('room.ui.1241')}
                    {:else} {tr('room.ui.1222')} {/if}
                  </span>
                  <!-- The class count stands here, not in the footer: it is
                       information about the room, not an action, and in the
                       footer it competed with the buttons for space: on a
                       narrow column they slid down away from it. -->
                  {#if count && !councilClosed}
                    <span class="font-mono text-2xs tabular-nums text-muted">{countLine(count)}</span>
                  {/if}
                </div>
                <!--
                  Submitted text is not dimmed.

                  Dimming stood here and read as "faded": a submitted attempt
                  is exactly the thing that is reread after submitting, and
                  half the contrast on code gets in the way of precisely the
                  rereading. That editing is closed is said by the chip in the
                  footer and the missing run buttons: by a word and by absence,
                  not by fog.

                  Kernel completions here are the same as in an ordinary cell,
                  and the cell's name travels with the question: by it the
                  server tells one's own council sheet from the rest
                  (control.ts · mayComplete). Without it, in a lecture room, a
                  student in the ONLY cell where they are told to write code
                  got only words from that very cell: `df.` knew not a single
                  real column.

                  JUMP TO DEFINITION is here too, and that is a decision, not
                  symmetry with the cell. The sheet is the only place where a
                  student in a lecture room writes code themselves, and writes
                  it on top of the seminar's modules: `from utils import helper`
                  on the first line, and then the whole exercise is about what
                  is inside `helper`. Without the jump they never get there.

                  But the cell's name does NOT go into this question, although
                  it goes into completion. The sheet does not live in the
                  shared notebook (it has its own Y.Doc connected to nothing:
                  above · openSheet), and `cellId` would mean "I am asking from
                  this cell", that is, it would take the search into someone
                  else's text the student did not write. Without it the server
                  parses its own source from the code sent and searches the
                  room's notebooks and the seminar's files.

                  There is no landing mark (`mark`) for the same reason: there
                  is nowhere to lead into the sheet: it exists only for its
                  author and cannot appear in the server's answer.
                -->
                <CodeEditor
                  text={sheet.text}
                  awareness={sheet.awareness}
                  undoManager={sheet.undo}
                  language={isCode ? 'python' : 'markdown'}
                  label={tr('room.extra.132', { p0: ordinal })}
                  readOnly={!mayAttempt || submittedAt !== null}
                  placeholder={tr('room.ui.354')}
                  onfocus={() => onselect()}
                  onrun={sheetRunKey}
                  onrunstep={sheetRunKey}
                  onsubmit={submitFromKey}
                  onescape={() => root?.querySelector<HTMLElement>('.cm-content')?.blur()}
                  onarrowout={(direction) => step(direction)}
                  complete={(code, cursor) => session.complete(code, cursor, id)}
                  inspect={(code, cursor) => session.inspect(code, cursor, id)}
                  jump={(code, cursor) => void jumpToDefinition(session, code, cursor, {})}
                  maxChars={MAX_ATTEMPT_CHARS}
                  onoverflow={(chars) =>
                    session.showError(
                      tr('room.extra.133', { p0: MAX_ATTEMPT_CHARS.toLocaleString(getLocale()), p1: chars.toLocaleString(getLocale()) }),
                    )}
                />
                <!--
                  The character counter: under the sheet and only near the end.

                  The ceiling used to be reported by the server: a refusal on
                  every pause in typing, that is, a toast once a second, from
                  which one could learn neither how much was typed nor how much
                  is allowed. The counter appears nine tenths of the way
                  (council.svelte.ts · attemptCounter) and states the same
                  number as the refusal.
                -->
                {#if attemptCount}
                  <p
                    class={cn(
                      'flex flex-wrap items-baseline justify-end gap-x-2 pt-0.5 text-2xs',
                      attemptOver ? 'text-warning' : 'text-muted',
                    )}
                  >
                    {#if attemptOver}
                      <span>{tr('room.ui.355')}</span>
                    {/if}
                    <span class="font-mono tabular-nums">{attemptCount}</span>
                  </p>
                {/if}
              </div>
              <!-- The run's output belongs to the attempt, not to the shared
                   cell: it arrives for the author together with the attempt
                   and lies right under it, under the same edge. The shared
                   cell has no output on this screen at all, so there is
                   nothing to confuse them with. -->
              {#if attemptRun}
                <!-- The same pair as in an ordinary cell: output on the sheet,
                     code on the slab, a hairline between them. -->
                <div
                  class={cn(
                    'border-l-4 border-t',
                    SHEET_RULE[sheetState] || RULE[tone],
                    attemptRun.state === 'error' ? 'bg-danger/5' : 'bg-canvas',
                  )}
                  style:border-top-color="rgb(var(--line))"
                >
                  {#if attemptRun.outputs.length > 0}
                    <div class="px-2 py-1.5">
                      <CellOutputs outputs={attemptRun.outputs} />
                    </div>
                  {/if}
                  <div class="px-4 pb-1.5 pt-0.5 text-2xs text-muted">
                    {ranByLine(attemptRun, spell)}
                  </div>
                </div>
              {/if}
              <!--
                The teacher's letter is UNDER the output and inside the same
                edge: it is part of the attempt, not a neighbouring chat. The
                signature is of whoever answered: a room may have two teachers,
                and an oracle draft arrives here already in their words.

                One letter per line, not all in one paragraph: the personal
                answer and the message to the group are written at different
                times and to different people, and run together they read as
                one letter. The group one is marked with a word: then silence
                on the personal one means "this is for you".
              -->
              {#if letters.length > 0}
                <div
                  class={cn('border-l-4 border-t px-3 py-1.5', SHEET_RULE[sheetState] || RULE[tone], 'bg-surface')}
                  style:border-top-color="rgb(var(--line))"
                >
                  {#each letters as letter}
                    <div class="flex items-start gap-2 py-0.5">
                      <span
                        class={cn(
                          'mt-1.5 h-2 w-2 shrink-0 rounded-full',
                          letter.to === 'oracle' ? 'bg-accent' : 'bg-brand-2',
                        )}
                        aria-hidden="true"
                      ></span>
                      <div class="min-w-0">
                        <p class="flex flex-wrap items-baseline gap-x-2 text-2xs">
                          <span class="text-ui font-bold text-ink">{letter.by}</span>
                          <span class="text-muted">
                            {letter.to === 'oracle' ? tr('room.ui.1261') : tr('room.ui.1251')} ·
                            {clock(letter.at)}
                          </span>
                          {#if letter.to === 'group'}
                            <span class="text-muted">{tr('room.ui.70')}</span>
                          {/if}
                        </p>
                        <p class="text-ui text-ink">{letter.text}</p>
                      </div>
                    </div>
                  {/each}
                </div>
              {/if}
              <!--
                What was shown to the class is an attachment to ONE'S OWN cell,
                not a second cell.

                The teacher put up someone's answer: the person's own text
                stays their own, and the other one grows on underneath, under
                the same edge, with no gap, with the bar changing colour to
                positive and with a signature. It is the only place in the
                notebook where the edge changes colour midway, and it lives
                exactly as long as the showing does: "take off the screen"
                collapses the block, and the cell returns to one column.

                The fold is measured by height (`slide`), like the header's
                fold: the block gives its place back to the notebook entirely
                rather than dissolving and leaving a hole. Under
                `prefers-reduced-motion`, zero, that is, instant.
              -->
              {#if showsOnScreen && onScreen}
                <div
                  transition:slide={{ duration: prefersReducedMotion() ? 0 : 200, easing: quintOut }}
                >
                  <CouncilOnScreen shown={onScreen} />
                </div>
              {/if}
              <!--
                The restore question is a bar across the whole cell, not a
                browser dialog.

                `window.confirm` knocks one out of the page and looks foreign
                exactly where the answer is visible right here: in the sheet
                that will be replaced. Ochre, because this is neither an error
                nor a danger but an unfinished movement: one press there, one
                back.
              -->
              {#if restoreAsking}
                <div
                  class="mt-px flex flex-wrap items-center gap-x-3 gap-y-1.5 border-l-4 border-warning bg-warning/10 px-3 py-2"
                  role="group"
                >
                  <span class="text-ui font-bold text-ink">{tr('room.ui.1233')}</span>
                  <span class="text-2xs text-muted">{tr('room.ui.1250')}</span>
                  <!-- The pair of answers stays together: on a narrow column
                       the line wraps, and "Cancel", pressed alone against the
                       edge, ended up a line above its "Restore". -->
                  <span class="ml-auto flex items-center gap-3">
                    <button
                      type="button"
                      class="text-2xs text-muted hover:text-ink"
                      onclick={() => (restoreAsking = false)}
                    >{tr('room.ui.1235')}</button>
                    <button
                      type="button"
                      class="btn h-7 bg-warning text-canvas hover:brightness-110"
                      onclick={restoreStub}
                    >{tr('room.ui.1234')}</button>
                  </span>
                </div>
              {/if}
              <!--
                The footer: on the left a quiet "start over", on the right the
                actions in increasing weight: the state in words, run, submit.

                "Restore" stands at the opposite end of the footer from "Run"
                and "Submit" on purpose: there is half the cell's width between
                them, one cannot miss. Its weight is quiet (an icon and muted,
                no border or fill): the life buoy is visible but does not argue
                with the main thing.
              -->
              <div
                class="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1.5 pl-5 pr-1"
                bind:clientWidth={footerWidth}
              >
                {#if !councilClosed}
                  <button
                    type="button"
                    class="inline-flex h-7 items-center gap-1.5 text-2xs text-muted transition-colors
                           duration-[var(--speed-quick)] hover:text-ink disabled:cursor-not-allowed
                           disabled:text-faint disabled:hover:text-faint"
                    disabled={!mayRestore || restoreAsking}
                    title={tr('room.ui.1240')}
                    onclick={() => (restoreAsking = true)}
                  >
                    <span aria-hidden="true">↺</span>
                    {tr('room.ui.1232')}
                  </button>
                  {#if submittedAt === null && sheetText === stubText()}
                    <span class="text-2xs text-muted">{tr('room.ui.1249')}</span>
                  {/if}
                  <!--
                    The hint stands on the left, next to "Restore", not among
                    the actions on the right: both are help for someone stuck,
                    and both are quiet. On the right lives what moves the
                    attempt forward.
                  -->
                  {#if mayHint || hint?.asking}
                    <button
                      type="button"
                      class="inline-flex h-7 items-center gap-1.5 text-2xs text-accent-text transition-colors
                             duration-[var(--speed-quick)] hover:text-ink disabled:cursor-not-allowed
                             disabled:text-faint disabled:hover:text-faint"
                      disabled={hint?.asking || !mayHint}
                      title={tr('room.ui.1264')}
                      onclick={() => session.council.askHint(id)}
                    >
                      <Icon name="sparkles" size={12} />
                      {hint?.asking ? tr('room.ui.1263') : tr('room.ui.1262')}
                    </button>
                  {/if}
                  {#if hint?.error}
                    <span class="text-2xs text-warning" role="status">{hint.error}</span>
                  {/if}
                {/if}

                <!--
                  The actions are one group, pressed to the right.

                  Not scattered in the common flex: there, when space ran out,
                  ONE outermost button slid down, leaving the chip on top, that
                  is, exactly the pairing the footer is read for broke. The
                  group wraps as a whole and stays aligned to the right edge,
                  as on the artboards.
                -->
                <span class="ml-auto flex flex-wrap items-center justify-end gap-x-2.5 gap-y-1.5">
                {#if councilClosed}
                  <span class={cn(CAPS, 'bg-surface px-2 py-0.5 text-muted')}>{tr('room.ui.370')}</span>
                {:else}
                  {#if sheetState === 'edited' && mine?.correct != null}
                    <!-- The old mark is no longer true, but it is not an empty
                         place either: it is what the edits are for. It stays as
                         a memory, muted. -->
                    <span class="text-2xs text-muted">
                      {tr('room.ui.1247')} {mine.correct ? tr('room.ui.1225') : tr('room.ui.1226')}
                    </span>
                  {/if}
                  <!--
                    A draft has no chip.

                    It used to say "DRAFT · SAVING": two words about what
                    happens anyway with every letter in every field of the
                    product, in the most visible spot of the footer and in the
                    cell's most frequent state: ninety percent of the time a
                    person read a message that nothing had happened. The chip
                    appears where there is something to say: submitted, unsent
                    edits, a mark, on screen. That the text goes to the teacher
                    is said by the label in the header, once and at the top.
                  -->
                  {#if sheetState !== 'draft'}
                    <span class={cn(CAPS, 'px-2 py-0.5', SHEET_CHIP[sheetState])} role="status">
                      {#if sheetState === 'edited'} {tr('room.ui.1228')} {:else if sheetState === 'correct'}
                        {tr('room.ui.1225')}
                      {:else if sheetState === 'wrong'} {tr('room.ui.1226')} {:else}
                        {tr(tightFooter ? 'room.ui.1252' : 'room.ui.1224', { p0: clock(submittedAt ?? 0) })}
                      {/if}
                    </span>
                  {/if}
                  {#if mine?.shown}
                    <span class={cn(CAPS, 'bg-positive/15 px-2 py-0.5 text-positive')}>
                      {tr('room.ui.1227')}
                    </span>
                  {/if}
                  {#if !mayAttempt}
                    <span class="text-2xs text-muted">{attemptWhy}</span>
                  {/if}

                  <!--
                    A submitted attempt has no run buttons at all: submitted
                    means closed, and a dimmed button would say the problem is
                    the connection. They come back together with the right to
                    write, after "Edit".
                  -->
                  {#if submittedAt === null}
                    {#if runWaiting}
                      <!--
                        The waiting stands IN PLACE OF the button, not next to
                        it: there is one kernel per room, there is nothing to
                        press a second time, and a button left live next to the
                        queue number offered exactly that. The number is given
                        when it is known; while the request is with the teacher,
                        all that is known is that we are waiting.
                      -->
                      <span
                        class={cn(CAPS, 'inline-flex h-7 items-center gap-2 border border-accent px-3 text-accent-text')}
                        role="status"
                      >
                        {mine?.queue != null
                          ? tr('room.ui.1236', { p0: mine.queue })
                          : tr('room.ui.1260')}
                        {#if mayCancelRun}
                          <button
                            type="button"
                            class="font-normal normal-case tracking-normal text-accent-text hover:underline disabled:no-underline disabled:opacity-40"
                            disabled={controlDisabled(session.connected) || requestSending !== null}
                            onclick={cancelAttemptRunRequest}
                          >{requestSending?.action === 'cancel' ? tr('room.ui.360') : tr('room.ui.1238')}</button>
                        {/if}
                      </span>
                    {:else if runPaused}
                      <!--
                        The countdown is IN THE SAME PLACE and with the same
                        chip as "Queued · 3", but without the accent: the queue
                        is about your run, which is already under way, while
                        the pause is the teacher's rule, and there is no reason
                        to alarm anyone with it. The edge and the muted text say
                        exactly this: not trouble and not an action, but a
                        condition.

                        `aria-live="off"` with `role="status"`: the digit
                        changes twice a second, and an ordinary polite live
                        region would make a screen reader read the whole
                        countdown. The name meanwhile carries both the
                        remainder and the reason in full: they will be read
                        when the reader gets to the chip.
                      -->
                      <span
                        class={cn(
                          CAPS,
                          'inline-flex h-7 items-center border px-3 tabular-nums',
                          pauseNudge ? 'border-ink text-ink' : 'border-line text-muted',
                        )}
                        role="status"
                        aria-live="off"
                        aria-label={`${tr('room.council.nextRun', { p0: pauseClock(pauseLeft) })} · ${tr('room.council.nextRunWhy')}`}
                        title={tr('room.council.nextRunWhy')}
                      >
                        {tr('room.council.nextRun', { p0: pauseClock(pauseLeft) })}
                      </span>
                    {:else if mayRunAttempt || mayRequestRun}
                      <!--
                        The teacher's refusal is the only thing spoken about in
                        words here: the button went back to its initial state,
                        and without the line this would read as "the press did
                        not get through". Diverged text (the request was about
                        the previous version) stays silent: the button is live
                        again, and pressing it is the whole answer.
                      -->
                      {#if mine?.runRequest?.status === 'declined' && attemptSynced}
                        <span class="text-2xs text-muted" role="status">{tr('room.ui.364')}</span>
                      {/if}
                      <button
                        type="button"
                        class="btn-outline h-7"
                        disabled={!mayPressRun || attemptOver || controlDisabled(session.connected)}
                        title={controlTitle(
                          session.connected,
                          tr('room.extra.138', { p0: tr(COUNCIL_SHARED_KERNEL_NOTE) }),
                        )}
                        onclick={sheetRunKey}
                      >
                        {tr('room.ui.73')}
                        <span class="font-mono text-2xs text-muted">⇧↵</span>
                      </button>
                    {:else}
                      <!-- The setting is off: there is no button, and that is
                           said with a word, not a dimmed button: there is
                           nothing to dim, running here is not yours. -->
                      <span class="text-2xs text-muted">{tr('room.ui.1230')}</span>
                    {/if}
                  {/if}

                  <!--
                    Submitting is one button in one place that changes its
                    word: "Submit" → "Edit" → "Submit again". "Fix" is the same
                    "Edit", named for what it does: after "there is an error"
                    the button leads to the way out rather than repeating the
                    trouble.
                  -->
                  {#if sheetState === 'edited'}
                    <button
                      type="button"
                      class={cn('btn h-7 bg-warning text-canvas hover:brightness-110', submitFlash && 'brightness-90')}
                      disabled={!mayAttempt || controlDisabled(session.connected) || awaitingMine !== null}
                      title={controlTitle(session.connected, mayAttempt ? tr('room.extra.135') : attemptWhy)}
                      onclick={resubmitAttempt}
                    >{awaitingMine === 'submit' ? tr('room.ui.66') : tr('room.ui.1229')}</button>
                  {:else if submittedAt === null}
                    <button
                      type="button"
                      class={cn('btn-primary h-7', submitFlash && 'brightness-90')}
                      disabled={!mayAttempt || controlDisabled(session.connected) || awaitingMine !== null}
                      title={controlTitle(session.connected, mayAttempt ? tr('room.extra.135') : attemptWhy)}
                      onclick={() => void submitAttempt()}
                    >
                      {awaitingMine === 'submit' ? tr('room.ui.66') : tr('room.ui.356')}
                    </button>
                  {:else}
                    <button
                      type="button"
                      class="btn-outline h-7"
                      disabled={!mayAttempt || controlDisabled(session.connected) || awaitingMine !== null}
                      title={controlTitle(
                        session.connected,
                        mayAttempt ? tr('room.extra.136') : attemptWhy,
                      )}
                      onclick={withdrawAttempt}
                    >
                      {awaitingMine === 'withdraw'
                        ? tr('room.ui.66')
                        : sheetState === 'wrong'
                          ? tr('room.ui.1248')
                          : tr('room.ui.358')}
                    </button>
                  {/if}
                  {/if}
                </span>
              </div>
              <!--
                The hint on ⇧↵ when the setting is off: two seconds and it
                fades.

                Not a toast: a toast drifts off into a corner of the screen,
                while the question was asked here, with fingers in this cell.
                And not a refusal: the run did not "fail", it simply does not
                exist here.
              -->
              {#if runHint}
                <p class="ml-5 mt-1.5 inline-flex items-center gap-2 bg-ink px-2.5 py-1 text-2xs text-canvas" role="status">
                  <span class="font-mono">⇧↵</span>
                  <span>{tr('room.ui.1231')}</span>
                </p>
              {/if}
              {#if mayAttempt && !councilClosed}
                <p class="pl-5 pt-1 text-2xs text-muted">{tr('room.ui.357')}</p>
              {/if}
            </div>
          {:else if showEditor}
            <!-- The focus ring lands at once: box-shadow cannot be animated
                 on the compositor, and a focus cue that arrives late is worse
                 than one that arrives hard. -->
            <div
              class={cn(
                // No transition, by the same rule as the ordinal above: both
                // the edge and the background hang on `tone`, which the
                // keyboard switches.
                'border-l-4 px-3 py-1',
                RULE[tone],
                /*
                 * One background of three, not three classes stacked: `cn` is
                 * clsx, it resolves nothing, and with two `bg-*` side by side
                 * the order in the built CSS decides, not the order here.
                 *
                 * A locked one is colder than an ordinary one (brand mixed in,
                 * not another surface level): it is not "deeper" or "higher"
                 * than its neighbours, it is simply not yours. And only colder:
                 * it must not be dimmed entirely, people come to a lecture for
                 * the outputs.
                 */
                selected && !shownRunning && !hasError
                  ? 'bg-raised'
                  : shut
                    ? isCode
                      ? 'bg-brand/[0.05]'
                      : 'bg-brand/[0.035]'
                    : isCode
                      ? 'bg-surface'
                      : 'bg-surface/70',
              )}
              onfocusout={(event) => {
                // Blurring a note puts it back to rendered form; code cells stay open.
                if (isCode) return
                const next = event.relatedTarget as Node | null
                if (!next || !event.currentTarget.contains(next)) commitMarkdown()
              }}
            >
              {@render openMark()}
              <!--
                Only this editor gets kernel completions: the one in which
                people write into the shared notebook. The council sheet and the
                draft further down the file ask nothing of the room's kernel:
                there people write THEIR OWN text, which the kernel does not
                have, and showing other people's variables from it would mean
                opening the kernel's state to those whom the `run` rule does not
                open it to. A markdown cell is filtered out in the editor
                itself: prose is written there.

                Jump to definition is wired the same way. The cell's name
                travels with the question, because by it the server computes
                both the search order (one's own notebook before others) and
                relative imports (lib/goto.svelte.ts). What comes back is not an
                event but the `landing` mark: while the answer was on its way,
                the cell may have been rebuilt.
              -->
              <CodeEditor
                text={ytext}
                awareness={session.awareness}
                cellId={id}
                undoManager={session.undoManager}
                language={isCode ? 'python' : 'markdown'}
                label={tr('room.cell.label', { type: isCode ? tr('room.extra.139') : tr('room.extra.140'), count: ordinal })}
                readOnly={!mayEdit}
                autoFocus={!isCode && focusOnEdit}
                placeholder={isCode ? '' : tr('room.extra.141')}
                complete={(code, cursor) => session.complete(code, cursor, id)}
                inspect={(code, cursor) => session.inspect(code, cursor, id)}
                brief={(code, cursor) => session.brief(code, cursor, id)}
                sources={codeSources}
                jump={(code, cursor) => void jumpToDefinition(session, code, cursor, { cellId: id })}
                mark={landing}
                onfocus={() => onselect()}
                onrun={run}
                onrunstep={runAndStep}
                onrunandadd={runAndAdd}
                onescape={() => {
                  if (isCode) root?.querySelector<HTMLElement>('.cm-content')?.blur()
                  else commitMarkdown()
                }}
                ondeleteempty={deleteIfEmpty}
                onarrowout={(direction) => step(direction)}
              />
              <!--
                One line under the code, instead of a dimmed cell.

                The editor silently refuses typing, and silence reads as a
                breakage: a person presses keys, nothing appears, and they go
                check the keyboard. The words stand where they are looking,
                right under the cell rather than in a toast at the edge of the
                screen, and speak about the class, not the rule: the teacher
                can open this cell, and the teacher is nearby.
              -->
              {#if shut}
                <!-- Here too the notebook speaks before the room: `editWhy`
                     has already combined this in one place (see its
                     explanation above). -->
                <p class="flex items-center gap-2 pb-1 pt-1.5 text-2xs text-muted">
                  <span aria-hidden="true" class="h-px w-3.5 shrink-0 bg-line"></span>
                  {editWhy}
                </p>
              {/if}
            </div>
          {:else}
            <!-- A note at rest carries no chrome at all: it is the seminar's
                 prose, and the editor is a thing you go and get. -->
            <!--
              Rendered text has a rail too. It used to have none at all: the
              rail was drawn only inside the editor, so on selection a text cell
              changed only its ordinal in the gutter on the left: from that it
              is impossible to tell which cell is selected when looking at the
              text rather than the margins. Now all cells have the same vertical
              bar, and a selected one differs from the rest the same way a
              running one does.
            -->
            <!-- svelte-ignore a11y_no_static_element_interactions -->
            <div
              class={cn(
                // See above: `tone` is switched by an arrow key, a transition
                // has no place here.
                'note border-l-4 px-3 py-1',
                RULE[tone],
                selected ? 'bg-surface/70' : 'bg-transparent',
              )}
              ondblclick={() => enter()}
            >
              {@render openMark()}
              {#if liveText.current.trim()}
                <Markdown source={liveText.current} class="text-prose text-muted" />
              {:else}
                <!-- The invitation is only for someone who will be let in: a
                     double click on a locked note answers with a refusal, and
                     inviting to it means promising an action this room does
                     not have. The same argument by which a locked cell's
                     first toolbar slot was removed. -->
                <p class="text-prose text-muted">
                  {mayEdit ? tr('room.ui.366') : tr('room.ui.367')}
                </p>
              {/if}
            </div>
          {/if}

          <!--
            The council for the teacher is ONE LINE AND A BUTTON. Always.

            The notebook is mirrored to the projector, while the council
            console is full of names, drafts, errors and marks: it has one
            place, the console window (components/council/pult). Under the
            cell stays exactly what the audience sees on the projector anyway
            (how many have submitted and how many are still writing) and the
            door to the console. There is NO private stack here IN ANY case,
            including when the window is closed: a fallback that draws names
            in the notebook is precisely the leak the window was introduced
            to prevent.

            The block stays after the council is closed too, while there are
            attempts: submitted work is looked at until the end of class, and
            looked at in the same place, in the console.
          -->
          {#if leads && (inCouncil || (board?.counts.attempts ?? 0) > 0)}
            <div
              class="flex flex-wrap items-center gap-x-2.5 gap-y-1.5 border-l-4 border-brand bg-surface px-3 py-2"
              data-council-host
            >
              <span class="shrink-0 text-ui font-bold text-ink">{tr('room.ui.34')}</span>
              <span class="min-w-0 flex-1 font-mono text-2xs tabular-nums text-muted">
                · {countLine(count ?? { submitted: 0, total: 0 })}
                {#if (board?.counts.writing ?? 0) > 0}
                  · {tr('room.ui.1056', { count: board?.counts.writing ?? 0 })}
                {/if}
              </span>
              <!--
                The cell's main button in a council, and it is filled:
                everything else here is only numbers. While the window is
                alive, it does not open a second one but raises that one
                (`pultReach`), and says so with a word.
              -->
              <button
                type="button"
                class={cn('h-8 shrink-0', pultOpen ? 'btn-outline' : 'btn-primary')}
                data-council-pult-button
                onclick={reachPult}
              >{pultOpen ? tr('room.ui.1401') : tr('room.ui.1400')} ↗</button>
              {#if pultBlocked}
                <!-- The browser did not let the window open: a silent button
                     reads as broken, so the reason stands as a line and fades
                     by itself. -->
                <p class="basis-full text-2xs text-warning" role="status">{tr('room.ui.1402')}</p>
              {/if}
              {#if pultFullscreen}
                <!-- The window opened but landed as a tab: nobody lets a
                     second window out of macOS full-screen mode. -->
                <p class="basis-full text-2xs text-muted" role="status" data-council-pult-fullscreen>
                  {tr('room.pult.v3.fullscreen')}
                </p>
              {/if}
            </div>
          {/if}

          <!--
            The same banner for the teacher, under the stack.

            They lead the discussion by it and must see exactly what the class
            sees: the same signature (a name, or "Variant N" with the names
            setting off), the same code, the same output of its own. The
            difference is one link on the right, "take off the screen", and it
            exists only here.
          -->
          {#if leads && showsOnScreen && onScreen}
            <div transition:slide={{ duration: prefersReducedMotion() ? 0 : 200, easing: quintOut }}>
              <CouncilOnScreen
                shown={onScreen}
                mayClear
                onclear={() => session.council.clearShown(id)}
              />
            </div>
          {/if}

          <!--
            The council was closed, but the sheet stayed.

            The lock moved to another position: the cell body is shared again,
            and what the person wrote has not gone anywhere: it is here, as a
            draft, collapsed. The line must say so, otherwise an editor that
            vanished from under one's hands reads as "your work was erased".

            There is nothing to ask from here and nowhere to ask: neither
            kernel completions nor jump to definition are passed to the draft.
            It is an archive: it is reread, not written, and the editor here
            only shows the text.
          -->
          {#if !inCouncil && !leads && sheet}
            <div class={cn('border-l-4 px-3 py-1.5', RULE[tone], 'bg-surface/70')}>
              <div class="flex flex-wrap items-center gap-x-3 gap-y-1">
                <span class={cn(CAPS, 'text-muted')}>{tr('room.ui.370')}</span>
                <span class="text-2xs text-muted">{tr(COUNCIL_CLOSED)}</span>
                <button
                  type="button"
                  class="ml-auto text-2xs text-accent-text hover:underline"
                  aria-expanded={showDraft}
                  onclick={() => (showDraft = !showDraft)}
                >
                  {showDraft ? tr('room.ui.371') : tr('room.ui.372')}
                </button>
              </div>
              {#if showDraft}
                <div class="pt-1 opacity-70">
                  <CodeEditor
                    text={sheet.text}
                    awareness={sheet.awareness}
                    undoManager={sheet.undo}
                    language={isCode ? 'python' : 'markdown'}
                    label={tr('room.extra.143', { p0: ordinal })}
                    readOnly={true}
                  />
                </div>
              {/if}
            </div>
          {/if}

          <!--
            Asking the oracle to change this cell, and what it answered.

            Both live under the cell rather than in the side panel, because both are about
            this cell: the sentence you type is about it, and the diff that comes back
            replaces it. The panel still receives every word — the question, the reasoning
            and the code — because the room is entitled to know why the notebook it is
            reading changed.
          -->
          {#if asking && mayRewrite}
            <div class={cn('flex flex-col gap-2 border-l-4 px-3 py-2.5', RULE[tone], 'bg-surface')}>
              <textarea
                bind:this={promptBox}
                bind:value={prompt}
                rows="2"
                class="w-full resize-none border border-line bg-canvas px-3 py-2 text-ui text-ink
                       placeholder:text-muted focus:border-accent focus:outline-none"
                placeholder={tr('room.ui.373')}
                onkeydown={(event) => {
                  // Enter sends: this is one sentence, not a document. Shift+Enter is
                  // there for the person who wants two.
                  if (event.key === 'Enter' && !event.shiftKey) {
                    event.preventDefault()
                    void sendEdit()
                  }
                  if (event.key === 'Escape') asking = false
                }}
              ></textarea>
              <div class="flex flex-wrap items-center gap-2.5">
                <button type="button" class="btn-primary h-8" disabled={sending || !prompt.trim()} onclick={sendEdit}>
                  {#if sending}
                    <Icon name="spinner" size={13} class="animate-spin" /> {tr('room.ui.374')} {:else} {tr('room.ui.375')} {/if}
                </button>
                <button type="button" class="btn-ghost h-8" onclick={() => (asking = false)}>{tr('room.ui.376')}</button>
                {#if askError}
                  <span class="text-2xs text-danger" role="alert">{askError}</span>
                {:else}
                  <span class="text-2xs text-muted">{tr('room.ui.377')}</span>
                {/if}
              </div>
            </div>
          {/if}

          {#if proposal}
            <!--
              The same pair as for the input form: a solid accent here covered
              both RULE.running on a running cell and RULE.error on a failed
              one, the very one whose fix the suggestion was asked for.
            -->
            <div class={cn('border-l-4 bg-accent/[0.04]', shownRunning ? 'border-accent/40' : 'border-accent')}>
              <div class="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 pt-2">
                <span class={cn(CAPS, 'text-accent-text')}>{tr('room.ui.378')}</span>
                <span class="font-mono text-2xs">
                  {#if proposedCounts.added > 0}<span class="text-positive">+{proposedCounts.added}</span>{/if}
                  {#if proposedCounts.removed > 0}<span class="ml-1.5 text-danger">−{proposedCounts.removed}</span>{/if}
                </span>
                {#if proposalStale}
                  <!-- Not a refusal: the room may want the rewrite anyway. But accepting
                       deletes whatever arrived in the meantime, and that has to be said
                       before the press rather than after. -->
                  <span class="text-2xs text-warning"> {tr('room.ui.379')} </span>
                {/if}
              </div>
              <div class="overflow-x-auto whitespace-pre px-3 py-2 font-mono text-code-lg leading-[21px]"><div class="w-max min-w-full">{#each proposedLines as line, index (index)}<span class={cn('block min-h-[21px]', line.kind === 'added' && 'bg-positive/10', line.kind === 'removed' && 'bg-danger/10', line.kind === 'same' && 'opacity-55')}><span class="inline-block w-5 select-none text-center text-faint">{line.kind === 'added' ? '+' : line.kind === 'removed' ? '\u2212' : ' '}</span><CodeLine tokens={proposedTokens[index] ?? []} /></span>{/each}</div></div>
              <div class="flex flex-wrap items-center gap-2.5 border-t border-line-soft px-3 py-2">
                <!-- When the ground has shifted, the filled button changes
                     owner: the reflex after five accepts is to press the
                     filled one, and it must land on the safe outcome. The same
                     in the oracle panel. -->
                <!-- "Accept" is an edit of the shared notebook, and it asks the
                     CELL: in a lecture and in the shared council cell the
                     teacher edits. The button dims and names the reason;
                     "Decline" stays for everyone: a removed banner breaks
                     nothing while class is on. -->
                {#if proposalStale}
                  <button type="button" class="btn-primary h-8" onclick={decline}>{tr('room.ui.380')}</button>
                  <button
                    type="button"
                    class="btn-outline h-8"
                    disabled={!mayPatchHere}
                    title={mayPatchHere ? '' : patchWhy}
                    onclick={accept}
                  >{tr('room.ui.381')}</button>
                {:else}
                  <button
                    type="button"
                    class="btn-primary h-8"
                    disabled={!mayPatchHere}
                    title={mayPatchHere ? '' : patchWhy}
                    onclick={accept}
                  >{tr('room.ui.382')}</button>
                  <button type="button" class="btn-outline h-8" onclick={decline}>{tr('room.ui.380')}</button>
                  <span class="text-2xs text-muted">{mayPatchHere ? tr('room.ui.383') : patchWhy}</span>
                {/if}
              </div>
            </div>
          {/if}

          <!--
            The output area does not shrink while there is nothing to put in
            it.

            Output is wiped at the moment of start (an old number that looks
            fresh is worse on a projector than any jerk), but the height
            stays. Rerunning a cell that prints the same thing does not move
            the page at all; a cell whose output really changed in size moves
            once and by the real difference. Right now every one moves twice.

            It is a floor, not a promise: the block has no top, bottom or right
            border and no rounding, so empty it cannot be told from padding.
            Not an object standing empty, but a cell that has not shrunk yet.
            What is happening is explained by the breathing bar on the left and
            the Running line under it: adding a third label here would say the
            same thing three times.

            The real `running` is read, not `shownRunning`: this is layout, not
            a busy signal. The two-hundred-millisecond threshold does not apply
            to it: tying the space to it would mean collapsing fast cells and
            holding slow ones, that is, turning both mechanisms inside out.
          -->
          <!--
            `!ownSheet`: a student in an open council has no shared cell on
            screen, neither code nor output. The output would remain its last
            trace: someone else's run (or "Show to class") would print numbers
            right under the person's OWN sheet, and there would be no way to
            read them as not their own. The attempt has its own output, and it
            lies in the same place, right under the sheet.
          -->
          {#if isCode && !ownSheet && (outputs.current.length > 0 || outputFloor > 0)}
            <!--
              An empty space draws nothing: no background, no edge.

              The first version left the block both `bg-surface/50` and a
              coloured edge, and claimed in a comment that empty it was
              "indistinguishable from padding". That was untrue: the result
              was a grey rectangle with a bar, as tall as the previous output.
              On a traceback, half a screen. Not stillness but a hole, and that
              is exactly how it was reported.

              The point of the reserve is that the page does not move, not that
              something stands on it. So while there is nothing to put in, the
              block is pure height.
            -->
            {@const seatOnly = outputs.current.length === 0}
            <!--
              Output lies on the SHEET, code on the slab: different backgrounds
              plus a hairline along the border.

              Both halves of the cell used to stand on surface (code solid,
              output the same colour at half strength), and in the light theme
              there was nothing to tell them apart with: 243→249 against a page
              background of 255. At night the pair read, and that is exactly why
              the trouble lived so long: people looked in the dark theme.

              The direction was chosen not by taste but by what is already
              printed: the published page (server/src/publish/render.ts) and the
              reader draw exactly this: code on a backing, output on the card
              background, a `line` rule between them. The room was the only
              place where the notebook looked different. Besides, the account
              balances both ways: in the light the sheet is lighter than the
              slab, at night darker, and "the computer printed this" reads the
              same.

              The state bar runs through both halves and does not change colour:
              it is about the CELL (running, failed, open, selected), not about
              where the code ends. Breaking it would mean starting a second
              language where there is already a first.

              The colour of the rule itself is a style, not a class:
              `RULE[tone]` paints the whole border-color, and a `border-t-line`
              next to it would be decided by the order of utilities in the built
              CSS, not by what is written here. And the line must stay grey for
              both a running and a failed cell: it is not a signal, it is a
              border.
            -->
            <div
              class={cn(
                'transition-[background-color] duration-[var(--speed-quick)]',
                !seatOnly && 'border-l-4 border-t',
                !seatOnly && RULE[tone],
                !seatOnly && (hasError ? 'bg-danger/5' : 'bg-canvas'),
              )}
              style:border-top-color={seatOnly ? undefined : 'rgb(var(--line))'}
              style:min-height={outputFloor > 0 ? `${outputFloor}px` : undefined}
            >
              <!--
                One node measures, another holds, and that is mandatory.

                Put `min-height` and `bind:clientHeight` on one element, and the
                reserve starts reading itself: the remembered height grows to
                the largest there has ever been and never comes back down. In a
                quick test this looks perfectly right.
              -->
              <div bind:clientHeight={outputsMeasured}>
                {#if outputs.current.length > 0}
                  <div class="px-2 py-1.5">
                    <CellOutputs outputs={outputs.current} bind:pending={outputsPending} />
                  </div>
                  <!--
                    The line under the output, only where it has something to SAY.
                    
                    There used to be a full-width rule here and "Out [2] · 1.4 s"
                    in the far corner: the line split the screen in half for the
                    sake of one number, and the number itself was read once an
                    hour and was not drawn at all for cells without output. The
                    number moved into the gutter, next to the cell's ordinal (see
                    `mark`), the rule went away entirely: the output ends where
                    the output ends. What remained are the words: who ran it and
                    that the number was lost; they do not fit into the gutter,
                    and they must be said.
                  -->
                  {#if ranByOther || unnumbered}
                    <div class="flex items-center gap-3 px-4 pb-1.5 pt-0.5">
                      {#if unnumbered}
                        <!--
                          In words, not by shade: language survives a projector,
                          a screenshot in a chat and colour blindness. This is a
                          state, not a passing transition: it hangs exactly as
                          long as it stays true.
                        -->
                        <span class="text-2xs text-warning"> {tr('room.ui.384')} </span>
                      {/if}
                      {#if ranByOther}
                        <span class="font-mono text-2xs text-muted">{ranByOther}</span>
                      {/if}
                    </div>
                  {/if}
                {/if}
              </div>
            </div>
          {/if}
        </div>
      {:else}
        <div class={cn('border-l-4 bg-surface/50', RULE[tone])} style="height: {parkHeight}px"></div>
      {/if}

      {#if stdin}
        <!--
          The form stands under the cell, not in a toast: it is exactly this
          cell that is waiting, and it is this cell one must look at. The edge
          is in the running colour, because the cell really is running, it has
          just stopped against a person.
        -->
        <form
          class={cn(
            'mt-1.5 flex items-center gap-2 border-l-4 bg-accent/[0.07] px-3 py-2',
            // Paired with RULE.running: on a running cell the edge is muted,
            // and a solid accent here would read as a third shade in the
            // column.
            shownRunning ? 'border-accent/40' : 'border-accent',
          )}
          onsubmit={sendAnswer}
        >
          <span class={cn(CAPS, 'shrink-0 text-accent-text')}>{tr('room.ui.385')}</span>
          {#if stdin.prompt}
            <span class="shrink-0 font-mono text-code text-ink">{stdin.prompt}</span>
          {/if}
          <!--
            The field is only for someone whose answer will be accepted.
            Everyone else gets the banner itself: the room must see that the
            cell has stopped and what it is waiting for.
          -->
          {#if canAnswer}
            <input
              bind:this={answerField}
              bind:value={answer}
              type={stdin.password ? 'password' : 'text'}
              class="field h-8 min-w-0 flex-1 font-mono text-code-lg"
              autocomplete="off"
              spellcheck="false"
              aria-label={stdin.prompt || tr('room.cell.waitingInput')}
            />
            <!-- The press is right here too: the answer goes into the kernel,
                 and nothing changes on screen until it gets there. The
                 properties are listed, not `.press`: a `transition-*` utility
                 would rewrite transition-property and leave transform out of
                 the list (see CAP in Notebook.svelte). -->
            <button
              type="submit"
              class={cn(
                'inline-flex h-8 shrink-0 items-center bg-primary px-3 text-primary-ink',
                CAPS,
                'transition-[opacity,transform] duration-press ease-out',
                'enabled:active:scale-[0.97] hover:opacity-90',
              )}
            > {tr('room.ui.386')} </button>
          {/if}
        </form>
      {/if}

      <!--
        The only thing that moves in the notebook.
        
        A width of 4px is exactly `border-l-4`, and it stands in the same place:
        not a second line next to it, but the same one, lit. Under it the muted
        `RULE.running`, on top the accent breathing from 1 to 0.25; together
        they give an edge that moves between the full accent and 55 %.
        
        The breathing stays even under prefers-reduced-motion, and that is
        written into the policy in index.css: continuous indicators are not
        switched off, because a stopped indicator is a lie about the system.
        The bar goes nowhere, changes one compositor property, never reaches
        zero and does less than one beat per second, that is, none of the
        things motion is removed for.
      -->
      {#if shownRunning}
        <span
          aria-hidden="true"
          class="pointer-events-none absolute inset-y-0 left-0 w-1 animate-blink bg-accent"
        ></span>
      {/if}
      </div>

      <!--
        The label under the input form stands OUTSIDE the wrapper with the bar.

        The bar is stretched over the whole wrapper (`inset-y-0`), while this
        label has no `border-l-4` edge, just as the `mt-1.5` gap above the form
        itself has none. While the label lay inside, the glowing line went a
        couple of dozen pixels below the edge it lights up and hung in the air.
      -->
      {#if stdin}
        <p class="px-3 pt-1 text-2xs text-muted">
          {#if canAnswer} {tr('room.ui.387')} {:else if !acts}
            <!-- Two different reasons, and the bell outranks the other:
                 inviting to the field the person who ran this cell, after the
                 end of class, means inviting them to a refusal. Hence no name
                 here. --> {tr('room.ui.388')} {:else} {tr('room.ui.389')} {runBy ?? tr('room.ui.390')} {tr('room.ui.391')} {/if}
        </p>
      {/if}

      <!--
        The oracle is busy with this cell, and that is said in words, not only
        by the edge.

        The edge tells the whole room WHAT is busy here and reads across the
        hall; the line tells one person WHO is busy and reads at arm's length.
        The same pair, for the same reason, as for the running cell below, and
        here it is needed more: the gesture is made with a button above the
        cell, and the answer comes into a panel that may be collapsed. Without
        a word, movement at the edge means "something is happening", not "the
        oracle took it".

        It stands ABOVE the execution line and not instead of it: the kernel
        and the oracle are two different workers, and having taken one cell,
        each speaks for itself.
      -->
      {#if oracleBusy}
        <div class={FOOTER}>
          <!-- The same muted icon as for execution: it is about the system
               being alive, and must not argue with the accent word next to
               it. -->
          <Icon name="spinner" size={12} class="shrink-0 animate-spin text-accent-text/70" />
          <span class={cn(CAPS, 'text-accent-text')}>{tr('room.oracle.working')}</span>
        </div>
      {/if}

      {#if shownRunning}
        <!--
          This cell's status line, for the whole room.

          It stays, although "stop" is now in the toolbar too, and here is why.
          The toolbar opens on hover, and the running cell is very often not
          the one under the cursor: Run All computes the seventh while the
          twelfth is being edited. Making the only stop button one that has to
          be reached with the mouse first is the worst possible trade exactly
          when someone wants to kill an infinite loop; on a tablet there is no
          hover at all. Besides, the line is drawn outside `{#if mounted}` and
          speaks for a cell whose editor is parked, and carries what cannot be
          put into a 24×24 icon: who ran it, their face and how long it has
          been going.

          The stopwatch is here. This place used to say "execution time is not
          in the document, so we do not claim it"; now it is: one timestamp,
          written by the kernel in the same transaction that starts execution.
          This component counts it, because what is still going on is counted
          where people look.
        -->
        <div class={FOOTER}>
          {#if runner}
            <Avatar
              name={runner.name}
              color={runner.color}
              avatar={runner.avatar}
              size="xs"
              title={tr('room.extra.150', { p0: runner.name })}
            />
          {/if}
          <!--
            "Waiting" when the cell has stopped against a person: it really is
            executing, but saying "Running" right above a form that says "the
            kernel is waiting for an answer" means letting the sheet argue with
            itself. The bar meanwhile breathes and the stopwatch counts: elapsed
            execution time is still elapsed execution time.
          -->
          <!--
            A spinning icon right by the word.

            The bar on the left tells the room WHICH cell is busy and reads
            across the whole hall; this icon tells one person that the system
            is alive and reads at arm's length. Different questions and
            different distances, hence two of them. The icon is muted: it must
            not argue with the accent word next to it.

            It does not spin while waiting for input: nothing happens there
            until somebody answers, and a spinning icon would promise work.
          -->
          {#if !stdin}
            <Icon name="spinner" size={12} class="shrink-0 animate-spin text-accent-text/70" />
          {/if}
          <span class={cn(CAPS, 'text-accent-text')}>{stdin ? tr('room.ui.392') : tr('room.ui.393')}</span>
          {#if runBy}
            <span class="text-2xs text-muted">{tr('room.ui.394')} {runBy}</span>
          {/if}
          <!--
            The stopwatch and "stop" are one group pressed to the right: the
            group grows to the left, so the button's right edge does not move
            when the digits appear. `tabular-nums` and `shrink-0`, otherwise
            the row twitches five times a second.
          -->
          <div class="ml-auto flex items-center gap-2">
          {#if meta.current.startedAt !== null}
            <span class="shrink-0 font-mono text-2xs tabular-nums text-muted">
              {elapsed(meta.current.startedAt, now - session.clockSkewMs)}
            </span>
          {/if}
          <button
            type="button"
            disabled={controlDisabled(session.connected, canInterrupt)}
            title={controlTitle(
              session.connected,
              canInterrupt ? tr('room.extra.151') : tr('room.extra.152'),
            )}
            onclick={() => session.send({ t: 'interrupt', cellId: id })}
            class={cn(
              'inline-flex h-6 items-center border border-line px-2 text-ink',
              CAPS,
              // A panic button: the server does not answer instantly, and the
              // press is the only thing that confirms it was heard. The same
              // recipe as "Cancel" below and the whole Run bar.
              'transition-[color,background-color,border-color,transform] duration-press ease-out',
              'enabled:active:scale-[0.97] hover:bg-raised',
              'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50',
              'disabled:pointer-events-none disabled:opacity-40',
            )}
          > {tr('room.ui.395')} </button>
          </div>
        </div>
      <!--
        A queued cell said nothing at all whenever the document's queue had not
        caught up with the cell's own state — which is exactly the moment after
        somebody presses Run All, and exactly when the room wants to know that
        their cell is waiting rather than ignored. The position is extra when we
        have it; that it is queued, and whose it is, we always have.
      -->
      {:else if shownState === 'queued'}
        <div class={FOOTER}>
          <!-- The chip is the POSITION. Without one it would only say "queued"
               beside "queued by John", which is the same word twice. -->
          {#if queuePosition >= 0}
            <span
              title={tr('room.ui.396')}
              class="inline-flex h-5 items-center bg-raised px-2 font-mono text-2xs text-muted"
            >
              {place(queuePosition + 1)} {tr('room.ui.397')} </span>
          {/if}
          <span class={cn(CAPS, 'text-accent-text')}>{tr('room.ui.398')}</span>
          {#if runBy}
            <span class="text-2xs text-muted">{tr('room.ui.399')} {runBy}</span>
          {/if}
          {#if canCancel}
            <button
              type="button"
              disabled={controlDisabled(session.connected)}
              title={controlTitle(session.connected, tr('room.extra.154'))}
              onclick={() => session.send({ t: 'cancel', cellId: id })}
              class={cn(
                'ml-auto inline-flex h-6 items-center border border-line px-2 text-ink',
                CAPS,
                // Spelled out, not `.press`: a Tailwind transition-* utility rewrites
                // transition-property, so the helper's transform would be left out of
                // the list and the scale would snap. Same shape the run bar's CAP uses.
                'transition-[color,background-color,border-color,transform] duration-press ease-out',
                'enabled:active:scale-[0.97] hover:bg-raised',
                'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50',
                'disabled:pointer-events-none disabled:opacity-40',
              )}
            > {tr('room.ui.376')} </button>
          {/if}
        </div>
      {:else if hasError && aiReady && may.ask}
        <div class="{FOOTER} flex-wrap">
          <button
            type="button"
            onclick={() => askAi('fix')}
            class={cn(
              // The filled pair, like Run all: cyan cannot carry a fill in light.
              'inline-flex h-7 shrink-0 items-center gap-2 whitespace-nowrap bg-primary px-3 text-primary-ink',
              CAPS,
              'transition-[opacity,transform] duration-press ease-out',
              'enabled:active:scale-[0.97] hover:opacity-90',
              'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset',
              'focus-visible:ring-primary-ink/60',
            )}
          >
            <Icon name="sparkles" size={12} /> {tr('room.ui.400')} </button>
          <span class="text-2xs text-muted">{tr('room.ui.401')}</span>
        </div>
      {/if}

      {#if editingHere}
        <div class="{FOOTER} enter">
          {#each peersHere.current.slice(0, 4) as peer (peer.clientId)}
            <Avatar
              name={peer.user.name}
              color={peer.user.color}
              avatar={peer.user.avatar}
              size="xs"
              title={tr('room.extra.158', { p0: peer.user.name })}
            />
          {/each}
          <span class="text-2xs text-muted">{editingHere}</span>
        </div>
      {/if}
    </div>
  </div>
{/if}

<style>
  /*
   * A note in the notebook is the seminar's prose: the artboard leads it with a
   * display heading in the black weight and drops the body to muted, so the
   * code below it stays the loudest thing on the sheet. .prose-note in
   * index.css is shared with the oracle panel, which wants neither, so the
   * notebook's own voice is set here rather than by retuning every reader.
   */
  .note :global(.prose-note h1) {
    @apply text-display font-black text-ink;
  }
  .note :global(.prose-note h2) {
    @apply text-head font-black text-ink;
  }
</style>
