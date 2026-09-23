import { createServer, createConnection, type Server, type Socket } from 'node:net'
import { lookup } from 'node:dns/promises'
import { isIP } from 'node:net'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const ALLOWED = new Set(['pypi.org:443', 'files.pythonhosted.org:443'])
type Options = { maxBytes: number, seconds: number }

export function publicIPv4(value: string): boolean {
  if (isIP(value) !== 4) return false
  const parts = value.split('.').map(Number)
  const [a, b, c] = parts
  if (a === undefined || b === undefined || c === undefined) return false
  if (a === 0 || a === 10 || a === 127 || a >= 224 || a === 169 && b === 254 ||
      a === 100 && b >= 64 && b <= 127 || a === 172 && b >= 16 && b <= 31 ||
      a === 192 && (b === 168 || b === 0 && c === 0 || b === 0 && c === 2 || b === 88 && c === 99) ||
      a === 198 && (b === 18 || b === 19 || b === 51 && c === 100) ||
      a === 203 && b === 0 && c === 113) return false
  return true
}

export function createCompetitionProxy(options: Options): Server {
  if (!Number.isSafeInteger(options.maxBytes) || options.maxBytes < 1 || options.maxBytes > 2 * 1024 * 1024 * 1024 ||
      !Number.isSafeInteger(options.seconds) || options.seconds < 1 || options.seconds > 3600) throw new Error('invalid proxy limits')
  const deadline = Date.now() + options.seconds * 1000
  let remaining = options.maxBytes
  let active = 0
  const sockets = new Set<Socket>()
  const server = createServer(socket => {
    if (active >= 16 || Date.now() > deadline) return socket.destroy()
    active++
    sockets.add(socket)
    socket.setTimeout(15_000)
    socket.on('error', () => socket.destroy())
    socket.on('timeout', () => socket.destroy())
    socket.on('close', () => { sockets.delete(socket); active-- })
    let header = Buffer.alloc(0)
    const receiveHeader = async (chunk: Buffer) => {
      header = Buffer.concat([header, chunk])
      if (header.length > 8192) return socket.destroy()
      const end = header.indexOf('\r\n\r\n')
      if (end < 0) return
      socket.off('data', receiveHeader)
      socket.pause()
      const first = header.subarray(0, header.indexOf('\r\n')).toString('ascii')
      const match = /^CONNECT ([^ ]+) HTTP\/1\.[01]$/.exec(first)
      if (!match || !ALLOWED.has(match[1]!)) return socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n')
      try {
        const host = match[1]!.split(':')[0]!
        const addresses = await lookup(host, { all: true, family: 4 })
        if (!addresses.length || addresses.some(item => !publicIPv4(item.address))) return socket.destroy()
        const upstream = createConnection({ host: addresses[0]!.address, port: 443, timeout: 15_000 })
        sockets.add(upstream)
        upstream.on('close', () => sockets.delete(upstream))
        upstream.on('timeout', () => upstream.destroy())
        upstream.on('error', () => socket.destroy())
        socket.on('error', () => upstream.destroy())
        socket.on('close', () => upstream.destroy())
        upstream.on('close', () => socket.destroy())
        upstream.once('connect', () => {
          socket.write('HTTP/1.1 200 Connection Established\r\n\r\n')
          const carry = header.subarray(end + 4)
          const forward = (data: Buffer, destination: Socket, source: Socket) => {
            remaining -= data.length
            if (remaining < 0 || Date.now() > deadline) { socket.destroy(); upstream.destroy(); return }
            if (!destination.write(data)) {
              source.pause()
              destination.once('drain', () => source.resume())
            }
          }
          socket.on('data', data => forward(data, upstream, socket))
          upstream.on('data', data => forward(data, socket, upstream))
          if (carry.length) forward(carry, upstream, socket)
          socket.resume()
        })
      } catch { socket.destroy() }
    }
    socket.on('data', receiveHeader)
  })
  const timer = setTimeout(() => { for (const socket of sockets) socket.destroy(); server.close() }, options.seconds * 1000)
  timer.unref()
  server.on('close', () => clearTimeout(timer))
  return server
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const maxBytes = Number(process.argv[2] ?? process.env.COMP_PROXY_MAX_BYTES)
  const seconds = Number(process.argv[3] ?? process.env.COMP_PROXY_WALL_SECONDS)
  createCompetitionProxy({ maxBytes, seconds }).listen(3128, '0.0.0.0')
}
