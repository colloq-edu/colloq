/**
 * The council's epoch from below (remote-classes.md §9.3–9.4, 9.7): a
 * notebook kernel freezes its names, and pool workers seed themselves from
 * the files and run attempts through the same entry and exit as on a
 * server.
 *
 * What runs here is the very Python the kernels get, on a real `python3`:
 * one process plays the notebook's kernel and exports, other processes play
 * workers that never saw its objects and load them from the files alone,
 * the way a worker on a machine does. Half of the cases need nothing but
 * the standard library and always run; tables, arrays, notebook classes,
 * sklearn and torch run where this `python3` has them, and say so when it
 * does not. Point PATH at a fuller interpreter to run them all.
 *
 * `python3` may be missing altogether; then only the pure half runs: the
 * builders of the cells and the parsers of their reports.
 */
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { chmodSync, copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { setLocaleResolver } from '../shared/i18n.js'
import {
  councilEnterSource,
  councilLeftLine,
  councilLeftWords,
  epochFiles,
  exportDropExpression,
  exportExpression,
  loadExpression,
  parseCouncilReport,
  parseExitReport,
  parseExportReport,
  parseSeedReport,
  COUNCIL_EXIT_SOURCE,
  COUNCIL_EXPORT_EXPR,
  COUNCIL_MODULE,
  COUNCIL_NOT_CARRIED,
  COUNCIL_REPORT_KEY,
  COUNCIL_SEED_EXPR,
  type CouncilExportOptions,
  type CouncilExportReport,
  type CouncilIsolationSettings,
} from '../server/src/kernel/council-isolation.js'
import { COUNCIL_EPOCH_BUFFERS_MAX, COUNCIL_EPOCH_DIR } from '../shared/remote-kernels.js'

/* ------------------------------------------------------ the pure half */

test('the export and the load are three statements that bind no name in the kernel', () => {
  const run = exportExpression({ seq: 7, mainRuns: 3 })
  const lines = run.code.split('\n')
  assert.equal(lines.length, 3)
  for (const line of lines) {
    assert.doesNotMatch(line, /^[A-Za-z_][A-Za-z0-9_]*\s*=[^=]/, `a name bound: ${line.slice(0, 40)}`)
    assert.doesNotMatch(line, /^(import|from|def|class)\s/)
  }
  // The isolation first, then the epoch half into the same module, each behind its own version.
  assert.match(lines[0], /'version', None\) != "[0-9a-f]{12}": exec\(compile\(/)
  assert.match(lines[1], /'epoch_version', None\) != "[0-9a-f]{12}": exec\(compile\(/)
  // The folder is the contract's own, inside the kernel's container.
  assert.ok(lines[2].includes(`.export(globals(), ${JSON.stringify(`${COUNCIL_EPOCH_DIR}/7`)}, `), lines[2])
  assert.match(lines[2], /'seq': 7, 'mainRuns': 3/)
  // The stream counts against the contract's cap on files too.
  assert.ok(lines[2].includes(`'buffers': ${COUNCIL_EPOCH_BUFFERS_MAX - 1}`))
  assert.deepEqual(run.userExpressions, { [COUNCIL_REPORT_KEY]: COUNCIL_EXPORT_EXPR })
  assert.doesNotMatch(lines[2], /\b(false|true|null)\b/)

  const sha = 'a'.repeat(64)
  const load = loadExpression({ manifest: sha, body: 'b'.repeat(64) })
  assert.equal(load.code.split('\n').length, 3)
  assert.ok(load.code.includes(`.load(globals(), "${sha}", "${'b'.repeat(64)}", {'dir': "/colloq/epochs"`))
  assert.deepEqual(load.userExpressions, { [COUNCIL_REPORT_KEY]: COUNCIL_SEED_EXPR })
  // A load is asked by hashes, and only by hashes.
  assert.throws(() => loadExpression({ manifest: 'x', body: sha }))
  assert.throws(() => exportExpression({ seq: 0, mainRuns: 0 }))

  // The epoch half travels with the export and the load only: an attempt's entry does not carry it.
  assert.ok(!councilEnterSource(1024).includes('epoch_version'))
  assert.ok(!councilEnterSource(1024, { source: 'x', runId: 'r1', capMb: 1024 }).includes('epoch_version'))
})

test('a worker\'s entry carries its inputs, and refuses to be built without a real cap or run id', () => {
  const plain = councilEnterSource(1024).split('\n')[2]
  // The notebook kernel's own entry carries none of a worker's inputs.
  for (const key of ["'cap'", "'source'", "'runId'", "'scratch'", "'workspace'"]) assert.ok(!plain.includes(key), key)
  const worker = councilEnterSource(1024, { source: 'print(conn)\nx = "true"', runId: 'abc_1-2', capMb: 1024, workspace: '/workspace/s1' })
  const call = worker.split('\n')[2]
  assert.equal(worker.split('\n').length, 3, 'the source must not break the entry into more lines')
  assert.ok(call.includes(`'cap': ${1024 * 1024 * 1024}`))
  // A worker's ceiling is on whatever the instance's switch says.
  assert.ok(call.includes("'memory': True"))
  assert.ok(call.includes(`'source': ${JSON.stringify('print(conn)\nx = "true"')}`))
  assert.ok(call.includes(`'runId': "abc_1-2", 'scratch': "/colloq/scratch"`))
  assert.ok(call.includes(`'workspace': "/workspace/s1"`))
  assert.throws(() => councilEnterSource(1024, { runId: '../x' }), /REMOTE_RUN_ID/)
  assert.throws(() => councilEnterSource(1024, { capMb: 0 }), /memory cap/)
  assert.throws(() => councilEnterSource(1024, { capMb: Number.NaN }), /memory cap/)
})

const SHA = (n: number) => n.toString(16).padStart(64, '0')

test('an export\'s report is read as the contract would take it, or not at all', () => {
  const good = {
    ok: true, seq: 3, manifest: SHA(1), manifestBytes: 120, body: SHA(2), bodyBytes: 900,
    buffers: [{ sha256: SHA(3), bytes: 65536 }], written: [SHA(1), SHA(2), SHA(3)], reused: 0,
    carried: ['df'], left: [{ name: 'conn', why: 'connection' }, { name: 'odd', why: 'martian' }],
    imported: { np: 'numpy' }, local: [], cuda: false, mainRuns: 4, ms: 5,
  }
  const bundle = (row: unknown) => ({ status: 'ok', data: { 'text/plain': JSON.stringify(row) }, metadata: {} })
  const report = parseExportReport(bundle(good))!
  assert.equal(report.ok, true)
  assert.equal(report.bytes, 120 + 900 + 65536)
  // An unknown reason reads as "cannot be copied", never as nothing.
  assert.deepEqual(report.left, [{ name: 'conn', why: 'connection' }, { name: 'odd', why: 'unpicklable' }])
  // The intent's files: the stream first, then the buffers.
  assert.deepEqual(epochFiles(report), [{ sha256: SHA(2), bytes: 900 }, { sha256: SHA(3), bytes: 65536 }])

  // What the contract would refuse is no epoch at all.
  assert.equal(parseExportReport(bundle({ ...good, manifest: 'zz' })), null)
  assert.equal(parseExportReport(bundle({ ...good, buffers: [{ sha256: SHA(2), bytes: 1 }] })), null, 'the stream named twice')
  assert.equal(parseExportReport(bundle({ ...good, buffers: [{ sha256: SHA(3), bytes: 3 * 1024 ** 3 }] })), null, 'over COUNCIL_EPOCH_MB')
  assert.equal(parseExportReport(bundle({ ...good, buffers: Array.from({ length: COUNCIL_EPOCH_BUFFERS_MAX }, (_, i) => ({ sha256: SHA(10 + i), bytes: 1 })) })), null)
  assert.equal(parseExportReport({ status: 'error' }), null)
  // CUDA: no files, by construction.
  const cuda = parseExportReport(bundle({ ...good, manifest: null, body: null, manifestBytes: 0, bodyBytes: 0, buffers: [], written: [], cuda: true, left: [{ name: 'model', why: 'cuda' }] }))!
  assert.equal(cuda.cuda, true)
  assert.equal(cuda.manifest, null)
  assert.deepEqual(epochFiles(cuda), [])
  const failed = parseExportReport(bundle({ ok: false, seq: 3, error: 'OSError: disk full', ms: 1 }))!
  assert.equal(failed.ok, false)
  assert.equal(failed.error, 'OSError: disk full')

  const seed = parseSeedReport(bundle({ ok: true, seq: 3, manifest: SHA(1), loaded: 4, imported: 2, left: [], oomScoreAdj: 1000, threads: 1, mapped: 65536, ms: 9 }))!
  assert.equal(seed.oomScoreAdj, 1000)
  assert.equal(parseSeedReport(bundle({ ok: false, error: 'RuntimeError: x' }))!.error, 'RuntimeError: x')

  const exit = parseExitReport(bundle({
    threads: 0, processes: 0, more: 2, dirty: 10, grown: 5, recycle: false,
    files: [{ name: 'out.csv', bytes: 3, sha256: SHA(4) }, { name: '../evil', bytes: 1, sha256: SHA(5) }, { name: 'big.bin', bytes: 9 }],
  }))!
  // A name the contract could not carry never reaches a collect.
  assert.deepEqual(exit.files, [{ name: 'out.csv', bytes: 3, sha256: SHA(4) }, { name: 'big.bin', bytes: 9, sha256: null }])
  assert.equal(exit.recycle, false)
  assert.equal(exit.grown, 5)

  // A worker's refusal is a report with what it needs.
  const refused = parseCouncilReport(bundle({ ok: false, needs: [{ name: 'conn', why: 'connection' }], error: 'NotCarried: conn', copied: 0 }))!
  assert.deepEqual(refused.needs, [{ name: 'conn', why: 'connection' }])
})

test('left names are told in the room\'s words, once per epoch', () => {
  setLocaleResolver(() => 'ru')
  assert.equal(councilLeftWords('connection'), 'соединение с базой')
  assert.equal(councilLeftWords('nonsense'), councilLeftWords('unpicklable'))
  assert.equal(councilLeftLine([{ name: 'conn', why: 'connection' }, { name: 'batches', why: 'generator' }]),
    'Не переносится: conn (соединение с базой), batches (генератор).')
  assert.equal(councilLeftLine([]), null)
  setLocaleResolver(() => 'en')
  assert.equal(councilLeftWords('cuda'), 'data on the GPU')
  setLocaleResolver(() => 'ru')
})

/* ------------------------------------------------------- a real python3 */

const python = (() => {
  const probe = spawnSync('python3', ['-c', 'import sys; print(sys.version_info[0])'], { encoding: 'utf8' })
  return probe.status === 0 ? 'python3' : null
})()

/** Whether this `python3` imports all of these. */
function has(modules: string): boolean {
  return python !== null && spawnSync(python, ['-c', `import ${modules}`], { encoding: 'utf8' }).status === 0
}

const noPython = python ? false : 'no python3'
const noNumeric = has('numpy, pandas') ? false : 'no numpy and pandas in this python3'

test('the removal of an export nobody collects binds no name, takes that folder alone, and a folder already gone is no error — on a real python3', { skip: noPython }, () => {
  const run = exportDropExpression(7)
  assert.equal(run.code, `__import__('shutil').rmtree(${JSON.stringify(`${COUNCIL_EPOCH_DIR}/7`)}, ignore_errors=True)`)
  assert.deepEqual(run.userExpressions, {})
  assert.throws(() => exportDropExpression(0))
  // As the notebook's kernel runs it, the container's COUNCIL_EPOCH_DIR a folder of the test's.
  const root = mkdtempSync(path.join(tmpdir(), 'epoch-drop-'))
  try {
    for (const seq of ['7', '8']) {
      mkdirSync(path.join(root, seq, 'deep'), { recursive: true })
      writeFileSync(path.join(root, seq, 'deep', 'buffer'), 'x')
    }
    const code = run.code.replace(COUNCIL_EPOCH_DIR, root)
    const script = `before = set(globals())\n${code}\n${code}\nassert set(globals()) == before | {'before'}, sorted(set(globals()) ^ before)\n`
    const done = spawnSync(python!, ['-c', script], { encoding: 'utf8' })
    assert.equal(done.status, 0, done.stderr)
    assert.deepEqual(readdirSync(root), ['8'])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
const noCloudpickle = has('cloudpickle') || has('joblib.externals.cloudpickle') ? false : 'no cloudpickle in this python3'

const roots: string[] = []
after(() => {
  for (const root of roots) {
    // Read-only class folders get their permissions back, or they would outlive the run.
    spawnSync('chmod', ['-R', 'u+w', root])
    rmSync(root, { recursive: true, force: true })
  }
})

function scratch(): string {
  const root = mkdtempSync(path.join(tmpdir(), 'colloq-epoch-'))
  roots.push(root)
  return root
}

/** One python3 run of a script; its answer is the JSON line starting with @@. */
function run(script: string): any {
  const result = spawnSync(python!, ['-'], { input: script, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
  assert.equal(result.status, 0, `python3 crashed: ${result.stderr}`)
  const line = result.stdout.split('\n').find((one) => one.startsWith('@@'))
  assert.ok(line, `no answer: ${result.stdout} ${result.stderr}`)
  return JSON.parse(line.slice(2))
}

/**
 * A notebook's kernel: its cells, then one export after another, with cells
 * in between. `prep` runs once the hidden module is installed and before the
 * first export, with `m` the module: a test's stand-ins for what only Linux has.
 */
function notebook(setup: string, exports: Array<CouncilExportOptions & { before?: string }>, probe = 'None', prep = ''): { reports: CouncilExportReport[]; after: any } {
  const install = exportExpression(exports[0]).code.split('\n').slice(0, 2).join('\n')
  const script = [
    'import json, sys',
    "ns = {'__builtins__': __builtins__, '__name__': '__main__'}",
    `exec(compile(${JSON.stringify(setup)}, '<setup>', 'exec'), ns)`,
    ...(prep
      ? [
        `exec(compile(${JSON.stringify(install)}, '<install>', 'exec'), ns)`,
        `exec(compile(${JSON.stringify(prep)}, '<prep>', 'exec'), {'m': sys.modules[${JSON.stringify(COUNCIL_MODULE)}], 'ns': ns, 'sys': sys})`,
      ]
      : []),
    'reports = []',
    `for before, code in ${JSON.stringify(exports.map((one) => [one.before ?? '', exportExpression(one).code]))}:`,
    "    exec(compile(before, '<cell>', 'exec'), ns)",
    "    exec(compile(code, '<export>', 'exec'), ns)",
    `    reports.append(json.loads(repr(sys.modules[${JSON.stringify(COUNCIL_MODULE)}].exported)))`,
    `after = eval(compile(${JSON.stringify(probe)}, '<probe>', 'eval'), ns)`,
    "print('@@' + json.dumps({'reports': reports, 'after': after}, default=str))",
  ].join('\n')
  const out = run(script)
  return {
    reports: out.reports.map((raw: unknown) => {
      const report = parseExportReport(JSON.stringify(raw))
      assert.ok(report, `an export report the parser refused: ${JSON.stringify(raw).slice(0, 400)}`)
      return report
    }),
    after: out.after,
  }
}

/**
 * The collector's part (§9.2): every file an export wrote goes into one
 * content-addressed folder, and each must be named by its own sha256.
 */
function collect(from: string, cas: string): string[] {
  mkdirSync(cas, { recursive: true })
  const names = readdirSync(from)
  for (const name of names) {
    const bytes = readFileSync(path.join(from, name))
    assert.equal(createHash('sha256').update(bytes).digest('hex'), name, `${name} is not named by its content`)
    copyFileSync(path.join(from, name), path.join(cas, name))
  }
  return names.sort()
}

interface Attempt {
  source: string
  /** The worker's inputs beyond the source; by default a run id of its own, a scratch folder and 1024 MB, as the pool gives them. */
  entry?: CouncilIsolationSettings
  /** The copy budget, 512 MB unless said. */
  budget?: number
  /** A service line of the worker's own, run with no entry or exit around it. */
  bare?: boolean
}

interface Worker {
  report: CouncilExportReport
  dir: string
  attempts?: Attempt[]
  /** Python run before the seed, with `m` the hidden module: a test's patches. */
  prep?: string
  probe?: string
  workspace?: string
  threads?: number
}

/**
 * A pool worker: a fresh python3 that knows nothing of the notebook's
 * objects, seeds itself from the files, then runs each attempt through the
 * entry and the exit. What an attempt wants to tell the test it appends to
 * `sys.modules['_probe'].seen`, which no exit rolls back.
 */
function worker(w: Worker): { seed: any; results: Array<{ report: any; failure: string | null; exit: any }>; seen: any[]; after: any } {
  assert.ok(w.report.manifest && w.report.body, 'no epoch to load')
  // A council container's own folders: the class mount (empty unless the test brings one) and the scratch space.
  const area = scratch()
  const ws = w.workspace ?? path.join(area, 'ws')
  mkdirSync(ws, { recursive: true })
  const load = loadExpression({
    manifest: w.report.manifest, body: w.report.body, dir: w.dir, workspace: ws,
    ...(w.threads !== undefined ? { threads: w.threads } : {}),
  }).code.split('\n')
  const attempts = (w.attempts ?? []).map((one, n) => [
    one.bare ? '' : councilEnterSource(one.budget ?? 512 * 1024 * 1024, { source: one.source, runId: `a${n}`, capMb: 1024, scratchRoot: area, ...one.entry }),
    one.source,
  ])
  const module = JSON.stringify(COUNCIL_MODULE)
  const script = [
    'import json, sys, types',
    "probe = types.ModuleType('_probe')",
    'probe.seen = []',
    "sys.modules['_probe'] = probe",
    "ns = {'__builtins__': __builtins__, '__name__': '__main__'}",
    `exec(compile(${JSON.stringify(load.slice(0, 2).join('\n'))}, '<install>', 'exec'), ns)`,
    `m = sys.modules[${module}]`,
    `exec(compile(${JSON.stringify(w.prep ?? '')}, '<prep>', 'exec'), {'m': m, 'ns': ns, 'sys': sys})`,
    `exec(compile(${JSON.stringify(load[2])}, '<load>', 'exec'), ns)`,
    'seed = json.loads(repr(m.seeded))',
    'results = []',
    `for entry, attempt in ${JSON.stringify(attempts)}:`,
    '    if not entry:',
    "        exec(compile(attempt, '<service>', 'exec'), ns)",
    '        continue',
    "    exec(compile(entry, '<enter>', 'exec'), ns)",
    '    report = json.loads(repr(m.report))',
    '    failure = None',
    "    if report['ok']:",
    '        try:',
    "            exec(compile(attempt, '<attempt>', 'exec'), ns)",
    '        except BaseException as err:',
    "            failure = type(err).__name__ + ': ' + str(err)",
    `    exec(compile(${JSON.stringify(COUNCIL_EXIT_SOURCE)}, '<exit>', 'exec'), ns)`,
    '    raw = m.leftovers',
    "    results.append({'report': report, 'failure': failure, 'exit': json.loads(repr(raw)) if raw is not None else None})",
    `after = eval(compile(${JSON.stringify(w.probe ?? 'None')}, '<probe>', 'eval'), ns)`,
    "print('@@' + json.dumps({'seed': seed, 'results': results, 'seen': probe.seen, 'after': after}, default=str))",
  ].join('\n')
  return run(script)
}

/** Export once and gather the files as a collector would. */
function epochOf(setup: string, options: Partial<CouncilExportOptions> = {}): { report: CouncilExportReport; cas: string; root: string } {
  const root = scratch()
  const cas = path.join(root, 'cas')
  const { reports } = notebook(setup, [{ seq: 1, mainRuns: 1, dir: path.join(root, 'e1'), ...options }])
  const report = reports[0]
  assert.equal(report.ok, true, `the export failed: ${report.error}`)
  if (report.manifest) collect(path.join(root, 'e1'), cas)
  return { report, cas, root }
}

test('plain data and notebook functions travel in one stream: one memo, functions on the worker\'s own names', { skip: noPython }, () => {
  const { report, cas } = epochOf([
    'data = [3, None, 1, None, 7]',
    'a = [1, 2]',
    'b = a',
    'k = 10',
    'def count():',
    '    return len(data) * k',
    'def scaled(x, factor=2):',
    '    return x * factor * k',
    "nested = {'list': a, 'fn': count}",
    'twice = lambda: count() * 2',
    'def typed(x: int) -> int:',
    '    return x + k',
    'def make(n):',
    '    def add(x):',
    '        return x + n + k',
    '    return add',
    'add5 = make(5)',
    'def fact(n):',
    '    return 1 if n <= 1 else n * fact(n - 1)',
  ].join('\n'))
  assert.deepEqual(report.carried, ['a', 'add5', 'b', 'count', 'data', 'fact', 'k', 'make', 'nested', 'scaled', 'twice', 'typed'])
  assert.deepEqual(report.left, [])
  assert.equal(report.mainRuns, 1)
  const out = worker({
    report, dir: cas,
    attempts: [
      {
        // The line from the seminar of 19 Sep 2026: the attempt rebinds a name a notebook function reads.
        source: [
          'import sys',
          'data = [x for x in data if x is not None]',
          "sys.modules['_probe'].seen.append([count(), nested['fn'](), twice(), scaled(1), a is b, nested['list'] is a])",
          'k = 0',
          // A closure keeps its own cell and reads the module's names: the attempt's `k` here.
          "sys.modules['_probe'].seen.append([add5(1), make(2)(1), fact(5), typed(1), sorted(typed.__annotations__)])",
        ].join('\n'),
      },
      { source: "import sys\nsys.modules['_probe'].seen.append([count(), len(data), add5(1)])" },
    ],
  })
  assert.equal(out.seed.ok, true, out.seed.error)
  assert.equal(out.seed.loaded, 12)
  assert.equal(out.results[0].failure, null, out.results[0].failure ?? undefined)
  // A function anywhere (a name, a dict, a lambda's body) reads the attempt's `data`, as in the shared kernel.
  assert.deepEqual(out.seen[0], [30, 30, 60, 20, true, true])
  assert.deepEqual(out.seen[1], [6, 3, 120, 1, ['return', 'x']])
  // And the next attempt starts from the epoch again.
  assert.deepEqual(out.seen[2], [50, 5, 16])
})

test('notebook classes and their instances travel by value, their methods on the worker\'s names', { skip: noPython }, () => {
  const setup = [
    'k = 2',
    'class Scaler:',
    '    def __init__(self, m):',
    '        self.m = m',
    '    def apply(self, x):',
    '        return x * self.m * k',
    'sc = Scaler(3)',
  ].join('\n')
  const { report, cas } = epochOf(setup)
  if (noCloudpickle) {
    // Without cloudpickle a notebook class has no way to travel, and neither do its instances.
    assert.deepEqual(report.left, [{ name: 'Scaler', why: 'unpicklable' }, { name: 'sc', why: 'unpicklable' }])
    return
  }
  assert.deepEqual(report.left, [])
  const out = worker({
    report, dir: cas,
    attempts: [{ source: "import sys\nk = 5\nsys.modules['_probe'].seen.append([sc.apply(1), Scaler(1).apply(1), type(sc) is Scaler])" }],
  })
  assert.equal(out.results[0].failure, null, out.results[0].failure ?? undefined)
  assert.deepEqual(out.seen[0], [15, 5, true])
})

test('what cannot travel stays behind with its reason, and the worker holds a sentinel that refuses in words', { skip: noPython }, () => {
  const root = scratch()
  writeFileSync(path.join(root, 'notes.txt'), 'hello')
  const { report, cas } = epochOf([
    'import socket, threading',
    `fh = open(${JSON.stringify(path.join(root, 'notes.txt'))})`,
    'sock = socket.socket()',
    'gen = (i for i in range(3))',
    'lock = threading.Lock()',
    'worker_thread = threading.Thread(target=print)',
    'big = list(range(200000))',
    'small = [1, 2]',
  ].join('\n'), { budgetBytes: 64 * 1024 })
  assert.deepEqual(report.carried, ['small'])
  assert.deepEqual(report.left, [
    { name: 'big', why: 'budget' },
    { name: 'fh', why: 'file' },
    { name: 'gen', why: 'generator' },
    { name: 'lock', why: 'lock' },
    { name: 'sock', why: 'socket' },
    { name: 'worker_thread', why: 'thread' },
  ])
  assert.deepEqual(report.imported, { socket: 'socket', threading: 'threading' })
  setLocaleResolver(() => 'ru')
  const out = worker({
    report, dir: cas,
    attempts: [
      // A direct read is refused by the entry, before anything is copied or held.
      { source: 'print(fh.read())' },
      // The attempt binds `gen` itself before reading it: nothing of the epoch's is needed.
      { source: "import sys\ngen = iter([5])\nsys.modules['_probe'].seen.append(next(gen))" },
      // An indirect read hits the sentinel, which says why.
      { source: "globals()['sock'].close()" },
      { source: "import sys\nfor b in globals()['gen']:\n    pass" },
    ],
  })
  assert.equal(out.seed.ok, true, out.seed.error)
  assert.deepEqual(out.seed.left.map((row: { name: string }) => row.name), ['big', 'fh', 'gen', 'lock', 'sock', 'worker_thread'])
  const refused = parseCouncilReport(JSON.stringify(out.results[0].report))!
  assert.equal(refused.ok, false)
  assert.deepEqual(refused.needs, [{ name: 'fh', why: 'file' }])
  // A refused entry holds nothing: the exit finds nothing to return.
  assert.equal(out.results[0].exit, null)
  assert.equal(out.results[1].failure, null, out.results[1].failure ?? undefined)
  assert.deepEqual(out.seen, [5])
  assert.ok(out.results[2].failure?.startsWith(`${COUNCIL_NOT_CARRIED}: `), out.results[2].failure ?? '')
  assert.ok(out.results[2].failure?.includes('sock'))
  assert.ok(out.results[2].failure?.includes(councilLeftWords('socket')), out.results[2].failure ?? '')
  assert.ok(out.results[3].failure?.includes(councilLeftWords('generator')), out.results[3].failure ?? '')
})

test('an object that is not data has a byte cap of its own; data has only the epoch\'s', { skip: noPython }, () => {
  const { report } = epochOf([
    'import types',
    'rows = list(range(50000))',
    'box = types.SimpleNamespace(rows=list(range(50000)))',
    'def heavy(x, table=list(range(50000))):',
    '    return table[x]',
  ].join('\n'), { nameBytes: 64 * 1024 })
  assert.deepEqual(report.carried, ['rows'])
  assert.deepEqual(report.imported, { types: 'types' })
  assert.deepEqual(report.left, [{ name: 'box', why: 'budget' }, { name: 'heavy', why: 'budget' }])
})

test('the check of left names: what an attempt reads before it binds, in every scope', { skip: noPython }, () => {
  const cases: Array<[string, string[]]> = [
    ['conn.execute("x")', ['conn']],
    ['conn = make()\nconn.execute()', []],
    // Read before bound, on one line: the epoch's `conn` is what `.cursor()` is called on.
    ['conn = conn.cursor()', ['conn']],
    ['conn += 1', ['conn']],
    ['conn.x = 1', ['conn']],
    // A comprehension's own names are its own, but its first iterable is read where it stands.
    ['x = [conn for conn in range(3)]', []],
    ['x = [c for c in conn]', ['conn']],
    ['x = {k: conn for k in range(3)}', ['conn']],
    // A function body runs later: what it reads counts unless the attempt binds it somewhere.
    ['def f():\n    return conn.q()\nf()', ['conn']],
    ['def f():\n    return conn.q()\nconn = 1\nf()', []],
    ['def f():\n    global conn\n    conn = 1\nf()\nprint(conn)', ['conn']],
    ['class A:\n    conn = 1\n    def m(self):\n        return conn', ['conn']],
    ['f = lambda: gen\nconn = 2', ['gen']],
    ['with open("x") as conn:\n    conn.read()', []],
    ['for gen in range(3):\n    pass\nprint(gen)', []],
    ['import conn\nconn.x', []],
    ['try:\n    pass\nexcept Exception as conn:\n    print(conn)', []],
    ['del conn', []],
    ['print(gen, conn)', ['conn', 'gen']],
    // IPython runs a top-level await.
    ['rows = await conn.fetch()', ['conn']],
    // What no static reading can see is the sentinel's.
    ["globals()['conn']", []],
    ['!echo {conn}\nprint(1)', []],
    ['this is not python', []],
    // Magics that run Python in the attempt's own namespace are read like the rest of it.
    ['%timeit conn.q()\nprint(1)', ['conn']],
    ['%%time\nrows = conn.execute(1)', ['conn']],
    ['\n%%timeit -n1 -r1\nfor b in gen:\n    pass', ['gen']],
    ['%time rows = conn.execute()', ['conn']],
    ['%timeit -n 10 -r 3 conn.q()', ['conn']],
    ['%%capture out\nprint(conn)', ['conn']],
    ['conn = 1\n%time conn.q()', []],
    ['%%writefile x.py\nprint(conn)', []],
  ]
  const install = councilEnterSource(1024).split('\n').slice(0, 2).join('\n')
  const script = [
    'import json, sys',
    `exec(compile(${JSON.stringify(install)}, '<install>', 'exec'), {})`,
    `m = sys.modules[${JSON.stringify(COUNCIL_MODULE)}]`,
    "left = {'conn': 'connection', 'gen': 'generator'}",
    `print('@@' + json.dumps([m._colloq_needs(source, left) for source in ${JSON.stringify(cases.map(([source]) => source))}]))`,
  ].join('\n')
  const found = run(script) as string[][]
  cases.forEach(([source, wanted], index) => assert.deepEqual(found[index], wanted, source))
})

test('numeric buffers travel out of band and are mapped copy-on-write: a fresh mapping per attempt, the file untouched',
  { skip: noPython || noNumeric }, () => {
    const { report, cas } = epochOf([
      'import numpy as np, pandas as pd',
      "arr = np.arange(100000, dtype='float64')",
      "df = pd.DataFrame({'a': np.arange(50000, dtype='float64'), 's': ['x'] * 50000})",
      'small = np.arange(10)',
      'view = arr',
    ].join('\n'))
    // arr (800 KB) and df's numeric column (400 KB) have files of their own; the small array stays in the stream.
    assert.deepEqual(report.buffers.map((file) => file.bytes).sort((x, y) => x - y), [400000, 800000])
    assert.equal(report.written.length, 4)
    const arrFile = report.buffers.find((file) => file.bytes === 800000)!.sha256
    const before = readFileSync(path.join(cas, arrFile))
    const attempt = [
      'import sys',
      "sys.modules['_probe'].seen.append(type(arr.base).__name__)",
      'arr[0] = 999',
      'df.iloc[0, 0] = -1',
      "sys.modules['_probe'].seen.append([float(arr[0]), view is arr])",
    ].join('\n')
    const a = worker({
      report, dir: cas,
      attempts: [{ source: attempt }, { source: "import sys\nsys.modules['_probe'].seen.append([float(arr[0]), float(df.iloc[0, 0])])" }],
      // The worker itself writes into its own mapping: a private page, never the file.
      probe: '[arr.__setitem__(1, 555.0), float(arr[1])][1]',
    })
    assert.equal(a.results[0].failure, null, a.results[0].failure ?? undefined)
    // The attempt's array is a mapping of its own, not a copy: O(1) whatever its size.
    assert.equal(a.seen[0], 'mmap')
    assert.deepEqual(a.seen[1], [999, true])
    assert.deepEqual(a.seen[2], [0, 0], 'the attempt\'s writes reached the next attempt')
    assert.equal(a.after, 555)
    assert.ok(readFileSync(path.join(cas, arrFile)).equals(before), 'a write in a worker reached the epoch\'s file')
    // Another worker maps the same file and sees the epoch, not its neighbour's writes.
    const b = worker({ report, dir: cas, attempts: [{ source: "import sys\nsys.modules['_probe'].seen.append([float(arr[1]), int(df.shape[0]), df['s'].iloc[0]])" }] })
    assert.deepEqual(b.seen[0], [1, 50000, 'x'])
  })

test('an unchanged refreeze rewrites nothing; a changed buffer is written again, and full writes them all',
  { skip: noPython || noNumeric }, () => {
    const root = scratch()
    const dir = (n: number) => path.join(root, `e${n}`)
    const { reports } = notebook([
      'import numpy as np',
      "arr = np.arange(100000, dtype='float64')",
      "other = np.ones(30000, dtype='float64')",
    ].join('\n'), [
      { seq: 1, mainRuns: 1, dir: dir(1) },
      { seq: 2, mainRuns: 1, dir: dir(2) },
      { seq: 3, mainRuns: 2, dir: dir(3), before: 'arr[0] = 5.0' },
      { seq: 4, mainRuns: 2, dir: dir(4), full: true },
    ])
    const [first, same, changed, full] = reports
    assert.equal(first.reused, 0)
    assert.equal(first.buffers.length, 2)
    assert.deepEqual(same.buffers, first.buffers, 'an unchanged buffer changed its name')
    assert.equal(same.reused, 2)
    // Only the epoch's own two files: the buffers are with the collector already.
    assert.deepEqual(same.written, [same.manifest, same.body])
    assert.deepEqual(readdirSync(dir(2)).sort(), [same.manifest, same.body].sort())
    const moved = changed.buffers.find((file) => !first.buffers.some((old) => old.sha256 === file.sha256))!
    assert.ok(moved, 'the changed array kept its old name')
    assert.equal(changed.reused, 1)
    assert.deepEqual(changed.written, [changed.manifest, changed.body, moved.sha256])
    assert.equal(full.reused, 0)
    assert.equal(full.written.length, 4)
    // And an epoch from the refreeze loads from what the collector holds by now.
    const cas = path.join(root, 'cas')
    for (const n of [1, 2, 3]) collect(dir(n), cas)
    const out = worker({ report: changed, dir: cas, probe: '[float(arr[0]), float(arr[1]), float(other[0])]' })
    assert.equal(out.seed.ok, true, out.seed.error)
    assert.deepEqual(out.after, [5, 1, 1])
  })

/** A module of the class folder whose objects travel out of band, as numpy's do, for a python3 without numpy. */
const BLOBS = [
  'import pickle',
  'class Blob(object):',
  '    def __init__(self, size, fill):',
  '        self.data = bytearray([fill]) * size',
  '    def __reduce_ex__(self, protocol):',
  '        return (make, (pickle.PickleBuffer(self.data),))',
  'def make(buffer):',
  '    blob = Blob.__new__(Blob)',
  '    blob.data = bytearray(buffer)',
  '    return blob',
].join('\n')

test('a hundred buffers seed a worker whose descriptors are few: the seed makes room for its mappings', { skip: noPython }, () => {
  const root = scratch()
  const lib = path.join(root, 'lib')
  mkdirSync(lib)
  writeFileSync(path.join(lib, 'blobs.py'), BLOBS)
  const { report, cas } = epochOf([
    'import sys',
    `sys.path.insert(0, ${JSON.stringify(lib)})`,
    'import blobs',
    'items = [blobs.Blob(65536, i) for i in range(100)]',
  ].join('\n'))
  assert.equal(report.buffers.length, 100)
  const out = worker({
    report, dir: cas,
    // A container's soft limit, made small: before Python 3.13 every mapping keeps a descriptor.
    prep: 'import resource\nresource.setrlimit(resource.RLIMIT_NOFILE, (64, resource.getrlimit(resource.RLIMIT_NOFILE)[1]))',
    probe: '[len(items), items[99].data[0], len(items[99].data)]',
  })
  assert.equal(out.seed.ok, true, out.seed.error)
  assert.deepEqual(out.after, [100, 99, 65536])
})

test('an export after an attempt whose exit never came freezes the class\'s data, not the attempt\'s', { skip: noPython }, () => {
  const root = scratch()
  const enter = councilEnterSource(512 * 1024 * 1024)
  // A key that is no name (legal Python) neither stops the entry nor the export.
  const { reports, after: kernel } = notebook('lst = [1, 2]\nglobals()[1] = 2', [{
    seq: 1, mainRuns: 1, dir: path.join(root, 'e1'),
    // The entry went in and the attempt ran; the server restarted before its exit.
    before: [
      `exec(compile(${JSON.stringify(enter)}, '<enter>', 'exec'), globals())`,
      `assert __import__('json').loads(repr(__import__('sys').modules[${JSON.stringify(COUNCIL_MODULE)}].report))['ok']`,
      'lst.append(9)',
    ].join('\n'),
  }], 'lst')
  assert.equal(reports[0].ok, true, reports[0].error ?? undefined)
  assert.deepEqual(kernel, [1, 2], 'the export left the attempt\'s copies bound')
  const cas = path.join(root, 'cas')
  collect(path.join(root, 'e1'), cas)
  assert.deepEqual(worker({ report: reports[0], dir: cas, probe: 'lst' }).after, [1, 2])
})

test('identical attempts print identical numbers in every worker, and the numbers the shared kernel would', { skip: noPython }, () => {
  const numeric = !noNumeric
  // Bound by name too: `randint` is a method of the process's own generator, never a copy of it.
  const setup = ['import random', 'random.seed(7)', '_ = [random.random() for _ in range(3)]', 'from random import randint, choice, seed as rseed']
  if (numeric) setup.push('import numpy as np', 'np.random.seed(11)', 'rng = np.random.default_rng(5)', 'from numpy.random import rand')
  const draw = numeric
    ? '[random.random(), randint(1, 10**9), choice(range(10**9)), float(np.random.rand()), float(rand()), float(rng.random())]'
    : '[random.random(), randint(1, 10**9), choice(range(10**9))]'
  const root = scratch()
  const { reports, after: expected } = notebook(setup.join('\n'), [{ seq: 1, mainRuns: 1, dir: path.join(root, 'e1') }], draw)
  const cas = path.join(root, 'cas')
  collect(path.join(root, 'e1'), cas)
  const attempt = { source: `import sys\nsys.modules['_probe'].seen.append(${draw})` }
  // Something of the worker's own draws between the seed and the first attempt: the attempt starts from the epoch anyway.
  const draws = { source: numeric ? 'import random\nrandom.random()\nnp.random.rand()' : 'import random\nrandom.random()', bare: true }
  // The seed bound by name seeds the process's own generator, as it does in the shared kernel.
  const reseeded = { source: "import sys\nrseed(42)\nsys.modules['_probe'].seen.append(random.random())" }
  const one = worker({ report: reports[0], dir: cas, attempts: [draws, attempt, attempt, reseeded, attempt] })
  const two = worker({ report: reports[0], dir: cas, attempts: [attempt] })
  for (const result of [...one.results, ...two.results]) {
    assert.equal(result.report.ok, true, JSON.stringify(result.report))
    assert.equal(result.failure, null, result.failure ?? '')
  }
  assert.deepEqual(one.seen[0], expected, 'a worker drew other numbers than the notebook\'s kernel would')
  assert.deepEqual(one.seen[1], expected, 'the second attempt in a worker drew on from the first')
  assert.equal(one.seen[2], 0.6394267984578837, 'seed(42) bound by name seeded something else')
  assert.deepEqual(one.seen[3], expected, 'an attempt\'s seed reached the next attempt')
  assert.deepEqual(two.seen[0], expected, 'two workers drew different numbers')
})

test('process state travels: warnings, decimal, the recursion limit, sys.path, the folder and the environment, not the container\'s own',
  { skip: noPython }, () => {
    const root = scratch()
    const ws = path.join(root, 'ws')
    mkdirSync(path.join(ws, 'sub'), { recursive: true })
    mkdirSync(path.join(ws, 'lib'))
    writeFileSync(path.join(ws, 'lib', 'helpers.py'), 'def double(x):\n    return 2 * x\n')
    const setup = [
      'import warnings, decimal, sys, os',
      "warnings.filterwarnings('ignore', message='colloq-test')",
      'decimal.getcontext().prec = 7',
      'sys.setrecursionlimit(4321)',
      `sys.path.append(${JSON.stringify(path.join(ws, 'lib'))})`,
      'import helpers',
      'import os.path as osp',
      'from collections import abc',
      "os.environ['TEACHER_SETTING'] = 'on'",
      "os.environ['JUPYTER_TOKEN'] = 'the-class-container-token'",
      `os.chdir(${JSON.stringify(path.join(ws, 'sub'))})`,
    ]
    if (!noNumeric) setup.push('import pandas as pd', "pd.set_option('display.max_rows', 7)")
    const { report, cas } = epochOf(setup.join('\n'), { workspace: ws })
    assert.deepEqual(report.imported, {
      abc: 'collections.abc', decimal: 'decimal', helpers: 'helpers', os: 'os', osp: path.sep === '/' ? 'posixpath' : 'ntpath', sys: 'sys', warnings: 'warnings',
      ...(noNumeric ? {} : { pd: 'pandas' }),
    })
    // A module from the class folder is named: a worker imports the synced copy.
    assert.deepEqual(report.local, ['helpers'])
    const probe = "[__import__('decimal').getcontext().prec, __import__('sys').getrecursionlimit(), __import__('os').path.realpath(__import__('os').getcwd()), "
      + "__import__('os').environ.get('TEACHER_SETTING'), __import__('os').environ.get('JUPYTER_TOKEN'), helpers.double(2), osp.join('a', 'b'), abc.Mapping.__name__, "
      + "any(f[1] is not None and f[1].pattern == 'colloq-test' for f in __import__('warnings').filters)"
      + (noNumeric ? ']' : ", __import__('pandas').get_option('display.max_rows')]")
    const out = worker({ report, dir: cas, workspace: ws, probe, prep: "import os\nos.environ.pop('JUPYTER_TOKEN', None)" })
    assert.equal(out.seed.ok, true, out.seed.error)
    const [prec, limit, cwd, setting, token, doubled, joined, mapping, filtered, rows] = out.after
    assert.equal(prec, 7)
    assert.equal(limit, 4321)
    assert.equal(cwd, path.join(realpathSync(ws), 'sub'))
    assert.equal(setting, 'on')
    assert.notEqual(token, 'the-class-container-token', 'an attempt could read the class container\'s Jupyter token')
    assert.equal(doubled, 4)
    assert.equal(joined, path.join('a', 'b'))
    assert.equal(mapping, 'Mapping')
    assert.equal(filtered, true)
    if (!noNumeric) assert.equal(rows, 7)
  })

test('an attempt works in a scratch folder: the class tree as links, writes local, class files read-only, new files listed',
  { skip: noPython }, () => {
    const root = scratch()
    const ws = path.join(root, 'ws')
    const area = path.join(root, 'scratch')
    mkdirSync(path.join(ws, 'sub'), { recursive: true })
    mkdirSync(area)
    writeFileSync(path.join(ws, 'data.csv'), 'a,b\n1,2\n')
    writeFileSync(path.join(ws, 'sub', 'x.txt'), 'x')
    // The class mount is read-only on a machine: here, the files' own modes say so.
    chmodSync(path.join(ws, 'data.csv'), 0o444)
    chmodSync(path.join(ws, 'sub', 'x.txt'), 0o444)
    const { report, cas } = epochOf('k = 1', { workspace: ws })
    const entry = (runId: string, extra: Partial<CouncilIsolationSettings> = {}): CouncilIsolationSettings => ({ runId, scratchRoot: area, workspace: ws, capMb: 1024, ...extra })
    const out = worker({
      report, dir: cas, workspace: ws,
      attempts: [
        {
          source: [
            'import sys, os',
            "seen = sys.modules['_probe'].seen",
            "seen.append(open('data.csv').read())",
            "seen.append(open('sub/x.txt').read())",
            "open('out.csv', 'w').write('1,2')",
            "open('sub/y.txt', 'w').write('yy')",
            'try:',
            "    open('data.csv', 'w').write('spoiled')",
            "    seen.append('wrote a class file')",
            'except OSError:',
            "    seen.append('refused')",
            "seen.append(os.path.basename(os.getcwd()))",
          ].join('\n'),
          entry: entry('run1'),
        },
        // Past the skeleton's cap, the top level only: folders as links too.
        { source: "import sys, os\nsys.modules['_probe'].seen.append([os.path.islink('sub'), open('sub/x.txt').read()])", entry: entry('run2', { skeletonEntries: 2 }) },
      ],
    })
    const [first, second] = out.results
    assert.equal(first.report.ok, true, first.report.error)
    assert.equal(first.failure, null, first.failure ?? undefined)
    assert.equal(first.report.scratch, path.join(area, 'run1'))
    assert.deepEqual(out.seen.slice(0, 4), ['a,b\n1,2\n', 'x', 'refused', 'run1'])
    assert.deepEqual(out.seen[4], [true, 'x'])
    const exit = parseExitReport(JSON.stringify(first.exit))!
    const sha = (text: string) => createHash('sha256').update(text).digest('hex')
    assert.deepEqual(exit.files, [{ name: 'out.csv', bytes: 3, sha256: sha('1,2') }, { name: 'sub/y.txt', bytes: 2, sha256: sha('yy') }])
    assert.equal(exit.more, 0)
    assert.equal(second.report.ok, true, second.report.error)
    // The class folder got nothing, and its files are as they were.
    assert.deepEqual(readdirSync(ws).sort(), ['data.csv', 'sub'])
    assert.equal(readFileSync(path.join(ws, 'data.csv'), 'utf8'), 'a,b\n1,2\n')
    assert.ok(lstatSync(path.join(area, 'run1', 'data.csv')).isSymbolicLink())
    assert.ok(lstatSync(path.join(area, 'run1', 'sub')).isDirectory())
    assert.ok(lstatSync(path.join(area, 'run2', 'sub')).isSymbolicLink())
    // The worker is back in its own folder after the attempt.
    assert.ok(existsSync(path.join(area, 'run1', 'out.csv')))
  })

test('a scratch folder that is a link is refused, and the attempt does not run', { skip: noPython }, () => {
  const root = scratch()
  const area = path.join(root, 'scratch')
  mkdirSync(area)
  mkdirSync(path.join(root, 'elsewhere'))
  symlinkSync(path.join(root, 'elsewhere'), path.join(area, 'run1'))
  const { report, cas } = epochOf('k = 1')
  const out = worker({
    report, dir: cas,
    attempts: [{ source: "open('out.csv', 'w').write('x')", entry: { runId: 'run1', scratchRoot: area } }],
  })
  assert.equal(out.results[0].report.ok, false)
  assert.match(out.results[0].report.error, /not a folder/)
  assert.deepEqual(readdirSync(path.join(root, 'elsewhere')), [])
})

test('a worker raises its OOM score and limits its threads at seed', { skip: noPython }, () => {
  const root = scratch()
  const score = path.join(root, 'oom_score_adj')
  writeFileSync(score, '0')
  const { report, cas } = epochOf('k = 1')
  const pools = has('threadpoolctl')
  const out = worker({
    report, dir: cas, prep: `m._OOM = ${JSON.stringify(score)}`, threads: 1,
    probe: pools ? "sorted(set(pool['num_threads'] for pool in __import__('threadpoolctl').threadpool_info()))" : 'None',
  })
  assert.equal(out.seed.ok, true, out.seed.error)
  assert.equal(out.seed.oomScoreAdj, 1000)
  assert.equal(readFileSync(score, 'utf8'), '1000')
  if (pools) {
    assert.equal(out.seed.threads, 1)
    // Every thread pool loaded by then: about one CPU per worker (§9.7).
    assert.ok(out.after.every((count: number) => count === 1), JSON.stringify(out.after))
  }
})

test('a seed refuses a stream that is not the one home registered, and files that are not the epoch\'s', { skip: noPython }, () => {
  const { report, cas } = epochOf('k = 1\nlst = [1, 2, 3]')
  const forged = { ...report, body: SHA(9) }
  const out = worker({ report: forged, dir: cas })
  assert.equal(out.seed.ok, false)
  assert.match(out.seed.error, /not the one the server registered/)
  // A manifest whose bytes do not match its name is not read further.
  const bad = path.join(cas, report.manifest!)
  chmodSync(bad, 0o644)
  writeFileSync(bad, readFileSync(bad, 'utf8').replace('"format":1', '"format":1 '))
  const again = worker({ report, dir: cas })
  assert.equal(again.seed.ok, false)
  assert.match(again.seed.error, /does not match its hash/)
})

test('data on the GPU stays behind and keeps the whole council shared, with nothing written', { skip: noPython }, () => {
  // A stand-in torch: the check is the export's own, and needs no card to be proven.
  const root = scratch()
  const { reports } = notebook([
    'import sys, types',
    "torch = types.ModuleType('torch')",
    'class Tensor(object):',
    '    def __init__(self, kind):',
    '        self.device = types.SimpleNamespace(type=kind)',
    'torch.Tensor = Tensor',
    "sys.modules['torch'] = torch",
    "weights = [Tensor('cuda')]",
    "cpu = Tensor('cpu')",
    'plain = [1, 2]',
  ].join('\n'), [{ seq: 1, mainRuns: 1, dir: path.join(root, 'e1') }])
  const report = reports[0]
  assert.equal(report.ok, true, report.error ?? undefined)
  assert.equal(report.cuda, true)
  assert.ok(report.left.some((row) => row.name === 'weights' && row.why === 'cuda'), JSON.stringify(report.left))
  assert.ok(!report.left.some((row) => row.name === 'cpu' && row.why === 'cuda'))
  assert.equal(report.manifest, null)
  assert.deepEqual(report.written, [])
  assert.ok(!existsSync(path.join(root, 'e1')), 'an epoch the pool can never use was written anyway')
})

test('a real CUDA tensor stays behind', { skip: has('torch') && spawnSync('python3', ['-c', 'import torch, sys; sys.exit(0 if torch.cuda.is_available() else 1)']).status === 0 ? false : 'no torch with CUDA' }, () => {
  const { report } = epochOf('import torch\nt = torch.ones(3).cuda()\nc = torch.ones(3)')
  assert.equal(report.cuda, true)
  assert.deepEqual(report.left, [{ name: 't', why: 'cuda' }])
})

test('pandas, sklearn: a frame with its index and text, a fitted model that predicts the same on a worker',
  { skip: noPython || (has('numpy, pandas, sklearn') ? false : 'no numpy, pandas and sklearn in this python3') }, () => {
    const { report, cas } = epochOf([
      'import numpy as np, pandas as pd',
      'from sklearn.linear_model import LogisticRegression',
      "X = pd.DataFrame({'a': np.linspace(0, 1, 200), 'b': np.linspace(1, 0, 200)}, index=[f'r{i}' for i in range(200)])",
      'y = (X.a > 0.5).astype(int)',
      'model = LogisticRegression().fit(X, y)',
      'expected = model.predict_proba(X)[:, 1].round(6).tolist()',
      "df = pd.DataFrame({'v': [1.0, None, 3.0], 't': ['p', 'q', None]})",
      'def size():',
      '    return len(df)',
    ].join('\n'))
    assert.deepEqual(report.left, [])
    const out = worker({
      report, dir: cas,
      attempts: [{
        source: [
          'import sys',
          "seen = sys.modules['_probe'].seen",
          'seen.append(model.predict_proba(X)[:, 1].round(6).tolist() == expected)',
          "seen.append([X.index[0], X.index[-1]])",
          // The seminar's line, on a real frame: the notebook function sees the attempt's df.
          'df = df.dropna()',
          'seen.append(size())',
        ].join('\n'),
      }],
      probe: 'size()',
    })
    assert.equal(out.results[0].failure, null, out.results[0].failure ?? undefined)
    assert.deepEqual(out.seen, [true, ['r0', 'r199'], 1])
    assert.equal(out.after, 3)
  })

test('torch on the CPU: a model and its optimizer stay one graph, and a training step stays in its attempt',
  { skip: noPython || (has('torch') ? false : 'no torch in this python3') }, () => {
    const { report, cas } = epochOf([
      'import torch',
      'torch.manual_seed(0)',
      'model = torch.nn.Linear(4, 2)',
      'opt = torch.optim.SGD(model.parameters(), lr=1.0)',
      'was = float(model.weight[0][0])',
    ].join('\n'))
    assert.deepEqual(report.left, [])
    const out = worker({
      report, dir: cas,
      attempts: [{
        source: [
          'import sys, torch',
          "seen = sys.modules['_probe'].seen",
          "seen.append(opt.param_groups[0]['params'][0] is model.weight)",
          'loss = model(torch.ones(1, 4)).sum()',
          'opt.zero_grad()',
          'loss.backward()',
          'opt.step()',
          'seen.append(float(model.weight[0][0]) != was)',
        ].join('\n'),
      }],
      probe: 'float(model.weight[0][0]) == was',
    })
    assert.equal(out.results[0].failure, null, out.results[0].failure ?? undefined)
    assert.deepEqual(out.seen, [true, true])
    assert.equal(out.after, true, 'the attempt\'s training step changed the worker\'s model')
  })

/* --------------------------------------- memory, ownership and failures */

const MiB = 1024 * 1024

test('a view numpy would copy in band travels out of band: as a view of its owner, or as a copy of its own',
  { skip: noPython || noNumeric }, () => {
    const root = scratch()
    const npy = path.join(root, 'big.npy')
    const { reports } = notebook([
      'import numpy as np, pandas as pd',
      `np.save(${JSON.stringify(npy)}, np.arange(100000.0))`,
      // The usual splits: features and labels, train and test of a frame of one block, a file mapped read-only.
      'data = np.ones((4000, 21))',
      'X = data[:, :-1]',
      'y = data[:, -1]',
      // Contiguous, so numpy alone would send it as a second copy of data's first rows.
      'rows = data[:3000]',
      "frame = pd.DataFrame(np.arange(200000.0).reshape(25000, 8), columns=list('abcdefgh'))",
      'train = frame.iloc[:20000]',
      'test = frame.iloc[20000:]',
      `M = np.load(${JSON.stringify(npy)}, mmap_mode='r')`,
    ].join('\n'), [
      { seq: 1, mainRuns: 1, dir: path.join(root, 'e1') },
      { seq: 2, mainRuns: 2, dir: path.join(root, 'e2'), before: 'k = 1' },
    ])
    const [first, again] = reports
    assert.equal(first.ok, true, first.error ?? undefined)
    assert.deepEqual(first.left, [])
    // Nothing big in the stream: the owners travel once each, out of band (data, the frame's block, the mapped file).
    assert.ok(first.bodyBytes < 64 * 1024, `the stream holds ${first.bodyBytes} bytes`)
    assert.deepEqual(first.buffers.map((file) => file.bytes).sort((a, b) => a - b), [4000 * 21 * 8, 800128, 200000 * 8])
    // An unrelated cell later, the same files: nothing to ship again.
    assert.deepEqual(again.buffers, first.buffers)
    const cas = path.join(root, 'cas')
    collect(path.join(root, 'e1'), cas)
    const out = worker({
      report: first, dir: cas,
      attempts: [
        { source: "import sys\nX[0, 0] = 7.0\nsys.modules['_probe'].seen.append(float(X[0, 0]))" },
        { source: "import sys\nsys.modules['_probe'].seen.append([float(X[0, 0]), type(X.base).__name__ != 'NoneType'])" },
      ],
      probe: '[bool(np.shares_memory(X, data)), list(X.shape), float(X.sum()), float(y.sum()), list(train.shape), float(test["a"].iloc[0]), '
        + 'bool(M.flags.writeable), float(M[5]), [__import__("sys").modules["_colloq_council"]._backing(one) is not None '
        + 'for one in (X, train._mgr.blocks[0].values, test._mgr.blocks[0].values, M)], bool(np.shares_memory(rows, data))]',
    })
    assert.equal(out.seed.ok, true, out.seed.error)
    for (const result of out.results) assert.equal(result.failure, null, result.failure ?? undefined)
    // A worker holds the views as views, of the epoch's mapped files: no private copy of any of them.
    assert.deepEqual(out.after, [true, [4000, 20], 80000, 4000, [20000, 8], 160000, false, 5, [true, true, true, true], true])
    // An attempt's write stays in its own mapping.
    assert.deepEqual(out.seen, [7, [1, true]])
  })

test('an export runs under an address-space ceiling of its own, and an in-band copy that cannot fit is refused before it is made',
  { skip: noPython || noNumeric }, () => {
    const root = scratch()
    const GB = 1024 * MiB
    // A Linux container as the module reads it, and a resource module that records what is set.
    const prep = [
      'import types',
      'm._linux = lambda: True',
      'm._gpu_near = lambda: False',
      `m._cgroup = lambda *names: {'memory.max': ${8 * GB}, 'memory.current': ${GB}}.get(names[0])`,
      'm._reclaimable = lambda: 0',
      `m._vmsize = lambda: ${1000 * MiB}`,
      'calls = []',
      "fake = types.ModuleType('resource')",
      'fake.RLIMIT_AS = 9',
      'fake.RLIM_INFINITY = -1',
      'fake.getrlimit = lambda what: (-1, -1)',
      'fake.setrlimit = lambda what, pair: calls.append(list(pair))',
      "sys.modules['resource'] = fake",
      'm._colloq_calls = calls',
    ].join('\n')
    // An array of a subclass pickles in band by its own reduce, a copy: the probe hears whether it ran.
    const setup = [
      'import sys, types, numpy as np',
      "probe = types.ModuleType('_probe')",
      'probe.reduced = 0',
      "sys.modules['_probe'] = probe",
      'class Tracked(np.ndarray):',
      '    def __reduce_ex__(self, protocol):',
      "        sys.modules['_probe'].reduced += 1",
      '        return np.ndarray.__reduce_ex__(self, protocol)',
      't = np.ones(300000).view(Tracked)',
      'small = [1, 2]',
    ].join('\n')
    const nearlyFull = [
      "m = __import__('sys').modules['_colloq_council']",
      // A card nearby: no ceiling at all, and the container's own memory is the only guard left.
      'm._gpu_near = lambda: True',
      `m._cgroup = lambda *names: {'memory.max': ${1100 * MiB}, 'memory.current': ${1000 * MiB}}.get(names[0])`,
    ].join('\n')
    const { reports, after } = notebook(setup, [
      { seq: 1, mainRuns: 1, dir: path.join(root, 'e1'), budgetBytes: MiB },
      { seq: 2, mainRuns: 1, dir: path.join(root, 'e2'), before: nearlyFull },
    ], "[sys.modules['_probe'].reduced, sys.modules['_colloq_council']._colloq_calls]", prep)
    const [tight, full] = reports
    assert.equal(tight.ok, true, tight.error ?? undefined)
    assert.deepEqual(tight.left, [{ name: 't', why: 'budget' }])
    assert.deepEqual(full.left, [{ name: 't', why: 'budget' }], 'a copy past what the container has left was made')
    const [reduced, calls] = after
    assert.equal(reduced, 0, 'the in-band copy was made before the name was refused')
    // The first export set its ceiling (the address space now plus what the container has left) and put it back; the second, near a card, set none.
    assert.deepEqual(calls, [[1000 * MiB + 7 * GB - 256 * MiB, -1], [-1, -1]])
  })

test('torch\'s CPU storages travel out of band, and an optimizer costs only its own state',
  { skip: noPython || (has('torch, numpy') ? false : 'no torch and numpy in this python3') }, () => {
    const setup = [
      'import torch',
      'torch.manual_seed(0)',
      'model = torch.nn.Linear(256, 256)',
      'opt = torch.optim.Adam(model.parameters())',
      'model(torch.ones(1, 256)).sum().backward()',
      'opt.step()',
      'was = float(model.weight.sum())',
    ].join('\n')
    // The weights once, their two moments once each: the budget holds them, and nothing of the weights twice.
    const { report, cas } = epochOf(setup, { budgetBytes: MiB })
    assert.deepEqual(report.left, [])
    assert.ok(report.bodyBytes < 64 * 1024, `the stream holds ${report.bodyBytes} bytes`)
    assert.deepEqual(report.buffers.map((file) => file.bytes), [262144, 262144, 262144])
    const out = worker({
      report, dir: cas,
      probe: "[opt.param_groups[0]['params'][0] is model.weight, abs(float(model.weight.sum()) - was) < 1e-6, "
        + "sorted(opt.state[model.weight]), float(opt.state[model.weight]['exp_avg'].abs().sum()) > 0]",
    })
    assert.equal(out.seed.ok, true, out.seed.error)
    assert.deepEqual(out.after, [true, true, ['exp_avg', 'exp_avg_sq', 'step'], true])
  })

test('a function, a partial or a closure over a carried table costs only what it adds', { skip: noPython || noNumeric }, () => {
  const { report, cas } = epochOf([
    'import functools, numpy as np',
    'table = np.ones(100000)',
    'def make(t):',
    '    def check():',
    '        return float(t.sum())',
    '    return check',
    // Sorted before the table it closes over, and over the cap of a name that is not data.
    'check = make(table)',
    'part = functools.partial(np.sum, table)',
    'def evaluate(x=table):',
    '    return float(x.mean())',
  ].join('\n'), { nameBytes: 64 * 1024 })
  assert.deepEqual(report.left, [])
  assert.deepEqual(report.carried, ['check', 'evaluate', 'make', 'part', 'table'])
  assert.equal(report.buffers.length, 1)
  const out = worker({ report, dir: cas, probe: '[check(), float(part()), evaluate(), check.__closure__[0].cell_contents is table]' })
  assert.equal(out.seed.ok, true, out.seed.error)
  assert.deepEqual(out.after, [100000, 100000, 1, true])
})

test('a buffer whose bytes were only moved about is written again: crc32 sees what adler32 did not', { skip: noPython || noNumeric }, () => {
  const root = scratch()
  const { reports } = notebook('import numpy as np\nX = np.arange(200000)', [
    { seq: 1, mainRuns: 1, dir: path.join(root, 'e1') },
    // Two values swapped 65521 elements apart: adler32's sums both stay as they were.
    { seq: 2, mainRuns: 2, dir: path.join(root, 'e2'), before: 'X[[0, 65521]] = X[[65521, 0]]' },
  ])
  const [first, swapped] = reports
  assert.equal(swapped.reused, 0)
  assert.notEqual(swapped.buffers[0].sha256, first.buffers[0].sha256, 'the swapped array kept the old file')
  const cas = path.join(root, 'cas')
  collect(path.join(root, 'e2'), cas)
  assert.deepEqual(worker({ report: swapped, dir: cas, probe: '[int(X[0]), int(X[65521])]' }).after, [65521, 0])
})

test('an epoch\'s files together stay within its budget, the manifest and the process state included', { skip: noPython }, () => {
  const { report } = epochOf("a = b'x' * 524000\nb = b'y' * 524000", { budgetBytes: MiB })
  assert.ok(report.bytes <= MiB, `${report.bytes} bytes for a budget of ${MiB}`)
  assert.deepEqual(report.carried, ['a'])
  assert.deepEqual(report.left, [{ name: 'b', why: 'budget' }])
})

test('a failed export takes away what it wrote', { skip: noPython }, () => {
  const root = scratch()
  const dir = path.join(root, 'e1')
  // A variable of the environment past the manifest's size: the stream is written by then, the manifest refused.
  const { reports } = notebook("import os\nos.environ['HUGE'] = 'x' * (5 * 1024 * 1024)\nrows = list(range(100000))", [{ seq: 1, mainRuns: 1, dir }])
  assert.equal(reports[0].ok, false)
  assert.match(reports[0].error ?? '', /manifest is over its size/)
  assert.ok(!existsSync(dir), `a failed export left ${existsSync(dir) ? readdirSync(dir).join(', ') : ''}`)
})

test('a carried object whose module a worker cannot import leaves its names behind, never the seed', { skip: noPython }, () => {
  const root = scratch()
  const lib = path.join(root, 'site')
  mkdirSync(lib)
  writeFileSync(path.join(lib, 'extrapkg.py'), 'class Model(object):\n    def __init__(self):\n        self.w = [1, 2, 3]\n')
  writeFileSync(path.join(lib, 'warnpkg.py'), 'class Noisy(UserWarning):\n    pass\n')
  const { report, cas } = epochOf([
    'import sys, warnings',
    `sys.path.append(${JSON.stringify(lib)})`,
    'import extrapkg',
    // A package the process state alone needs: a filter of its warning class.
    'import warnpkg',
    "warnings.filterwarnings('ignore', category=warnpkg.Noisy)",
    'del warnpkg',
    'model = extrapkg.Model()',
    "bundle = {'m': model, 'n': 5}",
    'rows = [1, 2, 3]',
    'k = 41',
  ].join('\n'))
  assert.deepEqual(report.carried, ['bundle', 'k', 'model', 'rows'])
  // Installed in the notebook's kernel only: `!pip install` there, and the council container never had it.
  rmSync(lib, { recursive: true, force: true })
  const out = worker({
    report, dir: cas,
    attempts: [{ source: "import sys\nsys.modules['_probe'].seen.append([k + 1, rows])" }, { source: 'print(model.w)' }],
  })
  assert.equal(out.seed.ok, true, out.seed.error)
  // Said as such, a module the worker lacks (the console's «модуль есть только в ядре тетради»), not as a value that does not copy.
  assert.deepEqual(out.seed.left, [
    { name: 'bundle', why: 'module' }, { name: 'extrapkg', why: 'module' }, { name: 'model', why: 'module' },
  ])
  assert.deepEqual(out.seen, [[42, [1, 2, 3]]])
  // An attempt that needs one goes to the shared kernel, where the module is.
  assert.deepEqual(parseCouncilReport(JSON.stringify(out.results[1].report))!.needs, [{ name: 'model', why: 'module' }])
})

test('a seeded worker refuses an entry without its inputs, and a seed that failed refuses every entry', { skip: noPython }, () => {
  const { report, cas } = epochOf('k = 1')
  const out = worker({
    report, dir: cas,
    attempts: [
      { source: 'x = k', entry: { runId: undefined } },
      { source: 'x = k', entry: { capMb: undefined } },
      { source: 'x = k' },
    ],
  })
  assert.deepEqual(out.results.map((result) => result.report.ok), [false, false, true])
  assert.match(out.results[0].report.error, /without its source, run id or cap/)
  // A seed refused midway leaves no epoch to run on, not an empty namespace that looks like one.
  const failed = worker({ report: { ...report, body: SHA(9) }, dir: cas, attempts: [{ source: 'x = 1' }] })
  assert.equal(failed.seed.ok, false)
  assert.equal(failed.results[0].report.ok, false)
  assert.match(failed.results[0].report.error, /holds no epoch/)
})

test('a seed maps its stream rather than reading it, and measures its baseline once the stream is let go', { skip: noPython }, () => {
  // Forty megabytes in band: bytes are never a buffer of their own.
  const { report, cas } = epochOf("blob = b'x' * (40 * 1024 * 1024)\nk = 1")
  assert.ok(report.bodyBytes > 40 * MiB)
  // The worker's own memory as tracemalloc counts it, for smaps_rollup, which only Linux has.
  const prep = 'import tracemalloc\ntracemalloc.start()\nm._dirty = lambda: tracemalloc.get_traced_memory()[0]'
  const out = worker({
    report, dir: cas, prep,
    attempts: [
      { source: "import sys, tracemalloc\nsys.modules['_probe'].seen.append(tracemalloc.get_traced_memory()[1])", bare: true },
      // An attempt that leaves 30 MB behind for good, in a worker whose «Память на попытку» is 20 MB.
      // Written, not zero-filled: Linux counts a zeroed allocation nobody touched as no dirty memory at all.
      { source: "import sys\nsys.modules['_probe'].keep = bytearray(b'\\x01') * (30 * 1024 * 1024)", entry: { capMb: 20 } },
    ],
  })
  assert.equal(out.seed.ok, true, out.seed.error)
  // The blob itself, once: never the stream read in beside it.
  assert.ok(out.seen[0] < 60 * MiB, `the seed's peak was ${out.seen[0]} bytes`)
  const exit = parseExitReport(JSON.stringify(out.results[0].exit))!
  assert.ok((exit.grown ?? 0) >= 30 * MiB, `grown ${exit.grown}`)
  assert.equal(exit.recycle, true)
})

test('a worker raises its OOM score before it unpickles a thing', { skip: noPython }, () => {
  const root = scratch()
  const lib = path.join(root, 'lib')
  mkdirSync(lib)
  const score = path.join(root, 'oom_score_adj')
  // An object that reads the score while the stream loads.
  writeFileSync(path.join(lib, 'probe_oom.py'), [
    'class Reader(object):',
    '    def __init__(self, path):',
    '        self.path = path',
    '    def __reduce__(self):',
    '        return (read_now, (self.path,))',
    'def read_now(path):',
    '    with open(path) as handle:',
    '        return handle.read()',
  ].join('\n'))
  const { report, cas } = epochOf(`import sys\nsys.path.insert(0, ${JSON.stringify(lib)})\nimport probe_oom\nheard = probe_oom.Reader(${JSON.stringify(score)})`)
  writeFileSync(score, '0')
  const out = worker({ report, dir: cas, prep: `m._OOM = ${JSON.stringify(score)}`, probe: 'heard' })
  assert.equal(out.seed.ok, true, out.seed.error)
  assert.equal(out.after, '1000')
})

test('an attempt maps from the descriptor its seed kept, and a mapping that fails is a copy that counts', { skip: noPython || noNumeric }, () => {
  const { report, cas } = epochOf('import numpy as np\narr = np.arange(100000.0)')
  const file = path.join(cas, report.buffers[0].sha256)
  const out = worker({
    report, dir: cas,
    attempts: [
      // The agent lets an older epoch's files go while workers still hold it.
      { source: `import os\nos.unlink(${JSON.stringify(file)})`, bare: true },
      { source: "import sys\nsys.modules['_probe'].seen.append([type(arr.base).__name__, bool(arr.flags.owndata)])" },
      { source: "import sys\nsys.modules['_colloq_council']._mmap = None", bare: true },
      { source: 'x = 1', budget: 1024 },
    ],
  })
  assert.equal(out.seed.ok, true, out.seed.error)
  assert.deepEqual(out.seen, [['mmap', false]])
  // No mapping: a copy, as in the shared kernel, and over this budget it stays shared, named.
  assert.deepEqual(out.results[1].report.skipped, [{ name: 'arr', bytes: 800000 }])
})

test('past the skeleton\'s cap the folders down to the notebook\'s own stay real, and the links are capped', { skip: noPython }, () => {
  const root = scratch()
  const ws = path.join(root, 'ws')
  mkdirSync(path.join(ws, 'lesson3'), { recursive: true })
  mkdirSync(path.join(ws, 'datasets'))
  writeFileSync(path.join(ws, 'lesson3', 'data.csv'), 'a,b\n1,2\n')
  for (let n = 0; n < 6; n++) writeFileSync(path.join(ws, 'datasets', `img${n}.png`), 'x')
  // The notebook's kernel works in lesson3/, as a notebook kept in a subfolder does.
  const { report, cas } = epochOf(`import os\nos.chdir(${JSON.stringify(path.join(ws, 'lesson3'))})`, { workspace: ws })
  const area = path.join(root, 'scratch')
  mkdirSync(area)
  // A scratch root the kernels may write into and enter but not list, as the agent may make it.
  chmodSync(area, 0o333)
  try {
    const out = worker({
      report, dir: cas, workspace: ws,
      attempts: [{
        source: "import sys, os\nsys.modules['_probe'].seen.append([os.path.basename(os.getcwd()), open('data.csv').read()])\nopen('out.csv', 'w').write('1')",
        entry: { runId: 'deep1', scratchRoot: area, skeletonEntries: 3 },
      }],
    })
    assert.equal(out.seed.ok, true, out.seed.error)
    assert.equal(out.results[0].failure, null, out.results[0].failure ?? undefined)
    assert.deepEqual(out.seen, [['lesson3', 'a,b\n1,2\n']])
    assert.deepEqual(parseExitReport(JSON.stringify(out.results[0].exit))!.files.map((file) => file.name), ['lesson3/out.csv'])
    const top = readdirSync(path.join(area, 'deep1')).sort()
    assert.deepEqual(top, ['datasets', 'lesson3'])
    assert.ok(lstatSync(path.join(area, 'deep1', 'lesson3')).isDirectory() && !lstatSync(path.join(area, 'deep1', 'lesson3')).isSymbolicLink())
    assert.ok(lstatSync(path.join(area, 'deep1', 'datasets')).isSymbolicLink())
  } finally {
    chmodSync(area, 0o755)
  }
})
