/**
 * The sandbox is the same on a machine as at home (docs/architecture/
 * remote-runners.md §1, acceptance): for the same request, the `docker run`
 * a machine's agent makes is the one home makes, flag for flag.
 *
 * Both go through the real DockerCompetitionRunner with its docker swapped
 * for one that records (useDockerForCompetitions): home's request as
 * runner.ts · runNotebookThenScore builds it, the machine's as its agent
 * builds it from a lease of the same row (execute.ts · prepareRun). The tree
 * is home's layout under the machine's DATA_DIR, so the attempt's result
 * folder, the notebook's folder, the package set's folder and a hidden-test
 * run's own /data are the very paths home would mount; only two things may
 * differ, and both are named: the image (home runs the revision by its local
 * id, the machine by the colloq-revision tag it gave the pulled pin) and the
 * folder of the open data (home's data/, the machine's inputs/<manifest12>/).
 * A flag lost on one side — `--network none`, `--read-only`, a share's cap,
 * `--pull=never` — is a sandbox that differs where nobody looks.
 */
import './_env.mts'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { DockerCompetitionRunner, useDockerForCompetitions } from '../server/src/competitions/docker-runner.ts'
import { limitsFor, type RunRequest } from '../server/src/competitions/runner-port.ts'
import { attemptDir, attemptPath, competitionsDir, inputDir, openDir } from '../server/src/competitions/storage.ts'
import { bundleDir } from '../server/src/dependencies/files.ts'
import { gpuSliceMb } from '../server/src/competitions/gpu-math.ts'
import { Cache } from '../server/src/runner-agent/cache.ts'
import { prepareRun, runPrepared } from '../server/src/runner-agent/execute.ts'
import { pickCard } from '../server/src/runner-agent/machine.ts'
import { INSTANCE_LABEL, revisionImage } from '../server/src/runner-agent/images.ts'
import type { Competition } from '../shared/competitions.ts'
import { TEST_ROOT } from './_env.mts'
import { REVISION, dataSet, hex, makeLease, sha256 } from './_runner-agent-home.mts'

const PICTURE = { memTotalMb: 128_000, memAvailableMb: 120_000, cpus: 32, diskFreeMb: 500_000, diskTotalMb: 1_000_000 }
const CARDS = [{ device: '0', name: 'NVIDIA GeForce RTX 4090', memoryMb: 24_564 }, { device: '1', name: 'NVIDIA GeForce RTX 4090', memoryMb: 24_564 }]

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

/** The machine's cache with the lease's blobs already in place: nothing is fetched here. */
function cacheWith(blobs: Map<string, Buffer>, sealed: Map<string, Buffer> = new Map()): Cache {
  for (const [dir, set] of [[path.join(competitionsDir, '.blobs'), blobs], [path.join(competitionsDir, '.sealed'), sealed]] as const) {
    fs.mkdirSync(dir, { recursive: true })
    for (const [sha, body] of set) fs.writeFileSync(path.join(dir, sha), body, { mode: 0o644 })
  }
  const cache = new Cache({ client: { blob: () => { throw new Error('nothing is fetched in this test') } }, books: path.join(TEST_ROOT, 'books'), log: () => undefined })
  cache.load()
  return cache
}

/** The image argument (after `--entrypoint python`) and the open data's mount source named, everything else as it is. */
function named(args: string[], openData: string | null): string[] {
  const image = args.indexOf('--entrypoint') + 2
  return args.map((arg, index) => {
    if (index === image) return '<image>'
    if (openData !== null && arg === `${openData}:/data:ro`) return '<open data>:/data:ro'
    return arg
  })
}

const competition = { limits: { wallSeconds: 600, memoryMb: 8192, cpus: 4, perDay: 5, gpu: true } } as unknown as Competition

async function agentArgs(lease: ReturnType<typeof makeLease>, cache: Cache): Promise<{ args: string[]; request: Omit<RunRequest, 'signal' | 'onProgress'> }> {
  const docker = recording()
  try {
    const prepared = await prepareRun({
      lease,
      receivedAt: Date.now(),
      cache,
      images: { verify: async () => revisionImage(REVISION.id) },
      picture: PICTURE,
      holding: [{ memoryMb: lease.limits.memoryMb, cpus: lease.limits.cpus }],
      heldMb: 0,
      attempts: 1,
      trusted: true,
      cards: CARDS,
      claimCard: (perDevice) => pickCard(CARDS, perDevice, [{ device: '0', perDevice: 2 }]),
      described: async () => undefined,
      signal: new AbortController().signal,
    })
    assert.ok(prepared.ok, prepared.ok ? '' : JSON.stringify(prepared.decline))
    await runPrepared(new DockerCompetitionRunner(), prepared.run, new AbortController().signal, () => undefined)
    assert.equal(docker.runs.length, 1)
    return { args: docker.runs[0]!, request: prepared.run.request }
  } finally {
    docker.restore()
  }
}

async function homeArgs(request: RunRequest): Promise<string[]> {
  const docker = recording()
  try {
    await new DockerCompetitionRunner().run(request)
    assert.equal(docker.runs.length, 1)
    return docker.runs[0]!
  } finally {
    docker.restore()
  }
}

test('a CPU notebook: the machine\'s argv is home\'s, the image and the open data\'s folder aside', async () => {
  const set = dataSet({ 'train.csv': 'id,x\n1,2\n', 'test.csv': 'id\n1\n' })
  const cache = cacheWith(set.bodies)
  cache.want([{ competitionId: 'compabcd', manifest: set.manifest, sealed: false, files: set.files }], [])
  const limits = limitsFor({ limits: { wallSeconds: 300, memoryMb: 4096, cpus: 2, perDay: 5 } } as unknown as Competition, 'notebook')
  const lease = makeLease({ data: set.manifest, submissionId: 'subcpucp', limits })
  const machine = await agentArgs(lease, cache)
  // Home's request for the same row (runner.ts · runNotebookThenScore).
  const home = await homeArgs({
    imageDigest: `sha256:${'ab'.repeat(32)}`,
    competition: { id: 'compabcd', environment: 'kaggle-base' },
    submissionId: lease.submissionId,
    attemptId: lease.attemptId,
    container: lease.container,
    dataDir: openDir('compabcd'),
    inputDir: inputDir('compabcd', lease.submissionId),
    resultDir: attemptDir('compabcd', lease.submissionId, lease.attemptId),
    limits,
  })
  assert.deepEqual(named(machine.args, machine.request.dataDir), named(home, openDir('compabcd')))
  // What differs is what is named: the image is the pulled pin under its tag, the data the manifest's folder of links.
  assert.equal(machine.args[machine.args.indexOf('--entrypoint') + 2], revisionImage(REVISION.id))
  assert.ok(machine.args.includes(`${path.join(competitionsDir, 'compabcd', 'inputs', set.manifest.slice(0, 12))}:/data:ro`))
  for (const flag of ['--pull=never', '--read-only', '--cap-drop=ALL', '--security-opt=no-new-privileges', '--restart=no']) assert.ok(machine.args.includes(flag), flag)
  assert.equal(machine.args[machine.args.indexOf('--network') + 1], 'none')
  // The tree's instance label, as the runner itself puts it on its runs, is the one the agent's own check containers carry (images.ts · INSTANCE_LABEL).
  const labels = machine.args.flatMap((arg, index) => (machine.args[index - 1] === '--label' ? [arg] : []))
  assert.ok(labels.includes(INSTANCE_LABEL), `${INSTANCE_LABEL} is not among ${labels.join(', ')}`)
})

test('a GPU notebook with a package set: the card\'s share, its caps and the set\'s room are home\'s', async () => {
  const set = dataSet({ 'train.csv': 'id,x\n1,2\n' })
  const wheel = Buffer.from('a wheel of bytes')
  const bundleId = hex(16)
  const cache = cacheWith(new Map([...set.bodies, [sha256(wheel), wheel]]))
  cache.want([{ competitionId: 'compabcd', manifest: set.manifest, sealed: false, files: set.files }], [
    { id: bundleId, packagesMb: 512, lock: 'pkg==1.0 --hash=sha256:aa\n', wheels: [{ fileName: 'pkg-1.0-py3-none-any.whl', sha256: sha256(wheel), bytes: wheel.length }] },
  ])
  const limits = limitsFor(competition, 'notebook')
  const lease = makeLease({ data: set.manifest, submissionId: 'subgpugp', limits, gpu: true, perDevice: 2, bundle: { id: bundleId, packagesMb: 512 } })
  const machine = await agentArgs(lease, cache)
  // Card 0 holds a run already, so the less loaded card 1 is the one, as home's pick takes it.
  assert.equal(machine.request.gpu?.device, '1')
  const home = await homeArgs({
    imageDigest: `sha256:${'cd'.repeat(32)}`,
    dependenciesDir: bundleDir(bundleId),
    packagesMb: 512,
    competition: { id: 'compabcd', environment: 'kaggle-gpu' },
    submissionId: lease.submissionId,
    attemptId: lease.attemptId,
    container: lease.container,
    dataDir: openDir('compabcd'),
    inputDir: inputDir('compabcd', lease.submissionId),
    resultDir: attemptDir('compabcd', lease.submissionId, lease.attemptId),
    limits,
    gpu: { device: '1', sliceMb: gpuSliceMb(24_564, 2), perDevice: 2 },
  })
  assert.deepEqual(named(machine.args, machine.request.dataDir), named(home, openDir('compabcd')))
  // The share is capped inside and watched outside, as at home: the allocator's cap and the card's size go in.
  assert.ok(machine.args.some((arg) => arg.startsWith('COLLOQ_GPU_MEMORY_MB=')))
  assert.ok(machine.args.includes('device=1'))
  assert.ok(machine.args.includes(`${bundleDir(bundleId)}:/deps:ro`))
  assert.ok(machine.args.some((arg) => arg.startsWith('--tmpfs=/packages:') && arg.includes('size=512m')))
})

test('a hidden-test notebook: its own composed /data is the very folder home would mount', async () => {
  const open = dataSet({ 'train.csv': 'id,y\n1,0\n', 'test.csv': 'id\n1\n' })
  const hidden = dataSet({ 'test.csv': 'id\n5\n6\n' })
  const cache = cacheWith(open.bodies, hidden.bodies)
  cache.want([
    { competitionId: 'compabcd', manifest: open.manifest, sealed: false, files: open.files },
    { competitionId: 'compabcd', manifest: hidden.manifest, sealed: true, files: hidden.files },
  ], [])
  const limits = limitsFor({ limits: { wallSeconds: 300, memoryMb: 4096, cpus: 2, perDay: 5 } } as unknown as Competition, 'notebook')
  const lease = makeLease({ data: open.manifest, sealed: true, sealedData: hidden.manifest, submissionId: 'subseals', limits })
  const machine = await agentArgs(lease, cache)
  const sealedData = attemptPath('compabcd', lease.submissionId, lease.attemptId, 'inputs')
  assert.equal(machine.request.dataDir, sealedData)
  assert.equal(machine.request.sealedInputs, true)
  assert.equal(fs.readFileSync(path.join(sealedData, 'test.csv'), 'utf8'), 'id\n5\n6\n')
  const home = await homeArgs({
    imageDigest: `sha256:${'ef'.repeat(32)}`,
    competition: { id: 'compabcd', environment: 'base' },
    submissionId: lease.submissionId,
    attemptId: lease.attemptId,
    container: lease.container,
    dataDir: sealedData,
    sealedInputs: true,
    inputDir: inputDir('compabcd', lease.submissionId),
    resultDir: attemptDir('compabcd', lease.submissionId, lease.attemptId),
    limits,
  })
  // Not even the data folder differs: only the image does.
  assert.deepEqual(named(machine.args, null), named(home, null))
})
