import { tr } from '@shared/i18n'
/**
 * Process entry point: one HTTP server, two WebSocket paths, one static bundle.
 *
 * Colloq is deliberately a single process behind a single origin. A seminar is
 * hosted by whoever runs `docker compose up` twenty minutes before class, so
 * everything a student touches — the page, the REST API, the CRDT socket and
 * the run-control socket — must arrive on the one URL that was written on the
 * whiteboard, with no reverse-proxy rules to get wrong.
 *
 * That single origin is also the whole delivery story: there is no CDN in front
 * of it and no proxy to add compression or cache headers, so the server does
 * both itself — in app.ts, where the whole application is assembled. What
 * stays here is what belongs to the PROCESS: sockets, the port, signals and
 * shutdown. The upgrade handler itself is upgrade.ts's, where a test can
 * attach it to a server of its own.
 */
// First: it patches console, and imports are hoisted, so everything modules
// print while loading must find console already patched. Names from it are
// imported right here: this is that same module, not a second one, since a
// process has one journal.
import { startJournal, stopJournal } from './log.js'
import { retireDatabaseKernels, stopsLocalKernelsOnExit } from './local/kernel-cleanup.js'
import { dropLocalRoomKernel, warmRoomPerimeter } from './kernel/pool.js'
import { watchGpuCards } from './kernel/resources.js'
import { kernelBackend } from './kernel/runtime-client.js'
import http from 'node:http'
import { setupBanner } from './admin/auth.js'
import { describeInboundPolicy, inboundPolicy } from './net/inbound.js'
import { describeSsoPolicy, ssoPolicy } from './sso/identity.js'
import { aiEnabled, config, DEV_JUPYTER_TOKEN } from './config.js'
import { roomCensus, shutdownCollab } from './collab/index.js'
import { flushLastSeen, handleUpgrade, wss } from './upgrade.js'
import { machineTunnels } from './kernel/remote/tunnel.js'
import { db, closeDatabase } from './db.js'
import { startDatabaseSnapshots, stopDatabaseSnapshots } from './db-snapshots.js'
import { startMetrics } from './ops/metrics.js'
import { kernelCensus, shutdownKernels } from './kernel/index.js'
import { sweepAllStaleUploads } from './workspace.js'
import {
  reclaimCompetitionQueue,
  startCompetitionPump,
  stopCompetitionPump,
} from './competitions/runner.js'
import { app } from './app.js'
import { COLLOQ_VERSION } from './version.js'
import { startDependencyPump, stopDependencyPump } from './dependencies/service.js'
import { backfillRevisionImages, pinLegacySubmissions } from './dependencies/revisions.js'
import { competitionBackend } from './competitions/runner-port.js'
import { assertCompetitionCapability } from './competitions/capabilities.js'
import { createWorkerStartup } from './competitions/worker-startup.js'
import { startRemoteRunners, stopRemoteRunners } from './competitions/remote/liveness.js'
import { installOutboundProxy } from './outbound.js'
import { migratePages } from './publish/migrate-pages.js'
import { sweepPageFiles } from './publish/page-files.js'
import { repairFolderFiles } from './publish/materials.js'
import { answerClientError } from './net/long-body.js'

/*
 * The institution's proxy (HTTPS_PROXY, HTTP_PROXY, NO_PROXY) is in place
 * before anything can make a request, and .env has been read by config.ts by
 * now. Without those variables this does nothing (outbound.ts).
 */
await installOutboundProxy()

const SHUTDOWN_GRACE_MS = stopsLocalKernelsOnExit() ? 70000 : 8000

const server = http.createServer(app)
/*
 * Outlive the proxies' keep-alive. Node closes an idle keep-alive socket
 * after 5 s by default, while the proxies in front of it keep theirs longer
 * and reuse them: frps on the relay about a minute, Caddy two minutes. A
 * request sent on a socket Node is closing at that moment dies with EOF; the
 * proxy repeats a GET by itself but not a POST. On 29 Sep 2026 one notebook
 * upload of a class rehearsal came back as the relay's 404 page for exactly
 * this reason ("error: EOF" in the frps log). headersTimeout stays above
 * keepAliveTimeout, or an idle socket can be cut by the headers timer first.
 */
server.keepAliveTimeout = 130_000
server.headersTimeout = 135_000
/*
 * Node's request timeout (300 s) spares a machine's upload whose body this
 * server itself reads at its own pace, while its door's stall timer stands
 * (net/long-body.ts); every other client error is answered as Node does.
 */
server.on('clientError', answerClientError)

server.on('upgrade', handleUpgrade)

/* --------------------------------------------------------------- lifecycle */

/*
 * What we listen on. The default is unchanged, all interfaces: under
 * `make up` compose publishes the port, and otherwise the server in the
 * container cannot be reached.
 *
 * On a dedicated machine this is unneeded and harmful: Colloq reaches the
 * outside through an outgoing tunnel, and an open port on a public address is
 * a second door into the same room that nobody named. The systemd service
 * sets 127.0.0.1 here.
 */
const bindAddr = (process.env.BIND_ADDR ?? '').trim()
const workerStartup = createWorkerStartup({
  async startExecution() {
    await assertCompetitionCapability('execution')
    await reclaimCompetitionQueue()
    // Legacy pinning invokes image probes; the test backend has no containers.
    if (competitionBackend() !== 'test') await pinLegacySubmissions()
    // What older revisions' images are beyond this machine, in the background:
    // nothing here waits on it (dependencies/revisions.ts · backfillRevisionImages).
    void backfillRevisionImages().catch((error: unknown) => console.warn('[dependencies] revision images were not inspected', error))
    startCompetitionPump()
  },
  startPreparation: startDependencyPump,
  onError: (worker, error) => console.error(`[competitions] ${worker} startup deferred`, error),
})


/*
 * Courses and pages written by an older release are brought up to class
 * pages before the first request can read them (publish/migrate-pages.ts),
 * then page files a crash left without a row are swept, and folder files a
 * rollback to a release before folders deleted are put back from their
 * rooms or their folders taken off the page (materials.ts ·
 * repairFolderFiles). All idempotent and all logged, never fatal: a page
 * that cannot be converted keeps its 0.12 step, and the server still starts.
 */
try {
  migratePages()
  const swept = sweepPageFiles()
  if (swept.rows + swept.files > 0) {
    console.log(`[pages] swept ${swept.rows} unreferenced and ${swept.files} stray page file(s)`)
  }
  const repaired = repairFolderFiles()
  if (repaired.restored > 0) {
    console.log(`[pages] put back ${repaired.restored} folder file(s) from their rooms`)
  }
  for (const { pub, key } of repaired.dropped) {
    console.error(
      `[pages] folder "${key}" of page ${pub} lost files and was taken off the page; ` +
        'publishing the page again brings it back',
    )
  }
} catch (err) {
  console.error('[pages] the class-page migration did not finish:', err)
}

server.listen(config.port, ...(bindAddr ? ([bindAddr] as const) : ([] as const)), () => {
  const ai = aiEnabled() ? `on (${config.ai.model})` : 'off'
  console.log(`colloq ${COLLOQ_VERSION} ready — open ${config.publicUrl} · ai ${ai} · jupyter ${config.jupyter.url}`)
  announceSetupToken()
  announceBind()
  announceProxies()
  announceJupyterToken()
  /*
   * Leftovers from a crash are removed at startup, not "some day at the next
   * upload".
   *
   * A half-written file survives exactly the crash we are now starting after;
   * in a room where nothing is being uploaded there was nobody else to remove
   * it (see sweepAllStaleUploads).
   */
  sweepAllStaleUploads()
  /*
   * The census is assembled here, not inside `log.ts`: that module loads first
   * in the process, before collab and kernel, and importing them from there
   * would put the console patch after everything modules print while loading.
   */
  startJournal(() => ({ ...roomCensus(), kernels: kernelCensus() }))
  // The sockets are counted where they live; /metrics answers only with
  // METRICS_TOKEN set (ops/metrics.ts).
  startMetrics({ sockets: () => wss.clients.size })
  /*
   * The machines that run submissions (competitions/remote/liveness.ts):
   * what the previous life left half done (offers withdrawn, outcomes left
   * applying driven again), then the clock that decides when a silent
   * machine's runs count as lost, and the probe of this server's own address
   * that proves the road to the machines works. Not behind the execution
   * worker: a machine's sync must be answered even while this server's own
   * Docker is not up, and its results are kept for the metric to score.
   */
  startRemoteRunners()
  /*
   * Consistent copies of the database into the data volume, when
   * DB_SNAPSHOT_HOURS asks for them (db-snapshots.ts). Here rather than when
   * db.ts loads: the CLI's cleanup helper and the tests open the database
   * through it too, and neither is a server with a schedule.
   */
  startDatabaseSnapshots(db, config.dataDir)
  /*
   * The room network and the ban on local addresses come up right away, not
   * with the first Run: a refusal (no rights for the helper, someone else's
   * firewall) reaches the operator's journal before class, and the first room
   * does not wait an extra second (kernel/perimeter.ts).
   */
  void warmRoomPerimeter()
  /*
   * The cards behind KERNEL_GPUS are asked about now, in the background, and
   * kept warm from then on (kernel/resources.ts · watchGpuCards): the owner's
   * first look at the Resources tab after a restart, and the first GPU
   * submission the queue picks up again below, find the card sizes known
   * instead of waiting for a probe container.
   */
  watchGpuCards()
  /*
   * The competition queue also starts right away, and in this order.
   *
   * First comes what the previous exit cut short: a "running" row with another
   * process's liveness mark is a submission that no longer has a container,
   * and without cleanup it would hang as "running" until the end of the
   * competition. The pump is switched on only after that: taking work earlier,
   * it would fill the only slot with something that has to be brought up again
   * anyway.
   */
  void workerStartup.start()
})

/**
 * Who the door is open to, said out loud, because a .env on a machine
 * outlives semesters.
 *
 * BIND_ADDR is now described in the README settings table and in
 * .env.example, and compose uses it to restrict port publishing on the host.
 * But documentation is read once, at install time, while .env lives on the
 * machine for years and moves by being copied from the previous laptop: a
 * line missing from it cannot be seen from the README. So the open door is
 * named out loud by the process itself, in the journal, to whoever starts it
 * rather than whoever reads the documentation: otherwise a teacher who ran
 * `make run` in a classroom also hands out the room at
 * http://<laptop-ip>:3000, bypassing the link, bypassing the tunnel and
 * without knowing it. The same door on 8888 is closed by
 * docker-compose.dev.yml publishing it on loopback; that is where it was
 * closed after it had opened in a classroom.
 *
 * Printed once per start and only when the door really is open: a line that
 * always appears stops being read by the second week.
 */
function announceBind(): void {
  if (bindAddr) return
  console.log(
    `[net] BIND_ADDR is not set: port ${config.port} is open on every interface of this machine — ` +
      `on a classroom network the room also answers at http://<this-machine-ip>:${config.port}, ` +
      'bypassing the link. On a laptop or a dedicated machine set BIND_ADDR=127.0.0.1 ' +
      '(Colloq reaches the outside through a tunnel, see make host); under make up this is as it should be — ' +
      'otherwise the server in the container cannot be reached, and compose decides the port publishing.',
  )
}

/**
 * Whose word about the client address is taken, said once per start.
 *
 * Unlike the lines around it this one is printed always: behind a campus
 * proxy the only symptom of a wrong TRUSTED_PROXIES is the whole class
 * sharing one address, which nobody sees until the sixty-first student is
 * turned away at the door. One line at start is the cheapest place to see
 * that the setting arrived, and a dropped entry is named right above it.
 * Sign-in by proxy (AUTH_JWT_*) is said here too when it is configured: a
 * setting it could not read turns it off, which is just as invisible.
 */
function announceProxies(): void {
  const policy = inboundPolicy()
  for (const problem of policy.problems) console.warn(`[net] ${problem}`)
  console.log(`[net] ${describeInboundPolicy(policy)}`)
  const sso = ssoPolicy()
  for (const problem of sso.problems) console.warn(`[sso] ${problem}`)
  if (sso.enabled || sso.problems.length > 0) console.log(`[sso] ${describeSsoPolicy(sso)}`)
}

/**
 * The kernel password comes from a public file: say so out loud until it is
 * replaced.
 *
 * `make up` writes out a random token when it creates .env, and normally
 * nobody will see this line. It is about two ordinary cases: `cp .env.example
 * .env` by hand and a .env left over from last semester. In both, the way
 * into the container with the files of ALL seminars is a password printed in
 * a public repository.
 *
 * Not a refusal and not a stop: on a laptop behind NAT this is exactly the
 * case the default exists for, and derailing a class with a configuration
 * warning would be worse than the hole itself. Room isolation by containers
 * and a network of its own for the shared kernel (docker-compose.yml) are the
 * first lock; this token is the second, and it has to be a real one.
 */
function announceJupyterToken(): void {
  if (config.jupyter.token !== DEV_JUPYTER_TOKEN) return
  // The broker's rooms have tokens of their own, derived per room: on
  // Kubernetes this line spoke about a value nothing uses (1 Oct 2026).
  if (kernelBackend() === 'broker') return
  console.warn(
    `[kernel] JUPYTER_TOKEN is the well-known value from .env.example (${DEV_JUPYTER_TOKEN}); ` +
      'put your own in: the JUPYTER_TOKEN= line in .env, then restart',
  )
}

/**
 * The first-run banner (admin/auth.ts · setupBanner): printed while nobody owns
 * the instance, never after the claim, which replaced the printed token.
 */
function announceSetupToken(): void {
  const banner = setupBanner(config.publicUrl)
  if (banner) console.log(banner)
}

let stopping = false

async function shutdown(signal: string): Promise<void> {
  if (stopping) return
  stopping = true
  console.log(`\ncolloq shutting down (${signal})`)
  // A summary for a cut-short minute means nothing, and a line about zero
  // rooms among the shutdown lines is just noise.
  stopJournal()

  const force = setTimeout(() => {
    console.warn('colloq: shutdown timed out, exiting anyway')
    process.exit(1)
  }, SHUTDOWN_GRACE_MS)

  server.close()
  for (const client of wss.clients) {
    try {
      client.close(1001, tr("server.serverShuttingDown.0df697"))
    } catch {
      client.terminate()
    }
  }
  /*
   * The machines' tunnels go the same way: an agent hears a server going
   * away and dials again in half a second, which finds this process's next
   * life; the kernels on its machine never notice (remote-classes.md §11.4).
   */
  machineTunnels().shutdown()

  // "Was here" marks that did not get to leave in a batch: there are few of
  // them and they are cheap, and without this line a restart in the middle of
  // a class loses the last five seconds of arrivals.
  flushLastSeen()

  /*
   * No more new submissions are taken, and the one already started is waited
   * for: its container will outlive this process anyway, and dropping it
   * halfway means leaving gigabytes on the machine and a "running" row that
   * the server's next life will have to pick up.
   */
  try {
    stopRemoteRunners()
    await workerStartup.stop()
    await stopDependencyPump()
    await stopCompetitionPump()
  } catch (err) {
    console.error('colloq: could not stop the competition queue:', err instanceof Error ? err.message : err)
  }

  // Snapshots first: an unsaved notebook is the only thing here that cannot be
  // rebuilt. Kernels are disposable, and shutting them down may involve HTTP.
  try {
    shutdownCollab()
  } catch (err) {
    console.error('colloq: could not flush notebooks:', err instanceof Error ? err.message : err)
  }
  try {
    await shutdownKernels()
    if (stopsLocalKernelsOnExit()) await retireDatabaseKernels(db, dropLocalRoomKernel)
  } catch (err) {
    console.error('colloq: could not stop kernels:', err instanceof Error ? err.message : err)
  }
  /*
   * Last: the database is closed for real.
   *
   * The process used to just leave through process.exit, and the WAL journal
   * was left lying next to it: a stopped instance's `colloq.db` was
   * yesterday's, and the whole day sat in a file nobody copies. db.close()
   * folds the journal in and closes the file, which is exactly what one
   * expects from "stopped". A database snapshot still copying gives up first
   * and takes its partial file with it (db-snapshots.ts).
   */
  try {
    await stopDatabaseSnapshots()
    closeDatabase()
  } catch (err) {
    console.error('colloq: could not close the database:', err instanceof Error ? err.message : err)
  }

  clearTimeout(force)
  process.exit(0)
}

process.on('SIGINT', () => void shutdown('SIGINT'))
process.on('SIGTERM', () => void shutdown('SIGTERM'))

// A stray rejection from a kernel or model call must not end the class.
process.on('unhandledRejection', (err: unknown) => {
  console.error(
    'colloq: unhandled rejection:',
    err instanceof Error ? (err.stack ?? err.message) : err,
  )
})

/*
 * An uncaught exception is not the same as a rejected promise.
 *
 * A promise can be swallowed: somewhere an answer was not waited for, and a
 * seminar does not break over it. An exception that got this far leaves the
 * process in a state nobody knows anything about, and by default node then
 * just dies silently, without a single line about the cause. We write the
 * cause and leave with a non-zero code: a restart is more honest than a
 * server nobody can tell is working.
 */
process.on('uncaughtException', (err: unknown) => {
  console.error(
    'colloq: uncaught exception:',
    err instanceof Error ? (err.stack ?? err.message) : err,
  )
  try {
    shutdownCollab()
  } catch {
    // The snapshots are the last thing to try to save, not a reason to stay.
  }
  process.exit(1)
})
