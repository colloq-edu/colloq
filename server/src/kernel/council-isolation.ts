import { createHash } from 'node:crypto'
import { tr, formatNumber, hasTranslation } from '@shared/i18n'
import { MAX_DEPTH, MAX_PATH, MAX_SEGMENT, MAX_SEGMENT_BYTES, normalizePath } from '@shared/paths'
import {
  COUNCIL_ARTIFACTS,
  COUNCIL_EPOCH_BUFFERS_MAX,
  COUNCIL_EPOCH_DIR,
  COUNCIL_EPOCH_MANIFEST_BYTES,
  COUNCIL_EPOCH_MB,
  COUNCIL_EPOCHS_MOUNT,
  COUNCIL_SCRATCH_ENTRIES,
  COUNCIL_SCRATCH_MOUNT,
  REMOTE_RUN_ID,
} from '@shared/remote-kernels'
import { COLLOQ_REFUSED, GUARD_MODULE, guardCouncilSettings, guardInstallLine } from './danger.js'

/**
 * Personal copies of the data for one council attempt, and an exact return
 * afterwards.
 *
 * A notebook has one kernel, and that is by product design: an attempt must see
 * `df`, `np` and everything the teacher prepared in a shared cell. But while a
 * "personal sheet" meant only personal TEXT, everything else stayed shared, and
 * at the seminar of 19 Sep 2026 this cost a class: the task had a commented-out
 * line `# data = data.dropna()`, one person uncommented it and ran it, and
 * `data` changed for EVERYONE, including those who had already submitted.
 *
 * It broke in two different ways, and the previous cleanup (a snapshot of the
 * names before the attempt, removing the new ones after) closed neither:
 *   1. rebinding: `data = data.dropna()` changes a NAME that existed, while
 *      only names that had not existed were removed;
 *   2. in-place mutation: `df.drop(..., inplace=True)`, `df['x'] = 1`,
 *      `lst.append(...)` spoil the object itself, and there is nothing to
 *      remove at all.
 *
 * A separate kernel per student was rejected on cost (≈2 GB per kernel and the
 * fragility of zmq/matplotlib), `fork` for the same reasons plus the shared
 * Jupyter socket. The only cheap option left: before an attempt, replace the
 * bindings with personal copies; after it, return the namespace to exactly
 * what it was.
 *
 * The cost of a copy here is not theoretical. The `colloq-kernel:base` image has
 * pandas 3, where Copy-on-Write is always on: `obj.copy(deep=False)` costs O(1),
 * and any write to the copy leaves the original alone, i.e. the most frequent
 * and heaviest case of a seminar (a table of hundreds of megabytes) is covered
 * for free. Deep copies remain for numpy, containers and pandas without CoW,
 * and they have a budget: whatever does not fit stays shared, and the attempt
 * is told so out loud; a silent "some have a copy, others do not" would be
 * worse than the old hole.
 *
 * Copies are not the end of it. The same entry closes what let ONE attempt take
 * down the whole class, all of it found by asking "what if someone does this?":
 *   · `exit()` and `quit()`: in ipykernel that is `shell.ask_exit()`, i.e. the
 *     end of the process. Reproduced on a live kernel: after such an attempt
 *     nobody has any variables. Now they are refused; the kernel survives
 *     `sys.exit()` without our help, so that one is left alone;
 *   · `os._exit()` and `os.abort()`: the end of the process without a single
 *     word: no traceback, no stack, no signal in dmesg, no counter in the
 *     cgroup. On 20 Sep 2026 a class of thirty lost its kernel nine times in
 *     eleven minutes on a two-line attempt; reproduced in a throwaway
 *     container. Now they are refused, except in a child after `fork()`, where
 *     `_exit` is the right ending. Since 20 Sep 2026 this is not a copy of our
 *     own but the room's SHARED guard (`danger.ts`), which the attempt keeps on
 *     for its duration, whatever the "Dangerous commands" rule says;
 *   · greed: `np.ones((40000, 40000))` or an unlucky cartesian join called the
 *     OOM killer, and it killed the notebook's kernel. Checked with a control
 *     experiment. Now the attempt gets an address-space ceiling derived from
 *     the container limit, and the same thing ends in a `MemoryError` for the
 *     author;
 *   · process state that silently changes the results of whoever comes next:
 *     the random number stream, `sys.stdout`, `sys.path`, `os.environ`,
 *     `builtins`, warning filters, numpy and pandas print options, `%pdb`,
 *     IPython hooks, matplotlib figures, child processes. A snapshot before, a
 *     return after.
 *
 * What is NOT here, and will not be until decided otherwise: files on disk
 * (chmod for the duration of an attempt breaks the file editor and the
 * terminal, intercepting `open` breaks the ordinary "everyone writes out.csv"),
 * a sandbox against intent (`ctypes`, `signal.raise_signal`, deleting this
 * module from `sys.modules` get past it), and modules the attempt imported.
 * The council is a teaching technique, not an exam sandbox: what is closed is
 * the way a class really gets taken down, not every conceivable one.
 *
 * Since 0.26 the same hidden module also serves the council's pool on a
 * machine (remote-classes.md §9.3–9.4, 9.7). The notebook's kernel freezes
 * its names into an epoch (`export`: one pickle stream with one memo, numeric
 * buffers of 64 KiB or more as files named by their sha256, what cannot
 * travel named with a reason), and each worker of the pool, a kernel of its
 * own, seeds itself from it once (`load`: the buffers mapped copy-on-write,
 * notebook functions rebuilt on the worker's own namespace, the names left
 * behind bound to sentinels that refuse in words). An attempt in a worker
 * then runs today's entry and exit with three inputs more: its source (an
 * attempt that reads a name the epoch left behind is refused before anything
 * is copied, and runs in the shared kernel), its run id (it works in a
 * scratch folder of its own, and the exit lists what it wrote there) and the
 * attempt's memory, a ceiling that is not optional for a worker. The export
 * and the load are a second source (EPOCH_IMPL) installed into the same
 * module only by their own cells, so an attempt's entry does not carry them.
 *
 * A pure module: the Python sources, building and parsing the report, no
 * network, no Yjs, for the sake of the test (the same trick as in council.ts).
 */

/** The hidden module the isolation state lives in. Not a name in `globals()`. */
export const COUNCIL_MODULE = '_colloq_council'

/** The key the report travels under in the kernel reply's `user_expressions`. */
export const COUNCIL_REPORT_KEY = 'colloq'

/**
 * The expression the kernel evaluates and puts into `execute_reply`.
 *
 * `user_expressions` answers EVEN with `silent: true` (ipykernel ·
 * IPythonKernel.do_execute: they are evaluated after the run if the status is
 * `ok`), and with `silent: true` the kernel sends nothing over IOPUB, so there
 * would be no other way to hear the entry. The module is hidden in
 * `sys.modules`, so it has to be reached through `__import__`: it is
 * deliberately not in `user_ns`.
 */
export const COUNCIL_REPORT_EXPR = `__import__('sys').modules['${COUNCIL_MODULE}'].report`

/**
 * The EXIT report, and unlike the entry one it is optional.
 *
 * The exit does not decide whether to run the attempt; it only tells about the
 * leftovers that could not be returned (threads left running, killed
 * processes). Silence here is not the attempt's trouble, just the absence of a
 * note in its output.
 */
export const COUNCIL_LEFTOVERS_EXPR = `__import__('sys').modules['${COUNCIL_MODULE}'].leftovers`

/**
 * The name of the exception with which the isolation refuses an attempt in its
 * own words.
 *
 * The same as the global guard's (danger.ts · COLLOQ_REFUSED), and that is no
 * coincidence: since 20 Sep 2026 the refusal "this command takes the kernel
 * down for everyone" is implemented ONCE, and a council attempt simply keeps it
 * on above the room rule. The name is kept here as an alias so callers do not
 * have to be rewritten.
 */
export const COUNCIL_REFUSED = COLLOQ_REFUSED

/** How many bytes of personal copies one attempt may have, unless told otherwise. */
export const COUNCIL_DEFAULT_COPY_BYTES = 512 * 1024 * 1024

/** The memory ceiling never goes below this: under it not even an import works. */
export const COUNCIL_MEMORY_FLOOR_BYTES = 512 * 1024 * 1024

/** Headroom left to the room's kernel beyond what is given to the attempt. */
export const COUNCIL_MEMORY_HEADROOM_BYTES = 256 * 1024 * 1024

/** This many "stayed shared" lines fit into the output header; beyond, a count. */
export const MAX_SKIP_NOTES = 3

/** A size that cannot be counted: the walk hit the node ceiling. */
export const SIZE_UNKNOWN = -1

/* ------------------------------------------------------------- the pool */

/** Out-of-band buffers this large or larger become files of their own in an epoch (§9.3); smaller ones stay in the stream. */
export const COUNCIL_EPOCH_BUFFER_BYTES = 64 * 1024

/**
 * The byte cap of one name that is not data in `_plan`'s list (a figure, a
 * session, a notebook function with a heavy default): such objects are tried
 * like the rest, but one of them never takes the room of the tables (§9.4).
 */
export const COUNCIL_EPOCH_NAME_BYTES = 64 * 1024 * 1024

/** The format of an epoch's stream and manifest: a worker refuses another one rather than guess. */
export const COUNCIL_EPOCH_FORMAT = 1

/** Files of a scratch folder an exit lists by name: past it, a count. */
export const COUNCIL_EXIT_FILES_MAX = 100

/** Entries of a scratch folder an exit looks at, folders included: an attempt that writes a million files or folders does not hold its worker for minutes. The skeleton's own links never count. */
export const COUNCIL_SCRATCH_WALK = 10_000

/** Submodules of the notebook's packages a worker imports again at seed, at most. */
export const COUNCIL_SUBMODULES_MAX = 2000

/** What a worker writes into its `oom_score_adj` at seed (§9.3 detail 5): the cgroup's OOM killer picks a worker, never jupyter_server. */
export const COUNCIL_OOM_SCORE_ADJ = 1000

/** The exception a worker raises when an attempt touches a name the epoch left behind (§9.4). */
export const COUNCIL_NOT_CARRIED = 'NotCarried'

/**
 * Why a name stays behind (§9.4), as the export and the load report it: a
 * database connection, an open file, a network socket, a generator, a
 * thread, a lock, data on the GPU (D11), a name over the snapshot's budget,
 * and anything else that does not pickle; and, said by a worker's load
 * alone, a name whose module its environment lacks (a package installed
 * into the notebook's own container, K7a #16). Each has its words
 * (councilLeftWords).
 */
export type CouncilLeftWhy =
  | 'connection'
  | 'file'
  | 'socket'
  | 'generator'
  | 'thread'
  | 'lock'
  | 'cuda'
  | 'budget'
  | 'unpicklable'
  | 'module'

export const COUNCIL_LEFT_WHYS: readonly CouncilLeftWhy[] = [
  'connection', 'file', 'socket', 'generator', 'thread', 'lock', 'cuda', 'budget', 'unpicklable', 'module',
]

/** A name an epoch could not carry, and why. */
export interface CouncilLeftName {
  name: string
  why: CouncilLeftWhy
}

/** One file of an epoch, by its content. */
export interface CouncilEpochFile {
  sha256: string
  bytes: number
}

export interface CouncilCopySkip {
  name: string
  /** Bytes; `SIZE_UNKNOWN` means the object was too branchy to measure. */
  bytes: number
}

export interface CouncilCopyFailure {
  name: string
  error: string
}

export interface CouncilIsolationReport {
  ok: boolean
  /** How many names got a personal copy. */
  copied: number
  /** What did not fit into the budget and stayed shared. */
  skipped: CouncilCopySkip[]
  /** What failed to copy for its own reason (and also stayed shared). */
  failed: CouncilCopyFailure[]
  /** How many bytes of copies the entry counted. */
  bytes: number
  /** The memory ceiling per attempt, in bytes; `null` means no ceiling. */
  memory: number | null
  ms: number
  /** Filled only when `ok` is false. */
  error: string | null
  /**
   * A worker's refusal (§9.4): the names the attempt reads that its epoch
   * left behind. Not empty only with `ok` false, and then nothing was copied
   * or held: the attempt goes to the notebook's queue, keeping its place.
   */
  needs: CouncilLeftName[]
  /** The scratch folder the attempt works in (a worker's, with a run id); `null` elsewhere. */
  scratch: string | null
}

/** What could not be returned after the attempt. */
export interface CouncilLeftovers {
  /** Threads the attempt left running: there is no way to stop them. */
  threads: number
  /** Child processes that had to be killed on its behalf. */
  processes: number
}

/** A file an attempt wrote into its scratch folder (§9.7). */
export interface CouncilArtifact {
  /** Its path inside the scratch folder, canonical (shared/paths · normalizePath). */
  name: string
  bytes: number
  /** Within the caps (COUNCIL_ARTIFACTS, in the exit's order): the hash home asks the agent to collect it by; `null` for a file only named. */
  sha256: string | null
}

/**
 * The exit's whole report, a worker's included: what could not be returned,
 * what the attempt wrote, and whether its worker should be recycled.
 */
export interface CouncilExitReport extends CouncilLeftovers {
  /** New regular files of the scratch folder, by name, at most COUNCIL_EXIT_FILES_MAX; links into the class folder are never listed. */
  files: CouncilArtifact[]
  /** New files past those listed. */
  more: number
  /** The worker's private dirty memory now (smaps_rollup), bytes; `null` where Linux does not say or outside a worker. */
  dirty: number | null
  /** How much of it the attempts added since the seed. */
  grown: number | null
  /**
   * The worker should restart and reseed (§9.5): the attempt left threads or
   * processes behind, or what the attempts added since the seed is over
   * «Память на попытку».
   */
  recycle: boolean
}

/** Texts and knobs the entry gets from the server rather than carrying itself. */
export interface CouncilIsolationSettings {
  budgetBytes?: number
  /** Whether to set an address-space ceiling for the duration of the attempt. */
  memoryGuard?: boolean
  /**
   * A pool worker's: the attempt's text, for the check of the names its
   * epoch left behind (§9.4). The entry refuses an attempt that reads one.
   */
  source?: string
  /** A pool worker's: the run id (REMOTE_RUN_ID), which names the attempt's scratch folder (§9.7). */
  runId?: string
  /**
   * A pool worker's: «Память на попытку» in MB (D33). The ceiling is then
   * mandatory and never above it, whatever `memoryGuard` says: on Linux an
   * entry that cannot set it refuses. The attempt's copies count against
   * it: at most half of it goes to them (the copy budget is cut to that),
   * and the ceiling is what they leave. A seeded worker refuses an entry
   * without it, its `runId` or its `source`.
   */
  capMb?: number
  /** The class folder inside the container (`/workspace/<id>`): the scratch folder's skeleton is made from it. */
  workspace?: string
  /** Where the scratch folders are; COUNCIL_SCRATCH_MOUNT unless a test says otherwise. */
  scratchRoot?: string
  /** The skeleton's entries at most; COUNCIL_SCRATCH_ENTRIES unless a test says otherwise. */
  skeletonEntries?: number
}

/** One silent service execute: its code, and the user_expressions its report travels in. */
export interface CouncilServiceRun {
  code: string
  userExpressions: Record<string, string>
}

/** What the server tells an export (§9.2–9.3). */
export interface CouncilExportOptions {
  /** The epoch's number: the export writes into COUNCIL_EPOCH_DIR/<seq>, inside the notebook kernel's own container. */
  seq: number
  /** The main runtime's count of history runs at the export: the epoch records it, and the report says it back. */
  mainRuns: number
  /** The epoch's files together at most; COUNCIL_EPOCH_MB by default. A name that does not fit stays behind, `budget`. */
  budgetBytes?: number
  /**
   * Write every buffer again, unchanged ones too. By default a buffer whose
   * place, size and crc32 match the previous export keeps its sha256 and
   * is not written: whoever collected that export holds it already. A
   * collector that lost it asks for a full export.
   */
  full?: boolean
  /** The class folder inside the container: the kernel's folder is kept relative to it, and modules from it are named local. */
  workspace?: string
  /** The folder to write into, instead of COUNCIL_EPOCH_DIR/<seq>: for a test. */
  dir?: string
  /** The byte cap of a name that is not data, instead of COUNCIL_EPOCH_NAME_BYTES: for a test. */
  nameBytes?: number
}

/** What the server tells a worker's seed (§9.3). */
export interface CouncilLoadOptions {
  /** The manifest's sha256: the file of that name in `dir`, checked against it. */
  manifest: string
  /** The stream's sha256 as home registered it: the stream is checked against it before a single byte is unpickled. */
  body: string
  /** Where the epoch's files are, read-only, each named by its sha256; COUNCIL_EPOCHS_MOUNT by default. */
  dir?: string
  /** Threads per worker (§9.7: about one CPU each); 1 by default. */
  threads?: number
  /** The class folder inside the container: the kernel's folder of the epoch is taken inside it. */
  workspace?: string
}

/** An export's report (§9.3), from `user_expressions`. */
export interface CouncilExportReport {
  ok: boolean
  /** The epoch's number, as the server gave it. */
  seq: number | null
  /** The manifest's sha256; `null` when nothing was written: the export failed, or the state holds CUDA (D11). */
  manifest: string | null
  manifestBytes: number
  /** The stream's sha256 (the pickle without its big buffers); `null` as for the manifest. */
  body: string | null
  bodyBytes: number
  /** The out-of-band buffers, distinct, in the order the stream first uses them. */
  buffers: CouncilEpochFile[]
  /** The files this export put in its folder, by sha256: the manifest, the stream and every buffer that changed (all of them with `full`). The rest the collector holds already. */
  written: string[]
  /** The epoch's files together: the manifest, the stream and the buffers. */
  bytes: number
  /** Buffers kept from the previous export without a write: their place, size and crc32 had not changed. */
  reused: number
  /** The names carried. */
  carried: string[]
  /** The names left behind, and why. */
  left: CouncilLeftName[]
  /** Modules by the name they are bound to (`np` → `numpy`): re-imported by name in a worker. */
  imported: Record<string, string>
  /** Those of them that come from the class folder: a worker imports the synced copy, which may be newer (§9.4). */
  local: string[]
  /** The state holds data on the GPU: the whole council stays in the shared kernel (D11), and nothing was written. */
  cuda: boolean
  /** The main runtime's count of history runs, said back. */
  mainRuns: number | null
  ms: number
  /** Filled only when `ok` is false. */
  error: string | null
  /**
   * The kernel's PYTHONHASHSEED as its environment has it (D28): null — none
   * (a container started before 0.25.0); absent — the report did not say.
   */
  hashSeed?: string | null
}

/** A worker's seed report (§9.5), from `user_expressions`. */
export interface CouncilSeedReport {
  ok: boolean
  seq: number | null
  manifest: string | null
  /** Names bound from the epoch. */
  loaded: number
  /** Modules imported again by name. */
  imported: number
  /** Names bound to sentinels: the epoch's own left names, and modules this worker could not import. */
  left: CouncilLeftName[]
  /** What the worker's `oom_score_adj` reads after the seed; `null` where there is none to write. */
  oomScoreAdj: number | null
  /** The thread limit set; `null` when no library would take one. */
  threads: number | null
  /** Bytes of the epoch's buffers mapped. */
  mapped: number
  ms: number
  /** Filled only when `ok` is false. */
  error: string | null
}

/**
 * The entry and exit implementation, as one chunk of Python that runs NOT in
 * the student's namespace.
 *
 * Everything declared below lands in the hidden module's `__dict__`: the entry
 * cell (`councilEnterSource`) does exactly two things, and neither binds names
 * in the attempt's `globals()`. Otherwise the entry would contradict itself,
 * promising an exact return of the namespace while leaving `sys`, `copy` and
 * its own variables in it.
 *
 * `state` and `report` are created with `setdefault` at the end: the source is
 * executed before EVERY attempt (cheaper than comparing versions), and a plain
 * assignment would erase the state of a previous entry not yet closed, i.e.
 * exactly what the state is kept for.
 */
const IMPL = `
import ast
import builtins
import collections
import copy
import hashlib
import json
import os
import stat
import sys
import time
import types


# A snapshot of the builtins themselves, taken AT INSTALL time while they are
# still intact.
#
# An attempt is free to write \`builtins.list = "broken"\`, and the return,
# which is exactly what fixes that, would fail on its very first line:
# \`list(ns)\` can no longer be called. Checked, that is exactly how it failed.
# So everything the RETURN uses is taken from here, not from builtins, which by
# then are someone else's.
_list = list
_vars = vars
_getattr = getattr
_setattr = setattr
_delattr = delattr
_id = id


def _guard():
    """The shared guard against dangerous commands, the same as in a plain cell.

    The council no longer has its own copy of the refusal: \`exit()\`,
    \`os._exit()\`, a deadly signal to the kernel, \`!kill -9 -1\` and
    \`%reset\` are closed by one module (kernel/danger.ts), and the attempt only
    KEEPS it on for its duration, whatever the room rule says. Two
    implementations of one refusal would drift apart at the very first edit,
    and drift silently.
    """
    return sys.modules.get('${GUARD_MODULE}')


def _hold(words):
    guard = _guard()
    if guard is None:
        # The guard is installed by the FIRST line of the same entry cell, so
        # only kernels where it did not go in at all get here, and then the
        # entry honestly reports failure, and the attempt does not run.
        return False
    try:
        guard.hold(words)
    except Exception:
        return False
    return True


def _release(current):
    if not current.get('guard'):
        return
    guard = _guard()
    if guard is None:
        return
    try:
        guard.release()
    except Exception:
        pass


# IPython's service names: they belong to the kernel, not the student, and a
# copy of the input log helps nobody. \`_1\`, \`_i7\` are cell echoes, same
# thing.
_SERVICE = frozenset((
    'In', 'Out', '_', '__', '___', '_i', '_ii', '_iii',
    '_ih', '_oh', '_dh', 'exit', 'quit', 'get_ipython',
))

# A module, function, class, method: an attempt has no way to spoil them so
# that it outlives the exit, and copying the numpy module would be both
# expensive and pointless.
_NOCOPY = (
    types.ModuleType, types.FunctionType, types.BuiltinFunctionType,
    types.MethodType, types.MethodWrapperType, type,
)

# The walk ceiling when ESTIMATING a container's size. A tree of a million nodes
# costs more to measure than to copy: we declare such a thing too big and leave
# it alone.
_WALK_NODES = 200000
_MISS = object()


class _Report(object):
    """A report for the server: its repr is ready-made JSON.

    user_expressions returns a mimebundle, and its text/plain is the repr() of
    the value. A string cannot be handed over: its repr would arrive in quotes
    and escaped, i.e. JSON inside JSON. An object with the right repr settles
    the question entirely.
    """
    __slots__ = ('text',)

    def __init__(self, text):
        self.text = text

    def __repr__(self):
        return self.text


def _short(err, limit=200):
    try:
        text = type(err).__name__ + ': ' + str(err)
    except Exception:
        text = type(err).__name__
    return text[:limit]


def _service(name):
    # \`globals()[1] = 2\` is legal Python: such a key is nobody's variable,
    # and treating it as one made every entry fail on \`startswith\`.
    if not isinstance(name, str):
        return True
    if name.startswith('__') and name.endswith('__'):
        return True
    if name.startswith('_colloq'):
        return True
    if name in _SERVICE:
        return True
    if len(name) > 1 and name[0] == '_':
        rest = name[1:]
        if rest.isdigit():
            return True
        if rest[0] == 'i' and rest[1:].isdigit():
            return True
    return False


def _pandas():
    return sys.modules.get('pandas')


def _numpy():
    return sys.modules.get('numpy')


def _torch():
    # Only an already imported one: our own import here would cost seconds on
    # the very first attempt in a room where nobody needs torch.
    return sys.modules.get('torch')


def _sparse():
    return sys.modules.get('scipy.sparse')


def _shell():
    """IPython's shell when inside a kernel; plain python has none, which is fine."""
    mod = sys.modules.get('IPython')
    if mod is None:
        return None
    try:
        return mod.get_ipython()
    except Exception:
        return None


def _threading():
    return sys.modules.get('threading')


def _main_thread():
    thr = _threading()
    # threading is not imported, so there is exactly one thread, and it is the
    # main one. There used to be False here, and the SIGINT handler never came
    # back in the most ordinary case: a room where nobody called threading.
    if thr is None:
        return True
    try:
        return thr.current_thread() is thr.main_thread()
    except Exception:
        return False


def _own(obj):
    """An instance of a class declared in the notebook itself.

    \`class Dataset: ...\` in a shared cell is the teacher's code, and an object
    of such a class behaves like data: an attempt changes it, and the next one
    gets it spoiled. Other classes (from libraries) are deliberately kept out: a
    database connection, a matplotlib window, a requests session are copied
    either wrongly or catastrophically expensively.
    """
    try:
        return getattr(type(obj), '__module__', None) == '__main__'
    except Exception:
        return False


def _fields(obj):
    """The instance's fields: __dict__ and __slots__ across the whole class chain."""
    out = []
    try:
        own = getattr(obj, '__dict__', None)
        if isinstance(own, dict):
            out.extend(own.values())
    except Exception:
        pass
    try:
        chain = type(obj).__mro__
    except Exception:
        return out
    for cls in chain:
        slots = getattr(cls, '__slots__', None)
        if not slots or cls is object:
            continue
        if isinstance(slots, str):
            slots = (slots,)
        for name in slots:
            try:
                out.append(getattr(obj, name))
            except Exception:
                pass
    return out


def _cow(pd):
    """A lazy pandas copy is safe only under Copy-on-Write.

    In pandas 3 it is always on and cannot be turned off; before that there is
    the options.mode.copy_on_write knob. Without CoW copy(deep=False) hands out
    a view onto the same data: a write to the copy would reach the original,
    i.e. exactly the trouble all of this exists for.
    """
    try:
        if int(str(pd.__version__).split('.')[0]) >= 3:
            return True
    except Exception:
        pass
    try:
        return bool(pd.options.mode.copy_on_write)
    except Exception:
        return False


def _frame_bytes(obj):
    try:
        used = obj.memory_usage(index=True, deep=False)
    except TypeError:
        # Index.memory_usage does not know index=True: it has no index of its own.
        try:
            used = obj.memory_usage(deep=False)
        except Exception:
            return 0
    except Exception:
        return 0
    try:
        return int(used.sum())
    except AttributeError:
        try:
            return int(used)
        except Exception:
            return 0
    except Exception:
        return 0


def _tensor_bytes(obj):
    """A tensor weighs its elements, not the wrapper; a sparse one counts by nnz."""
    try:
        item = int(obj.element_size())
    except Exception:
        return 0
    try:
        if getattr(obj, 'is_sparse', False):
            # nelement() of a sparse tensor is the DENSE size (it can be 1e12),
            # and by it any adjacency matrix would land in "too large".
            return int(obj._nnz()) * item * (1 + int(obj.dim()))
    except Exception:
        return 0
    try:
        return int(obj.nelement()) * item
    except Exception:
        return 0


def _module_bytes(obj):
    """A model weighs its parameters and buffers; the rest of it is small change."""
    total = 0
    try:
        for part in obj.parameters(recurse=True):
            total += _tensor_bytes(part)
        for part in obj.buffers(recurse=True):
            total += _tensor_bytes(part)
    except Exception:
        return 0
    return total


def _optimizer_bytes(obj, memo):
    """An optimizer weighs its state: Adam's moments are a second set of weights.

    The parameters themselves do not count here: they are the keys of \`state\`
    and belong to the model, which was (or will be) counted separately.
    Everything already decided in this entry is recognised by memo and is not
    counted twice.
    """
    total = 0
    try:
        slots = obj.state.values()
    except Exception:
        return 0
    try:
        for slot in slots:
            if not isinstance(slot, dict):
                continue
            for value in slot.values():
                if id(value) in memo:
                    continue
                total += _tensor_bytes(value)
    except Exception:
        return 0
    return total


def _sparse_bytes(obj):
    """A sparse matrix weighs its arrays, whichever of them it has."""
    total = 0
    for name in ('data', 'indices', 'indptr', 'row', 'col', 'offsets', 'coords'):
        part = getattr(obj, name, None)
        if part is None:
            continue
        items = part if isinstance(part, (tuple, list)) else (part,)
        for item in items:
            try:
                total += int(item.nbytes)
            except Exception:
                pass
    return total


def _leaf_bytes(obj):
    """A heavy leaf's weight: arrays, tables, tensors weigh not what getsizeof says.

    Without this a list of ten one-gigabyte CUDA tensors would cost eighty bytes
    by \`getsizeof\` and slip past the budget entirely.
    """
    np = _numpy()
    if np is not None and isinstance(obj, np.ndarray):
        try:
            return int(obj.nbytes)
        except Exception:
            return 0
    pd = _pandas()
    if pd is not None and isinstance(obj, (pd.DataFrame, pd.Series, pd.Index)):
        return _frame_bytes(obj)
    torch = _torch()
    if torch is not None:
        try:
            if isinstance(obj, torch.Tensor):
                return _tensor_bytes(obj)
            if isinstance(obj, torch.nn.Module):
                return _module_bytes(obj)
        except Exception:
            return 0
    sparse = _sparse()
    if sparse is not None:
        try:
            if sparse.issparse(obj):
                return _sparse_bytes(obj)
        except Exception:
            return 0
    return 0


def _deep_bytes(root):
    """A tree's weight by walking it; None: over the node ceiling, cannot measure."""
    seen = set()
    stack = [root]
    total = 0
    nodes = 0
    while stack:
        cur = stack.pop()
        key = id(cur)
        if key in seen:
            continue
        seen.add(key)
        nodes += 1
        if nodes > _WALK_NODES:
            return None
        leaf = _leaf_bytes(cur)
        if leaf:
            # A DataFrame inside a dict counts at its own weight, not the
            # wrapper's: deepcopy will copy it whole, even under CoW.
            total += leaf
            continue
        try:
            total += sys.getsizeof(cur)
        except Exception:
            total += 64
        if isinstance(cur, dict):
            stack.extend(cur.keys())
            stack.extend(cur.values())
        elif isinstance(cur, (list, tuple, set, frozenset, collections.deque)):
            stack.extend(cur)
        elif _own(cur):
            # An object of a class from the notebook is a container just the
            # same: deepcopy takes all its fields, so those are what has to be
            # measured. We do not descend into other objects: windows, sockets
            # and half a library live in there.
            stack.extend(_fields(cur))
    return total


def _estimator_bytes(obj):
    """A sklearn estimator weighs its arrays: one or two levels down __dict__."""
    total = 0
    try:
        fields = vars(obj)
    except TypeError:
        return 0
    for value in fields.values():
        total += _leaf_bytes(value)
        if isinstance(value, (list, tuple)):
            for item in value:
                total += _leaf_bytes(item)
        elif isinstance(value, dict):
            for item in value.values():
                total += _leaf_bytes(item)
    return total


def _plan(obj, memo):
    """What to copy with and what it will cost; None means do not copy at all.

    The list of types is closed, and on purpose: an open file, a generator, a
    socket, a database connection get copied either wrongly or catastrophically
    expensively, and an attempt that had such a thing swapped in fails with an
    error that is not its own. Whatever was not copied is named in the report
    and in the attempt's output.

    The order of checks goes from cheap to expensive, and that is not a matter
    of taste: \`_plan\` is called on every name of every attempt. First two
    isinstance calls against the already imported numpy and pandas, then the
    built-in containers (a plain isinstance without a single sys.modules
    lookup), and only then the libraries sticking out, each behind one dict
    lookup in sys.modules, which costs nothing in a room without torch.
    """
    if type(obj) is _NotCarried:
        # A worker's stand-in for a name its epoch left behind: there is
        # nothing to copy, and touching it would refuse.
        return None
    np = _numpy()
    if np is not None:
        if isinstance(obj, np.ndarray):
            if epoch is not None and type(obj) is np.ndarray and _backing(obj) is not None:
                # An array a worker maps from its epoch's files: its copy is a
                # fresh mapping (_remap), O(1), and costs the budget nothing.
                return ('mapped', 0)
            try:
                return ('ndarray', int(obj.nbytes))
            except Exception:
                return ('ndarray', 0)
        try:
            # A random number generator in a variable is state, and shared
            # state at that: \`rng.random()\` for one person shifts the stream
            # for the next, and identical attempts get different numbers. It
            # weighs bytes.
            if isinstance(obj, (np.random.Generator, np.random.RandomState)):
                return ('deep', 0)
        except Exception:
            pass
    rnd = sys.modules.get('random')
    if rnd is not None:
        try:
            if isinstance(obj, rnd.Random):
                return ('deep', 0)
        except Exception:
            pass
    pd = _pandas()
    if pd is not None and isinstance(obj, (pd.DataFrame, pd.Series, pd.Index)):
        if _cow(pd):
            return ('pandas-lazy', 0)
        return ('pandas-deep', _frame_bytes(obj))
    # A tuple is a container too: it is immutable itself, but a list or a table
    # inside it is not. deepcopy of a tuple with nothing to change returns the
    # tuple itself.
    if isinstance(obj, (list, dict, set, tuple, bytearray, collections.deque)):
        return ('deep', _deep_bytes(obj))
    torch = _torch()
    if torch is not None:
        try:
            # Before \`_own\`: \`class Net(nn.Module)\` in a notebook is both,
            # and a model's weight is more honestly counted by its parameters
            # than by walking its fields.
            if isinstance(obj, torch.nn.Module):
                return ('deep', _module_bytes(obj))
            if isinstance(obj, torch.Tensor):
                # A model parameter is the same tensor, down the same road.
                # deepcopy preserves requires_grad, the device and whether it
                # is a leaf; on a non-leaf tensor with gradient history it will
                # throw, and the object goes into failed: shared, but named.
                return ('deep', _tensor_bytes(obj))
            if isinstance(obj, torch.optim.Optimizer):
                # The shared memo is the only thing tying an optimizer to its
                # model: the parameters in both are the same objects, and there
                # must be one copy for the two, whatever order the names come in.
                return ('deep', _optimizer_bytes(obj, memo))
        except Exception:
            return None
    sparse = _sparse()
    if sparse is not None:
        try:
            if sparse.issparse(obj):
                return ('sparse', _sparse_bytes(obj))
        except Exception:
            return None
    base = sys.modules.get('sklearn.base')
    if base is not None:
        try:
            if isinstance(obj, base.BaseEstimator):
                return ('deep', _estimator_bytes(obj))
        except Exception:
            return None
    if _own(obj):
        return ('deep', _deep_bytes(obj))
    return None


def _make(kind, obj, memo):
    if kind == 'ndarray':
        return obj.copy()
    if kind == 'pandas-lazy':
        return obj.copy(deep=False)
    if kind == 'pandas-deep':
        return obj.copy(deep=True)
    if kind == 'sparse':
        # scipy's own copy() is cheaper than deepcopy and knows the format.
        return obj.copy()
    return copy.deepcopy(obj, memo)


def _read_int(path):
    try:
        with open(path) as handle:
            raw = handle.read().strip()
    except Exception:
        return None
    if raw == 'max':
        return None
    try:
        value = int(raw)
    except Exception:
        return None
    # cgroup v1 writes "no limit" as 2**63-1: that is not a limit but its absence.
    if value <= 0 or value > (1 << 60):
        return None
    return value


def _cgroup(*names):
    for name in names:
        value = _read_int('/sys/fs/cgroup/' + name)
        if value is not None:
            return value
    return None


def _reclaimable():
    """File cache the cgroup counts as used but will give back on first demand.

    memory.current includes the pages of files that were read: after a
    one-gigabyte read_csv, "used" is a gigabyte higher, although the OOM killer
    will not come for those pages; the Linux kernel simply drops them. Counting
    them as used would mean refusing the attempt memory that is in fact free.
    docker stats counts the same way: usage minus inactive_file.
    """
    for path, key in (
        ('/sys/fs/cgroup/memory.stat', 'inactive_file '),
        ('/sys/fs/cgroup/memory/memory.stat', 'total_inactive_file '),
    ):
        try:
            with open(path) as handle:
                for line in handle:
                    if line.startswith(key):
                        return int(line.split()[1])
        except Exception:
            continue
    return 0


def _vmsize():
    """The process's address space right now, in bytes."""
    try:
        with open('/proc/self/status') as handle:
            for line in handle:
                if line.startswith('VmSize:'):
                    return int(line.split()[1]) * 1024
    except Exception:
        return None
    return None


def _gpu_near():
    """Whether CUDA is nearby: with it an address-space ceiling must not be set.

    The driver reserves tens of terabytes of VIRTUAL address space (not used
    memory), and RLIMIT_AS breaks initialisation for good. Better no ceiling
    than a room where torch does not work.
    """
    torch = _torch()
    if torch is not None:
        try:
            if torch.cuda.is_initialized() or torch.cuda.is_available():
                return True
        except Exception:
            return True
    if os.environ.get('NVIDIA_VISIBLE_DEVICES', '').strip() not in ('', 'void', 'none'):
        return True
    for node in ('/dev/nvidiactl', '/dev/nvidia0'):
        try:
            if os.path.exists(node):
                return True
        except Exception:
            pass
    return False


def _memory_cap(floor, headroom, cap=None):
    """How much address space to give the attempt; None means no ceiling.

    Counted from the container's limit, not the machine's: the notebook's kernel
    lives in a cgroup, and it is that cgroup's OOM killer that kills it. From the
    limit we subtract what is already used (by the teacher's data too) and a
    reserve for the kernel itself; we never go below the floor, since a ceiling
    under which not even an import works is worse than none.

    MEASURED on 20 Sep 2026 on the same image, the same hardware and the real
    class data (three HistGradientBoostingClassifier on 240,000 rows,
    OMP_NUM_THREADS=10):

        no ceiling     VmPeak 2.37 GB   VmHWM 0.45 GB
        with ceiling   VmPeak 2.33 GB   VmHWM 0.46 GB, headroom under the ceiling 14.2 GB

    Two conclusions, and both matter. First: the ceiling does NOT kill the
    process; checked both on greed (\`np.ones((40000, 40000))\`, a cartesian
    join) and on the attempt itself under a tight ceiling; an honest
    \`MemoryError\` comes up, not \`std::bad_alloc\` and not a signal. Second,
    an unpleasant one: the address space is FIVE TIMES larger than the real
    consumption, while the budget is counted from what is USED, i.e. the real
    thing. In a 16 GB room the difference drowns in the reserve, but in a small
    one (the 512 MB floor) an ordinary \`fit\` hits the ceiling and answers
    \`RuntimeError: can't allocate read lock\`, an error from which the
    attempt's author will understand nothing. This is a known shortcoming, not
    the cause of the kernel deaths on 20 Sep 2026: those came from
    \`os._exit(0)\` in an attempt (see \`_hold\` and danger.ts), with the cgroup
    untouched (\`oom_kill 0\`, peak 5.2 of 16 GB).

    A council worker passes \`cap\` («Память на попытку», D33), and its
    ceiling is then never above it (§9.3 detail 5): N workers share one
    cgroup, and each reading "what is left of the container" would promise
    every one of them the same remainder. The remainder still lowers it when
    it is smaller, down to the floor (or to \`cap\` when that is lower still),
    and a card nearby does not lift it: a worker has none (D11), and its
    ceiling is not optional.
    """
    if not _linux():
        return None
    if cap is None and _gpu_near():
        return None
    limit = _cgroup('memory.max', 'memory/memory.limit_in_bytes')
    used = _cgroup('memory.current', 'memory/memory.usage_in_bytes')
    if cap is None:
        if limit is None or used is None:
            return None
        room = limit - max(used - _reclaimable(), 0) - headroom
        if room < floor:
            room = floor
        return room
    room = int(cap)
    if limit is not None and used is not None:
        free = limit - max(used - _reclaimable(), 0) - headroom
        room = min(room, max(free, min(floor, room)))
    return room


def _linux():
    """Where RLIMIT_AS and the cgroup files mean what this module reads them for."""
    return sys.platform.startswith('linux')


def _arm_memory(floor, headroom, cap=None):
    """Set the ceiling, returning the old one (for the exit) and the amount given."""
    res = sys.modules.get('resource')
    if res is None:
        try:
            import resource as res
        except Exception:
            return None
    room = _memory_cap(floor, headroom, cap)
    if room is None:
        return None
    base = _vmsize()
    if base is None:
        return None
    try:
        soft, hard = res.getrlimit(res.RLIMIT_AS)
    except Exception:
        return None
    wanted = base + room
    if hard != res.RLIM_INFINITY and wanted > hard:
        wanted = hard
    if soft != res.RLIM_INFINITY and wanted >= soft:
        # Someone already set a ceiling below ours: it takes precedence, leave it.
        if cap is None:
            return None
        # A worker's ceiling is not optional, and a lower one already in
        # place is a ceiling kept: the exit puts back exactly what it found.
        return {'soft': soft, 'hard': hard, 'room': max(soft - base, 0)}
    try:
        res.setrlimit(res.RLIMIT_AS, (wanted, hard))
    except Exception:
        return None
    return {'soft': soft, 'hard': hard, 'room': room}


def _disarm_memory(saved):
    if not saved:
        return
    res = sys.modules.get('resource')
    if res is None:
        return
    try:
        res.setrlimit(res.RLIMIT_AS, (saved['soft'], saved['hard']))
    except Exception:
        pass


def _snapshot():
    """The PROCESS state an attempt can shift for the whole room.

    Not the names (saved holds those) but everything around them: the random
    number stream, the output streams, sys.path, the environment, numpy and
    pandas print settings, the interrupt handler, open matplotlib figures.
    Every line here is "someone will do this, and the next twenty attempts will
    compute differently".

    We import nothing: what the kernel does not have, an attempt cannot shift
    either.
    """
    snap = {}
    rnd = sys.modules.get('random')
    if rnd is not None:
        try:
            snap['random'] = rnd.getstate()
        except Exception:
            pass
    np = _numpy()
    if np is not None:
        try:
            snap['np_random'] = np.random.get_state()
        except Exception:
            pass
        try:
            snap['np_print'] = np.get_printoptions()
        except Exception:
            pass
        try:
            snap['np_err'] = np.geterr()
        except Exception:
            pass
    torch = _torch()
    if torch is not None:
        try:
            snap['torch_rng'] = torch.get_rng_state()
        except Exception:
            pass
        try:
            if torch.cuda.is_initialized():
                snap['torch_cuda_rng'] = torch.cuda.get_rng_state_all()
        except Exception:
            pass
        try:
            snap['torch_grad'] = torch.is_grad_enabled()
        except Exception:
            pass
        try:
            snap['torch_dtype'] = torch.get_default_dtype()
        except Exception:
            pass
    try:
        snap['streams'] = (sys.stdout, sys.stderr, sys.stdin,
                           sys.displayhook, sys.excepthook)
    except Exception:
        pass
    try:
        snap['path'] = list(sys.path)
    except Exception:
        pass
    try:
        snap['reclimit'] = sys.getrecursionlimit()
    except Exception:
        pass
    try:
        snap['trace'] = (sys.gettrace(), sys.getprofile())
    except Exception:
        pass
    thr_hooks = _threading()
    if thr_hooks is not None:
        try:
            # The same hooks, but for threads started AFTER the attempt: a
            # profiler left behind would silently slow the whole room down.
            snap['thread_trace'] = (thr_hooks.gettrace(), thr_hooks.getprofile())
        except Exception:
            pass
    try:
        snap['environ'] = dict(os.environ)
    except Exception:
        pass
    warn = sys.modules.get('warnings')
    if warn is not None:
        try:
            snap['warnfilters'] = warn.filters[:]
        except Exception:
            pass
    try:
        snap['builtins'] = dict(vars(builtins))
    except Exception:
        pass
    sig = sys.modules.get('signal')
    if sig is not None and _main_thread():
        try:
            snap['sigint'] = sig.getsignal(sig.SIGINT)
        except Exception:
            pass
    dec = sys.modules.get('decimal')
    if dec is not None:
        try:
            snap['decimal'] = dec.getcontext().copy()
        except Exception:
            pass
    pd = _pandas()
    if pd is not None:
        try:
            # A private pandas API, and so strictly inside try: if it breaks, we
            # simply do not restore the options instead of failing the entry.
            snap['pd_options'] = copy.deepcopy(pd._config.config._global_config)
        except Exception:
            pass
    sk = sys.modules.get('sklearn')
    if sk is not None:
        try:
            snap['sklearn'] = sk.get_config()
        except Exception:
            pass
    shell = _shell()
    if shell is not None:
        try:
            # With %pdb on, the kernel sits down in the debugger on SOMEONE
            # ELSE'S exception, holding the whole room's queue until a restart.
            snap['call_pdb'] = shell.call_pdb
        except Exception:
            pass
        try:
            snap['events'] = dict(
                (key, list(value)) for key, value in shell.events.callbacks.items())
        except Exception:
            pass
    plt = sys.modules.get('matplotlib.pyplot')
    if plt is not None:
        try:
            snap['fignums'] = set(plt.get_fignums())
        except Exception:
            pass
    # An empty set, not a missing key: the attempt may ITSELF be the first to
    # call threading or multiprocessing, and then its own threads would go
    # unnoticed, which is exactly the case this count exists for.
    snap['children'] = set()
    snap['threads'] = set()
    mp = sys.modules.get('multiprocessing')
    if mp is not None:
        try:
            snap['children'] = set(id(child) for child in mp.active_children())
        except Exception:
            pass
    thr = _threading()
    if thr is not None:
        try:
            snap['threads'] = set(id(item) for item in thr.enumerate())
        except Exception:
            pass
    return snap


def _restore(snap):
    """Return the process state. Each line swallows its own trouble separately.

    Returns a count of what CANNOT be returned: threads the attempt left
    running. The server names them to the teacher in the attempt's output:
    there is no way to stop someone else's thread, and keeping quiet about it
    is worse.
    """
    left = {'threads': 0, 'processes': 0}
    if not snap:
        return left
    rnd = sys.modules.get('random')
    if rnd is not None and 'random' in snap:
        try:
            rnd.setstate(snap['random'])
        except Exception:
            pass
    np = _numpy()
    if np is not None:
        if 'np_random' in snap:
            try:
                np.random.set_state(snap['np_random'])
            except Exception:
                pass
        if 'np_print' in snap:
            try:
                np.set_printoptions(**snap['np_print'])
            except Exception:
                pass
        if 'np_err' in snap:
            try:
                np.seterr(**snap['np_err'])
            except Exception:
                pass
    torch = _torch()
    if torch is not None:
        if 'torch_rng' in snap:
            try:
                torch.set_rng_state(snap['torch_rng'])
            except Exception:
                pass
        if 'torch_cuda_rng' in snap:
            try:
                torch.cuda.set_rng_state_all(snap['torch_cuda_rng'])
            except Exception:
                pass
        if 'torch_grad' in snap:
            try:
                torch.set_grad_enabled(snap['torch_grad'])
            except Exception:
                pass
        if 'torch_dtype' in snap:
            try:
                torch.set_default_dtype(snap['torch_dtype'])
            except Exception:
                pass
    if 'streams' in snap:
        try:
            out, err, inp, display, excepthook = snap['streams']
            sys.stdout, sys.stderr, sys.stdin = out, err, inp
            sys.displayhook, sys.excepthook = display, excepthook
        except Exception:
            pass
    if 'path' in snap:
        try:
            sys.path[:] = snap['path']
        except Exception:
            pass
    if 'reclimit' in snap:
        try:
            sys.setrecursionlimit(snap['reclimit'])
        except Exception:
            pass
    if 'trace' in snap:
        try:
            sys.settrace(snap['trace'][0])
            sys.setprofile(snap['trace'][1])
        except Exception:
            pass
    if 'thread_trace' in snap:
        try:
            hooks = _threading()
            hooks.settrace(snap['thread_trace'][0])
            hooks.setprofile(snap['thread_trace'][1])
        except Exception:
            pass
    if 'environ' in snap:
        try:
            was = snap['environ']
            for key in [k for k in _list(os.environ) if k not in was]:
                try:
                    del os.environ[key]
                except Exception:
                    pass
            for key in was:
                try:
                    if os.environ.get(key) != was[key]:
                        os.environ[key] = was[key]
                except Exception:
                    pass
        except Exception:
            pass
    warn = sys.modules.get('warnings')
    if warn is not None and 'warnfilters' in snap:
        try:
            warn.filters[:] = snap['warnfilters']
        except Exception:
            pass
    if 'builtins' in snap:
        try:
            was = snap['builtins']
            for key in [k for k in _list(_vars(builtins)) if k not in was]:
                try:
                    _delattr(builtins, key)
                except Exception:
                    pass
            for key in was:
                try:
                    if _getattr(builtins, key, _MISS) is not was[key]:
                        _setattr(builtins, key, was[key])
                except Exception:
                    pass
        except Exception:
            pass
    sig = sys.modules.get('signal')
    if sig is not None and 'sigint' in snap and _main_thread():
        try:
            sig.signal(sig.SIGINT, snap['sigint'])
        except Exception:
            pass
    dec = sys.modules.get('decimal')
    if dec is not None and 'decimal' in snap:
        try:
            dec.setcontext(snap['decimal'])
        except Exception:
            pass
    pd = _pandas()
    if pd is not None and 'pd_options' in snap:
        try:
            live = pd._config.config._global_config
            live.clear()
            live.update(snap['pd_options'])
        except Exception:
            pass
    sk = sys.modules.get('sklearn')
    if sk is not None and 'sklearn' in snap:
        try:
            sk.set_config(**snap['sklearn'])
        except Exception:
            pass
    shell = _shell()
    if shell is not None:
        if 'call_pdb' in snap:
            try:
                shell.call_pdb = snap['call_pdb']
            except Exception:
                pass
        if 'events' in snap:
            try:
                live = shell.events.callbacks
                for key in live:
                    # In place, not by swapping the list: IPython itself and
                    # everything that subscribed before the attempt look at
                    # these same lists.
                    live[key][:] = snap['events'].get(key, [])
            except Exception:
                pass
    plt = sys.modules.get('matplotlib.pyplot')
    if plt is not None and 'fignums' in snap:
        try:
            for num in _list(plt.get_fignums()):
                if num not in snap['fignums']:
                    try:
                        plt.close(num)
                    except Exception:
                        pass
        except Exception:
            pass
    mp = sys.modules.get('multiprocessing')
    if mp is not None and 'children' in snap:
        try:
            for child in mp.active_children():
                if _id(child) in snap['children']:
                    continue
                left['processes'] += 1
                try:
                    child.terminate()
                except Exception:
                    pass
        except Exception:
            pass
    thr = _threading()
    if thr is not None and 'threads' in snap:
        try:
            # Our own thread and the main one are not the attempt's leftovers,
            # even if the snapshot is empty (it was taken before threading
            # appeared in the kernel at all).
            skip = set()
            try:
                skip.add(_id(thr.current_thread()))
                skip.add(_id(thr.main_thread()))
            except Exception:
                pass
            for item in thr.enumerate():
                if _id(item) in snap['threads'] or _id(item) in skip:
                    continue
                if item.is_alive():
                    left['threads'] += 1
        except Exception:
            pass
    return left


# ----------------------------------------------------------------- workers
#
# A council worker (remote-classes.md §9.5) is a kernel of its own, seeded
# by \`load\` (the epoch half of this module, EPOCH_IMPL) from an epoch: a
# frozen copy of the notebook kernel's names. The entry and the exit do four
# things more there, all of them below, and none of them in the notebook's
# own kernel, where \`epoch\` stays None:
#   · an attempt that reads a name the epoch left behind is refused before
#     anything is copied, and runs in the shared kernel instead (§9.4);
#   · every attempt starts from the epoch's random state (§9.7);
#   · an array mapped from the epoch's files gets a fresh private mapping
#     instead of a copy (§9.3, detail 3);
#   · the attempt works in a scratch folder of its own, and the exit lists
#     the files it wrote there (§9.7, D10).


class NotCarried(Exception):
    """An attempt reached a name its epoch left behind (§9.4)."""


class _NotCarried(object):
    """What a worker holds in place of a name its epoch could not carry.

    A NameError would be a lie (the name exists, in the notebook's kernel)
    and None a worse one: the attempt would compute on nothing and print a
    plausible answer. So any use of the stand-in raises NotCarried in the
    room's words, naming the variable, why it stayed behind and where such
    attempts run. Reads the entry can see are refused before the attempt
    starts (\`_colloq_needs\`); this catches the rest, \`globals()['conn']\`
    and the like.

    Special methods are looked up on the type, past \`__getattr__\`: hence
    the list below, so that iterating, calling, indexing, comparing,
    printing and pickling it all refuse alike.
    """
    __slots__ = ('_colloq_name', '_colloq_why', '_colloq_text')

    def __init__(self, name, why, text):
        object.__setattr__(self, '_colloq_name', name)
        object.__setattr__(self, '_colloq_why', why)
        object.__setattr__(self, '_colloq_text', text)

    def _colloq_refuse(self, *args, **kwargs):
        raise NotCarried(object.__getattribute__(self, '_colloq_text'))

    def __getattr__(self, name):
        raise NotCarried(object.__getattribute__(self, '_colloq_text'))


for _method in (
        '__call__', '__iter__', '__next__', '__aiter__', '__anext__', '__await__',
        '__len__', '__length_hint__', '__getitem__', '__setitem__', '__delitem__',
        '__contains__', '__enter__', '__exit__', '__aenter__', '__aexit__',
        '__bool__', '__str__', '__repr__', '__format__', '__bytes__', '__fspath__',
        '__index__', '__int__', '__float__', '__complex__', '__round__',
        '__eq__', '__ne__', '__lt__', '__le__', '__gt__', '__ge__', '__hash__',
        '__setattr__', '__delattr__', '__reduce__', '__reduce_ex__', '__copy__',
        '__deepcopy__', '__neg__', '__pos__', '__abs__', '__invert__',
        '__add__', '__radd__', '__iadd__', '__sub__', '__rsub__', '__isub__',
        '__mul__', '__rmul__', '__imul__', '__matmul__', '__rmatmul__',
        '__truediv__', '__rtruediv__', '__floordiv__', '__rfloordiv__',
        '__mod__', '__rmod__', '__pow__', '__rpow__', '__and__', '__rand__',
        '__or__', '__ror__', '__xor__', '__rxor__', '__lshift__', '__rlshift__',
        '__rshift__', '__rrshift__'):
    setattr(_NotCarried, _method, _NotCarried._colloq_refuse)
del _method


def _reseed(current):
    """Put the epoch's random state back before an attempt (§9.7).

    The exit returns the state the entry found, so in a worker that is the
    epoch's anyway. Setting it again here is what makes it hold whatever
    happened in between (an import that draws a number, a service line):
    identical attempts print identical numbers on every worker, as they do
    one after another in the shared kernel.
    """
    rng = current.get('rng') or {}
    rnd = sys.modules.get('random')
    if rnd is not None and 'random' in rng:
        try:
            rnd.setstate(rng['random'])
        except Exception:
            pass
    np = _numpy()
    if np is not None and 'np_random' in rng:
        try:
            np.random.set_state(rng['np_random'])
        except Exception:
            pass
    torch = _torch()
    if torch is not None and 'torch_rng' in rng:
        try:
            torch.set_rng_state(rng['torch_rng'])
        except Exception:
            pass


def _backing(obj):
    """The epoch file an array's memory is mapped from: (path, mapping, address, descriptor), or None.

    numpy keeps the chain: a reshaped view, the array frombuffer made, the
    memoryview pickle handed it, and that memoryview's object is one of the
    mappings \`load\` made. Identity, not equality, decides.
    """
    current = epoch
    known = current.get('backing') if current else None
    if not known:
        return None
    np = _numpy()
    root = obj
    for _ in range(64):
        nxt = getattr(root, 'base', None) if isinstance(root, np.ndarray) else None
        if nxt is None:
            break
        root = nxt
    if isinstance(root, memoryview):
        try:
            root = root.obj
        except Exception:
            return None
    entry = known.get(id(root))
    if entry is None or entry[1] is not root:
        return None
    return entry


def _remap(obj):
    """A personal copy of an epoch-backed array in O(1) (§9.3, detail 3).

    A worker maps its epoch's files copy-on-write: their pages are shared by
    every worker through the page cache and charged to the container once. A
    copy of a 500 MB array per attempt would undo that, so the attempt gets
    a fresh private mapping of the same file: the same bytes, nothing
    copied, and its writes land in pages of its own that go with it. The
    worker's own mapping, and so the next attempt, never sees them.

    From the descriptor the seed kept, never by the file's path: the agent
    lets an older epoch's files go a minute after a newer one is ready, and
    an attempt on the older one still maps what it was seeded from. When the
    mapping fails anyway (memory, descriptors), this raises, and the entry
    makes a plain copy that counts against its budget, as in the shared
    kernel.
    """
    entry = _backing(obj)
    if entry is None or entry[2] is None or entry[3] is None:
        raise LookupError('not mapped')
    np = _numpy()
    fresh = _mmap(entry[3])
    made = np.ndarray(obj.shape, dtype=obj.dtype, buffer=fresh,
                      offset=obj.__array_interface__['data'][0] - entry[2],
                      strides=obj.strides)
    if not obj.flags.writeable:
        made.flags.writeable = False
    return made


def _mmap(fd):
    """A copy-on-write mapping of a whole file.

    Python before 3.13 keeps a duplicate of the descriptor for every mapping
    (for \`size()\` and \`resize()\`, which nothing here calls); 3.13 can be
    told not to. Where it cannot, the seed makes room for them (_fds).
    """
    import mmap
    try:
        return mmap.mmap(fd, 0, access=mmap.ACCESS_COPY, trackfd=False)
    except TypeError:
        return mmap.mmap(fd, 0, access=mmap.ACCESS_COPY)


# Where Linux says how much private memory a process has written.
_SMAPS = '/proc/self/smaps_rollup'


def _dirty():
    """This process's private dirty memory, in bytes; None where Linux does not say.

    What a worker holds for itself alone: its heap, the attempts' leftovers,
    epoch pages it wrote into, modules an attempt imported. The epoch's
    shared pages are clean and do not count, which is the whole point of
    mapping them (§9.3, detail 4).
    """
    try:
        with open(_SMAPS) as handle:
            for line in handle:
                if line.startswith('Private_Dirty:'):
                    return int(line.split()[1]) * 1024
    except Exception:
        return None
    return None


def _run_id(value):
    """A run id as REMOTE_RUN_ID has it: one plain folder name, never a path."""
    return (isinstance(value, str) and 0 < len(value) <= 64
            and all((char.isascii() and char.isalnum()) or char in '-_' for char in value))


def _skeleton(source, target, limit, cwd=None):
    """The class tree in a scratch folder: real folders, files as links into the class mount (§9.7).

    So \`open('data.csv')\` reads the class file, while \`to_csv('out.csv')\`
    and \`savefig('figs/a.png')\` write into the scratch folder, subfolders
    included; overwriting a class file fails, because the mount is
    read-only. A tree of more than \`limit\` entries gets the top level
    only, folders as links too, except the folders down to the notebook's
    own (\`cwd\`), which stay real: the attempt starts there, and its
    relative reads find the files beside it. Even then at most \`limit\`
    links, the notebook's own folder's first. Returns the paths it linked:
    the exit never counts them as the attempt's.
    """
    entries = []
    pending = ['']
    over = False
    while pending and not over:
        rel = pending.pop()
        try:
            with os.scandir(os.path.join(source, rel) if rel else source) as listing:
                for item in listing:
                    if len(entries) >= limit:
                        over = True
                        break
                    path = rel + '/' + item.name if rel else item.name
                    try:
                        folder = item.is_dir(follow_symlinks=False)
                    except OSError:
                        continue
                    entries.append((path, folder))
                    if folder:
                        pending.append(path)
        except OSError:
            continue
    if over:
        entries = _top_skeleton(source, limit, cwd)
    links = set()
    for path, folder in entries:
        place = os.path.join(target, path)
        try:
            if folder:
                os.mkdir(place)
            else:
                os.symlink(os.path.join(source, path), place)
                links.add(path)
        except OSError:
            pass
    return links


def _top_skeleton(source, limit, cwd):
    """Past the cap: the folders down to \`cwd\` as real folders, every other entry beside them as a link, at most \`limit\` links."""
    folders = []
    levels = ['']
    rel = ''
    for part in [part for part in (cwd or '').split('/') if part]:
        down = os.path.join(source, rel, part)
        if os.path.islink(down) or not os.path.isdir(down):
            break
        rel = rel + '/' + part if rel else part
        folders.append((rel, True))
        levels.append(rel)
    real = set(path for path, _ in folders)
    links = []
    for rel in reversed(levels):
        try:
            with os.scandir(os.path.join(source, rel) if rel else source) as listing:
                for item in listing:
                    if len(links) >= limit:
                        break
                    path = rel + '/' + item.name if rel else item.name
                    if path not in real:
                        links.append((path, False))
        except OSError:
            continue
        if len(links) >= limit:
            break
    return folders + links


# The entries an exit looks at in a scratch folder at most (COUNCIL_SCRATCH_WALK).
_WALK = ${COUNCIL_SCRATCH_WALK}


def _regular(folder, links=()):
    """The regular files under a folder by path, with (size, mtime): links neither followed nor listed.

    At most _WALK entries are looked at, folders and the attempt's own links
    among them; the skeleton's links (\`links\`) are not the attempt's and do
    not count. Past the cap the walk stops: an attempt that makes a million
    folders does not hold its worker's exit for minutes.
    """
    found = {}
    seen = 0
    pending = ['']
    while pending:
        rel = pending.pop()
        try:
            with os.scandir(os.path.join(folder, rel) if rel else folder) as listing:
                for item in listing:
                    path = rel + '/' + item.name if rel else item.name
                    try:
                        link = item.is_symlink()
                        inner = not link and item.is_dir(follow_symlinks=False)
                    except OSError:
                        continue
                    if link and path in links:
                        continue
                    seen += 1
                    if seen > _WALK:
                        return found
                    if link:
                        continue
                    if inner:
                        pending.append(path)
                        continue
                    try:
                        info = item.stat(follow_symlinks=False)
                    except OSError:
                        continue
                    if stat.S_ISREG(info.st_mode):
                        found[path] = (info.st_size, info.st_mtime_ns)
        except OSError:
            continue
    return found


def _plain(name):
    """A name the card can show and a URL can carry: UTF-8, no control characters."""
    try:
        name.encode('utf-8')
    except UnicodeError:
        return False
    return all(32 <= ord(char) != 127 for char in name)


# What JavaScript's trim() takes off a name, which shared/paths refuses at either end.
_TRIM = ''.join(chr(code) for code in (9, 10, 11, 12, 13, 32, 0xa0, 0x1680, 0x2028, 0x2029,
                                        0x202f, 0x205f, 0x3000, 0xfeff) + tuple(range(0x2000, 0x200b)))


def _canonical(path):
    """A path the contract carries as it is (shared/paths · normalizePath): only such a name reaches a card.

    The same rules, so that a name home would drop never takes one of the
    artifacts' places: at most ${MAX_DEPTH} segments and ${MAX_PATH} characters, each
    segment at most ${MAX_SEGMENT} characters and ${MAX_SEGMENT_BYTES} bytes, none hidden, none with a
    backslash, a control character or a space at either end.
    """
    if _units(path) > ${MAX_PATH}:
        return False
    parts = path.split('/')
    if len(parts) > ${MAX_DEPTH}:
        return False
    for part in parts:
        if not part or part.startswith('.') or chr(92) in part or not _plain(part):
            return False
        if _units(part) > ${MAX_SEGMENT} or len(part.encode('utf-8')) > ${MAX_SEGMENT_BYTES}:
            return False
        if part != part.strip(_TRIM):
            return False
    return True


def _units(text):
    """A string's length as JavaScript counts it, in UTF-16 code units."""
    return len(text) + sum(1 for char in text if ord(char) > 0xffff)


def _file_sha(path, size):
    """A regular file's sha256 over exactly \`size\` bytes, never through a link; None otherwise.

    Opened without blocking: a thread the attempt left behind may have put
    a FIFO in the file's place since it was listed, and reading one would
    hold the exit until a writer came.
    """
    try:
        fd = os.open(path, os.O_RDONLY | getattr(os, 'O_NOFOLLOW', 0) | getattr(os, 'O_NONBLOCK', 0))
    except OSError:
        return None
    try:
        info = os.fstat(fd)
        if not stat.S_ISREG(info.st_mode) or info.st_size != size:
            return None
        digest = hashlib.sha256()
        rest = size
        while rest > 0:
            chunk = os.read(fd, min(rest, 1 << 16))
            if not chunk:
                return None
            digest.update(chunk)
            rest -= len(chunk)
        return digest.hexdigest()
    except OSError:
        return None
    finally:
        os.close(fd)


def _scratch(settings, current):
    """Make the attempt's scratch folder, and go into it (§9.7).

    \`<root>/<runId>\`, with the class tree's skeleton when it is new. A
    folder that is there already (a rerun of the same attempt) is kept as it
    is, and only what changes in it from here counts as the attempt's. The
    attempt starts in the folder that mirrors the notebook kernel's folder
    of the epoch. A folder that is a link is refused: the attempt would
    write, and the exit list, wherever it points.
    """
    run = settings.get('runId')
    if not _run_id(run):
        raise ValueError('a bad run id')
    folder = os.path.join(settings.get('scratch') or '${COUNCIL_SCRATCH_MOUNT}', run)
    try:
        os.mkdir(folder)
        fresh = True
    except FileExistsError:
        fresh = False
    if os.path.islink(folder) or not os.path.isdir(folder):
        raise ValueError('the scratch folder is not a folder')
    workspace = settings.get('workspace') or (current.get('workspace') if current else None)
    rel = current.get('cwd') if current else None
    links = set()
    if workspace and os.path.isdir(workspace) and (fresh or not os.listdir(folder)):
        links = _skeleton(workspace, folder, int(settings.get('entries') or ${COUNCIL_SCRATCH_ENTRIES}), rel)
    before = _regular(folder, links)
    place = folder
    if rel:
        inner = os.path.join(folder, rel)
        if os.path.isdir(inner) and not os.path.islink(inner):
            place = inner
    os.chdir(place)
    return {'folder': folder, 'before': before, 'links': links}


def _artifacts(scratch):
    """The files the attempt wrote into its scratch folder, for its card (§9.7, D10).

    New or changed regular files, by name, with a sha256 for those within
    the caps (${COUNCIL_ARTIFACTS.files} files, each up to ${COUNCIL_ARTIFACTS.fileBytes} bytes, ${COUNCIL_ARTIFACTS.totalBytes} in all):
    home asks the agent to bring exactly those. The rest are named with
    their size and stay behind. Links into the class folder are the
    skeleton's, never the attempt's work. A name the contract would not
    carry (\`.cache.json\`, too deep, too long) is counted, never listed:
    it would take a place within the caps and then be dropped at home.
    """
    folder = scratch['folder']
    before = scratch['before']
    now = _regular(folder, scratch.get('links') or ())
    changed = [name for name, mark in now.items() if before.get(name) != mark]
    names = sorted(name for name in changed if _canonical(name))
    rows = []
    taken = 0
    total = 0
    for name in names[:${COUNCIL_EXIT_FILES_MAX}]:
        size = now[name][0]
        row = {'name': name, 'bytes': size}
        if (taken < ${COUNCIL_ARTIFACTS.files} and size <= ${COUNCIL_ARTIFACTS.fileBytes}
                and total + size <= ${COUNCIL_ARTIFACTS.totalBytes}):
            digest = _file_sha(os.path.join(folder, name), size)
            if digest is not None:
                row['sha256'] = digest
                taken += 1
                total += size
        rows.append(row)
    return rows, len(changed) - len(rows)


def _python_of(source):
    """The attempt as Python: IPython's own transform in a kernel, a stand-in elsewhere.

    Magics and shell lines become calls with string arguments, so a name
    used only inside one is invisible here, and the sentinel catches it when
    it runs. The magics that run Python in the attempt's own namespace,
    \`%%time\` at the top of a cell above all, are unwrapped first
    (_unmagic): their code is read like the rest. Without IPython (a plain
    python3, the tests), the other magics and shell lines become \`pass\`,
    and another cell magic hides the whole cell.
    """
    source = _unmagic(source)
    shell = _shell()
    if shell is not None:
        try:
            return shell.transform_cell(source)
        except Exception:
            pass
    lines = []
    for line in source.splitlines():
        stripped = line.lstrip()
        if stripped.startswith('%%'):
            return ''
        if stripped[:1] in ('%', '!'):
            line = line[:len(line) - len(stripped)] + 'pass'
        lines.append(line)
    return chr(10).join(lines)


# Magics whose argument (a line magic's) or body (a cell magic's) is Python
# run in the attempt's own namespace: \`%%time\` heads a student's cell often.
_PYTHON_MAGICS = frozenset(('time', 'timeit', 'prun', 'capture'))


def _unmagic(source):
    """The attempt with its timing and capture magics taken off: the code they run, where they run it."""
    lines = source.splitlines()
    top = 0
    while top < len(lines) and not lines[top].strip():
        top += 1
    if top < len(lines) and lines[top].lstrip().startswith('%%'):
        words = lines[top].lstrip()[2:].split(None, 1)
        if words and words[0] in _PYTHON_MAGICS:
            lines = lines[top + 1:]
    out = []
    for line in lines:
        stripped = line.lstrip()
        if stripped.startswith('%') and not stripped.startswith('%%'):
            words = stripped[1:].split(None, 1)
            if words and words[0] in _PYTHON_MAGICS:
                code = _magic_code(words[1] if len(words) > 1 else '')
                line = line[:len(line) - len(stripped)] + (code or 'pass')
        out.append(line)
    return chr(10).join(out)


def _magic_code(rest):
    """A line magic's statement past its options (\`-n 10 conn.q()\`): the longest tail that parses."""
    tail = rest.strip()
    for _ in range(8):
        if not tail:
            return None
        try:
            compile(tail, '<magic>', 'exec', ast.PyCF_ONLY_AST)
            return tail
        except Exception:
            pass
        parts = tail.split(None, 1)
        tail = parts[1] if len(parts) > 1 else ''
    return None


class _Reads(object):
    """The top level of an attempt, in the order Python runs it: what it reads before it binds.

    \`conn = conn.cursor()\` reads the epoch's \`conn\` before binding its own,
    and \`x += 1\` reads \`x\`: a set of the names bound anywhere would call
    both safe. Class bodies and comprehensions run where they stand, with
    names of their own; function and lambda bodies run later, if at all, and
    what they read is symtable's part (_colloq_needs). Branches are taken in
    order, as if all of them ran.
    """

    def __init__(self, left):
        self.left = left
        self.bound = set()
        self.inner = []
        self.needs = set()

    def read(self, name):
        for scope in self.inner:
            if name in scope:
                return
        if name in self.left and name not in self.bound:
            self.needs.add(name)

    def bind(self, name):
        if self.inner:
            self.inner[-1].add(name)
        else:
            self.bound.add(name)

    def block(self, body):
        for node in body:
            self.statement(node)

    def statement(self, node):
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
            for item in node.decorator_list:
                self.expr(item)
            self.arguments(node.args)
            if node.returns is not None:
                self.expr(node.returns)
            self.bind(node.name)
        elif isinstance(node, ast.ClassDef):
            for item in node.decorator_list + node.bases:
                self.expr(item)
            for item in node.keywords:
                self.expr(item.value)
            self.inner.append(set())
            self.block(node.body)
            self.inner.pop()
            self.bind(node.name)
        elif isinstance(node, ast.Assign):
            self.expr(node.value)
            for item in node.targets:
                self.target(item)
        elif isinstance(node, ast.AugAssign):
            if isinstance(node.target, ast.Name):
                self.read(node.target.id)
            self.expr(node.value)
            self.target(node.target)
        elif isinstance(node, ast.AnnAssign):
            if node.value is not None:
                self.expr(node.value)
                self.target(node.target)
            elif not isinstance(node.target, ast.Name):
                self.expr(node.target)
        elif isinstance(node, (ast.For, ast.AsyncFor)):
            self.expr(node.iter)
            self.target(node.target)
            self.block(node.body)
            self.block(node.orelse)
        elif isinstance(node, (ast.With, ast.AsyncWith)):
            for item in node.items:
                self.expr(item.context_expr)
                if item.optional_vars is not None:
                    self.target(item.optional_vars)
            self.block(node.body)
        elif isinstance(node, (ast.Import, ast.ImportFrom)):
            for alias in node.names:
                if alias.name != '*':
                    self.bind(alias.asname or alias.name.split('.')[0])
        elif isinstance(node, ast.Delete):
            for item in node.targets:
                self.target(item)
        elif isinstance(node, (ast.Global, ast.Nonlocal)):
            pass
        else:
            # If, While, Try, Match, Expr, Assert, Raise: their fields in
            # the order Python evaluates them.
            for field, value in ast.iter_fields(node):
                if field == 'handlers':
                    for handler in value:
                        if handler.type is not None:
                            self.expr(handler.type)
                        if handler.name:
                            self.bind(handler.name)
                        self.block(handler.body)
                elif field == 'cases':
                    for case in value:
                        self.pattern(case.pattern)
                        if case.guard is not None:
                            self.expr(case.guard)
                        self.block(case.body)
                elif isinstance(value, list):
                    for item in value:
                        if isinstance(item, ast.stmt):
                            self.statement(item)
                        elif isinstance(item, ast.AST):
                            self.expr(item)
                elif isinstance(value, ast.AST):
                    self.expr(value)

    def expr(self, node):
        if isinstance(node, ast.Name):
            if isinstance(node.ctx, ast.Load):
                self.read(node.id)
            else:
                self.bind(node.id)
        elif isinstance(node, ast.Lambda):
            # The defaults now; the body when it is called.
            self.arguments(node.args)
        elif isinstance(node, (ast.ListComp, ast.SetComp, ast.GeneratorExp, ast.DictComp)):
            # The first iterable is the enclosing scope's; the rest is the
            # comprehension's own, its loop names included.
            for index, item in enumerate(node.generators):
                self.expr(item.iter)
                if index == 0:
                    self.inner.append(set())
                self.target(item.target)
                for condition in item.ifs:
                    self.expr(condition)
            if isinstance(node, ast.DictComp):
                self.expr(node.key)
                self.expr(node.value)
            else:
                self.expr(node.elt)
            self.inner.pop()
        elif isinstance(node, ast.NamedExpr):
            self.expr(node.value)
            # A walrus binds past the comprehension, in the enclosing scope (PEP 572).
            self.bound.add(node.target.id)
        else:
            for child in ast.iter_child_nodes(node):
                if isinstance(child, ast.keyword):
                    self.expr(child.value)
                elif isinstance(child, ast.AST):
                    self.expr(child)

    def target(self, node):
        if isinstance(node, ast.Name):
            self.bind(node.id)
        elif isinstance(node, (ast.Tuple, ast.List)):
            for item in node.elts:
                self.target(item)
        elif isinstance(node, ast.Starred):
            self.target(node.value)
        else:
            # \`conn.x = 1\` and \`d[k] = v\` read \`conn\`, \`d\` and \`k\`.
            self.expr(node)

    def arguments(self, args):
        for item in list(args.defaults) + [value for value in args.kw_defaults if value is not None]:
            self.expr(item)
        named = list(getattr(args, 'posonlyargs', [])) + list(args.args) + list(args.kwonlyargs)
        for arg in named + [arg for arg in (args.vararg, args.kwarg) if arg is not None]:
            if arg.annotation is not None:
                self.expr(arg.annotation)

    def pattern(self, node):
        for field in ('name', 'rest'):
            value = getattr(node, field, None)
            if isinstance(value, str):
                self.bind(value)
        for child in ast.iter_child_nodes(node):
            if isinstance(child, ast.expr):
                self.expr(child)
            elif isinstance(child, ast.AST):
                self.pattern(child)


def _deferred(table, out):
    """The globals every function, lambda and class body of an attempt reads, however deep."""
    for child in table.get_children():
        for symbol in child.get_symbols():
            if symbol.is_global() and symbol.is_referenced():
                out.add(symbol.get_name())
        _deferred(child, out)


def _colloq_needs(source, left):
    """The names an attempt reads that its epoch left behind (§9.4), sorted.

    It runs inside the entry's own execute, so it costs no round trip, and
    only in a worker whose epoch left something behind. Two passes: \`ast\`
    walks the top level in the order Python runs it (a name read before the
    attempt binds it is the epoch's), and \`symtable\` finds the globals that
    function bodies read, which count unless the top level binds them
    somewhere. What neither can see (\`globals()['conn']\`, \`eval\`, a shell
    line's argument) the sentinel refuses when it runs.
    """
    if not left:
        return []
    try:
        text = _python_of(source)
        # IPython runs a top-level \`await\` (autoawait); plain parsing would refuse it.
        tree = compile(text, '<attempt>', 'exec',
                       ast.PyCF_ONLY_AST | getattr(ast, 'PyCF_ALLOW_TOP_LEVEL_AWAIT', 0), True)
    except Exception:
        # It does not parse: it fails the same way anywhere, and in a
        # worker it does so without holding up the shared kernel.
        return []
    walker = _Reads(left)
    try:
        walker.block(tree.body)
    except Exception:
        pass
    needs = set(walker.needs)
    later = set()
    try:
        import symtable
        _deferred(symtable.symtable(text, '<attempt>', 'exec'), later)
    except Exception:
        later = set()
    for name in later:
        if name in left and name not in walker.bound:
            needs.add(name)
    return sorted(needs)


def leave(ns):
    """Return the namespace to what it was before the attempt.

    Each failure is swallowed separately: restoring the cwd must not be undone
    by someone deleting a name from ns right now, nor rcParams by a directory
    having disappeared. Half a return is better than none.
    """
    global state, leftovers
    current = state
    if not current:
        return
    # The memory ceiling is removed FIRST: no part of the return may run under
    # it, or someone else's np.set_printoptions would be undone for lack of
    # addresses.
    _disarm_memory(current.get('memory'))
    # The guard is released by exactly one count: under the "Blocked" rule it
    # stays on after the attempt too, under "Allowed" it is removed here.
    _release(current)
    saved = current.get('saved')
    if saved is not None:
        for key in saved:
            try:
                if key not in ns or ns[key] is not saved[key]:
                    ns[key] = saved[key]
            except Exception:
                pass
        for key in [k for k in _list(ns) if k not in saved]:
            try:
                del ns[key]
            except Exception:
                pass
    cwd = current.get('cwd')
    if cwd:
        try:
            os.chdir(cwd)
        except Exception:
            pass
    rc = current.get('rc')
    if rc:
        try:
            mpl = sys.modules.get('matplotlib')
            if mpl is not None:
                mpl.rcParams.update(rc)
        except Exception:
            pass
    try:
        left = _restore(current.get('process'))
    except Exception:
        left = {'threads': 0, 'processes': 0}
    state = None
    out = {'threads': left['threads'], 'processes': left['processes']}
    scratch = current.get('scratch')
    if scratch:
        # What the attempt wrote, for its card; the folder itself stays for
        # the agent, which brings what home asks for and then removes it.
        try:
            out['files'], out['more'] = _artifacts(scratch)
        except Exception:
            pass
    if epoch is not None:
        # A worker restarts and reseeds when attempts left it holding more
        # than one attempt's memory of its own (§9.3 detail 4, §9.5): the
        # pages it wrote into, what it imported, what it leaked. Measured
        # against the seed, since the epoch's own objects are its baseline.
        dirty = _dirty()
        base = epoch.get('dirty')
        grown = None if dirty is None or base is None else max(dirty - base, 0)
        cap = current.get('cap')
        out['dirty'] = dirty
        out['grown'] = grown
        out['recycle'] = bool(left['threads'] or left['processes']
                              or (cap and grown is not None and grown > cap))
    # The exit report is optional: the server reads it if it arrived, and
    # silence here is no trouble for the attempt, unlike silence at the entry.
    try:
        leftovers = _Report(json.dumps(out, separators=(',', ':')))
    except Exception:
        leftovers = None


def enter(ns, budget, settings=None):
    """Replace the bindings with personal copies and report to the server.

    The report is set ALWAYS, including on our own error: the server reads it
    as the only confirmation and must treat silence as a refusal; an attempt
    must not run on shared objects after any failure whatsoever.

    \`settings\` comes from the server rather than being baked in here: it
    holds the texts in the room's language and the memory ceiling switch. The
    language gets changed in the panel in the middle of class, and building the
    source with it inside would mean keeping yesterday's in the kernel.
    """
    global state, report, leftovers
    started = time.time()
    report = None
    leftovers = None
    settings = settings or {}
    try:
        current = epoch
        source = settings.get('source')
        cap = settings.get('cap')
        if current is not None:
            if current.get('broken'):
                # Its seed did not come through, and its names are half
                # gone: an attempt here would compute on nothing.
                raise RuntimeError('the worker holds no epoch')
            if not isinstance(source, str) or not settings.get('runId') or not cap:
                # A seeded worker's rules are not optional (§9.3 detail 5,
                # §9.4, §9.7): without its ceiling, its scratch folder or
                # the check of the names its epoch left behind, no entry.
                raise RuntimeError("a worker's entry without its source, run id or cap")
        if current is not None and current.get('left'):
            # A worker refuses an attempt that reads a name its epoch left
            # behind (§9.4), and does so before anything is held or copied:
            # the attempt goes to the notebook's queue, keeping its place,
            # and the worker stays exactly as it was.
            needs = _colloq_needs(source, current['left'])
            if needs:
                report = _Report(json.dumps({
                    'ok': False,
                    'copied': 0,
                    'skipped': [],
                    'failed': [],
                    'bytes': 0,
                    'memory': None,
                    'needs': [{'name': name[:200], 'why': current['left'][name]} for name in needs],
                    'error': ('NotCarried: ' + ', '.join(needs))[:200],
                    'ms': int((time.time() - started) * 1000),
                }, separators=(',', ':')))
                return
        if state:
            # The previous exit did not get through (the kernel died, the
            # server restarted): it goes first, otherwise this entry's saved
            # would remember someone else's copies as originals, and the real
            # data would be lost for good.
            leave(ns)
        if current is not None:
            _reseed(current)
        saved = dict(ns)
        rc = None
        mpl = sys.modules.get('matplotlib')
        if mpl is not None:
            try:
                # The backend is not restored: it is lazy, and update() on it
                # would mean switching the backend for no reason.
                rc = dict((k, v) for k, v in mpl.rcParams.items() if k != 'backend')
            except Exception:
                rc = None
        try:
            cwd = os.getcwd()
        except Exception:
            cwd = None
        # The state is set BEFORE copying: an interrupt by the limit in the
        # middle of the entry must not leave the attempt with half a swap and
        # no way back.
        state = {'saved': saved, 'cwd': cwd, 'rc': rc, 'process': _snapshot(),
                 'guard': _hold(settings.get('guard')),
                 'memory': None, 'scratch': None, 'cap': None}
        if not state['guard']:
            # Without the guard the attempt does not run at all: a student on
            # the SHARED kernel must not be able to bring the class down under
            # any room rule, and "it seems to have gone in" is no answer here.
            raise RuntimeError('guard unavailable')

        copies = {}
        skipped = []
        failed = []
        if cap:
            # «Память на попытку» holds the attempt's copies too (§9.5): at
            # most half of it goes to them, and the ceiling below is what
            # they leave, so copies and attempt together stay within it.
            budget = min(budget, int(cap) // 2)
        # One memo for the whole entry: it both stores the decisions by object
        # id and serves as deepcopy's memory. Two names for one object get ONE
        # copy, and a is b stays true inside the attempt; an object left shared
        # is recorded as itself and so is not copied inside someone else's
        # copy.
        memo = {}
        used = 0
        for key in list(saved):
            obj = saved[key]
            if _service(key) or isinstance(obj, _NOCOPY):
                continue
            seen = memo.get(id(obj), _MISS)
            if seen is not _MISS:
                if seen is not obj:
                    copies[key] = seen
                continue
            try:
                plan = _plan(obj, memo)
            except Exception as err:
                failed.append({'name': key[:80], 'error': _short(err)})
                memo[id(obj)] = obj
                continue
            if plan is None:
                memo[id(obj)] = obj
                continue
            kind, size = plan
            if kind == 'mapped':
                try:
                    made = _remap(obj)
                    memo[id(obj)] = made
                    copies[key] = made
                    continue
                except Exception:
                    # No fresh mapping: a plain copy, as in the shared
                    # kernel, and one that counts.
                    kind, size = 'ndarray', int(obj.nbytes)
            if size is None or used + size > budget:
                skipped.append({
                    'name': key[:80],
                    'bytes': ${SIZE_UNKNOWN} if size is None else int(size),
                })
                memo[id(obj)] = obj
                continue
            try:
                made = _make(kind, obj, memo)
            except Exception as err:
                # One failed copy is not a refusal of the entry: the object
                # stays shared and is named in the report, and the attempt gets
                # the rest as its own.
                failed.append({'name': key[:80], 'error': _short(err)})
                memo[id(obj)] = obj
                continue
            used += int(size)
            memo[id(obj)] = made
            copies[key] = made

        # The swap happens in one pass and only now, when ALL copies are
        # ready: the attempt must not see half of its data personal and half
        # shared.
        for key in copies:
            ns[key] = copies[key]

        folder = None
        if settings.get('runId'):
            # A worker's attempt writes into a folder of its own (§9.7, D10).
            # Without it the attempt does not run: its files would land in
            # the read-only class mount, or somewhere nobody collects.
            state['scratch'] = _scratch(settings, current)
            folder = state['scratch']['folder']

        given = None
        if cap:
            # A worker's ceiling is mandatory (§9.3 detail 5): N workers in
            # one container, and one greedy attempt must meet a MemoryError,
            # never the cgroup's OOM killer. Where it cannot be set on
            # Linux, the attempt does not run. It is what the copies left
            # of the cap: they are in the address space it starts from.
            state['cap'] = int(cap)
            armed = _arm_memory(int(settings.get('floor') or 0),
                                int(settings.get('headroom') or 0), max(int(cap) - used, 1))
            if armed:
                state['memory'] = armed
                given = armed['room']
            elif _linux():
                raise RuntimeError('memory ceiling unavailable')
        elif settings.get('memory'):
            # The ceiling is set AFTER the copies and from a fresh measurement:
            # otherwise a greedy attempt (np.ones((40000, 40000)), a cartesian
            # join) calls the OOM killer, and that kills the notebook's kernel,
            # together with the teacher's analysis and the work of everyone who
            # has already submitted. Under the ceiling the same thing ends in a
            # MemoryError in a single attempt.
            armed = _arm_memory(int(settings.get('floor') or 0),
                                int(settings.get('headroom') or 0))
            if armed:
                state['memory'] = armed
                given = armed['room']

        report = _Report(json.dumps({
            'ok': True,
            'copied': len(copies),
            'skipped': skipped,
            'failed': failed,
            'bytes': used,
            'memory': given,
            'scratch': folder,
            'ms': int((time.time() - started) * 1000),
        }, separators=(',', ':')))
    except Exception as err:
        report = _Report(json.dumps({
            'ok': False,
            'copied': 0,
            'skipped': [],
            'failed': [],
            'bytes': 0,
            'memory': None,
            'error': _short(err),
            'ms': int((time.time() - started) * 1000),
        }, separators=(',', ':')))


globals().setdefault('state', None)
globals().setdefault('report', None)
globals().setdefault('leftovers', None)
# A worker's seed (load, EPOCH_IMPL): None in every other kernel.
globals().setdefault('epoch', None)
# As the last line, and this matters: by it the entry knows the install got to
# the END. An exec interrupted halfway would leave the module without version,
# and the next attempt would reinstall it whole rather than rely on half.
version = '__VERSION__'
`

/**
 * The epoch half of the hidden module (remote-classes.md §9.3): `export` in
 * the notebook's kernel, `load` in a pool worker.
 *
 * Installed into the same module as IMPL, and only by the export's and the
 * load's own cells, with a version of its own: an attempt's entry, which
 * travels to the kernel with every attempt, does not carry it. It leans on
 * IMPL's helpers (`_snapshot`, `_restore`, `_service`, `_NotCarried`, the
 * module getters), and the cells install IMPL first.
 *
 * The format, in one paragraph. An epoch is a manifest plus files, each
 * named by the sha256 of its bytes and nothing else, so that the folder the
 * export writes, home's store, the agent's store and the worker's read-only
 * mount can all be the same content-addressed set: the manifest (JSON: the
 * stream's hash, the buffers' hashes in the order the stream takes them,
 * modules by name, the names left behind with their reasons, the modules
 * each carried name's classes and functions are found in, the process
 * state that imports depend on: sys.path, the folder, the environment), the
 * stream (one pickle, protocol 5, of every carried name and the rest of the
 * process state, with ONE memo: a model and its optimizer stay one graph)
 * and one file per out-of-band buffer of 64 KiB or more: numeric arrays and
 * their views, memmaps and torch's CPU storages among them.
 */
const EPOCH_IMPL = `
import gc
import hashlib
import importlib
import importlib.util
import io
import marshal
import pickle
import zlib


class _Left(Exception):
    """A name the epoch cannot carry, and why: a code the server puts in words (§9.4)."""

    def __init__(self, why):
        Exception.__init__(self, why)
        self.why = why


# The manifest's line for one buffer (\`{"bytes":…,"sha256":"…"}\`): counted
# against the budget with the buffer itself, because the epoch's files
# together stay within it, the manifest included (§9.2).
_BUFFER_ROW = 96

# The manifest's own keys and the stream's line, counted the same way.
_MANIFEST_SLACK = 1024


class _Counter(object):
    """A file that only counts, for a trial: what a name would cost, without writing it.

    Its buffers are priced as they come: one that a name carried before
    holds already is free (the stream has one memo, the folder one file per
    content), the others cost their bytes and their line in the manifest.
    """
    __slots__ = ('n', 'cap', 'threshold', 'counted', 'keys', 'big')

    def __init__(self, cap, threshold=None, counted=None):
        self.n = 0
        self.cap = cap
        self.threshold = threshold
        self.counted = counted if counted is not None else {}
        # The buffers this trial priced, by (place, size): the export adds
        # them to \`counted\` once the name is carried. Each is held, so
        # that its memory cannot become another buffer at the same place.
        self.keys = {}
        self.big = []

    def write(self, data):
        size = len(data) if type(data) is bytes else memoryview(data).nbytes
        self.charge(size)
        return size

    def charge(self, size):
        self.n += size
        if self.n > self.cap:
            raise _Left('budget')

    def room(self):
        return self.cap - self.n

    def price(self, size):
        """A buffer the trial does not make, being a copy only the export's own dump makes: its cost, in band or out."""
        if self.threshold is None or size < self.threshold:
            self.charge(size)
            return
        self.charge(size + _BUFFER_ROW)
        self.big.append(size)

    def callback(self, buf):
        """The pickler's buffer_callback: False keeps a buffer out of band."""
        try:
            with buf.raw() as view:
                size = view.nbytes
                where = _address(view)
        except Exception:
            return True
        if self.threshold is None or size < self.threshold:
            return True
        key = (where, size) if where is not None else None
        if key is not None and (key in self.counted or key in self.keys):
            self.charge(_BUFFER_ROW)
            return False
        self.charge(size + _BUFFER_ROW)
        self.big.append(size)
        if key is not None:
            self.keys[key] = buf
        return False


class _Sink(object):
    """The stream's file, hashed as it is written: its name is known the moment it ends."""
    __slots__ = ('handle', 'digest', 'n')

    def __init__(self, handle):
        self.handle = handle
        self.digest = hashlib.sha256()
        self.n = 0

    def write(self, data):
        self.digest.update(data)
        self.handle.write(data)
        size = len(data) if type(data) is bytes else memoryview(data).nbytes
        self.n += size
        return size


def _cloudpickle():
    """cloudpickle, or joblib's copy of it before joblib 1.6 (§9.3 detail 1).

    scikit-learn brings joblib, so the kernel's image always has one or the
    other. With it, classes declared in the notebook travel by value; without
    it they, and their instances, stay behind.
    """
    try:
        import cloudpickle
        return cloudpickle
    except Exception:
        pass
    try:
        from joblib.externals import cloudpickle
        return cloudpickle
    except Exception:
        return None


# The pickler class, made once per install: it subclasses whichever pickler
# this kernel has, and a new install (a new server build) makes it again.
_pickler_class = None


def _pickler():
    global _pickler_class
    if _pickler_class is not None:
        return _pickler_class
    found = _cloudpickle()
    base = found.Pickler if found is not None else pickle.Pickler
    parent = getattr(base, 'reducer_override', None)

    class _EpochPickler(base):
        def __init__(self, file, ns, callback, trial=None, counted=None):
            base.__init__(self, file, protocol=5, buffer_callback=callback)
            self.colloq_ns = ns
            # A trial prices the copies only the export's own dump makes (_array).
            self.colloq_trial = trial
            # The buffers carried names hold, by (place, size).
            self.colloq_counted = trial.counted if trial is not None else (counted or {})
            # The modules this pickle names its classes and functions by (_uses).
            self.colloq_uses = set()
            # Flat byte views of the buffers under arrays (_owner), one per buffer.
            self.colloq_owners = {}

        def reducer_override(self, obj):
            return _reduce(self, obj, parent)

    _pickler_class = _EpochPickler
    return _pickler_class


def _reduce(pickler, obj, parent):
    """Every object the stream meets, before pickle decides how to write it.

    Decided here, and the rest is cloudpickle's (or plain pickle's) own
    business:
      · a function declared in the notebook travels as its code, and comes
        back built on the WORKER's namespace (_rebound): one stream, so its
        globals are the worker's own \`df\`, after \`df = df.dropna()\` too;
      · the process's own random generators, behind \`random.randint\` or
        \`np.random.rand\` bound by name, travel by name (_singleton): a
        worker then draws from its own, which every attempt starts from the
        epoch's state;
      · numeric arrays and torch's CPU storages travel out of band, by their
        content, where their own pickling would copy them in band (_array,
        _storage), and an in-band copy that cannot fit is refused before it
        is made (_afford);
      · data on a GPU stops the name (D11);
      · what would be written as a bare name in \`__main__\` stops the name
        too: a worker unpickles before it binds anything, so such a name
        would not be found there, and one name would fail the whole seed;
      · the modules classes and functions are found in are noted (_uses): a
        worker that cannot import one leaves behind only the names that
        need it.
    """
    kind = type(obj)
    if kind is types.FunctionType:
        if obj in _BY_NAME:
            return NotImplemented
        if obj.__globals__ is pickler.colloq_ns:
            return _function_reduce(obj)
        _uses(pickler, obj)
    elif kind is _NotCarried:
        raise _Left(object.__getattribute__(obj, '_colloq_why'))
    elif isinstance(obj, type):
        if parent is None and _module_of(obj) == '__main__':
            raise _Left('unpicklable')
        _uses(pickler, obj)
    else:
        if kind is types.MethodType or kind is types.BuiltinMethodType:
            which = _singleton_of(getattr(obj, '__self__', None))
            if which is not None and isinstance(getattr(obj, '__name__', None), str):
                return (_singleton, (which, obj.__name__))
            if kind is types.BuiltinMethodType:
                _uses(pickler, obj)
        else:
            which = _singleton_of(obj)
            if which is not None:
                return (_singleton, (which, None))
        if isinstance(obj, _FILES):
            # cloudpickle would carry a file open for reading as a copy of
            # its contents; a worker's \`fh\` would then be another object
            # that reads, and never writes, the same bytes. It stays behind,
            # as §9.4 has it.
            raise _Left('file')
        np = _numpy()
        if np is not None and isinstance(obj, np.ndarray):
            reduced = _array(pickler, obj, np)
            if reduced is not None:
                return reduced
        torch = _torch()
        if torch is not None:
            try:
                gpu = isinstance(obj, torch.Tensor) and obj.device.type != 'cpu'
            except Exception:
                gpu = False
            if gpu:
                raise _Left('cuda')
            reduced = _storage(pickler, obj, torch)
            if reduced is not None:
                return reduced
        home = _module_of(kind)
        if home.startswith('cupy'):
            raise _Left('cuda')
        if home != '__main__' and callable(obj) and _module_of(obj) == '__main__':
            try:
                named = isinstance(obj.__reduce_ex__(5), str)
            except Exception:
                named = False
            if named:
                raise _Left('unpicklable')
    if parent is None:
        return NotImplemented
    return parent(pickler, obj)


# Files of the operating system, unlike StringIO and BytesIO, which are data.
_FILES = (io.FileIO, io.BufferedReader, io.BufferedWriter, io.BufferedRandom,
          io.BufferedRWPair, io.TextIOWrapper)

# Modules every worker has: never worth a line in the manifest.
_ALWAYS = frozenset(('builtins', 'copyreg', '_codecs', '__main__', '${COUNCIL_MODULE}'))


def _module_of(obj):
    """An object's \`__module__\` when it is a name; '' otherwise (a type may keep a descriptor there)."""
    try:
        name = getattr(obj, '__module__', None)
    except Exception:
        return ''
    return name if isinstance(name, str) else ''


def _uses(pickler, obj):
    """Note the module a class or a function will be looked up in when the stream loads."""
    module = _module_of(obj)
    if module and module not in _ALWAYS:
        pickler.colloq_uses.add(module)


def _singleton_of(obj):
    """'random' or 'numpy' for the generator behind \`random.randint\` or \`np.random.rand\`; None for anything else.

    \`from random import randint\` binds a method of the process's own
    generator. Pickled by value, every worker would hold a copy of it under
    that name that no attempt's start resets: identical attempts would draw
    different numbers from the second on, and \`seed(42)\` would seed the
    copy.
    """
    if obj is None:
        return None
    rnd = sys.modules.get('random')
    if rnd is not None and obj is getattr(rnd, '_inst', None):
        return 'random'
    mtrand = sys.modules.get('numpy.random.mtrand')
    if mtrand is not None and obj is getattr(mtrand, '_rand', None):
        return 'numpy'
    return None


def _singleton(which, name):
    """The worker's own generator, or its method of that name."""
    if which == 'random':
        owner = importlib.import_module('random')._inst
    else:
        owner = importlib.import_module('numpy.random.mtrand')._rand
    return owner if name is None else getattr(owner, name)


# The headroom an export leaves the kernel (its settings' \`headroom\`).
_spare = ${COUNCIL_MEMORY_HEADROOM_BYTES}


def _fits(size):
    """Whether a copy of \`size\` bytes fits in what the container has left, headroom kept; True where that cannot be told."""
    if not _linux():
        return True
    limit = _cgroup('memory.max', 'memory/memory.limit_in_bytes')
    used = _cgroup('memory.current', 'memory/memory.usage_in_bytes')
    if limit is None or used is None:
        return True
    return size <= limit - max(used - _reclaimable(), 0) - _spare


def _afford(pickler, size):
    """A copy about to be made in band: refused before it is made when it cannot fit.

    In a trial the name stays behind, \`budget\`, past its room or the
    container's; in the export's own dump the export fails instead of
    meeting the OOM killer, which nothing else would stop in a GPU room
    (no address-space ceiling there).
    """
    trial = pickler.colloq_trial
    if trial is not None:
        if size > trial.room() or not _fits(size):
            raise _Left('budget')
    elif not _fits(size):
        raise MemoryError('the epoch does not fit in the memory the kernel has left')


def _array(pickler, obj, np):
    """How an array travels (§9.3–9.4): by its content, out of band, wherever its bytes allow; None leaves it to numpy.

    numpy's own protocol 5 hands a plain contiguous array out of band and
    writes anything else in band, as a copy: a view (\`X = data[:, :-1]\`,
    \`train = df.iloc[:n]\` on a frame of one block), a memmap
    (\`np.load(..., mmap_mode='r')\`). A copy made at every export,
    re-shipped whenever the stream changes, and private in every worker.
    Here such an array travels as the view it is, of the memory it lives
    in: its owner, which the stream then carries once, out of band and
    shared through the memo with every other name over it (a view of the
    mapping in a worker too); or, when the owner is more than twice its
    size and carried by nothing else, a contiguous copy of its own, out of
    band all the same. Subclasses with a pickling of their own (a matrix, a
    masked array) and object arrays keep it, in band, once their copy is
    known to fit.
    """
    kind = type(obj)
    try:
        size = int(obj.nbytes)
        boxed = bool(obj.dtype.hasobject)
    except Exception:
        return None
    if (kind is not np.ndarray and kind is not np.memmap) or boxed:
        _afford(pickler, size)
        return None
    contiguous = kind is np.ndarray and (obj.flags.c_contiguous or obj.flags.f_contiguous)
    if size == 0 or (contiguous and not isinstance(obj.base, np.ndarray)):
        # It owns its memory, or lies right over a buffer that is no array
        # (bytes, a mapping, the flat view _owner makes): numpy's own.
        return None
    writeable = bool(obj.flags.writeable)
    found = _owner(pickler, obj, np)
    if found is not None:
        base, start, extent = found
        offset = int(obj.__array_interface__['data'][0]) - start
        if _within(obj, offset, extent):
            if (start, extent) in pickler.colloq_counted:
                # Its memory travels anyway, with a name carried already:
                # the view costs nothing more, \`train = X[:n]\` included.
                return (_view_of, (base, offset, obj.shape, obj.strides, obj.dtype, writeable))
            if not contiguous and size * 2 >= extent:
                return (_view_of, (base, offset, obj.shape, obj.strides, obj.dtype, writeable))
    if contiguous:
        # numpy's own: out of band, its own bytes, and no copy made.
        return None
    _afford(pickler, size)
    trial = pickler.colloq_trial
    if trial is not None:
        # A trial only prices the copy: the export's own dump makes it.
        trial.price(size)
        return (_view_of, (None, 0, (), (), obj.dtype, writeable))
    made = np.array(obj, dtype=obj.dtype, order='C', copy=True, subok=False)
    return (_view_of, (made, 0, made.shape, made.strides, made.dtype, writeable))


def _owner(pickler, obj, np):
    """The memory under an array: (an array over all of it, its first byte's address, its size), or None.

    The array that owns it, or, under a memmap, bytes or a mapping, a flat
    byte view of that buffer, made once per pickle, so that the memo makes
    every view over it one buffer.
    """
    cur = obj
    for _ in range(64):
        nxt = cur.base
        if nxt is None:
            break
        if not isinstance(nxt, np.ndarray):
            known = pickler.colloq_owners.get(id(nxt))
            if known is None or known[0] is not nxt:
                try:
                    flat = np.frombuffer(nxt, dtype=np.uint8)
                except Exception:
                    return None
                known = (nxt, flat)
                pickler.colloq_owners[id(nxt)] = known
            flat = known[1]
            return flat, int(flat.__array_interface__['data'][0]), int(flat.nbytes)
        cur = nxt
    else:
        return None
    if cur is obj or type(cur) is not np.ndarray or cur.dtype.hasobject:
        return None
    if not (cur.flags.c_contiguous or cur.flags.f_contiguous):
        return None
    return cur, int(cur.__array_interface__['data'][0]), int(cur.nbytes)


def _within(obj, offset, extent):
    """Whether every byte of the view lies within the memory under it."""
    low = high = offset
    for count, step in zip(obj.shape, obj.strides):
        if step >= 0:
            high += (count - 1) * step
        else:
            low += (count - 1) * step
    return low >= 0 and high + obj.dtype.itemsize <= extent


def _view_of(base, offset, shape, strides, dtype, writeable):
    """An array rebuilt as the view it was: of its owner's memory, or of the copy that travelled for it."""
    import numpy as np
    flat = base.reshape(-1, order='A').view(np.uint8)
    made = np.ndarray(shape, dtype=dtype, buffer=flat, offset=offset, strides=strides)
    if not writeable:
        made.flags.writeable = False
    return made


def _storage(pickler, obj, torch):
    """torch's CPU storages out of band, as numpy's blocks are (§9.4); None for anything else.

    torch pickles a storage through torch.save into bytes, in band: two
    copies at every export, a stream re-shipped whenever a weight moves,
    and a private copy in every worker. Here its bytes travel as a buffer by
    their content, mapped in a worker; a typed storage travels as its
    untyped one, so tensors that share a storage share it in a worker too.
    """
    module = getattr(torch, 'storage', None)
    typed = getattr(module, 'TypedStorage', None) if module is not None else None
    untyped = getattr(torch, 'UntypedStorage', None)
    if typed is not None and isinstance(obj, typed):
        try:
            return (_typed_storage, (obj._untyped_storage, obj.dtype))
        except Exception:
            return None
    if untyped is None or not isinstance(obj, untyped):
        return None
    try:
        where = obj.device.type
        size = int(obj.nbytes())
    except Exception:
        return None
    if where == 'cuda':
        raise _Left('cuda')
    if where != 'cpu':
        return None
    if size == 0:
        return (_untyped_storage, (None,))
    try:
        flat = torch.empty(0, dtype=torch.uint8).set_(obj).numpy()
    except Exception:
        # Without numpy, torch's own pickling, in band, once it is known to fit.
        _afford(pickler, size)
        return None
    return (_untyped_storage, (pickle.PickleBuffer(flat),))


def _untyped_storage(buffer):
    """A CPU storage over the bytes it travelled as: the worker's mapping, never a copy of it."""
    import torch
    if buffer is None or memoryview(buffer).nbytes == 0:
        return torch.UntypedStorage(0)
    if memoryview(buffer).readonly:
        buffer = bytearray(buffer)
    return torch.frombuffer(buffer, dtype=torch.uint8).untyped_storage()


def _typed_storage(inner, dtype):
    import torch
    return torch.storage.TypedStorage(wrap_storage=inner, dtype=dtype, _internal=True)


def _function_reduce(fn):
    code = fn.__code__
    cells = ()
    if fn.__closure__:
        kept = []
        for index, cell in enumerate(fn.__closure__):
            try:
                kept.append((index, cell.cell_contents))
            except ValueError:
                pass
        cells = tuple(kept)
    # Python 3.14 evaluates annotations lazily, through a function of their
    # own: that one travels, and is rebuilt here as well. Before 3.14 the
    # annotations are a plain dict.
    annotate = getattr(fn, '__annotate__', None)
    notes = None
    if annotate is None:
        try:
            notes = dict(fn.__annotations__) or None
        except Exception:
            notes = None
    state = (fn.__qualname__, fn.__defaults__, fn.__kwdefaults__, fn.__module__,
             fn.__doc__, dict(fn.__dict__) or None, cells, notes, annotate)
    return (_rebound, (marshal.dumps(code), len(code.co_freevars), fn.__name__),
            state, None, None, _rebound_state)


# The namespace a seed is loading into: notebook functions are rebuilt on it.
_target = None


def _rebound(code, cells, name):
    """A notebook function, rebuilt on the worker's own namespace (§9.3 detail 2, \`_rebind\`).

    \`types.FunctionType(code, ns, ...)\` while the stream loads, so every
    function and method from the notebook, wherever it sits (a name, a
    class, a list, a default, a closure), reads the worker's names when it
    runs, exactly as it reads the shared kernel's there. Marshal is safe
    here: a worker runs the main kernel's own image, and \`load\` refuses an
    epoch from another Python.
    """
    target = _target
    if target is None:
        target = {'__builtins__': builtins}
    closure = None
    if cells:
        closure = tuple(types.CellType() for _ in range(cells))
    return types.FunctionType(marshal.loads(code), target, name, None, closure)


def _rebound_state(fn, state):
    qualname, defaults, kwdefaults, module, doc, fields, cells, notes, annotate = state
    fn.__qualname__ = qualname
    fn.__defaults__ = defaults
    fn.__kwdefaults__ = kwdefaults
    fn.__module__ = module
    fn.__doc__ = doc
    if fields:
        fn.__dict__.update(fields)
    for index, value in cells:
        fn.__closure__[index].cell_contents = value
    try:
        if annotate is not None:
            fn.__annotate__ = annotate
        elif notes:
            fn.__annotations__ = notes
    except Exception:
        pass
    return fn


# This module's own functions a stream names: always by name, a worker has them.
_BY_NAME = frozenset((_rebound, _rebound_state, _view_of, _untyped_storage, _typed_storage, _singleton))


def _trial(obj, ns, cap, threshold, counted):
    """What one name costs in the epoch, alone: (bytes, its new big buffers, their keys, its modules), or (why, …).

    Pickled into a counting sink, so nothing is written, and its big
    buffers only measured; those a name carried before holds cost nothing
    again (_Counter). Every name is tried alone first, to name what fails
    and why rather than lose the whole epoch to it.
    """
    sink = _Counter(cap, threshold, counted)
    pickler = _pickler()(sink, ns, sink.callback, sink)
    try:
        pickler.dump(obj)
    except _Left as left:
        return left.why, (), {}, ()
    except MemoryError:
        # The ceiling the export runs under: what does not fit stays behind.
        return 'budget', (), {}, ()
    except Exception as err:
        return _why(obj, err), (), {}, ()
    return sink.n, sink.big, sink.keys, pickler.colloq_uses


# What a failed pickle names, and the reason that is. The message names the
# object that failed, which may sit deep inside the name: a class instance
# holding a socket stays behind as a socket.
_WHYS = (
    (('generator', 'coroutine'), 'generator'),
    (('socket', 'ssl'), 'socket'),
    (('_thread.lock', 'rlock', 'semaphore', 'condition', 'lock'), 'lock'),
    (('thread',), 'thread'),
    (('sqlite', 'connection', 'cursor', 'engine'), 'connection'),
    (('_io.', 'textiowrapper', 'bufferedreader', 'bufferedwriter', 'bufferedrandom', 'fileio', 'mmap'), 'file'),
)


def _why(obj, err):
    try:
        if isinstance(obj, (types.GeneratorType, types.AsyncGeneratorType, types.CoroutineType)):
            return 'generator'
        thr = _threading()
        if thr is not None and isinstance(obj, thr.Thread):
            return 'thread'
        if isinstance(obj, io.IOBase):
            return 'file'
    except Exception:
        pass
    try:
        text = str(err)
    except Exception:
        text = ''
    start = text.find("cannot pickle '")
    if start >= 0:
        start += len("cannot pickle '")
        named = text[start:text.find("'", start)].lower()
    else:
        named = (_module_of(type(obj)) + '.' + type(obj).__name__).lower()
    for marks, why in _WHYS:
        for mark in marks:
            if mark in named:
                return why
    return 'unpicklable'


def _datalike(obj):
    """Data in \`_plan\`'s list: only the other objects have a byte cap of their own (§9.4)."""
    if isinstance(obj, (list, dict, set, frozenset, tuple, bytearray, bytes, str, int,
                        float, complex, collections.deque)):
        return True
    try:
        np = _numpy()
        if np is not None and isinstance(obj, (np.ndarray, np.generic, np.random.Generator,
                                               np.random.RandomState)):
            return True
        pd = _pandas()
        if pd is not None and isinstance(obj, (pd.DataFrame, pd.Series, pd.Index)):
            return True
        rnd = sys.modules.get('random')
        if rnd is not None and isinstance(obj, rnd.Random):
            return True
        torch = _torch()
        if torch is not None and isinstance(obj, (torch.Tensor, torch.nn.Module, torch.optim.Optimizer)):
            return True
        sparse = _sparse()
        if sparse is not None and sparse.issparse(obj):
            return True
        base = sys.modules.get('sklearn.base')
        if base is not None and isinstance(obj, base.BaseEstimator):
            return True
    except Exception:
        return False
    return _own(obj)


def _carries(value, ns):
    sink = _Counter(${COUNCIL_EPOCH_NAME_BYTES})
    try:
        _pickler()(sink, ns, None, sink).dump(value)
        return True
    except Exception:
        return False


def _view(obj):
    """Whether a value is an array over memory it does not own."""
    np = _numpy()
    try:
        return np is not None and isinstance(obj, np.ndarray) and obj.base is not None
    except Exception:
        return False


def _priced(value, ns):
    """What a value takes in the stream, priced the way a trial prices a name, and the modules it is found in."""
    sink = _Counter(1 << 62)
    pickler = _pickler()(sink, ns, None, sink)
    try:
        pickler.dump(value)
    except Exception:
        return 0, set()
    return sink.n, pickler.colloq_uses


def _row(name):
    """A left name's line in the manifest."""
    return len(json.dumps({'name': name, 'why': 'unpicklable'})) + 1


# The process state that travels in the stream: what \`_snapshot\` takes and
# a fresh worker can take on. The output streams, signal handlers, IPython's
# hooks, builtins and open figures are this process's own (§9.4's last row).
_PORTABLE = ('random', 'np_random', 'np_print', 'np_err', 'torch_rng', 'torch_grad',
             'torch_dtype', 'reclimit', 'warnfilters', 'decimal', 'pd_options', 'sklearn')


def _portable(ns):
    snap = _snapshot()
    keep = {}
    for key in _PORTABLE:
        if key in snap and _carries(snap[key], ns):
            keep[key] = snap[key]
    mpl = sys.modules.get('matplotlib')
    if mpl is not None:
        try:
            rc = dict((key, value) for key, value in mpl.rcParams.items() if key != 'backend')
        except Exception:
            rc = {}
        if rc and not _carries(rc, ns):
            rc = dict((key, value) for key, value in rc.items() if _carries(value, ns))
        if rc:
            keep['rc'] = rc
    return keep


# Variables of the container rather than of the notebook: a worker keeps its
# own. JUPYTER_TOKEN above all: an attempt must not read the class
# container's token from a worker's environment.
_ENV_OUT = frozenset(('HOSTNAME', 'HOME', 'PWD', 'OLDPWD', 'SHLVL', '_', 'PYTHONHASHSEED',
                      'OMP_NUM_THREADS', 'MKL_NUM_THREADS', 'OPENBLAS_NUM_THREADS',
                      'NUMEXPR_NUM_THREADS', 'VECLIB_MAXIMUM_THREADS'))
_ENV_OUT_PREFIX = ('JPY_', 'JUPYTER', 'KERNEL_', 'IPY', 'COLLOQ', 'NVIDIA_', 'CUDA_', 'PYDEVD')


def _environment():
    keep = {}
    for key, value in _list(os.environ.items()):
        if key in _ENV_OUT or key.startswith(_ENV_OUT_PREFIX):
            continue
        keep[key] = value
    return keep


def _inside(path, root):
    if not isinstance(path, str) or not root:
        return False
    try:
        return os.path.realpath(path).startswith(os.path.realpath(root) + os.sep)
    except Exception:
        return False


def _relative_cwd(workspace):
    """The kernel's folder inside the class folder, '' for the folder itself; None outside it."""
    if not workspace:
        return None
    try:
        here = os.path.realpath(os.getcwd())
        root = os.path.realpath(workspace)
    except Exception:
        return None
    if here == root:
        return ''
    if here.startswith(root + os.sep):
        return os.path.relpath(here, root).replace(os.sep, '/')
    return None


def _submodules(imported):
    """Loaded submodules of the packages the notebook named, imported again at seed.

    \`import sklearn.metrics\` binds \`sklearn\`, and an attempt's
    \`sklearn.metrics.f1_score\` works only because the submodule is loaded:
    a worker that imported \`sklearn\` alone would answer AttributeError.
    Private ones come with their packages anyway.
    """
    roots = set(name.split('.')[0] for name in imported.values())
    found = []
    for name in sorted(_list(sys.modules)):
        root, _, rest = name.partition('.')
        if not rest or root not in roots or sys.modules.get(name) is None:
            continue
        if any(part.startswith('_') for part in rest.split('.')):
            continue
        found.append(name)
        if len(found) >= ${COUNCIL_SUBMODULES_MAX}:
            break
    return found


def _address(view):
    """Where a buffer's bytes are, for the crc32 table; None when it cannot be told (then it is hashed again)."""
    np = _numpy()
    if np is not None:
        try:
            return int(np.frombuffer(view, dtype=np.uint8).__array_interface__['data'][0])
        except Exception:
            pass
    if view.readonly:
        return None
    try:
        import ctypes
        return ctypes.addressof(ctypes.c_char.from_buffer(view))
    except Exception:
        return None


def _put(folder, name, data):
    path = os.path.join(folder, name)
    with open(path + '.part', 'wb') as handle:
        handle.write(data)
    os.replace(path + '.part', path)


def _empty(folder):
    """What an earlier try at the same epoch left in its folder."""
    for item in _list(os.scandir(folder)):
        try:
            if not item.is_dir(follow_symlinks=False):
                os.unlink(item.path)
        except OSError:
            pass


def export(ns, out, budget, settings=None):
    """Freeze this kernel's names into an epoch in the folder \`out\` (§9.3).

    The report lands in \`exported\` for \`user_expressions\`, always, an
    error included: silence would read as a refusal anyway. The kernel's
    names are not touched.

    It runs under an address-space ceiling of its own, as an attempt's entry
    does: the notebook's kernel has no other, and a copy that does not fit
    is then a failed export, never the cgroup's OOM killer taking the
    class's state with it. Data is tried before everything else, so that a
    function or an optimizer over a table carried already costs only what
    it adds; the manifest and the process state come out of the same
    budget, so the epoch's files together never pass it.

    A buffer is hashed again only when its crc32 at the same place and size
    changed against the previous export's table, and an unchanged one keeps
    its sha256 and is not written: a refreeze of an unchanged state is a
    crc32 pass and a small stream. The table moves on only after a whole
    export, so a failed one never vouches for files nobody collected, and a
    failed one takes what it wrote away with it.
    """
    global exported, _table, _spare
    started = time.time()
    exported = None
    settings = settings or {}
    seq = settings.get('seq')
    runs = settings.get('mainRuns')
    armed = None
    wrote = False
    try:
        if state:
            # An attempt's exit never came (the server restarted mid-attempt)
            # and its copies are still bound: an epoch freezes the class's
            # data, never a student's. The exit goes first, as at the entry.
            leave(ns)
        _spare = int(settings.get('headroom') or 0)
        armed = _arm_memory(int(settings.get('floor') or 0), _spare)
        threshold = max(1, int(settings.get('threshold') or ${COUNCIL_EPOCH_BUFFER_BYTES}))
        most = settings.get('buffers')
        most = ${COUNCIL_EPOCH_BUFFERS_MAX - 1} if most is None else max(0, int(most))
        each = int(settings.get('each') or 0)
        workspace = settings.get('workspace') or None
        imported = {}
        local = []
        left = []
        data = []
        rest = []
        # \`globals()[1] = 2\` is legal Python, and sorting it with names is not.
        for name in sorted(key for key in _list(ns) if isinstance(key, str)):
            if _service(name):
                continue
            try:
                obj = ns[name]
            except KeyError:
                continue
            if isinstance(obj, types.ModuleType):
                # From the module's own namespace: a lazy module's
                # \`__getattr__\` may import, or raise, for any attribute.
                fields = getattr(obj, '__dict__', None) or {}
                known = fields.get('__name__')
                if not isinstance(known, str):
                    left.append({'name': name, 'why': 'unpicklable'})
                    continue
                imported[name] = known
                if workspace and _inside(fields.get('__file__'), workspace):
                    local.append(name)
                continue
            (data if _datalike(obj) else rest).append(name)
        # Arrays that own their memory before the views of it: an owner's
        # trial counts its bytes, and a view's then costs nothing (_array).
        data.sort(key=lambda name: (_view(ns.get(name)), name))
        process = _portable(ns)
        fixed = {
            'imported': imported,
            'submodules': _submodules(imported),
            'local': local,
            'path': _list(sys.path),
            'cwd': _relative_cwd(workspace),
            'environ': _environment(),
        }
        weight, found = _priced(process, ns)
        total = (len(json.dumps(fixed, separators=(',', ':'))) + weight
                 + _MANIFEST_SLACK + sum(_row(row['name']) for row in left))
        counted = {}
        carried = []
        sizes = []
        modules = []
        index = {}
        uses = {}
        cuda = False
        others = set(rest)
        # The process state's own modules, with the names': a warning
        # filter of a package's warning class is no name, and a worker
        # without that package still seeds.
        surround = []
        for module in sorted(found):
            index[module] = len(modules)
            modules.append(module)
            surround.append(index[module])
            total += len(json.dumps(module)) + 1 + 6
        for name in data + rest:
            try:
                obj = ns[name]
            except KeyError:
                continue
            room = budget - total
            if each and name in others:
                room = min(room, each)
            if room <= 0:
                left.append({'name': name, 'why': 'budget'})
                total += _row(name)
                continue
            size, big, keys, found = _trial(obj, ns, room, threshold, counted)
            if isinstance(size, str):
                cuda = cuda or size == 'cuda'
                left.append({'name': name, 'why': size})
                total += _row(name)
                continue
            carried.append(name)
            total += size
            sizes.extend(big)
            counted.update(keys)
            marks = []
            for module in sorted(found):
                if module not in index:
                    index[module] = len(modules)
                    modules.append(module)
                    total += len(json.dumps(module)) + 1
                marks.append(index[module])
            if marks:
                uses[name] = marks
                total += len(json.dumps({name: marks}, separators=(',', ':')))
        carried.sort()
        left.sort(key=lambda row: row['name'])
        head = None
        head_bytes = 0
        body = None
        body_bytes = 0
        files = {}
        written = []
        reused = 0
        if not cuda:
            # Past the cap on files the smaller buffers stay in the stream:
            # the threshold rises to the size of the last one that fits.
            if len(sizes) > most:
                sizes.sort(reverse=True)
                threshold = max(threshold, sizes[most - 1]) if most else (1 << 62)
            os.makedirs(out, exist_ok=True)
            wrote = True
            _empty(out)
            found = []

            def callback(buf):
                try:
                    with buf.raw() as view:
                        size = view.nbytes
                except Exception:
                    return True
                if size < threshold or len(found) >= most:
                    return True
                found.append(buf)
                return False

            part = os.path.join(out, '.stream.part')
            with open(part, 'wb') as handle:
                sink = _Sink(handle)
                payload = {'names': dict((name, ns[name]) for name in carried), 'process': process}
                _pickler()(sink, ns, callback, None, counted).dump(payload)
            body = sink.digest.hexdigest()
            body_bytes = sink.n
            os.replace(part, os.path.join(out, body))
            table = {}
            order = []
            full = bool(settings.get('full'))
            for buf in found:
                with buf.raw() as view:
                    size = view.nbytes
                    where = _address(view)
                    # crc32, not adler32: adler32's first sum is the bytes'
                    # sum, which an in-place shuffle or sort never changes.
                    check = zlib.crc32(view)
                    known = _table.get((where, size)) if where is not None else None
                    if known is not None and known[0] == check:
                        digest = known[1]
                        fresh = False
                    else:
                        digest = hashlib.sha256(view).hexdigest()
                        fresh = True
                    if where is not None:
                        table[(where, size)] = (check, digest)
                    order.append({'sha256': digest, 'bytes': size})
                    if digest in files:
                        continue
                    files[digest] = size
                    if fresh or full:
                        _put(out, digest, view)
                        written.append(digest)
                    else:
                        reused += 1
            del found[:]
            counted.clear()
            manifest = {
                'format': ${COUNCIL_EPOCH_FORMAT},
                'impl': epoch_version,
                'magic': importlib.util.MAGIC_NUMBER.hex(),
                'python': sys.version,
                'seq': seq,
                'mainRuns': runs,
                'at': time.time(),
                'stream': {'sha256': body, 'bytes': body_bytes},
                'buffers': order,
                'left': left,
                # The modules each carried name's classes and functions are
                # found in: a worker that cannot import one leaves only the
                # names that need it behind.
                'modules': modules,
                'uses': uses,
                'state': surround,
            }
            manifest.update(fixed)
            text = json.dumps(manifest, separators=(',', ':'), sort_keys=True).encode('utf-8')
            if len(text) > ${COUNCIL_EPOCH_MANIFEST_BYTES}:
                raise RuntimeError('the manifest is over its size')
            head = hashlib.sha256(text).hexdigest()
            head_bytes = len(text)
            _put(out, head, text)
            written = [head, body] + written
            _table = table
        exported = _Report(json.dumps({
            'ok': True,
            'seq': seq,
            'manifest': head,
            'manifestBytes': head_bytes,
            'body': body,
            'bodyBytes': body_bytes,
            'buffers': [{'sha256': digest, 'bytes': size} for digest, size in files.items()],
            'written': written,
            'bytes': head_bytes + body_bytes + sum(files.values()),
            'reused': reused,
            'carried': [name[:200] for name in carried],
            'left': [{'name': row['name'][:200], 'why': row['why']} for row in left],
            'imported': imported,
            'local': local,
            'cuda': cuda,
            'mainRuns': runs,
            # The kernel's seed for str hashes, as its container set it (D28): the workers have the class's.
            'hashSeed': os.environ.get('PYTHONHASHSEED'),
            'ms': int((time.time() - started) * 1000),
        }, separators=(',', ':')))
    except BaseException as err:
        # An interrupt included: the report says the export failed, and the
        # kernel goes on as it was. What it wrote goes with it: nobody
        # collects a failed export, and a full disk would fill on at every try.
        if wrote:
            try:
                _empty(out)
                os.rmdir(out)
            except OSError:
                pass
        exported = _Report(json.dumps({
            'ok': False,
            'seq': seq,
            'mainRuns': runs,
            'error': _short(err),
            'ms': int((time.time() - started) * 1000),
        }, separators=(',', ':')))
    finally:
        _disarm_memory(armed)
        _spare = ${COUNCIL_MEMORY_HEADROOM_BYTES}


def _sha(value):
    return (isinstance(value, str) and len(value) == 64
            and all(char in '0123456789abcdef' for char in value))


def _opened(path):
    """A file of the epoch, opened for reading and never through a link."""
    return os.open(path, os.O_RDONLY | getattr(os, 'O_NOFOLLOW', 0))


def _read(path):
    fd = _opened(path)
    try:
        chunks = []
        while True:
            chunk = os.read(fd, 1 << 20)
            if not chunk:
                return b''.join(chunks)
            chunks.append(chunk)
    finally:
        os.close(fd)


def _map(path, size):
    """One buffer of the epoch, mapped copy-on-write (§9.3 detail 3), and its descriptor.

    The pages are the file's, shared with every other worker through the
    page cache and charged to the container once; a write lands in a
    private page of this process only, and the file never changes. One
    mapping per place in the stream, so two equal arrays stay two arrays.
    The descriptor stays open for the attempts' own fresh mappings (_remap):
    the file itself may be let go by the agent meanwhile.
    """
    fd = _opened(path)
    try:
        if os.fstat(fd).st_size != size:
            raise RuntimeError('an epoch file of the wrong size')
        if size == 0:
            os.close(fd)
            return bytearray(), None
        return _mmap(fd), fd
    except BaseException:
        try:
            os.close(fd)
        except OSError:
            pass
        raise


def _stream(path):
    """The epoch's stream as a file, never through a link: read as it is unpickled, never whole into memory.

    Its pages are the file's, in the page cache, clean and given back on
    demand; the unpickler reads each object's bytes straight into the
    object (\`readinto\`), so not even an in-band one is held twice.
    """
    fd = _opened(path)
    try:
        if os.fstat(fd).st_size == 0:
            raise RuntimeError('an empty stream')
        return os.fdopen(fd, 'rb')
    except BaseException:
        os.close(fd)
        raise


def _hashed(handle):
    """A file's sha256 from where it stands, a megabyte at a time."""
    digest = hashlib.sha256()
    chunk = memoryview(bytearray(1 << 20))
    while True:
        size = handle.readinto(chunk)
        if not size:
            return digest.hexdigest()
        digest.update(chunk[:size])


def _fds(mappings):
    """Room for the descriptors of the mappings: a kept one per buffer, the mapping's own, and an attempt's fresh ones.

    Before Python 3.13 every mapping keeps a descriptor (_mmap), and a
    container's soft limit may be 1024 (Docker 25 and later) while its hard
    one is far above: an epoch of a few thousand buffers would fail its
    seed on EMFILE. A process may raise its soft limit up to the hard one.
    """
    try:
        import resource
        soft, hard = resource.getrlimit(resource.RLIMIT_NOFILE)
        wanted = mappings * 3 + 1024
        if soft == resource.RLIM_INFINITY or soft >= wanted:
            return
        if hard != resource.RLIM_INFINITY:
            wanted = min(wanted, hard)
        if wanted > soft:
            resource.setrlimit(resource.RLIMIT_NOFILE, (wanted, hard))
    except Exception:
        pass


def _mapping_address(view):
    try:
        import ctypes
        return ctypes.addressof(ctypes.c_char.from_buffer(view))
    except Exception:
        return None


def _apply_environment(wanted):
    if not isinstance(wanted, dict):
        return
    for key, value in wanted.items():
        if not isinstance(key, str) or not isinstance(value, str):
            continue
        if key in _ENV_OUT or key.startswith(_ENV_OUT_PREFIX):
            continue
        try:
            if os.environ.get(key) != value:
                os.environ[key] = value
        except Exception:
            pass


def _pandas_options(wanted):
    """pandas options one by one through set_option, so that the ones with a callback take effect."""
    try:
        import pandas as pd
    except Exception:
        return
    flat = {}

    def walk(prefix, node):
        for key, value in node.items():
            if isinstance(value, dict):
                walk(prefix + key + '.', value)
            else:
                flat[prefix + key] = value

    try:
        walk('', wanted)
    except Exception:
        return
    warn = sys.modules.get('warnings')
    with warn.catch_warnings():
        warn.simplefilter('ignore')
        for key, value in flat.items():
            try:
                if pd.get_option(key) != value:
                    pd.set_option(key, value)
            except Exception:
                pass


def _apply_process(keep):
    rest = dict(keep)
    wanted = rest.pop('pd_options', None)
    if wanted is not None:
        _pandas_options(wanted)
    rc = rest.pop('rc', None)
    if rc:
        try:
            import matplotlib
            matplotlib.rcParams.update(rc)
        except Exception:
            pass
    if 'sklearn' in rest and sys.modules.get('sklearn') is None:
        try:
            import sklearn
        except Exception:
            rest.pop('sklearn', None)
    _restore(rest)


def _rng_now():
    rng = {}
    rnd = sys.modules.get('random')
    if rnd is not None:
        try:
            rng['random'] = rnd.getstate()
        except Exception:
            pass
    np = _numpy()
    if np is not None:
        try:
            rng['np_random'] = np.random.get_state()
        except Exception:
            pass
    torch = _torch()
    if torch is not None:
        try:
            rng['torch_rng'] = torch.get_rng_state()
        except Exception:
            pass
    return rng


_THREAD_VARIABLES = ('OMP_NUM_THREADS', 'MKL_NUM_THREADS', 'OPENBLAS_NUM_THREADS',
                     'NUMEXPR_NUM_THREADS', 'VECLIB_MAXIMUM_THREADS')


def _threads(count):
    """About one CPU per worker (§9.7): the thread pools of what is loaded, and the variables of what loads later."""
    done = None
    try:
        import threadpoolctl
        globals()['_limits'] = threadpoolctl.threadpool_limits(limits=count)
        done = count
    except Exception:
        pass
    torch = _torch()
    if torch is not None:
        try:
            torch.set_num_threads(count)
            done = count
        except Exception:
            pass
    return done


# Where Linux takes a process's own OOM score: a worker raises its own, which
# needs no privilege.
_OOM = '/proc/self/oom_score_adj'


def _oom(value):
    try:
        with open(_OOM, 'w') as handle:
            handle.write(str(value))
        with open(_OOM) as handle:
            return int(handle.read().strip())
    except Exception:
        return None


def _words(words, name, why):
    text = words.get('text') or 'NotCarried: {name} ({why})'
    reasons = words.get('why') or {}
    return text.replace('{name}', name).replace('{why}', reasons.get(why) or reasons.get('unpicklable') or why)


class _Missing(object):
    """What a worker unpickles in place of a class or a function it cannot import.

    Anything goes with it while the stream loads (it is built, called and
    given its state), and every name whose classes or functions need that
    module is bound to a sentinel instead (load): \`!pip install catboost\`
    in the notebook's kernel, or a class renamed since in an edited local
    module, leaves those names behind, never the whole seed.
    """

    def __new__(cls, *args, **kwargs):
        return object.__new__(cls)

    def __init__(self, *args, **kwargs):
        pass

    def __call__(self, *args, **kwargs):
        return _Missing()

    def __setstate__(self, state):
        pass

    def __setitem__(self, key, value):
        pass

    def append(self, value):
        pass

    def extend(self, values):
        pass


class _Seed(pickle.Unpickler):
    """The stream's unpickler: a class or function this worker cannot import becomes _Missing, and its module is noted."""

    def __init__(self, file, buffers):
        pickle.Unpickler.__init__(self, file, buffers=buffers)
        self.colloq_missing = set()

    def find_class(self, module, name):
        try:
            return pickle.Unpickler.find_class(self, module, name)
        except (ImportError, AttributeError):
            self.colloq_missing.add(module)
            return _Missing


def _tainted(book, missing):
    """The carried names whose classes or functions need a module this worker could not import (the export's \`uses\`).

    A module counts with its package: \`extrapkg.consts\` missing leaves
    behind every name that uses anything of \`extrapkg\`. One the export
    noted for the process state alone leaves nothing behind (a warning
    filter of a missing package's class simply never matches); one it noted
    for nothing at all fails the seed, since there is no telling which names
    hold it.
    """
    if not missing:
        return set()
    modules = book.get('modules') or []

    def named(marks):
        return [modules[mark] for mark in marks if isinstance(mark, int) and 0 <= mark < len(modules)]

    uses = dict((name, named(marks)) for name, marks in (book.get('uses') or {}).items())
    state = named(book.get('state') or [])
    out = set()
    for module in missing:
        package = str(module).split('.', 1)[0]
        hit = set(name for name, found in uses.items()
                  if any(one == module or one.split('.', 1)[0] == package for one in found))
        if not hit and not any(one.split('.', 1)[0] == package for one in state):
            raise RuntimeError('this worker cannot import ' + str(module)[:80])
        out |= hit
    return out


def load(ns, manifest, body_sha, settings=None):
    """Seed this worker from an epoch (§9.3); the report lands in \`seeded\`.

    Nothing is unpickled but this epoch's own stream: the manifest is
    checked against its hash, the stream against the hash home registered,
    and both are read without following a link. The stream is read from
    its file as it is unpickled, never whole into memory; the buffers are
    mapped copy-on-write, each checked for its size, their descriptors
    kept for the attempts' fresh mappings. In this order: the OOM score,
    before the seed's own peak; thread limits for what imports
    next, the environment, sys.path and the folder the imports depend on,
    the modules by name, the stream (notebook functions rebuilt on this
    namespace), the names, sentinels for what stayed behind or needs a
    module this worker cannot import, the rest of the process state, and
    last the baseline of the worker's own memory.

    Until the seed is whole the worker holds no epoch, and its entry
    refuses: an attempt never runs on half a namespace.
    """
    global seeded, epoch, _target
    started = time.time()
    seeded = None
    settings = settings or {}
    # A previous seed's descriptors go with it (the pool restarts a worker
    # before it reseeds, so this is only ever a leftover).
    for entry in ((epoch or {}).get('backing') or {}).values():
        try:
            if entry[3] is not None:
                os.close(entry[3])
        except (OSError, IndexError, TypeError):
            pass
    epoch = {'broken': True, 'left': {}}
    stream = None
    kept = []
    try:
        folder = settings.get('dir')
        if not isinstance(folder, str) or not folder:
            raise ValueError('no folder for the epoch')
        if not _sha(manifest) or not _sha(body_sha):
            raise ValueError('a bad hash')
        # First of all: should the seed's own peak meet the cgroup's OOM
        # killer, it takes this worker, never one already serving (§9.3
        # detail 5).
        oom = _oom(int(settings.get('oom') or ${COUNCIL_OOM_SCORE_ADJ}))
        head = _read(os.path.join(folder, manifest))
        if hashlib.sha256(head).hexdigest() != manifest:
            raise RuntimeError('the manifest does not match its hash')
        book = json.loads(head.decode('utf-8'))
        del head
        if book.get('format') != ${COUNCIL_EPOCH_FORMAT}:
            raise RuntimeError('an epoch of another format')
        if book.get('magic') != importlib.util.MAGIC_NUMBER.hex():
            raise RuntimeError('an epoch from another Python: ' + str(book.get('python'))[:40])
        if (book.get('stream') or {}).get('sha256') != body_sha:
            raise RuntimeError('the stream is not the one the server registered')
        stream = _stream(os.path.join(folder, body_sha))
        if _hashed(stream) != body_sha:
            raise RuntimeError('the stream does not match its hash')
        maps = []
        backing = {}
        mapped = 0
        _fds(len(book.get('buffers') or []))
        for item in book.get('buffers') or []:
            digest = item.get('sha256')
            size = int(item.get('bytes'))
            if not _sha(digest):
                raise RuntimeError('a bad buffer hash')
            path = os.path.join(folder, digest)
            view, fd = _map(path, size)
            if fd is not None:
                kept.append(fd)
            maps.append(view)
            mapped += size
            backing[id(view)] = (path, view, _mapping_address(view), fd)
        threads = max(1, int(settings.get('threads') or 1))
        for key in _THREAD_VARIABLES:
            os.environ[key] = str(threads)
        _apply_environment(book.get('environ'))
        if isinstance(book.get('path'), list):
            sys.path[:] = [entry for entry in book['path'] if isinstance(entry, str)]
        rel = book.get('cwd')
        # The class folder: as the server says, else where this kernel
        # started, which in a council container is the class mount itself.
        workspace = settings.get('workspace')
        if not workspace:
            try:
                workspace = os.getcwd()
            except OSError:
                workspace = None
        if isinstance(rel, str) and workspace:
            place = os.path.join(workspace, rel) if rel else workspace
            try:
                os.chdir(place)
            except OSError:
                rel = None
        else:
            rel = None
        for key in [key for key in _list(ns) if not _service(key)]:
            try:
                del ns[key]
            except Exception:
                pass
        left = {}
        for row in book.get('left') or []:
            left[row['name']] = row['why']
        imported = 0
        for alias, name in sorted((book.get('imported') or {}).items()):
            try:
                ns[alias] = importlib.import_module(name)
                imported += 1
            except Exception:
                left[alias] = 'module'
        for name in book.get('submodules') or []:
            try:
                importlib.import_module(name)
            except Exception:
                pass
        keeps = ns.get('__builtins__')
        _target = ns
        try:
            stream.seek(0)
            reader = _Seed(stream, maps)
            payload = reader.load()
            missing = reader.colloq_missing
            del reader
        finally:
            _target = None
        stream.close()
        stream = None
        names = payload.get('names') or {}
        tainted = _tainted(book, missing)
        for name in tainted:
            left[name] = 'module'
        for key in names:
            if key not in tainted:
                ns[key] = names[key]
        if keeps is not None:
            ns['__builtins__'] = keeps
        words = settings.get('words') or {}
        for name, why in left.items():
            if name not in names or name in tainted:
                ns[name] = _NotCarried(name, why, _words(words, name, why))
        _apply_process(payload.get('process') or {})
        limited = _threads(threads)
        loaded = len(names) - len(tainted)
        seq = book.get('seq')
        del payload, names, book
        gc.collect()
        epoch = {
            'seq': seq,
            'manifest': manifest,
            'left': left,
            'backing': backing,
            'workspace': workspace,
            'cwd': rel,
            'rng': _rng_now(),
            # Last, with the stream let go: what the exits measure the
            # attempts' growth against (§9.5) is the epoch's, not the seed's.
            'dirty': _dirty(),
        }
        kept = []
        seeded = _Report(json.dumps({
            'ok': True,
            'seq': seq,
            'manifest': manifest,
            'loaded': loaded,
            'imported': imported,
            'left': [{'name': name[:200], 'why': why} for name, why in sorted(left.items())],
            'oomScoreAdj': oom,
            'threads': limited,
            'mapped': mapped,
            'ms': int((time.time() - started) * 1000),
        }, separators=(',', ':')))
    except BaseException as err:
        for fd in kept:
            try:
                os.close(fd)
            except OSError:
                pass
        seeded = _Report(json.dumps({
            'ok': False,
            'manifest': manifest if _sha(manifest) else None,
            'error': _short(err),
            'ms': int((time.time() - started) * 1000),
        }, separators=(',', ':')))
    finally:
        if stream is not None:
            try:
                stream.close()
            except Exception:
                pass


globals().setdefault('exported', None)
globals().setdefault('seeded', None)
# The previous export's buffers: (place, size) -> (crc32, sha256).
globals().setdefault('_table', {})
# The last line, as in IMPL: its presence says the install got to the end.
epoch_version = '__EPOCH_VERSION__'
`

/** The install version: a short hash of the source itself, computed once. */
let version: string | null = null
function implVersion(): string {
  return (version ??= createHash('sha1').update(IMPL).digest('hex').slice(0, 12))
}
/**
 * The source with the version filled in, already escaped into a Python
 * literal.
 *
 * Computed once per process: the entry is built for every attempt (it holds
 * texts in the room's language), and there is no reason to escape twenty
 * kilobytes ten times a second for a cohort of five hundred people.
 */
let literal: string | null = null
function implLiteral(): string {
  return (literal ??= JSON.stringify(IMPL.replace('__VERSION__', implVersion())))
}

/** The epoch half's own version and literal, the same way. */
let epochVersion: string | null = null
function epochImplVersion(): string {
  return (epochVersion ??= createHash('sha1').update(EPOCH_IMPL).digest('hex').slice(0, 12))
}
let epochLiteral: string | null = null
function epochImplLiteral(): string {
  return (epochLiteral ??= JSON.stringify(EPOCH_IMPL.replace('__EPOCH_VERSION__', epochImplVersion())))
}

/**
 * Install the module only when it is not there yet or is a different one.
 *
 * The source grows with every new type (twenty-odd kilobytes), and its
 * `compile` cost about half a millisecond for EVERY attempt, while between
 * attempts it never changes. The version check removes that entirely and
 * stays honest: a different server build means a different hash, and a live
 * kernel gets the new code without a restart.
 */
function implInstallLine(): string {
  const module = JSON.stringify(COUNCIL_MODULE)
  return (
    `if getattr(__import__('sys').modules.get(${module}), 'version', None) != ` +
    `${JSON.stringify(implVersion())}: ` +
    `exec(compile(${implLiteral()}, '<colloq-council>', 'exec'), ` +
    `__import__('sys').modules.setdefault(${module}, ` +
    `__import__('types').ModuleType(${module})).__dict__)`
  )
}

/** The epoch half, into the same module, after IMPL: the export's and the load's cells only. */
function epochInstallLine(): string {
  const module = JSON.stringify(COUNCIL_MODULE)
  return (
    `if getattr(__import__('sys').modules.get(${module}), 'epoch_version', None) != ` +
    `${JSON.stringify(epochImplVersion())}: ` +
    `exec(compile(${epochImplLiteral()}, '<colloq-epoch>', 'exec'), ` +
    `__import__('sys').modules[${module}].__dict__)`
  )
}

/** A positive whole number of MB in bytes; anything else is a programming error, never "no ceiling". */
function capBytes(capMb: number): number {
  if (!Number.isFinite(capMb) || capMb < 1) throw new Error(`A council worker's memory cap must be a positive number of MB, not ${capMb}`)
  return Math.floor(capMb) * 1024 * 1024
}

/**
 * The entry cell: two expressions, not a single bound name.
 *
 * `exec` into the hidden module's `__dict__` is the only way to bring a hundred
 * lines of Python in here without leaving either `sys` or temporary variables
 * in the student's namespace. `setdefault` makes the install idempotent, and a
 * repeated `exec` redefines the functions without touching `state` (see the
 * tail of IMPL).
 *
 * A pool worker's entry (§9.5) adds the attempt's source, its run id and the
 * attempt's memory (CouncilIsolationSettings): the notebook kernel's own entry
 * stays byte for byte what it was.
 */
export function councilEnterSource(
  budgetBytes: number = COUNCIL_DEFAULT_COPY_BYTES,
  options: CouncilIsolationSettings = {},
): string {
  const budget = Number.isFinite(budgetBytes) && budgetBytes >= 0
    ? Math.floor(budgetBytes)
    : COUNCIL_DEFAULT_COPY_BYTES
  const module = JSON.stringify(COUNCIL_MODULE)
  const cap = options.capMb === undefined ? null : capBytes(options.capMb)
  if (options.runId !== undefined && !REMOTE_RUN_ID.test(options.runId)) {
    throw new Error(`A council run id must match REMOTE_RUN_ID, not ${JSON.stringify(options.runId)}`)
  }
  /*
   * Settings as a literal in the call itself, not inside the source.
   *
   * The refusal text depends on the room's language, and that gets changed in
   * the panel in the middle of class: had we baked it into the source, the live
   * kernel would hold yesterday's translation (or we would reinstall the module
   * on every language change). Strings go through `JSON.stringify` (Python
   * escapes them the same way), booleans as Python words: `false` in the kernel
   * is a NameError, not a value.
   */
  const settings = [
    // The refusal words for the guard: its own room ones, but with a different
    // tail: inside an attempt nothing can allow these commands, and pointing to
    // the rule would be untrue (danger.ts · guardCouncilSettings).
    `{'guard': ${guardCouncilSettings()}`,
    `'memory': ${options.memoryGuard === true || cap !== null ? 'True' : 'False'}`,
    `'floor': ${COUNCIL_MEMORY_FLOOR_BYTES}`,
    `'headroom': ${COUNCIL_MEMORY_HEADROOM_BYTES}`,
    ...(cap !== null ? [`'cap': ${cap}`] : []),
    ...(options.source !== undefined ? [`'source': ${JSON.stringify(options.source)}`] : []),
    ...(options.runId !== undefined
      ? [`'runId': ${JSON.stringify(options.runId)}`, `'scratch': ${JSON.stringify(options.scratchRoot ?? COUNCIL_SCRATCH_MOUNT)}`]
      : []),
    ...(options.workspace !== undefined ? [`'workspace': ${JSON.stringify(options.workspace)}`] : []),
    ...(options.skeletonEntries !== undefined ? [`'entries': ${Math.max(1, Math.floor(options.skeletonEntries))}`] : []),
  ].join(', ') + '}'
  return [
    /*
     * The guard against dangerous commands is installed by the FIRST line,
     * before the isolation itself: its module is exactly what the entry
     * immediately takes a hold on, and the order here is not a matter of taste:
     * `_hold` looks for the module in `sys.modules` and refuses without it.
     */
    guardInstallLine(),
    implInstallLine(),
    `__import__('sys').modules[${module}].enter(globals(), ${budget}, ${settings})`,
  ].join('\n')
}

/** The export's report, evaluated after its cell under COUNCIL_REPORT_KEY, like the entry's. */
export const COUNCIL_EXPORT_EXPR = `__import__('sys').modules['${COUNCIL_MODULE}'].exported`

/** A seed's report, the same way. */
export const COUNCIL_SEED_EXPR = `__import__('sys').modules['${COUNCIL_MODULE}'].seeded`

/** An epoch's number: the folder's name, as the contract has it (a whole number from 1). */
function epochSeq(seq: number): number {
  if (!Number.isSafeInteger(seq) || seq < 1) throw new Error(`An epoch's number must be a whole number from 1, not ${seq}`)
  return seq
}

/**
 * The export (§9.2–9.3): one silent execute in the notebook's own kernel, a
 * service item of its FIFO, whose report comes back in `user_expressions`.
 *
 * It writes into COUNCIL_EPOCH_DIR/<seq> inside the kernel's container, which
 * personal kernels and attempts cannot reach; whoever collects it (home for
 * a kernel here, the agent for one on a machine) takes the files the report
 * names as `written`, checks each against its name and removes the folder.
 */
export function exportExpression(options: CouncilExportOptions): CouncilServiceRun {
  const seq = epochSeq(options.seq)
  const runs = Number.isSafeInteger(options.mainRuns) && options.mainRuns >= 0 ? options.mainRuns : 0
  const budget = options.budgetBytes !== undefined && Number.isFinite(options.budgetBytes) && options.budgetBytes >= 0
    ? Math.floor(options.budgetBytes)
    : COUNCIL_EPOCH_MB * 1024 * 1024
  const module = JSON.stringify(COUNCIL_MODULE)
  const settings = [
    `{'seq': ${seq}`,
    `'mainRuns': ${runs}`,
    // The export's own address-space ceiling, as an attempt's entry has it: the notebook's kernel has no other.
    `'floor': ${COUNCIL_MEMORY_FLOOR_BYTES}`,
    `'headroom': ${COUNCIL_MEMORY_HEADROOM_BYTES}`,
    `'threshold': ${COUNCIL_EPOCH_BUFFER_BYTES}`,
    // The stream counts against COUNCIL_EPOCH_BUFFERS_MAX too.
    `'buffers': ${COUNCIL_EPOCH_BUFFERS_MAX - 1}`,
    `'each': ${options.nameBytes !== undefined && Number.isFinite(options.nameBytes) && options.nameBytes >= 1 ? Math.floor(options.nameBytes) : COUNCIL_EPOCH_NAME_BYTES}`,
    `'full': ${options.full === true ? 'True' : 'False'}`,
    ...(options.workspace !== undefined ? [`'workspace': ${JSON.stringify(options.workspace)}`] : []),
  ].join(', ') + '}'
  const out = options.dir ?? `${COUNCIL_EPOCH_DIR}/${seq}`
  return {
    code: [
      implInstallLine(),
      epochInstallLine(),
      `__import__('sys').modules[${module}].export(globals(), ${JSON.stringify(out)}, ${budget}, ${settings})`,
    ].join('\n'),
    userExpressions: { [COUNCIL_REPORT_KEY]: COUNCIL_EXPORT_EXPR },
  }
}

/**
 * The removal of one of the kernel's own export folders that nobody will
 * collect (kernel/council-pool.ts · dropMachineExport): a silent run in a
 * notebook's kernel on a machine, whose container this server cannot reach
 * and whose agent reads only the exports home names. It needs no module,
 * binds no name in the notebook's namespace, and a folder already gone is no
 * error.
 */
export function exportDropExpression(seq: number): CouncilServiceRun {
  return {
    code: `__import__('shutil').rmtree(${JSON.stringify(`${COUNCIL_EPOCH_DIR}/${epochSeq(seq)}`)}, ignore_errors=True)`,
    userExpressions: {},
  }
}

/**
 * A worker's seed (§9.3, §9.5): one silent execute in a fresh worker kernel,
 * before its first attempt, whose report comes back in `user_expressions`.
 *
 * The words of the sentinels go with it, in the room's language at the time
 * of the seed: a worker reseeds often enough (every 20 attempts, every new
 * epoch) for a language changed mid-class to reach it soon.
 */
export function loadExpression(options: CouncilLoadOptions): CouncilServiceRun {
  if (!SHA256.test(options.manifest) || !SHA256.test(options.body)) {
    throw new Error('An epoch is loaded by the sha256 of its manifest and its stream')
  }
  const threads = options.threads !== undefined && Number.isFinite(options.threads) && options.threads >= 1
    ? Math.floor(options.threads)
    : 1
  const module = JSON.stringify(COUNCIL_MODULE)
  const settings = [
    `{'dir': ${JSON.stringify(options.dir ?? COUNCIL_EPOCHS_MOUNT)}`,
    `'threads': ${threads}`,
    `'oom': ${COUNCIL_OOM_SCORE_ADJ}`,
    `'words': ${notCarriedWords()}`,
    ...(options.workspace !== undefined ? [`'workspace': ${JSON.stringify(options.workspace)}`] : []),
  ].join(', ') + '}'
  return {
    code: [
      implInstallLine(),
      epochInstallLine(),
      `__import__('sys').modules[${module}].load(globals(), ${JSON.stringify(options.manifest)}, ` +
        `${JSON.stringify(options.body)}, ${settings})`,
    ].join('\n'),
    userExpressions: { [COUNCIL_REPORT_KEY]: COUNCIL_SEED_EXPR },
  }
}

/** A sha256 as the epoch's files are named. */
const SHA256 = /^[0-9a-f]{64}$/

/** The key of the sentinel's sentence (§9.4); until shared/locales has it, its English words below. */
const NOT_CARRIED_KEY = 'server.council.notCarried'

/** The words for a reason a name stays behind. */
const LEFT_WORDS: Record<CouncilLeftWhy, string> = {
  connection: 'server.databaseConnection.cdf70c',
  file: 'server.openFile.3a6aca',
  socket: 'server.networkSocket.34c443',
  generator: 'server.generator.c33340',
  thread: 'server.thread.49e10b',
  lock: 'server.lock.1f0e8d',
  cuda: 'server.dataOnTheGpu.605180',
  budget: 'server.tooBigForTheSnapshot.1a48a4',
  unpicklable: 'server.cannotBeCopied.e6521a',
  module: 'server.itsModuleIsOnlyInTheNotebook.49d81a',
}

/** Why a name stayed behind, in the instance's words: «соединение с базой». */
export function councilLeftWords(why: string): string {
  return tr(LEFT_WORDS[leftWhy(why)])
}

/** The console's line for an epoch's left names (§9.4): «Не переносится: conn (соединение с базой), batches (генератор).»; `null` with none. */
export function councilLeftLine(left: readonly CouncilLeftName[]): string | null {
  if (left.length === 0) return null
  return tr('server.notCarriedOver.00ad4e', {
    names: left.map((row) => `${row.name} (${councilLeftWords(row.why)})`).join(', '),
  })
}

/**
 * The sentinels' words, as a Python literal for the seed: the sentence with
 * `{name}` and `{why}`, and every reason's words.
 */
function notCarriedWords(): string {
  const sentence = hasTranslation(NOT_CARRIED_KEY)
    ? tr(NOT_CARRIED_KEY)
    : 'The variable {name} was not carried over to the council machine ({why}), and this attempt reached it indirectly. Attempts whose text names {name} run in the shared kernel.'
  const reasons = COUNCIL_LEFT_WHYS.map((why) => `${JSON.stringify(why)}: ${JSON.stringify(councilLeftWords(why))}`)
  return `{'text': ${JSON.stringify(sentence)}, 'why': {${reasons.join(', ')}}}`
}

function leftWhy(value: unknown): CouncilLeftWhy {
  return (COUNCIL_LEFT_WHYS as readonly unknown[]).includes(value) ? (value as CouncilLeftWhy) : 'unpicklable'
}

/**
 * The exit cell, and it has to work even where there was no entry.
 *
 * The module may not exist at all (the entry did not arrive, the kernel was
 * restarted in the meantime), and a KeyError is then a normal outcome, not the
 * attempt's trouble: there is nothing to return.
 */
export const COUNCIL_EXIT_SOURCE = [
  'try:',
  `    __import__('sys').modules[${JSON.stringify(COUNCIL_MODULE)}].leave(globals())`,
  'except Exception:',
  '    pass',
].join('\n')

function skipList(value: unknown): CouncilCopySkip[] {
  if (!Array.isArray(value)) return []
  const out: CouncilCopySkip[] = []
  for (const item of value) {
    const row = item as { name?: unknown; bytes?: unknown }
    if (typeof row?.name !== 'string') continue
    out.push({ name: row.name, bytes: typeof row.bytes === 'number' ? row.bytes : SIZE_UNKNOWN })
  }
  return out
}

function failList(value: unknown): CouncilCopyFailure[] {
  if (!Array.isArray(value)) return []
  const out: CouncilCopyFailure[] = []
  for (const item of value) {
    const row = item as { name?: unknown; error?: unknown }
    if (typeof row?.name !== 'string') continue
    out.push({ name: row.name, error: typeof row.error === 'string' ? row.error : '' })
  }
  return out
}

/**
 * Parse the kernel's answer into an entry report; `null` means there was no
 * confirmation.
 *
 * Accepts both what arrives in `user_expressions` (`{status, data}` with
 * `text/plain` inside) and a bare JSON string; the latter for the test that
 * runs the same sources with a real python3 and reads the report from stdout.
 */
export function parseCouncilReport(raw: unknown): CouncilIsolationReport | null {
  const row = readBundle(raw)
  if (!row || typeof row.ok !== 'boolean') return null
  return {
    ok: row.ok,
    copied: typeof row.copied === 'number' ? row.copied : 0,
    skipped: skipList(row.skipped),
    failed: failList(row.failed),
    bytes: typeof row.bytes === 'number' ? row.bytes : 0,
    memory: typeof row.memory === 'number' ? row.memory : null,
    ms: typeof row.ms === 'number' ? row.ms : 0,
    error: typeof row.error === 'string' ? row.error : null,
    // A refusal names what the attempt needs; an entry that went in needs nothing.
    needs: row.ok ? [] : leftList(row.needs),
    scratch: typeof row.scratch === 'string' ? row.scratch : null,
  }
}

/** The exit report; `null` means there was none, and that is no reason for anything. */
export function parseCouncilLeftovers(raw: unknown): CouncilLeftovers | null {
  const row = readBundle(raw)
  if (!row) return null
  const threads = typeof row.threads === 'number' ? row.threads : 0
  const processes = typeof row.processes === 'number' ? row.processes : 0
  if (threads <= 0 && processes <= 0) return null
  return { threads, processes }
}

/**
 * The exit's whole report, a worker's included; `null` when there was none.
 *
 * Unlike parseCouncilLeftovers it answers with nothing left behind too: a
 * worker's exit is also its list of files and its recycle verdict. A file
 * name the contract could not carry (not canonical) is dropped here and
 * counted with the files past the list, so a collect home builds from it is
 * never refused for one bad name. The Python lists only canonical names
 * (`_canonical`), so this is the second line, not the first.
 */
export function parseExitReport(raw: unknown): CouncilExitReport | null {
  const row = readBundle(raw)
  if (!row) return null
  const files: CouncilArtifact[] = []
  let dropped = 0
  if (Array.isArray(row.files)) {
    for (const item of row.files.slice(0, COUNCIL_EXIT_FILES_MAX)) {
      const file = item as { name?: unknown; bytes?: unknown; sha256?: unknown }
      if (typeof file?.name !== 'string' || normalizePath(file.name) !== file.name || !count(file.bytes)) {
        dropped += 1
        continue
      }
      files.push({ name: file.name, bytes: file.bytes, sha256: typeof file.sha256 === 'string' && SHA256.test(file.sha256) ? file.sha256 : null })
    }
  }
  return {
    threads: count(row.threads) ? row.threads : 0,
    processes: count(row.processes) ? row.processes : 0,
    files,
    more: (count(row.more) ? row.more : 0) + dropped,
    dirty: count(row.dirty) ? row.dirty : null,
    grown: count(row.grown) ? row.grown : null,
    recycle: row.recycle === true,
  }
}

/**
 * An export's report; `null` means there was no confirmation, or one whose
 * files the contract would refuse (bad hashes, over the caps of
 * shared/remote-kernels.ts): either way, no epoch to use.
 */
export function parseExportReport(raw: unknown): CouncilExportReport | null {
  const row = readBundle(raw)
  if (!row || typeof row.ok !== 'boolean') return null
  const base = {
    seq: count(row.seq) ? row.seq : null,
    mainRuns: count(row.mainRuns) ? row.mainRuns : null,
    ms: count(row.ms) ? row.ms : 0,
  }
  if (!row.ok) {
    return {
      ...base, ok: false, manifest: null, manifestBytes: 0, body: null, bodyBytes: 0, buffers: [], written: [],
      bytes: 0, reused: 0, carried: [], left: [], imported: {}, local: [], cuda: false,
      error: typeof row.error === 'string' ? row.error : '',
    }
  }
  const cuda = row.cuda === true
  const buffers: CouncilEpochFile[] = []
  if (Array.isArray(row.buffers)) {
    for (const item of row.buffers) {
      const file = item as { sha256?: unknown; bytes?: unknown }
      if (typeof file?.sha256 !== 'string' || !SHA256.test(file.sha256) || !count(file.bytes)) return null
      buffers.push({ sha256: file.sha256, bytes: file.bytes })
    }
  }
  const manifest = typeof row.manifest === 'string' && SHA256.test(row.manifest) ? row.manifest : null
  const body = typeof row.body === 'string' && SHA256.test(row.body) ? row.body : null
  const manifestBytes = count(row.manifestBytes) ? row.manifestBytes : 0
  const bodyBytes = count(row.bodyBytes) ? row.bodyBytes : 0
  // An epoch is its manifest and its stream, or nothing at all (CUDA).
  if (!cuda && (manifest === null || body === null || manifestBytes < 1)) return null
  if (cuda && (manifest !== null || buffers.length > 0)) return null
  const shas = new Set(buffers.map((file) => file.sha256))
  if (shas.size !== buffers.length || (body !== null && shas.has(body)) || (manifest !== null && (shas.has(manifest) || manifest === body))) return null
  const bytes = manifestBytes + bodyBytes + buffers.reduce((sum, file) => sum + file.bytes, 0)
  if (buffers.length + 1 > COUNCIL_EPOCH_BUFFERS_MAX || manifestBytes > COUNCIL_EPOCH_MANIFEST_BYTES || bytes > COUNCIL_EPOCH_MB * 1024 * 1024) return null
  const imported: Record<string, string> = {}
  if (row.imported && typeof row.imported === 'object' && !Array.isArray(row.imported)) {
    for (const [alias, name] of Object.entries(row.imported as Record<string, unknown>)) {
      if (typeof name === 'string') imported[alias] = name
    }
  }
  return {
    ...base,
    ok: true,
    manifest,
    manifestBytes,
    body,
    bodyBytes,
    buffers,
    written: Array.isArray(row.written) ? row.written.filter((sha): sha is string => typeof sha === 'string' && SHA256.test(sha)) : [],
    bytes,
    reused: count(row.reused) ? row.reused : 0,
    carried: Array.isArray(row.carried) ? row.carried.filter((name): name is string => typeof name === 'string') : [],
    left: leftList(row.left),
    imported,
    local: Array.isArray(row.local) ? row.local.filter((name): name is string => typeof name === 'string') : [],
    cuda,
    error: null,
    ...('hashSeed' in row ? { hashSeed: typeof row.hashSeed === 'string' ? row.hashSeed.slice(0, 32) : null } : {}),
  }
}

/** The files of an epoch besides its manifest, as RemoteEpochIntent.buffers has them: the stream first, then the buffers. */
export function epochFiles(report: CouncilExportReport): CouncilEpochFile[] {
  if (report.body === null) return []
  return [{ sha256: report.body, bytes: report.bodyBytes }, ...report.buffers]
}

/** A seed's report; `null` means there was no confirmation, and the worker is not seeded. */
export function parseSeedReport(raw: unknown): CouncilSeedReport | null {
  const row = readBundle(raw)
  if (!row || typeof row.ok !== 'boolean') return null
  return {
    ok: row.ok,
    seq: count(row.seq) ? row.seq : null,
    manifest: typeof row.manifest === 'string' && SHA256.test(row.manifest) ? row.manifest : null,
    loaded: count(row.loaded) ? row.loaded : 0,
    imported: count(row.imported) ? row.imported : 0,
    left: leftList(row.left),
    oomScoreAdj: typeof row.oomScoreAdj === 'number' && Number.isInteger(row.oomScoreAdj) ? row.oomScoreAdj : null,
    threads: count(row.threads) ? row.threads : null,
    mapped: count(row.mapped) ? row.mapped : 0,
    ms: count(row.ms) ? row.ms : 0,
    error: row.ok ? null : typeof row.error === 'string' ? row.error : '',
  }
}

/** A whole number from zero, as the reports count bytes and files. */
function count(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

/** Left names as the reports list them; an unknown reason reads as "cannot be copied". */
function leftList(value: unknown): CouncilLeftName[] {
  if (!Array.isArray(value)) return []
  const out: CouncilLeftName[] = []
  for (const item of value) {
    const row = item as { name?: unknown; why?: unknown }
    if (typeof row?.name !== 'string') continue
    out.push({ name: row.name, why: leftWhy(row.why) })
  }
  return out
}

/** Shared by both reports: get the JSON out of a mimebundle or a bare string. */
function readBundle(raw: unknown): Record<string, unknown> | null {
  let text: string | null = null
  if (typeof raw === 'string') text = raw
  else if (raw && typeof raw === 'object') {
    const wrapper = raw as { status?: unknown; data?: Record<string, unknown> }
    // status !== 'ok' is IPython's `_user_obj_error()`: the expression was not
    // evaluated, i.e. the module or its report is missing.
    if (wrapper.status !== undefined && wrapper.status !== 'ok') return null
    const plain = wrapper.data?.['text/plain']
    if (typeof plain === 'string') text = plain
  }
  if (text === null || text === 'None') return null
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return null
  }
  if (!parsed || typeof parsed !== 'object') return null
  return parsed as Record<string, unknown>
}

/** Bytes in words: "1.2 GB". The number follows the instance language, like the rest. */
export function sizeWords(bytes: number): string {
  const round = (value: number) =>
    formatNumber(value, { maximumFractionDigits: value < 10 ? 1 : 0 })
  if (bytes >= 1024 * 1024 * 1024) return tr('server.council.sizeGb', { p0: round(bytes / 1024 ** 3) })
  if (bytes >= 1024 * 1024) return tr('server.council.sizeMb', { p0: round(bytes / 1024 ** 2) })
  return tr('server.council.sizeKb', { p0: round(Math.max(1, bytes) / 1024) })
}

/**
 * What to tell the attempt about what stayed shared.
 *
 * The lines go at the start of its output, one per variable and no more than
 * three: an attempt card is drawn in a stack of hundreds, and ten lines of
 * warnings would push the answer itself out of it. The rest as a number.
 *
 * Failed copies (`failed`) say exactly the same: for a student there is no
 * difference between "did not fit" and "did not copy"; the data is shared, and
 * the rule is the same.
 */
export function councilSkipNotes(report: CouncilIsolationReport): string[] {
  const shared: CouncilCopySkip[] = [
    ...report.skipped,
    ...report.failed.map((row) => ({ name: row.name, bytes: SIZE_UNKNOWN })),
  ]
  if (shared.length === 0) return []
  const lines = shared.slice(0, MAX_SKIP_NOTES).map(({ name, bytes }) =>
    bytes >= 0
      ? tr('server.council.copyTooBig', { p0: name, p1: sizeWords(bytes) })
      : tr('server.council.copyShared', { p0: name }),
  )
  if (shared.length > MAX_SKIP_NOTES) {
    lines.push(tr('server.council.copyMore', { count: shared.length - MAX_SKIP_NOTES }))
  }
  return lines.map((line) => `${line}\n`)
}

/** Why the entry failed: one line, no traceback, in the room's language. */
export function councilEnterRefusal(reason: string | null): string {
  return tr('server.council.copyFailed', {
    p0: reason && reason.trim().length > 0 ? reason.trim() : tr('server.council.copyNoAnswer'),
  })
}

/**
 * The attempt hit the memory ceiling, and that is good news that has to be
 * told well.
 *
 * Without the ceiling the same `np.ones((40000, 40000))` would call the OOM
 * killer, and that kills the notebook's kernel: the teacher's analysis, the
 * data of everyone who has already submitted, and the queue. The student has
 * to understand that it is THEY who failed, not the class.
 */
export function councilMemoryNote(bytes: number | null): string {
  return `${bytes && bytes > 0
    ? tr('server.council.outOfMemory', { p0: sizeWords(bytes) })
    : tr('server.council.outOfMemoryPlain')}\n`
}

/**
 * What the attempt left running behind it.
 *
 * A thread started by an attempt outlives it and keeps writing into the shared
 * kernel; there is no way to stop it, since Python has no `Thread.stop()`. So
 * we do not fix it, we name it: the teacher reading the output should know why
 * something in the room moves on its own.
 */
export function councilLeftoverNotes(left: CouncilLeftovers | null): string[] {
  if (!left) return []
  const lines: string[] = []
  if (left.threads > 0) lines.push(tr('server.council.threadsLeft', { count: left.threads }))
  if (left.processes > 0) lines.push(tr('server.council.processesKilled', { count: left.processes }))
  return lines.map((line) => `${line}\n`)
}
