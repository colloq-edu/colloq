/**
 * A fake `docker` CLI for the machines of the e2e suites
 * (tests/remote-e2e.test.mts, tests/classes-e2e.test.mts): what a machine's
 * agent, its class kernel host and the unchanged DockerCompetitionRunner on
 * it ask of the daemon, answered from a state folder, so the REAL agent
 * process runs submissions and class kernels end to end without a daemon, an
 * image or a network.
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
 *   containers/<name>.log    a class container's log (its Jupyter's output, every start of it)
 *   containers/<name>.oom    a line for each kernel its cgroup's OOM killer took
 *   containers/<name>.fs/    what a class container holds outside its mounts (`cp`)
 *   networks/<name>.json     a network `network create` made
 *   knobs.json               how the daemon misbehaves (KNOBS below)
 *   calls.log                every call, one JSON line each, for the test to read
 * FAKE_DOCKER_REGISTRY is a JSON file shared by the machines: what a pull of a
 * ref brings (its layers). FAKE_DOCKER_GATES is a folder shared with the test:
 * a notebook whose directive names a gate finishes once a file of that name
 * is there. FAKE_DOCKER_OWNER is the test's pid: a class container's process
 * ends once it is gone. FAKE_DOCKER_CALLS, when set, is a folder where each
 * class container's Jupyter writes down every call it takes
 * (<container id>.jsonl), which no `rm` removes.
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
 *
 * A CLASS CONTAINER IS A FAKE JUPYTER OF ITS OWN (remote-classes.md §17.2). A
 * `run -d` labelled colloq.kind=class-kernel — room-spec.ts ·
 * machineRoomRunArgs, as the agent's kernel host lays it out — starts
 * tests/_fake-jupyter.mjs as a process on 127.0.0.1:0, working in the class
 * folder the run mounts at /workspace/<id> (read-only under the council's
 * `:ro`), with the run's JUPYTER_TOKEN: the container's Jupyter, and its port
 * the one `docker port … 8888/tcp` answers. It outlives the agent, as a
 * container does — an agent killed and started again finds it running and
 * adopts it — and ends with `rm` or `kill`, or once the test is gone. A class
 * container runs as long as its Jupyter does: one that dies under it reads
 * exited (137), and `start` gives it a fresh process (a fresh Python, the
 * folder kept). Every question the kernel host asks is answered from that
 * state: `inspect` and `ps` in docker's own --format (the part of Go's
 * templates the agent writes: fields, `index`, `json`, `range`, a ps row's
 * `.Label`; a field the object lacks, a function docker does not define and
 * what this fake does not read are refused, exit 1, as a filter other than by
 * label is), `ps` with and without `-a` by any labels, `stats`, `update`,
 * `exec` of the cgroup's script and of `rm -rf` in its own filesystem, `logs`,
 * `cp`, `port`, `start`, `rm`. Its kernels' exports of a council epoch go to
 * that filesystem's /tmp/colloq-epoch/<seq>, and a council container's
 * Jupyter loads epochs from its /colloq/epochs and runs attempts in its
 * /colloq/scratch (tests/_fake-jupyter.mjs · --epoch-dir, --epochs-dir,
 * --scratch-dir). Besides
 * them: the class bridge (`network create`, `inspect`, `ls` by label), the
 * perimeter's helper (`run --privileged … sh -c`, which says
 * `colloq-perimeter: ok`), the council scratch space's helper (its line done
 * as root would do it to the folder: emptied, 1733 — the owner stays this
 * process's — or listed), the admission canary (its checks read off its own
 * script, every one held, its folder round-tripped), and a card probe
 * (`--gpus`), answered as a daemon without cards answers it.
 *
 * KNOBS (knobs.json, read at every call; tests/_remote-e2e-agent.mts · dockerKnobs):
 *   perimeter       'ok' | 'fail' | 'no-iptables' | 'no-dockerd'   the helper's answer (default ok)
 *   canary          'ok' | 'fail'                                  every check held, or the metadata reached
 *   classRun        { failure: 'memory'|'cpu'|'gpu'|'other', times }   the next class runs fail so
 *   update          'ok' | 'refuse'                                docker keeps a class container's limits
 *   networkOverlap  true                                           a network asked with --subnet overlaps
 */
import fs from 'node:fs'
import path from 'node:path'
import { spawn, spawnSync } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { fileURLToPath } from 'node:url'

const STATE = process.env.FAKE_DOCKER_STATE
const REGISTRY = process.env.FAKE_DOCKER_REGISTRY
const GATES = process.env.FAKE_DOCKER_GATES
const OWNER = process.env.FAKE_DOCKER_OWNER
/** Where class containers' Jupyters write down their calls, when the test keeps them (FAKE_DOCKER_CALLS: a folder). */
const CALLS = process.env.FAKE_DOCKER_CALLS
const DIRECTIVE = /^\s*#\s*colloq-test:\s*(\{.*\})\s*$/m
const FAKE_JUPYTER = path.join(path.dirname(fileURLToPath(import.meta.url)), '_fake-jupyter.mjs')

// Every answer leaves through process.exit(), and a pipe write on macOS is asynchronous: blocking writes, or a 64 KB export arrives cut short (tests/_cli.mts says the same).
for (const stream of [process.stdout, process.stderr]) stream._handle?.setBlocking?.(true)

if (!STATE) {
  process.stderr.write('fake docker: FAKE_DOCKER_STATE is not set\n')
  process.exit(125)
}
/*
 * A machine's tree goes with the test (tests/_remote-e2e-agent.mts · createFleet), and a call its agent spawned a moment
 * before it was killed may still run after that: it finds no daemon, as on a machine that is gone, and leaves nothing behind.
 */
if (!fs.existsSync(STATE)) {
  process.stderr.write('fake docker: the daemon\'s state is gone (its machine with it)\n')
  process.exit(125)
}

const args = process.argv.slice(2)
const IMAGES = path.join(STATE, 'images')
const CONTAINERS = path.join(STATE, 'containers')
const NETWORKS = path.join(STATE, 'networks')
fs.mkdirSync(IMAGES, { recursive: true })
fs.mkdirSync(CONTAINERS, { recursive: true })
fs.mkdirSync(NETWORKS, { recursive: true })
fs.appendFileSync(path.join(STATE, 'calls.log'), `${JSON.stringify({ at: Date.now(), pid: process.pid, args })}\n`)

/** The class kernels' kind label (room-spec.ts · CLASS_KERNEL_LABEL) and the perimeter helper's (perimeter-core.ts · helperArgs). */
const CLASS_KIND = 'colloq.kind=class-kernel'
const PERIMETER_KIND = 'colloq.kind=room-perimeter'
/** The council scratch space's helper (runner-agent/council.ts · SCRATCH_HELPER_LABEL). */
const SCRATCH_KIND = 'colloq.kind=council-scratch'
/** The networks every daemon has. */
const BUILTIN_NETWORKS = new Set(['bridge', 'host', 'none', 'default'])
const MIB = 1024 * 1024
/** Docker's zero time, for a container that never started or never finished. */
const ZERO_TIME = '0001-01-01T00:00:00Z'

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

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const hex = (bytes) => randomBytes(bytes).toString('hex')

const imageFile = (name) => path.join(IMAGES, `${encodeURIComponent(name)}.json`)
const containerFile = (name) => path.join(CONTAINERS, `${encodeURIComponent(name)}.json`)
const logFile = (name) => path.join(CONTAINERS, `${encodeURIComponent(name)}.log`)
const oomFile = (name) => path.join(CONTAINERS, `${encodeURIComponent(name)}.oom`)
const privateRoot = (name) => path.join(CONTAINERS, `${encodeURIComponent(name)}.fs`)
const networkFile = (name) => path.join(NETWORKS, `${encodeURIComponent(name)}.json`)

/** How this daemon misbehaves now (the header's KNOBS). */
function knobs() {
  return readJson(path.join(STATE, 'knobs.json')) ?? {}
}

/** An image by a name it has, or by its id (`sha256:…`, as the perimeter's helper is run by). */
function image(ref) {
  const named = readJson(imageFile(ref))
  if (named) return named
  if (!/^(?:sha256:)?[a-f0-9]{12,64}$/.test(ref)) return null
  const id = ref.startsWith('sha256:') ? ref : `sha256:${ref}`
  for (const file of fs.readdirSync(IMAGES)) {
    if (!file.endsWith('.json')) continue
    const found = readJson(path.join(IMAGES, file))
    if (found && (found.id === id || found.id.startsWith(id))) return found
  }
  return null
}

/** A container by its name, its id or a prefix of its id (`ps` prints the short id). */
function container(ref) {
  const named = readJson(containerFile(ref.replace(/^\//, '')))
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

function network(name) {
  return readJson(networkFile(name))
}

function allNetworks() {
  return fs.readdirSync(NETWORKS).filter((file) => file.endsWith('.json')).map((file) => readJson(path.join(NETWORKS, file))).filter(Boolean)
}

/** A call docker would refuse, or this fake cannot read: it exits 1 with these words (the dispatch at the end). */
class Refused extends Error {}

/** A Go map in what docker formats (labels, options, ports): a key it lacks reads `<no value>`, where a struct's missing field is an error. */
const GO_MAP = Symbol('a Go map')
const goMap = (entries) => Object.defineProperty({ ...entries }, GO_MAP, { value: true })

/** `key=value` labels as docker's map. */
function labelMap(labels) {
  return goMap(Object.fromEntries(labels.map((label) => [label.slice(0, label.indexOf('=') < 0 ? label.length : label.indexOf('=')), label.indexOf('=') < 0 ? '' : label.slice(label.indexOf('=') + 1)])))
}

/** A `--filter label=…`: `key=value` names a value, `key` alone a label that is there. */
function hasLabel(labels, filter) {
  return filter.includes('=') ? labels.includes(filter) : labels.some((label) => label === filter || label.startsWith(`${filter}=`))
}

/** The kinds of `--filter` docker's `ps` and `network ls` take. */
const FILTER_KINDS = new Set(['ancestor', 'before', 'dangling', 'driver', 'expose', 'exited', 'health', 'id', 'isolation', 'is-task', 'label', 'name', 'network', 'publish', 'scope', 'since', 'status', 'type', 'volume'])

/**
 * The label filters of a `ps` or `network ls`, the only kind the agent asks
 * for. Any other is refused, as run refuses a flag it does not know: a filter
 * docker has, by name (this fake would list everything for it), one docker
 * has not, in docker's words.
 */
function labelFilters(list) {
  const found = []
  for (let i = 0; i < list.length; i++) {
    const filter = list[i] === '--filter' ? list[++i] ?? '' : list[i]?.startsWith('--filter=') ? list[i].slice('--filter='.length) : null
    if (filter === null) continue
    if (filter.startsWith('label=')) {
      found.push(filter.slice('label='.length))
      continue
    }
    const kind = filter.split('=')[0]
    throw new Refused(FILTER_KINDS.has(kind) ? `fake docker: --filter ${filter} is not in this fake` : `Error response from daemon: invalid filter '${kind}'`)
  }
  return found
}

/** `--format X` or `--format=X` (`-f X` too) of a command; null — none. */
function formatOf(list) {
  for (let i = 0; i < list.length; i++) {
    if (list[i] === '--format' || list[i] === '-f') return list[i + 1] ?? null
    if (list[i]?.startsWith('--format=')) return list[i].slice('--format='.length)
  }
  return null
}

/** Megabytes in docker's memory language: `512m`, `2g`, `1048576` (bytes). */
function megabytes(text) {
  const match = /^(\d+(?:\.\d+)?)([bkmg]?)$/i.exec(String(text ?? '').trim())
  if (!match) return 0
  const value = Number(match[1])
  const unit = match[2].toLowerCase()
  return Math.round(unit === 'g' ? value * 1024 : unit === 'm' ? value : unit === 'k' ? value / 1024 : value / MIB)
}

const isoOf = (ms) => (Number.isFinite(ms) && ms > 0 ? new Date(ms).toISOString() : ZERO_TIME)

/* ------------------------------------------------------- docker's --format */

/*
 * The part of Go's text/template that the agent's and the runner's formats
 * use: `{{.Field.Path}}`, `{{index .Config.Labels "key"}}`, `{{json .X}}`, a
 * ps row's `{{.Label "key"}}`, and `{{range .List}}…{{end}}`, with the text
 * between them as it is. Read the way docker reads it, so that a format the
 * agent changes is answered as docker would answer it, not matched against a
 * copy of the old string — and refused as docker refuses it: a field the
 * object lacks (in docker's words for its inspect, which falls back to the
 * raw JSON with missingkey=error, and for its rows), a function neither Go
 * nor docker defines (when the format is parsed, before anything runs). What
 * docker reads and this fake does not (its other functions, `if`, `with`,
 * variables, pipes) is refused by name, as run refuses a flag it does not
 * know, so a format the agent starts writing shows here first.
 */

/** The functions Go's templates and docker's (cli/templates) define. */
const TEMPLATE_FUNCTIONS = new Set([
  'and', 'call', 'eq', 'ge', 'gt', 'html', 'index', 'js', 'le', 'len', 'lt', 'ne', 'not', 'or', 'print', 'printf', 'println', 'slice', 'urlquery',
  'json', 'join', 'lower', 'pad', 'split', 'title', 'truncate', 'upper',
])
const TEMPLATE_KEYWORDS = new Set(['if', 'else', 'with', 'define', 'template', 'block', 'break', 'continue', 'nil'])

function tokenize(format) {
  const tokens = []
  let at = 0
  for (const match of format.matchAll(/\{\{-?\s*([\s\S]*?)\s*-?\}\}/g)) {
    if (match.index > at) tokens.push({ text: format.slice(at, match.index) })
    tokens.push({ action: match[1] })
    at = match.index + match[0].length
  }
  if (at < format.length) tokens.push({ text: format.slice(at) })
  return tokens
}

/** An action's words, each a string, a field or a function's name; a pipe, a variable, a comment or a parenthesis this fake does not read. */
function words(action) {
  if (/^\/\*|[|()$]/.test(action.replace(/"(?:[^"\\]|\\.)*"/g, '""'))) throw new Refused(`fake docker: {{${action}}} is not in this fake`)
  return [...action.matchAll(/"((?:[^"\\]|\\.)*)"|(\S+)/g)].map((match) => (match[1] !== undefined ? { string: JSON.parse(`"${match[1]}"`) } : { word: match[2] }))
}

/**
 * A format read whole before any of it runs, as Go parses a template: its
 * tokens, or a refusal (a function unknown, one this fake has not, a
 * construct it does not do, a range without its end). `inspect` says it as
 * docker's inspect says a template's error.
 */
function parse(format, inspect) {
  const say = (text) => new Refused(inspect ? `template parsing error: ${text}` : text)
  const tokens = tokenize(format)
  let depth = 0
  for (const token of tokens) {
    if (token.text !== undefined) continue
    if (token.action === 'end') {
      if (--depth < 0) throw say('template: :1: unexpected {{end}}')
      continue
    }
    const range = /^range\s+(.+)$/.exec(token.action)
    if (range) depth++
    const [first, ...rest] = words(range ? range[1] : token.action)
    if (!first) throw say(`template: :1: missing value for command`)
    const named = first.word !== undefined && !first.word.startsWith('.')
    if (named && first.word !== 'json' && first.word !== 'index') {
      if (TEMPLATE_KEYWORDS.has(first.word)) throw new Refused(`fake docker: {{${token.action}}} is not in this fake`)
      if (TEMPLATE_FUNCTIONS.has(first.word)) throw new Refused(`fake docker: the template function "${first.word}" is not in this fake`)
      throw say(`template: :1: function "${first.word}" not defined`)
    }
    for (const part of rest) if (part.word !== undefined && !part.word.startsWith('.')) throw new Refused(`fake docker: {{${token.action}}} is not in this fake`)
  }
  if (depth > 0) throw say('template: :1: unexpected EOF')
  return tokens
}

/**
 * A field of what is formatted. A struct's field it lacks is docker's error:
 * an inspect's (`type` null) read off the raw JSON with missingkey=error, a
 * row's off its Go type. A map's missing key is no error.
 */
function field(dot, at, type) {
  if (at === '.') return dot
  let value = dot
  for (const name of at.split('.').slice(1)) {
    if (value !== null && typeof value === 'object' && value[GO_MAP]) {
      value = value[name]
      if (value === undefined) return undefined
      continue
    }
    if (value === null || typeof value !== 'object' || !Object.hasOwn(value, name)) {
      throw new Refused(type === null
        ? `template parsing error: template: :1: executing "" at <${at}>: map has no entry for key "${name}"`
        : `template: :1: executing "" at <${at}>: can't evaluate field ${name} in type ${type}`)
    }
    value = value[name]
  }
  return value
}

function evaluate(parts, dot, type) {
  const [first, ...rest] = parts
  if (!first) return undefined
  if (first.string !== undefined) return first.string
  if (first.word === 'json') return JSON.stringify(evaluate(rest, dot, type) ?? null)
  if (first.word === 'index') {
    const map = evaluate(rest.slice(0, 1), dot, type)
    const key = evaluate(rest.slice(1, 2), dot, type)
    // Go's index of a map key that is not there: the zero value, an empty string.
    return map && typeof map === 'object' ? (map[key] ?? '') : ''
  }
  const found = field(dot, first.word, type)
  if (typeof found !== 'function') return found
  if (found.length !== rest.length) throw new Refused(`template: :1: executing "" at <${first.word}>: wrong number of args for ${first.word.slice(1)}: want ${found.length} got ${rest.length}`)
  return found(...rest.map((part) => evaluate([part], dot, type)))
}

function show(value) {
  if (value === undefined) return '<no value>'
  if (value === null) return '<nil>'
  if (typeof value === 'object') return JSON.stringify(value)
  return String(value)
}

/** What a range goes over: a list, a map's values by their sorted keys, nothing for nil; anything else docker refuses. */
function rangeOf(value) {
  if (value === null || value === undefined) return []
  if (Array.isArray(value)) return value
  if (typeof value === 'object' && value[GO_MAP]) return Object.keys(value).sort().map((key) => value[key])
  throw new Refused(`template: :1: range can't iterate over ${show(value)}`)
}

/**
 * One object formatted by a parsed format (parse). `type`: the Go type of a
 * row docker formats (`ps`, `stats`), named in its errors; null for an
 * inspect's object.
 */
function render(tokens, root, type = null) {
  let at = 0
  const run = (dot, live) => {
    let out = ''
    while (at < tokens.length) {
      const token = tokens[at++]
      if (token.text !== undefined) {
        if (live) out += token.text
        continue
      }
      if (token.action === 'end') return out
      const range = /^range\s+(.+)$/.exec(token.action)
      if (range) {
        const items = live ? rangeOf(evaluate(words(range[1]), dot, type)) : []
        const start = at
        if (items.length === 0) {
          run(dot, false)
          continue
        }
        for (const item of items) {
          at = start
          out += run(item, true)
        }
        continue
      }
      if (live) out += show(evaluate(words(token.action), dot, type))
    }
    return out
  }
  return run(root, true)
}

/** The Go types of the rows docker formats, as its errors name them. */
const PS_ROW = '*formatter.ContainerContext'
const STATS_ROW = '*formatter.statsContext'

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

/* -------------------------------------------------- the class containers */

/** A process's command line, by its pid; null — no such process, or none this process may read. */
function commandLine(pid) {
  try {
    return fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').replaceAll('\0', ' ')
  } catch { /* no /proc: macOS */ }
  const asked = spawnSync('ps', ['-ww', '-o', 'command=', '-p', String(pid)], { encoding: 'utf8' })
  return asked.status === 0 ? asked.stdout : null
}

const owned = new Map()

/**
 * Whether a class container's Jupyter runs: its pid is alive and is that
 * container's process by its command line, never another that took the pid
 * over since (pids come round).
 */
function jupyterRuns(c) {
  if (!Number.isSafeInteger(c.pid) || c.pid <= 0) return false
  const key = `${c.pid}:${c.id}`
  if (!owned.has(key)) {
    let alive = true
    try {
      process.kill(c.pid, 0)
    } catch (error) {
      alive = error.code === 'EPERM'
    }
    owned.set(key, alive && (commandLine(c.pid) ?? '').includes(`--container-id ${c.id}`))
  }
  return owned.get(key)
}

/** A class container runs while its Jupyter does: one that died under it is exited, as a container whose main process ended is. */
function classState(c) {
  if (c.status !== 'running') return { running: false, status: c.status, exit: c.exitCode ?? 0, oom: c.oomKilled === true }
  if (jupyterRuns(c)) return { running: true, status: 'running', exit: 0, oom: false }
  return { running: false, status: 'exited', exit: 137, oom: c.oomKilled === true }
}

/** Any container's state: a class container's, a seeded one's (the agent's own), a submission's. */
function stateOf(c) {
  if (c.kind === 'class') return classState(c)
  if (c.kind === 'seed') return { running: c.status === 'running', status: c.status ?? 'running', exit: c.exitCode ?? 0, oom: false }
  return containerState(c)
}

/** A class container's Jupyter, stopped as its container is: SIGKILL, and gone before the answer. */
async function stopJupyter(c) {
  if (!jupyterRuns(c)) return
  try {
    process.kill(c.pid, 'SIGKILL')
  } catch { /* gone meanwhile */ }
  for (let i = 0; i < 100; i++) {
    try {
      process.kill(c.pid, 0)
    } catch {
      return
    }
    await sleep(20)
  }
}

/** The cgroup's kill counter: the kernels the OOM killer took, as the fake Jupyter counts them. */
function oomKills(c) {
  try {
    return fs.readFileSync(oomFile(c.name), 'utf8').split('\n').filter(Boolean).length
  } catch {
    return 0
  }
}

/**
 * A class container's Jupyter started: the fake as a process of its own, its
 * output the container's log, its port the first line it prints. The state
 * names its pid before it is asked anything (the process's own watch waits
 * for that), and its port once it said it. A string — why it did not start.
 */
async function startJupyter(c) {
  const file = containerFile(c.name)
  const log = logFile(c.name)
  const offset = fs.existsSync(log) ? fs.statSync(log).size : 0
  const argv = [FAKE_JUPYTER, '--port', '0', '--cwd', c.folder, '--container-file', file, '--container-id', c.id, '--oom-file', oomFile(c.name)]
  if (c.token) argv.push('--token', c.token)
  if (c.readOnly) argv.push('--read-only')
  // Its kernels' exports go to the container's own /tmp (COUNCIL_EPOCH_DIR), which `cp` copies out and `exec … rm` removes.
  argv.push('--epoch-dir', path.join(privateRoot(c.name), 'tmp', 'colloq-epoch'))
  // A council container's two folders of its own (council.ts · councilMounts): its workers load epochs from the one, attempts work in the other.
  const epochs = (c.mounts ?? []).find((mount) => mount.target === '/colloq/epochs')
  const scratch = (c.mounts ?? []).find((mount) => mount.target === '/colloq/scratch')
  if (epochs) argv.push('--epochs-dir', epochs.source)
  if (scratch) argv.push('--scratch-dir', scratch.source)
  if (OWNER) argv.push('--owner', OWNER)
  // Its calls written down where `rm` leaves them (FAKE_DOCKER_CALLS, the agent's keepCalls): one file per container, every life of it.
  if (CALLS) {
    fs.mkdirSync(CALLS, { recursive: true })
    argv.push('--calls-file', path.join(CALLS, `${c.id}.jsonl`))
  }
  const out = fs.openSync(log, 'a')
  let child
  try {
    child = spawn(process.execPath, argv, { detached: true, stdio: ['ignore', out, out] })
  } finally {
    fs.closeSync(out)
  }
  if (!child.pid) return 'the container\'s Jupyter could not be started'
  child.unref()
  const running = { ...c, status: 'running', pid: child.pid, port: null, startedAt: Date.now(), finishedAt: null, exitCode: 0, oomKilled: false }
  writeJson(file, running)
  for (let waited = 0; waited < 20_000; waited += 20) {
    let text = ''
    try {
      text = fs.readFileSync(log, 'utf8').slice(offset)
    } catch { /* not written yet */ }
    const line = /^(\d{1,5})\n/.exec(text)
    if (line) {
      const started = { ...running, port: Number(line[1]) }
      writeJson(file, started)
      return started
    }
    if (child.exitCode !== null || child.signalCode !== null) break
    await sleep(20)
  }
  try {
    process.kill(child.pid, 'SIGKILL')
  } catch { /* gone */ }
  writeJson(file, { ...running, status: 'exited', exitCode: 1, finishedAt: Date.now(), pid: null })
  let said = ''
  try {
    said = fs.readFileSync(log, 'utf8').slice(offset).trim().split('\n').slice(-1)[0] ?? ''
  } catch { /* nothing */ }
  return `the container's Jupyter did not start${said ? `: ${said}` : ''}`
}

/** What `docker inspect` says of a container: the fields the agent's and the runner's formats read. */
function inspectObject(c) {
  const state = stateOf(c)
  const labels = labelMap(c.labels ?? [])
  const known = c.image ? image(c.image) : null
  const mounts = c.kind === 'class'
    ? c.mounts.map((mount) => ({ Type: 'bind', Source: mount.source, Destination: mount.target, RW: !mount.readOnly }))
    : Object.entries(c.mounts ?? {}).map(([inside, host]) => ({ Type: 'bind', Source: host, Destination: inside }))
  const ports = goMap(c.kind === 'class' && state.running && c.port ? { '8888/tcp': [{ HostIp: '127.0.0.1', HostPort: String(c.port) }] } : {})
  return {
    Id: c.id,
    Name: `/${c.name}`,
    Image: c.imageId ?? known?.id ?? '',
    State: {
      Status: state.status, Running: state.running, Paused: false, Restarting: false, OOMKilled: state.oom, Dead: false,
      Pid: state.running ? c.pid ?? 0 : 0, ExitCode: state.exit,
      StartedAt: isoOf(c.startedAt), FinishedAt: state.running ? ZERO_TIME : isoOf(c.finishedAt ?? 0),
    },
    HostConfig: {
      Memory: (c.memoryMb ?? 0) * MIB, MemorySwap: (c.memoryMb ?? 0) * MIB, NanoCpus: Math.round((c.cpus ?? 0) * 1e9),
      NetworkMode: c.network ?? 'bridge',
    },
    Config: { Image: c.image ?? '', Labels: labels, Env: Object.entries(c.env ?? {}).map(([key, value]) => `${key}=${value}`) },
    Mounts: mounts,
    NetworkSettings: { Ports: ports },
  }
}

/** A container as `ps` lists it. */
function psRow(c, full) {
  const state = stateOf(c)
  const labels = labelMap(c.labels ?? [])
  return {
    ID: full ? c.id : c.id.slice(0, 12),
    Names: c.name,
    Image: c.image ?? '',
    State: state.status,
    Status: state.running ? 'Up' : `Exited (${state.exit})`,
    Labels: (c.labels ?? []).join(','),
    Label: (key) => labels[key] ?? '',
  }
}

/** A class container as `stats --no-stream` reads it: what the test set (`stats` in its state), or an idle kernel's. */
function statsRow(c) {
  const state = stateOf(c)
  const used = c.stats?.usedMb ?? 120
  const cpu = c.stats?.cpuPercent ?? 0.3
  return {
    Name: c.name,
    ID: c.id.slice(0, 12),
    Container: c.name,
    MemUsage: state.running ? `${used}MiB / ${c.memoryMb ?? 0}MiB` : '0B / 0B',
    CPUPerc: state.running ? `${cpu.toFixed(2)}%` : '0.00%',
    MemPerc: state.running && c.memoryMb ? `${((used / c.memoryMb) * 100).toFixed(2)}%` : '0.00%',
    NetIO: '0B / 0B',
    BlockIO: '0B / 0B',
    PIDs: state.running ? '12' : '0',
  }
}

/* ------------------------------------------------------------ run's flags */

/** `docker run`'s flags that take a value, as the agent, the runner and the class argv use them. */
const RUN_VALUED = new Set([
  '--name', '--network', '--net', '-p', '--publish', '--label', '-l', '-e', '--env', '-v', '--volume', '--gpus', '--entrypoint',
  '--user', '-u', '--memory', '-m', '--memory-swap', '--cpus', '--pids-limit', '--sysctl', '--dns', '--shm-size', '--restart',
  '--security-opt', '--cap-drop', '--cap-add', '--log-driver', '--log-opt', '--tmpfs', '--workdir', '-w', '--mount', '--pull',
  '--hostname', '--add-host', '--ulimit', '--device', '--pid', '--ipc', '--platform', '--stop-timeout', '--oom-score-adj',
])
const RUN_SWITCHES = new Set(['-d', '--detach', '--rm', '--privileged', '--read-only', '--init', '-i', '-t', '-it', '--interactive', '--tty', '--no-healthcheck'])

/**
 * `docker run [OPTIONS] IMAGE [COMMAND…]`, read: a flag's value inline
 * (`--memory=2048m`) or as the next argument, the image the first argument
 * that is no flag. A flag this fake does not know is refused by name, so a
 * new one in the agent's argv shows here rather than as a misread image.
 */
function runSpec(list) {
  const spec = { name: null, network: null, publish: [], labels: [], env: {}, volumes: [], gpus: null, entrypoint: null, memoryMb: 0, cpus: 0, pids: null, detach: false, rm: false, image: null, command: [] }
  for (let i = 0; i < list.length; i++) {
    const arg = list[i]
    if (!arg.startsWith('-')) {
      spec.image = arg
      spec.command = list.slice(i + 1)
      return spec
    }
    const eq = arg.startsWith('--') ? arg.indexOf('=') : -1
    const flag = eq > 0 ? arg.slice(0, eq) : arg
    if (RUN_SWITCHES.has(flag)) {
      if (flag === '-d' || flag === '--detach') spec.detach = true
      if (flag === '--rm') spec.rm = true
      continue
    }
    if (!RUN_VALUED.has(flag)) return `unknown flag: ${arg} (not in this fake)`
    const value = eq > 0 ? arg.slice(eq + 1) : list[++i]
    if (value === undefined) return `flag needs an argument: ${flag}`
    if (flag === '--name') spec.name = value
    else if (flag === '--network' || flag === '--net') spec.network = value
    else if (flag === '-p' || flag === '--publish') spec.publish.push(value)
    else if (flag === '--label' || flag === '-l') spec.labels.push(value)
    else if (flag === '-e' || flag === '--env') spec.env[value.slice(0, value.indexOf('=') < 0 ? value.length : value.indexOf('='))] = value.indexOf('=') < 0 ? '' : value.slice(value.indexOf('=') + 1)
    else if (flag === '-v' || flag === '--volume') {
      const [source, target, mode = ''] = value.split(':')
      spec.volumes.push({ source, target, readOnly: mode.split(',').includes('ro') })
    } else if (flag === '--gpus') spec.gpus = value
    else if (flag === '--entrypoint') spec.entrypoint = value
    else if (flag === '--memory' || flag === '-m') spec.memoryMb = megabytes(value)
    else if (flag === '--cpus') spec.cpus = Number(value)
    else if (flag === '--pids-limit') spec.pids = Number(value)
  }
  return 'docker run needs an image'
}

/* ---------------------------------------------------------------- commands */

function info() {
  finish(0, JSON.stringify({
    ServerVersion: '28.3.1', Driver: 'overlay2', Name: process.env.FAKE_DOCKER_HOST ?? 'fake-docker-host', NCPU: 12,
    MemTotal: 32 * 1024 ** 3, OSType: 'linux', Architecture: 'x86_64', DockerRootDir: STATE,
  }))
}

/** `ps`: the running containers, or every one with `-a`, that have every label asked; short ids unless `--no-trunc`. */
function ps() {
  const list = args.slice(1)
  const all = list.some((arg) => arg === '--all' || /^-[a-z]*a[a-z]*$/.test(arg))
  const quiet = list.some((arg) => arg === '--quiet' || /^-[a-z]*q[a-z]*$/.test(arg))
  const full = list.includes('--no-trunc')
  const labels = labelFilters(list)
  const format = formatOf(list)
  const tokens = format && !quiet ? parse(format, false) : null
  const found = allContainers().filter((c) => (all || stateOf(c).running) && labels.every((label) => hasLabel(c.labels ?? [], label)))
  const lines = found.map((c) => (tokens ? render(tokens, psRow(c, full), PS_ROW) : psRow(c, full).ID))
  finish(0, lines.join('\n'))
}

function imageCommand() {
  const [, sub] = args
  const list = args.slice(2)
  const format = formatOf(list)
  const names = list.filter((arg, i) => !arg.startsWith('-') && list[i - 1] !== '--format' && list[i - 1] !== '-f')
  if (sub !== 'inspect' || names.length === 0) return finish(1, '', `fake docker: image ${sub ?? ''} is not in this fake`)
  const name = names[0]
  const tokens = format ? parse(format, true) : null
  const found = image(name)
  if (!found) return finish(1, '', `Error response from daemon: No such image: ${name}`)
  const object = {
    Id: found.id, RepoTags: found.tags ?? [], RepoDigests: found.repoDigests ?? [],
    Os: 'linux', Architecture: 'amd64', RootFS: { Type: 'layers', Layers: found.diffIds },
  }
  finish(0, tokens ? render(tokens, object) : JSON.stringify([object]))
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

async function run() {
  if (args.includes('/harness/run_notebook.py')) return sandboxRun()
  const spec = runSpec(args.slice(1))
  if (typeof spec === 'string') return finish(125, '', `docker: ${spec}`)
  if (spec.labels.includes(CLASS_KIND)) return classRun(spec)
  if (spec.labels.includes(PERIMETER_KIND)) return perimeterRun(spec)
  if (spec.labels.includes(SCRATCH_KIND)) return scratchRun(spec)
  if (spec.name?.startsWith('colloq-runner-canary-')) return canaryRun(spec)
  // The card probe and the GPU smoke test, on a daemon with no card: what docker says there.
  if (spec.gpus !== null) return finish(125, '', 'docker: Error response from daemon: could not select device driver "" with capabilities: [[gpu]].')
  finish(125, '', `docker: fake docker runs only submission, class, perimeter and canary containers: ${args.join(' ')}`)
}

/** A submission's container, from the directive in its notebook (see the header). */
function sandboxRun() {
  const at = (flag) => {
    const index = args.indexOf(flag)
    return index >= 0 ? args[index + 1] : undefined
  }
  const name = at('--name')
  const entry = args.indexOf('--entrypoint')
  if (!name || entry < 0) return finish(125, '', `docker: fake docker runs only submission containers: ${args.join(' ')}`)
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
    id: hex(32), name, image: imageName, labels, mounts, env,
    attemptId: env.COMP_ATTEMPT_ID ?? name, wallSeconds: Number(env.COMP_WALL_SECONDS ?? 0),
    directive: directiveOf(notebook), cells: codeCellsOf(notebook), startedAt: Date.now(), killed: false, killedAt: null,
  }
  writeJson(containerFile(name), made)
  finish(0, made.id)
}

/** What a class container's start fails with when the knob says so (startFailureOf in kernels.ts reads these words). */
const CLASS_RUN_FAILURES = {
  memory: 'docker: Error response from daemon: failed to create task for container: cannot allocate memory: unknown.',
  cpu: 'docker: Error response from daemon: Range of CPUs is from 0.01 to 2.00, as there are only 2 CPUs available.',
  gpu: 'docker: Error response from daemon: could not select device driver "nvidia" with capabilities: [[gpu]].',
  other: 'docker: Error response from daemon: OCI runtime create failed: the fake daemon was told to fail: unknown.',
}

/** A class container (see the header): its Jupyter a fake of its own, in the folder the run mounts at /workspace/<id>. */
async function classRun(spec) {
  if (!spec.detach || !spec.name) return finish(125, '', 'docker: fake docker runs a class container detached (-d) and named only')
  const known = image(spec.image)
  // `--pull=never`: an image not here is not fetched.
  if (!known) return finish(125, '', `docker: Error response from daemon: No such image: ${spec.image}.`)
  if (spec.network && !BUILTIN_NETWORKS.has(spec.network) && !network(spec.network)) return finish(125, '', `docker: Error response from daemon: network ${spec.network} not found.`)
  const taken = container(spec.name)
  if (taken) return finish(125, '', `docker: Error response from daemon: Conflict. The container name "/${spec.name}" is already in use by container "${taken.id}". You have to remove (or rename) that container to be able to reuse that name.`)
  const asked = knobs()
  if (asked.classRun && asked.classRun.times > 0) {
    writeJson(path.join(STATE, 'knobs.json'), { ...asked, classRun: { ...asked.classRun, times: asked.classRun.times - 1 } })
    return finish(125, '', CLASS_RUN_FAILURES[asked.classRun.failure] ?? CLASS_RUN_FAILURES.other)
  }
  const session = labelMap(spec.labels)['colloq.session'] ?? ''
  const folder = spec.volumes.find((mount) => mount.target === `/workspace/${session}`)
  if (!folder) return finish(125, '', `docker: fake docker: a class container mounts its class folder at /workspace/${session}`)
  // A bind mount's missing source is made, as docker makes it.
  fs.mkdirSync(folder.source, { recursive: true })
  const made = {
    kind: 'class', id: hex(32), name: spec.name, image: spec.image, imageId: known.id, labels: spec.labels, env: spec.env,
    mounts: spec.volumes, network: spec.network ?? 'bridge', publish: spec.publish, memoryMb: spec.memoryMb, cpus: spec.cpus, gpus: spec.gpus, pids: spec.pids,
    token: spec.env.JUPYTER_TOKEN ?? '', folder: folder.source, readOnly: folder.readOnly,
    createdAt: Date.now(), status: 'created', pid: null, port: null, startedAt: null, finishedAt: null, exitCode: 0, oomKilled: false, restarts: 0,
  }
  writeJson(containerFile(made.name), made)
  const started = await startJupyter(made)
  if (typeof started === 'string') {
    fs.rmSync(containerFile(made.name), { force: true })
    return finish(125, '', `docker: Error response from daemon: ${started}`)
  }
  finish(0, made.id)
}

/** The perimeter's helper (perimeter-core.ts · helperArgs): the agent's own image, its script's verdict from the knob. */
function perimeterRun(spec) {
  if (!image(spec.image)) return finish(125, '', `docker: Error response from daemon: No such image: ${spec.image}.`)
  const said = knobs().perimeter ?? 'ok'
  if (said === 'no-dockerd') return finish(20, 'colloq-perimeter: no dockerd process to enter')
  if (said === 'no-iptables') return finish(21, 'colloq-perimeter: no iptables in the host\'s namespace')
  if (said === 'fail') return finish(1, 'iptables: No chain/target/match by that name.\ncolloq-perimeter: failed')
  finish(0, 'colloq-perimeter: ok')
}

/**
 * The council scratch space's helper (runner-agent/council.ts ·
 * scratchHelperArgs): its one line done to the folder mounted at /s, as root
 * would — every entry removed, the mode 1733 (no chown here: the owner stays
 * this process's), or the entries listed — and its word said.
 */
function scratchRun(spec) {
  if (!image(spec.image)) return finish(125, '', `docker: Error response from daemon: No such image: ${spec.image}.`)
  const folder = spec.volumes.find((mount) => mount.target === '/s')?.source
  if (!folder) return finish(125, '', 'docker: fake docker: the scratch helper mounts its folder at /s')
  const script = spec.command[spec.command.indexOf('-c') + 1] ?? ''
  fs.mkdirSync(folder, { recursive: true })
  const mode = fs.statSync(folder).mode & 0o7777
  fs.chmodSync(folder, mode | 0o700)
  let listed = ''
  try {
    const names = fs.readdirSync(folder)
    if (/-exec rm -rf/.test(script)) for (const name of names) fs.rmSync(path.join(folder, name), { recursive: true, force: true })
    if (/-print0/.test(script)) listed = `${names.map((name) => `/s/${name}\0`).join('')}\n`
  } finally {
    fs.chmodSync(folder, /chmod 1733/.test(script) ? 0o1733 : mode)
  }
  finish(0, `${listed}colloq-scratch: ok`)
}

/**
 * The admission canary (kernels.ts · canaryScript), as a sandbox that holds
 * answers it: every check its script names (`r["…"] =`), true — the seed read
 * back from its folder and written there again — unless the knob says the
 * metadata service was reached.
 */
function canaryRun(spec) {
  if (!image(spec.image)) return finish(125, '', `docker: Error response from daemon: No such image: ${spec.image}.`)
  if (spec.network && !BUILTIN_NETWORKS.has(spec.network) && !network(spec.network)) return finish(125, '', `docker: Error response from daemon: network ${spec.network} not found.`)
  const script = spec.command[spec.command.indexOf('-c') + 1] ?? ''
  const checks = [...new Set([...script.matchAll(/r\["(\w+)"\]\s*=/g)].map((match) => match[1]))]
  const folder = spec.volumes.find((mount) => mount.target === '/workspace/canary')?.source
  let seed = null
  try {
    seed = fs.readFileSync(path.join(folder, 'seed'), 'utf8')
    fs.writeFileSync(path.join(folder, 'canary'), seed)
  } catch { /* no folder: the checks say so */ }
  const verdict = Object.fromEntries(checks.map((check) => [check, true]))
  if ('folderRead' in verdict) verdict.folderRead = seed !== null
  if ('folderWritten' in verdict) verdict.folderWritten = seed !== null
  if (knobs().canary === 'fail' && 'metadataRefused' in verdict) verdict.metadataRefused = false
  finish(0, `colloq-canary: ${JSON.stringify(verdict)}`)
}

/** `start`: a class container's fresh process (a fresh Python, its folder and packages kept); one running already is left as it is. */
async function start() {
  const refs = args.slice(1).filter((arg) => !arg.startsWith('-'))
  const started = []
  const errors = []
  for (const ref of refs) {
    const c = container(ref)
    if (!c) {
      errors.push(`Error response from daemon: No such container: ${ref}`)
      continue
    }
    if (c.kind !== 'class') {
      errors.push(`Error response from daemon: fake docker starts only class containers again: ${ref}`)
      continue
    }
    if (stateOf(c).running) {
      started.push(ref)
      continue
    }
    const fresh = await startJupyter({ ...c, restarts: (c.restarts ?? 0) + 1 })
    if (typeof fresh === 'string') errors.push(`Error response from daemon: ${fresh}`)
    else started.push(ref)
  }
  if (errors.length > 0) return finish(1, started.join('\n'), [...errors, `Error: failed to start containers: ${refs.filter((ref) => !started.includes(ref)).join(', ')}`].join('\n'))
  finish(0, started.join('\n'))
}

function inspect() {
  const list = args.slice(1)
  const format = formatOf(list)
  let type = null
  const refs = []
  for (let i = 0; i < list.length; i++) {
    const arg = list[i]
    if (arg === '--format' || arg === '-f' || arg === '--type') {
      if (arg === '--type') type = list[i + 1]
      i++
    } else if (arg.startsWith('--type=')) type = arg.slice('--type='.length)
    else if (!arg.startsWith('-')) refs.push(arg)
  }
  const tokens = format ? parse(format, true) : null
  const lines = []
  const objects = []
  const errors = []
  for (const ref of refs) {
    const c = type === 'image' ? null : container(ref)
    if (!c) {
      errors.push(type === 'container' ? `Error: No such container: ${ref}` : `Error: No such object: ${ref}`)
      continue
    }
    const object = inspectObject(c)
    if (tokens) lines.push(render(tokens, object))
    else objects.push(object)
  }
  const out = tokens ? lines.join('\n') : objects.length > 0 ? JSON.stringify(objects, null, 4) : '[]'
  finish(errors.length > 0 ? 1 : 0, out, errors.join('\n'))
}

/** `port <c> [8888/tcp]`: where a class container's Jupyter is published on the host's loopback. */
function port() {
  const ref = args[1]
  const c = ref ? container(ref) : null
  if (!c) return finish(1, '', `Error response from daemon: No such container: ${ref ?? ''}`)
  const wanted = args[2] ?? null
  const published = c.kind === 'class' && stateOf(c).running && c.port && (c.publish ?? []).some((spec) => /^127\.0\.0\.1:0:8888(?:\/tcp)?$/.test(spec))
  if (!published || (wanted !== null && wanted !== '8888/tcp' && wanted !== '8888')) {
    return finish(1, '', `Error: No public port '${wanted ?? '8888/tcp'}' published for ${c.id}`)
  }
  finish(0, wanted === null ? `8888/tcp -> 127.0.0.1:${c.port}` : `127.0.0.1:${c.port}`)
}

/** `stats --no-stream [--format F] <names…>`: what the census reads of memory and CPU. */
function stats() {
  const list = args.slice(1)
  const format = formatOf(list)
  const refs = list.filter((arg, i) => !arg.startsWith('-') && list[i - 1] !== '--format')
  const tokens = parse(format ?? '{{.Name}}\t{{.CPUPerc}}\t{{.MemUsage}}', false)
  const lines = []
  const errors = []
  for (const ref of refs) {
    const c = container(ref)
    if (!c) errors.push(`Error response from daemon: No such container: ${ref}`)
    else lines.push(render(tokens, statsRow(c), STATS_ROW))
  }
  finish(errors.length > 0 ? 1 : 0, lines.join('\n'), errors.join('\n'))
}

/** `update`: a class container's memory and CPUs live, as `docker update` sets a cgroup's; anything else, as before, done. */
function update() {
  const list = args.slice(1)
  let memory = null
  let cpus = null
  const refs = []
  for (let i = 0; i < list.length; i++) {
    const arg = list[i]
    const eq = arg.indexOf('=')
    const flag = arg.startsWith('--') && eq > 0 ? arg.slice(0, eq) : arg
    const valued = ['--memory', '-m', '--memory-swap', '--cpus', '--restart', '--pids-limit']
    if (valued.includes(flag)) {
      const value = arg.startsWith('--') && eq > 0 ? arg.slice(eq + 1) : list[++i]
      if (flag === '--memory' || flag === '-m') memory = megabytes(value)
      if (flag === '--cpus') cpus = Number(value)
    } else if (!arg.startsWith('-')) refs.push(arg)
  }
  const done = []
  const errors = []
  for (const ref of refs) {
    const c = container(ref)
    if (!c) {
      // A class container that is gone says so, as docker does; the agent's own container and the runs had this fake's silent yes.
      if (ref.startsWith('colloq-class-') || /^[a-f0-9]{64}$/.test(ref)) errors.push(`Error response from daemon: No such container: ${ref}`)
      else done.push(ref)
      continue
    }
    if (c.kind !== 'class') {
      done.push(ref)
      continue
    }
    if (knobs().update === 'refuse') {
      errors.push(`Error response from daemon: Cannot update container ${c.id}: Memory limit should not be smaller than the memory in use`)
      continue
    }
    writeJson(containerFile(c.name), { ...c, memoryMb: memory ?? c.memoryMb, cpus: cpus ?? c.cpus })
    done.push(ref)
  }
  finish(errors.length > 0 ? 1 : 0, done.join('\n'), errors.join('\n'))
}

function exec() {
  let i = 1
  // exec's own flags before the container: --user X, -u X, -e X, -w X, -i, -t.
  while (i < args.length && args[i].startsWith('-')) {
    if (['--user', '-u', '-e', '--env', '-w', '--workdir'].includes(args[i])) i += 2
    else i += 1
  }
  const ref = args[i]
  const c = ref ? container(ref) : null
  if (!c) return finish(1, '', `Error response from daemon: No such container: ${ref ?? ''}`)
  if (!stateOf(c).running) return finish(1, '', `Error response from daemon: container ${c.id} is not running`)
  const command = args.slice(i + 1)
  if (c.kind === 'class') return classExec(c, command)
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

/**
 * An exec in a class container: the cgroup's script (postmortem-core.ts ·
 * CGROUP_SCRIPT, with a GPU room's card line after it), answered in cgroup
 * v2's words — the limit, the peak (at the limit once the OOM killer took a
 * kernel), what is in use, the kills.
 */
function classExec(c, command) {
  // `rm -rf [--] PATH` of the container's own filesystem: the agent removes an epoch's export folder once it read it (council.ts · dropExport).
  if (command[0] === 'rm' && command[1] === '-rf') return classRemove(c, command.slice(command[2] === '--' ? 3 : 2))
  const script = command[0] === 'sh' && command[1] === '-c' ? command[2] ?? '' : ''
  if (!/memory\.max|memory\.events/.test(script)) return finish(126, '', `fake docker: exec ${command.join(' ')} is not in this fake`)
  const limit = (c.memoryMb ?? 0) * MIB
  const current = Math.round((c.stats?.usedMb ?? 120) * MIB)
  const kills = oomKills(c)
  const peak = kills > 0 ? limit : Math.max(current, Math.round((c.stats?.peakMb ?? 0) * MIB))
  const card = /nvidia-smi/.test(script) ? `\ncard ${c.stats?.cardMb ?? 0}` : ''
  finish(0, `limit ${limit}\npeak ${peak}\ncurrent ${current}\nkills ${kills}${card}`)
}

/**
 * `exec <c> rm -rf [--] PATH…` in a class container: each absolute path of
 * its own filesystem (`cp` reads it there too) removed, a missing one no
 * error, as rm -f has it. A path inside one of its mounts is not this fake's
 * to remove (the agent never asks it), and is refused as an exec it does not
 * know.
 */
function classRemove(c, paths) {
  if (paths.length === 0) return finish(1, '', 'rm: missing operand')
  for (const inside of paths.map((one) => path.posix.normalize(one))) {
    const mounted = (c.mounts ?? []).some((mount) => inside === mount.target || inside.startsWith(`${mount.target}/`))
    if (!inside.startsWith('/') || inside === '/' || mounted) return finish(126, '', `fake docker: exec rm -rf ${inside} is not in this fake`)
    fs.rmSync(path.join(privateRoot(c.name), inside), { recursive: true, force: true })
  }
  finish(0)
}

function logs() {
  const ref = args[args.length - 1]
  const c = container(ref)
  if (!c) return finish(1, '', `Error response from daemon: No such container: ${ref}`)
  if (c.kind !== 'class') return finish(0, typeof c.directive?.log === 'string' ? c.directive.log : '')
  const tail = args.indexOf('--tail') >= 0 ? Number(args[args.indexOf('--tail') + 1]) : null
  let lines = []
  try {
    // Each start's first line is the port its Jupyter took: the fake's handshake with this file, not a line a Jupyter logs.
    lines = fs.readFileSync(logFile(c.name), 'utf8').split('\n').filter((line) => line !== '' && !/^\d{1,5}$/.test(line))
  } catch { /* nothing said yet */ }
  if (tail !== null && Number.isSafeInteger(tail) && tail >= 0) lines = lines.slice(-tail || lines.length)
  finish(0, lines.join('\n'))
}

async function kill() {
  const ref = args[args.length - 1]
  const c = container(ref)
  if (!c) return finish(1, '', `Error response from daemon: No such container: ${ref}`)
  if (!stateOf(c).running) return finish(1, '', `Error response from daemon: cannot kill container: ${ref}: container ${c.id} is not running`)
  if (c.kind === 'class') {
    await stopJupyter(c)
    writeJson(containerFile(c.name), { ...c, status: 'exited', exitCode: 137, finishedAt: Date.now(), pid: null })
    return finish(0, ref)
  }
  writeJson(containerFile(c.name), { ...c, killed: true, killedAt: Date.now() })
  finish(0, ref)
}

async function rm() {
  const force = args.slice(1).some((arg) => arg === '--force' || /^-[a-z]*f[a-z]*$/.test(arg))
  const refs = args.slice(1).filter((arg) => !arg.startsWith('-'))
  const missing = []
  const refused = []
  for (const ref of refs) {
    const c = container(ref)
    if (!c) {
      missing.push(ref)
      continue
    }
    if (c.kind === 'class') {
      if (stateOf(c).running && !force) {
        refused.push(`Error response from daemon: cannot remove container "/${c.name}": container is running: stop the container before removing or force remove`)
        continue
      }
      await stopJupyter(c)
      for (const file of [containerFile(c.name), logFile(c.name), oomFile(c.name)]) fs.rmSync(file, { force: true })
      fs.rmSync(privateRoot(c.name), { recursive: true, force: true })
      continue
    }
    fs.rmSync(containerFile(c.name), { force: true })
  }
  const errors = [...missing.map((ref) => `Error response from daemon: No such container: ${ref}`), ...refused]
  if (errors.length > 0) return finish(1, refs.filter((ref) => !missing.includes(ref)).join('\n'), errors.join('\n'))
  finish(0, refs.join('\n'))
}

/**
 * `cp` between the host and a class container: a path inside its mounts is
 * the mounted folder's (the class folder, the council's epochs and scratch),
 * any other its own filesystem (`/tmp/colloq-epoch/…`). Docker's rule for
 * folders: copied into a folder that exists, as one that does not.
 */
function cp() {
  const list = args.slice(1).filter((arg) => !/^-[aLq]+$/.test(arg))
  const [from, to] = list
  const side = (text) => {
    const match = /^([A-Za-z0-9][A-Za-z0-9_.-]*):(\/.*)$/.exec(text ?? '')
    const c = match ? container(match[1]) : null
    if (!match || !c || c.kind !== 'class') return null
    const inside = path.posix.normalize(match[2])
    const mount = [...c.mounts].sort((a, b) => b.target.length - a.target.length).find((one) => inside === one.target || inside.startsWith(`${one.target}/`))
    const host = mount ? path.join(mount.source, path.posix.relative(mount.target, inside)) : path.join(privateRoot(c.name), inside)
    return { c, inside, host, readOnly: mount?.readOnly === true }
  }
  const source = side(from)
  const target = side(to)
  if ((source === null) === (target === null)) return finish(1, '', 'fake docker: cp copies between the host and one class container')
  const src = source ? source.host : from
  const dst = target ? target.host : to
  if (target?.readOnly) return finish(1, '', `Error response from daemon: mounted volume is marked read-only: ${target.inside}`)
  if (!fs.existsSync(src)) return finish(1, '', source ? `Error response from daemon: Could not find the file ${source.inside} in container ${source.c.name}` : `lstat ${src}: no such file or directory`)
  const contents = (source ? source.inside : from).endsWith('/.')
  // A destination named as a folder (a trailing `/`) must be one already, as docker has it.
  if ((target ? target.inside : to).endsWith('/') && !fs.existsSync(dst)) return finish(1, '', `Error response from daemon: destination directory ${target ? target.inside : to} does not exist`)
  const into = fs.existsSync(dst) && fs.statSync(dst).isDirectory()
  const landing = into && !contents ? path.join(dst, path.basename(src)) : dst
  fs.mkdirSync(path.dirname(landing), { recursive: true })
  fs.cpSync(src, landing, { recursive: true })
  finish(0)
}

/** The class bridge and the rooms' networks: `network create`, `inspect`, `ls` (by label), `rm`. */
function networkCommand() {
  const sub = args[1]
  const list = args.slice(2)
  if (sub === 'create') {
    const labels = []
    let subnet = null
    let driver = 'bridge'
    const options = {}
    let name = null
    for (let i = 0; i < list.length; i++) {
      const arg = list[i]
      if (arg === '--label') labels.push(list[++i])
      else if (arg.startsWith('--label=')) labels.push(arg.slice('--label='.length))
      else if (arg.startsWith('--subnet=')) subnet = arg.slice('--subnet='.length)
      else if (arg === '--subnet') subnet = list[++i]
      else if (arg.startsWith('--driver=')) driver = arg.slice('--driver='.length)
      else if (arg === '-o' || arg === '--opt') {
        const pair = list[++i] ?? ''
        options[pair.slice(0, pair.indexOf('='))] = pair.slice(pair.indexOf('=') + 1)
      } else if (!arg.startsWith('-')) name = arg
    }
    if (!name) return finish(1, '', 'fake docker: network create needs a name')
    if (network(name) || BUILTIN_NETWORKS.has(name)) return finish(1, '', `Error response from daemon: network with name ${name} already exists`)
    if (subnet && knobs().networkOverlap) return finish(1, '', 'Error response from daemon: invalid pool request: Pool overlaps with other one on this address space')
    const made = { id: hex(32), name, driver, labels, options, subnets: [subnet ?? '172.30.0.0/16'] }
    writeJson(networkFile(name), made)
    return finish(0, made.id)
  }
  if (sub === 'inspect') {
    const format = formatOf(list)
    const tokens = format ? parse(format, true) : null
    const names = list.filter((arg, i) => !arg.startsWith('-') && list[i - 1] !== '--format' && list[i - 1] !== '-f')
    const found = names.map((name) => [name, network(name)])
    const missing = found.filter(([, net]) => !net).map(([name]) => `Error response from daemon: network ${name} not found`)
    const objects = found.filter(([, net]) => net).map(([, net]) => ({
      Name: net.name, Id: net.id, Driver: net.driver, EnableIPv6: false, Labels: labelMap(net.labels), Options: goMap(net.options),
      IPAM: { Driver: 'default', Config: net.subnets.map((value) => ({ Subnet: value })) },
    }))
    const out = tokens ? objects.map((object) => render(tokens, object)).join('\n') : JSON.stringify(objects, null, 4)
    return finish(missing.length > 0 ? 1 : 0, objects.length > 0 ? out : '', missing.join('\n'))
  }
  if (sub === 'ls') {
    const quiet = list.some((arg) => arg === '-q' || arg === '--quiet')
    const labels = labelFilters(list)
    const found = allNetworks().filter((net) => labels.every((label) => hasLabel(net.labels, label)))
    return finish(0, found.map((net) => (quiet ? net.id.slice(0, 12) : net.name)).join('\n'))
  }
  if (sub === 'rm') {
    const names = list.filter((arg) => !arg.startsWith('-'))
    const missing = names.filter((name) => !network(name))
    for (const name of names) fs.rmSync(networkFile(name), { force: true })
    return finish(missing.length > 0 ? 1 : 0, names.filter((name) => !missing.includes(name)).join('\n'), missing.map((name) => `Error response from daemon: network ${name} not found`).join('\n'))
  }
  finish(1, '', `fake docker: network ${sub ?? ''} is not in this fake`)
}

const COMMANDS = { info, ps, image: imageCommand, pull, tag, rmi, run, start, inspect, port, stats, exec, logs, kill, rm, update, cp, network: networkCommand }

try {
  if (args[0] === 'version') finish(0, '28.3.1')
  else if (Object.hasOwn(COMMANDS, args[0] ?? '')) await COMMANDS[args[0]]()
  else finish(1, '', `fake docker: ${args.join(' ')} is not in this fake`)
} catch (error) {
  // What docker refuses, or this fake cannot read, before it prints anything: docker's exit for a refused call.
  if (error instanceof Refused) finish(1, '', error.message)
  throw error
}
