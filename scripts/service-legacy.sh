#!/usr/bin/env bash
#
# Colloq on a dedicated machine: the server as a systemd service, room kernels in docker.
#
#   scripts/service.sh install   install and start (idempotent)
#   scripts/service.sh restart   restart — after git pull and a build
#   scripts/service.sh stop      stop (room kernels stay alive)
#   scripts/service.sh status    is the service alive and ready to run a seminar
#   scripts/service.sh logs      the journal, Ctrl+C to quit
#
# WHY THIS, WHEN THERE IS `make up`. There are three ways to run, and they are
# not interchangeable:
#
#   make up   the whole stack in docker. A laptop, a one-off demo, "a look".
#   make run  the server by hand, the kernel in docker. Development: a rebuild
#             takes seconds.
#   service   the server on the host under systemd, only the kernels in docker.
#             A dedicated machine — your own or rented — where classes are held.
#
# The form was not changed for looks. Under `make up` on a dedicated machine
# things broke twice, and both times the same way — the server in a container
# does not see what is around it:
#
#   1. The data/ and workspace/ directories were created as root (the docker
#      daemon creates them for the bind mount), while the server inside runs
#      as uid 1000: the database did not open at all, and the container went
#      into a restart loop.
#   2. The panel could not build an environment: inside the container there
#      is no docker-compose.yml, no kernel/Dockerfile and no .env — and
#      building an environment is exactly those. The Build button was there,
#      and it did nothing.
#
# A server on the host removes both: the repository, .env and docker are right
# next to it, the panel can do everything, and there is no user mismatch — see
# deploy/colloq.service, which also names the price (the service runs as root).
#
# WHAT install DOES, step by step: checks the machine, creates .env, installs
# docker (if it is missing) and Node, builds the project, builds the kernel
# image, fixes the owners of directories and, finally, puts the unit in place
# and waits until the instance reports that it is ready. The image comes
# before the directories not for tidiness: it is the one asked which group to
# give workspace/ to.
# Every step survives a repeated run: `install` is both the first installation
# and a code update.
set -euo pipefail

cd "$(dirname "$0")/.."

RED=$'\033[31m'; DIM=$'\033[2m'; BOLD=$'\033[1m'; CYAN=$'\033[36m'; OFF=$'\033[0m'
say() { printf '%s\n' "$*"; }
die() { printf '%s%s%s\n' "$RED" "$*" "$OFF" >&2; exit 1; }

SERVICE=colloq
UNIT=/etc/systemd/system/$SERVICE.service
TEMPLATE=deploy/colloq-legacy.service
# The default path written in the template. It is replaced with the real
# repository directory; kept in a variable so the replacement and the template
# do not drift apart.
TEMPLATE_ROOT=/opt/colloq
# Node is installed by major line. 20 is the one the project is built and
# tested on; a machine that already has 20 or newer is not touched at all.
NODE_MAJOR="${NODE_MAJOR:-22}"

# Wait until apt is released. A freshly rented machine spends its first minutes
# running unattended-upgrades, and any apt-get of our own fails with "Could not
# get lock /var/lib/dpkg/lock-frontend" (13 Sep 2026, two hours before a
# lecture). We wait up to ten minutes; after that let it fail with the real
# error.
apt_wait() {
  local waited=0
  while fuser /var/lib/dpkg/lock-frontend /var/lib/dpkg/lock /var/lib/apt/lists/lock >/dev/null 2>&1 \
    || pgrep -x unattended-upgr >/dev/null 2>&1; do
    [ "$waited" -eq 0 ] && say "${DIM}    apt is busy (unattended-upgrades) — waiting${OFF}"
    sleep 3; waited=$((waited + 3))
    [ "$waited" -ge 600 ] && break
  done
}

REPO="$PWD"

# read_env is shared by all scripts, scripts/lib.sh: a private copy lived in
# three files and everywhere cut out the spaces inside values.
. ./scripts/lib.sh
PORT="$(read_env PORT)"; PORT="${PORT:-3000}"

CMD="${1:-}"

# ---------------------------------------------------------------- checks

# A service means Linux with systemd, and root. The refusal here is short and
# comes before anything is installed: on macOS there is nowhere to put a
# systemd unit, and as an ordinary user there is nothing to do it with anyway.
need_systemd() {
  [ "$(uname -s)" = Linux ] || die "a systemd service exists only on Linux.
  On a laptop there are two other ways: make up (everything in docker) or make run."
  command -v systemctl >/dev/null 2>&1 || die "this machine has no systemd (systemctl not found).
  This way is meant for Ubuntu/Debian. Without systemd there are make up and make run."
}

need_root() {
  [ "$(id -u)" = 0 ] || die "root is needed: sudo $0 $CMD
  The service is installed into /etc/systemd/system and runs as root — why exactly so
  is explained in the header of deploy/colloq.service."
}

# The service is installed — not "running" but "the unit file exists". It
# answers the question "has this machine already moved to the new form".
installed() { [ -f "$UNIT" ]; }
active() { systemctl is-active --quiet "$SERVICE" 2>/dev/null; }

# We wait not for "systemctl returned" but for an answer from /api/health: it
# answers 200 only when the database reads and the room's Python is ready to
# start. A link printed over an instance that is still coming up is a link
# handed to the audience a minute before it starts working.
wait_health() {
  local tries="${1:-60}" i
  for ((i = 0; i < tries; i++)); do
    if curl -fsS -m 2 "http://localhost:$PORT/api/health" >/dev/null 2>&1; then return 0; fi
    active || return 1
    sleep 1
  done
  return 1
}

# What to say when readiness never came. Two different troubles with the same
# screen: the service crashed (look at the journal), and the service is alive
# but cannot run a seminar (usually an unbuilt environment or docker being off).
explain_unhealthy() {
  printf '\n'
  if active; then
    say "${RED}the service is running but not ready to run a seminar${OFF}"
    say "${DIM}what it says itself:${OFF}"
    curl -fsS -m 3 "http://localhost:$PORT/api/health" 2>/dev/null | head -c 400 | sed 's/^/    /' || true
    printf '\n'
    say "${DIM}most often this is an unbuilt kernel environment (make env-build NAME=…)${OFF}"
    say "${DIM}or docker being unreachable (systemctl status docker)${OFF}"
  else
    say "${RED}the service did not come up${OFF}"
  fi
  say "${DIM}journal: journalctl -u $SERVICE -n 40 --no-pager${OFF}"
  journalctl -u "$SERVICE" -n 20 --no-pager 2>/dev/null | sed 's/^/    /' || true
}

# Did the kernel recipe change after the image was built?
#
# "The image exists, so it is ready" holds exactly until the recipe itself is
# edited, and the price of the mistake here is silent: rooms run on the old
# image, the panel says "Ready", and the fix does not work. That is what
# happened to the matplotlib fix: `MPLBACKEND=Agg` in the Dockerfile took every
# inline picture away from the kernel, and after the rollout the image stayed
# the old one, because it was "already built".
#
# The environment's package list is not part of this: the server itself
# watches it, by its own build mark (server/src/environments.ts ·
# editedSinceBuild), and it can compare contents rather than times. Here it is
# only the base shared by all environments, which has no mark.
kernel_recipe_newer() {
  local image="colloq-kernel:$1" created built file
  created="$(docker image inspect -f '{{.Created}}' "$image" 2>/dev/null || true)"
  [ -n "$created" ] || return 0
  built="$(date -d "$created" +%s 2>/dev/null || true)"
  # The date did not parse — rebuilding blindly costs more than trusting the
  # image: building the base means minutes of downtime on every rollout.
  [ -n "$built" ] || return 1
  # Through `if`, not `[ … ] && return 0`: under `set -e` a failed check on the
  # last file would bring down the whole script instead of "no, not newer".
  for file in kernel/Dockerfile kernel/requirements.txt; do
    [ -f "$file" ] || continue
    if [ "$(stat -c %Y "$file" 2>/dev/null || echo 0)" -gt "$built" ]; then return 0; fi
  done
  return 1
}

# ---------------------------------------------------------------- install

cmd_install() {
  need_systemd
  need_root

  local steps=8

  say "${BOLD}1/$steps${OFF} checking the machine"
  [ -f package.json ] && [ -d server/src ] || die "this is not a Colloq repository: $REPO
  Run it from a clone: cd /opt/colloq && make service-install"
  [ -f "$TEMPLATE" ] || die "no $TEMPLATE — the unit template. Is the clone incomplete?"
  # The repository path goes both into the unit and into the sed that puts it
  # there. A unit is not a shell: a path with a space would have to be quoted
  # there, and a '#' in the path would break the substitution itself. A refusal
  # is cheaper than a silently crooked unit.
  case "$REPO" in
    *[!A-Za-z0-9._/-]*) die "the path \"$REPO\" has characters a systemd unit does not understand.
  Move the repository to where the path has only letters, digits, dot, hyphen,
  underscore and slash: /opt/colloq is what scripts/vast.sh uses." ;;
  esac
  # Who holds the port. A second Colloq on the same port means two databases,
  # two setup-tokens and links leading now here, now there; there is no
  # catching that from the screen. Our own service (a reinstall) is no obstacle.
  if active; then
    say "${DIM}    the service is already installed and running — this is an update${OFF}"
  elif docker compose ps --status running --services 2>/dev/null | grep -qx app; then
    die "app is running in docker — that is Colloq in the old form, and it holds port $PORT.
  Stop it and try again: make down"
  elif [ -f .colloq.pid ] && kill -0 "$(cat .colloq.pid 2>/dev/null)" 2>/dev/null; then
    die "a server started with make run is running on the host.
  Stop it and try again: make stop"
  elif command -v ss >/dev/null 2>&1 && ss -ltn 2>/dev/null | grep -qE "[:.]$PORT[[:space:]]"; then
    die "port $PORT is taken by someone else — the service cannot take it.
  To see by whom: ss -ltnp | grep :$PORT"
  fi

  say "${BOLD}2/$steps${OFF} settings"
  # .env is created by the same code as for the other ways of running: that is
  # also where it gets a JUPYTER_TOKEN of its own instead of the well-known one
  # from the example. Called only when the file is missing: for an existing
  # file make answers "is up to date", and in the install output that is an
  # extra line that looks like an error.
  [ -f .env ] || make --no-print-directory .env
  # Re-read the port: before this line it may not have existed at all, and
  # further on it is what occupancy and readiness are checked by.
  PORT="$(read_env PORT)"; PORT="${PORT:-3000}"
  # Three lines that break this form silently.
  #
  # For a server in a container, WORKSPACE_HOST_DIR names ./workspace as the
  # host sees it. Here the server ITSELF is on the host — the path is right
  # anyway — but the server also reads this variable as a sign of "I am in a
  # container": seeing it, it puts the room's kernel into the compose network
  # and calls it by the container's name, which there is no route to from the
  # host. Every Run would end in an error.
  if [ -n "$(read_env WORKSPACE_HOST_DIR)" ]; then
    die "WORKSPACE_HOST_DIR is set in .env — remove the line.
  Only a server that itself lives in a container (make up) needs it. Here the
  server is on the host, and from this variable it will decide it is in a
  container: the room's kernel will go into the compose network and be called by
  a name that cannot be seen from the host. The room will answer the very first
  Run with an error."
  fi
  # Without WORKSPACE_HOST_DIR the server does not read KERNEL_NETWORK at all —
  # but a line left over from the old form promises what is not here. We say
  # so and move on.
  if [ -n "$(read_env KERNEL_NETWORK)" ]; then
    say "${DIM}    KERNEL_NETWORK in .env is not needed: the compose network plays no part here,${OFF}"
    say "${DIM}    the room's kernel listens on a loopback port. The line is simply not read.${OFF}"
  fi
  # Isolation is off — so the rooms share one kernel. Under `make up` the
  # compose kernel served them; here nobody brings it up, and there is no
  # shared Python on the machine at all.
  if [ "$(read_env KERNEL_ISOLATION)" = off ]; then
    say "${RED}    KERNEL_ISOLATION=off — rooms will not have kernels of their own${OFF}"
    say "${DIM}    And the shared compose kernel is not brought up here: you would have to${OFF}"
    say "${DIM}    bring it up yourself (docker compose with docker-compose.dev.yml publishes${OFF}"
    say "${DIM}    8888 on loopback). Otherwise nobody will have Python.${OFF}"
  fi
  say "${DIM}    .env is in place${OFF}"

  say "${BOLD}3/$steps${OFF} docker — for room kernels"
  export DEBIAN_FRONTEND=noninteractive
  if ! command -v docker >/dev/null 2>&1; then
    say "${DIM}    installing (get.docker.com)${OFF}"
    curl -fsSL https://get.docker.com | sh >/dev/null
  fi
  systemctl enable --now docker >/dev/null 2>&1 || true
  docker version --format '{{.Server.Version}}' >/dev/null 2>&1 \
    || die "docker is here, but the daemon does not answer: systemctl status docker
  Without it a room has no kernel of its own, and on this machine none at all."
  say "${DIM}    docker $(docker version --format '{{.Server.Version}}' 2>/dev/null)${OFF}"
  # Environments are built along two roads: `make env-build` calls docker
  # compose, the panel a plain `docker build`, and since client 23 that
  # requires buildx. Without the plugin the Build button answers "buildx
  # component is missing", and there is no telling why from the screen. Not a
  # refusal: a seminar with an already built image runs anyway.
  docker buildx version >/dev/null 2>&1 \
    || say "${RED}    no docker-buildx-plugin — the panel will not build an environment${OFF}"
  docker compose version >/dev/null 2>&1 \
    || say "${RED}    no docker-compose-plugin — make env-build will not build an environment${OFF}"

  say "${BOLD}4/$steps${OFF} Node $NODE_MAJOR"
  # Why nodesource, and not the distribution's package or nvm.
  #
  # In Debian 12 node is 18, in Ubuntu 22.04 it is 12: both lines are older
  # than what the project is built on. nvm installs into a user's shell, and a
  # systemd service sees nobody's shell — the unit simply would not find node.
  # What remains is the official nodesource repository: an ordinary apt
  # source, whose updates arrive along with the rest of the machine.
  local have=0
  if command -v node >/dev/null 2>&1; then
    have="$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)"
  fi
  if [ "$have" -ge "$NODE_MAJOR" ] 2>/dev/null; then
    say "${DIM}    node $(node -v) is already installed${OFF}"
  else
    apt_wait
    apt-get update -qq
    apt-get install -y -qq curl ca-certificates gnupg >/dev/null
    apt_wait
    curl -fsSL "https://deb.nodesource.com/setup_${NODE_MAJOR}.x" | bash - >/dev/null
    apt_wait
    apt-get install -y -qq nodejs >/dev/null
    say "${DIM}    node $(node -v)${OFF}"
  fi
  # Build tools — for the sake of better-sqlite3: a prebuilt binary does not
  # exist for every combination of node version and architecture, and then npm
  # builds it from source. Without a compiler that is a failure in `npm ci`
  # with a three-storey stack trace from which the cause does not follow. The
  # same three packages are in the Dockerfile, for the same reason.
  if ! command -v g++ >/dev/null 2>&1 || ! command -v make >/dev/null 2>&1; then
    apt_wait
    apt-get update -qq
    apt-get install -y -qq python3 make g++ >/dev/null
  fi

  say "${BOLD}5/$steps${OFF} building"
  say "${DIM}    the first time this takes a few minutes${OFF}"
  # `npm ci`, not install: the lock file is in the repository, and exactly the
  # versions the project was tested with must be built. --include=dev is
  # spelled out because the build needs devDependencies (vite, tsc), and
  # NODE_ENV=production in the machine's environment would silently drop them.
  npm ci --no-audit --no-fund --include=dev

  # The client is built NEXT TO its place and moves in by a rename.
  #
  # `vite build` first of all empties its outDir, and web/dist is being served
  # from disk right now by the running service (express.static,
  # server/src/index.ts). While the build ran — on a rented machine that is
  # minutes — any tab reload in a running room got a 404 on /assets/*.js: a
  # white screen in the middle of a class just because someone is updating the
  # code. This same command is the only regular way to update ("git pull &&
  # make service-install"), so the case is not rare.
  #
  # Renaming a directory is one filesystem operation, and there is no window in
  # which the static files are missing.
  rm -rf web/dist.next web/dist.prev
  npm run build -w @colloq/web -- --outDir dist.next --emptyOutDir
  [ -f web/dist.next/index.html ] || die "the build passed, but there is no web/dist.next/index.html — the room would open empty."
  if [ -d web/dist ]; then mv web/dist web/dist.prev; fi
  mv web/dist.next web/dist
  rm -rf web/dist.prev

  # The server is one file, and swapping it is not visible to the running
  # process at all: node read it at startup. The new one is picked up by the
  # service restart in step eight.
  npm run build -w @colloq/server
  [ -f server/dist/server.js ] || die "the build passed, but there is no server/dist/server.js — see the output above."

  say "${BOLD}6/$steps${OFF} kernel image"
  # Without a built environment image the instance comes up but cannot run a
  # seminar: a room asks for `colloq-kernel:<environment>`, and it is not
  # there. `make up` used to do this along with building the whole stack; here
  # there is no stack, and the step became visible. An image that is already
  # built is not rebuilt — that is the idempotence.
  local env_name; env_name="$(read_env KERNEL_ENV)"; env_name="${env_name:-base}"
  if docker image inspect "colloq-kernel:$env_name" >/dev/null 2>&1 && ! kernel_recipe_newer "$env_name"; then
    say "${DIM}    colloq-kernel:$env_name is already built${OFF}"
  else
    say "${DIM}    building colloq-kernel:$env_name — this is slow, minutes${OFF}"
    make --no-print-directory env-build NAME="$env_name"
  fi

  say "${BOLD}7/$steps${OFF} directories and owners"
  mkdir -p data workspace
  # data/ belongs to the server alone. It is root, so the owner is not changed
  # here at all: the database, the signing key and the setup token stay with
  # whoever writes them. (The directory may have come from the old form with
  # owner 1000 — root writes there anyway, nothing needs breaking.)
  #
  # workspace/ is shared with the kernel: the server puts uploads there, the
  # room's kernel writes cell results as uid 1000. The kernel's group and the
  # setgid bit do what happened by itself in the old forms (both sides were
  # uid 1000 there): everything new inside goes to that group, and UMask=0002
  # from the unit gives it the right to write. Without this pair the very
  # first cell with open(...,'w') fails with PermissionError on a green screen.
  #
  # The group recursively, the permissions only on directories. The owner of
  # the files inside is not touched at all: what the kernel wrote belongs to
  # it and is edited by it, and as root:<group> with the old 0644 it would
  # become uneditable for it.
  #
  # The group number is not hard-coded but asked from the image itself:
  # `runner` in kernel/Dockerfile is created with uid 1000, but its group comes
  # from useradd — and if gid 1000 is already taken in the parent image (an
  # environment can be built on top of a CUDA base), it will be different. A
  # hard-coded thousand would then silently not match, and the first cell that
  # writes to a file would fail with PermissionError.
  local kgid
  kgid="$(docker run --rm "colloq-kernel:$env_name" id -g 2>/dev/null | tr -dc '0-9' || true)"
  if [ -z "$kgid" ]; then
    kgid=1000
    say "${DIM}    could not ask the image for its group — taking 1000, as in kernel/Dockerfile${OFF}"
  fi
  chgrp -R "$kgid" workspace 2>/dev/null || say "${DIM}    could not set group $kgid${OFF}"
  find workspace -type d -exec chmod 2775 {} + 2>/dev/null || true
  say "${DIM}    workspace/ — group $kgid and setgid: the room's kernel writes where the server does${OFF}"

  say "${BOLD}8/$steps${OFF} service"
  # The unit is laid down from the template with the path substituted.
  # Comparing with what is already there is not thrift: an extra daemon-reload
  # on every reinstall hides the real changes in the journal, while here one
  # can see whether anything changed.
  local tmp; tmp="$(mktemp)"
  sed "s#$TEMPLATE_ROOT#$REPO#g" "$TEMPLATE" > "$tmp"
  if [ -f "$UNIT" ] && cmp -s "$tmp" "$UNIT"; then
    say "${DIM}    $UNIT has not changed${OFF}"
    rm -f "$tmp"
  else
    install -m 0644 "$tmp" "$UNIT"
    rm -f "$tmp"
    say "${DIM}    $UNIT written${OFF}"
    systemctl daemon-reload
  fi
  # enable means "come up after a reboot". A silent failure here would cost a
  # machine that does not bring the seminar up at all after a planned reboot.
  systemctl enable "$SERVICE" >/dev/null 2>&1 \
    || say "${RED}    systemctl enable failed — after a reboot the service will not come up by itself${OFF}"
  # restart, not start: one command serves both the first install and a code
  # update, and a repeated run must not trip over "already running".
  systemctl restart "$SERVICE"

  if wait_health 90; then
    printf '\n'
    say "${BOLD}Colloq runs as a service${OFF} ${DIM}(systemd, as root)${OFF}"
    say "  ${CYAN}$(read_env PUBLIC_URL)${OFF}"
    say "${DIM}journal: make service-logs · restart: make service-restart${OFF}"
    say "${DIM}to the outside: make host HOST=<name>${OFF}"
  else
    explain_unhealthy
    exit 1
  fi
}

# ---------------------------------------------------------------- the rest

cmd_restart() {
  need_systemd
  need_root
  installed || die "the service is not installed. Install it: make service-install"
  systemctl restart "$SERVICE"
  if wait_health 60; then
    say "${DIM}the service restarted and answers${OFF}"
  else
    explain_unhealthy
    exit 1
  fi
}

cmd_stop() {
  need_systemd
  need_root
  installed || die "the service is not installed — nothing to stop."
  # Only the server. Room containers stay alive: they are kernels holding the
  # seminar's variables, and there is no reason to kill them for a server
  # restart — the next time a room opens, the server finds them by label and
  # picks them up. To remove them all at once: make down.
  systemctl stop "$SERVICE"
  say "${DIM}the service is stopped. Room kernels are still there — to remove them: make down${OFF}"
}

cmd_logs() {
  need_systemd
  installed || die "the service is not installed. Install it: make service-install"
  journalctl -u "$SERVICE" -n 80 -f
}

cmd_status() {
  need_systemd
  if ! installed; then
    say "${DIM}the service is not installed${OFF} ${DIM}($UNIT)${OFF}"
    say "${DIM}install: make service-install · other ways: make up, make run${OFF}"
    return 0
  fi
  systemctl status "$SERVICE" --no-pager -n 5 || true
  printf '\n'
  # "active (running)" is about the process, not the seminar. A separate
  # question asks whether the instance is ready to run a class: the database
  # and the room's Python.
  if curl -fsS -m 3 "http://localhost:$PORT/api/health" >/dev/null 2>&1; then
    say "${CYAN}ready to run a seminar${OFF} ${DIM}(localhost:$PORT/api/health)${OFF}"
  else
    say "${RED}not ready to run a seminar${OFF}"
    curl -fsS -m 3 "http://localhost:$PORT/api/health" 2>/dev/null | head -c 400 | sed 's/^/  /' || true
    printf '\n'
  fi
  say "${DIM}PUBLIC_URL: $(read_env PUBLIC_URL)${OFF}"
}

case "$CMD" in
  install) cmd_install ;;
  restart) cmd_restart ;;
  stop)    cmd_stop ;;
  logs)    cmd_logs ;;
  status)  cmd_status ;;
  *)
    say "${BOLD}Colloq as a systemd service${OFF} ${DIM}— the server on the host, room kernels in docker${OFF}"
    say "  scripts/service.sh install  ${DIM}install and start (also: update)${OFF}"
    say "  scripts/service.sh restart  ${DIM}restart${OFF}"
    say "  scripts/service.sh stop     ${DIM}stop (room kernels stay)${OFF}"
    say "  scripts/service.sh status   ${DIM}is it alive and ready to run a seminar${OFF}"
    say "  scripts/service.sh logs     ${DIM}journal${OFF}"
    say ""
    say "${DIM}the same via make: make service-install · service-restart · service-stop${OFF}"
    say "${DIM}                   make service-status · service-logs${OFF}"
    say "${DIM}A laptop does not need this: make up (everything in docker) or make run.${OFF}"
    if [ -n "$CMD" ]; then die "unknown command \"${CMD}\"."; fi
    ;;
esac
