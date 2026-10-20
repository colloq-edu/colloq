/**
 * The WebSocket upgrades of the one HTTP server (index.ts): the browsers'
 * three doors — the notebook's CRDT socket, the room's control socket and a
 * file's — and, before them, the machines' tunnel.
 *
 * MOVED OUT OF index.ts, UNCHANGED, so that a test can attach the very
 * handler the process runs to a server of its own (the e2e home of classes
 * on machines, tests/remote-tunnel.test.mts): index.ts starts the process
 * when it loads, and a copy of the handler in a test would only prove the
 * copy works.
 *
 * THE MACHINES' TUNNEL IS MATCHED FIRST, before the browsers' Origin rule
 * (docs/architecture/remote-classes.md §4.2). A machine sends no Origin and
 * no cookie, and its door takes nothing but a machine's credential
 * (kernel/remote/tunnel.ts · MachineTunnels.handleUpgrade), which these three
 * doors keep refusing (socket-authorization.ts · upgradeToken). Every other
 * path is answered here as it always was.
 */
import { tr } from '@shared/i18n'
import type { IncomingMessage } from 'node:http'
import type { Duplex } from 'node:stream'
import { WebSocketServer } from 'ws'
import { normalizePath } from '@shared/paths'
import { originAllowed } from './admin/auth.js'
import { verifyToken, type TokenPayload } from './auth.js'
import { upgradeToken } from './socket-authorization.js'
import { banFor, banRefusal, type BanInForce } from './bans.js'
import { forwardedHost } from './net/inbound.js'
import { socketCookieHeader } from './sso/identity.js'
import { handleCollabSocket } from './collab/index.js'
import { handleFileSocket } from './collab/files.js'
import { handleControlSocket } from './control.js'
import { getSession, syncParticipantRole, touchLastSeenAll } from './db.js'
import { roleFor } from './routes/sessions.js'
import { kernelRetirementInProgress } from './kernel/retirement.js'
import { machineTunnels } from './kernel/remote/tunnel.js'

/** A whole notebook's state travels in one sync frame; images make it big. */
const MAX_WS_PAYLOAD = 16 * 1024 * 1024
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

/* ------------------------------------------------------------ websockets */

export const wss = new WebSocketServer({
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

export function flushLastSeen(): void {
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
  refuse403(socket, banRefusal(ban))
}

function refuse403(socket: Duplex, reply: object): void {
  const body = Buffer.from(JSON.stringify(reply), 'utf8')
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
 * diverge. The cookie header is the one the sign-in proxy has had its say on
 * (sso/identity.ts · socketCookieHeader).
 */
function effectiveRole(cookieHeader: string | undefined, payload: TokenPayload): TokenPayload['role'] {
  return roleFor(cookieHeader, payload)
}

/** A file room's name back into a path. A malformed string is just not a path. */
function decodeRoom(room: string): string {
  try {
    return Buffer.from(room, 'base64url').toString('utf8')
  } catch {
    return ''
  }
}

/** The upgrade handler of the process's one server (index.ts · server.on('upgrade')). */
export function handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void {
  // Until handleUpgrade adopts it this socket has no error handler, and a client
  // that vanishes mid-handshake would otherwise throw out of the event loop.
  socket.on('error', () => socket.destroy())

  /*
   * The machines' tunnel first (see the header): its door answers its own
   * path whatever it says, and nothing below sees that path.
   */
  if (machineTunnels().handleUpgrade(req, socket, head)) return

  /*
   * A page from another origin opens no socket here, on any of the three
   * paths.
   *
   * The role on the socket comes from the teacher's cookie (effectiveRole),
   * and a browser attaches that cookie to a WebSocket opened by any page of
   * the same site: SameSite looks at the registrable domain, not the host. A
   * page on a neighbouring subdomain of the university, holding any student's
   * room token, could open the control socket with the teacher's rights. The
   * rule is the one every write under /api already obeys (admin/auth.ts ·
   * originAllowed): a sent Origin must name this server, the dev server on
   * this machine or the share tunnel; a missing one is not a browser (curl,
   * tests, the load scripts) and passes, as it does there.
   */
  if (!originAllowed(req.headers.origin, req.headers.host, forwardedHost(req))) {
    return refuse403(socket, {
      error: tr("server.requestBlockedThisPageUsesADifferent.dd9b4b"),
      reason: 'forbidden',
    })
  }

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
  // A machine's credential opens no socket (socket-authorization.ts · upgradeToken).
  const payload: TokenPayload | null = verifyToken(upgradeToken(req.headers, url.searchParams.get('token')))
  if (!payload || payload.sessionId !== sessionId) return reject(socket)
  // A token outlives the room it names. Without this check a browser left open
  // on a deleted seminar reconnects, gets a freshly seeded document and writes
  // a snapshot row for a seminar the owner already destroyed.
  if (!getSession(sessionId) || kernelRetirementInProgress(sessionId)) return reject(socket)
  /*
   * Sign-in by proxy decides a socket's staff authority the way it decides a
   * request's (sso/identity.ts · socketCookieHeader): with a verified token
   * the staff cookie is the proxy's, whatever a shared browser kept from the
   * previous person. Without the proxy this is the browser's own header, a
   * microtask later.
   */
  void socketCookieHeader(req.headers).catch(() => req.headers.cookie).then((cookieHeader) => {
    if (socket.destroyed) return
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
    const ban = banFor(sessionId, payload.participantId, cookieHeader)
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
        const role = effectiveRole(cookieHeader, payload)
        // The badge in the participants list follows the access actually held
        // (db.ts · syncParticipantRole) — once per tab, on its control socket.
        if (channel === 'control') syncParticipantRole(sessionId, payload.participantId, role)
        const credentials = { cookieHeader, payload: { ...payload, role } }
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
          ws.close(1011, tr('server.connectionDidNotOpen'))
        } catch {
          ws.terminate()
        }
      }
    })
  }).catch((err: unknown) => {
    // A promise now stands between the handshake and the event loop: a throw
    // in it must cost this one socket, not the process (unhandledRejection).
    console.error('[ws] upgrade failed —', err instanceof Error ? (err.stack ?? err.message) : err)
    socket.destroy()
  })
}
