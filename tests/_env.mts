/**
 * Every server module reaches config on import, and config resolves DATA_DIR and
 * WORKSPACE_DIR at module scope. Import this FIRST in any test that touches
 * server code, or the suite writes SQLite into the developer's real data
 * directory — which is how a test run once ate a working instance.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

const root = mkdtempSync(path.join(tmpdir(), 'colloq-test-'))

/*
 * The process cleans up after itself, and does it at the very end.
 *
 * A directory is created for EVERY file of the suite (its own SQLite, its own
 * rooms folder) and was never removed: `npm test` left ninety-six of them per
 * run, and books/control-room/paths/tree-move write a couple of thousand
 * files each into theirs. On a machine where this suite has been run for
 * months, seventeen thousand directories and five and a half gigabytes piled
 * up, and not a line in the output about where they came from.
 *
 * Exactly `exit`, not `after()` from node:test: this is reached by a failed
 * file, by a thrown exception and (checked) by a child process under
 * `--test-force-exit` that was not going to exit on its own. By this point
 * nothing is running any more, so removing the folder cannot pull the disk
 * out from under a background timer that is still writing a snapshot or a
 * notebook projection.
 *
 * Directories of past runs are not touched: a second suite may be running
 * alongside, and wiping someone else's DATA_DIR in the middle of its work is
 * exactly the trouble all this exists to prevent. Leftovers from old
 * versions are removed by hand.
 */
process.on('exit', () => rmSync(root, { recursive: true, force: true }))

process.env.DATA_DIR = path.join(root, 'data')
process.env.WORKSPACE_DIR = path.join(root, 'workspace')
process.env.SESSION_SECRET = 'test-secret-not-random-on-purpose'
process.env.PUBLIC_URL = 'http://localhost:9999'
process.env.ADMIN_EMAIL = 'owner@test.local'
/*
 * Tests have no kernel, and must not have one.
 *
 * Without this line JUPYTER_URL stayed at its default, localhost:8888, that
 * is, a real container on the developer's machine. A test that accidentally
 * reached for the kernel was green exactly as long as something was running
 * nearby, and failed after a sixty-second timeout once it stopped. One such
 * test has already been written.
 *
 * A port where there is certainly nobody: a call to the kernel that bypasses
 * the fake now fails at once and loudly. `kernel.test.mts` starts its own
 * fake and points this variable at it.
 */
process.env.JUPYTER_URL = 'http://127.0.0.1:1'

/*
 * And tests have no containers either.
 *
 * A room now has its own container (`kernel/pool.ts`), and without this line
 * the suite started a real one for every seminar: one run left thirty-six
 * hanging `colloq-room-*` on the machine. The Jupyter fake in
 * `kernel.test.mts` replaces the kernel entirely, so there is nothing to
 * start.
 */
process.env.NODE_ENV = 'test'
process.env.KERNEL_BACKEND = 'test'
process.env.KERNEL_ISOLATION = 'off'

export const TEST_ROOT = root
