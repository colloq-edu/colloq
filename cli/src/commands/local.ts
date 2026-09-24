/**
 * Locally: the class on this machine: start, end, restart, look at the log
 * and the address, take and restore a backup.
 *
 * Commands: run (also start), stop, restart, logs, link, backup, restore. The
 * order here is the order in help. This is everything a teacher runs a class
 * with on their laptop after `pip install colloq`; the workshop (the docker
 * stack, the build, tests, a shell in the kernel) is not here. It lives in the
 * Makefile and scripts/, and is called there directly: a wrapper over it from
 * the wheel only printed `make …`, which the package does not have.
 *
 * A command behaves the same wherever the CLI was started from, the wheel or
 * the sources. ctx.dist decides exactly one thing: what to call the supervisor
 * with (launcher below). Let the fork creep into behaviour, and what was
 * tested in a clone turns out to be a different command for the teacher: that
 * already happened with backup and stop.
 *
 * node:child_process and node:fs must not be imported: only ctx.sh and ctx.io.
 * Otherwise the test stops being hermetic, and cli-core guards that.
 *
 * The work goes to whoever knows it: the class to the supervisor, backups to
 * scripts/backup-local.sh, scripts/backup.sh and scripts/restore.sh. Checks
 * that already stand there (a live server under restore, no release under a
 * portable backup, the state lock) are not repeated here: they are put more
 * precisely there, and their stderr goes out as is.
 */
import type { Command, Ctx } from '../registry.js'
import { cancelled, heading as head, UsageError } from '../ui.js'
import { envNameOk, joinPath } from '../env.js'
import { readSession, type Session } from '../session.js'
import { hostNameOk } from './host.js'
import { leaseUrl } from '../../../shared/local-public-url-lease.js'

/** Our own question: "no" is a DIM "cancelled" and code 4. --yes and --dry-run answer "yes". */
async function ask(ctx: Ctx, question: string): Promise<boolean> {
  if (await ctx.confirm(question)) return true
  cancelled(ctx.ui)
  return false
}

/** The value of a string flag; an empty string is as good as not said. */
function flag(ctx: Ctx, name: string): string | undefined {
  const raw = ctx.values[name]
  return typeof raw === 'string' && raw !== '' ? raw : undefined
}

/**
 * Where the class data lies, as an explicit environment variable for the
 * scripts.
 *
 * scripts/backup.sh and scripts/restore.sh cd to themselves and, without a
 * hint, take data/ and workspace/ from the APPLICATION directory, putting the
 * archive into <app>/backups. For an installed colloq there is neither the
 * database nor the class files there: a backup would be taken from an empty
 * place, and a restore would land beside the real database, and both
 * troubles are silent.
 *
 * So we name the state root ourselves, and always: in a clone home is the
 * root, and the line changes nothing, but then there is no fork that one must
 * remember to repeat in the next command.
 */
function stateEnv(ctx: Ctx): Record<string, string> {
  return { COLLOQ_HOME: ctx.env.paths.home }
}

/**
 * Take or restore a backup with the script itself, not with a Makefile
 * target.
 *
 * The targets backup, backup-legacy, restore and restore-legacy are one- or
 * two-line wrappers over these same scripts, but the Makefile does not travel
 * into the wheel and never will: `colloq backup --dry-run` from the wheel
 * printed `make backup MODE=live`, a command that dies there with code 127,
 * and this is the only way to carry a class off the machine. Checked live.
 * The scripts do travel (scripts/pack.mts · SCRIPTS), so we call them directly
 * and the same way the target would: what the target passes as an argument
 * goes as an argument, what it passes as a variable goes in the environment.
 *
 * Empty values do not go into the environment: the script does not
 * everywhere tell "not said" from an empty string, and an extra `NAME=` in
 * the --dry-run line only confuses.
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

/** An environment name: the same sieve as scripts/backup.sh and scripts/restore.sh (env.envNameOk). */
function checkName(name: string | undefined): void {
  if (name === undefined) return
  if (!envNameOk(name)) {
    throw new UsageError(
      'environment name "' + name + '" is not valid',
      'letters, digits and a hyphen in the middle: --name lab',
    )
  }
}

/** The number of tail lines: only a positive whole number. */
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
 * The receipt of the running class, or null if there is no class.
 *
 * There is one path: ctx.env.paths.sessionFile, resolved from the STATE
 * directory. This used to say ctx.env.path('.colloq/local-session.json'), that
 * is, from the APPLICATION directory, and for an installed colloq that
 * diverged silently: the supervisor writes the receipt into ~/.colloq, while
 * stop, restart and link looked for it in site-packages and did not find it.
 * Checked live: with the server running, `colloq stop` answered "no class is
 * running — nothing to stop".
 *
 * The parsing is not our own either: readSession is one for all readers of
 * the receipt (link, status, doctor). A second copy of the checks would drift
 * apart from them on the very first edit of the format, exactly the way the
 * paths once drifted apart.
 *
 * What is not here is pid liveness: session.ts deliberately does not go to
 * processes, and whoever needs it asks about it (sessionAddress below,
 * through ctx.sh).
 */
function localSession(ctx: Ctx): Session | null {
  return readSession(ctx.io, ctx.env.paths.sessionFile)
}

async function sessionAddress(
  ctx: Ctx,
): Promise<{ local: string; public: string | undefined } | undefined> {
  const session = localSession(ctx)
  if (session === null) return undefined
  // We show the public address only for a live class: the receipt for a
  // temporary address survives a crash of the supervisor, and a dead session
  // would name a link nobody will answer at any more.
  const alive = await ctx.sh.capture('kill', ['-0', String(session.pid)], { timeoutMs: 4000 })
  const publicUrl =
    alive.code === 0 && session.leaseFile !== ''
      ? leaseUrl(ctx.io.readText(session.leaseFile), session.runId, ctx.io.now())
      : undefined
  return { local: session.url, public: publicUrl }
}

/**
 * The port and the tunnel name are checked before the supervisor starts.
 *
 * An empty value is an error too, not "the default": `--port ''` most often
 * means an empty variable in someone's script, and silently taking 3000 would
 * mean bringing the class up somewhere other than where it is expected.
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
  // Two ways out at once mean two tunnels on one address receipt. The same
  // refusal stands in the supervisor too (launch-config.ts · parseLaunchArgs),
  // but here it comes with code 2 and before any start.
  if (ctx.values.share === true && host !== undefined) {
    throw new UsageError(
      '--share and --host do not work together',
      'colloq start --share for a quick link, or colloq start --host class.example.org for your own name',
    )
  }
}

/**
 * What to call the class supervisor with: the source or the bundle.
 *
 * From the sources it is `cli/src/launch.ts` through tsx: the source gets
 * edited, and running it through a build on every start would put a build
 * between the edit and the check. A distribution has neither the source nor
 * tsx at all: there lies a single built `cli/launch.mjs`, and it must be
 * called with bare node.
 *
 * While this fork did not exist, `colloq start` from the wheel printed the
 * path `…/_app/cli/src/launch.ts` and fell over: no file, no tsx. Checked with
 * `colloq start --dry-run` from an installed wheel.
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
    // Asking "stop the server?" only to say "nothing to stop" right after means
    // asking for nothing: only a running class gets the question.
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
       * No receipt means no class either.
       *
       * A class started by colloq is exactly one, its own, with a receipt, and
       * the absence of the receipt means there is nothing to stop. A server
       * brought up bypassing colloq (make run, docker compose) is the
       * workshop's concern, and shutting it down with the same word would mean
       * guessing at someone else's. Code 0: the request "let nothing be
       * running" is already fulfilled.
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
         * No receipt means nothing to restart, and we answer in words.
         *
         * Once, parsing of the old forms started here (docker, the service,
         * the pid file) along with calls of make. A teacher has none of that,
         * and a person got "make: *** No rule to make target `stop`" with a
         * live pid file right there, and the restart looked meaningful. The
         * refusal is code 3, under --dry-run too: there would be nothing to
         * execute.
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
         * The supervisor creates the log on every `colloq start`, both in the
         * terminal and in the background (launch.ts · runSession and
         * detached). No file means no class has been started on this machine
         * yet, and there is exactly one piece of advice: start one. We name
         * the path in full: for an installed colloq it is in the state
         * directory, not in the person's working folder.
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
       * We tail our own file rather than hand the job to make logs-run.
       *
       * The Makefile target is `tail -f $(LOG)` from the APPLICATION
       * directory, and an installed colloq does not have it at all. The right
       * path is known from the line above (by it we have just checked that
       * the log exists at all), and the log holds the sign-in link that
       * colloq link refers to: missing here costs the most.
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
       * We name the paths in full, not ".colloq.log" and "data/setup-token".
       *
       * A relative name implies that there is one root. For an installed
       * colloq the log and the token lie in the state directory (~/.colloq),
       * while the person looks for them in their working folder, does not find
       * them and decides the sign-in was not saved, although the link is in
       * place.
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
      // The portable backup was named out loud: any of its flags is a request for it.
      const portable =
        given !== undefined ||
        resume ||
        name !== undefined ||
        out !== undefined ||
        release !== undefined
      /*
       * The default is a local backup.
       *
       * A portable one makes sense where k3s is installed: scripts/backup.sh
       * first of all demands an installed release and refuses without one. A
       * teacher who installed colloq through pip and runs a class on their
       * laptop has no release and never will: `colloq backup` without flags
       * would answer them about a cluster they never set up, while what they
       * need is exactly the backup scripts/backup-local.sh makes: the database
       * and the class files. The command's promise ("take a backup") and a
       * refusal about someone else's world are incompatible, and this is
       * resolved in favour of the promise, as with env list.
       *
       * The second path is not closed: a cluster is maintained with the same
       * wheel (scripts/cluster.sh travels there as well), and a named flag
       * leads into it. --legacy stays a word for those who want to say it out
       * loud.
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
      // backup.sh reads everything from the environment (MODE, RESUME, NAME,
      // OUT, RELEASE): it has no arguments at all.
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
      // --yes removes our question, and only it. Laying a backup over the live
      // database and over workspace/ is a separate permission, and it is named
      // separately: --replace.
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
        // People stop reading a second question in a row: here the script
        // itself asks.
        head(ctx, 'restoring an old-format backup')
        // As in the restore-legacy target: the paths as arguments, the
        // environment name and the permission in the environment. There must be
        // no empty argument: the script sorts them by extension and on an empty
        // string dies with "I do not understand """.
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
      // As in the restore target: --archive, --release and the two switches as
      // arguments, the environment name as a variable.
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
