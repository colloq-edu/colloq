import { createHash } from 'node:crypto'
import { tr } from '@shared/i18n'

/**
 * Dangerous commands in a cell: a speed bump for the whole room.
 *
 * THIS IS NOT A SANDBOX, and that has to be said first. `ctypes.string_at(0)`,
 * reloading the `os` module through importlib, a fork bomb, a segfault in a
 * native library, `globals().clear()` and the room's terminal all get past
 * everything written here. Exactly one class of trouble is closed: "one line
 * known from the internet, typed out of curiosity, and the whole class has
 * lost everything". Intent is not stopped by this, and no attempt is made.
 *
 * The trouble is measured. 20 Sep 2026, a class of thirty: a student wrote two
 * lines in a council attempt, `import os` and `os._exit(0)`. The teacher, going
 * through the work and pressing "run", brought the room's kernel down nine
 * times in eleven minutes: `os._exit` ends the process WITHOUT an exception,
 * without a signal in dmesg, without a counter in the cgroup and without a
 * single line in the journal. Jupyter brought the kernel back up, thirty
 * people lost their variables and the queue, and nobody, the teacher included,
 * saw the cause.
 *
 * That day it was closed inside the council attempt (`council-isolation.ts`),
 * while in an ORDINARY cell `exit()` and `os._exit()` still took the kernel
 * down for everyone. Now there is one guard for both places, and it lives
 * here; the council reuses it instead of starting a second one
 * (`hold`/`release` below).
 *
 * Two layers, both under one room rule (`shared/rules.ts` · `danger`):
 *
 *   1. IN-PROCESS PATCHES, reliable because there is no getting past them
 *      without writing the same thing in other words: `shell.ask_exit` (that
 *      is `exit()` and `quit()`), `os._exit`, `os.abort`, `os.kill`,
 *      `os.killpg`, `signal.raise_signal`, `signal.pthread_kill`,
 *      `kernel.do_shutdown`. Signals are closed ONLY when the target is the
 *      kernel itself, its parent, pid 1, its own group or "everyone" (`0`,
 *      `-1`), and the signal is deadly: killing other children is allowed,
 *      otherwise `multiprocessing`, joblib and `subprocess` break.
 *      `sys.exit()` is not touched at all: in ipykernel it is `SystemExit`,
 *      and the kernel survives it.
 *
 *   2. SHELL COMMANDS AND MAGICS, by the command text at run time, not by
 *      parsing Python: `!cmd` (`shell.system`, `shell.getoutput`),
 *      `%%bash`/`%%sh`/`%%script`, `os.system`, `os.popen`, `subprocess`. The
 *      boundary is narrow on purpose: `git`, `pip`, `ls`, `kill` of your own
 *      background process work, while `kill -9 -1`, `pkill python`,
 *      `shutdown`, `reboot`, `init 0` and `rm -rf` of the class root do not.
 *      The same goes for `%reset`, `%reset -f`, `%reset_selective` and
 *      `%xdel`: in a shared notebook they erase the variables of the whole
 *      class.
 *
 * The role makes no difference. The rule applies to the teacher too: there is
 * one kernel, and `os._exit(0)` from their cell costs the class exactly as
 * much. They do have a way to restart the kernel: the Restart button, which
 * goes around the kernel, through Jupyter.
 *
 * A pure module: the Python source, building and parsing the report, no
 * network, no Yjs, for the sake of the test that runs this same source with a
 * real python3 (the same trick as in council-isolation.ts).
 */

/** The hidden module the guard lives in. Not a name in the student's `globals()`. */
export const GUARD_MODULE = '_colloq_guard'

/**
 * The name of the exception the guard refuses with.
 *
 * One for the global guard and for the council isolation: the server
 * recognises its own refusal by it and prints ONE human line without a
 * traceback; the `<colloq-guard>` frames are not student code, and there is
 * nothing there for the student to read.
 */
export const COLLOQ_REFUSED = 'ColloqRefused'

/** The key the report travels under in the kernel reply's `user_expressions`. */
export const GUARD_REPORT_KEY = 'colloq'

/** The expression the server uses to ask the kernel whether the guard is up. */
export const GUARD_REPORT_EXPR = `__import__('sys').modules['${GUARD_MODULE}'].report`

export interface GuardReport {
  ok: boolean
  /** Whether the functions are patched right now (the rule or a council hold). */
  on: boolean
  /** What exactly was said about the room RULE; this is what the server checks. */
  policy: boolean
  /** How many council attempts hold the guard on top of the rule. */
  holds: number
  /** Names of the patched attributes, for the journal and the test. */
  patched: string[]
  error: string | null
}

/**
 * The implementation, as one chunk of Python that runs NOT in the student's
 * namespace.
 *
 * Everything declared below lands in the hidden module's `__dict__`: the
 * install cell binds not a single name in `globals()`, otherwise the guard
 * itself would leave `os`, `sys` and its own variables in the notebook.
 *
 * There is not a single regular expression here, and that is not a matter of
 * taste: the source lives in a TypeScript template string, where every `\\` is
 * an escape, and `re.compile('\\|\\|')` would silently turn into
 * `re.compile('||')`. Command parsing gets by with `str.split`.
 */
const IMPL = `
import json
import os
import sys


class ColloqRefused(Exception):
    """The cell asked for something the room has only one of, shared by all.

    The name is visible to the student, so it is short and our own: the server
    recognises its own refusal by it and prints one human line without a
    traceback (kernel/index.ts · runOne and runCouncilOne), just as with a stop
    at the limit.
    """


class _Report(object):
    """A report for the server: its repr is ready-made JSON.

    user_expressions returns a mimebundle, and its text/plain is the repr() of
    the value. A string cannot be handed over: its repr would arrive in quotes
    and escaped, i.e. JSON inside JSON.
    """
    __slots__ = ('text',)

    def __init__(self, text):
        self.text = text

    def __repr__(self):
        return self.text


# A snapshot of the builtins, taken AT INSTALL time while they are still
# intact: a cell may write builtins.getattr = None, and removing the guard
# would then fail on its first line.
_getattr = getattr
_setattr = setattr
_delattr = delattr
_MISS = object()

# Signals that have no meaning other than "end the process now" or "freeze it
# forever". SIGINT is NOT among them: it is what stops a cell.
_DEADLY_NAMES = (
    'SIGKILL', 'SIGTERM', 'SIGABRT', 'SIGQUIT', 'SIGSEGV', 'SIGHUP',
    'SIGBUS', 'SIGILL', 'SIGFPE', 'SIGSYS', 'SIGTRAP', 'SIGSTOP', 'SIGTSTP',
)

# Commands whose target is the whole machine.
_STOP_CMDS = frozenset(('shutdown', 'reboot', 'halt', 'poweroff'))

# Words by which pkill and killall find the kernel itself.
_SELF_WORDS = (
    'python', 'ipython', 'ipykernel', 'jupyter', 'kernel',
)

# pkill patterns that mean "everything there is".
_ALL_PATTERNS = frozenset(('.', '.*', '^.*', '^.*$', '*', '-1'))

# pkill and killall flags followed by a value, not a pattern.
_PATTERN_FLAGS = frozenset((
    '-u', '-U', '-g', '-G', '-P', '-s', '-t', '-n', '-o',
    '--user', '--group', '--parent', '--signal', '--session',
))

# Magics that erase the variables of the WHOLE room in one line.
_WIPE_MAGICS = frozenset(('reset', 'reset_selective', 'xdel'))

# Cell magics whose body is a shell command, not Python.
_SCRIPT_MAGICS = frozenset(('bash', 'sh', 'script', 'zsh', 'ksh', 'cmd', 'powershell'))

# Words that stand IN FRONT of the real command and say nothing about it.
_PREFIX_CMDS = frozenset((
    'sudo', 'doas', 'env', 'nohup', 'exec', 'time', 'command', 'setsid', 'stdbuf',
))

# Command separators in a shell line. Order matters: doubled ones first.
_SEPARATORS = ('||', '&&', ';', '|', '&', '\\n')


def _shell():
    """IPython's shell when inside a kernel; plain python has none, which is fine."""
    mod = sys.modules.get('IPython')
    if mod is None:
        return None
    try:
        return mod.get_ipython()
    except Exception:
        return None


def _state():
    return saved or {}


def _mine():
    return _state().get('pid', -1)


def _in_child():
    """A child after fork(): there the real functions are the right behaviour.

    multiprocessing and joblib end a child process precisely with os._exit, and
    refusing in the child would let a copy of the cell run on as a second
    kernel, a bigger trouble than the one we guard against.
    """
    try:
        return os.getpid() != _mine()
    except Exception:
        return False


def _texts():
    # While a council attempt holds the guard, we speak in ITS words: there is
    # nothing to advise about the room rule, since inside an attempt the ban is
    # unconditional.
    return held if held is not None else texts


def _say(what, why):
    words = _texts() or {}
    out = [(words.get('lead') or '{p0}').replace('{p0}', what)]
    reason = words.get(why)
    if reason:
        out.append(reason)
    tail = words.get('tail')
    if tail:
        out.append(tail)
    return ' '.join(out)


def _refuse(what, why='kernel'):
    raise ColloqRefused(_say(what, why))


def _deadly():
    sig = sys.modules.get('signal')
    if sig is None:
        try:
            import signal as sig
        except Exception:
            return frozenset()
    out = set()
    for name in _DEADLY_NAMES:
        value = _getattr(sig, name, None)
        if value is None:
            continue
        try:
            out.add(int(value))
        except Exception:
            pass
    return frozenset(out)


def _fatal_target(pid):
    """The signal's target is the kernel, its parent, pid 1, its group or "everyone".

    Someone else's child deliberately does not get here: subprocess and joblib
    manage those, and a refusal there would break more than it closed.
    """
    try:
        pid = int(pid)
    except Exception:
        return False
    mine = _mine()
    # 0 is our own process group, -1 is all of the user's processes.
    if pid in (0, 1, -1) or pid == mine:
        return True
    try:
        if pid == os.getppid():
            return True
    except Exception:
        pass
    if pid < 0:
        if -pid in (1,) or -pid == mine:
            return True
        try:
            return -pid == os.getpgid(0)
        except Exception:
            return False
    return False


def _fatal_group(pgid):
    try:
        pgid = int(pgid)
    except Exception:
        return False
    if pgid in (0, 1):
        return True
    try:
        return pgid == os.getpgid(0)
    except Exception:
        return False


# ------------------------------------------------- parsing shell commands


def _is_assign(word):
    """VAR=value before a command is environment, not a command."""
    head = word.split('=', 1)[0]
    if not head or head == word:
        return False
    if head[0].isdigit():
        return False
    return head.replace('_', 'a').isalnum()


def _words(piece):
    try:
        import shlex
        return shlex.split(piece, posix=True)
    except Exception:
        # An unclosed quote, strange unicode: parse roughly. Something dangerous
        # can get through here: this is a speed bump, not a sandbox.
        try:
            return piece.split()
        except Exception:
            return []


def _head(words):
    i = 0
    while i < len(words):
        word = words[i]
        if _is_assign(word) or word in _PREFIX_CMDS:
            i += 1
            continue
        break
    return words[i:]


def _pieces(text):
    out = [text]
    for sep in _SEPARATORS:
        nxt = []
        for part in out:
            nxt.extend(part.split(sep))
        out = nxt
    return out


def _roots():
    """Directories whose wholesale removal is exactly "everyone lost everything"."""
    out = set(('/', '/workspace'))
    here = _state().get('root')
    try:
        home = os.path.expanduser('~')
    except Exception:
        home = None
    for path in (here, home):
        if not path:
            continue
        try:
            out.add(path.rstrip('/') or '/')
        except Exception:
            pass
    return out


def _resolve(arg):
    raw = arg
    # rm -rf /* and rm -rf * remove the same directory, just with an asterisk.
    if raw.endswith('/*'):
        raw = raw[:-2] or '/'
    elif raw in ('*', './*'):
        raw = '.'
    try:
        path = os.path.abspath(os.path.expanduser(os.path.expandvars(raw)))
    except Exception:
        return None
    return path.rstrip('/') or '/'


def _rm_target(args):
    """What \`rm\` removes, if that is the class or machine root; otherwise None.

    Without -r there is no recursion, and so no trouble: \`rm -f /\` does nothing.
    """
    recursive = False
    targets = []
    for arg in args:
        if arg.startswith('--'):
            if arg == '--recursive':
                recursive = True
            continue
        if arg.startswith('-') and len(arg) > 1:
            if 'r' in arg[1:] or 'R' in arg[1:]:
                recursive = True
            continue
        targets.append(arg)
    if not recursive:
        return None
    roots = _roots()
    for arg in targets:
        path = _resolve(arg)
        if path is not None and path in roots:
            return arg
    return None


def _kill_target(args):
    """Whom to kill: the first signal spec is swallowed as a spec."""
    signature = True
    for arg in args:
        if signature and arg.startswith('-'):
            signature = False
            continue
        signature = False
        if arg.startswith('-') and not arg[1:].isdigit():
            continue
        # $PPID for a \`!kill\` command is the kernel process itself: it started
        # the shell. There is no number here, but the target is known.
        if arg in ('$PPID',):
            return arg
        if _fatal_target(arg):
            return arg
    return None


def _pattern_target(args):
    skip = False
    for arg in args:
        if skip:
            skip = False
            continue
        if arg.startswith('-'):
            if arg in _PATTERN_FLAGS:
                skip = True
            continue
        low = arg.lower()
        if low in _ALL_PATTERNS:
            return arg
        for word in _SELF_WORDS:
            if word in low:
                return arg
    return None


def _bad_words(words):
    """The first dangerous command in a parsed line, or None."""
    words = _head(words)
    if not words:
        return None
    try:
        name = os.path.basename(words[0]).lower()
    except Exception:
        return None
    args = words[1:]
    if name in _STOP_CMDS:
        return (name, 'kernel')
    if name in ('init', 'telinit'):
        for arg in args:
            if arg in ('0', '6'):
                return (name + ' ' + arg, 'kernel')
        return None
    if name == 'systemctl':
        for arg in args:
            if arg in ('poweroff', 'reboot', 'halt', 'kexec'):
                return ('systemctl ' + arg, 'kernel')
        return None
    if name == 'kill':
        target = _kill_target(args)
        if target is not None:
            return ('kill ' + target, 'kernel')
        return None
    if name in ('pkill', 'killall'):
        target = _pattern_target(args)
        if target is not None:
            return (name + ' ' + target, 'kernel')
        return None
    if name == 'rm':
        target = _rm_target(args)
        if target is not None:
            return ('rm -r ' + target, 'files')
        return None
    return None


def _check_text(text):
    if not text:
        return
    try:
        pieces = _pieces(text)
    except Exception:
        return
    for piece in pieces:
        piece = piece.strip()
        if not piece:
            continue
        try:
            bad = _bad_words(_words(piece))
        except ColloqRefused:
            raise
        except Exception:
            bad = None
        if bad is not None:
            _refuse(bad[0], bad[1])


def _as_text(value):
    if isinstance(value, str):
        return value
    if isinstance(value, (bytes, bytearray)):
        try:
            return value.decode('utf-8', 'replace')
        except Exception:
            return ''
    try:
        return os.fspath(value)
    except Exception:
        return ''


def _check_argv(args, shell_mode):
    if isinstance(args, (str, bytes, bytearray)):
        _check_text(_as_text(args))
        return
    try:
        words = [_as_text(item) for item in args]
    except Exception:
        return
    if not words:
        return
    if shell_mode:
        # shell=True with a list: the shell gets the first element, the rest go
        # into its $0, $1, so the command is exactly that element.
        _check_text(words[0])
        return
    bad = _bad_words(words)
    if bad is not None:
        _refuse(bad[0], bad[1])


# --------------------------------------------------------------- patches


def _patch(store, obj, name, make):
    real = _getattr(obj, name, _MISS)
    if real is _MISS:
        return
    try:
        own = name in vars(obj)
    except Exception:
        own = True
    try:
        _setattr(obj, name, make(real))
    except Exception:
        return
    store.append((obj, name, real, own))


def _unpatch(store):
    for obj, name, real, own in reversed(store):
        try:
            if own:
                _setattr(obj, name, real)
            else:
                # The class method comes back by itself once our patch is gone.
                _delattr(obj, name)
        except Exception:
            try:
                _setattr(obj, name, real)
            except Exception:
                pass


def _guard_exit(store):
    """exit() and quit() in a cell take down the kernel for the WHOLE room.

    In ipykernel exit and quit are one ZMQExitAutocall object; calling it (and
    even a bare exit on a line: IPython adds the parentheses itself) goes to
    shell.ask_exit(), which sets exit_now, and the process ends.

    It is ask_exit that gets patched, not the names exit/quit: IPython turns a
    bare exit on a line into a call only because ITS autocall object lies
    there. Had we replaced the name with an ordinary function, we would have
    closed exit() with parentheses and opened exit without them; checked on a
    live kernel, that is exactly what happened.
    """
    shell = _shell()
    if shell is None:
        return

    def ask(real):
        def refuse(*args, **kwargs):
            if _in_child():
                return real(*args, **kwargs)
            _refuse('exit()')
        return refuse

    _patch(store, shell, 'ask_exit', ask)

    kernel = _getattr(shell, 'kernel', None)
    if kernel is None:
        return

    def shutdown(real):
        def refuse(*args, **kwargs):
            # A real shutdown_request comes from ipykernel itself and must not
            # be touched: Jupyter clients use it. We tell them apart by the
            # IMMEDIATE caller: for cell code that is __main__.
            try:
                who = sys._getframe(1).f_globals.get('__name__') or ''
            except Exception:
                who = ''
            if _in_child() or who.startswith('ipykernel'):
                return real(*args, **kwargs)
            _refuse('kernel.do_shutdown()')
        return refuse

    _patch(store, kernel, 'do_shutdown', shutdown)


def _guard_process_exit(store):
    """os._exit() and os.abort() end the process silently: no word, no trace.

    No traceback, no stack, no signal in dmesg, no oom_kill counter in the
    cgroup. Exactly this made a class of thirty lose its kernel nine times in
    eleven minutes on 20 Sep 2026.
    """
    for name in ('_exit', 'abort'):
        def make(real, _name=name):
            def refuse(*args, **kwargs):
                if _in_child():
                    return real(*args, **kwargs)
                _refuse('os.' + _name + '()')
            return refuse
        _patch(store, os, name, make)


def _guard_signals(store, deadly):
    """A deadly signal INTO THE KERNEL ITSELF, and only that.

    os.kill stays a working tool: child processes are managed with it, and
    joblib, multiprocessing and subprocess cannot live without it. Exactly one
    pair is closed: "the target is us" and "the signal is deadly".
    """
    def kill(real):
        def refuse(pid, sig, *rest, **kwargs):
            if not _in_child():
                try:
                    number = int(sig)
                except Exception:
                    number = None
                if number in deadly and _fatal_target(pid):
                    _refuse('os.kill()')
            return real(pid, sig, *rest, **kwargs)
        return refuse

    _patch(store, os, 'kill', kill)

    def killpg(real):
        def refuse(pgid, sig, *rest, **kwargs):
            if not _in_child():
                try:
                    number = int(sig)
                except Exception:
                    number = None
                if number in deadly and _fatal_group(pgid):
                    _refuse('os.killpg()')
            return real(pgid, sig, *rest, **kwargs)
        return refuse

    _patch(store, os, 'killpg', killpg)

    sig = sys.modules.get('signal')
    if sig is None:
        try:
            import signal as sig
        except Exception:
            return

    def raise_signal(real):
        def refuse(number, *rest, **kwargs):
            if not _in_child():
                try:
                    value = int(number)
                except Exception:
                    value = None
                if value in deadly:
                    _refuse('signal.raise_signal()')
            return real(number, *rest, **kwargs)
        return refuse

    _patch(store, sig, 'raise_signal', raise_signal)

    def pthread_kill(real):
        def refuse(thread, number, *rest, **kwargs):
            # A deadly signal to ANY thread ends the whole process: threads
            # share the handler table.
            if not _in_child():
                try:
                    value = int(number)
                except Exception:
                    value = None
                if value in deadly:
                    _refuse('signal.pthread_kill()')
            return real(thread, number, *rest, **kwargs)
        return refuse

    _patch(store, sig, 'pthread_kill', pthread_kill)


def _guard_os_commands(store):
    for name in ('system', 'popen'):
        def make(real, _name=name):
            def refuse(command, *rest, **kwargs):
                if not _in_child():
                    _check_text(_as_text(command))
                return real(command, *rest, **kwargs)
            return refuse
        _patch(store, os, name, make)


def _guard_subprocess(store):
    sub = sys.modules.get('subprocess')
    if sub is None:
        try:
            import subprocess as sub
        except Exception:
            return
    real = _getattr(sub, 'Popen', None)
    if real is None:
        return

    class _GuardedPopen(real):
        """A subclass, not a function: isinstance and inheritance must still work.

        joblib and multiprocessing on Linux never come here at all (they call
        _posixsubprocess.fork_exec directly), so this patch stands in the way
        only of someone who wrote subprocess code themselves.
        """

        def __init__(self, args, *rest, **kwargs):
            if not _in_child():
                shell_mode = kwargs.get('shell', False)
                # shell is the ninth positional; it is almost never passed that
                # way, but since it was, we read it from there.
                if len(rest) >= 8:
                    shell_mode = rest[7]
                _check_argv(args, shell_mode)
            real.__init__(self, args, *rest, **kwargs)

    try:
        _GuardedPopen.__name__ = real.__name__
        _GuardedPopen.__qualname__ = real.__qualname__
        _GuardedPopen.__module__ = real.__module__
    except Exception:
        pass
    try:
        _setattr(sub, 'Popen', _GuardedPopen)
    except Exception:
        return
    store.append((sub, 'Popen', real, True))


def _guard_shell_commands(store):
    shell = _shell()
    if shell is None:
        return

    def make(real):
        def refuse(command, *rest, **kwargs):
            if not _in_child():
                _check_text(_as_text(command))
            return real(command, *rest, **kwargs)
        return refuse

    # system is !cmd; getoutput is !!cmd, %sx and var = !cmd. The other two
    # names are patched for the case when a magic calls them bypassing
    # self.system.
    for name in ('system', 'system_raw', 'system_piped', 'getoutput'):
        _patch(store, shell, name, make)


def _guard_magics(store):
    shell = _shell()
    if shell is None:
        return

    def line(real):
        def refuse(*args, **kwargs):
            name = args[0] if args else kwargs.get('magic_name')
            if not _in_child() and name in _WIPE_MAGICS:
                _refuse('%' + str(name), 'wipe')
            return real(*args, **kwargs)
        return refuse

    _patch(store, shell, 'run_line_magic', line)

    def cellmagic(real):
        def refuse(*args, **kwargs):
            name = args[0] if args else kwargs.get('magic_name')
            if not _in_child():
                if name in _WIPE_MAGICS:
                    _refuse('%%' + str(name), 'wipe')
                if name in _SCRIPT_MAGICS:
                    head = args[1] if len(args) > 1 else kwargs.get('line', '')
                    body = args[2] if len(args) > 2 else kwargs.get('cell', '')
                    _check_text(_as_text(head) + '\\n' + _as_text(body))
            return real(*args, **kwargs)
        return refuse

    _patch(store, shell, 'run_cell_magic', cellmagic)


# ------------------------------------------------------ install and removal


def _install():
    global saved
    try:
        mine = os.getpid()
    except Exception:
        mine = -1
    store = []
    current = {'pid': mine, 'store': store, 'root': None, 'version': version}
    try:
        current['root'] = os.getcwd()
    except Exception:
        pass
    # Set BEFORE the patches: the patches themselves ask it for the pid and the
    # root.
    saved = current
    deadly = _deadly()
    for step in (
        lambda: _guard_exit(store),
        lambda: _guard_process_exit(store),
        lambda: _guard_signals(store, deadly),
        lambda: _guard_os_commands(store),
        lambda: _guard_subprocess(store),
        lambda: _guard_shell_commands(store),
        lambda: _guard_magics(store),
    ):
        try:
            step()
        except Exception:
            # One patch that did not go in is no reason to go without the others.
            pass


def _remove():
    global saved
    current = saved
    saved = None
    if not current:
        return
    _unpatch(current.get('store') or [])


def _recompute():
    want = bool(policy) or holds > 0
    if want:
        if saved is None:
            _install()
        elif _state().get('version') != version:
            # The server was redeployed while the kernel lived: the old patches
            # are removed by their own records, and the new ones come from the
            # fresh code.
            _remove()
            _install()
        return
    if saved is not None:
        _remove()


def _names():
    return [name for _, name, _, _ in (_state().get('store') or [])]


def _tell():
    global report
    try:
        report = _Report(json.dumps({
            'ok': True,
            'on': saved is not None,
            'policy': bool(policy),
            'holds': holds,
            'patched': _names(),
        }, separators=(',', ':')))
    except Exception:
        report = None


def apply(on, settings=None):
    """The room rule: whether to execute dangerous commands.

    The report is set ALWAYS, including on our own error: the server reads it
    as the only confirmation and must treat silence as a refusal.
    """
    global policy, texts, report
    try:
        if settings:
            texts = settings
        policy = bool(on)
        _recompute()
        _tell()
    except Exception as err:
        try:
            report = _Report(json.dumps({
                'ok': False,
                'on': saved is not None,
                'policy': bool(policy),
                'holds': holds,
                'patched': [],
                'error': type(err).__name__ + ': ' + str(err),
            }, separators=(',', ':')))
        except Exception:
            report = None


def hold(settings=None):
    """A council attempt: the guard is on, whatever the rule says.

    A student's attempt runs on the SHARED kernel, and it must not be able to
    bring the class down even when the teacher has allowed dangerous commands
    for a demonstration. A counter, not a flag: the rule may be changed in the
    middle of an attempt, and both answers have to add up, not argue.
    """
    global holds, held
    if settings:
        held = settings
    holds += 1
    _recompute()
    _tell()
    return True


def release():
    """The attempt is over: go back to what the room rule says."""
    global holds, held
    if holds > 0:
        holds -= 1
    if holds <= 0:
        holds = 0
        held = None
    _recompute()
    _tell()


globals().setdefault('texts', {})
globals().setdefault('held', None)
globals().setdefault('holds', 0)
globals().setdefault('saved', None)
globals().setdefault('report', None)
# The default is strict: a kernel the server has told nothing yet is guarded.
# The only possible mistake here is "refused too much", and that is cheaper.
globals().setdefault('policy', True)
# As the last line, and this matters: by it the install knows it got to the END.
version = '__VERSION__'
`

/** The install version: a short hash of the source itself, computed once. */
let stamp: string | null = null
function implVersion(): string {
  return (stamp ??= createHash('sha1').update(IMPL).digest('hex').slice(0, 12))
}

/** The source with the version filled in, already escaped into a Python literal. */
let literal: string | null = null
function implLiteral(): string {
  return (literal ??= JSON.stringify(IMPL.replace('__VERSION__', implVersion())))
}

const MODULE = JSON.stringify(GUARD_MODULE)

/**
 * The install line: exactly one, and everyone who needs the guard puts it
 * first.
 *
 * The install runs only when the module is not there yet or is a different
 * one: the source is twenty kilobytes, and `compile` would cost every cell
 * half a millisecond, while between cells it never changes. The version check
 * stays honest: a different server build means a different hash, and a live
 * kernel gets the new code without a restart.
 */
export function guardInstallLine(): string {
  return (
    `if getattr(__import__('sys').modules.get(${MODULE}), 'version', None) != ` +
    `${JSON.stringify(implVersion())}: ` +
    `exec(compile(${implLiteral()}, '<colloq-guard>', 'exec'), ` +
    `__import__('sys').modules.setdefault(${MODULE}, ` +
    `__import__('types').ModuleType(${MODULE})).__dict__)`
  )
}

/**
 * Refusal texts: as a literal in the call itself, not inside the source.
 *
 * The room language gets changed in the panel in the middle of class: had we
 * baked the translation into the source, the live kernel would hold
 * yesterday's (or we would reinstall the module on every language change). The
 * tail differs: in a room it says who can allow this, while in a council
 * attempt nothing can allow it, and promising otherwise would be dishonest.
 */
function settingsLiteral(tail: string): string {
  return [
    `{'lead': ${JSON.stringify(tr('server.guard.lead'))}`,
    `'kernel': ${JSON.stringify(tr('server.guard.whyKernel'))}`,
    `'wipe': ${JSON.stringify(tr('server.guard.whyWipe'))}`,
    `'files': ${JSON.stringify(tr('server.guard.whyFiles'))}`,
    `'tail': ${JSON.stringify(tail)}}`,
  ].join(', ')
}

/** Settings for a room: the tail points to the "Dangerous commands" rule. */
export function guardRoomSettings(): string {
  return settingsLiteral(tr('server.guard.allow'))
}

/** Settings for a council attempt: nobody can allow this. */
export function guardCouncilSettings(): string {
  return settingsLiteral(tr('server.guard.inCouncil'))
}

/**
 * The cell with which the server tells the kernel the room rule.
 *
 * The whole line serves as the fingerprint: it holds both the rule and the
 * refusal language, so comparing it with the last line said catches both a
 * rule change in the middle of class and a change of the instance language,
 * without an extra trip to the kernel for every cell.
 */
export function guardPolicySource(block: boolean): string {
  return [
    guardInstallLine(),
    `__import__('sys').modules[${MODULE}].apply(` +
      `${block ? 'True' : 'False'}, ${guardRoomSettings()})`,
  ].join('\n')
}

/** The hold expression: the council isolation's entry calls it. */
export function guardHoldExpr(): string {
  return `__import__('sys').modules[${MODULE}].hold(${guardCouncilSettings()})`
}

/** The release expression: the council isolation's exit calls it. */
export const GUARD_RELEASE_EXPR = `__import__('sys').modules[${MODULE}].release()`

/**
 * Parse the kernel's answer into a report; `null` means there was no
 * confirmation.
 *
 * Accepts both what arrives in `user_expressions` (`{status, data}` with
 * `text/plain` inside) and a bare JSON string; the latter for the test that
 * runs the same sources with a real python3 and reads the report from stdout.
 */
export function parseGuardReport(raw: unknown): GuardReport | null {
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
  const row = parsed as Record<string, unknown>
  if (typeof row.ok !== 'boolean') return null
  return {
    ok: row.ok,
    on: row.on === true,
    policy: row.policy === true,
    holds: typeof row.holds === 'number' ? row.holds : 0,
    patched: Array.isArray(row.patched) ? row.patched.filter((x): x is string => typeof x === 'string') : [],
    error: typeof row.error === 'string' ? row.error : null,
  }
}
