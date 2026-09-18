#!/usr/bin/env bash
#
# Проверка образа colloq-vast на своей машине — без аренды и без риска для
# идущего рядом занятия.
#
#   deploy/vast/smoke.sh up      поднять «машину» (docker:dind), загрузить в неё образ,
#                                colloq-host up и дождаться готовности ядра
#   deploy/vast/smoke.sh e2e     завладеть инстансом, открыть комнату, выполнить
#                                ячейки настоящим ядром (scripts/e2e.mts), снять копию
#   deploy/vast/smoke.sh stop    мягкая остановка Colloq: SIGTERM, снимки, база
#   deploy/vast/smoke.sh down    убрать «машину» со всем, что в ней было
#
# ПОЧЕМУ В DIND, А НЕ В DOCKER ЭТОЙ МАШИНЫ. Сервер убирает простаивающие
# контейнеры комнат по метке docker (kernel/index.ts · sweepIdleKernelsOnce) —
# ВСЕ контейнеры с меткой colloq.kind=room-kernel на демоне, а не только свои.
# Стенд, поднятый на том же демоне, что и `make dev`, через полчаса снёс бы
# ядра чужой пары. Внутри dind свой демон: он и есть арендованная VM — пустой,
# с сокетом, без собранных ядер, — и colloq-host на нём проходит тот же путь,
# что на vast.
#
# Переменные: IMAGE (colloq-vast:dev), SMOKE_PORT (13000), SMOKE_NAME,
# SEED_KERNEL=1 — отдать «машине» уже собранный здесь colloq-kernel:base вместо
# сборки (минуты против секунд), SMOKE_WAIT — сколько ждать ядра (900 с).
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
  # --privileged — только у стенда: так dind получает свой демон. Сам образ
  # colloq-vast внутри него работает без привилегий, как на VM.
  # Демон стенда слушает только свой сокет: без TLS dind по умолчанию открывает
  # ещё и tcp 2375 — root-доступ для любого контейнера на мосту этой машины.
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
  # bash и curl — у dind их нет, а у Ubuntu VM vast они есть.
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
  # Стенд — одноразовый инстанс, завладеть им здесь можно. На живом инстансе
  # scripts/e2e.mts нарочно этого не делает: это решение человека.
  code="$(curl -s -o /dev/null -w '%{http_code}' -H 'content-type: application/json' \
    -d "{\"token\":\"$token\",\"name\":\"Smoke Owner\",\"email\":\"owner@example.com\"}" \
    "$BASE/api/admin/claim")"
  case "$code" in 201|409) : ;; *) die "claim answered HTTP $code" ;; esac
  tmp="$(mktemp -d)"
  printf '%s\n' "$token" > "$tmp/setup-token"
  E2E_BASE_URL="$BASE" DATA_DIR="$tmp" node --import tsx scripts/e2e.mts || { rm -rf "$tmp"; die "scripts/e2e.mts"; }
  rm -rf "$tmp"
  # Контейнер комнаты e2e уже убрал вместе с семинаром — поэтому не список,
  # а история: видно, что комнате поднимали СВОЙ контейнер и сносили его.
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
