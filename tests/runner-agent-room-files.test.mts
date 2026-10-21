/**
 * A class folder's copy on the machine (server/src/runner-agent/room-files.ts,
 * docs/architecture/remote-classes.md §8, §17.1 row runner-agent-room-files):
 * home's pushes in their order, the baseline both sides agreed written down
 * and read again, the scans with their quiet rule and their pace, package
 * trees left on the machine, links never followed, copy before hash, paced
 * uploads, the late list of a copy home fenced, and full walks in pages
 * within one sync's budget — and all of it through the agent's sync.
 *
 * What is held here is what a class would lose: a push applied out of order
 * is a renamed file overwritten by its successor; a baseline lost is every
 * file of the class a conflict copy at home; a checkpoint hashed half written
 * a broken file home applies; a planted link a secret of the agent's on its
 * way home; a `pip install -t .` sent over the relay a lecture that freezes.
 */
import './_env.mts'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'
import { createHash, randomBytes } from 'node:crypto'
import {
  CLASS_FILE_QUIET_MS,
  CLASS_INLINE_BYTES,
  CLASS_PACE_BURST_BYTES,
  CLASS_SCAN_BUSY_MS,
  CLASS_SCAN_IDLE_MS,
  REMOTE_REPORT_PATHS_MAX,
  parseRemoteKernelsReply,
  parseRemoteKernelsRequest,
  type RemoteFilesLag,
  type RemoteFilesPush,
  type RemoteFilesReport,
  type RemoteKernelsReply,
  type RemotePlacementIntent,
} from '../shared/remote-kernels.ts'
import { REMOTE_MARKER, REMOTE_MARKER_HEADER } from '../shared/remote-runner.ts'
import { Cache, Pacer } from '../server/src/runner-agent/cache.ts'
import { RemoteClient, Backoff } from '../server/src/runner-agent/client.ts'
import { RoomFiles, ROOM_FILE_TIMINGS, packagePaths, roomBaselineFile, roomFolder, type RoomFileTimings, type RoomUpload, type RoomUploadAnswer } from '../server/src/runner-agent/room-files.ts'
import { Agent } from '../server/src/runner-agent/sync.ts'
import { stateLayout, type StateLayout } from '../server/src/runner-agent/state.ts'
import { TEST_ROOT } from './_env.mts'
import { DIFF_IDS, FakeSeam, LAYERS, REVISION, fakeAgentDocker, fakeHome, serveBlob, sha256, syncReply, waitFor } from './_runner-agent-home.mts'

/* ---------------------------------------------------------------- fixtures */

const sha = (body: string | Buffer): string => createHash('sha256').update(body).digest('hex')
const MIB = 1024 * 1024

function intent(key = 's1:room', gen = 1): RemotePlacementIntent {
  return {
    key, gen, environment: 'base', revision: { id: REVISION.id, ref: REVISION.ref, layers: LAYERS },
    memoryMb: 4096, cpus: 2, pids: 512, gpu: false, network: 'blocked', blockedCidrs: [], token: 'e'.repeat(40), hashSeed: 7, shm: '1g',
  }
}

/** Home's block, as the agent's parser takes it: the class s1 placed here at gen 1 unless a test says otherwise. */
function block(partial: Partial<RemoteKernelsReply> = {}, placements: RemotePlacementIntent[] = [intent()]): RemoteKernelsReply {
  return parseRemoteKernelsReply({
    placements, pushes: [], verdicts: [], pulls: [], scan: [], epochs: [], collect: [], postmortem: [],
    rates: { classBulkMBps: 4, machinePaceMBps: 6 }, tunnel: 'open', ...partial,
  })
}

const put = (at: string, body: string | Buffer) => ({ path: at, sha256: sha(body), bytes: Buffer.byteLength(body), inline: Buffer.from(body).toString('base64') })
const putBlob = (at: string, body: string | Buffer) => ({ path: at, sha256: sha(body), bytes: Buffer.byteLength(body) })
const dirPut = (at: string) => ({ path: at, dir: true as const })
const push = (seq: number, parts: Partial<RemoteFilesPush> = {}, sessionId = 's1'): RemoteFilesPush => ({ sessionId, seq, full: false, put: [], remove: [], move: [], ...parts })

const FACTS = { hostNetwork: true, perimeter: 'ok', mode: 'blocked', canary: 'ok', sameDaemon: false } as const

interface Rig {
  layout: StateLayout
  clock: { now: number }
  files: RoomFiles
  /** Blobs home serves, by hash; what was fetched, and at which pace. */
  blobs: Map<string, Buffer>
  fetched: Array<{ sha: string; pace: number }>
  /** Blobs let go once copied into their folder (Cache.release). */
  released: string[]
  uploads: Array<{ upload: RoomUpload; body: Buffer }>
  /** The answer of the next upload; `before` runs before its body is read; `door`, when set, is home's door instead. */
  answer: (upload: RoomUpload) => RoomUploadAnswer
  before: (upload: RoomUpload) => void
  door: ((upload: RoomUpload) => Promise<RoomUploadAnswer>) | null
  waits: number[]
  held: Map<string, Array<{ role: 'room' | 'own' | 'council'; gen: number }>>
  busy: { at: number }
  urgent: number
  logs: string[]
  dir: (sessionId?: string) => string
}

/** A copy's host with every seam its own: a clock that only the waits move, home's blobs, an upload door that keeps what it took. */
function rig(layout: StateLayout = stateLayout(fs.mkdtempSync(path.join(TEST_ROOT, 'room-files-'))), extra: { timings?: Partial<RoomFileTimings>; uid?: number | null } = {}): Rig {
  const r: Rig = {
    layout,
    clock: { now: 1_800_000_000_000 },
    files: undefined as unknown as RoomFiles,
    blobs: new Map(),
    fetched: [],
    released: [],
    uploads: [],
    answer: () => ({ kind: 'ok' }),
    before: () => undefined,
    door: null,
    waits: [],
    held: new Map(),
    busy: { at: 0 },
    urgent: 0,
    logs: [],
    dir: (sessionId = 's1') => roomFolder(layout, sessionId),
  }
  r.files = new RoomFiles({
    layout,
    blob: async (hash, bytes, { pace }) => {
      r.fetched.push({ sha: hash, pace: pace() })
      const body = r.blobs.get(hash)
      if (!body || body.length !== bytes) throw new Error(`home refused ${hash.slice(0, 12)}: not_found`)
      const file = path.join(layout.root, 'cas', hash)
      fs.mkdirSync(path.dirname(file), { recursive: true })
      fs.writeFileSync(file, body)
      return file
    },
    release: (hash) => r.released.push(hash),
    upload: async (upload) => {
      if (r.door) return r.door(upload)
      r.before(upload)
      const chunks: Buffer[] = []
      for await (const chunk of upload.body) chunks.push(Buffer.from(chunk))
      r.uploads.push({ upload, body: zlib.gunzipSync(Buffer.concat(chunks)) })
      return r.answer(upload)
    },
    held: (sessionId) => r.held.get(sessionId) ?? [],
    busyAt: () => r.busy.at,
    onChange: (urgent) => {
      if (urgent) r.urgent++
    },
    log: (line) => r.logs.push(line),
    now: () => r.clock.now,
    sleep: async (ms) => {
      r.waits.push(ms)
      r.clock.now += ms
    },
    timings: { beatMs: 0, ...extra.timings },
    uid: extra.uid ?? null,
  })
  return r
}

/** One beat, and everything it started settled. */
async function beat(r: Rig): Promise<void> {
  await r.files.tick()
  await r.files.idle()
}

/** A reply taken in, and everything it started settled. */
async function answer(r: Rig, kernels: RemoteKernelsReply): Promise<void> {
  r.files.reconcile(kernels)
  await r.files.idle()
}

/** The next sync's reports, read by home's own strict parser, not answered yet. */
function build(r: Rig): RemoteFilesReport[] {
  const reports = r.files.reportsNow()
  parseRemoteKernelsRequest({ placements: [], reports, epochs: [], readings: [], tunnel: 'up', classes: FACTS })
  return reports
}

/** The next sync's reports, read by home's own strict parser, then answered (reportsSaid). */
function say(r: Rig): RemoteFilesReport[] {
  const reports = build(r)
  r.files.reportsSaid(reports)
  return reports
}

/** The descriptors this process holds open. */
const openFds = (): number => fs.readdirSync(process.platform === 'linux' ? '/proc/self/fd' : '/dev/fd').length

const changedOf = (report: RemoteFilesReport | undefined) => (report?.changed ?? []).map(({ path: at, sha256, base }) => ({ path: at, sha256, base }))

/** An empty full push: the copy's folder, made as a placement's first push makes it. */
const begin = (sessionId = 's1') => push(1, { full: true }, sessionId)

/* --------------------------------------------------------------- pushes */

test('a push applies in its order — moves, then removes, then puts — each change into the baseline, written whole, and the ack asked for at once', async () => {
  const r = rig()
  await answer(r, block({ pushes: [push(1, { full: true, put: [put('f.csv', 'old'), dirPut('d'), put('d/x.txt', 'x')] })] }))
  const urgent = r.urgent
  // Home moved f.csv to t.csv and wrote a new f.csv in its place; its folder d became a file.
  await answer(r, block({ pushes: [push(2, { move: [{ from: 'f.csv', to: 't.csv' }], remove: ['d'], put: [put('f.csv', 'new'), put('d', 'now a file')] })] }))
  const dir = r.dir()
  assert.equal(fs.readFileSync(path.join(dir, 't.csv'), 'utf8'), 'old', 'the put came before the move it follows')
  assert.equal(fs.readFileSync(path.join(dir, 'f.csv'), 'utf8'), 'new')
  assert.equal(fs.readFileSync(path.join(dir, 'd'), 'utf8'), 'now a file', 'the folder went after the file that replaces it')
  assert.ok(r.urgent > urgent, 'the ack waited for the end of the held sync')
  assert.deepEqual(r.files.lag('s1'), { pushSeq: 2, pending: 0, pendingBytes: 0, heldOnly: 0, heldOnlyBytes: 0 })
  // Written whole, as both sides now agree on it.
  const written = JSON.parse(fs.readFileSync(roomBaselineFile(r.layout, 's1'), 'utf8')) as { pushSeq: number; gens: unknown; files: unknown[][] }
  assert.equal(written.pushSeq, 2)
  assert.deepEqual(written.gens, { room: 1 })
  assert.deepEqual(Object.fromEntries(written.files.map(([at, base]) => [at, base])), { 'f.csv': sha('new'), 't.csv': sha('old'), d: sha('now a file') })
  // As home's sessionDir makes them, and no temporary name left behind.
  assert.equal(fs.statSync(path.join(dir, 'f.csv')).mode & 0o777, 0o664)
  assert.deepEqual(fs.readdirSync(dir).filter((name) => name.startsWith('.')), [])
  // Everything agreed: nothing to say.
  await answer(r, block({ scan: [{ sessionId: 's1' }] }))
  assert.deepEqual(say(r), [])
})

test('the baseline outlives the agent: a new life serves the same copy, and what changed while it was down is said against what both sides agreed', async () => {
  const r = rig()
  await answer(r, block({ pushes: [push(1, { full: true, put: [put('a.csv', 'v1'), put('b.csv', 'b')] })] }))
  r.files.stop()
  fs.writeFileSync(path.join(r.dir(), 'a.csv'), 'v2, written while the agent was down')
  fs.rmSync(path.join(r.dir(), 'b.csv'))
  const next = rig(r.layout)
  next.files.load()
  await answer(next, block({ scan: [{ sessionId: 's1' }] }))
  assert.equal(next.files.lag('s1')?.pushSeq, 1, 'the ack was lost with the life')
  const [report] = say(next)
  assert.deepEqual(changedOf(report), [{ path: 'a.csv', sha256: sha('v2, written while the agent was down'), base: sha('v1') }])
  assert.deepEqual(report!.removed, [{ path: 'b.csv', base: sha('b') }])
  // A report's seq outgrows the earlier life's, whose verdicts must find nothing of this one's.
  assert.ok(report!.seq > r.clock.now - 1)
})

test('a push with blobs takes them down the cache at the class\'s rate, the promoted one while a run waits on it, and copies them out of the CAS', async () => {
  const r = rig()
  const big = randomBytes(CLASS_INLINE_BYTES + 1)
  r.blobs.set(sha(big), big)
  await answer(r, block({ pushes: [push(1, { full: true, put: [putBlob('train.bin', big)] })] }))
  await answer(r, block({ pushes: [push(2, { promoted: true, put: [putBlob('again.bin', Buffer.concat([big, Buffer.from('!')]))] })] }))
  assert.deepEqual(r.fetched.map(({ pace }) => pace / MIB), [4, 8])
  assert.ok(fs.readFileSync(path.join(r.dir(), 'train.bin')).equals(big))
  // Copied, never linked: the class may open it r+ without rewriting what a submission mounts; and the CAS lets it go.
  assert.equal(fs.statSync(path.join(r.dir(), 'train.bin')).nlink, 1)
  assert.deepEqual(r.released, [sha(big)])
  // The second blob was never home's: the push waits, unacked, and tries again later.
  assert.equal(r.files.lag('s1')?.pushSeq, 1)
})

test('both sides changed a file: home\'s version is written and the machine\'s goes home with its old base, for home\'s conflict copy; a put home did not change leaves the machine\'s change to its report', async () => {
  const r = rig()
  await answer(r, block({ pushes: [push(1, { full: true, put: [put('u.py', 'v1'), put('w.py', 'w1')] })] }))
  // The kernel rewrote both, and no scan has seen it yet.
  fs.writeFileSync(path.join(r.dir(), 'u.py'), 'machine')
  fs.writeFileSync(path.join(r.dir(), 'w.py'), 'machine w')
  await answer(r, block({ pushes: [push(2, { put: [put('u.py', 'home'), put('w.py', 'w1')] })] }))
  assert.equal(fs.readFileSync(path.join(r.dir(), 'u.py'), 'utf8'), 'home', 'home\'s version did not win')
  assert.equal(fs.readFileSync(path.join(r.dir(), 'w.py'), 'utf8'), 'machine w', 'a put of what home did not change overwrote the machine\'s change')
  await answer(r, block({ scan: [{ sessionId: 's1' }] }))
  const [report] = say(r)
  assert.deepEqual(changedOf(report).sort((a, b) => a.path.localeCompare(b.path)), [
    { path: 'u.py', sha256: sha('machine'), base: sha('v1') },
    { path: 'w.py', sha256: sha('machine w'), base: sha('w1') },
  ])
  assert.equal(Buffer.from(report!.changed.find((entry) => entry.path === 'u.py')!.inline!, 'base64').toString(), 'machine', 'the conflict\'s bytes are not the kept ones')
  // Home kept the machine's u.py as its copy, and took w.py.
  await answer(r, block({ verdicts: [{ sessionId: 's1', seq: report!.seq, accepted: ['w.py'], refused: [{ path: 'u.py', why: 'base', copy: 'u (с машины 14-32).py' }] }], scan: [{ sessionId: 's1' }] }))
  assert.deepEqual(say(r), [])
  assert.deepEqual(r.files.lag('s1'), { pushSeq: 2, pending: 0, pendingBytes: 0, heldOnly: 0, heldOnlyBytes: 0 })
})

test('a version home keeps as its conflict copy goes home when home pulls it, the copy\'s name and the pull in one reply', async () => {
  const r = rig()
  await answer(r, block({ pushes: [push(1, { full: true, put: [put('big.bin', 'v1')] })] }))
  const machine = randomBytes(CLASS_INLINE_BYTES * 2)
  fs.writeFileSync(path.join(r.dir(), 'big.bin'), machine)
  // Home changed it too and pushes its version before any scan saw the machine's.
  await answer(r, block({ pushes: [push(2, { put: [put('big.bin', 'home')] })] }))
  await answer(r, block({ scan: [{ sessionId: 's1' }] }))
  const [report] = say(r)
  assert.deepEqual(changedOf(report), [{ path: 'big.bin', sha256: sha(machine), base: sha('v1') }])
  assert.equal(report!.changed[0]!.inline, undefined)
  // Home's answer as kernel/remote/files.ts makes it: the verdict naming its copy, and the pull of the copy's bytes beside it.
  await answer(r, block({
    verdicts: [{ sessionId: 's1', seq: report!.seq, accepted: [], refused: [{ path: 'big.bin', why: 'base', copy: 'big (с машины 14-32).bin' }] }],
    pulls: [{ sessionId: 's1', gen: 1, paths: [{ path: 'big.bin', sha256: sha(machine) }] }],
  }))
  assert.equal(r.uploads.length, 1, 'home\'s conflict copy never got its bytes')
  assert.ok(r.uploads[0]!.body.equals(machine))
  assert.deepEqual(fs.readdirSync(`${r.dir()}.staging`), [], 'the kept version outlived its upload')
})

test('«Привезти» sends the file as it is now, never a version kept aside for home\'s conflict copy', async () => {
  const r = rig()
  await answer(r, block({ pushes: [push(1, { full: true, put: [put('big.bin', 'v1')] })] }))
  fs.writeFileSync(path.join(r.dir(), 'big.bin'), randomBytes(CLASS_INLINE_BYTES * 2))
  await answer(r, block({ pushes: [push(2, { put: [put('big.bin', 'home')] })] }))
  await answer(r, block({ scan: [{ sessionId: 's1' }] }))
  const [report] = say(r)
  await answer(r, block({ verdicts: [{ sessionId: 's1', seq: report!.seq, accepted: [], refused: [{ path: 'big.bin', why: 'base', copy: 'big (с машины 14-32).bin' }] }] }))
  await answer(r, block({ pulls: [{ sessionId: 's1', gen: 1, paths: [{ path: 'big.bin' }] }] }))
  assert.equal(r.uploads[0]?.body.toString(), 'home')
})

test('a version home has seen is never said again when home\'s push replaces it — home answered first, or the push landed while it was on its way: home would keep a second copy', async () => {
  for (const order of ['verdict with the push', 'push before the verdict'] as const) {
    const r = rig()
    await answer(r, block({ pushes: [push(1, { full: true, put: [put('utils.py', 'B')] })] }))
    fs.writeFileSync(path.join(r.dir(), 'utils.py'), 'X from the kernel')
    await answer(r, block({ scan: [{ sessionId: 's1' }] }))
    const [report] = say(r)
    assert.deepEqual(changedOf(report), [{ path: 'utils.py', sha256: sha('X from the kernel'), base: sha('B') }])
    // The editor saved its own version meanwhile: home kept the kernel's as «utils (с машины 14-32).py» and pushes its own back.
    const verdicts = [{ sessionId: 's1', seq: report!.seq, accepted: [], refused: [{ path: 'utils.py', why: 'base' as const, copy: 'utils (с машины 14-32).py' }] }]
    const pushes = [push(2, { put: [put('utils.py', 'Y from the editor')] })]
    if (order === 'verdict with the push') await answer(r, block({ verdicts, pushes }))
    else {
      await answer(r, block({ pushes }))
      await answer(r, block({ verdicts }))
    }
    assert.equal(fs.readFileSync(path.join(r.dir(), 'utils.py'), 'utf8'), 'Y from the editor')
    await answer(r, block({ scan: [{ sessionId: 's1' }] }))
    assert.deepEqual(say(r), [], `${order}: the version home kept was said again`)
  }
})

test('nothing past the cap is read to be kept aside: a push over a kernel\'s file of holes replaces it unread, and «Привезти» of one past the room limit copies nothing', async () => {
  const r = rig()
  const caps = { machineFileMb: 1, roomMb: 2 }
  await answer(r, block({ pushes: [push(1, { full: true, put: [put('data.csv', 'v1')] })], caps }))
  // The kernel's os.truncate: 64 MiB to read, none of it on the disk (16 TiB is as easy, and hours of zeros).
  const data = path.join(r.dir(), 'data.csv')
  fs.truncateSync(data, 64 * MIB)
  await answer(r, block({ pushes: [push(2, { put: [put('data.csv', 'v2')] })], caps }))
  assert.equal(fs.readFileSync(data, 'utf8'), 'v2')
  const staging = `${r.dir()}.staging`
  assert.deepEqual(fs.existsSync(staging) ? fs.readdirSync(staging) : [], [], 'the machine\'s version past the cap was copied aside')
  await answer(r, block({ scan: [{ sessionId: 's1' }], caps }))
  assert.deepEqual(say(r), [], 'a version past the cap was said for a conflict copy home cannot keep')
  const big = path.join(r.dir(), 'big.bin')
  fs.writeFileSync(big, '')
  fs.truncateSync(big, 3 * MIB)
  await answer(r, block({ pulls: [{ sessionId: 's1', gen: 1, paths: [{ path: 'big.bin' }] }], caps }))
  assert.equal(r.uploads.length, 0, 'a file past the room limit was copied and sent for «Привезти»')
})

test('a blob two classes copy is let go of only once the last has copied it', async () => {
  const r = rig()
  const both = [intent('s1:room'), intent('s2:room')]
  const body = randomBytes(CLASS_INLINE_BYTES + 1)
  r.blobs.set(sha(body), body)
  await answer(r, block({ pushes: [push(1, { full: true, put: [putBlob('shared.bin', body)] }, 's1'), push(1, { full: true, put: [putBlob('shared.bin', body)] }, 's2')] }, both))
  assert.ok(fs.readFileSync(path.join(r.dir('s1'), 'shared.bin')).equals(body) && fs.readFileSync(path.join(r.dir('s2'), 'shared.bin')).equals(body))
  assert.deepEqual(r.released, [sha(body)], 'the blob was let go while the other class was still copying it')
})

test('what the agent makes is as home\'s sessionDir makes it: folders 2775 with their setgid, files 0664, owned by the kernels\' uid', async () => {
  const uid = process.getuid?.() ?? null
  const r = rig(undefined, { uid })
  await answer(r, block({ pushes: [push(1, { full: true, put: [dirPut('data'), put('deep/er/x.csv', 'x')] })] }))
  for (const dir of ['data', 'deep', 'deep/er']) {
    const stat = fs.statSync(path.join(r.dir(), dir))
    assert.equal((stat.mode & 0o7777).toString(8), '2775', `${dir}: not a folder the kernels' group keeps`)
    if (uid !== null) assert.equal(stat.uid, uid)
  }
  const file = fs.statSync(path.join(r.dir(), 'deep/er/x.csv'))
  assert.equal((file.mode & 0o7777).toString(8), '664')
  if (uid !== null) assert.equal(file.uid, uid)
})

/* ---------------------------------------------------------------- scans */

test('a changed file is hashed once its stats held for CLASS_FILE_QUIET_MS on the agent\'s clock; a scan home asks for after a cell does not wait', async () => {
  const r = rig()
  await answer(r, block({ pushes: [begin()] }))
  const file = path.join(r.dir(), 'ckpt.bin')
  fs.writeFileSync(file, 'half')
  r.clock.now = r.files.due('s1')!
  await beat(r)
  assert.deepEqual(say(r), [], 'a file seen once was said')
  assert.equal(r.files.due('s1'), r.clock.now + CLASS_FILE_QUIET_MS, 'the copy looks again only at its idle pace')
  r.clock.now += 1_000
  fs.appendFileSync(file, ' and the rest')
  r.clock.now = r.files.due('s1')!
  await beat(r)
  assert.deepEqual(say(r), [], 'a file still being written was said')
  r.clock.now = r.files.due('s1')!
  await beat(r)
  assert.deepEqual(changedOf(say(r)[0]), [{ path: 'ckpt.bin', sha256: sha('half and the rest'), base: null }])
  // Home's word after a cell: the writer is done.
  fs.writeFileSync(path.join(r.dir(), 'out.csv'), 'a,b\n1,2\n')
  await answer(r, block({ scan: [{ sessionId: 's1' }] }))
  const [report] = say(r)
  assert.deepEqual(report!.changed.map((entry) => entry.path), ['out.csv'], 'the change in flight was said twice, or the new one not at once')
  assert.equal(Buffer.from(report!.changed[0]!.inline!, 'base64').toString(), 'a,b\n1,2\n')
})

test('a class\'s own scans: every CLASS_SCAN_BUSY_MS while a kernel of it was busy within the minute, every CLASS_SCAN_IDLE_MS otherwise', async () => {
  const r = rig()
  r.busy.at = r.clock.now
  await answer(r, block({ pushes: [begin()] }))
  assert.equal(r.files.due('s1'), r.clock.now + CLASS_SCAN_BUSY_MS)
  r.clock.now += CLASS_SCAN_BUSY_MS
  await beat(r)
  assert.equal(r.files.due('s1'), r.clock.now + CLASS_SCAN_BUSY_MS)
  // A minute since the census last saw a kernel busy: the idle pace.
  r.clock.now = r.busy.at + ROOM_FILE_TIMINGS.busyWindowMs
  await beat(r)
  assert.equal(r.files.due('s1'), r.clock.now + CLASS_SCAN_IDLE_MS)
  // Not due: a beat walks nothing.
  const due = r.files.due('s1')
  r.clock.now += 1_000
  await beat(r)
  assert.equal(r.files.due('s1'), due)
})

test('a new folder at the top is said only once nothing in it has moved for the quiet time: an install is not sent half done', async () => {
  const r = rig()
  await answer(r, block({ pushes: [begin()] }))
  fs.mkdirSync(path.join(r.dir(), 'dataset'))
  fs.writeFileSync(path.join(r.dir(), 'dataset', 'a.csv'), 'a')
  r.clock.now = r.files.due('s1')!
  await beat(r)
  // a.csv has held its stats long enough, but b.csv lands beside it: the folder is still being written.
  r.clock.now += CLASS_FILE_QUIET_MS
  fs.writeFileSync(path.join(r.dir(), 'dataset', 'b.csv'), 'b')
  await beat(r)
  assert.deepEqual(say(r), [], 'a folder still being written was sent')
  r.clock.now += CLASS_FILE_QUIET_MS
  await beat(r)
  assert.deepEqual(say(r)[0]!.changed.map((entry) => entry.path).sort(), ['dataset/a.csv', 'dataset/b.csv'])
})

test('a package tree its RECORD lists stays on the machine, one entry for each folder it owns whole, and none of its files travels', async () => {
  const r = rig()
  await answer(r, block({ pushes: [begin()] }))
  const write = (at: string, body: string): void => {
    fs.mkdirSync(path.dirname(path.join(r.dir(), at)), { recursive: true })
    fs.writeFileSync(path.join(r.dir(), at), body)
  }
  write('torch/__init__.py', 'x')
  write('torch/lib/libtorch.so', 'y'.repeat(1000))
  write('torch-2.4.0.dist-info/METADATA', 'Name: torch')
  write('bin/torchrun', '#!/bin/sh')
  write('bin/mine.sh', 'echo mine')
  write('notes.txt', 'mine too')
  write('torch-2.4.0.dist-info/RECORD', [
    'torch/__init__.py,sha256=abc,1', 'torch/lib/libtorch.so,sha256=def,1000', 'torch-2.4.0.dist-info/METADATA,sha256=ghi,11',
    'torch-2.4.0.dist-info/RECORD,,', 'bin/torchrun,sha256=jkl,9', '',
  ].join('\n'))
  // An older package's list, relative to its own metadata folder.
  write('oldpkg/__init__.py', 'old')
  write('old-1.0-py3.egg-info/installed-files.txt', '../oldpkg/__init__.py\n')
  await answer(r, block({ scan: [{ sessionId: 's1' }] }))
  const [report] = say(r)
  assert.deepEqual(report!.changed.map((entry) => entry.path).sort(), ['bin/mine.sh', 'notes.txt'])
  assert.deepEqual(Object.fromEntries(report!.skipped.map((entry) => [entry.path, [entry.bytes, entry.why]])), {
    torch: [1001, 'package'], 'torch-2.4.0.dist-info': [11, 'package'], 'bin/torchrun': [9, 'package'], oldpkg: [0, 'package'], 'old-1.0-py3.egg-info': [0, 'package'],
  })
  assert.deepEqual(r.files.lag('s1'), { pushSeq: 1, pending: 2, pendingBytes: 'echo mine'.length + 'mine too'.length, heldOnly: 5, heldOnlyBytes: 1021 })
  // Said once: a later report says no package again until it changes, and one that goes is released.
  fs.rmSync(path.join(r.dir(), 'oldpkg'), { recursive: true })
  fs.rmSync(path.join(r.dir(), 'old-1.0-py3.egg-info'), { recursive: true })
  await answer(r, block({ scan: [{ sessionId: 's1' }] }))
  const [after] = say(r)
  assert.deepEqual(after!.skipped, [])
  assert.deepEqual(after!.released!.sort(), ['old-1.0-py3.egg-info', 'oldpkg'])
})

test('a RECORD\'s paths are read as Python\'s csv writes them, quoted with a comma or a quote in them, a size where it says one', () => {
  assert.deepEqual(packagePaths('a.py,sha256=x,12\n"b,c.py",sha256=y,7\n"d""e.py",,\nf.py,,\n', 'record'), [
    { path: 'a.py', bytes: 12 }, { path: 'b,c.py', bytes: 7 }, { path: 'd"e.py', bytes: 0 }, { path: 'f.py', bytes: 0 },
  ])
  assert.deepEqual(packagePaths('../pkg/__init__.py\r\n../pkg/x.py\n', 'installed'), [{ path: '../pkg/__init__.py', bytes: 0 }, { path: '../pkg/x.py', bytes: 0 }])
})

test('the caps keep a file home on its own and the class\'s files together: one past either stays «на машине», and «Привезти» sends it as it is', async () => {
  const r = rig()
  await answer(r, block({ pushes: [begin()] }))
  const model = randomBytes(MIB + 1)
  fs.writeFileSync(path.join(r.dir(), 'model.pt'), model)
  fs.writeFileSync(path.join(r.dir(), 'a.bin'), randomBytes(600 * 1024))
  fs.writeFileSync(path.join(r.dir(), 'b.bin'), randomBytes(600 * 1024))
  await answer(r, block({ scan: [{ sessionId: 's1' }], caps: { machineFileMb: 1, roomMb: 1 } }))
  const [report] = say(r)
  assert.deepEqual(report!.changed.map((entry) => entry.path), ['a.bin'])
  assert.deepEqual(report!.skipped.map(({ path: at, why }) => [at, why]).sort(), [['b.bin', 'room'], ['model.pt', 'size']])
  // Staff press «Привезти» (within the room limit, past the file's): home pulls it with no hash, and it goes as it is, its PUT saying what it is.
  await answer(r, block({ pulls: [{ sessionId: 's1', gen: 1, paths: [{ path: 'model.pt' }] }], caps: { machineFileMb: 1, roomMb: 2 } }))
  assert.equal(r.uploads.length, 1)
  assert.equal(r.uploads[0]!.upload.sha256, sha(model))
  assert.ok(r.uploads[0]!.body.equals(model))
})

test('a rewrite that keeps the length and puts the mtime back is a change: its ctime says so, and a push over it keeps the machine\'s version for home\'s copy', async () => {
  // Whole seconds, as a tar's files have them: an mtime shutil.copy2, cp -p or touch -r sets back exactly.
  const TAR_TIME = 1_700_000_000
  const rewrite = (file: string, body: string): void => {
    const fd = fs.openSync(file, 'r+')
    fs.ftruncateSync(fd, 0)
    fs.writeSync(fd, body, 0)
    fs.closeSync(fd)
    fs.utimesSync(file, TAR_TIME, TAR_TIME)
  }
  const r = rig()
  await answer(r, block({ pushes: [push(1, { full: true, put: [put('model.bin', 'version-A')] })] }))
  const file = path.join(r.dir(), 'model.bin')
  fs.utimesSync(file, TAR_TIME, TAR_TIME)
  await answer(r, block({ scan: [{ sessionId: 's1' }] }))
  assert.deepEqual(say(r), [])
  rewrite(file, 'version-B')
  r.clock.now += 10_000
  await answer(r, block({ scan: [{ sessionId: 's1' }] }))
  const [report] = say(r)
  assert.deepEqual(changedOf(report), [{ path: 'model.bin', sha256: sha('version-B'), base: sha('version-A') }], 'the rewrite was taken for the file both sides agreed')
  // Home pushes its own version C over it before answering: the kernel's B is kept aside, never taken for what both sides agreed.
  rewrite(file, 'version-D')
  await answer(r, block({ pushes: [push(2, { put: [put('model.bin', 'version-C')] })] }))
  await answer(r, block({ scan: [{ sessionId: 's1' }] }))
  assert.deepEqual(say(r).flatMap((one) => changedOf(one)), [{ path: 'model.bin', sha256: sha('version-D'), base: sha('version-A') }], 'the machine\'s version went without a conflict copy')
})

test('a new top folder holds its files back only while new paths come into it, and newFolderMs at most: a checkpoint beside a log a cell keeps writing goes, and so does a folder filled for good', async () => {
  const r = rig()
  r.busy.at = r.clock.now
  await answer(r, block({ pushes: [begin()] }))
  fs.mkdirSync(path.join(r.dir(), 'logs'))
  fs.writeFileSync(path.join(r.dir(), 'logs', 'ckpt.pt'), 'epoch 1 weights')
  fs.mkdirSync(path.join(r.dir(), 'frames'))
  const said = new Set<string>()
  // A cell at the busy pace: its log grows every second, and another loop saves a frame a second into a folder of its own.
  for (let second = 0; second < 60; second++) {
    r.clock.now += 1_000
    r.busy.at = r.clock.now
    fs.appendFileSync(path.join(r.dir(), 'logs', 'train.log'), `step ${second}\n`)
    fs.writeFileSync(path.join(r.dir(), 'frames', `${String(second).padStart(3, '0')}.png`), `frame ${second}`)
    if (r.clock.now >= r.files.due('s1')!) await beat(r)
    for (const report of say(r)) for (const entry of report.changed) said.add(entry.path)
    if (second === 10) assert.ok(said.has('logs/ckpt.pt'), 'the checkpoint waited on a log beside it')
  }
  assert.ok(!said.has('logs/train.log'), 'a log still being written was said')
  assert.ok(said.has('frames/000.png'), 'a folder that keeps filling held its files back for good')
})

test('the class\'s own pace: a file that keeps changing is looked at by the pace, not at every quiet time; a class that turns busy is scanned at the busy pace from its last scan', async () => {
  const r = rig()
  await answer(r, block({ pushes: [begin()] }))
  r.clock.now = r.files.due('s1')!
  await beat(r)
  let walks = 0
  for (let second = 0; second < 60; second++) {
    r.clock.now += 1_000
    fs.appendFileSync(path.join(r.dir(), 'app.log'), `${second}\n`)
    if (r.clock.now >= r.files.due('s1')!) {
      walks++
      await beat(r)
      say(r)
    }
  }
  assert.ok(walks <= 3, `${walks} walks of the whole folder in one idle minute`)
  // Scanned at its idle pace; a second later the census sees a kernel of it computing: the busy pace counts from that scan.
  r.clock.now = r.files.due('s1')!
  await beat(r)
  const scanned = r.clock.now
  assert.equal(r.files.due('s1'), scanned + CLASS_SCAN_IDLE_MS)
  r.clock.now += 1_000
  r.busy.at = r.clock.now
  assert.equal(r.files.due('s1'), scanned + CLASS_SCAN_BUSY_MS, 'the idle pace set at the last scan still holds')
})

test('a walk lets the event loop turn between its slices: the tunnel\'s frames of every class go between them', async () => {
  const r = rig()
  await answer(r, block({ pushes: [begin()] }))
  for (let i = 0; i < 600; i++) fs.writeFileSync(path.join(r.dir(), `f${i}.csv`), String(i))
  await answer(r, block({ scan: [{ sessionId: 's1' }] }))
  say(r)
  // Every file booked: the next scan reads stats only, and nothing in it waits on the disk.
  let turns = 0
  let counting = true
  const count = (): void => {
    turns++
    if (counting) setImmediate(count)
  }
  setImmediate(count)
  await answer(r, block({ scan: [{ sessionId: 's1' }] }))
  counting = false
  assert.ok(turns > 0, 'a walk of 600 entries held the loop from end to end')
})

test('byte counts a kernel controls are kept within what home\'s parser takes: a forged RECORD and files of holes leave a sync home reads', async () => {
  const r = rig()
  await answer(r, block({ pushes: [begin()], caps: { machineFileMb: 1, roomMb: 1 } }))
  const meta = path.join(r.dir(), 'x-1.0.dist-info')
  fs.mkdirSync(meta)
  fs.writeFileSync(path.join(meta, 'RECORD'), Array.from({ length: 10 }, (_, i) => `x-1.0.dist-info/f${i},sha256=x,999999999999999`).join('\n'))
  // Files of holes, each the most ext4 holds: no disk used, and their lengths past Number.MAX_SAFE_INTEGER together.
  for (let i = 0; i < 520; i++) {
    const hole = path.join(r.dir(), `hole${i}.bin`)
    fs.writeFileSync(hole, '')
    fs.truncateSync(hole, 2 ** 44 - 4096)
  }
  await answer(r, block({ scan: [{ sessionId: 's1' }], caps: { machineFileMb: 1, roomMb: 1 } }))
  const reports = build(r)
  const lag = r.files.lag('s1') as RemoteFilesLag
  assert.equal(lag.heldOnly, 521)
  parseRemoteKernelsRequest({ placements: [{ key: 's1:room', gen: 1, phase: 'starting', files: lag }], reports, epochs: [], readings: [], tunnel: 'up', classes: FACTS })
  assert.equal(reports[0]!.skipped.find((entry) => entry.path === 'x-1.0.dist-info')!.bytes, Number.MAX_SAFE_INTEGER)
})

test('what a crash of an earlier life left mid-write in the copy is swept at its first walk of the next life', async () => {
  const r = rig()
  await answer(r, block({ pushes: [push(1, { full: true, put: [put('d/a.csv', 'a')] })] }))
  r.files.stop()
  fs.writeFileSync(path.join(r.dir(), '.colloq.saving-0123456789ab'), 'half of a file')
  fs.writeFileSync(path.join(r.dir(), 'd', '.colloq.saving-ba9876543210'), 'half of another')
  fs.writeFileSync(path.join(r.dir(), '.kernel-cache'), 'the kernel\'s own hidden file')
  const next = rig(r.layout)
  next.files.load()
  await answer(next, block({ scan: [{ sessionId: 's1' }] }))
  assert.deepEqual(fs.readdirSync(r.dir()).sort(), ['.kernel-cache', 'd'])
  assert.deepEqual(fs.readdirSync(path.join(r.dir(), 'd')), ['a.csv'])
})

/* ------------------------------------------------------- what travels home */

test('a pull sends the version the report named, copied to the agent\'s own staging and hashed as it was copied: a write after the copy never travels', async () => {
  const r = rig()
  await answer(r, block({ pushes: [begin()] }))
  const file = path.join(r.dir(), 'data.bin')
  const first = randomBytes(CLASS_INLINE_BYTES * 2)
  fs.writeFileSync(file, first)
  await answer(r, block({ scan: [{ sessionId: 's1' }] }))
  const [report] = say(r)
  assert.deepEqual(changedOf(report), [{ path: 'data.bin', sha256: sha(first), base: null }])
  assert.equal(report!.changed[0]!.inline, undefined, 'a file past the inline cap rode inline')
  // The kernel writes again while the PUT is under way: what goes is what was copied and hashed.
  r.before = () => fs.writeFileSync(file, randomBytes(100))
  await answer(r, block({ pulls: [{ sessionId: 's1', gen: 1, paths: [{ path: 'data.bin', sha256: sha(first) }] }] }))
  assert.equal(r.uploads.length, 1)
  const [{ upload, body }] = r.uploads as [{ upload: RoomUpload; body: Buffer }]
  assert.deepEqual([upload.sessionId, upload.gen, upload.path, upload.sha256, upload.bytes], ['s1', 1, 'data.bin', sha(first), first.length])
  assert.ok(body.equals(first))
  assert.deepEqual(fs.readdirSync(`${r.dir()}.staging`), [], 'a staged copy outlived its upload')
  // Asked again for the first version, long after: it is not here any more, and nothing goes.
  r.clock.now += ROOM_FILE_TIMINGS.verdictMs
  await answer(r, block({ pulls: [{ sessionId: 's1', gen: 1, paths: [{ path: 'data.bin', sha256: sha(first) }] }] }))
  assert.equal(r.uploads.length, 1)
})

test('a version gone before its PUT is waited on no more: a rewrite is said in its place, a new file removed is said removed as it was said, and home\'s repeated pulls send nothing', async () => {
  const r = rig()
  await answer(r, block({ pushes: [begin()] }))
  const results = path.join(r.dir(), 'results.csv')
  const scratch = path.join(r.dir(), 'scratch.bin')
  const x1 = randomBytes(CLASS_INLINE_BYTES * 2)
  const t1 = randomBytes(CLASS_INLINE_BYTES * 2)
  fs.writeFileSync(results, x1)
  fs.writeFileSync(scratch, t1)
  await answer(r, block({ scan: [{ sessionId: 's1' }] }))
  assert.deepEqual(say(r)[0]!.changed.map((entry) => entry.path).sort(), ['results.csv', 'scratch.bin'])
  // The next epoch rewrites one and deletes the other before home's pulls come; home repeats its pulls in every reply.
  const x2 = randomBytes(CLASS_INLINE_BYTES * 2)
  fs.writeFileSync(results, x2)
  fs.rmSync(scratch)
  const pulls = block({ pulls: [{ sessionId: 's1', gen: 1, paths: [{ path: 'results.csv', sha256: sha(x1) }, { path: 'scratch.bin', sha256: sha(t1) }] }] })
  await answer(r, pulls)
  // The removal goes at once; while the newer version waits out its quiet time, nothing of the old one is said again.
  const [meanwhile] = say(r)
  assert.deepEqual(meanwhile?.removed, [{ path: 'scratch.bin', base: sha(t1) }], 'home was never told the file it pulls is gone')
  assert.deepEqual(changedOf(meanwhile), [], 'the version that is gone was said again')
  r.clock.now += 10_000
  await answer(r, pulls)
  await beat(r)
  const [next] = say(r)
  assert.equal(r.uploads.length, 0)
  assert.deepEqual(changedOf(next), [{ path: 'results.csv', sha256: sha(x2), base: null }], 'the newer version waited for the old one\'s pull for good')
})

test('an upload cut short lets go of its staged copy at once: no descriptor of it stays open', async () => {
  const r = rig()
  await answer(r, block({ pushes: [begin()] }))
  const body = randomBytes(MIB)
  fs.writeFileSync(path.join(r.dir(), 'big.bin'), body)
  await answer(r, block({ scan: [{ sessionId: 's1' }] }))
  say(r)
  // Home takes one piece, then reads no more until the upload is given up (here the class leaves the machine).
  let reading!: () => void
  const read = new Promise<void>((resolve) => (reading = resolve))
  r.door = async (upload) => {
    await upload.body.getReader().read()
    reading()
    await new Promise((resolve) => upload.signal.addEventListener('abort', resolve, { once: true }))
    return { kind: 'transient', reason: 'cancelled', retryAfterMs: null }
  }
  const before = openFds()
  r.files.reconcile(block({ pulls: [{ sessionId: 's1', gen: 1, paths: [{ path: 'big.bin', sha256: sha(body) }] }] }))
  await read
  r.files.reconcile(block({}, []))
  await r.files.idle()
  await waitFor(() => openFds() <= before, 'the staged copy\'s descriptor closed')
})

test('a pull through a hiccup is sent again after its wait; a refusal is home\'s word and ends it', async () => {
  const r = rig()
  await answer(r, block({ pushes: [begin()] }))
  const body = randomBytes(CLASS_INLINE_BYTES + 1)
  fs.writeFileSync(path.join(r.dir(), 'a.bin'), body)
  fs.writeFileSync(path.join(r.dir(), 'b.bin'), Buffer.concat([body, body]))
  await answer(r, block({ scan: [{ sessionId: 's1' }] }))
  const [report] = say(r)
  const shaOf = (at: string) => report!.changed.find((entry) => entry.path === at)!.sha256
  const answers: RoomUploadAnswer[] = [{ kind: 'transient', reason: 'home answered 503', retryAfterMs: 2_000 }, { kind: 'ok' }]
  r.answer = (upload) => (upload.path === 'a.bin' ? answers.shift()! : { kind: 'refused', status: 409, error: 'revoked', detail: 'an older gen' })
  await answer(r, block({ pulls: [{ sessionId: 's1', gen: 1, paths: [{ path: 'a.bin', sha256: shaOf('a.bin') }, { path: 'b.bin', sha256: shaOf('b.bin') }] }] }))
  assert.deepEqual(r.uploads.map(({ upload }) => upload.path).sort(), ['a.bin', 'b.bin'])
  // Not before its wait.
  await beat(r)
  assert.equal(r.uploads.length, 2)
  r.clock.now += 30_000
  await beat(r)
  assert.deepEqual(r.uploads.map(({ upload }) => upload.path).sort(), ['a.bin', 'a.bin', 'b.bin'], 'the refused one was sent again, or the hiccup was not')
  r.clock.now += 30_000
  await beat(r)
  assert.equal(r.uploads.length, 3)
})

test('a link is never followed and never travels — one planted to the agent\'s own files, a linked folder, a push over a link — and a hard link travels as its content', async () => {
  const r = rig()
  await answer(r, block({ pushes: [begin()] }))
  const secret = path.join(r.layout.root, 'runner.json')
  fs.writeFileSync(secret, '{"secret":"the machine\'s"}')
  const outside = path.join(r.layout.root, 'elsewhere')
  fs.mkdirSync(outside)
  fs.writeFileSync(path.join(outside, 'inside.csv'), 'not the class\'s')
  fs.symlinkSync(secret, path.join(r.dir(), 'x.csv'))
  fs.symlinkSync(outside, path.join(r.dir(), 'data'))
  fs.writeFileSync(path.join(r.dir(), 'orig.txt'), 'shared')
  fs.linkSync(path.join(r.dir(), 'orig.txt'), path.join(r.dir(), 'hard.txt'))
  await answer(r, block({ scan: [{ sessionId: 's1' }] }))
  const [report] = say(r)
  assert.deepEqual(changedOf(report).sort((a, b) => a.path.localeCompare(b.path)), [
    { path: 'hard.txt', sha256: sha('shared'), base: null }, { path: 'orig.txt', sha256: sha('shared'), base: null },
  ])
  assert.deepEqual([...report!.skipped, ...(report!.released ?? [])], [])
  // Home asks for the link by the secret's hash: nothing goes.
  await answer(r, block({ pulls: [{ sessionId: 's1', gen: 1, paths: [{ path: 'x.csv', sha256: sha(fs.readFileSync(secret)) }, { path: 'data/inside.csv' }] }] }))
  assert.equal(r.uploads.length, 0)
  // A push of x.csv replaces the link itself, and writes nothing through it.
  await answer(r, block({ pushes: [push(2, { put: [put('x.csv', 'home\'s'), put('data/new.csv', 'home\'s too')] })] }))
  assert.ok(fs.lstatSync(path.join(r.dir(), 'x.csv')).isFile())
  assert.equal(fs.readFileSync(path.join(r.dir(), 'x.csv'), 'utf8'), 'home\'s')
  assert.equal(fs.readFileSync(secret, 'utf8'), '{"secret":"the machine\'s"}')
  assert.ok(fs.lstatSync(path.join(r.dir(), 'data')).isDirectory(), 'the linked folder was written through')
  assert.deepEqual(fs.readdirSync(outside), ['inside.csv'])
})

test('a change goes out once and waits for its verdict; a refused one is not said again while it stays, and home\'s next push overwrites it; one never answered is said again after a minute', async () => {
  const r = rig()
  await answer(r, block({ pushes: [begin()] }))
  fs.writeFileSync(path.join(r.dir(), 'Тетрадь.ipynb'), '{"cells":[]}')
  await answer(r, block({ scan: [{ sessionId: 's1' }] }))
  const [first] = say(r)
  await answer(r, block({ scan: [{ sessionId: 's1' }] }))
  assert.deepEqual(say(r), [], 'a change in flight was said twice')
  // A notebook file is home's: refused, and not said again while the machine holds the same.
  await answer(r, block({ verdicts: [{ sessionId: 's1', seq: first!.seq, accepted: [], refused: [{ path: 'Тетрадь.ipynb', why: 'book' }] }], scan: [{ sessionId: 's1' }] }))
  assert.deepEqual(say(r), [])
  // Re-projected by home: its push overwrites the refused version.
  await answer(r, block({ pushes: [push(2, { put: [put('Тетрадь.ipynb', '{"cells":[1]}')] })] }))
  assert.equal(fs.readFileSync(path.join(r.dir(), 'Тетрадь.ipynb'), 'utf8'), '{"cells":[1]}')
  // A change whose verdict never comes (a reply lost): said again once a minute has passed, with a seq of its own.
  fs.writeFileSync(path.join(r.dir(), 'b.csv'), 'b')
  await answer(r, block({ scan: [{ sessionId: 's1' }] }))
  const [b] = say(r)
  r.clock.now += ROOM_FILE_TIMINGS.verdictMs
  await answer(r, block({ scan: [{ sessionId: 's1' }] }))
  const [again] = say(r)
  assert.deepEqual(changedOf(again), changedOf(b))
  assert.ok(again!.seq > b!.seq)
  // Accepted: into the baseline, and nothing more to say.
  await answer(r, block({ verdicts: [{ sessionId: 's1', seq: again!.seq, accepted: ['b.csv'], refused: [] }], scan: [{ sessionId: 's1' }] }))
  assert.deepEqual(say(r), [])
  const written = JSON.parse(fs.readFileSync(roomBaselineFile(r.layout, 's1'), 'utf8')) as { files: unknown[][] }
  assert.ok(written.files.some(([at, base]) => at === 'b.csv' && base === sha('b')))
})

test('class bulk is paced smoothly both ways: an upload at the reply\'s rate and a pushed blob down the cache\'s stream, through a bucket of CLASS_PACE_BURST_BYTES', async () => {
  // The bucket itself: a burst at once, then the rate, never a second's worth at a time.
  const clock = { now: 0 }
  const pacer = new Pacer(() => clock.now, CLASS_PACE_BURST_BYTES)
  const rate = MIB
  assert.equal(pacer.delay(CLASS_PACE_BURST_BYTES, rate), 0)
  const waits = Array.from({ length: 16 }, () => pacer.delay(64 * 1024, rate))
  assert.deepEqual(new Set(waits.map((wait, i) => wait - (i > 0 ? waits[i - 1]! : 0))).size <= 2, true)
  assert.ok(Math.abs(waits.at(-1)! - 1000) <= 2, `16 × 64 KiB past the burst at 1 MiB/s: ${waits.at(-1)} ms`)

  // Up: a file at 1 MiB/s.
  const r = rig()
  await answer(r, block({ pushes: [begin()], rates: { classBulkMBps: 1, machinePaceMBps: 6 } }))
  const body = randomBytes(3 * MIB)
  fs.writeFileSync(path.join(r.dir(), 'big.bin'), body)
  await answer(r, block({ scan: [{ sessionId: 's1' }], rates: { classBulkMBps: 1, machinePaceMBps: 6 } }))
  say(r)
  await answer(r, block({ pulls: [{ sessionId: 's1', gen: 1, paths: [{ path: 'big.bin', sha256: sha(body) }] }], rates: { classBulkMBps: 1, machinePaceMBps: 6 } }))
  assert.ok(r.uploads[0]!.body.equals(body))
  const slept = r.waits.reduce((sum, wait) => sum + wait, 0)
  const expected = ((zlib.gzipSync(body).length - CLASS_PACE_BURST_BYTES) / MIB) * 1000
  assert.ok(Math.abs(slept - expected) <= expected * 0.1, `paced ${slept} ms, expected about ${Math.round(expected)}`)
  assert.ok(Math.max(...r.waits) < 100, `a wait of ${Math.max(...r.waits)} ms: a burst, not a pace`)

  // Down: a class's blob at its pace, through the agent's cache and its one stream.
  const blob = randomBytes(MIB)
  const downs: number[] = []
  const now = { at: 0 }
  const cache = new Cache({
    client: {
      blob: async () => ({
        kind: 'ok' as const, status: 200 as const, headers: new Headers(),
        body: new ReadableStream<Uint8Array>({
          start(controller) {
            for (let at = 0; at < blob.length; at += 64 * 1024) controller.enqueue(new Uint8Array(blob.subarray(at, at + 64 * 1024)))
            controller.close()
          },
        }),
      }),
    },
    books: path.join(r.layout.root, 'books'),
    now: () => now.at,
    sleep: async (ms) => {
      downs.push(ms)
      now.at += ms
    },
  })
  cache.load()
  const file = await cache.blob(sha(blob), blob.length, { pace: () => 512 * 1024 })
  assert.ok(fs.readFileSync(file).equals(blob))
  const down = downs.reduce((sum, wait) => sum + wait, 0)
  assert.ok(Math.abs(down - 1500) <= 20, `1 MiB at 512 KiB/s past a 256 KiB burst: ${down} ms`)
  // Copied into its folder, it leaves the CAS: nothing else here names it.
  cache.release(sha(blob))
  assert.ok(!fs.existsSync(file))
  cache.stop()
})

test('one blob stream, what waits most goes first: a class\'s file a run waits on ahead of a lease\'s blob under way, a lease\'s ahead of a class\'s file nobody waits on yet, each stopped one resumed with a Range', async () => {
  const home = await fakeHome()
  const client = new RemoteClient({ home: home.url, build: 'dev', credential: () => null })
  // A held stream is never given up as stalled here: only a job that ranks above it gets past it.
  const cache = new Cache({ client, books: fs.mkdtempSync(path.join(TEST_ROOT, 'books-')), backoff: new Backoff(() => 0, 5, 20), idleMs: 600_000, log: () => undefined })
  cache.load()
  const body = (what: string): Buffer => Buffer.from(`${what} ${randomBytes(8).toString('hex')}\n`.repeat(200))
  const held = new Map<string, () => void>()
  /** Half of the blob, then nothing until the test lets it go: a slow link. */
  const hold = (blob: Buffer): void => {
    const until = new Promise<void>((resolve) => held.set(sha256(blob), resolve))
    let first = true
    const before = home.onBlob
    home.onBlob = (call) => {
      if (call.sha !== sha256(blob) || !first) return before ? before(call) : serveBlob(home.blobs.get(call.sha), call.range)
      first = false
      return { status: 200, slow: { pieces: [blob.subarray(0, 2000)], gapMs: 5, until }, headers: { 'Content-Type': 'application/octet-stream' } }
    }
  }
  const ranges = (blob: Buffer): string[] => home.calls.filter((call) => call.path.endsWith(sha256(blob))).map((call) => call.headers.range ?? 'all')
  const partOf = (blob: Buffer): string => path.join(cache.blobsDir, `.${sha256(blob)}.part`)
  const done: string[] = []
  const fetched = (what: string, file: Promise<string>): Promise<string> => file.then((found) => (done.push(what), found))
  try {
    const lease = body('lease')
    const pushed = body('a class file a run waits on')
    for (const blob of [lease, pushed]) home.blobs.set(sha256(blob), blob)
    hold(lease)
    const leaseFile = fetched('lease', cache.blob(sha256(lease), lease.length))
    await waitFor(() => fs.existsSync(partOf(lease)) && fs.statSync(partOf(lease)).size === 2000, 'the lease\'s blob under way')
    const pushedFile = fetched('pushed', cache.blob(sha256(pushed), pushed.length, { pace: () => 1e12, urgent: () => true }))
    // The lease's first request is held still: only a lease's blob stopped for the class's lets the class's through.
    await waitFor(() => done.length > 0, 'the class file a run waits on, ahead of the lease\'s blob under way')
    assert.ok(fs.readFileSync(await pushedFile).equals(pushed))
    assert.ok(fs.readFileSync(await leaseFile).equals(lease))
    assert.deepEqual(done, ['pushed', 'lease'])
    assert.deepEqual(ranges(lease), ['all', 'bytes=2000-'])

    const eager = body('a class file nobody waits on')
    const another = body('another lease')
    for (const blob of [eager, another]) home.blobs.set(sha256(blob), blob)
    hold(eager)
    done.length = 0
    const eagerFile = fetched('eager', cache.blob(sha256(eager), eager.length, { pace: () => 1e12, urgent: () => false }))
    await waitFor(() => fs.existsSync(partOf(eager)) && fs.statSync(partOf(eager)).size === 2000, 'the class\'s file under way')
    const anotherFile = fetched('another', cache.blob(sha256(another), another.length))
    await waitFor(() => done.length > 0, 'the lease\'s blob, ahead of a class file nobody waits on under way')
    assert.ok(fs.readFileSync(await anotherFile).equals(another))
    assert.ok(fs.readFileSync(await eagerFile).equals(eager))
    assert.deepEqual(done, ['another', 'eager'])
    assert.deepEqual(ranges(eager), ['all', 'bytes=2000-'])
  } finally {
    for (const release of held.values()) release()
    cache.stop()
    await home.close()
  }
})

/* --------------------------------------------------------------- fences */

test('a copy home no longer names is fenced: once its containers are gone, the paths changed since home last agreed are said late, then the copy goes', async () => {
  const r = rig()
  await answer(r, block({ pushes: [push(1, { full: true, put: [put('a.csv', 'v1'), put('b.csv', 'b')] })] }))
  fs.writeFileSync(path.join(r.dir(), 'a.csv'), 'v2 after the fence')
  fs.writeFileSync(path.join(r.dir(), 'new.csv'), 'n')
  fs.writeFileSync(path.join(r.dir(), 'big.bin'), randomBytes(CLASS_INLINE_BYTES * 2))
  await answer(r, block({ scan: [{ sessionId: 's1' }] }))
  const [before] = say(r)
  assert.ok(before!.changed.some((entry) => entry.path === 'big.bin'))
  // Home failed the class over: its reply names it no more, while its container is still being removed here.
  r.held.set('s1', [{ role: 'room', gen: 1 }])
  await answer(r, block({ pulls: [{ sessionId: 's1', gen: 1, paths: [{ path: 'big.bin', sha256: before!.changed.find((entry) => entry.path === 'big.bin')!.sha256 }] }] }, []))
  assert.equal(r.uploads.length, 0, 'a fenced copy sent a file home')
  assert.deepEqual(say(r), [], 'the late list went while its kernel could still write')
  assert.equal(r.files.lag('s1'), null)
  r.clock.now += 1_000
  await beat(r)
  assert.deepEqual(say(r), [], 'the late list went while its kernel could still write')
  r.held.delete('s1')
  r.clock.now += 1_000
  await beat(r)
  const [late] = say(r)
  assert.deepEqual(late, { sessionId: 's1', gen: 1, seq: late!.seq, changed: [], removed: [], skipped: [], late: ['a.csv', 'big.bin', 'new.csv'] })
  assert.ok(fs.existsSync(r.dir()), 'the copy went before home answered the sync that said its late list')
  // Home's answer to that sync, which held no container of the class, names it nowhere: home keeps no copy of it here.
  await answer(r, block({}, []))
  assert.ok(!fs.existsSync(r.dir()) && !fs.existsSync(roomBaselineFile(r.layout, 's1')), 'the fenced copy stayed')
  assert.deepEqual(say(r), [])
})

test('one copy serves the class here: home naming it only at other gens keeps it, files and all, with no ack until home\'s next push lands; a copy fenced and named again before it goes stays too', async () => {
  const r = rig()
  await answer(r, block({ pushes: [push(1, { full: true, put: [put('data.csv', 'id,x\n1,2\n')] })] }, [intent('s1:room', 3)]))
  // The room moves to the server while a student's personal kernel of the class is placed here, in one reply: home keeps its copy.
  r.held.set('s1', [{ role: 'room', gen: 3 }, { role: 'own', gen: 1 }])
  await answer(r, block({}, [intent('s1:own', 1)]))
  r.held.set('s1', [{ role: 'own', gen: 1 }])
  for (let i = 0; i < 3; i++) {
    r.clock.now += 1_000
    await beat(r)
    say(r)
  }
  assert.equal(fs.readFileSync(path.join(r.dir(), 'data.csv'), 'utf8'), 'id,x\n1,2\n', 'the folder was emptied under a kernel home thinks has every file')
  // Whether home's copy is the one this one agreed with, home's next push says: no ack meanwhile, then that push's.
  assert.equal(r.files.lag('s1'), null)
  await answer(r, block({ pushes: [push(2, { put: [put('b.csv', 'b')] })] }, [intent('s1:own', 1)]))
  assert.deepEqual(r.files.lag('s1'), { pushSeq: 2, pending: 0, pendingBytes: 0, heldOnly: 0, heldOnlyBytes: 0 })
  // Stopped, its container gone, then placed again at the next gen before the copy went (the new gen supersedes the stop).
  await answer(r, block({}, []))
  r.held.delete('s1')
  r.clock.now += 1_000
  await beat(r)
  say(r)
  await answer(r, block({}, [intent('s1:own', 2)]))
  r.clock.now += 1_000
  await beat(r)
  say(r)
  assert.deepEqual(fs.readdirSync(r.dir()).sort(), ['b.csv', 'data.csv'], 'the copy went under a placement home serves from the same copy')
  assert.equal(r.files.lag('s1'), null, 'an ack was said for a copy home may have begun anew')
  assert.equal((JSON.parse(fs.readFileSync(roomBaselineFile(r.layout, 's1'), 'utf8')) as { doubt?: boolean }).doubt, true)
})

test('a copy found with no baseline, home naming it nowhere, goes without a late list: home agreed nothing with it', async () => {
  const layout = stateLayout(fs.mkdtempSync(path.join(TEST_ROOT, 'room-files-')))
  fs.mkdirSync(roomFolder(layout, 's1'), { recursive: true })
  fs.writeFileSync(path.join(roomFolder(layout, 's1'), 'left.csv'), 'a copy a container wrote into before any push')
  const r = rig(layout)
  r.files.load()
  await answer(r, block({}, [intent('s2:room')]))
  r.clock.now += 1_000
  await beat(r)
  assert.deepEqual(say(r).filter((report) => report.sessionId === 's1'), [])
  await answer(r, block({}, [intent('s2:room')]))
  assert.ok(!fs.existsSync(roomFolder(layout, 's1')), 'a copy with no gen to say its late list under stayed for good')
})

/* ----------------------------------------------------------- full walks */

test('a full report goes in pages within one sync\'s budget, shared with the other classes, and nothing else of the class until its last page; a new full scan starts over', async () => {
  const r = rig()
  const both = [intent('s1:room'), intent('s2:room')]
  await answer(r, block({ pushes: [begin('s1'), begin('s2')] }, both))
  for (let i = 0; i < 1500; i++) fs.writeFileSync(path.join(r.dir('s1'), `f${String(i).padStart(4, '0')}.csv`), String(i))
  for (let i = 0; i < 10; i++) fs.writeFileSync(path.join(r.dir('s2'), `g${i}.csv`), String(i))
  await answer(r, block({ scan: [{ sessionId: 's1', full: true }, { sessionId: 's2' }] }, both))
  const first = say(r)
  const s1 = first.find((report) => report.sessionId === 's1')!
  const s2 = first.find((report) => report.sessionId === 's2')!
  assert.equal(s2.changed.length, 10)
  assert.deepEqual([s1.full, s1.page], [true, { index: 0, last: false }])
  assert.equal(s1.changed.length + s2.changed.length, REMOTE_REPORT_PATHS_MAX, 'the budget was not shared, or not used')
  // A change while the walk is paged waits for its last page.
  fs.writeFileSync(path.join(r.dir('s1'), 'meanwhile.csv'), 'm')
  await answer(r, block({ scan: [{ sessionId: 's1' }] }, both))
  const [second] = say(r)
  assert.deepEqual([second!.sessionId, second!.page, second!.changed.length], ['s1', { index: 1, last: true }, 1500 - s1.changed.length])
  assert.ok(!second!.changed.some((entry) => entry.path === 'meanwhile.csv'))
  const [third] = say(r)
  assert.deepEqual([third!.full, changedOf(third)], [undefined, [{ path: 'meanwhile.csv', sha256: sha('m'), base: null }]])
  // A new full scan asked while a walk is paged: a fresh walk, from page 0.
  await answer(r, block({ scan: [{ sessionId: 's1', full: true }] }, both))
  say(r)
  await answer(r, block({ scan: [{ sessionId: 's1', full: true }] }, both))
  assert.deepEqual(say(r).find((report) => report.sessionId === 's1')!.page, { index: 0, last: false })
  // Its next page goes in a sync the agent cuts short for news: the same page goes again under the same seq, for home to know.
  const cut = build(r).find((report) => report.sessionId === 's1')!
  r.files.reportsCut([cut])
  const again = build(r).find((report) => report.sessionId === 's1')!
  assert.deepEqual([again.page, again.seq], [cut.page, cut.seq])
})

/* ------------------------------------------------------------- the sync */

test('through the sync: a push lands in the class folder and is acked in the next sync, a kernel\'s files are reported, verdicted, and pulled home gzipped with their hash and length', async () => {
  const home = await fakeHome()
  const layout = stateLayout(fs.mkdtempSync(path.join(TEST_ROOT, 'room-files-agent-')))
  const puts: Array<{ url: URL; headers: Headers; body: Buffer }> = []
  const through: typeof fetch = async (input, init) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url)
    if (init?.method !== 'PUT' || !url.pathname.includes('/rooms/')) return fetch(input, init)
    const chunks: Buffer[] = []
    for await (const chunk of init.body as ReadableStream<Uint8Array>) chunks.push(Buffer.from(chunk))
    puts.push({ url, headers: new Headers(init.headers), body: zlib.gunzipSync(Buffer.concat(chunks)) })
    return new Response('{}', { status: 200, headers: { [REMOTE_MARKER_HEADER]: REMOTE_MARKER, 'Content-Type': 'application/json' } })
  }
  const docker = fakeAgentDocker()
  docker.registry.set(REVISION.ref, { diffIds: DIFF_IDS })
  const agent = new Agent({
    layout, join: { home: home.url, code: '0123456789abcdef0123456789abcdef' }, build: 'dev', version: '0.25.0', container: 'colloq-runner',
    image: 'ghcr.io/colloq-edu/colloq-server:0.25.0', docker, runner: new FakeSeam(), fetch: through,
    machine: () => ({ memTotalMb: 16_000, memAvailableMb: 15_000, cpus: 16, diskFreeMb: 500_000, diskTotalMb: 1_000_000 }),
    backoffMs: { min: 5, max: 20 }, stopMs: 2_000, log: () => undefined,
    tunnel: () => ({ want: () => undefined, state: () => ({ up: false, rttMs: null, since: 0 }), close: async () => undefined }),
    classes: { probe: async () => true, timings: { censusMs: 3_600_000 } },
  })
  const first = push(1, { full: true, put: [put('data.csv', 'id,x\n1,2\n')] })
  const big = randomBytes(CLASS_INLINE_BYTES + 100)
  let ask = false
  let answers: Pick<RemoteKernelsReply, 'verdicts' | 'pulls'> = { verdicts: [], pulls: [] }
  home.onSync = (body) => {
    const acked = (body.kernels?.placements.find((held) => held.key === 's1:room')?.files?.pushSeq ?? 0) >= 1
    for (const report of body.kernels?.reports ?? []) {
      answers = {
        verdicts: [{ sessionId: 's1', seq: report.seq, accepted: report.changed.filter((entry) => entry.inline !== undefined).map((entry) => entry.path), refused: [] }],
        pulls: [{ sessionId: 's1', gen: 1, paths: report.changed.filter((entry) => entry.inline === undefined).map((entry) => ({ path: entry.path, sha256: entry.sha256 })) }],
      }
    }
    const scan = ask ? [{ sessionId: 's1' }] : []
    ask = false
    const kernels = block({ pushes: acked ? [] : [first], scan, ...answers })
    answers = { verdicts: [], pulls: [] }
    return { json: syncReply({ want: { revisions: [{ id: REVISION.id, ref: REVISION.ref, layers: LAYERS, gpu: false }], data: [], bundles: [] }, kernels }), delayMs: 20 }
  }
  const running = agent.run()
  try {
    await waitFor(() => home.syncs().some((sync) => sync.kernels?.placements.some((held) => held.files?.pushSeq === 1)), 'the push acked')
    const dir = roomFolder(layout, 's1')
    assert.equal(fs.readFileSync(path.join(dir, 'data.csv'), 'utf8'), 'id,x\n1,2\n')
    // The cell wrote two files and ended: home asks for a scan.
    fs.writeFileSync(path.join(dir, 'out.csv'), 'a\n')
    fs.writeFileSync(path.join(dir, 'big.bin'), big)
    ask = true
    const reported = await waitFor(() => home.syncs().find((sync) => sync.kernels?.reports.some((report) => report.changed.length === 2)), 'the report')
    const report = reported.kernels!.reports[0]!
    assert.deepEqual(report.changed.map(({ path: at, base, inline }) => [at, base, inline !== undefined]).sort(), [['big.bin', null, false], ['out.csv', null, true]])
    await waitFor(() => puts.length === 1, 'the pull PUT home')
    const [sent] = puts as [{ url: URL; headers: Headers; body: Buffer }]
    assert.equal(sent.url.pathname, '/api/runners/v1/rooms/s1/files')
    assert.deepEqual([sent.url.searchParams.get('path'), sent.url.searchParams.get('gen')], ['big.bin', '1'])
    assert.deepEqual([sent.headers.get('content-encoding'), sent.headers.get('x-colloq-sha256'), sent.headers.get('x-colloq-bytes')], ['gzip', sha(big), String(big.length)])
    assert.match(sent.headers.get('authorization') ?? '', /^Bearer cr1\./)
    assert.ok(sent.body.equals(big))
    // out.csv was accepted: what is left pending is the pulled file, until its own verdict.
    await waitFor(() => home.syncs().at(-1)?.kernels?.placements.find((held) => held.key === 's1:room')?.files?.pending === 1, 'out.csv agreed')
  } finally {
    await agent.stop()
    await running
    await home.close()
  }
})

test('through the sync: a sync the agent cuts short for news counts as said, and the conflict it carried is not said again — home would keep a second copy', async () => {
  const home = await fakeHome()
  const layout = stateLayout(fs.mkdtempSync(path.join(TEST_ROOT, 'room-files-cut-')))
  const docker = fakeAgentDocker()
  docker.registry.set(REVISION.ref, { diffIds: DIFF_IDS })
  const agent = new Agent({
    layout, join: { home: home.url, code: '0123456789abcdef0123456789abcdef' }, build: 'dev', version: '0.25.0', container: 'colloq-runner',
    image: 'ghcr.io/colloq-edu/colloq-server:0.25.0', docker, runner: new FakeSeam(),
    machine: () => ({ memTotalMb: 16_000, memAvailableMb: 15_000, cpus: 16, diskFreeMb: 500_000, diskTotalMb: 1_000_000 }),
    backoffMs: { min: 5, max: 20 }, stopMs: 2_000, log: () => undefined,
    tunnel: () => ({ want: () => undefined, state: () => ({ up: false, rttMs: null, since: 0 }), close: async () => undefined }),
    classes: { probe: async () => true, timings: { censusMs: 3_600_000 } },
    // The class's own scans often and with no quiet time: the news that cuts the held sync short comes from one of them. A
    // report a cut took before home heard it is said again soon (it is a minute in production): only what home heard counts.
    files: { beatMs: 20, busyMs: 50, idleMs: 50, quietMs: 0, verdictMs: 2_000 },
  })
  const dir = roomFolder(layout, 's1')
  const pushes = [push(1, { full: true, put: [put('u.py', 'v1')] }), push(2, { put: [put('u.py', 'home')] })]
  let kernelWrote = false
  let saidU = 0
  let saidNew = false
  // Home keeps the machine's u.py as its conflict copy, and says so in every reply from the one after it heard it.
  const verdicts: RemoteKernelsReply['verdicts'] = []
  home.onSync = (body) => {
    const acked = body.kernels?.placements.find((held) => held.key === 's1:room')?.files?.pushSeq ?? 0
    // The kernel rewrites u.py as home's push of its own version is on its way.
    if (acked >= 1 && !kernelWrote) {
      kernelWrote = true
      fs.writeFileSync(path.join(dir, 'u.py'), 'machine')
    }
    const answered = verdicts.slice()
    for (const report of body.kernels?.reports ?? []) {
      if (report.changed.some((entry) => entry.path === 'u.py')) verdicts.push({ sessionId: 's1', seq: report.seq, accepted: [], refused: [{ path: 'u.py', why: 'base', copy: 'u (с машины 14-32).py' }] })
    }
    const said = (body.kernels?.reports ?? []).flatMap((report) => report.changed.map((entry) => entry.path))
    if (said.includes('n.csv')) saidNew = true
    let delayMs = 20
    if (said.includes('u.py') && ++saidU === 1) {
      // Nothing to answer yet: home holds the sync. A cell writes a new file meanwhile, and the agent's own scan finds it.
      fs.writeFileSync(path.join(dir, 'n.csv'), 'new')
      delayMs = 60_000
    }
    const kernels = block({ pushes: pushes.filter((one) => one.seq > acked).slice(0, 1), verdicts: answered })
    return { json: syncReply({ want: { revisions: [{ id: REVISION.id, ref: REVISION.ref, layers: LAYERS, gpu: false }], data: [], bundles: [] }, kernels }), delayMs }
  }
  const running = agent.run()
  try {
    await waitFor(() => saidNew, 'the new file said in the sync after the one cut short')
    assert.equal(saidU, 1, 'u.py was said again after the sync that carried it was cut short')
  } finally {
    await agent.stop()
    await running
    await home.close()
  }
})

test('through the sync: a file report home\'s parser would refuse goes nowhere, and the machine\'s block goes without it — never refused whole, with every class on the machine', async () => {
  const home = await fakeHome()
  const layout = stateLayout(fs.mkdtempSync(path.join(TEST_ROOT, 'room-files-strict-')))
  const docker = fakeAgentDocker()
  docker.registry.set(REVISION.ref, { diffIds: DIFF_IDS })
  const logs: string[] = []
  const agent = new Agent({
    layout, join: { home: home.url, code: '0123456789abcdef0123456789abcdef' }, build: 'dev', version: '0.25.0', container: 'colloq-runner',
    image: 'ghcr.io/colloq-edu/colloq-server:0.25.0', docker, runner: new FakeSeam(),
    machine: () => ({ memTotalMb: 16_000, memAvailableMb: 15_000, cpus: 16, diskFreeMb: 500_000, diskTotalMb: 1_000_000 }),
    backoffMs: { min: 5, max: 20 }, stopMs: 2_000, log: (line) => logs.push(line),
    tunnel: () => ({ want: () => undefined, state: () => ({ up: false, rttMs: null, since: 0 }), close: async () => undefined }),
    classes: { probe: async () => true, timings: { censusMs: 3_600_000 } },
  })
  home.onSync = () => ({ json: syncReply({ want: { revisions: [{ id: REVISION.id, ref: REVISION.ref, layers: LAYERS, gpu: false }], data: [], bundles: [] }, kernels: block({ pushes: [begin()] }) }), delayMs: 20 })
  // A report no parser of home's takes (a length below zero): whatever bug of the agent's, or kernel's doing, made it.
  const reportsNow = RoomFiles.prototype.reportsNow
  RoomFiles.prototype.reportsNow = function (): RemoteFilesReport[] {
    reportsNow.call(this)
    return [{ sessionId: 's1', gen: 1, seq: 1, changed: [{ path: 'x.csv', sha256: sha('x'), bytes: -1, base: null }], removed: [], skipped: [] }]
  }
  const running = agent.run()
  try {
    await waitFor(() => home.syncs().filter((sync) => sync.kernels?.placements.some((held) => held.key === 's1:room')).length >= 3, 'syncs that hold the class')
    assert.deepEqual(home.violations, [], 'home refused a sync whole for one report')
    assert.ok(home.syncs().every((sync) => !sync.kernels || sync.kernels.reports.length === 0))
    assert.equal(logs.filter((line) => line.includes('would not pass home\'s parser')).length, 1)
  } finally {
    RoomFiles.prototype.reportsNow = reportsNow
    await agent.stop()
    await running
    await home.close()
  }
})
