/**
 * A submission on a share of a video card: the container line, the watchdog
 * that holds the share from outside, the harness's sitecustomize that holds
 * it from inside, the card a stuck container keeps, and the words a run
 * stopped for its card ends with.
 *
 * Each of these fails quietly. A lost `--network none` on the GPU line is a
 * submission with internet access, noticed only by whoever uses it. A GPU flag
 * leaking into the CPU line changes every existing competition. A metric
 * container with a card is a card next to the hidden answers. A watchdog that
 * kills on one failed `docker exec` stops honest runs on a busy daemon; one
 * that never kills — or that the notebook it watches can stall or blind —
 * lets one notebook take the memory of every other run on its card. A
 * container whose removal failed but whose card is counted free puts a fifth
 * run on a card shared by four. A cap that a library's "is torch installed?"
 * takes away, or a CatBoost pool sized to the whole card, turns the share into
 * a promise. And a blind participant told how far past its share their run
 * went has been handed a number their notebook chose while it read the hidden
 * test.
 *
 * No docker and no card: the commands are pure functions, the daemon is a
 * stand-in, and the sitecustomize runs under a real python against stand-in
 * `torch` and `catboost` packages.
 */
import './_env.mts'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { setLocaleResolver, tr } from '../shared/i18n.js'
import { getInstanceLanguage } from '../server/src/admin/settings.js'
import type { Competition } from '../shared/competitions.js'
import {
  competitionDockerDiagnostics,
  gpuOverShare,
  heldShareMb,
  parseGpuMemory,
  runArgs,
  scoreArgs,
  unreadCardNotes,
  useDockerForCompetitions,
  verdictOfRun,
  METRIC_NAME,
  SOLUTION_NAME,
  SUBMISSION_NAME,
  VRAM_UNREAD_LIMIT,
} from '../server/src/competitions/docker-runner.js'
import { brokerHarnessDir, harnessDir, HARNESS_SITE } from '../server/src/competitions/harness.js'
import { FakeCompetitionRunner } from '../server/src/competitions/fake-runner.js'
import {
  CLUSTER_GPU,
  competitionRunner,
  forgetCompetitionRunner,
  limitsFor,
  useCompetitionRunner,
  type RunOutcome,
  type RunRequest,
} from '../server/src/competitions/runner-port.js'
import { briefNote, errorTypeOf, gpuKillNote, gpuMemoryHint, notebookNote, teacherNote } from '../server/src/competitions/runner.js'
import { GPU_CONTEXT_MB, GPU_TOLERANCE_MB } from '../server/src/competitions/gpu.js'
import { competitionsDir } from '../server/src/competitions/storage.js'

/* ------------------------------------------------------------------ setup */

const runner = new FakeCompetitionRunner()
useCompetitionRunner(runner)

const COMPETITION = { limits: { wallSeconds: 600, memoryMb: 4096, cpus: 2, perDay: 5, gpu: true } } as Competition
const LIMITS = limitsFor(COMPETITION, 'notebook')

/** One run's paths and limits, as the runner hands them to `runArgs`. */
const CPU_RUN = {
  attemptId: 'a'.repeat(32),
  container: 'colloq-comp-s1-0123abcd-run',
  image: 'sha256:pinned',
  dataDir: '/data/competitions/c1/data',
  inputDir: '/data/competitions/c1/s/s1/in',
  resultDir: '/data/competitions/c1/s/s1/out',
  limits: LIMITS,
  target: SUBMISSION_NAME,
}

/** A card shared by four runs, 6 GB each (a 24 GB card). */
const SHARED: NonNullable<RunRequest['gpu']> = { device: '1', sliceMb: 6144, perDevice: 4 }

/** Whether a call to the stand-in daemon is the watchdog's sample of the card. */
const isSample = (args: string[]): boolean => args[0] === 'exec' && args.includes('nvidia-smi')

/** The value after a flag given as two arguments (`--gpus device=1`). */
const valueOf = (args: string[], flag: string): string | undefined => {
  const at = args.indexOf(flag)
  return at >= 0 ? args[at + 1] : undefined
}

/** Every `-e NAME=value` of a line, as a map. */
function envOf(args: string[]): Map<string, string> {
  const env = new Map<string, string>()
  args.forEach((arg, at) => {
    if (args[at - 1] !== '-e') return
    const eq = arg.indexOf('=')
    env.set(arg.slice(0, eq), arg.slice(eq + 1))
  })
  return env
}

/** Words in English, then back to the instance's language whatever happens. */
function inEnglish<T>(body: () => T): T {
  setLocaleResolver(() => 'en')
  try {
    return body()
  } finally {
    setLocaleResolver(getInstanceLanguage)
  }
}

function inRussian<T>(body: () => T): T {
  setLocaleResolver(() => 'ru')
  try {
    return body()
  } finally {
    setLocaleResolver(getInstanceLanguage)
  }
}

async function until(reached: () => boolean, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!reached()) {
    if (Date.now() > deadline) throw new Error('the condition was never reached')
    await new Promise<void>((resolve) => setTimeout(resolve, 10))
  }
}

/** The docker runner behind a stand-in daemon for one check, restored after it. */
async function withDocker<T>(fake: Parameters<typeof useDockerForCompetitions>[0], body: () => Promise<T>): Promise<T> {
  const before = process.env.COMPETITION_BACKEND
  process.env.COMPETITION_BACKEND = 'docker'
  useCompetitionRunner(null)
  forgetCompetitionRunner()
  useDockerForCompetitions(fake)
  try {
    return await body()
  } finally {
    useDockerForCompetitions(null)
    useCompetitionRunner(runner)
    forgetCompetitionRunner()
    if (before === undefined) delete process.env.COMPETITION_BACKEND
    else process.env.COMPETITION_BACKEND = before
  }
}

/* ------------------------------------------------------- the container line */

test('a run with a card gets the card, its /dev/shm and the label rooms carry, with every hardening flag kept', () => {
  const args = runArgs({ ...CPU_RUN, gpu: SHARED })
  assert.equal(valueOf(args, '--gpus'), 'device=1')
  // Half the memory, at most a gigabyte: DataLoader workers die on docker's 64 MB.
  assert.ok(args.includes('--shm-size=1024m'))
  assert.equal(runArgs({ ...CPU_RUN, limits: { ...LIMITS, memoryMb: 1536 }, gpu: SHARED }).find((arg) => arg.startsWith('--shm-size=')), '--shm-size=768m')
  // The label by which a new class is kept off the card (kernel/pool.ts · submissionGpuCards).
  const labels = args.filter((_, at) => args[at - 1] === '--label')
  assert.ok(labels.includes('colloq.gpu=1'))
  assert.ok(labels.includes('colloq.kind=competition-run'))
  // The card changes nothing of the perimeter.
  assert.equal(valueOf(args, '--network'), 'none')
  for (const flag of ['--read-only', '--cap-drop=ALL', '--user=1000:1000', '--security-opt=no-new-privileges', '--pids-limit=256']) {
    assert.ok(args.includes(flag), flag)
  }
  assert.ok(args.every((arg) => arg !== '--privileged' && !arg.startsWith('--device') && !arg.startsWith('--ipc')))
  // Docker's own way of handing out a card, never a variable a notebook could rewrite.
  assert.ok(![...envOf(args).keys()].some((name) => name === 'CUDA_VISIBLE_DEVICES' || name === 'NVIDIA_VISIBLE_DEVICES'))
  assert.equal(args.at(-1), '/harness/run_notebook.py')
})

test('the allocator cap and the harness site go only to a run that shares its card and knows its size', () => {
  const shared = envOf(runArgs({ ...CPU_RUN, gpu: SHARED }))
  // The share less the CUDA context, which lives outside torch's allocator.
  assert.equal(shared.get('COLLOQ_GPU_MEMORY_MB'), String(6144 - GPU_CONTEXT_MB))
  // The card the share was cut from: CatBoost's pool is a part of the card, not a size.
  assert.equal(shared.get('COLLOQ_GPU_CARD_MB'), String(6144 * 4))
  assert.equal(shared.get('PYTHONPATH'), HARNESS_SITE)
  // Never below the floor, however small the share.
  const tiny = envOf(runArgs({ ...CPU_RUN, gpu: { device: '0', sliceMb: 600, perDevice: 8 } }))
  assert.equal(tiny.get('COLLOQ_GPU_MEMORY_MB'), '256')
  assert.equal(tiny.get('COLLOQ_GPU_CARD_MB'), '4800')

  // A whole card: nobody to disturb, nothing to cap. A card of unknown size: no limit anyone can state.
  for (const gpu of [{ device: '1', sliceMb: 24_564, perDevice: 1 }, { device: '1', sliceMb: null, perDevice: 4 }]) {
    const args = runArgs({ ...CPU_RUN, gpu })
    assert.equal(valueOf(args, '--gpus'), 'device=1', 'the card itself is still given')
    assert.ok(!envOf(args).has('COLLOQ_GPU_MEMORY_MB'))
    assert.ok(!envOf(args).has('COLLOQ_GPU_CARD_MB'))
    assert.ok(!envOf(args).has('PYTHONPATH'))
    assert.equal(heldShareMb(gpu), null)
  }
  assert.equal(heldShareMb(SHARED), 6144)
  assert.equal(heldShareMb(undefined), null)
  assert.equal(heldShareMb(CLUSTER_GPU), null)
})

test('the CPU line is exactly what it was: a card adds its own arguments and nothing else', () => {
  const cpu = runArgs(CPU_RUN)
  // No field, an absent card, and the cluster's empty device are one and the same line.
  assert.deepEqual(runArgs({ ...CPU_RUN, gpu: undefined }), cpu)
  assert.deepEqual(runArgs({ ...CPU_RUN, gpu: { ...CLUSTER_GPU } }), cpu)
  const line = cpu.join(' ')
  for (const word of ['--gpus', '--shm-size', 'colloq.gpu', 'COLLOQ_GPU_MEMORY_MB', 'COLLOQ_GPU_CARD_MB', 'PYTHONPATH']) {
    assert.ok(!line.includes(word), `${word} in a CPU line`)
  }
  // Take the card's own arguments out of the GPU line, and the CPU line is what remains, in order.
  const gpu = runArgs({ ...CPU_RUN, gpu: SHARED })
  const own = new Set(['--gpus', 'device=1', '--shm-size=1024m', 'colloq.gpu=1', 'COLLOQ_GPU_MEMORY_MB=5632', 'COLLOQ_GPU_CARD_MB=24576', `PYTHONPATH=${HARNESS_SITE}`])
  const rest: string[] = []
  for (let at = 0; at < gpu.length; at++) {
    if (own.has(gpu[at])) continue
    // The flag before a value of the card's goes with it.
    if ((gpu[at] === '-e' || gpu[at] === '--label') && own.has(gpu[at + 1])) continue
    rest.push(gpu[at])
  }
  assert.deepEqual(rest, cpu)
})

test('the metric line never has a card, whatever the notebook had', () => {
  const args = scoreArgs({
    container: 'colloq-comp-s1-0123abcd-score',
    image: 'sha256:pinned',
    secretDir: '/data/competitions/c1/secret',
    submissionDir: '/data/competitions/c1/s/s1/score',
    outDir: '/data/competitions/c1/s/s1/score-out',
    limits: limitsFor(COMPETITION, 'metric'),
    solutionFile: SOLUTION_NAME,
    metricFile: METRIC_NAME,
    idColumn: 'id',
    publicPercent: 30,
    splitSeed: 'zerno',
  })
  const line = args.join(' ')
  for (const word of ['--gpus', '--shm-size', 'colloq.gpu', 'COLLOQ_GPU', 'PYTHONPATH', '/harness/site']) {
    assert.ok(!line.includes(word), `${word} in the metric's line`)
  }
})

test('Docker launches the notebook on its card and the scorer of the same attempt without one', async () => {
  const commands: string[][] = []
  await withDocker(async (args) => {
    commands.push(args)
    return { code: args[0] === 'rm' ? 0 : 1, out: 'launch stopped by test' }
  }, async () => {
    const actual = competitionRunner()
    const competition = { ...COMPETITION, environment: 'base-gpu', publicPercent: 30, splitSeed: 's' } as Competition
    await actual.run({ competition, imageDigest: 'sha256:gpu-base', submissionId: 's', container: 'c-run', dataDir: '/data/open', inputDir: '/data/input', resultDir: '/data/result', limits: LIMITS, gpu: SHARED })
    await actual.score({ competition, imageDigest: 'sha256:gpu-base', submissionId: 's', container: 'c-score', secretDir: '/data/secret', submissionDir: '/data/answer', outDir: '/data/score', limits: limitsFor(competition, 'metric') })
  })
  const launches = commands.filter((args) => args[0] === 'run')
  assert.equal(launches.length, 2)
  assert.equal(valueOf(launches[0], '--gpus'), 'device=1')
  assert.ok(!launches[1].some((arg) => arg === '--gpus' || arg.includes('colloq.gpu') || arg.includes('COLLOQ_GPU')))
})

/* --------------------------------------------------------------- the watchdog */

test('a sample is the sum of the container\'s own processes; anything else is no answer', () => {
  assert.equal(parseGpuMemory('5120\n2150\n'), 7270)
  assert.equal(parseGpuMemory(' 458 '), 458)
  // Nothing on the card yet is an answer: zero.
  assert.equal(parseGpuMemory(''), 0)
  assert.equal(parseGpuMemory('No running processes found'), 0)
  for (const garbage of ['[N/A]', '5120\n[N/A]', '7270 MiB', 'Failed to initialize NVML: Unknown Error', '-1']) {
    assert.equal(parseGpuMemory(garbage), null, garbage)
  }
})

test('the watchdog kills only on two answered samples in a row above the share plus its tolerance', () => {
  const slice = 6144
  const over = slice + GPU_TOLERANCE_MB + 1
  const at = slice + GPU_TOLERANCE_MB
  assert.equal(gpuOverShare([over, over], slice), true)
  assert.equal(gpuOverShare([100, over, over], slice), true)
  // One reading may catch a moment; the tolerance itself is still inside.
  assert.equal(gpuOverShare([over], slice), false)
  assert.equal(gpuOverShare([over, at], slice), false)
  assert.equal(gpuOverShare([over, 5000, over], slice), false)
  assert.equal(gpuOverShare([], slice), false)
  // A sample that did not answer decides nothing: it never kills...
  assert.equal(gpuOverShare([null, null, null], slice), false)
  assert.equal(gpuOverShare([over, null], slice), false)
  // ...and it does not save a run that stays over its share either.
  assert.equal(gpuOverShare([over, null, over], slice), true)
  assert.equal(gpuOverShare([over, null, null, 6000], slice), false)
})

test('a run over its share is stopped from outside, with the peak and the deciding samples kept', async () => {
  const commands: string[][] = []
  const outcome = await withDocker(async (args) => {
    commands.push(args)
    if (args[0] === 'inspect') return { code: 0, out: args.at(-1) === '{{.State.Running}}' ? 'true' : 'running 137 false' }
    // Two processes of this container: 7270 MiB on a 6144 MiB share.
    if (isSample(args)) return { code: 0, out: '5120\n2150\n' }
    if (args[0] === 'exec' && args[5] === 'status') return { code: 0, out: '{}' }
    if (args[0] === 'exec') return { code: 1, out: 'no such file' }
    return { code: 0, out: '' }
  }, () => competitionRunner().run({
    competition: COMPETITION, submissionId: 's-over', attemptId: 'over', container: 'over-run',
    dataDir: '/data/open', inputDir: '/data/in', resultDir: path.join(competitionsDir, 'gpu-over-result'),
    limits: { ...LIMITS, wallSeconds: 60 }, gpu: SHARED,
  }))
  assert.equal(outcome.status, 'out-of-memory')
  assert.equal(outcome.diagnostics.killedBy, 'gpu')
  assert.equal(outcome.diagnostics.oomKilled, false, 'the machine\'s memory was never the trouble')
  assert.equal(outcome.diagnostics.gpuPeakMb, 7270)
  assert.deepEqual(outcome.diagnostics.gpuSamplesMb, [7270, 7270])
  const samples = commands.filter(isSample)
  assert.equal(samples.length, 2, 'two samples, three seconds apart, and not one more')
  // As root: the participant's uid 1000 cannot signal it, and the container has no CAP_KILL to lend.
  assert.deepEqual(samples[0], ['exec', '--user', '0:0', 'over-run', 'nvidia-smi', '--query-compute-apps=used_memory', '--format=csv,noheader,nounits'])
  const kill = commands.findIndex((args) => args[0] === 'kill')
  const salvage = commands.findIndex((args) => args[0] === 'exec' && args.at(-1) === 'executed.ipynb')
  assert.ok(kill > 0 && salvage >= 0 && salvage < kill, 'the notebook is copied out before the kill, as for printing')
})

test('a sample or two that fail or do not parse never stop a run, and a whole card is never sampled', async () => {
  let looks = 0
  const commands: string[][] = []
  const outcome = await withDocker(async (args) => {
    commands.push(args)
    if (args[0] === 'inspect') return { code: 0, out: args.at(-1) === '{{.State.Running}}' ? 'true' : 'exited 0 false' }
    if (isSample(args)) return looks === 0 ? { code: 1, out: 'Error response from daemon' } : { code: 0, out: '[N/A]' }
    // The notebook finishes at the second look.
    if (args[0] === 'exec' && args[5] === 'status') return { code: 0, out: JSON.stringify(++looks >= 2 ? { complete: { attemptId: 'calm', exit: 0 } } : {}) }
    if (args[0] === 'exec') return { code: 1, out: 'no such file' }
    return { code: 0, out: '' }
  }, () => competitionRunner().run({
    competition: COMPETITION, submissionId: 's-calm', attemptId: 'calm', container: 'calm-run',
    dataDir: '/data/open', inputDir: '/data/in', resultDir: path.join(competitionsDir, 'gpu-calm-result'),
    limits: { ...LIMITS, wallSeconds: 60 }, gpu: SHARED,
  }))
  assert.equal(outcome.diagnostics.killedBy, undefined)
  assert.ok(!commands.some((args) => args[0] === 'kill'))
  assert.equal(outcome.diagnostics.gpuPeakMb, null, 'nothing answered, nothing is claimed')
  assert.deepEqual(outcome.diagnostics.gpuSamplesMb, [])

  const whole: string[][] = []
  const finished = await withDocker(async (args) => {
    whole.push(args)
    if (args[0] === 'inspect') return { code: 0, out: args.at(-1) === '{{.State.Running}}' ? 'true' : 'exited 0 false' }
    if (args[0] === 'exec' && args[5] === 'status') return { code: 0, out: JSON.stringify({ complete: { attemptId: 'whole', exit: 0 } }) }
    if (args[0] === 'exec') return { code: 1, out: 'no such file' }
    return { code: 0, out: '' }
  }, () => competitionRunner().run({
    competition: COMPETITION, submissionId: 's-whole', attemptId: 'whole', container: 'whole-run',
    dataDir: '/data/open', inputDir: '/data/in', resultDir: path.join(competitionsDir, 'gpu-whole-result'),
    limits: LIMITS, gpu: { device: '0', sliceMb: 24_564, perDevice: 1 },
  }))
  assert.ok(!whole.some((args) => args.includes('nvidia-smi')), 'a run alone on its card disturbs nobody')
  assert.equal(finished.diagnostics.gpuPeakMb, undefined)
})

/*
 * The participant is the one watched. Before 13 Oct 2026 the sample entered
 * the container as its own uid 1000, so the notebook could SIGSTOP it (one
 * stalled sample stopped the sampling for good) or SIGKILL every one of them
 * (no answer ever, so no kill ever), and then hold the whole card for the
 * wall limit. Root closes the signals; what root cannot close — a processor
 * starved by the notebook, a hung driver — is caught by failing closed.
 */

/** A stand-in daemon for a run on a shared card: running until killed, its beacon at cell 5 of 9, its samples as `sample` says. */
function watchedDaemon(
  attemptId: string,
  commands: string[][],
  sample: (count: number) => Promise<{ code: number; out: string }> | { code: number; out: string },
) {
  let samples = 0
  return async (args: string[]) => {
    commands.push(args)
    if (args[0] === 'inspect') return { code: 0, out: args.at(-1) === '{{.State.Running}}' ? 'true' : 'running 137 false' }
    if (isSample(args)) return sample(samples++)
    if (args[0] === 'exec' && args[5] === 'status') {
      return { code: 0, out: JSON.stringify({ progress: { attemptId, phase: 'notebook', cell: 4, cells: 9, outputBytes: 0 } }) }
    }
    if (args[0] === 'exec') return { code: 1, out: 'no such file' }
    return { code: 0, out: '' }
  }
}

/** One run on SHARED behind `daemon`, with a wall limit the old watch would have run into instead. */
function watchedRun(attemptId: string, daemon: Parameters<typeof useDockerForCompetitions>[0]) {
  return withDocker(daemon, () => competitionRunner().run({
    competition: COMPETITION, submissionId: `s-${attemptId}`, attemptId, container: `${attemptId}-run`,
    dataDir: '/data/open', inputDir: '/data/in', resultDir: path.join(competitionsDir, `gpu-${attemptId}-result`),
    limits: { ...LIMITS, wallSeconds: 30 }, gpu: SHARED,
  }))
}

test('a sample that never comes back is given up at its deadline, and the next ones still stop a run over its share', async () => {
  const commands: string[][] = []
  // The first sample hangs for good — a stopped nvidia-smi, a client that never exits — and then the run is 20 GB on a 6 GB share.
  const outcome = await watchedRun('stall', watchedDaemon('stall', commands, (count) => (count === 0 ? new Promise<never>(() => {}) : { code: 0, out: '20480\n' })))
  assert.equal(outcome.diagnostics.killedBy, 'gpu', 'one hung sample does not end the watch')
  assert.equal(outcome.status, 'out-of-memory')
  assert.deepEqual(outcome.diagnostics.gpuSamplesMb, [20480, 20480])
  const samples = commands.filter(isSample)
  assert.equal(samples.length, 3, 'the hung one, then two over the share')
  for (const args of samples) assert.deepEqual(args.slice(0, 4), ['exec', '--user', '0:0', 'stall-run'], 'every sample as root')
})

test('a shared card that stops answering stops the run, in our own words for the participant and the teacher', async () => {
  const commands: string[][] = []
  // It answered once (450 MB), and then never again: nvidia-smi starved, killed, or failing.
  const outcome = await watchedRun('silent', watchedDaemon('silent', commands, (count) => (count === 0
    ? { code: 0, out: '450\n' }
    : { code: 9, out: 'Failed to initialize NVML: Unknown Error\nmore lines' })))
  assert.equal(outcome.diagnostics.killedBy, 'gpu-unread')
  assert.equal(outcome.status, 'cell_error', 'a card that went silent is the notebook\'s failure, and counts as one')
  assert.equal(outcome.diagnostics.oomKilled, false)
  assert.equal(outcome.diagnostics.gpuPeakMb, 450)
  assert.equal(commands.filter(isSample).length, 1 + VRAM_UNREAD_LIMIT, 'stopped at the limit, not before and not after')
  const kill = commands.findIndex((args) => args[0] === 'kill')
  assert.ok(kill > 0 && !commands.slice(0, kill).some((args) => args.at(-1) === 'executed.ipynb'), 'no salvage: every second may be the card')

  const words = unreadCardNotes({ device: '1', sliceMb: 6144, failures: VRAM_UNREAD_LIMIT, lastFailure: 'Failed to initialize NVML: Unknown Error', answered: true })
  assert.equal(outcome.detail, words.participant, 'the participant\'s sentence goes where a traceback would')
  assert.ok(outcome.log.startsWith(words.teacher), outcome.log)
  // Through runner.ts's own words: its head with the cell, then ours; the teacher's head, then ours.
  assert.equal(
    inEnglish(() => notebookNote({ ...outcome, detail: unreadCardNotes({ device: '1', sliceMb: 6144, failures: 4, lastFailure: null, answered: true }).participant! }, COMPETITION, null, SHARED)),
    [
      'The notebook failed at cell 5 of 9.',
      'The submission was stopped from outside: how much GPU memory it held could not be read 4 times in a row, and a run nobody can watch is not left on a card shared with other runs. That happens when a notebook keeps its processor busy with hundreds of threads or processes, or when the card itself stops answering.',
    ].join('\n\n'),
  )
  const teacher = teacherNote(outcome, SHARED)!
  assert.ok(teacher.startsWith('cell_error · exit 137 · killed by gpu-unread\n'), teacher)
  assert.ok(teacher.includes(words.teacher), teacher)
})

test('a shared card that never answered stops the run as our failure, not the participant\'s', async () => {
  const commands: string[][] = []
  const missing = 'OCI runtime exec failed: exec failed: unable to start container process: exec: "nvidia-smi": executable file not found in $PATH: unknown'
  const outcome = await watchedRun('never', watchedDaemon('never', commands, () => ({ code: 126, out: missing })))
  assert.equal(outcome.diagnostics.killedBy, 'gpu-unread', 'fail closed: a share nobody can hold is not run on')
  assert.equal(outcome.status, 'harness_error', 'no blame and no cost to the participant')
  assert.equal(outcome.diagnostics.gpuPeakMb, null)
  assert.equal(outcome.detail, '')
  assert.equal(commands.filter(isSample).length, VRAM_UNREAD_LIMIT)
  const words = unreadCardNotes({ device: '1', sliceMb: 6144, failures: VRAM_UNREAD_LIMIT, lastFailure: missing, answered: false })
  assert.equal(words.participant, null)
  assert.ok(outcome.log.startsWith(words.teacher), outcome.log)
  assert.ok(words.teacher.endsWith(tr('competitions.answer.gpuNeverRead')), 'the teacher is told where to look')
})

test('a card that could not be read is the notebook\'s failure only when it had answered before', () => {
  assert.equal(verdictOfRun({ oom: false, killedBy: 'gpu-unread', status: null, produced: false, cardRead: true }), 'cell_error')
  // Whatever the harness had written by then: the kill came from outside.
  assert.equal(verdictOfRun({ oom: false, killedBy: 'gpu-unread', status: 'ok', produced: true, cardRead: true }), 'cell_error')
  assert.equal(verdictOfRun({ oom: false, killedBy: 'gpu-unread', status: 'ok', produced: true, cardRead: false }), 'harness_error')
  assert.equal(verdictOfRun({ oom: false, killedBy: 'gpu-unread', status: null, produced: false }), 'harness_error')
  // The machine's own out-of-memory still outranks it.
  assert.equal(verdictOfRun({ oom: true, killedBy: 'gpu-unread', status: null, produced: false, cardRead: true }), 'out-of-memory')
})

test('the words for an unread card name the samples, the share and what the last one said, and nothing the notebook chose', () => {
  const silent = { device: '1', sliceMb: 6144, failures: 4, lastFailure: 'Failed to initialize NVML: Unknown Error', answered: true }
  assert.deepEqual(inEnglish(() => unreadCardNotes(silent)), {
    participant: 'The submission was stopped from outside: how much GPU memory it held could not be read 4 times in a row, and a run nobody can watch is not left on a card shared with other runs. That happens when a notebook keeps its processor busy with hundreds of threads or processes, or when the card itself stops answering.',
    teacher: 'GPU 1: 4 samples in a row did not answer (the last: Failed to initialize NVML: Unknown Error) with a 6144 MB share — the run was stopped from outside: an unwatched run is not left on a shared card.',
  })
  assert.deepEqual(inRussian(() => unreadCardNotes(silent)), {
    participant: 'Посылку остановили снаружи: 4 раза подряд не удалось прочитать, сколько видеопамяти она занимает, а на карте, которую делят несколько посылок, прогон без присмотра не оставляют. Так бывает, когда тетрадь занимает процессор сотнями потоков или процессов, или когда сама карта перестаёт отвечать.',
    teacher: 'Видеокарта 1: 4 замера подряд не ответили (последний: Failed to initialize NVML: Unknown Error) при срезе 6144 МБ — прогон остановлен снаружи: на общей карте прогон без присмотра не оставляют.',
  })
  // A sample that hung said nothing: the deadline is named instead.
  assert.match(inEnglish(() => unreadCardNotes({ ...silent, lastFailure: null }).teacher), /\(the last: no answer within 5 s\)/)
  assert.match(inRussian(() => unreadCardNotes({ ...silent, lastFailure: null, failures: 5 }).teacher), /5 замеров подряд не ответили \(последний: нет ответа за 5 с\)/)
  assert.match(inRussian(() => unreadCardNotes({ ...silent, failures: 5 }).participant!), /^Посылку остановили снаружи: 5 раз подряд /)
  // Never answered: no sentence for the participant (their run is our failure), a hint for the teacher.
  const never = inEnglish(() => unreadCardNotes({ ...silent, answered: false }))
  assert.equal(never.participant, null)
  assert.ok(never.teacher.endsWith(' The card never answered during this run: if every run on it ends like this, check that nvidia-smi works inside a container on this host.'), never.teacher)
})

test('a card\'s memory over the share reads as out of memory, ahead of the time limit', () => {
  assert.equal(verdictOfRun({ oom: false, killedBy: 'gpu', status: null, produced: false }), 'out-of-memory')
  assert.equal(verdictOfRun({ oom: false, killedBy: 'gpu', status: 'ok', produced: true }), 'out-of-memory')
})

/* ----------------------------------------------- a card a container still holds */

test('a GPU launch the driver refuses tells the teacher about the toolkit, and its stuck container keeps the card', async () => {
  let removal: 'fails' | 'works' = 'fails'
  const refusal = 'docker: Error response from daemon: could not select device driver "" with capabilities: [[gpu]].'
  try {
    await withDocker(async (args) => {
      if (args[0] === 'run') return { code: 125, out: refusal }
      if (args[0] === 'rm') return { code: removal === 'works' ? 0 : 1, out: 'daemon busy' }
      return { code: 1, out: 'unavailable' }
    }, async () => {
      const actual = competitionRunner()
      const outcome = await actual.run({ competition: COMPETITION, submissionId: 's-driver', container: 'driver-run', dataDir: '/data/open', inputDir: '/data/in', resultDir: '/data/result', limits: LIMITS, gpu: SHARED })
      assert.equal(outcome.status, 'harness_error')
      assert.ok(outcome.log.startsWith(refusal))
      assert.ok(outcome.log.endsWith(tr('server.theHostMayBeMissingNvidiaContainer.f5c0df')), 'the hint a GPU room gives')
      // The container whose removal failed holds its card as well as its memory.
      const held = await actual.capacity()
      assert.deepEqual(held.heldGpus, { '1': 1 })
      assert.equal(held.heldMb, LIMITS.memoryMb + 256)
      // The same refusal on a CPU run is not about the toolkit.
      removal = 'works'
      const cpu = await actual.run({ competition: COMPETITION, submissionId: 's-cpu', container: 'cpu-run', dataDir: '/data/open', inputDir: '/data/in', resultDir: '/data/result', limits: LIMITS })
      assert.equal(cpu.log, refusal)
      // The retry gets the stuck container at last, and the card comes back.
      await actual.capacity()
      await until(() => competitionDockerDiagnostics().pendingCleanup === 0)
      assert.deepEqual((await actual.capacity()).heldGpus, {})
    })
  } finally {
    removal = 'works'
  }
})

test('an orphan of the previous life that will not go keeps the card its label names', async () => {
  let removal: 'fails' | 'works' = 'fails'
  const asked: string[][] = []
  try {
    await withDocker(async (args) => {
      asked.push(args)
      if (args[0] === 'ps') {
        return args.includes('label=colloq.kind=competition-run') ? { code: 0, out: 'aa11\t0\nbb22\t\n' } : { code: 0, out: '' }
      }
      if (args[0] === 'rm') return args.at(-1) === 'aa11' && removal === 'fails' ? { code: 1, out: 'daemon busy' } : { code: 0, out: '' }
      return { code: 1, out: 'unavailable' }
    }, async () => {
      const actual = competitionRunner()
      assert.equal(await actual.sweep(), 1, 'the one without a card is gone')
      const ps = asked.find((args) => args[0] === 'ps')!
      assert.equal(valueOf(ps, '--format'), '{{.ID}}\t{{.Label "colloq.gpu"}}')
      assert.deepEqual((await actual.capacity()).heldGpus, { '0': 1 })
      removal = 'works'
      await actual.capacity()
      await until(() => competitionDockerDiagnostics().pendingCleanup === 0)
      assert.deepEqual((await actual.capacity()).heldGpus, {})
    })
  } finally {
    removal = 'works'
  }
})

/* ------------------------------------------------------------------ the harness */

test('the harness ships site/sitecustomize.py, alone in the directory PYTHONPATH gets', () => {
  const dir = harnessDir()
  const site = path.join(dir, 'site')
  assert.deepEqual(fs.readdirSync(site), ['sitecustomize.py'], 'nothing else of the harness is importable by name')
  const source = fs.readFileSync(path.join(site, 'sitecustomize.py'), 'utf8')
  assert.match(source, /COLLOQ_GPU_MEMORY_MB/)
  assert.match(source, /set_per_process_memory_fraction/)
  assert.match(source, /_lazy_call/)
  assert.equal(HARNESS_SITE, '/harness/site')
  // The broker's fixed directory gets it too, readable by the Pod's user.
  const broker = brokerHarnessDir()
  const shipped = path.join(broker, 'site', 'sitecustomize.py')
  assert.equal(fs.readFileSync(shipped, 'utf8'), source)
  assert.equal(fs.statSync(path.join(broker, 'site')).mode & 0o777, 0o755)
  assert.ok(!fs.readdirSync(path.join(broker, 'site')).some((name) => name.endsWith('.tmp')), 'no temporary file is left behind')
  // A second lay-out of an unchanged harness rewrites nothing.
  const before = fs.statSync(shipped).mtimeMs
  brokerHarnessDir()
  assert.equal(fs.statSync(shipped).mtimeMs, before)
})

const python = spawnSync('python3', ['--version'], { encoding: 'utf8' })
const PYTHON = { skip: python.status === 0 ? false : 'no python3 on this machine: the cap is checked only where it can run' }

/**
 * Stand-in packages for the sitecustomize, in a directory of their own: a
 * torch that records what is asked of it (the callback queued for CUDA's
 * start, and the fraction set); a library that asks whether torch is there at
 * its own import, the way polars does; a catboost with the two doors of
 * catboost 1.2 (CatBoost._prepare_train_params, core._cv) that records the
 * parameters reaching them; and, apart in `odd/`, a catboost without them.
 */
function standIns(): { root: string; odd: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'colloq-fake-gpu-libs-'))
  const write = (file: string, lines: string[]) => {
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true })
    fs.writeFileSync(path.join(root, file), `${lines.join('\n')}\n`)
  }
  write('torch/__init__.py', ['from . import cuda'])
  write('torch/cuda.py', [
    'queued = []',
    'fractions = []',
    'class _Card:',
    '    total_memory = 24 * 1024 ** 3',
    'def get_device_properties(index):',
    '    return _Card()',
    'def set_per_process_memory_fraction(fraction, device=None):',
    '    fractions.append([fraction, device])',
    'def _lazy_call(callback):',
    '    queued.append(callback)',
  ])
  write('asks_for_torch.py', ['import importlib.util', 'TORCH = importlib.util.find_spec("torch") is not None'])
  write('catboost/__init__.py', ['from . import core', 'from .core import CatBoost, CatBoostClassifier, cv'])
  write('catboost/core.py', [
    'calls = []',
    'def _cv(params, pool=None):',
    '    calls.append(["cv", dict(params)])',
    '    return params',
    'class CatBoost:',
    '    def __init__(self, params=None):',
    '        self._init_params = dict(params or {})',
    '    def _prepare_train_params(self, X=None, y=None):',
    '        return {"params": dict(self._init_params), "train_pool": X}',
    '    def fit(self, X=None, y=None):',
    '        calls.append(["fit", self._prepare_train_params(X=X, y=y)["params"]])',
    '        return self',
    'class CatBoostClassifier(CatBoost):',
    '    def __init__(self, task_type=None, gpu_ram_part=None, **rest):',
    '        given = dict(task_type=task_type, gpu_ram_part=gpu_ram_part, **rest)',
    '        super().__init__({k: v for k, v in given.items() if v is not None})',
    'def cv(pool=None, params=None):',
    '    return _cv(dict(params), pool)',
  ])
  write('odd/catboost/__init__.py', ['from . import core'])
  write('odd/catboost/core.py', ['class CatBoost:', '    def fit(self):', '        return "fitted"'])
  return { root, odd: path.join(root, 'odd') }
}

/** A python of this machine started the way the container starts one: the harness's site first on PYTHONPATH, then `libs`. */
function inPython(script: string, libs: string, env: Record<string, string>, ...args: string[]): { out: any; stderr: string } {
  const site = path.join(harnessDir(), 'site')
  const vars: NodeJS.ProcessEnv = { ...process.env, PYTHONPATH: `${site}${path.delimiter}${libs}` }
  delete vars.COLLOQ_GPU_MEMORY_MB
  delete vars.COLLOQ_GPU_CARD_MB
  Object.assign(vars, env)
  const result = spawnSync('python3', ['-s', '-c', script, ...args], { encoding: 'utf8', env: vars })
  assert.equal(result.status, 0, result.stderr)
  return { out: JSON.parse(result.stdout), stderr: result.stderr }
}

test('sitecustomize caps torch at COLLOQ_GPU_MEMORY_MB when CUDA starts, once, however torch was asked about first', PYTHON, () => {
  const libs = standIns()
  try {
    const script = [
      'import importlib, importlib.util, json, sys',
      'order = sys.argv[1]',
      'if order == "find_spec": importlib.util.find_spec("torch")',
      // polars does this at its own import (_dependencies._lazy_import), and isort puts it before torch.
      'if order == "library": import asks_for_torch',
      'if order == "again":',
      '    importlib.util.find_spec("torch")',
      '    importlib.util.find_spec("torch")',
      'import torch',
      'if order == "again":',
      '    import torch',
      '    importlib.util.find_spec("torch")',
      '    importlib.reload(torch)',
      'queued = len(torch.cuda.queued)',
      'for callback in torch.cuda.queued: callback()',
      'site = sys.modules.get("sitecustomize")',
      'print(json.dumps({"queued": queued, "fractions": torch.cuda.fractions,',
      '  "site": getattr(site, "__file__", None), "finders": [type(f).__name__ for f in sys.meta_path]}))',
    ].join('\n')
    const share = { COLLOQ_GPU_MEMORY_MB: '4096' }
    const capped = inPython(script, libs.root, share, 'plain')
    assert.ok(capped.out.site, 'a sitecustomize was imported')
    assert.equal(fs.realpathSync(capped.out.site), fs.realpathSync(path.join(harnessDir(), 'site', 'sitecustomize.py')), 'the harness\'s module is the one Python found')
    assert.equal(capped.out.queued, 1, 'one callback, queued for the moment CUDA initialises')
    assert.deepEqual(capped.out.fractions, [[4096 / (24 * 1024), 0]])
    assert.ok(!capped.stderr.includes('colloq:'), capped.stderr)

    // Asked about before it is imported — by the notebook or by a library at its own import —
    // and asked again, imported again, reloaded: still exactly one cap.
    for (const order of ['find_spec', 'library', 'again']) {
      const asked = inPython(script, libs.root, share, order)
      assert.equal(asked.out.queued, 1, `one cap after ${order}`)
      assert.deepEqual(asked.out.fractions, [[4096 / (24 * 1024), 0]], order)
      assert.ok(!asked.stderr.includes('colloq:'), asked.stderr)
    }

    for (const value of ['', '0', 'lots']) {
      const free = inPython(script, libs.root, { COLLOQ_GPU_MEMORY_MB: value }, 'plain')
      assert.equal(free.out.queued, 0, `no cap with COLLOQ_GPU_MEMORY_MB=${value}`)
      assert.deepEqual(free.out.fractions, [])
      assert.ok(!free.out.finders.includes('_GpuFinder'), 'nothing is put in front of the import system')
    }
    assert.equal(inPython(script, libs.root, {}, 'plain').out.queued, 0, 'no cap without the variable')
  } finally {
    fs.rmSync(libs.root, { recursive: true, force: true })
  }
})

test('sitecustomize gives a GPU CatBoost fit the share\'s part of the card, unless the participant named their own', PYTHON, () => {
  const libs = standIns()
  try {
    const script = [
      'import importlib.util, json, sys',
      'if sys.argv[1] == "find_spec": importlib.util.find_spec("catboost")',
      'import catboost',
      'from catboost import core',
      'gpu = catboost.CatBoostClassifier(task_type="GPU")',
      'for model in (gpu, catboost.CatBoostClassifier(task_type="gpu"), catboost.CatBoostClassifier(task_type="GPU", gpu_ram_part=0.3),',
      '              catboost.CatBoostClassifier(), catboost.CatBoostClassifier(task_type="CPU")):',
      '    model.fit()',
      'mine = {"task_type": "GPU"}',
      'catboost.cv(params=mine)',
      'print(json.dumps({"calls": core.calls, "own": gpu._init_params, "mine": mine}))',
    ].join('\n')
    // A 24 GB card shared by four: 6144 MB each, 5632 of it for the allocators.
    const card = { COLLOQ_GPU_MEMORY_MB: '5632', COLLOQ_GPU_CARD_MB: '24576' }
    const part = 5632 / 24576
    for (const order of ['plain', 'find_spec']) {
      const ran = inPython(script, libs.root, card, order)
      assert.deepEqual(ran.out.calls, [
        ['fit', { task_type: 'GPU', gpu_ram_part: part }],
        ['fit', { task_type: 'gpu', gpu_ram_part: part }],
        ['fit', { task_type: 'GPU', gpu_ram_part: 0.3 }],
        ['fit', {}],
        ['fit', { task_type: 'CPU' }],
        ['cv', { task_type: 'GPU', gpu_ram_part: part }],
      ], order)
      // Set on the copies handed to the GPU, never on what the participant holds.
      assert.deepEqual(ran.out.own, { task_type: 'GPU' })
      assert.deepEqual(ran.out.mine, { task_type: 'GPU' })
      assert.ok(!ran.stderr.includes('colloq:'), ran.stderr)
    }
    // Without the card, or with numbers that make no part of it, catboost is left as it is.
    for (const env of [{ COLLOQ_GPU_MEMORY_MB: '5632' }, { COLLOQ_GPU_MEMORY_MB: '5632', COLLOQ_GPU_CARD_MB: '4096' }, { COLLOQ_GPU_CARD_MB: '24576' }, {}]) {
      const left = inPython(script, libs.root, env, 'plain')
      assert.deepEqual(left.out.calls[0], ['fit', { task_type: 'GPU' }], JSON.stringify(env))
    }
    // A catboost without the doors of 1.2 imports and fits as it is, and the reason is said on stderr.
    const odd = inPython('import catboost, json; print(json.dumps(catboost.core.CatBoost().fit()))', libs.odd, card)
    assert.equal(odd.out, 'fitted')
    assert.match(odd.stderr, /^colloq: CatBoost GPU memory default not applied: /)
  } finally {
    fs.rmSync(libs.root, { recursive: true, force: true })
  }
})

/* ------------------------------------------------------------------ the words */

/** A run stopped for its card: cell 5 of 9, 7.1 GB at its peak on a 6 GB share. */
const KILLED: RunOutcome = {
  status: 'out-of-memory', cell: 4, cells: 9, wall: 61_000, submission: null, detail: '', log: 'Killed',
  diagnostics: { exit: 137, oomKilled: false, backend: 'docker', killedBy: 'gpu', gpuPeakMb: 7270, gpuSamplesMb: [6890, 7270] },
}

test('a run stopped for its card is told the share and the peak, in our own words', () => {
  assert.equal(
    inRussian(() => notebookNote(KILLED, COMPETITION, null, SHARED)),
    'Посылка заняла на видеокарте 7,1 ГБ при срезе 6 ГБ; её остановили на ячейке 5, чтобы не мешать соседям по карте.',
  )
  assert.equal(
    inEnglish(() => notebookNote(KILLED, COMPETITION, null, SHARED)),
    'The submission took 7.1 GB on the GPU with a 6 GB share; it was stopped at cell 5 so it would not disturb the other runs on the card.',
  )
  // The machine's own memory keeps its own sentence, card or no card.
  const ram: RunOutcome = { ...KILLED, diagnostics: { exit: 137, oomKilled: true, backend: 'docker' } }
  assert.equal(notebookNote(ram, COMPETITION, null, SHARED), tr('competitions.answer.outOfMemory', { count: 4, cell: 5 }))
  assert.equal(gpuKillNote(ram, SHARED), null)
})

test('a blind participant is told the share, not how far past it the run went', () => {
  for (const words of [inRussian(() => briefNote(KILLED, COMPETITION, null, SHARED)), inEnglish(() => briefNote(KILLED, COMPETITION, null, SHARED))]) {
    assert.ok(words, 'there are words')
    assert.ok(!/7[.,]1/.test(words) && !words.includes('7270'), words)
  }
  assert.equal(
    inRussian(() => briefNote(KILLED, COMPETITION, null, SHARED)),
    'Посылка заняла на видеокарте больше своего среза в 6 ГБ; её остановили на ячейке 5, чтобы не мешать соседям по карте.',
  )
  assert.equal(
    inEnglish(() => briefNote(KILLED, COMPETITION, null, SHARED)),
    'The submission took more than its 6 GB share of the GPU; it was stopped at cell 5 so it would not disturb the other runs on the card.',
  )
})

test('the teacher reads the card, the share and the samples that decided the kill', () => {
  const teacher = inEnglish(() => teacherNote(KILLED, SHARED))!
  assert.equal(
    teacher,
    [
      'out-of-memory · exit 137 · killed by gpu',
      'GPU 1: two samples in a row above 6400 MB (6890, 7270 MB) with a 6144 MB share — the run was stopped from outside.',
      'Killed',
    ].join('\n'),
  )
  assert.match(inRussian(() => teacherNote(KILLED, SHARED))!, /Видеокарта 1: два замера подряд выше 6400 МБ \(6890, 7270 МБ\) при срезе 6144 МБ/)
  // Any other failure of a watched run carries the peak; an unwatched one, nothing about a card.
  const failed: RunOutcome = { ...KILLED, status: 'cell_error', diagnostics: { exit: 1, oomKilled: false, backend: 'docker', gpuPeakMb: 5900, gpuSamplesMb: [5900] } }
  assert.match(inEnglish(() => teacherNote(failed, SHARED))!, /^cell_error · exit 1\nGPU 1: peak 5900 MB with a 6144 MB share\.\nKilled$/)
  const whole: RunOutcome = { ...failed, diagnostics: { exit: 1, oomKilled: false, backend: 'docker' } }
  assert.equal(teacherNote(whole, { device: '1', sliceMb: 24_564, perDevice: 1 }), 'cell_error · exit 1\nKilled')
  assert.equal(teacherNote(whole, null), 'cell_error · exit 1\nKilled')
})

test('torch\'s own out-of-memory error is a type a blind participant may be told', () => {
  const trace = 'Traceback (most recent call last):\n  Cell In[4], line 2\n    x = torch.empty(2**33, device="cuda")\n'
  assert.equal(errorTypeOf(`${trace}OutOfMemoryError: CUDA out of memory. Tried to allocate 8.00 GiB. GPU 0 has a total capacity of 23.99 GiB of which 4.00 GiB is allowed.`), 'OutOfMemoryError')
  assert.equal(errorTypeOf(`${trace}torch.OutOfMemoryError: CUDA out of memory.`), 'OutOfMemoryError')
  const failed: RunOutcome = { ...KILLED, status: 'cell_error', diagnostics: { exit: 1, oomKilled: false, backend: 'docker' } }
  assert.match(inEnglish(() => briefNote(failed, COMPETITION, 'OutOfMemoryError', SHARED))!, /: OutOfMemoryError\./)
})

/**
 * torch met its share inside the participant's own cell: cell 7 of 14, the
 * allocator's cap at 5.5 of a 6 GB share. Not the watchdog's kill — a cell
 * error, with the traceback for the full policy and the type for the brief.
 */
const TORCH_OOM: RunOutcome = {
  status: 'cell_error', cell: 6, cells: 14, wall: 38_000, submission: null, log: '',
  detail: 'Traceback (most recent call last):\n  Cell In[7], line 3\n    loss = model(batch)\nOutOfMemoryError: CUDA out of memory. Tried to allocate 2.00 GiB. GPU 0 has a total capacity of 23.99 GiB of which 5.50 GiB is allowed.',
  diagnostics: { exit: 1, oomKilled: false, backend: 'docker' },
}

test('torch\'s own out-of-memory on a card is followed by the share the run had, in full and brief alike', () => {
  // The full text: our head, the traceback, and our sentence after the type (Paper 15 · G4 #6).
  const full = inRussian(() => notebookNote(TORCH_OOM, COMPETITION, null, SHARED))!
  assert.ok(full.startsWith('Тетрадь упала на ячейке 7 из 14.\n\n'), full)
  assert.ok(full.includes('OutOfMemoryError: CUDA out of memory.'), 'the traceback stays')
  assert.ok(full.endsWith('\n\nУ посылки срез видеокарты 6 ГБ: уменьшите batch_size или модель.'), full)
  assert.ok(inEnglish(() => notebookNote(TORCH_OOM, COMPETITION, null, SHARED))!.endsWith('\n\nThis submission has a 6 GB GPU share: reduce the batch size or the model.'))
  // The brief text: the type, then the same advice as a paragraph of its own.
  // Every word and number in it is ours, so a blind participant may read it.
  assert.equal(
    inRussian(() => briefNote(TORCH_OOM, COMPETITION, errorTypeOf(TORCH_OOM.detail), SHARED)),
    'Тетрадь упала на ячейке 7 из 14: OutOfMemoryError. Текст ошибки и вывод скрыты — проверка шла на скрытом тесте.\n\nУ посылки срез видеокарты 6 ГБ: уменьшите batch_size или модель.',
  )
  // A card to itself has no share to name; the cluster's card and a card that
  // did not say its size have none we could state — the advice stays.
  assert.equal(inRussian(() => gpuMemoryHint('OutOfMemoryError', { device: '1', sliceMb: 24_564, perDevice: 1 })), 'У посылки вся карта: уменьшите batch_size или модель.')
  assert.equal(inEnglish(() => gpuMemoryHint('OutOfMemoryError', { device: '1', sliceMb: 24_564, perDevice: 1 })), 'This submission has the whole card: reduce the batch size or the model.')
  assert.equal(inRussian(() => gpuMemoryHint('OutOfMemoryError', { ...CLUSTER_GPU })), 'Видеопамяти посылке не хватило: уменьшите batch_size или модель.')
  assert.equal(inRussian(() => gpuMemoryHint('OutOfMemoryError', { device: '1', sliceMb: null, perDevice: 4 })), 'Видеопамяти посылке не хватило: уменьшите batch_size или модель.')
  // No card, or another error: nothing of ours is added, and the texts are the ones they were.
  assert.equal(gpuMemoryHint('OutOfMemoryError', null), null)
  assert.equal(gpuMemoryHint('ValueError', SHARED), null)
  assert.equal(gpuMemoryHint(null, SHARED), null)
  assert.ok(!notebookNote(TORCH_OOM, COMPETITION)!.includes('batch_size'))
  assert.equal(
    inRussian(() => briefNote(TORCH_OOM, COMPETITION, 'OutOfMemoryError', null)),
    'Тетрадь упала на ячейке 7 из 14: OutOfMemoryError. Текст ошибки и вывод скрыты — проверка шла на скрытом тесте.',
  )
  // A missing module keeps its own sentence on a run with a card.
  const missing: RunOutcome = { ...TORCH_OOM, detail: "Traceback (most recent call last):\nModuleNotFoundError: No module named 'lightgbm'" }
  const sources = { ownPackages: false, attached: null, base: [] }
  assert.match(inRussian(() => notebookNote(missing, COMPETITION, sources, SHARED))!, /lightgbm/)
  assert.ok(!inRussian(() => notebookNote(missing, COMPETITION, sources, SHARED))!.includes('batch_size'))
})
