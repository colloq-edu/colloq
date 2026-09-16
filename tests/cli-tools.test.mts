/**
 * Инструменты: status, doctor, activity, site, course, load, make.
 *
 * Ни один процесс здесь не запускается и ни один настоящий файл не читается:
 * исполнитель подменён (вызовы падают в массив, ответы — из таблицы теста),
 * файловая система — карта в памяти, вывод — массив строк. Проверяется то, на
 * что человек смотрит: строка делегирования под --dry-run, отказ до первого
 * действия и вопрос перед тем, что меняет чужое.
 */
import './_cli.mjs'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { cli } from '../cli/src/main.js'
import { registry } from '../cli/src/registry.js'
import { createMemoryIo } from '../cli/src/env.js'

const ROOT = '/repo'
const NOW = 1_700_000_000_000

const FILES: Record<string, string> = {
  '/repo/package.json': '{ "name": "colloq", "version": "0.1.0" }',
  '/repo/cli/package.json': '{ "name": "@colloq/cli", "version": "0.1.0" }',
  '/repo/Makefile': ['activity:', 'site:', 'course:', 'load:', 'help:'].join('\n'),
  '/repo/.env': [
    'PORT=4000',
    'KERNEL_ENV=cv',
    'RELAY_DOMAIN=hse.colloq.ru',
    'RELAY_ADDR=203.0.113.10',
    'ACTIVITY_SHEET_ID=SHEETID',
  ].join('\n'),
}

type Answer = { code: number; stdout: string; stderr: string }

type Harness = {
  code: number
  out: string[]
  err: string[]
  calls: string[][]
  asked: string[]
  /** Всё, кроме чтений: только то, что действительно запускалось бы. */
  made: string[][]
  text: string
}

const silent: Answer = { code: 1, stdout: '', stderr: '' }

async function run(
  argv: string[],
  opts: {
    files?: Record<string, string>
    answer?: string
    tty?: boolean
    capture?: (cmd: string, args: string[]) => Answer
    /** Установленный colloq: приложение отдельно, состояние отдельно. */
    dist?: boolean
    home?: string
  } = {},
): Promise<Harness> {
  const out: string[] = []
  const err: string[] = []
  const calls: string[][] = []
  const asked: string[] = []
  const io = createMemoryIo({ ...FILES, ...(opts.files ?? {}) }, NOW)
  const code = await cli(argv, {
    io,
    root: ROOT,
    home: opts.home,
    dist: opts.dist ?? false,
    cwd: ROOT,
    out: (line) => void out.push(line),
    err: (line) => void err.push(line),
    tty: opts.tty ?? false,
    // NO_COLOR: строки сравниваются как есть, без escape-последовательностей.
    processEnv: { NO_COLOR: '1' },
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
        return opts.capture ? opts.capture(cmd, args) : silent
      },
    },
  })
  return {
    code,
    out,
    err,
    calls,
    asked,
    made: calls.filter((call) => call[0] !== 'capture'),
    text: out.join('\n'),
  }
}

/** Живая машина: сервер под make run, две комнаты, туннель через ретранслятор. */
function alive(cmd: string, args: string[]): Answer {
  if (cmd === 'ps') return { code: 0, stdout: ' 01:14:23\n', stderr: '' }
  if (cmd === 'docker' && args[0] === 'ps') {
    return { code: 0, stdout: 'room-kernel||running\nroom-kernel||running\n', stderr: '' }
  }
  if (cmd === 'docker' && args[0] === 'image') {
    return { code: 0, stdout: '2026-09-12T10:00:00Z\n', stderr: '' }
  }
  if (cmd === 'pgrep' && args[1] === 'frpc') return { code: 0, stdout: '4990\n', stderr: '' }
  return silent
}

const LIVE: Record<string, string> = {
  '/repo/.env': [
    'PORT=4000',
    'KERNEL_ENV=cv',
    'RELAY_DOMAIN=hse.colloq.ru',
    'RELAY_ADDR=203.0.113.10',
    'ACTIVITY_SHEET_ID=SHEETID',
    'PUBLIC_URL=https://hse.colloq.ru',
  ].join('\n'),
  '/repo/.colloq.pid': '4821\n',
  '/repo/web/dist/index.html': '<!doctype html>',
  '/repo/web/dist/assets/app.js': 'export {}',
  '/repo/backups/colloq-20260905-201332.db': 'db',
  '/repo/.colloq/state.json': JSON.stringify({
    name: 'hse',
    addr: 'hse.colloq.ru',
    gpu: 'RTX 5070',
    last: { command: 'vast up', code: 0, at: NOW - 3_600_000 },
  }),
}

// ------------------------------------------------------------------ status

test('status: --dry-run говорит, что читает, и ничего не запускает', async () => {
  const result = await run(['status', '--dry-run'])
  assert.equal(result.code, 0)
  assert.deepEqual(result.calls, [])
  assert.deepEqual(result.out, [
    'native: status (reads the class receipt, .env, .colloq.pid, docker ps)',
  ])
})

test('status: экран собирается из ps, docker и pgrep, сеть не трогается', async () => {
  const result = await run(['status'], { files: LIVE, capture: alive })
  assert.equal(result.code, 0)
  assert.deepEqual(result.made, [])
  assert.match(result.text, /^Colloq · hse$/m)
  assert.match(result.text, /● server\s+pid 4821 · port 4000 · 1h 14m · make run/)
  assert.match(result.text, /● outside\s+hse\.colloq\.ru · relay \(frpc pid 4990\)/)
  assert.match(result.text, /link\s+https:\/\/hse\.colloq\.ru/)
  assert.match(result.text, /● kernels\s+colloq-kernel:cv, built 12\.09 · rooms with a kernel: 2/)
  assert.match(result.text, /env\s+cv · change: colloq env use <name>/)
  // Адрес машины CLI не запоминает: его печатает скрипт, чужой поток мы не разбираем.
  assert.match(
    result.text,
    /○ vast\s+hse — vast up succeeded .* · RTX 5070 · from memory, no network/,
  )
  assert.match(result.text, /● backup\s+colloq-20260905-201332\.db/)
  // Токен установки и прочие значения .env на экран не попадают.
  assert.equal(result.text.includes('SHEETID'), false)
})

test('status: собранный позже сервера клиент — предупреждение и одна подсказка', async () => {
  const result = await run(['status'], { files: LIVE, capture: alive })
  assert.match(
    result.text,
    /● client\s+web\/dist built \d\d:\d\d — newer than the server \(started \d\d:\d\d\)/,
  )
  const hints = result.out.filter((line) => line.includes('→ colloq restart'))
  assert.equal(hints.length, 1)
})

test('status: docker не ответил — строка про него, остальной экран на месте', async () => {
  const result = await run(['status'], {
    files: LIVE,
    capture: (cmd, args) =>
      cmd === 'docker' ? { code: 124, stdout: '', stderr: '' } : alive(cmd, args),
  })
  assert.equal(result.code, 0)
  assert.match(result.text, /○ kernels\s+docker did not answer in 0\.7s/)
  assert.match(result.text, /● server\s+pid 4821/)
})

test('status: без публикации местный адрес называется один раз', async () => {
  const result = await run(['status'], {
    files: { ...LIVE, '/repo/.env': 'PORT=4000\nKERNEL_ENV=cv\nPUBLIC_URL=http://127.0.0.1:4000' },
    capture: alive,
  })
  assert.equal(result.code, 0)
  assert.match(result.text, /○ outside\s+not published · http:\/\/127\.0\.0\.1:4000 only/)
  // Отдельной строки «ссылка» с тем же адресом нет: её дают, когда есть кому.
  assert.equal(/link/.test(result.text), false)
})

test('status: --short — ровно две строки, ими открывается меню', async () => {
  const result = await run(['status', '--short'], { files: LIVE, capture: alive })
  assert.equal(result.code, 0)
  assert.equal(result.out.length, 2)
  assert.match(result.out[0] ?? '', /● server/)
  assert.match(result.out[1] ?? '', /● outside/)
})

test('status: --json — одна строка и ни одного лишнего значения .env', async () => {
  const result = await run(['status', '--json'], { files: LIVE, capture: alive })
  assert.equal(result.code, 0)
  assert.equal(result.out.length, 1)
  const value = JSON.parse(result.out[0] ?? '{}') as {
    ok: boolean
    server: { form: string; pid: number; port: number; uptimeSec: number }
    client: { stale: boolean }
    public: { url: string; transport: string; tunnelPid: number }
    kernel: { env: string; rooms: number; image: string }
    backup: { path: string }
  }
  assert.equal(value.ok, true)
  assert.equal(value.server.form, 'make run')
  assert.equal(value.server.pid, 4821)
  assert.equal(value.server.port, 4000)
  assert.equal(value.server.uptimeSec, 4463)
  assert.equal(value.client.stale, true)
  assert.equal(value.public.transport, 'relay')
  assert.equal(value.public.tunnelPid, 4990)
  assert.equal(value.kernel.rooms, 2)
  assert.equal(value.kernel.image, 'colloq-kernel:cv')
  assert.equal(value.backup.path, '/repo/backups/colloq-20260905-201332.db')
  assert.equal(result.out[0]?.includes('SHEETID'), false)
})

test('status: пусто — ровно одна строка', async () => {
  const result = await run(['status'])
  assert.equal(result.code, 0)
  assert.deepEqual(result.out, ['nothing is running · colloq run'])
})

// ------------------------------------------------------------------ doctor

test('doctor: --dry-run печатает, что проверил бы, и не проверяет', async () => {
  const result = await run(['doctor', '--dry-run'])
  assert.equal(result.code, 0)
  assert.deepEqual(result.calls, [])
  assert.deepEqual(result.out, [
    'native: doctor (programs, files, images, disk space; TCP to the relay — 2s)',
  ])
})

test('doctor: сломанное — ✗ и код 3, выключенное — ○ и это не ошибка', async () => {
  const result = await run(['doctor'])
  assert.equal(result.code, 3)
  assert.deepEqual(result.made, [])
  assert.match(result.text, /✗ docker\s+the daemon is not answering/)
  assert.match(result.text, /✗ tsx/)
  assert.match(result.text, /✗ kernel image\s+no colloq-kernel:cv image/)
  assert.match(result.text, /○ python3\s+missing — no activity/)
  assert.match(result.text, /✓ \.env\s+present · PORT 4000 · KERNEL_ENV cv/)
  // Из .env наружу только PORT и KERNEL_ENV.
  assert.equal(result.text.includes('SHEETID'), false)
})

test('doctor: порт держит наш сервер — это не занятость', async () => {
  const result = await run(['doctor'], {
    files: { ...LIVE },
    capture: (cmd) =>
      cmd === 'lsof'
        ? {
            code: 0,
            stdout: 'COMMAND PID USER\nnode 4821 alex 23u IPv4 TCP *:4000 (LISTEN)\n',
            stderr: '',
          }
        : silent,
  })
  assert.match(result.text, /✓ port 4000\s+our server is listening, pid 4821/)
})

test('doctor: чужой процесс на порту — ✗ и починка без pkill', async () => {
  const result = await run(['doctor'], {
    capture: (cmd) =>
      cmd === 'lsof'
        ? { code: 0, stdout: 'node 5150 alex 23u IPv4 TCP *:4000 (LISTEN)\n', stderr: '' }
        : silent,
  })
  assert.match(result.text, /✗ port 4000\s+taken: node pid 5150 — a second Colloq/)
  assert.match(result.text, /→ colloq stop · colloq status \(never pkill by name\)/)
})

test('doctor: --offline снимает единственную сетевую проверку', async () => {
  const online = await run(['doctor'])
  assert.ok(online.calls.some((call) => call[1] === 'node'))
  const offline = await run(['doctor', '--offline'])
  assert.equal(
    offline.calls.some((call) => call[1] === 'node'),
    false,
  )
  assert.match(offline.text, /○ relay\s+not checked: --offline/)
})

test('doctor: --json — массив проверок и ни строки вне него', async () => {
  const result = await run(['doctor', '--json'])
  assert.equal(result.code, 3)
  assert.equal(result.out.length, 1)
  const checks = JSON.parse(result.out[0] ?? '[]') as {
    id: string
    ok: boolean
    optional: boolean
    value: string
    hint: string
  }[]
  const byId = new Map(checks.map((check) => [check.id, check]))
  assert.equal(byId.get('env')?.ok, true)
  assert.equal(byId.get('docker')?.ok, false)
  assert.equal(byId.get('docker')?.optional, false)
  assert.equal(byId.get('sqlite3')?.optional, true)
  assert.ok(byId.has('class'))
  assert.ok(byId.has('worlds'))
  assert.ok(byId.has('restore'))
})

// ---------------------------------------------------------------- activity

test('activity: комната и --replace доезжают парами make', async () => {
  const one = await run(['activity', 'y84w9hpc', '--replace', '--dry-run'])
  assert.equal(one.code, 0)
  assert.deepEqual(one.out, ['make activity ROOM=y84w9hpc REPLACE=1'])
  assert.deepEqual(one.made, [])

  const all = await run(['activity', '--all', '--dry-run'])
  assert.deepEqual(all.out, ['make activity ALL=1'])
})

test('activity: комнат бывает несколько, и все уходят одной парой ROOM', async () => {
  const many = await run(['activity', 'aaa', 'bbb', '--dry-run'])
  assert.equal(many.code, 0)
  assert.deepEqual(many.out, ["make activity 'ROOM=aaa bbb'"])
})

test('activity: имя комнаты просеивается — ROOM уходит в рецепт без кавычек', async () => {
  for (const room of ['x;id', 'a b', '$(pwd)', '../evil', '`id`']) {
    const result = await run(['activity', room, '--replace'], { tty: true, answer: 'y' })
    assert.equal(result.code, 2, room)
    assert.deepEqual(result.calls, [], room)
    assert.match(result.err.join('\n'), /will not do/, room)
  }
  // Отказ идёт до вопроса: терминала нет, а код всё равно 2.
  const quiet = await run(['activity', 'x;id', '--replace'], { tty: false })
  assert.equal(quiet.code, 2)
})

test('activity: без комнаты и без --all — отказ до всякого действия', async () => {
  const result = await run(['activity'])
  assert.equal(result.code, 2)
  assert.deepEqual(result.calls, [])
  assert.match(result.err.join('\n'), /✗ no room to count activity for/)
})

test('activity: комната вместе с --all не читается', async () => {
  const result = await run(['activity', 'y84w9hpc', '--all'])
  assert.equal(result.code, 2)
  assert.deepEqual(result.calls, [])
})

test('activity: --replace спрашивает, «нет» — код 4, --yes снимает вопрос', async () => {
  const no = await run(['activity', 'y84w9hpc', '--replace'], { answer: 'n', tty: true })
  assert.equal(no.code, 4)
  assert.deepEqual(no.made, [])
  assert.match(no.asked[0] ?? '', /rewrite the rows of these rooms in the sheet\? \[y\/N\]/)

  const yes = await run(['activity', 'y84w9hpc', '--replace', '--yes'], { tty: true })
  assert.equal(yes.code, 0)
  assert.deepEqual(yes.asked, [])
  assert.deepEqual(yes.made, [['make', 'activity', 'ROOM=y84w9hpc', 'REPLACE=1']])
})

test('activity: дописывание ни о чём не спрашивает', async () => {
  const result = await run(['activity', 'y84w9hpc'], { answer: 'n', tty: true })
  assert.equal(result.code, 0)
  assert.deepEqual(result.asked, [])
  assert.deepEqual(result.made, [['make', 'activity', 'ROOM=y84w9hpc']])
})

test('activity: нет ACTIVITY_SHEET_ID — предусловие, код 3', async () => {
  const result = await run(['activity', 'y84w9hpc'], {
    files: { '/repo/.env': 'PORT=4000' },
    tty: true,
  })
  assert.equal(result.code, 3)
  assert.deepEqual(result.made, [])
  assert.match(result.err.join('\n'), /no ACTIVITY_SHEET_ID/)
})

// -------------------------------------------------------------------- site

test('site: путь считается от каталога человека, флаги уходят парами', async () => {
  const result = await run([
    'site',
    '--dry',
    '--site',
    'site',
    '--base',
    'https://colloq.ru',
    '--dry-run',
  ])
  assert.equal(result.code, 0)
  assert.deepEqual(result.out, ['make site SITE=/repo/site BASE=https://colloq.ru DRY=1'])
})

test('site: без --dry спрашивает про push, «нет» — код 4', async () => {
  const no = await run(['site'], { answer: 'n', tty: true })
  assert.equal(no.code, 4)
  assert.deepEqual(no.made, [])
  assert.match(no.asked[0] ?? '', /publish the site\? there will be a commit and a push to main/)

  const yes = await run(['site', '--yes'], { tty: true })
  assert.equal(yes.code, 0)
  assert.deepEqual(yes.made, [['make', 'site']])
})

test('site: --dry — сборка без push, и вопроса нет', async () => {
  const result = await run(['site', '--dry'], { answer: 'n', tty: true })
  assert.equal(result.code, 0)
  assert.deepEqual(result.asked, [])
  assert.deepEqual(result.made, [['make', 'site', 'DRY=1']])
})

// ------------------------------------------------------------------ course

test('course: колонка по тексту заголовка доезжает целиком', async () => {
  const result = await run([
    'course',
    '--sheet',
    'SHEETID',
    '--col',
    'ML · advanced',
    '--dry',
    '--dry-run',
  ])
  assert.equal(result.code, 0)
  assert.deepEqual(result.out, ["make course SHEET=SHEETID GID=0 'COL=ML · advanced' DRY=1"])
})

test('course: без --sheet и без --col — отказ, ничего не запущено', async () => {
  const noSheet = await run(['course', '--col', 'ML · advanced'])
  assert.equal(noSheet.code, 2)
  assert.deepEqual(noSheet.calls, [])
  assert.match(noSheet.err.join('\n'), /✗ no sheet to take the schedule from/)

  const noColumn = await run(['course', '--sheet', 'SHEETID'])
  assert.equal(noColumn.code, 2)
  assert.deepEqual(noColumn.calls, [])
  assert.match(noColumn.err.join('\n'), /✗ no column to take/)
})

test('course: запись в базу спрашивают, --yes снимает вопрос', async () => {
  const no = await run(['course', '--sheet', 'SHEETID', '--col', 'ML'], { answer: 'n', tty: true })
  assert.equal(no.code, 4)
  assert.deepEqual(no.made, [])
  assert.match(no.asked[0] ?? '', /create the course\? we write into data\/colloq\.db/)

  const yes = await run(
    ['course', '--sheet', 'SHEETID', '--col', 'ML', '--name', 'ML · advanced', '--yes'],
    {
      tty: true,
    },
  )
  assert.equal(yes.code, 0)
  assert.deepEqual(yes.made, [
    ['make', 'course', 'SHEET=SHEETID', 'GID=0', 'COL=ML', 'NAME=ML · advanced'],
  ])
})

// -------------------------------------------------------------------- load

test('load: N, темп и pid сервера уходят парами make', async () => {
  const result = await run(['load', '500', '--ramp', '60', '--pid', '4821', '--dry-run'])
  assert.equal(result.code, 0)
  assert.deepEqual(result.out, ['make load N=500 RAMP=60 SPID=4821'])
})

test('load: SPID без --pid берётся из .colloq.pid', async () => {
  const result = await run(['load', '100', '--dry-run'], { files: LIVE })
  assert.deepEqual(result.out, ['make load N=100 SPID=4821'])
})

test('load: --url идёт окружением, и строка показывает это как есть', async () => {
  const result = await run(['load', '50', '--url', 'https://hse.colloq.ru', '--dry-run'])
  assert.deepEqual(result.out, ['LOAD_BASE_URL=https://hse.colloq.ru make load N=50'])
})

test('load: N — это число', async () => {
  const result = await run(['load', 'many'])
  assert.equal(result.code, 2)
  assert.deepEqual(result.calls, [])
  assert.match(result.err.join('\n'), /✗ N is a number of students/)
})

test('load: вопрос называет цель, «нет» — код 4 и «отменено»', async () => {
  const no = await run(['load', '500'], { answer: 'n', tty: true })
  assert.equal(no.code, 4)
  assert.deepEqual(no.made, [])
  assert.match(
    no.asked[0] ?? '',
    /the load test will go at http:\/\/localhost:3000 — that is the teacher's server/,
  )
  assert.deepEqual(no.out, ['cancelled'])

  const yes = await run(['load', '500', '--yes'], { files: LIVE, tty: true })
  assert.equal(yes.code, 0)
  assert.deepEqual(yes.asked, [])
  assert.deepEqual(yes.made, [['make', 'load', 'N=500', 'SPID=4821']])
  assert.match(yes.text, /→ the server pid is taken from \.colloq\.pid: 4821/)
})

// -------------------------------------------------------------------- make

test('make: цель и пары уходят как есть, ничего не разбирая', async () => {
  const result = await run(['make', 'vast-up', 'NAME=hse', '--dry-run'])
  assert.equal(result.code, 0)
  assert.deepEqual(result.out, ['make vast-up NAME=hse'])

  const real = await run(['make', 'ps'])
  assert.equal(real.code, 0)
  assert.deepEqual(real.made, [['make', 'ps']])
})

test('make: ручка цели — это пара, а не флаг; про -- сказано честно', async () => {
  const result = await run(['make', 'ui', 'HEADED=1', '--dry-run'])
  assert.equal(result.code, 0)
  assert.deepEqual(result.out, ['make ui HEADED=1'])

  const notes = registry.find((command) => command.name === 'make')?.notes ?? ''
  // Пример `colloq make ui -- --headed` не работал: make отвергает такой ключ.
  assert.equal(notes.includes('-- --headed'), false)
  assert.match(notes, /HEADED=1/)
  assert.match(notes, /only BEFORE --/)
})

test('make: без цели — код 2 и список целей', async () => {
  const result = await run(['make', '--dry-run'])
  assert.equal(result.code, 2)
  assert.deepEqual(result.made, [])
  assert.match(result.err.join('\n'), /✗ no target to call/)
  assert.deepEqual(result.out, ['make help'])
})

/**
 * Доктор у установленного colloq: два каталога окружений и выполнимые советы.
 *
 * Найдено живьём, из колеса: `colloq doctor` писал «нет kernel/environments/
 * mlcourse.txt» про окружение, которое человек только что завёл сам и которое
 * лежало целым в его каталоге, — а рядом советовал `colloq env build`, который
 * у установленного colloq отказывает нарочно. Оба совета вели в тупик.
 */
const INSTALLED = {
  '/repo/kernel/environments/base.txt': '# база\n',
  '/home/.colloq/.env': 'PORT=4000\nKERNEL_ENV=mine\n',
  '/home/.colloq/environments/mine.txt': '# своё\nstatsmodels\n',
}

test('doctor видит своё окружение во втором каталоге и не зовёт туда, где откажут', async () => {
  const result = await run(['doctor'], { dist: true, home: '/home/.colloq', files: INSTALLED })
  assert.match(result.text, /environment\s+mine\.txt in place · your own/)
  assert.doesNotMatch(result.text, /no mine\.txt list/)
  // Образа нет (docker подставной молчит) — но чинится это запуском, не сборкой.
  assert.match(result.text, /colloq start — the image is built before the class/)
  assert.doesNotMatch(result.text, /colloq env build/)
})

test('doctor у установленного colloq всё равно говорит, когда списка нет нигде', async () => {
  const { '/home/.colloq/environments/mine.txt': _gone, ...without } = INSTALLED
  const result = await run(['doctor'], { dist: true, home: '/home/.colloq', files: without })
  assert.match(result.text, /no mine\.txt list in either environment directory/)
  assert.match(result.text, /colloq env list · colloq env new <name>/)
})

test('в репозитории доктор по-прежнему советует сборку окружения', async () => {
  const result = await run(['doctor'])
  assert.match(result.text, /colloq env build cv/)
})

/**
 * Занятие под супервизором: два процесса, два корня и одна расписка.
 *
 * .colloq.pid хранит номер СУПЕРВИЗОРА, а порт держит его ребёнок — сервер, и
 * половина экрана считала по неверному номеру. Живьём это выглядело так:
 * status называл сервером супервизора и печатал «порт 3000», пока класс сидел
 * на 4100; doctor тут же объявлял настоящий слушатель «вторым Colloq»,
 * советовал colloq stop и возвращал 3 — то есть звал преподавателя остановить
 * собственную пару. Ниже — по тесту на каждое место, где номер и порт теперь
 * берутся из расписки.
 */
const SESSION = JSON.stringify({
  pid: 4821,
  serverPid: 4822,
  port: 4100,
  url: 'http://localhost:4100',
  runId: 'r1',
  mode: 'run',
  phase: 'ready',
  startedAt: NOW - 600_000,
  leaseFile: '/repo/.colloq/public-url.json',
})

const RECEIPT = '/repo/.colloq/local-session.json'

test('status: порт и номер сервера берутся из расписки, а не из .env и .colloq.pid', async () => {
  const result = await run(['status'], { files: { ...LIVE, [RECEIPT]: SESSION }, capture: alive })
  assert.equal(result.code, 0)
  assert.match(result.text, /● server\s+pid 4822 · port 4100 · 1h 14m · colloq run/)
  // Супервизора под подписью «сервер» нет, порта из .env — тоже.
  assert.doesNotMatch(result.text, /pid 4821/)
  assert.doesNotMatch(result.text, /port 4000/)
  // И живость спрашивали у сервера: doctor назовёт слушателем тот же номер.
  assert.ok(result.calls.some((call) => call[1] === 'ps' && call[3] === '4822'))
})

test('status: занятие в режиме dev называется своей формой', async () => {
  const dev = JSON.stringify({ ...JSON.parse(SESSION), mode: 'dev' })
  const result = await run(['status'], { files: { ...LIVE, [RECEIPT]: dev }, capture: alive })
  assert.match(result.text, /● server\s+pid 4822 · port 4100 · 1h 14m · colloq dev/)
})

test('status: сервер занятия ещё не поднялся — порт есть, чужого номера нет', async () => {
  const starting = JSON.stringify({
    ...JSON.parse(SESSION),
    serverPid: null,
    phase: 'starting',
  })
  const result = await run(['status'], { files: { ...LIVE, [RECEIPT]: starting }, capture: alive })
  assert.match(result.text, /● server\s+port 4100 · 1h 14m · colloq run/)
  assert.doesNotMatch(result.text, /pid 4821/)
})

test('status: публичный адрес занятия — из его расписки на адрес, а не из .env', async () => {
  const result = await run(['status'], {
    files: {
      ...LIVE,
      [RECEIPT]: SESSION,
      '/repo/.colloq/public-url.json': JSON.stringify({
        runId: 'r1',
        owner: 'colloq',
        url: 'https://hse.colloq.ru',
        expiresAt: NOW + 600_000,
      }),
    },
    capture: alive,
  })
  assert.match(result.text, /^Colloq · hse$/m)
  assert.match(result.text, /● outside\s+hse\.colloq\.ru · relay \(frpc pid 4990\)/)
  assert.match(result.text, /link\s+https:\/\/hse\.colloq\.ru/)
})

test('status: расписка от убитого занятия ничего не рисует', async () => {
  // kill -9 файл не убирает: верить ему без живого процесса нельзя.
  const result = await run(['status'], { files: { [RECEIPT]: SESSION } })
  assert.equal(result.code, 0)
  assert.deepEqual(result.out, ['nothing is running · colloq run'])
})

/** Осмотр во время занятия: .colloq.pid нет вовсе, всё знает расписка. */
const CLASS: Record<string, string> = {
  '/repo/.env': 'PORT=4000\nKERNEL_ENV=cv\n',
  [RECEIPT]: SESSION,
}

function listening(pid: number): (cmd: string) => Answer {
  return (cmd) =>
    cmd === 'lsof'
      ? { code: 0, stdout: 'node ' + pid + ' alex 23u IPv4 TCP *:4100 (LISTEN)\n', stderr: '' }
      : silent
}

test('doctor: слушатель порта — сервер занятия, а не «второй Colloq»', async () => {
  const result = await run(['doctor'], { files: CLASS, capture: listening(4822) })
  assert.match(result.text, /✓ port 4100\s+our server is listening, pid 4822/)
  assert.doesNotMatch(result.text, /a second Colloq/)
  // Проверяли тот порт, на котором идёт занятие: .env про 4100 не знает.
  assert.ok(result.calls.some((call) => call.includes('-iTCP:4100')))
  // А строка про .env говорит своё — вопрос у неё другой.
  assert.match(result.text, /✓ \.env\s+present · PORT 4000 · KERNEL_ENV cv/)
})

test('doctor: супервизор на порту — тоже наш: сервер мог перезапуститься', async () => {
  const result = await run(['doctor'], { files: CLASS, capture: listening(4821) })
  assert.match(result.text, /✓ port 4100\s+our server is listening, pid 4821/)
})

test('doctor: чужой на порту занятия — по-прежнему ✗', async () => {
  const result = await run(['doctor'], { files: CLASS, capture: listening(5150) })
  assert.equal(result.code, 3)
  assert.match(result.text, /✗ port 4100\s+taken: node pid 5150 — a second Colloq/)
})

test('doctor: место меряется на томе каталога состояния, а не приложения', async () => {
  const result = await run(['doctor'], { dist: true, home: '/home/.colloq', files: INSTALLED })
  assert.ok(result.calls.some((call) => call[1] === 'df' && call[3] === '/home/.colloq'))
  assert.equal(
    result.calls.some((call) => call[1] === 'df' && call[3] === '/repo'),
    false,
  )
})

test('load: SPID — номер сервера из расписки, а не супервизор из .colloq.pid', async () => {
  const dry = await run(['load', '100', '--dry-run'], { files: { ...LIVE, [RECEIPT]: SESSION } })
  assert.deepEqual(dry.out, ['make load N=100 SPID=4822'])

  const yes = await run(['load', '100', '--yes'], {
    files: { ...LIVE, [RECEIPT]: SESSION },
    tty: true,
  })
  assert.equal(yes.code, 0)
  assert.deepEqual(yes.made, [['make', 'load', 'N=100', 'SPID=4822']])
  assert.match(yes.text, /→ the server pid is taken from the class receipt: 4822/)
})

test('load: расписка без номера сервера — лучше не мерить, чем мерить супервизора', async () => {
  const starting = JSON.stringify({ ...JSON.parse(SESSION), serverPid: null })
  const result = await run(['load', '100', '--dry-run'], {
    files: { ...LIVE, [RECEIPT]: starting },
  })
  assert.deepEqual(result.out, ['make load N=100'])
})
