/**
 * Группа «Локально»: run, stop, restart, up, down, ps, logs, dev, build, ui,
 * test, check, shell, link, docker-gid, backup, restore.
 *
 * Здесь не запускается ни один процесс и не читается ни один настоящий файл:
 * исполнитель подменён массивом вызовов, файловая система — картой в памяти.
 * Проверяется ровно то, за что отвечает группа: какая строка уходит make или
 * скрипту, где команда отказывает до делегирования и кто спрашивает.
 *
 * Общее (уникальность имён, русский summary, вопрос у каждой опасной команды,
 * --dry-run без единого запуска) стережёт tests/cli-core.test.mts.
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
  '/repo/Makefile': ['run: ## Build and start', 'ps: status'].join('\n'),
  '/repo/.env': ['PORT=4000', 'KERNEL_ENV=cv', 'RELAY_DOMAIN=hse.colloq.ru'].join('\n'),
}

type Call = string[]

type Harness = {
  code: number
  out: string[]
  err: string[]
  calls: Call[]
  asked: string[]
}

type Capture = { code: number; stdout: string; stderr: string }

async function run(
  argv: string[],
  opts: {
    files?: Record<string, string>
    answer?: string
    tty?: boolean
    processEnv?: NodeJS.ProcessEnv
    exit?: number
    capture?: (cmd: string, args: string[]) => Capture
    /** Установленный colloq: ни Makefile, ни tsx, ни исходников рядом нет. */
    dist?: boolean
    /**
     * Каталог состояния, когда он не совпадает с каталогом приложения.
     *
     * Так живёт установленный colloq: код в site-packages, а .env, журнал,
     * расписка сессии и data/ — в ~/.colloq. Не назван — оба корня это /repo,
     * как в репозитории.
     */
    home?: string
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
      async run(cmd, args) {
        calls.push([cmd, ...args])
        return opts.exit ?? 0
      },
      async capture(cmd, args) {
        calls.push(['capture', cmd, ...args])
        return opts.capture?.(cmd, args) ?? { code: 1, stdout: '', stderr: '' }
      },
    },
  })
  return { code, out, err, calls, asked }
}

/** Настоящие запуски: чтение состояния (capture) вызовом не считается. */
function spawned(result: Harness): Call[] {
  return result.calls.filter((call) => call[0] !== 'capture')
}

/** Сервер жив: расписка на месте и kill -0 отвечает. */
const ALIVE = {
  files: { '/repo/.colloq.pid': '4242\n' },
  capture: (cmd: string) => ({
    code: cmd === 'kill' ? 0 : 1,
    stdout: '',
    stderr: '',
  }),
}

// ------------------------------------------------------------------ запуск

const LAUNCH = 'node --import tsx /repo/cli/src/launch.ts'

/**
 * Расписка идущего занятия так, как её пишет супервизор.
 *
 * Полем, а не огрызком `{pid, port, mode}`: читает её теперь общий readSession
 * (cli/src/session.ts), и без url с runId он честно отвечает «расписки нет» —
 * то же, что видит человек, когда файл дописан наполовину.
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

/** Каталог состояния установленного colloq: код отдельно, занятие отдельно. */
const HOME = '/home/teacher/.colloq'

const SESSION = {
  files: { '/repo/.colloq/local-session.json': JSON.stringify(RECEIPT) },
}

test('run: foreground launcher, aliases and flags have one exact dry-run command', async () => {
  for (const argv of [[], ['run'], ['start']]) {
    assert.deepEqual((await run([...argv, '--dry-run'])).out, [LAUNCH + ' run'])
  }
  for (const flags of [['--fast'], ['FAST=1']]) {
    assert.deepEqual((await run(['run', ...flags, '--dry-run'])).out, [LAUNCH + ' run --fast'])
  }
  assert.deepEqual(
    (
      await run([
        'run',
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
  assert.deepEqual(
    (
      await run([
        'run',
        'HOST=hse.colloq.ru',
        'DETACH=1',
        'PORT=4100',
        'OPEN=0',
        'FAST=1',
        '--dry-run',
      ])
    ).out,
    [LAUNCH + ' run --host hse.colloq.ru --detach --port 4100 --no-open --fast'],
  )
  assert.deepEqual((await run(['run', "DATA_DIR=folder with 'quote'", '--dry-run'])).out, [
    "DATA_DIR='folder with '\\''quote'\\''' " + LAUNCH + ' run',
  ])
})

test('run: launch never asks to restart a busy server and preserves launcher exit', async () => {
  for (const argv of [[], ['run'], ['run', '--yes']]) {
    const result = await run(argv, { tty: true, answer: 'n', ...ALIVE, exit: 3 })
    assert.equal(result.code, 3)
    assert.deepEqual(result.asked, [])
    assert.deepEqual(result.calls, [['node', '--import', 'tsx', '/repo/cli/src/launch.ts', 'run']])
  }
})

test('run/dev: invalid ports and host names fail before launcher or prompts', async () => {
  for (const argv of [
    ['run', '--port', '0'],
    ['run', '--port', '65536'],
    ['dev', '--port', '3.5'],
    ['dev', '--port', ''],
    ['run', '--host', 'https://hse.colloq.ru'],
    ['run', '--host', ''],
    ['run', '--direct'],
  ]) {
    const result = await run(argv, { tty: true, answer: 'y' })
    assert.equal(result.code, 2, argv.join(' '))
    assert.deepEqual(result.calls, [])
    assert.deepEqual(result.asked, [])
  }
})

test('stop/restart: new receipt selects supervisor without legacy probing', async () => {
  for (const command of ['stop', 'restart']) {
    const result = await run([command, '--dry-run'], SESSION)
    assert.deepEqual(result.out, [LAUNCH + ' ' + command])
    assert.deepEqual(result.calls, [])
    const live = await run([command, '--yes'], SESSION)
    assert.deepEqual(spawned(live), [
      ['node', '--import', 'tsx', '/repo/cli/src/launch.ts', command],
    ])
  }
  assert.deepEqual((await run(['restart', '--build', '--fast', '--dry-run'], SESSION)).out, [
    LAUNCH + ' restart --build --fast',
  ])
})

test('stop: вопрос каркаса, «нет» — код 4, --yes снимает', async () => {
  assert.deepEqual((await run(['stop', '--dry-run'])).out, ['make stop'])

  const no = await run(['stop'], { tty: true, answer: 'n' })
  assert.equal(no.code, 4)
  assert.deepEqual(spawned(no), [])

  const yes = await run(['stop', '--yes'], { tty: true })
  assert.deepEqual(yes.asked, [])
  assert.deepEqual(spawned(yes), [['make', 'stop']])
})

test('restart: строка зависит от формы, кластеру отказ', async () => {
  assert.deepEqual((await run(['restart', '--dry-run'])).out, ['make restart'])

  const host = await run(['restart', '--dry-run'], ALIVE)
  assert.deepEqual(host.out, ['make stop && make run'])

  const build = await run(['restart', '--build', '--fast', '--dry-run'], ALIVE)
  assert.deepEqual(build.out, ['npm run build && make stop && make run FAST=1'])

  const service = await run(['restart', '--dry-run'], {
    files: { '/etc/systemd/system/colloq.service': '[Unit]' },
    capture: (cmd) => ({ code: cmd === 'systemctl' ? 0 : 1, stdout: '', stderr: '' }),
  })
  assert.deepEqual(service.out, ['make service-restart'])

  const cluster = await run(['restart'], {
    tty: true,
    answer: 'y',
    files: { '/repo/.env': 'COLLOQ_CLUSTER=1\nPORT=4000' },
  })
  assert.equal(cluster.code, 3)
  assert.deepEqual(spawned(cluster), [])
  assert.match(cluster.err.join('\n'), /k3s cluster/)
  assert.match(cluster.err.join('\n'), /colloq cluster stop/)
})

test('restart: спрашивает сам, --build говорит про web/dist', async () => {
  const no = await run(['restart'], { tty: true, answer: 'n' })
  assert.equal(no.code, 4)
  assert.deepEqual(spawned(no), [])
  assert.match(no.asked[0] ?? '', /restart the server\?/)

  const build = await run(['restart', '--build'], { tty: true, answer: 'n' })
  assert.match(build.asked[0] ?? '', /web\/dist changes on the fly/)

  const host = await run(['restart', '--build', '--yes'], { tty: true, ...ALIVE })
  assert.deepEqual(host.asked, [])
  assert.deepEqual(spawned(host), [
    ['npm', 'run', 'build:optimized'],
    ['make', 'stop'],
    ['make', 'run'],
  ])
})

test('restart: неудачная сборка останавливает перезапуск, код уходит наружу', async () => {
  const result = await run(['restart', '--build', '--yes'], { tty: true, exit: 2 })
  assert.equal(result.code, 2)
  assert.deepEqual(spawned(result), [['npm', 'run', 'build:optimized']])
})

test('up и down: вопрос каркаса и одна строка make', async () => {
  assert.deepEqual((await run(['up', '--dry-run'])).out, ['make up'])
  assert.deepEqual((await run(['down', '--dry-run'])).out, ['make down'])

  const no = await run(['down'], { tty: true, answer: 'n' })
  assert.equal(no.code, 4)
  assert.deepEqual(spawned(no), [])
  assert.match(no.asked[0] ?? '', /stop everything in docker\?/)

  const yes = await run(['up', '--yes'], { tty: true })
  assert.deepEqual(spawned(yes), [['make', 'up']])
})

test('ps: докерный взгляд уходит в make status', async () => {
  assert.deepEqual((await run(['ps', '--dry-run'])).out, ['make status'])
  assert.deepEqual(spawned(await run(['ps'])), [['make', 'status']])
})

// ------------------------------------------------------------------ журнал

test('logs: без флага форма решает, какой журнал', async () => {
  assert.deepEqual((await run(['logs', '--dry-run'])).out, ['make logs'])
  assert.deepEqual((await run(['logs', '--dry-run'], ALIVE)).out, ['tail -f /repo/.colloq.log'])
  assert.deepEqual(
    (
      await run(['log', '--dry-run'], {
        files: { '/etc/systemd/system/colloq.service': 'x' },
        capture: (cmd) => ({ code: cmd === 'systemctl' ? 0 : 1, stdout: '', stderr: '' }),
      })
    ).out,
    ['make service-logs'],
  )
})

test('logs: -n и --no-follow меняют вызов, а не журнал', async () => {
  assert.deepEqual((await run(['logs', '--docker', '-n', '200', '--dry-run'])).out, [
    'docker compose logs -f --tail=200',
  ])
  assert.deepEqual((await run(['logs', '--docker', '--no-follow', '--dry-run'])).out, [
    'docker compose logs --tail=80',
  ])
  assert.deepEqual((await run(['logs', '--server', '-n', '200', '--dry-run'])).out, [
    'tail -f -n 200 /repo/.colloq.log',
  ])
  assert.deepEqual((await run(['logs', '--server', '--no-follow', '--dry-run'])).out, [
    'tail /repo/.colloq.log',
  ])
})

test('logs: спорные флаги — код 2, ничего не запущено', async () => {
  for (const argv of [
    ['logs', '--server', '--docker'],
    ['logs', '-f', '--no-follow'],
    ['logs', '-n', 'many'],
    ['logs', '-n', '0'],
  ]) {
    const result = await run(argv)
    assert.equal(result.code, 2, argv.join(' '))
    assert.deepEqual(spawned(result), [], argv.join(' '))
  }
})

test('logs --server без .colloq.log — отказ 3 и подсказка', async () => {
  const result = await run(['logs', '--server'])
  assert.equal(result.code, 3)
  assert.deepEqual(spawned(result), [])
  assert.match(result.err.join('\n'), /no \.colloq\.log/)
  assert.match(result.err.join('\n'), /colloq logs --docker/)

  const there = await run(['logs', '--server'], { files: { '/repo/.colloq.log': 'line' } })
  assert.deepEqual(spawned(there), [['tail', '-f', '/repo/.colloq.log']])
})

// ------------------------------------------------------------ сборка и проверки

test('dev uses the supervisor; check and shell retain their make targets', async () => {
  assert.deepEqual((await run(['dev', '--dry-run'])).out, [LAUNCH + ' dev'])
  assert.deepEqual((await run(['dev', '--port', '4100', '--no-open', '--dry-run'])).out, [
    LAUNCH + ' dev --port 4100 --no-open',
  ])
  assert.deepEqual((await run(['check', '--dry-run'])).out, ['make check'])
  assert.deepEqual((await run(['shell', '--dry-run'])).out, ['make shell'])
})

test('build: сжатие по умолчанию, --fast без него', async () => {
  assert.deepEqual((await run(['build', '--dry-run'])).out, ['npm run build:optimized'])
  assert.deepEqual((await run(['build', '--fast', '--dry-run'])).out, ['npm run build'])
})

test('build: спрашивает только под живым сервером', async () => {
  const quiet = await run(['build'], { tty: true, answer: 'y' })
  assert.deepEqual(quiet.asked, [])
  assert.deepEqual(spawned(quiet), [['npm', 'run', 'build:optimized']])

  const busy = await run(['build'], { tty: true, answer: 'n', ...ALIVE })
  assert.equal(busy.code, 4)
  assert.deepEqual(spawned(busy), [])
  assert.match(busy.asked[0] ?? '', /the server is running/)
  assert.deepEqual(busy.out, ['cancelled'])

  const forced = await run(['build', '--yes'], { tty: true, ...ALIVE })
  assert.deepEqual(forced.asked, [])
  assert.deepEqual(spawned(forced), [['npm', 'run', 'build:optimized']])
})

test('ui: HEADED=1 и тот же вопрос, что у build', async () => {
  assert.deepEqual((await run(['ui', '--dry-run'])).out, ['make ui'])
  assert.deepEqual((await run(['ui', '--headed', '--dry-run'])).out, ['make ui HEADED=1'])

  const busy = await run(['ui'], { tty: true, answer: 'n', ...ALIVE })
  assert.equal(busy.code, 4)
  assert.deepEqual(spawned(busy), [])
  assert.match(busy.asked[0] ?? '', /web\/dist will be rebuilt/)
})

test('test: без шаблона — make test, с шаблоном — файлы tests/', async () => {
  const files = {
    '/repo/tests/cli-local.test.mts': '',
    '/repo/tests/council-sheet.test.mts': '',
    '/repo/tests/shell.test.mts': '',
  }
  assert.deepEqual((await run(['test', '--dry-run'], { files })).out, ['make test'])
  assert.deepEqual((await run(['test', 'cli', '--dry-run'], { files })).out, [
    'node --import tsx --import ./tests/_cli.mts --test --test-force-exit --test-concurrency=1 tests/cli-local.test.mts',
  ])
  assert.deepEqual((await run(['test', 'shell', '--dry-run'], { files })).out, [
    'node --import tsx --import ./tests/_cli.mts --test --test-force-exit --test-concurrency=1 tests/shell.test.mts',
  ])
})

test('test: шаблон ни во что не попал — отказ 1, каталог не тот — 2', async () => {
  const empty = await run(['test', 'nothing'], { files: { '/repo/tests/a.test.mts': '' } })
  assert.equal(empty.code, 1)
  assert.deepEqual(spawned(empty), [])
  assert.match(empty.err.join('\n'), /no tests match/)

  const wrong = await run(['test', 'tests/a.test.mts'])
  assert.equal(wrong.code, 2)
  assert.deepEqual(spawned(wrong), [])
})

// ------------------------------------------------------------------ прочее

test('link: адрес печатается, токен — никогда', async () => {
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

test('link: local receipt wins over .env and only its current lease is public', async () => {
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
      capture: ALIVE.capture,
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

test('docker-gid: спрашивает, пока строки в .env нет', async () => {
  assert.deepEqual((await run(['docker-gid', '--dry-run'])).out, ['make docker-gid'])

  const no = await run(['docker-gid'], { tty: true, answer: 'n' })
  assert.equal(no.code, 4)
  assert.deepEqual(spawned(no), [])
  assert.match(no.asked[0] ?? '', /append DOCKER_GID to \.env\?/)

  const already = await run(['docker-gid'], {
    tty: true,
    answer: 'n',
    files: { '/repo/.env': 'PORT=4000\nDOCKER_GID=101' },
  })
  assert.deepEqual(already.asked, [])
  assert.deepEqual(spawned(already), [['make', 'docker-gid']])
})

// ------------------------------------------------------------ копии

test('backup: режим, среда и пути уходят переменными', async () => {
  assert.deepEqual((await run(['backup', '--dry-run'])).out, [
    'COLLOQ_HOME=/repo make backup MODE=live',
  ])
  assert.deepEqual((await run(['backup', '--mode', 'consistent', '--resume', '--dry-run'])).out, [
    'COLLOQ_HOME=/repo make backup MODE=consistent RESUME=1',
  ])
  assert.deepEqual(
    (await run(['backup', '--name', 'hse', '--out', 'backups/hse/copy.tar.gz', '--dry-run'])).out,
    ['COLLOQ_HOME=/repo make backup MODE=live NAME=hse OUT=/repo/backups/hse/copy.tar.gz'],
  )
  // Путь с пробелом копируется целиком: строка --dry-run для того и печатается.
  assert.deepEqual((await run(['backup', '--out', 'backup of the day.tar.gz', '--dry-run'])).out, [
    "COLLOQ_HOME=/repo make backup MODE=live 'OUT=/repo/backup of the day.tar.gz'",
  ])
  assert.deepEqual((await run(['backup', '--legacy', '--dry-run'])).out, [
    'COLLOQ_HOME=/repo make backup-legacy',
  ])
})

test('backup: consistent спрашивает, live — нет; пара MODE= тоже спрашивает', async () => {
  const live = await run(['backup'], { tty: true, answer: 'n' })
  assert.equal(live.code, 0)
  assert.deepEqual(live.asked, [])
  assert.deepEqual(spawned(live), [['make', 'backup', 'MODE=live']])

  const no = await run(['backup', '--mode', 'consistent'], { tty: true, answer: 'n' })
  assert.equal(no.code, 4)
  assert.deepEqual(spawned(no), [])
  assert.match(no.asked[0] ?? '', /stop every writer\? without --resume/)

  const pair = await run(['backup', 'MODE=consistent'], { tty: true, answer: 'n' })
  assert.equal(pair.code, 4)
  assert.deepEqual(spawned(pair), [])

  const forced = await run(['backup', '--mode', 'consistent', '--resume', '--yes'], { tty: true })
  assert.deepEqual(forced.asked, [])
  assert.deepEqual(spawned(forced), [['make', 'backup', 'MODE=consistent', 'RESUME=1']])
})

test('backup: спорные флаги — отказ до делегирования', async () => {
  for (const argv of [
    ['backup', '--mode', 'half'],
    ['backup', '--resume'],
    ['backup', '--legacy', '--mode', 'consistent'],
    ['backup', '--legacy', '--name', 'hse'],
    ['backup', '--name', '-hse'],
  ]) {
    const result = await run(argv, { tty: true, answer: 'y' })
    assert.equal(result.code, 2, argv.join(' '))
    assert.deepEqual(spawned(result), [], argv.join(' '))
  }
})

test('restore: переносимая ветка требует оба файла и спрашивает сама', async () => {
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
      'COLLOQ_HOME=/repo make restore ARCHIVE=/repo/colloq-20260914.tar.gz RELEASE=/repo/release.json',
    ],
  )

  const half = await run(['restore', '--archive', 'colloq-20260914.tar.gz'])
  assert.equal(half.code, 2)
  assert.deepEqual(spawned(half), [])
  assert.match(half.err.join('\n'), /no --release <file>/)

  const files = { '/repo/colloq-20260914.tar.gz': 'archive', '/repo/release.json': '{}' }
  const no = await run(
    ['restore', '--archive', 'colloq-20260914.tar.gz', '--release', 'release.json'],
    {
      tty: true,
      answer: 'n',
      files,
    },
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
      '--recover',
      '--yes',
    ],
    { tty: true, files },
  )
  assert.deepEqual(yes.asked, [])
  // --yes снимает вопрос, и только его: REPLACE=1 отсюда не берётся.
  assert.deepEqual(spawned(yes), [
    [
      'make',
      'restore',
      'ARCHIVE=/repo/colloq-20260914.tar.gz',
      'RELEASE=/repo/release.json',
      'RECOVER=1',
    ],
  ])
})

test('restore: поверх живой базы разворачивают только по --replace, не по --yes', async () => {
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
    const line = (spawned(result)[0] ?? []).join(' ')
    assert.equal(line.includes('REPLACE=1'), false, argv.join(' '))
  }

  const asked = await run(['restore', '--legacy', '--db', 'colloq-20260914.db', '--replace'], {
    tty: true,
    files,
  })
  assert.deepEqual(spawned(asked), [
    ['make', 'restore-legacy', 'DB=/repo/colloq-20260914.db', 'REPLACE=1'],
  ])

  // Пара REPLACE=1 из командной строки работает так же, как флаг.
  const paired = await run(['restore', '--legacy', '--db', 'colloq-20260914.db', 'REPLACE=1'], {
    tty: true,
    files,
  })
  assert.deepEqual(spawned(paired), [
    ['make', 'restore-legacy', 'DB=/repo/colloq-20260914.db', 'REPLACE=1'],
  ])
})

test('restore --legacy: вопроса от нас нет, спрашивает скрипт', async () => {
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
    [
      'COLLOQ_HOME=/repo make restore-legacy DB=/repo/colloq-20260914.db FILES=/repo/colloq-20260914-files.tar.gz',
    ],
  )

  const result = await run(['restore', '--legacy', '--db', 'colloq-20260914.db'], {
    tty: true,
    answer: 'n',
    files: { '/repo/colloq-20260914.db': 'database' },
  })
  assert.equal(result.code, 0)
  assert.deepEqual(result.asked, [])
  assert.deepEqual(spawned(result), [['make', 'restore-legacy', 'DB=/repo/colloq-20260914.db']])
})

test('restore: миры не смешиваются, файла нет — отказ 3', async () => {
  for (const argv of [
    ['restore', '--legacy', '--archive', 'colloq-20260914.tar.gz', '--db', 'colloq-20260914.db'],
    ['restore', '--legacy'],
    ['restore'],
  ]) {
    const result = await run(argv, { tty: true, answer: 'y' })
    assert.equal(result.code, 2, argv.join(' '))
    assert.deepEqual(spawned(result), [], argv.join(' '))
  }

  const gone = await run(['restore', '--legacy', '--db', 'missing.db'], { tty: true, answer: 'y' })
  assert.equal(gone.code, 3)
  assert.deepEqual(spawned(gone), [])
  assert.match(gone.err.join('\n'), /no file \/repo\/missing\.db/)

  const noRelease = await run(
    ['restore', '--archive', 'colloq-20260914.tar.gz', '--release', 'missing.json'],
    {
      tty: true,
      answer: 'y',
      files: { '/repo/colloq-20260914.tar.gz': 'archive' },
    },
  )
  assert.equal(noRelease.code, 3)
  assert.deepEqual(spawned(noRelease), [])
})

/**
 * Установленный colloq запускает бандл, а не исходник.
 *
 * Ошибка, ради которой это записано: из колеса `colloq start --dry-run` печатал
 * `node --import tsx …/_app/cli/src/launch.ts run` — путь репозитория, которого
 * в пакете нет вовсе, и запуск падал на ERR_MODULE_NOT_FOUND. Проверяются обе
 * дороги сразу: в репозитории по-прежнему tsx и .ts.
 */
test('у установленного colloq запуск идёт через бандл, в репозитории — через tsx', async () => {
  const dist = await run(['start', '--dry-run'], { dist: true })
  assert.equal(dist.code, 0)
  const line = dist.out.join('\n')
  assert.match(line, /cli\/launch\.mjs run/)
  assert.doesNotMatch(line, /tsx|launch\.ts/)

  const repo = await run(['start', '--dry-run'])
  assert.match(repo.out.join('\n'), /--import tsx .*cli\/src\/launch\.ts run/)
})

test('stop у установленного colloq отвечает словами, не целью make', async () => {
  const dist = await run(['stop', '--yes'], { dist: true })
  assert.equal(dist.code, 0)
  assert.deepEqual(dist.calls, [])
  assert.match(dist.out.join('\n'), /nothing to stop/)
})

/**
 * Два корня: код отдельно, занятие отдельно.
 *
 * Ошибка, ради которой записано: расписку сессии команды искали как
 * ctx.env.path('.colloq/local-session.json') — от каталога ПРИЛОЖЕНИЯ, — а
 * супервизор пишет её в каталог состояния. У установленного colloq это
 * разные каталоги, и `colloq stop` под работающим сервером отвечал «занятие
 * не идёт — останавливать нечего». Проверяется главное: расписка читается
 * там, где её пишут, и только там.
 */
test('расписка сессии читается в каталоге состояния, а не рядом с кодом', async () => {
  const live = await run(['stop', '--yes'], {
    dist: true,
    home: HOME,
    files: { [HOME + '/.colloq/local-session.json']: JSON.stringify(RECEIPT) },
  })
  assert.equal(live.code, 0)
  assert.deepEqual(spawned(live), [['node', '/repo/cli/launch.mjs', 'stop']])
  assert.doesNotMatch(live.out.join('\n'), /nothing to stop/)

  // Та же расписка рядом с кодом — чужой корень: её нет для нас вовсе.
  const beside = await run(['stop', '--yes'], {
    dist: true,
    home: HOME,
    files: { '/repo/.colloq/local-session.json': JSON.stringify(RECEIPT) },
  })
  assert.deepEqual(beside.calls, [])
  assert.match(beside.out.join('\n'), /nothing to stop/)

  // Тот же корень ведёт и перезапуск, и адрес занятия.
  const restart = await run(['restart', '--yes'], {
    dist: true,
    home: HOME,
    tty: true,
    files: { [HOME + '/.colloq/local-session.json']: JSON.stringify(RECEIPT) },
  })
  assert.deepEqual(spawned(restart), [['node', '/repo/cli/launch.mjs', 'restart']])
})

test('link: адрес занятия и пути входа берутся из каталога состояния целиком', async () => {
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
    capture: ALIVE.capture,
  })
  assert.equal(result.code, 0)
  const text = result.out.join('\n')
  // Локальный адрес в расписке есть — и он же единственный, откуда его берут.
  assert.match(text, /local.*http:\/\/localhost:4100/)
  // Пути называются целиком: в рабочей папке человека этих файлов нет.
  assert.ok(text.includes(HOME + '/.colloq.log'), text)
  assert.ok(text.includes(HOME + '/data/setup-token'), text)
  assert.doesNotMatch(text, /admin\/t\//)
})

test('restart у установленного colloq без расписки отказывает словами, не целью make', async () => {
  for (const argv of [
    ['restart', '--yes'],
    ['restart', '--build', '--yes'],
    ['restart', '--dry-run'],
  ]) {
    const result = await run(argv, {
      dist: true,
      home: HOME,
      tty: true,
      // Прежний запуск на хосте: pid-файл есть, и раньше он уводил в make.
      files: { [HOME + '/.colloq.pid']: '4242\n' },
      capture: ALIVE.capture,
    })
    assert.equal(result.code, 3, argv.join(' '))
    assert.deepEqual(result.calls, [], argv.join(' '))
    assert.deepEqual(result.asked, [], argv.join(' '))
    assert.match(result.err.join('\n'), /nothing to restart/)
    assert.match(result.err.join('\n'), /colloq start/)
  }
})

test('logs: хвост журнала читается своим tail, а не целью make logs-run', async () => {
  const dist = await run(['logs', '--server'], {
    dist: true,
    home: HOME,
    files: { [HOME + '/.colloq.log']: 'line' },
  })
  assert.deepEqual(spawned(dist), [['tail', '-f', HOME + '/.colloq.log']])

  // Форма «хост» выбирает тот же журнал и тот же вызов: make тут больше нет.
  const host = await run(['logs', '--dry-run'], {
    home: HOME,
    files: { [HOME + '/.colloq.pid']: '4242\n' },
    capture: ALIVE.capture,
  })
  assert.deepEqual(host.out, ['tail -f ' + HOME + '/.colloq.log'])
})

test('копии снимаются с каталога состояния: COLLOQ_HOME уходит make и скриптам', async () => {
  const files = {
    [HOME + '/.env']: 'PORT=4000',
    [HOME + '/colloq-20260914.tar.gz']: 'archive',
    [HOME + '/release.json']: '{}',
    [HOME + '/colloq-20260914.db']: 'database',
  }
  const lines: Record<string, string> = {
    backup: 'COLLOQ_HOME=' + HOME + ' make backup MODE=live',
    'backup --legacy': 'COLLOQ_HOME=' + HOME + ' make backup-legacy',
  }
  for (const [argv, line] of Object.entries(lines)) {
    const result = await run([...argv.split(' '), '--dry-run'], { home: HOME, files })
    assert.deepEqual(result.out, [line], argv)
  }

  const portable = await run(
    [
      'restore',
      '--archive',
      HOME + '/colloq-20260914.tar.gz',
      '--release',
      HOME + '/release.json',
      '--dry-run',
    ],
    { home: HOME, files },
  )
  assert.deepEqual(portable.out, [
    'COLLOQ_HOME=' +
      HOME +
      ' make restore ARCHIVE=' +
      HOME +
      '/colloq-20260914.tar.gz RELEASE=' +
      HOME +
      '/release.json',
  ])

  const legacy = await run(
    ['restore', '--legacy', '--db', HOME + '/colloq-20260914.db', '--dry-run'],
    { home: HOME, files },
  )
  assert.deepEqual(legacy.out, [
    'COLLOQ_HOME=' + HOME + ' make restore-legacy DB=' + HOME + '/colloq-20260914.db',
  ])
})

/**
 * У поставленного colloq копии делают скрипты, а не make.
 *
 * Ошибка, ради которой это записано: `colloq backup --dry-run` из колеса
 * печатал `COLLOQ_HOME=… make backup MODE=live` — а make в пакете нет вовсе,
 * Makefile туда не едет. Единственный способ унести занятие с машины умирал
 * кодом 127. Проверено живьём. Заодно закрепляется умолчание: без флагов
 * снимается ЛОКАЛЬНАЯ копия — переносимая требует установленного релиза k3s,
 * которого у преподавателя нет и не будет.
 */
test('у установленного colloq копия снимается скриптом, и без флагов — локальная', async () => {
  const files = { [HOME + '/.env']: 'PORT=4000' }
  const at = { dist: true, home: HOME, files }
  const script = 'COLLOQ_HOME=' + HOME + ' ./scripts/backup-local.sh'

  assert.deepEqual((await run(['backup', '--dry-run'], at)).out, [script])
  assert.deepEqual((await run(['backup', '--legacy', '--dry-run'], at)).out, [script])

  // И это настоящий вызов, а не только строка --dry-run: make здесь не зовут.
  const real = await run(['backup', '--yes'], at)
  assert.equal(real.code, 0)
  assert.deepEqual(spawned(real), [['./scripts/backup-local.sh']])

  // Названный вслух флаг переносимой копии уводит в неё — и тоже скриптом:
  // backup.sh читает MODE, RESUME, NAME, OUT и RELEASE окружением.
  assert.deepEqual(
    (await run(['backup', '--mode', 'consistent', '--resume', '--dry-run'], at)).out,
    ['COLLOQ_HOME=' + HOME + ' MODE=consistent RESUME=1 ./scripts/backup.sh'],
  )
  // Пара, написанная руками, доходит так же: make экспортировал бы её в рецепт.
  assert.deepEqual((await run(['backup', 'NAME=hse', '--dry-run'], at)).out, [
    'COLLOQ_HOME=' + HOME + ' NAME=hse MODE=live ./scripts/backup.sh',
  ])

  // В репозитории ничего не сдвинулось: цель Makefile и прежнее умолчание.
  assert.deepEqual((await run(['backup', '--dry-run'])).out, [
    'COLLOQ_HOME=/repo make backup MODE=live',
  ])
  assert.deepEqual((await run(['backup', '--legacy', '--dry-run'])).out, [
    'COLLOQ_HOME=/repo make backup-legacy',
  ])
})

/**
 * Разворачивание у поставленного colloq — тот же скрипт теми же аргументами.
 *
 * Цель restore-legacy отдаёт пути аргументами, а имя среды и REPLACE —
 * переменными; прямой вызов обязан вести себя так же, иначе одна и та же
 * команда в репозитории и у преподавателя значила бы разное.
 */
test('у установленного colloq копия разворачивается скриптом: пути аргументом, остальное окружением', async () => {
  const db = HOME + '/colloq-20260914.db'
  const arch = HOME + '/colloq-20260914-files.tar.gz'
  const at = {
    dist: true,
    home: HOME,
    files: {
      [HOME + '/.env']: 'PORT=4000',
      [db]: 'database',
      [arch]: 'archive',
      [HOME + '/release.json']: '{}',
    },
  }

  assert.deepEqual(
    (await run(['restore', '--legacy', '--db', db, '--files', arch, '--dry-run'], at)).out,
    ['COLLOQ_HOME=' + HOME + ' ./scripts/restore.sh ' + db + ' ' + arch],
  )
  // Архива в аргументах не было — пустой строкой он не уходит: restore.sh
  // разбирает аргументы по расширению и на пустой умирает «не понимаю «»».
  assert.deepEqual(
    (await run(['restore', '--legacy', '--db', db, '--name', 'hse', '--replace', '--dry-run'], at))
      .out,
    ['COLLOQ_HOME=' + HOME + ' NAME=hse REPLACE=1 ./scripts/restore.sh ' + db],
  )
  assert.deepEqual(
    (
      await run(
        ['restore', '--archive', arch, '--release', HOME + '/release.json', '--dry-run'],
        at,
      )
    ).out,
    [
      'COLLOQ_HOME=' +
        HOME +
        ' ./scripts/restore.sh --archive ' +
        arch +
        ' --release ' +
        HOME +
        '/release.json',
    ],
  )

  // Настоящий вызов — тот же, и make в нём не участвует.
  const real = await run(['restore', '--legacy', '--db', db], { ...at, tty: true, answer: 'y' })
  assert.deepEqual(spawned(real), [['./scripts/restore.sh', db]])
})
