import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { createHash, randomUUID, timingSafeEqual } from 'node:crypto'
import { fileURLToPath } from 'node:url'

type Kind = 'notebook' | 'metric' | 'inventory' | 'resolve' | 'verify'
type FileRecord = { name: string, bytes: number, sha256: string }
type ExportOptions = { source: string, destination: string, token: string, kind?: Kind, maxBytes?: number }
const MiB = 1024 * 1024
const MAX_TOTAL = 512 * MiB
const MAX_PROGRESS = 64 * 1024
const caps: Record<Kind, Record<string, number>> = {
  notebook: { 'run.json': MAX_PROGRESS, 'progress.json': MAX_PROGRESS, 'executed.ipynb': 64 * MiB, 'submission.csv': 256 * MiB },
  metric: { 'score.json': MiB },
  inventory: { 'inventory.json': 8 * MiB },
  resolve: { 'resolved.json': MiB, 'progress.ndjson': MiB },
  verify: { 'verified.json': MiB, 'progress.ndjson': MiB },
}
const required: Record<Kind, string> = {
  notebook: 'run.json', metric: 'score.json', inventory: 'inventory.json', resolve: 'resolved.json', verify: 'verified.json',
}
const wheelName = /^[A-Za-z0-9][A-Za-z0-9_.+!-]{0,230}\.whl$/

class ExportError extends Error {
  constructor(message: string, readonly status: number) { super(message) }
}
function fail(message: string, status = 400): never { throw new ExportError(message, status) }
function json(response: ServerResponse, status: number, value: unknown) {
  response.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' })
  response.end(JSON.stringify(value))
}
function authenticated(header: string | undefined, token: string): boolean {
  if (!header?.startsWith('Bearer ')) return false
  const received = Buffer.from(header.slice(7))
  const expected = Buffer.from(token)
  return received.length === expected.length && timingSafeEqual(received, expected)
}
function regular(file: string): fs.Stats {
  const stat = fs.lstatSync(file)
  if (!stat.isFile() || stat.isSymbolicLink()) fail('non-regular output')
  return stat
}
function listFiles(source: string, kind: Kind): Array<{ name: string, source: string, bytes: number }> {
  const allowed = caps[kind]
  const files: Array<{ name: string, source: string, bytes: number }> = []
  for (const name of fs.readdirSync(source).sort()) {
    if (name === 'wheels' && kind === 'resolve') {
      const directory = path.join(source, name)
      if (!fs.lstatSync(directory).isDirectory()) fail('wheel path is not a directory')
      const wheels = fs.readdirSync(directory).sort()
      if (wheels.length > 256) fail('too many wheels', 413)
      for (const wheel of wheels) {
        if (!wheelName.test(wheel)) fail('invalid wheel name')
        const filename = path.join(directory, wheel)
        const bytes = regular(filename).size
        if (bytes > 256 * MiB) fail('wheel exceeds per-file cap', 413)
        files.push({ name: 'wheels/' + wheel, source: filename, bytes })
      }
      continue
    }
    if (!Object.hasOwn(allowed, name)) fail('unexpected output file')
    const filename = path.join(source, name)
    const bytes = regular(filename).size
    if (bytes > allowed[name]!) fail('output exceeds per-file cap', 413)
    files.push({ name, source: filename, bytes })
  }
  return files
}
function aggregateCap(kind: Kind, targetBytes: number): number {
  if (kind === 'notebook') return Math.min(2 * targetBytes, 256 * MiB)
  if (kind === 'metric') return Math.min(2 * targetBytes, 16 * MiB)
  if (kind === 'resolve') return Math.min(targetBytes + 8 * MiB, MAX_TOTAL)
  return Math.min(targetBytes, 2 * MiB)
}
function copyRegular(source: string, destination: string, expectedBytes: number): FileRecord {
  const sourceFd = fs.openSync(source, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW)
  const temporary = destination + '.' + randomUUID() + '.tmp'
  let destinationFd: number | undefined
  try {
    const before = fs.fstatSync(sourceFd)
    if (!before.isFile() || before.size !== expectedBytes) fail('output changed during export')
    if (fs.existsSync(destination) || fs.lstatSync(path.dirname(destination)).isSymbolicLink()) fail('output destination exists')
    destinationFd = fs.openSync(temporary, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600)
    const hash = createHash('sha256')
    const chunk = Buffer.allocUnsafe(64 * 1024)
    let bytes = 0
    while (bytes < expectedBytes) {
      const count = fs.readSync(sourceFd, chunk, 0, Math.min(chunk.length, expectedBytes - bytes), bytes)
      if (count === 0) fail('output truncated during export')
      let written = 0
      while (written < count) {
        const n = fs.writeSync(destinationFd, chunk, written, count - written)
        if (n === 0) fail('output write failed', 500)
        written += n
      }
      hash.update(chunk.subarray(0, count))
      bytes += count
    }
    const after = fs.fstatSync(sourceFd)
    if (after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.ino !== before.ino) fail('output changed during export')
    fs.fsyncSync(destinationFd)
    fs.closeSync(destinationFd); destinationFd = undefined
    fs.renameSync(temporary, destination)
    return { name: '', bytes, sha256: hash.digest('hex') }
  } finally {
    if (destinationFd !== undefined) fs.closeSync(destinationFd)
    fs.closeSync(sourceFd)
    try { fs.unlinkSync(temporary) } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
  }
}
async function body(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of request) {
    size += chunk.length
    if (size > 1024) fail('request too large', 413)
    chunks.push(chunk)
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')) }
  catch { return fail('invalid JSON') }
}
function preparationProgress(source: string, kind: 'resolve' | 'verify'): unknown {
  const filename = path.join(source, 'progress.ndjson')
  let fd: number
  try { fd = fs.openSync(filename, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW) }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error }
  try {
    const stat = fs.fstatSync(fd)
    if (!stat.isFile()) fail('non-regular progress')
    const start = Math.max(0, stat.size - MAX_PROGRESS)
    const data = Buffer.allocUnsafe(Math.min(stat.size, MAX_PROGRESS))
    let bytes = 0
    while (bytes < data.length) {
      const count = fs.readSync(fd, data, bytes, data.length - bytes, start + bytes)
      if (count === 0) break
      bytes += count
    }
    const lines = data.subarray(0, bytes).toString('utf8').split('\n')
    if (start > 0) lines.shift()
    const last = lines.filter(Boolean).at(-1)
    if (!last) return null
    if (Buffer.byteLength(last) > 2048) fail('progress event too large', 413)
    const event = JSON.parse(last) as Record<string, unknown>
    const output = event.downloadBytes ?? (event.resolved && typeof event.resolved === 'object' ? (event.resolved as Record<string, unknown>).downloadBytes : 0)
    return { phase: kind, cell: 0, cells: 0, outputBytes: Number.isSafeInteger(output) && Number(output) >= 0 ? output : 0 }
  } catch (error) { if (error instanceof SyntaxError) fail('invalid progress'); throw error }
  finally { fs.closeSync(fd) }
}
function progress(source: string, kind?: Kind): unknown {
  if (kind === 'resolve' || kind === 'verify') return preparationProgress(source, kind)
  const filename = path.join(source, 'progress.json')
  try {
    const stat = regular(filename)
    if (stat.size > MAX_PROGRESS) fail('progress too large', 413)
    const fd = fs.openSync(filename, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW)
    try {
      const data = Buffer.allocUnsafe(MAX_PROGRESS + 1)
      const bytes = fs.readSync(fd, data, 0, data.length, 0)
      if (bytes > MAX_PROGRESS) fail('progress too large', 413)
      return JSON.parse(data.subarray(0, bytes).toString('utf8'))
    } finally { fs.closeSync(fd) }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    if (error instanceof SyntaxError) fail('invalid progress')
    throw error
  }
}

export function createExportServer(options: ExportOptions): Server {
  if (!options.token || options.token.length > 512) throw new Error('export token is required')
  if (options.kind !== undefined && !Object.hasOwn(caps, options.kind)) throw new Error('invalid export kind')
  if (options.maxBytes !== undefined && (!Number.isSafeInteger(options.maxBytes) || options.maxBytes < 1 || options.maxBytes > MAX_TOTAL)) throw new Error('invalid export maximum')
  let cached: { kind: Kind, targetBytes: number, allowIncomplete: boolean, result: { files: FileRecord[], totalBytes: number } } | undefined
  let collecting = false
  return createServer(async (request, response) => {
    try {
      if (!authenticated(request.headers.authorization, options.token)) return json(response, 401, { error: 'unauthorized' })
      if (request.url === '/status' && request.method === 'GET') return json(response, 200, { progress: progress(options.source, options.kind) })
      if (request.url !== '/collect' || request.method !== 'POST') return json(response, 404, { error: 'not found' })
      if (collecting) return json(response, 409, { error: 'already collecting' })
      if (cached) {
        const retry = await body(request) as Record<string, unknown>
        return retry && retry.kind === cached.kind && retry.targetBytes === cached.targetBytes && (retry.allowIncomplete === true) === cached.allowIncomplete &&
          (!('allowIncomplete' in retry) || typeof retry.allowIncomplete === 'boolean') &&
          Object.keys(retry).every(key => key === 'kind' || key === 'targetBytes' || key === 'allowIncomplete')
          ? json(response, 200, cached.result) : json(response, 409, { error: 'already collected' })
      }
      collecting = true
      const created: string[] = []
      try {
        const parsed = await body(request) as Record<string, unknown>
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) fail('invalid request')
        const kind = parsed.kind as Kind
        const targetBytes = parsed.targetBytes
        const allowIncomplete = parsed.allowIncomplete === true
        if (!Object.hasOwn(caps, kind) || (options.kind && options.kind !== kind) || !Number.isSafeInteger(targetBytes) || (targetBytes as number) < 1 || (targetBytes as number) > (options.maxBytes ?? MAX_TOTAL) ||
            ('allowIncomplete' in parsed && typeof parsed.allowIncomplete !== 'boolean') ||
            Object.keys(parsed).some(key => key !== 'kind' && key !== 'targetBytes' && key !== 'allowIncomplete')) fail('invalid collection request')
        const files = listFiles(options.source, kind)
        if (!allowIncomplete && !files.some(file => file.name === required[kind])) fail('required output is missing')
        const totalBytes = files.reduce((sum, file) => sum + file.bytes, 0)
        if (totalBytes > aggregateCap(kind, targetBytes as number)) fail('outputs exceed aggregate cap', 413)
        if (kind === 'notebook' && files.some(file => file.name === 'submission.csv' && file.bytes > (targetBytes as number))) fail('submission exceeds target cap', 413)
        if (kind === 'resolve' && files.filter(file => file.name.startsWith('wheels/')).reduce((sum, file) => sum + file.bytes, 0) > (targetBytes as number)) fail('wheels exceed target cap', 413)
        if (kind === 'metric' && files.some(file => file.name === 'score.json' && file.bytes > (targetBytes as number))) fail('score exceeds target cap', 413)
        if (files.some(file => file.name.startsWith('wheels/'))) {
          const wheels = path.join(options.destination, 'wheels')
          if (fs.existsSync(wheels)) { if (!fs.lstatSync(wheels).isDirectory()) fail('invalid destination directory') }
          else fs.mkdirSync(wheels, { mode: 0o700 })
        }
        const records = files.map(file => {
          const destination = path.join(options.destination, file.name)
          const record = copyRegular(file.source, destination, file.bytes)
          created.push(destination)
          return { ...record, name: file.name }
        })
        const result = { files: records, totalBytes }
        cached = { kind, targetBytes: targetBytes as number, allowIncomplete, result }
        return json(response, 200, result)
      } catch (error) {
        for (const file of created) fs.unlinkSync(file)
        throw error
      } finally { collecting = false }
    } catch (error) {
      const status = error instanceof ExportError ? error.status : 500
      json(response, status, { error: status === 500 ? 'export failed' : (error as Error).message })
    }
  })
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const server = createExportServer({ source: '/out', destination: '/result', token: process.env.COMP_EXPORT_TOKEN || '',
    kind: process.env.COMP_EXPORT_KIND as Kind, maxBytes: Number(process.env.COMP_EXPORT_MAX_BYTES) })
  server.listen(8765, '0.0.0.0')
}
