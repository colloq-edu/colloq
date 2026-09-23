#!/usr/bin/env python3
"""Platform wheels: the universal wheel plus Node and ready node_modules.

  python3 scripts/platform-wheels.py build [--target darwin-arm64 ...]
  python3 scripts/platform-wheels.py smoke --wheel python/dist/colloq-…-macosx_14_0_arm64.whl
  make wheels

Why. The universal wheel (make wheel) asks the teacher for Node 22+ and, on
the first run, installs node_modules with npm: a minute or two, and network
access to GitHub. Jupyter asks for none of that; Python is enough. A platform
wheel carries everything itself: Node (pinned in scripts/node-runtime.json,
checked by sha256) and the server's node_modules, installed by `npm ci` from
the root package-lock.json, so exactly the versions the tests ran against.
After `pip install colloq` on macOS and Linux x64/arm64, only Docker is left.

All four wheels are built on one machine. The server has two native
dependencies, and both ship as prebuilt binaries rather than being compiled:
better-sqlite3 13 carries prebuilds/<platform>.node for every platform inside
the package, and @resvg/resvg-js has one optionalDependency per platform,
which `npm ci --os --cpu --libc` selects. Install scripts never run
(--ignore-scripts): there is nothing to compile, and compiling for the build
machine instead of the target would break silently. That is why, after the
install, every .node file and Node itself are checked by their header
(Mach-O/ELF and architecture) against the target; a mismatch means no wheel.

The universal wheel stays and is published alongside. pip picks the most
specific matching tag, so macOS 13, Alpine, Windows and everything else get
the universal wheel and the system Node, as before.

Tags. Node 24 needs macOS 13.5 and glibc 2.28 (BUILDING.md). For macOS 11
and later pip only generates whole-version tags (macosx_13_0, macosx_14_0),
so the macOS wheels are tagged 14_0: 13_0 would let in 13.0-13.4, where Node
does not start. Linux wheels are manylinux_2_28.

The build is deterministic: file order, modes and zip dates are fixed (the
date is SOURCE_DATE_EPOCH), so two runs on one commit give the same bytes.
"""

from __future__ import annotations

import argparse
import base64
import csv
import hashlib
import io
import json
import os
import shutil
import stat
import subprocess
import tarfile
import tempfile
import time
import urllib.error
import urllib.request
import venv
import zipfile
from dataclasses import dataclass
from pathlib import Path
from typing import Dict, NoReturn, Optional, Tuple

ROOT = Path(__file__).resolve().parent.parent
PIN = ROOT / "scripts" / "node-runtime.json"
APP = "colloq/_app"


@dataclass(frozen=True)
class Target:
    #: The same name Node (node-v…-<name>.tar.gz) and better-sqlite3
    #: (prebuilds/<name>.node) use.
    name: str
    #: The platform part of the wheel tag.
    tag: str
    npm_os: str
    npm_cpu: str
    libc: Optional[str]
    #: What the header of every binary has to say: format and machine.
    binary: Tuple[str, str]


TARGETS: Dict[str, Target] = {
    t.name: t
    for t in (
        Target("darwin-arm64", "macosx_14_0_arm64", "darwin", "arm64", None, ("macho", "arm64")),
        Target("darwin-x64", "macosx_14_0_x86_64", "darwin", "x64", None, ("macho", "x86_64")),
        Target("linux-x64", "manylinux_2_28_x86_64", "linux", "x64", "glibc", ("elf", "x86_64")),
        Target("linux-arm64", "manylinux_2_28_aarch64", "linux", "arm64", "glibc", ("elf", "aarch64")),
    )
}


def say(line: str) -> None:
    print(line, flush=True)


def fail(line: str) -> NoReturn:
    raise SystemExit("platform-wheels: " + line)


# -------------------------------------------------------------------- binaries


def binary_kind(head: bytes) -> Optional[Tuple[str, str]]:
    """Format and machine from the first bytes of a file; None if not a binary.

    64-bit Mach-O (little-endian): magic cf fa ed fe, then the 4-byte cputype.
    64-bit little-endian ELF: e_machine is the two bytes at offset 18.
    Fat Mach-O (cafebabe) does not occur here, since Node and the prebuilds
    are single-architecture, and such a file is simply not recognised.
    """
    if head[:4] == b"\xcf\xfa\xed\xfe" and len(head) >= 8:
        cpu = int.from_bytes(head[4:8], "little")
        return ("macho", {0x01000007: "x86_64", 0x0100000C: "arm64"}.get(cpu, hex(cpu)))
    if head[:4] == b"\x7fELF" and len(head) >= 20 and head[4] == 2 and head[5] == 1:
        machine = int.from_bytes(head[18:20], "little")
        return ("elf", {62: "x86_64", 183: "aarch64"}.get(machine, str(machine)))
    return None


# ------------------------------------------------------------------------ Node


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1 << 20), b""):
            digest.update(chunk)
    return digest.hexdigest()


def node_runtime(target: Target, cache: Path) -> Tuple[bytes, bytes, str]:
    """The Node binary and its LICENSE, from the pinned archive checked by sha256."""
    pin = json.loads(PIN.read_text(encoding="utf-8"))
    version = pin["version"]
    entry = pin["archives"].get(target.name)
    if not entry:
        fail("%s has no archive for %s" % (PIN.name, target.name))
    cache.mkdir(parents=True, exist_ok=True)
    archive = cache / entry["file"]
    if not archive.is_file() or sha256_file(archive) != entry["sha256"]:
        url = "https://nodejs.org/dist/%s/%s" % (version, entry["file"])
        say("  downloading %s" % url)
        partial = archive.with_suffix(archive.suffix + ".part")
        with urllib.request.urlopen(url, timeout=120) as response, partial.open("wb") as out:
            shutil.copyfileobj(response, out)
        partial.replace(archive)
    got = sha256_file(archive)
    if got != entry["sha256"]:
        archive.unlink()
        fail("%s: sha256 is %s, the pin says %s" % (entry["file"], got, entry["sha256"]))
    top = entry["file"][: -len(".tar.gz")]
    with tarfile.open(archive, "r:gz") as tar:
        node = tar.extractfile("%s/bin/node" % top)
        license_file = tar.extractfile("%s/LICENSE" % top)
        if node is None or license_file is None:
            fail("%s: no bin/node or LICENSE" % entry["file"])
        return node.read(), license_file.read(), version


# ---------------------------------------------------------------- node_modules


def node_modules(target: Target, work: Path) -> Path:
    """The server's production dependencies for the target: `npm ci` from the root lock.

    Every workspace manifest is copied: `npm ci` checks the lock against the
    whole tree, not one workspace. The server's dependencies are all hoisted
    to the root node_modules in the lock (there is no server/node_modules),
    and the app layout mirrors that: both server/dist and cli/ find them in
    _app/node_modules.
    """
    manifests = work / ("npm-" + target.name)
    shutil.rmtree(manifests, ignore_errors=True)
    manifests.mkdir(parents=True)
    root_pkg = json.loads((ROOT / "package.json").read_text(encoding="utf-8"))
    for name in ("package.json", "package-lock.json", ".npmrc"):
        if (ROOT / name).is_file():
            shutil.copy2(ROOT / name, manifests / name)
    for workspace in root_pkg.get("workspaces", []):
        (manifests / workspace).mkdir(parents=True, exist_ok=True)
        shutil.copy2(ROOT / workspace / "package.json", manifests / workspace / "package.json")
    server = json.loads((ROOT / "server/package.json").read_text(encoding="utf-8"))["name"]
    args = [
        "npm",
        "ci",
        "--omit=dev",
        "--workspace=" + server,
        "--ignore-scripts",
        "--no-audit",
        "--no-fund",
        "--loglevel=error",
        "--os=" + target.npm_os,
        "--cpu=" + target.npm_cpu,
    ]
    if target.libc:
        args.append("--libc=" + target.libc)
    done = subprocess.run(args, cwd=str(manifests), stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
    if done.returncode != 0:
        fail("npm ci for %s failed:\n%s" % (target.name, done.stdout))
    modules = manifests / "node_modules"
    prune(modules, target)
    return modules


def prune(modules: Path, target: Target) -> None:
    """Drop what is never loaded at run time, and every symlink.

    A wheel cannot hold symlinks: zip does not store them, and pip would write
    a file containing the link target instead. There are two kinds here:
    node_modules/.bin (launchers of other packages' CLIs) and the workspace
    link @colloq/server -> ../../server.

    better-sqlite3 loads only prebuilds/<target>.node. The SQLite sources
    (deps, src, binding.gyp) are for compiling, and the other platforms'
    binaries belong in the other wheels. @types is nothing but .d.ts files.
    """
    for link in sorted(modules.rglob(".bin"), reverse=True):
        if link.is_symlink() or link.is_file():
            link.unlink()
        elif link.is_dir():
            shutil.rmtree(link)
    shutil.rmtree(modules / "@colloq", ignore_errors=True)
    # @types can be nested too (openai/node_modules/@types).
    for types in sorted(modules.rglob("@types"), reverse=True):
        if types.is_dir() and types.parent.name == "node_modules":
            shutil.rmtree(types)
    sqlite = modules / "better-sqlite3"
    for gone in ("deps", "src"):
        shutil.rmtree(sqlite / gone, ignore_errors=True)
    (sqlite / "binding.gyp").unlink(missing_ok=True)
    prebuilds = sqlite / "prebuilds"
    if prebuilds.is_dir():
        for item in prebuilds.iterdir():
            if item.name != target.name + ".node":
                item.unlink()
    links = [p for p in modules.rglob("*") if p.is_symlink()]
    if links:
        fail("symlinks left in node_modules: %s" % ", ".join(str(p.relative_to(modules)) for p in links[:5]))


def verify(target: Target, node: bytes, modules: Path) -> None:
    """Every binary is built for the target, and both native modules are there."""
    want = target.binary
    got = binary_kind(node[:64])
    if got != want:
        fail("Node for %s turned out to be %s, not %s" % (target.name, got, want))
    natives = sorted(p for p in modules.rglob("*.node") if p.is_file())
    names = [p.relative_to(modules).as_posix() for p in natives]
    if "better-sqlite3/prebuilds/%s.node" % target.name not in names:
        fail("%s: no better-sqlite3/prebuilds/%s.node" % (target.name, target.name))
    if not any(name.startswith("@resvg/resvg-js-") for name in names):
        fail("%s: npm installed no platform package @resvg/resvg-js-*" % target.name)
    for path, name in zip(natives, names):
        with path.open("rb") as handle:
            kind = binary_kind(handle.read(64))
        if kind != want:
            fail("%s: %s is built as %s, not %s" % (target.name, name, kind, want))


# ----------------------------------------------------------------------- wheel


def zip_time(epoch: int) -> Tuple[int, int, int, int, int, int]:
    # zip has no dates before 1980.
    return time.gmtime(max(epoch, 315532800))[:6]  # type: ignore[return-value]


def record_hash(data: bytes) -> str:
    return "sha256=" + base64.urlsafe_b64encode(hashlib.sha256(data).digest()).rstrip(b"=").decode()


def retag(wheel_meta: str, tag: str) -> str:
    """WHEEL with the new tag. A platform wheel is not purelib."""
    lines = []
    for line in wheel_meta.splitlines():
        if line.startswith("Tag:"):
            continue
        if line.startswith("Root-Is-Purelib:"):
            line = "Root-Is-Purelib: false"
        lines.append(line)
    while lines and not lines[-1].strip():
        lines.pop()
    lines.append("Tag: py3-none-" + tag)
    return "\n".join(lines) + "\n\n"


def repack(
    universal: Path,
    target: Target,
    node: bytes,
    node_license: bytes,
    node_version: str,
    modules: Path,
    out: Path,
    epoch: int,
) -> Path:
    """Universal wheel + Node + node_modules -> a wheel tagged for the target."""
    stem = universal.name[: -len(".whl")].split("-")
    if len(stem) != 5 or stem[2:] != ["py3", "none", "any"]:
        fail("%s is not a universal py3-none-any wheel" % universal.name)
    name, version = stem[0], stem[1]
    files: Dict[str, Tuple[bytes, int]] = {}
    with zipfile.ZipFile(universal) as source:
        dist_info = next(
            (n.split("/")[0] for n in source.namelist() if n.endswith(".dist-info/WHEEL")), None
        )
        if not dist_info:
            fail("%s: no .dist-info/WHEEL" % universal.name)
        for info in source.infolist():
            if info.is_dir() or info.filename in (dist_info + "/RECORD", dist_info + "/WHEEL"):
                continue
            mode = (info.external_attr >> 16) & 0o777
            files[info.filename] = (source.read(info), mode or 0o644)
        wheel_meta = source.read(dist_info + "/WHEEL").decode("utf-8")
    for required in (APP + "/package.json", APP + "/.colloq-dist.json"):
        if required not in files:
            fail("%s: no %s; was it built by make wheel?" % (universal.name, required))

    files[APP + "/bin/node"] = (node, 0o755)
    files[APP + "/bin/node.LICENSE"] = (node_license, 0o644)
    for path in sorted(modules.rglob("*")):
        if path.is_file():
            mode = 0o755 if path.stat().st_mode & 0o111 else 0o644
            files["%s/node_modules/%s" % (APP, path.relative_to(modules).as_posix())] = (path.read_bytes(), mode)
    # The "node_modules are installed" stamp is the very one the shim writes
    # after npm install (python/colloq/__main__.py: _wanted, _ready): version
    # and dependencies from _app/package.json. With it the first run installs
    # nothing.
    app_pkg = json.loads(files[APP + "/package.json"][0])
    wanted = {"version": app_pkg.get("version"), "dependencies": app_pkg.get("dependencies", {})}
    files[APP + "/.node-modules.json"] = (json.dumps(wanted, ensure_ascii=False, indent=2).encode(), 0o644)
    dist = json.loads(files[APP + "/.colloq-dist.json"][0])
    dist["bundled"] = {
        "target": target.name,
        "node": node_version,
        "nodeModules": "npm ci --omit=dev from package-lock.json (scripts/platform-wheels.py)",
    }
    files[APP + "/.colloq-dist.json"] = (
        (json.dumps(dist, ensure_ascii=False, indent=2) + "\n").encode(),
        0o644,
    )
    files[dist_info + "/WHEEL"] = (retag(wheel_meta, target.tag).encode(), 0o644)

    # Package files in order, .dist-info at the end, RECORD last.
    order = sorted(n for n in files if not n.startswith(dist_info + "/"))
    order += sorted(n for n in files if n.startswith(dist_info + "/"))
    record = io.StringIO()
    writer = csv.writer(record, lineterminator="\n")
    for arcname in order:
        data = files[arcname][0]
        writer.writerow([arcname, record_hash(data), str(len(data))])
    writer.writerow([dist_info + "/RECORD", "", ""])
    files[dist_info + "/RECORD"] = (record.getvalue().encode(), 0o644)
    order.append(dist_info + "/RECORD")

    out.mkdir(parents=True, exist_ok=True)
    result = out / ("%s-%s-py3-none-%s.whl" % (name, version, target.tag))
    partial = result.with_suffix(".whl.part")
    stamp = zip_time(epoch)
    with zipfile.ZipFile(partial, "w", zipfile.ZIP_DEFLATED) as wheel:
        for arcname in order:
            data, mode = files[arcname]
            info = zipfile.ZipInfo(arcname, date_time=stamp)
            info.compress_type = zipfile.ZIP_DEFLATED
            info.create_system = 3
            info.external_attr = (stat.S_IFREG | mode) << 16
            wheel.writestr(info, data)
    partial.replace(result)
    return result


def human(size: int) -> str:
    return "%.1f MB" % (size / 1e6)


def build(args: argparse.Namespace) -> None:
    universal = Path(args.wheel) if args.wheel else None
    if universal is None:
        found = sorted((ROOT / "python/dist").glob("*-py3-none-any.whl"))
        if len(found) != 1:
            fail("python/dist holds %d universal wheels, not one: run make wheel" % len(found))
        universal = found[0]
    out = Path(args.out) if args.out else universal.parent
    targets = [TARGETS[name] for name in (args.target or list(TARGETS))]
    epoch = int(os.environ.get("SOURCE_DATE_EPOCH") or 315532800)
    cache = Path(args.cache or os.environ.get("COLLOQ_NODE_CACHE") or Path.home() / ".cache/colloq/node")
    with tempfile.TemporaryDirectory(prefix="colloq-wheels-") as scratch:
        for target in targets:
            say("%s:" % target.name)
            node, node_license, node_version = node_runtime(target, cache)
            modules = node_modules(target, Path(scratch))
            verify(target, node, modules)
            wheel = repack(universal, target, node, node_license, node_version, modules, out, epoch)
            shutil.rmtree(modules.parent, ignore_errors=True)
            say("  %s  %s" % (wheel.name, human(wheel.stat().st_size)))


# ----------------------------------------------------------------------- smoke


def smoke(args: argparse.Namespace) -> None:
    """Install the wheel into a clean venv and run it on this machine.

    The system Node is kept off PATH: the wheel has to work with its own.
    Checks: the shim picks the bundled Node, `colloq --version` answers (shim
    -> Node -> CLI), both native modules load, and the server comes up to
    /api/health with the stand-in kernel backend, without Docker.
    """
    wheel = Path(args.wheel).resolve()
    with tempfile.TemporaryDirectory(prefix="colloq-smoke-") as scratch:
        base = Path(scratch)
        venv.EnvBuilder(with_pip=True).create(str(base / "venv"))
        bindir = base / "venv" / ("Scripts" if os.name == "nt" else "bin")
        subprocess.run([str(bindir / "python"), "-m", "pip", "install", "--quiet", str(wheel)], check=True)
        path = os.pathsep.join([str(bindir), "/usr/bin", "/bin"])
        env = {
            "PATH": path,
            "HOME": str(base / "home"),
            "COLLOQ_HOME": str(base / "colloq"),
            "NO_COLOR": "1",
        }
        version = subprocess.run(
            [str(bindir / "colloq"), "--version"], env=env, stdout=subprocess.PIPE, text=True, check=True
        ).stdout.strip()
        site = subprocess.run(
            [str(bindir / "python"), "-c", "import colloq, os; print(os.path.dirname(colloq.__file__))"],
            stdout=subprocess.PIPE,
            text=True,
            check=True,
        ).stdout.strip()
        app = Path(site) / "_app"
        node = app / "bin" / "node"
        if not os.access(str(node), os.X_OK):
            fail("%s: bin/node is not executable after pip install" % wheel.name)
        # The shim must choose its own Node, not one found at a well-known
        # path: /opt/homebrew/bin/node on a build machine would silently stand in.
        chosen = subprocess.run(
            [str(bindir / "python"), "-c", "from colloq.__main__ import find_node; print(find_node())"],
            env=env,
            stdout=subprocess.PIPE,
            text=True,
            check=True,
        ).stdout.strip()
        if Path(chosen).resolve() != node.resolve():
            fail("the shim chose %s, not the Node from the wheel" % chosen)
        probe = (
            "const Database = require('better-sqlite3');"
            "const row = new Database(':memory:').prepare('select 1 + 1 as two').get();"
            "if (row.two !== 2) throw new Error('sqlite');"
            "const { Resvg } = require('@resvg/resvg-js');"
            "const svg = '<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"4\" height=\"4\"/>';"
            "if (new Resvg(svg).render().asPng().length < 8) throw new Error('resvg');"
            "console.log(process.version, process.platform, process.arch);"
        )
        said = subprocess.run(
            [str(node), "-e", probe], cwd=str(app), env=env, stdout=subprocess.PIPE, text=True, check=True
        ).stdout.strip()
        port = args.port
        server_env = dict(
            env,
            PORT=str(port),
            BIND_ADDR="127.0.0.1",
            NODE_ENV="test",
            KERNEL_BACKEND="test",
            DATA_DIR=str(base / "data"),
            WORKSPACE_DIR=str(base / "workspace"),
            STATIC_DIR=str(app / "web" / "dist"),
        )
        server = subprocess.Popen(
            [str(node), str(app / "server" / "dist" / "server.js")],
            cwd=str(app),
            env=server_env,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
        )
        try:
            health = None
            deadline = time.time() + 60
            while time.time() < deadline and server.poll() is None:
                try:
                    with urllib.request.urlopen("http://127.0.0.1:%d/api/health" % port, timeout=2) as response:
                        health = json.loads(response.read())
                        break
                except urllib.error.HTTPError as refused:
                    # 503 without a kernel is expected here: there is no
                    # Jupyter or Docker. The body is the same and has
                    # everything this check needs.
                    health = json.loads(refused.read() or b"{}")
                    break
                except OSError:
                    time.sleep(0.5)
            if health is None:
                server.kill()
                fail("the server did not answer /api/health:\n%s" % (server.communicate()[0] or "")[-4000:])
            if health.get("version") != version:
                fail("/api/health says version %r, colloq --version says %r" % (health.get("version"), version))
            # The database is better-sqlite3 inside the server; the workspace is the files.
            for part in ("database", "workspace"):
                if health.get(part) is not True:
                    fail("/api/health: %s = %r\n%s" % (part, health.get(part), json.dumps(health)[:800]))
        finally:
            if server.poll() is None:
                server.terminate()
                try:
                    server.wait(timeout=20)
                except subprocess.TimeoutExpired:
                    server.kill()
        say("  %s: colloq %s · node %s · /api/health ok" % (wheel.name, version, said))


def main() -> None:
    parser = argparse.ArgumentParser(description="Colloq platform wheels: Node and node_modules inside.")
    commands = parser.add_subparsers(dest="command", required=True)
    make = commands.add_parser("build", help="build them from the universal wheel (make wheel)")
    make.add_argument("--wheel", help="the universal wheel; by default the only one in python/dist")
    make.add_argument("--target", action="append", choices=sorted(TARGETS), help="a target; all by default")
    make.add_argument("--out", help="where to put them; next to the universal wheel by default")
    make.add_argument("--cache", help="cache of Node archives; ~/.cache/colloq/node by default")
    check = commands.add_parser("smoke", help="install a wheel into a clean venv and run it")
    check.add_argument("--wheel", required=True)
    check.add_argument("--port", type=int, default=39317)
    args = parser.parse_args()
    if args.command == "build":
        build(args)
    else:
        smoke(args)


if __name__ == "__main__":
    main()
