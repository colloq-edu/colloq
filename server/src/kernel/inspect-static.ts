import { createHash } from 'node:crypto'
import { formatNumber, tr } from '@shared/i18n'

/**
 * Help for what the kernel does not have yet: a signature jedi read FROM THE
 * SOURCES.
 *
 * `inspect_request` answers from the NAMESPACE: it looks at a live object, and
 * until the `import seaborn as sns` cell has been run, `sns.lmplot` is a name
 * that does not exist for it. Hence half the complaints that "help does not
 * always appear": the notebook was opened, the cell with the imports has not
 * been reached yet, and the signature is wanted right now, while the line is
 * being written, not after it has been written.
 *
 * The second path answers the same question statically. jedi is in every
 * kernel (it comes with IPython, and it is the same jedi ipykernel uses to
 * answer `complete_request`), and it can read a signature without executing
 * anything at all. It needs just one thing the text of a single cell lacks:
 * where the name `sns` came from. So an IMPORT HEADER is glued on top of the
 * code being analysed: the `import …` lines from the code cells of the same
 * notebook above the current one (see `importHeader`). In a notebook the scope
 * is not the cell but the kernel, and the header repeats exactly that.
 *
 * Why the source travels into the kernel ITSELF instead of being analysed on
 * the server: jedi answers about the libraries installed IN THIS environment.
 * The server lives on a host that has neither seaborn nor torch nor whatever
 * the teacher added with `pip install` in the room's terminal; the kernel is
 * the only place where the question "what is lmplot's signature" has an answer
 * at all.
 *
 * What is done here for safety and quiet, and why:
 *   · a hidden module in `sys.modules`, not a single name bound in the
 *     student's `globals()` (the same trick as the council isolation);
 *   · `silent: true, store_history: False`: no output, no trace in `In`/`Out`;
 *   · the answer travels in `user_expressions`: with `silent` nothing arrives
 *     over IOPUB;
 *   · an alarm clock inside Python: someone else's kernel has no right to stand
 *     still for seconds because of a hovering mouse, and jedi has to be cut off
 *     THERE, not merely stop being waited for here;
 *   · a size ceiling: a numpy docstring can run to hundreds of kilobytes, and
 *     it travels over the same socket as the class's output.
 *
 * A pure module: the Python sources, building the question and parsing the
 * answer, no network, no Yjs, no docker (the same trick as in
 * council-isolation.ts).
 */

/** The hidden module the analysis lives in. Not a name in `globals()`. */
export const INSPECT_MODULE = '_colloq_inspect'

/** The key the answer travels under in `user_expressions`. */
export const INSPECT_REPORT_KEY = 'colloq'

/**
 * The expression the kernel evaluates after the code and puts into
 * `execute_reply`.
 *
 * The module has to be reached through `__import__`: it is deliberately not in
 * `user_ns`; see the file header.
 */
export const INSPECT_REPORT_EXPR = `__import__('sys').modules['${INSPECT_MODULE}'].report`

/**
 * How many seconds jedi is allowed to think.
 *
 * Two and a half, and the number is measured, not picked. On a cold container
 * the first analysis of pandas costs ~1.5 s (jedi parses the library's sources
 * and puts the result into its cache), the second 0.5 s, the third and later a
 * few milliseconds; seaborn after a warmed-up pandas takes 0.57 s. The previous
 * one and a half seconds cut off exactly the first hover over the heaviest
 * library, and the person got "nothing to say" where the answer was half a
 * step away.
 *
 * Why not more: for this long the kernel's shell is busy, i.e. a Run pressed in
 * the same second waits. Three seconds of waiting before the computation starts
 * are already noticeable, two and a half not yet. And an analysis that did not
 * make it no longer lies: it answers "still thinking" (`thinking`), the client
 * asks again by itself, and by the next time jedi is warm.
 */
export const INSPECT_BUDGET_SEC = 2.5

/** Answer ceiling: a docstring can be hundreds of KB, and the room shares a socket. */
export const INSPECT_LIMIT_BYTES = 20 * 1024

/** How many import lines go into the header. A course notebook fits ten times over. */
const HEADER_MAX_LINES = 60

/** And how many characters: the frame to the kernel is not made of rubber either. */
const HEADER_MAX_CHARS = 4 * 1024

/**
 * A line that may go into the header: one whole top-level import.
 *
 * Top-level only: `import cv2` inside a `try:` would be an indent in the middle
 * of the module in the header, i.e. a syntax error that would keep jedi from
 * parsing the WHOLE header, and so not a single name in it. Whole only: a line
 * continuation (`\` or an unclosed bracket) without its tail means the same.
 */
const IMPORT_LINE = /^(?:import\s+[A-Za-z_][\w.]*.*|from\s+[.\w]+\s+import\s+.+)$/

/**
 * The notebook's import header: the `import …` and `from … import …` lines from
 * its code cells.
 *
 * The order is the notebook's own: it is read and run top to bottom, and if
 * `np` was redefined lower down, the lower one is in effect. Repeats are
 * dropped: the same line stands in half the cells of a course notebook.
 *
 * Cells with `%%magic` are skipped entirely: `%%bash` with an `import` inside is
 * not Python, and a line from there glued into the header would spoil the
 * analysis of everything.
 */
export function importHeader(sources: readonly string[]): string {
  const lines: string[] = []
  const seen = new Set<string>()
  let chars = 0
  for (const source of sources) {
    if (typeof source !== 'string' || !source.includes('import')) continue
    if (/^\s*%%/.test(source)) continue
    for (const row of source.split('\n')) {
      const line = row.replace(/\s+$/, '')
      // Indented: an import inside `try`, a function or `if`; see IMPORT_LINE.
      if (line !== line.trimStart()) continue
      if (!IMPORT_LINE.test(line)) continue
      // A line continuation: its tail will not be in the header.
      if (line.endsWith('\\') || (line.includes('(') && !line.includes(')'))) continue
      if (seen.has(line)) continue
      if (lines.length >= HEADER_MAX_LINES || chars + line.length + 1 > HEADER_MAX_CHARS) {
        return lines.join('\n')
      }
      seen.add(line)
      lines.push(line)
      chars += line.length + 1
    }
  }
  return lines.join('\n')
}

/**
 * The name under the caret, as a dotted chain, the way a person sees it.
 *
 * Needed exactly so that the signature says `sns.lmplot(...)`, not
 * `lmplot(...)`: jedi knows what it found by its own name and does not guess the
 * prefix, while `inspect_request` writes exactly what was typed. Were they to
 * diverge, the same hovered `sns.lmplot` would look different depending on
 * whether the cell with the import had been run in the room.
 */
export function nameChainAt(code: string, cursor: number): string {
  const at = Math.max(0, Math.min(cursor, code.length))
  const head = code.slice(0, at)
  const line = head.slice(head.lastIndexOf('\n') + 1)
  return /[A-Za-z_][A-Za-z0-9_.]*$/.exec(line)?.[0] ?? ''
}

/**
 * The analysis source: all the work the kernel does, in one piece.
 *
 * A separate string in the file rather than assembled from pieces, for the same
 * reason as the council isolation: this is Python, and it should read as
 * Python, with indents and comments in their places.
 */
const IMPL = `
"""Signatures and docs from the sources, through jedi's eyes, running nothing."""
import json
import sys

version = '__VERSION__'

# The answer to the last question. The server picks it up through
# user_expressions, not as a return value: with silent=True an execute_request
# has no return value.
report = None


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


class _Timeout(Exception):
    """The alarm clock: jedi is thinking longer than the room agrees to wait."""


def _arm(budget):
    """Arm an alarm for budget seconds; None means it could not be armed.

    It has to be cut off FROM INSIDE: a server that stopped waiting does not
    free the kernel, which would go on parsing pandas while someone waits for
    their cell. SIGALRM works only in the main thread; ipykernel runs code in
    exactly that thread, but the check is here for the case when it does not.
    """
    try:
        import signal
        import threading
        if threading.current_thread() is not threading.main_thread():
            return None

        def bang(signum, frame):
            raise _Timeout('colloq-inspect')

        old = signal.signal(signal.SIGALRM, bang)
        signal.setitimer(signal.ITIMER_REAL, budget)
        return old
    except Exception:
        return None


def _disarm(old):
    if old is None:
        return
    try:
        import signal
        signal.setitimer(signal.ITIMER_REAL, 0)
        signal.signal(signal.SIGALRM, old)
    except Exception:
        pass


_QUOTES = ('"', "'")
_OPEN = '(['
_CLOSE = ')]'
_BACKSLASH = chr(92)


def _split(inner):
    """Parameters from the signature text, split on TOP-LEVEL commas.

    From the text, not from sig.params, and that is not nitpicking: jedi's
    parameter list has no bare asterisk, and that asterisk is exactly the line
    after which arguments are passed by name only. Without it, lmplot's
    signature would read as permission to write lmplot(data, x, y), i.e. as an
    untruth.

    Quotes and nested brackets are counted, because a comma also lives inside a
    default: markers=("o", "x"), dtype=Dict[str, int].
    """
    parts = []
    depth = 0
    quote = ''
    start = 0
    i = 0
    while i < len(inner):
        ch = inner[i]
        if quote:
            if ch == _BACKSLASH:
                i += 2
                continue
            if ch == quote:
                quote = ''
        elif ch in _QUOTES:
            quote = ch
        elif ch in _OPEN:
            depth += 1
        elif ch in _CLOSE:
            depth -= 1
        elif ch == ',' and depth == 0:
            parts.append(inner[start:i].strip())
            start = i + 1
        i += 1
    tail = inner[start:].strip()
    if tail:
        parts.append(tail)
    return [p for p in parts if p]


def _wrap(display, sig):
    """The signature in a column, if it does not fit on one line.

    That is how IPython itself prints it: twenty-five lmplot parameters on one
    line read worse than not at all. The tail ("-> Self") stays in place: it is
    part of the same text, and there is nothing to rewrite it with.
    """
    try:
        text = sig.to_string()
    except Exception:
        return ''
    if not text:
        return ''
    own = getattr(sig, 'name', '') or ''
    if display and own and text.startswith(own + '('):
        text = display + text[len(own):]
    if len(text) <= 72:
        return text
    at = text.find('(')
    close = text.rfind(')')
    if at == -1 or close < at:
        return text
    parts = _split(text[at + 1:close])
    if not parts:
        return text
    return text[:at] + '(\\n' + ''.join('    ' + p + ',\\n' for p in parts) + ')' + text[close + 1:]


# The "top-level module name → distribution" map, computed once per kernel.
#
# packages_distributions() walks ALL dist-info of the environment: 84 ms and 117
# entries on the colloq-kernel:base image (measured 20 Sep 2026). For a single
# question that costs more than jedi's analysis itself (9 ms for pd), and the
# map changes only on pip install, i.e. once a class, and not silently: a new
# kernel rereads it.
_dists = None


def _dist_of(top):
    """The distribution of a top-level module, WITHOUT importing the module.

    sklearn lives in scikit-learn, cv2 in opencv-python, PIL in Pillow: the name
    a module is imported under and the name it is installed under do not always
    match, and the person needs the second one in the help.
    """
    global _dists
    if _dists is None:
        try:
            import importlib.metadata as md
            _dists = md.packages_distributions()
        except Exception:
            _dists = {}
    names = _dists.get(top) or []
    if not names:
        return None
    # Several distributions for one module (namespaces like zope.*): take the
    # one whose name is the module's name, otherwise the first.
    for name in names:
        if name.replace('-', '_').lower() == top.replace('-', '_').lower():
            return name
    return names[0]


def _docs_link(meta):
    """A documentation link: by the Project-URL labels, then Home-page."""
    labelled = {}
    try:
        for row in meta.get_all('Project-URL') or []:
            label, _, url = row.partition(',')
            labelled[label.strip().lower()] = url.strip()
    except Exception:
        pass
    for key in ('documentation', 'docs', 'doc', 'homepage', 'home-page', 'home'):
        if labelled.get(key):
            return labelled[key]
    try:
        home = meta.get('Home-page') or ''
    except Exception:
        home = ''
    return home.strip()


def _package(full):
    """Package sections: Package / Summary / Docs. Empty means no metadata.

    The metadata lies on disk next to the package (dist-info), and it is read
    WITHOUT importing: a mouse hover has no right to execute someone else's
    code. A standard library module and a file from the class folder have no
    distribution at all; then these sections are simply absent.
    """
    top = (full or '').split('.')[0]
    if not top:
        return []
    dist = _dist_of(top)
    if not dist:
        return []
    try:
        import importlib.metadata as md
        meta = md.metadata(dist)
    except Exception:
        return []
    out = []
    try:
        name = meta['Name'] or dist
    except Exception:
        name = dist
    try:
        version = meta['Version'] or ''
    except Exception:
        version = ''
    out.append('Package: ' + name + ((' ' + version) if version else ''))
    try:
        summary = (meta.get('Summary') or '').strip()
    except Exception:
        summary = ''
    # "UNKNOWN" is what setuptools puts when the author wrote no description.
    if summary and summary.lower() != 'unknown':
        out.append('Summary: ' + summary)
    link = _docs_link(meta)
    if link:
        out.append('Docs: ' + link)
    return out


def _module_facts(full):
    """Everything we know about a module, before its own documentation."""
    parts = []
    if full:
        parts.append('Module: ' + full)
    parts.append('Type: module')
    parts.extend(_package(full))
    return parts


def facts(ns, expr, limit):
    """The same sections for a LIVE module, from the object in the namespace.

    Needed where inspect_request itself answered: about a module it says "Type:
    module", "String form: <module 'seaborn' from ...>" and "Docstring: <no
    docstring>", i.e. nothing. The package name and description lie in the
    metadata, and they can be read without importing anything: the object
    ALREADY exists (the import in the cell was run), and all that is left is to
    read its __name__.

    The expression is parsed by dots and with getattr only: no calls, no
    indexing, no eval. A mouse hover does not run someone else's code.
    """
    global report
    out = {'found': False, 'why': 'nothing'}
    try:
        value = None
        for i, step in enumerate((expr or '').split('.')):
            if not step:
                break
            value = ns.get(step) if i == 0 else getattr(value, step, None)
            if value is None:
                break
        import types
        if isinstance(value, types.ModuleType):
            name = getattr(value, '__name__', '') or expr
            text = '\\n'.join(_module_facts(name))
            if len(text) > limit:
                text = text[:limit]
            out = {'found': True, 'text': text}
    except Exception:
        out = {'found': False, 'why': 'nothing'}
    report = _Report(json.dumps(out))


# How many characters of a value we show, and how many list elements we look at.
_BRIEF_CHARS = 40
_BRIEF_PEEK = 20

# Types whose repr() is known to be cheap and harmless.
_PLAIN = (bool, int, float, complex, str, bytes, range, slice, type(None))


def _short(text, limit=_BRIEF_CHARS):
    text = text.replace(chr(10), ' ')
    return text if len(text) <= limit else text[: limit - 1] + '…'


def _type_name(value):
    """Type name with its package unless builtin: DataFrame, torch.Tensor."""
    cls = type(value)
    name = getattr(cls, '__name__', '?')
    module = getattr(cls, '__module__', '') or ''
    if module in ('builtins', '__main__', ''):
        return name
    # We show the top package, not the internal path: pandas.core.frame.DataFrame
    # tells a person nothing beyond DataFrame.
    return name


def _elem_type(items):
    """One type for all, or empty. We look at no more than _BRIEF_PEEK elements."""
    seen = None
    count = 0
    for item in items:
        if count >= _BRIEF_PEEK:
            break
        count += 1
        kind = type(item).__name__
        if seen is None:
            seen = kind
        elif seen != kind:
            return ''
    return seen or ''


def _brief_of(value):
    """A short truth about a value: its type, size, sometimes the value itself.

    Strictly O(1) and without side effects. An unfamiliar object gets ONE type
    name as its answer: neither len(), nor repr(), nor str() is called on it;
    for a database cursor, a generator or a lazy collection that can be
    expensive, or even move them forward. A mouse hover has no right to change
    state.
    """
    import sys

    np0 = sys.modules.get('numpy')
    # A numpy scalar is checked FIRST: np.float64 inherits from float, and the
    # ordinary branch would show "float64 · np.float64(3.5)" instead of
    # "float64 · 3.5".
    if np0 is not None and isinstance(value, np0.generic):
        return {'type': str(value.dtype), 'value': _short(repr(value.item()))}

    if value is None or isinstance(value, _PLAIN):
        out = {'type': _type_name(value)}
        if not isinstance(value, (str, bytes)):
            out['value'] = _short(repr(value))
            return out
        out['dims'] = str(len(value))
        out['value'] = _short(repr(value))
        return out

    pd = sys.modules.get('pandas')
    if pd is not None:
        if isinstance(value, pd.DataFrame):
            rows, cols = value.shape
            return {'type': 'DataFrame', 'dims': str(rows) + ' × ' + str(cols)}
        if isinstance(value, pd.Series):
            out = {'type': 'Series', 'dims': str(value.shape[0]), 'dtype': str(value.dtype)}
            name = getattr(value, 'name', None)
            if name is not None:
                out['note'] = _short(str(name))
            return out
        if isinstance(value, pd.Index):
            return {'type': type(value).__name__, 'dims': str(len(value)), 'dtype': str(value.dtype)}

    np = sys.modules.get('numpy')
    if np is not None:
        if isinstance(value, np.ndarray):
            return {'type': 'ndarray', 'dtype': str(value.dtype), 'dims': str(tuple(value.shape))}

    torch = sys.modules.get('torch')
    if torch is not None:
        if isinstance(value, torch.Tensor):
            out = {
                'type': 'Tensor',
                'dtype': str(value.dtype).replace('torch.', ''),
                'dims': str(tuple(value.shape)),
                'note': str(value.device),
            }
            if bool(value.requires_grad):
                out['note'] = out['note'] + ' · grad'
            return out
        nn = sys.modules.get('torch.nn')
        if nn is not None and isinstance(value, nn.Module):
            out = {'type': _type_name(value)}
            try:
                # Counting parameters walks the module list, not the data; for
                # a seminar's networks that is hundreds of entries, not millions.
                # The number, not a phrase: the kernel does not know the room's
                # language, and the server words it (parseBrief).
                out['params'] = int(sum(p.numel() for p in value.parameters()))
            except Exception:
                pass
            return out

    sparse = sys.modules.get('scipy.sparse')
    if sparse is not None and getattr(sparse, 'issparse', None) is not None:
        try:
            if sparse.issparse(value):
                return {
                    'type': getattr(value, 'format', 'sparse') + ' sparse',
                    'dtype': str(value.dtype),
                    'dims': str(tuple(value.shape)),
                    'note': str(value.nnz) + ' nnz',
                }
        except Exception:
            pass

    if isinstance(value, (list, tuple, set, frozenset)):
        kind = type(value).__name__
        inner = _elem_type(value)
        return {'type': kind + ('[' + inner + ']' if inner else ''), 'dims': str(len(value))}
    if isinstance(value, dict):
        keys = []
        vals = []
        count = 0
        for key in value:
            if count >= _BRIEF_PEEK:
                break
            count += 1
            keys.append(key)
            vals.append(value[key])
        kt = _elem_type(keys)
        vt = _elem_type(vals)
        out = {
            'type': 'dict' + ('[' + kt + ', ' + vt + ']' if kt and vt else ''),
            'dims': str(len(value)),
        }
        first = [str(k) for k in keys[:3]]
        if first:
            out['note'] = _short(', '.join(first))
        return out

    deque = getattr(sys.modules.get('collections'), 'deque', None)
    if deque is not None and isinstance(value, deque):
        return {'type': 'deque', 'dims': str(len(value))}

    import types as _t

    if isinstance(value, _t.ModuleType):
        return {'type': 'module', 'note': getattr(value, '__name__', '')}
    if isinstance(value, type):
        return {'type': 'class', 'note': getattr(value, '__name__', '')}
    if isinstance(value, (_t.FunctionType, _t.BuiltinFunctionType, _t.MethodType)):
        out = {'type': 'function'}
        try:
            import inspect as _i

            out['note'] = _short(
                getattr(value, '__name__', 'f') + str(_i.signature(value)), 72
            )
        except Exception:
            out['note'] = getattr(value, '__name__', '')
        return out

    base = sys.modules.get('sklearn.base')
    if base is not None and getattr(base, 'BaseEstimator', None) is not None:
        try:
            if isinstance(value, base.BaseEstimator):
                out = {'type': _type_name(value)}
                # Is it fitted: by the traces of fitting in the object itself,
                # attributes with a trailing underscore. No method is called.
                # A flag, not a word: the server says it in the room's language.
                out['fitted'] = any(
                    k.endswith('_') and not k.startswith('__') for k in vars(value)
                )
                return out
        except Exception:
            pass

    # Unfamiliar: only the type name. Neither len nor repr; see the function header.
    return {'type': _type_name(value)}


def brief(ns, expr):
    """A short line about a value, from the object in the namespace.

    The expression is parsed the same way as in facts: only dots and getattr, no
    calls, no indexing, no eval. No name means no answer: hovering over a word
    that does not exist in the kernel must stay silent.
    """
    global report
    out = {'found': False}
    try:
        steps = (expr or '').split('.')
        if not steps or not steps[0]:
            report = _Report(json.dumps(out))
            return
        if steps[0] not in ns:
            report = _Report(json.dumps(out))
            return
        value = ns[steps[0]]
        missing = object()
        for step in steps[1:]:
            if not step:
                value = missing
                break
            value = getattr(value, step, missing)
            if value is missing:
                break
        if value is not missing:
            said = _brief_of(value)
            if said:
                out = {'found': True, 'brief': said}
    except Exception:
        out = {'found': False}
    report = _Report(json.dumps(out))


def _render(found, display, limit):
    """The best of what was found, laid out under IPython's headers.

    The same headers as inspect_request's, and that is the condition of the
    whole idea: there is one parser on the client
    (web/src/lib/signature-help.ts), and two answers to one question must look
    the same.

    The BEST, not the first: for pd.read_csv jedi returns five overloads from
    the .pyi, and not every one has documentation. We take the one with both a
    signature and documentation; if there is none, the one with anything at all.
    """
    best = None
    for d in found:
        try:
            sigs = d.get_signatures()
        except Exception:
            sigs = []
        sig = _wrap(display, sigs[0]) if sigs else ''
        try:
            doc = d.docstring(raw=True) or ''
        except Exception:
            doc = ''
        doc = doc.strip('\\n')
        rank = 2 if (sig and doc.strip()) else 1 if (sig or doc.strip()) else 0
        if best is None or rank > best[0]:
            best = (rank, d, sig, doc)
        if rank == 2:
            break
    if best is None:
        return ''
    rank, d, sig, doc = best
    kind = getattr(d, 'type', '') or ''
    parts = []
    if kind == 'module':
        """A module is a package, not an object.

        pandas assembles its module docstring by assigning __doc__ at runtime,
        seaborn has none at all, and until 21 Sep 2026 hovering over them
        answered "module · <module pandas>", words from which a person learns
        nothing. Everything about the package is written next to it on disk:
        the name, version, description, documentation link (see _package).
        """
        full = getattr(d, 'full_name', '') or getattr(d, 'name', '') or display
        parts.extend(_module_facts(full))
    elif sig:
        # A class has no signature: there is the signature of its __init__, and
        # IPython calls it exactly that.
        head = 'Init signature' if kind == 'class' else 'Signature'
        parts.append(head + ':\\n' + sig)
    if kind and kind != 'module':
        parts.append('Type: ' + kind)
    if doc.strip():
        parts.append('Docstring:\\n' + doc)
    elif not sig and kind != 'module':
        # Neither a signature nor documentation, and it is not a module, but
        # there is still something to say: at least the kind and the full name,
        # in the same field IPython itself shows them in.
        full = getattr(d, 'full_name', '') or getattr(d, 'name', '') or ''
        if not full and not kind:
            return ''
        parts.append('String form: <' + (kind or 'object') + ' ' + (full or '?') + '>')
    if not parts:
        return ''
    text = '\\n'.join(parts)
    if len(text) > limit:
        # The cut is visible: silently shortened documentation reads as
        # documentation that simply ends there.
        text = text[:limit] + '\\n…'
    return text


def look(code, line, column, display, budget, limit):
    """Answer one question and put the answer into report."""
    global report
    report = None
    try:
        import jedi
    except Exception:
        # No jedi in this environment: ordinary for a kernel not built by us.
        report = _Report(json.dumps({'found': False, 'why': 'no-jedi'}))
        return
    out = {'found': False, 'why': 'nothing'}
    old = _arm(budget)
    try:
        script = jedi.Script(code=code)
        try:
            found = script.infer(line, column)
        except Exception:
            found = []
        if not found:
            # infer answers about the name's VALUE, goto about where it is
            # declared. The latter knows more where the former could not resolve
            # the type.
            try:
                found = script.goto(line, column, follow_imports=True)
            except Exception:
                found = []
        text = _render(found, display, limit)
        if text:
            out = {'found': True, 'text': text}
    except _Timeout:
        out = {'found': False, 'why': 'timeout'}
    except Exception:
        out = {'found': False, 'why': 'nothing'}
    finally:
        _disarm(old)
    report = _Report(json.dumps(out))
`

let stamp: string | null = null

/** Source version: a new server build means a new hash, and the kernel rereads it. */
function implVersion(): string {
  return (stamp ??= createHash('sha256').update(IMPL).digest('hex').slice(0, 12))
}

let literal: string | null = null
function implLiteral(): string {
  return (literal ??= JSON.stringify(IMPL.replace('__VERSION__', implVersion())))
}

export interface StaticInspectQuestion {
  /** The cell's code, the same that would go into `inspect_request`. */
  code: string
  /** The caret in this code, in characters from the start. */
  cursor: number
  /** The notebook's import header; `''` means there were no imports above. */
  header?: string
  budgetSec?: number
  limitBytes?: number
}

/**
 * The question cell: install the module (if it is not the right one) and make
 * one call.
 *
 * `exec` into the hidden module's `__dict__` is the only way to bring two
 * hundred lines of Python in here without leaving either `sys` or temporary
 * variables in the student's namespace. The version check makes the install
 * idempotent and free: `compile` of this source costs a millisecond, and
 * between questions it never changes.
 */
export function inspectStaticSource(question: StaticInspectQuestion): string {
  const header = typeof question.header === 'string' ? question.header : ''
  const cell = typeof question.code === 'string' ? question.code : ''
  const at = Math.max(0, Math.min(question.cursor ?? 0, cell.length))
  /*
   * The header goes ON TOP, and the caret moves down by exactly as many lines
   * as it has. Recomputing the position from the glued text is not an option:
   * off by one character, jedi would analyse the neighbouring name and
   * confidently answer about the wrong thing.
   */
  const whole = header === '' ? cell : `${header}\n${cell}`
  const before = whole.slice(0, whole.length - cell.length + at)
  const line = before.split('\n').length
  const column = before.length - (before.lastIndexOf('\n') + 1)
  const display = nameChainAt(cell, at)
  const budget = Number.isFinite(question.budgetSec) ? Number(question.budgetSec) : INSPECT_BUDGET_SEC
  const limit = Number.isFinite(question.limitBytes)
    ? Math.floor(Number(question.limitBytes))
    : INSPECT_LIMIT_BYTES
  const module = JSON.stringify(INSPECT_MODULE)
  return [
    `if getattr(__import__('sys').modules.get(${module}), 'version', None) != ` +
      `${JSON.stringify(implVersion())}: ` +
      `exec(compile(${implLiteral()}, '<colloq-inspect>', 'exec'), ` +
      `__import__('sys').modules.setdefault(${module}, ` +
      `__import__('types').ModuleType(${module})).__dict__)`,
    `__import__('sys').modules[${module}].look(${JSON.stringify(whole)}, ${line}, ${column}, ` +
      `${JSON.stringify(display)}, ${budget}, ${limit})`,
  ].join('\n')
}

/**
 * A question about a LIVE module: the package name, version, description,
 * link.
 *
 * A second, short request, and it is asked only where `inspect_request` has
 * already answered "Type: module". About a module IPython itself says three
 * things, and all three are useless: the kind, the object's address in memory
 * and `<no docstring>`; pandas assembles its docstring at runtime, seaborn has
 * none at all, and the person saw "module · <module pandas>".
 *
 * `globals()` goes as the first argument: the code runs in the student's
 * namespace, and the module is ALREADY there; there was an import, otherwise
 * `inspect_request` would not have answered. The expression inside is parsed
 * only by dots and only with `getattr` (inspect-static · `facts`): a mouse
 * hover does not run someone else's code.
 */
export function inspectFactsSource(expr: string, limitBytes?: number): string {
  const limit = Number.isFinite(limitBytes) ? Math.floor(Number(limitBytes)) : INSPECT_LIMIT_BYTES
  const module = JSON.stringify(INSPECT_MODULE)
  return [
    `if getattr(__import__('sys').modules.get(${module}), 'version', None) != ` +
      `${JSON.stringify(implVersion())}: ` +
      `exec(compile(${implLiteral()}, '<colloq-inspect>', 'exec'), ` +
      `__import__('sys').modules.setdefault(${module}, ` +
      `__import__('types').ModuleType(${module})).__dict__)`,
    `__import__('sys').modules[${module}].facts(globals(), ${JSON.stringify(expr)}, ${limit})`,
  ].join('\n')
}

/**
 * The live kernel's answer about a module, supplemented with the same sections.
 *
 * The package sections go ON TOP: in IPython everything substantial
 * (`Docstring:`) comes last, and anything appended after it would be read by
 * the parser as part of the documentation. And `String form:` and `File:` are
 * not shown for a module at all (web/src/lib/signature-help.ts): the object's
 * address in another process and the path inside the container tell a person
 * in the room nothing.
 */
export function withModuleFacts(live: string, facts: string): string {
  const extra = facts.trim()
  if (extra === '') return live
  /*
   * IPython's header is stripped at the same time, and without that the
   * appended part would break the parsing.
   *
   * About a module IPython says exactly three lines, `Type:`, `String form:`,
   * `File:`, and all three we either already have or do not need: the kind is
   * named in the appended part, and the object's address in memory and the path
   * inside the container tell a person in the room nothing. Left in, they
   * arrive as REPEATED headers, and the parser on the client, rightly, counts a
   * repeat as part of the open section: the documentation link would turn into
   * "https://… Type: module". Only leading lines are stripped: the same line
   * inside the documentation stays text, as it was.
   */
  const rows = live.replace(/\r/g, '').split('\n')
  let at = 0
  while (at < rows.length && /^(?:Type|String form|File):/.test(rows[at])) at++
  const rest = rows.slice(at).join('\n').replace(/^\n+/, '')
  return rest === '' ? extra : `${extra}\n${rest}`
}

/** Does the kernel say "this is a module": by the same parsing as the client. */
export function looksLikeModule(text: string): boolean {
  return /^Type: *module\s*$/m.test(text.replace(/\r/g, ''))
}

/**
 * What is briefly known about a value: its type, size, sometimes the value
 * itself.
 *
 * All fields are optional, and that is not laziness but the shape of the
 * answer: an `int` has a value and no size, a `DataFrame` the other way round,
 * and an unfamiliar object has only a type name, and we have no right to ask it
 * for anything else (inspect-static · `_brief_of`).
 */
export interface BriefValue {
  type: string
  dims?: string
  dtype?: string
  value?: string
  note?: string
}

/**
 * A question about a name's VALUE, the cheapest of all.
 *
 * No jedi, no documentation, no metadata: the object is already computed and
 * lies in the kernel's memory; it is asked for its type and size. So the
 * budget is short, and no kernel is started for this: no kernel, no line.
 */
export function inspectBriefSource(expr: string): string {
  const module = JSON.stringify(INSPECT_MODULE)
  return [
    `if getattr(__import__('sys').modules.get(${module}), 'version', None) != ` +
      `${JSON.stringify(implVersion())}: ` +
      `exec(compile(${implLiteral()}, '<colloq-inspect>', 'exec'), ` +
      `__import__('sys').modules.setdefault(${module}, ` +
      `__import__('types').ModuleType(${module})).__dict__)`,
    `__import__('sys').modules[${module}].brief(globals(), ${JSON.stringify(expr)})`,
  ].join('\n')
}

/** Parse the answer about a value; `null` means nothing to say or no answer. */
export function parseBrief(raw: unknown): BriefValue | null {
  let text: string | null = null
  if (typeof raw === 'string') text = raw
  else if (raw && typeof raw === 'object') {
    const wrapper = raw as { status?: unknown; data?: Record<string, unknown> }
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
  const row = parsed as { found?: unknown; brief?: unknown } | null
  if (!row || row.found !== true || !row.brief || typeof row.brief !== 'object') return null
  const said = row.brief as Record<string, unknown>
  if (typeof said.type !== 'string' || said.type === '') return null
  const out: BriefValue = { type: said.type }
  for (const key of ['dims', 'dtype', 'value', 'note'] as const) {
    const value = said[key]
    if (typeof value === 'string' && value !== '') out[key] = value
  }
  /*
   * Facts the kernel reports without words, because it does not know the
   * room's language: the size of a network and whether an estimator is fitted.
   * The server says them in the language of the instance.
   */
  if (typeof said.params === 'number' && Number.isSafeInteger(said.params) && said.params >= 0) {
    out.note = tr('server.brief.parameters', { count: said.params, n: formatNumber(said.params) })
  }
  if (typeof said.fitted === 'boolean') {
    out.note = tr(said.fitted ? 'server.brief.fitted' : 'server.brief.notFitted')
  }
  return out
}

export interface StaticInspectAnswer {
  found: boolean
  text: string | null
  /** Why not found: `no-jedi`, not in the environment; `timeout`, too slow. */
  why: 'no-jedi' | 'timeout' | 'nothing' | null
}

/**
 * Parse the kernel's answer.
 *
 * Accepts both what arrives in `user_expressions` (`{status, data}` with
 * `text/plain` inside) and a bare JSON string; the latter for the test that
 * runs the same source with a real python3 and reads the answer from stdout.
 *
 * `null` means there was no confirmation at all: the module did not install,
 * the run failed, the kernel answered with something else. Telling this apart
 * from "not found" matters: the first is our trouble, the second an ordinary
 * outcome.
 */
export function parseStaticInspect(raw: unknown): StaticInspectAnswer | null {
  let text: string | null = null
  if (typeof raw === 'string') text = raw
  else if (raw && typeof raw === 'object') {
    const wrapper = raw as { status?: unknown; data?: Record<string, unknown> }
    // status !== 'ok' is IPython's `_user_obj_error()`: the expression was not
    // evaluated, i.e. the module or its answer is missing.
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
  const row = parsed as { found?: unknown; text?: unknown; why?: unknown }
  if (row.found === true && typeof row.text === 'string' && row.text !== '') {
    return { found: true, text: row.text, why: null }
  }
  const why = row.why === 'no-jedi' || row.why === 'timeout' ? row.why : 'nothing'
  return { found: false, text: null, why }
}
