/**
 * The contest judge's harness, materialized the way the competitions' harness is
 * (server/src/competitions/harness.ts).
 *
 * WHY A STRING AND NOT A FILE. The server is built with esbuild and installed
 * from a package; a `.py` sitting next to this module under `server/src` would
 * reach neither `dist` nor the package. A string travels through the build, the
 * container image and `pip install` alike, where a "remember to copy judge.py"
 * step would survive none of them.
 *
 * WHY MATERIALIZED, AND UNDER A HASH. The harness is mounted read-only into the
 * judge container at `/judge`, and only a path inside DATA_DIR can be turned
 * into the host path the docker daemon needs under `make up` (hostPathOf). The
 * directory carries the content hash in its name for the colima/virtiofs rule
 * the whole storage tree lives by: a directory removed and recreated under the
 * same name answers "Directory nonexistent" from inside the VM for about a
 * minute, so a changed harness is a new path and the old one is never touched
 * (competitions/storage.ts header).
 *
 * WHY ITS OWN ANCHORED FILESYSTEM. The contests' on-disk tree (its database
 * rows, the tests, the runs) belongs to the queue, in a module this one must
 * not reach into or wait for — the judge is the half that could one day run on
 * a machine of its own. So the few paths the judge writes by itself go through
 * an anchored filesystem it opens here, over the very directory the queue uses
 * (`<DATA_DIR>/contests`); two anchored handles over one root is no more than
 * two open descriptors (secure-files.ts). The judge creates only what it owns:
 * this harness directory, and each run's `jobDir` (docker-judge.ts).
 *
 * The harness itself is documented at the top of the Python below: it reads a
 * framed job from stdin, keeps the answers in a root-only tmpfs the program can
 * never read, compiles and runs every test as `nobody`, and reports JSON lines
 * on stdout. See docs/architecture/contests.md §2 and judge/docker-judge.ts.
 */
import path from 'node:path'
import { createHash } from 'node:crypto'
import { dataDir } from '../../data-dir.js'
import { createAnchoredFilesystem } from '../../secure-files.js'

/** The root of every contest's files on disk (the same the queue uses). */
export const contestsDir = path.join(dataDir, 'contests')

/**
 * The judge's own anchored view of that root: every name it opens is resolved
 * segment by segment with O_NOFOLLOW, so a test revision or a contest id that
 * came from the database cannot walk the write out of the tree (secure-files.ts).
 */
export const contestsFs = createAnchoredFilesystem(contestsDir)

/**
 * The harness source.
 *
 * `String.raw` so that every backslash in the Python — `\n` in a byte string,
 * `\x0b` in the whitespace set, `\u2026` for the ellipsis — reaches the file
 * exactly as written, not as whatever JavaScript would make of the escape. The
 * source holds no backtick and no `${`, so nothing in it is interpolated or
 * closes the literal early (judge/harness-source is checked in the suite).
 */
export const JUDGE_SOURCE = String.raw`"""The contest judge's harness: one submission, every test, inside its container.

It runs as root, PID 1 of a disposable container with no network and a
read-only root (server/src/contests/judge/docker-judge.ts starts it), and it is
the only process there that may ever read an answer. It reads its job from
stdin, keeps the answers in /secret (a tmpfs only root may enter), compiles the
source, runs every test as nobody and reports on stdout, one JSON object a
line:

  {"t":"compile"}                                   compiling now
  {"t":"compiled","ok":true,"log":"...","ms":412}   the compiler's word
  {"t":"start","n":3}                               test 3 is running
  {"t":"check","n":3}                               test 3 ran, its output is being checked
  {"t":"answer","n":3,"b64":"..."}                  mode answers: a piece of what test 3 printed
  {"t":"test","n":3,"v":"WA","ms":12,"kb":9120}     test 3's verdict, with snippets and the note
  {"t":"done"}  or  {"t":"done","se":"..."}         the end: all said, or the judge itself failed

Nothing else is ever written to stdout: the program's own output goes to files
in /secret, the compiler's and the checker's to pipes this process reads.

Time is the program's user + system time and memory its ru_maxrss, both from
wait4. The memory has a floor: Linux starts a child's ru_maxrss at the RSS of
the process it was forked from, so an empty C program reports what this
harness held at the fork — about 10 MB, measured in the kernel image. Far
below the smallest limit a contest may set (16 MB), and kept steady by doing
every heavy check in a child of its own (isolated()).

Python 3.11 standard library only: the kernel images are python:3.11-slim, and
nothing is installed into them for the judge's sake.
"""

import base64
import codecs
import fcntl
import json
import math
import os
import re
import resource
import select
import signal
import stat
import sys
import time
import traceback
import warnings

NOBODY = 65534
# The teacher's custom checker runs as a uid of its own: not root, so it cannot
# open /secret (0700) and read the answers of other tests whatever a crafted
# output makes it do, and not nobody, so the program's uid can neither signal
# nor trace it, and the after-test sweep of nobody's processes never hits it.
CHECKER_UID = 65533

# The test suite's way in: the harness run by the system python3 with no
# container around it — no privilege drop, no /proc sweep, every directory
# named in the environment. main() refuses it as root, so that a variable in an
# image can never turn the real judge into this.
NO_SANDBOX = os.environ.get("COLLOQ_JUDGE_NO_SANDBOX") == "1"

HEADER_BYTES = 4 << 20
COPY_CHUNK = 1 << 20
ANSWER_CHUNK = 48 << 10
COMPILE_SECONDS = 60
CHECKER_SECONDS = 10
# A binary bigger than this is a source that put its data into .data; the
# working tmpfs holds it twice (the build and the copy the tests run).
COMPILE_FSIZE = 64 << 20
COMPILE_AS = 2 << 30
STACK_CAP = 1 << 30
PROGRAM_FILES = 64
NOTE_CHARS = 32
MESSAGE_CHARS = 1024
DETAIL_CHARS = 8000
CAPTURE_BYTES = 16 << 10

LANGUAGES = {"python3": "solution.py", "cpp20": "solution.cpp", "c17": "solution.c"}
MODES = ("icpc", "ioi", "answers")
CHECKERS = ("tokens", "lines", "float", "custom")
WHITESPACE = b" \t\n\r\x0b\x0c"
TRAILING = b" \t\r\x0b\x0c"
NUMBER = re.compile(rb"[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?\Z")
TICKS = os.sysconf("SC_CLK_TCK") if hasattr(os, "sysconf") else 100
SAFE_PATH = "/usr/local/bin:/usr/bin:/bin"


class Failure(Exception):
    """The judge's own failure (SE): never the participant's fault, never their verdict."""

    def __init__(self, detail):
        super().__init__(detail)
        self.detail = detail[-DETAIL_CHARS:]


def where(name):
    if not NO_SANDBOX:
        return {"job": "/job", "tests": "/tests", "secret": "/secret", "work": "/work", "tmp": "/tmp"}[name]
    return os.environ["COLLOQ_JUDGE_" + name.upper()]


JOB = where("job")
TESTS = where("tests")
SECRET = where("secret")
WORK = where("work")
TMP = where("tmp")
ANSWERS = os.path.join(SECRET, "ans")
CHECKER = os.path.join(SECRET, "checker.py")
RUNS = os.path.join(SECRET, "run")
OUT = os.path.join(RUNS, "out")
ERR = os.path.join(RUNS, "err")
BUILD = os.path.join(WORK, "build")
BIN = os.path.join(WORK, "bin")
RUN = os.path.join(WORK, "run")
HARNESS = os.path.abspath(__file__)

# Where a program may leave files that would outlive its test: its working
# directory (emptied whole) and the shared scratch places (only nobody's
# entries go). /dev/shm and /dev/mqueue come with every container.
SHARED_SCRATCH = [TMP] if NO_SANDBOX else [TMP, "/dev/shm", "/dev/mqueue"]

_STDOUT = sys.stdout.buffer


def emit(message):
    line = json.dumps(message, ensure_ascii=False, separators=(",", ":")) + "\n"
    try:
        _STDOUT.write(line.encode("utf-8", "replace"))
        _STDOUT.flush()
    except OSError:
        # Nobody reads any more: the host is gone or has killed the container.
        os._exit(3)


def is_int(value):
    return isinstance(value, int) and not isinstance(value, bool)


def write_all(fd, data):
    view = memoryview(data)
    while view:
        view = view[os.write(fd, view):]


def text_of(data, limit):
    """At most 'limit' bytes as text, never ending in half a character."""
    return codecs.getincrementaldecoder("utf-8")("replace").decode(bytes(data[:limit]), final=False)


def snippet(path, limit):
    try:
        with open(path, "rb") as handle:
            data = handle.read(limit)
    except OSError:
        return None
    return text_of(data, limit) or None


def size_of(path):
    try:
        return os.stat(path).st_size
    except OSError:
        return 0


# ------------------------------------------------------------------- the job


def read_job():
    """The header, then every answer and the checker's code — straight into /secret."""
    stdin = sys.stdin.buffer
    raw = stdin.readline(HEADER_BYTES + 1)
    if not raw.endswith(b"\n"):
        raise Failure("the job's header is missing or longer than %d bytes" % HEADER_BYTES)
    try:
        job = json.loads(raw)
    except ValueError as error:
        raise Failure("the job's header is not JSON: %s" % error)
    check_header(job)
    os.mkdir(ANSWERS, 0o700)
    os.mkdir(RUNS, 0o700)
    for test in job["tests"]:
        if test["answerBytes"] is not None:
            store(stdin, test["answerBytes"], os.path.join(ANSWERS, str(test["n"])))
    store(stdin, job["checker"]["codeBytes"], CHECKER)
    return job


def check_header(job):
    def need(ok, what):
        if not ok:
            raise Failure("the job's header is malformed: " + what)

    need(isinstance(job, dict) and job.get("v") == 1, "version")
    need(job.get("language") in LANGUAGES, "language")
    need(is_int(job.get("timeLimitMs")) and 1 <= job["timeLimitMs"] <= 600000, "timeLimitMs")
    need(is_int(job.get("memoryMb")) and 1 <= job["memoryMb"] <= 1 << 20, "memoryMb")
    need(job.get("mode") in MODES, "mode")
    for key in ("outputCap", "snippetBytes", "compileLogBytes"):
        need(is_int(job.get(key)) and job[key] > 0, key)
    checker = job.get("checker")
    need(isinstance(checker, dict) and checker.get("kind") in CHECKERS, "checker")
    epsilon = checker.get("epsilon")
    need(isinstance(epsilon, (int, float)) and not isinstance(epsilon, bool) and math.isfinite(epsilon) and epsilon >= 0, "checker.epsilon")
    need(is_int(checker.get("codeBytes")) and checker["codeBytes"] >= 0, "checker.codeBytes")
    need(checker["kind"] != "custom" or job["mode"] == "answers" or checker["codeBytes"] > 0, "a custom checker without code")
    need(isinstance(job.get("tests"), list), "tests")
    seen = set()
    for test in job["tests"]:
        need(isinstance(test, dict) and is_int(test.get("n")) and test["n"] >= 1 and test["n"] not in seen, "a test's number")
        seen.add(test["n"])
        need(isinstance(test.get("sample"), bool) and is_int(test.get("group")), "test %d" % test["n"])
        size = test.get("answerBytes")
        if job["mode"] == "answers":
            need(size is None, "test %d carries an answer in mode answers" % test["n"])
        else:
            need(is_int(size) and size >= 0, "test %d has no answer" % test["n"])


def store(stream, size, path):
    """Copy 'size' bytes of the job into a file of /secret, a megabyte at a time at most."""
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    try:
        left = size
        while left > 0:
            block = stream.read(min(left, COPY_CHUNK))
            if not block:
                raise Failure("the job ended %d bytes early" % left)
            write_all(fd, block)
            left -= len(block)
    finally:
        os.close(fd)


# --------------------------------------------------------------- processes


class Exited:
    """How a child ended: its status and rusage from wait4, and who stopped it."""

    def __init__(self, status, usage, killed):
        self.status = status
        self.usage = usage
        self.killed = killed

    @property
    def signal(self):
        return os.WTERMSIG(self.status) if os.WIFSIGNALED(self.status) else 0

    @property
    def code(self):
        return os.WEXITSTATUS(self.status) if os.WIFEXITED(self.status) else None

    @property
    def cpu_ms(self):
        return int(round((self.usage.ru_utime + self.usage.ru_stime) * 1000))

    @property
    def kb(self):
        # Linux counts ru_maxrss in kilobytes, macOS (the no-sandbox runs of the suite) in bytes.
        peak = self.usage.ru_maxrss
        return peak // 1024 if sys.platform == "darwin" else peak

    def describe(self):
        if self.signal:
            try:
                return signal.Signals(self.signal).name
            except ValueError:
                return "signal %d" % self.signal
        return "exit %d" % (self.code or 0)


def set_limit(which, soft, hard):
    _, current = resource.getrlimit(which)
    if current != resource.RLIM_INFINITY:
        hard = min(hard, current)
        soft = min(soft, hard)
    try:
        resource.setrlimit(which, (soft, hard))
    except (ValueError, OSError):
        # Only the no-sandbox runs get here (macOS keeps its own rules for the
        # stack); in the container root lowers what it likes.
        if not NO_SANDBOX:
            raise


def drop_to_nobody():
    if NO_SANDBOX:
        return
    os.setgroups([])
    os.setresgid(NOBODY, NOBODY, NOBODY)
    os.setresuid(NOBODY, NOBODY, NOBODY)


def become_child(stdin_fd, stdout_fd, stderr_fd, keep, cwd, limits, nobody, oom):
    """Everything between fork and exec, in the order that works.

    A session of its own first, so that its descendants can be killed as one
    group. The OOM score while still root: a cgroup out of memory then kills
    the program, not the harness that would report it. Descriptors before the
    limits — closing everything above 2 has to see the old ceiling. Python
    ignores SIGPIPE and SIGXFSZ, and an ignored signal survives exec: without
    the reset a C program over its output cap would get EFBIG instead of
    SIGXFSZ. The uid last, because everything before it needs root.
    """
    os.setsid()
    if oom:
        try:
            with open("/proc/self/oom_score_adj", "w") as handle:
                handle.write("1000")
        except OSError:
            pass
    os.dup2(stdin_fd, 0)
    os.dup2(stdout_fd, 1)
    os.dup2(stderr_fd, 2)
    os.closerange(3, keep)
    os.closerange(keep + 1, 1 << 16)
    for which, soft, hard in limits:
        set_limit(which, soft, hard)
    os.chdir(cwd)
    for number in (signal.SIGPIPE, signal.SIGXFSZ):
        signal.signal(number, signal.SIG_DFL)
    os.umask(0o022)
    if nobody:
        drop_to_nobody()


class SpawnError(Exception):
    pass


def spawn(argv, env, cwd, stdin_fd, stdout_fd, stderr_fd, limits, nobody, oom):
    """Fork and exec; a failure before or at exec comes back as SpawnError, not as an exit code.

    The classic close-on-exec pipe: a successful exec closes it with nothing
    written, a failed one leaves the reason in it. Otherwise "python3 is not in
    the image" would read as the participant's runtime error.
    """
    reader, writer = os.pipe()
    pid = os.fork()
    if pid == 0:
        try:
            os.close(reader)
            become_child(stdin_fd, stdout_fd, stderr_fd, writer, cwd, limits, nobody, oom)
            os.execve(argv[0], argv, env)
        except BaseException as error:
            try:
                os.write(writer, ("%s: %s" % (type(error).__name__, error)).encode("utf-8", "replace")[:2000])
            finally:
                os._exit(127)
    os.close(writer)
    reason = b""
    while True:
        block = os.read(reader, 4096)
        if not block:
            break
        reason += block
    os.close(reader)
    if reason:
        os.waitpid(pid, 0)
        raise SpawnError(reason.decode("utf-8", "replace"))
    return pid


def pidfd(pid):
    """A descriptor that becomes readable when the child exits (Linux 5.3+); None — poll by sleeping."""
    try:
        return os.pidfd_open(pid)
    except (AttributeError, OSError):
        return None


def exited(pid):
    """Whether the child has ended — without reaping it, so its pid stays ours to kill the group by."""
    return os.waitid(os.P_PID, pid, os.WEXITED | os.WNOHANG | os.WNOWAIT) is not None


def kill_group(pid):
    for kill in (os.killpg, os.kill):
        try:
            kill(pid, signal.SIGKILL)
        except (ProcessLookupError, PermissionError):
            pass


def cpu_ms(pid):
    """The processor time a running child has used so far, from /proc; None where there is no /proc."""
    try:
        with open("/proc/%d/stat" % pid, "rb") as handle:
            raw = handle.read()
        fields = raw[raw.rfind(b")") + 2:].split()
        return (int(fields[11]) + int(fields[12])) * 1000 // TICKS
    except (OSError, IndexError, ValueError):
        return None


def reap():
    """Collect every child that has ended. PID 1 inherits every orphan; nobody else will."""
    while True:
        try:
            pid, _ = os.waitpid(-1, os.WNOHANG)
        except ChildProcessError:
            return
        if pid == 0:
            return


def wait_program(pid, limit_ms, started):
    """Wait for a test's program and stop it at its limits.

    The wall clock gives it 2 × TL + 1 s, for a program that sleeps or waits.
    The processor is watched from /proc once the wall clock has passed TL —
    one CPU can spend no more than that before — so a busy loop stops at TL
    rather than at the wall's end or at RLIMIT_CPU's next whole second.
    """
    wall_end = started + (2 * limit_ms + 1000) / 1000.0
    cpu_from = started + limit_ms / 1000.0
    handle = pidfd(pid)
    killed = None
    pause = 0.0005
    try:
        while not exited(pid):
            now = time.monotonic()
            if killed is None:
                if now >= wall_end:
                    killed = "wall"
                elif now >= cpu_from:
                    used = cpu_ms(pid)
                    if used is not None and used > limit_ms:
                        killed = "cpu"
                if killed is not None:
                    kill_group(pid)
                    continue
            if killed is not None:
                wait = 0.001
            elif now < cpu_from:
                wait = cpu_from - now
            else:
                wait = min(wall_end - now, 0.005)
            wait = max(wait, 0.0)
            if handle is not None:
                select.select([handle], [], [], wait)
            else:
                time.sleep(min(wait, pause))
                pause = min(pause * 2, 0.01)
    finally:
        if handle is not None:
            os.close(handle)
    # Whatever it left in its own session goes while its pid is still ours.
    kill_group(pid)
    _, status, usage = os.wait4(pid, 0)
    return Exited(status, usage, killed)


def wait_with_output(pid, fd, seconds, cap):
    """Wait for a child at most 'seconds', reading its output pipe meanwhile; keep 'cap' bytes of it.

    The pipe is drained while the child runs, not after: g++ can print
    megabytes about one template, and a full pipe would stop it forever. A
    child that has ended while something it started still holds the pipe gets
    one more second, not the rest of its deadline.
    """
    deadline = time.monotonic() + seconds
    handle = pidfd(pid)
    kept = bytearray()
    reading = True
    killed = None
    linger = None
    try:
        while True:
            done = exited(pid)
            if done and not reading:
                break
            now = time.monotonic()
            if done and linger is None:
                linger = now + 1.0
            if not done and now >= deadline:
                killed = "wall"
                break
            if done and now >= linger:
                break
            watch = [fd] if reading else []
            if handle is not None and not done:
                watch.append(handle)
            wait = (linger if done else deadline) - now
            if handle is None and not done:
                wait = min(wait, 0.005)
            wait = max(wait, 0.0)
            if not watch:
                time.sleep(wait)
                continue
            if fd in select.select(watch, [], [], wait)[0]:
                block = os.read(fd, 65536)
                if not block:
                    reading = False
                elif len(kept) < cap:
                    kept += block[: cap - len(kept)]
    finally:
        if handle is not None:
            os.close(handle)
        os.close(fd)
    kill_group(pid)
    _, status, usage = os.wait4(pid, 0)
    return Exited(status, usage, killed), bytes(kept)


def isolated(work):
    """Run 'work' in a forked child and hand back what it returned (JSON-able).

    For the harness's own memory, which is every test's: a child's ru_maxrss
    starts at the RSS of the process it was forked from (measured in the
    kernel image: posix_spawn does the same), so a check that grew this
    process by fifty megabytes would hand them to every later test as memory
    it never used. The heavy reading happens here and dies with the child.
    """
    reader, writer = os.pipe()
    pid = os.fork()
    if pid == 0:
        try:
            os.close(reader)
            result = {"value": work()}
        except BaseException as error:
            result = {"error": "%s: %s" % (type(error).__name__, error)}
        try:
            write_all(writer, json.dumps(result).encode("utf-8"))
        finally:
            os._exit(0)
    os.close(writer)
    data = bytearray()
    while True:
        block = os.read(reader, 65536)
        if not block:
            break
        data += block
    os.close(reader)
    _, status = os.waitpid(pid, 0)
    try:
        result = json.loads(bytes(data))
    except ValueError:
        raise Failure("a check died without an answer (status %d)" % status)
    if "error" in result:
        raise Failure("a check failed: %s" % result["error"])
    return result["value"]


def nobody_processes():
    """Processes of uid 65534 by /proc: the live ones and the zombies."""
    alive, dead = [], []
    for name in os.listdir("/proc"):
        if not name.isdigit():
            continue
        try:
            with open("/proc/%s/status" % name, "rb") as handle:
                status = handle.read()
        except OSError:
            continue
        uids, state = [], b""
        for line in status.split(b"\n"):
            if line.startswith(b"Uid:"):
                uids = line.split()[1:]
            elif line.startswith(b"State:"):
                state = line.split()[1] if len(line.split()) > 1 else b""
        if any(uid == b"65534" for uid in uids):
            (dead if state in (b"Z", b"X") else alive).append(int(name))
    return alive, dead


def kill_all_as_nobody():
    """kill(-1) from a process of uid 65534: every process of that uid but itself, in one call.

    The kernel walks the task list under the lock fork must take to add a
    child, so not even a fork bomb gets a process past it. Best effort: when
    the pids are full there is no fork for it, and the root-side kills of the
    sweep free them for the next round.
    """
    try:
        pid = os.fork()
    except OSError:
        return
    if pid == 0:
        try:
            drop_to_nobody()
            os.kill(-1, signal.SIGKILL)
        finally:
            os._exit(0)
    os.waitpid(pid, 0)


def kill_leftovers():
    """No process of the program outlives its test: double-forked, setsid or not."""
    if NO_SANDBOX:
        reap()
        return
    deadline = time.monotonic() + 5
    while True:
        alive, dead = nobody_processes()
        if not alive and not dead:
            return
        for pid in alive:
            try:
                os.kill(pid, signal.SIGKILL)
            except (ProcessLookupError, PermissionError):
                pass
        if alive:
            kill_all_as_nobody()
        reap()
        if time.monotonic() > deadline:
            raise Failure("processes of the program outlived its test: %s" % sorted(alive + dead)[:20])
        time.sleep(0.001)


# ----------------------------------------------------------------- scratch


def entries(place, owner):
    try:
        names = os.listdir(place)
    except OSError:
        return []
    found = []
    for name in names:
        try:
            info = os.lstat(os.path.join(place, name))
        except OSError:
            continue
        if owner is None or info.st_uid == owner:
            found.append(name)
    return found


def clear(place, owner):
    """Remove the entries of 'place' (only those 'owner' owns, when given), never following a link.

    By descriptors and with a stack, not by path and recursion: a program can
    build a tree deeper than PATH_MAX or than Python's recursion limit, and
    must not turn its own leftovers into the judge's failure.
    """
    top = os.open(place, os.O_RDONLY | os.O_DIRECTORY)
    stack = [(top, entries(place, owner), None)]
    try:
        while stack:
            fd, names, name_in_parent = stack[-1]
            if not names:
                stack.pop()
                if name_in_parent is not None:
                    os.close(fd)
                    os.rmdir(name_in_parent, dir_fd=stack[-1][0])
                continue
            name = names.pop()
            info = os.stat(name, dir_fd=fd, follow_symlinks=False)
            if not stat.S_ISDIR(info.st_mode):
                os.unlink(name, dir_fd=fd)
                continue
            if (info.st_mode & 0o700) != 0o700:
                os.chmod(name, 0o700, dir_fd=fd)
            child = os.open(name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=fd)
            stack.append((child, os.listdir(child), name))
    finally:
        for fd, _, name_in_parent in stack:
            if name_in_parent is not None:
                os.close(fd)
        os.close(top)


def scratch_places():
    places = [(RUN, None)]
    places += [(place, None if NO_SANDBOX else NOBODY) for place in SHARED_SCRATCH]
    return places


def dirty(places):
    return any(entries(place, owner) for place, owner in places)


def clean(places):
    """Empty what a program could have left for the next one.

    As nobody, because only the owner can take apart what nobody built:
    root here has no CAP_DAC_OVERRIDE, and a directory a program made 0755 is
    closed to it.
    """
    if not dirty(places):
        return
    if NO_SANDBOX:
        for place, owner in places:
            clear(place, owner)
    else:
        pid = os.fork()
        if pid == 0:
            code = 0
            try:
                drop_to_nobody()
                for place, owner in places:
                    if os.path.isdir(place):
                        clear(place, owner)
            except BaseException:
                code = 1
            os._exit(code)
        os.waitpid(pid, 0)
    if dirty(places):
        raise Failure("the program's files could not be removed after its test")


# ---------------------------------------------------------------- compiling


def which(tool):
    for folder in (os.environ.get("PATH", SAFE_PATH) if NO_SANDBOX else SAFE_PATH).split(":"):
        candidate = os.path.join(folder, tool)
        if os.path.isfile(candidate) and os.access(candidate, os.X_OK):
            return candidate
    return None


def base_env(home):
    return {
        "PATH": os.environ.get("PATH", SAFE_PATH) if NO_SANDBOX else SAFE_PATH,
        "HOME": home,
        "TMPDIR": TMP,
        "LANG": "C.UTF-8",
        "OMP_NUM_THREADS": "1",
        "OPENBLAS_NUM_THREADS": "1",
        "MKL_NUM_THREADS": "1",
    }


def make_dir(path, mode):
    os.mkdir(path)
    os.chmod(path, mode)


def compile_source(job):
    """Compile, or say why not: (ok, log, argv to run each test with)."""
    language = job["language"]
    source = os.path.join(JOB, LANGUAGES[language])
    if not os.path.isfile(source):
        raise Failure("the source is missing (%s)" % source)
    if language == "python3":
        ok, log = check_python(source, job["compileLogBytes"])
        return ok, log, [sys.executable, "-B", source]
    tool = "g++" if language == "cpp20" else "gcc"
    compiler = which(tool)
    if compiler is None:
        raise Failure("%s not found in the image" % tool)
    make_dir(BUILD, 0o777)
    output = os.path.join(BUILD, "solution")
    # From inside /job and by its bare name, so that every message reads
    # "solution.cpp:3:7: error", as on the participant's own machine.
    name = LANGUAGES[language]
    if language == "cpp20":
        argv = [compiler, "-std=gnu++20", "-O2", "-pipe", "-o", output, name]
    else:
        argv = [compiler, "-std=gnu17", "-O2", "-pipe", "-o", output, name, "-lm"]
    reader, writer = os.pipe()
    quiet = os.open(os.devnull, os.O_RDONLY)
    limits = [
        (resource.RLIMIT_AS, COMPILE_AS, COMPILE_AS),
        (resource.RLIMIT_FSIZE, COMPILE_FSIZE, COMPILE_FSIZE),
        (resource.RLIMIT_CORE, 0, 0),
    ]
    try:
        pid = spawn(argv, base_env(BUILD), JOB, quiet, writer, writer, limits, nobody=True, oom=True)
    except SpawnError as error:
        raise Failure("%s could not be started: %s" % (tool, error))
    finally:
        os.close(writer)
        os.close(quiet)
    ended, log = wait_with_output(pid, reader, COMPILE_SECONDS, job["compileLogBytes"])
    kill_leftovers()
    text = text_of(log, job["compileLogBytes"])
    if ended.killed:
        return False, text + "\ncompilation ran over %d s\n" % COMPILE_SECONDS, None
    if ended.code != 0 or not os.path.isfile(output):
        if ended.signal:
            text += "\nthe compiler was killed (%s)\n" % ended.describe()
        return False, text, None
    # A copy owned by root, in a directory nobody cannot write: no test can
    # rewrite the binary the next one runs.
    make_dir(BIN, 0o755)
    binary = os.path.join(BIN, "solution")
    copy_file(output, binary, 0o755)
    clean([(BUILD, None)])
    os.rmdir(BUILD)
    return True, text, [binary]


def copy_file(source, target, mode):
    reading = os.open(source, os.O_RDONLY | os.O_NOFOLLOW)
    try:
        writing = os.open(target, os.O_WRONLY | os.O_CREAT | os.O_EXCL, mode)
        try:
            while True:
                block = os.read(reading, COPY_CHUNK)
                if not block:
                    break
                write_all(writing, block)
        finally:
            os.close(writing)
    finally:
        os.close(reading)
    os.chmod(target, mode)


def syntax_check(source):
    """compile() of the source, as the interpreter will compile it: a syntax error is CE, nothing runs."""
    with warnings.catch_warnings(record=True) as caught:
        warnings.simplefilter("always")
        try:
            compile(source, "solution.py", "exec", dont_inherit=True)
        except SyntaxError as error:
            return {"ok": False, "log": "".join(traceback.format_exception_only(type(error), error))}
        except (ValueError, MemoryError, RecursionError, OverflowError) as error:
            return {"ok": False, "log": "%s: %s\n" % (type(error).__name__, error)}
    log = "".join(
        "solution.py:%s: %s: %s\n" % (item.lineno, item.category.__name__, item.message)
        for item in caught
        if item.filename == "solution.py"
    )
    return {"ok": True, "log": log}


def check_python(path, cap):
    """The syntax check in a forked child, as nobody: a parser crash or a 2 GB AST is the source's trouble, not the judge's."""
    with open(path, "rb") as handle:
        source = handle.read()
    reader, writer = os.pipe()
    pid = os.fork()
    if pid == 0:
        try:
            os.close(reader)
            quiet = os.open(os.devnull, os.O_RDWR)
            become_child(quiet, quiet, quiet, writer, WORK, [(resource.RLIMIT_AS, COMPILE_AS, COMPILE_AS), (resource.RLIMIT_CORE, 0, 0)], True, True)
        except BaseException as error:
            # Ours, not the source's: the drop to nobody failed. SE, never CE.
            try:
                write_all(writer, json.dumps({"error": "%s: %s" % (type(error).__name__, error)}).encode("utf-8"))
            finally:
                os._exit(0)
        try:
            write_all(writer, json.dumps(syntax_check(source)).encode("utf-8"))
        finally:
            os._exit(0)
    os.close(writer)
    ended, said = wait_with_output(pid, reader, COMPILE_SECONDS, 4 << 20)
    kill_leftovers()
    if ended.killed:
        return False, "the syntax check ran over %d s\n" % COMPILE_SECONDS
    try:
        result = json.loads(said)
    except ValueError:
        # The parser itself died on this source (a crash, the memory cap): it does not compile.
        return False, "the syntax check failed (%s)\n" % ended.describe()
    if "error" in result:
        raise Failure("the syntax check could not start: %s" % result["error"])
    return bool(result.get("ok")), text_of(str(result.get("log", "")).encode("utf-8"), cap)


# ------------------------------------------------------------------ checking


def token_blocks(path):
    """The file's whitespace-separated tokens, a block at a time: 64 MB of "1 1 1" never becomes 30 million objects at once."""
    with open(path, "rb") as handle:
        carry = b""
        while True:
            block = handle.read(COPY_CHUNK)
            if not block:
                if carry:
                    yield [carry]
                return
            block = carry + block
            parts = block.split()
            carry = parts.pop() if parts and block[-1] not in WHITESPACE else b""
            if parts:
                yield parts


def line_blocks(path):
    """The file's lines without trailing whitespace, a block at a time; empty lines at its end are not lines."""
    with open(path, "rb") as handle:
        carry = b""
        empty = 0
        while True:
            block = handle.read(COPY_CHUNK)
            final = not block
            lines = (carry + block).split(b"\n")
            carry = b"" if final else lines.pop()
            ready = []
            for line in lines:
                line = line.rstrip(TRAILING)
                if not line:
                    empty += 1
                    continue
                while empty:
                    run = min(empty, 1 << 16)
                    ready.extend([b""] * run)
                    empty -= run
                    if len(ready) >= 1 << 16:
                        yield ready
                        ready = []
                ready.append(line)
            if ready:
                yield ready
            if final:
                return


class Stream:
    def __init__(self, blocks):
        self.blocks = blocks
        self.block = []
        self.at = 0
        self.over = False

    def left(self):
        while self.at >= len(self.block) and not self.over:
            nxt = next(self.blocks, None)
            if nxt is None:
                self.over = True
                self.block, self.at = [], 0
            else:
                self.block, self.at = nxt, 0
        return len(self.block) - self.at


def shorten(value):
    text = text_of(value, NOTE_CHARS * 4)
    return text if len(text) <= NOTE_CHARS else text[: NOTE_CHARS - 1] + "\u2026"


def note(code, n, expected=None, got=None):
    """The note is a code and its numbers, never words: the container does not know the instance's language."""
    params = {"n": n}
    if expected is not None:
        params["expected"] = shorten(expected)
    if got is not None:
        params["got"] = shorten(got)
    return {"code": code, "params": params}


def compare(kind, output, answer, same):
    """Item by item; equal stretches compared as whole lists (in C), the first difference found item by item."""
    out, ans = Stream(output), Stream(answer)
    index = 0
    while True:
        have, want = out.left(), ans.left()
        if not have and not want:
            return True, None
        if not want:
            return False, note(kind + ".long", index + 1, got=out.block[out.at])
        if not have:
            return False, note(kind + ".short", index + 1, expected=ans.block[ans.at])
        count = min(have, want)
        mine = out.block[out.at : out.at + count]
        theirs = ans.block[ans.at : ans.at + count]
        if mine != theirs:
            for offset in range(count):
                if not same(mine[offset], theirs[offset]):
                    return False, note(kind + ".differ", index + offset + 1, expected=theirs[offset], got=mine[offset])
        out.at += count
        ans.at += count
        index += count


def exact(got, expected):
    return got == expected


def near(epsilon):
    def same(got, expected):
        if got == expected:
            return True
        if not (NUMBER.match(got) and NUMBER.match(expected)):
            return False
        try:
            mine, theirs = float(got), float(expected)
        except (ValueError, OverflowError):
            return False
        if not (math.isfinite(mine) and math.isfinite(theirs)):
            return False
        # testlib's slack on top of the epsilon: 0.100001 against 0.1 at 1e-6 is a pass, not a rounding accident.
        return abs(mine - theirs) <= epsilon * max(1.0, abs(theirs)) + 1e-15

    return same


def check_builtin(kind, epsilon, answer):
    if kind == "lines":
        return compare("lines", line_blocks(OUT), line_blocks(answer), exact)
    same = near(epsilon) if kind == "float" else exact
    return compare(kind, token_blocks(OUT), token_blocks(answer), same)


# The descriptors the checker's process finds its four inputs and its result on.
CHECK_FDS = {"code": 3, "input": 4, "output": 5, "answer": 6, "result": 7}
CHECK_NAME = "checker.py"


def spawn_checker(argv, env, out_fd, passing):
    """Fork the checker's process: its inputs on fds 3..6, its result pipe on 7, as CHECKER_UID.

    The files are opened HERE, by root, and handed over as descriptors: the
    checker's uid can read exactly these four and nothing else of /secret. A
    failure before or at exec comes back as SpawnError, as in spawn().
    """
    reader, writer = os.pipe()
    pid = os.fork()
    if pid == 0:
        try:
            os.close(reader)
            os.setsid()
            # Everything that moves is lifted above the range it moves into
            # first, so no dup2 below overwrites a descriptor still to be moved.
            lifted = [fcntl.fcntl(fd, fcntl.F_DUPFD, 100) for fd in passing]
            out = fcntl.fcntl(out_fd, fcntl.F_DUPFD, 100)
            error = fcntl.fcntl(writer, fcntl.F_DUPFD_CLOEXEC, 200)
            quiet = os.open(os.devnull, os.O_RDONLY)
            os.dup2(quiet, 0)
            os.dup2(out, 1)
            os.dup2(out, 2)
            for index, fd in enumerate(lifted):
                os.dup2(fd, 3 + index)
            os.closerange(3 + len(lifted), error)
            os.closerange(error + 1, 1 << 16)
            set_limit(resource.RLIMIT_CORE, 0, 0)
            os.chdir(TMP)
            for number in (signal.SIGPIPE, signal.SIGXFSZ):
                signal.signal(number, signal.SIG_DFL)
            os.umask(0o077)
            if not NO_SANDBOX:
                os.setgroups([])
                os.setresgid(CHECKER_UID, CHECKER_UID, CHECKER_UID)
                os.setresuid(CHECKER_UID, CHECKER_UID, CHECKER_UID)
            os.execve(argv[0], argv, env)
        except BaseException as failure:
            try:
                os.write(writer, ("%s: %s" % (type(failure).__name__, failure)).encode("utf-8", "replace")[:2000])
            finally:
                os._exit(127)
    os.close(writer)
    reason = b""
    while True:
        block = os.read(reader, 4096)
        if not block:
            break
        reason += block
    os.close(reader)
    if reason:
        os.waitpid(pid, 0)
        raise SpawnError(reason.decode("utf-8", "replace"))
    return pid


def wait_checker(pid, out_fd, result_fd, seconds):
    """Wait for the checker at most 'seconds', draining what it prints and its result as they come.

    Both pipes are read while it runs: a verdict or a print over a pipe's
    buffer would otherwise stop it until the deadline.
    """
    deadline = time.monotonic() + seconds
    printed = bytearray()
    result = bytearray()
    open_fds = {out_fd: (printed, CAPTURE_BYTES), result_fd: (result, 4 << 20)}
    killed = None
    try:
        while open_fds:
            now = time.monotonic()
            if now >= deadline:
                killed = "wall"
                break
            ready = select.select(list(open_fds), [], [], deadline - now)[0]
            for fd in ready:
                block = os.read(fd, 65536)
                if not block:
                    del open_fds[fd]
                    continue
                kept, cap = open_fds[fd]
                if len(kept) < cap:
                    kept += block[: cap - len(kept)]
    finally:
        os.close(out_fd)
        os.close(result_fd)
    kill_group(pid)
    _, status, usage = os.wait4(pid, 0)
    return Exited(status, usage, killed), bytes(printed), bytes(result)


def check_custom(n, input_path, answer):
    """The teacher's check(input, output, answer), in a process of its own as CHECKER_UID, 10 s."""
    files = [os.open(path, os.O_RDONLY) for path in (CHECKER, input_path, OUT, answer)]
    result_read, result_write = os.pipe()
    out_read, out_write = os.pipe()
    argv = [sys.executable, "-I", HARNESS, "check"]
    try:
        pid = spawn_checker(argv, base_env(TMP), out_write, files + [result_write])
    except SpawnError as error:
        os.close(result_read)
        os.close(out_read)
        raise Failure("the checker could not be started: %s" % error)
    finally:
        for fd in files + [result_write, out_write]:
            os.close(fd)
    ended, printed, raw = wait_checker(pid, out_read, result_read, CHECKER_SECONDS)
    reap()
    said = text_of(printed, CAPTURE_BYTES).strip()
    tail = ("\n" + said) if said else ""
    if ended.killed:
        raise Failure("the checker ran over %d s on test %d%s" % (CHECKER_SECONDS, n, tail))
    try:
        result = json.loads(raw.decode("utf-8"))
    except (UnicodeDecodeError, ValueError):
        raise Failure("the checker ended without a verdict on test %d (%s)%s" % (n, ended.describe(), tail))
    if not isinstance(result, dict):
        raise Failure("the checker ended without a verdict on test %d (%s)%s" % (n, ended.describe(), tail))
    if "error" in result:
        raise Failure("the checker failed on test %d:\n%s" % (n, result["error"]))
    message = result.get("message")
    return result.get("ok") is True, (message[:MESSAGE_CHARS] if isinstance(message, str) and message else None)


def checker_main(args):
    """'judge.py check': the custom checker's own process, reading fds 3..6 and answering on fd 7."""

    def answer(result):
        write_all(CHECK_FDS["result"], json.dumps(result).encode("utf-8"))

    def read(fd):
        chunks = []
        while True:
            block = os.read(fd, 1 << 20)
            if not block:
                break
            chunks.append(block)
        return b"".join(chunks)

    try:
        code = compile(read(CHECK_FDS["code"]), CHECK_NAME, "exec", dont_inherit=True)
        space = {"__name__": "colloq_checker", "__file__": CHECK_NAME, "__builtins__": __builtins__}
        exec(code, space)
        check = space.get("check")
        if not callable(check):
            answer({"error": "the checker defines no check(input, output, answer)"})
            return
        decoded = [read(CHECK_FDS[name]).decode("utf-8", "replace") for name in ("input", "output", "answer")]
        value = check(*decoded)
    except BaseException as error:
        answer({"error": checker_traceback(error, CHECK_NAME)})
        return
    verdict = checker_verdict(value)
    if verdict is None:
        answer({"error": "check() returned %s; it must return a bool or (bool, str)" % type(value).__name__})
        return
    answer({"ok": verdict[0], "message": verdict[1]})


def checker_traceback(error, code_path):
    if isinstance(error, SyntaxError) and error.filename == code_path:
        return "".join(traceback.format_exception_only(type(error), error))[-DETAIL_CHARS:]
    # The first frame is checker_main, ours; the teacher reads from their own code down.
    frames = error.__traceback__.tb_next if error.__traceback__ is not None else None
    return "".join(traceback.format_exception(type(error), error, frames))[-DETAIL_CHARS:]


def checker_verdict(value):
    def boolean(item):
        # numpy's bool_ is what 'return np.allclose(...)' gives.
        return isinstance(item, bool) or type(item).__name__ == "bool_"

    if boolean(value):
        return bool(value), None
    if isinstance(value, (tuple, list)) and len(value) == 2 and boolean(value[0]) and (value[1] is None or isinstance(value[1], str)):
        return bool(value[0]), value[1]
    return None


# ------------------------------------------------------------------ running


def verdict_of(ended, job, out_size, err_size):
    """A test's verdict before any checker, or None — it ran clean and its output is to be checked.

    The order is the answer: time over memory over output over a crash. A
    program over its time and killed for it is TL whatever else it did; a
    SIGKILL nobody here sent is the cgroup's out-of-memory killer; Python
    turns SIGXFSZ into an exception and an exit, so the output's size decides
    OL as well as the signal does.
    """
    limit = job["timeLimitMs"]
    cap = job["outputCap"]
    if ended.killed is not None or ended.cpu_ms > limit or ended.signal == signal.SIGXCPU:
        return "TL"
    if ended.kb > job["memoryMb"] * 1024 or (ended.signal == signal.SIGKILL and ended.killed is None):
        return "ML"
    if ended.signal == signal.SIGXFSZ or out_size > cap or err_size > cap:
        return "OL"
    if ended.signal or ended.code != 0:
        return "RE"
    return None


def run_test(job, test, argv):
    n = test["n"]
    limit = job["timeLimitMs"]
    cap = job["outputCap"]
    input_path = os.path.join(TESTS, "%d.in" % n)
    try:
        given = os.open(input_path, os.O_RDONLY)
    except OSError as error:
        raise Failure("the input of test %d cannot be opened: %s" % (n, error.strerror))
    printed = os.open(OUT, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    complained = os.open(ERR, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    cpu = (limit + 999) // 1000 + 1
    stack = min(job["memoryMb"] << 20, STACK_CAP)
    limits = [
        (resource.RLIMIT_CPU, cpu, cpu + 1),
        (resource.RLIMIT_FSIZE, cap + 1, cap + 1),
        (resource.RLIMIT_STACK, stack, stack),
        (resource.RLIMIT_CORE, 0, 0),
        (resource.RLIMIT_NOFILE, PROGRAM_FILES, PROGRAM_FILES),
    ]
    started = time.monotonic()
    try:
        pid = spawn(argv, base_env(RUN), RUN, given, printed, complained, limits, nobody=True, oom=True)
    except SpawnError as error:
        raise Failure("the program could not be started on test %d: %s" % (n, error))
    finally:
        for fd in (given, printed, complained):
            os.close(fd)
    ended = wait_program(pid, limit, started)
    kill_leftovers()
    clean(scratch_places())
    return ended, input_path


def judge(job):
    emit({"t": "compile"})
    started = time.monotonic()
    make_dir(RUN, 0o777)
    if not NO_SANDBOX:
        # From here nobody may write into /work only through run/ (and build/
        # while compiling): nothing it leaves at the top would outlive a test.
        os.chmod(WORK, 0o755)
    ok, log, argv = compile_source(job)
    emit({"t": "compiled", "ok": ok, "log": log, "ms": int((time.monotonic() - started) * 1000)})
    if not ok:
        return
    mode = job["mode"]
    kind = job["checker"]["kind"]
    snip = job["snippetBytes"]
    failed_groups = set()
    for test in job["tests"]:
        n = test["n"]
        if mode == "ioi" and test["group"] in failed_groups:
            continue
        emit({"t": "start", "n": n})
        ended, input_path = run_test(job, test, argv)
        out_size, err_size = size_of(OUT), size_of(ERR)
        verdict = verdict_of(ended, job, out_size, err_size)
        line = {"t": "test", "n": n, "ms": ended.cpu_ms, "kb": ended.kb}
        if verdict is None and mode == "answers":
            verdict = "OK"
            stream_answer(n)
            line["bytes"] = out_size
        elif verdict is None:
            emit({"t": "check", "n": n})
            answer = os.path.join(ANSWERS, str(n))
            if kind == "custom":
                passed, said = check_custom(n, input_path, answer)
            else:
                epsilon = job["checker"]["epsilon"]
                passed, said = isolated(lambda: check_builtin(kind, epsilon, answer))
            verdict = "OK" if passed else "WA"
            if said:
                line["note"] = said
        line["v"] = verdict
        if ended.signal or ended.code != 0:
            line["exit"] = ended.describe()
        if verdict != "OK" or (test["sample"] and mode != "answers"):
            if mode != "answers":
                out = snippet(OUT, snip)
                if out:
                    line["out"] = out
            err = snippet(ERR, snip)
            if err:
                line["err"] = err
        emit(line)
        if verdict != "OK":
            if mode == "icpc":
                return
            if mode == "ioi":
                failed_groups.add(test["group"])


def stream_answer(n):
    with open(OUT, "rb") as handle:
        while True:
            block = handle.read(ANSWER_CHUNK)
            if not block:
                return
            emit({"t": "answer", "n": n, "b64": base64.b64encode(block).decode("ascii")})


def main():
    if sys.argv[1:2] == ["check"]:
        checker_main(sys.argv[2:])
        return
    try:
        if NO_SANDBOX and os.geteuid() == 0:
            raise Failure("the no-sandbox mode is for the test suite and refuses to run as root")
        if not NO_SANDBOX and os.geteuid() != 0:
            raise Failure("the judge must start as root (docker run --user 0:0)")
        os.umask(0o022)
        judge(read_job())
    except Failure as failure:
        emit({"t": "done", "se": failure.detail})
        return
    except BaseException:
        emit({"t": "done", "se": "the judge failed:\n" + traceback.format_exc()[-DETAIL_CHARS:]})
        return
    emit({"t": "done"})


if __name__ == "__main__":
    main()
`

/**
 * The harness version is the hash of its content, not a number kept by hand.
 *
 * A hand-set version is forgotten in exactly the case it exists for: a one-line
 * fix rolled out onto a machine where the old harness directory already lies.
 * A hash is not forgotten (competitions/harness.ts · HARNESS_REVISION).
 */
export const JUDGE_REVISION = createHash('sha256').update(JUDGE_SOURCE).digest('hex').slice(0, 12)

/** What the container calls the harness, under `/judge`. */
export const JUDGE_FILE = 'judge.py'

let materialized: string | null = null

/**
 * Lay the harness out on disk and return the directory mounted at `/judge:ro`.
 *
 * `<DATA_DIR>/contests/.judge/<hash>/judge.py`, the file 0644 and the directory
 * 0755 so that the container's root — and the `nobody` the compiler and the
 * program run as — can read it. The leading dot keeps it clear of any contest
 * id and so out of the way of any cleanup that sweeps the contests' root.
 * Idempotent and computed once per process: the content never changes between
 * submissions, and a rewrite would be a write into a directory already mounted
 * into a neighbour's running container.
 */
export function judgeDir(): string {
  if (materialized) return materialized
  const dir = path.join(contestsDir, '.judge', JUDGE_REVISION)
  contestsFs.mkdirSync(dir, { recursive: true })
  contestsFs.chmodSync(dir, 0o755)
  const file = path.join(dir, JUDGE_FILE)
  // In a directory named by the content's hash the file is either already
  // there with this very content or not there at all, so it is never rewritten.
  if (!contestsFs.existsSync(file)) {
    // Written beside its target and renamed over it: a neighbour mounting this
    // directory never sees a half-written harness (competitions/harness.ts).
    const temporary = path.join(dir, `.${JUDGE_FILE}-${JUDGE_REVISION}.tmp`)
    contestsFs.writeFileSync(temporary, Buffer.from(JUDGE_SOURCE, 'utf8'), { mode: 0o644 })
    contestsFs.renameSync(temporary, file)
    contestsFs.chmodSync(file, 0o644)
  }
  materialized = dir
  return dir
}

/** Forget what was laid out — for tests that move DATA_DIR under the module's feet. */
export function forgetJudgeHarness(): void {
  materialized = null
}
