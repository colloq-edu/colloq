import { tr, formatNumber } from '@shared/i18n'
/**
 * The council on the client: one's own attempt, the teacher's stack and the
 * counters — from control socket messages, per cell.
 *
 * Attempts deliberately do not live in the shared notebook (see
 * shared/protocol.ts · council:*): a student types locally, a snapshot goes to
 * the server on a typing pause, and three different views come back —
 * `council:mine` to the author, `council:board` to the teacher (whole once,
 * then as `council:patch` deltas), `council:count` to the whole room. Here
 * they are stored per cell and handed to CellView as runes; the socket itself
 * lives in SessionState and comes here as a single `send` function.
 *
 * The maps are `$state.raw` and are replaced whole, like notes and ink in
 * SessionState: there is no point wrapping a stack snapshot of five hundred
 * attempts in a deep proxy, it is read as a whole. The values keep their
 * reference meanwhile: a cell whose snapshot did not change gets the same
 * object from `$derived` and is not redrawn.
 *
 * The pure part — `DraftOutbox`, `withOracle`, the counter captions — has no
 * runes, and it is exactly what is under test (tests/council-client.test.mts).
 */
import { untrack } from 'svelte'
import type * as Y from 'yjs'
import {
  cellLock,
  councilSettingsOf,
  MAX_ATTEMPT_CHARS,
  type CellLock,
  type CouncilSettings,
  type YCell,
} from '@shared/notebook'
import type {
  ControlClientMessage,
  ControlServerMessage,
  CouncilAttempt,
  CouncilBoard,
  CouncilKernel,
  CouncilMine,
  CouncilOracle,
  CouncilShown,
} from '@shared/protocol'
import { plural } from './plural'

/** The server messages that are about the council — exactly what `receive` takes. */
export type CouncilMessage = Extract<
  ControlServerMessage,
  {
    t:
      | 'council:mine'
      | 'council:board'
      | 'council:patch'
      | 'council:oracle'
      | 'council:count'
      | 'council:shown'
      | 'council:hint:state'
      | 'council:kernel'
      | 'council:ready'
  }
>

export type CouncilPatch = Extract<CouncilMessage, { t: 'council:patch' }>

/** "N of M submitted" — without texts, for the projector and the chip above the cell. */
export interface CouncilCount {
  submitted: number
  total: number
}

/**
 * How long to wait for the end of the welcome batch if the server does not say.
 *
 * The `council:ready` frame appeared on 20 Sep 2026; an older build does not
 * send it, and the batch can get lost too. Six seconds is surely longer than
 * the batch itself (it is assembled in one pass over the notebooks and sent
 * right after entry) and surely shorter than the patience of a person looking
 * at the splash and wondering whether the window is alive. After that the
 * console shows what it knows — even if that is emptiness.
 */
export const WELCOME_WAIT_MS = 6_000

/**
 * What the console knows about a cell's stack: waiting, it is not there, or
 * here it is.
 *
 * Before 20 Sep 2026 there was a single fork — `board === null` — and it meant
 * two different facts at once: "the frame is still on its way" and "there is
 * no council here". The console chose the second, and on every reload, between
 * the splash and itself, it managed to flash "the cell is not in the council":
 * the window is drawn before the first `council:board`.
 *
 * A pure function with four inputs, because "I don't know" is made of four
 * different promises:
 *  - `settled` — the server said the batch is over (or the watchdog got tired
 *    of waiting);
 *  - `connected` — without a connection emptiness means nothing;
 *  - `council` — the cell's lock in the DOCUMENT: the CRDT and the socket are
 *    different channels, and a document that already knows about the council
 *    argues with the socket's silence;
 *  - `board` — the stack itself.
 *
 * A stack whose council was lifted and that has no attempts left is a "no":
 * there is no point showing it, and this same branch used to be responsible
 * for the empty screen.
 */
export type BoardPhase = 'waiting' | 'missing' | 'ready'

export function boardPhase(input: {
  board: CouncilBoard | null
  settled: boolean
  connected: boolean
  council: boolean
}): BoardPhase {
  const { board, settled, connected, council } = input
  if (board !== null) {
    return board.lock === 'council' || board.counts.attempts > 0 ? 'ready' : 'missing'
  }
  // The batch is still on its way — silence is not an answer.
  if (!settled) return 'waiting'
  /*
   * The watchdog has let go, but the document says "there is a council here":
   * the stack will arrive in its own frame, because the server sends it on a
   * lock change. Keep waiting — but only while the connection is alive:
   * without it the stack has nowhere to come from, and an eternal splash would
   * be a worse answer than emptiness.
   */
  return council && connected ? 'waiting' : 'missing'
}

/**
 * The typing pause after which a snapshot goes to the server.
 *
 * Under a second, by design: a person who finished a line and reached for
 * "Submit" must not manage to press before the text has gone — otherwise the
 * previous snapshot is submitted. Over half a second: five hundred people
 * sending a snapshot on every word is exactly the noise the council keeps
 * attempts out of the CRDT to avoid.
 */
export const DRAFT_PAUSE_MS = 800

/**
 * The draft queue: one timer per cell, the last text wins.
 *
 * A separate class without runes and with a fake clock — to check exactly
 * what makes such queues lie: two quick presses give one send, "Submit"
 * before the pause runs out carries the fresh text rather than the previous
 * one, and a cell where nothing was typed sends no empty snapshot on submit.
 */
export class DraftOutbox {
  readonly #pending = new Map<string, { text: string; timer: ReturnType<typeof setTimeout> }>()
  readonly #send: (cellId: string, text: string) => void
  readonly #pause: number

  constructor(send: (cellId: string, text: string) => void, pause = DRAFT_PAUSE_MS) {
    this.#send = send
    this.#pause = pause
  }

  /** Hold the text: it goes out after the pause unless called again in the meantime. */
  hold(cellId: string, text: string): void {
    const previous = this.#pending.get(cellId)
    if (previous) clearTimeout(previous.timer)
    const timer = setTimeout(() => this.flush(cellId), this.#pause)
    this.#pending.set(cellId, { text, timer })
  }

  /** Send now what is held for this cell. Nothing held — nothing sent. */
  flush(cellId: string): boolean {
    const pending = this.#pending.get(cellId)
    if (!pending) return false
    clearTimeout(pending.timer)
    this.#pending.delete(cellId)
    this.#send(cellId, pending.text)
    return true
  }

  /** Forget what is held without sending: the council was closed under one's hand. */
  drop(cellId: string): void {
    const pending = this.#pending.get(cellId)
    if (!pending) return
    clearTimeout(pending.timer)
    this.#pending.delete(cellId)
  }

  has(cellId: string): boolean {
    return this.#pending.has(cellId)
  }

  /** Clear all timers — on leaving the room. Sends nothing: the socket is already gone. */
  clear(): void {
    for (const { timer } of this.#pending.values()) clearTimeout(timer)
    this.#pending.clear()
  }
}

/** The stack with a new oracle state — everything else untouched. */
export function withOracle(board: CouncilBoard, oracle: CouncilOracle): CouncilBoard {
  return { ...board, oracle }
}

/**
 * The stack after a delta: attempts from the frame replace their own by
 * participantId (new ones go to the end), `removed` ones leave, the numbers
 * and the lock come from the frame. The order of the rest does not change:
 * the console computes the groups and the stack itself, the order here
 * affects nothing, and an extra re-sort is an extra redraw.
 */
export function withPatch(board: CouncilBoard, patch: CouncilPatch): CouncilBoard {
  const fresh = new Map(patch.attempts.map((a) => [a.participantId, a] as const))
  const gone = new Set(patch.removed)
  const attempts: CouncilAttempt[] = []
  for (const attempt of board.attempts) {
    if (gone.has(attempt.participantId)) continue
    const next = fresh.get(attempt.participantId)
    if (next) fresh.delete(attempt.participantId)
    attempts.push(next ?? attempt)
  }
  for (const attempt of fresh.values()) if (!gone.has(attempt.participantId)) attempts.push(attempt)
  return {
    ...board,
    attempts,
    counts: patch.counts,
    lock: patch.lock,
    settings: patch.settings,
  }
}

/**
 * What to start one's sheet from: one's own attempt, if there is one,
 * otherwise the cell's shared text — the task usually lies in it.
 *
 * An empty string from the server is not an attempt but "no attempt yet"
 * (mineFor sends `text: ''` for an open council), and a sheet must not be
 * started from it: the lock arrives over the CRDT and `council:mine` over the
 * control socket, and whoever got `mine` first ended up with an empty sheet,
 * while their neighbour got the task. One class, two different starting
 * sheets, decided by the race of two sockets.
 */
export function sheetSeed(mineText: string | null | undefined, shared: string): string {
  return mineText || shared
}

/**
 * The teacher-mode strip: "487 attempts · 446 submitted · 41 drafts ·
 * 6 different answers". Pieces with nothing to say are dropped: "0 drafts" at
 * the end of the work is noise next to the number people look for.
 *
 * `groups` — how many different answers are ON SCREEN. A separate argument
 * rather than a `counts` field, because these are different numbers: the
 * server counts groups across the whole room, while the stack groups what has
 * reached it, and the strip must show what a person can recount by eye. Not
 * given — the server's number is used.
 */
export function councilStripText(counts: CouncilBoard['counts'], groups = counts.groups): string {
  const parts: string[] = []
  parts.push(tr('room.ui.1054', { count: counts.attempts }))
  parts.push(tr('room.ui.1055', { count: counts.submitted }))
  if (counts.writing > 0) {
    parts.push(tr('room.ui.1056', { count: counts.writing }))
  }
  if (groups > 0) {
    parts.push(tr('room.ui.1057', { count: groups }))
  }
  return parts.join(' · ')
}

/** "446 of 487 submitted" — the student's chip and the projector line. */
export function countLine(count: CouncilCount): string {
  return tr('room.ui.1058', { count: count.submitted, total: count.total })
}

/**
 * Who ran the attempt and how — the line under the output for the author.
 *
 * "You" instead of a name: the author has one counterpart — the teacher — and
 * a second name in this line would be the author's own.
 */
export function ranByLine(
  run: NonNullable<CouncilMine['run']>,
  spellMs: (ms: number) => string,
): string {
  if (run.state === 'queued') return tr('room.ui.1059')
  if (run.state === 'running') return tr('room.ui.1060')
  const who = run.by === 'host' ? tr('room.ui.61') : tr('room.ui.1061')
  return run.ranMs === null ? who : `${who} · ${spellMs(run.ranMs)}`
}

/**
 * The output of the shown attempt — as lines of text, for the projector.
 *
 * The projector strip is a dark band twenty pixels high over the lecture page,
 * and there is nothing to draw a real `CellOutputs` in it with: that is set
 * for a light notebook (frames, backings, full-width images) and on black it
 * would read as a white rectangle. The hall looks at the output in ONE
 * glance: what was printed, the exception name with its message, the text
 * representation — and the tail, which would not fit into the band anyway, is
 * cut off.
 *
 * Images do not come here at all: a plot in a band at the bottom of the
 * screen is either a fifteen-pixel stamp or half of the lecture hidden under
 * it.
 */
export function shownOutputLines(run: CouncilMine['run'], limit = 4): string[] {
  const lines: string[] = []
  for (const output of run?.outputs ?? []) {
    if (output.kind === 'stream') lines.push(...output.text.replace(/\n+$/, '').split('\n'))
    else if (output.kind === 'error') lines.push([output.ename, output.evalue].filter(Boolean).join(': '))
    else if (output.data['text/plain']) {
      lines.push(...output.data['text/plain'].replace(/\n+$/, '').split('\n'))
    }
    if (lines.length > limit) break
  }
  return lines.slice(0, limit)
}

/**
 * "you are 37th in the queue" — the place in the run queue, if the knob is on.
 *
 * Masculine, not inflected: in Russian the nominative ordinal of any number
 * ends in "-й" (first, third, fortieth), so there is one ending.
 */
export function queueWords(place: number): string {
  return tr('room.ui.1063', { p0: place })
}

/* ------------------------------------------------------- attempt ceiling */

/**
 * How many characters are in the attempt — in words under the sheet, and only
 * when it matters.
 *
 * The ceiling is one for both sides (`MAX_ATTEMPT_CHARS` in
 * shared/notebook.ts): above it the server does not accept a snapshot and
 * says so in words. While the client did not know the number, it sent a
 * snapshot on every typing pause and got a refusal on every one — a toast once
 * a second over the typing, telling neither how much had been typed nor how
 * much was allowed.
 *
 * `null` while the ceiling is far away: a counter hanging over every sheet
 * from the first letter is noise. Nine tenths is the point where it can still
 * be a warning rather than a verdict on what has been typed.
 */
export function attemptCounter(chars: number): string | null {
  if (chars < MAX_ATTEMPT_CHARS * 0.9) return null
  return tr('room.ui.1064', { p0: countOf(chars), p1: countOf(MAX_ATTEMPT_CHARS) })
}

/** Digit groups the Russian way: "9 012", not "9012". */
function countOf(n: number): string {
  return formatNumber(n)
}

/** Does not fit: the server will reject such a snapshot, so a paste must be stopped. */
export function attemptTooLong(text: string): boolean {
  return text.length > MAX_ATTEMPT_CHARS
}

/**
 * Whether what the server holds is what the person sees on the sheet.
 *
 * Asked for the sake of "submitted": a snapshot over the ceiling does not go
 * out, and "Submit" sends WHAT THE SERVER HOLDS. Without this check the
 * student has a long text marked as submitted, while the teacher's stack has
 * a short, previous one; this is discovered at the review, when it is too
 * late to rewrite.
 *
 * `undefined` — there is no attempt on the server at all yet, and an empty
 * sheet equals it.
 */
export function attemptInSync(mine: CouncilMine | null | undefined, sheet: string): boolean {
  return (mine?.text ?? '') === sheet
}

/* ----------------------------------------------------------------- runes */

/**
 * The room's council state. Lives in SessionState and dies with it.
 *
 * Sending goes only through the socket's `send`: the queue on a closed
 * connection and "no connection" in words stay where they are for every
 * other press.
 */
export class CouncilState {
  /** One's own attempt per cell — arrives only to the author. */
  mine = $state.raw<Record<string, CouncilMine>>({})
  /** Stacks per cell — arrive only to the teacher. */
  boards = $state.raw<Record<string, CouncilBoard>>({})
  /** "N of M submitted" per cell — to the whole room. */
  counts = $state.raw<Record<string, CouncilCount>>({})
  /**
   * The oracle hint on one's own attempt: whether it is thinking and how the
   * last press ended. Per cell, because a person has as many sheets as there
   * are cells in the council.
   */
  hints = $state.raw<Record<string, { asking: boolean; error: string | null }>>({})
  /**
   * What is on screen right now per cell — also for the whole room.
   *
   * The only place where a student holds someone else's code, and it is there
   * for a reason: it is the caption to a solution that is on the projector at
   * that very second (shared/protocol.ts · CouncilShown). The key is present
   * but the value is `null` — the showing was removed: the badge collapses,
   * and the cell remembers that a frame for it did arrive.
   */
  shown = $state.raw<Record<string, CouncilShown | null>>({})
  /**
   * What the NOTEBOOK kernel of each cell is busy with — for the teacher only.
   *
   * Separate from the stack, although the key is the same. The stack is about
   * this cell's attempts, and this is about the shared kernel: the notebook
   * has one queue, and it can be held by an ordinary cell or by an attempt of
   * a neighbouring council cell. That cannot be assembled from the stack, and
   * for ages the console showed "No code is running in this cell" next to
   * "queued: 12" (shared/protocol.ts · CouncilKernel).
   */
  kernels = $state.raw<Record<string, CouncilKernel>>({})
  /**
   * The council's welcome batch has finished — at least once in the window's
   * life.
   *
   * Raised by the `council:ready` frame (shared/protocol.ts) and NEVER goes
   * out again: a reconnect brings the batch again, and resetting the flag on a
   * disconnect would bring back that very flash of "the cell is not in the
   * council" — this time in the middle of a class, in a console that simply
   * lost the network for a second.
   */
  welcomed = $state(false)

  readonly #send: (message: ControlClientMessage) => void
  readonly #outbox: DraftOutbox
  /**
   * An oracle that arrived before its stack. The stack arrives whole and
   * carries `oracle` inside, so this is usually empty; but nobody promised the
   * order of frames in the welcome batch, and losing a model answer because of
   * it would be a pity — it cost a question from the room's limit.
   */
  readonly #earlyOracles = new Map<string, CouncilOracle>()
  /**
   * For which runs the output has already been requested —
   * `cellId:participantId:startedAt`.
   *
   * The key carries the start moment, not just the participantId: an attempt
   * gets run again, and the new run's output may again not fit the frame
   * budget. The memory lives here, not in the card: the card gets unmounted —
   * the cell collapsed, the view switched, the notebook scrolled — and it sets
   * up its set anew, that is, it would ask the same thing again.
   */
  readonly #askedOutputs = new Set<string>()

  constructor(send: (message: ControlClientMessage) => void) {
    this.#send = send
    this.#outbox = new DraftOutbox((cellId, text) =>
      this.#send({ t: 'council:draft', cellId, text }),
    )
  }

  receive(message: CouncilMessage): void {
    if (message.t === 'council:ready') {
      this.welcomed = true
      return
    }
    if (message.t === 'council:mine') {
      this.mine = { ...this.mine, [message.cellId]: message.state }
      // A closed council accepts no snapshots — the held one is dropped unsent,
      // while the text stays in the author's editor as a draft.
      if (message.state.closed) this.#outbox.drop(message.cellId)
      return
    }
    if (message.t === 'council:board') {
      /*
       * The full stack arrives anew — and is cut by the budget anew.
       *
       * After the console reconnects or the lock clicks, the output of the
       * same attempt may again not come along, while it was asked for in the
       * frame's previous life. Without this cleanup the card would be stuck
       * with "requesting separately…" forever.
       */
      for (const key of this.#askedOutputs) {
        if (key.startsWith(`${message.cellId}:`)) this.#askedOutputs.delete(key)
      }
      const early = this.#earlyOracles.get(message.cellId)
      const board =
        early && message.board.oracle === null ? withOracle(message.board, early) : message.board
      this.#earlyOracles.delete(message.cellId)
      this.boards = { ...this.boards, [message.cellId]: board }
      return
    }
    if (message.t === 'council:patch') {
      const board = this.boards[message.cellId]
      // There is no stack for this cell yet — nowhere to put the delta: the full
      // stack arrives in the batch on connect and on a lock change, and a delta
      // without it would pass off a stack of one person as the whole class.
      if (!board) return
      this.boards = { ...this.boards, [message.cellId]: withPatch(board, message) }
      return
    }
    if (message.t === 'council:shown') {
      this.shown = { ...this.shown, [message.cellId]: message.shown }
      return
    }
    if (message.t === 'council:kernel') {
      this.kernels = { ...this.kernels, [message.cellId]: message.kernel }
      return
    }
    if (message.t === 'council:hint:state') {
      /*
       * The frame is only about the button: the answer itself arrives as a
       * letter in `council:mine` and lives in the attempt. A refusal stays
       * until the next press — it explains why the button is alive again and
       * nothing happened.
       */
      this.hints = {
        ...this.hints,
        [message.cellId]: { asking: message.asking, error: message.error ?? null },
      }
      return
    }
    if (message.t === 'council:oracle') {
      const board = this.boards[message.cellId]
      if (board)
        this.boards = { ...this.boards, [message.cellId]: withOracle(board, message.oracle) }
      else this.#earlyOracles.set(message.cellId, message.oracle)
      return
    }
    this.counts = {
      ...this.counts,
      [message.cellId]: { submitted: message.submitted, total: message.total },
    }
  }

  /* ------------------------------------------------------------ own sheet */

  /**
   * Hold a snapshot of the text: it goes out after a typing pause.
   *
   * Over the ceiling a snapshot is neither held nor sent: the server would
   * reject it anyway, and it rejects in words — that is, with a toast on every
   * typing pause while the person finishes a long attempt. The counter under
   * the sheet (`attemptCounter`) speaks about the ceiling, and it speaks once,
   * not twenty times.
   */
  draft(cellId: string, text: string): void {
    if (attemptTooLong(text)) return
    this.#outbox.hold(cellId, text)
  }

  /** Send what is held right now — on blur and before "Submit". */
  flush(cellId: string): void {
    this.#outbox.flush(cellId)
  }

  /**
   * "Submit". The fresh snapshot first, then the submission: otherwise the
   * server would submit a text a second old, and the last line would arrive
   * after it was already submitted.
   */
  submit(cellId: string): void {
    this.#outbox.flush(cellId)
    this.#send({ t: 'council:submit', cellId })
  }

  /**
   * Ask for a hint on one's own failed attempt.
   *
   * "Thinking" is set here, without waiting for the echo: between the press
   * and the server's first frame lies a trip to the model, and a live button
   * all that time is an invitation to press a second time, that is, a second
   * question from the limit. The server will confirm the same with a
   * `council:hint:state` frame, and it is also what clears it.
   */
  askHint(cellId: string): void {
    if (this.hints[cellId]?.asking) return
    this.hints = { ...this.hints, [cellId]: { asking: true, error: null } }
    this.#send({ t: 'council:hint', cellId })
  }

  /** "Edit": remove "submitted", the text stays. */
  withdraw(cellId: string): void {
    this.#send({ t: 'council:withdraw', cellId })
  }

  /**
   * Ask for the output of one attempt — the one that did not come with the
   * stack.
   *
   * The server cuts the full `council:board` frame by an output budget:
   * attempts beyond it have an empty `run.outputs` and `run.outputsOmitted`
   * set (shared/protocol · CouncilRun). The card asks when it is expanded —
   * one attempt at a time, and the answer arrives as an ordinary
   * `council:patch` delta, now with the output.
   *
   * It silently does nothing in two cases, both normal: the attempt is not in
   * the stack (its author was banned while the card was being looked at), and
   * the output in the frame is real. The second is why the check is here and
   * not at the caller: while the card is open, the effect reruns on every
   * delta, and the request must go out once per run.
   */
  wantOutputs(cellId: string, participantId: string): void {
    const attempt = this.boards[cellId]?.attempts.find((a) => a.participantId === participantId)
    const run = attempt?.run
    if (!run?.outputsOmitted) return
    const key = `${cellId}:${participantId}:${run.startedAt}`
    if (this.#askedOutputs.has(key)) return
    this.#askedOutputs.add(key)
    this.#send({ t: 'council:attempt', cellId, participantId })
  }

  /** Run: one's own attempt (no participantId) or someone's — the teacher. */
  run(cellId: string, participantId?: string): void {
    if (participantId === undefined) this.#outbox.flush(cellId)
    this.#send(
      participantId === undefined
        ? { t: 'council:run', cellId }
        : { t: 'council:run', cellId, participantId },
    )
  }

  /** The request refers to the latest snapshot, not to the previous text on the server. */
  requestRun(cellId: string): void {
    this.#outbox.flush(cellId)
    this.#send({ t: 'council:run:request', cellId })
  }

  cancelRunRequest(cellId: string, requestId: string): void {
    this.#send({ t: 'council:run:cancel', cellId, requestId })
  }

  approveRunRequest(cellId: string, participantId: string, requestId: string): void {
    this.#send({ t: 'council:run:approve', cellId, participantId, requestId })
  }

  declineRunRequest(cellId: string, participantId: string, requestId: string): void {
    this.#send({ t: 'council:run:decline', cellId, participantId, requestId })
  }

  /**
   * Take someone else's waiting run out of the queue — without touching the
   * person.
   *
   * Separate from `cancelRunRequest`: that one is about a REQUEST ("please let
   * me run"), this one about a job already put in the queue. The server tells
   * the author about it in words — a run that silently vanishes reads as a
   * breakage.
   */
  dropRun(cellId: string, participantId: string): void {
    this.#send({ t: 'council:run:drop', cellId, participantId })
  }

  /* ------------------------------------------------------------------ host */

  /** Set the lock position — and the council's knobs in the same message. */
  lock(cellId: string, state: CellLock, settings?: Partial<CouncilSettings>): void {
    this.#send(
      settings ? { t: 'cell:lock', cellId, state, settings } : { t: 'cell:lock', cellId, state },
    )
  }

  show(cellId: string, participantId: string): void {
    this.#send({ t: 'council:show', cellId, participantId })
  }

  /** "Clear the screen": the showing leaves the cell entirely; the text is untouched. */
  clearShown(cellId: string): void {
    this.#send({ t: 'council:show:clear', cellId })
  }

  reply(cellId: string, to: { participantId: string } | { groupKey: string }, text: string): void {
    this.#send({ t: 'council:reply', cellId, to, text })
  }

  mark(cellId: string, participantId: string, correct: boolean | null): void {
    this.#send({ t: 'council:mark', cellId, participantId, correct })
  }

  destroy(): void {
    this.#outbox.clear()
  }
}

/* --------------------------------------------------------------- cell lock */

/** The lock position and the council's knobs — what `watchCellMeta` does not distinguish. */
export interface CellLockView {
  lock: CellLock
  /** `null` outside a council — a closed door has no knobs. */
  settings: CouncilSettings | null
}

const CLOSED_LOCK: CellLockView = { lock: 'closed', settings: null }

function readLock(cell: YCell): CellLockView {
  return { lock: cellLock(cell), settings: councilSettingsOf(cell) }
}

function sameLock(a: CellLockView, b: CellLockView): boolean {
  return (
    a.lock === b.lock &&
    a.settings?.studentRun === b.settings?.studentRun &&
    a.settings?.namesOnProjector === b.settings?.namesOnProjector &&
    (a.settings === null) === (b.settings === null)
  )
}

/**
 * The three-position cell lock — as a rune.
 *
 * `watchCellMeta` returns `open: boolean` (= isCellOpen) and wakes on the
 * `open` key, but to it a council is a closed cell, and it silently swallows
 * the closed → council transition as "the same thing". Here is a narrow
 * observer of our own on the same Y.Map: two keys, `open` and `council`, only
 * the server writes them, and they change a handful of times per class. Call
 * it during component initialisation — inside `$effect`.
 */
export function watchCellLock(cell: () => YCell | null): { readonly current: CellLockView } {
  let current = $state.raw<CellLockView>(CLOSED_LOCK)

  $effect(() => {
    const target = cell()
    // Assign without reading: the effect depends on the cell, not on what it writes.
    current = target ? readLock(target) : CLOSED_LOCK
    if (!target) return
    const observer = (event: Y.YMapEvent<unknown>) => {
      if (!event.keysChanged.has('open') && !event.keysChanged.has('council')) return
      const next = readLock(target)
      if (
        !sameLock(
          next,
          untrack(() => current),
        )
      )
        current = next
    }
    target.observe(observer)
    return () => target.unobserve(observer)
  })

  return {
    get current() {
      return current
    },
  }
}
