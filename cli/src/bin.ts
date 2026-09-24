#!/usr/bin/env node
/**
 * The entry point of the `colloq` command, and the only unconditional one.
 *
 * main.ts starts itself, but only once it recognizes its own name in argv[1]
 * (`…/cli/src/main.ts` or `.js`): that is how it is called from the sources
 * (`node --import tsx cli/src/main.ts`), and that is also how it stays silent
 * when tests merely import it. The package has a different name. The bundle
 * built into one file lies anywhere and is called anything (`colloq`,
 * `colloq-cli`, a full path inside a venv), and the name check in it NEVER
 * fires: the command exited with code 0 without printing a single line, and
 * that looked like "it worked". So the package has its own entry point without
 * a single condition: import main and call it.
 *
 * There is nothing here but the start: all the argv parsing, all refusals and
 * all output live in main.ts. The exit code is set through process.exitCode,
 * not process.exit: an early exit would cut off the child that sh forwards
 * signals to and whose end it waits for; the same reason as at the tail of
 * main.ts.
 */
import { cli } from './main.js'

process.exitCode = await cli(process.argv.slice(2))
