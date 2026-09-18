/**
 * Инструменты: status и doctor.
 *
 * Ни один процесс здесь не запускается и ни один настоящий файл не читается:
 * исполнитель подменён (вызовы падают в массив, ответы — из таблицы теста),
 * файловая система — карта в памяти, вывод — массив строк. Проверяется то, на
 * что человек смотрит: строки экрана, код возврата и то, что каждая подсказка
 * ведёт к команде, которая у преподавателя есть.
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
  // ACTIVITY_SHEET_ID — метка: значений .env, кроме порта и окружения, экран не печатает.
  '/repo/.env': [
    'PORT=4000',
    'KERNEL_ENV=cv',
    'RELAY_DOMAIN=hse.colloq.ru',
    'RELAY_ADDR=203.0.113.10',
    'ACTIVITY_SHEET_ID=1SheetFixture',
  ].join('\n'),
}

type Answer = { code: number; stdout: string; stderr: string }

type Harness = {
  code: number
  out: string[]
  err: string[]
  calls: string[][]
  /** Всё, кроме чтений: только то, что действительно запускалось бы. */
  made: string[][]
  text: string
}

const silent: Answer = { code: 1, stdout: '', stderr: '' }

async function run(
  argv: string[],
  opts: {
    files?: Record<string, string>
    capture?: (cmd: string, args: string[]) => Answer
    /** Установленный colloq: приложение отдельно, состояние отдельно. */
    dist?: boolean
    home?: string
  } = {},
): Promise<Harness> {
  const out: string[] = []
  const err: string[] = []
  const calls: string[][] = []
  const io = createMemoryIo({ ...FILES, ...(opts.files ?? {}) }, NOW)
  const code = await cli(argv, {
    io,
    root: ROOT,
    home: opts.home,
    dist: opts.dist ?? false,
    cwd: ROOT,
    out: (line) => void out.push(line),
    err: (line) => void err.push(line),
    tty: false,
    // NO_COLOR: строки сравниваются как есть, без escape-последовательностей.
    processEnv: { NO_COLOR: '1' },
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
    made: calls.filter((call) => call[0] !== 'capture'),
    text: out.join('\n'),
  }
}

/** Подсказки экрана — строки «→ …» — без стрелки. */
function hints(result: Harness): string[] {
  return result.out
    .map((line) => line.trim())
    .filter((line) => line.startsWith('→ '))
    .map((line) => line.slice(2))
}

/**
 * Слова, которые подсказка преподавателю назвать не может: команд обёртки над
 * мастерской больше нет, а Makefile и scripts/ в колесо не едут.
 */
const DEAD_ENDS = [
  /colloq (make|build|dev|vast|docker-gid|activity|relay|dns|tunnel|env build)\b/,
  /npm install/,
  /scripts\//,
  /\bmake\b(?! run)/,
]

function assertReachable(lines: string[]): void {
  for (const line of lines)
    for (const dead of DEAD_ENDS) assert.doesNotMatch(line, dead, 'a dead end: ' + line)
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
    'ACTIVITY_SHEET_ID=1SheetFixture',
    'PUBLIC_URL=https://hse.colloq.ru',
  ].join('\n'),
  '/repo/.colloq.pid': '4821\n',
  '/repo/web/dist/index.html': '<!doctype html>',
  '/repo/web/dist/assets/app.js': 'export {}',
  '/repo/backups/colloq-20260905-201332.db': 'db',
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
  assert.match(result.text, /● backup\s+colloq-20260905-201332\.db · \d/)
  // Токен установки и прочие значения .env на экран не попадают.
  assert.equal(result.text.includes('1SheetFixture'), false)
  // Только процессы и docker: ни systemctl, ни проб сети.
  const asked = new Set(result.calls.map((call) => call[1]))
  assert.deepEqual([...asked].sort(), ['docker', 'pgrep', 'ps'])
})

test('status: об аренде машин ни строки — даже если от неё осталась память', async () => {
  const leftover = {
    ...LIVE,
    '/repo/.colloq/state.json': JSON.stringify({
      name: 'hse',
      gpu: 'RTX 5070',
      last: { command: 'vast up', code: 0, at: NOW - 3_600_000 },
    }),
  }
  const old = await run(['status'], { files: leftover, capture: alive })
  assert.equal(old.code, 0)
  assert.doesNotMatch(old.text, /vast|RTX 5070/)
  assertReachable(hints(old))

  const json = await run(['status', '--json'], { files: leftover, capture: alive })
  const value = JSON.parse(json.out[0] ?? '{}') as Record<string, unknown>
  assert.deepEqual(Object.keys(value).sort(), [
    'backup',
    'client',
    'kernel',
    'ok',
    'public',
    'server',
  ])
})

test('status: собранный позже сервера клиент — предупреждение и одна подсказка', async () => {
  const result = await run(['status'], { files: LIVE, capture: alive })
  assert.match(
    result.text,
    /● client\s+web\/dist built \d\d:\d\d — newer than the server \(started \d\d:\d\d\)/,
  )
  assert.deepEqual(
    hints(result).filter((hint) => hint === 'colloq restart'),
    ['colloq restart'],
  )
})

test('status: панели нет — чинится переустановкой, а не сборкой', async () => {
  const { '/repo/web/dist/index.html': _page, '/repo/web/dist/assets/app.js': _app, ...bare } = LIVE
  for (const dist of [false, true]) {
    const result = await run(['status'], { files: bare, capture: alive, dist })
    assert.match(result.text, /○ client\s+the frontend is not built/)
    assert.ok(hints(result).includes('reinstall colloq: pip install --force-reinstall colloq'))
    assertReachable(hints(result))
  }
})

test('status: образа нет — один совет, откуда бы ни звали CLI', async () => {
  const noImage = (cmd: string, args: string[]): Answer =>
    cmd === 'docker' && args[0] === 'image' ? silent : alive(cmd, args)
  for (const dist of [false, true]) {
    const result = await run(['status'], { files: LIVE, capture: noImage, dist })
    assert.match(result.text, /○ kernels\s+no colloq-kernel:cv image · rooms with a kernel: 2/)
    assert.ok(hints(result).includes('colloq start — the image is built before the class'))
    assert.doesNotMatch(result.text, /colloq env build/)
  }
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
  assert.ok(hints(result).includes('colloq host <name>'))
  // Отдельной строки «ссылка» с тем же адресом нет: её дают, когда есть кому.
  assert.equal(/link/.test(result.text), false)
})

test('status: копий нет — подсказка зовёт colloq backup', async () => {
  const { '/repo/backups/colloq-20260905-201332.db': _gone, ...none } = LIVE
  const result = await run(['status'], { files: none, capture: alive })
  assert.match(result.text, /○ backup\s+no backups/)
  assert.ok(hints(result).includes('colloq backup'))
})

test('status: контейнер compose — своя форма, мёртвый номер из .colloq.pid не печатается', async () => {
  const result = await run(['status'], {
    files: LIVE,
    capture: (cmd, args) => {
      // .colloq.pid остался от прошлого make run: ps о нём ничего не знает.
      if (cmd === 'ps') return silent
      if (cmd === 'docker' && args[0] === 'ps') {
        return { code: 0, stdout: '|app|running\nroom-kernel||running\n', stderr: '' }
      }
      return alive(cmd, args)
    },
  })
  assert.match(result.text, /● server\s+port 4000 · container/)
  assert.doesNotMatch(result.text, /pid 4821/)
})

test('status: ни службы, ни кластера — у ноутбука преподавателя их нет', async () => {
  const result = await run(['status'], {
    files: {
      ...LIVE,
      '/repo/.env': LIVE['/repo/.env'] + '\nCOLLOQ_CLUSTER=1',
      '/etc/systemd/system/colloq.service': '[Unit]',
    },
    capture: alive,
  })
  assert.match(result.text, /● server\s+pid 4821 · port 4000 · 1h 14m · make run/)
  assert.equal(
    result.calls.some((call) => call[1] === 'systemctl'),
    false,
  )
})

test('status: --short — ровно две строки, без подсказок', async () => {
  const result = await run(['status', '--short'], { files: LIVE, capture: alive })
  assert.equal(result.code, 0)
  assert.equal(result.out.length, 2)
  assert.match(result.out[0] ?? '', /● server/)
  assert.match(result.out[1] ?? '', /● outside/)

  // И когда не идёт ничего — те же две строки: подсказка у --short не печатается.
  const quiet = await run(['status', '--short'])
  assert.deepEqual(quiet.out, [
    '  ○ server    not running · port 4000',
    '  ○ outside   not published · colloq host <name>',
  ])
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
  assert.equal(result.out[0]?.includes('1SheetFixture'), false)
})

test('status: пусто — ровно одна строка', async () => {
  const result = await run(['status'])
  assert.equal(result.code, 0)
  assert.deepEqual(result.out, ['nothing is running · colloq run'])
})

test('status: текст справки не зовёт ни к аренде, ни к памяти о ней', () => {
  const status = registry.find((command) => command.name === 'status')
  assert.ok(status)
  assert.doesNotMatch(status.notes ?? '', /vast/)
  assert.doesNotMatch(status.delegates, /state\.json/)
  assert.equal('audience' in status, false)
})

// ------------------------------------------------------------------ doctor

test('doctor: --dry-run печатает, что проверил бы, и не проверяет', async () => {
  const result = await run(['doctor', '--dry-run'])
  assert.equal(result.code, 0)
  assert.deepEqual(result.calls, [])
  assert.deepEqual(result.out, [
    'native: doctor (programs, docker, the port, the kernel image, files, disk space)',
  ])
})

/** Проверки доктора — ровно эти и в этом порядке: весь осмотр — про занятие на этой машине. */
const CHECK_IDS = [
  'node',
  'docker',
  'port',
  'kernel-image',
  'kernel-env-file',
  'web-dist',
  'frpc',
  'cloudflared',
  'oracle',
  'disk',
  'room-network',
  'perimeter',
]

test('doctor: осмотр — только то, от чего зависит занятие на этой машине', async () => {
  const result = await run(['doctor', '--json'])
  const checks = JSON.parse(result.out[0] ?? '[]') as { id: string }[]
  assert.deepEqual(
    checks.map((check) => check.id),
    CHECK_IDS,
  )
  // Из установленного колеса — тот же набор.
  const installed = await run(['doctor', '--json'], { dist: true, home: '/home/.colloq' })
  const same = JSON.parse(installed.out[0] ?? '[]') as { id: string }[]
  assert.deepEqual(
    same.map((check) => check.id),
    CHECK_IDS,
  )
})

test('doctor: сломанное — ✗ и код 3, выключенное — ○ и это не ошибка', async () => {
  const result = await run(['doctor'])
  assert.equal(result.code, 3)
  assert.deepEqual(result.made, [])
  assert.match(result.text, /✗ docker\s+the daemon is not answering/)
  assert.match(result.text, /✗ kernel image\s+no colloq-kernel:cv image/)
  assert.match(result.text, /✗ web\/dist\s+the frontend is not built/)
  assert.match(result.text, /○ cloudflared\s+missing — the quick tunnel will not start/)
  assert.match(result.text, /○ Oracle\s+no key — suggestions are off/)
  assert.match(result.text, /○ perimeter/)
  // Из .env наружу только PORT и KERNEL_ENV.
  assert.equal(result.text.includes('1SheetFixture'), false)
})

test('doctor: ни одна подсказка не ведёт туда, чего у преподавателя нет', async () => {
  const broken = await run(['doctor'])
  const lines = hints(broken)
  // Подсказка есть у каждой не-ok строки, так что их здесь много.
  assert.ok(lines.length >= 8, lines.join('\n'))
  assertReachable(lines)
  assert.ok(lines.includes('reinstall colloq: pip install --force-reinstall colloq'))
  assert.ok(lines.includes('colloq start — the image is built before the class'))
  assert.ok(lines.includes('brew install frpc'))
  assert.ok(lines.includes('clear old backups out of /repo/backups'))

  const json = await run(['doctor', '--json'])
  const checks = JSON.parse(json.out[0] ?? '[]') as { hint: string }[]
  assertReachable(checks.map((check) => check.hint))
})

test('doctor: сети нет вовсе, и --offline выключать нечего', async () => {
  const result = await run(['doctor'])
  const asked = new Set(result.calls.map((call) => call[1]))
  assert.deepEqual([...asked].sort(), ['df', 'docker', 'lsof', 'sh'])
  assert.equal(
    result.calls.some((call) => call.includes('203.0.113.10')),
    false,
  )

  const offline = await run(['doctor', '--offline'])
  assert.equal(offline.code, 2)
  assert.deepEqual(offline.calls, [])
  assert.match(offline.err.join('\n'), /command doctor has no flag --offline/)
})

test('doctor: frpc нужен, только когда настроен ретранслятор', async () => {
  const wanted = await run(['doctor'])
  assert.match(wanted.text, /✗ frpc\s+missing — no way out under \*\.hse\.colloq\.ru/)

  const plain = await run(['doctor'], { files: { '/repo/.env': 'PORT=4000\nKERNEL_ENV=cv' } })
  assert.match(plain.text, /○ frpc\s+the relay is not set up/)
})

/** Машина, на которой всё на месте: осмотр должен сказать это и вернуть 0. */
const READY: Record<string, string> = {
  '/repo/.env': 'PORT=4000\nKERNEL_ENV=cv\nRELAY_DOMAIN=hse.colloq.ru\nOPENAI_API_KEY=sk-secret',
  '/repo/kernel/environments/cv.txt': 'numpy\n',
  '/repo/web/dist/index.html': '<!doctype html>',
  '/repo/web/dist/assets/app.js': 'export {}',
  '/repo/web/dist/assets/app.js.br': 'br',
}

function healthy(cmd: string, args: string[]): Answer {
  if (cmd === 'sh') return { code: 0, stdout: 'frpc\ncloudflared\n', stderr: '' }
  if (cmd === 'docker' && args[0] === 'info') {
    return { code: 0, stdout: '27.3.1 docker-desktop 8589934592\n', stderr: '' }
  }
  if (cmd === 'docker' && args[0] === 'image') {
    return { code: 0, stdout: '2026-09-12T10:00:00Z\n', stderr: '' }
  }
  if (cmd === 'df') {
    return {
      code: 0,
      stdout:
        'Filesystem 1024-blocks Used Available Capacity Mounted on\n' +
        '/dev/disk3s5 971350180 500000000 104857600 83% /System/Volumes/Data\n',
      stderr: '',
    }
  }
  return silent
}

test('doctor: всё на месте — ✓ по строкам, код 0 и ни одного значения ключа', async () => {
  const result = await run(['doctor'], { files: READY, capture: healthy })
  assert.equal(result.code, 0, result.text)
  assert.match(result.text, /✓ docker\s+docker-desktop, 8 GB/)
  assert.match(result.text, /✓ port 4000\s+free/)
  assert.match(result.text, /✓ kernel image\s+colloq-kernel:cv/)
  assert.match(result.text, /✓ environment\s+cv\.txt in place/)
  assert.match(result.text, /✓ web\/dist\s+built, pre-compressed: 1 of 1/)
  assert.match(result.text, /✓ frpc\s+present/)
  assert.match(result.text, /✓ cloudflared\s+present/)
  assert.match(result.text, /✓ Oracle\s+key present/)
  assert.match(result.text, /✓ disk space\s+100 GB/)
  // Единственная строка с подсказкой — периметр: он не проверка.
  assert.equal(hints(result).length, 1)
  assert.equal(result.text.includes('sk-secret'), false)
})

test('doctor: сеть комнат — ✓ по умолчанию, ○ и выход назад при COLLOQ_ROOM_NETWORK=open', async () => {
  const blocked = await run(['doctor'], { files: READY, capture: healthy })
  assert.match(blocked.text, /✓ room network\s+local addresses blocked: LAN, router, this computer, cloud metadata/)

  const open = await run(['doctor'], {
    files: { ...READY, '/repo/.env': READY['/repo/.env'] + '\nCOLLOQ_ROOM_NETWORK=open' },
    capture: healthy,
  })
  // Выключенная возможность, а не поломка: код тот же, но сказано вслух.
  assert.equal(open.code, 0, open.text)
  assert.match(open.text, /○ room network\s+open \(COLLOQ_ROOM_NETWORK=open\): rooms reach your LAN, router and this computer/)
  assert.ok(hints(open).includes('remove COLLOQ_ROOM_NETWORK=open from .env, then colloq restart'))
  assertReachable(hints(open))
})

test('doctor: несжатая панель — ○ и тот же совет переустановить', async () => {
  const { '/repo/web/dist/assets/app.js.br': _br, ...raw } = READY
  const result = await run(['doctor'], { files: raw, capture: healthy })
  assert.equal(result.code, 0)
  assert.match(result.text, /○ web\/dist\s+the frontend is not pre-compressed/)
  assert.ok(hints(result).includes('reinstall colloq: pip install --force-reinstall colloq'))
})

test('doctor: мало памяти у docker и мало места — ✗, с выполнимыми советами', async () => {
  const result = await run(['doctor'], {
    files: READY,
    capture: (cmd, args) => {
      if (cmd === 'docker' && args[0] === 'info') {
        return { code: 0, stdout: '27.3.1 colima 2147483648\n', stderr: '' }
      }
      if (cmd === 'df') {
        return {
          code: 0,
          stdout: 'Filesystem 1024-blocks Used Available\n/dev/sda1 100 90 3145728 97% /\n',
          stderr: '',
        }
      }
      return healthy(cmd, args)
    },
  })
  assert.equal(result.code, 3)
  assert.match(result.text, /✗ docker\s+colima, 2 GB — not enough for a room kernel/)
  assert.ok(
    hints(result).includes('raise docker memory: under 4 GB the room kernel is killed by OOM'),
  )
  assert.match(result.text, /✗ disk space\s+3\.0 GB — an image build and a backup will not fit/)
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
  assert.equal(byId.get('docker')?.ok, false)
  assert.equal(byId.get('docker')?.optional, false)
  assert.equal(byId.get('cloudflared')?.optional, true)
  assert.equal(byId.get('perimeter')?.ok, false)
  assert.equal(byId.get('perimeter')?.optional, true)
  assert.equal(result.out[0]?.includes('1SheetFixture'), false)

  // У исправного — пустая подсказка: совет даётся только тому, что не ok.
  const ready = await run(['doctor', '--json'], { files: READY, capture: healthy })
  const fine = JSON.parse(ready.out[0] ?? '[]') as { id: string; ok: boolean; hint: string }[]
  assert.equal(fine.find((check) => check.id === 'docker')?.hint, '')
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
  // И чистить предлагают копии там, где они лежат у установленного colloq.
  assert.ok(hints(result).includes('clear old backups out of /home/.colloq/backups'))
})

test('doctor у установленного colloq всё равно говорит, когда списка нет нигде', async () => {
  const { '/home/.colloq/environments/mine.txt': _gone, ...without } = INSTALLED
  const result = await run(['doctor'], { dist: true, home: '/home/.colloq', files: without })
  assert.match(result.text, /no mine\.txt list in either environment directory/)
  assert.match(result.text, /colloq env list · colloq env new <name>/)
})

test('из рабочего дерева доктор советует то же, что из колеса', async () => {
  const source = await run(['doctor', '--json'])
  const wheel = await run(['doctor', '--json'], { dist: true })
  const hintsOf = (result: Harness): string[] =>
    (JSON.parse(result.out[0] ?? '[]') as { hint: string }[]).map((check) => check.hint)
  assert.deepEqual(hintsOf(source), hintsOf(wheel))
  assert.doesNotMatch(source.out[0] ?? '', /colloq env build/)
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

test('status: режим dev называется командой, которой его заводят: npm run dev', async () => {
  const dev = JSON.stringify({ ...JSON.parse(SESSION), mode: 'dev' })
  const result = await run(['status'], { files: { ...LIVE, [RECEIPT]: dev }, capture: alive })
  assert.match(result.text, /● server\s+pid 4822 · port 4100 · 1h 14m · npm run dev/)
  // `colloq dev` у CLI нет, и экран к нему не отправляет.
  assert.doesNotMatch(result.text, /colloq dev/)
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

// ------------------------------------------------------------------ группа

test('в группе инструментов только status и doctor', () => {
  const tools = registry.filter((command) => command.group === 'tools').map((c) => c.name)
  assert.deepEqual(tools, ['status', 'doctor'])
})
