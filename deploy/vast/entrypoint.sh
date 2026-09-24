#!/usr/bin/env bash
#
# colloq-vast: the entry point of the deploy/vast/Dockerfile image.
#
#   colloq-vast serve          (default) server + tunnel + kernels on demand
#   colloq-vast status         is the instance ready for a class: /api/health and kernel images
#   colloq-vast link           the address for the audience and, while nobody owns it, the setup link
#   colloq-vast backup         a class backup into <state>/backups/ (database + files)
#   colloq-vast restore …      restore a backup; only while the server is STOPPED
#   colloq-vast install-host D put the host-side manager (colloq-host) into directory D on the host
#   colloq-vast version
#
# WHAT HAPPENS HERE AND WHY IT IS DONE THIS WAY.
#
# Every room's kernel is a separate container (server/src/kernel/pool.ts), and
# the HOST daemon starts it through the mounted socket. Hence three things the
# entry point has to do before the server starts, otherwise the server comes up
# "healthy" and refuses on the first Run:
#
#   1. the path of the state directory as the host sees it. The `-v` of a room
#      container is resolved by the daemon, not by us: the server writes the
#      room files to /workspace/colloq/workspace/<id> INSIDE this container,
#      while the daemon has to be given the same place on the host. We learn it
#      from the daemon itself, from our own mounts, instead of asking the
#      operator to repeat the path a second time;
#   2. a network shared with the room containers (KERNEL_NETWORK). The server
#      reaches a kernel by container name; without the network canIsolate()
#      answers "no" and CACHES the answer until a restart (pool.ts ·
#      networkExists), so the network is created before the server, not "when
#      it is needed";
#   3. the public address. The server prints the owner's setup link at start,
#      and prints it from PUBLIC_URL: the tunnel comes up FIRST, so that the log
#      gets the real link, not localhost.
#
# The kernel of the default environment is prepared in the background after the
# server has started: the first build takes minutes, and the panel and the
# setup link are needed right away. While there is no image, /api/health
# honestly answers 503 "environment not built", and that is the truth.
#
# NODE_ENV=development is neither a typo nor debugging. The server allows the
# docker kernel backend only outside production (runtime-client.ts ·
# selectKernelBackend): in production it expects the k3s broker. The old path
# on a rented machine (deploy/colloq-legacy.service) does exactly the same, for
# the same reason. NODE_ENV decides nothing else in the server: the unsafe file
# bypass is enabled only together with COLLOQ_UNSAFE_DEV_FILES=1, and that is
# not set here.
set -euo pipefail

APP=/opt/colloq
STATE="${COLLOQ_HOME:-/workspace/colloq}"
export COLLOQ_HOME="$STATE"
PORT="${PORT:-3000}"
APP_UID=1000
APP_GID=1000
SOCK="${DOCKER_SOCK:-/var/run/docker.sock}"
VERSION="${COLLOQ_VERSION:-0.0.0-dev}"

say()  { printf '[vast] %s\n' "$*"; }
warn() { printf '[vast] WARNING: %s\n' "$*" >&2; }
die()  { printf '[vast] ERROR: %s\n' "$*" >&2; exit "${2:-1}"; }

# ----------------------------------------------------------- root → node
#
# As root, only the preparation: the state directory and the docker socket
# group. Everything else (the server, tunnels, builds, backups) runs as node,
# uid 1000: that is the same uid as the kernel user in kernel/Dockerfile, and
# both sides read and write the room files without groups and umask (see UMask
# in deploy/colloq-legacy.service: that match was missing there, and it had to
# be created by hand).
#
# An honest caveat: access to the docker socket is root on the host. The
# unprivileged uid here is about file ownership and about a server bug not
# writing as root into other directories, not about a security boundary with
# the host.
prepare_as_root() {
  local walk="${1:-}"
  mkdir -p "$STATE"/data "$STATE"/workspace "$STATE"/environments "$STATE"/backups "$STATE"/.colloq
  if [ "$walk" = full ]; then
    # Our files back to our user. Backups brought by scp as root, and files laid
    # out by hand, otherwise turn into "Permission denied" for the server in the
    # middle of a class. find, not chown -R: only files owned by others are
    # touched, and a repeated start costs one walk.
    find "$STATE" -xdev \( ! -user "$APP_UID" -o ! -group "$APP_GID" \) \
      -exec chown -h "$APP_UID:$APP_GID" {} + 2>/dev/null || true
  else
    # status, link, backup are a `docker exec` in the middle of a class, and
    # there is no reason to walk the whole workspace (the rooms' datasets) for
    # them: serve has already sorted it out. The top directories are enough, in
    # case mkdir above has just created them.
    chown "$APP_UID:$APP_GID" "$STATE" "$STATE"/data "$STATE"/workspace "$STATE"/environments "$STATE"/backups "$STATE"/.colloq
  fi
  chmod 0700 "$STATE/data"
  touch "$STATE/.env"
  chown "$APP_UID:$APP_GID" "$STATE/.env"
  chmod 0600 "$STATE/.env"
  # The .env link in the image leads to /workspace/colloq, the COLLOQ_HOME
  # default. Another state directory would leave it dangling: the server reads
  # PUBLIC_URL from the APPLICATION's .env (config.ts · readPublicUrl), and the
  # links would say localhost instead of the tunnel address, while the panel
  # (environments.ts · envFile) writes KERNEL_ENV into the state directory and
  # would notice nothing.
  if [ "$(readlink "$APP/.env" 2>/dev/null || true)" != "$STATE/.env" ]; then
    ln -sfn "$STATE/.env" "$APP/.env"
  fi
  # The credentials of the private registry (colloq-host mounts them
  # read-only): as a copy into the ~/.docker of the node user. A file mounted
  # straight there would create ~/.docker as root, and buildx could not write
  # its own directory next to it.
  if [ -s /run/colloq/docker-config.json ]; then
    install -d -o "$APP_UID" -g "$APP_GID" -m 0700 /home/node/.docker
    install -o "$APP_UID" -g "$APP_GID" -m 0600 /run/colloq/docker-config.json /home/node/.docker/config.json
  fi
}

drop_to_app() {
  local groups=()
  if [ -S "$SOCK" ]; then
    groups=(--groups "$(stat -c %g "$SOCK")")
  else
    groups=(--clear-groups)
  fi
  # HOME is required: buildx writes ~/.docker/buildx, and under HOME=/root an
  # environment build fails on permissions before the first layer.
  exec setpriv --reuid="$APP_UID" --regid="$APP_GID" "${groups[@]}" --inh-caps=-all \
    env HOME=/home/node USER=node LOGNAME=node COLLOQ_VAST_DROPPED=1 "$0" "$@"
}

# ------------------------------------------------------------- host docker
require_docker() {
  if docker version --format '{{.Server.Version}}' >/dev/null 2>&1; then return 0; fi
  cat >&2 <<'MSG'
[vast] ERROR: no Docker daemon is reachable at /var/run/docker.sock.

  Colloq gives every room its own kernel container, and this image starts those
  containers on the HOST's Docker daemon. That needs the host socket:

      docker run ... -v /var/run/docker.sock:/var/run/docker.sock ...

  An ordinary Vast.ai *Docker instance* cannot provide it (Vast disables
  Docker-in-Docker). Rent a Vast *VM* and use the template described in
  deploy/vast/README.md — the VM runs this same image with the socket mounted.
MSG
  exit 78
}

# Our own container: to ask the daemon about our own mounts and networks.
SELF=""
locate_self() {
  SELF="${COLLOQ_CONTAINER:-$(hostname)}"
  docker inspect "$SELF" >/dev/null 2>&1 \
    || die "cannot inspect this container as \"$SELF\". Start it without --hostname, or set COLLOQ_CONTAINER=<its name>."
}

# The path of the state directory as the host sees it: the longest mount that
# contains it. If none matches, the state lives in the container layer: the
# daemon will mount an empty place into a room, the seminar files will diverge
# from the kernel, and an image update will wipe out everything. That is a
# refusal, not a warning.
HOST_STATE=""
locate_host_state() {
  if [ -n "${COLLOQ_HOST_STATE:-}" ]; then HOST_STATE="$COLLOQ_HOST_STATE"; return; fi
  local best="" source="" dest src
  while IFS=$'\t' read -r dest src; do
    [ -n "$dest" ] || continue
    if [ "$STATE" = "$dest" ] || [ "${STATE#"$dest"/}" != "$STATE" ]; then
      if [ "${#dest}" -gt "${#best}" ]; then best="$dest"; source="$src"; fi
    fi
  done < <(docker inspect -f '{{range .Mounts}}{{.Destination}}{{"\t"}}{{.Source}}{{"\n"}}{{end}}' "$SELF")
  [ -n "$best" ] || die "$STATE is not a mounted directory. Mount one from the host at the same path:
      -v /workspace/colloq:/workspace/colloq
  Room kernels are sibling containers; they can only see files that live on the host."
  HOST_STATE="${source}${STATE#"$best"}"
}

NET=""
ensure_network() {
  NET="${KERNEL_NETWORK:-colloq}"
  if ! docker network inspect "$NET" >/dev/null 2>&1; then
    docker network create "$NET" >/dev/null || die "could not create the docker network $NET"
    say "created docker network $NET for room kernels"
  fi
  local joined
  joined=" $(docker inspect -f '{{range $name, $_ := .NetworkSettings.Networks}}{{$name}} {{end}}' "$SELF") "
  case "$joined" in
    *" $NET "*) : ;;
    *) docker network connect "$NET" "$SELF" || die "could not attach this container to $NET"
       say "attached to docker network $NET" ;;
  esac
}

# --------------------------------------------------------------- state .env
#
# A single PUBLIC_URL line in <state>/.env. The server re-reads it at least once
# every two seconds (config.ts · readPublicUrl), so the new quick tunnel address
# after a tunnel restart reaches the links without a server restart.
# Through tmp and mv in the same directory: a reader must not see half a file.
set_public_url() {
  local url="$1" file="$STATE/.env" tmp
  tmp="$(mktemp "$STATE/.env.XXXXXX")"
  { grep -v '^PUBLIC_URL=' "$file" 2>/dev/null || true; printf 'PUBLIC_URL=%s\n' "$url"; } > "$tmp"
  chmod 0600 "$tmp"
  mv -f "$tmp" "$file"
}

read_state_env() {
  grep -E "^$1=" "$STATE/.env" 2>/dev/null | tail -1 | cut -d= -f2- | tr -d '\r' || true
}

# ------------------------------------------------------------- tunnels
#
# Four ways, chosen by COLLOQ_TUNNEL (auto by default):
#
#   relay       frpc → your own relay (RELAY_*), address https://<name>.<domain>.
#               The path for Russia: Cloudflare addresses do not open from there.
#   cloudflare  CLOUDFLARE_TUNNEL_TOKEN + COLLOQ_HOSTNAME: a named tunnel,
#               otherwise a quick *.trycloudflare.com with a random address.
#   direct      http://$PUBLIC_IPADDR:$VAST_TCP_PORT_<PORT>: vast port forwarding,
#               no TLS and no intermediary.
#   none        bring nothing up; the address is PUBLIC_URL or localhost.
#
# auto takes relay if it is configured; otherwise a named Cloudflare tunnel;
# otherwise none, if the address is given explicitly; otherwise a quick tunnel.
MODE=""
PUBLIC=""
TUNNEL_PID=""
TUNNEL_LOG=""
RUN_DIR=""

relay_hostname() {
  local host="${COLLOQ_HOSTNAME:-}"
  # A short name is completed to the relay zone: HOST=demo → demo.<domain>.
  case "$host" in
    *.*) printf '%s' "$host" ;;
    '') printf '' ;;
    *) printf '%s.%s' "$host" "${RELAY_DOMAIN:-}" ;;
  esac
}

pick_mode() {
  MODE="${COLLOQ_TUNNEL:-auto}"
  if [ "$MODE" = auto ]; then
    if [ -n "${COLLOQ_HOSTNAME:-}" ] && [ -n "${RELAY_ADDR:-}" ] && [ -n "${RELAY_TOKEN:-}" ] && [ -n "${RELAY_DOMAIN:-}" ]; then
      MODE=relay
    elif [ -n "${CLOUDFLARE_TUNNEL_TOKEN:-}" ] && [ -n "${COLLOQ_HOSTNAME:-}" ]; then
      MODE=cloudflare
    elif [ -n "${PUBLIC_URL:-}" ]; then
      MODE=none
    else
      MODE=cloudflare
    fi
  fi
  case "$MODE" in
    relay)
      [ -n "${RELAY_ADDR:-}" ] && [ -n "${RELAY_TOKEN:-}" ] && [ -n "${RELAY_DOMAIN:-}" ] && [ -n "${COLLOQ_HOSTNAME:-}" ] \
        || die "COLLOQ_TUNNEL=relay needs COLLOQ_HOSTNAME, RELAY_ADDR, RELAY_TOKEN and RELAY_DOMAIN."
      local host; host="$(relay_hostname)"
      # The name goes as a string into frpc.toml (start_relay): a quote or a
      # space in it would break the config so that frpc would blame a line of
      # the file, not the variable.
      case "$host" in
        *[!A-Za-z0-9.-]*) die "COLLOQ_HOSTNAME=$COLLOQ_HOSTNAME: a hostname has only letters, digits, dots and hyphens." ;;
      esac
      [ "${host%".$RELAY_DOMAIN"}" != "$host" ] \
        || die "$host is not under RELAY_DOMAIN=$RELAY_DOMAIN: the relay only serves names in its own zone."
      PUBLIC="https://$host" ;;
    cloudflare)
      if [ -n "${CLOUDFLARE_TUNNEL_TOKEN:-}" ]; then
        [ -n "${COLLOQ_HOSTNAME:-}" ] || die "a named Cloudflare tunnel needs COLLOQ_HOSTNAME (the hostname routed to it)."
        PUBLIC="https://${COLLOQ_HOSTNAME}"
      fi ;;
    direct)
      # On a Docker instance vast itself puts the address and the external port
      # into the environment; on a VM these variables may not arrive, and then
      # the address is given as PUBLIC_URL.
      local mapped_var="VAST_TCP_PORT_${PORT}"
      local mapped="${!mapped_var:-}"
      if [ -z "${PUBLIC_URL:-}" ]; then
        [ -n "${PUBLIC_IPADDR:-}" ] && [ -n "$mapped" ] \
          || die "COLLOQ_TUNNEL=direct needs PUBLIC_URL=http://<ip>:<port>, or PUBLIC_IPADDR and $mapped_var (Vast sets both for -p ${PORT}:${PORT})."
        PUBLIC="http://${PUBLIC_IPADDR}:${mapped}"
      fi ;;
    none)
      PUBLIC="${PUBLIC_URL:-http://localhost:${PORT}}" ;;
    *) die "unknown COLLOQ_TUNNEL=$MODE (auto, relay, cloudflare, direct, none)" ;;
  esac
  # An explicit PUBLIC_URL beats the computed one: the operator knows more
  # about their proxy than we know about the vast variables.
  if [ -n "${PUBLIC_URL:-}" ] && [ "$MODE" != none ]; then PUBLIC="$PUBLIC_URL"; fi
}

# The tunnel lines go to the container log with a prefix, and to a file: we
# wait for the confirmation by the file. `> >(…)` leaves in $! the number of
# the tunnel itself, not of tee.
start_relay() {
  local conf="$RUN_DIR/frpc.toml" sub host
  host="$(relay_hostname)"
  sub="${host%".$RELAY_DOMAIN"}"
  # The relay secret goes into a 0600 file in the container directory, not
  # into the arguments (ps sees the command line) and not into the state
  # directory (it travels in backups).
  (umask 077; cat > "$conf" <<CONF
serverAddr = "${RELAY_ADDR}"
serverPort = ${RELAY_PORT:-7000}
auth.method = "token"
auth.token = "${RELAY_TOKEN}"
log.to = "console"
log.level = "info"
# The container log is not a terminal: color escape codes there are just junk.
log.disablePrintColor = true
# Ready connections to the relay: the bell brings the whole group at once, and
# without a reserve every first request waits for a connection to be set up
# (see scripts/host.sh).
transport.poolCount = 5
# The first login failed: do not exit, keep trying: the relay may have
# blinked, and there is nobody but us to start frpc again.
loginFailExit = false

[[proxies]]
name = "${sub}"
type = "http"
localIP = "127.0.0.1"
localPort = ${PORT}
subdomain = "${sub}"
CONF
  )
  : > "$TUNNEL_LOG"
  frpc -c "$conf" > >(tee -a "$TUNNEL_LOG" | sed -u 's/^/[frpc] /') 2>&1 &
  TUNNEL_PID=$!
  # A relay refusal is not the death of the container: the server comes up
  # anyway (it can be reached through ssh -L), and frpc is taken down and
  # restarted by the loop in serve with a growing pause. A taken name heals
  # itself this way: the previous machine leaves, and the next attempt gets the
  # name. The lines are the ones frpc 0.71 prints (checked on a live relay, see
  # scripts/host.sh).
  local i
  for i in $(seq 1 30); do
    if grep -q 'start proxy success' "$TUNNEL_LOG" 2>/dev/null; then say "relay tunnel is up: $PUBLIC"; return 0; fi
    if grep -q 'already exists' "$TUNNEL_LOG" 2>/dev/null; then
      warn "$host is taken on the relay: this class is open from another machine. Will retry."
      kill -TERM "$TUNNEL_PID" 2>/dev/null || true
      return 0
    fi
    if grep -qiE 'authorization failed|authentication failed|token in login doesn' "$TUNNEL_LOG" 2>/dev/null; then
      warn "the relay did not accept RELAY_TOKEN. Will retry."
      kill -TERM "$TUNNEL_PID" 2>/dev/null || true
      return 0
    fi
    kill -0 "$TUNNEL_PID" 2>/dev/null || { warn "frpc exited before the tunnel opened"; return 0; }
    sleep 1
  done
  warn "no answer from the relay in 30 s; frpc keeps trying"
}

start_cloudflare() {
  : > "$TUNNEL_LOG"
  if [ -n "${CLOUDFLARE_TUNNEL_TOKEN:-}" ]; then
    # The token goes as the cloudflared environment variable (TUNNEL_TOKEN),
    # not as an argument.
    TUNNEL_TOKEN="$CLOUDFLARE_TUNNEL_TOKEN" cloudflared tunnel --no-autoupdate run \
      > >(tee -a "$TUNNEL_LOG" | sed -u 's/^/[cloudflared] /') 2>&1 &
    TUNNEL_PID=$!
    say "named Cloudflare tunnel started for $PUBLIC"
    return 0
  fi
  cloudflared tunnel --no-autoupdate --url "http://127.0.0.1:${PORT}" \
    > >(tee -a "$TUNNEL_LOG" | sed -u 's/^/[cloudflared] /') 2>&1 &
  TUNNEL_PID=$!
  local i url=""
  for i in $(seq 1 60); do
    url="$(grep -oE 'https://[a-z0-9-]+\.trycloudflare\.com' "$TUNNEL_LOG" 2>/dev/null | head -1 || true)"
    [ -n "$url" ] && break
    kill -0 "$TUNNEL_PID" 2>/dev/null || break
    sleep 1
  done
  if [ -n "$url" ]; then
    PUBLIC="$url"
    say "quick Cloudflare tunnel is up: $PUBLIC (random address; it changes when the tunnel restarts)"
  else
    warn "the quick Cloudflare tunnel gave no address in 60 s; links will say ${PUBLIC:-localhost} until it does"
  fi
}

TUNNEL_SINCE=0
start_tunnel() {
  TUNNEL_PID=""
  TUNNEL_SINCE=$SECONDS
  case "$MODE" in
    relay) start_relay ;;
    cloudflare) start_cloudflare ;;
    *) : ;;
  esac
}

# The static mirror on the relay (scripts/relay-assets.py): otherwise every
# byte of /assets travels through the tunnel to everyone who comes. Not a
# refusal if it fails: without the mirror the class goes on, only slower. The
# header with the secret comes from a file (`-H @file`), not as an argument.
upload_relay_assets() {
  [ "$MODE" = relay ] || return 0
  local host archive hdr code dirs=()
  host="$(relay_hostname)"
  for d in assets fonts pdf; do [ -d "$APP/web/dist/$d" ] && dirs+=("$d"); done
  [ "${#dirs[@]}" -gt 0 ] || return 0
  archive="$RUN_DIR/assets.tgz"; hdr="$RUN_DIR/relay-header"
  tar -czf "$archive" --exclude '.*' -C "$APP/web/dist" "${dirs[@]}"
  (umask 077; printf 'Authorization: Bearer %s\n' "$RELAY_TOKEN" > "$hdr")
  code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 180 --upload-file "$archive" \
    -H @"$hdr" -H 'Content-Type: application/gzip' \
    "https://${host}/.relay/assets/${host}" || true)"
  rm -f "$archive" "$hdr"
  case "$code" in
    200) say "static files mirrored on the relay" ;;
    404|000) say "the relay has no static mirror; static files go through the tunnel" ;;
    *) warn "could not mirror static files on the relay (HTTP $code); they go through the tunnel" ;;
  esac
}

# ------------------------------------------------------------ room kernels
#
# The image of the default environment (and KERNEL_PRELOAD, comma-separated)
# before the first class, not on the first Run. The order of sources:
#
#   1. already in the host docker: do nothing (re-creating the machine from the
#      image does not touch the images, let alone a colloq-vast update);
#   2. KERNEL_IMAGE_REPO: pull the published release image
#      (<repo>:<tag>-<environment>, as scripts/release-build.py names them) and
#      name it colloq-kernel:<environment>, as pool.ts expects;
#   3. build from the context that lies in the image, with the same docker call
#      as the panel (environments.ts · buildCommand) and the CLI
#      (launch-prepare.ts).
#
# The `# colloq: from <parent>` chain is walked from the root to the leaf, as
# in the panel: gpu stands on base-gpu, and torch with CUDA is installed once.
env_file_for() {
  local name="$1"
  if [ -f "$STATE/environments/$name.txt" ]; then printf '%s' "$STATE/environments/$name.txt"
  elif [ -f "$APP/kernel/environments/$name.txt" ]; then printf '%s' "$APP/kernel/environments/$name.txt"
  fi
}

chain_of() {
  local name="$1" chain=() parent file i=0
  while [ -n "$name" ] && [ "$i" -lt 8 ]; do
    file="$(env_file_for "$name")"
    [ -n "$file" ] || { warn "no environment called \"$name\""; return 1; }
    chain=("$name" "${chain[@]}")
    parent="$(sed -nE 's/^[[:space:]]*#[[:space:]]*colloq:[[:space:]]*from[[:space:]]+([^[:space:]]+)[[:space:]]*$/\1/p' "$file" | head -1)"
    name="$parent"; i=$((i + 1))
  done
  printf '%s\n' "${chain[@]}"
}

kernel_context() {
  # Our own environments on top of the shipped ones, as a copy, the way the
  # server does it (environments.ts · buildContext): the docker context is one
  # directory.
  if compgen -G "$STATE/environments/*.txt" >/dev/null; then
    local staged="$STATE/.colloq/kernel-context/_boot"
    rm -rf "$staged"; mkdir -p "$(dirname "$staged")"
    cp -a "$APP/kernel" "$staged"
    cp -p "$STATE"/environments/*.txt "$staged/environments/"
    printf '%s' "$staged"
  else
    printf '%s' "$APP/kernel"
  fi
}

prepare_kernels() {
  local wanted active names=() chain=() name link parent ctx file py tag args
  active="$(read_state_env KERNEL_ENV)"; active="${active:-${KERNEL_ENV:-base}}"
  wanted="${KERNEL_PRELOAD:-$active}"
  IFS=',' read -r -a names <<< "$wanted"
  for name in "${names[@]}"; do
    name="$(printf '%s' "$name" | tr -d '[:space:]')"
    [ -n "$name" ] || continue
    # The whole chain up front, not `while read … < <(…)`: docker inside the
    # loop must not share stdin with it.
    mapfile -t chain < <(chain_of "$name" || true)
    parent=""
    for link in "${chain[@]}"; do
      [ -n "$link" ] || continue
      if docker image inspect "colloq-kernel:$link" >/dev/null 2>&1; then
        parent="colloq-kernel:$link"; continue
      fi
      if [ -n "${KERNEL_IMAGE_REPO:-}" ]; then
        tag="${KERNEL_IMAGE_TAG:-v${VERSION}}-${link}"
        say "[kernels] pulling ${KERNEL_IMAGE_REPO}:${tag}"
        if docker pull -q "${KERNEL_IMAGE_REPO}:${tag}" </dev/null >/dev/null \
            && docker tag "${KERNEL_IMAGE_REPO}:${tag}" "colloq-kernel:$link"; then
          stamp_environment "$link"; parent="colloq-kernel:$link"; continue
        fi
        warn "[kernels] could not pull ${KERNEL_IMAGE_REPO}:${tag}; building \"$link\" here instead"
      fi
      ctx="$(kernel_context)"
      args=(build -f "$ctx/Dockerfile" --build-arg "KERNEL_ENV=$link")
      if [ -n "$parent" ]; then
        args+=(--build-arg "PARENT=$parent")
      else
        # The root of the chain: the Python version is named by the directive
        # in its file; no directive means the default of kernel/Dockerfile
        # itself, and we keep no second copy of the base image name here.
        file="$(env_file_for "$link")"
        py="$(sed -nE 's/^[[:space:]]*#[[:space:]]*colloq:[[:space:]]*python[[:space:]]+(3\.[0-9]+)[[:space:]]*$/\1/p' "$file" | head -1)"
        [ -z "$py" ] || args+=(--build-arg "PARENT=python:${py}-slim-bookworm")
      fi
      args+=(-t "colloq-kernel:$link" "$ctx")
      say "[kernels] building \"$link\" (the first build takes minutes; the panel works meanwhile)"
      if DOCKER_BUILDKIT=1 BUILDKIT_PROGRESS=plain docker "${args[@]}" </dev/null 2>&1 \
          | sed -u "s/^/[kernels:$link] /"; then
        stamp_environment "$link"; parent="colloq-kernel:$link"
      else
        warn "[kernels] building \"$link\" failed; rooms on it will not start. Retry from the panel (Environments → Build)."
        break
      fi
    done
  done
  say "[kernels] done; readiness: curl -s http://127.0.0.1:${PORT}/api/health"
}

# The "what was built" stamp is the same file the panel writes (environments.ts
# · ownStampFor): otherwise the panel judges the image's freshness by the time
# the list was edited, and an image pulled from the registry could look like
# "Needs rebuild".
stamp_environment() {
  local file; file="$(env_file_for "$1")"
  [ -n "$file" ] || return 0
  cp "$file" "$STATE/environments/.$1.built" 2>/dev/null || true
}

# ------------------------------------------------------------------ serve
SERVER_PID=""
PREP_PID=""
STOPPING=""

start_server() {
  # The docker backend does not need JUPYTER_TOKEN at all: every room has its
  # own token, derived from the signing key (pool.ts · roomToken). A random one
  # here only so that the server does not print the warning about the
  # well-known token from .env.example, which does not apply to this instance.
  local jt; jt="$(head -c 24 /dev/urandom | od -An -tx1 | tr -d ' \n')"
  # The tunnel secrets are needed by the entry point, not by the server: it
  # does not read them, and everything in its environment is inherited by its
  # child processes too (docker CLI, environment builds).
  (
    cd "$APP"
    exec env \
      -u RELAY_TOKEN -u CLOUDFLARE_TUNNEL_TOKEN \
      NODE_ENV=development \
      KERNEL_BACKEND=docker \
      KERNEL_ISOLATION=required \
      KERNEL_NETWORK="$NET" \
      DATA_DIR="$STATE/data" \
      WORKSPACE_DIR="$STATE/workspace" \
      WORKSPACE_HOST_DIR="$HOST_STATE/workspace" \
      DATA_HOST_DIR="$HOST_STATE/data" \
      STATIC_DIR="$APP/web/dist" \
      BIND_ADDR="${BIND_ADDR:-0.0.0.0}" \
      JUPYTER_TOKEN="$jt" \
      node server/dist/server.js
  ) &
  SERVER_PID=$!
}

wait_live() {
  local i
  for i in $(seq 1 90); do
    curl -fsS -o /dev/null --max-time 2 "http://127.0.0.1:${PORT}/api/livez" 2>/dev/null && return 0
    kill -0 "$SERVER_PID" 2>/dev/null || return 1
    sleep 1
  done
  return 1
}

on_term() {
  [ -z "$STOPPING" ] || return 0
  STOPPING=1
  say "stopping: the server saves notebooks and closes the database; room kernels keep running"
  [ -n "$SERVER_PID" ] && kill -TERM "$SERVER_PID" 2>/dev/null || true
  # The server gives itself eight seconds (SHUTDOWN_GRACE_MS); we wait with
  # a margin.
  local i
  for i in $(seq 1 25); do kill -0 "$SERVER_PID" 2>/dev/null || break; sleep 1; done
  [ -n "$PREP_PID" ] && kill -TERM "$PREP_PID" 2>/dev/null || true
  [ -n "$TUNNEL_PID" ] && kill -TERM "$TUNNEL_PID" 2>/dev/null || true
  wait "$SERVER_PID" 2>/dev/null || true
  exit 0
}

serve() {
  say "Colloq ${VERSION} (${COLLOQ_REVISION:-unknown}) — image colloq-vast"
  require_docker
  locate_self
  locate_host_state
  ensure_network
  RUN_DIR="$(mktemp -d /tmp/colloq-vast.XXXXXX)"
  TUNNEL_LOG="$RUN_DIR/tunnel.log"
  trap on_term TERM INT

  pick_mode
  start_tunnel
  set_public_url "${PUBLIC:-http://localhost:${PORT}}"

  start_server
  wait_live || die "the server did not come up; see the lines above"

  local gpus="${KERNEL_GPUS:-none}"
  say "ready: ${PUBLIC:-http://localhost:${PORT}}"
  say "  state   $STATE (host: $HOST_STATE)"
  say "  kernels one container per room on docker network $NET; GPUs: $gpus"
  say "  owner   the setup link is in the box above while nobody owns this instance;"
  say "          print it again with: docker exec <container> colloq-vast link"
  upload_relay_assets

  # No errexit: a command that fails in the middle of the preparation must
  # become a line in the log, not a background subshell killed in silence.
  (set +e; prepare_kernels) &
  PREP_PID=$!

  local backoff=5 done_pid code
  while :; do
    done_pid=""
    code=0
    if [ -n "$TUNNEL_PID" ]; then
      wait -n -p done_pid "$SERVER_PID" "$TUNNEL_PID" || code=$?
    else
      wait -n -p done_pid "$SERVER_PID" || code=$?
    fi
    [ -z "$STOPPING" ] || continue
    [ -n "$done_pid" ] || continue
    if [ "$done_pid" = "$SERVER_PID" ]; then
      # The server died: exit with its code, and docker takes care of the
      # restart (--restart unless-stopped in colloq-host): bringing the process
      # back up in a live container with a half-broken tunnel would be no more
      # honest.
      warn "the server exited with code $code"
      [ -n "$TUNNEL_PID" ] && kill -TERM "$TUNNEL_PID" 2>/dev/null || true
      exit "$code"
    fi
    # The pause grows up to a minute on consecutive failures and resets if the
    # tunnel had lived longer than five minutes before that: a relay that
    # blinked in the middle of a class must not cost a minute of waiting just
    # because there was a failure in the morning.
    [ $((SECONDS - TUNNEL_SINCE)) -lt 300 ] || backoff=5
    warn "the tunnel exited (code $code); restarting it in ${backoff}s"
    sleep "$backoff"
    backoff=$((backoff * 2 > 60 ? 60 : backoff * 2))
    local before="$PUBLIC"
    start_tunnel
    if [ -n "$PUBLIC" ] && [ "$PUBLIC" != "$before" ]; then
      set_public_url "$PUBLIC"
      say "the public address changed: $PUBLIC"
    fi
  done
}

# -------------------------------------------------------- service commands
status() {
  local body
  body="$(curl -s --max-time 10 "http://127.0.0.1:${PORT}/api/health" || true)"
  if [ -z "$body" ]; then say "the server does not answer on :${PORT}"; exit 1; fi
  printf '%s\n' "$body"
  say "kernel images on the host:"
  docker image ls colloq-kernel --format '  {{.Repository}}:{{.Tag}}  {{.Size}}  {{.CreatedSince}}' 2>/dev/null || true
  say "room containers:"
  docker ps -a --filter label=colloq.kind=room-kernel --format '  {{.Names}}  {{.Status}}' 2>/dev/null || true
  case "$body" in *'"ok":true'*) exit 0 ;; *) exit 1 ;; esac
}

link() {
  local url claimed token
  url="$(read_state_env PUBLIC_URL)"; url="${url:-http://localhost:${PORT}}"
  say "address for the class: $url"
  claimed="$(curl -s --max-time 5 "http://127.0.0.1:${PORT}/api/admin/state" || true)"
  case "$claimed" in
    *'"claimed":false'*)
      token="$(cat "$STATE/data/setup-token" 2>/dev/null || true)"
      [ -n "$token" ] && say "nobody owns this instance yet — open: $url/admin/t/$token"
      say "that link is the key to the instance: do not paste it into the class chat" ;;
    *'"claimed":true'*) say "the instance has an owner; staff sign in with their personal links" ;;
    *) warn "the server did not answer /api/admin/state" ;;
  esac
}

backup() {
  cd "$APP"
  bash scripts/backup-local.sh
  # The script's hint names the command of the pip wheel
  # (`colloq restore --legacy`), which does not exist on the VM; here the way
  # back is colloq-host.
  say "restore on a machine running this image: colloq-host restore backups/<the .db above>"
}

restore() {
  # restore.sh refuses by itself under a live server, but it asks the
  # localhost of THIS container. A one-off `docker run … restore` lives in its
  # own network namespace and will not see a running neighbor, so colloq-host
  # stops the main container before calling this.
  cd "$APP"
  exec bash scripts/restore.sh "$@"
}

install_host() {
  local into="${1:-}"
  [ -n "$into" ] && [ -d "$into" ] || die "usage: colloq-vast install-host <host directory mounted into this container>"
  install -m 0755 "$APP/deploy/vast/colloq-host" "$into/colloq-host"
  say "installed $into/colloq-host"
}

usage() {
  cat <<'USAGE'
colloq-vast — Colloq for a rented machine (room kernels on the host's Docker)

  colloq-vast serve            (default) server, tunnel, kernel images
  colloq-vast status           is this instance ready for a class
  colloq-vast link             the class address and, while unclaimed, the owner link
  colloq-vast backup           a backup into <state>/backups/ (database + files)
  colloq-vast restore [FILES]  restore a backup; only while the server is stopped
  colloq-vast install-host DIR put the host-side manager (colloq-host) into DIR
  colloq-vast version

Settings are environment variables; see deploy/vast/README.md.
USAGE
}

# ------------------------------------------------------------------ main
cmd="${1:-serve}"
[ "$#" -eq 0 ] || shift

case "$cmd" in
  version) printf '%s %s\n' "$VERSION" "${COLLOQ_REVISION:-unknown}"; exit 0 ;;
  help|-h|--help) usage; exit 0 ;;
  install-host) install_host "$@"; exit 0 ;;
esac

if [ "$(id -u)" = 0 ] && [ -z "${COLLOQ_VAST_DROPPED:-}" ]; then
  case "$cmd" in
    serve|restore) prepare_as_root full ;;
    *) prepare_as_root ;;
  esac
  drop_to_app "$cmd" "$@"
fi

case "$cmd" in
  serve) serve ;;
  status) status ;;
  link) link ;;
  backup) backup ;;
  restore) restore "$@" ;;
  *) exec "$cmd" "$@" ;;
esac
