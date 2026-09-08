import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import express from 'express'
import { createAnchoredFilesystem, downloadHeldFile } from '../server/src/secure-files.js'

test('download serves the held inode with original MIME/name and byte ranges after a symlink swap', { skip: process.platform !== 'linux' }, async () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'colloq-fd-http-'))
  const root = path.join(base, 'workspace'); fs.mkdirSync(root)
  const file = path.join(root, 'table.csv'), secret = path.join(base, 'secret')
  fs.writeFileSync(file, 'abcdefghij'); fs.writeFileSync(secret, 'SECRET-OUTSIDE')
  const safe = createAnchoredFilesystem(root, { allowUnsafeDevelopment: false })
  const app = express()
  app.get('/file', (_req, res) => {
    const held = safe.openRead(file)
    fs.unlinkSync(file); fs.symlinkSync(secret, file)
    downloadHeldFile(res, held, 'table.csv')
  })
  const server = app.listen(0, '127.0.0.1'); await new Promise<void>(resolve => server.once('listening', resolve))
  try {
    const address = server.address() as { port: number }
    const response = await fetch(`http://127.0.0.1:${address.port}/file`, { headers: { Range: 'bytes=2-5' } })
    assert.equal(response.status, 206); assert.equal(await response.text(), 'cdef')
    assert.match(response.headers.get('content-type')!, /^text\/csv/)
    assert.match(response.headers.get('content-disposition')!, /table\.csv/)
    assert.equal(response.headers.get('content-range'), 'bytes 2-5/10')
  } finally {
    server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()))
    safe.close(); fs.rmSync(base, { recursive: true, force: true })
  }
})
