/**
 * Personal copies of data per council attempt — from below, from the Python
 * side.
 *
 * The trouble all this exists for happened at a live seminar on 19 Sep 2026:
 * the task had a commented-out line `# data = data.dropna()`, one person
 * uncommented it and ran it — and `data` became different for EVERYONE,
 * including those who had already submitted. The old clean-up (a snapshot of
 * names before the attempt, removing the new ones after) could not catch this
 * by design: rebinding changes a name that ALREADY EXISTED, and
 * `df.drop(..., inplace=True)` changes no names at all.
 *
 * So what is tested here is not the shape of the source but the behaviour:
 * the same piece of Python that goes into the room's kernel is executed by a
 * real `python3` — entry, attempt, exit — and after the exit the originals
 * must be intact down to the last byte. Half of the cases need neither pandas
 * nor numpy (a list, a dict, a set), and that half always runs; tables and
 * arrays only if this `python3` has them.
 *
 * `python3` may be missing (CI without Python, someone else's machine) — then
 * the whole lower half is skipped, while the upper one, about building the
 * source and parsing the report, stays: it is pure.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { setLocaleResolver } from '../shared/i18n.js'
import {
  councilEnterRefusal,
  councilEnterSource,
  councilLeftoverNotes,
  councilMemoryNote,
  councilSkipNotes,
  parseCouncilLeftovers,
  parseCouncilReport,
  sizeWords,
  COUNCIL_EXIT_SOURCE,
  COUNCIL_MODULE,
  COUNCIL_REPORT_EXPR,
  MAX_SKIP_NOTES,
  SIZE_UNKNOWN,
  type CouncilIsolationReport,
} from '../server/src/kernel/council-isolation.js'
import { guardPolicySource, GUARD_MODULE } from '../server/src/kernel/danger.js'

/* --------------------------------------------------------------- sources */

test('entry is three statements that bind not a single name in the kernel', () => {
  const source = councilEnterSource(1024 * 1024)
  const lines = source.split('\n')
  /*
   * It became three statements on 20 Sep 2026, when the guard against
   * dangerous commands moved from the council into a shared module: the first
   * line installs THE GUARD, the second the isolation, the third enters. The
   * order is not a matter of taste — the entry immediately takes hold of the
   * guard and refuses without it (IMPL · `_hold`).
   */
  assert.equal(lines.length, 3, 'entry is no longer three statements')
  assert.ok(lines[0].includes(JSON.stringify(GUARD_MODULE)), 'the first line does not install the guard')
  /*
   * Not a single assignment at the top level — that is the whole point of
   * `exec` into the hidden module's `__dict__`. Were `import sys` or
   * `m = ...` to appear here, the entry itself would break the promise "the
   * namespace returns exactly to what it was": its own names would stay with
   * the student.
   */
  for (const line of lines) {
    assert.doesNotMatch(line, /^[A-Za-z_][A-Za-z0-9_]*\s*=[^=]/, `entry bound a name: ${line.slice(0, 40)}`)
    assert.doesNotMatch(line, /^(import|from|def|class)\s/, `entry bound a name: ${line.slice(0, 40)}`)
  }
  /*
   * Installation goes through a version check, not unconditionally: the
   * source has grown past twenty kilobytes, and a `compile` per attempt would
   * cost half a millisecond for nothing. The version is a hash of the source
   * itself, so a new server build reinstalls the module in an already live
   * kernel on its own, without restarting the room.
   */
  for (const line of [lines[0], lines[1]]) {
    assert.match(line, /^if getattr\(__import__\('sys'\)\.modules\.get\(/)
    assert.match(line, /'version', None\) != "[0-9a-f]{12}": exec\(compile\(/)
  }
  assert.ok(lines[1].includes(JSON.stringify(COUNCIL_MODULE)))
  // The version inside the source and the version in the check are one and
  // the same string, otherwise the module would be reinstalled on every
  // attempt, and silently.
  const stamp = /!= "([0-9a-f]{12})"/.exec(lines[1])![1]
  assert.ok(lines[1].includes(`version = '${stamp}'`), 'the version in the source is different')
  // The budget travels as a number in the request itself: the kernel knows
  // nothing about the server's configuration.
  assert.match(lines[2], /\.enter\(globals\(\), 1048576, \{/)
  // A bad number does not turn into NaN inside Python: our own default is
  // closer at hand.
  assert.match(councilEnterSource(Number.NaN), /\.enter\(globals\(\), 536870912, \{/)
  assert.match(councilEnterSource(-1), /\.enter\(globals\(\), 536870912, \{/)

  /*
   * The settings go as a literal in the call, not inside the source: the
   * refusal text depends on the room's language, and that gets changed in the
   * panel in the middle of a class. The boolean, meanwhile, is a Python word:
   * `false` in the kernel is not a value but a NameError (we stepped on it).
   */
  assert.match(lines[2], /'memory': False\}?/)
  assert.match(councilEnterSource(1024, { memoryGuard: true }), /'memory': True/)
  assert.doesNotMatch(lines[2], /\b(false|true|null)\b/)
  /*
   * The refusal's tail is the attempt's OWN: in a room it points to the
   * "Dangerous commands" rule, but here nobody can allow this — the kernel is
   * one for everyone, and promising otherwise would be untrue.
   */
  setLocaleResolver(() => 'en')
  assert.match(councilEnterSource(1024), /never run: the whole room shares one kernel/)
  assert.doesNotMatch(councilEnterSource(1024), /The teacher can allow/)
  setLocaleResolver(() => 'ru')
  assert.match(councilEnterSource(1024), /не выполняются никогда: ядро одно на всю комнату/)
  assert.doesNotMatch(councilEnterSource(1024), /Разрешить такие команды/)
})

test('exit survives the module being absent — then there is nothing to return', () => {
  // The kernel may have been restarted between entry and exit: no module, and
  // a KeyError is a normal outcome, which the source itself must swallow, not
  // the server.
  assert.match(COUNCIL_EXIT_SOURCE, /^try:/)
  assert.match(COUNCIL_EXIT_SOURCE, /except Exception:\n {4}pass$/)
  assert.ok(COUNCIL_EXIT_SOURCE.includes('.leave(globals())'))
  assert.ok(COUNCIL_REPORT_EXPR.includes(COUNCIL_MODULE))
})

/* ---------------------------------------------------------------- report */

test('the report is read from the mimebundle, and anything unclear means "not confirmed"', () => {
  const body = { ok: true, copied: 3, skipped: [{ name: 'big', bytes: 42 }], failed: [], bytes: 7, ms: 4 }
  const bundle = { status: 'ok', data: { 'text/plain': JSON.stringify(body) }, metadata: {} }
  const parsed = parseCouncilReport(bundle)
  assert.equal(parsed?.ok, true)
  assert.equal(parsed?.copied, 3)
  assert.equal(parsed?.bytes, 7)
  assert.deepEqual(parsed?.skipped, [{ name: 'big', bytes: 42 }])

  // The same string without the wrapper — that is how the test driving
  // python3 directly reads it.
  assert.equal(parseCouncilReport(JSON.stringify(body))?.copied, 3)

  /*
   * Everything else is `null`, and this is the main property of the parser:
   * by it the server decides NOT to run the attempt. An empty object is
   * exactly what comes from the kernel when the entry failed:
   * user_expressions are not evaluated on a failed run.
   */
  assert.equal(parseCouncilReport({}), null, 'an empty answer passed for a confirmation')
  assert.equal(parseCouncilReport(undefined), null)
  assert.equal(parseCouncilReport({ status: 'error', ename: 'KeyError' }), null)
  assert.equal(parseCouncilReport({ status: 'ok', data: { 'text/plain': 'не json' } }), null)
  assert.equal(parseCouncilReport({ status: 'ok', data: { 'text/plain': '{"copied":1}' } }), null,
    'a report without ok passed for a confirmation')

  // An entry refusal is a report, not silence: it has a cause.
  const bad = parseCouncilReport('{"ok":false,"error":"MemoryError: ","copied":0,"ms":3}')
  assert.equal(bad?.ok, false)
  assert.equal(bad?.error, 'MemoryError: ')
})

/* ----------------------------------------------------------------- words */

test('what stayed shared is told in human words, in at most three lines and in two languages', () => {
  const report = (skipped: { name: string; bytes: number }[]): CouncilIsolationReport => ({
    ok: true, copied: 0, skipped, failed: [], bytes: 0, ms: 1, error: null,
  })
  setLocaleResolver(() => 'ru')
  assert.deepEqual(councilSkipNotes(report([])), [])

  const one = councilSkipNotes(report([{ name: 'big', bytes: 1.2 * 1024 ** 3 }]))
  assert.equal(one.length, 1)
  assert.match(one[0], /Переменная `big`/)
  assert.match(one[0], /1,2 ГБ/)
  // The advice must be actionable: the name is filled in on both sides.
  assert.match(one[0], /big = big\.copy\(\)/)
  // The line goes to the attempt's stderr — with its own newline, not glued
  // on.
  assert.ok(one[0].endsWith('\n'))

  const many = councilSkipNotes(report(
    ['a', 'b', 'c', 'd', 'e'].map((name) => ({ name, bytes: 5 * 1024 ** 2 })),
  ))
  assert.equal(many.length, MAX_SKIP_NOTES + 1, 'the warnings would crowd out the answer itself')
  assert.match(many.at(-1)!, /и ещё 2 такие переменные/)

  // Did not fit the budget or did not copy — for the student it is the same
  // thing: the data is shared. But the second one has no size, and making one
  // up is not allowed.
  const failed = councilSkipNotes({
    ok: true, copied: 0, skipped: [], bytes: 0, ms: 1, error: null,
    failed: [{ name: 'conn', error: 'TypeError: cannot pickle' }],
  })
  assert.equal(failed.length, 1)
  assert.match(failed[0], /`conn`/)
  // A failed copy has no size, and making one up is not allowed.
  assert.doesNotMatch(failed[0], /\(\d/, 'a made-up size')
  // A walk that hit the node ceiling — the same line without a number.
  const deep = councilSkipNotes(report([{ name: 'tree', bytes: SIZE_UNKNOWN }]))
  assert.equal(deep.length, 1)
  assert.doesNotMatch(deep[0], /\(\d/)

  assert.match(councilEnterRefusal(null), /Не удалось подготовить личные копии/)
  assert.match(councilEnterRefusal(null), /ядро не подтвердило/)
  assert.match(councilEnterRefusal('MemoryError'), /MemoryError/)
  assert.doesNotMatch(councilEnterRefusal('MemoryError'), /\n/, 'the refusal is no longer a single line')

  setLocaleResolver(() => 'en')
  assert.match(councilSkipNotes(report([{ name: 'big', bytes: 3 * 1024 ** 2 }]))[0], /too large to copy/)
  assert.match(councilEnterRefusal(null), /Could not prepare personal copies/)
  assert.equal(sizeWords(2 * 1024 ** 3), '2 GB')
  assert.equal(sizeWords(512 * 1024), '512 kB')
  assert.match(councilMemoryNote(2 * 1024 ** 3), /ran out of memory/)
  setLocaleResolver(() => 'ru')

  /*
   * A MemoryError under our ceiling is a class saved, and it has to be told
   * so that the student understands: it was they who fell over, not the room.
   * The number is required: without it the advice "reduce the size" has
   * nothing to lean on.
   */
  assert.match(councilMemoryNote(2 * 1024 ** 3), /не хватило памяти/)
  assert.match(councilMemoryNote(2 * 1024 ** 3), /2 ГБ/)
  assert.match(councilMemoryNote(2 * 1024 ** 3), /Ядро и данные остальных целы/)
  // There was no ceiling (not Linux, CUDA alongside) — the same thought, but
  // without a made-up number.
  assert.doesNotMatch(councilMemoryNote(null), /\d/)
  assert.match(councilMemoryNote(null), /Ядро и данные остальных целы/)
})

/* ---------------------------------------------------- a real python3 */

const python = (() => {
  const probe = spawnSync('python3', ['-c', 'import sys; print(sys.version_info[0])'], {
    encoding: 'utf8',
  })
  return probe.status === 0 ? 'python3' : null
})()

interface Drive {
  /** What went into `setup`, went through `enter`, survived the attempt and was returned by the exit. */
  setup: string
  attempt: string
  /** A Python expression evaluated in `ns` AFTER the exit and put into JSON. */
  probe: string
  budget?: number
  /** A second entry in a row, with no exit in between: the previous exit never arrived. */
  twice?: boolean
  /**
   * The room's "Dangerous commands" rule, declared to the kernel BEFORE the
   * entry.
   *
   * Since 20 Sep 2026 the guard against `exit()` and `os._exit()` is not the
   * council's own: the council keeps the shared one (danger.ts) switched on,
   * and after the exit the guard stays exactly as the rule told it to be.
   * Nothing said means the guard's own default, that is, "Blocked".
   */
  policy?: boolean
}

/**
 * One run on a real python3: setup → entry → attempt → exit → probe.
 *
 * `ns` is a plain dict, and it is an honest stand-in for user_ns: IPython
 * executes a cell in exactly the same way, with `globals()` equal to it. An
 * exception in the attempt is caught and named, but the exit runs in any
 * case — just as on the server.
 */
interface Drove {
  report: any
  /** The exit's report: what it had no way to put back. `null` means nothing was left behind. */
  left: any
  after: any
  failure: string | null
  names: string[]
}

function drive(what: Drive): Drove {
  const enterOnce = "exec(compile(ENTER, '<enter>', 'exec'), ns)"
  const module = JSON.stringify(COUNCIL_MODULE)
  const script = [
    'import json, sys',
    `ENTER = ${JSON.stringify(councilEnterSource(what.budget ?? 512 * 1024 * 1024))}`,
    `EXIT = ${JSON.stringify(COUNCIL_EXIT_SOURCE)}`,
    "ns = {'__builtins__': __builtins__, '__name__': '__main__'}",
    `exec(compile(${JSON.stringify(what.setup)}, '<setup>', 'exec'), ns)`,
    ...(what.policy === undefined
      ? []
      : [`exec(compile(${JSON.stringify(guardPolicySource(what.policy))}, '<rule>', 'exec'), ns)`]),
    enterOnce,
    `report = json.loads(repr(sys.modules[${module}].report))`,
    'failure = None',
    'try:',
    `    exec(compile(${JSON.stringify(what.attempt)}, '<attempt>', 'exec'), ns)`,
    'except BaseException as err:',
    '    failure = type(err).__name__ + ": " + str(err)',
    ...(what.twice ? [enterOnce] : []),
    "exec(compile(EXIT, '<exit>', 'exec'), ns)",
    `raw = sys.modules[${module}].leftovers`,
    'left = json.loads(repr(raw)) if raw is not None else None',
    `after = eval(compile(${JSON.stringify(what.probe)}, '<probe>', 'eval'), ns)`,
    "print('@@' + json.dumps({'report': report, 'after': after, 'failure': failure, 'left': left,"
      + " 'names': sorted(k for k in ns if k not in ('__builtins__', '__name__'))}))",
  ].join('\n')
  const run = spawnSync(python!, ['-'], { input: script, encoding: 'utf8' })
  assert.equal(run.status, 0, `python3 crashed: ${run.stderr}`)
  const line = run.stdout.split('\n').find((l) => l.startsWith('@@'))
  assert.ok(line, `no answer: ${run.stdout} ${run.stderr}`)
  return JSON.parse(line.slice(2))
}

const noPython = python ? false : 'no python3'

test('rebinding, mutation and a new name do not survive the attempt — on a real python3', { skip: noPython }, () => {
  const out = drive({
    setup: [
      'lst = [1, 2, 3]',
      "d = {'k': 1}",
      'st = {1, 2}',
      'ba = bytearray(b"abc")',
      "nested = {'inner': [1, 2], 'deep': {'q': 3}}",
      'shared = [7]',
      'a = shared',
      'b = shared',
      // A tuple is immutable itself, but the list inside it is not.
      'pair = ([1], "x")',
    ].join('\n'),
    attempt: [
      // Rebinding: that very line from the seminar, only on a list.
      'lst = lst + [9]',
      "d['k'] = 2",
      "d['new'] = 3",
      'st.add(3)',
      'ba.extend(b"xyz")',
      "nested['inner'].append(4)",
      "nested['deep']['q'] = 9",
      // Two names for one object — and inside the attempt they must stay one.
      "assert a is b, 'copies drifted apart'",
      'a.append(8)',
      "assert b == [7, 8], 'a change through a is not visible through b'",
      'pair[0].append(2)',
      'secret = 42',
    ].join('\n'),
    probe: "{'lst': lst, 'd': d, 'st': sorted(st), 'ba': ba.decode(), 'nested': nested,"
      + " 'a': a, 'b': b, 'same': a is b and a is shared, 'pair': list(pair[0])}",
  })
  assert.equal(out.report.ok, true)
  assert.equal(out.failure, null, `the attempt failed: ${out.failure}`)
  assert.deepEqual(out.after.lst, [1, 2, 3], 'the rebinding was not rolled back')
  assert.deepEqual(out.after.d, { k: 1 }, 'the dict is corrupted')
  assert.deepEqual(out.after.st, [1, 2], 'the set is corrupted')
  assert.equal(out.after.ba, 'abc', 'the bytearray is corrupted')
  assert.deepEqual(out.after.nested, { inner: [1, 2], deep: { q: 3 } }, 'the nested value is corrupted')
  assert.deepEqual(out.after.a, [7], 'the shared object is corrupted')
  assert.deepEqual(out.after.pair, [1], 'the list inside the tuple is corrupted')
  assert.equal(out.after.same, true, 'after the exit the names drifted apart onto different objects')
  assert.ok(!out.names.includes('secret'), 'the new name survived the attempt')
  // And the entry and the exit left not a single name of their own behind.
  assert.ok(!out.names.some((n) => n.startsWith('_colloq')), out.names.join(','))
  assert.deepEqual(out.names, ['a', 'b', 'ba', 'd', 'lst', 'nested', 'pair', 'shared', 'st'])
})

test('an exception or KeyboardInterrupt in the middle of an attempt does not stop the exit', { skip: noPython }, () => {
  for (const boom of ['raise ValueError("бум")', 'raise KeyboardInterrupt()']) {
    const out = drive({
      setup: 'lst = [1, 2, 3]',
      attempt: `lst.append(9)\n${boom}`,
      probe: 'lst',
    })
    assert.equal(out.report.ok, true)
    assert.deepEqual(out.after, [1, 2, 3], `the exit did not run after ${boom}`)
  }
})

test('an object over the budget is named in the report and stays shared', { skip: noPython }, () => {
  // A budget of a hundred bytes: no real list fits under it.
  const out = drive({
    setup: 'big = list(range(5000))\nsmall = [1]',
    attempt: 'big.append(-1)\nsmall.append(2)',
    probe: "{'big': big[-1], 'small': small}",
    budget: 100,
  })
  assert.equal(out.report.ok, true)
  assert.deepEqual(out.report.skipped.map((r: { name: string }) => r.name), ['big'])
  assert.ok(out.report.skipped[0].bytes > 100, 'the report does not name the size')
  assert.equal(out.after.big, -1, 'the over-budget object turned out to be a copy')
  assert.deepEqual(out.after.small, [1], 'the small object did not get a copy')
})

test('a second entry without an exit does not lose the originals', { skip: noPython }, () => {
  const out = drive({
    setup: 'lst = [1, 2, 3]',
    attempt: 'lst.append(9)',
    probe: 'lst',
    twice: true,
  })
  assert.deepEqual(out.after, [1, 2, 3], 'the second entry remembered the copy as the original')
})

test('the working directory comes back together with the names', { skip: noPython }, () => {
  const out = drive({
    setup: 'import os as _os\nwas = _os.getcwd()',
    attempt: "import os\nos.chdir('/')",
    probe: '_os.getcwd() == was',
  })
  assert.equal(out.after, true, 'the working directory did not come back')
})

/* -------------------------------------------- pandas and numpy, if present */

const hasPandas = python !== null &&
  spawnSync(python, ['-c', 'import pandas, numpy'], { encoding: 'utf8' }).status === 0

test('a table and an array: dropna, inplace and writes by index do not reach the next person',
  { skip: hasPandas ? false : 'no pandas/numpy' }, () => {
    const out = drive({
      setup: [
        'import pandas as pd',
        'import numpy as np',
        "data = pd.DataFrame({'a': [1.0, None, 3.0]})",
        "df = pd.DataFrame({'a': [1, 2, 3], 'b': [4, 5, 6]})",
        's = pd.Series([1, 2, 3])',
        'arr = np.arange(5)',
        "box = {'inner': pd.DataFrame({'z': [1, 2]})}",
      ].join('\n'),
      attempt: [
        // Exactly what happened at the seminar on 19 Sep 2026.
        'data = data.dropna()',
        "assert len(data) == 2, 'the attempt did not see its copy'",
        "df.drop(columns=['b'], inplace=True)",
        "df['x'] = 1",
        'df.iloc[0, 0] = 999',
        's[0] = 777',
        'arr[0] = 555',
        "box['inner']['z2'] = 5",
      ].join('\n'),
      probe: "{'data': int(len(data)), 'cols': list(df.columns), 's0': int(s[0]),"
        + " 'arr0': int(arr[0]), 'box': list(box['inner'].columns)}",
    })
    assert.equal(out.report.ok, true)
    assert.equal(out.failure, null, `the attempt failed: ${out.failure}`)
    assert.ok(out.report.copied >= 5, `too little was copied: ${out.report.copied}`)
    assert.equal(out.after.data, 3, 'the table rebinding was not rolled back')
    assert.deepEqual(out.after.cols, ['a', 'b'], 'the inplace column drop reached the original')
    assert.equal(out.after.s0, 1, 'the write into the Series reached the original')
    assert.equal(out.after.arr0, 0, 'the write into the ndarray reached the original')
    assert.deepEqual(out.after.box, ['z'], 'the nested table is corrupted')
    // Modules are not copied: a copy of numpy would cost a lot and mean
    // nothing.
    assert.ok(out.names.includes('np') && out.names.includes('pd'))
  })

/* ------------------------------------ destructive tricks and the process */

/**
 * "Someone will do X, and it is over for everyone" — a list collected at a
 * live seminar.
 *
 * Every line here is closed by one and the same move: a snapshot before the
 * attempt, a restore after. The value of the test is that it runs a REAL
 * python3 — half of these cases break the restore itself if it is written
 * carelessly (a replaced `builtins.list` once brought the whole exit down).
 */
test('del, globals().clear() and shadowed builtins do not survive the attempt', { skip: noPython }, () => {
  const out = drive({
    setup: 'df = [1, 2, 3]\nkeep = {"a": 1}',
    attempt: 'del df\nlist = "сломал"\nlen = None\nsecret = 1',
    probe: "{'df': df, 'keep': keep}",
  })
  assert.deepEqual(out.after.df, [1, 2, 3], 'del df was not restored')
  assert.deepEqual(out.names, ['df', 'keep'], 'shadowed builtins or a new name survived the attempt')

  const wiped = drive({
    setup: 'df = [1, 2, 3]\nkeep = {"a": 1}',
    attempt: 'globals().clear()',
    probe: "{'df': df, 'keep': keep}",
  })
  assert.deepEqual(wiped.after, { df: [1, 2, 3], keep: { a: 1 } }, 'globals().clear() took the room away with it')
})

test('replaced builtins come back — and do not break the restore itself', { skip: noPython }, () => {
  /*
   * Here the restore repairs what it uses itself. While it called `list(ns)`
   * from builtins, an attempt with `builtins.list = "..."` brought the exit
   * down on its first line, the state stayed replaced, and the next entry
   * remembered someone else's copies as originals. Verified — it failed
   * exactly like that.
   */
  const out = drive({
    setup: 'df = [1, 2, 3]',
    attempt: 'import builtins\nbuiltins.list = "сломал"\nbuiltins.len = None\nbuiltins.ПОДКИНУТО = 1',
    probe: "{'list_ok': __import__('builtins').list is list, 'len_ok': __import__('builtins').len is len,"
      + " 'no_new': not hasattr(__import__('builtins'), 'ПОДКИНУТО'), 'df': df}",
  })
  assert.equal(out.after.list_ok, true, 'builtins.list stayed replaced')
  assert.equal(out.after.len_ok, true, 'builtins.len stayed replaced')
  assert.equal(out.after.no_new, true, 'the planted name stayed in builtins')
  assert.deepEqual(out.after.df, [1, 2, 3], 'restoring the names did not finish after broken builtins')
})

test('exit() and quit() in an attempt refuse instead of shutting down the room\'s kernel', { skip: noPython }, () => {
  // In ipykernel this is `shell.ask_exit()` — the end of the process and lost
  // variables for EVERYONE; reproduced on a live kernel. Plain python has no
  // shell, so the names themselves are checked here, and IPython's autocall
  // by an acceptance test on a kernel.
  const out = drive({
    setup: 'df = [1]',
    attempt: 'try:\n    exit()\nexcept BaseException as e:\n    caught = type(e).__name__\n'
      + 'try:\n    quit()\nexcept BaseException as e:\n    caught2 = type(e).__name__\n'
      + 'both = [caught, caught2]',
    probe: "{'names': sorted(k for k in globals() if k in ('exit', 'quit')), 'df': df}",
  })
  assert.equal(out.failure, null, out.failure ?? '')
  assert.deepEqual(out.after.names, [], 'exit/quit stayed in the namespace after the exit')
})

/**
 * That very `os._exit(0)` which on 20 Sep 2026 took the kernel away from
 * thirty people nine times.
 *
 * The test is built so that this trouble physically cannot slip past it: if
 * `os._exit` fires, python ends silently, `print('@@'...)` is never reached,
 * and `drive` fails with "no answer". So what is checked is not the shape of
 * the refusal but exactly that the process is ALIVE — the only thing that
 * mattered that day. `os.abort()` sits alongside: it kills the same way, only
 * through SIGABRT.
 *
 * And the second half, no less important: after the exit `os._exit` must be
 * the REAL one. Leaving our refusal in the shared `os` module would mean
 * breaking `multiprocessing` for the whole room — not for the attempt, but
 * for good.
 */
test('os._exit() in an attempt refuses instead of shutting down the room\'s kernel', { skip: noPython }, () => {
  const out = drive({
    setup: 'df = [1]',
    // Exactly the attempt that stood in room d8uf9ewe on 20 Sep 2026 — two
    // lines.
    attempt: 'import os\nos._exit(0)',
    probe: "{'alive': True, 'df': df}",
  })
  // We got here, so python made it to printing the answer, that is, it
  // survived.
  assert.equal(out.after.alive, true, 'the attempt took the process down with it')
  assert.deepEqual(out.after.df, [1], 'the room\'s data did not survive the attempt')
  // The refusal's name is what the server goes by to print one line instead
  // of a traceback.
  assert.match(out.failure ?? '', /^ColloqRefused: /, `instead of a refusal: ${out.failure}`)
  assert.match(out.failure ?? '', /os\._exit/)
})

test('os.abort() in an attempt refuses the same way', { skip: noPython }, () => {
  const out = drive({
    setup: 'df = [1]',
    attempt: 'import os\nos.abort()',
    probe: "{'alive': True}",
  })
  assert.equal(out.after.alive, true, 'os.abort() took the process down with it')
  assert.match(out.failure ?? '', /^ColloqRefused: /, `instead of a refusal: ${out.failure}`)
})

/**
 * Nesting: the attempt holds the guard ON TOP of the rule, and the exit
 * restores exactly what the rule says.
 *
 * Before 20 Sep 2026 the council had its own copy of the refusal, and after
 * the exit `os._exit` had to become the real one again — otherwise
 * `multiprocessing` would break for the whole room for good. Now there is one
 * copy (danger.ts), and the promise has become more precise: with the rule
 * set to "Allowed", the REAL functions come back after the attempt; with
 * "Blocked", the guard stays in place — and it should, this is the room's
 * rule, not a property of the attempt.
 *
 * Checked name by name, because one can go wrong here silently in both
 * directions: a forgotten refusal in the shared `os` is joblib broken until
 * the end of the class, and a removed guard is exactly the hole all of this
 * was written for.
 */
test('after the exit the functions come back according to the room\'s rule, not the attempt',
  { skip: noPython }, () => {
    const allowed = drive({
      // The note about what the attempt saw goes into sys.modules: the exit
      // removes the names the attempt created, but it does not look there.
      setup: 'import os, signal, sys, types\n'
        + "sys.modules['_probe'] = types.ModuleType('_probe')\n"
        + 'real = (os._exit, os.abort, os.kill, signal.raise_signal)',
      attempt: "import os, sys\nsys.modules['_probe'].held = os._exit is not real[0]",
      probe: "{'restored': os._exit is real[0] and os.abort is real[1]"
        + " and os.kill is real[2] and signal.raise_signal is real[3], 'held': sys.modules['_probe'].held}",
      policy: false,
    })
    assert.equal(allowed.failure, null, allowed.failure ?? '')
    assert.equal(allowed.after.held, true, 'there was no guard inside the attempt — the class can be brought down')
    assert.equal(
      allowed.after.restored,
      true,
      'with the rule set to "Allowed" the replacement survived the attempt — this breaks multiprocessing for good',
    )

    const blocked = drive({
      // The note about what the attempt saw goes into sys.modules: the exit
      // removes the names the attempt created, but it does not look there.
      setup: 'import os, signal, sys, types\n'
        + "sys.modules['_probe'] = types.ModuleType('_probe')\n"
        + 'real = (os._exit, os.abort, os.kill, signal.raise_signal)',
      attempt: "import os, sys\nsys.modules['_probe'].held = os._exit is not real[0]",
      probe: "{'guarded': os._exit is not real[0] and os.abort is not real[1]"
        + " and os.kill is not real[2] and signal.raise_signal is not real[3], 'held': sys.modules['_probe'].held}",
      policy: true,
    })
    assert.equal(blocked.failure, null, blocked.failure ?? '')
    assert.equal(blocked.after.held, true, 'there was no guard inside the attempt')
    assert.equal(
      blocked.after.guarded,
      true,
      'the exit from the attempt removed the room\'s guard — and the rule requires exactly that guard',
    )
  })

test('process state comes back: the RNG, output streams, the path, the environment', { skip: noPython }, () => {
  const out = drive({
    setup: 'import random, sys, os, warnings, decimal\n'
      + 'random.seed(1234)\n'
      + 'was = [random.random() for _ in range(3)]\n'
      + 'random.seed(1234)\n'
      + 'path_was = list(sys.path)\n'
      + 'os.environ["COLLOQ_KEEP"] = "да"\n'
      + 'warnings.resetwarnings()\n'
      + 'filters_was = len(warnings.filters)\n'
      + 'limit_was = sys.getrecursionlimit()\n'
      + 'prec_was = decimal.getcontext().prec',
    attempt: 'import random, sys, os, io, warnings, decimal\n'
      + 'random.seed(99)\n[random.random() for _ in range(5)]\n'
      + 'sys.stdout = io.StringIO()\n'
      + 'sys.path.insert(0, "/подкинуто")\n'
      + 'os.environ["COLLOQ_NEW"] = "подкинуто"\n'
      + 'os.environ["COLLOQ_KEEP"] = "испорчено"\n'
      + 'warnings.filterwarnings("ignore")\n'
      + 'sys.setrecursionlimit(100)\n'
      + 'sys.settrace(lambda *a: None)\n'
      + 'decimal.getcontext().prec = 3',
    probe: "{'rng': [random.random() for _ in range(3)] == was,"
      + " 'stdout': sys.stdout is sys.__stdout__,"
      + " 'path': sys.path == path_was,"
      + " 'env_keep': os.environ.get('COLLOQ_KEEP'),"
      + " 'env_new': 'COLLOQ_NEW' in os.environ,"
      + " 'filters': len(warnings.filters) == filters_was,"
      + " 'reclimit': sys.getrecursionlimit() == limit_was,"
      + " 'trace': sys.gettrace() is None,"
      + " 'prec': decimal.getcontext().prec == prec_was}",
  })
  assert.equal(out.after.rng, true, 'the random number stream was shifted by the attempt')
  assert.equal(out.after.stdout, true, 'sys.stdout stayed replaced — output is broken for everyone')
  assert.equal(out.after.path, true, 'sys.path kept someone else\'s entry')
  assert.equal(out.after.env_keep, 'да', 'os.environ is corrupted')
  assert.equal(out.after.env_new, false, 'the planted environment variable stayed')
  assert.equal(out.after.filters, true, 'the warning filters stayed someone else\'s')
  assert.equal(out.after.reclimit, true, 'the recursion limit stayed someone else\'s')
  assert.equal(out.after.trace, true, 'the attempt\'s tracer stayed switched on')
  assert.equal(out.after.prec, true, 'the decimal context stayed someone else\'s')
})

test('a thread left by the attempt is counted by the exit — there is nothing to stop it with', { skip: noPython }, () => {
  const out = drive({
    setup: 'x = 1',
    attempt: 'import threading\nev = threading.Event()\n'
      + 'threading.Thread(target=lambda: ev.wait(20), daemon=True).start()',
    probe: 'x',
  })
  assert.equal(out.left?.threads, 1, `exit report: ${JSON.stringify(out.left)}`)
  // And exactly the same in the words the teacher will see.
  setLocaleResolver(() => 'ru')
  const notes = councilLeftoverNotes(parseCouncilLeftovers(JSON.stringify(out.left)))
  assert.equal(notes.length, 1)
  assert.match(notes[0], /остался работать 1 поток/)

  // And with nothing left behind there is no note at all: an empty report is
  // not news.
  const quiet = drive({ setup: 'x = 1', attempt: 'y = 2', probe: 'x' })
  assert.equal(parseCouncilLeftovers(JSON.stringify(quiet.left)), null)
})

test('numpy, pandas and their generators come back together with the rest',
  { skip: hasPandas ? false : 'no pandas/numpy' }, () => {
    const out = drive({
      setup: 'import numpy as np, pandas as pd\n'
        + 'np.random.seed(7)\nwas = list(np.random.rand(3))\nnp.random.seed(7)\n'
        + 'print_was = np.get_printoptions()["precision"]\n'
        + 'width_was = pd.get_option("display.width")\n'
        + 'rng = np.random.default_rng(5)\nfirst = list(rng.random(3))\n'
        + 'rng = np.random.default_rng(5)',
      attempt: 'import numpy as np, pandas as pd\n'
        + 'np.random.seed(1)\nnp.random.rand(5)\n'
        + 'np.set_printoptions(precision=1)\n'
        + 'pd.set_option("display.width", 17)\n'
        + 'mine = list(rng.random(3))',
      probe: "{'rng': list(np.random.rand(3)) == was,"
        + " 'print': np.get_printoptions()['precision'] == print_was,"
        + " 'pandas': pd.get_option('display.width') == width_was,"
        + " 'generator': list(rng.random(3)) == first}",
    })
    assert.equal(out.after.rng, true, 'numpy: the random number stream was shifted by the attempt')
    assert.equal(out.after.print, true, 'numpy printoptions stayed someone else\'s')
    assert.equal(out.after.pandas, true, 'pandas options stayed someone else\'s')
    // A Generator in a variable is state too: without a personal copy,
    // identical attempts would give different numbers depending on the queue.
    assert.equal(out.after.generator, true, 'np.random.Generator turned out to be shared')
  })

/* -------------------------------------------------- torch, if present */

const hasTorch = python !== null &&
  spawnSync(python, ['-c', 'import torch'], { encoding: 'utf8' }).status === 0

test('tensors, the model and the optimizer are personal, and the optimizer looks at its own model',
  { skip: hasTorch ? false : 'no torch' }, () => {
    for (const order of ['model', 'opt'] as const) {
      const out = drive({
        setup: 'import torch, torch.nn as nn\n'
          + 't = torch.arange(5, dtype=torch.float32)\n'
          + 'bag = [torch.zeros(4)]\n'
          + 'shared = torch.ones(3)\na = shared\nb = shared\n'
          + 'leaf = torch.zeros(2, requires_grad=True)\nnonleaf = leaf * 2\n'
          + (order === 'model'
            ? 'model = nn.Linear(4, 2)\nopt = torch.optim.SGD(model.parameters(), lr=1.0)\n'
            : 'model0 = nn.Linear(4, 2)\nopt = torch.optim.SGD(model0.parameters(), lr=1.0)\nmodel = model0\ndel model0\n')
          + 'was = float(model.weight[0][0])',
        attempt: 'import torch\nt[0] = 7\nt.add_(1)\nbag[0][0] = 5\n'
          + "assert a is b, 'tensors drifted apart'\na[0] = 9\n"
          + 'out = model(torch.ones(1, 4)).sum()\nopt.zero_grad()\nout.backward()\nopt.step()\n'
          + "assert opt.param_groups[0]['params'][0] is model.weight, 'the optimizer is not looking at its own model'\n"
          + 'moved = float(model.weight[0][0])',
        probe: "{'t': float(t[0]), 'bag': float(bag[0][0]), 'shared': float(a[0]),"
          + " 'same': a is b, 'weight': float(model.weight[0][0]), 'was': was}",
      })
      assert.equal(out.failure, null, `${order}: ${out.failure}`)
      assert.equal(out.after.t, 0, `${order}: the write into the tensor reached the original`)
      assert.equal(out.after.bag, 0, `${order}: the tensor in the list is corrupted`)
      assert.equal(out.after.shared, 1, `${order}: the shared tensor is corrupted`)
      assert.equal(out.after.same, true, `${order}: after the exit the names drifted apart`)
      assert.equal(out.after.weight, out.after.was, `${order}: the optimizer step changed the shared model`)
      // deepcopy does not take a non-leaf tensor with gradient history — it
      // stays shared and is named in the report instead of bringing the entry
      // down.
      assert.ok(out.report.failed.some((row: { name: string }) => row.name === 'nonleaf'),
        JSON.stringify(out.report.failed))
      assert.equal(out.report.ok, true)
    }
  })

/* --------------------------------- notebook classes and scipy.sparse */

test('an object of a class declared in the notebook gets a personal copy', { skip: noPython }, () => {
  const out = drive({
    setup: 'class Dataset:\n'
      + '    def __init__(self):\n'
      + '        self.rows = [1, 2, 3]\n'
      + '        self.name = "исходник"\n'
      + 'class Slotted:\n'
      + "    __slots__ = ('items',)\n"
      + '    def __init__(self):\n'
      + '        self.items = [1, 2]\n'
      + 'class WithGen:\n'
      + '    def __init__(self):\n'
      + '        self.gen = (i for i in range(3))\n'
      + '        self.rows = [1, 2]\n'
      + 'ds = Dataset()\nsl = Slotted()\nwg = WithGen()\n'
      + 'import io\nbuf = io.StringIO("x")',
    attempt: 'ds.rows.append(9)\nds.name = "испорчено"\nsl.items.append(3)\nwg.rows.append(9)',
    probe: "{'rows': ds.rows, 'name': ds.name, 'slots': sl.items, 'gen': wg.rows}",
  })
  assert.deepEqual(out.after.rows, [1, 2, 3], 'the list inside the notebook\'s object is corrupted')
  assert.equal(out.after.name, 'исходник', 'the field of the notebook\'s object is corrupted')
  assert.deepEqual(out.after.slots, [1, 2], 'the __slots__ object was not copied')
  // A generator inside has nothing to be copied with — the object stays
  // shared and is named.
  assert.deepEqual(out.after.gen, [1, 2, 9], 'the object with a generator got copied after all')
  const shared = out.report.failed.map((row: { name: string }) => row.name)
  assert.ok(shared.includes('wg'), JSON.stringify(out.report.failed))
  // A foreign (library) object is not copied at all: sockets and windows live
  // in there.
  assert.ok(!out.report.failed.some((row: { name: string }) => row.name === 'buf'))
})

const hasScipy = python !== null &&
  spawnSync(python, ['-c', 'import scipy.sparse'], { encoding: 'utf8' }).status === 0

test('a sparse matrix is copied and weighed by its own arrays', { skip: hasScipy ? false : 'no scipy' }, () => {
  const out = drive({
    setup: 'import scipy.sparse as sp, numpy as np\n'
      + 'm = sp.csr_matrix(np.array([[1.0, 0.0], [0.0, 2.0]]))\n'
      + 'big = sp.random(300, 300, density=0.5, format="csr")',
    attempt: 'm.data[:] = 0\nbig.data[:] = 0',
    probe: "{'m': float(m.toarray()[0][0]), 'big': float(abs(big).sum())}",
    budget: 1024,
  })
  assert.equal(out.after.m, 1, 'the write into the sparse matrix\'s data reached the original')
  // The big one did not fit the budget — and was weighed by its real arrays,
  // not by the wrapper's weight, otherwise it would slip past the budget
  // silently.
  const skipped = out.report.skipped.find((row: { name: string }) => row.name === 'big')
  assert.ok(skipped, JSON.stringify(out.report.skipped))
  assert.ok(skipped.bytes > 300 * 300 * 0.5 * 4, `sparse matrix weight: ${skipped.bytes}`)
})
