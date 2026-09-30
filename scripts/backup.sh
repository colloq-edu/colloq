#!/usr/bin/env bash
# Cluster application backup. MODE=live (default) or MODE=consistent.
# Consistent mode stops app, broker and every room; RESUME=1 explicitly starts
# the application afterwards. Failure leaves writers stopped for investigation.
#
# Everything that can refuse is asked BEFORE any writer stops: the database,
# the free space, the settings below. A consistent backup that refuses leaves
# the classes running; cluster.sh update relies on that.
#
# Archives go to backups/ next to these tools (OUT= names another file) and
# are 0600. Settings, from the environment or from <state>/config.env:
#   BACKUP_KEEP=14            archives kept after a successful backup; 0 keeps all
#   BACKUP_AGE_RECIPIENT=...  encrypt with age for this recipient (or a file of
#                             recipients); restore.sh decrypts with
#                             BACKUP_AGE_IDENTITY
set -euo pipefail
SCRIPT_PATH="$(cd "$(dirname "$0")" && pwd)/$(basename "$0")"
cd "$(dirname "$0")/.."
umask 077
STATE="${COLLOQ_STATE_DIR:-/var/lib/colloq}"
MODE="${MODE:-live}"
NAME="${NAME:-}"
case "$MODE" in live|consistent) ;; *) echo 'MODE must be live or consistent' >&2; exit 1;; esac
case "$NAME" in *[!A-Za-z0-9-]*|-*|*-) echo 'invalid environment name' >&2; exit 1;; esac
RELEASE="${RELEASE:-$STATE/releases/current.json}"
[ -f "$RELEASE" ] || { echo 'No installed release. Local backup: colloq backup (make backup-legacy); cluster backup needs an installed release.' >&2; exit 1; }
OUT="${OUT:-backups${NAME:+/$NAME}/colloq-$(date -u +%Y%m%dT%H%M%SZ)-$MODE.tar.gz}"
case "$OUT" in /*) ;; *) OUT="$PWD/$OUT" ;; esac
mkdir -p "$STATE"
if ! python3 scripts/state-lock.py held --state "$STATE"; then
  exec python3 scripts/state-lock.py run --state "$STATE" -- bash "$SCRIPT_PATH" "$@"
fi
[ ! -e "$STATE/.restore-in-progress" ] && [ ! -L "$STATE/.restore-in-progress" ] || { echo 'An interrupted restore must be recovered before backup.' >&2; exit 1; }

# The environment wins; otherwise the operator's config.env, read as data.
setting() {
  local value="${!1:-}"
  if [ -z "$value" ] && [ -r "$STATE/config.env" ]; then
    value="$(grep -E "^$1=" "$STATE/config.env" | tail -1 | cut -d= -f2- || true)"
  fi
  printf '%s' "$value"
}
KEEP="$(setting BACKUP_KEEP)"; KEEP="${KEEP:-14}"
case "$KEEP" in *[!0-9]*) echo "BACKUP_KEEP must be a whole number of backups to keep (0 keeps every one), not \"$KEEP\"" >&2; exit 1;; esac
RECIPIENT="$(setting BACKUP_AGE_RECIPIENT)"
# Asked for encryption and cannot encrypt: refuse before anything is written.
# A plaintext copy of the keys where the operator expects ciphertext is worse
# than no copy.
if [ -n "$RECIPIENT" ] && ! command -v age >/dev/null 2>&1; then
  echo 'BACKUP_AGE_RECIPIENT is set, but age is not installed (https://age-encryption.org). Install it or unset the variable; nothing was stopped or written.' >&2
  exit 1
fi
mkdir -p "$(dirname "$OUT")"

extra=()
if [ "$MODE" = consistent ]; then
  python3 scripts/runtime-backup.py preflight --root "$STATE" --release "$RELEASE" --output "$OUT" --name "$NAME"
  bash scripts/cluster.sh stop
  # The preflight has named every skipped entry already; the backup counts them.
  extra+=(--quiesced --brief)
  echo 'Consistent backup: all writers stopped; active kernel memory is discarded.' >&2
else
  echo 'Live backup: SQLite snapshot is consistent; workspace files are copied at different instants.' >&2
fi
python3 scripts/runtime-backup.py backup --root "$STATE" --release "$RELEASE" --output "$OUT" --mode "$MODE" --name "$NAME" ${extra[@]+"${extra[@]}"}
python3 scripts/runtime-backup.py validate --archive "$OUT" --name "$NAME" >&2
if [ "$MODE" = consistent ]; then
  if [ "${RESUME:-}" = 1 ]; then bash scripts/cluster.sh start; else echo 'Writers remain stopped. Resume: bash scripts/cluster.sh start' >&2; fi
fi

# After the writers are back: encryption reads the whole archive and has no
# reason to lengthen the stop. The plaintext goes only once the ciphertext is
# complete on disk.
FINAL="$OUT"
if [ -n "$RECIPIENT" ]; then
  to=(-r "$RECIPIENT"); [ ! -f "$RECIPIENT" ] || to=(-R "$RECIPIENT")
  if ! age "${to[@]}" -o "$OUT.age" "$OUT"; then
    rm -f "$OUT.age"
    echo "Encryption failed; the validated plaintext archive is kept at $OUT" >&2
    exit 1
  fi
  python3 -c 'import os, sys; fd = os.open(sys.argv[1], os.O_RDONLY); os.fsync(fd); os.close(fd)' "$OUT.age"
  rm -f "$OUT"
  FINAL="$OUT.age"
fi
python3 scripts/runtime-backup.py prune --directory "$(dirname "$FINAL")" --keep "$KEEP" --fresh "$FINAL"
echo "Backup: $FINAL" >&2
