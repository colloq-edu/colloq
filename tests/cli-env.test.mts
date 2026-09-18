/**
 * Группа env: окружения ядра.
 *
 * Ни один процесс здесь не запускается и ни один настоящий файл не читается
 * командами: исполнитель подставной и пишет вызовы в массив, io — карта файлов
 * в памяти. Настоящие kernel/environments/*.txt читает только сам тест — и
 * кладёт их в ту же карту, чтобы сверить машинный вид с правилом счёта, которым
 * пользуется и цель env-list в Makefile.
 *
 * Все четыре команды группы — list, show, new, use — только файлы: ни одна
 * ничего не запускает, и массив вызовов после каждой обязан остаться пустым.
 * Поэтому проверяется и то, ЧТО написано: карта файлов возвращается наружу
 * (Harness.io), и после команды в неё заглядывают.
 */
import './_cli.mjs'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { cli } from '../cli/src/main.js'
import { createEnv, createMemoryIo, type Io } from '../cli/src/env.js'
import { commands, envFileIn, listEnvNames } from '../cli/src/commands/env.js'
import { PYTHON_VERSIONS } from '../shared/admin.js'

const ROOT = '/repo'

const FILES: Record<string, string> = {
  '/repo/package.json': '{ "name": "colloq", "version": "0.1.0" }',
  '/repo/cli/package.json': '{ "name": "@colloq/cli", "version": "0.1.0" }',
  '/repo/.env': ['PORT=3000', 'KERNEL_ENV=cv', 'RELAY_DOMAIN=hse.colloq.ru'].join('\n'),
  '/repo/kernel/Dockerfile': ['FROM scratch', 'ARG PARENT=python:3.11-slim-bookworm'].join('\n'),
  '/repo/kernel/requirements.txt': [
    'jupyter-server>=2.14,<3',
    '# кнопка FORMAT',
    'numpy>=1.26',
  ].join('\n'),
  '/repo/kernel/environments/base.txt': '# Базовое окружение — здесь намеренно пусто.\n',
  '/repo/kernel/environments/base-gpu.txt': [
    '# Тяжёлая половина GPU-окружений.',
    '# colloq: gpu',
    '# colloq: python 3.12',
    'torch>=2.4',
    'torchvision>=0.19',
  ].join('\n'),
  '/repo/kernel/environments/cv.txt': [
    '# Компьютерное зрение.',
    '',
    '--extra-index-url https://download.pytorch.org/whl/cpu',
    'torch>=2.4',
    'torchvision>=0.19',
  ].join('\n'),
  '/repo/kernel/environments/gpu.txt': [
    '# Нейросети на GPU.',
    '# colloq: from base-gpu',
    'transformers>=4.44',
    'accelerate>=0.33',
  ].join('\n'),
}

/** Два окружения, сославшиеся друг на друга: цепочка, которой не бывает. */
const RING: Record<string, string> = {
  '/repo/kernel/environments/ring.txt': ['# Петля.', '# colloq: from ring2', 'timm'].join('\n'),
  '/repo/kernel/environments/ring2.txt': ['# Вторая половина петли.', '# colloq: from ring'].join(
    '\n',
  ),
}

type Harness = {
  code: number
  out: string[]
  err: string[]
  calls: string[][]
  asked: string[]
  io: Io
}

async function run(
  argv: string[],
  opts: {
    files?: Record<string, string>
    answer?: string
    tty?: boolean
    /**
     * Установленный colloq. Поведение команд от него не зависит; он решает
     * только умолчания нового .env — те же, что написал бы запуск.
     */
    dist?: boolean
    /** Каталог состояния, когда он не совпадает с каталогом приложения. */
    home?: string
    /** Пути, которых на этой машине нет: чистое место проверяется тоже. */
    without?: string[]
  } = {},
): Promise<Harness> {
  const out: string[] = []
  const err: string[] = []
  const calls: string[][] = []
  const asked: string[] = []
  const map: Record<string, string> = { ...FILES, ...(opts.files ?? {}) }
  for (const path of opts.without ?? []) delete map[path]
  const io = createMemoryIo(map, 1_700_000_000_000)
  const code = await cli(argv, {
    io,
    root: ROOT,
    home: opts.home,
    cwd: ROOT,
    out: (line) => void out.push(line),
    err: (line) => void err.push(line),
    tty: opts.tty ?? false,
    dist: opts.dist ?? false,
    processEnv: {},
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
      async capture() {
        // Счёт комнат каркасом — чтение, а не запуск: в calls ему не место.
        return { code: 1, stdout: '', stderr: '' }
      },
    },
  })
  return { code, out, err, calls, asked, io }
}

/** Строка списка ровно той ширины, какой её печатает цель env-list (%-14s). */
function row(mark: string, name: string, tail: string): string {
  return '  ' + mark + ' ' + name.padEnd(14) + ' ' + tail
}

/** Настоящие файлы окружений в карте памяти: путь тот же, содержимое своё. */
function realFiles(): Record<string, string> {
  const files: Record<string, string> = {
    '/repo/kernel/Dockerfile': readFileSync(
      new URL('../kernel/Dockerfile', import.meta.url),
      'utf8',
    ),
    '/repo/kernel/requirements.txt': readFileSync(
      new URL('../kernel/requirements.txt', import.meta.url),
      'utf8',
    ),
    // Своя строка вместо настоящего .env: в тест он не ходит.
    '/repo/.env': 'KERNEL_ENV=base\n',
  }
  const dir = new URL('../kernel/environments/', import.meta.url)
  for (const name of readdirSync(dir)) {
    if (!name.endsWith('.txt')) continue
    files['/repo/kernel/environments/' + name] = readFileSync(new URL(name, dir), 'utf8')
  }
  return files
}

// -------------------------------------------------------------- два каталога

test('два каталога окружений: в репозитории один путь, у установленного — разные', () => {
  const io = createMemoryIo({})
  const repo = createEnv({ io, root: '/repo' })
  assert.equal(repo.paths.ownEnvDir, '/repo/kernel/environments')
  assert.equal(repo.paths.ownEnvDir, repo.paths.envDir, 'в клоне писать некуда, кроме kernel/')

  const installed = createEnv({ io, root: '/app', home: '/home/teacher/.colloq' })
  assert.equal(installed.paths.envDir, '/app/kernel/environments')
  assert.equal(installed.paths.ownEnvDir, '/home/teacher/.colloq/environments')
})

test('список — объединение двух каталогов, своё имя перекрывает привезённое', () => {
  const dirs = { app: '/app/kernel/environments', own: '/home/.colloq/environments' }
  const io = createMemoryIo({
    '/app/kernel/environments/base.txt': '',
    '/app/kernel/environments/cv.txt': 'torch',
    '/home/.colloq/environments/cv.txt': 'timm',
    '/home/.colloq/environments/ml.txt': 'transformers',
    // Не список пакетов — в перечень не попадает.
    '/home/.colloq/environments/README.md': 'заметка',
  })
  assert.deepEqual(listEnvNames(io, dirs), ['base', 'cv', 'ml'])
  assert.equal(envFileIn(io, dirs, 'base'), '/app/kernel/environments/base.txt')
  assert.equal(envFileIn(io, dirs, 'cv'), '/home/.colloq/environments/cv.txt', 'своё главнее')
  assert.equal(envFileIn(io, dirs, 'ml'), '/home/.colloq/environments/ml.txt')
  // Имени нет нигде — путь всё равно называется, и он привезённый: на нём
  // строится отказ «нет такого окружения».
  assert.equal(envFileIn(io, dirs, 'нет'), '/app/kernel/environments/нет.txt')
})

test('совпавшие каталоги не удваивают имя', () => {
  const same = '/repo/kernel/environments'
  const io = createMemoryIo({ [same + '/base.txt']: '', [same + '/cv.txt']: 'torch' })
  assert.deepEqual(listEnvNames(io, { app: same, own: same }), ['base', 'cv'])
})

// ------------------------------------------------------------- состав группы

test('в группе четыре команды, и ни одна не собирает образ', async () => {
  /*
   * env build и env freeze ушли вместе с обёрткой над Makefile: образ собирает
   * colloq start, а цели env-build и env-freeze остались в мастерской. Старое
   * имя не должно тихо сделать что-нибудь другое — `env build cv` доходит до
   * `env` (алиас списка) и отказывает лишним словом, ничего не запустив.
   */
  assert.deepEqual(
    commands.map((command) => command.name),
    ['env list', 'env show', 'env new', 'env use'],
  )
  for (const argv of [
    ['env', 'build', 'cv'],
    ['env', 'freeze'],
  ]) {
    const result = await run(argv, { answer: 'y' })
    assert.equal(result.code, 2, argv.join(' '))
    assert.deepEqual(result.calls, [])
    assert.deepEqual(result.asked, [])
    assert.equal(result.io.readText('/repo/.env'), FILES['/repo/.env'])
  }
})

// ------------------------------------------------------------------ env list

test('env list: имя, голое env и env ls печатают список сами, ничего не запуская', async () => {
  for (const argv of [['env', 'list'], ['env'], ['env', 'ls']]) {
    const result = await run(argv)
    assert.equal(result.code, 0)
    assert.deepEqual(result.calls, [], 'нативная команда ничего не запускает')
    assert.deepEqual(result.out, [
      'Environments (kernel/environments/)',
      '',
      row(' ', 'base', 'Python 3.11 · 0 packages on top of the base'),
      row(' ', 'base-gpu', 'Python 3.12 · 2 packages on top of the base'),
      row('*', 'cv', 'Python 3.11 · 2 packages on top of the base'),
      // gpu наследует Python у корня цепочки base-gpu, а не берёт умолчание.
      row(' ', 'gpu', 'Python 3.12 · 2 packages on top of the base'),
      '',
      '* — the default for new classes. Change it: colloq env use <name>',
    ])
  }
})

test('env list: ширина колонки и звёздочка — те же, что печатает цель', async () => {
  const result = await run(['env', 'list'])
  assert.equal(
    result.out[4],
    '  * cv             Python 3.11 · 2 packages on top of the base',
    'два пробела, метка, имя в 14 знаков',
  )
})

test('env list --dry-run: одна строка native, ни одного вызова', async () => {
  const result = await run(['env', 'list', '--dry-run'])
  assert.equal(result.code, 0)
  assert.deepEqual(result.calls, [])
  assert.equal(result.out.length, 1)
  assert.match(result.out[0] as string, /^native: env list \(reads kernel\/environments\//)
})

test('env list --json: машинный вид, звёздочка у текущего, версия из корня цепочки', async () => {
  const result = await run(['env', 'list', '--json'])
  assert.equal(result.code, 0)
  assert.deepEqual(result.calls, [])
  assert.equal(result.out.length, 1)
  assert.deepEqual(result.err, [])
  const parsed = JSON.parse(result.out[0] as string) as {
    ok: boolean
    current: string
    dir: string
    ownDir: string
    environments: { name: string; python: string; packages: number; current: boolean }[]
  }
  assert.equal(parsed.ok, true)
  assert.equal(parsed.current, 'cv')
  assert.equal(parsed.dir, 'kernel/environments')
  assert.equal(parsed.ownDir, 'kernel/environments')
  assert.deepEqual(
    parsed.environments.map((item) => [item.name, item.python, item.packages, item.current]),
    [
      ['base', '3.11', 0, false],
      ['base-gpu', '3.12', 2, false],
      ['cv', '3.11', 2, true],
      ['gpu', '3.12', 2, false],
    ],
  )
})

test('env list --json --dry-run: ровно одна строка JSON и ничего мимо него', async () => {
  const result = await run(['env', 'list', '--json', '--dry-run'])
  assert.equal(result.code, 0)
  assert.deepEqual(result.calls, [])
  assert.equal(result.out.length, 1)
  assert.deepEqual(result.err, [])
  const parsed = JSON.parse(result.out[0] as string) as { ok: boolean; command: string }
  assert.equal(parsed.ok, true)
  assert.match(parsed.command, /^native: env list /)
})

test('env list --json по настоящим файлам считает пакеты тем же правилом, что цель env-list', async () => {
  const result = await run(['env', 'list', '--json'], { files: realFiles() })
  assert.equal(result.code, 0)
  const parsed = JSON.parse(result.out[0] as string) as {
    current: string
    environments: { name: string; python: string; packages: number; current: boolean }[]
  }
  /*
   * Ожидание считается ПО ФАЙЛАМ, а не выписано числами.
   *
   * Числа тут стояли, и они устарели ровно так, как и должны были: списки
   * окружений правят из панели прямо на машине, где идут занятия (окно
   * «Окружения» пишет kernel/environments/<имя>.txt), и первая же такая
   * правка красила тест — не найдя ошибки, а найдя чужую работу. Проверять
   * надо не «в базе ноль пакетов», а «CLI считает их тем же правилом, что и
   * цель env-list»: комментарии и ключи pip не пакеты, пустые строки тоже.
   *
   * Правило здесь своё и нарочно простое — второй счёт, независимый от
   * первого. Совпали два разных способа — значит считает верно; разъехались —
   * значит в одном из них ошибка, и это ровно то, что тест обязан ловить.
   */
  const dir = new URL('../kernel/environments/', import.meta.url)
  const expected = readdirSync(dir)
    .filter((name) => name.endsWith('.txt'))
    // По ИМЕНИ окружения, а не по имени файла: «base-gpu.txt» встаёт раньше
    // «base.txt» (дефис младше точки), а список сортирует «base» и «base-gpu».
    .sort((left, right) => (left.replace(/\.txt$/, '') < right.replace(/\.txt$/, '') ? -1 : 1))
    .map((file) => {
      const text = readFileSync(new URL(file, dir), 'utf8')
      const packages = text
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line !== '' && !line.startsWith('#') && !line.startsWith('--')).length
      return [file.replace(/\.txt$/, ''), packages]
    })
  assert.deepEqual(
    parsed.environments.map((item) => [item.name, item.packages]),
    expected,
  )
  // Питон берётся из корня цепочки «# colloq: from», и это отдельная арифметика.
  assert.deepEqual(
    parsed.environments.map((item) => item.python),
    parsed.environments.map(() => '3.11'),
  )
})

test('env list терпит петлю: список не гаснет из-за одного битого окружения', async () => {
  const result = await run(['env', 'list'], { files: RING })
  assert.equal(result.code, 0)
  const text = result.out.join('\n')
  assert.match(text, /ring {11}Python 3\.11/, 'версия неизвестна — берётся умолчание')
  assert.match(text, /cv/, 'остальные окружения на месте')
})

// ------------------------------------------------------------------ env show

test('env show без имени показывает текущее окружение сам, ничего не запуская', async () => {
  const bare = await run(['env', 'show'])
  assert.equal(bare.code, 0)
  assert.deepEqual(bare.calls, [])
  const text = bare.out.join('\n')
  assert.match(text, /^cv — kernel\/environments\/cv\.txt · Python 3\.11/)
  assert.match(text, /torch>=2\.4/)
  assert.match(text, /Base \(always there\):/)

  // Имя текущего окружения — то же самое, что без имени.
  const named = await run(['env', 'show', 'cv'])
  assert.deepEqual(named.out, bare.out)
})

test('env show чужого окружения читает файл сам: пакеты, база, ни одного вызова', async () => {
  const result = await run(['env', 'show', 'gpu'])
  assert.equal(result.code, 0)
  assert.deepEqual(result.calls, [])
  const text = result.out.join('\n')
  assert.match(text, /gpu — kernel\/environments\/gpu\.txt · Python 3\.12/)
  assert.match(text, /transformers>=4\.44/)
  assert.match(text, /Base \(always there\):/)
  assert.match(text, /numpy>=1\.26/)
  // Комментарии и директивы в список пакетов не попадают.
  assert.equal(/colloq: from/.test(text), false)
})

test('env show --dry-run на чужом окружении печатает одну строку native', async () => {
  const result = await run(['env', 'show', 'gpu', '--dry-run'])
  assert.equal(result.code, 0)
  assert.deepEqual(result.calls, [])
  assert.deepEqual(result.out, [
    'native: env show gpu (reads kernel/environments/gpu.txt and kernel/requirements.txt)',
  ])
})

test('env show: нет файла — отказ 3 со ссылкой на список, ничего не запущено', async () => {
  const result = await run(['env', 'show', 'нетакого'])
  assert.equal(result.code, 2, 'имя не из латиницы — употребление')

  const missing = await run(['env', 'show', 'ml'])
  assert.equal(missing.code, 3)
  assert.deepEqual(missing.calls, [])
  assert.match(missing.err.join('\n'), /kernel\/environments\/ml\.txt/)
  assert.match(missing.err.join('\n'), /colloq env list/)
})

test('env show пустого окружения говорит, что сверх базы ничего нет', async () => {
  const result = await run(['env', 'show', 'base'])
  assert.equal(result.code, 0)
  assert.match(result.out.join('\n'), /nothing on top of the base/)
})

test('env show на петле отказывает, а не печатает версию наугад', async () => {
  const result = await run(['env', 'show', 'ring'], { files: RING })
  assert.equal(result.code, 3)
  assert.match(result.err.join('\n'), /in a circle: ring/)
})

// ------------------------------------------------------------------- env new

test('env new --dry-run: путь и версия названы, файл не создан', async () => {
  const plain = await run(['env', 'new', 'ml', '--dry-run'])
  assert.equal(plain.code, 0)
  assert.deepEqual(plain.calls, [])
  assert.deepEqual(plain.out, [
    'native: env new ml (creates kernel/environments/ml.txt, Python 3.11)',
  ])
  assert.equal(plain.io.exists('/repo/kernel/environments/ml.txt'), false)

  const withPython = await run(['env', 'new', 'ml', '--python', '3.12', '--dry-run'])
  assert.deepEqual(withPython.out, [
    'native: env new ml (creates kernel/environments/ml.txt, Python 3.12)',
  ])
})

test('env new пишет файл со шапкой в свой каталог и ничего не запускает', async () => {
  const result = await run(['env', 'new', 'ml'])
  assert.equal(result.code, 0)
  assert.deepEqual(result.calls, [])
  const text = result.io.readText('/repo/kernel/environments/ml.txt') as string
  assert.match(text, /# Environment "ml"\./)
  assert.match(text, /kernel\/requirements\.txt/)
  assert.match(text, /#   transformers>=4\.44/)
  // Умолчание в шапку не пишется: завтра ARG PARENT поднимут, и строка
  // окажется враньём, которого никто не просил.
  assert.equal(/colloq: python/.test(text), false)
  // Ни одного пакета сверх базы — шапка целиком из комментариев.
  assert.match(result.out.join('\n'), /^created kernel\/environments\/ml\.txt/)
  assert.match(
    result.out.join('\n'),
    /Python 3\.11 · write the packages in, then: colloq env use ml/,
  )
})

test('env new --python не по умолчанию пишет директиву в шапку', async () => {
  const other = await run(['env', 'new', 'ml', '--python', '3.12'])
  assert.equal(other.code, 0)
  const text = other.io.readText('/repo/kernel/environments/ml.txt') as string
  assert.match(text, /^# colloq: python 3\.12\n#\n# Environment "ml"/)
  assert.match(other.out.join('\n'), /Python 3\.12/)

  const same = await run(['env', 'new', 'ml', '--python', '3.11'])
  const plain = same.io.readText('/repo/kernel/environments/ml.txt') as string
  assert.equal(/colloq: python/.test(plain), false, 'просили умолчание — писать нечего')
})

test('env new без имени — употребление, ничего не запущено', async () => {
  const result = await run(['env', 'new'])
  assert.equal(result.code, 2)
  assert.deepEqual(result.calls, [])
  assert.match(result.err.join('\n'), /<name>/)
})

test('версии Python приезжают с кодом, а не читаются файлом: shared/ в пакете нет', async () => {
  /*
   * Каталога shared/ нет ни в карте файлов, ни в дистрибутиве (scripts/pack.mts
   * кладёт server/dist, web/dist, server/assets и kernel/*). Раньше список
   * читался оттуда текстом по корню приложения, у установленного colloq выходил
   * пустым — и проверка вместе с ним молча выключалась: окружение заводилось с
   * «# colloq: python 3.99», а env list потом показывал это преподавателю как
   * версию окружения, которого не соберётся.
   */
  const wrong = await run(['env', 'new', 'ml', '--python', '3.99'], { dist: true })
  assert.equal(wrong.code, 2)
  assert.deepEqual(wrong.calls, [])
  assert.equal(wrong.io.exists('/repo/kernel/environments/ml.txt'), false)
  assert.ok(
    wrong.err.join('\n').includes('available: ' + PYTHON_VERSIONS.join(' ')),
    'список тот же, что у панели: ' + wrong.err.join('\n'),
  )

  const latest = PYTHON_VERSIONS[PYTHON_VERSIONS.length - 1] as string
  const good = await run(['env', 'new', 'ml', '--python', latest], { dist: true })
  assert.equal(good.code, 0)
  const text = good.io.readText('/repo/kernel/environments/ml.txt') as string
  assert.ok(text.startsWith('# colloq: python ' + latest + '\n'), text.slice(0, 40))
})

test('env new: чужая версия Python — отказ со списком, чужое имя — отказ', async () => {
  const python = await run(['env', 'new', 'ml', '--python', '3.9'])
  assert.equal(python.code, 2)
  assert.deepEqual(python.calls, [])
  assert.match(python.err.join('\n'), /3\.10 3\.11 3\.12 3\.13/)

  const name = await run(['env', 'new', 'ML Env'])
  assert.equal(name.code, 2)
  assert.deepEqual(name.calls, [])
  assert.match(name.err.join('\n'), /cannot be an environment name/)
})

test('env new: файл уже есть — отказ 3, чужой список не тронут', async () => {
  const result = await run(['env', 'new', 'cv'])
  assert.equal(result.code, 3)
  assert.match(result.err.join('\n'), /kernel\/environments\/cv\.txt already exists/)
  assert.equal(
    result.io.readText('/repo/kernel/environments/cv.txt'),
    FILES['/repo/kernel/environments/cv.txt'],
  )
})

// ------------------------------------------------------------------- env use

test('env use --dry-run: запись названа, вопроса нет, .env не тронут', async () => {
  const result = await run(['env', 'use', 'base', '--dry-run'])
  assert.equal(result.code, 0)
  assert.deepEqual(result.calls, [])
  assert.deepEqual(result.asked, [])
  assert.deepEqual(result.out, ['native: env use base (KERNEL_ENV=base in .env)'])
  assert.equal(result.io.readText('/repo/.env'), FILES['/repo/.env'])
})

test('env use --yes переливает KERNEL_ENV в .env и ничего не собирает сам', async () => {
  const result = await run(['env', 'use', 'base', '--yes'], { answer: 'y' })
  assert.equal(result.code, 0)
  assert.deepEqual(result.asked, [])
  assert.deepEqual(result.calls, [], 'образ собирает colloq start, а не эта команда')
  assert.equal(
    result.io.readText('/repo/.env'),
    ['PORT=3000', 'RELAY_DOMAIN=hse.colloq.ru', 'KERNEL_ENV=base', ''].join('\n'),
    'остальные строки на месте, KERNEL_ENV ровно один',
  )
  assert.deepEqual(result.out, [
    'Default environment for new classes: base',
    'the image is built on your next colloq start: this can take minutes',
  ])
})

test('env use спрашивает один раз и без обещания сборки; «нет» — код 4 и .env цел', async () => {
  const no = await run(['env', 'use', 'base'], { answer: 'n' })
  assert.equal(no.code, 4)
  assert.deepEqual(no.calls, [])
  assert.equal(no.asked.length, 1)
  assert.match(no.asked[0] as string, /make environment base the default for new classes\?/)
  assert.doesNotMatch(no.asked[0] as string, /build|slow/, 'сборки здесь нет — нет и обещания')
  assert.match(no.out.join('\n'), /cancelled/)
  assert.equal(no.io.readText('/repo/.env'), FILES['/repo/.env'])

  const yes = await run(['env', 'use', 'base'], { answer: 'y' })
  assert.equal(yes.code, 0)
  assert.equal(yes.asked.length, 1)
  assert.deepEqual(yes.calls, [])
  assert.match(yes.io.readText('/repo/.env') ?? '', /^KERNEL_ENV=base$/m)
})

test('env use без терминала и без --yes — отказ 3, а не «да»', async () => {
  const result = await run(['env', 'use', 'cv'])
  assert.equal(result.code, 3)
  assert.deepEqual(result.calls, [])
  assert.match(result.err.join('\n'), /--yes/)
  assert.equal(result.io.readText('/repo/.env'), FILES['/repo/.env'])
})

test('env use: нет окружения — отказ 3 без вопроса; алиас env switch — та же команда', async () => {
  const missing = await run(['env', 'use', 'ml'], { answer: 'y' })
  assert.equal(missing.code, 3)
  assert.deepEqual(missing.asked, [])
  assert.deepEqual(missing.calls, [])
  assert.match(missing.err.join('\n'), /colloq env new ml/)
  assert.equal(missing.io.readText('/repo/.env'), FILES['/repo/.env'])

  const alias = await run(['env', 'switch', 'base', '--dry-run'])
  assert.deepEqual(alias.out, ['native: env use base (KERNEL_ENV=base in .env)'])

  // Проверка идёт до вопроса и под --dry-run тоже: строка «сделал бы» про
  // окружение, которого нет, была бы враньём.
  const dry = await run(['env', 'use', 'ml', '--dry-run'])
  assert.equal(dry.code, 3)
  assert.deepEqual(dry.out, [])
})

test('env use без имени и с чужим именем — употребление, .env не тронут', async () => {
  const bare = await run(['env', 'use'], { answer: 'y' })
  assert.equal(bare.code, 2)
  assert.deepEqual(bare.asked, [])
  assert.match(bare.err.join('\n'), /<name>/)

  const wrong = await run(['env', 'use', 'ML'], { answer: 'y' })
  assert.equal(wrong.code, 2)
  assert.deepEqual(wrong.asked, [])
  assert.match(wrong.err.join('\n'), /cannot be an environment name/)
  assert.equal(wrong.io.readText('/repo/.env'), FILES['/repo/.env'])
})

test('env use на петле отказывает до вопроса', async () => {
  const result = await run(['env', 'use', 'ring'], { files: RING, answer: 'y' })
  assert.equal(result.code, 3)
  assert.deepEqual(result.asked, [])
  assert.deepEqual(result.calls, [])
  assert.match(result.err.join('\n'), /in a circle: ring/)
  assert.equal(result.io.readText('/repo/.env'), FILES['/repo/.env'])
})

// -------------------------------------------------------------------- помощь

test('помощь по команде группы: употребление, пример с настоящим окружением, делегат', async () => {
  const result = await run(['env', 'use', '--help'])
  assert.equal(result.code, 0)
  const text = result.out.join('\n')
  assert.match(text, /Usage: colloq env use <name>/)
  assert.match(text, /colloq env use cv --yes/)
  assert.match(text, /delegates: native: KERNEL_ENV in \.env$/m)
  // Цели мастерской в помощи преподавателю не место: звать их нечем.
  assert.doesNotMatch(text, /env-build|NAME=/)
})

// ------------------------------------------- установленный colloq и репозиторий

/**
 * Установленный colloq и репозиторий ведут себя одинаково.
 *
 * Развилка по ctx.dist в группе осталась одна — умолчания нового .env
 * (launch-config.ts · localClassEnv), и она повторяет выбор самого запуска.
 * Всё прочее — вопрос, запись, вывод — от признака не зависит, и это
 * проверяется прямо: две дороги, один результат.
 */
test('env use одинаков у установленного colloq и в репозитории', async () => {
  const dist = await run(['env', 'use', 'gpu', '--yes'], { dist: true })
  const repo = await run(['env', 'use', 'gpu', '--yes'], { dist: false })
  for (const result of [dist, repo]) {
    assert.equal(result.code, 0)
    assert.deepEqual(result.calls, [])
    assert.match(result.io.readText('/repo/.env') ?? '', /^KERNEL_ENV=gpu$/m)
  }
  assert.deepEqual(dist.out, repo.out)
  assert.equal(dist.io.readText('/repo/.env'), repo.io.readText('/repo/.env'))
})

test('env use на пустом месте заводит .env целиком, а не одну строку', async () => {
  const result = await run(['env', 'use', 'gpu', '--yes'], {
    without: ['/repo/.env'],
    dist: true,
  })
  assert.equal(result.code, 0)
  const written = result.io.readText('/repo/.env') ?? ''
  assert.match(written, /^KERNEL_ENV=gpu$/m)
  assert.equal(
    written.match(/^KERNEL_ENV=/gm)?.length,
    1,
    'строка из умолчаний заменена, а не удвоена',
  )
  // Ровно то, чего не хватало: свой токен ядра, а не общеизвестный из примера.
  assert.match(written, /^JUPYTER_TOKEN=[0-9a-f]{48}$/m)
  assert.match(written, /^KERNEL_BACKEND=docker$/m)
  assert.doesNotMatch(written, /colloq-dev-token/)
  // У пакета pip комната и панель открываются по-английски; в репозитории ru.
  assert.match(written, /^UI_LANGUAGE=en$/m)

  const repo = await run(['env', 'use', 'gpu', '--yes'], { without: ['/repo/.env'] })
  assert.match(repo.io.readText('/repo/.env') ?? '', /^UI_LANGUAGE=ru$/m)
})

test('env use в существующем .env трогает одну строку и оставляет остальные', async () => {
  const result = await run(['env', 'use', 'gpu', '--yes'])
  const written = result.io.readText('/repo/.env') ?? ''
  assert.match(written, /^KERNEL_ENV=gpu$/m)
  assert.match(written, /^PORT=3000$/m, 'чужие строки на месте')
  assert.match(written, /^RELAY_DOMAIN=hse\.colloq\.ru$/m)
  assert.doesNotMatch(written, /JUPYTER_TOKEN/, 'готовый файл не переписывается заново')
})

// ------------------------------------------ два каталога: свой и привезённый

/**
 * Каталог состояния отдельно от каталога приложения.
 *
 * Так живёт установленный colloq, и так же — рабочее дерево, запущенное с
 * COLLOQ_HOME. Тогда .env лежит в <home>, свои окружения — в
 * <home>/environments, а привезённые — в <app>/kernel/environments, и каждая
 * команда группы обязана смотреть в оба каталога и писать только в свой.
 */
const HOME = '/home/teacher/.colloq'

const SPLIT: Record<string, string> = {
  [HOME + '/.env']: 'KERNEL_ENV=base\n',
  [HOME + '/environments/mine.txt']: ['# colloq: from base', 'statsmodels'].join('\n'),
}

test('env list при двух каталогах называет оба и помечает своё', async () => {
  const result = await run(['env', 'list'], { home: HOME, files: SPLIT })
  assert.equal(result.code, 0)
  assert.deepEqual(result.calls, [])
  assert.equal(result.out[0], 'Environments (kernel/environments/ and ' + HOME + '/environments/)')
  const text = result.out.join('\n')
  assert.match(text, /\* base /, 'звёздочка — по .env каталога состояния')
  assert.match(text, /mine .*1 package on top of the base · your own$/m)
  assert.doesNotMatch(text, /cv .*your own/, 'привезённое своим не называется')

  const json = await run(['env', 'list', '--json'], { home: HOME, files: SPLIT })
  const parsed = JSON.parse(json.out[0] as string) as {
    ownDir: string
    environments: { name: string; own: boolean; file: string }[]
  }
  assert.equal(parsed.ownDir, HOME + '/environments')
  const mine = parsed.environments.find((item) => item.name === 'mine')
  assert.deepEqual([mine?.own, mine?.file], [true, HOME + '/environments/mine.txt'])
})

test('env new при двух каталогах пишет только в свой, и перекрытие называет вслух', async () => {
  const fresh = await run(['env', 'new', 'ml'], { home: HOME, files: SPLIT })
  assert.equal(fresh.code, 0)
  assert.ok(fresh.io.exists(HOME + '/environments/ml.txt'))
  assert.equal(fresh.io.exists('/repo/kernel/environments/ml.txt'), false, 'в пакет не пишем')
  assert.doesNotMatch(fresh.out.join('\n'), /overrides/)

  // cv приехал с продуктом: своё с тем же именем законно, но не молча.
  const shadow = await run(['env', 'new', 'cv'], { home: HOME, files: SPLIT })
  assert.equal(shadow.code, 0)
  assert.ok(shadow.io.exists(HOME + '/environments/cv.txt'))
  assert.equal(
    shadow.io.readText('/repo/kernel/environments/cv.txt'),
    FILES['/repo/kernel/environments/cv.txt'],
    'привезённый список не тронут',
  )
  assert.match(shadow.out.join('\n'), /overrides the bundled environment with the same name/)
})

test('env show своего окружения читает его файл, а не привезённый', async () => {
  const result = await run(['env', 'show', 'mine'], { home: HOME, files: SPLIT })
  assert.equal(result.code, 0)
  const text = result.out.join('\n')
  assert.match(text, new RegExp('^mine — ' + HOME + '/environments/mine\\.txt · Python 3\\.11'))
  assert.match(text, /statsmodels/)
})

test('env use на своём окружении пишет KERNEL_ENV в .env каталога состояния', async () => {
  const result = await run(['env', 'use', 'mine', '--yes'], { home: HOME, files: SPLIT })
  assert.equal(result.code, 0)
  assert.deepEqual(result.calls, [])
  assert.match(result.io.readText(HOME + '/.env') ?? '', /^KERNEL_ENV=mine$/m)
  assert.equal(result.io.readText('/repo/.env'), FILES['/repo/.env'], '.env приложения не наш')
  assert.match(result.out.join('\n'), /the image is built on your next colloq start/)
})

test('env use на привезённом окружении при двух каталогах — то же самое', async () => {
  const result = await run(['env', 'use', 'cv', '--yes'], { home: HOME, files: SPLIT })
  assert.equal(result.code, 0)
  assert.deepEqual(result.calls, [])
  assert.match(result.io.readText(HOME + '/.env') ?? '', /^KERNEL_ENV=cv$/m)
})

test('env use: цепочка идёт через оба каталога, пропавший родитель — отказ', async () => {
  const kid = await run(['env', 'use', 'kid', '--yes'], {
    home: HOME,
    files: {
      ...SPLIT,
      [HOME + '/environments/kid.txt']: ['# colloq: from mine', 'seaborn'].join('\n'),
    },
  })
  assert.equal(kid.code, 0, 'родитель mine из своего каталога, его родитель base — из пакета')
  assert.deepEqual(kid.calls, [])
  assert.match(kid.io.readText(HOME + '/.env') ?? '', /^KERNEL_ENV=kid$/m)

  const orphan = await run(['env', 'use', 'orphan', '--yes'], {
    home: HOME,
    files: {
      ...SPLIT,
      [HOME + '/environments/orphan.txt']: ['# colloq: from gone', 'seaborn'].join('\n'),
    },
  })
  assert.equal(orphan.code, 3)
  assert.match(orphan.err.join('\n'), /"gone" is named as a parent, and it does not exist/)
  assert.equal(orphan.io.readText(HOME + '/.env'), SPLIT[HOME + '/.env'])
})
