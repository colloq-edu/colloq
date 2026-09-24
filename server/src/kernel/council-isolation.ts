import { createHash } from 'node:crypto'
import { tr, formatNumber } from '@shared/i18n'
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
}

/** What could not be returned after the attempt. */
export interface CouncilLeftovers {
  /** Threads the attempt left running: there is no way to stop them. */
  threads: number
  /** Child processes that had to be killed on its behalf. */
  processes: number
}

/** Texts and knobs the entry gets from the server rather than carrying itself. */
export interface CouncilIsolationSettings {
  budgetBytes?: number
  /** Whether to set an address-space ceiling for the duration of the attempt. */
  memoryGuard?: boolean
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
import builtins
import collections
import copy
import json
import os
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
    np = _numpy()
    if np is not None:
        if isinstance(obj, np.ndarray):
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


def _memory_cap(floor, headroom):
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
    """
    if not sys.platform.startswith('linux'):
        return None
    if _gpu_near():
        return None
    limit = _cgroup('memory.max', 'memory/memory.limit_in_bytes')
    if limit is None:
        return None
    used = _cgroup('memory.current', 'memory/memory.usage_in_bytes')
    if used is None:
        return None
    room = limit - max(used - _reclaimable(), 0) - headroom
    if room < floor:
        room = floor
    return room


def _arm_memory(floor, headroom):
    """Set the ceiling, returning the old one (for the exit) and the amount given."""
    res = sys.modules.get('resource')
    if res is None:
        try:
            import resource as res
        except Exception:
            return None
    room = _memory_cap(floor, headroom)
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
        return None
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
    # The exit report is optional: the server reads it if it arrived, and
    # silence here is no trouble for the attempt, unlike silence at the entry.
    try:
        leftovers = _Report(json.dumps(left, separators=(',', ':')))
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
        if state:
            # The previous exit did not get through (the kernel died, the
            # server restarted): it goes first, otherwise this entry's saved
            # would remember someone else's copies as originals, and the real
            # data would be lost for good.
            leave(ns)
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
                 'memory': None}
        if not state['guard']:
            # Without the guard the attempt does not run at all: a student on
            # the SHARED kernel must not be able to bring the class down under
            # any room rule, and "it seems to have gone in" is no answer here.
            raise RuntimeError('guard unavailable')

        copies = {}
        skipped = []
        failed = []
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

        cap = None
        if settings.get('memory'):
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
                cap = armed['room']

        report = _Report(json.dumps({
            'ok': True,
            'copied': len(copies),
            'skipped': skipped,
            'failed': failed,
            'bytes': used,
            'memory': cap,
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
# As the last line, and this matters: by it the entry knows the install got to
# the END. An exec interrupted halfway would leave the module without version,
# and the next attempt would reinstall it whole rather than rely on half.
version = '__VERSION__'
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

/**
 * The entry cell: two expressions, not a single bound name.
 *
 * `exec` into the hidden module's `__dict__` is the only way to bring a hundred
 * lines of Python in here without leaving either `sys` or temporary variables
 * in the student's namespace. `setdefault` makes the install idempotent, and a
 * repeated `exec` redefines the functions without touching `state` (see the
 * tail of IMPL).
 */
export function councilEnterSource(
  budgetBytes: number = COUNCIL_DEFAULT_COPY_BYTES,
  options: CouncilIsolationSettings = {},
): string {
  const budget = Number.isFinite(budgetBytes) && budgetBytes >= 0
    ? Math.floor(budgetBytes)
    : COUNCIL_DEFAULT_COPY_BYTES
  const source = implLiteral()
  const module = JSON.stringify(COUNCIL_MODULE)
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
    `'memory': ${options.memoryGuard === true ? 'True' : 'False'}`,
    `'floor': ${COUNCIL_MEMORY_FLOOR_BYTES}`,
    `'headroom': ${COUNCIL_MEMORY_HEADROOM_BYTES}}`,
  ].join(', ')
  return [
    /*
     * The guard against dangerous commands is installed by the FIRST line,
     * before the isolation itself: its module is exactly what the entry
     * immediately takes a hold on, and the order here is not a matter of taste:
     * `_hold` looks for the module in `sys.modules` and refuses without it.
     */
    guardInstallLine(),
    /*
     * Install only when it is not there yet or is a different one.
     *
     * The source grows with every new type (twenty-odd kilobytes), and its
     * `compile` cost about half a millisecond for EVERY attempt, while between
     * attempts it never changes. The version check removes that entirely and
     * stays honest: a different server build means a different hash, and a
     * live kernel gets the new code without a restart.
     */
    `if getattr(__import__('sys').modules.get(${module}), 'version', None) != ` +
      `${JSON.stringify(implVersion())}: ` +
      `exec(compile(${source}, '<colloq-council>', 'exec'), ` +
      `__import__('sys').modules.setdefault(${module}, ` +
      `__import__('types').ModuleType(${module})).__dict__)`,
    `__import__('sys').modules[${module}].enter(globals(), ${budget}, ${settings})`,
  ].join('\n')
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
