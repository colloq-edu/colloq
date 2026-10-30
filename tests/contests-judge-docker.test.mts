/**
 * The real judge, with real docker: opt-in (COLLOQ_CONTEST_DOCKER_TEST=1),
 * because it starts containers and is slow where the rest of the suite is not.
 *
 * It proves what only a container can: that a correct Python and a correct C++
 * submission are judged OK, that WA/TL/ML/RE/CE come back as themselves through
 * the whole pipeline, and above all the two safety properties the design rests
 * on — a program CANNOT READ THE ANSWERS (everything under /secret and the
 * harness's own descriptors is closed to it: a solution that tries gets WA, not
 * OK) and a program CANNOT OUTLIVE ITS TEST (a child it double-forks is gone by
 * the next test, the container is removed after).
 *
 * C++ needs a compiler the base kernel does not yet carry, so this builds a
 * throwaway image `colloq-contest-test:gpp` from `colloq-kernel:base` once (it
 * never retags the base). Python runs in the base image as is.
 *
 * It prints the measured overheads (a container's start-to-verdict, a test's
 * extra cost) so a change that makes judging slower is visible in the log.
 */
// Home-based DATA_DIR first (see the module): Colima shares only $HOME, so the
// judge's mounts must live there. This file deliberately does not import _env.mts.
import './_contest-judge-docker-env.mts'
import { test, before } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { execFileSync, spawnSync } from 'node:child_process'
import { DockerContestJudge } from '../server/src/contests/judge/docker-judge.ts'
import { contestsDir } from '../server/src/contests/judge/harness.ts'
import { buildRequest, type BuildOptions } from './_contest-judge.mts'
import type { JudgeOutcome } from '../server/src/contests/judge/port.ts'

/** The instance label the judge stamps, recomputed as the module does (a hash of the data root). */
const INSTANCE_LABEL = `ru.colloq.competition-instance=${createHash('sha256').update(path.resolve(process.env.DATA_DIR ?? '')).digest('hex').slice(0, 16)}`

const enabled = process.env.COLLOQ_CONTEST_DOCKER_TEST === '1'
const BASE = 'colloq-kernel:base'
/*
 * The image C and C++ run in: the base kernel itself once it carries g++ (this
 * feature's Dockerfile change, after `make dev` or a rebuild), otherwise a local
 * layer with g++ on top of it, built once.
 */
let GPP = BASE
/** An image without a compiler, for the probe's «missing» answer: the kernels' own parent. */
const NO_COMPILER = 'python:3.11-slim-bookworm'

/** Build the C++ test image once; the base kernel has no g++ yet (that is this feature's Dockerfile change). */
before(() => {
  if (!enabled) return
  // Colima shares the home directory with its VM, so the judge's DATA_DIR (the
  // test root under tmp) must be reachable from inside: the suite's root is a
  // mkdtemp under os.tmpdir(), which on this Mac is under the home. If a host
  // ever puts tmp elsewhere, DATA_HOST_DIR would bridge it; here it is identity.
  delete process.env.DATA_HOST_DIR
  const hasCompiler = spawnSync('docker', ['run', '--rm', '--network', 'none', '--entrypoint', 'sh', BASE, '-c', 'command -v g++'], { stdio: 'ignore' }).status === 0
  if (hasCompiler) return
  GPP = 'colloq-contest-test:gpp'
  const dockerfile = `FROM ${BASE}\nUSER root\nRUN apt-get update && apt-get install -y --no-install-recommends g++ && rm -rf /var/lib/apt/lists/*\n`
  execFileSync('docker', ['build', '-t', GPP, '-'], { input: dockerfile, stdio: ['pipe', 'ignore', 'inherit'], timeout: 600_000 })
}, { timeout: 600_000 })

/** Judge a request against a real container and clean up its temp dirs. */
async function judge(image: string, options: BuildOptions): Promise<{ outcome: JudgeOutcome; wallMs: number }> {
  // Under DATA_DIR/contests so the anchored filesystem accepts the job dir and
  // the daemon's VM can see every mount.
  const root = path.join(contestsDir, 'it', randomUUID())
  const built = buildRequest({ ...options, root })
  built.request.image = image
  built.request.container = `colloq-contest-it-${process.pid}-${Math.random().toString(36).slice(2, 8)}`
  const started = Date.now()
  try {
    const outcome = await new DockerContestJudge().judge(built.request)
    return { outcome, wallMs: Date.now() - started }
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
    // Belt and braces: the judge removes its own container; make sure nothing is left if it threw.
    spawnSync('docker', ['rm', '-f', built.request.container], { stdio: 'ignore' })
  }
}

const SUM_PY = 'import sys\nfor line in sys.stdin:\n    a, b = line.split()\n    print(int(a) + int(b))\n'
const THREE: BuildOptions['tests'] = [
  { ordinal: 1, input: '1 2\n', answer: '3\n', sample: true },
  { ordinal: 2, input: '5 7\n', answer: '12\n' },
  { ordinal: 3, input: '10 20\n', answer: '30\n' },
]

const SUM_CPP =
  '#include <iostream>\nint main(){long a,b;while(std::cin>>a>>b)std::cout<<a+b<<"\\n";}\n'

test('docker: a correct Python solution is OK, and the overhead is reported', { skip: !enabled, timeout: 120_000 }, async () => {
  const { outcome, wallMs } = await judge(BASE, { source: SUM_PY, tests: THREE })
  assert.equal(outcome.verdict, 'OK')
  assert.equal(outcome.passed, 3)
  const perTest = outcome.tests.filter((t) => t.timeMs !== null)
  console.log(`[contest-judge] python OK: ${wallMs} ms end to end for ${perTest.length} tests (container start + compile + run)`)
})

test('docker: a wrong Python answer is WA at the first failing test', { skip: !enabled, timeout: 120_000 }, async () => {
  const { outcome } = await judge(BASE, {
    source: 'import sys\nfor line in sys.stdin:\n    a, b = line.split()\n    print(int(a) + int(b) if int(a) < 5 else 0)\n',
    tests: THREE,
  })
  assert.equal(outcome.verdict, 'WA')
  assert.equal(outcome.failedTest, 2)
})

test('docker: a busy loop is TL', { skip: !enabled, timeout: 120_000 }, async () => {
  const { outcome } = await judge(BASE, { source: 'while True:\n    pass\n', timeLimitMs: 500, tests: [{ ordinal: 1, input: 'x', answer: 'y' }] })
  assert.equal(outcome.verdict, 'TL')
})

test('docker: a program over its memory limit is ML', { skip: !enabled, timeout: 120_000 }, async () => {
  const { outcome } = await judge(BASE, {
    source: 'a = bytearray(400 * 1024 * 1024)\nfor i in range(0, len(a), 4096):\n    a[i] = 1\nprint(len(a))\n',
    memoryMb: 64,
    tests: [{ ordinal: 1, input: 'x', answer: 'y' }],
  })
  assert.equal(outcome.verdict, 'ML')
})

test('docker: a crash is RE with the signal for staff', { skip: !enabled, timeout: 120_000 }, async () => {
  const { outcome } = await judge(BASE, {
    source: 'import ctypes\nctypes.string_at(0)\n',
    tests: [{ ordinal: 1, input: 'x', answer: 'y' }],
  })
  assert.equal(outcome.verdict, 'RE')
  assert.match(outcome.tests[0].exit ?? '', /SIG|exit/)
})

test('docker: the program cannot read the answers (/secret and the harness fds are closed)', { skip: !enabled, timeout: 120_000 }, async () => {
  // The solution tries every way to reach an answer the design forbids, prints
  // what it got, and so would only match the answer if the sandbox leaked. It
  // must be WA (it printed junk, not the answer), never OK.
  const snoop =
    'import os\n' +
    'seen = []\n' +
    'for top in ("/secret", "/secret/ans", "/proc/1/fd", "/proc/1/root/secret", "/proc/1/cwd"):\n' +
    '    try:\n' +
    '        seen.append(os.listdir(top))\n' +
    '    except Exception as e:\n' +
    '        seen.append(type(e).__name__)\n' +
    'for path in ("/secret/ans/1", "/proc/1/environ", "/proc/1/maps"):\n' +
    '    try:\n' +
    '        seen.append(open(path).read())\n' +
    '    except Exception as e:\n' +
    '        seen.append(type(e).__name__)\n' +
    'print(seen)\n'
  const { outcome } = await judge(BASE, { source: snoop, tests: [{ ordinal: 1, input: '1 2\n', answer: '3\n' }] })
  assert.equal(outcome.verdict, 'WA', 'a program that snoops must get WA, not OK')
  // And it must have been refused at every door (no answer bytes anywhere in its output).
  assert.ok(!(outcome.tests[0].output ?? '').includes('3'), 'the answer must not appear in what the program could read')
})

test('docker: a double-forked child does not outlive its test', { skip: !enabled, timeout: 120_000 }, async () => {
  // Test 1 leaves a grandchild sleeping a minute; if it survived into test 2
  // the run would hang near the wall budget. Both tests pass quickly instead.
  const source =
    'import os, sys, time\n' +
    'data = sys.stdin.readline().strip()\n' +
    'if data == "1":\n' +
    '    if os.fork() == 0:\n' +
    '        os.setsid()\n' +
    '        if os.fork() == 0:\n' +
    '            time.sleep(60)\n' +
    '        os._exit(0)\n' +
    '    time.sleep(0.2)\n' +
    'print("ok")\n'
  const started = Date.now()
  const { outcome } = await judge(BASE, {
    source,
    checker: 'lines',
    tests: [{ ordinal: 1, input: '1\n', answer: 'ok\n' }, { ordinal: 2, input: '2\n', answer: 'ok\n' }],
  })
  assert.equal(outcome.verdict, 'OK')
  assert.ok(Date.now() - started < 30_000, 'the run must not wait on the grandchild')
})

test('docker: a correct C++ solution is OK; the C++ overhead is reported', { skip: !enabled, timeout: 180_000 }, async () => {
  const { outcome, wallMs } = await judge(GPP, { language: 'cpp20', source: SUM_CPP, tests: THREE })
  assert.equal(outcome.verdict, 'OK')
  assert.equal(outcome.passed, 3)
  console.log(`[contest-judge] c++ OK: ${wallMs} ms end to end (container start + g++ compile + run of ${outcome.tests.length} tests)`)
})

test('docker: a C++ compile error is CE with the compiler log, never a crash', { skip: !enabled, timeout: 180_000 }, async () => {
  const { outcome } = await judge(GPP, { language: 'cpp20', source: 'int main(){ return nope; }\n', tests: THREE })
  assert.equal(outcome.verdict, 'CE')
  assert.match(outcome.compileLog, /nope|error/)
  assert.deepEqual(outcome.tests, [])
})

test('docker: a custom checker runs as a uid of its own — it judges, and cannot read other tests\' answers', { skip: !enabled, timeout: 120_000 }, async () => {
  const fair = await judge(BASE, {
    source: SUM_PY,
    tests: THREE,
    checker: 'custom',
    checkerCode: 'def check(input, output, answer):\n    return output.split() == answer.split()\n',
  })
  assert.equal(fair.outcome.verdict, 'OK', JSON.stringify(fair.outcome))
  // A checker coerced into reading the answers of the other tests (here: told to)
  // meets the same 0700 /secret the program does.
  const prying = await judge(BASE, {
    source: SUM_PY,
    tests: THREE,
    checker: 'custom',
    checkerCode: "import os\ndef check(input, output, answer):\n    os.listdir('/secret')\n    return True\n",
  })
  assert.equal(prying.outcome.verdict, 'SE')
  assert.match(prying.outcome.systemDetail ?? '', /PermissionError/)
})

test('docker: probe reads each image, down to a missing compiler', { skip: !enabled, timeout: 120_000 }, async () => {
  const judgeInstance = new DockerContestJudge()
  const probe = await judgeInstance.probe(GPP)
  assert.match(probe.python ?? '', /^3\.\d+/)
  assert.match(probe.gpp ?? '', /^\d+/)
  assert.match(probe.gcc ?? '', /^\d+/)
  // An image without a compiler answers null for it, so C and C++ are offered as unavailable, not as broken.
  const bare = await judgeInstance.probe(NO_COMPILER)
  assert.match(bare.python ?? '', /^3\.\d+/)
  assert.equal(bare.gpp, null)
  assert.equal(bare.gcc, null)
})

test('docker: sweep removes a leftover judge container of this instance, and only it', { skip: !enabled, timeout: 120_000 }, async () => {
  const mine = `colloq-contest-sweep-mine-${process.pid}`
  // One of this instance (both labels) and one of another instance (a different
  // scope): the sweep must take the first and leave the second untouched.
  const other = `colloq-contest-sweep-other-${process.pid}`
  try {
    execFileSync('docker', ['run', '-d', '--name', mine, '--network', 'none',
      '--label', 'colloq.kind=contest-judge', '--label', INSTANCE_LABEL,
      '--entrypoint', 'sh', BASE, '-c', 'sleep 120'], { stdio: 'ignore' })
    execFileSync('docker', ['run', '-d', '--name', other, '--network', 'none',
      '--label', 'colloq.kind=contest-judge', '--label', 'ru.colloq.competition-instance=0000000000000000',
      '--entrypoint', 'sh', BASE, '-c', 'sleep 120'], { stdio: 'ignore' })

    const removed = await new DockerContestJudge().sweep()
    assert.ok(removed >= 1, 'the sweep removed at least our own leftover')
    assert.equal(spawnSync('docker', ['ps', '-aq', '--filter', `name=${mine}`], { encoding: 'utf8' }).stdout.trim(), '')
    assert.notEqual(spawnSync('docker', ['ps', '-aq', '--filter', `name=${other}`], { encoding: 'utf8' }).stdout.trim(), '', 'another instance\'s container is left alone')
  } finally {
    spawnSync('docker', ['rm', '-f', mine], { stdio: 'ignore' })
    spawnSync('docker', ['rm', '-f', other], { stdio: 'ignore' })
  }
})
