/**
 * Занятие в сети: colloq host — единственная команда группы.
 *
 * В первой половине файла не запускается ни один процесс и не читается ни один
 * настоящий файл: исполнитель подменён массивом вызовов, файловая система —
 * картой в памяти, вывод — массивом строк. Проверяется ровно то, за что
 * отвечает группа: какая строка уходит в scripts/host.sh, что случается с
 * плохим именем и кто спрашивает перед опасным действием.
 *
 * Вторая половина (в конце файла) читает настоящие scripts/host.sh, scripts/lib.sh
 * и scripts/pack.mts: строка может уходить верная, а на другом её конце не быть
 * ни скрипта, ни каталога состояния, — и увидеть это подставным исполнителем
 * нельзя. Почему это отдельная проверка, сказано там же.
 *
 * Общее (уникальность имён, --dry-run без запусков, вопрос у каждой опасной
 * команды) стережёт tests/cli-core.test.mts — здесь не дублируем.
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
import { registry } from '../cli/src/registry.js'

const ROOT = '/repo'

const FILES: Record<string, string> = {
  '/repo/package.json': '{ "name": "colloq", "version": "0.1.0" }',
  '/repo/cli/package.json': '{ "name": "@colloq/cli", "version": "0.1.0" }',
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
  /** Что отвечает подставной capture: сюда ходит docker ps. */
  capture?: (cmd: string, args: string[]) => { code: number; stdout: string; stderr: string }
  /**
   * Поставленный пакет или исходники. На поведение host это влиять не должно —
   * ради этого поле и оставлено: проверить, что не влияет.
   */
  dist?: boolean
  /** Каталог состояния. Умолчание — корень приложения, как в исходниках. */
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

/** Запуски без чтений: capture (docker ps) сюда не считается. */
function spawned(result: Harness): Call[] {
  return result.calls.filter((call) => call[0] !== 'capture')
}

/* ------------------------------------------------------------------ host */

test('host: имя уходит скрипту переменной, --direct добавляет COLLOQ_DIRECT=1', async () => {
  const relay = await run(['host', 'hse.colloq.ru', '--dry-run'])
  assert.equal(relay.code, 0)
  // COLLOQ_HOME впереди — это каталог состояния: .env, расписка занятия и
  // .colloq.pid лежат там, а не рядом со скриптом. В исходниках это тот же
  // каталог, и строка от переменной не меняется ничем, кроме честности.
  assert.deepEqual(relay.out, ['COLLOQ_HOME=/repo COLLOQ_HOSTNAME=hse.colloq.ru ./scripts/host.sh'])
  assert.deepEqual(spawned(relay), [])

  // Порядок — как в цели host-direct и в шапке host.sh: строку копируют.
  const direct = await run(['host', 'hse.colloq.ru', '--direct', '--dry-run'])
  assert.deepEqual(direct.out, [
    'COLLOQ_HOME=/repo COLLOQ_DIRECT=1 COLLOQ_HOSTNAME=hse.colloq.ru ./scripts/host.sh',
  ])

  // Без имени — быстрый туннель: имя скрипту не выдумывается.
  const quick = await run(['host', '--dry-run'])
  assert.deepEqual(quick.out, ['COLLOQ_HOME=/repo ./scripts/host.sh'])

  const alias = await run(['public', 'hse.colloq.ru', '--dry-run'])
  assert.deepEqual(alias.out, ['COLLOQ_HOME=/repo COLLOQ_HOSTNAME=hse.colloq.ru ./scripts/host.sh'])
})

test('host: из колеса и из исходников — одна и та же строка, make не зовётся никогда', async () => {
  // Прежде в исходниках уходило `make host HOST=…`, а в колесе — сам скрипт:
  // две ветки, и проверенной на машине автора была не та, что у
  // преподавателя. Теперь ветка одна, и ctx.dist её не трогает.
  for (const argv of [
    ['host', 'hse.colloq.ru'],
    ['host', 'hse.colloq.ru', '--direct'],
    ['host'],
  ]) {
    const source = await run([...argv, '--dry-run'], { dist: false, home: '/home/.colloq' })
    const wheel = await run([...argv, '--dry-run'], { dist: true, home: '/home/.colloq' })
    assert.deepEqual(source.out, wheel.out, argv.join(' '))
    assert.match(wheel.out[0] ?? '', /^COLLOQ_HOME=\/home\/\.colloq .*\.\/scripts\/host\.sh$/)
    assert.doesNotMatch(wheel.out[0] ?? '', /\bmake\b/)
  }
})

test('host: пары ВИДА=ЗНАЧЕНИЕ больше не разбираются — отказ, а не молчаливая подстановка', async () => {
  // HOST=… на месте имени — это имя, и в DNS оно не годится.
  const asName = await run(['host', 'HOST=hse.colloq.ru', '--dry-run'])
  assert.equal(asName.code, 2)
  assert.deepEqual(spawned(asName), [])
  assert.deepEqual(asName.out, [])
  assert.match(asName.err.join('\n'), /will not do/)

  // PORT=3001 после имени — лишний аргумент, и скрипту он окружением не уходит.
  const extra = await run(['host', 'hse.colloq.ru', 'PORT=3001', '--dry-run'])
  assert.equal(extra.code, 2)
  assert.deepEqual(spawned(extra), [])
  assert.deepEqual(extra.out, [])
  assert.match(extra.err.join('\n'), /extra argument: PORT=3001/)
})

test('host: прямой режим без имени — отказ об употреблении, ничего не запущено', async () => {
  const result = await run(['host', '--direct', '--yes'], { tty: true })
  assert.equal(result.code, 2)
  assert.deepEqual(spawned(result), [])
  assert.match(result.err.join('\n'), /direct mode needs a name/)
  assert.match(result.err.join('\n'), /colloq host class\.example\.org --direct/)

  // И под --dry-run тоже: строка с пустым COLLOQ_HOSTNAME была бы ложью о
  // том, что выполнится.
  const dry = await run(['host', '--direct', '--dry-run'])
  assert.equal(dry.code, 2)
  assert.deepEqual(dry.out, [])
})

test('host: имя не из латиницы — отказ, до скрипта дело не доходит', async () => {
  for (const name of [
    'ХСЕ.colloq.ru',
    'Hse.colloq.ru',
    'hse.colloq.ru-',
    'hse.colloq.ru.',
    'hse_colloq.ru',
  ]) {
    const result = await run(['host', name, '--dry-run'])
    assert.equal(result.code, 2, name)
    assert.deepEqual(spawned(result), [], name)
    assert.deepEqual(result.out, [], name)
    assert.match(result.err.join('\n'), /will not do/, name)
  }
})

test('host: вопрос не задаётся раньше проверки — плохое имя даёт код 2, а не 3', async () => {
  for (const argv of [
    ['host', 'ХСЕ.colloq.ru', '--direct'],
    ['host', '--direct'],
  ]) {
    // Ни терминала, ни --yes: каркас спросил бы и отказал с кодом 3 — но
    // check срабатывает раньше вопроса.
    const result = await run(argv)
    assert.equal(result.code, 2, argv.join(' '))
    assert.deepEqual(spawned(result), [], argv.join(' '))
    assert.deepEqual(result.asked, [], argv.join(' '))
  }
})

test('host --direct: вопрос называет цену, «нет» — код 4 и «отменено»', async () => {
  const no = await run(['host', 'hse.colloq.ru', '--direct'], { tty: true, answer: 'n' })
  assert.equal(no.code, 4)
  assert.deepEqual(spawned(no), [])
  assert.match(no.asked[0] ?? '', /caddy on 80 and 443.*hse\.colloq\.ru\?/)
  assert.deepEqual(no.out, ['cancelled'])

  const yes = await run(['host', 'hse.colloq.ru', '--direct'], { tty: true, answer: 'y' })
  assert.equal(yes.code, 0)
  assert.deepEqual(spawned(yes), [['./scripts/host.sh']])
  assert.deepEqual(yes.envs[0], {
    COLLOQ_HOME: '/repo',
    COLLOQ_DIRECT: '1',
    COLLOQ_HOSTNAME: 'hse.colloq.ru',
  })
})

test('host --direct --yes: вопроса нет вовсе', async () => {
  const result = await run(['host', 'hse.colloq.ru', '--direct', '--yes'], { tty: true })
  assert.equal(result.code, 0)
  assert.deepEqual(result.asked, [])
  assert.deepEqual(spawned(result), [['./scripts/host.sh']])
  assert.equal(result.envs[0]?.COLLOQ_DIRECT, '1')
})

test('host: туннель молчит, пока нет занятия, и спрашивает, когда оно идёт', async () => {
  const quiet = await run(['host', 'hse.colloq.ru'], { tty: true, answer: 'n' })
  assert.equal(quiet.code, 0)
  assert.deepEqual(quiet.asked, [])
  assert.deepEqual(spawned(quiet), [['./scripts/host.sh']])
  assert.deepEqual(quiet.envs[0], { COLLOQ_HOME: '/repo', COLLOQ_HOSTNAME: 'hse.colloq.ru' })

  const busy = await run(['host', 'hse.colloq.ru'], { tty: true, answer: 'n', capture: oneRoom })
  assert.equal(busy.code, 4)
  assert.deepEqual(spawned(busy), [])
  assert.match(busy.asked[0] ?? '', /publish hse\.colloq\.ru\? 1 room is running/)

  // Без имени вопрос называет занятие целиком, а не пустое место.
  const quick = await run(['host'], { tty: true, answer: 'n', capture: oneRoom })
  assert.equal(quick.code, 4)
  assert.match(quick.asked[0] ?? '', /publish the class\? 1 room is running/)
})

test('host: шапка называет транспорт, и она одна; под ней — две строки о периметре', async () => {
  const relay = await run(['host', 'hse.colloq.ru', '--yes'], { tty: true })
  // Шапка одна, а под ней — две строки о периметре: комната — укреплённый
  // контейнер без доступа к домашней сети, а ссылка всё равно дверь к коду на
  // этом компьютере. Те же слова говорит colloq doctor (PERIMETER в
  // cli/src/commands/host.ts).
  assert.equal(relay.out[0], 'publishing hse.colloq.ru through the relay: keep this window open')
  assert.equal(relay.out.length, 3)
  assert.match(relay.out[1] ?? '', /hardened container per room, cut off from your home network/)
  assert.match(relay.out[2] ?? '', /the link is a door: anyone who has it runs code in a sandbox/)
  assert.match(relay.out[2] ?? '', /keep it for your class; Ctrl\+C closes it/)
  // Прежние слова были правдой до укрепления комнат, и вернуться им нельзя.
  assert.doesNotMatch(relay.out.join('\n'), /without production limits|privileges are not dropped/)

  const cloud = await run(['host', 'class.example.ru', '--yes'], { tty: true })
  assert.match(cloud.out[0] ?? '', /through Cloudflare, which does not open from Russia/)

  const quick = await run(['host', '--yes'], { tty: true })
  assert.match(quick.out[0] ?? '', /quick Cloudflare tunnel: the name is random/)

  const direct = await run(['host', 'hse.colloq.ru', '--direct', '--yes'], { tty: true })
  assert.equal(
    direct.out[0],
    'installing caddy on this machine: it holds 80 and 443 for hse.colloq.ru',
  )
  assert.equal(direct.out.length, 3)

  // Секреты из .env в вывод не попадают ни строкой.
  for (const result of [relay, cloud, quick, direct]) {
    const text = [...result.out, ...result.err].join('\n')
    assert.equal(text.includes('very-secret-token'), false)
    assert.equal(text.includes('zone-token'), false)
  }
})

test('host: нет .env — код 3, назван путь и выполнимый совет, один и тот же везде', async () => {
  const source = await run(['host', 'hse.colloq.ru', '--yes'], {
    tty: true,
    files: { '/repo/.env': null },
  })
  assert.equal(source.code, 3)
  assert.deepEqual(spawned(source), [])
  // Путь целиком, а не «нет .env»: корня два, и человеку нужно знать, в каком
  // из них файла не хватает.
  assert.match(source.err.join('\n'), /no \/repo\/\.env/)
  // Совет должен быть выполнимым. Прежний — «cp .env.example .env» — врал
  // дважды: путь относительный (то есть в текущем каталоге человека), а
  // .env.example у поставленного пакета нет вовсе. Заводит .env colloq start,
  // и из исходников так же, поэтому совет один.
  assert.match(source.err.join('\n'), /colloq start creates it on the first run/)
  assert.doesNotMatch(source.err.join('\n'), /\.env\.example/)

  const packaged = await run(['host', 'hse.colloq.ru', '--yes'], {
    tty: true,
    dist: true,
    home: '/home/.colloq',
    files: { '/repo/.env': null },
  })
  assert.equal(packaged.code, 3)
  assert.deepEqual(spawned(packaged), [])
  assert.match(packaged.err.join('\n'), /no \/home\/\.colloq\/\.env/)
  assert.match(packaged.err.join('\n'), /colloq start creates it on the first run/)
  assert.doesNotMatch(packaged.err.join('\n'), /\.env\.example/)
})

test('host: нет .env, но --dry-run — строка печатается, проверка .env не нужна', async () => {
  // --dry-run только показывает, что выполнится, и ничего не читает сверх
  // аргументов: отказ за отсутствующий .env здесь был бы отказом зря.
  const result = await run(['host', 'hse.colloq.ru', '--dry-run'], {
    files: { '/repo/.env': null },
  })
  assert.equal(result.code, 0)
  assert.deepEqual(result.out, [
    'COLLOQ_HOME=/repo COLLOQ_HOSTNAME=hse.colloq.ru ./scripts/host.sh',
  ])
})

/* -------------------------------------------------- host у поставленного colloq */

/**
 * Два корня: приложение отдельно, состояние отдельно.
 *
 * У поставленного через pip colloq каталог приложения лежит внутри пакета
 * (только чтение, сносится обновлением), а .env, расписка занятия и .colloq.pid
 * — в ~/.colloq. Скрипту надо сказать, где состояние, иначе он поищет его
 * рядом с собой и опубликует адрес в файл, которого никто не читает.
 */
const PACKAGED: Options = { dist: true, home: '/home/.colloq' }

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

test('host: в исходниках корень состояния назван так же, хотя и совпадает с приложением', async () => {
  // Развилки «когда корни совпадают, не посылаем» нет намеренно: её пришлось
  // бы не забыть повторить в следующей команде. Тем же правилом живут copies и
  // link (cli/src/commands/local.ts · stateEnv).
  const result = await run(['host', '--yes'], { tty: true })
  assert.deepEqual(spawned(result), [['./scripts/host.sh']])
  assert.deepEqual(result.envs[0], { COLLOQ_HOME: '/repo' })
})

/* ------------------------------------------------------- состав группы */

test('в группе одна команда — host; мастерская отсюда не зовётся', () => {
  // Ретранслятор, DNS, именованный туннель и стенд ставят и правят чужие
  // машины и зону: это Makefile и scripts/, обёртки над ними в CLI нет.
  const group = registry.filter((command) => command.group === 'host')
  assert.deepEqual(
    group.map((command) => command.name),
    ['host'],
  )
  // Второе имя у host одно — public; прямой режим живёт флагом --direct, а не
  // отдельной командой host-direct.
  assert.deepEqual(group[0]?.aliases, ['public'])
})

test('прежние имена мастерской — «нет такой команды», и ничего не запущено', async () => {
  for (const argv of [
    ['host-direct', 'hse.colloq.ru'],
    ['tunnel', 'setup', 'class.example.ru'],
    ['relay', 'setup', 'root@203.0.113.10'],
    ['relay', 'ping'],
    ['dns', 'point', 'hse.colloq.ru', '203.0.113.10'],
  ]) {
    const result = await run([...argv, '--yes'], { tty: true })
    assert.equal(result.code, 2, argv.join(' '))
    assert.deepEqual(spawned(result), [], argv.join(' '))
    assert.deepEqual(result.asked, [], argv.join(' '))
  }
})

/* ------------------------------------------- скрипты, которыми это и делается */

/**
 * Вторая половина файла — про то, чего подставным исполнителем не увидеть.
 *
 * Выше ни один процесс не запускается и ни один настоящий файл не читается:
 * проверяется, ЧТО уходит в скрипт. Здесь проверяется то, что
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
