# colloq — the teacher's command

This workspace is the `colloq` command a teacher gets from `pip install colloq`.
There is no other CLI: the repository runs on `make` (`make help`), and the
workshop — machines, releases, the relay, DNS, the load test — lives in the
Makefile and `scripts/`, not here.

```bash
pip install colloq
colloq                   # three lines about what lives here
colloq start             # a class: browser, logs in the terminal, Ctrl+C stops
colloq <command> --help
```

State lives **outside the package**, in `~/.colloq`: `.env`, the database,
`workspace/`, environments of your own. Reinstalling or upgrading the package
leaves all of it alone. `COLLOQ_HOME` moves it elsewhere.

## How it is built and run

`python/colloq/__main__.py` is a shim: it finds Node, installs the server's
`node_modules` once, and execs the bundled CLI. `make pack` bundles
`cli/src/bin.ts` into `python/colloq/_app/cli/colloq.mjs` and the supervisor
`cli/src/launch.ts` into `cli/launch.mjs`; `make wheel` builds the wheel into
`python/dist`. What goes inside and why is explained at the top of
`scripts/pack.mts`.

The supervisor is shared with development: `make dev` (and `npm run dev`) runs
`cli/src/launch.ts dev` through tsx — the reloading server, Vite and the room
kernels in one terminal. From source the CLI itself runs as
`node --import tsx cli/src/main.ts <command>`; it behaves exactly as the
installed one.

## Commands

| Command                         | What it does                                                        |
| ------------------------------- | ------------------------------------------------------------------- |
| `start` · `run`                 | Start a class in this terminal and open the browser                 |
| `stop`                          | End the class, its tunnel and the kernels of this database          |
| `restart`                       | Restart the running class                                           |
| `logs`                          | Watch the log of a class started in the background                  |
| `link`                          | Show the class address and where to find the sign-in to the panel   |
| `backup`                        | Take a backup of the database and the class files                   |
| `restore`                       | Restore a backup                                                    |
| `host` · `public`               | Publish the running class and get a link (`scripts/host.sh`)        |
| `env list` · `env` · `env ls`   | Which kernel environments exist                                     |
| `env show`                      | What is in an environment and which Python it runs on               |
| `env new`                       | Create an environment of your own                                   |
| `env use` · `env switch`        | Make an environment the default for new classes                     |
| `status`                        | What is on this machine right now: one screen, no network           |
| `doctor`                        | Check that everything is in place before a class                    |

`start` takes `--share`, `--host <name>`, `--detach`, `--port <port>`,
`--no-open` and `--fast`. Publishing happens only on an explicit `--share` or
`--host` (they do not work together) or through the separate `host` command. A
standalone `host` holds the tunnel and nothing else: ending it does not stop
the server. A local session's tunnel address is temporary — `.env` is not
rewritten and the server is not restarted.

Ctrl+C and `colloq stop` end the session's processes and the kernels belonging to
its database. Data, files and any other instance are left alone. A tunnel that
fails leaves the local session running.

## `start --share`: one link

`colloq start --share` (from source: `node --import tsx cli/src/main.ts start
--share`; `make dev SHARE=1` for the reloading dev server) starts the class and
a quick Cloudflare tunnel owned by the supervisor. `scripts/host.sh` opens the
tunnel as it always has, holds the temporary-address lease and checks the
address from outside; under `COLLOQ_SHARE=1` it reports the result as one marker
line instead of its own summary. The supervisor swallows that line and prints a
single block (`cli/src/launch-share.ts`): the `/s/<id>` link of the newest class
from the database — or, with no class yet, the panel on the public address and
where to create one — a warning never to share `/admin/` links, that Ctrl+C
closes the link, that a quick tunnel's address changes every run, and that
Cloudflare does not open from Russia (use `--host` with your own relay there).
The setup token is not printed.

cloudflared: `COLLOQ_CLOUDFLARED=/path` wins; then `cloudflared` on `PATH`; then
colloq's own copy in `<state>/bin` (`~/.colloq/bin`; the clone itself from
source), used only if its SHA-256 matches the pin; otherwise the pinned release
is downloaded from GitHub (`cli/src/launch-cloudflared-pin.ts` holds the
version, the per-asset hashes and how to bump them), checked, written 0600,
checked again from disk and only then made executable. The download is said
out loud, with the URL. `COLLOQ_CLOUDFLARED_DOWNLOAD=0` forbids it. Windows is
refused (use WSL 2). `host.sh` asks the same resolver (`launch.ts cloudflared`)
when there is no cloudflared on `PATH`, so `colloq host` and `make host` need no
manual install either.

**The isolation gate.** A class goes online only when every room's kernel runs
in a container of its own. The supervisor refuses `--share`/`--host` before
starting if `KERNEL_ISOLATION=off` or the backend is not docker/broker, and
again before the tunnel unless Docker answers and the server confirms it in
`/api/health` (`isolation: "docker"` or `"broker"`, set only when the kernel
check passed). `scripts/host.sh` applies the same check to every transport, so
`colloq host` and `make host` refuse an unconfirmed server too. A refusal
leaves the class running locally.

## Flags that are everywhere

| Flag          | What it does                                                                                                                                              |
| ------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `--dry-run`   | Prints exactly one line — what would have run — and runs nothing. Values from `.env` are not substituted into it: secrets live in `.env`, never in argv. |
| `--yes`, `-y` | Agree in advance; there will be no question. It never changes what a command means: restoring over a live database is allowed separately, `--replace`.  |
| `--json`      | Machine-readable output where there is something to hand over: `status`, `doctor`, `env list`. A refusal arrives as an object too.                       |

There is also `--no-color` (not one escape byte in the stream; `NO_COLOR` and
output that is not a terminal do the same), `--version` and `-h`. A hyphenated
name is the command itself: `colloq env-use cv` is `colloq env use cv`.

## Exit codes

| Code  | What it means                                                                                 |
| ----- | --------------------------------------------------------------------------------------------- |
| `0`   | Done.                                                                                         |
| `1`   | An error inside the CLI, or the child's own code.                                             |
| `2`   | Usage: no command, a missing required argument, conflicting flags, an argument too many.      |
| `3`   | A precondition is missing: no `.env`, no backup file, no terminal to ask in.                  |
| `4`   | The question was answered no.                                                                 |
| `130` | Ctrl+C. A child's signal is `128 + number` in general: 137 is the OOM killer, 143 is SIGTERM. |

## Asking before anything dangerous

A dangerous command asks exactly once. Where the script names the cost itself,
the CLI stays quiet and does not ask again: a second question in a row stops
being read. If rooms are running right now, their number is appended to the
question — it forbids nothing, it only makes the question precise. With no
terminal and no `--yes`, the question is not a yes: it is a refusal with code 3.

## What the CLI does not do

It does not read secrets: for `JUPYTER_TOKEN`, `RELAY_TOKEN`, `CF_TOKEN` and the
rest there is only "the line is there or it is not". It does not rewrite a
script's refusal — that stderr reaches you word for word. It does not bring an
instance up on your behalf, and it does not complete a short name into a zone.
It does not kill processes by pattern.

## State

`.colloq/local-session.json` is the supervisor's session receipt: the run id, the
pid, the port, the local address and the data paths. `stop`, `restart`, `link`
and `status` pick out the current session by it; the supervisor is what checks
which processes it owns. It lives in the state directory — the repository in a
clone, `~/.colloq` for an installed package — never next to the code.
