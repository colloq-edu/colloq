#!/usr/bin/env python3
"""The high-score table for the game on the relay's waiting page.

The "room is not open yet" page (scripts/relay-offline.html) keeps a student
busy with a pixel capybara until the teacher opens the room, and offers to put
the score into a shared table. The table is the whole service: one JSON
collection on disk and three requests.

    GET  /.relay/capy/start    → {"run": token}   — issued at the start of a run
    GET  /.relay/capy/scores   → {"top": [{"id", "name", "score"}...],
                                  "total": attempts, "names": distinct names}
    POST /.relay/capy/scores   ← {"name", "score", "run": token, "owner": key}
                               → {"id", "name", "rank", "best", "improved",
                                  "renamed", "total", "names", "top": [...]}
                                 id, name and best are this name's row in the
                                 table (its best attempt); rank: null means the
                                 score did not make even the tail of the store.
                                 409: the name is held by another owner.

Lives on the loopback (127.0.0.1:9181) behind caddy, which hands it the
/.relay/capy/* path for any name under *.colloq.ru; the path starts with a dot
so as not to collide with any instance address. Installed and updated by
scripts/relay-setup.sh as the colloq-capy systemd service under a separate
user; data in /var/lib/colloq-capy/: scores.json and secret.

Why the standard library and not something more convenient: the relay has
neither node nor pip, nor any wish to drag them there. It is a machine with
two daemons and a secret, and every extra dependency on it is one too many.
Ubuntu always has python3.

Who owns what. The browser creates a random owner key for itself once and
sends it with every entry; the service stores only its hash. The name is the
owner's signature, not the identity itself: type another one, and all of that
owner's rows move under the new name together with the record (that is how
"test" becomes "sleep3r" instead of a second player). A name already held by
another owner cannot be taken: 409; nobody's rows (written before this rule)
go to the first one who writes under them with their own key. The flip side:
the same person on another device is another owner and will not get their
name there; that is the price of nobody being able to put 99 999 under
someone else's name.

Entries WITHOUT a key are not accepted at all: 400. The owner check used to
sit inside "if a key was sent", and `curl` without a key wrote anything under
any other person's name: the 409 rule was bypassed by simply never being
asked.

Score honesty. At the start of a run the page takes a token: a signed start
time. An entry without a token or with a foreign one is not accepted; the
score is checked against the time that has passed on the service's clock: the
game honestly scores up to ~37 per second, and up to 40·s + 50 is accepted.
The token is single-use per name (renaming the same attempt is legitimate,
repeating under the same name is not). This is no protection against someone
who rewrites the game, but protection against curl a minute before the bell.

The table is one row per name: a person's best result, not all their attempts
in a row. Names are compared case-insensitively. All attempts are counted:
that is the number above the table.

The table has no nameless rows. An empty name used to become "Аноним"
(Anonymous), and every such attempt took ITS OWN permanent row: of eight rows
in the table, five were "Аноним", and a table about people turned into a feed
of attempts. You can still play without a name as much as you like, but a row
in the table starts with a name. The old nameless rows stayed in the file and
count towards attempts, but are not shown.

What else is checked: a name is up to 16 characters, without control or
invisible characters, with at least one visible one; "Аноним" is the old label
of nameless rows, not a name, and cannot be taken. The score is an integer
from 0 to 99 999. The limit per address is a bucket: five entries at once,
then one every three seconds (a class behind one NAT fits, a stream of curl
does not). The address is taken from the LAST element of X-Forwarded-For:
caddy appends it, the first one is sent by the client. The table keeps the
five hundred best; the reply is computed from what is stored.

Checking by hand, without the relay:
    CAPY_STATE=/tmp/capy CAPY_PORT=9181 CAPY_PAGE=scripts/relay-offline.html \
        python3 scripts/relay-capy.py
and open http://127.0.0.1:9181/: with CAPY_PAGE the service serves the page on
any path, so the game and the table can be tried from one address.
"""

import hashlib
import hmac
import json
import os
import re
import sys
import tempfile
import threading
import time
import unicodedata
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

STATE_DIR = os.environ.get("CAPY_STATE", "/var/lib/colloq-capy")
STORE = os.path.join(STATE_DIR, "scores.json")
SECRET_FILE = os.path.join(STATE_DIR, "secret")
PORT = int(os.environ.get("CAPY_PORT", "9181"))
PAGE = os.environ.get("CAPY_PAGE")  # only for checking by hand

PATH = "/.relay/capy/scores"
START = "/.relay/capy/start"
KEEP = 500
TOP = 10
NAME_MAX = 16
SCORE_MAX = 99_999
BODY_MAX = 2048
# The name of the old nameless rows: they have no place in the table, but they stay in the file.
ANON = "Аноним"
# A bucket per address: BURST entries at once, then one every REFILL_SECONDS.
BURST = 5
REFILL_SECONDS = 3.0
# Honesty: the points per second beyond which the game does not score, and a margin.
POINTS_PER_SECOND = 40
POINTS_SLACK = 50
RUN_MAX_AGE = 6 * 3600  # a token older than this has expired

_lock = threading.Lock()
_buckets = {}  # address → (tokens, when counted)
_used = {}  # (token, name key) → when used


def load_secret():
    try:
        with open(SECRET_FILE, "rb") as f:
            s = f.read()
        if len(s) >= 32:
            return s
    except OSError:
        pass
    os.makedirs(STATE_DIR, exist_ok=True)
    s = os.urandom(32)
    fd = os.open(SECRET_FILE, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "wb") as f:
        f.write(s)
    return s


SECRET = load_secret()


def make_run(now):
    start = "%x" % int(now * 1000)
    nonce = os.urandom(6).hex()
    sig = hmac.new(SECRET, ("%s.%s" % (start, nonce)).encode(), hashlib.sha256).hexdigest()[:20]
    return "%s.%s.%s" % (start, nonce, sig)


def run_started(token):
    # Returns the start time (s), or None if the token is not ours.
    if not isinstance(token, str) or token.count(".") != 2 or len(token) > 80:
        return None
    start, nonce, sig = token.split(".")
    want = hmac.new(SECRET, ("%s.%s" % (start, nonce)).encode(), hashlib.sha256).hexdigest()[:20]
    if not hmac.compare_digest(want, sig):
        return None
    try:
        return int(start, 16) / 1000
    except ValueError:
        return None


def owner_hash(value):
    if not isinstance(value, str) or not (16 <= len(value) <= 64) or not re.fullmatch(r"[0-9a-f]+", value):
        return None
    return hashlib.sha256(value.encode()).hexdigest()[:16]


def load():
    try:
        with open(STORE, encoding="utf-8") as f:
            rows = json.load(f)
    except (OSError, ValueError):
        return []
    if not isinstance(rows, list):
        return []
    # Do not take the shape of the rows on faith: the file is edited by hand on
    # the machine, and the schema may change in the next version; a garbage row
    # must drop out of the table, not kill both requests with a KeyError forever.
    return [
        r for r in rows
        if isinstance(r, dict)
        and isinstance(r.get("id"), str)
        and isinstance(r.get("name"), str)
        and isinstance(r.get("score"), int) and not isinstance(r.get("score"), bool)
        and isinstance(r.get("at"), (int, float)) and not isinstance(r.get("at"), bool)
        and (r.get("owner") is None or isinstance(r.get("owner"), str))
    ]


def save(rows):
    # Through a temporary file and a rename: a break in the middle of writing
    # will not leave a half-written JSON from which nothing can be read later.
    os.makedirs(STATE_DIR, exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=STATE_DIR, prefix=".scores-", suffix=".json")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            json.dump(rows, f, ensure_ascii=False)
        os.replace(tmp, STORE)
    except BaseException:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise


def ordered(rows):
    # More points ranks higher; on a tie, the one written earlier ranks higher.
    return sorted(rows, key=lambda r: (-r["score"], r["at"]))


def key_of(row):
    # The merge key: the name, ignoring case.
    return row["name"].casefold()


def board(rows):
    # Ordered rows without repeated names: the first occurrence is the best.
    # The old nameless rows are skipped: the table is about names.
    seen = set()
    out = []
    for r in ordered(rows):
        if r["name"] == ANON:
            continue
        k = key_of(r)
        if k in seen:
            continue
        seen.add(k)
        out.append(r)
    return out


def public(row):
    return {"id": row["id"], "name": row["name"], "score": row["score"]}


def summary(rows):
    # How many attempts in total and how many distinct names, for the line above
    # the table. Counted over the five hundred stored: more precision is not
    # needed. Attempts are all of them, including the old nameless ones; names
    # are only those actually in the table.
    return {
        "total": len(rows),
        "names": len({key_of(r) for r in rows if r["name"] != ANON}),
    }


# Control and invisible characters: zero-width, writing direction, isolates,
# joiners, Hangul fillers, BOM: everything that can make a name look empty or
# flip its neighbours in the table.
_CONTROL = re.compile(
    "[\\x00-\\x1f\\x7f-\\x9f\\u00ad\\u061c\\u180e\\u200b-\\u200f\\u2028-\\u202e"
    "\\u2060-\\u2064\\u206a-\\u206f\\u3164\\ufe00-\\ufe0f\\ufeff\\u115f\\u1160]"
)


def clean_name(value):
    """The name, or None if there is no name.

    None, not "Аноним": a nameless entry is not accepted at all now, and telling
    "typed nothing" from "typed a name" is the job of whoever answers the client.
    """
    if not isinstance(value, str):
        return None
    value = _CONTROL.sub("", value)
    value = " ".join(value.split())[:NAME_MAX].strip()
    # At least one visible character: a letter, a digit, punctuation or a
    # symbol. Anything new and invisible in future Unicode versions is cut off
    # by category, not by the list above.
    if not any(unicodedata.category(c)[0] in "LNPS" for c in value):
        return None
    # "Аноним" is the label of the old nameless rows, not a name: by taking it,
    # a person would get other people's rows along with it, rows that should not
    # be in the table at all.
    if value.casefold() == ANON.casefold():
        return None
    return value


def clean_score(value):
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    if value != value or value < 0 or value > SCORE_MAX:
        return None
    return int(value)


def allow(ip, now):
    # A bucket with headroom: a class that crashes out all at once at the bell
    # gets through; a stream from curl still runs into one entry per three
    # seconds.
    tokens, at = _buckets.get(ip, (BURST, now))
    tokens = min(BURST, tokens + (now - at) / REFILL_SECONDS)
    if tokens < 1:
        _buckets[ip] = (tokens, now)
        return False
    _buckets[ip] = (tokens - 1, now)
    if len(_buckets) > 10_000:
        # Do not keep in memory everyone who has ever come by.
        for k in [k for k, (t, a) in _buckets.items() if now - a > BURST * REFILL_SECONDS]:
            del _buckets[k]
    return True


def prune_used(now):
    if len(_used) > 20_000:
        for k in [k for k, t in _used.items() if now - t > RUN_MAX_AGE]:
            del _used[k]


class Handler(BaseHTTPRequestHandler):
    server_version = "colloq-capy/4"
    protocol_version = "HTTP/1.1"
    # A body that is never finished must not hold a thread forever.
    timeout = 15

    def handle(self):
        # A student closed the tab in the middle of a reply: not an event for the log.
        try:
            super().handle()
        except (BrokenPipeError, ConnectionResetError, TimeoutError):
            pass

    def log_message(self, fmt, *args):
        # Only refusals go to the systemd journal; it does not need every GET of the table.
        code = str(args[1]) if len(args) > 1 else ""
        if code[:1] in ("4", "5"):
            sys.stderr.write("%s - %s\n" % (self.client_ip(), fmt % args))

    def log_error(self, fmt, *args):
        sys.stderr.write("%s - %s\n" % (self.client_ip(), fmt % args))

    def client_ip(self):
        fwd = self.headers.get("X-Forwarded-For", "") if getattr(self, "headers", None) else ""
        # The last element was appended by caddy; the first was sent by the
        # client, and it can be anything at all.
        last = fwd.split(",")[-1].strip() if fwd else ""
        return last or (self.client_address[0] if self.client_address else "") or "?"

    def reply(self, code, body, ctype="application/json; charset=utf-8"):
        data = body if isinstance(body, bytes) else json.dumps(body, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-store")
        if self.close_connection:
            self.send_header("Connection", "close")
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(data)

    def do_GET(self):
        path = self.path.split("?", 1)[0]
        if path == PATH:
            with _lock:
                rows = load()
            return self.reply(200, {"top": [public(r) for r in board(rows)[:TOP]], **summary(rows)})
        if path == START:
            return self.reply(200, {"run": make_run(time.time())})
        if PAGE and self.command == "GET":
            try:
                with open(PAGE, "rb") as f:
                    return self.reply(404, f.read(), "text/html; charset=utf-8")
            except OSError:
                pass
        self.reply(404, {"error": "not found"})

    do_HEAD = do_GET

    def refuse(self, code, body):
        # The request body has not been read: the rest would stay in the socket
        # and be parsed as the next request. The connection is closed; keep-alive
        # is not needed here.
        self.close_connection = True
        self.reply(code, body)

    def do_POST(self):
        path = self.path.split("?", 1)[0]
        if path != PATH:
            return self.refuse(404, {"error": "not found"})
        try:
            length = int(self.headers.get("Content-Length", "0"))
        except ValueError:
            length = -1
        if length < 0 or length > BODY_MAX:
            return self.refuse(413, {"error": "body too large"})
        try:
            body = json.loads(self.rfile.read(length) or b"{}")
        except (ValueError, UnicodeDecodeError):
            return self.reply(400, {"error": "bad json"})
        if not isinstance(body, dict):
            return self.reply(400, {"error": "bad json"})
        score = clean_score(body.get("score"))
        if score is None:
            return self.reply(400, {"error": "bad score"})
        name = clean_name(body.get("name"))
        if name is None:
            return self.reply(400, {"error": "name"})
        # The owner key is required: without it there is nobody to pin the name
        # to, and the "name taken" check below becomes a check about nothing; it
        # used to sit inside "if a key was sent", and an entry without a key went
        # through under any other person's name.
        owner = owner_hash(body.get("owner"))
        if owner is None:
            return self.reply(400, {"error": "owner"})
        now = time.time()

        # The run start token: without one, or with a foreign or expired one, there is no entry.
        started = run_started(body.get("run"))
        if started is None or started > now + 60 or now - started > RUN_MAX_AGE:
            return self.reply(400, {"error": "run"})
        # The game does not score this many points in this many seconds.
        if score > POINTS_PER_SECOND * max(0.0, now - started) + POINTS_SLACK:
            return self.reply(400, {"error": "implausible"})

        ip = self.client_ip()
        with _lock:
            if not allow(ip, now):
                return self.reply(429, {"error": "too fast"})
            row = {
                # A millisecond plus randomness: two entries in one millisecond
                # (the bell: the whole class crashes at once) must not share an id.
                "id": "%x%s" % (int(now * 1000), os.urandom(4).hex()),
                "name": name,
                "score": score,
                "at": now,
                "host": (self.headers.get("X-Forwarded-Host") or self.headers.get("Host") or "").split(":")[0],
            }
            key = key_of(row)
            used_key = (body.get("run"), key)
            if used_key in _used:
                return self.reply(400, {"error": "run"})
            rows = load()
            renamed = False
            row["owner"] = owner
            # A name held by another owner is taken.
            if any(key_of(r) == key and r.get("owner") not in (None, owner) for r in rows):
                return self.reply(409, {"error": "name taken"})
            # The owner's own rows under the previous name move under the new one.
            for r in rows:
                if r.get("owner") == owner and key_of(r) != key:
                    r["name"] = name
                    renamed = True
            # Nobody's rows under this name become the owner's own.
            for r in rows:
                if key_of(r) == key and r.get("owner") is None:
                    r["owner"] = owner
            _used[used_key] = now
            prune_used(now)
            rows = ordered(rows + [row])[:KEEP]
            save(rows)
            table = board(rows)
            # The place is counted among names, and it belongs to this name's best
            # attempt, possibly not the one that came in now. The client highlights it.
            mine = next((r for r in table if key_of(r) == key), None)
            top = [public(r) for r in table[:TOP]]
            counts = summary(rows)
        if mine is None:
            # The store is full, and the attempt is worse than all five hundred: nothing is saved.
            return self.reply(200, {"id": row["id"], "name": name, "rank": None, "best": None,
                                    "improved": False, "renamed": renamed, "top": top, **counts})
        self.reply(200, {
            "id": mine["id"], "name": mine["name"], "rank": table.index(mine) + 1,
            "best": mine["score"], "improved": row["score"] >= mine["score"],
            "renamed": renamed, "top": top, **counts,
        })


def main():
    server = ThreadingHTTPServer(("127.0.0.1", PORT), Handler)
    server.daemon_threads = True
    sys.stderr.write("colloq-capy: 127.0.0.1:%d, store %s%s\n" % (PORT, STORE, " + page" if PAGE else ""))
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
