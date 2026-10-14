/**
 * The machines that run this server's submissions («машины для посылок»,
 * docs/architecture/remote-runners.md §5.1, §6): their rows, the owner's
 * enrollment codes, the leases and the events — and nothing that decides
 * what a lease means (lease.ts), when a machine counts as gone
 * (liveness.ts) or what travels on the wire (routes.ts).
 *
 * THE SCHEMA IS HERE, with one owner, as competitions/store.ts keeps its
 * own: no other module writes these tables. And NO REVISION TRIGGERS on any
 * of them. A competition's `revision` is what wakes every open console and
 * participant page (store.ts · revisionTriggers), and a machine's heartbeat
 * every ten seconds, a lease's phase or a log line would wake them all for
 * nothing that is theirs. What a console must see of a lease reaches it
 * through the queue row, which has its triggers already: the take, the
 * started_at a container's start moves, the flip to a metric row.
 *
 * LIVENESS IS NOT A COLUMN. When a machine was last heard lives in memory
 * (liveness.ts), on this server's clock, and last_seen_at is only its echo,
 * written at most once a minute (REMOTE_SEEN_FLUSH_MS): ten machines syncing
 * every ten seconds would otherwise be a write a second for a number nobody
 * reads until the process restarts.
 *
 * SECRETS ARE NEVER STORED, ONLY THEIR SHA256. A machine's secret (256 bits)
 * and the owner's enrollment code (128 bits) are random, so a plain sha256 is
 * as good as any key derivation: there is nothing to guess from. A leaked
 * database therefore opens no machine's door and enrolls no machine, and the
 * code exists in clear exactly once — in the answer that minted it.
 */
import { createHash, randomBytes, randomInt, timingSafeEqual } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { db } from '../../db.js'
import { COLLOQ_VERSION } from '../../version.js'
import {
  REMOTE_ATTEMPTS_MAX,
  REMOTE_BUILD_DEV,
  REMOTE_BUILD_FILE,
  REMOTE_CODE_TTL_MAX_MS,
  REMOTE_EVENTS_KEEP_MS,
  REMOTE_JOIN_REPEAT_MS,
  REMOTE_LEASES_KEEP_MS,
  REMOTE_PER_DEVICE_MAX,
  REMOTE_REASON_CHARS,
  REMOTE_RUNNER_ID,
  REMOTE_SECRET,
  REMOTE_VERSION,
  parseRemoteBuildFile,
  remoteText,
  type RemoteAttemptPhase,
  type RemoteCard,
  type RemoteDataFile,
  type RemoteFacts,
  type RemoteStepLimits,
} from '@shared/remote-runner'
import type { RemoteEventKind } from '@shared/remote-admin'

/* ----------------------------------------------------------------- schema */

db.exec(`
  /*
   * A machine. \`state\` is the owner's word and the machine's own leave:
   * active, draining (the owner's «Осушить», or a quarantine), revoked (the
   * owner's «Отключить»: its secret is refused from then on), left (it revoked
   * itself on colloq-host runner leave). Whether it is heard, outdated or
   * silent is worked out on this server's clock (liveness.ts), never stored.
   */
  CREATE TABLE IF NOT EXISTS remote_runners (
    id             TEXT PRIMARY KEY,
    name           TEXT NOT NULL,
    secret_sha256  TEXT NOT NULL,
    join_id        TEXT UNIQUE,
    trusted        INTEGER NOT NULL DEFAULT 0,
    approved_slots INTEGER,
    per_device     INTEGER,
    state          TEXT NOT NULL DEFAULT 'active',
    build          TEXT,
    version        TEXT,
    facts          TEXT NOT NULL DEFAULT '{}',
    created_by     TEXT NOT NULL,
    created_at     INTEGER NOT NULL,
    revoked_at     INTEGER,
    last_seen_at   INTEGER,
    last_address   TEXT,
    offer_seq      INTEGER NOT NULL DEFAULT 0
  );

  /* The owner's enrollment codes: a code is a door, kept by its sha256 alone. */
  CREATE TABLE IF NOT EXISTS remote_runner_codes (
    code_sha256    TEXT PRIMARY KEY,
    created_by     TEXT NOT NULL,
    created_at     INTEGER NOT NULL,
    expires_at     INTEGER NOT NULL,
    uses_left      INTEGER NOT NULL,
    trusted        INTEGER NOT NULL DEFAULT 0,
    approved_slots INTEGER,
    name_prefix    TEXT NOT NULL
  );

  /*
   * One attempt of one submission on one machine, keyed by the queue's own
   * attempt_id. Kept a week (REMOTE_LEASES_KEEP_MS): the machine's page counts
   * its losses and declines from here, and a late upload or outcome is told
   * apart from an unknown one by it.
   */
  CREATE TABLE IF NOT EXISTS remote_leases (
    attempt_id     TEXT PRIMARY KEY,
    runner_id      TEXT NOT NULL,
    competition_id TEXT NOT NULL,
    submission_id  TEXT NOT NULL,
    run_id         TEXT NOT NULL,
    state          TEXT NOT NULL,
    seq            INTEGER NOT NULL,
    sealed         INTEGER NOT NULL,
    code_cells     INTEGER,
    provenance     TEXT NOT NULL,
    manifest       TEXT NOT NULL,
    container      TEXT NOT NULL,
    device         TEXT,
    per_device     INTEGER,
    slice_mb       INTEGER,
    offered_at     INTEGER NOT NULL,
    accepted_at    INTEGER,
    started_at     INTEGER,
    ended_at       INTEGER,
    deadline_at    INTEGER NOT NULL,
    outcome_sha256 TEXT,
    reply          TEXT,
    reason         TEXT
  );
  CREATE INDEX IF NOT EXISTS remote_leases_runner ON remote_leases(runner_id, state);
  CREATE INDEX IF NOT EXISTS remote_leases_submission ON remote_leases(submission_id, offered_at);

  /* What happened to a machine, kept three months (REMOTE_EVENTS_KEEP_MS): the machine's log (M3). */
  CREATE TABLE IF NOT EXISTS remote_events (
    id         INTEGER PRIMARY KEY,
    at         INTEGER NOT NULL,
    runner_id  TEXT NOT NULL,
    attempt_id TEXT,
    kind       TEXT NOT NULL,
    address    TEXT,
    detail     TEXT
  );
  CREATE INDEX IF NOT EXISTS remote_events_runner ON remote_events(runner_id, at);
`)

/** A column that does not exist yet (the same helper as store.ts and db.ts keep for their tables). */
function ensureColumn(table: string, column: string, definition: string): void {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]
  if (columns.some((c) => c.name === column)) return
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${definition}`)
}
/*
 * Beyond §5.1, each for a reason the design's columns could not carry.
 *
 * remote_runners.code_sha256 — the code a machine joined with: a repeated
 * join (its first reply was lost) must bring the same code as well as the
 * same joinId, and the dialog's «ждём первую машину…» counts the machines
 * each code enrolled. cards — the cards of its last sync: the GPU door
 * (decision 8) asks whether a machine with cards was seen within the hour,
 * and after a restart of this server memory knows nothing of the hour
 * before. quarantined_at / quarantine_seen — the banner: home drained it for
 * its losses or declines, and the owner has not looked yet.
 *
 * remote_runner_codes.machines — how many it was minted for, so the dialog
 * can say "2 of 3 joined" after uses_left has moved.
 *
 * remote_leases.prepared — what settles the run when its outcome comes back,
 * minutes or hours later and maybe to the next life of this server
 * (§13b note 11): the hidden files by name as they were when the step began,
 * and the submission's numbers from before the run, which the neighbour-OOM
 * retry puts back. phase — where the machine last said the attempt was, for
 * the console's «готовится» before its container starts. outcome — the
 * outcome as it was applied, so that a crash between moving its files and
 * the commit is re-driven at boot from the row alone (§3.6).
 */
ensureColumn('remote_runners', 'code_sha256', 'code_sha256 TEXT')
ensureColumn('remote_runners', 'cards', "cards TEXT NOT NULL DEFAULT '[]'")
ensureColumn('remote_runners', 'quarantined_at', 'quarantined_at INTEGER')
ensureColumn('remote_runners', 'quarantine_seen', 'quarantine_seen INTEGER NOT NULL DEFAULT 0')
ensureColumn('remote_runner_codes', 'machines', 'machines INTEGER NOT NULL DEFAULT 1')
ensureColumn('remote_leases', 'prepared', "prepared TEXT NOT NULL DEFAULT '{}'")
ensureColumn('remote_leases', 'phase', 'phase TEXT')
ensureColumn('remote_leases', 'outcome', 'outcome TEXT')
/*
 * remote_leases.cause — why a lease ended without its outcome, as a word the
 * code reads (LeaseCause), next to `reason`, the sentence the panel shows:
 * the console says «вернулась: vast-1 замолчала» for a run lost to a silence
 * and «вернулась: отказалась» for a decline (WaitingRow.returnedWhy), and a
 * sentence in whatever language was in force then is no word to match on.
 */
ensureColumn('remote_leases', 'cause', 'cause TEXT')

/* ----------------------------------------------------------------- hashes */

export const sha256 = (text: string | Buffer): string => createHash('sha256').update(text).digest('hex')

/**
 * Two hex digests compared in constant time: equal lengths whatever was sent
 * (a digest is always 32 bytes), so neither the bytes nor how many of them
 * match leak through how long a wrong guess takes.
 */
function sameDigest(a: string, b: string): boolean {
  const x = Buffer.from(a, 'hex')
  const y = Buffer.from(b, 'hex')
  return x.length === 32 && y.length === 32 && timingSafeEqual(x, y)
}

/* ----------------------------------------------------------- home's build */

/**
 * The runner build this home hands work to (decision 5): the sha256 of
 * dist/runner.js, in dist/runner.sha256 next to the bundle this server runs
 * from (server/scripts/runner-sha256.mjs writes it). Under make dev and in
 * the tests the server runs from its sources and there is no bundle: it
 * reports REMOTE_BUILD_DEV, which only a machine started the same way
 * matches. A built server without the file (a build that skipped the
 * runner) answers '' — no build at all, so no machine is compatible, which
 * is the safe way to be wrong: «устарела» on the panel, rather than work
 * handed to a machine whose sandbox nobody compared with this one.
 */
let homeBuild: string | null = null

export function homeRunnerBuild(): string {
  if (homeBuild !== null) return homeBuild
  const here = fileURLToPath(import.meta.url)
  if (here.endsWith('.ts')) {
    homeBuild = REMOTE_BUILD_DEV
    return homeBuild
  }
  try {
    homeBuild = parseRemoteBuildFile(fs.readFileSync(path.join(path.dirname(here), REMOTE_BUILD_FILE), 'utf8')) ?? ''
  } catch {
    homeBuild = ''
  }
  if (homeBuild === '') console.warn(`[runners] no ${REMOTE_BUILD_FILE} next to the server: no machine will be given work`)
  return homeBuild
}

/** For tests: the build this home compares machines with; `null` reads it again. */
export function useHomeRunnerBuild(build: string | null): void {
  homeBuild = build
}

/** Home's release as the sync reply names it (REMOTE_VERSION): «устарела: на ней 0.23.0, на сервере 0.24.0». */
export function homeVersion(): string {
  return REMOTE_VERSION.test(COLLOQ_VERSION) ? COLLOQ_VERSION : '0.0.0-dev'
}

/* ---------------------------------------------------------------- machines */

export type RunnerDbState = 'active' | 'draining' | 'revoked' | 'left'

export interface RunnerRow {
  id: string
  name: string
  joinId: string | null
  codeSha256: string | null
  trusted: boolean
  /** The owner's cap on its places; null — what it offers. */
  approvedSlots: number | null
  /** Runs per card for this machine; null — the instance's «Посылок на карту». */
  perDevice: number | null
  state: RunnerDbState
  build: string | null
  version: string | null
  facts: RemoteFacts | null
  /** The cards of its last sync, as it reported them. */
  cards: RemoteCard[]
  createdBy: string
  createdAt: number
  revokedAt: number | null
  lastSeenAt: number | null
  lastAddress: string | null
  offerSeq: number
  quarantinedAt: number | null
  quarantineSeen: boolean
}

interface RunnerRaw {
  id: string
  name: string
  secret_sha256: string
  join_id: string | null
  code_sha256: string | null
  trusted: number
  approved_slots: number | null
  per_device: number | null
  state: string
  build: string | null
  version: string | null
  facts: string
  cards: string
  created_by: string
  created_at: number
  revoked_at: number | null
  last_seen_at: number | null
  last_address: string | null
  offer_seq: number
  quarantined_at: number | null
  quarantine_seen: number
}

function parsed<T>(text: string | null | undefined, fallback: T): T {
  if (!text) return fallback
  try {
    return JSON.parse(text) as T
  } catch {
    return fallback
  }
}

function toRunner(row: RunnerRaw): RunnerRow {
  const facts = parsed<Partial<RemoteFacts>>(row.facts, {})
  return {
    id: row.id,
    name: row.name,
    joinId: row.join_id,
    codeSha256: row.code_sha256,
    trusted: row.trusted === 1,
    approvedSlots: row.approved_slots,
    perDevice: row.per_device,
    state: (['active', 'draining', 'revoked', 'left'].includes(row.state) ? row.state : 'revoked') as RunnerDbState,
    build: row.build,
    version: row.version,
    facts: typeof facts.version === 'string' ? (facts as RemoteFacts) : null,
    cards: parsed<RemoteCard[]>(row.cards, []),
    createdBy: row.created_by,
    createdAt: row.created_at,
    revokedAt: row.revoked_at,
    lastSeenAt: row.last_seen_at,
    lastAddress: row.last_address,
    offerSeq: row.offer_seq,
    quarantinedAt: row.quarantined_at,
    quarantineSeen: row.quarantine_seen === 1,
  }
}

const selectRunner = db.prepare('SELECT * FROM remote_runners WHERE id = ?')
const selectRunners = db.prepare('SELECT * FROM remote_runners ORDER BY created_at, id')
const selectByJoin = db.prepare('SELECT * FROM remote_runners WHERE join_id = ?')

export function getRunner(id: string): RunnerRow | null {
  const row = selectRunner.get(id) as RunnerRaw | undefined
  return row ? toRunner(row) : null
}

export function listRunners(): RunnerRow[] {
  return (selectRunners.all() as RunnerRaw[]).map(toRunner)
}

/** Whether a machine was ever connected: until then every screen stays as it was before machines. */
export function anyRunnerEver(): boolean {
  return db.prepare('SELECT 1 FROM remote_runners LIMIT 1').get() !== undefined
}

/** A machine still allowed to call: neither revoked by the owner nor gone on its own. */
export function runnerStanding(runner: Pick<RunnerRow, 'state'> | null): boolean {
  return runner !== null && (runner.state === 'active' || runner.state === 'draining')
}

/**
 * The machine a credential names, if the secret is its own and it may still
 * call; `null` otherwise — an unknown id, a wrong secret, a revoked or a gone
 * machine all read the same, 401. The secret is compared as sha256 digests in
 * constant time.
 */
export function authenticateRunner(runnerId: string, secret: string): RunnerRow | null {
  if (!REMOTE_RUNNER_ID.test(runnerId) || !REMOTE_SECRET.test(secret)) return null
  const row = selectRunner.get(runnerId) as RunnerRaw | undefined
  // The comparison runs even for an unknown id, against a digest of nothing: the same time either way.
  const ok = sameDigest(sha256(secret), row?.secret_sha256 ?? sha256(''))
  if (!row || !ok) return null
  const runner = toRunner(row)
  return runnerStanding(runner) ? runner : null
}

export interface RunnerPatch {
  name?: string
  approvedSlots?: number | null
  perDevice?: number | null
  trusted?: boolean
  state?: RunnerDbState
  build?: string | null
  version?: string | null
  facts?: RemoteFacts
  cards?: RemoteCard[]
  revokedAt?: number | null
  quarantinedAt?: number | null
  quarantineSeen?: boolean
}

const RUNNER_COLUMN: Record<keyof RunnerPatch, string> = {
  name: 'name',
  approvedSlots: 'approved_slots',
  perDevice: 'per_device',
  trusted: 'trusted',
  state: 'state',
  build: 'build',
  version: 'version',
  facts: 'facts',
  cards: 'cards',
  revokedAt: 'revoked_at',
  quarantinedAt: 'quarantined_at',
  quarantineSeen: 'quarantine_seen',
}

export function updateRunner(id: string, patch: RunnerPatch): RunnerRow | null {
  const sets: string[] = []
  const params: Record<string, unknown> = { id }
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) continue
    const column = RUNNER_COLUMN[key as keyof RunnerPatch]
    sets.push(`${column} = @${column}`)
    params[column] = typeof value === 'boolean' ? (value ? 1 : 0) : key === 'facts' || key === 'cards' ? JSON.stringify(value) : value
  }
  if (sets.length > 0) db.prepare(`UPDATE remote_runners SET ${sets.join(', ')} WHERE id = @id`).run(params)
  return getRunner(id)
}

/** last_seen_at and the address, written at most once a minute by liveness.ts (REMOTE_SEEN_FLUSH_MS). */
export function flushRunnerSeen(id: string, at: number, address: string | null): void {
  db.prepare('UPDATE remote_runners SET last_seen_at = ?, last_address = COALESCE(?, last_address) WHERE id = ?').run(at, address, id)
}

/**
 * The next offer's number for a machine, inside the take's transaction: a
 * machine acks offers by number (RemoteSyncRequest.seq), so two offers must
 * never share one, and the counter survives restarts with the machine.
 */
export function nextOfferSeq(id: string): number {
  db.prepare('UPDATE remote_runners SET offer_seq = offer_seq + 1 WHERE id = ?').run(id)
  return (db.prepare('SELECT offer_seq FROM remote_runners WHERE id = ?').get(id) as { offer_seq: number } | undefined)?.offer_seq ?? 0
}

/* ------------------------------------------------------- enrollment codes */

/**
 * How many machines one code enrolls. colloq-host runner-code takes up to a
 * hundred (a fleet for an exam), the panel's dialog offers fewer; one bound
 * for both doors, so the code the console mints is never refused by the
 * function the panel uses.
 */
export const REMOTE_CODE_MACHINES_MAX = 100

/** A machine's name: what the owner reads and edits; the prefix a code gives the machines it enrolls. */
export const RUNNER_NAME_CHARS = 64
export const RUNNER_PREFIX = /^[A-Za-z0-9][A-Za-z0-9-]{0,31}$/

export interface MintCode {
  machines: number
  hours: number
  trusted: boolean
  approvedSlots: number | null
  namePrefix?: string | null
  /** The staff member, or `colloq-host` for a code minted on the instance's console (ops/runner-code.ts). */
  createdBy: string
}

export interface MintedCode {
  /** 128 random bits in hex (REMOTE_JOIN_CODE): shown once, inside the join commands, and never stored. */
  code: string
  expiresAt: number
  machines: number
  trusted: boolean
  approvedSlots: number | null
}

export type MintRefusal = 'machines' | 'hours' | 'slots' | 'prefix'

/** Why a code cannot be minted as asked; `null` — it can. The same bounds for the panel and the console. */
export function mintRefusal(input: Pick<MintCode, 'machines' | 'hours' | 'approvedSlots' | 'namePrefix'>): MintRefusal | null {
  if (!Number.isSafeInteger(input.machines) || input.machines < 1 || input.machines > REMOTE_CODE_MACHINES_MAX) return 'machines'
  if (!Number.isSafeInteger(input.hours) || input.hours < 1 || input.hours * 60 * 60_000 > REMOTE_CODE_TTL_MAX_MS) return 'hours'
  if (input.approvedSlots !== null && (!Number.isSafeInteger(input.approvedSlots) || input.approvedSlots < 1 || input.approvedSlots > REMOTE_ATTEMPTS_MAX)) return 'slots'
  if (input.namePrefix && !RUNNER_PREFIX.test(input.namePrefix)) return 'prefix'
  return null
}

/**
 * Mint an enrollment code: good for `machines` joins within `hours` (at most
 * a day: a code is a door, and a door left open is found), carrying the
 * trusted flag and the slot cap to every machine it enrolls. The ONE way a
 * code is made — the owner's dialog (routes/admin-runners.ts) and the
 * instance's console (ops/runner-code.ts) both call it — and the code itself
 * leaves only in its return value; the row keeps its sha256.
 */
export function mintRemoteCode(input: MintCode, now = Date.now()): MintedCode {
  const refusal = mintRefusal(input)
  if (refusal) throw new Error(`Invalid enrollment code request: ${refusal}`)
  const code = randomBytes(16).toString('hex')
  const expiresAt = now + input.hours * 60 * 60_000
  db.prepare(`INSERT INTO remote_runner_codes
      (code_sha256, created_by, created_at, expires_at, uses_left, trusted, approved_slots, name_prefix, machines)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    sha256(code), input.createdBy, now, expiresAt, input.machines, input.trusted ? 1 : 0, input.approvedSlots, input.namePrefix ?? '', input.machines,
  )
  return { code, expiresAt, machines: input.machines, trusted: input.trusted, approvedSlots: input.approvedSlots }
}

export interface CodeRow {
  codeSha256: string
  createdBy: string
  createdAt: number
  expiresAt: number
  usesLeft: number
  machines: number
  trusted: boolean
  approvedSlots: number | null
  namePrefix: string
}

interface CodeRaw {
  code_sha256: string
  created_by: string
  created_at: number
  expires_at: number
  uses_left: number
  machines: number
  trusted: number
  approved_slots: number | null
  name_prefix: string
}

const toCode = (row: CodeRaw): CodeRow => ({
  codeSha256: row.code_sha256,
  createdBy: row.created_by,
  createdAt: row.created_at,
  expiresAt: row.expires_at,
  usesLeft: row.uses_left,
  machines: row.machines,
  trusted: row.trusted === 1,
  approvedSlots: row.approved_slots,
  namePrefix: row.name_prefix,
})

/** Codes still good (not expired, not used up), newest first: the dialog's «ждём первую машину…». */
export function liveCodes(now = Date.now()): CodeRow[] {
  return (db.prepare('SELECT * FROM remote_runner_codes WHERE expires_at > ? AND uses_left > 0 ORDER BY created_at DESC').all(now) as CodeRaw[]).map(toCode)
}

/** Every code, for counting what each enrolled (the dialog asks after the last use too). */
export function codeBySha(codeSha256: string): CodeRow | null {
  const row = db.prepare('SELECT * FROM remote_runner_codes WHERE code_sha256 = ?').get(codeSha256) as CodeRaw | undefined
  return row ? toCode(row) : null
}

/** How many machines a code has enrolled so far. */
export function codeJoins(codeSha256: string): number {
  return (db.prepare('SELECT COUNT(*) AS n FROM remote_runners WHERE code_sha256 = ?').get(codeSha256) as { n: number }).n
}

/* ---------------------------------------------------------------- joining */

export type JoinOutcome =
  | { ok: true; runner: RunnerRow; secret: string; repeated: boolean }
  | { ok: false; why: 'code' }

const ID_ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789'

/** Eight letters read aloud, as a competition's id (store.ts · newId): REMOTE_RUNNER_ID. */
function newRunnerId(): string {
  let out = ''
  for (let i = 0; i < 8; i++) out += ID_ALPHABET[randomInt(0, ID_ALPHABET.length)]
  return out
}

/**
 * The name a newly joined machine gets: the code's prefix and its number
 * among the machines of that prefix («vast-4090-3»), or what the machine
 * calls itself, cut to a name. The owner renames it on its page; the name
 * is never parsed, only shown.
 */
function runnerName(prefix: string, facts: RemoteFacts): string {
  if (prefix) {
    const taken = (db.prepare("SELECT COUNT(*) AS n FROM remote_runners WHERE name LIKE ? ESCAPE '\\'").get(`${prefix.replace(/[\\%_]/g, '\\$&')}-%`) as { n: number }).n
    return `${prefix}-${taken + 1}`
  }
  const host = facts.hostname.replace(/[^\p{L}\p{N}._-]+/gu, '-').replace(/^-+|-+$/g, '').slice(0, 40)
  return host || 'machine'
}

/**
 * A machine joins with the owner's code (POST join, routes.ts).
 *
 * In one transaction, so two machines on the last use of a code cannot both
 * get in. A machine whose first reply was lost asks again with the same
 * joinId: within REMOTE_JOIN_REPEAT_MS, and with the same code, it is the
 * same machine and gets a new secret (the one in the lost reply is replaced,
 * so a copy of it read on the way opens nothing) without spending another
 * use of the code, even one used up by that very join. Anything else needs a
 * code that is known, not expired and not used up.
 */
export const joinRunner = db.transaction((input: { code: string; joinId: string; build: string; facts: RemoteFacts; address: string | null }, now: number): JoinOutcome => {
  const codeSha = sha256(input.code)
  const secret = randomBytes(32).toString('hex')
  const earlier = selectByJoin.get(input.joinId) as RunnerRaw | undefined
  if (earlier) {
    const runner = toRunner(earlier)
    const same = earlier.code_sha256 !== null && sameDigest(earlier.code_sha256, codeSha)
    if (!same || now - earlier.created_at > REMOTE_JOIN_REPEAT_MS || !runnerStanding(runner)) return { ok: false, why: 'code' }
    db.prepare('UPDATE remote_runners SET secret_sha256 = ?, build = ?, version = ?, facts = ?, last_seen_at = ?, last_address = COALESCE(?, last_address) WHERE id = ?')
      .run(sha256(secret), input.build, input.facts.version, JSON.stringify(input.facts), now, input.address, runner.id)
    return { ok: true, runner: getRunner(runner.id)!, secret, repeated: true }
  }
  const code = db.prepare('SELECT * FROM remote_runner_codes WHERE code_sha256 = ?').get(codeSha) as CodeRaw | undefined
  if (!code || code.expires_at <= now || code.uses_left <= 0) return { ok: false, why: 'code' }
  db.prepare('UPDATE remote_runner_codes SET uses_left = uses_left - 1 WHERE code_sha256 = ?').run(codeSha)
  const name = runnerName(code.name_prefix, input.facts)
  for (let tries = 0; tries < 8; tries++) {
    const id = newRunnerId()
    if (selectRunner.get(id)) continue
    db.prepare(`INSERT INTO remote_runners
        (id, name, secret_sha256, join_id, code_sha256, trusted, approved_slots, state, build, version, facts,
         created_by, created_at, last_seen_at, last_address)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?, ?, ?, ?, ?)`).run(
      id, name, sha256(secret), input.joinId, codeSha, code.trusted, code.approved_slots, input.build, input.facts.version,
      JSON.stringify(input.facts), code.created_by, now, now, input.address,
    )
    return { ok: true, runner: getRunner(id)!, secret, repeated: false }
  }
  throw new Error('Could not mint a unique machine id')
})

/** The machine revoked itself (colloq-host runner leave): its secret is refused from now on. */
export function markRunnerLeft(id: string, now = Date.now()): void {
  db.prepare("UPDATE remote_runners SET state = 'left', revoked_at = ? WHERE id = ? AND state IN ('active', 'draining')").run(now, id)
}

/* ------------------------------------------------------------------ leases */

/**
 * A lease's states (§3.4): offered → accepted → running → applying →
 * applied, or out of that path as withdrawn (never acked), declined (the
 * machine refused it), lost (home gave up on it) or revoked (a cancel, an
 * erase, a deletion, the machine revoked). The first four are LIVE: the
 * machine holds the attempt, or is about to.
 */
export type LeaseState = 'offered' | 'accepted' | 'running' | 'applying' | 'applied' | 'withdrawn' | 'declined' | 'lost' | 'revoked'
export const LIVE_LEASE_STATES: readonly LeaseState[] = ['offered', 'accepted', 'running', 'applying']
/** Live and not yet being applied: what a cancel, a loss or a silence may still end. */
export const OPEN_LEASE_STATES: readonly LeaseState[] = ['offered', 'accepted', 'running']

/** What the take wrote down about the run, everything the offer is built from and repeated by. */
export interface LeaseManifest {
  revision: { id: string; ref: string; layers: string }
  harness: string
  limits: RemoteStepLimits
  gpu: boolean
  /** Runs per card, pinned at the take (§5.5); null without a card. */
  perDevice: number | null
  data: { manifest: string; files: RemoteDataFile[] }
  sealed: { manifest: string; files: RemoteDataFile[] } | null
  notebook: { sha256: string; bytes: number }
  bundle: { id: string; packagesMb: number } | null
}

/** What settling the outcome needs that is not in the database any more by then (§13b note 11). */
export interface LeasePrepared {
  sealedFiles: string[]
  before: { cellsDone: number; cellsTotal: number; durationMs: number | null }
}

export interface LeaseProvenance {
  inputRevision: number | null
  notebookInputRevision: number | null
}

export interface LeaseRow {
  attemptId: string
  runnerId: string
  competitionId: string
  submissionId: string
  runId: string
  state: LeaseState
  seq: number
  sealed: boolean
  codeCells: number | null
  provenance: LeaseProvenance
  manifest: LeaseManifest
  prepared: LeasePrepared
  container: string
  device: string | null
  perDevice: number | null
  sliceMb: number | null
  phase: RemoteAttemptPhase | null
  offeredAt: number
  acceptedAt: number | null
  startedAt: number | null
  endedAt: number | null
  deadlineAt: number
  outcomeSha256: string | null
  /** The outcome as it was applied (the request without `free`), for the re-drive. */
  outcome: unknown
  reply: { result: 'applied' | 'refused' | 'revoked' } | null
  reason: string | null
  cause: LeaseCause | null
}

/**
 * Why a lease ended without its outcome. Losses: `silent`, `ceiling`,
 * `missing`, `refused`, `declined` (a refusal after its container started).
 * Withdrawals: `unacked`, `unseen`, `restart`. A decline: its reason
 * (RemoteDeclineReason). Taken back: `revoked` (the machine disconnected),
 * `untrusted`, `cancelled`.
 */
export type LeaseCause =
  | 'silent' | 'ceiling' | 'missing' | 'refused' | 'declined'
  | 'unacked' | 'unseen' | 'restart'
  | 'image' | 'data' | 'wheels' | 'disk' | 'memory' | 'card' | 'draining' | 'version'
  | 'revoked' | 'untrusted' | 'cancelled'

interface LeaseRaw {
  attempt_id: string
  runner_id: string
  competition_id: string
  submission_id: string
  run_id: string
  state: string
  seq: number
  sealed: number
  code_cells: number | null
  provenance: string
  manifest: string
  prepared: string
  container: string
  device: string | null
  per_device: number | null
  slice_mb: number | null
  phase: string | null
  offered_at: number
  accepted_at: number | null
  started_at: number | null
  ended_at: number | null
  deadline_at: number
  outcome_sha256: string | null
  outcome: string | null
  reply: string | null
  reason: string | null
  cause: string | null
}

function toLease(row: LeaseRaw): LeaseRow {
  return {
    attemptId: row.attempt_id,
    runnerId: row.runner_id,
    competitionId: row.competition_id,
    submissionId: row.submission_id,
    runId: row.run_id,
    state: row.state as LeaseState,
    seq: row.seq,
    sealed: row.sealed === 1,
    codeCells: row.code_cells,
    provenance: parsed<LeaseProvenance>(row.provenance, { inputRevision: null, notebookInputRevision: null }),
    manifest: parsed<LeaseManifest>(row.manifest, null as unknown as LeaseManifest),
    prepared: parsed<LeasePrepared>(row.prepared, { sealedFiles: [], before: { cellsDone: 0, cellsTotal: 0, durationMs: null } }),
    container: row.container,
    device: row.device,
    perDevice: row.per_device,
    sliceMb: row.slice_mb,
    phase: row.phase as RemoteAttemptPhase | null,
    offeredAt: row.offered_at,
    acceptedAt: row.accepted_at,
    startedAt: row.started_at,
    endedAt: row.ended_at,
    deadlineAt: row.deadline_at,
    outcomeSha256: row.outcome_sha256,
    outcome: parsed<unknown>(row.outcome, null),
    reply: parsed<LeaseRow['reply']>(row.reply, null),
    reason: row.reason,
    cause: (row.cause ?? null) as LeaseCause | null,
  }
}

const selectLease = db.prepare('SELECT * FROM remote_leases WHERE attempt_id = ?')

export function getLease(attemptId: string): LeaseRow | null {
  const row = selectLease.get(attemptId) as LeaseRaw | undefined
  return row ? toLease(row) : null
}

const LIVE_SQL = `('${LIVE_LEASE_STATES.join("', '")}')`
const OPEN_SQL = `('${OPEN_LEASE_STATES.join("', '")}')`

/** A machine's live leases (offered, accepted, running, applying), oldest first. */
export function liveLeases(runnerId?: string): LeaseRow[] {
  const rows = runnerId === undefined
    ? db.prepare(`SELECT * FROM remote_leases WHERE state IN ${LIVE_SQL} ORDER BY offered_at, attempt_id`).all()
    : db.prepare(`SELECT * FROM remote_leases WHERE runner_id = ? AND state IN ${LIVE_SQL} ORDER BY offered_at, attempt_id`).all(runnerId)
  return (rows as LeaseRaw[]).map(toLease)
}

/** Leases a cancel, a loss or a silence may still end: live and not being applied. */
export function openLeases(runnerId?: string): LeaseRow[] {
  const rows = runnerId === undefined
    ? db.prepare(`SELECT * FROM remote_leases WHERE state IN ${OPEN_SQL} ORDER BY offered_at, attempt_id`).all()
    : db.prepare(`SELECT * FROM remote_leases WHERE runner_id = ? AND state IN ${OPEN_SQL} ORDER BY offered_at, attempt_id`).all(runnerId)
  return (rows as LeaseRaw[]).map(toLease)
}

export function leasesInState(state: LeaseState): LeaseRow[] {
  return (db.prepare('SELECT * FROM remote_leases WHERE state = ? ORDER BY offered_at, attempt_id').all(state) as LeaseRaw[]).map(toLease)
}

/** The leases of a submission since `since` (its queue row's arrival): the losses and declines that count toward ending it. */
export function submissionLeases(submissionId: string, since: number): LeaseRow[] {
  return (db.prepare('SELECT * FROM remote_leases WHERE submission_id = ? AND offered_at >= ? ORDER BY offered_at, attempt_id').all(submissionId, since) as LeaseRaw[]).map(toLease)
}

/** The last lease of a submission whatever its state: where a returned row came back from. */
export function lastLeaseOf(submissionId: string): LeaseRow | null {
  const row = db.prepare('SELECT * FROM remote_leases WHERE submission_id = ? ORDER BY offered_at DESC, attempt_id DESC LIMIT 1').get(submissionId) as LeaseRaw | undefined
  return row ? toLease(row) : null
}

/** A machine's leases that ended in `states` since `since`: what the quarantine counts. */
export function endedLeases(runnerId: string, states: readonly LeaseState[], since: number): LeaseRow[] {
  const list = `('${states.join("', '")}')`
  return (db.prepare(`SELECT * FROM remote_leases WHERE runner_id = ? AND state IN ${list} AND ended_at >= ? ORDER BY ended_at`).all(runnerId, since) as LeaseRaw[]).map(toLease)
}

/**
 * The submissions a machine refused since `since` (its drains aside), or
 * whose result it could not deliver — a result that did not match its
 * uploads, a run stuck past its ceiling: the take does not offer them to it
 * again until REMOTE_DECLINE_SKIP_MS has passed (§3.4 "Decline"), so that
 * another machine, or this server, gets the next try — and the three losses
 * that end a submission are three different machines' (decision 6). A run
 * lost to a silence or an agent's restart is not skipped: the machine that
 * comes back is as good as any for it. Read from the leases themselves, so
 * it outlives a restart and holds nothing row-wide.
 */
export function declinedBy(runnerId: string, since: number): Set<string> {
  const rows = db.prepare(`SELECT submission_id FROM remote_leases WHERE runner_id = ? AND ended_at >= ?
      AND ((state = 'declined' AND (cause IS NULL OR cause != 'draining')) OR (state = 'lost' AND cause IN ('refused', 'ceiling', 'declined')))`)
    .all(runnerId, since) as { submission_id: string }[]
  return new Set(rows.map((row) => row.submission_id))
}

/** A machine's leases, newest first, for its page (M3) and its counters. */
export function runnerLeaseCounts(runnerId: string): { applied: number; lost: number; declined: number; requeued: number } {
  const rows = db.prepare(`SELECT state, reason, COUNT(*) AS n FROM remote_leases WHERE runner_id = ? GROUP BY state, reason`).all(runnerId) as { state: string; reason: string | null; n: number }[]
  const out = { applied: 0, lost: 0, declined: 0, requeued: 0 }
  for (const row of rows) {
    if (row.state === 'applied') out.applied += row.n
    else if (row.state === 'lost') out.lost += row.n
    else if (row.state === 'declined' && row.reason !== 'draining') out.declined += row.n
    // Given back with no loss counted: a drain, a withdrawn offer, a revoked machine's runs, an untrust.
    else if (row.state === 'withdrawn' || (row.state === 'declined' && row.reason === 'draining') || (row.state === 'revoked' && row.reason !== 'cancelled')) out.requeued += row.n
  }
  return out
}

/** The newest decline's or loss's words on a machine, for its counter's caption. */
export function lastTrouble(runnerId: string): string | null {
  const row = db.prepare(`SELECT reason FROM remote_leases WHERE runner_id = ? AND state IN ('lost', 'declined') AND reason IS NOT NULL
    ORDER BY ended_at DESC LIMIT 1`).get(runnerId) as { reason: string } | undefined
  return row?.reason ?? null
}

export interface NewLease {
  attemptId: string
  runnerId: string
  competitionId: string
  submissionId: string
  runId: string
  seq: number
  sealed: boolean
  codeCells: number | null
  provenance: LeaseProvenance
  manifest: LeaseManifest
  prepared: LeasePrepared
  container: string
  perDevice: number | null
  offeredAt: number
  deadlineAt: number
}

export function insertLease(lease: NewLease): void {
  db.prepare(`INSERT INTO remote_leases
      (attempt_id, runner_id, competition_id, submission_id, run_id, state, seq, sealed, code_cells, provenance, manifest, prepared,
       container, per_device, offered_at, deadline_at)
    VALUES (?, ?, ?, ?, ?, 'offered', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    lease.attemptId, lease.runnerId, lease.competitionId, lease.submissionId, lease.runId, lease.seq, lease.sealed ? 1 : 0, lease.codeCells,
    JSON.stringify(lease.provenance), JSON.stringify(lease.manifest), JSON.stringify(lease.prepared), lease.container, lease.perDevice,
    lease.offeredAt, lease.deadlineAt,
  )
}

export interface LeasePatch {
  state?: LeaseState
  acceptedAt?: number
  startedAt?: number
  endedAt?: number
  phase?: RemoteAttemptPhase
  device?: string | null
  sliceMb?: number | null
  outcomeSha256?: string
  outcome?: unknown
  reply?: LeaseRow['reply']
  reason?: string | null
  cause?: LeaseCause
}

const LEASE_COLUMN: Record<keyof LeasePatch, string> = {
  state: 'state',
  acceptedAt: 'accepted_at',
  startedAt: 'started_at',
  endedAt: 'ended_at',
  phase: 'phase',
  device: 'device',
  sliceMb: 'slice_mb',
  outcomeSha256: 'outcome_sha256',
  outcome: 'outcome',
  reply: 'reply',
  reason: 'reason',
  cause: 'cause',
}

/**
 * Change a lease, fenced on the states it may be in now: `from` lists them,
 * and a lease that moved on meanwhile (applied a second ago, revoked by a
 * cancel) is left alone. Returns whether this call changed it.
 */
export function updateLease(attemptId: string, patch: LeasePatch, from?: readonly LeaseState[]): boolean {
  const sets: string[] = []
  const params: Record<string, unknown> = { attempt: attemptId }
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) continue
    const column = LEASE_COLUMN[key as keyof LeasePatch]
    sets.push(`${column} = @${column}`)
    params[column] = key === 'outcome' || key === 'reply' ? (value === null ? null : JSON.stringify(value)) : key === 'reason' && typeof value === 'string' ? reasonText(value) : value
  }
  if (sets.length === 0) return false
  const fence = from ? ` AND state IN ('${from.join("', '")}')` : ''
  return db.prepare(`UPDATE remote_leases SET ${sets.join(', ')} WHERE attempt_id = @attempt${fence}`).run(params).changes > 0
}

/** A reason as the panel shows it: one line, REMOTE_REASON_CHARS at most. */
export function reasonText(text: string): string {
  return remoteText(text.replace(/[\r\n\t]+/g, ' ').trim(), REMOTE_REASON_CHARS, 'start')
}

/* ------------------------------------------------------------------ events */

export interface EventRow {
  id: number
  at: number
  runnerId: string
  attemptId: string | null
  kind: RemoteEventKind
  address: string | null
  detail: string | null
}

/**
 * One line of a machine's log. Never throws: an event is a record of what
 * already happened, and failing a sync or an outcome because the log could
 * not be written would lie about that.
 */
export function remoteEvent(runnerId: string, kind: RemoteEventKind, extra: { attemptId?: string | null; address?: string | null; detail?: string | null } = {}, at = Date.now()): void {
  try {
    db.prepare('INSERT INTO remote_events (at, runner_id, attempt_id, kind, address, detail) VALUES (?, ?, ?, ?, ?, ?)').run(
      at, runnerId, extra.attemptId ?? null, kind, extra.address ?? null, extra.detail ? reasonText(extra.detail) : null,
    )
  } catch (error) {
    console.warn('[runners] an event could not be recorded:', error instanceof Error ? error.message : error)
  }
}

export function runnerEvents(runnerId: string, limit = 50): EventRow[] {
  const rows = db.prepare('SELECT * FROM remote_events WHERE runner_id = ? ORDER BY at DESC, id DESC LIMIT ?').all(runnerId, limit) as {
    id: number; at: number; runner_id: string; attempt_id: string | null; kind: string; address: string | null; detail: string | null
  }[]
  return rows.map((row) => ({ id: row.id, at: row.at, runnerId: row.runner_id, attemptId: row.attempt_id, kind: row.kind as RemoteEventKind, address: row.address, detail: row.detail }))
}

/**
 * Old leases and events go: a week of leases (the counters and late replies
 * need no more), three months of events. A lease still live is kept whatever
 * its age: a four-hour run of last week is not last week's.
 */
export function pruneRemoteRows(now = Date.now()): { leases: number; events: number; codes: number } {
  const leases = db.prepare(`DELETE FROM remote_leases WHERE state NOT IN ${LIVE_SQL} AND offered_at < ?`).run(now - REMOTE_LEASES_KEEP_MS).changes
  const events = db.prepare('DELETE FROM remote_events WHERE at < ?').run(now - REMOTE_EVENTS_KEEP_MS).changes
  // A code expired a week ago enrolls nothing and counts nothing the dialog still shows.
  const codes = db.prepare('DELETE FROM remote_runner_codes WHERE expires_at < ?').run(now - REMOTE_LEASES_KEEP_MS).changes
  return { leases, events, codes }
}

/** The instance setting «Посылок на карту», bounded to what the contract carries. */
export function boundedPerDevice(value: number): number {
  return Math.min(REMOTE_PER_DEVICE_MAX, Math.max(1, Math.trunc(value) || 1))
}
