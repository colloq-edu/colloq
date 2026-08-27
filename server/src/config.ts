import 'dotenv/config'
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'

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
  fs.mkdirSync(dataDir, { recursive: true })
  fs.writeFileSync(file, secret + '\n', { mode: 0o600 })
  return secret
}

export const config = {
  port: Number(env('PORT', '3000')),
  publicUrl: env('PUBLIC_URL', `http://localhost:${env('PORT', '3000')}`).replace(/\/+$/, ''),

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
    token: env('JUPYTER_TOKEN', 'colloq-dev-token'),
  },

  /**
   * Prefills the claim form on a fresh instance. It is a suggestion, not a
   * credential: the setup token is what proves ownership, and the owner can
   * type any address. Empty is fine — the form just starts blank.
   */
  adminEmail: env('ADMIN_EMAIL', ''),

  /**
   * Whether anyone with the URL may still create a seminar from the home
   * screen. Off by default now that there is a staff list: an open instance
   * means any visitor can spin up a room and spend the owner's API key.
   */
  openSeminarCreation: env('OPEN_SEMINAR_CREATION', 'false') === 'true',

  ai: {
    provider: env('AI_PROVIDER', 'openai'),
    apiKey: env('OPENAI_API_KEY', ''),
    baseUrl: env('OPENAI_BASE_URL', 'https://api.openai.com/v1'),
    model: env('OPENAI_MODEL', 'gpt-4o-mini'),
  },

  maxUploadBytes: Number(env('MAX_UPLOAD_MB', '50')) * 1024 * 1024,

  /**
   * Потолок на всю комнату, а не на один файл.
   *
   * Ограничение было только на файл: пятьдесят мегабайт за раз и сто заходов
   * дают пять гигабайт на одном семинаре. Диск здесь общий с базой, снимками
   * тетрадей и образами окружений, и кончается он молча и сразу для всех.
   * Гигабайт — это двадцать предельных файлов; настоящему семинару столько не
   * нужно, а промахнувшемуся ногой по клавише хватит, чтобы остановиться.
   */
  maxSessionBytes: Number(env('MAX_SESSION_MB', '1024')) * 1024 * 1024,

  /** How often an idle-but-dirty document is written to disk. */
  snapshotIntervalMs: 4000,
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
