/**
 * Node's request timeout and the machines' upload doors (server/src/net/
 * long-body.ts): a body this server reads at its own pace — a class's files
 * coming home through one bucket for every machine — is spared the timeout
 * while it lasts, under its door's own stall timer; any other request is cut
 * as Node cuts it (408), and every other client error gets Node's answer.
 *
 * Without it a 1 GiB «Привезти» read at 4 MiB/s by two machines at once was
 * cut at Node's 300 s and sent again from its start, for ever. The server
 * here has Node's timeout at a fraction of a second and checks it often: the
 * test waits for the timeout to have come for the long body, by its event,
 * before it lets that body end.
 */
import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import net from 'node:net'
import type { AddressInfo } from 'node:net'
import { allowLongBody, answerClientError } from '../server/src/net/long-body.ts'

/** Node's request timeouts that came for a socket still open: the long body's proof that the timer did come for it. */
let timeouts = 0
const server = http.createServer({ connectionsCheckingInterval: 25 }, (req, res) => {
  if (req.url === '/long') allowLongBody(req)
  let bytes = 0
  req.on('data', (chunk: Buffer) => (bytes += chunk.length))
  req.on('end', () => res.end(String(bytes)))
  req.on('error', () => undefined)
})
server.requestTimeout = 300
server.headersTimeout = 200
server.on('clientError', (error: NodeJS.ErrnoException, socket) => {
  if (error.code === 'ERR_HTTP_REQUEST_TIMEOUT' && !socket.destroyed) timeouts++
  answerClientError(error, socket)
})
await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
const port = (server.address() as AddressInfo).port

after(() => {
  server.closeAllConnections()
  server.close()
})

/** A chunked PUT that sends a kilobyte every 20 ms until `until` says stop or the server answers: the status and the body. */
function slowPut(path: string, until: () => boolean): Promise<{ status: number | null; body: string }> {
  return new Promise((resolve) => {
    const req = http.request({ host: '127.0.0.1', port, path, method: 'PUT', headers: { 'Transfer-Encoding': 'chunked' } }, (res) => {
      let body = ''
      res.on('data', (chunk: Buffer) => (body += chunk))
      res.on('end', () => {
        clearInterval(tick)
        resolve({ status: res.statusCode ?? null, body })
      })
    })
    req.on('error', () => {
      clearInterval(tick)
      resolve({ status: null, body: '' })
    })
    let sent = 0
    const tick = setInterval(() => {
      if (until() && sent > 0) {
        clearInterval(tick)
        req.end()
        return
      }
      req.write(Buffer.alloc(1024))
      sent++
    }, 20)
  })
}

test('a machine\'s upload door\'s body is spared Node\'s request timeout while its bytes move; any other body is cut by it', async () => {
  const before = timeouts
  // Ends only once Node's timeout came for it, and was let go.
  const long = await slowPut('/long', () => timeouts > before)
  assert.equal(long.status, 200, 'the long body arrived whole')
  assert.ok(Number(long.body) > 1024, long.body)
  // An ordinary request's body that outlasts the timeout: Node's 408, as before.
  const plain = await slowPut('/plain', () => false)
  assert.equal(plain.status, 408)
})

test('every other client error is answered as Node answers it with nobody listening', async () => {
  const answer = await new Promise<string>((resolve) => {
    const socket = net.connect(port, '127.0.0.1', () => socket.write('NOT A REQUEST\r\n\r\n'))
    let said = ''
    socket.on('data', (chunk) => (said += chunk))
    socket.on('close', () => resolve(said))
    socket.on('error', () => resolve(said))
  })
  assert.match(answer, /^HTTP\/1\.1 400 Bad Request\r\nConnection: close\r\n\r\n$/)
})
