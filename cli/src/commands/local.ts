/**
 * Локально — занятие на этой машине: начать, закончить, перезапустить,
 * посмотреть журнал и адрес, снять и развернуть копию.
 *
 * Команды: run (он же start), stop, restart, logs, link, backup, restore.
 * Порядок здесь — порядок в help. Это всё, чем преподаватель ведёт занятие на
 * своём ноутбуке после `pip install colloq`; мастерской — docker-стека,
 * сборки, тестов, оболочки в ядре — здесь нет. Она живёт в Makefile и
 * scripts/, и её зовут там напрямую: обёртка над ней из колеса только
 * печатала `make …`, которого в пакете нет.
 *
 * Команда ведёт себя одинаково, откуда бы CLI ни запустили — из колеса или
 * из исходников. ctx.dist решает ровно одно: чем звать супервизор (launcher
 * ниже). Стоит развилке заползти в поведение, и проверенное в клоне окажется
 * у преподавателя другой командой — так уже было с backup и stop.
 *
 * node:child_process и node:fs импортировать нельзя: только ctx.sh и ctx.io.
 * Иначе тест перестаёт быть герметичным, и это стережёт cli-core.
 *
 * Работа отдаётся тому, кто её знает: занятие — супервизору, копии —
 * scripts/backup-local.sh, scripts/backup.sh и scripts/restore.sh. Проверки,
 * которые уже стоят там (живой сервер под restore, нет релиза под переносимой
 * копией, замок состояния), здесь не повторяются: там они сказаны точнее, и
 * их stderr уходит наружу как есть.
 */
import type { Command, Ctx } from '../registry.js'
import { cancelled, heading as head, UsageError } from '../ui.js'
import { envNameOk, joinPath } from '../env.js'
import { readSession, type Session } from '../session.js'
import { hostNameOk } from './host.js'
import { leaseUrl } from '../../../shared/local-public-url-lease.js'

/** Свой вопрос: «нет» — это DIM «отменено» и код 4. --yes и --dry-run отвечают «да». */
async function ask(ctx: Ctx, question: string): Promise<boolean> {
  if (await ctx.confirm(question)) return true
  cancelled(ctx.ui)
  return false
}

/** Значение строкового флага; пустая строка — всё равно что не сказали. */
function flag(ctx: Ctx, name: string): string | undefined {
  const raw = ctx.values[name]
  return typeof raw === 'string' && raw !== '' ? raw : undefined
}

/**
 * Где лежат данные занятия — явной переменной окружения для скриптов.
 *
 * scripts/backup.sh и scripts/restore.sh делают cd к себе и без подсказки
 * берут data/ с workspace/ от каталога ПРИЛОЖЕНИЯ, складывая архив в
 * <app>/backups. У установленного colloq там нет ни базы, ни файлов занятий —
 * копия снялась бы с пустого места, а восстановление легло бы мимо настоящей
 * базы, и обе беды тихие.
 *
 * Поэтому корень состояния называем сами и всегда: в клоне home и есть
 * корень, и строка ничего не меняет — зато нет развилки, которую надо не
 * забыть повторить в следующей команде.
 */
function stateEnv(ctx: Ctx): Record<string, string> {
  return { COLLOQ_HOME: ctx.env.paths.home }
}

/**
 * Снять или развернуть копию — самим скриптом, не целью Makefile.
 *
 * Цели backup, backup-legacy, restore и restore-legacy — обёртки в одну-две
 * строки над этими же скриптами, но Makefile в колесо не едет и не поедет:
 * `colloq backup --dry-run` из колеса печатал `make backup MODE=live` —
 * команду, которая там умирает кодом 127, и это единственный способ унести
 * занятие с машины. Проверено живьём. Скрипты едут (scripts/pack.mts ·
 * SCRIPTS), поэтому зовём их напрямую и так же, как их позвала бы цель: что
 * цель отдаёт аргументом — аргументом, что переменной — окружением.
 *
 * Пустые значения в окружение не идут: скрипт отличает «не сказали» от
 * пустой строки не везде, и лишнее `NAME=` в строке --dry-run только путает.
 */
function copyCall(
  ctx: Ctx,
  script: string,
  vars: Record<string, string | undefined> = {},
  args: string[] = [],
): Promise<number> {
  const env = stateEnv(ctx)
  for (const [key, item] of Object.entries(vars)) {
    if (item !== undefined && item !== '') env[key] = item
  }
  return ctx.sh.script(script, args, { env })
}

/** Имя среды: тем же ситом, что в scripts/backup.sh и scripts/restore.sh (env.envNameOk). */
function checkName(name: string | undefined): void {
  if (name === undefined) return
  if (!envNameOk(name)) {
    throw new UsageError(
      'environment name "' + name + '" is not valid',
      'letters, digits and a hyphen in the middle: --name lab',
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

/**
 * Порт и имя туннеля проверяются до запуска супервизора.
 *
 * Пустое значение — тоже ошибка, а не «умолчание»: `--port ''` чаще всего
 * значит пустую переменную в чьём-то скрипте, и молча взять 3000 значило бы
 * поднять занятие не там, где его ждут.
 */
function checkLaunch(ctx: Ctx): void {
  const port = ctx.values.port
  if (
    typeof port === 'string' &&
    (!/^[0-9]+$/.test(port) || Number(port) < 1 || Number(port) > 65535)
  ) {
    throw new UsageError(
      'the port must be a whole number from 1 to 65535',
      'colloq run --port 3000',
    )
  }
  const host = ctx.values.host
  if (typeof host === 'string' && !hostNameOk(host)) {
    throw new UsageError('the tunnel name is not valid', 'colloq run --host class.example.org')
  }
  // Два выхода наружу разом — это два туннеля на одну расписку адреса. Тот
  // же отказ стоит и в супервизоре (launch-config.ts · parseLaunchArgs), но
  // здесь он приходит кодом 2 и до всякого запуска.
  if (ctx.values.share === true && host !== undefined) {
    throw new UsageError(
      '--share and --host do not work together',
      'colloq start --share for a quick link, or colloq start --host class.example.org for your own name',
    )
  }
}

/**
 * Чем звать супервизор занятия — исходником или бандлом.
 *
 * Из исходников это `cli/src/launch.ts` через tsx: исходник правят, и гонять
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

async function launch(ctx: Ctx, command: 'run' | 'stop' | 'restart'): Promise<number> {
  const args = [...launcher(ctx), command]
  if (command === 'run') {
    const host = flag(ctx, 'host')
    if (host) args.push('--host', host)
    if (ctx.values.share === true) args.push('--share')
    if (ctx.values.detach === true) args.push('--detach')
    const port = flag(ctx, 'port')
    if (port) args.push('--port', port)
    if (ctx.values['no-open'] === true) args.push('--no-open')
  }
  if (command === 'restart' && ctx.values.build === true) args.push('--build')
  if (command !== 'stop' && ctx.values.fast === true) args.push('--fast')
  return await ctx.sh.run('node', args)
}

export const commands: Command[] = [
  {
    name: 'run',
    aliases: ['start'],
    group: 'local',
    summary: 'Start a local session in this terminal and open the browser',
    usage:
      'colloq run [--share | --host <name>] [--detach] [--port <port>] [--no-open] [--fast]',
    flags: [
      {
        name: 'share',
        summary: 'Put the class online through a quick Cloudflare tunnel and print one link',
      },
      { name: 'host', arg: 'name', summary: 'Publish the session through the tunnel it owns' },
      { name: 'detach', summary: 'Leave the session in the background' },
      { name: 'port', arg: 'port', summary: 'Port of the local server' },
      { name: 'no-open', summary: 'Do not open the browser' },
      { name: 'fast', summary: 'Build without pre-compressing the frontend' },
    ],
    destructive: false,
    check: checkLaunch,
    delegates:
      'native: the class supervisor — cli/launch.mjs in the distribution, cli/src/launch.ts through tsx from the sources',
    examples: ['colloq start', 'colloq start --share', 'colloq run --host class.example.org'],
    notes:
      'colloq start is the same command under its other name, and it is the one a class is started with most of the time. Logs stay in the terminal and are appended to .colloq.log in the state directory as well; Ctrl+C ends the session, its tunnel and the kernels of this database, keeping files and data. A busy server is not restarted. --detach leaves the session in the background; colloq logs follows it, colloq stop ends it. --fast matters only when colloq runs from its sources: an installed colloq arrives built. ' +
      '--share opens a quick Cloudflare tunnel and prints one block: the link for students (or, with no class yet, where to create one), a warning never to share /admin/ links, and how long the link lives. The address is new on every start, and Cloudflare does not open from Russia — there, use --host with your own relay. Without cloudflared on PATH, colloq downloads a pinned release from GitHub into <state>/bin once and checks its sha256 before running it; COLLOQ_CLOUDFLARED=/path names your own file, COLLOQ_CLOUDFLARED_DOWNLOAD=0 forbids the download. ' +
      '--share and --host publish a class only when every room runs in a Docker container of its own; otherwise they refuse and the class stays local. They do not work together.',
    async run(ctx) {
      head(ctx, 'starting the local session')
      return await launch(ctx, 'run')
    },
  },
  {
    name: 'stop',
    group: 'local',
    summary: 'End the local session, its tunnel and the kernels of this database',
    usage: 'colloq stop',
    flags: [],
    destructive: true,
    confirm: 'cli',
    // Спрашивать «остановить сервер?», чтобы следом сказать «останавливать
    // нечего», — значит спросить зря: вопрос есть только у идущего занятия.
    confirmWhen: async (ctx) => localSession(ctx) !== null,
    confirmQuestion: 'stop the server?',
    delegates: 'native: the same supervisor with the stop command',
    examples: ['colloq stop', 'colloq stop --yes'],
    notes:
      'From the session receipt (.colloq/local-session.json in the state directory) the supervisor ends the processes it owns and the kernels of its own database. Files and the database are kept. Without a receipt no class is running and there is nothing to stop: every colloq start leaves one.',
    async run(ctx) {
      if (localSession(ctx) !== null) {
        head(ctx, 'stopping the server')
        return await launch(ctx, 'stop')
      }
      /*
       * Расписки нет — значит, и занятия нет.
       *
       * Занятие, которое начал colloq, бывает ровно одно — своё, с распиской,
       * — и её отсутствие и значит, что останавливать нечего. Сервер, поднятый
       * мимо colloq (make run, docker compose), — забота мастерской, и
       * гасить его тем же словом значило бы угадывать чужое. Код 0: просьба
       * «пусть ничего не идёт» уже исполнена.
       */
      ctx.ui.line('no class is running — nothing to stop')
      ctx.ui.hint('start one: colloq start')
      return 0
    },
  },
  {
    name: 'restart',
    group: 'local',
    summary: 'Restart the local session with the same port, data and tunnel',
    usage: 'colloq restart [--build] [--fast]',
    flags: [
      { name: 'build', summary: 'Rebuild the frontend before restarting' },
      { name: 'fast', summary: 'With --build, build without compression' },
    ],
    destructive: true,
    confirm: 'self',
    delegates: 'native: the same supervisor with the restart command',
    examples: ['colloq restart', 'colloq restart --build'],
    notes:
      'The supervisor reads the session receipt, ends the session and starts it again with the same port, data and flags. Without a receipt no class is running, and the command says so in words. --build and --fast matter only when colloq runs from its sources: an installed colloq arrives built and has nothing to rebuild.',
    async run(ctx) {
      if (localSession(ctx) === null) {
        /*
         * Расписки нет — перезапускать нечего, и отвечаем словами.
         *
         * Когда-то здесь начинался разбор старых форм — docker, служба,
         * pid-файл — и вызовы make. У преподавателя ничего из этого нет, а
         * человек получал «make: *** No rule to make target `stop`» при живом
         * pid-файле рядом, и перезапуск выглядел осмысленным. Отказ — код 3 и
         * под --dry-run тоже: выполнить было бы нечего.
         */
        ctx.ui.refuse(
          'no class is running — nothing to restart',
          'there is no session receipt at ' + ctx.env.paths.sessionFile,
          'start one: colloq start',
        )
        return 3
      }
      if (!ctx.dryRun && !(await ask(ctx, 'restart the local session?'))) return 4
      head(ctx, 'restarting the local session')
      return await launch(ctx, 'restart')
    },
  },
  {
    name: 'logs',
    aliases: ['log'],
    group: 'local',
    summary: 'Watch the log of the class on this machine',
    usage: 'colloq logs [-f|--no-follow] [-n <lines>]',
    flags: [
      { name: 'follow', short: 'f', summary: 'Follow (on by default)' },
      { name: 'no-follow', summary: 'Show the tail and exit' },
      { name: 'lines', short: 'n', arg: 'lines', summary: 'How many lines of the tail' },
    ],
    destructive: false,
    delegates: 'tail .colloq.log in the state directory',
    examples: ['colloq logs', 'colloq logs -n 200 --no-follow'],
    notes:
      '.colloq.log is written by every colloq start, in the terminal and with --detach alike. It is appended to and never truncated — the history of past weeks is evidence, and tail only reads. The log holds /admin/t/<token> links: the CLI cuts nothing out of the stream and retells nothing, and it never prints the token itself either.',
    async run(ctx) {
      if (ctx.values.follow === true && ctx.values['no-follow'] === true) {
        throw new UsageError(
          '-f and --no-follow do not work together',
          'follow with -f, show the tail and exit with --no-follow',
        )
      }
      const follow = ctx.values['no-follow'] !== true
      const lines = flag(ctx, 'lines')
      checkLines(lines)
      const log = ctx.env.paths.logFile
      if (!ctx.dryRun && !ctx.io.exists(log)) {
        /*
         * Журнал заводит супервизор при каждом `colloq start` — и в
         * терминале, и в фоне (launch.ts · runSession и detached). Нет файла
         * — значит, занятие на этой машине ещё не начинали, и совет ровно
         * один: начать. Путь называем целиком: у установленного colloq он в
         * каталоге состояния, а не в рабочей папке человека.
         */
        ctx.ui.refuse(
          'no log at ' + log,
          'no class has been started on this machine yet — every colloq start writes its log there',
          'colloq start --detach — the class goes to the background, and colloq logs follows it',
        )
        return 3
      }
      head(ctx, 'the log of the class')
      /*
       * Тейлим свой файл, а не отдаём работу make logs-run.
       *
       * Цель Makefile — это `tail -f $(LOG)` от каталога ПРИЛОЖЕНИЯ, и у
       * установленного colloq её нет вовсе. Верный путь известен строкой выше
       * — по нему же только что проверили, что журнал вообще есть, — а в
       * журнале лежит ссылка входа, к которой отсылает colloq link:
       * промахнуться тут дороже всего.
       */
      const args: string[] = []
      if (follow) args.push('-f')
      if (lines !== undefined) args.push('-n', lines)
      args.push(log)
      return await ctx.sh.run('tail', args)
    },
  },
  {
    name: 'link',
    group: 'local',
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
    name: 'backup',
    group: 'local',
    summary: 'Take a backup: a local one of this machine or a portable k3s one',
    usage:
      'colloq backup [--legacy] [--mode <live|consistent>] [--resume] [--name <environment>] [--out <path>] [--release <path>]',
    flags: [
      { name: 'legacy', summary: 'A local pair of .db and -files.tar.gz (the default)' },
      { name: 'mode', arg: 'mode', summary: 'Portable: live (the default) or consistent' },
      { name: 'resume', summary: 'Portable: start the writers again after consistent' },
      {
        name: 'name',
        arg: 'environment',
        summary: 'Portable backup of an environment: into backups/<environment>/',
      },
      { name: 'out', arg: 'path', summary: 'Portable: where to put the archive' },
      { name: 'release', arg: 'path', summary: 'Portable: which release counts as installed' },
    ],
    destructive: true,
    confirm: 'self',
    delegates:
      './scripts/backup-local.sh · with a portable flag — MODE=… ./scripts/backup.sh; COLLOQ_HOME names the state directory',
    examples: ['colloq backup', 'colloq backup --mode consistent --resume'],
    notes:
      'Without flags it is a local backup: the database and the class files of this machine. The portable one is for a machine with k3s on it, and --mode, --resume, --out, --release or --name lead into it. The question is asked only with --mode consistent: it stops app, the broker and every room and deliberately leaves them down — only --resume brings them back, and a backup that fails leaves the writers down as well. backup.sh restarts itself under scripts/state-lock.py, refuses while .restore-in-progress is there and refuses without an installed release. The local backup (scripts/backup-local.sh) does a VACUUM INTO (sqlite3 required) and an archive with workspace, data/session-secret, data/setup-token and its own environment lists, both files 0600; exit code 1 from tar means "the file changed while it was read", that is a class in progress, and it is allowed. Everything counts from the state directory: backups of this machine live in its backups/, backups of environments in backups/<environment>/.',
    async run(ctx) {
      const given = flag(ctx, 'mode')
      const mode = given ?? 'live'
      const resume = ctx.values.resume === true
      const name = flag(ctx, 'name')
      const out = flag(ctx, 'out')
      const release = flag(ctx, 'release')
      // Переносимую копию назвали вслух: любой её флаг — это просьба о ней.
      const portable =
        given !== undefined ||
        resume ||
        name !== undefined ||
        out !== undefined ||
        release !== undefined
      /*
       * Умолчание — локальная копия.
       *
       * Переносимая имеет смысл там, где стоит k3s: scripts/backup.sh первым
       * делом требует установленный релиз и без него отказывает. У
       * преподавателя, который поставил colloq через pip и ведёт занятие на
       * своём ноутбуке, релиза нет и не будет — `colloq backup` без флагов
       * отвечал бы ему про кластер, которого он не заводил, хотя нужна ему
       * ровно та копия, что делает scripts/backup-local.sh: база и файлы
       * занятия. Обещание команды («снять копию») и отказ про чужой мир
       * несовместимы, и разрешается это в пользу обещания — как у env list.
       *
       * Второй путь не закрыт: кластер обслуживают тем же колесом
       * (scripts/cluster.sh едет туда же), и названный флаг уводит в него.
       * --legacy остаётся словом для тех, кто хочет сказать это вслух.
       */
      const legacy = ctx.values.legacy === true || !portable

      if (legacy) {
        const extra = [
          ['--mode', given !== undefined],
          ['--resume', resume],
          ['--out', out !== undefined],
          ['--release', release !== undefined],
          ['--name', name !== undefined],
        ] as const
        const used = extra.filter(([, on]) => on).map(([option]) => option)
        if (used.length > 0) {
          throw new UsageError(
            used.join(' and ') + ' does not work with --legacy',
            'a local backup is always the same pair in backups/: colloq backup --legacy',
          )
        }
        head(ctx, 'taking a local backup: the database and the files')
        return await copyCall(ctx, './scripts/backup-local.sh')
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
      // backup.sh читает всё окружением (MODE, RESUME, NAME, OUT, RELEASE):
      // аргументов у него нет вовсе.
      return await copyCall(ctx, './scripts/backup.sh', {
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
    summary: 'Restore a backup: a local one of this machine or a portable k3s one',
    usage:
      'colloq restore --archive <file> --release <file> [--replace] [--recover] [--name <environment>] | colloq restore --legacy --db <file> [--files <archive>] [--name <environment>] [--replace]',
    flags: [
      { name: 'archive', arg: 'file', summary: 'The portable backup, a .tar.gz' },
      { name: 'release', arg: 'file', summary: 'release.json of the same generation' },
      { name: 'legacy', summary: 'A local pair of .db and -files.tar.gz' },
      { name: 'db', arg: 'file', summary: 'The database from a local backup' },
      { name: 'files', arg: 'archive', summary: 'Class files from a local backup' },
      {
        name: 'name',
        arg: 'environment',
        summary: 'Backup of an environment: from backups/<environment>/',
      },
      {
        name: 'replace',
        summary: 'Restore over the current database (--yes does not grant this)',
      },
      { name: 'recover', summary: 'Finish an interrupted restore' },
    ],
    destructive: true,
    confirm: 'self',
    delegates:
      './scripts/restore.sh <db> [<files>] · ./scripts/restore.sh --archive … --release …; COLLOQ_HOME names the state directory',
    examples: [
      'colloq restore --legacy --db backups/colloq-20260914.db --files backups/colloq-20260914-files.tar.gz',
      'colloq restore --archive backups/{env}/colloq-20260914.tar.gz --release release.json',
    ],
    notes:
      'The portable path asks nothing on its own — we ask; the local one asks for itself (scripts/restore.sh), and we do not ask a second time. The two worlds must not be mixed: restore.sh rejects an old pair laid on top as soon as a k3s release is installed. The local path refuses if the colloq service is active, the compose app is running, .colloq.pid is alive, or somebody answers on localhost:<PORT>. WAL and SHM travel with their own database, the old database is set aside as data/colloq.db.replaced-<stamp>, and the files from the archive go over workspace/ without a backup of their own. Relative paths count from the directory the command was called from.',
    async run(ctx) {
      const legacy = ctx.values.legacy === true
      const archive = flag(ctx, 'archive')
      const release = flag(ctx, 'release')
      const db = flag(ctx, 'db')
      const files = flag(ctx, 'files')
      const name = flag(ctx, 'name')
      const recover = ctx.values.recover === true
      // --yes снимает наш вопрос, и только его. Положить копию поверх живой
      // базы и поверх workspace/ — отдельное разрешение, и называют его
      // отдельно: --replace.
      const replace = ctx.values.replace === true
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
        const used = wrong.filter(([, given]) => given).map(([option]) => option)
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
        // Как у цели restore-legacy: пути — аргументами, имя среды и
        // разрешение — окружением. Пустого аргумента быть не должно: скрипт
        // разбирает их по расширению и на пустой строке умирает «не понимаю «»».
        return await copyCall(
          ctx,
          './scripts/restore.sh',
          { NAME: name, REPLACE: replace ? '1' : undefined },
          filesPath === undefined ? [dbPath] : [dbPath, filesPath],
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
      // Как у цели restore: --archive, --release и два ключа-переключателя —
      // аргументами, имя среды — переменной.
      return await copyCall(ctx, './scripts/restore.sh', { NAME: name }, [
        '--archive',
        archivePath,
        '--release',
        releasePath,
        ...(replace ? ['--replace'] : []),
        ...(recover ? ['--recover'] : []),
      ])
    },
  },
]
