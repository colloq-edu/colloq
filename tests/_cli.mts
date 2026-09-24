/**
 * Output of a node --test child process must not get lost under
 * --test-force-exit.
 *
 * The root `npm test` runs with --test-force-exit, which exits through
 * process.exit(). Each file's child process writes its report into a PIPE to
 * the parent, pipe writes are asynchronous, and process.exit() cuts them off
 * mid-word: a run showed "pass 4" instead of "pass 27", with exit code 0.
 * Green there proved nothing.
 *
 * One setBlocking call makes the write synchronous, and the report arrives
 * whole. npm test loads this module through --import for every child
 * process. The import in the CLI files keeps direct runs working as well.
 */
const handle = (process.stdout as unknown as { _handle?: { setBlocking?(on: boolean): void } })
  ._handle
handle?.setBlocking?.(true)

export {}
