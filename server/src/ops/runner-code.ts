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
 * shown once, inside the join commands; home keeps only its sha256. Anything
 * else — a refusal included — goes to stderr with a non-zero exit, and
 * nothing to stdout.
 *
 * A STUB UNTIL HOME'S SIDE IS BUILT (phase 5 of the plan, §9): the codes live
 * in remote_runner_codes, which does not exist yet. It says so on stderr and
 * exits with 2, printing no code, so that colloq-host reports a refusal
 * instead of a code nobody can join with.
 */
process.stderr.write('colloq runner-code: this build cannot mint enrollment codes yet: the machines for submissions are not part of it\n')
process.exit(2)
