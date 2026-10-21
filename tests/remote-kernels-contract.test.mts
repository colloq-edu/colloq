/**
 * The contract of classes on machines (shared/remote-kernels.ts,
 * docs/architecture/remote-classes.md §15): home's strict parser of the
 * machine's `kernels` block and the agent's tolerant parser of home's, the
 * keys and doors, the echo check both kernel clients make
 * (shared/runtime.ts · checkRuntimeEndpoint), the two modules loading in
 * either order, and the server's words of §13.2.
 *
 * What is checked is what breaks in the middle of a class on a rented
 * machine and nowhere else. A parser that took an extra key lets a forged
 * field into home; one that refused an honest block takes every placement of
 * the machine down with it. A path outside the folder's rules is a file home
 * would write where it must not; an inline block past its cap a sync no body
 * cap holds. A stale gen read as a fresh one is a kernel answering for
 * another placement. And a word that drifted from the design's table is a
 * room reading something nobody agreed on.
 */
import './_env.mts'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { build } from 'esbuild'
import ts from 'typescript'
import * as Y from 'yjs'
import {
  CLASS_BARRIER_MS,
  CLASS_BARRIER_STALL_MS,
  CLASS_BULK_IDLE_MBPS,
  CLASS_BULK_MBPS,
  CLASS_BULK_PROMOTED_MBPS,
  CLASS_BYE_GRACE_MS,
  CLASS_COMPETITION_MBPS,
  CLASS_EVIDENCE_MS,
  CLASS_FAILOVER_SEC,
  CLASS_FILE_QUIET_MS,
  CLASS_HELP_PAD_MAX_MS,
  CLASS_INLINE_BYTES,
  CLASS_INLINE_PUSH_BYTES,
  CLASS_INLINE_REPORT_BYTES,
  CLASS_LATE_MAX,
  CLASS_MACHINE_FILE_MB,
  CLASS_MOVE_NOW_MS,
  CLASS_PACE_BURST_BYTES,
  CLASS_ROOM_MB,
  CLASS_PROBE_MS,
  CLASS_QUARANTINE_FAILOVERS,
  CLASS_QUARANTINE_WINDOW_MS,
  CLASS_SCAN_BUSY_MS,
  CLASS_SCAN_IDLE_MS,
  CLASS_SILENCE_MS,
  CLASS_START_MS,
  CLASS_SYNC_FILES_MAX,
  CLASS_TUNNEL_STUCK_MS,
  CLASS_UNREACHABLE_NOTE_MS,
  COUNCIL_ARTIFACTS,
  COUNCIL_ATTEMPT_MB,
  COUNCIL_EPOCH_BUFFERS_MAX,
  COUNCIL_EPOCH_DIR,
  COUNCIL_EPOCH_MB,
  COUNCIL_EPOCH_SHIP_MB,
  COUNCIL_EPOCH_STORE_MB,
  COUNCIL_EPOCH_WAIT_MS,
  COUNCIL_EPOCHS_MOUNT,
  COUNCIL_POOL_LINGER_MS,
  COUNCIL_POOL_READY_MS,
  COUNCIL_SCRATCH_ENTRIES,
  COUNCIL_SCRATCH_MOUNT,
  COUNCIL_WORKERS,
  COUNCIL_WORKER_REUSE,
  MACHINE_PACE_BURST_BYTES,
  MACHINE_PACE_MBPS,
  PERIMETER_FAILURES_MAX,
  PERIMETER_RECHECK_MS,
  REMOTE_CLASS_UPLOADS,
  REMOTE_COLLECTED_MAX,
  REMOTE_COLLECTS_MAX,
  REMOTE_EPOCHS_MAX,
  REMOTE_EPOCH_FILES_MAX,
  REMOTE_FILE_CAP_MB_MAX,
  REMOTE_PLACEMENTS_MAX,
  REMOTE_PUSH_PATHS_MAX,
  REMOTE_READINGS_MAX,
  REMOTE_READING_LINES_MAX,
  REMOTE_READING_LINE_CHARS,
  REMOTE_REPORT_PATHS_MAX,
  REMOTE_ROOT_CHARS,
  REMOTE_SESSION_ID,
  REMOTE_SHM,
  councilEpochPath,
  councilScratchPath,
  isRemoteRoot,
  parseRemoteKernelsReply,
  parseRemoteKernelsRequest,
  parseRemotePlacementKey,
  remoteClassPaths,
  remotePlacementKey,
  remoteRevisionDigest,
  type RemoteKernelsReply,
  type RemoteKernelsRequest,
} from '../shared/remote-kernels.js'
import { RemoteProtocolError, REMOTE_HOLD_BUSY_MS, REMOTE_REASON_CHARS, REMOTE_REF_CHARS, REMOTE_TEXT_KEY } from '../shared/remote-runner.js'
import { MAX_PATH, MAX_SEGMENT, normalizePath } from '../shared/paths.js'
import { CELLS_KEY, addBook, bookList, ensureInitialNotebook, isBookRoot } from '../shared/notebook.js'
import { RUNTIME_SESSION_ID, RuntimeEndpointError, checkRuntimeEndpoint, type RuntimeEndpointRefusal } from '../shared/runtime.js'
import { messages, setLocaleResolver, translate } from '../shared/i18n.js'
import { RuntimeClient } from '../server/src/kernel/runtime-client.js'
import { RUNNER_OPTIONS, withoutTranslations } from '../server/scripts/build-runner.mjs'

/* ---------------------------------------------------------------- fixtures */

const SESSION = 'seminar_1'
const OTHER = 'seminar_2'
const CONTAINER = 'c'.repeat(64)
const DIGEST = `sha256:${'a'.repeat(64)}`
const REF = `ghcr.io/colloq-edu/colloq-kernel@sha256:${'3'.repeat(64)}`
const sha = (i: number): string => i.toString(16).padStart(64, '0')
const b64 = (bytes: number, fill = 7): string => Buffer.alloc(bytes, fill).toString('base64')

function refused(run: () => unknown, message: RegExp = /./): void {
  assert.throws(run, (error: unknown) => error instanceof RemoteProtocolError && error.code === 'invalid' && message.test(error.message), String(message))
}

/** A deep copy with the field at `path` set; `undefined` removes it. */
function edit<T>(value: T, at: readonly (string | number)[], next: unknown): T {
  const copy = structuredClone(value) as Record<string | number, unknown>
  let node = copy
  for (const key of at.slice(0, -1)) node = node[key] as Record<string | number, unknown>
  const last = at[at.length - 1]!
  if (next === undefined) delete node[last]
  else node[last] = next
  return copy as T
}

const request: RemoteKernelsRequest = {
  placements: [
    {
      key: 'seminar_1:room', gen: 3, phase: 'ready', container: CONTAINER, revision: DIGEST,
      usage: { usedMb: 3100, limitMb: 8192, cpus: 4, cpuPercent: 12, startedAt: 1_792_000_000_000, oomKills: 0 },
      card: { device: 'GPU-0b1c2d3e', usedMb: 1200 },
      files: { pushSeq: 7, pending: 3, pendingBytes: 12_000_000, heldOnly: 2, heldOnlyBytes: 2_100_000_000 },
      resized: 'applied',
    },
    { key: 'seminar_1:own', gen: 1, phase: 'starting', container: 'd'.repeat(64), usage: { usedMb: null, limitMb: 16_384, cpus: 8, cpuPercent: null, startedAt: 0, oomKills: 2 } },
    { key: 'seminar_1:council', gen: 2, phase: 'pulling' },
    { key: 'seminar_2:room', gen: 5, phase: 'failed', failure: { unschedulable: 'memory', memoryMb: 8192, cpus: 1.5, detail: 'docker: cannot allocate memory' } },
    { key: 'seminar_2:own', gen: 1, phase: 'stopping', resized: 'absent' },
  ],
  reports: [
    {
      sessionId: SESSION, gen: 3, seq: 12,
      changed: [
        { path: 'out.csv', sha256: sha(1), bytes: 5, base: null, inline: Buffer.from('a,b\n1').toString('base64') },
        { path: 'данные/выборка 1.csv', sha256: sha(2), bytes: 2_100_000, base: sha(3) },
        // A folder that became a file: one path, one change.
        { path: 'results', sha256: sha(4), bytes: 10, base: 'dir' },
      ],
      removed: [{ path: 'old.csv', base: sha(5) }, { path: 'tmp', base: 'dir' }],
      skipped: [{ path: 'model.pt', bytes: 2_254_857_830, why: 'size' }, { path: 'torch/__init__.py', bytes: 100, why: 'package' }],
      // Said «на машине» before, gone from the machine since; and one that now travels (out.csv, changed above).
      released: ['checkpoint.bin', 'out.csv'],
    },
    { sessionId: OTHER, gen: 5, seq: 1, full: true, page: { index: 0, last: true }, changed: [], removed: [], skipped: [{ path: 'big.bin', bytes: 1, why: 'room' }], late: ['out.csv', 'model.pt'] },
  ],
  epochs: [
    { sessionId: SESSION, root: 'cells', seq: 4, ready: true },
    { sessionId: SESSION, root: 'nb:b_k3j2h1g0f9e8', seq: 2, ready: false, missing: [sha(6), sha(7)] },
  ],
  readings: [{
    key: 'seminar_2:room', gen: 5,
    reading: { limit: 8_589_934_592, peak: 8_589_000_000, current: 120_000_000, kills: 1, containerOomKilled: false, status: 'running', exit: null, tail: ['Killed', 'KernelRestarter: restarting kernel'] },
  }],
  tunnel: 'up',
  classes: { hostNetwork: true, perimeter: 'ok', mode: 'blocked', canary: 'ok', sameDaemon: false },
}

const intent = {
  key: 'seminar_1:room', gen: 3, environment: 'base-gpu', revision: { id: 'd'.repeat(32), ref: REF, layers: '4'.repeat(64) },
  memoryMb: 8192, cpus: 4, pids: 512, gpu: true, network: 'blocked' as const, blockedCidrs: ['203.0.113.0/24', '198.51.100.7/32'],
  token: 'e'.repeat(40), hashSeed: 2_947_120_311, shm: '1g',
}

const reply: RemoteKernelsReply = {
  placements: [
    intent,
    { ...intent, key: 'seminar_1:own', gen: 1, environment: 'base', memoryMb: 16_384, cpus: 8, pids: 2048, gpu: false, network: 'none', blockedCidrs: [] },
    { ...intent, key: 'seminar_1:council', gen: 2, environment: 'base', memoryMb: 9216, gpu: false, workers: 8 },
  ],
  pushes: [{
    sessionId: SESSION, seq: 8, full: false, promoted: true,
    put: [
      { path: 'train.csv', sha256: sha(8), bytes: 150_000_000 },
      { path: 'utils.py', sha256: sha(9), bytes: 12, inline: b64(12) },
      { path: 'data', dir: true },
      // A folder at home became a file: removed, then put, in that order.
      { path: 'results', sha256: sha(10), bytes: 3 },
    ],
    remove: ['old.csv', 'results'],
    move: [{ from: 'a.csv', to: 'archive/a.csv' }],
  }, { sessionId: OTHER, seq: 1, full: true, put: [], remove: [], move: [] }],
  verdicts: [{
    sessionId: SESSION, seq: 12, accepted: ['out.csv', 'данные/выборка 1.csv'],
    refused: [{ path: 'Тетрадь.ipynb', why: 'book' }, { path: 'data.csv', why: 'base', copy: 'data (с машины 14-32).csv' }, { path: 'x.bin', why: 'cap' }],
  }],
  // The version a report named, and «Привезти» of a file left on the machine: as it is now, no hash.
  pulls: [{ sessionId: SESSION, gen: 3, paths: [{ path: 'данные/выборка 1.csv', sha256: sha(2) }, { path: 'model.pt' }] }],
  scan: [{ sessionId: SESSION }, { sessionId: OTHER, full: true }],
  epochs: [
    { sessionId: SESSION, root: 'cells', seq: 4, manifest: { sha256: sha(11), bytes: 2048 }, buffers: [{ sha256: sha(12), bytes: 500_000_000 }, { sha256: sha(13), bytes: 65_536 }], from: 'home' },
    { sessionId: SESSION, root: 'nb:b_k3j2h1g0f9e8', seq: 2, manifest: { sha256: sha(14), bytes: 900 }, buffers: [], from: { container: CONTAINER, dir: `${COUNCIL_EPOCH_DIR}/2` } },
  ],
  collect: [{ sessionId: SESSION, runId: 'r_1792000000', files: [{ name: 'out.csv', sha256: sha(15), bytes: 12_000 }, { name: 'plots/fig.png', sha256: sha(16), bytes: 40_000 }] }],
  postmortem: ['seminar_2:room'],
  rates: { classBulkMBps: CLASS_BULK_MBPS, machinePaceMBps: MACHINE_PACE_MBPS },
  caps: { machineFileMb: CLASS_MACHINE_FILE_MB, roomMb: CLASS_ROOM_MB },
  tunnel: 'open',
}

/** Paths a class folder never holds: each a rule of shared/paths.ts, and the two a file system cannot give back. */
const BAD_PATHS = [
  '', '/etc/passwd', '\\x', '../x', 'a/../b', 'a/./b', 'a//b', 'a/', '.env', 'a/.git/config', 'a\\b',
  'x'.repeat(MAX_SEGMENT + 1), Array.from({ length: 9 }, () => 'a').join('/'), Array.from({ length: 4 }, () => 'a'.repeat(100)).join('/'),
  'line\nbreak', 'nul\u0000', 'tab\there', ' lead', 'trail ', 'half\uD83D', '\uDC00tail',
]
/** Paths that are files like any other. */
const GOOD_PATHS = ['данные/выборка.csv', 'Тетрадь.ipynb', 'a/b/c/d/e/f/g/h', '😀.txt', 'data (с машины 14-32).csv', 'x'.repeat(MAX_SEGMENT)]

/* ------------------------------------------------- the machine's block, at home */

test('home takes the machine\'s block as it is sent, and returns it checked', () => {
  assert.deepEqual(parseRemoteKernelsRequest(request), request)
  // The smallest block: a machine with classes that holds nothing yet.
  const empty = { placements: [], reports: [], epochs: [], readings: [], tunnel: 'down', classes: { ...request.classes, perimeter: 'no-iptables', canary: 'pending', hostNetwork: false } }
  assert.deepEqual(parseRemoteKernelsRequest(empty), empty)
  for (const bye of ['restart', 'stopping', 'leaving']) assert.doesNotThrow(() => parseRemoteKernelsRequest({ ...request, bye }))
  for (const perimeter of ['ok', 'no-dockerd', 'no-iptables', 'refused', 'failing']) assert.doesNotThrow(() => parseRemoteKernelsRequest(edit(request, ['classes', 'perimeter'], perimeter)))
  for (const mode of ['blocked', 'none', 'open']) assert.doesNotThrow(() => parseRemoteKernelsRequest(edit(request, ['classes', 'mode'], mode)))
  for (const resized of ['applied', 'pending', 'absent']) assert.doesNotThrow(() => parseRemoteKernelsRequest(edit(request, ['placements', 0, 'resized'], resized)))
  for (const unschedulable of ['memory', 'cpu', 'gpu', 'other']) assert.doesNotThrow(() => parseRemoteKernelsRequest(edit(request, ['placements', 3, 'failure'], { unschedulable })))
  // An epoch that holds everything may say so with an empty list.
  assert.doesNotThrow(() => parseRemoteKernelsRequest(edit(request, ['epochs', 0, 'missing'], [])))
  // The number of home's last reply the agent took in, said back: a whole number, or no key at all.
  assert.deepEqual(parseRemoteKernelsRequest({ ...request, heard: 1_792_000_000_123 }), { ...request, heard: 1_792_000_000_123 })
  for (const heard of [-1, 1.5, '7', null, 2 ** 53]) refused(() => parseRemoteKernelsRequest({ ...request, heard }), /kernels block/)
})

test('home refuses a key it does not know, at every depth of the machine\'s block', () => {
  for (const at of [
    [], ['placements', 0], ['placements', 3, 'failure'], ['placements', 0, 'usage'], ['placements', 0, 'card'], ['placements', 0, 'files'],
    ['reports', 0], ['reports', 0, 'changed', 0], ['reports', 0, 'removed', 0], ['reports', 0, 'skipped', 0], ['reports', 1, 'page'], ['epochs', 1], ['readings', 0],
    ['readings', 0, 'reading'], ['classes'],
  ] as const) {
    refused(() => parseRemoteKernelsRequest(edit(request, [...at, 'stray'], 1)), /Unexpected key "stray"/)
  }
  for (const bad of [null, [], 'kernels', 1]) refused(() => parseRemoteKernelsRequest(bad))
  for (const [at, value] of [
    [['tunnel'], 'open'], [['tunnel'], undefined], [['bye'], 'crash'], [['classes'], undefined], [['classes', 'perimeter'], 'maybe'],
    [['classes', 'mode'], 'host'], [['classes', 'hostNetwork'], 'yes'], [['classes', 'sameDaemon'], undefined],
    // The canary's words say what failed: never nothing, never a log.
    [['classes', 'canary'], ''], [['classes', 'canary'], 'x'.repeat(REMOTE_REASON_CHARS + 1)],
    [['placements'], undefined], [['reports'], {}], [['epochs'], null], [['readings'], undefined],
  ] as const) refused(() => parseRemoteKernelsRequest(edit(request, at, value)), /Invalid|Unexpected/)
})

test('gens below one, fractional or past the safe integers are refused, both ways', () => {
  for (const gen of [0, -1, 1.5, '3', 2 ** 53, null, undefined]) {
    refused(() => parseRemoteKernelsRequest(edit(request, ['placements', 0, 'gen'], gen)), /held placement/)
    refused(() => parseRemoteKernelsRequest(edit(request, ['reports', 0, 'gen'], gen)), /files report/)
    refused(() => parseRemoteKernelsRequest(edit(request, ['readings', 0, 'gen'], gen)), /reading/)
    refused(() => parseRemoteKernelsReply(edit(reply, ['placements', 0, 'gen'], gen)), /placement intent/)
    refused(() => parseRemoteKernelsReply(edit(reply, ['pulls', 0, 'gen'], gen)), /pull/)
  }
  // The largest a gen may be is the largest a JavaScript number counts exactly.
  assert.doesNotThrow(() => parseRemoteKernelsRequest(edit(request, ['placements', 0, 'gen'], Number.MAX_SAFE_INTEGER)))
  // One placement per slot: the same key twice is no state a machine can be in, whatever the gens.
  refused(() => parseRemoteKernelsRequest(edit(request, ['placements', 1], { ...request.placements[0], gen: 4 })), /held placement/)
  refused(() => parseRemoteKernelsReply(edit(reply, ['placements', 1], { ...intent, gen: 4 })), /placement intent/)
  // One reading per placement and gen; one report per class.
  refused(() => parseRemoteKernelsRequest(edit(request, ['readings', 1], request.readings[0])), /reading/)
  refused(() => parseRemoteKernelsRequest(edit(request, ['reports', 1, 'sessionId'], SESSION)), /files report/)
})

test('a held placement carries what its phase says it has, and nothing of another slot\'s', () => {
  // A ready placement echoes its container and its image, as the broker's answer does.
  refused(() => parseRemoteKernelsRequest(edit(request, ['placements', 0, 'container'], undefined)), /echoes/)
  refused(() => parseRemoteKernelsRequest(edit(request, ['placements', 0, 'revision'], undefined)), /echoes/)
  refused(() => parseRemoteKernelsRequest(edit(request, ['placements', 2, 'container'], CONTAINER)), /pulling/)
  refused(() => parseRemoteKernelsRequest(edit(request, ['placements', 3, 'failure'], undefined)), /failure/)
  refused(() => parseRemoteKernelsRequest(edit(request, ['placements', 1, 'failure'], { unschedulable: 'cpu' })), /failure/)
  // A whole card is a GPU room's.
  for (const slot of [1, 2]) refused(() => parseRemoteKernelsRequest(edit(request, ['placements', slot, 'card'], { device: '0', usedMb: null })), /card/)
  for (const [at, value] of [
    [['placements', 0, 'key'], 'seminar_1:lecture'], [['placements', 0, 'key'], 'seminar_1'], [['placements', 0, 'key'], '../x:room'],
    [['placements', 0, 'phase'], 'running'], [['placements', 0, 'container'], 'colloq-class-abc'], [['placements', 0, 'container'], 'C'.repeat(64)],
    [['placements', 0, 'revision'], 'd'.repeat(32)], [['placements', 0, 'revision'], REF], [['placements', 0, 'resized'], 'done'],
    [['placements', 0, 'card', 'device'], '../0'], [['placements', 0, 'card', 'usedMb'], -1],
    [['placements', 0, 'usage', 'cpuPercent'], 12.5], [['placements', 0, 'usage', 'usedMb'], -1], [['placements', 0, 'usage', 'limitMb'], undefined],
    [['placements', 0, 'usage', 'startedAt'], '2026-10-16'], [['placements', 0, 'usage', 'oomKills'], -1],
    [['placements', 0, 'files', 'pending'], 1.5], [['placements', 0, 'files', 'heldOnlyBytes'], undefined],
    [['placements', 3, 'failure', 'unschedulable'], 'disk'], [['placements', 3, 'failure', 'memoryMb'], 63], [['placements', 3, 'failure', 'cpus'], 0],
    [['placements', 3, 'failure', 'cpus'], 65], [['placements', 3, 'failure', 'detail'], 'x'.repeat(REMOTE_REASON_CHARS + 1)],
  ] as const) refused(() => parseRemoteKernelsRequest(edit(request, at, value)), /Invalid|Unexpected/)
  refused(() => parseRemoteKernelsRequest({ ...request, placements: Array.from({ length: REMOTE_PLACEMENTS_MAX + 1 }, (_, i) => ({ key: `s${i}:room`, gen: 1, phase: 'pulling' })) }))
})

test('a path in the machine\'s block is a canonical path inside the class folder, or the block is refused', () => {
  const late = (pathName: unknown) => edit(request, ['reports', 1, 'late', 0], pathName)
  for (const bad of BAD_PATHS) {
    // Each breaks a rule of normalizePath, or is its root, or holds half a surrogate pair.
    assert.ok(bad === '' || normalizePath(bad) !== bad || /[\uD800-\uDFFF]/.test(bad), `${JSON.stringify(bad)} is a path normalizePath keeps as it is`)
    refused(() => parseRemoteKernelsRequest(edit(request, ['reports', 0, 'changed', 0, 'path'], bad)), /changed file/)
    refused(() => parseRemoteKernelsRequest(edit(request, ['reports', 0, 'removed', 0, 'path'], bad)), /removed file/)
    refused(() => parseRemoteKernelsRequest(edit(request, ['reports', 0, 'skipped', 0, 'path'], bad)), /skipped file/)
    refused(() => parseRemoteKernelsRequest(edit(request, ['reports', 0, 'released', 0], bad)), /released file/)
    refused(() => parseRemoteKernelsRequest(late(bad)), /late change/)
  }
  // A path released is no longer left on the machine: not one it leaves there in the same report, nor one it releases twice.
  refused(() => parseRemoteKernelsRequest(edit(request, ['reports', 0, 'released', 0], 'model.pt')), /released file/)
  refused(() => parseRemoteKernelsRequest(edit(request, ['reports', 0, 'released', 1], 'checkpoint.bin')), /released file/)
  refused(() => parseRemoteKernelsRequest(edit(request, ['reports', 0, 'released'], 'checkpoint.bin')), /released files/)
  for (const good of GOOD_PATHS) {
    assert.doesNotThrow(() => parseRemoteKernelsRequest(edit(request, ['reports', 0, 'changed', 1, 'path'], good)), good)
    assert.doesNotThrow(() => parseRemoteKernelsRequest(late(good)), good)
  }
  // One path, one fate in a report: changed, removed or left behind.
  refused(() => parseRemoteKernelsRequest(edit(request, ['reports', 0, 'removed', 0, 'path'], 'out.csv')), /removed file/)
  refused(() => parseRemoteKernelsRequest(edit(request, ['reports', 0, 'skipped', 0, 'path'], 'old.csv')), /skipped file/)
  refused(() => parseRemoteKernelsRequest(edit(request, ['reports', 0, 'changed', 1, 'path'], 'out.csv')), /changed file/)
  refused(() => parseRemoteKernelsRequest(edit(request, ['reports', 1, 'late', 1], 'out.csv')), /late change/)
  for (const [at, value] of [
    [['reports', 0, 'changed', 0, 'sha256'], 'abc'], [['reports', 0, 'changed', 0, 'bytes'], -1], [['reports', 0, 'changed', 0, 'base'], 'folder'],
    [['reports', 0, 'changed', 0, 'base'], undefined], [['reports', 0, 'removed', 0, 'base'], null], [['reports', 0, 'skipped', 0, 'why'], 'big'],
    [['reports', 0, 'skipped', 0, 'bytes'], undefined], [['reports', 0, 'seq'], 0], [['reports', 0, 'full'], 'yes'], [['reports', 0, 'sessionId'], 'a:b'],
  ] as const) refused(() => parseRemoteKernelsRequest(edit(request, at, value)), /Invalid|Unexpected/)
})

test('inline content past its caps is refused: 64 KiB a file, 128 KiB a sync', () => {
  const file = (pathName: string, bytes: number) => ({ path: pathName, sha256: sha(1), bytes, base: null, inline: b64(bytes) })
  assert.doesNotThrow(() => parseRemoteKernelsRequest(edit(request, ['reports', 0, 'changed', 0], file('out.csv', CLASS_INLINE_BYTES))))
  refused(() => parseRemoteKernelsRequest(edit(request, ['reports', 0, 'changed', 0], file('out.csv', CLASS_INLINE_BYTES + 1))), /inline/)
  // The content is what it says it is, to the byte: home checks its hash after it decodes it.
  refused(() => parseRemoteKernelsRequest(edit(request, ['reports', 0, 'changed', 0, 'inline'], b64(4))), /inline/)
  refused(() => parseRemoteKernelsRequest(edit(request, ['reports', 0, 'changed', 0, 'inline'], 'not base64!')), /inline/)
  // All the reports of one sync together: two full files fit, a byte more does not, wherever it is.
  const twoReports = (extra: number) => ({
    ...request,
    reports: [
      { sessionId: SESSION, gen: 3, seq: 1, changed: [file('a.csv', CLASS_INLINE_BYTES)], removed: [], skipped: [] },
      { sessionId: OTHER, gen: 5, seq: 1, changed: [file('b.csv', CLASS_INLINE_BYTES), ...(extra > 0 ? [file('c.csv', extra)] : [])], removed: [], skipped: [] },
    ],
  })
  assert.equal(CLASS_INLINE_REPORT_BYTES, 2 * CLASS_INLINE_BYTES)
  assert.doesNotThrow(() => parseRemoteKernelsRequest(twoReports(0)))
  refused(() => parseRemoteKernelsRequest(twoReports(1)), /Inline files over their budget/)
})

test('the machine\'s block keeps to its counts: paths, late changes, epochs, readings', () => {
  const changed = (count: number, from = 0) => Array.from({ length: count }, (_, i) => ({ path: `f${from + i}.csv`, sha256: sha(1), bytes: 1, base: null }))
  const split = (a: number, b: number) => ({
    ...request,
    reports: [
      { sessionId: SESSION, gen: 3, seq: 1, changed: changed(a), removed: [], skipped: [] },
      { sessionId: OTHER, gen: 5, seq: 1, changed: changed(b, a), removed: [], skipped: [] },
    ],
  })
  assert.doesNotThrow(() => parseRemoteKernelsRequest(split(REMOTE_REPORT_PATHS_MAX / 2, REMOTE_REPORT_PATHS_MAX / 2)))
  refused(() => parseRemoteKernelsRequest(split(REMOTE_REPORT_PATHS_MAX / 2, REMOTE_REPORT_PATHS_MAX / 2 + 1)), /Files reports over their budget/)
  // Late changes and released paths count among the paths, and a report names fifty late changes at most.
  refused(() => parseRemoteKernelsRequest(edit(split(REMOTE_REPORT_PATHS_MAX / 2, REMOTE_REPORT_PATHS_MAX / 2), ['reports', 1, 'late'], ['late.csv'])), /budget/)
  refused(() => parseRemoteKernelsRequest(edit(split(REMOTE_REPORT_PATHS_MAX / 2, REMOTE_REPORT_PATHS_MAX / 2), ['reports', 1, 'released'], ['gone.csv'])), /budget/)
  refused(() => parseRemoteKernelsRequest(edit(request, ['reports', 1, 'late'], Array.from({ length: CLASS_LATE_MAX + 1 }, (_, i) => `l${i}.csv`))), /late changes/)
  refused(() => parseRemoteKernelsRequest(edit(request, ['epochs'], Array.from({ length: REMOTE_EPOCHS_MAX + 1 }, (_, i) => ({ sessionId: SESSION, root: 'cells', seq: i + 1, ready: true })))), /epochs/)
  // The hashes still missing, over all the epochs of one sync.
  const missing = (from: number, count: number) => Array.from({ length: count }, (_, i) => sha(from + i))
  const halves = (extra: number) => edit(edit(request, ['epochs', 0], { sessionId: SESSION, root: 'cells', seq: 4, ready: false, missing: missing(0, COUNCIL_EPOCH_BUFFERS_MAX / 2 + extra) }),
    ['epochs', 1, 'missing'], missing(1_000_000, COUNCIL_EPOCH_BUFFERS_MAX / 2))
  assert.doesNotThrow(() => parseRemoteKernelsRequest(halves(0)))
  refused(() => parseRemoteKernelsRequest(halves(1)), /budget/)
  refused(() => parseRemoteKernelsRequest(edit(request, ['epochs', 0, 'missing'], [sha(1)])), /ready epoch/)
  refused(() => parseRemoteKernelsRequest(edit(request, ['epochs', 1, 'missing'], [sha(1), sha(1)])), /missing/)
  refused(() => parseRemoteKernelsRequest(edit(request, ['epochs', 1, 'root'], 'nb/../cells')), /epoch/)
  refused(() => parseRemoteKernelsRequest(edit(request, ['epochs', 1], { ...request.epochs[0] })), /epoch/)
  // Readings: a few, and short, for the sentence home says of them.
  refused(() => parseRemoteKernelsRequest(edit(request, ['readings'], Array.from({ length: REMOTE_READINGS_MAX + 1 }, (_, i) => ({ ...request.readings[0], gen: i + 1 })))), /readings/)
  refused(() => parseRemoteKernelsRequest(edit(request, ['readings', 0, 'reading', 'tail'], Array.from({ length: REMOTE_READING_LINES_MAX + 1 }, () => 'x'))), /log tail/)
  refused(() => parseRemoteKernelsRequest(edit(request, ['readings', 0, 'reading', 'tail', 0], 'x'.repeat(REMOTE_READING_LINE_CHARS + 1))), /log tail/)
  for (const [at, value] of [
    [['reading', 'limit'], -1], [['reading', 'peak'], 1.5], [['reading', 'kills'], '1'], [['reading', 'exit'], 256], [['reading', 'status'], 'Running'],
    [['reading', 'status'], 'x'.repeat(17)], [['reading', 'containerOomKilled'], null], [['reading', 'tail'], 'Killed'], [['key'], 'seminar_2'],
  ] as const) refused(() => parseRemoteKernelsRequest(edit(request, ['readings', 0, ...at], value)), /Invalid|Unexpected/)
})

test('a full report comes in pages, each saying where it is in its walk, and only a full report has them', () => {
  // A page belongs to a full report, and a full report to its pages: without one, home cannot tell a walk's first page from all of it.
  refused(() => parseRemoteKernelsRequest(edit(request, ['reports', 1, 'page'], undefined)), /page/)
  refused(() => parseRemoteKernelsRequest(edit(request, ['reports', 0, 'page'], { index: 0, last: true })), /page/)
  refused(() => parseRemoteKernelsRequest(edit(edit(request, ['reports', 1, 'full'], false), ['reports', 1, 'page'], { index: 0, last: true })), /page/)
  for (const page of [{ index: -1, last: true }, { index: 1.5, last: false }, { index: '0', last: true }, { index: 0, last: 'yes' }, { index: 0 }, { last: true }, null, 0]) {
    refused(() => parseRemoteKernelsRequest(edit(request, ['reports', 1, 'page'], page)), /page/)
  }
  // The largest walk a class folder has, one sync's whole budget a page, in order, the last one saying so.
  const walkPage = (index: number, last: boolean) => ({
    sessionId: OTHER, gen: 5, seq: 100 + index, full: true, page: { index, last }, removed: [], skipped: [],
    changed: Array.from({ length: REMOTE_REPORT_PATHS_MAX }, (_, i) => ({ path: `walk/${index * REMOTE_REPORT_PATHS_MAX + i}.csv`, sha256: sha(1), bytes: 1, base: sha(1) })),
  })
  const pages = CLASS_SYNC_FILES_MAX / REMOTE_REPORT_PATHS_MAX
  assert.ok(Number.isInteger(pages) && pages > 1)
  for (let index = 0; index < pages; index++) {
    const last = index === pages - 1
    assert.deepEqual(parseRemoteKernelsRequest({ ...request, reports: [walkPage(index, last)] }).reports[0]!.page, { index, last })
  }
  // In one report the walk is past what one sync carries: the reason it pages at all.
  refused(() => parseRemoteKernelsRequest({ ...request, reports: [{ ...walkPage(0, true), changed: [...walkPage(0, true).changed, ...walkPage(1, true).changed] }] }), /changed files/)
})

/* ---------------------------------------------- home's block, on the agent */

test('the agent keeps home\'s block as it is sent', () => {
  assert.deepEqual(parseRemoteKernelsReply(reply), reply)
  // The reply's number, which the agent's next block says back (`heard`): kept as it is, refused when it is no number.
  assert.deepEqual(parseRemoteKernelsReply({ ...reply, replySeq: 1_792_000_000_124 }), { ...reply, replySeq: 1_792_000_000_124 })
  for (const replySeq of [0, -1, 1.5, '7', null]) refused(() => parseRemoteKernelsReply({ ...reply, replySeq }), /kernels block/)
  const quiet = { ...reply, placements: [], pushes: [], verdicts: [], pulls: [], scan: [], epochs: [], collect: [], postmortem: [], tunnel: 'closed' }
  assert.deepEqual(parseRemoteKernelsReply(quiet), quiet)
  assert.doesNotThrow(() => parseRemoteKernelsReply({ ...reply, tunnel: 'reconnect' }))
})

test('the agent drops every key it does not know, at every depth, and keeps none of it', () => {
  const newer = structuredClone(reply) as unknown as Record<string, any>
  Object.assign(newer, { notice: 'maintenance', placementsV2: [] })
  Object.assign(newer.placements[0], { note: 'x', entrant: 'Иванов' })
  Object.assign(newer.placements[0].revision, { gpu: true })
  Object.assign(newer.pushes[0], { priority: 1 })
  Object.assign(newer.pushes[0].put[0], { mode: 0o644 })
  Object.assign(newer.pushes[0].put[2], { mode: 0o755 })
  Object.assign(newer.pushes[0].move[0], { why: 'rename' })
  Object.assign(newer.verdicts[0], { at: 1 })
  Object.assign(newer.verdicts[0].refused[1], { note: 'conflict' })
  Object.assign(newer.pulls[0], { promoted: true })
  Object.assign(newer.pulls[0].paths[0], { bytes: 1 })
  Object.assign(newer.scan[0], { quiet: false })
  Object.assign(newer.epochs[0], { createdAt: 1 })
  Object.assign(newer.epochs[0].manifest, { name: 'manifest.json' })
  Object.assign(newer.epochs[0].buffers[0], { kind: 'ndarray' })
  Object.assign(newer.epochs[1].from, { user: 'root' })
  Object.assign(newer.collect[0], { author: 'Иванов' })
  Object.assign(newer.collect[0].files[0], { path: '/colloq/scratch/x' })
  Object.assign(newer.rates, { competitionMBps: 2 })
  // JSON.parse makes `__proto__` an own key like any other: it is no key of the contract's either.
  const text = JSON.stringify(newer).replace(/^\{/, '{"__proto__":{"polluted":true},')
  const read = parseRemoteKernelsReply(JSON.parse(text))
  assert.deepEqual(read, reply, 'what the parser returns is the contract\'s block, exactly')
  assert.equal(JSON.stringify(read).includes('Иванов'), false, 'no name reaches what the agent keeps')
  assert.equal(JSON.stringify(read).includes('"user"'), false)
  assert.equal(({} as Record<string, unknown>).polluted, undefined)
  // Whatever it drops, it still checks what it knows.
  refused(() => parseRemoteKernelsReply({ ...newer, tunnel: 'maybe' }), /kernels block/)
  refused(() => parseRemoteKernelsReply(edit(newer, ['placements', 0, 'cpus'], 65)), /placement intent/)
  for (const bad of [null, [], 'kernels']) refused(() => parseRemoteKernelsReply(bad))
})

test('an intent is a whole placement, and says nothing a slot of its role cannot have', () => {
  // A whole card goes to a class's own container; a pool has a size, and nothing else has one.
  for (const slot of [1, 2]) refused(() => parseRemoteKernelsReply(edit(reply, ['placements', slot, 'gpu'], true)), /card/)
  refused(() => parseRemoteKernelsReply(edit(reply, ['placements', 0, 'workers'], 4)), /pool size/)
  refused(() => parseRemoteKernelsReply(edit(reply, ['placements', 2, 'workers'], undefined)), /pool size/)
  for (const workers of [0, COUNCIL_WORKERS.max + 1, 2.5]) refused(() => parseRemoteKernelsReply(edit(reply, ['placements', 2, 'workers'], workers)), /pool size/)
  assert.doesNotThrow(() => parseRemoteKernelsReply(edit(reply, ['placements', 2, 'workers'], COUNCIL_WORKERS.max)))
  for (const [at, value] of [
    [['key'], 'seminar_1:lecture'], [['environment'], 'Base GPU'], [['environment'], undefined], [['memoryMb'], 63], [['memoryMb'], 262_145],
    [['cpus'], 0], [['cpus'], 65], [['cpus'], 1.5], [['pids'], 63], [['pids'], 32_769], [['gpu'], 'true'],
    // Home's network mode is the floor: an open room never leaves home (D21).
    [['network'], 'open'], [['network'], undefined],
    [['blockedCidrs'], ['10.0.0.0/8 ']], [['blockedCidrs'], ['2001:db8::/32']], [['blockedCidrs'], ['203.0.113.0/33']], [['blockedCidrs'], ['203.0.113.0/24', '203.0.113.0/24']],
    [['blockedCidrs'], Array.from({ length: 65 }, (_, i) => `10.0.${i}.0/24`)],
    [['token'], 'e'.repeat(39)], [['token'], 'E'.repeat(40)], [['hashSeed'], 0], [['hashSeed'], 4_294_967_296], [['hashSeed'], -1],
    [['revision', 'ref'], 'ghcr.io/colloq-edu/colloq-kernel:v0.24.0-base'], [['revision', 'layers'], `sha256:${'4'.repeat(64)}`], [['revision'], undefined],
  ] as const) refused(() => parseRemoteKernelsReply(edit(reply, ['placements', 0, ...at], value)), /Invalid|Unexpected/)
  assert.doesNotThrow(() => parseRemoteKernelsReply(edit(reply, ['placements', 0, 'hashSeed'], 4_294_967_295)))
  refused(() => parseRemoteKernelsReply({ ...reply, placements: Array.from({ length: REMOTE_PLACEMENTS_MAX + 1 }, (_, i) => ({ ...intent, key: `s${i}:room` })) }))
})

test('an intent carries the shared memory home\'s own GPU rooms run with, in a size docker reads', () => {
  // What KERNEL_SHM may say at home (pool.ts · roomShm, docker's go-units), and room-spec.ts · ROOM_SHM.
  for (const shm of ['1g', '4g', '512m', '512M', '2gb', '512MiB', '1.5g', '0.5g', '1 g', '1073741824', '64k']) {
    assert.ok(REMOTE_SHM.test(shm), shm)
    assert.equal(parseRemoteKernelsReply(edit(reply, ['placements', 0, 'shm'], shm)).placements[0]!.shm, shm)
  }
  // Nothing at all is docker's 64 MB, the "bus error" the flag is there to prevent; a word, a sign or a shell is no size.
  for (const shm of [undefined, '', '0', '0g', '0.0g', '-1g', 'big', '1g;rm', '1g ', ' 1g', '1x', '1.2.3g', 'g', '1gbb', '1'.repeat(13), 1024, null]) {
    refused(() => parseRemoteKernelsReply(edit(reply, ['placements', 0, 'shm'], shm)), /placement intent/)
  }
  // Every slot carries it, the ones without a card too: the argv is home's flag for flag whatever the role.
  for (const slot of [1, 2]) refused(() => parseRemoteKernelsReply(edit(reply, ['placements', slot, 'shm'], undefined)), /placement intent/)
})

test('a push applies in its order without contradicting itself, within its caps', () => {
  const push = (at: readonly (string | number)[], value: unknown) => edit(reply, ['pushes', 0, ...at], value)
  // A folder is its path alone.
  for (const folder of [{ path: 'data', dir: true, sha256: sha(1) }, { path: 'data', dir: true, bytes: 0 }, { path: 'data', dir: false }, { path: 'data', dir: 1 }]) {
    refused(() => parseRemoteKernelsReply(push(['put', 2], folder)), /pushed folder/)
  }
  // A path is put once, removed once, moved once to one place, and never into itself.
  refused(() => parseRemoteKernelsReply(push(['put', 1, 'path'], 'train.csv')), /pushed file/)
  refused(() => parseRemoteKernelsReply(push(['remove', 1], 'old.csv')), /removed paths/)
  for (const move of [{ from: 'a', to: 'a/b' }, { from: 'a/b', to: 'a' }, { from: 'a', to: 'a' }, { from: 'b.csv', to: 'archive/a.csv' }]) {
    refused(() => parseRemoteKernelsReply(push(['move'], [...reply.pushes[0]!.move, move])), /move/)
  }
  refused(() => parseRemoteKernelsReply(push(['move', 1], { from: 'a.csv', to: 'b.csv' })), /move/)
  // One push per class in one reply.
  refused(() => parseRemoteKernelsReply(edit(reply, ['pushes', 1, 'sessionId'], SESSION)), /files push/)
  for (const [at, value] of [
    [['seq'], 0], [['full'], undefined], [['promoted'], 'yes'], [['put', 0, 'sha256'], undefined], [['put', 0, 'bytes'], -1],
    [['put', 1, 'inline'], b64(13)], [['put'], undefined], [['remove'], [7]], [['move', 0, 'to'], undefined],
  ] as const) refused(() => parseRemoteKernelsReply(push(at, value)), /Invalid|Unexpected/)
  // Inline: 64 KiB a file, 1 MiB all the pushes of one reply together.
  const inline = (index: number, bytes: number) => ({ path: `i${index}.bin`, sha256: sha(index), bytes, inline: b64(bytes) })
  refused(() => parseRemoteKernelsReply(push(['put', 1], inline(1, CLASS_INLINE_BYTES + 1))), /inline/)
  const many = (count: number, last: number) => edit(reply, ['pushes', 1, 'put'], [...Array.from({ length: count }, (_, i) => inline(i, CLASS_INLINE_BYTES)), ...(last ? [inline(count, last)] : [])])
  const room = CLASS_INLINE_PUSH_BYTES - 12
  assert.doesNotThrow(() => parseRemoteKernelsReply(many(Math.floor(room / CLASS_INLINE_BYTES), room % CLASS_INLINE_BYTES)))
  refused(() => parseRemoteKernelsReply(many(Math.floor(room / CLASS_INLINE_BYTES), (room % CLASS_INLINE_BYTES) + 1)), /Inline files over their budget/)
  // The paths of one reply's pushes, a move counting two: the largest folder in one full push.
  const files = (count: number) => Array.from({ length: count }, (_, i) => ({ path: `p/${i}.csv`, sha256: sha(1), bytes: 1 }))
  const used = reply.pushes[0]!.put.length + reply.pushes[0]!.remove.length + 2 * reply.pushes[0]!.move.length
  assert.doesNotThrow(() => parseRemoteKernelsReply(edit(reply, ['pushes', 1, 'put'], files(REMOTE_PUSH_PATHS_MAX - used))))
  refused(() => parseRemoteKernelsReply(edit(reply, ['pushes', 1, 'put'], files(REMOTE_PUSH_PATHS_MAX - used + 1))), /Files pushes over their budget/)
  refused(() => parseRemoteKernelsReply(edit(edit(reply, ['pushes', 1, 'put'], files(REMOTE_PUSH_PATHS_MAX - used - 1)), ['pushes', 1, 'move'], [{ from: 'm.csv', to: 'n.csv' }])), /budget/)
})

test('a path in home\'s block is a canonical path inside the class folder, or the block is refused', () => {
  for (const bad of BAD_PATHS) {
    for (const at of [
      ['pushes', 0, 'put', 0, 'path'], ['pushes', 0, 'put', 2, 'path'], ['pushes', 0, 'remove', 0], ['pushes', 0, 'move', 0, 'from'], ['pushes', 0, 'move', 0, 'to'],
      ['verdicts', 0, 'accepted', 0], ['verdicts', 0, 'refused', 0, 'path'], ['verdicts', 0, 'refused', 1, 'copy'], ['pulls', 0, 'paths', 0, 'path'],
      ['collect', 0, 'files', 1, 'name'],
    ] as const) refused(() => parseRemoteKernelsReply(edit(reply, at, bad)), /Invalid/)
  }
  for (const good of GOOD_PATHS) assert.doesNotThrow(() => parseRemoteKernelsReply(edit(reply, ['pulls', 0, 'paths', 0, 'path'], good)), good)
})

test('verdicts, pulls, scans and collections: each path one fate, each within its count', () => {
  // A path is accepted or refused; a copy is kept only where home's version won over the machine's.
  refused(() => parseRemoteKernelsReply(edit(reply, ['verdicts', 0, 'refused', 0, 'path'], 'out.csv')), /refused path/)
  refused(() => parseRemoteKernelsReply(edit(reply, ['verdicts', 0, 'refused', 0, 'copy'], 'Тетрадь (с машины 14-32).ipynb')), /refused path/)
  refused(() => parseRemoteKernelsReply(edit(reply, ['verdicts', 0, 'refused', 0, 'why'], 'size')), /refused path/)
  refused(() => parseRemoteKernelsReply(edit(reply, ['verdicts', 1], reply.verdicts[0])), /verdict/)
  const accepted = (count: number) => edit(reply, ['verdicts', 0, 'accepted'], Array.from({ length: count }, (_, i) => `a${i}.csv`))
  assert.doesNotThrow(() => parseRemoteKernelsReply(accepted(REMOTE_REPORT_PATHS_MAX - 3)))
  refused(() => parseRemoteKernelsReply(accepted(REMOTE_REPORT_PATHS_MAX - 2)), /Verdicts over their budget/)
  const pulled = (count: number) => edit(reply, ['pulls', 0, 'paths'], Array.from({ length: count }, (_, i) => ({ path: `p${i}.csv`, sha256: sha(i) })))
  assert.doesNotThrow(() => parseRemoteKernelsReply(pulled(REMOTE_REPORT_PATHS_MAX)))
  refused(() => parseRemoteKernelsReply(pulled(REMOTE_REPORT_PATHS_MAX + 1)), /pulled paths/)
  refused(() => parseRemoteKernelsReply(edit(reply, ['pulls', 0, 'paths', 1], reply.pulls[0]!.paths[0])), /pulled path/)
  // «Привезти» names no hash; a hash it names is one.
  assert.deepEqual(parseRemoteKernelsReply(reply).pulls[0]!.paths[1], { path: 'model.pt' })
  refused(() => parseRemoteKernelsReply(edit(reply, ['pulls', 0, 'paths', 1, 'sha256'], 'abc')), /pulled path/)
  // The caps of a kernel's files on their way home: whole megabytes, within the settings' own bounds and the contract's; absent, the machine keeps to its defaults.
  for (const [at, value] of [[['caps', 'machineFileMb'], 0], [['caps', 'roomMb'], REMOTE_FILE_CAP_MB_MAX + 1], [['caps', 'roomMb'], 1.5], [['caps', 'machineFileMb'], undefined], [['caps'], 200]] as const) {
    refused(() => parseRemoteKernelsReply(edit(reply, at, value)), /file caps/)
  }
  assert.equal('caps' in parseRemoteKernelsReply(edit(reply, ['caps'], undefined)), false)
  assert.deepEqual(parseRemoteKernelsReply(edit(reply, ['caps', 'stray'], 1)).caps, reply.caps)
  refused(() => parseRemoteKernelsReply(edit(reply, ['scan', 1, 'sessionId'], SESSION)), /scan/)
  refused(() => parseRemoteKernelsReply(edit(reply, ['scan', 0, 'full'], 1)), /scan/)
  refused(() => parseRemoteKernelsReply(edit(reply, ['postmortem'], ['seminar_2:room', 'seminar_2:room'])), /post-mortem/)
  refused(() => parseRemoteKernelsReply(edit(reply, ['postmortem'], ['seminar_2'])), /post-mortem/)
  refused(() => parseRemoteKernelsReply(edit(reply, ['postmortem'], Array.from({ length: REMOTE_READINGS_MAX + 1 }, (_, i) => `s${i}:room`))), /post-mortem/)
  // An attempt's files on its card: twenty, a megabyte each, five in all.
  const artifact = (i: number, bytes: number) => ({ name: `f${i}.png`, sha256: sha(i), bytes })
  refused(() => parseRemoteKernelsReply(edit(reply, ['collect', 0, 'files'], Array.from({ length: COUNCIL_ARTIFACTS.files + 1 }, (_, i) => artifact(i, 1)))), /artifacts/)
  refused(() => parseRemoteKernelsReply(edit(reply, ['collect', 0, 'files', 0, 'bytes'], COUNCIL_ARTIFACTS.fileBytes + 1)), /artifact/)
  const fiveMiB = Array.from({ length: 5 }, (_, i) => artifact(i, COUNCIL_ARTIFACTS.fileBytes))
  assert.doesNotThrow(() => parseRemoteKernelsReply(edit(reply, ['collect', 0, 'files'], fiveMiB)))
  refused(() => parseRemoteKernelsReply(edit(reply, ['collect', 0, 'files'], [...fiveMiB, artifact(9, 1)])), /Artifacts over their cap/)
  refused(() => parseRemoteKernelsReply(edit(reply, ['collect', 0, 'files', 1, 'name'], 'out.csv')), /artifact/)
  refused(() => parseRemoteKernelsReply(edit(reply, ['collect', 0, 'runId'], '../r')), /collection/)
  for (const [at, value] of [[['rates', 'classBulkMBps'], 0], [['rates', 'machinePaceMBps'], 1001], [['rates'], undefined]] as const) {
    refused(() => parseRemoteKernelsReply(edit(reply, at, value)), /rates|Invalid/)
  }
})

test('epochs: content-addressed, within their caps, and read from no folder but their own', () => {
  const epoch = (at: readonly (string | number)[], value: unknown) => edit(reply, ['epochs', 0, ...at], value)
  // A file named twice, or by the manifest's own hash, is one file the epoch does not have twice.
  refused(() => parseRemoteKernelsReply(epoch(['buffers', 1, 'sha256'], sha(12))), /epoch file/)
  refused(() => parseRemoteKernelsReply(epoch(['buffers', 1, 'sha256'], sha(11))), /epoch file/)
  refused(() => parseRemoteKernelsReply(epoch(['buffers'], [{ sha256: sha(12), bytes: COUNCIL_EPOCH_MB * 1024 * 1024 }, { sha256: sha(13), bytes: 1 }])), /Epoch over its cap/)
  refused(() => parseRemoteKernelsReply(epoch(['buffers'], Array.from({ length: COUNCIL_EPOCH_BUFFERS_MAX + 1 }, (_, i) => ({ sha256: sha(100 + i), bytes: 1 })))), /epoch files/)
  refused(() => parseRemoteKernelsReply(epoch(['manifest', 'bytes'], 0)), /manifest/)
  refused(() => parseRemoteKernelsReply(epoch(['from'], 'machine')), /epoch source/)
  // docker cp reads the export's own folder, `<dir>/<seq>`, and nothing else on the machine.
  for (const dir of [`${COUNCIL_EPOCH_DIR}/3`, '/etc', `${COUNCIL_EPOCH_DIR}/2/../../etc`, `${COUNCIL_EPOCH_DIR}/2/`, '/var/lib/colloq-runner']) {
    refused(() => parseRemoteKernelsReply(edit(reply, ['epochs', 1, 'from', 'dir'], dir)), /epoch source/)
  }
  refused(() => parseRemoteKernelsReply(edit(reply, ['epochs', 1, 'from', 'container'], 'colloq-runner')), /epoch source/)
  refused(() => parseRemoteKernelsReply(edit(reply, ['epochs', 1, 'seq'], 4)), /epoch source/)
  refused(() => parseRemoteKernelsReply(edit(reply, ['epochs', 1], { ...reply.epochs[0] })), /epoch intent/)
  refused(() => parseRemoteKernelsReply(edit(reply, ['epochs'], Array.from({ length: REMOTE_EPOCHS_MAX + 1 }, (_, i) => ({ ...reply.epochs[0], seq: i + 1 })))), /epoch intents/)
})

test('a notebook\'s root is any root a room holds, the paths of August 2026 among them, both ways', () => {
  // A second notebook's root was its path for four days (f43e62f), and no room rewrites a root.
  const longest = `${'a'.repeat(MAX_SEGMENT)}/${'a'.repeat(MAX_SEGMENT)}/${'a'.repeat(MAX_SEGMENT)}/${'a'.repeat(MAX_PATH - 3 * (MAX_SEGMENT + 1))}`
  const legacy = [
    'nb:Тетрадь 2.ipynb', 'nb:week 1/разбор задачи.ipynb', 'nb:😀.ipynb', 'nb:a/b/c/d/e/f/g/h.ipynb', `nb:${longest}`,
    // A name of then that a path of today may not have (MAX_SEGMENT_BYTES came after): the root keeps the rules of then.
    `nb:${'界'.repeat(MAX_SEGMENT - '.ipynb'.length)}.ipynb`,
  ]
  assert.equal(longest.length, MAX_PATH)
  assert.equal(normalizePath(legacy[5]!.slice('nb:'.length)), null)
  // Today's, made by the code that makes them.
  const doc = new Y.Doc()
  ensureInitialNotebook(doc)
  addBook(doc, 'Второй.ipynb')
  addBook(doc, 'папка/третий.ipynb')
  const made = bookList(doc).map((book) => book.root)
  doc.destroy()
  assert.equal(made.length, 3)
  assert.equal(made[0], CELLS_KEY)
  for (const root of [...made, ...legacy]) {
    assert.ok(isBookRoot(root) && isRemoteRoot(root), root)
    assert.equal(parseRemoteKernelsRequest(edit(request, ['epochs', 1, 'root'], root)).epochs[1]!.root, root)
    assert.equal(parseRemoteKernelsReply(edit(reply, ['epochs', 1, 'root'], root)).epochs[1]!.root, root)
  }
  // What no room holds: another key of the document, no rest after the prefix, a control character, half a pair, past the longest path.
  for (const bad of ['', 'nb:', 'cell', 'Cells', 'meta', 'books', 'nb', 'NB:x', ' nb:x', 'nb:a\nb', 'nb:\u0000', 'nb:\u007f', 'nb:half\uD83D', `nb:${longest}a`, 7, null, undefined]) {
    assert.equal(isRemoteRoot(bad), false, JSON.stringify(bad))
    refused(() => parseRemoteKernelsRequest(edit(request, ['epochs', 1, 'root'], bad)), /epoch/)
    refused(() => parseRemoteKernelsReply(edit(reply, ['epochs', 1, 'root'], bad)), /epoch intent/)
  }
  assert.equal(REMOTE_ROOT_CHARS, 'nb:'.length + MAX_PATH)
})

test('epochs: home names those not ready yet, and a machine says all it holds, two for each council notebook', () => {
  // A machine of D31 classes holds their council slots and no room: sixty-four notebooks, each with its live epoch and the one being refreshed.
  const held = Array.from({ length: REMOTE_PLACEMENTS_MAX }, (_, i) => [1, 2].map((seq) => ({ sessionId: `s${i}`, root: 'cells', seq, ready: seq === 1 }))).flat()
  assert.equal(held.length, REMOTE_EPOCHS_MAX)
  assert.equal(parseRemoteKernelsRequest({ ...request, epochs: held }).epochs.length, REMOTE_EPOCHS_MAX)
  refused(() => parseRemoteKernelsRequest({ ...request, epochs: [...held, { sessionId: 's99', root: 'cells', seq: 1, ready: true }] }), /epochs/)
  // Home may name every one of them still to come in one reply, within the files a reply names.
  const pending = (i: number, files: number) => ({
    sessionId: `s${i}`, root: 'cells', seq: 2, manifest: { sha256: sha(1), bytes: 2048 }, from: 'home' as const,
    buffers: Array.from({ length: files }, (_, b) => ({ sha256: sha(2 + i * COUNCIL_EPOCH_BUFFERS_MAX + b), bytes: 1 })),
  })
  assert.equal(parseRemoteKernelsReply({ ...reply, epochs: Array.from({ length: REMOTE_EPOCHS_MAX }, (_, i) => pending(i, 1)) }).epochs.length, REMOTE_EPOCHS_MAX)
  // Two epochs at their largest fit one reply; a file more waits for the next.
  const largest = [pending(0, COUNCIL_EPOCH_BUFFERS_MAX), pending(1, COUNCIL_EPOCH_BUFFERS_MAX)]
  assert.doesNotThrow(() => parseRemoteKernelsReply({ ...reply, epochs: largest }))
  refused(() => parseRemoteKernelsReply({ ...reply, epochs: [...largest, pending(2, 1)] }), /Epoch files over their budget/)
})

test('council (0.26): an epoch not had says why in a word, an attempt\'s collection over is said by its ids, and nothing else of either', () => {
  const failed = edit(request, ['epochs', 1, 'failed'], 'files')
  assert.deepEqual(parseRemoteKernelsRequest(failed).epochs[1], { ...request.epochs[1], failed: 'files' })
  for (const why of ['source', 'files', 'disk']) assert.doesNotThrow(() => parseRemoteKernelsRequest(edit(request, ['epochs', 1, 'failed'], why)), why)
  // A ready epoch has no failure; a failure is one of the words, never the agent's text.
  refused(() => parseRemoteKernelsRequest(edit(request, ['epochs', 0, 'failed'], 'disk')), /epoch failure/)
  for (const bad of ['docker cp: no such file', '', null, 1]) refused(() => parseRemoteKernelsRequest(edit(request, ['epochs', 1, 'failed'], bad)), /epoch failure/)
  const collected = { ...request, collected: [{ sessionId: SESSION, runId: 'r_1792000000' }, { sessionId: OTHER, runId: 'r_1792000000' }] }
  assert.deepEqual(parseRemoteKernelsRequest(collected), collected)
  refused(() => parseRemoteKernelsRequest({ ...request, collected: [collected.collected[0], collected.collected[0]] }), /collected attempt/)
  refused(() => parseRemoteKernelsRequest(edit(collected, ['collected', 0, 'runId'], '../r')), /collected attempt/)
  refused(() => parseRemoteKernelsRequest(edit(collected, ['collected', 0, 'files'], [])), /Unexpected key/)
  const many = Array.from({ length: REMOTE_COLLECTED_MAX + 1 }, (_, i) => ({ sessionId: SESSION, runId: `r_${i}` }))
  assert.doesNotThrow(() => parseRemoteKernelsRequest({ ...request, collected: many.slice(0, REMOTE_COLLECTED_MAX) }))
  refused(() => parseRemoteKernelsRequest({ ...request, collected: many }), /collected attempts/)
  // A machine finishes as many collections between two syncs as home asked for in several replies.
  assert.ok(REMOTE_COLLECTED_MAX >= REMOTE_COLLECTS_MAX)
})

test('council (0.26): home asks an export read on its machine to come home, of its own files only, and never one the machine fetched from home', () => {
  const shipped = edit(reply, ['epochs', 1, 'ship'], [sha(14)])
  assert.deepEqual(parseRemoteKernelsReply(shipped).epochs[1]!.ship, [sha(14)])
  // Not one of the epoch's own files; the same twice; from home (nothing to send back).
  refused(() => parseRemoteKernelsReply(edit(reply, ['epochs', 1, 'ship'], [sha(99)])), /epoch files to send/)
  refused(() => parseRemoteKernelsReply(edit(reply, ['epochs', 1, 'ship'], [sha(14), sha(14)])), /epoch files to send/)
  refused(() => parseRemoteKernelsReply(edit(reply, ['epochs', 0, 'ship'], [sha(12)])), /epoch files to send/)
  // No `ship`, no key: an older reply's epochs read as they always did.
  assert.equal('ship' in parseRemoteKernelsReply(reply).epochs[1]!, false)
})

test('council (0.26): a worker finds an epoch\'s files and an attempt\'s folder by the contract\'s own paths', () => {
  assert.equal(COUNCIL_EPOCHS_MOUNT, '/colloq/epochs')
  assert.equal(COUNCIL_SCRATCH_MOUNT, '/colloq/scratch')
  assert.equal(COUNCIL_SCRATCH_ENTRIES, 2000)
  assert.equal(councilEpochPath(sha(7)), `/colloq/epochs/${sha(7)}`)
  assert.equal(councilScratchPath('r_1792000000'), '/colloq/scratch/r_1792000000')
  // Neither under the class folder's mount: the class folder is read-only to the pool, and the epoch dir is the notebook kernel's own.
  for (const mount of [COUNCIL_EPOCHS_MOUNT, COUNCIL_SCRATCH_MOUNT]) assert.ok(!mount.startsWith('/workspace') && !mount.startsWith(COUNCIL_EPOCH_DIR))
  for (const run of [() => councilEpochPath('../x'), () => councilEpochPath('A'.repeat(64)), () => councilScratchPath('r/1'), () => councilScratchPath('..'), () => councilScratchPath('')]) refused(run, /path part/)
})

/* ----------------------------------------------------------- keys and doors */

test('a key names one slot of one class, and the doors are built only from what their patterns take', () => {
  assert.equal(remotePlacementKey('seminar_1', 'council'), 'seminar_1:council')
  assert.deepEqual(parseRemotePlacementKey('seminar_1:own'), { sessionId: 'seminar_1', role: 'own' })
  for (const bad of ['seminar_1', 'seminar_1:lecture', ':room', 'a:b:room', '../x:room', `${'s'.repeat(65)}:room`, 7, null]) assert.equal(parseRemotePlacementKey(bad), null, String(bad))
  for (const [sessionId, role] of [['a:b', 'room'], ['../x', 'own'], ['seminar_1', 'lecture']] as const) refused(() => remotePlacementKey(sessionId, role as 'room'), /placement key/)
  // A class id is the broker's: the same pattern, one place.
  assert.equal(REMOTE_SESSION_ID, RUNTIME_SESSION_ID)
  assert.equal(remoteClassPaths.roomFile('seminar_1', 'данные/таблица 1.csv', 3), `rooms/seminar_1/files?path=${encodeURIComponent('данные/таблица 1.csv')}&gen=3`)
  assert.equal(remoteClassPaths.epoch(sha(1), 'seminar_1', 2), `epochs/${sha(1)}?session=seminar_1&gen=2`)
  assert.equal(remoteClassPaths.artifact('seminar_1', 'r_1', 'plots/fig.png', 2), 'council/seminar_1/runs/r_1/files/plots%2Ffig.png?gen=2')
  for (const run of [
    () => remoteClassPaths.roomFile('../seminar', 'a.csv', 1), () => remoteClassPaths.roomFile('seminar_1', '../a.csv', 1), () => remoteClassPaths.roomFile('seminar_1', 'a.csv', 0),
    () => remoteClassPaths.epoch('../x', 'seminar_1', 1), () => remoteClassPaths.epoch(sha(1), 'seminar_1', 1.5),
    () => remoteClassPaths.artifact('seminar_1', 'r/1', 'a.png', 1), () => remoteClassPaths.artifact('seminar_1', 'r_1', '.hidden', 1),
  ]) refused(run, /path part/)
})

/* ------------------------------------------------------------- the echoes */

test('checkRuntimeEndpoint takes an endpoint that echoes what was asked, and says which echo was wrong', () => {
  const answer = { url: 'http://127.0.0.1:41234', token: 'e'.repeat(40), instanceId: 'k7m2p9qa:container:3', environment: 'base', revision: DIGEST, gen: 3, extra: 'not read' }
  const endpoint = { url: answer.url, token: answer.token, instanceId: answer.instanceId, environment: 'base', revision: DIGEST }
  assert.deepEqual(checkRuntimeEndpoint(answer, { environment: 'base', revision: DIGEST, gen: 3 }), endpoint)
  // The broker asks for no gen, and whatever revision is current there.
  assert.deepEqual(checkRuntimeEndpoint({ ...answer, gen: undefined }, { environment: 'base' }), endpoint)
  const why = (value: unknown, asked: Parameters<typeof checkRuntimeEndpoint>[1]): RuntimeEndpointRefusal | null => {
    try {
      checkRuntimeEndpoint(value, asked)
      return null
    } catch (error) {
      assert.ok(error instanceof RuntimeEndpointError, String(error))
      return error.refusal
    }
  }
  const asked = { environment: 'base', revision: DIGEST, gen: 3 }
  for (const value of [
    null, [], 'endpoint', { ...answer, url: 7 }, { ...answer, token: 'short' }, { ...answer, token: `${'e'.repeat(20)}\r\nX-Injected: 1` },
    { ...answer, instanceId: '' }, { ...answer, environment: 'base-gpu' }, { ...answer, revision: 'd'.repeat(32) }, { ...answer, revision: undefined },
  ]) assert.equal(why(value, asked), 'endpoint', JSON.stringify(value))
  // The order a client reads them in: the endpoint, then a stale gen, then a substituted image, then the address.
  assert.equal(why({ ...answer, gen: 2 }, asked), 'gen')
  assert.equal(why({ ...answer, gen: undefined }, asked), 'gen')
  assert.equal(why({ ...answer, gen: '3' }, asked), 'gen')
  assert.equal(why({ ...answer, gen: 2, revision: `sha256:${'b'.repeat(64)}` }, asked), 'gen')
  assert.equal(why({ ...answer, revision: `sha256:${'b'.repeat(64)}`, url: 'nonsense' }, asked), 'revision')
  for (const url of ['nonsense', 'ftp://127.0.0.1:1', 'http://u:p@127.0.0.1:1', 'http://127.0.0.1:1/api', 'http://127.0.0.1:1/?token=x', 'http://127.0.0.1:1/#x']) {
    assert.equal(why({ ...answer, url }, asked), 'url', url)
  }
  assert.equal(why({ ...answer, url: 'https://colloq-kernel.svc:8888/' }, asked), null)
})

test('RuntimeClient.ensure says what it always said for each echo, now from the shared check', async () => {
  setLocaleResolver(() => 'en')
  let answer: unknown = null
  const server = http.createServer((_req, res) => {
    res.setHeader('content-type', 'application/json')
    res.end(JSON.stringify(answer))
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as { port: number }
  try {
    const client = new RuntimeClient({ url: `http://127.0.0.1:${port}`, token: 'a'.repeat(64) })
    const endpoint = { url: 'http://colloq-kernel-demo.colloq.svc:8888', token: 'r'.repeat(64), instanceId: 'pod-one', environment: 'base', revision: DIGEST }
    answer = { ...endpoint, gen: 99 }
    assert.deepEqual(await client.ensure('seminar_1', 'base', DIGEST), endpoint, 'a gen in the broker\'s answer is no echo it was asked for')
    for (const [value, key] of [
      [{ ...endpoint, instanceId: '' }, 'server.invalidKernelRuntimeEndpointOrInstanceIdentity.a63d8b'],
      [{ ...endpoint, environment: 'other' }, 'server.invalidKernelRuntimeEndpointOrInstanceIdentity.a63d8b'],
      [{ ...endpoint, revision: `sha256:${'b'.repeat(64)}` }, 'server.kernelRuntimeReturnedADifferentEnvironmentRevision.8f728c'],
      [{ ...endpoint, url: 'http://colloq-kernel-demo.colloq.svc:8888/api' }, 'server.invalidJupyterEndpointUrl.edef18'],
      [{ ...endpoint, url: 'not a url' }, 'server.invalidJupyterEndpointUrl.edef18'],
    ] as const) {
      answer = value
      await assert.rejects(client.ensure('seminar_1', 'base', DIGEST), (error: Error) => error.name === 'RuntimeRequestError' && error.message === translate('en', key), key)
    }
    // No revision asked: any digest is taken, as before.
    answer = { ...endpoint, revision: `sha256:${'b'.repeat(64)}` }
    assert.equal((await client.ensure('seminar_1', 'base')).revision, `sha256:${'b'.repeat(64)}`)
  } finally {
    server.closeAllConnections()
    await new Promise<void>((resolve) => server.close(() => resolve()))
    setLocaleResolver(() => 'ru')
  }
})

test('a ready placement echoes the digest its image is pinned by, and home asks for that same digest', () => {
  assert.equal(remoteRevisionDigest(REF), `sha256:${'3'.repeat(64)}`)
  // The longest pin there is, and the strings that are no pin: a tag, a bare digest, a line break, past the length.
  const longest = `${'r'.repeat(262)}.io/${'p'.repeat(262)}@sha256:${'3'.repeat(64)}`
  assert.equal(longest.length, REMOTE_REF_CHARS)
  assert.equal(remoteRevisionDigest(longest), `sha256:${'3'.repeat(64)}`)
  for (const bad of ['ghcr.io/colloq-edu/colloq-kernel:v0.24.0-base', `sha256:${'3'.repeat(64)}`, `${REF}\n`, `x${longest}`, 7, null]) {
    refused(() => remoteRevisionDigest(bad as string), /image ref/)
  }
  // The agent echoes the ref of its record, home asks for its intent's: the same pin passes the check placement makes.
  const answer = { url: 'http://127.0.0.1:40001', token: intent.token, instanceId: CONTAINER, environment: intent.environment, gen: intent.gen }
  const asked = { environment: intent.environment, revision: remoteRevisionDigest(intent.revision.ref), gen: intent.gen }
  const echo = remoteRevisionDigest(REF)
  assert.ok(parseRemoteKernelsRequest(edit(request, ['placements', 0, 'revision'], echo)))
  assert.equal(checkRuntimeEndpoint({ ...answer, revision: echo }, asked).revision, echo)
  // Docker's image id is the config's digest under the classic store, never the manifest's: an echo of it is another image.
  assert.throws(() => checkRuntimeEndpoint({ ...answer, revision: `sha256:${'9'.repeat(64)}` }, asked), (error: unknown) => error instanceof RuntimeEndpointError && error.refusal === 'revision')
})

/* ------------------------------------------------------ either import first */

const ROOT = path.resolve(import.meta.dirname, '..')
const SERVER = path.join(ROOT, 'server')

/** A probe that loads `first` before anything else and then parses with all three modules. */
const probe = (first: string, from: (name: string) => string): string => [
  `import * as first from '${from(first)}'`,
  `import { parseRemoteSyncRequest, parseRemoteSyncReply } from '${from('remote-runner')}'`,
  `import { parseRemoteKernelsRequest, REMOTE_PLACEMENT_KEY } from '${from('remote-kernels')}'`,
  `import { decodeTunnelFrame, encodeTunnelFrame } from '${from('remote-tunnel')}'`,
  'const kernels = { placements: [], reports: [], epochs: [], readings: [], tunnel: "up", classes: { hostNetwork: true, perimeter: "ok", mode: "blocked", canary: "ok", sameDaemon: false } }',
  'const sync = { protocol: 1, build: "dev", seq: 0, holdMs: 0, state: "active", free: { slots: 0, memoryMb: 0, cpus: 0, gpuShares: 0, diskMb: 0 }, cards: [], ready: { revisions: [], data: [], sealed: [], bundles: [] }, fetching: [], attempts: [], problems: [], kernels }',
  'const frame = decodeTunnelFrame(encodeTunnelFrame({ kind: "OPEN", stream: 1, lane: 1, open: { key: "s:room", gen: 1 } }), "home")',
  'process.stdout.write(JSON.stringify({ loaded: Object.keys(first).length > 0, sync: parseRemoteSyncRequest(sync).kernels.tunnel, kernels: parseRemoteKernelsRequest(kernels).tunnel, key: REMOTE_PLACEMENT_KEY.test("s:own"), frame: frame.kind, reply: typeof parseRemoteSyncReply }))',
].join('\n')
const EXPECTED = { loaded: true, sync: 'up', kernels: 'up', key: true, frame: 'OPEN' as const, reply: 'function' }

test('the two contract modules, and the tunnel\'s, load in either order under tsx', () => {
  for (const first of ['remote-runner', 'remote-kernels', 'remote-tunnel']) {
    const ran = spawnSync(process.execPath, ['--import', import.meta.resolve('tsx'), '--input-type=module', '-e', probe(first, (name) => new URL(`../shared/${name}.ts`, import.meta.url).href)], {
      encoding: 'utf8', timeout: 60_000, env: { ...process.env, TSX_TSCONFIG_PATH: path.join(ROOT, 'tsconfig.json') },
    })
    assert.equal(ran.status, 0, `${first} first: ${ran.stderr}`)
    assert.deepEqual(JSON.parse(ran.stdout), EXPECTED, first)
  }
})

test('and in either order bundled as the agent\'s build bundles them', async () => {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'colloq-kernels-order-'))
  try {
    for (const first of ['remote-runner', 'remote-kernels', 'remote-tunnel']) {
      const result = await build({
        ...RUNNER_OPTIONS,
        stdin: { contents: probe(first, (name) => `@shared/${name}`), resolveDir: path.join(SERVER, 'src'), sourcefile: 'order-probe.ts', loader: 'ts' },
        absWorkingDir: SERVER,
        outfile: path.join(scratch, `${first}.mjs`),
        write: false,
        logLevel: 'silent',
        plugins: [withoutTranslations()],
      })
      const file = path.join(scratch, `${first}.mjs`)
      fs.writeFileSync(file, result.outputFiles[0]!.text)
      const ran = spawnSync(process.execPath, [file], { encoding: 'utf8', timeout: 30_000 })
      assert.equal(ran.status, 0, `${first} first, bundled: ${ran.stderr}`)
      assert.deepEqual(JSON.parse(ran.stdout), EXPECTED, first)
    }
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true })
  }
})

/* ----------------------------------------------------------- the types */

test('a pushed folder that carries a file\'s keys does not compile, as the agent would not take it', () => {
  // §15's one shape put `dir?: true` beside a hash and a size; pushesOf refuses that folder, and the whole reply with it.
  const lines = [
    `import type { RemoteFilesPut, RemoteFilesPush } from './remote-kernels.js'`,
    `const sha = '${sha(1)}'`,
    `export const file: RemoteFilesPut = { path: 'a.csv', sha256: sha, bytes: 1, inline: 'AA==' }`,
    `export const folder: RemoteFilesPut = { path: 'data', dir: true }`,
    `export const shaped: RemoteFilesPut = { path: 'data', sha256: sha, bytes: 0, dir: true }`,
    `export const inlined: RemoteFilesPut = { path: 'data', dir: true, inline: '' }`,
    `export const pushed: RemoteFilesPush = { sessionId: 's', seq: 1, full: false, put: [{ path: 'data', sha256: sha, bytes: 0, dir: true }], remove: [], move: [] }`,
  ]
  const probe = path.join(ROOT, 'shared', 'remote-kernels.probe.ts')
  const source = lines.join('\n')
  const options: ts.CompilerOptions = {
    target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext, moduleResolution: ts.ModuleResolutionKind.Bundler,
    strict: true, noEmit: true, skipLibCheck: true, types: [], lib: ['lib.es2023.d.ts'],
  }
  // The probe lives in memory beside the module it imports, and is the only file whose errors are read.
  const host = ts.createCompilerHost(options)
  const { fileExists, getSourceFile } = host
  host.fileExists = (file) => file === probe || fileExists.call(host, file)
  host.getSourceFile = (file, language, ...rest) => (file === probe ? ts.createSourceFile(file, source, language) : getSourceFile.call(host, file, language, ...rest))
  const program = ts.createProgram([probe], options, host)
  const file = program.getSourceFile(probe)!
  const failing = new Set(program.getSemanticDiagnostics(file).map((diagnostic) => file.getLineAndCharacterOfPosition(diagnostic.start!).line + 1))
  assert.deepEqual([...failing].sort(), [5, 6, 7], [...failing].map((line) => lines[line - 1]).join('\n'))
})

/* --------------------------------------------------------------- the words */

/*
 * docs/architecture/remote-classes.md §13.2 is the locale source: these are
 * its rows the server writes, as the table spells them with its own example
 * values (vast-3, 14:32:05, 2,1 ГБ …). A row whose sentence drifts from the
 * table fails here, in Russian, word for word.
 */
const MACHINE = 'vast-3'
const WORDS: ReadonlyArray<readonly [key: string, params: Record<string, string | number>, ru: string]> = [
  ['server.noConnectionToMachineTheKernelAnd.df78c8', { machine: MACHINE, elapsed: '0:12' }, 'Нет связи с машиной «vast-3» · 0:12. Ядро и переменные на ней целы — ждём связь. Новые запуски подождут.'],
  ['server.machineHasNotAnsweredSinceWaitingUntil.1d012e', { machine: MACHINE, since: '14:32:05', until: '14:33:05' }, 'Машина «vast-3» не отвечает с 14:32:05. Ждём до 14:33:05, потом поднимем ядро заново (переменные пропадут).'],
  ['server.theConnectionToMachineCameBackAfter.28f7cf', { machine: MACHINE, seconds: 37 }, 'Связь с машиной «vast-3» вернулась через 37 с.'],
  ['server.theConnectionToTheMachineBrokeThe.5504d1', {}, 'Связь с машиной прервалась — результат ячейки потерян. Ядро и переменные целы; запустите ячейку снова.'],
  ['server.machineHasNotAnsweredSinceTheKernel.6c488a', { machine: MACHINE, since: '14:32:05', filesAt: '14:31:58' }, 'Машина «vast-3» не отвечает с 14:32:05. Ядро поднимется заново: переменные пропали, файлы — по 14:31:58. Запустите ячейки снова.'],
  ['server.thisCellWasRunningOnMachineWhen.cbb534', { machine: MACHINE }, 'Эта ячейка выполнялась на машине «vast-3», когда та пропала. Неизвестно, успела ли она закончиться; на новом ядре её нет.'],
  ['server.theQueueWasClearedItsCellsCounted.c77303', {}, 'Очередь сброшена: ячейки рассчитывали на переменные, которых больше нет.'],
  ['server.noConnectionToMachineARestartWould.406486', { machine: MACHINE }, 'Нет связи с машиной «vast-3» — перезапуск сейчас не дойдёт. Нажмите, когда связь вернётся.'],
  ['server.theRestartWasSentButNoAnswer.17cbbc', {}, 'Перезапуск отправлен, но ответа нет: связь с машиной прервалась. Узнаем, когда она вернётся.'],
  ['server.theRestartWentThroughTheVariablesWere.96b635', {}, 'Перезапуск прошёл: переменные сброшены.'],
  ['server.theRestartDidNotGetThroughThe.92177b', {}, 'Перезапуск не дошёл — переменные на месте.'],
  ['server.noConnectionToTheMachineTheCell.b76132', {}, 'Нет связи с машиной — остановить ячейку сейчас нельзя. Предел времени сработает, когда связь вернётся.'],
  ['server.theOwnerDisconnectedMachine.1a3061', { machine: MACHINE }, 'Владелец отключил машину «vast-3».'],
  ['server.machineIsNoLongerTrustedToRun.8962f2', { machine: MACHINE }, 'Машине «vast-3» больше не доверено вести занятия.'],
  ['server.machineIsBeingDisconnected.6aa752', { machine: MACHINE }, 'Машину «vast-3» отключают.'],
  ['server.theKernelWillStartAgainTheVariables.a76610', {}, 'Ядро поднимется заново, переменные пропали.'],
  ['server.theNetworkOnMachineGotOutOf.c73666', { machine: MACHINE }, 'Сеть на машине «vast-3» вышла из-под контроля: ядро остановлено ради безопасности и поднимется заново.'],
  ['server.thisServerHasNoRoomForThis.25c35f', { used: '14', total: '15 ГБ' }, 'На сервере нет места для ядра этого занятия: занято 14 из 15 ГБ. Освободите память или подключите машину.'],
  ['server.machineCameBackAfterTheMoveIts.aacc24', { machine: MACHINE, since: '14:32', files: 'out.csv, model.pt' }, 'Машина «vast-3» вернулась после переезда; её изменения в файлах после 14:32 не приняты: out.csv, model.pt.'],
  ['server.theKernelsOnTheMachineWereStopped.d5fceb', { files: 'out.csv, model.pt' }, 'Ядра на машине остановлены; изменения в файлах, которые не успели доехать до сервера, отброшены: out.csv, model.pt.'],
  ['server.wasChangedHereAndOnTheMachine.107a60', { file: 'data.csv', copy: 'data (с машины 14-32).csv' }, 'data.csv изменили одновременно здесь и на машине. Оставлена версия сервера, версия с машины — «data (с машины 14-32).csv».'],
  ['server.fromTheMachine.3b540b', { name: 'data', time: '14-32' }, 'data (с машины 14-32)'],
  ['server.wasDeletedOnTheServerTheChanges.6230f9', { file: 'old.csv' }, 'old.csv удалён на сервере; изменения, сделанные в нём на машине, отброшены.'],
  ['server.isOverTheLimitAndStaysOn.bf3362', { file: 'model.pt', size: '2,1 ГБ', limit: '200 МБ' }, 'model.pt (2,1 ГБ) больше предела 200 МБ и остаётся на машине. Если машина пропадёт, файл пропадёт тоже.'],
  ['server.staysOnTheMachineTheProxyIn.8cfa12', { file: 'model.pt', size: '150 МБ' }, 'model.pt (150 МБ) остаётся на машине: прокси перед этим сервером не принял файл такого размера. Если машина пропадёт, файл пропадёт тоже.'],
  ['server.theKernelOnTheMachineWasStopped.7de430', {}, 'Ядро на машине остановлено: следующий запуск поднимет его заново, переменные пропали.'],
  ['server.filesAreOnTheirWayToThe.1bb29d', { done: '12', total: '150 МБ' }, 'Файлы едут на машину: 12 из 150 МБ…'],
  ['server.theFilesDidNotReachTheMachine.20cf87', { seconds: 30 }, 'Файлы не дошли до машины: 30 с без движения — ячейка не запущена.'],
  ['server.startingTheKernelOnMachineImage.1f4cdc', { machine: MACHINE, percent: 45 }, 'Запускаем ядро на машине «vast-3»… образ ↓ 45 %'],
  ['server.thePoolIsStillStartingThisAttempt.bf84be', {}, 'Пул ещё поднимается — эта попытка посчитана в общем ядре.'],
  ['server.runInTheSharedKernelItUses.eaf141', { name: 'conn' }, 'Посчитано в общем ядре: использует conn — её нельзя перенести.'],
  ['server.stateAsOfWithoutCells.44aa0a', { time: '14:05', cells: '8–9' }, 'Состояние 14:05 — без ячеек 8–9.'],
  ['server.theKernelHasRunCellsSinceThe.e29733', { count: 3 }, 'Ядро ушло вперёд на 3 ячейки после снимка — результат в тетради может отличаться.'],
  ['server.theMachineWasLostInTheMiddle.b5f5c5', {}, 'Машина пропала посреди попытки — пересчитано в общем ядре. Пауза между запусками не засчитана.'],
  ['server.theOrderOfSetsInAttemptsMay.b87dc7', {}, 'Порядок множеств в попытках может отличаться от тетради: её ядро запущено до обновления.'],
  // The 0.26.0 rows the build added (§13.2 «As built»), and F6's.
  ['server.thePoolSMachineDoesNotAnswer.16922d', {}, 'Машина пула не отвечает — эта попытка посчитана в общем ядре.'],
  ['server.thePoolSMachineWasLostThe.8aff4c', {}, 'Машина пула пропала — попытка посчитана в общем ядре.'],
  ['server.aPoolWorkerDidNotStartThe.4ecf00', {}, 'Исполнитель пула не поднялся — попытка посчитана в общем ядре.'],
  ['server.theNotebookSStateHoldsDataOn.2ac2bc', {}, 'В состоянии тетради есть данные на видеокарте — попытки считаются в общем ядре.'],
  ['server.theNotebookSStateDoesNotFit.c67b68', {}, 'Состояние тетради не помещается — попытки считаются в общем ядре.'],
  ['server.theNotebookSStateCouldNotBe.9e7101', {}, 'Состояние тетради не собралось — попытки считаются в общем ядре.'],
  ['server.theNewStateDoesNotFit.1c7533', { time: '14:05' }, 'Новое состояние не помещается — попытки на состоянии 14:05.'],
  ['server.theNewStateCouldNotBeTaken.01b6b1', { time: '14:05' }, 'Новое состояние не собралось — попытки на состоянии 14:05.'],
  ['server.thePoolDidNotStart.80644c', { why: 'Пул консилиума бывает только на машинах.' }, 'Пул не поднялся: Пул консилиума бывает только на машинах.'],
  ['server.theWorkersCouldNotLoadThe.69de42', {}, 'исполнители не загрузили состояние тетради'],
  ['server.itsWorkersDidNotStart.f8a286', {}, 'исполнители не запустились'],
  ['server.noMachineHasTakenThePoolYet.9a460b', {}, 'ни одна машина ещё не взяла пул'],
  ['server.theNotebookSStateHasNotReached.461833', {}, 'состояние тетради ещё не дошло до машины'],
  ['server.thePoolSMachineDoesNotAnswer.5890e3', {}, 'машина пула не отвечает'],
  ['server.theWorkersHaveNotLoadedTheNotebook.e2c616', {}, 'исполнители ещё не загрузили состояние тетради'],
  ['server.thisCellSAttemptsDoNotGo.7d2837', {}, 'Попытки этой ячейки не идут в пул.'],
  ['server.onlyTheTeacherRefreshesTheAttempts.3cdeb6', {}, 'Обновить состояние для попыток может преподаватель.'],
  ['server.onlyTheAttemptSAuthorAndThe.94ba37', {}, 'Файлы попытки берут её автор и преподаватели.'],
]
/** Rows beside the table: the slow start before an image, an update's note (§11.7), the Docker branch's refusal (§6.1), an older epoch of one cell, and the reasons of left names (§9.4). */
const BESIDE = [
  'server.startingTheKernelOnMachine.c2d7a3', 'server.theAgentOnMachineIsUpdatingThe.88b188', 'server.theCouncilPoolRunsOnlyOnMachines.ef5702', 'server.stateAsOfWithoutCell.30d8e4',
  'server.notCarriedOver.00ad4e', 'server.databaseConnection.cdf70c', 'server.openFile.3a6aca', 'server.networkSocket.34c443', 'server.generator.c33340',
  'server.thread.49e10b', 'server.lock.1f0e8d', 'server.dataOnTheGpu.605180', 'server.tooBigForTheSnapshot.1a48a4', 'server.cannotBeCopied.e6521a',
  'server.thePersonalNotebooksKernelsOnTheMachine.160525', 'server.cannotBeBroughtHereTheProxyIn.fc1eca', 'server.itsModuleIsOnlyInTheNotebook.49d81a',
]

test('the server\'s words read as the design\'s table, in Russian word for word, and in English', () => {
  for (const [key, params, ru] of WORDS) {
    assert.ok(Object.hasOwn(messages, key), `${key} is not in shared/locales/server.ts`)
    assert.equal(translate('ru', key, params), ru, key)
    const en = translate('en', key, params)
    assert.notEqual(en, key)
  }
  // The sentinel (§9.4): named by its own key, its two names and its reason as the Python fills them; it promises no rerun.
  const sentinel = translate('ru', 'server.council.notCarried', { name: 'conn', why: translate('ru', 'server.databaseConnection.cdf70c') })
  assert.equal(sentinel, 'Переменная conn не перенесена на машину консилиума (соединение с базой), а эта попытка добралась до неё не напрямую. Попытки, в тексте которых есть conn, считаются в общем ядре.')
  assert.doesNotMatch(translate('en', 'server.council.notCarried'), /[А-Яа-яЁё]/)
  // A name a worker's load leaves for a module its machine lacks, and the console's line with it.
  assert.equal(translate('ru', 'server.itsModuleIsOnlyInTheNotebook.49d81a'), 'модуль есть только в ядре тетради')
  // The left names of an epoch, said with their reasons, as the console's row in the table says them.
  const left = translate('ru', 'server.notCarriedOver.00ad4e', {
    names: `conn (${translate('ru', 'server.databaseConnection.cdf70c')}), batches (${translate('ru', 'server.generator.c33340')})`,
  })
  assert.equal(left, 'Не переносится: conn (соединение с базой), batches (генератор).')
  // The plurals are home's, in either language.
  const behind = (locale: 'ru' | 'en', count: number) => translate(locale, 'server.theKernelHasRunCellsSinceThe.e29733', { count })
  assert.deepEqual([1, 2, 5, 21].map((count) => behind('ru', count).split(' ')[5]), ['ячейку', 'ячейки', 'ячеек', 'ячейку'])
  assert.match(behind('en', 1), /run 1 cell since/)
  assert.match(behind('en', 3), /run 3 cells since/)
  // An older epoch names the cells, not their count: «без ячейки» is one cell and «без ячеек» several, 21 or 31 of them as much as 2.
  const without = (locale: 'ru' | 'en', cells: string, count: number) =>
    translate(locale, count === 1 ? 'server.stateAsOfWithoutCell.30d8e4' : 'server.stateAsOfWithoutCells.44aa0a', { time: '14:05', cells, count })
  assert.equal(without('ru', '8', 1), 'Состояние 14:05 — без ячейки 8.')
  for (const count of [2, 5, 21, 31, 101]) assert.equal(without('ru', `3–${2 + count}`, count), `Состояние 14:05 — без ячеек 3–${2 + count}.`)
  assert.equal(without('en', '8', 1), 'State as of 14:05, without cell 8.')
  assert.equal(without('en', '3–23', 21), 'State as of 14:05, without cells 3–23.')
  // Every key in the catalogue's scheme, one a machine's marker could carry; English with no Russian in it; the same parameters in both.
  const parameters = (value: unknown) => [...new Set((typeof value === 'string' ? [value] : Object.values(value as object)).flatMap((text) => [...String(text).matchAll(/\{(\w+)\}/g)].map((m) => m[1])))].sort()
  for (const key of [...WORDS.map(([key]) => key), ...BESIDE]) {
    assert.match(key, /^server\.[a-z][A-Za-z0-9]*\.[a-f0-9]{6}$/)
    assert.match(key, REMOTE_TEXT_KEY)
    const pair = messages[key]!
    for (const text of typeof pair.en === 'string' ? [pair.en] : Object.values(pair.en)) assert.doesNotMatch(text ?? '', /[А-Яа-яЁё]/, key)
    assert.deepEqual(parameters(pair.ru), parameters(pair.en), key)
  }
  // And the copy's name is a file name the class folder takes.
  assert.equal(normalizePath(`${translate('ru', 'server.fromTheMachine.3b540b', { name: 'data', time: '14-32' })}.csv`), 'data (с машины 14-32).csv')
  assert.equal(normalizePath(`${translate('en', 'server.fromTheMachine.3b540b', { name: 'data', time: '14-32' })}.csv`), 'data (from the machine 14-32).csv')
})

/* ------------------------------------------------------------- the numbers */

test('the numbers of §15, and how they agree with each other and with the sync', () => {
  assert.equal(CLASS_START_MS, 180_000)
  assert.equal(CLASS_BARRIER_MS, 120_000)
  assert.equal(CLASS_BARRIER_STALL_MS, 30_000)
  assert.equal(CLASS_SCAN_BUSY_MS, 5_000)
  assert.equal(CLASS_SCAN_IDLE_MS, 30_000)
  assert.equal(CLASS_FILE_QUIET_MS, 2_000)
  assert.equal(CLASS_INLINE_BYTES, 64 * 1024)
  assert.equal(CLASS_INLINE_PUSH_BYTES, 1024 * 1024)
  assert.equal(CLASS_SYNC_FILES_MAX, 5000)
  assert.equal(REMOTE_CLASS_UPLOADS, 2)
  assert.equal(CLASS_MACHINE_FILE_MB, 200)
  assert.equal(CLASS_ROOM_MB, 1024)
  assert.equal(CLASS_PACE_BURST_BYTES, 256 * 1024)
  assert.ok(REMOTE_FILE_CAP_MB_MAX >= 65_536, 'a setting home keeps would be a reply refused')
  assert.equal(CLASS_UNREACHABLE_NOTE_MS, 10_000)
  assert.equal(CLASS_SILENCE_MS, 60_000)
  assert.deepEqual(CLASS_FAILOVER_SEC, { min: 30, max: 300, default: 60 })
  assert.equal(CLASS_TUNNEL_STUCK_MS, 120_000)
  assert.equal(CLASS_EVIDENCE_MS, 15_000)
  assert.equal(CLASS_PROBE_MS, 5_000)
  assert.equal(CLASS_BYE_GRACE_MS, 120_000)
  assert.equal(CLASS_MOVE_NOW_MS, 10_000)
  assert.equal(CLASS_QUARANTINE_FAILOVERS, 2)
  assert.equal(CLASS_QUARANTINE_WINDOW_MS, 30 * 60_000)
  assert.equal(PERIMETER_RECHECK_MS, 60_000)
  assert.equal(PERIMETER_FAILURES_MAX, 3)
  assert.equal(CLASS_HELP_PAD_MAX_MS, 1_000)
  assert.deepEqual([CLASS_BULK_MBPS, CLASS_BULK_PROMOTED_MBPS, CLASS_BULK_IDLE_MBPS, CLASS_COMPETITION_MBPS, MACHINE_PACE_MBPS], [4, 8, 8, 2, 6])
  assert.equal(MACHINE_PACE_BURST_BYTES, 2 * 1024 * 1024)
  assert.equal(COUNCIL_ATTEMPT_MB, 1024)
  assert.deepEqual(COUNCIL_WORKERS, { min: 2, auto: 16, max: 32 })
  assert.equal(COUNCIL_WORKER_REUSE, 20)
  assert.equal(COUNCIL_EPOCH_MB, 2048)
  assert.equal(COUNCIL_EPOCH_SHIP_MB, 256)
  assert.equal(COUNCIL_EPOCH_WAIT_MS, 5_000)
  assert.equal(COUNCIL_POOL_READY_MS, 60_000)
  assert.equal(COUNCIL_POOL_LINGER_MS, 15 * 60_000)
  assert.deepEqual(COUNCIL_ARTIFACTS, { files: 20, fileBytes: 1024 * 1024, totalBytes: 5 * 1024 * 1024 })
  assert.equal(COUNCIL_EPOCH_STORE_MB, 4096)
  // The defaults sit inside their bounds, and the clocks inside each other.
  assert.ok(CLASS_FAILOVER_SEC.min <= CLASS_FAILOVER_SEC.default && CLASS_FAILOVER_SEC.default <= CLASS_FAILOVER_SEC.max)
  assert.ok(CLASS_EVIDENCE_MS >= 2 * CLASS_PROBE_MS, 'evidence outlives one failed probe')
  assert.ok(CLASS_UNREACHABLE_NOTE_MS < CLASS_FAILOVER_SEC.min * 1000 && CLASS_MOVE_NOW_MS < CLASS_FAILOVER_SEC.min * 1000)
  assert.ok(CLASS_SILENCE_MS < CLASS_TUNNEL_STUCK_MS)
  // A machine holding placements is held by the busy hold, so its silence is measured in syncs it sends.
  assert.ok(REMOTE_HOLD_BUSY_MS < CLASS_FAILOVER_SEC.min * 1000)
  assert.ok(CLASS_SCAN_BUSY_MS < CLASS_SCAN_IDLE_MS && CLASS_FILE_QUIET_MS < CLASS_SCAN_BUSY_MS)
  assert.ok(CLASS_BARRIER_STALL_MS < CLASS_BARRIER_MS)
  assert.ok(CLASS_INLINE_BYTES <= CLASS_INLINE_REPORT_BYTES && CLASS_INLINE_REPORT_BYTES <= CLASS_INLINE_PUSH_BYTES)
  assert.ok(COUNCIL_EPOCH_SHIP_MB <= COUNCIL_EPOCH_MB && COUNCIL_EPOCH_MB <= COUNCIL_EPOCH_STORE_MB)
  assert.ok(COUNCIL_WORKERS.min <= COUNCIL_WORKERS.auto && COUNCIL_WORKERS.auto <= COUNCIL_WORKERS.max)
  assert.ok(COUNCIL_ARTIFACTS.fileBytes * COUNCIL_ARTIFACTS.files >= COUNCIL_ARTIFACTS.totalBytes)
  // A full push of the largest folder fits one reply; a walk's report takes several syncs at most, in pages.
  assert.equal(REMOTE_PUSH_PATHS_MAX, CLASS_SYNC_FILES_MAX)
  assert.ok(REMOTE_REPORT_PATHS_MAX * 5 >= CLASS_SYNC_FILES_MAX)
  // Every epoch a machine may hold fits one message: two for each notebook of as many classes as it holds slots.
  assert.equal(REMOTE_EPOCHS_MAX, 2 * REMOTE_PLACEMENTS_MAX)
  assert.equal(REMOTE_EPOCH_FILES_MAX, 2 * COUNCIL_EPOCH_BUFFERS_MAX)
})
