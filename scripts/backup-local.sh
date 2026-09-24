#!/usr/bin/env bash
#
# A backup of the class on this machine: the database as one file and an
# archive with everything the database does not hold. The counterpart of
# `colloq restore --legacy` (scripts/restore.sh).
#
#   ./scripts/backup-local.sh    take a backup into <state>/backups/
#   colloq backup                for the teacher, this is it
#   make backup-legacy           in the repository, the same, as a one-line wrapper
#
# Why a separate file and not a recipe in the Makefile, where it has lived until
# now. The pip wheel carries the application and scripts/; the Makefile is not
# carried and will not be (scripts/pack.mts · SCRIPTS), and `colloq backup` in
# an installed colloq called make and died on "command not found", on the one
# command with which the teacher carries the semester off the machine. The same
# has already been done, for the same reason, with restore-legacy and with host:
# one description, one file.
#
# ---------------------------------------------------------------- two roots
#
# The APPLICATION directory is the one above scripts/: web/dist, kernel/, these
# scripts. It arrives with the package and is wiped entirely by the next
# `pip install -U`. The STATE directory (.env, data/, workspace/, own
# environments, backups/) lives separately (~/.colloq or COLLOQ_HOME) and
# survives updates.
#
# The backup is taken ENTIRELY from the state, and its address is not computed
# here: scripts/lib.sh knows it (COLLOQ_STATE_ROOT), and there must not be a
# second answer to one question. In the repository both roots are the same
# directory, and not a single path moved there.
#
# Names in the archive are also relative to the state root: that is where it
# will have to be unpacked.
#
# ------------------------------------------------------------ what and why
#
# A backup of THIS instance, and it goes into the root of backups/. An
# environment on a rented machine has a name and its own subdirectory
# (backups/demo/, which make vast-sync writes to), while this machine has no
# name: the root is its place. That way the root and the subdirectories stay out
# of each other's way: the "latest backup" of one environment will never turn
# out to be a backup of another.
#
# VACUUM INTO reads a consistent snapshot and writes one finished file. A copy
# of colloq.db itself does not give that: in WAL mode half a day lies in the
# journal next to it, and a file copied on the fly lags by hours. Verified.
#
# The second file next to it is an archive with everything the database does
# not hold: workspace (what was uploaded into the rooms), competition files,
# wheel sets, the signing key and the installation token. The README used to
# tell people to copy the folder by hand, and that was exactly the step that
# gets skipped: a database without workspace is notebooks with links to files
# that no longer exist, and a database without the signing key is an instance
# where every link handed out is dead. On a rented machine that is destroyed
# after the class, the price of such forgetfulness is the whole semester at
# once.
#
# Both files are 0600 and are not "class files": they hold the keys to the
# instance.
#
# The database holds the classes themselves, the teachers, the version history
# and the Oracle settings. Docker image layers are not copied. A pinned image ID
# in the database is a reference, not the image content: to reproduce old
# submissions, keep the images themselves in a registry or separately via
# docker image save/load. Rebuilding the package list does not guarantee the
# previous image ID or environment contents.
#
# ------------------------------------------------------- environment lists
#
# There are TWO directories with package lists on the machine, and only the
# second goes into the backup:
#
#   <application>/kernel/environments   shipped with the product (base, cv, gpu).
#       Nothing to copy: they come again with any installation of the package.
#   <state>/environments                created by a person. These exist
#       nowhere else; why the directory is separate is worked through at
#       ownEnvDir in cli/src/env.ts.
#
# In the repository it is ONE directory, kernel/environments, and it goes into
# the archive whole, exactly as before.
#
# Why the lists are in the backup at all: they are edited and created from the
# panel right on the machine where the classes run (the "Environments" window
# writes <name>.txt on the host), and there is nowhere else to take them from:
# the repository holds only those that came from the laptop. Images are rebuilt
# from them with one command, while the `.<name>.built` stamps stay with the
# machine: they are about its image, not about the list.
set -euo pipefail

cd "$(dirname "$0")/.."

RED=$'\033[31m'; DIM=$'\033[2m'; BOLD=$'\033[1m'; OFF=$'\033[0m'
say() { printf '%s\n' "$*"; }
die() { printf '%s%s%s\n' "$RED" "$*" "$OFF" >&2; exit 1; }

# The state root is one shared answer for everyone: scripts/lib.sh, the same as
# for host.sh and restore.sh.
. ./scripts/lib.sh

APP="$PWD"
STATE="$(cd "$COLLOQ_STATE_ROOT" 2>/dev/null && pwd || true)"
# The braces around the name are required: it is followed by a "»", and bash
# takes its first byte for part of the variable name and fails on "unbound
# variable" instead of refusing for the actual reason. restore.sh writes it with
# the same trick for the same reason.
[ -n "$STATE" ] || die "no state directory \"${COLLOQ_STATE_ROOT}\" — check COLLOQ_HOME."

# Own environments: the former kernel/environments in the repository,
# <state>/environments for an installed package (see the header).
if [ "$STATE" = "$APP" ]; then ENV_LISTS=kernel/environments; else ENV_LISTS=environments; fi

# From here on everything is counted from the state root, the way it used to be
# counted from the repository root. One change of directory instead of a prefix
# on every line: the names in the archive also come out relative on their own.
cd "$STATE"

# Without the database there is nothing to back up, and that has to be said out
# loud. VACUUM INTO over a nonexistent file silently creates an empty database
# and just as silently writes an empty "backup": for an installed colloq with
# its roots out of step, this would look like a successful backup of nothing.
[ -f data/colloq.db ] || die "no data/colloq.db in $STATE — there is nothing to back up.
  This is the directory that holds the .env of the class; for an installed colloq
  its address is COLLOQ_HOME."

mkdir -p backups
stamp="$(date +%Y%m%d-%H%M%S)"
out="backups/colloq-$stamp.db"
files="backups/colloq-$stamp-files.tar.gz"

# How to name the backup to a person. In the repository, as before, from the
# root: `backups/…` is the path from the directory the person stands in. For an
# installed colloq the state lies in ~/.colloq, while the person stands
# anywhere, and a relative name would point to a nonexistent backups/ next to
# them, including in the "restore it back" hint, which gets copied whole.
if [ "$STATE" = "$APP" ]; then SHOW=""; else SHOW="$STATE/"; fi

# The path goes inside an SQL string, and it now comes from outside
# (COLLOQ_HOME): a single quote in the name of the home directory would close
# the string in the middle of the path. In SQL it is doubled.
sql_out="$PWD/$out"
sqlite3 data/colloq.db "VACUUM INTO '${sql_out//\'/\'\'}'" \
  || die "did not work. sqlite3 is needed — brew install sqlite"
# A copy of the database is as secret as the database itself: it holds the
# sign-in keys for teachers and the Oracle key, if it was set in the panel.
# VACUUM INTO creates the file with ordinary permissions, so we set 0600
# ourselves.
chmod 600 "$out"
printf '%sbackup:%s %s %s(%s)%s\n' "$BOLD" "$OFF" "$SHOW$out" "$DIM" "$(du -h "$out" | cut -f1)" "$OFF"

back="colloq restore --legacy --db $SHOW$out"
set --
for p in workspace data/competitions data/dependencies data/session-secret data/setup-token "$ENV_LISTS"/*.txt; do
  if [ -e "$p" ]; then set -- "$@" "$p"; fi
done
if [ $# -gt 0 ]; then
  # The tar exit code is examined, not swallowed: otherwise `set -e` would drop
  # the script on a 1, which here is not a failure (see below).
  code=0
  tar -czf "$files" "$@" || code=$?
  chmod 600 "$files" 2>/dev/null || true
  [ "$code" -le 1 ] || die "could not take the class files — the backup is incomplete"
  # Exit code 1 from tar means "a file changed while it was being read": a
  # running class writes into workspace, and that is normal. The archive is
  # still usable, but one or two files in it are worth knowing about.
  if [ "$code" -eq 1 ]; then
    say "${DIM}some files changed while they were being copied — a class is running${OFF}"
  fi
  printf '%sfiles:%s  %s %s(%s)%s\n' "$BOLD" "$OFF" "$SHOW$files" "$DIM" "$(du -h "$files" | cut -f1)" "$OFF"
  # Both files are named in one line on purpose: they have to be restored as a
  # pair, and a person has no reason to hunt for the second by the name of the
  # first.
  back="$back --files $SHOW$files"
fi

# Where to go back. The previous hint called `make restore`, and that target has
# long been about the portable k3s backup and answers "ARCHIVE is required" to a
# pair of files; besides, not everyone who took this backup has make. The paths
# are from the state root, that is, from the directory where they actually lie.
say "${DIM}restore it back: $back${OFF}"
