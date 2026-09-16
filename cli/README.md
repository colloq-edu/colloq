# colloq — a local class and the commands around it

The CLI has two lives, and it is the same code in both.

**For a teacher** it is a pip package. Install it, start it, teach:

```bash
pip install colloq
colloq                   # three lines about what lives here
colloq start             # a class: browser, logs in the terminal, Ctrl+C stops
colloq <command> --help
```

Fourteen commands are visible there — the ones a class is run with: `start`,
`stop`, `status`, `doctor`, `host`, `env`, `logs`, `link`, `backup`. The workshop
(`vast *`, `cluster *`, `relay *`, `dns *`, `site`, `load`, `dev`) is hidden: it
has nothing to do on a teacher's machine, and a long list buries what matters.
Hidden is not gone — those commands still answer to their exact names.

State lives **outside the package**, in `~/.colloq`: `.env`, the database,
`workspace/`, environments of your own. Reinstalling or upgrading the package
leaves all of it alone. `COLLOQ_HOME` moves it elsewhere.

**In the repository** there is nothing to install. From a clone, from any
directory:

```bash
./colloq                 # a local session, logs in the terminal, browser
./colloq menu            # the older menu, grouped
./colloq help            # every command, workshop included
./colloq dev             # server with reload, and Vite
```

The `./colloq` shim runs `node --import tsx cli/src/main.ts`; tsx is already a
dev dependency, so there is no build step. It works from another directory too:
the shim remembers where it was called from and resolves paths in arguments
against that, not against the repository root. Here the state directory is the
repository: `.env`, `data/` and `workspace/` sit in it, as they always did.

The pip wheel is built from here as well: `make pack` (the distribution into
`python/colloq/_app`), `make wheel` (the wheel into `python/dist`). What goes
inside it and why is explained at the top of `scripts/pack.mts`.

## How this relates to make

`colloq` and `colloq run` start the local supervisor — `cli/launch.mjs` in the
installed package, `cli/src/launch.ts` through tsx in the repository. It prepares
the build and the kernel image, starts the server, opens the browser and streams
the logs until Ctrl+C. Existing builds and images are reused when their inputs
have not changed. A busy server is never restarted on its own.

```bash
./colloq run --port 4000 --no-open
./colloq run --host hse.colloq.ru   # the server and a tunnel the session owns
./colloq run --detach               # background, asked for explicitly
./colloq stop --yes                 # end a background session
./colloq dev                        # server with reload and Vite until Ctrl+C
```

`run` takes `--host <name>`, `--detach`, `--port <port>`, `--no-open` and
`--fast`; `dev` takes `--port <port>` and `--no-open`. In `dev` the `--port` flag
sets the browser and Vite port, while `PORT` in `.env` sets the server's.
Publishing happens only on an explicit `--host` or through the separate `host`
command. A standalone `host` holds the tunnel and nothing else: ending it does
not stop the server. A local session's tunnel address is temporary — `.env` is
not rewritten and the server is not restarted.

Ctrl+C and `colloq stop` end the session's processes and the kernels belonging to
its database. Data, files and any other instance are left alone. Source reloads
in `dev` keep the kernels alive for the whole session. A tunnel that fails leaves
the local session running.

The remaining commands go through Makefile targets and `scripts/*.sh`, ask before
anything dangerous, take into account how the machine is set up (host, docker,
service, cluster) and pass the child's exit code straight out. In the installed
package there is no Makefile, so the commands a teacher needs call their scripts
directly — the `delegates` column below says which.

Three rules follow. Anything make can do, the wrapper can do: `colloq make
<target>` calls the target directly and parses nothing. A hyphenated command name
is the command itself: `colloq cluster-stop` is the same as `colloq cluster
stop`, with its own question, its own checks and its own flags (`colloq
vast-logs --since 2h`). And a target with no wrapper at all is never run
silently: the CLI says the target exists and asks for it by name — `colloq make
<target>`. The other way round holds too: with no wrapper at hand, `make` works
exactly as it did.

## Three flags that are everywhere

| Flag          | What it does                                                                                                                                                                                                                                                                          |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `--dry-run`   | Prints exactly one line — what would have run — and runs nothing. Values from `.env` are not substituted into it: secrets live in `.env`, never in argv.                                                                                                                              |
| `--yes`, `-y` | Agree in advance; there will be no question. Where the script asks rather than the CLI, `--yes` reaches it as `FORCE=1`. It never changes what a command means: `restore` does not take `REPLACE=1` from it — restoring over a live database is allowed separately, with `--replace`. |
| `--json`      | Machine-readable output, declared where there is something to hand over: `status`, `doctor`, `env list`. In this mode the ordinary output is silenced entirely, and a refusal arrives as an object too.                                                                               |

The shared flags apply only BEFORE `--`: everything after it is untouched and
passed straight through, so `colloq make check -- -n --dry-run` means make's
switches, not ours.

There is also `--no-color` (not one escape byte in the stream; `NO_COLOR` and
output that is not a terminal do the same), `--version` and `-h`.

## make variables are written as pairs

A `NAME=VALUE` pair is picked up anywhere in the line and passed to `make` as it
is, so both forms mean the same thing:

```bash
./colloq backup --mode consistent
./colloq backup MODE=consistent
./colloq vast up hse --gpu "RTX 5070"
./colloq vast up NAME=hse GPU="RTX 5070"
```

`run` understands the pairs `HOST=…`, `DETACH=1`, `PORT=…`, `OPEN=0` and
`FAST=1`; they become supervisor flags. Other pairs reach it through the
environment. Values from `.env` are never substituted into the `--dry-run` line.

A pair written by hand is not sent a second time: `NAME=hse NAME=hse` never
appears in a line. The fine-grained knobs that have no flag are set only by a
pair — `colloq load 500 K=20 STORM=20`.

## Exit codes

| Code  | What it means                                                                                 |
| ----- | --------------------------------------------------------------------------------------------- |
| `0`   | Done.                                                                                         |
| `1`   | An error inside the CLI, or the child's own code.                                             |
| `2`   | Usage: no command, a missing required argument, conflicting flags, an argument too many.      |
| `3`   | A precondition is missing: no `.env`, no release file, no terminal to ask in.                 |
| `4`   | The question was answered no.                                                                 |
| `130` | Ctrl+C. A child's signal is `128 + number` in general: 137 is the OOM killer, 143 is SIGTERM. |

A child process's code is passed straight out: `colloq check` in CI ends the same
way `make check` does.

## Asking before anything dangerous

A dangerous command asks exactly once. Where the script names the cost itself
(`vast up` shows the bid, `vast down` asks you to type the word for destroy), the
CLI stays quiet and does not ask again: a second question in a row stops being
read. If rooms are running right now, their number is appended to the question —
it forbids nothing, it only makes the question precise. With no terminal and no
`--yes`, the question is not a yes: it is a refusal with code 3.

## Commands

### Locally

| Command               | What it does                                                              | Delegates to                                                                                                                                                                            |
| --------------------- | ------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `run` <br>`start`     | Start a local session in this terminal and open the browser               | `native: the class supervisor — cli/launch.mjs in the distribution, cli/src/launch.ts through tsx in the repository`                                                                    |
| `stop`                | End the local session, its tunnel and the kernels of this database        | `native: the same supervisor with the stop command; without a session receipt — make stop (in the repository)`                                                                          |
| `restart`             | Restart whatever is running on this machine                               | `session → supervisor restart; container → make restart · service → make service-restart · host → make stop, make run; without a receipt in the installed package — a refusal in words` |
| `up`                  | Bring the whole stack up in docker: the application and the kernel        | `make up`                                                                                                                                                                               |
| `down`                | Stop everything in docker (data and files stay)                           | `make down`                                                                                                                                                                             |
| `ps` <br>`containers` | What is running in docker: compose, room kernels, the environment         | `make status (also known as make ps)`                                                                                                                                                   |
| `logs` <br>`log`      | Watch the log of whatever is running on this machine                      | `tail <log> · make logs · make service-logs`                                                                                                                                            |
| `dev`                 | Start the reloading server and Vite in one session                        | `native: the same supervisor with the dev command (in the repository only)`                                                                                                             |
| `build`               | Build the frontend and the server                                         | `npm run build:optimized (with --fast — npm run build)`                                                                                                                                 |
| `ui`                  | Check the interface in a real browser                                     | `make ui [HEADED=1]`                                                                                                                                                                    |
| `test`                | Run the tests                                                             | `make test · node --import tsx --test tests/*<pattern>*.test.mts`                                                                                                                       |
| `check`               | Run the tests and the type check                                          | `make check`                                                                                                                                                                            |
| `shell`               | Open a shell in the kernel to see what is installed there                 | `make shell`                                                                                                                                                                            |
| `link`                | Show the class address and where to find the sign-in to the panel         | `native: reads the session receipt, the temporary address and .env`                                                                                                                     |
| `docker-gid`          | Write the docker socket group into .env so every room gets its own kernel | `make docker-gid`                                                                                                                                                                       |
| `backup`              | Take a backup: a portable k3s one or a local one in the old format        | `make backup MODE=… · make backup-legacy (in an installed colloq — scripts/backup.sh and scripts/backup-local.sh directly)`                                                             |
| `restore`             | Restore a backup: a portable k3s one or a local one in the old format     | `make restore ARCHIVE=… RELEASE=… · make restore-legacy DB=… FILES=… (in an installed colloq — scripts/restore.sh directly)`                                                            |

### A class on the network

| Command              | What it does                                                            | Delegates to                                                                                                                              |
| -------------------- | ----------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `host` <br>`public`  | Publish the running class and get a link                                | `make host HOST=… (with --direct: make host-direct HOST=…); in the package there is no make to call: COLLOQ_HOSTNAME=… ./scripts/host.sh` |
| `host-direct`        | The same, but caddy on this machine: no relay and no middlemen          | `make host-direct HOST=… (in the package: COLLOQ_DIRECT=1 COLLOQ_HOSTNAME=… ./scripts/host.sh)`                                           |
| `tunnel setup`       | Set up a permanent address through Cloudflare, once                     | `make tunnel-setup HOST=…`                                                                                                                |
| `relay setup`        | Install the \*.colloq.ru relay on a VPS                                 | `make relay-setup WHERE=…`                                                                                                                |
| `relay page`         | Update the "room is not open yet" page                                  | `make relay-page WHERE=… (scripts/relay-setup.sh --page)`                                                                                 |
| `relay ping`         | Whether the relay answers                                               | `native: TCP to RELAY_ADDR:RELAY_PORT from .env, 2s timeout`                                                                              |
| `dns sync` <br>`dns` | Put the colloq.ru zone in order                                         | `./scripts/dns.sh (with --domain: DOMAIN=<zone> ./scripts/dns.sh)`                                                                        |
| `dns point`          | Point one name at one address                                           | `./scripts/dns.sh point <name> <ip>`                                                                                                      |
| `sync`               | Check that the projector follows the console when pages are turned fast | `make sync (with --headed: make sync HEADED=1)`                                                                                           |

### Machines and releases

| Command                     | What it does                                                           | Delegates to                                                               |
| --------------------------- | ---------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| `vast up`                   | Rent a GPU machine and deploy Colloq on it                             | `make vast-up NAME=… HOST=… GPU=… [RELEASE=…] [REPLACE=1] [FORCE=1]`       |
| `vast status` <br>`vast ls` | What is rented: every environment, or one in detail                    | `make vast-status NAME=… [RELEASE=…]`                                      |
| `vast sync`                 | Take a backup from the rented machine into backups/<environment>/      | `make vast-sync NAME=… [MODE=…] [RESUME=1] [RELEASE=…]`                    |
| `vast logs`                 | Fetch the logs from the rented machine into logs/<environment>/<date>/ | `make vast-logs NAME=… [SINCE=…] [RELEASE=…]`                              |
| `vast down`                 | Destroy the rented machine along with everything on it                 | `make vast-down NAME=… [RELEASE=…] [FORCE=1]`                              |
| `vast adopt`                | Name a machine with the old “colloq” label as an environment           | `make vast-adopt NAME=… (always scripts/vast.sh, even without RELEASE)`    |
| `install`                   | Install a k3s version on this Linux machine                            | `make install RELEASE=… (scripts/cluster.sh install)`                      |
| `update`                    | Update to an explicit version                                          | `make update RELEASE=… (scripts/cluster.sh update)`                        |
| `rollback`                  | Bring back a compatible version                                        | `make rollback RELEASE=… (scripts/cluster.sh rollback)`                    |
| `cluster start`             | Start the installed k3s application                                    | `make cluster-start (scripts/cluster.sh start)`                            |
| `cluster stop`              | Stop the k3s application (every writer)                                | `make cluster-stop (scripts/cluster.sh stop)`                              |
| `cluster status`            | What is in the cluster: deployments, pods, volumes, health             | `make cluster-status (scripts/cluster.sh status)`                          |
| `cluster logs`              | Watch the application log in the cluster                               | `make cluster-logs (scripts/cluster.sh logs)`                              |
| `service install`           | Install k3s from a release — the old target name                       | `make service-install RELEASE=… (scripts/service.sh → cluster.sh install)` |
| `service restart`           | Restart the application and wait until it is ready                     | `make service-restart (service.sh: cluster.sh stop, then start)`           |
| `service stop`              | Stop the application (room kernels stay alive)                         | `make service-stop (cluster.sh stop)`                                      |
| `service status`            | Whether the service is alive and ready to run a class                  | `make service-status (cluster.sh status)`                                  |
| `service logs`              | Watch the service log                                                  | `make service-logs (cluster.sh logs)`                                      |
| `release validate`          | Check the release manifest                                             | `make release-validate RELEASE=… (python3 scripts/release.py validate)`    |

### Kernel environments

| Command                         | What it does                                              | Delegates to                                                                      |
| ------------------------------- | --------------------------------------------------------- | --------------------------------------------------------------------------------- |
| `env list` <br>`env` · `env ls` | Which environments exist                                  | `native: reads both environment directories and KERNEL_ENV from .env`             |
| `env show`                      | What is in an environment and which Python it runs on     | `native: reads <environment>.txt and kernel/requirements.txt`                     |
| `env new`                       | Create an environment                                     | `native: creates <name>.txt with a header in your own environment directory`      |
| `env build`                     | Build the image of an environment without switching to it | `make env-build NAME=… (in the repository only)`                                  |
| `env use` <br>`env switch`      | Make an environment the default for new classes           | `native: KERNEL_ENV in .env (in the repository, make env-build first)`            |
| `env freeze`                    | Show the real package versions from the kernel            | `make env-freeze (with colloq installed: docker run colloq-kernel:<environment>)` |

### Tools

| Command           | What it does                                                       | Delegates to                                                                                                   |
| ----------------- | ------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------- |
| `status` <br>`st` | Show what is on this machine right now: one screen, no network     | `native: .colloq/local-session.json, .env, .colloq.pid, ps, docker ps, web/dist, backups/, .colloq/state.json` |
| `doctor`          | Check that everything is in place before a class                   | `native: programs, files, images, disk space; one TCP check of the relay`                                      |
| `activity`        | Count the activity of a class and write it into a Google sheet     | `make activity ROOM=… [ALL=1] [REPLACE=1]`                                                                     |
| `site`            | Publish the colloq.ru site: the landing page and published classes | `make site [SITE=…] [BASE=…] [DRY=1]`                                                                          |
| `course`          | Create a course from a schedule in a sheet                         | `make course SHEET=… GID=… COL=… [NAME=…] [BLURB=…] [DRY=1]`                                                   |
| `load`            | Drive N students into a room of your own: the load test            | `make load N=… RAMP=… [SPID=… IDLE=… TREE=… COUNCIL=… INK=… STAFF=1]`                                          |
| `make`            | Call a Makefile target directly, parsing nothing                   | `make <target> [VAR=value …]`                                                                                  |

## What the CLI does not do

It does not read secrets: for `JUPYTER_TOKEN`, `RELAY_TOKEN`, `CF_TOKEN` and the
rest there is only "the line is there or it is not". It does not rewrite a
script's refusal — that stderr reaches you word for word. It does not bring an
instance up on your behalf, and it does not complete a short name into a zone.
It does not kill processes by pattern.

## State

`.colloq/local-session.json` is the supervisor's session receipt: the run id, the
pid, the port, the local address and the data paths. `stop` and `restart` pick
out a current session by it; the supervisor is what checks which processes it
owns. It lives in the state directory — the repository in a clone, `~/.colloq`
for an installed package — never next to the code.

`.colloq/state.json` holds the last environment's name, its GPU, the deployment
path and the last command with its exit code. It is machine state, not source; it
is in `.gitignore`, and `colloq status` reads it to say something about a rented
machine without going to the network.
