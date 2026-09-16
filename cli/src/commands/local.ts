/**
 * Локально — всё, что происходит на этой машине.
 *
 * Цели группы: run, stop, restart, up, down, ps, logs, dev, build, ui, test,
 * check, shell, link, docker-gid, backup, restore.
 *
 * В поверхности преподавателя (COLLOQ_SURFACE=teacher) из них видны семь:
 * run (он же start), stop, restart, logs, link, backup, restore — то, из чего
 * состоит занятие на своём ноутбуке. Остальные — up, down, ps, dev, build, ui,
 * test, check, shell, docker-gid — мастерская: docker-стек, сборка, тесты и
 * оболочка в ядре имеют смысл только рядом с исходниками. Ничего не удалено:
 * спрятанная команда работает по точному имени и в той поверхности тоже.
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
import { cancelled, countWord, heading as head, UsageError } from '../ui.js'
import { envNameOk, joinPath } from '../env.js'
import { readSession, type Session } from '../session.js'
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

/**
 * Где лежат данные занятия — явной переменной окружения для make и скриптов.
 *
 * scripts/backup.sh и scripts/restore.sh делают cd к себе и берут data/ с
 * workspace/ от каталога ПРИЛОЖЕНИЯ, складывая архив в <app>/backups. Пока
 * корень был один, это и был каталог состояния; у установленного colloq там
 * нет ни базы, ни файлов занятий — копия снялась бы с пустого места, а
 * восстановление легло бы мимо настоящей базы, и обе беды тихие.
 *
 * Поэтому корень состояния называем сами и всегда, а не только в пакете: в
 * репозитории home и есть корень, и строка ничего не меняет — зато нет второй
 * развилки, которую надо не забыть повторить в третьей команде.
 */
function stateEnv(ctx: Ctx): { env: Record<string, string> } {
  return { env: { COLLOQ_HOME: ctx.env.paths.home } }
}

/**
 * Чем снимать и разворачивать копию: целью Makefile или самим скриптом.
 *
 * Все четыре цели — backup, backup-legacy, restore, restore-legacy — это
 * обёртки в одну-две строки над scripts/backup.sh, scripts/backup-local.sh и
 * scripts/restore.sh. В репозитории пусть так и остаётся: цели зовут руками, и
 * обходить их значило бы завести второе описание того же — ровно об этом
 * host.ts · publishCall и env.ts · env build.
 *
 * У поставленного пакета make звать нечем: Makefile в колесо не едет и не
 * поедет. `colloq backup --dry-run` из колеса печатал `make backup MODE=live`
 * — команду, которая там умирает кодом 127, и это единственный способ унести
 * занятие с машины. Проверено живьём. Скрипты при этом лежат рядом
 * (scripts/pack.mts довозит scripts/), поэтому в дистрибутиве зовём их
 * напрямую и тем же, чем их позвала бы цель.
 *
 * Пары, написанные человеком (NAME=hse), уходят ребёнку окружением: make
 * экспортирует переменные командной строки в рецепт, и без этого прямой вызов
 * вёл бы себя иначе, чем цель. Имена из asArgs — исключение: их цель отдаёт
 * скрипту аргументом, и в окружении им делать нечего.
 */
function copyCall(
  ctx: Ctx,
  target: string,
  script: string,
  vars: Record<string, string | undefined> = {},
  args: string[] = [],
  asArgs: string[] = [],
): Promise<number> {
  if (!ctx.dist) return ctx.sh.make(target, mine(ctx, vars), stateEnv(ctx))
  const env: Record<string, string> = { ...stateEnv(ctx).env }
  for (const [key, item] of Object.entries(ctx.makeVars)) {
    if (!asArgs.includes(key)) env[key] = item
  }
  for (const [key, item] of Object.entries(vars)) {
    if (item !== undefined && item !== '' && !asArgs.includes(key)) env[key] = item
  }
  return ctx.sh.script(script, args, { env })
}

/** Имя среды: тем же ситом, что в scripts/backup.sh и scripts/restore.sh (env.envNameOk). */
function checkName(name: string | undefined): void {
  if (name === undefined) return
  if (!envNameOk(name)) {
    throw new UsageError(
      'environment name "' + name + '" is not valid',
      'letters, digits and a hyphen in the middle: --name hse',
    )
  }
}

/** Число строк хвоста: только целое и положительное. */
function checkLines(lines: string | undefined): void {
  if (lines === undefined) return
  if (!/^[0-9]+$/.test(lines) || lines === '0') {
    throw new UsageError(
      '"' + lines + '" is not a number of lines',
      'a whole number: colloq logs -n 200',
    )
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

/**
 * Расписка идущего занятия — или null, если занятия нет.
 *
 * Путь один: ctx.env.paths.sessionFile, посчитанный от каталога СОСТОЯНИЯ.
 * Здесь стояло ctx.env.path('.colloq/local-session.json') — то есть от каталога
 * ПРИЛОЖЕНИЯ, — и у установленного colloq это расходилось молча: супервизор
 * пишет расписку в ~/.colloq, а stop, restart и link искали её в site-packages
 * и не находили. Проверено живьём: под работающим сервером `colloq stop`
 * отвечал «занятие не идёт — останавливать нечего».
 *
 * Разбор тоже не свой: readSession один на всех читателей расписки (link,
 * status, doctor). Вторая копия проверок разошлась бы с ними на первой же
 * правке формата — ровно так и разъехались когда-то пути.
 *
 * Чего здесь нет — живости pid: session.ts к процессам намеренно не ходит, и
 * спрашивает о ней тот, кому она нужна (sessionAddress ниже, через ctx.sh).
 */
function localSession(ctx: Ctx): Session | null {
  return readSession(ctx.io, ctx.env.paths.sessionFile)
}

async function sessionAddress(
  ctx: Ctx,
): Promise<{ local: string; public: string | undefined } | undefined> {
  const session = localSession(ctx)
  if (session === null) return undefined
  // Публичный адрес показываем только у живого занятия: расписка на временный
  // адрес переживает падение супервизора, и мёртвая сессия называла бы ссылку,
  // по которой уже никто не ответит.
  const alive = await ctx.sh.capture('kill', ['-0', String(session.pid)], { timeoutMs: 4000 })
  const publicUrl =
    alive.code === 0 && session.leaseFile !== ''
      ? leaseUrl(ctx.io.readText(session.leaseFile), session.runId, ctx.io.now())
      : undefined
  return { local: session.url, public: publicUrl }
}

function checkLaunch(ctx: Ctx): void {
  const port = value(ctx, 'port', 'PORT')
  if (
    (ctx.values.port !== undefined && port === undefined) ||
    (port !== undefined && (!/^[0-9]+$/.test(port) || Number(port) < 1 || Number(port) > 65535))
  ) {
    throw new UsageError(
      'the port must be a whole number from 1 to 65535',
      'colloq run --port 3000',
    )
  }
  const host = value(ctx, 'host', 'HOST')
  if (
    (ctx.values.host !== undefined && host === undefined) ||
    (host !== undefined && !hostNameOk(host))
  ) {
    throw new UsageError('the tunnel name is not valid', 'colloq run --host hse.colloq.ru')
  }
}

/**
 * Чем звать супервизор занятия — исходником или бандлом.
 *
 * В репозитории это `cli/src/launch.ts` через tsx: исходник правят, и гонять
 * его через сборку на каждый запуск значило бы вставить сборку между правкой и
 * проверкой. В дистрибутиве ни исходника, ни tsx нет вовсе — там лежит один
 * собранный `cli/launch.mjs`, и звать его надо голым node.
 *
 * Пока этой развилки не было, `colloq start` из колеса печатал путь
 * `…/_app/cli/src/launch.ts` и падал: файла нет, tsx нет. Проверено
 * `colloq start --dry-run` из поставленного колеса.
 */
function launcher(ctx: Ctx): string[] {
  return ctx.dist
    ? [ctx.env.path('cli/launch.mjs')]
    : ['--import', 'tsx', ctx.env.path('cli/src/launch.ts')]
}

async function launch(ctx: Ctx, command: 'run' | 'dev' | 'stop' | 'restart'): Promise<number> {
  const args = [...launcher(ctx), command]
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
    audience: 'teacher',
    summary: 'Start a local session in this terminal and open the browser',
    usage: 'colloq run [--host <name>] [--detach] [--port <port>] [--no-open] [--fast]',
    flags: [
      {
        name: 'host',
        arg: 'name',
        summary: 'Publish the session through the tunnel it owns (HOST=…)',
      },
      { name: 'detach', summary: 'Leave the session in the background (DETACH=1)' },
      { name: 'port', arg: 'port', summary: 'Port of the local server (PORT=…)' },
      { name: 'no-open', summary: 'Do not open the browser (OPEN=0)' },
      { name: 'fast', summary: 'Build without pre-compressing the frontend (FAST=1)' },
    ],
    destructive: false,
    check: checkLaunch,
    delegates:
      'native: the class supervisor — cli/launch.mjs in the distribution, cli/src/launch.ts through tsx in the repository',
    examples: ['colloq start', 'colloq run --host hse.colloq.ru'],
    notes:
      'colloq start is the same command under its other name, and it is the one a class is started with most of the time. In the repository a bare colloq does what run does; in the installed package a bare call starts nothing and prints a short help page — there a class begins with the word start. Logs stay in the terminal; Ctrl+C ends the session, its tunnel and the kernels of this database, keeping files and data. A busy server is not restarted. --detach leaves the session in the background; colloq stop ends it. The old menu is still there: colloq menu.',
    async run(ctx) {
      head(ctx, 'starting the local session')
      return await launch(ctx, 'run')
    },
  },
  {
    name: 'stop',
    group: 'local',
    audience: 'teacher',
    summary: 'End the local session, its tunnel and the kernels of this database',
    usage: 'colloq stop',
    flags: [],
    destructive: true,
    confirm: 'cli',
    confirmQuestion: 'stop the server?',
    delegates:
      'native: the same supervisor with the stop command; without a session receipt — make stop (in the repository)',
    examples: ['colloq stop', 'colloq stop --yes'],
    notes:
      'From the session receipt (.colloq/local-session.json in the state directory) the supervisor ends the processes it owns and the kernels of its own database. Files and the database are kept. Without a new receipt the repository falls back to the old make stop; in the installed package there is nothing to stop — a class there is only ever your own, with a receipt.',
    async run(ctx) {
      head(ctx, 'stopping the server')
      if (localSession(ctx) !== null) return await launch(ctx, 'stop')
      /*
       * Расписки нет — и дальше две разные машины.
       *
       * В репозитории сервер мог поднять кто угодно: make run, docker compose,
       * прежняя версия CLI, — и старый `make stop` остаётся единственным, кто
       * знает про все эти формы. У поставленного пакета Makefile нет вовсе, и
       * звать его значило бы отдать человеку «make: *** No rule to make target
       * `stop`» вместо ответа. А отвечать тут есть что: занятие в пакете бывает
       * ровно одно — своё, с распиской, — и её отсутствие и значит, что
       * останавливать нечего.
       */
      if (ctx.dist) {
        ctx.ui.line('no class is running — nothing to stop')
        ctx.ui.hint('start one: colloq start')
        return 0
      }
      return await ctx.sh.make('stop')
    },
  },
  {
    name: 'restart',
    group: 'local',
    audience: 'teacher',
    summary: 'Restart whatever is running on this machine',
    usage: 'colloq restart [--build] [--fast]',
    flags: [
      { name: 'build', summary: 'Rebuild the frontend before restarting' },
      { name: 'fast', summary: 'With --build, build without compression' },
    ],
    destructive: true,
    confirm: 'self',
    delegates:
      'session → supervisor restart; container → make restart · service → make service-restart · host → make stop, make run; without a receipt in the installed package — a refusal in words',
    examples: ['colloq restart', 'colloq restart --build'],
    notes:
      'A new session receipt points at the supervisor. For older launches what is running is decided in the same order as in scripts/host.sh: COLLOQ_CLUSTER=1 → cluster, service, the app container, a live .colloq.pid receipt. The order must not change: the pid file speaks of the past. The installed package has none of the older forms at all: without a receipt there is nothing to restart, and the command says so in words rather than through a make error. A bare docker compose restart is never called: it restarts the kernel as well, and that is the Python state of every room. The cluster does not come here: colloq cluster stop · colloq cluster start.',
    async run(ctx) {
      if (localSession(ctx) !== null) {
        if (!ctx.dryRun && !(await ask(ctx, 'restart the local session?'))) return 4
        return await launch(ctx, 'restart')
      }
      /*
       * Расписки нет — и у поставленного пакета дальше идти не с чем.
       *
       * Ниже всё держится на Makefile и node_modules: make restart, пара make
       * stop + make run, make service-restart, а с --build ещё и npm run
       * build:optimized. В пакете нет ни того, ни другого, и человек получал
       * «make: *** No rule to make target `stop`» — при том что pid-файл рядом
       * есть и перезапуск выглядел осмысленным. Отвечаем словами, как stop:
       * занятие в пакете бывает ровно одно — своё, с распиской.
       */
      if (ctx.dist) {
        ctx.ui.refuse(
          'no class is running — nothing to restart',
          'there is no session receipt, and the older forms (docker, service, make) live only next to the sources',
          'start one: colloq start',
        )
        return 3
      }
      const form = await ctx.form()
      if (form === 'cluster') {
        ctx.ui.refuse(
          'this is a k3s cluster',
          'it has no soft restart',
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
        ? 'rebuild the panel and restart? web/dist changes on the fly'
        : 'restart the server?'
      if (!(await ask(ctx, question))) return 4

      if (build) {
        head(
          ctx,
          fast ? 'building the panel without compression' : 'building the panel with compression',
        )
        const built = await ctx.sh.npm(script)
        if (built !== 0) return built
      }
      if (form === 'service') {
        head(ctx, 'restarting the service')
        return await ctx.sh.make('service-restart')
      }
      if (form === 'host') {
        head(ctx, 'restarting the server on the host')
        const stopped = await ctx.sh.make('stop')
        if (stopped !== 0) return stopped
        return await ctx.sh.make('run', mine(ctx, { FAST: fast ? '1' : undefined }))
      }
      head(ctx, 'restarting app in docker')
      return await ctx.sh.make('restart')
    },
  },
  {
    name: 'up',
    group: 'local',
    summary: 'Bring the whole stack up in docker: the application and the kernel',
    usage: 'colloq up',
    flags: [],
    destructive: true,
    confirm: 'cli',
    confirmQuestion: 'recreate app in docker?',
    delegates: 'make up',
    examples: ['colloq up', 'colloq up --yes'],
    notes:
      'Pulls .env, dirs and docker-gid along with it, recreates the app container and prints http://localhost:<PORT>. The server on the host (colloq run) and app in docker are two Colloqs on one port.',
    async run(ctx) {
      head(ctx, 'bringing the stack up in docker')
      return await ctx.sh.make('up')
    },
  },
  {
    name: 'down',
    group: 'local',
    summary: 'Stop everything in docker (data and files stay)',
    usage: 'colloq down',
    flags: [],
    destructive: true,
    confirm: 'cli',
    confirmQuestion: 'stop everything in docker?',
    delegates: 'make down',
    examples: ['colloq down', 'colloq down --yes'],
    notes:
      'The most dangerous of the local commands: every room container is removed first (label colloq.kind=room-kernel), and only then compose down — otherwise the compose network is not deleted while containers it does not own are still inside. The room containers hold the Python state of the class in progress, so the question names how many of them there are. A server running under the service is untouched, and make down says so itself.',
    async run(ctx) {
      head(ctx, 'stopping everything in docker')
      return await ctx.sh.make('down')
    },
  },
  {
    name: 'ps',
    aliases: ['containers'],
    group: 'local',
    summary: 'What is running in docker: compose, room kernels, the environment',
    usage: 'colloq ps',
    flags: [],
    destructive: false,
    delegates: 'make status (also known as make ps)',
    examples: ['colloq ps', 'colloq ps --dry-run'],
    notes:
      'This is the docker view. The whole machine is colloq status, and it works without the network and without compose. The names do not collide: here ps is not an alias of status, unlike in the Makefile.',
    async run(ctx) {
      return await ctx.sh.make('status')
    },
  },
  {
    name: 'logs',
    aliases: ['log'],
    group: 'local',
    audience: 'teacher',
    summary: 'Watch the log of whatever is running on this machine',
    usage: 'colloq logs [-f|--no-follow] [-n <lines>] [--server|--docker|--service]',
    flags: [
      { name: 'follow', short: 'f', summary: 'Follow (on by default)' },
      { name: 'no-follow', summary: 'Show the tail and exit' },
      { name: 'lines', short: 'n', arg: 'lines', summary: 'How many lines of the tail' },
      { name: 'server', summary: 'The log of the server on the host — .colloq.log' },
      { name: 'docker', summary: 'The docker compose log' },
      { name: 'service', summary: 'The service log' },
    ],
    destructive: false,
    delegates: 'tail <log> · make logs · make service-logs',
    examples: ['colloq logs', 'colloq logs --docker -n 200'],
    notes:
      'Without a flag, what is running is decided in the same order as for restart. .colloq.log is appended to and never truncated — the history of past weeks is evidence, and tail only reads. The log holds /admin/t/<token> links: the CLI cuts nothing out of the stream and retells nothing, and it never prints the token itself either. For the service the log is kept by journalctl: -n and --no-follow do not reach it.',
    async run(ctx) {
      const picked = (['server', 'docker', 'service'] as const).filter(
        (name) => ctx.values[name] === true,
      )
      if (picked.length > 1) {
        throw new UsageError(
          picked.map((name) => '--' + name).join(' and ') + ' at once does not happen',
          'there is one log: colloq logs --docker',
        )
      }
      if (ctx.values.follow === true && ctx.values['no-follow'] === true) {
        throw new UsageError(
          '-f and --no-follow do not work together',
          'follow with -f, show the tail and exit with --no-follow',
        )
      }
      const follow = ctx.values['no-follow'] !== true
      const lines = value(ctx, 'lines', 'LINES')
      checkLines(lines)
      const source = picked[0] ?? (await logSource(ctx))

      if (source === 'service') {
        head(ctx, 'the service log')
        return await ctx.sh.make('service-logs')
      }
      if (source === 'docker') {
        head(ctx, 'the docker compose log')
        if (follow && lines === undefined) return await ctx.sh.make('logs')
        const args = ['compose', 'logs']
        if (follow) args.push('-f')
        args.push('--tail=' + (lines ?? '80'))
        return await ctx.sh.run('docker', args)
      }
      if (!ctx.dryRun && !ctx.io.exists(ctx.env.paths.logFile)) {
        ctx.ui.refuse(
          'no .colloq.log',
          'the server on this machine has never been started through colloq run',
          'colloq run · the docker log: colloq logs --docker',
        )
        return 3
      }
      head(ctx, 'the log of the server on the host')
      /*
       * Тейлим свой файл, а не отдаём работу make logs-run.
       *
       * Цель Makefile — это `tail -f $(LOG)` от каталога ПРИЛОЖЕНИЯ, и у
       * установленного colloq она даёт «make: *** No rule to make target
       * `logs-run`» вместо журнала. Верный путь известен строкой выше — по
       * нему же только что проверили, что журнал вообще есть, — а в журнале
       * лежит ссылка входа, к которой отсылает colloq link: промахнуться тут
       * дороже всего. Вызов получается тот же самый: `tail -f <журнал>`.
       */
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
    summary: 'Start the reloading server and Vite in one session',
    usage: 'colloq dev [--port <port>] [--no-open]',
    flags: [
      { name: 'port', arg: 'port', summary: 'Port of the browser and Vite (PORT=… as a pair)' },
      { name: 'no-open', summary: 'Do not open the browser (OPEN=0)' },
    ],
    destructive: false,
    check: checkLaunch,
    delegates: 'native: the same supervisor with the dev command (in the repository only)',
    examples: ['colloq dev', 'colloq dev --port 4000 --no-open'],
    notes:
      'The server watching the sources and Vite run until Ctrl+C. Server reloads keep the room kernels; the end of the session ends the kernels of this database. Files and the database are kept.',
    async run(ctx) {
      head(ctx, 'starting the server and Vite for development')
      return await launch(ctx, 'dev')
    },
  },
  {
    name: 'build',
    group: 'local',
    summary: 'Build the frontend and the server',
    usage: 'colloq build [--fast]',
    flags: [{ name: 'fast', summary: 'Without pre-compression' }],
    destructive: false,
    confirm: 'self',
    delegates: 'npm run build:optimized (with --fast — npm run build)',
    examples: ['colloq build', 'colloq build --fast'],
    notes:
      'Asks only if the server is alive: web/dist is served live through STATIC_DIR, and a rebuild under a class in progress swaps the assets on the fly. Compression by default is not idle: without .br files next to assets/ the server compresses every file on every request — 11.6 ms of CPU and 25 KB per student per file.',
    async run(ctx) {
      const fast = on(ctx, 'fast', 'FAST')
      if (!ctx.dryRun && !ctx.yes && (await ctx.serverAlive())) {
        if (
          !(await ask(
            ctx,
            'rebuild the panel while the server is running? the assets change on the fly',
          ))
        )
          return 4
      }
      head(
        ctx,
        fast ? 'building the panel without compression' : 'building the panel with compression',
      )
      return await ctx.sh.npm(fast ? 'build' : 'build:optimized')
    },
  },
  {
    name: 'ui',
    group: 'local',
    summary: 'Check the interface in a real browser',
    usage: 'colloq ui [--headed]',
    flags: [{ name: 'headed', summary: 'With a visible window' }],
    destructive: false,
    confirm: 'self',
    delegates: 'make ui [HEADED=1]',
    examples: ['colloq ui', 'colloq ui --headed'],
    notes:
      "Asks the same way build does: make ui rebuilds web/dist first, so on a machine where a class is running it is not safe. Its own server on 3891 (CDP 9334), its own DATA_DIR, KERNEL_BACKEND=test — the check touches nobody else's database.",
    async run(ctx) {
      if (!ctx.dryRun && !ctx.yes && (await ctx.serverAlive())) {
        if (
          !(await ask(
            ctx,
            'check the interface while the server is running? web/dist will be rebuilt',
          ))
        ) {
          return 4
        }
      }
      head(ctx, 'checking the interface in a browser')
      return await ctx.sh.make(
        'ui',
        mine(ctx, { HEADED: on(ctx, 'headed', 'HEADED') ? '1' : undefined }),
      )
    },
  },
  {
    name: 'test',
    group: 'local',
    summary: 'Run the tests',
    usage: 'colloq test [pattern]',
    args: [{ name: 'pattern', summary: 'A piece of a file name: council, cli, shell' }],
    flags: [],
    destructive: false,
    delegates: 'make test · node --import tsx --test tests/*<pattern>*.test.mts',
    examples: ['colloq test', 'colloq test council'],
    notes:
      'The pattern is a piece of a file name, not a regular expression: it is looked for in the names under tests/*.test.mts. --test-force-exit and --test-concurrency=1 are repeated word for word from the root npm test, otherwise the suite behaves differently than it does in CI.',
    async run(ctx) {
      const pattern = ctx.positionals[0]
      if (pattern === undefined) {
        head(ctx, 'running the tests')
        return await ctx.sh.make('test')
      }
      if (pattern.includes('/') || pattern.startsWith('-')) {
        throw new UsageError(
          'pattern "' + pattern + '" is not valid',
          'it is a piece of a file name, without a directory: colloq test council',
        )
      }
      const names = ctx.io
        .list(ctx.env.path('tests'))
        .filter((name) => name.endsWith('.test.mts') && name.includes(pattern))
      if (names.length === 0) {
        ctx.ui.refuse(
          'no tests match "' + pattern + '"',
          'looked for tests/*' + pattern + '*.test.mts',
          'see what is there: ls tests',
        )
        return 1
      }
      head(ctx, 'running the tests: ' + countWord(names.length, 'file'))
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
    summary: 'Run the tests and the type check',
    usage: 'colloq check',
    flags: [],
    destructive: false,
    delegates: 'make check',
    examples: ['colloq check', 'colloq check --dry-run'],
    notes: 'npm test && npm run typecheck; the type check of the root covers @colloq/cli as well.',
    async run(ctx) {
      head(ctx, 'running the tests and the type check')
      return await ctx.sh.make('check')
    },
  },
  {
    name: 'shell',
    group: 'local',
    summary: 'Open a shell in the kernel to see what is installed there',
    usage: 'colloq shell',
    flags: [],
    destructive: false,
    delegates: 'make shell',
    examples: ['colloq shell', 'colloq shell --dry-run'],
    notes:
      'Interactive: input and output go to the terminal as they are. On a machine running under the service there is no shared compose kernel at all — make shell opens a throwaway colloq-kernel:<environment> container itself. Whatever was installed by hand into a running room is visible only in that room, from its terminal.',
    async run(ctx) {
      head(ctx, 'opening a shell in the kernel: ' + ctx.env.kernelEnv())
      return await ctx.sh.make('shell')
    },
  },
  {
    name: 'link',
    group: 'local',
    audience: 'teacher',
    summary: 'Show the class address and where to find the sign-in to the panel',
    usage: 'colloq link',
    flags: [],
    destructive: false,
    delegates: 'native: reads the session receipt, the temporary address and .env',
    examples: ['colloq link', 'colloq link --dry-run'],
    notes:
      'The setup token is never printed — not from data/setup-token, not from the log: the /admin/t/<token> link is the key to the whole instance.',
    async run(ctx) {
      if (ctx.dryRun) {
        return ctx.sh.dry(
          'native: link (reads the session receipt, the temporary address and .env)',
        )
      }
      const session = await sessionAddress(ctx)
      if (!session && !ctx.io.exists(ctx.env.paths.envFile)) {
        ctx.ui.refuse(
          'no .env',
          'the class address comes from there',
          'the first run creates it: colloq run',
        )
        return 3
      }
      const url = session ? (session.public ?? session.local) : ctx.env.publicUrl()
      const inside =
        (session !== undefined && session.public === undefined) ||
        url === '' ||
        /^https?:\/\/(127\.0\.0\.1|localhost|0\.0\.0\.0)([:/]|$)/.test(url)
      ctx.ui.header('Class')
      if (session) ctx.ui.kv('local', session.local)
      if (inside) {
        ctx.ui.kv('address', 'not published', url === '' ? undefined : url)
        ctx.ui.hint('colloq host <name> — publish it and get a link for the room')
      } else {
        ctx.ui.kv('address', ctx.ui.cyan(url))
      }
      const domain = ctx.env.relay().domain
      if (domain !== '') ctx.ui.kv('domain', domain)
      ctx.ui.kv('sign-in', 'printed once at startup')
      /*
       * Пути называем целиком, а не «.colloq.log» и «data/setup-token».
       *
       * Относительное имя подразумевает, что корень один. У установленного
       * colloq журнал и токен лежат в каталоге состояния (~/.colloq), а человек
       * ищет их в своей рабочей папке, не находит и решает, что вход не
       * сохранился, — хотя ссылка на месте.
       */
      ctx.ui.hint(
        'it is in ' +
          ctx.env.paths.logFile +
          '; on the machine — in ' +
          joinPath(ctx.env.paths.home, 'data/setup-token') +
          '. The CLI never prints the token itself',
      )
      return 0
    },
  },
  {
    name: 'docker-gid',
    group: 'local',
    summary: 'Write the docker socket group into .env so every room gets its own kernel',
    usage: 'colloq docker-gid',
    flags: [],
    destructive: true,
    confirm: 'cli',
    confirmWhen: async (ctx) => !ctx.env.has('DOCKER_GID'),
    confirmQuestion: 'append DOCKER_GID to .env?',
    delegates: 'make docker-gid',
    examples: ['colloq docker-gid', 'colloq docker-gid --yes'],
    notes:
      'The only write into .env the CLI ever starts, and make does it itself: the line is appended only if it is not there already. Without it the server cannot reach docker, and the rooms will share one kernel. To ask the daemon for the gid a tiny busybox container may come up.',
    async run(ctx) {
      head(ctx, 'asking for the docker socket group')
      return await ctx.sh.make('docker-gid')
    },
  },
  {
    name: 'backup',
    group: 'local',
    audience: 'teacher',
    summary: 'Take a backup: a portable k3s one or a local one in the old format',
    usage:
      'colloq backup [--legacy] [--mode <live|consistent>] [--resume] [--name <environment>] [--out <path>] [--release <path>]',
    flags: [
      { name: 'legacy', summary: 'A local pair of .db and -files.tar.gz' },
      { name: 'mode', arg: 'mode', summary: 'live (the default) or consistent' },
      { name: 'resume', summary: 'Start the writers again after consistent' },
      {
        name: 'name',
        arg: 'environment',
        summary: 'Backup of an environment: into backups/<environment>/',
      },
      { name: 'out', arg: 'path', summary: 'Where to put the archive' },
      { name: 'release', arg: 'path', summary: 'Which release counts as installed' },
    ],
    destructive: true,
    confirm: 'self',
    delegates:
      'make backup MODE=… · make backup-legacy (in an installed colloq — scripts/backup.sh and scripts/backup-local.sh directly)',
    examples: ['colloq backup', 'colloq backup --mode consistent --resume'],
    notes:
      'Without flags an installed colloq takes a local backup: the portable one is for a machine with k3s on it, and --mode, --out, --release or --name still lead into it. The question is asked only with --mode consistent: it stops app, the broker and every room and deliberately leaves them down — only --resume brings them back, and a backup that fails leaves the writers down as well. backup.sh restarts itself under scripts/state-lock.py and refuses while .restore-in-progress is there; without an installed release it sends you to --legacy itself. The local backup (scripts/backup-local.sh) does a VACUUM INTO (sqlite3 required) and an archive with workspace, data/session-secret, data/setup-token and its own environment lists, both files 0600; exit code 1 from tar means "the file changed while it was read", that is a class in progress, and it is allowed. Everything counts from the state directory: backups of this machine live in its backups/, backups of environments in backups/<environment>/.',
    async run(ctx) {
      const mode = value(ctx, 'mode', 'MODE') ?? 'live'
      const resume = on(ctx, 'resume', 'RESUME')
      const name = value(ctx, 'name', 'NAME')
      const out = value(ctx, 'out', 'OUT')
      const release = value(ctx, 'release', 'RELEASE')
      // Переносимую копию назвали вслух: любой её флаг — это просьба о ней.
      const portable =
        value(ctx, 'mode', 'MODE') !== undefined ||
        resume ||
        name !== undefined ||
        out !== undefined ||
        release !== undefined
      /*
       * Умолчание меняется, и только для дистрибутива.
       *
       * Переносимая копия имеет смысл там, где стоит k3s: scripts/backup.sh
       * первым делом требует установленный релиз и без него отказывает. У
       * преподавателя, который поставил colloq через pip и ведёт занятие на
       * своём ноутбуке, релиза нет и не будет — `colloq backup` без флагов
       * отвечал бы ему про кластер, которого он не заводил, хотя нужна ему
       * ровно та копия, что делает scripts/backup-local.sh: база и файлы
       * занятия. Обещание команды («снять копию») и отказ про чужой мир
       * несовместимы, и разрешается это в пользу обещания — как у env list.
       *
       * Второй путь не закрыт: кластер обслуживают тем же колесом
       * (scripts/cluster.sh едет туда же), и названный флаг уводит в него. В
       * репозитории умолчание прежнее: там make есть, а мастерская знает,
       * чего просит.
       */
      const legacy = ctx.values.legacy === true || (ctx.dist && !portable)

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
            used.join(' and ') + ' does not work with --legacy',
            'a local backup is always the same pair in backups/: colloq backup --legacy',
          )
        }
        head(ctx, 'taking a local backup: the database and the files')
        return await copyCall(ctx, 'backup-legacy', './scripts/backup-local.sh')
      }

      if (mode !== 'live' && mode !== 'consistent') {
        throw new UsageError(
          'there is no "' + mode + '" mode',
          'there is --mode live and there is --mode consistent',
        )
      }
      if (resume && mode !== 'consistent') {
        throw new UsageError(
          '--resume only makes sense with --mode consistent',
          'live stops nobody, there is nothing to bring back',
        )
      }
      checkName(name)

      if (mode === 'consistent') {
        const tail = resume ? '' : ' without --resume they stay down'
        if (!(await ask(ctx, 'stop every writer?' + tail))) return 4
      }
      head(ctx, mode === 'consistent' ? 'taking a consistent backup' : 'taking a backup on the fly')
      // backup.sh читает всё окружением (MODE, RESUME, NAME, OUT, RELEASE), и
      // цель backup ровно этим его и зовёт: аргументов у него нет вовсе.
      return await copyCall(ctx, 'backup', './scripts/backup.sh', {
        MODE: mode,
        RESUME: resume ? '1' : undefined,
        NAME: name,
        OUT: out === undefined ? undefined : ctx.env.userPath(out),
        RELEASE: release === undefined ? undefined : ctx.env.userPath(release),
      })
    },
  },
  {
    name: 'restore',
    group: 'local',
    audience: 'teacher',
    summary: 'Restore a backup: a portable k3s one or a local one in the old format',
    usage:
      'colloq restore --archive <file> --release <file> [--replace] [--recover] [--name <environment>] | colloq restore --legacy --db <file> [--files <archive>] [--name <environment>] [--replace]',
    flags: [
      { name: 'archive', arg: 'file', summary: 'The portable backup, a .tar.gz' },
      { name: 'release', arg: 'file', summary: 'release.json of the same generation' },
      { name: 'legacy', summary: 'A local pair in the old format' },
      { name: 'db', arg: 'file', summary: 'The database from a local backup' },
      { name: 'files', arg: 'archive', summary: 'Class files from a local backup' },
      {
        name: 'name',
        arg: 'environment',
        summary: 'Backup of an environment: from backups/<environment>/',
      },
      {
        name: 'replace',
        summary: 'REPLACE=1: restore over the current database (--yes does not grant this)',
      },
      { name: 'recover', summary: 'Finish an interrupted restore' },
    ],
    destructive: true,
    confirm: 'self',
    delegates:
      'make restore ARCHIVE=… RELEASE=… · make restore-legacy DB=… FILES=… (in an installed colloq — scripts/restore.sh directly)',
    examples: [
      'colloq restore --archive backups/{env}/colloq-20260914.tar.gz --release release.json',
      'colloq restore --legacy --db backups/colloq-20260914.db --files backups/colloq-20260914-files.tar.gz',
    ],
    notes:
      'The portable path asks nothing on its own — we ask; the local one asks for itself (scripts/restore.sh), and we do not ask a second time. The two worlds must not be mixed: restore.sh rejects an old pair laid on top as soon as a k3s release is installed. The local path refuses if the colloq service is active, the compose app is running, .colloq.pid is alive, or somebody answers on localhost:<PORT>. WAL and SHM travel with their own database, the old database is set aside as data/colloq.db.replaced-<stamp>, and the files from the archive go over workspace/ without a backup of their own. Relative paths count from the directory the command was called from.',
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
          'no file ' + path,
          what,
          'see what has been taken: ls backups' + (name === undefined ? '' : '/' + name),
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
            'an old-format backup and a portable one are different worlds: drop ' +
              used.join(' and '),
            'k3s: colloq restore --archive … --release …',
          )
        }
        if (db === undefined) {
          throw new UsageError(
            'no --db <file>',
            'Usage: colloq restore --legacy --db backups/colloq-….db [--files backups/colloq-…-files.tar.gz]',
          )
        }
        const dbPath = ctx.env.userPath(db)
        const filesPath = files === undefined ? undefined : ctx.env.userPath(files)
        if (!ctx.dryRun) {
          if (!ctx.io.exists(dbPath)) return missing(dbPath, 'there is nothing to restore')
          if (filesPath !== undefined && !ctx.io.exists(filesPath)) {
            return missing(filesPath, 'the archive holds the class files and the instance keys')
          }
        }
        // Второй вопрос подряд перестают читать: здесь спрашивает сам скрипт.
        head(ctx, 'restoring an old-format backup')
        // Цель restore-legacy — `NAME=… ./scripts/restore.sh $(DB) $(FILES)`:
        // пути идут аргументами, остальное окружением. Пустого аргумента быть
        // не должно — скрипт разбирает их по расширению и на пустой строке
        // умирает «не понимаю «»».
        return await copyCall(
          ctx,
          'restore-legacy',
          './scripts/restore.sh',
          { DB: dbPath, FILES: filesPath, NAME: name, REPLACE: replace ? '1' : undefined },
          filesPath === undefined ? [dbPath] : [dbPath, filesPath],
          ['DB', 'FILES'],
        )
      }

      if (archive === undefined || release === undefined) {
        const what = archive === undefined ? '--archive <file>' : '--release <file>'
        throw new UsageError(
          'no ' + what,
          'a portable backup needs both: colloq restore --archive backup.tar.gz --release release.json',
        )
      }
      const archivePath = ctx.env.userPath(archive)
      const releasePath = ctx.env.userPath(release)
      if (!ctx.dryRun) {
        if (!ctx.io.exists(archivePath)) return missing(archivePath, 'there is nothing to restore')
        if (!ctx.io.exists(releasePath)) {
          return missing(
            releasePath,
            'without release.json the generation of the backup cannot be checked',
          )
        }
        if (
          !(await ask(
            ctx,
            'restore over this machine? the cluster will be stopped and the writers will stay down',
          ))
        ) {
          return 4
        }
      }
      head(ctx, 'restoring a portable backup')
      // Цель restore собирает скрипту те же аргументы: --archive, --release и
      // два ключа-переключателя. Именем среды она распоряжается иначе —
      // отдаёт его переменной, как и все остальные.
      const flags = [
        '--archive',
        archivePath,
        '--release',
        releasePath,
        ...(replace ? ['--replace'] : []),
        ...(recover ? ['--recover'] : []),
      ]
      return await copyCall(
        ctx,
        'restore',
        './scripts/restore.sh',
        {
          ARCHIVE: archivePath,
          RELEASE: releasePath,
          REPLACE: replace ? '1' : undefined,
          RECOVER: recover ? '1' : undefined,
          NAME: name,
        },
        flags,
        ['ARCHIVE', 'RELEASE', 'REPLACE', 'RECOVER'],
      )
    },
  },
]
