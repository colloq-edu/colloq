# Colloq: everyday commands.
#
# The two things this exists for:
#
#   make run               build and start
#   make host              bring up a seminar and get a link for the audience
#   make env-use NAME=cv   the Python environment for new seminars
#
# Development: make dev, the server with reload and Vite in one terminal.
#
# Everything is computed on this machine. `make host` exposes it to the
# outside with a tunnel, an outgoing connection, so neither a public IP nor
# port forwarding on the router is needed. The tunnel goes either to
# Cloudflare or to your own relay under *.colloq.ru (make relay-setup):
# Cloudflare addresses do not open from Russia.
#
# A machine with its own public address has a shorter path: `make host-direct`
# installs caddy right here, and there is no intermediary on the students' path
# at all. That is how a real audience should be served: a relay with a gigabyte
# of memory does not hold two hundred sockets (measured). What to pick when:
# the README, the section on transports.

SHELL := /bin/bash
.DEFAULT_GOAL := help

# The directory with the package lists. One environment, one file.
ENV_DIR := kernel/environments
# The default Python version comes from the Dockerfile itself, not from a
# second list: it has `ARG PARENT=python:<version>-slim-bookworm`, and that is
# the version in effect when an environment says nothing about its version. A
# copy of the number of our own would silently drift from it, and
# `make env-show` would talk about 3.11 over an image with 3.12.
PY_DEFAULT := $(shell sed -nE 's/^ARG PARENT=python:([0-9]+\.[0-9]+)-.*/\1/p' kernel/Dockerfile | head -1)
# Which versions are offered at all: from the same place the panel takes them.
PY_LIST := $(shell sed -nE "s/^export const PYTHON_VERSIONS = \[(.*)\].*/\1/p" shared/admin.ts | tr -d "' " | tr ',' ' ')
# Parsing of the two header directives: comments to pip, the mechanism to us.
PY_FROM = sed -nE 's/^[[:space:]]*\#[[:space:]]*colloq:[[:space:]]*from[[:space:]]+([^[:space:]]+)[[:space:]]*$$/\1/p'
PY_PICK = sed -nE 's/^[[:space:]]*\#[[:space:]]*colloq:[[:space:]]*python[[:space:]]+(3\.[0-9]+)[[:space:]]*$$/\1/p'
# Which Python the environment will run on: the version is set by the ROOT of
# the `# colloq: from` chain, because it comes from the base image, and a
# layer on top of a ready image does not change the interpreter. Eight steps:
# the same ceiling the build has.
PY_OF = py_of() { n="$$1"; i=0; while [ $$i -lt 8 ]; do u=$$($(PY_FROM) $(ENV_DIR)/$$n.txt 2>/dev/null | head -1); if [ -z "$$u" ] || [ ! -f $(ENV_DIR)/$$u.txt ]; then break; fi; n="$$u"; i=$$((i+1)); done; v=$$($(PY_PICK) $(ENV_DIR)/$$n.txt 2>/dev/null | head -1); printf '%s' "$${v:-$(PY_DEFAULT)}"; }
# Which environment is currently baked into the kernel image. Written to
# .env, read by compose.
CURRENT_ENV = $(shell grep -E '^KERNEL_ENV=' .env 2>/dev/null | tail -1 | cut -d= -f2- | tr -d ' ')
CURRENT_ENV := $(if $(CURRENT_ENV),$(CURRENT_ENV),base)
# The port is read from .env, not from the shell. That is where it is set, as
# both the README and .env.example say, while `$$PORT` in a recipe is the
# person's environment variable, usually empty. With PORT=4000 in .env the
# server listened on 4000, `make run` waited for readiness on 3000 and declared
# a healthy instance not started.
PORT = $(shell grep -E '^PORT=' .env 2>/dev/null | tail -1 | cut -d= -f2- | tr -d ' ')
PORT := $(if $(PORT),$(PORT),3000)

BOLD := \033[1m
DIM  := \033[2m
CYAN := \033[36m
RED  := \033[31m
OFF  := \033[0m

# All targets are .PHONY, and that is not a formality: next to this file lies
# the `site/` directory, because of which `make site` printed "site is up to
# date" and did nothing (no pages, no commit, no push) while reporting success.
.PHONY: help up dev run dirs docker-gid stop logs-run down restart logs status ps shell activity \
        service-install service-restart service-stop service-status service-logs \
        host host-direct relay-setup relay-page tunnel-setup site mirror readme-art site-icons site-og ui sync load course \
        vast-up vast-status vast-sync vast-logs vast-down vast-adopt \
        env-list env-show env-new env-use env-build env-freeze \
        backup restore test check pack wheel wheels version bump

## ----------------------------------------------------------------- running

up: .env dirs docker-gid ## Local development in Docker: a separate kernel for each room
	docker compose build kernel
	docker compose up -d --build app
	@printf '$(BOLD)colloq at$(OFF) $(CYAN)http://localhost:$(PORT)$(OFF)\n'
	@printf '$(DIM)kernel environment: $(CURRENT_ENV) · expose it: make host$(OFF)\n'

dirs:
	@# We create the directories for the database and the seminar files
	@# ourselves, before docker.
	@#
	@# For a bind mount with a nonexistent source, Docker on Linux creates it as
	@# root, while app runs as node: the very first write of data/session-secret
	@# failed with EACCES, `restart: unless-stopped` spun the container in a
	@# loop, and setup-token was never printed, that is, `make up` on a fresh
	@# clone did not come up at all. On macOS this is invisible, so the line
	@# looks redundant right up until Ubuntu.
	@mkdir -p data workspace
	@# And hand them to the user the server in the container runs as.
	@#
	@# Creating the directory is not enough: under root (and on a rented
	@# machine and on a server, deployment is done exactly as root) it also
	@# sets root as the owner, while inside the container the server is
	@# `node`, uid 1000. The database does not open at all, the container goes
	@# into a restart loop with SQLITE_CANTOPEN, and in the log this reads as a
	@# broken build, not as folder permissions. Only under root and only on
	@# Linux: on macOS the directories are yours anyway, and chown there would
	@# break `make run`, where the server runs as the person.
	@if [ "$$(id -u)" = 0 ] && [ "$$(uname -s)" = Linux ]; then chown -R 1000:1000 data workspace; fi

docker-gid:
	@# The group of the docker socket: without it a room has no kernel of its
	@# own.
	@#
	@# The server in the container runs as `node`, and the socket belongs to
	@# root:docker. We need the gid the socket has as the DAEMON sees it, not
	@# the host: under colima and Docker Desktop the file may not exist on the
	@# host at all, so when it is not visible we ask the daemon itself with one
	@# tiny container. We write to .env, not to the make environment: `docker
	@# compose` is also called by host.sh and by hand, and all of them read
	@# .env. If it could not be determined, no harm done: the server will not
	@# reach docker, will say so in the log, and the rooms will share one
	@# kernel, as before.
	@grep -qE '^DOCKER_GID=' .env 2>/dev/null || { \
	  gid=$$(stat -c %g /var/run/docker.sock 2>/dev/null \
	    || stat -f %g /var/run/docker.sock 2>/dev/null \
	    || docker run --rm -v /var/run/docker.sock:/var/run/docker.sock busybox stat -c %g /var/run/docker.sock 2>/dev/null); \
	  if [ -n "$$gid" ]; then \
	    printf '\n# Group of the docker socket: with it the server gives each seminar its own kernel.\nDOCKER_GID=%s\n' "$$gid" >> .env; \
	    printf '$(DIM)docker socket group: %s — written to .env, every seminar will get its own kernel$(OFF)\n' "$$gid"; \
	  fi; \
	}

DEV := -f docker-compose.yml -f docker-compose.dev.yml

dev: ## Development: the server with reload and Vite, each room with its own kernel. OPEN=0 — no browser, SHARE=1 — a link through a quick tunnel
	@# The same supervisor that brings up a class for `colloq start`
	@# (cli/src/launch.ts): it creates .env itself, builds the kernel image,
	@# starts the server under tsx watch and Vite, opens the browser, and on
	@# Ctrl+C shuts everything down together with this database's kernels. A
	@# server reload does not touch the rooms' kernels. The target used to only
	@# build the compose kernel, and the server was brought up with a second
	@# command, which people forgot about.
	@# SHARE=1 is the same as `colloq start --share` (cli/src/launch-share.ts).
	@node --import tsx cli/src/launch.ts dev $(if $(filter 0,$(OPEN)),--no-open) $(if $(filter 1,$(SHARE)),--share)

## How this actually runs.
##
## The kernel lives in docker, and the server on the host: that way a debugger
## can see it, and a rebuild takes seconds instead of an image rebuild. So the
## kernel must have the dev override: it publishes 8888 to the outside and
## mounts ./workspace. Without it the kernel in the container answers only
## itself, the server on the host cannot find it, and the seminar files split
## across two different folders. The container still looks healthy meanwhile,
## so the set of files is given here explicitly.
PID := .colloq.pid
LOG := .colloq.log

run: .env dirs ## Build and start. FAST=1 — do not precompress the frontend (only for editing code)
	@$(MAKE) --no-print-directory stop
	@# The containerized app and the host server are two Colloqs on one port.
	@# The second one used to simply fail with EADDRINUSE, and after `make down`
	@# it took the same place, empty: the same localhost:3000, a different
	@# database, a different setup-token, links from the schedule answer 404.
	@# Now this is said out loud, with the one command that fixes it.
	@if docker compose ps --status running --services 2>/dev/null | grep -qx app; then \
	  printf '$(RED)app is already running in docker — that is a second Colloq on the same port$(OFF)\n'; \
	  printf '$(DIM)stop it: make down · or use it as it is: make logs$(OFF)\n'; \
	  exit 1; \
	fi
	@# And, in general, anyone who holds the port. `make stop` above knows only
	@# about the process whose PID is written in the file, while a second
	@# server could have been brought up by anyone, even the tunnel script. Two
	@# Yjs authorities for one room give a half-empty notebook with duplicated
	@# cells and endless reconnecting, and there is no way to tell that from
	@# the screen. The check costs one command.
	@#
	@# Both calls ask exactly about a LISTENER. `lsof -ti :3000` returns a pid
	@# for any socket with this port, including a browser tab of somebody else
	@# whose connection hangs in CLOSE_WAIT after a server that was just killed.
	@# Because of that, `make run` right after `make stop` refused with the
	@# words "port is taken:" and an empty list under them: the list filtered
	@# by LISTEN, but the condition did not.
	@if lsof -nP -iTCP:$(PORT) -sTCP:LISTEN -t >/dev/null 2>&1; then \
	  printf '$(RED)port $(PORT) is already taken:$(OFF)\n'; \
	  lsof -nP -iTCP:$(PORT) -sTCP:LISTEN | tail -n +2 | awk '{printf "  %s (pid %s)\n", $$1, $$2}'; \
	  printf '$(DIM)that is a second Colloq — stop it and try again: make stop · make down$(OFF)\n'; \
	  exit 1; \
	fi
	docker compose $(DEV) build kernel
	@printf '$(DIM)image $(CURRENT_ENV) is ready; every room gets a separate kernel$(OFF)\n'
	@# Precompressed by default, and this is a fix.
	@#
	@# Only `make run OPTIMIZE=1` used to compress, and without it there was not
	@# a single .br next to assets/, so the server compressed EVERY file on
	@# every request, with streaming brotli at quality 5 (server/src/app.ts).
	@# Measured on codemirror from this build: 219 751 bytes versus 194 920 at
	@# quality 11, and 11.6 ms of CPU time for every response. Two hundred
	@# students at the bell means two hundred such compressions of the same
	@# file on a machine that is starting kernels at that very moment.
	@#
	@# A flag one has to remember is not enough for this: nobody remembered it.
	@# Now compression is the default, and it is turned off where it really gets
	@# in the way, in the code editing loop, where the build runs ten times an
	@# hour: FAST=1.
	npm run $(if $(filter 1,$(FAST)),build,build:optimized)
	@# nohup and a subshell: make leaves right away, and the server has to
	@# outlive both it and the closing of the terminal. Everything it says,
	@# including a crash at startup, goes to $(LOG); otherwise it is lost along
	@# with the shell.
	@# Appended, not overwritten: `>` wiped out last week on every start, and
	@# "something broke on Thursday" had nothing to be checked against.
	@#
	@# .env is NOT sourced here, and this is a fix. `set -a; . ./.env` is not
	@# reading the file but executing it with the shell: the line
	@# `INSTITUTION=Higher School of Economics`, exactly the one .env.example
	@# and the README ask for, is to bash the command `School` with a prefix
	@# assignment: "command not found", and the variable is not set at all.
	@# The server reads .env itself (dotenv, server/src/config.ts), from this
	@# same directory and with spaces inside values, so starting node is
	@# enough.
	@#
	@# There is exactly one difference, and it is the usual one for dotenv: a
	@# variable already set in the shell now beats the line in .env, not the
	@# other way round. Under the service and in the container it has always
	@# been so; PUBLIC_URL is the exception both there and here: the server
	@# takes it from the file on purpose (readPublicUrl).
	@( NODE_ENV=development KERNEL_BACKEND=docker STATIC_DIR="$$PWD/web/dist" nohup node server/dist/server.js >> $(LOG) 2>&1 & \
	   echo $$! > $(PID) )
	@# We wait for the server to say it is ready, not two seconds at random:
	@# two seconds is either too long or too short, and "too short" prints the
	@# link over an instance that is still coming up. /api/health answers 200
	@# only when the database reads and Jupyter responds.
	@#
	@# The link is PUBLIC_URL, and without it the same thing the server takes
	@# (config.ts · readPublicUrl): localhost:PORT. The line may be missing
	@# from .env altogether: it is not in the file that the .env target and
	@# colloq write, and a ready server was announced with an empty "colloq
	@# at".
	@ok=; for i in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15; do \
	  if ! kill -0 "$$(cat $(PID) 2>/dev/null)" 2>/dev/null; then break; fi; \
	  if curl -fsS -m 2 "http://localhost:$(PORT)/api/health" >/dev/null 2>&1; then ok=1; break; fi; \
	  sleep 1; \
	done; \
	if [ -n "$$ok" ]; then \
	  url="$$(grep -E '^PUBLIC_URL=' .env | tail -1 | cut -d= -f2-)"; \
	  printf '\n$(BOLD)colloq at$(OFF) $(CYAN)%s$(OFF)\n' "$${url:-http://localhost:$(PORT)}"; \
	  printf '$(DIM)logs: make logs-run · stop: make stop · expose it: make host$(OFF)\n'; \
	elif kill -0 "$$(cat $(PID) 2>/dev/null)" 2>/dev/null; then \
	  printf '$(RED)the server is running but does not report ready — did the kernel fail to start?$(OFF)\n'; \
	  printf '$(DIM)check: docker compose ps · logs: make logs-run$(OFF)\n'; \
	  tail -20 $(LOG); exit 1; \
	else \
	  printf '$(RED)the server did not come up. The last lines of $(LOG):$(OFF)\n'; \
	  tail -20 $(LOG); exit 1; \
	fi

stop: ## Stop the server on the host (the kernel in docker stays)
	@if [ -f $(PID) ] && kill -0 "$$(cat $(PID))" 2>/dev/null; then \
	  kill "$$(cat $(PID))" && printf '$(DIM)server stopped$(OFF)\n'; \
	fi
	@rm -f $(PID)
	@# We do not know about other receipts: the server may have been started by
	@# something other than make run, and then its PID is not written anywhere.
	@# Saying so out loud is the only way not to leave a person with two
	@# Colloqs, the second of which they do not suspect.
	@others="$$(pgrep -f 'node server/dist/server.js' 2>/dev/null || true)"; \
	if [ -n "$$others" ]; then \
	  printf '$(RED)server processes are still running on the host:$(OFF) %s\n' "$$(echo $$others | tr '\n' ' ')"; \
	  printf '$(DIM)they were not started by make run — to stop them: pkill -f "node server/dist/server.js"$(OFF)\n'; \
	fi

logs-run: ## Follow the logs of the server started by make run
	@tail -f $(LOG)

backup-legacy: ## Backup of the local development instance (the database and the changing files)
	@# The recipe used to live right here as thirty lines, and now it lies in
	@# scripts/backup-local.sh, exactly as with restore-legacy below and for
	@# the same reason: scripts/ goes into the pip wheel, the Makefile does
	@# not, and for installed colloq this backup was out of reach altogether
	@# ("make: command not found"). There must not be a second description of
	@# the same thing, so one line is left here.
	@#
	@# The script takes the directory to back up from COLLOQ_HOME
	@# (scripts/lib.sh · COLLOQ_STATE_ROOT). Nobody names it here, and rightly
	@# so: in the repository the state root is the repository root.
	@./scripts/backup-local.sh

restore: ## Restore k3s: ARCHIVE=backup.tar.gz RELEASE=release.json REPLACE=1
	@test -n "$(ARCHIVE)" || { printf 'ARCHIVE is required; legacy copies use make restore-legacy\n' >&2; exit 1; }
	@test -n "$(RELEASE)" || { printf 'RELEASE is required for portable recovery\n' >&2; exit 1; }
	@args=(--archive "$(ARCHIVE)" --release "$(RELEASE)"); \
	  if [ "$(REPLACE)" = 1 ]; then args+=(--replace); fi; \
	  if [ "$(RECOVER)" = 1 ]; then args+=(--recover); fi; \
	  NAME="$(NAME)" ./scripts/restore.sh "$${args[@]}"

restore-legacy: ## Restore a local backup in the old format: DB=… FILES=…
	@# The counterpart of backup. A separate script, not three lines here: the
	@# database must not be swapped under a running server, and next to it lies
	@# the WAL journal, which has to go together with the old database; both
	@# checks are explained there.
	@#
	@# NAME picks the directory: backups/<environment>/ instead of backups/.
	@# Without it, the root, that is, the backups of the local instance; another
	@# environment cannot be pulled from there even by accident, and that is the
	@# only thing we are after here.
	@NAME="$(NAME)" ./scripts/restore.sh $(DB) $(FILES)

down: ## Stop everything (data and seminar files stay)
	@# The seminar containers first: every room has TWO, its own and the one
	@# where its students' personal notebooks run, and compose does not know
	@# about them: the server starts them during the class. Without this line
	@# "stop everything" would leave a pair of containers running for every
	@# room opened today. And in exactly this order: under `make up` they sit in
	@# the compose network, and a network with foreign containers inside is not
	@# removed: `docker compose down` would say "Resource is still in use" and
	@# leave it hanging.
	@ids="$$(docker ps -aq --filter 'label=colloq.kind=room-kernel' 2>/dev/null)"; \
	if [ -n "$$ids" ]; then \
	  docker rm -f $$ids >/dev/null && \
	  printf '$(DIM)seminar containers removed: %s$(OFF)\n' "$$(echo $$ids | wc -w | tr -d ' ')"; \
	fi
	docker compose down
	@# "Everything" is everything in docker. A server run as a service sits on
	@# the host, and `docker compose down` does not touch it: it will keep
	@# working over an empty spot, starting kernels for the rooms anew. Saying
	@# so is cheaper than stopping the service behind the back of whoever asked
	@# to remove the containers.
	@if systemctl is-active --quiet colloq 2>/dev/null; then \
	  printf '$(DIM)the server is still running as a service — to stop it: make service-stop$(OFF)\n'; \
	fi

restart: ## Restart the server in docker without rebuilding (the kernel is left alone)
	@# Only app, and that matters more than it seems.
	@#
	@# A bare `docker compose restart` also restarted the kernel service, and
	@# that is the kernel the rooms sit on when they did not get a container of
	@# their own: Jupyter came up empty, the sockets reconnected as if nothing
	@# had happened, the notebook still showed the old Out[n], and the class
	@# learned that model and df were gone from the first NameError some ten
	@# minutes later. The README promises that the server survives a restart:
	@# a promise about the server, not about the kernel.
	@if docker compose ps --status running --services 2>/dev/null | grep -qx app; then \
	  docker compose restart app; \
	elif [ -f /etc/systemd/system/colloq.service ]; then \
	  printf '$(DIM)app is not running in docker, but the service is installed — restart that instead:$(OFF)\n'; \
	  printf '$(DIM)make service-restart$(OFF)\n'; \
	else \
	  printf '$(DIM)app is not running in docker — nothing to restart.$(OFF)\n'; \
	  printf '$(DIM)a server on the host (make run) is restarted like this: make stop · make run$(OFF)\n'; \
	fi

logs: ## Follow the logs (Ctrl+C to quit)
	docker compose logs -f --tail=80

status: ## What is running and in what state
	@docker compose ps
	@# On a dedicated machine the server runs as a service, and it is not in
	@# the compose output at all: there are only kernels there. Without this
	@# line `make status` would show an empty list over a working instance.
	@if [ -f /etc/systemd/system/colloq.service ]; then \
	  printf '\n$(DIM)server: systemd service — $(OFF)%s\n' "$$(systemctl is-active colloq 2>/dev/null || echo unknown)"; \
	  printf '$(DIM)details: make service-status$(OFF)\n'; \
	fi
	@# The seminar containers live apart from compose: a pair per room (its own
	@# and "own", for the students' personal notebooks); they start during the
	@# class and are removed when the room has been empty for two hours.
	@rooms="$$(docker ps --filter 'label=colloq.kind=room-kernel' --format '{{.Label "colloq.session"}} {{.Label "colloq.role"}} {{.Status}}' 2>/dev/null)"; \
	if [ -n "$$rooms" ]; then \
	  printf '\n$(DIM)seminar kernels:$(OFF)\n'; echo "$$rooms" | sed 's/^/  /'; \
	fi
	@printf '\n$(DIM)kernel environment:$(OFF) $(BOLD)$(CURRENT_ENV)$(OFF)\n'
	@# No line: the server takes localhost:PORT (as make run above does), and
	@# that is what we print.
	@url="$$(grep -E '^PUBLIC_URL=' .env 2>/dev/null | tail -1 | cut -d= -f2-)"; \
	printf '$(DIM)PUBLIC_URL:$(OFF) %s\n' "$${url:-http://localhost:$(PORT)}"

ps: status

shell: ## A shell inside the kernel, to see what is actually installed there
	@# The shared compose kernel does not always exist. On a dedicated machine
	@# (the server as a service) nobody starts it: every room has its own, and
	@# the environment image lies nearby, built. Then we open a throwaway
	@# container from the same image: that answers "what is installed in the
	@# environment", not "what was added by hand in a running room"; the latter
	@# is checked in the room itself, with the terminal.
	@if docker compose ps --status running --services 2>/dev/null | grep -qx kernel; then \
	  docker compose exec kernel bash; \
	else \
	  printf '$(DIM)no shared kernel — opening a throwaway container colloq-kernel:$(CURRENT_ENV)$(OFF)\n'; \
	  docker run --rm -it colloq-kernel:$(CURRENT_ENV) bash; \
	fi

## ------------------------------------------------------- dedicated machine

## A third way to run, and it does not replace the two above.
##
##   make up   the whole stack in docker: a laptop, to show, to try
##   make run  the server by hand, the kernel in docker: development
##   service   the server on the host under systemd, only the room kernels in
##             docker: the machine where classes happen (own or rented)
##
## On a dedicated machine the server is moved out of the container not for
## speed. In a container it does not see what is around it: the data
## directories were created as root while it runs as uid 1000 inside, and the
## panel could not build an environment, because next to it there is neither
## docker-compose.yml, nor kernel/Dockerfile, nor .env. On the host all of
## that lies nearby. The price is named out loud: the service runs as root (it
## needs docker.sock anyway, and that is root-equivalent), and Node appears on
## the machine. Details: the header of deploy/colloq.service and the README.

service-install: ## Compatibility: k3s install, RELEASE=/path/release.json
	@# It also updates: git pull && make service-install; the build and the
	@# restart happen inside.
	@./scripts/service.sh install --release "$(RELEASE)"

service-restart: ## Restart the service and wait until it is ready
	@./scripts/service.sh restart

service-stop: ## Stop the service (the room kernels keep running)
	@./scripts/service.sh stop

service-status: ## Whether the service is alive and ready to run a seminar
	@./scripts/service.sh status

service-logs: ## The service log (Ctrl+C to quit)
	@./scripts/service.sh logs

## -------------------------------------------------------------- records

activity: .env ## Seminar activity into a Google Sheet. ROOM=id (or ALL=1); REPLACE=1 — recount
	@# One row per person per seminar; the "Сводка" (summary) sheet computes
	@# the total itself. Where to: ACTIVITY_SHEET_ID in .env; to create the
	@# spreadsheet: scripts/activity-sheet.py --create "title".
	@python3 scripts/activity-sheet.py $(ROOM) $(if $(ALL),--all) $(if $(REPLACE),--replace)

## ---------------------------------------------------------------- outside

host: .env ## Expose a seminar to the outside and get a link. HOST=... — your own address
	@# A tunnel: an outgoing connection from here to the outside. It works from
	@# anywhere (a laptop in the classroom, behind NAT, a rented machine) and
	@# holds as long as the window is open. Where exactly the tunnel goes is
	@# decided by the name: under RELAY_DOMAIN, to your own relay; anything
	@# else, to Cloudflare.
	@COLLOQ_HOSTNAME="$(HOST)" ./scripts/host.sh

host-direct: .env ## The same, but straight from this machine: caddy here, no relay. HOST=name
	@# For a machine with its own public address and real ports 80 and 443.
	@# There is no intermediary at all: students come straight here, the name
	@# points at this address with an A record, and the certificate is obtained
	@# by itself.
	@#
	@# What for: the relay is a shared point of failure for all the names under
	@# it, and with a gigabyte of memory it does not hold two hundred sockets
	@# (measured during a class: 36 out-of-memory kills in an evening, each
	@# tearing down all the tunnels at once).
	@#
	@# The script refuses by itself if 80 and 443 are closed from the outside:
	@# on a rented vast.ai machine that will be the case, direct mode is
	@# impossible there.
	@#
	@# sudo: privileged ports are taken and the caddy service is installed.
	@test -n "$(HOST)" || { printf '$(RED)Specify the address: make host-direct HOST=hse.colloq.ru$(OFF)\n'; exit 1; }
	@COLLOQ_DIRECT=1 COLLOQ_HOSTNAME="$(HOST)" ./scripts/host.sh

ui: ## Check the interface with a real browser. HEADED=1 — with a visible window
	@# Added after a button that did nothing: the types matched, the tests were
	@# green, but there was nothing to press it with.
	@npm run build >/dev/null && npx tsx scripts/ui-check.mts $(if $(HEADED),--headed,)

sync: ## Check that the projector follows the console when slides are flipped fast
	@# Added after a complaint from a class: "flip ahead, and sync catches up in
	@# five seconds or not at all". It measures a queue of presses, not a single
	@# one: waiting for the reply after each press is exactly what hid the whole
	@# disease.
	@npm run build >/dev/null && npx tsx scripts/lecture-sync-check.mts $(if $(HEADED),--headed,)

load: ## Load test rig: 500 students in one room. N=500 RAMP=60 SPID=<pid>
	@# Added after a question there was nothing to answer with: "will the
	@# instance withstand the flow". perf.mts opens two people; here it is a
	@# seminar of its own, N joins at the RAMP pace, both sockets for each, a
	@# typing storm and cleanup afterwards.
	@#
	@# Do not run it against ANOTHER room, and there is no way to: the rig
	@# creates its own and deletes it.
	@# SPID is the pid of the server process, for CPU and RSS; it is not
	@# guessed: service: systemctl show -p MainPID colloq, make run: cat $(PID).
	@# ulimit: five hundred students are a thousand sockets, and on macOS the
	@# default is fewer than needed, so the rig would run into the limits of
	@# its own machine.
	@#
	@# Three opt-in sections, three DIFFERENT forms of broadcast that the storm
	@# does not have at all, and they are off by default: they are the only
	@# ones that leave more than sockets in the room.
	@#   TREE=<files per second>   — to everyone on every change of the tree
	@#   COUNCIL=<how many write>  — to one console from each of the N (EVERY=<sec>)
	@#   INK=<frames per second>   — from one presenter to all N viewers
	@#
	@# The rig does NOT echo the presence of others back to the server, just
	@# like a real tab since ownChanges appeared (web/src/lib/presence.ts).
	@# While it did, the idle CPU of the server came out 2.7 times higher than
	@# it is during a class. To measure the old behavior: LOAD_ECHO=1 make load.
	@ulimit -n 8192 2>/dev/null || true; \
	 LOAD_STUDENTS="$${N:-500}" LOAD_RAMP_SEC="$${RAMP:-60}" LOAD_IDLE_SEC="$${IDLE:-15}" \
	 LOAD_TYPISTS="$${K:-20}" LOAD_KEYS="$${M:-5}" LOAD_STORM_SEC="$${STORM:-20}" \
	 $(if $(TREE),LOAD_TREE="$(TREE)" LOAD_TREE_SEC="$${TREE_SEC:-10}",) \
	 $(if $(COUNCIL),LOAD_COUNCIL="$(COUNCIL)" LOAD_COUNCIL_EVERY="$${EVERY:-2}" LOAD_COUNCIL_SEC="$${COUNCIL_SEC:-10}",) \
	 $(if $(INK),LOAD_INK="$(INK)" LOAD_INK_SEC="$${INK_SEC:-10}",) \
	 $(if $(SPID),LOAD_SERVER_PID="$(SPID)",) $(if $(STAFF),LOAD_STAFF_JOIN=1,) \
	 npx tsx scripts/load.mts

site: ## Publish the colloq.ru site: the landing page and the published seminars. DRY=1 — build only
	@# The site lives in site/ of this same repository; the Pages workflow
	@# publishes it on push to main. A separate repository was set up with the
	@# caveat "Pages cannot do private ones": untrue, and a second clone
	@# alongside is no longer needed.
	@npx tsx scripts/publish-site.mts $(if $(SITE),--site "$(SITE)",) $(if $(BASE),--base "$(BASE)",) $(if $(DRY),--dry,)

mirror: ## Update the colloq.cc mirror (the same site for those who can reach Cloudflare). DRY=1 — only tell
	@# A second name, not a second site: the content is the same, from site/,
	@# and it has one origin, colloq.ru on GitHub Pages. Pages serves a site
	@# under ONE name of its own (site/CNAME), so a second CNAME cannot do this:
	@# at the Cloudflare edge a worker sits and swaps the Host. colloq.ru itself
	@# meanwhile stays grey-clouded and points straight at Pages: Cloudflare
	@# addresses do not open from Russia, and it must not be touched. Details
	@# next to the script: deploy/cloudflare/colloq-cc/README.md.
	@./deploy/cloudflare/colloq-cc/deploy.sh $(if $(DRY),--dry-run,)

site-icons: ## Redraw the site icons from site/favicon.svg (favicon.ico, PNG 48/96/192, apple-touch, icon-512)
	@node --import tsx scripts/site-icons.mts

site-og: ## Redraw the link cards of the landing page (og.png, og-en.png, og-cc.png)
	@# Three 1200×630 pictures for messenger previews: Russian, English, and the
	@# same English one captioned colloq.cc for the mirror. After redrawing,
	@# update the ?v= marks of og:image in site/index.html and
	@# site/en/index.html (tests/site.test.mts checks them); otherwise a chat
	@# shows the old picture from its cache.
	@node --import tsx scripts/site-og.mts

readme-art: ## Redraw the scene animations (.github/assets/readme and site/img/scenes)
	@# Twenty files: five scenes × two languages × two themes. There are two
	@# directories because Pages serves the landing page from site/, and it
	@# cannot reach .github/.
	@node --import tsx scripts/readme-art.mts

course: ## A course from the schedule in a spreadsheet. SHEET=<id> GID=<gid> COL="ML · сильная"
	@test -n "$(SHEET)" || { printf '$(RED)Specify the spreadsheet: make course SHEET=<id> COL="ML · сильная"$(OFF)\n'; exit 1; }
	@npx tsx scripts/course-from-sheet.mts \
	  --sheet "$(SHEET)" --gid "$${GID:-0}" --column "$(COL)" \
	  $(if $(NAME),--name "$(NAME)",) $(if $(BLURB),--blurb "$(BLURB)",) $(if $(DRY),--dry,)

relay-setup: ## Install the relay for *.colloq.ru. WHERE=root@address
	@test -n "$(WHERE)" || { printf '$(RED)Specify the machine: make relay-setup WHERE=root@203.0.113.10$(OFF)\n'; exit 1; }
	@./scripts/relay-setup.sh "$(WHERE)"

relay-page: ## Update the "room is not open yet" page. WHERE=root@address
	@# A student who arrives before the teacher sees it. The page is the file
	@# scripts/relay-offline.html (together with the capybara game), and a full
	@# install for the sake of one paragraph means packages, binaries and a
	@# restart of both services on the production machine where the live
	@# addresses hang. Here it is only the file: no service is restarted.
	@test -n "$(WHERE)" || { printf '$(RED)Specify the machine: make relay-page WHERE=root@203.0.113.10$(OFF)\n'; exit 1; }
	@./scripts/relay-setup.sh --page "$(WHERE)"

tunnel-setup: ## Set up a permanent address, once. HOST=seminar.example.ru
	@test -n "$(HOST)" || { printf '$(RED)Specify the address: make tunnel-setup HOST=seminar.example.ru$(OFF)\n'; exit 1; }
	@./scripts/tunnel-setup.sh "$(HOST)"

## ----------------------------------------------------- rented machine

## You may have no GPU machine of your own at all. Then it is rented by the
## hour on vast.ai, and only as a VM: in a regular docker instance vast forbids
## docker inside, and without it a room has no kernel of its own. Data on a
## rented machine lives until the machine is destroyed, so vast-sync here is
## not a convenience but half of the job. Details and the price of the
## decision: the header of scripts/vast.sh and the README.
##
##   make vast-up GPU="RTX 5070" HOST=demo.colloq.ru
##
## rents, deploys, restores the backup of this environment from backups/ and
## opens the address to the outside. Without HOST and GPU everything is as
## before: the card from VAST_* in .env, no address is brought up.
##
## There can be several environments, and they are several machines:
## hse.colloq.ru and demo.colloq.ru are two rentals, two bills, two databases,
## sharing only the code and the relay. An environment is called by one word,
## and that word is also the first part of the address, the label on vast and
## the backup subdirectory:
##
##   make vast-up NAME=demo HOST=demo.colloq.ru   ·   make vast-sync NAME=demo
##
## What happened during the class, in one command, without a walk over ssh:
##
##   make vast-logs NAME=demo            ·   make vast-logs NAME=demo SINCE=-2h
##
## The name can be omitted when HOST is given (the name is already in it) or
## when there is only one environment. As soon as there are two, sync and down
## without a name refuse with a list.

VAST_SCRIPT := $(if $(RELEASE),vast.sh,vast-legacy.sh)

vast-up: ## Rent a GPU machine and deploy Colloq. NAME=environment HOST=name GPU="RTX 5070" OFFER=number
	@# NAME, HOST and GPU go as the environment, not as arguments, like
	@# COLLOQ_HOSTNAME in `make host`. Empty, they mean "not asked for": the
	@# script then behaves exactly as before they appeared.
	@# Two paths. Without RELEASE, the old one (scripts/vast-legacy.sh): the
	@# working tree, the backup from backups/<environment>/, a systemd service and
	@# docker kernels; with RELEASE=…, the k3s release (scripts/vast.sh). The old
	@# one was brought back on 13 Sep 2026: there was no release at hand two
	@# hours before a lecture, and a machine from the backup was needed at once.
	@# OFFER is the number of an offer from the list, if not taking the
	@# cheapest; the same number can also be given in reply to the "rent?"
	@# question instead of y.
	@NAME="$(NAME)" HOST="$(HOST)" GPU="$(GPU)" OFFER="$(OFFER)" ./scripts/$(VAST_SCRIPT) up

vast-status: ## What is rented: without NAME, all environments; with NAME, the details of one
	@NAME="$(NAME)" ./scripts/$(VAST_SCRIPT) status

vast-sync: ## Pull the data from a rented machine into backups/<environment>/. NAME=environment
	@NAME="$(NAME)" ./scripts/$(VAST_SCRIPT) sync

vast-logs: ## Fetch the logs from a rented machine into logs/<environment>/<date>/. NAME=environment SINCE=today
	@# This used to be a walk over ssh by hand, and so it was not done: to
	@# understand what happened during a class you have to fetch BOTH the
	@# service log AND the kernel logs of every room, including the stopped
	@# ones, which is exactly where the reason for the stop lies. SINCE is
	@# passed as the environment, like NAME and HOST: empty means "today".
	@# Secrets are cut on the fly, before anything is written to disk: see
	@# scrub in scripts/vast.sh and the paragraph in the README.
	@NAME="$(NAME)" SINCE="$(SINCE)" ./scripts/$(VAST_SCRIPT) logs

vast-down: ## Destroy the rented machine, together with everything on it. NAME=environment
	@NAME="$(NAME)" ./scripts/$(VAST_SCRIPT) down

vast-adopt: ## Make an environment of a machine with the old "colloq" label. NAME=demo
	@# The label is changed on the live instance, without re-creating it: the
	@# seminar on it is not interrupted, the disk and the tunnel stay as they
	@# are. This is needed exactly once, for a machine rented before there were
	@# several environments.
	@test -n "$(NAME)" || { printf '$(RED)Name the environment: make vast-adopt NAME=demo$(OFF)\n'; exit 1; }
	@NAME="$(NAME)" ./scripts/vast.sh adopt

## ------------------------------------------------------ image for vast
##
## A ready image instead of a build on the rented machine: the server, the
## client, the tunnels and the kernel build context in one colloq-vast. On a
## Vast VM it is started by the template's on-start (deploy/vast/onstart.sh);
## the room kernels are sibling containers on this VM's docker. Why a VM and
## not a regular Docker instance: deploy/vast/README.md, "Design".

# TAG, not VAST_IMAGE: VAST_IMAGE in .env is already the VM image for rental
# (scripts/vast-legacy.sh, scripts/vast.sh), and one name with two meanings
# would one day tag the build as docker.io/vastai/kvm:… . `=`, not `?=`: an
# environment variable with the same name does not leak in here, only
# make TAG=….
TAG = colloq-vast:dev

.PHONY: vast-image vast-image-run vast-image-stop

vast-image: ## Build the colloq-vast image. TAG=name:tag PLATFORM=linux/amd64
	@# The version comes from the root package.json (its only source, see
	@# scripts/version.mts), the revision from git: both go into the OCI labels
	@# and into `colloq-vast version`. Publishing is a separate step for the
	@# owner: docker push.
	@# The revision gets -dirty if the tree differs from HEAD: otherwise the
	@# label of an image built from uncommitted code would name some other
	@# commit as its source.
	docker build -f deploy/vast/Dockerfile \
	  $(if $(PLATFORM),--platform $(PLATFORM),) \
	  --build-arg COLLOQ_VERSION="$$(node -p "require('./package.json').version")" \
	  --build-arg GIT_SHA="$$(git rev-parse --short HEAD)$$(git diff --quiet HEAD -- 2>/dev/null || echo -dirty)" \
	  -t "$(TAG)" .

vast-image-run: ## Check the image locally: dind instead of a VM, a room, a cell, a backup. SEED_KERNEL=1 — do not build the kernel
	@# Inside docker:dind, not on the docker of this machine: the idle cleanup
	@# removes the room containers of ALL instances on the daemon, and a rig
	@# next to make dev would kill the kernels of another class half an hour
	@# later. The rig stays alive (the address is printed); to remove it:
	@# make vast-image-stop.
	@IMAGE="$(TAG)" SEED_KERNEL="$(SEED_KERNEL)" ./deploy/vast/smoke.sh up
	@IMAGE="$(TAG)" ./deploy/vast/smoke.sh e2e

vast-image-stop: ## Remove the make vast-image-run rig together with everything that was in it
	@./deploy/vast/smoke.sh down

## ---------------------------------------------------------- environments

env-list: ## Which environments exist
	@printf '$(BOLD)Environments$(OFF) $(DIM)($(ENV_DIR)/)$(OFF)\n\n'
	@$(PY_OF); for f in $(ENV_DIR)/*.txt; do \
	  name=$$(basename "$$f" .txt); \
	  n=$$(grep -vE '^\s*(#|-|$$)' "$$f" | grep -c . || true); \
	  mark=' '; [ "$$name" = "$(CURRENT_ENV)" ] && mark='*'; \
	  printf '  %s %-14s $(DIM)Python %s · %s packages on top of the base$(OFF)\n' "$$mark" "$$name" "$$(py_of "$$name")" "$$n"; \
	done
	@printf '\n$(DIM)* — the default for new seminars. Change it: make env-use NAME=<name>$(OFF)\n'

env-show: ## Which environment is set now and what is in it
	@$(PY_OF); printf '$(BOLD)$(CURRENT_ENV)$(OFF) $(DIM)— $(ENV_DIR)/$(CURRENT_ENV).txt · Python %s$(OFF)\n\n' "$$(py_of $(CURRENT_ENV))"
	@out=$$(grep -vE '^\s*(#|$$)' $(ENV_DIR)/$(CURRENT_ENV).txt 2>/dev/null || true); \
	  if [ -n "$$out" ]; then printf '%s\n' "$$out" | sed 's/^/  /'; \
	  else printf '  $(DIM)nothing on top of the base$(OFF)\n'; fi
	@printf '\n$(DIM)Base (always there):$(OFF)\n'
	@grep -vE '^\s*(#|$$)' kernel/requirements.txt | sed 's/^/  /'

env-new: ## Create an environment. NAME=cv [PYTHON=3.12]
	@test -n "$(NAME)" || { printf '$(RED)Specify the name: make env-new NAME=cv$(OFF)\n'; exit 1; }
	@test ! -f $(ENV_DIR)/$(NAME).txt || { printf '$(RED)$(ENV_DIR)/$(NAME).txt already exists.$(OFF)\n'; exit 1; }
	@test -z "$(PYTHON)" || printf '%s\n' $(PY_LIST) | grep -qx '$(PYTHON)' || { \
	  printf '$(RED)Python $(PYTHON) is not one of those the kernel builds on: $(PY_LIST)$(OFF)\n'; exit 1; }
	@# The version goes as a directive in the header, and only if a NON-default
	@# one was asked for: a file without the line and a file with a line about
	@# the default mean the same thing, and the second one also lies if the
	@# default in the Dockerfile is raised one day.
	@: > $(ENV_DIR)/$(NAME).txt
	@test -z "$(PYTHON)" || test "$(PYTHON)" = "$(PY_DEFAULT)" || \
	  printf '# colloq: python $(PYTHON)\n#\n' >> $(ENV_DIR)/$(NAME).txt
	@printf '# Environment "$(NAME)". It is installed on top of the base from kernel/requirements.txt,\n' >> $(ENV_DIR)/$(NAME).txt
	@printf '# so numpy/pandas/matplotlib/plotly/scikit-learn need not be listed.\n#\n' >> $(ENV_DIR)/$(NAME).txt
	@printf '# One package per line, as in an ordinary requirements.txt:\n#\n' >> $(ENV_DIR)/$(NAME).txt
	@printf '#   transformers>=4.44\n#   datasets>=2.20\n' >> $(ENV_DIR)/$(NAME).txt
	@printf '$(BOLD)created$(OFF) $(ENV_DIR)/$(NAME).txt\n'
	@$(PY_OF); printf '$(DIM)Python %s · add the packages, then: make env-use NAME=$(NAME)$(OFF)\n' "$$(py_of $(NAME))"

env-build: ## Build an environment image without switching to it. NAME=cv
	@test -n "$(NAME)" || { printf '$(RED)Specify the name: make env-build NAME=cv$(OFF)\n'; exit 1; }
	@test -f $(ENV_DIR)/$(NAME).txt || { printf '$(RED)No $(ENV_DIR)/$(NAME).txt — first make env-new NAME=$(NAME)$(OFF)\n'; exit 1; }
	@# The inheritance chain. `# colloq: from base-gpu` in the header means
	@# "build on top of that environment's image": the parent goes first, and
	@# only if its image does not exist yet. That is what all this is for: an
	@# edit of the list must not install torch again. A loop or a chain that is
	@# too long is refused here, not after nine minutes of a build that would
	@# fail anyway.
	@set -e; \
	chain=; name=$(NAME); \
	while [ -n "$$name" ]; do \
	  case " $$chain " in *" $$name "*) \
	    printf '$(RED)Environments refer to each other in a loop: %s$(OFF)\n' "$$name"; exit 1;; \
	  esac; \
	  test -f $(ENV_DIR)/$$name.txt || { \
	    printf '$(RED)No %s.txt: environment "%s" is named as a parent, but it does not exist$(OFF)\n' \
	      "$(ENV_DIR)/$$name" "$$name"; exit 1; }; \
	  chain="$$name $$chain"; \
	  [ $$(printf '%s' "$$chain" | wc -w) -le 8 ] || { \
	    printf '$(RED)The environment chain is longer than eight links$(OFF)\n'; exit 1; }; \
	  name=$$(sed -nE 's/^[[:space:]]*#[[:space:]]*colloq:[[:space:]]*from[[:space:]]+([^[:space:]]+)[[:space:]]*$$/\1/p' $(ENV_DIR)/$$name.txt | head -1); \
	  case "$$name" in '') ;; *[!a-z0-9-]*|-*|*-) \
	    printf '$(RED)"%s" cannot be an environment name — neither as a file nor as an image tag$(OFF)\n' "$$name"; \
	    exit 1;; esac; \
	done; \
	parent=; \
	for step in $$chain; do \
	  if [ "$$step" = "$(NAME)" ] || ! docker image inspect colloq-kernel:$$step >/dev/null 2>&1; then \
	    printf '$(BOLD)building %s$(OFF)$(DIM)%s$(OFF)\n' "$$step" "$${parent:+ on top of $$parent}"; \
	    KERNEL_ENV=$$step KERNEL_PARENT=$$parent docker compose build kernel; \
	  fi; \
	  parent=colloq-kernel:$$step; \
	done

env-use: .env ## The default environment for new seminars. NAME=cv
	@# The .env prerequisite is not a formality. Without it, on a fresh clone
	@# the line below created a .env of a single KERNEL_ENV=… line, and after
	@# that neither make up nor make dev wrote their own file (it exists, after
	@# all): the class ran with the defaults, with a well-known kernel token.
	@# The same bug was in `colloq env use` (cli/src/commands/env.ts); there
	@# the same localClassEnv is taken as the base.
	@test -n "$(NAME)" || { printf '$(RED)Specify the name: make env-use NAME=cv$(OFF)\n'; exit 1; }
	@test -f $(ENV_DIR)/$(NAME).txt || { printf '$(RED)No $(ENV_DIR)/$(NAME).txt — first make env-new NAME=$(NAME)$(OFF)\n'; exit 1; }
	@printf '$(DIM)the first time may take a while$(OFF)\n'
	@# Through env-build, not with a `docker compose build` of our own:
	@# building the inheritance chain lives there, and two copies of it would
	@# drift apart on the very first edit.
	@$(MAKE) --no-print-directory env-build NAME=$(NAME)
	@# Written to .env because compose reads KERNEL_ENV from there: otherwise
	@# the next `make up` without the variable would silently bring back the
	@# old environment.
	@#
	@# The content is poured into the existing .env instead of a `mv` over it,
	@# for the same reason as in scripts/host.sh: on Linux, where docker asks
	@# for sudo, `sudo make env-use` moved the file from /tmp together with the
	@# root owner and 0600 permissions, and the next `make run` by the person
	@# could not read it: the instance came up with the defaults, that is, with
	@# a kernel token not its own and localhost in the links for the audience.
	@tmp=$$(mktemp); grep -vE '^KERNEL_ENV=' .env > "$$tmp" 2>/dev/null || true; \
	  printf 'KERNEL_ENV=$(NAME)\n' >> "$$tmp"; cat "$$tmp" > .env; rm -f "$$tmp"
	@printf '$(BOLD)Default environment for new seminars: $(NAME)$(OFF)\n'

env-freeze: ## Show the actual versions from the kernel
	@# The same as with `make shell`: on a dedicated machine the shared compose
	@# kernel does not exist, and the old line answered "no such service"
	@# there. Then we ask the environment image itself: the room kernels are
	@# started from it.
	@if docker compose ps --status running --services 2>/dev/null | grep -qx kernel; then \
	  docker compose exec -T kernel pip freeze; \
	else \
	  docker run --rm colloq-kernel:$(CURRENT_ENV) pip freeze; \
	fi

## ------------------------------------------------------------------- other

test: ## Run the tests
	npm test

check: ## Tests and type checking
	npm test && npm run typecheck

## ---------------------------------------------------------------- package

# The package for the teacher: `pip install colloq`, then `colloq`, and the
# class runs on their machine. There is no repository, no make and no tsx
# there, so everything that today is computed from the sources (the frontend
# build, the tree fingerprint, npm run build) is computed HERE, once. The sign
# of "arrived built" is the .colloq-dist.json file at the application root.

pack: ## Build the pip distribution into python/colloq/_app. SKIP_BUILD=1 — take what is already built
	@# SKIP_BUILD comes in handy in exactly two cases: when the packaging is
	@# being edited and run again and again, and when a class is running on
	@# this machine: `npm run build:optimized` wipes web/dist, from which the
	@# live server is serving pages right now.
	@npx tsx scripts/pack.mts $(if $(SKIP_BUILD),--skip-build,)

wheel: pack ## Build the pip wheel into python/dist (published separately, not here)
	@# pip wheel, not python -m build: build is a separate package the machine
	@# may not have, while pip is everywhere pip install exists at all.
	@# --no-deps: the package has no dependencies at all, and without the flag
	@# pip would go to the network only to confirm that.
	@rm -rf python/dist
	@python3 -m pip wheel ./python --no-deps --quiet --wheel-dir python/dist
	@printf '$(BOLD)Wheel:$(OFF) %s\n' "$$(ls python/dist/*.whl)"
	@printf '$(DIM)To check it: python3 -m venv /tmp/colloq-venv && /tmp/colloq-venv/bin/pip install python/dist/*.whl$(OFF)\n'

wheels: wheel ## Platform wheels with Node and node_modules inside (TARGET=darwin-arm64 for one)
	@# Next to the universal wheel: macOS arm64/x64 and Linux x64/arm64, all
	@# four built on this machine (scripts/platform-wheels.py). To run one here:
	@# python3 scripts/platform-wheels.py smoke --wheel python/dist/<wheel>
	@python3 scripts/platform-wheels.py build $(if $(TARGET),--target $(TARGET),)

## ----------------------------------------------------------------- version

# There is one version: "version" in the root package.json. The rest are its
# copies (the workspaces, the lockfile, python/colloq/_version.py, the
# release-please manifest) and derivatives (web, server, wheel, image tags);
# scripts/version.mts checks them, and so does CI.
#
# The version is not bumped here. The number, the CHANGELOG, the tag and the
# release are made by release-please: it keeps the PR "chore(main): release
# X.Y.Z", and merging that PR is the release. The old `make bump` is gone: the
# next number is decided by the Conventional Commits in main, not by a part
# picked by hand. The target is kept so that the old habit gets an answer
# instead of "No rule to make target". RELEASING.md.

version: ## The project version and a check of all its copies (CI checks the same)
	@node --import tsx scripts/version.mts current
	@node --import tsx scripts/version.mts check

bump:
	@printf '$(RED)release-please bumps the version: merge its PR "chore(main): release X.Y.Z".$(OFF)\n'
	@printf '$(DIM)The next number comes from the Conventional Commits in main; for a number of your own, the Release-As: X.Y.Z footer. RELEASING.md$(OFF)\n'
	@exit 1

.env:
	@test -f .env || { \
	  printf '$(BOLD)no .env — writing the .env of this machine (kernels in docker, its own kernel token)$(OFF)\n'; \
	  : ; \
	  : 'Not a copy of .env.example. That one is the production template,'; \
	  : 'KERNEL_BACKEND=broker, and after make up (run, host) the make dev'; \
	  : 'supervisor refused on it as on an installation with a broker. We write'; \
	  : 'the same file colloq writes on its first run, with its own'; \
	  : 'JUPYTER_TOKEN; why with the shell and not node: scripts/local-env.sh.'; \
	  : 'umask 077: there will be login keys inside; if the writer fails, we do'; \
	  : 'not leave an empty .env behind, otherwise make would count the target done.'; \
	  ( umask 077; bash scripts/local-env.sh > .env ) || { rm -f .env; exit 1; }; \
	  printf '$(DIM)look into it before the seminar: the assistant key is there; all the settings are in .env.example$(OFF)\n'; \
	}

help: ## Show this list
	@printf '$(BOLD)Colloq$(OFF) $(DIM)— collaborative seminars on your own hardware$(OFF)\n\n'
	@grep -hE '^[a-z][a-z-]*:.*?## .*$$' $(MAKEFILE_LIST) \
	  | awk 'BEGIN {FS = ":.*?## "}; {printf "  $(CYAN)%-16s$(OFF) %s\n", $$1, $$2}'
	@printf '\n$(DIM)Production: make install RELEASE=/path/release.json · make host$(OFF)\n'
	@printf '$(DIM)Development in Docker: make up$(OFF)\n'
	@printf '$(DIM)Managing k3s: make cluster-status · cluster-logs · cluster-stop$(OFF)\n'
	@printf '$(DIM)Kernel environment now: $(BOLD)$(CURRENT_ENV)$(OFF)\n'
	@printf '$(DIM)Development: make dev · a class run by a teacher: pip install colloq, colloq start$(OFF)\n'

.PHONY: install update rollback cluster-start cluster-stop cluster-status cluster-logs backup backup-legacy restore-legacy release-validate
install: ## Install a version on a Linux VM. RELEASE=/path/release.json
	@./scripts/cluster.sh install --release "$(RELEASE)"
update: ## Update to an explicit version. RELEASE=/path/release.json
	@./scripts/cluster.sh update --release "$(RELEASE)"
rollback: ## Roll back to a compatible version. RELEASE=/path/release.json
	@./scripts/cluster.sh rollback --release "$(RELEASE)"
cluster-start:
	@./scripts/cluster.sh start
cluster-stop:
	@./scripts/cluster.sh stop
cluster-status:
	@./scripts/cluster.sh status
cluster-logs:
	@./scripts/cluster.sh logs
backup: ## Portable k3s backup. MODE=consistent — stop all writers
	@./scripts/backup.sh
release-validate:
	@python3 scripts/release.py validate --release "$(RELEASE)"
