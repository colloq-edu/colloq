/**
 * The agent of a machine that runs submissions for a home instance
 * («машина для посылок», docs/architecture/remote-runners.md): bundled as
 * dist/runner.js, which the image's entry point starts in `runner` mode
 * (deploy/vast/entrypoint.sh · runner), and whose sha256 next to it
 * (dist/runner.sha256) is the build home compares before it hands the machine
 * new work (the owner's decision 5).
 *
 * A STUB UNTIL THE AGENT IS BUILT (phase 6 of the plan, §9). It says which
 * version it is and that it cannot run submissions yet, on stderr, and exits
 * with 2 — a refusal, not a crash and not a success: a machine started on
 * this build must never look as if it had joined. Its place in the image, in
 * the build and in the hash is already the real one, so the packaging and
 * home's compatibility check can be built against it meanwhile.
 *
 * WHAT THIS BUNDLE MAY LOAD (tests/runner-import-graph.test.mts keeps it so):
 * the execution core — competitions/docker-runner.ts with the harness and the
 * storage layout, competitions/gpu-math.ts, kernel/card-probe.ts,
 * ops/meminfo.ts — and the contract, but never the database, the room pool,
 * config.ts and its .env, or the release's version (version.ts says why).
 */
import { runnerVersion } from './version.js'

process.stderr.write(`colloq-runner ${runnerVersion()}\n`)
process.stderr.write('colloq-runner: this build cannot run submissions yet: the agent of the machines for submissions is not part of it\n')
process.exit(2)
