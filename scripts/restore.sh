#!/usr/bin/env bash
#
# Restore a backup — the pair to `make backup`.
#
#   scripts/restore.sh                     the most recent pair from backups/
#   scripts/restore.sh backups/colloq-20260905-120000.db
#   NAME=demo scripts/restore.sh          the most recent pair of deployment demo
#
# About NAME. There can be several deployments — one rented machine each — and
# their backups are laid out in subdirectories: backups/demo/, backups/hse/.
# Without NAME we look in the root of backups/: those are the backups of the
# local instance, which has no name. That is exactly why "the most recent" is
# looked for in one directory and not in all of them at once: restoring
# another seminar's database means another seminar's notebooks, teachers, and
# links that lead into someone else's files — and silently.
#
# Why this is a separate command. `make backup` takes the database and an
# archive of seminar files, while the way back was until now described with
# the words "put the two files in place". There are actually three places, and
# one of them can quietly corrupt the database: in WAL mode colloq.db-wal and
# colloq.db-shm lie next to colloq.db, and if you slip in the database from a
# backup and leave the old journal, sqlite will roll foreign pages onto it. So
# the journal leaves together with the database it describes, rather than
# being thrown away or left behind.
#
# What survives re-creating the machine and is in the backup:
#
#   colloq.db          seminars, teachers, version history, Oracle settings
#   workspace/         seminar files — what was uploaded and what cells created
#   data/session-secret  the signing key: without it every issued link and cookie is dead
#   data/setup-token     the setup token — the way into the panel when the link is lost
#   kernel/environments/*.txt  package lists, including those created from the panel
#                      right on the machine: there is nowhere else to get them, and
#                      the image is rebuilt from them with one command
#
# What is not in the backup and why: built environment images (rebuilding them
# with one command is cheaper than carrying tens of gigabytes: make env-build
# NAME=…) and .env (it travels to the new machine on its own, together with
# the repository — see scripts/vast.sh).
set -euo pipefail
SCRIPT_PATH="$(cd "$(dirname "$0")" && pwd)/$(basename "$0")"

cd "$(dirname "$0")/.."

# Portable cluster recovery is explicit; a legacy archive is never silently
# overlaid onto a PVC. Validate before stopping writers or moving any data.
if [ "${1:-}" = --archive ]; then
  STATE="${COLLOQ_STATE_DIR:-/var/lib/colloq}"
  if ! python3 scripts/state-lock.py held --state "$STATE"; then
    exec python3 scripts/state-lock.py run --state "$STATE" -- bash "$SCRIPT_PATH" "$@"
  fi
  shift
  ARCHIVE="${1:?archive path required}"; shift
  STATE="${COLLOQ_STATE_DIR:-/var/lib/colloq}"
  RELEASE="${RELEASE:-$STATE/releases/current.json}"
  extra=()
  while [ "$#" -gt 0 ]; do
    case "$1" in
      --release) RELEASE="${2:?release required}"; shift 2;;
      --replace) extra+=(--replace); shift;;
      --recover) extra+=(--recover); shift;;
      *) echo "Unknown restore argument: $1" >&2; exit 1;;
    esac
  done
  [ -f "$RELEASE" ] || { echo 'Select the matching RELEASE before restoring.' >&2; exit 1; }
  python3 scripts/runtime-backup.py validate --archive "$ARCHIVE" --name "${NAME:-}" --release "$RELEASE"
  mkdir -p "$STATE"
  bash scripts/cluster.sh stop
  python3 scripts/runtime-backup.py restore --root "$STATE" --release "$RELEASE" --archive "$ARCHIVE" --name "${NAME:-}" --defer-finalize "${extra[@]}"
  # A restored older backup may deliberately contain previously retired IDs.
  # Keep the durable marker until those old reservations are removed, with
  # every writer still stopped and the same operation lock held throughout.
  bash scripts/cluster.sh restore-services
  python3 scripts/runtime-backup.py finalize --root "$STATE" --release "$RELEASE" --archive "$ARCHIVE" --name "${NAME:-}"
  # Ownership was set on the validated stage before the durable marker cleared.
  echo 'Restore completed with writers stopped. Run cluster.sh prepare --release, then cluster.sh start.'
  exit 0
fi
if [ -f "${COLLOQ_STATE_DIR:-/var/lib/colloq}/releases/current.json" ]; then
  echo 'Cluster restore requires --archive PORTABLE.tar.gz --release RELEASE.json; legacy overlay is refused.' >&2
  exit 1
fi

RED=$'\033[31m'; DIM=$'\033[2m'; BOLD=$'\033[1m'; OFF=$'\033[0m'
say() { printf '%s\n' "$*"; }
die() { printf '%s%s%s\n' "$RED" "$*" "$OFF" >&2; exit 1; }

# The STATE root — data/, workspace/ and backups/ are taken from there.
#
# The pair to scripts/backup-local.sh, and for the same reason. The script came
# here from a world with a single root and counted data/ and workspace/ from
# the directory above itself, that is, from the APP directory. For colloq
# installed with pip that is site-packages: `colloq restore --legacy` would
# have unpacked a class backup next to the code — where neither the server nor
# the next launch looks — and the very first `pip install -U` would have wiped
# it. The state location arrives in the COLLOQ_HOME variable, parsed in
# scripts/lib.sh · COLLOQ_STATE_ROOT.
#
# The app directory is still needed, though: it holds the scripts themselves,
# docker-compose.yml and cluster.sh. So it is remembered, not lost.
. ./scripts/lib.sh
APP="$PWD"
STATE="$(cd "$COLLOQ_STATE_ROOT" 2>/dev/null && pwd || true)"
[ -n "$STATE" ] || die "no state directory \"${COLLOQ_STATE_ROOT}\" — check COLLOQ_HOME."
cd "$STATE"

# The backup directory of one deployment. The name arrives in an environment
# variable, like HOST for `make host`: that is how the Makefile passes it, and
# that way it does not get in the way of the old call with paths as arguments.
# We check the same characters as vast.sh: the name goes into a path, and
# "../" would take the restore outside backups/.
ENV_NAME="${NAME:-}"
case "$ENV_NAME" in
  '') : ;;
  *[!A-Za-z0-9-]*|-*|*-) die "deployment name \"${ENV_NAME}\" is not valid: letters, digits and a hyphen inside." ;;
esac
BACKUP_DIR="backups${ENV_NAME:+/$ENV_NAME}"

DB=""
FILES=""
for arg in "$@"; do
  case "$arg" in
    *.db) DB="$arg" ;;
    *.tar.gz) FILES="$arg" ;;
    *) die "I do not understand \"${arg}\". Expected backups/colloq-<date>.db and/or backups/colloq-<date>-files.tar.gz" ;;
  esac
done

if [ -z "$DB" ] && [ -z "$FILES" ]; then
  DB="$(ls -1t "$BACKUP_DIR"/colloq-*.db 2>/dev/null | head -1 || true)"
  if [ -z "$DB" ]; then
    # The list of deployments is printed right in the refusal: "no backups"
    # with a full backups/hse is not a missing backup but the wrong name, and
    # there is no reason to find that out on an empty machine in the middle
    # of a class.
    others="$(ls -1d backups/*/ 2>/dev/null | sed 's#backups/##;s#/##' | tr '\n' ' ' | sed 's/ *$//' || true)"
    # The advice names a command that exists on THIS machine: an installed
    # package has no Makefile, and "make backup" would be a second refusal
    # in a row.
    take="colloq backup"; [ "$STATE" = "$APP" ] && take="make backup"
    die "there is not a single backup in $BACKUP_DIR/.
  Take one on a running instance: $take${others:+
  Backups of other deployments live in subdirectories: $others
  Restore a deployment backup: make restore NAME=<name>}"
  fi
fi
# The archive is found by the database's name, not as "the most recent": a
# pair of one day's database and another day's files is a seminar whose
# notebook links to a file that does not exist.
if [ -z "$FILES" ] && [ -n "$DB" ] && [ -f "${DB%.db}-files.tar.gz" ]; then
  FILES="${DB%.db}-files.tar.gz"
fi

[ -z "$DB" ] || [ -f "$DB" ] || die "no file $DB"
[ -z "$FILES" ] || [ -f "$FILES" ] || die "no file $FILES"

say "${BOLD}1/3${OFF} checking there is somewhere to restore into"

# The database is not swapped under a running server. sqlite keeps open the
# file it opened: the old inode stays alive until the last close, the seminar
# goes on writing into a file that is no longer on disk, and after a restart
# that work simply disappears. And until the restart everything on screen
# looks fine — which is why the check is here and not in the parting words
# below.
# .env is read by the shared read_env (scripts/lib.sh) — the same one as in
# host.sh and service.sh: one copy of the rule for all scripts. It is sourced
# above, together with the state root: the path to .env comes from there too.
PORT="$(read_env PORT)"; PORT="${PORT:-3000}"
if command -v systemctl >/dev/null 2>&1 && systemctl is-active --quiet colloq 2>/dev/null; then
  die "the colloq service is running — stop it first: make service-stop.
  A stopped service is not yet an empty machine: restoring a backup over today's
  work still has to be deliberate, see REPLACE=1 further down."
fi
# Ask from the APP directory: docker-compose.yml lives there, and we are
# standing in the state. An installed package has no compose at all — the
# question goes unanswered, and that is the right answer: nothing runs in a
# container there.
if (cd "$APP" && docker compose ps --status running --services 2>/dev/null) | grep -qx app; then
  die "app is running in docker — stop it first: make down"
fi
if [ -f .colloq.pid ] && kill -0 "$(cat .colloq.pid 2>/dev/null)" 2>/dev/null; then
  die "a class is running on this machine — first: colloq stop"
fi
if curl -sf -o /dev/null --max-time 3 "http://localhost:$PORT/api/health" 2>/dev/null; then
  die "something answers on localhost:$PORT — that is a second Colloq.
  Stop it (make down · make stop) and try again."
fi

# Over a non-empty machine — only when asked.
#
# Restoring is irreversible exactly by half, and that is the worst of the
# options: the database is set aside as colloq.db.replaced-<stamp> (which
# nobody will remember later), while the archive lands on top of workspace/,
# overwriting same-named files without any backup. So "something is already
# here" is a question, not a reason to act: the script is called both by hand
# ("roll back to yesterday") and from scripts/vast.sh, where the reason can be
# accidental.
#
# We ask only when there is someone to ask: on the far side of ssh there is no
# terminal, stdin holds a heredoc — and `read` would eat the rest of the
# script. Without a terminal it takes REPLACE=1, said out loud.
if [ -n "$DB" ] && [ -s data/colloq.db ]; then
  if [ "${REPLACE:-}" = 1 ]; then
    say "${DIM}    a database is already here — restoring over it (REPLACE=1)${OFF}"
  elif [ -t 0 ]; then
    say "${RED}There is already a data/colloq.db here${OFF} — classes, teachers, version history."
    say "${DIM}It will be set aside as data/colloq.db.replaced-<stamp>, and the archive will${OFF}"
    say "${DIM}land on workspace/ — same-named files are overwritten with no backup.${OFF}"
    printf '%srestore the backup over it? [y/N] %s' "$BOLD" "$OFF"
    read -r answer
    case "$answer" in y|Y|yes|YES|Yes) : ;; *) die "not restoring." ;; esac
  else
    die "there is already a data/colloq.db here, and no terminal to ask in.
  This is not an empty machine: restoring a backup over it means setting the
  current database aside as data/colloq.db.replaced-<stamp> and unpacking the
  archive on top of workspace/.
  If that is what you want: REPLACE=1 $0 $*"
  fi
fi

mkdir -p data workspace
STAMP="$(date +%Y%m%d-%H%M%S)"

say "${BOLD}2/3${OFF} database"
if [ -n "$DB" ]; then
  # A cheap check instead of trusting the extension: the first sixteen bytes
  # of an sqlite file are "SQLite format 3". Restoring an empty file that was
  # downloaded halfway means losing what was there as well.
  head -c 16 "$DB" | LC_ALL=C grep -qa 'SQLite format 3' \
    || die "$DB does not look like an sqlite database — the backup is broken or incomplete."
  if command -v sqlite3 >/dev/null 2>&1; then
    [ "$(sqlite3 "$DB" 'pragma quick_check')" = ok ] \
      || die "$DB does not pass the sqlite check. Take another backup."
  fi
  if [ -f data/colloq.db ]; then
    # The previous database leaves whole, with its journal. It is not deleted —
    # "I pressed restore with the wrong backup" must be fixable; and it does
    # not stay in place — an old -wal rolled onto the new database corrupts it
    # silently.
    mv data/colloq.db "data/colloq.db.replaced-$STAMP"
    for j in wal shm; do
      if [ -f "data/colloq.db-$j" ]; then
        mv "data/colloq.db-$j" "data/colloq.db.replaced-$STAMP-$j"
      fi
    done
    say "${DIM}    the previous database is set aside as data/colloq.db.replaced-$STAMP${OFF}"
  fi
  cp "$DB" data/colloq.db
  chmod 600 data/colloq.db
  say "    $DB → data/colloq.db"
else
  say "${DIM}    not touching the database — it was not in the arguments${OFF}"
fi

say "${BOLD}3/3${OFF} class files and keys"
if [ -n "$FILES" ]; then
  # Unpacked over, not instead: rooms that are not in the backup stay in
  # place. Removing the extra is always possible, bringing back the erased is
  # not.
  #
  # -p is required: data/session-secret has mode 0600, and without preserving
  # the mode the signing key would become readable by everyone on the machine.
  tar -xzpf "$FILES"
  # Where the environment lists landed depends on whether the roots diverged:
  # in the repository that is kernel/environments, for an installed package a
  # directory of its own next to .env. That is exactly how
  # scripts/backup-local.sh packed them, and the same place has to be named,
  # or the person goes looking for the files in the wrong place.
  if [ "$STATE" = "$APP" ]; then lists=kernel/environments; else lists=environments; fi
  say "    $FILES → workspace/, data/, $lists/"
  if [ -f data/session-secret ]; then
    chmod 600 data/session-secret
    say "${DIM}    the signing key is in place — issued links and cookies survive the move${OFF}"
  fi
  if [ -f data/setup-token ]; then
    chmod 600 data/setup-token
  fi
else
  say "${DIM}    no file archive — only the database was restored.${OFF}"
  say "${DIM}    Notebooks and settings are in place, uploaded files are not.${OFF}"
fi

# Files belong to whoever the server runs as, not to whoever restored them.
#
# Under `make up` the server in the container runs as `node` (uid 1000), while
# on a new machine the backup is restored by root: the database and folders
# stayed root:root, and the container crash-looped with "unable to open
# database file". Locally this is not visible at all — under `make run` the
# server is the one who unpacked.
#
# On a dedicated machine, though, the server is a service and runs as root —
# there uid 1000 on the database would mean exactly the opposite error. So the
# form is asked, not guessed: there is a unit — the server is root, there is
# none — the server is in a container. And asked with a caveat: on a new
# machine the backup is restored BEFORE the service is installed (otherwise
# the server would open the database we are about to swap), and there is no
# unit there yet — so scripts/vast.sh states the form directly, FORM=service.
#
# What does not depend on the form: workspace/. The room's kernel writes into
# it, and the kernel is always uid 1000 (kernel/Dockerfile, user runner).
# Under the service the server puts its own files there as root, so the
# directories get group 1000 and the setgid bit: everything new inside goes to
# that group, and UMask=0002 from the unit gives it the right to write.
# Without the "setgid + umask" pair the first cell with open(…,'w') in a fresh
# room fails with PermissionError on a green screen.
#
# A thousand here is a default, not the truth: the kernel's group comes from
# useradd, and in an environment built on another base it may turn out
# different. The exact number is set by scripts/service.sh, which asks the
# image itself; that is also repeated there after every install.
#
# Only when we are root and only on these two directories: other permissions
# are not touched here, and on macOS (the uid is different there and
# everything is yours anyway) the step is skipped.
FORM="${FORM:-}"
if [ -z "$FORM" ] && [ -f /etc/systemd/system/colloq.service ]; then FORM=service; fi
if [ "$(id -u)" = 0 ] && [ "$(uname -s)" = Linux ]; then
  if [ "$FORM" = service ]; then
    chown -R root:root data
    # The group, not the owner. The owner of files inside workspace/ must not
    # change: what was unpacked as uid 1000 the kernel wrote as the owner, and
    # as root:1000 with mode 0644 it would become unwritable for the kernel.
    # Group 1000 plus setgid on the directories, on the other hand, lets both
    # sides create and delete files inside without touching those already
    # there.
    chgrp -R 1000 workspace
    find workspace -type d -exec chmod 2775 {} + 2>/dev/null || true
    say "${DIM}    data/ — root's (the server is a service), workspace/ — group 1000 (the kernel)${OFF}"
  else
    chown -R 1000:1000 data workspace
    say "${DIM}    data/ and workspace/ — uid 1000: that is who the server is in the container${OFF}"
  fi
fi

printf '\n'
say "${BOLD}done${OFF}"
# Where to go next — with a command the reader actually has.
#
# The old parting words sent people to `make up / make run / make
# service-install` and `make env-build NAME=…`. colloq installed with pip has
# no make at all (the wheel carries the app and scripts/, the Makefile does
# not travel — scripts/pack.mts · SCRIPTS), and both lines lied to exactly the
# person who had just restored a backup on a new machine and was looking for a
# way to start it. For the package that is `colloq start`: it builds the
# environment image itself, on the first start (cli/src/commands/env.ts · env
# use). Next to the sources it is make: the service-install target of a
# dedicated machine lives there too.
if [ "$STATE" = "$APP" ]; then
  say "${DIM}Start a class: make run (make dev for development)${OFF}"
  say "${DIM}On a dedicated machine the class is held by a service: make service-install.${OFF}"
else
  say "${DIM}Start a class: colloq start${OFF}"
fi
say "${DIM}Kernel environments are not restored here —${OFF}"
say "${DIM}the image is built on the next start of a class.${OFF}"
say "${DIM}Pinned competition images must be restored separately with their exact image IDs (see backup/restore docs).${OFF}"
say "${DIM}The Oracle key, RELAY_* and PUBLIC_URL live in .env, not in the backup.${OFF}"
