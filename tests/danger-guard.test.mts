/**
 * Dangerous commands in a cell — from below, from the Python side.
 *
 * The trouble all this exists for happened at a live class on 20 Sep 2026: a
 * student wrote `import os` and `os._exit(0)` in a council attempt, and the
 * teacher, going through the work and pressing "run", brought down the
 * room's kernel for thirty people nine times in eleven minutes. Such a death
 * cannot be told from normal work by anything — no trace, no signal in
 * dmesg, no counter in the cgroup, no line in the log.
 *
 * So what is checked here is not the shape of the source but the BEHAVIOUR:
 * the same piece of Python that goes into the room's kernel is executed by a
 * real `python3` next to a fake IPython shell (exactly the hooks the guard
 * replaces), and on it we call what a student would type out of curiosity.
 *
 * Every ban has a pair: "this is blocked" and "but this is not". The second
 * half matters more than the first. The boundary must be narrow, otherwise
 * the class breaks more quietly than the kernel used to fall: `git`, `pip`,
 * `ls`, `subprocess`, `kill` of one's own background process and `os.kill`
 * of someone else's child must work, otherwise joblib, multiprocessing and
 * half the seminar stop computing without a single word.
 *
 * `python3` may be missing (CI without Python, someone else's machine) —
 * then the lower half is skipped, while the upper one, about building the
 * source and parsing the report, stays: it is pure.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { setLocaleResolver } from '../shared/i18n.js'
import {
  guardCouncilSettings,
  guardHoldExpr,
  guardPolicySource,
  guardRoomSettings,
  parseGuardReport,
  COLLOQ_REFUSED,
  GUARD_MODULE,
  GUARD_RELEASE_EXPR,
  GUARD_REPORT_EXPR,
} from '../server/src/kernel/danger.js'
import { COUNCIL_REFUSED } from '../server/src/kernel/council-isolation.js'

/* --------------------------------------------------------------- sources */

test('installation is one line with a version check, and it binds no names', () => {
  const source = guardPolicySource(true)
  const lines = source.split('\n')
  assert.equal(lines.length, 2, 'the rule cell is no longer two statements')
  /*
   * Not a single assignment at the top level: the whole module lives in the
   * hidden module's `__dict__`, and after installation the student's
   * namespace has neither `os` nor `sys` nor a single variable of ours.
   */
  for (const line of lines) {
    assert.doesNotMatch(line, /^[A-Za-z_][A-Za-z0-9_]*\s*=[^=]/, `the guard bound a name: ${line.slice(0, 40)}`)
    assert.doesNotMatch(line, /^(import|from|def|class)\s/, `the guard bound a name: ${line.slice(0, 40)}`)
  }
  assert.match(lines[0], /^if getattr\(__import__\('sys'\)\.modules\.get\(/)
  assert.match(lines[0], /'version', None\) != "[0-9a-f]{12}": exec\(compile\(/)
  assert.ok(lines[0].includes(JSON.stringify(GUARD_MODULE)))
  // The version inside the source and the version in the check are one and
  // the same string, otherwise the module would be reinstalled on every
  // cell, and silently.
  const stamp = /!= "([0-9a-f]{12})"/.exec(lines[0])![1]
  assert.ok(lines[0].includes(`version = '${stamp}'`), 'the version in the source is different')
  // The boolean is a Python word: `false` in the kernel is not a value but a
  // NameError.
  assert.match(lines[1], /\.apply\(True, \{/)
  assert.match(guardPolicySource(false), /\.apply\(False, \{/)
  assert.doesNotMatch(source, /\b(false|true|null)\b/)
})

test('the rule line is the fingerprint: the rule and the language change it, nothing else does', () => {
  /*
   * By it the server decides whether to go to the kernel (kernel/index.ts ·
   * Runtime.guard). Were it to match under a different rule, the kernel
   * would live by yesterday's; were it to differ for no reason, there would
   * be an extra trip for every cell.
   */
  setLocaleResolver(() => 'ru')
  const blocked = guardPolicySource(true)
  assert.equal(guardPolicySource(true), blocked, 'the same question gave different lines')
  assert.notEqual(guardPolicySource(false), blocked, 'the rule is not visible in the line')
  setLocaleResolver(() => 'en')
  assert.notEqual(guardPolicySource(true), blocked, 'the refusal language is not visible in the line')
  setLocaleResolver(() => 'ru')
})

test('the refusal says what was not run, why, and who can allow it', () => {
  setLocaleResolver(() => 'ru')
  const room = guardRoomSettings()
  assert.ok(room.includes('{p0}'), 'the refusal has no slot for the command itself')
  assert.match(room, /опасная команда/)
  assert.match(room, /гасит ядро/)
  assert.match(room, /стирает переменные/)
  assert.match(room, /правило «Опасные команды»/)
  /*
   * But inside a council attempt nobody can allow this: the attempt runs on
   * the shared kernel, and the advice "ask the teacher" would be untrue.
   */
  const council = guardCouncilSettings()
  assert.match(council, /ядро одно на всю комнату/)
  assert.doesNotMatch(council, /правило «Опасные команды»/)

  setLocaleResolver(() => 'en')
  assert.match(guardRoomSettings(), /dangerous command/)
  assert.match(guardRoomSettings(), /Dangerous commands/)
  assert.match(guardCouncilSettings(), /never run/)
  setLocaleResolver(() => 'ru')
})

test('the exception name is one for the guard and the council — there is no second copy of the refusal', () => {
  assert.equal(COLLOQ_REFUSED, 'ColloqRefused')
  assert.equal(COUNCIL_REFUSED, COLLOQ_REFUSED)
  assert.ok(GUARD_REPORT_EXPR.includes(GUARD_MODULE))
  assert.ok(guardHoldExpr().includes('.hold('))
  assert.ok(GUARD_RELEASE_EXPR.includes('.release()'))
})

/* ---------------------------------------------------------------- report */

test('the report is read from the mimebundle, and anything unclear means "not confirmed"', () => {
  const body = { ok: true, on: true, policy: true, holds: 0, patched: ['_exit'] }
  const bundle = { status: 'ok', data: { 'text/plain': JSON.stringify(body) }, metadata: {} }
  const parsed = parseGuardReport(bundle)
  assert.equal(parsed?.ok, true)
  assert.equal(parsed?.policy, true)
  assert.deepEqual(parsed?.patched, ['_exit'])
  // The same string without the wrapper — that is how the test driving
  // python3 directly reads it.
  assert.equal(parseGuardReport(JSON.stringify(body))?.on, true)
  /*
   * Everything else is `null`, and this is the main property of the parser:
   * by it the server decides NOT to execute the cell. An empty object is
   * exactly what comes from the kernel when the installation failed:
   * user_expressions are not evaluated on a failed run.
   */
  assert.equal(parseGuardReport({}), null, 'an empty answer passed for a confirmation')
  assert.equal(parseGuardReport({ status: 'error' }), null)
  assert.equal(parseGuardReport('None'), null)
  assert.equal(parseGuardReport('не json'), null)
  assert.equal(parseGuardReport(JSON.stringify({ on: true })), null, 'a report without ok passed for an answer')
})

/* ---------------------------------------------------- a real python3 */

const python = (() => {
  const probe = spawnSync('python3', ['-c', 'import sys; print(sys.version_info[0])'], {
    encoding: 'utf8',
  })
  return probe.status === 0 ? 'python3' : null
})()
const noPython = python ? false : 'no python3'

/**
 * A fake IPython shell — exactly the hooks the guard replaces.
 *
 * Our own, not the real one: there is no ipykernel in the test environment,
 * and what needs testing is not it but our replacement. The hooks have the
 * same names as in `InteractiveShell`, and so the replacement lands on them
 * the same way as in a live kernel (that it lands there too was checked
 * live, in a throwaway container from the `colloq-kernel:base` image).
 */
const SHELL = [
  'class _Shell(object):',
  '    def __init__(self):',
  '        self.exited = False',
  '        self.kernel = types.SimpleNamespace(do_shutdown=lambda restart=False: "shut")',
  '    def ask_exit(self):',
  '        self.exited = True',
  '        return "exited"',
  '    def system(self, cmd):',
  '        return "ran:" + cmd',
  '    def getoutput(self, cmd):',
  '        return "out:" + cmd',
  '    def run_line_magic(self, name, line=""):',
  '        return "line:" + name',
  '    def run_cell_magic(self, name, line="", cell=""):',
  '        return "cell:" + name',
  'shell = _Shell()',
  '_ip = types.ModuleType("IPython")',
  '_ip.get_ipython = lambda: shell',
  'sys.modules["IPython"] = _ip',
].join('\n')

interface Ask {
  /** What to ask the kernel — a Python expression. */
  [name: string]: string
}

/**
 * One run on a real python3: set the rule, ask about each case.
 *
 * The answer to a case is either `ok:<repr>` or an exception name. They are
 * parsed afterwards by the `refused` and `ran` helpers, so that the tests
 * themselves read not "equals a string" but "refused" and "ran".
 */
function ask(
  asks: Ask,
  /** `pre` is evaluated BEFORE the rule is declared: it takes a snapshot of the real functions. */
  opts: { block?: boolean; steps?: string[]; setup?: string; pre?: string } = {},
): Record<string, string> {
  const script = [
    'import json, os, signal, subprocess, sys, types',
    SHELL,
    // Modules are put into `ns` by hand: this stands in for the kernel's
    // `user_ns`, where the student's `import os` brings them.
    'ns = {"__builtins__": __builtins__, "__name__": "__main__", "shell": shell,',
    '      "os": os, "sys": sys, "signal": signal, "subprocess": subprocess, "types": types}',
    ...(opts.pre ? [opts.pre] : []),
    `exec(compile(${JSON.stringify(guardPolicySource(opts.block !== false))}, '<rule>', 'exec'), ns)`,
    ...(opts.setup ? [opts.setup] : []),
    ...(opts.steps ?? []).map(
      (step, i) => `exec(compile(${JSON.stringify(step)}, '<step${i}>', 'exec'), ns)`,
    ),
    `CASES = ${JSON.stringify(Object.entries(asks))}`,
    'out = {}',
    'for name, src in CASES:',
    '    try:',
    '        value = eval(compile(src, "<ask>", "eval"), ns)',
    '        out[name] = "ok:" + repr(value)[:60]',
    '    except BaseException as err:',
    '        out[name] = type(err).__name__ + ": " + str(err)[:200]',
    `report = json.loads(repr(sys.modules[${JSON.stringify(GUARD_MODULE)}].report))`,
    'out["@report"] = json.dumps(report)',
    'print("@@" + json.dumps(out))',
  ].join('\n')
  const run = spawnSync(python!, ['-'], { input: script, encoding: 'utf8' })
  /*
   * Zero here is half the check. An unclosed `os._exit(0)` ends the process
   * WITHOUT a single word and with code 0: a test that looked only at the
   * absence of an exception would pass exactly on the day the guard fell
   * off. So the answer must ARRIVE as a line.
   */
  assert.equal(run.status, 0, `python3 crashed: ${run.stderr}`)
  const line = run.stdout.split('\n').find((l) => l.startsWith('@@'))
  assert.ok(line, `no answer — the process ended silently: ${run.stdout} ${run.stderr}`)
  return JSON.parse(line.slice(2))
}

/** Refused with our exception — and the text names the command itself. */
function refused(out: Record<string, string>, name: string, named: string): void {
  assert.match(out[name] ?? '', new RegExp(`^${COLLOQ_REFUSED}: `), `"${name}" was not refused: ${out[name]}`)
  assert.ok(
    (out[name] ?? '').includes(named),
    `the refusal for "${name}" did not name the command itself (${named}): ${out[name]}`,
  )
}

/** Ran as if nothing had happened. */
function ran(out: Record<string, string>, name: string): void {
  assert.match(out[name] ?? '', /^ok:/, `"${name}" did not run: ${out[name]}`)
}

test('the end of the process and the end of the kernel are closed — by every known way',
  { skip: noPython }, () => {
    const out = ask({
      'exit()': 'shell.ask_exit()',
      'do_shutdown': 'shell.kernel.do_shutdown(True)',
      'os._exit': 'os._exit(0)',
      'os.abort': 'os.abort()',
      'os.kill self': 'os.kill(os.getpid(), signal.SIGKILL)',
      'os.kill parent': 'os.kill(os.getppid(), signal.SIGTERM)',
      'os.kill pid 1': 'os.kill(1, signal.SIGKILL)',
      'os.kill -1': 'os.kill(-1, signal.SIGKILL)',
      'os.killpg': 'os.killpg(0, signal.SIGKILL)',
      'raise_signal': 'signal.raise_signal(signal.SIGKILL)',
      'pthread_kill': 'signal.pthread_kill(__import__("threading").get_ident(), signal.SIGKILL)',
    })
    refused(out, 'exit()', 'exit()')
    refused(out, 'do_shutdown', 'do_shutdown')
    refused(out, 'os._exit', 'os._exit()')
    refused(out, 'os.abort', 'os.abort()')
    for (const name of ['os.kill self', 'os.kill parent', 'os.kill pid 1', 'os.kill -1']) {
      refused(out, name, 'os.kill()')
    }
    refused(out, 'os.killpg', 'os.killpg()')
    refused(out, 'raise_signal', 'signal.raise_signal()')
    refused(out, 'pthread_kill', 'signal.pthread_kill()')
    // And the confirmation itself: the server reads exactly it and counts
    // silence as a refusal.
    const report = JSON.parse(out['@report'])
    assert.equal(report.ok, true)
    assert.equal(report.policy, true)
    assert.ok(report.patched.includes('_exit'), 'os._exit is not replaced, while the report says "ok"')
  })

test('sys.exit, someone else\'s process and a harmless signal get through — otherwise joblib is broken',
  { skip: noPython }, () => {
    const out = ask({
      // In ipykernel this is SystemExit, and the kernel survives it: nothing
      // to touch.
      'sys.exit': 'sys.exit(3)',
      // Signal 0 means "are you alive", not a kill.
      'probe alive': 'os.kill(os.getpid(), 0)',
      // Someone else's child: this is how subprocess, joblib and pools manage
      // processes.
      'kill child': 'os.kill(sub.pid, signal.SIGTERM) or sub.wait()',
      // A non-fatal signal to oneself — ordinary work with windows and timers.
      'own SIGWINCH': 'os.kill(os.getpid(), signal.SIGWINCH)',
    }, {
      setup: 'ns["sub"] = subprocess.Popen([sys.executable, "-c", "import time; time.sleep(5)"],'
        + ' stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)',
    })
    assert.match(out['sys.exit'] ?? '', /^SystemExit/, `sys.exit was touched: ${out['sys.exit']}`)
    ran(out, 'probe alive')
    ran(out, 'kill child')
    ran(out, 'own SIGWINCH')
  })

test('shell commands: only what kills the kernel or wipes out the class is closed',
  { skip: noPython }, () => {
    const out = ask({
      'bang kill all': 'shell.system("kill -9 -1")',
      'bang kill init': 'shell.system("kill 1")',
      'bang pkill python': 'shell.system("pkill -9 python")',
      'bang killall': 'shell.system("killall -9 python3")',
      'bang pkill dot': 'shell.system("pkill -f .")',
      'bang shutdown': 'shell.system("shutdown -h now")',
      'bang sudo reboot': 'shell.system("sudo reboot")',
      'bang init 0': 'shell.system("init 0")',
      'bang systemctl': 'shell.system("systemctl poweroff")',
      'bang rm root': 'shell.system("rm -rf /")',
      'bang rm star': 'shell.system("rm -rf /*")',
      'bang rm home': 'shell.system("rm -rf ~")',
      'bang chained': 'shell.system("ls && rm -rf /")',
      'bangbang reboot': 'shell.getoutput("reboot")',
      'os.system': 'os.system("halt")',
      'cell magic bash': 'shell.run_cell_magic("bash", "", "echo hi\\nkill -9 -1\\n")',
      'subprocess argv': 'subprocess.run(["shutdown", "now"])',
      'subprocess shell': 'subprocess.run("rm -rf /", shell=True)',

      // …and exactly as many "but this works" cases.
      'ls': 'shell.system("ls -la")',
      'git': 'shell.system("git status")',
      'pip': 'shell.system("pip install pandas")',
      'kill own pid': 'shell.system("kill -9 987654")',
      'pkill own server': 'shell.system("pkill -f my_server.py")',
      'rm build': 'shell.system("rm -rf build")',
      'rm subdir': 'shell.system("rm -rf ./out/tmp")',
      'pipe': 'shell.system("cat data.csv | head -3")',
      'bash body': 'shell.run_cell_magic("bash", "", "ls -la\\npwd\\n")',
      'subprocess git': 'subprocess.run([sys.executable, "-c", "print(1)"]).returncode',
      'popen subclass': 'isinstance(subprocess.Popen(["true"]), subprocess.Popen)',
    })
    for (const [name, named] of [
      ['bang kill all', 'kill -1'],
      ['bang kill init', 'kill 1'],
      ['bang pkill python', 'pkill python'],
      ['bang killall', 'killall python3'],
      ['bang pkill dot', 'pkill .'],
      ['bang shutdown', 'shutdown'],
      ['bang sudo reboot', 'reboot'],
      ['bang init 0', 'init 0'],
      ['bang systemctl', 'systemctl poweroff'],
      ['bang rm root', 'rm -r /'],
      ['bang rm star', 'rm -r /*'],
      ['bang rm home', 'rm -r ~'],
      ['bang chained', 'rm -r /'],
      ['bangbang reboot', 'reboot'],
      ['os.system', 'halt'],
      ['cell magic bash', 'kill -1'],
      ['subprocess argv', 'shutdown'],
      ['subprocess shell', 'rm -r /'],
    ] as const) {
      refused(out, name, named)
    }
    for (const name of [
      'ls', 'git', 'pip', 'kill own pid', 'pkill own server', 'rm build', 'rm subdir',
      'pipe', 'bash body', 'subprocess git', 'popen subclass',
    ]) {
      ran(out, name)
    }
    assert.equal(out['popen subclass'], 'ok:True', 'replacing Popen broke isinstance')
  })

test('%reset and %xdel wipe everyone\'s variables — and so they are closed, while other magics are not',
  { skip: noPython }, () => {
    const out = ask({
      'reset': 'shell.run_line_magic("reset", "-f")',
      'reset_selective': 'shell.run_line_magic("reset_selective", "df")',
      'xdel': 'shell.run_line_magic("xdel", "df")',
      'time': 'shell.run_line_magic("time", "sum(range(10))")',
      'matplotlib': 'shell.run_line_magic("matplotlib", "inline")',
      'pip magic': 'shell.run_line_magic("pip", "install pandas")',
    })
    refused(out, 'reset', '%reset')
    refused(out, 'reset_selective', '%reset_selective')
    refused(out, 'xdel', '%xdel')
    for (const name of ['time', 'matplotlib', 'pip magic']) ran(out, name)
    // These three have a reason of their own: not "kills the kernel" but
    // "wipes variables".
    assert.match(out['reset'] ?? '', /стирает переменные/)
  })

test('the "Allowed" rule brings back the REAL functions instead of quietly not interfering',
  { skip: noPython }, () => {
    const out = ask({
      'os._exit real': 'os._exit is real[0]',
      'os.abort real': 'os.abort is real[1]',
      'os.kill real': 'os.kill is real[2]',
      'raise_signal real': 'signal.raise_signal is real[3]',
      'os.system real': 'os.system is real[4]',
      'Popen real': 'subprocess.Popen is real[5]',
      'ask_exit gone': '"ask_exit" not in vars(shell)',
      'shell system': 'shell.system("rm -rf /")',
      'reset': 'shell.run_line_magic("reset", "-f")',
    }, {
      block: false,
      /*
       * The snapshot is taken BEFORE installation — that is, of the real
       * functions — and the "Allowed" rule must bring back exactly them. A
       * replacement left behind would break `multiprocessing` for the whole
       * room, and not for one cell but for good.
       */
      setup: 'ns["real"] = (os._exit, os.abort, os.kill, signal.raise_signal, os.system, subprocess.Popen)',
      steps: [],
    })
    for (const name of [
      'os._exit real', 'os.abort real', 'os.kill real', 'raise_signal real',
      'os.system real', 'Popen real', 'ask_exit gone',
    ]) {
      assert.equal(out[name], 'ok:True', `${name}: ${out[name]}`)
    }
    ran(out, 'shell system')
    ran(out, 'reset')
  })

test('inside a council attempt the ban holds even under a permissive rule',
  { skip: noPython }, () => {
    /*
     * The main property of nesting. A student's attempt runs on the SHARED
     * kernel, and it must not be able to bring the class down even when the
     * teacher of a Python course allowed dangerous commands for a demo. The
     * hold is counted rather than toggled: the rule may be changed in the
     * middle of an attempt.
     */
    const held = ask({
      'os._exit': 'os._exit(0)',
      'shell rm': 'shell.system("rm -rf /")',
      'reset': 'shell.run_line_magic("reset", "-f")',
    }, {
      block: false,
      steps: [`__import__('sys').modules[${JSON.stringify(GUARD_MODULE)}].hold(None)`],
    })
    refused(held, 'os._exit', 'os._exit()')
    refused(held, 'shell rm', 'rm -r /')
    refused(held, 'reset', '%reset')

    const after = ask({
      'os._exit real': 'os._exit is real[0]',
      'shell rm': 'shell.system("rm -rf /")',
    }, {
      block: false,
      setup: 'ns["real"] = (os._exit,)',
      steps: [
        `__import__('sys').modules[${JSON.stringify(GUARD_MODULE)}].hold(None)`,
        `__import__('sys').modules[${JSON.stringify(GUARD_MODULE)}].release()`,
      ],
    })
    assert.equal(after['os._exit real'], 'ok:True', 'after the attempt the replacement stayed under "Allowed"')
    ran(after, 'shell rm')

    // But under the strict rule the exit from the attempt does NOT remove the
    // guard: it is the room's rule, not a property of the attempt.
    const strict = ask({
      'os._exit': 'os._exit(0)',
    }, {
      block: true,
      steps: [
        `__import__('sys').modules[${JSON.stringify(GUARD_MODULE)}].hold(None)`,
        `__import__('sys').modules[${JSON.stringify(GUARD_MODULE)}].release()`,
      ],
    })
    refused(strict, 'os._exit', 'os._exit()')

    // Two holds in a row — and one release does not remove the guard.
    const nested = ask({
      'os._exit': 'os._exit(0)',
    }, {
      block: false,
      steps: [
        `__import__('sys').modules[${JSON.stringify(GUARD_MODULE)}].hold(None)`,
        `__import__('sys').modules[${JSON.stringify(GUARD_MODULE)}].hold(None)`,
        `__import__('sys').modules[${JSON.stringify(GUARD_MODULE)}].release()`,
      ],
    })
    refused(nested, 'os._exit', 'os._exit()')
  })

test('a rule changed in the middle of a class reaches the live kernel both ways',
  { skip: noPython }, () => {
    const loosened = ask({
      'os._exit real': 'os._exit is real[0]',
    }, {
      block: true,
      // The snapshot is BEFORE installation: otherwise our own refusal would
      // pass for "real".
      pre: 'ns["real"] = (os._exit,)',
      steps: [guardPolicySource(false)],
    })
    assert.equal(loosened['os._exit real'], 'ok:True', 'the removed rule did not reach the kernel')

    const tightened = ask({
      'os._exit': 'os._exit(0)',
    }, {
      block: false,
      steps: [guardPolicySource(true)],
    })
    refused(tightened, 'os._exit', 'os._exit()')
  })

test('a child after fork() ends itself with the real os._exit — otherwise multiprocessing does not live',
  { skip: noPython }, () => {
    /*
     * Not a decoration but an obligation: `multiprocessing` and joblib end a
     * child process exactly with `os._exit`, and a refusal in the child would
     * send a copy of the cell running on as a second kernel — a bigger
     * trouble than the one we guard against. It is checked on a real `fork`,
     * not a fake: the child's code is told apart only by the pid.
     */
    const out = ask({
      // The real multiprocessing in full, with a pool and a join.
      'pool works': 'pool_result',
    }, {
      setup: [
        'import multiprocessing',
        'def _square(x):',
        '    return x * x',
        'ns["_square"] = _square',
        'if __name__ == "__main__":',
        '    with multiprocessing.get_context("fork").Pool(2) as p:',
        '        ns["pool_result"] = p.map(_square, [1, 2, 3])',
      ].join('\n'),
    })
    assert.equal(out['pool works'], 'ok:[1, 4, 9]', `the pool did not finish: ${out['pool works']}`)
  })

test('a child after fork() may end itself — checked with a real fork',
  { skip: noPython }, () => {
    const script = [
      'import json, os, sys, types',
      SHELL,
      'ns = {"__builtins__": __builtins__, "__name__": "__main__"}',
      `exec(compile(${JSON.stringify(guardPolicySource(true))}, '<rule>', 'exec'), ns)`,
      'pid = os.fork()',
      'if pid == 0:',
      '    try:',
      '        os._exit(7)',
      '    except BaseException:',
      // A refusal in the child is exactly the trouble: it would send a copy
      // running on.
      '        os.write(2, b"refused in child")',
      '        os._exit(9)',
      'code = os.waitpid(pid, 0)[1] >> 8',
      'print("@@" + json.dumps({"child": code}))',
    ].join('\n')
    const run = spawnSync(python!, ['-'], { input: script, encoding: 'utf8' })
    assert.equal(run.status, 0, `python3 crashed: ${run.stderr}`)
    const line = run.stdout.split('\n').find((l) => l.startsWith('@@'))
    assert.ok(line, `no answer: ${run.stdout} ${run.stderr}`)
    assert.equal(
      JSON.parse(line.slice(2)).child,
      7,
      `the child after fork was refused os._exit: ${run.stderr}`,
    )
  })

test('a repeated installation breaks nothing and does not double the replacements',
  { skip: noPython }, () => {
    /*
     * The rule cell goes to the kernel on every rule change and every
     * start-up; the version check turns the second `exec` into a skip, but
     * `apply` is called anyway. A double replacement would mean a double
     * wrapper and a crooked restore on removal.
     */
    const out = ask({
      'os._exit': 'os._exit(0)',
      'patched once': 'len(mod.saved["store"]) == first',
    }, {
      block: true,
      setup: `ns["mod"] = __import__('sys').modules[${JSON.stringify(GUARD_MODULE)}]\n`
        + 'ns["first"] = len(ns["mod"].saved["store"])',
      steps: [guardPolicySource(true), guardPolicySource(true)],
    })
    refused(out, 'os._exit', 'os._exit()')
    assert.equal(out['patched once'], 'ok:True', `the replacements doubled: ${out['patched once']}`)
  })
