import { test } from 'node:test'
import assert from 'node:assert/strict'
import { once } from 'node:events'
import { connect } from 'node:net'
import { createCompetitionProxy, publicIPv4 } from '../runtime/src/competition-proxy.ts'

test('proxy permits public addresses and rejects special-use IPv4 ranges', () => {
  assert.equal(publicIPv4('151.101.0.223'), true)
  for (const address of ['127.0.0.1', '10.1.2.3', '100.64.0.1', '169.254.169.254',
    '172.16.0.1', '192.168.0.1', '192.88.99.1', '198.18.0.1', '203.0.113.1', '::1']) {
    assert.equal(publicIPv4(address), false, address)
  }
})

test('competition proxy rejects CONNECT to arbitrary hosts and plain HTTP', async () => {
  const server = createCompetitionProxy({ maxBytes: 1024, seconds: 5 })
  server.listen(0, '127.0.0.1'); await once(server, 'listening')
  const address = server.address(); assert.ok(address && typeof address !== 'string')
  const request = async (text: string) => {
    const socket = connect(address.port, '127.0.0.1'); await once(socket, 'connect')
    socket.write(text)
    const [response] = await once(socket, 'data')
    socket.destroy()
    return (response as Buffer).toString('ascii')
  }
  try {
    assert.match(await request('CONNECT 127.0.0.1:443 HTTP/1.1\r\n\r\n'), /^HTTP\/1\.1 403/)
    assert.match(await request('CONNECT example.com:443 HTTP/1.1\r\n\r\n'), /^HTTP\/1\.1 403/)
    assert.match(await request('GET https:\/\/pypi.org/ HTTP/1.1\r\n\r\n'), /^HTTP\/1\.1 403/)
  } finally { server.close(); await once(server, 'close') }
})
