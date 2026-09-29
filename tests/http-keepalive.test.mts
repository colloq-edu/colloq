/**
 * The HTTP server keeps idle keep-alive sockets longer than the proxies in
 * front of it (frps about a minute, Caddy two minutes). With Node's default
 * of 5 s, a POST that a proxy sent on a socket Node was closing came back as
 * the relay's 404 page (29 Sep 2026). server/src/index.ts starts the server
 * on import, so the numbers are read from its source.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const source = readFileSync(new URL('../server/src/index.ts', import.meta.url), 'utf8')
const number = (name: string): number => {
  const match = new RegExp(`server\\.${name}\\s*=\\s*([\\d_]+)`).exec(source)
  assert.ok(match, `server.${name} is set in server/src/index.ts`)
  return Number(match[1].replace(/_/g, ''))
}

test('keep-alive outlives the proxies, and the headers timer outlives keep-alive', () => {
  const keepAlive = number('keepAliveTimeout')
  const headers = number('headersTimeout')
  assert.ok(keepAlive > 120_000, `keepAliveTimeout ${keepAlive} ms must exceed Caddy's 2-minute idle keep-alive`)
  assert.ok(headers > keepAlive, `headersTimeout ${headers} ms must exceed keepAliveTimeout ${keepAlive} ms`)
})
