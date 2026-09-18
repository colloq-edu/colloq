/**
 * Окружения ядра — какой Python и какие пакеты видит занятие.
 *
 * Четыре команды: env list, env show, env new, env use. Все четыре работают
 * с одними файлами — читают и пишут через ctx.io — и не запускают ни одного
 * процесса. Цели env-* в Makefile делают то же самое, но звать их отсюда
 * нечем: CLI едет в колесе pip вместе с приложением, а Makefile в колесо не
 * едет. Совпадать с ними команды обязаны устройством файлов и экраном, а не
 * вызовом.
 *
 * Образа окружения здесь не собирает никто, и это решение, а не пробел.
 * Собирает colloq start, перед занятием (launch-prepare.ts · prepare): там
 * цепочка `# colloq: from`, отпечаток исходников, склейка двух каталогов в
 * один контекст docker и прогресс в .colloq.log. Вторая сборка отсюда
 * оказалась бы третьей копией рядом с запуском и панелью
 * (server/src/environments.ts · buildCommand), а три копии разъезжаются на
 * первой же правке Dockerfile. Поэтому `env use` только переписывает
 * KERNEL_ENV, а о цене — минутах сборки — честно предупреждает словами.
 *
 * ГДЕ ЛЕЖАТ ОКРУЖЕНИЯ — главное решение группы, и оно такое.
 *
 *   · Привезённые с продуктом (base, base-gpu, cv, gpu) — в <app>/kernel/
 *     environments и только читаются: у установленного colloq это
 *     site-packages, и писать туда нельзя ни в каком смысле (см. env.ts ·
 *     ownEnvDir).
 *   · Свои — в <home>/environments, рядом с .env и data/. В репозитории это
 *     тот же самый kernel/environments, и там ничего не меняется.
 *   · Список — объединение двух каталогов; своё имя перекрывает привезённое,
 *     потому что переопределить cv под свой курс — законное желание.
 *
 * Имя в путь превращает ровно одна функция — envFile(); всё остальное зовёт
 * её. Второй ответ на вопрос «где лежит cv» развёл бы список с показом, а
 * показ — с тем, что потом соберёт запуск, причём молча.
 *
 * node:child_process и node:fs импортировать нельзя: только ctx.io, а
 * ctx.sh — ради одной строки --dry-run.
 */
import type { Command, Ctx } from '../registry.js'
import { joinPath, type Io } from '../env.js'
import { localClassEnv } from '../launch-config.js'
import { countWord, PreconditionError, UsageError } from '../ui.js'
import { PYTHON_VERSIONS } from '../../../shared/admin.js'

/** Потолок цепочки `# colloq: from` — тот же, что у сборки в Makefile. */
const CHAIN_LIMIT = 8

/** Две директивы шапки. Для pip это комментарии, для нас — устройство. */
const FROM = /^[ \t]*#[ \t]*colloq:[ \t]*from[ \t]+([^\s]+)[ \t]*$/m
const PYTHON = /^[ \t]*#[ \t]*colloq:[ \t]*python[ \t]+(3\.[0-9]+)[ \t]*$/m

/** Имя окружения: им зовётся и файл, и тег образа colloq-kernel:<имя>. */
const NAME = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/

/** Строка, которую в списке пакетов не видно: комментарий, пусто, ключ pip. */
const NOT_A_PACKAGE = /^[ \t]*(#|-|$)/

/** Комментарий и пустая строка — то, что прячет и цель env-show. */
const NOT_A_LINE = /^[ \t]*(#|$)/

/** Два каталога окружений: привезённый с продуктом и свой. */
type Dirs = { app: string; own: string }

function envDirs(ctx: Ctx): Dirs {
  return { app: ctx.env.paths.envDir, own: ctx.env.paths.ownEnvDir }
}

/**
 * Имя окружения в путь к файлу — единственное место, где это решается.
 *
 * Своё перекрывает привезённое: если <home>/environments/cv.txt есть, дальше
 * всё (показ, версия Python, счёт пакетов, сборка) работает с ним, а не с тем
 * cv, который приехал в пакете. Обратный порядок означал бы, что завести своё
 * окружение с занятым именем можно, а пользоваться им нельзя.
 *
 * В репозитории оба каталога — один и тот же путь, и выбор сводится к нулю:
 * строка получается та же самая.
 */
export function envFileIn(io: Io, dirs: Dirs, name: string): string {
  const own = joinPath(dirs.own, name + '.txt')
  return io.exists(own) ? own : joinPath(dirs.app, name + '.txt')
}

/** Имена всех окружений: объединение двух каталогов, без повторов. */
export function listEnvNames(io: Io, dirs: Dirs): string[] {
  const names = new Set<string>()
  // Set, а не два списка подряд: в репозитории каталоги совпадают, и без него
  // каждое окружение печаталось бы дважды.
  for (const dir of [dirs.app, dirs.own]) {
    for (const file of io.list(dir)) {
      if (file.endsWith('.txt')) names.add(file.slice(0, -'.txt'.length))
    }
  }
  return [...names].sort()
}

function envFile(ctx: Ctx, name: string): string {
  return envFileIn(ctx.io, envDirs(ctx), name)
}

/** Куда пишет `env new`: всегда свой каталог, что бы ни лежало в привезённом. */
function ownFile(ctx: Ctx, name: string): string {
  return joinPath(ctx.env.paths.ownEnvDir, name + '.txt')
}

/** Своё ли это окружение — то есть лежит ли оно в каталоге, куда мы пишем. */
function isOwn(ctx: Ctx, name: string): boolean {
  const dirs = envDirs(ctx)
  if (dirs.own === dirs.app) return false
  return ctx.io.exists(ownFile(ctx, name))
}

/**
 * Путь покороче: от корня приложения — как его печатает Makefile, от дома
 * человека — с тильдой. У установленного colloq оба каталога абсолютные и
 * длинные, и целиком они в строку про окружение не помещаются.
 */
function short(ctx: Ctx, path: string): string {
  const root = ctx.env.root() + '/'
  if (path.startsWith(root)) return path.slice(root.length)
  const home = ctx.env.home()
  if (home && path.startsWith(home + '/')) return '~' + path.slice(home.length)
  return path
}

/** Где искать окружения — одной строкой для шапки списка. */
function places(ctx: Ctx): string {
  const dirs = envDirs(ctx)
  const app = short(ctx, dirs.app) + '/'
  return dirs.own === dirs.app ? app : app + ' and ' + short(ctx, dirs.own) + '/'
}

function textOf(ctx: Ctx, path: string): string | null {
  const text = ctx.io.readText(path)
  return text === null ? null : text.replace(/\r/g, '')
}

/** Имя окружения из первого позиционного — сразу через сито имени. */
function wantName(ctx: Ctx, usage: string): string {
  const name = (ctx.positionals[0] ?? '').trim()
  if (!name) throw new UsageError('no environment given', 'Usage: ' + usage)
  checkName(name)
  return name
}

function checkName(name: string): void {
  if (NAME.test(name)) return
  throw new UsageError(
    '"' + name + '" cannot be an environment name: lowercase latin letters, digits and a hyphen',
    'colloq env list: which ones already exist',
  )
}

/** Нет файла окружения — отказ здесь, до вопросов и до записи. */
function needFile(ctx: Ctx, name: string, fix: string): void {
  if (ctx.io.exists(envFile(ctx, name))) return
  throw new PreconditionError(
    'no ' + short(ctx, envFile(ctx, name)) + ': environment "' + name + '" has not been created',
    fix,
  )
}

/**
 * Версии, на которых вообще собирается ядро: те же, что предлагает панель.
 *
 * Значением из импорта, а не разбором текста shared/admin.ts, как было
 * здесь раньше. Тот файл искался по корню ПРИЛОЖЕНИЯ, а каталога shared/ в
 * дистрибутиве нет вовсе (scripts/pack.mts кладёт server/dist, web/dist,
 * server/assets и kernel/*) — список у установленного colloq всегда выходил
 * пустым, и проверка в wantPython вместе с ним молча выключалась:
 * `colloq env new ml --python 3.99` проходил без отказа и писал в шапку
 * «# colloq: python 3.99», а env list и env show потом показывали это как версию
 * окружения, которое не соберётся. Импорт esbuild впечатывает в бандл, и
 * читать на машине становится нечего — и разойтись с панелью тоже нечему.
 *
 * readonly string[], а не сам кортеж: у `as const` у includes() тип аргумента —
 * литерал из списка, а нам нужно спросить про произвольную строку от человека.
 */
const PYTHONS: readonly string[] = PYTHON_VERSIONS

/** Версия Python из --python; пусто — значит умолчание. */
function wantPython(ctx: Ctx): string | undefined {
  const value = ((ctx.values.python as string | undefined) ?? '').trim()
  if (!value) return undefined
  if (!PYTHONS.includes(value)) {
    throw new UsageError(
      'Python ' + value + ' is not one of those the kernel builds on',
      'available: ' + PYTHONS.join(' '),
    )
  }
  return value
}

/** Умолчание — из самого kernel/Dockerfile, а не вторым списком. */
function defaultPython(ctx: Ctx): string {
  const text = textOf(ctx, ctx.env.path('kernel/Dockerfile')) ?? ''
  return /^ARG PARENT=python:([0-9]+\.[0-9]+)-/m.exec(text)?.[1] ?? '3.11'
}

/**
 * Цепочка наследования `# colloq: from`, от корня к названному окружению, и
 * беда, если цепочка негодная.
 *
 * Беда возвращается, а не бросается, потому что читателей у цепочки два с
 * разным отношением к ней. Списку важнее показать список: одно окружение,
 * сославшееся на себя, не должно гасить экран целиком, — он берёт то, что
 * прочиталось, и молчит. Показу и переключению важнее сказать правду: строить
 * такое окружение всё равно нечем, и узнать об этом лучше сейчас, чем на
 * colloq start перед парой, когда сборка упадёт.
 *
 * Меры ровно те же, что у сборки в запуске (launch-config.ts · kernelInputs)
 * и у цели env-build в Makefile: петля, потолок в восемь звеньев,
 * имя-не-имя, пропавший родитель. Своя реализация, а не вызов kernelInputs,
 * по двум причинам: та ходит в настоящую файловую систему мимо ctx.io (в
 * тестах группы её нет) и знает один каталог окружений из двух.
 */
type Chain = { names: string[]; trouble?: string }

function chainOf(io: Io, dirs: Dirs, name: string): Chain {
  const names: string[] = []
  let current: string | undefined = name
  while (current) {
    const file = envFileIn(io, dirs, current)
    if (names.includes(current)) {
      return { names, trouble: 'environments reference each other in a circle: ' + current }
    }
    if (!NAME.test(current)) {
      return {
        names,
        trouble: '"' + current + '" cannot be an environment name: neither a file nor an image tag',
      }
    }
    const text = io.readText(file)
    if (text === null) {
      return {
        names,
        trouble:
          names.length === 0
            ? 'environment "' + current + '" has not been created'
            : 'environment "' + current + '" is named as a parent, and it does not exist',
      }
    }
    // unshift, а не push: первым в списке стоит корень цепочки — тот, с кого
    // начинается сборка и чей интерпретатор достаётся всем, кто ниже.
    names.unshift(current)
    if (names.length > CHAIN_LIMIT) {
      return { names, trouble: 'the environment chain is longer than eight links' }
    }
    current = FROM.exec(text.replace(/\r/g, ''))?.[1]
  }
  return { names }
}

/**
 * На каком Python поедет окружение. Версию задаёт КОРЕНЬ цепочки: она
 * приходит из базового образа, а слой поверх готового образа интерпретатор не
 * меняет.
 */
function pythonOf(ctx: Ctx, name: string, fallback: string): string {
  const root = chainOf(ctx.io, envDirs(ctx), name).names[0]
  if (root === undefined) return fallback
  const text = textOf(ctx, envFile(ctx, root))
  return (text === null ? undefined : PYTHON.exec(text)?.[1]) ?? fallback
}

/** Цепочка или отказ: для тех, кому с негодной цепочкой дальше идти некуда. */
function needChain(ctx: Ctx, name: string, fix: string): Chain {
  const chain = chainOf(ctx.io, envDirs(ctx), name)
  if (chain.trouble) throw new PreconditionError(chain.trouble, fix)
  return chain
}

/** Сколько пакетов сверх базы — тем же правилом, что у цели env-list. */
function packagesOf(text: string): number {
  return text.split('\n').filter((line) => !NOT_A_PACKAGE.test(line)).length
}

/** Строки файла, которые человек вписал сам: без комментариев и пустых. */
function meaningful(text: string): string[] {
  return text.split('\n').filter((line) => !NOT_A_LINE.test(line))
}

/** Шапка нового окружения — строка в строку та, что пишет цель env-new, только по-английски. */
function starter(name: string, python: string | undefined, fallback: string): string {
  const lines: string[] = []
  /*
   * Версия — директивой в шапке, и только если её просили НЕ по умолчанию.
   *
   * Файл без строки и файл со строкой про умолчание значат сегодня одно и то
   * же, но завтра — разное: умолчание живёт в ARG PARENT самого
   * kernel/Dockerfile, и когда его однажды поднимут, записанная строка станет
   * враньём, которое никто не просил. Не записанная — просто согласится.
   */
  if (python && python !== fallback) lines.push('# colloq: python ' + python, '#')
  lines.push(
    '# Environment "' + name + '". It is installed on top of the base from',
    '# kernel/requirements.txt, so numpy/pandas/matplotlib/scikit-learn need no line here.',
    '#',
    '# One package per line, as in an ordinary requirements.txt:',
    '#',
    '#   transformers>=4.44',
    '#   datasets>=2.20',
    '',
  )
  return lines.join('\n')
}

/**
 * Перелить KERNEL_ENV в .env, не трогая остальные строки.
 *
 * Содержимое переписывается в существующий файл, а не кладётся поверх новым:
 * та же причина, что в Makefile и в scripts/host.sh. На Linux, где docker
 * просит sudo, перенос файла из /tmp уносил вместе с ним владельца root и
 * права 0600 — и следующий запуск от человека не мог прочитать собственный
 * .env: инстанс поднимался с умолчаниями, то есть с чужим токеном ядра и
 * localhost в ссылках для аудитории. Запись в тот же путь владельца и права
 * оставляет как были.
 */
function writeKernelEnv(ctx: Ctx, name: string): void {
  /*
   * Файла ещё нет — значит его здесь и заводят, целым.
   *
   * Строка «KERNEL_ENV=…» в пустом месте выглядела бы безобидно, но она и есть
   * .env: дальше `colloq start` видит файл на месте и своего не пишет (launch.ts
   * создаёт его ТОЛЬКО когда файла нет). Занятие поднималось с умолчаниями —
   * то есть с общеизвестным JUPYTER_TOKEN из .env.example, и сервер честно
   * ругался на это в журнал. Поймано живьём: `colloq env use` из колеса до
   * первого `colloq start`.
   *
   * Поэтому основой берётся тот же самый текст, который написал бы запуск
   * (launch-config.ts · localClassEnv) — один файл на двоих, и расходиться им
   * негде. Права 0600 по той же причине, что и там: внутри ключи входа.
   */
  const existing = ctx.io.readText(ctx.env.paths.envFile)
  const text = existing ?? localClassEnv(ctx.dist)
  const kept = text.split('\n').filter((line) => !/^KERNEL_ENV=/.test(line))
  while (kept.length > 0 && (kept[kept.length - 1] ?? '').trim() === '') kept.pop()
  kept.push('KERNEL_ENV=' + name, '')
  ctx.io.writeText(ctx.env.paths.envFile, kept.join('\n'), existing === null ? 0o600 : undefined)
}

/** Экран `env list` — тот же, что печатает цель env-list, вплоть до ширины колонки. */
function renderList(ctx: Ctx): void {
  const current = ctx.env.kernelEnv()
  const fallback = defaultPython(ctx)
  const names = listEnvNames(ctx.io, envDirs(ctx))
  ctx.ui.line(ctx.ui.bold('Environments') + ' ' + ctx.ui.dim('(' + places(ctx) + ')'))
  ctx.ui.line()
  if (names.length === 0) {
    ctx.ui.line('  ' + ctx.ui.dim('no environment files: create one with colloq env new <name>'))
    return
  }
  // Колонка в 14 знаков — из Makefile (%-14s); длинное имя её раздвигает, а не
  // ломает строку.
  const width = Math.max(14, ...names.map((name) => name.length))
  for (const name of names) {
    const text = textOf(ctx, envFile(ctx, name)) ?? ''
    const tail =
      'Python ' +
      pythonOf(ctx, name, fallback) +
      ' · ' +
      countWord(packagesOf(text), 'package') +
      ' on top of the base' +
      (isOwn(ctx, name) ? ' · your own' : '')
    ctx.ui.line(
      '  ' + (name === current ? '*' : ' ') + ' ' + name.padEnd(width) + ' ' + ctx.ui.dim(tail),
    )
  }
  ctx.ui.line()
  ctx.ui.line(ctx.ui.dim('* — the default for new classes. Change it: colloq env use <name>'))
}

/** Экран `env show` — то же, что печатает цель env-show, но про любое окружение. */
function renderShow(ctx: Ctx, name: string): void {
  const file = envFile(ctx, name)
  const python = pythonOf(ctx, name, defaultPython(ctx))
  ctx.ui.line(ctx.ui.bold(name) + ' ' + ctx.ui.dim('— ' + short(ctx, file) + ' · Python ' + python))
  ctx.ui.line()
  const own = meaningful(textOf(ctx, file) ?? '')
  if (own.length > 0) ctx.ui.table(own.map((line) => [line]))
  else ctx.ui.line('  ' + ctx.ui.dim('nothing on top of the base'))
  ctx.ui.line()
  ctx.ui.line(ctx.ui.dim('Base (always there):'))
  ctx.ui.table(
    meaningful(textOf(ctx, ctx.env.path('kernel/requirements.txt')) ?? '').map((line) => [line]),
  )
}

export const commands: Command[] = [
  {
    name: 'env list',
    aliases: ['env', 'env ls'],
    group: 'env',
    summary: 'Which environments exist',
    usage: 'colloq env list [--json]',
    flags: [
      { name: 'json', summary: 'Machine-readable: name, Python, packages on top of the base' },
    ],
    destructive: false,
    delegates: 'native: reads both environment directories and KERNEL_ENV from .env',
    examples: ['colloq env list', 'colloq env list --json'],
    notes:
      'The star marks the default for new classes: KERNEL_ENV from .env, otherwise base. The Python version comes from the root of the "# colloq: from" chain, which is at most eight links long. "your own" is an environment you created yourself: it lives next to .env and survives an update of the package.',
    async run(ctx) {
      // Намерение одной строкой — и для человека, и для --json: расходиться
      // им незачем, а два раза написанная строка разъезжается.
      const intent = 'native: env list (reads ' + places(ctx) + ' and KERNEL_ENV from .env)'
      if (ctx.dryRun) {
        if (!ctx.json) return ctx.sh.dry(intent)
        ctx.ui.json({ ok: true, dryRun: true, command: intent })
        return 0
      }
      if (!ctx.json) {
        renderList(ctx)
        return 0
      }
      const current = ctx.env.kernelEnv()
      const fallback = defaultPython(ctx)
      const dirs = envDirs(ctx)
      ctx.ui.json({
        ok: true,
        current,
        dir: short(ctx, dirs.app),
        ownDir: short(ctx, dirs.own),
        environments: listEnvNames(ctx.io, dirs).map((name) => ({
          name,
          python: pythonOf(ctx, name, fallback),
          packages: packagesOf(textOf(ctx, envFile(ctx, name)) ?? ''),
          current: name === current,
          own: isOwn(ctx, name),
          file: short(ctx, envFile(ctx, name)),
        })),
      })
      return 0
    },
  },

  {
    name: 'env show',
    group: 'env',
    summary: 'What is in an environment and which Python it runs on',
    usage: 'colloq env show [name]',
    args: [{ name: 'name', summary: 'Environment; without a name, the current one' }],
    flags: [],
    destructive: false,
    delegates: 'native: reads <environment>.txt and kernel/requirements.txt',
    examples: ['colloq env show', 'colloq env show {env}'],
    notes:
      'Without a name it shows the current one: what stands in KERNEL_ENV. When there is no such file it refuses. The base packages are listed separately: they are in every environment, and there is no need to repeat them in your own list.',
    async run(ctx) {
      const asked = (ctx.positionals[0] ?? '').trim() || ctx.env.kernelEnv()
      checkName(asked)
      needFile(ctx, asked, 'colloq env list')
      // Негодная цепочка — отказ до показа: строка «Python 3.11» над
      // окружением, которое ссылается на себя, выглядит как ответ, а ответом
      // не является.
      needChain(ctx, asked, 'colloq env show ' + asked + ': fix the "# colloq: from" line')
      if (ctx.dryRun) {
        return ctx.sh.dry(
          'native: env show ' +
            asked +
            ' (reads ' +
            short(ctx, envFile(ctx, asked)) +
            ' and kernel/requirements.txt)',
        )
      }
      renderShow(ctx, asked)
      return 0
    },
  },

  {
    name: 'env new',
    group: 'env',
    summary: 'Create an environment',
    usage: 'colloq env new <name> [--python <version>]',
    args: [
      {
        name: 'name',
        summary: 'What to call it: lowercase latin letters, digits, hyphen',
        required: true,
      },
    ],
    flags: [
      {
        name: 'python',
        arg: 'version',
        summary: 'Which Python to build on; otherwise the default',
      },
    ],
    destructive: false,
    delegates: 'native: creates <name>.txt with a header in your own environment directory',
    examples: ['colloq env new cv', 'colloq env new cv --python 3.12'],
    notes:
      'Creates an empty file with a header and does not overwrite an existing one. It is always written into your own directory, next to .env, and not where the package is installed: otherwise the environment would be gone on the first update. A name already taken by a bundled environment is allowed: your file overrides the bundled one. The version comes from PYTHON_VERSIONS in shared/admin.ts, and the "# colloq: python X.Y" line is written only when the version differs from ARG PARENT in kernel/Dockerfile.',
    async run(ctx) {
      const name = wantName(ctx, 'colloq env new <name>')
      const python = wantPython(ctx)
      const file = ownFile(ctx, name)
      if (ctx.io.exists(file)) {
        throw new PreconditionError(
          short(ctx, file) + ' already exists',
          'colloq env show ' + name + ': what is in it now',
        )
      }
      // Перекрытие — не ошибка, но и не мелочь: человек должен видеть, что
      // теперь cv значит его файл, а не тот, что приехал с продуктом.
      const shadows = ctx.io.exists(joinPath(ctx.env.paths.envDir, name + '.txt'))
      if (ctx.dryRun) {
        return ctx.sh.dry(
          'native: env new ' +
            name +
            ' (creates ' +
            short(ctx, file) +
            ', Python ' +
            (python ?? defaultPython(ctx)) +
            ')',
        )
      }
      ctx.io.writeText(file, starter(name, python, defaultPython(ctx)))
      ctx.ui.line(ctx.ui.bold('created') + ' ' + short(ctx, file))
      if (shadows) {
        ctx.ui.line(ctx.ui.dim('overrides the bundled environment with the same name'))
      }
      ctx.ui.line(
        ctx.ui.dim(
          'Python ' +
            pythonOf(ctx, name, defaultPython(ctx)) +
            ' · write the packages in, then: colloq env use ' +
            name,
        ),
      )
      return 0
    },
  },

  {
    name: 'env use',
    aliases: ['env switch'],
    group: 'env',
    summary: 'Make an environment the default for new classes',
    usage: 'colloq env use <name>',
    args: [{ name: 'name', summary: 'An environment from colloq env list', required: true }],
    flags: [],
    destructive: true,
    confirm: 'cli',
    // Проверка до вопроса: окружения нет или цепочка негодная — отказ, а не
    // вопрос перед отказом. Негодную цепочку не соберёт и запуск, и узнать об
    // этом сейчас дешевле, чем на colloq start перед парой.
    check(ctx) {
      const name = wantName(ctx, 'colloq env use <name>')
      needFile(ctx, name, 'colloq env new ' + name)
      needChain(ctx, name, 'fix the "# colloq: from" line in the chain')
    },
    // Вопрос обещает ровно то, что команда сделает, — одну строку в .env.
    // Сборки здесь нет, значит нет и обещания долгого ожидания: о минутах
    // сборки на colloq start команда говорит уже после записи.
    confirmQuestion: (ctx) =>
      'make environment ' +
      wantName(ctx, 'colloq env use <name>') +
      ' the default for new classes?',
    delegates: 'native: KERNEL_ENV in .env',
    examples: ['colloq env use cv', 'colloq env use {env} --yes'],
    notes:
      'The KERNEL_ENV= line is written into the existing .env instead of a fresh file put on top of it: under sudo the file would stay root:0600, and the next start would bring an instance up with the defaults. Classes that are already open stay on their own environment. The image is not built here: colloq start builds it before the class, together with the rest of the preparation, and the first time that can take minutes.',
    async run(ctx) {
      // Файл и цепочку уже проверил check() — до вопроса и под --dry-run тоже.
      const name = wantName(ctx, 'colloq env use <name>')
      if (ctx.dryRun) {
        return ctx.sh.dry(
          'native: env use ' +
            name +
            ' (KERNEL_ENV=' +
            name +
            ' in ' +
            short(ctx, ctx.env.paths.envFile) +
            ')',
        )
      }
      writeKernelEnv(ctx, name)
      ctx.ui.line(ctx.ui.bold('Default environment for new classes: ' + name))
      ctx.ui.line(
        ctx.ui.dim('the image is built on your next colloq start: this can take minutes'),
      )
      return 0
    },
  },
]
