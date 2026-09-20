import { createHash } from 'node:crypto'
import { tr } from '@shared/i18n'

/**
 * Опасные команды в ячейке — лежачий полицейский на всю комнату.
 *
 * ЭТО НЕ ПЕСОЧНИЦА, и сказать это надо первым делом. `ctypes.string_at(0)`,
 * перезагрузка модуля `os` через importlib, fork-бомба, segfault нативной
 * библиотеки, `globals().clear()` и терминал комнаты проходят мимо всего, что
 * здесь написано. Закрыт ровно один класс бед: «одна строка, известная из
 * интернета, набранная из любопытства, — и у всего класса всё пропало».
 * Умысел этим не останавливают и не пытаются.
 *
 * Беда измеренная. 20.09.2026, занятие на тридцать человек: студент написал в
 * попытке консилиума две строки — `import os` и `os._exit(0)`. Преподаватель,
 * перебирая работы и нажимая «запустить», девять раз за одиннадцать минут
 * уронил ядро комнаты: `os._exit` кончает процесс БЕЗ исключения, без сигнала
 * в dmesg, без счётчика в cgroup и без единой строки в журнале. Jupyter
 * поднимал ядро заново, тридцать человек теряли переменные и очередь, и никто,
 * включая преподавателя, не видел причины.
 *
 * В тот день это закрыли внутри попытки консилиума (`council-isolation.ts`), а
 * в ОБЫЧНОЙ ячейке `exit()` и `os._exit()` по-прежнему гасили ядро всем.
 * Теперь защита одна на оба места и живёт здесь; консилиум её переиспользует,
 * а не заводит вторую (`hold`/`release` ниже).
 *
 * Два слоя, оба под одним правилом комнаты (`shared/rules.ts` · `danger`):
 *
 *   1. ПОДМЕНЫ ВНУТРИ ПРОЦЕССА — надёжные, потому что мимо них не пройти, не
 *      написав это другими словами: `shell.ask_exit` (это `exit()` и
 *      `quit()`), `os._exit`, `os.abort`, `os.kill`, `os.killpg`,
 *      `signal.raise_signal`, `signal.pthread_kill`, `kernel.do_shutdown`.
 *      Сигналы закрыты ТОЛЬКО когда цель — само ядро, его родитель, pid 1,
 *      своя группа или «все» (`0`, `-1`), а сигнал смертельный: чужих детей
 *      убивать можно, иначе ломаются `multiprocessing`, joblib и `subprocess`.
 *      `sys.exit()` не трогается вовсе — в ipykernel это `SystemExit`, и ядро
 *      его переживает.
 *
 *   2. КОМАНДЫ ОБОЛОЧКИ И МАГИИ — по тексту команды в момент запуска, а не
 *      разбором Python: `!cmd` (`shell.system`, `shell.getoutput`),
 *      `%%bash`/`%%sh`/`%%script`, `os.system`, `os.popen`, `subprocess`.
 *      Граница узкая нарочно: `git`, `pip`, `ls`, `kill` собственного фонового
 *      процесса работают, а `kill -9 -1`, `pkill python`, `shutdown`,
 *      `reboot`, `init 0` и `rm -rf` корня занятия — нет. Сюда же `%reset`,
 *      `%reset -f`, `%reset_selective` и `%xdel`: в общей тетради они стирают
 *      переменные у всего класса.
 *
 * Роль не различается. Правило действует и на преподавателя: ядро одно, и
 * `os._exit(0)` из его ячейки стоит классу ровно столько же. Перезапустить
 * ядро у него есть чем — кнопка Restart, она идёт мимо ядра, через Jupyter.
 *
 * Чистый модуль: исходник на Python, сборка и разбор отчёта, ни сети, ни Yjs —
 * ради теста, который гоняет этот же исходник настоящим python3 (тот же приём,
 * что в council-isolation.ts).
 */

/** Скрытый модуль, в котором живёт защита. Не имя в `globals()` студента. */
export const GUARD_MODULE = '_colloq_guard'

/**
 * Имя исключения, которым защита отказывает.
 *
 * Одно на глобальную защиту и на изоляцию консилиума: сервер узнаёт по нему
 * свой же отказ и печатает ОДНУ человеческую строку без трейсбека — кадры
 * `<colloq-guard>` не код студента, и читать ему там нечего.
 */
export const COLLOQ_REFUSED = 'ColloqRefused'

/** Ключ, под которым отчёт едет в `user_expressions` ответа ядра. */
export const GUARD_REPORT_KEY = 'colloq'

/** Выражение, которым сервер спрашивает у ядра, встала ли защита. */
export const GUARD_REPORT_EXPR = `__import__('sys').modules['${GUARD_MODULE}'].report`

export interface GuardReport {
  ok: boolean
  /** Подменены ли сейчас функции (правило или удержание консилиума). */
  on: boolean
  /** Что именно сказано про ПРАВИЛО комнаты — это и сверяет сервер. */
  policy: boolean
  /** Сколько попыток консилиума держат защиту поверх правила. */
  holds: number
  /** Имена подменённых атрибутов — для журнала и теста. */
  patched: string[]
  error: string | null
}

/**
 * Реализация — одним куском Python, который исполняется НЕ в пространстве
 * студента.
 *
 * Всё объявленное ниже ложится в `__dict__` скрытого модуля: ячейка установки
 * не связывает в `globals()` ни одного имени, иначе защита сама оставляла бы в
 * тетради `os`, `sys` и свои переменные.
 *
 * Регулярных выражений здесь нет ни одного, и это не вкусовщина: исходник
 * живёт в шаблонной строке TypeScript, где каждый `\\` — это escape, и
 * `re.compile('\\|\\|')` молча превратился бы в `re.compile('||')`. Разбор
 * команд обходится `str.split`.
 */
const IMPL = `
import json
import os
import sys


class ColloqRefused(Exception):
    """Ячейка попросила то, что у комнаты одно на всех.

    Имя видно студенту, поэтому оно короткое и своё: сервер узнаёт по нему свой
    же отказ и печатает одну человеческую строку без трейсбека (kernel/index.ts
    · runOne и runCouncilOne), как и с остановкой по пределу.
    """


class _Report(object):
    """Отчёт серверу: его repr и есть готовый JSON.

    user_expressions возвращает mimebundle, а text/plain в нём — repr()
    значения. Отдавать строку нельзя: её repr приехал бы в кавычках и с
    экранированием, то есть JSON внутри JSON.
    """
    __slots__ = ('text',)

    def __init__(self, text):
        self.text = text

    def __repr__(self):
        return self.text


# Снимок встроенных, снятый ПРИ УСТАНОВКЕ, когда они ещё целы: ячейка вправе
# написать builtins.getattr = None, и снятие защиты падало бы на первой строке.
_getattr = getattr
_setattr = setattr
_delattr = delattr
_MISS = object()

# Сигналы, у которых нет другого смысла, кроме «кончить процесс сейчас» или
# «заморозить его навсегда». SIGINT сюда НЕ входит: им останавливают ячейку.
_DEADLY_NAMES = (
    'SIGKILL', 'SIGTERM', 'SIGABRT', 'SIGQUIT', 'SIGSEGV', 'SIGHUP',
    'SIGBUS', 'SIGILL', 'SIGFPE', 'SIGSYS', 'SIGTRAP', 'SIGSTOP', 'SIGTSTP',
)

# Команды, у которых цель — машина целиком.
_STOP_CMDS = frozenset(('shutdown', 'reboot', 'halt', 'poweroff'))

# Слова, по которым pkill и killall находят само ядро.
_SELF_WORDS = (
    'python', 'ipython', 'ipykernel', 'jupyter', 'kernel',
)

# Шаблоны pkill, которые значат «всё, что есть».
_ALL_PATTERNS = frozenset(('.', '.*', '^.*', '^.*$', '*', '-1'))

# Флаги pkill и killall, за которыми идёт значение, а не шаблон.
_PATTERN_FLAGS = frozenset((
    '-u', '-U', '-g', '-G', '-P', '-s', '-t', '-n', '-o',
    '--user', '--group', '--parent', '--signal', '--session',
))

# Магии, стирающие переменные ВСЕЙ комнаты одной строкой.
_WIPE_MAGICS = frozenset(('reset', 'reset_selective', 'xdel'))

# Клеточные магии, тело которых — это команда оболочки, а не Python.
_SCRIPT_MAGICS = frozenset(('bash', 'sh', 'script', 'zsh', 'ksh', 'cmd', 'powershell'))

# Слова, которые стоят ПЕРЕД настоящей командой и ничего о ней не говорят.
_PREFIX_CMDS = frozenset((
    'sudo', 'doas', 'env', 'nohup', 'exec', 'time', 'command', 'setsid', 'stdbuf',
))

# Разделители команд в строке оболочки. Порядок важен: сначала двойные.
_SEPARATORS = ('||', '&&', ';', '|', '&', '\\n')


def _shell():
    """Оболочка IPython, если мы в ядре; в голом python её нет, и это нормально."""
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
    """Ребёнок после fork() — там настоящие функции и есть правильное поведение.

    multiprocessing и joblib кончают дочерний процесс именно os._exit, и отказ
    в ребёнке пустил бы копию ячейки бежать дальше вторым ядром — беда крупнее
    той, от которой защищаемся.
    """
    try:
        return os.getpid() != _mine()
    except Exception:
        return False


def _texts():
    # Пока попытка консилиума держит защиту, говорят ЕЁ словами: там нечего
    # советовать про правило комнаты — внутри попытки запрет безусловный.
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
    """Цель сигнала — само ядро, его родитель, pid 1, своя группа или «все».

    Чужой ребёнок сюда не попадает нарочно: им управляют subprocess и joblib, и
    отказ там сломал бы больше, чем закрыл.
    """
    try:
        pid = int(pid)
    except Exception:
        return False
    mine = _mine()
    # 0 — своя группа процессов, -1 — все процессы пользователя.
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


# ------------------------------------------------- разбор команд оболочки


def _is_assign(word):
    """VAR=value перед командой — это окружение, а не команда."""
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
        # Незакрытая кавычка, странный юникод — разбираем грубо. Пропустить
        # опасное здесь можно: это лежачий полицейский, а не песочница.
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
    """Каталоги, снос которых целиком и есть «у всех всё пропало»."""
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
    # rm -rf /* и rm -rf * — это снос того же каталога, только звёздочкой.
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
    """Что сносит \`rm\`, если это корень занятия или машины; иначе None.

    Без -r рекурсии нет, а значит нет и беды: \`rm -f /\` не делает ничего.
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
    """Кого просят убить: первая подпись сигнала съедается как подпись."""
    signature = True
    for arg in args:
        if signature and arg.startswith('-'):
            signature = False
            continue
        signature = False
        if arg.startswith('-') and not arg[1:].isdigit():
            continue
        # $PPID у команды \`!kill\` — это и есть процесс ядра: оболочку запустило
        # оно. Числа тут нет, но цель известна.
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
    """Первая опасная команда в разобранной строке — или None."""
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
        # shell=True со списком: оболочке достаётся первый элемент, остальные
        # уезжают в её $0, $1 — то есть командой является именно он.
        _check_text(words[0])
        return
    bad = _bad_words(words)
    if bad is not None:
        _refuse(bad[0], bad[1])


# --------------------------------------------------------------- подмены


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
                # Метод класса вернётся сам, как только уйдёт наша подмена.
                _delattr(obj, name)
        except Exception:
            try:
                _setattr(obj, name, real)
            except Exception:
                pass


def _guard_exit(store):
    """exit() и quit() в ячейке гасят ядро ВСЕЙ комнате.

    В ipykernel exit и quit — один объект ZMQExitAutocall, его вызов (и даже
    голое имя exit на строке: IPython сам дописывает скобки) идёт в
    shell.ask_exit(), а тот ставит exit_now, и процесс заканчивается.

    Подменяется именно ask_exit, а не имена exit/quit: голое exit на строке
    IPython превращает в вызов только потому, что там лежит ЕГО объект
    автовызова. Подменив имя обычной функцией, мы бы закрыли exit() со скобками
    и открыли exit без них — проверено на живом ядре, именно так и вышло.
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
            # Настоящий shutdown_request приходит от самого ipykernel, и его
            # трогать нельзя: им пользуются клиенты Jupyter. Отличаем по
            # НЕПОСРЕДСТВЕННОМУ вызывающему: у кода ячейки это __main__.
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
    """os._exit() и os.abort() кончают процесс молча — без слова и без следа.

    Ни трассировки, ни стека, ни сигнала в dmesg, ни счётчика oom_kill в
    cgroup. Ровно этим 20.09.2026 занятие на тридцать человек потеряло ядро
    девять раз за одиннадцать минут.
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
    """Смертельный сигнал В САМО ЯДРО — и только он.

    os.kill остаётся рабочим инструментом: им управляют дочерними процессами, и
    joblib, multiprocessing и subprocess без него не живут. Закрыта одна
    единственная пара «цель — это мы» и «сигнал смертельный».
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
            # Смертельный сигнал ЛЮБОМУ потоку кончает весь процесс: потоки
            # делят таблицу обработчиков.
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
        """Подкласс, а не функция: isinstance и наследование должны жить.

        joblib и multiprocessing на Linux сюда не заходят вовсе — они зовут
        _posixsubprocess.fork_exec напрямую, — так что эта подмена стоит на
        дороге только у того, кто сам написал subprocess.
        """

        def __init__(self, args, *rest, **kwargs):
            if not _in_child():
                shell_mode = kwargs.get('shell', False)
                # shell — девятый позиционный; списком его почти никогда не
                # передают, но раз уж передали, читаем оттуда.
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

    # system — это !cmd; getoutput — это !!cmd, %sx и var = !cmd. Остальные два
    # имени подменяются на случай, когда магия зовёт их в обход self.system.
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


# ------------------------------------------------------- установка и снятие


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
    # Ставится ДО подмен: сами подмены спрашивают у него pid и корень.
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
            # Одна не вставшая подмена — не повод остаться без остальных.
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
            # Сервер выкатили, пока ядро жило: старые подмены снимаются своими
            # же записями, новые встают из свежего кода.
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
    """Правило комнаты: исполнять опасные команды или нет.

    Отчёт ставится ВСЕГДА, в том числе на своей ошибке: сервер читает его как
    единственное подтверждение и молчание обязан считать отказом.
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
    """Попытка консилиума: защита действует, что бы ни стояло в правиле.

    Попытка студента идёт на ОБЩЕМ ядре, и уронить им класс нельзя даже тогда,
    когда преподаватель разрешил опасные команды ради показа. Счётчик, а не
    флажок: правило могут поменять посреди попытки, и оба ответа должны
    складываться, а не спорить.
    """
    global holds, held
    if settings:
        held = settings
    holds += 1
    _recompute()
    _tell()
    return True


def release():
    """Попытка кончилась — вернуться к тому, что говорит правило комнаты."""
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
# Умолчание строгое: ядро, которому сервер ещё ничего не сказал, защищено.
# Ошибиться здесь можно только в сторону «отказали лишнего», и это дешевле.
globals().setdefault('policy', True)
# Последней строкой, и это важно: по ней установка узнаёт, что ДОШЛА до конца.
version = '__VERSION__'
`

/** Версия установки — короткий хеш самого исходника, считается один раз. */
let stamp: string | null = null
function implVersion(): string {
  return (stamp ??= createHash('sha1').update(IMPL).digest('hex').slice(0, 12))
}

/** Исходник с проставленной версией, уже экранированный в литерал Python. */
let literal: string | null = null
function implLiteral(): string {
  return (literal ??= JSON.stringify(IMPL.replace('__VERSION__', implVersion())))
}

const MODULE = JSON.stringify(GUARD_MODULE)

/**
 * Строка установки — ровно одна, и её ставят первой все, кому защита нужна.
 *
 * Установка идёт только когда её ещё нет или она другая: исходник за двадцать
 * килобайт, а `compile` его стоил бы полмиллисекунды каждой ячейке при том,
 * что между ячейками он не меняется никогда. Сверка по версии остаётся
 * честной: другая сборка сервера — другой хеш, и живое ядро получает новый
 * код без перезапуска.
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
 * Тексты отказа — литералом в самом вызове, а не внутри исходника.
 *
 * Язык комнаты меняют в панели посреди пары: запёкши перевод в исходник, мы
 * держали бы в живом ядре вчерашний (или переустанавливали модуль на каждой
 * смене языка). Хвост разный: в комнате он говорит, кто это может разрешить, а
 * в попытке консилиума разрешить это нельзя ничем, и обещать обратное нечестно.
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

/** Настройки для комнаты: хвост советует правило «Опасные команды». */
export function guardRoomSettings(): string {
  return settingsLiteral(tr('server.guard.allow'))
}

/** Настройки для попытки консилиума: разрешить это не может никто. */
export function guardCouncilSettings(): string {
  return settingsLiteral(tr('server.guard.inCouncil'))
}

/**
 * Ячейка, которой сервер объявляет ядру правило комнаты.
 *
 * Строка целиком и служит отпечатком: в ней и правило, и язык отказа, так что
 * сравнение с прошлой сказанной строкой ловит и смену правила посреди пары, и
 * смену языка инстанса — без лишнего похода в ядро на каждую ячейку.
 */
export function guardPolicySource(block: boolean): string {
  return [
    guardInstallLine(),
    `__import__('sys').modules[${MODULE}].apply(` +
      `${block ? 'True' : 'False'}, ${guardRoomSettings()})`,
  ].join('\n')
}

/** Выражение удержания — его зовёт вход изоляции консилиума. */
export function guardHoldExpr(): string {
  return `__import__('sys').modules[${MODULE}].hold(${guardCouncilSettings()})`
}

/** Выражение освобождения — его зовёт выход изоляции консилиума. */
export const GUARD_RELEASE_EXPR = `__import__('sys').modules[${MODULE}].release()`

/**
 * Разобрать ответ ядра в отчёт; `null` — подтверждения не было.
 *
 * Принимает и то, что приезжает в `user_expressions` (`{status, data}` с
 * `text/plain` внутри), и голую строку JSON — второе ради теста, который гоняет
 * те же исходники настоящим python3 и читает отчёт со stdout.
 */
export function parseGuardReport(raw: unknown): GuardReport | null {
  let text: string | null = null
  if (typeof raw === 'string') text = raw
  else if (raw && typeof raw === 'object') {
    const wrapper = raw as { status?: unknown; data?: Record<string, unknown> }
    // status !== 'ok' — это `_user_obj_error()` IPython: выражение не
    // посчиталось, то есть модуля или отчёта в нём нет.
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
