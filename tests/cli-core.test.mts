/**
 * Каркас colloq: разбор argv, диспетчер, отказы, вопрос, вёрстка.
 *
 * Здесь не запускается ни один процесс и не читается ни один настоящий файл:
 * sh подменяется исполнителем, который пишет вызовы в массив, io — картой
 * файлов в памяти, вывод — массивом строк. Тест стережёт ровно те свойства
 * каркаса, на которые опираются пять групп команд: пока они держатся, агент
 * группы правит свой файл и свой тест, и больше ничего.
 */
import './_cli.mjs'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { cli, isMakeTarget, levenshtein, respell, roomsPhrase } from '../cli/src/main.js'
import { GROUPS, registry, type Command } from '../cli/src/registry.js'
import { createEnv, createMemoryIo, SECRET_KEYS } from '../cli/src/env.js'
import { commandLine, exitFromSignal, quote } from '../cli/src/sh.js'
import {
  colorAllowed,
  countWord,
  createUi,
  roomsWord,
  stripAnsi,
  UsageError,
} from '../cli/src/ui.js'

const ROOT = '/repo'

const FILES: Record<string, string> = {
  '/repo/package.json': '{ "name": "colloq", "version": "0.1.0" }',
  '/repo/cli/package.json': '{ "name": "@colloq/cli", "version": "0.1.0" }',
  '/repo/Makefile': ['ps: status', 'status: ## What is running', 'site: ## Pages'].join('\n'),
  '/repo/.env': [
    'PORT=4000',
    'KERNEL_ENV=cv',
    'RELAY_DOMAIN=hse.colloq.ru',
    'VAST_GPU="RTX 4090"',
    'JUPYTER_TOKEN=secret',
  ].join('\n'),
}

type Call = string[]

type Harness = {
  code: number
  out: string[]
  err: string[]
  calls: Call[]
  asked: string[]
}

async function run(
  argv: string[],
  opts: {
    commands?: Command[]
    files?: Record<string, string>
    answer?: string
    /** Очередь ответов: меню спрашивает дважды — пункт, потом аргумент. */
    answers?: string[]
    tty?: boolean
    processEnv?: NodeJS.ProcessEnv
  } = {},
): Promise<Harness> {
  const out: string[] = []
  const err: string[] = []
  const calls: Call[] = []
  const asked: string[] = []
  const io = createMemoryIo({ ...FILES, ...(opts.files ?? {}) }, 1_700_000_000_000)
  const code = await cli(argv, {
    io,
    root: ROOT,
    cwd: ROOT,
    out: (line) => void out.push(line),
    err: (line) => void err.push(line),
    tty: opts.tty ?? false,
    processEnv: opts.processEnv ?? {},
    commands: opts.commands,
    ask:
      opts.answer === undefined && opts.answers === undefined
        ? undefined
        : async (question: string) => {
            asked.push(question)
            if (opts.answers) return opts.answers[asked.length - 1] ?? ''
            return opts.answer as string
          },
    runner: {
      async run(cmd, args) {
        calls.push([cmd, ...args])
        return 0
      },
      async capture(cmd, args) {
        calls.push(['capture', cmd, ...args])
        return { code: 1, stdout: '', stderr: '' }
      },
    },
  })
  return { code, out, err, calls, asked }
}

/** Крошечный реестр: две группы, двухсловное имя, опасная команда. */
function fakeCommands(): Command[] {
  return [
    {
      name: 'ps',
      aliases: ['containers'],
      group: 'local',
      summary: 'What is running',
      usage: 'colloq ps',
      flags: [],
      destructive: false,
      delegates: 'make ps',
      async run(ctx) {
        return await ctx.sh.make('ps')
      },
    },
    {
      name: 'stop',
      group: 'local',
      summary: 'Stop the server',
      usage: 'colloq stop',
      flags: [],
      destructive: true,
      confirm: 'cli',
      confirmQuestion: 'stop the server?',
      delegates: 'make stop',
      async run(ctx) {
        return await ctx.sh.make('stop')
      },
    },
    {
      name: 'vast up',
      group: 'vast',
      summary: 'Rent a machine and deploy a release on it',
      usage: 'colloq vast up <name>',
      args: [{ name: 'name', summary: 'Machine name', required: true }],
      flags: [{ name: 'gpu', arg: 'card', summary: 'Which card to look for' }],
      destructive: true,
      confirm: 'script',
      delegates: 'make vast-up NAME=…',
      async run(ctx) {
        return await ctx.sh.make('vast-up', {
          NAME: ctx.positionals[0],
          GPU: ctx.values.gpu as string | undefined,
        })
      },
    },
    {
      name: 'status',
      group: 'tools',
      summary: 'What is running and how',
      usage: 'colloq status',
      flags: [{ name: 'json', summary: 'Machine-readable output' }],
      destructive: false,
      delegates: 'native: status',
      async run(ctx) {
        if (ctx.json) {
          ctx.ui.json({ ok: true, port: ctx.env.port() })
          return 0
        }
        return await ctx.sh.make('status')
      },
    },
  ]
}

test('имя команды и алиас ведут в одну цель make', async () => {
  const byName = await run(['ps'], { commands: fakeCommands() })
  assert.equal(byName.code, 0)
  assert.deepEqual(byName.calls, [['make', 'ps']])

  const byAlias = await run(['containers'], { commands: fakeCommands() })
  assert.deepEqual(byAlias.calls, [['make', 'ps']])
})

test('двухсловное имя разбирается жадно, аргумент и флаг доезжают', async () => {
  const result = await run(['vast', 'up', 'hse', '--gpu', 'RTX 4090'], {
    commands: fakeCommands(),
  })
  assert.equal(result.code, 0)
  assert.deepEqual(result.calls, [['make', 'vast-up', 'NAME=hse', 'GPU=RTX 4090']])
})

test('пара ВИДА=ЗНАЧЕНИЕ снимается из любого места и уходит make', async () => {
  const result = await run(['FORCE=1', 'ps', 'MODE=consistent'], { commands: fakeCommands() })
  assert.deepEqual(result.calls, [['make', 'ps', 'FORCE=1', 'MODE=consistent']])
})

test('нет обязательного аргумента — код 2 и строка употребления', async () => {
  const result = await run(['vast', 'up'], { commands: fakeCommands() })
  assert.equal(result.code, 2)
  assert.equal(result.calls.length, 0)
  assert.match(result.err.join('\n'), /missing required argument <name>/)
})

test('обязательный аргумент называют и парой: NAME= вместо позиции', async () => {
  const commands = fakeCommands()
  const up = commands.find((command) => command.name === 'vast up')
  if (up?.args?.[0]) up.args[0].makeVar = 'NAME'

  const paired = await run(['vast', 'up', 'NAME=hse'], { commands })
  assert.equal(paired.code, 0)
  assert.deepEqual(paired.calls, [['make', 'vast-up', 'NAME=hse']])
})

test('лишний позиционный — код 2: опечатка не сводится молча к другой команде', async () => {
  const extra = await run(['ps', 'cv'], { commands: fakeCommands() })
  assert.equal(extra.code, 2)
  assert.equal(extra.calls.length, 0)
  assert.match(extra.err.join('\n'), /extra argument: cv/)

  const allowed = fakeCommands()
  const ps = allowed.find((command) => command.name === 'ps')
  if (ps) ps.extra = true
  assert.equal((await run(['ps', 'cv'], { commands: allowed })).code, 0)
})

test('односложный алиас двухсловной команды не съедает значение флага', async () => {
  const commands = fakeCommands()
  const up = commands.find((command) => command.name === 'vast up')
  if (up) up.aliases = ['up']

  const short = await run(['up', '--gpu', 'RTX 4090', 'hse'], { commands })
  assert.equal(short.code, 0)
  assert.deepEqual(short.calls, [['make', 'vast-up', 'NAME=hse', 'GPU=RTX 4090']])
})

test('check срабатывает раньше вопроса: без терминала это код 2, а не 3', async () => {
  const commands = fakeCommands()
  const stop = commands.find((command) => command.name === 'stop')
  if (stop) {
    stop.check = () => {
      throw new UsageError('that is not allowed', 'colloq stop', 'and here is why')
    }
  }
  const result = await run(['stop'], { commands, tty: false })
  assert.equal(result.code, 2)
  assert.deepEqual(result.calls, [])
  assert.deepEqual(result.err, ['✗ that is not allowed', 'and here is why', '→ colloq stop'])
})

test('вопрос бывает функцией от ctx и умеет не считать комнаты', async () => {
  const commands = fakeCommands()
  const stop = commands.find((command) => command.name === 'stop')
  if (stop) {
    stop.confirmQuestion = (ctx) => 'stop ' + (ctx.values.gpu ?? 'the server') + '?'
    stop.flags = [{ name: 'gpu', arg: 'card', summary: 'Which card to look for' }]
    stop.rooms = false
  }
  const result = await run(['stop', '--gpu', 'RTX 4090'], { commands, tty: true, answer: 'n' })
  assert.equal(result.code, 4)
  assert.match(result.asked[0] ?? '', /stop RTX 4090\?/)
  // rooms:false — docker о комнатах не спрашивают вовсе.
  assert.deepEqual(result.calls, [])
})

test('неизвестный флаг — код 2, ничего не запущено', async () => {
  const result = await run(['ps', '--no-such-flag'], { commands: fakeCommands() })
  assert.equal(result.code, 2)
  assert.equal(result.calls.length, 0)
})

test('опечатка во флаге говорит своими словами и подсказывает соседний', async () => {
  const result = await run(['status', '--jsno'], { commands: fakeCommands() })
  assert.equal(result.code, 2)
  assert.deepEqual(result.calls, [])
  const text = result.err.join('\n')
  assert.match(text, /command status has no flag --jsno/)
  assert.match(text, /did you mean --json\?/)
  // Английского текста Node в потоке не остаётся.
  assert.equal(/Unknown option|positional argument/.test(text), false)
})

test('--dry-run печатает одну строку и не порождает ни одного вызова', async () => {
  const result = await run(['vast', 'up', 'hse', '--dry-run'], { commands: fakeCommands() })
  assert.equal(result.code, 0)
  assert.deepEqual(result.calls, [])
  assert.deepEqual(result.out, ['make vast-up NAME=hse'])
})

test('--dry-run не порождает вызовов ни у одной команды настоящего реестра', async () => {
  for (const command of registry) {
    const result = await run([...command.name.split(' '), '--dry-run'], {})
    const spawned = result.calls.filter((call) => call[0] !== 'capture')
    assert.deepEqual(spawned, [], 'команда ' + command.name + ' что-то запустила под --dry-run')
  }
})

test('опасная команда спрашивает, «нет» даёт код 4 и «cancelled»', async () => {
  const result = await run(['stop'], { commands: fakeCommands(), answer: 'n', tty: true })
  assert.equal(result.code, 4)
  assert.deepEqual(result.calls, [
    ['capture', 'docker', 'ps', '--filter', 'label=colloq.kind=room-kernel', '--format', '{{.ID}}'],
  ])
  assert.match(result.asked[0] ?? '', /stop the server\? \[y\/N\]/)
  assert.deepEqual(result.out, ['cancelled'])
})

test('«да» пропускает, --yes снимает вопрос вовсе', async () => {
  const yes = await run(['stop'], { commands: fakeCommands(), answer: 'y', tty: true })
  assert.equal(yes.code, 0)
  assert.ok(yes.calls.some((call) => call[0] === 'make' && call[1] === 'stop'))

  const forced = await run(['stop', '--yes'], { commands: fakeCommands(), tty: true })
  assert.equal(forced.code, 0)
  assert.deepEqual(forced.asked, [])
  assert.deepEqual(forced.calls, [['make', 'stop']])
})

test('confirm:script не спрашивает: скрипт спросит сам', async () => {
  const result = await run(['vast', 'up', 'hse'], { commands: fakeCommands(), tty: true })
  assert.equal(result.code, 0)
  assert.deepEqual(result.asked, [])
})

test('нет терминала и нет --yes — отказ с кодом 3, а не «да»', async () => {
  const result = await run(['stop'], { commands: fakeCommands(), tty: false })
  assert.equal(result.code, 3)
  assert.equal(result.calls.filter((call) => call[0] === 'make').length, 0)
})

test('неизвестная команда — код 2 и одна подсказка по Левенштейну', async () => {
  const result = await run(['statsu'], { commands: fakeCommands() })
  assert.equal(result.code, 2)
  assert.equal(result.calls.length, 0)
  assert.match(result.err.join('\n'), /did you mean colloq status\?/)
})

test('цель Makefile без обёртки не выполняется молча: её зовут явно', async () => {
  const result = await run(['site'], { commands: fakeCommands() })
  assert.equal(result.code, 2)
  assert.deepEqual(result.calls, [])
  assert.match(result.err.join('\n'), /colloq make site/)

  // А слова, которого нет и в Makefile, — обычная подсказка по буквам.
  const typo = await run(['statsu'], { commands: fakeCommands() })
  assert.equal(typo.code, 2)
  assert.match(typo.err.join('\n'), /did you mean colloq status\?/)
})

test('дефисное имя — это сама команда: её проверки, её вопрос, её флаги', async () => {
  const result = await run(['vast-up', 'hse', '--gpu', 'RTX 4090'], { commands: fakeCommands() })
  assert.equal(result.code, 0)
  assert.deepEqual(result.calls, [['make', 'vast-up', 'NAME=hse', 'GPU=RTX 4090']])

  // Настоящий реестр: cluster-stop — тот же cluster stop, и он спрашивает.
  // Без терминала и без --yes это код 3, а не остановленное занятие.
  const cluster = await run(['cluster-stop'], { tty: false })
  assert.equal(cluster.code, 3)
  assert.deepEqual(
    cluster.calls.filter((call) => call[0] === 'make'),
    [],
  )

  const asked = await run(['cluster-stop'], { tty: true, answer: 'n' })
  assert.equal(asked.code, 4)
  assert.match(asked.asked[0] ?? '', /stop the application\?/)
  assert.deepEqual(
    asked.calls.filter((call) => call[0] === 'make'),
    [],
  )

  assert.deepEqual(respell(['vast-up', 'hse'], 'vast-up', 'vast up'), ['vast', 'up', 'hse'])
})

test('--help не выполняет ничего: ни дефисного двойника, ни неизвестного слова', async () => {
  const twin = await run(['cluster-stop', '--help'], { tty: true, answer: 'y' })
  assert.equal(twin.code, 0)
  assert.deepEqual(twin.calls, [])
  assert.match(twin.out.join('\n'), /Usage: colloq cluster stop/)

  const unknown = await run(['release-validate', '--help'], { tty: true, answer: 'y' })
  assert.equal(unknown.code, 0)
  assert.deepEqual(unknown.calls, [])
  assert.match(unknown.out.join('\n'), /Usage: colloq release validate/)

  const nothing = await run(['statsu', '--help'], { commands: fakeCommands(), tty: true })
  assert.equal(nothing.code, 2)
  assert.deepEqual(nothing.calls, [])
  assert.match(nothing.out.join('\n'), /Locally/)
})

test('голое имя группы показывает её команды, а не гадает по буквам', async () => {
  for (const group of ['vast', 'cluster', 'service', 'relay', 'tunnel', 'release']) {
    const result = await run([group], { tty: false })
    assert.equal(result.code, 2, group)
    assert.deepEqual(result.calls, [], group)
    const text = result.err.join('\n')
    assert.match(text, new RegExp(group + ' is a group of commands'), group)
    assert.match(text, new RegExp('colloq ' + group + ' '), group)
    assert.equal(/did you mean/.test(text), false, group)
  }
})

test('--json есть только там, где объявлен', async () => {
  const ok = await run(['status', '--json'], { commands: fakeCommands() })
  assert.equal(ok.code, 0)
  assert.deepEqual(ok.out, ['{"ok":true,"port":4000}'])

  const no = await run(['ps', '--json'], { commands: fakeCommands() })
  assert.equal(no.code, 2)
})

test('bare invocation launches run in either terminal mode; help stays read-only', async () => {
  for (const tty of [false, true]) {
    const result = await run([], { tty })
    assert.equal(result.code, 0)
    assert.deepEqual(result.asked, [])
    assert.deepEqual(result.calls, [['node', '--import', 'tsx', '/repo/cli/src/launch.ts', 'run']])
  }
  const help = await run(['--help'])
  assert.equal(help.code, 0)
  assert.deepEqual(help.calls, [])
  assert.match(help.out.join('\n'), /colloq menu/)
})

test('explicit menu requires terminal, supports help and rejects extra arguments', async () => {
  assert.equal((await run(['menu'])).code, 3)
  const help = await run(['menu', '--help'])
  assert.equal(help.code, 0)
  assert.deepEqual(help.calls, [])
  assert.match(help.out.join('\n'), /colloq menu/)
  assert.equal((await run(['menu', 'run'], { tty: true })).code, 2)
})

test('меню: пять групп, сквозная нумерация, цифра ведёт в команду', async () => {
  const result = await run(['menu'], { commands: fakeCommands(), tty: true, answer: '1' })
  assert.equal(result.code, 0)
  const text = result.out.join('\n')
  assert.match(text, /Locally/)
  assert.match(text, /Machines and releases/)
  assert.match(text, /  1  ps/)
  assert.match(text, /a number and Enter/)
  // Выбран первый пункт — ушла его команда, и ровно она.
  assert.deepEqual(
    result.calls.filter((call) => call[0] === 'make'),
    [['make', 'ps']],
  )
})

test('меню спрашивает только обязательный аргумент и принимает его позицией', async () => {
  const commands = fakeCommands().filter((command) => command.name === 'vast up')
  const result = await run(['menu'], { commands, tty: true, answers: ['1', 'hse'] })
  assert.equal(result.code, 0)
  assert.match(result.asked.at(-1) ?? '', /name\?/)
  assert.deepEqual(
    result.calls.filter((call) => call[0] === 'make'),
    [['make', 'vast-up', 'NAME=hse']],
  )
})

test('меню: умолчание подставляется имени, а не адресу и не окружению ядра', async () => {
  const state = { '/repo/.colloq/state.json': JSON.stringify({ name: 'hse' }) }
  const point: Command = {
    name: 'dns point',
    group: 'host',
    summary: 'Point a name at an address',
    usage: 'colloq dns point <name> <ip>',
    args: [
      { name: 'name', summary: 'Name in the zone', required: true },
      { name: 'ip', summary: 'IPv4', required: true },
    ],
    flags: [],
    destructive: true,
    confirm: 'cli',
    confirmQuestion: 'point it?',
    delegates: 'scripts/dns.sh point',
    async run() {
      return 0
    },
  }
  const dns = await run(['menu'], {
    commands: [point],
    tty: true,
    answers: ['1', 'hse', ''],
    files: state,
  })
  // Первым спрошено имя — ему умолчание есть; адресу его не предлагают вовсе.
  assert.match(dns.asked[1] ?? '', /name\? \[hse\]/)
  assert.match(dns.asked[2] ?? '', /ip\? $/)
  assert.equal(dns.code, 2)

  const build: Command = {
    name: 'env build',
    group: 'env',
    summary: 'Build the environment image',
    usage: 'colloq env build <name>',
    args: [{ name: 'name', summary: 'Environment name', required: true }],
    flags: [],
    destructive: true,
    confirm: 'cli',
    confirmQuestion: 'build it?',
    delegates: 'make env-build NAME=…',
    async run() {
      return 0
    },
  }
  const env = await run(['menu'], {
    commands: [build],
    tty: true,
    answers: ['1', ''],
    files: state,
  })
  // Окружение ядра и среда vast — разные миры: умолчание берётся из .env.
  assert.match(env.asked[1] ?? '', /name\? \[cv\]/)
  assert.equal((env.asked[1] ?? '').includes('hse'), false)
})

test('help по команде показывает употребление и строку делегирования', async () => {
  const result = await run(['vast', 'up', '--help'], { commands: fakeCommands() })
  assert.equal(result.code, 0)
  const text = result.out.join('\n')
  assert.match(text, /Usage: colloq vast up <name>/)
  assert.match(text, /delegates: make vast-up NAME=…/)
})

test('ни одного байта escape, когда цвета нет', async () => {
  const result = await run(['ps'], { commands: fakeCommands(), processEnv: { NO_COLOR: '1' } })
  const text = [...result.out, ...result.err].join('\n')
  assert.equal(text.includes('\u001b'), false)
  assert.equal(colorAllowed({ NO_COLOR: '1' }, true), false)
  assert.equal(colorAllowed({ NO_COLOR: '' }, true), false)
  assert.equal(colorAllowed({}, true), true)
  assert.equal(colorAllowed({}, false), false)
})

test('таблица считает ширину по строке без escape-последовательностей', () => {
  const out: string[] = []
  const ui = createUi({ color: true, out: (line) => void out.push(line) })
  ui.table([
    [ui.cyan('ps'), 'what is running'],
    ['vast up', 'rent a machine'],
  ])
  const plain = out.map(stripAnsi)
  assert.deepEqual(plain, ['  ps       what is running', '  vast up  rent a machine'])
})

test('kv и hint держат отступы, а пояснение отделено точкой и без цвета', () => {
  const out: string[] = []
  const ui = createUi({ out: (line) => void out.push(line) })
  ui.kv('port', '4000')
  ui.kv('environment', 'cv', 'switch: colloq env use <name>')
  ui.hint('to change it: PORT in .env')
  assert.deepEqual(out, [
    '  port        4000',
    '  environment cv · switch: colloq env use <name>',
    '      → to change it: PORT in .env',
  ])
})

test('отказ — ровно три строки в stderr', () => {
  const err: string[] = []
  const ui = createUi({ err: (line) => void err.push(line) })
  ui.refuse('no docker', 'without it a room has nowhere to compute', 'install docker and repeat')
  assert.deepEqual(err, [
    '✗ no docker',
    'without it a room has nowhere to compute',
    '→ install docker and repeat',
  ])
})

test('json гасит весь остальной вывод', () => {
  const out: string[] = []
  const err: string[] = []
  const ui = createUi({
    json: true,
    out: (line) => void out.push(line),
    err: (line) => void err.push(line),
  })
  ui.header('State')
  ui.refuse('no .env', '', 'copy .env.example')
  assert.deepEqual(err, [])
  assert.deepEqual(out, ['{"ok":false,"code":3,"error":"no .env","hint":"copy .env.example"}'])
})

test('.env читается как в scripts/lib.sh: края обрезаются, внутренность нет', () => {
  const env = createEnv({ io: createMemoryIo(FILES), root: ROOT, cwd: ROOT, processEnv: {} })
  assert.equal(env.port(), 4000)
  assert.equal(env.kernelEnv(), 'cv')
  assert.equal(env.read('VAST_GPU'), 'RTX 4090')
  assert.equal(env.relay().domain, 'hse.colloq.ru')
  assert.equal(env.relay().port, 7000)
})

test('read на секретном ключе бросает, has отвечает', () => {
  const env = createEnv({ io: createMemoryIo(FILES), root: ROOT, cwd: ROOT, processEnv: {} })
  for (const key of SECRET_KEYS) {
    assert.throws(() => env.read(key), new RegExp(key))
  }
  assert.equal(env.has('JUPYTER_TOKEN'), true)
  assert.equal(env.has('CF_TOKEN'), false)
})

test('userPath считается от каталога человека, не от корня', () => {
  const env = createEnv({
    io: createMemoryIo(FILES),
    root: ROOT,
    cwd: '/home/a/class',
    processEnv: {},
  })
  assert.equal(env.userPath('./release.json'), '/home/a/class/release.json')
  assert.equal(env.userPath('/tmp/release.json'), '/tmp/release.json')
})

test('состояние пишется и читается', () => {
  const io = createMemoryIo(FILES)
  const env = createEnv({ io, root: ROOT, cwd: ROOT, processEnv: {} })
  env.writeState({ name: 'hse', last: { code: 0 } })
  assert.equal(env.readState().name, 'hse')
  env.writeState({ last: { code: 2 } })
  assert.equal(env.readState().name, 'hse')
  assert.equal(env.readState().last?.code, 2)
})

test('память об аренде переживает любую следующую команду', async () => {
  const io = createMemoryIo(FILES, 1_700_000_000_000)
  const env = createEnv({ io, root: ROOT, cwd: ROOT, processEnv: {} })
  env.writeState({ name: 'hse', gpu: 'RTX 4090' })
  await cli(['ps'], {
    io,
    root: ROOT,
    cwd: ROOT,
    out: () => {},
    err: () => {},
    processEnv: {},
    commands: fakeCommands(),
    runner: {
      async run() {
        return 0
      },
      async capture() {
        return { code: 1, stdout: '', stderr: '' }
      },
    },
  })
  const after = env.readState()
  assert.equal(after.name, 'hse')
  assert.equal(after.gpu, 'RTX 4090')
  assert.equal(after.last?.command, 'ps')
})

test('строка --dry-run квотируется безопасно и не подставляет .env', () => {
  assert.equal(quote('hse.colloq.ru'), 'hse.colloq.ru')
  assert.equal(quote('RTX 4090'), "'RTX 4090'")
  assert.equal(quote(''), "''")
  assert.equal(
    commandLine('make', ['host', 'HOST=hse.colloq.ru'], { KERNEL_ENV: 'cv' }),
    'KERNEL_ENV=cv make host HOST=hse.colloq.ru',
  )
})

test('сигнал у ребёнка — 128 + номер: 130 остаётся ровно за Ctrl+C', () => {
  assert.equal(exitFromSignal('SIGINT'), 130)
  assert.equal(exitFromSignal('SIGKILL'), 137)
  assert.equal(exitFromSignal('SIGTERM'), 143)
})

test('вспомогательное: Левенштейн, цель Makefile, счёт комнат', () => {
  assert.equal(levenshtein('statsu', 'status'), 2)
  assert.equal(isMakeTarget(FILES['/repo/Makefile'] as string, 'status'), true)
  assert.equal(isMakeTarget(FILES['/repo/Makefile'] as string, 'nope'), false)
  assert.equal(roomsPhrase(1), '1 room is running')
  assert.equal(roomsPhrase(3), '3 rooms are running')
  assert.equal(roomsPhrase(5), '5 rooms are running')
  assert.equal(roomsPhrase(11), '11 rooms are running')
  // Слово одно на весь CLI: каркас и «Инструменты» считают его одинаково.
  assert.equal(roomsWord(1), '1 room')
  assert.equal(roomsWord(3), '3 rooms')
  assert.equal(roomsWord(11), '11 rooms')
  // Правило счёта тоже одно, и оно не про комнаты: пакеты в списке окружений
  // считаются тем же помощником, а не вторым его списыванием.
  assert.equal(countWord(0, 'package'), '0 packages')
  assert.equal(countWord(1, 'package'), '1 package')
  assert.equal(countWord(2, 'package'), '2 packages')
  assert.equal(countWord(21, 'package'), '21 packages')
  // Неправильное множественное называется вторым словом, иначе вышло бы
  // «classs»: 's' — умолчание, а не правило.
  assert.equal(countWord(1, 'class', 'classes'), '1 class')
  assert.equal(countWord(2, 'class', 'classes'), '2 classes')
})

test('реестр: имена и алиасы уникальны, группа известна', () => {
  const seen = new Set<string>()
  const groups = new Set(GROUPS.map((group) => group.name))
  for (const command of registry) {
    for (const name of [command.name, ...(command.aliases ?? [])]) {
      assert.equal(seen.has(name), false, 'имя занято дважды: ' + name)
      seen.add(name)
    }
    assert.ok(groups.has(command.group), 'чужая группа у ' + command.name)
  }
})

test('реестр: usage называет каждый флаг команды', () => {
  for (const command of registry) {
    for (const flag of command.flags) {
      const named =
        command.usage.includes('--' + flag.name) ||
        (flag.short !== undefined && command.usage.includes('-' + flag.short))
      assert.ok(named, 'флаг --' + flag.name + ' не назван в usage: ' + command.name)
    }
  }
})

test('реестр: summary по-английски, usage с «colloq », delegates не пуст', () => {
  for (const command of registry) {
    assert.match(command.summary, /[A-Za-z]/, 'summary без единой буквы: ' + command.name)
    assert.doesNotMatch(command.summary, /[а-яА-ЯёЁ]/, 'summary не по-английски: ' + command.name)
    assert.ok(command.usage.startsWith('colloq '), 'usage без colloq: ' + command.name)
    assert.notEqual(command.delegates.trim(), '', 'нет delegates: ' + command.name)
    assert.ok(command.name.length <= 18, 'имя не влезет в help: ' + command.name)
  }
})

test('реестр: у опасной команды есть вопрос или тот, кто спросит вместо нас', () => {
  for (const command of registry) {
    if (!command.destructive) continue
    const ok =
      command.confirm === 'script' ||
      command.confirm === 'self' ||
      (command.confirm === 'cli' && Boolean(command.confirmQuestion))
    assert.ok(ok, 'опасная команда без вопроса: ' + command.name)
  }
})

test('модули групп не открывают дверь к процессам и файлам мимо ctx', () => {
  for (const group of ['local', 'host', 'vast', 'env', 'tools']) {
    const source = readFileSync(
      new URL('../cli/src/commands/' + group + '.ts', import.meta.url),
      'utf8',
    )
    const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*/g, '')
    assert.equal(/process\.env/.test(code), false, group + ': process.env мимо ctx')
    assert.equal(/node:child_process/.test(code), false, group + ': node:child_process')
    assert.equal(/node:fs/.test(code), false, group + ': node:fs')
    assert.equal(/from 'node:/.test(code), false, group + ': импорт node: мимо ctx')
  }
})
