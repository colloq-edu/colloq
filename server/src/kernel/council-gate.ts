import { createHash } from 'node:crypto'
import { COUNCIL_GATE_MOUNT } from '@shared/remote-kernels'

/**
 * The gate of a council worker's kernel (docs/architecture/remote-classes.md
 * §9.6, 0.26.1): what makes one tunnel trip per attempt safe.
 *
 * A pool worker on a gated kernel gets an attempt's three requests in one
 * batch — its entry, the attempt, its exit (kernel/index.ts · councilTrip) —
 * and the kernel runs them in order, so the attempt no longer waits a round
 * trip for the entry's verdict. The entry's promise still holds ("an attempt
 * never runs on shared objects") because the kernel itself lets a non-silent
 * request through only when the gate was opened for the token in that
 * request's metadata (COUNCIL_GATE_RUN_KEY), and an opening is spent by that
 * one request. Any other non-silent request is not run: its code is swapped
 * for a call that raises COUNCIL_GATE_REFUSED, so its reply is an ordinary
 * error. Silent requests — the entry, the exit, the load, the guard, an
 * evaluation — always pass. The hidden module's `enter` closes the gate
 * first thing and opens it for the attempt's run id as its very last step
 * when its personal copies are ready, never on its `needs` path and never
 * on an error (council-isolation.ts · `_gate`).
 *
 * THE OPENING STANDS ONLY WITH ITS ENTRY'S REPLY. An opening made by a
 * silent request whose reply is not ok in full — its cell stopped once the
 * entry was done (the limit's signal, a stop), or its report's expression
 * failed — is taken back as that request ends: the gate is open for the
 * attempt exactly when home can read the entry's report as held. Only a
 * reply lost on its way leaves home without it, and then home reads the
 * gate's own verdict off the attempt (kernel/index.ts · runCouncilOne).
 *
 * A HOME THAT DOES NOT KNOW THE GATE (before 0.26.1, a rollback) sends no
 * run id and its entry never touches the gate; its requests run as they
 * always did, on its three trips, while no entry has shut or opened the
 * gate in this process. Once one has, a request without a token is refused
 * like any other, and a request carrying one is held to the gate from the
 * process's birth.
 *
 * FROM BIRTH, NOT INSTALLED BY THE LOAD. A request sent to a kernel process
 * that died before it arrived waits in jupyter_server's socket and reaches
 * the NEXT process after a restart (measured on ipykernel 7.3 through
 * jupyter_client's sockets, the kind jupyter_server holds for every
 * channel; what a live process had taken in dies with it). A gate the
 * load installed would be absent there, and an attempt queued behind a
 * dying entry would run on an empty kernel without its ceiling. So the
 * machine's agent mounts this module and a system IPython config into every
 * council container (runner-agent/council.ts · councilMounts), and the
 * config loads the module as an extension into every kernel the container
 * starts, before the kernel reads its first request. A process born gated
 * refuses such an attempt. A batch sent to a dead process reaches the next
 * one whole, its entry too, so a worker's entry also refuses in a process
 * that does not hold the epoch its pool loaded for the attempt
 * (council-isolation.ts · CouncilIsolationSettings.epoch), and the gate
 * stays shut there as well.
 *
 * The extension rides `InteractiveShellApp.extra_extensions`, which a
 * user's profile setting `extensions` does not override; the system config
 * has the lowest priority, so a profile that sets `extra_extensions` itself
 * takes the gate away — then the load says so (`gated: false`), and home
 * takes the sequential road: never an attempt sent behind an entry to a
 * kernel that cannot hold it back.
 *
 * ipykernel 7 hands `do_execute` the request's metadata (`cell_meta`) when
 * the method accepts it; an older one does not, and the token is read from
 * the shell's parent message instead. Both shapes, and calls by position
 * as well as by keyword, are taken.
 *
 * The machine's agent writes these texts (runner-agent/council.ts), so this
 * file imports nothing of home's: no guard, no translations.
 */

/** The gate's module, as the kernel imports it from COUNCIL_GATE_MOUNT. */
export const COUNCIL_GATE_MODULE = 'colloq_gate'

/** The key of an attempt's request metadata that carries its run id, the token the entry opened the gate for. */
export const COUNCIL_GATE_RUN_KEY = 'colloqRun'

/**
 * The name of the exception the gate refuses with: the guard's own
 * (danger.ts · COLLOQ_REFUSED, the same string, held by
 * tests/council-gate.test.mts), so that an attempt's card draws a refusal as
 * one line without a traceback, whichever module refused.
 */
export const COUNCIL_GATE_REFUSED = 'ColloqRefused'

/**
 * What the gate's refusal says, in English, for the log: never a card's
 * words. A refusal that reaches an attempt's output is said there as the
 * entry's refusal is (kernel/index.ts · runCouncilOne, councilEnterRefusal):
 * the entry did not confirm the attempt's copies, and nothing ran.
 */
export const COUNCIL_GATE_REFUSAL = 'colloq gate: this request was not run, as no entry opened the gate for it'

/** Whether an attempt's error is the gate's refusal (and not the guard's, which shares its exception's name). */
export function isGateRefusal(ename: string, evalue: string): boolean {
  return ename === COUNCIL_GATE_REFUSED && evalue === COUNCIL_GATE_REFUSAL
}

/**
 * The module, `colloq_gate.py`. Its API: `open_for(token)`, `close()`,
 * `installed()` (true while the kernel's `do_execute` is its wrapper). It
 * binds no name in the user's namespace: the refused code is one
 * expression that raises, and the module lives in `sys.modules` alone.
 */
export const COUNCIL_GATE_PYTHON = `"""The gate of a Colloq council worker's kernel (remote-classes.md §9.6).

A worker gets an attempt's entry, the attempt and its exit in one batch, and
the kernel runs them in order. A non-silent request runs only when the gate
was opened for the token its metadata carries (\`${COUNCIL_GATE_RUN_KEY}\`), and an
opening is spent by that one request. Any other non-silent request is not
run: its code is swapped for a call that raises ${COUNCIL_GATE_REFUSED}, so its reply
is an ordinary error. Silent requests always pass. The entry closes the gate
first thing and opens it as its last step when its copies are ready; an
opening whose silent request does not end ok in full is taken back as that
request ends. A request with no token runs while no entry has shut or
opened the gate in this process: a home that does not know the gate sends
none, and its entry never touches it.

Loaded as an IPython extension at the kernel's start, by the system config
the machine's agent mounts into every council container: every process of a
worker is born gated, so a request that outlived a dead process and reaches
the next one is refused there. No name of it is bound in the user's namespace.
"""
import inspect

# token: the opening (None: shut); opened: openings made so far; armed: an entry has shut or opened the gate in this process.
_state = {'token': None, 'opened': 0, 'armed': False, 'kernel': None, 'wrapper': None}

# What a refused request runs instead: one expression that raises.
_REFUSAL = "__import__('${COUNCIL_GATE_MODULE}')._refuse()"


class ${COUNCIL_GATE_REFUSED}(Exception):
    """The request did not run: no entry opened the gate for it."""


def open_for(token):
    """Let the next non-silent request through if its metadata carries this token: once."""
    _state['armed'] = True
    _state['opened'] += 1
    _state['token'] = token if isinstance(token, str) and token else None


def close():
    """Let no non-silent request through until the next opening."""
    _state['armed'] = True
    _state['token'] = None


def installed():
    """Whether this kernel's requests go through the gate now."""
    kernel = _state['kernel']
    wrapper = _state['wrapper']
    return kernel is not None and wrapper is not None and getattr(kernel, 'do_execute', None) is wrapper


def _refuse():
    raise ${COUNCIL_GATE_REFUSED}(${JSON.stringify(COUNCIL_GATE_REFUSAL)})


def _token(kernel, meta):
    """The token a request carries: in the metadata ipykernel hands do_execute, else in the shell's parent message."""
    if meta is None:
        try:
            parent = kernel.get_parent('shell')
        except Exception:
            parent = None
        meta = parent.get('metadata') if isinstance(parent, dict) else None
    token = meta.get('${COUNCIL_GATE_RUN_KEY}') if isinstance(meta, dict) else None
    return token if isinstance(token, str) else None


def _whole(reply):
    """Whether a request's reply says it ran in full: its status ok, and so every expression asked of it."""
    if not isinstance(reply, dict) or reply.get('status') != 'ok':
        return False
    values = reply.get('user_expressions') or {}
    return all(isinstance(value, dict) and value.get('status') == 'ok' for value in values.values())


def _settle(reply, opened):
    """An opening made during a silent request stands only if its reply is whole: home reads the entry's report as held then."""
    if _state['opened'] != opened and not _whole(reply):
        _state['token'] = None


async def _settled(pending, opened):
    try:
        reply = await pending
    except BaseException:
        _settle(None, opened)
        raise
    _settle(reply, opened)
    return reply


def load_ipython_extension(ip):
    kernel = getattr(ip, 'kernel', None)
    # A terminal IPython has no kernel to gate; a second load changes nothing.
    if kernel is None or installed():
        return
    original = kernel.do_execute
    try:
        params = list(inspect.signature(original).parameters.values())
        named = set(p.name for p in params if p.kind in (p.POSITIONAL_OR_KEYWORD, p.KEYWORD_ONLY))
        anything = any(p.kind == p.VAR_KEYWORD for p in params)
    except (TypeError, ValueError):
        named, anything = set(), True

    def gated(*args, **kwargs):
        silent = kwargs['silent'] if 'silent' in kwargs else (len(args) > 1 and args[1])
        meta = kwargs.get('cell_meta')
        if not anything:
            # Only what the method takes: ipykernel chose its arguments by the method it wrapped.
            for name in ('cell_meta', 'cell_id'):
                if name in kwargs and name not in named:
                    del kwargs[name]
        if silent:
            opened = _state['opened']
            try:
                reply = original(*args, **kwargs)
            except BaseException:
                _settle(None, opened)
                raise
            if inspect.isawaitable(reply):
                return _settled(reply, opened)
            _settle(reply, opened)
            return reply
        token = _state['token']
        _state['token'] = None
        carried = _token(kernel, meta)
        # Held to the gate: a request with a token always, one without once an entry has touched the gate.
        if (carried is not None or _state['armed']) and (token is None or carried != token):
            if args:
                args = (_REFUSAL,) + tuple(args[1:])
            else:
                kwargs['code'] = _REFUSAL
            if 'user_expressions' in kwargs:
                kwargs['user_expressions'] = {}
            elif len(args) > 3:
                args = tuple(args[:3]) + ({},) + tuple(args[4:])
        return original(*args, **kwargs)

    kernel.do_execute = gated
    _state['kernel'] = kernel
    _state['wrapper'] = gated
`

/**
 * The system IPython config, `ipython_kernel_config.py`: the gate's folder
 * first on `sys.path`, and the module loaded through `extra_extensions`
 * (see the head of this file).
 */
export const COUNCIL_GATE_CONFIG = `# Colloq (remote-classes.md §9.6): every kernel of a council container is born with the gate.
import sys as _colloq_sys
if ${JSON.stringify(COUNCIL_GATE_MOUNT)} not in _colloq_sys.path:
    _colloq_sys.path.insert(0, ${JSON.stringify(COUNCIL_GATE_MOUNT)})
c = get_config()  # noqa: F821
c.InteractiveShellApp.extra_extensions = [${JSON.stringify(COUNCIL_GATE_MODULE)}]
`

/** The module's file name inside its folder (COUNCIL_GATE_MOUNT). */
export const COUNCIL_GATE_FILE = `${COUNCIL_GATE_MODULE}.py`

/** The two files' own hash: the name of the agent's folder that holds them (written once, never changed in place). */
export const COUNCIL_GATE_DIGEST = createHash('sha256').update(COUNCIL_GATE_PYTHON).update('\0').update(COUNCIL_GATE_CONFIG).digest('hex')
