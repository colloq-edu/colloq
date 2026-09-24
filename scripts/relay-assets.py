#!/usr/bin/env python3
"""A mirror of the class's immutable static files on the relay itself.

Why. Everything a student sees used to travel through the tunnel from the
teacher's laptop: every /assets/*, every font, every piece of pdf.js, 598 KB
compressed for everyone who arrives, over the classroom Wi-Fi, through frpc,
through frps and back. Two hundred people at the bell are two hundred such
trips over one and the same channel, and they are what clogs it: while the
page loads, the room's sockets go through that same tunnel.

Yet the files are identical. Under /assets/* the name contains the content
hash (which is why they are served as immutable for a year), and /fonts/* and
/pdf/* change only with a deployment. So they can be kept on the relay and
served from there, leaving the tunnel to what it is there for: the live room.

    PUT /.relay/assets/<name>  ← tar.gz from web/dist: assets/, fonts/, pdf/
                                 Authorization: Bearer <shared secret>
                               → {"host", "files", "bytes", "kept", "skipped"}
    GET /.relay/assets/<name>  → {"host", "files", "bytes", "updated"}: what
                                 is in the mirror now (with the same secret)

Lives on the loopback (127.0.0.1:9182) behind caddy, which hands it the
/.relay/assets/* path on any name under its zone. The path starts with a dot:
no instance address looks like that, and the route takes nothing away from a
room. Installed by scripts/relay-setup.sh as the colloq-assets service under a
separate user; data in /var/lib/colloq-assets.

The files are served NOT by this service but by caddy, straight from the
directory (file_server with precompressed br gzip). A mirror miss is not a
failure: the Caddyfile has a `file` matcher, and if the file is not there the
request goes to the tunnel as before. An empty, stale or disabled mirror
breaks nothing; it only brings back the old speed.

Who owns what. The secret is the same as for frps: everyone entitled to take a
subdomain already has it. The name in the path must match the name the
request came by (X-Forwarded-Host from caddy), that is, hse.colloq.ru can
rewrite only its own mirror and only through its own tunnel address.

Why the standard library: the relay has neither node nor pip; it is a machine
with three daemons and a secret. Ubuntu always has python3.

    ROOT/<name>                → a symbolic link to sets/<name>/<stamp>
    ROOT/sets/<name>/<stamp>/   {assets,fonts,pdf}
    ROOT/.tmp/                  unpacking before the swap

The swap is a rename of the link: a request finds either the previous set
whole or the new one whole. Files of the previous set from assets/ younger
than 30 days are carried into the new one as a HARD LINK: a tab opened before
the deployment keeps loading its pieces by the old hashes for another month,
and that costs no space.

Checking by hand, without the relay:
    ASSETS_ROOT=/tmp/mirror ASSETS_PORT=9182 ASSETS_TOKEN_FILE=/tmp/token \
        ASSETS_DOMAIN=colloq.ru python3 scripts/relay-assets.py
Cleanup once a day (the colloq-assets-prune timer):
    python3 scripts/relay-assets.py --prune
"""

import hmac
import json
import os
import posixpath
import re
import shutil
import sys
import tarfile
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

ROOT = os.environ.get("ASSETS_ROOT", "/var/lib/colloq-assets")
PORT = int(os.environ.get("ASSETS_PORT", "9182"))
DOMAIN = os.environ.get("ASSETS_DOMAIN", "colloq.ru")
# The secret is read either from /etc/colloq-relay/token or, under systemd,
# from the credentials directory: LoadCredential= gives the service a copy of
# the file without letting it into the frps directory and without adding an
# extra group membership.
TOKEN_FILE = os.environ.get("ASSETS_TOKEN_FILE") or os.path.join(
    os.environ.get("CREDENTIALS_DIRECTORY", "/etc/colloq-relay"), "token"
)
PREFIX = "/.relay/assets/"
# What there is in web/dist at all that is worth mirroring. Everything else
# (index.html, robots.txt, service files) is served by the instance: the page is
# live and must not be cached.
DIRS = ("assets", "fonts", "pdf")
MAX_BYTES = int(os.environ.get("ASSETS_MAX_BYTES", str(64 * 1024 * 1024)))
MAX_FILES = int(os.environ.get("ASSETS_MAX_FILES", "4000"))
# How long the pieces of the previous build live. A month is headroom for a
# tab forgotten open through the whole stretch between sessions; names with a
# hash do not collide.
KEEP_DAYS = float(os.environ.get("ASSETS_KEEP_DAYS", "30"))
# How long to wait for a name that is no longer exposed before removing its
# mirror entirely. Twice the lifetime of the pieces: there is no reason to
# delete what live tabs still refer to.
FORGET_DAYS = KEEP_DAYS * 2

SETS = os.path.join(ROOT, "sets")
STAGE = os.path.join(ROOT, ".tmp")


def make_staging(host):
    """A fresh unpacking directory under STAGE: 0750 subject to umask, no chmod.

    The name has a random tail, like mkdtemp's; the one difference is that the
    mode is set at creation, so as not to touch the setgid bit inherited from
    STAGE.
    """
    import secrets
    for _ in range(100):
        path = os.path.join(STAGE, "%s-%s" % (host, secrets.token_hex(4)))
        try:
            os.mkdir(path, 0o750)
        except FileExistsError:
            continue
        return path
    raise RuntimeError("no free staging name")

# A file name inside the archive: letters, digits, dot, hyphen, underscore.
# Vite hashes, fonts and pdf.worker.min.mjs fit into that entirely, and
# anything else is a reason to refuse, not to figure it out.
PART = re.compile(r"[A-Za-z0-9_][A-Za-z0-9._-]*\Z")
HOST = re.compile(r"[a-z0-9][a-z0-9-]*\.%s\Z" % re.escape(DOMAIN))

_hosts = {}
_hosts_lock = threading.Lock()


def lock_for(host):
    # One lock per name: two deployments of the same seminar must not swap the
    # set out from under each other, while different seminars do not get in
    # each other's way.
    with _hosts_lock:
        if host not in _hosts:
            _hosts[host] = threading.Lock()
        return _hosts[host]


def secret():
    try:
        with open(TOKEN_FILE, "rb") as f:
            return f.read().strip()
    except OSError:
        return b""


class Reject(Exception):
    """A refusal with a code and a word for the log: the archive is not what was promised."""

    def __init__(self, code, why):
        super().__init__(why)
        self.code = code
        self.why = why


def checked_name(name):
    """A path inside the archive, or Reject. Returns None for what we skip."""
    normalized = posixpath.normpath(name)
    if normalized in (".", "/") or normalized.startswith("/") or "\x00" in normalized:
        raise Reject(400, "path")
    parts = normalized.split("/")
    if parts[0] not in DIRS:
        raise Reject(400, "prefix")
    for part in parts:
        if part == ".." or part == ".":
            raise Reject(400, "path")
        # Hidden files are neither mirrored nor a reason to refuse: a .DS_Store
        # from the teacher's laptop is no reason not to deploy the build.
        if part.startswith("."):
            return None
        if not PART.match(part):
            raise Reject(400, "name")
    if len(normalized) > 255 or len(parts) > 8:
        raise Reject(400, "name")
    return normalized


def unpack(stream, into):
    """Unpacking by our own hand: no links, no devices, no paths leading outside."""
    files = 0
    total = 0
    skipped = 0
    with tarfile.open(fileobj=stream, mode="r|gz") as tar:
        for member in tar:
            if member.isdir():
                inside = checked_name(member.name)
                if inside:
                    os.makedirs(os.path.join(into, inside), exist_ok=True)
                continue
            if not member.isreg():
                # A symbolic link in the archive is the cheapest way to make
                # caddy serve /etc/shadow disguised as a chunk.
                raise Reject(400, "kind")
            relative = checked_name(member.name)
            if relative is None:
                skipped += 1
                continue
            files += 1
            total += member.size
            if files > MAX_FILES:
                raise Reject(413, "files")
            if total > MAX_BYTES:
                raise Reject(413, "bytes")
            source = tar.extractfile(member)
            if source is None:
                raise Reject(400, "kind")
            target = os.path.join(into, relative)
            os.makedirs(os.path.dirname(target), exist_ok=True)
            fd = os.open(target, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o640)
            with os.fdopen(fd, "wb") as out:
                shutil.copyfileobj(source, out, 1 << 16)
    return files, total, skipped


def carry_over(previous, staging, now):
    """Pieces of the previous build younger than KEEP_DAYS go into the new set as hard links."""
    kept = 0
    old = os.path.join(previous, "assets")
    if not os.path.isdir(old):
        return kept
    cutoff = now - KEEP_DAYS * 86400
    for directory, _, names in os.walk(old):
        for name in names:
            source = os.path.join(directory, name)
            relative = os.path.relpath(source, previous)
            target = os.path.join(staging, relative)
            if os.path.exists(target):
                continue
            try:
                if os.lstat(source).st_mtime < cutoff:
                    continue
                os.makedirs(os.path.dirname(target), exist_ok=True)
                os.link(source, target)
            except OSError:
                continue
            kept += 1
    return kept


def current_set(host):
    link = os.path.join(ROOT, host)
    try:
        return os.path.realpath(link) if os.path.islink(link) else None
    except OSError:
        return None


def swap(host, staging, now):
    """The new set in place of the previous one, by renaming, not copying."""
    home = os.path.join(SETS, host)
    os.makedirs(home, exist_ok=True)
    stamp = "%s-%s" % (time.strftime("%Y%m%d-%H%M%S", time.gmtime(now)), os.urandom(3).hex())
    final = os.path.join(home, stamp)
    os.replace(staging, final)
    link = os.path.join(ROOT, host)
    # A relay set up before the mirror existed could have left an ordinary
    # directory in this place: a link cannot be renamed over it.
    if os.path.isdir(link) and not os.path.islink(link):
        shutil.rmtree(link, ignore_errors=True)
    temporary = os.path.join(ROOT, ".swap-%s-%s" % (host, os.urandom(4).hex()))
    os.symlink(os.path.join("sets", host, stamp), temporary)
    os.replace(temporary, link)
    # The previous sets are no longer needed: whatever of them survived the
    # deployment lies in the new one as a hard link, and deleting does not affect
    # files that are open right now.
    for name in os.listdir(home):
        if name != stamp:
            shutil.rmtree(os.path.join(home, name), ignore_errors=True)
    return final


def measure(directory):
    files = 0
    bytes_ = 0
    for where, _, names in os.walk(directory):
        for name in names:
            try:
                bytes_ += os.lstat(os.path.join(where, name)).st_size
            except OSError:
                continue
            files += 1
    return files, bytes_


def prune(now=None):
    """The daily cleanup: abandoned names, scraps of unpacking, old sets."""
    now = now or time.time()
    removed = []
    for host in sorted(os.listdir(SETS) if os.path.isdir(SETS) else []):
        home = os.path.join(SETS, host)
        live = current_set(host)
        for name in sorted(os.listdir(home)):
            version = os.path.join(home, name)
            if live and os.path.realpath(version) == live:
                continue
            shutil.rmtree(version, ignore_errors=True)
            removed.append(os.path.join("sets", host, name))
        # A name that is no longer exposed at all. The link is updated on every
        # deployment, so its time is the time of the last class.
        try:
            age = now - os.lstat(os.path.join(ROOT, host)).st_mtime
        except OSError:
            age = FORGET_DAYS * 86400 + 1
        if age > FORGET_DAYS * 86400:
            shutil.rmtree(home, ignore_errors=True)
            try:
                os.unlink(os.path.join(ROOT, host))
            except OSError:
                pass
            removed.append(host)
    for name in sorted(os.listdir(STAGE) if os.path.isdir(STAGE) else []):
        leftover = os.path.join(STAGE, name)
        try:
            if now - os.lstat(leftover).st_mtime < 3600:
                continue
        except OSError:
            continue
        shutil.rmtree(leftover, ignore_errors=True)
        removed.append(os.path.join(".tmp", name))
    return removed


class Handler(BaseHTTPRequestHandler):
    server_version = "colloq-assets/1"
    protocol_version = "HTTP/1.1"
    # A body that is never finished must not hold a thread forever. The archive
    # comes over the loopback from caddy, not from the classroom, but a
    # deployment is a dozen megabytes.
    timeout = 300

    def handle(self):
        try:
            super().handle()
        except (BrokenPipeError, ConnectionResetError, TimeoutError):
            pass

    def log_message(self, fmt, *args):
        code = str(args[1]) if len(args) > 1 else ""
        if code[:1] in ("4", "5"):
            sys.stderr.write("%s\n" % (fmt % args))

    def reply(self, code, body):
        data = json.dumps(body, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-store")
        if self.close_connection:
            self.send_header("Connection", "close")
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(data)

    def refuse(self, code, body):
        # The request body has not been read: the rest would stay in the socket
        # and be parsed as the next request.
        self.close_connection = True
        self.reply(code, body)

    def authorized(self):
        want = secret()
        given = self.headers.get("Authorization", "")
        prefix = "Bearer "
        if not want or not given.startswith(prefix):
            return False
        return hmac.compare_digest(given[len(prefix):].strip().encode(), want)

    def target(self):
        """The name from the path, which must also be the one the request came by."""
        path = self.path.split("?", 1)[0]
        if not path.startswith(PREFIX):
            raise Reject(404, "not found")
        host = path[len(PREFIX):].strip("/").lower()
        if not HOST.match(host) or len(host) > 100:
            raise Reject(400, "host")
        came = (self.headers.get("X-Forwarded-Host") or self.headers.get("Host") or "")
        came = came.split(":")[0].strip().lower()
        # Its own mirror and only its own: the secret is shared across the whole
        # relay, and without this check any seminar could rewrite the static
        # files of its neighbour.
        if came != host:
            raise Reject(403, "host")
        return host

    def do_GET(self):
        try:
            host = self.target()
        except Reject as no:
            return self.reply(no.code, {"error": no.why})
        if not self.authorized():
            return self.reply(401, {"error": "token"})
        live = current_set(host)
        if not live or not os.path.isdir(live):
            return self.reply(404, {"error": "empty", "host": host})
        files, bytes_ = measure(live)
        return self.reply(200, {
            "host": host, "files": files, "bytes": bytes_,
            "updated": int(os.lstat(live).st_mtime),
        })

    do_HEAD = do_GET

    def do_PUT(self):
        try:
            host = self.target()
        except Reject as no:
            return self.refuse(no.code, {"error": no.why})
        if not self.authorized():
            return self.refuse(401, {"error": "token"})
        try:
            length = int(self.headers.get("Content-Length", "-1"))
        except ValueError:
            length = -1
        if length < 0:
            # The length is required: without it nothing can stop the stream before unpacking.
            return self.refuse(411, {"error": "length"})
        if length > MAX_BYTES:
            return self.refuse(413, {"error": "bytes"})
        os.makedirs(STAGE, exist_ok=True)
        now = time.time()
        with lock_for(host):
            # Not mkdtemp: it makes 0700, and a chmod after it is a trap. The
            # directory inherits the caddy group and the setgid bit from STAGE,
            # but a chmod by a user who is not in the caddy group silently clears
            # that bit, and everything unpacked inside gets the process's group
            # (assets). The mirror then lies on disk in full, yet caddy cannot
            # read it and goes to the tunnel without a word; that is exactly what
            # happened at the first deployment on 12 Sep 2026. Hence mkdir with
            # the right mode at once and not a single chmod: setgid and the group
            # come from the parent on their own.
            staging = make_staging(host)
            try:
                files, bytes_, skipped = unpack(Body(self.rfile, length), staging)
                if files == 0:
                    raise Reject(400, "empty")
                previous = current_set(host)
                kept = carry_over(previous, staging, now) if previous else 0
                swap(host, staging, now)
            except Reject as no:
                shutil.rmtree(staging, ignore_errors=True)
                return self.refuse(no.code, {"error": no.why})
            except (tarfile.TarError, EOFError, OSError) as bad:
                shutil.rmtree(staging, ignore_errors=True)
                sys.stderr.write("%s: %s\n" % (host, bad))
                return self.refuse(400, {"error": "tar"})
        self.reply(200, {"host": host, "files": files, "bytes": bytes_,
                         "kept": kept, "skipped": skipped})


class Body:
    """Exactly Content-Length bytes from the socket and not one more."""

    def __init__(self, stream, length):
        self.stream = stream
        self.left = length

    def read(self, size=-1):
        if self.left <= 0:
            return b""
        if size is None or size < 0:
            size = self.left
        chunk = self.stream.read(min(size, self.left))
        self.left -= len(chunk)
        return chunk


def main():
    os.makedirs(SETS, exist_ok=True)
    os.makedirs(STAGE, exist_ok=True)
    if "--prune" in sys.argv[1:]:
        for name in prune():
            sys.stderr.write("colloq-assets: removed %s\n" % name)
        return
    server = ThreadingHTTPServer(("127.0.0.1", PORT), Handler)
    server.daemon_threads = True
    sys.stderr.write("colloq-assets: 127.0.0.1:%d, mirror %s, zone %s\n" % (PORT, ROOT, DOMAIN))
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
