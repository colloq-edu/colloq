/**
 * The real judge, with real docker: opt-in (COLLOQ_CONTEST_DOCKER_TEST=1),
 * because it starts containers and is slow where the rest of the suite is not.
 *
 * It proves what only a container can: that a correct Python and a correct C++
 * submission are judged OK, that WA/TL/ML/RE/CE come back as themselves through
 * the whole pipeline, and above all the safety properties the design rests
 * on — a program CANNOT READ THE ANSWERS (everything under /secret and the
 * harness's own descriptors is closed to it: a solution that tries gets WA, not
 * OK) and a program CANNOT START ANOTHER PROCESS (fork, subprocess, posix_spawn,
 * system() all fail, threads work: its memory is one process's peak, and
 * nothing it starts can outlive its test).
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

/*
 * A program is one process (audit F09). Its memory is the peak wait4 reports,
 * and that is the largest of its processes, not their sum: two children of
 * 64 MiB each under a 96 MiB limit were OK, each child under the limit on its
 * own. Every way to start a process now fails, so a program that leans on one
 * fails with it (RE: the program reports the refusal and exits non-zero), and
 * nothing it starts can outlive its test. Threads still work, and count
 * together: they share the one process's memory.
 */
const PY_CHILD = 'b = bytearray(64 << 20)\\nfor i in range(0, len(b), 4096):\\n    b[i] = 1\\nimport time\\ntime.sleep(0.3)\\n'
const SPREAD_PY: Record<string, string> = {
  'os.fork':
    'import os, sys, time\n' +
    'a, b = map(int, sys.stdin.readline().split())\n' +
    'kids = []\n' +
    'for _ in range(2):\n' +
    '    pid = os.fork()\n' +
    '    if pid == 0:\n' +
    `        exec("${PY_CHILD}")\n` +
    '        os._exit(0)\n' +
    '    kids.append(pid)\n' +
    'assert all(os.waitpid(pid, 0)[1] == 0 for pid in kids)\n' +
    'print(a + b)\n',
  subprocess:
    'import subprocess, sys\n' +
    'a, b = map(int, sys.stdin.readline().split())\n' +
    `kids = [subprocess.Popen([sys.executable, "-c", "${PY_CHILD}"]) for _ in range(2)]\n` +
    'assert all(kid.wait() == 0 for kid in kids)\n' +
    'print(a + b)\n',
  multiprocessing:
    'import multiprocessing, sys, time\n' +
    'def grab(_):\n' +
    '    block = bytearray(64 << 20)\n' +
    '    for i in range(0, len(block), 4096):\n' +
    '        block[i] = 1\n' +
    '    time.sleep(0.3)\n' +
    '    return 1\n' +
    'if __name__ == "__main__":\n' +
    '    a, b = map(int, sys.stdin.readline().split())\n' +
    '    with multiprocessing.Pool(2) as pool:\n' +
    '        assert sum(pool.map(grab, range(2))) == 2\n' +
    '    print(a + b)\n',
}
/** The C side: the same two children of 64 MiB, started three ways; argv[1] makes the binary a child. */
const C_CHILD =
  '#include <spawn.h>\n#include <stdio.h>\n#include <stdlib.h>\n#include <string.h>\n#include <unistd.h>\n#include <sys/wait.h>\n' +
  'extern char **environ;\n' +
  // volatile: at -O2 GCC drops a malloc and memset nothing reads back, and the child would hold no memory at all.
  'static int child(void) { size_t n = 64u << 20; volatile char *p = malloc(n); if (!p) return 1; for (size_t i = 0; i < n; i += 4096) p[i] = 1; usleep(300000); return p[n - 4096] == 1 ? 0 : 1; }\n' +
  'static int reaped(pid_t pid) { int st; return waitpid(pid, &st, 0) == pid && WIFEXITED(st) && WEXITSTATUS(st) == 0; }\n'
const SPREAD_C: Record<string, string> = {
  fork: C_CHILD +
    'int main(void) { long a, b; if (scanf("%ld %ld", &a, &b) != 2) return 2; pid_t kids[2];\n' +
    '  for (int k = 0; k < 2; k++) { kids[k] = fork(); if (kids[k] < 0) { perror("fork"); return 1; } if (kids[k] == 0) _exit(child()); }\n' +
    '  if (!reaped(kids[0]) || !reaped(kids[1])) return 1; printf("%ld\\n", a + b); return 0; }\n',
  posix_spawn: C_CHILD +
    'int main(int argc, char **argv) { if (argc > 1) return child(); long a, b; if (scanf("%ld %ld", &a, &b) != 2) return 2;\n' +
    '  char *args[] = { argv[0], "child", NULL }; pid_t kids[2];\n' +
    '  for (int k = 0; k < 2; k++) { int rc = posix_spawn(&kids[k], argv[0], NULL, NULL, args, environ); if (rc) { fprintf(stderr, "posix_spawn: %s\\n", strerror(rc)); return 1; } }\n' +
    '  if (!reaped(kids[0]) || !reaped(kids[1])) return 1; printf("%ld\\n", a + b); return 0; }\n',
  system: C_CHILD +
    'int main(int argc, char **argv) { if (argc > 1) return child(); long a, b; if (scanf("%ld %ld", &a, &b) != 2) return 2;\n' +
    '  char line[512]; snprintf(line, sizeof line, "%s child & %s child & wait", argv[0], argv[0]);\n' +
    '  int rc = system(line); if (rc != 0) { fprintf(stderr, "system: %d\\n", rc); return 1; } printf("%ld\\n", a + b); return 0; }\n',
}
const ONE_SUM: BuildOptions['tests'] = [{ ordinal: 1, input: '1 2\n', answer: '3\n' }]

/** Every way judged, then one assertion over all of them: a failure shows the whole picture, not its first line. */
async function spread(image: string, language: 'python3' | 'c17', ways: Record<string, string>) {
  const seen: Record<string, JudgeOutcome> = {}
  for (const [way, source] of Object.entries(ways)) {
    const started = Date.now()
    seen[way] = (await judge(image, { language, source, memoryMb: 96, tests: ONE_SUM })).outcome
    console.log(`[contest-judge] ${language} ${way}: ${seen[way].verdict}, ${seen[way].tests[0]?.memoryKb ?? '?'} KB, ${seen[way].tests[0]?.exit ?? 'exit 0'}, ${Date.now() - started} ms`)
  }
  assert.deepEqual(Object.fromEntries(Object.entries(seen).map(([way, outcome]) => [way, outcome.verdict])),
    Object.fromEntries(Object.keys(ways).map((way) => [way, 'RE'])), JSON.stringify(seen))
  return seen
}

test('docker: a Python program cannot spread its memory over processes — fork, subprocess, multiprocessing', { skip: !enabled, timeout: 240_000 }, async () => {
  for (const [way, outcome] of Object.entries(await spread(BASE, 'python3', SPREAD_PY)))
    assert.match(outcome.tests[0].stderr ?? '', /PermissionError|Operation not permitted/, way)
})

test('docker: a C program cannot either — fork, posix_spawn, system()', { skip: !enabled, timeout: 240_000 }, async () => {
  for (const [way, outcome] of Object.entries(await spread(GPP, 'c17', SPREAD_C)))
    assert.match(outcome.tests[0].stderr ?? '', /fork|posix_spawn|system/, way)
})

test('docker: threads still work, and their memory counts together', { skip: !enabled, timeout: 240_000 }, async () => {
  const threads = await judge(GPP, {
    language: 'cpp20',
    source:
      '#include <iostream>\n#include <thread>\n' +
      'int main() { long a, b, parts[2]; std::cin >> a >> b;\n' +
      '  std::thread first([&] { parts[0] = a; }), second([&] { parts[1] = b; });\n' +
      '  first.join(); second.join(); std::cout << parts[0] + parts[1] << "\\n"; }\n',
    tests: THREE,
  })
  assert.equal(threads.outcome.verdict, 'OK', JSON.stringify(threads.outcome))
  // numpy is imported with its thread pools capped (base_env): an import, not a process.
  const python = await judge(BASE, {
    source:
      'import sys, threading\nimport numpy as np\n' +
      'parts = [0, 0]\n' +
      'def put(i, value):\n    parts[i] = int(np.int64(value))\n' +
      'for line in sys.stdin:\n' +
      '    a, b = map(int, line.split())\n' +
      '    workers = [threading.Thread(target=put, args=(0, a)), threading.Thread(target=put, args=(1, b))]\n' +
      '    for w in workers:\n        w.start()\n' +
      '    for w in workers:\n        w.join()\n' +
      '    print(sum(parts))\n',
    tests: THREE,
  })
  assert.equal(python.outcome.verdict, 'OK', JSON.stringify(python.outcome))
  // Two threads of 64 MiB each are one process of 128: ML under 96, as the children should have been.
  const together = await judge(GPP, {
    language: 'cpp20',
    source:
      '#include <chrono>\n#include <iostream>\n#include <thread>\n#include <vector>\n' +
      'int main() { long a, b; std::cin >> a >> b; char got[2];\n' +
      '  auto grab = [](char *out) { std::vector<char> block(64u << 20, 1); std::this_thread::sleep_for(std::chrono::milliseconds(300)); *out = block.back(); };\n' +
      '  std::thread first(grab, &got[0]), second(grab, &got[1]); first.join(); second.join();\n' +
      '  std::cout << a + b + got[0] - got[1] << "\\n"; }\n',
    memoryMb: 96,
    tests: ONE_SUM,
  })
  assert.equal(together.outcome.verdict, 'ML', JSON.stringify(together.outcome))
  assert.ok((together.outcome.tests[0].memoryKb ?? 0) > 128 * 1024, JSON.stringify(together.outcome.tests[0]))
})

test('docker: one process near its limit — under is OK, over is ML, memory given back is not counted twice', { skip: !enabled, timeout: 240_000 }, async () => {
  const grab = (mib: number) => `b = bytearray(${mib} << 20)\nfor i in range(0, len(b), 4096):\n    b[i] = 1\n`
  const sum = 'import sys\na, b = map(int, sys.stdin.readline().split())\nprint(a + b)\n'
  const under = await judge(BASE, { source: grab(60) + sum, memoryMb: 96, tests: ONE_SUM })
  assert.equal(under.outcome.verdict, 'OK', JSON.stringify(under.outcome))
  assert.ok((under.outcome.memoryKb ?? 0) > 60 * 1024 && (under.outcome.memoryKb ?? 0) < 96 * 1024, JSON.stringify(under.outcome))
  const over = await judge(BASE, { source: grab(110) + sum, memoryMb: 96, tests: ONE_SUM })
  assert.equal(over.outcome.verdict, 'ML', JSON.stringify(over.outcome))
  const twice = await judge(BASE, { source: grab(60) + 'del b\n' + grab(60) + sum, memoryMb: 96, tests: ONE_SUM })
  assert.equal(twice.outcome.verdict, 'OK', JSON.stringify(twice.outcome))
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
