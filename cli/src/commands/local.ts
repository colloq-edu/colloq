/**
 * Локально — всё, что происходит на этой машине.
 *
 * Цели группы: run, stop, restart, up, down, ps, logs, dev, build, ui, test,
 * check, shell, link, docker-gid, backup, restore.
 *
 * Файл правит только агент группы. Реестр, каркас и тесты остальных групп
 * этого файла не касаются; порядок команд здесь — порядок в help и в меню.
 *
 * node:child_process и node:fs импортировать нельзя: только ctx.sh и ctx.io.
 * Иначе тест перестаёт быть герметичным, и это стережёт cli-core.
 *
 * Две вещи, которые здесь делаются одинаково во всех командах:
 *
 *   · значение берётся и флагом, и парой ВИДА=ЗНАЧЕНИЕ (`colloq backup
 *     MODE=consistent` — та же команда, что `--mode consistent`): пары снимает
 *     каркас, и он же добавляет их к вызову make, поэтому свою пару мы шлём
 *     только тогда, когда её не прислал человек, — иначе в строке было бы
 *     `MODE=live MODE=consistent`;
 *   · работа отдаётся цели Makefile целиком. Проверки, которые уже стоят в
 *     рецепте (живой app в docker, занятый порт, чужие серверные процессы),
 *     здесь не повторяются: там они сказаны точнее, и их stderr уходит наружу
 *     как есть.
 */
import type { Command, Ctx } from '../registry.js'
import { cancelled, heading as head, UsageError } from '../ui.js'
import { envNameOk } from '../env.js'
import { quote } from '../sh.js'
import { hostNameOk } from './host.js'
import { leaseUrl } from '../../../shared/local-public-url-lease.js'

/** Свой вопрос: «нет» — это DIM «отменено» и код 4. --yes и --dry-run отвечают «да». */
async function ask(ctx: Ctx, question: string): Promise<boolean> {
  if (await ctx.confirm(question)) return true
  cancelled(ctx.ui)
  return false
}

/** Значение флага или пары ВИДА=ЗНАЧЕНИЕ: пара главнее, её написали руками. */
function value(ctx: Ctx, flag: string, variable: string): string | undefined {
  const pair = ctx.makeVars[variable]
  if (pair !== undefined && pair !== '') return pair
  const raw = ctx.values[flag]
  return typeof raw === 'string' && raw !== '' ? raw : undefined
}

/** Булев флаг или пара ВИДА=1. */
function on(ctx: Ctx, flag: string, variable: string): boolean {
  return ctx.makeVars[variable] === '1' || ctx.values[flag] === true
}

/** Свои пары для make: те, что человек прислал сам, каркас добавит и без нас. */
function mine(
  ctx: Ctx,
  pairs: Record<string, string | undefined>,
): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = {}
  for (const [key, item] of Object.entries(pairs)) {
    if (ctx.makeVars[key] === undefined) out[key] = item
  }
  return out
}

/** Строка вызова make для --dry-run там, где команд две: `make stop && make run`. */
function makeLine(
  ctx: Ctx,
  target: string,
  pairs: Record<string, string | undefined> = {},
): string {
  const args = ['make', target]
  for (const [key, item] of Object.entries(mine(ctx, pairs))) {
    if (item !== undefined && item !== '') args.push(key + '=' + item)
  }
  for (const [key, item] of Object.entries(ctx.makeVars)) args.push(key + '=' + item)
  return args.map(quote).join(' ')
}

/** Имя среды: тем же ситом, что в scripts/backup.sh и scripts/restore.sh (env.envNameOk). */
function checkName(name: string | undefined): void {
  if (name === undefined) return
  if (!envNameOk(name)) {
    throw new UsageError(
      'имя среды «' + name + '» не годится',
      'буквы, цифры и дефис в середине: --name hse',
    )
  }
}

/** Число строк хвоста: только целое и положительное. */
function checkLines(lines: string | undefined): void {
  if (lines === undefined) return
  if (!/^[0-9]+$/.test(lines) || lines === '0') {
    throw new UsageError('строк «' + lines + '» не бывает', 'целое число: colloq logs -n 200')
  }
}

/** Какой журнал смотреть, когда не сказали явно. */
async function logSource(ctx: Ctx): Promise<'server' | 'docker' | 'service'> {
  const form = await ctx.form()
  if (form === 'cluster' || form === 'service') return 'service'
  if (form === 'container') return 'docker'
  if (form === 'host') return 'server'
  return ctx.io.exists(ctx.env.paths.logFile) ? 'server' : 'docker'
}

/** Receipt ownership and process validation remain inside the supervisor. */
function localSession(ctx: Ctx): boolean {
  return ctx.io.exists(ctx.env.path('.colloq/local-session.json'))
}

async function sessionAddress(
  ctx: Ctx,
): Promise<{ local: string; public: string | undefined } | undefined> {
  try {
    const receipt: unknown = JSON.parse(
      ctx.io.readText(ctx.env.path('.colloq/local-session.json')) ?? 'null',
    )
    if (!receipt || typeof receipt !== 'object') return undefined
    const data = receipt as Record<string, unknown>
    if (typeof data.pid !== 'number' || !Number.isSafeInteger(data.pid) || data.pid < 1 ||
        typeof data.runId !== 'string' || typeof data.url !== 'string') return undefined
    const local = new URL(data.url)
    if (local.protocol !== 'http:' || !['localhost', '127.0.0.1', '[::1]'].includes(local.hostname) ||
        local.username || local.password || local.search || local.hash || local.pathname !== '/') return undefined
    const alive = await ctx.sh.capture('kill', ['-0', String(data.pid)], { timeoutMs: 4000 })
    const publicUrl = alive.code === 0 && typeof data.leaseFile === 'string'
      ? leaseUrl(ctx.io.readText(data.leaseFile), data.runId, ctx.io.now()) : undefined
    return { local: data.url, public: publicUrl }
  } catch {
    return undefined
  }
}

function checkLaunch(ctx: Ctx): void {
  const port = value(ctx, 'port', 'PORT')
  if ((ctx.values.port !== undefined && port === undefined) ||
      (port !== undefined && (!/^[0-9]+$/.test(port) || Number(port) < 1 || Number(port) > 65535))) {
    throw new UsageError('порт должен быть целым числом от 1 до 65535', 'colloq run --port 3000')
  }
  const host = value(ctx, 'host', 'HOST')
  if ((ctx.values.host !== undefined && host === undefined) || (host !== undefined && !hostNameOk(host))) {
    throw new UsageError('имя туннеля не годится', 'colloq run --host hse.colloq.ru')
  }
}

async function launch(ctx: Ctx, command: 'run' | 'dev' | 'stop' | 'restart'): Promise<number> {
  const args = ['--import', 'tsx', ctx.env.path('cli/src/launch.ts'), command]
  if (command === 'run') {
    const host = value(ctx, 'host', 'HOST')
    if (host) args.push('--host', host)
    if (on(ctx, 'detach', 'DETACH')) args.push('--detach')
  }
  if (command === 'run' || command === 'dev') {
    const port = value(ctx, 'port', 'PORT')
    if (port) args.push('--port', port)
    if (ctx.values['no-open'] === true || ctx.makeVars.OPEN === '0') args.push('--no-open')
  }
  if (command === 'restart' && ctx.values.build === true) args.push('--build')
  if (command !== 'stop' && on(ctx, 'fast', 'FAST')) args.push('--fast')
  const consumed = new Set(['HOST', 'DETACH', 'PORT', 'OPEN', 'FAST'])
  const env = Object.fromEntries(Object.entries(ctx.makeVars).filter(([key]) => !consumed.has(key)))
  return await ctx.sh.run('node', args, Object.keys(env).length ? { env } : {})
}

export const commands: Command[] = [
  {
    name: 'run',
    aliases: ['start'],
    group: 'local',
    summary: 'Запустить локальную сессию в терминале и открыть браузер',
    usage: 'colloq run [--host <имя>] [--detach] [--port <порт>] [--no-open] [--fast]',
    flags: [
      { name: 'host', arg: 'имя', summary: 'Опубликовать сессию через принадлежащий ей туннель (HOST=…)' },
      { name: 'detach', summary: 'Оставить сессию в фоне (DETACH=1)' },
      { name: 'port', arg: 'порт', summary: 'Порт локального сервера (PORT=…)' },
      { name: 'no-open', summary: 'Не открывать браузер (OPEN=0)' },
      { name: 'fast', summary: 'Собирать без предварительного сжатия фронтенда (FAST=1)' },
    ],
    destructive: false,
    check: checkLaunch,
    delegates: 'node --import tsx cli/src/launch.ts run',
    examples: ['colloq', 'colloq run --host hse.colloq.ru'],
    notes:
      'Без аргументов colloq делает то же, что run. Журналы остаются в терминале; Ctrl+C завершает сессию, её туннель и ядра этой базы, сохраняя файлы и данные. Занятый сервер не перезапускается. --detach оставляет сессию в фоне; colloq stop завершает её. Для прежнего меню есть colloq menu.',
    async run(ctx) {
      head(ctx, 'запускаю локальную сессию')
      return await launch(ctx, 'run')
    },
  },
  {
    name: 'stop',
    group: 'local',
    summary: 'Завершить локальную сессию, её туннель и ядра этой базы',
    usage: 'colloq stop',
    flags: [],
    destructive: true,
    confirm: 'cli',
    confirmQuestion: 'остановить сервер?',
    delegates: 'node --import tsx cli/src/launch.ts stop; без расписки сессии — make stop',
    examples: ['colloq stop', 'colloq stop --yes'],
    notes:
      'Для .colloq/local-session.json супервизор завершает принадлежащие ему процессы и ядра своей базы. Файлы и база сохраняются. Без новой расписки используется прежний make stop.',
    async run(ctx) {
      head(ctx, 'останавливаю сервер')
      return localSession(ctx) ? await launch(ctx, 'stop') : await ctx.sh.make('stop')
    },
  },
  {
    name: 'restart',
    group: 'local',
    summary: 'Перезапустить ту форму, которая сейчас работает',
    usage: 'colloq restart [--build] [--fast]',
    flags: [
      { name: 'build', summary: 'Пересобрать фронтенд перед перезапуском' },
      { name: 'fast', summary: 'С --build собирать без сжатия' },
    ],
    destructive: true,
    confirm: 'self',
    delegates:
      'сессия → супервизор restart; контейнер → make restart · служба → make service-restart · хост → make stop, make run',
    examples: ['colloq restart', 'colloq restart --build'],
    notes:
      'Новая расписка сессии направляет к супервизору. Для прежних запусков форма определяется тем же порядком, что в scripts/host.sh: COLLOQ_CLUSTER=1 → кластер, служба, контейнер app, живая расписка .colloq.pid. Порядок менять нельзя: pid-файл говорит о прошлом. Голый docker compose restart не зовём никогда — он перезапускает и kernel, а это Python-состояние всех комнат. Кластер сюда не ходит: colloq cluster stop · colloq cluster start.',
    async run(ctx) {
      if (localSession(ctx)) {
        if (!ctx.dryRun && !(await ask(ctx, 'перезапустить локальную сессию?'))) return 4
        return await launch(ctx, 'restart')
      }
      const form = await ctx.form()
      if (form === 'cluster') {
        ctx.ui.refuse(
          'это кластер k3s',
          'мягкого перезапуска у него не бывает',
          'colloq cluster stop · colloq cluster start',
        )
        return 3
      }
      const fast = on(ctx, 'fast', 'FAST')
      const build = ctx.values.build === true
      const script = fast ? 'build' : 'build:optimized'

      if (ctx.dryRun) {
        const parts: string[] = []
        if (build) parts.push('npm run ' + script)
        if (form === 'service') parts.push(makeLine(ctx, 'service-restart'))
        else if (form === 'host') {
          parts.push(makeLine(ctx, 'stop'))
          parts.push(makeLine(ctx, 'run', { FAST: fast ? '1' : undefined }))
        } else parts.push(makeLine(ctx, 'restart'))
        return ctx.sh.dry(parts.join(' && '))
      }

      const question = build
        ? 'пересобрать панель и перезапустить? web/dist меняется на лету'
        : 'перезапустить сервер?'
      if (!(await ask(ctx, question))) return 4

      if (build) {
        head(ctx, fast ? 'собираю панель без сжатия' : 'собираю панель со сжатием')
        const built = await ctx.sh.npm(script)
        if (built !== 0) return built
      }
      if (form === 'service') {
        head(ctx, 'перезапускаю службу')
        return await ctx.sh.make('service-restart')
      }
      if (form === 'host') {
        head(ctx, 'перезапускаю сервер на хосте')
        const stopped = await ctx.sh.make('stop')
        if (stopped !== 0) return stopped
        return await ctx.sh.make('run', mine(ctx, { FAST: fast ? '1' : undefined }))
      }
      head(ctx, 'перезапускаю app в docker')
      return await ctx.sh.make('restart')
    },
  },
  {
    name: 'up',
    group: 'local',
    summary: 'Поднять весь стек в docker: приложение и ядро',
    usage: 'colloq up',
    flags: [],
    destructive: true,
    confirm: 'cli',
    confirmQuestion: 'пересоздать app в docker?',
    delegates: 'make up',
    examples: ['colloq up', 'colloq up --yes'],
    notes:
      'Тянет за собой .env, dirs и docker-gid, пересоздаёт контейнер app и печатает http://localhost:<PORT>. Сервер на хосте (colloq run) и app в docker — это два Colloq на одном порту.',
    async run(ctx) {
      head(ctx, 'поднимаю стек в docker')
      return await ctx.sh.make('up')
    },
  },
  {
    name: 'down',
    group: 'local',
    summary: 'Остановить всё в docker (данные и файлы остаются)',
    usage: 'colloq down',
    flags: [],
    destructive: true,
    confirm: 'cli',
    confirmQuestion: 'остановить всё в docker?',
    delegates: 'make down',
    examples: ['colloq down', 'colloq down --yes'],
    notes:
      'Самая опасная из локальных: сначала убираются все контейнеры комнат (label colloq.kind=room-kernel), и только потом compose down — иначе сеть compose с чужими контейнерами внутри не удаляется. В контейнерах комнат лежит Python-состояние идущей пары, поэтому вопрос называет их число. Сервер под службой это не трогает, make down скажет об этом сам.',
    async run(ctx) {
      head(ctx, 'останавливаю всё в docker')
      return await ctx.sh.make('down')
    },
  },
  {
    name: 'ps',
    aliases: ['containers'],
    group: 'local',
    summary: 'Что запущено в docker: compose, ядра комнат, окружение',
    usage: 'colloq ps',
    flags: [],
    destructive: false,
    delegates: 'make status (он же make ps)',
    examples: ['colloq ps', 'colloq ps --dry-run'],
    notes:
      'Это докерный взгляд. Обзор всей машины — colloq status, и он без сети и без compose. Имена не сталкиваются: здесь ps не алиас status, в отличие от Makefile.',
    async run(ctx) {
      return await ctx.sh.make('status')
    },
  },
  {
    name: 'logs',
    aliases: ['log'],
    group: 'local',
    summary: 'Смотреть журнал той формы, которая работает',
    usage: 'colloq logs [-f|--no-follow] [-n <строк>] [--server|--docker|--service]',
    flags: [
      { name: 'follow', short: 'f', summary: 'Следить (включено по умолчанию)' },
      { name: 'no-follow', summary: 'Показать хвост и выйти' },
      { name: 'lines', short: 'n', arg: 'строк', summary: 'Сколько строк хвоста' },
      { name: 'server', summary: 'Журнал сервера на хосте — .colloq.log' },
      { name: 'docker', summary: 'Журнал docker compose' },
      { name: 'service', summary: 'Журнал службы' },
    ],
    destructive: false,
    delegates: 'make logs-run · make logs · make service-logs',
    examples: ['colloq logs', 'colloq logs --docker -n 200'],
    notes:
      'Без флага форма определяется тем же порядком, что у restart. .colloq.log дописывается и никогда не обрезается — история прошлых недель это улика, tail только читает. В журнале лежат ссылки /admin/t/<токен>: CLI из потока ничего не вырезает и не пересказывает, но и сам токен не печатает никогда. У службы журнал ведёт journalctl: -n и --no-follow до него не доходят.',
    async run(ctx) {
      const picked = (['server', 'docker', 'service'] as const).filter(
        (name) => ctx.values[name] === true,
      )
      if (picked.length > 1) {
        throw new UsageError(
          'сразу ' + picked.map((name) => '--' + name).join(' и ') + ' не бывает',
          'журнал один: colloq logs --docker',
        )
      }
      if (ctx.values.follow === true && ctx.values['no-follow'] === true) {
        throw new UsageError(
          '-f и --no-follow вместе не работают',
          'следить — -f, показать хвост и выйти — --no-follow',
        )
      }
      const follow = ctx.values['no-follow'] !== true
      const lines = value(ctx, 'lines', 'LINES')
      checkLines(lines)
      const source = picked[0] ?? (await logSource(ctx))

      if (source === 'service') {
        head(ctx, 'журнал службы')
        return await ctx.sh.make('service-logs')
      }
      if (source === 'docker') {
        head(ctx, 'журнал docker compose')
        if (follow && lines === undefined) return await ctx.sh.make('logs')
        const args = ['compose', 'logs']
        if (follow) args.push('-f')
        args.push('--tail=' + (lines ?? '80'))
        return await ctx.sh.run('docker', args)
      }
      if (!ctx.dryRun && !ctx.io.exists(ctx.env.paths.logFile)) {
        ctx.ui.refuse(
          'нет .colloq.log',
          'сервер этой машины через colloq run ещё не запускали',
          'colloq run · журнал docker: colloq logs --docker',
        )
        return 3
      }
      head(ctx, 'журнал сервера на хосте')
      if (follow && lines === undefined) return await ctx.sh.make('logs-run')
      const args: string[] = []
      if (follow) args.push('-f')
      if (lines !== undefined) args.push('-n', lines)
      args.push(ctx.env.paths.logFile)
      return await ctx.sh.run('tail', args)
    },
  },
  {
    name: 'dev',
    group: 'local',
    summary: 'Запустить сервер с перезагрузкой и Vite в одной сессии',
    usage: 'colloq dev [--port <порт>] [--no-open]',
    flags: [
      { name: 'port', arg: 'порт', summary: 'Порт браузера и Vite (PORT=… в аргументах)' },
      { name: 'no-open', summary: 'Не открывать браузер (OPEN=0)' },
    ],
    destructive: false,
    check: checkLaunch,
    delegates: 'node --import tsx cli/src/launch.ts dev',
    examples: ['colloq dev', 'colloq dev --port 4000 --no-open'],
    notes:
      'Сервер с наблюдением за исходниками и Vite работают до Ctrl+C. Перезагрузки сервера сохраняют ядра комнат; окончание сессии завершает ядра этой базы. Файлы и база сохраняются.',
    async run(ctx) {
      head(ctx, 'запускаю сервер и Vite для разработки')
      return await launch(ctx, 'dev')
    },
  },
  {
    name: 'build',
    group: 'local',
    summary: 'Собрать фронтенд и сервер',
    usage: 'colloq build [--fast]',
    flags: [{ name: 'fast', summary: 'Без предварительного сжатия' }],
    destructive: false,
    confirm: 'self',
    delegates: 'npm run build:optimized (с --fast — npm run build)',
    examples: ['colloq build', 'colloq build --fast'],
    notes:
      'Спрашивает, только если сервер жив: web/dist отдаётся живьём через STATIC_DIR, и пересборка под идущей парой меняет ассеты на лету. Сжатие по умолчанию не зря: без .br рядом с assets/ сервер сжимает каждый файл на каждый запрос — 11.6 мс процессора и 25 КБ на студента за файл.',
    async run(ctx) {
      const fast = on(ctx, 'fast', 'FAST')
      if (!ctx.dryRun && !ctx.yes && (await ctx.serverAlive())) {
        if (!(await ask(ctx, 'пересобрать панель, пока сервер работает? ассеты меняются на лету')))
          return 4
      }
      head(ctx, fast ? 'собираю панель без сжатия' : 'собираю панель со сжатием')
      return await ctx.sh.npm(fast ? 'build' : 'build:optimized')
    },
  },
  {
    name: 'ui',
    group: 'local',
    summary: 'Проверить интерфейс настоящим браузером',
    usage: 'colloq ui [--headed]',
    flags: [{ name: 'headed', summary: 'С видимым окном' }],
    destructive: false,
    confirm: 'self',
    delegates: 'make ui [HEADED=1]',
    examples: ['colloq ui', 'colloq ui --headed'],
    notes:
      'Спрашивает так же, как build: make ui сначала пересобирает web/dist, значит на машине, где идёт пара, он небезопасен. Свой сервер на 3891 (CDP 9334), свой DATA_DIR, KERNEL_BACKEND=test — чужую базу проверка не трогает.',
    async run(ctx) {
      if (!ctx.dryRun && !ctx.yes && (await ctx.serverAlive())) {
        if (
          !(await ask(ctx, 'проверить интерфейс, пока сервер работает? web/dist пересоберётся'))
        ) {
          return 4
        }
      }
      head(ctx, 'проверяю интерфейс браузером')
      return await ctx.sh.make(
        'ui',
        mine(ctx, { HEADED: on(ctx, 'headed', 'HEADED') ? '1' : undefined }),
      )
    },
  },
  {
    name: 'test',
    group: 'local',
    summary: 'Прогнать тесты',
    usage: 'colloq test [шаблон]',
    args: [{ name: 'шаблон', summary: 'Кусок имени файла: council, cli, shell' }],
    flags: [],
    destructive: false,
    delegates: 'make test · node --import tsx --test tests/*<шаблон>*.test.mts',
    examples: ['colloq test', 'colloq test council'],
    notes:
      'Шаблон — кусок имени файла, а не регулярное выражение: он ищется в именах tests/*.test.mts. --test-force-exit и --test-concurrency=1 повторяются один в один из корневого npm test, иначе сюита ведёт себя не так, как в CI.',
    async run(ctx) {
      const pattern = ctx.positionals[0]
      if (pattern === undefined) {
        head(ctx, 'прогоняю тесты')
        return await ctx.sh.make('test')
      }
      if (pattern.includes('/') || pattern.startsWith('-')) {
        throw new UsageError(
          'шаблон «' + pattern + '» не годится',
          'это кусок имени файла, без каталога: colloq test council',
        )
      }
      const names = ctx.io
        .list(ctx.env.path('tests'))
        .filter((name) => name.endsWith('.test.mts') && name.includes(pattern))
      if (names.length === 0) {
        ctx.ui.refuse(
          'нет тестов по шаблону «' + pattern + '»',
          'искали tests/*' + pattern + '*.test.mts',
          'посмотреть, что есть: ls tests',
        )
        return 1
      }
      head(ctx, 'прогоняю тесты: файлов ' + String(names.length))
      return await ctx.sh.run('node', [
        '--import',
        'tsx',
        '--import',
        './tests/_cli.mts',
        '--test',
        '--test-force-exit',
        '--test-concurrency=1',
        ...names.map((name) => 'tests/' + name),
      ])
    },
  },
  {
    name: 'check',
    group: 'local',
    summary: 'Прогнать тесты и проверку типов',
    usage: 'colloq check',
    flags: [],
    destructive: false,
    delegates: 'make check',
    examples: ['colloq check', 'colloq check --dry-run'],
    notes: 'npm test && npm run typecheck; проверка типов корня включает и @colloq/cli.',
    async run(ctx) {
      head(ctx, 'прогоняю тесты и проверку типов')
      return await ctx.sh.make('check')
    },
  },
  {
    name: 'shell',
    group: 'local',
    summary: 'Открыть оболочку в ядре — посмотреть, что там стоит',
    usage: 'colloq shell',
    flags: [],
    destructive: false,
    delegates: 'make shell',
    examples: ['colloq shell', 'colloq shell --dry-run'],
    notes:
      'Интерактивно: ввод и вывод идут в терминал как есть. Общего ядра compose на машине под службой нет вовсе — make shell сам откроет одноразовый контейнер colloq-kernel:<окружение>. Что доставили руками в работающую комнату, видно только в самой комнате, терминалом.',
    async run(ctx) {
      head(ctx, 'открываю оболочку в ядре: ' + ctx.env.kernelEnv())
      return await ctx.sh.make('shell')
    },
  },
  {
    name: 'link',
    group: 'local',
    summary: 'Показать адрес семинара и где искать вход в панель',
    usage: 'colloq link',
    flags: [],
    destructive: false,
    delegates: 'native: читает расписку сессии, временный адрес и .env',
    examples: ['colloq link', 'colloq link --dry-run'],
    notes:
      'Токен установки не печатается никогда — ни из data/setup-token, ни из журнала: ссылка /admin/t/<токен> это ключ ко всему инстансу.',
    async run(ctx) {
      if (ctx.dryRun) {
        return ctx.sh.dry('native: link (читает расписку сессии, временный адрес и .env)')
      }
      const session = await sessionAddress(ctx)
      if (!session && !ctx.io.exists(ctx.env.paths.envFile)) {
        ctx.ui.refuse(
          'нет .env',
          'адрес семинара берётся оттуда',
          'его заведёт первый же запуск: colloq run',
        )
        return 3
      }
      const url = session ? session.public ?? session.local : ctx.env.publicUrl()
      const inside =
        (session !== undefined && session.public === undefined) || url === '' || /^https?:\/\/(127\.0\.0\.1|localhost|0\.0\.0\.0)([:/]|$)/.test(url)
      ctx.ui.header('Семинар')
      if (session) ctx.ui.kv('локально', session.local)
      if (inside) {
        ctx.ui.kv('адрес', 'наружу не выставлен', url === '' ? undefined : url)
        ctx.ui.hint('colloq host <имя> — выставить наружу и получить ссылку для аудитории')
      } else {
        ctx.ui.kv('адрес', ctx.ui.cyan(url))
      }
      const domain = ctx.env.relay().domain
      if (domain !== '') ctx.ui.kv('домен', domain)
      ctx.ui.kv('вход', 'печатался один раз при запуске')
      ctx.ui.hint('он в .colloq.log; на машине — в data/setup-token. Сам токен CLI не печатает')
      return 0
    },
  },
  {
    name: 'docker-gid',
    group: 'local',
    summary: 'Записать в .env группу сокета docker — чтобы у каждой комнаты было своё ядро',
    usage: 'colloq docker-gid',
    flags: [],
    destructive: true,
    confirm: 'cli',
    confirmWhen: async (ctx) => !ctx.env.has('DOCKER_GID'),
    confirmQuestion: 'дописать DOCKER_GID в .env?',
    delegates: 'make docker-gid',
    examples: ['colloq docker-gid', 'colloq docker-gid --yes'],
    notes:
      'Единственная запись в .env, которую затевает CLI, и делает её сам make: строка дописывается, только если её там нет. Без неё сервер не достучится до docker, и комнаты поделят одно ядро. Чтобы спросить gid у демона, может подняться крошечный контейнер busybox.',
    async run(ctx) {
      head(ctx, 'спрашиваю группу сокета docker')
      return await ctx.sh.make('docker-gid')
    },
  },
  {
    name: 'backup',
    group: 'local',
    summary: 'Снять копию: переносимую k3s или локальную старого формата',
    usage:
      'colloq backup [--legacy] [--mode <live|consistent>] [--resume] [--name <среда>] [--out <путь>] [--release <путь>]',
    flags: [
      { name: 'legacy', summary: 'Локальная пара .db и -files.tar.gz' },
      { name: 'mode', arg: 'режим', summary: 'live (умолчание) или consistent' },
      { name: 'resume', summary: 'После consistent снова запустить писателей' },
      { name: 'name', arg: 'среда', summary: 'Копия среды: в backups/<среда>/' },
      { name: 'out', arg: 'путь', summary: 'Куда положить архив' },
      { name: 'release', arg: 'путь', summary: 'Какой релиз считать установленным' },
    ],
    destructive: true,
    confirm: 'self',
    delegates: 'make backup MODE=… · make backup-legacy',
    examples: ['colloq backup', 'colloq backup --mode consistent --resume'],
    notes:
      'Вопрос задаётся только при --mode consistent: он останавливает app, брокер и все комнаты и нарочно оставляет их стоять — поднимает их только --resume, и неудачная копия тоже оставляет писателей лежать. backup.sh перезапускает себя под scripts/state-lock.py и откажет, пока лежит .restore-in-progress; без установленного релиза он сам отправит в --legacy. --legacy делает VACUUM INTO (нужен sqlite3) и архив с workspace, data/session-secret, data/setup-token и списками окружений, оба файла 0600; код 1 у tar — «файл менялся при чтении», это идущая пара, и он допустим. Копии этой машины лежат в корне backups/, копии сред — в backups/<среда>/.',
    async run(ctx) {
      const legacy = ctx.values.legacy === true
      const mode = value(ctx, 'mode', 'MODE') ?? 'live'
      const resume = on(ctx, 'resume', 'RESUME')
      const name = value(ctx, 'name', 'NAME')
      const out = value(ctx, 'out', 'OUT')
      const release = value(ctx, 'release', 'RELEASE')

      if (legacy) {
        const extra = [
          ['--mode', value(ctx, 'mode', 'MODE') !== undefined],
          ['--resume', resume],
          ['--out', out !== undefined],
          ['--release', release !== undefined],
          ['--name', name !== undefined],
        ] as const
        const used = extra.filter(([, given]) => given).map(([flag]) => flag)
        if (used.length > 0) {
          throw new UsageError(
            'с --legacy ' + used.join(' и ') + ' не работает',
            'локальная копия всегда одна и та же пара в backups/: colloq backup --legacy',
          )
        }
        head(ctx, 'снимаю локальную копию: база и файлы')
        return await ctx.sh.make('backup-legacy')
      }

      if (mode !== 'live' && mode !== 'consistent') {
        throw new UsageError(
          'режима «' + mode + '» не бывает',
          'бывает --mode live или --mode consistent',
        )
      }
      if (resume && mode !== 'consistent') {
        throw new UsageError(
          '--resume имеет смысл только с --mode consistent',
          'live никого не останавливает, поднимать некого',
        )
      }
      checkName(name)

      if (mode === 'consistent') {
        const tail = resume ? '' : ' без --resume они останутся стоять'
        if (!(await ask(ctx, 'остановить всех писателей?' + tail))) return 4
      }
      head(ctx, mode === 'consistent' ? 'снимаю согласованную копию' : 'снимаю копию на ходу')
      return await ctx.sh.make(
        'backup',
        mine(ctx, {
          MODE: mode,
          RESUME: resume ? '1' : undefined,
          NAME: name,
          OUT: out === undefined ? undefined : ctx.env.userPath(out),
          RELEASE: release === undefined ? undefined : ctx.env.userPath(release),
        }),
      )
    },
  },
  {
    name: 'restore',
    group: 'local',
    summary: 'Развернуть копию: переносимую k3s или локальную старого формата',
    usage:
      'colloq restore --archive <файл> --release <файл> [--replace] [--recover] [--name <среда>] | colloq restore --legacy --db <файл> [--files <архив>] [--name <среда>] [--replace]',
    flags: [
      { name: 'archive', arg: 'файл', summary: 'Переносимая копия .tar.gz' },
      { name: 'release', arg: 'файл', summary: 'release.json того же поколения' },
      { name: 'legacy', summary: 'Локальная пара старого формата' },
      { name: 'db', arg: 'файл', summary: 'База из локальной копии' },
      { name: 'files', arg: 'архив', summary: 'Файлы семинаров из локальной копии' },
      { name: 'name', arg: 'среда', summary: 'Копия среды: из backups/<среда>/' },
      {
        name: 'replace',
        summary: 'REPLACE=1: разворачивать поверх нынешней базы (--yes этого не даёт)',
      },
      { name: 'recover', summary: 'Долечить прерванное восстановление' },
    ],
    destructive: true,
    confirm: 'self',
    delegates: 'make restore ARCHIVE=… RELEASE=… · make restore-legacy DB=… FILES=…',
    examples: [
      'colloq restore --archive backups/{env}/colloq-20260914.tar.gz --release release.json',
      'colloq restore --legacy --db backups/colloq-20260914.db --files backups/colloq-20260914-files.tar.gz',
    ],
    notes:
      'Переносимый путь не спрашивает ничего сам — спрашиваем мы; локальный спрашивает сам (scripts/restore.sh), и второй раз мы не переспрашиваем. Смешивать миры нельзя: restore.sh отвергает наложение старой пары, как только установлен релиз k3s. Локальный путь откажет, если активна служба colloq, работает compose app, жив .colloq.pid или кто-то отвечает на localhost:<PORT>. WAL и SHM уезжают вместе со своей базой, старая база откладывается в data/colloq.db.replaced-<штамп>, файлы архива ложатся поверх workspace/ без копии. Относительные пути считаются от каталога, откуда позвали.',
    async run(ctx) {
      const legacy = ctx.values.legacy === true
      const archive = value(ctx, 'archive', 'ARCHIVE')
      const release = value(ctx, 'release', 'RELEASE')
      const db = value(ctx, 'db', 'DB')
      const files = value(ctx, 'files', 'FILES')
      const name = value(ctx, 'name', 'NAME')
      const recover = on(ctx, 'recover', 'RECOVER')
      // --yes снимает наш вопрос, и только его. REPLACE=1 — это разрешение
      // положить копию поверх живой базы и поверх workspace/, и называют его
      // отдельно: --replace или REPLACE=1.
      const replace = on(ctx, 'replace', 'REPLACE')
      checkName(name)

      const missing = (path: string, what: string): number => {
        ctx.ui.refuse(
          'нет файла ' + path,
          what,
          'посмотреть, что снято: ls backups' + (name === undefined ? '' : '/' + name),
        )
        return 3
      }

      if (legacy || db !== undefined || files !== undefined) {
        const wrong = [
          ['--archive', archive !== undefined],
          ['--release', release !== undefined],
          ['--recover', recover],
        ] as const
        const used = wrong.filter(([, given]) => given).map(([flag]) => flag)
        if (used.length > 0) {
          throw new UsageError(
            'копия старого формата и переносимая — разные миры: ' +
              used.join(' и ') +
              ' тут лишний',
            'k3s: colloq restore --archive … --release …',
          )
        }
        if (db === undefined) {
          throw new UsageError(
            'нет --db <файл>',
            'Употребление: colloq restore --legacy --db backups/colloq-….db [--files backups/colloq-…-files.tar.gz]',
          )
        }
        const dbPath = ctx.env.userPath(db)
        const filesPath = files === undefined ? undefined : ctx.env.userPath(files)
        if (!ctx.dryRun) {
          if (!ctx.io.exists(dbPath)) return missing(dbPath, 'разворачивать нечего')
          if (filesPath !== undefined && !ctx.io.exists(filesPath)) {
            return missing(filesPath, 'в архиве лежат файлы семинаров и ключи инстанса')
          }
        }
        // Второй вопрос подряд перестают читать: здесь спрашивает сам скрипт.
        head(ctx, 'разворачиваю копию старого формата')
        return await ctx.sh.make(
          'restore-legacy',
          mine(ctx, {
            DB: dbPath,
            FILES: filesPath,
            NAME: name,
            REPLACE: replace ? '1' : undefined,
          }),
        )
      }

      if (archive === undefined || release === undefined) {
        const what = archive === undefined ? '--archive <файл>' : '--release <файл>'
        throw new UsageError(
          'нет ' + what,
          'переносимой копии нужны оба: colloq restore --archive копия.tar.gz --release release.json',
        )
      }
      const archivePath = ctx.env.userPath(archive)
      const releasePath = ctx.env.userPath(release)
      if (!ctx.dryRun) {
        if (!ctx.io.exists(archivePath)) return missing(archivePath, 'разворачивать нечего')
        if (!ctx.io.exists(releasePath)) {
          return missing(releasePath, 'без release.json поколение копии не проверить')
        }
        if (
          !(await ask(
            ctx,
            'развернуть поверх? кластер будет остановлен, писатели останутся стоять',
          ))
        ) {
          return 4
        }
      }
      head(ctx, 'разворачиваю переносимую копию')
      return await ctx.sh.make(
        'restore',
        mine(ctx, {
          ARCHIVE: archivePath,
          RELEASE: releasePath,
          REPLACE: replace ? '1' : undefined,
          RECOVER: recover ? '1' : undefined,
          NAME: name,
        }),
      )
    },
  },
]
