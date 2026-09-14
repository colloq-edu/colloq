/**
 * Занятие в сети: host, tunnel setup, relay setup/page/ping, dns sync/point, sync.
 *
 * Здесь не запускается ни один процесс и не читается ни один настоящий файл:
 * исполнитель подменён массивом вызовов, файловая система — картой в памяти,
 * вывод — массивом строк. Проверяется ровно то, за что отвечает группа: какая
 * строка уходит в make или в scripts/*.sh, что случается без аргумента и кто
 * спрашивает перед опасным действием.
 *
 * Общее (уникальность имён, --dry-run без запусков, русский summary, вопрос у
 * каждой опасной команды) стережёт tests/cli-core.test.mts — здесь не дублируем.
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
  '/repo/Makefile': ['host: .env', 'host-direct: .env', 'sync:', 'relay-setup:'].join('\n'),
  '/repo/.env': [
    'PORT=3000',
    'KERNEL_ENV=base',
    'RELAY_DOMAIN=colloq.ru',
    'RELAY_ADDR=203.0.113.10',
    'RELAY_PORT=7000',
    'RELAY_TOKEN=очень-секретный-токен',
    'CF_TOKEN=токен-зоны',
  ].join('\n'),
}

type Call = string[]

type Harness = {
  code: number
  out: string[]
  err: string[]
  calls: Call[]
  envs: (Record<string, string> | undefined)[]
  asked: string[]
}

type Options = {
  /** Правка карты файлов: null — файла нет вовсе (так проверяется отсутствие .env). */
  files?: Record<string, string | null>
  answer?: string
  tty?: boolean
  /** Что отвечает подставной capture: сюда ходят docker ps и проба TCP. */
  capture?: (cmd: string, args: string[]) => { code: number; stdout: string; stderr: string }
}

/** Тот же образец, что в cli-core: ни одного настоящего процесса и файла. */
async function run(argv: string[], opts: Options = {}): Promise<Harness> {
  const out: string[] = []
  const err: string[] = []
  const calls: Call[] = []
  const envs: (Record<string, string> | undefined)[] = []
  const asked: string[] = []
  const files: Record<string, string> = { ...FILES }
  for (const [path, text] of Object.entries(opts.files ?? {})) {
    if (text === null) delete files[path]
    else files[path] = text
  }
  const io = createMemoryIo(files, 1_700_000_000_000)
  const code = await cli(argv, {
    io,
    root: ROOT,
    cwd: ROOT,
    out: (line) => void out.push(line),
    err: (line) => void err.push(line),
    tty: opts.tty ?? false,
    processEnv: {},
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
        return 0
      },
      async capture(cmd, args) {
        calls.push(['capture', cmd, ...args])
        return opts.capture?.(cmd, args) ?? { code: 1, stdout: '', stderr: '' }
      },
    },
  })
  return { code, out, err, calls, envs, asked }
}

/** Идёт одна комната: docker ps отвечает одной строкой. */
const oneRoom: Options['capture'] = (cmd) =>
  cmd === 'docker'
    ? { code: 0, stdout: 'c0ffee\n', stderr: '' }
    : { code: 1, stdout: '', stderr: '' }

/** Запуски без чтений: capture (docker ps, проба TCP) сюда не считается. */
function spawned(result: Harness): Call[] {
  return result.calls.filter((call) => call[0] !== 'capture')
}

/* ------------------------------------------------------------------ host */

test('host: имя уходит в make host HOST=…, --direct — в host-direct', async () => {
  const relay = await run(['host', 'hse.colloq.ru', '--dry-run'])
  assert.equal(relay.code, 0)
  assert.deepEqual(relay.out, ['make host HOST=hse.colloq.ru'])
  assert.deepEqual(spawned(relay), [])

  const direct = await run(['host', 'hse.colloq.ru', '--direct', '--dry-run'])
  assert.deepEqual(direct.out, ['make host-direct HOST=hse.colloq.ru'])

  const quick = await run(['host', '--dry-run'])
  assert.deepEqual(quick.out, ['make host'])

  const alias = await run(['public', 'hse.colloq.ru', '--dry-run'])
  assert.deepEqual(alias.out, ['make host HOST=hse.colloq.ru'])
})

test('host: пара HOST=… работает вместо позиционного и не дублируется', async () => {
  const result = await run(['host', 'HOST=hse.colloq.ru', '--dry-run'])
  assert.deepEqual(result.out, ['make host HOST=hse.colloq.ru'])
})

test('host: прямой режим без имени — отказ об употреблении, ничего не запущено', async () => {
  const result = await run(['host', '--direct', '--yes'], { tty: true })
  assert.equal(result.code, 2)
  assert.deepEqual(spawned(result), [])
  assert.match(result.err.join('\n'), /прямому режиму нужно имя/)
})

test('host: имя не из латиницы — отказ, до make дело не доходит', async () => {
  const result = await run(['host', 'ХСЕ.colloq.ru', '--dry-run'])
  assert.equal(result.code, 2)
  assert.deepEqual(spawned(result), [])
  assert.match(result.err.join('\n'), /не годится/)
})

test('host --direct: вопрос называет цену, «нет» — код 4 и «отменено»', async () => {
  const no = await run(['host', 'hse.colloq.ru', '--direct'], { tty: true, answer: 'n' })
  assert.equal(no.code, 4)
  assert.deepEqual(spawned(no), [])
  assert.match(no.asked[0] ?? '', /caddy на 80 и 443.*hse\.colloq\.ru\?/)
  assert.deepEqual(no.out, ['отменено'])

  const yes = await run(['host', 'hse.colloq.ru', '--direct'], { tty: true, answer: 'y' })
  assert.equal(yes.code, 0)
  assert.deepEqual(spawned(yes), [['make', 'host-direct', 'HOST=hse.colloq.ru']])
})

test('host --direct --yes: вопроса нет вовсе', async () => {
  const result = await run(['host', 'hse.colloq.ru', '--direct', '--yes'], { tty: true })
  assert.equal(result.code, 0)
  assert.deepEqual(result.asked, [])
  assert.deepEqual(spawned(result), [['make', 'host-direct', 'HOST=hse.colloq.ru']])
})

test('host: туннель молчит, пока нет занятия, и спрашивает, когда оно идёт', async () => {
  const quiet = await run(['host', 'hse.colloq.ru'], { tty: true, answer: 'n' })
  assert.equal(quiet.code, 0)
  assert.deepEqual(quiet.asked, [])
  assert.deepEqual(spawned(quiet), [['make', 'host', 'HOST=hse.colloq.ru']])

  const busy = await run(['host', 'hse.colloq.ru'], { tty: true, answer: 'n', capture: oneRoom })
  assert.equal(busy.code, 4)
  assert.deepEqual(spawned(busy), [])
  assert.match(busy.asked[0] ?? '', /выставить hse\.colloq\.ru наружу\? сейчас идёт 1 комната/)
})

test('host: шапка называет транспорт, и она одна', async () => {
  const relay = await run(['host', 'hse.colloq.ru', '--yes'], { tty: true })
  assert.deepEqual(relay.out, [
    'выставляю hse.colloq.ru через ретранслятор — окно держать открытым',
  ])

  const cloud = await run(['host', 'seminar.example.ru', '--yes'], { tty: true })
  assert.match(cloud.out.join('\n'), /через Cloudflare — из России он не открывается/)
})

test('host: нет .env — код 3 и ни одного запуска', async () => {
  const result = await run(['host', 'hse.colloq.ru', '--yes'], {
    tty: true,
    files: { '/repo/.env': null },
  })
  assert.equal(result.code, 3)
  assert.deepEqual(spawned(result), [])
  assert.match(result.err.join('\n'), /нет \.env/)
})

test('host-direct: отдельное имя делает то же, что host --direct', async () => {
  const dry = await run(['host-direct', 'hse.colloq.ru', '--dry-run'])
  assert.deepEqual(dry.out, ['make host-direct HOST=hse.colloq.ru'])

  const empty = await run(['host-direct', '--yes'], { tty: true })
  assert.equal(empty.code, 2)
  assert.deepEqual(spawned(empty), [])
})

/* ---------------------------------------------------------- tunnel setup */

test('tunnel setup: имя уходит в make tunnel-setup HOST=…', async () => {
  const dry = await run(['tunnel', 'setup', 'seminar.example.ru', '--dry-run'])
  assert.equal(dry.code, 0)
  assert.deepEqual(dry.out, ['make tunnel-setup HOST=seminar.example.ru'])

  const pair = await run(['tunnel', 'setup', 'HOST=seminar.example.ru', '--dry-run'])
  assert.deepEqual(pair.out, ['make tunnel-setup HOST=seminar.example.ru'])
})

test('tunnel setup: без имени и с коротким именем — код 2, ничего не запущено', async () => {
  const empty = await run(['tunnel', 'setup', '--yes'], { tty: true })
  assert.equal(empty.code, 2)
  assert.deepEqual(spawned(empty), [])
  assert.match(empty.err.join('\n'), /обязательного аргумента <имя>/)

  const short = await run(['tunnel', 'setup', 'seminar', '--yes'], { tty: true })
  assert.equal(short.code, 2)
  assert.deepEqual(spawned(short), [])
})

test('tunnel setup: «нет» — код 4, --yes снимает вопрос', async () => {
  const no = await run(['tunnel', 'setup', 'seminar.example.ru'], { tty: true, answer: 'n' })
  assert.equal(no.code, 4)
  assert.deepEqual(spawned(no), [])
  assert.match(no.asked[0] ?? '', /туннель и запись CNAME\?/)

  const yes = await run(['tunnel', 'setup', 'seminar.example.ru', '--yes'], { tty: true })
  assert.equal(yes.code, 0)
  assert.deepEqual(yes.asked, [])
  assert.deepEqual(spawned(yes), [['make', 'tunnel-setup', 'HOST=seminar.example.ru']])
})

/* ------------------------------------------------------ relay setup/page */

test('relay setup: машина уходит в make relay-setup WHERE=…', async () => {
  const dry = await run(['relay', 'setup', 'root@203.0.113.10', '--dry-run'])
  assert.deepEqual(dry.out, ['make relay-setup WHERE=root@203.0.113.10'])

  const pair = await run(['relay', 'setup', 'WHERE=root@203.0.113.10', '--dry-run'])
  assert.deepEqual(pair.out, ['make relay-setup WHERE=root@203.0.113.10'])
})

test('relay setup: без машины — код 2; вопрос говорит про обрыв туннелей', async () => {
  const empty = await run(['relay', 'setup', '--yes'], { tty: true })
  assert.equal(empty.code, 2)
  assert.deepEqual(spawned(empty), [])
  assert.match(empty.err.join('\n'), /обязательного аргумента <root@адрес>/)

  const no = await run(['relay', 'setup', 'root@203.0.113.10'], { tty: true, answer: 'n' })
  assert.equal(no.code, 4)
  assert.deepEqual(spawned(no), [])
  assert.match(no.asked[0] ?? '', /frps и caddy перезапустятся, живые туннели оборвутся/)

  const yes = await run(['relay', 'setup', 'root@203.0.113.10', '--yes'], { tty: true })
  assert.deepEqual(spawned(yes), [['make', 'relay-setup', 'WHERE=root@203.0.113.10']])
})

test('relay page: дешёвый путь, без вопроса и без перезапусков', async () => {
  const dry = await run(['relay', 'page', 'root@203.0.113.10', '--dry-run'])
  assert.deepEqual(dry.out, ['make relay-page WHERE=root@203.0.113.10'])

  const real = await run(['relay', 'page', 'root@203.0.113.10'], { tty: true, answer: 'n' })
  assert.equal(real.code, 0)
  assert.deepEqual(real.asked, [])
  assert.deepEqual(spawned(real), [['make', 'relay-page', 'WHERE=root@203.0.113.10']])

  const empty = await run(['relay', 'page'])
  assert.equal(empty.code, 2)
  assert.deepEqual(spawned(empty), [])
})

/* -------------------------------------------------------------- relay ping */

test('relay ping: --dry-run печатает одну строку native и ничего не трогает', async () => {
  const result = await run(['relay', 'ping', '--dry-run'])
  assert.equal(result.code, 0)
  assert.deepEqual(result.out, [
    'native: relay ping (TCP RELAY_ADDR:RELAY_PORT из .env, таймаут 2 с)',
  ])
  assert.deepEqual(result.calls, [])
})

test('relay ping: ответил — ●, молчит — ○ и что делать; токена в выводе нет', async () => {
  const up = await run(['relay', 'ping'], {
    capture: (cmd) =>
      cmd === 'node' ? { code: 0, stdout: '', stderr: '' } : { code: 1, stdout: '', stderr: '' },
  })
  assert.equal(up.code, 0)
  assert.deepEqual(up.out, ['● 203.0.113.10:7000 отвечает'])
  const probe = up.calls.find((call) => call[1] === 'node')
  assert.deepEqual(probe?.slice(-2), ['203.0.113.10', '7000'])

  const down = await run(['relay', 'ping'])
  assert.equal(down.code, 1)
  assert.match(down.out.join('\n'), /○ 188\.119\.112\.65:7000 молчит/)
  assert.match(down.out.join('\n'), /→ проверить машину/)
  assert.equal([...down.out, ...down.err].join('\n').includes('очень-секретный-токен'), false)
})

test('relay ping: нет RELAY_ADDR — код 3 и куда идти', async () => {
  const files = { ...FILES, '/repo/.env': 'RELAY_DOMAIN=colloq.ru' }
  const result = await run(['relay', 'ping'], { files })
  assert.equal(result.code, 3)
  assert.deepEqual(result.calls, [])
  assert.match(result.err.join('\n'), /нет RELAY_ADDR/)
  assert.match(result.err.join('\n'), /colloq relay setup/)
})

/* ------------------------------------------------------------------- dns */

test('dns sync: без зоны — голый скрипт, с зоной — DOMAIN=… перед ним', async () => {
  const plain = await run(['dns', 'sync', '--dry-run'])
  assert.equal(plain.code, 0)
  assert.deepEqual(plain.out, ['./scripts/dns.sh'])

  const zone = await run(['dns', 'sync', '--domain', 'example.ru', '--dry-run'])
  assert.deepEqual(zone.out, ['DOMAIN=example.ru ./scripts/dns.sh'])

  const alias = await run(['dns', '--dry-run'])
  assert.deepEqual(alias.out, ['./scripts/dns.sh'])

  const pair = await run(['dns', 'sync', 'DOMAIN=example.ru', '--dry-run'])
  assert.deepEqual(pair.out, ['DOMAIN=example.ru ./scripts/dns.sh'])
})

test('dns sync: зона не именем — код 2; «нет» — код 4; --yes запускает скрипт', async () => {
  const bad = await run(['dns', 'sync', '--domain', 'не зона', '--yes'], { tty: true })
  assert.equal(bad.code, 2)
  assert.deepEqual(spawned(bad), [])

  const no = await run(['dns', 'sync'], { tty: true, answer: 'n' })
  assert.equal(no.code, 4)
  assert.deepEqual(spawned(no), [])
  assert.match(no.asked[0] ?? '', /лишние записи каждой пары \(тип, имя\) будут удалены/)

  const yes = await run(['dns', 'sync', '--domain', 'example.ru', '--yes'], { tty: true })
  assert.equal(yes.code, 0)
  assert.deepEqual(spawned(yes), [['./scripts/dns.sh']])
  assert.deepEqual(yes.envs[0], { DOMAIN: 'example.ru' })
})

test('dns point: имя и адрес уходят скрипту позиционно', async () => {
  const dry = await run(['dns', 'point', 'hse.colloq.ru', '203.0.113.10', '--dry-run'])
  assert.equal(dry.code, 0)
  assert.deepEqual(dry.out, ['./scripts/dns.sh point hse.colloq.ru 203.0.113.10'])

  const pair = await run(['dns', 'point', 'HOST=hse.colloq.ru', 'IP=203.0.113.10', '--dry-run'])
  assert.deepEqual(pair.out, ['./scripts/dns.sh point hse.colloq.ru 203.0.113.10'])
})

test('dns point: нет имени, нет адреса, адрес не IPv4 — код 2 и ни одного запуска', async () => {
  for (const argv of [
    ['dns', 'point'],
    ['dns', 'point', 'hse.colloq.ru'],
    ['dns', 'point', 'hse.colloq.ru', '300.1.1.1'],
    ['dns', 'point', 'hse', '203.0.113.10'],
  ]) {
    const result = await run([...argv, '--yes'], { tty: true })
    assert.equal(result.code, 2, argv.join(' '))
    assert.deepEqual(spawned(result), [], argv.join(' '))
    assert.match(result.err.join('\n'), /✗/)
  }
})

test('dns point: «нет» — код 4, --yes запускает скрипт', async () => {
  const no = await run(['dns', 'point', 'hse.colloq.ru', '203.0.113.10'], {
    tty: true,
    answer: 'n',
  })
  assert.equal(no.code, 4)
  assert.deepEqual(spawned(no), [])
  assert.match(no.asked[0] ?? '', /явная A-запись сильнее \*\.colloq\.ru/)

  const yes = await run(['dns', 'point', 'hse.colloq.ru', '203.0.113.10', '--yes'], { tty: true })
  assert.equal(yes.code, 0)
  assert.deepEqual(spawned(yes), [['./scripts/dns.sh', 'point', 'hse.colloq.ru', '203.0.113.10']])
})

test('вопрос не задаётся раньше проверки: плохой аргумент — код 2, а не 3', async () => {
  for (const argv of [
    ['tunnel', 'setup', 'seminar'],
    ['relay', 'setup', 'ssh://203.0.113.10'],
    ['dns', 'point', 'hse', '203.0.113.10'],
    ['dns', 'sync', '--domain', 'зона'],
  ]) {
    // Ни терминала, ни --yes: каркас спросил бы и отказал с кодом 3 — но
    // check срабатывает раньше вопроса.
    const result = await run(argv)
    assert.equal(result.code, 2, argv.join(' '))
    assert.deepEqual(spawned(result), [], argv.join(' '))
    assert.deepEqual(result.asked, [], argv.join(' '))
  }
})

/* ------------------------------------------------------------------ sync */

test('sync: make sync, а с --headed — HEADED=1', async () => {
  const plain = await run(['sync', '--dry-run'])
  assert.deepEqual(plain.out, ['make sync'])

  const headed = await run(['sync', '--headed', '--dry-run'])
  assert.deepEqual(headed.out, ['make sync HEADED=1'])

  const pair = await run(['sync', 'HEADED=1', '--dry-run'])
  assert.deepEqual(pair.out, ['make sync HEADED=1'])
})

test('sync: спрашивает только при живом сервере', async () => {
  const quiet = await run(['sync'], { tty: true, answer: 'n' })
  assert.equal(quiet.code, 0)
  assert.deepEqual(quiet.asked, [])
  assert.deepEqual(spawned(quiet), [['make', 'sync']])

  const alive = await run(['sync'], {
    tty: true,
    answer: 'n',
    files: { '/repo/.colloq.pid': '4242\n' },
  })
  assert.equal(alive.code, 4)
  assert.deepEqual(spawned(alive), [])
  assert.match(alive.asked[0] ?? '', /гнать стенд, пока сервер работает\?/)
  assert.deepEqual(alive.out, ['отменено'])
})
