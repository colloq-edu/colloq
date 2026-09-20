#!/usr/bin/env bash
#
# colloq-vast — точка входа образа deploy/vast/Dockerfile.
#
#   colloq-vast serve          (по умолчанию) сервер + туннель + ядра по требованию
#   colloq-vast status         готов ли инстанс вести пару: /api/health и образы ядер
#   colloq-vast link           адрес для аудитории и, пока инстанс ничей, ссылка входа
#   colloq-vast backup         копия занятия в <состояние>/backups/ (база + файлы)
#   colloq-vast restore …      развернуть копию; только при ОСТАНОВЛЕННОМ сервере
#   colloq-vast install-host D положить на хост его менеджер (colloq-host) в каталог D
#   colloq-vast version
#
# ЧТО ЗДЕСЬ ПРОИСХОДИТ И ПОЧЕМУ ТАК.
#
# Ядро каждой комнаты — отдельный контейнер (server/src/kernel/pool.ts), и
# поднимает его демон ХОСТА через примонтированный сокет. Отсюда три вещи,
# которые точка входа обязана сделать до старта сервера, иначе он поднимется
# «здоровым» и откажет на первом Run:
#
#   1. путь каталога состояния глазами хоста. `-v` у контейнера комнаты
#      разбирает демон, а не мы: сервер пишет файлы комнаты в
#      /workspace/colloq/workspace/<id> ВНУТРИ этого контейнера, а демону надо
#      назвать то же место на хосте. Узнаём его у самого демона — по своим
#      монтированиям, — а не просим оператора повторить путь второй раз;
#   2. общая сеть с контейнерами комнат (KERNEL_NETWORK). Сервер ходит к ядру
#      по имени контейнера; без сети canIsolate() отвечает «нет» и КЭШИРУЕТ
#      ответ до перезапуска (pool.ts · networkExists), поэтому сеть заводится
#      раньше сервера, а не «когда понадобится»;
#   3. публичный адрес. Сервер печатает ссылку входа владельца при старте, и
#      печатает её от PUBLIC_URL: туннель поднимается ПЕРВЫМ, чтобы в журнале
#      оказалась настоящая ссылка, а не localhost.
#
# Ядро окружения по умолчанию готовится в фоне уже после старта сервера:
# первая сборка — минуты, а панель и ссылка входа нужны сразу. Пока образа нет,
# /api/health честно отвечает 503 «окружение не собрано», и это правда.
#
# NODE_ENV=development — не опечатка и не отладка. Докер-бэкенд ядер сервер
# пускает только вне production (runtime-client.ts · selectKernelBackend): в
# production он ждёт брокер k3s. Прежний путь на арендованной машине
# (deploy/colloq-legacy.service) идёт ровно так же и по той же причине. Больше
# NODE_ENV в сервере не решает ничего: небезопасный файловый обход включается
# только вместе с COLLOQ_UNSAFE_DEV_FILES=1, а её здесь нет.
set -euo pipefail

APP=/opt/colloq
STATE="${COLLOQ_HOME:-/workspace/colloq}"
export COLLOQ_HOME="$STATE"
PORT="${PORT:-3000}"
APP_UID=1000
APP_GID=1000
SOCK="${DOCKER_SOCK:-/var/run/docker.sock}"
VERSION="${COLLOQ_VERSION:-0.0.0-dev}"

say()  { printf '[vast] %s\n' "$*"; }
warn() { printf '[vast] WARNING: %s\n' "$*" >&2; }
die()  { printf '[vast] ERROR: %s\n' "$*" >&2; exit "${2:-1}"; }

# ----------------------------------------------------------- root → node
#
# От root — только подготовка: каталог состояния и группа сокета docker. Всё
# остальное (сервер, туннели, сборки, копии) — от node, uid 1000: это тот же
# uid, что у пользователя ядра в kernel/Dockerfile, и файлы комнаты читают и
# пишут обе стороны без групп и umask (см. UMask в deploy/colloq-legacy.service
# — там этого совпадения не было, и его пришлось создавать руками).
#
# Честная оговорка: доступ к сокету docker — это root на хосте. Непривилегированный
# uid здесь про владельца файлов и про то, чтобы ошибка в сервере не писала от
# root в чужие каталоги, а не про границу безопасности с хостом.
prepare_as_root() {
  local walk="${1:-}"
  mkdir -p "$STATE"/data "$STATE"/workspace "$STATE"/environments "$STATE"/backups "$STATE"/.colloq
  if [ "$walk" = full ]; then
    # Своё — своим. Копии, привезённые scp от root, и файлы, разложенные руками,
    # иначе становятся «Permission denied» у сервера посреди пары. find, а не
    # chown -R: трогаются только чужие файлы, и повторный старт стоит один обход.
    find "$STATE" -xdev \( ! -user "$APP_UID" -o ! -group "$APP_GID" \) \
      -exec chown -h "$APP_UID:$APP_GID" {} + 2>/dev/null || true
  else
    # status, link, backup — это `docker exec` посреди пары, и обходить ради них
    # весь workspace (датасеты комнат) незачем: его уже разобрал serve. Хватает
    # верхних каталогов — на случай, если их только что завёл mkdir выше.
    chown "$APP_UID:$APP_GID" "$STATE" "$STATE"/data "$STATE"/workspace "$STATE"/environments "$STATE"/backups "$STATE"/.colloq
  fi
  chmod 0700 "$STATE/data"
  touch "$STATE/.env"
  chown "$APP_UID:$APP_GID" "$STATE/.env"
  chmod 0600 "$STATE/.env"
  # Ссылка .env в образе ведёт в /workspace/colloq — умолчание COLLOQ_HOME.
  # Другой каталог состояния оставил бы её висеть: PUBLIC_URL сервер читает из
  # .env ПРИЛОЖЕНИЯ (config.ts · readPublicUrl), и ссылки говорили бы localhost
  # вместо адреса туннеля — при том что панель (environments.ts · envFile) пишет
  # KERNEL_ENV в каталог состояния и ничего не заметила бы.
  if [ "$(readlink "$APP/.env" 2>/dev/null || true)" != "$STATE/.env" ]; then
    ln -sfn "$STATE/.env" "$APP/.env"
  fi
  # Учётка закрытого реестра (colloq-host монтирует её только на чтение):
  # копией в ~/.docker пользователя node. Файл, смонтированный прямо туда,
  # завёл бы ~/.docker от root, и buildx не смог бы писать рядом свой каталог.
  if [ -s /run/colloq/docker-config.json ]; then
    install -d -o "$APP_UID" -g "$APP_GID" -m 0700 /home/node/.docker
    install -o "$APP_UID" -g "$APP_GID" -m 0600 /run/colloq/docker-config.json /home/node/.docker/config.json
  fi
}

drop_to_app() {
  local groups=()
  if [ -S "$SOCK" ]; then
    groups=(--groups "$(stat -c %g "$SOCK")")
  else
    groups=(--clear-groups)
  fi
  # HOME обязателен: buildx пишет ~/.docker/buildx, и под HOME=/root сборка
  # окружения падает на правах раньше первого слоя.
  exec setpriv --reuid="$APP_UID" --regid="$APP_GID" "${groups[@]}" --inh-caps=-all \
    env HOME=/home/node USER=node LOGNAME=node COLLOQ_VAST_DROPPED=1 "$0" "$@"
}

# ------------------------------------------------------------ docker хоста
require_docker() {
  if docker version --format '{{.Server.Version}}' >/dev/null 2>&1; then return 0; fi
  cat >&2 <<'MSG'
[vast] ERROR: no Docker daemon is reachable at /var/run/docker.sock.

  Colloq gives every room its own kernel container, and this image starts those
  containers on the HOST's Docker daemon. That needs the host socket:

      docker run ... -v /var/run/docker.sock:/var/run/docker.sock ...

  An ordinary Vast.ai *Docker instance* cannot provide it (Vast disables
  Docker-in-Docker). Rent a Vast *VM* and use the template described in
  deploy/vast/README.md — the VM runs this same image with the socket mounted.
MSG
  exit 78
}

# Свой контейнер: чтобы спросить демон о своих монтированиях и сетях.
SELF=""
locate_self() {
  SELF="${COLLOQ_CONTAINER:-$(hostname)}"
  docker inspect "$SELF" >/dev/null 2>&1 \
    || die "cannot inspect this container as \"$SELF\". Start it without --hostname, or set COLLOQ_CONTAINER=<its name>."
}

# Путь каталога состояния глазами хоста — самое длинное монтирование, внутри
# которого он лежит. Не сошлось ни одно — значит, состояние живёт в слое
# контейнера: демон смонтирует комнате пустоту, файлы семинара разойдутся с
# ядром, а при обновлении образа исчезнет всё. Это отказ, а не предупреждение.
HOST_STATE=""
locate_host_state() {
  if [ -n "${COLLOQ_HOST_STATE:-}" ]; then HOST_STATE="$COLLOQ_HOST_STATE"; return; fi
  local best="" source="" dest src
  while IFS=$'\t' read -r dest src; do
    [ -n "$dest" ] || continue
    if [ "$STATE" = "$dest" ] || [ "${STATE#"$dest"/}" != "$STATE" ]; then
      if [ "${#dest}" -gt "${#best}" ]; then best="$dest"; source="$src"; fi
    fi
  done < <(docker inspect -f '{{range .Mounts}}{{.Destination}}{{"\t"}}{{.Source}}{{"\n"}}{{end}}' "$SELF")
  [ -n "$best" ] || die "$STATE is not a mounted directory. Mount one from the host at the same path:
      -v /workspace/colloq:/workspace/colloq
  Room kernels are sibling containers; they can only see files that live on the host."
  HOST_STATE="${source}${STATE#"$best"}"
}

NET=""
ensure_network() {
  NET="${KERNEL_NETWORK:-colloq}"
  if ! docker network inspect "$NET" >/dev/null 2>&1; then
    docker network create "$NET" >/dev/null || die "could not create the docker network $NET"
    say "created docker network $NET for room kernels"
  fi
  local joined
  joined=" $(docker inspect -f '{{range $name, $_ := .NetworkSettings.Networks}}{{$name}} {{end}}' "$SELF") "
  case "$joined" in
    *" $NET "*) : ;;
    *) docker network connect "$NET" "$SELF" || die "could not attach this container to $NET"
       say "attached to docker network $NET" ;;
  esac
}

# ------------------------------------------------------------ .env состояния
#
# Одна строка PUBLIC_URL в <состояние>/.env. Сервер перечитывает её не реже раза
# в две секунды (config.ts · readPublicUrl), поэтому новый адрес быстрого
# туннеля после его перезапуска доезжает до ссылок без перезапуска сервера.
# Через tmp и mv в том же каталоге: читатель не должен увидеть полфайла.
set_public_url() {
  local url="$1" file="$STATE/.env" tmp
  tmp="$(mktemp "$STATE/.env.XXXXXX")"
  { grep -v '^PUBLIC_URL=' "$file" 2>/dev/null || true; printf 'PUBLIC_URL=%s\n' "$url"; } > "$tmp"
  chmod 0600 "$tmp"
  mv -f "$tmp" "$file"
}

read_state_env() {
  grep -E "^$1=" "$STATE/.env" 2>/dev/null | tail -1 | cut -d= -f2- | tr -d '\r' || true
}

# ------------------------------------------------------------- туннели
#
# Четыре способа, выбор — COLLOQ_TUNNEL (auto по умолчанию):
#
#   relay       frpc → свой ретранслятор (RELAY_*), адрес https://<имя>.<домен>.
#               Путь для России: адреса Cloudflare оттуда не открываются.
#   cloudflare  CLOUDFLARE_TUNNEL_TOKEN + COLLOQ_HOSTNAME — именованный туннель,
#               иначе быстрый *.trycloudflare.com со случайным адресом.
#   direct      http://$PUBLIC_IPADDR:$VAST_TCP_PORT_<PORT> — проброс портов vast,
#               без TLS и без посредника.
#   none        ничего не поднимать; адрес — PUBLIC_URL или localhost.
#
# auto берёт relay, если он настроен; иначе именованный Cloudflare; иначе
# none, если адрес назван явно; иначе быстрый туннель.
MODE=""
PUBLIC=""
TUNNEL_PID=""
TUNNEL_LOG=""
RUN_DIR=""

relay_hostname() {
  local host="${COLLOQ_HOSTNAME:-}"
  # Короткое имя достраивается до зоны ретранслятора: HOST=demo → demo.<домен>.
  case "$host" in
    *.*) printf '%s' "$host" ;;
    '') printf '' ;;
    *) printf '%s.%s' "$host" "${RELAY_DOMAIN:-}" ;;
  esac
}

pick_mode() {
  MODE="${COLLOQ_TUNNEL:-auto}"
  if [ "$MODE" = auto ]; then
    if [ -n "${COLLOQ_HOSTNAME:-}" ] && [ -n "${RELAY_ADDR:-}" ] && [ -n "${RELAY_TOKEN:-}" ] && [ -n "${RELAY_DOMAIN:-}" ]; then
      MODE=relay
    elif [ -n "${CLOUDFLARE_TUNNEL_TOKEN:-}" ] && [ -n "${COLLOQ_HOSTNAME:-}" ]; then
      MODE=cloudflare
    elif [ -n "${PUBLIC_URL:-}" ]; then
      MODE=none
    else
      MODE=cloudflare
    fi
  fi
  case "$MODE" in
    relay)
      [ -n "${RELAY_ADDR:-}" ] && [ -n "${RELAY_TOKEN:-}" ] && [ -n "${RELAY_DOMAIN:-}" ] && [ -n "${COLLOQ_HOSTNAME:-}" ] \
        || die "COLLOQ_TUNNEL=relay needs COLLOQ_HOSTNAME, RELAY_ADDR, RELAY_TOKEN and RELAY_DOMAIN."
      local host; host="$(relay_hostname)"
      # Имя уходит строкой в frpc.toml (start_relay): кавычка или пробел в нём
      # сломали бы конфиг так, что frpc назвал бы виноватой строку файла, а не
      # переменную.
      case "$host" in
        *[!A-Za-z0-9.-]*) die "COLLOQ_HOSTNAME=$COLLOQ_HOSTNAME: a hostname has only letters, digits, dots and hyphens." ;;
      esac
      [ "${host%".$RELAY_DOMAIN"}" != "$host" ] \
        || die "$host is not under RELAY_DOMAIN=$RELAY_DOMAIN: the relay only serves names in its own zone."
      PUBLIC="https://$host" ;;
    cloudflare)
      if [ -n "${CLOUDFLARE_TUNNEL_TOKEN:-}" ]; then
        [ -n "${COLLOQ_HOSTNAME:-}" ] || die "a named Cloudflare tunnel needs COLLOQ_HOSTNAME (the hostname routed to it)."
        PUBLIC="https://${COLLOQ_HOSTNAME}"
      fi ;;
    direct)
      # На Docker-инстансе vast сам кладёт адрес и внешний порт в окружение; до
      # VM эти переменные могут не доехать — тогда адрес называют PUBLIC_URL.
      local mapped_var="VAST_TCP_PORT_${PORT}"
      local mapped="${!mapped_var:-}"
      if [ -z "${PUBLIC_URL:-}" ]; then
        [ -n "${PUBLIC_IPADDR:-}" ] && [ -n "$mapped" ] \
          || die "COLLOQ_TUNNEL=direct needs PUBLIC_URL=http://<ip>:<port>, or PUBLIC_IPADDR and $mapped_var (Vast sets both for -p ${PORT}:${PORT})."
        PUBLIC="http://${PUBLIC_IPADDR}:${mapped}"
      fi ;;
    none)
      PUBLIC="${PUBLIC_URL:-http://localhost:${PORT}}" ;;
    *) die "unknown COLLOQ_TUNNEL=$MODE (auto, relay, cloudflare, direct, none)" ;;
  esac
  # Явный PUBLIC_URL сильнее вычисленного: оператор знает про свой прокси
  # больше, чем мы про переменные vast.
  if [ -n "${PUBLIC_URL:-}" ] && [ "$MODE" != none ]; then PUBLIC="$PUBLIC_URL"; fi
}

# Строки туннеля — в журнал контейнера с приставкой, и в файл: по файлу ждём
# подтверждения. `> >(…)` оставляет в $! номер самого туннеля, а не tee.
start_relay() {
  local conf="$RUN_DIR/frpc.toml" sub host
  host="$(relay_hostname)"
  sub="${host%".$RELAY_DOMAIN"}"
  # Секрет ретранслятора — в файл 0600 в каталоге контейнера, а не в аргументы
  # (командную строку видит ps) и не в каталог состояния (он едет в копии).
  (umask 077; cat > "$conf" <<CONF
serverAddr = "${RELAY_ADDR}"
serverPort = ${RELAY_PORT:-7000}
auth.method = "token"
auth.token = "${RELAY_TOKEN}"
log.to = "console"
log.level = "info"
# Журнал контейнера — не терминал: escape-коды цвета в нём только мусор.
log.disablePrintColor = true
# Готовые соединения к ретранслятору: звонок — это вся группа разом, и без
# запаса каждый первый запрос ждёт установки соединения (см. scripts/host.sh).
transport.poolCount = 5
# Первый вход неудачен — не выходить, а пробовать дальше: ретранслятор мог
# моргнуть, а поднимать frpc заново некому, кроме нас.
loginFailExit = false

[[proxies]]
name = "${sub}"
type = "http"
localIP = "127.0.0.1"
localPort = ${PORT}
subdomain = "${sub}"
CONF
  )
  : > "$TUNNEL_LOG"
  frpc -c "$conf" > >(tee -a "$TUNNEL_LOG" | sed -u 's/^/[frpc] /') 2>&1 &
  TUNNEL_PID=$!
  # Отказ ретранслятора — не смерть контейнера: сервер поднимается всё равно
  # (до него можно дойти по ssh -L), а frpc снимается и перезапускается циклом
  # в serve с нарастающей паузой. Занятое имя так и лечится само: прежняя
  # машина уходит — следующая попытка его получает. Строки — те, что печатает
  # frpc 0.71 (проверены на живом ретрансляторе, см. scripts/host.sh).
  local i
  for i in $(seq 1 30); do
    if grep -q 'start proxy success' "$TUNNEL_LOG" 2>/dev/null; then say "relay tunnel is up: $PUBLIC"; return 0; fi
    if grep -q 'already exists' "$TUNNEL_LOG" 2>/dev/null; then
      warn "$host is taken on the relay: this class is open from another machine. Will retry."
      kill -TERM "$TUNNEL_PID" 2>/dev/null || true
      return 0
    fi
    if grep -qiE 'authorization failed|authentication failed|token in login doesn' "$TUNNEL_LOG" 2>/dev/null; then
      warn "the relay did not accept RELAY_TOKEN. Will retry."
      kill -TERM "$TUNNEL_PID" 2>/dev/null || true
      return 0
    fi
    kill -0 "$TUNNEL_PID" 2>/dev/null || { warn "frpc exited before the tunnel opened"; return 0; }
    sleep 1
  done
  warn "no answer from the relay in 30 s; frpc keeps trying"
}

start_cloudflare() {
  : > "$TUNNEL_LOG"
  if [ -n "${CLOUDFLARE_TUNNEL_TOKEN:-}" ]; then
    # Токен — переменной окружения cloudflared (TUNNEL_TOKEN), не аргументом.
    TUNNEL_TOKEN="$CLOUDFLARE_TUNNEL_TOKEN" cloudflared tunnel --no-autoupdate run \
      > >(tee -a "$TUNNEL_LOG" | sed -u 's/^/[cloudflared] /') 2>&1 &
    TUNNEL_PID=$!
    say "named Cloudflare tunnel started for $PUBLIC"
    return 0
  fi
  cloudflared tunnel --no-autoupdate --url "http://127.0.0.1:${PORT}" \
    > >(tee -a "$TUNNEL_LOG" | sed -u 's/^/[cloudflared] /') 2>&1 &
  TUNNEL_PID=$!
  local i url=""
  for i in $(seq 1 60); do
    url="$(grep -oE 'https://[a-z0-9-]+\.trycloudflare\.com' "$TUNNEL_LOG" 2>/dev/null | head -1 || true)"
    [ -n "$url" ] && break
    kill -0 "$TUNNEL_PID" 2>/dev/null || break
    sleep 1
  done
  if [ -n "$url" ]; then
    PUBLIC="$url"
    say "quick Cloudflare tunnel is up: $PUBLIC (random address; it changes when the tunnel restarts)"
  else
    warn "the quick Cloudflare tunnel gave no address in 60 s; links will say ${PUBLIC:-localhost} until it does"
  fi
}

TUNNEL_SINCE=0
start_tunnel() {
  TUNNEL_PID=""
  TUNNEL_SINCE=$SECONDS
  case "$MODE" in
    relay) start_relay ;;
    cloudflare) start_cloudflare ;;
    *) : ;;
  esac
}

# Зеркало статики на ретрансляторе (scripts/relay-assets.py): иначе каждый
# байт /assets едет через туннель к каждому пришедшему. Не отказ, если не
# вышло: без зеркала пара идёт, только медленнее. Заголовок с секретом — из
# файла (`-H @file`), а не аргументом.
upload_relay_assets() {
  [ "$MODE" = relay ] || return 0
  local host archive hdr code dirs=()
  host="$(relay_hostname)"
  for d in assets fonts pdf; do [ -d "$APP/web/dist/$d" ] && dirs+=("$d"); done
  [ "${#dirs[@]}" -gt 0 ] || return 0
  archive="$RUN_DIR/assets.tgz"; hdr="$RUN_DIR/relay-header"
  tar -czf "$archive" --exclude '.*' -C "$APP/web/dist" "${dirs[@]}"
  (umask 077; printf 'Authorization: Bearer %s\n' "$RELAY_TOKEN" > "$hdr")
  code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 180 --upload-file "$archive" \
    -H @"$hdr" -H 'Content-Type: application/gzip' \
    "https://${host}/.relay/assets/${host}" || true)"
  rm -f "$archive" "$hdr"
  case "$code" in
    200) say "static files mirrored on the relay" ;;
    404|000) say "the relay has no static mirror; static files go through the tunnel" ;;
    *) warn "could not mirror static files on the relay (HTTP $code); they go through the tunnel" ;;
  esac
}

# ------------------------------------------------------------ ядра комнат
#
# Образ окружения по умолчанию (и KERNEL_PRELOAD, через запятую) — до первой
# пары, а не на первом Run. Порядок источников:
#
#   1. уже есть в docker хоста — ничего не делаем (пересоздание машины из
#      образа не трогает образы, а обновление colloq-vast — тем более);
#   2. KERNEL_IMAGE_REPO — вытянуть опубликованный образ релиза
#      (<repo>:<тег>-<окружение>, как их называет scripts/release-build.py) и
#      назвать его colloq-kernel:<окружение>, как ждёт pool.ts;
#   3. собрать из контекста, лежащего в образе, тем же вызовом docker, что и
#      панель (environments.ts · buildCommand) и CLI (launch-prepare.ts).
#
# Цепочка `# colloq: from <родитель>` проходится от корня к листу, как у
# панели: gpu стоит на base-gpu, и torch с CUDA ставится один раз.
env_file_for() {
  local name="$1"
  if [ -f "$STATE/environments/$name.txt" ]; then printf '%s' "$STATE/environments/$name.txt"
  elif [ -f "$APP/kernel/environments/$name.txt" ]; then printf '%s' "$APP/kernel/environments/$name.txt"
  fi
}

chain_of() {
  local name="$1" chain=() parent file i=0
  while [ -n "$name" ] && [ "$i" -lt 8 ]; do
    file="$(env_file_for "$name")"
    [ -n "$file" ] || { warn "no environment called \"$name\""; return 1; }
    chain=("$name" "${chain[@]}")
    parent="$(sed -nE 's/^[[:space:]]*#[[:space:]]*colloq:[[:space:]]*from[[:space:]]+([^[:space:]]+)[[:space:]]*$/\1/p' "$file" | head -1)"
    name="$parent"; i=$((i + 1))
  done
  printf '%s\n' "${chain[@]}"
}

kernel_context() {
  # Свои окружения поверх привезённых — копией, как делает сервер
  # (environments.ts · buildContext): контекст docker один каталог.
  if compgen -G "$STATE/environments/*.txt" >/dev/null; then
    local staged="$STATE/.colloq/kernel-context/_boot"
    rm -rf "$staged"; mkdir -p "$(dirname "$staged")"
    cp -a "$APP/kernel" "$staged"
    cp -p "$STATE"/environments/*.txt "$staged/environments/"
    printf '%s' "$staged"
  else
    printf '%s' "$APP/kernel"
  fi
}

prepare_kernels() {
  local wanted active names=() chain=() name link parent ctx file py tag args
  active="$(read_state_env KERNEL_ENV)"; active="${active:-${KERNEL_ENV:-base}}"
  wanted="${KERNEL_PRELOAD:-$active}"
  IFS=',' read -r -a names <<< "$wanted"
  for name in "${names[@]}"; do
    name="$(printf '%s' "$name" | tr -d '[:space:]')"
    [ -n "$name" ] || continue
    # Цепочка целиком заранее, а не `while read … < <(…)`: docker внутри цикла
    # не должен делить с ним stdin.
    mapfile -t chain < <(chain_of "$name" || true)
    parent=""
    for link in "${chain[@]}"; do
      [ -n "$link" ] || continue
      if docker image inspect "colloq-kernel:$link" >/dev/null 2>&1; then
        parent="colloq-kernel:$link"; continue
      fi
      if [ -n "${KERNEL_IMAGE_REPO:-}" ]; then
        tag="${KERNEL_IMAGE_TAG:-v${VERSION}}-${link}"
        say "[kernels] pulling ${KERNEL_IMAGE_REPO}:${tag}"
        if docker pull -q "${KERNEL_IMAGE_REPO}:${tag}" </dev/null >/dev/null \
            && docker tag "${KERNEL_IMAGE_REPO}:${tag}" "colloq-kernel:$link"; then
          stamp_environment "$link"; parent="colloq-kernel:$link"; continue
        fi
        warn "[kernels] could not pull ${KERNEL_IMAGE_REPO}:${tag}; building \"$link\" here instead"
      fi
      ctx="$(kernel_context)"
      args=(build -f "$ctx/Dockerfile" --build-arg "KERNEL_ENV=$link")
      if [ -n "$parent" ]; then
        args+=(--build-arg "PARENT=$parent")
      else
        # Корень цепочки: версию Python называет директива его файла; нет
        # директивы — умолчание самого kernel/Dockerfile, второй копии имени
        # базового образа здесь не заводим.
        file="$(env_file_for "$link")"
        py="$(sed -nE 's/^[[:space:]]*#[[:space:]]*colloq:[[:space:]]*python[[:space:]]+(3\.[0-9]+)[[:space:]]*$/\1/p' "$file" | head -1)"
        [ -z "$py" ] || args+=(--build-arg "PARENT=python:${py}-slim-bookworm")
      fi
      args+=(-t "colloq-kernel:$link" "$ctx")
      say "[kernels] building \"$link\" (the first build takes minutes; the panel works meanwhile)"
      if DOCKER_BUILDKIT=1 BUILDKIT_PROGRESS=plain docker "${args[@]}" </dev/null 2>&1 \
          | sed -u "s/^/[kernels:$link] /"; then
        stamp_environment "$link"; parent="colloq-kernel:$link"
      else
        warn "[kernels] building \"$link\" failed; rooms on it will not start. Retry from the panel (Environments → Build)."
        break
      fi
    done
  done
  say "[kernels] done; readiness: curl -s http://127.0.0.1:${PORT}/api/health"
}

# Штамп «что собрано» — тем же файлом, что пишет панель (environments.ts ·
# ownStampFor): иначе свежесть образа панель судит по времени правки списка, и
# вытянутый из реестра образ мог бы выглядеть «Needs rebuild».
stamp_environment() {
  local file; file="$(env_file_for "$1")"
  [ -n "$file" ] || return 0
  cp "$file" "$STATE/environments/.$1.built" 2>/dev/null || true
}

# ------------------------------------------------------------------ serve
SERVER_PID=""
PREP_PID=""
STOPPING=""

start_server() {
  # JUPYTER_TOKEN докер-бэкенду не нужен вовсе: у каждой комнаты свой токен,
  # выведенный из ключа подписи (pool.ts · roomToken). Случайный здесь — только
  # чтобы сервер не печатал предупреждение про известный всем токен из
  # .env.example, которое к этому инстансу не относится.
  local jt; jt="$(head -c 24 /dev/urandom | od -An -tx1 | tr -d ' \n')"
  # Секреты туннеля нужны точке входа, а не серверу: он их не читает, а всё,
  # что лежит в его окружении, наследуют и его дочерние процессы (docker CLI,
  # сборки окружений).
  (
    cd "$APP"
    exec env \
      -u RELAY_TOKEN -u CLOUDFLARE_TUNNEL_TOKEN \
      NODE_ENV=development \
      KERNEL_BACKEND=docker \
      KERNEL_ISOLATION=required \
      KERNEL_NETWORK="$NET" \
      DATA_DIR="$STATE/data" \
      WORKSPACE_DIR="$STATE/workspace" \
      WORKSPACE_HOST_DIR="$HOST_STATE/workspace" \
      DATA_HOST_DIR="$HOST_STATE/data" \
      STATIC_DIR="$APP/web/dist" \
      BIND_ADDR="${BIND_ADDR:-0.0.0.0}" \
      JUPYTER_TOKEN="$jt" \
      node server/dist/server.js
  ) &
  SERVER_PID=$!
}

wait_live() {
  local i
  for i in $(seq 1 90); do
    curl -fsS -o /dev/null --max-time 2 "http://127.0.0.1:${PORT}/api/livez" 2>/dev/null && return 0
    kill -0 "$SERVER_PID" 2>/dev/null || return 1
    sleep 1
  done
  return 1
}

on_term() {
  [ -z "$STOPPING" ] || return 0
  STOPPING=1
  say "stopping: the server saves notebooks and closes the database; room kernels keep running"
  [ -n "$SERVER_PID" ] && kill -TERM "$SERVER_PID" 2>/dev/null || true
  # Сервер отводит себе восемь секунд (SHUTDOWN_GRACE_MS); ждём с запасом.
  local i
  for i in $(seq 1 25); do kill -0 "$SERVER_PID" 2>/dev/null || break; sleep 1; done
  [ -n "$PREP_PID" ] && kill -TERM "$PREP_PID" 2>/dev/null || true
  [ -n "$TUNNEL_PID" ] && kill -TERM "$TUNNEL_PID" 2>/dev/null || true
  wait "$SERVER_PID" 2>/dev/null || true
  exit 0
}

serve() {
  say "Colloq ${VERSION} (${COLLOQ_REVISION:-unknown}) — image colloq-vast"
  require_docker
  locate_self
  locate_host_state
  ensure_network
  RUN_DIR="$(mktemp -d /tmp/colloq-vast.XXXXXX)"
  TUNNEL_LOG="$RUN_DIR/tunnel.log"
  trap on_term TERM INT

  pick_mode
  start_tunnel
  set_public_url "${PUBLIC:-http://localhost:${PORT}}"

  start_server
  wait_live || die "the server did not come up; see the lines above"

  local gpus="${KERNEL_GPUS:-none}"
  say "ready: ${PUBLIC:-http://localhost:${PORT}}"
  say "  state   $STATE (host: $HOST_STATE)"
  say "  kernels one container per room on docker network $NET; GPUs: $gpus"
  say "  owner   the setup link is in the box above while nobody owns this instance;"
  say "          print it again with: docker exec <container> colloq-vast link"
  upload_relay_assets

  # Без errexit: упавшая команда посреди подготовки должна стать строкой в
  # журнале, а не молча убитой фоновой подоболочкой.
  (set +e; prepare_kernels) &
  PREP_PID=$!

  local backoff=5 done_pid code
  while :; do
    done_pid=""
    code=0
    if [ -n "$TUNNEL_PID" ]; then
      wait -n -p done_pid "$SERVER_PID" "$TUNNEL_PID" || code=$?
    else
      wait -n -p done_pid "$SERVER_PID" || code=$?
    fi
    [ -z "$STOPPING" ] || continue
    [ -n "$done_pid" ] || continue
    if [ "$done_pid" = "$SERVER_PID" ]; then
      # Сервер упал — выходим с его кодом, и перезапуском займётся docker
      # (--restart unless-stopped в colloq-host): поднимать процесс в живом
      # контейнере с полусломанным туннелем честнее не станет.
      warn "the server exited with code $code"
      [ -n "$TUNNEL_PID" ] && kill -TERM "$TUNNEL_PID" 2>/dev/null || true
      exit "$code"
    fi
    # Пауза растёт до минуты на отказах подряд и сбрасывается, если туннель
    # до этого прожил дольше пяти минут: моргнувший посреди пары ретранслятор
    # не должен стоить минуты ожидания только потому, что утром был отказ.
    [ $((SECONDS - TUNNEL_SINCE)) -lt 300 ] || backoff=5
    warn "the tunnel exited (code $code); restarting it in ${backoff}s"
    sleep "$backoff"
    backoff=$((backoff * 2 > 60 ? 60 : backoff * 2))
    local before="$PUBLIC"
    start_tunnel
    if [ -n "$PUBLIC" ] && [ "$PUBLIC" != "$before" ]; then
      set_public_url "$PUBLIC"
      say "the public address changed: $PUBLIC"
    fi
  done
}

# ------------------------------------------------------------ сервисные
status() {
  local body
  body="$(curl -s --max-time 10 "http://127.0.0.1:${PORT}/api/health" || true)"
  if [ -z "$body" ]; then say "the server does not answer on :${PORT}"; exit 1; fi
  printf '%s\n' "$body"
  say "kernel images on the host:"
  docker image ls colloq-kernel --format '  {{.Repository}}:{{.Tag}}  {{.Size}}  {{.CreatedSince}}' 2>/dev/null || true
  say "room containers:"
  docker ps -a --filter label=colloq.kind=room-kernel --format '  {{.Names}}  {{.Status}}' 2>/dev/null || true
  case "$body" in *'"ok":true'*) exit 0 ;; *) exit 1 ;; esac
}

link() {
  local url claimed token
  url="$(read_state_env PUBLIC_URL)"; url="${url:-http://localhost:${PORT}}"
  say "address for the class: $url"
  claimed="$(curl -s --max-time 5 "http://127.0.0.1:${PORT}/api/admin/state" || true)"
  case "$claimed" in
    *'"claimed":false'*)
      token="$(cat "$STATE/data/setup-token" 2>/dev/null || true)"
      [ -n "$token" ] && say "nobody owns this instance yet — open: $url/admin/t/$token"
      say "that link is the key to the instance: do not paste it into the class chat" ;;
    *'"claimed":true'*) say "the instance has an owner; staff sign in with their personal links" ;;
    *) warn "the server did not answer /api/admin/state" ;;
  esac
}

backup() {
  cd "$APP"
  bash scripts/backup-local.sh
  # Подсказка скрипта называет команду колеса pip (`colloq restore --legacy`),
  # которой на VM нет; здесь обратная дорога — colloq-host.
  say "restore on a machine running this image: colloq-host restore backups/<the .db above>"
}

restore() {
  # restore.sh сам откажет под живым сервером — но спрашивает он localhost ЭТОГО
  # контейнера. Разовый `docker run … restore` живёт в своём сетевом
  # пространстве и работающего соседа не увидит, поэтому colloq-host
  # останавливает основной контейнер раньше, чем зовёт это.
  cd "$APP"
  exec bash scripts/restore.sh "$@"
}

install_host() {
  local into="${1:-}"
  [ -n "$into" ] && [ -d "$into" ] || die "usage: colloq-vast install-host <host directory mounted into this container>"
  install -m 0755 "$APP/deploy/vast/colloq-host" "$into/colloq-host"
  say "installed $into/colloq-host"
}

usage() {
  cat <<'USAGE'
colloq-vast — Colloq for a rented machine (room kernels on the host's Docker)

  colloq-vast serve            (default) server, tunnel, kernel images
  colloq-vast status           is this instance ready for a class
  colloq-vast link             the class address and, while unclaimed, the owner link
  colloq-vast backup           a backup into <state>/backups/ (database + files)
  colloq-vast restore [FILES]  restore a backup; only while the server is stopped
  colloq-vast install-host DIR put the host-side manager (colloq-host) into DIR
  colloq-vast version

Settings are environment variables; see deploy/vast/README.md.
USAGE
}

# ------------------------------------------------------------------ main
cmd="${1:-serve}"
[ "$#" -eq 0 ] || shift

case "$cmd" in
  version) printf '%s %s\n' "$VERSION" "${COLLOQ_REVISION:-unknown}"; exit 0 ;;
  help|-h|--help) usage; exit 0 ;;
  install-host) install_host "$@"; exit 0 ;;
esac

if [ "$(id -u)" = 0 ] && [ -z "${COLLOQ_VAST_DROPPED:-}" ]; then
  case "$cmd" in
    serve|restore) prepare_as_root full ;;
    *) prepare_as_root ;;
  esac
  drop_to_app "$cmd" "$@"
fi

case "$cmd" in
  serve) serve ;;
  status) status ;;
  link) link ;;
  backup) backup ;;
  restore) restore "$@" ;;
  *) exec "$cmd" "$@" ;;
esac
