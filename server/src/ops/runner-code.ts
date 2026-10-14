/**
 * The owner's enrollment code for the machines that run this instance's
 * submissions («машины для посылок», docs/architecture/remote-runners.md §6),
 * minted on the instance itself: the path when the panel cannot be reached,
 * kept next to Teleport SSH. `colloq-host runner-code` runs it through the
 * image's entry point (deploy/vast/entrypoint.sh · runner_code), as the
 * server's own user and on the database the running server holds open.
 *
 * THE CONTRACT, which the entry point and colloq-host already speak:
 *
 *   node dist/runner-code.js --machines N --hours H [--trusted] [--slots S] [--prefix NAME]
 *
 * prints exactly one JSON line on stdout, {"code","expiresAt","machines","trusted"}:
 * a code good for N machines within H hours (at most a day), which may receive
 * the hidden test only with --trusted, offers at most S places per machine
 * with --slots, and names the machines it enrolls after NAME. The code is
 * shown once, inside the join commands colloq-host prints around it; home
 * keeps only its sha256. Anything else — a refusal included — goes to stderr
 * with a non-zero exit (64 for a call that does not parse, 2 for one the
 * minter refuses), and nothing to stdout.
 *
 * THE SAME ROW AS THE PANEL'S. The code is written by the one function the
 * owner's dialog uses (competitions/remote/store.ts · mintRemoteCode), with
 * its bounds, into the same database: DATA_DIR is the instance's, set by the
 * entry point before this module loads. SQLite takes a second writer next to
 * the running server (WAL), and the server reads the code on the machine's
 * first join; it needs no restart and no message.
 */
import { mintRefusal, mintRemoteCode } from '../competitions/remote/store.js'

interface Asked {
  machines: number
  hours: number
  trusted: boolean
  slots: number | null
  prefix: string | null
}

/** The arguments, or the line of stderr that says what is wrong with them. */
function parseRunnerCodeArgs(argv: readonly string[]): Asked | string {
  const asked: Asked = { machines: 1, hours: 24, trusted: false, slots: null, prefix: null }
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i]
    if (flag === '--trusted') {
      asked.trusted = true
      continue
    }
    if (flag !== '--machines' && flag !== '--hours' && flag !== '--slots' && flag !== '--prefix') return `unknown option ${flag}`
    const value = argv[++i]
    if (value === undefined) return `${flag} needs a value`
    if (flag === '--prefix') {
      asked.prefix = value
      continue
    }
    if (!/^[0-9]{1,6}$/.test(value)) return `${flag} is a whole number, not ${JSON.stringify(value.slice(0, 20))}`
    const number = Number(value)
    if (flag === '--machines') asked.machines = number
    else if (flag === '--hours') asked.hours = number
    else asked.slots = number
  }
  return asked
}

function main(argv: readonly string[]): number {
  const asked = parseRunnerCodeArgs(argv)
  if (typeof asked === 'string') {
    process.stderr.write(`colloq runner-code: ${asked} (usage: --machines N --hours H [--trusted] [--slots S] [--prefix NAME])\n`)
    return 64
  }
  const input = { machines: asked.machines, hours: asked.hours, trusted: asked.trusted, approvedSlots: asked.slots, namePrefix: asked.prefix, createdBy: 'colloq-host' }
  const refusal = mintRefusal(input)
  if (refusal) {
    const why = {
      machines: '--machines is how many machines may join with the code: 1 to 100',
      hours: '--hours is how long the code stays valid: 1 to 24',
      slots: '--slots caps the places on each machine: 1 to 64',
      prefix: '--prefix is a short name: letters, digits and hyphens, up to 32',
    }[refusal]
    process.stderr.write(`colloq runner-code: ${why}\n`)
    return 2
  }
  const minted = mintRemoteCode(input)
  process.stdout.write(`${JSON.stringify({ code: minted.code, expiresAt: minted.expiresAt, machines: minted.machines, trusted: minted.trusted })}\n`)
  return 0
}

try {
  process.exitCode = main(process.argv.slice(2))
} catch (error) {
  process.stderr.write(`colloq runner-code: ${error instanceof Error ? error.message : String(error)}\n`)
  process.exitCode = 2
}
// The database module keeps a checkpoint timer (unref'd) and the code is written: nothing is left to wait for.
process.exit(process.exitCode)
