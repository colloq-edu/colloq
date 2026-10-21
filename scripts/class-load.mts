/**
 * class-load.mts: a class whose kernels compute on a machine, under the load
 * of a real one, measured from the students' side (docs/architecture/
 * remote-classes.md §17.5, «Load»).
 *
 * load.mts asks whether one Node process holds five hundred tabs; this asks
 * what a class feels like when its kernels are a tunnel away. The rig creates
 * ITS OWN seminar through the admin routes, sets «Где считается» as asked
 * (LOAD_CLASS), brings in two staff tabs and N students, and holds a class:
 *
 *   1 ROOM      the seminar, its placement, the machines that take it
 *   2 JOIN      N students over the ramp: both sockets, the initial Yjs sync,
 *               presence with a name and a color
 *   3 CLASS     rounds of ten minutes (a shorter class is one round). Each
 *               round the teacher, in the class notebook: `echo` in the
 *               shared terminal, completion and the value line, `print(1)`,
 *               a 2 MB figure (every third round, the first included), a
 *               10 KB file edited and read back at once, tqdm at 10 Hz for a
 *               fifth of the round, a long cell for a tenth with the next
 *               cell pressed behind it (Shift+Enter down the notebook),
 *               interrupts of a cell that would sleep two minutes, and a
 *               council on a fresh cell (see THE COUNCIL below): the class
 *               writes, then presses its attempts at once, twice — after a
 *               cell the teacher ran since the epoch, and again while the
 *               teacher's long cell runs — one student's run pressed by the
 *               teacher, then «Обновить состояние». Once a class, in its
 *               first round: the CSVs of LOAD_CSV_MB written by cells, to the
 *               files panel, and the upload of LOAD_BIG_MB read back.
 *               Meanwhile each student types a line and runs their own
 *               `print(1)` every tenth of a round, asks for a completion
 *               every other turn, and uploads a file once, then runs the cell
 *               that reads it. A share of them (LOAD_OWN) work in a personal
 *               notebook of their own, its kernel the class's `own` slot, and
 *               the first of them runs, from the class's start, a cell that
 *               outlives the room's run limit in a second one
 *   4 CELLS     click → visible for `print(1)` (the class notebook idle at the
 *               click, behind its queue, the personal notebooks, and clicks
 *               while the class's machine is away; first runs apart),
 *               completion (answered asks to a free kernel apart from a busy
 *               one's, and empty answers counted, never timed), the value
 *               line, interrupt, terminal echo, the figure (in the document,
 *               fetched, every viewer's), the edit and the big upload read
 *               back (the files barrier), the CSVs to the panel, tqdm's
 *               longest gap, the long cell past its own time, the run limit's
 *               stop past the limit, upload → readable, council attempts
 *               (press → result, the wait for a worker, each one's time past
 *               its two seconds, the burst and the epochs it computed on, the
 *               one beside the long cell, the teacher's run), the pool's
 *               start, a later open's epoch and «Обновить состояние» as the
 *               console saw them, a worker's seed, the workers' memory as
 *               each attempt read it, a keystroke from one tab to another
 *               (quiet, during a burst, during the big upload): p50 and p95
 *               of each
 *   5 MACHINE   the chip as staff hear it (`kernel:machine`, to both staff tabs:
 *               where each slot computes, its states, the link's round trip,
 *               staff's sentences), the room's own view (the document's
 *               «на машине» and link, the kernel log's notes), the class's
 *               containers as «Работают сейчас» reads them (memory held and
 *               used, a GPU room's card), and a timeline of what changed: the
 *               failover events a class sees
 *   6 BYTES     what the rig sent and received: TCP bytes of every socket,
 *               bodies of every request, per tab and class-hour; and what of
 *               the relay's count is the rig's own measuring (its keystrokes'
 *               writes of the class notebook, pushed to the machine)
 *   7 TARGETS   the §17.5 rows the client side can judge
 *
 * A TAB IS THE WEB APP'S, wire for wire (web/src/lib/session.svelte.ts): the
 * notebook socket syncs both ways and sends only its own presence (no echo of
 * other people's, presence.ts · ownChanges), the control socket says what
 * device it is and pings at once and every 25 s. Both come back by
 * themselves: the control socket after every close but a ban, with the web
 * app's pause that grows and jitters (lib/controls.ts · reconnectDelay),
 * asking the home every fourth failure whether the room is still there; the
 * notebook socket as y-websocket does, 100 ms after a live one closed and
 * doubling while they die young, up to a ceiling of the tab's own
 * (lib/controls.ts · collabBackoff), and closing itself after 30 s in which
 * it heard nothing. While the control socket is away, a press made in that
 * moment waits as the web app keeps it (lib/controls.ts · enqueueControl:
 * the same press once, a council draft by its latest, the last sixteen), the
 * pulse and the editor's questions are not kept at all (DISCARDED_OFFLINE),
 * and nobody presses Run: its button is grey while the room is away
 * (controls.ts · controlDisabled). Completion and the value line go only over
 * a live socket and wait as long as the editor does (3 s and 4 s). A figure
 * is fetched as an <img> fetches it: a ticket, then the bytes by hash.
 *
 * A CLICK waits for the server to take it (its cell queued, running, or its
 * answer shown) for a tenth of a round, at most a minute; then as long as it
 * is on its way: while its cell waits in its kernel's queue or runs, or the
 * press waits for the socket, the wait goes on. The teacher's two-minute
 * tqdm ahead of a student's `print(1)` is the class's queue, measured in full
 * in «behind its queue», never a lost click; «unanswered» is for a click the
 * server never took, or one whose cell ended without its answer.
 *
 * WHAT IT DOES NOT SEE: the tunnel's bytes between the machine and home, the
 * home's CPU, relay2's counters, the barrier's round trips. Bytes per
 * class-hour through the relay (§17.5: ≤ 300 MB without datasets) need the
 * relay's own interface counters: the rig prints the line to run on the
 * relay before and after, and never connects anywhere but the home it is
 * given. It asks the home for nothing staff cannot ask: the owner's sign-in,
 * its own seminar, the environments and resource settings, the class's
 * placement outlook, «Работают сейчас», the doors its students use.
 *
 * THE COUNCIL is the class's own (§9): on machines its attempts go to the
 * class's pool of workers (LOAD_COUNCIL=pool, what the machines presets say;
 * LOAD_WORKERS and LOAD_ATTEMPT_MB are its «Попыток одновременно» and
 * «Память на попытку»), on CLASS=home to the shared kernel as before the
 * pool, so that the baseline is the same class pressing the same attempts.
 * Each attempt computes for ATTEMPT_SEC; a burst is the whole class pressing
 * within a second of the teacher's word, as a class does. What is measured
 * are §17.5's R2 rows the client side can see: thirty attempts of two
 * seconds on eight workers within twenty seconds (the first burst, after
 * the one cell the teacher ran since the open: one refreeze, waited for),
 * the overhead past the two seconds within one at p95 (home's own count of
 * the attempt's time, ranMs), the notebook's kernel untouched by them (a
 * completion asked of it meanwhile, never a run, which would make the epoch
 * stale under the burst), the burst beside the teacher's long cell waiting
 * at most five seconds for a fresher epoch and saying «без ячеек N» after
 * (D8), the teacher's run ahead of the class's (D12), a greedy attempt's
 * MemoryError its author's alone, where the pool computed it, and a
 * keystroke between tabs during the burst within 50 ms of a quiet one. With
 * LOAD_EPOCH_MB a cell gives the notebook's kernel a DataFrame of that size
 * and a fitted model before the class, the epoch row's data. What the
 * client sees of it, each number with what is in it: the pool's cold start
 * (its epoch taken: the export; ready: the epoch's way to the machine, the
 * workers' start and a seed — the transfer H → C is in it when the class
 * notebook computes here, CLASS=personal, which the ship cap bounds), a
 * later open's epoch on the machine and an unchanged refreeze (the export
 * and its way there, no worker's reload), the seed (the epoch the first
 * burst waited for named by the console → its first attempt computing: a
 * worker's restart and load), each worker's memory as its attempts read it,
 * and the council container in «Работают сейчас».
 *
 * SAFETY. It refuses to start without an explicit LOAD_BASE_URL and an
 * owner's credential in the environment (only an owner deletes a seminar,
 * and a rig that could not delete its room would leave it), prints neither
 * of them nor any participant's token, touches no room but the one it
 * created, and deletes that one at the end, on Ctrl+C, SIGTERM and SIGHUP
 * alike. A delete the home does not answer is tried again for three minutes,
 * and a room whose creation was never answered is looked up by its name,
 * which carries a tag of the run's own. A second Ctrl+C leaves at once and
 * names the room to delete by hand; one press delivered twice (npx tsx relays
 * it, ~35 ms apart) is one press. It starts no process and stops none. Never
 * run it against vsos or during a class: thirty synthetic students cost the
 * relay and the home what thirty real ones do.
 *
 * Usage: make class-load URL=… N=30 MIN=60 CLASS=machines
 *        (or node --import tsx scripts/class-load.mts with the variables below)
 *   LOAD_BASE_URL      the home, http(s)://…                        required
 *   LOAD_SETUP_TOKEN   its setup token (signs in as the first owner), or
 *   LOAD_STAFF_COOKIE  an owner's `colloq_staff=…` cookie: one of the two
 *   LOAD_STUDENTS      N                                             default 30
 *   LOAD_MINUTES       the class's length                            default 60
 *   LOAD_CLASS         «Где считается»: machines, personal, gpu, home default machines
 *                      (gpu: a GPU environment, LOAD_ENVIRONMENT's or base-gpu)
 *   LOAD_OWN           the share of students in personal notebooks   default 0.5
 *   LOAD_RAMP_SEC      how long the students take to come in         default 30
 *   LOAD_UPLOAD_KB     each student's upload (0: none)               default 256
 *   LOAD_CSV_MB        the CSVs the cells write once, in MB (0: none) default 1,50
 *   LOAD_BIG_MB        one upload read back once, in MB (0: none)    default 0; R1: 150
 *   LOAD_COUNCIL       pool or shared: where the attempts run         default the preset's
 *                      (machines, personal, gpu: the pool; home: shared)
 *   LOAD_WORKERS       «Попыток одновременно»: auto or 1–32           default auto; R2: 8
 *   LOAD_ATTEMPT_MB    «Память на попытку», MB                        default 1024
 *   LOAD_EPOCH_MB      the data a cell gives the class notebook's kernel for the epoch, MB
 *                      (a DataFrame and a fitted model; python cells) default 0; R2: 500
 *                      (at most 2032; 240 where the class notebook computes here)
 *   LOAD_ENVIRONMENT   the class's environment                       default the instance's
 *   LOAD_CPUS          the class's cores                             default the instance's
 *   LOAD_MEMORY_MB     the class's memory                            default the instance's
 *   LOAD_BASELINE      a previous run's LOAD_OUT, with LOAD_CLASS=home and the same N,
 *                      LOAD_OWN and LOAD_CELLS: the deltas §17.5 asks for
 *   LOAD_OUT           where the numbers go, as JSON
 *   LOAD_CELLS         python (default), or fake: the small language of the
 *                      e2e's fake Jupyter (tests/class-load.test.mts), never a real class
 * More than 60 students from one address meet the join's per-address ceiling
 * (routes/sessions.ts · MAX_NEW_PER_ADDRESS): name the rig's address in the
 * home's SHARED_ADDRESSES. Each upload must fit the home's upload limit
 * (MAX_UPLOAD_MB, 50 by default): the rig refuses to start otherwise.
 */
import { readFileSync, writeFileSync } from 'node:fs'
import type { IncomingMessage } from 'node:http'
import type { Socket } from 'node:net'
import { randomBytes } from 'node:crypto'
import * as Y from 'yjs'
import * as encoding from 'lib0/encoding'
import * as decoding from 'lib0/decoding'
import * as syncProtocol from 'y-protocols/sync'
import * as awarenessProtocol from 'y-protocols/awareness'
import WS, { type RawData } from 'ws'
import {
  CLASS_PLACEMENT_BOUNDS,
  CLASS_PLACEMENT_DEFAULT,
  CLASS_PLACEMENT_PRESETS,
  CLASS_PLACEMENT_PRESET_NAMES,
  type AdminMe,
  type ClassPlacement,
  type ClassPlacementPreset,
  type EnvironmentsState,
  type ResourceSettingsResponse,
  type RunningClass,
  type RunningKernels,
} from '@shared/admin'
import type { ClassPlacementOutlook, RunningClassMachines } from '@shared/remote-admin'
import { CLASS_BULK_MBPS, COUNCIL_EPOCH_MB, COUNCIL_EPOCH_SHIP_MB, COUNCIL_EPOCH_WAIT_MS, COUNCIL_POOL_READY_MS } from '@shared/remote-kernels'
import {
  SESSION_MISSING,
  type AwarenessUser,
  type ControlClientMessage,
  type ControlServerMessage,
  type CouncilMine,
  type CouncilPool,
  type CouncilRun,
  type FileEntry,
  type JoinResponse,
  type KernelMachine,
  type TerminalStatus,
} from '@shared/protocol'
import {
  CELLS_KEY,
  bookAt,
  bookCells,
  bookKernel,
  bookList,
  cellId,
  cellLock,
  cellOutputs,
  cellSource,
  createCell,
  findCell,
  getTerminal,
  kernelsMap,
  readOutput,
  readTerminalLine,
  type CellOutput,
} from '@shared/notebook'
import { MAX_QUEUED_CONTROL, collabBackoff, enqueueControl, reconnectDelay } from '@/lib/controls'

/* --------------------------------------------------------------- settings */

class Usage extends Error {}

const env = process.env

function text(name: string): string {
  return (env[name] ?? '').trim()
}

/** A number from the environment within bounds, or its default; anything else is refused, never guessed. */
function number(name: string, fallback: number, min: number, max: number, whole = false): number {
  const raw = text(name)
  if (raw === '') return fallback
  const value = Number(raw)
  if (!Number.isFinite(value) || value < min || value > max || (whole && !Number.isInteger(value))) {
    throw new Usage(`${name}: ${whole ? 'a whole number' : 'a number'} from ${min} to ${max}, not "${raw}"`)
  }
  return value
}

function optionalWhole(name: string, min: number, max: number): number | null {
  return text(name) === '' ? null : number(name, 0, min, max, true)
}

/** Sizes in megabytes, comma-separated, each above 0 and at most `max`; "0" — none. */
function sizes(name: string, fallback: readonly number[], max: number): number[] {
  const raw = text(name)
  if (raw === '') return [...fallback]
  if (raw === '0') return []
  const list = raw.split(',').map((one) => Number(one.trim()))
  if (list.some((one) => !Number.isFinite(one) || one <= 0 || one > max)) throw new Usage(`${name}: sizes in MB above 0 and at most ${max}, comma-separated, or 0 for none; not "${raw}"`)
  return [...new Set(list)]
}

const USAGE = [
  'class-load: LOAD_BASE_URL and an owner\'s credential are required, in the environment:',
  '  LOAD_BASE_URL=https://lab.example LOAD_SETUP_TOKEN=… node --import tsx scripts/class-load.mts',
  '  (or make class-load URL=… with LOAD_SETUP_TOKEN or LOAD_STAFF_COOKIE exported)',
  'The header of scripts/class-load.mts lists every variable.',
].join('\n')

interface Settings {
  base: string
  setupToken: string
  staffCookie: string
  students: number
  minutes: number
  preset: ClassPlacementPreset
  ownShare: number
  rampSec: number
  uploadKb: number
  csvMb: number[]
  bigMb: number
  environment: string | null
  cpus: number | null
  memoryMb: number | null
  /** Where the attempts run: the class's pool of workers on a machine, or the notebook's shared kernel. */
  council: 'pool' | 'shared'
  workers: ClassPlacement['workers']
  attemptMb: number
  epochMb: number
  baseline: Baseline | null
  out: string | null
  cells: 'python' | 'fake'
}

/** What a previous run's LOAD_OUT gives the deltas: who it was, its probes and its figure. */
interface Baseline {
  path: string
  numbers?: { print?: { room?: Spread; own?: Spread }; figure?: { viewers?: Spread } }
}

/*
 * A baseline is a CLASS=home run of the same class: the same students, the
 * same share in personal notebooks, the same cells. Anything else gives a
 * delta of nothing, and a check that passes on it: a machines run against
 * itself, fake cells against Python. So it is refused before anything is
 * made, as any other wrong setting is.
 */
function readBaseline(path: string, against: { students: number; ownShare: number; cells: string }): Baseline {
  let body: Record<string, unknown>
  try {
    body = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>
  } catch (error) {
    throw new Usage(`LOAD_BASELINE could not be read as a run's LOAD_OUT: ${error instanceof Error ? error.message : String(error)}`)
  }
  if (body.classLoad !== 1) throw new Usage('LOAD_BASELINE is not a class-load LOAD_OUT')
  if (body.class !== 'home') throw new Usage(`LOAD_BASELINE is a CLASS=${String(body.class)} run: the baseline is a CLASS=home one, the class computing here`)
  const mismatch = [
    body.students !== against.students ? `${String(body.students)} students, not ${against.students}` : null,
    body.own !== against.ownShare ? `LOAD_OWN ${String(body.own)}, not ${against.ownShare}` : null,
    body.cells !== against.cells ? `${String(body.cells)} cells, not ${against.cells}` : null,
  ].filter(Boolean)
  if (mismatch.length > 0) throw new Usage(`LOAD_BASELINE is another class: ${mismatch.join(', ')}`)
  return { path, numbers: body.numbers as Baseline['numbers'] }
}

/** What an epoch holds beside the data cell's frame (LOAD_EPOCH_MB): the fitted model, the class's small names, the stream and the manifest. */
const EPOCH_ROOM_MB = 16

function readSettings(): Settings {
  const base = text('LOAD_BASE_URL').replace(/\/+$/, '')
  if (!base) throw new Usage('LOAD_BASE_URL is not set: the rig never guesses which home to load')
  let url: URL
  try {
    url = new URL(base)
  } catch {
    throw new Usage(`LOAD_BASE_URL is not a URL: "${base}"`)
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Usage('LOAD_BASE_URL: http:// or https://')
  if (url.username || url.password || url.search || url.hash) throw new Usage('LOAD_BASE_URL: an origin and a path, nothing else')
  const setupToken = text('LOAD_SETUP_TOKEN')
  const staffCookie = text('LOAD_STAFF_COOKIE').split(';')[0]!.trim()
  if (!setupToken && !staffCookie) throw new Usage('neither LOAD_SETUP_TOKEN nor LOAD_STAFF_COOKIE is set: only an owner may make and delete the rig\'s room')
  if (staffCookie && !staffCookie.startsWith('colloq_staff=')) throw new Usage('LOAD_STAFF_COOKIE is not a colloq_staff= cookie')
  const preset = (text('LOAD_CLASS') || 'machines') as ClassPlacementPreset
  if (!CLASS_PLACEMENT_PRESET_NAMES.includes(preset)) throw new Usage(`LOAD_CLASS: one of ${CLASS_PLACEMENT_PRESET_NAMES.join(', ')}, not "${preset}"`)
  const cells = text('LOAD_CELLS') || 'python'
  if (cells !== 'python' && cells !== 'fake') throw new Usage(`LOAD_CELLS: python or fake, not "${cells}"`)
  const environment = text('LOAD_ENVIRONMENT') || null
  if (environment !== null && !/^[a-z0-9][a-z0-9-]{0,62}$/.test(environment)) throw new Usage(`LOAD_ENVIRONMENT: an environment's name, not "${environment}"`)
  const students = number('LOAD_STUDENTS', 30, 1, 500, true)
  const ownShare = number('LOAD_OWN', 0.5, 0, 1)
  const council = text('LOAD_COUNCIL') || (CLASS_PLACEMENT_PRESETS[preset].council === 'machines' ? 'pool' : 'shared')
  if (council !== 'pool' && council !== 'shared') throw new Usage(`LOAD_COUNCIL: pool or shared, not "${council}"`)
  const workers = text('LOAD_WORKERS') === '' || text('LOAD_WORKERS') === 'auto' ? 'auto' : number('LOAD_WORKERS', 0, CLASS_PLACEMENT_BOUNDS.workers.min, CLASS_PLACEMENT_BOUNDS.workers.max, true)
  const epochMb = number('LOAD_EPOCH_MB', 0, 0, COUNCIL_EPOCH_MB, true)
  // The data is a Python cell's: the fake Jupyter's small language makes no frame.
  if (epochMb > 0 && cells === 'fake') throw new Usage('LOAD_EPOCH_MB: the data is a Python cell, and LOAD_CELLS=fake has none')
  /*
   * Data that cannot be the pool's epoch would measure the shared kernel under
   * the pool's name: past the export's budget the frame stays behind, and
   * every attempt that reads it computes in the notebook's kernel (§9.4); and
   * a class notebook that computes here sends its first epoch to the pool's
   * machine whole, which past the ship cap keeps the council shared (§9.2).
   * Room is left beside the frame for the model, the stream and the manifest.
   */
  if (epochMb > COUNCIL_EPOCH_MB - EPOCH_ROOM_MB) throw new Usage(`LOAD_EPOCH_MB: at most ${COUNCIL_EPOCH_MB - EPOCH_ROOM_MB}, not ${epochMb}: an epoch holds ${COUNCIL_EPOCH_MB} MB in all (COUNCIL_EPOCH_MB), the model, the stream and the manifest beside the frame, and a frame past it stays behind`)
  const shipsWhole = council === 'pool' && CLASS_PLACEMENT_PRESETS[preset].room === 'home'
  if (shipsWhole && epochMb > COUNCIL_EPOCH_SHIP_MB - EPOCH_ROOM_MB) throw new Usage(`LOAD_EPOCH_MB: at most ${COUNCIL_EPOCH_SHIP_MB - EPOCH_ROOM_MB} with CLASS=${preset}, not ${epochMb}: its class notebook computes here, so its first epoch goes to the pool's machine whole, and one past ${COUNCIL_EPOCH_SHIP_MB} MB (COUNCIL_EPOCH_SHIP_MB) keeps the council in the shared kernel`)
  const baseline = text('LOAD_BASELINE')
  return {
    base,
    setupToken,
    staffCookie,
    students,
    minutes: number('LOAD_MINUTES', 60, 0.05, 600),
    preset,
    ownShare,
    rampSec: number('LOAD_RAMP_SEC', 30, 0, 3600),
    uploadKb: number('LOAD_UPLOAD_KB', 256, 0, 1024 * 1024, true),
    csvMb: sizes('LOAD_CSV_MB', [1, 50], 1024),
    bigMb: number('LOAD_BIG_MB', 0, 0, 2048),
    environment,
    cpus: optionalWhole('LOAD_CPUS', 1, 256),
    memoryMb: optionalWhole('LOAD_MEMORY_MB', 64, 1024 * 1024),
    council,
    workers,
    attemptMb: number('LOAD_ATTEMPT_MB', CLASS_PLACEMENT_DEFAULT.attemptMb, CLASS_PLACEMENT_BOUNDS.attemptMb.min, CLASS_PLACEMENT_BOUNDS.attemptMb.max, true),
    epochMb,
    baseline: baseline ? readBaseline(baseline, { students, ownShare, cells }) : null,
    out: text('LOAD_OUT') || null,
    cells,
  }
}

let settings: Settings
try {
  settings = readSettings()
} catch (error) {
  if (!(error instanceof Usage)) throw error
  console.error(`class-load: ${error.message}\n\n${USAGE}`)
  process.exit(2)
}
const S = settings
const WSB = S.base.replace(/^http/, 'ws')
const secrets = new Set<string>([S.setupToken, S.staffCookie.slice('colloq_staff='.length)].filter(Boolean))

/* -------------------------------------------------------------- the plan */

/*
 * A class is rounds of ten minutes, and every act takes the share of a round
 * a real class gives it, so that a fifteen-second run in a test plays the
 * same lesson as an hour on the rehearsal rig, only shorter.
 */
const CLASS_MS = S.minutes * 60_000
const ROUND_MS = Math.min(600_000, CLASS_MS)
const ROUNDS = Math.max(1, Math.round(CLASS_MS / ROUND_MS))
/** Echoes, completions, value lines, teacher's probes and interrupts per round: a hundred of each in an hour (§17.5). */
const EACH = Math.max(2, Math.round(ROUND_MS / 36_000))
/** tqdm at 10 Hz for a fifth of a round: two minutes in an hour's round (§17.5). */
const TQDM_SEC = Math.max(2, Math.round(ROUND_MS / 5_000))
const LONG_SEC = Math.max(1, Math.round(ROUND_MS / 10_000))
/** What the cell to interrupt would sleep: an interrupt that never lands costs the class two minutes. */
const HANG_SEC = 120
/** How long a council takes the class: half of it writing, the rest its two bursts and the teacher's long cell beside the second. */
const COUNCIL_MS = Math.max(2_000, ROUND_MS / 5)
/** The council's share of a round's time, where every other act has one (teacherRound). */
const COUNCIL_SHARES = 3
/** What an attempt computes for (§17.5 «30 attempts of 2 s»): what it costs past this is overhead. */
const ATTEMPT_SEC = 2
/** A class pressing at the teacher's word: every press within this of the first. */
const BURST_SPREAD_MS = 1_000
/*
 * How long the first council waits for its pool to hold an epoch: the pool's
 * own «пул не поднялся» bound (§9.9), and, for a class notebook that computes
 * here, the first epoch's way to the pool's machine at the classes' pace on
 * top of it — that one goes there whole (§9.2).
 */
const POOL_WAIT_MS = COUNCIL_POOL_READY_MS + (S.council === 'pool' && CLASS_PLACEMENT_PRESETS[S.preset].room === 'home' ? Math.ceil(S.epochMb / CLASS_BULK_MBPS) * 1000 : 0)
/*
 * The teacher's cell the second burst runs beside (§17.5 «a 30-attempt burst
 * while the teacher runs a 60 s cell»): the long cell's minute in an hour's
 * round, and in any class long enough to outlast the five seconds an attempt
 * waits for a fresher epoch (D8) and a few attempts after them.
 */
const BESIDE_SEC = Math.max(LONG_SEC, Math.ceil(COUNCIL_EPOCH_WAIT_MS / 1000) + 3 * ATTEMPT_SEC + 2)
/*
 * THE ROOM'S RUN LIMIT (rules.ts · cellLimitSec): set on the rig's room, past
 * the longest cell the class runs on purpose — tqdm, the long cell and the
 * one the second burst runs beside — so that it stops one cell only, the one
 * made to outlive it. A teacher's cell is stopped by it too.
 */
const LIMIT_SEC = Math.max(TQDM_SEC, LONG_SEC, BESIDE_SEC) + 10
/** How long the cell made to outlive the limit would run if nothing stopped it. */
const RUNAWAY_SEC = LIMIT_SEC + Math.max(10, Math.round(LIMIT_SEC / 2))
/** How often a keystroke goes from one tab to another while the class does something heavy: a council's burst, the big upload (§17.5 «Collaboration RTT»). */
const COLLAB_EVERY_MS = 2_000
/*
 * And while it does nothing heavy, for the baseline the heavy ones are judged
 * against: every twentieth of a round, half a minute in an hour's (120
 * samples). Each keystroke is an edit of the class notebook, which the
 * server writes to its file a moment later and pushes to the class's
 * machine (books.ts · WRITE_AFTER_MS, §8): bytes on the relay that are the
 * rig's own, kept to what the measure needs and counted in section 6.
 */
const COLLAB_QUIET_MS = Math.max(COLLAB_EVERY_MS, Math.round(ROUND_MS / 20))
/** A student's turn: a line typed, a probe, every other turn a completion too. */
const TURN_MS = Math.min(60_000, Math.max(1_500, ROUND_MS / 10))
/*
 * A 2 MB figure costs the relay its size times the viewers (every tab that
 * draws the class notebook fetches it), so the class shows one every third
 * round, the first included: two in an hour, which is already a heavy class
 * by the bytes-per-class-hour row.
 */
const FIGURE_EVERY_ROUNDS = 3
const FIGURE_BYTES = 2_000_000
/** The barrier's edit (§17.5 «a 10 KB edit»): a file at home changed, and the cell that reads it run at once. */
const EDIT_BYTES = 10 * 1024
const MB = 1024 * 1024
const BIG_BYTES = Math.round(S.bigMb * MB)
const CSV_BYTES = S.csvMb.map((mb) => Math.round(mb * MB))
const STUDENTS_OWN = Math.round(S.students * S.ownShare)
/** Whether the attempts go to the class's pool of workers on a machine (§9), not the notebook's shared kernel. */
const POOL = S.council === 'pool'
const PLACEMENT: Pick<ClassPlacement, 'room' | 'own' | 'council'> & Partial<Pick<ClassPlacement, 'workers' | 'attemptMb'>> = {
  ...CLASS_PLACEMENT_PRESETS[S.preset],
  council: POOL ? 'machines' : 'shared',
  ...(POOL ? { workers: S.workers, attemptMb: S.attemptMb } : {}),
}
const ON_MACHINES = PLACEMENT.room === 'machines' || (PLACEMENT.own === 'machines' && STUDENTS_OWN > 0) || POOL
/** The greedy attempt's ask (§17.5 «a greedy attempt»): twice «Память на попытку» and a little, past any ceiling it is given. */
const GREEDY_MB = 2 * S.attemptMb + 256

/**
 * How long the server may take to show it took a click (its cell queued or
 * running, or the answer shown) before the click counts unanswered: a tenth
 * of a round, at most a minute. A click on its way waits longer (CAP_MS).
 */
const ANSWER_MS = Math.min(60_000, Math.max(1_500, ROUND_MS / 10))
/*
 * The longest a click on its way is waited for: its cell behind two of the
 * class's longest cells. Past it something is stuck, and the click is
 * counted unanswered after all.
 */
const CAP_MS = ANSWER_MS + 2 * Math.max(TQDM_SEC, LONG_SEC, HANG_SEC) * 1000
/** How often a wait on its way looks again at whether it still is. */
const HOLD_STEP_MS = 1_000
/** The editor's patience for a completion and for help (session.svelte.ts · ASK_TIMEOUT_MS, INSPECT_TIMEOUT_MS). */
const ASK_MS = 3_000
const INSPECT_MS = 4_000
/** How long a person waits for the shell's prompt before giving up on typing the next command. */
const SHELL_WAIT_MS = 15_000
const HEALTH_EVERY_MS = 5_000
/** How often «Работают сейчас» is read for the class's containers. */
const RUNNING_EVERY_MS = 30_000
/** The web app's control pulse (session.svelte.ts · beat). */
const PING_EVERY_MS = 25_000
/** y-websocket's messageReconnectTimeout: a notebook socket that heard nothing this long is closed and opened anew. */
const COLLAB_SILENCE_MS = 30_000
/** The timer step with which the rig watches ITS OWN event loop (load.mts · SELF_TICK_MS). */
const SELF_TICK_MS = 200

/*
 * What the web app never queues while its control socket is away
 * (session.svelte.ts · DISCARDED_OFFLINE): its own pulse and what the next
 * open says again, the hand's motion, the editor's questions, presses that
 * go now or never.
 */
const DISCARDED_OFFLINE = new Set<ControlClientMessage['t']>(['ping', 'ink', 'ink:page', 'laser', 'complete', 'inspect', 'define', 'lecture:take', 'device', 'lecture:zoom', 'lecture:sheet'])

/* ---------------------------------------------------------------- output */

const isTTY = Boolean(process.stdout.isTTY)
const dim = (s: string) => (isTTY ? `\x1b[2m${s}\x1b[0m` : s)
const red = (s: string) => (isTTY ? `\x1b[31m${s}\x1b[0m` : s)
const green = (s: string) => (isTTY ? `\x1b[32m${s}\x1b[0m` : s)
const bold = (s: string) => (isTTY ? `\x1b[1m${s}\x1b[0m` : s)
const plain = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, '')
const pad = (s: string, width: number) => s + ' '.repeat(Math.max(0, width - plain(s).length))

/*
 * Nothing the rig prints may carry a credential: not the setup token or the
 * staff cookie it was given, not a participant's token, not a blob ticket.
 * Every line goes through here, error messages above all, since a socket's
 * or a fetch's error may quote the address it was opened with. The set
 * grows as credentials come: the staff cookie, every tab's token, tickets.
 */
function redact(line: string): string {
  let out = line.replace(/([?&](?:token|key)=)[^&\s"']+/gi, '$1…')
  for (const secret of secrets) if (secret.length >= 8) out = out.split(secret).join('…')
  return out
}
const say = (s = '') => console.log(redact(s))
const warn = (s: string) => console.error(redact(s))
const row = (label: string, value: string, note = '') => say('    ' + pad(label, 26) + pad(value, 46) + (note ? dim(note) : ''))

const ms = (v: number | null | undefined) => (v === null || v === undefined || !Number.isFinite(v) ? '—' : v < 10 ? `${v.toFixed(1)}ms` : v < 10_000 ? `${Math.round(v)}ms` : `${(v / 1000).toFixed(1)}s`)
const size = (v: number) => (!Number.isFinite(v) ? '—' : v >= MB ? `${(v / MB).toFixed(1)}M` : v >= 1024 ? `${(v / 1024).toFixed(1)}K` : `${Math.round(v)}B`)
const megabytes = (mb: number) => (mb >= 1024 ? `${(mb / 1024).toFixed(1)} GB` : mb < 10 ? `${Number(mb.toFixed(2))} MB` : `${Math.round(mb)} MB`)
const clock = (at: number) => new Date(at).toISOString().slice(11, 19)
const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error))
/** A pause no stop ends: the cleanup's own, which runs while the rig is stopping. */
const sleep = (msec: number) => new Promise<void>((resolve) => setTimeout(resolve, msec))

/* ------------------------------------------------------------- the numbers */

/** A percentile over unsorted samples, nearest rank, as load.mts and perf.mts take it. */
function pct(samples: readonly number[], p: number): number | null {
  if (samples.length === 0) return null
  const s = [...samples].sort((a, b) => a - b)
  return s[Math.min(s.length - 1, Math.max(0, Math.ceil((p / 100) * s.length) - 1))]!
}

interface Spread {
  n: number
  p50: number | null
  p95: number | null
  max: number | null
}

const round1 = (v: number | null) => (v === null ? null : Math.round(v * 10) / 10)
function spread(samples: readonly number[]): Spread {
  // The largest by a loop: the rig's own loop gives 18 000 samples an hour, past what a spread call takes as arguments in a long run.
  return { n: samples.length, p50: round1(pct(samples, 50)), p95: round1(pct(samples, 95)), max: round1(samples.length ? samples.reduce((a, b) => (b > a ? b : a), -Infinity) : null) }
}
const spreadText = (s: Spread) => (s.n === 0 ? dim('—') : `p50 ${ms(s.p50)} · p95 ${ms(s.p95)} · max ${ms(s.max)}`)

/** Every sample the rig took, by what it measures: milliseconds. */
const samples = new Map<string, number[]>()
function sample(key: string, value: number): void {
  const list = samples.get(key) ?? []
  list.push(value)
  samples.set(key, list)
}
const taken = (key: string) => samples.get(key) ?? []
/** Every count the rig kept: clicks nobody answered, refusals, retries. */
const counts = new Map<string, number>()
const count = (key: string, by = 1) => counts.set(key, (counts.get(key) ?? 0) + by)
const counted = (key: string) => counts.get(key) ?? 0
/** What the room's control sockets refused, by the server's words. */
const refusals = new Map<string, number>()

const now = () => performance.now()
let stopping = false
const stopWaiters = new Set<() => void>()
/** Why the run ended before its class did, when something outside it ended it (its room deleted under it). */
let endedBy: string | null = null

/** End the run from outside its own flow: every wait answers now, and the main flow unwinds to the cleanup. */
function endRun(why: string): void {
  if (stopping) return
  endedBy = why
  stopping = true
  warn(red(`class-load: ${why}`))
  for (const done of [...stopWaiters]) done()
  for (const tab of tabs) tab.release()
}

/** A pause that a stop ends early. */
function pause(msec: number): Promise<void> {
  if (stopping || msec <= 0) return Promise.resolve()
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer)
      stopWaiters.delete(done)
      resolve()
    }
    const timer = setTimeout(done, msec)
    stopWaiters.add(done)
  })
}

const jitter = (msec: number) => msec * (0.5 + Math.random())

/*
 * THE RIG'S OWN LOOP. Two documents per tab apply every update of the room
 * in this one process, and when it chokes, every latency below grows by its
 * wait: a frame that came in on time is read late. It is watched as
 * load.mts watches its own, and said beside the numbers.
 */
const selfLag: number[] = []
let selfTimer: NodeJS.Timeout | null = null
function watchSelf(): void {
  let last = now()
  selfTimer = setInterval(() => {
    const at = now()
    selfLag.push(Math.max(0, at - last - SELF_TICK_MS))
    last = at
  }, SELF_TICK_MS)
  selfTimer.unref()
}

/* ------------------------------------------------------------------- http */

const http = { requests: 0, failed: 0, sent: 0, received: 0 }
let staffCookie = ''

interface Answer {
  status: number
  /** The body as text; empty for a body asked for as bytes (`binary`). */
  text: string
  bytes: number
  /** Its content-type, lower case: the home's own answers are JSON, a relay's page is not. */
  type: string
}

/**
 * One request to the home, its body's bytes counted both ways. The headers
 * are not: a fetch does not show its socket, and they are a few hundred bytes
 * against the documents, figures and uploads the class moves. A body asked
 * for `binary` (a figure's bytes) is counted and never decoded.
 */
async function request(method: string, path: string, options: { cookie?: string; bearer?: string; json?: unknown; form?: FormData; formBytes?: number; timeoutMs?: number; binary?: boolean } = {}): Promise<Answer> {
  const headers: Record<string, string> = {}
  if (options.cookie) headers.cookie = options.cookie
  if (options.bearer) headers.authorization = `Bearer ${options.bearer}`
  let body: string | FormData | undefined
  if (options.json !== undefined) {
    headers['content-type'] = 'application/json'
    body = JSON.stringify(options.json)
    http.sent += Buffer.byteLength(body)
  } else if (options.form) {
    body = options.form
    http.sent += options.formBytes ?? 0
  }
  http.requests++
  try {
    const res = await fetch(`${S.base}${path}`, { method, headers, body, signal: AbortSignal.timeout(options.timeoutMs ?? 30_000) })
    const bytes = Buffer.from(await res.arrayBuffer())
    http.received += bytes.length
    return { status: res.status, text: options.binary ? '' : bytes.toString('utf8'), bytes: bytes.length, type: (res.headers.get('content-type') ?? '').toLowerCase() }
  } catch (error) {
    http.failed++
    throw error
  }
}

function parsed<T>(answer: Answer): T | null {
  try {
    return JSON.parse(answer.text) as T
  } catch {
    return null
  }
}

/** The server's own words of a refusal (`{error}`), or its status. */
function refusalOf(answer: Answer): string {
  const body = parsed<{ error?: unknown }>(answer)
  return typeof body?.error === 'string' ? `${answer.status} ${body.error}` : `HTTP ${answer.status}`
}

/* ---------------------------------------------------------------- sign-in */

/**
 * The owner's cookie: the one given, or the setup token spent on its second
 * job, signing in as the instance's first owner (routes/admin-auth.ts ·
 * signin/token). Then the panel is asked who that is: only an owner deletes a
 * seminar (DELETE /api/admin/seminars/:id is ownerOnly), and a rig that made
 * a room it could not delete would leave it behind.
 */
async function signIn(): Promise<string | null> {
  if (S.staffCookie) {
    staffCookie = S.staffCookie
  } else {
    let res: Response
    try {
      res = await fetch(`${S.base}/api/admin/signin/token`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ token: S.setupToken }),
        signal: AbortSignal.timeout(30_000),
      })
    } catch (error) {
      return `the home did not answer: ${errorText(error)}`
    }
    await res.arrayBuffer()
    if (!res.ok) return `the setup token was refused (HTTP ${res.status})`
    staffCookie = (res.headers.get('set-cookie') ?? '').split(';')[0]!
    if (!staffCookie.startsWith('colloq_staff=')) return 'no staff cookie was issued'
  }
  secrets.add(staffCookie.slice('colloq_staff='.length))
  const me = await request('GET', '/api/admin/me', { cookie: staffCookie }).catch(() => null)
  if (!me || me.status !== 200) return `the panel does not know this cookie (${me ? `HTTP ${me.status}` : 'no answer'})`
  const role = parsed<AdminMe>(me)?.teacher?.role
  if (role !== 'owner') return 'the cookie is a teacher\'s, not an owner\'s: only an owner deletes a seminar, and the rig deletes its own'
  return null
}

/** The class's environment as the room is made with it; null — the instance's. */
let environment: string | null = S.environment
/** The environment asks for a card (`# colloq: gpu`): the class's room holds one whole. */
let gpuClass = false

/**
 * The environment, asked of the home before any room exists: CLASS=gpu is a
 * class on a GPU environment (shared/admin.ts · CLASS_PLACEMENT_PRESETS: the
 * card follows from the environment, the tile is its name), so it takes
 * LOAD_ENVIRONMENT's when that one asks for a card, base-gpu or the first
 * that does when none is named, and refuses otherwise: a run labelled «gpu»
 * that measured a CPU class would answer the GPU row with a lie.
 */
async function chooseEnvironment(): Promise<string | null> {
  if (S.preset !== 'gpu' && S.environment === null) return null
  const answer = await request('GET', '/api/admin/environments', { cookie: staffCookie }).catch(() => null)
  const list = answer?.status === 200 ? parsed<EnvironmentsState>(answer)?.environments : undefined
  if (!list) return S.preset === 'gpu' ? `the home's environments did not answer (${answer ? `HTTP ${answer.status}` : 'no answer'}): CLASS=gpu needs one that asks for a card` : null
  if (S.environment !== null) {
    const named = list.find((one) => one.name === S.environment)
    if (!named) return `there is no environment called ${S.environment} on this home`
    gpuClass = named.gpu
    if (S.preset === 'gpu' && !named.gpu) return `CLASS=gpu needs a GPU environment (\`# colloq: gpu\`), and ${S.environment} is not one`
    return null
  }
  const gpu = list.find((one) => one.name === 'base-gpu' && one.gpu) ?? list.find((one) => one.gpu)
  if (!gpu) return 'CLASS=gpu: this home has no GPU environment (`# colloq: gpu`): name one with LOAD_ENVIRONMENT'
  environment = gpu.name
  gpuClass = true
  return null
}

/** Each upload the class makes must fit the home's limit (MAX_UPLOAD_MB): a refused one would measure a refusal. */
async function uploadsFit(): Promise<string | null> {
  const biggest = Math.max(S.uploadKb * 1024, BIG_BYTES, S.cells === 'fake' ? FIGURE_BYTES : 0, EDIT_BYTES)
  const answer = await request('GET', '/api/admin/resources', { cookie: staffCookie }).catch(() => null)
  const limit = answer?.status === 200 ? parsed<ResourceSettingsResponse>(answer)?.settings?.uploadMb?.value : undefined
  // Not said: the uploads themselves will tell.
  if (typeof limit !== 'number') return null
  if (biggest > limit * MB) return `the home takes uploads up to ${limit} MB (MAX_UPLOAD_MB, the Resources tab), and the class would upload ${megabytes(biggest / MB)}`
  return null
}

/* -------------------------------------------------------------- the cells */

/**
 * What the class types. `python` is a real class's Python; `fake` says the
 * same in the small language of the e2e's fake Jupyter (tests/_fake-jupyter.mjs:
 * no figures there, so its figure is a 2 MB file the teacher uploaded and a
 * cell that prints it, the same bytes through the tunnel).
 */
interface Cells {
  print: { source: string; shows: string }
  /** What the value line asks about, and the cell that binds it. */
  setup: string
  value: { code: string; cursor: number }
  completion: { code: string; cursor: number }
  figure: { source: string; upload: { name: string; body: Buffer } | null }
  tqdm(seconds: number): string
  long(seconds: number): string
  /** A cell to interrupt: it would sleep HANG_SEC, so an interrupt that never lands costs the class two minutes. */
  hang: string
  read(name: string, bytes: number, marker: string): { source: string; shows: string }
  /** The cell that reads the edited file: it shows the file's first line, which each edit makes new. */
  edit: string
  /** The cell that reads the big upload, and what it shows once the file is all there (`marker`: a small file sent after it). */
  big(bytes: number, marker: string): { source: string; shows: string; marker: boolean }
  /** A cell that writes a CSV of `bytes` and says so. */
  csv(name: string, bytes: number): { source: string; shows: string }
  /** torch's card, asked of a GPU class's kernel; null — not askable in these cells. */
  cuda: { source: string; shows: string } | null
  /** The teacher's cell after the epoch (§17.5): a run that stores history, binding a name; it says `after`. */
  after: string
  /** The data an epoch carries (LOAD_EPOCH_MB): `df` of `mb` and a `model` fitted on it; null — not in these cells. */
  data: ((mb: number) => { source: string; shows: string }) | null
  /**
   * An attempt computing for ATTEMPT_SEC on the class's `x` (and the data,
   * `withData`); in Python it says its worker's memory as it reads it at its
   * end (smaps_rollup, kB): Anonymous − LazyFree + Pss_Shmem + Swap, all the
   * worker wrote for itself — the epoch's objects it unpickled included, so
   * not the growth since its seed that the pool recycles it by (§9.3 detail
   * 4); never Private_Dirty, which also charges a reader the page cache's
   * still-dirty pages of a freshly copied epoch — its Pss and its Rss.
   */
  attempt(n: number, draft: number, withData: boolean): string
  /** An attempt asking `mb` at once, more than «Память на попытку» gives it; null — not in these cells. */
  greedy: ((mb: number, draft: number) => string) | null
  task: string
}

/*
 * The cells leave nothing big in the notebook's namespace that a class's
 * would not: every name there rides the council's epoch, underscored ones
 * too, and a worker unpickles what is not an array into memory of its own
 * (§9.3). A 2 MB pixel buffer or a 50 MB CSV string left behind would be the
 * rig's own weight in the epoch's stream, the seed and each worker's memory.
 */
const PNG = [
  'import os, struct, zlib',
  'from IPython.display import Image, display',
  'def _chunk(kind, data):',
  '    return struct.pack(">I", len(data)) + kind + data + struct.pack(">I", zlib.crc32(kind + data) & 0xffffffff)',
  '_w = _h = 816',
  String.raw`_raw = b"".join(b"\x00" + os.urandom(_w * 3) for _ in range(_h))`,
  String.raw`display(Image(data=b"\x89PNG\r\n\x1a\n" + _chunk(b"IHDR", struct.pack(">IIBBBBB", _w, _h, 8, 2, 0, 0, 0)) + _chunk(b"IDAT", zlib.compress(_raw, 1)) + _chunk(b"IEND", b"")))`,
  'del _raw',
].join('\n')

const FIGURE_FILE = 'load-figure.txt'
const EDIT_FILE = 'load-edit.txt'
const BIG_FILE = 'load-big.bin'
const BIG_MARK = 'load-big.txt'

const PYTHON: Cells = {
  print: { source: 'print(1)', shows: '1' },
  setup: 'x = list(range(1000))',
  value: { code: 'x', cursor: 1 },
  completion: { code: 'import os\nos.pa', cursor: 'import os\nos.pa'.length },
  // 816 × 816 random pixels: a PNG of 2.0 MB that does not compress, shown as a cell's image is.
  figure: { source: PNG, upload: null },
  tqdm: (seconds) => [
    'import sys, time',
    'try:',
    '    from tqdm import tqdm',
    'except ImportError:',
    '    tqdm = None',
    `n = ${Math.max(1, Math.round(seconds * 10))}`,
    'if tqdm:',
    '    for _ in tqdm(range(n), mininterval=0.1, file=sys.stderr):',
    '        time.sleep(0.1)',
    'else:',
    '    for i in range(n):',
    '        sys.stderr.write(f"\\r{i + 1}/{n}")',
    '        sys.stderr.flush()',
    '        time.sleep(0.1)',
    'print("done")',
  ].join('\n'),
  long: (seconds) => `import time\ntime.sleep(${seconds})\nprint("done")`,
  hang: `import time\ntime.sleep(${HANG_SEC})`,
  read: (name, bytes) => ({ source: `print(len(open(${JSON.stringify(name)}, "rb").read()))`, shows: String(bytes) }),
  edit: `print(open(${JSON.stringify(EDIT_FILE)}).readline().strip())`,
  big: (bytes) => ({ source: `import os\nprint(os.path.getsize(${JSON.stringify(BIG_FILE)}))`, shows: String(bytes), marker: false }),
  // Exactly `bytes` of ASCII, written as a cell writes its results; the text and the file go with the cell.
  csv: (name, bytes) => ({
    source: [`_n = ${bytes}`, `with open(${JSON.stringify(name)}, "w") as _f:`, '    _f.write(("id,value\\n" + "17,0.5\\n" * (_n // 7 + 1))[:_n])', 'del _f', 'print("written")'].join('\n'),
    shows: 'written',
  }),
  cuda: { source: 'import torch\nprint("cuda", torch.cuda.is_available(), torch.cuda.device_count())', shows: 'cuda True' },
  after: 'y = 1\nprint("after")',
  // Sixteen float columns, numeric blocks that travel out of band and are shared by the workers (§9.3), and a model fitted on them.
  data: (mb) => ({
    source: [
      'import numpy as np, pandas as pd',
      'from sklearn.linear_model import LogisticRegression',
      `_rows = max(1000, ${Math.round(mb * MB)} // (8 * 16))`,
      'df = pd.DataFrame(np.random.default_rng(17).standard_normal((_rows, 16)), columns=[f"f{i}" for i in range(16)])',
      'model = LogisticRegression(max_iter=200).fit(df.iloc[:20000].to_numpy(), (df["f0"].iloc[:20000] > 0).to_numpy())',
      'print("data", len(df))',
    ].join('\n'),
    shows: 'data',
  }),
  // Computing for its whole two seconds, as a student's attempt does, not sleeping through them: the worker's core is busy.
  attempt: (n, draft, withData) => [
    'import time',
    '_t0 = time.perf_counter()',
    'def solve(xs):',
    '    return sum(v * v for v in xs)',
    `answer = solve(x) + ${n}${withData ? ' + len(df) + int(model.predict(df.iloc[:1].to_numpy())[0])' : ''}`,
    `while time.perf_counter() - _t0 < ${ATTEMPT_SEC}:`,
    '    solve(range(1000))',
    'try:',
    '    _m = {}',
    '    for _line in open("/proc/self/smaps_rollup"):',
    '        _k, _, _v = _line.partition(":")',
    '        if _v.strip().endswith("kB"):',
    '            _m[_k.strip()] = int(_v.split()[0])',
    '    print(answer, "mem", _m.get("Anonymous", 0) - _m.get("LazyFree", 0) + _m.get("Pss_Shmem", 0) + _m.get("Swap", 0), _m.get("Pss", 0), _m.get("Rss", 0))',
    'except OSError:',
    '    print(answer)',
    `# draft ${draft}`,
  ].join('\n'),
  greedy: (mb, draft) => `big = bytearray(${mb} * 1024 * 1024)\nprint(len(big))  # draft ${draft}`,
  task: '# Write solve(xs): the sum of the squares of xs\n',
}

const FAKE: Cells = {
  print: { source: 'print(1)', shows: '1' },
  setup: 'x = 1',
  value: { code: 'df', cursor: 2 },
  completion: { code: 'df.', cursor: 3 },
  figure: { source: `READ ${FIGURE_FILE}`, upload: { name: FIGURE_FILE, body: Buffer.concat([Buffer.from('load-figure\n'), Buffer.alloc(FIGURE_BYTES - 12, 'x')]) } },
  tqdm: (seconds) => `STREAM ${Math.max(1, Math.round(seconds * 10))} 100\nprint("done")`,
  long: (seconds) => `SLEEP ${Math.round(seconds * 1000)}\nprint("done")`,
  hang: `SLEEP ${HANG_SEC * 1000}`,
  read: (name, _bytes, marker) => ({ source: `READ ${name}`, shows: marker }),
  edit: `READ ${EDIT_FILE}`,
  // READ would print the whole file into the document: the fake reads the small marker sent after it, which the barrier brings with it.
  big: (_bytes, marker) => ({ source: `READ ${BIG_MARK}`, shows: marker, marker: true }),
  csv: (name, bytes) => ({ source: `FILL ${name} ${bytes} 17,0.5\\n\nprint("written")`, shows: 'written' }),
  cuda: null,
  after: 'y = 1\nprint("after")',
  data: null,
  attempt: (n, draft) => `SLEEP ${ATTEMPT_SEC * 1000}\nprint("attempt", ${n}, ${draft})`,
  greedy: null,
  task: 'print("task")',
}

const CELLS = S.cells === 'fake' ? FAKE : PYTHON

/* --------------------------------------------------------------- the tabs */

/** y-websocket's frame tags: the protocol's numbers, not a choice. */
const MSG_SYNC = 0
const MSG_AWARENESS = 1

interface DocCheck {
  check: () => boolean
  resolve: (at: number | null) => void
  timer: NodeJS.Timeout | null
}

interface FrameCheck {
  pick: (frame: ControlServerMessage) => boolean
  resolve: (at: number | null) => void
  timer: NodeJS.Timeout
}

type Channel = 'collab' | 'control'

const tabs: Tab[] = []
/** Closes by code, of sockets the rig did not close itself. */
const closes = new Map<number, number>()
const reconnects = { collab: 0, control: 0 }
let badFrames = 0
const pongs: number[] = []

/**
 * One browser tab: the notebook socket and the control socket, as the web
 * app opens them (see the header). The teacher's tabs carry the staff cookie
 * on both: the role on the wire is asked of it, never of the token.
 */
class Tab {
  readonly doc = new Y.Doc()
  readonly aw: awarenessProtocol.Awareness
  collab: WS | null = null
  control: WS | null = null
  synced = false
  welcomed = false
  /** The shared terminal's phase as the control socket last said it (`terminal`); null — not said yet. */
  terminal: TerminalStatus | null = null
  /** The room's files as this tab's panel holds them (`files`, `files:delta`), by path: kept by a tab that watches them. */
  readonly tree = new Map<string, FileEntry>()
  watchesTree = false
  /** Each council cell's own sheet as the server last sent it (`council:mine`). */
  readonly sheets = new Map<string, CouncilMine>()
  /** The run each council cell's last press is waiting for on this sheet, by cell. */
  readonly runs = new Map<string, RunWatch>()
  /** When the notebook socket last heard anything (y-websocket · wsLastMessageReceived). */
  collabHeard = 0
  /** The messages' bytes both ways, after decompression. */
  readonly payload = { collabIn: 0, collabOut: 0, controlIn: 0, controlOut: 0 }
  /** TCP bytes of the sockets this tab had that are closed now. */
  readonly tcp = { in: 0, out: 0 }
  private readonly live = new Set<Socket>()
  private readonly docChecks = new Set<DocCheck>()
  private readonly frameChecks = new Set<FrameCheck>()
  private readonly listeners: Array<(frame: ControlServerMessage) => void> = []
  private readonly applied: Array<() => void> = []
  private readonly queue: ControlClientMessage[] = []
  private readonly timers = new Set<NodeJS.Timeout>()
  /** The notebook socket's backoff ceiling, this tab's own (lib/controls.ts · collabBackoff). */
  private readonly collabCeiling = collabBackoff()
  /** Notebook sockets that died before they opened, in a row (y-websocket · wsUnsuccessfulReconnects). */
  private collabFailures = 0
  /** Control sockets closed since the last that opened (session.svelte.ts · #retries). */
  private controlRetries = 0
  private treeRev: number | null = null
  private pingTimer: NodeJS.Timeout | null = null
  private pingAt = 0
  private closed = false
  private seq = 0
  /** A blob ticket and until when it holds (routes/blobs.ts: five minutes). */
  ticket: { token: string; until: number } | null = null

  constructor(
    readonly n: number,
    readonly participant: JoinResponse['participant'],
    readonly token: string,
    readonly cookie: string | null,
  ) {
    secrets.add(token)
    // The root types before the first foreign update, as SessionState declares them.
    this.doc.getArray(CELLS_KEY)
    this.doc.getMap('meta')
    this.aw = new awarenessProtocol.Awareness(this.doc)
    this.doc.on('update', (update: Uint8Array, origin: unknown) => {
      // What arrived over the wire is not sent back: readSyncMessage sets the origin.
      if (origin === this) return
      const enc = encoding.createEncoder()
      encoding.writeVarUint(enc, MSG_SYNC)
      syncProtocol.writeUpdate(enc, update)
      this.raw(encoding.toUint8Array(enc))
    })
    this.aw.on('update', (changes: { added: number[]; updated: number[]; removed: number[] }, origin: unknown) => {
      // Only our own presence: a tab no longer retells other people's (presence.ts · ownChanges).
      if (origin !== 'local') return
      const changed = changes.added.concat(changes.updated, changes.removed)
      if (changed.length > 0) this.sendPresence(changed)
    })
    const user: AwarenessUser = {
      id: participant.id,
      name: participant.name,
      avatar: null,
      color: participant.color,
      role: participant.role,
      activeCellId: null,
    }
    // Set before any socket: the open handler says it, so the first one is not sent twice.
    this.aw.setLocalStateField('user', user)
  }

  get name(): string {
    return this.participant.name
  }

  get host(): boolean {
    return this.participant.role === 'host'
  }

  /** Both sockets open, as the web app's `connected` asks (session.svelte.ts): what greys its buttons when false. */
  get connected(): boolean {
    return this.collab?.readyState === WS.OPEN && this.control?.readyState === WS.OPEN
  }

  open(): void {
    this.connect('collab')
    this.connect('control')
  }

  /** The cell under this person's caret, as presence says it to the room. */
  focus(id: string | null): void {
    const user = this.aw.getLocalState()?.user as AwarenessUser | undefined
    if (!user || user.activeCellId === id) return
    this.aw.setLocalStateField('user', { ...user, activeCellId: id })
  }

  private connect(channel: Channel): void {
    if (this.closed || stopping) return
    const options = this.cookie ? { headers: { cookie: this.cookie } } : undefined
    const ws = new WS(`${WSB}/${channel}/${SID}?token=${encodeURIComponent(this.token)}`, options)
    ws.binaryType = 'arraybuffer'
    let opened = false
    ws.on('upgrade', (res: IncomingMessage) => {
      const socket = res.socket
      this.live.add(socket)
      socket.once('close', () => {
        this.tcp.in += socket.bytesRead
        this.tcp.out += socket.bytesWritten
        this.live.delete(socket)
      })
    })
    let refused: number | null = null
    ws.on('error', (error: Error) => {
      count('socket errors')
      // A refused upgrade is an HTTP answer instead of the 101 (upgrade.ts · reject): ws names its status.
      const status = /Unexpected server response: (\d{3})/.exec(error.message)?.[1]
      if (status) refused = Number(status)
    })
    ws.on('open', () => {
      opened = true
    })
    ws.on('close', (code: number) => {
      if (this.closed || stopping) return
      closes.set(refused ?? code, (closes.get(refused ?? code) ?? 0) + 1)
      if (channel === 'collab') this.collab = null
      else {
        this.control = null
        if (this.pingTimer) clearInterval(this.pingTimer)
        this.pingTimer = null
      }
      // The server's word that the room is going (1001), or a door that refuses this tab (401, 404): the home is asked, never guessed.
      if (code === 1001 || refused === 401 || refused === 404) roomStillThere()
      if (channel === 'control') {
        // A ban (1008) is the one close the web app does not knock after (session.svelte.ts · #youAreBanned).
        if (code === 1008) return void count('banned')
        this.controlRetries++
        // And every fourth failure it asks the home why (session.svelte.ts · #diagnose).
        if (this.controlRetries % 4 === 0) roomStillThere()
        this.later(channel, reconnectDelay(this.controlRetries))
        return
      }
      /*
       * A refused edit (4403): the web app reloads its document. The rig's
       * class edits nothing a rule refuses, so a refusal is the rig's bug or
       * the server's, never the class's: the tab goes quiet, and the report
       * says it in red, instead of a reload that would hide it.
       */
      if (code === 4403) return void count('edits refused')
      // y-websocket's ladder: 100 ms after a live socket, doubling while they die young, up to this tab's ceiling.
      if (!opened) this.collabFailures++
      this.later(channel, Math.min(100 * 2 ** this.collabFailures, this.collabCeiling))
    })
    if (channel === 'collab') {
      this.collab = ws
      ws.on('message', (data: RawData) => this.onCollab(data))
      ws.on('open', () => {
        this.collabFailures = 0
        this.collabHeard = now()
        const enc = encoding.createEncoder()
        encoding.writeVarUint(enc, MSG_SYNC)
        syncProtocol.writeSyncStep1(enc, this.doc)
        this.raw(encoding.toUint8Array(enc))
        this.sendPresence([this.doc.clientID])
      })
    } else {
      this.control = ws
      ws.on('message', (data: RawData) => this.onControl(data))
      ws.on('open', () => {
        this.controlRetries = 0
        for (const queued of this.queue.splice(0)) this.send(queued)
        // What this connection is (session.svelte.ts · #sayDevice), then the pulse: at once, and every 25 s.
        this.send({ t: 'device', device: { kind: 'other', console: false } } as ControlClientMessage)
        const beat = () => {
          this.pingAt = now()
          this.send({ t: 'ping' } as ControlClientMessage)
        }
        beat()
        this.pingTimer = setInterval(beat, PING_EVERY_MS)
      })
    }
  }

  /** The socket opened anew after `wait`. */
  private later(channel: Channel, wait: number): void {
    const timer = setTimeout(() => {
      this.timers.delete(timer)
      reconnects[channel]++
      this.connect(channel)
    }, wait)
    this.timers.add(timer)
  }

  /** A notebook socket that heard nothing for 30 s is closed, and comes back by itself (y-websocket · messageReconnectTimeout). */
  checkSilence(): void {
    const ws = this.collab
    if (!ws || ws.readyState !== WS.OPEN || now() - this.collabHeard <= COLLAB_SILENCE_MS) return
    count('collab silent 30s')
    ws.terminate()
  }

  private raw(payload: Uint8Array): void {
    const ws = this.collab
    if (!ws || ws.readyState !== WS.OPEN) return
    try {
      ws.send(payload)
      this.payload.collabOut += payload.byteLength
    } catch {
      /* closed meanwhile: the reconnect's sync step brings what did not go */
    }
  }

  private sendPresence(clients: number[]): void {
    const enc = encoding.createEncoder()
    encoding.writeVarUint(enc, MSG_AWARENESS)
    encoding.writeVarUint8Array(enc, awarenessProtocol.encodeAwarenessUpdate(this.aw, clients))
    this.raw(encoding.toUint8Array(enc))
  }

  private write(ws: WS, message: ControlClientMessage): void {
    const textOut = JSON.stringify(message)
    try {
      ws.send(textOut)
      this.payload.controlOut += Buffer.byteLength(textOut)
    } catch {
      /* closed meanwhile */
    }
  }

  /**
   * A control message. While the socket is away, what the web app drops is
   * dropped (DISCARDED_OFFLINE) and the rest waits as it keeps it
   * (lib/controls.ts · enqueueControl): the same press once, a draft by its
   * latest, the last sixteen.
   */
  send(message: ControlClientMessage): void {
    const ws = this.control
    if (ws && ws.readyState === WS.OPEN) return void this.write(ws, message)
    if (DISCARDED_OFFLINE.has(message.t)) return
    enqueueControl(this.queue, message)
    if (this.queue.length >= MAX_QUEUED_CONTROL) count('control queue full')
  }

  /** A question for the kernel: over a live socket or not at all (session.svelte.ts · #ask). False — not asked. */
  ask(message: ControlClientMessage): boolean {
    const ws = this.control
    if (!ws || ws.readyState !== WS.OPEN) return false
    this.write(ws, message)
    return true
  }

  nextId(): number {
    return ++this.seq
  }

  private onCollab(data: RawData): void {
    this.collabHeard = now()
    const bytes = data instanceof ArrayBuffer ? new Uint8Array(data) : Array.isArray(data) ? new Uint8Array(Buffer.concat(data)) : new Uint8Array(data)
    this.payload.collabIn += bytes.byteLength
    try {
      const dec = decoding.createDecoder(bytes)
      switch (decoding.readVarUint(dec)) {
        case MSG_SYNC: {
          const enc = encoding.createEncoder()
          encoding.writeVarUint(enc, MSG_SYNC)
          const kind = syncProtocol.readSyncMessage(dec, enc, this.doc, this)
          // step2 is the server's answer to our step1: from it the tab is synced.
          if (kind === syncProtocol.messageYjsSyncStep2) this.synced = true
          if (encoding.length(enc) > 1) this.raw(encoding.toUint8Array(enc))
          break
        }
        case MSG_AWARENESS:
          awarenessProtocol.applyAwarenessUpdate(this.aw, decoding.readVarUint8Array(dec), this)
          break
      }
    } catch {
      badFrames++
      return
    }
    for (const hook of this.applied) hook()
    this.checkAll()
  }

  /** The checks this tab's frames may have satisfied, on the rig's clock of the frame that did. */
  private checkAll(): void {
    const at = now()
    for (const entry of [...this.docChecks]) {
      if (!entry.check()) continue
      this.docChecks.delete(entry)
      if (entry.timer) clearTimeout(entry.timer)
      entry.resolve(at)
    }
  }

  private onControl(data: RawData): void {
    const raw = String(data)
    this.payload.controlIn += Buffer.byteLength(raw)
    let frame: ControlServerMessage
    try {
      frame = JSON.parse(raw) as ControlServerMessage
    } catch {
      badFrames++
      return
    }
    if (frame.t === 'role') this.welcomed = true
    if (frame.t === 'pong' && this.pingAt > 0) {
      pongs.push(now() - this.pingAt)
      this.pingAt = 0
    }
    if (frame.t === 'terminal') this.terminal = frame.status
    if (frame.t === 'council:mine') {
      this.sheets.set(frame.cellId, frame.state)
      this.runs.get(frame.cellId)?.saw(frame.state.run, now())
    }
    if (this.watchesTree && (frame.t === 'files' || frame.t === 'files:delta')) this.onTree(frame)
    if (frame.t === 'error' || frame.t === 'refused') refusals.set(frame.message, (refusals.get(frame.message) ?? 0) + 1)
    // A copy: a listener may go while the frame is told.
    for (const listener of [...this.listeners]) listener(frame)
    const at = now()
    for (const entry of [...this.frameChecks]) {
      if (!entry.pick(frame)) continue
      this.frameChecks.delete(entry)
      clearTimeout(entry.timer)
      entry.resolve(at)
    }
    // A check may read what the control socket says too (the welcome, the terminal, a sheet, the files).
    this.checkAll()
  }

  /** The files panel's list, as the web app keeps it: the whole one, then the deltas laid on it. */
  private onTree(frame: Extract<ControlServerMessage, { t: 'files' | 'files:delta' }>): void {
    if (frame.t === 'files') {
      this.tree.clear()
      for (const entry of frame.files) this.tree.set(entry.path, entry)
      this.treeRev = frame.rev ?? null
      return
    }
    // A delta laid on a list this tab does not hold is not applied: the tab asks for the whole one (protocol.ts · files:delta).
    if (this.treeRev === null || frame.from !== this.treeRev) return void this.send({ t: 'files:ask' })
    for (const gone of frame.removed) this.tree.delete(gone)
    for (const entry of frame.changed) this.tree.set(entry.path, entry)
    for (const { entry } of frame.added) this.tree.set(entry.path, entry)
    this.treeRev = frame.rev
  }

  /**
   * When `check` first holds, on the rig's clock, read after every frame
   * either socket brings; null after `timeoutMs`. With `hold`, a wait whose
   * thing is still on its way when the time is up (`hold()` true) goes on,
   * looked at again every HOLD_STEP_MS, until CAP_MS from its start.
   */
  until(check: () => boolean, timeoutMs = ANSWER_MS, hold?: () => boolean): Promise<number | null> {
    if (check()) return Promise.resolve(now())
    if (stopping) return Promise.resolve(null)
    const since = now()
    return new Promise((resolve) => {
      const entry: DocCheck = { check, resolve, timer: null }
      const due = () => {
        if (hold?.() && now() - since < CAP_MS) {
          entry.timer = setTimeout(due, HOLD_STEP_MS)
          return
        }
        this.docChecks.delete(entry)
        resolve(null)
      }
      entry.timer = setTimeout(due, timeoutMs)
      this.docChecks.add(entry)
    })
  }

  /** When this tab's control socket next hears a frame `pick` takes; null after `timeoutMs`. */
  frame(pick: (frame: ControlServerMessage) => boolean, timeoutMs = ANSWER_MS): Promise<number | null> {
    if (stopping) return Promise.resolve(null)
    return new Promise((resolve) => {
      const entry: FrameCheck = {
        pick,
        resolve,
        timer: setTimeout(() => {
          this.frameChecks.delete(entry)
          resolve(null)
        }, timeoutMs),
      }
      this.frameChecks.add(entry)
    })
  }

  /** Every frame this tab's control socket hears, until the returned function is called. */
  onFrame(listener: (frame: ControlServerMessage) => void): () => void {
    this.listeners.push(listener)
    return () => {
      const at = this.listeners.indexOf(listener)
      if (at >= 0) this.listeners.splice(at, 1)
    }
  }

  /** Run after every frame this tab's document applies, before its checks. */
  onApplied(hook: () => void): void {
    this.applied.push(hook)
  }

  /** Every check still waiting answers null: the rig is stopping. */
  release(): void {
    for (const entry of this.docChecks) {
      if (entry.timer) clearTimeout(entry.timer)
      entry.resolve(null)
    }
    this.docChecks.clear()
    for (const entry of this.frameChecks) {
      clearTimeout(entry.timer)
      entry.resolve(null)
    }
    this.frameChecks.clear()
  }

  close(): void {
    this.closed = true
    this.release()
    for (const timer of this.timers) clearTimeout(timer)
    this.timers.clear()
    if (this.pingTimer) clearInterval(this.pingTimer)
    try {
      this.aw.destroy()
      this.collab?.terminate()
      this.control?.terminate()
    } catch {
      /* already closed */
    }
  }

  /** TCP bytes of every socket this tab had: those closed, and those still open as they stand. */
  wire(): { in: number; out: number } {
    let inBytes = this.tcp.in
    let outBytes = this.tcp.out
    for (const socket of this.live) {
      inBytes += socket.bytesRead
      outBytes += socket.bytesWritten
    }
    return { in: inBytes, out: outBytes }
  }
}

/** One look every three seconds at every notebook socket's silence, as y-websocket looks (a tenth of its timeout). */
let silenceTimer: NodeJS.Timeout | null = null
function watchSilence(): void {
  silenceTimer = setInterval(() => {
    for (const tab of tabs) tab.checkSilence()
  }, COLLAB_SILENCE_MS / 10)
  silenceTimer.unref()
}

/* ------------------------------------------------------------- the people */

interface Student {
  tab: Tab
  /** The notebook the student works in: the class's, or their own personal one. */
  root: string
  personal: boolean
  probe: string
  /** A cell the student types into between runs, never run: the keystrokes a class sends. */
  scratch: string
  read: { id: string; name: string; bytes: number; shows: string }
  body: Buffer | null
  uploaded: boolean
}

let SID = ''
let roomName = ''
let teacher: Tab | null = null
let assistant: Tab | null = null
const students: Student[] = []
const joinMs: number[] = []
const joinRefused = new Map<number, number>()

async function join(n: number, name: string, cookie: string | null): Promise<Tab | null> {
  const t0 = now()
  let answer: Answer
  try {
    answer = await request('POST', `/api/sessions/${SID}/join`, { json: { name }, ...(cookie ? { cookie } : {}) })
  } catch {
    count('join did not arrive')
    return null
  }
  if (answer.status !== 200) {
    joinRefused.set(answer.status, (joinRefused.get(answer.status) ?? 0) + 1)
    return null
  }
  joinMs.push(now() - t0)
  const body = parsed<JoinResponse>(answer)
  if (!body?.participant || !body.token) return null
  const tab = new Tab(n, body.participant, body.token, cookie)
  tabs.push(tab)
  tab.open()
  return tab
}

/** A code cell typed at the end of a notebook of `tab`'s, with `source`: its id. */
function addCell(tab: Tab, root: string, source: string): string {
  const cell = createCell('code', source)
  tab.doc.transact(() => bookCells(tab.doc, root).push([cell]))
  return cellId(cell)
}

/** The outputs a cell holds now, by their objects: a new run's are new ones (the server erases and writes anew). */
function outputsOf(tab: Tab, id: string): Set<unknown> {
  const found = findCell(tab.doc, id)
  return new Set(found ? cellOutputs(found.cell).toArray() : [])
}

/** The outputs that were not there before a press: what the press brought. */
function freshOutputs(tab: Tab, id: string, before: Set<unknown>): CellOutput[] {
  const found = findCell(tab.doc, id)
  if (!found) return []
  return cellOutputs(found.cell).toArray().filter((o) => !before.has(o)).map(readOutput).filter((o): o is CellOutput => o !== null)
}

const textOf = (outputs: readonly CellOutput[]) => outputs.map((o) => (o.kind === 'stream' ? o.text : o.kind === 'error' ? `${o.ename}: ${o.evalue}` : '')).join('')
const stateOf = (tab: Tab, id: string) => findCell(tab.doc, id)?.cell.get('state') as string | undefined
const settled = (tab: Tab, id: string) => {
  const state = stateOf(tab, id)
  return state === 'ok' || state === 'error'
}

/** Whether a click on this cell is still on its way: the press waits for the socket, or the cell waits in its kernel's queue or runs. */
function onItsWay(tab: Tab, id: string): boolean {
  if (!tab.connected) return true
  const state = stateOf(tab, id)
  return state === 'queued' || state === 'running'
}

/** Whether the notebook's kernel looks free in this tab's document: nothing running, nothing queued. */
function idle(tab: Tab, root: string): boolean {
  const kernel = bookKernel(tab.doc, root)
  return kernel.status === 'idle' && kernel.runningCell === null && kernel.queue.length === 0
}

/** Whether the room reads «нет связи с машиной» for this notebook's kernel now: its machine away, or the kernel moving. */
function machineAway(tab: Tab, root: string): boolean {
  const kernel = bookKernel(tab.doc, root)
  return kernel.where === 'machine' && (kernel.link === 'lost' || kernel.link === 'moving')
}

/**
 * One click on Run and what the clicker sees: the time from the press to the
 * first fresh output holding `shows`, then the wait for the cell to settle
 * (never counted). A click on its way is waited for (see the header). Null —
 * nothing came: the server never took it, or its cell ended without it.
 */
async function run(tab: Tab, id: string, shows: string, timeoutMs = ANSWER_MS): Promise<number | null> {
  const before = outputsOf(tab, id)
  tab.focus(id)
  const t0 = now()
  tab.send({ t: 'run', cellId: id })
  const at = await tab.until(() => textOf(freshOutputs(tab, id, before)).includes(shows), timeoutMs, () => onItsWay(tab, id))
  if (at === null) return null
  await tab.until(() => settled(tab, id), 10_000, () => onItsWay(tab, id))
  return at - t0
}

/** Until the tab is back, as a person waits out «Переподключение…» before pressing; false — not within the wait. */
async function online(tab: Tab, timeoutMs = 30_000): Promise<boolean> {
  return (await tab.until(() => tab.connected, timeoutMs)) !== null
}

/* ----------------------------------------------------------- the measures */

/**
 * `print(1)` from a tab, sorted by where it ran, whether its kernel was free
 * at the press, and whether the class's machine was away at it: an outage's
 * clicks wait for the outage, and their numbers are its, not the class's.
 */
async function probe(tab: Tab, id: string, root: string, personal: boolean): Promise<void> {
  const away = machineAway(tab, root)
  const free = idle(tab, root)
  const took = await run(tab, id, CELLS.print.shows)
  if (took === null) return void count('print unanswered')
  sample(away ? 'print away' : personal ? (free ? 'print own' : 'print own queued') : free ? 'print room' : 'print room queued', took)
}

/**
 * A completion, asked as the editor asks it: over a live socket only, its
 * answer awaited ASK_MS. An answer with matches is timed, by whether its
 * kernel was free at the ask; an empty one is the server's «nothing» — a
 * busy kernel's 2.5 s timeout, a machine away, no right (control.ts ·
 * askKernel) — counted, never timed.
 */
async function completion(tab: Tab, id: string, root: string): Promise<void> {
  const away = machineAway(tab, root)
  const free = idle(tab, root)
  const got = await askCompletion(tab, id)
  if (got === 'offline') return void count('completion offline')
  count('completion asked')
  if (got === 'unanswered') return void count('completion unanswered')
  if (got === 'empty') return void count('completion empty')
  sample(away ? 'completion away' : free ? 'completion' : 'completion busy', got)
}

/** One completion as the editor asks it: its time when it came with matches; not asked (the socket away), never answered, or answered empty. */
async function askCompletion(tab: Tab, id: string): Promise<number | 'offline' | 'unanswered' | 'empty'> {
  const ask = tab.nextId()
  let matches = 0
  const t0 = now()
  if (!tab.ask({ t: 'complete', id: ask, code: CELLS.completion.code, cursor: CELLS.completion.cursor, cellId: id })) return 'offline'
  const at = await tab.frame((frame) => {
    if (frame.t !== 'complete:reply' || frame.id !== ask) return false
    matches = frame.matches.length
    return true
  }, ASK_MS)
  if (at === null) return 'unanswered'
  return matches === 0 ? 'empty' : at - t0
}

/** The value line: the hover's one line about a value lying in the kernel. Answered — it named a type. Judged on asks to a free kernel. */
async function valueLine(tab: Tab, id: string, root: string): Promise<void> {
  const free = idle(tab, root) && !machineAway(tab, root)
  const ask = tab.nextId()
  let answered = false
  const t0 = now()
  if (!tab.ask({ t: 'inspect', id: ask, code: CELLS.value.code, cursor: CELLS.value.cursor, cellId: id, brief: true })) return void count('value offline')
  const at = await tab.frame((frame) => {
    if (frame.t !== 'inspect:reply' || frame.id !== ask) return false
    answered = frame.found && frame.brief !== undefined
    return true
  }, INSPECT_MS)
  if (!free) return void count('value asked busy')
  count('value asked')
  if (at === null || !answered) return
  count('value answered')
  sample('value', at - t0)
}

/** Whether the shared shell is free: the newest command in it has ended (terminal.ts · runCommand queues a new one behind it). */
function shellFree(tab: Tab): boolean {
  if (tab.terminal === 'busy') return false
  const lines = getTerminal(tab.doc)
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines.get(i)
    if (line.get('kind') === 'command') return line.get('running') !== true
  }
  return true
}

let marks = 0
/**
 * `echo` in the shared terminal: the time to the command's own output line,
 * never the echo of what was typed. Typed at the prompt, as a person types:
 * the shell holds a command for its quiet window after its output (terminal.ts
 * · QUIET_MS and the link's pad), and one typed meanwhile would wait behind
 * it, with a «waiting for the shell» line in the class's terminal. 'busy' —
 * the shell never came free, and nothing was typed.
 */
async function echo(tab: Tab, timeoutMs = 10_000): Promise<number | null | 'busy'> {
  if ((await tab.until(() => tab.connected && shellFree(tab), SHELL_WAIT_MS)) === null) return 'busy'
  const mark = `class-load-${process.pid}-${++marks}`
  const t0 = now()
  tab.send({ t: 'term:run', command: `echo ${mark}` })
  const at = await tab.until(() => getTerminal(tab.doc).toArray().some((line) => {
    const read = readTerminalLine(line)
    return read.kind === 'output' && read.text.split(/\r?\n/).some((one) => one.trim() === mark)
  }), timeoutMs)
  return at === null ? null : at - t0
}

/** A room's image by hash, fetched as an <img> fetches it: the room's ticket, then the bytes. Whether it came. */
async function fetchBlob(tab: Tab, sha: string): Promise<boolean> {
  try {
    if (!tab.ticket || tab.ticket.until < Date.now()) {
      const ticket = await request('GET', `/api/sessions/${SID}/blobs/ticket`, { bearer: tab.token })
      const token = parsed<{ token?: string }>(ticket)?.token
      if (ticket.status !== 200 || !token) return false
      secrets.add(token)
      tab.ticket = { token, until: Date.now() + 4 * 60_000 }
    }
    const got = await request('GET', `/api/sessions/${SID}/blobs/${encodeURIComponent(sha)}?token=${encodeURIComponent(tab.ticket.token)}`, { timeoutMs: 120_000, binary: true })
    return got.status === 200 && got.bytes > 0
  } catch {
    return false
  }
}

/** The images among fresh outputs: their blobs' hashes; `inline` when the server kept one in the document. */
function imagesIn(outputs: readonly CellOutput[]): { shas: string[]; inline: boolean } {
  const shas: string[] = []
  let inline = false
  for (const output of outputs) {
    if (output.kind !== 'data') continue
    for (const blob of output.blobs ?? []) if (blob.mime.startsWith('image/')) shas.push(blob.sha)
    if (Object.keys(output.data).some((mime) => mime.startsWith('image/'))) inline = true
  }
  return { shas, inline }
}

/**
 * The figure: the teacher's click, the output in the document, the bytes
 * fetched; and every viewer of the class notebook fetching it as its tab
 * draws it. In `fake` cells it is 2 MB printed (the fake has no figures):
 * the same bytes through the tunnel, nothing to fetch.
 */
async function figure(lead: Tab, id: string, viewers: readonly Tab[]): Promise<void> {
  const befores = new Map<Tab, Set<unknown>>([[lead, outputsOf(lead, id)], ...viewers.map((tab) => [tab, outputsOf(tab, id)] as [Tab, Set<unknown>])])
  const image = (tab: Tab) => imagesIn(freshOutputs(tab, id, befores.get(tab)!))
  const shown = S.cells === 'fake'
    ? (tab: Tab) => textOf(freshOutputs(tab, id, befores.get(tab)!)).includes('load-figure')
    : (tab: Tab) => {
      const found = image(tab)
      return found.inline || found.shas.length > 0
    }
  const t0 = now()
  const watching = viewers.map(async (tab) => {
    const at = await tab.until(() => shown(tab), ANSWER_MS * 2, () => onItsWay(tab, id))
    if (at === null) return
    const shas = S.cells === 'fake' ? [] : image(tab).shas
    for (const sha of shas) if (!(await fetchBlob(tab, sha))) return void count('figure fetch failed')
    sample('figure viewers', now() - t0)
  })
  lead.focus(id)
  lead.send({ t: 'run', cellId: id })
  const at = await lead.until(() => shown(lead), ANSWER_MS * 2, () => onItsWay(lead, id))
  if (at === null) {
    count('figure unanswered')
  } else {
    sample('figure shown', at - t0)
    // An image the server kept in the document is drawn as it arrives; one moved out is fetched first.
    const shas = S.cells === 'fake' ? [] : image(lead).shas
    let fetched = true
    for (const sha of shas) fetched = (await fetchBlob(lead, sha)) && fetched
    if (!fetched) count('figure fetch failed')
    else if (S.cells !== 'fake') sample('figure fetched', now() - t0)
  }
  await Promise.all(watching)
  await lead.until(() => settled(lead, id), 30_000, () => onItsWay(lead, id))
}

/** tqdm at 10 Hz: what a viewer sees of it, as the gaps between the cell's changes from the press to its end. */
async function tqdm(lead: Tab, viewer: Tab, id: string): Promise<void> {
  const found = findCell(viewer.doc, id)
  if (!found) return void count('tqdm cell missing')
  const changes: number[] = []
  const seen = () => changes.push(now())
  found.cell.observeDeep(seen)
  const before = outputsOf(viewer, id)
  const t0 = now()
  lead.focus(id)
  lead.send({ t: 'run', cellId: id })
  const at = await viewer.until(() => textOf(freshOutputs(viewer, id, before)).includes('done'), TQDM_SEC * 1000 + ANSWER_MS, () => onItsWay(viewer, id))
  found.cell.unobserveDeep(seen)
  await lead.until(() => settled(lead, id), 10_000, () => onItsWay(lead, id))
  if (at === null) return void count('tqdm unanswered')
  let longest = 0
  let last = t0
  for (const change of changes) {
    const gap = change - last
    sample('tqdm gaps', gap)
    if (gap > 1000) count('tqdm stalls')
    longest = Math.max(longest, gap)
    last = change
  }
  sample('tqdm longest', longest)
  count('tqdm updates', changes.length)
}

/**
 * A long cell: how much later than its own time its end reaches the room.
 * And the next cell pressed while it runs, as a teacher goes down the
 * notebook with Shift+Enter: its `print(1)` waits behind it, measured in
 * full in «behind its queue».
 */
async function long(lead: Tab, id: string, next: string): Promise<void> {
  const took = run(lead, id, 'done', LONG_SEC * 1000 + ANSWER_MS)
  if ((await lead.until(() => stateOf(lead, id) === 'running', ANSWER_MS, () => onItsWay(lead, id))) !== null) await probe(lead, next, CELLS_KEY, false)
  const ran = await took
  if (ran === null) return void count('long unanswered')
  sample('long overhead', Math.max(0, ran - LONG_SEC * 1000))
}

/**
 * An interrupt: the hanging cell runs (a second past the document's
 * «running», so the kernel surely has it), then the press, then its
 * KeyboardInterrupt in the document. An interrupt that does not land is
 * pressed again every five seconds, three times, as a teacher would.
 */
async function interrupt(lead: Tab, id: string): Promise<void> {
  lead.focus(id)
  lead.send({ t: 'run', cellId: id })
  if ((await lead.until(() => stateOf(lead, id) === 'running', ANSWER_MS, () => !lead.connected || stateOf(lead, id) === 'queued')) === null) return void count('interrupt never ran')
  await pause(1000)
  const t0 = now()
  for (let press = 0; press < 4 && !stopping; press++) {
    if (press > 0) count('interrupt pressed again')
    lead.send({ t: 'interrupt', cellId: id })
    const at = await lead.until(() => settled(lead, id), 5_000)
    if (at !== null) return void sample('interrupt', at - t0)
  }
  count('interrupt lost')
}

/** A file for a student's upload: a CSV whose rows name them, so the cell that reads it shows whose it is. */
function uploadBody(n: number, bytes: number): { body: Buffer; marker: string } {
  const marker = `load-${n},`
  const line = `${marker}0.5\n`
  const head = 'id,value\n'
  const filled = head + line.repeat(Math.max(1, Math.ceil((bytes - head.length) / line.length)))
  return { body: Buffer.from(filled.slice(0, Math.max(bytes, head.length + line.length))), marker }
}

/** The files panel's upload (POST /api/sessions/:id/files, multipart, field `file`), as the tab's participant; its time under `sampled`. */
async function upload(tab: Tab, name: string, body: Uint8Array, sampled: string | null = 'upload http'): Promise<boolean> {
  const form = new FormData()
  form.append('file', new Blob([body as Uint8Array<ArrayBuffer>], { type: 'application/octet-stream' }), name)
  const t0 = now()
  try {
    const answer = await request('POST', `/api/sessions/${SID}/files`, { bearer: tab.token, form, formBytes: body.byteLength, timeoutMs: 300_000 })
    if (answer.status !== 200) {
      const words = `upload: ${refusalOf(answer)}`
      refusals.set(words, (refusals.get(words) ?? 0) + 1)
      return false
    }
  } catch {
    count('upload failed')
    return false
  }
  if (sampled) sample(sampled, now() - t0)
  return true
}

/** A student's upload, then the run of the cell that reads it: upload → readable, the barrier included (§8.2). */
async function uploadAndRead(student: Student): Promise<void> {
  if (!student.body) return
  let ok = await upload(student.tab, student.read.name, student.body)
  if (!ok && !stopping) {
    await pause(2_000)
    ok = await upload(student.tab, student.read.name, student.body)
  }
  student.uploaded = true
  if (!ok) return
  // Pressed the moment the upload is in, as a student runs the cell that reads it: the barrier brings the file first.
  const took = await run(student.tab, student.read.id, student.read.shows)
  if (took === null) return void count('upload never readable')
  sample('upload readable', took)
}

/**
 * The barrier's edit (§17.5 «a 10 KB edit»): the teacher changes a 10 KB file
 * at home — a new first line each round — and runs the cell that reads it the
 * moment the change is in. On a machine the run waits until the barrier has
 * carried the change there.
 */
async function edit(lead: Tab, id: string, round: number): Promise<void> {
  const marker = `load-edit-${process.pid}-${round}`
  const body = Buffer.concat([Buffer.from(`${marker}\n`), Buffer.alloc(EDIT_BYTES - marker.length - 1, 'e')])
  if (!(await upload(lead, EDIT_FILE, body, null))) return void count('edit not uploaded')
  const took = await run(lead, id, marker)
  if (took === null) return void count('edit never readable')
  sample('edit readable', took)
}

/** The barrier's big upload (§17.5 «a 150 MB upload readable»): once a class, the upload, then its cell at once. */
async function bigUpload(lead: Tab, id: string): Promise<void> {
  const marker = `load-big-${process.pid}`
  const read = CELLS.big(BIG_BYTES, marker)
  const body = new Uint8Array(BIG_BYTES).fill(0x61)
  // The keystrokes between tabs meanwhile are the class's collaboration during the big sync (§17.5).
  heavy = 'big'
  try {
    if (!(await upload(lead, BIG_FILE, body, 'big upload http'))) return void count('big upload failed')
    if (read.marker && !(await upload(lead, BIG_MARK, Buffer.from(marker), null))) return void count('big upload failed')
    const took = await run(lead, id, read.shows, ANSWER_MS + 120_000)
    if (took === null) return void count('big upload never readable')
    sample('big readable', took)
  } finally {
    heavy = null
  }
}

const csvName = (bytes: number) => `load-csv-${bytes}.csv`
/** Whether this tab's files panel names the file at its whole size: brought here, or listed «на машине». */
function listed(tab: Tab, path: string, bytes: number): boolean {
  const entry = tab.tree.get(path)
  return entry !== undefined && !entry.dir && (entry.size === bytes || entry.onMachine?.bytes === bytes)
}

/**
 * The CSVs (§17.5 «to_csv of 1 MB and 50 MB → the panel»): once a class, the
 * teacher's cells write each size, and the watcher's files panel is timed
 * from the cell's end to the row at its whole size. A file a machine's kernel
 * wrote reaches the panel once its scan has reported it and, under the
 * room's cap, it has come here.
 */
async function csvs(lead: Tab, watcher: Tab, cells: ReadonlyArray<{ id: string; bytes: number }>): Promise<void> {
  for (const csv of cells) {
    if (stopping || !(await online(lead))) return
    const took = await run(lead, csv.id, CELLS.csv(csvName(csv.bytes), csv.bytes).shows, ANSWER_MS + 60_000)
    if (took === null) {
      count(`csv ${csv.bytes} unanswered`)
      continue
    }
    const end = now()
    const at = await watcher.until(() => listed(watcher, csvName(csv.bytes), csv.bytes), 120_000)
    if (at === null) count(`csv ${csv.bytes} never listed`)
    else sample(`csv ${csv.bytes}`, at - end)
  }
}

/* ----------------------------------------------------------- the limit */

/** The cell made to outlive the room's limit, in a second personal notebook of the first personal student so that it holds up nobody, and that notebook's first cell, its kernel's warm-up. */
let limitCell: { tab: Tab; root: string; id: string; warm: string } | null = null

/**
 * The run limit (§17.5 «Run-limit SIGINT latency ≤ 1 s after the limit»):
 * from the class's start, the cell runs until the room's limit stops it; its
 * stop is timed from its «running» in the document to its end there, less
 * the limit. One collab hop sits at each end, so it is the server's own time
 * to within the link's jitter. A cell that ran to its own end was never
 * stopped: counted, never timed.
 */
async function runLimit(): Promise<void> {
  if (!limitCell) return
  const { tab, id } = limitCell
  if (!(await online(tab))) return void count('limit cell offline')
  tab.focus(id)
  tab.send({ t: 'run', cellId: id })
  const started = await tab.until(() => stateOf(tab, id) === 'running', ANSWER_MS, () => !tab.connected || stateOf(tab, id) === 'queued')
  if (started === null) return void count('limit cell never ran')
  const ended = await tab.until(() => settled(tab, id), (RUNAWAY_SEC + 30) * 1000, () => onItsWay(tab, id))
  if (ended === null) return void count('limit cell never ended')
  const ran = ended - started
  if (stateOf(tab, id) !== 'error' || ran >= RUNAWAY_SEC * 1000) return void count('limit never fired')
  sample('limit', Math.max(0, ran - LIMIT_SEC * 1000))
}

/* ----------------------------------------------------------- the council */

let councilOpen = false
/** What the class is doing as a keystroke goes between tabs (watchCollab): a council's burst, the big upload, or nothing heavy. */
let heavy: 'burst' | 'big' | null = null
/** The councils held so far: the first one's pool starts cold. */
let councilsHeld = 0
/** The most workers the console counted up at once. */
let poolWorkers = 0
/** The most attempts a council's first burst pressed at once, and its second beside the teacher's long cell. */
let burstPresses = 0
let besidePresses = 0
/** The most epochs one burst's attempts on the pool computed on, of the first bursts and of those beside the long cell. */
const burstEpochs = { first: 0, beside: 0 }
/** §17.5 R2's burst: thirty attempts pressed at once (on eight workers, LOAD_WORKERS=8). */
const R2_BURST = 30
/** The epoch the console last named for the class notebook's pool: what a council's open is to take a newer one than. */
let poolSeq: number | null = null
/** Why attempts of a class whose council is on machines ran in the shared kernel, as their cards said it, with how often. */
const sharedWhy = new Map<string, number>()

/**
 * One press's run as its author's sheet tells it (`council:mine`): when the
 * server took it, when it began to compute, and how it ended, by the rig's
 * clock and by the server's (a run's `startedAt`: its queueing in its first
 * frame, its start once computing, kernel/index.ts · queuedRun and
 * runCouncilOne). A sheet still telling of the run before the press is not
 * this press's: its run is the first the sheet says queued or running after
 * the press, and its end the first end after that.
 */
class RunWatch {
  queuedAt: number | null = null
  runningAt: number | null = null
  endedAt: number | null = null
  /** The server's clock when it queued the run; null — its `queued` frame was not seen. */
  queuedServerAt: number | null = null
  run: CouncilRun | null = null
  private fresh = false

  constructor(readonly pressedAt: number) {}

  saw(run: CouncilRun | null, at: number): void {
    if (!run || this.endedAt !== null) return
    if (run.state === 'queued' || run.state === 'running') this.fresh = true
    if (!this.fresh) return
    if (run.state === 'queued') {
      this.queuedAt ??= at
      this.queuedServerAt ??= run.startedAt
    } else if (run.state === 'running') this.runningAt ??= at
    else {
      this.endedAt = at
      this.run = run
    }
  }

  /** The server took the press, and its run has not ended: a wait on it goes on. */
  get onItsWay(): boolean {
    return this.fresh && this.endedAt === null
  }
}

/**
 * What the teacher's console hears of the notebook's kernel and its pool
 * while a council is open (`council:kernel`, to staff only): when the pool
 * holds an epoch and a worker loaded with it, when it names one newer than
 * the pool held before the open (the open's own, §9.2: before the pool has
 * any, the newest taken; after, the newest on the pool's machine — the
 * console shows the epoch the workers may run, `usableEpoch`, which a worker
 * loads only after that), when it first named each epoch, its sentence and
 * the names an epoch left behind, and, during a burst, every frame in which
 * the notebook's own kernel computes an attempt — what the pool is there to
 * spare it.
 */
class ConsoleWatch {
  readyAt: number | null = null
  epochAt: number | null = null
  pool: CouncilPool | null = null
  /** When the console first named each epoch as the pool's, by its number. */
  readonly named = new Map<number, number>()
  /** The burst on now (its tag: '' or ' beside'): frames of the notebook's kernel busy with an attempt are counted under it; null — none. */
  burst: string | null = null
  private readonly stop: () => void

  constructor(tab: Tab, cellId: string, before: number | null) {
    this.stop = tab.onFrame((frame) => {
      if (frame.t !== 'council:kernel' || frame.cellId !== cellId) return
      const at = now()
      if (this.burst !== null && frame.kernel.busy?.kind === 'attempt') {
        count('main busy with an attempt')
        if (this.burst) count(`main busy with an attempt${this.burst}`)
      }
      const pool = frame.kernel.pool ?? null
      this.pool = pool
      if (!pool) return
      poolWorkers = Math.max(poolWorkers, pool.workers)
      if (pool.state === 'ready' && pool.epoch !== null) this.readyAt ??= at
      if (pool.epoch !== null) {
        if (before === null || pool.epoch.seq > before) this.epochAt ??= at
        if (!this.named.has(pool.epoch.seq)) this.named.set(pool.epoch.seq, at)
        poolSeq = pool.epoch.seq
      }
      if (pool.note) noted('staff', pool.note)
      const left = pool.epoch?.left ?? []
      if (left.length > 0) noted('staff', `epoch ${pool.epoch!.seq} left behind: ${left.map((one) => `${one.name} (${one.why})`).join(', ')}`)
    })
  }

  close(): void {
    this.stop()
  }
}

/** The class's one greedy student (§17.5 «a greedy attempt»): the last of a class of three or more, on the pool, in Python. */
const greedyOf = (s: Student): boolean => POOL && CELLS.greedy !== null && students.length >= 3 && s === students[students.length - 1]

/** What a student writes on their sheet: the class's attempt, or the greedy one's. */
function attemptText(s: Student, draft: number): string {
  if (greedyOf(s) && CELLS.greedy) return CELLS.greedy(GREEDY_MB, draft)
  return CELLS.attempt(s.tab.n, draft, lesson?.data != null)
}

/**
 * A council on a fresh cell of the class notebook (the header's THE
 * COUNCIL): the teacher opens it with student runs on, on the class's lane,
 * its snapshot following the kernel. The class writes for half the
 * council's time — a snapshot on every pause in typing — while the pool
 * starts and, once it holds an epoch, the teacher runs a cell after it; the
 * first burst; the class runs its changed attempts again while the
 * teacher's long cell runs beside them, one of them run by the teacher;
 * then «Обновить состояние» with nothing run since, and the teacher closes
 * it. An attempt waiting for a worker or in the shared kernel's queue, or
 * running, is on its way.
 */
async function council(lead: Tab, round: number): Promise<void> {
  councilOpen = true
  const first = councilsHeld++ === 0
  let watch: ConsoleWatch | null = null
  try {
    const writers = students.filter((s) => s.tab.connected && s.tab.synced)
    const id = addCell(lead, CELLS_KEY, CELLS.task)
    const arrived = await Promise.all(writers.map((s) => s.tab.until(() => findCell(s.tab.doc, id) !== null, 30_000)))
    if (arrived.some((at) => at === null)) count('council cell missing')
    const watching = new ConsoleWatch(lead, id, poolSeq)
    watch = watching
    const openedAt = now()
    lead.send({ t: 'cell:lock', cellId: id, state: 'council', settings: { studentRun: true, runLimitSec: 30, rerunPauseSec: 0, lane: POOL ? 'pool' : 'shared', refresh: 'auto' } })
    const opened = await Promise.all(writers.map((s) => s.tab.until(() => {
      const found = findCell(s.tab.doc, id)
      return found !== null && cellLock(found.cell) === 'council'
    }, 30_000)))
    if (opened.some((at) => at === null)) count('council never opened')
    const ready = writers.filter((_, i) => opened[i] !== null)
    const writeMs = COUNCIL_MS / 2
    say(dim(`    ${clock(Date.now())}  council · ${ready.length} writing for ${Math.round(writeMs / 1000)}s${POOL ? ' · its pool starting' : ' · the shared kernel'}`))
    // A snapshot on every pause in typing, as the sheet sends one: every two seconds or so (load.mts · COUNCIL_EVERY).
    const drafts = Math.max(1, Math.round(writeMs / Math.min(2_000, Math.max(500, writeMs / 5))))
    const writing = Promise.all(ready.map(async (s) => {
      for (let draft = 1; draft <= drafts && !stopping; draft++) {
        await pause(jitter(writeMs / drafts))
        s.tab.send({ t: 'council:draft', cellId: id, text: attemptText(s, draft + round * 100) })
        count('council drafts')
      }
    }))
    /*
     * The pool takes an epoch as the council opens (§9.2, §9.5); once its
     * workers hold the open's, the teacher runs a cell after it. The first
     * council's pool starts cold: its epoch is named once taken, and it is
     * ready once a worker has loaded it on the machine; a later one's names
     * the open's epoch once it is on the machine.
     */
    if (POOL) {
      if ((await lead.until(() => watching.readyAt !== null && watching.epochAt !== null, POOL_WAIT_MS)) === null) count('pool not ready in time')
      else if (first) {
        sample('pool epoch first', watching.epochAt! - openedAt)
        sample('pool ready first', watching.readyAt! - openedAt)
      } else sample('pool epoch', watching.epochAt! - openedAt)
    }
    if (await online(lead)) {
      const took = await run(lead, lesson!.after, 'after')
      if (took === null) count('after cell unanswered')
    }
    await writing
    if (stopping) return
    await burst(lead, id, ready, round, watching, false)
    // Again, the attempts changed, while the teacher's long cell runs: the epoch it makes stale cannot be taken before it ends (§9.2).
    const beside = lesson!.beside
    if (stopping || !(await online(lead))) return
    lead.focus(beside)
    lead.send({ t: 'run', cellId: beside })
    if ((await lead.until(() => stateOf(lead, beside) === 'running', ANSWER_MS, () => onItsWay(lead, beside))) === null) count('beside cell never ran')
    await burst(lead, id, ready, round, watching, true)
    if ((await lead.until(() => settled(lead, beside), (BESIDE_SEC + 30) * 1000, () => onItsWay(lead, beside))) === null) count('beside cell never ended')
    // It ran its own time: the room's run limit is past it (LIMIT_SEC), and the burst it held was beside a cell that ran on.
    else if (stateOf(lead, beside) !== 'ok') count('beside cell stopped')
    if (POOL) await refresh(lead, id, watching)
    lead.send({ t: 'cell:lock', cellId: id, state: 'closed' })
  } finally {
    watch?.close()
    councilOpen = false
  }
}

/**
 * One burst: the class presses «Запустить» at the teacher's word, each
 * within BURST_SPREAD_MS of the first. The first burst: the teacher's editor
 * asks the notebook's kernel for a completion meanwhile — its kernel is not
 * the attempts' — a question, never a run: every run of the notebook makes
 * the epoch stale (§9.2), and the burst would wait for a second refreeze and
 * its workers reload once more. The second, `beside` the teacher's long cell
 * (§17.5 «a 30-attempt burst while the teacher runs a 60 s cell»): one
 * student only submits, and once the class has pressed the teacher runs
 * their attempt from the console — the last pressed, the first of those
 * waiting to leave the pool's queue (D12), which the wait for a fresher
 * epoch holds whole. Each attempt is timed on its author's sheet; its
 * overhead is home's own count of its time (ranMs) past its ATTEMPT_SEC. The
 * lane is judged by the server's clock (each run's `startedAt`): no attempt
 * still waiting when the teacher's was queued may start before it.
 *
 * The epochs a burst's attempts computed on are counted. The first burst's
 * is one, the refreeze of the teacher's cell since the open, which it waited
 * for: from the console naming it on the pool's machine to the first attempt
 * computing on it is a worker's seed, its restart and load, and the dispatch
 * — the seed as the client sees it (§17.5 R2's epoch row).
 */
async function burst(lead: Tab, id: string, writers: readonly Student[], round: number, watching: ConsoleWatch, beside: boolean): Promise<void> {
  const tag = beside ? ' beside' : ''
  const hostPick = beside && writers.length > 1 ? writers[0]! : null
  const pressed: Array<{ s: Student; watch: RunWatch; host: boolean; greedy: boolean }> = []
  let firstPress = Infinity
  heavy = 'burst'
  watching.burst = tag
  try {
    say(dim(`    ${clock(Date.now())}  council · ${writers.length} attempts at once${beside ? ', the teacher\'s long cell beside them' : ''}`))
    const press = (s: Student, host: boolean): void => {
      const watch = new RunWatch(now())
      s.tab.runs.set(id, watch)
      firstPress = Math.min(firstPress, watch.pressedAt)
      if (host) lead.send({ t: 'council:run', cellId: id, participantId: s.tab.participant.id })
      else {
        s.tab.send({ t: 'council:submit', cellId: id })
        s.tab.send({ t: 'council:run', cellId: id })
      }
      pressed.push({ s, watch, host, greedy: !host && greedyOf(s) })
    }
    await Promise.all([
      ...writers.map(async (s) => {
        // Changed before the second burst, as a class fixes its attempts and runs them again.
        if (beside) s.tab.send({ t: 'council:draft', cellId: id, text: attemptText(s, round * 100 + 99) })
        if (s === hostPick) return void s.tab.send({ t: 'council:submit', cellId: id })
        await pause(Math.random() * BURST_SPREAD_MS)
        if (stopping) return
        if (!s.tab.connected) return void count('council offline')
        press(s, false)
      }),
      (async () => {
        if (!hostPick) return
        await pause(BURST_SPREAD_MS + 200)
        if (!stopping && lead.connected) press(hostPick, true)
      })(),
    ])
    if (beside) besidePresses = Math.max(besidePresses, pressed.length)
    else burstPresses = Math.max(burstPresses, pressed.length)
    await Promise.all([
      ...pressed.map(async (one) => {
        const at = await one.s.tab.until(() => one.watch.endedAt !== null, ANSWER_MS * 2, () => !one.s.tab.connected || one.watch.onItsWay)
        if (at === null) count('council unanswered')
      }),
      (async () => {
        // The notebook's kernel during the first burst: free on the pool, busy with every attempt in the shared kernel (an empty answer).
        if (beside || stopping) return
        const got = await askCompletion(lead, lesson!.probe)
        if (typeof got === 'number') sample('completion during the burst', got)
        else count(`completion during the burst ${got}`)
      })(),
    ])
  } finally {
    heavy = null
    watching.burst = null
  }
  let last = 0
  let started = Infinity
  // The epochs the burst's attempts on the pool computed on, each with when the first of them began computing there.
  const epochs = new Map<number, number>()
  for (const one of pressed) {
    const { watch } = one
    const done = watch.run
    if (watch.endedAt === null || !done) continue
    last = Math.max(last, watch.endedAt)
    sample('council', watch.endedAt - watch.pressedAt)
    if (watch.runningAt !== null) {
      started = Math.min(started, watch.runningAt)
      sample(one.host ? 'council host wait' : 'council wait', watch.runningAt - watch.pressedAt)
    }
    const placed = done.placed ?? 'shared'
    count(`council ${placed}`)
    if (beside) count(`council ${placed} beside`)
    // On a class whose council is on machines, the shared kernel took it for a reason its card says (§9.9).
    if (POOL && placed === 'shared') {
      const why = done.note ?? '(no reason on the card)'
      sharedWhy.set(why, (sharedWhy.get(why) ?? 0) + 1)
    }
    if (done.epoch) count(done.epoch.behind === 0 ? 'council fresh epoch' : done.note ? 'council older noted' : 'council older silent')
    if (placed === 'pool' && done.epoch) epochs.set(done.epoch.seq, Math.min(epochs.get(done.epoch.seq) ?? Infinity, watch.runningAt ?? Infinity))
    if (one.greedy) {
      // Judged where the pool computed it, under «Память на попытку»: in the shared kernel the class's own memory decides, and its card said why it went there.
      if (placed !== 'pool') {
        count('greedy shared')
        continue
      }
      count('greedy asked')
      count(done.state === 'error' && done.outputs.some((output) => output.kind === 'error' && output.ename === 'MemoryError') ? 'greedy memory error' : 'greedy other')
      continue
    }
    if (done.state !== 'ok') {
      count('council errors')
      continue
    }
    if (done.ranMs !== null) sample('council overhead', Math.max(0, done.ranMs - ATTEMPT_SEC * 1000))
    // Its worker's memory as it read it at its end (smaps_rollup, kB): a pool's worker only, the shared kernel's is the class's.
    const mem = placed === 'pool' ? /\bmem (\d+) (\d+) (\d+)/.exec(textOf(done.outputs)) : null
    if (mem) {
      sample('worker private', Number(mem[1]) / 1024)
      sample('worker pss', Number(mem[2]) / 1024)
      sample('worker rss', Number(mem[3]) / 1024)
    }
  }
  if (beside) burstEpochs.beside = Math.max(burstEpochs.beside, epochs.size)
  else burstEpochs.first = Math.max(burstEpochs.first, epochs.size)
  if (last > 0 && Number.isFinite(firstPress)) {
    sample(`council burst${tag}`, last - firstPress)
    // §17.5 R2's burst: thirty or more pressed at once after the teacher's cell, on the one epoch it waited for — not one refrozen again under it.
    if (!beside && pressed.length >= R2_BURST) {
      if (epochs.size === 1) sample('council burst r2', last - firstPress)
      else if (epochs.size > 1) count('council burst r2 refrozen')
    }
  }
  if (Number.isFinite(started) && Number.isFinite(firstPress)) sample(`council first start${tag}`, started - firstPress)
  /*
   * The seed, on the first burst's one epoch, which the console named after
   * the first press: the workers held the one before it, so the first
   * attempt on it began once a worker had restarted and loaded it. The
   * console's frames ride a window of their own (control.ts · nudgeKernel,
   * 250 ms) where an attempt's start is told at once: the seed is said up to
   * that much short, and one quicker than the window as 0.
   */
  if (!beside && epochs.size === 1) {
    const [seq, first] = [...epochs][0]!
    const named = watching.named.get(seq)
    if (named !== undefined && named > firstPress && Number.isFinite(first)) sample('pool seed', Math.max(0, first - named))
  }
  // The teacher's lane (D12), by the server's clock: the class's attempts still waiting when the teacher's was queued, and those of them that started first.
  const host = pressed.find((one) => one.host)
  const queuedAt = host?.watch.queuedServerAt ?? null
  const hostStart = host?.watch.run?.startedAt ?? null
  // Judged where the pool took it: the shared kernel's queue has no lane of the teacher's.
  if (queuedAt !== null && hostStart !== null && host?.watch.run?.placed === 'pool') {
    const waiting = pressed.filter((one) => !one.host && one.watch.run !== null && one.watch.run.startedAt > queuedAt)
    if (waiting.length > 0) {
      count('lane judged')
      // A few milliseconds apart are one dispatch: each worker's pump starts its attempt in a turn of its own.
      count('lane overtaken', waiting.filter((one) => one.watch.run!.startedAt < hostStart - 50).length)
    }
  }
}

/**
 * «Обновить состояние» with nothing run since the last epoch (§17.5 «an
 * unchanged refreeze»): once the refreeze the long cell held back has come,
 * the teacher presses it, and the press is timed to the console naming the
 * next epoch as the one the pool computes on — its export, and its way to
 * the pool's machine (H → C when the class notebook computes here), not the
 * workers' reload of it, which follows in the background (the seed is the
 * first burst's).
 */
async function refresh(lead: Tab, id: string, watching: ConsoleWatch): Promise<void> {
  const current = (): CouncilPool['epoch'] | null => (watching.pool?.state === 'ready' && !watching.pool.refreezing ? watching.pool.epoch : null)
  if ((await lead.until(() => current()?.behind === 0, ANSWER_MS * 2)) === null) return void count('refresh: the epoch never caught up')
  const seq = current()!.seq
  const t0 = now()
  lead.send({ t: 'council:epoch', cellId: id })
  const at = await lead.until(() => (watching.pool?.epoch?.seq ?? 0) > seq, ANSWER_MS * 2, () => watching.pool?.refreezing === true)
  if (at === null) return void count('refresh unanswered')
  sample('council refresh', at - t0)
}

/* ---------------------------------------------------------- collaboration */

let collabTimer: NodeJS.Timeout | null = null
/** The keystrokes the rig wrote into the class notebook to time them: each one an edit the server writes to the notebook's file. */
let collabEdits = 0

/**
 * A keystroke from one tab to another (§17.5 «Collaboration RTT»): the
 * teacher's tab writes a fresh word into a cell of its own, and the time
 * until the assistant's document holds it is the class's collaboration round
 * trip, through the server and back out — a document's edit, which no
 * presence frame stands in for (the server drops presence behind a slow
 * socket, collab/index.ts). Sorted by what the class does meanwhile
 * (`heavy`): a council's burst or the big upload, every COLLAB_EVERY_MS, or
 * nothing heavy, every COLLAB_QUIET_MS — the baseline the other two are
 * judged against.
 */
function watchCollab(): void {
  let busy = false
  let seq = 0
  let quietAt = -Infinity
  collabTimer = setInterval(() => {
    const cell = lesson?.collab
    const lead = teacher
    const watcher = assistant
    if (busy || stopping || !cell || !lead?.connected || !watcher?.connected) return
    const during = heavy
    if (during === null && now() - quietAt < COLLAB_QUIET_MS - COLLAB_EVERY_MS / 2) return
    const mine = findCell(lead.doc, cell)
    const theirs = findCell(watcher.doc, cell)
    if (!mine || !theirs) return
    busy = true
    if (during === null) quietAt = now()
    collabEdits++
    const word = `collab-${process.pid}-${++seq}`
    const t0 = now()
    lead.doc.transact(() => {
      const source = cellSource(mine.cell)
      source.delete(0, source.length)
      source.insert(0, word)
    })
    void watcher.until(() => cellSource(theirs.cell).toString() === word, 10_000)
      .then((at) => {
        if (at === null) count('collab unanswered')
        else sample(during ? `collab ${during}` : 'collab', at - t0)
      })
      .finally(() => (busy = false))
  }, COLLAB_EVERY_MS)
  collabTimer.unref()
}

/* ------------------------------------------------------- the machine watch */

interface MachineEvent {
  at: number
  who: 'staff' | 'room'
  what: string
}

/** What changed where the class computes: the chip's states and the notebooks' places, the timeline. */
const events: MachineEvent[] = []
const chipRtt: number[] = []
/** The sentences staff and the room were told, each once with how often it came: a repeated one is one line with its count. */
const notes = { staff: new Map<string, number>(), room: new Map<string, number>() }
/** Each role's machine as the chip last named it; null — this server. */
const where = new Map<string, string | null>()
let machineFrames = 0
let failoversSeen = 0
const unreachable = new Map<string, number>()
const unreachableMs: number[] = []

function event(who: 'staff' | 'room', what: string): void {
  events.push({ at: Date.now(), who, what })
  if (classStarted) say(dim(`    ${clock(Date.now())}  ${who} · ${what}`))
}

/** A sentence heard: said once, as it first comes, and counted every time after. */
function noted(who: 'staff' | 'room', sentence: string): void {
  const heard = notes[who].get(sentence) ?? 0
  notes[who].set(sentence, heard + 1)
  if (heard === 0 && classStarted) say(dim(`    ${clock(Date.now())}  ${who} · note: ${sentence}`))
}

/**
 * What staff hear of the class's machines (`kernel:machine`, to hosts only):
 * where each slot computes, its state, the link's round trip, staff's
 * sentence. A slot that leaves its machine — back here, or onto another one
 * — is a failover the class lived through. Both staff tabs hear every frame;
 * the assistant's are the ones written down, so none is counted twice.
 */
function watchChip(tab: Tab): void {
  const last = new Map<string, string>()
  tab.onFrame((frame) => {
    if (frame.t !== 'kernel:machine') return
    machineFrames++
    const machine: KernelMachine | null = frame.machine
    if (machine?.rttMs !== null && machine?.rttMs !== undefined) chipRtt.push(machine.rttMs)
    if (frame.note) noted('staff', frame.note)
    const state = machine ? `${machine.state} on ${machine.name}` : 'here'
    if (last.get(frame.role) === state) return
    last.set(frame.role, state)
    const was = where.get(frame.role)
    const name = machine?.name ?? null
    if (was !== undefined && was !== null && name !== was) failoversSeen++
    where.set(frame.role, name)
    const since = unreachable.get(frame.role)
    if (machine?.state === 'unreachable') {
      if (since === undefined) unreachable.set(frame.role, now())
    } else if (since !== undefined) {
      unreachableMs.push(now() - since)
      unreachable.delete(frame.role)
    }
    event('staff', `${frame.role}: ${state}${machine?.rttMs != null ? ` · ${machine.rttMs} ms` : ''}`)
  })
}

/**
 * What the room itself reads: each notebook kernel's «на машине» and link in
 * the document, and the kernel log's notes. The log is trimmed from the
 * front (kernel/terminal.ts · trim), so its lines are told apart by id, the
 * newest read back to the first one seen.
 */
function watchRoom(tab: Tab): void {
  const seen = new Map<string, string>()
  const lines = new Set<string>()
  tab.onApplied(() => {
    for (const root of kernelsMap(tab.doc)?.keys() ?? []) {
      const kernel = bookKernel(tab.doc, root)
      const state = kernel.where === 'machine' ? `on a machine, link ${kernel.link ?? '—'}` : 'here'
      const was = seen.get(root)
      if (was === state) continue
      seen.set(root, state)
      if (was !== undefined) event('room', `${root === CELLS_KEY ? 'the class notebook' : 'a personal notebook'}: ${state}`)
    }
    const terminal = getTerminal(tab.doc)
    const fresh: string[] = []
    for (let i = terminal.length - 1; i >= 0; i--) {
      const line = readTerminalLine(terminal.get(i))
      if (lines.has(line.id)) break
      lines.add(line.id)
      if (line.kind === 'system') fresh.unshift(line.text)
    }
    for (const sentence of fresh) noted('room', sentence)
  })
}

/* --------------------------------------------------- «Работают сейчас» */

interface SlotReading {
  role: string
  where: string
  heldMb: number | null
  usedMb: number[]
  cpuPercent: number[]
  card: string | null
  /** The council container's planned workers, as «Работают сейчас» says them; null for the other roles. */
  workers: number | null
}

/** The class's containers as «Работают сейчас» read them, by role and place: the memory each holds and uses, a GPU room's card. */
const slots = new Map<string, SlotReading>()
let runningTimer: NodeJS.Timeout | null = null

function slotRead(role: string, place: string, heldMb: number | null, usedMb: number | null, cpuPercent: number | null, card: string | null, workers: number | null = null): void {
  const key = `${role}@${place}`
  const reading = slots.get(key) ?? { role, where: place, heldMb, usedMb: [], cpuPercent: [], card: null, workers: null }
  reading.heldMb = heldMb ?? reading.heldMb
  if (usedMb !== null) reading.usedMb.push(usedMb)
  if (cpuPercent !== null) reading.cpuPercent.push(cpuPercent)
  reading.card = card ?? reading.card
  reading.workers = workers ?? reading.workers
  slots.set(key, reading)
}

/** One look at the class's row in «Работают сейчас» (GET /api/admin/resources/running, as staff): its containers here and its slots on machines. */
async function readRunning(): Promise<void> {
  const answer = await request('GET', '/api/admin/resources/running', { cookie: staffCookie, timeoutMs: 15_000 }).catch(() => null)
  const body = answer?.status === 200 ? parsed<RunningKernels>(answer) : null
  const mine = body?.classes.find((one) => one.id === SID) as (RunningClass & RunningClassMachines) | undefined
  if (!mine) return
  for (const container of [mine.room, mine.own]) {
    if (container) slotRead(container.role, 'here', container.reservedMb, container.usedMb, container.cpuPercent, container.role === 'room' ? mine.gpu : null)
  }
  for (const slot of mine.machines ?? []) slotRead(slot.role, slot.machine ?? 'a machine', slot.memoryMb, slot.usedMb, slot.cpuPercent, slot.card, slot.workers)
}

function watchRunning(): void {
  let busy = false
  runningTimer = setInterval(() => {
    if (busy || stopping) return
    busy = true
    void readRunning().finally(() => (busy = false))
  }, RUNNING_EVERY_MS)
}

/** The card the class's room holds, as «Работают сейчас» names it; null — none seen. */
const roomCard = () => [...slots.values()].find((slot) => slot.role === 'room' && slot.card !== null)?.card ?? null
/** What torch said of the card in a GPU class's kernel: null — not asked (fake cells, or not a GPU class). */
let cuda: boolean | null = null

/* ----------------------------------------------------------------- health */

const health = { ms: [] as number[], lag: [] as number[], failed: 0 }
let healthTimer: NodeJS.Timeout | null = null

/** The home's /api/health with the staff cookie, which adds its event loop's lag. */
function watchHealth(): void {
  let busy = false
  healthTimer = setInterval(() => {
    if (busy || stopping) return
    busy = true
    const t0 = now()
    request('GET', '/api/health', { cookie: staffCookie, timeoutMs: 5_000 })
      .then((answer) => {
        health.ms.push(now() - t0)
        const lag = parsed<{ loopLagMs?: number }>(answer)?.loopLagMs
        if (typeof lag === 'number') health.lag.push(lag)
      })
      .catch(() => health.failed++)
      .finally(() => (busy = false))
  }, HEALTH_EVERY_MS)
}

/* ------------------------------------------------------------- the room */

/*
 * The seminar's creation as the rig knows it: `pending` while the POST has
 * no answer, `made` once its answer named the room, `refused` when the home
 * answered without one, `unknown` when the request ended with no answer at
 * all — the home may hold the room all the same.
 */
let creation: 'none' | 'pending' | 'made' | 'refused' | 'unknown' = 'none'
let creating: Promise<void> | null = null
let deleted = false
let classStarted = false
let classStartedAt = 0
let classEndedAt = 0
let roundsHeld = 0
let placementLine = ''
/** Tabs with both sockets open at the class's end, staff's and the students'; null — the class did not reach its end. */
let tabsUp: { staff: number; students: number } | null = null

async function makeRoom(): Promise<string | null> {
  // A tag of this run's own: a room whose creation is never answered is found by its name (cleanup · roomsNamed).
  roomName = `class-load ${new Date().toISOString().slice(0, 16)} ${randomBytes(3).toString('hex')}`
  creation = 'pending'
  // Settled once the creation's state is known, its room's id with it: the cleanup waits on it.
  let known = () => {}
  creating = new Promise<void>((resolve) => (known = resolve))
  let made: Answer
  try {
    made = await request('POST', '/api/admin/seminars', {
      cookie: staffCookie,
      json: {
        name: roomName,
        ...(environment ? { environment } : {}),
        ...(S.cpus !== null ? { cpus: S.cpus } : {}),
        ...(S.memoryMb !== null ? { memoryMb: S.memoryMb } : {}),
        // Personal notebooks are off in an open room; the class turns them on for the share that uses them. The limit: see LIMIT_SEC.
        rules: { ownBooks: STUDENTS_OWN > 0 ? 'on' : 'off', cellLimitSec: LIMIT_SEC },
      },
    })
  } catch (error) {
    creation = 'unknown'
    known()
    return `the seminar's create had no answer: ${errorText(error)}`
  }
  const id = parsed<{ id?: string }>(made)?.id
  if (made.status !== 201 || typeof id !== 'string' || !id) {
    creation = 'refused'
    known()
    return `the seminar was not created: ${refusalOf(made)}`
  }
  SID = id
  creation = 'made'
  known()
  if (stopping) return 'stopped'
  const set = await request('PATCH', `/api/admin/seminars/${SID}`, { cookie: staffCookie, json: { placement: PLACEMENT } })
  if (set.status !== 200) return `the class's placement was refused: ${refusalOf(set)}`
  return null
}

/**
 * Whether the home itself says the rig's room is gone: its public door
 * (GET /api/sessions/:id) answers 404 in its own words (SESSION_MISSING, as
 * the web app reads it: identity.ts · verdictOnFailure). True — gone; false
 * — the home shows it; null — no verdict: the relay's own 404 page for a
 * home it cannot reach, a 5xx, no answer.
 */
async function roomGone(id = SID): Promise<boolean | null> {
  if (!id) return null
  try {
    const answer = await request('GET', `/api/sessions/${id}`, { timeoutMs: 15_000 })
    if (answer.status === 200) return false
    if (answer.status === 404 && answer.type.includes('application/json') && parsed<{ error?: unknown }>(answer)?.error === SESSION_MISSING) return true
    return null
  } catch {
    return null
  }
}

let asking: Promise<void> | null = null

/**
 * Whether the rig's room is still there, asked when a socket is refused or
 * told the room is going: someone deleted it in the panel, and its tabs would
 * knock and every click wait until the class's end. Gone by the home's own
 * word, the run ends at once; a relay's 404 for a home it cannot reach ends
 * nothing (§17.5's injects restart the home and block its leg), and the tabs
 * keep knocking. One question at a time.
 */
function roomStillThere(): void {
  if (asking || stopping || !SID) return
  asking = roomGone()
    .then((gone) => {
      if (gone === true) endRun(`seminar ${SID} was deleted under the rig: the run ends`)
    })
    .finally(() => (asking = null))
}

/** The class's own refusal stands this long before the rig believes it: the home looks the class's image up just after the PATCH (§6.6). */
const CLASS_REFUSAL_MS = 15_000
/** A machine's refusal, this long: a machine fresh from its rent may still be pulling a kernel image of gigabytes. */
const MACHINE_REFUSAL_MS = 10 * 60_000

/**
 * Until the class form's live line names a machine that takes the class
 * (GET /api/admin/seminars/:id/placement): a class set to machines with none
 * to take it would fall back here, and the rig would measure this server
 * while saying «машины». The class's own refusal (its image not portable,
 * blocked ranges, no machine open to classes) ends the run once it has
 * stood for CLASS_REFUSAL_MS; the machines' refusals are waited out longer,
 * and said every half a minute meanwhile. A GPU class's machines refuse by
 * themselves without a card (placement.ts · eligibility, 'card').
 */
async function machinesTakeIt(): Promise<string | null> {
  const started = now()
  let refusedSince: number | null = null
  let toldAt = started
  let last: ClassPlacementOutlook | null = null
  const machinesSay = (outlook: ClassPlacementOutlook) => outlook.machines.map((m) => `${m.name}: ${m.refusal}`).join(', ') || 'no machine takes classes'
  while (!stopping && now() - started < MACHINE_REFUSAL_MS) {
    const answer = await request('GET', `/api/admin/seminars/${SID}/placement`, { cookie: staffCookie }).catch(() => null)
    last = answer?.status === 200 ? parsed<ClassPlacementOutlook>(answer) : null
    const taking = last?.machines.filter((machine) => machine.refusal === null) ?? []
    if (last && last.refusal === null && taking.length > 0) {
      placementLine = taking.map((m) => {
        const facts = [m.freeMb !== null ? `${megabytes(m.freeMb)} free` : null, gpuClass ? `${m.cards} ${m.cards === 1 ? 'card' : 'cards'}` : null, m.rttP95Ms !== null ? `p95 ${m.rttP95Ms} ms` : null, m.far ? 'far' : null].filter(Boolean)
        return facts.length ? `${m.name} (${facts.join(' · ')})` : m.name
      }).join(', ')
      return null
    }
    if (last?.refusal) {
      refusedSince ??= now()
      if (now() - refusedSince >= CLASS_REFUSAL_MS) return `no machine takes this class: ${last.refusal}`
    } else {
      refusedSince = null
      if (last && now() - toldAt >= 30_000) {
        toldAt = now()
        say(dim(`    ${clock(Date.now())}  waiting for a machine: ${machinesSay(last)}`))
      }
    }
    await pause(1_000)
  }
  if (stopping) return 'stopped'
  return `no machine takes this class: ${last ? (last.refusal ?? machinesSay(last)) : 'the outlook did not answer'}`
}

/* --------------------------------------------------------------- the class */

/** Every tab in, synced and welcomed; the teacher first, as the class's first comer warms its kernel up. */
async function joinEveryone(): Promise<void> {
  teacher = await join(0, 'Teacher (class-load)', staffCookie)
  if (!teacher) throw new Error('the teacher could not join the room')
  await teacher.until(() => teacher!.synced && teacher!.welcomed, 30_000)
  if (!teacher.host) throw new Error('the teacher joined without the host\'s role: the staff cookie is not this room\'s')
  assistant = await join(-1, 'Assistant (class-load)', staffCookie)
  if (!assistant) throw new Error('the assistant could not join the room')
  assistant.watchesTree = true
  watchChip(assistant)
  watchRoom(assistant)
  const gap = S.students > 1 ? (S.rampSec * 1000) / S.students : 0
  const joining: Array<Promise<Tab | null>> = []
  for (let n = 1; n <= S.students && !stopping; n++) {
    joining.push(join(n, `Student ${n}`, null))
    if (gap > 0 && n < S.students) await pause(gap)
  }
  await Promise.all(joining)
  await Promise.all(tabs.map((tab) => tab.until(() => tab.synced && tab.welcomed, 60_000)))
}

/** The lesson's cells in the class notebook, typed by the teacher once: each act runs its own cell again and again. */
interface Lesson {
  probe: string
  value: string
  figure: string
  tqdm: string
  long: string
  hang: string
  edit: string
  big: string | null
  csvs: Array<{ id: string; bytes: number }>
  /** The teacher's cell after a council's epoch, and the long one its second burst runs beside. */
  after: string
  beside: string
  /** The cell the teacher's tab types into for the keystrokes between tabs (watchCollab): markdown, never run. */
  collab: string
  /** The cell that gives the class notebook's kernel the epoch's data (LOAD_EPOCH_MB); null — none. */
  data: string | null
}

let lesson: Lesson | null = null

/** A personal notebook of the student's own, made as «Новая тетрадь» makes it: its root and its first cell, which the server made. */
async function personalNotebook(tab: Tab, path: string, source: string): Promise<{ root: string; first: string } | null> {
  tab.send({ t: 'tree:new', path })
  const book = await tab.until(() => {
    const found = bookAt(tab.doc, path)
    return found !== null && bookCells(tab.doc, found.root).length > 0
  }, 30_000)
  if (book === null) return null
  const root = bookAt(tab.doc, path)!.root
  const first = bookCells(tab.doc, root).get(0)
  tab.doc.transact(() => {
    const text = cellSource(first)
    text.delete(0, text.length)
    text.insert(0, source)
  })
  return { root, first: cellId(first) }
}

async function prepare(): Promise<void> {
  const lead = teacher!
  lead.send({ t: 'term:open' })
  lesson = {
    probe: addCell(lead, CELLS_KEY, CELLS.print.source),
    value: addCell(lead, CELLS_KEY, CELLS.setup),
    figure: addCell(lead, CELLS_KEY, CELLS.figure.source),
    tqdm: addCell(lead, CELLS_KEY, CELLS.tqdm(TQDM_SEC)),
    long: addCell(lead, CELLS_KEY, CELLS.long(LONG_SEC)),
    hang: addCell(lead, CELLS_KEY, CELLS.hang),
    edit: addCell(lead, CELLS_KEY, CELLS.edit),
    big: BIG_BYTES > 0 ? addCell(lead, CELLS_KEY, CELLS.big(BIG_BYTES, '').source) : null,
    csvs: CSV_BYTES.map((bytes) => ({ id: addCell(lead, CELLS_KEY, CELLS.csv(csvName(bytes), bytes).source), bytes })),
    after: addCell(lead, CELLS_KEY, CELLS.after),
    beside: addCell(lead, CELLS_KEY, CELLS.long(BESIDE_SEC)),
    collab: (() => {
      const cell = createCell('markdown', '…')
      lead.doc.transact(() => bookCells(lead.doc, CELLS_KEY).push([cell]))
      return cellId(cell)
    })(),
    data: S.epochMb > 0 && CELLS.data ? addCell(lead, CELLS_KEY, CELLS.data(S.epochMb).source) : null,
  }
  if (CELLS.figure.upload && !(await upload(lead, CELLS.figure.upload.name, CELLS.figure.upload.body, null))) count('figure file not uploaded')
  const cudaCell = gpuClass && CELLS.cuda ? addCell(lead, CELLS_KEY, CELLS.cuda.source) : null

  // A share of the class in personal notebooks, spread through it: every other student when the share is a half.
  const own = new Set<number>()
  for (let i = 0; i < STUDENTS_OWN; i++) own.add(Math.floor((i * S.students) / Math.max(STUDENTS_OWN, 1)) + 1)
  const firstOwn = Math.min(...own)
  const synced = tabs.filter((tab) => tab.n > 0 && tab.synced)
  await Promise.all(synced.map(async (tab) => {
    const name = `load-${tab.n}.csv`
    const made = S.uploadKb > 0 ? uploadBody(tab.n, S.uploadKb * 1024) : null
    const read = CELLS.read(name, made?.body.length ?? 0, made?.marker ?? '')
    let root = CELLS_KEY
    let probeId: string
    if (own.has(tab.n)) {
      // «Новая тетрадь» in a room where personal notebooks are on: the student's own, its first cell made by the server.
      const book = await personalNotebook(tab, `student-${tab.n}.ipynb`, CELLS.print.source)
      if (book === null) return void count('personal notebook not made')
      root = book.root
      probeId = book.first
      if (tab.n === firstOwn) {
        // A second one of the same student's for the run limit: its own kernel, so the cell that outlives the limit holds up nobody.
        const spare = await personalNotebook(tab, `student-${tab.n}-limit.ipynb`, CELLS.print.source)
        if (spare === null) count('limit notebook not made')
        else limitCell = { tab, root: spare.root, id: addCell(tab, spare.root, CELLS.long(RUNAWAY_SEC)), warm: spare.first }
      }
    } else {
      probeId = addCell(tab, CELLS_KEY, CELLS.print.source)
    }
    const readId = addCell(tab, root, read.source)
    const scratch = addCell(tab, root, `# ${tab.name}'s notes\n`)
    students.push({ tab, root, personal: root !== CELLS_KEY, probe: probeId, scratch, read: { id: readId, name, bytes: made?.body.length ?? 0, shows: read.shows }, body: made?.body ?? null, uploaded: false })
  }))
  if (students.length < synced.length) count('students not prepared', synced.length - students.length)

  // The server has what everyone typed once the assistant's document holds it: it sends one frame to the whole room.
  const typed = [lesson.probe, lesson.value, lesson.figure, lesson.tqdm, lesson.long, lesson.hang, lesson.edit, lesson.after, lesson.beside, lesson.collab, ...(lesson.data ? [lesson.data] : []), ...(lesson.big ? [lesson.big] : []), ...lesson.csvs.map((csv) => csv.id), ...students.flatMap((s) => [s.probe, s.read.id, s.scratch]), ...(limitCell ? [limitCell.id] : [])]
  if ((await assistant!.until(() => typed.every((id) => findCell(assistant!.doc, id) !== null), 30_000)) === null) count('cells the server never had')

  // First runs, apart from the class's numbers: the class notebook's kernel (warm since the teacher came in) and each personal one's.
  const firstRoom = await run(lead, lesson.probe, CELLS.print.shows, 180_000)
  if (firstRoom === null) throw new Error('the class notebook\'s first run showed nothing in three minutes')
  sample('first run room', firstRoom)
  // The value line's binding: a cell that prints nothing, so its end is its state.
  lead.send({ t: 'run', cellId: lesson.value })
  if ((await lead.until(() => settled(lead, lesson!.value), 60_000, () => onItsWay(lead, lesson!.value))) === null) count('value cell never ran')
  // The epoch's data, made once before the class (LOAD_EPOCH_MB): every council's export carries it.
  if (lesson.data && CELLS.data) {
    const took = await run(lead, lesson.data, CELLS.data(S.epochMb).shows, 600_000)
    if (took === null) count('data cell unanswered')
    else sample('data cell', took)
  }
  await Promise.all([
    ...students.map(async (s) => {
      const took = await run(s.tab, s.probe, CELLS.print.shows, 180_000)
      if (took === null) count('first run unanswered')
      else sample(s.personal ? 'first run own' : 'first run room', took)
    }),
    // The limit's notebook warmed too, unmeasured: its cell's limit counts from its work, and its kernel's start is not that.
    (async () => {
      if (limitCell && (await run(limitCell.tab, limitCell.warm, CELLS.print.shows, 180_000)) === null) count('limit notebook never ran')
    })(),
  ])
  // A GPU class's kernel asked about its card, once: what the cell printed when it ended (no torch at all is an error, and an answer).
  if (cudaCell && CELLS.cuda) {
    const before = outputsOf(lead, cudaCell)
    lead.send({ t: 'run', cellId: cudaCell })
    if ((await lead.until(() => settled(lead, cudaCell), 120_000, () => onItsWay(lead, cudaCell))) !== null) cuda = textOf(freshOutputs(lead, cudaCell, before)).includes(CELLS.cuda.shows)
  }
  // The shared terminal comes up with its first command.
  const first = await echo(lead, 60_000)
  if (first === null || first === 'busy') count('terminal never answered')
}

async function teacherRound(r: number): Promise<void> {
  const lead = teacher!
  const at = lesson!
  const viewers = [assistant!, ...students.filter((s) => !s.personal).map((s) => s.tab)]
  const acts: Array<() => Promise<void>> = [
    async () => {
      for (let i = 0; i < EACH && !stopping; i++) {
        if (!(await online(lead))) return void count('teacher offline')
        const took = await echo(lead)
        if (took === 'busy') count('echo: the shell stayed busy')
        else if (took === null) count('echo unanswered')
        else sample('echo', took)
        await pause(200)
      }
    },
    async () => {
      for (let i = 0; i < EACH && !stopping; i++) {
        if (!(await online(lead))) return void count('teacher offline')
        await completion(lead, at.probe, CELLS_KEY)
        await valueLine(lead, at.value, CELLS_KEY)
        await pause(200)
      }
    },
    async () => {
      for (let i = 0; i < EACH && !stopping; i++) {
        if (!(await online(lead))) return void count('teacher offline')
        await lead.until(() => idle(lead, CELLS_KEY), 5_000)
        await probe(lead, at.probe, CELLS_KEY, false)
        await pause(300)
      }
    },
    async () => {
      if ((r - 1) % FIGURE_EVERY_ROUNDS === 0 && (await online(lead))) await figure(lead, at.figure, viewers)
    },
    async () => {
      if (await online(lead)) await edit(lead, at.edit, r)
    },
    async () => {
      if (await online(lead)) await tqdm(lead, assistant!, at.tqdm)
    },
    async () => {
      if (await online(lead)) await long(lead, at.long, at.probe)
    },
    async () => {
      for (let i = 0; i < EACH && !stopping; i++) {
        if (!(await online(lead))) return void count('teacher offline')
        await interrupt(lead, at.hang)
      }
    },
    async () => {
      // Once a class: the CSVs to the panel and the big upload read back.
      if (r !== 1) return
      await csvs(lead, assistant!, at.csvs)
      if (at.big && (await online(lead))) await bigUpload(lead, at.big)
    },
    () => council(lead, r),
  ]
  /*
   * Each act starts at its share of the round, the council taking three: its
   * writing, two bursts and the long cell beside the second are two and a
   * half minutes of an hour's round, where every other act is one.
   */
  const shares = acts.map((_, i) => (i === acts.length - 1 ? COUNCIL_SHARES : 1))
  const whole = shares.reduce((sum, one) => sum + one, 0)
  const start = now()
  let before = 0
  for (let i = 0; i < acts.length && !stopping; i++) {
    // Only the first round is always whole: later ones end with the class.
    if (r > 1 && now() >= classStartedAt + CLASS_MS) return
    await pause(start + (before * ROUND_MS) / whole - now())
    before += shares[i]!
    await acts[i]!()
  }
}

/** A line typed into the student's scratch cell a few keys at a time, as an editor sends a word: one update each. */
function type(s: Student, turn: number): void {
  const found = findCell(s.tab.doc, s.scratch)
  if (!found) return
  s.tab.focus(s.scratch)
  const source = cellSource(found.cell)
  for (const piece of ['y', `${turn % 10}`, ' = ', 'x', ` + ${turn}`, '\n']) s.tab.doc.transact(() => source.insert(source.length, piece))
}

/**
 * A student's turns until the class ends: a line typed, `print(1)`, every
 * other turn a completion, once the upload and its read. With the room away
 * the student types on (the notebook is local-first) and presses nothing:
 * Run is grey, the editor asks nothing.
 */
async function studentTurns(s: Student, end: number): Promise<void> {
  const uploadAt = classStartedAt + (0.1 + 0.4 * Math.random()) * ROUND_MS
  let turn = 0
  while (!stopping && now() < end) {
    await pause(jitter(TURN_MS))
    if (stopping || now() >= end) return
    // A student writing their council attempt runs nothing else meanwhile.
    if (councilOpen) continue
    turn++
    type(s, turn)
    if (!s.tab.connected) {
      count('turns offline')
      continue
    }
    await probe(s.tab, s.probe, s.root, s.personal)
    if (turn % 2 === 0 && !stopping) await completion(s.tab, s.probe, s.root)
    if (!s.uploaded && !stopping && now() >= uploadAt && s.tab.connected) await uploadAndRead(s)
  }
}

async function holdClass(): Promise<void> {
  classStarted = true
  classStartedAt = now()
  const end = classStartedAt + CLASS_MS
  watchRunning()
  watchCollab()
  // A turn that throws is the rig's fault, never the class's: it is counted, and the others go on.
  const failed = (what: string) => (error: unknown) => {
    count('turns failed')
    warn(red(`  ${what} stopped: ${errorText(error)}`))
  }
  const turns = students.map((s) => studentTurns(s, end).catch(failed('a student\'s turns')))
  // The cell that outlives the room's limit runs from the class's start, alongside it.
  const limit = runLimit().catch(failed('the run limit\'s cell'))
  for (let r = 1; r <= ROUNDS && !stopping; r++) {
    if (r > 1 && now() >= end) break
    const chips = [...where].map(([role, name]) => `${role} ${name ?? 'here'}`).join(' · ')
    const probes = ['print room', 'print room queued', 'print own', 'print own queued', 'print away'].reduce((sum, key) => sum + taken(key).length, 0)
    say(dim(`    ${clock(Date.now())}  round ${r}/${ROUNDS} · ${tabs.filter((t) => t.connected).length} tabs up · ${probes} probes so far${chips ? ` · ${chips}` : ''}`))
    await teacherRound(r)
    roundsHeld = r
  }
  // The class ends on time: the students' turns stop with it, the teacher's first round may run past it.
  await pause(end - now())
  classEndedAt = now()
  tabsUp = { staff: tabs.filter((tab) => tab.n <= 0 && tab.connected).length, students: tabs.filter((tab) => tab.n > 0 && tab.connected).length }
  // A turn caught mid-click finishes it, within reason, and the limit's cell its stop.
  await Promise.race([Promise.all([...turns, limit]), pause(Math.max(10_000, classStartedAt + (RUNAWAY_SEC + 15) * 1000 - now()))])
  // The class's containers as they stand at its end.
  await readRunning()
}

/* ---------------------------------------------------------------- report */

function bytesTotals() {
  let tcpIn = 0
  let tcpOut = 0
  const payload = { collabIn: 0, collabOut: 0, controlIn: 0, controlOut: 0 }
  for (const tab of tabs) {
    const wire = tab.wire()
    tcpIn += wire.in
    tcpOut += wire.out
    for (const key of Object.keys(payload) as Array<keyof typeof payload>) payload[key] += tab.payload[key]
  }
  return { sent: tcpOut + http.sent, received: tcpIn + http.received, sockets: { in: tcpIn, out: tcpOut }, http: { sent: http.sent, received: http.received, requests: http.requests, failed: http.failed }, payload }
}

/** The class notebook's file as the assistant's files panel last listed it, in bytes: what one of the probe's edits has the server write and push; null — not listed. */
function notebookFileBytes(): number | null {
  const tab = assistant
  const path = tab ? bookList(tab.doc).find((book) => book.root === CELLS_KEY)?.path : undefined
  const entry = path ? tab!.tree.get(path) : undefined
  return entry && !entry.dir ? entry.size : null
}

const sentences = (heard: Map<string, number>) => [...heard].map(([sentence, times]) => ({ text: sentence, count: times }))

function summary(interrupted: boolean) {
  const minutes = classEndedAt > classStartedAt ? (classEndedAt - classStartedAt) / 60_000 : 0
  const bytes = bytesTotals()
  const machine = Object.fromEntries([...where].map(([role, name]) => [role, name]))
  return {
    classLoad: 1,
    base: S.base,
    seminar: SID || null,
    deleted,
    interrupted,
    endedBy,
    class: S.preset,
    placement: PLACEMENT,
    environment,
    gpuClass,
    cells: S.cells,
    students: S.students,
    own: S.ownShare,
    joined: tabs.filter((tab) => tab.n > 0).length,
    synced: tabs.filter((tab) => tab.n > 0 && tab.synced).length,
    personal: students.filter((s) => s.personal).length,
    tabsUp,
    minutes: Math.round(minutes * 100) / 100,
    rounds: roundsHeld,
    join: { ...spread(joinMs), refused: Object.fromEntries(joinRefused) },
    numbers: {
      print: {
        room: spread(taken('print room')),
        roomQueued: spread(taken('print room queued')),
        own: spread(taken('print own')),
        ownQueued: spread(taken('print own queued')),
        away: spread(taken('print away')),
        firstRoom: spread(taken('first run room')),
        firstOwn: spread(taken('first run own')),
        unanswered: counted('print unanswered'),
      },
      completion: {
        free: spread(taken('completion')),
        busy: spread(taken('completion busy')),
        away: spread(taken('completion away')),
        asked: counted('completion asked'),
        empty: counted('completion empty'),
        unanswered: counted('completion unanswered'),
        offline: counted('completion offline'),
      },
      value: { ...spread(taken('value')), asked: counted('value asked'), answered: counted('value answered'), askedBusy: counted('value asked busy'), offline: counted('value offline') },
      interrupt: { ...spread(taken('interrupt')), pressedAgain: counted('interrupt pressed again'), lost: counted('interrupt lost') },
      echo: { ...spread(taken('echo')), unanswered: counted('echo unanswered'), shellBusy: counted('echo: the shell stayed busy') },
      figure: { shown: spread(taken('figure shown')), fetched: spread(taken('figure fetched')), viewers: spread(taken('figure viewers')), unanswered: counted('figure unanswered'), fetchFailed: counted('figure fetch failed') },
      tqdm: { updates: counted('tqdm updates'), longest: spread(taken('tqdm longest')), gaps: spread(taken('tqdm gaps')), stalls: counted('tqdm stalls'), unanswered: counted('tqdm unanswered') },
      long: { overhead: spread(taken('long overhead')), unanswered: counted('long unanswered') },
      limit: { sec: LIMIT_SEC, past: spread(taken('limit')), neverFired: counted('limit never fired'), measured: limitCell !== null },
      upload: { http: spread(taken('upload http')), readable: spread(taken('upload readable')), failed: counted('upload failed'), neverReadable: counted('upload never readable') },
      edit: { kb: EDIT_BYTES / 1024, readable: spread(taken('edit readable')), notUploaded: counted('edit not uploaded'), neverReadable: counted('edit never readable') },
      big: { mb: S.bigMb, http: spread(taken('big upload http')), readable: spread(taken('big readable')), failed: counted('big upload failed'), neverReadable: counted('big upload never readable') },
      csv: CSV_BYTES.map((bytes) => ({ bytes, mb: Number((bytes / MB).toFixed(3)), toPanel: spread(taken(`csv ${bytes}`)), unanswered: counted(`csv ${bytes} unanswered`), neverListed: counted(`csv ${bytes} never listed`) })),
      council: {
        lane: POOL ? 'pool' : 'shared',
        workers: PLACEMENT.workers ?? null,
        attemptMb: PLACEMENT.attemptMb ?? null,
        attemptSec: ATTEMPT_SEC,
        councils: councilsHeld,
        ...spread(taken('council')),
        wait: spread(taken('council wait')),
        overhead: spread(taken('council overhead')),
        burst: spread(taken('council burst')),
        firstStart: spread(taken('council first start')),
        /** The most attempts a first burst pressed at once, and the most epochs a first burst's attempts on the pool computed on (one: the refreeze it waited for). */
        presses: burstPresses,
        burstEpochs: burstEpochs.first,
        /** §17.5 R2's: the first bursts of R2_BURST or more pressed at once that computed on one epoch, and those refrozen again under them. */
        r2: { size: R2_BURST, burst: spread(taken('council burst r2')), refrozen: counted('council burst r2 refrozen') },
        beside: {
          sec: BESIDE_SEC,
          burst: spread(taken('council burst beside')),
          firstStart: spread(taken('council first start beside')),
          presses: besidePresses,
          burstEpochs: burstEpochs.beside,
          placed: { pool: counted('council pool beside'), shared: counted('council shared beside') },
          busyWithAttempt: counted('main busy with an attempt beside'),
          /** The long cell ended otherwise than by itself: the run limit or a stop under the burst it held. */
          stopped: counted('beside cell stopped'),
        },
        host: { ...spread(taken('council host wait')), judged: counted('lane judged'), overtaken: counted('lane overtaken') },
        placed: { pool: counted('council pool'), shared: counted('council shared'), why: Object.fromEntries(sharedWhy) },
        epochs: { fresh: counted('council fresh epoch'), noted: counted('council older noted'), silent: counted('council older silent') },
        pool: {
          workers: poolWorkers,
          epochFirst: spread(taken('pool epoch first')),
          readyFirst: spread(taken('pool ready first')),
          waitMs: POOL_WAIT_MS,
          epoch: spread(taken('pool epoch')),
          notReady: counted('pool not ready in time'),
          refresh: spread(taken('council refresh')),
          refreshUnanswered: counted('refresh unanswered') + counted('refresh: the epoch never caught up'),
          /** The console naming the epoch a first burst waited for → its first attempt computing on it: a worker's restart and load, and the dispatch. */
          seed: spread(taken('pool seed')),
        },
        data: { mb: S.epochMb, cell: spread(taken('data cell')), unanswered: counted('data cell unanswered') },
        memory: { privateMb: spread(taken('worker private')), pssMb: spread(taken('worker pss')), rssMb: spread(taken('worker rss')) },
        /** The greedy attempts the pool computed (`asked`), and those the shared kernel took, whose reasons are with every shared card's (`placed.why`). */
        greedy: { mb: GREEDY_MB, asked: counted('greedy asked'), memoryError: counted('greedy memory error'), other: counted('greedy other'), shared: counted('greedy shared') },
        errors: counted('council errors'),
        main: {
          completionDuringBurst: spread(taken('completion during the burst')),
          completionEmpty: counted('completion during the burst empty'),
          completionUnanswered: counted('completion during the burst unanswered') + counted('completion during the burst offline'),
          busyWithAttempt: counted('main busy with an attempt'),
        },
        drafts: counted('council drafts'),
        unanswered: counted('council unanswered'),
      },
      collab: { quiet: spread(taken('collab')), burst: spread(taken('collab burst')), big: spread(taken('collab big')), unanswered: counted('collab unanswered') },
      controlRtt: spread(pongs),
    },
    machine: {
      where: machine,
      frames: machineFrames,
      rtt: spread(chipRtt),
      unreachable: spread(unreachableMs),
      failovers: failoversSeen,
      containers: [...slots.values()].map((slot) => ({ role: slot.role, where: slot.where, heldMb: slot.heldMb, usedMb: spread(slot.usedMb), cpuPercent: spread(slot.cpuPercent), card: slot.card, workers: slot.workers })),
      gpu: { card: roomCard(), cuda },
      staffNotes: sentences(notes.staff),
      roomNotes: sentences(notes.room),
      events: events.map((e) => ({ at: new Date(e.at).toISOString(), who: e.who, what: e.what })),
    },
    health: { ms: spread(health.ms), loopLag: spread(health.lag), failed: health.failed },
    rig: { loopLag: spread(selfLag) },
    bytes: {
      ...bytes,
      perTabHour: minutes > 0 && tabs.length > 0 ? Math.round(((bytes.sent + bytes.received) / Math.max(1, tabs.length)) * (60 / minutes)) : null,
      datasets: CSV_BYTES.reduce((sum, one) => sum + one, 0) + BIG_BYTES,
      /** The rig's own keystrokes between tabs (watchCollab): each an edit of the class notebook, written to its file and pushed to the class's machine. */
      probe: { edits: collabEdits, notebookBytes: notebookFileBytes() },
    },
    sockets: { reconnects, closes: Object.fromEntries(closes), errors: counted('socket errors'), badFrames, silent: counted('collab silent 30s'), editsRefused: counted('edits refused') },
    refusals: Object.fromEntries(refusals),
    counts: Object.fromEntries(counts),
  }
}

type Summary = ReturnType<typeof summary>

const RELAY_LINE = 'IF=$(ip route show default | awk \'{print $5; exit}\'); echo "$(date +%s) $(cat /sys/class/net/$IF/statistics/rx_bytes) $(cat /sys/class/net/$IF/statistics/tx_bytes)"'

function check(ok: boolean | null, line: string): void {
  say(`    ${ok === null ? dim('·') : ok ? green('✓') : red('✗')} ${line}`)
}

/** The first `max` of a list, and how many more LOAD_OUT holds. */
function firstOf<T>(list: readonly T[], max: number, each: (item: T) => void): void {
  for (const item of list.slice(0, max)) each(item)
  if (list.length > max) say(dim(`        … ${list.length - max} more in LOAD_OUT`))
}

function report(sum: Summary): void {
  const n = sum.numbers
  say()
  say(bold('  4. CELLS') + dim(`  — ${sum.rounds} ${sum.rounds === 1 ? 'round' : 'rounds'}, ${sum.minutes} min of class`))
  row('print(1), class notebook', spreadText(n.print.room), `n=${n.print.room.n}, its kernel free at the click`)
  row('  behind its queue', spreadText(n.print.roomQueued), `n=${n.print.roomQueued.n}: the class's own cells ahead of it, waited for in full`)
  row('  personal notebooks', spreadText(n.print.own), `n=${n.print.own.n}${n.print.ownQueued.n ? `, ${n.print.ownQueued.n} behind their own cell` : ''}`)
  if (n.print.away.n) row('  the machine away', spreadText(n.print.away), `n=${n.print.away.n}: clicks while the room read «нет связи с машиной»`)
  row('  first runs', `class ${ms(n.print.firstRoom.p95)} · personal ${ms(n.print.firstOwn.p95)}`, `p95 of n=${n.print.firstRoom.n} and n=${n.print.firstOwn.n}: the kernels' start`)
  if (n.print.unanswered) row('  unanswered', red(String(n.print.unanswered)), `the server never took the click within ${ANSWER_MS / 1000}s, or its cell ended without the answer`)
  const c = n.completion
  row('completion', spreadText(c.free), `n=${c.free.n} answered, its kernel free · ${c.asked} asked`)
  row('  to a busy kernel', spreadText(c.busy), `n=${c.busy.n}${c.away.n ? ` · ${c.away.n} with the machine away` : ''}`)
  if (c.empty || c.unanswered || c.offline) row('  without matches', `${c.empty} empty · ${c.unanswered} unanswered`, `${c.offline} not asked: the socket away`)
  row('value line', `${n.value.answered} of ${n.value.asked} answered`, `${spreadText(n.value)}${n.value.askedBusy ? ` · ${n.value.askedBusy} more to a busy kernel` : ''}`)
  row('interrupt', spreadText(n.interrupt), `n=${n.interrupt.n}${n.interrupt.pressedAgain ? ` · pressed again ${n.interrupt.pressedAgain}` : ''}${n.interrupt.lost ? red(` · ${n.interrupt.lost} lost`) : ''}`)
  row('terminal echo', spreadText(n.echo), `n=${n.echo.n}, typed at the prompt${n.echo.unanswered ? red(` · ${n.echo.unanswered} unanswered`) : ''}${n.echo.shellBusy ? red(` · ${n.echo.shellBusy} times the shell stayed busy`) : ''}`)
  row('figure, in the document', spreadText(n.figure.shown), S.cells === 'fake' ? '2 MB printed: the fake Jupyter draws nothing' : `n=${n.figure.shown.n}, a PNG of ${(FIGURE_BYTES / 1e6).toFixed(0)} MB`)
  row('  fetched', spreadText(n.figure.fetched), `${S.cells === 'fake' ? 'nothing to fetch: no image' : 'the teacher\'s tab'}${n.figure.fetchFailed ? red(` · ${n.figure.fetchFailed} fetches failed`) : ''}`)
  row('  every viewer', spreadText(n.figure.viewers), `n=${n.figure.viewers.n}: click → on each class-notebook tab`)
  row('tqdm at 10 Hz', `longest gap ${ms(n.tqdm.longest.max)} · p95 ${ms(n.tqdm.gaps.p95)}`, `${n.tqdm.updates} updates seen${n.tqdm.stalls ? red(` · ${n.tqdm.stalls} stalls over 1s`) : ''}`)
  row(`long cell (${LONG_SEC}s)`, spreadText(n.long.overhead), 'past its own time')
  row(`run limit (${LIMIT_SEC}s)`, n.limit.measured ? spreadText(n.limit.past) : dim('not measured'), n.limit.measured ? `its stop past the limit, a personal notebook's${n.limit.neverFired ? red(' · the limit never fired') : ''}` : 'no student in a personal notebook (LOAD_OWN)')
  row('upload', spreadText(n.upload.http), `n=${n.upload.http.n} of ${S.uploadKb} KB${n.upload.failed ? red(` · ${n.upload.failed} failed`) : ''}`)
  row('  → readable', spreadText(n.upload.readable), 'the next cell reads it: the barrier included')
  row(`edit (${n.edit.kb} KB) → readable`, spreadText(n.edit.readable), `the barrier carries a change at home first${n.edit.neverReadable ? red(` · ${n.edit.neverReadable} never readable`) : ''}`)
  if (n.big.mb > 0) row(`upload of ${megabytes(n.big.mb)}`, spreadText(n.big.http), `→ readable ${spreadText(n.big.readable)}${n.big.failed ? red(` · ${n.big.failed} failed`) : ''}`)
  for (const csv of n.csv) row(`CSV of ${megabytes(csv.mb)} → panel`, spreadText(csv.toPanel), `from the cell's end to its row${csv.neverListed ? red(' · never listed') : ''}${csv.unanswered ? red(' · its cell never answered') : ''}`)
  const k = n.council
  const lane = k.lane === 'pool' ? `the pool of ${k.workers === 'auto' ? 'auto' : k.workers} workers (${megabytes(k.attemptMb ?? 0)} each)` : 'the shared kernel'
  row('council attempt', spreadText(k), `n=${k.n} press → result, ${k.councils} ${k.councils === 1 ? 'council' : 'councils'} on ${lane} · ${k.placed.pool} on the pool, ${k.placed.shared} in the shared kernel${k.unanswered ? red(` · ${k.unanswered} unanswered`) : ''}${k.errors ? red(` · ${k.errors} failed`) : ''}`)
  if (k.lane === 'pool') for (const [why, times] of Object.entries(k.placed.why)) say(red(`      in the shared kernel ${times}×: ${why}`))
  row('  waited to compute', spreadText(k.wait), 'press → computing: a free worker, or the shared kernel\'s queue, and a fresher epoch first (D8)')
  row('  overhead', spreadText(k.overhead), `its time computing (home's ranMs) past its ${ATTEMPT_SEC} s: the entry, the exit, the barrier, the road`)
  row('  the burst', spreadText(k.burst), `up to ${k.presses} at once, first press → last result · the first computing ${ms(k.firstStart.p50)} after the first press${k.burstEpochs > 1 ? red(` · on ${k.burstEpochs} epochs: refrozen again under it`) : ''}`)
  row(`  beside a ${k.beside.sec}s cell`, spreadText(k.beside.burst), `the teacher's long cell running · the first computing ${ms(k.beside.firstStart.p50)} after the first press · ${k.beside.placed.pool} on the pool, ${k.beside.placed.shared} in the shared kernel${k.beside.stopped ? red(` · the long cell stopped under it ${k.beside.stopped}×`) : ''}`)
  if (k.host.n) row('  the teacher\'s run', spreadText(k.host), `beside the long cell, pressed once the class had, press → computing · ${k.host.overtaken} of the attempts waiting then started before it (the teacher's lane, D12)`)
  if (k.epochs.fresh + k.epochs.noted + k.epochs.silent > 0) row('  epochs', `${k.epochs.fresh} on the newest · ${k.epochs.noted + k.epochs.silent} on an older one`, `${k.epochs.noted} of those said «без ячеек N»${k.epochs.silent ? red(` · ${k.epochs.silent} said nothing`) : ''}`)
  if (k.lane === 'pool') {
    row('  the pool, cold', `epoch ${ms(k.pool.epochFirst.p50)} · ready ${ms(k.pool.readyFirst.p50)}`, `after the first open: its epoch taken (the export), then on the machine and loaded by a worker (its way there, the workers' start and a seed) · up to ${k.pool.workers} workers up${k.pool.notReady ? red(` · ${k.pool.notReady} not ready within ${Math.round(k.pool.waitMs / 1000)}s`) : ''}`)
    row('  a later open', spreadText(k.pool.epoch), 'its epoch on the pool\'s machine after the open: the export and its way there, no worker\'s reload')
    row('  «Обновить состояние»', spreadText(k.pool.refresh), `nothing run since: the same, an unchanged refreeze${k.pool.refreshUnanswered ? red(` · ${k.pool.refreshUnanswered} unanswered`) : ''}`)
    row('  a worker\'s seed', spreadText(k.pool.seed), 'the console naming the epoch a first burst waited for → its first attempt computing on it: a worker\'s restart and load, and the dispatch (the console\'s frames up to 250 ms late)')
    if (k.memory.privateMb.n) row('  a worker\'s memory', `own ${megabytes(k.memory.privateMb.p50 ?? 0)} · Pss ${megabytes(k.memory.pssMb.p50 ?? 0)} at p50`, `all it wrote for itself (Anonymous − LazyFree + Pss_Shmem + Swap, the epoch's objects it unpickled with it: the pool recycles on the growth since the seed past «Память на попытку», not this) up to ${megabytes(k.memory.privateMb.max ?? 0)} · Rss ${megabytes(k.memory.rssMb.p50 ?? 0)}: smaps_rollup as each attempt read it at its end`)
    if (k.greedy.asked || k.greedy.shared) row('  a greedy attempt', k.greedy.asked ? `${k.greedy.memoryError} of ${k.greedy.asked} MemoryError on the pool` : 'none on the pool', `asking ${megabytes(k.greedy.mb)}${k.greedy.other ? red(` · ${k.greedy.other} ended otherwise`) : ''}${k.greedy.shared ? red(` · ${k.greedy.shared} computed in the shared kernel, under the class's memory: not judged`) : ''}`)
  }
  if (k.data.mb > 0) row(`  the data (${megabytes(k.data.mb)})`, spreadText(k.data.cell), `a DataFrame and a fitted model in the class notebook's kernel, before the class${k.data.unanswered ? red(' · never made') : ''}`)
  row('  the notebook\'s kernel', spreadText(k.main.completionDuringBurst), `a completion asked of it during the first burst (a question, not a run: a run would make the epoch stale)${k.main.completionEmpty ? ` · ${k.main.completionEmpty} empty: it was busy` : ''}${k.main.completionUnanswered ? red(` · ${k.main.completionUnanswered} unanswered`) : ''} · ${k.main.busyWithAttempt} console frames of it computing an attempt during a burst`)
  row('control ping', spreadText(n.controlRtt), 'the tabs\' own round trip to the home: the floor of everything above')
  const co = n.collab
  row('collaboration', spreadText(co.quiet), `a keystroke from one tab to another, nothing heavy on${co.unanswered ? red(` · ${co.unanswered} never arrived`) : ''}`)
  row('  during a burst', spreadText(co.burst), `n=${co.burst.n}`)
  if (co.big.n) row('  during the big upload', spreadText(co.big), `n=${co.big.n}`)
  if ((sum.rig.loopLag.p95 ?? 0) > 50) say(red(`    the rig waited for ITS OWN loop p95 ${ms(sum.rig.loopLag.p95)} — every latency above holds up to that much of the rig's own`))
  say()

  say(bold('  5. MACHINE') + dim('  — what staff and the room saw of where the class computes'))
  row('where', Object.entries(sum.machine.where).map(([role, name]) => `${role} ${name ?? 'here'}`).join(' · ') || dim('nothing on a machine'), `${sum.machine.frames} chip frames`)
  row('the chip\'s link', spreadText(sum.machine.rtt), 'kernel:machine rttMs as staff read it')
  row('unreachable', sum.machine.unreachable.n === 0 ? green('never') : red(`${sum.machine.unreachable.n}× · longest ${ms(sum.machine.unreachable.max)}`), '')
  row('failovers seen', sum.machine.failovers === 0 ? green('0') : red(String(sum.machine.failovers)), 'a slot left its machine')
  for (const slot of sum.machine.containers) {
    row(`  ${slot.role} ${slot.where === 'here' ? 'here' : `on ${slot.where}`}`, `used ${slot.usedMb.max === null ? '—' : `${Math.round(slot.usedMb.max)} MB at most`}${slot.heldMb !== null ? ` of ${megabytes(slot.heldMb)}` : ''}`, `«Работают сейчас», ${slot.usedMb.n} ${slot.usedMb.n === 1 ? 'look' : 'looks'}${slot.cpuPercent.max !== null ? ` · CPU up to ${Math.round(slot.cpuPercent.max)} %` : ''}${slot.card ? ` · card ${slot.card}` : ''}${slot.workers !== null ? ` · ${slot.workers} workers` : ''}`)
  }
  firstOf(sum.machine.staffNotes, 8, (heard) => say(dim(`      staff: ${heard.text}${heard.count > 1 ? `  (×${heard.count})` : ''}`)))
  firstOf(sum.machine.roomNotes, 8, (heard) => say(dim(`      room: ${heard.text}${heard.count > 1 ? `  (×${heard.count})` : ''}`)))
  if (sum.machine.events.length > 0) {
    say(dim('      timeline:'))
    firstOf(sum.machine.events, 40, (e) => say(dim(`        ${e.at.slice(11, 19)} ${e.who} · ${e.what}`)))
  }
  row('the home', `/api/health ${spreadText(sum.health.ms)}`, `loop lag p95 ${ms(sum.health.loopLag.p95)}${sum.health.failed ? red(` · ${sum.health.failed} unanswered`) : ''}`)
  const socketTrouble = sum.sockets.reconnects.collab + sum.sockets.reconnects.control
  if (socketTrouble > 0 || Object.keys(sum.sockets.closes).length > 0) {
    row('sockets', red(`${socketTrouble} reconnects`), `closed ${Object.entries(sum.sockets.closes).map(([code, k]) => `${k}×${code}`).join(' ') || '—'}${sum.sockets.silent ? ` · ${sum.sockets.silent} silent 30s` : ''}`)
  }
  if (sum.sockets.editsRefused) say(red(`      ${sum.sockets.editsRefused} notebook sockets refused an edit (4403) and went quiet: the rig's bug or the server's`))
  if (sum.tabsUp && sum.tabsUp.staff < 2) say(red(`      ${sum.tabsUp.staff} of 2 staff tabs up at the class's end: the chip was not watched to the end`))
  for (const [words, k] of Object.entries(sum.refusals).slice(0, 8)) say(red(`      refused ${k}×: ${words}`))
  say()

  say(bold('  6. BYTES') + dim('  — the rig\'s own, both ways'))
  row('sent', size(sum.bytes.sent), `sockets ${size(sum.bytes.sockets.out)} · requests ${size(sum.bytes.http.sent)}`)
  row('received', size(sum.bytes.received), `sockets ${size(sum.bytes.sockets.in)} · requests ${size(sum.bytes.http.received)}`)
  row('per tab and class-hour', sum.bytes.perTabHour === null ? '—' : size(sum.bytes.perTabHour), `${tabs.length} tabs, ${sum.minutes} min`)
  say(dim('    relay2 per class-hour (§17.5: ≤ 300 MB without datasets) is the relay\'s: run this on it now, as before the run,'))
  say(dim(`      ${RELAY_LINE}`))
  say(dim(`    then (Δrx + Δtx) × 60 / ${sum.minutes || S.minutes} — the tunnel's bytes are in it, the rig's are above`))
  if (sum.bytes.datasets > 0) say(dim(`    less the datasets: the class wrote and uploaded ${size(sum.bytes.datasets)} once (the CSVs, the big upload), each crossing the relay about twice`))
  const probe = sum.bytes.probe
  if (probe.edits > 0 && ON_MACHINES) {
    // The class notebook's file is source only, and one edit has the server write it whole and push it to the class's machine (books.ts, §8).
    say(dim(`    less the rig's own keystrokes between tabs (collaboration RTT): ${probe.edits} edits of the class notebook, each one write of its file${probe.notebookBytes !== null ? ` (${size(probe.notebookBytes)} at the end)` : ''} pushed to the class's machine: up to ${probe.notebookBytes !== null ? size(probe.edits * probe.notebookBytes) : 'that many files'}, crossing the relay about twice`))
  }
  say(dim('    the home\'s CPU while it pipes (§17.5: < 5 % of a core) is the home\'s too: `ps -o cputime= -p <its server\'s pid>` before and after'))
  say()

  const base = S.baseline
  say(bold('  7. TARGETS') + dim('  — §17.5, the rows the students\' side can judge'))
  const delta = (what: string, now: Spread, then: Spread | undefined) => {
    if (!then || then.p50 === null || then.p95 === null || now.p50 === null || now.p95 === null) return check(null, `${what} p50 ${ms(now.p50)} · p95 ${ms(now.p95)}: the target is a delta, give LOAD_BASELINE a run of the same class with LOAD_CLASS=home`)
    const d50 = now.p50 - then.p50
    const d95 = now.p95 - then.p95
    check(d50 <= 150 && d95 <= 400, `${what} against the baseline: +${ms(d50)} at p50 (≤ +150), +${ms(d95)} at p95 (≤ +400)`)
  }
  delta('print(1), class notebook,', n.print.room, base?.numbers?.print?.room)
  if (PLACEMENT.own === 'machines' && STUDENTS_OWN > 0) delta('print(1), personal notebooks,', n.print.own, base?.numbers?.print?.own)
  check(c.free.n > 0 ? (c.free.p95 ?? Infinity) < 1000 : null, `completion < 1 s at p95, answered asks to a free kernel: ${ms(c.free.p95)}`)
  check(n.value.asked > 0 ? n.value.answered / n.value.asked >= 0.95 : null, `value line ≥ 95 %, asks to a free kernel: ${n.value.asked ? Math.round((100 * n.value.answered) / n.value.asked) : 0} %`)
  check(n.interrupt.n > 0 ? (n.interrupt.p95 ?? Infinity) <= 300 && n.interrupt.lost === 0 : null, `interrupt ≤ 300 ms: p95 ${ms(n.interrupt.p95)}`)
  check(n.echo.n > 0 ? (n.echo.p95 ?? Infinity) <= 300 : null, `terminal echo ≤ 300 ms: p95 ${ms(n.echo.p95)}`)
  check(n.limit.past.n > 0 ? (n.limit.past.p95 ?? Infinity) <= 1000 : n.limit.neverFired ? false : null, `run-limit stop ≤ 1 s after the limit: ${n.limit.past.n ? `p95 ${ms(n.limit.past.p95)}` : n.limit.neverFired ? 'the limit never fired' : 'not measured'}`)
  check(n.tqdm.updates > 0 ? (n.tqdm.longest.max ?? Infinity) <= 1000 : null, `tqdm: no stall over 1 s: the longest gap ${ms(n.tqdm.longest.max)}`)
  const figureBase = base?.numbers?.figure?.viewers
  if (figureBase?.p50 != null && n.figure.viewers.p50 !== null) check(n.figure.viewers.p50 - figureBase.p50 <= 1500, `the figure ≤ +1.5 s, on every viewer: +${ms(n.figure.viewers.p50 - figureBase.p50)} at p50`)
  else check(null, `the figure ${ms(n.figure.viewers.p50)} at p50 on every viewer: the target is a delta (LOAD_BASELINE)`)
  const roomPrint = n.print.room.p50
  check(n.edit.readable.n > 0 && roomPrint !== null ? (n.edit.readable.p95 ?? Infinity) - roomPrint <= 400 : null, `barrier: a 10 KB edit ≤ 400 ms: readable p95 ${ms(n.edit.readable.p95)} against print(1)'s p50 ${ms(roomPrint)}`)
  if (n.big.mb >= 150) check(n.big.readable.n > 0 ? (n.big.readable.p95 ?? Infinity) <= 25_000 : false, `barrier: a ${megabytes(n.big.mb)} upload readable ≤ 25 s: ${ms(n.big.readable.p95)}`)
  else check(null, n.big.mb > 0 ? `barrier: a ${megabytes(n.big.mb)} upload readable in ${ms(n.big.readable.p95)}: the target is for 150 MB (LOAD_BIG_MB=150)` : 'barrier: the 150 MB upload not measured (LOAD_BIG_MB=150)')
  for (const csv of n.csv) {
    const target = csv.mb <= 1 ? 2_000 : csv.mb >= 50 ? 15_000 : null
    check(target === null || csv.toPanel.n === 0 ? (csv.neverListed ? false : null) : (csv.toPanel.p95 ?? Infinity) <= target, `to_csv of ${megabytes(csv.mb)} → the panel${target ? ` ≤ ${target / 1000} s` : ''}: ${csv.toPanel.n ? ms(csv.toPanel.p95) : csv.neverListed ? 'never listed' : 'not measured'}`)
  }
  const own = sum.machine.containers.filter((slot) => slot.role === 'own')
  check(null, `${sum.personal} personal ${sum.personal === 1 ? 'notebook' : 'notebooks'}: first-run p95 ${ms(n.print.firstOwn.p95)}, the own container ${own.length ? own.map((slot) => `${slot.usedMb.max === null ? '—' : `${Math.round(slot.usedMb.max)} MB`} at most ${slot.where === 'here' ? 'here' : `on ${slot.where}`}`).join(', ') : 'not seen'}`)
  if (gpuClass) check(sum.machine.gpu.card !== null && cuda !== false, `a GPU room: the card held ${sum.machine.gpu.card ?? red('— none seen')}${cuda === null ? '' : `, torch.cuda ${cuda ? 'works' : red('does not work')}`}`)
  // The council's R2 rows, judged where its attempts go to a pool; in the shared kernel its numbers above are the baseline's.
  if (k.lane === 'pool') {
    /*
     * The burst row is judged on the shape it names, as it was asked: eight
     * workers (LOAD_WORKERS=8) and a first burst of thirty pressed at once.
     * Asked so, it holds only for bursts on one epoch, all eight up: a pool
     * that never had its eight, never took the burst or refroze under it
     * fails it.
     */
    if (k.workers === 8 && k.presses >= k.r2.size) {
      const held = k.r2.burst.n > 0 && (k.r2.burst.p95 ?? Infinity) <= 20_000 && k.pool.workers === 8 && k.r2.refrozen === 0
      check(held, `(R2) ${k.presses} attempts at once on 8 workers: the burst ${k.r2.burst.n ? `${ms(k.r2.burst.p95)} at p95` : red('never computed on the pool')} (≤ 20 s)${k.pool.workers === 8 ? '' : red(`, only ${k.pool.workers} of the 8 workers ever up at once`)}${k.r2.refrozen ? red(`, ${k.r2.refrozen} refrozen under it`) : ''}`)
    } else {
      const why = k.workers !== 8 ? `«Попыток одновременно» was ${k.workers ?? '—'}, not 8 (LOAD_WORKERS=8)` : `the most pressed at once was ${k.presses}, not ${k.r2.size} (LOAD_STUDENTS=${k.r2.size})`
      check(null, `(R2) ${k.r2.size} attempts of ${ATTEMPT_SEC} s on 8 workers ≤ 20 s not judged: ${why}; the first burst here ${ms(k.burst.p95)} at p95 on ${k.pool.workers} workers up`)
    }
    check(k.overhead.n > 0 ? (k.overhead.p95 ?? Infinity) <= 1000 : null, `(R2) each attempt past its ${ATTEMPT_SEC} s ≤ 1 s at p95: ${ms(k.overhead.p95)}`)
    check(k.n > 0 ? k.placed.shared === 0 && k.main.busyWithAttempt === 0 : null, `(R2) the notebook's kernel untouched: ${k.placed.shared} attempts in it, ${k.main.busyWithAttempt} console frames of it computing one; a completion asked of it during the burst ${ms(k.main.completionDuringBurst.p50)} at p50${k.main.completionEmpty ? `, ${k.main.completionEmpty} empty` : ''}`)
    check(k.beside.firstStart.n > 0 ? (k.beside.firstStart.p95 ?? Infinity) <= COUNCIL_EPOCH_WAIT_MS + 1000 && k.epochs.silent === 0 : null, `(R2) beside the teacher's long cell: the first attempt computing ${ms(k.beside.firstStart.p95)} after the first press at p95 (≤ ${COUNCIL_EPOCH_WAIT_MS / 1000} s waiting for a fresher epoch, and a second of the road), ${k.epochs.noted} on an older epoch saying «без ячеек N»${k.epochs.silent ? red(`, ${k.epochs.silent} saying nothing`) : ''}`)
    check(k.host.judged > 0 ? k.host.overtaken === 0 : null, `(R2) the teacher's lane first: ${k.host.judged ? `${k.host.overtaken} of the class's waiting attempts started before the teacher's run, ${ms(k.host.p50)} from its press to computing` : 'not judged: no attempt of the class still waited when the teacher pressed'}`)
    check(k.greedy.asked > 0 ? k.greedy.memoryError === k.greedy.asked && k.errors === 0 : null, k.greedy.asked > 0 ? `(R2) a greedy attempt on the pool: ${k.greedy.memoryError} of ${k.greedy.asked} a MemoryError, ${k.errors} other attempts failed${k.greedy.shared ? `; ${k.greedy.shared} more in the shared kernel, not judged` : ''}` : k.greedy.shared ? `(R2) a greedy attempt: not judged, the shared kernel computed it ${k.greedy.shared}× (its reason with the shared cards' in section 4)` : '(R2) a greedy attempt: not asked (Python cells and a class of three or more)')
    check(null, `(R2) the epoch${k.data.mb ? ` of ${megabytes(k.data.mb)} of data` : ''}: taken ${ms(k.pool.epochFirst.p50)} after the first open, the pool ready ${ms(k.pool.readyFirst.p50)} (the H → C transfer in it when the class notebook computes here), a later open's on the machine ${ms(k.pool.epoch.p50)}, an unchanged refreeze ${ms(k.pool.refresh.p50)}, a seed ${ms(k.pool.seed.p50)}, a worker's own memory ${k.memory.privateMb.n ? megabytes(k.memory.privateMb.p50 ?? 0) : '—'}; the council container in section 5`)
  }
  const within = (during: Spread): boolean | null => (during.n > 0 && co.quiet.p95 !== null ? (during.p95 ?? Infinity) - co.quiet.p95 <= 50 : null)
  check(within(co.burst), `collaboration during the council's bursts within 50 ms of a quiet one at p95: ${ms(co.burst.p95)} against ${ms(co.quiet.p95)}`)
  if (co.big.n) check(within(co.big), `collaboration during the big upload within 50 ms of a quiet one at p95: ${ms(co.big.p95)} against ${ms(co.quiet.p95)}`)
  check(sum.machine.failovers === 0 && sum.machine.unreachable.n === 0 ? true : null, sum.machine.failovers === 0 ? 'no failover and no amber chip seen' : `${sum.machine.failovers} failovers seen: compare the timeline with what was injected`)
  say()
}

/* ---------------------------------------------------------------- cleanup */

/** How long cleanup waits for the create's answer before it looks the room up by its name. */
const CREATE_WAIT_MS = 5_000
/** How long cleanup keeps trying to delete the rig's seminar: a relay that answers its own 404 for a while, a home mid-restart. */
const DELETE_FOR_MS = 3 * 60_000
/** One press delivered twice comes within this: `npx tsx` relays a Ctrl+C to the rig ~35 ms after the terminal's own. */
const REPEAT_MS = 1_000

/** The rig's seminars by their name, as the panel lists every room to an owner: their ids, or null when the home did not answer. */
async function roomsNamed(name: string): Promise<string[] | null> {
  try {
    const answer = await request('GET', '/api/admin/seminars?scope=all', { cookie: staffCookie, timeoutMs: 30_000 })
    const rows = answer.status === 200 ? parsed<Array<{ id?: unknown; name?: unknown }>>(answer) : null
    if (!Array.isArray(rows)) return null
    return rows.filter((one) => one.name === name && typeof one.id === 'string').map((one) => one.id as string)
  } catch {
    return null
  }
}

/**
 * The seminar deleted, tried again with a growing pause for DELETE_FOR_MS:
 * a 404 is the home's own word only when its public door agrees (roomGone),
 * and a relay's page, a 503 «already stopping» or no answer is tried again.
 * A refusal no retry mends (the cookie no owner's any more) ends it at once.
 */
async function deleteRoom(id: string): Promise<'deleted' | 'gone' | string> {
  const started = now()
  let wait = 1_000
  for (;;) {
    let last: string
    try {
      const gone = await request('DELETE', `/api/admin/seminars/${id}?reading=drop`, { cookie: staffCookie, timeoutMs: 120_000 })
      if (gone.status >= 200 && gone.status < 300) return 'deleted'
      if (gone.status === 404 && (await roomGone(id)) === true) return 'gone'
      last = refusalOf(gone)
      if (gone.status === 401 || gone.status === 403) return last
    } catch (error) {
      last = errorText(error)
    }
    if (now() - started + wait > DELETE_FOR_MS) return last
    say(dim(`  the seminar's delete did not go through (${last}): again in ${Math.round(wait / 1000)}s`))
    await sleep(wait)
    wait = Math.min(15_000, wait * 2)
  }
}

let cleaning: Promise<void> | null = null

/**
 * Everything the rig opened it closes, and the room it made it deletes,
 * whatever the outcome: a finished run, an error, Ctrl+C. A room left behind
 * holds the class's kernels on a machine and N participant rows nobody made
 * by hand. A create with no answer (late, or lost) is looked up by the
 * room's name, and failing that, the name is said.
 */
function cleanup(): Promise<void> {
  cleaning ??= (async () => {
    stopping = true
    for (const done of [...stopWaiters]) done()
    for (const timer of [healthTimer, runningTimer, silenceTimer, selfTimer, collabTimer]) if (timer) clearInterval(timer)
    for (const tab of tabs) tab.close()
    if (creation === 'pending') await Promise.race([creating ?? Promise.resolve(), sleep(CREATE_WAIT_MS)])
    const ids = new Set<string>(SID ? [SID] : [])
    if (!SID && (creation === 'pending' || creation === 'unknown')) {
      say(dim(`  the seminar's create had no answer: looking for «${roomName}» at the home`))
      let found = await roomsNamed(roomName)
      if (found !== null && found.length === 0 && creation === 'pending') {
        // Not made yet: the request may still be on its way to the home. Its own end decides, then one more look.
        await creating
        found = SID ? [SID] : await roomsNamed(roomName)
      }
      if (found === null) say(red(`  could not look for «${roomName}» at the home: if the panel lists it, delete it there`))
      else if (found.length === 0) say(dim(`  no seminar named «${roomName}» at the home: the create never got there`))
      for (const id of found ?? []) ids.add(id)
    }
    for (const id of ids) {
      SID ||= id
      const outcome = await deleteRoom(id)
      const done = outcome === 'deleted' || outcome === 'gone'
      if (id === SID) deleted = done
      say(done ? dim(`  cleaned up: seminar ${id} ${outcome === 'gone' ? 'was gone already' : 'deleted'}`) : red(`  could not delete seminar ${id}: ${outcome} — delete it in the panel`))
    }
  })()
  return cleaning
}

function writeOut(sum: Summary): void {
  if (!S.out) return
  try {
    writeFileSync(S.out, `${JSON.stringify(sum, null, 2)}\n`)
  } catch (error) {
    warn(red(`  LOAD_OUT could not be written: ${errorText(error)}`))
  }
}

/*
 * An error nothing caught is a bug of the rig's, and it must not cost the
 * home a room: the process would die with the seminar and its kernels
 * standing. It is said, the room is deleted, and the rig ends with 1.
 */
let crashed = false
const crash = (error: unknown): void => {
  if (crashed) return
  crashed = true
  warn(red(`class-load: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`))
  stopping = true
  void cleanup().finally(() => {
    writeOut(summary(true))
    process.exit(1)
  })
}
process.on('uncaughtException', crash)
process.on('unhandledRejection', crash)

let signalled = false
let signalledAt = 0
for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) {
  process.on(signal, () => {
    if (signalled) {
      // The same press, delivered again by npm and tsx on its way (npx tsx): the cleanup it started goes on.
      if (now() - signalledAt < REPEAT_MS) return
      // A second one leaves at once: the room is named so that it can be deleted by hand.
      const left = SID && !deleted ? ` — seminar ${SID} may be left: delete it in the panel` : !SID && roomName && creation !== 'refused' ? ` — a seminar named «${roomName}» may be left: delete it in the panel` : ''
      warn(red(`class-load: left at once${left}`))
      process.exit(130)
    }
    signalled = true
    signalledAt = now()
    warn(dim(`class-load: ${signal}, stopping${classStarted ? '; what was measured follows' : ''}`))
    stopping = true
    void (async () => {
      classEndedAt ||= now()
      const before = summary(true)
      if (classStarted) report(before)
      await cleanup()
      writeOut(summary(true))
      process.exit(130)
    })()
  })
}

/* ------------------------------------------------------------------- main */

async function main(): Promise<number> {
  say()
  say(bold('  colloq class-load') + dim(`  ${new Date().toISOString()}  ·  ${S.base}`))
  say(dim(`  ${S.students} students (${STUDENTS_OWN} in personal notebooks) · ${S.minutes} min in ${ROUNDS} ${ROUNDS === 1 ? 'round' : 'rounds'} of ${Math.round(ROUND_MS / 1000)}s · CLASS=${S.preset} (room ${PLACEMENT.room}, own ${PLACEMENT.own}, council ${POOL ? `on a pool of ${S.workers} workers, ${S.attemptMb} MB each` : 'in the shared kernel'})${S.epochMb ? ` · ${S.epochMb} MB of data for the epoch` : ''}${S.cells === 'fake' ? ' · fake cells' : ''}`))
  if (S.baseline) say(dim(`  baseline: ${S.baseline.path}`))
  say(dim('  relay2\'s counters before the run, on the relay:'))
  say(dim(`    ${RELAY_LINE}`))
  say()
  watchSelf()

  const problem = await signIn()
  if (problem) {
    warn(red(`class-load: could not sign in as an owner: ${problem}`))
    return 2
  }
  // What the class needs of the home, asked before anything is made: a refusal here leaves nothing behind.
  const unfit = (await chooseEnvironment()) ?? (await uploadsFit())
  if (unfit) {
    warn(red(`class-load: ${unfit}`))
    return 2
  }

  say(bold('  1. ROOM'))
  const why = await makeRoom()
  if (why) throw new Error(why)
  row('seminar', `${SID}`, `«${roomName}», the rig's own${environment ? ` · ${environment}${gpuClass ? ', a GPU environment' : ''}` : ''}`)
  if (ON_MACHINES) {
    const refused = await machinesTakeIt()
    if (refused) throw new Error(refused)
    row('machines that take it', placementLine, 'the class form\'s live line')
  } else {
    row('where it computes', 'here', 'CLASS=home: the baseline for LOAD_BASELINE')
  }
  watchHealth()
  watchSilence()
  say()

  say(bold('  2. JOIN') + dim(`  — ${S.students} over ${S.rampSec}s, both sockets each, and two staff tabs`))
  await joinEveryone()
  const studentTabs = tabs.filter((tab) => tab.n > 0)
  row('joined', `${studentTabs.length} of ${S.students}`, `${studentTabs.filter((tab) => tab.synced).length} synced`)
  row('refused', joinRefused.size === 0 ? green('0') : red([...joinRefused].map(([code, k]) => `${k}×${code}`).join(' · ')), joinRefused.has(429) ? 'the join\'s ceilings: SHARED_ADDRESSES on the home' : '')
  row('response time', `p50 ${ms(pct(joinMs, 50))} · p95 ${ms(pct(joinMs, 95))}`, `n=${joinMs.length}`)
  if (studentTabs.length === 0) throw new Error('nobody joined: nothing to measure')
  await prepare()
  const chips = [...where].map(([role, name]) => `${role} ${name ?? 'here'}`).join(' · ')
  row('the chip', chips || (ON_MACHINES ? red('no slot on a machine') : 'here'), 'kernel:machine, as staff hear it')
  if (ON_MACHINES && PLACEMENT.room === 'machines' && !where.get('room')) say(red('    the class notebook computes here: its numbers are this server\'s, not a machine\'s'))
  if (cuda === false) say(red('    torch sees no card in the class\'s kernel'))
  say()

  say(bold('  3. CLASS') + dim(`  — ${ROUNDS} ${ROUNDS === 1 ? 'round' : 'rounds'} of ${Math.round(ROUND_MS / 1000)}s: echo, completion, print(1), the figure, an edit, tqdm ${TQDM_SEC}s, a ${LONG_SEC}s cell, interrupts, a council of two bursts of ${ATTEMPT_SEC}s attempts, the second beside a ${BESIDE_SEC}s cell; the run limit ${LIMIT_SEC}s`))
  await holdClass()
  return 0
}

let code = 1
try {
  code = await main()
} catch (error) {
  if (!stopping) {
    warn(red(`class-load: the run stopped: ${errorText(error)}`))
    code = 1
  }
}
// A signal or a crash ends the run on its own path, its room deleted there.
if (!signalled && !crashed) {
  stopping = true
  classEndedAt ||= now()
  const before = summary(false)
  if (classStarted) report(before)
  await cleanup()
  const sum = summary(false)
  writeOut(sum)
  if (badFrames > 0) say(dim(`  ${badFrames} frames the rig could not parse — its problem, not the server's`))
  if ((SID && !deleted) || endedBy) code = code || 1
  // Live sockets and timers would keep the loop open.
  process.exit(code)
}
