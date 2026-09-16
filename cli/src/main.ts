/**
 * Разбор argv, диспетчер, help и меню.
 *
 * Весь каркас живёт здесь: группы команд его не правят. Что он берёт на себя:
 *
 *   · пары ВИДА=ЗНАЧЕНИЕ снимаются из ЛЮБОГО места argv и уходят make как
 *     есть — make-форма работает везде и всегда (MODE, RESUME, FORCE, SINCE);
 *   · глобальные флаги --help --dry-run --yes --json --no-color --version;
 *   · имя команды разрешается жадно: сначала два токена («vast up»), потом один;
 *   · вопрос перед опасным действием задаётся один раз и здесь, а не в командах;
 *   · дефисное имя команды («cluster-stop») ведёт в саму команду, а не в make:
 *     иначе мимо проходят её проверки, вопрос и флаги;
 *   · неизвестное слово — подсказка: группа, соседнее имя по расстоянию
 *     Левенштейна или «зовите цель явно: colloq make <цель>»;
 *   · поверхность: в поверхности преподавателя (COLLOQ_SURFACE=teacher) help,
 *     меню и подсказки показывают только команды с audience:'teacher'. Поиск
 *     команды по имени поверхность не сужает никогда — спрятанное остаётся
 *     доступным, иначе «спрятать» превратилось бы в «выбросить».
 */
import { parseArgs } from 'node:util'
import { GROUPS, registry, type Audience, type Command, type Ctx, type Form } from './registry.js'
import { createEnv, createIo, isDistribution, type Io } from './env.js'
import { createSh, type Runner } from './sh.js'
import {
  cancelled,
  colorAllowed,
  createUi,
  PreconditionError,
  roomsWord,
  SYMBOL,
  UsageError,
} from './ui.js'

export type Deps = {
  io?: Io
  out?: (text: string) => void
  err?: (text: string) => void
  /** Подставной исполнитель: пока он стоит, ни один процесс не запускается. */
  runner?: Runner | null
  tty?: boolean
  /** Подставные ответы на вопросы. */
  ask?: (question: string) => Promise<string>
  processEnv?: NodeJS.ProcessEnv
  /** Реестр целиком — для тестов. */
  commands?: Command[]
  root?: string
  /** Каталог состояния. Не назван — совпадает с root, как в репозитории. */
  home?: string
  cwd?: string
  /** Считать приложение установленным: иначе признак ищется у корня. */
  dist?: boolean
}

const GLOBAL_FLAGS = new Set([
  '--help',
  '-h',
  '--dry-run',
  '--yes',
  '-y',
  '--json',
  '--no-color',
  '--version',
  '-V',
])

/** Пара вида ВИДА=ЗНАЧЕНИЕ: так переменные передают make, и так же их принимаем мы. */
const MAKE_VAR = /^[A-Z][A-Z0-9_]*=/

/**
 * Какая сейчас поверхность.
 *
 * Выбирает её окружение, а не догадка по каталогу: COLLOQ_SURFACE=teacher
 * выставляет питоновский шим, которым команда `colloq` приходит к человеку
 * после `pip install colloq`. В репозитории переменной нет, и поверхность
 * остаётся мастерской — видно всё, как было до разделения. Любое другое
 * значение тоже мастерская: незнакомое слово не должно прятать команды.
 */
export function surfaceOf(processEnv: NodeJS.ProcessEnv): Audience {
  return (processEnv.COLLOQ_SURFACE ?? '').trim() === 'teacher' ? 'teacher' : 'workshop'
}

/**
 * Что показывать в этой поверхности.
 *
 * Сужение применяется РОВНО к трём вещам: список в help, пункты меню и
 * подсказка по опечатке (включая перечисление команд группы и список тех, у
 * кого есть --json). Поиск команды по имени идёт по полному реестру: `colloq
 * dev` у преподавателя работает, просто про него нигде не написано.
 */
export function visibleIn(commands: Command[], surface: Audience): Command[] {
  if (surface !== 'teacher') return commands
  return commands.filter((command) => command.audience === 'teacher')
}

export async function cli(argv: string[], deps: Deps = {}): Promise<number> {
  const processEnv = deps.processEnv ?? process.env
  const commands = deps.commands ?? registry
  const surface = surfaceOf(processEnv)
  // Показываем это, ищем по всему: см. visibleIn.
  const shown = visibleIn(commands, surface)
  const io = deps.io ?? createIo()
  const tty = deps.tty ?? Boolean(process.stdout.isTTY && process.stdin.isTTY)

  // 1. Переменные make — из любого места, до всего остального.
  const makeVars: Record<string, string> = {}
  const rest: string[] = []
  for (const token of argv) {
    if (MAKE_VAR.test(token)) {
      const eq = token.indexOf('=')
      makeVars[token.slice(0, eq)] = token.slice(eq + 1)
      continue
    }
    rest.push(token)
  }

  // 2. Глобальные флаги — тоже из любого места. Всё после `--` неприкосновенно.
  const globals = {
    help: false,
    dryRun: false,
    yes: false,
    json: false,
    noColor: false,
    version: false,
  }
  const tokens: string[] = []
  let raw = false
  for (const token of rest) {
    if (raw) {
      tokens.push(token)
      continue
    }
    if (token === '--') {
      raw = true
      tokens.push(token)
      continue
    }
    if (!GLOBAL_FLAGS.has(token)) {
      tokens.push(token)
      continue
    }
    if (token === '--help' || token === '-h') globals.help = true
    else if (token === '--dry-run') globals.dryRun = true
    else if (token === '--yes' || token === '-y') globals.yes = true
    else if (token === '--json') globals.json = true
    else if (token === '--no-color') globals.noColor = true
    else globals.version = true
  }

  const color = globals.noColor ? false : colorAllowed(processEnv, Boolean(process.stdout.isTTY))
  const ui = createUi({
    color,
    json: globals.json,
    out: deps.out,
    err: deps.err,
    tty,
    ask: deps.ask,
  })
  const env = createEnv({ io, root: deps.root, home: deps.home, cwd: deps.cwd, processEnv })
  const sh = createSh({
    root: env.root(),
    ui,
    dryRun: globals.dryRun,
    makeVars,
    runner: deps.runner ?? null,
  })

  let roomsCache: Promise<number> | null = null
  let formCache: Promise<Form> | null = null
  let serverCache: Promise<boolean> | null = null

  const ctx: Ctx = {
    positionals: [],
    values: {},
    makeVars,
    dryRun: globals.dryRun,
    yes: globals.yes,
    json: globals.json,
    sh,
    ui,
    env,
    io,
    surface,
    dist: deps.dist ?? isDistribution(),
    rooms() {
      roomsCache ??= countRooms()
      return roomsCache
    },
    form() {
      formCache ??= detectForm()
      return formCache
    },
    serverAlive() {
      serverCache ??= detectServer()
      return serverCache
    },
    async confirm(question) {
      if (globals.yes || globals.dryRun) return true
      return await ui.confirm(await withRooms(question))
    },
  }

  async function countRooms(): Promise<number> {
    const result = await sh.capture(
      'docker',
      ['ps', '--filter', 'label=colloq.kind=room-kernel', '--format', '{{.ID}}'],
      { timeoutMs: 4000 },
    )
    if (result.code !== 0) return 0
    return result.stdout.split('\n').filter((line) => line.trim() !== '').length
  }

  /**
   * Форма установки — тем же порядком, что scripts/host.sh:387-397.
   *
   * COLLOQ_CLUSTER=1 в .env главнее всего: так себя помечает выделенная машина
   * под k3s, у которой каталога состояния может ещё не быть. Служба считается
   * формой, только если она жива: оставшийся юнит-файл говорит о прошлом.
   * Расписка .colloq.pid идёт последней и тоже проверяется на живость — она
   * переживает и перезагрузку, и смену формы.
   */
  async function detectForm(): Promise<Form> {
    if (env.read('COLLOQ_CLUSTER') === '1') return 'cluster'
    if (io.exists(env.paths.clusterState)) return 'cluster'
    if (io.exists(env.paths.serviceUnit)) {
      const unit = await sh.capture('systemctl', ['is-active', 'colloq'], { timeoutMs: 4000 })
      if (unit.code === 0 || unit.code === 127) return 'service'
    }
    const result = await sh.capture(
      'docker',
      ['ps', '--filter', 'name=colloq', '--format', '{{.Names}}'],
      { timeoutMs: 4000 },
    )
    if (result.code === 0 && /colloq[-_]?app/.test(result.stdout)) return 'container'
    if (await livePid()) return 'host'
    return 'other'
  }

  /** Живой ли pid из .colloq.pid: `kill -0` и ничего больше. */
  async function livePid(): Promise<boolean> {
    const pid = (io.readText(env.paths.pidFile) ?? '').trim()
    if (!/^[0-9]+$/.test(pid)) return false
    const alive = await sh.capture('kill', ['-0', pid], { timeoutMs: 4000 })
    return alive.code === 0
  }

  /**
   * Жив ли сервер этой машины: расписка make run или кто угодно, кто слушает
   * порт. Спрашивается только ради вопроса — запрещать ничего нельзя.
   */
  async function detectServer(): Promise<boolean> {
    if (await livePid()) return true
    const listen = await sh.capture(
      'lsof',
      ['-nP', '-iTCP:' + String(env.port()), '-sTCP:LISTEN', '-t'],
      { timeoutMs: 4000 },
    )
    return listen.code === 0 && listen.stdout.trim() !== ''
  }

  /** Вопрос с уточнением о комнатах: число не запрещает действие, только уточняет. */
  async function withRooms(question: string): Promise<string> {
    const count = await ctx.rooms()
    return count > 0 ? question + ' ' + roomsPhrase(count) : question
  }

  try {
    if (globals.version) {
      ui.line(version(io, env.path('cli/package.json')))
      return 0
    }

    // Без аргументов: в мастерской — локальная сессия, как было (голый
    // `colloq` в репозитории поднимает сервер, и менять это нельзя). У
    // преподавателя голый вызов ничего не запускает: пакет ставят задолго до
    // пары, и первое знакомство должно быть строкой «что я умею», а не
    // внезапно занятым портом и открытым браузером. Занятие начинается словом
    // — `colloq start`, как `jupyter lab`.
    if (tokens.length === 0) {
      if (globals.help) {
        renderHelp(ui, commands, env.kernelEnv(), surface)
        return 0
      }
      if (surface === 'teacher') {
        renderIntro(ui)
        return 0
      }
      return await dispatch(['run'])
    }

    return await dispatch(tokens)
  } catch (error) {
    return fail(error)
  }

  function fail(error: unknown): number {
    if (error instanceof UsageError) return report(2, error.message, error.fix, error.why)
    if (error instanceof PreconditionError) return report(3, error.message, error.fix, error.why)
    const message = error instanceof Error ? error.message : String(error)
    return report(1, message, 'colloq help')
  }

  /** Отказ в трёх строках, а в режиме --json — тем же кодом и ни строки вне JSON. */
  function report(code: number, what: string, fix: string, why = ''): number {
    if (globals.json) {
      ui.json({ ok: false, code, error: what + (why ? '. ' + why : ''), hint: fix })
      return code
    }
    ui.refuse(what, why, fix)
    return code
  }

  async function dispatch(input: string[]): Promise<number> {
    const head = input.filter((token) => !token.startsWith('-'))
    const first = head[0] ?? ''

    if (first === 'menu' || (first === 'help' && head[1] === 'menu')) {
      if (globals.help || first === 'help') {
        ui.line('Usage: colloq menu')
        ui.line('Interactive menu of commands by group; needs a terminal.')
        return 0
      }
      if (input.length !== 1 || globals.json) {
        throw new UsageError('the menu takes no arguments and no --json', 'colloq menu')
      }
      if (globals.dryRun) return sh.dry('native: menu')
      if (!tty)
        throw new PreconditionError(
          'the menu needs a terminal',
          'colloq help — the list of commands',
        )
      return await menu(ctx, shown, (next) => dispatch(next))
    }

    if (first === 'help') {
      const wanted = head[1]
      if (wanted) {
        const target = find(commands, wanted) ?? find(commands, head.slice(1, 3).join(' '))
        if (!target) return unknown(wanted)
        renderCommandHelp(ui, target, env)
        return 0
      }
      renderHelp(ui, commands, env.kernelEnv(), surface)
      return 0
    }

    // Жадно: сначала два токена, потом один.
    const two = head.length > 1 ? first + ' ' + head[1] : ''
    const found = (two ? find(commands, two) : undefined) ?? find(commands, first)
    if (!found) {
      // Дефисный двойник двухсловного имени — та же команда: `cluster-stop`
      // это `cluster stop`. Молча уводить его в make нельзя: там нет ни
      // проверок, ни вопроса, ни флагов, а на машине идёт пара.
      const twin = first.includes('-') ? find(commands, first.replaceAll('-', ' ')) : undefined
      if (twin) return await dispatch(respell(input, first, twin.name))
      // --help не должен выполнить ни одного неизвестного слова.
      if (globals.help) {
        renderHelp(ui, commands, env.kernelEnv(), surface)
        return 2
      }
      return unknownOrMake(first)
    }

    // Сколько токенов съело имя: два — только если позвали именно двухсловным
    // именем или двухсловным алиасом. У односложного алиаса двухсловной команды
    // (`colloq dns` = `dns sync`) съедается один, иначе следом за ним пропадало
    // бы значение флага: `colloq dns --domain colloq.ru`.
    const matchedTwo = Boolean(two) && (found.name === two || (found.aliases ?? []).includes(two))
    const used = matchedTwo ? 2 : 1
    // Хвост: всё, кроме съеденных имени команды токенов.
    const tail = dropCommandTokens(input, used)

    if (globals.help) {
      renderCommandHelp(ui, found, env)
      return 0
    }

    if (globals.json && !found.flags.some((flag) => flag.name === 'json')) {
      // Перечисляем только видимое: советовать преподавателю `colloq env list
      // --json` можно, а отправлять его к спрятанной команде — значит назвать
      // её вслух и тут же не найти в help.
      const where = shown
        .filter((command) => command.flags.some((flag) => flag.name === 'json'))
        .map((command) => command.name)
      throw new UsageError(
        'command ' + found.name + ' has no --json',
        where.length
          ? '--json works with ' + where.join(', ')
          : 'no command has a machine-readable view',
      )
    }

    const options: Record<
      string,
      { type: 'string' | 'boolean'; short?: string; multiple?: boolean }
    > = {}
    for (const flag of found.flags) {
      options[flag.name] = {
        type: flag.arg ? 'string' : 'boolean',
        ...(flag.short ? { short: flag.short } : {}),
        ...(flag.multiple ? { multiple: true } : {}),
      }
    }

    let parsed: { values: Record<string, unknown>; positionals: string[] }
    try {
      parsed = parseArgs({ args: tail, options, strict: true, allowPositionals: true }) as {
        values: Record<string, unknown>
        positionals: string[]
      }
    } catch (error) {
      throw parseTrouble(error, found)
    }

    ctx.positionals = parsed.positionals
    ctx.values = parsed.values

    // Обязательный аргумент назван либо позицией, либо своей парой
    // ВИДА=ЗНАЧЕНИЕ: make-форма работает везде, и required ей не мешает.
    const declared = found.args ?? []
    for (let i = 0; i < declared.length; i++) {
      const arg = declared[i]
      if (!arg?.required) continue
      if ((parsed.positionals[i] ?? '').trim() !== '') continue
      if (arg.makeVar && (makeVars[arg.makeVar] ?? '').trim() !== '') continue
      throw new UsageError('missing required argument <' + arg.name + '>', 'Usage: ' + found.usage)
    }
    // Лишний позиционный — это чаще всего опечатка в имени команды
    // (`colloq env cv`): молча свести её к другой команде хуже, чем отказать.
    if (!found.extra && parsed.positionals.length > declared.length) {
      throw new UsageError(
        'extra argument: ' + (parsed.positionals[declared.length] ?? ''),
        'Usage: ' + found.usage,
      )
    }

    // Проверка аргументов идёт ДО вопроса: у плохого аргумента вопроса не
    // бывает, и отказ не должен зависеть от того, есть ли терминал.
    if (found.check) await found.check(ctx)

    // Вопрос задаётся здесь и один раз. confirm:'script' — молчим, спросит
    // скрипт; confirm:'self' — спросит сама команда там, где ей нужно.
    if (found.destructive && found.confirm === 'cli' && !globals.yes && !globals.dryRun) {
      const needed = found.confirmWhen ? await found.confirmWhen(ctx) : true
      if (needed) {
        const asked =
          typeof found.confirmQuestion === 'function'
            ? await found.confirmQuestion(ctx)
            : (found.confirmQuestion ?? 'continue?')
        const question = found.rooms === false ? asked : await withRooms(asked)
        if (!(await ui.confirm(question))) return cancelled(ui)
      }
    }

    const code = await found.run(ctx)
    if (!globals.dryRun) {
      // Отдельным полем last: иначе `colloq ps` затирал бы память об аренде,
      // и строка «vast» в status говорила бы про ps.
      env.writeState({
        last: { command: [found.name, ...parsed.positionals].join(' '), code, at: io.now() },
      })
    }
    return code
  }

  /**
   * Неизвестное слово. Цель Makefile с таким именем зовётся только явно, через
   * `colloq make`: молчаливое делегирование обходило вопрос, ради которого
   * обёртка и написана, — `cluster-stop` останавливал писателей без единой
   * строки о цене.
   */
  function unknownOrMake(name: string): number {
    if (name && isMakeTarget(io.readText(env.paths.makefile) ?? '', name)) {
      return report(
        2,
        'no command ' + name,
        'colloq make ' + name + ' — that calls the target directly, without a question',
        'a Makefile target with this name exists, but nothing wraps it',
      )
    }
    return unknown(name)
  }

  function unknown(name: string): number {
    // Голое имя группы — самое естественное, что печатают после help: показать
    // её команды честнее, чем гадать по буквам («vast» → «может быть, test?»).
    // По видимому списку: в поверхности преподавателя «colloq vast» — это не
    // группа, про которую надо рассказать, а слово, которого он не знает.
    const inGroup = shown
      .filter((command) => command.name.startsWith(name + ' '))
      .map((command) => command.name)
    if (inGroup.length > 0) {
      return report(
        2,
        name + ' is a group of commands, not a command',
        'colloq ' + inGroup.join(' · colloq '),
        'the group needs a second word',
      )
    }
    // Тоже по видимому: подсказка — это приглашение напечатать её, и звать
    // ею спрятанную команду нельзя.
    const near = nearest(shown, name)
    return report(
      2,
      'no command ' + name,
      near ? 'did you mean colloq ' + near + '?' : 'colloq help — the list of commands',
    )
  }
}

/** Токены имени команды выбрасываются из хвоста: остальное идёт в parseArgs. */
function dropCommandTokens(input: string[], count: number): string[] {
  const out: string[] = []
  let dropped = 0
  for (const token of input) {
    if (dropped < count && !token.startsWith('-')) {
      dropped++
      continue
    }
    out.push(token)
  }
  return out
}

/** Дефисное имя переписывается двухсловным: хвост и флаги остаются как были. */
export function respell(input: string[], from: string, to: string): string[] {
  const out: string[] = []
  let done = false
  for (const token of input) {
    if (!done && token === from) {
      out.push(...to.split(' '))
      done = true
      continue
    }
    out.push(token)
  }
  return out
}

/**
 * Отказ parseArgs по-русски. Английский текст Node остаётся только там, где
 * своего слова нет: его совет «поставьте после --» для опечатки во флаге ещё и
 * неверен.
 */
export function parseTrouble(error: unknown, command: Command): UsageError {
  const message = error instanceof Error ? error.message : String(error)
  const fix = 'colloq ' + command.name + ' --help'
  if ((error as { code?: string }).code === 'ERR_PARSE_ARGS_UNKNOWN_OPTION') {
    const flag = /'(-[^']+)'/.exec(message)?.[1] ?? ''
    const near = nearestWord(
      command.flags.map((item) => '--' + item.name),
      flag,
    )
    return new UsageError(
      'command ' + command.name + ' has no flag ' + flag,
      near ? 'did you mean ' + near + '? · ' + fix : fix,
    )
  }
  return new UsageError(message, fix)
}

/** Команда по имени или алиасу. */
export function find(commands: Command[], name: string): Command | undefined {
  if (!name) return undefined
  return commands.find((command) => command.name === name || (command.aliases ?? []).includes(name))
}

/** Ближайшее имя: расстояние Левенштейна ≤ 3, одна подсказка. */
export function nearest(commands: Command[], name: string): string | undefined {
  let best: string | undefined
  let bestDistance = 4
  for (const command of commands) {
    for (const candidate of [command.name, ...(command.aliases ?? [])]) {
      const distance = levenshtein(name, candidate)
      if (distance < bestDistance) {
        bestDistance = distance
        best = command.name
      }
    }
  }
  return best
}

/** То же расстояние по списку слов: для флагов команды. */
export function nearestWord(words: string[], name: string): string | undefined {
  let best: string | undefined
  let bestDistance = 4
  for (const word of words) {
    const distance = levenshtein(name, word)
    if (distance < bestDistance) {
      bestDistance = distance
      best = word
    }
  }
  return best
}

export function levenshtein(a: string, b: string): number {
  const rows = a.length + 1
  const cols = b.length + 1
  let previous = Array.from({ length: cols }, (_, i) => i)
  for (let i = 1; i < rows; i++) {
    const current = [i]
    for (let j = 1; j < cols; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1
      current[j] = Math.min(
        (current[j - 1] ?? 0) + 1,
        (previous[j] ?? 0) + 1,
        (previous[j - 1] ?? 0) + cost,
      )
    }
    previous = current
  }
  return previous[cols - 1] ?? Math.max(a.length, b.length)
}

/** Есть ли в Makefile строка `<имя>:`. */
export function isMakeTarget(makefile: string, name: string): boolean {
  if (!/^[a-z][a-z0-9-]*$/.test(name)) return false
  return new RegExp('^' + name + ':', 'm').test(makefile)
}

/** «3 rooms are running» — только уточнение к вопросу. Слово считает ui. */
export function roomsPhrase(count: number): string {
  return roomsWord(count) + (count === 1 ? ' is running' : ' are running')
}

function version(io: Io, packagePath: string): string {
  const text = io.readText(packagePath)
  const match = text ? /"version"\s*:\s*"([^"]+)"/.exec(text) : null
  return match?.[1] ?? '0.0.0'
}

/**
 * Короткая справка голого вызова в поверхности преподавателя.
 *
 * Четыре строки и ни одной лишней: что это такое и три слова, которыми
 * занятие начинают, показывают классу и заканчивают. Ни dev, ни make, ни меню
 * — их в этой поверхности нет вовсе. Полный список так и остаётся за `colloq
 * help`, как у git и jupyter.
 */
export function renderIntro(ui: ReturnType<typeof createUi>): void {
  ui.line(ui.bold('colloq') + ' — a class on this computer: notebooks, a Python kernel and a board')
  ui.line()
  ui.table([
    [ui.cyan('colloq start'), 'start the class and open the browser'],
    [ui.cyan('colloq host <name>'), 'publish it and give the room a link'],
    [ui.cyan('colloq stop'), 'end the class'],
  ])
  ui.line()
  ui.line(ui.dim('More: colloq help · one command: colloq <command> --help'))
}

/**
 * Список команд пятью группами.
 *
 * Сужается поверхностью: у преподавателя показываются только команды с
 * audience:'teacher', и подвал у него свой. Мастерской подвал зовёт в dev,
 * menu и пары make — того, кто поставил пакет, туда звать некуда: ни dev, ни
 * Makefile рядом с ним нет.
 */
export function renderHelp(
  ui: ReturnType<typeof createUi>,
  commands: Command[],
  kernelEnv: string,
  surface: Audience = 'workshop',
): void {
  const shown = visibleIn(commands, surface)
  for (const group of GROUPS) {
    const inGroup = shown.filter((command) => command.group === group.name)
    if (inGroup.length === 0) continue
    ui.header(group.title)
    for (const command of inGroup) {
      ui.line('  ' + ui.cyan(command.name.padEnd(18)) + command.summary)
    }
    ui.line()
  }
  if (surface === 'teacher') {
    ui.line(ui.dim('Most used: colloq start · colloq host <name> · colloq status · colloq stop'))
  } else {
    ui.line(ui.dim('Most used: colloq · colloq run --host <name> · colloq dev · colloq menu'))
  }
  ui.line(ui.dim('Everywhere: --dry-run — show what would run and do nothing · --yes — do not ask'))
  if (surface !== 'teacher') {
    ui.line(ui.dim('Variables for make are written as pairs: colloq backup MODE=consistent'))
  }
  ui.line(ui.dim('Kernel environment now: ' + kernelEnv))
  ui.line(ui.dim('In detail: colloq <command> --help'))
}

/** Помощь по одной команде: назначение, употребление, аргументы, флаги, два примера. */
export function renderCommandHelp(
  ui: ReturnType<typeof createUi>,
  command: Command,
  env: ReturnType<typeof createEnv>,
): void {
  const domain = env.relay().domain || 'hse.colloq.ru'
  const kernel = env.kernelEnv() || 'base'
  const fill = (text: string): string =>
    text.replaceAll('{domain}', domain).replaceAll('{env}', kernel)

  ui.line(command.summary)
  ui.line('Usage: ' + ui.cyan(command.usage))
  if (command.args?.length) {
    ui.line()
    ui.header('Arguments')
    // Обязательный в угловых скобках, необязательный в квадратных — как в usage.
    ui.table(
      command.args.map((arg) => [
        arg.required ? '<' + arg.name + '>' : '[' + arg.name + ']',
        arg.summary + (arg.makeVar ? ' (or ' + arg.makeVar + '=…)' : ''),
      ]),
    )
  }
  ui.line()
  ui.header('Flags')
  ui.table([
    ...command.flags.map((flag) => [
      (flag.short ? '-' + flag.short + ', ' : '') +
        '--' +
        flag.name +
        (flag.arg ? ' <' + flag.arg + '>' : ''),
      flag.summary,
    ]),
    // Общие флаги дописываются здесь, а не в usage каждой команды: иначе одни
    // группы их перечисляют, другие нет, и help читается как пять разных.
    ...globalFlagRows(command),
  ])
  const examples = (command.examples?.length ? command.examples : [command.usage]).map(fill)
  const shown =
    examples.length >= 2
      ? examples.slice(0, 2)
      : [examples[0] ?? '', fill(command.usage) + ' --dry-run']
  ui.line()
  ui.header('Examples')
  ui.table(shown.map((example) => [ui.cyan(example)]))
  if (command.notes) {
    ui.line()
    ui.line(ui.dim(command.notes))
  }
  ui.line()
  ui.line(ui.dim('delegates: ' + command.delegates))
}

/** Общие флаги, которые к этой команде и правда применимы. */
function globalFlagRows(command: Command): string[][] {
  const rows: string[][] = [['--dry-run', 'Show what would run and do nothing']]
  if (command.destructive) rows.push(['-y, --yes', 'Agree in advance, no question will be asked'])
  rows.push(['--no-color', 'No colour: the same output without a single escape'])
  rows.push(['-h, --help', 'This page'])
  return rows
}

/** Меню: две строки состояния, пять групп, сквозная нумерация. */
async function menu(
  ctx: Ctx,
  commands: Command[],
  run: (argv: string[]) => Promise<number>,
): Promise<number> {
  const { ui, env } = ctx
  const status = find(commands, 'status')
  if (status && status.flags.some((flag) => flag.name === 'short')) {
    ctx.positionals = []
    ctx.values = { short: true }
    await status.run(ctx)
  } else {
    ui.kv('port', String(env.port()), 'setup: ' + (await ctx.form()))
    ui.kv('kernel', env.kernelEnv(), 'rooms now: ' + String(await ctx.rooms()))
  }
  ui.line()

  const items: Command[] = []
  for (const group of GROUPS) {
    const inGroup = commands.filter((command) => command.group === group.name)
    if (inGroup.length === 0) continue
    ui.header(group.title)
    for (const command of inGroup) {
      items.push(command)
      const number = String(items.length).padStart(3)
      ui.line('  ' + number + '  ' + command.name.padEnd(18) + ui.dim('colloq ' + command.name))
    }
    ui.line()
  }
  if (items.length === 0) {
    ui.line(ui.dim('no commands yet'))
    return 0
  }
  ui.line(ui.dim('a number and Enter · ↑ ↓ · q — quit'))

  const picked = await pick(ui, items.length)
  // Ctrl+C в сыром режиме приходит байтом, а не сигналом: код тот же 130.
  if (picked === INTERRUPT) return 130
  if (picked === null) return 0
  const command = items[picked - 1]
  if (!command) return 0

  const argv: string[] = command.name.split(' ')
  for (const arg of command.args ?? []) {
    if (!arg.required) continue
    const value = await ui.prompt(arg.name + '?', { default: menuDefault(ctx, command, arg.name) })
    if (!value) return 2
    argv.push(value)
  }
  return await run(argv)
}

/**
 * Умолчание для вопроса меню.
 *
 * Имя последней среды подставляется только туда, где спрашивают имя: адресу
 * IPv4 у `dns point` и машине `root@адрес` у `relay setup` оно не умолчание, а
 * ловушка — Enter увёл бы ssh не туда. Окружение ядра и среда vast — разные
 * миры: в группе «Окружения ядра» умолчание берётся из .env.
 */
function menuDefault(ctx: Ctx, command: Command, argName: string): string {
  const state = ctx.env.readState()
  if (command.group === 'env') return ctx.env.kernelEnv()
  if (/^(name|host|domain|machine|env|environment)$/i.test(argName)) {
    return state.name ?? ctx.env.relay().domain
  }
  return ''
}

/** Ctrl+C в меню: не отказ от выбора, а прерывание — код 130. */
const INTERRUPT = -1

/** Номер пункта: цифры работают всегда, стрелки — если терминал даёт. */
async function pick(ui: ReturnType<typeof createUi>, total: number): Promise<number | null> {
  const stdin = process.stdin
  if (!stdin.isTTY || typeof stdin.setRawMode !== 'function') {
    const answer = await ui.prompt('choice', { default: '' })
    if (answer === '' || answer === 'q') return null
    const number = Number.parseInt(answer, 10)
    return Number.isFinite(number) && number >= 1 && number <= total ? number : null
  }
  return await new Promise<number | null>((resolve) => {
    let typed = ''
    let cursor = 1
    const draw = (): void => {
      const shown = typed === '' ? String(cursor) : typed
      process.stdout.write('\u001b[2K\r' + SYMBOL.next + ' choice [' + shown + '] ')
    }
    const finish = (value: number | null): void => {
      stdin.setRawMode?.(false)
      stdin.pause()
      stdin.off('data', onData)
      process.stdout.write('\n')
      resolve(value)
    }
    const onData = (chunk: Buffer): void => {
      const key = chunk.toString()
      if (key === '\u0003') return finish(INTERRUPT)
      if (key === 'q') return finish(null)
      if (key === '\r' || key === '\n') {
        const number = typed === '' ? cursor : Number.parseInt(typed, 10)
        return finish(Number.isFinite(number) && number >= 1 && number <= total ? number : null)
      }
      if (key === '\u001b[A') {
        cursor = cursor > 1 ? cursor - 1 : total
        typed = ''
      } else if (key === '\u001b[B') {
        cursor = cursor < total ? cursor + 1 : 1
        typed = ''
      } else if (key === '\u007f') {
        typed = typed.slice(0, -1)
      } else if (/^[0-9]+$/.test(key)) {
        typed += key
      }
      draw()
    }
    stdin.setRawMode(true)
    stdin.resume()
    stdin.on('data', onData)
    draw()
  })
}

// Запуск: шим зовёт этот файл напрямую.
const entry = process.argv[1] ?? ''
if (entry.endsWith('/cli/src/main.ts') || entry.endsWith('/cli/src/main.js')) {
  // Без ребёнка действует обычный SIGINT Node. При запуске sh сам пересылает
  // сигнал и ждёт ребёнка: ранний process.exit здесь оставлял его работать.
  const code = await cli(process.argv.slice(2))
  process.exitCode = code
}
