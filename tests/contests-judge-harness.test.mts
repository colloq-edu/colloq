/**
 * The real Python harness, run by the system `python3` with no container.
 *
 * This is the half the stand-in cannot prove: the checkers' arithmetic, a
 * busy loop caught as TL, an exit code read as RE, a flood caught as OL, a
 * syntax error as CE, and the way ICPC and IOI decide which tests run. It
 * exercises the harness through the docker judge's OWN stdin framing and the
 * SAME OutcomeAssembler the real run parses with, so a drift in either shows
 * here, in milliseconds, without a container.
 *
 * It runs in plain `npm test`: fast (seconds, not minutes), hermetic (temp
 * dirs only), deterministic. It needs a `python3` on PATH and refuses to run
 * as root — the harness's no-sandbox mode will not run a program as root — and
 * skips with that reason when it cannot.
 */
import './_env.mts'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { judgeDir, JUDGE_FILE } from '../server/src/contests/judge/harness.ts'
import { buildRequest, harnessRunnable, runHarnessNoSandbox, type BuildOptions } from './_contest-judge.mts'

const runnable = harnessRunnable()
const SKIP = runnable.ok ? false : runnable.reason

/** Build, run through the real harness, then clean up. */
function judge(options: BuildOptions) {
  const built = buildRequest(options)
  try {
    return runHarnessNoSandbox(built)
  } finally {
    built.cleanup()
  }
}

const SUM = 'import sys\nfor line in sys.stdin:\n    a, b = line.split()\n    print(int(a) + int(b))\n'
const THREE: BuildOptions['tests'] = [
  { ordinal: 1, input: '1 2\n', answer: '3\n', sample: true },
  { ordinal: 2, input: '5 7\n', answer: '12\n' },
  { ordinal: 3, input: '10 20\n', answer: '30\n' },
]

test('tokens: a correct Python solution is OK on every test', { skip: SKIP }, () => {
  const run = judge({ source: SUM, tests: THREE })
  assert.equal(run.outcome.verdict, 'OK')
  assert.equal(run.outcome.passed, 3)
  assert.equal(run.outcome.failedTest, null)
  assert.ok((run.outcome.timeMs ?? 0) >= 0)
  // The example's output comes back (it is shown to the author); the hidden tests' does not.
  assert.ok(run.outcome.tests[0].output)
  assert.equal(run.outcome.tests[1].output, undefined)
})

test('tokens: a wrong answer is WA at the first failing test, with a neutral note', { skip: SKIP }, () => {
  const run = judge({
    source: 'import sys\nfor line in sys.stdin:\n    a, b = line.split()\n    print(int(a) + int(b) if int(a) < 5 else 0)\n',
    tests: THREE,
  })
  assert.equal(run.outcome.verdict, 'WA')
  assert.equal(run.outcome.failedTest, 2)
  assert.deepEqual(run.outcome.tests.map((t) => t.verdict), ['OK', 'WA', 'skipped'])
  assert.match(run.outcome.tests[1].note ?? '', /ожидалось/)
})

test('tokens: whitespace does not matter, order does', { skip: SKIP }, () => {
  // Spaces and newlines differ from the answer, tokens are identical -> OK.
  const run = judge({ source: 'print(" 3 \\n")\n', tests: [{ ordinal: 1, input: 'x', answer: '3\n' }] })
  assert.equal(run.outcome.verdict, 'OK')
})

test('lines: trailing spaces and trailing blank lines are ignored', { skip: SKIP }, () => {
  const run = judge({
    source: 'import sys\nsys.stdout.write("a b  \\n\\n\\n")\n',
    checker: 'lines',
    tests: [{ ordinal: 1, input: 'x', answer: 'a b\n' }],
  })
  assert.equal(run.outcome.verdict, 'OK')
})

test('lines: an inner difference is WA', { skip: SKIP }, () => {
  const run = judge({ source: 'print("a\\nX\\nc")\n', checker: 'lines', tests: [{ ordinal: 1, input: 'x', answer: 'a\nb\nc\n' }] })
  assert.equal(run.outcome.verdict, 'WA')
})

test('float: within epsilon is OK, outside is WA', { skip: SKIP }, () => {
  const near = judge({ source: 'print(0.3333334)\n', checker: 'float', epsilon: 1e-6, tests: [{ ordinal: 1, input: 'x', answer: '0.3333333\n' }] })
  assert.equal(near.outcome.verdict, 'OK')
  const far = judge({ source: 'print(0.34)\n', checker: 'float', epsilon: 1e-6, tests: [{ ordinal: 1, input: 'x', answer: '0.3333333\n' }] })
  assert.equal(far.outcome.verdict, 'WA')
})

test('custom: the teacher\'s check decides, and its message is the note', { skip: SKIP }, () => {
  const run = judge({
    source: 'import sys, math\nfor line in sys.stdin:\n    print(math.isqrt(int(line)))\n',
    checker: 'custom',
    checkerCode: 'def check(inp, out, ans):\n    return int(out) ** 2 == int(inp), "square ok"\n',
    tests: [{ ordinal: 1, input: '4\n', answer: '2\n' }, { ordinal: 2, input: '9\n', answer: '3\n' }],
  })
  assert.equal(run.outcome.verdict, 'OK')
  assert.equal(run.outcome.tests[0].note, 'square ok')
})

test('custom: a checker that raises is SE for the submission, not a verdict', { skip: SKIP }, () => {
  const run = judge({
    source: 'print(input())\n',
    checker: 'custom',
    checkerCode: 'def check(inp, out, ans):\n    return 1 / 0\n',
    tests: [{ ordinal: 1, input: '4\n', answer: '2\n' }],
  })
  assert.equal(run.outcome.verdict, 'SE')
  assert.match(run.outcome.systemDetail ?? '', /ZeroDivisionError/)
})

test('TL: a busy loop is caught by the CPU limit', { skip: SKIP }, () => {
  const run = judge({ source: 'while True:\n    pass\n', timeLimitMs: 300, tests: [{ ordinal: 1, input: 'x', answer: 'y' }] })
  assert.equal(run.outcome.verdict, 'TL')
  assert.equal(run.outcome.failedTest, 1)
})

test('RE: a non-zero exit is a runtime error, with the exit for staff', { skip: SKIP }, () => {
  const run = judge({ source: 'import sys\nsys.exit(3)\n', tests: [{ ordinal: 1, input: 'x', answer: 'y' }] })
  assert.equal(run.outcome.verdict, 'RE')
  assert.equal(run.outcome.tests[0].exit, 'exit 3')
})

test('OL: output past the cap is caught, not kept in memory as WA', { skip: SKIP }, () => {
  // Write well past a tiny per-test cap. The real cap is 64 MiB; here RLIMIT_FSIZE fires.
  const run = judge({ source: 'import sys\nsys.stdout.write("x" * (80 * 1024 * 1024))\n', tests: [{ ordinal: 1, input: 'x', answer: 'y' }] })
  assert.equal(run.outcome.verdict, 'OL')
})

test('CE: a Python syntax error compiles to nothing and runs nothing', { skip: SKIP }, () => {
  const run = judge({ source: 'def f(:\n    pass\n', tests: THREE })
  assert.equal(run.outcome.verdict, 'CE')
  assert.match(run.outcome.compileLog, /SyntaxError/)
  assert.deepEqual(run.outcome.tests, [])
})

test('ICPC stops at the first failure; the rest never run', { skip: SKIP }, () => {
  const run = judge({
    source: 'import sys\nfor line in sys.stdin:\n    a, b = line.split()\n    print(int(a) + int(b) if int(a) != 5 else 99)\n',
    mode: 'icpc',
    tests: THREE,
  })
  assert.deepEqual(run.outcome.tests.map((t) => t.verdict), ['OK', 'WA', 'skipped'])
  // The harness emitted no line for test 3 at all.
  assert.ok(!run.lines.some((line) => line.t === 'start' && line.n === 3))
})

test('IOI runs every group but skips the rest of a failed one', { skip: SKIP }, () => {
  const run = judge({
    source: 'import sys\nfor line in sys.stdin:\n    n = int(line)\n    print(n if n != 2 else -1)\n',
    mode: 'ioi',
    tests: [
      { ordinal: 1, input: '1\n', answer: '1\n', group: 1 },
      { ordinal: 2, input: '2\n', answer: '2\n', group: 1 },
      { ordinal: 3, input: '3\n', answer: '3\n', group: 1 },
      { ordinal: 4, input: '4\n', answer: '4\n', group: 2 },
    ],
  })
  assert.deepEqual(run.outcome.tests.map((t) => t.verdict), ['OK', 'WA', 'skipped', 'OK'])
  assert.equal(run.outcome.passed, 2)
})

test('mode answers runs every test and streams the outputs back, unchecked', { skip: SKIP }, () => {
  const run = judge({
    source: 'import sys\nfor line in sys.stdin:\n    print(int(line) * 2)\n',
    mode: 'answers',
    tests: [{ ordinal: 1, input: '21\n' }, { ordinal: 2, input: '50\n' }],
  })
  assert.equal(run.outcome.verdict, 'OK')
  assert.equal(run.outcome.answers?.get(1)?.toString(), '42\n')
  assert.equal(run.outcome.answers?.get(2)?.toString(), '100\n')
})

test('the harness protocol is JSON lines: compile, compiled, start, test, done', { skip: SKIP }, () => {
  const run = judge({ source: SUM, tests: THREE })
  const kinds = run.lines.map((line) => line.t)
  assert.equal(kinds[0], 'compile')
  assert.equal(kinds[1], 'compiled')
  assert.ok(kinds.includes('start'))
  assert.ok(kinds.includes('test'))
  assert.equal(kinds.at(-1), 'done')
  // The exit code is a clean 0: the harness ended itself.
  assert.equal(run.exitCode, 0)
})

/*
 * The program is one process (audit F09): the harness puts it under a seccomp
 * filter that refuses every way to start another, threads aside, so the peak
 * wait4 reports is the whole program's. Linux has the filter, in the
 * container and in this no-sandbox mode alike; off Linux — this suite on
 * macOS — a program may still start processes, and the reaping below is all
 * that stands between them and the next test.
 */
const LINUX = process.platform === 'linux'
const ONE_PROCESS = SKIP || (LINUX ? false : 'no seccomp off Linux: here the no-sandbox harness leaves a program free to start processes')
const FORKS = SKIP || (LINUX ? 'on Linux a program cannot start a process at all (the one-process cases)' : false)

test('a leftover process started by one test does not outlive it', { skip: FORKS }, () => {
  // Spawn a child that would sleep for a minute, then exit the test cleanly.
  // kill_leftovers() reaps it (no-sandbox reaps rather than killing by uid),
  // so the next test is OK and the run ends promptly, not after the child's sleep.
  const run = judge({
    source:
      'import os, sys, time\n' +
      'data = sys.stdin.readline().strip()\n' +
      'if os.fork() == 0:\n' +
      '    os.setsid()\n' +
      '    time.sleep(60)\n' +
      '    os._exit(0)\n' +
      'print(data)\n',
    tests: [{ ordinal: 1, input: 'hi\n', answer: 'hi\n' }],
  })
  assert.equal(run.outcome.verdict, 'OK')
})

test('on Linux a program is one process: fork, subprocess and multiprocessing fail, threads work', { skip: ONE_PROCESS }, () => {
  const sum = 'a, b = map(int, sys.stdin.readline().split())\nprint(a + b)\n'
  const ways: Record<string, string> = {
    'os.fork': 'import os, sys\nif os.fork() == 0:\n    os._exit(0)\nos.wait()\n' + sum,
    subprocess: 'import subprocess, sys\nsubprocess.run([sys.executable, "-c", "pass"], check=True)\n' + sum,
    multiprocessing: 'import multiprocessing, sys\nif __name__ == "__main__":\n    with multiprocessing.Pool(2) as pool:\n        pool.map(abs, [1, 2])\n' + sum,
  }
  const tests = [{ ordinal: 1, input: '1 2\n', answer: '3\n' }]
  for (const [way, source] of Object.entries(ways)) {
    const run = judge({ source, tests })
    assert.equal(run.outcome.verdict, 'RE', `${way}: ${JSON.stringify(run.outcome)}`)
    assert.match(run.outcome.tests[0].stderr ?? '', /PermissionError|Operation not permitted/, way)
  }
  const threads = judge({
    source: 'import sys, threading\nparts = []\nworkers = [threading.Thread(target=parts.append, args=(n,)) for n in map(int, sys.stdin.readline().split())]\n' +
      'for w in workers:\n    w.start()\nfor w in workers:\n    w.join()\nprint(sum(parts))\n',
    tests,
  })
  assert.equal(threads.outcome.verdict, 'OK', JSON.stringify(threads.outcome))
})

/**
 * Classic BPF as seccomp runs it, the five instructions the filter is made of,
 * over a struct seccomp_data of the call's number, the architecture and the
 * low half of the first argument: the filter's every decision, on any
 * machine — the x86_64 half included, which the Docker suite here (aarch64)
 * never reaches.
 */
function decide(rows: Buffer, nr: number, arch: number, arg0 = 0): number {
  const field = (offset: number): number => {
    if (offset === 0) return nr >>> 0
    if (offset === 4) return arch >>> 0
    if (offset === 16) return arg0 >>> 0
    throw new Error(`the filter reads offset ${offset}`)
  }
  let a = 0
  for (let pc = 0; pc * 8 < rows.length;) {
    const code = rows.readUInt16LE(pc * 8), yes = rows[pc * 8 + 2], no = rows[pc * 8 + 3], k = rows.readUInt32LE(pc * 8 + 4)
    if (code === 0x20) { a = field(k); pc++ }
    else if (code === 0x15) pc += 1 + (a === k ? yes : no)
    else if (code === 0x45) pc += 1 + ((a & k) !== 0 ? yes : no)
    else if (code === 0x06) return k
    else throw new Error(`instruction ${code.toString(16)} at ${pc}`)
  }
  throw new Error('the filter ran off its end')
}

test('the one-process filter answers by each machine\'s own numbers, and refuses another ABI outright', { skip: SKIP }, () => {
  const read = spawnSync('python3', ['-I', '-c', 'import runpy, sys; sys.stdout.write(runpy.run_path(sys.argv[1], run_name="judge")["one_process_filter"]().hex())',
    path.join(judgeDir(), JUDGE_FILE)], { encoding: 'utf8' })
  assert.equal(read.status, 0, read.stderr)
  const rows = Buffer.from(read.stdout, 'hex')
  const ALLOW = 0x7fff0000, EPERM = 0x50001, ENOSYS = 0x50026, KILL = 0x80000000
  const X86_64 = 0xc000003e, AARCH64 = 0xc00000b7, I386 = 0x40000003, ARM = 0x40000028
  // The flags glibc passes: fork, posix_spawn (and so system()), pthread_create.
  const FORK = 0x01200011, SPAWN = 0x4111, THREAD = 0x3d0f00
  const cases: Array<[string, number, number, number, number]> = [
    ['x86_64 fork', 57, X86_64, 0, EPERM],
    ['x86_64 vfork', 58, X86_64, 0, EPERM],
    ['x86_64 clone as fork', 56, X86_64, FORK, EPERM],
    ['x86_64 clone as posix_spawn', 56, X86_64, SPAWN, EPERM],
    ['x86_64 clone as a thread', 56, X86_64, THREAD, ALLOW],
    ['x86_64 clone3', 435, X86_64, 0, ENOSYS],
    ['x86_64 read', 0, X86_64, 0, ALLOW],
    ['x86_64 execve', 59, X86_64, 0, ALLOW],
    ['x32 clone', 0x40000000 + 56, X86_64, FORK, ENOSYS],
    ['x32 read', 0x40000000, X86_64, 0, ENOSYS],
    ['aarch64 clone as fork', 220, AARCH64, FORK, EPERM],
    ['aarch64 clone as posix_spawn', 220, AARCH64, SPAWN, EPERM],
    ['aarch64 clone as a thread', 220, AARCH64, THREAD, ALLOW],
    ['aarch64 clone3', 435, AARCH64, 0, ENOSYS],
    ['aarch64 close (x86_64 fork\'s number)', 57, AARCH64, 0, ALLOW],
    ['aarch64 vhangup (x86_64 vfork\'s number)', 58, AARCH64, 0, ALLOW],
    ['aarch64 read', 63, AARCH64, 0, ALLOW],
    ['i386 fork through int 0x80', 2, I386, 0, KILL],
    ['i386 anything', 3, I386, 0, KILL],
    ['AArch32 clone', 120, ARM, FORK, KILL],
  ]
  for (const [name, nr, arch, arg0, expected] of cases)
    assert.equal(decide(rows, nr, arch, arg0).toString(16), expected.toString(16), name)
})
