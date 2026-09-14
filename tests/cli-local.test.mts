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
  '/repo/Makefile': ['run: ## Собрать и запустить', 'ps: status'].join('\n'),
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

test('run: строка make, FAST флагом и парой, дубля пары не бывает', async () => {
  assert.deepEqual((await run(['run', '--dry-run'])).out, ['make run'])
  assert.deepEqual((await run(['run', '--fast', '--dry-run'])).out, ['make run FAST=1'])
  assert.deepEqual((await run(['run', 'FAST=1', '--dry-run'])).out, ['make run FAST=1'])
  assert.deepEqual((await run(['start', '--dry-run'])).out, ['make run'])
})

test('run: спрашивает только под живым сервером', async () => {
  const quiet = await run(['run'], { tty: true, answer: 'y' })
  assert.equal(quiet.code, 0)
  assert.deepEqual(quiet.asked, [])
  assert.deepEqual(spawned(quiet), [['make', 'run']])

  const busy = await run(['run'], { tty: true, answer: 'n', ...ALIVE })
  assert.equal(busy.code, 4)
  assert.deepEqual(spawned(busy), [])
  assert.match(busy.asked[0] ?? '', /перезапустить сервер\? \[y\/N\]/)
  assert.deepEqual(busy.out, ['отменено'])

  const forced = await run(['run', '--yes'], { tty: true, ...ALIVE })
  assert.deepEqual(forced.asked, [])
  assert.deepEqual(spawned(forced), [['make', 'run']])
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
  assert.match(cluster.err.join('\n'), /кластер k3s/)
  assert.match(cluster.err.join('\n'), /colloq cluster stop/)
})

test('restart: спрашивает сам, --build говорит про web/dist', async () => {
  const no = await run(['restart'], { tty: true, answer: 'n' })
  assert.equal(no.code, 4)
  assert.deepEqual(spawned(no), [])
  assert.match(no.asked[0] ?? '', /перезапустить сервер\?/)

  const build = await run(['restart', '--build'], { tty: true, answer: 'n' })
  assert.match(build.asked[0] ?? '', /web\/dist меняется на лету/)

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
  assert.match(no.asked[0] ?? '', /остановить всё в docker\?/)

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
  assert.deepEqual((await run(['logs', '--dry-run'], ALIVE)).out, ['make logs-run'])
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
    ['logs', '-n', 'много'],
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
  assert.match(result.err.join('\n'), /нет \.colloq\.log/)
  assert.match(result.err.join('\n'), /colloq logs --docker/)

  const there = await run(['logs', '--server'], { files: { '/repo/.colloq.log': 'строка' } })
  assert.deepEqual(spawned(there), [['make', 'logs-run']])
})

// ------------------------------------------------------------ сборка и проверки

test('dev, check, shell: по одной цели make', async () => {
  assert.deepEqual((await run(['dev', '--dry-run'])).out, ['make dev'])
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
  assert.match(busy.asked[0] ?? '', /сервер работает/)
  assert.deepEqual(busy.out, ['отменено'])

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
  assert.match(busy.asked[0] ?? '', /web\/dist пересоберётся/)
})

test('test: без шаблона — make test, с шаблоном — файлы tests/', async () => {
  const files = {
    '/repo/tests/cli-local.test.mts': '',
    '/repo/tests/council-sheet.test.mts': '',
    '/repo/tests/shell.test.mts': '',
  }
  assert.deepEqual((await run(['test', '--dry-run'], { files })).out, ['make test'])
  assert.deepEqual((await run(['test', 'cli', '--dry-run'], { files })).out, [
    'node --import tsx --test --test-force-exit --test-concurrency=1 tests/cli-local.test.mts',
  ])
  assert.deepEqual((await run(['test', 'shell', '--dry-run'], { files })).out, [
    'node --import tsx --test --test-force-exit --test-concurrency=1 tests/shell.test.mts',
  ])
})

test('test: шаблон ни во что не попал — отказ 1, каталог не тот — 2', async () => {
  const empty = await run(['test', 'ничего'], { files: { '/repo/tests/a.test.mts': '' } })
  assert.equal(empty.code, 1)
  assert.deepEqual(spawned(empty), [])
  assert.match(empty.err.join('\n'), /нет тестов по шаблону/)

  const wrong = await run(['test', 'tests/a.test.mts'])
  assert.equal(wrong.code, 2)
  assert.deepEqual(spawned(wrong), [])
})

// ------------------------------------------------------------------ прочее

test('link: адрес печатается, токен — никогда', async () => {
  assert.deepEqual((await run(['link', '--dry-run'])).out, [
    'native: link (читает PUBLIC_URL и RELAY_DOMAIN из .env)',
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
  assert.match(inside.out.join('\n'), /наружу не выставлен/)
  assert.match(inside.out.join('\n'), /colloq host/)
})

test('docker-gid: спрашивает, пока строки в .env нет', async () => {
  assert.deepEqual((await run(['docker-gid', '--dry-run'])).out, ['make docker-gid'])

  const no = await run(['docker-gid'], { tty: true, answer: 'n' })
  assert.equal(no.code, 4)
  assert.deepEqual(spawned(no), [])
  assert.match(no.asked[0] ?? '', /дописать DOCKER_GID в \.env\?/)

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
  assert.deepEqual((await run(['backup', '--dry-run'])).out, ['make backup MODE=live'])
  assert.deepEqual((await run(['backup', '--mode', 'consistent', '--resume', '--dry-run'])).out, [
    'make backup MODE=consistent RESUME=1',
  ])
  assert.deepEqual(
    (await run(['backup', '--name', 'hse', '--out', 'backups/hse/copy.tar.gz', '--dry-run'])).out,
    ['make backup MODE=live NAME=hse OUT=/repo/backups/hse/copy.tar.gz'],
  )
  // Путь с пробелом копируется целиком: строка --dry-run для того и печатается.
  assert.deepEqual((await run(['backup', '--out', 'копия дня.tar.gz', '--dry-run'])).out, [
    "make backup MODE=live 'OUT=/repo/копия дня.tar.gz'",
  ])
  assert.deepEqual((await run(['backup', '--legacy', '--dry-run'])).out, ['make backup-legacy'])
})

test('backup: consistent спрашивает, live — нет; пара MODE= тоже спрашивает', async () => {
  const live = await run(['backup'], { tty: true, answer: 'n' })
  assert.equal(live.code, 0)
  assert.deepEqual(live.asked, [])
  assert.deepEqual(spawned(live), [['make', 'backup', 'MODE=live']])

  const no = await run(['backup', '--mode', 'consistent'], { tty: true, answer: 'n' })
  assert.equal(no.code, 4)
  assert.deepEqual(spawned(no), [])
  assert.match(no.asked[0] ?? '', /остановить всех писателей\? без --resume/)

  const pair = await run(['backup', 'MODE=consistent'], { tty: true, answer: 'n' })
  assert.equal(pair.code, 4)
  assert.deepEqual(spawned(pair), [])

  const forced = await run(['backup', '--mode', 'consistent', '--resume', '--yes'], { tty: true })
  assert.deepEqual(forced.asked, [])
  assert.deepEqual(spawned(forced), [['make', 'backup', 'MODE=consistent', 'RESUME=1']])
})

test('backup: спорные флаги — отказ до делегирования', async () => {
  for (const argv of [
    ['backup', '--mode', 'полу'],
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
    ['make restore ARCHIVE=/repo/colloq-20260914.tar.gz RELEASE=/repo/release.json'],
  )

  const half = await run(['restore', '--archive', 'colloq-20260914.tar.gz'])
  assert.equal(half.code, 2)
  assert.deepEqual(spawned(half), [])
  assert.match(half.err.join('\n'), /нет --release <файл>/)

  const files = { '/repo/colloq-20260914.tar.gz': 'архив', '/repo/release.json': '{}' }
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
  assert.match(no.asked[0] ?? '', /развернуть поверх\? кластер будет остановлен/)

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
    '/repo/colloq-20260914.tar.gz': 'архив',
    '/repo/release.json': '{}',
    '/repo/colloq-20260914.db': 'база',
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
    ['make restore-legacy DB=/repo/colloq-20260914.db FILES=/repo/colloq-20260914-files.tar.gz'],
  )

  const result = await run(['restore', '--legacy', '--db', 'colloq-20260914.db'], {
    tty: true,
    answer: 'n',
    files: { '/repo/colloq-20260914.db': 'база' },
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

  const gone = await run(['restore', '--legacy', '--db', 'нет.db'], { tty: true, answer: 'y' })
  assert.equal(gone.code, 3)
  assert.deepEqual(spawned(gone), [])
  assert.match(gone.err.join('\n'), /нет файла \/repo\/нет\.db/)

  const noRelease = await run(
    ['restore', '--archive', 'colloq-20260914.tar.gz', '--release', 'нет.json'],
    {
      tty: true,
      answer: 'y',
      files: { '/repo/colloq-20260914.tar.gz': 'архив' },
    },
  )
  assert.equal(noRelease.code, 3)
  assert.deepEqual(spawned(noRelease), [])
})
