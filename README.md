# Colloq

One link, one live notebook, one AI. A self-hosted workspace for running technical seminars.

The teacher creates a session and shares a link. Students open it, type a name, and land inside a
collaborative notebook with Python execution and a built-in assistant. No signup, no email, no
course management — the link *is* the seminar.

```
┌─────────────────────────────────────────────────────────────┐
│ Computer Vision Seminar                 8 people online     │
├──────────────┬───────────────────────────────┬──────────────┤
│ FILES        │        NOTEBOOK               │  AI          │
│ data.csv     │  In [1]: import torch         │  Ask AI...   │
│ PEOPLE       │  In [2]: model = ...          │              │
│ 🟢 Alex      │                               │              │
└──────────────┴───────────────────────────────┴──────────────┘
```

## Run it

```bash
cp .env.example .env      # set OPENAI_API_KEY if you want the assistant
docker compose up --build
```

The first boot prints a setup token. Open <http://localhost:3000/admin>, paste it in with your
name and email, and the instance is yours — then create a seminar and share the link it gives you.

To expose it to students on a real host, set `PUBLIC_URL` in `.env` to the URL they will open.

## The teaching side

Everything a teacher runs lives at `/admin`: the seminars, the assistant's provider and limits, and
who else may teach here. Students never see it — they open a seminar link, type a name, and are in.

**The setup token** is written to `<DATA_DIR>/setup-token` (mode 0600, `./data/setup-token` by
default) on first boot and printed to the server log while nobody has claimed the instance. It
claims the instance once, and afterwards keeps working as the way back in if an owner loses their
link. Whoever can read the server's disk owns the instance; that is true of any self-hosted service,
so it is said out loud rather than pretended away.

**Teachers are added by an owner**, on the *Who can teach* page: a name and an email — identity
only, Colloq never sends mail. Adding someone mints their **sign-in link**, a URL of the form
`https://your-host/admin/k/<key>`, shown once and never again. Send it to them however you already
talk to them; opening it exchanges the key for an HttpOnly cookie and lands them in the panel. A
link can be rotated (the old one dies instantly) or removed with the account. There is no password
and no SSO — a product whose premise is "a link is enough" has no business growing a login form for
the ten people on the other side of it.

Creating a seminar is staff-only by default. Set `OPEN_SEMINAR_CREATION=true` to let anyone with
the URL open one from the home screen again — on an instance with an API key in it, that is anyone
spending your money.

## Configuration

Everything lives in `.env` — see `.env.example` for the full list.

| Variable | What it does |
| --- | --- |
| `PUBLIC_URL` | Origin students open; used to build the shareable link |
| `SESSION_SECRET` | Signs participant tokens and staff cookies. Change it. |
| `ADMIN_EMAIL` | Prefills the address on the first-run claim screen |
| `OPEN_SEMINAR_CREATION` | Let anyone with the URL create a seminar (default off: staff only) |
| `JUPYTER_TOKEN` | Shared secret between the app and the kernel container |
| `OPENAI_API_KEY` / `OPENAI_BASE_URL` / `OPENAI_MODEL` | Any OpenAI-compatible endpoint |
| `KERNEL_MEM` / `KERNEL_CPUS` | Resource ceiling for student code |

The AI layer talks plain OpenAI-compatible HTTP, so pointing `OPENAI_BASE_URL` at Ollama, vLLM,
LM Studio or OpenRouter works without touching code. Leaving `OPENAI_API_KEY` empty simply
disables the assistant; everything else keeps working. All of it can also be set from
`/admin` → *Assistant*, where a stored value overrides the environment and clearing it hands the
setting back to `.env`.

## How it works

```
Browser ── WS /collab  ── Yjs sync (notebook + presence)
       ── WS /control  ── run / interrupt / restart, kernel status
       ── HTTP /api    ── sessions, join, files, AI (SSE)
                │
          Node server ── DocManager (holds each session's Y.Doc in memory)
                      ── ExecQueue  (one shared kernel per session, FIFO)
                      ── AI         (context assembled from the server's own Y.Doc)
                │
        Jupyter Server container ── isolated, resource-capped, shared /workspace volume
```

Five decisions worth knowing about:

**The server is a full participant in the CRDT.** Execution output is written into the Y.Doc by the
server, not by the browser that pressed Run. Everyone therefore sees byte-identical output, and a
student who joins twenty minutes late gets the entire execution history for free.

**One shared kernel per session.** The trade-off is real and deliberate: a student can clobber
another's variables, and a long-running cell blocks the queue. In exchange the room shares one
mental model — we are all at the same blackboard — with no per-user container orchestration and no
divergent state. It is made legible rather than hidden: the queue is visible, every run is
attributed to a name, and the host can interrupt or restart.

**Browsers never touch Jupyter.** The kernel token stays on the server, which also serializes the
run queue. Student code cannot reach the Jupyter API even though it can run arbitrary Python.

**Local-first editing.** Keystrokes apply to the local Yjs document immediately and sync in the
background, so typing never waits for a round-trip. The same holds for AI and execution — both are
fully asynchronous and never block the editor.

**Identity is a link, not an account.** A participant is a name plus a signed token in
localStorage. Refreshing the page, or closing a laptop mid-seminar, drops the student straight back
into the room.

### Isolation

Student code runs as a non-root user inside the `kernel` container, in a separate process from the
Node server, capped by `mem_limit`, `cpus` and `pids_limit`. Files live on a shared volume, so a
CSV dropped in the Files panel is readable as `pd.read_csv('data.csv')` from a cell.

This is sandboxing appropriate to a classroom of people you know, not to hostile untrusted input.
Anyone with the link can execute Python inside that container.

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

### End-to-end check

With the server and kernel running:

```bash
npm run e2e
```

It signs in as staff with the setup token from `<DATA_DIR>/setup-token`, opens two independent
clients against a fresh seminar, types a cell on one, presses Run on the other, and asserts that the
output, the execution attribution and a file written by the cell all reach the *second* client — the
whole realtime + execution + CRDT chain in one pass.

## Not in this MVP

Courses, assignments, grading, submissions, progress tracking, analytics, permissions,
SSO, GPU scheduling, multiple languages, package management, Kubernetes, video. All deliberately
out of scope: the MVP exists to answer whether one link and one shared workspace is enough to run a
real seminar.
