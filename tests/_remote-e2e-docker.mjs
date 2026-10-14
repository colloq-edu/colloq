/**
 * A fake `docker` CLI for tests/remote-e2e.test.mts: what a machine's agent
 * and the unchanged DockerCompetitionRunner on it ask of the daemon, answered
 * from a state folder, so the REAL agent process runs a submission end to end
 * without a daemon, an image or a network.
 *
 * ONE PROCESS PER CALL, AS THE REAL CLI. The agent spawns `docker` from PATH
 * (runner-agent/docker.ts, competitions/docker-runner.ts · shell); the test
 * puts a two-line wrapper named `docker` first on the agent's PATH that runs
 * this file with the test's own node. Plain JavaScript on purpose: a watched
 * run asks `inspect` every second and `exec … status` every three, and a
 * TypeScript loader would add a third of a second to each.
 *
 * THE STATE (FAKE_DOCKER_STATE, one per machine):
 *   images/<name>.json       an image by every name it has (a pull's ref, a tag)
 *   containers/<name>.json   a container, from `run` until `rm`
 *   calls.log                every call, one JSON line each, for the test to read
 * FAKE_DOCKER_REGISTRY is a JSON file shared by the machines: what a pull of a
 * ref brings (its layers). FAKE_DOCKER_GATES is a folder shared with the test:
 * a notebook whose directive names a gate finishes once a file of that name
 * is there.
 *
 * THE SANDBOX IS THE HARNESS'S SHAPE, NOT ITS CODE. `run` of a submission's
 * container reads the notebook it mounts at /submission for the directive the
 * home's stand-in runner reads (competitions/fake-runner.ts):
 *
 *     # colloq-test: {"status": "cell_error", "cell": 1, "detail": "…"}
 *
 * and answers `exec … export_files.py status|file` the way the real harness's
 * files would read: progress.json while the notebook runs, then run.json, the
 * answer (built exactly as the stand-in builds it, so this server's metric
 * stand-in scores it the same way), executed.ipynb and .complete.json. The
 * supervisor keeps a finished container running for the export, as
 * hold_export.py does, until the runner removes it. No line of the notebook
 * is ever executed.
 *
 * Directive keys: `status` (a harness word, `oom`/`out_of_memory` for the
 * kernel killed for memory, `timeout` for a notebook that never ends — the
 * runner's wall decides), `cell`, `detail`, `detailFrom` (a data file put into
 * the traceback), `read` (a data file put into the answer), `executed`
 * (the executed notebook shows what was read), `log` (what `docker logs`
 * prints), `hold` (ms before the notebook ends), `gate` (a name: the notebook
 * ends once FAKE_DOCKER_GATES/<name> exists).
 */
import fs from 'node:fs'
import path from 'node:path'
import { createHash, randomBytes } from 'node:crypto'

const STATE = process.env.FAKE_DOCKER_STATE
const REGISTRY = process.env.FAKE_DOCKER_REGISTRY
const GATES = process.env.FAKE_DOCKER_GATES
const DIRECTIVE = /^\s*#\s*colloq-test:\s*(\{.*\})\s*$/m

// Every answer leaves through process.exit(), and a pipe write on macOS is asynchronous: blocking writes, or a 64 KB export arrives cut short (tests/_cli.mts says the same).
for (const stream of [process.stdout, process.stderr]) stream._handle?.setBlocking?.(true)

if (!STATE) {
  process.stderr.write('fake docker: FAKE_DOCKER_STATE is not set\n')
  process.exit(125)
}

const args = process.argv.slice(2)
const IMAGES = path.join(STATE, 'images')
const CONTAINERS = path.join(STATE, 'containers')
fs.mkdirSync(IMAGES, { recursive: true })
fs.mkdirSync(CONTAINERS, { recursive: true })
fs.appendFileSync(path.join(STATE, 'calls.log'), `${JSON.stringify({ at: Date.now(), pid: process.pid, args })}\n`)

/* ----------------------------------------------------------------- helpers */

function finish(code, out = '', err = '') {
  if (out) process.stdout.write(out.endsWith('\n') ? out : `${out}\n`)
  if (err) process.stderr.write(err.endsWith('\n') ? err : `${err}\n`)
  process.exit(code)
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    return null
  }
}

/** Whole or not at all: a reader in another process sees the old file or the new one. */
function writeJson(file, value) {
  const temporary = `${file}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`
  fs.writeFileSync(temporary, JSON.stringify(value))
  fs.renameSync(temporary, file)
}

const imageFile = (name) => path.join(IMAGES, `${encodeURIComponent(name)}.json`)
const containerFile = (name) => path.join(CONTAINERS, `${encodeURIComponent(name)}.json`)

function image(name) {
  return readJson(imageFile(name))
}

/** A container by its name, its id or a prefix of its id (`ps` prints the short id). */
function container(ref) {
  const named = readJson(containerFile(ref))
  if (named) return named
  if (!/^[a-f0-9]{6,64}$/.test(ref)) return null
  for (const file of fs.readdirSync(CONTAINERS)) {
    if (!file.endsWith('.json')) continue
    const found = readJson(path.join(CONTAINERS, file))
    if (found && found.id.startsWith(ref)) return found
  }
  return null
}

function allContainers() {
  return fs.readdirSync(CONTAINERS).filter((file) => file.endsWith('.json')).map((file) => readJson(path.join(CONTAINERS, file))).filter(Boolean)
}

/* --------------------------------------------------------------- the sandbox */

const ALIASES = { out_of_memory: 'out-of-memory', oom: 'out-of-memory', no_submission: 'no-submission' }

function directiveOf(notebook) {
  try {
    const book = JSON.parse(notebook.toString('utf8'))
    for (const cell of Array.isArray(book.cells) ? book.cells : []) {
      const source = Array.isArray(cell?.source) ? cell.source.join('') : typeof cell?.source === 'string' ? cell.source : ''
      const found = DIRECTIVE.exec(source)
      if (!found) continue
      const asked = JSON.parse(found[1])
      return asked && typeof asked === 'object' && !Array.isArray(asked) ? asked : {}
    }
  } catch { /* the ordinary path */ }
  return {}
}

function codeCellsOf(notebook) {
  try {
    const book = JSON.parse(notebook.toString('utf8'))
    return (Array.isArray(book.cells) ? book.cells : []).filter((cell) => cell?.cell_type === 'code').length
  } catch {
    return 0
  }
}

const statusOf = (c) => {
  const raw = typeof c.directive.status === 'string' ? c.directive.status : 'ok'
  return ALIASES[raw] ?? raw
}

/** Where the notebook inside is now: `running`, `finished` (its files written), or `oom` (the kernel and the container killed for memory). */
function notebookPhase(c, now = Date.now()) {
  const d = c.directive
  const status = statusOf(c)
  if (status === 'timeout') return 'running'
  const hold = typeof d.hold === 'number' && d.hold > 0 ? d.hold : 0
  if (now - c.startedAt < hold) return 'running'
  if (typeof d.gate === 'string' && !(GATES && fs.existsSync(path.join(GATES, d.gate)))) return 'running'
  return status === 'out-of-memory' ? 'oom' : 'finished'
}

/** The container's own state: killed, dead of memory, or running (a finished notebook's supervisor keeps it up for the export). */
function containerState(c) {
  if (c.killed) return { running: false, status: 'exited', exit: 137, oom: false }
  if (notebookPhase(c) === 'oom') return { running: false, status: 'exited', exit: 137, oom: true }
  return { running: true, status: 'running', exit: 0, oom: false }
}

const finalCell = (c) => (statusOf(c) === 'ok' || statusOf(c) === 'no-submission' ? Math.max(0, c.cells - 1) : typeof c.directive.cell === 'number' ? c.directive.cell : Math.max(0, c.cells - 1))
const runningCell = (c) => (typeof c.directive.cell === 'number' ? c.directive.cell : Math.max(0, c.cells - 1))

function dataFile(c, key) {
  const name = c.directive[key]
  if (typeof name !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,119}$/.test(name)) return null
  try {
    return fs.readFileSync(path.join(c.mounts['/data'], name))
  } catch {
    return null
  }
}

/** What /result holds now, by name: the harness's files as they would read. */
function resultFiles(c) {
  const phase = notebookPhase(c)
  const notebook = fs.readFileSync(path.join(c.mounts['/submission'], 'notebook.ipynb'))
  const files = {}
  const read = dataFile(c, 'read')
  const raised = dataFile(c, 'detailFrom')
  const executedCells = c.directive.executed === true
    ? [{ cell_type: 'code', source: 'print(data)', metadata: {}, execution_count: 1, outputs: [{ output_type: 'stream', name: 'stdout', text: (read ?? raised ?? Buffer.alloc(0)).toString('utf8') }] }]
    : (JSON.parse(notebook.toString('utf8')).cells ?? []).map((cell, index) => ({ ...cell, ...(cell.cell_type === 'code' ? { execution_count: index + 1, outputs: [] } : {}) }))
  // The harness snapshots the notebook as each cell starts: a run cut short still has one to salvage.
  files['executed.ipynb'] = Buffer.from(JSON.stringify({ nbformat: 4, nbformat_minor: 5, metadata: { colloq: 'fake-docker' }, cells: executedCells }))
  const finished = phase === 'finished'
  files['progress.json'] = Buffer.from(JSON.stringify({
    phase: finished ? 'finished' : 'cell', cell: finished ? finalCell(c) : runningCell(c), cells: c.cells,
    elapsed: (Date.now() - c.startedAt) / 1000, outputBytes: 0, outputTruncated: false, attemptId: c.attemptId,
  }))
  if (!finished) return files
  const status = statusOf(c)
  const harnessStatus = status === 'no-submission' ? 'ok' : status
  let answer = null
  if (status === 'ok') {
    let sample = null
    try { sample = fs.readFileSync(path.join(c.mounts['/data'], 'sample_submission.csv')) } catch { /* none: no answer */ }
    if (sample) {
      // The stand-in's answer, byte for byte (fake-runner.ts · run): its metric reads the directive from the head.
      const stamp = createHash('sha256').update(notebook).digest('hex').slice(0, 16)
      const head = Object.keys(c.directive).length ? `# colloq-test: ${JSON.stringify(c.directive)}\n` : ''
      answer = Buffer.concat([Buffer.from(head, 'utf8'), sample, Buffer.from(`\n# colloq-run: ${stamp}\n`, 'utf8'), read ?? Buffer.alloc(0)])
      files['submission.csv'] = answer
    }
  }
  const detail = raised
    ? `Traceback (most recent call last):\n  Cell In[1], line 1\nValueError: ${raised.toString('utf8')}`
    : typeof c.directive.detail === 'string' ? c.directive.detail : ''
  files['run.json'] = Buffer.from(JSON.stringify({
    status: harnessStatus, detail, cell: finalCell(c), cells: c.cells, cellTimes: [], wall: (Date.now() - c.startedAt) / 1000,
    outputBytes: 0, outputTruncated: false, targetBytes: answer ? answer.length : null, peakBytes: null, attemptId: c.attemptId,
  }))
  files['.complete.json'] = Buffer.from(JSON.stringify({ attemptId: c.attemptId, exit: harnessStatus === 'ok' ? 0 : 1 }))
  return files
}

/* ---------------------------------------------------------------- commands */

function info() {
  finish(0, JSON.stringify({
    ServerVersion: '28.3.1', Driver: 'overlay2', Name: process.env.FAKE_DOCKER_HOST ?? 'fake-docker-host', NCPU: 12,
    MemTotal: 32 * 1024 ** 3, OSType: 'linux', Architecture: 'x86_64', DockerRootDir: STATE,
  }))
}

function ps() {
  const labels = []
  let format = null
  for (let i = 1; i < args.length; i++) {
    if (args[i] === '--filter' && args[i + 1]?.startsWith('label=')) labels.push(args[++i].slice('label='.length))
    else if (args[i] === '--format') format = args[++i]
  }
  const quiet = args.some((arg) => /^-[a-z]*q[a-z]*$/.test(arg))
  const found = allContainers().filter((c) => labels.every((label) => c.labels.includes(label)))
  const lines = found.map((c) => {
    const short = c.id.slice(0, 12)
    if (quiet || !format) return short
    const gpu = c.labels.find((label) => label.startsWith('colloq.gpu='))?.slice('colloq.gpu='.length) ?? ''
    return format.replace('{{.ID}}', short).replace('{{.Label "colloq.gpu"}}', gpu)
  })
  finish(0, lines.join('\n'))
}

function imageCommand() {
  const [, sub, name] = args
  if (sub !== 'inspect' || !name) return finish(1, '', `fake docker: image ${sub ?? ''} is not in this fake`)
  const found = image(name)
  if (!found) return finish(1, '', `Error response from daemon: No such image: ${name}`)
  finish(0, JSON.stringify([{
    Id: found.id, RepoTags: found.tags ?? [], RepoDigests: found.repoDigests ?? [],
    Os: 'linux', Architecture: 'amd64', RootFS: { Type: 'layers', Layers: found.diffIds },
  }]))
}

function pull() {
  const ref = args[1]
  const registry = REGISTRY ? readJson(REGISTRY) ?? {} : {}
  const known = registry[ref]
  if (!ref || !known) return finish(1, '', `Error response from daemon: manifest unknown: ${ref ?? ''}`)
  const lines = known.diffIds.map((id) => `${id.replace(/^sha256:/, '').slice(0, 12)}: Pull complete`)
  writeJson(imageFile(ref), { id: `sha256:${createHash('sha256').update(ref).digest('hex')}`, diffIds: known.diffIds, repoDigests: [ref], tags: [] })
  finish(0, [...lines, `Digest: ${ref.slice(ref.indexOf('@') + 1)}`, `Status: Downloaded newer image for ${ref}`].join('\n'))
}

function tag() {
  const [, from, to] = args
  const found = from ? image(from) : null
  if (!found || !to) return finish(1, '', `Error response from daemon: No such image: ${from ?? ''}`)
  writeJson(imageFile(to), { ...found, tags: [...new Set([...(found.tags ?? []), to])] })
  finish(0)
}

function rmi() {
  const name = args[1]
  if (!name || !fs.existsSync(imageFile(name))) return finish(1, '', `Error response from daemon: No such image: ${name ?? ''}`)
  fs.rmSync(imageFile(name), { force: true })
  finish(0, `Untagged: ${name}`)
}

function run() {
  const at = (flag) => {
    const index = args.indexOf(flag)
    return index >= 0 ? args[index + 1] : undefined
  }
  const name = at('--name')
  const entry = args.indexOf('--entrypoint')
  // Only a submission's own container is in this fake: the agent's check containers (the card probe, Docker's disk) never start here.
  if (!name || entry < 0 || !args.includes('/harness/run_notebook.py')) return finish(125, '', `docker: fake docker runs only submission containers: ${args.join(' ')}`)
  const imageName = args[entry + 2]
  if (!image(imageName)) return finish(125, '', `docker: Error response from daemon: No such image: ${imageName}.`)
  if (fs.existsSync(containerFile(name))) return finish(125, '', `docker: Error response from daemon: Conflict. The container name "/${name}" is already in use.`)
  const mounts = {}
  const env = {}
  const labels = []
  for (let i = 1; i < entry; i++) {
    if (args[i] === '-v') {
      const [host, inside] = args[++i].split(':')
      mounts[inside] = host
    } else if (args[i] === '-e') {
      const pair = args[++i]
      env[pair.slice(0, pair.indexOf('='))] = pair.slice(pair.indexOf('=') + 1)
    } else if (args[i] === '--label') labels.push(args[++i])
  }
  let notebook
  try {
    notebook = fs.readFileSync(path.join(mounts['/submission'], 'notebook.ipynb'))
  } catch (error) {
    return finish(126, '', `docker: the fake sandbox found no notebook at /submission: ${error.message}`)
  }
  const made = {
    id: randomBytes(32).toString('hex'), name, image: imageName, labels, mounts, env,
    attemptId: env.COMP_ATTEMPT_ID ?? name, wallSeconds: Number(env.COMP_WALL_SECONDS ?? 0),
    directive: directiveOf(notebook), cells: codeCellsOf(notebook), startedAt: Date.now(), killed: false, killedAt: null,
  }
  writeJson(containerFile(name), made)
  finish(0, made.id)
}

function inspect() {
  // `inspect <name> --format <format>`, the runner's form; `inspect -f <format> <name>` is the agent's own (not used without a container of its own).
  const [, first, , second] = args
  const ref = first === '-f' || first === '--format' ? second : first
  const format = first === '-f' || first === '--format' ? args[2] : args[args.indexOf('--format') + 1]
  const c = ref ? container(ref) : null
  if (!c) return finish(1, '', `Error: No such object: ${ref ?? ''}`)
  const state = containerState(c)
  if (format === '{{.State.Running}}') return finish(0, String(state.running))
  if (format === '{{.State.Status}} {{.State.ExitCode}} {{.State.OOMKilled}}') return finish(0, `${state.status} ${state.exit} ${state.oom}`)
  if (format?.startsWith('{"labels"')) {
    const labels = Object.fromEntries(c.labels.map((label) => [label.slice(0, label.indexOf('=')), label.slice(label.indexOf('=') + 1)]))
    return finish(0, JSON.stringify({ labels, mounts: Object.entries(c.mounts).map(([inside, host]) => ({ Type: 'bind', Source: host, Destination: inside })) }))
  }
  finish(1, '', `fake docker: inspect format ${format} is not in this fake`)
}

function exec() {
  let i = 1
  if (args[i] === '--user') i += 2
  const ref = args[i]
  const c = ref ? container(ref) : null
  if (!c) return finish(1, '', `Error response from daemon: No such container: ${ref ?? ''}`)
  if (!containerState(c).running) return finish(1, '', `Error response from daemon: container ${c.id} is not running`)
  const command = args.slice(i + 1)
  if (command[0] === 'nvidia-smi') return finish(9, '', 'NVIDIA-SMI has failed: no card in a fake docker')
  if (command[0] !== 'python' || command[2] !== '/harness/export_files.py') return finish(126, '', `fake docker: exec ${command.join(' ')} is not in this fake`)
  const files = resultFiles(c)
  if (command[3] === 'status') {
    const value = {}
    for (const [key, name] of [['progress', 'progress.json'], ['complete', '.complete.json']]) {
      if (files[name]) value[key] = JSON.parse(files[name].toString('utf8'))
    }
    return finish(0, JSON.stringify(value))
  }
  const name = command[5]
  if (command[3] !== 'file' || !name || name === '.complete.json') return finish(1, '', 'ValueError: unknown export')
  if (!files[name]) return finish(1, '', `FileNotFoundError: [Errno 2] No such file or directory: '/result/${name}'`)
  process.stdout.write(files[name].toString('base64'))
  process.exit(0)
}

function logs() {
  const ref = args[args.length - 1]
  const c = container(ref)
  if (!c) return finish(1, '', `Error response from daemon: No such container: ${ref}`)
  finish(0, typeof c.directive.log === 'string' ? c.directive.log : '')
}

function kill() {
  const ref = args[args.length - 1]
  const c = container(ref)
  if (!c) return finish(1, '', `Error response from daemon: No such container: ${ref}`)
  if (!containerState(c).running) return finish(1, '', `Error response from daemon: cannot kill container: ${ref}: container ${c.id} is not running`)
  writeJson(containerFile(c.name), { ...c, killed: true, killedAt: Date.now() })
  finish(0, ref)
}

function rm() {
  const refs = args.slice(1).filter((arg) => !arg.startsWith('-'))
  const missing = []
  for (const ref of refs) {
    const c = container(ref)
    if (!c) missing.push(ref)
    else fs.rmSync(containerFile(c.name), { force: true })
  }
  if (missing.length > 0) return finish(1, refs.filter((ref) => !missing.includes(ref)).join('\n'), missing.map((ref) => `Error response from daemon: No such container: ${ref}`).join('\n'))
  finish(0, refs.join('\n'))
}

switch (args[0]) {
  case 'version':
    finish(0, '28.3.1')
    break
  case 'info':
    info()
    break
  case 'ps':
    ps()
    break
  case 'image':
    imageCommand()
    break
  case 'pull':
    pull()
    break
  case 'tag':
    tag()
    break
  case 'rmi':
    rmi()
    break
  case 'run':
    run()
    break
  case 'inspect':
    inspect()
    break
  case 'exec':
    exec()
    break
  case 'logs':
    logs()
    break
  case 'kill':
    kill()
    break
  case 'rm':
    rm()
    break
  case 'update':
    finish(0)
    break
  default:
    finish(1, '', `fake docker: ${args.join(' ')} is not in this fake`)
}
