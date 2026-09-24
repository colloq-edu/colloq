import 'dotenv/config'
import { readLeaseUrl } from './local/public-url-lease.js'
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { normalizeLocale } from '@shared/i18n'

function env(name: string, fallback: string): string {
  const value = process.env[name]
  return value === undefined || value === '' ? fallback : value
}

/*
 * Anchored to this file rather than to process.cwd(). These two defaults used
 * to be resolve(cwd, '../workspace') and '../data', which are only right when
 * the process was started from server/: launched from the repo root instead,
 * the server silently created a workspace directory *beside* the repo and then
 * listed that, while the kernel container kept writing into the real one — a
 * cell would report success and its file would never appear.
 *
 * src/config.ts and the bundled dist/server.js both sit two levels under the
 * root, so one expression covers dev and a local production build. The
 * container sets DATA_DIR and WORKSPACE_DIR explicitly and never gets here.
 */
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const dataDir = path.resolve(env('DATA_DIR', path.join(repoRoot, 'data')))
const workspaceDir = path.resolve(env('WORKSPACE_DIR', path.join(repoRoot, 'workspace')))

/**
 * The data directory is 0700, and this is the only place that says so.
 *
 * Inside lie the teachers' sign-in keys, the instance's model key and the
 * setup token. Three parties used to create the directory — this module,
 * db.ts and admin/auth.ts — and only one of them set `mode`; and
 * `mkdirSync(mode)` on an already existing directory does NOTHING. Whoever
 * called first won, and that was always config.ts (it loads before db.ts):
 * the directory came out 0755 while a comment in db.ts promised "0700, closed
 * to everyone". The files themselves are 0600, so nothing leaked — but a
 * promise in code must be true, otherwise the next person to put something
 * less careful here will trust it.
 *
 * chmod separately from mkdir: that is what fixes a directory created by a
 * previous version (and by `make dirs`, which creates it before us). In a try
 * — on a shared folder owned by someone else chmod will refuse, and that is no
 * reason not to start.
 */
export function ensureDataDir(): string {
  fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 })
  try {
    fs.chmodSync(dataDir, 0o700)
  } catch {
    /* not our directory — carry on as is, the files are 0600 anyway */
  }
  return dataDir
}

/*
 * The signing key outlives the process.
 *
 * It used to be `crypto.randomBytes(24)` per boot, which is fine for a service
 * nobody is sitting in and wrong for this one: the key signs participant
 * tokens, so restarting the server mid-seminar invalidated every token in the
 * room at once. Every student's socket was refused from then on — no error, no
 * reconnect, just a room that had gone quiet — and each of them had to reload
 * and retype their name, arriving as a new person with a new colour. The owner
 * was signed out of the panel in the same instant.
 *
 * A crash, `docker compose restart` and a deploy all land here, so the key is
 * generated once and kept. 0600 at creation rather than a chmod afterwards:
 * there must be no moment when it is readable and already holds the secret.
 * SESSION_SECRET still wins when it is set, which is how you rotate it — or
 * share one key across several replicas.
 */
function persistedSecret(): string {
  const file = path.join(dataDir, 'session-secret')
  try {
    const existing = fs.readFileSync(file, 'utf8').trim()
    if (existing) return existing
  } catch {
    /* first boot, or the file was removed to force a rotation */
  }
  const secret = crypto.randomBytes(32).toString('hex')
  ensureDataDir()
  fs.writeFileSync(file, secret + '\n', { mode: 0o600 })
  return secret
}

/*
 * The address at which the room is visible from outside — reread.
 *
 * It used to be a constant read once at startup, and `make host` used it the
 * other way round: on Ctrl+C the script puts PUBLIC_URL in .env back to
 * localhost, while the live server keeps handing out an https link to a
 * tunnel that no longer exists. The teacher copies the address from the panel
 * and sends it to the group — the address opens for nobody, the teacher
 * included.
 *
 * The file is reread at most once every two seconds: it is asked for on every
 * link in the seminar list, and it changes twice in the life of the process.
 */
const envFile = path.join(repoRoot, '.env')
let publicUrlCache: { at: number; value: string } | null = null

function readPublicUrl(): string {
  const fallback = `http://localhost:${env('PORT', '3000')}`
  if (process.env.COLLOQ_LOCAL_SESSION === '1') {
    const local = (process.env.COLLOQ_LOCAL_URL || fallback).replace(/\/+$/, '')
    const lease = process.env.COLLOQ_PUBLIC_URL_LEASE_FILE
    const runId = process.env.COLLOQ_LOCAL_RUN_ID
    return (lease && runId ? readLeaseUrl(lease, runId) : null) || local
  }
  const now = Date.now()
  if (publicUrlCache && now - publicUrlCache.at < 2000) return publicUrlCache.value

  /*
   * The file outranks the environment variable — and that is not a typo.
   *
   * It used to be the other way round, "as usual", and that broke exactly what
   * the whole thing was for: `make run` and `scripts/host.sh` do
   * `set -a; . ./.env` before starting node, so PUBLIC_URL is always already in
   * process.env — and the file that host.sh edits on Ctrl+C was never reread.
   *
   * In the container there is no .env alongside (the image does not copy it),
   * and PUBLIC_URL comes through compose — there the variable is read, as
   * before. So the rule is simple: where the file exists, it wins; where it
   * does not, the environment does.
   */
  let value = ''
  try {
    const line = fs
      .readFileSync(envFile, 'utf8')
      .split('\n')
      .reverse()
      .find((l) => /^\s*PUBLIC_URL\s*=/.test(l))
    if (line) value = line.slice(line.indexOf('=') + 1).trim().replace(/^['"]|['"]$/g, '')
  } catch {
    /* no .env — that is normal */
  }
  if (!value) value = process.env.PUBLIC_URL ?? ''
  const resolved = (value || fallback).replace(/\/+$/, '')
  publicUrlCache = { at: now, value: resolved }
  return resolved
}

/**
 * The Jupyter token from .env.example — that is, known to everyone who has
 * seen the repository.
 *
 * A default is needed: without it `make run` on a laptop would not come up at
 * all. But it is also the password to the container with the files of all
 * seminars: `make up` writes out a random one when it creates .env, while
 * `cp .env.example .env` by hand or a .env left over from last spring keep
 * this one. For the sake of one warning line at startup
 * (`server/src/index.ts` · announceJupyterToken) the value is named here
 * rather than repeated as a second literal at the other end of the process.
 */
export const DEV_JUPYTER_TOKEN = 'colloq-dev-token'

export const config = {
  uiLanguage: normalizeLocale(process.env.UI_LANGUAGE),
  port: Number(env('PORT', '3000')),
  get publicUrl(): string {
    return readPublicUrl()
  },

  /** Signs participant tokens, host tokens and the staff cookie. See sessionSecret(). */
  // `||` rather than a fallback argument: persistedSecret() writes a file, and
  // an install that sets the key explicitly should not have one made for it.
  sessionSecret: env('SESSION_SECRET', '') || persistedSecret(),

  dataDir,
  workspaceDir,
  /** Built frontend, served by this process in production. Empty in dev (Vite serves it). */
  staticDir: env('STATIC_DIR', ''),

  jupyter: {
    url: env('JUPYTER_URL', 'http://localhost:8888').replace(/\/+$/, ''),
    token: env('JUPYTER_TOKEN', DEV_JUPYTER_TOKEN),
  },

  /**
   * The organisation that deployed the instance: the line next to the logo on
   * every screen. At one address it is a university, at another a bank, at a
   * third nothing is needed — so the default is empty, and then the logo
   * stays a single word, without the dividing rule.
   *
   * Eighty characters — the same ceiling as the model name in the room rules
   * (shared/rules.ts). Trimmed here, not in the layout, because the cost of a
   * long string is not only in the header: it travels in every response about
   * a seminar and lands in every browser's localStorage as part of the room
   * card. In the header it also sits in one line with the logo and takes all
   * the remaining width — an ellipsis saves the layout, but the seminar name
   * next to a paragraph is still left with nothing. The old hard-coded string
   * was forty-four characters; eighty is twice any real name and still a
   * line, not a paragraph.
   */
  institution: env('INSTITUTION', '').trim().slice(0, 80),

  /**
   * Prefills the claim form on a fresh instance. It is a suggestion, not a
   * credential: the setup token is what proves ownership, and the owner can
   * type any address. Empty is fine — the form just starts blank.
   */
  adminEmail: env('ADMIN_EMAIL', ''),

  /**
   * Whether anyone may create a seminar through the API — POST /api/sessions
   * with no staff cookie. There is no screen for it: `/` goes to the panel, so
   * this is a switch for scripting.
   *
   * Off by default now that there is a staff list: an open instance means any
   * visitor can spin up a room and spend the owner's API key. The line above
   * used to promise a home screen with a "create a seminar" button on it — the
   * screen was taken out and the promise stayed, so the flag read as a way to
   * bring an interface back rather than as what it is.
   */
  openSeminarCreation: env('OPEN_SEMINAR_CREATION', 'false') === 'true',

  ai: {
    provider: env('AI_PROVIDER', 'openai'),
    apiKey: env('OPENAI_API_KEY', ''),
    baseUrl: env('OPENAI_BASE_URL', 'https://api.openai.com/v1'),
    model: env('OPENAI_MODEL', 'gpt-4o-mini'),
    /**
     * Whether to ask the model for its reasoning as a separate field.
     *
     * Off. It used to be "always on OpenRouter", and that quietly doubled the
     * bill: for reasoning models the trace costs as much as the answer, and
     * sometimes more, and it was requested for every question — including
     * "explain this error", where there is nothing to think about. The trace
     * is still visible when the provider returns it on its own; this is only
     * about whether to pay extra for it.
     */
    reasoning: env('AI_REASONING', 'false') === 'true',
  },

  maxUploadBytes: Number(env('MAX_UPLOAD_MB', '50')) * 1024 * 1024,

  /**
   * A ceiling for the whole room, not for one file.
   *
   * The limit used to be per file only: fifty megabytes at a time and a
   * hundred uploads make five gigabytes in one seminar. The disk here is
   * shared with the database, notebook snapshots and environment images, and
   * it runs out silently and for everyone at once. A gigabyte is twenty
   * maximum-size files; a real seminar does not need that much, and it is
   * enough to stop someone whose foot slipped on the key.
   */
  maxSessionBytes: Number(env('MAX_SESSION_MB', '1024')) * 1024 * 1024,

  /**
   * How much memory one council attempt may spend on personal copies of data
   * (kernel/council-isolation.ts).
   *
   * The ceiling is needed because a room has one kernel and its memory is
   * shared: without it the teacher's `arr = np.zeros(2_000_000_000)` would
   * turn every attempt into a 16 GB copy and kill the kernel in the middle of
   * the class period for everyone at once. The most frequent and the heaviest
   * case in a seminar — a big pandas table — does not count toward this at
   * all: with Copy-on-Write the copy costs O(1).
   *
   * Whatever did not fit under the ceiling stays shared, and the attempt is
   * told so with a line in its output: quiet half-way isolation is worse than
   * honestly named isolation.
   */
  councilCopyBytes: Number(env('COUNCIL_COPY_MB', '512')) * 1024 * 1024,

  /**
   * Whether to put an address-space ceiling on a council attempt.
   *
   * Without it `np.ones((40000, 40000))` or an unlucky Cartesian join calls
   * the OOM killer, and that kills the kernel of the WHOLE room: the teacher's
   * review, the data of everyone who has already submitted, and the queue
   * along with them. Under the ceiling the same thing ends with a
   * `MemoryError` in one attempt, and the class goes on.
   *
   * The ceiling is computed from the container's limit minus what is already
   * used and a reserve for the kernel; without Linux, without a cgroup, or
   * with CUDA nearby there is no ceiling at all (the driver reserves terabytes
   * of virtual addresses and does not come up under RLIMIT_AS). The switch
   * here is for an environment where this calculation lies.
   */
  councilMemoryGuard: env('COUNCIL_MEMORY_GUARD', '1') !== '0',

  /** How often an idle-but-dirty document is written to disk. */
  snapshotIntervalMs: 1500,
  /** Coalescing window for kernel stdout/stderr before it hits the CRDT. */
  outputFlushMs: 50,

  /*
   * How long a kernel may say nothing before this server asks Jupyter whether
   * it is still alive — see JupyterKernel.confirmAlive(). Settable because the
   * test that covers a kernel dying silently would otherwise spend fifteen
   * seconds waiting for the room to notice; nothing else has a reason to touch
   * these.
   */
  kernelQuietMs: Number(env('KERNEL_QUIET_MS', '10000')),
  kernelWatchdogMs: Number(env('KERNEL_WATCHDOG_MS', '5000')),
} as const

export const aiEnabled = () => config.ai.apiKey.length > 0
