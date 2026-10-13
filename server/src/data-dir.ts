/**
 * Where the instance keeps its state (DATA_DIR): the database and the keys,
 * the competitions' files, the package sets.
 *
 * ITS OWN MODULE, AND A PURE ONE, for the machines that run submissions for a
 * home instance (docs/architecture/remote-runners.md, «машины для посылок»).
 * Their agent (dist/runner.js) lays its tree out as home lays out DATA_DIR
 * (competitions/storage.ts), so that the paths, the harness and the mounts of
 * `docker run` are home's by construction — and it must reach that layout
 * without config.ts, which reads .env from the working directory when it
 * loads (dotenv) and, without SESSION_SECRET, writes a signing key into
 * DATA_DIR. A machine has no business with either: under a checkout the
 * working directory is a home's, and its .env would hand the agent that
 * home's DATA_DIR. The agent is given DATA_DIR in its environment instead
 * (deploy/vast/entrypoint.sh · runner). Everything that reads the directory
 * reads it here; config.ts serves the same value as `config.dataDir`.
 *
 * READ ONCE, WHEN THE MODULE LOADS, as config.ts always read it. A DATA_DIR
 * written only in .env still lands here: config.ts imports this right after
 * dotenv, in every home entry it loads before the competitions' storage, the
 * package sets and the Docker runner do (the bundles hoist the dotenv import
 * above all their code), and tests/runner-import-graph.test.mts keeps the
 * server's entry so.
 */
import path from 'node:path'
import { fileURLToPath } from 'node:url'

/*
 * Anchored to this file rather than to process.cwd(). The defaults of this
 * directory and of WORKSPACE_DIR (config.ts) used to be '../data' and
 * '../workspace' from the working directory, which are only right when the
 * process was started from server/: launched from the repo root instead, the
 * server silently created a workspace directory *beside* the repo and then
 * listed that, while the kernel container kept writing into the real one — a
 * cell would report success and its file would never appear.
 *
 * src/data-dir.ts and the bundled dist/*.js all sit two levels under the
 * root, so one expression covers dev and a local production build. The
 * containers set DATA_DIR and WORKSPACE_DIR explicitly and never get here.
 */
export const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')

/** The data directory, absolute: DATA_DIR, or `data/` at the root of the checkout. */
export const dataDir = path.resolve(process.env.DATA_DIR || path.join(repoRoot, 'data'))
