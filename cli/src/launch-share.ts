/**
 * `colloq start --share`: one link for the class, and what stands behind it.
 *
 * The tunnel itself is opened by scripts/host.sh, as with --host: it also
 * keeps the receipt of the temporary address, checks the address from outside
 * and cleans up after itself. Here are three things the script does not have.
 *
 * The lock (publishRefusal). The author's decision: a class goes out to the
 * internet only when every room's kernel sits in its own container. The link
 * is a door: whoever gets it runs code on this computer, and one kernel shared
 * by everyone behind such a door means someone else's code right next to the
 * notebooks of the whole class. The check stands twice, before the start by
 * the settings and before the tunnel by the live server, and a third one, the
 * same in meaning, stands in host.sh: both `colloq host` and `make host`,
 * which do not see the supervisor, go through it.
 *
 * The link block (renderShareBlock). The script prints the tunnel address, but
 * the student needs not that, but the class's /s/<id>, and only the database
 * knows about classes. The block is printed once, when host.sh has said "the
 * address is up and checked" with a marker line (parseShareMarker), and it
 * repeats in one place everything the teacher needs to know about this link.
 *
 * The list of classes (readClasses) comes from the database, read-only. There
 * is no way to ask the server: the list of classes is given only to someone
 * signed in to the panel, and an open route with the list would go into the
 * tunnel along with everything else, since cloudflared reaches the server
 * from the same 127.0.0.1 as we do.
 *
 * The name starts with launch: the test rig tests/local-launch-process.test.mts
 * copies cli/src/launch*.ts, and another name would not be found there.
 */
import fs from 'node:fs'
import path from 'node:path'

/** How room kernels are kept apart from each other, in the words of /api/health · isolation. */
type Isolation = 'docker' | 'broker'

export interface PublishCheck {
  /** The server's effective environment: .env plus variables, as the server will see them. */
  env: Record<string, string | undefined>
  /** Whether the docker daemon answers; not asked means undefined. */
  dockerReachable?: boolean
  /** The /api/health answer of the live server; not asked means undefined, no answer means null. */
  health?: Record<string, unknown> | null
}

/**
 * Whether this class may be exposed to the outside: null means yes, a string
 * says why not.
 *
 * The refusal speaks only of what is visible from here. KERNEL_BACKEND
 * defaults to docker: that is how the server picks it without
 * NODE_ENV=production (server/src/kernel/runtime-client.ts ·
 * selectKernelBackend), and that is how the supervisor sets it
 * (launch-config.ts). test is the test backend, without isolation. The last
 * word is the server's: it names what actually keeps the rooms apart in the
 * isolation field, and sets it only when the kernel is ready.
 */
export function publishRefusal(check: PublishCheck): string | null {
  const backend = (check.env.KERNEL_BACKEND ?? '').trim() || 'docker'
  if ((check.env.KERNEL_ISOLATION ?? '').trim().toLowerCase() === 'off')
    return 'KERNEL_ISOLATION=off is set, so the rooms would not be kept apart'
  if (backend !== 'docker' && backend !== 'broker')
    return `KERNEL_BACKEND=${backend} does not give every room a container of its own`
  if (backend === 'docker' && check.dockerReachable === false)
    return 'Docker is not responding, and without it nothing keeps the rooms apart'
  if (check.health !== undefined) {
    const said = check.health?.isolation
    if (said !== (backend as Isolation))
      return typeof said === 'string'
        ? `the server reports room isolation "${said}", not ${backend}`
        : 'the server does not confirm that every room runs in a container of its own'
  }
  return null
}

/** The whole refusal: what happened, why it matters, where the class is now. */
export function refusalText(reason: string, local?: string): string {
  return [
    `Not published: ${reason}.`,
    'A public link lets anyone who has it run code on this computer, so colloq',
    'publishes a class only when every room runs in a Docker container of its own.',
    'Check Docker and KERNEL_BACKEND / KERNEL_ISOLATION in .env, then try again.',
    ...(local ? [`The class keeps running locally: ${local}`] : []),
  ].join('\n')
}

/** The marker line of host.sh under COLLOQ_SHARE=1: the address is up, the outside check passed or not. */
export const SHARE_MARKER = '@colloq-share'

export function parseShareMarker(line: string): { url: string; verified: boolean } | null {
  const match = /^@colloq-share (ok|unverified) (https:\/\/[A-Za-z0-9.-]+)\/?\s*$/.exec(line)
  return match ? { url: match[2]!, verified: match[1] === 'ok' } : null
}

export interface ShareClass {
  id: string
  name: string
}

/**
 * The class name for the terminal: without control bytes and no longer than a
 * line.
 *
 * The name is written by the teacher (or by an import from a spreadsheet), and
 * we print it to the terminal: an ESC inside the name would recolour the
 * screen or erase the line with the link.
 */
function printable(name: string): string {
  // eslint-disable-next-line no-control-regex
  const clean = name.replace(/[\u0000-\u001f\u007f-\u009f]+/g, ' ').trim()
  return clean.length > 48 ? clean.slice(0, 47) + '…' : clean
}

export interface ShareBlock {
  /** The public address of the tunnel, without a trailing /. */
  url: string
  /**
   * The teacher's sign-in on the public address, with the setup token, as
   * with Jupyter (launch-banner.ts · teacherLink). With no token on disk,
   * /admin.
   */
  teacher: string
  /** The local address: the panel on this computer. */
  local: string
  /** The newest classes, no more than three. */
  classes: ShareClass[]
  /** How many classes there are in total (not archived). */
  total: number
  /** The outside check passed; null means it was not checked (a background start). */
  verified: boolean | null
  /** The class went to the background: colloq stop closes it, not Ctrl+C. */
  detached: boolean
  /** RELAY_DOMAIN from .env, so that the advice about Russia is a ready command. */
  relayDomain: string
}

/**
 * The link block. The lines have no colour: they also go into .colloq.log.
 *
 * The order is the order of the teacher's questions: what to give the
 * students; what to give nobody; how long the link lives; why it is different
 * next time; whether it opens in Russia. Each takes one or two lines,
 * otherwise the block gets scrolled past entirely.
 */
export function renderShareBlock(block: ShareBlock): string[] {
  const out: string[] = [
    '',
    `  ┌ Colloq is online at ${block.url}`,
    '  │',
    '  │ Your panel on this address (the link signs you in — keep it to yourself):',
    `  │   ${block.teacher}`,
    '  │',
  ]
  const link = (item: ShareClass): string =>
    `  │   ${block.url}/s/${encodeURIComponent(item.id)}   ${printable(item.name)}`
  if (block.classes.length === 1 && block.total === 1) {
    out.push('  │ Give your students this link:', link(block.classes[0]!))
  } else if (block.classes.length > 0) {
    out.push('  │ Give your students the link of the class you teach (newest first):')
    for (const item of block.classes) out.push(link(item))
    const more = block.total - block.classes.length
    if (more > 0) out.push(`  │   … and ${more} more: the panel lists every class with its link`)
  } else {
    out.push(
      '  │ There is no class yet. Create one in the panel above and copy its link',
      '  │ from the list — the list already gives links on this public address.',
    )
  }
  out.push(
    '  │',
    '  │ Never share a link with /admin/ in it (/admin/t/…, /admin/k/…): it is a',
    '  │ key to the panel. Students only ever get /s/… links.',
  )
  if (block.verified === false)
    out.push(
      '  │',
      '  │ The check from this computer did not get through — usually the DNS of',
      '  │ this network, not the class. Open the link on a phone on mobile data.',
    )
  out.push(
    '  │',
    block.detached
      ? '  │ The link lives until colloq stop, which closes it with the class.'
      : '  │ The link lives while this terminal is open: Ctrl+C closes it and the class.',
    '  │ A quick tunnel gets a new address on every start: send the new link each time.',
    '  │ Cloudflare addresses do not open from Russia. For students there, use a relay:',
    block.relayDomain
      ? `  │   colloq start --host <name>.${block.relayDomain}`
      : '  │   colloq start --host <name> with RELAY_* in .env (see the docs: networking)',
    '  └',
    '',
  )
  return out
}

/**
 * The classes of this database, the newest and not archived; a read error
 * means "no classes".
 *
 * better-sqlite3 is the same driver the server uses, and it already lies in
 * node_modules nearby (in the package the shim installs them, in the
 * repository npm ci does); the import is deferred so that stop and restart do
 * not load the native module for nothing. The database is opened read-only:
 * the server writes it in WAL mode, and a reader does not get in its way. A
 * miss here does not break publishing: the block will say "create a class in
 * the panel", and that will be true up to the classes already created.
 */
export async function readClasses(
  dataDir: string,
  limit = 3,
): Promise<{ classes: ShareClass[]; total: number }> {
  const file = path.join(dataDir, 'colloq.db')
  if (!fs.existsSync(file)) return { classes: [], total: 0 }
  try {
    const { default: Database } = await import('better-sqlite3')
    const db = new Database(file, { readonly: true, fileMustExist: true })
    try {
      const rows = db
        .prepare(
          'SELECT id, name FROM sessions WHERE archived_at IS NULL ORDER BY created_at DESC LIMIT ?',
        )
        .all(limit) as ShareClass[]
      const { total } = db
        .prepare('SELECT COUNT(*) AS total FROM sessions WHERE archived_at IS NULL')
        .get() as { total: number }
      return {
        classes: rows.filter(
          (row) => typeof row.id === 'string' && /^[A-Za-z0-9_-]+$/.test(row.id),
        ),
        total,
      }
    } finally {
      db.close()
    }
  } catch {
    return { classes: [], total: 0 }
  }
}
