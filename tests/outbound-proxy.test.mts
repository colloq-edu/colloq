/**
 * Outbound HTTP through an institution's proxy (server/src/outbound.ts).
 *
 * A university server often gets out only through an HTTP proxy named in
 * HTTPS_PROXY/HTTP_PROXY/NO_PROXY. These tests prove the three promises:
 * nothing changes without the variables; with them, what leaves the campus
 * (the model endpoint, GitHub) goes through the proxy while Colloq's own
 * traffic and NO_PROXY destinations go direct; and the OpenAI SDK, which has a
 * transport of its own, follows the same road. The proxy is a local fake that
 * records what it was asked; nothing leaves this machine.
 */
import './_env.mts'
import { after, afterEach, test } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import type net from 'node:net'
import { once } from 'node:events'
import {
  bypassesProxy,
  installOutboundProxy,
  outboundProxyActive,
  parseNoProxy,
  proxyBuildArgs,
  proxyEnvironmentFor,
  proxySettings,
  redactedArgument,
  redactedProxy,
} from '../server/src/outbound.js'
import { updateOracleSettings } from '../server/src/admin/settings.js'
import { streamChat } from '../server/src/ai/provider.js'

const DISPATCHER = Symbol.for('undici.globalDispatcher.1')
let undo: (() => Promise<void>) | null = null
afterEach(async () => {
  await undo?.()
  undo = null
})

/** A proxy that answers plain requests itself (as the model endpoint) and refuses tunnels, remembering both. */
async function fakeProxy() {
  const seen: string[] = []
  const server = http.createServer((req, res) => {
    seen.push(`${req.method} ${req.url}`)
    let body = ''
    req.on('data', (chunk) => (body += chunk))
    req.on('end', () => {
      if (req.url?.endsWith('/chat/completions')) {
        res.setHeader('content-type', 'text/event-stream')
        res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: 'through ' } }] })}\n\n`)
        res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: 'the proxy' } }] })}\n\n`)
        res.end('data: [DONE]\n\n')
        return
      }
      res.end(`proxied ${req.url} ${body}`)
    })
  })
  server.on('connect', (req, socket) => {
    seen.push(`CONNECT ${req.url}`)
    socket.end('HTTP/1.1 403 Forbidden\r\n\r\n')
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  return { seen, url: `http://127.0.0.1:${(server.address() as net.AddressInfo).port}`, close: () => server.close() }
}

async function directServer() {
  const seen: string[] = []
  const server = http.createServer((req, res) => {
    seen.push(`${req.method} ${req.url}`)
    res.end('direct')
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  return { seen, port: (server.address() as net.AddressInfo).port, close: () => server.close() }
}

test('no proxy variable: nothing is installed, and undici is not even loaded into the dispatcher slot', async () => {
  const before = (globalThis as Record<symbol, unknown>)[DISPATCHER]
  assert.equal(await installOutboundProxy({ NO_PROXY: 'campus.edu' }), null)
  assert.equal(outboundProxyActive(), false)
  assert.equal((globalThis as Record<symbol, unknown>)[DISPATCHER], before)
  assert.deepEqual(proxyEnvironmentFor({}), {})
})

test('the variables read as curl reads them: lowercase first, a bare host gets http://, https falls back to http', () => {
  assert.deepEqual(proxySettings({}), { http: '', https: '', noProxy: '', problems: [] })
  const both = proxySettings({ HTTPS_PROXY: 'http://upper:3128', https_proxy: 'http://lower:3128', HTTP_PROXY: 'proxy.campus.edu:8080', no_proxy: '.campus.edu' })
  assert.deepEqual(both, { http: 'http://proxy.campus.edu:8080', https: 'http://lower:3128', noProxy: '.campus.edu', problems: [] })
  // An empty lowercase spelling does not hide the uppercase one.
  assert.equal(proxySettings({ https_proxy: '', HTTPS_PROXY: 'http://upper:3128' }).https, 'http://upper:3128')
  // Only HTTP_PROXY: https uses it too, as undici and most tools do.
  assert.equal(proxySettings({ HTTP_PROXY: 'http://proxy:3128' }).https, 'http://proxy:3128')
  // Only HTTPS_PROXY: plain http goes direct.
  assert.equal(proxySettings({ HTTPS_PROXY: 'http://proxy:3128' }).http, '')
  // Junk is reported and ignored, not a crash at start.
  const junk = proxySettings({ HTTPS_PROXY: 'socks5://proxy:1080', HTTP_PROXY: 'http://' })
  assert.equal(junk.https, '')
  assert.equal(junk.http, '')
  assert.equal(junk.problems.length, 2)
  // Credentials never reach a log line.
  assert.equal(redactedProxy('http://student:s3cret@proxy.campus.edu:3128'), 'http://student:***@proxy.campus.edu:3128')
  // What package preparation's proxy container gets: one of each, the same reading.
  assert.deepEqual(proxyEnvironmentFor({ http_proxy: 'proxy:3128', NO_PROXY: 'nexus.campus.edu' }), {
    HTTPS_PROXY: 'http://proxy:3128',
    NO_PROXY: 'nexus.campus.edu',
  })
})

test("Colloq's own destinations always go direct; the outside world goes through the proxy", () => {
  const none = parseNoProxy('')
  const direct = [
    'http://127.0.0.1:49213/api/kernels', 'http://localhost:3000/', 'http://[::1]:8888/', // a room's published port
    'http://colloq-room-abc123:8888/api/status', 'http://colloq-runtime:8787/v1/rooms', // compose, k3s broker
    'http://colloq-room-abc.colloq.svc:8888/api', 'http://ollama.default.svc.cluster.local:11434/v1', // k3s Services
    'http://10.1.2.3:8000/v1', 'http://192.168.1.20/v1', 'http://172.20.0.5/', 'http://100.64.3.4/', // a model on the LAN
    'http://169.254.169.254/', 'http://[fd00::5]:8000/', 'http://host.docker.internal:11434/', 'https://printer.local/',
  ]
  for (const url of direct) assert.equal(bypassesProxy(new URL(url), none), true, url)
  const proxied = ['https://api.openai.com/v1', 'https://api.github.com/repos/a/b', 'https://raw.githubusercontent.com/a/b/HEAD/x.ipynb', 'http://8.8.8.8/', 'https://llm.campus.edu/v1']
  for (const url of proxied) assert.equal(bypassesProxy(new URL(url), none), false, url)
})

test('NO_PROXY: domains with everything under them, ports, ranges for literal addresses, and *', () => {
  for (const entry of ['campus.edu', '.campus.edu', '*.campus.edu', 'CAMPUS.EDU.']) {
    const rules = parseNoProxy(`example.org, ${entry}`)
    assert.equal(bypassesProxy(new URL('https://llm.campus.edu/v1'), rules), true, entry)
    assert.equal(bypassesProxy(new URL('https://campus.edu/'), rules), true, entry)
    assert.equal(bypassesProxy(new URL('https://evilcampus.edu/'), rules), false, `${entry}: a suffix is a domain, not a string`)
    assert.equal(bypassesProxy(new URL('https://api.openai.com/'), rules), false, entry)
  }
  const port = parseNoProxy('llm.campus.edu:8443')
  assert.equal(bypassesProxy(new URL('https://llm.campus.edu:8443/v1'), port), true)
  assert.equal(bypassesProxy(new URL('https://llm.campus.edu/v1'), port), false)
  const ranges = parseNoProxy('203.0.113.0/24 2001:db8::/32,198.51.100.7')
  assert.equal(bypassesProxy(new URL('https://203.0.113.10/v1'), ranges), true)
  assert.equal(bypassesProxy(new URL('https://198.51.100.7/'), ranges), true)
  assert.equal(bypassesProxy(new URL('https://198.51.100.8/'), ranges), false)
  assert.equal(bypassesProxy(new URL('https://[2001:db8::5]/'), ranges), true)
  assert.equal(bypassesProxy(new URL('https://llm.campus.edu/'), ranges), false, 'ranges match literal addresses only')
  assert.equal(bypassesProxy(new URL('https://api.openai.com/'), parseNoProxy('*')), true)
  // Junk exempts nothing.
  assert.equal(bypassesProxy(new URL('https://api.openai.com/'), parseNoProxy('10.0.0.0/99, /8')), false)
})

test('with a proxy set, fetch goes through it for the outside and direct for loopback and NO_PROXY', async () => {
  const proxy = await fakeProxy()
  const local = await directServer()
  try {
    undo = await installOutboundProxy({ HTTP_PROXY: proxy.url, NO_PROXY: 'model.example.test' })
    assert.equal(outboundProxyActive(), true)
    // Plain http: an ordinary proxy request, body and all.
    assert.equal(await (await fetch('http://example.test/x', { method: 'POST', body: 'hi' })).text(), 'proxied http://example.test/x hi')
    // https (GitHub import): a CONNECT tunnel to the right authority.
    await assert.rejects(fetch('https://api.github.com/repos/colloq-edu/colloq/contents'))
    // A room's Jupyter on a loopback port: never through the proxy.
    assert.equal(await (await fetch(`http://127.0.0.1:${local.port}/api/status`)).text(), 'direct')
    // NO_PROXY: goes direct, which here means a name that does not resolve.
    await assert.rejects(fetch('http://model.example.test/v1/models'))
    assert.deepEqual(proxy.seen, ['POST http://example.test/x', 'CONNECT api.github.com:443'])
    assert.deepEqual(local.seen, ['GET /api/status'])
  } finally {
    proxy.close()
    local.close()
  }
  await undo?.()
  undo = null
  assert.equal(outboundProxyActive(), false)
})

test('the OpenAI client, which has its own transport, streams through the proxy too', async () => {
  const proxy = await fakeProxy()
  try {
    undo = await installOutboundProxy({ HTTPS_PROXY: proxy.url, HTTP_PROXY: proxy.url })
    // A new host means a new client, built after the proxy is in place.
    updateOracleSettings({ provider: 'custom', baseUrl: 'http://model.example.test/v1', apiKey: 'test-key', model: 'test-model' })
    const deltas: string[] = []
    const answer = await streamChat([{ role: 'user', content: 'hello' }], (text) => deltas.push(text))
    assert.equal(answer, 'through the proxy')
    assert.deepEqual(deltas, ['through ', 'the proxy'])
    assert.deepEqual(proxy.seen, ['POST http://model.example.test/v1/chat/completions'])
  } finally {
    proxy.close()
  }
})

test('an internal model endpoint named in NO_PROXY never reaches the proxy', async () => {
  const proxy = await fakeProxy()
  const model = await directServer()
  try {
    undo = await installOutboundProxy({ HTTPS_PROXY: proxy.url, HTTP_PROXY: proxy.url, NO_PROXY: 'llm.campus.test' })
    updateOracleSettings({ provider: 'custom', baseUrl: 'http://llm.campus.test/v1', apiKey: 'test-key', model: 'test-model' })
    // Direct means DNS here, and the name does not exist: the request fails
    // without the proxy seeing it.
    await assert.rejects(streamChat([{ role: 'user', content: 'hello' }], () => {}))
    // And a model on this very machine is reached directly by its address.
    updateOracleSettings({ provider: 'custom', baseUrl: `http://127.0.0.1:${model.port}/v1`, apiKey: 'test-key', model: 'test-model' })
    await streamChat([{ role: 'user', content: 'hello' }], () => {}).catch(() => '')
    assert.deepEqual(proxy.seen, [])
    assert.deepEqual(model.seen, ['POST /v1/chat/completions'])
  } finally {
    proxy.close()
    model.close()
  }
})

test('environment builds get the proxy as Docker\'s predefined build arguments, both spellings, and the log hides the password', () => {
  assert.deepEqual(proxyBuildArgs({}), [])
  const args = proxyBuildArgs({ HTTPS_PROXY: 'http://student:s3cret@proxy.campus.edu:3128', NO_PROXY: '.campus.edu' })
  // Only HTTPS_PROXY: plain http in the build goes direct, as for this process.
  assert.deepEqual(args, [
    '--build-arg', 'HTTPS_PROXY=http://student:s3cret@proxy.campus.edu:3128',
    '--build-arg', 'https_proxy=http://student:s3cret@proxy.campus.edu:3128',
    '--build-arg', 'NO_PROXY=.campus.edu', '--build-arg', 'no_proxy=.campus.edu',
  ])
  assert.deepEqual(args.map(redactedArgument).filter((arg) => arg.includes('proxy.campus.edu')), [
    'HTTPS_PROXY=http://student:***@proxy.campus.edu:3128',
    'https_proxy=http://student:***@proxy.campus.edu:3128',
  ])
  assert.equal(redactedArgument('KERNEL_ENV=cv'), 'KERNEL_ENV=cv')
  assert.equal(proxyBuildArgs({ HTTP_PROXY: 'http://proxy:3128' }).filter((arg) => arg !== '--build-arg').length, 4)
})

test('a proxy on this machine\'s loopback is not handed to containers, which cannot reach it', () => {
  for (const address of ['http://127.0.0.1:3128', 'http://localhost:3128', 'http://[::1]:3128']) {
    assert.deepEqual(proxyEnvironmentFor({ HTTPS_PROXY: address }), {}, address)
    assert.deepEqual(proxyBuildArgs({ HTTPS_PROXY: address, HTTP_PROXY: address }), [], address)
  }
  // This process still uses it for its own requests.
  assert.equal(proxySettings({ HTTPS_PROXY: 'http://127.0.0.1:3128' }).https, 'http://127.0.0.1:3128')
})

after(async () => {
  await undo?.()
})
