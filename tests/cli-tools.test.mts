/**
 * Tools: status and doctor.
 *
 * No process is started here and no real file is read: the executor is
 * replaced (calls land in an array, answers come from the test's table), the
 * file system is an in-memory map, output an array of lines. What is checked
 * is what a person looks at: the screen lines, the exit code, and that every
 * hint leads to a command the teacher actually has.
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
  // ACTIVITY_SHEET_ID is a marker: the screen prints no .env values except the
  // port and the environment.
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
  /** Everything except reads: only what would really be launched. */
  made: string[][]
  text: string
}

const silent: Answer = { code: 1, stdout: '', stderr: '' }

async function run(
  argv: string[],
  opts: {
    files?: Record<string, string>
    capture?: (cmd: string, args: string[]) => Answer
    /** Installed colloq: the app separate, the state separate. */
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
    // NO_COLOR: lines are compared as they are, without escape sequences.
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

/** The screen's hints (the "→ …" lines) without the arrow. */
function hints(result: Harness): string[] {
  return result.out
    .map((line) => line.trim())
    .filter((line) => line.startsWith('→ '))
    .map((line) => line.slice(2))
}

/**
 * Words a hint to the teacher must not name: the wrapper commands over the
 * workshop are gone, and the Makefile and scripts/ do not go into the wheel.
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

/** A live machine: a server under make run, two rooms, a tunnel via the relay. */
function alive(cmd: string, args: string[]): Answer {
  if (cmd === 'ps') return { code: 0, stdout: ' 01:14:23\n', stderr: '' }
  if (cmd === 'docker' && args[0] === 'ps') {
    /*
      * Two ROOMS mean four containers: each has its own and one more for its
      * students' personal notebooks. The screen must say "2", not "4".
      */
    return { code: 0, stdout: 'room-kernel||running|r1\nroom-kernel||running|r1\nroom-kernel||running|r2\nroom-kernel||running|r2\n', stderr: '' }
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

test('status: --dry-run says what it reads and starts nothing', async () => {
  const result = await run(['status', '--dry-run'])
  assert.equal(result.code, 0)
  assert.deepEqual(result.calls, [])
  assert.deepEqual(result.out, [
    'native: status (reads the class receipt, .env, .colloq.pid, docker ps)',
  ])
})

test('status: the screen is built from ps, docker and pgrep, the network is not touched', async () => {
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
  // The setup token and other .env values do not reach the screen.
  assert.equal(result.text.includes('1SheetFixture'), false)
  // Only processes and docker: no systemctl, no network probes.
  const asked = new Set(result.calls.map((call) => call[1]))
  assert.deepEqual([...asked].sort(), ['docker', 'pgrep', 'ps'])
})

test('status: not a line about machine rental, even if its memory was left behind', async () => {
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

test('status: a client built after the server means a warning and one hint', async () => {
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

test('status: a missing panel is fixed by reinstalling, not by building', async () => {
  const { '/repo/web/dist/index.html': _page, '/repo/web/dist/assets/app.js': _app, ...bare } = LIVE
  for (const dist of [false, true]) {
    const result = await run(['status'], { files: bare, capture: alive, dist })
    assert.match(result.text, /○ client\s+the frontend is not built/)
    assert.ok(hints(result).includes('reinstall colloq: pip install --force-reinstall colloq'))
    assertReachable(hints(result))
  }
})

test('status: a missing image gets one hint, wherever the CLI is called from', async () => {
  const noImage = (cmd: string, args: string[]): Answer =>
    cmd === 'docker' && args[0] === 'image' ? silent : alive(cmd, args)
  for (const dist of [false, true]) {
    const result = await run(['status'], { files: LIVE, capture: noImage, dist })
    assert.match(result.text, /○ kernels\s+no colloq-kernel:cv image · rooms with a kernel: 2/)
    assert.ok(hints(result).includes('colloq start — the image is built before the class'))
    assert.doesNotMatch(result.text, /colloq env build/)
  }
})

test('status: docker did not answer: a line about it, the rest of the screen in place', async () => {
  const result = await run(['status'], {
    files: LIVE,
    capture: (cmd, args) =>
      cmd === 'docker' ? { code: 124, stdout: '', stderr: '' } : alive(cmd, args),
  })
  assert.equal(result.code, 0)
  assert.match(result.text, /○ kernels\s+docker did not answer in 0\.7s/)
  assert.match(result.text, /● server\s+pid 4821/)
})

test('status: without publication the local address is named once', async () => {
  const result = await run(['status'], {
    files: { ...LIVE, '/repo/.env': 'PORT=4000\nKERNEL_ENV=cv\nPUBLIC_URL=http://127.0.0.1:4000' },
    capture: alive,
  })
  assert.equal(result.code, 0)
  assert.match(result.text, /○ outside\s+not published · http:\/\/127\.0\.0\.1:4000 only/)
  assert.ok(hints(result).includes('colloq host <name>'))
  // There is no separate "link" line with the same address: it is given when
  // there is someone to give it to.
  assert.equal(/link/.test(result.text), false)
})

test('status: no backups, so the hint points to colloq backup', async () => {
  const { '/repo/backups/colloq-20260905-201332.db': _gone, ...none } = LIVE
  const result = await run(['status'], { files: none, capture: alive })
  assert.match(result.text, /○ backup\s+no backups/)
  assert.ok(hints(result).includes('colloq backup'))
})

test('status: a compose container has its own form, and the dead pid from .colloq.pid is not printed', async () => {
  const result = await run(['status'], {
    files: LIVE,
    capture: (cmd, args) => {
      // .colloq.pid is left over from a previous make run: ps knows nothing
      // about it.
      if (cmd === 'ps') return silent
      if (cmd === 'docker' && args[0] === 'ps') {
        return { code: 0, stdout: '|app|running|\nroom-kernel||running|r1\n', stderr: '' }
      }
      return alive(cmd, args)
    },
  })
  assert.match(result.text, /● server\s+port 4000 · container/)
  assert.doesNotMatch(result.text, /pid 4821/)
})

test("status: neither a service nor a cluster — the teacher's laptop has neither", async () => {
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

test('status: --short is exactly two lines, without hints', async () => {
  const result = await run(['status', '--short'], { files: LIVE, capture: alive })
  assert.equal(result.code, 0)
  assert.equal(result.out.length, 2)
  assert.match(result.out[0] ?? '', /● server/)
  assert.match(result.out[1] ?? '', /● outside/)

  // And when nothing is running, the same two lines: --short prints no hint.
  const quiet = await run(['status', '--short'])
  assert.deepEqual(quiet.out, [
    '  ○ server    not running · port 4000',
    '  ○ outside   not published · colloq host <name>',
  ])
})

test('status: --json is one line and not a single extra .env value', async () => {
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

test('status: empty means exactly one line', async () => {
  const result = await run(['status'])
  assert.equal(result.code, 0)
  assert.deepEqual(result.out, ['nothing is running · colloq run'])
})

test('status: the help text points neither to rental nor to its memory', () => {
  const status = registry.find((command) => command.name === 'status')
  assert.ok(status)
  assert.doesNotMatch(status.notes ?? '', /vast/)
  assert.doesNotMatch(status.delegates, /state\.json/)
  assert.equal('audience' in status, false)
})

// ------------------------------------------------------------------ doctor

test('doctor: --dry-run prints what it would check, and checks nothing', async () => {
  const result = await run(['doctor', '--dry-run'])
  assert.equal(result.code, 0)
  assert.deepEqual(result.calls, [])
  assert.deepEqual(result.out, [
    'native: doctor (programs, docker, the port, the kernel image, files, disk space)',
  ])
})

/**
 * The doctor's checks, exactly these and in this order: the whole examination
 * is about a class on this machine.
 */
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

test('doctor: the examination covers only what a class on this machine depends on', async () => {
  const result = await run(['doctor', '--json'])
  const checks = JSON.parse(result.out[0] ?? '[]') as { id: string }[]
  assert.deepEqual(
    checks.map((check) => check.id),
    CHECK_IDS,
  )
  // From an installed wheel, the same set.
  const installed = await run(['doctor', '--json'], { dist: true, home: '/home/.colloq' })
  const same = JSON.parse(installed.out[0] ?? '[]') as { id: string }[]
  assert.deepEqual(
    same.map((check) => check.id),
    CHECK_IDS,
  )
})

test('doctor: broken means ✗ and code 3, switched off means ○ and is not an error', async () => {
  const result = await run(['doctor'])
  assert.equal(result.code, 3)
  assert.deepEqual(result.made, [])
  assert.match(result.text, /✗ docker\s+the daemon is not answering/)
  assert.match(result.text, /✗ kernel image\s+no colloq-kernel:cv image/)
  assert.match(result.text, /✗ web\/dist\s+the frontend is not built/)
  assert.match(result.text, /○ cloudflared\s+missing — the quick tunnel will not start/)
  assert.match(result.text, /○ Oracle\s+no key — suggestions are off/)
  assert.match(result.text, /○ perimeter/)
  // Only PORT and KERNEL_ENV get out of .env.
  assert.equal(result.text.includes('1SheetFixture'), false)
})

test('doctor: no hint leads to something the teacher does not have', async () => {
  const broken = await run(['doctor'])
  const lines = hints(broken)
  // Every non-ok line has a hint, so there are many of them here.
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

test('doctor: no network at all, so there is nothing for --offline to switch off', async () => {
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

test('doctor: frpc is needed only when the relay is set up', async () => {
  const wanted = await run(['doctor'])
  assert.match(wanted.text, /✗ frpc\s+missing — no way out under \*\.hse\.colloq\.ru/)

  const plain = await run(['doctor'], { files: { '/repo/.env': 'PORT=4000\nKERNEL_ENV=cv' } })
  assert.match(plain.text, /○ frpc\s+the relay is not set up/)
})

/** A machine where everything is in place: the check must say so and return 0. */
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

test('doctor: everything in place gives ✓ on every line, code 0 and not a single key value', async () => {
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
  // The only line with a hint is the perimeter: it is not a check.
  assert.equal(hints(result).length, 1)
  assert.equal(result.text.includes('sk-secret'), false)
})

test('doctor: room network is ✓ by default, ○ plus the way back with COLLOQ_ROOM_NETWORK=open', async () => {
  const blocked = await run(['doctor'], { files: READY, capture: healthy })
  assert.match(blocked.text, /✓ room network\s+local addresses blocked: LAN, router, this computer, cloud metadata/)

  const open = await run(['doctor'], {
    files: { ...READY, '/repo/.env': READY['/repo/.env'] + '\nCOLLOQ_ROOM_NETWORK=open' },
    capture: healthy,
  })
  // A switched-off feature, not a breakage: the code is the same, but it is
  // said out loud.
  assert.equal(open.code, 0, open.text)
  assert.match(open.text, /○ room network\s+open \(COLLOQ_ROOM_NETWORK=open\): rooms reach your LAN, router and this computer/)
  assert.ok(hints(open).includes('remove COLLOQ_ROOM_NETWORK=open from .env, then colloq restart'))
  assertReachable(hints(open))
})

test('doctor: an uncompressed panel gives ○ and the same advice to reinstall', async () => {
  const { '/repo/web/dist/assets/app.js.br': _br, ...raw } = READY
  const result = await run(['doctor'], { files: raw, capture: healthy })
  assert.equal(result.code, 0)
  assert.match(result.text, /○ web\/dist\s+the frontend is not pre-compressed/)
  assert.ok(hints(result).includes('reinstall colloq: pip install --force-reinstall colloq'))
})

test('doctor: too little docker memory and disk space give ✗, with workable hints', async () => {
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

test('doctor: our own server holding the port does not count as taken', async () => {
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

test("doctor: someone else's process on the port gives ✗ and a fix without pkill", async () => {
  const result = await run(['doctor'], {
    capture: (cmd) =>
      cmd === 'lsof'
        ? { code: 0, stdout: 'node 5150 alex 23u IPv4 TCP *:4000 (LISTEN)\n', stderr: '' }
        : silent,
  })
  assert.match(result.text, /✗ port 4000\s+taken: node pid 5150 — a second Colloq/)
  assert.match(result.text, /→ colloq stop · colloq status \(never pkill by name\)/)
})

test('doctor: --json is an array of checks and not a line outside it', async () => {
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

  // A healthy one has an empty hint: advice is given only to what is not ok.
  const ready = await run(['doctor', '--json'], { files: READY, capture: healthy })
  const fine = JSON.parse(ready.out[0] ?? '[]') as { id: string; ok: boolean; hint: string }[]
  assert.equal(fine.find((check) => check.id === 'docker')?.hint, '')
})

/**
 * Doctor in an installed colloq: two environment directories and workable
 * hints.
 *
 * Found live, from the wheel: `colloq doctor` wrote "no kernel/environments/
 * mlcourse.txt" about an environment the person had just created and that sat
 * intact in their directory — and next to it suggested `colloq env build`,
 * which deliberately refuses in an installed colloq. Both hints led to a dead
 * end.
 */
const INSTALLED = {
  '/repo/kernel/environments/base.txt': '# база\n',
  '/home/.colloq/.env': 'PORT=4000\nKERNEL_ENV=mine\n',
  '/home/.colloq/environments/mine.txt': '# своё\nstatsmodels\n',
}

test("doctor sees one's own environment in the second directory and does not point where it will be refused", async () => {
  const result = await run(['doctor'], { dist: true, home: '/home/.colloq', files: INSTALLED })
  assert.match(result.text, /environment\s+mine\.txt in place · your own/)
  assert.doesNotMatch(result.text, /no mine\.txt list/)
  // No image (the stand-in docker is silent) — but that is fixed by starting,
  // not by building.
  assert.match(result.text, /colloq start — the image is built before the class/)
  assert.doesNotMatch(result.text, /colloq env build/)
  // And cleaning is suggested for backups where they live in an installed
  // colloq.
  assert.ok(hints(result).includes('clear old backups out of /home/.colloq/backups'))
})

test('doctor in an installed colloq still speaks up when the list is nowhere', async () => {
  const { '/home/.colloq/environments/mine.txt': _gone, ...without } = INSTALLED
  const result = await run(['doctor'], { dist: true, home: '/home/.colloq', files: without })
  assert.match(result.text, /no mine\.txt list in either environment directory/)
  assert.match(result.text, /colloq env list · colloq env new <name>/)
})

test('from a working tree the doctor gives the same hints as from the wheel', async () => {
  const source = await run(['doctor', '--json'])
  const wheel = await run(['doctor', '--json'], { dist: true })
  const hintsOf = (result: Harness): string[] =>
    (JSON.parse(result.out[0] ?? '[]') as { hint: string }[]).map((check) => check.hint)
  assert.deepEqual(hintsOf(source), hintsOf(wheel))
  assert.doesNotMatch(source.out[0] ?? '', /colloq env build/)
})

/**
 * A class under the supervisor: two processes, two roots and one receipt.
 *
 * .colloq.pid holds the SUPERVISOR's pid, while the port is held by its child,
 * the server, and half the screen computed from the wrong pid. Live it looked
 * like this: status called the supervisor the server and printed "port 3000"
 * while the class sat on 4100; doctor at once declared the real listener "a
 * second Colloq", suggested colloq stop and returned 3 — that is, told the
 * teacher to stop their own class. Below is a test for every place where the
 * pid and the port now come from the receipt.
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

test("status: the server's port and pid come from the receipt, not from .env and .colloq.pid", async () => {
  const result = await run(['status'], { files: { ...LIVE, [RECEIPT]: SESSION }, capture: alive })
  assert.equal(result.code, 0)
  assert.match(result.text, /● server\s+pid 4822 · port 4100 · 1h 14m · colloq run/)
  // No supervisor under the "server" label, and no port from .env either.
  assert.doesNotMatch(result.text, /pid 4821/)
  assert.doesNotMatch(result.text, /port 4000/)
  // And liveness was asked of the server: doctor will name the same pid as
  // the listener.
  assert.ok(result.calls.some((call) => call[1] === 'ps' && call[3] === '4822'))
})

test('status: dev mode is named by the command that starts it: npm run dev', async () => {
  const dev = JSON.stringify({ ...JSON.parse(SESSION), mode: 'dev' })
  const result = await run(['status'], { files: { ...LIVE, [RECEIPT]: dev }, capture: alive })
  assert.match(result.text, /● server\s+pid 4822 · port 4100 · 1h 14m · npm run dev/)
  // The CLI has no `colloq dev`, and the screen does not send anyone there.
  assert.doesNotMatch(result.text, /colloq dev/)
})

test("status: the class server is not up yet: the port is there, but no one else's pid", async () => {
  const starting = JSON.stringify({
    ...JSON.parse(SESSION),
    serverPid: null,
    phase: 'starting',
  })
  const result = await run(['status'], { files: { ...LIVE, [RECEIPT]: starting }, capture: alive })
  assert.match(result.text, /● server\s+port 4100 · 1h 14m · colloq run/)
  assert.doesNotMatch(result.text, /pid 4821/)
})

test("status: the class's public address comes from its address receipt, not from .env", async () => {
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

test('status: a receipt from a killed class draws nothing', async () => {
  // kill -9 does not remove the file: it cannot be trusted without a live
  // process.
  const result = await run(['status'], { files: { [RECEIPT]: SESSION } })
  assert.equal(result.code, 0)
  assert.deepEqual(result.out, ['nothing is running · colloq run'])
})

/** A check during a class: no .colloq.pid at all, the receipt knows everything. */
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

test('doctor: the port listener is the class server, not "a second Colloq"', async () => {
  const result = await run(['doctor'], { files: CLASS, capture: listening(4822) })
  assert.match(result.text, /✓ port 4100\s+our server is listening, pid 4822/)
  assert.doesNotMatch(result.text, /a second Colloq/)
  // The port checked is the one the class runs on: .env knows nothing about
  // 4100.
  assert.ok(result.calls.some((call) => call.includes('-iTCP:4100')))
})

test('doctor: the supervisor on the port is ours too: the server may have restarted', async () => {
  const result = await run(['doctor'], { files: CLASS, capture: listening(4821) })
  assert.match(result.text, /✓ port 4100\s+our server is listening, pid 4821/)
})

test('doctor: someone else on the class port is still ✗', async () => {
  const result = await run(['doctor'], { files: CLASS, capture: listening(5150) })
  assert.equal(result.code, 3)
  assert.match(result.text, /✗ port 4100\s+taken: node pid 5150 — a second Colloq/)
})

test("doctor: disk space is measured on the state directory's volume, not the app's", async () => {
  const result = await run(['doctor'], { dist: true, home: '/home/.colloq', files: INSTALLED })
  assert.ok(result.calls.some((call) => call[1] === 'df' && call[3] === '/home/.colloq'))
  assert.equal(
    result.calls.some((call) => call[1] === 'df' && call[3] === '/repo'),
    false,
  )
})

// ------------------------------------------------------------------- group

test('the tools group has only status and doctor', () => {
  const tools = registry.filter((command) => command.group === 'tools').map((c) => c.name)
  assert.deepEqual(tools, ['status', 'doctor'])
})
