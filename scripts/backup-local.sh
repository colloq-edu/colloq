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
# wheel sets, the images of cell outputs (data/blobs), the signing key and the
# installation token. The README used to
# tell people to copy the folder by hand, and that was exactly the step that
# gets skipped: a database without workspace is notebooks with links to files
# that no longer exist, and a database without the signing key is an instance
# where every link handed out is dead. On a rented machine that is destroyed
# after the class, the price of such forgetfulness is the whole semester at
# once.
#
# Both files are 0600 from the first byte (umask 077) and are not "class
# files": they hold the keys to the instance.
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
#   <application>/kernel/environments   shipped with the product (base, base-gpu,
#       kaggle-base).
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
# ------------------------------------------------ what student code leaves
#
# A room holds whatever the students' code made, not only files: symlinks
# (`python -m venv` makes a dozen), FIFOs, sockets, files and folders it closed
# to everyone with chmod 000. One walk with find decides what goes in, and tar
# only packs that list, without recursing on its own:
#
#   folders, files and links     go in; a link is stored as a link, never
#                                followed, so the backup cannot pick up
#                                anything outside the state directory;
#   FIFOs, sockets, devices      are left out, each named with its full path
#                                (a FIFO would make tar wait forever);
#   unreadable files and folders are left out and named: they are not the
#                                backup's to read, and refusing the whole
#                                semester over one of them is worse;
#   anything else that fails     (an I/O error, a full disk) stops the backup
#                                with the path tar or find named.
#
# ------------------------------------------------------- settings
#
# From the environment, otherwise from the .env of the instance:
#
#   BACKUP_KEEP=14             backups of this instance kept after a successful
#                              one; the oldest pairs go. 0 keeps every backup.
#   BACKUP_AGE_RECIPIENT=...   encrypt both files with age for this recipient
#                              (or a file of recipients). restore.sh decrypts
#                              with BACKUP_AGE_IDENTITY.
set -euo pipefail
# The archive used to be world-readable for as long as tar wrote it, and only
# the chmod at the end closed it. Nothing written here is anyone else's.
umask 077

cd "$(dirname "$0")/.."

RED=$'\033[31m'; DIM=$'\033[2m'; BOLD=$'\033[1m'; OFF=$'\033[0m'
say() { printf '%s\n' "$*"; }
warn() { printf 'warning: %s\n' "$*" >&2; }
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

# The environment wins; otherwise the .env of this instance, read as data.
setting() {
  local value="${!1:-}"
  [ -n "$value" ] || value="$(read_env "$1")"
  printf '%s' "$value"
}
KEEP="$(setting BACKUP_KEEP)"; KEEP="${KEEP:-14}"
case "$KEEP" in *[!0-9]*) die "BACKUP_KEEP must be a whole number of backups to keep (0 keeps every one), not \"${KEEP}\"." ;; esac
RECIPIENT="$(setting BACKUP_AGE_RECIPIENT)"
# Asked for encryption and cannot encrypt: refuse before anything is written.
# A plain copy of the keys where the operator expects ciphertext is worse than
# no copy at all.
if [ -n "$RECIPIENT" ] && ! command -v age >/dev/null 2>&1; then
  die "BACKUP_AGE_RECIPIENT is set, but age is not installed (https://age-encryption.org).
  Install it or unset the variable; nothing was written."
fi

mkdir -p backups
stamp="$(date +%Y%m%d-%H%M%S)"
out="backups/colloq-$stamp.db"
files="backups/colloq-$stamp-files.tar.gz"
# Names go by the second. VACUUM INTO refuses an existing file, which is
# right, but it says so as "did not work, install sqlite3".
if [ -e "$out" ] || [ -e "$out.age" ]; then
  die "a backup named $out was taken this very second — try again in a moment."
fi

# How to name the backup to a person. In the repository, as before, from the
# root: `backups/…` is the path from the directory the person stands in. For an
# installed colloq the state lies in ~/.colloq, while the person stands
# anywhere, and a relative name would point to a nonexistent backups/ next to
# them, including in the "restore it back" hint, which gets copied whole.
if [ "$STATE" = "$APP" ]; then SHOW=""; else SHOW="$STATE/"; fi

# What goes into the file archive; see the header for why each one.
set --
for p in workspace data/competitions data/dependencies data/blobs data/session-secret data/setup-token "$ENV_LISTS"/*.txt; do
  if [ -e "$p" ] || [ -L "$p" ]; then set -- "$@" "$p"; fi
done

# Room for both files before either is written: the database copy is at most
# the database, the archive at most what it packs. The same disk usually holds
# the live instance, and a full disk stops notebook saves, so a gigabyte stays
# free on top.
kb() { { du -sk "$@" 2>/dev/null || true; } | awk '{ total += $1 } END { print total + 0 }'; }
gb() { awk -v kb="$1" 'BEGIN { printf "%.1f", kb / 1048576 }'; }
need_kb="$(kb data/colloq.db data/colloq.db-wal)"
[ "$#" -eq 0 ] || need_kb=$((need_kb + $(kb "$@")))
need_kb=$((need_kb + 1048576))
free_kb="$(df -Pk backups 2>/dev/null | awk 'NR == 2 { print $4 }' || true)"
if [ -n "$free_kb" ] && [ "$free_kb" -lt "$need_kb" ]; then
  die "not enough free space in ${SHOW}backups/: the backup needs about $(gb "$need_kb") GB, and $(gb "$free_kb") GB is free.
  Free space (old backups there are the usual suspects) and try again; nothing was written."
fi

# The path goes inside an SQL string, and it now comes from outside
# (COLLOQ_HOME): a single quote in the name of the home directory would close
# the string in the middle of the path. In SQL it is doubled.
sql_out="$PWD/$out"
sqlite3 data/colloq.db "VACUUM INTO '${sql_out//\'/\'\'}'" \
  || die "did not work. sqlite3 is needed — brew install sqlite"
# A copy of the database is as secret as the database itself: it holds the
# sign-in keys for teachers and the Oracle key, if it was set in the panel.
# VACUUM INTO creates the file by the process umask, which is 077 here; the
# chmod stays for whoever changes that line.
chmod 600 "$out"

made_files=""
if [ $# -gt 0 ]; then
  list="$(mktemp backups/.colloq-list.XXXXXX)"
  keep="$(mktemp backups/.colloq-keep.XXXXXX)"
  errs="$(mktemp backups/.colloq-errors.XXXXXX)"
  trap 'rm -f "$list" "$keep" "$errs"' EXIT
  # Messages in English, so that the refusals below can be told from the
  # harmless ones; names keep the person's own character set.
  ctype="${LC_ALL:-${LC_CTYPE:-${LANG:-C}}}"
  found=0
  LC_ALL= LC_CTYPE="$ctype" LC_MESSAGES=C find "$@" -print0 >"$list" 2>"$errs" || found=$?
  if [ "$found" -ne 0 ]; then
    # A folder closed to everyone cannot be listed, and one deleted by a
    # running class cannot be entered: both are left out. Anything else find
    # could not do is a real failure, and it names the path.
    if grep -qvE ': (Permission denied|No such file or directory)$' "$errs"; then
      cat "$errs" >&2
      rm -f "$out"
      die "could not list the class files — no backup was made"
    fi
    while IFS= read -r line; do
      case "$line" in
        *': Permission denied')
          entry="${line#find: }"; entry="${entry%: Permission denied}"
          # GNU find quotes the name, with ‘’ under a UTF-8 locale.
          entry="${entry#\'}"; entry="${entry%\'}"; entry="${entry#‘}"; entry="${entry%’}"
          warn "skipped an unreadable folder: $STATE/$entry" ;;
      esac
    done <"$errs"
  fi
  skipped=0
  skip() {
    skipped=$((skipped + 1))
    [ "$skipped" -gt 50 ] || warn "skipped $1: $STATE/$2"
  }
  # Order matters to the checks: -d and -f follow a link, -L does not.
  while IFS= read -r -d '' p; do
    if [ -L "$p" ] || [ -d "$p" ]; then printf '%s\0' "$p"
    elif [ -f "$p" ]; then
      if [ -r "$p" ]; then printf '%s\0' "$p"; else skip 'an unreadable file' "$p"; fi
    elif [ -p "$p" ]; then skip 'a FIFO' "$p"
    elif [ -S "$p" ]; then skip 'a socket' "$p"
    elif [ -b "$p" ] || [ -c "$p" ]; then skip 'a device node' "$p"
    elif [ -e "$p" ]; then skip 'a special file' "$p"
    fi
  done <"$list" >"$keep"
  [ "$skipped" -le 50 ] || warn "… and $((skipped - 50)) more entries that are not files, folders or links"
fi
if [ $# -gt 0 ] && [ -s "$keep" ]; then
  # The tar exit code is examined, not swallowed: otherwise `set -e` would drop
  # the script on a 1, which here is not a failure (see below).
  code=0
  LC_ALL= LC_CTYPE="$ctype" LC_MESSAGES=C tar -czf "$files" --null --no-recursion -T "$keep" 2>"$errs" || code=$?
  # 1 is "a file changed while it was being read": a running class writes into
  # workspace, and the archive is still usable. GNU tar says 2 as well for a
  # file the class deleted after the walk named it; those lines, and only
  # those, are no reason to lose the backup. Everything else is.
  benign=': (Cannot stat|Cannot open): (No such file or directory|Permission denied)$|: File removed before we read it$|: file changed as we read it$|: socket ignored$|: File shrank by [0-9]+ bytes; padding with zeros$|^tar: Exiting with failure status due to previous errors$'
  if [ "$code" -gt 1 ] && grep -qvE "$benign" "$errs"; then
    cat "$errs" >&2
    rm -f "$files" "$out"
    die "could not take the class files — no backup was made"
  fi
  if [ -s "$errs" ]; then sed 's/^/    /' "$errs" >&2; fi
  if [ "$code" -ne 0 ]; then
    say "${DIM}some files changed or disappeared while they were being copied — a class is running${OFF}"
  fi
  chmod 600 "$files" 2>/dev/null || true
  made_files=1
fi

# Encrypted after both files are whole; the plain copy goes only once its
# ciphertext is complete on disk.
if [ -n "$RECIPIENT" ]; then
  to=(-r "$RECIPIENT"); [ ! -f "$RECIPIENT" ] || to=(-R "$RECIPIENT")
  for f in "$out" ${made_files:+"$files"}; do
    age "${to[@]}" -o "$f.age" "$f" || { rm -f "$f.age"; die "could not encrypt ${SHOW}$f; the plain copy is kept"; }
    sync
    rm -f "$f"
  done
  out="$out.age"
  [ -z "$made_files" ] || files="$files.age"
fi

printf '%sbackup:%s %s %s(%s)%s\n' "$BOLD" "$OFF" "$SHOW$out" "$DIM" "$(du -h "$out" | cut -f1)" "$OFF"
back="colloq restore --legacy --db $SHOW$out"
if [ -n "$made_files" ]; then
  printf '%sfiles:%s  %s %s(%s)%s\n' "$BOLD" "$OFF" "$SHOW$files" "$DIM" "$(du -h "$files" | cut -f1)" "$OFF"
  # Both files are named in one line on purpose: they have to be restored as a
  # pair, and a person has no reason to hunt for the second by the name of the
  # first.
  back="$back --files $SHOW$files"
fi

# The newest BACKUP_KEEP backups of this instance stay; older pairs go. Only
# names this script writes are touched, only in the root of backups/ (the
# subdirectories belong to other deployments), never the pair just made, and
# only after it is complete.
if [ "$KEEP" -gt 0 ]; then
  n=0
  for old in $(ls -1 backups | sed -n -E 's/^colloq-([0-9]{8}-[0-9]{6})(-files\.tar\.gz|\.db)(\.age)?$/\1/p' | sort -ru); do
    n=$((n + 1))
    if [ "$n" -le "$KEEP" ] || [ "$old" = "$stamp" ]; then continue; fi
    for f in "backups/colloq-$old.db" "backups/colloq-$old.db.age" "backups/colloq-$old-files.tar.gz" "backups/colloq-$old-files.tar.gz.age"; do
      if [ -f "$f" ] && [ ! -L "$f" ]; then rm -f -- "$f"; say "${DIM}removed an old backup: $SHOW$f${OFF}"; fi
    done
  done
fi

# Where to go back. The previous hint called `make restore`, and that target has
# long been about the portable k3s backup and answers "ARCHIVE is required" to a
# pair of files; besides, not everyone who took this backup has make. The paths
# are from the state root, that is, from the directory where they actually lie.
say "${DIM}restore it back: $back${OFF}"
