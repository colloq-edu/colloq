#!/usr/bin/env bash
#
# Expose a seminar to the outside and get a link for the audience.
#
# The main reason this script exists at all: PUBLIC_URL. The server puts it
# into the link you copy and hand out. Leave localhost there, and the link
# opens only for you, while the whole audience gets "site can't be reached",
# and you find this out at exactly the moment thirty people are already
# sitting in the classroom. A temporary address is published without
# restarting the application.
#
# There are four transports:
#
#   ./scripts/host.sh                       quick Cloudflare tunnel, the address
#                                           is random and lives until Ctrl+C
#   COLLOQ_HOSTNAME=seminar.sleep3r.ru      named Cloudflare tunnel
#   COLLOQ_HOSTNAME=hse.colloq.ru           our own relay (frpc → frps)
#   COLLOQ_DIRECT=1 COLLOQ_HOSTNAME=…       straight from this machine, no middleman
#
# The first three are an outbound connection from here to the outside: no
# public IP and no port forwarding on the router are needed. The fourth is the
# opposite: 80 and 443 on this machine take the students themselves, caddy
# terminates TLS and hands the request to colloq on localhost. It needs a real
# public address, and it is the only one with not a single foreign node on the
# class's path.
#
# Why the fourth appeared. A Cloudflare tunnel always comes out at Cloudflare's
# edge addresses, proxying cannot be taken off them (a *.cfargotunnel.com
# record only makes sense for their proxy), and those addresses do not open
# from Russia; that is why colloq.ru has a relay of its own. But the relay is
# not free either: measured on a live class, two hundred students in one
# evening brought down a VPS with 951 MB of memory. The OS kernel killed now
# frps (209 MB), now caddy (186 MB on two hundred sockets), thirty-six times,
# every kill tore down all the tunnels at once, and the room went into
# reconnecting. The relay is a shared point of failure for every name under
# it, and a class's traffic should not go through it when the machine has a
# public address of its own.
#
# What gets installed: frpc (brew install frpc) for the relay, cloudflared for
# Cloudflare, caddy for direct mode (the script installs the last one itself).
# With no cloudflared in PATH, colloq downloads a pinned release with a
# checksum check into <state>/bin (cli/src/launch-cloudflared.ts);
# COLLOQ_CLOUDFLARED=/path names the file explicitly.
#
# The lock: only a server whose every room kernel sits in a container of its
# own goes out, which the server itself reports in the isolation field of
# /api/health (docker or broker). A link is a door: whoever gets it runs code
# on this machine, and a shared kernel behind such a door is not published by
# any transport.
#
set -euo pipefail

cd "$(dirname "$0")/.."

RED=$'\033[31m'; DIM=$'\033[2m'; BOLD=$'\033[1m'; CYAN=$'\033[36m'; OFF=$'\033[0m'
say() { printf '%s\n' "$*"; }
die() { printf '%s%s%s\n' "$RED" "$*" "$OFF" >&2; exit 1; }

# docker is not needed by every form, only by the one the script talks to
# through it: the `make up` container, to recognize it, recreate it with a new
# PUBLIC_URL and get the installation token out of its volume (see "Who
# exactly holds the port" below).
#
# There used to be an unconditional refusal "docker is not installed" here,
# and it dropped a k3s machine on the very first line: under a release the
# server and the kernels live in k3s, a rented VM may have no docker at all,
# and `make vast-up HOST=…` left the seminar without an address: the tmux
# session running this script died a second later. A local session, the
# service and `make run` do not need docker from this script either: kernels
# are the server's business, and if they do not come up, /api/health says so
# at the first step. Without docker there is simply no "container" form.
HAVE_DOCKER=""
if command -v docker >/dev/null 2>&1; then HAVE_DOCKER=1; fi

# The relay settings live in .env next to everything else. Empty means this
# instance does not use one, and Cloudflare remains.
#
# read_env is shared by all the scripts: scripts/lib.sh. A copy of its own used
# to live in three files, and in all three it cut out the spaces inside values.
. ./scripts/lib.sh

# The state is not where the application is. The directory above scripts/ is
# the application (web/dist, kernel/, these scripts), while .env, the class
# receipt and .colloq.pid lie in the STATE directory: that is COLLOQ_STATE_ROOT
# from lib.sh. In the repository it is one and the same directory, for an
# installed package they differ, and all paths below are counted from the
# state, not from "itself".
SESSION_RECEIPT="$COLLOQ_STATE_ROOT/.colloq/local-session.json"
PIDFILE="${PIDFILE:-$COLLOQ_STATE_ROOT/.colloq.pid}"

# What to call the external address receipt with (scripts/public-url-lease.mts).
#
# In the repository, the source through tsx: it is edited next to the server,
# and a build between the edit and the check is pointless. The distribution has
# neither the source nor tsx: `node --import tsx` fails there before the first
# line ("Cannot find package 'tsx'"), and the whole script used to fail with
# it: a local session was left without an address for no reason at all. So
# scripts/pack.mts puts the built cli/public-url-lease.mjs next to
# cli/launch.mjs, and if it is in place, we call plain node. The same fork, for
# the same reason, stands in the CLI: cli/src/commands/local.ts · launcher.
#
# An array, not a function: the address watcher is started in the background,
# and $! must hold the pid of node itself. With a function it would hold the
# pid of a subshell, and cleanup would kill that, leaving the watcher an
# orphan: for three more seconds it would renew the lease of an address we had
# just given up.
if [ -f cli/public-url-lease.mjs ]; then
  LEASE=(node cli/public-url-lease.mjs)
else
  LEASE=(node --import tsx scripts/public-url-lease.mts)
fi
# The class supervisor, by the same choice: built in the package, the source
# next to the repository. From here it is needed for one word, cloudflared:
# find or download it (with a checksum check) and name the path. The search
# rule lives there, one for everyone: for `colloq start --share`, for
# `colloq host` and for `make host`.
if [ -f cli/launch.mjs ]; then
  LAUNCHER=(node cli/launch.mjs)
else
  LAUNCHER=(node --import tsx cli/src/launch.ts)
fi

RELAY_DOMAIN="$(read_env RELAY_DOMAIN)"
RELAY_ADDR="$(read_env RELAY_ADDR)"
RELAY_PORT="$(read_env RELAY_PORT)"; RELAY_PORT="${RELAY_PORT:-7000}"
RELAY_TOKEN="$(read_env RELAY_TOKEN)"

# Between the tunnels the transport is chosen by the name, not by a separate
# flag: a name under our zone can be served only by our relay, and any other
# only by Cloudflare. A flag here would be a third way of saying what the
# address has already said.
#
# Direct mode, however, is not expressed by the name at all, and that is not
# an oversight: hse.colloq.ru can be served both by the relay and by this
# machine; the difference is not in the name but in whether the machine has a
# public address. That can only be asked explicitly, so direct mode has a
# switch of its own: COLLOQ_DIRECT=1 (make host-direct HOST=…).
VIA="cloudflare"
if [ "${COLLOQ_DIRECT:-}" = "1" ] && [ "${COLLOQ_LOCAL_SESSION:-}" != 1 ]; then
  VIA="direct"
elif [ -n "${COLLOQ_HOSTNAME:-}" ] && [ -n "$RELAY_DOMAIN" ] \
   && [ "${COLLOQ_HOSTNAME%".$RELAY_DOMAIN"}" != "$COLLOQ_HOSTNAME" ]; then
  VIA="relay"
fi

case "$VIA" in
  relay)
    command -v frpc >/dev/null 2>&1 || die \
      "frpc is not installed. brew install frpc — then run this again."
    [ -n "$RELAY_ADDR" ]  || die "no RELAY_ADDR in .env — the address of the relay."
    [ -n "$RELAY_TOKEN" ] || die "no RELAY_TOKEN in .env — the shared secret of the relay."
    ;;
  direct)
    # Everything that must be checked before the first action. A refusal here
    # is cheap: there is no DNS record and no installed caddy yet.
    #
    # The name is required, and it must be a full one. Direct mode has nowhere
    # to take a default from: for the relay a short name is completed up to
    # RELAY_DOMAIN, for the quick tunnel Cloudflare hands out the name, while
    # here the name is what the certificate is issued for, and it cannot be
    # made up on a person's behalf.
    [ -n "${COLLOQ_HOSTNAME:-}" ] || die \
      "direct mode needs a name: make host-direct HOST=hse.colloq.ru"
    case "$COLLOQ_HOSTNAME" in
      *.*) : ;;
      *) die "the name must be a full one, with a dot: make host-direct HOST=hse.colloq.ru
  Only the relay completes a short name up to RELAY_DOMAIN." ;;
    esac
    printf '%s' "$COLLOQ_HOSTNAME" | grep -qE '^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$' || die \
      "the name ${COLLOQ_HOSTNAME} has something other than a-z, digits, dots and hyphens."

    # systemd is not nitpicking. Direct mode leaves behind a caddy service that
    # outlives this window; without systemd there would be nowhere to leave it,
    # and the seminar would die along with the closed terminal without a word
    # about it. A laptop (macOS) does not need this anyway: it has no public
    # address, it gets a tunnel.
    command -v systemctl >/dev/null 2>&1 || die \
      "direct mode is for a machine with systemd and a public address (a Linux server).
  There is no systemd here: from a laptop a class goes out through a tunnel —
  make host HOST=<name>."

    # 80 and 443 are privileged ports, and a systemd service is installed as root too.
    [ "$(id -u)" = "0" ] || die \
      "direct mode installs the caddy service and takes 80 and 443 — root is needed.
  Try again: sudo make host-direct HOST=${COLLOQ_HOSTNAME}"

    # python3 is needed both here (the port check) and in scripts/dns.sh, which
    # writes the record.
    command -v python3 >/dev/null 2>&1 || die \
      "no python3 — it is what checks the ports and writes the DNS record (scripts/dns.sh)."
    command -v curl >/dev/null 2>&1 || die "no curl."
    [ -x ./scripts/dns.sh ] || die "no scripts/dns.sh — it is what sets the A record for the name."
    ;;
  *)
    # Named explicitly (the supervisor passes one it has already found and
    # verified): take it as it is. Installed in PATH: the same, the fast path
    # without node. Otherwise ask the supervisor: it verifies its copy in
    # <state>/bin or downloads a pinned release, saying so in stderr, and hands
    # the path over in stdout. The checksum check lives there; from here we do
    # not run a copy of our own without it.
    CLOUDFLARED="${COLLOQ_CLOUDFLARED:-$(read_env COLLOQ_CLOUDFLARED)}"
    if [ -z "$CLOUDFLARED" ]; then CLOUDFLARED="$(command -v cloudflared 2>/dev/null || true)"; fi
    if [ -z "$CLOUDFLARED" ]; then
      CLOUDFLARED="$("${LAUNCHER[@]}" cloudflared)" || die \
        "there is no cloudflared, and colloq could not fetch it (the reason is above).
  Install it yourself (brew install cloudflared) or name the file: COLLOQ_CLOUDFLARED=/path/to/cloudflared"
    fi
    [ -x "$CLOUDFLARED" ] || die "cloudflared at ${CLOUDFLARED} is not an executable file."
    ;;
esac

# PORT is needed before the tunnel starts: that is the port cloudflared exposes.
PORT="${PORT:-$(read_env PORT)}"
PORT="${PORT:-3000}"
CLUSTER="${COLLOQ_CLUSTER:-$(read_env COLLOQ_CLUSTER)}"
if [ "${COLLOQ_LOCAL_SESSION:-}" = 1 ]; then CLUSTER=0; fi
if [ "$CLUSTER" = 1 ]; then PORT=30080; fi
LOCAL="http://127.0.0.1:${PORT}"
TUNNEL_PORT="$PORT"
LOCAL_RUN_ID=""
LEASE_FILE=""
LEASE_OWNER=""
LEASE_PID=""
if [ "$CLUSTER" != 1 ] && [ "$VIA" != direct ] && { [ "${COLLOQ_LOCAL_SESSION:-}" = 1 ] || [ -f "$SESSION_RECEIPT" ]; }; then
  if DISCOVERY="$("${LEASE[@]}" discover "$SESSION_RECEIPT")"; then
    IFS=$'\t' read -r LOCAL_RUN_ID LEASE_FILE LOCAL PORT DATA_DIR TUNNEL_PORT <<< "$DISCOVERY"
  else
    discovery_code=$?
    [ "$discovery_code" = 2 ] || die "Could not check the local session."
  fi
fi
HEALTH_LOCAL="http://127.0.0.1:${PORT}"
# Only the local origin sees this rewrite; the public Host still routes at the relay.
# Vite retains its Host protection instead of accepting every external hostname.
#
# Expanded below as ${ORIGIN_ARGS[@]+"${ORIGIN_ARGS[@]}"}, not as a bare
# "${ORIGIN_ARGS[@]}": an empty array under set -u in bash before 4.4 is an
# "unbound variable", and that is the stock /bin/bash of macOS (3.2). A
# Cloudflare tunnel without a local session (the service, `make run`, k3s)
# failed there before it could start.
ORIGIN_ARGS=()
if [ -n "$LOCAL_RUN_ID" ]; then ORIGIN_ARGS=(--http-host-header "127.0.0.1:${TUNNEL_PORT}"); fi

# A template with X's, not just a name: BSD mktemp appends a random tail by
# itself, while GNU requires "XXXXXX" in the template and fails without them
# with "too few X's". The script lives on both systems (the teacher's laptop
# and a rented machine), and wherever it failed, the seminar was left without
# an address.
LOG="$(mktemp -t colloq-tunnel.XXXXXX)"
TUNNEL_PID=""
# A temporary listener on 80 and 443 in direct mode: see the port check.
LISTEN_PID=""
LISTEN_LOG=""
# Whether we set PUBLIC_URL ourselves: see cleanup.
TOUCHED_ENV=""
# Which address we gave the k3s cluster (cluster.sh public-url): that one and
# only that one is taken down by cleanup on exit, see there.
CLUSTER_PUBLISHED=""
# Where k3s keeps the application data: the same state directory and the same
# default as in scripts/cluster.sh, backup.sh and restore.sh.
CLUSTER_STATE="${COLLOQ_STATE_DIR:-/var/lib/colloq}"

# The transports have different numbers of steps, and numbering is needed
# everywhere: by it a person understands where the script got stuck. Hence a
# counter, not a hand-written "1/4", which in direct mode would be off by two
# steps.
STEPS=4
if [ "$VIA" = direct ]; then STEPS=6; fi
STEP=0
step() { STEP=$((STEP + 1)); say "${BOLD}${STEP}/${STEPS}${OFF} $*"; }

cleanup() {
  local code=$?
  trap - EXIT INT TERM
  # The cleanup runs to the end, not to the first failure, and a closed window
  # does not cut it short. On a rented machine the script lives in tmux as
  # `host.sh | tee`: Ctrl+C kills tee as well, and the very first line of the
  # cleanup would get SIGPIPE, the shell would die without returning the
  # address; a closed session (SIGHUP) would tear cluster.sh apart halfway,
  # just as it restarts the application. Everything below is best effort with
  # `|| true` anyway; set -e here would only cut things off at output.
  set +e
  trap '' HUP PIPE
  [ -n "$LEASE_PID" ] && kill "$LEASE_PID" 2>/dev/null || true
  if [ -n "$LEASE_OWNER" ]; then
    "${LEASE[@]}" release "$LEASE_FILE" "$LOCAL_RUN_ID" "$LEASE_OWNER" || true
  fi
  [ -n "$TUNNEL_PID" ] && kill "$TUNNEL_PID" 2>/dev/null || true
  # The listener holds exactly the ports caddy needs. Not removing it means
  # breaking the certificate issuance, and silently at that.
  [ -n "$LISTEN_PID" ] && kill "$LISTEN_PID" 2>/dev/null || true
  [ -n "$LISTEN_LOG" ] && rm -f "$LISTEN_LOG" || true
  # Direct mode does not put PUBLIC_URL back, and that is not forgetfulness.
  # The link there lives not in this window but in the caddy service: it
  # survives Ctrl+C and a closed ssh alike. Returning the address to localhost
  # would mean that after the script exits a working seminar starts handing
  # out links to localhost.
  if [ "$VIA" = direct ]; then rm -f "$LOG"; exit $code; fi
  # k3s. Here the address lives not in .env but in the cluster config:
  # `cluster.sh public-url` writes it into <state>/config.env and restarts the
  # application, which reads PUBLIC_URL once, at startup. The cleanup used to
  # bypass the cluster entirely, and after Ctrl+C the panel went on handing
  # out links to a tunnel that no longer existed, while `make vast-status`
  # reported the dead address as alive.
  #
  # We take down exactly what we set, the way a local session releases only
  # its own address lease (release with the owner, above): --if-current checks
  # under the state lock that the cluster still holds our address, and leaves
  # someone else's alone. The price is an application restart, but by this
  # point the room is cut off anyway: the lines above have already closed the
  # tunnel.
  #
  # We show the reason for a failure: "could not" without it would send a
  # person guessing between the state lock (vast-sync is running), not being
  # root and a restart timeout, and in tmux these lines are the only trace in
  # host.log.
  if [ -n "$CLUSTER_PUBLISHED" ]; then
    say "${DIM}taking ${CLUSTER_PUBLISHED} off the cluster — the app restarts, up to 3 minutes${OFF}"
    local why rc
    why="$(bash scripts/cluster.sh public-url "$LOCAL" --if-current "$CLUSTER_PUBLISHED" 2>&1 >/dev/null)"
    rc=$?
    case $rc in
      0) say "${DIM}PUBLIC_URL is back at ${LOCAL}${OFF}" ;;
      4) say "${DIM}the cluster's PUBLIC_URL is not ${CLUSTER_PUBLISHED} any more — left as it is${OFF}" ;;
      *) say "${RED}could not take ${CLUSTER_PUBLISHED} off the cluster (exit ${rc}):${OFF}"
         [ -z "$why" ] || printf '%s\n' "$why" | tail -3 | sed 's/^/    /'
         say "${DIM}By hand, as root:${OFF} bash scripts/cluster.sh public-url ${LOCAL}"
         # The cluster keeps handing out the dead address, so the entry in .env
         # must name it too: by it vast-status checks the address from outside
         # and says "not answering", not "not exposed" while links to the tunnel
         # are alive.
         TOUCHED_ENV="" ;;
    esac
  fi
  # The link is dead along with the tunnel. Leaving it in .env means the next
  # `make up` without a tunnel hands the students an address that leads
  # nowhere. On k3s the application does not read .env, but `make vast-status`
  # learns from it which address the machine serves, and a dead one there
  # would be the same untruth.
  #
  # Only if we set it: a refusal at the first step ("the instance is
  # unhealthy", "the relay refused") is no reason to rewrite someone else's
  # setting that we have not touched yet. And only if the file still holds OUR
  # address: a second `make host` started on top has rewritten it with its
  # own, and putting localhost back over someone else's live tunnel would
  # break their links.
  if [ -n "$TOUCHED_ENV" ] && [ -f "$ENV_FILE" ] && [ "$(read_env PUBLIC_URL)" = "${PUBLIC:-}" ]; then
    restore_public_url
    # Putting the line back into .env is not enough for whoever reads it only
    # once, at startup.
    #
    # The container: there is no file inside at all, PUBLIC_URL is baked into
    # the environment by `docker compose up -d app` at the second-to-last step.
    # Without recreating it the panel keeps handing out links to a tunnel that
    # no longer exists, and only the person the link was sent to sees it.
    #
    # The service: nothing. The server on the host rereads .env by itself, at
    # least once every two seconds (readPublicUrl in server/src/config.ts), and
    # for it the file wins over the environment from EnvironmentFile. A restart
    # here would only tear down the sockets of the whole room, including on the
    # Ctrl+C by which the tunnel is normally closed.
    #
    # A server started through `make run` is not touched either: it was started
    # by hand, and it must not be taken down silently behind someone's back. It
    # rereads the address from the same place.
    #
    # The cluster: already said above; .env is only a record for it, and
    # cluster.sh reported the address taken down a line above.
    case "${WHO:-}" in
      container) PUBLIC_URL="$LOCAL" docker compose up -d app >/dev/null 2>&1 || true ;;
    esac
    [ "${WHO:-}" = cluster ] || say "${DIM}PUBLIC_URL is back at ${LOCAL}${OFF}"
  fi
  rm -f "$LOG"
  exit $code
}
trap cleanup EXIT INT TERM

# sed -i is incompatible between macOS and GNU, so we write through a temporary file.
set_public_url() {
  local url="$1" tmp
  tmp="$(mktemp)"
  if grep -qE '^PUBLIC_URL=' "$ENV_FILE" 2>/dev/null; then
    grep -vE '^PUBLIC_URL=' "$ENV_FILE" > "$tmp"
  else
    cat "$ENV_FILE" > "$tmp" 2>/dev/null || true
  fi
  printf 'PUBLIC_URL=%s\n' "$url" >> "$tmp"
  # The content is poured into the existing .env instead of `mv` over it. The
  # difference shows where the script is run under sudo (direct mode and any
  # dedicated machine): mv from /tmp would make .env a root file with mode 600,
  # and the teacher's next `make run` could neither rewrite nor read it. The
  # file is still prepared whole in advance: it is not edited in place for a
  # single second.
  cat "$tmp" > "$ENV_FILE"
  rm -f "$tmp"
}
restore_public_url() { set_public_url "$LOCAL"; }

# Ask several resolvers: on corporate networks requests to 1.1.1.1 are cut
# every other time; measured, three dig calls in a row gave an answer, empty,
# empty.
#
# The name comes as an argument, not from a global variable: two callers ask
# from here, the "does the address answer from outside" check at the end and
# direct mode, which has to wait until the new A record reaches the public
# resolvers.
resolve_any() {
  local name="$1" r ip
  for r in 1.1.1.1 8.8.8.8 9.9.9.9; do
    ip="$(dig +short +time=2 +tries=1 "$name" "@$r" 2>/dev/null | grep -E '^[0-9.]+$' | head -1 || true)"
    [ -n "$ip" ] && { printf '%s' "$ip"; return 0; }
  done
  return 1
}

# ------------------------------------------------------------- static files outward
#
# Three directories, and all three are the same for everyone who came to the
# class. Vite stamps assets/ with a content hash (which is why they are served
# as immutable for a year), fonts/ and pdf/ change only with a deployment.
# These are exactly what is mirrored on the relay, and exactly what is
# compressed in advance.
DIST_DIRS="assets fonts pdf"

# How many built files lie WITHOUT a compressed neighbour.
#
# The threshold of a kilobyte is the same as in web/scripts/precompress.mjs:
# below it the format wrapper eats everything compression gains, and .br is
# absent there by design, not by forgetfulness.
assets_uncompressed() {
  local n=0 f
  [ -d web/dist/assets ] || { printf 0; return 0; }
  for f in web/dist/assets/*.js web/dist/assets/*.mjs web/dist/assets/*.css; do
    [ -f "$f" ] || continue
    [ "$(wc -c < "$f")" -lt 1024 ] && continue
    [ -f "$f.br" ] || n=$((n + 1))
  done
  printf '%s' "$n"
}

# The archive for the mirror: exactly the directories that exist, and nothing
# hidden.
#
# COPYFILE_DISABLE is about macOS: without it tar also puts a `._name` with
# extended attributes next to every file, and the mirror gets twice as many
# files, half of which mean nothing.
assets_tar() {
  local out="$1" dir dirs=""
  for dir in $DIST_DIRS; do
    [ -d "web/dist/$dir" ] && dirs="$dirs $dir"
  done
  [ -n "$dirs" ] || return 1
  # shellcheck disable=SC2086
  COPYFILE_DISABLE=1 tar -czf "$out" --exclude '.*' --exclude '*/.*' -C web/dist $dirs
}

# Put the static files on the relay so that it serves them itself.
#
# Without this EVERY byte of every /assets/*, /fonts/* and /pdf/* travels
# through this laptop: 598 KB compressed for everyone who arrives, over the
# same tunnel the room's sockets live on at that moment. The files are the
# same for everyone, and the relay can perfectly well serve them itself
# (scripts/relay-assets.py).
#
# A failure here is a warning, not death: the tunnel works without the mirror
# too, just slower. A relay installed before the mirror appeared answers this
# address with anything at all; that case gets a message of its own.
upload_assets() {
  local archive answer code files bytes
  archive="$(mktemp -t colloq-assets.XXXXXX)"
  answer="$(mktemp -t colloq-assets-out.XXXXXX)"
  if ! assets_tar "$archive"; then
    rm -f "$archive" "$answer"
    return 0
  fi
  code="$(curl -s -o "$answer" -w '%{http_code}' --max-time 180 \
    --upload-file "$archive" \
    -H "Authorization: Bearer ${RELAY_TOKEN}" \
    -H 'Content-Type: application/gzip' \
    "https://${COLLOQ_HOSTNAME}/.relay/assets/${COLLOQ_HOSTNAME}" || true)"
  if [ "$code" = "200" ]; then
    files="$(sed -n 's/.*"files":[ ]*\([0-9]*\).*/\1/p' "$answer")"
    bytes="$(sed -n 's/.*"bytes":[ ]*\([0-9]*\).*/\1/p' "$answer")"
    say "${DIM}    mirror on the relay: ${files:-?} files, $(( ${bytes:-0} / 1024 )) KB —${OFF}"
    say "${DIM}    students take the static files from it, not through this laptop${OFF}"
  elif [ "$code" = "404" ] || [ "$code" = "000" ]; then
    say "${DIM}    the relay has no static mirror: it was installed before the mirror${OFF}"
    say "${DIM}    appeared. Update it: make relay-setup WHERE=root@<address>${OFF}"
    say "${DIM}    The class runs anyway — every static file goes through this laptop.${OFF}"
  else
    say "${RED}    could not upload the static files to the relay (HTTP ${code})${OFF}"
    head -c 200 "$answer" >&2 2>/dev/null || true
    printf '\n' >&2
    say "${DIM}    Not fatal: the files go through the tunnel, as before.${OFF}"
  fi
  rm -f "$archive" "$answer"
}

# ---------------------------------------------------------------- start

step "checking colloq at ${LOCAL}"
#
# Start nothing if it is already running. This is not thrift but a fix:
# `docker compose up -d` recreates the kernel too, from the main compose file,
# without the dev override. The override publishes 8888 on the host and mounts
# ./workspace, and a server started by hand lives on exactly that. One such
# rebuild, and the kernel stops starting while the terminal stays silent,
# though the container is "healthy".
#
#
# /api/health answers 200 only when the database can be read and Jupyter
# responds, so "not answering" here means both "nobody is there" and "someone
# is, but a seminar cannot be held"; curl -sf counts the second as a failure
# too, and rightly so.
#
# The response body is not thrown away: it holds the isolation field, by which
# it is decided below whether the door may be opened at all.
HEALTH_BODY=""
if HEALTH_BODY="$(curl -sf --max-time 5 "$HEALTH_LOCAL/api/health" 2>/dev/null)"; then
  say "${DIM}    already running — touching nothing${OFF}"
elif [ "$CLUSTER" = 1 ]; then
  die "k3s application is not ready at $LOCAL. Inspect: bash scripts/cluster.sh status; bash scripts/cluster.sh logs"
elif { command -v systemctl >/dev/null 2>&1 && systemctl is-active --quiet colloq 2>/dev/null; } \
     || { [ -f "$PIDFILE" ] && kill -0 "$(cat "$PIDFILE" 2>/dev/null)" 2>/dev/null; }; then
  #
  # The server on the host is alive (as a service or by hand) but does not
  # consider itself healthy. Almost always that is Docker switched off or a
  # kernel environment that was never built. Running `docker compose up` here
  # is not allowed: it would bring up app as well, and the port would get a
  # second Colloq with a different database on top of the first. That was the
  # "third switch-over": three different instances in one morning.
  #
  die "colloq at ${LOCAL} is running, but is not ready to hold a class — usually that
  is Docker switched off or a kernel environment that was never built
  (make env-build NAME=<environment>).
  Check: curl -s ${LOCAL}/api/health"
else
  #
  # We start nothing ourselves, and this is a fix that was paid for dearly.
  #
  # There used to be `docker compose up -d` here, and it brought up the WHOLE
  # stack, including `app`. It was enough for health to answer with a failure
  # for a second (for instance, because the kernel was switched off), and next
  # to the server already running on the host a second Colloq came up in a
  # container. Both are full Yjs authorities, both write into one database
  # (after the move to bind mounts, literally the same one), and the browser
  # lands now on one, now on the other: the notebook is now half empty, now
  # has doubled cells, and the socket reconnects without end.
  #
  # The tunnel is about showing an already running instance to the outside. It
  # should not decide for a person which of the two ways of starting they
  # need.
  #
  say "${RED}    nobody answers at ${LOCAL}${OFF}"
  # The advice must be doable on the machine where it was read.
  #
  # There used to be "make up / make run / make service-install" here: three
  # targets of a Makefile that colloq installed through pip does not have at
  # all. And this line fires precisely on `colloq host`, the command by which
  # a class gets its link. A person read the advice, typed make and got
  # "command not found" as a second refusal in a row. The targets remain, but
  # only where there is a Makefile, and that is visible by the same sign by
  # which the script already chooses directories.
  if [ "${COLLOQ_STATE_ROOT}" = "." ] || [ -f "$PWD/Makefile" ]; then
    die "start the class first — colloq start (or make up for everything in
  docker, make service-install on a dedicated machine), then try again."
  fi
  die "start the class first — colloq start — then try again."
fi

# The publishing lock: before the first action toward the outside, the same for
# all forms.
#
# The author's decision: only a class where every room's kernel sits in a
# container of its own goes onto the internet. Whoever gets the link runs code
# on this machine; a shared kernel behind such a door is someone else's code
# next to the notebooks of the whole class, and no transport cures that. We
# judge not by .env (for a local class the supervisor sets docker itself
# anyway) but by the server's answer: it sets the isolation field only when
# the kernel check has passed, that is, the docker daemon or the broker
# answered (server/src/app.ts · roomIsolation). No field means a server older
# than this check or a backend without isolation, and in both cases there is
# nothing to publish.
#
# A strict comparison by string, without jq: JSON.stringify writes without
# spaces, and this script gets by with what a bare machine has.
case "$HEALTH_BODY" in
  *'"isolation":"docker"'* | *'"isolation":"broker"'*) : ;;
  *) die "not publishing: the server at ${LOCAL} does not confirm that every room
  runs in a container of its own (the isolation field of /api/health).
  A public link lets anyone who has it run code on this machine, so a class
  goes online only with room kernels in Docker, one container per room
  (KERNEL_BACKEND=docker and Docker running), or behind the runtime broker.
  Check: curl -s ${LOCAL}/api/health — restart or update colloq if the field is missing." ;;
esac

# Who exactly holds the port. There are four cases, and all four are real:
#
#   service     — systemd on a dedicated machine: the server on the host, only
#                 the room kernels in docker. That is how a rented machine is
#                 set up, and any machine where classes run;
#   container   — `make up`, the whole application in docker;
#   host        — `make run`, the server on the machine, the kernel in docker.
#                 That is how the project is run while the code is edited, and
#                 .colloq.pid is its receipt;
#   other       — something else. The tunnel will stand in front of it too, but
#                 nobody will fix its PUBLIC_URL, and that has to be said out
#                 loud.
#
# The order of checks is not alphabetical but by how reliable the sign is. The
# service is asked first: on a machine under the service there is also a
# .colloq.pid lying around from a long-ago `make run`, and a stopped app
# container, while what has to be restarted is the form that holds the port
# now. The `make run` receipt goes last for exactly that reason: a pid file
# survives both a reboot and a change of form, and speaks about the past, not
# the present.
#
# Telling them apart is a must: links to seminars are built from PUBLIC_URL,
# and a seminar handed out with a link to localhost is a seminar nobody came
# to.
WHO="other"
if [ -n "$LOCAL_RUN_ID" ]; then
  WHO="local"
elif [ "$CLUSTER" = 1 ]; then
  WHO="cluster"
elif command -v systemctl >/dev/null 2>&1 && systemctl is-active --quiet colloq 2>/dev/null; then
  WHO="service"
elif [ -n "$HAVE_DOCKER" ] && docker compose ps app --format '{{.State}}' 2>/dev/null | grep -q running; then
  WHO="container"
elif [ -f "$PIDFILE" ] && kill -0 "$(cat "$PIDFILE" 2>/dev/null)" 2>/dev/null; then
  WHO="host"
fi

# ------------------------------------------------- direct mode: no middleman
#
# Everything below works only with COLLOQ_DIRECT=1. The point of the mode in
# one sentence: there is nobody on the path from the student to this machine.
# Neither the relay, which at 951 MB of memory went down under two hundred
# sockets, nor Cloudflare, whose addresses do not open from Russia. The price:
# the machine needs a real public address and real 80 and 443 on it.

DIRECT_IP=""

# This machine's address as the outside world sees it.
#
# Ask several services in a row: any of them may be unreachable from this very
# network, and the address must not be wrong: a DNS record would send the
# whole audience to the wrong place. Cloudflare is not among them on purpose:
# its addresses do not open from Russia, and "could not find out my address"
# would be an untruth about the machine.
public_ip() {
  local url addr
  for url in https://api.ipify.org https://checkip.amazonaws.com https://ident.me https://ipinfo.io/ip; do
    addr="$(curl -s --max-time 6 "$url" 2>/dev/null | tr -d ' \r\n' || true)"
    if printf '%s' "$addr" | grep -qE '^([0-9]{1,3}\.){3}[0-9]{1,3}$'; then
      printf '%s' "$addr"
      return 0
    fi
  done
  return 1
}

# Whether this address sits directly on the machine's interface.
#
# A "no" by itself decides nothing and is not a refusal: on cloud machines
# (AWS, GCP) the public address lives on the edge router, the interface has
# only a private one, and direct mode works there perfectly well. But the same
# "no" also comes from a machine behind port forwarding, where 80 and 443 are
# not open at all. So the sign is used only as a hint to the verdict of the
# outside check, which is the real answer.
ip_is_local() {
  local want="$1"
  if command -v ip >/dev/null 2>&1; then
    ip -4 -o addr show 2>/dev/null | awk '{print $4}' | cut -d/ -f1 | grep -qx "$want"
  elif command -v ifconfig >/dev/null 2>&1; then
    ifconfig 2>/dev/null | awk '/inet /{print $2}' | grep -qx "$want"
  else
    return 1
  fi
}

# Take 80 and 443 for a while, so that there is something to connect to from
# outside.
#
# Checking "is the port open" without listening on it is impossible: a port
# closed by a firewall and a port nobody holds look the same from outside. So
# for the time of the check the ports are held by a tiny listener in python3,
# which also proves that the ports are free at all and may be taken.
listener_start() {
  LISTEN_LOG="$(mktemp -t colloq-ports.XXXXXX)"
  python3 - 80 443 >"$LISTEN_LOG" 2>&1 <<'PY' &
import socket, sys, threading

socks = []
for port in (int(a) for a in sys.argv[1:]):
    s = socket.socket()
    s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    s.bind(("", port))
    s.listen(16)
    socks.append(s)

# The word is printed only after both ports are taken: the waiting side learns
# from it that asking from outside now makes sense.
print("READY", flush=True)


def serve(sock):
    while True:
        try:
            conn, _ = sock.accept()
        except OSError:
            return
        # The checking node outside looks only at whether the connection
        # happened, but answering is still more polite: that way no torn
        # requests remain in other people's logs.
        try:
            conn.sendall(b"HTTP/1.1 204 No Content\r\nConnection: close\r\n\r\n")
        except OSError:
            pass
        conn.close()


for sock in socks:
    threading.Thread(target=serve, args=(sock,), daemon=True).start()
threading.Event().wait()
PY
  LISTEN_PID=$!
  local i
  for i in $(seq 1 25); do
    grep -q READY "$LISTEN_LOG" 2>/dev/null && return 0
    kill -0 "$LISTEN_PID" 2>/dev/null || return 1
    sleep 0.2
  done
  return 1
}

listener_stop() {
  [ -n "$LISTEN_PID" ] && kill "$LISTEN_PID" 2>/dev/null || true
  LISTEN_PID=""
}

# Ask from outside: does this machine let us in on such-and-such a port.
# Prints open, closed or unknown.
#
# We ask check-host.net: it is free, needs no keys, answers from several
# countries and, unlike most such services, opens from Russia. The shape of
# the answer was checked on live requests, not from memory: while the check is
# running, a node's value is null; a successful connection comes as
# [{"address": …, "time": …}], a refusal as [{"error": "Connection timed out"}].
ask_outside() {
  local addr="$1" port="$2" id res verdict i
  id="$(curl -s --max-time 10 -H 'Accept: application/json' \
        "https://check-host.net/check-tcp?host=${addr}:${port}&max_nodes=3" 2>/dev/null \
        | python3 -c 'import json,sys
try: print(json.load(sys.stdin).get("request_id") or "")
except Exception: print("")' 2>/dev/null || true)"
  [ -n "$id" ] || { printf 'unknown'; return 0; }
  for i in $(seq 1 12); do
    sleep 2
    res="$(curl -s --max-time 10 -H 'Accept: application/json' \
           "https://check-host.net/check-result/${id}" 2>/dev/null || true)"
    verdict="$(printf '%s' "$res" | python3 -c '
import json, sys
try:
    rows = json.load(sys.stdin)
except Exception:
    rows = None
if not isinstance(rows, dict) or not rows:
    print("wait")
else:
    vals = list(rows.values())
    done = [v for v in vals if isinstance(v, list)]
    # One node that got an answer is enough: a connection from outside
    # happened, so the port is open. "Closed", though, only when all have spoken.
    if any(v and isinstance(v[0], dict) and v[0].get("address") for v in done):
        print("open")
    elif len(done) == len(vals):
        print("closed")
    else:
        print("wait")' 2>/dev/null || printf 'wait')"
    [ "$verdict" = wait ] || { printf '%s' "$verdict"; return 0; }
  done
  printf 'unknown'
}

# Ask from outside what answers at the address on 80. Prints code:<code>,
# closed or unknown.
#
# Separate from ask_outside, because the question is different and more
# important. "The port is open" is not yet "the port is open to us": measured
# right on this machine, where the public address turned out to be a VPN exit,
# and on its 80 and 443 someone else's web server honestly answered. A TCP
# check would have said "open", the seminar name would have gone to someone
# else's machine, and the certificate would never have been issued, with
# nothing to tell why. So while the ports are held by our listener, which
# answers 204, we ask precisely for the response code: 204 means "it is us".
#
# The shape of check-host's answer for an http check, verified on a live
# request: [[1, 0.13, "OK", "200", "8.47.69.0"]], success and the code in the
# fourth field.
ask_outside_http() {
  local url="$1" id res verdict i
  id="$(curl -s --max-time 10 -H 'Accept: application/json' \
        "https://check-host.net/check-http?host=${url}&max_nodes=3" 2>/dev/null \
        | python3 -c 'import json,sys
try: print(json.load(sys.stdin).get("request_id") or "")
except Exception: print("")' 2>/dev/null || true)"
  [ -n "$id" ] || { printf 'unknown'; return 0; }
  for i in $(seq 1 12); do
    sleep 2
    res="$(curl -s --max-time 10 -H 'Accept: application/json' \
           "https://check-host.net/check-result/${id}" 2>/dev/null || true)"
    verdict="$(printf '%s' "$res" | python3 -c '
import json, sys
try:
    rows = json.load(sys.stdin)
except Exception:
    rows = None
if not isinstance(rows, dict) or not rows:
    print("wait")
else:
    vals = list(rows.values())
    done = [v for v in vals if isinstance(v, list)]
    codes = set()
    for v in done:
        row = v[0] if v and isinstance(v[0], list) else None
        if row and row[0] and len(row) > 3 and row[3]:
            codes.add(str(row[3]))
    if codes:
        print("code:" + sorted(codes)[0])
    elif len(done) == len(vals):
        print("closed")
    else:
        print("wait")' 2>/dev/null || printf 'wait')"
    [ "$verdict" = wait ] || { printf '%s' "$verdict"; return 0; }
  done
  printf 'unknown'
}

# ---------------------------------------------------------- step: ports

direct_check_ports() {
  step "checking that 80 and 443 on this machine are visible from outside"
  #
  # This is the most important check of direct mode, and that is why it comes
  # first, before the DNS record and before installing caddy.
  #
  # The certificate is issued over HTTP-01: Let's Encrypt comes to 80 by the
  # name and expects an answer from exactly this machine. No 80, no
  # certificate; no 443, no seminar. Finding this out at certificate issuance
  # means finding out late and unclearly: caddy does not fail, it silently
  # retries, and all that time the room's browsers say "unable to connect".
  #
  # The case is not made up. On a rented vast.ai machine only the forwarded ssh
  # is open to the outside: the offer has direct_port_count, but vast does not
  # give real 80 and 443 at all (verified). Direct mode is impossible there,
  # and that has to be said in words, not by failing on the certificate ten
  # minutes later.
  #
  # Colloq on 80 or 443 is the same port caddy asks for, and the two of them
  # will not fit on it together. Saying so here is cheaper than breaking an
  # already running instance by restarting caddy, which would not come up
  # anyway.
  case "$PORT" in
    80|443) die "colloq listens on ${PORT} — and direct mode needs exactly that port for caddy.
  Move the instance to another port (PORT in .env, then make run/service-restart)
  and try again." ;;
  esac

  DIRECT_IP="${COLLOQ_PUBLIC_IP:-$(public_ip || true)}"
  [ -n "$DIRECT_IP" ] || die \
    "could not find out this machine's public address: none of the services answered.
  Name it yourself: COLLOQ_PUBLIC_IP=<address> make host-direct HOST=${COLLOQ_HOSTNAME}"
  say "${DIM}    from outside this machine looks like ${DIRECT_IP}${OFF}"

  local on_iface=""
  if ip_is_local "$DIRECT_IP"; then
    on_iface=1
  else
    say "${DIM}    (it is not on an interface — this is NAT: on a cloud machine that${OFF}"
    say "${DIM}    is how it should be, behind port forwarding it is trouble)${OFF}"
  fi

  # caddy already holding the ports from a previous run is not "taken" but "we
  # took them ourselves". We do not start our own listener then: the ports are
  # open anyway, and we can ask from outside right away.
  local held_by_caddy=""
  if systemctl is-active --quiet caddy 2>/dev/null; then
    held_by_caddy=1
    say "${DIM}    caddy is already running — checking straight through it${OFF}"
  elif ! listener_start; then
    tail -3 "$LISTEN_LOG" 2>/dev/null | sed 's/^/    /' >&2 || true
    if grep -q 'Address already in use' "$LISTEN_LOG" 2>/dev/null; then
      # Who exactly holds the port is the answer; "taken" is only half of it.
      command -v ss >/dev/null 2>&1 && \
        ss -lntp 2>/dev/null | awk 'NR==1 || /:(80|443) /' >&2 || true
      die "80 or 443 on this machine are already taken — and direct mode needs exactly them.
  Stop the other web server (nginx, apache) or publish the class through a tunnel:
  make host HOST=${COLLOQ_HOSTNAME}"
    fi
    die "could not take 80 and 443 on this machine — see the error above."
  fi

  local verdict closed="" unknown="" foreign=""

  # 80 is asked more strictly than the rest: Let's Encrypt comes over it, and
  # it also shows whether this is our machine. While the port is held by our
  # listener, a 204 answer is proof; any other code means someone else sits at
  # this address outside. When the ports are held by an already running caddy,
  # we ask only for connectivity: it answers with a redirect to https, not
  # with our 204.
  if [ -n "$held_by_caddy" ]; then
    verdict="$(ask_outside "$DIRECT_IP" 80)"
  else
    case "$(ask_outside_http "http://${DIRECT_IP}/colloq-check")" in
      code:204) verdict=open ;;
      code:*)   verdict=foreign ;;
      closed)   verdict=closed ;;
      *)        verdict=unknown ;;
    esac
  fi
  case "$verdict" in
    open)    say "${DIM}    80 — open from outside, and this machine is what answers${OFF}" ;;
    foreign) say "${RED}    80 — open, but it is NOT this machine that answers${OFF}"; foreign=1 ;;
    closed)  say "${RED}    80 — closed from outside${OFF}"; closed="${closed} 80" ;;
    *)       say "${DIM}    80 — could not ask from outside${OFF}"; unknown="${unknown} 80" ;;
  esac

  # 443: connectivity only. Our temporary listener cannot do TLS, and nothing
  # smarter than "the connection happened" can be learned about this port in
  # advance.
  case "$(ask_outside "$DIRECT_IP" 443)" in
    open)   say "${DIM}    443 — open from outside${OFF}" ;;
    closed) say "${RED}    443 — closed from outside${OFF}"; closed="${closed} 443" ;;
    *)      say "${DIM}    443 — could not ask from outside${OFF}"; unknown="${unknown} 443" ;;
  esac
  [ -n "$held_by_caddy" ] || listener_stop

  # Someone else's machine at our "public" address is a separate refusal, and
  # no flag can get around it: this is not a doubt of the check but a direct
  # answer that the address is not ours.
  if [ -n "$foreign" ]; then
    die "the address ${DIRECT_IP} answers from outside, but it is not this machine.
  That is what a VPN or a proxy looks like: traffic leaves through someone else's
  box, and we took its address for ours. Pointing a class name at it means sending
  the room to that box, and the certificate never arrives at all.

  If the machine does have a public address, name it directly:
    COLLOQ_PUBLIC_IP=<address> make host-direct HOST=${COLLOQ_HOSTNAME}
  If it does not — this is a case for a tunnel:  make host HOST=${COLLOQ_HOSTNAME}"
  fi

  # A refusal must name the reason and offer a way out, not just say "no".
  #
  # COLLOQ_DIRECT_FORCE=1 lifts the refusal, and it is not a "just in case"
  # loophole: the checking service sees the machine from Germany and Finland,
  # and there are firewalls closed to half the world and open to the
  # university network. The decision is then the person's, but they have to
  # say it out loud, not find out that the script silently went on.
  if [ -n "$closed" ] && [ "${COLLOQ_DIRECT_FORCE:-}" = "1" ]; then
    say "${RED}    ports${closed} are closed from outside, but COLLOQ_DIRECT_FORCE=1 — going on${OFF}"
    say "${DIM}    If the check is right, there will be no certificate: journalctl -u caddy -f${OFF}"
    closed=""
  fi
  if [ -n "$closed" ]; then
    die "ports${closed} on ${DIRECT_IP} are closed from outside — direct mode is impossible here.
  That is how it is behind a provider firewall, behind a home router without
  forwarding and always on a rented vast.ai machine: only the forwarded ssh is
  open there, and 80 and 443 are not handed out at all.

  Publish the class through a tunnel — it goes out as an outbound connection and
  needs no open ports:  make host HOST=${COLLOQ_HOSTNAME}

  If you know for certain the ports are open and the check is lying: COLLOQ_DIRECT_FORCE=1"
  fi

  if [ -n "$unknown" ]; then
    # Asking from outside did not work: that is not a verdict on the ports but
    # the silence of the checking service. Still, "all is well" cannot be said
    # either.
    if [ -n "$on_iface" ]; then
      say "${DIM}    the checking service did not answer; the address belongs to this${OFF}"
      say "${DIM}    machine, the ports are free — going on. If 80 and 443 are closed${OFF}"
      say "${DIM}    after all, caddy gets no certificate: journalctl -u caddy -f${OFF}"
    elif [ "${COLLOQ_DIRECT_FORCE:-}" != "1" ]; then
      die "could not ask from outside, and the address ${DIRECT_IP} does not belong to this machine.
  This is NAT, and it comes in two kinds: one to one on a cloud machine — then all
  is well; port forwarding — then 80 and 443 are closed and there will be no
  certificate. Nothing here can tell them apart.

  A tunnel works in both cases:  make host HOST=${COLLOQ_HOSTNAME}
  Certain the ports are open:    COLLOQ_DIRECT_FORCE=1 make host-direct HOST=${COLLOQ_HOSTNAME}"
    fi
  fi
}

# ------------------------------------------------------------- step: name

direct_point_dns() {
  step "pointing ${COLLOQ_HOSTNAME} at ${DIRECT_IP}"
  #
  # The record is written by scripts/dns.sh, the same code that puts the whole
  # zone in order. There is no copy here on purpose: the rule "delete the
  # extra, create the missing and NEVER leave proxying on" must live in one
  # place and be fixed in one place.
  #
  # Proxying (the orange cloud) is off, and that is no minor setting: turned
  # on, it takes the students to Cloudflare's edge addresses, and those do not
  # open from Russia. Direct mode is valuable exactly because there is nobody
  # between the machine and the room; proxying would bring back a middleman,
  # and the very one we were moving away from.
  #
  ./scripts/dns.sh point "$COLLOQ_HOSTNAME" "$DIRECT_IP" || die \
    "could not set the A record ${COLLOQ_HOSTNAME} → ${DIRECT_IP}.
  CF_TOKEN (Zone:Read + DNS:Edit) is needed, and CF_ZONE in .env if the token
  cannot list the zones."

  # Wait until the name starts resolving to our address. This is not pedantry:
  # while the public resolvers hand out the old one, Let's Encrypt comes over
  # HTTP-01 to the previous address, gets refused and backs off for several
  # minutes. Half a minute of waiting here is cheaper than that pause during a
  # class.
  local seen="" i
  for i in $(seq 1 30); do
    [ "$(resolve_any "$COLLOQ_HOSTNAME" || true)" = "$DIRECT_IP" ] && { seen=1; break; }
    sleep 2
  done
  if [ -n "$seen" ]; then
    say "${DIM}    the name already resolves to ${DIRECT_IP}${OFF}"
  else
    # Not a refusal: the record's TTL is 300 seconds, and the old answer may
    # still sit in caches. caddy retries by itself, so we go on, but out loud.
    say "${DIM}    the name does not resolve here yet — the record has a 300 second TTL.${OFF}"
    say "${DIM}    The certificate may be late by those five minutes.${OFF}"
  fi
}

# ----------------------------------------------------------- step: caddy

direct_caddy() {
  step "starting caddy on this machine"
  #
  # The same approach as on the relay (scripts/relay-setup.sh): one prebuilt
  # binary instead of a repository with a key. No modules are needed here (the
  # certificate is obtained over HTTP-01), and a single file is simpler to
  # update and to understand.
  #
  local arch caddy_bin
  if ! command -v caddy >/dev/null 2>&1; then
    case "$(uname -m)" in
      x86_64|amd64) arch=amd64 ;;
      aarch64|arm64) arch=arm64 ;;
      *) die "I do not know which caddy to take for $(uname -m) — install it yourself and try again." ;;
    esac
    say "${DIM}    installing caddy (${arch})${OFF}"
    curl -fsSL -o /usr/local/bin/caddy \
      "https://caddyserver.com/api/download?os=linux&arch=${arch}" \
      || die "could not download caddy."
    chmod +x /usr/local/bin/caddy
  fi
  caddy_bin="$(command -v caddy)"

  # Someone else's config is not touched, and we check that before creating
  # the user and changing permissions on /etc/caddy. On a machine where caddy
  # already serves something, rewriting the Caddyfile would silently switch off
  # someone's site, and its owner would find out about it, not us.
  if [ -f /etc/caddy/Caddyfile ] && ! grep -q '^# colloq:' /etc/caddy/Caddyfile; then
    die "this machine already has a /etc/caddy/Caddyfile of its own — I will not overwrite it.
  Add the site to it by hand:
    ${COLLOQ_HOSTNAME} { reverse_proxy 127.0.0.1:${PORT} }
  and restart caddy."
  fi

  id -u caddy >/dev/null 2>&1 || \
    useradd --system --home /var/lib/caddy --shell /usr/sbin/nologin caddy
  install -d -o caddy -g caddy -m 0750 /var/lib/caddy /etc/caddy

  # A config for one name and nothing else. It is rewritten on every run, and
  # that is what makes the command repeatable: the name or the port changed,
  # and the file simply becomes right, without cleaning up by hand.
  cat > /etc/caddy/Caddyfile <<CONF
# colloq: direct mode (scripts/host.sh). The file is rewritten on every run,
# edits by hand will be lost; edit the script.
#
# The certificate is issued automatically on the first request: caddy goes to
# Let's Encrypt over HTTP-01 by itself, which is what the real 80 and 443 are
# needed for. No DNS key is stored on the machine, and none is needed.
${COLLOQ_HOSTNAME} {
	# WebSockets (and Colloq is WebSockets first of all: /collab and /control)
	# pass through reverse_proxy by themselves and need no separate setup.
	reverse_proxy 127.0.0.1:${PORT} {
		# The only header named out loud. caddy sets it without us too, but the
		# Secure flag on the staff cookie depends on it (server/src/admin/
		# auth.ts reads x-forwarded-proto), and a silent default is worse here
		# than an explicit line. X-Forwarded-Host is not written: caddy passes it
		# itself and complains about the extra line with a warning on every
		# config check.
		header_up X-Forwarded-Proto https
	}
}
CONF
  "$caddy_bin" fmt --overwrite /etc/caddy/Caddyfile >/dev/null 2>&1 || true
  # The validation output is held back and printed only on failure: on success
  # caddy writes several lines of JSON about adapting the config, and a person
  # who ran "expose the seminar" reads them as an error.
  local report
  if ! report="$("$caddy_bin" validate --config /etc/caddy/Caddyfile --adapter caddyfile 2>&1)"; then
    printf '%s\n' "$report" >&2
    die "caddy did not accept the config — see the error above."
  fi

  cat > /etc/systemd/system/caddy.service <<UNIT
[Unit]
Description=Caddy for colloq (direct mode)
After=network-online.target
Wants=network-online.target

[Service]
User=caddy
Group=caddy
ExecStart=${caddy_bin} run --config /etc/caddy/Caddyfile --adapter caddyfile
ExecReload=${caddy_bin} reload --config /etc/caddy/Caddyfile --adapter caddyfile --force
Restart=on-abnormal
RestartSec=3
# The right to listen on 80 and 443 without running as root. Certificates and
# keys lie in /var/lib/caddy, the home directory of the caddy user.
AmbientCapabilities=CAP_NET_BIND_SERVICE
CapabilityBoundingSet=CAP_NET_BIND_SERVICE
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
PrivateTmp=true
ReadWritePaths=/var/lib/caddy /etc/caddy

[Install]
WantedBy=multi-user.target
UNIT

  systemctl daemon-reload
  systemctl enable caddy >/dev/null 2>&1 || true
  # enable --now does not touch what is already running, and the command is
  # meant to be repeated: without an explicit restart a second run would leave
  # caddy on the old config, that is, on the previous seminar name.
  systemctl restart caddy || {
    journalctl -u caddy -n 20 --no-pager 2>/dev/null >&2 || true
    die "caddy did not start."
  }
  sleep 2
  systemctl is-active --quiet caddy || {
    journalctl -u caddy -n 20 --no-pager 2>/dev/null >&2 || true
    die "caddy started and fell over at once — the log is above."
  }
  say "${DIM}    caddy holds 443 and passes requests to ${LOCAL}${OFF}"
}

direct_publish() {
  direct_check_ports
  direct_point_dns
  direct_caddy
  PUBLIC="https://${COLLOQ_HOSTNAME}"
}

# ------------------------------------------------------------- opening the address

# Is what is about to go to the audience compressed.
#
# This has to be said BEFORE the link and before the first student: without
# .br next to assets/ the server compresses every file on every request;
# measured on the largest piece of this build, 11.6 ms of CPU time and
# 219 751 bytes instead of 194 920 for the precompressed one. That is
# multiplied by the number of people who arrive.
#
# Not a refusal: the class matters more, and it cannot be forbidden because of
# the build mode. But staying silent is not allowed either: it used to stay
# silent, and `make run` without OPTIMIZE=1 went to the audience exactly like
# that.
UNCOMPRESSED="$(assets_uncompressed)"
if [ "${UNCOMPRESSED:-0}" != 0 ]; then
  say "${RED}${UNCOMPRESSED} files in web/dist/assets have no compressed neighbour (.br)${OFF}"
  say "${DIM}    The server compresses them again on EVERY request: 11.6 ms of CPU time${OFF}"
  say "${DIM}    and an extra 25 KB per student, on the same machine where the room${OFF}"
  say "${DIM}    kernels come up.${OFF}"
  say "${DIM}    Rebuild: npm run build:optimized (make run does the same)${OFF}"
  printf '\n'
fi

if [ "$VIA" = direct ]; then
  # Three steps instead of one "opening the tunnel": check the ports, point the
  # name, bring up caddy. There is no tunnel here at all: the machine itself
  # faces the outside.
  direct_publish
elif [ "$VIA" = relay ]; then
  step "opening the tunnel to the relay"
  # The subdomain is all the instance asks of the relay: frps hands out names
  # only under its own zone, so a foreign name cannot be requested even with
  # the secret.
  SUB="${COLLOQ_HOSTNAME%".$RELAY_DOMAIN"}"
  CONF="$(mktemp -t colloq-frpc.XXXXXX)"
  # The secret goes into a file, not into arguments: the command line is
  # visible to the whole machine through ps, and the relay's shared key must
  # not show up there.
  cat > "$CONF" <<CONF
serverAddr = "${RELAY_ADDR}"
serverPort = ${RELAY_PORT}
auth.method = "token"
auth.token = "${RELAY_TOKEN}"
log.to = "console"
log.level = "info"

# A pool of ready connections to the relay.
#
# Without it every new student request waits for frpc to establish a
# connection to frps: an extra round trip over the network BEFORE the first
# byte, and it falls exactly on the bell, when the whole group opens the link
# at once. Five means five connections hanging ready; there is no point
# keeping more, beyond that the multiplexing works (tcpMux is on by default,
# and we do not touch it).
transport.poolCount = 5

# useCompression is NOT enabled here, and that is a decision, not an omission.
# What travels through this tunnel is already compressed: the server serves
# static files precompressed (.br), and since the mirror appeared (see
# upload_assets) they do not come in here at all. Compressing what is
# compressed costs the laptop CPU time for a negative gain. It is worth
# measuring again once the mirror has worked through live classes.

[[proxies]]
name = "${SUB}"
type = "http"
localIP = "127.0.0.1"
localPort = ${TUNNEL_PORT}
subdomain = "${SUB}"
CONF
  if [ -n "$LOCAL_RUN_ID" ]; then
    printf 'hostHeaderRewrite = "127.0.0.1:%s"\n' "$TUNNEL_PORT" >> "$CONF"
  fi
  chmod 600 "$CONF"
  frpc -c "$CONF" >"$LOG" 2>&1 &
  TUNNEL_PID=$!
  PUBLIC="https://${COLLOQ_HOSTNAME}"
  # Wait for confirmation from the server, not for "N seconds have passed": a
  # subdomain taken by someone or a wrong secret is a refusal that comes at
  # once, and silently going on would mean handing out a link to nowhere.
  #
  # The strings are the ones frpc actually prints. The former `proxy name .*
  # already` matched nothing: frpc 0.71 writes `start error: proxy [hse]
  # already exists`. Because of that a taken subdomain, the most common refusal
  # when the seminar is already up on another machine, was recognized not at
  # once but after thirty seconds of waiting, and was called "no answer".
  #
  # Verified on a live relay: a second frpc with the same name prints exactly
  # this line within a quarter of a second.
  #
  ok=""
  for _ in $(seq 1 30); do
    grep -q 'start proxy success' "$LOG" 2>/dev/null && { ok=1; break; }
    if grep -qE 'already exists' "$LOG" 2>/dev/null; then
      die "the subdomain ${COLLOQ_HOSTNAME} is taken — this class is open from another machine.
  Close it there or take another name: make host HOST=<name>.colloq.ru"
    fi
    if grep -qiE 'login to server failed|authorization failed|authentication failed|token in login doesn' "$LOG" 2>/dev/null; then
      die "the relay did not accept the secret. Check RELAY_TOKEN in .env."
    fi
    if grep -qiE 'start error|login to server failed' "$LOG" 2>/dev/null; then
      grep -iE 'start error|login to server failed' "$LOG" | head -3 >&2
      die "the relay refused."
    fi
    kill -0 "$TUNNEL_PID" 2>/dev/null || { cat "$LOG" >&2; die "frpc died without opening the tunnel."; }
    sleep 1
  done
  rm -f "$CONF"
  [ -n "$ok" ] || { cat "$LOG" >&2; die "no answer from the relay in 30 seconds."; }
  # The tunnel is up, so the name also has a certificate (the relay issues one
  # only to a live name), and the static files can be put in place. Precisely
  # here and not at the end: the mirror must be complete by the time the link
  # goes to the chat.
  upload_assets
elif [ -n "${COLLOQ_HOSTNAME:-}" ]; then
  step "opening the named Cloudflare tunnel"
  # A named tunnel: a permanent address, but it has to be set up once (make
  # tunnel-setup). Without that cloudflared does not know where to route.
  #
  # And we say out loud what we went through: a name under our own zone
  # without RELAY_DOMAIN in .env silently went to Cloudflare, and its addresses
  # do not open from Russia; this came out only in the classroom, where the
  # link opened for nobody.
  say "${DIM}    through Cloudflare. Your own relay (Cloudflare addresses do not${OFF}"
  say "${DIM}    open from Russia) — RELAY_* in .env, see make relay-setup${OFF}"
  "$CLOUDFLARED" tunnel --no-autoupdate run --url "$LOCAL" ${ORIGIN_ARGS[@]+"${ORIGIN_ARGS[@]}"} colloq >"$LOG" 2>&1 &
  TUNNEL_PID=$!
  PUBLIC="https://${COLLOQ_HOSTNAME}"
else
  step "opening the quick Cloudflare tunnel"
  "$CLOUDFLARED" tunnel --no-autoupdate --url "$LOCAL" ${ORIGIN_ARGS[@]+"${ORIGIN_ARGS[@]}"} >"$LOG" 2>&1 &
  TUNNEL_PID=$!
  PUBLIC=""
  # The address does not come at once and not on the first line: cloudflared
  # prints a banner first. We wait for the link itself, not for "N seconds
  # have passed".
  for _ in $(seq 1 60); do
    PUBLIC="$(grep -oE 'https://[a-z0-9-]+\.trycloudflare\.com' "$LOG" | head -1 || true)"
    [ -n "$PUBLIC" ] && break
    kill -0 "$TUNNEL_PID" 2>/dev/null || { cat "$LOG" >&2; die "cloudflared died without opening the tunnel."; }
    sleep 1
  done
  [ -n "$PUBLIC" ] || { cat "$LOG" >&2; die "no tunnel address in a minute."; }
fi

step "publishing the external address"
if [ "$WHO" != local ]; then
  set_public_url "$PUBLIC"
  TOUCHED_ENV=1
fi
case "$WHO" in
  local)
    LEASE_OWNER="${LOCAL_RUN_ID}:$$:${RANDOM}"
    "${LEASE[@]}" acquire "$LEASE_FILE" "$LOCAL_RUN_ID" "$LEASE_OWNER" "$PUBLIC" "$HEALTH_LOCAL"
    "${LEASE[@]}" watch "$LEASE_FILE" "$LOCAL_RUN_ID" "$LEASE_OWNER" "$TUNNEL_PID" "$$" "$HEALTH_LOCAL" &
    LEASE_PID=$!
    ;;
  cluster)
    # Remember it BEFORE the call: should it fail halfway, config.env may
    # already carry this address, and cleanup must know what to take down.
    CLUSTER_PUBLISHED="$PUBLIC"
    bash scripts/cluster.sh public-url "$PUBLIC"
    ;;
  service)
    # The service is NOT restarted, and this is a fix.
    #
    # There used to be `systemctl restart colloq` here with the explanation
    # "the service reads .env at startup, a new address only arrives by a
    # restart". Not true: config.publicUrl is a getter, and readPublicUrl
    # (server/src/config.ts) rereads the file at least once every two seconds,
    # the file winning over the environment variable; all links are built
    # through it on every request. The same is written in the header of
    # deploy/colloq.service. And the restart tore down all the sockets of the
    # room, most noticeably when `make host` is repeated in the middle of a
    # class because the tunnel fell over: the room went into reconnecting for
    # no reason at all.
    #
    # The wait is those same two seconds, but not blind: `/api/health` names
    # the address the server writes into links RIGHT NOW (server/src/app.ts ·
    # publicUrl), and we wait for a match, not for time to pass. There used to
    # be `sleep 3` here, the only sleep in this script that was put in not
    # because something is awaited but because there was nobody to ask.
    #
    # Without `-f`: until the kernel is up, health answers 503; that is still a
    # live server, and the address in its answer is the very one we are
    # waiting for.
    ok=""
    said=""
    blind=0
    for _ in $(seq 1 20); do
      said="$(curl -s --max-time 2 "$LOCAL/api/health" 2>/dev/null || true)"
      if printf '%s' "$said" | grep -qF "\"publicUrl\":\"${PUBLIC%/}\""; then ok=1; break; fi
      # The service may have been built before this field existed: then there
      # is nothing to ask, and the former answer remains, a live instance after
      # three seconds of rereading. Silence and "the field is there, the
      # address is different" are NOT that, and have to be waited out to the
      # end of the term.
      case "$said" in
        '' | *'"publicUrl"'*) ;;
        *)
          blind=$((blind + 1))
          if [ "$blind" -ge 3 ]; then ok=1; break; fi
          ;;
      esac
      sleep 1
    done
    [ -n "$ok" ] || {
      journalctl -u colloq -n 20 --no-pager 2>/dev/null >&2 || true
      [ -n "$said" ] || die "the service stopped answering while the address was changing. Log: make service-logs"
      die "the service answers, but writes not ${PUBLIC} into links: .env was not reread. Log: make service-logs"
    }
    say "${DIM}    the service reread .env: ${PUBLIC} (no restart, sockets intact)${OFF}"
    ;;
  container)
    PUBLIC_URL="$PUBLIC" docker compose up -d app >/dev/null
    ;;
  host)
    # Native servers reread .env on each cache refresh, just like the service.
    # The tunnel owns no application PID and must never restart it.
    ok=""
    for _ in $(seq 1 20); do
      said="$(curl -s --max-time 2 "$LOCAL/api/health" 2>/dev/null || true)"
      if printf '%s' "$said" | grep -qF "\"publicUrl\":\"${PUBLIC%/}\""; then ok=1; break; fi
      sleep 1
    done
    [ -n "$ok" ] || die "The server did not reread the external address; local work continues."
    ;;
  *)
    # Passing by silently is not allowed: the audience would get localhost, that is, nothing.
    say "${RED}    ${LOCAL} is held by some other process, not colloq.${OFF}"
    # Without docker the "container" form cannot be asked at all, and `make up`
    # here is indistinguishable from someone else's process; saying so is more
    # honest than "not colloq".
    [ -n "$HAVE_DOCKER" ] || say "${DIM}    (there is no docker here, so a make up container could not even be asked)${OFF}"
    say "${DIM}    Its PUBLIC_URL cannot be changed from here — restart it yourself with${OFF}"
    say "${DIM}    PUBLIC_URL=${PUBLIC}, or links to classes will lead to localhost.${OFF}"
    ;;
esac

step "checking that it really answers from outside"
#
# The check bypasses the system resolver. Measured on a live machine: the
# tunnel returned 200 in 0.6 seconds, while `curl https://<address>` failed
# right away with "could not resolve host": getaddrinfo held on to a negative
# answer, although dig saw the same name perfectly well. Our own check
# declared a working seminar broken.
#
# So the address is taken from a public resolver and substituted via
# --resolve: that way the tunnel is checked, not the DNS settings of this
# laptop.
host_only="${PUBLIC#https://}"

probe() {
  local ip
  if ip="$(resolve_any "$host_only")"; then
    [ "$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 --resolve "$host_only:443:$ip" "$PUBLIC/" || true)" = "200" ] && return 0
  fi
  # The system resolver as the second attempt, not the first: it is exactly the one that lies here.
  [ "$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 "$PUBLIC/" || true)" = "200" ] && return 0
  return 1
}

ok=""
for _ in $(seq 1 30); do
  probe && { ok=1; break; }
  sleep 2
done

# `colloq start --share`: the summary is printed by the supervisor, in one
# block, with the link to the class from the database, which cannot be seen
# from here (cli/src/launch-share.ts). From here it needs one marker line: the
# address is up, the check from outside passed or not. It does not reach the
# screen: the supervisor takes it.
#
# There is no link with the installation token here on purpose: a terminal
# with --share often stands on the projector, and the CLI never prints the
# token (colloq link). The panel on this computer is open at the local
# address, and the sign-in there already exists.
#
# Only for a local session: a variable forgotten in the shell must not hide
# the summary for the service or the cluster.
if [ "${COLLOQ_SHARE:-}" = 1 ] && [ "$WHO" = local ]; then
  if [ -n "$ok" ]; then say "@colloq-share ok ${PUBLIC}"; else say "@colloq-share unverified ${PUBLIC}"; fi
  wait "$TUNNEL_PID"
  exit 0
fi

#
# The token. The admin cookie is bound to the origin, and the tunnel hands out
# a new one every time, so after each `make host` the teacher ends up signed
# out and retypes thirty-two characters. Hence a link with the token, as in
# Jupyter.
#
# There are two candidates, and they differ: the container keeps the token in
# its volume, and a server started by hand in its local DATA_DIR. Guessing is
# not allowed. It took reading "the one that is running" only once, and the
# tunnel got a link from one instance while the port was held by another: 401
# and the sign-in screen instead of the panel.
#
# So we do not guess but ask the server itself: 401 is the wrong token, 200
# is the right one and the instance is claimed, 409 is the right one but the
# instance is nobody's yet. Either of the two non-empty answers will do.
token_works() {
  local code
  code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 \
    -X POST "$LOCAL/api/admin/signin/token" \
    -H 'content-type: application/json' -d "{\"token\":\"$1\"}" || true)"
  [ "$code" = "200" ] || [ "$code" = "409" ]
}

#
# k3s has a third candidate: the colloq-data volume is <state>/data on the
# host (scripts/release.py · render, deploy/k3s/README.md), that is,
# /var/lib/colloq/data if COLLOQ_STATE_DIR is not named. It used to be missing
# here, and on a k3s machine the link to the panel was printed only for
# whoever guessed to set DATA_DIR themselves, while `make vast-up` sent people
# for it exactly here, to the output of this session. It is asked first and
# checked by the same token_works.
read_setup_token() {
  local t dir dirs=()
  if [ "$CLUSTER" = 1 ]; then
    dirs=("$CLUSTER_STATE/data")
  elif [ -n "$HAVE_DOCKER" ] && docker compose ps app --format '{{.State}}' 2>/dev/null | grep -q running; then
    t="$(docker compose exec -T app cat /data/setup-token 2>/dev/null | tr -d '\r\n' || true)"
    [ -n "$t" ] && token_works "$t" && { printf '%s' "$t"; return 0; }
  fi
  dirs+=("${DATA_DIR:-$COLLOQ_STATE_ROOT/data}")
  for dir in "${dirs[@]}"; do
    t="$(cat "$dir/setup-token" 2>/dev/null | tr -d '\r\n' || true)"
    [ -n "$t" ] && token_works "$t" && { printf '%s' "$t"; return 0; }
  done
  return 1
}
SETUP_TOKEN="$(read_setup_token || true)"

printf '\n'
if [ -n "$ok" ]; then
  say "${BOLD}Colloq is available at this link${OFF}"
else
  say "${RED}The check from this machine did not go through.${OFF}"
  if [ "$VIA" = direct ]; then
    # In direct mode the suspect is different, and there is only one: the
    # certificate. We have already checked the ports from outside and pointed
    # the name; what remains is the issuance, which takes a minute, and all
    # five if the DNS has not caught up. caddy is silent to the terminal
    # meanwhile but talks to the journal, which is why we send people there.
    say "${DIM}The ports are open and the name points here — most likely the certificate${OFF}"
    say "${DIM}is still being issued: up to a minute, and up to five if the DNS record${OFF}"
    say "${DIM}has just changed. What is going on: journalctl -u caddy -f${OFF}"
  else
    # Most often it is not the tunnel but the network we check from: corporate
    # DNS or blocked outbound traffic. Students at home get in normally, so
    # scaring people with "does not work" is wrong; we have to say what exactly
    # is unclear.
    say "${DIM}The tunnel is up, but the check did not pass — usually this network's DNS${OFF}"
    say "${DIM}is to blame, not the class. Open the link from a phone on mobile internet.${OFF}"
  fi
fi
say "  ${CYAN}${BOLD}${PUBLIC}${OFF}"

if [ -n "$SETUP_TOKEN" ]; then
  printf '\n'
  say "${BOLD}Sign-in to the panel — this link is for you only${OFF}"
  say "  ${CYAN}${PUBLIC}/admin/t/${SETUP_TOKEN}${OFF}"
  # The line stands right under the link, not at the end: mistaking it for the
  # seminar address and sending it to the group chat is exactly one move, and
  # an irreversible one.
  say "  ${RED}This is the key to the instance.${OFF} ${DIM}Do not send it to a chat and do${OFF}"
  say "  ${DIM}not leave it on screen while the room is watching. Students get the${OFF}"
  say "  ${DIM}class link, which you copy from the panel.${OFF}"
else
  # A link that will not open the panel is worse than no link: a person pokes
  # at it three times before doubting the link rather than themselves.
  printf '\n'
  say "${DIM}Not printing the sign-in link for the panel: none of the setup tokens found${OFF}"
  if [ "$CLUSTER" = 1 ]; then
    # The k3s data directory is 0750 and belongs to the application's uid 1000
    # (cluster.sh · prepare): a non-root user cannot read it, hence the advice
    # goes through sudo.
    say "${DIM}suited the server at ${LOCAL}. On k3s it lies in ${CLUSTER_STATE}/data/setup-token${OFF}"
    say "${DIM}(readable by root): sudo cat it and open ${PUBLIC}/admin/t/<token>.${OFF}"
  else
    say "${DIM}suited the server at ${LOCAL}. Take it from the DATA_DIR of the server that${OFF}"
    say "${DIM}answers there and open ${PUBLIC}/admin/t/<token>.${OFF}"
  fi
fi

printf '\n'
if [ "$VIA" = direct ]; then
  # Direct mode cannot be described in words about this window: it has nothing
  # to do with it, and pretending that Ctrl+C switches something off means
  # promising a switch that does not exist. The address is held by the caddy
  # service, which survives a closed terminal, a dropped ssh and a reboot of
  # the machine alike.
  say "${DIM}Everything runs here, and the students come straight here too: caddy on${OFF}"
  say "${DIM}this machine terminates TLS and passes the request to colloq at ${LOCAL}.${OFF}"
  say "${DIM}There is no relay and no Cloudflare on this path.${OFF}"
  printf '\n'
  say "${DIM}This window can be closed: caddy is a systemd service, it lives on its own.${OFF}"
  say "${DIM}Switch the address off: ${OFF}systemctl stop caddy"
  say "${DIM}Read the log:           ${OFF}journalctl -u caddy -f"
  say "${DIM}PUBLIC_URL stays in .env: the address is alive, and rolling it back to${OFF}"
  say "${DIM}localhost is pointless — unlike a tunnel, it does not die with the script.${OFF}"
  if [ -n "$RELAY_DOMAIN" ] && [ "${COLLOQ_HOSTNAME%".$RELAY_DOMAIN"}" != "$COLLOQ_HOSTNAME" ]; then
    # This has to be said plainly: a record for a specific name is stronger
    # than the wildcard, and while it exists, the relay has nothing to do with
    # this name. Giving the name back to it means deleting the record by hand
    # (or running scripts/dns.sh, which brings the zone to the shape "wildcard
    # to the relay").
    printf '\n'
    say "${DIM}The record ${COLLOQ_HOSTNAME} → ${DIRECT_IP} stays in the zone and overrides${OFF}"
    say "${DIM}*.${RELAY_DOMAIN}: while it is there, this name leads here, not to the relay.${OFF}"
  fi
  printf '\n'
  exit 0
fi
if [ "$VIA" = relay ]; then
  say "${DIM}Everything runs here: the students' browsers go to the relay, and it goes${OFF}"
else
  say "${DIM}Everything runs here: the students' browsers go to Cloudflare, and it goes${OFF}"
fi
say "${DIM}to this window. Close it (Ctrl+C) and the link stops working, while colloq${OFF}"
say "${DIM}keeps turning locally at ${LOCAL}.${OFF}"
# About the cluster, out loud and in advance: the cleanup there is not instant
# (an application restart), and a second Ctrl+C in the middle of it would cut
# cluster.sh off halfway.
if [ -n "$CLUSTER_PUBLISHED" ]; then
  say "${DIM}On exit the address is taken off the cluster too: the app restarts with${OFF}"
  say "${DIM}PUBLIC_URL=${LOCAL} — let that finish, do not press Ctrl+C twice.${OFF}"
fi
printf '\n'

# Keep the window alive: the tunnel exists exactly as long as this process.
wait "$TUNNEL_PID"
