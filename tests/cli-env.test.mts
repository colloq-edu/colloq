/**
 * Группа env: окружения ядра.
 *
 * Ни один процесс здесь не запускается и ни один настоящий файл не читается
 * командами: исполнитель подставной и пишет вызовы в массив, io — карта файлов
 * в памяти. Настоящие kernel/environments/*.txt читает только сам тест — и
 * кладёт их в ту же карту, чтобы сверить машинный вид со списком, который даёт
 * make env-list.
 */
import './_cli.mjs'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { cli } from '../cli/src/main.js'
import { createMemoryIo } from '../cli/src/env.js'

const ROOT = '/repo'

const FILES: Record<string, string> = {
  '/repo/package.json': '{ "name": "colloq", "version": "0.1.0" }',
  '/repo/cli/package.json': '{ "name": "@colloq/cli", "version": "0.1.0" }',
  '/repo/Makefile': ['env-list: ## Окружения', 'env-show: ## Окружение'].join('\n'),
  '/repo/.env': ['PORT=3000', 'KERNEL_ENV=cv', 'RELAY_DOMAIN=hse.colloq.ru'].join('\n'),
  '/repo/kernel/Dockerfile': ['FROM scratch', 'ARG PARENT=python:3.11-slim-bookworm'].join('\n'),
  '/repo/shared/admin.ts':
    "export const PYTHON_VERSIONS = ['3.10', '3.11', '3.12', '3.13'] as const\n",
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

type Harness = {
  code: number
  out: string[]
  err: string[]
  calls: string[][]
  asked: string[]
}

async function run(
  argv: string[],
  opts: {
    files?: Record<string, string>
    answer?: string
    tty?: boolean
    exit?: number
  } = {},
): Promise<Harness> {
  const out: string[] = []
  const err: string[] = []
  const calls: string[][] = []
  const asked: string[] = []
  const io = createMemoryIo({ ...FILES, ...(opts.files ?? {}) }, 1_700_000_000_000)
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
      async run(cmd, args) {
        calls.push([cmd, ...args])
        return opts.exit ?? 0
      },
      async capture() {
        // Счёт комнат каркасом — чтение, а не запуск: в calls ему не место.
        return { code: 1, stdout: '', stderr: '' }
      },
    },
  })
  return { code, out, err, calls, asked }
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
    '/repo/shared/admin.ts': readFileSync(new URL('../shared/admin.ts', import.meta.url), 'utf8'),
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

// ------------------------------------------------------------------ env list

test('env list: имя, голое env и env ls ведут в make env-list', async () => {
  for (const argv of [['env', 'list'], ['env'], ['env', 'ls']]) {
    const result = await run(argv)
    assert.equal(result.code, 0)
    assert.deepEqual(result.calls, [['make', 'env-list']])
  }
})

test('env list --dry-run: одна строка, ни одного вызова', async () => {
  const result = await run(['env', 'list', '--dry-run'])
  assert.equal(result.code, 0)
  assert.deepEqual(result.calls, [])
  assert.deepEqual(result.out, ['make env-list'])
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
    environments: { name: string; python: string; packages: number; current: boolean }[]
  }
  assert.equal(parsed.ok, true)
  assert.equal(parsed.current, 'cv')
  assert.equal(parsed.dir, 'kernel/environments')
  assert.deepEqual(
    parsed.environments.map((item) => [item.name, item.python, item.packages, item.current]),
    [
      ['base', '3.11', 0, false],
      ['base-gpu', '3.12', 2, false],
      ['cv', '3.11', 2, true],
      // gpu наследует Python у корня цепочки base-gpu, а не берёт умолчание.
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

test('env list --json по настоящим файлам совпадает с тем, что показывает make env-list', async () => {
  const result = await run(['env', 'list', '--json'], { files: realFiles() })
  assert.equal(result.code, 0)
  const parsed = JSON.parse(result.out[0] as string) as {
    current: string
    environments: { name: string; python: string; packages: number; current: boolean }[]
  }
  // Сверено с выводом make env-list на этих же файлах:
  //     base-gpu  Python 3.11 · 2 пакетов сверх базы
  //   * base      Python 3.11 · 0 пакетов сверх базы
  //     cv        Python 3.11 · 5 пакетов сверх базы
  //     gpu       Python 3.11 · 2 пакетов сверх базы
  assert.equal(parsed.current, 'base')
  assert.deepEqual(
    parsed.environments.map((item) => [item.name, item.python, item.packages, item.current]),
    [
      ['base', '3.11', 0, true],
      ['base-gpu', '3.11', 2, false],
      ['cv', '3.11', 5, false],
      ['gpu', '3.11', 2, false],
    ],
  )
})

// ------------------------------------------------------------------ env show

test('env show без имени и на текущем окружении зовёт make env-show', async () => {
  const bare = await run(['env', 'show'])
  assert.equal(bare.code, 0)
  assert.deepEqual(bare.calls, [['make', 'env-show']])

  const current = await run(['env', 'show', 'cv'])
  assert.deepEqual(current.calls, [['make', 'env-show']])
})

test('env show чужого окружения читает файл сам: пакеты, база, ни одного вызова', async () => {
  const result = await run(['env', 'show', 'gpu'])
  assert.equal(result.code, 0)
  assert.deepEqual(result.calls, [])
  const text = result.out.join('\n')
  assert.match(text, /gpu — kernel\/environments\/gpu\.txt · Python 3\.12/)
  assert.match(text, /transformers>=4\.44/)
  assert.match(text, /База \(есть всегда\):/)
  assert.match(text, /numpy>=1\.26/)
  // Комментарии и директивы в список пакетов не попадают.
  assert.equal(/colloq: from/.test(text), false)
})

test('env show --dry-run на чужом окружении печатает одну строку native', async () => {
  const result = await run(['env', 'show', 'gpu', '--dry-run'])
  assert.equal(result.code, 0)
  assert.deepEqual(result.calls, [])
  assert.deepEqual(result.out, [
    'native: env show gpu (читает kernel/environments/gpu.txt и kernel/requirements.txt)',
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
  assert.match(result.out.join('\n'), /ничего сверх базы/)
})

// ------------------------------------------------------------------- env new

test('env new --dry-run: имя и версия доезжают до make env-new', async () => {
  const plain = await run(['env', 'new', 'ml', '--dry-run'])
  assert.equal(plain.code, 0)
  assert.deepEqual(plain.calls, [])
  assert.deepEqual(plain.out, ['make env-new NAME=ml'])

  const withPython = await run(['env', 'new', 'ml', '--python', '3.12', '--dry-run'])
  assert.deepEqual(withPython.out, ['make env-new NAME=ml PYTHON=3.12'])
})

test('env new принимает и форму make: NAME= и PYTHON= не удваиваются', async () => {
  const result = await run(['env', 'new', 'NAME=ml', 'PYTHON=3.12', '--dry-run'])
  assert.equal(result.code, 0)
  assert.deepEqual(result.out, ['make env-new NAME=ml PYTHON=3.12'])
})

test('env new без имени — употребление, ничего не запущено', async () => {
  const result = await run(['env', 'new'])
  assert.equal(result.code, 2)
  assert.deepEqual(result.calls, [])
  assert.match(result.err.join('\n'), /обязательного аргумента <имя>/)
})

test('env new: чужая версия Python — отказ со списком, чужое имя — отказ', async () => {
  const python = await run(['env', 'new', 'ml', '--python', '3.9'])
  assert.equal(python.code, 2)
  assert.deepEqual(python.calls, [])
  assert.match(python.err.join('\n'), /3\.10 3\.11 3\.12 3\.13/)

  const name = await run(['env', 'new', 'ML Env'])
  assert.equal(name.code, 2)
  assert.deepEqual(name.calls, [])
  assert.match(name.err.join('\n'), /не может быть именем окружения/)

  const twice = await run(['env', 'new', 'ml', 'NAME=cv'])
  assert.equal(twice.code, 2)
  assert.deepEqual(twice.calls, [])
  assert.match(twice.err.join('\n'), /названо дважды/)
})

test('env new выполняется целью и отдаёт её код как есть', async () => {
  const result = await run(['env', 'new', 'ml'], { exit: 1 })
  assert.equal(result.code, 1)
  assert.deepEqual(result.calls, [['make', 'env-new', 'NAME=ml']])
})

// ----------------------------------------------------------------- env build

test('env build --dry-run печатает цель с именем', async () => {
  const result = await run(['env', 'build', 'cv', '--dry-run'])
  assert.equal(result.code, 0)
  assert.deepEqual(result.calls, [])
  assert.deepEqual(result.out, ['make env-build NAME=cv'])
})

test('env build: шапка одной строкой, дальше поток цели', async () => {
  const result = await run(['env', 'build', 'cv'])
  assert.equal(result.code, 0)
  assert.deepEqual(result.calls, [['make', 'env-build', 'NAME=cv']])
  assert.equal(result.out.length, 1)
  assert.match(result.out[0] as string, /^собираю образ окружения cv/)
})

test('env build: нет файла окружения — отказ 3 до сборки', async () => {
  const result = await run(['env', 'build', 'ml'])
  assert.equal(result.code, 3)
  assert.deepEqual(result.calls, [])
  assert.match(result.err.join('\n'), /colloq env new ml/)
})

test('env build без имени — употребление; пары ВИДА=ЗНАЧЕНИЕ доезжают', async () => {
  const bare = await run(['env', 'build'])
  assert.equal(bare.code, 2)
  assert.deepEqual(bare.calls, [])

  const vars = await run(['env', 'build', 'cv', 'FORCE=1', '--dry-run'])
  assert.deepEqual(vars.out, ['make env-build NAME=cv FORCE=1'])
})

// ------------------------------------------------------------------- env use

test('env use --dry-run: цель с именем, вопроса нет', async () => {
  const result = await run(['env', 'use', 'cv', '--dry-run'])
  assert.equal(result.code, 0)
  assert.deepEqual(result.calls, [])
  assert.deepEqual(result.asked, [])
  assert.deepEqual(result.out, ['make env-use NAME=cv'])
})

test('env use --yes не спрашивает и зовёт цель', async () => {
  const result = await run(['env', 'use', 'cv', '--yes'], { answer: 'y' })
  assert.equal(result.code, 0)
  assert.deepEqual(result.asked, [])
  assert.deepEqual(result.calls, [['make', 'env-use', 'NAME=cv']])
})

test('env use спрашивает один раз, «нет» — код 4 и ни одного вызова', async () => {
  const no = await run(['env', 'use', 'cv'], { answer: 'n' })
  assert.equal(no.code, 4)
  assert.deepEqual(no.calls, [])
  assert.equal(no.asked.length, 1)
  assert.match(no.asked[0] as string, /собрать окружение cv и сделать умолчанием\?/)
  assert.match(no.out.join('\n'), /отменено/)

  const yes = await run(['env', 'use', 'cv'], { answer: 'y' })
  assert.equal(yes.code, 0)
  assert.equal(yes.asked.length, 1)
  assert.deepEqual(yes.calls, [['make', 'env-use', 'NAME=cv']])
})

test('env use без терминала и без --yes — отказ 3, а не «да»', async () => {
  const result = await run(['env', 'use', 'cv'])
  assert.equal(result.code, 3)
  assert.deepEqual(result.calls, [])
  assert.match(result.err.join('\n'), /--yes/)
})

test('env use: нет окружения — отказ 3 без вопроса; алиас env switch и форма NAME=', async () => {
  const missing = await run(['env', 'use', 'ml'], { answer: 'y' })
  assert.equal(missing.code, 3)
  assert.deepEqual(missing.asked, [])
  assert.deepEqual(missing.calls, [])

  const alias = await run(['env', 'switch', 'cv', '--dry-run'])
  assert.deepEqual(alias.out, ['make env-use NAME=cv'])

  const asVar = await run(['env', 'use', 'NAME=cv', '--dry-run'])
  assert.deepEqual(asVar.out, ['make env-use NAME=cv'])
})

// ---------------------------------------------------------------- env freeze

test('env freeze зовёт цель и отдаёт её код; --dry-run печатает одну строку', async () => {
  const dry = await run(['env', 'freeze', '--dry-run'])
  assert.equal(dry.code, 0)
  assert.deepEqual(dry.calls, [])
  assert.deepEqual(dry.out, ['make env-freeze'])

  const real = await run(['env', 'freeze'], { exit: 2 })
  assert.equal(real.code, 2)
  assert.deepEqual(real.calls, [['make', 'env-freeze']])
})

// -------------------------------------------------------------------- помощь

test('помощь по команде группы: употребление, пример с настоящим окружением, делегат', async () => {
  const result = await run(['env', 'use', '--help'])
  assert.equal(result.code, 0)
  const text = result.out.join('\n')
  assert.match(text, /Употребление: colloq env use <имя>/)
  assert.match(text, /colloq env use cv --yes/)
  assert.match(text, /делегирует: make env-use NAME=…/)
})
