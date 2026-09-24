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
 * shutdown.
 */
// First: it patches console, and imports are hoisted, so everything modules
// print while loading must find console already patched. Names from it are
// imported right here: this is that same module, not a second one, since a
// process has one journal.
import { startJournal, stopJournal } from './log.js'
import { retireDatabaseKernels, stopsLocalKernelsOnExit } from './local/kernel-cleanup.js'
import { dropLocalRoomKernel, warmRoomPerimeter } from './kernel/pool.js'
import { kernelRetirementInProgress } from './kernel/retirement.js'
import http from 'node:http'
import { WebSocketServer } from 'ws'
import type { Duplex } from 'node:stream'
import { isClaimed, readSetupToken, setupTokenPath } from './admin/auth.js'
import { verifyToken, type TokenPayload } from './auth.js'
import { banFor, banRefusal, type BanInForce } from './bans.js'
import { aiEnabled, config, DEV_JUPYTER_TOKEN } from './config.js'
import { handleCollabSocket, roomCensus, shutdownCollab } from './collab/index.js'
import { handleFileSocket } from './collab/files.js'
import { normalizePath } from '@shared/paths'

import { handleControlSocket } from './control.js'
import { db, closeDatabase, getSession, touchLastSeenAll } from './db.js'
import { kernelCensus, shutdownKernels } from './kernel/index.js'
import { sweepAllStaleUploads } from './workspace.js'
import {
  reclaimCompetitionQueue,
  startCompetitionPump,
  stopCompetitionPump,
} from './competitions/runner.js'
import { roleFor } from './routes/sessions.js'
import { app } from './app.js'
import { COLLOQ_VERSION } from './version.js'
import { startDependencyPump, stopDependencyPump } from './dependencies/service.js'
import { pinLegacySubmissions } from './dependencies/revisions.js'
import { competitionBackend } from './competitions/runner-port.js'
import { assertCompetitionCapability } from './competitions/capabilities.js'
import { createWorkerStartup } from './competitions/worker-startup.js'

/** A whole notebook's state travels in one sync frame; images make it big. */
const MAX_WS_PAYLOAD = 16 * 1024 * 1024
const SHUTDOWN_GRACE_MS = stopsLocalKernelsOnExit() ? 70000 : 8000
const UPGRADE_PATH = /^\/(collab|control)\/([A-Za-z0-9_-]{1,64})\/?$/
/*
 * A file's address has two segments: the room and the file itself, the path
 * in base64url.
 *
 * The path moved from the query string into the address not for looks:
 * y-websocket opens a BroadcastChannel keyed by the address without its
 * parameters, and two different files of one room, open in two browser tabs,
 * ended up in one channel, so the edits of one arrived in the other's
 * document. The room name has to differ.
 */
const FILE_PATH = /^\/file\/([A-Za-z0-9_-]{1,64})\/([A-Za-z0-9_-]{1,2048})\/?$/

const server = http.createServer(app)

/* ------------------------------------------------------------ websockets */

const wss = new WebSocketServer({
  noServer: true,
  maxPayload: MAX_WS_PAYLOAD,
  perMessageDeflate: {
    /*
     * Yjs deltas are a few dozen binary bytes; deflating those costs more CPU
     * and more latency than the bytes are worth. The frames that matter are the
     * initial sync steps, which are tens of kilobytes and compress well.
     *
     * This is the LOWER bound: anything smaller is not compressed. An upper
     * one is needed too (a two-megabyte base64 image compresses by a quarter
     * but costs as much as five hundred zlib jobs, since compression here is
     * per socket, not per frame), but this setting cannot express it: it
     * would take compression away from exactly those first steps it exists
     * for. So the ceiling sits where the frame is sent and its size is
     * visible: `MAX_DEFLATE_BYTES` in collab/index.ts.
     */
    threshold: 8 * 1024,
    zlibDeflateOptions: { level: 4, memLevel: 8 },
    zlibInflateOptions: { chunkSize: 16 * 1024 },
    // No context takeover: a seminar holds thirty sockets open at once, and a
    // retained zlib window per socket is memory spent on frames that mostly
    // never get compressed anyway.
    clientNoContextTakeover: true,
    serverNoContextTakeover: true,
    serverMaxWindowBits: 13,
    concurrencyLimit: 10,
  },
})

/**
 * "Was here" is recorded not on every handshake but once every few seconds,
 * in a batch.
 *
 * The mark used to be set with an UPDATE right here, and a tab has two
 * sockets: five hundred returning tabs are a thousand separate transactions
 * in the very second when everyone is waiting for the room to come back. The
 * mark is read by the list of people, and a few seconds of delay in it mean
 * nothing; the time recorded is when the person arrived, not when the write
 * got to them.
 *
 * The key is a set: the same tab with its two sockets (and its reconnect) is
 * marked once.
 */
const LAST_SEEN_EVERY_MS = 5_000
const lastSeenPending = new Set<string>()
let lastSeenTimer: NodeJS.Timeout | null = null

function flushLastSeen(): void {
  if (lastSeenTimer) {
    clearTimeout(lastSeenTimer)
    lastSeenTimer = null
  }
  if (lastSeenPending.size === 0) return
  const batch = [...lastSeenPending]
  lastSeenPending.clear()
  try {
    // One time for the whole batch: nobody needs "was here" accurate to less
    // than five seconds, and a time of its own for each would mean a
    // transaction for each, which is exactly what the batch exists to avoid.
    touchLastSeenAll(batch)
  } catch {
    /* presence bookkeeping must never cost anybody their connection */
  }
}

function noteLastSeen(participantId: string): void {
  lastSeenPending.add(participantId)
  if (lastSeenTimer) return
  lastSeenTimer = setTimeout(() => {
    lastSeenTimer = null
    flushLastSeen()
  }, LAST_SEEN_EVERY_MS)
  lastSeenTimer.unref?.()
}

function reject(socket: Duplex): void {
  socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\nContent-Length: 0\r\n\r\n')
  socket.destroy()
}

/**
 * A banned user is refused before the upgrade, in the same words as at the
 * entrance.
 *
 * With a body, even though the browser will not show it: WebSocket gives the
 * page neither the code nor the response, only "did not open". These lines
 * will be read by whoever digs into it (the Network tab, curl, a proxy log),
 * and "403 and why" there is worth exactly as much as an evening of guessing.
 */
function refuseBanned(socket: Duplex, ban: BanInForce): void {
  const body = Buffer.from(JSON.stringify(banRefusal(ban)), 'utf8')
  socket.write(
    'HTTP/1.1 403 Forbidden\r\nConnection: close\r\n' +
      'Content-Type: application/json; charset=utf-8\r\n' +
      `Content-Length: ${body.length}\r\n\r\n`,
  )
  socket.write(body)
  socket.destroy()
}

/**
 * This connection's role is decided now, not read from the token.
 *
 * A role baked into the token at sign-in is a role that cannot be taken away:
 * a teacher removed from the list kept Restart in every room they had ever
 * opened. The socket is re-checked on every reconnect, so leaving the panel
 * takes the rights away within seconds. The decision is made by `roleFor`,
 * the same one as on the HTTP side, so the two entrances have nowhere to
 * diverge.
 */
function effectiveRole(
  req: { headers: { cookie?: string } },
  payload: TokenPayload,
): TokenPayload['role'] {
  return roleFor(req.headers.cookie, payload)
}

/** A file room's name back into a path. A malformed string is just not a path. */
function decodeRoom(room: string): string {
  try {
    return Buffer.from(room, 'base64url').toString('utf8')
  } catch {
    return ''
  }
}

server.on('upgrade', (req, socket, head) => {
  // Until handleUpgrade adopts it this socket has no error handler, and a client
  // that vanishes mid-handshake would otherwise throw out of the event loop.
  socket.on('error', () => socket.destroy())

  let url: URL
  try {
    url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`)
  } catch {
    return reject(socket)
  }

  const asFile = FILE_PATH.exec(url.pathname)
  const match = asFile ?? UPGRADE_PATH.exec(url.pathname)
  if (!match) return reject(socket)
  const channel = asFile ? 'file' : match[1]
  const sessionId = asFile ? asFile[1] : match[2]

  // The token is the whole authorization story: it names the session it was
  // minted for, so a valid token for seminar A cannot open seminar B.
  const payload: TokenPayload | null = verifyToken(url.searchParams.get('token'))
  if (!payload || payload.sessionId !== sessionId) return reject(socket)
  // A token outlives the room it names. Without this check a browser left open
  // on a deleted seminar reconnects, gets a freshly seeded document and writes
  // a snapshot row for a seminar the owner already destroyed.
  if (!getSession(sessionId) || kernelRetirementInProgress(sessionId)) return reject(socket)
  /*
   * A ban closes all three doors at once: the notebook, the console and the
   * file.
   *
   * Here, before the upgrade: a socket opened to a banned user "just to look"
   * is their cursor in someone else's notebook and their lines in the shared
   * terminal, which is exactly what they were banned for. The check is the
   * same as at the entrance (bans.ts · banFor), so the two answers have
   * nowhere to diverge.
   */
  const ban = banFor(sessionId, payload.participantId, req.headers.cookie)
  if (ban) return refuseBanned(socket, ban)

  wss.handleUpgrade(req, socket, head, (ws) => {
    /*
     * The whole body is under try, and this is not overcaution.
     *
     * ws calls this callback without catching anything itself, so a
     * synchronous exception from here goes to `uncaughtException`, and that
     * ends the process: one malformed cookie in one participant's header (it
     * is parsed by effectiveRole) took down the whole instance, every room,
     * every terminal, every kernel. The cost of an error here must be one
     * socket: the browser reconnects in a second and comes here again.
     */
    try {
      noteLastSeen(payload.participantId)
      const role = effectiveRole(req, payload)
      const credentials = { cookieHeader: req.headers.cookie, payload: { ...payload, role } }
      if (channel === 'collab')
        handleCollabSocket(ws, sessionId, role, payload.participantId, credentials)
      else if (channel === 'file') {
        /*
         * The path arrives as the second segment of the address, in base64url.
         * It is checked by the same `normalizePath` as everything else in the
         * product, and nothing gets here except an already verified token of
         * this very room.
         */
        const wanted = normalizePath(decodeRoom(asFile?.[2] ?? ''))
        if (!wanted) {
          try {
            ws.close(4404, tr("server.fileNotFound.f1ab8a"))
          } catch {
            /* already closed */
          }
          return
        }
        handleFileSocket(ws, sessionId, wanted, role, payload.participantId, credentials)
      } else {
        /*
         * A participant token carries the role it was minted with. A teacher who
         * joined before signing in — or who created the seminar in the admin
         * panel, which never handed out a host token at all — holds a
         * 'participant' token for a room that is theirs, and interrupt and
         * restart were dead for the whole seminar as a result. Staff on this
         * instance are exactly who those controls are for; the cookie is a
         * stronger credential than the token and it is re-checked here on every
         * reconnect rather than baked into anything.
         */
        handleControlSocket(ws, sessionId, credentials.payload, credentials)
      }
    } catch (err) {
      console.error(
        `[ws] ${channel} ${sessionId}: connection did not open —`,
        err instanceof Error ? (err.stack ?? err.message) : err,
      )
      try {
        ws.close(1011, 'соединение не открылось')
      } catch {
        ws.terminate()
      }
    }
  })
})

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
    startCompetitionPump()
  },
  startPreparation: startDependencyPump,
  onError: (worker, error) => console.error(`[competitions] ${worker} startup deferred`, error),
})


server.listen(config.port, ...(bindAddr ? ([bindAddr] as const) : ([] as const)), () => {
  const ai = aiEnabled() ? `on (${config.ai.model})` : 'off'
  console.log(`colloq ${COLLOQ_VERSION} ready — open ${config.publicUrl} · ai ${ai} · jupyter ${config.jupyter.url}`)
  announceSetupToken()
  announceBind()
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
  /*
   * The room network and the ban on local addresses come up right away, not
   * with the first Run: a refusal (no rights for the helper, someone else's
   * firewall) reaches the operator's journal before class, and the first room
   * does not wait an extra second (kernel/perimeter.ts).
   */
  void warmRoomPerimeter()
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
  console.warn(
    `[kernel] JUPYTER_TOKEN is the well-known value from .env.example (${DEV_JUPYTER_TOKEN}); ` +
      'put your own in: the JUPYTER_TOKEN= line in .env, then restart',
  )
}

/**
 * The entire onboarding story, printed by the only thing that can see it.
 *
 * An unclaimed instance has exactly one way in, and the panel deliberately
 * never shows the token back — so if this line is not readable and actionable
 * on its own, nobody gets in without reading documentation. It prints on every
 * boot while the instance is unclaimed, not only the boot that minted the file:
 * the operator who scrolled past it yesterday needs it again today, and it
 * stops the moment someone claims the instance.
 */
function announceSetupToken(): void {
  if (isClaimed()) return
  console.log(
    [
      '',
      '  ┌ nobody owns this Colloq yet',
      `  │ open  ${config.publicUrl}/admin/t/${readSetupToken()}`,
      '  │ then type your name and email — that makes you the owner, and everyone',
      '  │ else teaching here gets a personal sign-in link from you.',
      '  │',
      // The link carries the token, so it is not a URL to paste into a chat.
      // Saying so next to it is cheaper than explaining it afterwards.
      '  │ That link IS the key to this instance. Do not share it, and do not',
      '  │ leave it on screen while the room is watching.',
      `  └ the token alone is in ${setupTokenPath} (0600). Keep it: it is also the`,
      '    way back in if an owner ever loses their link.',
      '',
    ].join('\n'),
  )
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
   * expects from "stopped".
   */
  try {
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
