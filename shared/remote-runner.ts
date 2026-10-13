/**
 * The contract between home and the machines that run its submissions
 * («машины для посылок», docs/architecture/remote-runners.md): every message
 * on /api/runners/v1, a strict parser for each, and every number both sides
 * must agree on.
 *
 * ONE FILE THAT BOTH SIDES IMPORT. Home (server/src/competitions/remote/) and
 * the agent on a machine (server/src/runner-agent/, bundled as
 * dist/runner.js) meet only on the wire. A field one of them writes and the
 * other reads under another name fails on a rented VM in the middle of a
 * class, not in a test, unless both read it from here. So the module is pure:
 * nothing from server/ or runtime/, no node: module, nothing done at import
 * time. The agent's bundle carries it whole, the panel may read its words,
 * and where a rule needs a hash the caller passes its own (remoteManifest,
 * remoteOutcomeDigest). One rule both sides share is not here: an image's
 * layer fingerprint is server/src/dependencies/image-identity.ts ·
 * layersFingerprint, written pure for the machines to import as it is, and a
 * second copy of it here could only ever disagree with the first.
 *
 * STRICT, LIKE THE BROKER'S CONTRACT (competition-runtime.ts). Every parser
 * refuses unknown keys, ids and hashes outside their patterns, numbers out of
 * range and texts over their caps, and throws RemoteProtocolError. One
 * version is spoken at a time (REMOTE_PROTOCOL): an extra key is not a newer
 * agent to be humoured but a bug or a forgery.
 *
 * BUT A HEARTBEAT CARRIES WHAT A NOTEBOOK WROTE. progress.json and run.json
 * lie where the participant's code can write (runner.ts · clampCells), and the
 * Docker runner passes on any finite number it finds in them
 * (docker-runner.ts · num). A sync refused for one forged `cell` would be
 * every lease on that machine lost, its neighbours' included: one notebook
 * taking down a machine's worth of other people's runs. So whatever a
 * notebook can write goes through remoteProgress or remoteOutcome on the
 * agent before it is sent (whole numbers clamped into the ranges below, texts
 * cut to their caps), and a parser refuses only what a conforming agent never
 * sends.
 *
 * THE SIZES ADD UP. Each request has a body cap at home's router, and the
 * field and count caps below are chosen so that the largest message a parser
 * accepts fits its body cap even with every free text JSON-escaped at its
 * worst, six bytes a character: a conforming agent is never refused for size
 * (tests/remote-runner-protocol.test.mts builds each worst case).
 */
import { COMPETITION_ATTEMPT_ID, COMPETITION_ROW_ID } from './competition-runtime.js'
import type { RunVerdict } from './competitions.js'

/* ------------------------------------------------------------------ the wire */

/**
 * The one version both sides speak. A breaking change bumps it and the path
 * with it: home never parses two versions side by side, and leases already
 * out under the old one are requeued with no penalty.
 *
 * Within one version a message only ever gains optional fields, and only the
 * newer side ever writes them. Home goes first: a machine with another build
 * gets no new leases (remoteCompatible), and an agent is updated by draining
 * it. So a machine never runs ahead of its home, and home's strict parsers
 * never meet a field they do not know.
 */
export const REMOTE_PROTOCOL = 1

/**
 * Where home mounts the router: in app.ts right after the security headers,
 * before compression (a Range download must not be re-encoded), the SSO
 * identity, express.json and the same-origin gate. It has parsers and caps of
 * its own.
 */
export const REMOTE_API_BASE = `/api/runners/v${REMOTE_PROTOCOL}`

/**
 * The calls under REMOTE_API_BASE. A path is built only from ids a parser has
 * accepted, and they are checked once more here: an attempt id from a lease
 * ends up in a URL, and a URL is no place for a `../`.
 */
export const remotePaths = {
  join: 'join',
  sync: 'sync',
  blob: (sha256: string): string => `blobs/${pathPart(sha256, REMOTE_SHA256)}`,
  file: (attemptId: string, name: RemoteFileName): string =>
    `attempts/${pathPart(attemptId, COMPETITION_ATTEMPT_ID)}/files/${pathPart(name, REMOTE_FILE_NAME)}`,
  outcome: (attemptId: string): string => `attempts/${pathPart(attemptId, COMPETITION_ATTEMPT_ID)}/outcome`,
} as const

/**
 * The header every reply of the router carries, refusals included, with
 * REMOTE_MARKER as its value.
 *
 * A reply without it never came from home: the relay's own page served as a
 * 404 or a 502, frps's 504 at sixty seconds, frps's EOF turned into a 404 on a
 * reused POST connection. Taken for home's answer, a relay restart would make
 * the agent drop leases home still counts on; taken for a hiccup, it costs one
 * retry.
 */
export const REMOTE_MARKER_HEADER = 'X-Colloq-Runner-Api'
export const REMOTE_MARKER = String(REMOTE_PROTOCOL)

/**
 * Whether a reply is a hiccup of the path rather than home's answer: no
 * marker, or home itself saying "not now" (429, any 5xx). The agent backs off
 * with jitter between REMOTE_BACKOFF_MIN_MS and REMOTE_BACKOFF_MAX_MS, asks
 * the relay's REMOTE_RELAY_STATE_PATH whether home is offline, and never
 * drops a lease over one.
 */
export function remoteTransient(status: number, marker: string | null | undefined): boolean {
  return marker?.trim() !== REMOTE_MARKER || status === 429 || status >= 500
}

/**
 * An uploaded file's own sha256 and length, uncompressed (the body is
 * `Content-Encoding: gzip`): home stops decompressing at the declared length
 * plus one byte, and keeps the file only if both match.
 */
export const REMOTE_SHA256_HEADER = 'X-Colloq-Sha256'
export const REMOTE_BYTES_HEADER = 'X-Colloq-Bytes'

/**
 * The relay's page (not home's) the agent reads after a transient reply, to
 * tell "home is offline" from "home refused": the relay must serve it before
 * the agent can rely on it (deploy, phase P7).
 */
export const REMOTE_RELAY_STATE_PATH = '/.relay/state'

/**
 * A machine's credential: `Authorization: Bearer cr1.<runnerId>.<secret>`.
 *
 * `cr1` names the scheme, so that signed requests can come later under a name
 * of their own rather than as a guess about this one. The secret is 256
 * random bits; home keeps its sha256 and compares digests in constant time.
 * It goes in this header and nowhere else: never in a URL, which proxies, the
 * relay and every access log keep.
 */
export const REMOTE_CREDENTIAL_SCHEME = 'cr1'

export function remoteCredential(runnerId: string, secret: string): string {
  if (!REMOTE_RUNNER_ID.test(runnerId) || !REMOTE_SECRET.test(secret)) refuse('Invalid machine credential')
  return `${REMOTE_CREDENTIAL_SCHEME}.${runnerId}.${secret}`
}

/**
 * The machine an Authorization header names, or null. The scheme word is
 * case-insensitive (RFC 7235), the token is not, and nothing else in the
 * header is a machine's credential.
 */
export function parseRemoteAuthorization(header: string | null | undefined): { runnerId: string; secret: string } | null {
  const bearer = /^bearer[ \t]+(\S+)[ \t]*$/i.exec(header ?? '')
  const parts = bearer ? bearer[1].split('.') : []
  if (parts.length !== 3 || parts[0] !== REMOTE_CREDENTIAL_SCHEME || !REMOTE_RUNNER_ID.test(parts[1]) || !REMOTE_SECRET.test(parts[2])) return null
  return { runnerId: parts[1], secret: parts[2] }
}

/**
 * Whether a token has the shape of a machine's credential, bare or after
 * `Bearer`, for the doors that must refuse one (currentStaff, currentEntrant,
 * verifyToken, the WebSocket upgrades): only this router takes it, and a door
 * that tried it as a token of its own kind would be one more place a leaked
 * machine secret opens.
 */
export function isRemoteCredential(token: string | null | undefined): boolean {
  return typeof token === 'string' && /^(?:bearer[ \t]+)?cr1\./i.test(token.trim())
}

/**
 * What COLLOQ_RUNNER_JOIN holds: home's address with the owner's code as its
 * fragment, `https://vsos.colloq.ru#<code>`, one string to paste into the
 * join command. A fragment never leaves the machine in a request line, so the
 * code stays out of every proxy's and relay's log on the way; the agent sends
 * it in the join body and nowhere else.
 */
export function remoteJoinTarget(home: string, code: string): string {
  const origin = homeOrigin(home)
  if (origin === null || !REMOTE_JOIN_CODE.test(code)) refuse('Invalid join target')
  return `${origin}#${code}`
}

export function parseRemoteJoinTarget(text: string): { home: string; code: string } | null {
  const value = text.trim()
  const hash = value.indexOf('#')
  if (hash < 0) return null
  const home = homeOrigin(value.slice(0, hash))
  const code = value.slice(hash + 1)
  return home !== null && REMOTE_JOIN_CODE.test(code) ? { home, code } : null
}

/**
 * Home as the agent keeps it: an http(s) origin and nothing else. A path, a
 * query or credentials in it would be sent with every call. Plain http is for
 * a home on the same network or in a test; the panel's commands name https.
 */
function homeOrigin(text: string): string | null {
  try {
    const url = new URL(text)
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return null
    if (url.username || url.password || url.search || url.hash || url.pathname !== '/') return null
    return url.origin
  } catch {
    return null
  }
}

/* -------------------------------------------------------------- identities */

/** A machine's id: eight letters read aloud, like a competition's (store.ts · newId). In its credential, the panel and the events; not a secret. */
export const REMOTE_RUNNER_ID = COMPETITION_ROW_ID

/** Minted once by the agent and written to runner.json before its first try, so that a join whose reply was lost is the same join. */
export const REMOTE_JOIN_ID = COMPETITION_ATTEMPT_ID

/** The owner's enrollment code: 128 random bits, shown once inside the join command; home keeps its sha256. */
export const REMOTE_JOIN_CODE = /^[a-f0-9]{32}$/

/** A machine's secret: 256 random bits; home keeps its sha256. */
export const REMOTE_SECRET = /^[a-f0-9]{64}$/

/** A content hash: blobs, result files, data manifests, an image's layer fingerprint. */
export const REMOTE_SHA256 = /^[a-f0-9]{64}$/

/** environment_revisions.id and dependency_bundles.id: 32 hex digits (dependencies/store.ts · id). */
export const REMOTE_REVISION_ID = COMPETITION_ATTEMPT_ID
export const REMOTE_BUNDLE_ID = COMPETITION_ATTEMPT_ID

/** HARNESS_REVISION: twelve hex digits of the harness files' hash (harness.ts). */
export const REMOTE_HARNESS = /^[a-f0-9]{12}$/

/** A notebook container's name as home mints it (runner.ts · containerName): the submission, a token, `run`. */
export const REMOTE_CONTAINER = /^colloq-comp-[a-z2-9]{8}-[a-f0-9]{8}-run$/

/** A card as the machine's own probe names it: an index or a `GPU-<uuid>`. */
export const REMOTE_DEVICE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/

/** A data file as the notebook reads it in /data: storage.ts · NAME_OK, and never `..`. */
export const REMOTE_DATA_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,119}$/

/** A wheel's file name, as a published set keeps it (dependencies/files.ts · publishBundle). */
export const REMOTE_WHEEL_NAME = /^[A-Za-z0-9][A-Za-z0-9_.+!-]{0,230}\.whl$/

/**
 * An image by digest, as home pins it (environment_revisions.registry_ref,
 * image-identity.ts · registryRefOf): `ghcr.io/colloq-edu/colloq-kernel@sha256:…`,
 * the grammar docker's references have. A tag is not a pin: what it names
 * changes under it, and a machine would run something home never saw.
 */
const REF_COMPONENT = '[a-z0-9]+(?:(?:[._]|__|-+)[a-z0-9]+)*'
const REF_HOST = '[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\\.[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)*(?::[0-9]{1,5})?'
export const REMOTE_IMAGE_REF = new RegExp(`^(?:${REF_HOST}/)?${REF_COMPONENT}(?:/${REF_COMPONENT})*@sha256:[a-f0-9]{64}$`)
/**
 * Checked before the pattern, so that it never meets a long string: more than
 * any RepoDigests entry home keeps (512, image-identity.ts) with the
 * `docker.io/library/` it may put in front.
 */
const REF_CHARS = 600

/** A release as the root package.json names it: what «устарел — обновить» updates a machine to. */
export const REMOTE_VERSION = /^\d{1,4}\.\d{1,4}\.\d{1,6}(?:-[0-9A-Za-z.-]{1,40})?(?:\+[0-9A-Za-z.-]{1,40})?$/

/** The two files a machine uploads: the answer and the executed notebook (EXECUTED_NOTEBOOK_FILE). Nothing else is ever stored. */
export const REMOTE_FILE_NAMES = ['submission.csv', 'executed.ipynb'] as const
export type RemoteFileName = (typeof REMOTE_FILE_NAMES)[number]
const SUBMISSION: RemoteFileName = 'submission.csv'
const REMOTE_FILE_NAME = /^(?:submission\.csv|executed\.ipynb)$/

/* ----------------------------------------------------------------- numbers */

/** join: a code, an id and the machine's facts; anything bigger is not a machine introducing itself. */
export const REMOTE_JOIN_BYTES = 8 * 1024
/** sync: the machine's whole state, level-triggered; the caps below add up to well under it. */
export const REMOTE_SYNC_BYTES = 256 * 1024
/** outcome: the verdict, its two texts and the raw harness report; the caps below add up to just under it. */
export const REMOTE_OUTCOME_BYTES = 192 * 1024
/** One uploaded file, uncompressed: the answer's cap (LIMITS.submissionBytes) and the executed notebook's (storage.ts · EXECUTED_BYTES). */
export const REMOTE_FILE_BYTES = 64 * 1024 * 1024
/** Any reply of home's; the agent stops reading past it. Home stays under it by its inline budget and by describing few package sets at a time. */
export const REMOTE_REPLY_BYTES = 16 * 1024 * 1024

/** The longest wall an editor allows (LIMITS.wallSeconds.max): the longest run any lease can carry. */
export const REMOTE_WALL_SECONDS_MAX = 4 * 60 * 60
/** A submitted notebook's ceiling (LIMITS.notebookBytes): no lease names a bigger one. */
export const REMOTE_NOTEBOOK_BYTES = 20 * 1024 * 1024
/** A notebook rides inside its lease up to this; a bigger one is a blob, fetched by its hash (s/<sid>/in/). */
export const REMOTE_INLINE_BYTES = 64 * 1024
/** All inline notebooks of one reply together; past it the rest go as blobs, so a burst never makes a reply megabytes long. */
export const REMOTE_INLINE_TOTAL_BYTES = 1024 * 1024
/** A data manifest's files together, open or hidden (LIMITS.dataBytes, LIMITS.sealedBytes). */
export const REMOTE_DATA_BYTES = 200 * 1024 * 1024
/** Files in one data manifest: LIMITS.files open plus LIMITS.sealedFiles hidden. */
export const REMOTE_DATA_FILES_MAX = 50
/** A package set's wheels together: the most a competition's policy may allow (DEPENDENCY_LIMITS.downloadBytes). */
export const REMOTE_WHEELS_BYTES = 500 * 1024 * 1024
/** Wheels in one set: the broker's own cap on a collected set (competition-runtime.ts · parseCompetitionJobCollection). */
export const REMOTE_WHEELS_MAX = 256
/** A set's requirements.lock: 256 lines of `name==version --hash=sha256:…`, with room to spare. */
export const REMOTE_LOCK_CHARS = 128 * 1024
/** A wheel's address: home keeps one of up to 2,048 characters as pip reported it (preparation-contract.ts · wheelUrl), and canonical it may grow a little. */
export const REMOTE_URL_CHARS = 4096
/** The raw harness report, as the export takes it out of the container (docker-runner.ts · RUN_FILE at 65536). */
export const REMOTE_RUN_JSON_BYTES = 64 * 1024
/** The participant's text of a run: the harness hands over up to 4,000 (harness.ts · cell_error_detail), home keeps the last 2,000 (runner.ts · withinLimit). */
export const REMOTE_DETAIL_CHARS = 8_000
/** The teacher's log: the container's last 4,000 characters (docker-runner.ts · postmortem) and our line about the card. */
export const REMOTE_LOG_CHARS = 8_000
/** A reason a machine gives (a problem, a decline, an error reply's detail): one line for the owner, not a log. */
export const REMOTE_REASON_CHARS = 300
/** What a machine calls itself (hostname, Docker, storage driver, a card's name): shown, never parsed. */
export const REMOTE_HOSTNAME_CHARS = 253
export const REMOTE_LABEL_CHARS = 64

/** Attempts a machine holds, and leases in one reply: the most places an instance runs at once (SETTINGS_LIMITS.slots.max). */
export const REMOTE_ATTEMPTS_MAX = 64
/** Cards on one machine: eight is the most a Vast host offers, sixteen leaves room for a university server. */
export const REMOTE_CARDS_MAX = 16
/** Runs sharing one card (SETTINGS_LIMITS.gpuPerDevice): past eight, a 24 GB card leaves each less than a CUDA context and a model. */
export const REMOTE_PER_DEVICE_MAX = 8
/** Revisions a machine reports ready or is asked for: one per competition for its whole life, a handful at a time. */
export const REMOTE_REVISIONS_MAX = 32
/** Data manifests in a list (ready open, ready sealed, wanted): open, upcoming and waiting competitions, and those of leases still out. */
export const REMOTE_MANIFESTS_MAX = 128
/** Package sets a machine reports ready or is asked to keep: every entrant of a few competitions, with a set or two each. */
export const REMOTE_BUNDLES_MAX = 1024
/** Of those, how many one reply describes in full (lock and wheels): a machine fetches one stream at a time anyway. */
export const REMOTE_BUNDLE_DETAILS_MAX = 8
/** Problems one sync reports: past it the rest wait for the next one. */
export const REMOTE_PROBLEMS_MAX = 32
/** Fetches one sync reports progress for («образ ↓ 45 %»). */
export const REMOTE_FETCHING_MAX = 64
/** A run's card samples, oldest first (docker-runner.ts · VramWatch keeps four). */
export const REMOTE_GPU_SAMPLES_MAX = 4
/** Code cells a run may report: more than a 20 MiB notebook of empty cells can hold, so only a forged count is ever clamped. */
export const REMOTE_CELLS_MAX = 1_000_000

/** A machine's size, as far as any machine goes: CPUs, memory, a card's memory, disk (MB). */
export const REMOTE_CPUS_MAX = 1024
export const REMOTE_MEMORY_MB_MAX = 16 * 1024 * 1024
export const REMOTE_CARD_MB_MAX = 1024 * 1024
export const REMOTE_DISK_MB_MAX = 1024 * 1024 * 1024

/** The longest a sync is held while the machine is idle: proxies cut at 30 s, and frps answers 504 at 60. */
export const REMOTE_HOLD_IDLE_MS = 25_000
/** The longest a sync is held while the machine holds any attempt: progress reaches home at least this often. */
export const REMOTE_HOLD_BUSY_MS = 10_000
/** An offer no sync has acked within this is withdrawn and its row requeued. */
export const REMOTE_OFFER_MS = 60_000
/** A machine silent this long on home's clock loses its leases, but only while home has path evidence. */
export const REMOTE_SILENCE_MS = 180_000
/** Path evidence: another machine heard, or home's probe of PUBLIC_URL/api/readyz through the relay passed, within this. */
export const REMOTE_EVIDENCE_MS = 60_000
/** How often home probes itself through the relay. */
export const REMOTE_PROBE_MS = 30_000
/** Without path evidence nothing expires for up to this: a dead tunnel is not a dead fleet. */
export const REMOTE_BLIND_MS = 15 * 60_000
/** Nothing expires in this first stretch after home starts: every machine needs a round trip to be heard again. */
export const REMOTE_BOOT_GRACE_MS = 180_000
/** The ceiling's first part: pulling, data and wheels for a lease, before the participant's timer starts. */
export const REMOTE_PREPARE_MS = 10 * 60_000
/** Its part around the wall: `docker run`'s own start (120 s, docker-runner.ts) and the export after the kill. */
export const REMOTE_RUN_GRACE_MS = 120_000
/** Its last part: the uploads and the outcome. */
export const REMOTE_UPLOAD_MS = 10 * 60_000

/**
 * A lease's ceiling, from its offer: past it the lease is revoked and counted
 * lost even while syncs keep arriving, because a run that long is a machine
 * that is stuck, not slow.
 */
export function remoteCeilingMs(wallSeconds: number): number {
  return REMOTE_PREPARE_MS + wallSeconds * 1000 + REMOTE_RUN_GRACE_MS + REMOTE_UPLOAD_MS
}

/** The longest any lease, run or report of one can last: the ceiling of the longest wall. */
export const REMOTE_RUN_MS_MAX = remoteCeilingMs(REMOTE_WALL_SECONDS_MAX)

/** A machine that declined a submission is not offered it again for this long; nothing row-wide waits. */
export const REMOTE_DECLINE_SKIP_MS = 10 * 60_000
/** Losses by different machines after their containers started that end a submission as a server failure spending no quota (decision 6). */
export const REMOTE_LOSS_LIMIT = 3
/** Declines by different machines that end it the same way, with their reasons. */
export const REMOTE_DECLINE_LIMIT = 3
/** Quarantine: this many losses, or declines, on one machine within the window drain it and raise a banner. */
export const REMOTE_QUARANTINE_LOSSES = 3
export const REMOTE_QUARANTINE_DECLINES = 5
export const REMOTE_QUARANTINE_WINDOW_MS = 30 * 60_000
/** The same joinId within this gets the same machine and a new secret, and spends no use of the code: its first reply was lost. */
export const REMOTE_JOIN_REPEAT_MS = 10 * 60_000
/** Joins per address: the router's only limit by address, so machines behind one NAT never throttle each other. */
export const REMOTE_JOINS_PER_ADDRESS = { count: 10, windowMs: 10 * 60_000 } as const
/** An enrollment code lives at most a day: a code is a door, and a door left open is found. */
export const REMOTE_CODE_TTL_MAX_MS = 24 * 60 * 60_000
/** After a transient reply the agent waits between these, with jitter. */
export const REMOTE_BACKOFF_MIN_MS = 1_000
export const REMOTE_BACKOFF_MAX_MS = 30_000
/** last_seen_at is written at most this often: liveness itself lives in memory. */
export const REMOTE_SEEN_FLUSH_MS = 60_000
/** remote_leases rows are kept a week, remote_events three months. */
export const REMOTE_LEASES_KEEP_MS = 7 * 24 * 60 * 60_000
export const REMOTE_EVENTS_KEEP_MS = 90 * 24 * 60 * 60_000
/** A GPU competition takes uploads while a machine with cards was heard within this, home's own cards aside (decision 8). */
export const REMOTE_GPU_SEEN_MS = 60 * 60_000

/** Uploads home stores at once across the instance (the owner's runnerUploads); past it 503 with Retry-After. */
export const REMOTE_UPLOADS = { min: 1, max: 8, default: 4 } as const
/** Free disk every upload needs by statfs; below it home answers 507. */
export const REMOTE_UPLOAD_FREE_BYTES = 128 * 1024 * 1024
/** Blob streams: one per machine, three per instance; past them 429 with Retry-After. The class archive (files.zip) is never used. */
export const REMOTE_BLOB_STREAMS_PER_RUNNER = 1
export const REMOTE_BLOB_STREAMS = 3
/** «Скорость раздачи», MB/s for all blobs together; the default is a placeholder until the relay is measured (P0). */
export const REMOTE_BLOB_MBPS = { min: 1, max: 1000, default: 8 } as const

/** On the machine: memory kept for the host, and the cushion each container gets beyond its limit (docker-runner.ts · CONTAINER_CUSHION_MB). */
export const REMOTE_HOST_RESERVE_MB = 2048
export const REMOTE_CONTAINER_CUSHION_MB = 256
/** Disk a machine always leaves free, and what each attempt adds to it. */
export const REMOTE_DISK_RESERVE_MB = 2048
export const REMOTE_ATTEMPT_DISK_MB = 256
/** The least disk a machine needs: a CPU kernel is a gigabyte, a GPU one four to thirteen. */
export const REMOTE_DISK_MIN_GB = { cpu: 40, gpu: 120 } as const
/** A GPU revision's smoke test: torch must see CUDA within this, on a driver no older than this. */
export const REMOTE_GPU_SMOKE_MS = 10_000
export const REMOTE_DRIVER_MIN = 580
/** Competitions opening within this are prefetched; revisions nobody wanted for this long go first when the disk runs low. */
export const REMOTE_PREFETCH_AHEAD_MS = 24 * 60 * 60_000
export const REMOTE_EVICT_AFTER_MS = 24 * 60 * 60_000

/* ------------------------------------------------------------ compatibility */

/**
 * WHICH MACHINES MAY TAKE NEW WORK: those whose runner code is home's
 * (decision 5).
 *
 * `build` is the sha256 of dist/runner.js, written next to it as
 * REMOTE_BUILD_FILE when the image is built, and sent in every JSON request.
 * The bundle holds everything that decides how a submission runs on a
 * machine (the sandbox's argv, docker-runner.ts · runArgs; the harness files;
 * this contract), so two machines with one build run a notebook identically,
 * and home's own copy of the same file says which build is right. A machine
 * with another one is «устарел»: no new leases, while those already out
 * finish.
 *
 * Not the version string: a release that touches none of the above (the
 * panel, the docs, home's own logic) keeps the fleet serving. For that the
 * version is read at run time and never inlined into the bundle, or every
 * release would change the hash. Under make dev there is no bundle and both
 * sides report REMOTE_BUILD_DEV, which matches only itself; a production home
 * never reports it.
 */
export const REMOTE_BUILD_DEV = 'dev'
export const REMOTE_BUILD = /^(?:[a-f0-9]{64}|dev)$/
export const REMOTE_BUILD_FILE = 'runner.sha256'

/** The build in REMOTE_BUILD_FILE: the digest alone, or as `sha256sum` prints it with the file's name after it. */
export function parseRemoteBuildFile(text: string): string | null {
  const digest = text.trim().split(/\s+/)[0] ?? ''
  return /^[a-f0-9]{64}$/.test(digest) ? digest : null
}

export function remoteCompatible(homeBuild: string, runnerBuild: string): boolean {
  return REMOTE_BUILD.test(homeBuild) && homeBuild === runnerBuild
}

/* ------------------------------------------------------- names of contents */

/** A hash function the caller brings (node:crypto at home and on the agent): the text in, its sha256 in hex out. */
export type RemoteHash = (text: string) => string

/**
 * A data manifest: the name of a set of files, the hash of their names and
 * hashes (competition_files) sorted by name.
 *
 * So a machine fetches only the hashes it lacks, a replaced file makes a new
 * manifest, and leases already out keep a folder of their own
 * (inputs/<manifest12>/). Sorted by code unit, not by locale: the order must
 * be the same on every machine. REMOTE_DATA_NAME has neither tab nor newline,
 * so the text reads only one way, and its first line keeps it from ever
 * equalling another text we hash.
 */
export function remoteManifest(files: readonly { name: string; sha256: string }[], hash: RemoteHash): string {
  const names = new Set<string>()
  for (const file of files) {
    if (!dataName(file.name) || names.has(file.name) || !REMOTE_SHA256.test(file.sha256)) refuse('Invalid manifest file')
    names.add(file.name)
  }
  const sorted = [...files].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
  return hash(`colloq.remote.data.v1\n${sorted.map((file) => `${file.name}\t${file.sha256}\n`).join('')}`)
}

/**
 * What an outcome's digest covers (remote_leases.outcome_sha256): its kind
 * and its result, as canonical JSON (keys sorted, files by name), and not
 * protocol, build or free.
 *
 * The same outcome posted again gets the reply cached for it, a different one
 * 409 `conflict`. The agent sends `free` as it is when it repeats a post, not
 * as it was the first time, and a digest over all of the body would take a
 * repeat for a conflict.
 */
export function remoteOutcomeDigest(request: RemoteOutcomeRequest, hash: RemoteHash): string {
  const result = request.kind === 'finished'
    ? { kind: request.kind, outcome: request.outcome, runJson: request.runJson, files: [...request.files].sort((a, b) => (a.name < b.name ? -1 : 1)) }
    : { kind: request.kind, reason: request.reason, detail: request.detail }
  return hash(canonical(result))
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (value !== null && typeof value === 'object') {
    const v = value as Record<string, unknown>
    const keys = Object.keys(v).filter((key) => v[key] !== undefined).sort()
    return `{${keys.map((key) => `${JSON.stringify(key)}:${canonical(v[key])}`).join(',')}}`
  }
  return JSON.stringify(value)
}

/* ---------------------------------------------------------------- messages */

/** What a machine can still take, as it measures itself: MemTotal less the host reserve and its runs, nproc less one and its runs, disk over its floor. */
export interface RemoteFree {
  /** Places it would still run at once, before home's own cap (approvedSlots). */
  slots: number
  memoryMb: number
  cpus: number
  /** Shares of its cards that no run holds. */
  gpuShares: number
  diskMb: number
}

/**
 * The machine as it introduces itself: at join, and again in the first sync
 * after every start and whenever the facts change (an update changes the
 * version, a new driver the driver). Its free texts (hostname, docker,
 * storage) are shown, never parsed, and the agent cuts them to their caps
 * (remoteText) before it sends them; the version, the platform and the driver
 * are read, and keep their patterns. Its cards are in every sync instead.
 */
export interface RemoteFacts {
  version: string
  hostname: string
  /** `linux/amd64` today: the kernels are published for it alone. */
  platform: string
  cpus: number
  memoryMb: number
  diskMb: number
  /** The Docker Engine's version, and its storage driver (overlay2 for the classic store, overlayfs for containerd's). */
  docker: string
  storage: string
  /** The NVIDIA driver, `580.65.06`; null on a machine without cards. «драйвер 535, нужен 580+» is read from it. */
  driver: string | null
}

/** One of the machine's cards as its own probe saw it (a throwaway `--gpus all nvidia-smi` container). */
export interface RemoteCard {
  device: string
  /** What the card calls itself; null — it did not say. */
  name: string | null
  /** Its memory; null — unknown, and then no share of it is promised or enforced (competitions/gpu.ts · gpuSliceMb). */
  memoryMb: number | null
  /** Runs sharing it, as home last said (RemoteSyncReply.perDevice). */
  perDevice: number
  /** Shares runs hold on it now: above perDevice for a while after home lowered it, while the runs on the card finish. */
  busyShares: number
}

/** What the machine has in place: pulled and verified revisions, complete data manifests (open and hidden), installed package sets. */
export interface RemoteReady {
  revisions: string[]
  data: string[]
  sealed: string[]
  bundles: string[]
}

/**
 * A fetch under way, for «образ ↓ 45 %» in the panel: exactly one of a
 * revision, a data manifest or a package set.
 */
export interface RemoteFetch {
  revisionId?: string
  manifest?: string
  bundleId?: string
  percent: number
}

/**
 * Where a held attempt is. `accepted`: the lease is written down, nothing
 * else. `preparing`: data, wheels, the card. `running`: the container runs.
 * `exporting`: it has ended and its files come out. `uploading`: the PUTs and
 * the outcome, repeated until home answers.
 */
export type RemoteAttemptPhase = 'accepted' | 'preparing' | 'running' | 'exporting' | 'uploading'

/** How far a running notebook has got, after remoteProgress: progress.json is the notebook's own to write. */
export interface RemoteProgress {
  phase: 'dependencies' | 'notebook'
  cell: number
  cells: number
}

/** An attempt the machine holds: every one of them is in every sync, and one left out is one the machine no longer has. */
export interface RemoteHeldAttempt {
  id: string
  phase: RemoteAttemptPhase
  /** Since the container started: home sets started_at to now less this, so pulls and downloads never eat the participant's time. */
  runningMs?: number
  progress?: RemoteProgress
  /** The card the attempt was given at prepare (competitions/gpu.ts · pickRunnerGpu), and its share. */
  card?: { device: string; sliceMb: number | null }
}

/**
 * Why something is not ready. `image`: the pull failed; `layers`: the pulled
 * image is not the one home pinned; `smoke`: torch saw no CUDA on a card (a
 * driver older than REMOTE_DRIVER_MIN, no toolkit) — each about a revision.
 * `data`: a blob of a manifest could not be fetched or failed its hash.
 * `wheels`: a wheel of a set could not be fetched. `disk`, `docker`, `cards`:
 * the machine itself (below its disk floor, a daemon that does not answer, a
 * card probe that failed).
 */
export type RemoteProblemCode = 'image' | 'layers' | 'smoke' | 'data' | 'wheels' | 'disk' | 'docker' | 'cards'
export interface RemoteProblem {
  code: RemoteProblemCode
  revisionId?: string
  manifest?: string
  bundleId?: string
  /** What docker, nvidia-smi or the network said, for the owner: at most REMOTE_REASON_CHARS. */
  detail: string
}

/** `active` takes work; `draining` finishes what it holds and takes none; `leaving` is about to revoke itself (colloq-host runner leave). */
export type RemoteRunnerState = 'active' | 'draining' | 'leaving'

/**
 * The heartbeat, the long-poll for work and the reconciliation in one call,
 * level-triggered: the machine's whole state goes in and the whole answer
 * comes out, so a lost reply is only a delay.
 */
export interface RemoteSyncRequest {
  protocol: typeof REMOTE_PROTOCOL
  build: string
  /** The highest lease seq the machine has written down: an offer at or below it that `attempts` leaves out was never received. */
  seq: number
  /** How long home may hold this call: at most REMOTE_HOLD_IDLE_MS, and REMOTE_HOLD_BUSY_MS while `attempts` is not empty. */
  holdMs: number
  state: RemoteRunnerState
  free: RemoteFree
  cards: RemoteCard[]
  ready: RemoteReady
  fetching: RemoteFetch[]
  attempts: RemoteHeldAttempt[]
  problems: RemoteProblem[]
  facts?: RemoteFacts
}

export interface RemoteJoinRequest {
  protocol: typeof REMOTE_PROTOCOL
  build: string
  /** The owner's code, from the fragment of COLLOQ_RUNNER_JOIN. */
  code: string
  joinId: string
  facts: RemoteFacts
}

export interface RemoteJoinReply {
  runnerId: string
  secret: string
  /** May receive the hidden test (decision 1): off unless the owner said so with the code or since. */
  trusted: boolean
  /** The owner's cap on its places; null — what the machine offers. */
  approvedSlots: number | null
}

/** StepLimits of runner-port.ts, field for field: the notebook step's limits in the numbers docker speaks (limitsFor). */
export interface RemoteStepLimits {
  wallSeconds: number
  memoryMb: number
  cpus: number
  pids: number
  fsizeBytes: number
  tmpfsMb: number
  targetBytes: number
  outputBytes: number
  outputKillBytes: number
}

/**
 * One attempt of one submission, offered to one machine. It names the
 * participant by no name, email or score: ids, pins and limits only.
 */
export interface RemoteLease {
  attemptId: string
  /** The offer's number; the machine acks it by listing the attempt and reports the highest it has written down. */
  seq: number
  competitionId: string
  submissionId: string
  container: string
  /** Until the lease's ceiling, relative: home's clock is the one that counts. */
  deadlineMs: number
  /** The pinned image; the machine runs it as colloq-revision:<id>, tagged after its layers matched. */
  revision: { id: string; ref: string; layers: string }
  harness: string
  limits: RemoteStepLimits
  /** The notebook reads the hidden test: its inputs are `data` with `sealedData`'s files put over them by name. */
  sealed: boolean
  gpu: boolean
  /** With `gpu`: runs per card, pinned when the lease was made, whatever the owner sets next. */
  perDevice?: number
  data: string
  sealedData?: string
  /** `inline` is the notebook itself in base64, up to REMOTE_INLINE_BYTES; otherwise it is fetched as a blob by its sha256. */
  notebook: { sha256: string; bytes: number; inline?: string }
  bundle?: { id: string; packagesMb: number }
}

/** `cancelled`: a cancel, an erase, a deletion. `withdrawn`: an offer never acked. `lost`: home gave up on the run. `unknown`: home holds no such lease. */
export type RemoteRevokeReason = 'cancelled' | 'withdrawn' | 'lost' | 'unknown'
export interface RemoteRevoke {
  id: string
  reason: RemoteRevokeReason
}

export interface RemoteWantRevision {
  id: string
  ref: string
  /**
   * The image's layer fingerprint (image-identity.ts · layersFingerprint):
   * the machine computes it over its own inspect after the pull, and the
   * revision is ready only when the two agree.
   */
  layers: string
  /** A GPU kernel: only machines with cards are asked for it, and it passes the smoke test before it is ready. */
  gpu: boolean
}

export interface RemoteDataFile {
  name: string
  sha256: string
  bytes: number
}

export interface RemoteWantData {
  competitionId: string
  manifest: string
  /** The hidden test's manifest: trusted machines only, in a directory of its own, purged on forget, untrust, revoke, drain and 401. */
  sealed: boolean
  files: RemoteDataFile[]
}

export interface RemoteWheel {
  fileName: string
  sha256: string
  bytes: number
  /** Where the index's CDN serves it, as remoteWheelUrl passes it; absent, or failing, the machine fetches it from home by its sha256. */
  url?: string
}

/**
 * A package set to keep. A set the machine has not reported ready comes with
 * its `lock` and `wheels`, at most REMOTE_BUNDLE_DETAILS_MAX of them in one
 * reply, the sets of its live leases first; a ready one comes by its id
 * alone, which keeps a steady sync a few kilobytes long.
 */
export interface RemoteWantBundle {
  id: string
  packagesMb: number
  lock?: string
  wheels?: RemoteWheel[]
}

/** What home wants a machine to hold: for competitions open, opening within REMOTE_PREFETCH_AHEAD_MS, or with waiting rows. */
export interface RemoteWant {
  revisions: RemoteWantRevision[]
  data: RemoteWantData[]
  bundles: RemoteWantBundle[]
}

export interface RemoteSyncReply {
  /** The highest seq home has offered this machine. */
  seq: number
  /** New offers, and offers not yet acked, repeated until they are or are withdrawn. */
  leases: RemoteLease[]
  revoke: RemoteRevoke[]
  /** Outcomes home has applied: the machine deletes their attempt trees. */
  applied: string[]
  want: RemoteWant
  /** Competitions closed or deleted: drop their data, purge their hidden test. */
  forget: string[]
  /** Finish what is held and take nothing more: the owner's «Осушить», or quarantine. */
  drain: boolean
  /** Whether the machine may hold the hidden test now: false after an untrust, which purges it. */
  trusted: boolean
  approvedSlots: number | null
  /** Runs per card: the machine's own setting, or the instance's «Посылок на карту». */
  perDevice: number
  /** Whether the machine's build is home's: false is «устарел» (remoteCompatible). */
  compatible: boolean
  homeVersion: string
}

/**
 * The harness's words, every one of them: a notebook run may end in any,
 * run.json being the notebook's to forge (docker-runner.ts · asVerdict). A
 * Record over the type, not a list: a word RunVerdict gains stops the build
 * here until it is added, rather than a machine's outcome in a class.
 */
const VERDICT_WORDS = {
  ok: true, cell_error: true, cell_timeout: true, kernel_died: true, exit: true, target_too_large: true, target_unreadable: true,
  harness_error: true, dependency_error: true, 'no-submission': true, 'out-of-memory': true, timeout: true, participant_error: true,
  metric_error: true, unknown: true,
} as const satisfies Record<RunVerdict, true>
const VERDICTS: ReadonlySet<string> = new Set(Object.keys(VERDICT_WORDS))

export type RemoteKilledBy = 'wall' | 'output' | 'disk' | 'gpu' | 'gpu-unread'
const KILLS: ReadonlySet<string> = new Set<RemoteKilledBy>(['wall', 'output', 'disk', 'gpu', 'gpu-unread'])

/** DependencyFailure of runner-port.ts. */
export type RemoteDependencyFailure =
  | { reason: 'no_space'; roomBytes: number }
  | { reason: 'memory'; bytes: number; limitBytes: number }

/** RunDiagnostics of runner-port.ts; the backend is the one the machine ran: Docker, or the stand-in under tests. */
export interface RemoteDiagnostics {
  exit: number | null
  oomKilled: boolean
  backend: 'docker' | 'test'
  killedBy?: RemoteKilledBy
  peakBytes?: number | null
  gpuPeakMb?: number | null
  gpuSamplesMb?: number[]
}

/**
 * RunOutcome of runner-port.ts without its one path (`submission`), plus what
 * home cannot see from where it is: whether the answer was written
 * (`produced`), whether a neighbour's burst on the card crowded this run out
 * (`crowded`: the machine keeps the window, runner.ts · neighbourVerdict), and
 * the card it ran on.
 */
export interface RemoteRunOutcome {
  status: RunVerdict
  cell: number
  cells: number
  wall: number
  produced: boolean
  detail: string
  log: string
  dependencyFailure?: RemoteDependencyFailure
  diagnostics: RemoteDiagnostics
  crowded: boolean
  card?: { device: string; perDevice: number; sliceMb: number | null }
}

/** A file the machine has PUT for an attempt, as it was before gzip. */
export interface RemoteResultFile {
  name: RemoteFileName
  bytes: number
  sha256: string
}

export interface RemoteFinishedRequest {
  protocol: typeof REMOTE_PROTOCOL
  build: string
  /** As it is now that the attempt is over, so that the reply can carry the next lease. */
  free: RemoteFree
  kind: 'finished'
  outcome: RemoteRunOutcome
  /** The harness's run.json as the export took it out, in base64 (exact bytes, nothing to escape); null — the harness wrote none. */
  runJson: string | null
  files: RemoteResultFile[]
}

/**
 * `image`, `data`, `wheels`: not in place after all. `disk`, `memory`,
 * `card`: no room left for it. `draining`: the machine stops, and gives back
 * even a started run when its owner says `--now`. `version`: the lease names a
 * harness or a protocol this build does not have.
 */
export type RemoteDeclineReason = 'image' | 'data' | 'wheels' | 'disk' | 'memory' | 'card' | 'draining' | 'version'

export interface RemoteDeclinedRequest {
  protocol: typeof REMOTE_PROTOCOL
  build: string
  free: RemoteFree
  kind: 'declined'
  reason: RemoteDeclineReason
  detail: string
}

export type RemoteOutcomeRequest = RemoteFinishedRequest | RemoteDeclinedRequest

/**
 * `applied`: the outcome (or the decline) took effect. `refused`: home could
 * not use the result (its files missing or not as listed), and the lease is
 * lost. `revoked`: the lease had been revoked before the outcome came. In all
 * three the machine deletes the attempt and never posts it again.
 */
export interface RemoteOutcomeReply {
  result: 'applied' | 'refused' | 'revoked'
  seq: number
  /** The next work, at once, without waiting for a sync. */
  leases: RemoteLease[]
}

/** What home answers a stored upload: the file as it now holds it. */
export interface RemoteUploadReply {
  name: RemoteFileName
  sha256: string
  bytes: number
}

/** An upload as its headers describe it, before a byte of its body is read. */
export type RemoteUploadMeta = RemoteUploadReply

/**
 * Every refusal of the router, by the code in its body (`{ error, detail? }`)
 * and its status. The agent acts on the code; the status is for whatever sits
 * in between. 429, 503 and 507 come with Retry-After.
 */
export const REMOTE_ERRORS = {
  /** A body, a header or a path that does not parse: the agent's bug, never retried as it is. */
  invalid: 400,
  /** No credential, an unknown one, or a machine revoked or gone: purge the hidden test and stop. */
  unauthorized: 401,
  /** join: the code is unknown, expired or used up. */
  code: 403,
  /** A blob outside this machine's scope, or an attempt it does not hold. */
  not_found: 404,
  /** The attempt was cancelled, erased or lost: discard it and send nothing more about it. */
  revoked: 409,
  /** A second, different outcome for an attempt home has already settled. */
  conflict: 409,
  /** A blob whose file has been replaced since: the next sync's `want` names the new one. */
  gone: 410,
  /** A body over its cap, or an upload over its own once decompressed. */
  too_large: 413,
  /** An upload whose bytes do not match its X-Colloq-Sha256 and X-Colloq-Bytes. */
  mismatch: 422,
  /** Another version of this contract: the machine needs the release home runs. */
  protocol: 426,
  /** Over a rate limit or the blob streams. */
  too_often: 429,
  /** Home's own failure: back off and try again. */
  failed: 500,
  /** Uploads at their limit (REMOTE_UPLOADS). */
  busy: 503,
  /** Home's disk below REMOTE_UPLOAD_FREE_BYTES. */
  disk: 507,
} as const
export type RemoteErrorCode = keyof typeof REMOTE_ERRORS
export interface RemoteErrorReply {
  error: RemoteErrorCode
  detail?: string
}

/* ----------------------------------------------------------------- parsers */

/**
 * What every parser here throws. `code` is the router's answer to it
 * (REMOTE_ERRORS): `protocol` for a request in another version of this
 * contract, `too_large` for an upload declared over its cap, `invalid` for
 * everything else. The agent takes a reply it cannot parse for a transient
 * one: a proxy that mangled one reply is no reason to drop a lease.
 */
export class RemoteProtocolError extends Error {
  override name = 'RemoteProtocolError'
  constructor(message: string, readonly code: 'invalid' | 'protocol' | 'too_large' = 'invalid') {
    super(message)
  }
}

export function parseRemoteJoinRequest(value: unknown): RemoteJoinRequest {
  const v = spoken(value, 'join request', ['protocol', 'build', 'code', 'joinId', 'facts'])
  if (!matching(v.code, REMOTE_JOIN_CODE) || !matching(v.joinId, REMOTE_JOIN_ID)) refuse('Invalid join request')
  factsOf(v.facts)
  return v as unknown as RemoteJoinRequest
}

export function parseRemoteJoinReply(value: unknown): RemoteJoinReply {
  const v = fields(value, 'join reply', ['runnerId', 'secret', 'trusted', 'approvedSlots'])
  if (!matching(v.runnerId, REMOTE_RUNNER_ID) || !matching(v.secret, REMOTE_SECRET) || !flag(v.trusted) || !slots(v.approvedSlots)) refuse('Invalid join reply')
  return v as unknown as RemoteJoinReply
}

const STATES: ReadonlySet<string> = new Set<RemoteRunnerState>(['active', 'draining', 'leaving'])

export function parseRemoteSyncRequest(value: unknown): RemoteSyncRequest {
  const v = spoken(value, 'sync request', ['protocol', 'build', 'seq', 'holdMs', 'state', 'free', 'cards', 'ready', 'fetching', 'attempts', 'problems', 'facts'])
  if (!integer(v.seq, 0, Number.MAX_SAFE_INTEGER) || !integer(v.holdMs, 0, REMOTE_HOLD_IDLE_MS) || !word(v.state, STATES)) refuse('Invalid sync request')
  freeOf(v.free)
  cardsOf(v.cards)
  readyOf(v.ready)
  fetchingOf(v.fetching)
  const held = attemptsOf(v.attempts)
  problemsOf(v.problems)
  if (v.facts !== undefined) factsOf(v.facts)
  // While anything is held, progress (and the silence rule) must not wait longer than this.
  if (held.length > 0 && (v.holdMs as number) > REMOTE_HOLD_BUSY_MS) refuse('Sync held too long for a busy machine')
  return v as unknown as RemoteSyncRequest
}

const REVOKE_REASONS: ReadonlySet<string> = new Set<RemoteRevokeReason>(['cancelled', 'withdrawn', 'lost', 'unknown'])

export function parseRemoteSyncReply(value: unknown): RemoteSyncReply {
  const v = fields(value, 'sync reply', ['seq', 'leases', 'revoke', 'applied', 'want', 'forget', 'drain', 'trusted', 'approvedSlots', 'perDevice', 'compatible', 'homeVersion'])
  if (!integer(v.seq, 0, Number.MAX_SAFE_INTEGER) || !flag(v.drain) || !flag(v.trusted) || !flag(v.compatible) || !slots(v.approvedSlots)
    || !integer(v.perDevice, 1, REMOTE_PER_DEVICE_MAX) || !matching(v.homeVersion, REMOTE_VERSION)) refuse('Invalid sync reply')
  const leases = leasesOf(v.leases, v.seq as number)
  const revoked = new Set<string>()
  for (const item of items(v.revoke, 'revokes', REMOTE_ATTEMPTS_MAX)) {
    const r = fields(item, 'revoke', ['id', 'reason'])
    if (!matching(r.id, COMPETITION_ATTEMPT_ID) || revoked.has(r.id) || !word(r.reason, REVOKE_REASONS)) refuse('Invalid revoke')
    revoked.add(r.id)
  }
  const applied = distinct(v.applied, 'applied attempts', COMPETITION_ATTEMPT_ID, REMOTE_ATTEMPTS_MAX)
  // An attempt is offered, revoked or applied, never two of them in one breath.
  if (leases.some((lease) => revoked.has(lease.attemptId) || applied.includes(lease.attemptId)) || applied.some((id) => revoked.has(id))) refuse('Contradictory sync reply')
  const want = wantOf(v.want)
  const forget = distinct(v.forget, 'forgotten competitions', COMPETITION_ROW_ID, REMOTE_MANIFESTS_MAX)
  if (want.data.some((entry) => forget.includes(entry.competitionId))) refuse('Contradictory sync reply')
  // The hidden test reaches trusted machines only (decision 1): an untrusted one keeps none of it, whatever a reply says.
  if (!v.trusted && (want.data.some((entry) => entry.sealed) || leases.some((lease) => lease.sealed))) refuse('Hidden test for an untrusted machine')
  return v as unknown as RemoteSyncReply
}

/**
 * An upload's headers: the file's name from the path, Content-Encoding,
 * X-Colloq-Sha256 and X-Colloq-Bytes as they arrived. `targetBytes` is the
 * lease's answer cap; the notebook's is REMOTE_FILE_BYTES. Declared over its
 * cap, a file is refused before a byte of it is read.
 */
export function parseRemoteUploadMeta(
  input: { name: unknown; encoding: unknown; sha256: unknown; bytes: unknown },
  targetBytes: number = REMOTE_FILE_BYTES,
): RemoteUploadMeta {
  if (!matching(input.name, REMOTE_FILE_NAME)) refuse('Unexpected result file')
  if (typeof input.encoding !== 'string' || input.encoding.trim().toLowerCase() !== 'gzip') refuse('Invalid result encoding')
  if (!matching(input.sha256, REMOTE_SHA256) || !matching(input.bytes, /^(?:0|[1-9][0-9]{0,15})$/)) refuse('Invalid result metadata')
  const bytes = Number(input.bytes)
  if (bytes > (input.name === SUBMISSION ? Math.min(targetBytes, REMOTE_FILE_BYTES) : REMOTE_FILE_BYTES)) refuse('Result file over its cap', 'too_large')
  return { name: input.name as RemoteFileName, sha256: input.sha256, bytes }
}

export function parseRemoteUploadReply(value: unknown): RemoteUploadReply {
  const v = fields(value, 'upload reply', ['name', 'sha256', 'bytes'])
  if (!matching(v.name, REMOTE_FILE_NAME) || !matching(v.sha256, REMOTE_SHA256) || !integer(v.bytes, 0, REMOTE_FILE_BYTES)) refuse('Invalid upload reply')
  return v as unknown as RemoteUploadReply
}

const DECLINE_REASONS: ReadonlySet<string> = new Set<RemoteDeclineReason>(['image', 'data', 'wheels', 'disk', 'memory', 'card', 'draining', 'version'])
const OUTCOME_KEYS = {
  finished: ['protocol', 'build', 'free', 'kind', 'outcome', 'runJson', 'files'],
  declined: ['protocol', 'build', 'free', 'kind', 'reason', 'detail'],
} as const

export function parseRemoteOutcomeRequest(value: unknown): RemoteOutcomeRequest {
  const v = spoken(value, 'outcome', [...OUTCOME_KEYS.finished, ...OUTCOME_KEYS.declined])
  if (v.kind !== 'finished' && v.kind !== 'declined') refuse('Invalid outcome kind')
  fields(v, `${v.kind} outcome`, OUTCOME_KEYS[v.kind])
  freeOf(v.free)
  if (v.kind === 'declined') {
    if (!word(v.reason, DECLINE_REASONS) || !within(v.detail, REMOTE_REASON_CHARS)) refuse('Invalid decline')
    return v as unknown as RemoteDeclinedRequest
  }
  const outcome = runOutcomeOf(v.outcome)
  if (v.runJson !== null && !(base64Bytes(v.runJson) >= 0 && base64Bytes(v.runJson) <= REMOTE_RUN_JSON_BYTES)) refuse('Invalid run report')
  const names = new Set<string>()
  for (const item of items(v.files, 'result files', REMOTE_FILE_NAMES.length)) {
    const f = fields(item, 'result file', ['name', 'bytes', 'sha256'])
    if (!matching(f.name, REMOTE_FILE_NAME) || names.has(f.name) || !integer(f.bytes, 0, REMOTE_FILE_BYTES) || !matching(f.sha256, REMOTE_SHA256)) refuse('Invalid result file')
    names.add(f.name)
  }
  // The answer comes back with a run that wrote it and always with one that succeeded: home scores nothing else.
  if ((names.has(SUBMISSION) && !outcome.produced) || (outcome.status === 'ok' && !names.has(SUBMISSION))) refuse('Result files disagree with the outcome')
  return v as unknown as RemoteFinishedRequest
}

const OUTCOME_RESULTS: ReadonlySet<string> = new Set<RemoteOutcomeReply['result']>(['applied', 'refused', 'revoked'])

export function parseRemoteOutcomeReply(value: unknown): RemoteOutcomeReply {
  const v = fields(value, 'outcome reply', ['result', 'seq', 'leases'])
  if (!word(v.result, OUTCOME_RESULTS) || !integer(v.seq, 0, Number.MAX_SAFE_INTEGER)) refuse('Invalid outcome reply')
  leasesOf(v.leases, v.seq as number)
  return v as unknown as RemoteOutcomeReply
}

export function parseRemoteErrorReply(value: unknown): RemoteErrorReply {
  const v = fields(value, 'error reply', ['error', 'detail'])
  if (typeof v.error !== 'string' || !Object.hasOwn(REMOTE_ERRORS, v.error) || (v.detail !== undefined && !within(v.detail, REMOTE_REASON_CHARS))) refuse('Invalid error reply')
  return v as unknown as RemoteErrorReply
}

/* --------------------------------------------------------- parts of them */

function freeOf(value: unknown): RemoteFree {
  const v = fields(value, 'free capacity', ['slots', 'memoryMb', 'cpus', 'gpuShares', 'diskMb'])
  if (!integer(v.slots, 0, REMOTE_ATTEMPTS_MAX) || !integer(v.memoryMb, 0, REMOTE_MEMORY_MB_MAX) || !integer(v.cpus, 0, REMOTE_CPUS_MAX)
    || !integer(v.gpuShares, 0, REMOTE_CARDS_MAX * REMOTE_PER_DEVICE_MAX) || !integer(v.diskMb, 0, REMOTE_DISK_MB_MAX)) refuse('Invalid free capacity')
  return v as unknown as RemoteFree
}

function factsOf(value: unknown): RemoteFacts {
  const v = fields(value, 'machine facts', ['version', 'hostname', 'platform', 'cpus', 'memoryMb', 'diskMb', 'docker', 'storage', 'driver'])
  if (!matching(v.version, REMOTE_VERSION) || !label(v.hostname, REMOTE_HOSTNAME_CHARS) || !matching(v.platform, /^linux\/[a-z0-9_]{1,16}$/)
    || !integer(v.cpus, 1, REMOTE_CPUS_MAX) || !integer(v.memoryMb, 1, REMOTE_MEMORY_MB_MAX) || !integer(v.diskMb, 0, REMOTE_DISK_MB_MAX)
    || !label(v.docker, REMOTE_LABEL_CHARS) || !label(v.storage, REMOTE_LABEL_CHARS)
    || !(v.driver === null || matching(v.driver, /^[0-9]{1,4}(?:\.[0-9]{1,4}){0,3}$/))) refuse('Invalid machine facts')
  return v as unknown as RemoteFacts
}

function cardsOf(value: unknown): RemoteCard[] {
  const seen = new Set<string>()
  for (const item of items(value, 'cards', REMOTE_CARDS_MAX)) {
    const v = fields(item, 'card', ['device', 'name', 'memoryMb', 'perDevice', 'busyShares'])
    if (!matching(v.device, REMOTE_DEVICE) || seen.has(v.device) || !(v.name === null || label(v.name, REMOTE_LABEL_CHARS))
      || !(v.memoryMb === null || integer(v.memoryMb, 1, REMOTE_CARD_MB_MAX)) || !integer(v.perDevice, 1, REMOTE_PER_DEVICE_MAX)
      || !integer(v.busyShares, 0, REMOTE_PER_DEVICE_MAX)) refuse('Invalid card')
    seen.add(v.device)
  }
  return value as RemoteCard[]
}

function readyOf(value: unknown): RemoteReady {
  const v = fields(value, 'readiness', ['revisions', 'data', 'sealed', 'bundles'])
  distinct(v.revisions, 'ready revisions', REMOTE_REVISION_ID, REMOTE_REVISIONS_MAX)
  distinct(v.data, 'ready data', REMOTE_SHA256, REMOTE_MANIFESTS_MAX)
  distinct(v.sealed, 'ready hidden data', REMOTE_SHA256, REMOTE_MANIFESTS_MAX)
  distinct(v.bundles, 'ready package sets', REMOTE_BUNDLE_ID, REMOTE_BUNDLES_MAX)
  return v as unknown as RemoteReady
}

type Subject = 'revision' | 'manifest' | 'bundle'
const SUBJECTS = [['revisionId', 'revision', REMOTE_REVISION_ID], ['manifest', 'manifest', REMOTE_SHA256], ['bundleId', 'bundle', REMOTE_BUNDLE_ID]] as const

/** What a problem or a fetch is about: at most one of a revision, a data manifest and a package set, each in its pattern. */
function subjectOf(v: Record<string, unknown>, what: string): Subject | null {
  const named = SUBJECTS.filter(([key]) => v[key] !== undefined)
  if (named.length > 1 || named.some(([key, , pattern]) => !matching(v[key], pattern))) refuse(`Invalid ${what}`)
  return named[0]?.[1] ?? null
}

function fetchingOf(value: unknown): RemoteFetch[] {
  const seen = new Set<string>()
  for (const item of items(value, 'fetches', REMOTE_FETCHING_MAX)) {
    const v = fields(item, 'fetch', ['revisionId', 'manifest', 'bundleId', 'percent'])
    const about = subjectOf(v, 'fetch')
    const key = `${about}:${String(v.revisionId ?? v.manifest ?? v.bundleId)}`
    if (about === null || seen.has(key) || !integer(v.percent, 0, 100)) refuse('Invalid fetch')
    seen.add(key)
  }
  return value as RemoteFetch[]
}

const PHASES: ReadonlySet<string> = new Set<RemoteAttemptPhase>(['accepted', 'preparing', 'running', 'exporting', 'uploading'])
/** The phases after the container's start: a run lost from here on cost its machine time (lost++), and its time is known. */
const STARTED: ReadonlySet<string> = new Set<RemoteAttemptPhase>(['running', 'exporting', 'uploading'])

function attemptsOf(value: unknown): RemoteHeldAttempt[] {
  const seen = new Set<string>()
  for (const item of items(value, 'attempts', REMOTE_ATTEMPTS_MAX)) {
    const v = fields(item, 'attempt', ['id', 'phase', 'runningMs', 'progress', 'card'])
    if (!matching(v.id, COMPETITION_ATTEMPT_ID) || seen.has(v.id) || !word(v.phase, PHASES)) refuse('Invalid attempt')
    seen.add(v.id)
    /*
     * Every phase after the start says how long the container has run, not
     * only `running`: a run short enough to end between two syncs is first
     * heard of as `uploading`, and home sets started_at from it all the same.
     */
    if (STARTED.has(v.phase) ? !integer(v.runningMs, 0, REMOTE_RUN_MS_MAX) : v.runningMs !== undefined) refuse('Invalid attempt run time')
    if (v.progress !== undefined) {
      if (v.phase !== 'running') refuse('Unexpected attempt progress')
      const p = fields(v.progress, 'progress', ['phase', 'cell', 'cells'])
      if ((p.phase !== 'dependencies' && p.phase !== 'notebook') || !integer(p.cell, -1, REMOTE_CELLS_MAX) || !integer(p.cells, 0, REMOTE_CELLS_MAX)) refuse('Invalid progress')
    }
    if (v.card !== undefined) {
      // A card is picked at prepare, never before: an accepted lease holds none yet.
      if (v.phase === 'accepted') refuse('Unexpected attempt card')
      const c = fields(v.card, 'attempt card', ['device', 'sliceMb'])
      if (!matching(c.device, REMOTE_DEVICE) || !(c.sliceMb === null || integer(c.sliceMb, 1, REMOTE_CARD_MB_MAX))) refuse('Invalid attempt card')
    }
  }
  return value as RemoteHeldAttempt[]
}

const PROBLEM_SUBJECTS: Readonly<Record<RemoteProblemCode, Subject | null>> = {
  image: 'revision', layers: 'revision', smoke: 'revision', data: 'manifest', wheels: 'bundle', disk: null, docker: null, cards: null,
}

function problemsOf(value: unknown): RemoteProblem[] {
  for (const item of items(value, 'problems', REMOTE_PROBLEMS_MAX)) {
    const v = fields(item, 'problem', ['code', 'revisionId', 'manifest', 'bundleId', 'detail'])
    if (typeof v.code !== 'string' || !Object.hasOwn(PROBLEM_SUBJECTS, v.code) || subjectOf(v, 'problem') !== PROBLEM_SUBJECTS[v.code as RemoteProblemCode]
      || !within(v.detail, REMOTE_REASON_CHARS)) refuse('Invalid problem')
  }
  return value as RemoteProblem[]
}

function leasesOf(value: unknown, seq: number): RemoteLease[] {
  const seen = new Set<string>()
  let inline = 0
  for (const item of items(value, 'leases', REMOTE_ATTEMPTS_MAX)) {
    const lease = leaseOf(item)
    if (seen.has(lease.attemptId) || lease.seq > seq) refuse('Invalid lease')
    seen.add(lease.attemptId)
    if (lease.notebook.inline !== undefined) inline += lease.notebook.bytes
  }
  if (inline > REMOTE_INLINE_TOTAL_BYTES) refuse('Inline notebooks over their budget')
  return value as RemoteLease[]
}

function leaseOf(value: unknown): RemoteLease {
  const v = fields(value, 'lease', ['attemptId', 'seq', 'competitionId', 'submissionId', 'container', 'deadlineMs', 'revision', 'harness',
    'limits', 'sealed', 'gpu', 'perDevice', 'data', 'sealedData', 'notebook', 'bundle'])
  if (!matching(v.attemptId, COMPETITION_ATTEMPT_ID) || !integer(v.seq, 1, Number.MAX_SAFE_INTEGER) || !matching(v.competitionId, COMPETITION_ROW_ID)
    || !matching(v.submissionId, COMPETITION_ROW_ID) || !integer(v.deadlineMs, 1, REMOTE_RUN_MS_MAX) || !matching(v.harness, REMOTE_HARNESS)
    || !matching(v.data, REMOTE_SHA256) || !flag(v.sealed) || !flag(v.gpu)) refuse('Invalid lease')
  // The container is named after its own submission (runner.ts · containerName), so a kill by name can only reach this run.
  if (!matching(v.container, REMOTE_CONTAINER) || !v.container.startsWith(`colloq-comp-${v.submissionId}-`)) refuse('Invalid lease container')
  imageOf(v.revision, 'lease revision', ['id', 'ref', 'layers'])
  limitsOf(v.limits)
  // The hidden test's manifest comes with a sealed lease and with nothing else.
  if (v.sealed ? !matching(v.sealedData, REMOTE_SHA256) : v.sealedData !== undefined) refuse('Unexpected hidden data')
  if (v.gpu ? !integer(v.perDevice, 1, REMOTE_PER_DEVICE_MAX) : v.perDevice !== undefined) refuse('Unexpected card share')
  const n = fields(v.notebook, 'lease notebook', ['sha256', 'bytes', 'inline'])
  if (!matching(n.sha256, REMOTE_SHA256) || !integer(n.bytes, 1, REMOTE_NOTEBOOK_BYTES)) refuse('Invalid lease notebook')
  if (n.inline !== undefined && (n.bytes > REMOTE_INLINE_BYTES || base64Bytes(n.inline) !== n.bytes)) refuse('Invalid inline notebook')
  if (v.bundle !== undefined) {
    const b = fields(v.bundle, 'lease package set', ['id', 'packagesMb'])
    if (!matching(b.id, REMOTE_BUNDLE_ID) || !packagesMb(b.packagesMb)) refuse('Invalid lease package set')
  }
  return v as unknown as RemoteLease
}

function imageOf(value: unknown, what: string, keys: readonly string[]): Record<string, unknown> {
  const v = fields(value, what, keys)
  if (!matching(v.id, REMOTE_REVISION_ID) || typeof v.ref !== 'string' || v.ref.length > REF_CHARS || !REMOTE_IMAGE_REF.test(v.ref) || !matching(v.layers, REMOTE_SHA256)) refuse(`Invalid ${what}`)
  return v
}

/** The broker's own bounds for a notebook's limits (competition-runtime.ts · parseCompetitionJobIntent), and the caps limitsFor sets. */
function limitsOf(value: unknown): RemoteStepLimits {
  const v = fields(value, 'lease limits', ['wallSeconds', 'memoryMb', 'cpus', 'pids', 'fsizeBytes', 'tmpfsMb', 'targetBytes', 'outputBytes', 'outputKillBytes'])
  if (!integer(v.wallSeconds, 1, REMOTE_WALL_SECONDS_MAX) || !integer(v.memoryMb, 128, 65536) || !integer(v.cpus, 1, 32) || !integer(v.pids, 16, 2048)
    || !integer(v.fsizeBytes, 1, 1024 ** 3) || !integer(v.tmpfsMb, 16, 4096) || !integer(v.targetBytes, 1, REMOTE_FILE_BYTES)
    || !integer(v.outputBytes, 0, 1024 ** 3) || !integer(v.outputKillBytes, 0, 1024 ** 3)) refuse('Invalid lease limits')
  return v as unknown as RemoteStepLimits
}

function wantOf(value: unknown): RemoteWant {
  const v = fields(value, 'want', ['revisions', 'data', 'bundles'])
  const revisions = new Set<string>()
  for (const item of items(v.revisions, 'wanted revisions', REMOTE_REVISIONS_MAX)) {
    const r = imageOf(item, 'wanted revision', ['id', 'ref', 'layers', 'gpu'])
    if (revisions.has(r.id as string) || !flag(r.gpu)) refuse('Invalid wanted revision')
    revisions.add(r.id as string)
  }
  const manifests = new Set<string>()
  for (const item of items(v.data, 'wanted data', REMOTE_MANIFESTS_MAX)) {
    const d = fields(item, 'wanted data', ['competitionId', 'manifest', 'sealed', 'files'])
    if (!matching(d.competitionId, COMPETITION_ROW_ID) || !matching(d.manifest, REMOTE_SHA256) || manifests.has(d.manifest) || !flag(d.sealed)) refuse('Invalid wanted data')
    manifests.add(d.manifest)
    filesOf(d.files)
  }
  const bundles = new Set<string>()
  let described = 0
  for (const item of items(v.bundles, 'wanted package sets', REMOTE_BUNDLES_MAX)) {
    const b = fields(item, 'wanted package set', ['id', 'packagesMb', 'lock', 'wheels'])
    if (!matching(b.id, REMOTE_BUNDLE_ID) || bundles.has(b.id) || !packagesMb(b.packagesMb)) refuse('Invalid wanted package set')
    bundles.add(b.id)
    if (b.lock === undefined && b.wheels === undefined) continue
    // A lock and its wheels come together, or neither does: half a set installs nothing.
    if (!within(b.lock, REMOTE_LOCK_CHARS) || !/^[\x20-\x7E\n]*$/.test(b.lock) || ++described > REMOTE_BUNDLE_DETAILS_MAX) refuse('Invalid wanted package set')
    wheelsOf(b.wheels)
  }
  return v as unknown as RemoteWant
}

function filesOf(value: unknown): void {
  const names = new Set<string>()
  let bytes = 0
  for (const item of items(value, 'data files', REMOTE_DATA_FILES_MAX)) {
    const f = fields(item, 'data file', ['name', 'sha256', 'bytes'])
    if (!dataName(f.name) || names.has(f.name) || !matching(f.sha256, REMOTE_SHA256) || !integer(f.bytes, 0, REMOTE_DATA_BYTES)) refuse('Invalid data file')
    names.add(f.name)
    bytes += f.bytes
  }
  if (bytes > REMOTE_DATA_BYTES) refuse('Data over its cap')
}

function wheelsOf(value: unknown): void {
  const names = new Set<string>()
  let bytes = 0
  for (const item of items(value, 'wheels', REMOTE_WHEELS_MAX)) {
    const w = fields(item, 'wheel', ['fileName', 'sha256', 'bytes', 'url'])
    if (!matching(w.fileName, REMOTE_WHEEL_NAME) || names.has(w.fileName) || !matching(w.sha256, REMOTE_SHA256) || !integer(w.bytes, 0, REMOTE_WHEELS_BYTES)
      || (w.url !== undefined && remoteWheelUrl(w.url) !== w.url)) refuse('Invalid wheel')
    names.add(w.fileName)
    bytes += w.bytes
  }
  if (bytes > REMOTE_WHEELS_BYTES) refuse('Wheels over their cap')
}

/**
 * A wheel's address as `want` may carry it, in its canonical form, or
 * undefined: https, with no credentials and no fragment — the rule the set's
 * manifest was kept by (preparation-contract.ts · wheelUrl), which checked the
 * host and the file name as well when the set was prepared. Credentials in a
 * file's URL would travel to every machine and into its logs, and a mirror for
 * participants' packages allows anonymous reads (dependency-source.ts). Home
 * passes a stored address through this before it lists the wheel, and one
 * this drops is fetched from home by its hash instead: the parser takes only
 * what this returns, so an odd address costs a download, never a reply.
 */
export function remoteWheelUrl(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length > REMOTE_URL_CHARS) return undefined
  try {
    const url = new URL(value)
    if (url.protocol !== 'https:' || !url.hostname || url.username || url.password || url.hash || url.href.length > REMOTE_URL_CHARS) return undefined
    return url.href
  } catch {
    return undefined
  }
}

const DEPENDENCY_REASONS = { no_space: ['reason', 'roomBytes'], memory: ['reason', 'bytes', 'limitBytes'] } as const

function runOutcomeOf(value: unknown): RemoteRunOutcome {
  const v = fields(value, 'run outcome', ['status', 'cell', 'cells', 'wall', 'produced', 'detail', 'log', 'dependencyFailure', 'diagnostics', 'crowded', 'card'])
  if (!word(v.status, VERDICTS) || !integer(v.cell, -1, REMOTE_CELLS_MAX) || !integer(v.cells, 0, REMOTE_CELLS_MAX) || !integer(v.wall, 0, REMOTE_RUN_MS_MAX)
    || !flag(v.produced) || !within(v.detail, REMOTE_DETAIL_CHARS) || !within(v.log, REMOTE_LOG_CHARS) || !flag(v.crowded)) refuse('Invalid run outcome')
  if (v.dependencyFailure !== undefined) {
    // Only a set that failed to install says why (docker-runner.ts · dependencyFailureOf).
    const reason = (v.dependencyFailure as { reason?: unknown } | null)?.reason
    if (v.status !== 'dependency_error' || (reason !== 'no_space' && reason !== 'memory')) refuse('Unexpected dependency failure')
    const f = fields(v.dependencyFailure, 'dependency failure', DEPENDENCY_REASONS[reason])
    if (reason === 'no_space' ? !integer(f.roomBytes, 0, Number.MAX_SAFE_INTEGER) : !integer(f.bytes, 0, Number.MAX_SAFE_INTEGER) || !integer(f.limitBytes, 0, Number.MAX_SAFE_INTEGER)) refuse('Invalid dependency failure')
  }
  const d = fields(v.diagnostics, 'diagnostics', ['exit', 'oomKilled', 'backend', 'killedBy', 'peakBytes', 'gpuPeakMb', 'gpuSamplesMb'])
  if (!(d.exit === null || integer(d.exit, 0, 255)) || !flag(d.oomKilled) || (d.backend !== 'docker' && d.backend !== 'test')
    || (d.killedBy !== undefined && !word(d.killedBy, KILLS))
    || (d.peakBytes !== undefined && d.peakBytes !== null && !integer(d.peakBytes, 0, Number.MAX_SAFE_INTEGER))
    || (d.gpuPeakMb !== undefined && d.gpuPeakMb !== null && !integer(d.gpuPeakMb, 0, REMOTE_CARD_MB_MAX))) refuse('Invalid diagnostics')
  if (d.gpuSamplesMb !== undefined) {
    for (const sample of items(d.gpuSamplesMb, 'card samples', REMOTE_GPU_SAMPLES_MAX)) if (!integer(sample, 0, REMOTE_CARD_MB_MAX)) refuse('Invalid card samples')
  }
  if (v.card !== undefined) {
    const c = fields(v.card, 'run card', ['device', 'perDevice', 'sliceMb'])
    if (!matching(c.device, REMOTE_DEVICE) || !integer(c.perDevice, 1, REMOTE_PER_DEVICE_MAX) || !(c.sliceMb === null || integer(c.sliceMb, 1, REMOTE_CARD_MB_MAX))) refuse('Invalid run card')
  } else if (v.crowded === true || d.killedBy === 'gpu' || d.killedBy === 'gpu-unread' || d.gpuPeakMb !== undefined || d.gpuSamplesMb !== undefined) {
    // All of these were seen on a card: a run without one had no share to be crowded on, killed for or measured against.
    refuse('Card diagnostics without a card')
  }
  return v as unknown as RemoteRunOutcome
}

/* --------------------------------------------- what the agent sends, made safe */

/**
 * A measured number as the contract carries it: whole, inside its range, and
 * `min` for NaN or an infinity. For what the machine measures itself (free
 * capacity, runningMs, a card's memory), whose clock may jump and whose
 * meminfo may say anything.
 */
export function remoteCount(value: number, min: number, max: number): number {
  return Number.isFinite(value) ? Math.min(max, Math.max(min, Math.trunc(value))) : min
}

/**
 * A text cut to `max` UTF-16 units, keeping its start (a reason: its first
 * line says what failed) or its end (a traceback: its last line is the
 * exception home reads, runner.ts · missingPackageHint), never with half of a
 * surrogate pair at the cut.
 */
export function remoteText(text: string, max: number, keep: 'start' | 'end'): string {
  if (text.length <= max) return text
  if (max <= 0) return ''
  if (keep === 'start') {
    const head = text.slice(0, max)
    return /[\uD800-\uDBFF]$/.test(head) ? head.slice(0, -1) : head
  }
  const tail = text.slice(text.length - max)
  return /^[\uDC00-\uDFFF]/.test(tail) ? tail.slice(1) : tail
}

/** A progress beacon as it may travel: whole cells within REMOTE_CELLS_MAX, whatever progress.json said. */
export function remoteProgress(raw: { phase?: string; cell: number; cells: number }): RemoteProgress {
  return {
    phase: raw.phase === 'dependencies' ? 'dependencies' : 'notebook',
    cell: remoteCount(raw.cell, -1, REMOTE_CELLS_MAX),
    cells: remoteCount(raw.cells, 0, REMOTE_CELLS_MAX),
  }
}

/**
 * What remoteOutcome takes: the runner's RunOutcome as DockerCompetitionRunner
 * returns it (its `submission` path is dropped), with what only the machine
 * knows next to it.
 */
export interface RemoteOutcomeSource {
  status: string
  cell: number
  cells: number
  wall: number
  detail: string
  log: string
  dependencyFailure?: RemoteDependencyFailure
  diagnostics: {
    exit: number | null
    oomKilled: boolean
    backend: string
    killedBy?: RemoteKilledBy
    peakBytes?: number | null
    gpuPeakMb?: number | null
    gpuSamplesMb?: readonly number[]
  }
  produced: boolean
  crowded?: boolean
  card?: { device: string; perDevice: number; sliceMb: number | null } | null
}

/**
 * A run's outcome as it may travel. An honest run passes unchanged; what a
 * forged run.json could make of it (a fractional or negative cell, a peak of
 * 1e300, a word the harness never says, a traceback of 60 KB) is made whole
 * and cut to the caps, so that the outcome is applied — and the participant
 * reads what home makes of it, as on home's own runs — instead of being
 * refused, lost and run again elsewhere.
 */
export function remoteOutcome(raw: RemoteOutcomeSource): RemoteRunOutcome {
  const status = VERDICTS.has(raw.status) ? (raw.status as RunVerdict) : 'unknown'
  const bytes = (value: number): number => remoteCount(value, 0, Number.MAX_SAFE_INTEGER)
  const measured = (value: number | null, max: number): number | null => (value !== null && Number.isFinite(value) ? remoteCount(value, 0, max) : null)
  const failure = raw.dependencyFailure
  const d = raw.diagnostics
  const card = raw.card ?? undefined
  return {
    status,
    cell: remoteCount(raw.cell, -1, REMOTE_CELLS_MAX),
    cells: remoteCount(raw.cells, 0, REMOTE_CELLS_MAX),
    wall: remoteCount(raw.wall, 0, REMOTE_RUN_MS_MAX),
    produced: raw.produced === true,
    detail: remoteText(typeof raw.detail === 'string' ? raw.detail : '', REMOTE_DETAIL_CHARS, 'end'),
    log: remoteText(typeof raw.log === 'string' ? raw.log : '', REMOTE_LOG_CHARS, 'end'),
    ...(status === 'dependency_error' && failure
      ? { dependencyFailure: failure.reason === 'no_space'
        ? { reason: 'no_space' as const, roomBytes: bytes(failure.roomBytes) }
        : { reason: 'memory' as const, bytes: bytes(failure.bytes), limitBytes: bytes(failure.limitBytes) } }
      : {}),
    diagnostics: {
      exit: integer(d.exit, 0, 255) ? d.exit : null,
      oomKilled: d.oomKilled === true,
      backend: d.backend === 'test' ? 'test' : 'docker',
      ...(d.killedBy !== undefined && KILLS.has(d.killedBy) ? { killedBy: d.killedBy } : {}),
      ...(d.peakBytes !== undefined ? { peakBytes: measured(d.peakBytes, Number.MAX_SAFE_INTEGER) } : {}),
      ...(d.gpuPeakMb !== undefined ? { gpuPeakMb: measured(d.gpuPeakMb, REMOTE_CARD_MB_MAX) } : {}),
      ...(d.gpuSamplesMb !== undefined ? { gpuSamplesMb: d.gpuSamplesMb.slice(-REMOTE_GPU_SAMPLES_MAX).map((mb) => remoteCount(mb, 0, REMOTE_CARD_MB_MAX)) } : {}),
    },
    // Crowding is a card's: without one there was no neighbour to be crowded by.
    crowded: raw.crowded === true && card !== undefined,
    ...(card
      ? { card: { device: card.device, perDevice: remoteCount(card.perDevice, 1, REMOTE_PER_DEVICE_MAX), sliceMb: card.sliceMb === null ? null : remoteCount(card.sliceMb, 1, REMOTE_CARD_MB_MAX) } }
      : {}),
  }
}

/* ---------------------------------------------------------------- helpers */

function refuse(what: string, code: RemoteProtocolError['code'] = 'invalid'): never {
  throw new RemoteProtocolError(what, code)
}

const integer = (v: unknown, min: number, max: number): v is number => Number.isSafeInteger(v) && (v as number) >= min && (v as number) <= max
const matching = (v: unknown, pattern: RegExp): v is string => typeof v === 'string' && pattern.test(v)
const within = (v: unknown, max: number): v is string => typeof v === 'string' && v.length <= max
const label = (v: unknown, max: number): v is string => typeof v === 'string' && v.length > 0 && v.length <= max
const flag = (v: unknown): v is boolean => typeof v === 'boolean'
const word = (v: unknown, words: ReadonlySet<string>): v is string => typeof v === 'string' && words.has(v)
const slots = (v: unknown): boolean => v === null || integer(v, 0, REMOTE_ATTEMPTS_MAX)
/** A set's own room in MiB (packagesRoomMb), within the broker's bounds for it. */
const packagesMb = (v: unknown): boolean => integer(v, 16, 4096)
const dataName = (v: unknown): v is string => matching(v, REMOTE_DATA_NAME) && !v.includes('..')

/**
 * A plain object with no key outside `keys`; which of them must be there is
 * the caller's to check. The refusal names the key (quoted and cut short):
 * a key one side does not know is what a version skew looks like in a log.
 */
function fields(value: unknown, what: string, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) refuse(`Invalid ${what}`)
  const v = value as Record<string, unknown>
  const stray = Object.keys(v).find((key) => !keys.includes(key))
  if (stray !== undefined) refuse(`Unexpected key ${JSON.stringify(stray.slice(0, 40))} in ${what}`)
  return v
}

/**
 * A request's fields, its version checked before its keys: a request of
 * another version has other keys, and its answer is `protocol`, not `invalid`.
 */
function spoken(value: unknown, what: string, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) refuse(`Invalid ${what}`)
  if ((value as Record<string, unknown>).protocol !== REMOTE_PROTOCOL) refuse(`Unexpected protocol in ${what}`, 'protocol')
  const v = fields(value, what, keys)
  if (!matching(v.build, REMOTE_BUILD)) refuse(`Invalid build in ${what}`)
  return v
}

function items(value: unknown, what: string, max: number): unknown[] {
  if (!Array.isArray(value) || value.length > max) refuse(`Invalid ${what}`)
  return value
}

/** Distinct strings, each in its pattern: lists of ids and hashes. */
function distinct(value: unknown, what: string, pattern: RegExp, max: number): string[] {
  const seen = new Set<string>()
  for (const item of items(value, what, max)) {
    if (!matching(item, pattern) || seen.has(item)) refuse(`Invalid ${what}`)
    seen.add(item)
  }
  return value as string[]
}

/** The bytes a base64 text decodes to, or -1 when it is not base64 with its padding. */
function base64Bytes(value: unknown): number {
  if (typeof value !== 'string' || value.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(value)) return -1
  return (value.length / 4) * 3 - (value.endsWith('==') ? 2 : value.endsWith('=') ? 1 : 0)
}

function pathPart(value: string, pattern: RegExp): string {
  if (!pattern.test(value)) refuse('Invalid path part')
  return value
}
