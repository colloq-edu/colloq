#!/usr/bin/env bash
#
# A check of the colloq-vast image on your own machine, with no rental and no
# risk to a class running next to it.
#
#   deploy/vast/smoke.sh up      bring up the "machine" (docker:dind), load the image into it,
#                                colloq-host up and wait until the kernel is ready
#   deploy/vast/smoke.sh e2e     claim the instance, open a room, run cells on a
#                                real kernel (scripts/e2e.mts), take a backup
#   deploy/vast/smoke.sh stop    a gentle stop of Colloq: SIGTERM, snapshots, database
#   deploy/vast/smoke.sh down    remove the "machine" with everything that was in it
#
# WHY IN DIND AND NOT IN THE DOCKER OF THIS MACHINE. The server removes idle
# room containers by docker label (kernel/index.ts · sweepIdleKernelsOnce): ALL
# the containers labeled colloq.kind=room-kernel on the daemon, not only its
# own. A rig brought up on the same daemon as `make dev` would take down the
# kernels of another class half an hour later. Inside dind there is a daemon of
# its own: it is the rented VM (empty, with a socket, no kernels built), and
# colloq-host on it goes the same path as on vast.
#
# Variables: IMAGE (colloq-vast:dev), SMOKE_PORT (13000), SMOKE_NAME,
# SEED_KERNEL=1 to hand the "machine" the colloq-kernel:base already built here
# instead of a build (minutes versus seconds), SMOKE_WAIT for how long to wait
# for the kernel (900 s).
set -euo pipefail

cd "$(dirname "$0")/../.."

IMAGE="${IMAGE:-colloq-vast:dev}"
NAME="${SMOKE_NAME:-colloq-vast-smoke}"
PORT="${SMOKE_PORT:-13000}"
DIND="${DIND_IMAGE:-docker:28-dind}"
BASE="http://127.0.0.1:${PORT}"

say() { printf '[smoke] %s\n' "$*"; }
die() { printf '[smoke] FAIL: %s\n' "$*" >&2; exit 1; }
in_vm() { docker exec "$NAME" "$@"; }

up() {
  docker image inspect "$IMAGE" >/dev/null 2>&1 || die "no image $IMAGE — build it: make vast-image"
  if docker container inspect "$NAME" >/dev/null 2>&1; then
    die "$NAME already exists — deploy/vast/smoke.sh down first"
  fi
  say "starting a stand-in VM ($DIND) on $BASE"
  # --privileged only for the rig: that is how dind gets its own daemon. The
  # colloq-vast image itself runs inside it without privileges, as on a VM.
  # The rig's daemon listens only on its own socket: without TLS dind by
  # default also opens tcp 2375, root access for any container on the bridge of
  # this machine.
  docker run -d --privileged --name "$NAME" --label colloq.smoke=1 \
    -e DOCKER_TLS_CERTDIR= -p "127.0.0.1:${PORT}:3000" "$DIND" \
    dockerd --host=unix:///var/run/docker.sock >/dev/null
  local i
  for i in $(seq 1 60); do in_vm docker info >/dev/null 2>&1 && break; sleep 1; done
  in_vm docker info >/dev/null 2>&1 || die "the stand-in docker daemon did not start"
  say "loading $IMAGE into it"
  docker save "$IMAGE" | docker exec -i "$NAME" docker load >/dev/null
  if [ "${SEED_KERNEL:-}" = 1 ] && docker image inspect colloq-kernel:base >/dev/null 2>&1; then
    say "seeding colloq-kernel:base from this machine (SEED_KERNEL=1)"
    docker save colloq-kernel:base | docker exec -i "$NAME" docker load >/dev/null
  fi
  # bash and curl: dind lacks them, while the Ubuntu VM on vast has them.
  in_vm apk add --no-cache bash curl >/dev/null
  in_vm docker run --rm -v /usr/local/sbin:/host "$IMAGE" install-host /host
  docker exec -e COLLOQ_IMAGE="$IMAGE" -e COLLOQ_PULL=0 -e COLLOQ_BIND=0.0.0.0 \
    -e COLLOQ_TUNNEL=none -e PUBLIC_URL="$BASE" -e UI_LANGUAGE=en \
    "$NAME" colloq-host up
  say "waiting for /api/health (the default environment builds on first start)"
  local wait="${SMOKE_WAIT:-900}" body=""
  for i in $(seq 1 "$wait"); do
    body="$(curl -s --max-time 3 "$BASE/api/health" || true)"
    case "$body" in *'"ok":true'*) say "healthy after ${i}s: $body"; return 0 ;; esac
    sleep 1
  done
  in_vm docker logs --tail 80 colloq >&2 || true
  die "not healthy in ${wait}s: $body"
}

e2e() {
  local token tmp code
  token="$(in_vm cat /workspace/colloq/data/setup-token)"
  # The rig is a throwaway instance, so claiming it here is fine. On a live
  # instance scripts/e2e.mts deliberately does not do this: that is a decision
  # for a person.
  code="$(curl -s -o /dev/null -w '%{http_code}' -H 'content-type: application/json' \
    -d "{\"token\":\"$token\",\"name\":\"Smoke Owner\",\"email\":\"owner@example.com\"}" \
    "$BASE/api/admin/claim")"
  case "$code" in 201|409) : ;; *) die "claim answered HTTP $code" ;; esac
  tmp="$(mktemp -d)"
  printf '%s\n' "$token" > "$tmp/setup-token"
  E2E_BASE_URL="$BASE" DATA_DIR="$tmp" node --import tsx scripts/e2e.mts || { rm -rf "$tmp"; die "scripts/e2e.mts"; }
  rm -rf "$tmp"
  # e2e has already removed the room container together with the seminar, so
  # not a list but the history: it shows that the room got a container of ITS
  # OWN, and that it was taken down.
  say "room kernel containers the room got on the stand-in daemon:"
  in_vm docker events --since 30m --until 0s --filter type=container \
    --filter label=colloq.kind=room-kernel --filter event=create --filter event=destroy \
    --format '  {{.Action}}  {{.Actor.Attributes.name}}  {{.Actor.Attributes.image}}'
  say "backup:"
  in_vm colloq-host backup
}

stop() {
  in_vm docker stop -t 30 colloq >/dev/null
  in_vm docker logs --tail 12 colloq
  local code; code="$(in_vm docker inspect -f '{{.State.ExitCode}}' colloq)"
  [ "$code" = 0 ] || die "colloq exited with code $code on SIGTERM"
  say "stopped cleanly (exit 0); colloq-host start brings it back"
}

down() {
  if docker rm -f -v "$NAME" >/dev/null 2>&1; then say "removed $NAME"; else say "nothing to remove"; fi
}

case "${1:-}" in
  up) up ;;
  e2e) e2e ;;
  stop) stop ;;
  down) down ;;
  *) sed -n '5,12p' "$0" | sed 's/^# \{0,1\}//'; exit 2 ;;
esac
