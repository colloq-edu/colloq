#!/usr/bin/env bash
# Compatibility names now manage the isolated k3s application.
set -euo pipefail
cd "$(dirname "$0")/.."
command="${1:-help}"; [ "$#" -eq 0 ] || shift
case "$command" in
  restart) ./scripts/cluster.sh stop; exec ./scripts/cluster.sh start ;;
  install) exec ./scripts/cluster.sh install "$@" ;;
  start|stop|status|logs) exec ./scripts/cluster.sh "$command" "$@" ;;
  *) exec ./scripts/cluster.sh help ;;
esac
