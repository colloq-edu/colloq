#!/usr/bin/env bash
# Cluster application backup. MODE=live (default) or MODE=consistent.
# Consistent mode stops app, broker and every room; RESUME=1 explicitly starts
# the application afterwards. Failure leaves writers stopped for investigation.
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
mkdir -p "$STATE"
if ! python3 scripts/state-lock.py held --state "$STATE"; then
  exec python3 scripts/state-lock.py run --state "$STATE" -- bash "$SCRIPT_PATH" "$@"
fi
[ ! -e "$STATE/.restore-in-progress" ] && [ ! -L "$STATE/.restore-in-progress" ] || { echo 'An interrupted restore must be recovered before backup.' >&2; exit 1; }
extra=()
if [ "$MODE" = consistent ]; then
  bash scripts/cluster.sh stop
  extra+=(--quiesced)
  echo 'Consistent backup: all writers stopped; active kernel memory is discarded.' >&2
else
  echo 'Live backup: SQLite snapshot is consistent; workspace files are copied at different instants.' >&2
fi
python3 scripts/runtime-backup.py backup --root "$STATE" --release "$RELEASE" --output "$OUT" --mode "$MODE" --name "$NAME" "${extra[@]}"
python3 scripts/runtime-backup.py validate --archive "$OUT" --name "$NAME" >&2
if [ "$MODE" = consistent ]; then
  if [ "${RESUME:-}" = 1 ]; then bash scripts/cluster.sh start; else echo 'Writers remain stopped. Resume: bash scripts/cluster.sh start' >&2; fi
fi
