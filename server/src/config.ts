import 'dotenv/config'
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

export const config = {
  port: Number(env('PORT', '3000')),
  publicUrl: env('PUBLIC_URL', `http://localhost:${env('PORT', '3000')}`).replace(/\/+$/, ''),

  /** Signs participant tokens. Ephemeral in dev, which logs everyone out on restart. */
  sessionSecret: env('SESSION_SECRET', crypto.randomBytes(24).toString('hex')),

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

  /** How often an idle-but-dirty document is written to disk. */
  snapshotIntervalMs: 4000,
  /** Coalescing window for kernel stdout/stderr before it hits the CRDT. */
  outputFlushMs: 50,
} as const

export const aiEnabled = () => config.ai.apiKey.length > 0
