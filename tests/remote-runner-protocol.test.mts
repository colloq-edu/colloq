/**
 * The contract between home and its machines for submissions
 * (shared/remote-runner.ts): every parser's accept and refuse cases, the
 * sizes adding up, what the agent sends made safe, the texts a machine makes
 * read on home in home's words, and the numbers it shares with the rest of
 * the code.
 *
 * What is checked is what breaks on a rented machine in the middle of a
 * class and nowhere else. A parser that takes an extra key lets a forged
 * field in; one that refuses an honest message drops every lease of a
 * machine. A forged `cell` in progress.json that reached the parser raw would
 * be the second. A field cap that adds up past its body cap is a machine
 * refused 413 forever for an outcome it cannot shrink. And a number that
 * drifted from the one the editor, the store or the broker uses is a lease
 * home builds and the agent refuses.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import {
  REMOTE_API_BASE,
  REMOTE_ATTEMPTS_MAX,
  REMOTE_BACKOFF_MAX_MS,
  REMOTE_BOOT_GRACE_MS,
  REMOTE_BUILD_DEV,
  REMOTE_BUNDLES_MAX,
  REMOTE_BUNDLE_DETAILS_MAX,
  REMOTE_CARDS_MAX,
  REMOTE_CARD_MB_MAX,
  REMOTE_CELLS_MAX,
  REMOTE_CPUS_MAX,
  REMOTE_DATA_BYTES,
  REMOTE_DATA_FILES_MAX,
  REMOTE_DETAIL_CHARS,
  REMOTE_DISK_MB_MAX,
  REMOTE_ERRORS,
  REMOTE_EVIDENCE_MS,
  REMOTE_FETCHING_MAX,
  REMOTE_FILE_BYTES,
  REMOTE_FILE_NAMES,
  REMOTE_HOLD_BUSY_MS,
  REMOTE_HOLD_IDLE_MS,
  REMOTE_HOSTNAME_CHARS,
  REMOTE_INLINE_BYTES,
  REMOTE_INLINE_TOTAL_BYTES,
  REMOTE_JOIN_BYTES,
  REMOTE_LABEL_CHARS,
  REMOTE_LOCK_CHARS,
  REMOTE_LOG_CHARS,
  REMOTE_MANIFESTS_MAX,
  REMOTE_API_ROOT,
  REMOTE_MARKER,
  REMOTE_MARKER_HEADER,
  REMOTE_MEMORY_MB_MAX,
  REMOTE_NOTEBOOK_BYTES,
  REMOTE_OFFER_MS,
  REMOTE_OUTCOME_BYTES,
  REMOTE_PER_DEVICE_MAX,
  REMOTE_PROBE_MS,
  REMOTE_PROBLEMS_MAX,
  REMOTE_PROTOCOL,
  REMOTE_PROTOCOL_HEADER,
  REMOTE_REASON_CHARS,
  REMOTE_REPLY_BYTES,
  REMOTE_REVISIONS_MAX,
  REMOTE_RUN_JSON_BYTES,
  REMOTE_RUN_MS_MAX,
  REMOTE_SILENCE_MS,
  REMOTE_SYNC_BYTES,
  REMOTE_TEXT_DEPTH,
  REMOTE_TEXT_JSON_CHARS,
  REMOTE_TEXT_KEY,
  REMOTE_TEXT_OPEN,
  REMOTE_TEXT_PARAMS_MAX,
  REMOTE_TEXT_PARAM_CHARS,
  REMOTE_TEXT_SPLIT,
  REMOTE_URL_CHARS,
  REMOTE_WALL_SECONDS_MAX,
  REMOTE_WHEELS_BYTES,
  REMOTE_WHEELS_MAX,
  RemoteProtocolError,
  isRemoteCredential,
  parseRemoteAuthorization,
  parseRemoteBuildFile,
  parseRemoteErrorReply,
  parseRemoteJoinReply,
  parseRemoteJoinRequest,
  parseRemoteJoinTarget,
  parseRemoteOutcomeReply,
  parseRemoteOutcomeRequest,
  parseRemoteSyncReply,
  parseRemoteSyncRequest,
  parseRemoteUploadMeta,
  parseRemoteUploadReply,
  remoteCeilingMs,
  remoteCompatible,
  remoteCount,
  remoteCredential,
  remoteJoinTarget,
  remoteManifest,
  remoteOutcome,
  remoteOutcomeDigest,
  remotePaths,
  remoteProgress,
  remoteProtocolOf,
  remoteRenderTexts,
  remoteText,
  remoteTextMarker,
  remoteTransient,
  remoteWheelUrl,
  type RemoteOutcomeRequest,
  type RemoteOutcomeSource,
} from '../shared/remote-runner.js'
import {
  CLASS_INLINE_BYTES,
  CLASS_INLINE_PUSH_BYTES,
  CLASS_INLINE_REPORT_BYTES,
  COUNCIL_ARTIFACTS,
  COUNCIL_EPOCH_BUFFERS_MAX,
  COUNCIL_EPOCH_DIR,
  COUNCIL_EPOCH_MB,
  COUNCIL_WORKERS,
  REMOTE_BLOCKED_CIDRS_MAX,
  REMOTE_COLLECTS_MAX,
  REMOTE_EPOCHS_MAX,
  REMOTE_EPOCH_FILES_MAX,
  REMOTE_PLACEMENTS_MAX,
  REMOTE_PUSH_PATHS_MAX,
  REMOTE_READINGS_MAX,
  REMOTE_READING_LINES_MAX,
  REMOTE_READING_LINE_CHARS,
  REMOTE_REPORT_PATHS_MAX,
  REMOTE_ROOT_CHARS,
  isRemoteRoot,
  parseRemoteKernelsReply,
} from '../shared/remote-kernels.js'
import { normalizePath } from '../shared/paths.js'
import { hasTranslation, messages, tr, translate } from '../shared/i18n.js'
import { COMPETITION_ATTEMPT_ID } from '../shared/competition-runtime.js'
import { EXECUTED_NOTEBOOK_FILE, LIMITS } from '../shared/competitions.js'
import { SETTINGS_LIMITS } from '../shared/competitions-settings.js'
import { DEPENDENCY_LIMITS, packagesRoomMb } from '../shared/dependencies.js'
import { limitsFor } from '../server/src/competitions/runner-port.js'

/* ---------------------------------------------------------------- fixtures */

const sha256 = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex')
const same = (text: string): string => text
/** The i-th of a run of distinct hex ids of `width` digits. */
const nth = (i: number, width: number): string => i.toString(16).padStart(width, '0')
/** Six bytes a character once JSON-escaped: the worst a free text can do to a body. */
const worst = (chars: number): string => '\u0001'.repeat(chars)
const bytesOf = (value: unknown): number => Buffer.byteLength(JSON.stringify(value), 'utf8')

/** A deep copy with the field at `path` set; `undefined` removes it. */
function edit<T>(value: T, path: readonly (string | number)[], next: unknown): T {
  const copy = structuredClone(value) as Record<string | number, unknown>
  let at = copy
  for (const key of path.slice(0, -1)) at = at[key] as Record<string | number, unknown>
  const last = path[path.length - 1]
  if (next === undefined) delete at[last]
  else at[last] = next
  return copy as T
}

function refused(run: () => unknown, message: RegExp = /./, code: RemoteProtocolError['code'] = 'invalid'): void {
  assert.throws(run, (error: unknown) => error instanceof RemoteProtocolError && error.code === code && message.test(error.message))
}

const BUILD = 'b'.repeat(64)
const ATTEMPT = 'c'.repeat(32)
const OTHER_ATTEMPT = '9'.repeat(32)
const REVISION = 'd'.repeat(32)
const GPU_REVISION = 'f'.repeat(32)
const BUNDLE = 'e'.repeat(32)
const MANIFEST = '1'.repeat(64)
const SEALED_MANIFEST = '2'.repeat(64)
const COMPETITION = 'x77h25nx'
const SUBMISSION = 'ab2cd3ef'
const REF = `ghcr.io/colloq-edu/colloq-kernel@sha256:${'3'.repeat(64)}`
/** The template of runner.ts · containerName for a notebook. */
const containerOf = (submissionId: string, token = '0a1b2c3d'): string => `colloq-comp-${submissionId}-${token}-run`
/** A competition as limitsFor reads it: its limits and nothing else. */
const competitionWith = (limits: { wallSeconds: number; memoryMb: number; cpus: number }) =>
  ({ limits: { ...limits, perDay: 5 } }) as unknown as Parameters<typeof limitsFor>[0]

const facts = {
  version: '0.24.0', hostname: 'C.31415926', platform: 'linux/amd64', cpus: 32, memoryMb: 128_000, diskMb: 150_000,
  docker: '28.3.3', storage: 'overlayfs', driver: '580.65.06',
}
const free = { slots: 9, memoryMb: 90_000, cpus: 27, gpuShares: 6, diskMb: 100_000 }
const card = { device: '0', name: 'NVIDIA GeForce RTX 4090', memoryMb: 24_564, perDevice: 4, busyShares: 1 }

const sync = {
  protocol: 1, build: BUILD, seq: 7, holdMs: REMOTE_HOLD_BUSY_MS, state: 'active', free,
  cards: [card, { ...card, device: '1', busyShares: 0 }],
  ready: { revisions: [REVISION], data: [MANIFEST], sealed: [], bundles: [BUNDLE] },
  fetching: [{ revisionId: GPU_REVISION, percent: 45 }],
  attempts: [
    { id: ATTEMPT, phase: 'running', runningMs: 12_345, progress: { phase: 'notebook', cell: 3, cells: 14 }, card: { device: '0', sliceMb: 6141 } },
    { id: OTHER_ATTEMPT, phase: 'accepted' },
  ],
  problems: [{ code: 'smoke', revisionId: GPU_REVISION, detail: 'driver 535.104.05, the kernels need 580+' }],
}

const notebook = Buffer.from(JSON.stringify({ cells: [{ cell_type: 'code', source: ['print(1)'] }], nbformat: 4 }))
const lease = {
  attemptId: ATTEMPT, seq: 7, competitionId: COMPETITION, submissionId: SUBMISSION, container: containerOf(SUBMISSION),
  deadlineMs: remoteCeilingMs(600),
  revision: { id: REVISION, ref: REF, layers: '4'.repeat(64) },
  harness: '0123456789ab',
  limits: limitsFor(competitionWith({ wallSeconds: 600, memoryMb: 4096, cpus: 2 }), 'notebook'),
  sealed: false, gpu: false, data: MANIFEST,
  notebook: { sha256: createHash('sha256').update(notebook).digest('hex'), bytes: notebook.length, inline: notebook.toString('base64') },
}
const gpuLease = {
  ...lease, attemptId: OTHER_ATTEMPT, seq: 6, sealed: true, sealedData: SEALED_MANIFEST, gpu: true, perDevice: 4,
  bundle: { id: BUNDLE, packagesMb: 379 }, notebook: { sha256: '5'.repeat(64), bytes: 300_000 },
}

const WHEEL = 'catboost-1.2.8-cp312-cp312-manylinux2014_x86_64.whl'
const reply = {
  seq: 7, leases: [lease], revoke: [{ id: 'a'.repeat(32), reason: 'cancelled' }], applied: ['b'.repeat(32)],
  want: {
    revisions: [{ id: REVISION, ref: REF, layers: '4'.repeat(64), gpu: false }],
    data: [{ competitionId: COMPETITION, manifest: MANIFEST, sealed: false, files: [{ name: 'train.csv', sha256: '5'.repeat(64), bytes: 1_000_000 }] }],
    bundles: [
      { id: BUNDLE, packagesMb: 379 },
      {
        id: '6'.repeat(32), packagesMb: 140, lock: `catboost==1.2.8 --hash=sha256:${'7'.repeat(64)}\n`,
        wheels: [{ fileName: WHEEL, sha256: '7'.repeat(64), bytes: 99_000_000, url: `https://files.pythonhosted.org/packages/1a/2b/${'c'.repeat(60)}/${WHEEL}` }],
      },
    ],
  },
  forget: ['zz22zz22'], drain: false, trusted: false, approvedSlots: null, perDevice: 4, compatible: true, homeVersion: '0.24.0',
}

/** A machine with classes: one class's room ready, the shapes of shared/remote-kernels.ts (tests/remote-kernels-contract.test.mts has them all). */
const classes = { hostNetwork: true, perimeter: 'ok', mode: 'blocked', canary: 'ok', sameDaemon: false }
const kernelsAsked = {
  placements: [{ key: 'seminar_1:room', gen: 3, phase: 'ready', container: 'c'.repeat(64), revision: `sha256:${'a'.repeat(64)}` }],
  reports: [{ sessionId: 'seminar_1', gen: 3, seq: 1, changed: [{ path: 'out.csv', sha256: '1'.repeat(64), bytes: 5, base: null }], removed: [], skipped: [] }],
  epochs: [], readings: [], tunnel: 'up', classes,
}
const kernelsAnswer = {
  placements: [{
    key: 'seminar_1:room', gen: 3, environment: 'base', revision: { id: REVISION, ref: REF, layers: '4'.repeat(64) },
    memoryMb: 4096, cpus: 2, pids: 512, gpu: false, network: 'blocked', blockedCidrs: [], token: 'e'.repeat(40), hashSeed: 7,
  }],
  pushes: [], verdicts: [{ sessionId: 'seminar_1', seq: 1, accepted: ['out.csv'], refused: [] }], pulls: [], scan: [], epochs: [], collect: [], postmortem: [],
  rates: { classBulkMBps: 4, machinePaceMBps: 6 }, tunnel: 'open',
}

const runJson = Buffer.from(JSON.stringify({ status: 'ok', detail: '', cell: 13, cells: 14, attemptId: ATTEMPT })).toString('base64')
const finished = {
  protocol: 1, build: BUILD, free, kind: 'finished',
  outcome: {
    status: 'ok', cell: 13, cells: 14, wall: 31_337, produced: true, detail: '', log: '',
    diagnostics: { exit: 0, oomKilled: false, backend: 'docker', peakBytes: 1_234_567_890 }, crowded: false,
  },
  runJson,
  files: [{ name: 'submission.csv', bytes: 20_480, sha256: '8'.repeat(64) }, { name: 'executed.ipynb', bytes: 81_920, sha256: '9'.repeat(64) }],
}
const declined = { protocol: 1, build: BUILD, free, kind: 'declined', reason: 'disk', detail: '1.2 GB free, 2.3 GB needed' }

/* ---------------------------------------------------------------- the wire */

test('one version, one path, and a marker that tells home from the relay in front of it, whatever home\'s version', () => {
  assert.equal(REMOTE_PROTOCOL, 1)
  assert.equal(REMOTE_API_ROOT, '/api/runners')
  assert.equal(REMOTE_API_BASE, '/api/runners/v1')
  assert.equal(REMOTE_MARKER_HEADER, 'X-Colloq-Runner-Api')
  // The marker says "home", not which version of it: the protocol travels beside it.
  assert.equal(REMOTE_MARKER, 'colloq-runners')
  assert.equal(REMOTE_PROTOCOL_HEADER, 'X-Colloq-Runner-Protocol')
  // The relay's HTML 404 and 502, frps's 504, its EOF turned 404: no marker, a hiccup whatever the status.
  for (const status of [200, 401, 404, 409, 426, 502, 504]) {
    assert.equal(remoteTransient(status, null), true, `unmarked ${status}`)
    assert.equal(remoteTransient(status, undefined), true)
    assert.equal(remoteTransient(status, 'colloq'), true, 'a header of the same name and another value is not home\'s')
  }
  // Home saying "not now".
  for (const status of [429, 500, 503, 507]) assert.equal(remoteTransient(status, REMOTE_MARKER), true, `marked ${status}`)
  // Home's answers, refusals included: acted on, never retried blindly.
  for (const status of [200, 400, 401, 403, 404, 409, 410, 413, 422, 426]) assert.equal(remoteTransient(status, ` ${REMOTE_MARKER} `), false, `marked ${status}`)
  // A home of ANOTHER version marks its 426 the same way, and an agent of this one takes it as final: it needs that home's release.
  assert.equal(remoteTransient(426, REMOTE_MARKER), false)
  assert.equal(remoteProtocolOf('2'), 2)
  assert.equal(remoteProtocolOf(' 1 '), 1)
  for (const bad of [null, undefined, '', 'v2', '0', '1.0', '01', '1234567']) assert.equal(remoteProtocolOf(bad), null, String(bad))
})

test('a path is built only from ids in their patterns', () => {
  assert.equal(remotePaths.join, 'join')
  assert.equal(remotePaths.sync, 'sync')
  assert.equal(remotePaths.blob(MANIFEST), `blobs/${MANIFEST}`)
  assert.equal(remotePaths.file(ATTEMPT, 'executed.ipynb'), `attempts/${ATTEMPT}/files/executed.ipynb`)
  assert.equal(remotePaths.outcome(ATTEMPT), `attempts/${ATTEMPT}/outcome`)
  refused(() => remotePaths.blob('../secret/solution.csv'))
  refused(() => remotePaths.outcome(`${ATTEMPT}/../x`))
  refused(() => remotePaths.file(ATTEMPT, 'run.json' as never))
  refused(() => remotePaths.file(ATTEMPT, '../solution.csv' as never))
})

test('a machine credential: one shape, in one header, and recognisable at every other door', () => {
  const secret = 'f'.repeat(64)
  const token = remoteCredential('k7m2p9qa', secret)
  assert.equal(token, `cr1.k7m2p9qa.${secret}`)
  assert.deepEqual(parseRemoteAuthorization(`Bearer ${token}`), { runnerId: 'k7m2p9qa', secret })
  // The scheme word is case-insensitive (RFC 7235); the token is not.
  assert.deepEqual(parseRemoteAuthorization(`bearer ${token}  `), { runnerId: 'k7m2p9qa', secret })
  for (const header of [
    undefined, null, '', token, `Basic ${token}`, `Bearer ${token.toUpperCase()}`, `Bearer cr2.k7m2p9qa.${secret}`,
    `Bearer cr1.k7m2p9qa.${secret.slice(1)}`, `Bearer cr1.K7M2P9QA.${secret}`, `Bearer cr1.k7m2p9qa.${secret}.x`,
    `Bearer cr1.k7m2p9qa ${secret}`, `Bearer  cr1..${secret}`,
  ]) assert.equal(parseRemoteAuthorization(header), null, String(header))
  refused(() => remoteCredential('../admin', secret))
  refused(() => remoteCredential('k7m2p9qa', 'short'))
  // The staff, entrant, room and WebSocket doors refuse it by its shape before trying it as their own.
  for (const shaped of [token, `Bearer ${token}`, ` CR1.anything`]) assert.equal(isRemoteCredential(shaped), true, shaped)
  for (const other of ['eyJhbGciOiJIUzI1NiJ9.e30.x', 'ABC-DEF-GHJ', 'cr1', undefined, null]) assert.equal(isRemoteCredential(other), false, String(other))
})

test('the join target carries the code in its fragment and home as a bare origin', () => {
  const code = 'a'.repeat(32)
  assert.equal(remoteJoinTarget('https://vsos.colloq.ru/', code), `https://vsos.colloq.ru#${code}`)
  assert.deepEqual(parseRemoteJoinTarget(`  https://vsos.colloq.ru#${code}\n`), { home: 'https://vsos.colloq.ru', code })
  // A home on the same network, or a test's.
  assert.deepEqual(parseRemoteJoinTarget(`http://127.0.0.1:3000/#${code}`), { home: 'http://127.0.0.1:3000', code })
  for (const text of [
    'https://vsos.colloq.ru', `https://vsos.colloq.ru#${code.slice(1)}`, `https://vsos.colloq.ru#${code.toUpperCase()}`,
    `https://vsos.colloq.ru/api#${code}`, `https://vsos.colloq.ru?x=1#${code}`, `https://user:pass@vsos.colloq.ru#${code}`,
    `ftp://vsos.colloq.ru#${code}`, `vsos.colloq.ru#${code}`, `#${code}`,
  ]) assert.equal(parseRemoteJoinTarget(text), null, text)
  refused(() => remoteJoinTarget('https://vsos.colloq.ru/path', code))
  refused(() => remoteJoinTarget('https://vsos.colloq.ru', 'nope'))
})

test('only a machine whose runner code is home\'s takes new work, and make dev matches only itself', () => {
  const build = sha256('dist/runner.js')
  assert.equal(parseRemoteBuildFile(`${build}\n`), build)
  // As sha256sum prints it.
  assert.equal(parseRemoteBuildFile(`${build}  runner.js\n`), build)
  for (const text of ['', '\n', build.slice(1), build.toUpperCase(), `sha256:${build}`, 'dev']) assert.equal(parseRemoteBuildFile(text), null, text)
  assert.equal(remoteCompatible(build, build), true)
  assert.equal(remoteCompatible(build, sha256('another release')), false)
  assert.equal(remoteCompatible(REMOTE_BUILD_DEV, REMOTE_BUILD_DEV), true)
  assert.equal(remoteCompatible(REMOTE_BUILD_DEV, build), false)
  assert.equal(remoteCompatible(build, REMOTE_BUILD_DEV), false)
  // Equal is not enough: both must be builds.
  assert.equal(remoteCompatible('', ''), false)
  assert.equal(remoteCompatible('0.24.0', '0.24.0'), false)
})

/* ------------------------------------------------------- names of contents */

test('a data manifest names a set of contents: any order, the same name; any change, another', () => {
  const files = [{ name: 'train.csv', sha256: '1'.repeat(64) }, { name: 'test.csv', sha256: '2'.repeat(64) }, { name: 'Sample.csv', sha256: '3'.repeat(64) }]
  const manifest = remoteManifest(files, sha256)
  assert.match(manifest, /^[a-f0-9]{64}$/)
  assert.equal(remoteManifest([...files].reverse(), sha256), manifest)
  assert.notEqual(remoteManifest([...files.slice(1), { ...files[0], sha256: '4'.repeat(64) }], sha256), manifest, 'a replaced file')
  assert.notEqual(remoteManifest([...files.slice(1), { ...files[0], name: 'train2.csv' }], sha256), manifest, 'a renamed file')
  assert.notEqual(remoteManifest(files.slice(1), sha256), manifest, 'a removed file')
  // By code unit, not by locale: `S` before `t`, the same on every machine; one line per file under a line of its own.
  assert.equal(remoteManifest(files, same),
    `colloq.remote.data.v1\nSample.csv\t${'3'.repeat(64)}\ntest.csv\t${'2'.repeat(64)}\ntrain.csv\t${'1'.repeat(64)}\n`)
  assert.equal(remoteManifest([], same), 'colloq.remote.data.v1\n', 'a competition without open files has a manifest too')
  for (const bad of [
    [files[0], files[0]], [{ name: '../solution.csv', sha256: '1'.repeat(64) }], [{ name: '.hidden', sha256: '1'.repeat(64) }],
    [{ name: 'a..b', sha256: '1'.repeat(64) }], [{ name: 'a b.csv', sha256: '1'.repeat(64) }], [{ name: 'x.csv', sha256: 'XYZ' }],
  ]) refused(() => remoteManifest(bad, sha256))
})

test('the image pins home captures (image-identity.ts) are pins a lease and a want carry', async () => {
  // The fingerprint's own rule is image-identity.ts's alone; the contract only has to carry what it makes.
  const { imageIdentity } = await import('../server/src/dependencies/image-identity.js')
  const digest = `sha256:${'3'.repeat(64)}`
  const inspect = {
    Id: `sha256:${'1'.repeat(64)}`, Os: 'linux', Architecture: 'amd64', RootFS: { Type: 'layers', Layers: ['a', 'b'].map((d) => `sha256:${d.repeat(64)}`) },
    RepoDigests: [`colloq-kernel@${digest}`, `ghcr.io/colloq-edu/colloq-kernel@${digest}`],
  }
  const pins = [
    imageIdentity(inspect, 'ghcr.io/colloq-edu/colloq-kernel'),
    // Docker Hub's short form, which home writes out in full.
    imageIdentity({ ...inspect, RepoDigests: [`python@${digest}`] }, 'python'),
    // The longest entry home keeps, with docker.io/library/ put in front of it.
    imageIdentity({ ...inspect, RepoDigests: [`${'k'.repeat(512 - 72)}@${digest}`] }, 'k'.repeat(512 - 72)),
  ]
  for (const { registryRef, layers } of pins) {
    assert.ok(registryRef !== null && layers !== null, JSON.stringify({ registryRef, layers }))
    const pinned = edit(edit(reply, ['want', 'revisions', 0], { id: REVISION, ref: registryRef, layers, gpu: false }), ['leases', 0, 'revision'], { id: REVISION, ref: registryRef, layers })
    assert.doesNotThrow(() => parseRemoteSyncReply(pinned), registryRef)
  }
})

test('an outcome\'s digest covers its result, not the capacity it was sent with', () => {
  const parsed = parseRemoteOutcomeRequest(finished)
  const digest = remoteOutcomeDigest(parsed, sha256)
  // A repeat after a lost reply: fresh capacity, files listed the other way round, keys in another order.
  const repeat = {
    files: [...finished.files].reverse(), runJson, kind: 'finished', free: { ...free, slots: 3 }, build: 'dev', protocol: 1,
    outcome: { crowded: false, diagnostics: { peakBytes: 1_234_567_890, backend: 'docker', oomKilled: false, exit: 0 }, log: '', detail: '', produced: true, wall: 31_337, cells: 14, cell: 13, status: 'ok' },
  } as RemoteOutcomeRequest
  assert.equal(remoteOutcomeDigest(repeat, sha256), digest)
  assert.notEqual(remoteOutcomeDigest(edit(parsed, ['outcome', 'detail'], 'x'), sha256), digest)
  assert.notEqual(remoteOutcomeDigest(edit(parsed, ['files', 0, 'sha256'], '0'.repeat(64)), sha256), digest)
  const decline = parseRemoteOutcomeRequest(declined)
  assert.equal(remoteOutcomeDigest(decline, same), '{"detail":"1.2 GB free, 2.3 GB needed","kind":"declined","reason":"disk"}')
  assert.notEqual(remoteOutcomeDigest(edit(decline, ['reason'], 'memory'), sha256), remoteOutcomeDigest(decline, sha256))
})

/* -------------------------------------------------------------------- join */

test('join: a code, an id and the facts — and nothing a newer or forged agent adds', () => {
  const join = { protocol: 1, build: BUILD, code: 'a'.repeat(32), joinId: 'b'.repeat(32), facts }
  assert.deepEqual(parseRemoteJoinRequest(join), join)
  assert.doesNotThrow(() => parseRemoteJoinRequest(edit(join, ['facts', 'driver'], null)), 'a machine without cards')
  assert.doesNotThrow(() => parseRemoteJoinRequest(edit(join, ['build'], 'dev')), 'make dev')
  for (const [path, value] of [
    [['code'], 'a'.repeat(31)], [['code'], 'A'.repeat(32)], [['joinId'], 'x'], [['build'], 'b'.repeat(63)], [['build'], undefined],
    [['secret'], 'f'.repeat(64)], [['facts', 'cards'], []], [['facts', 'platform'], 'windows/amd64'], [['facts', 'cpus'], 0],
    [['facts', 'memoryMb'], REMOTE_MEMORY_MB_MAX + 1], [['facts', 'version'], 'v0.24'], [['facts', 'driver'], '580; rm -rf'],
    [['facts', 'hostname'], ''], [['facts', 'hostname'], 'h'.repeat(REMOTE_HOSTNAME_CHARS + 1)], [['facts', 'docker'], undefined],
    [['facts'], undefined],
  ] as const) refused(() => parseRemoteJoinRequest(edit(join, path, value)), /Invalid|Unexpected/)
  // Another version is told so (426), not merely refused: the machine needs home's release.
  refused(() => parseRemoteJoinRequest({ ...join, protocol: 2, extra: true }), /protocol/, 'protocol')
  refused(() => parseRemoteJoinRequest(edit(join, ['protocol'], undefined)), /protocol/, 'protocol')
  refused(() => parseRemoteJoinRequest({ ...join, protocol: '1' }), /protocol/, 'protocol')
  // The refusal names the stray key: a version skew reads plainly in a log.
  refused(() => parseRemoteJoinRequest({ ...join, gpuToken: 'x' }), /Unexpected key "gpuToken" in join request/)
  for (const bad of [null, [], 'join', 1]) refused(() => parseRemoteJoinRequest(bad))
})

test('join reply: an id, a secret, the trust and the cap', () => {
  const answer = { runnerId: 'k7m2p9qa', secret: 'f'.repeat(64), trusted: false, approvedSlots: null }
  assert.deepEqual(parseRemoteJoinReply(answer), answer)
  assert.doesNotThrow(() => parseRemoteJoinReply({ ...answer, trusted: true, approvedSlots: 12 }))
  for (const bad of [
    { ...answer, runnerId: 'K7M2P9QA' }, { ...answer, secret: 'f'.repeat(32) }, { ...answer, trusted: 'yes' },
    { ...answer, approvedSlots: REMOTE_ATTEMPTS_MAX + 1 }, { ...answer, approvedSlots: 1.5 },
    { runnerId: answer.runnerId, secret: answer.secret, trusted: false },
  ]) refused(() => parseRemoteJoinReply(bad))
  // A field a newer home added: dropped, not refused, and not kept.
  assert.deepEqual(parseRemoteJoinReply({ ...answer, name: 'vast-1' }), answer)
})

test('join reply: whether the machine may run classes, never together with the hidden test', () => {
  const answer = { runnerId: 'k7m2p9qa', secret: 'f'.repeat(64), trusted: false, approvedSlots: null }
  for (const allowed of [true, false]) assert.deepEqual(parseRemoteJoinReply({ ...answer, classes: allowed }), { ...answer, classes: allowed })
  // A home from before classes says nothing of them, and the reply reads as it always did.
  assert.equal('classes' in parseRemoteJoinReply(answer), false)
  for (const bad of ['yes', 1, null]) refused(() => parseRemoteJoinReply({ ...answer, classes: bad }), /Invalid join reply/)
  // No code carries both (remote-classes.md D3): a machine that runs classes holds no hidden test.
  refused(() => parseRemoteJoinReply({ ...answer, trusted: true, classes: true }), /Contradictory join reply/)
  assert.doesNotThrow(() => parseRemoteJoinReply({ ...answer, trusted: true, classes: false }))
})

/* ------------------------------------------------------------- sync request */

test('sync request: the whole state of a machine, accepted as it is sent', () => {
  assert.deepEqual(parseRemoteSyncRequest(sync), sync)
  const idle = { ...sync, holdMs: REMOTE_HOLD_IDLE_MS, attempts: [], cards: [], fetching: [], problems: [], free: { ...free, gpuShares: 0 } }
  assert.deepEqual(parseRemoteSyncRequest(idle), idle)
  // The first sync after a start carries the facts again: an update changed the version.
  assert.doesNotThrow(() => parseRemoteSyncRequest({ ...sync, facts }))
  // Home lowered the share while four runs were on the card: they finish over it.
  assert.doesNotThrow(() => parseRemoteSyncRequest(edit(sync, ['cards', 0], { ...card, perDevice: 2, busyShares: 4 })))
  // A card that cannot say its name or size.
  assert.doesNotThrow(() => parseRemoteSyncRequest(edit(sync, ['cards', 1], { ...card, device: 'GPU-0b1c2d3e-aaaa-bbbb-cccc-0123456789ab', name: null, memoryMb: null })))
  for (const state of ['draining', 'leaving']) assert.doesNotThrow(() => parseRemoteSyncRequest({ ...sync, state }))
  // A run so short that home first hears of it uploading still says how long it ran.
  assert.doesNotThrow(() => parseRemoteSyncRequest(edit(sync, ['attempts', 0], { id: ATTEMPT, phase: 'uploading', runningMs: 900 })))
  assert.doesNotThrow(() => parseRemoteSyncRequest(edit(sync, ['attempts', 0], { id: ATTEMPT, phase: 'preparing', card: { device: '0', sliceMb: null } })))
  for (const code of ['disk', 'docker', 'cards']) assert.doesNotThrow(() => parseRemoteSyncRequest(edit(sync, ['problems', 0], { code, detail: '' })))
  assert.doesNotThrow(() => parseRemoteSyncRequest(edit(sync, ['problems', 0], { code: 'data', manifest: MANIFEST, detail: 'blob 410' })))
  assert.doesNotThrow(() => parseRemoteSyncRequest(edit(sync, ['problems', 0], { code: 'wheels', bundleId: BUNDLE, detail: 'PyPI 503' })))
})

test('sync request: the hold, the counts and every nested key are refused past their bounds', () => {
  refused(() => parseRemoteSyncRequest({ ...sync, holdMs: REMOTE_HOLD_IDLE_MS + 1, attempts: [] }))
  // While anything is held, progress must reach home within the busy hold.
  refused(() => parseRemoteSyncRequest({ ...sync, holdMs: REMOTE_HOLD_BUSY_MS + 1 }), /busy/)
  refused(() => parseRemoteSyncRequest({ ...sync, protocol: 2 }), /protocol/, 'protocol')
  // Cards travel in every sync, so the facts carry none.
  refused(() => parseRemoteSyncRequest({ ...sync, facts: { ...facts, cards: [] } }), /Unexpected key "cards" in machine facts/)
  refused(() => parseRemoteSyncRequest({ ...sync, facts: { ...facts, cpus: 0 } }), /facts/)
  for (const [path, value] of [
    [['seq'], -1], [['seq'], 1.5], [['holdMs'], -1], [['state'], 'paused'], [['state'], undefined],
    [['free', 'slots'], REMOTE_ATTEMPTS_MAX + 1], [['free', 'cpus'], -1], [['free', 'memoryMb'], 0.5], [['free', 'extra'], 1], [['free', 'diskMb'], undefined],
    [['cards', 1, 'device'], '0'], [['cards', 0, 'device'], 'card 0'], [['cards', 0, 'perDevice'], REMOTE_PER_DEVICE_MAX + 1],
    [['cards', 0, 'busyShares'], REMOTE_PER_DEVICE_MAX + 1], [['cards', 0, 'name'], 'n'.repeat(REMOTE_LABEL_CHARS + 1)], [['cards', 0, 'memoryMb'], 0],
    [['cards', 0, 'vendor'], 'nvidia'],
    [['ready', 'revisions'], [REVISION, REVISION]], [['ready', 'data'], ['xyz']], [['ready', 'bundles'], undefined], [['ready', 'wheels'], []],
    [['fetching', 0], { percent: 10 }], [['fetching', 0, 'percent'], 101], [['fetching', 0, 'manifest'], MANIFEST],
    [['fetching', 1], { revisionId: GPU_REVISION, percent: 50 }],
    [['attempts', 0, 'id'], 'c'.repeat(31)], [['attempts', 1, 'id'], ATTEMPT], [['attempts', 0, 'phase'], 'finished'],
    [['attempts', 0, 'runningMs'], undefined], [['attempts', 0, 'runningMs'], REMOTE_RUN_MS_MAX + 1],
    [['attempts', 1, 'runningMs'], 10], [['attempts', 1, 'card'], { device: '0', sliceMb: 6141 }],
    [['attempts', 0, 'progress', 'cell'], REMOTE_CELLS_MAX + 1], [['attempts', 0, 'progress', 'cells'], -1],
    [['attempts', 0, 'progress', 'phase'], 'score'], [['attempts', 0, 'progress', 'outputBytes'], 0],
    [['attempts', 0, 'card', 'sliceMb'], 0], [['attempts', 0, 'card', 'perDevice'], 4], [['attempts', 0, 'entrant'], 'Иванов'],
    [['problems', 0, 'code'], 'oops'], [['problems', 0, 'revisionId'], undefined], [['problems', 0, 'manifest'], MANIFEST],
    [['problems', 0, 'detail'], 'x'.repeat(REMOTE_REASON_CHARS + 1)], [['problems', 0, 'detail'], undefined],
  ] as const) refused(() => parseRemoteSyncRequest(edit(sync, path, value)), /Invalid|Unexpected/)
  // Progress belongs to a running container and to nothing else.
  refused(() => parseRemoteSyncRequest(edit(sync, ['attempts', 0, 'phase'], 'exporting')), /progress/)
  refused(() => parseRemoteSyncRequest(edit(sync, ['problems', 0], { code: 'disk', revisionId: REVISION, detail: '' })))
  refused(() => parseRemoteSyncRequest({ ...sync, attempts: Array.from({ length: REMOTE_ATTEMPTS_MAX + 1 }, (_, i) => ({ id: nth(i, 32), phase: 'accepted' })) }))
  refused(() => parseRemoteSyncRequest({ ...sync, problems: Array.from({ length: REMOTE_PROBLEMS_MAX + 1 }, () => ({ code: 'disk', detail: '' })) }))
  refused(() => parseRemoteSyncRequest({ ...sync, cards: Array.from({ length: REMOTE_CARDS_MAX + 1 }, (_, i) => ({ ...card, device: String(i) })) }))
  refused(() => parseRemoteSyncRequest({ ...sync, fetching: Array.from({ length: REMOTE_FETCHING_MAX + 1 }, (_, i) => ({ manifest: nth(i, 64), percent: 1 })) }))
  refused(() => parseRemoteSyncRequest(edit(sync, ['ready', 'bundles'], Array.from({ length: REMOTE_BUNDLES_MAX + 1 }, (_, i) => nth(i, 32)))))
})

/* ------------------------------------------------------- classes, in the sync */

test('a sync of 0.24\'s shape, without the kernels block, still parses both ways', () => {
  // The protocol does not move for classes: the block is optional in both directions.
  assert.equal(REMOTE_PROTOCOL, 1)
  const asked = parseRemoteSyncRequest(sync)
  assert.deepEqual(asked, sync)
  assert.equal('kernels' in asked, false)
  const answered = parseRemoteSyncReply(reply)
  assert.deepEqual(answered, reply)
  assert.equal('kernels' in answered, false, 'a machine without classes is told nothing of them')
})

test('sync request: home takes the kernels block only in its exact shape, and holds a machine with placements as busy', () => {
  const withKernels = { ...sync, kernels: kernelsAsked }
  assert.deepEqual(parseRemoteSyncRequest(withKernels), withKernels)
  refused(() => parseRemoteSyncRequest({ ...sync, kernels: { ...kernelsAsked, extra: 1 } }), /Unexpected key "extra" in kernels block/)
  refused(() => parseRemoteSyncRequest(edit(withKernels, ['kernels', 'placements', 0, 'gen'], 0)), /held placement/)
  refused(() => parseRemoteSyncRequest(edit(withKernels, ['kernels', 'reports', 0, 'changed', 0, 'path'], '../runner.json')), /changed file/)
  for (const bad of [null, [], 'kernels', {}]) refused(() => parseRemoteSyncRequest({ ...sync, kernels: bad }), /kernels block|Invalid/)
  // A typo of the block is no block at all, and refused like any key home does not know.
  refused(() => parseRemoteSyncRequest({ ...sync, kernel: kernelsAsked }), /Unexpected key "kernel"/)
  // A placement is held like an attempt: its machine's progress and silence are measured by the busy hold.
  const idle = { ...sync, attempts: [], holdMs: REMOTE_HOLD_IDLE_MS }
  refused(() => parseRemoteSyncRequest({ ...idle, kernels: kernelsAsked }), /busy/)
  assert.doesNotThrow(() => parseRemoteSyncRequest({ ...idle, holdMs: REMOTE_HOLD_BUSY_MS, kernels: kernelsAsked }))
  assert.doesNotThrow(() => parseRemoteSyncRequest({ ...idle, kernels: { ...kernelsAsked, placements: [] } }), 'classes on, nothing placed: an idle machine')
  // A bye is the last sync of a machine that stops: one still taking work says none.
  refused(() => parseRemoteSyncRequest({ ...withKernels, kernels: { ...kernelsAsked, bye: 'restart' } }), /bye/)
  for (const state of ['draining', 'leaving']) {
    for (const bye of ['restart', 'stopping', 'leaving']) assert.doesNotThrow(() => parseRemoteSyncRequest({ ...withKernels, state, kernels: { ...kernelsAsked, bye } }), `${state} ${bye}`)
  }
})

test('sync reply: the agent keeps the kernels block as the contract has it, and no hidden test beside a class', () => {
  const withKernels = { ...reply, kernels: kernelsAnswer }
  assert.deepEqual(parseRemoteSyncReply(withKernels), withKernels)
  // Keys a newer home added inside the block are dropped like any other.
  const newer = edit(edit(withKernels, ['kernels', 'stray'], 1), ['kernels', 'placements', 0, 'note'], 'x')
  assert.deepEqual(parseRemoteSyncReply(newer), withKernels)
  // What the agent knows it checks: one bad intent is a reply it cannot take, and retries like a hiccup.
  refused(() => parseRemoteSyncReply(edit(withKernels, ['kernels', 'placements', 0, 'network'], 'open')), /placement intent/)
  refused(() => parseRemoteSyncReply({ ...reply, kernels: null }), /kernels block/)
  // The hidden test never lies beside a class (D3): not in a lease, not in what is wanted.
  const sealedLease = { ...reply, trusted: true, leases: [gpuLease] }
  assert.doesNotThrow(() => parseRemoteSyncReply(sealedLease))
  refused(() => parseRemoteSyncReply({ ...sealedLease, kernels: kernelsAnswer }), /Hidden test for a class machine/)
  const sealedWant = edit({ ...reply, trusted: true }, ['want', 'data', 0], { competitionId: COMPETITION, manifest: SEALED_MANIFEST, sealed: true, files: [] })
  refused(() => parseRemoteSyncReply({ ...sealedWant, kernels: kernelsAnswer }), /Hidden test for a class machine/)
  // A machine whose classes are on but which holds no placement yet is no class machine in that sense.
  assert.doesNotThrow(() => parseRemoteSyncReply({ ...sealedLease, kernels: { ...kernelsAnswer, placements: [] } }))
})

/* --------------------------------------------------------------- the lease */

test('a lease: ids, pins and limits, and no name, email or score of anyone', () => {
  assert.deepEqual(parseRemoteSyncReply(reply), reply)
  const gpu = { ...reply, trusted: true, leases: [gpuLease, lease] }
  assert.deepEqual(parseRemoteSyncReply(gpu), gpu)
  // Every notebook step limitsFor can make over the editor's whole range is a lease limit the agent takes.
  for (const wallSeconds of [LIMITS.wallSeconds.min, LIMITS.wallSeconds.max]) {
    for (const memoryMb of [LIMITS.memoryMb.min, LIMITS.memoryMb.max]) {
      for (const cpus of [LIMITS.cpus.min, LIMITS.cpus.max]) {
        const limits = limitsFor(competitionWith({ wallSeconds, memoryMb, cpus }), 'notebook')
        assert.doesNotThrow(() => parseRemoteSyncReply(edit(reply, ['leases', 0, 'limits'], limits)), JSON.stringify(limits))
      }
    }
  }
  // A notebook above the inline cap travels by its hash.
  assert.doesNotThrow(() => parseRemoteSyncReply(edit(reply, ['leases', 0, 'notebook'], { sha256: '5'.repeat(64), bytes: REMOTE_NOTEBOOK_BYTES })))
  assert.doesNotThrow(() => parseRemoteSyncReply(edit(reply, ['leases', 0, 'revision', 'ref'], `localhost:5000/kernels/kaggle-gpu@sha256:${'3'.repeat(64)}`)))
  assert.doesNotThrow(() => parseRemoteSyncReply(edit(reply, ['leases', 0, 'revision', 'ref'], `python@sha256:${'3'.repeat(64)}`)))
  const inline = Buffer.alloc(REMOTE_INLINE_BYTES, 7)
  assert.doesNotThrow(() => parseRemoteSyncReply(edit(reply, ['leases', 0, 'notebook'], { sha256: '5'.repeat(64), bytes: inline.length, inline: inline.toString('base64') })))
})

test('a lease is refused for every field outside its shape', () => {
  const big = Buffer.alloc(REMOTE_INLINE_BYTES + 1, 7)
  for (const [path, value] of [
    [['attemptId'], 'c'.repeat(31)], [['seq'], 0], [['competitionId'], '../x'], [['submissionId'], 'AB2CD3EF'],
    // A container named for another submission: a kill by its name would reach someone else's run.
    [['container'], containerOf('zz22zz22')], [['container'], `colloq-comp-${SUBMISSION}-0a1b2c3d-score`], [['container'], 'colloq-runner'],
    [['deadlineMs'], 0], [['deadlineMs'], REMOTE_RUN_MS_MAX + 1], [['harness'], '0123456789abc'], [['data'], undefined],
    [['revision', 'ref'], 'ghcr.io/colloq-edu/colloq-kernel:v0.24.0-kaggle-base'], [['revision', 'ref'], `GHCR.io/Colloq/X@sha256:${'3'.repeat(64)}`],
    [['revision', 'ref'], `${'a/'.repeat(300)}x@sha256:${'3'.repeat(64)}`], [['revision', 'layers'], `sha256:${'4'.repeat(64)}`],
    [['limits', 'wallSeconds'], REMOTE_WALL_SECONDS_MAX + 1], [['limits', 'memoryMb'], 65_537], [['limits', 'cpus'], 33],
    [['limits', 'targetBytes'], REMOTE_FILE_BYTES + 1], [['limits', 'outputKillBytes'], undefined],
    [['sealedData'], SEALED_MANIFEST], [['perDevice'], 4], [['sealed'], 'false'], [['gpu'], 1],
    [['notebook', 'bytes'], REMOTE_NOTEBOOK_BYTES + 1], [['notebook', 'bytes'], 0], [['notebook', 'inline'], 'not base64!'],
    [['notebook', 'inline'], Buffer.from('other length').toString('base64')], [['notebook'], { sha256: '5'.repeat(64), bytes: big.length, inline: big.toString('base64') }],
    [['bundle'], { id: BUNDLE }], [['bundle'], { id: BUNDLE, packagesMb: 4097 }],
    [['bundle'], { id: BUNDLE, packagesMb: 15 }], [['bundle'], { id: '../wheels', packagesMb: 379 }],
  ] as const) refused(() => parseRemoteSyncReply(edit(reply, ['leases', 0, ...path], value)), /Invalid|Unexpected/)
  const sealed = { ...reply, trusted: true }
  refused(() => parseRemoteSyncReply(edit(sealed, ['leases', 0, 'sealed'], true)), /hidden/)
  refused(() => parseRemoteSyncReply(edit(sealed, ['leases', 0, 'gpu'], true)), /card share/)
  refused(() => parseRemoteSyncReply(edit(sealed, ['leases', 0], { ...gpuLease, perDevice: REMOTE_PER_DEVICE_MAX + 1 })))
})

/* -------------------------------------------------------------- sync reply */

test('sync reply: offers, revokes and applied outcomes never contradict each other', () => {
  refused(() => parseRemoteSyncReply({ ...reply, leases: [lease, lease] }))
  refused(() => parseRemoteSyncReply({ ...reply, seq: 6 }), /lease/, 'invalid')
  refused(() => parseRemoteSyncReply({ ...reply, revoke: [{ id: ATTEMPT, reason: 'cancelled' }] }), /Contradictory/)
  refused(() => parseRemoteSyncReply({ ...reply, applied: [ATTEMPT] }), /Contradictory/)
  refused(() => parseRemoteSyncReply({ ...reply, applied: ['a'.repeat(32)] }), /Contradictory/)
  refused(() => parseRemoteSyncReply({ ...reply, revoke: [{ id: 'a'.repeat(32), reason: 'cancelled' }, { id: 'a'.repeat(32), reason: 'lost' }] }))
  for (const reason of ['cancelled', 'withdrawn', 'lost', 'unknown']) assert.doesNotThrow(() => parseRemoteSyncReply(edit(reply, ['revoke', 0, 'reason'], reason)))
  refused(() => parseRemoteSyncReply(edit(reply, ['revoke', 0, 'reason'], 'because')))
  // Data of a competition being forgotten is not wanted in the same breath.
  refused(() => parseRemoteSyncReply({ ...reply, forget: [COMPETITION] }), /Contradictory/)
  // Seventeen inline notebooks of 64 KiB are past the reply's budget: the rest go as blobs.
  const inline = Buffer.alloc(REMOTE_INLINE_BYTES, 7).toString('base64')
  const many = Array.from({ length: REMOTE_INLINE_TOTAL_BYTES / REMOTE_INLINE_BYTES + 1 }, (_, i) => ({
    ...lease, attemptId: nth(i + 1, 32), notebook: { sha256: '5'.repeat(64), bytes: REMOTE_INLINE_BYTES, inline },
  }))
  assert.doesNotThrow(() => parseRemoteSyncReply({ ...reply, revoke: [], applied: [], leases: many.slice(1) }))
  refused(() => parseRemoteSyncReply({ ...reply, revoke: [], applied: [], leases: many }), /budget/)
  for (const [path, value] of [
    [['seq'], -1], [['drain'], 0], [['trusted'], undefined], [['compatible'], 'true'], [['approvedSlots'], -1], [['perDevice'], 0],
    [['perDevice'], REMOTE_PER_DEVICE_MAX + 1], [['homeVersion'], 'latest'], [['homeVersion'], undefined], [['forget'], ['../x']],
    [['want', 'bundles'], undefined],
  ] as const) refused(() => parseRemoteSyncReply(edit(reply, path, value)), /Invalid|Unexpected/)
})

test('sync reply: the hidden test reaches a trusted machine only, whatever home says', () => {
  const sealedWant = edit(reply, ['want', 'data', 0], { competitionId: COMPETITION, manifest: SEALED_MANIFEST, sealed: true, files: [{ name: 'test.csv', sha256: '6'.repeat(64), bytes: 10 }] })
  assert.doesNotThrow(() => parseRemoteSyncReply({ ...sealedWant, trusted: true }))
  refused(() => parseRemoteSyncReply(sealedWant), /untrusted/)
  refused(() => parseRemoteSyncReply({ ...reply, leases: [gpuLease] }), /untrusted/)
})

test('sync reply: what home wants fetched is bounded, named safely and described in full or not at all', () => {
  const at = (path: readonly (string | number)[], value: unknown) => edit(reply, ['want', ...path], value)
  for (const [path, value] of [
    [['revisions', 1], reply.want.revisions[0]], [['revisions', 0, 'gpu'], undefined], [['revisions', 0, 'ref'], 'kaggle-base'],
    [['data', 1], reply.want.data[0]], [['data', 0, 'competitionId'], undefined], [['data', 0, 'sealed'], 'no'],
    [['data', 0, 'files', 0, 'name'], '../secret/solution.csv'], [['data', 0, 'files', 0, 'name'], 'score/solution.csv'],
    [['data', 0, 'files', 1], reply.want.data[0].files[0]], [['data', 0, 'files', 0, 'bytes'], REMOTE_DATA_BYTES + 1],
    [['data', 0, 'files', 0, 'sha256'], 'abc'],
    [['bundles', 2], reply.want.bundles[0]], [['bundles', 0, 'packagesMb'], 15],
    // Half a set installs nothing: a lock comes with its wheels.
    [['bundles', 1, 'wheels'], undefined], [['bundles', 1, 'lock'], undefined], [['bundles', 1, 'lock'], 'pkg==1\u0000'],
    [['bundles', 1, 'lock'], 'x'.repeat(REMOTE_LOCK_CHARS + 1)], [['bundles', 1, 'wheels', 0, 'fileName'], '../x.whl'],
    [['bundles', 1, 'wheels', 0, 'fileName'], 'catboost.tar.gz'], [['bundles', 1, 'wheels', 0, 'bytes'], REMOTE_WHEELS_BYTES + 1],
    // A wheel's address: https, no credentials, no fragment, canonical, not too long.
    [['bundles', 1, 'wheels', 0, 'url'], `http://files.pythonhosted.org/${WHEEL}`],
    [['bundles', 1, 'wheels', 0, 'url'], `https://token:x@pypi.internal/${WHEEL}`],
    [['bundles', 1, 'wheels', 0, 'url'], `https://files.pythonhosted.org/${WHEEL}#sha256=${'7'.repeat(64)}`],
    [['bundles', 1, 'wheels', 0, 'url'], `https://Files.PythonHosted.org/${WHEEL}`],
    [['bundles', 1, 'wheels', 0, 'url'], `https://files.pythonhosted.org/${'a'.repeat(REMOTE_URL_CHARS)}.whl`],
  ] as const) refused(() => parseRemoteSyncReply(at(path, value)), /Invalid|Unexpected|over/)
  // The files of one manifest together stay within the data cap, and so do a set's wheels.
  const halves = [{ name: 'a.csv', sha256: '5'.repeat(64), bytes: REMOTE_DATA_BYTES / 2 }, { name: 'b.csv', sha256: '5'.repeat(64), bytes: REMOTE_DATA_BYTES / 2 + 1 }]
  refused(() => parseRemoteSyncReply(at(['data', 0, 'files'], halves)), /Data over its cap/)
  const wheel = reply.want.bundles[1].wheels![0]
  refused(() => parseRemoteSyncReply(at(['bundles', 1, 'wheels'], [{ ...wheel, bytes: REMOTE_WHEELS_BYTES }, { ...wheel, fileName: `x${WHEEL}`, bytes: 1 }])), /Wheels over/)
  refused(() => parseRemoteSyncReply(at(['bundles', 1, 'wheels'], Array.from({ length: REMOTE_WHEELS_MAX + 1 }, (_, i) => ({ ...wheel, fileName: `p${i}-1-py3-none-any.whl`, bytes: 1 })))))
  refused(() => parseRemoteSyncReply(at(['data', 0, 'files'], Array.from({ length: REMOTE_DATA_FILES_MAX + 1 }, (_, i) => ({ name: `f${i}.csv`, sha256: '5'.repeat(64), bytes: 1 })))))
  // A ready set comes by its id alone, and only so many come described in one reply.
  const described = (count: number) => Array.from({ length: count }, (_, i) => ({ id: nth(i, 32), packagesMb: 100, lock: '', wheels: [] }))
  assert.doesNotThrow(() => parseRemoteSyncReply(at(['bundles'], described(REMOTE_BUNDLE_DETAILS_MAX))))
  refused(() => parseRemoteSyncReply(at(['bundles'], described(REMOTE_BUNDLE_DETAILS_MAX + 1))))
  // What home passes a stored address through: the canonical address, or none.
  assert.equal(remoteWheelUrl(`https://Files.PythonHosted.org/packages/${WHEEL}`), `https://files.pythonhosted.org/packages/${WHEEL}`)
  for (const bad of [`http://x/${WHEEL}`, `https://u:p@x/${WHEEL}`, `https://x/${WHEEL}#h`, `https://x/${'a'.repeat(REMOTE_URL_CHARS)}`, 'not a url', 42, undefined])
    assert.equal(remoteWheelUrl(bad), undefined, String(bad))
  // A mirror's query is kept, as the set's manifest kept it (preparation-contract.ts · wheelUrl): refusing it would refuse the reply.
  const mirrored = `https://mirror.example/simple/catboost/${WHEEL}?download=1`
  assert.equal(remoteWheelUrl(mirrored), mirrored)
  assert.doesNotThrow(() => parseRemoteSyncReply(at(['bundles', 1, 'wheels', 0, 'url'], mirrored)))
})

test('a reply\'s keys the agent does not know are dropped at every depth and never kept; a request\'s are refused', () => {
  // A newer home within protocol 1 adds fields everywhere: the agent of this release reads the reply all the same.
  const newer = structuredClone(reply) as Record<string, unknown> & typeof reply
  Object.assign(newer, { notice: 'maintenance at 22:00' })
  Object.assign(newer.leases[0], { entrantName: 'Иванов', email: 'a@b.c', score: 0.93, metric: 'def score(...)', solution: 'x' })
  Object.assign(newer.leases[0].revision, { gpu: true })
  Object.assign(newer.leases[0].limits, { gpu: 1 })
  Object.assign(newer.leases[0].notebook, { path: '/var/lib/colloq' })
  Object.assign(newer.revoke[0], { note: 'x' })
  Object.assign(newer.want, { wheels: [] })
  Object.assign(newer.want.revisions[0], { size: 237_000_000 })
  Object.assign(newer.want.data[0], { priority: 1 })
  Object.assign(newer.want.data[0].files[0], { url: 'https://x' })
  Object.assign(newer.want.bundles[1], { python: '3.12' })
  Object.assign(newer.want.bundles[1].wheels![0], { mirror: 'https://mirror' })
  // JSON.parse makes `__proto__` an own key like any other: it is no key of the contract's either.
  const text = JSON.stringify(newer).replace(/^\{/, '{"__proto__":{"polluted":true},')
  const read = parseRemoteSyncReply(JSON.parse(text))
  assert.deepEqual(read, reply, 'what the parser returns is the contract\'s reply, exactly')
  assert.equal(JSON.stringify(read).includes('Иванов'), false, 'no name reaches what the agent writes down')
  assert.equal(Object.hasOwn(read, '__proto__'), false)
  assert.equal((read as unknown as Record<string, unknown>).polluted, undefined)
  assert.equal(({} as Record<string, unknown>).polluted, undefined)
  const bundled = parseRemoteSyncReply({ ...reply, trusted: true, leases: [{ ...gpuLease, bundle: { ...gpuLease.bundle, lock: '' } }] })
  assert.deepEqual(bundled.leases[0].bundle, gpuLease.bundle)
  // Whatever it drops, it still checks what it knows: a known key out of its shape is refused as before.
  refused(() => parseRemoteSyncReply({ ...newer, perDevice: 0 }))
  refused(() => parseRemoteSyncReply(edit(newer, ['leases', 0, 'limits', 'cpus'], 33)))
  // Home's parsers of a machine's requests stay strict: a key it does not know is a bug or a forgery, never a newer agent.
  refused(() => parseRemoteSyncRequest({ ...sync, notice: 'x' }), /Unexpected key "notice"/)
  refused(() => parseRemoteOutcomeRequest({ ...finished, next: true }), /Unexpected key/)
  refused(() => parseRemoteJoinRequest({ protocol: 1, build: BUILD, code: 'a'.repeat(32), joinId: 'b'.repeat(32), facts, extra: 1 }), /Unexpected key/)
})

test('two competitions with the very same files, and a hidden-test copy, are wanted side by side', () => {
  const files = [{ name: 'train.csv', sha256: '1'.repeat(64) }, { name: 'test.csv', sha256: '2'.repeat(64) }]
  const shared = remoteManifest(files, sha256)
  assert.equal(shared, remoteManifest([...files].reverse(), sha256), 'one manifest, whichever competition it is')
  const listed = files.map((file) => ({ ...file, bytes: 1000 }))
  const hidden = [{ name: 'test.csv', sha256: '3'.repeat(64), bytes: 10 }]
  const wanting = (data: unknown[], trusted = true) => ({ ...reply, leases: [], revoke: [], applied: [], forget: [], trusted, want: { ...reply.want, data } })
  // One task set for two groups: two competitions, one manifest, one entry each.
  const groups = wanting([
    { competitionId: 'x77h25nx', manifest: shared, sealed: false, files: listed },
    { competitionId: 'y88k36py', manifest: shared, sealed: false, files: listed },
  ], false)
  assert.deepEqual(parseRemoteSyncReply(groups).want.data.map((entry) => entry.competitionId), ['x77h25nx', 'y88k36py'])
  // A hidden-test copy of the first: the same open files, and its own hidden test.
  const copy = wanting([
    { competitionId: 'x77h25nx', manifest: shared, sealed: false, files: listed },
    { competitionId: 'y88k36py', manifest: shared, sealed: false, files: listed },
    { competitionId: 'y88k36py', manifest: remoteManifest(hidden, sha256), sealed: true, files: hidden },
  ])
  assert.equal(parseRemoteSyncReply(copy).want.data.length, 3)
  // One competition whose hidden test is its open files: the same manifest as both kinds.
  const both = wanting([
    { competitionId: 'x77h25nx', manifest: shared, sealed: false, files: listed },
    { competitionId: 'x77h25nx', manifest: shared, sealed: true, files: listed },
  ])
  assert.equal(parseRemoteSyncReply(both).want.data.length, 2)
  // The same competition, kind and manifest twice is a reply home could not mean.
  refused(() => parseRemoteSyncReply(wanting([
    { competitionId: 'x77h25nx', manifest: shared, sealed: false, files: listed },
    { competitionId: 'x77h25nx', manifest: shared, sealed: false, files: listed },
  ])), /Invalid wanted data/)
})

test('every address the set\'s manifest keeps (preparation-contract.ts · wheelUrl) is one the reply may carry', async () => {
  const { wheelUrl } = await import('../server/src/dependencies/preparation-contract.js')
  const hosts = ['files.pythonhosted.org:443', 'mirror.example:8443']
  for (const raw of [
    `https://files.pythonhosted.org/packages/1a/2b/${'c'.repeat(60)}/${WHEEL}`,
    `https://Files.PythonHosted.org/packages/${WHEEL}`,
    `https://mirror.example:8443/simple/catboost/${WHEEL}?download=1`,
    // The longest it keeps: 2,048 characters.
    `https://files.pythonhosted.org/packages/${'p'.repeat(2048 - 41 - WHEEL.length)}/${WHEEL}`,
  ]) {
    const kept = wheelUrl(raw, WHEEL, hosts)
    assert.ok(kept !== undefined, raw)
    assert.equal(remoteWheelUrl(kept), kept, raw)
  }
})

/* ----------------------------------------------------------------- uploads */

test('an upload: two names, gzip, and a declared size within its own cap', () => {
  const headers = { name: 'submission.csv', encoding: 'gzip', sha256: '8'.repeat(64), bytes: '20480' }
  assert.deepEqual(parseRemoteUploadMeta(headers, 64 * 1024 * 1024), { name: 'submission.csv', sha256: '8'.repeat(64), bytes: 20_480 })
  assert.deepEqual(parseRemoteUploadMeta({ ...headers, name: 'executed.ipynb', encoding: ' GZIP ', bytes: '0' }), { name: 'executed.ipynb', sha256: '8'.repeat(64), bytes: 0 })
  for (const name of ['run.json', 'solution.csv', 'metric.py', '../submission.csv', 'submission.csv/', 'progress.json', undefined])
    refused(() => parseRemoteUploadMeta({ ...headers, name }), /Unexpected result file/)
  for (const encoding of ['identity', 'br', 'gzip, gzip', undefined, ['gzip']]) refused(() => parseRemoteUploadMeta({ ...headers, encoding }), /encoding/)
  for (const bytes of ['', '01', '-1', '1e3', ' 5', '5.0', '0x10', '12345678901234567', undefined]) refused(() => parseRemoteUploadMeta({ ...headers, bytes }), /metadata/)
  for (const sha of ['8'.repeat(63), 'a'.repeat(64).toUpperCase(), ` ${'8'.repeat(64)}`, undefined]) refused(() => parseRemoteUploadMeta({ ...headers, sha256: sha }), /metadata/)
  // Declared over its cap: refused before a byte is read, as too large (413).
  refused(() => parseRemoteUploadMeta({ ...headers, bytes: '1025' }, 1024), /cap/, 'too_large')
  assert.doesNotThrow(() => parseRemoteUploadMeta({ ...headers, bytes: '1024' }, 1024))
  refused(() => parseRemoteUploadMeta({ ...headers, bytes: String(REMOTE_FILE_BYTES + 1) }, REMOTE_FILE_BYTES * 2), /cap/, 'too_large')
  refused(() => parseRemoteUploadMeta({ ...headers, name: 'executed.ipynb', bytes: String(REMOTE_FILE_BYTES + 1) }), /cap/, 'too_large')
  // The notebook's cap is its own, not the answer's.
  assert.doesNotThrow(() => parseRemoteUploadMeta({ ...headers, name: 'executed.ipynb', bytes: '2048' }, 1024))
  const stored = { name: 'executed.ipynb', sha256: '9'.repeat(64), bytes: 81_920 }
  assert.deepEqual(parseRemoteUploadReply(stored), stored)
  for (const bad of [{ ...stored, name: 'run.json' }, { ...stored, bytes: -1 }, { ...stored, sha256: 'x' }])
    refused(() => parseRemoteUploadReply(bad))
  assert.deepEqual(parseRemoteUploadReply({ ...stored, path: '/x' }), stored, 'a key it does not know is dropped')
})

/* ----------------------------------------------------------------- outcome */

test('outcome: a finished run and a decline, each with its own keys', () => {
  assert.deepEqual(parseRemoteOutcomeRequest(finished), finished)
  assert.deepEqual(parseRemoteOutcomeRequest(declined), declined)
  for (const reason of ['image', 'data', 'wheels', 'disk', 'memory', 'card', 'draining', 'version'])
    assert.doesNotThrow(() => parseRemoteOutcomeRequest({ ...declined, reason }))
  // A failed cell: the executed notebook comes back for the teacher, the answer stays behind.
  const failed = {
    ...finished, files: [finished.files[1]],
    outcome: {
      ...finished.outcome, status: 'cell_error', cell: 4, produced: true, detail: 'Traceback…\nZeroDivisionError: division by zero', log: 'exit 1',
      diagnostics: { exit: 1, oomKilled: false, backend: 'docker', peakBytes: null },
    },
  }
  assert.deepEqual(parseRemoteOutcomeRequest(failed), failed)
  // The harness wrote nothing: docker could not even start the container.
  const unstarted = { ...finished, runJson: null, files: [], outcome: { ...finished.outcome, status: 'harness_error', cell: -1, cells: 0, produced: false, diagnostics: { exit: null, oomKilled: false, backend: 'test' } } }
  assert.deepEqual(parseRemoteOutcomeRequest(unstarted), unstarted)
  // A set that ran out of room says how much it had.
  const noSpace = edit(edit(failed, ['outcome', 'status'], 'dependency_error'), ['outcome', 'dependencyFailure'], { reason: 'no_space', roomBytes: 379 * 1024 * 1024 })
  assert.doesNotThrow(() => parseRemoteOutcomeRequest(noSpace))
  assert.doesNotThrow(() => parseRemoteOutcomeRequest(edit(noSpace, ['outcome', 'dependencyFailure'], { reason: 'memory', bytes: 1, limitBytes: 2 })))
  // A shared card's run: crowded out by a neighbour, with the samples that decided it.
  const crowded = edit(edit(failed, ['outcome', 'crowded'], true), ['outcome', 'card'], { device: 'GPU-0b1c2d3e', perDevice: 4, sliceMb: 6141 })
  assert.doesNotThrow(() => parseRemoteOutcomeRequest(edit(crowded, ['outcome', 'diagnostics'], { exit: 1, oomKilled: false, backend: 'docker', killedBy: 'gpu', gpuPeakMb: 6500, gpuSamplesMb: [6400, 6500] })))
  assert.doesNotThrow(() => parseRemoteOutcomeRequest(edit(crowded, ['outcome', 'card', 'sliceMb'], null)))
})

test('outcome: refused for every field outside its shape, and when its files disagree with it', () => {
  for (const [path, value] of [
    [['outcome', 'status'], 'notebook_unreadable'], [['outcome', 'status'], 'scored'], [['outcome', 'cell'], -2], [['outcome', 'cell'], 2.5],
    [['outcome', 'cells'], REMOTE_CELLS_MAX + 1], [['outcome', 'wall'], -1], [['outcome', 'produced'], 'yes'], [['outcome', 'crowded'], undefined],
    [['outcome', 'detail'], 'x'.repeat(REMOTE_DETAIL_CHARS + 1)], [['outcome', 'log'], 'x'.repeat(REMOTE_LOG_CHARS + 1)],
    [['outcome', 'submission'], '/var/lib/colloq-runner/x/submission.csv'], [['outcome', 'score'], 0.9],
    [['outcome', 'diagnostics', 'exit'], 256], [['outcome', 'diagnostics', 'exit'], -1], [['outcome', 'diagnostics', 'backend'], 'broker'],
    [['outcome', 'diagnostics', 'killedBy'], 'teacher'], [['outcome', 'diagnostics', 'peakBytes'], -1], [['outcome', 'diagnostics', 'peakBytes'], 1e300],
    [['outcome', 'diagnostics', 'oomKilled'], undefined], [['outcome', 'diagnostics', 'host'], 'vast'],
    [['outcome', 'dependencyFailure'], { reason: 'no_space', roomBytes: 1 }],
    [['runJson'], 'not base64'], [['runJson'], Buffer.alloc(REMOTE_RUN_JSON_BYTES + 1).toString('base64')], [['runJson'], undefined], [['runJson'], { status: 'ok' }],
    [['files', 0, 'name'], 'solution.csv'], [['files', 1, 'name'], 'submission.csv'], [['files', 0, 'bytes'], REMOTE_FILE_BYTES + 1],
    [['files', 0, 'sha256'], 'x'], [['files', 2], { name: 'run.json', bytes: 1, sha256: '1'.repeat(64) }], [['files', 0, 'path'], '/x'],
    [['free'], undefined], [['free', 'slots'], -1], [['reason'], 'disk'], [['kind'], 'cancelled'], [['kind'], undefined],
  ] as const) refused(() => parseRemoteOutcomeRequest(edit(finished, path, value)), /Invalid|Unexpected|disagree/)
  // A success without its answer, and an answer from a run that wrote none.
  refused(() => parseRemoteOutcomeRequest({ ...finished, files: [finished.files[1]] }), /disagree/)
  refused(() => parseRemoteOutcomeRequest(edit(edit(finished, ['outcome', 'status'], 'cell_error'), ['outcome', 'produced'], false)), /disagree/)
  // Card diagnostics on a run without a card.
  for (const [key, value] of [['killedBy', 'gpu'], ['killedBy', 'gpu-unread'], ['gpuPeakMb', 100], ['gpuSamplesMb', [1]]] as const)
    refused(() => parseRemoteOutcomeRequest(edit(finished, ['outcome', 'diagnostics', key], value)), /card/)
  refused(() => parseRemoteOutcomeRequest(edit(finished, ['outcome', 'crowded'], true)), /card/)
  const carded = edit(finished, ['outcome', 'card'], { device: '0', perDevice: 4, sliceMb: 6141 })
  refused(() => parseRemoteOutcomeRequest(edit(carded, ['outcome', 'diagnostics', 'gpuSamplesMb'], [1, 2, 3, 4, 5])))
  refused(() => parseRemoteOutcomeRequest(edit(carded, ['outcome', 'card', 'perDevice'], 0)))
  refused(() => parseRemoteOutcomeRequest(edit(carded, ['outcome', 'card', 'device'], '../0')))
  for (const [path, value] of [[['reason'], 'bored'], [['detail'], 'x'.repeat(REMOTE_REASON_CHARS + 1)], [['detail'], undefined], [['files'], []], [['outcome'], finished.outcome]] as const)
    refused(() => parseRemoteOutcomeRequest(edit(declined, path, value)), /Invalid|Unexpected/)
  refused(() => parseRemoteOutcomeRequest({ ...declined, protocol: 2 }), /protocol/, 'protocol')
})

test('outcome reply: applied, refused or revoked, perhaps the next lease, and the trust as it is now', () => {
  for (const result of ['applied', 'refused', 'revoked']) {
    const answer = { result, seq: 7, leases: [lease], trusted: false }
    assert.deepEqual(parseRemoteOutcomeReply(answer), answer)
  }
  assert.doesNotThrow(() => parseRemoteOutcomeReply({ result: 'applied', seq: 0, leases: [], trusted: true }))
  for (const bad of [
    { result: 'ok', seq: 7, leases: [], trusted: false }, { result: 'applied', seq: 6, leases: [lease], trusted: false }, { result: 'applied', seq: 7, trusted: false },
    { result: 'applied', seq: 7, leases: [] }, { result: 'applied', seq: 7, leases: [], trusted: 'no' },
  ]) refused(() => parseRemoteOutcomeReply(bad))
  // The next lease of an outcome's reply obeys the sync reply's rule: the hidden test reaches a trusted machine only, whatever home says.
  assert.doesNotThrow(() => parseRemoteOutcomeReply({ result: 'applied', seq: 7, leases: [gpuLease], trusted: true }))
  refused(() => parseRemoteOutcomeReply({ result: 'applied', seq: 7, leases: [gpuLease], trusted: false }), /untrusted/)
  // A field a newer home added, at the top or inside a lease: dropped, never kept.
  const added = parseRemoteOutcomeReply({ result: 'applied', seq: 7, leases: [{ ...lease, email: 'a@b.c' }], trusted: false, next: lease })
  assert.deepEqual(added, { result: 'applied', seq: 7, leases: [lease], trusted: false })
})

test('error replies: one code per refusal, and its status', () => {
  assert.deepEqual(REMOTE_ERRORS, {
    invalid: 400, unauthorized: 401, code: 403, not_found: 404, revoked: 409, conflict: 409, gone: 410, too_large: 413,
    mismatch: 422, protocol: 426, too_often: 429, failed: 500, busy: 503, disk: 507,
  })
  for (const [error, status] of Object.entries(REMOTE_ERRORS)) {
    assert.deepEqual(parseRemoteErrorReply({ error }), { error })
    assert.deepEqual(parseRemoteErrorReply({ error, detail: 'x'.repeat(REMOTE_REASON_CHARS) }), { error, detail: 'x'.repeat(REMOTE_REASON_CHARS) })
    // Only home's own "not now" is retried; every other answer is acted on.
    assert.equal(remoteTransient(status, REMOTE_MARKER), status === 429 || status >= 500, error)
  }
  for (const bad of [{ error: 'teapot' }, { error: 'toString' }, { error: 'invalid', detail: 'x'.repeat(REMOTE_REASON_CHARS + 1) }, {}, '<html>502</html>'])
    refused(() => parseRemoteErrorReply(bad))
  assert.deepEqual(parseRemoteErrorReply({ error: 'invalid', stack: 'at …' }), { error: 'invalid' }, 'a key it does not know is dropped')
})

/* ----------------------------------------------------- made safe on the agent */

test('a forged progress.json cannot take a machine\'s heartbeat down: it is clamped before it is sent', () => {
  for (const [cell, cells] of [[1e300, -5], [-1e300, 1e300], [2.7, 13.9], [NaN, NaN], [Infinity, -Infinity], [-0.5, 0.5], [REMOTE_CELLS_MAX + 9, 2 ** 60]]) {
    const progress = remoteProgress({ phase: 'notebook', cell, cells })
    assert.ok(Number.isSafeInteger(progress.cell) && progress.cell >= -1 && progress.cell <= REMOTE_CELLS_MAX, `${cell} → ${progress.cell}`)
    assert.ok(Number.isSafeInteger(progress.cells) && progress.cells >= 0 && progress.cells <= REMOTE_CELLS_MAX, `${cells} → ${progress.cells}`)
    assert.doesNotThrow(() => parseRemoteSyncRequest(edit(sync, ['attempts', 0, 'progress'], progress)))
    // Raw, the same numbers are refused: that is why the agent never sends them raw.
    if (!Number.isSafeInteger(cell) || cell > REMOTE_CELLS_MAX) refused(() => parseRemoteSyncRequest(edit(sync, ['attempts', 0, 'progress'], { phase: 'notebook', cell, cells: 1 })))
  }
  assert.deepEqual(remoteProgress({ phase: 'dependencies', cell: -1, cells: 0 }), { phase: 'dependencies', cell: -1, cells: 0 })
  assert.deepEqual(remoteProgress({ cell: 3, cells: 14 }), { phase: 'notebook', cell: 3, cells: 14 })
  assert.deepEqual(remoteProgress({ phase: 'score', cell: 3, cells: 14 }), { phase: 'notebook', cell: 3, cells: 14 })
})

test('an honest outcome travels unchanged, without its path', () => {
  const run = {
    status: 'ok', cell: 13, cells: 14, wall: 31_337, submission: '/var/lib/colloq-runner/data/competitions/x/attempts/c/result/submission.csv',
    detail: '', log: '', diagnostics: { exit: 0, oomKilled: false, backend: 'docker', peakBytes: 1_234_567_890 },
  }
  assert.deepEqual(remoteOutcome({ ...run, produced: true }), finished.outcome)
  const gpu = {
    status: 'out-of-memory', cell: 9, cells: 14, wall: 61_000, submission: null, detail: '', log: 'OOMKilled',
    diagnostics: { exit: 137, oomKilled: false, backend: 'docker', killedBy: 'gpu' as const, peakBytes: null, gpuPeakMb: 6_600, gpuSamplesMb: [6_100, 6_500, 6_600] },
  }
  const card = { device: 'GPU-0b1c2d3e', perDevice: 4, sliceMb: 6_141 }
  const { submission: _path, ...wire } = gpu
  assert.deepEqual(remoteOutcome({ ...gpu, produced: false, crowded: false, card }), { ...wire, produced: false, crowded: false, card })
  const dependency = {
    status: 'dependency_error', cell: -1, cells: 0, wall: 4_000, detail: 'No space left on device', log: '',
    dependencyFailure: { reason: 'no_space' as const, roomBytes: 397_410_304 }, diagnostics: { exit: 1, oomKilled: false, backend: 'docker', peakBytes: null },
  }
  assert.deepEqual(remoteOutcome({ ...dependency, produced: false }), { ...dependency, produced: false, crowded: false })
})

test('a forged run.json is made whole and cut to the caps, so its outcome is applied rather than lost', () => {
  const traceback = `${'  File "<cell>", line 1, in <module>\n'.repeat(3000)}ModuleNotFoundError: No module named 'catboost'`
  const forged = remoteOutcome({
    status: 'notebook_unreadable', cell: -7.5, cells: 1e300, wall: -3, detail: traceback, log: 'x'.repeat(100_000),
    dependencyFailure: { reason: 'no_space', roomBytes: 1 },
    diagnostics: { exit: 70_000, oomKilled: false, backend: 'broker', peakBytes: 1e300, killedBy: 'teacher' as never },
    produced: false, crowded: true,
  })
  assert.equal(forged.status, 'unknown', 'a word the harness never says')
  assert.equal(forged.cell, -1)
  assert.equal(forged.cells, REMOTE_CELLS_MAX)
  assert.equal(forged.wall, 0)
  assert.equal(forged.detail.length, REMOTE_DETAIL_CHARS)
  // The tail survives the cut: its last line is what home reads for a hint (runner.ts · missingPackageHint).
  assert.ok(forged.detail.endsWith("ModuleNotFoundError: No module named 'catboost'"))
  assert.equal(forged.log.length, REMOTE_LOG_CHARS)
  assert.equal('dependencyFailure' in forged, false, 'only a failed install says why')
  assert.deepEqual(forged.diagnostics, { exit: null, oomKilled: false, backend: 'docker', peakBytes: Number.MAX_SAFE_INTEGER })
  assert.equal(forged.crowded, false, 'no card, no neighbour')
  assert.doesNotThrow(() => parseRemoteOutcomeRequest({ ...finished, files: [], outcome: forged }))
})

test('remoteOutcome always gives an outcome the parser takes, whatever the numbers and texts', () => {
  let seed = 20261013
  const random = (): number => {
    seed = (seed + 0x6d2b79f5) | 0
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
  const pick = <T,>(values: readonly T[]): T => values[Math.floor(random() * values.length)]
  const numbers = [-1e300, -5, -1, -0.5, 0, 0.5, 2.7, 13, 255, 256, 1e6, 1e6 + 1, 2 ** 53, 1e300, NaN, Infinity, -Infinity]
  const texts = ['', 'x', 'é'.repeat(9_000), worst(20_000), '😀'.repeat(5_000), `a${'😀'.repeat(4_001)}`, '\uD83D'.repeat(9_000)]
  const statuses = ['ok', 'cell_error', 'timeout', 'dependency_error', 'out-of-memory', 'harness_error', 'notebook_unreadable', 'bogus']
  for (let round = 0; round < 400; round++) {
    const status = pick(statuses)
    const card = random() < 0.5 ? { device: pick(['0', '7', 'GPU-0b1c2d3e']), perDevice: pick(numbers), sliceMb: random() < 0.3 ? null : pick(numbers) } : undefined
    const raw: RemoteOutcomeSource = {
      status, cell: pick(numbers), cells: pick(numbers), wall: pick(numbers), detail: pick(texts), log: pick(texts),
      ...(random() < 0.5 ? { dependencyFailure: random() < 0.5 ? { reason: 'no_space', roomBytes: pick(numbers) } : { reason: 'memory', bytes: pick(numbers), limitBytes: pick(numbers) } } : {}),
      diagnostics: {
        exit: random() < 0.2 ? null : pick(numbers), oomKilled: random() < 0.5, backend: pick(['docker', 'test', 'broker']),
        ...(random() < 0.5 ? { peakBytes: random() < 0.2 ? null : pick(numbers) } : {}),
        ...(card && random() < 0.5 ? { killedBy: pick(['gpu', 'gpu-unread', 'wall'] as const), gpuPeakMb: random() < 0.2 ? null : pick(numbers), gpuSamplesMb: Array.from({ length: Math.floor(random() * 8) }, () => pick(numbers)) } : {}),
        ...(!card && random() < 0.5 ? { killedBy: pick(['wall', 'output', 'disk'] as const) } : {}),
      },
      // An `ok` always produced its answer (docker-runner.ts · verdictOfRun).
      produced: status === 'ok' || random() < 0.5,
      crowded: random() < 0.5,
      ...(card ? { card } : {}),
    }
    const outcome = remoteOutcome(raw)
    const files = outcome.produced ? finished.files : [finished.files[1]]
    assert.doesNotThrow(() => parseRemoteOutcomeRequest({ ...finished, outcome, files }), JSON.stringify(raw).slice(0, 300))
  }
})

test('texts are cut to their caps at either end, never through a surrogate pair', () => {
  assert.equal(remoteText('short', 10, 'start'), 'short')
  assert.equal(remoteText('0123456789', 4, 'start'), '0123')
  assert.equal(remoteText('0123456789', 4, 'end'), '6789')
  assert.equal(remoteText('anything', 0, 'end'), '')
  // '😀' is two UTF-16 units: a cut through one drops the half rather than sending it.
  assert.equal(remoteText('😀😀😀', 3, 'start'), '😀')
  assert.equal(remoteText('😀😀😀', 3, 'end'), '😀')
  assert.equal(remoteText('a😀😀', 4, 'end'), '😀😀')
  assert.equal(remoteCount(7.9, 0, 10), 7)
  assert.equal(remoteCount(-7.9, -1, 10), -1)
  assert.equal(remoteCount(1e300, 0, 10), 10)
  assert.equal(remoteCount(NaN, 3, 10), 3)
  assert.equal(remoteCount(-Infinity, 1, 10), 1)
})

/* ------------------------------------------------- texts made on a machine */

/*
 * The machine's bundle has no dictionaries (server/src/runner-agent/i18n-shim.ts):
 * its `tr` is remoteTextMarker, and home reads the markers back in its own
 * language. These hold the two ends together with the real catalogues: what
 * the machine wrote reads on home exactly as home's own `tr` says it, and no
 * text, cut or forged, makes the reader throw or lets a marker character
 * through.
 */

const OPEN = REMOTE_TEXT_OPEN
const SPLIT = REMOTE_TEXT_SPLIT
/** Home's renderer in one language, as remoteRenderTexts takes it: translate, without the instance's setting in between. */
const homeIn = (locale: 'ru' | 'en') => (key: string, params: Record<string, string | number>): string => translate(locale, key, params)
/** A text read as plain text: the two characters gone and nothing else. */
const plain = (text: string): string => text.replace(/[\u2063\u2064]/g, '')
/** A marker's raw shape, for the ones remoteTextMarker would never write. */
const rawMarker = (key: string, json: string): string => `${OPEN}${key}${SPLIT}${json}${OPEN}`
const GPU_UNREAD = 'competitions.answer.gpuUnread'

/** Params whose JSON is exactly `chars` long, every string within its cap. */
function paramsOfJson(chars: number): Record<string, string | number> {
  const params: Record<string, string | number> = { count: 3 }
  const fill = 'x'.repeat(250)
  for (let i = 0; JSON.stringify({ ...params, [`p${i}`]: fill, pad: '' }).length <= chars; i++) params[`p${i}`] = fill
  params.pad = 'y'.repeat(chars - JSON.stringify({ ...params, pad: '' }).length)
  assert.equal(JSON.stringify(params).length, chars)
  assert.ok(Object.keys(params).length <= REMOTE_TEXT_PARAMS_MAX && (params.pad as string).length <= REMOTE_TEXT_PARAM_CHARS)
  return params
}

test('a marker is the key and its params between two invisible characters, which no catalogue text holds', () => {
  assert.equal(OPEN, '\u2063')
  assert.equal(SPLIT, '\u2064')
  assert.equal(remoteTextMarker(GPU_UNREAD, { count: 3 }), '\u2063competitions.answer.gpuUnread\u2064{"count":3}\u2063')
  assert.equal(remoteTextMarker('competitions.answer.gpuNeverRead'), '\u2063competitions.answer.gpuNeverRead\u2064{}\u2063')
  // JSON.stringify escapes neither character, so a marker inside a param travels as it is.
  assert.equal(JSON.stringify(`${OPEN}${SPLIT}`), `"${OPEN}${SPLIT}"`)
  const holding = Object.entries(messages).filter(([key, pair]) => /[\u2063\u2064]/.test(key + JSON.stringify(pair))).map(([key]) => key)
  assert.deepEqual(holding, [], 'a catalogue text with a marker character in it would read as a broken marker')
  // The catalogues' own spelling of a key is a marker's (every key the runner's core says is checked in
  // tests/runner-import-graph.test.mts); a phrase used as a key is not, and stays home's.
  assert.match(GPU_UNREAD, REMOTE_TEXT_KEY)
  assert.match('server.theHostMayBeMissingNvidiaContainer.f5c0df', REMOTE_TEXT_KEY)
  assert.doesNotMatch('room.editor.match case', REMOTE_TEXT_KEY)
})

test('a machine\'s marker reads on home as exactly what tr says there, in home\'s language', () => {
  const marker = remoteTextMarker(GPU_UNREAD, { count: 3 })
  assert.equal(remoteRenderTexts(marker, tr, hasTranslation), tr(GPU_UNREAD, { count: 3 }))
  const ru = remoteRenderTexts(marker, homeIn('ru'), hasTranslation)
  const en = remoteRenderTexts(marker, homeIn('en'), hasTranslation)
  assert.equal(ru, translate('ru', GPU_UNREAD, { count: 3 }))
  assert.equal(en, translate('en', GPU_UNREAD, { count: 3 }))
  assert.notEqual(ru, en, 'one marker, two languages: the machine does not pick one')
  assert.ok(en.includes('3') && !en.includes(GPU_UNREAD))
  // The count travels as a number, so the plural is home's as well.
  for (const count of [1, 2, 5, 21]) {
    for (const locale of ['ru', 'en'] as const) {
      assert.equal(remoteRenderTexts(remoteTextMarker(GPU_UNREAD, { count }), homeIn(locale), hasTranslation), translate(locale, GPU_UNREAD, { count }))
    }
  }
  // Inside a text, what is around the marker stays as it was.
  assert.equal(remoteRenderTexts(`Failed at cell 4.\n${marker}\n`, homeIn('en'), hasTranslation), `Failed at cell 4.\n${en}\n`)
  // A text with no marker is the text itself, character for character.
  const traceback = 'Traceback (most recent call last):\n  File "<cell>", line 1\nValueError: {count} — ü 😀 \uD83D'
  assert.equal(remoteRenderTexts(traceback, tr, hasTranslation), traceback)
  assert.equal(remoteRenderTexts('', tr, hasTranslation), '')
})

test('a key home does not know reads as the bare key', () => {
  const newer = remoteTextMarker('competitions.answer.fromANewerBuild', { count: 3, device: '0' })
  assert.equal(remoteRenderTexts(newer, tr, hasTranslation), 'competitions.answer.fromANewerBuild')
  assert.equal(remoteRenderTexts(`a ${newer} b`, tr, hasTranslation), 'a competitions.answer.fromANewerBuild b')
  // `known` decides, and a render that would make up words for any key is not asked.
  let asked = 0
  assert.equal(remoteRenderTexts(newer, () => `invented ${++asked}`, () => false), 'competitions.answer.fromANewerBuild')
  assert.equal(asked, 0)
  // An unknown key inside a known sentence: the sentence, with the key in its place.
  const killed = { device: '0', count: 3, reason: remoteTextMarker('competitions.answer.fromANewerBuild'), slice: 6141 }
  assert.equal(
    remoteRenderTexts(remoteTextMarker('competitions.answer.gpuUnreadKilled', killed), homeIn('en'), hasTranslation),
    translate('en', 'competitions.answer.gpuUnreadKilled', { ...killed, reason: 'competitions.answer.fromANewerBuild' }),
  )
})

test('a marker that is not well formed stays as plain text, without the two characters', () => {
  const whole = remoteTextMarker(GPU_UNREAD, { count: 3 })
  const malformed = [
    // Cut through at a cap (remoteText), from either end.
    whole.slice(1), whole.slice(0, -1), whole.slice(9), whole.slice(0, 25), whole.slice(0, -5),
    // Keys a catalogue may have but a marker cannot carry, and none at all.
    rawMarker('', '{}'), rawMarker('room.editor.match case', '{}'), rawMarker('k'.repeat(161), '{}'), rawMarker('competitions/answer', '{}'),
    // Params that are no JSON object.
    rawMarker(GPU_UNREAD, '[3]'), rawMarker(GPU_UNREAD, '"3"'), rawMarker(GPU_UNREAD, 'null'), rawMarker(GPU_UNREAD, '3'), rawMarker(GPU_UNREAD, ''),
    rawMarker(GPU_UNREAD, '{"count":3'), rawMarker(GPU_UNREAD, '{"count":}'), rawMarker(GPU_UNREAD, '{} {}'), rawMarker(GPU_UNREAD, ' {}'),
    rawMarker(GPU_UNREAD, `{"count":3${SPLIT}}`),
    // Values that are no primitive, or no finite number.
    rawMarker(GPU_UNREAD, '{"count":{"n":3}}'), rawMarker(GPU_UNREAD, '{"count":[3]}'), rawMarker(GPU_UNREAD, '{"count":null}'), rawMarker(GPU_UNREAD, '{"count":1e999}'),
    // Over the caps: entries, a string, the JSON.
    remoteTextMarker(GPU_UNREAD, Object.fromEntries(Array.from({ length: REMOTE_TEXT_PARAMS_MAX + 1 }, (_, i) => [`p${i}`, i]))),
    remoteTextMarker(GPU_UNREAD, { count: 3, reason: 'r'.repeat(REMOTE_TEXT_PARAM_CHARS + 1) }),
    remoteTextMarker(GPU_UNREAD, paramsOfJson(REMOTE_TEXT_JSON_CHARS + 1)),
    // The characters on their own.
    OPEN, SPLIT, `${OPEN}${OPEN}`, `${SPLIT}${OPEN}${SPLIT}`, `a${OPEN}b${SPLIT}c${OPEN}`, `${OPEN}${GPU_UNREAD}${SPLIT}`,
  ]
  for (const text of malformed) {
    assert.equal(remoteRenderTexts(text, tr, hasTranslation), plain(text), JSON.stringify(text).slice(0, 200))
  }
  // At the caps a marker is still one.
  const atCaps = [
    { device: '0', count: 3, reason: 'r'.repeat(REMOTE_TEXT_PARAM_CHARS), slice: 6141 },
    { ...Object.fromEntries(Array.from({ length: REMOTE_TEXT_PARAMS_MAX - 1 }, (_, i) => [`p${i}`, i])), count: 3 },
    paramsOfJson(REMOTE_TEXT_JSON_CHARS),
  ]
  for (const params of atCaps) {
    const key = 'competitions.answer.gpuUnreadKilled'
    assert.equal(remoteRenderTexts(remoteTextMarker(key, params), tr, hasTranslation), tr(key, params))
  }
  assert.equal(remoteRenderTexts(rawMarker('k'.repeat(160), '{"flag":true}'), (key, params) => `${key.length} ${JSON.stringify(params)}`, () => true), '160 {"flag":"true"}')
})

test('markers inside a param and side by side come out whole, and a cut one spoils only itself', () => {
  // docker-runner.ts · unreadCardNotes, when the card never answered: the reason is itself a tr.
  const stalled = { seconds: 5 }
  const killed = (reason: string) => ({ device: 'GPU-0b1c2d3e', count: 3, reason, slice: 6141 })
  const nested = remoteTextMarker('competitions.answer.gpuUnreadKilled', killed(remoteTextMarker('competitions.answer.gpuSampleStalled', stalled)))
  const neverMarker = remoteTextMarker('competitions.answer.gpuNeverRead')
  for (const locale of ['ru', 'en'] as const) {
    const home = homeIn(locale)
    const expected = translate(locale, 'competitions.answer.gpuUnreadKilled', killed(translate(locale, 'competitions.answer.gpuSampleStalled', stalled)))
    const never = translate(locale, 'competitions.answer.gpuNeverRead')
    assert.equal(remoteRenderTexts(nested, home, hasTranslation), expected)
    // With a space between, as unreadCardNotes joins them; with nothing between; at either end of a text.
    assert.equal(remoteRenderTexts(`${nested} ${neverMarker}`, home, hasTranslation), `${expected} ${never}`)
    assert.equal(remoteRenderTexts(`${nested}${neverMarker}${neverMarker}`, home, hasTranslation), `${expected}${never}${never}`)
    assert.equal(remoteRenderTexts(`docker: exit 125\n${neverMarker}`, home, hasTranslation), `docker: exit 125\n${never}`)
    assert.equal(remoteRenderTexts(`${neverMarker}\nthe log goes on`, home, hasTranslation), `${never}\nthe log goes on`)
    // A log cut at its start (remoteText keeps a log's end) keeps a broken head and the whole marker after it.
    for (let cut = 1; cut < nested.length; cut += 7) {
      const head = nested.slice(cut)
      assert.equal(remoteRenderTexts(`${head}${neverMarker}`, home, hasTranslation), `${plain(head)}${never}`, `cut at ${cut}`)
    }
  }
  // Deeper than REMOTE_TEXT_DEPTH a marker is plain text: only a made-up text nests further.
  const echo = (key: string, params: Record<string, string | number>): string => `${key}(${params.x ?? ''})`
  let deep = remoteTextMarker(`k${REMOTE_TEXT_DEPTH}`)
  const innermost = deep
  for (let level = REMOTE_TEXT_DEPTH - 1; level >= 0; level--) deep = remoteTextMarker(`k${level}`, { x: deep })
  const opened = Array.from({ length: REMOTE_TEXT_DEPTH }, (_, level) => `k${level}(`).join('')
  assert.equal(remoteRenderTexts(deep, echo, () => true), `${opened}${plain(innermost)}${')'.repeat(REMOTE_TEXT_DEPTH)}`)
})

test('a marker a notebook prints itself renders a sentence it could have printed, and takes in nothing else', () => {
  // The notebook raises with a marker for a message: home shows what `raise RuntimeError(<our sentence>)` would have.
  const forged = remoteTextMarker(GPU_UNREAD, { count: 3 })
  const ours = translate('en', GPU_UNREAD, { count: 3 })
  const traceback = `Traceback (most recent call last):\n  File "<cell>", line 1, in <module>\nRuntimeError: ${forged}`
  assert.equal(remoteRenderTexts(traceback, homeIn('en'), hasTranslation), traceback.replace(forged, ours))
  // Its params go into our sentence as plain text, as translate puts them in, and are read as nothing more.
  const markup = { device: '<img src=x onerror=alert(1)>', count: 3, reason: '{device} ${process.env.SECRET}', slice: 6141 }
  assert.equal(
    remoteRenderTexts(remoteTextMarker('competitions.answer.gpuUnreadKilled', markup), homeIn('en'), hasTranslation),
    translate('en', 'competitions.answer.gpuUnreadKilled', markup),
  )
  // A param that is no primitive makes no sentence at all.
  const shaped = rawMarker(GPU_UNREAD, '{"count":{"valueOf":3,"toString":"x"}}')
  assert.equal(remoteRenderTexts(shaped, homeIn('en'), hasTranslation), plain(shaped))
  // A forged marker that never closes is plain text, and the honest marker after it renders as ever.
  const unclosed = `${OPEN}${GPU_UNREAD}${SPLIT}{"count":"`
  const honest = remoteTextMarker('competitions.answer.gpuNeverRead')
  assert.equal(remoteRenderTexts(`${unclosed} ${honest}`, homeIn('en'), hasTranslation), `${plain(unclosed)} ${translate('en', 'competitions.answer.gpuNeverRead')}`)
  // The notebook's own invisible characters go, and nothing else of what it printed.
  assert.equal(remoteRenderTexts(`total${OPEN} 3${SPLIT}`, tr, hasTranslation), 'total 3')
})

test('rendering never throws and never lets a marker character through, whatever the text or the renderer', () => {
  const marker = remoteTextMarker(GPU_UNREAD, { count: 3 })
  assert.equal(remoteRenderTexts(marker, () => { throw new Error('render') }, hasTranslation), GPU_UNREAD)
  assert.equal(remoteRenderTexts(marker, tr, () => { throw new Error('known') }), GPU_UNREAD)
  assert.equal(remoteRenderTexts(marker, (() => undefined) as never, hasTranslation), GPU_UNREAD)
  assert.equal(remoteRenderTexts(undefined as never, tr, hasTranslation), '')
  assert.equal(remoteRenderTexts(null as never, tr, hasTranslation), '')
  // A param named after Object's own is a param, in a property of its own.
  const named = rawMarker('k', '{"__proto__":"x","constructor":"y","count":2}')
  const seen = (key: string, params: Record<string, string | number>): string =>
    `${key} ${Object.hasOwn(params, '__proto__')} ${params.__proto__} ${params.constructor} ${Object.getPrototypeOf(params) === Object.prototype}`
  assert.equal(remoteRenderTexts(named, seen, () => true), 'k true x y true')

  let seed = 20261014
  const random = (): number => {
    seed = (seed + 0x6d2b79f5) | 0
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
  const pieces = [
    OPEN, SPLIT, OPEN, SPLIT, '{', '}', '"', '\\', ':', ',', '[', ']', ' ', 'count', '3', '1e999', 'true', 'null', 'é', '😀', '\uD83D',
    GPU_UNREAD, 'competitions.answer.gpuNeverRead', 'k'.repeat(170), 'x'.repeat(400), marker, remoteTextMarker('competitions.answer.gpuNeverRead'),
    remoteTextMarker('competitions.answer.gpuUnreadKilled', { device: '0', count: 3, reason: marker, slice: 1 }),
  ]
  for (let round = 0; round < 3000; round++) {
    const text = Array.from({ length: Math.floor(random() * 24) }, () => pieces[Math.floor(random() * pieces.length)]).join('')
    let out = ''
    assert.doesNotThrow(() => { out = remoteRenderTexts(text, homeIn('en'), hasTranslation) }, JSON.stringify(text).slice(0, 300))
    assert.doesNotMatch(out, /[\u2063\u2064]/, JSON.stringify(text).slice(0, 300))
    // So a rendered text renders as itself: reading twice, as a retried apply might, changes nothing.
    assert.equal(remoteRenderTexts(out, homeIn('en'), hasTranslation), out)
  }

  // The worst a detail at its cap can do: a marker opened every six characters, each reading a JSON string to the
  // end of its cap (an escaped quote never closes one). Every opening is read that far, and still it is quick.
  const worstCase = `${OPEN}a${SPLIT}{\\"`.repeat(Math.ceil(REMOTE_DETAIL_CHARS / 6)).slice(0, REMOTE_DETAIL_CHARS)
  const started = performance.now()
  assert.equal(remoteRenderTexts(worstCase, tr, hasTranslation), plain(worstCase))
  assert.ok(performance.now() - started < 2_000, `${Math.round(performance.now() - started)} ms`)
})

/* -------------------------------------------------------- the sizes add up */

/**
 * A path at its worst for a body: 400 characters, each three bytes of UTF-8,
 * in segments at their 255-byte cap; distinct by `i`. Control characters and
 * lone surrogates, which escape longer, are no path a parser takes.
 */
const WIDE = '界'.repeat(85)
function worstPath(i: number): string {
  const id = String(i)
  const value = `${WIDE}/${WIDE}/${WIDE}/${WIDE}/${'界'.repeat(56 - id.length)}${id}`
  assert.equal(normalizePath(value), value)
  return value
}
const worstSession = (i: number) => `${'s'.repeat(60)}${nth(i, 4)}`
/** A notebook's root at its worst: a path's of August 2026 at its longest, three bytes a character (remote-kernels.ts · isRemoteRoot). */
function worstRoot(i: number): string {
  const id = String(i)
  const value = `nb:${'界'.repeat(REMOTE_ROOT_CHARS - 'nb:'.length - id.length)}${id}`
  assert.ok(isRemoteRoot(value) && value.length === REMOTE_ROOT_CHARS)
  return value
}

/** The largest kernels block home's parser takes from a machine: every count and cap at its worst at once. */
function worstKernelsRequest() {
  const reports = Array.from({ length: REMOTE_PLACEMENTS_MAX }, (_, r) => ({
    sessionId: worstSession(r), gen: Number.MAX_SAFE_INTEGER, seq: Number.MAX_SAFE_INTEGER, full: true, page: { index: Number.MAX_SAFE_INTEGER, last: false },
    changed: [] as Record<string, unknown>[], removed: [], skipped: [],
  }))
  // The paths of one sync together, all of them changes (the longest entry), two of them inline at their cap.
  for (let i = 0; i < REMOTE_REPORT_PATHS_MAX; i++) {
    const inline = i < CLASS_INLINE_REPORT_BYTES / CLASS_INLINE_BYTES
    reports[i % reports.length]!.changed.push({
      path: worstPath(i), sha256: 'f'.repeat(64), bytes: inline ? CLASS_INLINE_BYTES : Number.MAX_SAFE_INTEGER, base: 'e'.repeat(64),
      ...(inline ? { inline: Buffer.alloc(CLASS_INLINE_BYTES, 0xff).toString('base64') } : {}),
    })
  }
  return {
    placements: Array.from({ length: REMOTE_PLACEMENTS_MAX }, (_, i) => ({
      key: `${worstSession(i)}:room`, gen: Number.MAX_SAFE_INTEGER, phase: 'failed', container: 'c'.repeat(64), revision: `sha256:${'a'.repeat(64)}`,
      failure: { unschedulable: 'other', memoryMb: 262_144, cpus: 63.999_999_9, detail: worst(REMOTE_REASON_CHARS) },
      usage: { usedMb: REMOTE_MEMORY_MB_MAX, limitMb: REMOTE_MEMORY_MB_MAX, cpus: REMOTE_CPUS_MAX, cpuPercent: 100 * REMOTE_CPUS_MAX, startedAt: Number.MAX_SAFE_INTEGER, oomKills: Number.MAX_SAFE_INTEGER },
      card: { device: `G${String(i).padStart(63, '0')}`, usedMb: REMOTE_CARD_MB_MAX },
      files: { pushSeq: Number.MAX_SAFE_INTEGER, pending: Number.MAX_SAFE_INTEGER, pendingBytes: Number.MAX_SAFE_INTEGER, heldOnly: Number.MAX_SAFE_INTEGER, heldOnlyBytes: Number.MAX_SAFE_INTEGER },
      resized: 'pending',
    })),
    reports,
    epochs: Array.from({ length: REMOTE_EPOCHS_MAX }, (_, e) => ({
      sessionId: worstSession(e), root: worstRoot(e), seq: Number.MAX_SAFE_INTEGER, ready: false,
      missing: Array.from({ length: COUNCIL_EPOCH_BUFFERS_MAX / REMOTE_EPOCHS_MAX }, (_, i) => nth(e * COUNCIL_EPOCH_BUFFERS_MAX + i, 64)),
    })),
    readings: Array.from({ length: REMOTE_READINGS_MAX }, (_, i) => ({
      key: `${worstSession(i)}:council`, gen: Number.MAX_SAFE_INTEGER,
      reading: {
        limit: Number.MAX_SAFE_INTEGER, peak: Number.MAX_SAFE_INTEGER, current: Number.MAX_SAFE_INTEGER, kills: Number.MAX_SAFE_INTEGER,
        containerOomKilled: true, status: 'r'.repeat(16), exit: 255, tail: Array.from({ length: REMOTE_READING_LINES_MAX }, () => worst(REMOTE_READING_LINE_CHARS)),
      },
    })),
    tunnel: 'down', bye: 'restart',
    classes: { hostNetwork: false, perimeter: 'no-iptables', mode: 'blocked', canary: worst(REMOTE_REASON_CHARS), sameDaemon: false },
  }
}

/** The largest kernels block the agent takes from home: every count and cap at its worst at once. */
function worstKernelsReply() {
  const longRef = `${'r'.repeat(262)}.io/${'p'.repeat(262)}@sha256:${'3'.repeat(64)}`
  const sessions = Array.from({ length: REMOTE_PLACEMENTS_MAX }, (_, i) => worstSession(i))
  // The pushes' paths together, all of them files (the longest entry per path), a mebibyte of them inline.
  const pushes = sessions.map((sessionId) => ({ sessionId, seq: Number.MAX_SAFE_INTEGER, full: true, promoted: true, put: [] as Record<string, unknown>[], remove: [], move: [] }))
  for (let i = 0; i < REMOTE_PUSH_PATHS_MAX; i++) {
    const inline = i < CLASS_INLINE_PUSH_BYTES / CLASS_INLINE_BYTES
    pushes[i % pushes.length]!.put.push({
      path: worstPath(i), sha256: 'f'.repeat(64), bytes: inline ? CLASS_INLINE_BYTES : Number.MAX_SAFE_INTEGER,
      ...(inline ? { inline: Buffer.alloc(CLASS_INLINE_BYTES, 0xff).toString('base64') } : {}),
    })
  }
  // Verdicts: every path refused for its base, each with a conflict copy of its own as long as itself.
  const verdicts = sessions.map((sessionId) => ({ sessionId, seq: Number.MAX_SAFE_INTEGER, accepted: [], refused: [] as Record<string, unknown>[] }))
  for (let i = 0; i < REMOTE_REPORT_PATHS_MAX; i++) verdicts[i % verdicts.length]!.refused.push({ path: worstPath(i), why: 'base', copy: worstPath(i + 100_000) })
  const pulls = sessions.map((sessionId) => ({ sessionId, gen: Number.MAX_SAFE_INTEGER, paths: [] as Record<string, unknown>[] }))
  for (let i = 0; i < REMOTE_REPORT_PATHS_MAX; i++) pulls[i % pulls.length]!.paths.push({ path: worstPath(i), sha256: 'f'.repeat(64) })
  // Every epoch a machine may hold, naming every file one reply may name, each at the most its epoch's cap leaves it.
  const buffersEach = REMOTE_EPOCH_FILES_MAX / REMOTE_EPOCHS_MAX
  const perBuffer = Math.floor((COUNCIL_EPOCH_MB * 1024 * 1024) / buffersEach)
  return {
    placements: sessions.map((sessionId) => ({
      key: `${sessionId}:council`, gen: Number.MAX_SAFE_INTEGER, environment: 'e'.repeat(32), revision: { id: 'd'.repeat(32), ref: longRef, layers: '4'.repeat(64) },
      memoryMb: 262_144, cpus: 64, pids: 32_768, gpu: false, network: 'blocked',
      blockedCidrs: Array.from({ length: REMOTE_BLOCKED_CIDRS_MAX }, (_, i) => `255.255.${i}.255/32`), token: 'e'.repeat(40), hashSeed: 4_294_967_295, workers: COUNCIL_WORKERS.max,
    })),
    pushes, verdicts, pulls,
    scan: sessions.map((sessionId) => ({ sessionId, full: true })),
    epochs: Array.from({ length: REMOTE_EPOCHS_MAX }, (_, e) => ({
      sessionId: worstSession(e), root: worstRoot(e), seq: 999_999_999_999_999, manifest: { sha256: 'f'.repeat(64), bytes: 4 * 1024 * 1024 },
      buffers: Array.from({ length: buffersEach }, (_, i) => ({ sha256: nth(e * COUNCIL_EPOCH_BUFFERS_MAX + i, 64), bytes: perBuffer })),
      from: { container: 'c'.repeat(64), dir: `${COUNCIL_EPOCH_DIR}/999999999999999` },
    })),
    collect: Array.from({ length: REMOTE_COLLECTS_MAX }, (_, c) => ({
      sessionId: sessions[c]!, runId: 'r'.repeat(64),
      files: Array.from({ length: COUNCIL_ARTIFACTS.files }, (_, f) => ({ name: worstPath(c * 100 + f), sha256: 'f'.repeat(64), bytes: COUNCIL_ARTIFACTS.totalBytes / COUNCIL_ARTIFACTS.files })),
    })),
    postmortem: Array.from({ length: REMOTE_READINGS_MAX }, (_, i) => `${sessions[i]!}:own`),
    rates: { classBulkMBps: 1000, machinePaceMBps: 1000 },
    tunnel: 'reconnect',
  }
}

test('the largest join, sync and outcome a parser accepts fit their body caps, escaped at their worst', () => {
  const most = (i: number, width: number) => nth(i, width)
  const device = (i: number) => `G${String(i).padStart(63, '0')}`
  const worstFacts = {
    version: `1234.1234.123456-${'a'.repeat(40)}+${'b'.repeat(40)}`, hostname: worst(REMOTE_HOSTNAME_CHARS), platform: `linux/${'a'.repeat(16)}`,
    cpus: REMOTE_CPUS_MAX, memoryMb: REMOTE_MEMORY_MB_MAX, diskMb: REMOTE_DISK_MB_MAX, docker: worst(REMOTE_LABEL_CHARS), storage: worst(REMOTE_LABEL_CHARS),
    driver: '9999.9999.9999.9999',
  }
  const worstFree = { slots: REMOTE_ATTEMPTS_MAX, memoryMb: REMOTE_MEMORY_MB_MAX, cpus: REMOTE_CPUS_MAX, gpuShares: REMOTE_CARDS_MAX * REMOTE_PER_DEVICE_MAX, diskMb: REMOTE_DISK_MB_MAX }

  const join = { protocol: 1, build: BUILD, code: 'a'.repeat(32), joinId: 'b'.repeat(32), facts: worstFacts }
  assert.doesNotThrow(() => parseRemoteJoinRequest(join))
  assert.ok(bytesOf(join) <= REMOTE_JOIN_BYTES, `join: ${bytesOf(join)} > ${REMOTE_JOIN_BYTES}`)

  const request = {
    protocol: 1, build: BUILD, seq: Number.MAX_SAFE_INTEGER, holdMs: REMOTE_HOLD_BUSY_MS, state: 'draining', free: worstFree,
    cards: Array.from({ length: REMOTE_CARDS_MAX }, (_, i) => ({ device: device(i), name: worst(REMOTE_LABEL_CHARS), memoryMb: REMOTE_CARD_MB_MAX, perDevice: REMOTE_PER_DEVICE_MAX, busyShares: REMOTE_PER_DEVICE_MAX })),
    ready: {
      revisions: Array.from({ length: REMOTE_REVISIONS_MAX }, (_, i) => most(i, 32)), data: Array.from({ length: REMOTE_MANIFESTS_MAX }, (_, i) => most(i, 64)),
      sealed: Array.from({ length: REMOTE_MANIFESTS_MAX }, (_, i) => most(i + 1000, 64)), bundles: Array.from({ length: REMOTE_BUNDLES_MAX }, (_, i) => most(i, 32)),
    },
    fetching: Array.from({ length: REMOTE_FETCHING_MAX }, (_, i) => ({ manifest: most(i, 64), percent: 100 })),
    attempts: Array.from({ length: REMOTE_ATTEMPTS_MAX }, (_, i) => ({
      id: most(i, 32), phase: 'running', runningMs: REMOTE_RUN_MS_MAX, progress: { phase: 'dependencies', cell: REMOTE_CELLS_MAX, cells: REMOTE_CELLS_MAX },
      card: { device: device(i), sliceMb: REMOTE_CARD_MB_MAX },
    })),
    problems: Array.from({ length: REMOTE_PROBLEMS_MAX }, (_, i) => ({ code: 'wheels', bundleId: most(i, 32), detail: worst(REMOTE_REASON_CHARS) })),
    facts: worstFacts,
  }
  assert.doesNotThrow(() => parseRemoteSyncRequest(request))
  assert.ok(bytesOf(request) <= REMOTE_SYNC_BYTES, `sync: ${bytesOf(request)} > ${REMOTE_SYNC_BYTES}`)
  // A machine with classes adds its kernels block at its worst: the 0.23 part stays within the quarter it always had.
  assert.ok(bytesOf(request) <= 256 * 1024)
  const classSync = { ...request, kernels: worstKernelsRequest() }
  assert.doesNotThrow(() => parseRemoteSyncRequest(classSync))
  assert.ok(bytesOf(classSync) <= REMOTE_SYNC_BYTES, `sync with classes: ${bytesOf(classSync)} > ${REMOTE_SYNC_BYTES}`)

  const outcome = {
    protocol: 1, build: BUILD, free: worstFree, kind: 'finished',
    outcome: {
      status: 'dependency_error', cell: REMOTE_CELLS_MAX, cells: REMOTE_CELLS_MAX, wall: REMOTE_RUN_MS_MAX, produced: true,
      detail: worst(REMOTE_DETAIL_CHARS), log: worst(REMOTE_LOG_CHARS),
      dependencyFailure: { reason: 'memory', bytes: Number.MAX_SAFE_INTEGER, limitBytes: Number.MAX_SAFE_INTEGER },
      diagnostics: {
        exit: 255, oomKilled: true, backend: 'docker', killedBy: 'gpu-unread', peakBytes: Number.MAX_SAFE_INTEGER,
        gpuPeakMb: REMOTE_CARD_MB_MAX, gpuSamplesMb: Array(4).fill(REMOTE_CARD_MB_MAX),
      },
      crowded: true, card: { device: device(0), perDevice: REMOTE_PER_DEVICE_MAX, sliceMb: REMOTE_CARD_MB_MAX },
    },
    runJson: Buffer.alloc(REMOTE_RUN_JSON_BYTES, 0xff).toString('base64'),
    files: REMOTE_FILE_NAMES.map((name) => ({ name, bytes: REMOTE_FILE_BYTES, sha256: 'f'.repeat(64) })),
  }
  assert.doesNotThrow(() => parseRemoteOutcomeRequest(outcome))
  assert.ok(bytesOf(outcome) <= REMOTE_OUTCOME_BYTES, `outcome: ${bytesOf(outcome)} > ${REMOTE_OUTCOME_BYTES}`)
})

test('the largest sync reply the agent accepts fits the reply cap it reads up to', () => {
  const most = (i: number, width: number) => nth(i, width)
  // Six hundred characters, the most a pin may have.
  const longRef = `${'r'.repeat(262)}.io/${'p'.repeat(262)}@sha256:${'3'.repeat(64)}`
  const inline = Buffer.alloc(REMOTE_INLINE_BYTES, 7).toString('base64')
  const leases = Array.from({ length: REMOTE_ATTEMPTS_MAX }, (_, i) => ({
    ...gpuLease, attemptId: most(i, 32), seq: Number.MAX_SAFE_INTEGER, deadlineMs: REMOTE_RUN_MS_MAX,
    revision: { id: most(i, 32), ref: longRef, layers: '4'.repeat(64) },
    notebook: i < REMOTE_INLINE_TOTAL_BYTES / REMOTE_INLINE_BYTES
      ? { sha256: '5'.repeat(64), bytes: REMOTE_INLINE_BYTES, inline }
      : { sha256: '5'.repeat(64), bytes: REMOTE_NOTEBOOK_BYTES },
  }))
  const url = (i: number) => {
    const head = `https://files.pythonhosted.org/packages/${i}/`
    return `${head}${'w'.repeat(REMOTE_URL_CHARS - head.length - 4)}.whl`
  }
  const bundles = Array.from({ length: REMOTE_BUNDLES_MAX }, (_, i) => i < REMOTE_BUNDLE_DETAILS_MAX
    ? {
      id: most(i, 32), packagesMb: 4096, lock: '"'.repeat(REMOTE_LOCK_CHARS),
      wheels: Array.from({ length: REMOTE_WHEELS_MAX }, (_, w) => ({
        // The longest name a published set keeps: 235 characters (REMOTE_WHEEL_NAME).
        fileName: `${String(w).padStart(225, 'w')}-1-py3.whl`, sha256: '7'.repeat(64), bytes: REMOTE_WHEELS_BYTES / REMOTE_WHEELS_MAX, url: url(w),
      })),
    }
    : { id: most(i, 32), packagesMb: 4096 })
  const answer = {
    seq: Number.MAX_SAFE_INTEGER, leases,
    revoke: Array.from({ length: REMOTE_ATTEMPTS_MAX }, (_, i) => ({ id: most(i + 1000, 32), reason: 'withdrawn' })),
    applied: Array.from({ length: REMOTE_ATTEMPTS_MAX }, (_, i) => most(i + 2000, 32)),
    want: {
      revisions: Array.from({ length: REMOTE_REVISIONS_MAX }, (_, i) => ({ id: most(i, 32), ref: longRef, layers: '4'.repeat(64), gpu: true })),
      data: Array.from({ length: REMOTE_MANIFESTS_MAX }, (_, i) => ({
        competitionId: 'x77h25nx', manifest: most(i, 64), sealed: true,
        files: Array.from({ length: REMOTE_DATA_FILES_MAX }, (_, f) => ({ name: `${String(f).padStart(116, 'f')}.csv`, sha256: '5'.repeat(64), bytes: REMOTE_DATA_BYTES / REMOTE_DATA_FILES_MAX })),
      })),
      bundles,
    },
    forget: Array.from({ length: REMOTE_MANIFESTS_MAX }, (_, i) => most(i, 8).replace(/[01]/g, 'z')).filter((id, i, all) => all.indexOf(id) === i),
    drain: true, trusted: true, approvedSlots: REMOTE_ATTEMPTS_MAX, perDevice: REMOTE_PER_DEVICE_MAX, compatible: false,
    homeVersion: `1234.1234.123456-${'a'.repeat(40)}+${'b'.repeat(40)}`,
  }
  assert.doesNotThrow(() => parseRemoteSyncReply(answer))
  assert.ok(bytesOf(answer) <= REMOTE_REPLY_BYTES, `reply: ${bytesOf(answer)} > ${REMOTE_REPLY_BYTES}`)
  // The 0.23 fields stay under the 16 MiB they always had; a machine with classes gets its kernels block at its worst on top.
  assert.ok(bytesOf(answer) <= 16 * 1024 * 1024)
  const kernels = worstKernelsReply()
  assert.doesNotThrow(() => parseRemoteKernelsReply(kernels))
  // The hidden test never rides with placements (D3), so the two worsts never meet in one reply: their sum bounds every reply there is.
  const both = bytesOf(answer) + bytesOf({ kernels })
  assert.ok(both <= REMOTE_REPLY_BYTES, `reply with classes: ${both} > ${REMOTE_REPLY_BYTES}`)
  assert.doesNotThrow(() => parseRemoteSyncReply({ ...answer, trusted: false, leases: answer.leases.map(({ sealedData: _, ...lease }) => ({ ...lease, sealed: false })), want: { ...answer.want, data: answer.want.data.map((entry) => ({ ...entry, sealed: false })) }, kernels }))
})

/* ---------------------------------------------- numbers shared with the code */

test('the contract\'s numbers are the editor\'s, the store\'s, the settings\' and the broker\'s', () => {
  assert.equal(REMOTE_NOTEBOOK_BYTES, LIMITS.notebookBytes)
  assert.equal(REMOTE_FILE_BYTES, LIMITS.submissionBytes)
  assert.equal(REMOTE_DATA_BYTES, LIMITS.dataBytes)
  assert.equal(REMOTE_DATA_BYTES, LIMITS.sealedBytes)
  assert.equal(REMOTE_DATA_FILES_MAX, LIMITS.files + LIMITS.sealedFiles)
  assert.equal(REMOTE_WALL_SECONDS_MAX, LIMITS.wallSeconds.max)
  assert.equal(REMOTE_ATTEMPTS_MAX, SETTINGS_LIMITS.slots.max)
  assert.equal(REMOTE_PER_DEVICE_MAX, SETTINGS_LIMITS.gpuPerDevice.max)
  assert.equal(REMOTE_WHEELS_BYTES, DEPENDENCY_LIMITS.downloadBytes)
  assert.deepEqual([...REMOTE_FILE_NAMES], ['submission.csv', EXECUTED_NOTEBOOK_FILE])
  // Home reads the last LIMITS.participantError characters of a traceback; the harness hands over twice that.
  assert.ok(REMOTE_DETAIL_CHARS >= 2 * LIMITS.participantError)
  // The biggest set a policy allows has a room the lease can name.
  assert.ok(packagesRoomMb(DEPENDENCY_LIMITS.installedBytes) <= 4096 && packagesRoomMb(0) >= 16)
  // The broker's own attempt ids are the ones a lease carries.
  assert.equal(COMPETITION_ATTEMPT_ID.test(ATTEMPT), true)
})

test('the clocks agree with each other and with the path in between', () => {
  // Proxies cut a request at 30 s and frps answers 504 at 60: a held sync is answered before either.
  assert.ok(REMOTE_HOLD_IDLE_MS < 30_000)
  assert.ok(REMOTE_HOLD_BUSY_MS < REMOTE_HOLD_IDLE_MS)
  // An offer is withdrawn long before its machine counts as silent, and a backing-off agent is heard in time.
  assert.ok(REMOTE_OFFER_MS < REMOTE_SILENCE_MS)
  assert.ok(REMOTE_BACKOFF_MAX_MS + REMOTE_HOLD_IDLE_MS < REMOTE_SILENCE_MS)
  // Evidence outlives one failed probe.
  assert.ok(REMOTE_EVIDENCE_MS >= 2 * REMOTE_PROBE_MS)
  // After a restart every machine has the whole silence window to be heard again.
  assert.ok(REMOTE_BOOT_GRACE_MS >= REMOTE_SILENCE_MS)
  assert.equal(remoteCeilingMs(600), 10 * 60_000 + 600_000 + 120_000 + 10 * 60_000)
  assert.equal(REMOTE_RUN_MS_MAX, remoteCeilingMs(LIMITS.wallSeconds.max))
  assert.ok(REMOTE_INLINE_TOTAL_BYTES >= REMOTE_INLINE_BYTES && REMOTE_INLINE_BYTES < REMOTE_NOTEBOOK_BYTES)
})
