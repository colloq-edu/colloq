/**
 * A machine's agent against a home, both in this process: the join, the
 * sync, a lease from its offer to home's last word on it (server/src/
 * runner-agent/sync.ts), with no Docker and no network beyond the loopback.
 *
 * What is held here is what a class would lose: a lease listed before it is
 * written down is a run home counts on that the next life knows nothing of; a
 * decline after a container started is a participant's attempt spent; a run
 * home revoked that keeps uploading is a result applied twice; a transient
 * answer taken for a refusal is a finished run thrown away when the relay
 * restarts; a join whose reply was lost and that is sent as another join is
 * one more machine counted against the owner's code.
 */
import './_env.mts'
import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { REMOTE_CONTAINER_CUSHION_MB, REMOTE_HOST_RESERVE_MB, type RemoteHeldAttempt, type RemoteLease, type RemoteSyncRequest } from '../shared/remote-runner.ts'
import { Agent, type AgentOptions } from '../server/src/runner-agent/sync.ts'
import { readIdentity, stateLayout } from '../server/src/runner-agent/state.ts'
import { competitionsDir } from '../server/src/competitions/storage.ts'
import { TEST_ROOT } from './_env.mts'
import {
  DIFF_IDS, FakeSeam, LAYERS, REVISION, RUNNER_ID, SECRET, dataSet, fakeAgentDocker, fakeHome, makeLease, sha256, syncReply, waitFor,
  type FakeHome,
} from './_runner-agent-home.mts'

const layout = stateLayout(TEST_ROOT)
const CODE = '0123456789abcdef0123456789abcdef'
/** A machine whose promised memory, not MemAvailable, is the smaller bound: what a run holds shows in `free`. */
const PICTURE = { memTotalMb: 16_000, memAvailableMb: 15_000, cpus: 16, diskFreeMb: 500_000, diskTotalMb: 1_000_000 }

beforeEach(() => {
  for (const name of fs.readdirSync(TEST_ROOT)) {
    if (/^(runner\.json.*|status\.json|leases|books|data|agent\.sock)$/.test(name)) fs.rmSync(path.join(TEST_ROOT, name), { recursive: true, force: true })
  }
})

function agentFor(home: FakeHome, options: Partial<AgentOptions> = {}) {
  const docker = fakeAgentDocker()
  docker.registry.set(REVISION.ref, { diffIds: DIFF_IDS })
  const seam = new FakeSeam()
  const logs: string[] = []
  const agent = new Agent({
    layout,
    join: { home: home.url, code: CODE },
    build: 'dev',
    version: '0.24.0',
    container: 'colloq-runner',
    image: 'ghcr.io/colloq-edu/colloq-server:0.24.0',
    docker,
    runner: seam,
    machine: () => PICTURE,
    backoffMs: { min: 5, max: 20 },
    stopMs: 2_000,
    log: (line) => logs.push(line),
    ...options,
  })
  return { agent, docker, seam, logs }
}

const want = (set: ReturnType<typeof dataSet>) => ({
  revisions: [{ id: REVISION.id, ref: REVISION.ref, layers: LAYERS, gpu: false }],
  data: [{ competitionId: 'compabcd', manifest: set.manifest, sealed: false, files: set.files }],
  bundles: [],
})

/** Home offers `lease` once the machine reports its revision and data ready, and repeats it until the machine lists it. */
function offerWhenReady(home: FakeHome, set: ReturnType<typeof dataSet>, lease: RemoteLease, extra: (body: RemoteSyncRequest) => Partial<ReturnType<typeof syncReply>> = () => ({})) {
  home.onSync = (body) => {
    const ready = body.ready.revisions.includes(REVISION.id) && body.ready.data.includes(set.manifest)
    const listed = body.attempts.some((attempt) => attempt.id === lease.attemptId)
    const leases = ready && !listed && body.seq < lease.seq ? [lease] : []
    return { json: syncReply({ seq: lease.seq, leases, want: want(set), ...extra(body) }), delayMs: leases.length > 0 ? 0 : 20 }
  }
}

const attemptOf = (body: RemoteSyncRequest, id: string): RemoteHeldAttempt | undefined => body.attempts.find((attempt) => attempt.id === id)

/** Until the machine has held the lease (a sync listed it) and let it go again (its file is gone). */
async function settled(home: FakeHome, lease: RemoteLease): Promise<void> {
  await waitFor(() => home.syncs().some((sync) => attemptOf(sync, lease.attemptId)), `${lease.attemptId.slice(0, 8)} listed`)
  await waitFor(() => !fs.existsSync(path.join(layout.leasesDir, `${lease.attemptId}.json`)), `${lease.attemptId.slice(0, 8)} settled`)
}

test('a join whose reply is lost is the same join; the identity is 0600 and keeps the code\'s hash, never the code', async () => {
  const home = await fakeHome()
  const { agent } = agentFor(home)
  let joins = 0
  home.onJoin = () => {
    joins++
    // The relay's page for the first try: home never answered.
    if (joins === 1) return { status: 502, text: '<html>Bad Gateway</html>', marker: false }
    return { json: { runnerId: RUNNER_ID, secret: SECRET, trusted: true, approvedSlots: 3 } }
  }
  const running = agent.run()
  try {
    await waitFor(() => home.syncs().length > 0, 'the first sync')
    const tries = home.calls.filter((call) => call.path.endsWith('/join')).map((call) => call.body as { joinId: string; code: string; facts: { hostname: string; platform: string } })
    assert.equal(tries.length, 2)
    assert.equal(tries[0]!.joinId, tries[1]!.joinId, 'a lost reply made a second join')
    assert.equal(tries[1]!.code, CODE)
    assert.equal(tries[1]!.facts.hostname, 'vast-4090-host', 'the host\'s name, not the container\'s')
    assert.equal(tries[1]!.facts.platform, 'linux/amd64')
    const identity = readIdentity(layout)!
    assert.equal(identity.runnerId, RUNNER_ID)
    assert.equal(identity.codeSha256, sha256(CODE))
    assert.equal(identity.trusted, true)
    const text = fs.readFileSync(layout.identityFile, 'utf8')
    assert.ok(!text.includes(CODE), 'the code was written down')
    assert.equal(fs.statSync(layout.identityFile).mode & 0o777, 0o600)
    // The first sync after the start says the machine's facts; later ones say them only when they change.
    await waitFor(() => home.syncs().length > 2, 'more syncs')
    const syncs = home.syncs()
    assert.ok(syncs[0]!.facts, 'the first sync after the start has no facts')
    assert.ok(syncs.slice(1).every((sync) => !sync.facts || JSON.stringify(sync.facts) !== JSON.stringify(syncs[0]!.facts)))
    assert.equal(syncs[0]!.state, 'active')
    assert.equal(syncs[0]!.holdMs, 25_000)
  } finally {
    await agent.stop()
    await running
    await home.close()
  }
})

test('a lease is written down before a sync lists it, runs, uploads its files gzipped and its outcome, and leaves no trace once applied', async () => {
  const home = await fakeHome()
  const { agent, seam } = agentFor(home)
  const set = dataSet({ 'train.csv': 'id,x\n1,2\n', 'test.csv': 'id\n1\n' })
  for (const [sha, body] of set.bodies) home.blobs.set(sha, body)
  const lease = makeLease({ data: set.manifest })
  seam.next = 'wait'
  const leaseFile = path.join(layout.leasesDir, `${lease.attemptId}.json`)
  const writtenBeforeListed: boolean[] = []
  offerWhenReady(home, set, lease, (body) => {
    if (attemptOf(body, lease.attemptId)) writtenBeforeListed.push(fs.existsSync(leaseFile))
    return {}
  })
  const running = agent.run()
  try {
    await waitFor(() => seam.runs.length === 1, 'the run')
    // While it runs: listed as running, with its time, its progress, and what it holds taken out of `free`.
    const busy = await waitFor(() => home.syncs().find((sync) => attemptOf(sync, lease.attemptId)?.phase === 'running' && attemptOf(sync, lease.attemptId)?.progress), 'a sync with the run')
    assert.equal(busy.seq, lease.seq)
    assert.equal(busy.holdMs, 10_000)
    const held = attemptOf(busy, lease.attemptId)!
    assert.ok(Number.isSafeInteger(held.runningMs))
    assert.deepEqual(held.progress, { phase: 'notebook', cell: 0, cells: 1 })
    assert.equal(busy.free.memoryMb, PICTURE.memTotalMb - REMOTE_HOST_RESERVE_MB - (lease.limits.memoryMb + REMOTE_CONTAINER_CUSHION_MB))
    assert.equal(busy.free.cpus, PICTURE.cpus - 1 - lease.limits.cpus)
    // The run is home's own request, on this machine's tree.
    const request = seam.runs[0]!
    assert.equal(request.container, lease.container)
    assert.equal(request.attemptId, lease.attemptId)
    assert.equal(request.imageDigest, `colloq-revision:${REVISION.id}`)
    assert.deepEqual(request.limits, lease.limits)
    assert.equal(request.dataDir, path.join(competitionsDir, 'compabcd', 'inputs', set.manifest.slice(0, 12)))
    assert.deepEqual(fs.readdirSync(request.dataDir).sort(), ['test.csv', 'train.csv'])
    assert.equal(request.inputDir, path.join(competitionsDir, 'compabcd', 's', lease.submissionId, 'in'))
    assert.equal(request.resultDir, path.join(competitionsDir, 'compabcd', 's', lease.submissionId, 'attempts', lease.attemptId, 'result'))
    seam.release()

    await settled(home, lease)
    assert.ok(writtenBeforeListed.length > 0 && writtenBeforeListed.every(Boolean), 'a sync listed a lease not yet written down')
    // The files, gzipped, as they were.
    const stored = home.stored.get(lease.attemptId)!
    assert.equal(stored.get('submission.csv')!.toString(), 'id,target\n1,0.5\n')
    assert.ok(stored.get('executed.ipynb')!.toString().includes('"executed":true'))
    const outcome = home.calls.find((call) => call.path.endsWith(`/attempts/${lease.attemptId}/outcome`))!.body as any
    assert.equal(outcome.kind, 'finished')
    assert.equal(outcome.outcome.status, 'ok')
    assert.equal(outcome.outcome.produced, true)
    assert.deepEqual(outcome.files.map((file: any) => file.name).sort(), ['executed.ipynb', 'submission.csv'])
    for (const file of outcome.files) assert.equal(file.sha256, sha256(stored.get(file.name)!))
    assert.equal(JSON.parse(Buffer.from(outcome.runJson, 'base64').toString()).attemptId, lease.attemptId)
    // The PUTs went before the outcome.
    const order = home.calls.filter((call) => call.path.includes(lease.attemptId)).map((call) => call.method)
    assert.deepEqual(order, ['PUT', 'PUT', 'POST'])
    // Nothing left: the lease, its outcome, its tree, its submission's folder.
    assert.deepEqual(fs.readdirSync(layout.leasesDir), [])
    assert.ok(!fs.existsSync(path.join(competitionsDir, 'compabcd', 's', lease.submissionId)))
    // And the next syncs no longer list it, and give the room back.
    const after = await waitFor(() => home.syncs().slice(-1).find((sync) => sync.attempts.length === 0), 'an idle sync')
    assert.equal(after.free.memoryMb, PICTURE.memTotalMb - REMOTE_HOST_RESERVE_MB)
  } finally {
    await agent.stop()
    await running
    await home.close()
  }
})

test('a lease the machine cannot run is declined before any container, with its reason', async () => {
  const home = await fakeHome()
  const { agent, seam } = agentFor(home)
  const set = dataSet({ 'train.csv': 'id\n1\n' })
  for (const [sha, body] of set.bodies) home.blobs.set(sha, body)
  // Its data is a manifest home never asked this machine to fetch.
  const lease = makeLease({ data: dataSet({ 'other.csv': 'x\n' }).manifest })
  offerWhenReady(home, set, lease)
  const running = agent.run()
  try {
    const call = await waitFor(() => home.calls.find((found) => found.path.endsWith(`/attempts/${lease.attemptId}/outcome`)), 'the decline')
    const body = call.body as { kind: string; reason: string; detail: string; free: unknown }
    assert.equal(body.kind, 'declined')
    assert.equal(body.reason, 'data')
    assert.match(body.detail, /not complete here/)
    assert.equal(seam.runs.length, 0, 'a container started for a lease declined')
    // Listed before the decline as preparing (no container time), and not after it.
    await waitFor(() => !fs.existsSync(path.join(layout.leasesDir, `${lease.attemptId}.json`)), 'the decline settled')
    await waitFor(() => home.syncs().slice(-1).some((sync) => !attemptOf(sync, lease.attemptId)), 'a sync without it')
    assert.ok(home.syncs().every((sync) => !['running', 'exporting', 'uploading'].includes(attemptOf(sync, lease.attemptId)?.phase ?? '')))

    // A harness this build does not carry: `version`.
    const old = makeLease({ data: set.manifest, harness: '000000000000' })
    offerWhenReady(home, set, old)
    const declined = await waitFor(() => home.calls.find((found) => found.path.endsWith(`/attempts/${old.attemptId}/outcome`)), 'the version decline')
    assert.equal((declined.body as { reason: string }).reason, 'version')
    assert.equal(seam.runs.length, 0)
  } finally {
    await agent.stop()
    await running
    await home.close()
  }
})

test('a run home revokes mid-run is killed, sends nothing more, and leaves no trace', async () => {
  const home = await fakeHome()
  const { agent, seam } = agentFor(home)
  const set = dataSet({ 'train.csv': 'id\n1\n' })
  for (const [sha, body] of set.bodies) home.blobs.set(sha, body)
  const lease = makeLease({ data: set.manifest })
  seam.next = 'wait'
  let revoke = false
  offerWhenReady(home, set, lease, (body) => (revoke && attemptOf(body, lease.attemptId) ? { revoke: [{ id: lease.attemptId, reason: 'cancelled' }] } : {}))
  const running = agent.run()
  try {
    await waitFor(() => seam.runs.length === 1, 'the run')
    revoke = true
    await waitFor(() => seam.runs[0]!.signal?.aborted, 'the run\'s abort')
    await settled(home, lease)
    assert.equal(home.stored.size, 0, 'a revoked run uploaded')
    assert.ok(!home.calls.some((call) => call.path.includes(`/attempts/${lease.attemptId}/`)), 'a revoked run said something')
    assert.ok(!fs.existsSync(path.join(competitionsDir, 'compabcd', 's', lease.submissionId)))
    const later = await waitFor(() => home.syncs().slice(-1).find((sync) => !attemptOf(sync, lease.attemptId)), 'a sync without it')
    assert.equal(later.attempts.length, 0)
  } finally {
    await agent.stop()
    await running
    await home.close()
  }
})

test('an upload through a relay hiccup is asked again, the attempt held and listed as uploading, until home applies it', async () => {
  const home = await fakeHome()
  const { agent } = agentFor(home)
  const set = dataSet({ 'train.csv': 'id\n1\n' })
  for (const [sha, body] of set.bodies) home.blobs.set(sha, body)
  const lease = makeLease({ data: set.manifest })
  let refusals = 0
  home.onUpload = ({ name }) => {
    // The relay restarting: its page, then frps's 504, then home itself says "not now".
    if (name === 'submission.csv' && refusals < 3) {
      refusals++
      return refusals === 1 ? { status: 502, text: '<html>relay</html>', marker: false } : refusals === 2 ? { status: 504, text: 'gateway timeout', marker: false } : { status: 503, json: { error: 'busy' }, headers: { 'Retry-After': '0' } }
    }
    return { status: 200 }
  }
  let outcomes = 0
  home.onOutcome = () => {
    outcomes++
    // The first outcome reply is lost as well.
    return outcomes === 1 ? { status: 404, text: 'Not Found', marker: false } : { json: { result: 'applied', seq: lease.seq, leases: [] } }
  }
  offerWhenReady(home, set, lease)
  const running = agent.run()
  try {
    await settled(home, lease)
    assert.equal(refusals, 3)
    assert.equal(outcomes, 2)
    assert.equal(home.stored.get(lease.attemptId)?.get('submission.csv')?.toString(), 'id,target\n1,0.5\n')
    // Never dropped meanwhile: the syncs listed it, as uploading, with the container's time.
    assert.ok(home.syncs().some((sync) => attemptOf(sync, lease.attemptId)?.phase === 'uploading' && Number.isSafeInteger(attemptOf(sync, lease.attemptId)?.runningMs)))
  } finally {
    await agent.stop()
    await running
    await home.close()
  }
})

test('home\'s 409 for an upload discards the attempt; the outcome is never posted', async () => {
  const home = await fakeHome()
  const { agent } = agentFor(home)
  const set = dataSet({ 'train.csv': 'id\n1\n' })
  for (const [sha, body] of set.bodies) home.blobs.set(sha, body)
  const lease = makeLease({ data: set.manifest })
  home.onUpload = () => ({ status: 409, json: { error: 'revoked' } })
  offerWhenReady(home, set, lease)
  const running = agent.run()
  try {
    await waitFor(() => home.calls.some((call) => call.method === 'PUT'), 'an upload')
    await settled(home, lease)
    assert.ok(!home.calls.some((call) => call.path.endsWith('/outcome')), 'an outcome was posted for a revoked attempt')
    assert.ok(!fs.existsSync(path.join(competitionsDir, 'compabcd', 's', lease.submissionId)))
  } finally {
    await agent.stop()
    await running
    await home.close()
  }
})

test('applied in a sync settles an attempt whose outcome reply was lost; a failed notebook uploads no answer', async () => {
  const home = await fakeHome()
  const { agent, seam } = agentFor(home)
  const set = dataSet({ 'train.csv': 'id\n1\n' })
  for (const [sha, body] of set.bodies) home.blobs.set(sha, body)
  const lease = makeLease({ data: set.manifest })
  seam.next = 'cell_error'
  // Home applied it; every reply to the outcome is lost on the way.
  let applied = false
  home.onOutcome = () => {
    applied = true
    return { status: 504, text: 'gateway', marker: false }
  }
  offerWhenReady(home, set, lease, (body) => (applied && attemptOf(body, lease.attemptId) ? { applied: [lease.attemptId] } : {}))
  const running = agent.run()
  try {
    await waitFor(() => applied, 'the outcome posted')
    await settled(home, lease)
    const files = [...(home.stored.get(lease.attemptId)?.keys() ?? [])]
    assert.deepEqual(files, ['executed.ipynb'], 'a failed run sent an answer')
    const outcome = home.calls.find((call) => call.path.endsWith('/outcome'))!.body as any
    assert.equal(outcome.outcome.status, 'cell_error')
    assert.equal(outcome.outcome.produced, false)
  } finally {
    await agent.stop()
    await running
    await home.close()
  }
})

test('a GPU lease takes the least loaded card at its pinned share, and every sync says the card, the share and what is left', async () => {
  const home = await fakeHome()
  const { agent, seam, docker } = agentFor(home)
  docker.cards = '0, GPU-aa, NVIDIA GeForce RTX 4090, 24564\n1, GPU-bb, NVIDIA GeForce RTX 4090, 24564\n'
  const set = dataSet({ 'train.csv': 'id\n1\n' })
  for (const [sha, body] of set.bodies) home.blobs.set(sha, body)
  const lease = makeLease({ data: set.manifest, gpu: true, perDevice: 2 })
  seam.next = 'wait'
  home.onSync = (body) => {
    const gpuWant = { ...want(set), revisions: [{ id: REVISION.id, ref: REVISION.ref, layers: LAYERS, gpu: true }] }
    const ready = body.ready.revisions.includes(REVISION.id) && body.ready.data.includes(set.manifest) && body.cards.length === 2
    const leases = ready && !attemptOf(body, lease.attemptId) && body.seq < lease.seq ? [lease] : []
    return { json: syncReply({ seq: lease.seq, leases, want: gpuWant, perDevice: 2 }), delayMs: leases.length ? 0 : 20 }
  }
  const running = agent.run()
  try {
    await waitFor(() => seam.runs.length === 1, 'the GPU run')
    assert.deepEqual(seam.runs[0]!.gpu, { device: '0', sliceMb: 12_282, perDevice: 2 })
    // The GPU kernel passed its smoke test on card 0 before it was ready.
    assert.ok(docker.calls.some((args) => args[0] === 'run' && args.includes('python') && args.includes('device=0')))
    const busy = await waitFor(() => home.syncs().find((sync) => attemptOf(sync, lease.attemptId)?.card), 'a sync with the card')
    assert.deepEqual(attemptOf(busy, lease.attemptId)!.card, { device: '0', sliceMb: 12_282 })
    assert.deepEqual(busy.cards.map((card) => [card.device, card.busyShares, card.perDevice, card.memoryMb]), [['0', 1, 2, 24_564], ['1', 0, 2, 24_564]])
    assert.equal(busy.free.gpuShares, 3)
    // The driver the probe read travels in the facts.
    assert.ok(home.syncs().some((sync) => sync.facts?.driver === '580.65.06'))
    seam.release()
    await settled(home, lease)
  } finally {
    await agent.stop()
    await running
    await home.close()
  }
})

test('below the disk\'s floor with nothing left to evict, the machine says so', async () => {
  const home = await fakeHome()
  const { agent } = agentFor(home, { machine: () => ({ ...PICTURE, diskFreeMb: 3000 }), diskFloorMb: 8192 })
  const running = agent.run()
  try {
    const sync = await waitFor(() => home.syncs().find((found) => found.problems.some((problem) => problem.code === 'disk')), 'the disk problem')
    assert.match(sync.problems.find((problem) => problem.code === 'disk')!.detail, /3000 MB is below the 8192 MB floor/)
    // What it offers says the same: no place for an attempt's share of the disk.
    assert.equal(sync.free.diskMb, 3000 - 2048)
  } finally {
    await agent.stop()
    await running
    await home.close()
  }
})

test('a relay that goes down mid-run is no reason to drop the run: the status says home is offline, and the result goes up when it is back', async () => {
  const home = await fakeHome()
  const { agent, seam } = agentFor(home)
  const set = dataSet({ 'train.csv': 'id\n1\n' })
  for (const [sha, body] of set.bodies) home.blobs.set(sha, body)
  const lease = makeLease({ data: set.manifest })
  seam.next = 'wait'
  let down = false
  offerWhenReady(home, set, lease)
  const answer = home.onSync
  home.onSync = (body, call) => (down ? { status: 404, text: '<html>Colloq is not answering</html>', marker: false } : answer(body, call))
  home.relay = { known: true, tunnel: false }
  const running = agent.run()
  try {
    await waitFor(() => seam.runs.length === 1, 'the run')
    down = true
    await waitFor(() => JSON.parse(fs.readFileSync(layout.statusFile, 'utf8')).path === 'home_offline', 'the status saying home is offline')
    assert.equal(JSON.parse(fs.readFileSync(layout.statusFile, 'utf8')).held, 1)
    assert.ok(fs.existsSync(path.join(layout.leasesDir, `${lease.attemptId}.json`)), 'a lease was dropped over the relay\'s page')
    assert.ok(!seam.runs[0]!.signal?.aborted, 'the run was stopped over the relay\'s page')
    down = false
    seam.release()
    await settled(home, lease)
    assert.equal(home.stored.get(lease.attemptId)?.get('submission.csv')?.toString(), 'id,target\n1,0.5\n')
  } finally {
    await agent.stop()
    await running
    await home.close()
  }
})

test('a file home refuses for good ends its sibling\'s retries: one 409 discards the attempt even while the other upload only hiccups', async () => {
  const home = await fakeHome()
  const { agent } = agentFor(home)
  const set = dataSet({ 'train.csv': 'id\n1\n' })
  for (const [sha, body] of set.bodies) home.blobs.set(sha, body)
  const lease = makeLease({ data: set.manifest })
  home.onUpload = ({ name }) => (name === 'executed.ipynb' ? { status: 409, json: { error: 'revoked' } } : { status: 502, text: 'relay', marker: false })
  offerWhenReady(home, set, lease)
  const running = agent.run()
  try {
    await settled(home, lease)
    assert.ok(!home.calls.some((call) => call.path.endsWith('/outcome')))
  } finally {
    await agent.stop()
    await running
    await home.close()
  }
})

test('a disk smaller than a machine of its kind needs is said to the owner', async () => {
  const home = await fakeHome()
  const { agent } = agentFor(home, { machine: () => ({ ...PICTURE, diskTotalMb: 30 * 1024 }) })
  const running = agent.run()
  try {
    const sync = await waitFor(() => home.syncs().find((found) => found.problems.some((problem) => problem.code === 'disk')), 'the disk size problem')
    assert.match(sync.problems.find((problem) => problem.code === 'disk')!.detail, /30 GB, less than the 40 GB/)
  } finally {
    await agent.stop()
    await running
    await home.close()
  }
})
