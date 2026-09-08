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
│              │  $ python analysis.py           │              │
└──────────────┴───────────────────────────────┴──────────────┘
```

## Run it

Production runs on one Linux amd64 VM with k3s/containerd. The web app runs as
UID 1000, without a Docker socket or Kubernetes credentials. A private runtime
broker creates a separate Jupyter Pod, token and filesystem view for each seminar.
A missing runtime, image or policy fails execution; rooms never fall back to a
shared instance-wide kernel.

Use an explicit published release and its matching deployment bundle:

```bash
python3 scripts/release.py validate --release release.json
sudo scripts/cluster.sh install --release release.json --env-file instance.env
sudo scripts/cluster.sh smoke
```

For private images, add `--registry-config /path/to/pull-only-config.json`.
The release records real app/broker/kernel image digests, `sourceCommit`, exact
k3s and GPU tooling versions, and hashes of its archived deployment tools.
Installation rejects modified or mismatched tooling. Builds use a Git archive of
that commit, so untracked and edited working-tree files cannot become release code.

The app is available to the host proxy at `127.0.0.1:30080`. Use `make host` or
`make host-direct` to give students an HTTPS address. Keep broker and Kubernetes
ports private. GPU releases preserve the host driver, install pinned container
runtime tooling and device plugin, and must pass a real CUDA operation.

Read [single-node installation and operations](deploy/k3s/README.md),
[the runtime boundary](runtime/README.md), and [Vast VM deployment](docs/deployment-vast.md).
The installer refuses an unmanaged existing k3s installation and an existing
legacy `colloq.service` unit. An old root
`colloq.service` installation is a migration: stop and remove the old unit,
preserve/export its data,
and prepare a clean k3s deployment before importing a compatible portable backup.
The compatibility `service-*` commands now manage k3s; they do not update the old
root systemd service or silently convert its database directories into PVCs.

### Backing it up and restoring

Application state is under `/var/lib/colloq`: separate `data` and `workspace`
local volumes, persistent secrets/configuration, and installed release metadata.
Local volumes survive Pod replacement, but do not survive losing the VM disk.
Keep verified backups off the machine.

```bash
sudo make backup MODE=consistent   # stop app, broker and every room writer
sudo scripts/cluster.sh start      # resume deliberately after the backup
sudo make backup MODE=live         # SQLite snapshot plus independently copied files
sudo make restore ARCHIVE=backup.tar.gz RELEASE=release.json REPLACE=1
sudo scripts/cluster.sh prepare --release release.json
sudo scripts/cluster.sh start
```

A live backup is **not an atomic snapshot** of the database and workspace.
Consistent backup stops every writer and loses active Python memory. Portable
archives include database, workspace, application/runtime secrets, configuration
and the release/catalog required to interpret them. Images remain in the registry.
`make restore-legacy DB=old.db FILES=old-files.tar.gz` is the explicit old local
backup format; it is refused over an installed cluster.

Backup, restore and cluster mutations share one reentrant operation lock.
An interrupted restore leaves a durable `.restore-in-progress` marker; starts
and deployment changes refuse to run until recovery finishes. Repeat the verified
restore with `RECOVER=1 REPLACE=1` when recovering that interrupted operation.
After restore, schema compatibility comes from the restored release, rather than
stale installed-version metadata. That override is consumed before the app can
run a database migration. A rollback across incompatible schemas needs the
matching backup, not just an older image.

```bash
sudo scripts/cluster.sh update --release next-release.json
sudo scripts/cluster.sh rollback --release previous-release.json
sudo scripts/cluster.sh status
sudo scripts/cluster.sh logs
```

Use the deployment tools from the chosen release for either operation. Updates
and rollbacks take a consistent backup and replace the single app/broker and
room workloads. They have maintenance downtime; notebook files survive, Python
variables do not. A k3s version change is a separate, explicitly planned upgrade.

### Local development

```bash
make up                         # explicit Docker development target
# Or develop the app on the host:
npm ci
make dev                        # build the room kernel image; no shared Jupyter service
NODE_ENV=development KERNEL_BACKEND=docker npm run dev
```

Docker development still uses a separate container per room. Access to the Docker
socket is restricted to this explicit development backend, which is not a
production security boundary. `make up` builds the kernel image before starting
the app. `make run` builds and launches the host server with the same explicit
backend. Both use local `data/` and `workspace/`.

The example sets `BIND_ADDR=127.0.0.1`. Without that setting, the development
server and Compose publication default to every interface of the machine,
including classroom Wi-Fi. In Compose the setting controls the host port;
the app inside its container must listen on all interfaces.

Native macOS filesystem development requires an additional deliberate
`COLLOQ_UNSAFE_DEV_FILES=1` opt-in, for example:

```bash
COLLOQ_UNSAFE_DEV_FILES=1 NODE_ENV=development KERNEL_BACKEND=docker npm run dev
```

This unsafe filesystem mode is never a production option. Linux production
requires descriptor-anchored filesystem access through `/proc/self/fd` and fails
closed if that secure filesystem capability is unavailable.

## Giving the room a link

A seminar on `localhost` is a seminar for one person. There are four ways to give the room
an address, and choosing between them is really one question: does this machine have a
public address of its own?

| Transport | Command | Good for | The price |
| --- | --- | --- | --- |
| Quick Cloudflare tunnel | `make host` | trying it out, a one-off demo | random URL, dies with the terminal window, and not reachable from Russia |
| Named Cloudflare tunnel | `make tunnel-setup` once, then `make host HOST=seminar.example.ru` | a fixed address for a room outside Russia | same edge addresses, so still not reachable from Russia |
| Your own relay | `make host HOST=hse.colloq.ru` | a laptop, a room behind NAT, a rented box — anything without a public address | one shared machine on the path, and it is a single point of failure for every name under it. Sizing matters, see below |
| Straight off this machine | `sudo make host-direct HOST=hse.colloq.ru` | a dedicated machine with a public address and real ports 80 and 443 | it must actually have those ports open, plus root and a Cloudflare DNS token. `caddy` runs here as a service |

The rule of thumb: **your own machine with a white address — direct; a laptop or a rented
machine — a tunnel.** Two hundred students should not be routed through a relay when the
machine holding the class can answer for itself; see *Straight off this machine* for the
measurement that made this a rule rather than a preference.

With nothing else said, `make host` opens a Cloudflare tunnel and hands you a URL the
whole room can open:

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

### Reaching a room from Russia

A Cloudflare tunnel always comes out on Cloudflare's edge addresses, and the proxying
cannot be turned off for them — a `*.cfargotunnel.com` record only means anything behind
their proxy. Those addresses do not open from Russia. So a seminar published through
Cloudflare is unreachable to exactly the room it was published for, and you find that out
when thirty people have the link and none of them can open it.

The way out is your own relay: one machine with a public address, `caddy` for TLS and
`frps` for the tunnels. The instance still dials *out* to it, so nothing changes on the
teacher's side — no public IP, no port forwarding, and every cell is still executed on the
teacher's machine.

```bash
make relay-setup WHERE=root@203.0.113.11   # once, on the relay
#   → prints the four lines to paste into .env of every instance
make host HOST=hse.colloq.ru                 # every time after that
```

The four lines are `RELAY_DOMAIN`, `RELAY_ADDR`, `RELAY_PORT` and `RELAY_TOKEN`; they are
in `.env.example`, commented out. `make host` picks the transport from the name you ask
for: a name under `RELAY_DOMAIN` goes through the relay, anything else through Cloudflare.
With `RELAY_DOMAIN` empty there is no relay and everything goes to Cloudflare, which is the
right default for anyone the edge addresses do open for.

The relay is the one part of Colloq that is not on your own machine, and it is a single
point of failure for the addresses under it. Subdomains are handed out by `frps` against
the shared token, so one relay serves every instance without a DNS record per university:
`*.colloq.ru` points at it once (`scripts/dns.sh`).

**Size it for the room, and this is measured, not guessed.** During a live class, two
hundred students went into reconnect loops every few minutes. The logs said why: the relay
was a 951 MB VPS with no swap, and the kernel OOM-killer had fired 36 times that day,
taking down `frps` (209 MB resident) and `caddy` (186 MB across two hundred sockets) in
turns. Every kill drops every tunnel on that machine at once, so a single undersized relay
takes out every seminar under the domain, not just the busy one. For a real audience the
relay needs 2–4 GB — or the class should not be going through it at all, which is what the
next section is for.

Most of the time a student opens the link before anyone has dialled in — the instance is
off, the laptop is shut, the tunnel is not up. The relay answers that with a page of its
own instead of frp's default ("the page you requested was not found… faithfully yours,
frp"), which tells a student neither what happened nor what to do. Ours says, in Russian
and without blaming anyone, that the room has not been opened yet, and that the page
reloads itself every twenty seconds — so whoever came early ends up in the room without
pressing anything. It is one file with no external requests at all, because it is read on
a phone over cellular in a lecture hall. The same page covers the neighbouring failure:
`handle_errors` in the Caddyfile serves it when `frps` itself is down, where a bare gateway
error would read as "the internet is broken".

The text lives in `scripts/relay-setup.sh`, and editing it does not need the whole setup
again — nothing is restarted, both daemons read the file per request:

```bash
make relay-page WHERE=root@203.0.113.11
```

### Straight off this machine

When the machine that holds the class has a public address of its own, the relay is a
detour: the class leaves the machine, crosses a rented VPS somebody has to keep alive, and
comes back. Two hundred sockets on a 951 MB relay is exactly how that detour fails, and it
fails for every seminar under the domain at once. So a machine with a white address serves
the room itself:

```bash
sudo make host-direct HOST=hse.colloq.ru
```

Three things happen, in this order, and the order is the point.

1. **The ports are checked from outside, before anything is changed.** The script finds
   the address the outside world sees, briefly binds 80 and 443 itself, and asks
   check-host.net to connect to them from Germany and Finland. Both open — it goes on;
   either one closed — it refuses, says which port and why, and points at the tunnel
   instead. This is not a theoretical failure: on a rented vast.ai box only the forwarded
   ssh port is reachable. The offers advertise `direct_port_count`, but real 80 and 443 are
   not handed out at all, so the direct mode is impossible there and the script says so in
   words instead of hanging on a certificate that will never be issued. If the checking
   service itself is unreachable, that is said out loud rather than treated as a pass:
   the run continues only when the address is on this machine's own interface, and
   `COLLOQ_DIRECT_FORCE=1` is the way to overrule the verdict knowingly.
2. **The name is pointed here** — an `A` record for that one name, through the Cloudflare
   API, **never proxied**. The grey cloud is the whole point: an orange one would send
   students to Cloudflare's edge addresses, which is the thing this project keeps working
   around. The record is written by `scripts/dns.sh point <name> <address>` — the same
   reconcile logic that keeps the zone in order, so "delete the stale, create the missing,
   never leave proxying on" lives in one place. It also removes a leftover `CNAME` on that
   name (one that `make tunnel-setup` may have created), because Cloudflare will not hold
   a `CNAME` and an `A` on the same name.
3. **`caddy` is installed here** — one binary, the same way `relay-setup.sh` does it — with
   a config of exactly one site: `<name> { reverse_proxy 127.0.0.1:<PORT> }`. The
   certificate is issued automatically over HTTP-01, which is what ports 80 and 443 were
   checked for. Websockets need no extra configuration; `X-Forwarded-Proto` is set because
   the staff cookie's `Secure` flag is decided by it.

Then `PUBLIC_URL` is rewritten and the app restarted, exactly as the tunnel transports do
(k3s app, development container, or `make run` — whichever is holding the port).

**The window is not what holds the address.** `caddy` is a systemd service; it survives the
closed terminal, the dropped ssh and the reboot, and Ctrl+C does not take the seminar down.
The script says so instead of pretending otherwise, and `PUBLIC_URL` stays pointed at the
public name rather than being rolled back to `localhost` on exit. To take the address down:
`systemctl stop caddy`. To see why a certificate has not arrived: `journalctl -u caddy -f`.

Two more things worth knowing. It needs `CF_TOKEN` (and optionally `CF_ZONE`) in `.env` —
a Cloudflare token with `Zone:Read` and `DNS:Edit`. And an `A` record on a specific name
beats the `*.colloq.ru` wildcard, so while that record exists the name leads here and not
to the relay; the script says this at the end, and `scripts/dns.sh` with no arguments puts
the wildcard back in charge.

Everything is idempotent: run it again after changing the name or the port and the config,
the record and the service are simply brought to match. It refuses to touch an
`/etc/caddy/Caddyfile` it did not write, so a machine already serving somebody else's site
is left alone.

## Renting a machine

Vast deployment selects an on-demand **VM**, provisions the same release-bound
k3s installation, restores only that named instance's backup, and checks room
execution before publishing success. It requires an explicit release file and
matching archived tooling; it does not rsync a mutable working tree and build it
on the rented machine.

```bash
make vast-up NAME=hse RELEASE=/path/to/release.json HOST=hse.colloq.ru
make vast-status NAME=hse
make vast-sync NAME=hse
make vast-logs NAME=hse
make vast-down NAME=hse
```

`vast-up` can create a paid VM, and `vast-down` destroys its disk. The commands
retain the price and destruction confirmations, SSH identity checks and named
backup directories. Before renting, declare public images or provide a pull-only
registry configuration; private repository credentials are not forwarded as
application credentials. GPU availability includes a CUDA operation, not just an
app health response. Vast VM disks require independent off-node backups.

See [the complete Vast procedure](docs/deployment-vast.md) for registry settings,
GPU requirements, backup transfer and recovery. No rental is needed to run the
unit tests or develop the app locally.

## Environments

A production environment is a catalog entry pointing to an immutable kernel
image digest. A seminar stores its selected revision; changing the default or
publishing a new image does not silently change an existing seminar's Python.
Older revisions remain in the catalog while rooms reference them. Missing pinned
revisions fail with an error rather than substituting another environment.

The Environments panel lists available revisions and can choose the default for
new seminars. Production builds run outside the web app, using
`scripts/release-build.py` on a workstation or in release CI. Requirements and
`# colloq: from NAME` inheritance remain under `kernel/environments/`; publish a
new release/catalog after changing them. The panel does not require a Docker
socket or a privileged image builder.

For the explicit Docker development backend:

```bash
make env-list
make env-new NAME=nlp
make env-build NAME=nlp
make env-use NAME=nlp
```

These are development image commands. Production GPU requests come from the
operator-controlled catalog and consume one exclusive `nvidia.com/gpu` device.
No device is silently shared across rooms. See the
[release and environment workflow](deploy/k3s/README.md).

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

**A seminar has a shape, and it is picked when the seminar is created.** Three cards on the
form, and each one is a set of room rules rather than a mode the server keeps separately:

* **Обычный** — the lab Colloq has always been. Everyone types in the notebook, runs cells, drops
  files in and asks the oracle.
* **Лекция** — the notebook is the teacher's: nobody else edits, runs, rearranges, uploads, opens
  the terminal or puts a document on the room's screen. Reading, history and the oracle stay with
  the room, because a lecture is about who types, not about who may look.
* **Консилиум** — a lecture in every rule but one: what *opening a cell* means. See the lock below.

Whatever the card sets, the rules underneath it stay editable — before the class and during it,
from the room's settings — and a rule is kept by the server, not greyed out in the client. In the
order the settings show them, they are: what *opening a cell* does (the room types into one shared
text, or everyone gets a sheet of their own — this single rule is the whole difference between
`Лекция` and `Консилиум`), who edits a cell's text, who runs code (the room, one cell each, or the
teacher — cells, Run over a file and the terminal are all this one rule), who changes the structure
(the middle value lets people add cells and not delete or reorder), who may put a document on the
room's screen, who may create and edit files, whether the oracle may *act* on the room's files, two
ceilings on it — questions per hour and seconds between questions — who may read the history, who
may restart the kernel, and who may wipe shared work (outputs, the terminal transcript, the oracle's
thread). There is one list, `web/src/lib/rule-rows.ts`, and both surfaces that ask — the panel and
the room's own settings — draw their rows from it; its count is deliberately not written down here
or there, because it has already drifted twice.

Whether the oracle answers in this room **at all** — off, hints or full — is not one of those rows.
It is picked once, on the creation form, and neither the panel nor the room has a switch to turn it
back on afterwards, so an exam that wants no oracle is created that way rather than switched over
between classes. A room may tighten the instance's oracle settings and never loosen them.

Two of those have a sharp edge worth saying out loud. `run: host` without `edit: host` is not a
boundary: the kernel reads a cell's source when the queue reaches it, so a student who may not run
still writes the Python the teacher's Run executes. And `files: host` is only as strong as `run`,
because the kernel mounts the same folder: `open(...)` from a cell is a download either way. The
Files panel itself is a tree with folders — drag a file into one, or drop one in from the desktop.

**The lock on a cell** is how a lecture stops being a notebook on a screen. Each cell has three
positions, set by the teacher from the lock on its left:

* **closed** — the lecture's default: the teacher types and runs.
* **open** — the room types into that cell's shared text, under the room's own rules.
* **council** — everyone gets their own sheet of that cell. Attempts live on the server rather than
  in the shared document, the teacher pages through them and can put one on the projector, and the
  room sees only its own until then. `Консилиум` at creation makes this what a click on the lock
  does; the menu on any cell still offers all three in any room.
  Attempts are counted **in the room's one kernel, one after another** — which is the point: an
  attempt sees the `df` and the `np` the teacher prepared in a shared cell above it. The names an
  attempt defines itself the server takes away when it ends, so one student's `secret = 42` no
  longer answers the next one's `print(secret)`; what an attempt *changed* — `df.drop(...)`, a line
  written to a file — stays shared, exactly as it would from an ordinary cell. Do not check with
  this something that has to be independent (the same sentence, in the room and in the
  `studentRun` hint: `COUNCIL_SHARED_KERNEL_NOTE` in `shared/notebook.ts`).

**Banning someone** is the teacher's tool against a class being wrecked, and it is honest about
what it is. It lasts twenty-four hours — long enough for the rest of the class and the evening
after it, short enough not to reach next week's seminar — and it is enforced against a mark kept in
the browser, so a private window is a way around it. It is a way to end a disruption in the room,
not an identity check.

**A class ends with one press**, and the room stays open. *Закончить занятие* — in the room itself,
or on the seminar's row here — leaves the notebook, the files, the terminal transcript and the
oracle's answers exactly where they are, because that is what the week after a seminar is for. What
it takes away is acting: running a cell, editing, the shell, asking the oracle, uploading a file and
restarting the kernel become the teacher's, and every refusal says that the class is over rather
than naming a rule nobody changed. It is laid over the seminar's settings instead of rewriting them,
so *Продолжить занятие* — the same one press — puts the room back in exactly the settings it was
closed from. In the seminar list this is the *Finished* chip, and it is the bell rather than an
empty room: a finished seminar can be full of people re-reading the discussion, and the chip carries
a dot when somebody is in there. A room nobody is in is a different word — *Empty* — and it says
nothing about whether the class was ended.

## Configuration

Use [.env.example](.env.example) for local/operator settings. The k3s installer
passes only the application allowlist into a Secret and supplies runtime settings
through its fixed manifests. Runtime credentials and image catalogs are files;
they are not typed into notebook cells or exposed to browsers.

| Variable | What it does |
| --- | --- |
| `PORT` | Development app/host port; production host ingress is fixed at 30080 and the app listens on 3000 inside its Pod |
| `PUBLIC_URL` | Origin used in student links; update a deployed instance with `cluster.sh public-url https://example.edu` |
| `BIND_ADDR` | Development bind/publication address. Without a value it is every interface; the example uses `127.0.0.1`. Compose limits the host publication with this variable and keeps the container listener reachable |
| `KERNEL_BACKEND` | Production: `broker`. Explicit local development: `docker` with `NODE_ENV=development`. The test backend is accepted only with `NODE_ENV=test` |
| `KERNEL_RUNTIME_URL` | Private broker URL, normally `http://colloq-runtime:8787` inside the cluster |
| `KERNEL_RUNTIME_TOKEN_FILE` | App-to-broker credential file; generated and mounted by the installer |
| `KERNEL_CATALOG_FILE` | Validated immutable environment catalog file |
| `COLLOQ_UNSAFE_DEV_FILES` | Explicit nonproduction native-filesystem opt-in; macOS development requires `1`. Linux production requires secure `/proc/self/fd` access |
| `SESSION_SECRET` | Signs participant/staff credentials. Empty generates a persistent key in `DATA_DIR`; preserve it in backups |
| `INSTITUTION` / `ADMIN_EMAIL` | Institution label and the initial owner's address |
| `OPEN_SEMINAR_CREATION` | Allow anonymous API creation; off by default |
| `OPENAI_API_KEY` / `OPENAI_BASE_URL` / `OPENAI_MODEL` | Oracle provider configuration; an empty API key leaves it disabled unless configured in the panel |
| `AI_REASONING` | Request an additional reasoning field when the provider supports one; off by default |
| `KERNEL_MEM` / `KERNEL_CPUS` / `KERNEL_GPUS` / `KERNEL_SHM` | Docker-development room limits/devices. Production limits are broker configuration and GPU catalog metadata |
| `DOCKER_GID` / `WORKSPACE_HOST_DIR` / `KERNEL_NETWORK` | Docker-development socket group, daemon-visible workspace path and room network. `make up` supplies them. Leave `WORKSPACE_HOST_DIR` unset for a host-native development server |
| `KERNEL_ENV` | Docker-development default environment; production defaults are chosen from the catalog/panel |
| `MAX_UPLOAD_MB` / `MAX_SESSION_MB` | Application upload limits, not a filesystem quota against arbitrary Python writes |
| `TZ` | Instance time zone |
| `RELAY_DOMAIN` / `RELAY_ADDR` / `RELAY_PORT` / `RELAY_TOKEN` | Existing host relay transport settings |
| `CF_TOKEN` / `CF_ZONE` | Operator DNS credentials; not needed by the app |
| `VAST_TOKEN` / `VAST_REGISTRY_CONFIG` | Operator rental credential and separate pull-only registry configuration; see the Vast deployment guide |

The Oracle panel can override application provider settings. Model requests use
an OpenAI-compatible API; choose the endpoint and model appropriate for your own
installation.

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
        Private runtime broker ── fixed Kubernetes Pod/Service templates
                │
        Jupyter Pod ── one per seminar, digest-pinned, only that room's folder
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
kernel's container, in the seminar's own folder — so commands operate on the files and Python state of everyone in that room.
Production image packages are read-only; persistent environment changes are published
through a new catalog image. `ls` lists what the Files panel uploaded.
The transcript is in the document, so it is the same for everybody and it is still there when a
student joins late; each command carries the face of whoever typed it. One shell means one command
at a time: a command typed while another is running waits its turn and the room is told whose it
is. Full-screen programs (`vim`, `top`) are announced rather than rendered — a shared transcript
cannot give them a screen.

**Browsers never touch Jupyter.** The kernel token stays on the server, which also serializes the
run queue. Python inside a room can reach its own Jupyter process; the security boundary is
between rooms, with separate tokens, mounts and enforced network policy.

**Local-first editing.** Keystrokes apply to the local Yjs document immediately and sync in the
background, so typing never waits for a round-trip. The same holds for AI and execution — both are
fully asynchronous and never block the editor.

**Identity is a link, not an account.** A participant is a name plus a signed token in
localStorage. Refreshing the page, or closing a laptop mid-seminar, drops the student straight back
into the room.

### Surviving a restart

Notebook state is periodically snapshotted to SQLite. Graceful shutdown flushes
pending snapshots; abrupt power loss may lose the latest changes. A new app
process starts from persisted state and reconciles reconnecting browsers without
resurrecting old queued/running execution state.

When only the app restarts and a room Pod is still alive, it can reconnect to that
Jupyter instance. A replacement Pod has a different instance identity; terminal
metadata from the previous process is not reused. If the kernel dies or is
restarted, Python variables disappear and cells must be rerun; notebook text and
workspace files remain. Kernel failures are reported instead of leaving a queued
cell looking active indefinitely.

`cluster.sh stop`, consistent backup, update, rollback and the `service-restart`
compatibility command stop room writers as well as the app. They do not preserve
Python memory. Development `make restart` restarts only the Compose app. Plan
production maintenance between classes and verify recovery with `cluster.sh smoke`.

### Isolation

Production gives each seminar a non-root Jupyter Pod with a separate token and
only its validated room workspace subdirectory mounted. The app accesses its
private broker API; it has neither a container-runtime socket nor Kubernetes
credentials. The broker alone receives bounded namespace Pod/Service permissions,
uses fixed workload templates and resolves images from the operator's catalog.

Pod Security Admission enforces a pinned restricted policy. Room workloads drop
capabilities, disallow privilege escalation, use RuntimeDefault seccomp and have
resource limits. Network policy permits Jupyter ingress from app/broker and room
egress only to cluster DNS. Runtime errors never trigger a shared-kernel fallback.
Inside one seminar, participants deliberately share the same Python variables,
terminal and files; isolation is between seminars, not between people in a room.

Containers share a Linux kernel. Standard NetworkPolicy has a local-node traffic
exception; the host-port firewall is not a claim that every node service is
inaccessible from a Pod. Use a tested host-policy-capable CNI/firewall policy when
that boundary is required. Local PVC capacity is not an enforced per-room disk
quota, and one node is not high availability. The detailed boundary and required
checks are in [runtime/README.md](runtime/README.md) and
[deploy/k3s/README.md](deploy/k3s/README.md).

The Docker backend is available only for explicit local development, always with
per-room containers. Production cannot select it or an instance-wide Jupyter
endpoint. Linux production filesystem operations use descriptor-anchored paths;
unsafe native-filesystem compatibility requires the explicit development opt-in.

Descriptor traversal prevents symlink/path races; it does not split pre-existing
hardlinked inodes. Production assumes a clean per-room storage tree. When
migrating from a previously shared runtime, materialize regular files independently
through validated portable backup/restore, which rejects archive hardlinks and
symlinks, instead of reusing a potentially cross-linked workspace.

## Development

```bash
npm ci
make dev
NODE_ENV=development KERNEL_BACKEND=docker npm run dev
# Native macOS additionally requires COLLOQ_UNSAFE_DEV_FILES=1.
```

The app runs on :3000 and Vite on :5173 with proxying. The Docker kernel service
is an image-build target; actual rooms receive separate containers on demand.
`shared/` defines the document and runtime protocols used by the app, client and
private broker. See the local-development section above for port and filesystem
constraints.

### Tests

```bash
npm test        # unit: over 1,700 tests, a bit over two minutes, no server and no browser
npm run e2e     # end-to-end: needs the server and the kernel running
npm run perf    # budgets: bundle, API latency, CRDT round-trip
make load       # load: 500 students into one room, sockets and event loop
```

That count is the one line in this file that rots by itself — it has been wrong in both directions
already (220 when there were a thousand, 1,100 when there were 1,700) — so read it as an order of
magnitude and take the real one off the end of the run, the `ℹ tests` line. Without running
anything: `grep -cE '^\s*(test|it)\(' tests/*.test.mts | awk -F: '{s+=$2} END {print s}'`.

`e2e`, `perf` and `load` all create seminars and all delete them again on the way out. They point at
`http://localhost:3000` unless told otherwise — `E2E_BASE_URL`, `PERF_BASE_URL` and `LOAD_BASE_URL` —
which matters if an instance somebody is teaching in happens to be on that port.

All three sign in with the setup token from `<DATA_DIR>/setup-token`, and none of them *claims* an
instance nobody has claimed yet: a harness that made itself the owner would leave a stranger's name on the
install it was pointed at. So on a fresh one `e2e` stops with "nobody has claimed this instance
yet", `perf` skips the API and CRDT sections, measuring only the bundle and the network, and `load`
refuses to start at all — without a seminar of its own there is nothing it is allowed to load. Open
`/admin`, claim it once, and all three run in full.

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

### Load

`make load` answers the question `npm run perf` cannot: what one process does when a whole lecture
arrives at once. It creates *its own* seminar, joins N students (500 by default) at a given pace,
and for each one that gets in opens both sockets — `/collab/:id` and `/control/:id` — completes the
Yjs initial sync and publishes presence with a name and a colour. That last part is the difference
between a load test and a pile of TCP connections: presence is what the server fans out to everyone
else, and a silent socket would miss the traffic the room actually generates. The table at the end
holds how many got in and how many were refused *by code*, join latency, frames per second and
bytes per client at rest and under a typing storm (k students typing m keystrokes a second, each in
their own cell), how long an edit takes to reach another client, `/api/health` latency and the
`loopLagMs` it returns, and — if you name the server's pid — its CPU over the window and RSS. The
last line says where it hit a wall.

```bash
make load                                  # 500 students, 60s ramp, 20 typists at 5/s
make load N=200 RAMP=120 K=40 M=8 SPID=$(cat .colloq.pid)
make load TREE=4 COUNCIL=200 INK=25        # + the three optional sections below
```

`N` `RAMP` `IDLE` `K` `M` `STORM` `SPID`, and `TREE` `COUNCIL` `EVERY` `INK` for the optional
sections, all map to `LOAD_*` environment variables the script reads directly; `SPID` is the
development server's pid and is never guessed — use `cat .colloq.pid` under
`make run`; production Pod measurements must be collected in the cluster. The room's own door is set for a full lecture:
a seminar accepts 600 new participants a minute (`MAX_NEW_PARTICIPANTS` in
`server/src/routes/sessions.ts`), so 500 students arriving inside one minute all get in. It used to
be 120, and this harness is why it is not: a 500-student run came back 122 in and 378 refused, and
a client does not retry a 429 by itself. Stretching `RAMP` or passing `STAFF=1` — the staff cookie
skips the limit — is now a way to shape the arrival curve, not a way around a wall. On a
laptop, 500 connected clients cost about 4.5 KB/s each and 2.2 MB/s out of the server while
*nobody is typing*: that is presence alone, and it grows as the square of the room.

What a storm costs is measured too, and it is the number the fan-out work was for. Two runs of
`make load N=500 K=50 M=5` and two at `K=20`, harness and server on one laptop, defaults
otherwise (60s ramp, 15s at rest, 20s of storm):

| 500 in the room | at rest | 20 typing | 50 typing |
| --- | --- | --- | --- |
| server CPU (one core = 100%) | 28–31% | 47–52% | 41–42% |
| `loopLagMs` p95 | 0.2–0.7 ms | 3.3–4.4 ms | 5.8–16.3 ms |
| an edit reaching another client, p95 | — | 30–40 ms | 62–82 ms |
| bytes in, per client | 4.7 KB/s | 6.2–6.5 KB/s | 6.2–6.4 KB/s |

The at-rest column is the pair above, measured again after the server started merging a room's
frames per tick of the event loop — 4.7 KB/s per client and 2.3 MB/s out, which is where they
were. Idle cost is presence, and presence was already one frame per change; what the merging is
for is the storm column.

Read the last column with the harness in mind. With 500 sockets on it, one Node process got
55–70 keystrokes a second into the room in every one of the four runs — 61 of the 100 asked for
at `K=20`, 70 of the 250 at `K=50` — so `K=50` is not two and a half times the storm `K=20` is;
it is the same storm spread over more typists. That is why the server's CPU barely moves between
the two columns and only the tails grow, and it is why one of the two `K=50` runs printed
*стенд ждал СВОЕГО цикла p95 60.9ms*: the generator is what gave out. What the runs do say is
that a room of five hundred with fifty people typing costs this server about half of one core,
and that its own loop stays inside 20 ms at p95 while a client waits under a tenth of a second
for somebody else's letter. Whether the cost is linear in K needs the storm generated from a
second machine; from one laptop the question cannot be asked.

Three more sources of fan-out have sections of their own. All three are off by default — they are
the only ones that leave more than sockets behind in the room — and each is a *different* shape of
fan-out, which is the point of having them apart from the storm:

```bash
make load TREE=4 TREE_SEC=20          # 4: the room's whole file list, to everyone, per change
make load COUNCIL=200 EVERY=2         # 5: 200 sheets against one host's remote
make load INK=25 INK_SEC=20           # 6: one presenter's pen and pointer, to every viewer
```

Section 4 joins an extra teacher tab and has it create files while everybody else sits still: every
file is a `broadcastFiles`, the room's whole file list to every control socket, so the per-client
bytes there next to the same number in section 2 is the price of one file times the room — and it
grows with the folder. Section 5 opens a council on a cell and has N students snapshot their sheet
every `EVERY` seconds, then submit all at once; the stack is assembled per snapshot and goes to
**one** socket, so it is read off the teacher's own remote rather than the per-client average, and
the room-wide part — the counter moving on every submit — is the rush at the end. Section 6 starts a
lecture on an empty `.pdf` and draws: `ink` goes to every viewer on every frame, `laser` the server
coalesces to its own tick, and the two counts next to the bytes the room received are the
difference. Nothing here renders a page, so what these measure is the fan-out, not the drawing.

No run of these three at five hundred is written down yet, so the table above is still a table
about *typing*: read a green run as "the sockets and the event loop held for what this run did",
and if you want a number for a council or a lecture at that size, the way to get it is now in the
harness rather than in an argument.

What it does not measure: it never renders a page, never lays out a cell and never runs the kernel.
This is load on the websockets and on the event loop, and a real tab costs more on top of these
numbers. It is also one Node process holding N Y.Docs, so on the same machine it competes with the
server for the same cores — it watches its own event loop and says so when the harness is the
bottleneck, but the honest arrangement is to run it from somewhere else.

Never point it at a seminar somebody is teaching in — and you cannot: it works only in the room it
made itself and removes it in a `finally`, Ctrl+C included. Five hundred rows of participants left
in a real seminar's database never go away.

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

Courses, assignments, grading, submissions, progress tracking, analytics,
SSO, multiple languages, package management, Kubernetes, video. All deliberately
out of scope: the MVP exists to answer whether one link and one shared workspace is enough to run a
real seminar.

Permissions used to be on that list and are not any more: a room has twelve rules, three shapes to
start from and a lock per cell — see *The teaching side*. What is still absent is anything
per-person: rules apply to the room, and the only thing aimed at one participant is a ban.

GPU scheduling is out of scope in the same way, and `KERNEL_GPUS` is not it: a room holds one
slice for as long as its container lives, handed out first-come. Nothing queues, shares or
preempts, and when the slices run out the kernel refuses to start and says so — a seminar whose
wheels are built for CUDA cannot be quietly given a CPU instead.
