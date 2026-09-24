/**
 * How the fake kernel answers the installation of the guard against dangerous
 * commands.
 *
 * The server installs it on every kernel start and restart and does NOT
 * release the queue until the kernel confirms (kernel/index.ts ·
 * ensureGuard): it has to treat silence as refusal. So every kernel fake
 * that even one cell passes through must be able to confirm it, otherwise
 * the suite tests not what its name says but a guard failure.
 *
 * A shared piece rather than a copy in every file: the tests have several
 * kernel fakes, and this is where they would drift apart most easily: the
 * very first change to the report would be fixed in one place and silently
 * break the other two.
 */
import { GUARD_MODULE } from '../server/src/kernel/danger.js'

/**
 * Is this a rule cell? Then a ready answer, as from a real kernel.
 *
 * `null`: the code is not about the guard, and it should get whatever answer
 * the fake gave before. The rule is read from the code itself (`apply(True` /
 * `apply(False`), the same way the kernel would respond to it: the server
 * compares the returned `policy` with what it asked for and treats a
 * mismatch as refusal.
 */
export function guardAnswer(code: string): Record<string, unknown> | null {
  if (!code.includes(GUARD_MODULE) || !code.includes('.apply(')) return null
  const blocked = code.includes('.apply(True')
  return {
    ok: true,
    on: blocked,
    policy: blocked,
    holds: 0,
    patched: blocked
      ? ['ask_exit', '_exit', 'abort', 'kill', 'system', 'run_line_magic']
      : [],
  }
}
