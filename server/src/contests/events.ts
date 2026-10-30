/**
 * Who hears that a contest changed — so the streams PUSH instead of polling.
 *
 * The competitions' participant stream rebuilds its answer every second and
 * compares (routes/competitions.ts · stream); for contests that would be
 * thirty phones each recomputing a board every second for an hour, mostly to
 * learn that nothing moved. So every write the contests' store makes says
 * what it touched, here, and a stream recomputes only then (the pattern of
 * dependencies/service.ts · watchBundle).
 *
 * WHAT IS SAID: the contest and the kind of change —
 *  - `revision`: the contest itself, a problem, the tests, the phase (the
 *    pump's clock says when a start, an end or a freeze passes);
 *  - `submission`: a submission was sent, started, judged, rejudged or
 *    removed, or a person joined — the board may have moved;
 *  - `progress`: a running judging finished another test: only its author's
 *    page and the teacher's console care;
 *  - `questions`: a question, an answer, an announcement.
 *
 * DELIVERED AFTER THE WRITE, NOT DURING IT: the notes of one turn of the event
 * loop are gathered and handed out on the next (setImmediate), one per kind,
 * so a listener never reads inside a transaction that may yet roll back, and
 * an archive of three hundred tests is one event, not three hundred.
 */
import { EventEmitter } from 'node:events'
import { randomBytes } from 'node:crypto'

export type ContestChange = 'revision' | 'submission' | 'progress' | 'questions'

export interface ContestEvent {
  contestId: string
  change: ContestChange
  /** Whose submission it was, for `submission` and `progress`; null — the teacher's run, or nobody's. */
  entrantId: string | null
}

const emitter = new EventEmitter()
emitter.setMaxListeners(0)
const EVERY = '*'

const pending = new Map<string, ContestEvent>()
let scheduled = false

/*
 * The console's «submissions» version: a counter per contest, bumped with
 * every submission's change (progress included), under this process life's
 * mark. Exact and free, and a restart cannot make an old number mean new rows:
 * the mark changes with the life.
 */
const LIFE = randomBytes(4).toString('hex')
const submissionCounters = new Map<string, number>()

function flush(): void {
  scheduled = false
  const batch = [...pending.values()]
  pending.clear()
  for (const event of batch) {
    emitter.emit(event.contestId, event)
    emitter.emit(EVERY, event)
  }
}

/** Say that a contest changed. Cheap, synchronous, never throws: called from inside the store's writes. */
export function noteContest(contestId: string, change: ContestChange, entrantId: string | null = null): void {
  if (change === 'submission' || change === 'progress') {
    submissionCounters.set(contestId, (submissionCounters.get(contestId) ?? 0) + 1)
  }
  pending.set(`${contestId}\u0000${change}\u0000${entrantId ?? ''}`, { contestId, change, entrantId })
  if (scheduled) return
  scheduled = true
  setImmediate(flush)
}

/**
 * Say that the judge itself changed — paused, let go, its slots — which is no
 * contest's: heard only by those listening to every contest (the consoles'
 * judge strip).
 */
export function noteJudgeChanged(): void {
  pending.set('\u0000judge', { contestId: '', change: 'revision', entrantId: null })
  if (scheduled) return
  scheduled = true
  setImmediate(flush)
}

/** Listen to one contest; returns the way to stop. */
export function watchContest(contestId: string, listener: (event: ContestEvent) => void): () => void {
  emitter.on(contestId, listener)
  return () => {
    emitter.off(contestId, listener)
  }
}

/** Listen to every contest: the judge's strip changes with any of them. */
export function watchContests(listener: (event: ContestEvent) => void): () => void {
  emitter.on(EVERY, listener)
  return () => {
    emitter.off(EVERY, listener)
  }
}

/** The console's submissions version (ContestLiveState.submissions). */
export function submissionsVersion(contestId: string): string {
  return `${LIFE}.${submissionCounters.get(contestId) ?? 0}`
}

/** Whether anything is waiting to be delivered — for tests that wait for the streams to settle. */
export function contestEventsPending(): boolean {
  return scheduled
}
