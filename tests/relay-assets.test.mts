/**
 * The static mirror on the relay: what it accepts and where it puts it.
 *
 * The service (scripts/relay-assets.py) stands between the relay's shared
 * secret and the directory from which caddy serves files to ALL students of any
 * seminar. So what has to be checked is not "does it work" but exactly four
 * promises, each of which breaks silently:
 *
 *   no writes without the secret; no overwriting somebody else's name; no path
 *   from an archive leads outside the directory; a set is swapped as a whole,
 *   and chunks of the previous build live for another month, otherwise a tab
 *   opened before the deploy loses its chunks in the middle of a class.
 *
 * The real service is checked, on its own port with a temporary directory: the
 * rules live in it, not in a TypeScript copy. The archives are built with
 * python — there is no other way to make a malicious tar (a symbolic link, a
 * path outside).
 */
import './_env.mts'
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { spawn, spawnSync, type ChildProcess } from 'node:child_process'

const HAVE_PYTHON = spawnSync('python3', ['--version']).status === 0
const SCRIPT = path.resolve(import.meta.dirname, '..', 'scripts/relay-assets.py')
const TOKEN = 'seminar-relay-secret-0123456789'
const HOST = 'hse.colloq.ru'

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = net.createServer()
    probe.on('error', reject)
    probe.listen(0, '127.0.0.1', () => {
      const port = (probe.address() as net.AddressInfo).port
      probe.close(() => resolve(port))
    })
  })
}

let service: ChildProcess | null = null
let base = ''
let root = ''
let env: NodeJS.ProcessEnv = {}

/** A tar.gz with arbitrary members, including ones a build never has. */
function tarball(entries: Array<{ name: string; data?: string; link?: string; dir?: boolean }>): Buffer {
  const made = spawnSync('python3', ['-c', `
import io, json, sys, tarfile
entries = json.loads(sys.argv[1])
buffer = io.BytesIO()
with tarfile.open(fileobj=buffer, mode="w:gz") as tar:
    for entry in entries:
        info = tarfile.TarInfo(entry["name"])
        if entry.get("dir"):
            info.type = tarfile.DIRTYPE
            tar.addfile(info)
        elif entry.get("link") is not None:
            info.type = tarfile.SYMTYPE
            info.linkname = entry["link"]
            tar.addfile(info)
        else:
            payload = entry.get("data", "").encode()
            info.size = len(payload)
            tar.addfile(info, io.BytesIO(payload))
sys.stdout.buffer.write(buffer.getvalue())
`, JSON.stringify(entries)], { maxBuffer: 1 << 28 })
  assert.equal(made.status, 0, made.stderr?.toString())
  return made.stdout
}

/** The way caddy does it: the name in the path and the name the request came by are the same. */
async function put(
  body: Buffer,
  { host = HOST, target = host, token = TOKEN }: { host?: string; target?: string; token?: string } = {},
): Promise<{ status: number; body: Record<string, any> }> {
  const response = await fetch(`${base}/.relay/assets/${target}`, {
    method: 'PUT',
    headers: {
      'X-Forwarded-Host': host,
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      'content-type': 'application/gzip',
    },
    body,
  })
  return { status: response.status, body: (await response.json()) as Record<string, any> }
}

const mirror = (...parts: string[]) => path.join(root, HOST, ...parts)
const read = (...parts: string[]) => fs.readFileSync(mirror(...parts), 'utf8')
const there = (...parts: string[]) => fs.existsSync(mirror(...parts))

/** A build: a hashed chunk with its compressed neighbours, a font and the pdf worker. */
const build = (chunk: string, extra: Array<{ name: string; data?: string }> = []) =>
  tarball([
    { name: 'assets', dir: true },
    { name: `assets/${chunk}`, data: `export const answer = ${JSON.stringify(chunk)}\n` },
    { name: `assets/${chunk}.br`, data: 'сжатое braille' },
    { name: `assets/${chunk}.gz`, data: 'сжатое gzip' },
    { name: 'fonts/hse-sans-400.woff2', data: 'шрифт' },
    { name: 'pdf/pdf.worker.min.mjs', data: 'воркер' },
    ...extra,
  ])

async function up(): Promise<void> {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'colloq-mirror-'))
  const tokenFile = path.join(root, 'token')
  fs.writeFileSync(tokenFile, `${TOKEN}\n`)
  const port = await freePort()
  base = `http://127.0.0.1:${port}`
  env = {
    ...process.env,
    ASSETS_ROOT: path.join(root, 'store'),
    ASSETS_PORT: String(port),
    ASSETS_DOMAIN: 'colloq.ru',
    ASSETS_TOKEN_FILE: tokenFile,
    ASSETS_MAX_BYTES: '65536',
  }
  service = spawn('python3', [SCRIPT], { env, stdio: 'ignore' })
  root = path.join(root, 'store')
  for (let i = 0; i < 100; i += 1) {
    try {
      const probe = await fetch(`${base}/.relay/assets/${HOST}`, {
        headers: { 'X-Forwarded-Host': HOST, authorization: `Bearer ${TOKEN}` },
      })
      if (probe.status === 404) return
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 100))
  }
  throw new Error('the mirror did not come up')
}

function down(): void {
  service?.kill('SIGKILL')
  if (root) fs.rmSync(path.dirname(root), { recursive: true, force: true })
}

const suite = test.suite ?? test.describe

suite('relay static mirror', { skip: HAVE_PYTHON ? false : 'no python3' }, () => {
  test.before(up)
  test.after(down)

  test('nothing is written without the secret or with a wrong one', async () => {
    for (const token of ['', 'not-the-secret', `${TOKEN} `.repeat(2)]) {
      const { status, body } = await put(build('app-aaaa1111.js'), { token })
      assert.equal(status, 401, `the secret ${JSON.stringify(token)} was accepted`)
      assert.equal(body.error, 'token')
    }
    assert.equal(fs.existsSync(path.join(root, HOST)), false)
  })

  test('its own mirror and only its own: the name in the path is the one the request came by', async () => {
    const other = await put(build('app-aaaa1111.js'), { host: HOST, target: 'other.colloq.ru' })
    assert.equal(other.status, 403, 'one seminar overwrote the mirror of another')
    const alien = await put(build('app-aaaa1111.js'), { host: 'hse.example.com', target: 'hse.example.com' })
    assert.equal(alien.status, 400)
    assert.equal(alien.body.error, 'host')
  })

  test('a deploy lays down three directories and switches the set as a whole', async () => {
    const { status, body } = await put(build('app-aaaa1111.js'))
    assert.equal(status, 200, JSON.stringify(body))
    assert.equal(body.files, 5)
    assert.equal(body.kept, 0)
    // The name is a symbolic link to the set: a swap is a rename, not a copy over
    // the live directory.
    assert.ok(fs.lstatSync(path.join(root, HOST)).isSymbolicLink())
    /*
     * The set is read not by this service but by caddy — as another user, via the
     * group. mkdtemp makes the directory 0700, and without an explicit chmod the
     * mirror would stop silently and completely: the files in place, 403 for
     * everyone, and not a line in the log.
     */
    for (const where of [mirror(), mirror('assets'), mirror('assets', 'app-aaaa1111.js')]) {
      const info = fs.statSync(where)
      // A directory also has to be entered; a file only read.
      const need = info.isDirectory() ? 0o050 : 0o040
      assert.equal(
        info.mode & need, need,
        `${where} is not readable by the group: ${(info.mode & 0o777).toString(8)}`,
      )
    }
    assert.match(read('assets', 'app-aaaa1111.js'), /app-aaaa1111/)
    assert.equal(read('assets', 'app-aaaa1111.js.br'), 'сжатое braille')
    assert.equal(read('fonts', 'hse-sans-400.woff2'), 'шрифт')
    assert.equal(read('pdf', 'pdf.worker.min.mjs'), 'воркер')
  })

  test('the mirror state can be queried', async () => {
    const response = await fetch(`${base}/.relay/assets/${HOST}`, {
      headers: { 'X-Forwarded-Host': HOST, authorization: `Bearer ${TOKEN}` },
    })
    assert.equal(response.status, 200)
    const said = (await response.json()) as { files: number; bytes: number; updated: number }
    assert.equal(said.files, 5)
    assert.ok(said.bytes > 0 && said.updated > 0)
    const closed = await fetch(`${base}/.relay/assets/${HOST}`, { headers: { 'X-Forwarded-Host': HOST } })
    assert.equal(closed.status, 401)
  })

  test('no form of path leads outside the directory', async () => {
    const было = read('assets', 'app-aaaa1111.js')
    for (const name of [
      '../evil.js',
      'assets/../../evil.js',
      '/etc/passwd',
      'assets/sub/../../../evil.js',
      'etc/passwd',
      'index.html',
      'assets/./../evil.js',
    ]) {
      const { status } = await put(tarball([{ name, data: 'зло' }]))
      assert.equal(status, 400, `accepted ${name}`)
    }
    assert.equal(fs.existsSync(path.join(root, '..', 'evil.js')), false)
    assert.equal(fs.existsSync(path.join(root, 'evil.js')), false)
    // And the live mirror did not suffer from such attempts.
    assert.equal(read('assets', 'app-aaaa1111.js'), было)
  })

  test('a symbolic link in an archive gets a refusal, not a foreign file posing as a chunk', async () => {
    const { status, body } = await put(tarball([
      { name: 'assets/app-bbbb2222.js', data: 'настоящий' },
      { name: 'assets/secret.js', link: '/etc/passwd' },
    ]))
    assert.equal(status, 400)
    assert.equal(body.error, 'kind')
    assert.equal(there('assets', 'secret.js'), false)
    assert.equal(there('assets', 'app-bbbb2222.js'), false, 'a half-unpacked archive reached the mirror')
  })

  test('an archive over the ceiling is not unpacked', async () => {
    const { status, body } = await put(tarball([
      { name: 'assets/huge-cccc3333.js', data: 'x'.repeat(70_000) },
    ]))
    assert.equal(status, 413)
    assert.ok(['bytes', 'files'].includes(body.error), body.error)
    assert.equal(there('assets', 'huge-cccc3333.js'), false)
  })

  test('chunks of the previous build live for another month, while fonts are replaced', async () => {
    // A tab opened before the deploy lazy-loads its chunk by the old hash.
    const { status, body } = await put(build('app-dddd4444.js'))
    assert.equal(status, 200)
    assert.equal(body.kept, 3, 'the previous chunks were not carried over')
    assert.ok(there('assets', 'app-aaaa1111.js'), 'the old chunk disappeared on the day of the deploy')
    assert.ok(there('assets', 'app-dddd4444.js'))
    // Unversioned files move as they are: the same name, new content.
    assert.equal(read('fonts', 'hse-sans-400.woff2'), 'шрифт')
    assert.equal(fs.readdirSync(path.join(root, 'sets', HOST)).length, 1, 'the previous sets were not removed')
  })

  test('a chunk older than the term does not move into the new build', async () => {
    const месяц = Date.now() / 1000 - 31 * 86400
    for (const name of ['app-aaaa1111.js', 'app-aaaa1111.js.br', 'app-aaaa1111.js.gz']) {
      fs.utimesSync(mirror('assets', name), месяц, месяц)
    }
    const { body } = await put(build('app-eeee5555.js'))
    assert.equal(there('assets', 'app-aaaa1111.js'), false, 'the month-old chunk stayed forever')
    assert.ok(there('assets', 'app-dddd4444.js'), 'the fresh chunk was taken away together with the old one')
    assert.equal(body.kept, 3)
  })

  test('hidden files from a laptop are skipped, and the build is deployed', async () => {
    const { status, body } = await put(build('app-ffff6666.js', [
      { name: 'assets/.DS_Store', data: 'мусор macOS' },
    ]))
    assert.equal(status, 200, 'the whole build failed to deploy because of .DS_Store')
    assert.equal(body.skipped, 1)
    assert.equal(there('assets', '.DS_Store'), false)
  })

  test('the mirror accepts the archive that make host builds as it is', async () => {
    /*
     * The two halves of one job sit in different files and in different
     * languages: bash builds the archive (scripts/host.sh · assets_tar), python
     * unpacks it. The easiest way for them to diverge is silently — nobody reads
     * "0 files deployed". So THE VERY function from the script is used, not a retelling of it.
     */
    const script = fs.readFileSync(path.resolve(import.meta.dirname, '..', 'scripts/host.sh'), 'utf8')
    const dirs = /^DIST_DIRS=.*$/m.exec(script)
    const made = /^assets_tar\(\) \{$[\s\S]*?^\}$/m.exec(script)
    assert.ok(dirs && made, 'assets_tar can no longer be found in scripts/host.sh')
    const fake = fs.mkdtempSync(path.join(os.tmpdir(), 'colloq-dist-'))
    for (const dir of ['assets', 'fonts', 'pdf']) {
      fs.mkdirSync(path.join(fake, 'web/dist', dir), { recursive: true })
    }
    fs.writeFileSync(path.join(fake, 'web/dist/assets/app-9999zzzz.js'), 'export default 1\n')
    fs.writeFileSync(path.join(fake, 'web/dist/assets/app-9999zzzz.js.br'), 'сжато')
    fs.writeFileSync(path.join(fake, 'web/dist/fonts/hse-sans-400.woff2'), 'шрифт')
    fs.writeFileSync(path.join(fake, 'web/dist/pdf/pdf.worker.min.mjs'), 'воркер')
    // What macOS puts alongside and must not go to the relay.
    fs.writeFileSync(path.join(fake, 'web/dist/assets/.DS_Store'), 'мусор')
    fs.writeFileSync(path.join(fake, 'web/dist/index.html'), '<!doctype html>')
    const archive = path.join(fake, 'dist.tgz')
    const built = spawnSync('bash', ['-c', `set -euo pipefail\n${dirs[0]}\n${made[0]}\nassets_tar "$1"`, 'sh', archive], {
      cwd: fake, encoding: 'utf8',
    })
    assert.equal(built.status, 0, built.stderr)
    const { status, body } = await put(fs.readFileSync(archive))
    assert.equal(status, 200, JSON.stringify(body))
    assert.equal(body.files, 4, 'the archive got something other than what is mirrored')
    assert.equal(body.skipped, 0, 'hidden files got into the archive after all')
    assert.ok(there('assets', 'app-9999zzzz.js.br'))
    assert.equal(read('fonts', 'hse-sans-400.woff2'), 'шрифт')
    // The page is live, the instance serves it, and it has no business in the mirror.
    assert.equal(there('index.html'), false)
    fs.rmSync(fake, { recursive: true, force: true })
  })

  test('the cleanup removes an abandoned name and unpacking leftovers', async () => {
    const leftover = path.join(root, '.tmp', 'hse.colloq.ru-оборванная')
    fs.mkdirSync(leftover, { recursive: true })
    const давно = Date.now() / 1000 - 3 * 86400
    fs.utimesSync(leftover, давно, давно)
    let pruned = spawnSync('python3', [SCRIPT, '--prune'], { env, encoding: 'utf8' })
    assert.equal(pruned.status, 0, pruned.stderr)
    assert.equal(fs.existsSync(leftover), false)
    assert.ok(there('assets', 'app-ffff6666.js'), 'the cleanup tore down the live mirror')

    // A name that is no longer exposed: its link has not been updated for two terms.
    const stale = Date.now() / 1000 - 61 * 86400
    fs.lutimesSync(path.join(root, HOST), stale, stale)
    pruned = spawnSync('python3', [SCRIPT, '--prune'], { env, encoding: 'utf8' })
    assert.equal(pruned.status, 0, pruned.stderr)
    assert.equal(fs.existsSync(path.join(root, 'sets', HOST)), false)
    assert.equal(fs.existsSync(path.join(root, HOST)), false)
  })
})
