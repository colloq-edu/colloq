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
  assert.deepEqual(result.out, ['native: status (читает .env, .colloq.pid, docker ps)'])
})

test('status: экран собирается из ps, docker и pgrep, сеть не трогается', async () => {
  const result = await run(['status'], { files: LIVE, capture: alive })
  assert.equal(result.code, 0)
  assert.deepEqual(result.made, [])
  assert.match(result.text, /^Colloq · hse$/m)
  assert.match(result.text, /● сервер\s+pid 4821 · порт 4000 · 1 ч 14 мин · make run/)
  assert.match(result.text, /● наружу\s+hse\.colloq\.ru · ретранслятор \(frpc pid 4990\)/)
  assert.match(result.text, /ссылка\s+https:\/\/hse\.colloq\.ru/)
  assert.match(result.text, /● ядра\s+colloq-kernel:cv, собран 12\.09 · комнат с ядром: 2/)
  assert.match(result.text, /окружение\s+cv · сменить: colloq env use <имя>/)
  // Адрес машины CLI не запоминает: его печатает скрипт, чужой поток мы не разбираем.
  assert.match(result.text, /○ vast\s+hse — vast up прошёл .* · RTX 5070 · по памяти, без сети/)
  assert.match(result.text, /● копия\s+colloq-20260905-201332\.db/)
  // Токен установки и прочие значения .env на экран не попадают.
  assert.equal(result.text.includes('SHEETID'), false)
})

test('status: собранный позже сервера клиент — предупреждение и одна подсказка', async () => {
  const result = await run(['status'], { files: LIVE, capture: alive })
  assert.match(
    result.text,
    /● клиент\s+web\/dist собран \d\d:\d\d — новее сервера \(поднят \d\d:\d\d\)/,
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
  assert.match(result.text, /○ ядра\s+docker не ответил за 0,7 с/)
  assert.match(result.text, /● сервер\s+pid 4821/)
})

test('status: без публикации местный адрес называется один раз', async () => {
  const result = await run(['status'], {
    files: { ...LIVE, '/repo/.env': 'PORT=4000\nKERNEL_ENV=cv\nPUBLIC_URL=http://127.0.0.1:4000' },
    capture: alive,
  })
  assert.equal(result.code, 0)
  assert.match(result.text, /○ наружу\s+не выставлен · только http:\/\/127\.0\.0\.1:4000/)
  // Отдельной строки «ссылка» с тем же адресом нет: её дают, когда есть кому.
  assert.equal(/ссылка/.test(result.text), false)
})

test('status: --short — ровно две строки, ими открывается меню', async () => {
  const result = await run(['status', '--short'], { files: LIVE, capture: alive })
  assert.equal(result.code, 0)
  assert.equal(result.out.length, 2)
  assert.match(result.out[0] ?? '', /● сервер/)
  assert.match(result.out[1] ?? '', /● наружу/)
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
  assert.equal(value.public.transport, 'ретранслятор')
  assert.equal(value.public.tunnelPid, 4990)
  assert.equal(value.kernel.rooms, 2)
  assert.equal(value.kernel.image, 'colloq-kernel:cv')
  assert.equal(value.backup.path, '/repo/backups/colloq-20260905-201332.db')
  assert.equal(result.out[0]?.includes('SHEETID'), false)
})

test('status: пусто — ровно одна строка', async () => {
  const result = await run(['status'])
  assert.equal(result.code, 0)
  assert.deepEqual(result.out, ['ничего не запущено · colloq run'])
})

// ------------------------------------------------------------------ doctor

test('doctor: --dry-run печатает, что проверил бы, и не проверяет', async () => {
  const result = await run(['doctor', '--dry-run'])
  assert.equal(result.code, 0)
  assert.deepEqual(result.calls, [])
  assert.deepEqual(result.out, [
    'native: doctor (программы, файлы, образы, место; TCP до ретранслятора — 2 с)',
  ])
})

test('doctor: сломанное — ✗ и код 3, выключенное — ○ и это не ошибка', async () => {
  const result = await run(['doctor'])
  assert.equal(result.code, 3)
  assert.deepEqual(result.made, [])
  assert.match(result.text, /✗ docker\s+демон не отвечает/)
  assert.match(result.text, /✗ tsx/)
  assert.match(result.text, /✗ образ ядра\s+нет образа colloq-kernel:cv/)
  assert.match(result.text, /○ python3\s+нет — не будет activity/)
  assert.match(result.text, /✓ \.env\s+есть · PORT 4000 · KERNEL_ENV cv/)
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
  assert.match(result.text, /✓ порт 4000\s+слушает наш сервер, pid 4821/)
})

test('doctor: чужой процесс на порту — ✗ и починка без pkill', async () => {
  const result = await run(['doctor'], {
    capture: (cmd) =>
      cmd === 'lsof'
        ? { code: 0, stdout: 'node 5150 alex 23u IPv4 TCP *:4000 (LISTEN)\n', stderr: '' }
        : silent,
  })
  assert.match(result.text, /✗ порт 4000\s+занят: node pid 5150 — это второй Colloq/)
  assert.match(result.text, /→ colloq stop · colloq status \(pkill по имени — никогда\)/)
})

test('doctor: --offline снимает единственную сетевую проверку', async () => {
  const online = await run(['doctor'])
  assert.ok(online.calls.some((call) => call[1] === 'node'))
  const offline = await run(['doctor', '--offline'])
  assert.equal(
    offline.calls.some((call) => call[1] === 'node'),
    false,
  )
  assert.match(offline.text, /○ ретранслятор\s+не проверяли: --offline/)
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
    assert.match(result.err.join('\n'), /не годится/, room)
  }
  // Отказ идёт до вопроса: терминала нет, а код всё равно 2.
  const quiet = await run(['activity', 'x;id', '--replace'], { tty: false })
  assert.equal(quiet.code, 2)
})

test('activity: без комнаты и без --all — отказ до всякого действия', async () => {
  const result = await run(['activity'])
  assert.equal(result.code, 2)
  assert.deepEqual(result.calls, [])
  assert.match(result.err.join('\n'), /✗ не сказано, чью активность считать/)
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
  assert.match(no.asked[0] ?? '', /переписать строки этих комнат в таблице\? \[y\/N\]/)

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
  assert.match(result.err.join('\n'), /нет ACTIVITY_SHEET_ID/)
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
  assert.match(no.asked[0] ?? '', /выложить сайт\? будет коммит и push в main/)

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
    'ML · сильная',
    '--dry',
    '--dry-run',
  ])
  assert.equal(result.code, 0)
  assert.deepEqual(result.out, ["make course SHEET=SHEETID GID=0 'COL=ML · сильная' DRY=1"])
})

test('course: без --sheet и без --col — отказ, ничего не запущено', async () => {
  const noSheet = await run(['course', '--col', 'ML · сильная'])
  assert.equal(noSheet.code, 2)
  assert.deepEqual(noSheet.calls, [])
  assert.match(noSheet.err.join('\n'), /✗ не сказано, из какой таблицы брать расписание/)

  const noColumn = await run(['course', '--sheet', 'SHEETID'])
  assert.equal(noColumn.code, 2)
  assert.deepEqual(noColumn.calls, [])
  assert.match(noColumn.err.join('\n'), /✗ не сказано, какую колонку брать/)
})

test('course: запись в базу спрашивают, --yes снимает вопрос', async () => {
  const no = await run(['course', '--sheet', 'SHEETID', '--col', 'ML'], { answer: 'n', tty: true })
  assert.equal(no.code, 4)
  assert.deepEqual(no.made, [])
  assert.match(no.asked[0] ?? '', /завести курс\? пишем в data\/colloq\.db/)

  const yes = await run(
    ['course', '--sheet', 'SHEETID', '--col', 'ML', '--name', 'ML · сильная', '--yes'],
    {
      tty: true,
    },
  )
  assert.equal(yes.code, 0)
  assert.deepEqual(yes.made, [
    ['make', 'course', 'SHEET=SHEETID', 'GID=0', 'COL=ML', 'NAME=ML · сильная'],
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
  const result = await run(['load', 'много'])
  assert.equal(result.code, 2)
  assert.deepEqual(result.calls, [])
  assert.match(result.err.join('\n'), /✗ N — это число студентов/)
})

test('load: вопрос называет цель, «нет» — код 4 и «отменено»', async () => {
  const no = await run(['load', '500'], { answer: 'n', tty: true })
  assert.equal(no.code, 4)
  assert.deepEqual(no.made, [])
  assert.match(
    no.asked[0] ?? '',
    /стенд пойдёт по http:\/\/localhost:3000 — это сервер преподавателя/,
  )
  assert.deepEqual(no.out, ['отменено'])

  const yes = await run(['load', '500', '--yes'], { files: LIVE, tty: true })
  assert.equal(yes.code, 0)
  assert.deepEqual(yes.asked, [])
  assert.deepEqual(yes.made, [['make', 'load', 'N=500', 'SPID=4821']])
  assert.match(yes.text, /→ pid сервера взят из \.colloq\.pid: 4821/)
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
  assert.match(notes, /только ДО --/)
})

test('make: без цели — код 2 и список целей', async () => {
  const result = await run(['make', '--dry-run'])
  assert.equal(result.code, 2)
  assert.deepEqual(result.made, [])
  assert.match(result.err.join('\n'), /✗ не сказано, какую цель звать/)
  assert.deepEqual(result.out, ['make help'])
})
