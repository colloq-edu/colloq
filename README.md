# Colloq

One link, one live notebook, one AI. A self-hosted workspace for running technical seminars.

The teacher creates a session and shares a link. Students open it, type a name, and land inside a
collaborative notebook with Python execution, a shared terminal and a built-in oracle. No
signup, no email, no course management — the link *is* the seminar.

```
┌─────────────────────────────────────────────────────────────┐
│ Computer Vision Seminar                 8 people online     │
├──────────────┬───────────────────────────────┬──────────────┤
│ FILES        │        NOTEBOOK               │  AI          │
│ data.csv     │  In [1]: import torch         │  Ask AI...   │
│ PEOPLE       │  In [2]: model = ...          │              │
│ 🟢 Alex      ├───────────────────────────────┤              │
│              │  $ pip install timm           │              │
└──────────────┴───────────────────────────────┴──────────────┘
```

## Run it

```bash
make up                   # or: cp .env.example .env && docker compose up --build
```

The first boot prints a setup token. Open <http://localhost:3000/admin>, paste it in with your
name and email, and the instance is yours — then create a seminar and share the link it gives you.

`make` with no target lists everything. The two that matter are `make host` and
`make env-use`; both have a section below.

### One instance, two ways to start it

`make up` runs everything in Docker. `make run` builds and runs the server on your
machine with only the kernel in Docker — faster after a code change, which is why it
exists. **They are the same instance:** both keep the database in `./data` and the
seminars' files in `./workspace`, next to this README, so a seminar created one way
opens the other way and a backup is a copy of two folders.

They cannot run at the same time — both want port 3000 — and `make run` says so
rather than failing halfway. `make up` is the one to use unless you are changing
code; `make down` stops the Docker one, `make stop` the host one.

## Giving the room a link

A seminar on `localhost` is a seminar for one person. `make host` opens a Cloudflare
tunnel and hands you a URL the whole room can open:

```bash
make host
#   Colloq доступен по ссылке
#     https://calm-fox-rides.trycloudflare.com
#
#   Вход в панель — эта ссылка только для вас
#     https://calm-fox-rides.trycloudflare.com/admin/t/<token>
```

The tunnel is an *outbound* connection from this machine to Cloudflare, so nothing has to
be forwarded on the router, no public IP is needed, and no VPS is involved. Every cell the
room runs is still executed here.

What the script actually does, and why it is a script rather than one `cloudflared` call:
the seminar link the server hands out is built from `PUBLIC_URL`. Left at `localhost` it
opens for you and for nobody else — and you find that out when thirty people are already
sitting in the room. So the tunnel is opened *first*, its address read out of
`cloudflared`'s output, written into `.env`, and only then is the app restarted. On exit
`PUBLIC_URL` goes back to `localhost`, because a link to a closed tunnel is worse than no
link at all.

Two links are printed, and they are not interchangeable. The first is the
instance — that is where you create a seminar and copy *its* link for the room.
The second ends in `/admin/t/<token>` and is the way into the panel.

That second link exists because of the tunnel. The staff cookie is bound to an
origin, every run publishes a new one, so the teacher arrives signed out at the
start of every seminar — and a 32-character token is not something to retype
while a room waits. It is the same trade Jupyter makes with `?token=`. Opening
it signs you in and immediately erases itself from the address bar, because the
address bar is the one place a projector shows to everybody.

On an instance nobody owns yet the same link carries the token into the
first-run form instead, so all that is left to type is a name.

It is a key, not a URL to share. Anyone who opens it owns the instance.

The address is random and changes each run. For one that does not:

```bash
make tunnel-setup HOST=seminar.example.ru   # once: browser login, tunnel, DNS
make host HOST=seminar.example.ru           # every time after that
```

The last step verifies the URL from outside before printing it. If that check fails it
says so without claiming the seminar is broken — measured on a corporate network, queries
to public resolvers were dropped intermittently while the tunnel itself answered in 250 ms,
so a failed check is usually the network you are checking *from*.

## Environments

Every seminar on an instance shares one kernel, and that kernel has one set of packages.
`kernel/requirements.txt` is the base — jupyter, numpy, pandas, matplotlib, scikit-learn —
and it is always installed. An *environment* is a list of packages on top of it, one file
per environment in `kernel/environments/`.

```bash
make env-list              # what exists, and which one is running
make env-new NAME=nlp      # creates kernel/environments/nlp.txt
$EDITOR kernel/environments/nlp.txt
make env-use NAME=nlp      # builds it and switches the kernel over
```

Each environment is baked into its own image tag (`colloq-kernel:nlp`), so switching back
to one you have built before is instant rather than another pip install. The base layer is
shared between them, which is why an environment costs only the packages the base does not
already have.

Two things this deliberately does not do. It is **instance-wide**: switching changes the
kernel for every seminar on this install, not per-room — per-seminar environments need a
container per seminar, which is a different product. And `make env-use` **restarts the
kernel**, so every variable in every open seminar is gone; the notebooks and files are
untouched, the cells just need running again. Both are printed when you run it.

To see what is actually installed rather than what was requested: `make env-freeze`.

## The teaching side

Everything a teacher runs lives at `/admin`: the seminars, the oracle's provider and limits, and
who else may teach here. Students never see it — they open a seminar link, type a name, and are in.

**The setup token** is written to `<DATA_DIR>/setup-token` (mode 0600, `./data/setup-token` by
default) on first boot and printed to the server log while nobody has claimed the instance. It
claims the instance once, and afterwards keeps working as the way back in if an owner loses their
link. Whoever can read the server's disk owns the instance; that is true of any self-hosted service,
so it is said out loud rather than pretended away.

**Teachers are added by an owner**, on the *Who can teach* page: a name and an email — identity
only, Colloq never sends mail. Adding someone mints their **sign-in link**, a URL of the form
`https://your-host/admin/k/<key>`. Send it to them however you already talk to them; opening it
exchanges the key for an HttpOnly cookie and lands them in the panel. The link is *displayed* once
and the row afterwards shows only its shape, so a screen share or a screenshot of that page spills
nothing — but an owner can still copy it straight to the clipboard to re-send it to someone who
mislaid theirs. A link can be rotated (the old one dies instantly, along with every session opened
from it) or removed with the account. There is no password
and no SSO — a product whose premise is "a link is enough" has no business growing a login form for
the ten people on the other side of it.

Creating a seminar is staff-only by default. `OPEN_SEMINAR_CREATION=true` lifts that on the API —
there is no interface for it, since `/` goes to the panel, so it is a switch for scripting rather
than a page. On an instance with an API key in it, whoever can reach that endpoint is spending your
money.

## Configuration

Everything lives in `.env` — see `.env.example` for the full list.

| Variable | What it does |
| --- | --- |
| `PORT` | Port on the host. Change `PUBLIC_URL` with it — neither derives the other |
| `PUBLIC_URL` | Origin students open; the link they receive is built from this |
| `SESSION_SECRET` | Signs participant tokens and staff cookies. Leave empty — generated on first boot and kept in `DATA_DIR`. Set it to rotate |
| `ADMIN_EMAIL` | Prefills the address on the first-run claim screen |
| `OPEN_SEMINAR_CREATION` | Let anyone with the URL create a seminar (default off: staff only) |
| `JUPYTER_TOKEN` | Shared secret between the app and the kernel container |
| `OPENAI_API_KEY` / `OPENAI_BASE_URL` / `OPENAI_MODEL` | Any OpenAI-compatible endpoint |
| `KERNEL_MEM` / `KERNEL_CPUS` | Resource ceiling for student code |

The AI layer talks plain OpenAI-compatible HTTP, so pointing `OPENAI_BASE_URL` at Ollama, vLLM,
LM Studio or OpenRouter works without touching code. Leaving `OPENAI_API_KEY` empty simply
disables the oracle; everything else keeps working. All of it can also be set from
`/admin` → *Oracle*, where a stored value overrides the environment and clearing it hands the
setting back to `.env`.

## How it works

```
Browser ── WS /collab  ── Yjs sync (notebook + presence)
       ── WS /control  ── run / interrupt / restart, kernel status
       ── HTTP /api    ── sessions, join, files, ask the oracle
                │
          Node server ── collab/   holds each session's Y.Doc in memory, snapshots it
                      ── kernel/   one shared kernel per session, FIFO run queue
                      ── ai/       context assembled from the server's own Y.Doc
                │
        Jupyter Server container ── isolated, resource-capped, shared /workspace volume
```

Six decisions worth knowing about:

**The server is a full participant in the CRDT.** Execution output is written into the Y.Doc by the
server, not by the browser that pressed Run. Everyone therefore sees byte-identical output, and a
student who joins twenty minutes late gets the entire execution history for free.

**One shared kernel per session.** The trade-off is real and deliberate: a student can clobber
another's variables, and a long-running cell blocks the queue. In exchange the room shares one
mental model — we are all at the same blackboard — with no per-user container orchestration and no
divergent state. It is made legible rather than hidden: every cell says where it is in the queue and
whose run it is, and everyone has a way out of it. The host can interrupt or restart; so can whoever
started the cell that is running, because a seminar with no teacher in the room still has to be able
to end a loop that will not end itself. A cell that is only *waiting* can be taken back by the person
who queued it — pressing Run All behind somebody else's forty-second cell used to be a one-way door.
Run All stops at the first traceback, the way it does in the tool the room already knows: thirty
cells that each need the one before produce thirty tracebacks and only the first says anything.
Cells somebody else queued in the meantime still run — their work is not what broke.

**One shell, shared like everything else.** The drawer under the notebook is a real terminal in the
kernel's container, in the seminar's own folder — so `pip install seaborn` there changes the
environment for every cell and everyone in the room, and `ls` lists what the Files panel uploaded.
The transcript is in the document, so it is the same for everybody and it is still there when a
student joins late; each command carries the face of whoever typed it. One shell means one command
at a time: a command typed while another is running waits its turn and the room is told whose it
is. Full-screen programs (`vim`, `top`) are announced rather than rendered — a shared transcript
cannot give them a screen.

**Browsers never touch Jupyter.** The kernel token stays on the server, which also serializes the
run queue. Student code cannot reach the Jupyter API even though it can run arbitrary Python.

**Local-first editing.** Keystrokes apply to the local Yjs document immediately and sync in the
background, so typing never waits for a round-trip. The same holds for AI and execution — both are
fully asynchronous and never block the editor.

**Identity is a link, not an account.** A participant is a name plus a signed token in
localStorage. Refreshing the page, or closing a laptop mid-seminar, drops the student straight back
into the room.

### Surviving a restart

The server can be killed mid-seminar — a crash, a deploy, `docker compose restart` — and the room
comes back without anybody reloading a page. Three things make that true, and each of them was
false at some point:

- **The signing key outlives the process.** It is generated once and kept in `DATA_DIR`, so tokens
  and staff cookies still verify afterwards. Generated per boot, as it was, a restart refused every
  socket in the room and nobody was told why.
- **The notebook is on disk before it is reachable.** Snapshots are debounced by seconds while the
  seminar exists immediately, so a brand-new room is flushed at once. Otherwise the server came
  back, found nothing stored, decided the room was new, and seeded a second set of starter cells
  under everyone's real work.
- **Execution state is rebuilt, not restored.** Cells left `running` or `queued` in the snapshot
  are put back to rest and the room is told, because nothing is running in a process that has just
  started. Outputs are kept: a cell that printed three lines before the crash really did print them.

A room stays in memory once it has been opened, and is released only when the seminar is deleted.
That is deliberate — the document is what everyone is editing and what a latecomer syncs from — and
it is measured rather than assumed: eighty rooms opened, worked in and left cost about five
megabytes between them, and a term's worth of seminars is single-digit megabytes. What does not
grow is the room itself: thirty people typing and rewriting for a long class left a document of
16 KB against 12 KB of live text, because Yjs merges the deletions it keeps. Memory taken by the
people in the room comes back when they leave.

The kernel is the good half. It runs in its own container and Jupyter's session API is idempotent,
so the server re-attaches to the *same* kernel with every variable still in it. The one thing that
cannot survive is a cell that was executing: its output has nowhere to go, and until it is stopped
every Run anybody presses queues silently behind it. It is stopped on re-attach and the room is told.

And when the kernel itself dies — OOM-killed by `mem_limit`, culled, or restarted underneath — the
socket does not say so. Jupyter leaves it open. So the server asks: after ten seconds of silence
with a cell outstanding, it checks whether the kernel still exists, and a kernel that has gone is
announced, not waited on. A Run afterwards brings a fresh one up rather than failing once first.

### Isolation

Student code runs as a non-root user inside the `kernel` container, in a separate process from the
Node server, capped by `mem_limit`, `cpus` and `pids_limit`. Files live on a shared volume, so a
CSV dropped in the Files panel is readable as `pd.read_csv('data.csv')` from a cell.

This is sandboxing appropriate to a classroom of people you know, not to hostile untrusted input.
Anyone with the link can execute Python inside that container.

The same is true of the document. A CRDT everyone edits is a CRDT everyone can write anything
into, including in somebody else's name: with a console open, a student can add a question
attributed to the teacher, or a terminal line, or claim that someone else ran a cell. Nothing
there is a privilege — they still cannot run code as anybody else, reach `/admin`, or read the
API key, and the server decides who may interrupt or restart from its own record rather than from
the document. What it means is that attribution inside a seminar is a social fact among people who
can see each other, not a cryptographic one. The seminar's *name* is the exception, because the
header offers it to the host alone and it reaches the admin list: a rename written by anyone else
is put back.

The server also repairs one thing that is nobody's fault. Y.Array has no move operation, so the
editor reorders a cell by cloning it and deleting the original; two people nudging the same cell at
the same moment leave the notebook holding it twice under one id, and running, attributing and
asking about a cell are all keyed by that id. The server keeps the first copy and drops the rest —
which also means the move happens once rather than being undone.

## Development

```bash
npm install                     # workspaces: server + web
mkdir -p workspace && chmod 777 workspace
docker compose -f docker-compose.yml -f docker-compose.dev.yml up kernel -d
npm run dev                     # server on :3000, Vite on :5173 with proxying
```

The dev override bind-mounts `./workspace` into the kernel container so the host server and the
containerised kernel see the same files; production uses a named volume instead.

`shared/` holds the Y.Doc schema and wire protocol used by both sides — it is the contract to change
first when adding a feature.

### Tests

```bash
npm test        # unit: ~220 tests, under ten seconds, no server and no browser
npm run e2e     # end-to-end: needs the server and the kernel running
npm run perf    # budgets: bundle, API latency, CRDT round-trip
```

Both `e2e` and `perf` create seminars and both delete them again on the way out. They point at
`http://localhost:3000` unless told otherwise — `E2E_BASE_URL` and `PERF_BASE_URL` — which matters
if an instance somebody is teaching in happens to be on that port.

`npm test` covers what fails *quietly* — a token that verifies when it should not, an instance left
with no owner, a context window that drops the traceback the student asked about, a filename that
escapes the workspace, a seminar that ends up with two different names, a restart that signs the
whole room out, a kernel that dies without the socket ever closing, a room whose online list is
empty because it reads a field nothing publishes, two people reordering one notebook into a cell
that exists twice. See `tests/README.md` for why it stops there.

`npm run e2e`, with the server and kernel running:

The end-to-end pass signs in as staff with the setup token from `<DATA_DIR>/setup-token`, opens two independent
clients against a fresh seminar, types a cell on one, presses Run on the other, and asserts that the
output, the execution attribution and a file written by the cell all reach the *second* client — the
whole realtime + execution + CRDT chain in one pass.

### Widths

The seminar room holds together from a wide desktop down to a phone: below about 1100px the
oracle folds into a button in the top bar, below about 700px the files-and-people rail folds
into the one beside it, and each opens as a panel over the room that closes on Escape, on a click
outside, or on the button that opened it. Nothing scrolls the page sideways at any width — the run
bar scrolls inside itself instead.

The admin panel is a desk tool and is built for one: it is correct down to about 500px, and below
that its fixed 236px navigation and the seminar table's own columns leave too little for the list,
so the page scrolls sideways. Teaching is unaffected — the seminar link opens the room, not the
panel — and a collapsing admin nav is deliberately not built.

## Not in this MVP

Courses, assignments, grading, submissions, progress tracking, analytics, permissions,
SSO, GPU scheduling, multiple languages, package management, Kubernetes, video. All deliberately
out of scope: the MVP exists to answer whether one link and one shared workspace is enough to run a
real seminar.
