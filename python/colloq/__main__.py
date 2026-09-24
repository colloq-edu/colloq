"""Shim: find Node, install node_modules on the first run, hand over to the CLI.

Nothing else happens here, on purpose. The class logic (building, kernels,
ports, the tunnel, stopping) lives in the CLI (_app/cli/colloq.mjs, built from
cli/src) and in the class supervisor, which `npm run dev` in the repository
uses too. A second, Python layer of rules would mean two programs for one
job, and both would need fixing.

What the shim does, step by step:

  1. takes the Node that came in the wheel: the macOS and Linux wheels carry
     it in _app/bin/node together with ready node_modules
     (scripts/platform-wheels.py). The universal wheel has none, and then it
     looks for node — first in PATH, then where installers put it — and checks
     the version is at least 22 (better-sqlite3 13 declares node >=22, and on
     18 the server fails mid-class, not at start);
  2. if there are no node_modules next to the app, installs them once with
     npm and says so out loud: a silent minute on the first run reads as
     "it hung". A platform wheel already has them, and npm is not needed;
  3. sets COLLOQ_APP_DIR (where the app lives) and COLLOQ_CWD (where it was
     called from), and puts the chosen node's directory first in PATH:
     host.sh and the port probe call `node` by name, and a teacher with a
     platform wheel may have no Node of their own;
  4. replaces itself with the Node process via execve, so that Ctrl+C goes
     straight to the CLI and the exit code comes straight from it. A
     supervising middle layer would break both: Ctrl+C in class means "save
     and stop the class", and it has to reach whoever can do that.
"""

from __future__ import annotations

import json
import os
import re
import shutil
import subprocess
import sys
import time
from pathlib import Path
from typing import Iterator, NoReturn, Optional, Tuple

#: The application lies inside the package: that is how scripts/pack.mts puts
#: it into the wheel.
APP = Path(__file__).resolve().parent / "_app"
ENTRY = APP / "cli" / "colloq.mjs"
MARK = APP / ".colloq-dist.json"
STAMP = APP / ".node-modules.json"
#: Node from a platform wheel. The universal wheel has none.
BUNDLED_NODE = APP / "bin" / ("node.exe" if os.name == "nt" else "node")
LOCK = APP / ".node-modules.lock"

#: Nothing below 22: better-sqlite3 13 declares node >=22 (server/package.json),
#: and that is also the image version in the Dockerfile. Since 13 it is on
#: N-API: one prebuilt binary for every Node version above, so the teacher never
#: faces a rebuild for "their own" Node.
MIN_NODE = 22
#: How long to wait for another install before treating the lock as abandoned.
LOCK_WAIT_SEC = 900
#: Words for which there is no point installing the environment: they only
#: tell. `colloq --help` right after installation is the most common first
#: action, and a minute of npm in reply to a request to list the commands would
#: be a mockery. The CLI itself is built without a single external dependency
#: (scripts/pack.mts guards that), so it has something to answer with even
#: without node_modules.
#:
#: A bare `colloq` is NOT in this list, even though it also only tells. It is
#: the first thing people type after `pip install colloq`, and that is the best
#: moment for the one-time minute: a class starts with `colloq start`, and by
#: then there is no time left to wait: minutes remain before the class, not an
#: evening.
TELLING = frozenset(["--help", "-h", "help", "--version", "-V"])


def fail(*lines: str) -> NoReturn:
    """Refuse in words, without a traceback: nobody here would read it."""
    for line in lines:
        print(line, file=sys.stderr, flush=True)
    raise SystemExit(3)


def _version_key(path: Path) -> Tuple[int, ...]:
    """Sort key for directories like node-20.11.1: by numbers, not as a string."""
    numbers = re.findall(r"\d+", str(path))
    return tuple(int(number) for number in numbers[-3:]) or (0,)


def _candidates() -> Iterator[str]:
    """Where node tends to be, in order of decreasing trust.

    PATH first: if the teacher installed Node themselves, they expect exactly
    their own. Then the usual installer locations: Homebrew, for one, puts node
    into /opt/homebrew/bin, which is not in PATH for processes started outside
    a shell, and a pip script may well be started from anything. Version
    managers (nvm, fnm, volta, asdf) are tried last and from the highest
    version down: with them node appears in PATH only after `source`, and
    without this list `colloq` in a fresh terminal would say "install Node" to
    someone who has it installed.
    """
    found = shutil.which("node")
    if found:
        yield found
    for fixed in (
        "/opt/homebrew/bin/node",
        "/usr/local/bin/node",
        "/usr/bin/node",
        "/opt/local/bin/node",
        "/snap/bin/node",
    ):
        yield fixed
    home = Path.home()
    for pattern in (
        ".nvm/versions/node/*/bin/node",
        ".local/share/fnm/node-versions/*/installation/bin/node",
        ".fnm/node-versions/*/installation/bin/node",
        ".volta/tools/image/node/*/bin/node",
        ".asdf/installs/nodejs/*/bin/node",
    ):
        for path in sorted(home.glob(pattern), key=_version_key, reverse=True):
            yield str(path)


def _node_version(node: str) -> Optional[Tuple[int, int, int]]:
    try:
        done = subprocess.run(
            [node, "--version"], capture_output=True, text=True, timeout=15
        )
    except (OSError, subprocess.SubprocessError):
        return None
    match = re.match(r"v(\d+)\.(\d+)\.(\d+)", (done.stdout or "").strip())
    if done.returncode != 0 or not match:
        return None
    return (int(match.group(1)), int(match.group(2)), int(match.group(3)))


def _bundled_node() -> Optional[str]:
    """The Node from the wheel, if there is one and it runs on this machine.

    If it does not run (say, macOS is older than this Node needs and the
    wheel was installed by hand past its tag), fall back to the system Node:
    the node_modules in the wheel are N-API builds and work with it too.
    """
    if not BUNDLED_NODE.is_file():
        return None
    path = str(BUNDLED_NODE)
    if not os.access(path, os.X_OK):
        # An installer that dropped the executable bit is no reason to refuse.
        try:
            os.chmod(path, 0o755)
        except OSError:
            return None
    version = _node_version(path)
    return path if version and version[0] >= MIN_NODE else None


def find_node() -> str:
    """The Node from the wheel, or else the first working node not older than MIN_NODE.

    The case "node is there, but old" is handled separately: telling such a
    person "Node not found" means sending them to install for the second time
    what they already have, and to wonder why it does not help.
    """
    bundled = _bundled_node()
    if bundled:
        return bundled
    seen = set()
    old: Optional[str] = None
    for candidate in _candidates():
        if candidate in seen:
            continue
        seen.add(candidate)
        if not os.path.isfile(candidate) or not os.access(candidate, os.X_OK):
            continue
        version = _node_version(candidate)
        if version is None:
            continue
        if version[0] >= MIN_NODE:
            return candidate
        if old is None:
            old = "%s (v%d.%d.%d)" % (candidate, version[0], version[1], version[2])
    if old:
        fail(
            "Node is too old: " + old,
            "Colloq needs Node %d or newer." % MIN_NODE,
            "macOS: brew install node · Debian/Ubuntu: see https://nodejs.org/en/download",
        )
    fail(
        "Node.js not found — Colloq cannot start without it.",
        "Node %d or newer is required." % MIN_NODE,
        "macOS: brew install node · Debian/Ubuntu: apt install nodejs (or https://nodejs.org/en/download)",
        "If Node is installed somewhere unusual, add it to PATH.",
    )


def find_npm(node: str) -> Optional[str]:
    """npm next to node or in PATH.

    Next to it first: with version managers (nvm, fnm) PATH may hold an npm
    from a completely different Node version, and installing native modules
    with a version they will never run under is a quiet breakage of
    better-sqlite3 out of nowhere.
    """
    names = ["npm.cmd", "npm"] if os.name == "nt" else ["npm"]
    for name in names:
        near = Path(node).parent / name
        if near.is_file():
            return str(near)
    for name in names:
        found = shutil.which(name)
        if found:
            return found
    return None


def _wanted() -> dict:
    """What node_modules must match: the app version and the dependency list.

    Compared in full, not as "the directory exists": after a wheel upgrade the
    application is new while the node_modules next to it are from the previous
    version, and they silently match by names but not by contents.
    """
    data = json.loads((APP / "package.json").read_text(encoding="utf-8"))
    return {
        "version": data.get("version"),
        "dependencies": data.get("dependencies", {}),
    }


def _ready(wanted: dict) -> bool:
    if not (APP / "node_modules").is_dir():
        return False
    try:
        return json.loads(STAMP.read_text(encoding="utf-8")) == wanted
    except (OSError, ValueError):
        return False


def _install(npm: str, wanted: dict) -> None:
    # flush on every line is not superstition. Next comes someone else's
    # process (npm), and at the end os.execve, which throws away the stdout
    # buffer without printing it: with output going to a file or a pipe both
    # of these lines vanished entirely, and the one-time minute of waiting
    # looked like a hang with no explanation.
    print("Installing Colloq's Node environment — once, a minute or two.", flush=True)
    # npm output only on failure. Its progress spinner and warnings
    # (install-scripts, deprecated packages) tell the teacher nothing, yet
    # they were exactly what the first screen after `pip install` showed.
    done = subprocess.run(
        [npm, "install", "--omit=dev", "--no-audit", "--no-fund", "--no-progress", "--loglevel=error"],
        cwd=str(APP),
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
        errors="replace",
    )
    if done.returncode != 0:
        tail = [line for line in (done.stdout or "").splitlines() if line.strip()][-25:]
        fail(
            "",
            *tail,
            "",
            "Could not install the Node environment (npm exited with %d)." % done.returncode,
            "Run it by hand: cd %s && npm install --omit=dev" % APP,
        )
    STAMP.write_text(json.dumps(wanted, ensure_ascii=False, indent=2), encoding="utf-8")
    print("Environment ready.\n", flush=True)


def ensure_modules(node: str) -> None:
    """node_modules next to the application: installed once, on this machine.

    A platform wheel (macOS, Linux x64/arm64) ships them with the STAMP, and
    nothing happens here. The universal wheel has none: better-sqlite3 and
    @resvg/resvg-js are native, and with them it would stop being one wheel
    for everyone. The price is a minute on the first run, said out loud
    rather than spent in silence.
    """
    wanted = _wanted()
    if _ready(wanted):
        return
    npm = find_npm(node)
    if not npm:
        fail(
            "No npm next to Node, and the server environment cannot be installed without it.",
            "npm normally ships with Node: check `npm --version`.",
            "What should happen: cd %s && npm install --omit=dev" % APP,
        )
    if not os.access(str(APP), os.W_OK):
        fail(
            "The application directory is read-only: %s" % APP,
            "The first run installs the server's node_modules there, so it needs to be writable.",
            "Install Colloq into an environment of your own (python3 -m venv ~/colloq && ~/colloq/bin/pip install colloq),",
            "or pip install --user colloq — and run it as yourself.",
        )
    # A lock in case of two terminals at once: npm in one directory from two
    # processes means half the tree from one and half from the other.
    deadline = time.time() + LOCK_WAIT_SEC
    while True:
        try:
            handle = os.open(str(LOCK), os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o644)
        except FileExistsError:
            if _ready(wanted):
                return
            try:
                stale = time.time() - LOCK.stat().st_mtime > LOCK_WAIT_SEC
            except OSError:
                stale = False
            if stale:
                LOCK.unlink(missing_ok=True)
                continue
            if time.time() > deadline:
                fail(
                    "Another process is already installing the Node environment, and it is taking too long.",
                    "If that process died, remove the lock: rm %s" % LOCK,
                )
            print("Another run is installing the Node environment — waiting…", flush=True)
            time.sleep(2)
            continue
        os.close(handle)
        try:
            if _ready(wanted):
                return
            _install(npm, wanted)
        finally:
            LOCK.unlink(missing_ok=True)
        return


def main() -> int:
    if not ENTRY.is_file() or not MARK.is_file():
        fail(
            "The package carries no built application (%s)." % APP,
            "That happens to a wheel built without `make pack`. Rebuild it: make wheel.",
        )
    node = find_node()
    arguments = sys.argv[1:]
    if not arguments or not set(arguments) & TELLING:
        ensure_modules(node)

    environment = dict(os.environ)
    # Where the application lies. Everything else, the class state, the CLI
    # finds by itself: it has COLLOQ_HOME for that.
    environment["COLLOQ_APP_DIR"] = str(APP)
    # The chosen node goes first in PATH: host.sh and the port probe
    # (cli/src/sh.ts) call `node` by name and would otherwise find another
    # one, or none.
    environment["PATH"] = os.path.dirname(node) + os.pathsep + environment.get("PATH", "")
    # The directory it was called from: relative paths in the arguments
    # (`colloq restore --db backups/…`) must be resolved against it, not
    # against the application.
    environment.setdefault("COLLOQ_CWD", os.getcwd())

    argv = [str(node), str(ENTRY)] + arguments
    # Before replacing the process, flush everything of our own: execve does
    # not return and writes nothing more.
    sys.stdout.flush()
    sys.stderr.flush()
    if os.name == "nt":
        # On Windows execve does not replace the process but spawns a second
        # one, and the parent returns immediately: there we have to wait for
        # the child by hand.
        return subprocess.call(argv, env=environment)
    os.execve(str(node), argv, environment)


if __name__ == "__main__":
    sys.exit(main())
