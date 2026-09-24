/**
 * The colloq framework: argv parsing, the dispatcher, refusals, the question,
 * output layout.
 *
 * No process is started here and no real file is read: sh is replaced by an
 * executor that writes calls into an array, io by an in-memory file map,
 * output by an array of lines. The test guards exactly those properties of the
 * framework that the four command groups rely on.
 */
import './_cli.mjs'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { cli, levenshtein, respell, roomsPhrase } from '../cli/src/main.js'
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
      opts.answer === undefined
        ? undefined
        : async (question: string) => {
            asked.push(question)
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

/** A tiny registry: three groups, a two-word name, a destructive command. */
function fakeCommands(): Command[] {
  return [
    {
      name: 'logs',
      aliases: ['log'],
      group: 'local',
      summary: 'Watch the log',
      usage: 'colloq logs',
      flags: [],
      destructive: false,
      delegates: 'tail -f .colloq.log',
      async run(ctx) {
        return await ctx.sh.run('tail', ['-f', '.colloq.log'])
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
      delegates: './scripts/stop.sh',
      async run(ctx) {
        return await ctx.sh.script('./scripts/stop.sh')
      },
    },
    {
      name: 'env use',
      group: 'env',
      summary: 'Make an environment the default',
      usage: 'colloq env use <name> [--python <version>]',
      args: [{ name: 'name', summary: 'Environment name', required: true }],
      flags: [{ name: 'python', arg: 'version', summary: 'Which Python' }],
      destructive: true,
      confirm: 'script',
      delegates: './scripts/env.sh <name>',
      async run(ctx) {
        const python = ctx.values.python as string | undefined
        return await ctx.sh.script('./scripts/env.sh', [
          ctx.positionals[0] ?? '',
          ...(python ? ['--python', python] : []),
        ])
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
        return await ctx.sh.run('ps', [])
      },
    },
  ]
}

test("a command's name and its alias lead to the same call", async () => {
  const byName = await run(['logs'], { commands: fakeCommands() })
  assert.equal(byName.code, 0)
  assert.deepEqual(byName.calls, [['tail', '-f', '.colloq.log']])

  const byAlias = await run(['log'], { commands: fakeCommands() })
  assert.deepEqual(byAlias.calls, [['tail', '-f', '.colloq.log']])
})

test('a two-word name is parsed greedily, and the argument and the flag get through', async () => {
  const result = await run(['env', 'use', 'cv', '--python', '3.12'], {
    commands: fakeCommands(),
  })
  assert.equal(result.code, 0)
  assert.deepEqual(result.calls, [['./scripts/env.sh', 'cv', '--python', '3.12']])
})

test('a missing required argument gives code 2 and the usage line', async () => {
  const result = await run(['env', 'use'], { commands: fakeCommands() })
  assert.equal(result.code, 2)
  assert.equal(result.calls.length, 0)
  assert.match(result.err.join('\n'), /missing required argument <name>/)
})

test('an extra positional gives code 2: a typo does not silently turn into another command', async () => {
  const extra = await run(['logs', 'cv'], { commands: fakeCommands() })
  assert.equal(extra.code, 2)
  assert.equal(extra.calls.length, 0)
  assert.match(extra.err.join('\n'), /extra argument: cv/)
})

test('a KEY=VALUE pair is an ordinary word: nobody strips it or passes it on', async () => {
  const pair = await run(['logs', 'MODE=consistent'], { commands: fakeCommands() })
  assert.equal(pair.code, 2)
  assert.deepEqual(pair.calls, [])
  assert.match(pair.err.join('\n'), /extra argument: MODE=consistent/)
})

test("a one-word alias of a two-word command does not eat a flag's value", async () => {
  const commands = fakeCommands()
  const use = commands.find((command) => command.name === 'env use')
  if (use) use.aliases = ['use']

  const short = await run(['use', '--python', '3.12', 'cv'], { commands })
  assert.equal(short.code, 0)
  assert.deepEqual(short.calls, [['./scripts/env.sh', 'cv', '--python', '3.12']])
})

test('check fires before the question: without a terminal it is code 2, not 3', async () => {
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

test('the question can be a function of ctx and can skip counting rooms', async () => {
  const commands = fakeCommands()
  const stop = commands.find((command) => command.name === 'stop')
  if (stop) {
    stop.confirmQuestion = (ctx) => 'stop ' + (ctx.values.port ?? 'the server') + '?'
    stop.flags = [{ name: 'port', arg: 'port', summary: 'Which port' }]
    stop.rooms = false
  }
  const result = await run(['stop', '--port', '4100'], { commands, tty: true, answer: 'n' })
  assert.equal(result.code, 4)
  assert.match(result.asked[0] ?? '', /stop 4100\?/)
  // rooms:false: docker is not asked about rooms at all.
  assert.deepEqual(result.calls, [])
})

test('an unknown flag gives code 2, nothing is started', async () => {
  const result = await run(['logs', '--no-such-flag'], { commands: fakeCommands() })
  assert.equal(result.code, 2)
  assert.equal(result.calls.length, 0)
})

test('a flag typo is reported in our own words and suggests the nearest flag', async () => {
  const result = await run(['status', '--jsno'], { commands: fakeCommands() })
  assert.equal(result.code, 2)
  assert.deepEqual(result.calls, [])
  const text = result.err.join('\n')
  assert.match(text, /command status has no flag --jsno/)
  assert.match(text, /did you mean --json\?/)
  // None of Node's own English text is left in the stream.
  assert.equal(/Unknown option|positional argument/.test(text), false)
})

test('--dry-run prints one line and spawns no calls', async () => {
  const result = await run(['env', 'use', 'cv', '--dry-run'], { commands: fakeCommands() })
  assert.equal(result.code, 0)
  assert.deepEqual(result.calls, [])
  assert.deepEqual(result.out, ['./scripts/env.sh cv'])
})

test('--dry-run spawns no calls for any command of the real registry', async () => {
  for (const command of registry) {
    const result = await run([...command.name.split(' '), '--dry-run'], {})
    const spawned = result.calls.filter((call) => call[0] !== 'capture')
    assert.deepEqual(spawned, [], 'command ' + command.name + ' started something under --dry-run')
  }
})

test('a destructive command asks; "no" gives code 4 and "cancelled"', async () => {
  const result = await run(['stop'], { commands: fakeCommands(), answer: 'n', tty: true })
  assert.equal(result.code, 4)
  assert.deepEqual(result.calls, [
    // CLASSES are counted, not containers: one class has two of them (pool.ts ·
    // KernelRole).
    ['capture', 'docker', 'ps', '--filter', 'label=colloq.kind=room-kernel', '--format', '{{.Label "colloq.session"}}'],
  ])
  assert.match(result.asked[0] ?? '', /stop the server\? \[y\/N\]/)
  assert.deepEqual(result.out, ['cancelled'])
})

test('"yes" lets it through, --yes removes the question altogether', async () => {
  const yes = await run(['stop'], { commands: fakeCommands(), answer: 'y', tty: true })
  assert.equal(yes.code, 0)
  assert.ok(yes.calls.some((call) => call[0] === './scripts/stop.sh'))

  const forced = await run(['stop', '--yes'], { commands: fakeCommands(), tty: true })
  assert.equal(forced.code, 0)
  assert.deepEqual(forced.asked, [])
  assert.deepEqual(forced.calls, [['./scripts/stop.sh']])
})

test('confirm:script does not ask: the script will ask itself', async () => {
  const result = await run(['env', 'use', 'cv'], { commands: fakeCommands(), tty: true })
  assert.equal(result.code, 0)
  assert.deepEqual(result.asked, [])
})

test('no terminal and no --yes means a refusal with code 3, not "yes"', async () => {
  const result = await run(['stop'], { commands: fakeCommands(), tty: false })
  assert.equal(result.code, 3)
  assert.equal(result.calls.filter((call) => call[0] !== 'capture').length, 0)
})

test('an unknown command gives code 2 and one Levenshtein suggestion', async () => {
  const result = await run(['statsu'], { commands: fakeCommands() })
  assert.equal(result.code, 2)
  assert.equal(result.calls.length, 0)
  assert.match(result.err.join('\n'), /did you mean colloq status\?/)
})

test('the hyphenated name is the command itself: its checks, its question, its flags', async () => {
  const result = await run(['env-use', 'cv', '--python', '3.12'], { commands: fakeCommands() })
  assert.equal(result.code, 0)
  assert.deepEqual(result.calls, [['./scripts/env.sh', 'cv', '--python', '3.12']])

  const missing = await run(['env-use'], { commands: fakeCommands() })
  assert.equal(missing.code, 2)
  assert.match(missing.err.join('\n'), /missing required argument <name>/)

  assert.deepEqual(respell(['env-use', 'cv'], 'env-use', 'env use'), ['env', 'use', 'cv'])
})

test('--help runs nothing: neither the hyphenated twin nor an unknown word', async () => {
  const twin = await run(['env-use', '--help'], { tty: true, answer: 'y' })
  assert.equal(twin.code, 0)
  assert.deepEqual(twin.calls, [])
  assert.match(twin.out.join('\n'), /Usage: colloq env use/)

  const nothing = await run(['statsu', '--help'], { commands: fakeCommands(), tty: true })
  assert.equal(nothing.code, 2)
  assert.deepEqual(nothing.calls, [])
  assert.match(nothing.out.join('\n'), /Locally/)
})

test("a bare group name shows the group's commands instead of guessing by letters", async () => {
  const result = await run(['env'], { commands: fakeCommands(), tty: false })
  assert.equal(result.code, 2)
  assert.deepEqual(result.calls, [])
  const text = result.err.join('\n')
  assert.match(text, /env is a group of commands/)
  assert.match(text, /colloq env use/)
  assert.equal(/did you mean/.test(text), false)
})

test('--json exists only where it is declared', async () => {
  const ok = await run(['status', '--json'], { commands: fakeCommands() })
  assert.equal(ok.code, 0)
  assert.deepEqual(ok.out, ['{"ok":true,"port":4000}'])

  const no = await run(['logs', '--json'], { commands: fakeCommands() })
  assert.equal(no.code, 2)
})

test('a bare call starts nothing: three lines about what lives here', async () => {
  for (const tty of [false, true]) {
    const result = await run([], { tty })
    assert.equal(result.code, 0)
    assert.deepEqual(result.asked, [])
    assert.deepEqual(result.calls, [])
    const text = result.out.join('\n')
    assert.match(text, /colloq start/)
    assert.match(text, /colloq host <name>/)
    assert.match(text, /colloq stop/)
  }
  const help = await run(['--help'])
  assert.equal(help.code, 0)
  assert.deepEqual(help.calls, [])
  assert.match(help.out.join('\n'), /Most used: colloq start/)
})

test("help lists exactly the teacher's commands, without the workshop and the menu", async () => {
  const result = await run(['help'])
  assert.equal(result.code, 0)
  const text = result.out.join('\n')
  for (const title of ['Locally', 'Class online', 'Kernel environments', 'Tools']) {
    assert.match(text, new RegExp(title))
  }
  for (const gone of ['vast', 'cluster', 'relay', 'menu', 'colloq make', 'colloq dev']) {
    assert.equal(text.includes(gone), false, gone)
  }
  assert.equal((await run(['menu'])).code, 2)
})

test('help for a command shows the usage and the delegation line', async () => {
  const result = await run(['env', 'use', '--help'], { commands: fakeCommands() })
  assert.equal(result.code, 0)
  const text = result.out.join('\n')
  assert.match(text, /Usage: colloq env use <name>/)
  assert.match(text, /delegates: \.\/scripts\/env\.sh <name>/)
})

test('not a single escape byte when there is no colour', async () => {
  const result = await run(['logs'], { commands: fakeCommands(), processEnv: { NO_COLOR: '1' } })
  const text = [...result.out, ...result.err].join('\n')
  assert.equal(text.includes('\u001b'), false)
  assert.equal(colorAllowed({ NO_COLOR: '1' }, true), false)
  assert.equal(colorAllowed({ NO_COLOR: '' }, true), false)
  assert.equal(colorAllowed({}, true), true)
  assert.equal(colorAllowed({}, false), false)
})

test('the table measures width on the line without escape sequences', () => {
  const out: string[] = []
  const ui = createUi({ color: true, out: (line) => void out.push(line) })
  ui.table([
    [ui.cyan('logs'), 'watch the log'],
    ['env use', 'make it the default'],
  ])
  const plain = out.map(stripAnsi)
  assert.deepEqual(plain, ['  logs     watch the log', '  env use  make it the default'])
})

test('kv and hint keep their indents, and the note is separated by a dot and uncoloured', () => {
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

test('a refusal is exactly three lines on stderr', () => {
  const err: string[] = []
  const ui = createUi({ err: (line) => void err.push(line) })
  ui.refuse('no docker', 'without it a room has nowhere to compute', 'install docker and repeat')
  assert.deepEqual(err, [
    '✗ no docker',
    'without it a room has nowhere to compute',
    '→ install docker and repeat',
  ])
})

test('json silences all other output', () => {
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

test('.env is read as in scripts/lib.sh: the ends are trimmed, the inside is not', () => {
  const env = createEnv({ io: createMemoryIo(FILES), root: ROOT, cwd: ROOT, processEnv: {} })
  assert.equal(env.port(), 4000)
  assert.equal(env.kernelEnv(), 'cv')
  assert.equal(env.read('VAST_GPU'), 'RTX 4090')
  assert.equal(env.relay().domain, 'hse.colloq.ru')
  assert.equal(env.relay().port, 7000)
})

test('read on a secret key throws, has answers', () => {
  const env = createEnv({ io: createMemoryIo(FILES), root: ROOT, cwd: ROOT, processEnv: {} })
  for (const key of SECRET_KEYS) {
    assert.throws(() => env.read(key), new RegExp(key))
  }
  assert.equal(env.has('JUPYTER_TOKEN'), true)
  assert.equal(env.has('CF_TOKEN'), false)
})

test("userPath resolves from the person's directory, not from the root", () => {
  const env = createEnv({
    io: createMemoryIo(FILES),
    root: ROOT,
    cwd: '/home/a/class',
    processEnv: {},
  })
  assert.equal(env.userPath('./release.json'), '/home/a/class/release.json')
  assert.equal(env.userPath('/tmp/release.json'), '/tmp/release.json')
})

test('the --dry-run line is quoted safely and does not substitute .env', () => {
  assert.equal(quote('hse.colloq.ru'), 'hse.colloq.ru')
  assert.equal(quote('RTX 4090'), "'RTX 4090'")
  assert.equal(quote(''), "''")
  assert.equal(
    commandLine('./scripts/host.sh', [], { COLLOQ_HOSTNAME: 'hse.colloq.ru' }),
    'COLLOQ_HOSTNAME=hse.colloq.ru ./scripts/host.sh',
  )
})

test("a child's signal is 128 + its number: 130 stays reserved for Ctrl+C", () => {
  assert.equal(exitFromSignal('SIGINT'), 130)
  assert.equal(exitFromSignal('SIGKILL'), 137)
  assert.equal(exitFromSignal('SIGTERM'), 143)
})

test('helpers: Levenshtein, counting rooms', () => {
  assert.equal(levenshtein('statsu', 'status'), 2)
  assert.equal(roomsPhrase(1), '1 room is running')
  assert.equal(roomsPhrase(3), '3 rooms are running')
  assert.equal(roomsPhrase(5), '5 rooms are running')
  assert.equal(roomsPhrase(11), '11 rooms are running')
  // One word for the whole CLI: the framework and "Tools" count it the same
  // way.
  assert.equal(roomsWord(1), '1 room')
  assert.equal(roomsWord(3), '3 rooms')
  assert.equal(roomsWord(11), '11 rooms')
  // The counting rule is also one, and it is not about rooms: packages in the
  // environment list are counted by the same helper, not by a second copy of it.
  assert.equal(countWord(0, 'package'), '0 packages')
  assert.equal(countWord(1, 'package'), '1 package')
  assert.equal(countWord(2, 'package'), '2 packages')
  assert.equal(countWord(21, 'package'), '21 packages')
  // An irregular plural is given as the second word, otherwise it would come
  // out as "classs": 's' is the default, not a rule.
  assert.equal(countWord(1, 'class', 'classes'), '1 class')
  assert.equal(countWord(2, 'class', 'classes'), '2 classes')
})

test("registry: only the teacher's commands; the workshop lives in the Makefile", () => {
  assert.deepEqual(registry.map((command) => command.name).sort(), [
    'backup',
    'doctor',
    'env list',
    'env new',
    'env show',
    'env use',
    'host',
    'link',
    'logs',
    'restart',
    'restore',
    'run',
    'status',
    'stop',
  ])
})

test('registry: names and aliases are unique, the group is known', () => {
  const seen = new Set<string>()
  const groups = new Set(GROUPS.map((group) => group.name))
  for (const command of registry) {
    for (const name of [command.name, ...(command.aliases ?? [])]) {
      assert.equal(seen.has(name), false, 'name taken twice: ' + name)
      seen.add(name)
    }
    assert.ok(groups.has(command.group), 'unknown group for ' + command.name)
  }
})

test('registry: usage names every flag of the command', () => {
  for (const command of registry) {
    for (const flag of command.flags) {
      const named =
        command.usage.includes('--' + flag.name) ||
        (flag.short !== undefined && command.usage.includes('-' + flag.short))
      assert.ok(named, 'flag --' + flag.name + ' is not named in usage: ' + command.name)
    }
  }
})

test('registry: summary in English, usage starts with "colloq ", delegates not empty', () => {
  for (const command of registry) {
    assert.match(command.summary, /[A-Za-z]/, 'summary without a single letter: ' + command.name)
    assert.doesNotMatch(command.summary, /[а-яА-ЯёЁ]/, 'summary not in English: ' + command.name)
    assert.ok(command.usage.startsWith('colloq '), 'usage without colloq: ' + command.name)
    assert.notEqual(command.delegates.trim(), '', 'no delegates: ' + command.name)
    assert.ok(command.name.length <= 18, 'the name will not fit in help: ' + command.name)
  }
})

test('registry: a destructive command has a question, or someone who will ask instead of us', () => {
  for (const command of registry) {
    if (!command.destructive) continue
    const ok =
      command.confirm === 'script' ||
      command.confirm === 'self' ||
      (command.confirm === 'cli' && Boolean(command.confirmQuestion))
    assert.ok(ok, 'destructive command without a question: ' + command.name)
  }
})

test('group modules open no door to processes and files around ctx', () => {
  for (const group of ['local', 'host', 'env', 'tools']) {
    const source = readFileSync(
      new URL('../cli/src/commands/' + group + '.ts', import.meta.url),
      'utf8',
    )
    const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*/g, '')
    assert.equal(/process\.env/.test(code), false, group + ': process.env bypassing ctx')
    assert.equal(/node:child_process/.test(code), false, group + ': node:child_process')
    assert.equal(/node:fs/.test(code), false, group + ': node:fs')
    assert.equal(/from 'node:/.test(code), false, group + ': a node: import bypassing ctx')
  }
})
