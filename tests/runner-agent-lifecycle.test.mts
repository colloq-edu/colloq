/**
 * A machine's agent across its lives: a restart, a revocation, a drain, a
 * leave, a stop, and the commands the packaging runs against it (runner
 * status, drain, leave: deploy/vast/colloq-host and entrypoint.sh).
 *
 * What is held here: after a restart the agent removes its containers,
 * uploads the outcomes it had written down and reports nothing else (home
 * marks the rest lost at once); a 401 purges the hidden test and turns off
 * Docker's restart policy (or unless-stopped would start a revoked machine
 * forever), unless a new code waits, which joins anew; a stop hands every
 * unfinished run back as a `draining` decline; a drain takes nothing new and
 * says when nothing is held; a leave revokes the machine on its home and then
 * lets the process go, only after the one who asked heard it.
 */
import './_env.mts'
import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { remoteOutcome, type RemoteLease, type RemoteSyncRequest } from '../shared/remote-runner.ts'
import { Agent, type AgentOptions } from '../server/src/runner-agent/sync.ts'
import { readIdentity, stateLayout, writeIdentity, writeLease, writeOutcome, type Identity } from '../server/src/runner-agent/state.ts'
import { askAgent, serveControl, type ControlMessage } from '../server/src/runner-agent/control.ts'
import { INSTANCE_LABEL, revisionImage } from '../server/src/runner-agent/images.ts'
import { main, status } from '../server/src/runner-agent/main.ts'
import { attemptPath, competitionsDir, competitionsFs } from '../server/src/competitions/storage.ts'
import { TEST_ROOT } from './_env.mts'
import {
  DIFF_IDS, FakeSeam, LAYERS, REVISION, RUNNER_ID, SECRET, dataSet, fakeAgentDocker, fakeHome, hex, makeLease, outcomeReply, sha256, syncReply, waitFor,
  type FakeHome,
} from './_runner-agent-home.mts'

const layout = stateLayout(TEST_ROOT)
const CODE = '0123456789abcdef0123456789abcdef'
const NEW_CODE = 'fedcba9876543210fedcba9876543210'
const PICTURE = { memTotalMb: 16_000, memAvailableMb: 15_000, cpus: 16, diskFreeMb: 500_000, diskTotalMb: 1_000_000 }

beforeEach(() => {
  for (const name of fs.readdirSync(TEST_ROOT)) {
    if (/^(runner\.json.*|status\.json|leases|books|data|agent\.sock|nowhere)$/.test(name)) fs.rmSync(path.join(TEST_ROOT, name), { recursive: true, force: true })
  }
  // storage.ts holds the competitions folder open: on Linux the walk goes by that descriptor, so a
  // folder removed here would stay the one it writes into. Closed, it opens the new one.
  competitionsFs.close()
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

/** A machine that joined `home` with CODE in an earlier life. */
function joinedBefore(home: FakeHome, extra: Partial<Identity> = {}): void {
  writeIdentity(layout, { home: home.url, joinId: hex(16), codeSha256: sha256(CODE), runnerId: RUNNER_ID, secret: SECRET, trusted: true, approvedSlots: null, joinedAt: Date.now() - 60_000, ...extra })
}

const want = (set: ReturnType<typeof dataSet>) => ({
  revisions: [{ id: REVISION.id, ref: REVISION.ref, layers: LAYERS, gpu: false }],
  data: [{ competitionId: 'compabcd', manifest: set.manifest, sealed: false, files: set.files }],
  bundles: [],
})

const attemptOf = (body: RemoteSyncRequest, id: string) => body.attempts.find((attempt) => attempt.id === id)

function offerWhenReady(home: FakeHome, set: ReturnType<typeof dataSet>, lease: RemoteLease, extra: (body: RemoteSyncRequest) => Partial<ReturnType<typeof syncReply>> = () => ({})) {
  home.onSync = (body) => {
    const ready = body.ready.revisions.includes(REVISION.id) && body.ready.data.includes(set.manifest)
    const leases = ready && !attemptOf(body, lease.attemptId) && body.seq < lease.seq ? [lease] : []
    return { json: syncReply({ seq: lease.seq, leases, want: want(set), ...extra(body) }), delayMs: leases.length > 0 ? 0 : 20 }
  }
}

test('after a restart: its containers removed, the outcomes it wrote down uploaded, and nothing else reported', async () => {
  const home = await fakeHome()
  joinedBefore(home)
  const finished = makeLease({ data: 'f'.repeat(64), submissionId: 'subfinis' })
  const unfinished = makeLease({ data: 'f'.repeat(64), submissionId: 'subunfin' })
  // The earlier life: one run finished and its outcome written down, one cut off mid-run.
  for (const lease of [finished, unfinished]) writeLease(layout, { lease, receivedAt: Date.now() - 30_000 })
  const resultDir = attemptPath('compabcd', finished.submissionId, finished.attemptId, 'result')
  fs.mkdirSync(resultDir, { recursive: true })
  const executed = '{"cells":[],"executed":true}'
  fs.writeFileSync(path.join(resultDir, 'executed.ipynb'), executed)
  const outcome = remoteOutcome({ status: 'cell_error', cell: 0, cells: 1, wall: 900, detail: 'ValueError: x', log: '', diagnostics: { exit: 1, oomKilled: false, backend: 'docker' }, produced: false })
  writeOutcome(layout, finished.attemptId, { kind: 'finished', outcome, runJson: null, files: [{ name: 'executed.ipynb', bytes: executed.length, sha256: sha256(executed) }], startedAt: Date.now() - 20_000, endedAt: Date.now() - 10_000 })
  const cutOff = attemptPath('compabcd', unfinished.submissionId, unfinished.attemptId, 'result')
  fs.mkdirSync(cutOff, { recursive: true })
  // A tree no lease names at all.
  const stray = attemptPath('compabcd', 'substray', hex(16), 'result')
  fs.mkdirSync(stray, { recursive: true })

  const { agent, seam, docker } = agentFor(home)
  const running = agent.run()
  try {
    await waitFor(() => home.calls.some((call) => call.path.endsWith(`/attempts/${finished.attemptId}/outcome`)), 'the written-down outcome posted')
    // Swept before anything else: the runs by the runner's labels, the checks by the agent's.
    assert.equal(seam.sweeps, 1)
    // The checks of this tree only: another agent's on the same daemon are its own (images.ts · INSTANCE_LABEL).
    assert.ok(docker.calls.some((args) => args[0] === 'ps' && args.includes('label=colloq.kind=runner-check') && args.includes(`label=${INSTANCE_LABEL}`)))
    assert.ok(!docker.calls.some((args) => args[0] === 'ps' && !args.includes(`label=${INSTANCE_LABEL}`)), 'a sweep looked past this tree')
    assert.ok(!fs.existsSync(path.join(layout.leasesDir, `${unfinished.attemptId}.json`)), 'a lease without its outcome survived the restart')
    assert.ok(!fs.existsSync(path.join(competitionsDir, 'compabcd', 's', unfinished.submissionId)))
    assert.ok(!fs.existsSync(path.join(competitionsDir, 'compabcd', 's', 'substray')))
    // The very outcome written down, and its file, as they were.
    const posted = home.calls.find((call) => call.path.endsWith(`/attempts/${finished.attemptId}/outcome`))!.body as any
    assert.deepEqual(posted.outcome, outcome)
    assert.equal(home.stored.get(finished.attemptId)?.get('executed.ipynb')?.toString(), executed)
    await waitFor(() => !fs.existsSync(path.join(layout.leasesDir, `${finished.attemptId}.json`)), 'the outcome settled')
    // Reported: the finished one as uploading, with its container's time; the cut-off one never.
    const syncs = home.syncs()
    assert.ok(syncs.every((sync) => !attemptOf(sync, unfinished.attemptId)), 'a lease with nothing written down was reported')
    const first = syncs[0]!
    if (attemptOf(first, finished.attemptId)) {
      assert.equal(attemptOf(first, finished.attemptId)!.phase, 'uploading')
      assert.ok(attemptOf(first, finished.attemptId)!.runningMs! >= 20_000)
    }
    // The seq the earlier life had written down.
    assert.equal(first.seq, Math.max(finished.seq, unfinished.seq))
    assert.ok(!home.calls.some((call) => call.path.endsWith('/join')), 'a machine with an identity joined again')
  } finally {
    await agent.stop()
    await running
    await home.close()
  }
})

test('a 401 is the owner\'s revocation: the hidden test is purged, Docker\'s restart policy is turned off, and the agent stays gone with the same code', async () => {
  const home = await fakeHome()
  joinedBefore(home)
  fs.mkdirSync(path.join(competitionsDir, '.sealed'), { recursive: true })
  fs.writeFileSync(path.join(competitionsDir, '.sealed', 'e'.repeat(64)), 'hidden rows')
  home.onSync = () => ({ status: 401, json: { error: 'unauthorized' } })
  const { agent, docker } = agentFor(home)
  const exit = await agent.run()
  try {
    assert.deepEqual({ reason: exit.reason, code: exit.code }, { reason: 'revoked', code: 0 })
    assert.deepEqual(fs.readdirSync(path.join(competitionsDir, '.sealed')), [])
    assert.ok(docker.calls.some((args) => args.join(' ') === 'update --restart=no colloq-runner'))
    assert.ok(readIdentity(layout)!.revokedAt !== undefined)
    assert.equal(JSON.parse(fs.readFileSync(layout.statusFile, 'utf8')).state, 'revoked')

    // Started again with the same code: gone at once, without a call to home.
    const before = home.calls.length
    const again = agentFor(home)
    const second = await again.agent.run()
    assert.equal(second.reason, 'revoked')
    assert.equal(home.calls.length, before)
    assert.ok(again.docker.calls.some((args) => args.join(' ') === 'update --restart=no colloq-runner'))

    // With a new code in COLLOQ_RUNNER_JOIN: the revoked identity is put aside, and the machine joins anew.
    home.onSync = () => ({ json: syncReply(), delayMs: 20 })
    const fresh = agentFor(home, { join: { home: home.url, code: NEW_CODE } })
    const third = fresh.agent.run()
    await waitFor(() => home.calls.some((call) => call.path.endsWith('/join')), 'the new join')
    const join = home.calls.find((call) => call.path.endsWith('/join'))!.body as { code: string }
    assert.equal(join.code, NEW_CODE)
    assert.ok(fs.readdirSync(TEST_ROOT).some((name) => /^runner\.json\.revoked-\d{8}T\d{6}Z$/.test(name)))
    assert.equal(readIdentity(layout)!.codeSha256, sha256(NEW_CODE))
    await fresh.agent.stop()
    await third
  } finally {
    await home.close()
  }
})

test('what a revoked identity wrote down is never sent under the new one, and the new one\'s seq starts over', async () => {
  const home = await fakeHome()
  joinedBefore(home, { revokedAt: Date.now() - 1000 })
  const lease = makeLease({ data: 'f'.repeat(64) })
  writeLease(layout, { lease, receivedAt: Date.now() - 5000 })
  writeOutcome(layout, lease.attemptId, { kind: 'declined', reason: 'memory', detail: 'too big', startedAt: null })
  const { agent } = agentFor(home, { join: { home: home.url, code: NEW_CODE } })
  const running = agent.run()
  try {
    await waitFor(() => home.syncs().length > 1, 'syncs as the new machine')
    assert.ok(!home.calls.some((call) => call.path.includes(lease.attemptId)), 'the old identity\'s outcome was sent with the new one\'s secret')
    assert.ok(!fs.existsSync(path.join(layout.leasesDir, `${lease.attemptId}.json`)))
    assert.equal(home.syncs()[0]!.seq, 0)
    assert.ok(home.syncs().every((sync) => sync.attempts.length === 0))
  } finally {
    await agent.stop()
    await running
    await home.close()
  }
})

test('a 401 while a new code waits: the dead identity goes aside and the running machine joins again, without exiting', async () => {
  const home = await fakeHome()
  joinedBefore(home)
  let revoked = true
  home.onSync = (_, call) => {
    // The old secret is refused; the new one works.
    if (revoked && String(call.headers.authorization).includes(SECRET)) return { status: 401, json: { error: 'unauthorized' } }
    return { json: syncReply(), delayMs: 20 }
  }
  home.onJoin = () => {
    revoked = false
    return { json: { runnerId: 'runnercd', secret: 'd'.repeat(64), trusted: false, approvedSlots: null } }
  }
  const { agent } = agentFor(home, { join: { home: home.url, code: NEW_CODE } })
  const running = agent.run()
  try {
    await waitFor(() => home.calls.filter((call) => call.path.endsWith('/sync') && String(call.headers.authorization).includes('runnercd')).length > 0, 'a sync as the new machine')
    assert.equal(readIdentity(layout)!.runnerId, 'runnercd')
    assert.ok(fs.readdirSync(TEST_ROOT).some((name) => name.startsWith('runner.json.revoked-')))
  } finally {
    await agent.stop()
    await running
    await home.close()
  }
})

test('a stop hands back every unfinished run as a draining decline, and removes the containers', async () => {
  const home = await fakeHome()
  const set = dataSet({ 'train.csv': 'id\n1\n' })
  for (const [sha, body] of set.bodies) home.blobs.set(sha, body)
  const lease = makeLease({ data: set.manifest })
  offerWhenReady(home, set, lease)
  const { agent, seam } = agentFor(home)
  seam.next = 'wait'
  const running = agent.run()
  try {
    await waitFor(() => seam.runs.length === 1, 'the run')
    await agent.stop()
    const exit = await running
    assert.equal(exit.reason, 'stopped')
    assert.ok(seam.runs[0]!.signal?.aborted, 'the run was not stopped')
    const posted = home.calls.find((call) => call.path.endsWith(`/attempts/${lease.attemptId}/outcome`))!.body as any
    assert.deepEqual({ kind: posted.kind, reason: posted.reason }, { kind: 'declined', reason: 'draining' })
    assert.equal(home.stored.size, 0, 'a run cut off by the stop uploaded its files')
    // Swept at the start and once more on the way out.
    assert.equal(seam.sweeps, 2)
    assert.equal(JSON.parse(fs.readFileSync(layout.statusFile, 'utf8')).state, 'stopped')
  } finally {
    await home.close()
  }
})

test('a stop that cannot reach home keeps the outcome written down for the next life', async () => {
  const home = await fakeHome()
  const set = dataSet({ 'train.csv': 'id\n1\n' })
  for (const [sha, body] of set.bodies) home.blobs.set(sha, body)
  const lease = makeLease({ data: set.manifest })
  offerWhenReady(home, set, lease)
  // The relay goes down as the run ends.
  home.onUpload = () => ({ status: 502, text: 'relay', marker: false })
  const { agent } = agentFor(home, { stopMs: 300 })
  const running = agent.run()
  try {
    await waitFor(() => home.calls.some((call) => call.method === 'PUT'), 'an upload tried')
    await agent.stop()
    await running
    assert.ok(fs.existsSync(path.join(layout.leasesDir, `${lease.attemptId}.json`)))
    assert.ok(fs.existsSync(path.join(layout.leasesDir, `${lease.attemptId}.outcome.json`)), 'a finished run was lost to a stop')
  } finally {
    await home.close()
  }
})

test('drain over the agent\'s socket: nothing new is taken, offers are withdrawn by the seq, and it answers once nothing is held; leave then revokes the machine', async () => {
  const home = await fakeHome()
  const set = dataSet({ 'train.csv': 'id\n1\n' })
  for (const [sha, body] of set.bodies) home.blobs.set(sha, body)
  const lease = makeLease({ data: set.manifest })
  const late = makeLease({ data: set.manifest, submissionId: 'sublatee' })
  let draining = false
  home.onSync = (body) => {
    const ready = body.ready.revisions.includes(REVISION.id) && body.ready.data.includes(set.manifest)
    if (body.state === 'draining') draining = true
    // While draining, home (not knowing yet) offers one more.
    const leases = !ready ? [] : !attemptOf(body, lease.attemptId) && body.seq < lease.seq ? [lease] : draining && body.seq < late.seq ? [late] : []
    return { json: syncReply({ seq: Math.max(lease.seq, late.seq), leases, want: want(set) }), delayMs: leases.length > 0 ? 0 : 20 }
  }
  const { agent, seam, docker } = agentFor(home)
  seam.next = 'wait'
  const server = await serveControl(agent, layout.socket)
  const running = agent.run()
  try {
    await waitFor(() => seam.runs.length === 1, 'the run')
    const said: ControlMessage[] = []
    const drained = askAgent(layout.socket, 'drain', (message) => said.push(message))
    await waitFor(() => draining, 'a draining sync')
    await waitFor(() => home.syncs().some((sync) => sync.state === 'draining' && sync.seq >= late.seq), 'the late offer seen')
    assert.ok(!fs.existsSync(path.join(layout.leasesDir, `${late.attemptId}.json`)), 'a draining machine wrote down an offer')
    assert.ok(home.syncs().every((sync) => !attemptOf(sync, late.attemptId)))
    assert.deepEqual(said.filter((message) => 'held' in message).slice(0, 1), [{ held: 1, state: 'draining' }])
    seam.release()
    assert.equal(await drained, 'answered')
    assert.ok(said.some((message) => 'drained' in message))
    assert.equal(seam.runs.length, 1)

    // Leave: one sync that says so with nothing held, then the machine has left.
    const left = askAgent(layout.socket, 'leave', (message) => said.push(message))
    assert.equal(await left, 'answered')
    assert.ok(said.some((message) => 'left' in message))
    const exit = await running
    assert.equal(exit.reason, 'left')
    const leaving = home.syncs().filter((sync) => sync.state === 'leaving')
    assert.equal(leaving.length, 1)
    assert.deepEqual(leaving[0]!.attempts, [])
    assert.ok(readIdentity(layout)!.leftAt !== undefined)
    assert.ok(docker.calls.some((args) => args.join(' ') === 'update --restart=no colloq-runner'))
    // Draining is not written down: a machine started again takes work (and this one left, so it stays gone).
    assert.equal(JSON.parse(fs.readFileSync(layout.statusFile, 'utf8')).state, 'left')
  } finally {
    server.close()
    await home.close()
  }
})

test('home\'s drain and untrust: the hidden test is purged, and offers are not taken while home drains', async () => {
  const home = await fakeHome()
  joinedBefore(home)
  const open = dataSet({ 'train.csv': 'id\n1\n' })
  const hidden = dataSet({ 'test.csv': 'id\n2\n' })
  for (const [sha, body] of [...open.bodies, ...hidden.bodies]) home.blobs.set(sha, body)
  let trusted = true
  let drain = false
  const lease = makeLease({ data: open.manifest })
  home.onSync = (body) => ({
    json: syncReply({
      seq: lease.seq,
      trusted,
      drain,
      leases: drain && body.seq < lease.seq ? [lease] : [],
      want: { revisions: [], bundles: [], data: [{ competitionId: 'compabcd', manifest: open.manifest, sealed: false, files: open.files }, ...(trusted ? [{ competitionId: 'compabcd', manifest: hidden.manifest, sealed: true, files: hidden.files }] : [])] },
    }),
    delayMs: 20,
  })
  const { agent } = agentFor(home)
  const running = agent.run()
  try {
    await waitFor(() => home.syncs().some((sync) => sync.ready.sealed.includes(hidden.manifest)), 'the hidden test ready')
    trusted = false
    await waitFor(() => fs.readdirSync(path.join(competitionsDir, '.sealed')).length === 0, 'the hidden test purged')
    await waitFor(() => home.syncs().slice(-1)[0]!.ready.sealed.length === 0, 'reported gone')
    assert.equal(readIdentity(layout)!.trusted, false)
    // Home drains the machine: its offer is seen and not taken.
    drain = true
    await waitFor(() => home.syncs().some((sync) => sync.seq >= lease.seq), 'the offer seen')
    assert.ok(!fs.existsSync(path.join(layout.leasesDir, `${lease.attemptId}.json`)))
    assert.ok(home.syncs().every((sync) => !attemptOf(sync, lease.attemptId)))
    // The state it reports is its own: home's drain is home's to know.
    assert.equal(home.syncs().slice(-1)[0]!.state, 'active')
  } finally {
    await agent.stop()
    await running
    await home.close()
  }
})

test('`runner status` reads the running agent\'s status: 0 while joined and syncing, 1 once it is stale, stopped or revoked', async () => {
  const home = await fakeHome()
  const { agent } = agentFor(home)
  const out: string[] = []
  const io = { out: (text: string) => out.push(text), err: () => undefined }
  const running = agent.run()
  try {
    await waitFor(() => fs.existsSync(layout.statusFile) && JSON.parse(fs.readFileSync(layout.statusFile, 'utf8')).homeVersion, 'a status after a sync')
    assert.equal(status(layout, io), 0)
    const said = JSON.parse(out.pop()!)
    assert.deepEqual({ joined: said.joined, home: said.home, state: said.state, held: said.held, version: said.version, homeVersion: said.homeVersion, compatible: said.compatible, approvedSlots: said.approvedSlots },
      { joined: true, home: home.url, state: 'active', held: 0, version: '0.24.0', homeVersion: '0.24.0', compatible: true, approvedSlots: null })
    // A status a minute and a half old is no running agent's.
    assert.equal(status(layout, io, Date.now() + 120_000), 1)
  } finally {
    await agent.stop()
    await running
    await home.close()
  }
  assert.equal(status(layout, io), 1)
  assert.equal(JSON.parse(out.pop()!).state, 'stopped')
  // Nothing at all on this tree.
  fs.rmSync(layout.statusFile, { force: true })
  fs.rmSync(layout.identityFile, { force: true })
  assert.equal(status(layout, io), 1)
  assert.equal(JSON.parse(out.pop()!).joined, false)
})

test('the command line refuses a machine started without what it needs, before it touches docker or home', async () => {
  const errors: string[] = []
  const io = { out: () => undefined, err: (text: string) => errors.push(text) }
  const base: NodeJS.ProcessEnv = { ...process.env, COLLOQ_RUNNER_STATE: TEST_ROOT }
  delete base.COLLOQ_RUNNER_JOIN
  delete base.DATA_HOST_DIR
  // No join and no identity.
  assert.equal(await main([], base, io), 78)
  assert.match(errors.join(''), /COLLOQ_RUNNER_JOIN/)
  // A join that is not https://<home>#<code>.
  assert.equal(await main([], { ...base, COLLOQ_RUNNER_JOIN: 'https://home.example/path#short' }, io), 78)
  // DATA_DIR outside the tree: the layout would not be where the mounts say.
  assert.equal(await main([], { ...base, COLLOQ_RUNNER_STATE: path.join(TEST_ROOT, 'elsewhere'), COLLOQ_RUNNER_JOIN: `https://home.example#${CODE}` }, io), 78)
  assert.match(errors.join(''), /DATA_DIR/)
  // DATA_HOST_DIR: a machine's paths are the host's own.
  assert.equal(await main([], { ...base, COLLOQ_RUNNER_JOIN: `https://home.example#${CODE}`, DATA_HOST_DIR: '/host/data' }, io), 78)
  assert.match(errors.join(''), /DATA_HOST_DIR/)
  // `join` takes exactly a URL and a code; anything else is a usage error.
  assert.equal(await main(['join', 'https://home.example'], base, io), 64)
  assert.equal(await main(['frobnicate'], base, io), 64)
  // `drain` with no agent: nothing held, and it says so.
  assert.equal(await main(['drain'], base, io), 1)
  // `leave` of a machine that never joined: nothing to leave.
  assert.equal(await main(['leave'], base, io), 0)
  assert.match(errors.join(''), /nothing to leave/)
  const out: string[] = []
  assert.equal(await main(['version'], base, { out: (text) => out.push(text), err: () => undefined }), 0)
  assert.match(out.join(''), /^\d+\.\d+\.\d+/)
})

test('`runner leave` with no agent running revokes the machine with the identity it has, after uploading what it wrote down', async () => {
  const home = await fakeHome()
  joinedBefore(home)
  const lease = makeLease({ data: 'f'.repeat(64) })
  writeLease(layout, { lease, receivedAt: Date.now() - 1000 })
  writeOutcome(layout, lease.attemptId, { kind: 'declined', reason: 'memory', detail: 'too big', startedAt: null })
  home.onSync = (body) => ({ json: syncReply({ seq: body.seq }), delayMs: 5 })
  const errors: string[] = []
  // The one-off container: the same tree and environment, the agent's container stopped.
  const docker = fakeAgentDocker()
  const seam = new FakeSeam()
  const code = await main(['leave'], { ...process.env, COLLOQ_RUNNER_STATE: TEST_ROOT, COLLOQ_RUNNER_JOIN: `${home.url}#${NEW_CODE}`, COLLOQ_RUNNER_IMAGE: 'ghcr.io/colloq-edu/colloq-server:0.24.0', COLLOQ_RUNNER_CONTAINER: '' }, { out: () => undefined, err: (text) => errors.push(text) }, { docker, runner: seam })
  try {
    assert.equal(code, 0, errors.join(''))
    // The written-down decline went first, then the leaving sync with nothing held; never a join with the new code.
    const order = home.calls.map((call) => (call.path.endsWith('/sync') ? `sync:${(call.body as RemoteSyncRequest).state}` : call.path.split('/').pop()))
    assert.ok(order.indexOf('outcome') >= 0 && order.indexOf('outcome') < order.indexOf('sync:leaving'), order.join(' '))
    assert.ok(!order.includes('join'))
    assert.ok(readIdentity(layout)!.leftAt !== undefined)
    // Its containers swept first. No COLLOQ_RUNNER_CONTAINER here (colloq-host turns the machine's restart policy off itself before
    // a one-off leave): no container of its own, so nothing is updated or inspected by a name that could be anyone's (§13c note 20).
    assert.ok(seam.sweeps >= 1)
    assert.ok(!docker.calls.some((args) => args[0] === 'update' || args[0] === 'inspect'), docker.calls.map((args) => args.join(' ')).join('\n'))
    // Gone already: a second leave has nothing to do.
    assert.equal(await main(['leave'], { ...process.env, COLLOQ_RUNNER_STATE: TEST_ROOT }, { out: () => undefined, err: () => undefined }), 0)
  } finally {
    await home.close()
  }
})

test('while home drains a trusted machine, the hidden test it still lists is not fetched again', async () => {
  const home = await fakeHome()
  joinedBefore(home)
  const hidden = dataSet({ 'test.csv': 'id\n2\n' })
  for (const [sha, body] of hidden.bodies) home.blobs.set(sha, body)
  let drain = false
  home.onSync = () => ({
    json: syncReply({ trusted: true, drain, want: { revisions: [], bundles: [], data: [{ competitionId: 'compabcd', manifest: hidden.manifest, sealed: true, files: hidden.files }] } }),
    delayMs: 20,
  })
  const { agent } = agentFor(home)
  const running = agent.run()
  try {
    await waitFor(() => home.syncs().some((sync) => sync.ready.sealed.includes(hidden.manifest)), 'the hidden test ready')
    drain = true
    await waitFor(() => fs.readdirSync(path.join(competitionsDir, '.sealed')).length === 0, 'the hidden test purged')
    const fetchedBefore = home.calls.filter((call) => call.path.includes('/blobs/')).length
    const syncsBefore = home.syncs().length
    await waitFor(() => home.syncs().length > syncsBefore + 3, 'more syncs while drained')
    assert.equal(home.calls.filter((call) => call.path.includes('/blobs/')).length, fetchedBefore, 'a drained machine fetched the hidden test again')
    assert.deepEqual(fs.readdirSync(path.join(competitionsDir, '.sealed')), [])
    assert.deepEqual(home.syncs().slice(-1)[0]!.ready.sealed, [])
  } finally {
    await agent.stop()
    await running
    await home.close()
  }
})

test('an outcome past its lease\'s ceiling at home, which has given it up, is discarded rather than asked again forever', async () => {
  const home = await fakeHome()
  joinedBefore(home)
  const lease = makeLease({ data: 'f'.repeat(64) })
  // Written down long ago: the ceiling and the upload's time again have passed.
  writeLease(layout, { lease, receivedAt: Date.now() - lease.deadlineMs - 11 * 60_000 })
  writeOutcome(layout, lease.attemptId, { kind: 'declined', reason: 'memory', detail: 'too big', startedAt: null })
  // Home is not reachable for outcomes: without the ceiling it would be tried forever.
  home.onOutcome = () => ({ status: 502, text: 'relay', marker: false })
  const { agent } = agentFor(home)
  const running = agent.run()
  try {
    await waitFor(() => !fs.existsSync(path.join(layout.leasesDir, `${lease.attemptId}.json`)), 'the expired outcome discarded')
    // The discard can come before the first sync is answered: wait for one, so the check below has a sync to look at.
    const syncs = await waitFor(() => home.syncs().length > 0 && home.syncs(), 'a sync')
    assert.ok(syncs.every((sync) => !attemptOf(sync, lease.attemptId)), 'an attempt past its ceiling was still reported')
  } finally {
    await agent.stop()
    await running
    await home.close()
  }
})

test('without COLLOQ_RUNNER_IMAGE the cards are probed with the image the agent\'s own container runs, as docker says', async () => {
  const home = await fakeHome()
  const { agent, docker } = agentFor(home, { image: null, container: 'colloq-runner' })
  const running = agent.run()
  try {
    await waitFor(() => docker.calls.some((args) => args[0] === 'run' && args.includes('nvidia-smi')), 'the card probe')
    assert.ok(docker.calls.some((args) => args.join(' ') === 'inspect -f {{.Config.Image}} colloq-runner'))
    const probe = docker.calls.find((args) => args[0] === 'run' && args.includes('nvidia-smi'))!
    assert.equal(probe[probe.indexOf('--gpus') + 1], 'all')
    assert.ok(probe.includes('ghcr.io/colloq-edu/colloq-server:0.24.0'))
  } finally {
    await agent.stop()
    await running
    await home.close()
  }
})

test('a stop tells home in one sync, held for no time, that the machine drains, listing what it holds, before it hands anything back', async () => {
  const home = await fakeHome()
  const set = dataSet({ 'train.csv': 'id\n1\n' })
  for (const [sha, body] of set.bodies) home.blobs.set(sha, body)
  const lease = makeLease({ data: set.manifest })
  offerWhenReady(home, set, lease)
  const { agent, seam } = agentFor(home)
  seam.next = 'wait'
  const running = agent.run()
  try {
    await waitFor(() => seam.runs.length === 1, 'the run')
    await agent.stop()
    await running
    const said = home.calls.filter((call) => call.path.endsWith('/sync') || call.path.endsWith(`/attempts/${lease.attemptId}/outcome`))
    const draining = said.findIndex((call) => call.path.endsWith('/sync') && (call.body as RemoteSyncRequest).state === 'draining')
    const handBack = said.findIndex((call) => call.path.endsWith('/outcome'))
    assert.ok(draining >= 0, 'no sync told home the machine drains')
    assert.ok(handBack > draining, 'the run was handed back before home heard the machine drains')
    const sync = said[draining]!.body as RemoteSyncRequest
    assert.equal(sync.holdMs, 0)
    // Level-triggered: the run is listed as it is, or home would count it lost at once.
    assert.equal(attemptOf(sync, lease.attemptId)?.phase, 'running')
    const posted = said[handBack]!.body as { kind: string; reason: string }
    assert.deepEqual({ kind: posted.kind, reason: posted.reason }, { kind: 'declined', reason: 'draining' })
  } finally {
    await home.close()
  }
})

test('revoked by its owner while it drains for a leave, the machine has left: `runner leave` hears that it left and was revoked, and no new code joins it again', async () => {
  const home = await fakeHome()
  joinedBefore(home)
  const set = dataSet({ 'train.csv': 'id\n1\n' })
  for (const [sha, body] of set.bodies) home.blobs.set(sha, body)
  const lease = makeLease({ data: set.manifest })
  offerWhenReady(home, set, lease)
  let revoked = false
  const answer = home.onSync
  home.onSync = (body, call) => (revoked ? { status: 401, json: { error: 'unauthorized' } } : answer(body, call))
  // A new code waits in COLLOQ_RUNNER_JOIN: a revoked machine that is not leaving would join with it.
  const { agent, seam } = agentFor(home, { join: { home: home.url, code: NEW_CODE } })
  seam.next = 'wait'
  const server = await serveControl(agent, layout.socket)
  const running = agent.run()
  try {
    await waitFor(() => seam.runs.length === 1, 'the run')
    const said: ControlMessage[] = []
    const leave = askAgent(layout.socket, 'leave', (message) => said.push(message))
    await waitFor(() => home.syncs().some((sync) => sync.state === 'draining'), 'the leave draining the machine')
    // The owner disconnects it meanwhile.
    revoked = true
    assert.equal(await leave, 'answered')
    assert.ok(said.some((message) => 'left' in message && message.revoked === true), JSON.stringify(said))
    const exit = await running
    assert.equal(exit.reason, 'revoked')
    assert.ok(!home.calls.some((call) => call.path.endsWith('/join')), 'a machine asked to leave joined again')
    assert.ok(readIdentity(layout)!.revokedAt !== undefined)
    assert.ok(seam.runs[0]!.signal?.aborted, 'the run of a revoked machine was not stopped')
  } finally {
    server.close()
    await home.close()
  }
})

test('with no container of its own (COLLOQ_RUNNER_CONTAINER unset), a revoked machine updates and inspects no container by name', async () => {
  const home = await fakeHome()
  joinedBefore(home)
  home.onSync = () => ({ status: 401, json: { error: 'unauthorized' } })
  const { agent, docker } = agentFor(home, { container: null, image: null })
  try {
    const exit = await agent.run()
    assert.equal(exit.reason, 'revoked')
    assert.ok(!docker.calls.some((args) => args[0] === 'update' || args[0] === 'inspect'), docker.calls.map((args) => args.join(' ')).join('\n'))
    // No image to start a check container from either: no card probe, no measure of Docker's disk.
    assert.ok(!docker.calls.some((args) => args[0] === 'run'))
  } finally {
    await home.close()
  }
})

test('a drain lets a held hidden-test run finish: what it reads stays until it has linked it, and the run is not declined', async () => {
  const home = await fakeHome()
  joinedBefore(home)
  const open = dataSet({ 'train.csv': 'id,y\n1,0\n' })
  const hidden = dataSet({ 'test.csv': 'id\n9\n' })
  for (const [sha, body] of [...open.bodies, ...hidden.bodies]) home.blobs.set(sha, body)
  const lease = makeLease({ data: open.manifest, sealed: true, sealedData: hidden.manifest })
  home.onSync = (body) => {
    const ready = body.ready.revisions.includes(REVISION.id) && body.ready.data.includes(open.manifest) && body.ready.sealed.includes(hidden.manifest)
    const leases = ready && !attemptOf(body, lease.attemptId) && body.seq < lease.seq ? [lease] : []
    const data = [{ competitionId: 'compabcd', manifest: open.manifest, sealed: false, files: open.files }, { competitionId: 'compabcd', manifest: hidden.manifest, sealed: true, files: hidden.files }]
    return { json: syncReply({ seq: lease.seq, leases, trusted: true, want: { revisions: [{ id: REVISION.id, ref: REVISION.ref, layers: LAYERS, gpu: false }], data, bundles: [] } }), delayMs: leases.length > 0 ? 0 : 20 }
  }
  const { agent, seam, docker } = agentFor(home)
  // The lease's image is checked once more right before its run (images.ts · verify), before it links the hidden test: held there, where a drain can come.
  let verifying = 0
  let release!: () => void
  const held = new Promise<void>((resolve) => (release = resolve))
  docker.intercept = async (args) => {
    if (args[0] === 'image' && args[1] === 'inspect' && args[2] === revisionImage(REVISION.id)) {
      verifying++
      await held
    }
  }
  const running = agent.run()
  try {
    await waitFor(() => verifying === 1, 'the lease checking its image')
    agent.requestDrain()
    release()
    await waitFor(() => seam.runs.length === 1, 'the hidden-test run, after the drain')
    assert.equal(seam.runs[0]!.sealedInputs, true)
    assert.equal(fs.readFileSync(path.join(seam.runs[0]!.dataDir, 'test.csv'), 'utf8'), 'id\n9\n')
    await waitFor(() => !fs.existsSync(path.join(layout.leasesDir, `${lease.attemptId}.json`)), 'the run settled')
    assert.ok(!home.calls.some((call) => call.path.endsWith(`/attempts/${lease.attemptId}/outcome`) && (call.body as { kind: string }).kind === 'declined'), 'the drain declined a run it was to finish')
    // Settled, it reads nothing more: a draining machine keeps none of the hidden test.
    await waitFor(() => fs.readdirSync(path.join(competitionsDir, '.sealed')).length === 0, 'the hidden test gone once the run is done')
  } finally {
    release()
    await agent.stop()
    await running
    await home.close()
  }
})

test('an outcome\'s reply that says the machine is no longer trusted purges the hidden test there and then, before any sync', async () => {
  const home = await fakeHome()
  joinedBefore(home)
  const open = dataSet({ 'train.csv': 'id,y\n1,0\n' })
  const hidden = dataSet({ 'test.csv': 'id\n4\n' })
  for (const [sha, body] of [...open.bodies, ...hidden.bodies]) home.blobs.set(sha, body)
  const lease = makeLease({ data: open.manifest })
  let trusted = true
  let hold: Promise<void> | null = null
  let releaseSyncs!: () => void
  home.onSync = async (body) => {
    // Once the run is listed, home's syncs wait: only the outcome's reply can say anything.
    if (attemptOf(body, lease.attemptId) && !hold) hold = new Promise<void>((resolve) => (releaseSyncs = resolve))
    if (hold) await hold
    const ready = body.ready.revisions.includes(REVISION.id) && body.ready.data.includes(open.manifest) && body.ready.sealed.includes(hidden.manifest)
    const leases = ready && !attemptOf(body, lease.attemptId) && body.seq < lease.seq ? [lease] : []
    const data = [{ competitionId: 'compabcd', manifest: open.manifest, sealed: false, files: open.files }, ...(trusted ? [{ competitionId: 'compabcd', manifest: hidden.manifest, sealed: true, files: hidden.files }] : [])]
    return { json: syncReply({ seq: lease.seq, leases, trusted, want: { revisions: [{ id: REVISION.id, ref: REVISION.ref, layers: LAYERS, gpu: false }], data, bundles: [] } }), delayMs: leases.length > 0 ? 0 : 20 }
  }
  let posted = false
  home.onOutcome = () => {
    posted = true
    trusted = false
    return { json: outcomeReply({ seq: lease.seq, trusted: false }) }
  }
  const { agent, seam } = agentFor(home)
  seam.next = 'wait'
  const running = agent.run()
  try {
    await waitFor(() => seam.runs.length === 1, 'the run')
    await waitFor(() => hold !== null, 'home holding its syncs')
    assert.ok(fs.readdirSync(path.join(competitionsDir, '.sealed')).length > 0)
    seam.release()
    await waitFor(() => posted, 'the outcome posted')
    await waitFor(() => fs.readdirSync(path.join(competitionsDir, '.sealed')).length === 0, 'the hidden test purged on the outcome\'s word')
    assert.equal(readIdentity(layout)!.trusted, false)
  } finally {
    releaseSyncs?.()
    await agent.stop()
    await running
    await home.close()
  }
})

test('a leave whose answer is lost and then meets the 401 of a machine home has marked left still purges the hidden test its last run read; so does any start of an identity that is gone', async () => {
  const home = await fakeHome()
  joinedBefore(home)
  const sealedDir = path.join(competitionsDir, '.sealed')
  const open = dataSet({ 'train.csv': 'id,y\n1,0\n' })
  const hidden = dataSet({ 'test.csv': 'id\n9\n' })
  for (const [sha, body] of [...open.bodies, ...hidden.bodies]) home.blobs.set(sha, body)
  const lease = makeLease({ data: open.manifest, sealed: true, sealedData: hidden.manifest })
  let left = false
  home.onSync = (body) => {
    if (left) return { status: 401, json: { error: 'unauthorized' } }
    // Home marks the machine left before it answers the leaving sync, and that answer is lost on the way (the relay's page).
    if (body.state === 'leaving') {
      left = true
      return { status: 502, text: '<html>Bad Gateway</html>', marker: false }
    }
    const ready = body.ready.revisions.includes(REVISION.id) && body.ready.data.includes(open.manifest) && body.ready.sealed.includes(hidden.manifest)
    const leases = ready && !attemptOf(body, lease.attemptId) && body.seq < lease.seq ? [lease] : []
    const data = [{ competitionId: 'compabcd', manifest: open.manifest, sealed: false, files: open.files }, { competitionId: 'compabcd', manifest: hidden.manifest, sealed: true, files: hidden.files }]
    // A draining sync is held as a long-poll is: the run's end cuts it short, so no draining reply comes after the run.
    return { json: syncReply({ seq: lease.seq, leases, trusted: true, want: { revisions: [{ id: REVISION.id, ref: REVISION.ref, layers: LAYERS, gpu: false }], data, bundles: [] } }), delayMs: leases.length > 0 ? 0 : body.state === 'draining' ? 3_000 : 20 }
  }
  home.onOutcome = () => ({ json: outcomeReply({ seq: lease.seq, trusted: true }) })
  const { agent, seam } = agentFor(home)
  seam.next = 'wait'
  const life = agent.run()
  try {
    await waitFor(() => seam.runs.length === 1, 'the hidden-test run')
    const leaving = agent.requestLeave()
    agent.leaveAcknowledged()
    await waitFor(() => home.syncs().some((sync) => sync.state === 'draining'), 'the leave draining the machine')
    assert.ok(fs.readdirSync(sealedDir).length > 0, 'the leave purged the hidden test a held run reads')
    seam.release()
    const exit = await life
    assert.equal(exit.reason, 'left')
    assert.equal(await leaving, 'left')
    assert.ok(home.syncs().filter((sync) => sync.state === 'leaving').length >= 2, 'the lost leaving sync was not asked again')
    assert.deepEqual(fs.readdirSync(sealedDir), [], 'a machine that left kept the hidden test')
    assert.ok(!fs.readdirSync(path.join(layout.booksDir, 'manifests')).some((name) => name.endsWith('.sealed.json')), 'a machine that left kept the hidden test\'s book')
  } finally {
    await home.close()
  }
  // What an earlier build left in the tree of a machine that has left: the next start of that identity purges it, without a call to home.
  const leftover = dataSet({ 'test.csv': 'id\n7\n' })
  const [file] = leftover.files
  fs.mkdirSync(sealedDir, { recursive: true })
  fs.writeFileSync(path.join(sealedDir, file!.sha256), leftover.bodies.get(file!.sha256)!)
  const book = path.join(layout.booksDir, 'manifests', `${leftover.manifest}.sealed.json`)
  fs.writeFileSync(book, JSON.stringify({ competitions: ['compabcd'], manifest: leftover.manifest, sealed: true, files: leftover.files }))
  const calls = home.calls.length
  const again = agentFor(home)
  const second = await again.agent.run()
  assert.equal(second.reason, 'left')
  assert.equal(home.calls.length, calls)
  assert.deepEqual(fs.readdirSync(sealedDir), [], 'a start of a machine that has left kept the hidden test')
  assert.ok(!fs.existsSync(book))
})

test('a start whose sweep the daemon does not answer gives up no lease of an earlier life until it does: the lease and its tree are kept, nothing is synced, and they go once no run of theirs runs', async () => {
  const home = await fakeHome()
  joinedBefore(home)
  const cutOff = makeLease({ data: 'f'.repeat(64), submissionId: 'subzombi' })
  writeLease(layout, { lease: cutOff, receivedAt: Date.now() - 30_000 })
  const tree = attemptPath('compabcd', cutOff.submissionId, cutOff.attemptId, 'result')
  fs.mkdirSync(tree, { recursive: true })
  const { agent, docker, seam, logs } = agentFor(home)
  // The earlier life's container still runs. The daemon, busy, fails `docker ps` for a while (the Docker runner's sweep skips it silently), then lists the container until a sweep removes it, the second after the daemon is back.
  let busy = true
  let stillRuns = true
  let asked = 0
  let removals = 0
  docker.intercept = (args) => {
    if (args[0] !== 'ps' || !args.includes('label=colloq.kind=competition-run')) return
    asked++
    if (busy) return { code: 1, out: 'Error response from daemon: context deadline exceeded' }
    return { code: 0, out: stillRuns ? 'abcdef012345\n' : '' }
  }
  seam.sweep = async () => {
    seam.sweeps++
    if (busy || ++removals < 2) return 0
    stillRuns = false
    return 1
  }
  const life = agent.run()
  try {
    await waitFor(() => asked >= 3, 'the daemon asked again')
    assert.ok(fs.existsSync(path.join(layout.leasesDir, `${cutOff.attemptId}.json`)), 'a lease was given up while its container may still run')
    assert.ok(fs.existsSync(tree), 'the tree of a run that may still run was deleted under it')
    assert.equal(home.syncs().length, 0, 'the machine synced before its earlier life\'s runs were known gone')
    assert.ok(seam.sweeps > 1, 'the sweep was not tried again')
    assert.match(JSON.parse(fs.readFileSync(layout.statusFile, 'utf8')).problem, /docker does not answer/)
    busy = false
    await waitFor(() => home.syncs().length > 0, 'the first sync, once the daemon has said none of them runs')
    assert.ok(logs.some((line) => /1 run\(s\) of an earlier life still run here/.test(line)), logs.join('\n'))
    assert.ok(!fs.existsSync(path.join(layout.leasesDir, `${cutOff.attemptId}.json`)))
    assert.ok(!fs.existsSync(tree))
    assert.ok(home.syncs().every((sync) => !attemptOf(sync, cutOff.attemptId)))
  } finally {
    await agent.stop()
    await life
    await home.close()
  }
})

test('a stop whose draining sync is answered with offers says their seq in one more sync, held for no time: home withdraws them at once', async () => {
  const home = await fakeHome()
  const set = dataSet({ 'train.csv': 'id\n1\n' })
  for (const [sha, body] of set.bodies) home.blobs.set(sha, body)
  const lease = makeLease({ data: set.manifest })
  const pending = makeLease({ data: set.manifest, submissionId: 'subpendg' })
  offerWhenReady(home, set, lease)
  const answer = home.onSync
  // The stop's draining sync: home repeats an offer it made the machine, whose reply the stop cut off on its way back.
  home.onSync = (body, call) => (body.state === 'draining'
    ? { json: syncReply({ seq: pending.seq, leases: body.seq < pending.seq ? [pending] : [], want: want(set) }) }
    : answer(body, call))
  const { agent, seam } = agentFor(home)
  seam.next = 'wait'
  const life = agent.run()
  try {
    await waitFor(() => seam.runs.length === 1, 'the run')
    await agent.stop()
    await life
    const draining = home.syncs().filter((sync) => sync.state === 'draining')
    assert.ok(draining.some((sync) => sync.seq >= pending.seq), `no sync said the seq of the offers the stop passed: ${draining.map((sync) => sync.seq).join(', ')} < ${pending.seq}`)
    assert.ok(draining.length <= 2 && draining.every((sync) => sync.holdMs === 0))
    assert.ok(!fs.existsSync(path.join(layout.leasesDir, `${pending.attemptId}.json`)), 'a stopping machine wrote down an offer')
    assert.ok(!home.calls.some((call) => call.path.includes(pending.attemptId)))
    assert.equal(seam.runs.length, 1)
  } finally {
    await home.close()
  }
})
