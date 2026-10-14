/**
 * What a run came to, home's: written down, its files PUT, its outcome
 * posted (docs/architecture/remote-runners.md §2 step 6, §3.6).
 *
 * IN THIS ORDER, AND EACH STEP SURVIVES A RESTART. The outcome is assembled
 * from the Docker runner's own RunOutcome (remoteOutcome: what a forged
 * run.json could make of it is made whole and cut to the caps) and written
 * down (outcome.json) before a byte goes out: a machine that dies while
 * uploading sends the very same outcome when it comes back, and home answers
 * a repeat with the reply it cached for its digest. Then the answer
 * (submission.csv, only with a run that succeeded: home scores nothing else)
 * and the executed notebook (with every run that left one, the blind ones
 * too: the teacher downloads it) go up gzipped and side by side, each with its
 * own sha256 and length uncompressed; then the outcome.
 *
 * A TRANSIENT ANSWER IS ASKED AGAIN, A REFUSAL IS FINAL. Through a relay
 * restart, frps's 504 and home's 503 (uploads at their limit) the agent backs
 * off and tries again for as long as it holds the lease, and never drops it
 * over one. A 409 (`revoked`: the attempt was cancelled, erased or lost;
 * `conflict`: home settled it otherwise) and a 404 mean home has no use for
 * it: the attempt is discarded and nothing more is sent about it. A 401 is the
 * machine revoked, which the agent handles whole (sync.ts). Home's reply to
 * the outcome — applied, refused or revoked — ends the attempt the same way,
 * and may carry the next lease.
 */
import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { createGzip } from 'node:zlib'
import { pipeline } from 'node:stream/promises'
import {
  REMOTE_FILE_BYTES,
  REMOTE_PROTOCOL,
  REMOTE_RUN_JSON_BYTES,
  remoteOutcome,
  type RemoteFileName,
  type RemoteFree,
  type RemoteOutcomeReply,
  type RemoteOutcomeRequest,
  type RemoteResultFile,
} from '@shared/remote-runner'
import { EXECUTED_FILE, SUBMISSION_FILE } from '../competitions/storage.js'
import type { RunOutcome } from '../competitions/runner-port.js'
import { Backoff, type RemoteClient } from './client.js'
import type { RunCard } from './execute.js'
import type { StoredOutcome } from './state.js'

/**
 * The finished outcome as it travels, assembled from the runner's own (see
 * the header). `produced` is whether the answer was written at all, which home
 * cannot see from where it is; `crowded` and `card` are the machine's (§5.5).
 */
export async function assembleOutcome(input: {
  outcome: RunOutcome
  resultDir: string
  card: RunCard | null
  crowded: boolean
  startedAt: number
  endedAt: number
}): Promise<Extract<StoredOutcome, { kind: 'finished' }>> {
  const { outcome, resultDir } = input
  const produced = regularFile(path.join(resultDir, SUBMISSION_FILE)) !== null
  const remote = remoteOutcome({
    status: outcome.status,
    cell: outcome.cell,
    cells: outcome.cells,
    wall: outcome.wall,
    detail: outcome.detail,
    log: outcome.log,
    ...(outcome.dependencyFailure ? { dependencyFailure: outcome.dependencyFailure } : {}),
    diagnostics: outcome.diagnostics,
    produced,
    crowded: input.crowded,
    card: input.card ? { device: input.card.device, perDevice: input.card.perDevice, sliceMb: input.card.sliceMb } : null,
  })
  const runJsonFile = regularFile(path.join(resultDir, 'run.json'))
  const runJson = runJsonFile !== null && runJsonFile.size <= REMOTE_RUN_JSON_BYTES ? fs.readFileSync(path.join(resultDir, 'run.json')).toString('base64') : null
  const files: RemoteResultFile[] = []
  // The answer only with a run that succeeded and wrote it; the executed notebook whenever there is one.
  if (remote.status === 'ok' && produced) files.push(await describe(resultDir, SUBMISSION_FILE))
  const executed = regularFile(path.join(resultDir, EXECUTED_FILE))
  if (executed !== null && executed.size <= REMOTE_FILE_BYTES) files.push(await describe(resultDir, EXECUTED_FILE))
  return { kind: 'finished', outcome: remote, runJson, files, startedAt: input.startedAt, endedAt: input.endedAt }
}

/** A file's length and sha256, as it is before gzip. */
async function describe(dir: string, name: RemoteFileName): Promise<RemoteResultFile> {
  const hash = createHash('sha256')
  let bytes = 0
  for await (const chunk of fs.createReadStream(path.join(dir, name))) {
    bytes += (chunk as Buffer).length
    hash.update(chunk as Buffer)
  }
  return { name, bytes, sha256: hash.digest('hex') }
}

function regularFile(file: string): fs.Stats | null {
  try {
    const stat = fs.lstatSync(file)
    return stat.isFile() ? stat : null
  } catch {
    return null
  }
}

/** A result file gzipped beside the attempt's folders, for its PUT (and again after a restart: gzip is cheap). */
export interface Gzipped {
  name: RemoteFileName
  path: string
  sha256: string
  bytes: number
}

/** The attempt's files gzipped into `into`, each checked against what the outcome says of it. */
export async function gzipResults(resultDir: string, files: readonly RemoteResultFile[], into: string): Promise<Gzipped[]> {
  fs.mkdirSync(into, { recursive: true, mode: 0o700 })
  const done: Gzipped[] = []
  for (const file of files) {
    const target = path.join(into, `${file.name}.gz`)
    await pipeline(fs.createReadStream(path.join(resultDir, file.name)), createGzip(), fs.createWriteStream(target, { mode: 0o600 }))
    done.push({ name: file.name, path: target, sha256: file.sha256, bytes: file.bytes })
  }
  return done
}

/** How an attempt's delivery ended. `discarded`: home has no use for it (409, 404, or a refusal no retry changes). */
export type Delivery = RemoteOutcomeReply['result'] | 'discarded' | 'unauthorized' | 'stopped'

export interface DeliverInput {
  client: Pick<RemoteClient, 'upload' | 'outcome'>
  build: string
  attemptId: string
  stored: StoredOutcome
  uploads: readonly Gzipped[]
  /** What the machine can take now, for the reply's next lease. */
  free: () => RemoteFree
  /** Aborted when the attempt needs nothing more sent (revoked, applied by a sync) or the agent stops. */
  signal: AbortSignal
  /** Home's reply to the outcome, before the delivery says how it ended: it may carry the next lease. */
  onReply: (reply: RemoteOutcomeReply) => void
  backoff?: () => Backoff
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>
  log?: (line: string) => void
}

/** The files, side by side, then the outcome; each through every transient answer (the header). */
export async function deliver(input: DeliverInput): Promise<Delivery> {
  const sleep = input.sleep ?? wait
  const backoff = input.backoff ?? (() => new Backoff())
  // A file home refuses for good (a 409, a 401) ends its sibling too: it would otherwise retry a hiccup forever for nothing.
  const over = new AbortController()
  const files = { ...input, signal: AbortSignal.any([input.signal, over.signal]) }
  const ends = await Promise.all(input.uploads.map(async (file) => {
    const end = await put(files, file, backoff(), sleep)
    if (end === 'discarded' || end === 'unauthorized') over.abort()
    return end
  }))
  for (const end of ['unauthorized', 'discarded', 'stopped'] as const) if (ends.includes(end)) return end
  const tries = backoff()
  for (;;) {
    if (input.signal.aborted) return 'stopped'
    const stored = input.stored
    const body: RemoteOutcomeRequest = stored.kind === 'finished'
      ? { protocol: REMOTE_PROTOCOL, build: input.build, free: input.free(), kind: 'finished', outcome: stored.outcome, runJson: stored.runJson, files: stored.files }
      : { protocol: REMOTE_PROTOCOL, build: input.build, free: input.free(), kind: 'declined', reason: stored.reason, detail: stored.detail }
    const answer = await input.client.outcome(input.attemptId, body, input.signal)
    if (answer.kind === 'ok') {
      input.onReply(answer.value)
      return answer.value.result
    }
    if (answer.kind === 'refused') {
      if (answer.error === 'unauthorized') return 'unauthorized'
      input.log?.(`[runner] home refused the outcome of ${input.attemptId.slice(0, 8)}: ${answer.error}${answer.detail ? ` (${answer.detail})` : ''}; it is discarded`)
      return 'discarded'
    }
    if (input.signal.aborted) return 'stopped'
    await sleep(tries.next(answer.retryAfterMs), input.signal)
  }
}

async function put(input: DeliverInput, file: Gzipped, tries: Backoff, sleep: (ms: number, signal: AbortSignal) => Promise<void>): Promise<'ok' | 'skipped' | 'discarded' | 'unauthorized' | 'stopped'> {
  for (;;) {
    if (input.signal.aborted) return 'stopped'
    const answer = await input.client.upload(input.attemptId, file.name, file.path, { sha256: file.sha256, bytes: file.bytes }, input.signal)
    if (answer.kind === 'ok') {
      const kept = answer.value
      if (kept.name !== file.name || kept.sha256 !== file.sha256 || kept.bytes !== file.bytes) {
        input.log?.(`[runner] home kept ${file.name} of ${input.attemptId.slice(0, 8)} as something else; the outcome says what it holds`)
        return 'skipped'
      }
      return 'ok'
    }
    if (answer.kind === 'refused') {
      if (answer.error === 'unauthorized') return 'unauthorized'
      if (answer.error === 'revoked' || answer.error === 'conflict' || answer.error === 'not_found') return 'discarded'
      // Too large, a mismatch, a body home cannot read: no retry changes it, and home refuses the outcome without the file.
      input.log?.(`[runner] home refused ${file.name} of ${input.attemptId.slice(0, 8)}: ${answer.error}${answer.detail ? ` (${answer.detail})` : ''}`)
      return 'skipped'
    }
    if (input.signal.aborted) return 'stopped'
    await sleep(tries.next(answer.retryAfterMs), input.signal)
  }
}

/** A wait that ends early when the signal aborts. */
export function wait(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve()
    const timer = setTimeout(done, ms)
    function done(): void {
      clearTimeout(timer)
      signal?.removeEventListener('abort', done)
      resolve()
    }
    signal?.addEventListener('abort', done, { once: true })
  })
}
