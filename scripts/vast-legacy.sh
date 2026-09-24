#!/usr/bin/env bash
#
# The old rental path (from before k3s releases; brought back as "legacy" on
# 13 Sep 2026): rent a machine on vast.ai, bring over the working tree and the
# latest backup from backups/<deployment>/, restore it, bring the server up as
# a systemd service (kernels in docker) and expose it through the relay. It
# needs no release.json: that is exactly why it lives next to scripts/vast.sh
# (k3s): `make vast-up` without RELEASE comes here, with RELEASE=… it takes the
# k3s path.
# Paired scripts: scripts/service-legacy.sh, scripts/restore-legacy.sh,
# deploy/colloq-legacy.service.
#
# Renting a machine on vast.ai — when you have no GPU machine of your own.
#
#   scripts/vast.sh up      find, rent, deploy Colloq on it
#   scripts/vast.sh status  what is rented, in what state and at what price
#   scripts/vast.sh sync    take the data from the rented machine to here
#   scripts/vast.sh down    destroy the machine — together with everything on it
#
# A whole class with one command:
#
#   make vast-up GPU="RTX 5070" HOST=demo.colloq.ru
#
# — rent a machine with this GPU, deploy Colloq, restore the backup of this
# deployment if there is one in backups/, and open the address to the outside.
# HOST and GPU arrive as environment variables, not arguments: that is how the
# Makefile passes them, and that way they do not get in the way of the old call
# without them.
#
# THERE CAN BE SEVERAL DEPLOYMENTS, and that means several machines:
# hse.colloq.ru and demo.colloq.ru are two rentals, two bills, two databases.
# All they share is this repository and the relay. A deployment is named with
# one word, and the same word is the first part of the address, the label on
# vast ("colloq-hse") and the backup subdirectory (backups/hse/):
#
#   make vast-up NAME=demo HOST=demo.colloq.ru
#   make vast-sync NAME=demo   ·   make vast-down NAME=demo
#   make vast-status            without a name — the list of all rented deployments
#
# The name may be left out when an address is given: it is taken from the
# first part of HOST. The name may also be left out when there is only one
# deployment: that one is taken, and this is said out loud. As soon as there
# are two, `sync` and `down` without a name refuse with a list — destroying the
# wrong machine or carrying someone else's database onto it costs more than any
# convenience.
#
# The bare label "colloq", without a name, is left over from the days of a
# single machine and counts here as the unnamed deployment: that machine must
# not be orphaned. To name it without re-creating it and without losing a
# second of the seminar: make vast-adopt NAME=<name>; at vast a label is changed
# by the call PUT instances/<id>/ with a label field, the same one that changes
# state below. `up` does this itself too, but only after proving that the
# machine is ours — see adopt_legacy.
#
# THE ADDRESS IS BROUGHT UP THERE, NOT HERE: the seminar is computed on the
# rented machine, so that machine is the one to open the tunnel to the outside.
# `make host` is a window that lives exactly as long as the tunnel does, so it
# runs in the tmux session "colloq-host": otherwise the seminar would break off
# the second the laptop was closed and the ssh session died. And what has to be
# waited for is not "tmux started" but an answer from the address itself, from
# outside: a link that does not answer yet gets handed to the audience once,
# and then half the class goes into finding out why nobody could open it.
#
# THE SERVER RUNS THERE AS A SERVICE, NOT A CONTAINER. Only the room kernels
# stay in docker on the rented machine; Colloq itself sits on the host under
# systemd (deploy/colloq.service, installed by scripts/service.sh). It was not
# always so — before that `make up` was deployed, the whole stack in docker —
# and the form was changed after two breakages, both on a dedicated machine.
# The data/ and workspace/ directories were created as root, while the server
# inside the container runs as uid 1000: the database did not open at all. And
# the panel could not build an environment: inside the container there is no
# docker-compose.yml, no kernel/Dockerfile, no .env — that is, exactly what an
# environment is built from. On the host the repository, .env and docker sit
# right next to the server, and both troubles go away together with the
# container. The price is named in the unit's header: the service runs as root.
#
# ONLY VMs, and that is not a matter of taste. vast rents out two different
# products: a docker instance (a container on someone else's machine) and a VM
# — an offer with vms_enabled=true, started from an image from
# docker.io/vastai/kvm. Colloq brings up A CONTAINER FOR EVERY ROOM itself,
# through the docker socket, and inside a docker instance vast forbids docker:
# "Docker-in-Docker is disabled for security" — their own FAQ. That is, the
# server there would not bring up a single room kernel and would silently fall
# back to a shared one, where the files of all the other rooms are visible from
# any room. The isolation that the container per room was introduced for would
# vanish exactly on someone else's machine. A VM has systemd, and with it
# docker, and everything works as at home.
#
# ONLY ON-DEMAND. Next to it lies interruptible at half the price: whoever bids
# more takes it away, without warning and at any second. That second falls in
# the middle of a class. Nothing pays back the difference in price.
#
# THE DATA ON IT IS TEMPORARY. The instance is destroyed — everything on the
# disk is gone; the balance hits zero — vast destroys it itself. So `sync` here
# is not a convenience but the second half of the job, and `down` first shows
# when the last backup was taken and asks for confirmation with a word.
#
# WHAT IS VERIFIED AND WHAT IS NOT. The offer search was run against a live
# account by reading: the vms_enabled filter, the shape of the answer and the
# offers fields are real. It is also verified that with a bad key vast answers
# HTTP 404 with the body {"error":"auth_error"} — which is why the code below
# looks at the body of the answer, not at the status code.
#
# Renting, deploying and exposing were run live once: a machine with an RTX
# 5070, the deployment at demo.colloq.ru. That run found the four places where
# it all broke — the ssh proxy that VMs do not have; mktemp without X's, which
# fails on Linux; the owner of the restored backup; a repeated run on an
# already deployed machine. All of this is fixed here, but one run is one run,
# not a proven path.
#
# Taking data (sync), destroying (down) and adopting a stray machine (adopt)
# have never been run live. All of this is paid for with real money: the first
# run is worth doing on a cheap offer and not on the day of a class.
#
# The same goes for changing the label. That at vast it is PUT
# instances/<id>/ with a label field is stated in their documentation
# (api-reference/instances/manage-instance) and can be seen from the
# neighbouring call below, which brings a stopped machine up; it was not
# checked on a live instance, because on the day of the change not a single
# machine was rented on the account (asked by reading). Parsing the answer and
# the whole adoption fork were run on a made-up vast answer — including the
# cases "the address is someone else's" and "there is nobody to ask".
#
# The VAST_TOKEN key is read from .env. It is not printed, does not go into
# command-line arguments (the whole machine sees them through `ps`) and does not
# travel to the rented machine: that machine is already paid for, the key is
# not needed there a second time.
set -euo pipefail

cd "$(dirname "$0")/.."

RED=$'\033[31m'; DIM=$'\033[2m'; BOLD=$'\033[1m'; CYAN=$'\033[36m'; OFF=$'\033[0m'
say() { printf '%s\n' "$*"; }
die() { printf '%s%s%s\n' "$RED" "$*" "$OFF" >&2; exit 1; }

# JSON is parsed by python3, not jq: macOS has no jq by default, while python3
# is already needed by scripts/dns.sh. What is parsed arrives on the function's
# stdin.
py() { python3 -c "$1"; }

# read_env is shared by all scripts, scripts/lib.sh. Here it matters most: GPU
# names in the vast API are written with a space ("RTX 4090"), and the old copy
# turned VAST_GPU from .env into "RTX4090", for which there are no offers.
. ./scripts/lib.sh

# The field separator in the instance table — see instances_tsv.
SEP=$'\037'

API=https://console.vast.ai/api/v0
CMD="${1:-}"

[ -f .env ] || die "no .env — create it: make up (or cp .env.example .env)."

# The label on the instance. By it — and only by it — the script later finds
# the rented machine: a variable in memory survives neither a closed terminal
# nor a second laptop, while the label lives on vast's side. The deployment
# name is appended to it: "colloq-hse" and "colloq-demo" are two different
# machines, and they cannot be mixed up even by accident. A bare "colloq" is
# the unnamed deployment, that very first machine.
LABEL_BASE="$(read_env VAST_LABEL)";    LABEL_BASE="${LABEL_BASE:-colloq}"

# The deployment name. It is given in three ways, and all three are the same
# word: NAME=demo, the second argument (scripts/vast.sh sync demo) or the first
# part of the address (HOST=demo.colloq.ru). Requiring NAME where HOST is
# already given would be a redundant word: the address and the deployment are
# one name, and that is checked below.
ENV_NAME="${NAME:-${2:-}}"
if [ -z "$ENV_NAME" ] && [ -n "${HOST:-}" ]; then ENV_NAME="${HOST%%.*}"; fi
# The name goes into the label on vast, into a directory path and into the
# address. Anything other than letters, digits and a hyphen inside would no
# longer be a name there: "../" would take backups out of backups/ to anywhere,
# and a dot into someone else's subdomain.
case "$ENV_NAME" in
  '') : ;;
  *[!A-Za-z0-9-]*|-*|*-)
    die "deployment name \"${ENV_NAME}\" is not valid.
  It is also the subdomain of the address and the tail of the label on vast, so
  letters, digits and a hyphen inside are allowed: NAME=demo, NAME=hse-2026." ;;
esac

# The label and the backup directory derive from the name, so they are computed
# together with it: the deployment may not have been named at all, and then
# resolve_env picks it, after asking vast.
#
# Backups are laid out by deployment: backups/hse/ and backups/demo/.
# Everything used to be dumped into backups/ in a heap, and "the latest" was
# restored — with two deployments that is a straight road to putting one
# seminar's database into another one's room. The root of backups/ stays with
# the unnamed deployment: the local `make backup` writes there too, and a named
# deployment does not see those files at all.
use_env() {
  LABEL="$LABEL_BASE${ENV_NAME:+-$ENV_NAME}"
  BACKUP_DIR="backups${ENV_NAME:+/$ENV_NAME}"
  # The tail for hints in messages. The unnamed deployment has none at all:
  # advising an empty "NAME=" would be advising a typo. A named one must have it
  # in every hint — "repeat make vast-up" without a name, with two deployments,
  # is advice that leads the wrong way.
  NAME_ARG="${ENV_NAME:+ NAME=$ENV_NAME}"
}
use_env
# The VM image. Tags in vastai/kvm are dated, there is no `latest` at all; the
# list is at hub.docker.com/r/vastai/kvm/tags.
IMAGE="$(read_env VAST_IMAGE)";         IMAGE="${IMAGE:-docker.io/vastai/kvm:ubuntu_cli_22.04-2025-11-21}"
# Disk in gigabytes. 60 is the kernel image with torch for CUDA (tens of
# gigabytes), the database and the seminar files.
DISK="$(read_env VAST_DISK)";           DISK="${DISK:-60}"
MAX_PRICE="$(read_env VAST_MAX_PRICE)"; MAX_PRICE="${MAX_PRICE:-1.0}"
# Empty means any GPU. Names in the API are written with a space: "RTX 4090".
# GPU= from the command line beats .env: the GPU is chosen for the class
# ("today we need a 5070"), not once and for all.
GPU_NAME="${GPU:-$(read_env VAST_GPU)}"
# GPU memory, GB. Below it is converted to megabytes not via 1024: a "24 GB"
# card reports 24564 MB, and a threshold of 24*1024=24576 cuts off every 4090 at
# once.
#
# The default of 24 GB applies only when no GPU is named at all. A named GPU is
# a memory choice already made: an RTX 5070 has 12 GB, and the default would
# turn a clear "I want a 5070" into "no offers" without saying what exactly cut
# them off.
GPU_RAM="$(read_env VAST_GPU_RAM)"
if [ -z "$GPU_RAM" ] && [ -z "$GPU_NAME" ]; then GPU_RAM=24; fi
GPU_RAM_TEXT="${GPU_RAM:+from $GPU_RAM GB}"; GPU_RAM_TEXT="${GPU_RAM_TEXT:-any}"
# The key is named explicitly: ~/.ssh usually holds a dozen of them, sshd cuts
# the attempt off after the fifth, and the right one is never reached.
SSH_KEY="$(read_env VAST_SSH_KEY)";     SSH_KEY="${SSH_KEY:-$HOME/.ssh/id_ed25519}"
# People write the tilde in .env the human way, but inside a string it is just
# a character to the shell: without this line the key "~/.ssh/vast" is not
# found, and the script refuses, showing a path the person sees with their own
# eyes and believes to be right.
# The tilde here is the start of a pattern, not a path to expand.
# shellcheck disable=SC2088
case "$SSH_KEY" in "~/"*) SSH_KEY="$HOME/${SSH_KEY#\~/}" ;; esac
RELAY_DOMAIN="$(read_env RELAY_DOMAIN)"
RELAY_ADDR="$(read_env RELAY_ADDR)"
# The relay secret itself is not needed here — host.sh reads it on the machine.
# We only check that the line in .env is not empty: an empty one means a tunnel
# that will not come up, and it is better to learn that before renting.
RELAY_TOKEN="$(read_env RELAY_TOKEN)"
# The same port as here: .env goes to the machine whole, and PORT in it is the
# same one. A hard-coded 3000 would lie about the instance's health with
# PORT=4000.
PORT="$(read_env PORT)";               PORT="${PORT:-3000}"

REMOTE_DIR=/opt/colloq
# The same frp that relay-setup.sh installs on the relay: frps there, frpc here.
FRP_VERSION="${FRP_VERSION:-0.71.0}"

CURLRC=""
TMPS=()
cleanup() {
  local f
  for f in "${TMPS[@]:-}"; do
    if [ -n "$f" ]; then rm -f "$f"; fi
  done
  if [ -n "$CURLRC" ]; then rm -f "$CURLRC"; fi
  return 0
}
trap cleanup EXIT INT TERM

# ------------------------------------------------------------------- key

auth() {
  local token
  token="$(read_env VAST_TOKEN)"
  [ -n "$token" ] || die "no VAST_TOKEN in .env.
  The key is created at https://cloud.vast.ai/manage-keys/ (the +New button) and
  is shown there exactly once. Put it into .env as a line VAST_TOKEN=…"
  # The secret goes into a file, not into curl's arguments: the command line is
  # visible to the whole machine through `ps`, and this key spends money. mktemp
  # creates the file with mode 0600 right away, so there is not a moment when it
  # is readable by everyone and already full.
  CURLRC="$(mktemp -t colloq-vast.XXXXXX)"
  printf 'header = "Authorization: Bearer %s"\n' "$token" > "$CURLRC"
  unset token
}

# api METHOD PATH [BODY] — prints the response body, fails on any refusal.
api() {
  local method="$1" path="$2" body="${3:-}" out code text err
  out="$(mktemp -t colloq-vast-out.XXXXXX)"
  if [ -n "$body" ]; then
    code="$(curl -s -o "$out" -w '%{http_code}' --max-time 90 -K "$CURLRC" \
      -X "$method" -H 'content-type: application/json' -d "$body" "$API/$path" || true)"
  else
    code="$(curl -s -o "$out" -w '%{http_code}' --max-time 90 -K "$CURLRC" \
      -X "$method" "$API/$path" || true)"
  fi
  text="$(cat "$out")"; rm -f "$out"
  # The status code proves nothing here: with a bad key vast answers 404 — not
  # 401 — with the body {"success":false,"error":"auth_error"}. Verified. So the
  # body decides, and the code is needed only when there is no body at all.
  err="$(printf '%s' "$text" | py '
import json, sys
try:
    d = json.load(sys.stdin)
except Exception:
    raise SystemExit
if isinstance(d, dict) and d.get("error"):
    print(d["error"], (d.get("msg") or "").replace("\n", " "))
' || true)"
  case "$err" in
    '') : ;;
    auth_error*) die "vast did not accept the key. Check VAST_TOKEN in .env: it is
  shown once, at creation, on https://cloud.vast.ai/manage-keys/" ;;
    *) die "vast refused: $err" ;;
  esac
  [ -n "$(printf '%s' "$text" | tr -d '[:space:]')" ] \
    || die "vast answered with nothing (HTTP $code). Try again in a minute."
  printf '%s' "$text"
}

# ------------------------------------------------------------- tools

need() { command -v "$1" >/dev/null 2>&1 || die "$1 is needed. $2"; }

need_tools() {
  need curl    "Every system has it — check PATH."
  need python3 "brew install python — it parses the answers of vast here."
  need ssh     "Every system has it — check PATH."
  need rsync   "brew install rsync"
  need tar     "Every system has it — check PATH."
  # The official CLI (`curl -fsSL https://vast.ai/install.sh | bash` or
  # `pip install vastai`) is not needed here: everything is done over REST. It
  # comes in handy for exactly what this script deliberately does not do itself —
  # registering an ssh key in the account; the refusal below says so.
}

# ------------------------------------------------------------------- ssh

# The host's authenticity is not checked, and that is the price of renting,
# not carelessness: the machine is new every time, while vast reuses the
# addresses and ports of its forwarders — a key saved from the previous rental
# would greet us a week later with "REMOTE HOST IDENTIFICATION HAS CHANGED" and
# cut the deployment off halfway. There is nothing to compare against. Hence
# the rule everything else obeys: nothing goes to the rented machine that
# cannot survive strangers' eyes — VAST_TOKEN first of all.
ssh_opts() {
  printf '%s' "-o BatchMode=yes -o ConnectTimeout=10 -o StrictHostKeyChecking=no \
-o UserKnownHostsFile=/dev/null -o LogLevel=ERROR -o IdentitiesOnly=yes"
}
ssh_cmd() { printf 'ssh %s -i %q -p %s' "$(ssh_opts)" "$SSH_KEY" "$INST_SSH_PORT"; }
# Word splitting is exactly what is needed here: ssh_opts returns a list of
# options, not one argument.
# shellcheck disable=SC2046
rssh() { ssh $(ssh_opts) -i "$SSH_KEY" -p "$INST_SSH_PORT" "root@$INST_SSH_HOST" "$@"; }

# ---------------------------------------------------------------- instance

INST_NAME=""; INST_ID=""; INST_STATUS=""; INST_SSH_HOST=""; INST_SSH_PORT=""
INST_DPH=""; INST_GPU=""; INST_NGPU=""; INST_START=""; INST_MSG=""

# Our instances, one line each: deployment name, id, state, ssh host, ssh port,
# $/hour, GPU, number of GPUs, start, message. With an argument — only the
# instances with that label; without one — all our deployments at once, the
# unnamed one among them (its first field is empty).
#
# The fields are separated by \037 (the "unit separator" character), not by a
# tab, and that is not pedantry. A tab is whitespace, and `read` with a
# whitespace IFS swallows leading separators and merges consecutive ones: the
# line of the unnamed deployment starts with exactly an empty field, and on the
# very first attempt to parse it the name came out as the id, the state as the
# address, the price as the GPU. Verified on a made-up vast answer: with tabs
# the deployment table falls apart on the very first line.
#
# A refusal from vast itself and "no instances" are different things, and they
# must not be confused here: from "none" the up command concludes "need to
# rent", and a silent network error would turn into a second rented machine
# next to the first. So every step is checked explicitly rather than left to
# set -e: load_instance is called in an `if` condition, where set -e does not
# apply.
instances_tsv() {
  local raw out
  raw="$(api GET "instances/")" || die "could not ask vast about the instances."
  out="$(printf '%s' "$raw" | WANT="${1:-}" BASE="$LABEL_BASE" py '
import json, os, sys
base = os.environ["BASE"]
want = os.environ.get("WANT") or ""
rows = []
for i in (json.load(sys.stdin).get("instances") or []):
    label = i.get("label") or ""
    # Other instances of this account are none of our business, and ours differ by
    # the tail of the label: "colloq" is the unnamed deployment, "colloq-hse" the
    # deployment hse.
    if label == base:
        name = ""
    elif label.startswith(base + "-"):
        name = label[len(base) + 1:]
    else:
        continue
    if want and label != want:
        continue
    # Where ssh should knock. A VM has two answers, and the first is false: the
    # ssh_host/ssh_port fields name the vast proxy (ssh5.vast.ai:31430), which is up
    # only for ordinary docker instances, and on a VM answers "connection refused"
    # for all ten minutes of waiting. The truth is in ports: the docker port map of
    # the machine, where 22/tcp points at the public address and a port of its own.
    host, port = i.get("ssh_host") or "", i.get("ssh_port") or ""
    mapped = ((i.get("ports") or {}).get("22/tcp") or [])
    direct = next((m.get("HostPort") for m in mapped if m.get("HostPort")), None)
    if direct and i.get("public_ipaddr"):
        host, port = str(i["public_ipaddr"]).strip(), str(direct)
    cols = ("dph_total", "gpu_name", "num_gpus", "start_date", "status_msg")
    cells = [name, str(i.get("id") or ""), str(i.get("actual_status") or ""),
             host, str(port)]
    cells += [str(i.get(c) if i.get(c) is not None else "") for c in cols]
    # The line is parsed on the other side with IFS and read: a newline in
    # status_msg (and it is multi-line at times) would cut off everything after it.
    rows.append("\x1f".join(
        c.replace("\x1f", " ").replace("\t", " ").replace("\n", " ") for c in cells))
print("\n".join(sorted(rows)))
')" || die "did not understand the vast answer about the instances."
  printf '%s' "$out"
}

# How many lines the deployment table has. An empty string is zero, not one.
env_count() { printf '%s\n' "$1" | grep -c . || true; }

# Finds the instance of the current deployment by label; returns 1 if there is none.
load_instance() {
  local lines line
  lines="$(instances_tsv "$LABEL")"
  [ -n "$lines" ] || { clear_instance; return 1; }
  if [ "$(env_count "$lines")" -gt 1 ]; then
    say "${DIM}more than one machine with label \"${LABEL}\" — taking the first${OFF}" >&2
  fi
  line="$(printf '%s\n' "$lines" | head -1)"
  IFS=$'\037' read -r INST_NAME INST_ID INST_STATUS INST_SSH_HOST INST_SSH_PORT \
    INST_DPH INST_GPU INST_NGPU INST_START INST_MSG <<<"$line"
  return 0
}

# "Not found" has to clean up after itself: an INST_ID left over from an
# earlier search for another deployment means ssh and rsync into a machine that
# is not ours, the most expensive typo there is.
clear_instance() {
  INST_NAME=""; INST_ID=""; INST_STATUS=""; INST_SSH_HOST=""; INST_SSH_PORT=""
  INST_DPH=""; INST_GPU=""; INST_NGPU=""; INST_START=""; INST_MSG=""
}

# What the deployment is called out loud. The unnamed one is that very first
# machine with the label "colloq": it has no name, and pretending it has one is
# not allowed.
env_title() { printf '%s' "${1:-unnamed}"; }

# The list of deployments. `status` without a name answers with it, and the
# refusal of a dangerous command ends with it: "name the deployment" without
# showing which ones exist is an invitation to guess.
print_envs() {
  local lines="$1" name id st host port dph gpu ngpu start msg s db dir title
  # Local WANT_HOST and HOST_IP: host_health reads them from the globals, and the
  # table is also printed in the middle of `up`, where the global WANT_HOST is the
  # address the whole thing is for. Overwriting it here would mean exposing the
  # wrong name.
  local WANT_HOST HOST_IP
  while IFS=$'\037' read -r name id st host port dph gpu ngpu start msg; do
    [ -n "$id" ] || continue
    s="$(spent "$start" "$dph")"
    title="$(env_title "$name")"
    # We pad the spaces ourselves: printf counts width in BYTES, and a Cyrillic
    # title ("без имени": nine characters, seventeen bytes) is not aligned by %-12s
    # at all.
    printf '  %s%s%s%*s %s%s · %s x %s · $%s/hr%s%s\n' \
      "$BOLD" "$title" "$OFF" "$(( 12 > ${#title} ? 12 - ${#title} : 0 ))" "" \
      "$DIM" "$st" "$ngpu" "$gpu" "$dph" "${s:+ · $s}" "$OFF"
    if [ -n "$name" ] && [ -n "$RELAY_DOMAIN" ]; then
      # The address is asked from outside, of the name itself, not of the machine
      # over ssh: that is exactly what a student sees, and "the instance is running"
      # says nothing about it.
      WANT_HOST="$name.$RELAY_DOMAIN"; HOST_IP=""
      if command -v dig >/dev/null 2>&1; then HOST_IP="$(resolve_host "$WANT_HOST" || true)"; fi
      if host_health; then
        printf '               %shttps://%s%s %s— answers%s\n' "$CYAN" "$WANT_HOST" "$OFF" "$DIM" "$OFF"
      else
        printf '               %shttps://%s — does not answer%s\n' "$RED" "$WANT_HOST" "$OFF"
      fi
    elif [ -z "$name" ]; then
      printf '               %sunnamed — to name it: make vast-adopt NAME=<name>%s\n' "$DIM" "$OFF"
    fi
    dir="backups${name:+/$name}"
    db="$(ls -1t "$dir"/colloq-*.db 2>/dev/null | head -1 || true)"
    if [ -n "$db" ]; then
      printf '               %sbackup here: %s%s\n' "$DIM" "$(backup_age "$db")" "$OFF"
    else
      printf '               %sno backups here%s %s(make vast-sync%s)%s\n' \
        "$RED" "$OFF" "$DIM" "${name:+ NAME=$name}" "$OFF"
    fi
  done <<<"$lines"
}

# No name was given. While there is one deployment, that is not an ambiguity
# but a redundant word: we take the one there is and say out loud which. As soon
# as there are two, "whichever comes first" turns into "the wrong one" — and
# that is when we refuse, with a list: taking the data of one deployment and
# restoring it into another must not happen under any circumstances, and
# destroying someone else's machine even less so.
resolve_env() {
  local what="$1" lines n picked
  [ -z "$ENV_NAME" ] || return 0
  lines="$(instances_tsv)"
  n="$(env_count "$lines")"
  # Nothing is rented — the deployment is unnamed, as it was before names appeared.
  [ "$n" -gt 0 ] || return 0
  if [ "$n" -gt 1 ]; then
    say "${RED}several deployments are rented — name the one to $what${OFF}" >&2
    print_envs "$lines" >&2
    die "for example: make vast-${CMD} NAME=<name>"
  fi
  picked="$(printf '%s' "$lines" | cut -d "$SEP" -f1)"
  if [ -n "$picked" ]; then
    ENV_NAME="$picked"; use_env
    say "${DIM}there is one deployment — taking \"${ENV_NAME}\"${OFF}"
  fi
  return 0
}

# Waits until the instance reaches running. A VM boots in minutes, not seconds
# — but it cannot be waited for forever: from exited, unknown and offline an
# instance never gets to running (vast says so in plain words), and it is
# billed all that time.
wait_running() {
  local id="$1" waited=0 raw st msg
  while [ "$waited" -lt 900 ]; do
    raw="$(api GET "instances/$id/")" || die "could not ask vast about instance $id."
    st="$(printf '%s' "$raw" | py '
import json, sys
print((json.load(sys.stdin).get("instances") or {}).get("actual_status") or "")')"
    case "$st" in
      running) return 0 ;;
      exited|unknown|offline)
        msg="$(printf '%s' "$raw" | py '
import json, sys
print(((json.load(sys.stdin).get("instances") or {}).get("status_msg") or "").strip().replace("\n", " "))')"
        say "${RED}    the machine stopped in \"${st}\" — it will not get to running from there${OFF}"
        if [ -n "$msg" ]; then say "${DIM}    $msg${OFF}"; fi
        die "money is spent while the instance exists. Destroy it and try again:
  make vast-down$NAME_ARG · then make vast-up$NAME_ARG" ;;
    esac
    sleep 10; waited=$((waited + 10))
  done
  die "the machine did not reach running in 15 minutes.
  To look: make vast-status$NAME_ARG · to destroy: make vast-down$NAME_ARG"
}

# How much has ticked up so far. Not a bill but an order of magnitude: vast
# counts by the second and also charges for the disk, so the number is for
# deciding "time to switch off", not for accounting.
spent() {
  # Without arguments — about the loaded instance, with them — about a line from
  # the deployment table: the calculation is the same, the data arrives from two
  # different places.
  # Exactly "-", not ":-": an empty string from the deployment table means "no
  # start", and the start of another, earlier loaded instance must not be
  # substituted for it.
  local start="${1-$INST_START}" dph="${2-$INST_DPH}"
  [ -n "$start" ] && [ -n "$dph" ] || return 0
  START="$start" DPH="$dph" NOW="$(date +%s)" py '
import os
try:
    h = (float(os.environ["NOW"]) - float(os.environ["START"])) / 3600
    print("%d h %d min — about $%.2f" % (h, (h % 1) * 60, h * float(os.environ["DPH"])))
except Exception:
    pass
' 2>/dev/null || true
}

# The most recent backup of THIS deployment's data, taken here. Both `status`
# and `down` show its date: "destroy" without this line is a blind decision. We
# look only in our own subdirectory: a neighbour's backup is worse than none
# here — it would be restored as if it were ours.
last_backup() { ls -1t "$BACKUP_DIR"/colloq-*.db 2>/dev/null | head -1 || true; }

backup_age() {
  local f="$1" when
  when="$(date -r "$f" '+%d.%m %H:%M' 2>/dev/null || true)"
  printf '%s%s' "$f" "${when:+ ($when)}"
}

# ---------------------------------------------------------------- address

# The name under which the seminar is seen from the classroom. Empty — it is
# not exposed at all: that is the old behaviour of `vast.sh up`, and it must not
# break.
WANT_HOST="${HOST:-}"
# A name without a dot is a subdomain of our zone: "demo" means demo.colloq.ru.
# With a dot it is a full name, exactly as host.sh understands it: it picks the
# transport by whether the name ends in RELAY_DOMAIN, not by a separate flag.
case "$WANT_HOST" in
  ''|*.*) : ;;
  *)
    [ -n "$RELAY_DOMAIN" ] || die "\"${WANT_HOST}\" without a dot is a subdomain, but RELAY_DOMAIN in .env is empty.
  Write the full name (HOST=demo.example.ru) or fill in RELAY_*: make relay-setup."
    WANT_HOST="$WANT_HOST.$RELAY_DOMAIN" ;;
esac
# The name travels to the rented machine inside a string that a shell parses
# there. Anything other than letters, digits, dots and hyphens would no longer
# be a name there but a second command.
case "$WANT_HOST" in
  *[!A-Za-z0-9.-]*) die "the name \"${WANT_HOST}\" has stray characters. Expected a name like demo.colloq.ru." ;;
esac
# The deployment and the address are one name, and they must not diverge. The
# deployment name is used to find the label on vast, the backup directory and
# the address that is later checked from outside; a deployment "hse" living at
# demo.colloq.ru is exactly the confusion deployments were separated to avoid.
# The refusal here is cheap: it comes before renting and before a single byte
# of data.
if [ -n "$WANT_HOST" ] && [ -n "$ENV_NAME" ] && [ "${WANT_HOST%%.*}" != "$ENV_NAME" ]; then
  die "the deployment \"${ENV_NAME}\" and the address \"${WANT_HOST}\" are different names.
  The deployment name and the first part of the address are one word. Either this:
      make vast-up NAME=${WANT_HOST%%.*} HOST=${WANT_HOST}
  or an address under the deployment name: HOST=${ENV_NAME}.${RELAY_DOMAIN:-colloq.ru}"
fi

# Six steps, seven with an address. Counted in advance: "6/7" with no seventh
# after it is worse than an honest "6/6".
STEPS=6
if [ -n "$WANT_HOST" ]; then STEPS=7; fi

TMUX_SESSION=colloq-host
HOST_IP=""

# The address is asked of public resolvers, not the system one. This was
# measured in host.sh: getaddrinfo holds on to a negative answer and declares a
# live name nonexistent. Here the same mistake costs more — it causes a refusal
# BEFORE renting.
resolve_host() {
  local r ip
  for r in 1.1.1.1 8.8.8.8 9.9.9.9; do
    ip="$(dig +short +time=2 +tries=1 "$1" "@$r" 2>/dev/null | grep -E '^[0-9.]+$' | head -1 || true)"
    if [ -n "$ip" ]; then printf '%s' "$ip"; return 0; fi
  done
  return 1
}

# Health is checked from OUTSIDE, from this machine: "localhost answers" on the
# rented one holds even with a stone-dead tunnel, that is, exactly in the case
# the check exists for. The resolver is our own — for the same reason as in the
# paragraph above.
host_health() {
  local code
  if [ -n "$HOST_IP" ]; then
    code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 \
      --resolve "$WANT_HOST:443:$HOST_IP" "https://$WANT_HOST/api/health" || true)"
    [ "$code" = 200 ] && return 0
  fi
  code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 "https://$WANT_HOST/api/health" || true)"
  [ "$code" = 200 ]
}

# Everything that can be learned about the address is learned before renting.
# The machine is billed from the first second, while "RELAY_TOKEN is not filled
# in" and "the name does not resolve" come out equally fast before and after it
# — only in the second case for money.
check_host_ready() {
  [ -n "$WANT_HOST" ] || return 0
  # The rented machine can reach the outside only through the relay: frpc is
  # installed on it, cloudflared is not, and Cloudflare's addresses do not open
  # from Russia anyway. host.sh would send a name outside our zone to Cloudflare,
  # and the tunnel would not come up at all — already on the rented machine.
  if [ -z "$RELAY_DOMAIN" ] || [ "${WANT_HOST%".$RELAY_DOMAIN"}" = "$WANT_HOST" ]; then
    die "\"${WANT_HOST}\" is not under the relay's zone${RELAY_DOMAIN:+ (\"${RELAY_DOMAIN}\")}.
  The rented machine reaches the outside only through it: cloudflared is not
  installed there, and Cloudflare's addresses do not open from Russia anyway.
  Take a name like <something>.${RELAY_DOMAIN:-colloq.ru} — or bring up the
  relay: make relay-setup."
  fi
  [ -n "$RELAY_ADDR" ]  || die "no RELAY_ADDR in .env — the address of the relay.
  make relay-setup prints it, in four lines; they are also in .env.example."
  [ -n "$RELAY_TOKEN" ] || die "no RELAY_TOKEN in .env — the shared secret of the relay.
  Without it frps on the other side will not let the tunnel in, and the address stays dead."

  if ! command -v dig >/dev/null 2>&1; then
    say "${DIM}    no dig found — not checking that the name resolves${OFF}"
  elif HOST_IP="$(resolve_host "$WANT_HOST")"; then
    say "${DIM}    $WANT_HOST → $HOST_IP${OFF}"
    # Not a refusal: anything may stand in front of the relay. But a name that
    # leads past it means a tunnel that comes up and an address that stays silent.
    if [ -n "$RELAY_ADDR" ] && [ "$HOST_IP" != "$RELAY_ADDR" ]; then
      say "${DIM}    (RELAY_ADDR in .env is $RELAY_ADDR; the name points elsewhere)${OFF}"
    fi
  else
    die "the name $WANT_HOST resolves through neither 1.1.1.1, nor 8.8.8.8, nor 9.9.9.9.
  The relay gets a record \"*.${RELAY_DOMAIN}\" — scripts/dns.sh sets it.
  Check by hand: dig +short $WANT_HOST @1.1.1.1
  Refusing before renting: the machine is billed from the first second, and no
  tunnel helps a name that does not exist."
  fi
}

# --------------------------------------------------------------- label

# Change the label of a live instance. At vast that is PUT instances/<id>/ with
# a label field — the same call that brings a stopped machine up above, and
# that matters: the instance is not re-created, the disk stays, the seminar is
# not interrupted for a second.
relabel() {
  local id="$1" to="$2"
  api PUT "instances/$id/" "$(TO="$to" py '
import json, os
print(json.dumps({"label": os.environ["TO"]}))')" >/dev/null
}

# Which address the machine serves — by its own .env. That is the only honest
# answer to "whose is it": the label may be left over from a past life, while
# PUBLIC_URL was written there by `make host` at the moment the tunnel came up.
remote_host_name() {
  local url
  [ "$INST_STATUS" = running ] && [ -n "$INST_SSH_HOST" ] && [ -f "$SSH_KEY" ] || return 1
  url="$(rssh "grep -E '^PUBLIC_URL=' $REMOTE_DIR/.env 2>/dev/null | tail -1 | cut -d= -f2-" \
    </dev/null 2>/dev/null | tr -d ' \r' || true)"
  case "$url" in
    https://*) printf '%s' "${url#https://}" ;;
    *) return 1 ;;
  esac
}

# An unnamed machine for a named deployment. The label "colloq" is left over
# from the days of a single rental, and a production deployment runs on such a
# machine right now: it must not be orphaned, and `make vast-up
# HOST=demo.colloq.ru` has to lead to it rather than rent a second one next to
# it.
#
# But it can be taken as ours only by proving that it is ours, and there is one
# proof here: the deployment name is the first part of the address, and the
# machine knows its address itself. A match — we change the label and work by
# name from then on. No match — we leave it alone: restoring our database on
# someone else's machine means losing theirs.
adopt_legacy() {
  local mine="$LABEL" addr
  [ -n "$ENV_NAME" ] || return 1
  LABEL="$LABEL_BASE"
  if ! load_instance; then LABEL="$mine"; return 1; fi
  say "${DIM}    there is an unnamed machine $INST_ID nearby (label \"${LABEL_BASE}\") — finding out whose it is${OFF}"
  if addr="$(remote_host_name)" && [ "${addr%%.*}" = "$ENV_NAME" ]; then
    say "${DIM}    it serves https://$addr — so it is the deployment \"${ENV_NAME}\"${OFF}"
    relabel "$INST_ID" "$mine"
    say "${DIM}    label \"${LABEL_BASE}\" → \"${mine}\": from now on this machine is found by name${OFF}"
    LABEL="$mine"
    load_instance || die "changed the label, but the instance is not found by it.
  Have a look at https://cloud.vast.ai/instances/"
    return 0
  fi
  if [ -n "${addr:-}" ]; then
    say "${DIM}    it serves https://$addr — that is not the deployment \"${ENV_NAME}\", leaving it alone${OFF}"
  else
    say "${RED}    could not ask it which address it serves${OFF}"
    say "${DIM}    (the machine is \"${INST_STATUS}\" or ssh does not answer). If this is the deployment${OFF}"
    say "${DIM}    \"${ENV_NAME}\" — name it rather than renting a second one: make vast-adopt NAME=${ENV_NAME}${OFF}"
  fi
  LABEL="$mine"
  clear_instance
  return 1
}

# ---------------------------------------------------------------- adopt

cmd_adopt() {
  need_tools
  auth
  [ -n "$ENV_NAME" ] || die "name the deployment: make vast-adopt NAME=demo
  That becomes the name of the machine with label \"${LABEL_BASE}\" — the one rented
  before there were several deployments."
  if load_instance; then
    die "the deployment \"${ENV_NAME}\" already exists — instance $INST_ID with label \"${LABEL}\".
  There is nothing to rename: two machines under one name are exactly the confusion."
  fi
  local mine="$LABEL" addr answer
  LABEL="$LABEL_BASE"
  load_instance || die "there is no unnamed machine (label \"${LABEL_BASE}\") on vast.ai.
  To see what is rented: make vast-status"

  printf '\n'
  say "${BOLD}name instance $INST_ID as the deployment \"${ENV_NAME}\"${OFF} ${DIM}($INST_NGPU x $INST_GPU, \$$INST_DPH/hr)${OFF}"
  say "${DIM}label \"${LABEL_BASE}\" → \"${mine}\". The machine is not re-created: the disk, the database and${OFF}"
  say "${DIM}the open tunnel stay as they are — only the name on vast's side changes.${OFF}"
  if addr="$(remote_host_name)"; then
    say "${DIM}it serves ${OFF}${BOLD}https://$addr${OFF}"
    if [ "${addr%%.*}" != "$ENV_NAME" ]; then
      say "${RED}and that is not \"${ENV_NAME}\".${OFF} ${DIM}The deployment name is the first part of the address; named otherwise,${OFF}"
      say "${DIM}you get a deployment whose backups live under one name and its address under another.${OFF}"
    fi
  else
    say "${DIM}could not ask which address it serves — the machine is \"${INST_STATUS}\"${OFF}"
    say "${DIM}or ssh is silent. The name then rests on your memory alone.${OFF}"
  fi
  if [ "${FORCE:-}" != 1 ]; then
    [ -t 0 ] || die "no terminal to ask in. FORCE=1 renames without asking."
    printf '%srename? [y/N] %s' "$BOLD" "$OFF"
    read -r answer
    case "$answer" in y|Y|д|да) : ;; *) die "not renaming." ;; esac
  fi
  relabel "$INST_ID" "$mine"
  printf '\n'
  say "${BOLD}done${OFF} ${DIM}— now: make vast-status NAME=${ENV_NAME}${OFF}"
  say "${DIM}Backups of this deployment now go to backups/${ENV_NAME}/. Those already${OFF}"
  say "${DIM}lying loose in backups/ count as backups of the unnamed deployment and will${OFF}"
  say "${DIM}not go to this machine any more. If they are its own, move them by hand:${OFF}"
  say "${DIM}    mkdir -p backups/${ENV_NAME} && mv backups/colloq-<date>* backups/${ENV_NAME}/${OFF}"
}

# ------------------------------------------------------------------- up

cmd_up() {
  need_tools
  auth
  # Renting blindly is the most expensive thing: without a name and with several
  # deployments `up` would set up yet another machine alongside, and we would
  # learn about it from the bill.
  resolve_env "deploy to"

  say "${BOLD}1/$STEPS${OFF} checking that everything is ready${ENV_NAME:+ for the deployment \"${ENV_NAME}\"}"
  # The address is checked first of all, before the keys and the balance: it is
  # the only thing whose unfitness shows without spending a second of rental.
  check_host_ready
  [ -f "$SSH_KEY" ] || die "no key $SSH_KEY.
  Create one: ssh-keygen -t ed25519 — or name your own in a VAST_SSH_KEY line in .env"
  [ -f "$SSH_KEY.pub" ] || die "there is no $SSH_KEY.pub next to $SSH_KEY — the public half."

  # The key has to be in the account BEFORE renting. On VMs the keys of a running
  # machine do not change — the vast documentation says so in plain words — that
  # is, a machine rented without a key is a machine that cannot be entered, and
  # the money for it is already being spent. Refusing now is cheaper.
  local mine keys registered
  mine="$(awk '{print $1" "$2}' "$SSH_KEY.pub")"
  keys="$(api GET "ssh/")" || die "could not ask vast about the ssh keys."
  registered="$(printf '%s' "$keys" | MINE="$mine" py '
import json, os, sys
mine = os.environ["MINE"].split()
d = json.load(sys.stdin)
for k in (d if isinstance(d, list) else (d.get("results") or [])):
    # In the answer the field is called public_key, although the documentation says key.
    v = (k.get("public_key") or k.get("key") or "").split()
    if v[:2] == mine[:2]:
        print("yes")
        break
')"
  [ -n "$registered" ] || die "the key $SSH_KEY.pub is not registered in the vast account.
  Keys are not added to a VM after it starts: a machine rented without a key is
  money spent on a box you cannot get into. Add the key at
  https://cloud.vast.ai/account/ — or, if their CLI is installed:
      vastai create ssh-key \"\$(cat $SSH_KEY.pub)\"
  To install the CLI: curl -fsSL https://vast.ai/install.sh | bash"

  # The balance. At zero vast destroys instances together with their disks —
  # that is the second way to lose data, and it is better to know about it in
  # advance, not on a Friday.
  local user balance
  user="$(api GET "users/current/")" || die "could not ask vast about the balance."
  # One number is printed, not the whole answer: among other things this answer
  # also carries the account key.
  balance="$(printf '%s' "$user" | py '
import json, sys
d = json.load(sys.stdin)
b = d.get("credit", d.get("balance"))
print("%.2f" % float(b) if b is not None else "")
')"
  if [ -n "$balance" ]; then say "${DIM}    balance \$$balance${OFF}"; fi

  say "${BOLD}2/$STEPS${OFF} looking for the deployment's machine${ENV_NAME:+ \"${ENV_NAME}\"} — label \"${LABEL}\""
  # First by our own label, then that very unnamed one — but only if it proves
  # that it belongs to this deployment.
  if load_instance || adopt_legacy; then
    say "${DIM}    already rented: instance $INST_ID${OFF}"
    say "${BOLD}3/$STEPS${OFF} deploying over it"
    if [ "$INST_STATUS" != running ]; then
      say "${DIM}    it is \"${INST_STATUS}\" now — bringing it up${OFF}"
      api PUT "instances/$INST_ID/" '{"state":"running"}' >/dev/null
      wait_running "$INST_ID"
      load_instance || die "instance $INST_ID came up, but it is not found by label."
    fi
  else
    say "${DIM}    not rented — looking for an offer: ${GPU_NAME:-any GPU}${GPU_RAM:+, from $GPU_RAM GB}, VM, on-demand, up to \$$MAX_PRICE/hr${OFF}"
    local query offers pick suitable
    query="$(GPU_RAM="$GPU_RAM" MAX_PRICE="$MAX_PRICE" DISK="$DISK" GPU_NAME="$GPU_NAME" py '
import json, os
q = {
    # Only VMs: inside a vast docker instance docker is forbidden, and without it a
    # room has no kernel of its own.
    "vms_enabled": {"eq": True},
    # Only on-demand, and that is not a filter but a kind of deal: interruptible
    # ones get evicted in the middle of a class.
    "type": "ondemand",
    "rentable": {"eq": True},
    "rented": {"eq": False},
    "verified": {"eq": True},
    "reliability": {"gte": 0.98},
    "num_gpus": {"gte": 1},
    "disk_space": {"gte": float(os.environ["DISK"]) + 10},
    "dph_total": {"lte": float(os.environ["MAX_PRICE"])},
    "order": [["dph_total", "asc"]],
    # Take extra, because the driver is filtered out here, on our side: of twenty
    # offers none might be left after filtering.
    "limit": 60,
}
ram = os.environ.get("GPU_RAM", "").strip()
if ram:
    # Megabytes, and the threshold is deliberately not 24*1024: a "24 GB" card
    # reports 24564 MB, and a round power of two would cut off every 4090 at once.
    q["gpu_ram"] = {"gte": int(float(ram) * 1000)}
name = os.environ.get("GPU_NAME", "").strip()
if name:
    q["gpu_name"] = {"in": [name]}
print(json.dumps(q))
')"
    offers="$(api POST "bundles/" "$query")"
    # The first five are printed to stderr — so that the person sees the market,
    # not a single number — and the choice goes to stdout and is parsed below.
    suitable="$(printf '%s' "$offers" | py '
import json, sys
offers = json.load(sys.stdin).get("offers") or []
# The driver is checked here, not by a vast filter — and that is not a matter
# of taste. The torch wheels are built for CUDA 12.x and will not run on 11.8,
# but the server-side condition cuda_max_good >= 12.1 measurably lies: offers
# with RTX 5070 and RTX 5090 have cuda_max_good = 13.0 in the answer, yet with
# this condition in the query not one of them is found (checked by reading,
# twice in a row, 5 September 2026). That is, the filter threw out exactly the
# GPUs the machine is rented for. The field in the answer is right, though —
# the same condition, applied to the answer.
offers = [o for o in offers if float(o.get("cuda_max_good") or 0) >= 12.1]
for o in offers[:8]:
    print("    %-10s %s x %-10s %4.0f GB  $%.3f/hr  %s" % (
        o.get("id"), o.get("num_gpus"), o.get("gpu_name"),
        # Shown as on the box: 24564 MB is "24 GB", not "25".
        (o.get("gpu_ram") or 0) / 1024, o.get("dph_total") or 0,
        o.get("geolocation") or ""), file=sys.stderr)
# ALL suitable ones go to stdout, one line per offer, the cheapest first: the
# person may name not what we chose for them but any other — by its number from
# the list above (closer, a newer GPU, a host they know). The number is checked
# against this list rather than sent to vast as is: that way nothing can be
# rented that has not passed both the price limit and the driver filter.
for o in offers:
    print("%s\t%.3f\t%s x %s" % (o["id"], o.get("dph_total") or 0,
                                 o.get("num_gpus"), o.get("gpu_name")))
')"
    [ -n "$suitable" ] || die "nothing matched these conditions.
  Searched for: GPU \"${GPU_NAME:-any}\", memory $GPU_RAM_TEXT, up to \$$MAX_PRICE/hr,
  disk from $DISK GB.
  To relax it once: make vast-up GPU=\"RTX 4090\" — or for good, in .env:
  VAST_GPU, VAST_GPU_RAM, VAST_MAX_PRICE. There are noticeably fewer VMs on the market
  than ordinary instances — that is the price of choosing to rent VMs."

    local offer_id price what
    # The offer line by its number — from the same list of suitable offers.
    offer_line() { printf '%s\n' "$suitable" | awk -F '\t' -v id="$1" '$1 == id { print; exit }'; }
    announce() {
      say ""
      say "${BOLD}taking $offer_id${OFF} — $what, \$$price/hr"
      say "${DIM}a two-hour class will cost about \$$(PRICE="$price" py '
import os; print("%.2f" % (float(os.environ["PRICE"]) * 2))')${OFF}"
    }
    # OFFER=<number> — name the offer in advance (in a FORCE=1 script too).
    if [ -n "${OFFER:-}" ]; then
      pick="$(offer_line "$OFFER")"
      [ -n "$pick" ] || die "offer $OFFER is not among the suitable ones for these conditions.
  Drop OFFER — and pick a number from the list above."
    else
      pick="$(printf '%s\n' "$suitable" | head -n 1)"
    fi
    IFS=$'\t' read -r offer_id price what <<<"$pick"
    announce
    # The money is real, so we ask. FORCE=1 is for scripts where the price limit is
    # set in advance, in VAST_MAX_PRICE.
    if [ "${FORCE:-}" != 1 ]; then
      [ -t 0 ] || die "no terminal to ask in. FORCE=1 rents without asking."
      printf '%srent it? [y/N or a number from the list] %s' "$BOLD" "$OFF"
      local answer; read -r answer
      case "$answer" in
        y|Y|д|да) : ;;
        *[!0-9]*|'') die "not renting." ;;
        *)
          # A number instead of "yes" is consent too, only to another offer: we do not
          # ask a second time, but we say what we take.
          pick="$(offer_line "$answer")"
          [ -n "$pick" ] || die "offer $answer is not among the suitable ones — not renting.
  The numbers are in the list above; for a wider list: VAST_MAX_PRICE, VAST_GPU_RAM in .env."
          IFS=$'\t' read -r offer_id price what <<<"$pick"
          announce
          ;;
      esac
    fi

    say "${BOLD}3/$STEPS${OFF} renting"
    local create new_id
    create="$(IMAGE="$IMAGE" DISK="$DISK" LABEL="$LABEL" py '
import json, os
print(json.dumps({
    "image": os.environ["IMAGE"],
    "disk": float(os.environ["DISK"]),
    # This very line is what tells a VM from an ordinary instance.
    "vm": True,
    # For VMs vast supports only ssh, and nothing more is needed: Colloq reaches the
    # outside with an outgoing connection through the relay, so we ask for no
    # incoming port other than ssh.
    "runtype": "ssh",
    "label": os.environ["LABEL"],
    "target_state": "running",
    # The offer may have been withdrawn between the search and the rental. Let the
    # refusal be immediate and explicit, not a machine that "will start some day".
    "cancel_unavail": True,
}))
')"
    new_id="$(api PUT "asks/$offer_id/" "$create" | py '
import json, sys
# The instance number arrives in the new_contract field, not id: id here is the
# offer number, and mixing them up means polling a machine that is not ours
# afterwards.
print(json.load(sys.stdin).get("new_contract") or "")')"
    [ -n "$new_id" ] || die "vast did not say what it rented.
  Have a look at https://cloud.vast.ai/instances/ — if the machine did appear,
  repeat make vast-up$NAME_ARG: it will deploy over it."
    say "${DIM}    instance $new_id${OFF}"
    wait_running "$new_id"
    load_instance || die "instance $new_id is rented, but it is not found by label.
  Have a look at https://cloud.vast.ai/instances/"
  fi

  say "${BOLD}4/$STEPS${OFF} waiting for ssh"
  [ -n "$INST_SSH_HOST" ] && [ -n "$INST_SSH_PORT" ] \
    || die "vast has not given the ssh address yet. Try again in a minute: make vast-up$NAME_ARG"
  say "${DIM}    ssh root@$INST_SSH_HOST -p $INST_SSH_PORT${OFF}"
  local waited=0
  until rssh true </dev/null 2>/dev/null; do
    waited=$((waited + 5))
    [ "$waited" -lt 600 ] || die "ssh to the machine has not answered for ten minutes.
  Is the right key registered in the account? Check by hand:
      ssh -i $SSH_KEY -p $INST_SSH_PORT root@$INST_SSH_HOST"
    sleep 5
  done

  say "${BOLD}5/$STEPS${OFF} installing docker and transferring Colloq"
  rssh "FRP_VERSION='$FRP_VERSION' REMOTE_DIR='$REMOTE_DIR' bash -s" <<'REMOTE'
set -euo pipefail
export DEBIAN_FRONTEND=noninteractive

echo "== packages"
# The machine is disposable: it has no use for automatic updates, and their
# dpkg lock broke the node install at the next step (13 Sep 2026). We switch
# them off and wait until the lock is released.
systemctl disable --now unattended-upgrades apt-daily.timer apt-daily-upgrade.timer >/dev/null 2>&1 || true
for _ in $(seq 1 200); do
  fuser /var/lib/dpkg/lock-frontend /var/lib/dpkg/lock >/dev/null 2>&1 || pgrep -x unattended-upgr >/dev/null 2>&1 || break
  sleep 3
done
apt-get update -qq
# rsync is installed here, not later: the repository is copied with it, and
# without it on the other side the copy fails on the very first call. sqlite3
# is for restoring the database, tmux so that the tunnel survives a closed
# laptop.
# dnsutils is for host.sh: it checks the address it brought up with dig, and
# without it falls back to the system resolver, which lies in exactly this
# check.
apt-get install -y -qq rsync make git curl tar tmux sqlite3 dnsutils ca-certificates gnupg >/dev/null

echo "== docker"
if ! command -v docker >/dev/null; then
  curl -fsSL https://get.docker.com | sh >/dev/null
fi
systemctl enable --now docker >/dev/null 2>&1 || true
docker --version

echo "== gpu"
if command -v nvidia-smi >/dev/null 2>&1; then
  nvidia-smi --query-gpu=index,name,memory.total --format=csv,noheader || true
  # The machine has the driver, but without nvidia-container-toolkit docker does
  # not hand the GPU to a container: the room kernel comes up without CUDA, and
  # people find out from torch.cuda.is_available() == False, already in class.
  # The repository is the one NVIDIA describes; this path has never been checked
  # on a live rental.
  if ! docker info 2>/dev/null | grep -qi nvidia; then
    curl -fsSL https://nvidia.github.io/libnvidia-container/gpgkey \
      | gpg --dearmor -o /usr/share/keyrings/nvidia-container-toolkit-keyring.gpg
    curl -fsSL https://nvidia.github.io/libnvidia-container/stable/deb/nvidia-container-toolkit.list \
      | sed 's#deb https://#deb [signed-by=/usr/share/keyrings/nvidia-container-toolkit-keyring.gpg] https://#g' \
      > /etc/apt/sources.list.d/nvidia-container-toolkit.list
    apt-get update -qq
    apt-get install -y -qq nvidia-container-toolkit >/dev/null
    nvidia-ctk runtime configure --runtime=docker >/dev/null
    systemctl restart docker
  fi
else
  echo "  no nvidia-smi — this machine got no GPU"
fi

echo "== frpc ${FRP_VERSION}"
# The same frp as on the relay, only the client half: without it `make host`
# on this machine refuses, and Cloudflare does not open from Russia.
if [ ! -x /usr/local/bin/frpc ]; then
  tmp=$(mktemp -d)
  curl -fsSL "https://github.com/fatedier/frp/releases/download/v${FRP_VERSION}/frp_${FRP_VERSION}_linux_amd64.tar.gz" \
    | tar -xz -C "$tmp" --strip-components=1
  install -m 0755 "$tmp/frpc" /usr/local/bin/frpc
  rm -rf "$tmp"
fi
frpc --version

mkdir -p "$REMOTE_DIR"
REMOTE

  # What goes to the machine and what stays here. The list is the same as in
  # .dockerignore, and for the same reason: node_modules and .git are hundreds of
  # megabytes of transfer, while data/ and workspace/ arrive separately, as a
  # backup.
  local excl; excl="$(mktemp -t colloq-vast-excl.XXXXXX)"; TMPS+=("$excl")
  cat > "$excl" <<'EXCL'
node_modules/
.git/
data/
workspace/
backups/
dist/
.env
.env.local
*.log
*.png
.colloq.pid
.colloq.log
.colloq/
.claude/
scratchpad/
dist-pkg/
python/dist/
python/build/
.DS_Store
kernel/environments/.*.built
kernel/environments/*.txt
EXCL
  rsync -az --delete --exclude-from="$excl" -e "$(ssh_cmd)" \
    ./ "root@$INST_SSH_HOST:$REMOTE_DIR/"

  # `.colloq/` is the state of THIS machine: the `make dev` receipt with a
  # process number on the laptop, a lock, build marks. Until 20 Sep 2026 the
  # directory travelled with the tree, and `make host` on the rented machine,
  # finding a receipt with a process that is dead (for it), refused to publish
  # the address. The exclusion above stops new copies; rsync will not touch one
  # already brought over (--delete does not remove excluded files — and rightly
  # so, otherwise it would wipe data/ and .env there), so we remove it by hand.
  # Only the session receipt: the rest there is harmless.
  rssh "rm -f '$REMOTE_DIR/.colloq/local-session.json' '$REMOTE_DIR/.colloq/local-session.lock' '$REMOTE_DIR/.colloq/local-session-result.json'" || true

  # Package lists — in a separate pass, without --delete and with --update.
  #
  # They are edited and created right on the machine, from the panel (the
  # "Environments" window writes kernel/environments/<name>.txt on the host, and
  # docker-compose.yml promises that the edit stays there). In the general pass
  # above they fell under --delete and under being overwritten by the laptop's
  # version: an environment created during a class vanished silently together
  # with its image, and rooms on it stopped starting. And until recently the
  # lists were not in the backup either — they were lost without a trace.
  #
  # --update rather than "do not touch at all": a new environment written here
  # has to get there, but a file that is newer on the machine is not overwritten
  # by the local one. The `.<name>.built` stamps stay with the machine: they say
  # what is baked into ITS image, and the local ones know nothing about that.
  rsync -az --update --exclude='.*.built' -e "$(ssh_cmd)" \
    kernel/environments/ "root@$INST_SSH_HOST:$REMOTE_DIR/kernel/environments/"

  # .env travels without the keys that pay: VAST_TOKEN takes money from the
  # card, CF_* edits the colloq.ru zone. The seminar needs neither, and the
  # machine is someone else's. Everything else — RELAY_*, the Oracle key,
  # SESSION_SECRET — travels as is: secrets are not re-issued here, otherwise the
  # seminar links sent out and the panel login would stop working after the move.
  #
  # And without three lines that describe THIS machine, not that one.
  # WORKSPACE_HOST_DIR is not just redundant there — it is poisonous: the server
  # on the host reads it as a sign of "I am in a container", puts the room kernel
  # into the compose network and calls it by the container name, which has no
  # route from the host; every Run would end in an error. KERNEL_NETWORK is the
  # second half of the same form. DOCKER_GID is the group of the docker socket on
  # THIS laptop, and on the rented machine it is different; an empty spot there
  # is better than a wrong number, `make up` fills it in itself when needed.
  local tmpenv; tmpenv="$(mktemp -t colloq-vast-env.XXXXXX)"; TMPS+=("$tmpenv")
  grep -vE '^(VAST_[A-Z_]+|CF_[A-Z_]+|PUBLIC_URL|WORKSPACE_HOST_DIR|KERNEL_NETWORK|DOCKER_GID)=' .env > "$tmpenv"
  # Two lines belong to the machine itself, and this file, laid over it whole,
  # used to wipe them.
  #
  # PUBLIC_URL: the address of someone else's tunnel carried over from here would
  # hand the audience a link to a laptop that is not in that classroom — so the
  # local one is cut out above. But localhost instead of the machine's live
  # outside address means the same broken links: a repeated "bring over a code
  # fix" run on a machine that is already exposed dropped its links to localhost
  # until the end of step 7. The machine keeps its own https address; if it has
  # none, we write localhost, as before.
  #
  # KERNEL_ENV: the default environment is chosen in the panel THERE ("make
  # default" writes this line into the machine's .env, server/src/environments.ts),
  # and the local value has nothing to do with it.
  local there there_env there_url
  there="$(rssh "grep -hE '^(KERNEL_ENV|PUBLIC_URL)=' $REMOTE_DIR/.env 2>/dev/null" </dev/null 2>/dev/null || true)"
  there_env="$(printf '%s\n' "$there" | grep -E '^KERNEL_ENV=' | tail -1 || true)"
  there_url="$(printf '%s\n' "$there" | grep -E '^PUBLIC_URL=https://' | tail -1 || true)"
  if [ -n "$there_url" ]; then
    printf '%s\n' "$there_url" >> "$tmpenv"
    say "${DIM}    leaving the machine its outside address: ${there_url#PUBLIC_URL=}${OFF}"
  else
    printf 'PUBLIC_URL=http://localhost:%s\n' "$PORT" >> "$tmpenv"
  fi
  if [ -n "$there_env" ]; then
    local tmpenv2; tmpenv2="$(mktemp -t colloq-vast-env2.XXXXXX)"; TMPS+=("$tmpenv2")
    grep -vE '^KERNEL_ENV=' "$tmpenv" > "$tmpenv2" || true
    printf '%s\n' "$there_env" >> "$tmpenv2"
    cat "$tmpenv2" > "$tmpenv"
    say "${DIM}    leaving the machine its default environment: ${there_env#KERNEL_ENV=}${OFF}"
  fi
  # mktemp made the file with mode 0600, and rsync -a preserves it: .env holds
  # the Oracle key and the signing key, and on the other side they must be kept
  # the same way.
  rsync -a -e "$(ssh_cmd)" "$tmpenv" "root@$INST_SSH_HOST:$REMOTE_DIR/.env"

  # ONLY our own backup travels. Each deployment has its own directory
  # (backups/hse/), and the most recent one is taken from it; if there is none,
  # the machine comes up empty, and that is an honest answer. The old "the latest
  # backup in backups/" would have meant, with two deployments, another seminar's
  # database in this room: other notebooks, other links, other teachers.
  local db files want_db=""
  db="$(last_backup)"
  if [ -n "$db" ]; then
    say "${DIM}    bringing the backup of the deployment${ENV_NAME:+ \"${ENV_NAME}\"}: $db${OFF}"
    want_db="$(basename "$db")"
    rssh "mkdir -p $REMOTE_DIR/backups" </dev/null
    rsync -a -e "$(ssh_cmd)" "$db" "root@$INST_SSH_HOST:$REMOTE_DIR/backups/"
    files="${db%.db}-files.tar.gz"
    if [ -f "$files" ]; then
      rsync -a -e "$(ssh_cmd)" "$files" "root@$INST_SSH_HOST:$REMOTE_DIR/backups/"
    else
      say "${DIM}    no file archive next to it — only the database will arrive${OFF}"
    fi
  else
    say "${DIM}    no backup in $BACKUP_DIR/ — the machine will come up empty${OFF}"
  fi

  say "${BOLD}6/$STEPS${OFF} restoring the data and bringing Colloq up as a service"
  rssh "REMOTE_DIR='$REMOTE_DIR' WANT_DB='$want_db' REPLACE='${REPLACE:-}' bash -s" <<'REMOTE'
set -euo pipefail
cd "$REMOTE_DIR"

# Restore BEFORE bringing it up: sqlite keeps open the file it opened, and
# swapping the database under a running server means writing into a deleted
# file while seeing yesterday's state on the screen.
#
# And only on an empty machine. A repeated run on an already deployed one is
# an ordinary thing (the tunnel fell over, the name changed, a code fix
# arrived), and yesterday's backup must not be restored over a working room: it
# lags behind what has already been typed in the room.
#
# "Empty" means NO DATABASE, not "nobody answers on /api/health". The
# difference would have cost a seminar: a service stopped by hand (and
# `scripts/restore.sh` itself advises "stop it first: make service-stop"), or
# one that hit the systemd restart limit, does not answer health — and the old
# check declared a machine with today's class empty, swapped the database for
# yesterday's backup and unpacked the old archive over workspace. The database
# was set aside meanwhile as colloq.db.replaced-<stamp>, which nobody knows
# about, and the files were overwritten without a backup. The server, on the
# other hand, creates the database at its first start, so its absence is a sign
# that does not lie in the other direction.
#
# Rolling back to a backup ON PURPOSE is possible: REPLACE=1 make vast-up … —
# then it is the same branch and the same swap, but by request, not by silence.
if [ -s data/colloq.db ] && [ "${REPLACE:-}" != 1 ]; then
  echo "the machine already has a database data/colloq.db — not restoring the backup"
  echo "  to roll back to the backup brought over, on purpose: REPLACE=1 make vast-up …"
elif [ -n "${WANT_DB:-}" ] && [ -f "backups/$WANT_DB" ]; then
  # Exactly the file that was just brought here is restored, not "the most
  # recent in backups/". The difference shows in the machine's second life: a
  # backup from the previous rental may be left there, and "the most recent" is
  # sometimes that one.
  #
  # FORM=service is about directory owners. The backup is restored BEFORE the
  # service is installed (otherwise the server would open the database we are
  # about to swap), and there is no unit on the machine yet, so restore.sh
  # itself will not guess the form: without this line it would give data/ and
  # workspace/ to user 1000, as for a server in a container.
  #
  # REPLACE is passed on: there is nobody to ask "really over it?" a second time
  # — this shell has no terminal, the heredoc itself hangs on stdin.
  FORM=service REPLACE="${REPLACE:-}" bash scripts/restore-legacy.sh "backups/$WANT_DB"
else
  echo "nothing to restore — starting with an empty database"
fi

# A machine of the old form: all of Colloq in docker. We find one on a
# repeated run on a long-rented instance — the app container holds the port,
# and the service will not fit on it.
#
# Strictly AFTER the decision about the backup: restore.sh refuses to work
# under a live server, and the order here is the only thing that lets it see
# that refusal. (The decision "is the machine empty" itself no longer looks at
# the localhost answer: it looks at whether data/colloq.db exists — a stopped
# server is not the same as a clean machine.)
#
# Only app is stopped: the room containers live separately, compose does not
# know about them, and `make down` would take the class in progress down with
# them.
if docker compose ps --status running --services 2>/dev/null | grep -qx app; then
  echo "== old form: stopping app in docker, the service needs the port"
  docker compose stop app >/dev/null 2>&1 || true
fi

# Which devices to give to rooms. The list is in the form docker understands;
# on the rented machine these are just GPU numbers. No line, or an empty one —
# the old behaviour: nobody asks for a GPU.
if ! grep -qE '^KERNEL_GPUS=' .env 2>/dev/null; then
  gpus="$(nvidia-smi --query-gpu=index --format=csv,noheader 2>/dev/null | paste -sd, - || true)"
  if [ -n "$gpus" ]; then
    printf '\n# The GPUs of this machine. A slice goes to a room whose environment declares\n# "# colloq: gpu" in the header of kernel/environments/<name>.txt.\nKERNEL_GPUS=%s\n' "$gpus" >> .env
    echo "KERNEL_GPUS=$gpus"
  fi
fi

# The server as a systemd service, room kernels in docker. Inside: Node, npm
# ci, the build, the kernel image, the unit and waiting for readiness. The
# command is idempotent: it also updates the machine when a code fix has
# arrived here.
bash scripts/service-legacy.sh install
REMOTE

  local hosted=""
  if [ -n "$WANT_HOST" ]; then
    say "${BOLD}7/$STEPS${OFF} exposing it at $WANT_HOST"
    # A live address is left alone.
    #
    # The step below starts with `tmux kill-session`, that is, with closing the
    # tunnel — and a repeated run happens exactly on a machine where a class is
    # going on: "bring over a code fix" is the same `make vast-up HOST=…`. Every
    # such run threw the room into reconnecting and for a few seconds dropped the
    # links to localhost, although the address was answering all along. We ask the
    # address itself: it answers — there is nothing to touch, and the step passes
    # with one check.
    if host_health; then
      say "${DIM}    $WANT_HOST already answers — leaving the tunnel and the session alone${OFF}"
      hosted=1
    # A failure of this step does not undo the previous ones: the machine is
    # rented, Colloq runs on it. So a branch, not die — otherwise a person who has
    # already paid for the machine would not even see the ssh line to get into it.
    elif rssh "REMOTE_DIR='$REMOTE_DIR' WANT_HOST='$WANT_HOST' TMUX_SESSION='$TMUX_SESSION' PORT='$PORT' bash -s" <<'REMOTE'
set -euo pipefail
cd "$REMOTE_DIR"

# host.sh refuses to open a tunnel over an unhealthy instance — and rightly so.
# But `make up` returns as soon as compose has accepted the command, while the
# kernel takes another half minute to come up: without this wait "one command
# for the whole class" would fall apart in a race, every other time.
ok=""
for _ in $(seq 1 40); do
  if curl -sf -o /dev/null --max-time 5 "http://localhost:$PORT/api/health"; then ok=1; break; fi
  sleep 3
done
[ -n "$ok" ] || {
  echo "colloq on this machine does not answer on localhost:$PORT — nothing to open a tunnel to" >&2
  exit 1
}

# The previous session is removed before the new one. The relay does not let
# in a second frpc with the same subdomain ("already exists"), and a repeated
# vast-up would get a refusal from its own, still living tunnel — the most
# annoying kind of "taken".
tmux kill-session -t "$TMUX_SESSION" 2>/dev/null || true

# The tunnel lives exactly as long as `make host` lives. Started right in the
# ssh session, it would die with it — that is, the second the laptop is closed.
# The log is written alongside: when the address does not answer, that is what
# people will look at.
tmux new-session -d -s "$TMUX_SESSION" \
  "cd '$REMOTE_DIR' && make host HOST='$WANT_HOST' 2>&1 | tee -a host.log"
sleep 2
tmux has-session -t "$TMUX_SESSION" 2>/dev/null || {
  echo "tmux session $TMUX_SESSION did not start" >&2
  tail -20 host.log 2>/dev/null >&2 || true
  exit 1
}
REMOTE
    then
      # We wait not for "tmux started" but for the address itself to answer: between
      # them are frpc, the relay and a restart of the app with the new PUBLIC_URL.
      # The ceiling is three minutes: longer than that it is no longer "coming up"
      # but "did not come up".
      say "${DIM}    waiting for an answer from $WANT_HOST${OFF}"
      waited=0
      while [ "$waited" -lt 180 ]; do
        if host_health; then hosted=1; break; fi
        sleep 5; waited=$((waited + 5))
      done
      if [ -z "$hosted" ]; then
        say "${RED}    $WANT_HOST did not answer in three minutes — not printing the link${OFF}"
      fi
    fi

    if [ -z "$hosted" ]; then
      local pane
      # The session may already be gone: when the relay refuses, `make host` dies at
      # once, and the window ends with it. That case is why it writes to host.log —
      # the log outlives the session, and then that is where to look.
      pane="$(rssh "if tmux has-session -t $TMUX_SESSION 2>/dev/null; then tmux capture-pane -pt $TMUX_SESSION -S -60; else tail -30 $REMOTE_DIR/host.log 2>/dev/null; fi | grep -v '^\$' | tail -12" </dev/null 2>/dev/null || true)"
      if [ -n "$pane" ]; then
        say "${DIM}    the latest from there:${OFF}"
        printf '%s\n' "$pane" | sed 's/^/      /'
      fi
      say "${DIM}    to look further:${OFF}"
      say "${DIM}      session log       ssh -i $SSH_KEY -p $INST_SSH_PORT root@$INST_SSH_HOST 'tmux capture-pane -pt $TMUX_SESSION -S -200'${OFF}"
      say "${DIM}      same, on disk     ssh … 'tail -40 $REMOTE_DIR/host.log'${OFF}"
      say "${DIM}      RELAY_* there     ssh … 'grep RELAY_ $REMOTE_DIR/.env'${OFF}"
      say "${DIM}      name resolves?    dig +short $WANT_HOST @1.1.1.1${OFF}"
      say "${DIM}    Colloq itself is running — it is the outside address that does not answer.${OFF}"
    fi
  fi

  printf '\n'
  say "${BOLD}Colloq is up on the rented machine${ENV_NAME:+ — deployment \"${ENV_NAME}\"}${OFF}"
  say "  ${CYAN}ssh -i $SSH_KEY -p $INST_SSH_PORT root@$INST_SSH_HOST${OFF}"
  printf '\n'
  if [ -n "$hosted" ]; then
    say "${BOLD}The link for the audience${OFF}"
    say "  ${CYAN}${BOLD}https://$WANT_HOST${OFF}"
    say "  ${DIM}The tunnel is held by the tmux session \"${TMUX_SESSION}\" on that machine: it${OFF}"
    say "  ${DIM}survives a closed laptop, but not the destruction of the machine.${OFF}"
    # The link with the token is neither fetched here nor printed: it is the key to
    # the instance, and the fewer screens and logs it passes through, the better.
    # We show where to get it.
    say "  ${DIM}The way into the panel — the link with the token is printed in the session itself:${OFF}"
    say "  ${DIM}  ssh … 'tmux capture-pane -pt $TMUX_SESSION -S -200' | grep /admin/t/${OFF}"
  elif [ -n "$WANT_HOST" ]; then
    # A separate branch, not the general hint: for a person whose address has just
    # failed to come up it is too late to explain "go outside from there". They need
    # one thing — how to repeat. Repeating is safe: the machine is already rented,
    # and vast-up deploys over it rather than taking a second one.
    say "${BOLD}The address is not confirmed${OFF} ${DIM}— where to look is said above${OFF}"
    say "  ${DIM}repeat without renting anything again: make vast-up HOST=$WANT_HOST${OFF}"
  else
    say "${BOLD}Go outside from there, not from here${OFF} ${DIM}(the seminar is computed where the kernel runs)${OFF}"
    if [ -n "$RELAY_DOMAIN" ]; then
      say "  ${CYAN}make vast-up HOST=<name>.$RELAY_DOMAIN${OFF} ${DIM}— from here, with one command${OFF}"
      say "  ${DIM}or by hand on the machine: cd $REMOTE_DIR && make host HOST=<name>.$RELAY_DOMAIN${OFF}"
    else
      say "  ${CYAN}cd $REMOTE_DIR && make host${OFF}"
      say "  ${DIM}without RELAY_* in .env this is Cloudflare, and its addresses do not${OFF}"
      say "  ${DIM}open from Russia — see make relay-setup and the README section on the relay${OFF}"
    fi
    say "  ${DIM}Run by hand, the command holds the window: the tunnel lives while it runs.${OFF}"
    say "  ${DIM}Closing the laptop? Run it in tmux: tmux new -s $TMUX_SESSION${OFF}"
  fi
  printf '\n'
  say "${DIM}The server there is a systemd service, only the room kernels are in docker:${OFF}"
  say "${DIM}  logs        ssh … 'journalctl -u colloq -f'${OFF}"
  say "${DIM}  restart     ssh … 'cd $REMOTE_DIR && make service-restart'${OFF}"
  say "${DIM}  update      a repeated make vast-up$NAME_ARG brings code fixes here${OFF}"
  say "${DIM}An environment with a GPU is built there too: make env-build NAME=gpu${OFF}"
  say "${DIM}Data from there: make vast-sync$NAME_ARG · destroy the machine: make vast-down$NAME_ARG${OFF}"
  say "${RED}Everything on that machine lives exactly until it is destroyed.${OFF}"
}

# --------------------------------------------------------------- status

cmd_status() {
  need_tools
  auth
  local db s lines n
  # No name given — we show everything that is rented. There may be several
  # deployments, and "whichever comes first" would lie here in no small way: the
  # price, the backup and the address would belong to different machines.
  # Exactly one deployment — details right away: there is nothing to choose
  # from, and an extra step would be just that, extra.
  if [ -z "$ENV_NAME" ]; then
    lines="$(instances_tsv)"
    n="$(env_count "$lines")"
    if [ "$n" -gt 1 ]; then
      say "${BOLD}deployments rented: $n${OFF}"
      print_envs "$lines"
      printf '\n'
      say "${DIM}details of one: make vast-status NAME=<name>${OFF}"
      say "${DIM}every deployment has its own machine, bill and data — only the code and the relay are shared${OFF}"
      return 0
    fi
    if [ "$n" -eq 1 ]; then
      ENV_NAME="$(printf '%s' "$lines" | cut -d "$SEP" -f1)"; use_env
    fi
  fi
  db="$(last_backup)"
  if ! load_instance; then
    say "${DIM}nothing is rented on vast.ai${OFF} ${DIM}(label \"${LABEL}\")${OFF}"
    say "${DIM}to rent: make vast-up$NAME_ARG${OFF}"
    if [ -n "$db" ]; then say "${DIM}last backup here: $(backup_age "$db")${OFF}"; fi
    return 0
  fi
  printf '%sdeployment %s%s %s· instance %s · %s · %s x %s · $%s/hr%s\n' \
    "$BOLD" "$(env_title "$ENV_NAME")" "$OFF" "$DIM" "$INST_ID" "$INST_STATUS" \
    "$INST_NGPU" "$INST_GPU" "$INST_DPH" "$OFF"
  if [ -n "$INST_MSG" ]; then say "${DIM}  $INST_MSG${OFF}"; fi
  s="$(spent)"
  if [ -n "$s" ]; then say "${DIM}  running for $s${OFF}"; fi
  if [ -n "$INST_SSH_HOST" ]; then
    say "${DIM}  ssh -i $SSH_KEY -p $INST_SSH_PORT root@$INST_SSH_HOST${OFF}"
  fi
  # "running" is about the VM, not the seminar: the containers on it may not have
  # come up, and the difference is visible only from here.
  if [ "$INST_STATUS" = running ] && [ -n "$INST_SSH_HOST" ]; then
    if rssh "curl -sf -m 5 http://localhost:$PORT/api/health >/dev/null" </dev/null 2>/dev/null; then
      say "  ${CYAN}colloq on that machine answers${OFF}"
    else
      say "  ${RED}colloq on that machine does not answer${OFF} ${DIM}(logs: ssh … 'journalctl -u colloq -n 40')${OFF}"
    fi

    # The outside address is a separate question, and it has to be asked
    # separately: "colloq answers" holds even when the tunnel died long ago, and
    # that is visible only from outside. We ask the machine about two things at
    # once (whether the session is alive and which address it has managed to write
    # into .env) and check that address from here.
    local info alive public name
    info="$(rssh "cd $REMOTE_DIR 2>/dev/null && { tmux has-session -t $TMUX_SESSION >/dev/null 2>&1 && echo alive || echo dead; grep -E '^PUBLIC_URL=' .env 2>/dev/null | tail -1 | cut -d= -f2-; }" </dev/null 2>/dev/null || true)"
    alive="$(printf '%s\n' "$info" | sed -n 1p | tr -d ' \r')"
    public="$(printf '%s\n' "$info" | sed -n 2p | tr -d ' \r')"
    name="${public#https://}"
    case "$public" in
      https://*)
        # The name came from the rented machine, not from a person, so it goes into
        # curl only after the same check for stray characters.
        case "$name" in *[!A-Za-z0-9.-]*) name="" ;; esac
        if [ -n "$name" ]; then
          WANT_HOST="$name"
          if command -v dig >/dev/null 2>&1; then HOST_IP="$(resolve_host "$name" || true)"; fi
          if host_health; then
            say "  ${CYAN}answers from outside${OFF} ${BOLD}$public${OFF}"
          else
            say "  ${RED}$public does not answer from outside${OFF}"
          fi
          # The deployment and the address are one name, and here that is no longer a
          # wish but a check of fact: the machine itself said what it serves. If they
          # diverge, backups of this deployment are taken under one name while the
          # seminar runs under another, and one day they will meet at the wrong end.
          if [ -n "$ENV_NAME" ] && [ "${name%%.*}" != "$ENV_NAME" ]; then
            say "  ${RED}but the deployment is called \"${ENV_NAME}\", and the address \"${name%%.*}\"${OFF}"
            say "  ${DIM}backups of this deployment are in $BACKUP_DIR/ — under the deployment name, not the address${OFF}"
          fi
        fi
        if [ "$alive" != alive ]; then
          say "  ${DIM}there is no tmux session \"${TMUX_SESSION}\" on the machine — nobody holds the tunnel${OFF}"
          say "  ${DIM}bring it up again: make vast-up HOST=${name:-<name>}${OFF}"
        fi ;;
      *)
        if [ "$alive" = alive ]; then
          say "  ${DIM}the tunnel \"${TMUX_SESSION}\" is coming up — no address in .env yet${OFF}"
        else
          say "  ${DIM}not exposed${OFF} ${DIM}(make vast-up HOST=<name>${RELAY_DOMAIN:+.$RELAY_DOMAIN})${OFF}"
        fi ;;
    esac
  fi
  if [ -n "$db" ]; then
    say "${DIM}last backup here: $(backup_age "$db")${OFF}"
  else
    say "${RED}no backups here at all${OFF} ${DIM}— take one: make vast-sync$NAME_ARG${OFF}"
  fi
}

# ----------------------------------------------------------------- sync

cmd_sync() {
  need_tools
  auth
  # Taking the data of the wrong deployment is half the trouble; the other half
  # is that it lands in someone else's directory and one day travels into
  # someone else's room. So with several deployments the name is required.
  resolve_env "back up"
  load_instance || die "nothing with label \"${LABEL}\" is rented on vast.ai — nothing to take a backup from."
  [ "$INST_STATUS" = running ] || die "instance $INST_ID is \"${INST_STATUS}\" now.
  Data can be taken only from a running machine: bring it up (make vast-up$NAME_ARG)
  and try again."

  say "${BOLD}1/2${OFF} taking a backup on the rented machine"
  # The backup is made THERE, not by copying the database file here: in WAL mode
  # half a day sits in the journal next to it, and a file copied on the fly lags
  # behind by hours. `make backup` writes a consistent snapshot and does not
  # require stopping the seminar.
  rssh "cd $REMOTE_DIR && make backup-legacy" </dev/null

  say "${BOLD}2/2${OFF} fetching it here, into $BACKUP_DIR/"
  # Each deployment has its own directory, and it is created right here: a
  # backup put into a common heap can be told from a neighbour's only by its date
  # — that is, not at all.
  mkdir -p "$BACKUP_DIR"
  local newest
  newest="$(rssh "ls -1t $REMOTE_DIR/backups/colloq-*.db 2>/dev/null | head -1" </dev/null || true)"
  [ -n "$newest" ] || die "no backup appeared on that machine.
  Look by hand: ssh … 'cd $REMOTE_DIR && make backup-legacy'"
  rsync -a -e "$(ssh_cmd)" "root@$INST_SSH_HOST:$newest" "$BACKUP_DIR/" \
    || die "the database did not arrive — do not count the data as taken."
  # A separate call, not a second source in the previous one: where there is no
  # file archive, rsync with two sources would drag the database that already
  # arrived into a common failure, and "what exactly was not taken" would have to
  # be found out by hand.
  rsync -a -e "$(ssh_cmd)" "root@$INST_SSH_HOST:${newest%.db}-files.tar.gz" "$BACKUP_DIR/" \
    || die "the database arrived, but the seminar files did not.
  This is half a backup: notebooks and settings are in place, the uploaded files remain
  only on the rented machine. Repeat make vast-sync$NAME_ARG before make vast-down$NAME_ARG."

  printf '\n'
  say "${BOLD}arrived${OFF}"
  say "  $BACKUP_DIR/$(basename "$newest") ${DIM}— the database: seminars, teachers, version history, the Oracle${OFF}"
  say "  $BACKUP_DIR/$(basename "${newest%.db}-files.tar.gz") ${DIM}— seminar files, the signing key, the setup token,${OFF}"
  say "    ${DIM}package lists — including those created from the panel on that machine${OFF}"
  say "${DIM}The built environment images did not come: rebuilding them is cheaper${OFF}"
  say "${DIM}(make env-build NAME=…) than carrying tens of gigabytes.${OFF}"
  say "${DIM}To restore this on an empty machine: make restore$NAME_ARG${OFF}"
}

# ----------------------------------------------------------------- logs

# Cut out of the log whatever can be used.
#
# A service log is not only server lines: request URLs with their query strings
# end up there, and one-time file keys travel in those; the server also prints
# the link to the setup panel there — and that link IS the key to the whole
# instance. A log fetched here lives in the repository, flies into a chat and
# gets attached to an email, so the filter sits ON THE PIPE: nothing unscrubbed
# touches the disk for a second.
#
# It cuts by shape, not by a list of known names: a participant token is
# recognized by its look (base64url.signature), a provider key by its prefix,
# everything else by the name of the parameter next to it. Cutting too much is
# cheaper than missing something once.
scrub() {
  py '
import re, sys

# (pattern, replacement). The order matters only in that the longer is cut
# before the shorter: the setup panel link before the general rule about
# parameters.
RULES = [
    # The setup panel link: by itself it is a way in as the owner of the instance.
    (r"(/admin/t/)[A-Za-z0-9_\-]+", r"\1<redacted>"),
    # One-time keys in the query string: token, t, key, sig and their kin.
    (r"([?&](?:token|t|key|api[_\-]?key|access[_\-]?token|auth|secret|sig|"
     r"signature|password|passwd|pwd|code)=)[^&\s\x22\x27<>]+", r"\1<redacted>"),
    # A header with a key.
    (r"(?i)(authorization:\s*\w+\s+)\S+", r"\1<redacted>"),
    (r"(?i)\bBearer\s+[A-Za-z0-9._\-]+", "Bearer <redacted>"),
    # Cookies — whole: they carry both the staff session and the way into the panel.
    (r"(?i)((?:set-)?cookie:\s*).*", r"\1<redacted>"),
    (r"(?i)\b(colloq_staff|connect\.sid)=[^;\s]+", r"\1=<redacted>"),
    # A participant token: body.signature, both in base64url. The body is JSON, so
    # it starts with eyJ and cannot be mistaken for an ordinary word.
    (r"\beyJ[A-Za-z0-9_\-]{6,}\.[A-Za-z0-9_\-]{10,}", "<redacted>"),
    # Model provider keys: each has its own prefix, but the shape is the same.
    (r"\b(sk|rk|xai|gsk)-[A-Za-z0-9_\-]{12,}", r"\1-<redacted>"),
    # Lines like SESSION_SECRET=… — that is how both compose and systemd print them.
    (r"\b([A-Z][A-Z0-9_]*(?:TOKEN|SECRET|KEY|PASSWORD|PASS))=\S+", r"\1=<redacted>"),
]
RULES = [(re.compile(a), b) for a, b in RULES]

for line in sys.stdin:
    for rx, repl in RULES:
        line = rx.sub(repl, line)
    sys.stdout.write(line)
'
}

cmd_logs() {
  need_tools
  auth
  # Fetching the log of the wrong deployment is not fatal, but someone else's
  # lines in someone else's folder mean investigating the wrong class; we ask the
  # same way as for sync.
  resolve_env "read logs from"
  load_instance || die "nothing with label \"${LABEL}\" is rented on vast.ai — nothing to take a log from."
  [ "$INST_STATUS" = running ] || die "instance $INST_ID is \"${INST_STATUS}\" now.
  The log is on the machine's disk, and it can be fetched only from a running one:
  bring it up (make vast-up$NAME_ARG) and try again."

  local since dir
  # The default is today: people look at the log for a class that is going on or
  # has just ended. Another window is named in the words of journalctl:
  # SINCE=-2h, SINCE=yesterday, SINCE="2026-09-06 10:00".
  since="${SINCE:-today}"
  # The string goes into a command on that machine, so it is checked against a
  # list of what is allowed, not a list of what continues a command: listing the
  # dangerous means forgetting one character some day, and that will be a
  # foreign command on a production machine. Everything used to talk about time
  # fits into letters, digits, space, colon, comma and a sign.
  if ! printf '%s' "$since" | grep -Eq '^[A-Za-z0-9:,+ -]{1,40}$'; then
    die "SINCE=\"$since\" is not valid: only letters, digits, spaces, colon and minus.
  For example: SINCE=today · SINCE=-2h · SINCE=yesterday · SINCE=\"2026-09-06 10:00\""
  fi

  # The directory is laid out like the backups: the deployment, and the date
  # inside it. What was fetched today and what was fetched yesterday are
  # different investigations, and piling them together means losing both.
  dir="logs${ENV_NAME:+/$ENV_NAME}/$(date +%F)"
  mkdir -p "$dir"

  say "${BOLD}1/2${OFF} service log ${DIM}(journalctl -u colloq, since \"$since\")${OFF}"
  # Without `2>&1`: a complaint from journalctl itself has to reach the person's
  # screen, not a file that is later read as the class log.
  if ! rssh "journalctl -u colloq --since '$since' --no-pager -o short-iso" </dev/null \
      | scrub > "$dir/colloq.log"; then
    say "${RED}    the service log could not be fetched${OFF} ${DIM}— on this machine colloq may run in docker rather than as a service${OFF}"
  fi

  say "${BOLD}2/2${OFF} room kernel logs ${DIM}(label colloq.kind=room-kernel, stopped ones included)${OFF}"
  # The starting point for docker: it does not understand the words of
  # journalctl, but it does understand seconds. The same machine counts them —
  # its time zone and its "today", not ours.
  local when epoch names name taken=0
  case "$since" in
    today)     when='today 00:00' ;;
    yesterday) when='yesterday 00:00' ;;
    *)         when="$since" ;;
  esac
  epoch="$(rssh "date -d '$when' +%s 2>/dev/null" </dev/null || true)"
  # Digits only: the answer arrives with a newline, and a word instead of
  # seconds would travel back into the command. Empty means we take the whole
  # kernel log.
  epoch="$(printf '%s' "$epoch" | tr -dc '0-9')"
  # `-a`: a room container stopped during a break keeps its whole log, and that
  # is most often exactly where the reason it was stopped lies.
  names="$(rssh "docker ps -a --filter label=colloq.kind=room-kernel --format '{{.Names}}'" \
    </dev/null || true)"
  for name in $names; do
    # The name arrives from someone else's machine and goes back into a command.
    # Anything that is not a docker container name is no longer a name, and it is
    # too late to quote it.
    case "$name" in
      ''|*[!A-Za-z0-9_.-]*) continue ;;
    esac
    if rssh "docker logs ${epoch:+--since '$epoch'} --timestamps '$name' 2>&1" </dev/null \
        | scrub > "$dir/$name.log"; then
      taken=$((taken + 1))
    else
      say "${DIM}    $name — could not be fetched${OFF}"
    fi
  done
  [ "$taken" -gt 0 ] || say "${DIM}    no room kernels on the machine — neither live nor stopped${OFF}"

  printf '\n'
  say "${BOLD}arrived in $dir/${OFF}"
  # Sizes, not a list of names: an empty log file looks like success right until
  # someone starts searching it for something.
  ls -lh "$dir" | tail -n +2 | while read -r _ _ _ _ size _ _ _ f; do
    say "  $f ${DIM}— $size${OFF}"
  done
  say "${DIM}Keys and cookies are cut out on the fly (see scrub in this file): the files${OFF}"
  say "${DIM}have <redacted> instead of tokens from query strings, headers and the panel link.${OFF}"
  say "${DIM}The server does not write participant names or cell text into the log at all.${OFF}"
}

# ----------------------------------------------------------------- down

cmd_down() {
  need_tools
  auth
  # The most expensive command here. Without a name and with several deployments
  # it would destroy "whichever comes first" — and there would be nothing left to
  # restore it from.
  resolve_env "destroy"
  load_instance || { say "${DIM}nothing with label \"${LABEL}\" is rented on vast.ai${OFF}"; return 0; }

  local s db answer
  s="$(spent)"; db="$(last_backup)"
  printf '\n'
  say "${BOLD}destroy instance $INST_ID${OFF} ${DIM}— deployment $(env_title "$ENV_NAME"), $INST_NGPU x $INST_GPU, \$$INST_DPH/hr${s:+, $s}${OFF}"
  say "${RED}Everything on this machine will vanish:${OFF} the database with the seminars, the seminar files,"
  say "the built environment images. vast has neither a trash bin nor snapshots."
  if [ -n "$db" ]; then
    say "${DIM}last backup here: $(backup_age "$db")${OFF}"
  else
    say "${RED}no backups here at all.${OFF} ${DIM}Take one: make vast-sync$NAME_ARG${OFF}"
  fi

  if [ "${FORCE:-}" != 1 ]; then
    [ -t 0 ] || die "no terminal to ask in. FORCE=1 destroys without asking."
    printf '%stype "уничтожить" to continue: %s' "$BOLD" "$OFF"
    read -r answer
    [ "$answer" = "уничтожить" ] || die "not destroying."
  fi

  api DELETE "instances/$INST_ID/" >/dev/null
  say "${DIM}instance $INST_ID destroyed — the meter has stopped${OFF}"
  say "${DIM}restore this data again: make vast-up$NAME_ARG${ENV_NAME:+ HOST=$ENV_NAME.${RELAY_DOMAIN:-colloq.ru}} — or here: make restore$NAME_ARG${OFF}"
}

case "$CMD" in
  up)     cmd_up ;;
  status) cmd_status ;;
  sync)   cmd_sync ;;
  logs)   cmd_logs ;;
  down)   cmd_down ;;
  adopt)  cmd_adopt ;;
  *)
    say "${BOLD}Colloq on a rented machine${OFF}"
    say "  scripts/vast.sh up      ${DIM}find a VM, rent it, deploy Colloq${OFF}"
    say "  ${DIM}NAME=demo             ... a deployment: its own machine, its own backups, its own bill${OFF}"
    say "  ${DIM}HOST=demo.colloq.ru    ... and expose it at this address right away${OFF}"
    say "  ${DIM}                        (the deployment name can then be left out — it is here)${OFF}"
    say "  ${DIM}GPU=\"RTX 5070\"         ... on the GPU named out loud${OFF}"
    say "  scripts/vast.sh status  ${DIM}without a name — all deployments; with a name — details of one${OFF}"
    say "  scripts/vast.sh sync    ${DIM}take the data from there to here, into backups/<deployment>/${OFF}"
    say "  scripts/vast.sh logs    ${DIM}fetch service and kernel logs into logs/<deployment>/<date>/${OFF}"
    say "  ${DIM}SINCE=-2h              ... for another window; the default is today${OFF}"
    say "  scripts/vast.sh down    ${DIM}destroy the machine together with everything on it${OFF}"
    say "  scripts/vast.sh adopt   ${DIM}name the machine with the old label \"${LABEL_BASE}\" as a deployment${OFF}"
    say ""
    say "${DIM}the same through make: make vast-up · vast-status · vast-sync · vast-logs · vast-down · vast-adopt${OFF}"
    say "${DIM}A deployment is a separate machine: separate money and separate data.${OFF}"
    if [ -n "$CMD" ]; then die "unknown command \"${CMD}\"."; fi
    ;;
esac
