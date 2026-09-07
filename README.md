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
make up
# without make: cp .env.example .env && mkdir -p data workspace && docker compose up --build
```

The `mkdir` is not decoration. `./data` and `./workspace` are bind-mounted, and a bind mount
whose source does not exist yet is created by the Docker daemon as `root` — while the server
runs as `node` and cannot then write its own session key. `make up` does it for you, and it also
works out the group that owns `/var/run/docker.sock` and writes it to `.env` as `DOCKER_GID`,
which is what lets each seminar get a kernel container of its own (see *Isolation*).

The first boot prints a setup token. Open <http://localhost:3000/admin>, paste it in with your
name and email, and the instance is yours — then create a seminar and share the link it gives you.

`make` with no target lists everything. The two that matter are `make host` and
`make env-use`; both have a section below.

That is the laptop shape, and it is the right one for trying Colloq out or running a class
off your own machine. A machine whose *job* is hosting seminars — including a rented one —
runs the server on the host under systemd instead, with only the room kernels in Docker:
`make service-install`, described in *On a dedicated machine*.

### Backing it up

```bash
make backup     # → backups/colloq-<date>.db
                #   backups/colloq-<date>-files.tar.gz
make restore    # puts the newest pair back
```

The `.db` is the database — the seminars, the staff list, the version history, the
oracle settings. The archive beside it is everything the database does not hold:
`./workspace` (what the rooms uploaded), the setup token, and the signing key when the
server generated one rather than reading `SESSION_SECRET` from `.env`. Both files are
mode 0600, and the archive is not "the seminar's files" to forward to a colleague: it
carries the keys to the instance.

Both are written in one pass so that they belong to the same minute, and the pass is
safe to run mid-seminar. Copying `data/colloq.db` by hand is not — SQLite runs in WAL
mode, so part of the day sits in `colloq.db-wal` beside it and a copy of the one file
alone can be hours behind. `make backup` writes a single consistent file instead.

Restoring used to be described as putting the two back, and the two are three: the WAL
journal beside the database is the third, and a restored database with the previous
journal still next to it is corrupted quietly. `make restore` is the other half of
`make backup` — it refuses to run while a server is up, moves the old database aside
*with* its journal instead of deleting it, and unpacks the archive over `./workspace`
rather than replacing it. `DB=` and `FILES=` name specific files when the newest pair is
not the one you want, and `NAME=` names a rented environment: its copies live in
`backups/<name>/` rather than in the root, which belongs to this machine's own instance
(see *Several environments at once*).

What it deliberately does not restore is the environment images: rebuilding them
(`make env-build NAME=…`) is cheaper than carrying tens of gigabytes around.

### One instance, three ways to start it

`make up` runs everything in Docker. `make run` builds and runs the server on your
machine with only the kernel in Docker — faster after a code change, which is why it
exists. `make service-install` puts the server on the machine itself under systemd and
leaves only the room kernels in Docker; that is the shape for a machine that hosts
classes, and it has a section of its own below. **They are the same instance:** all
three keep the database in `./data` and the seminars' files in `./workspace`, next to
this README, so a seminar created one way opens the other way and a backup is a copy of
two folders.

They cannot run at the same time — all three want port 3000 — and each of them says so
rather than failing halfway. `make up` is the one to use on a laptop unless you are
changing code; `make down` stops the Docker one, `make stop` the host one,
`make service-stop` the service.

Two of the three open that port on **every interface of the machine**: under `make run` the
server binds them all, and under `make up` Compose publishes there. In a lecture hall that
means the room also answers at `http://<the laptop's ip>:3000` — past the link you handed
out, past the tunnel, and with nothing on screen to say so; the server prints one line about
it in the log at startup. `BIND_ADDR=127.0.0.1` in `.env` is the loopback-only shape, and it
means the same thing both ways (the server binds the loopback; Compose publishes on it), with
`make host` as the way in for the class. The systemd service sets it already.

Before this they were two instances: `make up` kept its data in Docker named volumes
(`colloq_data`, `colloq_workspace`) and `make run` in `./data` and `./workspace`. If
you have seminars in the old volumes, move them over once before starting:

```bash
docker run --rm -v colloq_data:/from -v "$PWD/data":/to alpine cp -a /from/. /to/
docker run --rm -v colloq_workspace:/from -v "$PWD/workspace":/to alpine cp -a /from/. /to/
docker volume rm colloq_data colloq_workspace
```

### On a dedicated machine

A machine whose job is to host seminars — a box under a desk, a university VM, or one
rented by the hour — runs the server *on the host* under systemd, with only the room
kernels in Docker:

```bash
git clone <this repo> /opt/colloq && cd /opt/colloq
sudo make service-install     # Ubuntu/Debian
```

That one command checks that nothing else is holding the port, writes `.env` if it is
missing, installs Docker when it is absent, installs Node 20 from nodesource, runs
`npm ci` and the build, builds the kernel image of the active environment, gives
`./workspace` the ownership that image needs, writes `/etc/systemd/system/colloq.service`
out of `deploy/colloq.service`, enables it, and waits until `/api/health` says the
instance can actually hold a class. Every step is idempotent, so it is also the update command:

```bash
git pull && sudo make service-install     # rebuild and restart
make service-status                       # alive? and ready to teach?
make service-logs                         # journalctl -u colloq -f
make service-restart                      # after editing .env by hand
make service-stop                         # the room kernels keep running
make host HOST=hse.colloq.ru              # the address the room opens (via the relay)
sudo make host-direct HOST=hse.colloq.ru  # …or straight off this machine, if it has
                                          # a public address and real 80/443
```

**Why not `make up` here.** It broke twice on dedicated machines, and both times the
cause was the same: a server inside a container cannot see what is around it. The data
directories were created by the Docker daemon as `root` while the server inside runs as
uid 1000, so the database would not open at all and the container looped on restarts.
And the panel could not build an environment, because building one *is*
`docker-compose.yml`, `kernel/Dockerfile` and `.env` — none of which exist inside the
image. On the host all three lie next to the server, the panel is fully powered, and
there is no second user to disagree with.

**The price, said out loud.**

- **The service runs as root.** It is stated in `deploy/colloq.service` along with the
  reason: the server needs `/var/run/docker.sock` to give each room a kernel of its own,
  and access to that socket *is* root on the host — "a normal user in the `docker`
  group" is the same power under a politer name. The other half is ownership: the
  kernel container writes the seminars' files as uid 1000, and root is the only user
  that reads and edits both its own files and those without a single `chown`. It is the
  same power the server already had under `make up` (the socket is mounted into the
  container) and under `make run`; what is new is only that it is now said in a unit
  file. Nothing has to be opened inbound for any of it — the instance reaches the room
  through an outbound tunnel, see below — and the machine is dedicated to this.
- **Node lives on the machine.** Node 20 from nodesource — the distributions' own
  packages are older than the project builds against, and `nvm` installs into a shell
  that systemd never sees. The build happens on the machine too: `npm ci` and Vite take
  a few minutes on the first install.
- **Updating is `git pull`, a build and a restart** — that is, `sudo make
  service-install`. There is no image to pull, and the seminar is down for the couple of
  seconds the restart takes. Rooms come back without anybody reloading (see *Surviving a
  restart*).

**One subtlety worth knowing, because it is invisible.** Under the other two ways of
starting, the server and the kernel happen to run as the same uid 1000 — `node` inside
the app container, or you on your own machine — and they share `./workspace` without
anyone having to arrange it. As a service the server is root and the kernel is still uid
1000, so the share has to be built: the unit sets `UMask=0002` and the installer gives
`./workspace` the kernel's group and the setgid bit. New room folders then come out
group-writable and inherit that group, and both sides write the same bytes. Without the
pair, the first `open('out.csv', 'w')` in a cell fails with `PermissionError` on a screen
where everything looks green. The group number is asked of the built kernel image rather
than assumed to be 1000, because an environment built on top of somebody else's CUDA base
can end up with a different one.

Two `.env` lines matter here and only here. `WORKSPACE_HOST_DIR` must be empty: the
server reads it as "I am inside a container" and would then put the room's kernel on the
compose network and address it by container name, which does not exist from the host —
`make service-install` refuses to install over it. And `KERNEL_ISOLATION=off` means
something different on this shape: there is no shared compose kernel running here, so it
leaves the rooms with no Python at all rather than with one they share.

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
(systemd service, container, or `make run` — whichever is holding the port).

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

A seminar with neural networks needs a GPU, and the university's A100 is either busy or
not there at all. `make vast-up` rents one by the hour on vast.ai, puts Colloq on it and
hands it the data from your latest backup:

```bash
make vast-up       # find a VM, rent it, deploy, restore the data
make vast-status   # what is rented, whether it and its address answer, what it has cost
make vast-sync     # pull the data back here
make vast-logs     # pull the logs back here, to find out what happened in class
make vast-down     # destroy the machine, and everything on it with it
```

`VAST_TOKEN` in `.env` is the key (made once at <https://cloud.vast.ai/manage-keys/>). It
is never printed, never passed on a command line — `ps` shows those to everyone on the
machine — and never copied to the rented box: that box is already paid for.

The rented box is a dedicated machine like any other, and it is set up the way the
section above describes: Docker (plus the NVIDIA container toolkit when there is a card)
and `frpc` for the tunnel, then `make service-install` — Node, the build, the kernel
image and the systemd service. The repository lives in `/opt/colloq` there, the `.env`
travels with it minus the keys that pay for things, and the server runs on the host
rather than in a container, which is what makes the panel able to build environments on
the machine that has the GPU. Watching it live is `ssh … 'journalctl -u colloq -f'`; a code
change is another `make vast-up`, which rsyncs the repository and re-runs the same
idempotent install.

### What happened in class

Afterwards is a different question from live, and it needs more than one log: the server
writes to the systemd journal, and every room's kernel writes to its own container. One
command brings all of it here:

```bash
make vast-logs NAME=hse              # today, into logs/hse/<date>/
make vast-logs NAME=hse SINCE=-2h    # the last two hours
make vast-logs NAME=hse SINCE=yesterday
```

`SINCE` is said in `journalctl`'s own words and defaults to `today`. What lands is
`colloq.log` — the service journal — next to one file per room kernel, named after its
container, **including the stopped ones**: a container that was stopped on the break
still holds the log that says why.

**Secrets are cut out on the way, not afterwards.** The journal carries request lines
with their query strings, and one-time file tokens ride in those; it also carries the
setup-token link the server prints on every boot while nobody owns the instance, and that
link *is* the key to the whole instance. So the filter sits on the pipe — nothing
unredacted ever touches the disk here. It replaces the value of `token`/`key`/`sig` and
their relatives in query strings, `Authorization` and `Cookie` headers, participant
tokens (`body.signature`, recognisable by shape), provider keys (`sk-…`) and
`SOMETHING_SECRET=…` lines with `<вырезано>`. It is `scrub` in `scripts/vast.sh`, and it
is deliberately a shape-matcher rather than a list of known names: missing one is worth
more than over-cutting. Names and cell contents are not a concern — the server never
writes those to the log at all, only numbers and room ids.

`logs/` is git-ignored, like `backups/`.

**What is in the service journal.** A whole day of it used to be ninety lines, all of
them failures — you could not tell from it how many rooms had been live, or when a kernel
died. It now writes two different kinds of thing, both through the same `console` every
other line here goes through; there is no second logger.

Once a minute, one summary line, and only when something is going on:

```
[minute] rooms 2 · people 41 · kernels 2 live (1 busy) · frames 1204 · gate refused 3
```

Zero counters are left out, and an instance with no live room and nothing counted writes
nothing at all — 1440 lines a night saying "nothing happened" hide the real thing exactly
as well as an empty journal does. `frames` is accepted CRDT sync frames, which is the one
honest measure of a room being *worked in*; the rest are refusals.

And one line per thing that actually happened: `[room <id>] opened`, `[kernel <id>] up`,
`[kernel <id>] died`, `[kernel <id>] oom`, `[gate <id>] edit refused — <why>`,
`[join <id>] refused`, and `[ai] request failed …`. The ones that can arrive as an
avalanche — a gate refusal, a room hitting the join limit, a kernel that will not
start — are said once a minute per room and counted the rest of the time.

`[join …]` is the exception that is deliberately per-request: one short line for every
person who joins, saying whether they came back as themselves or got a new row, and if
new, which check failed (`no id`, `no token`, `bad token`, `other room`, `other person`,
`row gone`), plus the role and where it came from (`staff`, `host-token`, `link`). Five
hundred students is five hundred lines, which a journal carries fine — and without them a
room accumulating five hundred rows of the same person cannot be explained at all.

Nothing personal goes in: no participant names, no avatars, no cell contents, no token
material. Numbers, room ids and participant ids only.

An aborted request — a student who closed the tab mid-load — is not logged at all, only
counted as `aborted N` in the summary. On a lecture of five hundred those were hundreds
of four-line stack traces about the server having done nothing wrong.

One command covers a whole class — rent a machine with a named card, deploy, restore the
newest backup this environment has here, and put the room on its address:

```bash
make vast-up GPU="RTX 5070" HOST=demo.colloq.ru
```

`GPU=` is the card for today and outranks `VAST_GPU` in `.env`. Naming a card also drops
the default 24 GB memory floor, because a named card *is* the memory decision: an RTX 5070
has 12 GB, and the floor turned "I want a 5070" into "no offers" without a word about
which condition threw them out. A `VAST_GPU_RAM` line you write into `.env` yourself still
applies — and still hides the 5070.

`HOST=` is the address the room opens on, and `vast-up` raises it on the rented machine
instead of telling you to. A name without a dot is a subdomain of `RELAY_DOMAIN`
(`demo` → `demo.colloq.ru`); a name with a dot is taken as written, exactly the way
`make host` reads it. The name and the `RELAY_*` lines are checked *before* renting: a
machine is billed from its first second, and "that name does not resolve" costs the same
to find out on either side of that. Cloudflare is not an option from the rented box —
`cloudflared` is not installed there, and its addresses do not open from Russia anyway —
so the name has to sit under `RELAY_DOMAIN`. Neither is the direct mode: vast gives a
rented box only its forwarded ssh port, and real 80 and 443 are not handed out at all
(the advertised `direct_port_count` is not them), so `make host-direct` there would refuse
on its own port check. A rented machine reaches the room through the relay, full stop.

On the machine the address is the same `make host`, which holds its terminal for as long
as the tunnel lives, so `vast-up` starts it in a `tmux` session called `colloq-host`: the
tunnel then outlives the ssh session, and the closed laptop with it. Then it waits — not
for tmux to start, but for `https://<name>/api/health` to answer from here, with a
three-minute ceiling, because a link printed before it answers is handed to the room once
and debugged for the rest of the hour. If it never answers, the script prints the tail of
that tmux session and names the three things to look at: the session's log, `RELAY_*` in
the `.env` on the machine, and whether the name resolves. `make vast-status` asks the same
two questions later — is `colloq-host` still alive, and does the address answer.

### Several environments at once

One rented machine is one environment. `hse.colloq.ru` and `demo.colloq.ru` are two
machines, two bills and two databases; all they share is this repository and the relay.
An environment is named by one word, and it is the same word three times over: the first
label of the address, the instance's label on vast (`colloq-demo`), and the directory
its backups live in (`backups/demo/`).

```bash
make vast-up NAME=demo HOST=demo.colloq.ru
make vast-status                 # every environment: card, price, spent, address
make vast-status NAME=demo      # the details of one, as before
make vast-sync NAME=demo        # into backups/demo/
make vast-down NAME=demo
```

`NAME` can be left out when `HOST` is there — the name *is* the first label of the
address, and asking for the same word twice buys nothing — and it can be left out while
only one environment is rented: that one is taken, and the script says which. The moment
there are two, `vast-sync` and `vast-down` refuse without a name and print the list
instead. Destroying the wrong machine cannot be undone, and deploying one seminar's
database onto another's address is the same loss with a delay; either costs more than the
convenience of a word not typed.

Backups are split for that second reason. `make vast-sync NAME=demo` writes into
`backups/demo/`, and the deploy onto a rented machine takes the newest copy *from that
directory only*: nothing there means an honestly empty machine, not the neighbour's
database. The root of `backups/` stays with this machine's own instance — that is where
`make backup` writes, and what `make restore` reads unless an environment is named.
Copies already lying there keep working exactly as before; they are simply the unnamed
environment's.

The machine rented before any of this carries the plain `colloq` label, and it counts as
that unnamed environment rather than being orphaned. `make vast-up HOST=demo.colloq.ru`
still reaches it: with no `colloq-demo` around, the script asks that machine which
address it is serving — `PUBLIC_URL` in its own `.env` — and if the answer is
`demo.colloq.ru`, renames the label in place (`PUT instances/<id>/`, field `label`, the
same call that starts a stopped instance) and carries on. Nothing is recreated, the
tunnel does not blink, and the question is asked once. If the answer is some other
address, that machine is left alone and a new one is rented for the new environment. If
it cannot be asked at all — stopped, or SSH silent — nothing is adopted and nothing is
assumed; `make vast-adopt NAME=demo` does the rename by hand, after showing what it
knows.

An environment is another machine: another bill by the hour and another set of data. Two
seminars on one machine would be one database and one address again, which is what the
split is there to prevent; the relay and this repository are all they are meant to have
in common.

Three prices, and they are the point of this section rather than footnotes to it.

**Only VMs, which is the expensive half.** vast rents two different things: a Docker
instance, which is a container on somebody's machine, and a virtual machine —
`vms_enabled=true`, booted from a `docker.io/vastai/kvm` image. Colloq starts a container
per room itself, through the Docker socket, and inside a Docker instance vast forbids
exactly that: "Docker-in-Docker is disabled for security", their own FAQ. The rooms would
fall back to one shared kernel, where any room reads every other room's files — and the
fallback is quiet enough to be noticed after the class rather than during it. So a VM it
is, and VMs are a smaller market: fewer machines, fewer cheap ones, and minutes rather
than seconds to boot.

**Only on-demand.** Interruptible offers cost about half and are taken away the moment
somebody bids higher, without warning. That moment lands in the middle of a class, and
the saving buys nothing.

**The data on it is temporary.** Destroy the instance and the disk goes with it; let the
balance reach zero and vast destroys it for you. There is no snapshot and no trash. That
is why `make vast-sync` is half of this work rather than a convenience, why
`make vast-down` prints when the last backup was taken and asks you to type
`уничтожить`, and why the machine is deployed *from* a backup instead of starting empty.

What survives a machine being recreated is what `make backup` writes: the database,
`./workspace`, the signing key and the setup token — plus `.env`, which travels with the
repository, minus the keys that buy things (`VAST_TOKEN`, `CF_*`). What does not survive
is the environment images; they are rebuilt there with `make env-build NAME=cv`, or from
*Build* in the panel — the server builds through the Docker socket, so that works on a rented
machine too, while making one the default still writes `.env` and stays `make env-use`. What the
rented machine does gain is its cards: `vast-up` writes them into `KERNEL_GPUS` in the `.env`
it leaves there, so an environment that declares `# colloq: gpu` gets a slice — see
*Environments* and the `KERNEL_GPUS` row in *Configuration*.

The room is published *from* the rented machine, with the same `make host` and the same
relay, because that is where the kernel is. `HOST=` above does this for you; by hand it is:

```bash
ssh -p <port> root@<host>
cd /opt/colloq && make host HOST=hse.colloq.ru
```

`vast-up` installs `frpc` on the machine for it — Cloudflare's addresses do not open from
Russia, see *Reaching a room from Russia*.

Two things to know before the first run. The SSH key must be registered in the vast
account *before* renting: a VM's keys cannot be changed once it is running, so a machine
rented without one is money spent on a box you cannot enter. `vast-up` checks that and
refuses early rather than late. And what has actually been run against a live account is
worth knowing exactly: renting, deploying and raising the address were done once, on a
machine with an RTX 5070 published at `demo.colloq.ru`, and that single run is where four
of the things this script now handles came from — the SSH proxy a VM does not have, a
`mktemp` that only works on macOS, the owner of a restored copy, and a second `vast-up`
onto a machine that is already live. Syncing, destroying and adopting have not been run
for real at all. They cost real money, so make the first run of them on a cheap offer, and
not on the day of a class.

That read-only search did turn up one thing worth writing down. vast's own
`cuda_max_good >= 12.1` filter drops every Blackwell offer, including the RTX 5070 and
5090, even though those same offers report `cuda_max_good: 13.0` in the response body —
measured twice in a row against the live account. The condition has not gone away, since
torch wheels are built for CUDA 12.x and will not run on 11.8; it is applied to the
response instead of asked of the server, where the answer is truthful. Otherwise the
filter would have thrown out exactly the cards the machine is being rented for.

## Environments

A seminar's Python is one set of packages. `kernel/requirements.txt` is the base — jupyter,
numpy, pandas, matplotlib, scikit-learn — and it is always installed. An *environment* is a
list of packages on top of it, one file per environment in `kernel/environments/`.

```bash
make env-list              # what exists, and which one is the default
make env-new NAME=nlp      # creates kernel/environments/nlp.txt
$EDITOR kernel/environments/nlp.txt
make env-use NAME=nlp      # builds it and makes it the default for new seminars
```

Each environment is baked into its own image tag (`colloq-kernel:nlp`), so an environment
you have built before starts a container rather than another pip install. The base layer is
shared between them, which is why an environment costs only the packages the base does not
already have.

**An environment can be built on top of another one.** A line `# colloq: from base-gpu` in
the header of the file means "build this on top of that environment's image" — pip reads it
as a comment, and the build reads it as the parent. Without such a line an environment is
built on the plain base, which is what almost all of them do. It exists for one reason: the
environment layer is a single layer, so any edit to the list reinstalls all of it, and for a
list with CUDA torch in it that is three gigabytes of wheels and nine minutes to add `timm`.
Put the heavy half in a parent — `base-gpu` here carries torch, `gpu` carries transformers on
top of it — and editing the child costs seconds. The parent is built first when its image is
missing, both from the panel and from `make env-build`; a loop or a parent that does not
exist is refused before Docker is started rather than nine minutes into a build. A `# colloq:
gpu` declaration is inherited too, because its reason is: an image built on top of CUDA
wheels needs a device whoever asked for it. The Environments screen shows what each one is
built over, and offers a rebuild when the parent was rebuilt later than the child.

**A seminar's environment is chosen when the seminar is created, and then fixed.** The room
runs its own container from that image; `make env-use` and *Make default* in the panel set
what the **next** seminar gets, and leave the ones that exist alone. A room that needs a
different set of packages is a new seminar — which is also why the choice sits in the form
that creates one. The reason it works that way: packages changing under a class mid-seminar
is worse than a class not having the newest ones.

There is one arrangement where it is still instance-wide, and it is the old one: when the server
cannot start a container per room, every seminar shares the kernel `docker compose` runs. That
happens with `KERNEL_ISOLATION=off`, and it happens when the server is itself in a container
(`make up`) and something in the chain below is missing — no `/var/run/docker.sock`, no
permission on it, no `KERNEL_NETWORK`. Then switching really does restart that one kernel and
every variable in every open seminar is gone — the notebooks and files untouched, the cells just
needing to be run again. Nothing about this is silent: the server log says it, the room's kernel
log says it, and the Environments screen says it. `make env-use` says which of the two happened —
it looks at `KERNEL_ISOLATION` and at whether any room containers are running, and when neither
answers (no rooms open, isolation on `auto`) it says that instead of guessing.

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

Everything lives in `.env` — see `.env.example` for the full list.

| Variable | What it does |
| --- | --- |
| `PORT` | Port on the host. Change `PUBLIC_URL` with it — neither derives the other |
| `PUBLIC_URL` | Origin students open; the link they receive is built from this |
| `BIND_ADDR` | Which address of this machine answers on that port. Empty — the default — is every interface, so on classroom Wi-Fi the room also opens at `http://<ip of this machine>:3000`, past the link you handed out; the server says so in the log on every start until the line is there. `127.0.0.1` is the shape for a laptop and for a dedicated machine, where the way out is an outgoing tunnel (`make host`) — the systemd unit sets it. Under `make up` the server inside the container has to keep listening on all of them, so Compose does not pass the line in: there it limits what Compose publishes on the host instead |
| `SESSION_SECRET` | Signs participant tokens and staff cookies. Leave empty — generated on first boot and kept in `DATA_DIR`. Set it to rotate |
| `INSTITUTION` | Who deployed this instance — the line beside the logo on every screen that draws it. Empty by default, and then there is no line at all. Cut at 80 characters: it shares one line with the mark |
| `ADMIN_EMAIL` | Prefills the address on the first-run claim screen |
| `OPEN_SEMINAR_CREATION` | Let anyone create a seminar through the API — `POST /api/sessions` with no staff cookie. There is no screen for it: `/` goes to the panel. Default off: staff only |
| `JUPYTER_TOKEN` | Fallback secret for the shared compose kernel. Each seminar's own container gets its own token, derived from `SESSION_SECRET` |
| `OPENAI_API_KEY` / `OPENAI_BASE_URL` / `OPENAI_MODEL` | Any OpenAI-compatible endpoint |
| `AI_REASONING` | Ask the model for its reasoning trace as well (default off — on a reasoning model the trace costs about as much as the answer) |
| `KERNEL_MEM` / `KERNEL_CPUS` | Resource ceiling: per seminar where each room runs its own container, otherwise on the one shared kernel. `KERNEL_CPUS` also caps the thread pools inside it (`OMP_NUM_THREADS` and its siblings), because `os.cpu_count()` in a container reports the host's cores and numpy would start thirty threads on two |
| `KERNEL_GPUS` | Devices the server may hand out to rooms, written the way Docker names them (`MIG-GPU-…`, `0,1`). Empty — the default — is today's behaviour: nobody asks for a GPU. A slice goes to one room for the life of its container and is recorded on it as the label `colloq.gpu=<device>`, which is what survives a server restart. Only an environment that declares `# colloq: gpu` asks for one |
| `KERNEL_SHM` | `/dev/shm` for a room that got a GPU (default `1g`). Docker's own 64 MB is what breaks a DataLoader with several workers |
| `KERNEL_ISOLATION` | `auto` (default) gives every seminar its own container, with only its own folder mounted. `off` shares one kernel, and then any room can read every other room's files on that machine. All three ways of starting can do the per-room thing; when the pieces for it are missing the server falls back to the shared kernel and says so — except under the systemd service, where there is no shared kernel running to fall back to |
| `DOCKER_GID` / `WORKSPACE_HOST_DIR` / `KERNEL_NETWORK` | What a server inside a container needs to give rooms their own kernels: the group of `/var/run/docker.sock`, where `./workspace` lives on the host, and the network to find the room's container on. `make up` fills them in; see *Isolation*. A server on the host (`make run`, the service) needs none of them, and `WORKSPACE_HOST_DIR` in particular has to stay empty there — the server reads it as "I am in a container" |
| `TZ` | One time zone for the whole instance — the log, the kernel and the dates on published pages (default `Europe/Moscow`) |
| `MAX_UPLOAD_MB` / `MAX_SESSION_MB` | One file, and everything one seminar holds (default 50 and 1024) |
| `KERNEL_ENV` | The environment new seminars are created with, and the one baked into the shared kernel. `make env-use` writes it |
| `RELAY_DOMAIN` / `RELAY_ADDR` / `RELAY_PORT` / `RELAY_TOKEN` | Your own relay instead of Cloudflare — see *Reaching a room from Russia*. Empty means Cloudflare. `make host` reads them to pick the transport by name |
| `CF_TOKEN` / `CF_ZONE` | Cloudflare token with `Zone:Read` and `DNS:Edit`, and optionally the zone id. `scripts/dns.sh` writes records with it: the whole zone with no arguments, one name for `make host-direct`. Records are always created unproxied — see *Straight off this machine*. Empty means neither works; the tunnels do not need it |
| `VAST_TOKEN` | Key to the vast.ai account for `make vast-up` and friends — see *Renting a machine*. Empty means nothing is rented; the rest of the `VAST_*` settings are defaults documented in `.env.example` |

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
        Jupyter Server container ── one per seminar, resource-capped, only that room's folder
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

The server can be killed mid-seminar — a crash, a deploy, `make restart`, `make
service-restart` — and the room comes back without anybody reloading a page. Three things make that true, and each of them was
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

A stopped server (`make restart`, `make stop`, `make service-stop`, a deploy) flushes its snapshot
on the way out, so what comes back is what was on screen. That is what SIGTERM buys, and it is why
the unit gives the service twenty seconds to stop rather than the default: the last thing the
server does is close the database properly, which is also what folds `colloq.db-wal` back in. A server that is *killed* — SIGKILL, the OOM killer, the
power going — cannot, and neither can a `colloq.db` restored from a backup: the snapshot is
seconds behind, while each open tab still holds outputs and kernel state written by the previous
server. The server no longer takes those on faith. It refuses that first frame and says so in the
room — "Сервер не знает части того, что осталось в кэше этой вкладки, — она собирается заново" —
and the tab rebuilds itself from the server's copy, once, without a reload. The few seconds
between the last snapshot and the kill are the part that is genuinely gone.

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

What the container does not survive is being left alone. A room's container is removed after two
hours in which nobody was in the room and nothing was running (`IDLE_KERNEL_MS` in
`server/src/kernel/index.ts`, swept every ten minutes; a cell still computing or a command still
running in the terminal holds it open). Files stay, the notebook stays, the variables do not: the
first cell after a long gap answers `NameError`, and the next Run brings a fresh kernel up. Leaving
a model training over lunch is fine; preparing variables in the morning for a class after lunch is
not — re-run the cells, or keep the state in a file.

All of that is about restarting the *server*. Restarting the **kernel** is the opposite thing:
the container the variables live in goes away, Jupyter hands the server a new empty one, and
nothing on screen disagrees — the old `Out[n]` are still in the notebook and the news arrives as
the first `NameError`. So `make restart` restarts `app` alone, and a bare `docker compose restart`
(no service named) is the command not to run mid-seminar, because it takes the kernel with it.

And when the kernel itself dies — OOM-killed by `mem_limit`, culled, or restarted underneath — the
socket does not say so. Jupyter leaves it open. So the server asks: after ten seconds of silence
with a cell outstanding, it checks whether the kernel still exists, and a kernel that has gone is
announced, not waited on. A Run afterwards brings a fresh one up rather than failing once first.

### Isolation

Student code runs as a non-root user in a container of its own — one per seminar, started on
demand from that seminar's environment image, capped by `KERNEL_MEM`, `KERNEL_CPUS` and a pid
limit, in a separate process from the Node server. Only that room's folder is mounted into it, and
its Jupyter token is derived from `SESSION_SECRET` rather than shared, so a cell in one seminar can
neither read another seminar's files nor talk to its kernel. Inside the room nothing changes: a CSV
dropped in the Files panel is still `pd.read_csv('data.csv')` from a cell.

The server starts those containers by talking to Docker, which is why the app container is given
`/var/run/docker.sock`, the group that owns it (`DOCKER_GID`, which `make up` works out and writes
to `.env`), the host path of `./workspace` (`WORKSPACE_HOST_DIR` — the daemon resolves `-v` paths
its own way) and the name of the compose network the rooms join (`KERNEL_NETWORK`, how the server
addresses a room's Jupyter, which is therefore not published on the host at all). That socket is
root on the host for the server process — the same power it already has under `make run`, and the
price of a container per room.

A server running *on* the host — `make run`, or the systemd service on a dedicated machine — needs
none of those three: it talks to the daemon directly, `./workspace` is already the path the daemon
means, and a room's Jupyter is published on `127.0.0.1` with a port the kernel picks, which is an
address the server can actually reach. `WORKSPACE_HOST_DIR` must be *empty* in that arrangement,
because the server takes it as the sign that it is itself in a container and would then look for
the room by container name on a network it is not on.

Take the socket away and everything still works: the rooms fall back to the
one shared kernel, where any of them can read the others' files, and the server says so in its log,
in the room's kernel log and on the Environments screen rather than letting the promise stand. That
shared kernel — the `kernel` service in `docker-compose.yml`, which mounts the whole of `./workspace`
— sits on a Docker network of its own (`colloq-kernel`) that room containers are not on, so while
isolation *is* working a cell cannot reach it at all. It used to share the rooms' network, where the
only thing between a cell and every seminar's files was `JUPYTER_TOKEN`. The
one place where that safety net is not there is the dedicated machine: nobody starts the compose
kernel on it, so the fallback has nothing to fall back to and the log line is all there is.

This is sandboxing appropriate to a classroom of people you know, not to hostile untrusted input.
By default anyone with the link can execute Python inside that container — that is what an open room
is. A room created as a lecture, or one whose `run` rule is the teacher's, does not let them, and
the refusal is the server's rather than the client's; the container is the same either way.

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

The dev override publishes the kernel's 8888 on the loopback so the host server can reach it;
`./workspace` is bind-mounted in both arrangements, which is what makes `make up` and `make run`
the same instance.

`shared/` holds the Y.Doc schema and wire protocol used by both sides — it is the contract to change
first when adding a feature.

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
server's pid and is never guessed — `systemctl show -p MainPID colloq` under
the service, `cat .colloq.pid` under `make run`. The room's own door is set for a full lecture:
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
