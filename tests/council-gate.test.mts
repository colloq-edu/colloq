/**
 * The gate of a council worker's kernel (server/src/kernel/council-gate.ts,
 * docs/architecture/remote-classes.md §9.6), from below: the module's text
 * and the entry that opens it, run by a real `python3`.
 *
 * CI has no ipykernel, so the kernel is a stand-in with ipykernel's own
 * shapes: an async `do_execute` with and without `cell_meta` (7.x hands it
 * the request's metadata, older ones do not), a `get_parent`, and an `ip`
 * whose `kernel` it is. What a real ipykernel 7.3 did with these same texts
 * — born gated through the system config, a request that outlived a dead
 * process refused by the next one — is the build's real-kernel check, said
 * in §20.26.
 *
 * `python3` may be missing; then the Python half is skipped, and the pure
 * half (the texts, the names) stays.
 */
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import {
  COUNCIL_GATE_CONFIG,
  COUNCIL_GATE_MODULE,
  COUNCIL_GATE_PYTHON,
  COUNCIL_GATE_REFUSAL,
  COUNCIL_GATE_REFUSED,
  COUNCIL_GATE_RUN_KEY,
  isGateRefusal,
} from '../server/src/kernel/council-gate.js'
import { COLLOQ_REFUSED } from '../server/src/kernel/danger.js'
import {
  councilEnterSource,
  COUNCIL_EXIT_SOURCE,
  COUNCIL_MODULE,
  exportExpression,
  loadExpression,
  parseSeedReport,
} from '../server/src/kernel/council-isolation.js'
import { COUNCIL_GATE_MOUNT } from '../shared/remote-kernels.js'

const python = (() => {
  const probe = spawnSync('python3', ['-c', 'import sys; print(sys.version_info[0])'], { encoding: 'utf8' })
  return probe.status === 0 ? 'python3' : null
})()
const noPython = python ? false : 'no python3'

const roots: string[] = []
after(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true })
})
function folder(): string {
  const root = mkdtempSync(path.join(tmpdir(), 'colloq-gate-'))
  roots.push(root)
  return root
}

/**
 * One python3 run: the gate's module installed as `colloq_gate` (`gate`),
 * two stand-in kernels — `k7` as ipykernel 7 has do_execute, `k6` as an
 * older one without `cell_meta` — and `call7`/`call6`, which call them as
 * those ipykernels do. Its answer is the JSON line starting with @@.
 */
function withGate(lines: string[]): any {
  const script = [
    'import asyncio, json, sys, types',
    `gate = types.ModuleType(${JSON.stringify(COUNCIL_GATE_MODULE)})`,
    `exec(compile(${JSON.stringify(COUNCIL_GATE_PYTHON)}, 'colloq_gate.py', 'exec'), gate.__dict__)`,
    `sys.modules[${JSON.stringify(COUNCIL_GATE_MODULE)}] = gate`,
    'class K7(object):',
    '    def __init__(self):',
    '        self.ran = []',
    "        self.parent = {'metadata': {}}",
    '    async def do_execute(self, code, silent, store_history=True, user_expressions=None, allow_stdin=False, *, cell_meta=None, cell_id=None):',
    "        self.ran.append({'code': code, 'silent': silent, 'ue': user_expressions})",
    "        return {'status': 'ok'}",
    '    def get_parent(self, channel=None):',
    '        return self.parent',
    'class K6(K7):',
    '    async def do_execute(self, code, silent, store_history=True, user_expressions=None, allow_stdin=False, *, cell_id=None):',
    "        self.ran.append({'code': code, 'silent': silent, 'ue': user_expressions})",
    "        return {'status': 'ok'}",
    'def call7(k, code, silent=False, run=None):',
    `    meta = {${JSON.stringify(COUNCIL_GATE_RUN_KEY)}: run} if run else {}`,
    "    return asyncio.run(k.do_execute(code=code, silent=silent, store_history=False, user_expressions={'u': '1'}, allow_stdin=True, cell_meta=meta, cell_id=None))",
    'def call6(k, code, silent=False, run=None):',
    `    k.parent = {'metadata': {${JSON.stringify(COUNCIL_GATE_RUN_KEY)}: run} if run else {}}`,
    "    return asyncio.run(k.do_execute(code, silent, False, {'u': '1'}, True, cell_id=None))",
    'def last(k):',
    '    return k.ran[-1]',
    'def runs(code):',
    "    ns = {'__builtins__': __builtins__, '__name__': '__main__'}",
    '    try:',
    '        exec(compile(code, "<cell>", "exec"), ns)',
    "        return {'raised': None, 'names': sorted(k for k in ns if k not in ('__builtins__', '__name__'))}",
    '    except BaseException as err:',
    "        return {'raised': type(err).__name__, 'words': str(err), 'names': sorted(k for k in ns if k not in ('__builtins__', '__name__'))}",
    ...lines,
  ].join('\n')
  const run = spawnSync(python!, ['-'], { input: script, encoding: 'utf8' })
  assert.equal(run.status, 0, `python3 crashed: ${run.stderr}`)
  const line = run.stdout.split('\n').find((one) => one.startsWith('@@'))
  assert.ok(line, `no answer: ${run.stdout} ${run.stderr}`)
  return JSON.parse(line.slice(2))
}

/* ----------------------------------------------------------------- texts */

test('the gate refuses with the guard\'s own exception name, and only its own words are taken for its refusal', () => {
  assert.equal(COUNCIL_GATE_REFUSED, COLLOQ_REFUSED)
  assert.ok(isGateRefusal(COLLOQ_REFUSED, COUNCIL_GATE_REFUSAL))
  assert.ok(!isGateRefusal(COLLOQ_REFUSED, 'exit() is refused in an attempt'), 'the guard\'s refusal is no gate\'s')
  assert.ok(!isGateRefusal('ValueError', COUNCIL_GATE_REFUSAL))
  // English for the log, never a card's: no Cyrillic in either text.
  assert.doesNotMatch(COUNCIL_GATE_PYTHON + COUNCIL_GATE_CONFIG + COUNCIL_GATE_REFUSAL, /[А-Яа-яЁё]/)
})

test('the system config puts the gate\'s folder first on sys.path and loads it as an extra extension, which a profile\'s `extensions` does not replace', { skip: noPython }, () => {
  const script = [
    'import json, sys, types',
    "app = types.SimpleNamespace(extensions=['profile_one'], extra_extensions=[])",
    "c = types.SimpleNamespace(InteractiveShellApp=app)",
    "ns = {'get_config': lambda: c}",
    `exec(compile(${JSON.stringify(COUNCIL_GATE_CONFIG)}, 'ipython_kernel_config.py', 'exec'), ns)`,
    "print('@@' + json.dumps({'first': sys.path[0], 'extra': app.extra_extensions, 'extensions': app.extensions}))",
  ].join('\n')
  const run = spawnSync(python!, ['-'], { input: script, encoding: 'utf8' })
  assert.equal(run.status, 0, run.stderr)
  const answer = JSON.parse(run.stdout.split('\n').find((one) => one.startsWith('@@'))!.slice(2))
  assert.deepEqual(answer, { first: COUNCIL_GATE_MOUNT, extra: [COUNCIL_GATE_MODULE], extensions: ['profile_one'] })
})

/* ---------------------------------------------------------- the gate itself */

test('a non-silent request runs only when the gate was opened for the token it carries, once; silent ones always pass', { skip: noPython }, () => {
  const answer = withGate([
    'k = K7()',
    'gate.load_ipython_extension(types.SimpleNamespace(kernel=k))',
    'out = {}',
    "out['installed'] = gate.installed()",
    // Born gated: a request carrying a token is held to the gate before any entry ran.
    "call7(k, 'attempt()', run='R0')",
    "out['born'] = last(k)",
    // A home before the gate sends no token and its entry never touches the gate: its request runs, as it always did.
    "call7(k, 'print(0)')",
    "out['before'] = last(k)",
    'gate.close()',
    "call7(k, 'print(1)')",
    "out['shut'] = last(k)",
    "call7(k, 'service()', silent=True)",
    "out['silent'] = last(k)",
    "gate.open_for('R1')",
    "call7(k, 'service()', silent=True)",
    "call7(k, 'attempt()', run='R1')",
    "out['open'] = last(k)",
    "call7(k, 'attempt()', run='R1')",
    "out['spent'] = last(k)",
    "gate.open_for('R2')",
    "call7(k, 'attempt()', run='R3')",
    "out['wrong'] = last(k)",
    "call7(k, 'attempt()', run='R2')",
    "out['wrong_spent'] = last(k)",
    "gate.open_for('R4')",
    'gate.close()',
    "call7(k, 'attempt()', run='R4')",
    "out['closed'] = last(k)",
    "out['refusal'] = runs(out['shut']['code'])",
    // A second load changes nothing: one wrapper.
    'before = k.do_execute',
    'gate.load_ipython_extension(types.SimpleNamespace(kernel=k))',
    "out['once'] = k.do_execute is before",
    // A terminal IPython has no kernel: nothing to gate, nothing raised.
    'gate.load_ipython_extension(types.SimpleNamespace())',
    "print('@@' + json.dumps(out))",
  ])
  assert.equal(answer.installed, true)
  const refusedCode = `__import__('${COUNCIL_GATE_MODULE}')._refuse()`
  assert.deepEqual(answer.born, { code: refusedCode, silent: false, ue: {} }, 'a request with a token ran in a process no entry opened the gate in')
  assert.deepEqual(answer.before, { code: 'print(0)', silent: false, ue: { u: '1' } }, 'a home before the gate had its attempt refused')
  assert.deepEqual(answer.shut, { code: refusedCode, silent: false, ue: {} }, 'an ungated request ran once an entry shut the gate, or kept its expressions')
  assert.deepEqual(answer.silent, { code: 'service()', silent: true, ue: { u: '1' } })
  assert.deepEqual(answer.open, { code: 'attempt()', silent: false, ue: { u: '1' } }, 'a silent request spent the opening, or the token was not taken')
  assert.equal(answer.spent.code, refusedCode, 'an opening let two requests through')
  assert.equal(answer.wrong.code, refusedCode)
  assert.equal(answer.wrong_spent.code, refusedCode, 'a refused request left the opening for the next')
  assert.equal(answer.closed.code, refusedCode)
  // The refused code raises the guard's exception with the gate's words, and binds no name where it runs.
  assert.deepEqual(answer.refusal, { raised: COLLOQ_REFUSED, words: COUNCIL_GATE_REFUSAL, names: [] })
  assert.equal(answer.once, true)
})

test('an ipykernel that does not hand do_execute the metadata: the token is read off the shell\'s parent, and a call by position is taken', { skip: noPython }, () => {
  const answer = withGate([
    'k = K6()',
    'gate.load_ipython_extension(types.SimpleNamespace(kernel=k))',
    'out = {}',
    "gate.open_for('R1')",
    "call6(k, 'attempt()', run='R1')",
    "out['open'] = last(k)",
    "call6(k, 'attempt()', run='R1')",
    "out['spent'] = last(k)",
    "gate.open_for('R2')",
    "call6(k, 'attempt()', run='R9')",
    "out['wrong'] = last(k)",
    // One that hands cell_meta to a method that does not take it (arguments chosen by the wrapper's own signature) still runs.
    "gate.open_for('R3')",
    "k.parent = {'metadata': {}}",
    "call7(k, 'attempt()', run='R3')",
    "out['handed'] = last(k)",
    "print('@@' + json.dumps(out))",
  ])
  const refusedCode = `__import__('${COUNCIL_GATE_MODULE}')._refuse()`
  assert.deepEqual(answer.open, { code: 'attempt()', silent: false, ue: { u: '1' } })
  assert.equal(answer.spent.code, refusedCode)
  assert.deepEqual(answer.wrong, { code: refusedCode, silent: false, ue: {} })
  assert.equal(answer.handed.code, 'attempt()', 'cell_meta handed to a method without it: the request failed or was refused')
})

test('an opening stands only with its request\'s whole reply: one that ends in an error, with an expression that failed, or raising takes it back, in either ipykernel\'s shape', { skip: noPython }, () => {
  const answer = withGate([
    'import inspect',
    // A kernel whose silent request runs its code (an entry opening the gate) and answers as the test says, async or not.
    'class KR(K7):',
    '    reply = None',
    '    sync = False',
    '    def do_execute(self, code, silent, store_history=True, user_expressions=None, allow_stdin=False, *, cell_meta=None, cell_id=None):',
    "        self.ran.append({'code': code, 'silent': silent, 'ue': user_expressions})",
    '        if silent:',
    "            exec(code, {'gate': gate})",
    "        reply = self.reply if silent else {'status': 'ok'}",
    '        def answer():',
    '            if isinstance(reply, BaseException):',
    '                raise reply',
    '            return reply',
    '        if self.sync:',
    '            return answer()',
    '        async def later():',
    '            return answer()',
    '        return later()',
    'def callr(k, code, silent=False, run=None):',
    `    meta = {${JSON.stringify(COUNCIL_GATE_RUN_KEY)}: run} if run else {}`,
    '    try:',
    "        out = k.do_execute(code=code, silent=silent, store_history=False, user_expressions={'u': '1'}, allow_stdin=True, cell_meta=meta, cell_id=None)",
    '        return asyncio.run(out) if inspect.isawaitable(out) else out',
    '    except BaseException as err:',
    '        return type(err).__name__',
    'k = KR()',
    'gate.load_ipython_extension(types.SimpleNamespace(kernel=k))',
    'out = {}',
    "whole = {'status': 'ok', 'user_expressions': {'colloq': {'status': 'ok', 'data': {}}}}",
    "cases = [('error', {'status': 'error'}), ('expression', {'status': 'ok', 'user_expressions': {'colloq': {'status': 'error'}}}), ('raised', KeyboardInterrupt()), ('whole', whole)]",
    'for sync in (False, True):',
    '    k.sync = sync',
    '    for name, reply in cases:',
    '        k.reply = reply',
    "        said = callr(k, \"gate.open_for('R-%s')\" % name, silent=True)",
    "        key = name + ('-sync' if sync else '')",
    "        out[key] = {'token': gate._state['token'], 'said': said if isinstance(said, str) else None}",
    "        callr(k, 'attempt()', run='R-' + name)",
    "        out[key]['attempt'] = last(k)['code']",
    // A silent request that opens nothing leaves an opening made before it alone, whatever its reply.
    "gate.open_for('R-kept')",
    "k.reply = {'status': 'error'}",
    "callr(k, 'pass', silent=True)",
    "out['kept'] = gate._state['token']",
    "print('@@' + json.dumps(out))",
  ])
  const refusedCode = `__import__('${COUNCIL_GATE_MODULE}')._refuse()`
  for (const shape of ['', '-sync']) {
    for (const name of ['error', 'expression', 'raised']) {
      assert.equal(answer[name + shape].token, null, `${name}${shape}: an opening outlived a reply that was not whole`)
      assert.equal(answer[name + shape].attempt, refusedCode, `${name}${shape}`)
    }
    assert.equal(answer['raised' + shape].said, 'KeyboardInterrupt', 'the exception was swallowed')
    assert.deepEqual([answer['whole' + shape].token, answer['whole' + shape].attempt], ['R-whole', 'attempt()'])
  }
  assert.equal(answer.kept, 'R-kept')
})

/* ----------------------------------------------------- the entry opens it */

/**
 * The hidden module's entry with the gate installed on a stand-in kernel:
 * `case(name, settings, prep)` runs one entry (and its exit) and says what
 * the report and the gate were after it.
 */
function entries(cases: Array<{ name: string; options: Parameters<typeof councilEnterSource>[1]; prep?: string; before?: string }>, extra: string[] = []): Record<string, { ok: boolean; error: string | null; needs: string[]; token: string | null }> {
  const install = councilEnterSource(1024).split('\n').slice(0, 2).join('\n')
  return withGate([
    'k = K7()',
    'gate.load_ipython_extension(types.SimpleNamespace(kernel=k))',
    `exec(compile(${JSON.stringify(install)}, '<install>', 'exec'), {})`,
    `m = sys.modules[${JSON.stringify(COUNCIL_MODULE)}]`,
    'out = {}',
    ...extra,
    ...cases.flatMap((one) => [
      "ns = {'__builtins__': __builtins__, '__name__': '__main__', 'x': [1, 2]}",
      ...(one.prep ? [one.prep] : []),
      ...(one.before ? [one.before] : []),
      `exec(compile(${JSON.stringify(councilEnterSource(64 * 1024 * 1024, one.options))}, '<enter>', 'exec'), ns)`,
      'report = json.loads(repr(m.report))',
      "token = gate._state['token']",
      `exec(compile(${JSON.stringify(COUNCIL_EXIT_SOURCE)}, '<exit>', 'exec'), ns)`,
      `out[${JSON.stringify(one.name)}] = {'ok': report['ok'], 'error': report.get('error'), 'needs': [n['name'] for n in report.get('needs', [])], 'token': token}`,
      'm.epoch = None',
      'gate.close()',
    ]),
    "print('@@' + json.dumps(out))",
  ])
}

test('a worker\'s entry opens the gate for its run id as its last step when it holds; shut on its needs path, on an error, and in a process without the epoch it was given', { skip: noPython }, () => {
  const scratch = folder()
  const worker = (runId: string, source: string, more: Partial<NonNullable<Parameters<typeof councilEnterSource>[1]>> = {}) => ({ source, runId, capMb: 512, scratchRoot: scratch, ...more })
  const seeded = (left: string) => `m.epoch = {'seq': 7, 'left': ${left}, 'dirty': None}`
  const answer = entries([
    { name: 'ok', options: worker('r1', 'print(x)') },
    { name: 'error', options: worker('r2', 'print(x)', { scratchRoot: path.join(scratch, 'missing') }), before: "gate.open_for('stale')" },
    { name: 'needs', options: worker('r3', 'print(conn)'), prep: seeded("{'conn': 'connection'}"), before: "gate.open_for('stale')" },
    { name: 'fresh', options: worker('r4', 'print(x)', { epoch: 7 }) },
    { name: 'other', options: worker('r5', 'print(x)', { epoch: 8 }), prep: seeded('{}') },
    { name: 'held', options: worker('r6', 'print(x)', { epoch: 7 }), prep: seeded('{}') },
  ])
  assert.deepEqual(answer.ok, { ok: true, error: null, needs: [], token: 'r1' })
  assert.equal(answer.error!.ok, false)
  assert.equal(answer.error!.token, null, 'an entry that failed left the gate open: the attempt behind it would run')
  assert.deepEqual([answer.needs!.ok, answer.needs!.needs, answer.needs!.token], [false, ['conn'], null])
  // A process that holds no epoch, or another than its pool loaded for the attempt: a fresh one after an unheard death.
  for (const name of ['fresh', 'other'] as const) {
    assert.deepEqual([answer[name]!.ok, answer[name]!.token], [false, null], name)
    assert.match(answer[name]!.error ?? '', /does not hold the epoch its attempt was given/)
  }
  assert.deepEqual(answer.held, { ok: true, error: null, needs: [], token: 'r6' })
})

test('an entry with no gate to open is the entry it always was: the notebook\'s own, a kernel without the module, one whose gate is not installed', { skip: noPython }, () => {
  const scratch = folder()
  const answer = entries([
    // The notebook's own kernel's entry has no run id: the gate, were there one, is not its to touch.
    { name: 'notebook', options: {}, before: "gate.open_for('kept')" },
    // A gate whose wrapper is gone (do_execute replaced) is not installed: neither shut nor opened.
    { name: 'uninstalled', options: { source: 'print(x)', runId: 'r1', capMb: 512, scratchRoot: scratch }, before: "gate.open_for('kept'); k.do_execute = lambda *a, **kw: None" },
  ])
  assert.deepEqual(answer.notebook, { ok: true, error: null, needs: [], token: 'kept' })
  assert.deepEqual(answer.uninstalled, { ok: true, error: null, needs: [], token: 'kept' })
  // And with no gate module at all, a worker's entry holds as before.
  const bare = withGate([
    `del sys.modules[${JSON.stringify(COUNCIL_GATE_MODULE)}]`,
    "ns = {'__builtins__': __builtins__, '__name__': '__main__'}",
    `exec(compile(${JSON.stringify(councilEnterSource(1024, { source: 'print(1)', runId: 'r2', capMb: 512, scratchRoot: scratch }))}, '<enter>', 'exec'), ns)`,
    `print('@@' + repr(sys.modules[${JSON.stringify(COUNCIL_MODULE)}].report))`,
  ])
  assert.equal(bare.ok, true)
})

test('a worker\'s load says whether its process was born with the gate', { skip: noPython }, () => {
  const dir = folder()
  const exported = exportExpression({ seq: 3, mainRuns: 0, dir })
  const run = (gated: boolean) => withGate([
    'k = K7()',
    ...(gated ? ['gate.load_ipython_extension(types.SimpleNamespace(kernel=k))'] : []),
    "ns = {'__builtins__': __builtins__, '__name__': '__main__', 'x': 41, 'words': ['a', 'b']}",
    `exec(compile(${JSON.stringify(exported.code)}, '<export>', 'exec'), ns)`,
    `report = json.loads(repr(sys.modules[${JSON.stringify(COUNCIL_MODULE)}].exported))`,
    `load = ${JSON.stringify(loadExpression({ manifest: 'a'.repeat(64), body: 'b'.repeat(64), dir }).code)}`,
    "load = load.replace('a' * 64, report['manifest']).replace('b' * 64, report['body'])",
    "worker = {'__builtins__': __builtins__, '__name__': '__main__'}",
    "exec(compile(load, '<load>', 'exec'), worker)",
    `print('@@' + json.dumps({'seed': repr(sys.modules[${JSON.stringify(COUNCIL_MODULE)}].seeded), 'x': worker.get('x')}))`,
  ])
  for (const gated of [true, false]) {
    const answer = run(gated)
    const seed = parseSeedReport(answer.seed)
    assert.ok(seed?.ok, answer.seed)
    assert.equal(seed!.gated, gated, answer.seed)
    assert.equal(answer.x, 41)
  }
  // A report that does not say (an older module) is no gate.
  assert.equal(parseSeedReport(JSON.stringify({ ok: true }))?.gated, false)
})
