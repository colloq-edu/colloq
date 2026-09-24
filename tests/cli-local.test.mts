/**
 * The "Locally" group: run (a.k.a. start), stop, restart, logs, link, backup,
 * restore — a class on this machine.
 *
 * No process is started here and no real file is read: the executor is
 * replaced by an array of calls, the file system by an in-memory map. What is
 * checked is exactly what the group is responsible for: which line goes to the
 * supervisor or a script, where a command refuses before delegating, and who
 * asks.
 *
 * One promise is guarded separately: a command behaves the same whether it is
 * run from the wheel or from the sources. ctx.dist changes only how the
 * supervisor is invoked — and nothing else.
 *
 * The shared parts (unique names, an English summary, a question for every
 * destructive command, --dry-run without a single launch) are guarded by
 * tests/cli-core.test.mts.
 */
import './_cli.mjs'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { cli } from '../cli/src/main.js'
import { createMemoryIo } from '../cli/src/env.js'

const ROOT = '/repo'

const FILES: Record<string, string> = {
  '/repo/package.json': '{ "name": "colloq", "version": "0.1.0" }',
  '/repo/cli/package.json': '{ "name": "@colloq/cli", "version": "0.1.0" }',
  '/repo/.env': ['PORT=4000', 'KERNEL_ENV=cv', 'RELAY_DOMAIN=hse.colloq.ru'].join('\n'),
}

type Call = string[]

type Harness = {
  code: number
  out: string[]
  err: string[]
  calls: Call[]
  /** The env of each real launch, in the order of calls without capture. */
  envs: (Record<string, string> | undefined)[]
  asked: string[]
}

type Capture = { code: number; stdout: string; stderr: string }

async function run(
  argv: string[],
  opts: {
    files?: Record<string, string>
    answer?: string
    tty?: boolean
    exit?: number
    capture?: (cmd: string, args: string[]) => Capture
    /** Installed colloq: the supervisor ships as a bundle, no tsx or sources. */
    dist?: boolean
    /**
     * The state directory, when it differs from the app directory.
     *
     * This is how an installed colloq lives: the code in site-packages, while
     * .env, the log, the session receipt and data/ are in ~/.colloq. When not
     * given, both roots are /repo, as in a clone.
     */
    home?: string
  } = {},
): Promise<Harness> {
  const out: string[] = []
  const err: string[] = []
  const calls: Call[] = []
  const envs: (Record<string, string> | undefined)[] = []
  const asked: string[] = []
  const io = createMemoryIo({ ...FILES, ...(opts.files ?? {}) }, 1_700_000_000_000)
  const code = await cli(argv, {
    io,
    root: ROOT,
    cwd: ROOT,
    out: (line) => void out.push(line),
    err: (line) => void err.push(line),
    tty: opts.tty ?? false,
    processEnv: {},
    dist: opts.dist ?? false,
    home: opts.home,
    ask:
      opts.answer === undefined
        ? undefined
        : async (question: string) => {
            asked.push(question)
            return opts.answer as string
          },
    runner: {
      async run(cmd, args, runOpts) {
        calls.push([cmd, ...args])
        envs.push(runOpts.env)
        return opts.exit ?? 0
      },
      async capture(cmd, args) {
        calls.push(['capture', cmd, ...args])
        return opts.capture?.(cmd, args) ?? { code: 1, stdout: '', stderr: '' }
      },
    },
  })
  return { code, out, err, calls, envs, asked }
}

/** Real launches: reading the state (capture) does not count as a call. */
function spawned(result: Harness): Call[] {
  return result.calls.filter((call) => call[0] !== 'capture')
}

/** The process answers by pid: kill -0 gives 0. */
const ALIVE = (cmd: string): Capture => ({ code: cmd === 'kill' ? 0 : 1, stdout: '', stderr: '' })

// ------------------------------------------------------------------ launch

const LAUNCH = 'node --import tsx /repo/cli/src/launch.ts'
const SOURCE = ['node', '--import', 'tsx', '/repo/cli/src/launch.ts']

/**
 * The receipt of a class in progress, as the supervisor writes it.
 *
 * In full, not as a stub `{pid, port, mode}`: it is read by the shared
 * readSession (cli/src/session.ts), and without url and runId it honestly
 * answers "no receipt" — the same thing a person sees when the file is only
 * half written.
 */
const RECEIPT = {
  pid: 4242,
  serverPid: 4243,
  port: 4000,
  url: 'http://localhost:4000',
  runId: 'session-1',
  mode: 'run',
  phase: 'ready',
  startedAt: 1_700_000_000_000,
  leaseFile: '',
}

/** State dir of an installed colloq: the code separate, the class separate. */
const HOME = '/home/teacher/.colloq'

const SESSION = {
  files: { '/repo/.colloq/local-session.json': JSON.stringify(RECEIPT) },
}

test('run: the alias and the flags give one exact dry-run command', async () => {
  for (const name of ['run', 'start']) {
    const result = await run([name, '--dry-run'])
    assert.equal(result.code, 0)
    assert.deepEqual(result.out, [LAUNCH + ' run'])
    assert.deepEqual(result.calls, [])
  }
  assert.deepEqual((await run(['run', '--fast', '--dry-run'])).out, [LAUNCH + ' run --fast'])
  assert.deepEqual(
    (
      await run([
        'start',
        '--host',
        'hse.colloq.ru',
        '--detach',
        '--port',
        '4100',
        '--no-open',
        '--fast',
        '--dry-run',
      ])
    ).out,
    [LAUNCH + ' run --host hse.colloq.ru --detach --port 4100 --no-open --fast'],
  )
  // --share is a supervisor flag, like --host: no variables, no second call.
  assert.deepEqual((await run(['start', '--share', '--dry-run'])).out, [LAUNCH + ' run --share'])
  assert.deepEqual((await run(['start', '--share', '--dry-run'], { dist: true })).out, [
    'node /repo/cli/launch.mjs run --share',
  ])
  assert.deepEqual((await run(['run', '--share', '--detach', '--no-open', '--dry-run'])).out, [
    LAUNCH + ' run --share --detach --no-open',
  ])
})

test('run: --share and --host together are a usage error before anything starts', async () => {
  for (const argv of [
    ['start', '--share', '--host', 'hse.colloq.ru'],
    ['run', '--host', 'hse.colloq.ru', '--share', '--dry-run'],
  ]) {
    const result = await run(argv, { tty: true, answer: 'y' })
    assert.equal(result.code, 2, argv.join(' '))
    assert.deepEqual(result.calls, [], argv.join(' '))
    assert.deepEqual(result.out, [], argv.join(' '))
    assert.match(result.err.join('\n'), /--share and --host do not work together/)
  }
})

test('run: a bare colloq starts nothing', async () => {
  const bare = await run([])
  assert.equal(bare.code, 0)
  assert.deepEqual(bare.calls, [])
  assert.match(bare.out.join('\n'), /colloq start/)
})

/**
 * KEY=VALUE pairs are no longer stripped by the framework: they are a
 * positional argument, and run has no positionals. Silently taking `FAST=1`
 * for --fast or, worse, handing `DATA_DIR=…` to the supervisor as environment
 * would mean keeping a second flag language that help does not mention.
 */
test('run: a KEY=VALUE pair is an extra argument, not a flag', async () => {
  for (const pair of ['FAST=1', 'HOST=hse.colloq.ru', 'DATA_DIR=/tmp/elsewhere']) {
    const result = await run(['run', pair, '--dry-run'])
    assert.equal(result.code, 2, pair)
    assert.deepEqual(result.calls, [], pair)
    assert.deepEqual(result.out, [], pair)
    assert.match(result.err.join('\n'), /extra argument/, pair)
  }
})

test('run: the launch never asks and hands back the supervisor exit code', async () => {
  for (const argv of [['run'], ['start'], ['run', '--yes']]) {
    const result = await run(argv, { tty: true, answer: 'n', capture: ALIVE, exit: 3 })
    assert.equal(result.code, 3)
    assert.deepEqual(result.asked, [])
    assert.deepEqual(result.calls, [[...SOURCE, 'run']])
    // No environment is added for the supervisor: everything it needs is in
    // argv.
    assert.deepEqual(result.envs, [undefined])
  }
})

test('run: invalid ports and tunnel names fail before the supervisor and before a question', async () => {
  for (const argv of [
    ['run', '--port', '0'],
    ['run', '--port', '65536'],
    ['run', '--port', '3.5'],
    ['start', '--port', ''],
    ['run', '--host', 'https://hse.colloq.ru'],
    ['run', '--host', ''],
    ['run', '--direct'],
  ]) {
    const result = await run(argv, { tty: true, answer: 'y' })
    assert.equal(result.code, 2, argv.join(' '))
    assert.deepEqual(result.calls, [], argv.join(' '))
    assert.deepEqual(result.asked, [], argv.join(' '))
  }
})

test('the installed colloq runs the bundle, the sources run through tsx', async () => {
  const dist = await run(['start', '--dry-run'], { dist: true })
  assert.equal(dist.code, 0)
  assert.deepEqual(dist.out, ['node /repo/cli/launch.mjs run'])

  const source = await run(['start', '--dry-run'])
  assert.deepEqual(source.out, [LAUNCH + ' run'])
})

// ------------------------------------------------------------ stop, restart

test('stop/restart: a receipt leads to the supervisor', async () => {
  for (const command of ['stop', 'restart']) {
    const result = await run([command, '--dry-run'], SESSION)
    assert.equal(result.code, 0)
    assert.deepEqual(result.out, [LAUNCH + ' ' + command])
    assert.deepEqual(result.calls, [])
    const live = await run([command, '--yes'], SESSION)
    assert.equal(live.code, 0)
    assert.deepEqual(spawned(live), [[...SOURCE, command]])
  }
  assert.deepEqual((await run(['restart', '--build', '--fast', '--dry-run'], SESSION)).out, [
    LAUNCH + ' restart --build --fast',
  ])
  // stop carries neither --build nor --fast: stopping has neither.
  assert.deepEqual(spawned(await run(['stop', '--yes'], SESSION)), [[...SOURCE, 'stop']])
})

test('stop: the framework asks under a class in progress, «no» is code 4', async () => {
  const no = await run(['stop'], { tty: true, answer: 'n', ...SESSION })
  assert.equal(no.code, 4)
  assert.deepEqual(spawned(no), [])
  assert.match(no.asked[0] ?? '', /stop the server\?/)

  const yes = await run(['stop'], { tty: true, answer: 'y', ...SESSION })
  assert.equal(yes.code, 0)
  assert.deepEqual(spawned(yes), [[...SOURCE, 'stop']])
})

test('stop without a receipt: nothing to stop, code 0, no question and no make', async () => {
  for (const argv of [['stop'], ['stop', '--yes'], ['stop', '--dry-run']]) {
    const result = await run(argv, {
      tty: true,
      answer: 'y',
      // An old pid file nearby is not a receipt: it used to lead to make stop,
      // no longer.
      files: { '/repo/.colloq.pid': '4242\n' },
      capture: ALIVE,
    })
    assert.equal(result.code, 0, argv.join(' '))
    assert.deepEqual(spawned(result), [], argv.join(' '))
    assert.deepEqual(result.asked, [], argv.join(' '))
    assert.match(result.out.join('\n'), /nothing to stop/, argv.join(' '))
    assert.match(result.out.join('\n'), /colloq start/, argv.join(' '))
  }
})

test('restart: asks itself, «no» is code 4, --yes and --dry-run do not ask', async () => {
  const no = await run(['restart'], { tty: true, answer: 'n', ...SESSION })
  assert.equal(no.code, 4)
  assert.deepEqual(spawned(no), [])
  assert.match(no.asked[0] ?? '', /restart the local session\?/)
  assert.deepEqual(no.out, ['cancelled'])

  const yes = await run(['restart', '--build'], { tty: true, answer: 'y', ...SESSION })
  assert.equal(yes.code, 0)
  assert.deepEqual(spawned(yes), [[...SOURCE, 'restart', '--build']])

  const forced = await run(['restart', '--yes'], { tty: true, answer: 'n', ...SESSION })
  assert.deepEqual(forced.asked, [])
  assert.deepEqual(spawned(forced), [[...SOURCE, 'restart']])
})

test('restart: the supervisor exit code goes out as it is', async () => {
  const result = await run(['restart', '--yes'], { ...SESSION, exit: 1 })
  assert.equal(result.code, 1)
})

test('restart without a receipt refuses in words: no make, no npm, no question', async () => {
  for (const argv of [
    ['restart'],
    ['restart', '--yes'],
    ['restart', '--build', '--yes'],
    ['restart', '--dry-run'],
  ]) {
    const result = await run(argv, {
      tty: true,
      answer: 'y',
      // A former launch on the host: the pid file exists, and it used to lead
      // to make.
      files: { '/repo/.colloq.pid': '4242\n', '/repo/.env': 'COLLOQ_CLUSTER=1\nPORT=4000' },
      capture: ALIVE,
    })
    assert.equal(result.code, 3, argv.join(' '))
    assert.deepEqual(spawned(result), [], argv.join(' '))
    assert.deepEqual(result.asked, [], argv.join(' '))
    const text = result.err.join('\n')
    assert.match(text, /nothing to restart/, argv.join(' '))
    assert.match(text, /\/repo\/\.colloq\/local-session\.json/, argv.join(' '))
    assert.match(text, /colloq start/, argv.join(' '))
    assert.doesNotMatch(text, /make|docker|cluster/, argv.join(' '))
  }
})

// --------------------------------------------------------------------- log

const LOG = { files: { '/repo/.colloq.log': 'line' } }

test('logs: the server log through tail, -n and --no-follow change the call', async () => {
  assert.deepEqual((await run(['logs', '--dry-run'])).out, ['tail -f /repo/.colloq.log'])
  assert.deepEqual((await run(['log', '--dry-run'])).out, ['tail -f /repo/.colloq.log'])
  assert.deepEqual((await run(['logs', '-n', '200', '--dry-run'])).out, [
    'tail -f -n 200 /repo/.colloq.log',
  ])
  assert.deepEqual((await run(['logs', '--lines', '50', '--no-follow', '--dry-run'])).out, [
    'tail -n 50 /repo/.colloq.log',
  ])
  assert.deepEqual((await run(['logs', '-f', '--dry-run'])).out, ['tail -f /repo/.colloq.log'])

  const real = await run(['logs', '--no-follow'], LOG)
  assert.equal(real.code, 0)
  assert.deepEqual(spawned(real), [['tail', '/repo/.colloq.log']])
})

test('logs: conflicting or removed flags are code 2, nothing runs', async () => {
  for (const argv of [
    ['logs', '-f', '--no-follow'],
    ['logs', '-n', 'many'],
    ['logs', '-n', '0'],
    // The other logs — docker's and the service's — stayed with the workshop.
    ['logs', '--server'],
    ['logs', '--docker'],
    ['logs', '--service'],
    ['logs', 'LINES=200'],
  ]) {
    const result = await run(argv, LOG)
    assert.equal(result.code, 2, argv.join(' '))
    assert.deepEqual(spawned(result), [], argv.join(' '))
  }
})

test('logs without the log file: refusal 3 naming the path and colloq start', async () => {
  const result = await run(['logs'])
  assert.equal(result.code, 3)
  assert.deepEqual(spawned(result), [])
  const text = result.err.join('\n')
  assert.match(text, /no log at \/repo\/\.colloq\.log/)
  assert.match(text, /colloq start --detach/)
  assert.doesNotMatch(text, /--docker|make/)

  const there = await run(['logs'], LOG)
  assert.deepEqual(spawned(there), [['tail', '-f', '/repo/.colloq.log']])
})

// ---------------------------------------------------------------- address

test('link: the address is printed, the token never', async () => {
  assert.deepEqual((await run(['link', '--dry-run'])).out, [
    'native: link (reads the session receipt, the temporary address and .env)',
  ])

  const outside = await run(['link'], {
    files: { '/repo/.env': 'PUBLIC_URL=https://hse.colloq.ru\nRELAY_DOMAIN=hse.colloq.ru' },
  })
  assert.equal(outside.code, 0)
  const text = outside.out.join('\n')
  assert.match(text, /https:\/\/hse\.colloq\.ru/)
  assert.doesNotMatch(text, /admin\/t\//)
  assert.match(text, /data\/setup-token/)
  assert.deepEqual(spawned(outside), [])

  const inside = await run(['link'], {
    files: { '/repo/.env': 'PUBLIC_URL=http://127.0.0.1:3000' },
  })
  assert.match(inside.out.join('\n'), /not published/)
  assert.match(inside.out.join('\n'), /colloq host/)
})

test('link: without a receipt and without .env — refusal 3', async () => {
  // A separate state directory with no .env in it: there is nowhere to take
  // the address from.
  const none = await run(['link'], { home: HOME })
  assert.equal(none.code, 3)
  assert.deepEqual(spawned(none), [])
  assert.match(none.err.join('\n'), /no \.env/)
  assert.match(none.err.join('\n'), /colloq run/)

  // An empty .env is still a .env: there is no address, but nothing to refuse
  // either.
  const empty = await run(['link'], { files: { '/repo/.env': '' } })
  assert.equal(empty.code, 0)
  assert.match(empty.out.join('\n'), /not published/)
})

test('link: the local receipt wins over .env and only its current lease is public', async () => {
  const receipt = JSON.stringify({
    ...RECEIPT,
    port: 4100,
    url: 'http://localhost:4100',
    leaseFile: '/repo/.colloq/public-url.json',
  })
  const base = {
    '/repo/.env': 'PUBLIC_URL=https://old.example.org',
    '/repo/.colloq/local-session.json': receipt,
  }
  for (const [lease, expected] of [
    [
      {
        runId: 'session-1',
        owner: 'tunnel',
        url: 'https://hse.colloq.ru',
        expiresAt: 1_700_000_010_000,
      },
      'https://hse.colloq.ru',
    ],
    [
      {
        runId: 'other-session',
        owner: 'tunnel',
        url: 'https://wrong.example.org',
        expiresAt: 1_700_000_010_000,
      },
      'not published',
    ],
    [
      {
        runId: 'session-1',
        owner: 'tunnel',
        url: 'https://expired.example.org',
        expiresAt: 1_700_000_000_000,
      },
      'not published',
    ],
    [
      {
        runId: 'session-1',
        owner: 'tunnel',
        url: 'https://secret@bad.example.org',
        expiresAt: 1_700_000_010_000,
      },
      'not published',
    ],
  ] as const) {
    const result = await run(['link'], {
      files: { ...base, '/repo/.colloq/public-url.json': JSON.stringify(lease) },
      capture: ALIVE,
    })
    assert.equal(result.code, 0)
    const text = result.out.join('\n')
    assert.ok(text.includes(expected), text)
    assert.match(text, /http:\/\/localhost:4100/)
    assert.doesNotMatch(text, /old\.example|wrong\.example|expired\.example|secret@/)
    assert.deepEqual(spawned(result), [])
  }
  const dead = await run(['link'], {
    files: {
      ...base,
      '/repo/.colloq/public-url.json': JSON.stringify({
        runId: 'session-1',
        owner: 'tunnel',
        url: 'https://hse.colloq.ru',
        expiresAt: 1_700_000_010_000,
      }),
    },
  })
  assert.doesNotMatch(dead.out.join('\n'), /https:\/\/hse\.colloq\.ru|old\.example/)
})

// ---------------------------------------------------------- backups

const HERE = 'COLLOQ_HOME=/repo '

test('backup: without flags a local backup, taken by the script itself', async () => {
  for (const argv of [['backup'], ['backup', '--legacy']]) {
    const dry = await run([...argv, '--dry-run'])
    assert.equal(dry.code, 0, argv.join(' '))
    assert.deepEqual(dry.out, [HERE + './scripts/backup-local.sh'], argv.join(' '))
    assert.deepEqual(dry.calls, [], argv.join(' '))
  }

  // The real call is the same script, and COLLOQ_HOME goes to it through the
  // environment.
  const real = await run(['backup'], { tty: true, answer: 'n' })
  assert.equal(real.code, 0)
  assert.deepEqual(real.asked, [])
  assert.deepEqual(spawned(real), [['./scripts/backup-local.sh']])
  assert.deepEqual(real.envs, [{ COLLOQ_HOME: '/repo' }])
})

test('backup: a portable flag leads to backup.sh, everything by environment', async () => {
  assert.deepEqual((await run(['backup', '--mode', 'live', '--dry-run'])).out, [
    HERE + 'MODE=live ./scripts/backup.sh',
  ])
  assert.deepEqual((await run(['backup', '--mode', 'consistent', '--resume', '--dry-run'])).out, [
    HERE + 'MODE=consistent RESUME=1 ./scripts/backup.sh',
  ])
  assert.deepEqual(
    (await run(['backup', '--name', 'hse', '--out', 'backups/hse/copy.tar.gz', '--dry-run'])).out,
    [HERE + 'MODE=live NAME=hse OUT=/repo/backups/hse/copy.tar.gz ./scripts/backup.sh'],
  )
  assert.deepEqual((await run(['backup', '--release', 'release.json', '--dry-run'])).out, [
    HERE + 'MODE=live RELEASE=/repo/release.json ./scripts/backup.sh',
  ])
  // A path with a space is copied whole: that is what the --dry-run line is
  // printed for.
  assert.deepEqual((await run(['backup', '--out', 'backup of the day.tar.gz', '--dry-run'])).out, [
    HERE + "MODE=live OUT='/repo/backup of the day.tar.gz' ./scripts/backup.sh",
  ])
})

test('backup: consistent asks, live does not', async () => {
  const live = await run(['backup', '--mode', 'live'], { tty: true, answer: 'n' })
  assert.equal(live.code, 0)
  assert.deepEqual(live.asked, [])
  assert.deepEqual(spawned(live), [['./scripts/backup.sh']])
  assert.deepEqual(live.envs, [{ COLLOQ_HOME: '/repo', MODE: 'live' }])

  const no = await run(['backup', '--mode', 'consistent'], { tty: true, answer: 'n' })
  assert.equal(no.code, 4)
  assert.deepEqual(spawned(no), [])
  assert.match(no.asked[0] ?? '', /stop every writer\? without --resume/)

  const forced = await run(['backup', '--mode', 'consistent', '--resume', '--yes'], { tty: true })
  assert.deepEqual(forced.asked, [])
  assert.deepEqual(spawned(forced), [['./scripts/backup.sh']])
  assert.deepEqual(forced.envs, [{ COLLOQ_HOME: '/repo', MODE: 'consistent', RESUME: '1' }])
})

test('backup: conflicting flags and pairs are refused before the script', async () => {
  for (const argv of [
    ['backup', '--mode', 'half'],
    ['backup', '--resume'],
    ['backup', '--legacy', '--mode', 'consistent'],
    ['backup', '--legacy', '--name', 'hse'],
    ['backup', '--legacy', '--out', 'copy.tar.gz'],
    ['backup', '--name', '-hse'],
    ['backup', 'MODE=consistent'],
  ]) {
    const result = await run(argv, { tty: true, answer: 'y' })
    assert.equal(result.code, 2, argv.join(' '))
    assert.deepEqual(spawned(result), [], argv.join(' '))
    assert.deepEqual(result.asked, [], argv.join(' '))
  }
})

test('restore: the portable path needs both files and asks itself', async () => {
  assert.deepEqual(
    (
      await run([
        'restore',
        '--archive',
        'colloq-20260914.tar.gz',
        '--release',
        'release.json',
        '--dry-run',
      ])
    ).out,
    [
      HERE +
        './scripts/restore.sh --archive /repo/colloq-20260914.tar.gz --release /repo/release.json',
    ],
  )

  const half = await run(['restore', '--archive', 'colloq-20260914.tar.gz'])
  assert.equal(half.code, 2)
  assert.deepEqual(spawned(half), [])
  assert.match(half.err.join('\n'), /no --release <file>/)

  const files = { '/repo/colloq-20260914.tar.gz': 'archive', '/repo/release.json': '{}' }
  const no = await run(
    ['restore', '--archive', 'colloq-20260914.tar.gz', '--release', 'release.json'],
    { tty: true, answer: 'n', files },
  )
  assert.equal(no.code, 4)
  assert.deepEqual(spawned(no), [])
  assert.match(no.asked[0] ?? '', /restore over this machine\? the cluster will be stopped/)

  const yes = await run(
    [
      'restore',
      '--archive',
      'colloq-20260914.tar.gz',
      '--release',
      'release.json',
      '--name',
      'hse',
      '--recover',
      '--yes',
    ],
    { tty: true, files },
  )
  assert.deepEqual(yes.asked, [])
  // As in the restore target: switches as arguments, the name through the
  // environment.
  assert.deepEqual(spawned(yes), [
    [
      './scripts/restore.sh',
      '--archive',
      '/repo/colloq-20260914.tar.gz',
      '--release',
      '/repo/release.json',
      '--recover',
    ],
  ])
  assert.deepEqual(yes.envs, [{ COLLOQ_HOME: '/repo', NAME: 'hse' }])
})

test('restore: over a live database only with --replace, never by --yes', async () => {
  const files = {
    '/repo/colloq-20260914.tar.gz': 'archive',
    '/repo/release.json': '{}',
    '/repo/colloq-20260914.db': 'database',
  }
  for (const argv of [
    ['restore', '--archive', 'colloq-20260914.tar.gz', '--release', 'release.json', '--yes'],
    ['restore', '--legacy', '--db', 'colloq-20260914.db', '--yes'],
  ]) {
    const result = await run(argv, { tty: true, files })
    assert.equal(spawned(result).length, 1, argv.join(' '))
    assert.equal((spawned(result)[0] ?? []).includes('--replace'), false, argv.join(' '))
    assert.equal(result.envs[0]?.REPLACE, undefined, argv.join(' '))
  }

  // A portable backup gets the permission as a switch, a local one as the
  // variable REPLACE=1.
  const portable = await run(
    [
      'restore',
      '--archive',
      'colloq-20260914.tar.gz',
      '--release',
      'release.json',
      '--replace',
      '--yes',
    ],
    { tty: true, files },
  )
  assert.deepEqual(spawned(portable), [
    [
      './scripts/restore.sh',
      '--archive',
      '/repo/colloq-20260914.tar.gz',
      '--release',
      '/repo/release.json',
      '--replace',
    ],
  ])
  assert.deepEqual(portable.envs, [{ COLLOQ_HOME: '/repo' }])

  const local = await run(['restore', '--legacy', '--db', 'colloq-20260914.db', '--replace'], {
    tty: true,
    files,
  })
  assert.deepEqual(spawned(local), [['./scripts/restore.sh', '/repo/colloq-20260914.db']])
  assert.deepEqual(local.envs, [{ COLLOQ_HOME: '/repo', REPLACE: '1' }])

  // The pair REPLACE=1 is no longer a permission but an extra argument.
  const paired = await run(['restore', '--legacy', '--db', 'colloq-20260914.db', 'REPLACE=1'], {
    tty: true,
    files,
  })
  assert.equal(paired.code, 2)
  assert.deepEqual(spawned(paired), [])
})

test('restore --legacy: we do not ask, the script does; paths go as arguments', async () => {
  assert.deepEqual(
    (
      await run([
        'restore',
        '--legacy',
        '--db',
        'colloq-20260914.db',
        '--files',
        'colloq-20260914-files.tar.gz',
        '--dry-run',
      ])
    ).out,
    [HERE + './scripts/restore.sh /repo/colloq-20260914.db /repo/colloq-20260914-files.tar.gz'],
  )
  // There was no archive among the arguments, so it is not passed as an empty
  // string: restore.sh sorts its arguments by extension and dies on an empty
  // one with 'I do not understand ""'.
  assert.deepEqual(
    (
      await run([
        'restore',
        '--db',
        'colloq-20260914.db',
        '--name',
        'hse',
        '--replace',
        '--dry-run',
      ])
    ).out,
    [HERE + 'NAME=hse REPLACE=1 ./scripts/restore.sh /repo/colloq-20260914.db'],
  )

  const result = await run(['restore', '--legacy', '--db', 'colloq-20260914.db'], {
    tty: true,
    answer: 'n',
    files: { '/repo/colloq-20260914.db': 'database' },
  })
  assert.equal(result.code, 0)
  assert.deepEqual(result.asked, [])
  assert.deepEqual(spawned(result), [['./scripts/restore.sh', '/repo/colloq-20260914.db']])
  assert.deepEqual(result.envs, [{ COLLOQ_HOME: '/repo' }])
})

test('restore: the worlds do not mix, a missing file is refusal 3', async () => {
  for (const argv of [
    ['restore', '--legacy', '--archive', 'colloq-20260914.tar.gz', '--db', 'colloq-20260914.db'],
    ['restore', '--db', 'colloq-20260914.db', '--recover'],
    ['restore', '--legacy'],
    ['restore'],
    ['restore', '--legacy', '--db', 'colloq-20260914.db', '--name', 'bad name'],
  ]) {
    const result = await run(argv, { tty: true, answer: 'y' })
    assert.equal(result.code, 2, argv.join(' '))
    assert.deepEqual(spawned(result), [], argv.join(' '))
  }

  const gone = await run(['restore', '--legacy', '--db', 'missing.db'], { tty: true, answer: 'y' })
  assert.equal(gone.code, 3)
  assert.deepEqual(spawned(gone), [])
  assert.match(gone.err.join('\n'), /no file \/repo\/missing\.db/)

  const noFiles = await run(
    ['restore', '--legacy', '--db', 'colloq-20260914.db', '--files', 'missing.tar.gz'],
    { tty: true, answer: 'y', files: { '/repo/colloq-20260914.db': 'database' } },
  )
  assert.equal(noFiles.code, 3)
  assert.deepEqual(spawned(noFiles), [])

  const noRelease = await run(
    ['restore', '--archive', 'colloq-20260914.tar.gz', '--release', 'missing.json'],
    { tty: true, answer: 'y', files: { '/repo/colloq-20260914.tar.gz': 'archive' } },
  )
  assert.equal(noRelease.code, 3)
  assert.deepEqual(spawned(noRelease), [])
  assert.deepEqual(noRelease.asked, [])
})

// ------------------------------------------------------- wheel and sources

/**
 * One command, one behaviour, wherever it is called from.
 *
 * The bugs this records: from the wheel `colloq backup` took one kind of
 * backup, and from a clone another; `colloq stop` without a receipt called
 * make stop in a clone and answered in words in the wheel. What was checked
 * in a clone turned out to be a different command for the teacher. Now
 * ctx.dist chooses only the bundle or the source of the supervisor — and this
 * check holds exactly that.
 */
test('the wheel and the sources behave the same, only the launcher differs', async () => {
  const same: string[][] = [
    ['backup', '--dry-run'],
    ['backup', '--legacy', '--dry-run'],
    ['backup', '--mode', 'consistent', '--resume', '--dry-run'],
    ['restore', '--legacy', '--db', 'colloq-20260914.db', '--dry-run'],
    ['restore', '--archive', 'a.tar.gz', '--release', 'release.json', '--replace', '--dry-run'],
    ['logs', '--dry-run'],
    ['logs', '--no-follow'],
    ['stop', '--yes'],
    ['restart', '--yes'],
    ['restart', '--dry-run'],
    ['link'],
  ]
  for (const argv of same) {
    const source = await run(argv)
    const wheel = await run(argv, { dist: true })
    assert.equal(wheel.code, source.code, argv.join(' '))
    assert.deepEqual(wheel.out, source.out, argv.join(' '))
    assert.deepEqual(wheel.err, source.err, argv.join(' '))
    assert.deepEqual(wheel.calls, source.calls, argv.join(' '))
  }

  // With a receipt the only difference is how the supervisor is invoked.
  for (const command of ['stop', 'restart']) {
    const wheel = await run([command, '--yes'], { ...SESSION, dist: true })
    assert.deepEqual(spawned(wheel), [['node', '/repo/cli/launch.mjs', command]])
  }
})

// ------------------------------------------------------------ two roots

/**
 * Two roots: the code separate, the class separate.
 *
 * The bug this records: commands looked for the session receipt as
 * ctx.env.path('.colloq/local-session.json') — relative to the APP directory —
 * while the supervisor writes it into the state directory. For an installed
 * colloq these are different directories, and `colloq stop` under a running
 * server answered "no class is running — nothing to stop". What is checked is
 * the main thing: the receipt is read where it is written, and only there.
 */
test('the session receipt is read in the state directory, not beside the code', async () => {
  const live = await run(['stop', '--yes'], {
    dist: true,
    home: HOME,
    files: { [HOME + '/.colloq/local-session.json']: JSON.stringify(RECEIPT) },
  })
  assert.equal(live.code, 0)
  assert.deepEqual(spawned(live), [['node', '/repo/cli/launch.mjs', 'stop']])
  assert.doesNotMatch(live.out.join('\n'), /nothing to stop/)

  // The same receipt beside the code is under a foreign root: for us it does
  // not exist at all.
  const beside = await run(['stop', '--yes'], {
    dist: true,
    home: HOME,
    files: { '/repo/.colloq/local-session.json': JSON.stringify(RECEIPT) },
  })
  assert.deepEqual(beside.calls, [])
  assert.match(beside.out.join('\n'), /nothing to stop/)

  // The same root drives the restart too.
  const restart = await run(['restart', '--yes'], {
    dist: true,
    home: HOME,
    tty: true,
    files: { [HOME + '/.colloq/local-session.json']: JSON.stringify(RECEIPT) },
  })
  assert.deepEqual(spawned(restart), [['node', '/repo/cli/launch.mjs', 'restart']])

  const none = await run(['restart', '--yes'], { dist: true, home: HOME })
  assert.equal(none.code, 3)
  assert.ok(none.err.join('\n').includes(HOME + '/.colloq/local-session.json'))
})

test('link: the class address and the sign-in paths come from the state directory', async () => {
  const result = await run(['link'], {
    dist: true,
    home: HOME,
    files: {
      [HOME + '/.colloq/local-session.json']: JSON.stringify({
        ...RECEIPT,
        port: 4100,
        url: 'http://localhost:4100',
      }),
    },
    capture: ALIVE,
  })
  assert.equal(result.code, 0)
  const text = result.out.join('\n')
  // The receipt has the local address, and it is the only place it is taken
  // from.
  assert.match(text, /local.*http:\/\/localhost:4100/)
  // Paths are named in full: these files are not in the person's working
  // folder.
  assert.ok(text.includes(HOME + '/.colloq.log'), text)
  assert.ok(text.includes(HOME + '/data/setup-token'), text)
  assert.doesNotMatch(text, /admin\/t\//)
})

test('logs: the tail of the log in the state directory', async () => {
  const there = await run(['logs'], {
    dist: true,
    home: HOME,
    files: { [HOME + '/.colloq.log']: 'line' },
  })
  assert.deepEqual(spawned(there), [['tail', '-f', HOME + '/.colloq.log']])

  // A log beside the code is not ours: the refusal names the path where it is
  // expected.
  const beside = await run(['logs'], { home: HOME, files: { '/repo/.colloq.log': 'line' } })
  assert.equal(beside.code, 3)
  assert.deepEqual(spawned(beside), [])
  assert.ok(beside.err.join('\n').includes(HOME + '/.colloq.log'))
})

test('backups are taken from the state directory: COLLOQ_HOME goes to the scripts', async () => {
  const files = {
    [HOME + '/.env']: 'PORT=4000',
    [HOME + '/colloq-20260914.tar.gz']: 'archive',
    [HOME + '/release.json']: '{}',
    [HOME + '/colloq-20260914.db']: 'database',
  }
  const at = { dist: true, home: HOME, files }
  const home = 'COLLOQ_HOME=' + HOME + ' '

  assert.deepEqual((await run(['backup', '--dry-run'], at)).out, [
    home + './scripts/backup-local.sh',
  ])
  assert.deepEqual((await run(['backup', '--mode', 'live', '--dry-run'], at)).out, [
    home + 'MODE=live ./scripts/backup.sh',
  ])

  const portable = await run(
    [
      'restore',
      '--archive',
      HOME + '/colloq-20260914.tar.gz',
      '--release',
      HOME + '/release.json',
      '--dry-run',
    ],
    at,
  )
  assert.deepEqual(portable.out, [
    home +
      './scripts/restore.sh --archive ' +
      HOME +
      '/colloq-20260914.tar.gz --release ' +
      HOME +
      '/release.json',
  ])

  const legacy = await run(['restore', '--legacy', '--db', HOME + '/colloq-20260914.db'], {
    ...at,
    tty: true,
  })
  assert.deepEqual(spawned(legacy), [['./scripts/restore.sh', HOME + '/colloq-20260914.db']])
  assert.deepEqual(legacy.envs, [{ COLLOQ_HOME: HOME }])

  const real = await run(['backup', '--yes'], at)
  assert.equal(real.code, 0)
  assert.deepEqual(spawned(real), [['./scripts/backup-local.sh']])
  assert.deepEqual(real.envs, [{ COLLOQ_HOME: HOME }])
})
