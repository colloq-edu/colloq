/**
 * The class on the network: how the audience gets to this machine.
 *
 * There is one command, host: expose the class that is already running and
 * get a link. The relay, the DNS zone, the named Cloudflare tunnel and the
 * load test rig are not part of it: they install and edit other machines and
 * the zone, that is the workshop, and it lives in the Makefile and scripts/.
 * Of all that, a teacher after `pip install colloq` needs only the link.
 *
 * host goes straight to scripts/host.sh, the same way from the wheel and from
 * the sources; the reasoning is at publishCall below. We name the state
 * directory to the script ourselves: stateEnv.
 *
 * Three things that are deliberately not done here.
 *
 * No instance is brought up. host.sh publishes what is already running: if
 * /api/health is silent, it dies with an instruction. A second instance is a
 * second database, and creating one instead of the person is not allowed.
 *
 * A short name is not completed. Only the relay extends it to RELAY_DOMAIN,
 * and host.sh decides that: the CLI, guessing the zone, would send the class
 * off to Cloudflare, and Cloudflare does not open from Russia.
 *
 * The script's refusals are not rewritten. Our own checks run only before the
 * first action and only about what is visible from here: whether there is a
 * name, whether it looks like a name, whether there is a .env.
 *
 * The order: check the name (check, the framework calls it before the
 * question) → the framework's question → --dry-run → .env → a one-line header
 * → the script. The check comes before the question: asking "install caddy for
 * this name?" only to say "this is not a name" afterwards means asking for
 * nothing.
 *
 * node:child_process and node:fs must not be imported: only ctx.sh and ctx.io.
 */
import type { Command, Ctx } from '../registry.js'
import { PreconditionError, UsageError } from '../ui.js'

/**
 * The perimeter of a local class, said out loud, in the same words in two
 * places.
 *
 * They have to be said where the person decides whom to let in: in `colloq
 * host` (right now they are opening the class to the outside) and in `colloq
 * doctor` (before class).
 *
 * What is true here and why exactly so. This used to say "no production
 * limits: the network to the outside is open, privileges are not dropped",
 * and that was true while the room container was bare. Now publishing to the
 * outside is possible at all only with kernel isolation (the author's
 * decision: a lock in host.sh and in the supervisor,
 * cli/src/launch-share.ts), and the room containers themselves are hardened:
 * privileges are dropped, the number of processes is limited, the home
 * network and the machine itself cannot be reached from a room
 * (server/src/kernel/perimeter.ts). What stays true even after that: the link
 * is a door. Whoever got it runs code in a sandbox on this computer, so the
 * link is for your own class, and Ctrl+C closes it.
 *
 * There are exactly two lines, both short: the name of the perimeter, and the
 * price together with the way out. One long sentence does not get read (in
 * doctor it also does not fit on the line next to the label), and a third
 * line turns the warning into a paragraph that gets scrolled past. The words
 * are the same on purpose: doctor and host speak about one thing.
 *
 * The CLI does not know the shared/locales directory: tr() lives in server and
 * web and does not reach here, so CLI strings are written right where they are
 * printed. That is why the words about the perimeter lie in an ordinary
 * constant here, and doctor imports it from here: the two places must not
 * drift apart.
 */
export const PERIMETER = {
  what: 'student code runs in a hardened container per room, cut off from your home network',
  fix: 'the link is a door: anyone who has it runs code in a sandbox on this computer — keep it for your class; Ctrl+C closes it',
} as const

/** A name in DNS: latin letters, digits, dots and hyphens; a certificate will be issued for it. */
const NAME = /^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$/

export function hostNameOk(host: string): boolean {
  return NAME.test(host)
}

/** The class name as written; an empty one means a quick tunnel with a random name. */
function nameOf(ctx: Ctx): string {
  return (ctx.positionals[0] ?? '').trim()
}

function directOf(ctx: Ctx): boolean {
  return ctx.values.direct === true
}

/**
 * The check before the question: direct mode requires a name, and any name
 * must be fit for DNS. A usage refusal is code 2, as in all groups; the
 * framework prints it in three lines: what happened, what caused it, what to
 * do.
 */
function checkName(ctx: Ctx): void {
  const host = nameOf(ctx)
  if (directOf(ctx) && !host) {
    throw new UsageError(
      'direct mode needs a name',
      'colloq host class.example.org --direct',
      'the certificate is issued for that name, and it cannot be made up for you',
    )
  }
  if (host && !hostNameOk(host)) {
    throw new UsageError(
      'name ' + host + ' will not do',
      'colloq host class.example.org',
      'a name holds only latin letters, digits, dots and hyphens',
    )
  }
}

/**
 * Without .env there is no way to learn the port, the relay or the zone token.
 *
 * The advice here used to be impossible to follow: "cp .env.example .env",
 * a relative path, that is, in whatever directory the person is standing in,
 * and an installed package has no .env.example at all. The first `colloq
 * start` creates .env and puts it into the state directory, right where we
 * look for it (cli/src/launch-config.ts · localClassEnv), the same way from
 * the wheel and from the sources; that is where we send people, with one
 * piece of advice.
 */
function needEnv(ctx: Ctx): void {
  if (ctx.io.exists(ctx.env.paths.envFile)) return
  throw new PreconditionError(
    'no ' + ctx.env.paths.envFile + ' — PORT, RELAY_* and CF_TOKEN are read from it',
    'colloq start creates it on the first run',
  )
}

/**
 * The state directory goes to the child as an explicit variable.
 *
 * The scripts took the directory above scripts/ as their root and looked there
 * for .env, the class receipt and .colloq.pid. For an installed colloq there
 * is only the application there: publishing "succeeded", PUBLIC_URL went off
 * into a file nobody reads, and `colloq link` looked into <home>/.env and said
 * that nothing was exposed. Now the state root is named to the scripts out
 * loud (scripts/lib.sh · COLLOQ_STATE_ROOT).
 *
 * We always name it, not only in the package. In the sources home is the
 * root, and the variable changes nothing there, but then there is no fork
 * "when they coincide, do not send it" that one must remember to repeat in
 * the next command. copies and link live by the same rule:
 * cli/src/commands/local.ts · stateEnv.
 */
function stateEnv(ctx: Ctx): Record<string, string> {
  return { COLLOQ_HOME: ctx.env.paths.home }
}

/**
 * The publishing call: scripts/host.sh itself, always.
 *
 * The Makefile targets host and host-direct are two lines over the same
 * script, but the Makefile does not travel into the wheel, and `colloq host`
 * died with "make: command not found" on the one command the class gets its
 * link from. The script meanwhile lies right there (scripts/pack.mts ships
 * scripts/), so we call it directly and with the same variables the target
 * would have set. From the sources, the same: a CLI that behaves differently
 * depending on where it came from is tested half as well, and the workshop
 * Makefile is called by hand anyway.
 *
 * The order of the variables is as in the host-direct target: COLLOQ_DIRECT
 * before COLLOQ_HOSTNAME. People copy the --dry-run line, and it must match
 * the one described in the header of host.sh.
 */
function publishCall(ctx: Ctx, host: string, direct: boolean): Promise<number> {
  const env: Record<string, string> = { ...stateEnv(ctx) }
  if (direct) env.COLLOQ_DIRECT = '1'
  if (host) env.COLLOQ_HOSTNAME = host
  return ctx.sh.script('./scripts/host.sh', [], { env })
}

/**
 * The framework's question: for direct mode always, for a tunnel only in the
 * middle of a class.
 *
 * Direct mode has its own price (caddy on 80 and 443, the A record
 * rewritten), and it is named out loud on every call. A tunnel changes
 * nothing on the machine, and it is worth asking about only when rooms that
 * are already running are waiting for the link.
 */
async function publishWhen(ctx: Ctx): Promise<boolean> {
  return directOf(ctx) || (await ctx.rooms()) > 0
}

/** The question names the price, and it depends on the transport and on the name. */
function publishQuestion(ctx: Ctx): string {
  const host = nameOf(ctx)
  return directOf(ctx)
    ? 'install caddy on 80 and 443 and rewrite the A record for ' + host + '?'
    : 'publish ' + (host || 'the class') + '?'
}

/** A one-line header: where the class will go and what it costs. */
function headline(ctx: Ctx, host: string, direct: boolean): string {
  if (direct) return 'installing caddy on this machine: it holds 80 and 443 for ' + host
  const domain = ctx.env.relay().domain
  if (host && domain && (host === domain || host.endsWith('.' + domain))) {
    return 'publishing ' + host + ' through the relay: keep this window open'
  }
  if (host) return 'publishing ' + host + ' through Cloudflare, which does not open from Russia'
  return 'publishing through a quick Cloudflare tunnel: the name is random, and it does not open from Russia'
}

export const commands: Command[] = [
  {
    name: 'host',
    aliases: ['public'],
    group: 'host',
    summary: 'Publish the running class and get a link',
    usage: 'colloq host [name] [--direct]',
    args: [
      {
        name: 'name',
        summary: 'Class address, e.g. class.example.org. Without a name: a quick tunnel',
      },
    ],
    flags: [{ name: 'direct', summary: 'caddy on this machine itself, without the relay' }],
    destructive: true,
    confirm: 'cli',
    check: checkName,
    confirmWhen: publishWhen,
    confirmQuestion: publishQuestion,
    delegates:
      'COLLOQ_HOSTNAME=<name> ./scripts/host.sh (with --direct: COLLOQ_DIRECT=1 as well)',
    examples: ['colloq host class.example.org', 'colloq host class.example.org --direct'],
    notes:
      'The class must already be running: host.sh publishes, it does not bring anything up — if /api/health is silent, it dies with an instruction. ' +
      'Keep this window open: the tunnel is this very process, and Ctrl+C closes only the tunnel. In a local session the temporary address is taken down without restarting the server and without changing .env. ' +
      'A name under RELAY_DOMAIN goes to the relay; any other name goes silently to Cloudflare, which does not open from Russia. ' +
      'Only the relay completes a short name to RELAY_DOMAIN, and host.sh decides that. ' +
      'The price of --direct: caddy takes 80 and 443, /etc/caddy/Caddyfile and its unit are rewritten, and an A record points the name at this machine; ' +
      'after Ctrl+C the name stays live. It needs Linux, systemd, root and a public address: on macOS the script refuses by itself. ' +
      'host.sh publishes nothing unless the server confirms in /api/health that every room runs in a container of its own (Docker or the runtime broker). ' +
      'Without cloudflared on PATH, the Cloudflare transports get a pinned release downloaded once into <state>/bin and checked by sha256; COLLOQ_CLOUDFLARED=/path names your own file. ' +
      'For a class started here, colloq start --share does all of this in one step and prints the link for students. ' +
      'Two lines about the perimeter are printed under the header: every room is a hardened container cut off from your home network, ' +
      'and the link is still a door to code on this computer. colloq doctor says the same.',
    async run(ctx) {
      const host = nameOf(ctx)
      const direct = directOf(ctx)
      if (ctx.dryRun) return await publishCall(ctx, host, direct)

      needEnv(ctx)
      ctx.ui.header(headline(ctx, host, direct))
      // Right under the header, BEFORE the script's output starts running: the
      // link is handed out after this command, and its price is not only in
      // the tunnel.
      ctx.ui.hint(PERIMETER.what)
      ctx.ui.hint(PERIMETER.fix)
      return await publishCall(ctx, host, direct)
    },
  },
]
