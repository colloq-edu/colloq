#!/usr/bin/env bash
#
# Выставить семинар наружу через Cloudflare Tunnel, не открывая ни одного порта.
#
# Всё считается на этой машине: туннель — это исходящее соединение от вашего
# ноутбука к Cloudflare, поэтому не нужны ни белый IP, ни проброс портов на
# роутере, ни VPS. Студенты ходят на адрес Cloudflare, тот доставляет запросы в
# уже открытое соединение.
#
# Главное, ради чего этот скрипт вообще существует: PUBLIC_URL. Сервер кладёт
# его в ссылку, которую вы копируете и раздаёте. Если оставить localhost, ссылка
# будет открываться только у вас, а вся аудитория получит «сайт недоступен» —
# и это выяснится ровно в тот момент, когда тридцать человек уже сидят в классе.
# Поэтому адрес туннеля узнаётся первым, а приложение перезапускается уже с ним.
#
# Транспортов три, и выбираются они сами по имени, которое вы просите:
#
#   ./scripts/host.sh                       быстрый туннель Cloudflare, адрес
#                                           случайный и живёт до Ctrl+C
#   COLLOQ_HOSTNAME=seminar.sleep3r.ru      именованный туннель Cloudflare
#   COLLOQ_HOSTNAME=hse.colloq.ru           свой ретранслятор
#
# Последнее — не прихоть. Туннель Cloudflare всегда выходит на пограничные
# адреса Cloudflare, и снять с них проксирование нельзя: запись
# *.cfargotunnel.com имеет смысл только для их прокси. А из России эти адреса
# не открываются. Семинар, выставленный через Cloudflare, недоступен ровно той
# аудитории, ради которой его и выставляют, — поэтому под colloq.ru стоит своя
# машина, а до неё инстанс дотягивается исходящим соединением frpc, так же как
# дотягивался бы до Cloudflare. Ставится: brew install frpc.
#
set -euo pipefail

cd "$(dirname "$0")/.."

RED=$'\033[31m'; DIM=$'\033[2m'; BOLD=$'\033[1m'; CYAN=$'\033[36m'; OFF=$'\033[0m'
say() { printf '%s\n' "$*"; }
die() { printf '%s%s%s\n' "$RED" "$*" "$OFF" >&2; exit 1; }

command -v docker >/dev/null 2>&1 || die "docker не установлен."

# Настройки ретранслятора живут в .env рядом со всем остальным. Пусто — значит
# этот инстанс им не пользуется, и остаётся Cloudflare.
read_env() { grep -E "^$1=" .env 2>/dev/null | tail -1 | cut -d= -f2- | tr -d ' \r' || true; }
RELAY_DOMAIN="$(read_env RELAY_DOMAIN)"
RELAY_ADDR="$(read_env RELAY_ADDR)"
RELAY_PORT="$(read_env RELAY_PORT)"; RELAY_PORT="${RELAY_PORT:-7000}"
RELAY_TOKEN="$(read_env RELAY_TOKEN)"

# Транспорт выбирается именем, а не отдельным флагом: имя под нашей зоной
# может обслужить только наш ретранслятор, а любое другое — только Cloudflare.
# Флаг здесь был бы третьим способом сказать то, что уже сказано адресом.
VIA="cloudflare"
if [ -n "${COLLOQ_HOSTNAME:-}" ] && [ -n "$RELAY_DOMAIN" ] \
   && [ "${COLLOQ_HOSTNAME%".$RELAY_DOMAIN"}" != "$COLLOQ_HOSTNAME" ]; then
  VIA="relay"
fi

if [ "$VIA" = relay ]; then
  command -v frpc >/dev/null 2>&1 || die \
    "frpc не установлен. brew install frpc — и запустите снова."
  [ -n "$RELAY_ADDR" ]  || die "в .env нет RELAY_ADDR — адреса ретранслятора."
  [ -n "$RELAY_TOKEN" ] || die "в .env нет RELAY_TOKEN — общего секрета ретранслятора."
else
  command -v cloudflared >/dev/null 2>&1 || die \
    "cloudflared не установлен. brew install cloudflared — и запустите снова."
fi

# PORT нужен до старта туннеля: на него cloudflared и будет светить.
PORT="$(grep -E '^PORT=' .env 2>/dev/null | tail -1 | cut -d= -f2- | tr -d ' ' || true)"
PORT="${PORT:-3000}"
LOCAL="http://localhost:${PORT}"

LOG="$(mktemp -t colloq-tunnel)"
TUNNEL_PID=""
# Ставили ли мы PUBLIC_URL сами — см. cleanup.
TOUCHED_ENV=""

cleanup() {
  local code=$?
  [ -n "$TUNNEL_PID" ] && kill "$TUNNEL_PID" 2>/dev/null || true
  # Ссылка мертва вместе с туннелем. Оставить её в .env значит, что следующий
  # `make up` без туннеля раздаст студентам адрес, который никуда не ведёт.
  #
  # Только если её ставили мы: отказ на первом шаге — «докера нет», «инстанс
  # нездоров» — не повод переписывать чужую настройку, к которой мы ещё не
  # прикасались.
  if [ -n "$TOUCHED_ENV" ] && [ -f .env ] && grep -qE '^PUBLIC_URL=https://' .env 2>/dev/null; then
    restore_public_url
    say "${DIM}PUBLIC_URL возвращён на ${LOCAL}${OFF}"
  fi
  rm -f "$LOG"
  exit $code
}
trap cleanup EXIT INT TERM

# sed -i несовместим между macOS и GNU, поэтому пишем через временный файл.
set_public_url() {
  local url="$1" tmp
  tmp="$(mktemp)"
  if grep -qE '^PUBLIC_URL=' .env 2>/dev/null; then
    grep -vE '^PUBLIC_URL=' .env > "$tmp"
  else
    cat .env > "$tmp" 2>/dev/null || true
  fi
  printf 'PUBLIC_URL=%s\n' "$url" >> "$tmp"
  mv "$tmp" .env
}
restore_public_url() { set_public_url "$LOCAL"; }

# ---------------------------------------------------------------- запуск

say "${BOLD}1/4${OFF} проверяю colloq на ${LOCAL}"
#
# Ничего не поднимаем, если оно уже поднято. Это не бережливость, а исправление:
# `docker compose up -d` пересоздаёт и ядро тоже — по основному compose-файлу,
# без dev-override. Override публикует 8888 на хост и монтирует ./workspace, и
# ровно этим живёт сервер, запущенный руками. Одна такая пересборка — и ядро
# перестаёт стартовать, а терминал молчит, хотя контейнер «healthy».
#
#
# /api/health отвечает 200 только когда и база читается, и Jupyter отзывается,
# поэтому «не отвечает» здесь значит и «никого нет», и «есть, но семинар вести
# нельзя» — второе curl -sf тоже считает отказом, и правильно делает.
#
if curl -sf -o /dev/null --max-time 5 "$LOCAL/api/health" 2>/dev/null; then
  say "${DIM}    уже работает — ничего не трогаю${OFF}"
elif [ -f "${PIDFILE:-.colloq.pid}" ] && kill -0 "$(cat "${PIDFILE:-.colloq.pid}" 2>/dev/null)" 2>/dev/null; then
  #
  # Хостовой сервер жив, но здоровым себя не считает — почти всегда потому, что
  # выключен Docker и ядра нет. Поднимать здесь `docker compose up` нельзя: он
  # поднимет и app, и на порту окажется второй Colloq с другой базой поверх
  # первого. Это и был «третий переход»: три разных инстанса за одно утро.
  #
  die "colloq на ${LOCAL} работает, но не готов вести семинар — обычно это выключенный Docker.
  Проверьте: curl -s ${LOCAL}/api/health"
else
  #
  # Ничего не поднимаем сами — и это исправление, купленное дорого.
  #
  # Здесь стоял `docker compose up -d`, и он поднимал ВЕСЬ стек, включая `app`.
  # Достаточно было, чтобы health на секунду ответил отказом — например, потому
  # что выключили ядро, — и рядом с уже работающим сервером на хосте вставал
  # второй Colloq в контейнере. Оба — полноправные Yjs-авторитеты, оба пишут в
  # одну базу (после перехода на bind-монты — буквально в ту же), и браузер
  # попадает то в один, то в другой: тетрадь то полупустая, то с задвоенными
  # ячейками, и сокет не переставая переподключается.
  #
  # Туннель — это про то, чтобы показать наружу уже работающий инстанс. Решать
  # за человека, какой из двух способов запуска ему нужен, он не должен.
  #
  say "${RED}    на ${LOCAL} никто не отвечает${OFF}"
  die "сначала поднимите colloq — «make up» (всё в docker) или «make run» (сервер на хосте), — потом повторите."
fi

# Кто именно держит порт. Три случая, и все три настоящие:
#
#   контейнер   — `make up`, приложение целиком в docker;
#   хост        — `make run`, сервер на машине, ядро в docker. Так проект и
#                 запускают каждый день, и .colloq.pid — его расписка;
#   чужой       — что-то другое. Туннель встанет и на него, но PUBLIC_URL ему
#                 никто не поправит, и об этом придётся сказать вслух.
#
# Различать обязательно: ссылки на семинары строятся из PUBLIC_URL, и семинар,
# розданный со ссылкой на localhost, — это семинар, на который никто не зашёл.
PIDFILE="${PIDFILE:-.colloq.pid}"
WHO="other"
if docker compose ps app --format '{{.State}}' 2>/dev/null | grep -q running; then
  WHO="container"
elif [ -f "$PIDFILE" ] && kill -0 "$(cat "$PIDFILE" 2>/dev/null)" 2>/dev/null; then
  WHO="host"
fi

say "${BOLD}2/4${OFF} открываю туннель"
if [ "$VIA" = relay ]; then
  # Поддомен — это всё, что инстанс просит у ретранслятора: frps выдаёт имена
  # только под своей зоной, поэтому попросить чужое имя нельзя даже с секретом.
  SUB="${COLLOQ_HOSTNAME%".$RELAY_DOMAIN"}"
  CONF="$(mktemp -t colloq-frpc)"
  # Секрет уходит в файл, а не в аргументы: командная строка видна всей машине
  # через ps, и общий ключ ретранслятора там светиться не должен.
  cat > "$CONF" <<CONF
serverAddr = "${RELAY_ADDR}"
serverPort = ${RELAY_PORT}
auth.method = "token"
auth.token = "${RELAY_TOKEN}"
log.to = "console"
log.level = "info"

[[proxies]]
name = "${SUB}"
type = "http"
localIP = "127.0.0.1"
localPort = ${PORT}
subdomain = "${SUB}"
CONF
  chmod 600 "$CONF"
  frpc -c "$CONF" >"$LOG" 2>&1 &
  TUNNEL_PID=$!
  PUBLIC="https://${COLLOQ_HOSTNAME}"
  # Ждём подтверждения от сервера, а не «прошло N секунд»: занятый кем-то
  # поддомен или неверный секрет — это отказ, который приходит сразу, и молча
  # пойти дальше значило бы раздать ссылку в никуда.
  #
  # Строки — те, что frpc печатает на самом деле. Прежний `proxy name .* already`
  # не совпадал ни с чем: frpc 0.71 пишет `start error: proxy [hse] already
  # exists`. Из-за этого занятый поддомен — самый частый отказ, когда семинар
  # уже поднят на другой машине, — распознавался не сразу, а через тридцать
  # секунд ожидания, и назывался «не дождался ответа».
  #
  # Проверено на живом ретрансляторе: второй frpc с тем же именем печатает
  # ровно эту строку через четверть секунды.
  #
  ok=""
  for _ in $(seq 1 30); do
    grep -q 'start proxy success' "$LOG" 2>/dev/null && { ok=1; break; }
    if grep -qE 'already exists' "$LOG" 2>/dev/null; then
      die "поддомен ${COLLOQ_HOSTNAME} уже занят — этот семинар открыт с другой машины.
  Закройте его там или возьмите другое имя: make host HOST=<имя>.colloq.ru"
    fi
    if grep -qiE 'login to server failed|authorization failed|authentication failed|token in login doesn' "$LOG" 2>/dev/null; then
      die "ретранслятор не принял секрет. Проверьте RELAY_TOKEN в .env."
    fi
    if grep -qiE 'start error|login to server failed' "$LOG" 2>/dev/null; then
      grep -iE 'start error|login to server failed' "$LOG" | head -3 >&2
      die "ретранслятор отказал."
    fi
    kill -0 "$TUNNEL_PID" 2>/dev/null || { cat "$LOG" >&2; die "frpc умер, не открыв туннель."; }
    sleep 1
  done
  rm -f "$CONF"
  [ -n "$ok" ] || { cat "$LOG" >&2; die "не дождался ответа ретранслятора за 30 секунд."; }
elif [ -n "${COLLOQ_HOSTNAME:-}" ]; then
  # Именованный туннель: постоянный адрес, но его нужно один раз завести
  # (make tunnel-setup). Без этого cloudflared не знает, куда маршрутизировать.
  cloudflared tunnel --no-autoupdate run --url "$LOCAL" colloq >"$LOG" 2>&1 &
  TUNNEL_PID=$!
  PUBLIC="https://${COLLOQ_HOSTNAME}"
else
  cloudflared tunnel --no-autoupdate --url "$LOCAL" >"$LOG" 2>&1 &
  TUNNEL_PID=$!
  PUBLIC=""
  # Адрес приходит не сразу и не первой строкой — cloudflared сначала пишет
  # баннер. Ждём именно ссылку, а не «прошло N секунд».
  for _ in $(seq 1 60); do
    PUBLIC="$(grep -oE 'https://[a-z0-9-]+\.trycloudflare\.com' "$LOG" | head -1 || true)"
    [ -n "$PUBLIC" ] && break
    kill -0 "$TUNNEL_PID" 2>/dev/null || { cat "$LOG" >&2; die "cloudflared умер, не открыв туннель."; }
    sleep 1
  done
  [ -n "$PUBLIC" ] || { cat "$LOG" >&2; die "не дождался адреса туннеля за минуту."; }
fi

say "${BOLD}3/4${OFF} перезапускаю приложение с внешним адресом"
set_public_url "$PUBLIC"
TOUCHED_ENV=1
case "$WHO" in
  container)
    PUBLIC_URL="$PUBLIC" docker compose up -d app >/dev/null
    ;;
  host)
    # Ровно то же, что делает `make run`, только с новым адресом: .env уже
    # переписан выше, поэтому достаточно поднять процесс заново.
    kill "$(cat "$PIDFILE")" 2>/dev/null || true
    sleep 1
    ( set -a; . ./.env; set +a
      STATIC_DIR="$PWD/web/dist" nohup node server/dist/server.js >> .colloq.log 2>&1 &
      echo $! > "$PIDFILE" )
    sleep 2
    kill -0 "$(cat "$PIDFILE" 2>/dev/null)" 2>/dev/null \
      || { tail -20 .colloq.log >&2; die "сервер не поднялся с новым адресом."; }
    say "${DIM}    сервер на хосте перезапущен с ${PUBLIC}${OFF}"
    ;;
  *)
    # Молча пройти мимо нельзя: аудитория получит localhost, то есть ничего.
    say "${RED}    ${LOCAL} держит не colloq, а какой-то другой процесс.${OFF}"
    say "${DIM}    Его PUBLIC_URL отсюда не поменять — перезапустите его сами с${OFF}"
    say "${DIM}    PUBLIC_URL=${PUBLIC}, иначе ссылки на семинары будут вести на localhost.${OFF}"
    ;;
esac

say "${BOLD}4/4${OFF} проверяю, что снаружи действительно отвечает"
#
# Проверка идёт мимо системного резолвера. Измерено на живой машине: туннель
# отдавал 200 за 0.6 секунды, а `curl https://<адрес>` тут же падал с «could
# not resolve host» — getaddrinfo держал отрицательный ответ, хотя dig то же
# имя видел прекрасно. Своя же проверка объявляла рабочий семинар сломанным.
#
# Поэтому адрес берётся у публичного резолвера и подставляется через --resolve:
# так проверяется туннель, а не настройки DNS на этом ноутбуке.
host_only="${PUBLIC#https://}"

# Спрашиваем несколько резолверов: на корпоративных сетях запросы к 1.1.1.1
# режутся через раз — измерено, три подряд dig дали ответ, пусто, пусто.
resolve_any() {
  local r ip
  for r in 1.1.1.1 8.8.8.8 9.9.9.9; do
    ip="$(dig +short +time=2 +tries=1 "$host_only" "@$r" 2>/dev/null | grep -E '^[0-9.]+$' | head -1 || true)"
    [ -n "$ip" ] && { printf '%s' "$ip"; return 0; }
  done
  return 1
}

probe() {
  local ip
  if ip="$(resolve_any)"; then
    [ "$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 --resolve "$host_only:443:$ip" "$PUBLIC/" || true)" = "200" ] && return 0
  fi
  # Системный резолвер — второй попыткой, а не первой: именно он здесь и врёт.
  [ "$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 "$PUBLIC/" || true)" = "200" ] && return 0
  return 1
}

ok=""
for _ in $(seq 1 30); do
  probe && { ok=1; break; }
  sleep 2
done

#
# Токен. Кука админки привязана к origin, а туннель каждый раз выдаёт новый —
# значит после каждого `make host` преподаватель оказывается разлогинен и
# перепечатывает тридцать два символа. Поэтому ссылка с токеном, как у Jupyter.
#
# Кандидатов два, и они разные: контейнер держит токен в своём томе, а сервер,
# запущенный руками, — в локальном DATA_DIR. Угадывать нельзя. Стоило один раз
# прочитать «тот, который запущен», и в туннель ушла ссылка от одного инстанса,
# а порт держал другой: 401 и экран входа вместо панели.
#
# Поэтому не гадаем, а спрашиваем сам сервер: 401 — не тот токен, 200 — тот и
# инстанс занят, 409 — тот, но инстанс пока ничей. Годятся оба непустых ответа.
token_works() {
  local code
  code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 \
    -X POST "$LOCAL/api/admin/signin/token" \
    -H 'content-type: application/json' -d "{\"token\":\"$1\"}" || true)"
  [ "$code" = "200" ] || [ "$code" = "409" ]
}

read_setup_token() {
  local t dir
  if docker compose ps app --format '{{.State}}' 2>/dev/null | grep -q running; then
    t="$(docker compose exec -T app cat /data/setup-token 2>/dev/null | tr -d '\r\n' || true)"
    [ -n "$t" ] && token_works "$t" && { printf '%s' "$t"; return 0; }
  fi
  dir="${DATA_DIR:-./data}"
  t="$(cat "$dir/setup-token" 2>/dev/null | tr -d '\r\n' || true)"
  [ -n "$t" ] && token_works "$t" && { printf '%s' "$t"; return 0; }
  return 1
}
SETUP_TOKEN="$(read_setup_token || true)"

printf '\n'
if [ -n "$ok" ]; then
  say "${BOLD}Colloq доступен по ссылке${OFF}"
else
  # Чаще всего это не туннель, а сеть, из которой мы проверяем: корпоративный
  # DNS или блокировка исходящих. Студенты из дома при этом заходят нормально,
  # поэтому пугать «не работает» нельзя — надо сказать, что именно неясно.
  say "${RED}С этой машины проверить не удалось.${OFF}"
  say "${DIM}Туннель поднят, но проверка не прошла — обычно виноват DNS этой сети,${OFF}"
  say "${DIM}а не сам семинар. Откройте ссылку с телефона по мобильному интернету.${OFF}"
fi
say "  ${CYAN}${BOLD}${PUBLIC}${OFF}"

if [ -n "$SETUP_TOKEN" ]; then
  printf '\n'
  say "${BOLD}Вход в панель — эта ссылка только для вас${OFF}"
  say "  ${CYAN}${PUBLIC}/admin/t/${SETUP_TOKEN}${OFF}"
  # Строка стоит прямо под ссылкой, а не в конце: спутать её с адресом семинара
  # и отправить в чат группы — ровно одно движение, и оно необратимо.
  say "  ${RED}Это ключ от инстанса.${OFF} ${DIM}Не отправляйте её в чат и не оставляйте${OFF}"
  say "  ${DIM}на экране, пока аудитория смотрит. Студентам — ссылка на семинар,${OFF}"
  say "  ${DIM}которую вы скопируете уже в панели.${OFF}"
else
  # Ссылка, которая не откроет панель, хуже, чем её отсутствие: человек три раза
  # ткнёт в неё, прежде чем усомнится в ссылке, а не в себе.
  printf '\n'
  say "${DIM}Ссылку для входа в панель не печатаю: ни один найденный setup-token${OFF}"
  say "${DIM}не подошёл серверу на ${LOCAL}. Возьмите его из DATA_DIR того сервера,${OFF}"
  say "${DIM}который там отвечает, и откройте ${PUBLIC}/admin/t/<токен>.${OFF}"
fi

printf '\n'
say "${DIM}Всё считается здесь: браузеры студентов ходят в Cloudflare, а он — в${OFF}"
say "${DIM}это окно. Закроете его (Ctrl+C) — ссылка перестанет работать, а colloq${OFF}"
say "${DIM}продолжит крутиться локально на ${LOCAL}.${OFF}"
printf '\n'

# Держим окно живым: туннель существует ровно столько, сколько этот процесс.
wait "$TUNNEL_PID"
