/**
 * Competition "own packages" from an institution's index, through its proxy,
 * with its CA (shared/dependency-source.ts, server/src/dependencies/source.ts,
 * preparation-python.ts, runtime/src/competition-proxy.ts).
 *
 * A campus with its own PyPI mirror (Nexus, Artifactory, devpi) and no direct
 * internet must be able to prepare packages, while everything the sandbox
 * promised stays true: the resolver talks only to the CONNECT proxy, the proxy
 * opens only the configured hosts, public PyPI's hosts never resolve to
 * private addresses, and nothing inherited from the environment steers pip.
 * No container runs here: docker is a script that records what it was asked,
 * the Python programs run their functions directly, and sockets stay local.
 */
import { TEST_ROOT } from './_env.mts'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { once } from 'node:events'
import { connect } from 'node:net'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { dependencySource, DependencySourceError, PUBLIC_PYPI_INDEX } from '../shared/dependency-source.ts'
import { PREPARATION_PROXY_PYTHON, PREPARATION_PYTHON } from '../server/src/dependencies/preparation-python.ts'
import { prepareDependencies } from '../server/src/dependencies/preparation.ts'
import { prepareBrokerDependencies } from '../server/src/dependencies/broker-preparation.ts'
import { campusIPv4, createCompetitionProxy } from '../runtime/src/competition-proxy.ts'
import { CompetitionJobs } from '../runtime/src/competition-jobs.ts'
import { parseRuntimeCatalog } from '../shared/runtime.ts'

const PEM = '-----BEGIN CERTIFICATE-----\nMIIBcampusCA\n-----END CERTIFICATE-----\n'

function python(source: string, code: string, env: Record<string, string> = {}) {
  const result = spawnSync('python3', ['-c', `__name__ = 'test_helper'\n${source}\n${code}`], { encoding: 'utf8', env: { ...process.env, ...env }, timeout: 30_000 })
  assert.equal(result.status, 0, result.stderr || result.stdout)
  return result.stdout.trim()
}

function withEnv<T>(vars: Record<string, string | undefined>, body: () => Promise<T>): Promise<T> {
  const before = new Map(Object.keys(vars).map((key) => [key, process.env[key]]))
  for (const [key, value] of Object.entries(vars)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  return body().finally(() => {
    for (const [key, value] of before) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  })
}

/* ------------------------------------------------------------ the settings */

test('by default: public PyPI, exactly the two hosts of today, none of them allowed on private addresses', () => {
  assert.deepEqual(dependencySource({}), {
    indexUrl: PUBLIC_PYPI_INDEX,
    publicPypi: true,
    authorities: ['pypi.org:443', 'files.pythonhosted.org:443'],
    configured: [],
    files: ['files.pythonhosted.org:443'],
  })
})

test('a campus mirror: its host serves the files, extra file hosts join, all of them configured', () => {
  assert.deepEqual(dependencySource({ DEPENDENCY_INDEX_URL: ' https://Nexus.Campus.edu/repository/pypi-proxy/simple/ ' }), {
    indexUrl: 'https://nexus.campus.edu/repository/pypi-proxy/simple',
    publicPypi: false,
    authorities: ['nexus.campus.edu:443'],
    configured: ['nexus.campus.edu:443'],
    files: ['nexus.campus.edu:443'],
  })
  const devpi = dependencySource({
    DEPENDENCY_INDEX_URL: 'https://10.20.30.40:3141/root/pypi/+simple/',
    DEPENDENCY_FILES_HOSTS: 'files.campus.edu, https://cdn.campus.edu:8443/ files.campus.edu',
  })
  assert.equal(devpi.indexUrl, 'https://10.20.30.40:3141/root/pypi/+simple')
  assert.deepEqual(devpi.authorities, ['10.20.30.40:3141', 'files.campus.edu:443', 'cdn.campus.edu:8443'])
  assert.deepEqual(devpi.configured, devpi.authorities)
  assert.deepEqual(devpi.files, devpi.authorities)
  // PyPI named explicitly is still PyPI: its files keep coming from files.pythonhosted.org.
  const explicit = dependencySource({ DEPENDENCY_INDEX_URL: 'https://pypi.org/simple/' })
  assert.equal(explicit.publicPypi, true)
  assert.deepEqual(explicit.files, ['files.pythonhosted.org:443'])
})

test('an index that could leak or be forged is refused with the reason, never silently replaced by PyPI', () => {
  for (const [value, reason] of [
    ['http://nexus.campus.edu/simple', /https/],
    ['https://student:secret@nexus.campus.edu/simple', /credentials/],
    ['https://nexus.campus.edu/simple?token=1', /query/],
    ['https://nexus.campus.edu/simple#x', /fragment/],
    ['https://[fd00::1]/simple', /host/],
    ['nexus.campus.edu/simple', /not a URL/],
  ] as const) {
    assert.throws(() => dependencySource({ DEPENDENCY_INDEX_URL: value }), (err: unknown) => err instanceof DependencySourceError && reason.test(err.message), value)
  }
  for (const value of ['bad host!', 'files.campus.edu:99999', 'ftp://files.campus.edu', 'files.campus.edu/path']) {
    assert.throws(() => dependencySource({ DEPENDENCY_FILES_HOSTS: value }), DependencySourceError, value)
  }
})

/* --------------------------------------------------------- the CONNECT proxy */

test('the Docker proxy admits the configured hosts only; configured ones may be campus addresses, never loopback or metadata', () => {
  python(PREPARATION_PROXY_PYTHON, `
configure({'allowed': ['nexus.campus.edu:443', 'files.campus.edu:8443'], 'configured': ['nexus.campus.edu:443', 'files.campus.edu:8443']}, {})
assert allowed_authority('nexus.campus.edu:443') and allowed_authority('files.campus.edu:8443')
for target in ['pypi.org:443', 'files.pythonhosted.org:443', 'nexus.campus.edu:8443', 'files.campus.edu:443']:
    assert not allowed_authority(target), target
for value in ['10.1.2.3', '172.20.0.9', '192.168.1.5', '100.64.0.7', 'fd00::5', '151.101.0.223']:
    assert campus_address(value), value
for value in ['127.0.0.1', '169.254.169.254', '0.0.0.0', '224.0.0.1', '::1', 'fe80::1', '::ffff:127.0.0.1', '240.0.0.1']:
    assert not campus_address(value), value
# Nothing configured: today's allowlist.
configure({}, {})
assert allowed_authority('pypi.org:443') and allowed_authority('files.pythonhosted.org:443') and not CONFIGURED and UPSTREAM is None
`)
})

test('a configured mirror on a campus address is connected, on its own port; PyPI with the same DNS answer is not', () => {
  python(PREPARATION_PROXY_PYTHON, `
listener = socket.socket(); listener.bind(('127.0.0.1', 0)); listener.listen(4); listener.settimeout(2)
port = listener.getsockname()[1]
authority = 'nexus.campus.test:%d' % port
configure({'allowed': [authority, 'pypi.org:443'], 'configured': [authority]}, {})
original_lookup, original_campus = socket.getaddrinfo, campus_address
socket.getaddrinfo = lambda host, *args, **kwargs: [(socket.AF_INET, socket.SOCK_STREAM, 6, '', ('127.0.0.1', port))]
# The listener stands in for a campus address; loopback itself is refused by campus_address (tested above).
campus_address = lambda value: True
server = Server(('127.0.0.1', 0), 100000, 10)
thread = threading.Thread(target=server.serve_forever, daemon=True); thread.start()
try:
    # A plain connect: create_connection would ask the patched getaddrinfo too.
    client = socket.socket(); client.settimeout(2); client.connect(server.server_address)
    client.sendall(('CONNECT %s HTTP/1.1\\r\\nHost: %s\\r\\n\\r\\n' % (authority, authority)).encode())
    assert client.recv(4096).startswith(b'HTTP/1.1 200'), 'the configured mirror was refused'
    connection, _ = listener.accept(); connection.close(); client.close()
    # Public PyPI resolving to a campus address: refused before any connection.
    client = socket.socket(); client.settimeout(2); client.connect(server.server_address)
    client.sendall(b'CONNECT pypi.org:443 HTTP/1.1\\r\\nHost: pypi.org:443\\r\\n\\r\\n')
    assert client.recv(4096) == b'', 'pypi.org was allowed onto a private address'
    listener.settimeout(0.2)
    try: listener.accept()
    except socket.timeout: pass
    else: raise AssertionError('a private upstream was contacted for pypi.org')
finally:
    client.close(); listener.close(); server.shutdown(); server.server_close(); socket.getaddrinfo = original_lookup
`)
})

test('behind the institution\'s proxy the tunnel goes through it, with its credentials; NO_PROXY and campus names go direct', () => {
  python(PREPARATION_PROXY_PYTHON, `
upstream = socket.socket(); upstream.bind(('127.0.0.1', 0)); upstream.listen(4); upstream.settimeout(3)
asked = []
def campus_proxy():
    connection, _ = upstream.accept()
    request = b''
    while b'\\r\\n\\r\\n' not in request: request += connection.recv(1)
    asked.append(request.decode())
    connection.sendall(b'HTTP/1.1 200 Connection established\\r\\n\\r\\n')
    connection.sendall(connection.recv(4))  # echo what the tunnel carries
    connection.close()
threading.Thread(target=campus_proxy, daemon=True).start()
configure({}, {'HTTPS_PROXY': 'http://student:p%40ss@127.0.0.1:' + str(upstream.getsockname()[1]), 'NO_PROXY': '.campus.edu,10.0.0.0/8'})
server = Server(('127.0.0.1', 0), 100000, 10)
thread = threading.Thread(target=server.serve_forever, daemon=True); thread.start()
try:
    client = socket.create_connection(server.server_address, 3)
    client.sendall(b'CONNECT pypi.org:443 HTTP/1.1\\r\\nHost: pypi.org:443\\r\\n\\r\\n')
    assert client.recv(4096).startswith(b'HTTP/1.1 200'), 'no tunnel through the campus proxy'
    client.sendall(b'ping'); assert client.recv(4) == b'ping'
    client.close()
    request = asked[0]
    assert request.startswith('CONNECT pypi.org:443 HTTP/1.1\\r\\n'), request
    assert 'Proxy-Authorization: Basic ' + base64.b64encode(b'student:p@ss').decode() in request, request
finally:
    server.shutdown(); server.server_close(); upstream.close()
# What goes direct: NO_PROXY (domains, ranges, ports), campus-local names and addresses.
for host, port in [('nexus.campus.edu', 443), ('campus.edu', 443), ('10.9.8.7', 443), ('devpi', 3141), ('mirror.local', 443), ('192.168.1.4', 443)]:
    assert goes_direct(host, port), host
for host, port in [('pypi.org', 443), ('files.pythonhosted.org', 443), ('evilcampus.edu', 443), ('8.8.8.8', 443)]:
    assert not goes_direct(host, port), host
NO_PROXY = 'nexus.campus.edu:8443'
assert goes_direct('nexus.campus.edu', 8443) and not goes_direct('nexus.campus.edu', 443)
NO_PROXY = '*'
assert goes_direct('pypi.org', 443)
try: upstream_proxy('https://proxy.campus.edu:3129')
except ValueError: pass
else: raise AssertionError('a TLS proxy was accepted for chaining')
`)
})

test('the k3s proxy reads the same settings: configured hosts on their ports, campus addresses allowed only for them', async () => {
  for (const address of ['10.1.2.3', '172.16.0.9', '192.168.1.5', '100.64.1.1', '151.101.0.223']) assert.equal(campusIPv4(address), true, address)
  for (const address of ['127.0.0.1', '0.1.2.3', '169.254.169.254', '224.0.0.1', '255.255.255.255', '::1']) assert.equal(campusIPv4(address), false, address)
  const source = dependencySource({ DEPENDENCY_INDEX_URL: 'https://nexus.campus.edu:8443/repository/pypi/simple' })
  const server = createCompetitionProxy({ maxBytes: 1024, seconds: 5, source })
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
    // With a mirror configured, public PyPI is no longer on the list.
    assert.match(await request('CONNECT pypi.org:443 HTTP/1.1\r\n\r\n'), /^HTTP\/1\.1 403/)
    assert.match(await request('CONNECT nexus.campus.edu:443 HTTP/1.1\r\n\r\n'), /^HTTP\/1\.1 403/, 'the port is part of the authority')
  } finally { server.close(); await once(server, 'close') }
})

/* ------------------------------------------------------------- the resolver */

test('the resolver asks the configured index, takes wheels only from its file hosts, and checks a missing project there', () => {
  python(PREPARATION_PYTHON, `
use_source({'index': {'url': 'https://nexus.campus.edu/repository/pypi/simple', 'publicPypi': False, 'files': ['nexus.campus.edu:443', 'cdn.campus.edu:8443']}})
assert safe_url('https://nexus.campus.edu/repository/pypi/packages/demo-1.0-py3-none-any.whl')
assert safe_url('https://cdn.campus.edu:8443/demo-1.0-py3-none-any.whl')
for url in ['https://files.pythonhosted.org/packages/demo-1.0-py3-none-any.whl', 'https://cdn.campus.edu/demo.whl', 'http://nexus.campus.edu/demo.whl',
            'https://user:pw@nexus.campus.edu/demo.whl', 'https://nexus.campus.edu:99999/demo.whl', 'https://nexus.campus.edu.evil.test/demo.whl']:
    try: safe_url(url)
    except PreparationFailure as error: assert error.code == 'unsupported_source', url
    else: raise AssertionError(url)
# A missing project is asked of the mirror's simple API, not of pypi.org.
asked = []
def urlopen(url, timeout=None):
    asked.append(url)
    raise urllib.error.HTTPError(url, 404, 'Not Found', {}, None)
urllib.request.urlopen = urlopen
try: pip_failed('ERROR: No matching distribution found for Demo_Pkg', 'resolution_failed')
except PreparationFailure as error: assert error.code == 'package_not_found' and 'package index' in error.message, (error.code, error.message)
else: raise AssertionError('a missing project was not named')
assert asked == ['https://nexus.campus.edu/repository/pypi/simple/demo-pkg/'], asked
# Without an index in the request: public PyPI, exactly as before.
use_source({})
assert INDEX_URL == 'https://pypi.org/simple' and PUBLIC_PYPI and FILES == {'files.pythonhosted.org:443'}
assert safe_url('https://files.pythonhosted.org/packages/demo-1.0-py3-none-any.whl')
asked.clear()
try: pip_failed('ERROR: No matching distribution found for demo', 'resolution_failed')
except PreparationFailure as error: assert error.code == 'package_not_found'
assert asked == ['https://pypi.org/pypi/demo/json'], asked
`)
})

test('pip gets the configured index, and the institution\'s CA joins the public roots instead of replacing them', () => {
  const room = fs.mkdtempSync(path.join(TEST_ROOT, 'room-'))
  const extra = path.join(room, 'extra-ca.pem')
  fs.writeFileSync(extra, PEM)
  python(PREPARATION_PYTHON, `
commands = []
def resolver(arguments, default_code, metadata_paths=None, base=None, on_full=None):
    commands.append(arguments)
    pathlib.Path(arguments[arguments.index('--report') + 1]).write_text('{"install": []}')
    return ''
run_pip, inventory_matches = resolver, lambda base: None
real_trust = trust_extra_ca
trust_extra_ca = lambda: real_trust(pathlib.Path(${JSON.stringify(extra)}))
resolve({'requirementsText': 'demo', 'basePackages': [], 'maxDownloadBytes': 10 ** 6, 'maxInstalledBytes': 10 ** 6,
         'index': {'url': 'https://nexus.campus.edu/simple', 'publicPypi': False, 'files': ['nexus.campus.edu:443']}})
arguments = commands[-1]
assert arguments[arguments.index('--index-url') + 1] == 'https://nexus.campus.edu/simple', arguments
# On pip's command line: --isolated makes pip ignore PIP_CERT like every PIP_* variable.
bundle = pathlib.Path(arguments[arguments.index('--cert') + 1])
assert bundle == ROOM / 'ca-bundle.pem', arguments
text = bundle.read_text()
from pip._vendor import certifi
assert text.startswith(pathlib.Path(certifi.where()).read_text().rstrip('\\n')), 'the public roots were dropped'
assert text.endswith(${JSON.stringify(PEM)}), 'the campus CA is missing'
assert os.environ['SSL_CERT_FILE'] == os.environ['REQUESTS_CA_BUNDLE'] == str(bundle)
# No CA handed over: nothing changes, and pip gets no --cert.
del os.environ['SSL_CERT_FILE'], os.environ['REQUESTS_CA_BUNDLE']
assert real_trust(pathlib.Path(${JSON.stringify(path.join(room, 'absent.pem'))})) is None and 'SSL_CERT_FILE' not in os.environ
trust_extra_ca = lambda: real_trust(pathlib.Path(${JSON.stringify(path.join(room, 'absent.pem'))}))
resolve({'requirementsText': 'demo', 'basePackages': [], 'maxDownloadBytes': 10 ** 6, 'maxInstalledBytes': 10 ** 6})
assert '--cert' not in commands[-1] and commands[-1][commands[-1].index('--index-url') + 1] == 'https://pypi.org/simple', commands[-1]
`, { COMP_OUT: room })
  fs.rmSync(room, { recursive: true, force: true })
})

/* ------------------------------------------------- the server's two backends */

/** A docker that records every call, keeps a copy of what a phase container is given in /input, then fails the phase. */
function recordingDocker(name: string) {
  const bin = path.join(TEST_ROOT, `${name}-bin`)
  const log = path.join(TEST_ROOT, `${name}-calls.jsonl`)
  const seen = path.join(TEST_ROOT, `${name}-input`)
  fs.mkdirSync(bin, { recursive: true })
  fs.writeFileSync(path.join(bin, 'docker'), `#!${process.execPath}
const fs = require('node:fs'), path = require('node:path')
const args = process.argv.slice(2)
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify(args) + '\\n')
if (args[0] === 'run') {
  const mount = args.find(arg => arg.startsWith('type=bind,') && arg.includes(',dst=/input'))
  const src = /src=([^,]+)/.exec(mount)[1]
  fs.cpSync(src, ${JSON.stringify(seen)}, { recursive: true })
  process.exitCode = 1
}
`, { mode: 0o755 })
  const calls = () => fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line) as string[]) : []
  return { bin, seen, calls }
}

const request = (name: string) => ({
  id: name, imageDigest: 'sha256:' + 'a'.repeat(64), requirementsText: 'demo', basePackages: [],
  workDir: path.join(TEST_ROOT, `${name}-work`), maxDownloadBytes: 1024 * 1024, maxInstalledBytes: 1024 * 1024,
  signal: new AbortController().signal,
})

test('Docker: the proxy container gets the allowlist and the campus proxy; the resolver keeps pointing at our proxy only', async () => {
  const docker = recordingDocker('egress-docker')
  const ca = path.join(TEST_ROOT, 'campus-ca.pem')
  fs.writeFileSync(ca, PEM)
  await withEnv({
    PATH: docker.bin + path.delimiter + process.env.PATH,
    DEPENDENCY_INDEX_URL: 'https://nexus.campus.edu/repository/pypi/simple',
    DEPENDENCY_FILES_HOSTS: undefined,
    HTTPS_PROXY: undefined, https_proxy: undefined, HTTP_PROXY: 'http://proxy.campus.edu:3128', http_proxy: undefined,
    NO_PROXY: '.campus.edu', no_proxy: undefined,
    NODE_EXTRA_CA_CERTS: ca,
  }, async () => {
    await assert.rejects(prepareDependencies(request('egress-docker')), { code: 'preparation_failed' })
  })
  const calls = docker.calls()
  const create = calls.find((args) => args[0] === 'create')!
  const image = create.indexOf('sha256:' + 'a'.repeat(64))
  const options = create.slice(0, image)
  assert.ok(options.includes('--network=bridge'))
  assert.ok(options.includes('HTTPS_PROXY=http://proxy.campus.edu:3128'), JSON.stringify(options))
  assert.ok(options.includes('NO_PROXY=.campus.edu'), JSON.stringify(options))
  assert.deepEqual(JSON.parse(create.at(-1)!), { allowed: ['nexus.campus.edu:443'], configured: ['nexus.campus.edu:443'] })
  // The resolver: our proxy and nothing else, whatever the server's environment says.
  const resolver = calls.find((args) => args[0] === 'run')!
  assert.ok(resolver.includes('HTTPS_PROXY=http://pypi-proxy:3128') && resolver.includes('NO_PROXY='), JSON.stringify(resolver))
  assert.ok(!resolver.some((arg) => arg.includes('proxy.campus.edu')), 'the campus proxy reached the resolver')
  // Its request names the index; the CA travels as a file of the request, not as a mount.
  const job = JSON.parse(fs.readFileSync(path.join(docker.seen, 'request.json'), 'utf8'))
  assert.deepEqual(job.index, { url: 'https://nexus.campus.edu/repository/pypi/simple', publicPypi: false, files: ['nexus.campus.edu:443'] })
  assert.equal(fs.readFileSync(path.join(docker.seen, 'extra-ca.pem'), 'utf8'), PEM)
  assert.equal(resolver.filter((arg) => arg === '--mount').length, 2)
})

test('Docker: without settings, the proxy runs exactly as before; a bad index or a TLS proxy stops before any container', async () => {
  const plain = recordingDocker('egress-plain')
  await withEnv({
    PATH: plain.bin + path.delimiter + process.env.PATH, DEPENDENCY_INDEX_URL: undefined, DEPENDENCY_FILES_HOSTS: undefined,
    HTTPS_PROXY: undefined, https_proxy: undefined, HTTP_PROXY: undefined, http_proxy: undefined, NODE_EXTRA_CA_CERTS: undefined,
  }, async () => {
    await assert.rejects(prepareDependencies(request('egress-plain')), { code: 'preparation_failed' })
  })
  const create = plain.calls().find((args) => args[0] === 'create')!
  assert.ok(!create.some((arg) => /PROXY=/.test(arg)), JSON.stringify(create))
  assert.deepEqual(JSON.parse(create.at(-1)!), { allowed: ['pypi.org:443', 'files.pythonhosted.org:443'], configured: [] })
  assert.ok(!fs.existsSync(path.join(plain.seen, 'extra-ca.pem')))

  for (const [vars, reason] of [
    [{ DEPENDENCY_INDEX_URL: 'http://nexus.campus.edu/simple' }, /https/],
    [{ DEPENDENCY_INDEX_URL: undefined, HTTPS_PROXY: 'https://proxy.campus.edu:3129' }, /http:\/\/ proxy/],
  ] as const) {
    const refused = recordingDocker(`egress-refused-${Object.keys(vars).length}-${String(reason).length}`)
    await withEnv({ PATH: refused.bin + path.delimiter + process.env.PATH, HTTPS_PROXY: undefined, https_proxy: undefined, ...vars }, async () => {
      await assert.rejects(prepareDependencies(request(`egress-refused-${String(reason).length}`)), (error: { code: string; message: string }) => {
        assert.equal(error.code, 'preparation_config')
        assert.match(error.message, reason)
        return true
      })
    })
    assert.deepEqual(refused.calls(), [], 'a container was started for a misconfigured index')
  }
})

test('k3s: the resolver\'s request names the index and carries the CA, readable by the job user only', async () => {
  const workDir = path.join(TEST_ROOT, 'data', 'dependencies', 'staging', 'e'.repeat(32))
  const catalogFile = path.join(TEST_ROOT, 'egress-runtime-catalog.json')
  fs.writeFileSync(catalogFile, JSON.stringify({ schemaVersion: 1, release: 'test', defaultEnvironment: 'base', environments: [{ name: 'base', image: `registry/base@sha256:${'b'.repeat(64)}`, gpu: false, current: true }] }))
  const ca = path.join(TEST_ROOT, 'campus-ca-broker.pem')
  fs.writeFileSync(ca, PEM)
  let seen: { job: any; ca: string; mode: number } | null = null
  const client = {
    async startCompetitionJob(intent: any) {
      if (!seen) {
        const input = path.join(workDir, 'input')
        seen = { job: JSON.parse(fs.readFileSync(path.join(input, 'request.json'), 'utf8')), ca: fs.readFileSync(path.join(input, 'extra-ca.pem'), 'utf8'), mode: fs.statSync(path.join(input, 'extra-ca.pem')).mode & 0o777 }
      }
      return { jobId: intent.jobId, kind: intent.kind, phase: 'failed', startedAt: 1, finishedAt: 2, exitCode: 1, oomKilled: false, progress: null, error: 'stop here' }
    },
    async competitionJob() { throw new Error('unused') },
    async collectCompetitionJob() { return { files: [], totalBytes: 0 } },
    async cancelCompetitionJob() {},
  }
  await withEnv({ KERNEL_CATALOG_FILE: catalogFile, DEPENDENCY_INDEX_URL: 'https://nexus.campus.edu/simple', DEPENDENCY_FILES_HOSTS: 'files.campus.edu', NODE_EXTRA_CA_CERTS: ca, HTTPS_PROXY: 'https://proxy.campus.edu:3129' }, async () => {
    // The TLS proxy does not matter here: the k3s proxy Pod does not chain.
    await assert.rejects(prepareBrokerDependencies({ ...request('broker'), id: 'e'.repeat(32), imageDigest: `registry/base@sha256:${'b'.repeat(64)}`, workDir }, client as any), { code: 'preparation_failed' })
  })
  assert.ok(seen, 'no job was started')
  const { job, ca: handed, mode } = seen as { job: any; ca: string; mode: number }
  assert.deepEqual(job.index, { url: 'https://nexus.campus.edu/simple', publicPypi: false, files: ['nexus.campus.edu:443', 'files.campus.edu:443'] })
  assert.equal(handed, PEM)
  assert.equal(mode, 0o600)
  assert.equal(createHash('sha256').update(handed).digest('hex').length, 64)
})

test('k3s: the broker hands the mirror settings to the proxy Pod as they are, and nothing when unset', async () => {
  const revision = `sha256:${'c'.repeat(64)}`
  const catalog = parseRuntimeCatalog({ schemaVersion: 1, release: 'v1', defaultEnvironment: 'kaggle-base', environments: [{ name: 'kaggle-base', image: `registry.example/kernel@${revision}`, gpu: false }] })
  const proxyEnv = async (extra: Record<string, string>) => {
    const posted: any[] = []
    const objects = new Map<string, any>()
    // What the broker checks before it starts a job: the data claim and the three policies.
    objects.set('/api/v1/namespaces/colloq/persistentvolumeclaims/colloq-data', { metadata: { name: 'colloq-data' } })
    for (const name of ['competition-job-isolation', 'competition-resolver-isolation', 'competition-proxy-isolation'])
      objects.set(`/apis/networking.k8s.io/v1/namespaces/colloq/networkpolicies/${name}`, { metadata: { name } })
    const kube = { async request<T>(method: string, path: string, body?: any): Promise<T> {
      const key = path.split('?')[0]!
      if (method === 'POST') {
        const object = { ...body, metadata: { ...body.metadata, uid: String(objects.size + 1) },
          ...(body.metadata?.labels?.['colloq.dev/role'] === 'competition-proxy' ? { status: { phase: 'Running', conditions: [{ type: 'Ready', status: 'True' }] } } : {}) }
        posted.push(object)
        objects.set(`${key}/${object.metadata.name}`, object)
        return object as T
      }
      if (method === 'GET' && objects.has(key)) return objects.get(key) as T
      if (method === 'GET' && (key.endsWith('/pods') || key.endsWith('/services'))) return { items: [], metadata: {} } as T
      if (method === 'DELETE') { objects.delete(key); return {} as T }
      throw Object.assign(new Error('missing'), { status: 404 })
    } }
    const jobs = new CompetitionJobs({ kube, config: { namespace: 'colloq', dataClaim: 'colloq-data', exporterImage: `registry.example/runtime@sha256:${'d'.repeat(64)}`, instanceId: 'instance123', ...extra },
      catalog: () => catalog, secret: () => 'x'.repeat(64), pollMs: 1 })
    const jobId = 'a'.repeat(32)
    await jobs.start(jobId, { schemaVersion: 1, jobId, kind: 'resolve', environment: 'kaggle-base', revision, preparationId: 'b'.repeat(32),
      limits: { wallSeconds: 120, memoryMb: 1024, cpus: 1, pids: 128, tmpfsMb: 256, targetBytes: 10_000_000 } })
    const proxy = posted.find((object) => object.kind === 'Pod' && object.metadata.labels['colloq.dev/role'] === 'competition-proxy')
    return Object.fromEntries(proxy.spec.containers[0].env.map((entry: any) => [entry.name, entry.value]))
  }
  const configured = await proxyEnv({ dependencyIndexUrl: 'https://nexus.campus.edu/simple', dependencyFilesHosts: 'files.campus.edu' })
  assert.equal(configured.DEPENDENCY_INDEX_URL, 'https://nexus.campus.edu/simple')
  assert.equal(configured.DEPENDENCY_FILES_HOSTS, 'files.campus.edu')
  const plain = await proxyEnv({})
  assert.equal('DEPENDENCY_INDEX_URL' in plain || 'DEPENDENCY_FILES_HOSTS' in plain, false)
  assert.ok(plain.COMP_PROXY_MAX_BYTES && plain.COMP_PROXY_WALL_SECONDS)
})
