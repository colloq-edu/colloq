/**
 * The pip freeze of an environment's image, downloaded from its window: the
 * exact `pip freeze --all` of the image the rooms run now, as
 * `<name>-pip-freeze.txt`, under one line saying which environment, which
 * image and when it was built.
 *
 * Docker is faked at the process boundary (_fake-docker.mts), so the route and
 * its reader run as they do on a machine and every docker call is counted.
 * The image's inspect and its `pip freeze` run are played here, on top of the
 * shared fake, because that one answers on stdout only, at once and whole:
 * these need docker's and python's words on stderr, a run that floods its
 * stdout and one that stalls until it is killed.
 *
 * What these pin: the file and its first line; one `pip freeze` per image id
 * (a second download costs an inspect, a rebuild gets a fresh read, and the
 * class running on the image is never touched); a run stopped at the size
 * limit and one given up at its timeout, each said as what it is; words
 * instead of a file for an environment with no image, for a docker that does
 * not answer and under the release catalog; who may download; and the
 * window: its action and reasons, a window with no image that asks for
 * nothing, and a press that saves only a 200.
 *
 * And the same download from a competition's window (routes/competitions.ts
 * · freeze): the panel's very file, of the image the window's list is of,
 * a pinned one included; open to exactly those the list is open to, refused
 * where the list is and in its words, a failed read in readable ones that
 * name nothing of docker's; told to the window beside the list, which never
 * waits long for it; asked of docker once an image however many ask, a
 * failed read included, for a few seconds (environments.ts ·
 * createFreezeReader, played here on a clock of the suite's); said in the
 * competition page's words, which load no panel catalog.
 */
import './_env.mts'
import cp from 'node:child_process'
import { EventEmitter } from 'node:events'
import http from 'node:http'
import fs from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
import { PassThrough } from 'node:stream'
import path from 'node:path'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { pathToFileURL } from 'node:url'
import express from 'express'
import type { Response } from 'express'
import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { compile } from 'svelte/compiler'
import { render } from 'svelte/server'
import type { Component } from 'svelte'
import { TEST_ROOT } from './_env.mts'
import { fakeDocker, type FakeDocker } from './_fake-docker.mts'
import { adminEnvironmentRoutes } from '../server/src/routes/admin-environments.js'
import { competitionRoutes } from '../server/src/routes/competitions.js'
import { createFreezeReader, readFreeze } from '../server/src/environments.js'
import { createTeacher } from '../server/src/admin/store.js'
import { issueStaffCookie } from '../server/src/admin/auth.js'
import { createCompetition, joinAsNewcomer, setCompetitionState } from '../server/src/competitions/store.js'
import { issueEntrantCookie } from '../server/src/competitions/identity.js'
import { putRevision, selectRevision } from '../server/src/dependencies/store.js'
import { STAFF_COOKIE, type AdminErrorBody } from '../shared/admin.js'
import { ENTRANT_COOKIE, type Competition, type CompetitionErrorBody } from '../shared/competitions.js'
import type { EnvironmentInventory } from '../shared/environment-inventory.js'
import { commonMessages } from '../shared/locales/common.js'
import { competitionsMessages } from '../shared/locales/competitions.js'
import { setLocaleResolver, tr } from '../shared/i18n.js'

/* ------------------------------------------------------------ the stand */

const MB = 1024 * 1024
const id = (digit: string) => `sha256:${digit.repeat(64)}`

interface Image {
  id: string
  created: string
  platform: string
  python: string
}

/** A docker client as the reader sees one: two streams, one exit, and every kill counted. */
type Child = EventEmitter & {
  stdout: PassThrough
  stderr: PassThrough
  kill: (signal?: string) => boolean
  /** How many times the reader killed it. */
  kills: number
  /** Exits once, whoever asks first: the play, or a kill's SIGKILL a tick later. */
  finish: (code: number | null) => void
}

/** How a played docker call goes: what it prints on each stream and its exit code, or a play of its own. */
type Played = { code: number; stdout?: string; stderr?: string } | ((child: Child) => void)

/** The window module's own shapes (EnvironmentDetails.svelte · module script), as the press takes and answers them. */
interface FreezeWords {
  hint: () => string
  unbuilt: (alone: boolean) => string
  managed: (alone: boolean) => string
}
interface EnvironmentFreeze {
  endpoint: string
  built: boolean
  catalogImage: string | null
  words?: FreezeWords
}
interface ListedFreeze {
  endpoint: string
  listed: true
  words: FreezeWords
}
type FreezePress =
  | { done: 'skipped' }
  | { done: 'saved' }
  | { done: 'refused'; words: string | null }
  | { done: 'aborted' }

/** What `colloq-kernel:<name>` names now, as docker would inspect it. */
const images = new Map<string, Image>()
/** How `python -m pip freeze --all` goes in each image, by id. */
const frozen = new Map<string, Played>()
/** When set, every inspect answers this: a docker that is not there. */
let inspectTrouble: Played | null = null
/**
 * A competition window's list, read from the same images: the packages of a
 * tag that names one, refused otherwise, the way the inventory probe reads
 * the tag (its own suite, environment-inventory.test.mts, holds how).
 */
const listOf = async (name: string): Promise<EnvironmentInventory> => {
  if (!images.has(`colloq-kernel:${name}`)) throw new Error('Environment image is unavailable')
  return { name, python: '3.11.9', packages: [{ name: 'numpy', version: '2.1.3' }] }
}

let docker: FakeDocker
let server: http.Server
let base = ''
/**
 * The competition door's clock: what it has asked docker is kept a few
 * seconds by it, and a test moves it on rather than waits.
 */
let now = 0
/** Everything the competition door asked docker before is old news: each of its tests starts from here. */
const expire = () => {
  now += 60_000
}
/** The window, compiled for the server the way the competition render tests compile it, with its module's exports. */
let dir = ''
let windowModule: {
  default: Component<any>
  pressFreeze: (name: string, freeze: EnvironmentFreeze | undefined, page: Page) => Promise<FreezePress>
  listedFreeze: (freeze: ListedFreeze, answer: unknown) => EnvironmentFreeze
}

const freezeRuns = () =>
  docker.calls.filter((args) => args[0] === 'run' && args.includes('pip') && args.includes('freeze'))
const inspects = () => docker.calls.filter((args) => args[0] === 'image' && args[1] === 'inspect')

function child(): Child {
  const made = new EventEmitter() as Child
  made.stdout = new PassThrough()
  made.stderr = new PassThrough()
  made.kills = 0
  let closed = false
  made.finish = (code) => {
    if (closed) return
    closed = true
    made.emit('close', code)
  }
  made.kill = () => {
    made.kills += 1
    process.nextTick(() => made.finish(null))
    return true
  }
  return made
}

function play(made: Child, played: Played): void {
  if (typeof played === 'function') return played(made)
  if (played.stderr) made.stderr.emit('data', Buffer.from(played.stderr))
  if (played.stdout) made.stdout.emit('data', Buffer.from(played.stdout))
  made.finish(played.code)
}

/** The image's inspect, the way docker answers it: the format's lines on stdout, a refusal on stderr. */
function inspect(args: string[]): Played {
  if (inspectTrouble) return inspectTrouble
  const image = images.get(args[2] ?? '')
  if (!image) return { code: 1, stderr: `Error response from daemon: No such image: ${args[2]}\n` }
  // The freeze's format: the id, the platform, then the list's size, date and variables.
  assert.match(args.at(-1) ?? '', /\.Id[\s\S]*\.Architecture[\s\S]*\.Size[\s\S]*\.Created[\s\S]*\.Config\.Env/)
  const python = image.python ? `PYTHON_VERSION=${image.python}\n` : ''
  return { code: 0, stdout: `${image.id}\n${image.platform}\n734003200\n${image.created}\nPATH=/usr/local/bin:/usr/bin\n${python}` }
}

before(async () => {
  docker = fakeDocker()
  const shared = cp.spawn
  cp.spawn = ((command: string, args: string[], options: unknown) => {
    const inspecting = command === 'docker' && args[0] === 'image' && args[1] === 'inspect'
    const freezing = command === 'docker' && args[0] === 'run' && args.includes('freeze')
    if (!inspecting && !freezing) return (shared as (...a: unknown[]) => unknown)(command, args, options)
    docker.calls.push(args)
    const made = child()
    const image = args[args.indexOf('--entrypoint') + 2] ?? ''
    const played = inspecting
      ? inspect(args)
      : (frozen.get(image) ?? { code: 125, stderr: `docker: Error response from daemon: No such image: ${image}.\n` })
    process.nextTick(() => play(made, played))
    return made
  }) as unknown as typeof cp.spawn
  syncBuiltinESMExports()

  const app = express()
  app.use(express.json())
  app.use(adminEnvironmentRoutes())
  app.use(competitionRoutes(listOf, createFreezeReader(() => now)))
  server = http.createServer(app)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`

  dir = await mkdtemp(path.join(tmpdir(), 'colloq-freeze-render-'))
  // The window and the placeholder it draws while its list loads, each compiled for the server beside the other.
  for (const name of ['Skeleton', 'EnvironmentDetails']) {
    const source = await readFile(new URL(`../web/src/components/ui/${name}.svelte`, import.meta.url), 'utf8')
    let code = compile(source, { filename: `${name}.svelte`, generate: 'server' }).js.code
    for (const [from, to] of [
      ['svelte/internal/server', import.meta.resolve('svelte/internal/server')],
      ['svelte', import.meta.resolve('svelte')],
      ['@shared/i18n', new URL('../shared/i18n.ts', import.meta.url).href],
      ['./Skeleton.svelte', './Skeleton.mjs'],
    ]) code = code.replaceAll(`'${from}'`, JSON.stringify(to))
    await writeFile(path.join(dir, `${name}.mjs`), code)
  }
  windowModule = await import(pathToFileURL(path.join(dir, 'EnvironmentDetails.mjs')).href)
})

after(async () => {
  server?.close()
  // Puts the real spawn back, under this file's layer as well as the shared fake's.
  docker?.restore()
  setLocaleResolver(() => 'ru')
  if (dir) await rm(dir, { recursive: true, force: true })
})

const cookies = new Map<string, string>()
/** A staff cookie per role, made once: an address is unique, a second teacher with it is null. */
function staff(role: 'owner' | 'teacher'): string {
  const known = cookies.get(role)
  if (known) return known
  const teacher = createTeacher({ name: role === 'owner' ? 'Ада' : 'Нина', email: `${role}.freeze@test.local`, role })
  assert.ok(teacher)
  let value = ''
  issueStaffCookie({ cookie: (_n: string, v: string) => (value = v) } as unknown as Response, teacher)
  cookies.set(role, `${STAFF_COOKIE}=${value}`)
  return cookies.get(role)!
}

const download = (name: string, role: 'owner' | 'teacher' | null = 'owner') =>
  fetch(`${base}/api/admin/environments/${name}/freeze`, { headers: role ? { cookie: staff(role) } : {} })

/** A refusal's body, the panel's or a competition door's: words and a reason, never a file. */
async function refusal<Body = AdminErrorBody>(response: globalThis.Response): Promise<Body> {
  assert.match(response.headers.get('content-type') ?? '', /application\/json/, 'a refusal is words, not a file')
  assert.equal(response.headers.get('content-disposition'), null, 'and nothing asks the browser to save it')
  return (await response.json()) as Body
}

const FREEZE = 'matplotlib==3.9.2\nnumpy==2.1.3\npandas==2.2.3\npip==25.0.1\nscikit-learn==1.5.2\nsetuptools==75.1.0\n'

/* ---------------------------------------------------------- the file */

test('a built environment downloads its pip freeze under one line naming the environment, the image and its build', async () => {
  images.set('colloq-kernel:base', { id: id('a'), created: '2026-10-20T09:15:02.123456789Z', platform: 'linux/arm64', python: '3.11.9' })
  frozen.set(id('a'), { code: 0, stdout: FREEZE })
  const response = await download('base')
  assert.equal(response.status, 200)
  assert.equal(response.headers.get('content-type'), 'text/plain; charset=utf-8')
  assert.equal(response.headers.get('content-disposition'), 'attachment; filename="base-pip-freeze.txt"')
  assert.equal(response.headers.get('cache-control'), 'no-store', 'a rebuild changes the file under the same address')
  const text = await response.text()
  const [head, ...rest] = text.split('\n')
  assert.equal(head, `# base · Python 3.11.9 · linux/arm64 · image ${id('a')} · built 2026-10-20T09:15:02Z`)
  assert.equal(rest.join('\n'), FREEZE, 'below the line, exactly what pip printed')
  // The file goes to laptops whose pip may read it in a code page: no Cyrillic, whatever the panel's language.
  assert.doesNotMatch(head ?? '', /[Ѐ-ӿ]/)

  const runs = freezeRuns()
  assert.equal(runs.length, 1)
  const run = runs[0]!
  for (const flag of ['--rm', '--pull=never', '--network=none', '--read-only', '--cap-drop=ALL']) assert.ok(run.includes(flag), flag)
  assert.ok(run.includes(id('a')), 'the inspected immutable image, not the tag a rebuild moves')
  assert.ok(!run.includes('colloq-kernel:base'))
  assert.deepEqual(run.slice(run.indexOf(id('a')) + 1, run.indexOf(id('a')) + 5), ['-m', 'pip', 'freeze', '--all'])
})

test('a freeze is read once per image id: a second download only inspects, a rebuild reads afresh, an alias reuses it', async () => {
  images.set('colloq-kernel:kaggle-base', { id: id('b'), created: '2026-10-01T08:00:00Z', platform: 'linux/amd64', python: '3.11.9' })
  frozen.set(id('b'), { code: 0, stdout: 'catboost==1.2.7\npip==25.0.1\n' })
  const runsBefore = freezeRuns().length
  const inspectsBefore = inspects().length
  const first = await (await download('kaggle-base')).text()
  const second = await (await download('kaggle-base')).text()
  assert.equal(second, first)
  assert.equal(freezeRuns().length - runsBefore, 1, 'one pip freeze for one image')
  assert.equal(inspects().length - inspectsBefore, 2, 'but the tag is asked each time: it may have moved')

  // Rebuilt: the tag names another image, and the file follows it.
  images.set('colloq-kernel:kaggle-base', { id: id('c'), created: '2026-10-21T10:30:00Z', platform: 'linux/amd64', python: '3.11.9' })
  frozen.set(id('c'), { code: 0, stdout: 'catboost==1.2.8\npip==25.0.1\n' })
  const rebuilt = await (await download('kaggle-base')).text()
  assert.equal(freezeRuns().length - runsBefore, 2)
  assert.match(rebuilt, new RegExp(`^# kaggle-base · Python 3\\.11\\.9 · linux/amd64 · image ${id('c')} · built 2026-10-21T10:30:00Z\\n`))
  assert.match(rebuilt, /^catboost==1\.2\.8$/m)

  // Another environment's tag on the very same image: the same freeze, under its own name.
  images.set('colloq-kernel:base-gpu', { ...images.get('colloq-kernel:kaggle-base')! })
  const alias = await (await download('base-gpu')).text()
  assert.equal(freezeRuns().length - runsBefore, 2, 'kept by the image, not by the name')
  assert.match(alias, new RegExp(`^# base-gpu · .* · image ${id('c')} · `))
  assert.equal(alias.split('\n').slice(1).join('\n'), rebuilt.split('\n').slice(1).join('\n'))
})

test('what pip says on stderr stays out of the file, and an image without a Python version names none', async () => {
  images.set('colloq-kernel:base', { id: id('9'), created: '2026-10-21T09:00:00Z', platform: 'linux/amd64', python: '' })
  frozen.set(id('9'), {
    code: 0,
    stderr: 'WARNING: Ignoring invalid distribution ~orch (/usr/local/lib/python3.11/site-packages)\n',
    stdout: FREEZE,
  })
  const text = await (await download('base')).text()
  assert.equal(text, `# base · linux/amd64 · image ${id('9')} · built 2026-10-21T09:00:00Z\n${FREEZE}`)
})

test('downloads pressed together share one pip freeze', async () => {
  images.set('colloq-kernel:kaggle-gpu', { id: id('d'), created: '2026-10-19T12:00:00Z', platform: 'linux/amd64', python: '3.11.9' })
  frozen.set(id('d'), { code: 0, stdout: 'torch==2.5.1\n' })
  const before = freezeRuns().length
  const answers = await Promise.all([download('kaggle-gpu'), download('kaggle-gpu'), download('kaggle-gpu', 'teacher')])
  assert.deepEqual(answers.map((r) => r.status), [200, 200, 200])
  assert.equal(freezeRuns().length - before, 1)
})

test('the class running on the image is never touched: the freeze has a container of its own, removed after', async () => {
  docker.add('freezeclass', 'room', { environment: 'base' })
  images.set('colloq-kernel:base', { id: id('e'), created: '2026-10-21T11:00:00Z', platform: 'linux/arm64', python: '3.11.9' })
  frozen.set(id('e'), { code: 0, stdout: FREEZE })
  const before = docker.calls.length
  assert.equal((await download('base')).status, 200)
  const asked = docker.calls.slice(before)
  assert.ok(!asked.some((args) => args[0] === 'exec'), 'nothing runs inside a room')
  assert.ok(!asked.some((args) => args.some((arg) => arg.startsWith('colloq-room-'))), 'no room container is named')
  assert.ok(docker.containers.get('colloq-room-freezeclass')?.running, 'the class is still running')
  const run = asked.find((args) => args[0] === 'run')!
  const container = run[run.indexOf('--name') + 1]!
  assert.match(container, /^colloq-freeze-[0-9a-f-]{36}$/)
  assert.ok(asked.some((args) => args[0] === 'rm' && args.includes('-f') && args.at(-1) === container), 'the throwaway container is removed')
})

/* -------------------------------------------------- words, not a file */

test('an environment with no image is refused in words that ask nobody to build, and docker is asked to run nothing', async () => {
  images.delete('colloq-kernel:base-gpu')
  const before = freezeRuns().length
  const response = await download('base-gpu', 'teacher')
  assert.equal(response.status, 409)
  const body = await refusal(response)
  assert.equal(body.reason, 'not_built')
  assert.match(body.error, /«base-gpu»/)
  // A teacher cannot build, and a first build may already be running: the fact, not an errand.
  assert.match(body.error, /появится после первой сборки/)
  assert.doesNotMatch(body.error, /соберите/)
  assert.equal(freezeRuns().length, before)

  const unknown = await download('no-such-env')
  assert.equal(unknown.status, 404)
  assert.equal((await refusal(unknown)).reason, 'not_found')
  const bad = await download('..%2Fsecret')
  assert.equal(bad.status, 404)
})

test('a docker that does not answer is said in its own words, and a failed read is tried again on the next press', async () => {
  inspectTrouble = { code: 1, stderr: 'Cannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the docker daemon running?\n' }
  try {
    const response = await download('base')
    assert.equal(response.status, 503)
    const body = await refusal(response)
    assert.equal(body.reason, 'failed')
    assert.match(body.error, /Cannot connect to the Docker daemon/)
  } finally {
    inspectTrouble = null
  }

  // An image without pip in it: the reason is python's, and it is not kept as the answer.
  images.set('colloq-kernel:base', { id: id('f'), created: '2026-10-21T11:30:00Z', platform: 'linux/arm64', python: '3.11.9' })
  frozen.set(id('f'), { code: 1, stderr: '/usr/local/bin/python: No module named pip\n' })
  const before = freezeRuns().length
  const failed = await download('base')
  assert.equal(failed.status, 503)
  assert.match((await refusal(failed)).error, /No module named pip/)
  frozen.set(id('f'), { code: 0, stdout: FREEZE })
  const again = await download('base')
  assert.equal(again.status, 200)
  assert.equal(freezeRuns().length - before, 2, 'the failure was not cached')
})

test('a failed run is said in stderr\'s last line, never in the package line its stdout ended on', async () => {
  images.set('colloq-kernel:base', { id: id('1'), created: '2026-10-21T12:00:00Z', platform: 'linux/arm64', python: '3.11.9' })
  // Killed by the kernel's OOM halfway through: pins on stdout, the reason on stderr.
  frozen.set(id('1'), {
    code: 137,
    stdout: 'matplotlib==3.9.2\nnumpy==2.1.3\n',
    stderr: 'Traceback (most recent call last):\nMemoryError\n',
  })
  const failed = await refusal(await download('base'))
  assert.match(failed.error, /: MemoryError$/)
  assert.doesNotMatch(failed.error, /numpy/)

  // Nothing on stderr: the exit code, still not a package.
  images.set('colloq-kernel:base', { id: id('2'), created: '2026-10-21T12:05:00Z', platform: 'linux/arm64', python: '3.11.9' })
  frozen.set(id('2'), { code: 137, stdout: 'matplotlib==3.9.2\nnumpy==2.1.3\n' })
  const silent = await refusal(await download('base'))
  assert.match(silent.error, /pip freeze завершился с кодом 137/)
  assert.doesNotMatch(silent.error, /numpy/)
})

test('a run that keeps printing is killed where it passes 1 MB, and nothing it prints after is kept', async () => {
  images.set('colloq-kernel:base', { id: id('7'), created: '2026-10-21T11:45:00Z', platform: 'linux/arm64', python: '3.11.9' })
  /*
   * A package's .pth that prints at every interpreter start, forever. Each
   * chunk counts how often it is decoded, which is what keeping one costs
   * the reader: the first megabyte is read, the chunk that passes the limit
   * and the pipe's remainder after the kill are not.
   */
  let decoded = 0
  let sent = 0
  let sentBeforeKill = 0
  const flooded: { child?: Child } = {}
  frozen.set(id('7'), (made) => {
    flooded.child = made
    const chunk = Buffer.alloc(MB, 0x78)
    chunk.toString = function (this: Buffer, ...args: Parameters<Buffer['toString']>) {
      decoded += 1
      return Buffer.prototype.toString.apply(this, args)
    }
    for (; sent < 64 && made.kills === 0; sent += 1) made.stdout.emit('data', chunk)
    sentBeforeKill = sent
    // What was already in the pipe when the client died.
    for (let i = 0; i < 4; i += 1, sent += 1) made.stdout.emit('data', chunk)
    made.finish(null)
  })
  const flood = await download('base')
  assert.equal(flood.status, 503)
  assert.match((await refusal(flood)).error, /больше 1 МБ/)
  assert.equal(flooded.child?.kills, 1, 'the client is killed, not read to its end')
  assert.equal(sentBeforeKill, 2, 'at the chunk that passed 1 MB')
  assert.equal(sent, 6)
  assert.equal(decoded, 1, 'only the first megabyte was kept')
})

test('a run that stalls is given up at its timeout and said to be slow, not by the line it stalled on', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  for (const [digit, printed] of [['3', 'matplotlib==3.9.2\nnumpy==2.1.3\n'], ['4', '']] as const) {
    images.set('colloq-kernel:base', { id: id(digit), created: '2026-10-21T12:10:00Z', platform: 'linux/arm64', python: '3.11.9' })
    let stalled!: Child
    const started = new Promise<void>((resolve) => {
      frozen.set(id(digit), (made) => {
        stalled = made
        if (printed) made.stdout.emit('data', Buffer.from(printed))
        resolve()
      })
    })
    const pending = readFreeze('base')
    await started
    t.mock.timers.tick(59_999)
    assert.equal(stalled.kills, 0, 'not before its minute')
    t.mock.timers.tick(1)
    assert.equal(stalled.kills, 1)
    const answer = await pending
    assert.deepEqual(answer, { state: 'failed', detail: 'pip freeze не ответил за 60 с' })
  }
})

test('under the release catalog the answer names the pinned image and where its freeze can be read, and asks docker nothing', async () => {
  const image = `registry.test/colloq/kernel-base@sha256:${'9'.repeat(64)}`
  const catalog = path.join(TEST_ROOT, 'catalog-freeze.json')
  fs.writeFileSync(catalog, JSON.stringify({ schemaVersion: 1, release: 'r1', defaultEnvironment: 'base', environments: [{ name: 'base', image, gpu: false, current: true }] }))
  const saved = { KERNEL_BACKEND: process.env.KERNEL_BACKEND, KERNEL_CATALOG_FILE: process.env.KERNEL_CATALOG_FILE }
  Object.assign(process.env, { KERNEL_BACKEND: 'broker', KERNEL_CATALOG_FILE: catalog })
  const before = docker.calls.length
  try {
    const response = await download('base')
    assert.equal(response.status, 409)
    const body = await refusal(response)
    assert.equal(body.reason, 'managed_environment')
    assert.ok(body.error.includes(image), 'the image, pinned by its digest, is named')
    assert.ok(body.error.includes(`docker run --rm --network none --entrypoint python ${image} -m pip freeze --all`))
    // An environment the catalog does not have is no such environment there.
    assert.equal((await download('kaggle-base')).status, 404)
    assert.equal(docker.calls.length, before, 'no docker here at all')
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }
})

test('every teacher may download, as they read the lists; nobody signed out may', async () => {
  images.set('colloq-kernel:base', { id: id('a'), created: '2026-10-20T09:15:02Z', platform: 'linux/arm64', python: '3.11.9' })
  assert.equal((await download('base', 'teacher')).status, 200)
  const anonymous = await download('base', null)
  assert.equal(anonymous.status, 401)
  assert.equal((await refusal(anonymous)).reason, 'unauthenticated')
})

/* ------------------------------------------------------------ the window */

const draw = (freeze?: EnvironmentFreeze) =>
  render(windowModule.default, {
    props: { name: 'base', endpoint: '/api/admin/environments/base/inventory', onclose: () => {}, ...(freeze ? { freeze } : {}) },
  }).body
const words = (html: string) => html.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ')
/** The `<button>` whose label names pip freeze, tag and all. */
const freezeButton = (html: string) => /<button\b[^>]*>[^<]*pip freeze[^<]*<\/button>/.exec(html)?.[0] ?? null
const dialogTag = (html: string) => /<dialog\b[^>]*>/.exec(html)?.[0] ?? ''
const footerTag = (html: string) => /<footer\b[^>]*>/.exec(html)?.[0] ?? ''
const endpoint = '/api/admin/environments/base/freeze'
const catalogImage = `registry.test/colloq/kernel-base@sha256:${'9'.repeat(64)}`
/** The window's words for a list on its way, and for one that failed. */
const LISTING = /Читаем состав окружения/
const LIST_FAILED = /Не удалось прочитать состав/

test('the window offers the download of a built image and says what the file is', () => {
  const html = draw({ endpoint, built: true, catalogImage: null })
  const button = freezeButton(html)
  assert.ok(button, 'the action is there')
  assert.match(button!, /Скачать pip freeze/)
  assert.doesNotMatch(button!, /\sdisabled/)
  assert.match(button!, /aria-describedby="environment-freeze-note"/)
  assert.match(words(html), /Точный состав образа, на котором сейчас работают комнаты окружения/)
  // The list is asked for and the window keeps its height for it; the foot stands under a line.
  assert.match(words(html), LISTING)
  assert.match(dialogTag(html), /h-\[min\(720px,85dvh\)\]/)
  assert.match(footerTag(html), /border-t/)
  setLocaleResolver(() => 'en')
  assert.match(freezeButton(draw({ endpoint, built: true, catalogImage: null })) ?? '', /Download pip freeze/)
  setLocaleResolver(() => 'ru')
})

test('the window greys the download with its reason: no image yet, or the catalog image is not on this server', () => {
  const unbuilt = draw({ endpoint, built: false, catalogImage: null })
  assert.match(freezeButton(unbuilt) ?? '', /\sdisabled/)
  assert.match(words(unbuilt), /Образа ещё нет: состав окружения и pip freeze появятся после первой сборки/)
  assert.doesNotMatch(words(unbuilt), /соберите/, 'every teacher opens this window, and only an owner builds')

  const managed = draw({ endpoint, built: false, catalogImage })
  assert.match(freezeButton(managed) ?? '', /\sdisabled/)
  assert.match(words(managed), /закреплён по дайджесту/)
  assert.ok(words(managed).includes(`docker run --rm --network none --entrypoint python ${catalogImage} -m pip freeze --all`))

  setLocaleResolver(() => 'en')
  assert.match(words(draw({ endpoint, built: false, catalogImage: null })), /its installed packages and pip freeze appear after the first build/)
  setLocaleResolver(() => 'ru')
})

test('a window with no image to read asks for no list: its foot\'s reason stands alone, and the window is as tall as that', async () => {
  for (const freeze of [{ endpoint, built: false, catalogImage: null }, { endpoint, built: false, catalogImage }]) {
    const html = draw(freeze)
    // Neither "reading…" nor the red "could not read… try again" with a retry that can never work.
    assert.doesNotMatch(words(html), LISTING)
    assert.doesNotMatch(words(html), LIST_FAILED)
    assert.doesNotMatch(words(html), /Повторить/)
    // fit-content: a modal dialog is fixed between the screen's top and bottom, and `auto` stretches it there.
    assert.match(dialogTag(html), /\sh-fit\s/)
    assert.doesNotMatch(dialogTag(html), /h-\[min\(720px/)
    // Right under the header, padded like it, with no second line under the header's own.
    assert.doesNotMatch(footerTag(html), /border-t/)
  }
  // And the list is not asked for when the window opens: only a window with an image to read loads it.
  const source = await readFile(new URL('../web/src/components/ui/EnvironmentDetails.svelte', import.meta.url), 'utf8')
  const mounted = /onMount\(\(\) => \{([\s\S]*?)\n {2}\}\)/.exec(source)?.[1] ?? ''
  assert.match(mounted, /if \(!imageless\) void load\(\)/)
  assert.doesNotMatch(mounted.replace(/if \(!imageless\) void load\(\)/, ''), /load\(\)/)
})

test('the window scrolls as a whole when it is taller than the screen, so its foot is never cut off and its table keeps a floor', async () => {
  for (const html of [draw({ endpoint, built: false, catalogImage }), draw({ endpoint, built: true, catalogImage: null }), draw()]) {
    const dialog = dialogTag(html)
    assert.match(dialog, /\soverflow-y-auto\s/)
    assert.match(dialog, /\smax-h-\[85dvh\]\s/)
    assert.doesNotMatch(dialog, /\soverflow-hidden\s/)
  }
  // On a phone held sideways the foot took the table's last rows: the table keeps a floor, and the window scrolls.
  // Read from the file: the table is drawn only once the list has come, which a server render never reaches.
  const source = await readFile(new URL('../web/src/components/ui/EnvironmentDetails.svelte', import.meta.url), 'utf8')
  const tableArea = /<div class="([^"]*)">\s*<table\b/.exec(source)?.[1] ?? ''
  assert.match(tableArea, /(^|\s)min-h-\[min\(160px,40dvh\)\](\s|$)/)
  assert.doesNotMatch(tableArea, /(^|\s)min-h-0(\s|$)/)
})

test('a window given no freeze offers none, and stays as it was', () => {
  const html = draw()
  assert.equal(freezeButton(html), null)
  assert.doesNotMatch(html, /pip freeze/)
  assert.match(words(html), LISTING)
  assert.match(dialogTag(html), /h-\[min\(720px,85dvh\)\]/)
})

/* ------------------------------------------------------- the window's press */

interface Page {
  fetch: typeof fetch
  save: (file: Blob, filename: string) => void
  signal: AbortSignal
}

/** The page's effects, counted: every request the press makes, and every file it hands the browser. */
function page(answer: (path: string) => Promise<globalThis.Response>, signal = new AbortController().signal) {
  const asked: string[] = []
  const saved: Array<Promise<{ filename: string; text: string }>> = []
  const effects: Page = {
    fetch: ((input: string) => {
      asked.push(input)
      return answer(input)
    }) as typeof fetch,
    save: (file, filename) => void saved.push(file.text().then((text) => ({ filename, text }))),
    signal,
  }
  return { effects, asked, saved }
}

/** The real route, as the owner's browser reaches it. */
const theRoute = (path: string) => fetch(`${base}${path}`, { headers: { cookie: staff('owner') } })

test('the window\'s press saves the route\'s 200 as the file, and a refusal only as words', async () => {
  images.set('colloq-kernel:base', { id: id('5'), created: '2026-10-21T12:20:00Z', platform: 'linux/arm64', python: '3.11.9' })
  frozen.set(id('5'), { code: 0, stdout: FREEZE })
  const ok = page(theRoute)
  assert.deepEqual(await windowModule.pressFreeze('base', { endpoint, built: true, catalogImage: null }, ok.effects), { done: 'saved' })
  assert.deepEqual(ok.asked, [endpoint])
  assert.equal(ok.saved.length, 1)
  const file = await ok.saved[0]!
  assert.equal(file.filename, 'base-pip-freeze.txt')
  assert.equal(file.text, `# base · Python 3.11.9 · linux/arm64 · image ${id('5')} · built 2026-10-21T12:20:00Z\n${FREEZE}`)

  // A list gone stale: the row said built, the image is gone since. The server's words, and no file.
  images.delete('colloq-kernel:base-gpu')
  const stale = page(theRoute)
  const refused = await windowModule.pressFreeze('base-gpu', { endpoint: '/api/admin/environments/base-gpu/freeze', built: true, catalogImage: null }, stale.effects)
  assert.equal(refused.done, 'refused')
  assert.match((refused as { words: string }).words, /У окружения «base-gpu» ещё нет образа/)
  assert.equal(stale.saved.length, 0)
})

test('the window\'s press saves nothing but a 200: not a proxy\'s page, not an empty 2xx, not a broken connection', async () => {
  const ready = { endpoint, built: true, catalogImage: null }
  const answers: Array<[string, () => Promise<globalThis.Response>, FreezePress]> = [
    ['a proxy\'s 502 page', async () => new Response('<html>Bad Gateway</html>', { status: 502, headers: { 'content-type': 'text/html' } }), { done: 'refused', words: null }],
    ['an empty 204', async () => new Response(null, { status: 204 }), { done: 'refused', words: null }],
    ['a refusal with empty words', async () => Response.json({ error: '', reason: 'failed' }, { status: 503 }), { done: 'refused', words: null }],
    ['a broken connection', async () => { throw new TypeError('Failed to fetch') }, { done: 'refused', words: null }],
  ]
  for (const [what, answer, expected] of answers) {
    const press = page(answer)
    assert.deepEqual(await windowModule.pressFreeze('base', ready, press.effects), expected, what)
    assert.equal(press.saved.length, 0, what)
  }

  // The window closed while the file was on its way: nothing is saved, and nobody is told.
  const closing = new AbortController()
  const late = page(async () => {
    closing.abort()
    return new Response(FREEZE, { status: 200 })
  }, closing.signal)
  assert.deepEqual(await windowModule.pressFreeze('base', ready, late.effects), { done: 'aborted' })
  assert.equal(late.saved.length, 0)
})

test('a press in a window with no image to read asks the server nothing', async () => {
  for (const freeze of [undefined, { endpoint, built: false, catalogImage: null }, { endpoint, built: false, catalogImage }]) {
    const press = page(theRoute)
    assert.deepEqual(await windowModule.pressFreeze('base', freeze, press.effects), { done: 'skipped' })
    assert.deepEqual(press.asked, [])
    assert.equal(press.saved.length, 0)
  }
})

test('the window presses through pressFreeze and says it is reading while it does', async () => {
  // Read from the file, like the panels' craft tests: the press's half that needs a page.
  const source = await readFile(new URL('../web/src/components/ui/EnvironmentDetails.svelte', import.meta.url), 'utf8')
  const press = /async function downloadFreeze\(\): Promise<void> \{([\s\S]*?)\n {2}\}/.exec(source)?.[1] ?? ''
  // What the foot offers: the panel's freeze as given, a competition page's once its list has told it.
  assert.match(press, /if \(!readable \|\| freezing\) return\s+freezing = true[\s\S]*await pressFreeze\(name, offered,[\s\S]*finally \{\s+freezing = false/)
  // The action's words are both pages' (common), the competition pages loading no panel words.
  assert.match(press, /press\.done === 'refused'[\s\S]*words \?\? tr\('common\.environmentFreezeFailed'\)/)
  const button = /<button\b[^>]*aria-describedby="environment-freeze-note"[\s\S]*?<\/button>/.exec(source)?.[0] ?? ''
  assert.match(button, /disabled=\{!readable \|\| freezing\}/)
  assert.match(button, /\{freezing \? tr\('common\.environmentFreezeReading'\) : tr\('common\.environmentFreeze'\)\}/)
})

/* ------------------------------------------------------------ the screen */

test('the environments screen hands every row\'s window its freeze: the route, whether an image is built, the catalog\'s image', async () => {
  const screen = await readFile(new URL('../web/src/admin/screens/Environments.svelte', import.meta.url), 'utf8')
  const link = /<EnvironmentLink\b[\s\S]*?\/>/.exec(screen)?.[0] ?? ''
  assert.match(link, /endpoint: `\/api\/admin\/environments\/\$\{encodeURIComponent\(env\.name\)\}\/freeze`/)
  assert.match(link, /built: env\.builtAt !== null/)
  assert.match(link, /catalogImage: env\.managed \? \(env\.image \?\? null\) : null/)
  const opener = await readFile(new URL('../web/src/components/ui/EnvironmentLink.svelte', import.meta.url), 'utf8')
  assert.match(opener, /<EnvironmentDetails \{name\} \{endpoint\} \{freeze\}/)
})

test('above a phone\'s width a row\'s name is never squeezed out: the states and actions go under it in one piece', async () => {
  // The name is the only way into the window; on an iPad in Russian it measured 0px beside two long pills.
  const screen = (await readFile(new URL('../web/src/admin/screens/Environments.svelte', import.meta.url), 'utf8'))
    .replace(/<!--[\s\S]*?-->/g, '')
  const row = /<section class="border border-line">\s*<div\s+class="([^"]*)"/.exec(screen)?.[1] ?? ''
  assert.match(row, /(^|\s)flex-wrap(\s|$)/, 'the row wraps at every width, not only on a phone')
  const column = /<div\s+class="(flex flex-1 flex-col[^"]*)"/.exec(screen)?.[1] ?? ''
  assert.ok(column, 'the name column')
  assert.doesNotMatch(column, /(^|\s)min-w-0(\s|$)/, 'above 640 it keeps the name and its badge whole')
  assert.match(column, /max-\[640px\]:min-w-0/)
  assert.match(screen, /<p class="admin-meta truncate[^"]*min-\[641px\]:w-0 min-\[641px\]:min-w-full">/, 'the facts line does not hold the column wide')
  // One tail for both branches, a box above 640 and none on a phone.
  const tail = /<div class="ml-auto flex flex-wrap items-center justify-end gap-3 max-\[640px\]:contents">\s*\{#if env\.state === 'building'\}[\s\S]*?\{\/if\}\s*<\/div>\s*<\/div>/.exec(screen)?.[0] ?? ''
  assert.ok(tail, 'the states and actions stand in one tail')
  assert.match(tail, /aria-haspopup="menu"/, 'the menu goes with them')
})

/* ------------------------------------------------- the competition's door */

let made = 0
/** A competition on `environment` in `state`, under a slug of its own; a draft is how one is created. */
function competition(environment: string, state: Competition['state'] = 'live', startsAt: number | null = null): Competition {
  made += 1
  const created = createCompetition({ slug: `freeze-${made}`, title: `Freeze ${made}`, environment, startsAt })
  assert.ok(created)
  if (state !== 'draft') setCompetitionState(created.id, state)
  return { ...created, state }
}

/** A participant of `competitionId`, signed in: a newcomer with a key, as joining makes one. */
function participant(competitionId: string, name: string): string {
  const minted = joinAsNewcomer(competitionId, name)
  assert.ok(minted !== 'taken', name)
  let value = ''
  issueEntrantCookie({ cookie: (_n: string, v: string) => (value = v) } as unknown as Response, minted.entrant)
  return `${ENTRANT_COOKIE}=${value}`
}

const door = (slug: string, cookie: string | null = null, tail = '/freeze') =>
  fetch(`${base}/api/k/competitions/${slug}/environment${tail}`, { headers: cookie ? { cookie } : {} })

/** The revision a competition pins at its first run, of `image`. */
function pin(c: Competition, image: string, packages: { name: string; version: string }[]): string {
  const revision = putRevision({
    environmentName: c.environment, imageDigest: image, pythonVersion: '3.11.9', pythonAbi: 'cp311',
    platform: 'linux/amd64', packages, baseConstraintsHash: `freeze-${image.slice(-8)}`,
  })
  selectRevision(c.id, revision.id)
  return revision.id
}

test('a competition window downloads the panel\'s very file for its environment, and one pip freeze serves both doors', async () => {
  expire()
  images.set('colloq-kernel:base', { id: id('6'), created: '2026-10-22T08:00:00Z', platform: 'linux/arm64', python: '3.11.9' })
  frozen.set(id('6'), { code: 0, stdout: FREEZE })
  const c = competition('base')
  const runs = freezeRuns().length
  // Nobody signed in: the page of a published competition is anyone's who has its link, and so is its list.
  const theirs = await door(c.slug)
  const panel = await download('base')
  assert.equal(theirs.status, 200)
  for (const header of ['content-type', 'content-disposition', 'cache-control']) {
    assert.equal(theirs.headers.get(header), panel.headers.get(header), header)
  }
  assert.equal(theirs.headers.get('content-disposition'), 'attachment; filename="base-pip-freeze.txt"')
  const text = await theirs.text()
  assert.equal(text, await panel.text(), 'the same header line and the same lines under it')
  assert.equal(text, `# base · Python 3.11.9 · linux/arm64 · image ${id('6')} · built 2026-10-22T08:00:00Z\n${FREEZE}`)
  assert.equal(freezeRuns().length - runs, 1, 'kept by the image, whichever door asked')
})

test('the freeze is open exactly where the window\'s list is: to anyone with a published competition\'s page, refused for a draft in the list\'s words', async () => {
  expire()
  images.set('colloq-kernel:base', { id: id('6'), created: '2026-10-22T08:00:00Z', platform: 'linux/arm64', python: '3.11.9' })
  frozen.set(id('6'), { code: 0, stdout: FREEZE })
  const elsewhere = competition('base')
  const outsider = participant(elsewhere.id, '@freeze_outsider')
  const day = 24 * 60 * 60 * 1000
  const cases: Array<{ what: string; slug: string; visible: boolean; member: string | null }> = []
  for (const [what, state, startsAt] of [
    ['live', 'live', null],
    ['live, not started yet', 'live', Date.now() + day],
    ['finished', 'finished', null],
    ['draft', 'draft', null],
  ] as const) {
    const c = competition('base', state, startsAt)
    cases.push({ what, slug: c.slug, visible: state !== 'draft', member: participant(c.id, `@freeze_${made}`) })
  }
  cases.push({ what: 'no such competition', slug: 'freeze-nowhere', visible: false, member: null })
  const visitors: Array<[string, (member: string | null) => string | null]> = [
    ['nobody signed in', () => null],
    ['a participant of another competition', () => outsider],
    ['its participant', (member) => member],
    ['an owner', () => staff('owner')],
    ['a teacher', () => staff('teacher')],
  ]
  const missing = { error: tr('competitions.refusal.notFound'), reason: 'not_found' }
  for (const { what, slug, visible, member } of cases) {
    for (const [who, cookieOf] of visitors) {
      const cookie = cookieOf(member)
      const where = `${what}, ${who}`
      const [list, listed, freeze] = await Promise.all([door(slug, cookie, ''), door(slug, cookie, '?freeze'), door(slug, cookie)])
      assert.equal(list.status, visible ? 200 : 404, `the list: ${where}`)
      assert.equal(listed.status, list.status, `the list with its image: ${where}`)
      assert.equal(freeze.status, list.status, `the freeze: ${where}`)
      if (visible) {
        assert.equal(freeze.headers.get('content-disposition'), 'attachment; filename="base-pip-freeze.txt"', where)
        assert.equal(await freeze.text(), `# base · Python 3.11.9 · linux/arm64 · image ${id('6')} · built 2026-10-22T08:00:00Z\n${FREEZE}`, where)
      } else {
        // Refused where the list is, and in its words: nothing says whether a draft is there.
        assert.deepEqual(await list.json(), missing, where)
        assert.deepEqual(await listed.json(), missing, where)
        assert.deepEqual(await freeze.json(), missing, where)
      }
    }
  }
})

test('a pinned competition\'s freeze is its pinned image\'s, the one its list shows and its submissions run in, after a rebuild moved the tag', async () => {
  expire()
  // The tag names the rebuilt image; the competition's revision keeps the one before, an id no other test plays.
  const before = `sha256:${'7a'.repeat(32)}`
  images.set('colloq-kernel:kaggle-base', { id: id('8'), created: '2026-10-22T09:00:00Z', platform: 'linux/amd64', python: '3.11.9' })
  frozen.set(id('8'), { code: 0, stdout: 'catboost==1.2.8\npip==25.0.1\n' })
  images.set(before, { id: before, created: '2026-09-01T08:00:00Z', platform: 'linux/amd64', python: '3.11.9' })
  frozen.set(before, { code: 0, stdout: 'catboost==1.2.7\npip==24.2\n' })
  const c = competition('kaggle-base')
  const revisionId = pin(c, before, [{ name: 'catboost', version: '1.2.7' }, { name: 'pip', version: '24.2' }])

  const list = (await (await door(c.slug, null, '?freeze')).json()) as EnvironmentInventory & { freeze?: unknown }
  assert.equal(list.revisionId, revisionId)
  assert.deepEqual(list.packages, [{ name: 'catboost', version: '1.2.7' }, { name: 'pip', version: '24.2' }])
  assert.deepEqual(list.freeze, { built: true, catalogImage: null })

  const file = await (await door(c.slug)).text()
  assert.equal(file, `# kaggle-base · Python 3.11.9 · linux/amd64 · image ${before} · built 2026-09-01T08:00:00Z\ncatboost==1.2.7\npip==24.2\n`)
  const run = freezeRuns().at(-1)!
  assert.ok(run.includes(before) && !run.includes('colloq-kernel:kaggle-base'), 'the pinned image, by its id')
  // The panel's window reads the image the rooms start from now.
  assert.match(await (await download('kaggle-base')).text(), new RegExp(`^# kaggle-base · .* · image ${id('8')} · `))
})

test('a competition\'s freeze refuses in the panel\'s words where there is no image, and in its own where its pinned image is gone', async () => {
  expire()
  images.delete('colloq-kernel:base-gpu')
  const unbuilt = competition('base-gpu')
  const runs = freezeRuns().length
  const refused = await door(unbuilt.slug)
  assert.equal(refused.status, 409)
  const body = await refusal<CompetitionErrorBody>(refused)
  assert.equal(body.error, tr('server.environmentFreeze.unbuilt', { name: 'base-gpu' }))
  assert.equal(freezeRuns().length, runs, 'docker is asked to run nothing')
  // The list it stands under is refused too, and tells its window why beside its words.
  const list = await door(unbuilt.slug, null, '?freeze')
  assert.equal(list.status, 503)
  assert.deepEqual(await list.json(), { error: tr('common.environmentUnavailable'), reason: 'unavailable', freeze: { built: false, catalogImage: null } })

  // Pinned to an image removed since: the list is the revision's still, and the freeze says what is gone.
  images.set('colloq-kernel:kaggle-base', { id: id('8'), created: '2026-10-22T09:00:00Z', platform: 'linux/amd64', python: '3.11.9' })
  images.delete(id('0'))
  const gone = competition('kaggle-base')
  pin(gone, id('0'), [{ name: 'catboost', version: '1.2.6' }])
  const pinnedGone = await door(gone.slug)
  assert.equal(pinnedGone.status, 409)
  const words = (await refusal<CompetitionErrorBody>(pinnedGone)).error
  assert.equal(words, tr('server.environmentFreeze.pinnedGone', { name: 'kaggle-base' }))
  assert.doesNotMatch(words, /первой сборки/, 'the environment has an image; the competition\'s is what is gone')
  const kept = await door(gone.slug, null, '?freeze')
  assert.equal(kept.status, 200)
  assert.deepEqual(((await kept.json()) as { freeze?: unknown }).freeze, { built: false, catalogImage: null })
  assert.equal(freezeRuns().length, runs)
})

/** An image id no other test plays: the hex digits of `id` are all taken. */
const pairId = (pair: string) => `sha256:${pair.repeat(32)}`

test('a competition\'s freeze that fails is refused as its list is, in readable words naming nothing of docker\'s or the host\'s, and the log says why', async (t) => {
  expire()
  const warned: string[] = []
  t.mock.method(console, 'warn', (...args: unknown[]) => void warned.push(args.map(String).join(' ')))
  /** The list door's rule (environment-inventory.test.mts · without Docker diagnostics), held to the freeze's. */
  const readable = async (response: globalThis.Response, what: string) => {
    assert.equal(response.status, 503, what)
    const body = await refusal<CompetitionErrorBody>(response)
    assert.deepEqual(body, { error: tr('server.environmentFreeze.unavailable', { name: 'base' }), reason: 'unavailable' }, what)
    assert.doesNotMatch(body.error, /docker|daemon|\.sock|No module|private-host|ENOENT/i, what)
  }
  images.set('colloq-kernel:base', { id: id('6'), created: '2026-10-22T08:00:00Z', platform: 'linux/arm64', python: '3.11.9' })
  const c = competition('base')

  // A daemon that does not answer: its socket stays on the server, and the panel's staff still read it.
  inspectTrouble = { code: 1, stderr: 'Cannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the docker daemon running?\n' }
  try {
    await readable(await door(c.slug), 'docker not answering')
    // Not "no image": nothing is known, and the window lets a press find out.
    const list = (await (await door(c.slug, null, '?freeze')).json()) as Record<string, unknown>
    assert.equal('freeze' in list, false)
    assert.equal(list.name, 'base')
    assert.match((await refusal(await download('base'))).error, /: Cannot connect to the Docker daemon at unix:\/\/\/var\/run\/docker\.sock/)
  } finally {
    inspectTrouble = null
  }
  assert.deepEqual(warned, ['[environments] the pip freeze of base could not be read: Cannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the docker daemon running?'])

  // An image whose python has no pip: python's words stay on the server too.
  expire()
  images.set('colloq-kernel:base', { id: pairId('5a'), created: '2026-10-22T08:30:00Z', platform: 'linux/arm64', python: '3.11.9' })
  frozen.set(pairId('5a'), { code: 1, stderr: '/usr/local/bin/python: No module named pip\n' })
  await readable(await door(c.slug), 'a run that failed')
  assert.match(warned.at(-1) ?? '', /could not be read: \/usr\/local\/bin\/python: No module named pip$/)

  // A release catalog this server cannot read: its path is the host's.
  const saved = { KERNEL_BACKEND: process.env.KERNEL_BACKEND, KERNEL_CATALOG_FILE: process.env.KERNEL_CATALOG_FILE }
  Object.assign(process.env, { KERNEL_BACKEND: 'broker', KERNEL_CATALOG_FILE: path.join(TEST_ROOT, 'private-host', 'kernel-catalog.json') })
  try {
    await readable(await door(c.slug), 'an unreadable catalog')
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }
})

test('however many ask at once, a competition\'s window costs docker one inspect an image, and a failing freeze one container, for a few seconds', async (t) => {
  expire()
  t.mock.method(console, 'warn', () => {})
  const ready = pairId('5b')
  images.set('colloq-kernel:base', { id: ready, created: '2026-10-22T10:00:00Z', platform: 'linux/arm64', python: '3.11.9' })
  frozen.set(ready, { code: 0, stdout: FREEZE })
  const c = competition('base')
  const burst = (slug: string, tail: string) => Promise.all(Array.from({ length: 30 }, () => door(slug, null, tail)))

  // Thirty windows opening at once, nobody signed in: one inspect, and every one of them told.
  let inspected = inspects().length
  const opened = await burst(c.slug, '?freeze')
  assert.equal(inspects().length - inspected, 1)
  for (const response of opened) assert.deepEqual(((await response.json()) as { freeze?: unknown }).freeze, { built: true, catalogImage: null })

  // Thirty presses at once: one inspect and one pip freeze, and thirty copies of one file.
  inspected = inspects().length
  const runs = freezeRuns().length
  const pressed = await burst(c.slug, '/freeze')
  assert.equal(inspects().length - inspected, 1)
  assert.equal(freezeRuns().length - runs, 1)
  const files = new Set(await Promise.all(pressed.map((response) => response.text())))
  assert.deepEqual([...files], [`# base · Python 3.11.9 · linux/arm64 · image ${ready} · built 2026-10-22T10:00:00Z\n${FREEZE}`])

  // A pinned competition's windows, by its pinned image all the same.
  const kept = pairId('5d')
  images.set(kept, { id: kept, created: '2026-09-02T08:00:00Z', platform: 'linux/amd64', python: '3.11.9' })
  const pinned = competition('kaggle-base')
  pin(pinned, kept, [{ name: 'catboost', version: '1.2.6' }])
  inspected = inspects().length
  await Promise.all((await burst(pinned.slug, '?freeze')).map((response) => response.arrayBuffer()))
  assert.equal(inspects().length - inspected, 1)

  // An image whose freeze fails: every press of those seconds is told so by one container, and one more comes after.
  const failing = pairId('5e')
  images.set('colloq-kernel:base', { id: failing, created: '2026-10-22T10:30:00Z', platform: 'linux/arm64', python: '3.11.9' })
  frozen.set(failing, { code: 1, stderr: '/usr/local/bin/python: No module named pip\n' })
  expire()
  const before = freezeRuns().length
  for (let press = 0; press < 10; press += 1) assert.equal((await door(c.slug)).status, 503)
  assert.equal(freezeRuns().length - before, 1, 'one container, not one a request')
  now += 4_000
  assert.equal((await door(c.slug)).status, 503)
  assert.equal(freezeRuns().length - before, 1, 'still kept four seconds after it failed')
  now += 2_000
  assert.equal((await door(c.slug)).status, 503)
  assert.equal(freezeRuns().length - before, 2, 'and tried again a few seconds after')
})

test('a pinned list answers while docker is still inspecting its image, untold of it, and the next window is told once docker answers', async () => {
  expire()
  const kept = pairId('5f')
  images.set(kept, { id: kept, created: '2026-09-03T08:00:00Z', platform: 'linux/amd64', python: '3.11.9' })
  const c = competition('kaggle-base')
  pin(c, kept, [{ name: 'catboost', version: '1.2.5' }])
  // A daemon that takes its time: the inspect starts, and ends only when this test lets it.
  const held: { child?: Child } = {}
  inspectTrouble = (made) => void (held.child = made)
  let answer: Record<string, unknown>
  try {
    answer = (await (await door(c.slug, null, '?freeze')).json()) as Record<string, unknown>
  } finally {
    inspectTrouble = null
  }
  const inspecting = held.child
  assert.ok(inspecting, 'the inspect was started')
  assert.equal(inspecting.kills, 0, 'and was still going, not given up at its timeout, when the list answered')
  assert.deepEqual(answer.packages, [{ name: 'catboost', version: '1.2.5' }], 'the revision\'s list, from the database')
  assert.equal('freeze' in answer, false, 'untold, which the window reads as an image to read')

  // Docker answers: the next window is told, by that very inspect.
  const inspected = inspects().length
  play(inspecting, inspect(inspects().at(-1)!))
  const next = (await (await door(c.slug, null, '?freeze')).json()) as { freeze?: unknown }
  assert.deepEqual(next.freeze, { built: true, catalogImage: null })
  assert.equal(inspects().length, inspected)
})

test('the list tells its window of the image only when asked: without `?freeze` it is the list it always was, and docker is not asked', async () => {
  expire()
  images.set('colloq-kernel:base', { id: id('6'), created: '2026-10-22T08:00:00Z', platform: 'linux/arm64', python: '3.11.9' })
  const c = competition('base')
  const listed = { name: 'base', python: '3.11.9', packages: [{ name: 'numpy', version: '2.1.3' }] }
  assert.deepEqual(await (await door(c.slug, null, '?freeze')).json(), { ...listed, freeze: { built: true, catalogImage: null } })
  const asked = inspects().length
  assert.deepEqual(await (await door(c.slug, null, '')).json(), listed)
  assert.equal(inspects().length, asked)
})

test('under the release catalog a competition\'s freeze names the image it runs, its pin or the catalog\'s, and docker is asked nothing', async () => {
  const current = `registry.test/colloq/kernel-base@sha256:${'9'.repeat(64)}`
  const older = `registry.test/colloq/kernel-base@sha256:${'8'.repeat(64)}`
  const catalog = path.join(TEST_ROOT, 'catalog-competition-freeze.json')
  fs.writeFileSync(catalog, JSON.stringify({ schemaVersion: 1, release: 'r2', defaultEnvironment: 'base', environments: [{ name: 'base', image: current, gpu: false, current: true }] }))
  const unpinned = competition('base')
  const pinned = competition('base')
  pin(pinned, older, [{ name: 'numpy', version: '2.0.2' }])
  const saved = { KERNEL_BACKEND: process.env.KERNEL_BACKEND, KERNEL_CATALOG_FILE: process.env.KERNEL_CATALOG_FILE }
  Object.assign(process.env, { KERNEL_BACKEND: 'broker', KERNEL_CATALOG_FILE: catalog })
  const calls = docker.calls.length
  try {
    for (const [c, image] of [[unpinned, current], [pinned, older]] as const) {
      const refused = await door(c.slug)
      assert.equal(refused.status, 409)
      const words = (await refusal<CompetitionErrorBody>(refused)).error
      assert.equal(words, tr('server.environmentFreeze.managed', { name: 'base', image }))
      assert.ok(words.includes(`docker run --rm --network none --entrypoint python ${image} -m pip freeze --all`))
      const list = (await (await door(c.slug, null, '?freeze')).json()) as { freeze?: unknown }
      assert.deepEqual(list.freeze, { built: false, catalogImage: image })
    }
    assert.equal(docker.calls.length, calls, 'no docker here at all')
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }
})

/* ----------------------------------------------- the competition's window */

/** Conditions.svelte's words, as its source has them (the last test of this file holds the two together). */
const competitionWords = {
  hint: () => tr('competitions.p.freezeHint'),
  unbuilt: (alone: boolean) => (alone ? tr('competitions.p.freezeMissingNoList') : tr('competitions.p.freezeMissing')),
  managed: (alone: boolean) => (alone ? tr('competitions.p.freezeManagedNoList') : tr('competitions.p.freezeManaged')),
}
const listed: ListedFreeze = { endpoint: '/api/k/competitions/letters/environment/freeze', listed: true, words: competitionWords }

test('a competition window takes what its image is from its list\'s answer, a refusal\'s too, and an answer that says nothing is an image to read', () => {
  const told = (answer: unknown) => {
    const { words, ...facts } = windowModule.listedFreeze(listed, answer)
    assert.equal(words, competitionWords, 'its own words go with it')
    return facts
  }
  const route = listed.endpoint
  assert.deepEqual(told({ name: 'base', python: '3.11.9', packages: [], freeze: { built: true, catalogImage: null } }), { endpoint: route, built: true, catalogImage: null })
  assert.deepEqual(told({ error: 'Не удалось прочитать…', reason: 'unavailable', freeze: { built: false, catalogImage: null } }), { endpoint: route, built: false, catalogImage: null })
  assert.deepEqual(told({ name: 'base', packages: [], freeze: { built: false, catalogImage } }), { endpoint: route, built: false, catalogImage })
  // Docker did not answer, an older server, a proxy's page, garbage: nothing is known against reading it.
  for (const answer of [{ name: 'base', packages: [] }, null, 'Bad Gateway', 7, { freeze: { built: 'yes', catalogImage: 9 } }]) {
    assert.deepEqual(told(answer), { endpoint: route, built: true, catalogImage: null }, JSON.stringify(answer))
  }
})

test('a competition window offers the download in the competition page\'s words, and greys it with its reason, which with no list above speaks for the list too', async () => {
  const ready = draw(windowModule.listedFreeze(listed, { freeze: { built: true, catalogImage: null } }))
  const button = freezeButton(ready)
  assert.ok(button, 'the action is there')
  assert.match(button!, /Скачать pip freeze/)
  assert.doesNotMatch(button!, /\sdisabled/)
  assert.match(words(ready), /Точный состав образа, в котором проверяются посылки: файл для pip install -r\./)
  assert.doesNotMatch(words(ready), /комнаты окружения|сборки/, 'not the panel\'s rooms and builds')

  // No list came, its door refused it: the reason is all the window says, as the panel's is.
  const missing = draw(windowModule.listedFreeze(listed, { freeze: { built: false, catalogImage: null } }))
  assert.match(freezeButton(missing) ?? '', /\sdisabled/)
  assert.match(words(missing), /Образа, в котором проверяются посылки, на сервере нет: ни состав, ни pip freeze здесь не прочитать\./)

  const managed = draw(windowModule.listedFreeze(listed, { freeze: { built: false, catalogImage } }))
  assert.match(freezeButton(managed) ?? '', /\sdisabled/)
  assert.match(words(managed), /Образ приходит из каталога релиза и закреплён по дайджесту, а Docker у этого сервера нет: ни состав, ни pip freeze здесь не прочитать\./)
  assert.ok(words(managed).includes(`docker run --rm --network none --entrypoint python ${catalogImage} -m pip freeze --all`))

  // Under the list a pinned revision keeps, the reasons are the pip freeze's alone. That list is drawn once it has
  // come, which a server render never reaches: the window tells its words whether they stand alone.
  const source = await readFile(new URL('../web/src/components/ui/EnvironmentDetails.svelte', import.meta.url), 'utf8')
  assert.match(source, /offered\.words\?\.unbuilt\(imageless\) \?\? tr\('admin\.env\.freezeUnbuilt'\)/)
  assert.match(source, /offered\.words\?\.managed\(imageless\) \?\? tr\('admin\.env\.freezeManaged'\)/)
  for (const key of ['competitions.p.freezeMissing', 'competitions.p.freezeManaged']) {
    assert.match(tr(key), /pip freeze здесь не прочитать/, key)
    assert.doesNotMatch(tr(key), /ни состав/, key)
  }

  setLocaleResolver(() => 'en')
  try {
    const english = draw(windowModule.listedFreeze(listed, { freeze: { built: true, catalogImage: null } }))
    assert.match(freezeButton(english) ?? '', /Download pip freeze/)
    assert.match(words(english), /The exact packages of the image used to check submissions: a file for pip install -r\./)
    assert.match(
      words(draw(windowModule.listedFreeze(listed, { freeze: { built: false, catalogImage: null } }))),
      /The image used to check submissions is not on this server: neither its installed packages nor its pip freeze can be read here\./,
    )
    assert.equal(tr('competitions.p.freezeMissing'), 'The image used to check submissions is not on this server, so its pip freeze cannot be read here.')
  } finally {
    // The next test reads Russian whatever this one found.
    setLocaleResolver(() => 'ru')
  }
})

test('a competition window asks for its list and shows its foot only once the list has said what the image is', async () => {
  const html = render(windowModule.default, {
    props: { name: 'base', endpoint: '/api/k/competitions/letters/environment?freeze', onclose: () => {}, freeze: listed },
  }).body
  assert.match(words(html), LISTING)
  assert.equal(freezeButton(html), null, 'no action while nothing is known of the image')
  assert.match(dialogTag(html), /h-\[min\(720px,85dvh\)\]/, 'the window keeps its height for the list')

  const source = await readFile(new URL('../web/src/components/ui/EnvironmentDetails.svelte', import.meta.url), 'utf8')
  // The answer is read whatever its status, and what it says of the image is taken before a refusal is.
  const load = /async function load\(\): Promise<void> \{([\s\S]*?)\n {2}\}/.exec(source)?.[1] ?? ''
  assert.match(load, /const body: unknown = await response\.json\(\)\.catch\(\(\) => null\)[\s\S]*told = listedFreeze\(freeze, body\)[\s\S]*if \(!response\.ok \|\| body === null\) throw/)
  // Its list may be its pinned revision's, kept whatever the machine has: imageless only when no list came.
  assert.match(source, /const imageless = \$derived\(offered !== undefined && !readable && inventory === null\)/)
  assert.match(source, /\{#if offered\}\s*<footer/)
  // A panel word is only ever the fallback of a page that gives none: the competition pages load no panel catalog.
  const panelWords = [...source.matchAll(/(.{0,40})tr\('admin\.[^']+'\)/g)]
  assert.equal(panelWords.length, 3)
  for (const [, before] of panelWords) assert.match(before!, /offered\.words\?\.\w+\((imageless)?\) \?\? $/)
})

test('the conditions\' «Окружение» row hands its window the competition\'s freeze, in words the competition pages load', async () => {
  const conditions = await readFile(new URL('../web/src/components/competitions/Conditions.svelte', import.meta.url), 'utf8')
  assert.match(conditions, /const environmentDoor = \$derived\(`\/api\/k\/competitions\/\$\{encodeURIComponent\(competition\.slug\)\}\/environment`\)/)
  const link = /<EnvironmentLink\b[\s\S]*?\/>/.exec(conditions)?.[0] ?? ''
  assert.match(link, /endpoint=\{`\$\{environmentDoor\}\?freeze`\}/)
  assert.match(link, /freeze=\{\{ endpoint: `\$\{environmentDoor\}\/freeze`, listed: true, words: freezeWords \}\}/)
  assert.doesNotMatch(conditions, /tr\('admin\./)
  const keys = [...conditions.matchAll(/tr\('(competitions\.p\.freeze\w+)'\)/g)].map((match) => match[1]!)
  assert.deepEqual(keys, [
    'competitions.p.freezeHint',
    'competitions.p.freezeMissingNoList', 'competitions.p.freezeMissing',
    'competitions.p.freezeManagedNoList', 'competitions.p.freezeManaged',
  ])
  // A reason with no list above speaks for the list too; under one, of the pip freeze alone (this file's competitionWords).
  assert.match(conditions, /unbuilt: \(alone: boolean\) => \(alone \? tr\('competitions\.p\.freezeMissingNoList'\) : tr\('competitions\.p\.freezeMissing'\)\)/)
  assert.match(conditions, /managed: \(alone: boolean\) => \(alone \? tr\('competitions\.p\.freezeManagedNoList'\) : tr\('competitions\.p\.freezeManaged'\)\)/)
  // The competition pages' dictionary is common + competitions (+ the server's status words): every word the window says there.
  for (const key of keys) assert.ok(Object.hasOwn(competitionsMessages, key), key)
  for (const key of ['common.environmentFreeze', 'common.environmentFreezeReading', 'common.environmentFreezeFailed']) {
    assert.ok(Object.hasOwn(commonMessages, key), key)
  }
  const opener = await readFile(new URL('../web/src/components/ui/EnvironmentLink.svelte', import.meta.url), 'utf8')
  assert.match(opener, /freeze\?: EnvironmentFreeze \| ListedFreeze/)
})
