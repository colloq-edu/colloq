/**
 * Занятие в сети: host, tunnel setup, relay setup/page/ping, dns sync/point, sync.
 *
 * В первой половине файла не запускается ни один процесс и не читается ни один
 * настоящий файл: исполнитель подменён массивом вызовов, файловая система —
 * картой в памяти, вывод — массивом строк. Проверяется ровно то, за что
 * отвечает группа: какая строка уходит в make или в scripts/*.sh, что случается
 * без аргумента и кто спрашивает перед опасным действием.
 *
 * Вторая половина (в конце файла) читает настоящие scripts/host.sh, scripts/lib.sh
 * и scripts/pack.mts: строка может уходить верная, а на другом её конце не быть
 * ни скрипта, ни каталога состояния, — и увидеть это подставным исполнителем
 * нельзя. Почему это отдельная проверка, сказано там же.
 *
 * Общее (уникальность имён, --dry-run без запусков, русский summary, вопрос у
 * каждой опасной команды) стережёт tests/cli-core.test.mts — здесь не дублируем.
 */
import './_cli.mjs'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
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
    'RELAY_TOKEN=very-secret-token',
    'CF_TOKEN=zone-token',
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
  /**
   * Поставленный пакет: корень приложения и каталог состояния — разные, make
   * звать нечем. Умолчание — репозиторий, где они совпадают.
   */
  dist?: boolean
  home?: string
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
    home: opts.home,
    dist: opts.dist,
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
  // COLLOQ_HOME впереди — это каталог состояния: .env, расписка занятия и
  // .colloq.pid лежат там, а не рядом со скриптом. В репозитории это тот же
  // каталог, и строка от переменной не меняется ничем, кроме честности.
  assert.deepEqual(relay.out, ['COLLOQ_HOME=/repo make host HOST=hse.colloq.ru'])
  assert.deepEqual(spawned(relay), [])

  const direct = await run(['host', 'hse.colloq.ru', '--direct', '--dry-run'])
  assert.deepEqual(direct.out, ['COLLOQ_HOME=/repo make host-direct HOST=hse.colloq.ru'])

  const quick = await run(['host', '--dry-run'])
  assert.deepEqual(quick.out, ['COLLOQ_HOME=/repo make host'])

  const alias = await run(['public', 'hse.colloq.ru', '--dry-run'])
  assert.deepEqual(alias.out, ['COLLOQ_HOME=/repo make host HOST=hse.colloq.ru'])
})

test('host: пара HOST=… работает вместо позиционного и не дублируется', async () => {
  const result = await run(['host', 'HOST=hse.colloq.ru', '--dry-run'])
  assert.deepEqual(result.out, ['COLLOQ_HOME=/repo make host HOST=hse.colloq.ru'])
})

test('host: прямой режим без имени — отказ об употреблении, ничего не запущено', async () => {
  const result = await run(['host', '--direct', '--yes'], { tty: true })
  assert.equal(result.code, 2)
  assert.deepEqual(spawned(result), [])
  assert.match(result.err.join('\n'), /direct mode needs a name/)
})

test('host: имя не из латиницы — отказ, до make дело не доходит', async () => {
  const result = await run(['host', 'ХСЕ.colloq.ru', '--dry-run'])
  assert.equal(result.code, 2)
  assert.deepEqual(spawned(result), [])
  assert.match(result.err.join('\n'), /will not do/)
})

test('host --direct: вопрос называет цену, «нет» — код 4 и «отменено»', async () => {
  const no = await run(['host', 'hse.colloq.ru', '--direct'], { tty: true, answer: 'n' })
  assert.equal(no.code, 4)
  assert.deepEqual(spawned(no), [])
  assert.match(no.asked[0] ?? '', /caddy on 80 and 443.*hse\.colloq\.ru\?/)
  assert.deepEqual(no.out, ['cancelled'])

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
  assert.match(busy.asked[0] ?? '', /publish hse\.colloq\.ru\? 1 room is running/)
})

test('host: шапка называет транспорт, и она одна', async () => {
  const relay = await run(['host', 'hse.colloq.ru', '--yes'], { tty: true })
  // Шапка по-прежнему одна, а под ней — две строки о периметре: занятие идёт
  // без ограничений прода, и для открытой аудитории нужна серверная установка.
  // Те же слова говорит colloq doctor (PERIMETER в cli/src/commands/host.ts).
  assert.equal(relay.out[0], 'publishing hse.colloq.ru through the relay: keep this window open')
  assert.equal(relay.out.length, 3)
  assert.match(relay.out[1] ?? '', /without production limits/)
  assert.match(relay.out[2] ?? '', /server install/)

  const cloud = await run(['host', 'class.example.ru', '--yes'], { tty: true })
  assert.match(cloud.out.join('\n'), /through Cloudflare, which does not open from Russia/)
})

test('host: нет .env — код 3, назван путь и выполнимый совет', async () => {
  const result = await run(['host', 'hse.colloq.ru', '--yes'], {
    tty: true,
    files: { '/repo/.env': null },
  })
  assert.equal(result.code, 3)
  assert.deepEqual(spawned(result), [])
  // Путь целиком, а не «нет .env»: корня два, и человеку нужно знать, в каком
  // из них файла не хватает.
  assert.match(result.err.join('\n'), /no \/repo\/\.env/)
  // Совет должен быть выполнимым. Прежний — «cp .env.example .env» — врал
  // дважды: путь относительный (то есть в текущем каталоге человека), а
  // .env.example у поставленного пакета нет вовсе.
  assert.match(result.err.join('\n'), /colloq start/)

  const packaged = await run(['host', 'hse.colloq.ru', '--yes'], {
    tty: true,
    dist: true,
    home: '/home/.colloq',
    files: { '/repo/.env': null },
  })
  assert.equal(packaged.code, 3)
  assert.deepEqual(spawned(packaged), [])
  assert.match(packaged.err.join('\n'), /no \/home\/\.colloq\/\.env/)
  assert.doesNotMatch(packaged.err.join('\n'), /\.env\.example/)
})

/* -------------------------------------------------- host у поставленного colloq */

/**
 * Два корня: приложение отдельно, состояние отдельно.
 *
 * У поставленного через pip colloq каталог приложения лежит внутри пакета
 * (только чтение, сносится обновлением), а .env, расписка занятия и .colloq.pid
 * — в ~/.colloq. Отсюда два свойства, и оба стоили ссылки на паре: звать make
 * нечем — Makefile в колесо не едет, — и скрипту надо сказать, где состояние,
 * иначе он поищет его рядом с собой и опубликует адрес в файл, которого никто
 * не читает.
 */
const PACKAGED: Options = { dist: true, home: '/home/.colloq' }

test('host: у поставленного пакета зовётся сам скрипт, а не make', async () => {
  const relay = await run(['host', 'hse.colloq.ru', '--dry-run'], PACKAGED)
  assert.equal(relay.code, 0)
  assert.deepEqual(relay.out, [
    'COLLOQ_HOME=/home/.colloq COLLOQ_HOSTNAME=hse.colloq.ru ./scripts/host.sh',
  ])

  const direct = await run(['host', 'hse.colloq.ru', '--direct', '--dry-run'], PACKAGED)
  assert.deepEqual(direct.out, [
    'COLLOQ_HOME=/home/.colloq COLLOQ_DIRECT=1 COLLOQ_HOSTNAME=hse.colloq.ru ./scripts/host.sh',
  ])

  // Без имени — быстрый туннель: имя скрипту не выдумывается.
  const quick = await run(['host', '--dry-run'], PACKAGED)
  assert.deepEqual(quick.out, ['COLLOQ_HOME=/home/.colloq ./scripts/host.sh'])

  // Пары, написанные человеком, цель Makefile отдала бы рецепту окружением —
  // прямой вызов делает то же, иначе он вёл бы себя не как цель.
  const pair = await run(['host', 'hse.colloq.ru', 'PORT=3001', '--dry-run'], PACKAGED)
  assert.deepEqual(pair.out, [
    'COLLOQ_HOME=/home/.colloq PORT=3001 COLLOQ_HOSTNAME=hse.colloq.ru ./scripts/host.sh',
  ])
})

test('host: скрипт запускается по-настоящему и знает каталог состояния', async () => {
  const result = await run(['host', 'hse.colloq.ru', '--yes'], {
    ...PACKAGED,
    tty: true,
    files: { '/repo/.env': null, '/home/.colloq/.env': 'PORT=3000\nRELAY_DOMAIN=colloq.ru\n' },
  })
  assert.equal(result.code, 0)
  assert.deepEqual(spawned(result), [['./scripts/host.sh']])
  assert.deepEqual(result.envs[0], {
    COLLOQ_HOME: '/home/.colloq',
    COLLOQ_HOSTNAME: 'hse.colloq.ru',
  })
  // Настройки прочитаны из каталога состояния: RELAY_DOMAIN оттуда, и шапка
  // называет ретранслятор, а не Cloudflare.
  assert.match(result.out[0] ?? '', /through the relay/)
})

test('host: в репозитории идёт та же цель, и корень состояния назван и там', async () => {
  // Развилки «когда корни совпадают, не посылаем» нет намеренно: её пришлось
  // бы не забыть повторить в следующей команде. Тем же правилом живут copies и
  // link (cli/src/commands/local.ts · stateEnv).
  const result = await run(['host', 'hse.colloq.ru', '--yes'], { tty: true })
  assert.deepEqual(spawned(result), [['make', 'host', 'HOST=hse.colloq.ru']])
  assert.deepEqual(result.envs[0], { COLLOQ_HOME: '/repo' })
})

test('host-direct: отдельное имя делает то же, что host --direct', async () => {
  const dry = await run(['host-direct', 'hse.colloq.ru', '--dry-run'])
  assert.deepEqual(dry.out, ['COLLOQ_HOME=/repo make host-direct HOST=hse.colloq.ru'])

  const empty = await run(['host-direct', '--yes'], { tty: true })
  assert.equal(empty.code, 2)
  assert.deepEqual(spawned(empty), [])
})

/* ---------------------------------------------------------- tunnel setup */

test('tunnel setup: имя уходит в make tunnel-setup HOST=…', async () => {
  const dry = await run(['tunnel', 'setup', 'class.example.ru', '--dry-run'])
  assert.equal(dry.code, 0)
  assert.deepEqual(dry.out, ['make tunnel-setup HOST=class.example.ru'])

  const pair = await run(['tunnel', 'setup', 'HOST=class.example.ru', '--dry-run'])
  assert.deepEqual(pair.out, ['make tunnel-setup HOST=class.example.ru'])
})

test('tunnel setup: без имени и с коротким именем — код 2, ничего не запущено', async () => {
  const empty = await run(['tunnel', 'setup', '--yes'], { tty: true })
  assert.equal(empty.code, 2)
  assert.deepEqual(spawned(empty), [])
  assert.match(empty.err.join('\n'), /<name>/)

  const short = await run(['tunnel', 'setup', 'class', '--yes'], { tty: true })
  assert.equal(short.code, 2)
  assert.deepEqual(spawned(short), [])
})

test('tunnel setup: «нет» — код 4, --yes снимает вопрос', async () => {
  const no = await run(['tunnel', 'setup', 'class.example.ru'], { tty: true, answer: 'n' })
  assert.equal(no.code, 4)
  assert.deepEqual(spawned(no), [])
  assert.match(no.asked[0] ?? '', /a named tunnel and a CNAME record\?/)

  const yes = await run(['tunnel', 'setup', 'class.example.ru', '--yes'], { tty: true })
  assert.equal(yes.code, 0)
  assert.deepEqual(yes.asked, [])
  assert.deepEqual(spawned(yes), [['make', 'tunnel-setup', 'HOST=class.example.ru']])
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
  assert.match(empty.err.join('\n'), /<root@address>/)

  const no = await run(['relay', 'setup', 'root@203.0.113.10'], { tty: true, answer: 'n' })
  assert.equal(no.code, 4)
  assert.deepEqual(spawned(no), [])
  assert.match(no.asked[0] ?? '', /frps and caddy restart, and live tunnels break/)

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
    'native: relay ping (TCP RELAY_ADDR:RELAY_PORT from .env, 2s timeout)',
  ])
  assert.deepEqual(result.calls, [])
})

test('relay ping: ответил — ●, молчит — ○ и что делать; токена в выводе нет', async () => {
  const up = await run(['relay', 'ping'], {
    capture: (cmd) =>
      cmd === 'node' ? { code: 0, stdout: '', stderr: '' } : { code: 1, stdout: '', stderr: '' },
  })
  assert.equal(up.code, 0)
  assert.deepEqual(up.out, ['● 203.0.113.10:7000 answers'])
  const probe = up.calls.find((call) => call[1] === 'node')
  assert.deepEqual(probe?.slice(-2), ['203.0.113.10', '7000'])

  const down = await run(['relay', 'ping'])
  assert.equal(down.code, 1)
  assert.match(down.out.join('\n'), /○ 188\.119\.112\.65:7000 is silent/)
  assert.match(down.out.join('\n'), /→ check the machine/)
  assert.equal([...down.out, ...down.err].join('\n').includes('very-secret-token'), false)
})

test('relay ping: нет RELAY_ADDR — код 3 и куда идти', async () => {
  const files = { ...FILES, '/repo/.env': 'RELAY_DOMAIN=colloq.ru' }
  const result = await run(['relay', 'ping'], { files })
  assert.equal(result.code, 3)
  assert.deepEqual(result.calls, [])
  assert.match(result.err.join('\n'), /no RELAY_ADDR/)
  assert.match(result.err.join('\n'), /colloq relay setup/)
})

/* ------------------------------------------------------------------- dns */

test('dns sync: без зоны — голый скрипт, с зоной — DOMAIN=… перед ним', async () => {
  const plain = await run(['dns', 'sync', '--dry-run'])
  assert.equal(plain.code, 0)
  assert.deepEqual(plain.out, ['COLLOQ_HOME=/repo ./scripts/dns.sh'])

  const zone = await run(['dns', 'sync', '--domain', 'example.ru', '--dry-run'])
  assert.deepEqual(zone.out, ['COLLOQ_HOME=/repo DOMAIN=example.ru ./scripts/dns.sh'])

  const alias = await run(['dns', '--dry-run'])
  assert.deepEqual(alias.out, ['COLLOQ_HOME=/repo ./scripts/dns.sh'])

  const pair = await run(['dns', 'sync', 'DOMAIN=example.ru', '--dry-run'])
  assert.deepEqual(pair.out, ['COLLOQ_HOME=/repo DOMAIN=example.ru ./scripts/dns.sh'])
})

test('dns sync: зона не именем — код 2; «нет» — код 4; --yes запускает скрипт', async () => {
  const bad = await run(['dns', 'sync', '--domain', 'не зона', '--yes'], { tty: true })
  assert.equal(bad.code, 2)
  assert.deepEqual(spawned(bad), [])

  const no = await run(['dns', 'sync'], { tty: true, answer: 'n' })
  assert.equal(no.code, 4)
  assert.deepEqual(spawned(no), [])
  assert.match(no.asked[0] ?? '', /extra records of each \(type, name\) pair will be deleted/)

  const yes = await run(['dns', 'sync', '--domain', 'example.ru', '--yes'], { tty: true })
  assert.equal(yes.code, 0)
  assert.deepEqual(spawned(yes), [['./scripts/dns.sh']])
  assert.deepEqual(yes.envs[0], { COLLOQ_HOME: '/repo', DOMAIN: 'example.ru' })
})

test('dns: у поставленного пакета скрипт слышит, где лежит .env с CF_TOKEN', async () => {
  const files = { '/repo/.env': null, '/home/.colloq/.env': 'CF_TOKEN=zone-token\n' }
  const sync = await run(['dns', 'sync', '--yes'], { ...PACKAGED, tty: true, files })
  assert.equal(sync.code, 0)
  assert.deepEqual(sync.envs[0], { COLLOQ_HOME: '/home/.colloq' })

  const point = await run(['dns', 'point', 'hse.colloq.ru', '203.0.113.10', '--yes'], {
    ...PACKAGED,
    tty: true,
    files,
  })
  assert.equal(point.code, 0)
  assert.deepEqual(point.envs[0], { COLLOQ_HOME: '/home/.colloq' })
})

test('dns point: имя и адрес уходят скрипту позиционно', async () => {
  const dry = await run(['dns', 'point', 'hse.colloq.ru', '203.0.113.10', '--dry-run'])
  assert.equal(dry.code, 0)
  assert.deepEqual(dry.out, [
    'COLLOQ_HOME=/repo ./scripts/dns.sh point hse.colloq.ru 203.0.113.10',
  ])

  const pair = await run(['dns', 'point', 'HOST=hse.colloq.ru', 'IP=203.0.113.10', '--dry-run'])
  assert.deepEqual(pair.out, [
    'COLLOQ_HOME=/repo ./scripts/dns.sh point hse.colloq.ru 203.0.113.10',
  ])
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
  assert.match(no.asked[0] ?? '', /an explicit A record beats \*\.colloq\.ru/)

  const yes = await run(['dns', 'point', 'hse.colloq.ru', '203.0.113.10', '--yes'], { tty: true })
  assert.equal(yes.code, 0)
  assert.deepEqual(spawned(yes), [['./scripts/dns.sh', 'point', 'hse.colloq.ru', '203.0.113.10']])
})

test('вопрос не задаётся раньше проверки: плохой аргумент — код 2, а не 3', async () => {
  for (const argv of [
    ['tunnel', 'setup', 'class'],
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
  assert.match(alive.asked[0] ?? '', /run the load test while the server is running\?/)
  assert.deepEqual(alive.out, ['cancelled'])
})

/* ------------------------------------------- скрипты, которыми это и делается */

/**
 * Вторая половина файла — про то, чего подставным исполнителем не увидеть.
 *
 * Выше ни один процесс не запускается и ни один настоящий файл не читается:
 * проверяется, ЧТО уходит в make или в скрипт. Здесь проверяется то, что
 * лежит на другом конце этой строки, — и увидеть это можно только в настоящих
 * файлах. Находка была ровно там: строка уходила верная, а скрипта в пакете не
 * было вовсе, и `colloq host` умирал кодом 127 на единственной команде,
 * которой класс получает ссылку.
 */
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const hostSh = fs.readFileSync(path.join(repo, 'scripts/host.sh'), 'utf8')
const packMts = fs.readFileSync(path.join(repo, 'scripts/pack.mts'), 'utf8')

/** Строки без комментариев: про эти решения комментарии как раз и рассказывают. */
function code(text: string, mark = '#'): string {
  return text
    .split('\n')
    .filter((line) => !new RegExp(`^\\s*${mark}`).test(line))
    .join('\n')
}

/** Какие scripts/* этот скрипт зовёт (по строкам кода, не по рассказам о них). */
function invoked(text: string): Set<string> {
  return new Set([...code(text).matchAll(/\bscripts\/([A-Za-z0-9._-]+)/g)].map((hit) => hit[1]!))
}

/** Что scripts/pack.mts кладёт в колесо: ключи SCRIPTS. */
const packedScripts = new Set(
  [...packMts.matchAll(/^\s*'([A-Za-z0-9._-]+\.(?:sh|py))':/gm)].map((hit) => hit[1]!),
)

test('в колесо едет всё, что скрипты зовут, — и ничего из этого не забыто', () => {
  // Замыкание, а не список глазами: host.sh сорсит lib.sh, backup и restore
  // зовут cluster.sh и своих помощников на python. Пропусти одного — и отказ
  // придёт кодом 127 на машине преподавателя, а не здесь.
  assert.ok(packedScripts.has('host.sh'), 'scripts/host.sh не едет в колесо')
  const seen = new Set<string>()
  const queue = [...packedScripts]
  while (queue.length) {
    const name = queue.shift()!
    if (seen.has(name) || !name.endsWith('.sh')) continue
    seen.add(name)
    const text = fs.readFileSync(path.join(repo, 'scripts', name), 'utf8')
    for (const needed of invoked(text)) {
      if (needed.endsWith('.mts')) continue // их не копируют, а собирают — см. ниже
      assert.ok(
        packedScripts.has(needed),
        `scripts/${name} зовёт scripts/${needed}, а в колесо тот не едет`,
      )
      queue.push(needed)
    }
  }
})

test('расписку внешнего адреса host.sh зовёт бандлом, а исходник — только рядом с репозиторием', () => {
  // tsx в дистрибутиве нет вовсе: `node --import tsx` падал там ещё до первой
  // строки, и локальная сессия оставалась без адреса. Та же развилка, что у
  // супервизора в cli/src/commands/local.ts.
  const bundle = 'cli/public-url-lease.mjs'
  assert.match(code(hostSh), new RegExp(`\\[ -f ${bundle.replace('/', '\\/')} \\]`))
  assert.match(code(hostSh), /node --import tsx scripts\/public-url-lease\.mts/)
  // И бандл действительно собирается — тем же именем, иначе развилка молча
  // уходила бы в ветку tsx.
  assert.match(packMts, /entryPoints: \[path\.join\(root, 'scripts\/public-url-lease\.mts'\)\]/)
  assert.match(packMts, new RegExp(`outfile: path\\.join\\(appDir, '${bundle}'\\)`))
  // Развилка — массивом, а не функцией: сторож адреса уходит в фон, и в $!
  // должен оказаться номер самого node. У функции там был бы номер
  // подоболочки, cleanup убил бы её, а сторож остался бы сиротой и ещё три
  // секунды продлевал аренду адреса, который мы только что отдали.
  assert.match(code(hostSh), /^\s*LEASE=\(node /m)
  assert.match(code(hostSh), /"\$\{LEASE\[@\]\}" watch .* &$/m)
})

test('состояние скрипты ищут в каталоге состояния, а не рядом с собой', () => {
  const body = code(hostSh)
  // Расписка занятия и pid-файл — от корня состояния. Прежние умолчания были
  // относительными, то есть «рядом со скриптом».
  assert.match(body, /SESSION_RECEIPT="\$COLLOQ_STATE_ROOT\/\.colloq\/local-session\.json"/)
  assert.match(body, /PIDFILE="\$\{PIDFILE:-\$COLLOQ_STATE_ROOT\/\.colloq\.pid\}"/)
  assert.equal(/\$\{PIDFILE:-\.colloq\.pid\}/.test(body), false, 'pid-файл снова ищется у себя')
  assert.equal(
    /\[ -f \.colloq\/local-session\.json \]/.test(body),
    false,
    'расписка занятия снова ищется у себя',
  )
  // PUBLIC_URL пишется в тот .env, который читает colloq link, — иначе после
  // «успешной» публикации он продолжал бы говорить «наружу не выставлен».
  const setter = /^set_public_url\(\) \{$[\s\S]*?^\}$/m.exec(hostSh)![0]
  assert.match(setter, /"\$ENV_FILE"/)
  assert.equal(
    /(^|\s)\.env(\s|$)/m.test(code(setter)),
    false,
    'set_public_url снова пишет в ./.env',
  )
})

test('lib.sh: корень состояния — COLLOQ_HOME, а без него прежний каталог', () => {
  // Единственное место этого файла, где запускается процесс: свойство
  // проверяется на настоящем bash, потому что вся его суть — в подстановке
  // оболочки. Проверять её чтением значило бы проверять свою же догадку.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'colloq-state-'))
  try {
    fs.writeFileSync(path.join(dir, '.env'), 'PORT=3999\n')
    const ask = (cwd: string, home?: string): string =>
      execFileSync('bash', ['-c', `. "${path.join(repo, 'scripts/lib.sh')}"; read_env PORT`], {
        cwd,
        encoding: 'utf8',
        env:
          home === undefined
            ? { PATH: process.env.PATH ?? '' }
            : { PATH: process.env.PATH ?? '', COLLOQ_HOME: home },
      })
    // Названный каталог состояния сильнее того, где стоит скрипт: у
    // поставленного colloq это разные каталоги, и .env есть только в первом.
    assert.equal(ask(repo, dir), '3999')
    // Без переменной — как было: текущий каталог, в который скрипты переходят
    // сами (тот самый каталог над scripts/). В репозитории это он и есть.
    assert.equal(ask(dir), '3999')
    assert.equal(ask(os.tmpdir()), '')
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
