/**
 * Опасные команды в ячейке — снизу, со стороны Python.
 *
 * Беда, ради которой всё это заведено, случилась на живом занятии 20.09.2026:
 * студент написал в попытке консилиума `import os` и `os._exit(0)`, а
 * преподаватель, перебирая работы и нажимая «запустить», девять раз за
 * одиннадцать минут уронил ядро комнаты на тридцать человек. Такую смерть не
 * отличить от исправной работы ничем — ни трассировки, ни сигнала в dmesg, ни
 * счётчика в cgroup, ни строки в журнале.
 *
 * Поэтому здесь проверяется не форма исходника, а ПОВЕДЕНИЕ: тот же кусок
 * Python, что уезжает в ядро комнаты, исполняется настоящим `python3` рядом с
 * поддельной оболочкой IPython (ровно те крючки, что подменяет защита), и на
 * нём вызывается то, что студент наберёт из любопытства.
 *
 * У каждого запрета — пара: «это блокируется» и «а это нет». Вторая половина
 * важнее первой. Граница должна быть узкой, иначе занятие сломается тише, чем
 * падало ядро: `git`, `pip`, `ls`, `subprocess`, `kill` собственного фонового
 * процесса и `os.kill` по чужому ребёнку обязаны работать, иначе joblib,
 * multiprocessing и половина семинара перестают считать без единого слова.
 *
 * `python3` может не оказаться (CI без Python, чужая машина) — тогда нижняя
 * половина пропускается, а верхняя, про сборку исходника и разбор отчёта,
 * остаётся: она чистая.
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

/* ------------------------------------------------------------- исходники */

test('установка — одна строка со сверкой версии, и она не связывает имён', () => {
  const source = guardPolicySource(true)
  const lines = source.split('\n')
  assert.equal(lines.length, 2, 'ячейка правила перестала быть двумя выражениями')
  /*
   * Ни одного присваивания на верхнем уровне: весь модуль живёт в `__dict__`
   * скрытого модуля, и в пространстве студента после установки не остаётся ни
   * `os`, ни `sys`, ни единой нашей переменной.
   */
  for (const line of lines) {
    assert.doesNotMatch(line, /^[A-Za-z_][A-Za-z0-9_]*\s*=[^=]/, `защита связала имя: ${line.slice(0, 40)}`)
    assert.doesNotMatch(line, /^(import|from|def|class)\s/, `защита связала имя: ${line.slice(0, 40)}`)
  }
  assert.match(lines[0], /^if getattr\(__import__\('sys'\)\.modules\.get\(/)
  assert.match(lines[0], /'version', None\) != "[0-9a-f]{12}": exec\(compile\(/)
  assert.ok(lines[0].includes(JSON.stringify(GUARD_MODULE)))
  // Версия внутри исходника и версия в сверке — одна и та же строка, иначе
  // модуль переустанавливался бы на каждой ячейке и молча.
  const stamp = /!= "([0-9a-f]{12})"/.exec(lines[0])![1]
  assert.ok(lines[0].includes(`version = '${stamp}'`), 'версия в исходнике другая')
  // Булево — словом Python: `false` в ядре не значение, а NameError.
  assert.match(lines[1], /\.apply\(True, \{/)
  assert.match(guardPolicySource(false), /\.apply\(False, \{/)
  assert.doesNotMatch(source, /\b(false|true|null)\b/)
})

test('строка правила и есть отпечаток: правило и язык меняют её, прочее — нет', () => {
  /*
   * По ней сервер решает, ходить ли в ядро (kernel/index.ts · Runtime.guard).
   * Совпади она при разном правиле — ядро жило бы по вчерашнему; разойдись на
   * пустом месте — лишний поход на каждую ячейку.
   */
  setLocaleResolver(() => 'ru')
  const blocked = guardPolicySource(true)
  assert.equal(guardPolicySource(true), blocked, 'один и тот же вопрос дал разные строки')
  assert.notEqual(guardPolicySource(false), blocked, 'правило не видно в строке')
  setLocaleResolver(() => 'en')
  assert.notEqual(guardPolicySource(true), blocked, 'язык отказа не виден в строке')
  setLocaleResolver(() => 'ru')
})

test('отказ говорит, что не выполнено, почему и кто это может разрешить', () => {
  setLocaleResolver(() => 'ru')
  const room = guardRoomSettings()
  assert.ok(room.includes('{p0}'), 'в отказе нет места под саму команду')
  assert.match(room, /опасная команда/)
  assert.match(room, /гасит ядро/)
  assert.match(room, /стирает переменные/)
  assert.match(room, /правило «Опасные команды»/)
  /*
   * А внутри попытки консилиума разрешить это не может никто: попытка идёт на
   * общем ядре, и совет «попросите преподавателя» был бы неправдой.
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

test('имя исключения одно на защиту и на консилиум — второй копии отказа нет', () => {
  assert.equal(COLLOQ_REFUSED, 'ColloqRefused')
  assert.equal(COUNCIL_REFUSED, COLLOQ_REFUSED)
  assert.ok(GUARD_REPORT_EXPR.includes(GUARD_MODULE))
  assert.ok(guardHoldExpr().includes('.hold('))
  assert.ok(GUARD_RELEASE_EXPR.includes('.release()'))
})

/* ----------------------------------------------------------------- отчёт */

test('отчёт читается из mimebundle, а всё непонятное — это «не подтверждено»', () => {
  const body = { ok: true, on: true, policy: true, holds: 0, patched: ['_exit'] }
  const bundle = { status: 'ok', data: { 'text/plain': JSON.stringify(body) }, metadata: {} }
  const parsed = parseGuardReport(bundle)
  assert.equal(parsed?.ok, true)
  assert.equal(parsed?.policy, true)
  assert.deepEqual(parsed?.patched, ['_exit'])
  // Та же строка без обёртки — так её читает тест, гоняющий python3 напрямую.
  assert.equal(parseGuardReport(JSON.stringify(body))?.on, true)
  /*
   * Всё остальное — `null`, и это главное свойство разбора: сервер по нему
   * решает НЕ исполнять ячейку. Пустой объект — ровно то, что приезжает от
   * ядра, когда установка упала: user_expressions на упавшем запуске не
   * считаются.
   */
  assert.equal(parseGuardReport({}), null, 'пустой ответ сошёл за подтверждение')
  assert.equal(parseGuardReport({ status: 'error' }), null)
  assert.equal(parseGuardReport('None'), null)
  assert.equal(parseGuardReport('не json'), null)
  assert.equal(parseGuardReport(JSON.stringify({ on: true })), null, 'отчёт без ok сошёл за ответ')
})

/* ------------------------------------------------- настоящий python3 */

const python = (() => {
  const probe = spawnSync('python3', ['-c', 'import sys; print(sys.version_info[0])'], {
    encoding: 'utf8',
  })
  return probe.status === 0 ? 'python3' : null
})()
const noPython = python ? false : 'нет python3'

/**
 * Поддельная оболочка IPython — ровно те крючки, которые подменяет защита.
 *
 * Своя, а не настоящая: ipykernel в тестовом окружении нет, а проверять надо
 * не его, а нашу подмену. Крючки названы теми же именами, что в
 * `InteractiveShell`, и потому подмена встаёт на них так же, как в живом ядре
 * (что она встаёт и там — проверено вживую, в одноразовом контейнере из
 * образа `colloq-kernel:base`).
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
  /** Что спросить у ядра — выражение Python. */
  [name: string]: string
}

/**
 * Один прогон настоящим python3: поставить правило, спросить про каждый случай.
 *
 * Ответ на случай — либо `ok:<repr>`, либо имя исключения. Разбираются они
 * потом помощниками `refused` и `ran`, чтобы в самих тестах читалось не
 * «равно строке», а «отказано» и «выполнилось».
 */
function ask(
  asks: Ask,
  /** `pre` считается ДО объявления правила: им снимают снимок настоящих функций. */
  opts: { block?: boolean; steps?: string[]; setup?: string; pre?: string } = {},
): Record<string, string> {
  const script = [
    'import json, os, signal, subprocess, sys, types',
    SHELL,
    // Модули кладутся в `ns` руками: это замена `user_ns` ядра, где `import os`
    // студента их туда и приносит.
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
   * Ноль здесь — половина проверки. Незакрытый `os._exit(0)` кончает процесс
   * БЕЗ единого слова и с кодом 0: тест, который смотрел бы только на
   * отсутствие исключения, прошёл бы именно в тот день, когда защита отвалилась.
   * Поэтому ответ обязан ДОЕХАТЬ строкой.
   */
  assert.equal(run.status, 0, `python3 упал: ${run.stderr}`)
  const line = run.stdout.split('\n').find((l) => l.startsWith('@@'))
  assert.ok(line, `ответа нет — процесс кончился молча: ${run.stdout} ${run.stderr}`)
  return JSON.parse(line.slice(2))
}

/** Отказано нашим исключением — и в тексте есть имя самой команды. */
function refused(out: Record<string, string>, name: string, named: string): void {
  assert.match(out[name] ?? '', new RegExp(`^${COLLOQ_REFUSED}: `), `«${name}» не отказано: ${out[name]}`)
  assert.ok(
    (out[name] ?? '').includes(named),
    `отказ по «${name}» не назвал саму команду (${named}): ${out[name]}`,
  )
}

/** Выполнилось как ни в чём не бывало. */
function ran(out: Record<string, string>, name: string): void {
  assert.match(out[name] ?? '', /^ok:/, `«${name}» не выполнилось: ${out[name]}`)
}

test('конец процесса и конец ядра закрыты — всеми известными способами',
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
    // И само подтверждение: сервер читает именно его и молчание считает отказом.
    const report = JSON.parse(out['@report'])
    assert.equal(report.ok, true)
    assert.equal(report.policy, true)
    assert.ok(report.patched.includes('_exit'), 'os._exit не подменён, а отчёт говорит «ok»')
  })

test('sys.exit, чужой процесс и безобидный сигнал проходят — иначе сломан joblib',
  { skip: noPython }, () => {
    const out = ask({
      // В ipykernel это SystemExit, и ядро его переживает: трогать нечего.
      'sys.exit': 'sys.exit(3)',
      // Сигнал 0 — это «жив ли», а не убийство.
      'probe alive': 'os.kill(os.getpid(), 0)',
      // Чужой ребёнок: так управляют процессами subprocess, joblib и пулы.
      'kill child': 'os.kill(sub.pid, signal.SIGTERM) or sub.wait()',
      // Не смертельный сигнал самому себе — обычная работа с окнами и таймерами.
      'own SIGWINCH': 'os.kill(os.getpid(), signal.SIGWINCH)',
    }, {
      setup: 'ns["sub"] = subprocess.Popen([sys.executable, "-c", "import time; time.sleep(5)"],'
        + ' stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)',
    })
    assert.match(out['sys.exit'] ?? '', /^SystemExit/, `sys.exit тронули: ${out['sys.exit']}`)
    ran(out, 'probe alive')
    ran(out, 'kill child')
    ran(out, 'own SIGWINCH')
  })

test('команды оболочки: закрыто только то, что гасит ядро или сносит занятие',
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

      // …и ровно столько же случаев «а это работает».
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
    assert.equal(out['popen subclass'], 'ok:True', 'подмена Popen сломала isinstance')
  })

test('%reset и %xdel стирают переменные у всех — и потому закрыты, а прочие магии нет',
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
    // Причина у этих трёх своя: не «гасит ядро», а «стирает переменные».
    assert.match(out['reset'] ?? '', /стирает переменные/)
  })

test('правило «исполняются» возвращает НАСТОЯЩИЕ функции, а не тихо не мешает',
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
       * Снимок берётся ДО установки — то есть настоящие функции, — и правило
       * «исполняются» обязано вернуть ровно их. Оставленная подмена сломала бы
       * `multiprocessing` всей комнате и уже не на одну ячейку, а навсегда.
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

test('в попытке консилиума запрет действует и при разрешающем правиле',
  { skip: noPython }, () => {
    /*
     * Главное свойство вложенности. Попытка студента идёт на ОБЩЕМ ядре, и
     * уронить им класс нельзя даже тогда, когда преподаватель курса по Python
     * разрешил опасные команды ради показа. Удержание считается, а не
     * переключает: правило могут поменять посреди попытки.
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
    assert.equal(after['os._exit real'], 'ok:True', 'после попытки подмена осталась при «исполняются»')
    ran(after, 'shell rm')

    // А при строгом правиле выход из попытки защиту НЕ снимает: она правило
    // комнаты, а не свойство попытки.
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

    // Два удержания подряд — и одно освобождение защиту не снимает.
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

test('правило, поменянное посреди пары, доезжает до живого ядра в обе стороны',
  { skip: noPython }, () => {
    const loosened = ask({
      'os._exit real': 'os._exit is real[0]',
    }, {
      block: true,
      // Снимок — ДО установки: иначе «настоящим» оказался бы наш же отказ.
      pre: 'ns["real"] = (os._exit,)',
      steps: [guardPolicySource(false)],
    })
    assert.equal(loosened['os._exit real'], 'ok:True', 'снятое правило не доехало до ядра')

    const tightened = ask({
      'os._exit': 'os._exit(0)',
    }, {
      block: false,
      steps: [guardPolicySource(true)],
    })
    refused(tightened, 'os._exit', 'os._exit()')
  })

test('ребёнок после fork() кончает себя настоящим os._exit — иначе не живёт multiprocessing',
  { skip: noPython }, () => {
    /*
     * Не украшение, а обязательство: `multiprocessing` и joblib заканчивают
     * дочерний процесс именно `os._exit`, и отказ в ребёнке пустил бы копию
     * ячейки бежать дальше вторым ядром — беда крупнее той, от которой
     * защищаемся. Проверяется на настоящем `fork`, а не на подделке: код
     * ребёнка отличает только pid.
     */
    const out = ask({
      // Настоящий multiprocessing целиком, с пулом и джойном.
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
    assert.equal(out['pool works'], 'ok:[1, 4, 9]', `пул не досчитал: ${out['pool works']}`)
  })

test('ребёнок после fork() вправе кончить себя — проверено настоящим fork',
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
      // Отказ в ребёнке — это и есть беда: он пустил бы копию бежать дальше.
      '        os.write(2, b"refused in child")',
      '        os._exit(9)',
      'code = os.waitpid(pid, 0)[1] >> 8',
      'print("@@" + json.dumps({"child": code}))',
    ].join('\n')
    const run = spawnSync(python!, ['-'], { input: script, encoding: 'utf8' })
    assert.equal(run.status, 0, `python3 упал: ${run.stderr}`)
    const line = run.stdout.split('\n').find((l) => l.startsWith('@@'))
    assert.ok(line, `нет ответа: ${run.stdout} ${run.stderr}`)
    assert.equal(
      JSON.parse(line.slice(2)).child,
      7,
      `ребёнку после fork отказали в os._exit: ${run.stderr}`,
    )
  })

test('повторная установка ничего не ломает и не удваивает подмены',
  { skip: noPython }, () => {
    /*
     * Ячейка правила уезжает в ядро на каждую смену правила и на каждый
     * подъём; сверка версии делает второй `exec` пропуском, но `apply`
     * вызывается всё равно. Двойная подмена означала бы двойную обёртку и
     * кривой возврат при снятии.
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
    assert.equal(out['patched once'], 'ok:True', `подмены удвоились: ${out['patched once']}`)
  })
