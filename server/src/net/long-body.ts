/**
 * NODE'S REQUEST TIMEOUT, BUT NOT FOR A MACHINE'S UPLOAD WHILE ITS BYTES MOVE.
 *
 * Node gives a request five minutes to arrive whole (server.requestTimeout,
 * 300 s since Node 18), and the doors of class machines read their bodies at
 * this server's own pace: a class's files coming home go through one bucket
 * for every machine (competitions/remote/blobs.ts · classUploadPace), so a
 * 1 GiB «Привезти» at 4 MiB/s takes 256 s alone and more than 300 s once
 * another machine shares the bucket or the owner lowers «Файлы занятий». Cut
 * by Node at 300 s, the agent sent the whole file again from its start.
 *
 * Those doors keep a stall timer of their own (upload.ts · UPLOAD_STALL_MS: a
 * body that sends nothing for a minute is ended, its slot freed), so a request
 * marked here is spared Node's timeout while it lasts; every other request
 * keeps it exactly as before, and every other client error gets Node's own
 * answer (answerClientError).
 */
import { STATUS_CODES, type IncomingMessage } from 'node:http'
import type { Duplex } from 'node:stream'

/** The sockets of requests whose bodies come at this server's pace (allowLongBody), while the request lasts. */
const longBodies = new WeakSet<object>()

/** This request's body is read at this server's pace, under its door's own stall timer: Node's request timeout spares it. */
export function allowLongBody(req: IncomingMessage): void {
  const socket = req.socket
  longBodies.add(socket)
  // A keep-alive socket's next request is any other: it keeps Node's timeout.
  req.once('close', () => longBodies.delete(socket))
}

/** What Node writes for a client error when nobody listens for one (node:_http_server · socketOnError). */
function answerOf(code: string | undefined): string {
  const status = code === 'ERR_HTTP_REQUEST_TIMEOUT' ? 408 : code === 'HPE_HEADER_OVERFLOW' ? 431 : code === 'HPE_CHUNK_EXTENSIONS_OVERFLOW' ? 413 : 400
  return `HTTP/1.1 ${status} ${STATUS_CODES[status]}\r\nConnection: close\r\n\r\n`
}

/**
 * The HTTP server's `clientError` (index.ts): the request timeout of a
 * request marked by allowLongBody is let go, its door's stall timer standing
 * in for it; anything else is answered as Node answers it with no listener —
 * a 400, 408, 413 or 431 while nothing of a response went out yet, then the
 * socket destroyed.
 */
export function answerClientError(error: NodeJS.ErrnoException, socket: Duplex): void {
  if (error.code === 'ERR_HTTP_REQUEST_TIMEOUT' && longBodies.has(socket)) return
  // Node's own test: an answer under way on this socket (its headers written) is not to be followed by another.
  const answering = (socket as Duplex & { _httpMessage?: { _headerSent?: boolean } })._httpMessage?._headerSent === true
  if (socket.writable && !answering) socket.write(answerOf(error.code))
  socket.destroy(error)
}
