#!/usr/bin/env bash
# Machines for another instance's submissions («машины для посылок») on
# rented Vast VMs (docs/architecture/remote-runners.md).
#
#   make vast-runner COUNT=3 CODE=<code> URL=https://vsos.colloq.ru   three VMs join that home
#   make vast-runner COUNT=2 GPU="RTX 4090" GPUS=2 DISK=150 CODE=… URL=…   with two 4090s each
#   make vast-runner … DESTROY_UNJOINED=1   a machine rented that did not join is destroyed at the end
#   make runners-update                   every machine to its home's version, its runs finished first
#   make runners-update URL=https://vsos.colloq.ru   only the machines of that home
#   make runners-update VERSION=0.24.0 NOW=1   to that one, handing the runs back right away
#   make runners-update FORCE=1           a machine already on its home's build too
#   make runners-down                     every machine leaves its home, then is destroyed
#   make runners-down URL=https://…       only the machines of that home
#   make runners-down NOW=1               destroyed at once: the home requeues its runs after 3 minutes
#
#   scripts/vast-runner.sh up | update | down
#
# CODE is the home owner's enrollment code (Resources, machines for
# submissions, «Подключить машину»; or colloq-host runner-code on the home),
# for at least COUNT machines. URL is the home; VAST_RUNNER_URL in .env names a
# usual one for `up` (the fleet commands take URL= from the command line only:
# a default there would quietly narrow, or widen, what is destroyed). GPU=,
# GPUS=, GPU_RAM=, CPU=, RAM=, DISK= and MAX_PRICE= are scripts/vast-vm.sh's
# filters, per machine. NAME= labels the batch colloq-runner-<NAME>, and the
# fleet commands then take only that batch.
#
# ONE WAY TO RENT. `up` runs COUNT copies of scripts/vast-vm.sh with
# ROLE=runner: the same rent request with "vm": true, the same offer filters
# and Max CUDA floor, the same handling of hosts that break. Each copy fills in
# nothing of its own: the on-start is deploy/vast/onstart-runner.sh with the
# home's address and the code written in, and nothing else. In particular no
# RELAY_TOKEN: a machine opens no address, and a rented VM's on-start is read
# by its host's operator and kept in Vast's console. The code it does carry
# is worth nothing a day later, and nothing once COUNT machines have used it.
#
# RENTED ONE AFTER ANOTHER, BOOTED TOGETHER. Each copy rents the cheapest
# offer that passes the filters, so two copies searching at once rent, or try
# to rent, the same one. A copy therefore starts only once the one before it
# holds its instance (its log says so), by which time the market no longer
# offers that machine; one refused for an offer that vanished all the same is
# tried again. The boots, minutes each (the image, the join), overlap, which
# is where the time goes.
#
# RENTED BUT NOT JOINED. A machine whose copy got an instance but never saw it
# join (the home did not answer, the code ran out of uses) bills by the hour
# like any other, and nothing else takes it down: it is in no home's panel.
# The run ends naming each such machine with the command that destroys it,
# and DESTROY_UNJOINED=1 destroys them itself. One the copy destroyed already
# (a broken host, scripts/vast-vm.sh) is said to be gone.
#
# WHICH MACHINES THE FLEET COMMANDS TAKE. Those labelled colloq-runner or
# colloq-runner-<NAME> on Vast, and nothing else of the account. A label says
# nothing of the home, though, and one account may rent machines for two
# homes (vsos and a lab's): so each machine is asked over ssh which home it
# serves, COLLOQ_RUNNER_JOIN in its /etc/colloq/runner.env up to the # (the
# code never leaves the machine), with the agent's status beside it. The list
# shows each machine's home before anything happens, and URL= keeps only the
# machines of that home; a machine whose home is not known (no ssh, no
# runner.env) is left out of a URL= run, and said so. Without URL= every
# machine is taken, as before; but VERSION= for machines of several homes is
# refused, since it would move some of them off their own home's version.
#
# UPDATE. `colloq-host runner update` drains a machine (the runs it holds
# finish, it takes no new ones) and restarts it on the home's version, since a
# machine whose runner code differs from its home's is «устарел» and gets no
# work (decision 5). A release that leaves the runner code alone keeps the
# fleet serving (§8.4), and draining a machine for it would only idle it for
# as long as its longest run: so a machine whose home has just said its build
# is the home's own (`compatible` in its agent's status) is left as it is,
# unless FORCE=1. Just said: in a sync made after this run asked, which the
# survey waits for, up to RUNNER_SURVEY_SEC (60) seconds. The status keeps
# the word of the last sync it had, and "right after the home", as the docs
# have it, that is the home that was: its container replaced, its tunnel
# back seconds later, the agent hearing relay pages meanwhile. A machine
# skipped on that word was «устарел» from its next sync on, while this
# script reported every machine on its home's build (review, 14 Oct 2026).
# One that gives no fresh word is updated, and colloq-host decides there.
# VERSION= names the version for every machine and skips none: colloq-host
# itself does nothing for one already on it.
#
# A drain lasts up to four hours and a laptop's ssh does not, and an ssh that
# drops kills what it runs: halfway through an update that is a machine
# stopped and never started again, billing for nothing. So the update runs
# detached on the machine (setsid and nohup, its log and exit code under
# /var/log/colloq-runner-update), and this script polls it over short ssh
# calls. A dropped poll costs nothing but the poll; the same command run again
# follows an update already running there instead of starting a second.
#
# DOWN. `colloq-host runner leave` drains a machine and revokes it on the
# home, and only then is the VM destroyed. NOW=1 skips the wait: a destroyed
# machine that did not leave is lost to its home after three minutes of
# silence, its runs requeued spending no participant's attempts, while the
# machine stays in the panel until the owner revokes it. A leave cut short by
# a dropped ssh ends the same way, which is why it is not detached. A leave
# ends with the home's answer, and colloq-host waits for it only while the
# home answers: after ten minutes without a word from it (a home destroyed
# before its machines, a tunnel down) the leave is given up, said so, and the
# VM destroyed all the same, rather than billing while this waits for good.
#
# Reads from .env: VAST_TOKEN, VAST_SSH_KEY, VAST_MAX_PRICE, VAST_RUNNER_URL.
# The token and the code are never printed. Logs of the copies go to
# logs/vast-runner/<time>/ (RUNNER_LOGS= for another directory); a copy refused
# for a vanished offer searches again after RENT_RETRY_SEC (20) seconds. An
# update is polled every RUNNER_POLL_SEC (15) seconds, for at most
# RUNNER_FOLLOW_SEC (18000: the longest drain and then some); before it, each
# machine's agent is given RUNNER_SURVEY_SEC (60) seconds for a fresh sync.
set -euo pipefail

cd "$(dirname "$0")/.."

RED=$'\033[31m'; DIM=$'\033[2m'; BOLD=$'\033[1m'; OFF=$'\033[0m'
say() { printf '%s\n' "$*"; }
warn() { printf '%s%s%s\n' "$RED" "$*" "$OFF" >&2; }
die() { printf '%s%s%s\n' "$RED" "$*" "$OFF" >&2; exit 1; }
py() { python3 -c "$1"; }
. ./scripts/lib.sh

API=https://console.vast.ai/api/v0
BASE_LABEL=colloq-runner
# NAME becomes a label on Vast and a word the copies' logs are searched for.
name_re='^[a-z0-9]([a-z0-9-]{0,30}[a-z0-9])?$'
[ -z "${NAME:-}" ] || [[ "$NAME" =~ $name_re ]] || die "NAME= is a short word (lowercase letters, digits, hyphens), not \"$NAME\"."
LABEL="$BASE_LABEL${NAME:+-$NAME}"
SSH_KEY="$(read_env VAST_SSH_KEY)"; SSH_KEY="${SSH_KEY:-$HOME/.ssh/id_ed25519}"
# shellcheck disable=SC2088
case "$SSH_KEY" in "~/"*) SSH_KEY="$HOME/${SSH_KEY#\~/}" ;; esac

CURLRC=""
SCRIPT=""
SURVEY=""
cleanup() { rm -f "$CURLRC" "$SCRIPT"; [ -z "$SURVEY" ] || rm -rf "$SURVEY"; }
trap cleanup EXIT

# The Vast key in a curl config file, never on a command line (ps sees those).
open_api() {
  local token
  token="$(read_env VAST_TOKEN)"
  [ -n "$token" ] || die "no VAST_TOKEN in .env (https://cloud.vast.ai/manage-keys/)."
  CURLRC="$(mktemp -t colloq-vast.XXXXXX)"
  printf 'header = "Authorization: Bearer %s"\n' "$token" > "$CURLRC"
  [ -f "$SSH_KEY" ] || die "no ssh key $SSH_KEY (VAST_SSH_KEY in .env)."
}

# api METHOD PATH [BODY], as in scripts/vast-vm.sh: the body on stdout; any
# refusal ends the call. Vast answers a bad key with 404 and an "error", so the
# body decides.
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

ssh_to() {
  local host="$1" port="$2"; shift 2
  ssh -o BatchMode=yes -o ConnectTimeout=15 -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null \
    -o LogLevel=ERROR -o IdentitiesOnly=yes -o ServerAliveInterval=30 -o ServerAliveCountMax=10 \
    -i "$SSH_KEY" -p "$port" "root@$host" "$@"
}

# Every line of a copy on the terminal too, marked with whose it is.
prefix() {
  local line
  while IFS= read -r line; do printf '%s[%s]%s %s\n' "$DIM" "$1" "$OFF" "$line"; done
}

# The machines of this fleet: id, ssh host, ssh port, state, label, one per
# line, separated by \037 rather than a tab (a tab is whitespace to `read`, and
# an empty field, a machine not running, would shift the rest; vast.sh says
# more). A VM's ssh is its own port map, not the ssh_host proxy (vast.sh ·
# instances_tsv). Nothing but colloq-runner labels: every other instance of
# the account is none of this script's business.
runner_instances() {
  local raw
  raw="$(api GET "instances/")"
  printf '%s' "$raw" | BASE="$BASE_LABEL" WANT="${NAME:+$LABEL}" py '
import json, os, sys
base, want = os.environ["BASE"], os.environ.get("WANT") or ""
for i in sorted(json.load(sys.stdin).get("instances") or [], key=lambda i: i.get("id") or 0):
    label = i.get("label") or ""
    if want and label != want: continue
    if not want and label != base and not label.startswith(base + "-"): continue
    host, port = str(i.get("public_ipaddr") or "").strip(), ""
    for m in ((i.get("ports") or {}).get("22/tcp") or []):
        if m.get("HostPort"):
            port = str(m["HostPort"]); break
    cells = [str(i.get("id") or ""), host, port, str(i.get("actual_status") or ""), label]
    print("\x1f".join(c.replace("\x1f", " ").replace("\n", " ") for c in cells))
'
}

# The home as the agent keeps it: an http(s) origin and nothing after it
# (colloq-host · check_home, remote-runner.ts · homeOrigin).
check_home() {
  local rest re='^[A-Za-z0-9]([A-Za-z0-9.-]*[A-Za-z0-9])?(:[0-9]{1,5})?$'
  case "$1" in
    https://*|http://*) rest="${1#*://}" ;;
    *) die "URL=$1: the home's address starts with https://" ;;
  esac
  [[ "$rest" =~ $re ]] || die "URL=$1 is not a home's address: its origin alone, like https://vsos.colloq.ru"
}

number() { [[ "$1" =~ ^[0-9]+([.][0-9]+)?$ ]]; }

# --------------------------------------------------------------------- up
up() {
  local count="${COUNT:-1}" code="${CODE:-}" url="${URL:-}" disk max_price answer k try id status rented joined unjoined=""
  local code_re='^[a-f0-9]{32}$'
  case "$count" in ''|*[!0-9]*) die "COUNT= is how many machines to rent, 1 to 16, not \"$count\"." ;; esac
  [ "$count" -ge 1 ] && [ "$count" -le 16 ] || die "COUNT= is how many machines to rent, 1 to 16, not \"$count\"."
  [ -n "$code" ] || die "CODE= is the enrollment code from the home's owner (its panel: Resources, machines for submissions; or colloq-host runner-code there)."
  [[ "$code" =~ $code_re ]] || die "CODE= is not an enrollment code: 32 hex digits from the home's owner."
  [ -n "$url" ] || url="$(read_env VAST_RUNNER_URL)"
  [ -n "$url" ] || die "URL= names the home these machines join (https://vsos.colloq.ru), or VAST_RUNNER_URL in .env."
  url="${url%/}"
  check_home "$url"
  # A machine with cards is asked for the GPU kernels, and every Vast VM has a
  # card: the floor of one with cards (remote-runner.ts · REMOTE_DISK_MIN_GB).
  disk="${DISK:-120}"
  number "$disk" || die "DISK= is a size in GB, not \"$disk\"."
  max_price="${MAX_PRICE:-$(read_env VAST_MAX_PRICE)}"; max_price="${max_price:-1.0}"
  number "$max_price" || die "MAX_PRICE= (VAST_MAX_PRICE in .env) is dollars per hour, not \"$max_price\"."
  [ -f deploy/vast/onstart-runner.sh ] || die "no deploy/vast/onstart-runner.sh in this checkout."
  open_api

  SCRIPT="$(mktemp -t colloq-runner-onstart.XXXXXX)"
  cp deploy/vast/onstart-runner.sh "$SCRIPT"
  URL="$url" CODE="$code" SCRIPT="$SCRIPT" py '
import os, re
path = os.environ["SCRIPT"]; text = open(path).read()
for key, value in (("COLLOQ_RUNNER_URL", os.environ["URL"]), ("COLLOQ_RUNNER_CODE", os.environ["CODE"])):
    text, n = re.subn(r"^export %s=\"[^\"]*\"" % key, "export %s=\"%s\"" % (key, value), text, count=1, flags=re.M)
    if not n: raise SystemExit("no %s line in deploy/vast/onstart-runner.sh" % key)
open(path, "w").write(text)'

  local what="GPU ${GPU:-any}${GPUS:+, from $GPUS cards}${GPU_RAM:+, from $GPU_RAM GB per card}${CPU:+, from $CPU cores}${RAM:+, from $RAM GB RAM}, disk $disk GB, up to \$$max_price/hr each"
  say "${BOLD}$count machine(s) for $url${OFF}: $what, label $LABEL"
  if [ "${FORCE:-}" != 1 ]; then
    [ -t 0 ] || die "no terminal to ask in. FORCE=1 rents without asking."
    printf '%srent %s? [y/N] %s' "$BOLD" "$count" "$OFF"; read -r answer
    [ "$answer" = y ] || [ "$answer" = Y ] || die "not renting."
  fi

  LOGS="${RUNNER_LOGS:-logs/vast-runner/$(date +%Y%m%d-%H%M%S)}"
  mkdir -p "$LOGS"
  trap 'warn "interrupted: the machines rented so far stay rented (make runners-down destroys them)"; exit 130' INT TERM

  local pids=()
  for k in $(seq 1 "$count"); do
    try=1
    while :; do
      start_copy "$k" "$disk" "$max_price"
      pids[k]="$COPY_PID"
      if wait_rented "$k"; then break; fi
      # Refused after an offer was found: the offer went to another renter (or
      # to the copy before this one) between the search and the rent.
      if [ "$try" -lt 3 ] && grep -q 'VM offer [0-9]' "$LOGS/runner-$k.log"; then
        try=$((try + 1))
        say "${DIM}[$k] the offer was gone; searching again in ${RENT_RETRY_SEC:-20} s (try $try of 3)${OFF}"
        sleep "${RENT_RETRY_SEC:-20}"
        continue
      fi
      break
    done
  done
  for k in $(seq 1 "$count"); do wait "${pids[k]}" 2>/dev/null || true; done

  say ""
  joined=0
  for k in $(seq 1 "$count"); do
    id="$(rented_in "$LOGS/runner-$k.log")"
    status="$(cat "$LOGS/runner-$k.log.exit" 2>/dev/null || echo 1)"
    if [ -n "$id" ] && [ "$status" = 0 ]; then
      say "  $k  instance $id  joined"; joined=$((joined + 1))
    elif [ -n "$id" ] && destroyed_in "$LOGS/runner-$k.log" "$id"; then
      say "  $k  instance $id  ${RED}not joined, and destroyed already${OFF} (a host that broke): $LOGS/runner-$k.log"
    elif [ -n "$id" ]; then
      say "  $k  instance $id  ${RED}rented, not joined${OFF}: $LOGS/runner-$k.log"
      unjoined="$unjoined $id"
    else
      rented="$(grep -v '^[[:space:]]*$' "$LOGS/runner-$k.log" | tail -1 | sed $'s/\033\\[[0-9;]*m//g' || true)"
      say "  $k  ${RED}not rented${OFF}: ${rented:-see $LOGS/runner-$k.log}"
    fi
  done
  say ""
  [ -z "$unjoined" ] || destroy_unjoined $unjoined
  say "$joined of $count joined $url; logs: $LOGS. Fleet: make runners-update · make runners-down"
  [ "$joined" = "$count" ]
}

# One copy of scripts/vast-vm.sh, in the background: its whole log in a file
# of its own, its lines on the terminal, its exit code in <log>.exit. Only the
# filters go along: no HOST, OFFER or INSTANCE from this shell (COUNT copies
# of one offer would all go for the same machine).
COPY_PID=""
start_copy() {
  local k="$1" disk="$2" max_price="$3" log="$LOGS/runner-$1.log"
  : > "$log"; rm -f "$log.exit"
  (
    set +e
    HOST="" OFFER="" INSTANCE="" ROLE=runner FORCE=1 ONSTART="$SCRIPT" NAME="${NAME:-}" \
      GPU="${GPU:-}" GPUS="${GPUS:-}" GPU_RAM="${GPU_RAM:-}" CPU="${CPU:-}" RAM="${RAM:-}" \
      DISK="$disk" MAX_PRICE="$max_price" bash ./scripts/vast-vm.sh </dev/null 2>&1 | tee -a "$log" | prefix "$k"
    echo "${PIPESTATUS[0]}" > "$log.exit"
  ) &
  COPY_PID=$!
}

# The instance a copy rented, from its own line (vast-vm.sh: "instance <id> (label …").
rented_in() {
  { grep -Eo "instance [0-9]+ \\(label $LABEL\\)" "$1" 2>/dev/null || true; } | head -1 | sed -E 's/^instance ([0-9]+).*/\1/'
}

# Whether the copy destroyed the instance itself, by its own words: a host
# that parked it with an error ("(destroyed; run again for another offer)"),
# or one whose ssh never let it in ("instance <id> destroyed").
destroyed_in() {
  grep -qE "\\(destroyed; run again|instance $2 destroyed" "$1" 2>/dev/null
}

# Until the copy holds its instance (0) or has ended without one (1).
wait_rented() {
  local log="$LOGS/runner-$1.log"
  while :; do
    [ -z "$(rented_in "$log")" ] || return 0
    if [ -f "$log.exit" ]; then [ -n "$(rented_in "$log")" ]; return; fi
    sleep 1
  done
}

# The machines rented that never joined: destroyed under DESTROY_UNJOINED=1,
# named with the command that destroys them otherwise. Each destroy is asked
# on its own (a subshell takes api's refusal), so one that fails is said and
# the others still go.
destroy_unjoined() {
  local id
  if [ "${DESTROY_UNJOINED:-}" = 1 ]; then
    for id in "$@"; do
      if ( api DELETE "instances/$id/" >/dev/null ); then say "  instance $id destroyed (DESTROY_UNJOINED=1): it no longer bills"
      else warn "  instance $id could not be destroyed (above); destroy it with: vastai destroy instance $id"
      fi
    done
  else
    say "${RED}rented but not joined, these bill by the hour until destroyed:${OFF}"
    for id in "$@"; do say "  vastai destroy instance $id"; done
    say "${DIM}or at https://cloud.vast.ai/instances/; DESTROY_UNJOINED=1 on make vast-runner destroys such machines at the end of the run${OFF}"
  fi
  say ""
}

# ----------------------------------------------------- the fleet over ssh

# Run TASK for every machine of the fleet at once, each one's lines marked
# with its instance id; the exit code says whether all of them succeeded.
FLEET=""
for_each_machine() {
  local task="$1" id host port status label home verdict pids=() ids=() logs failed=0 i
  logs="$(mktemp -d -t colloq-runners.XXXXXX)"
  while IFS=$'\037' read -r id host port status label home verdict; do
    [ -n "$id" ] || continue
    (
      set +e
      "$task" "$id" "$host" "$port" "$status" "$label" "$home" "$verdict" 2>&1 | prefix "$id"
      echo "${PIPESTATUS[0]}" > "$logs/$id.exit"
    ) &
    pids+=("$!"); ids+=("$id")
  done <<EOF
$FLEET
EOF
  for i in "${!pids[@]}"; do wait "${pids[i]}" 2>/dev/null || true; done
  for id in ${ids[@]+"${ids[@]}"}; do
    [ "$(cat "$logs/$id.exit" 2>/dev/null || echo 1)" = 0 ] || failed=$((failed + 1))
  done
  rm -rf "$logs"
  [ "$failed" = 0 ]
}

# What a machine says of itself, in one ssh call run as `bash -s -- WAIT`:
# its home, the moment it was asked (ms, the machine's own clock, the one
# its agent writes syncedAt by) and its agent's status line. The status goes
# first: on a machine joined with the panel's plain `docker run`,
# colloq-host's status writes runner.env out of the container (colloq-host ·
# adopt_runner), and the home is read from there. With WAIT, an update's, a
# working agent is given that many seconds for a sync made after it was
# asked, so that what the line says of the home's word on its build is the
# home's word now (UPDATE above says why); a machine whose agent does not
# work (stopped, refused, no container) is not waited for. The marker
# comment is how tests/vast-runner-fleet.test.mts tells the scripts apart.
SURVEY_SCRIPT='# colloq-runner-fleet: survey
# One group, read whole before a word of it runs: the script comes on
# stdin, and bash 3.2 lost its place in it once a child shared that stdin.
{
bound="${1:-0}"
asked="$(date +%s)000"
while :; do
  s="$(colloq-host runner status 2>/dev/null | grep "^{" | tail -1)"
  at="$(printf "%s" "$s" | sed -n "s/.*\"syncedAt\":\([0-9][0-9]*\).*/\1/p")"
  [ -z "$at" ] || [ "$at" -lt "$asked" ] || break
  case "$s" in *"\"state\":\"active\""*|*"\"state\":\"draining\""*|*"\"state\":\"leaving\""*) ;; *) break ;; esac
  [ "$bound" -gt 0 ] || break
  sleep 2; bound=$((bound - 2))
done
h="$(sed -n "s/^COLLOQ_RUNNER_JOIN=\([^#]*\)#.*/\1/p" /etc/colloq/runner.env 2>/dev/null | tail -1)"
printf "home %s\nasked %s\nstatus %s\n" "$h" "$asked" "$s"
exit
}'

# The seconds the survey gives each agent for a fresh sync: RUNNER_SURVEY_SEC
# for an update (update() checks it), none for a look or a leave.
SURVEY_WAIT=0

survey_one() {
  local id="$1" host="$2" port="$3" status="$4" out=""
  if [ -z "$host" ] || [ -z "$port" ]; then
    say "instance $id is $status and has no ssh: its home is not known"
  elif ! out="$(ssh_to "$host" "$port" "bash -s -- $SURVEY_WAIT" <<<"$SURVEY_SCRIPT")"; then
    say "no answer over ssh: its home is not known"
  fi
  printf '%s\n' "$out" > "$SURVEY/$id"
}

# FLEET with each machine's home and verdict after its five fields, and only
# the machines of URL= when it is given; the others are named on stderr. The
# verdict reads the agent's status: `current` when its home said, in a sync
# made after the survey asked, that the machine's build is its own
# (compatible); `outdated` when home said it is not; `unknown` otherwise,
# which an update treats as outdated (colloq-host decides on the machine).
# No `current` from an older word, and none from the agent's version against
# its home's: that too is the last sync's, and one version may be two builds
# (a fork's image and the published one).
FLEET_PY='
import json, os, sys
survey, want = os.environ["SURVEY"], (os.environ.get("WANT") or "").rstrip("/")
for line in sys.stdin:
    cells = line.rstrip("\n").split("\x1f")
    if len(cells) < 5 or not cells[0]: continue
    home = status = asked = ""
    try:
        with open(os.path.join(survey, cells[0])) as f:
            for row in f:
                if row.startswith("home "): home = row[5:].strip().rstrip("/")
                elif row.startswith("asked "): asked = row[6:].strip()
                elif row.startswith("status "): status = row[7:].strip()
    except OSError:
        pass
    try: said = json.loads(status) if status else None
    except ValueError: said = None
    verdict = "unknown"
    if isinstance(said, dict) and said.get("joined") is True:
        synced = said.get("syncedAt")
        fresh = type(synced) is int and asked.isdigit() and synced >= int(asked)
        if said.get("compatible") is False: verdict = "outdated"
        elif said.get("compatible") is True and fresh: verdict = "current"
    if want and home != want:
        print("  instance %s  %s  left alone: %s" % (cells[0], cells[4], ("its home is " + home) if home else "its home is not known"), file=sys.stderr)
        continue
    print("\x1f".join(cells[:5] + [home, verdict]))
'

load_fleet() {
  local want="${URL:-}"
  if [ -n "$want" ]; then want="${want%/}"; check_home "$want"; fi
  open_api
  FLEET="$(runner_instances)"
  if [ -z "$FLEET" ]; then
    say "no machines for submissions are rented (label $LABEL${NAME:+}; others: ${BASE_LABEL}-*)"
    exit 0
  fi
  SURVEY="$(mktemp -d -t colloq-runners-survey.XXXXXX)"
  if [ "$SURVEY_WAIT" -gt 0 ]; then
    say "${DIM}asking each machine which home it serves, and its home's word on its build in a sync from now on (up to $SURVEY_WAIT s)…${OFF}"
  else
    say "${DIM}asking each machine which home it serves…${OFF}"
  fi
  for_each_machine survey_one || true
  [ -z "$want" ] || say "${DIM}only the machines of $want (URL=):${OFF}"
  FLEET="$(printf '%s\n' "$FLEET" | SURVEY="$SURVEY" WANT="$want" py "$FLEET_PY")"
  rm -rf "$SURVEY"; SURVEY=""
  if [ -z "$FLEET" ]; then
    say "no machine serves $want"
    exit 0
  fi
}

# The machines about to be acted on, with their homes (and, for an update,
# whether each is on its home's build already).
show_fleet() {
  local with="${1:-}" id host port status label home verdict note
  while IFS=$'\037' read -r id host port status label home verdict; do
    [ -n "$id" ] || continue
    note=""
    if [ "$with" = verdict ]; then
      case "$verdict" in current) note="  (on its home's build)" ;; outdated) note="  (outdated)" ;; esac
    fi
    say "  instance $id  $label  $status${host:+  $host:$port}  home ${home:-not known}$note"
  done <<EOF
$FLEET
EOF
}

# The update itself, run on the machine by `bash -s -- [VERSION] [--now]`:
# detached, so that it outlives the ssh that started it, or not started at all
# when one is running there already (an earlier run of this script whose
# connection dropped), which is then followed instead. The detached shell
# writes its own pid (setsid may fork) and, at the end, colloq-host's exit
# code; its log is what the polls print.
UPDATE_START='# colloq-runner-fleet: start the update
# One group, read whole before a word of it runs: the script comes on
# stdin, and bash 3.2 lost its place in it once a child shared that stdin.
{
d=/var/log/colloq-runner-update
mkdir -p "$d"
alive() { p="$(cat "$d/pid" 2>/dev/null)"; [ -n "$p" ] && tr "\000" " " 2>/dev/null < "/proc/$p/cmdline" | grep -q "colloq-host runner update"; }
if [ ! -f "$d/exit" ] && alive; then
  echo "an update is running here already; following it"
  exit 0
fi
rm -f "$d/exit" "$d/pid"
: > "$d/log"
setsid nohup bash -c '"'"'echo "$$" > "$0/pid"; colloq-host runner update "$@" > "$0/log" 2>&1; echo "$?" > "$0/exit"'"'"' "$d" "$@" < /dev/null > /dev/null 2>&1 &
for _ in 1 2 3 4 5 6 7 8 9 10; do [ -s "$d/pid" ] && break; sleep 0.5; done
if [ ! -s "$d/pid" ] && [ ! -f "$d/exit" ]; then echo "the detached update did not start (no setsid or nohup here?)" >&2; exit 1; fi
echo "colloq-host runner update${*:+ $*} runs detached on this machine: it goes on if this connection drops"
exit
}'

# One poll, run on the machine by `bash -s -- SEEN`: the lines of the log past
# the SEEN already printed, then a marker line, \037<lines> <state>, where the
# state is `exit <code>`, `running`, or `gone` (no exit code and no process:
# the machine rebooted under it). The exit file is looked at first, so that
# once it is there the lines printed are the whole log.
UPDATE_POLL='# colloq-runner-fleet: poll the update
# One group, read whole before a word of it runs: the script comes on
# stdin, and bash 3.2 lost its place in it once a child shared that stdin.
{
d=/var/log/colloq-runner-update
seen="${1:-0}"
alive() { p="$(cat "$d/pid" 2>/dev/null)"; [ -n "$p" ] && tr "\000" " " 2>/dev/null < "/proc/$p/cmdline" | grep -q "colloq-host runner update"; }
if [ -f "$d/exit" ]; then state="exit $(cat "$d/exit")"
elif alive; then state=running
else state=gone
fi
total="$(wc -l 2>/dev/null < "$d/log" | tr -d " ")"; total="${total:-0}"
[ "$total" -le "$seen" ] || sed -n "$((seen + 1)),${total}p" "$d/log"
printf "\037%s %s\n" "$total" "$state"
exit
}'

# Polls the update until it ends, printing its lines as they come. A poll
# that gets no answer is retried; only a long silence ends the following, and
# never the update, which a later `make runners-update` follows again.
follow_update() {
  local host="$1" port="$2" seen=0 out marker state lines fails=0 began=$SECONDS
  local poll="${RUNNER_POLL_SEC:-15}" bound="${RUNNER_FOLLOW_SEC:-18000}" tries="${RUNNER_POLL_TRIES:-40}"
  while :; do
    marker=""
    if out="$(ssh_to "$host" "$port" "bash -s -- $seen" <<<"$UPDATE_POLL")"; then
      marker="$(printf '%s\n' "$out" | sed -n $'s/^\037//p' | tail -1)"
    fi
    if [ -n "$marker" ]; then
      fails=0
      printf '%s\n' "$out" | grep -v $'^\037' || true
      lines="${marker%% *}"; state="${marker#* }"
      case "$lines" in ''|*[!0-9]*) ;; *) seen="$lines" ;; esac
      case "$state" in
        'exit 0') return 0 ;;
        exit\ *) say "colloq-host runner update ended with code ${state#exit } (its words are above)"; return 1 ;;
        gone) say "the update stopped without finishing (the machine rebooted?): the log is /var/log/colloq-runner-update/log there"; return 1 ;;
      esac
    else
      fails=$((fails + 1))
      if [ "$fails" -ge "$tries" ]; then
        say "no answer from the machine for $tries polls; the update goes on there, and make runners-update follows it again"
        return 1
      fi
      say "${DIM}no answer over ssh (poll $fails of $tries); the update goes on on the machine${OFF}"
    fi
    if [ $((SECONDS - began)) -ge "$bound" ]; then
      say "still updating after $((bound / 60)) min; it goes on there: ssh to it and tail /var/log/colloq-runner-update/log"
      return 1
    fi
    sleep "$poll"
  done
}

update_one() {
  local id="$1" host="$2" port="$3" status="$4" home="$6" verdict="$7" args=""
  if [ -z "$host" ] || [ -z "$port" ]; then
    say "instance $id is $status and has no ssh: start it on Vast, then run this again"; return 1
  fi
  if [ -z "${VERSION:-}" ] && [ "${FORCE:-}" != 1 ] && [ "$verdict" = current ]; then
    say "its runner build is already its home's${home:+ ($home)}: left as it is (FORCE=1 updates it all the same)"
    return 0
  fi
  # Words of a remote command line: VERSION is checked in update() to hold no
  # character a shell would read as anything but itself.
  [ -z "${VERSION:-}" ] || args="$VERSION"
  [ -z "$NOW_FLAG" ] || args="${args:+$args }$NOW_FLAG"
  ssh_to "$host" "$port" "bash -s --${args:+ $args}" <<<"$UPDATE_START" || { say "the update could not be started there (above)"; return 1; }
  follow_update "$host" "$port"
}

update() {
  local version_re='^[A-Za-z0-9._:/@-]*$' target how homes
  [[ "${VERSION:-}" =~ $version_re ]] || die "VERSION= is a version (0.24.0) or an image, not \"${VERSION:-}\"."
  NOW_FLAG=""; [ "${NOW:-}" != 1 ] || NOW_FLAG=--now
  # Spelled out rather than as ${VERSION:-…} defaults: bash 3.2, the Mac's,
  # reads an apostrophe inside ${…} as a quote even within double quotes.
  target="${VERSION:-}"; [ -n "$target" ] || target="the version of their home"
  how=", their runs finished first"; [ -z "$NOW_FLAG" ] || how=", handing their runs back now"
  # The wait for each home's fresh word, only where it can spare a machine
  # its drain: VERSION= and FORCE=1 skip none.
  if [ -z "${VERSION:-}" ] && [ "${FORCE:-}" != 1 ]; then
    SURVEY_WAIT="${RUNNER_SURVEY_SEC:-60}"
    case "$SURVEY_WAIT" in ''|*[!0-9]*) die "RUNNER_SURVEY_SEC= is a number of seconds, not \"$SURVEY_WAIT\"." ;; esac
  fi
  load_fleet
  say "${BOLD}updating $(printf '%s\n' "$FLEET" | grep -c .) machine(s)${OFF} to $target$how:"
  show_fleet verdict
  if [ -n "${VERSION:-}" ]; then
    homes="$(printf '%s\n' "$FLEET" | awk -F $'\037' '$6 != "" { print $6 }' | sort -u | grep -c . || true)"
    [ "$homes" -le 1 ] \
      || die "these machines serve $homes homes, and VERSION=$VERSION would move all of them: name one with URL= (without VERSION= each follows its own home)."
  fi
  # Without VERSION= a machine left alone may run an older release with its
  # home's build, which is what counts (§8.4), so that is what is said.
  if for_each_machine update_one; then
    if [ -n "${VERSION:-}" ]; then say "every machine is on $VERSION"; else say "every machine runs its home's runner build"; fi
  else die "some machines did not update (their lines above); the others are done"
  fi
}

# Destroyed in any case (a machine that cannot leave still bills by the hour),
# and said so when it did not leave first: its home still lists it until the
# owner revokes it, and that is worth a non-zero exit. NOW=1 asks for exactly
# that, so there it is no failure.
down_one() {
  local id="$1" host="$2" port="$3" status="$4" left=0
  if [ "${NOW:-}" = 1 ]; then
    say "destroying without leaving (NOW=1)"
  elif [ -z "$host" ] || [ -z "$port" ]; then
    say "instance $id is $status and has no ssh: it cannot leave its home"
  elif ssh_to "$host" "$port" 'colloq-host runner leave'; then
    left=1
  else
    say "it did not leave its home (above)"
  fi
  api DELETE "instances/$id/" >/dev/null
  say "instance $id destroyed"
  [ "$left" != 1 ] || return 0
  say "its home still lists it: revoke it there (Resources, machines for submissions); until then it shows as silent, and its runs went back to the queue after 3 minutes"
  [ "${NOW:-}" = 1 ]
}

down() {
  local answer
  load_fleet
  say "${BOLD}these machines leave their home and are destroyed, with their disks:${OFF}"
  show_fleet
  if [ "${FORCE:-}" != 1 ]; then
    [ -t 0 ] || die "no terminal to ask in. FORCE=1 destroys without asking."
    printf '%sdestroy them? [y/N] %s' "$BOLD" "$OFF"; read -r answer
    [ "$answer" = y ] || [ "$answer" = Y ] || die "nothing destroyed."
  fi
  if for_each_machine down_one; then say "done: the fleet is gone"
  else die "not every machine left its home or was destroyed (their lines above): revoke what its home still lists in the panel, and see https://cloud.vast.ai/instances/"
  fi
}

case "${1:-}" in
  up) up ;;
  update) update ;;
  down) down ;;
  *) die "usage: scripts/vast-runner.sh up | update | down   (make vast-runner · runners-update · runners-down)" ;;
esac
