/**
 * Окружения ядра — какой Python и какие пакеты видит семинар.
 *
 * Цели группы: env list, env show, env new, env build, env use, env freeze
 * (make env-list, env-show, env-new, env-build, env-use, env-freeze).
 *
 * Работу делают цели Makefile: сборка цепочки наследования, проверка петель,
 * перелив KERNEL_ENV в .env — всё там. Здесь только имя окружения в двух
 * формах (позиционным и парой NAME=…), проверка имени до делегирования и два
 * чтения файлов, которых цель не умеет: чужое окружение для `env show` и
 * машинный вид для `env list --json`.
 *
 * node:child_process и node:fs импортировать нельзя: только ctx.sh и ctx.io.
 */
import type { Command, Ctx } from '../registry.js'
import { PreconditionError, UsageError } from '../ui.js'

/** Потолок цепочки `# colloq: from` — тот же, что у сборки в Makefile. */
const CHAIN_LIMIT = 8

/** Две директивы шапки. Для pip это комментарии, для нас — устройство. */
const FROM = /^[ \t]*#[ \t]*colloq:[ \t]*from[ \t]+([^\s]+)[ \t]*$/m
const PYTHON = /^[ \t]*#[ \t]*colloq:[ \t]*python[ \t]+(3\.[0-9]+)[ \t]*$/m

/** Имя окружения: им зовётся и файл, и тег образа colloq-kernel:<имя>. */
const NAME = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/

/** Строка, которую в списке пакетов не видно: комментарий, пусто, ключ pip. */
const NOT_A_PACKAGE = /^[ \t]*(#|-|$)/

/** Комментарий и пустая строка — то, что прячет env-show. */
const NOT_A_LINE = /^[ \t]*(#|$)/

function envFile(ctx: Ctx, name: string): string {
  return ctx.env.paths.envDir + '/' + name + '.txt'
}

/** Путь от корня репозитория: так его печатает Makefile. */
function short(ctx: Ctx, path: string): string {
  const root = ctx.env.root() + '/'
  return path.startsWith(root) ? path.slice(root.length) : path
}

function textOf(ctx: Ctx, path: string): string | null {
  const text = ctx.io.readText(path)
  return text === null ? null : text.replace(/\r/g, '')
}

/** Имя окружения: позиционным или парой NAME=… — работают обе формы. */
function wantName(ctx: Ctx, usage: string): string {
  const positional = (ctx.positionals[0] ?? '').trim()
  const variable = (ctx.makeVars.NAME ?? '').trim()
  if (positional && variable && positional !== variable) {
    throw new UsageError(
      'окружение названо дважды: ' + positional + ' и NAME=' + variable,
      'оставьте что-то одно: ' + usage,
    )
  }
  const name = positional || variable
  if (!name) throw new UsageError('не названо окружение', 'Употребление: ' + usage)
  checkName(name)
  return name
}

function checkName(name: string): void {
  if (NAME.test(name)) return
  throw new UsageError(
    '«' + name + '» не может быть именем окружения: строчные латинские буквы, цифры и дефис',
    'colloq env list — какие уже есть',
  )
}

/** NAME= уходит make только тогда, когда человек не передал пару сам. */
function nameVar(ctx: Ctx, name: string): string | undefined {
  return ctx.makeVars.NAME === undefined ? name : undefined
}

/** Нет файла окружения — отказ здесь, до сборки и до вопросов. */
function needFile(ctx: Ctx, name: string, fix: string): void {
  if (ctx.io.exists(envFile(ctx, name))) return
  throw new PreconditionError(
    'нет ' + short(ctx, envFile(ctx, name)) + ': окружение «' + name + '» не заведено',
    fix,
  )
}

/** Версии, на которых вообще собирается ядро: оттуда же, откуда их берёт панель. */
function pythonVersions(ctx: Ctx): string[] {
  const text = textOf(ctx, ctx.env.path('shared/admin.ts')) ?? ''
  const match = /^export const PYTHON_VERSIONS = \[(.*)\]/m.exec(text)
  return (match?.[1] ?? '')
    .split(',')
    .map((piece) => piece.replace(/['\s]/g, ''))
    .filter(Boolean)
}

/** Версия Python из --python или из пары PYTHON=…; пусто — значит умолчание. */
function wantPython(ctx: Ctx): string | undefined {
  const flag = ((ctx.values.python as string | undefined) ?? '').trim()
  const variable = (ctx.makeVars.PYTHON ?? '').trim()
  if (flag && variable && flag !== variable) {
    throw new UsageError(
      'версия Python названа дважды: ' + flag + ' и PYTHON=' + variable,
      'оставьте что-то одно',
    )
  }
  const value = flag || variable
  if (!value) return undefined
  const known = pythonVersions(ctx)
  if (known.length > 0 && !known.includes(value)) {
    throw new UsageError(
      'Python ' + value + ' не из тех, на которых собирается ядро',
      'есть: ' + known.join(' '),
    )
  }
  return value
}

function pythonVar(ctx: Ctx, value: string | undefined): string | undefined {
  return ctx.makeVars.PYTHON === undefined ? value : undefined
}

/** Умолчание — из самого kernel/Dockerfile, а не вторым списком. */
function defaultPython(ctx: Ctx): string {
  const text = textOf(ctx, ctx.env.path('kernel/Dockerfile')) ?? ''
  return /^ARG PARENT=python:([0-9]+\.[0-9]+)-/m.exec(text)?.[1] ?? '3.11'
}

/**
 * На каком Python поедет окружение. Версию задаёт КОРЕНЬ цепочки
 * `# colloq: from`: она приходит из базового образа, а слой поверх готового
 * образа интерпретатор не меняет. Восемь шагов — тот же потолок, что у сборки.
 */
function pythonOf(ctx: Ctx, name: string, fallback: string): string {
  let current = name
  for (let step = 0; step < CHAIN_LIMIT; step++) {
    const text = textOf(ctx, envFile(ctx, current))
    const up = text === null ? undefined : FROM.exec(text)?.[1]
    if (!up || !ctx.io.exists(envFile(ctx, up))) break
    current = up
  }
  const text = textOf(ctx, envFile(ctx, current))
  return (text === null ? undefined : PYTHON.exec(text)?.[1]) ?? fallback
}

/** Сколько пакетов сверх базы — так же, как считает env-list. */
function packagesOf(text: string): number {
  return text.split('\n').filter((line) => !NOT_A_PACKAGE.test(line)).length
}

function listNames(ctx: Ctx): string[] {
  return ctx.io
    .list(ctx.env.paths.envDir)
    .filter((file) => file.endsWith('.txt'))
    .map((file) => file.slice(0, -'.txt'.length))
    .sort()
}

export const commands: Command[] = [
  {
    name: 'env list',
    aliases: ['env', 'env ls'],
    group: 'env',
    summary: 'Какие окружения заведены',
    usage: 'colloq env list [--json]',
    flags: [{ name: 'json', summary: 'Машинный вид: имя, Python, пакеты сверх базы' }],
    destructive: false,
    delegates: 'make env-list (с --json — чтение kernel/environments/*.txt)',
    examples: ['colloq env list', 'colloq env list --json'],
    notes:
      'Звёздочка — умолчание для новых семинаров: KERNEL_ENV из .env, иначе base. Версия Python берётся из корня цепочки «# colloq: from», не длиннее восьми звеньев.',
    async run(ctx) {
      if (!ctx.json) return await ctx.sh.make('env-list')
      if (ctx.dryRun) {
        ctx.ui.json({
          ok: true,
          dryRun: true,
          command: 'native: env list (читает kernel/environments/*.txt и KERNEL_ENV из .env)',
        })
        return 0
      }
      const current = ctx.env.kernelEnv()
      const fallback = defaultPython(ctx)
      ctx.ui.json({
        ok: true,
        current,
        dir: short(ctx, ctx.env.paths.envDir),
        environments: listNames(ctx).map((name) => ({
          name,
          python: pythonOf(ctx, name, fallback),
          packages: packagesOf(textOf(ctx, envFile(ctx, name)) ?? ''),
          current: name === current,
          file: short(ctx, envFile(ctx, name)),
        })),
      })
      return 0
    },
  },

  {
    name: 'env show',
    group: 'env',
    summary: 'Что в окружении и на каком оно Python',
    usage: 'colloq env show [имя]',
    args: [{ name: 'имя', summary: 'Окружение; без имени — текущее', makeVar: 'NAME' }],
    flags: [],
    destructive: false,
    delegates: 'make env-show (чужое имя — чтение kernel/environments/<имя>.txt)',
    examples: ['colloq env show', 'colloq env show {env}'],
    notes:
      'make env-show знает только текущее окружение, NAME он не принимает, поэтому чужой файл CLI читает сам. Нет файла — отказ.',
    async run(ctx) {
      const asked = (ctx.positionals[0] ?? ctx.makeVars.NAME ?? '').trim()
      const current = ctx.env.kernelEnv()
      if (asked === '' || asked === current) return await ctx.sh.make('env-show')

      checkName(asked)
      needFile(ctx, asked, 'colloq env list')
      const file = envFile(ctx, asked)
      if (ctx.dryRun) {
        return ctx.sh.dry(
          'native: env show ' +
            asked +
            ' (читает ' +
            short(ctx, file) +
            ' и kernel/requirements.txt)',
        )
      }

      const python = pythonOf(ctx, asked, defaultPython(ctx))
      ctx.ui.line(
        ctx.ui.bold(asked) + ' ' + ctx.ui.dim('— ' + short(ctx, file) + ' · Python ' + python),
      )
      ctx.ui.line()
      const own = (textOf(ctx, file) ?? '').split('\n').filter((line) => !NOT_A_LINE.test(line))
      if (own.length > 0) ctx.ui.table(own.map((line) => [line]))
      else ctx.ui.line('  ' + ctx.ui.dim('ничего сверх базы'))
      ctx.ui.line()
      ctx.ui.line(ctx.ui.dim('База (есть всегда):'))
      const base = (textOf(ctx, ctx.env.path('kernel/requirements.txt')) ?? '')
        .split('\n')
        .filter((line) => !NOT_A_LINE.test(line))
      ctx.ui.table(base.map((line) => [line]))
      return 0
    },
  },

  {
    name: 'env new',
    group: 'env',
    summary: 'Завести окружение',
    usage: 'colloq env new <имя> [--python <версия>]',
    args: [
      {
        name: 'имя',
        summary: 'Как назвать: строчные латинские буквы, цифры, дефис',
        required: true,
        makeVar: 'NAME',
      },
    ],
    flags: [
      { name: 'python', arg: 'версия', summary: 'На каком Python собирать; иначе — умолчание' },
    ],
    destructive: false,
    delegates: 'make env-new NAME=… [PYTHON=…]',
    examples: ['colloq env new cv', 'colloq env new cv --python 3.12'],
    notes:
      'Создаёт пустой файл со шапкой и не перезаписывает существующий — это проверяет цель. Версия берётся из PYTHON_VERSIONS в shared/admin.ts, а строка «# colloq: python X.Y» пишется, только если версия отличается от ARG PARENT в kernel/Dockerfile.',
    async run(ctx) {
      const name = wantName(ctx, 'colloq env new <имя>')
      const python = wantPython(ctx)
      return await ctx.sh.make('env-new', {
        NAME: nameVar(ctx, name),
        PYTHON: pythonVar(ctx, python),
      })
    },
  },

  {
    name: 'env build',
    group: 'env',
    summary: 'Собрать образ окружения, не переключаясь на него',
    usage: 'colloq env build <имя>',
    args: [
      { name: 'имя', summary: 'Окружение из colloq env list', required: true, makeVar: 'NAME' },
    ],
    flags: [],
    destructive: false,
    delegates: 'make env-build NAME=…',
    examples: ['colloq env build cv', 'colloq env build {env} --dry-run'],
    notes:
      'Минуты работы и поток docker build как есть. Родители из «# colloq: from» собираются, только если их образа ещё нет, а названное окружение пересобирается всегда. Петля и цепочка длиннее восьми звеньев отвергаются целью до сборки, а не после девяти минут.',
    async run(ctx) {
      const name = wantName(ctx, 'colloq env build <имя>')
      needFile(ctx, name, 'colloq env new ' + name)
      if (!ctx.dryRun) ctx.ui.header('собираю образ окружения ' + name + ': первый раз долго')
      return await ctx.sh.make('env-build', { NAME: nameVar(ctx, name) })
    },
  },

  {
    name: 'env use',
    aliases: ['env switch'],
    group: 'env',
    summary: 'Сделать окружение умолчанием для новых семинаров',
    usage: 'colloq env use <имя>',
    args: [
      { name: 'имя', summary: 'Окружение из colloq env list', required: true, makeVar: 'NAME' },
    ],
    flags: [],
    destructive: true,
    confirm: 'cli',
    // Проверка до вопроса: окружения нет — отказ, а не вопрос перед отказом.
    check(ctx) {
      const name = wantName(ctx, 'colloq env use <имя>')
      needFile(ctx, name, 'colloq env new ' + name)
    },
    confirmQuestion: (ctx) =>
      'собрать окружение ' +
      wantName(ctx, 'colloq env use <имя>') +
      ' и сделать умолчанием? первый раз может быть долго',
    delegates: 'make env-use NAME=…',
    examples: ['colloq env use cv', 'colloq env use {env} --yes'],
    notes:
      'Сначала сборка (той же целью env-build), потом строка KERNEL_ENV= переливается в существующий .env, а не кладётся поверх: под sudo файл остался бы root:0600, и следующий make run поднял бы инстанс с умолчаниями. Уже открытые семинары остаются на своём окружении.',
    async run(ctx) {
      const name = wantName(ctx, 'colloq env use <имя>')
      needFile(ctx, name, 'colloq env new ' + name)
      if (!ctx.dryRun) {
        ctx.ui.header('переключаю на ' + name + ': сборка образа, потом KERNEL_ENV в .env')
      }
      return await ctx.sh.make('env-use', { NAME: nameVar(ctx, name) })
    },
  },

  {
    name: 'env freeze',
    group: 'env',
    summary: 'Показать реальные версии пакетов из ядра',
    usage: 'colloq env freeze',
    flags: [],
    destructive: false,
    delegates: 'make env-freeze',
    examples: ['colloq env freeze', 'colloq env freeze --dry-run'],
    notes:
      'Спрашивает работающую службу kernel, а если её нет (машина под службой) — одноразовый контейнер colloq-kernel:<окружение>: это ответ про окружение, а не про то, что доставили руками в живую комнату.',
    async run(ctx) {
      return await ctx.sh.make('env-freeze')
    },
  },
]
