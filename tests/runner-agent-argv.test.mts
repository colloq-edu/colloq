/**
 * The sandbox is the same on a machine as at home (docs/architecture/
 * remote-runners.md §1, acceptance): for the same row, the `docker run` a
 * machine's agent makes is the one home makes, flag for flag.
 *
 * BOTH SIDES ARE BUILT BY THEIR OWN CODE FROM ONE REAL ROW, never by a request
 * typed out here. The machine's lease is the one home's take makes for the row
 * (competitions/remote/lease.ts · takeForRunner, then the offer as a reply
 * carries it: pendingOffers), and the agent prepares it as it would
 * (execute.ts · prepareRun). Home's request is the one its own pump makes for
 * the same row once that offer is withdrawn (runner.ts · runNotebookThenScore,
 * through a runner of the docker backend that records it, so that home lays
 * out the data, verifies the package set and picks the card as a run here
 * does). A request literal in this file once stood for home's, and both sides
 * then went through the same runArgs: drift inside the agent was caught,
 * drift between the agent and home never — a package set's room computed
 * anew at home, a card's share, a field added to home's request, and the
 * machines would run another sandbox than home for the same row while this
 * file stayed green.
 *
 * Both go through the real DockerCompetitionRunner with its docker swapped for
 * one that records (useDockerForCompetitions). The tree is home's layout under
 * the machine's DATA_DIR, so the notebook's folder, the package set's folder
 * and the harness are the very paths home would mount. Only what is not the
 * sandbox may differ, and each is named: the image (home runs the revision by
 * its local id, the machine by the colloq-revision tag it gave the pulled
 * pin), the folder of the open data (home's data/, the machine's
 * inputs/<manifest12>/), and the attempt's id and container's name (the
 * machine's offer and home's run are two takes of the row, each with its own).
 * A flag lost on one side — `--network none`, `--read-only`, a share's cap,
 * `--pull=never` — is a sandbox that differs where nobody looks.
 */
import './_env.mts'
import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import type { RemoteLease } from '../shared/remote-runner.ts'
import { DockerCompetitionRunner, useDockerForCompetitions } from '../server/src/competitions/docker-runner.ts'
import { FakeCompetitionRunner } from '../server/src/competitions/fake-runner.ts'
import { useCompetitionRunner, type CompetitionRunner, type RunRequest } from '../server/src/competitions/runner-port.ts'
import { drainCompetitionQueue, setQueueSlots } from '../server/src/competitions/runner.ts'
import { attemptPath, competitionsDir, openDir, sealedDir } from '../server/src/competitions/storage.ts'
import { joinRunner } from '../server/src/competitions/remote/store.ts'
import { pendingOffers, runnerOffer, takeForRunner } from '../server/src/competitions/remote/lease.ts'
import { withdrawLease } from '../server/src/competitions/remote/release.ts'
import { dataNow } from '../server/src/competitions/remote/want.ts'
import { saveCompetitionSettings } from '../server/src/competitions/settings.ts'
import { bundleDir } from '../server/src/dependencies/files.ts'
import { bindSubmission, completeBundle, createBundle, setPolicy } from '../server/src/dependencies/store.ts'
import { useGpuCardProbe } from '../server/src/kernel/resources.ts'
import { Cache } from '../server/src/runner-agent/cache.ts'
import { prepareRun, runPrepared } from '../server/src/runner-agent/execute.ts'
import { pickCard } from '../server/src/runner-agent/machine.ts'
import { INSTANCE_LABEL, revisionImage } from '../server/src/runner-agent/images.ts'
import { TEST_ROOT } from './_env.mts'
import { FACTS, code, competition, reset, send, syncRequest, type TestCompetition } from './_remote.mts'
import { sha256 } from './_runner-agent-home.mts'

const PICTURE = { memTotalMb: 128_000, memAvailableMb: 120_000, cpus: 32, diskFreeMb: 500_000, diskTotalMb: 1_000_000 }
const RTX = { name: 'NVIDIA GeForce RTX 4090', memoryMb: 24_564 }
/** The machine's cards: the same card as home's, two of them. */
const CARDS = [{ device: '0', ...RTX }, { device: '1', ...RTX }]
const GPU_ENV = ['KERNEL_GPUS', 'COMPETITION_GPUS', 'COMPETITION_GPU_PER_DEVICE'] as const
/** A notebook home's stand-in runs as a failed cell: no metric follows the run this file records. */
const FAILING = '# colloq-test: {"status": "cell_error", "cell": 0, "detail": "ValueError: the sandbox is what is compared"}'

after(() => {
  useCompetitionRunner(null)
  useDockerForCompetitions(null)
})

/** The docker the Docker runner calls, recording every `run` and answering as a daemon whose container ended at once. */
function recording(): { runs: string[][]; restore: () => void } {
  const runs: string[][] = []
  useDockerForCompetitions(async (args) => {
    if (args[0] === 'run') runs.push(args)
    if (args[0] === 'inspect' && args.includes('{{.State.Running}}')) return { code: 0, out: 'false' }
    if (args[0] === 'inspect') return { code: 0, out: 'exited 0 false' }
    return { code: 0, out: '' }
  })
  return { runs, restore: () => useDockerForCompetitions(null) }
}

/** The `docker run` of a request, through the real Docker runner. */
async function argvOf(run: (runner: DockerCompetitionRunner) => Promise<unknown>): Promise<string[]> {
  const docker = recording()
  try {
    await run(new DockerCompetitionRunner())
    assert.equal(docker.runs.length, 1)
    return docker.runs[0]!
  } finally {
    docker.restore()
  }
}

/**
 * The argv with what is not the sandbox named (see the header): the image
 * (the argument after `--entrypoint python`), the open data's mount source,
 * the container's name and the attempt's id wherever they appear.
 */
function named(args: string[], own: { container: string; attemptId: string; openData: string | null }): string[] {
  const image = args.indexOf('--entrypoint') + 2
  return args.map((arg, index) => {
    if (index === image) return '<image>'
    if (own.openData !== null && arg === `${own.openData}:/data:ro`) return '<open data>:/data:ro'
    return arg.split(own.container).join('<container>').split(own.attemptId).join('<attempt>')
  })
}

/** A machine as home's join makes it. */
function machine(trusted: boolean) {
  const joined = joinRunner({ code: code({ trusted }), joinId: randomUUID().replaceAll('-', ''), build: 'dev', facts: FACTS, address: null }, Date.now())
  assert.ok(joined.ok)
  return joined.runner
}

/** Home's take of the row for a machine that has everything in place, and the offer as a reply carries it to the machine. */
function homeLease(c: TestCompetition, submissionId: string, options: { gpu: boolean; sealed: boolean }): RemoteLease {
  const runner = machine(options.sealed)
  const sets = dataNow(c.id)
  const sync = syncRequest({
    free: { ...syncRequest().free, gpuShares: options.gpu ? 2 : 0 },
    ready: { revisions: [c.revisionId], data: [sets.open!.manifest], sealed: options.sealed ? [sets.sealed!.manifest] : [], bundles: [] },
  })
  const taken = takeForRunner(runner, runnerOffer(runner, sync.free, sync), Date.now())
  assert.deepEqual(taken.map((lease) => lease.submissionId), [submissionId], 'home did not lease the row to the machine')
  const offered = pendingOffers(runner.id, Date.now()).find((lease) => lease.submissionId === submissionId)
  assert.ok(offered)
  return offered
}

/** The machine's cache, with the lease's blobs in it as a prefetch leaves them (read from home's own files) and its data and set described. */
function machineCache(c: TestCompetition, lease: RemoteLease, bundle: { lock: string; wheel: { fileName: string; body: Buffer } } | null): Cache {
  const sets = dataNow(c.id)
  const put = (dir: string, body: Buffer): void => {
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, sha256(body)), body, { mode: 0o644 })
  }
  for (const file of sets.open!.files) put(path.join(competitionsDir, '.blobs'), fs.readFileSync(path.join(openDir(c.id), file.name)))
  for (const file of sets.sealed?.files ?? []) put(path.join(competitionsDir, '.sealed'), fs.readFileSync(path.join(sealedDir(c.id), file.name)))
  if (bundle) put(path.join(competitionsDir, '.blobs'), bundle.wheel.body)
  const cache = new Cache({ client: { blob: () => { throw new Error('nothing is fetched in this test') } }, books: path.join(TEST_ROOT, 'books'), log: () => undefined })
  cache.load()
  cache.want([
    { competitionId: c.id, manifest: sets.open!.manifest, sealed: false, files: sets.open!.files },
    ...(lease.sealed && sets.sealed ? [{ competitionId: c.id, manifest: sets.sealed.manifest, sealed: true, files: sets.sealed.files }] : []),
  ], bundle && lease.bundle
    ? [{ id: lease.bundle.id, packagesMb: lease.bundle.packagesMb, lock: bundle.lock, wheels: [{ fileName: bundle.wheel.fileName, sha256: sha256(bundle.wheel.body), bytes: bundle.wheel.body.length }] }]
    : [])
  return cache
}

/** The machine's request and argv for a lease, as its agent prepares and runs it (no card of it taken yet, as home's is not). */
async function machineArgs(lease: RemoteLease, cache: Cache): Promise<{ args: string[]; request: Omit<RunRequest, 'signal' | 'onProgress'> }> {
  const prepared = await prepareRun({
    lease,
    receivedAt: Date.now(),
    cache,
    images: { verify: async () => revisionImage(lease.revision.id) },
    picture: PICTURE,
    holding: [{ memoryMb: lease.limits.memoryMb, cpus: lease.limits.cpus }],
    heldMb: 0,
    attempts: 1,
    trusted: true,
    cards: CARDS,
    claimCard: (perDevice) => pickCard(CARDS, perDevice, []),
    described: async () => undefined,
    signal: new AbortController().signal,
  })
  assert.ok(prepared.ok, prepared.ok ? '' : JSON.stringify(prepared.decline))
  const args = await argvOf((runner) => runPrepared(runner, prepared.run, new AbortController().signal, () => undefined))
  return { args, request: prepared.run.request }
}

/**
 * Home's own request for the row, as its pump makes one (runner.ts ·
 * runNotebookThenScore): a run here through a runner of the docker backend
 * that records the request and answers as the suite's stand-in does.
 */
async function homeRequest(submissionId: string): Promise<Omit<RunRequest, 'signal' | 'onProgress'>> {
  const stand = new FakeCompetitionRunner()
  const recorded: RunRequest[] = []
  const recorder: CompetitionRunner = {
    backend: 'docker',
    run: async (request) => {
      recorded.push(request)
      return stand.run(request)
    },
    score: (request) => stand.score(request),
    kill: (container) => stand.kill(container),
    sweep: () => stand.sweep(),
    capacity: () => stand.capacity(),
  }
  useCompetitionRunner(recorder)
  try {
    await drainCompetitionQueue()
  } finally {
    useCompetitionRunner(null)
  }
  const found = recorded.find((request) => request.submissionId === submissionId)
  assert.ok(found, 'home ran nothing for the row')
  const { signal: _signal, onProgress: _progress, ...request } = found
  return request
}

/** One row, leased by home's take and prepared on the machine, then run by home's own pump; both argv, and what each run was given. */
async function bothSides(options: { gpu?: boolean; sealed?: boolean; bundle?: boolean } = {}) {
  const gpu = options.gpu === true
  const sealed = options.sealed === true
  reset({ homeNotebooks: true })
  setQueueSlots(1)
  const c = competition({ gpu, sealed, memoryMb: 4096, cpus: 2 })
  const sent = send(c, { cells: [FAILING], revisionId: options.bundle ? null : undefined })
  let bundle: { lock: string; wheel: { fileName: string; body: Buffer } } | null = null
  if (options.bundle) {
    // A ready set as home keeps it: its row, and its published folder, which home verifies before a run here.
    const MiB = 1024 * 1024
    const body = Buffer.from(`a wheel of the parity test, ${c.id}`)
    const wheel = { fileName: 'catboost-1.2.10-py3-none-any.whl', body }
    const lock = `catboost==1.2.10 --hash=sha256:${sha256(body)}\n`
    setPolicy(c.id, { enabled: true })
    const set = createBundle(c.id, sent.entrantId, c.revisionId, 'catboost')
    assert.equal(completeBundle(set.id, {
      normalizedRequirements: ['catboost'], downloadBytes: body.length, installedBytes: 300 * MiB, contentHash: '3'.repeat(64),
      packages: [{ name: 'catboost', version: '1.2.10', fileName: wheel.fileName, sha256: sha256(body), bytes: body.length }],
      lock,
    }), true)
    fs.mkdirSync(path.join(bundleDir(set.id), 'wheels'), { recursive: true })
    fs.writeFileSync(path.join(bundleDir(set.id), 'wheels', wheel.fileName), body)
    fs.writeFileSync(path.join(bundleDir(set.id), 'requirements.lock'), lock)
    bindSubmission(sent.id, c.revisionId, set.id)
    bundle = { lock, wheel }
  }
  const lease = homeLease(c, sent.id, { gpu, sealed })
  const onMachine = await machineArgs(lease, machineCache(c, lease, bundle))
  // The /data the machine's run was given, as it was (a withdrawn offer's attempt tree goes with it).
  const data = Object.fromEntries(fs.readdirSync(onMachine.request.dataDir).sort().map((name) => [name, fs.readFileSync(path.join(onMachine.request.dataDir, name), 'utf8')]))
  // The offer goes back to the queue unacked, with nothing counted, and home's pump takes the row itself.
  assert.ok(withdrawLease(lease.attemptId, Date.now(), 'unacked'))
  const request = await homeRequest(sent.id)
  const atHome = await argvOf((runner) => runner.run(request as RunRequest))
  return {
    c,
    lease,
    machine: { ...onMachine, data },
    home: { args: atHome, request },
    compare: (openData: { machine: string | null; home: string | null }) => assert.deepEqual(
      named(onMachine.args, { container: lease.container, attemptId: lease.attemptId, openData: openData.machine }),
      named(atHome, { container: request.container, attemptId: request.attemptId!, openData: openData.home }),
    ),
  }
}

test('a CPU notebook: the machine\'s argv is home\'s for the same row, the image, the open data\'s folder and the attempt aside', async () => {
  const sides = await bothSides()
  sides.compare({ machine: sides.machine.request.dataDir, home: openDir(sides.c.id) })
  // What differs is what is named: the image is the pulled pin under its tag, the data the manifest's folder of links.
  const args = sides.machine.args
  assert.equal(args[args.indexOf('--entrypoint') + 2], revisionImage(sides.lease.revision.id))
  assert.ok(args.includes(`${path.join(competitionsDir, sides.c.id, 'inputs', sides.lease.data.slice(0, 12))}:/data:ro`))
  assert.equal(sides.home.request.dataDir, openDir(sides.c.id))
  for (const flag of ['--pull=never', '--read-only', '--cap-drop=ALL', '--security-opt=no-new-privileges', '--restart=no']) assert.ok(args.includes(flag), flag)
  assert.equal(args[args.indexOf('--network') + 1], 'none')
  // The tree's instance label, as the runner itself puts it on its runs, is the one the agent's own check containers carry (images.ts · INSTANCE_LABEL).
  const labels = args.flatMap((arg, index) => (args[index - 1] === '--label' ? [arg] : []))
  assert.ok(labels.includes(INSTANCE_LABEL), `${INSTANCE_LABEL} is not among ${labels.join(', ')}`)
})

test('a GPU notebook with a package set: the card\'s share, its caps and the set\'s room are home\'s for the same row', async () => {
  process.env.KERNEL_GPUS = '0'
  process.env.COMPETITION_GPUS = '0'
  process.env.COMPETITION_GPU_PER_DEVICE = '2'
  saveCompetitionSettings({ gpuDevices: null, gpuPerDevice: null })
  useGpuCardProbe(async (devices) => new Map(devices.map((device) => [device, RTX])))
  try {
    const sides = await bothSides({ gpu: true, bundle: true })
    // The share both runs were given, each by its own side's pick and arithmetic.
    assert.deepEqual(sides.machine.request.gpu, sides.home.request.gpu)
    assert.equal(sides.home.request.gpu?.perDevice, 2)
    assert.equal(sides.machine.request.packagesMb, sides.home.request.packagesMb)
    assert.equal(sides.machine.request.dependenciesDir, sides.home.request.dependenciesDir)
    sides.compare({ machine: sides.machine.request.dataDir, home: openDir(sides.c.id) })
    const args = sides.machine.args
    // The share is capped inside and watched outside, as at home: the allocator's cap and the card's size go in.
    assert.ok(args.some((arg) => arg.startsWith('COLLOQ_GPU_MEMORY_MB=')))
    assert.ok(args.includes(`device=${sides.home.request.gpu!.device}`))
    assert.ok(args.includes(`${sides.home.request.dependenciesDir}:/deps:ro`))
    assert.ok(args.some((arg) => arg.startsWith('--tmpfs=/packages:') && arg.includes(`size=${sides.home.request.packagesMb}m`)))
  } finally {
    for (const name of GPU_ENV) delete process.env[name]
    useGpuCardProbe(null)
  }
})

test('a hidden-test notebook: each side composes the run\'s own /data, and the two differ only by the attempt they are for', async () => {
  const sides = await bothSides({ sealed: true })
  const own = (attemptId: string): string => attemptPath(sides.c.id, sides.lease.submissionId, attemptId, 'inputs')
  assert.equal(sides.machine.request.dataDir, own(sides.lease.attemptId))
  assert.equal(sides.home.request.dataDir, own(sides.home.request.attemptId!))
  assert.equal(sides.machine.request.sealedInputs, true)
  assert.equal(sides.home.request.sealedInputs, true)
  // The open files with the hidden one put over them by name, as home composes its own.
  assert.equal(sides.machine.data['test.csv'], 'id,feature\n101,hidden\n')
  assert.deepEqual(Object.keys(sides.machine.data), ['sample_submission.csv', 'test.csv', 'train.csv'])
  // Not even the data folder differs, but for the attempt in its path.
  sides.compare({ machine: null, home: null })
})
