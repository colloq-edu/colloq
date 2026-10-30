/**
 * The judge's pure parts, with no python and no docker.
 *
 * Everything here breaks quietly and expensively if it is wrong: a `docker run`
 * line that lost `--network none` is a submission with internet, a stdin frame
 * off by the checker's length is every answer read one byte short, a verdict
 * worked out from the wrong test is a board that lies. So the argv is pinned
 * exactly, the framing and the sizing are checked against the numbers the
 * design fixed, and the assembler is fed the harness's own lines and asked for
 * the outcome the queue will write.
 */
import './_env.mts'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { COMPILE_LOG_BYTES, SNIPPET_BYTES } from '../shared/contests.ts'
import { dataDir } from '../server/src/data-dir.ts'
import {
  buildJobHeader,
  contestJudgeArgs,
  jobStdinChunks,
  judgeMemoryMb,
  noteText,
  OutcomeAssembler,
  parseProbe,
  secretTmpfsMb,
  totalAnswerBytes,
  wallBudgetSeconds,
  workTmpfsMb,
  type HarnessLine,
} from '../server/src/contests/judge/docker-judge.ts'
import { languageAvailable, languageLabel, shortVersion } from '../server/src/contests/judge/languages.ts'
import { parseDirectives, FakeContestJudge } from '../server/src/contests/judge/fake-judge.ts'
import { JUDGE_FILE, JUDGE_REVISION } from '../server/src/contests/judge/harness.ts'
import type { JudgeMode, JudgeRequest, JudgeTest, LanguageProbe } from '../server/src/contests/judge/port.ts'
import { buildRequest } from './_contest-judge.mts'

/* ------------------------------------------------------------- the argv */

const INSTANCE = createHash('sha256').update(path.resolve(dataDir)).digest('hex').slice(0, 16)

test('the docker argv is exactly the hardened line the design fixed', () => {
  const args = contestJudgeArgs({
    container: 'colloq-contest-s7-1',
    image: 'colloq-kernel:base',
    judgeDir: '/data/contests/.judge/abc',
    jobDir: '/data/contests/c1/runs/s7-1',
    testsDir: '/data/contests/c1/problems/p1/r3/in',
    memoryMb: 1536,
    workMb: 256,
    secretMb: 129,
  })
  assert.deepEqual(args, [
    'run', '-i', '--pull=never',
    '--name', 'colloq-contest-s7-1',
    '--network', 'none',
    '--read-only',
    '--user', '0:0',
    '--cap-drop', 'ALL',
    '--cap-add', 'SETUID', '--cap-add', 'SETGID', '--cap-add', 'KILL',
    '--security-opt', 'no-new-privileges',
    '--pids-limit', '128',
    '--memory', '1536m', '--memory-swap', '1536m',
    '--cpus', '1',
    '--tmpfs', '/tmp:rw,nosuid,nodev,noexec,size=64m,mode=1777',
    '--tmpfs', '/work:rw,nosuid,nodev,exec,size=256m,mode=1777',
    '--tmpfs', '/secret:rw,nosuid,nodev,noexec,size=129m,mode=700',
    '-v', '/data/contests/.judge/abc:/judge:ro',
    '-v', '/data/contests/c1/runs/s7-1:/job:ro',
    '-v', '/data/contests/c1/problems/p1/r3/in:/tests:ro',
    '--label', 'colloq.kind=contest-judge',
    '--label', `ru.colloq.competition-instance=${INSTANCE}`,
    '--log-driver=local', '--log-opt', 'max-size=8m',
    '-w', '/work',
    '-e', 'PYTHONDONTWRITEBYTECODE=1',
    '-e', 'PYTHONUNBUFFERED=1',
    '--entrypoint', 'python3',
    'colloq-kernel:base',
    '-I', `/judge/${JUDGE_FILE}`,
  ])
})

test('the instance label scopes to this data root, so two trees do not sweep each other', () => {
  assert.match(`ru.colloq.competition-instance=${INSTANCE}`, /^ru\.colloq\.competition-instance=[0-9a-f]{16}$/)
  const other = createHash('sha256').update('/some/other/root').digest('hex').slice(0, 16)
  assert.notEqual(other, INSTANCE)
})

/* --------------------------------------------------------------- sizing */

function tests(count: number, answerBytes = 0): JudgeTest[] {
  return Array.from({ length: count }, (_unused, index) => ({
    ordinal: index + 1,
    sample: false,
    group: 0,
    answer: answerBytes ? Buffer.alloc(answerBytes, 0x41) : Buffer.alloc(0),
  }))
}

test('the cgroup memory is the compiler room plus a cushion plus the answers', () => {
  // max(256, 1024) + 256 + ceil(0/MiB) = 1280 for a small problem.
  assert.equal(judgeMemoryMb({ memoryMb: 256, mode: 'icpc', tests: tests(3) }), 1280)
  // The program's own limit wins once it is over the compiler room.
  assert.equal(judgeMemoryMb({ memoryMb: 2048, mode: 'icpc', tests: tests(3) }), 2048 + 256)
  // Three answers of 1 MiB each add 3 MiB.
  assert.equal(judgeMemoryMb({ memoryMb: 256, mode: 'icpc', tests: tests(3, 1024 * 1024) }), 1280 + 3)
  // Mode answers carries none, so nothing is added for them.
  assert.equal(totalAnswerBytes({ mode: 'answers', tests: tests(3, 1024 * 1024) }), 0)
})

test('the secret tmpfs holds the answers, two output caps and the checker', () => {
  // 0 answers + 128 MiB (two 64 MiB caps) + 0 checker = 128.
  assert.equal(secretTmpfsMb({ mode: 'icpc', tests: tests(2), checker: { kind: 'tokens', epsilon: 0, code: '' } }), 128)
  assert.equal(workTmpfsMb(), 256)
})

test('the wall budget is a minute plus 2*TL+1 per test, capped at twenty minutes', () => {
  assert.equal(wallBudgetSeconds({ timeLimitMs: 1000, tests: tests(3) }), 60 + 3 * 3)
  assert.equal(wallBudgetSeconds({ timeLimitMs: 15000, tests: tests(300) }), 20 * 60)
})

/* --------------------------------------------------------- stdin framing */

test('the stdin is the header line, then the answers in order, then the checker', () => {
  const built = buildRequest({
    source: 'x',
    checker: 'custom',
    checkerCode: 'def check(i,o,a): return True',
    tests: [
      { ordinal: 1, input: 'a', answer: 'one' },
      { ordinal: 2, input: 'b', answer: 'twotwo' },
    ],
  })
  const header = buildJobHeader(built.request)
  assert.equal(header.v, 1)
  assert.equal(header.outputCap, 64 * 1024 * 1024)
  assert.equal(header.snippetBytes, SNIPPET_BYTES)
  assert.equal(header.compileLogBytes, COMPILE_LOG_BYTES)
  assert.deepEqual(header.tests, [
    { n: 1, sample: false, group: 0, answerBytes: 3 },
    { n: 2, sample: false, group: 0, answerBytes: 6 },
  ])
  assert.equal(header.checker.codeBytes, Buffer.byteLength('def check(i,o,a): return True'))

  const stdin = Buffer.concat([...jobStdinChunks(built.request)])
  const newline = stdin.indexOf(0x0a)
  assert.deepEqual(JSON.parse(stdin.subarray(0, newline).toString()), header)
  assert.equal(stdin.subarray(newline + 1).toString(), 'one' + 'twotwo' + 'def check(i,o,a): return True')
  built.cleanup()
})

test('mode answers frames a header with null answerBytes and sends no answers', () => {
  const built = buildRequest({ source: 'x', mode: 'answers', tests: [{ ordinal: 1, input: 'a' }, { ordinal: 2, input: 'b' }] })
  const header = buildJobHeader(built.request)
  assert.deepEqual(header.tests.map((t) => t.answerBytes), [null, null])
  const stdin = Buffer.concat([...jobStdinChunks(built.request)])
  assert.equal(stdin.subarray(stdin.indexOf(0x0a) + 1).length, 0)
  built.cleanup()
})

/* ------------------------------------------------- the outcome assembler */

/** A minimal request shape the assembler reads. */
function forTests(count: number, mode: JudgeMode = 'icpc'): Pick<JudgeRequest, 'tests' | 'mode' | 'onProgress'> {
  return { tests: tests(count), mode }
}

interface Ended {
  oomKilled: boolean
  killedReason: string | null
  wallMs: number
}
const ENDED: Ended = { oomKilled: false, killedReason: null, wallMs: 5 }

function assemble(lines: HarnessLine[], request: Pick<JudgeRequest, 'tests' | 'mode' | 'onProgress'>, ended: Ended = ENDED) {
  const assembler = new OutcomeAssembler(request)
  for (const line of lines) assembler.line(line)
  return assembler.build({ ...ended, stderrTail: '' })
}

test('all tests OK gives OK, the counts and the peaks', () => {
  const outcome = assemble(
    [
      { t: 'compile' },
      { t: 'compiled', ok: true, log: 'a warning' },
      { t: 'start', n: 1 },
      { t: 'test', n: 1, v: 'OK', ms: 12, kb: 9000 },
      { t: 'start', n: 2 },
      { t: 'test', n: 2, v: 'OK', ms: 7, kb: 9500 },
      { t: 'done' },
    ],
    forTests(2),
  )
  assert.equal(outcome.verdict, 'OK')
  assert.equal(outcome.compileLog, 'a warning')
  assert.equal(outcome.passed, 2)
  assert.equal(outcome.total, 2)
  assert.equal(outcome.failedTest, null)
  assert.equal(outcome.timeMs, 12)
  assert.equal(outcome.memoryKb, 9500)
  assert.equal(outcome.systemDetail, null)
  assert.equal(outcome.answers, null)
  assert.equal(outcome.wallMs, 5)
})

test('ICPC: the first failure is the verdict and the rest are skipped', () => {
  const outcome = assemble(
    [
      { t: 'compiled', ok: true, log: '' },
      { t: 'start', n: 1 },
      { t: 'test', n: 1, v: 'OK', ms: 3, kb: 800 },
      { t: 'start', n: 2 },
      { t: 'test', n: 2, v: 'WA', ms: 4, kb: 900, note: { code: 'tokens.differ', params: { n: 1, expected: '5', got: '4' } } },
      { t: 'done' },
    ],
    forTests(4),
  )
  assert.equal(outcome.verdict, 'WA')
  assert.equal(outcome.failedTest, 2)
  assert.equal(outcome.passed, 1)
  assert.deepEqual(outcome.tests.map((row) => row.verdict), ['OK', 'WA', 'skipped', 'skipped'])
  assert.equal(outcome.tests[1].note, 'слово 1: ожидалось «5», получено «4»')
})

test('IOI: a failed test skips the rest of its group, not of the others', () => {
  const outcome = assemble(
    [
      { t: 'compiled', ok: true, log: '' },
      { t: 'start', n: 1 },
      { t: 'test', n: 1, v: 'OK', ms: 1, kb: 1 },
      { t: 'start', n: 2 },
      { t: 'test', n: 2, v: 'RE', ms: 1, kb: 1, exit: 'exit 1' },
      // test 3 shares group with 2 and is skipped by the harness; test 4 (other group) runs.
      { t: 'start', n: 4 },
      { t: 'test', n: 4, v: 'OK', ms: 1, kb: 1 },
      { t: 'done' },
    ],
    { tests: [
      { ordinal: 1, sample: false, group: 1, answer: Buffer.alloc(0) },
      { ordinal: 2, sample: false, group: 2, answer: Buffer.alloc(0) },
      { ordinal: 3, sample: false, group: 2, answer: Buffer.alloc(0) },
      { ordinal: 4, sample: false, group: 3, answer: Buffer.alloc(0) },
    ], mode: 'ioi' },
  )
  assert.equal(outcome.verdict, 'RE')
  assert.equal(outcome.failedTest, 2)
  assert.deepEqual(outcome.tests.map((row) => row.verdict), ['OK', 'RE', 'skipped', 'OK'])
  assert.equal(outcome.tests[1].exit, 'exit 1')
})

test('a compilation error is CE, with the log and no tests', () => {
  const outcome = assemble(
    [{ t: 'compile' }, { t: 'compiled', ok: false, log: 'solution.py:1: SyntaxError' }, { t: 'done' }],
    forTests(3),
  )
  assert.equal(outcome.verdict, 'CE')
  assert.equal(outcome.compileLog, 'solution.py:1: SyntaxError')
  assert.deepEqual(outcome.tests, [])
  assert.equal(outcome.failedTest, null)
  assert.equal(outcome.total, 3)
})

test('the harness saying se is SE, with the detail for the teacher', () => {
  const outcome = assemble(
    [{ t: 'compiled', ok: true, log: '' }, { t: 'start', n: 1 }, { t: 'done', se: 'the checker failed on test 1' }],
    forTests(2),
  )
  assert.equal(outcome.verdict, 'SE')
  assert.match(outcome.systemDetail ?? '', /the checker failed on test 1/)
  // The tests that did not finish are a complete, skipped strip.
  assert.deepEqual(outcome.tests.map((row) => row.verdict), ['skipped', 'skipped'])
})

test('a container out of memory with no done marks the in-flight test ML, not SE', () => {
  const outcome = assemble(
    [{ t: 'compiled', ok: true, log: '' }, { t: 'start', n: 1 }, { t: 'test', n: 1, v: 'OK', ms: 1, kb: 1 }, { t: 'start', n: 2 }],
    forTests(3),
    { oomKilled: true, killedReason: null, wallMs: 9 },
  )
  assert.equal(outcome.verdict, 'ML')
  assert.equal(outcome.failedTest, 2)
  assert.deepEqual(outcome.tests.map((row) => row.verdict), ['OK', 'ML', 'skipped'])
  assert.equal(outcome.systemDetail, null)
})

test('a container gone with no done and no OOM is SE, not a verdict for the participant', () => {
  const outcome = assemble(
    [{ t: 'compiled', ok: true, log: '' }, { t: 'start', n: 1 }],
    forTests(2),
    { oomKilled: false, killedReason: null, wallMs: 9 },
  )
  assert.equal(outcome.verdict, 'SE')
  assert.match(outcome.systemDetail ?? '', /without a result/)
})

test('a host kill (wall budget) with no done is SE naming the reason', () => {
  const outcome = assemble(
    [{ t: 'compiled', ok: true, log: '' }, { t: 'start', n: 1 }],
    forTests(1),
    { oomKilled: false, killedReason: 'wall budget exceeded', wallMs: 9 },
  )
  assert.equal(outcome.verdict, 'SE')
  assert.match(outcome.systemDetail ?? '', /wall budget exceeded/)
})

test('mode answers collects each test\'s bytes into the answers map', () => {
  const one = Buffer.from('hello\n').toString('base64')
  const two = Buffer.from('world').toString('base64')
  const outcome = assemble(
    [
      { t: 'compiled', ok: true, log: '' },
      { t: 'start', n: 1 },
      { t: 'answer', n: 1, b64: one },
      { t: 'test', n: 1, v: 'OK', ms: 1, kb: 1, bytes: 6 },
      { t: 'start', n: 2 },
      { t: 'answer', n: 2, b64: two },
      { t: 'test', n: 2, v: 'OK', ms: 1, kb: 1, bytes: 5 },
      { t: 'done' },
    ],
    forTests(2, 'answers'),
  )
  assert.equal(outcome.verdict, 'OK')
  assert.ok(outcome.answers)
  assert.equal(outcome.answers?.get(1)?.toString(), 'hello\n')
  assert.equal(outcome.answers?.get(2)?.toString(), 'world')
})

test('progress is reported for the compile and for every test', () => {
  const progress: unknown[] = []
  const assembler = new OutcomeAssembler({ ...forTests(2), onProgress: (p) => progress.push(p) })
  for (const line of [
    { t: 'compile' },
    { t: 'compiled', ok: true, log: '' },
    { t: 'start', n: 1 },
    { t: 'test', n: 1, v: 'OK', ms: 1, kb: 1 },
    { t: 'start', n: 2 },
    { t: 'test', n: 2, v: 'OK', ms: 1, kb: 1 },
    { t: 'done' },
  ] as HarnessLine[]) {
    assembler.line(line)
  }
  assert.deepEqual(progress, [
    { phase: 'compile', test: null, done: 0, total: 2 },
    { phase: 'test', test: 1, done: 0, total: 2 },
    { phase: 'test', test: null, done: 1, total: 2 },
    { phase: 'test', test: 2, done: 1, total: 2 },
    { phase: 'test', test: null, done: 2, total: 2 },
  ])
})

/* ------------------------------------------------------------- the note */

test('a builtin note is a compact, language-neutral form', () => {
  assert.equal(noteText({ code: 'tokens.differ', params: { n: 3, expected: '5', got: '4' } }), 'слово 3: ожидалось «5», получено «4»')
  assert.equal(noteText({ code: 'lines.long', params: { n: 2, got: 'extra' } }), 'вывод длиннее ответа: лишняя строка 2 — «extra»')
  assert.equal(noteText({ code: 'tokens.short', params: { n: 7, expected: 'missing' } }), 'вывод короче ответа: нет слова 7 — ожидалось «missing»')
  assert.equal(noteText('a teacher sentence'), 'a teacher sentence')
  assert.equal(noteText(''), undefined)
  assert.equal(noteText(undefined), undefined)
})

/* ------------------------------------------------------------ languages */

const FULL: LanguageProbe = { python: '3.11.16', gpp: '12.2.0', gcc: '12.2.0' }

test('a language label carries the version, names literal, no translation', () => {
  assert.equal(languageLabel('python3', FULL), 'Python 3.11')
  assert.equal(languageLabel('cpp20', FULL), 'C++20 · g++ 12.2')
  assert.equal(languageLabel('c17', FULL), 'C17 · gcc 12.2')
})

test('a missing compiler is unavailable and labelled without a version', () => {
  const noCompilers: LanguageProbe = { python: '3.11.16', gpp: null, gcc: null }
  assert.equal(languageAvailable('python3', noCompilers), true)
  assert.equal(languageAvailable('cpp20', noCompilers), false)
  assert.equal(languageAvailable('c17', noCompilers), false)
  assert.equal(languageLabel('cpp20', noCompilers), 'C++20')
  assert.equal(languageLabel('c17', noCompilers), 'C17')
})

test('shortVersion keeps at most major.minor', () => {
  assert.equal(shortVersion('3.11.16'), '3.11')
  assert.equal(shortVersion('12.2.0'), '12.2')
  assert.equal(shortVersion('13'), '13')
  assert.equal(shortVersion('weird'), 'weird')
})

/* --------------------------------------------------------------- probe */

test('parseProbe reads the versions and leaves a missing tool null', () => {
  assert.deepEqual(parseProbe('python 3.11.16\ngpp 12.2.0\ngcc 12.2.0'), { python: '3.11.16', gpp: '12.2.0', gcc: '12.2.0' })
  assert.deepEqual(parseProbe('python 3.11.16'), { python: '3.11.16', gpp: null, gcc: null })
  assert.deepEqual(parseProbe(''), { python: null, gpp: null, gcc: null })
})

/* --------------------------------------------------- the fake judge */

test('the fake judge reads magic comments', () => {
  assert.deepEqual([...parseDirectives('# judge: WA 3').fails], [[3, 'WA']])
  const many = parseDirectives('// judge: TL 2\n// judge: ML 5\n# judge: slow 40')
  assert.deepEqual([...many.fails], [[2, 'TL'], [5, 'ML']])
  assert.equal(many.slowMs, 40)
  assert.equal(parseDirectives('# judge: CE').ce, true)
  assert.equal(parseDirectives('# judge: SE').se, true)
  assert.equal(parseDirectives('print(1)  # nothing of ours').fails.size, 0)
})

test('the fake judge never runs code and matches the real outcome shape', async () => {
  const judge = new FakeContestJudge()
  const built = buildRequest({ source: '# judge: WA 2\nprint(1)', tests: [
    { ordinal: 1, input: 'a', answer: '1' },
    { ordinal: 2, input: 'b', answer: '2' },
    { ordinal: 3, input: 'c', answer: '3' },
  ] })
  const outcome = await judge.judge(built.request)
  assert.equal(outcome.verdict, 'WA')
  assert.equal(outcome.failedTest, 2)
  assert.deepEqual(outcome.tests.map((row) => row.verdict), ['OK', 'WA', 'skipped'])
  assert.equal(outcome.answers, null)
  built.cleanup()
})

test('the fake judge CE and SE', async () => {
  const judge = new FakeContestJudge()
  const ce = buildRequest({ source: '# judge: CE', tests: [{ ordinal: 1, input: 'a', answer: '1' }] })
  assert.equal((await judge.judge(ce.request)).verdict, 'CE')
  ce.cleanup()
  const se = buildRequest({ source: '# judge: SE', tests: [{ ordinal: 1, input: 'a', answer: '1' }] })
  const outcome = await judge.judge(se.request)
  assert.equal(outcome.verdict, 'SE')
  assert.match(outcome.systemDetail ?? '', /judge error/)
  se.cleanup()
})

test('the fake judge in mode answers hands back each test\'s input as its answer', async () => {
  const judge = new FakeContestJudge()
  const built = buildRequest({ source: 'print(1)', mode: 'answers', tests: [
    { ordinal: 1, input: 'first input\n' },
    { ordinal: 2, input: 'second' },
  ] })
  const outcome = await judge.judge(built.request)
  assert.equal(outcome.verdict, 'OK')
  assert.equal(outcome.answers?.get(1)?.toString(), 'first input\n')
  assert.equal(outcome.answers?.get(2)?.toString(), 'second')
  built.cleanup()
})

test('the fake judge probe and sweep', async () => {
  const judge = new FakeContestJudge()
  assert.deepEqual(await judge.probe('colloq-kernel:base'), { python: '3.11.0', gpp: '12.2.0', gcc: '12.2.0' })
  assert.equal(await judge.sweep(), 0)
})

/* ----------------------------------------------------- the harness lays out */

test('the harness revision is a short content hash and its file is judge.py', () => {
  assert.match(JUDGE_REVISION, /^[0-9a-f]{12}$/)
  assert.equal(JUDGE_FILE, 'judge.py')
})
