/**
 * The environment for the opt-in real-docker judge test — a stand-in for
 * tests/_env.mts that puts DATA_DIR under $HOME, not under the OS temp dir.
 *
 * WHY NOT _env.mts. That one roots DATA_DIR in `os.tmpdir()`, which on macOS is
 * `/var/folders/…`. Colima (the daemon's VM here) shares only the home
 * directory with the VM: a `-v /var/folders/…:/judge` mount is silently empty
 * inside the container, and the harness is "not found". A path under $HOME is
 * shared, so the judge's three mounts — the harness, the job and the tests —
 * actually appear. Measured on this machine: $HOME visible, `/var/folders`
 * not.
 *
 * It must be imported BEFORE any server module, so data-dir.ts reads this
 * DATA_DIR when it loads (ES imports run top to bottom); the docker test lists
 * it first and does not import _env.mts.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const root = fs.mkdtempSync(path.join(os.homedir(), '.colloq-contest-it-'))
process.on('exit', () => {
  try {
    fs.rmSync(root, { recursive: true, force: true })
  } catch {
    /* best effort on exit */
  }
})

process.env.DATA_DIR = path.join(root, 'data')
process.env.WORKSPACE_DIR = path.join(root, 'workspace')
process.env.SESSION_SECRET = 'contest-judge-it-secret-not-random-on-purpose'
process.env.NODE_ENV = 'test'
process.env.KERNEL_BACKEND = 'test'
// The server runs on the host here, not in a container, so a host path is the
// daemon's path: hostPathOf must be the identity (no DATA_HOST_DIR).
delete process.env.DATA_HOST_DIR

export const IT_ROOT = root
