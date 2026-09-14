/**
 * Группа «Машины и версии»: vast up/status/sync/logs/down/adopt, install,
 * update, rollback, cluster *, service *, release validate.
 *
 * Здесь не запускается ни один процесс и не читается ни один настоящий файл:
 * исполнитель подставной и пишет вызовы в массив, io — карта файлов в памяти.
 * Проверяется ровно то, чего каркас не стережёт: какая строка make собирается
 * из флагов и пар ВИДА=ЗНАЧЕНИЕ, где отказ наступает до делегирования и кто
 * спрашивает перед опасным действием.
 */
import './_cli.mjs'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { cli } from '../cli/src/main.js'
import { createMemoryIo } from '../cli/src/env.js'
import { registry, type Command } from '../cli/src/registry.js'

const ROOT = '/repo'

const FILES: Record<string, string> = {
  '/repo/package.json': '{ "name": "colloq", "version": "0.1.0" }',
  '/repo/cli/package.json': '{ "name": "@colloq/cli", "version": "0.1.0" }',
  '/repo/Makefile': ['vast-up:', 'install:', 'cluster-start:'].join('\n'),
  '/repo/.env': ['PORT=3000', 'KERNEL_ENV=base', 'RELAY_DOMAIN=hse.colloq.ru'].join('\n'),
  '/repo/release.json': '{ "k3sVersion": "v1.31.0" }',
}

type Call = string[]

type Harness = {
  code: number
  out: string[]
  err: string[]
  calls: Call[]
  asked: string[]
  state: string | null
}

/** Образец из tests/cli-core.test.mts: тот же стенд, плюс чтение .colloq/state.json. */
async function run(
  argv: string[],
  opts: {
    files?: Record<string, string>
    answer?: string
    tty?: boolean
    processEnv?: NodeJS.ProcessEnv
    exit?: number
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
        return { code: 1, stdout: '', stderr: '' }
      },
    },
  })
  return { code, out, err, calls, asked, state: io.readText('/repo/.colloq/state.json') }
}

/** Команды группы: порядок в help — порядок массива. */
const MINE = registry.filter((command: Command) => command.group === 'vast')

const NAMES = [
  'vast up',
  'vast status',
  'vast sync',
  'vast logs',
  'vast down',
  'vast adopt',
  'install',
  'update',
  'rollback',
  'cluster start',
  'cluster stop',
  'cluster status',
  'cluster logs',
  'service install',
  'service restart',
  'service stop',
  'service status',
  'service logs',
  'release validate',
]

test('группа собрана целиком и в том порядке, в каком её читают', () => {
  assert.deepEqual(
    MINE.map((command) => command.name),
    NAMES,
  )
})

// ------------------------------------------------------------------ vast up

test('vast up: имя, адрес и карта уходят make; --yes даёт FORCE=1', async () => {
  const plain = await run(['vast', 'up', 'hse', '--host', 'hse.colloq.ru', '--dry-run'])
  assert.equal(plain.code, 0)
  assert.deepEqual(plain.calls, [])
  assert.deepEqual(plain.out, ['make vast-up NAME=hse HOST=hse.colloq.ru'])

  const full = await run([
    'vast',
    'up',
    'hse',
    '--gpu',
    'RTX 5070',
    '--release',
    'release.json',
    '--replace',
    '--yes',
    '--dry-run',
  ])
  assert.deepEqual(full.out, [
    "make vast-up NAME=hse 'GPU=RTX 5070' RELEASE=/repo/release.json REPLACE=1 FORCE=1",
  ])
})

test('vast up: make-форма работает и пара не удваивается', async () => {
  const result = await run(['vast', 'up', 'NAME=hse', 'GPU=RTX 4090', '--dry-run'])
  assert.deepEqual(result.out, ["make vast-up NAME=hse 'GPU=RTX 4090'"])
})

test('vast up: имя со скобкой и «../» не доходит до скрипта', async () => {
  const result = await run(['vast', 'up', '../evil'])
  assert.equal(result.code, 2)
  assert.deepEqual(result.calls, [])
  assert.match(result.err[0] ?? '', /имя среды «\.\.\/evil» не годится/)
})

test('vast up: среда и адрес — одно слово, иначе отказ до аренды', async () => {
  const result = await run(['vast', 'up', 'hse', '--host', 'demo.colloq.ru'])
  assert.equal(result.code, 2)
  assert.deepEqual(result.calls, [])
  assert.match(result.err[0] ?? '', /разные имена/)
})

test('vast up: про цену спрашивает скрипт, а не мы', async () => {
  const found = MINE.find((command) => command.name === 'vast up')
  assert.equal(found?.confirm, 'script')
  const result = await run(['vast', 'up', 'hse'], { tty: true, answer: 'n' })
  assert.deepEqual(result.asked, [])
  assert.deepEqual(result.calls, [['make', 'vast-up', 'NAME=hse']])
  assert.equal(result.code, 0)
})

test('vast up: после выхода среда и путь остаются в памяти', async () => {
  const result = await run(['vast', 'up', 'hse', '--gpu', 'RTX 5070'])
  const state = JSON.parse(result.state ?? '{}') as Record<string, unknown>
  assert.equal(state.name, 'hse')
  assert.equal(state.gpu, 'RTX 5070')
  assert.equal(state.path, 'прежний')
  assert.deepEqual((state.last as { command?: string }).command, 'vast up hse')
})

test('vast up: под --dry-run в состояние ничего не пишется', async () => {
  const result = await run(['vast', 'up', 'hse', '--dry-run'])
  assert.equal(result.state, null)
})

// -------------------------------------------------------------- vast status

test('vast status: без имени — все среды, алиас vast ls — то же самое', async () => {
  const all = await run(['vast', 'status', '--dry-run'])
  assert.deepEqual(all.out, ['make vast-status'])
  const one = await run(['vast', 'ls', 'hse', '--release', 'release.json', '--dry-run'])
  assert.deepEqual(one.out, ['make vast-status NAME=hse RELEASE=/repo/release.json'])
})

test('vast status: --json снят — скрипт печатает человеку', async () => {
  const result = await run(['vast', 'status', '--json'])
  assert.equal(result.code, 2)
  assert.deepEqual(result.calls, [])
  assert.equal(result.out.length, 1)
  const answer = JSON.parse(result.out[0] ?? '{}') as Record<string, unknown>
  assert.equal(answer.ok, false)
  assert.equal(answer.code, 2)
})

// ---------------------------------------------------------------- vast sync

test('vast sync: MODE и RESUME уходят make', async () => {
  const result = await run([
    'vast',
    'sync',
    'hse',
    '--mode',
    'consistent',
    '--resume',
    '--release',
    'release.json',
    '--yes',
    '--dry-run',
  ])
  assert.deepEqual(result.out, [
    'make vast-sync NAME=hse MODE=consistent RESUME=1 RELEASE=/repo/release.json',
  ])
})

test('vast sync: чужого MODE не бывает', async () => {
  const result = await run(['vast', 'sync', 'hse', '--mode', 'быстро'])
  assert.equal(result.code, 2)
  assert.deepEqual(result.calls, [])
  assert.match(result.err[0] ?? '', /live или consistent/)
})

test('vast sync: consistent спрашивает, «нет» — код 4 и «отменено»', async () => {
  const result = await run(['vast', 'sync', 'hse', '--mode', 'consistent'], {
    tty: true,
    answer: 'n',
  })
  assert.equal(result.code, 4)
  assert.deepEqual(
    result.calls.filter((call) => call[0] !== 'capture'),
    [],
  )
  assert.match(result.asked[0] ?? '', /снять согласованную копию\?.*\[y\/N\]/)
  assert.deepEqual(result.out, ['отменено'])
})

test('vast sync: live не спрашивает вовсе, --yes снимает вопрос', async () => {
  const live = await run(['vast', 'sync', 'hse'], { tty: true, answer: 'n' })
  assert.deepEqual(live.asked, [])
  assert.deepEqual(live.calls, [['make', 'vast-sync', 'NAME=hse']])

  const forced = await run(['vast', 'sync', 'hse', '--mode', 'consistent', '--yes'], {
    tty: true,
    answer: 'n',
  })
  assert.deepEqual(forced.asked, [])
  assert.deepEqual(forced.calls, [['make', 'vast-sync', 'NAME=hse', 'MODE=consistent']])
})

test('vast sync: в прежнем пути MODE и RESUME не действуют — одна строка и ничего больше', async () => {
  const result = await run(['vast', 'sync', 'hse', '--mode', 'consistent', '--yes'])
  assert.equal(result.code, 0)
  assert.deepEqual(result.out, [
    'в прежнем пути MODE и RESUME не действуют: копия снимается как есть',
    'снимаю копию среды hse',
  ])
  assert.deepEqual(result.calls, [['make', 'vast-sync', 'NAME=hse', 'MODE=consistent']])
})

// ---------------------------------------------------------------- vast logs

test('vast logs: словари окна у путей разные и не переводятся', async () => {
  const legacy = await run(['vast', 'logs', 'hse', '--since=-2h', '--dry-run'])
  assert.deepEqual(legacy.out, ['make vast-logs NAME=hse SINCE=-2h'])

  const k3s = await run([
    'vast',
    'logs',
    'hse',
    '--since',
    '2h',
    '--release',
    'release.json',
    '--dry-run',
  ])
  assert.deepEqual(k3s.out, ['make vast-logs NAME=hse SINCE=2h RELEASE=/repo/release.json'])

  const wrong = await run(['vast', 'logs', 'hse', '--since', 'today', '--release', 'release.json'])
  assert.equal(wrong.code, 2)
  assert.deepEqual(wrong.calls, [])
  assert.match(wrong.err[0] ?? '', /в k3s-пути это длительность/)
})

test('vast logs: вторая команда в окне не проедет', async () => {
  const result = await run(['vast', 'logs', 'hse', '--since', 'today; rm -rf /'])
  assert.equal(result.code, 2)
  assert.deepEqual(result.calls, [])
})

// ---------------------------------------------------------------- vast down

test('vast down: слово «уничтожить» просит скрипт, --yes даёт FORCE=1', async () => {
  const found = MINE.find((command) => command.name === 'vast down')
  assert.equal(found?.confirm, 'script')
  const quiet = await run(['vast', 'down', 'hse'], { tty: true, answer: 'n' })
  assert.deepEqual(quiet.asked, [])
  assert.deepEqual(quiet.calls, [['make', 'vast-down', 'NAME=hse']])

  const forced = await run(['vast', 'down', 'hse', '--yes', '--dry-run'])
  assert.deepEqual(forced.out, ['make vast-down NAME=hse FORCE=1'])
})

test('vast down: после успеха среда перестаёт числиться живой', async () => {
  const done = await run(['vast', 'down', 'hse'])
  const state = JSON.parse(done.state ?? '{}') as Record<string, unknown>
  assert.equal(state.name, 'hse')
  assert.equal(state.alive, false)

  const failed = await run(['vast', 'down', 'hse'], { exit: 1 })
  assert.equal(failed.code, 1)
  const after = JSON.parse(failed.state ?? '{}') as Record<string, unknown>
  assert.equal(after.alive, undefined)
})

// --------------------------------------------------------------- vast adopt

test('vast adopt: без имени отказ до make, с именем — всегда vast.sh', async () => {
  const empty = await run(['vast', 'adopt'])
  assert.equal(empty.code, 2)
  assert.deepEqual(empty.calls, [])
  assert.match(empty.err[0] ?? '', /обязательного аргумента <среда>/)

  const named = await run(['vast', 'adopt', 'hse', '--dry-run'])
  assert.deepEqual(named.out, ['make vast-adopt NAME=hse'])

  const byPair = await run(['vast', 'adopt', 'NAME=hse', '--yes', '--dry-run'])
  assert.deepEqual(byPair.out, ['make vast-adopt FORCE=1 NAME=hse'])
})

// ------------------------------------------------- install / update / rollback

for (const name of ['install', 'update', 'rollback']) {
  test(name + ': релиз обязателен, путь разрешается от каталога человека', async () => {
    const empty = await run([name, '--yes'])
    assert.equal(empty.code, 2)
    assert.deepEqual(empty.calls, [])
    assert.match(empty.err[0] ?? '', /нет обязательного флага --release/)

    const missing = await run([name, '--release', 'нет.json', '--yes'])
    assert.equal(missing.code, 3)
    assert.deepEqual(missing.calls, [])
    assert.match(missing.err[0] ?? '', /файла релиза нет/)

    const ok = await run([name, '--release', 'release.json', '--dry-run'])
    assert.deepEqual(ok.out, ['make ' + name + ' RELEASE=/repo/release.json'])
  })

  test(name + ': спрашивает перед делом, --yes снимает вопрос', async () => {
    const refused = await run([name, '--release', 'release.json'], { tty: true, answer: 'n' })
    assert.equal(refused.code, 4)
    assert.deepEqual(
      refused.calls.filter((call) => call[0] !== 'capture'),
      [],
    )
    assert.match(refused.asked[0] ?? '', /\[y\/N\]/)
    assert.deepEqual(refused.out, ['отменено'])

    const agreed = await run([name, '--release', 'release.json'], { tty: true, answer: 'y' })
    assert.equal(agreed.code, 0)
    assert.deepEqual(
      agreed.calls.filter((call) => call[0] !== 'capture'),
      [['make', name, 'RELEASE=/repo/release.json']],
    )

    const forced = await run([name, '--release', 'release.json', '--yes'])
    assert.deepEqual(forced.asked, [])
    assert.deepEqual(forced.calls, [['make', name, 'RELEASE=/repo/release.json']])
  })

  test(name + ': прерванное восстановление сильнее вопроса', async () => {
    const result = await run([name, '--release', 'release.json', '--yes'], {
      files: { '/var/lib/colloq/.restore-in-progress': '{}' },
    })
    assert.equal(result.code, 3)
    assert.deepEqual(result.calls, [])
    assert.match(result.err[0] ?? '', /не доведено восстановление/)
  })
}

test('update: вопрос говорит цену вслух', () => {
  const found = MINE.find((command) => command.name === 'update')
  assert.match(found?.confirmQuestion ?? '', /комнаты/)
})

// -------------------------------------------------------------- cluster / service

test('cluster: четыре цели без переменных', async () => {
  for (const [name, target] of [
    ['cluster start', 'cluster-start'],
    ['cluster stop', 'cluster-stop'],
    ['cluster status', 'cluster-status'],
    ['cluster logs', 'cluster-logs'],
  ]) {
    const result = await run([...(name as string).split(' '), '--dry-run'])
    assert.deepEqual(result.out, ['make ' + (target as string)])
  }
})

test('cluster stop: спрашивает и считает комнаты, --yes снимает вопрос', async () => {
  const refused = await run(['cluster', 'stop'], { tty: true, answer: 'n' })
  assert.equal(refused.code, 4)
  assert.match(refused.asked[0] ?? '', /остановить приложение\?.*\[y\/N\]/)
  assert.deepEqual(refused.out, ['отменено'])

  const forced = await run(['cluster', 'stop', '--yes'])
  assert.deepEqual(forced.asked, [])
  assert.deepEqual(forced.calls, [['make', 'cluster-stop']])
})

test('cluster start и status ничего не спрашивают', async () => {
  const start = await run(['cluster', 'start'], { tty: true, answer: 'n' })
  assert.deepEqual(start.asked, [])
  assert.deepEqual(start.calls, [['make', 'cluster-start']])
  const status = await run(['cluster', 'status'], { tty: true, answer: 'n' })
  assert.deepEqual(status.calls, [['make', 'cluster-status']])
})

test('service: пять целей, install требует релиз', async () => {
  const install = await run(['service', 'install', '--release', 'release.json', '--dry-run'])
  assert.deepEqual(install.out, ['make service-install RELEASE=/repo/release.json'])

  const empty = await run(['service', 'install', '--yes'])
  assert.equal(empty.code, 2)
  assert.deepEqual(empty.calls, [])

  for (const [name, target] of [
    ['service restart', 'service-restart'],
    ['service stop', 'service-stop'],
    ['service status', 'service-status'],
    ['service logs', 'service-logs'],
  ]) {
    const result = await run([...(name as string).split(' '), '--dry-run'])
    assert.deepEqual(result.out, ['make ' + (target as string)])
  }
})

test('service restart и stop спрашивают, status и logs — нет', async () => {
  const restart = await run(['service', 'restart'], { tty: true, answer: 'n' })
  assert.equal(restart.code, 4)
  assert.match(restart.asked[0] ?? '', /перезапустить\?/)

  const stop = await run(['service', 'stop', '--yes'])
  assert.deepEqual(stop.asked, [])
  assert.deepEqual(stop.calls, [['make', 'service-stop']])

  const logs = await run(['service', 'logs'], { tty: true, answer: 'n' })
  assert.deepEqual(logs.asked, [])
  assert.deepEqual(logs.calls, [['make', 'service-logs']])
})

// ---------------------------------------------------------- release validate

test('release validate: манифест обязателен, цели нет в make help', async () => {
  const empty = await run(['release', 'validate'])
  assert.equal(empty.code, 2)
  assert.deepEqual(empty.calls, [])

  const ok = await run(['release', 'validate', 'RELEASE=release.json', '--dry-run'])
  assert.deepEqual(ok.out, ['make release-validate RELEASE=release.json'])

  const missing = await run(['release', 'validate', '--release', '/нет/release.json'])
  assert.equal(missing.code, 3)
  assert.deepEqual(missing.calls, [])
})

// --------------------------------------------------------------------- общее

test('код подчинённого процесса возвращается как есть', async () => {
  const result = await run(['vast', 'status', 'hse'], { exit: 7 })
  assert.equal(result.code, 7)
})

test('каждая команда группы: --dry-run печатает ровно одну строку и не запускает ничего', async () => {
  for (const command of MINE) {
    const argv = [...command.name.split(' '), '--dry-run']
    if (
      command.flags.some((flag) => flag.name === 'release') &&
      /release|install|update|rollback/.test(command.name)
    ) {
      argv.push('--release', 'release.json')
    }
    if (command.name === 'vast adopt') argv.push('hse')
    const result = await run(argv)
    assert.equal(result.code, 0, command.name + ': код не 0')
    assert.deepEqual(result.calls, [], command.name + ': что-то запустилось')
    assert.equal(result.out.length, 1, command.name + ': строк не одна — ' + result.out.join(' | '))
    assert.match(result.out[0] ?? '', /^make /, command.name + ': строка не про make')
  }
})

test('каждая команда группы: помощь называет делегата и не врёт про usage', () => {
  for (const command of MINE) {
    assert.ok(command.usage.startsWith('colloq ' + command.name), 'usage: ' + command.name)
    assert.match(command.delegates, /^make /, 'делегат: ' + command.name)
    assert.ok((command.examples ?? []).length >= 2, 'мало примеров: ' + command.name)
    for (const example of command.examples ?? []) {
      assert.ok(example.startsWith('colloq '), 'пример не про colloq: ' + command.name)
    }
  }
})

test('опасные команды группы названы опасными, читающие — нет', () => {
  const dangerous = new Set([
    'vast up',
    'vast sync',
    'vast down',
    'vast adopt',
    'install',
    'update',
    'rollback',
    'cluster stop',
    'service install',
    'service restart',
    'service stop',
  ])
  for (const command of MINE) {
    assert.equal(command.destructive, dangerous.has(command.name), 'опасность: ' + command.name)
  }
})

test('в выводе нет ни одного байта escape, пока цвет выключен', async () => {
  const result = await run(['vast', 'sync', 'hse', '--mode', 'consistent'], {
    tty: true,
    answer: 'n',
  })
  for (const line of [...result.out, ...result.err, ...result.asked]) {
    assert.equal(/\[/.test(line), false, 'цвет там, где его выключили: ' + line)
  }
})
