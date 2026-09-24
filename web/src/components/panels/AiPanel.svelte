<script lang="ts">
  import { tr } from '@shared/i18n'
  /**
   * The room's oracle thread.
   *
   * Nothing here holds an answer: the server publishes both the question and
   * the streaming reply into the session document, and this panel is a reader
   * of that array like every other browser in the seminar. Which is the point —
   * a question asked in a private tab helps one student and teaches the teacher
   * nothing, so every question is attributed and lands on all screens at once.
   */
  import type * as Y from 'yjs'
  import { untrack } from 'svelte'
  import { getChat, readChatEntry, rereadRows, type ChatSnapshot } from '@shared/notebook'
  import { outgoingRow, settleOutbox, type Outgoing } from '@/lib/ask-outbox'
  import type {
    AiAction,
    AiAskRequest,
    AwarenessUser,
    ParticipantRole,
  } from '@shared/protocol'
  import { oracleModeIn, readRules } from '@shared/rules'
  import { kindOf } from '@shared/paths'
  import {
    effortRank,
    REASONING_EFFORTS,
    type OracleMode,
    type ReasoningEffort,
  } from '@shared/admin'
  import { rememberEffort, rememberedEffort } from '@/lib/oracle-effort'
  import { api, ApiError } from '@/lib/api'
  import { oracleDraft } from '@/lib/drafts.svelte'
  import { getSessionState } from '@/lib/session.svelte'
  import { permitsIn } from '@/lib/may'
  import { plural } from '@/lib/plural'
  import { watchBooks, watchCellNumbers } from '@/lib/yreactive.svelte'
  import Avatar from '@/components/ui/Avatar.svelte'
  import Icon from '@/components/ui/Icon.svelte'
  import ChatTurn from './ChatTurn.svelte'

  const session = getSessionState()
  const cellNumbers = watchCellNumbers(session.doc)
  const chat = getChat(session.doc)
  const isHost = $derived(session.me.role === 'host')

  // Raw: the whole array is rebuilt on every observer fire, so deep-proxying
  // each snapshot would be work spent on objects that are replaced next frame.
  let entries = $state.raw<ChatSnapshot[]>(chat.map(readChatEntry))
  let status = $state<{
    enabled: boolean
    model: string
    mode: OracleMode
    reasoningEffort?: ReasoningEffort
  } | null>(null)
  /*
   * The question survives closing the panel.
   *
   * The panel unmounts together with its button, and people usually ask about
   * the very cell they want to look at at that moment: collapsed it, glanced,
   * expanded it — the question is gone. The draft lives in the tab, not in the
   * component.
   */
  const composing = oracleDraft
  let sendErrorRender = $state<() => string | null>(() => null)
  const sendError = $derived(sendErrorRender())
  /*
   * Slow mode is not a failure, and a red banner does not suit it.
   *
   * "Not so often" stands next to "the oracle is switched off for this
   * seminar": it is an instance rule, not a breakage, and the person does
   * nothing about it — they wait. So it gets a calm line of the same kind as
   * the other rules below.
   */
  let slowNoticeRender = $state<() => string | null>(() => null)
  const slowNotice = $derived(slowNoticeRender())
  /** The moment the server asked to wait until, or 0. Ms, like Date.now. */
  let waitUntil = $state(0)
  /** Seconds on the button. Display only: the server judges, see `ask`. */
  let waitLeft = $state(0)
  let armed = $state(false)
  let pinned = $state(true)

  let scroller = $state<HTMLDivElement | null>(null)
  /** The thread's content: a resize observer watches it grow, see below. */
  let thread = $state<HTMLDivElement | null>(null)
  let composer = $state<HTMLTextAreaElement | null>(null)
  /**
   * Where the thread was when the reader stopped following it.
   *
   * Needed to tell "you scrolled up" from "you scrolled up and then something
   * arrived": a button that says there is a new answer when there is not is a
   * button people stop believing, and one that stays silent when there is loses
   * the answer entirely. Null while the thread is being followed.
   */
  let mark = $state<{ id: string; length: number } | null>(null)

  let composeTimer: number | undefined
  let armTimer: number | undefined
  /** What the room currently believes about us, so we only announce changes. */
  let composingSent = false

  /*
   * Hints mode is a real state of the room, not an error to discover by
   * pressing a button. The chips it refuses are not drawn at all — the rule
   * comes from actionAllowedIn, the same function the route refuses with, so
   * the two cannot drift.
   */
  /*
   * The instance's answer, narrowed by this room's own rule.
   *
   * /api/ai/status knows nothing about a seminar, so on its own it said "full"
   * for a room the server runs in hints — and the panel drew Explain, Fix and
   * Debug, each of which came back 403 when pressed. oracleModeIn is the same
   * function the route enforces with, so the two cannot drift.
   */
  const mode = $derived<OracleMode>(
    oracleModeIn(readRules(session.session.rules), status?.mode ?? 'full'),
  )
  const hintsOnly = $derived(mode === 'hints')
  /*
   * There is nowhere to ask — for either of two reasons.
   *
   * Optimistic until proven otherwise: a null status means "still checking",
   * and a dead input while a fetch is in flight reads as a broken oracle.
   *
   * The room's mode counts here on a par with the instance. The "oracle off"
   * rule is set for a test, and a live field that answers every question with a
   * red 403 line reads to the class as a breakage, not as the teacher's
   * decision. This tab knows the room rule right away; it has no reason to wait
   * for the status.
   */
  const offline = $derived(mode === 'off' || (status !== null && !status.enabled))

  /**
   * Questions that have been sent and have not yet come back through the
   * document — see lib/ask-outbox.
   *
   * Not "show and forget": if the server refuses — slow mode, the ceiling, a
   * dropped connection — the row is removed together with the promise, and the
   * text goes back into the field.
   */
  let outbox = $state.raw<Outgoing[]>([])
  let outgoing = 0

  /** Put the question in the feed ahead of the reply; returns the row name. */
  function openOutbox(body: AiAskRequest): string {
    const id = `outgoing:${++outgoing}`
    outbox = [
      ...outbox,
      {
        row: outgoingRow({
          id,
          me: session.me,
          question: body.message,
          action: body.action ?? null,
          cellId: body.cellId ?? null,
          cellIds: body.cellIds ?? [],
          mode: body.mode,
          at: Date.now(),
        }),
        before: new Set(entries.map((entry) => entry.id)),
      },
    ]
    return id
  }

  /** Remove the row: it was replaced by the real entry — or by a refusal. */
  function closeOutbox(id: string): void {
    outbox = outbox.filter((row) => row.row.id !== id)
  }

  function settlePending(fresh: readonly ChatSnapshot[]): void {
    const pending = untrack(() => outbox)
    const left = settleOutbox(pending, fresh)
    if (left === pending) return
    const landed = landedIds(pending, left, fresh)
    if (landed.length > 0) {
      const alive = new Set(fresh.map((entry) => entry.id))
      const kept = [...untrack(() => inherited)].filter((id) => alive.has(id))
      inherited = new Set([...kept, ...landed])
    }
    outbox = left
  }

  $effect(() => {
    /*
     * Reads the document and writes `entries` — and reads NOTHING from state.
     *
     * As soon as `entries` or `outbox` was read here (and substituting the
     * outgoing rows read both), the effect came to depend on what it rewrites
     * itself: `chat.map` returns a new array on every pass, Svelte sees a new
     * value, runs the effect again — and the room greeted people not with a
     * notebook but with `effect_update_depth_exceeded`. The fresh list goes on
     * through a variable, and the previous snapshot and the outgoing queue are
     * taken with `untrack`.
     *
     * ONLY what the frame touched is re-read (`rereadRows`): an answer is
     * appended to a Y.Text inside one entry, and the old code rebuilt the whole
     * thread for every chunk — `toString()` of every answer and every
     * reasoning, that is, work proportional to the length of the whole thread
     * on every token. Unchanged snapshots stay THE SAME objects, so each turn's
     * derived values (the patch diff, the markdown parse, the author's role)
     * are not recomputed.
     */
    const read = (events: Y.YEvent<any>[] | null) => {
      const previous = untrack(() => entries)
      const fresh = rereadRows(previous, chat, readChatEntry, events)
      if (fresh !== previous) entries = fresh
      settlePending(fresh)
    }
    read(null)
    // Deep: an answer streams into a Y.Text *inside* an entry. The array itself
    // only changes when somebody asks something new.
    const onFrame = (events: Y.YEvent<any>[]) => read(events)
    chat.observeDeep(onFrame)
    return () => chat.unobserveDeep(onFrame)
  })

  /*
   * Entries that took the place of a promise row: they do NOT get the entrance
   * animation.
   *
   * The promise row and the real entry are one and the same question, but their
   * keys differ (`outgoing:N` versus the server id), so Svelte honestly removes
   * one <article> and mounts another. With `animate-fade-up` on it, the same
   * question in the same place faded in from transparency a second time — a
   * jerk exactly where ask-outbox promised an unnoticeable swap.
   *
   * Who replaced whom is asked of `settleOutbox` itself, not computed here
   * again: the matching rule lives in one place, and a second copy of it would
   * drift from the first at the very first edit.
   */
  let inherited = $state.raw<ReadonlySet<string>>(new Set())

  function landedIds(
    before: readonly Outgoing[],
    after: readonly Outgoing[],
    fresh: readonly ChatSnapshot[],
  ): string[] {
    const gone = before.filter((row) => !after.includes(row))
    const out: string[] = []
    for (const row of gone) {
      for (const entry of fresh) {
        if (out.includes(entry.id)) continue
        if (settleOutbox([row], [entry]).length > 0) continue
        out.push(entry.id)
        break
      }
    }
    return out
  }

  /**
   * The oracle's state on the instance — and "don't know" separately from
   * "off".
   *
   * A rejected fetch (a network blip, a 5xx, the relay) used to land as
   * `{enabled:false, mode:'off'}`, and the class read an admin's decision where
   * there had been one failed attempt: "the oracle is switched off for this
   * instance", no input field, no retry — only remounting the panel could fix
   * it. Now `status` stays `null` (that is, "still checking", as intended
   * above), and at the bottom there is a line with a retry button.
   */
  let statusFailed = $state(false)
  let statusTry = $state(0)

  $effect(() => {
    void statusTry
    let alive = true
    api
      .aiStatus()
      .then((res) => {
        if (!alive) return
        status = res
        statusFailed = false
      })
      .catch(() => {
        if (!alive) return
        // null exactly: only the server says 'off'.
        status = null
        statusFailed = true
      })
    return () => {
      alive = false
    }
  })

  /*
   * An `errored` watcher used to stand here — "a cell failed somewhere in the
   * room".
   *
   * Nobody drew it: the value was written and never read, neither in the script
   * nor in the markup. And it was expensive — on every insertion and deletion
   * of a cell in ANY notebook of the room it detached and re-attached observers
   * on all Y.Maps of all notebooks, in each of five hundred tabs with the panel
   * open. Work with no result on screen is not an optimization but garbage, and
   * it was removed entirely: if a red "something failed" dot is ever needed, it
   * should be computed from the cell registry (`yreactive`), not by subscribing
   * to every cell.
   */

  // The notebook asks on the student's behalf from "Ask AI" and "Fix with AI".
  $effect(() => {
    const onAsk = (event: Event) => {
      const detail = (event as CustomEvent<{ cellId?: string; action?: AiAction }>).detail
      if (!detail) return
      void ask({
        message: '',
        action: detail.action ?? 'explain',
        cellId: detail.cellId ?? session.selectedCellId,
      })
    }
    window.addEventListener('colloq:ask-ai', onAsk)
    return () => window.removeEventListener('colloq:ask-ai', onAsk)
  })

  $effect(() => () => {
    window.clearTimeout(armTimer)
    // Leaving with text in the box must not leave a ghost typing line behind.
    stopComposing()
  })

  /* -------------------------------------------------------------- reading */

  const avatars = $derived.by(() => {
    const map = new Map<string, string | null>()
    for (const peer of session.peers) {
      if (peer.user.avatar) map.set(peer.user.id, peer.user.avatar)
    }
    return map
  })

  /**
   * The author's role by id — one pass over presence for the whole feed.
   *
   * Every turn asked `session.peers` for it by searching, and `#readPeers`
   * returns a new array on EVERY remote cursor: two hundred turns with five
   * hundred people are a hundred thousand comparisons on every move of a
   * student between cells, and so in every tab with the panel open. Here it is
   * one pass, and it wakes up whenever presence changes.
   */
  const roles = $derived.by(() => {
    const map = new Map<string, ParticipantRole>()
    for (const peer of session.peers) map.set(peer.user.id, peer.user.role)
    return map
  })

  /** One line per person, not per tab — two tabs are still one student. */
  const typing = $derived.by(() => {
    const seen = new Map<string, AwarenessUser>()
    for (const peer of session.peers) {
      if (peer.user.id === session.me.id || !peer.user.composing) continue
      if (!seen.has(peer.user.id)) seen.set(peer.user.id, peer.user)
    }
    return [...seen.values()]
  })

  const typingLine = $derived.by(() => {
    const names = typing.map((user) => user.name)
    if (names.length === 0) return null
    if (names.length === 1) return tr('room.ui.519', { p0: names[0] })
    if (names.length === 2) return tr('room.ui.520', { p0: names[0], p1: names[1] })
    return tr('room.ui.521', { count: names.length })
  })

  /**
   * What the oracle sees — and what it looks at especially.
   *
   * Two lines instead of a row of chips, and that is not cosmetics. The chips
   * listed the selected cell, the traceback and a few file names — that is,
   * PIECES of what is sent in full anyway — and kept silent about the notebook
   * and the other files, because "a chip that is always lit says nothing". It
   * came out exactly the other way round: a list of three names read as "this
   * is what it sees", and people did not understand why the answer knew about
   * the neighbouring cell.
   *
   * Now it is said plainly: by default everything in the room is visible. And
   * the selection and the open file are ADDED to that — as what it is asked to
   * focus on.
   */
  const books = watchBooks(session.doc)

  /*
   * Files OTHER THAN notebooks: notebooks are named separately, and counting
   * them twice would promise more than the room has.
   */
  const fileCount = $derived(
    session.files.filter((file) => !file.dir && kindOf(file.path) !== 'notebook').length,
  )

  const seesAll = $derived.by(() => {
    const nb = books.current.length
    return (
      `${nb} ${plural(nb, tr('room.ui.522'), tr('room.ui.523'), tr('room.ui.524'))}` +
      tr('room.ui.525', { p0: fileCount })
    )
  })

  /** An open text file goes whole; a notebook does not — it is in the cells. */
  const openFile = $derived(
    session.editingPath && kindOf(session.editingPath) === 'text' ? session.editingPath : null,
  )

  const focusNumbers = $derived(
    session.selection
      .map((id) => cellNumbers.current.get(id))
      .filter((n): n is number => n !== undefined)
      .sort((a, b) => a - b)
      .map(pad),
  )

  /**
   * The same thing in two grammatical cases.
   *
   * The "Especially" line lists things — that calls for the nominative; the
   * hint in the field comes after a preposition — that calls for the
   * accusative. In Russian, "Спросить про ячейка 02" (the nominative after the
   * preposition) jars more than this pair of lines costs.
   */
  const focus = $derived.by(() => {
    const parts: string[] = []
    if (focusNumbers.length === 1) parts.push(tr('room.ui.526', { p0: focusNumbers[0] }))
    else if (focusNumbers.length > 1) parts.push(tr('room.ui.527', { p0: focusNumbers.join(', ') }))
    if (openFile) parts.push(openFile)
    return parts
  })

  const focusAsked = $derived.by(() => {
    if (focusNumbers.length === 1) return tr('room.ui.528', { p0: focusNumbers[0] })
    if (focusNumbers.length > 1) return tr('room.ui.527', { p0: focusNumbers.join(', ') })
    return openFile
  })

  function cellNumber(id: string | null | undefined): number | null {
    if (!id) return null
    return cellNumbers.current.get(id) ?? null
  }

  /** Cells are named 01…04 in the gutter; the thread has to agree with it. */
  function pad(n: number): string {
    return String(n).padStart(2, '0')
  }

  /* ------------------------------------------------------------- scrolling */

  function toBottom(): void {
    if (scroller) scroller.scrollTop = scroller.scrollHeight
  }

  $effect(() => {
    const tail = entries[entries.length - 1]
    // Depend on the tail's length too, or a streaming answer scrolls out of view.
    void entries.length
    void tail?.answer.length
    if (!pinned || !scroller) return
    // After the DOM has the new text, not before.
    requestAnimationFrame(() => {
      if (pinned) toBottom()
    })
  })

  /*
   * FOLLOW WHAT GROWS, NOT ONLY WHAT IS NEW.
   *
   * The old effect woke up when an entry arrived. But the thread's height
   * changes without new entries too: an answer is appended to a bubble that is
   * already there, a "Nina is typing" line appears under the last turn, the
   * question field grows to a hundred and sixty pixels and takes them away from
   * the thread. None of this moves the scroll by itself, and the bottom quietly
   * slides under the bottom edge: when measured, the thread crept away by 37
   * pixels per question and stayed there until the next one.
   *
   * The resize observer watches both the content and the thread's window
   * itself — the latter is exactly about the grown input field.
   */
  $effect(() => {
    const box = scroller
    const inner = thread
    if (!box || !inner) return
    const watch = new ResizeObserver(() => {
      if (pinned) toBottom()
    })
    watch.observe(inner)
    watch.observe(box)
    return () => watch.disconnect()
  })

  /**
   * Where the thread stood last time, to tell "the reader went up" from "the
   * content grew". Not a rune: nobody draws it.
   */
  let lastTop = 0

  function onScroll() {
    if (!scroller) return
    const el = scroller
    const gap = el.scrollHeight - el.scrollTop - el.clientHeight
    /*
     * ONLY A PERSON CAN UNHOOK FROM THE BOTTOM.
     *
     * The scroll event also arrives from our own `scrollTop = scrollHeight`
     * line, and it used to unhook the thread too: while the event travelled to
     * the handler, the answer grew, `scrollHeight` managed to grow, and we
     * honestly computed "far from the bottom" — that is, we marked "the reader
     * went up" ourselves. After that the thread stood dead, and the audience's
     * questions went under the edge. That is exactly what was complained about.
     *
     * There is one reliable sign of a person: scrolling UP. Neither content
     * growth nor our own `scrollTop` line decreases it. A pixel of tolerance is
     * for fractional scrolling at a zoom other than a hundred percent.
     */
    const wentUp = el.scrollTop < lastTop - 1
    lastTop = el.scrollTop
    if (gap < 40) {
      pinned = true
      mark = null
      return
    }
    if (!wentUp || !pinned) return
    pinned = false
    const tail = entries[entries.length - 1]
    mark = tail ? { id: tail.id, length: tail.answer.length } : { id: '', length: 0 }
  }

  /**
   * Whether something arrived below while the reader was looking elsewhere.
   *
   * Both halves count: a whole new question from somebody else, and more of an
   * answer that was already there. The second is the common one — a student
   * scrolls up to re-read cell 03's explanation and the answer they are waiting
   * for finishes underneath them.
   */
  const news = $derived.by(() => {
    if (pinned || !mark) return null
    const tail = entries[entries.length - 1]
    if (!tail) return null
    if (tail.id === mark.id && tail.answer.length <= mark.length) return null
    return tail
  })

  function follow() {
    pinned = true
    mark = null
    toBottom()
  }

  /* ------------------------------------------------------------- composing */

  /**
   * Debounced in both directions: one keystroke should not broadcast, and a
   * pause to think should not yank the line out of everyone else's panel.
   */
  function announceComposing(active: boolean) {
    window.clearTimeout(composeTimer)
    if (active === composingSent) return
    composeTimer = window.setTimeout(
      () => {
        composingSent = active
        session.setComposing(active)
      },
      active ? 220 : 600,
    )
  }

  function stopComposing() {
    window.clearTimeout(composeTimer)
    if (!composingSent) return
    composingSent = false
    session.setComposing(false)
  }

  /* ---------------------------------------------------------------- asking */

  /*
   * The slow-mode countdown is display only.
   *
   * The tab has no time accounting of its own and must not have one: the
   * interval is computed by the server from its own usage table, and here the
   * number it named in the refusal just ticks down. A tab with a lagging clock
   * will simply get refused once more — the dimmed button saves an extra round,
   * it does not decide for the server.
   */
  $effect(() => {
    if (waitUntil === 0) return
    let timer = 0
    const tick = () => {
      const left = Math.max(0, Math.ceil((waitUntil - Date.now()) / 1000))
      waitLeft = left
      if (left === 0) {
        // The line goes away together with the wait: "ten more seconds" still
        // hanging after they have passed is no longer true.
        slowNoticeRender = () => (null)
        waitUntil = 0
        return
      }
      timer = window.setTimeout(tick, 250)
    }
    tick()
    return () => window.clearTimeout(timer)
  })

  async function ask(body: AiAskRequest) {
    if (offline) return
    // The effort level goes with every question, including those sent from the
    // notebook ("Ask the oracle", "Fix") and by retrying a turn: it is chosen
    // at the field, but it applies to everything this tab asks.
    if (effort !== null) body = { ...body, effort }
    stopComposing()
    sendErrorRender = () => (null)
    pinned = true
    // The row enters the feed here, not in `submit`: people also ask from the
    // notebook ("Ask the oracle", "Fix") and by retrying a turn, and they wait
    // exactly as long.
    const outgoingId = openOutbox(body)
    try {
      const { entryId } = await api.aiAsk(session.session.id, session.token, body)
      outbox = outbox.map(row => row.row.id === outgoingId ? { ...row, entryId } : row)
      // The document may arrive before HTTP, including an already finished
      // answer. Reconcile now as well as on the next document update.
      settlePending(entries)
      slowNoticeRender = () => (null)
      waitUntil = 0
    } catch (err) {
      // The question was not accepted — so it has no place in the feed either:
      // a row left hanging with a spinner promises an answer that will not
      // come.
      closeOutbox(outgoingId)
      // Verbatim: a 403 ("hints mode…", "switched off…") and a 429 with the
      // minutes until the next question are the server explaining an
      // instance's rules, and paraphrasing them would leave the student
      // guessing at a limit only the server knows.
      //
      // A deadline in the body means waiting, not a breakage: slow mode speaks
      // in a calm line and dims the button, rather than with a red banner that
      // looks like a failure.
      /*
       * And the question goes back into the field, on ANY refusal.
       *
       * `submit` clears the field before the server answers, and that is right:
       * the row is already in the feed. But if the server did not accept the
       * question — the hourly ceiling (a 429 with a Retry-After header and no
       * deadline in the body), a room rule (403, the bell), a drop through the
       * relay, any 5xx — then the five typed lines disappeared along with the
       * refusal, and there was nothing to bring them back with. The return
       * comes BEFORE the reason is examined, because the reason does not affect
       * it; the only exception is when the person has already started typing
       * again — their text matters more than ours.
       */
      if (composing.question.trim() === '') composing.question = body.message
      if (err instanceof ApiError && err.retryAfter !== null && err.retryAfter > 0) {
        slowNoticeRender = () => (tr(err.message))
        waitUntil = Date.now() + err.retryAfter * 1000
        return
      }
      sendErrorRender = () => (err instanceof Error ? tr(err.message) : tr('room.ui.529'))
    }
  }

  /**
   * Ask or act.
   *
   * A toggle, not a guess from the wording: "rewrite train.py" is both a
   * question and a task, depending on what the person wants, and guessing here
   * means sometimes silently touching other people's files. It sits next to the
   * field, is remembered between questions and goes dark where the mode is
   * forbidden by the room rule.
   */
  let doing = $state(false)

  /**
   * The reasoning effort — next to "Ask/Act" and by the same logic: a choice,
   * not a guess, remembered between questions, living in this browser.
   *
   * `null` means "as this Colloq is set": then not a single new field goes out
   * in the request, and other instances behave exactly as before the control
   * appeared.
   *
   * Anyone can lower it — the answer will come faster and cost less. Only the
   * teacher can raise it above the instance default: whether the whole class
   * waits and pays for "thorough" is decided by whoever runs the class. The
   * server enforces this rule (routes/ai.ts), and here it is drawn — a button
   * that does nothing is worse than a button that is not there.
   */
  let effort = $state<ReasoningEffort | null>(rememberedEffort())
  const instanceEffort = $derived<ReasoningEffort>(status?.reasoningEffort ?? 'normal')
  const effortLabel: Record<ReasoningEffort, string> = {
    instant: tr('common.reasoningInstant'),
    normal: tr('common.reasoningNormal'),
    deep: tr('common.reasoningDeep'),
  }
  const mayEffort = (one: ReasoningEffort): boolean =>
    isHost || effortRank(one) <= effortRank(instanceEffort)
  function pickEffort(next: ReasoningEffort): void {
    if (!mayEffort(next)) return
    // The same level a second time clears the choice: back to the instance
    // default.
    effort = effort === next ? null : next
    rememberEffort(effort)
  }

  const may = $derived(permitsIn(session.session.rules, session.me.role, session.finished))
  const mayDo = $derived(may.agent)
  /*
   * And the oracle mode, not only the `agent` rule.
   *
   * In hints mode the server refuses a task unconditionally: an oracle that
   * does not write the answer for a student all the more does not write it into
   * a file. The toggle has nothing to offer there — "not there at all" instead
   * of "there and refusing".
   */
  const canDo = $derived(mayDo && !hintsOnly)
  /*
   * The rule is changed in the middle of a class — the toggle goes away
   * together with its position. Otherwise a room returning from hints greets
   * the person with an armed "Act" they did not choose.
   */
  $effect(() => {
    if (!canDo) doing = false
    /*
     * And "Ivan is typing a question…" — with the same movement.
     *
     * The line lives in presence, not in this component: after the bell the
     * field disappears entirely, there will be no more `blur` or input, and
     * there is nobody to clear the flag — it hangs there for the whole room
     * until the tab is reloaded. Ivan, meanwhile, is no longer typing anything:
     * he has nothing to ask with.
     */
    if (!may.ask) stopComposing()
  })

  function submit() {
    const message = composing.question.trim()
    if (!message || waitLeft > 0) return
    composing.question = ''
    if (composer) {
      composer.style.height = 'auto'
      composer.focus()
    }
    if (doing && canDo) {
      void ask({ message, mode: 'agent' })
      return
    }
    void ask({ message, action: 'ask', cellIds: [...session.selection] })
  }

  /** Undo the whole turn: the files return to what they were before it. */
  function undo(entryId: string) {
    session.send({ t: 'ai:undo', entryId })
  }

  function retry(entry: ChatSnapshot) {
    /*
     * A retry of a task is a task.
     *
     * Without `mode`, "fix train.py and run it" went out as an ordinary
     * question: the model explained what it would do and did nothing — while
     * Retry was pressed precisely under an "Act" turn. The action and the cell
     * are not passed to the agent: it did not have them the first time either.
     */
    if (entry.mode === 'agent') {
      void ask({ message: entry.question, mode: 'agent' })
      return
    }
    /*
     * All the cells that were asked about, not only the first: "explain 02, 03
     * and 05", retried after a dropped connection, went out as a question about
     * 02, and the header of the new turn showed one cell out of three.
     */
    void ask({
      message: entry.question,
      action: (entry.action as AiAction | null) ?? undefined,
      cellId: entry.cellId,
      cellIds: [...entry.cellIds],
    })
  }

  async function stop(entryId: string) {
    try {
      await api.aiCancel(session.session.id, session.token, entryId)
    } catch (err) {
      sendErrorRender = () => (err instanceof Error ? tr(err.message) : tr('room.ui.530'))
    }
  }

  async function clearThread() {
    // Two-step: this wipes what the whole class asked, and the button sits one
    // pixel from the model name.
    if (!armed) {
      armed = true
      armTimer = window.setTimeout(() => (armed = false), 3000)
      return
    }
    window.clearTimeout(armTimer)
    armed = false
    try {
      await api.aiClearThread(session.session.id, session.token)
    } catch (err) {
      sendErrorRender = () => (err instanceof Error ? tr(err.message) : tr('room.ui.531'))
    }
  }

  function onInput(event: Event) {
    const el = event.currentTarget as HTMLTextAreaElement
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, 160)}px`
    announceComposing(el.value.trim().length > 0)
  }

  function onKeydown(event: KeyboardEvent) {
    if (event.key !== 'Enter' || event.shiftKey || event.isComposing) return
    event.preventDefault()
    submit()
  }
</script>

<div class="panel h-full">
  <div class="flex h-10 shrink-0 items-center gap-2 border-b border-line px-4">
    <Icon name="sparkles" size={14} class="shrink-0 text-accent-text" />
    <span class="shrink-0 text-2xs font-bold uppercase tracking-section text-ink">{tr('room.ui.488')}</span>
    <span
      class="inline-flex h-5 shrink-0 items-center bg-raised px-1.5 text-2xs font-bold uppercase
             tracking-caps text-ink"
      title={tr('room.ui.489')}
    > {tr('room.ui.490')} {entries.length}
    </span>

    <span class="ml-auto min-w-0 truncate font-mono text-2xs text-muted">
      <!--
        Only when there is something to name. A header reading "gpt-4o-mini"
        above a panel saying "no model is set up on this Colloq yet" is the
        screen contradicting itself: the model is what the server WOULD use, and
        until it can, saying it is a claim the room cannot act on.
      -->
      {offline ? '' : (status?.model ?? '')}
    </span>

    {#if isHost}
      <button
        type="button"
        class="btn-ghost h-7 shrink-0 gap-1 px-1.5 text-2xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 {armed
          ? 'text-danger hover:text-danger'
          : ''}"
        title={tr('room.ui.492')}
        aria-label={tr('room.ui.492')}
        disabled={entries.length === 0}
        onclick={clearThread}
      >
        <Icon name="eraser" size={14} />
        {#if armed}<span>{tr('room.ui.493')}</span>{/if}
      </button>
    {/if}
  </div>

  <div class="relative flex min-h-0 flex-1 flex-col">
    <!--
      The feed NEVER moves sideways: `overflow-x: hidden` is a safety net on top
      of the cure. `overflow-y-auto` alone is not enough, and it is harmful the
      other way: by the spec, its `visible` sibling then becomes `auto` by
      itself, that is, the panel got horizontal scrolling from any word that
      poked out past the edge. The cause has been removed in the prose
      (index.css · .prose-note), and this is about the next such word not
      rocking the feed.
    -->
    <div
      bind:this={scroller}
      onscroll={onScroll}
      class="min-h-0 flex-1 overflow-y-auto overflow-x-hidden"
    >
      <!-- The wrapper is needed by the resize observer: it watches the height
           of the CONTENT, and the scroll window's own height does not change,
           however much is appended to it. -->
      <div bind:this={thread}>
      {#if entries.length === 0 && outbox.length === 0}
        <!--
          The first thing a student reads on this panel, so it is not "nothing
          here yet" — it is the one rule about this thread worth knowing before
          you use it.
        -->
        <div class="flex flex-col items-start gap-2.5 px-4 pb-4 pt-4">
          <p class="text-answer text-ink">{tr('room.ui.494')}</p>
          <p class="text-ui text-muted"> {tr('room.ui.495')} </p>
          <!--
            "Select a cell to ask about it" was untrue in exactly the opposite
            way: without a selection the question still went along with the
            whole notebook, and the line advised making mandatory what merely
            sets the focus.
          -->
          <p class="text-ui text-muted"> {tr('room.ui.496')} </p>
        </div>
      {/if}

      {#each [...entries, ...outbox.map((row) => row.row)] as entry (entry.id)}
        <ChatTurn
          {entry}
          pending={entry.id.startsWith('outgoing:')}
          avatar={avatars.get(entry.participantId) ?? null}
          authorRole={roles.get(entry.participantId) ?? 'participant'}
          enter={!inherited.has(entry.id)}
          cellNumber={cellNumber(entry.cellId)}
          askedAbout={(entry.cellIds.length > 0 ? entry.cellIds : entry.cellId ? [entry.cellId] : [])
            .map((id) => cellNumber(id))
            .filter((n): n is number => n !== null)
            .sort((a, b) => a - b)}
          {canDo}
          onretry={() => retry(entry)}
          onstop={() => void stop(entry.id)}
          onundo={() => undo(entry.id)}
        />
      {/each}

      {#if typingLine}
        <!-- Under the last turn rather than inside the thread: this is an
             intention, and the thread holds finished facts. -->
        <div class="flex items-center gap-2 px-4 pb-4 pt-2 text-2xs italic text-muted">
          <span class="flex shrink-0 -space-x-1.5">
            {#each typing.slice(0, 3) as user (user.id)}
              <Avatar size="xs" ring name={user.name} color={user.color} avatar={user.avatar} />
            {/each}
          </span>
          <span class="min-w-0 truncate">{typingLine}</span>
        </div>
      {/if}
      </div>
    </div>

    {#if news}
      <!--
        The thread stops chasing the newest answer the moment somebody scrolls
        back, because reading beats following. Doing that silently, though, is
        how an answer gets lost, so it says whose it is.
      -->
      <div class="pointer-events-none absolute inset-x-0 bottom-2 flex justify-center">
        <button
          type="button"
          class="pointer-events-auto inline-flex h-[26px] animate-fade-up items-center gap-1.5
                 border border-line bg-canvas pl-1.5 pr-2.5 shadow-pop
                 transition-colors duration-[var(--speed-quick)] hover:border-faint
                 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
          onclick={follow}
        >
          <Avatar
            size="xs"
            name={news.name}
            color={news.color}
            avatar={avatars.get(news.participantId) ?? null}
          />
          <span class="text-2xs font-semibold text-ink">
            {news.participantId === session.me.id ? tr('room.ui.497') : tr('room.ui.498', { p0: news.name })}
          </span>
          <Icon name="chevron-down" size={11} class="text-accent-text" />
        </button>
      </div>
    {/if}
  </div>

  <div class="flex shrink-0 flex-col gap-2.5 border-t border-line px-4 pb-4 pt-3">
    {#if sendError}
      <div
        class="flex items-start gap-2 border-l-2 border-danger bg-danger/[0.05] px-3 py-2 text-2xs text-danger"
      >
        <span class="min-w-0 flex-1 [overflow-wrap:anywhere]">{sendError}</span>
        <button
          type="button"
          class="shrink-0 p-0.5 transition-colors duration-100 hover:bg-danger/15 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-danger/40"
          aria-label={tr('room.ui.499')}
          onclick={() => (sendErrorRender = () => null)}
        >
          <Icon name="x" size={12} />
        </button>
      </div>
    {/if}

    {#if statusFailed}
      <!--
        "Don't know" is not "off".

        A single rejected fetch of /api/ai/status used to become a banner "the
        oracle is switched off for this instance" and took the input field away
        with it: an admin's decision in place of a network failure, and without
        a retry. The field stays — the server decides everything by itself
        anyway — and the line says exactly what is.
      -->
      <p class="flex items-center gap-2 border border-line bg-raised px-3 py-2 text-2xs text-muted">
        <span class="min-w-0 flex-1">{tr('room.ui.500')}</span>
        <button
          type="button"
          class="btn-ghost press h-6 shrink-0 px-1.5 text-2xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
          onclick={() => (statusTry += 1)}
        > {tr('room.ui.501')} </button>
      </p>
    {/if}

    {#if slowNotice}
      <!--
        Waiting, not an error: the same calm look as the rules below. The line
        itself is the server's, word for word: only the server knows the
        interval.
      -->
      <p class="border border-line bg-raised px-3 py-2 text-2xs text-muted" role="status">
        {slowNotice}
      </p>
    {/if}

    {#if hintsOnly}
      <!--
        "Asked for a hint", not "there will be no solution".

        Hints mode rests on the wording of the request to the model: we ask it
        not to give the solution, repeat that request after the student's
        words — and that is all, because there is nothing more to be done.
        Promising the class that no solution will appear means making a promise
        on the model's behalf.

        The line stayed where the buttons used to be: it is about the room, not
        about a button, and it should not have disappeared together with them.
      -->
      <p class="text-2xs text-muted"> {tr('room.ui.502')} </p>
    {/if}

    {#if offline}
      <!--
        Two different facts wore the same sentence, and it was addressed to
        whoever runs the server while being read by a student who cannot act on
        it. An oracle switched off by the teacher is a decision, not a fault;
        an unconfigured one is a fault, and only staff can do anything about it —
        so only staff are told where.

        Off — by whom: the server distinguishes an admin's decision from a
        teacher's decision (routes/ai.ts), and the panel has to name the same
        thing, otherwise an admin's decision reaches the class as the teacher's.

        But "no key" and "zero limit" are both returned by /api/ai/status as
        `enabled: false`, and there is nothing here to tell them apart with — so
        the hint to the host names both places at once, not the one they have
        already set up.
      -->
      <p class="border border-line bg-raised px-3 py-2 text-2xs text-muted">
        {#if mode === 'off'}
          {#if status?.mode === 'off'} {tr('room.ui.503')} {:else} {tr('room.ui.504')} {/if}
        {:else if isHost} {tr('room.ui.505')} <span class="font-semibold text-ink">{tr('room.ui.488')}</span> {tr('room.ui.506')} {:else} {tr('room.ui.507')} {/if}
      </p>
    {:else if !may.ask}
      <!--
        The class is over — there is no field at all, rather than a field that
        refuses. The thread stays open and scrollable, though: people come back
        here precisely for the review the oracle wrote during the class.
      -->
      <p class="border border-line bg-raised px-3 py-2 text-2xs text-muted">{may.askWhy}</p>
    {:else}
      <div
        class="flex flex-col items-stretch border border-line bg-surface transition-colors
               duration-[var(--speed-quick)] focus-within:border-accent focus-within:ring-4
               focus-within:ring-accent/15"
      >
        <!--
          What this question will carry, attached to the box it will leave from.
          It used to sit above the whole thread, which read as a fact about the
          room; it is not one. Every chip here comes off THIS browser's
          selection, so two people looking at the same panel see two different
          rows — and the only place that is honest is against the field where
          the person who owns that selection is typing.

          Named piece by piece, and nothing is claimed that this browser cannot
          verify: ai/context.ts also sends the whole notebook, the kernel status
          and the file list, which have no chip because they are unconditional
          and a chip that is always lit says nothing.
        -->
        <!--
          What will go along with this question — above the field itself, not
          above the feed: it is a fact about THIS tab, not about the room.
          Everyone has their own selection, and two people looking at the same
          panel see different things here.
        -->
        <div class="flex flex-col gap-0.5 border-b border-line px-2 py-1.5">
          <div class="flex items-baseline gap-1.5">
            <span
              class="shrink-0 text-2xs font-bold uppercase tracking-institution text-muted"
              title={tr('room.ui.508')}
            > {tr('room.ui.509')} </span>
            <span class="min-w-0 truncate text-2xs text-muted">{seesAll}</span>
          </div>
          {#if focus.length > 0}
            <!-- Appears only when there is something to focus on: a line that
                 is always lit says nothing. -->
            <div class="flex items-baseline gap-1.5">
              <span
                class="shrink-0 text-2xs font-bold uppercase tracking-institution text-accent-text"
                title={tr('room.ui.510')}
              > {tr('room.ui.511')} </span>
              <span class="min-w-0 truncate font-mono text-2xs text-ink">
                {focus.join(' · ')}
              </span>
            </div>
          {/if}
        </div>

        <!--
          Ask or act — with a toggle, not a guess from the wording. "Rewrite
          train.py" is both a question and a task; guessing means sometimes
          silently touching other people's files. Where the mode is closed — by
          the room rule or by hints mode — there is no toggle at all, rather
          than one that is there and refuses.
        -->
        <div class="flex flex-wrap items-center gap-x-2 gap-y-1 px-2 pb-0.5 pt-1.5">
        {#if canDo}
            <div class="flex items-stretch border border-line bg-canvas">
              <button
                type="button"
                class="px-2 py-0.5 text-2xs font-semibold transition-colors duration-100
                       {doing ? 'text-muted hover:text-ink' : 'bg-primary text-primary-ink'}"
                onclick={() => (doing = false)}
              > {tr('room.ui.513')} </button>
              <button
                type="button"
                class="px-2 py-0.5 text-2xs font-semibold transition-colors duration-100
                       {doing ? 'bg-primary text-primary-ink' : 'text-muted hover:text-ink'}"
                onclick={() => (doing = true)}
              > {tr('room.ui.514')} </button>
            </div>
        {/if}
          <!--
            The reasoning effort. Disabled buttons are not drawn where the level
            cannot be raised: a student sees exactly what is available to them.
          -->
          <div class="flex items-stretch border border-line bg-canvas" data-oracle-effort>
            {#each REASONING_EFFORTS as one (one)}
              {#if mayEffort(one)}
                <button
                  type="button"
                  class="px-2 py-0.5 text-2xs font-semibold transition-colors duration-100
                         {effort === one ? 'bg-accent text-canvas' : 'text-muted hover:text-ink'}"
                  aria-pressed={effort === one}
                  title={tr('common.reasoning')}
                  onclick={() => pickEffort(one)}
                > {effortLabel[one]} </button>
              {/if}
            {/each}
          </div>
        </div>

        <div class="flex items-end gap-2 py-1 pl-2 pr-1.5">
        <!-- Your face before you type, so it is obvious the room will see this. -->
        <Avatar
          class="mb-1"
          size="xs"
          name={session.me.name}
          color={session.me.color}
          avatar={session.me.avatar}
          title={tr('room.oracle.asker', { name: session.me.name })}
        />
        <!-- A marker for "Ask the oracle" from the keyboard: ⌘/Ctrl+I and the
             palette row put focus here (SessionScreen · focusOracle). On the
             field itself, not on the panel: the fallback path
             `[data-oracle-panel] textarea` relies on there being exactly one
             input field in the panel, and a second field here — editing a
             question, a draft answer — would silently take the focus away. -->
        <textarea
          bind:this={composer}
          data-oracle-composer
          bind:value={composing.question}
          rows="1"
          placeholder={doing && canDo
            ? tr('room.extra.217')
            : focusAsked
              ? tr('room.extra.218', { p0: focusAsked })
              : tr('room.extra.219')}
          title={tr('room.ui.515')}
          class="max-h-40 flex-1 resize-none bg-transparent py-1 text-ui text-ink placeholder:text-muted focus:outline-none"
          oninput={onInput}
          onkeydown={onKeydown}
          onblur={() => {
            if (!composing.question.trim()) stopComposing()
          }}
        ></textarea>
        <!--
          While the interval runs, the button shows seconds instead of the paper
          plane. The number ticks on the send button, not in the line above the
          field: that line holds a rule, and rewriting it every second means
          blinking text that the person is reading at that time.
        -->
        <button
          type="button"
          class="btn-primary h-7 w-7 shrink-0 px-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
          aria-label={waitLeft > 0 ? tr('room.extra.220', { p0: waitLeft }) : tr('room.extra.221')}
          title={waitLeft > 0 ? (slowNotice ?? '') : ''}
          disabled={!composing.question.trim() || waitLeft > 0}
          onclick={submit}
        >
          {#if waitLeft > 0}
            <span class="font-mono text-2xs font-bold tabular-nums">{waitLeft}</span>
          {:else}
            <Icon name="send" size={14} />
          {/if}
        </button>
        </div>
      </div>
    {/if}

    <p class="flex items-center gap-1.5 text-2xs text-muted">
      <Icon name="users" size={13} class="shrink-0" />
      <span class="min-w-0">
        {doing && canDo
          ? tr('room.ui.516')
          : tr('room.ui.517')}
      </span>
    </p>
  </div>
</div>
