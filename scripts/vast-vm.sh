#!/usr/bin/env bash
# Rent a Vast VM that boots the prebuilt colloq-vast image (deploy/vast).
#
#   make vast-vm                         the cheapest suitable VM offer
#   make vast-vm GPU="RTX 3070"          only this card
#   make vast-vm CPU=48 RAM=96           at least 48 cores and 96 GB, any card
#   make vast-vm OFFER=51006376          exactly this offer
#   make vast-vm HOST=vsos               class address vsos.<RELAY_DOMAIN> (default: the on-start's)
#   make vast-vm INSTANCE=53175270 HOST=vsos   redeploy on a VM already rented
#
# Why this exists instead of a template in the Vast console: renting from a
# template in the web UI starts even a vastai/kvm image as an ordinary Docker
# instance (no systemd, no nested Docker), whatever the template's filters say.
# A VM is only created when the rent request itself carries "vm": true, which
# the console does not send (seen three times on 28 Sep 2026). So the request
# is made here, over the API.
#
# The on-start is the filled copy of deploy/vast/onstart.sh, by default
# backups/vast-onstart.sh (git-ignored: it holds the relay token). It goes into
# the rent request, but Vast does not execute it on a VM, so it is also copied
# over ssh to /etc/colloq/onstart.sh and started from here.
#
# Every Vast VM carries at least one GPU (no CPU-only VM offers, seen 29 Sep
# 2026), and the price is mostly the card's. A class without GPUs (a
# competition, pandas) wants the opposite: many cores and a weak card. CPU= and
# RAM= filter by what the renter gets (cpu_cores_effective, cpu_ram), and the
# cheapest match is then usually a 3060/4060-class card on a big EPYC. Inside
# the VM expect a little less than the listing: 30 of 32 cores and 49 of 63 GB
# on 29 Sep 2026.
#
# Reads from .env: VAST_TOKEN, VAST_SSH_KEY, VAST_IMAGE, VAST_DISK,
# VAST_MAX_PRICE, VAST_GPU; the key is never printed or passed on a command line.
set -euo pipefail

cd "$(dirname "$0")/.."

RED=$'\033[31m'; DIM=$'\033[2m'; BOLD=$'\033[1m'; OFF=$'\033[0m'
say() { printf '%s\n' "$*"; }
die() { printf '%s%s%s\n' "$RED" "$*" "$OFF" >&2; exit 1; }
py() { python3 -c "$1"; }
. ./scripts/lib.sh

API=https://console.vast.ai/api/v0
ONSTART="${ONSTART:-backups/vast-onstart.sh}"
IMAGE="$(read_env VAST_IMAGE)";         IMAGE="${IMAGE:-docker.io/vastai/kvm:ubuntu_cli_22.04-2025-11-21}"
DISK="$(read_env VAST_DISK)";           DISK="${DISK:-60}"
MAX_PRICE="$(read_env VAST_MAX_PRICE)"; MAX_PRICE="${MAX_PRICE:-1.0}"
GPU_NAME="${GPU:-$(read_env VAST_GPU)}"
MIN_CPUS="${CPU:-0}";                   MIN_RAM_GB="${RAM:-0}"
case "$MIN_CPUS$MIN_RAM_GB" in *[!0-9]*) die "CPU= and RAM= are whole numbers (cores, GB).";; esac
SSH_KEY="$(read_env VAST_SSH_KEY)";     SSH_KEY="${SSH_KEY:-$HOME/.ssh/id_ed25519}"
# shellcheck disable=SC2088
case "$SSH_KEY" in "~/"*) SSH_KEY="$HOME/${SSH_KEY#\~/}" ;; esac
LABEL="colloq-vm${NAME:+-$NAME}"

[ -f "$ONSTART" ] || die "no on-start script at $ONSTART.
  Copy deploy/vast/onstart.sh there and fill in its settings block (image, relay)."
image_line="$(grep '^export COLLOQ_IMAGE=' "$ONSTART" || true)"
case "$image_line" in *OWNER*|*:VERSION*|*'=""') image_line="" ;; esac
[ -n "$image_line" ] || die "COLLOQ_IMAGE in $ONSTART is not filled in (ghcr.io/<owner>/colloq-vast:<version>)."
[ -f "$SSH_KEY" ] || die "no ssh key $SSH_KEY (VAST_SSH_KEY in .env)."

CURLRC="$(mktemp -t colloq-vast.XXXXXX)"
SCRIPT="$(mktemp -t colloq-onstart.XXXXXX)"
trap 'rm -f "$CURLRC" "$SCRIPT"' EXIT INT TERM
# HOST= picks the class address for this machine without editing the file: a
# relay name ("vsos" becomes vsos.<RELAY_DOMAIN>) or a full hostname.
cp "$ONSTART" "$SCRIPT"
if [ -n "${HOST:-}" ]; then
  HOST="$HOST" SCRIPT="$SCRIPT" py '
import os, re
path = os.environ["SCRIPT"]; text = open(path).read()
text, n = re.subn(r"^export COLLOQ_HOSTNAME=\"[^\"]*\"", "export COLLOQ_HOSTNAME=\"%s\"" % os.environ["HOST"], text, count=1, flags=re.M)
if not n: raise SystemExit("no COLLOQ_HOSTNAME line in the on-start")
open(path, "w").write(text)'
fi
ADDRESS="$(sed -n 's/^export COLLOQ_HOSTNAME="\(.*\)"/\1/p' "$SCRIPT")"
token="$(read_env VAST_TOKEN)"
[ -n "$token" ] || die "no VAST_TOKEN in .env (https://cloud.vast.ai/manage-keys/)."
printf 'header = "Authorization: Bearer %s"\n' "$token" > "$CURLRC"
unset token

# api METHOD PATH [BODY]: the body on stdout; any refusal ends the script.
# Vast answers a bad key with 404 and {"error":"auth_error"}, so the body decides.
api() {
  local text err
  if [ -n "${3:-}" ]; then
    text="$(curl -s --max-time 90 -K "$CURLRC" -X "$1" -H 'content-type: application/json' -d "$3" "$API/$2" || true)"
  else
    text="$(curl -s --max-time 90 -K "$CURLRC" -X "$1" "$API/$2" || true)"
  fi
  err="$(printf '%s' "$text" | py '
import json, sys
try: d = json.load(sys.stdin)
except Exception: raise SystemExit
if isinstance(d, dict) and d.get("error"): print(d["error"], (d.get("msg") or "").replace("\n", " "))
' || true)"
  [ -z "$err" ] || die "vast refused: $err"
  [ -n "$(printf '%s' "$text" | tr -d '[:space:]')" ] || die "vast answered with nothing. Try again in a minute."
  printf '%s' "$text"
}

if [ -n "${INSTANCE:-}" ]; then
  # Deploy onto a VM this account already rents (a new address, a new image).
  id="$INSTANCE"
  say "${BOLD}instance $id${OFF}: deploying ${ADDRESS:+for $ADDRESS }without renting"
else
# ---------------------------------------------------------------- offer
query="$(DISK="$DISK" MAX_PRICE="$MAX_PRICE" GPU_NAME="$GPU_NAME" MIN_CPUS="$MIN_CPUS" MIN_RAM_GB="$MIN_RAM_GB" py '
import json, os
q = {"vms_enabled": {"eq": True}, "type": "ondemand", "rentable": {"eq": True}, "rented": {"eq": False},
     "verified": {"eq": True}, "reliability": {"gte": 0.98}, "num_gpus": {"gte": 1},
     "disk_space": {"gte": float(os.environ["DISK"]) + 10},
     "dph_total": {"lte": float(os.environ["MAX_PRICE"])}, "order": [["dph_total", "asc"]], "limit": 60}
if os.environ["GPU_NAME"].strip(): q["gpu_name"] = {"in": [os.environ["GPU_NAME"].strip()]}
if int(os.environ["MIN_CPUS"]): q["cpu_cores_effective"] = {"gte": int(os.environ["MIN_CPUS"])}
if int(os.environ["MIN_RAM_GB"]): q["cpu_ram"] = {"gte": int(os.environ["MIN_RAM_GB"]) * 1024}
print(json.dumps(q))
')"
# cuda_max_good is checked on the answer, not in the query: the server-side
# filter hid RTX 5070/5090 offers in September 2026 (see vast-legacy.sh).
# The bundles API silently ignores an "id" condition, so OFFER is matched here.
suitable="$(api POST bundles/ "$query" | OFFER="${OFFER:-}" py '
import json, os, sys
offers = [o for o in json.load(sys.stdin).get("offers") or [] if float(o.get("cuda_max_good") or 0) >= 12.1]
if os.environ["OFFER"].strip(): offers = [o for o in offers if str(o["id"]) == os.environ["OFFER"].strip()]
for o in offers[:8]:
    print("    %-10s %s x %-12s %3.0f GB  %3.0f cores  %4.0f GB RAM  $%.3f/hr  %s" % (o["id"], o.get("num_gpus"),
          o.get("gpu_name"), (o.get("gpu_ram") or 0) / 1024, o.get("cpu_cores_effective") or 0,
          (o.get("cpu_ram") or 0) / 1024, o.get("dph_total") or 0, o.get("geolocation") or ""), file=sys.stderr)
for o in offers: print("%s\t%.3f\t%s x %s" % (o["id"], o.get("dph_total") or 0, o.get("num_gpus"), o.get("gpu_name")))
')"
[ -n "$suitable" ] || die "no VM offer matches: GPU \"${GPU_NAME:-any}\"${OFFER:+, offer $OFFER}${CPU:+, from $CPU cores}${RAM:+, from $RAM GB RAM}, up to \$$MAX_PRICE/hr, disk from $DISK GB."
IFS=$'\t' read -r offer_id price what <<<"$(printf '%s\n' "$suitable" | head -n 1)"
say ""
say "${BOLD}VM offer $offer_id${OFF}: $what, \$$price/hr, image $(sed -n 's/^export COLLOQ_IMAGE="\(.*\)"/\1/p' "$SCRIPT")${ADDRESS:+, address $ADDRESS}"
if [ "${FORCE:-}" != 1 ]; then
  [ -t 0 ] || die "no terminal to ask in. FORCE=1 rents without asking."
  printf '%srent it? [y/N] %s' "$BOLD" "$OFF"; read -r answer
  [ "$answer" = y ] || [ "$answer" = Y ] || die "not renting."
fi

# ----------------------------------------------------------------- rent
body="$(IMAGE="$IMAGE" DISK="$DISK" LABEL="$LABEL" SCRIPT="$SCRIPT" py '
import json, os
print(json.dumps({
    "image": os.environ["IMAGE"], "disk": float(os.environ["DISK"]),
    "vm": True,                     # the one field that makes it a VM
    "runtype": "ssh", "label": os.environ["LABEL"],
    "onstart": open(os.environ["SCRIPT"]).read(),
    "target_state": "running", "cancel_unavail": True,
}))')"
id="$(api PUT "asks/$offer_id/" "$body" | py 'import json, sys; print(json.load(sys.stdin).get("new_contract") or "")')"
[ -n "$id" ] || die "vast did not say what it rented; look at https://cloud.vast.ai/instances/"
say "${DIM}instance $id (label $LABEL); destroy with: vastai destroy instance $id${OFF}"
fi

# ----------------------------------------------------------------- wait
# A VM's actual_status stays "created" even once it runs (seen 28 Sep 2026), so
# readiness is "ssh lets us in", not a status value.
field() { api GET "instances/$id/" | py "import json, sys; d = json.load(sys.stdin).get('instances') or {}; print($1)"; }
say "waiting for the VM to boot and open ssh (a few minutes)…"
ip=""; port=""
for _ in $(seq 1 120); do
  case "$(field 'd.get("actual_status") or ""')" in exited|offline) die "the instance stopped: $(field 'd.get("status_msg")')";; esac
  # A broken host does not stop the instance, it parks it: cur_state "stopped"
  # and a status message starting with "Error" ("GPU error, unable to start
  # instance", "Machine incompatible with VMs after host change"; both seen on
  # 29 Sep 2026). Waiting the full 20 minutes for ssh would only bill the disk.
  # A machine this run rented is destroyed; one passed as INSTANCE= is left.
  msg="$(field '(d.get("status_msg") or "").strip() if d.get("cur_state") == "stopped" else ""')"
  case "$msg" in
    Error*|error*)
      if [ -z "${INSTANCE:-}" ]; then api DELETE "instances/$id/" >/dev/null; msg="$msg (destroyed; run again for another offer)"; fi
      die "vast: $msg" ;;
  esac
  read -r ip port <<<"$(field '(d.get("public_ipaddr") or "").strip(), ((d.get("ports") or {}).get("22/tcp") or [{}])[0].get("HostPort", "")' | tr -d "(),'")"
  [ -n "$port" ] && break
  sleep 10
done
[ -n "$port" ] || die "the VM got no ssh port in 20 minutes; see https://cloud.vast.ai/instances/"
ssh_run() { ssh -o BatchMode=yes -o ConnectTimeout=10 -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null \
  -o LogLevel=ERROR -o IdentitiesOnly=yes -i "$SSH_KEY" -p "$port" "root@$ip" "$@"; }
say "ssh:  ssh -i $SSH_KEY -p $port root@$ip"
for _ in $(seq 1 60); do ssh_run true 2>/dev/null && break; sleep 10; done
if ! ssh_run true 2>/dev/null; then
  # Seen on 29 Sep 2026: a host whose VM restarts in a loop (actual_status
  # flips between exited and running) and never opens ssh. A machine this run
  # rented is destroyed rather than left billing.
  [ -n "${INSTANCE:-}" ] || { api DELETE "instances/$id/" >/dev/null; die "ssh never let us in (the VM keeps restarting?); instance $id destroyed, run again for another offer"; }
  die "ssh does not let us in; see https://cloud.vast.ai/instances/ (vastai logs $id)"
fi
[ "$(ssh_run 'systemctl is-system-running 2>/dev/null || true')" != offline ] \
  || die "this is not a VM (no systemd): Vast started it as a Docker instance. Destroy it: vastai destroy instance $id"

# Vast does not run the on-start on a VM (the rent request carries it, but
# nothing executes it; seen 28 Sep 2026). Upload it and start it detached. It
# is idempotent: unchanged settings leave a running Colloq alone, changed ones
# (HOST=) recreate the container; colloq-host keeps it across reboots.
ssh_run 'umask 077; mkdir -p /etc/colloq; cat > /etc/colloq/onstart.sh' < "$SCRIPT"
ssh_run 'setsid nohup bash /etc/colloq/onstart.sh >/dev/null 2>&1 < /dev/null &'

# The on-start installs colloq-host and brings the container up on
# 127.0.0.1:3000; /api/health turns 200 once the default environment exists.
say "waiting for Colloq (the first boot builds the default Python environment)…"
for _ in $(seq 1 90); do
  ssh_run 'curl -sf -o /dev/null --max-time 5 http://127.0.0.1:3000/api/health' 2>/dev/null && break
  sleep 20
done
ssh_run 'curl -sf -o /dev/null --max-time 5 http://127.0.0.1:3000/api/health' 2>/dev/null \
  || say "${RED}Colloq is not healthy after 30 minutes; the log follows.${OFF}"
ssh_run 'colloq-host link 2>/dev/null || tail -30 /var/log/colloq-onstart.log'
say ""
say "on the VM: colloq-host status | logs | link | backup"
