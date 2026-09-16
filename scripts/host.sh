#!/usr/bin/env bash
#
# Выставить семинар наружу и получить ссылку для аудитории.
#
# Главное, ради чего этот скрипт вообще существует: PUBLIC_URL. Сервер кладёт
# его в ссылку, которую вы копируете и раздаёте. Если оставить localhost, ссылка
# будет открываться только у вас, а вся аудитория получит «сайт недоступен» —
# и это выяснится ровно в тот момент, когда тридцать человек уже сидят в классе.
# Временный адрес публикуется без перезапуска приложения.
#
# Транспортов четыре:
#
#   ./scripts/host.sh                       быстрый туннель Cloudflare, адрес
#                                           случайный и живёт до Ctrl+C
#   COLLOQ_HOSTNAME=seminar.sleep3r.ru      именованный туннель Cloudflare
#   COLLOQ_HOSTNAME=hse.colloq.ru           свой ретранслятор (frpc → frps)
#   COLLOQ_DIRECT=1 COLLOQ_HOSTNAME=…       прямо с этой машины, без посредника
#
# Первые три — исходящее соединение отсюда наружу: не нужны ни белый IP, ни
# проброс портов на роутере. Четвёртый — противоположность: 80 и 443 на этой
# машине принимают студентов сами, caddy снимает TLS и отдаёт запрос colloq на
# localhost. Ему нужен настоящий публичный адрес, и он единственный, у кого на
# пути пары нет ни одного чужого узла.
#
# Почему появился четвёртый. Туннель Cloudflare всегда выходит на пограничные
# адреса Cloudflare, снять с них проксирование нельзя (запись
# *.cfargotunnel.com имеет смысл только для их прокси), а из России эти адреса
# не открываются — поэтому под colloq.ru стоит свой ретранслятор. Но и он не
# бесплатен: измерено на живой паре, двести студентов в один вечер положили
# VPS на 951 МБ памяти — ядро тридцать шесть раз убивало то frps (209 МБ), то
# caddy (186 МБ на двух сотнях сокетов), и каждое убийство рвало все туннели
# разом, а зал уходил в переподключение. Ретранслятор — общая точка отказа для
# всех имён под ним, и трафик пары не должен через него ходить, когда у машины
# есть свой публичный адрес.
#
# Что ставится: frpc (brew install frpc) для ретранслятора, cloudflared для
# Cloudflare, caddy для прямого режима — последний скрипт поставит сам.
#
set -euo pipefail

cd "$(dirname "$0")/.."

RED=$'\033[31m'; DIM=$'\033[2m'; BOLD=$'\033[1m'; CYAN=$'\033[36m'; OFF=$'\033[0m'
say() { printf '%s\n' "$*"; }
die() { printf '%s%s%s\n' "$RED" "$*" "$OFF" >&2; exit 1; }

command -v docker >/dev/null 2>&1 || die "docker is not installed."

# Настройки ретранслятора живут в .env рядом со всем остальным. Пусто — значит
# этот инстанс им не пользуется, и остаётся Cloudflare.
#
# read_env общий для всех скриптов — scripts/lib.sh. Своя копия была в трёх
# файлах и во всех трёх вырезала пробелы внутри значений.
. ./scripts/lib.sh

# Состояние — не там, где приложение. Каталог над scripts/ — это приложение
# (web/dist, kernel/, эти скрипты), а .env, расписка занятия и .colloq.pid
# лежат в каталоге СОСТОЯНИЯ: он и есть COLLOQ_STATE_ROOT из lib.sh. В
# репозитории это один и тот же каталог, у поставленного пакета — разные, и
# все пути ниже считаются от состояния, а не от «себя».
SESSION_RECEIPT="$COLLOQ_STATE_ROOT/.colloq/local-session.json"
PIDFILE="${PIDFILE:-$COLLOQ_STATE_ROOT/.colloq.pid}"

# Чем звать расписку внешнего адреса (scripts/public-url-lease.mts).
#
# В репозитории — исходником через tsx: его правят рядом с сервером, и сборка
# между правкой и проверкой ни к чему. В дистрибутиве нет ни исходника, ни
# tsx: `node --import tsx` падает там ещё до первой строки («Cannot find
# package 'tsx'»), а вместе с ним падал и весь скрипт — локальная сессия
# оставалась без адреса на ровном месте. Поэтому scripts/pack.mts кладёт рядом
# с cli/launch.mjs собранный cli/public-url-lease.mjs, и если он на месте,
# зовём голый node. Та же развилка и по той же причине стоит в CLI —
# cli/src/commands/local.ts · launcher.
#
# Массивом, а не функцией: сторож адреса запускается в фон, и в $! должен
# оказаться номер самого node. У функции там был бы номер подоболочки, а
# cleanup убивал бы её, оставляя сторожа сиротой — он ещё три секунды продлевал
# бы аренду адреса, который мы только что отдали.
if [ -f cli/public-url-lease.mjs ]; then
  LEASE=(node cli/public-url-lease.mjs)
else
  LEASE=(node --import tsx scripts/public-url-lease.mts)
fi

RELAY_DOMAIN="$(read_env RELAY_DOMAIN)"
RELAY_ADDR="$(read_env RELAY_ADDR)"
RELAY_PORT="$(read_env RELAY_PORT)"; RELAY_PORT="${RELAY_PORT:-7000}"
RELAY_TOKEN="$(read_env RELAY_TOKEN)"

# Между туннелями транспорт выбирается именем, а не отдельным флагом: имя под
# нашей зоной может обслужить только наш ретранслятор, а любое другое — только
# Cloudflare. Флаг здесь был бы третьим способом сказать то, что уже сказано
# адресом.
#
# А вот прямой режим именем не выражается вовсе, и это не оплошность: hse.colloq.ru
# может обслужить и ретранслятор, и эта машина — разница не в имени, а в том,
# есть ли у машины белый адрес. Спросить об этом можно только явно, поэтому у
# прямого режима есть свой выключатель: COLLOQ_DIRECT=1 (make host-direct HOST=…).
VIA="cloudflare"
if [ "${COLLOQ_DIRECT:-}" = "1" ] && [ "${COLLOQ_LOCAL_SESSION:-}" != 1 ]; then
  VIA="direct"
elif [ -n "${COLLOQ_HOSTNAME:-}" ] && [ -n "$RELAY_DOMAIN" ] \
   && [ "${COLLOQ_HOSTNAME%".$RELAY_DOMAIN"}" != "$COLLOQ_HOSTNAME" ]; then
  VIA="relay"
fi

case "$VIA" in
  relay)
    command -v frpc >/dev/null 2>&1 || die \
      "frpc is not installed. brew install frpc — then run this again."
    [ -n "$RELAY_ADDR" ]  || die "no RELAY_ADDR in .env — the address of the relay."
    [ -n "$RELAY_TOKEN" ] || die "no RELAY_TOKEN in .env — the shared secret of the relay."
    ;;
  direct)
    # Всё, что нужно проверить до первого действия. Отказ здесь дешёвый:
    # ни записи в DNS, ни поставленного caddy ещё нет.
    #
    # Имя обязательно и обязательно полное. Прямому режиму неоткуда взять
    # умолчание: у ретранслятора короткое имя достраивается до RELAY_DOMAIN,
    # у быстрого туннеля имя выдаёт Cloudflare, а здесь имя — это то, на что
    # выпишут сертификат, и придумать его за человека нельзя.
    [ -n "${COLLOQ_HOSTNAME:-}" ] || die \
      "direct mode needs a name: make host-direct HOST=hse.colloq.ru"
    case "$COLLOQ_HOSTNAME" in
      *.*) : ;;
      *) die "the name must be a full one, with a dot: make host-direct HOST=hse.colloq.ru
  Only the relay completes a short name up to RELAY_DOMAIN." ;;
    esac
    printf '%s' "$COLLOQ_HOSTNAME" | grep -qE '^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$' || die \
      "the name ${COLLOQ_HOSTNAME} has something other than a-z, digits, dots and hyphens."

    # systemd — не придирка. Прямой режим оставляет после себя службу caddy,
    # которая живёт дольше этого окна; без systemd оставить её было бы негде,
    # и семинар умирал бы вместе с закрытым терминалом, ничего об этом не сказав.
    # На ноутбуке (macOS) это и не нужно: у него нет белого адреса, ему туннель.
    command -v systemctl >/dev/null 2>&1 || die \
      "direct mode is for a machine with systemd and a public address (a Linux server).
  There is no systemd here: from a laptop a class goes out through a tunnel —
  make host HOST=<name>."

    # 80 и 443 — привилегированные порты, и службу в systemd тоже ставят от root.
    [ "$(id -u)" = "0" ] || die \
      "direct mode installs the caddy service and takes 80 and 443 — root is needed.
  Try again: sudo make host-direct HOST=${COLLOQ_HOSTNAME}"

    # python3 нужен и здесь (проверка портов), и в scripts/dns.sh, который
    # пишет запись.
    command -v python3 >/dev/null 2>&1 || die \
      "no python3 — it is what checks the ports and writes the DNS record (scripts/dns.sh)."
    command -v curl >/dev/null 2>&1 || die "no curl."
    [ -x ./scripts/dns.sh ] || die "no scripts/dns.sh — it is what sets the A record for the name."
    ;;
  *)
    command -v cloudflared >/dev/null 2>&1 || die \
      "cloudflared is not installed. brew install cloudflared — then run this again."
    ;;
esac

# PORT нужен до старта туннеля: на него cloudflared и будет светить.
PORT="${PORT:-$(read_env PORT)}"
PORT="${PORT:-3000}"
CLUSTER="${COLLOQ_CLUSTER:-$(read_env COLLOQ_CLUSTER)}"
if [ "${COLLOQ_LOCAL_SESSION:-}" = 1 ]; then CLUSTER=0; fi
if [ "$CLUSTER" = 1 ]; then PORT=30080; fi
LOCAL="http://127.0.0.1:${PORT}"
TUNNEL_PORT="$PORT"
LOCAL_RUN_ID=""
LEASE_FILE=""
LEASE_OWNER=""
LEASE_PID=""
if [ "$CLUSTER" != 1 ] && [ "$VIA" != direct ] && { [ "${COLLOQ_LOCAL_SESSION:-}" = 1 ] || [ -f "$SESSION_RECEIPT" ]; }; then
  if DISCOVERY="$("${LEASE[@]}" discover "$SESSION_RECEIPT")"; then
    IFS=$'\t' read -r LOCAL_RUN_ID LEASE_FILE LOCAL PORT DATA_DIR TUNNEL_PORT <<< "$DISCOVERY"
  else
    discovery_code=$?
    [ "$discovery_code" = 2 ] || die "Could not check the local session."
  fi
fi
HEALTH_LOCAL="http://127.0.0.1:${PORT}"
# Only the local origin sees this rewrite; the public Host still routes at the relay.
# Vite retains its Host protection instead of accepting every external hostname.
ORIGIN_ARGS=()
if [ -n "$LOCAL_RUN_ID" ]; then ORIGIN_ARGS=(--http-host-header "127.0.0.1:${TUNNEL_PORT}"); fi

# Шаблон с иксами, а не просто имя: BSD mktemp дописывает случайный хвост
# сам, а GNU требует «XXXXXX» в шаблоне и без них падает с «too few X's».
# Скрипт живёт на обеих системах — на ноутбуке преподавателя и на арендованной
# машине, — и там, где он падал, семинар оставался без адреса.
LOG="$(mktemp -t colloq-tunnel.XXXXXX)"
TUNNEL_PID=""
# Временный слушатель 80 и 443 в прямом режиме — см. проверку портов.
LISTEN_PID=""
LISTEN_LOG=""
# Ставили ли мы PUBLIC_URL сами — см. cleanup.
TOUCHED_ENV=""

# Шагов у транспортов разное число, а нумерация нужна везде: человек по ней
# понимает, где скрипт застрял. Поэтому счётчик, а не вписанные руками «1/4»,
# которые в прямом режиме врали бы на два шага.
STEPS=4
if [ "$VIA" = direct ]; then STEPS=6; fi
STEP=0
step() { STEP=$((STEP + 1)); say "${BOLD}${STEP}/${STEPS}${OFF} $*"; }

cleanup() {
  local code=$?
  trap - EXIT INT TERM
  [ -n "$LEASE_PID" ] && kill "$LEASE_PID" 2>/dev/null || true
  if [ -n "$LEASE_OWNER" ]; then
    "${LEASE[@]}" release "$LEASE_FILE" "$LOCAL_RUN_ID" "$LEASE_OWNER" || true
  fi
  [ -n "$TUNNEL_PID" ] && kill "$TUNNEL_PID" 2>/dev/null || true
  # Слушатель занимает ровно те порты, которые нужны caddy. Не убрать его —
  # значит уронить выдачу сертификата, причём молча.
  [ -n "$LISTEN_PID" ] && kill "$LISTEN_PID" 2>/dev/null || true
  [ -n "$LISTEN_LOG" ] && rm -f "$LISTEN_LOG" || true
  # Прямой режим не возвращает PUBLIC_URL назад, и это не забывчивость.
  # Ссылка там живёт не в этом окне, а в службе caddy: она переживает и Ctrl+C,
  # и закрытый ssh. Вернуть адрес на localhost значило бы, что после выхода из
  # скрипта работающий семинар начинает раздавать ссылки на localhost.
  if [ "$VIA" = direct ]; then rm -f "$LOG"; exit $code; fi
  # Ссылка мертва вместе с туннелем. Оставить её в .env значит, что следующий
  # `make up` без туннеля раздаст студентам адрес, который никуда не ведёт.
  #
  # Только если её ставили мы: отказ на первом шаге — «докера нет», «инстанс
  # нездоров» — не повод переписывать чужую настройку, к которой мы ещё не
  # прикасались.
  if [ "${WHO:-}" != cluster ] && [ -n "$TOUCHED_ENV" ] && [ -f "$ENV_FILE" ] && grep -qE '^PUBLIC_URL=https://' "$ENV_FILE" 2>/dev/null; then
    restore_public_url
    # Вернуть строку в .env мало тому, кто читает её один раз, при запуске.
    #
    # Контейнеру: файла внутри нет вовсе, PUBLIC_URL запечён в окружение на
    # `docker compose up -d app` предпоследним шагом. Без пересоздания в панели
    # так и раздаются ссылки на туннель, которого больше нет, — и видно это
    # только тому, кому её отправили.
    #
    # Службе — ничего: сервер на хосте перечитывает .env сам, не реже раза в
    # две секунды (readPublicUrl в server/src/config.ts), и файл для него
    # главнее окружения из EnvironmentFile. Перезапуск здесь только рвал бы
    # сокеты всей комнаты — в том числе на Ctrl+C, которым туннель закрывают
    # штатно.
    #
    # Сервер, запущенный через `make run`, тоже не трогаем: его подняли руками,
    # и снимать его молча, за спиной, нельзя. Он перечитает адрес оттуда же.
    case "${WHO:-}" in
      container) PUBLIC_URL="$LOCAL" docker compose up -d app >/dev/null 2>&1 || true ;;
    esac
    say "${DIM}PUBLIC_URL is back at ${LOCAL}${OFF}"
  fi
  rm -f "$LOG"
  exit $code
}
trap cleanup EXIT INT TERM

# sed -i несовместим между macOS и GNU, поэтому пишем через временный файл.
set_public_url() {
  local url="$1" tmp
  tmp="$(mktemp)"
  if grep -qE '^PUBLIC_URL=' "$ENV_FILE" 2>/dev/null; then
    grep -vE '^PUBLIC_URL=' "$ENV_FILE" > "$tmp"
  else
    cat "$ENV_FILE" > "$tmp" 2>/dev/null || true
  fi
  printf 'PUBLIC_URL=%s\n' "$url" >> "$tmp"
  # Содержимое переливается в существующий .env, а не `mv` поверх него.
  # Разница видна там, где скрипт запускают под sudo (прямой режим и любая
  # выделенная машина): mv из /tmp сделал бы .env файлом root с правами 600,
  # и следующий `make run` от преподавателя не смог бы его ни переписать, ни
  # прочитать. Файл при этом всё равно готовится целиком заранее — на месте
  # он не редактируется ни секунды.
  cat "$tmp" > "$ENV_FILE"
  rm -f "$tmp"
}
restore_public_url() { set_public_url "$LOCAL"; }

# Спрашиваем несколько резолверов: на корпоративных сетях запросы к 1.1.1.1
# режутся через раз — измерено, три подряд dig дали ответ, пусто, пусто.
#
# Имя приходит аргументом, а не из глобальной переменной: спрашивают отсюда
# двое — проверка «отвечает ли адрес снаружи» в конце и прямой режим, которому
# надо дождаться, пока новая A-запись доедет до публичных резолверов.
resolve_any() {
  local name="$1" r ip
  for r in 1.1.1.1 8.8.8.8 9.9.9.9; do
    ip="$(dig +short +time=2 +tries=1 "$name" "@$r" 2>/dev/null | grep -E '^[0-9.]+$' | head -1 || true)"
    [ -n "$ip" ] && { printf '%s' "$ip"; return 0; }
  done
  return 1
}

# ------------------------------------------------------------- статика наружу
#
# Три каталога, и все три — одно и то же у всех, кто пришёл на пару.
# assets/ Vite штампует хэшем содержимого (их и отдают с immutable на год),
# fonts/ и pdf/ меняются только с выкладкой. Именно они и зеркалятся на
# ретрансляторе, и именно они сжимаются заранее.
DIST_DIRS="assets fonts pdf"

# Сколько собранных файлов лежат БЕЗ сжатого соседа.
#
# Порог в килобайт — тот же, что у web/scripts/precompress.mjs: на меньшем
# обёртка формата съедает всё, что сжатие выигрывает, и .br там не бывает по
# замыслу, а не по забывчивости.
assets_uncompressed() {
  local n=0 f
  [ -d web/dist/assets ] || { printf 0; return 0; }
  for f in web/dist/assets/*.js web/dist/assets/*.mjs web/dist/assets/*.css; do
    [ -f "$f" ] || continue
    [ "$(wc -c < "$f")" -lt 1024 ] && continue
    [ -f "$f.br" ] || n=$((n + 1))
  done
  printf '%s' "$n"
}

# Архив для зеркала: ровно те каталоги, что есть, и ничего скрытого.
#
# COPYFILE_DISABLE — про macOS: без него tar кладёт рядом с каждым файлом
# ещё и `._имя` с расширенными атрибутами, и зеркало получает вдвое больше
# файлов, половина из которых ничего не значит.
assets_tar() {
  local out="$1" dir dirs=""
  for dir in $DIST_DIRS; do
    [ -d "web/dist/$dir" ] && dirs="$dirs $dir"
  done
  [ -n "$dirs" ] || return 1
  # shellcheck disable=SC2086
  COPYFILE_DISABLE=1 tar -czf "$out" --exclude '.*' --exclude '*/.*' -C web/dist $dirs
}

# Положить статику на ретранслятор, чтобы он раздавал её сам.
#
# Без этого КАЖДЫЙ байт каждого /assets/*, /fonts/* и /pdf/* едет через этот
# ноутбук: 598 КБ сжатого на каждого пришедшего, по тому же туннелю, по
# которому в этот момент живут сокеты комнаты. Файлы одинаковые у всех, и
# ретранслятор вполне может отдать их сам (scripts/relay-assets.py).
#
# Отказ здесь — предупреждение, а не смерть: туннель работает и без зеркала,
# просто медленнее. Ретранслятор, поставленный до появления зеркала, отвечает
# на этот адрес чем угодно — про него и сказано отдельно.
upload_assets() {
  local archive answer code files bytes
  archive="$(mktemp -t colloq-assets.XXXXXX)"
  answer="$(mktemp -t colloq-assets-out.XXXXXX)"
  if ! assets_tar "$archive"; then
    rm -f "$archive" "$answer"
    return 0
  fi
  code="$(curl -s -o "$answer" -w '%{http_code}' --max-time 180 \
    --upload-file "$archive" \
    -H "Authorization: Bearer ${RELAY_TOKEN}" \
    -H 'Content-Type: application/gzip' \
    "https://${COLLOQ_HOSTNAME}/.relay/assets/${COLLOQ_HOSTNAME}" || true)"
  if [ "$code" = "200" ]; then
    files="$(sed -n 's/.*"files":[ ]*\([0-9]*\).*/\1/p' "$answer")"
    bytes="$(sed -n 's/.*"bytes":[ ]*\([0-9]*\).*/\1/p' "$answer")"
    say "${DIM}    mirror on the relay: ${files:-?} files, $(( ${bytes:-0} / 1024 )) KB —${OFF}"
    say "${DIM}    students take the static files from it, not through this laptop${OFF}"
  elif [ "$code" = "404" ] || [ "$code" = "000" ]; then
    say "${DIM}    the relay has no static mirror: it was installed before the mirror${OFF}"
    say "${DIM}    appeared. Update it: make relay-setup WHERE=root@<address>${OFF}"
    say "${DIM}    The class runs anyway — every static file goes through this laptop.${OFF}"
  else
    say "${RED}    could not upload the static files to the relay (HTTP ${code})${OFF}"
    head -c 200 "$answer" >&2 2>/dev/null || true
    printf '\n' >&2
    say "${DIM}    Not fatal: the files go through the tunnel, as before.${OFF}"
  fi
  rm -f "$archive" "$answer"
}

# ---------------------------------------------------------------- запуск

step "checking colloq at ${LOCAL}"
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
if curl -sf -o /dev/null --max-time 5 "$HEALTH_LOCAL/api/health" 2>/dev/null; then
  say "${DIM}    already running — touching nothing${OFF}"
elif [ "$CLUSTER" = 1 ]; then
  die "k3s application is not ready at $LOCAL. Inspect: bash scripts/cluster.sh status; bash scripts/cluster.sh logs"
elif { command -v systemctl >/dev/null 2>&1 && systemctl is-active --quiet colloq 2>/dev/null; } \
     || { [ -f "$PIDFILE" ] && kill -0 "$(cat "$PIDFILE" 2>/dev/null)" 2>/dev/null; }; then
  #
  # Сервер на хосте жив — службой или руками, — но здоровым себя не считает.
  # Почти всегда это выключенный Docker или ни разу не собранное окружение
  # ядра. Поднимать здесь `docker compose up` нельзя: он поднимет и app, и на
  # порту окажется второй Colloq с другой базой поверх первого. Это и был
  # «третий переход»: три разных инстанса за одно утро.
  #
  die "colloq at ${LOCAL} is running, but is not ready to hold a class — usually that
  is Docker switched off or a kernel environment that was never built
  (make env-build NAME=<environment>).
  Check: curl -s ${LOCAL}/api/health"
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
  say "${RED}    nobody answers at ${LOCAL}${OFF}"
  # Совет обязан быть выполнимым на той машине, где его прочитали.
  #
  # Здесь стояло «make up / make run / make service-install» — три цели Makefile,
  # которого у поставленного через pip colloq нет вовсе. А срабатывает эта
  # строка именно на `colloq host`: на команде, которой класс получает ссылку.
  # Человек читал совет, набирал make и получал «command not found» вторым
  # отказом подряд. Цели остаются — но только там, где есть Makefile, и это
  # видно по тому же признаку, по которому скрипт уже выбирает каталоги.
  if [ "${COLLOQ_STATE_ROOT}" = "." ] || [ -f "$PWD/Makefile" ]; then
    die "start the class first — colloq start (or make up for everything in
  docker, make service-install on a dedicated machine), then try again."
  fi
  die "start the class first — colloq start — then try again."
fi

# Кто именно держит порт. Случаев четыре, и все четыре настоящие:
#
#   служба      — systemd на выделенной машине: сервер на хосте, в docker
#                 только ядра комнат. Так стоит арендованная машина и любая,
#                 где идут занятия;
#   контейнер   — `make up`, приложение целиком в docker;
#   хост        — `make run`, сервер на машине, ядро в docker. Так проект
#                 запускают, когда правят код, и .colloq.pid — его расписка;
#   чужой       — что-то другое. Туннель встанет и на него, но PUBLIC_URL ему
#                 никто не поправит, и об этом придётся сказать вслух.
#
# Порядок разбора — не алфавитный, а по надёжности признака. Служба спрашивается
# первой: на машине под службой рядом валяется и .colloq.pid от давнего `make
# run`, и остановленный контейнер app, — а перезапускать надо ту форму, которая
# сейчас держит порт. Расписка `make run` идёт последней ровно поэтому: pid-файл
# переживает и перезагрузку, и смену формы, и говорит о прошлом, а не о
# настоящем.
#
# Различать обязательно: ссылки на семинары строятся из PUBLIC_URL, и семинар,
# розданный со ссылкой на localhost, — это семинар, на который никто не зашёл.
WHO="other"
if [ -n "$LOCAL_RUN_ID" ]; then
  WHO="local"
elif [ "$CLUSTER" = 1 ]; then
  WHO="cluster"
elif command -v systemctl >/dev/null 2>&1 && systemctl is-active --quiet colloq 2>/dev/null; then
  WHO="service"
elif docker compose ps app --format '{{.State}}' 2>/dev/null | grep -q running; then
  WHO="container"
elif [ -f "$PIDFILE" ] && kill -0 "$(cat "$PIDFILE" 2>/dev/null)" 2>/dev/null; then
  WHO="host"
fi

# ------------------------------------------------- прямой режим: без посредника
#
# Всё, что ниже, работает только при COLLOQ_DIRECT=1. Смысл режима в одной
# фразе: на пути от студента до этой машины нет никого. Ни ретранслятора,
# который на 951 МБ памяти ложился от двухсот сокетов, ни Cloudflare, чьи
# адреса из России не открываются. Цена — машине нужен настоящий публичный
# адрес и настоящие 80 и 443 на нём.

DIRECT_IP=""

# Адрес этой машины, каким его видит внешний мир.
#
# Спрашиваем несколько служб подряд: любая из них может быть недоступна именно
# из этой сети, а ошибиться адресом нельзя — запись в DNS уведёт всю аудиторию
# не туда. Cloudflare среди них нет намеренно: из России их адреса не
# открываются, и «не смог узнать свой адрес» было бы неправдой о машине.
public_ip() {
  local url addr
  for url in https://api.ipify.org https://checkip.amazonaws.com https://ident.me https://ipinfo.io/ip; do
    addr="$(curl -s --max-time 6 "$url" 2>/dev/null | tr -d ' \r\n' || true)"
    if printf '%s' "$addr" | grep -qE '^([0-9]{1,3}\.){3}[0-9]{1,3}$'; then
      printf '%s' "$addr"
      return 0
    fi
  done
  return 1
}

# Висит ли этот адрес прямо на интерфейсе машины.
#
# Ответ «нет» сам по себе ничего не решает и отказом не является: у облачных
# машин (AWS, GCP) публичный адрес живёт на пограничном маршрутизаторе, на
# интерфейсе только частный, и прямой режим там работает прекрасно. Но это же
# «нет» бывает и у машины за пробросом портов, где 80 и 443 не открыты вовсе.
# Поэтому признак используется только как подсказка к вердикту проверки
# снаружи — она и есть настоящий ответ.
ip_is_local() {
  local want="$1"
  if command -v ip >/dev/null 2>&1; then
    ip -4 -o addr show 2>/dev/null | awk '{print $4}' | cut -d/ -f1 | grep -qx "$want"
  elif command -v ifconfig >/dev/null 2>&1; then
    ifconfig 2>/dev/null | awk '/inet /{print $2}' | grep -qx "$want"
  else
    return 1
  fi
}

# Временно занять 80 и 443, чтобы снаружи было к чему подключаться.
#
# Проверять «открыт ли порт», не слушая его, невозможно: закрытый фаерволом и
# никем не занятый порт выглядят снаружи одинаково. Поэтому на время проверки
# порты держит крошечный слушатель на python3 — он же доказывает, что порты
# вообще свободны и что их разрешено занимать.
listener_start() {
  LISTEN_LOG="$(mktemp -t colloq-ports.XXXXXX)"
  python3 - 80 443 >"$LISTEN_LOG" 2>&1 <<'PY' &
import socket, sys, threading

socks = []
for port in (int(a) for a in sys.argv[1:]):
    s = socket.socket()
    s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    s.bind(("", port))
    s.listen(16)
    socks.append(s)

# Слово печатается только после того, как оба порта заняты: ждущая сторона
# по нему и понимает, что спрашивать снаружи уже есть смысл.
print("READY", flush=True)


def serve(sock):
    while True:
        try:
            conn, _ = sock.accept()
        except OSError:
            return
        # Проверяющий узел снаружи смотрит только на то, состоялось ли
        # соединение, но ответить всё же вежливее: так в чужих журналах не
        # остаётся оборванных запросов.
        try:
            conn.sendall(b"HTTP/1.1 204 No Content\r\nConnection: close\r\n\r\n")
        except OSError:
            pass
        conn.close()


for sock in socks:
    threading.Thread(target=serve, args=(sock,), daemon=True).start()
threading.Event().wait()
PY
  LISTEN_PID=$!
  local i
  for i in $(seq 1 25); do
    grep -q READY "$LISTEN_LOG" 2>/dev/null && return 0
    kill -0 "$LISTEN_PID" 2>/dev/null || return 1
    sleep 0.2
  done
  return 1
}

listener_stop() {
  [ -n "$LISTEN_PID" ] && kill "$LISTEN_PID" 2>/dev/null || true
  LISTEN_PID=""
}

# Спросить снаружи: пускает ли эта машина на такой-то порт. Печатает
# open, closed или unknown.
#
# Спрашиваем check-host.net: он бесплатен, без ключей, отвечает из нескольких
# стран и — в отличие от большинства подобных служб — открывается из России.
# Форма ответа выверена на живых запросах, а не по памяти: пока проверка идёт,
# значение узла равно null; удавшееся соединение приходит как
# [{"address": …, "time": …}], отказ — как [{"error": "Connection timed out"}].
ask_outside() {
  local addr="$1" port="$2" id res verdict i
  id="$(curl -s --max-time 10 -H 'Accept: application/json' \
        "https://check-host.net/check-tcp?host=${addr}:${port}&max_nodes=3" 2>/dev/null \
        | python3 -c 'import json,sys
try: print(json.load(sys.stdin).get("request_id") or "")
except Exception: print("")' 2>/dev/null || true)"
  [ -n "$id" ] || { printf 'unknown'; return 0; }
  for i in $(seq 1 12); do
    sleep 2
    res="$(curl -s --max-time 10 -H 'Accept: application/json' \
           "https://check-host.net/check-result/${id}" 2>/dev/null || true)"
    verdict="$(printf '%s' "$res" | python3 -c '
import json, sys
try:
    rows = json.load(sys.stdin)
except Exception:
    rows = None
if not isinstance(rows, dict) or not rows:
    print("wait")
else:
    vals = list(rows.values())
    done = [v for v in vals if isinstance(v, list)]
    # Достаточно одного узла, которому ответили: соединение снаружи состоялось,
    # значит порт открыт. А вот «закрыт» — только когда высказались все.
    if any(v and isinstance(v[0], dict) and v[0].get("address") for v in done):
        print("open")
    elif len(done) == len(vals):
        print("closed")
    else:
        print("wait")' 2>/dev/null || printf 'wait')"
    [ "$verdict" = wait ] || { printf '%s' "$verdict"; return 0; }
  done
  printf 'unknown'
}

# Спросить снаружи, что отвечает по адресу на 80. Печатает code:<код>,
# closed или unknown.
#
# Отдельно от ask_outside, потому что вопрос другой и он важнее. «Порт открыт»
# — это ещё не «порт открыт у нас»: измерено прямо на этой машине, где
# публичным адресом оказался выход VPN, и на его 80 и 443 честно отвечал чужой
# веб-сервер. TCP-проверка сказала бы «открыт», имя семинара уехало бы на
# чужую машину, а сертификат не выпустился бы никогда — и понять, почему,
# было бы не по чему. Поэтому пока порты держит наш слушатель, отдающий 204,
# мы спрашиваем именно код ответа: 204 значит «это мы».
#
# Форма ответа check-host для http-проверки, выверена на живом запросе:
# [[1, 0.13, "OK", "200", "8.47.69.0"]] — успех и код в четвёртом поле.
ask_outside_http() {
  local url="$1" id res verdict i
  id="$(curl -s --max-time 10 -H 'Accept: application/json' \
        "https://check-host.net/check-http?host=${url}&max_nodes=3" 2>/dev/null \
        | python3 -c 'import json,sys
try: print(json.load(sys.stdin).get("request_id") or "")
except Exception: print("")' 2>/dev/null || true)"
  [ -n "$id" ] || { printf 'unknown'; return 0; }
  for i in $(seq 1 12); do
    sleep 2
    res="$(curl -s --max-time 10 -H 'Accept: application/json' \
           "https://check-host.net/check-result/${id}" 2>/dev/null || true)"
    verdict="$(printf '%s' "$res" | python3 -c '
import json, sys
try:
    rows = json.load(sys.stdin)
except Exception:
    rows = None
if not isinstance(rows, dict) or not rows:
    print("wait")
else:
    vals = list(rows.values())
    done = [v for v in vals if isinstance(v, list)]
    codes = set()
    for v in done:
        row = v[0] if v and isinstance(v[0], list) else None
        if row and row[0] and len(row) > 3 and row[3]:
            codes.add(str(row[3]))
    if codes:
        print("code:" + sorted(codes)[0])
    elif len(done) == len(vals):
        print("closed")
    else:
        print("wait")' 2>/dev/null || printf 'wait')"
    [ "$verdict" = wait ] || { printf '%s' "$verdict"; return 0; }
  done
  printf 'unknown'
}

# ---------------------------------------------------------- шаг: порты

direct_check_ports() {
  step "checking that 80 and 443 on this machine are visible from outside"
  #
  # Это самая важная проверка прямого режима, и поэтому она первая — до записи
  # в DNS и до установки caddy.
  #
  # Сертификат выдаётся по HTTP-01: Let's Encrypt приходит на 80 по имени и
  # ждёт ответа именно этой машины. Нет 80 — нет сертификата; нет 443 — нет
  # семинара. Узнать это на выдаче сертификата значит узнать поздно и невнятно:
  # caddy не падает, он молча повторяет попытки, а у зала в браузере всё это
  # время «не удалось установить соединение».
  #
  # Случай не выдуманный. На арендованной машине vast.ai наружу открыт только
  # проброшенный ssh: у предложения есть direct_port_count, но настоящих 80 и
  # 443 vast не даёт вовсе — проверено. Прямой режим там невозможен, и сказать
  # об этом надо словами, а не падением на сертификате через десять минут.
  #
  # Colloq на 80 или 443 — это тот же порт, что просит caddy, и вдвоём они на
  # нём не поместятся. Сказать это здесь дешевле, чем сломать уже работающий
  # инстанс перезапуском caddy, который всё равно не встанет.
  case "$PORT" in
    80|443) die "colloq listens on ${PORT} — and direct mode needs exactly that port for caddy.
  Move the instance to another port (PORT in .env, then make run/service-restart)
  and try again." ;;
  esac

  DIRECT_IP="${COLLOQ_PUBLIC_IP:-$(public_ip || true)}"
  [ -n "$DIRECT_IP" ] || die \
    "could not find out this machine's public address: none of the services answered.
  Name it yourself: COLLOQ_PUBLIC_IP=<address> make host-direct HOST=${COLLOQ_HOSTNAME}"
  say "${DIM}    from outside this machine looks like ${DIRECT_IP}${OFF}"

  local on_iface=""
  if ip_is_local "$DIRECT_IP"; then
    on_iface=1
  else
    say "${DIM}    (it is not on an interface — this is NAT: on a cloud machine that${OFF}"
    say "${DIM}    is how it should be, behind port forwarding it is trouble)${OFF}"
  fi

  # caddy, уже занявший порты с прошлого запуска, — это не «занято», а «мы же
  # их и заняли». Своего слушателя тогда не поднимаем: порты и так открыты, и
  # спросить снаружи можно прямо так.
  local held_by_caddy=""
  if systemctl is-active --quiet caddy 2>/dev/null; then
    held_by_caddy=1
    say "${DIM}    caddy is already running — checking straight through it${OFF}"
  elif ! listener_start; then
    tail -3 "$LISTEN_LOG" 2>/dev/null | sed 's/^/    /' >&2 || true
    if grep -q 'Address already in use' "$LISTEN_LOG" 2>/dev/null; then
      # Кто именно держит порт — это ответ, а «занято» — только половина.
      command -v ss >/dev/null 2>&1 && \
        ss -lntp 2>/dev/null | awk 'NR==1 || /:(80|443) /' >&2 || true
      die "80 or 443 on this machine are already taken — and direct mode needs exactly them.
  Stop the other web server (nginx, apache) or publish the class through a tunnel:
  make host HOST=${COLLOQ_HOSTNAME}"
    fi
    die "could not take 80 and 443 on this machine — see the error above."
  fi

  local verdict closed="" unknown="" foreign=""

  # 80 спрашиваем строже остальных: по нему придёт Let's Encrypt, и по нему же
  # видно, наша ли это машина. Пока порт держит наш слушатель, ответ 204 —
  # доказательство; любой другой код значит, что снаружи на этом адресе сидит
  # кто-то другой. Когда порты держит уже поднятый caddy, спрашиваем только
  # связность: он отвечает редиректом на https, а не нашим 204.
  if [ -n "$held_by_caddy" ]; then
    verdict="$(ask_outside "$DIRECT_IP" 80)"
  else
    case "$(ask_outside_http "http://${DIRECT_IP}/colloq-check")" in
      code:204) verdict=open ;;
      code:*)   verdict=foreign ;;
      closed)   verdict=closed ;;
      *)        verdict=unknown ;;
    esac
  fi
  case "$verdict" in
    open)    say "${DIM}    80 — open from outside, and this machine is what answers${OFF}" ;;
    foreign) say "${RED}    80 — open, but it is NOT this machine that answers${OFF}"; foreign=1 ;;
    closed)  say "${RED}    80 — closed from outside${OFF}"; closed="${closed} 80" ;;
    *)       say "${DIM}    80 — could not ask from outside${OFF}"; unknown="${unknown} 80" ;;
  esac

  # 443 — только связность: TLS наш временный слушатель не умеет, и ничего
  # умнее «соединение состоялось» про этот порт заранее не узнать.
  case "$(ask_outside "$DIRECT_IP" 443)" in
    open)   say "${DIM}    443 — open from outside${OFF}" ;;
    closed) say "${RED}    443 — closed from outside${OFF}"; closed="${closed} 443" ;;
    *)      say "${DIM}    443 — could not ask from outside${OFF}"; unknown="${unknown} 443" ;;
  esac
  [ -n "$held_by_caddy" ] || listener_stop

  # Чужая машина на нашем «публичном» адресе — отдельный отказ, и обойти его
  # флагом нельзя: тут не сомнение проверки, а прямой ответ, что адрес не наш.
  if [ -n "$foreign" ]; then
    die "the address ${DIRECT_IP} answers from outside, but it is not this machine.
  That is what a VPN or a proxy looks like: traffic leaves through someone else's
  box, and we took its address for ours. Pointing a class name at it means sending
  the room to that box, and the certificate never arrives at all.

  If the machine does have a public address, name it directly:
    COLLOQ_PUBLIC_IP=<address> make host-direct HOST=${COLLOQ_HOSTNAME}
  If it does not — this is a case for a tunnel:  make host HOST=${COLLOQ_HOSTNAME}"
  fi

  # Отказ должен называть причину и давать выход, а не просто «нельзя».
  #
  # COLLOQ_DIRECT_FORCE=1 отказ снимает, и это не лазейка «на всякий случай»:
  # проверяющая служба видит машину из Германии и Финляндии, а бывают фаерволы,
  # закрытые для половины мира и открытые для университетской сети. Решение
  # тогда за человеком — но он должен сказать это вслух, а не узнать, что
  # скрипт молча пошёл дальше.
  if [ -n "$closed" ] && [ "${COLLOQ_DIRECT_FORCE:-}" = "1" ]; then
    say "${RED}    ports${closed} are closed from outside, but COLLOQ_DIRECT_FORCE=1 — going on${OFF}"
    say "${DIM}    If the check is right, there will be no certificate: journalctl -u caddy -f${OFF}"
    closed=""
  fi
  if [ -n "$closed" ]; then
    die "ports${closed} on ${DIRECT_IP} are closed from outside — direct mode is impossible here.
  That is how it is behind a provider firewall, behind a home router without
  forwarding and always on a rented vast.ai machine: only the forwarded ssh is
  open there, and 80 and 443 are not handed out at all.

  Publish the class through a tunnel — it goes out as an outbound connection and
  needs no open ports:  make host HOST=${COLLOQ_HOSTNAME}

  If you know for certain the ports are open and the check is lying: COLLOQ_DIRECT_FORCE=1"
  fi

  if [ -n "$unknown" ]; then
    # Спросить снаружи не вышло — это не приговор портам, это молчание
    # проверяющей службы. Но и «всё хорошо» сказать нельзя.
    if [ -n "$on_iface" ]; then
      say "${DIM}    the checking service did not answer; the address belongs to this${OFF}"
      say "${DIM}    machine, the ports are free — going on. If 80 and 443 are closed${OFF}"
      say "${DIM}    after all, caddy gets no certificate: journalctl -u caddy -f${OFF}"
    elif [ "${COLLOQ_DIRECT_FORCE:-}" != "1" ]; then
      die "could not ask from outside, and the address ${DIRECT_IP} does not belong to this machine.
  This is NAT, and it comes in two kinds: one to one on a cloud machine — then all
  is well; port forwarding — then 80 and 443 are closed and there will be no
  certificate. Nothing here can tell them apart.

  A tunnel works in both cases:  make host HOST=${COLLOQ_HOSTNAME}
  Certain the ports are open:    COLLOQ_DIRECT_FORCE=1 make host-direct HOST=${COLLOQ_HOSTNAME}"
    fi
  fi
}

# ------------------------------------------------------------- шаг: имя

direct_point_dns() {
  step "pointing ${COLLOQ_HOSTNAME} at ${DIRECT_IP}"
  #
  # Запись пишет scripts/dns.sh — тот же код, что приводит в порядок всю зону.
  # Своей копии здесь нет намеренно: правило «удалить лишнее, создать
  # недостающее и НИКОГДА не оставлять проксирование» должно жить в одном
  # месте и в одном месте чиниться.
  #
  # Проксирование (оранжевое облако) выключено, и это не мелочь настройки:
  # включённое, оно уводит студентов на пограничные адреса Cloudflare, а они
  # из России не открываются. Прямой режим ценен ровно тем, что между машиной
  # и залом нет никого, — проксирование вернуло бы посредника, да ещё и того
  # самого, от которого уходили.
  #
  ./scripts/dns.sh point "$COLLOQ_HOSTNAME" "$DIRECT_IP" || die \
    "could not set the A record ${COLLOQ_HOSTNAME} → ${DIRECT_IP}.
  CF_TOKEN (Zone:Read + DNS:Edit) is needed, and CF_ZONE in .env if the token
  cannot list the zones."

  # Ждём, пока имя начнёт разрешаться в наш адрес. Это не педантизм: пока
  # публичные резолверы отдают старое, Let's Encrypt придёт по HTTP-01 на
  # прежний адрес, получит отказ и уйдёт в паузу на несколько минут. Полминуты
  # ожидания здесь дешевле, чем эта пауза на паре.
  local seen="" i
  for i in $(seq 1 30); do
    [ "$(resolve_any "$COLLOQ_HOSTNAME" || true)" = "$DIRECT_IP" ] && { seen=1; break; }
    sleep 2
  done
  if [ -n "$seen" ]; then
    say "${DIM}    the name already resolves to ${DIRECT_IP}${OFF}"
  else
    # Не отказ: TTL записи 300 секунд, и старый ответ может ещё лежать в
    # кэшах. caddy повторит попытку сам, поэтому идём дальше, но вслух.
    say "${DIM}    the name does not resolve here yet — the record has a 300 second TTL.${OFF}"
    say "${DIM}    The certificate may be late by those five minutes.${OFF}"
  fi
}

# ----------------------------------------------------------- шаг: caddy

direct_caddy() {
  step "starting caddy on this machine"
  #
  # Приём тот же, что у ретранслятора (scripts/relay-setup.sh): один собранный
  # бинарник вместо репозитория с ключом. Модули здесь не нужны — сертификат
  # берётся по HTTP-01, — а один файл проще обновлять и понимать.
  #
  local arch caddy_bin
  if ! command -v caddy >/dev/null 2>&1; then
    case "$(uname -m)" in
      x86_64|amd64) arch=amd64 ;;
      aarch64|arm64) arch=arm64 ;;
      *) die "I do not know which caddy to take for $(uname -m) — install it yourself and try again." ;;
    esac
    say "${DIM}    installing caddy (${arch})${OFF}"
    curl -fsSL -o /usr/local/bin/caddy \
      "https://caddyserver.com/api/download?os=linux&arch=${arch}" \
      || die "could not download caddy."
    chmod +x /usr/local/bin/caddy
  fi
  caddy_bin="$(command -v caddy)"

  # Чужой конфиг не трогаем, и спрашиваем об этом до того, как заведём
  # пользователя и поменяем права на /etc/caddy. На машине, где caddy уже
  # что-то обслуживает, переписать Caddyfile значило бы молча выключить чей-то
  # сайт — и узнал бы об этом его владелец, а не мы.
  if [ -f /etc/caddy/Caddyfile ] && ! grep -q '^# colloq:' /etc/caddy/Caddyfile; then
    die "this machine already has a /etc/caddy/Caddyfile of its own — I will not overwrite it.
  Add the site to it by hand:
    ${COLLOQ_HOSTNAME} { reverse_proxy 127.0.0.1:${PORT} }
  and restart caddy."
  fi

  id -u caddy >/dev/null 2>&1 || \
    useradd --system --home /var/lib/caddy --shell /usr/sbin/nologin caddy
  install -d -o caddy -g caddy -m 0750 /var/lib/caddy /etc/caddy

  # Конфиг на одно имя, и больше ничего. Он переписывается на каждый запуск —
  # это и делает команду повторяемой: сменилось имя или порт, и файл просто
  # становится верным, без чистки руками.
  cat > /etc/caddy/Caddyfile <<CONF
# colloq: прямой режим (scripts/host.sh). Файл переписывается на каждый запуск,
# правки руками пропадут — правьте скрипт.
#
# Сертификат выпишется автоматически при первом обращении: caddy сам сходит в
# Let's Encrypt по HTTP-01, для чего и нужны настоящие 80 и 443. Ключ от DNS на
# машине не хранится и не нужен.
${COLLOQ_HOSTNAME} {
	# Вебсокеты (а Colloq это в первую очередь они: /collab и /control)
	# проходят через reverse_proxy сами, отдельной настройки не требуют.
	reverse_proxy 127.0.0.1:${PORT} {
		# Единственный заголовок, названный вслух. Ставит его caddy и без нас,
		# но от него зависит флаг Secure на куке персонала (server/src/admin/
		# auth.ts читает x-forwarded-proto), и молчаливое умолчание тут хуже
		# явной строки. X-Forwarded-Host не пишем: caddy передаёт его сам и на
		# лишнюю строку ругается предупреждением при каждой проверке конфига.
		header_up X-Forwarded-Proto https
	}
}
CONF
  "$caddy_bin" fmt --overwrite /etc/caddy/Caddyfile >/dev/null 2>&1 || true
  # Вывод проверки придерживаем и печатаем только при отказе: на успехе caddy
  # пишет несколько строк JSON про адаптацию конфига, и человек, запустивший
  # «выставь семинар наружу», читает их как ошибку.
  local report
  if ! report="$("$caddy_bin" validate --config /etc/caddy/Caddyfile --adapter caddyfile 2>&1)"; then
    printf '%s\n' "$report" >&2
    die "caddy did not accept the config — see the error above."
  fi

  cat > /etc/systemd/system/caddy.service <<UNIT
[Unit]
Description=Caddy for colloq (direct mode)
After=network-online.target
Wants=network-online.target

[Service]
User=caddy
Group=caddy
ExecStart=${caddy_bin} run --config /etc/caddy/Caddyfile --adapter caddyfile
ExecReload=${caddy_bin} reload --config /etc/caddy/Caddyfile --adapter caddyfile --force
Restart=on-abnormal
RestartSec=3
# Право слушать 80 и 443 без запуска от root. Сертификаты и ключи лежат в
# /var/lib/caddy — это домашний каталог пользователя caddy.
AmbientCapabilities=CAP_NET_BIND_SERVICE
CapabilityBoundingSet=CAP_NET_BIND_SERVICE
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
PrivateTmp=true
ReadWritePaths=/var/lib/caddy /etc/caddy

[Install]
WantedBy=multi-user.target
UNIT

  systemctl daemon-reload
  systemctl enable caddy >/dev/null 2>&1 || true
  # enable --now не трогает уже запущенное, а команду задумано повторять:
  # без явного перезапуска второй прогон оставил бы caddy на старом конфиге —
  # то есть на прошлом имени семинара.
  systemctl restart caddy || {
    journalctl -u caddy -n 20 --no-pager 2>/dev/null >&2 || true
    die "caddy did not start."
  }
  sleep 2
  systemctl is-active --quiet caddy || {
    journalctl -u caddy -n 20 --no-pager 2>/dev/null >&2 || true
    die "caddy started and fell over at once — the log is above."
  }
  say "${DIM}    caddy holds 443 and passes requests to ${LOCAL}${OFF}"
}

direct_publish() {
  direct_check_ports
  direct_point_dns
  direct_caddy
  PUBLIC="https://${COLLOQ_HOSTNAME}"
}

# ------------------------------------------------------------- открываем адрес

# Сжато ли то, что сейчас поедет в аудиторию.
#
# Сказать об этом надо ДО ссылки и до первого студента: без .br рядом с
# assets/ сервер сжимает каждый файл на каждый запрос — измерено на самом
# большом куске этой сборки, 11.6 мс процессорного времени и 219 751 байт
# вместо 194 920 у заранее сжатого. Умножается это на число пришедших.
#
# Не отказ: пара важнее, и запретить её из-за режима сборки нельзя. Но и
# промолчать нельзя — раньше молчали, и `make run` без OPTIMIZE=1 уходил в
# аудиторию ровно так.
UNCOMPRESSED="$(assets_uncompressed)"
if [ "${UNCOMPRESSED:-0}" != 0 ]; then
  say "${RED}${UNCOMPRESSED} files in web/dist/assets have no compressed neighbour (.br)${OFF}"
  say "${DIM}    The server compresses them again on EVERY request: 11.6 ms of CPU time${OFF}"
  say "${DIM}    and an extra 25 KB per student, on the same machine where the room${OFF}"
  say "${DIM}    kernels come up.${OFF}"
  say "${DIM}    Rebuild: npm run build:optimized (make run does the same)${OFF}"
  printf '\n'
fi

if [ "$VIA" = direct ]; then
  # Три шага вместо одного «открываю туннель»: проверить порты, направить имя,
  # поднять caddy. Туннеля здесь нет вовсе — наружу смотрит сама машина.
  direct_publish
elif [ "$VIA" = relay ]; then
  step "opening the tunnel to the relay"
  # Поддомен — это всё, что инстанс просит у ретранслятора: frps выдаёт имена
  # только под своей зоной, поэтому попросить чужое имя нельзя даже с секретом.
  SUB="${COLLOQ_HOSTNAME%".$RELAY_DOMAIN"}"
  CONF="$(mktemp -t colloq-frpc.XXXXXX)"
  # Секрет уходит в файл, а не в аргументы: командная строка видна всей машине
  # через ps, и общий ключ ретранслятора там светиться не должен.
  cat > "$CONF" <<CONF
serverAddr = "${RELAY_ADDR}"
serverPort = ${RELAY_PORT}
auth.method = "token"
auth.token = "${RELAY_TOKEN}"
log.to = "console"
log.level = "info"

# Запас готовых соединений до ретранслятора.
#
# Без него каждый новый запрос студента ждёт, пока frpc установит соединение до
# frps: лишний круг по сети ПЕРЕД первым байтом, и приходится он ровно на
# звонок, когда вся группа открывает ссылку разом. Пять — это пять соединений,
# которые висят готовыми; больше держать незачем, дальше работает мультиплекс
# (tcpMux включён по умолчанию, и его мы не трогаем).
transport.poolCount = 5

# useCompression здесь НЕ включается, и это решение, а не пропуск. Через этот
# туннель едет то, что уже сжато: статику отдаёт сервер заранее сжатой (.br), а
# после появления зеркала (см. upload_assets) она сюда и вовсе не заходит.
# Сжимать сжатое — это процессорное время ноутбука за отрицательный выигрыш.
# Мерить это стоит заново, когда зеркало поработает на живых парах.

[[proxies]]
name = "${SUB}"
type = "http"
localIP = "127.0.0.1"
localPort = ${TUNNEL_PORT}
subdomain = "${SUB}"
CONF
  if [ -n "$LOCAL_RUN_ID" ]; then
    printf 'hostHeaderRewrite = "127.0.0.1:%s"\n' "$TUNNEL_PORT" >> "$CONF"
  fi
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
      die "the subdomain ${COLLOQ_HOSTNAME} is taken — this class is open from another machine.
  Close it there or take another name: make host HOST=<name>.colloq.ru"
    fi
    if grep -qiE 'login to server failed|authorization failed|authentication failed|token in login doesn' "$LOG" 2>/dev/null; then
      die "the relay did not accept the secret. Check RELAY_TOKEN in .env."
    fi
    if grep -qiE 'start error|login to server failed' "$LOG" 2>/dev/null; then
      grep -iE 'start error|login to server failed' "$LOG" | head -3 >&2
      die "the relay refused."
    fi
    kill -0 "$TUNNEL_PID" 2>/dev/null || { cat "$LOG" >&2; die "frpc died without opening the tunnel."; }
    sleep 1
  done
  rm -f "$CONF"
  [ -n "$ok" ] || { cat "$LOG" >&2; die "no answer from the relay in 30 seconds."; }
  # Туннель есть — значит у имени есть и сертификат (ретранслятор выпускает
  # его только живому имени), и статику можно класть на место. Именно здесь, а
  # не в конце: зеркало должно быть полным к моменту, когда ссылка уйдёт в чат.
  upload_assets
elif [ -n "${COLLOQ_HOSTNAME:-}" ]; then
  step "opening the named Cloudflare tunnel"
  # Именованный туннель: постоянный адрес, но его нужно один раз завести
  # (make tunnel-setup). Без этого cloudflared не знает, куда маршрутизировать.
  #
  # И говорим вслух, через что пошли: имя под своей зоной без RELAY_DOMAIN в
  # .env молча уезжало в Cloudflare, а его адреса из России не открываются —
  # выяснялось это уже в аудитории, где ссылка не открылась ни у кого.
  say "${DIM}    through Cloudflare. Your own relay (Cloudflare addresses do not${OFF}"
  say "${DIM}    open from Russia) — RELAY_* in .env, see make relay-setup${OFF}"
  cloudflared tunnel --no-autoupdate run --url "$LOCAL" "${ORIGIN_ARGS[@]}" colloq >"$LOG" 2>&1 &
  TUNNEL_PID=$!
  PUBLIC="https://${COLLOQ_HOSTNAME}"
else
  step "opening the quick Cloudflare tunnel"
  cloudflared tunnel --no-autoupdate --url "$LOCAL" "${ORIGIN_ARGS[@]}" >"$LOG" 2>&1 &
  TUNNEL_PID=$!
  PUBLIC=""
  # Адрес приходит не сразу и не первой строкой — cloudflared сначала пишет
  # баннер. Ждём именно ссылку, а не «прошло N секунд».
  for _ in $(seq 1 60); do
    PUBLIC="$(grep -oE 'https://[a-z0-9-]+\.trycloudflare\.com' "$LOG" | head -1 || true)"
    [ -n "$PUBLIC" ] && break
    kill -0 "$TUNNEL_PID" 2>/dev/null || { cat "$LOG" >&2; die "cloudflared died without opening the tunnel."; }
    sleep 1
  done
  [ -n "$PUBLIC" ] || { cat "$LOG" >&2; die "no tunnel address in a minute."; }
fi

step "publishing the external address"
if [ "$WHO" != local ]; then
  set_public_url "$PUBLIC"
  TOUCHED_ENV=1
fi
case "$WHO" in
  local)
    LEASE_OWNER="${LOCAL_RUN_ID}:$$:${RANDOM}"
    "${LEASE[@]}" acquire "$LEASE_FILE" "$LOCAL_RUN_ID" "$LEASE_OWNER" "$PUBLIC" "$HEALTH_LOCAL"
    "${LEASE[@]}" watch "$LEASE_FILE" "$LOCAL_RUN_ID" "$LEASE_OWNER" "$TUNNEL_PID" "$$" "$HEALTH_LOCAL" &
    LEASE_PID=$!
    ;;
  cluster)
    bash scripts/cluster.sh public-url "$PUBLIC"
    ;;
  service)
    # Службу НЕ перезапускаем, и это исправление.
    #
    # Здесь стоял `systemctl restart colloq` с объяснением «служба читает .env
    # при запуске, новый адрес доезжает только перезапуском». Неправда:
    # config.publicUrl — геттер, и readPublicUrl (server/src/config.ts)
    # перечитывает файл не реже раза в две секунды, причём файл главнее
    # переменной окружения; все ссылки строятся через него на каждый запрос.
    # То же самое написано и в шапке deploy/colloq.service. А перезапуск рвал
    # все сокеты комнаты — заметнее всего когда `make host` повторяют посреди
    # пары, потому что упал туннель: зал уходил в переподключение без всякой
    # причины.
    #
    # Ждать — те самые две секунды, но не вслепую: `/api/health` называет
    # адрес, который сервер СЕЙЧАС пишет в ссылки (server/src/app.ts ·
    # publicUrl), и ждём мы совпадения, а не выжданного времени. Здесь стоял
    # `sleep 3` — единственный сон в этом скрипте, поставленный не потому, что
    # чего-то ждут, а потому, что спросить было некого.
    #
    # Без `-f`: пока не поднято ядро, здоровье отвечает 503 — это по-прежнему
    # живой сервер, и адрес в его ответе тот самый, ради которого мы ждём.
    ok=""
    said=""
    blind=0
    for _ in $(seq 1 20); do
      said="$(curl -s --max-time 2 "$LOCAL/api/health" 2>/dev/null || true)"
      if printf '%s' "$said" | grep -qF "\"publicUrl\":\"${PUBLIC%/}\""; then ok=1; break; fi
      # Служба может быть собрана раньше этого поля: тогда спросить нечего, и
      # остаётся прежний ответ — живой инстанс после трёх секунд перечитывания.
      # Молчание и «поле есть, адрес другой» — это НЕ он, и ждать их надо до
      # конца срока.
      case "$said" in
        '' | *'"publicUrl"'*) ;;
        *)
          blind=$((blind + 1))
          if [ "$blind" -ge 3 ]; then ok=1; break; fi
          ;;
      esac
      sleep 1
    done
    [ -n "$ok" ] || {
      journalctl -u colloq -n 20 --no-pager 2>/dev/null >&2 || true
      [ -n "$said" ] || die "the service stopped answering while the address was changing. Log: make service-logs"
      die "the service answers, but writes not ${PUBLIC} into links: .env was not reread. Log: make service-logs"
    }
    say "${DIM}    the service reread .env: ${PUBLIC} (no restart, sockets intact)${OFF}"
    ;;
  container)
    PUBLIC_URL="$PUBLIC" docker compose up -d app >/dev/null
    ;;
  host)
    # Native servers reread .env on each cache refresh, just like the service.
    # The tunnel owns no application PID and must never restart it.
    ok=""
    for _ in $(seq 1 20); do
      said="$(curl -s --max-time 2 "$LOCAL/api/health" 2>/dev/null || true)"
      if printf '%s' "$said" | grep -qF "\"publicUrl\":\"${PUBLIC%/}\""; then ok=1; break; fi
      sleep 1
    done
    [ -n "$ok" ] || die "The server did not reread the external address; local work continues."
    ;;
  *)
    # Молча пройти мимо нельзя: аудитория получит localhost, то есть ничего.
    say "${RED}    ${LOCAL} is held by some other process, not colloq.${OFF}"
    say "${DIM}    Its PUBLIC_URL cannot be changed from here — restart it yourself with${OFF}"
    say "${DIM}    PUBLIC_URL=${PUBLIC}, or links to classes will lead to localhost.${OFF}"
    ;;
esac

step "checking that it really answers from outside"
#
# Проверка идёт мимо системного резолвера. Измерено на живой машине: туннель
# отдавал 200 за 0.6 секунды, а `curl https://<адрес>` тут же падал с «could
# not resolve host» — getaddrinfo держал отрицательный ответ, хотя dig то же
# имя видел прекрасно. Своя же проверка объявляла рабочий семинар сломанным.
#
# Поэтому адрес берётся у публичного резолвера и подставляется через --resolve:
# так проверяется туннель, а не настройки DNS на этом ноутбуке.
host_only="${PUBLIC#https://}"

probe() {
  local ip
  if ip="$(resolve_any "$host_only")"; then
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
  dir="${DATA_DIR:-$COLLOQ_STATE_ROOT/data}"
  t="$(cat "$dir/setup-token" 2>/dev/null | tr -d '\r\n' || true)"
  [ -n "$t" ] && token_works "$t" && { printf '%s' "$t"; return 0; }
  return 1
}
SETUP_TOKEN="$(read_setup_token || true)"

printf '\n'
if [ -n "$ok" ]; then
  say "${BOLD}Colloq is available at this link${OFF}"
else
  say "${RED}The check from this machine did not go through.${OFF}"
  if [ "$VIA" = direct ]; then
    # В прямом режиме подозреваемый другой, и он один: сертификат. Порты мы уже
    # проверили снаружи, имя направили — остаётся выдача, которая идёт минуту, а
    # при неуехавшем DNS и все пять. caddy при этом молчит в терминал, зато
    # говорит в журнал, поэтому сюда и посылаем.
    say "${DIM}The ports are open and the name points here — most likely the certificate${OFF}"
    say "${DIM}is still being issued: up to a minute, and up to five if the DNS record${OFF}"
    say "${DIM}has just changed. What is going on: journalctl -u caddy -f${OFF}"
  else
    # Чаще всего это не туннель, а сеть, из которой мы проверяем: корпоративный
    # DNS или блокировка исходящих. Студенты из дома при этом заходят нормально,
    # поэтому пугать «не работает» нельзя — надо сказать, что именно неясно.
    say "${DIM}The tunnel is up, but the check did not pass — usually this network's DNS${OFF}"
    say "${DIM}is to blame, not the class. Open the link from a phone on mobile internet.${OFF}"
  fi
fi
say "  ${CYAN}${BOLD}${PUBLIC}${OFF}"

if [ -n "$SETUP_TOKEN" ]; then
  printf '\n'
  say "${BOLD}Sign-in to the panel — this link is for you only${OFF}"
  say "  ${CYAN}${PUBLIC}/admin/t/${SETUP_TOKEN}${OFF}"
  # Строка стоит прямо под ссылкой, а не в конце: спутать её с адресом семинара
  # и отправить в чат группы — ровно одно движение, и оно необратимо.
  say "  ${RED}This is the key to the instance.${OFF} ${DIM}Do not send it to a chat and do${OFF}"
  say "  ${DIM}not leave it on screen while the room is watching. Students get the${OFF}"
  say "  ${DIM}class link, which you copy from the panel.${OFF}"
else
  # Ссылка, которая не откроет панель, хуже, чем её отсутствие: человек три раза
  # ткнёт в неё, прежде чем усомнится в ссылке, а не в себе.
  printf '\n'
  say "${DIM}Not printing the sign-in link for the panel: none of the setup tokens found${OFF}"
  say "${DIM}suited the server at ${LOCAL}. Take it from the DATA_DIR of the server that${OFF}"
  say "${DIM}answers there and open ${PUBLIC}/admin/t/<token>.${OFF}"
fi

printf '\n'
if [ "$VIA" = direct ]; then
  # Прямой режим нельзя описывать словами про это окно — оно здесь ни при чём,
  # и притворяться, что Ctrl+C что-то выключает, значит обещать выключатель,
  # которого нет. Адрес держит служба caddy, она переживает и закрытый терминал,
  # и оборванный ssh, и перезагрузку машины.
  say "${DIM}Everything runs here, and the students come straight here too: caddy on${OFF}"
  say "${DIM}this machine terminates TLS and passes the request to colloq at ${LOCAL}.${OFF}"
  say "${DIM}There is no relay and no Cloudflare on this path.${OFF}"
  printf '\n'
  say "${DIM}This window can be closed: caddy is a systemd service, it lives on its own.${OFF}"
  say "${DIM}Switch the address off: ${OFF}systemctl stop caddy"
  say "${DIM}Read the log:           ${OFF}journalctl -u caddy -f"
  say "${DIM}PUBLIC_URL stays in .env: the address is alive, and rolling it back to${OFF}"
  say "${DIM}localhost is pointless — unlike a tunnel, it does not die with the script.${OFF}"
  if [ -n "$RELAY_DOMAIN" ] && [ "${COLLOQ_HOSTNAME%".$RELAY_DOMAIN"}" != "$COLLOQ_HOSTNAME" ]; then
    # Про это надо сказать прямо: запись на конкретное имя сильнее звёздочки,
    # и пока она есть, ретранслятор для этого имени не при делах. Вернуть имя
    # ему — значит удалить запись руками (или прогнать scripts/dns.sh, который
    # приводит зону к виду «звёздочка на ретранслятор»).
    printf '\n'
    say "${DIM}The record ${COLLOQ_HOSTNAME} → ${DIRECT_IP} stays in the zone and overrides${OFF}"
    say "${DIM}*.${RELAY_DOMAIN}: while it is there, this name leads here, not to the relay.${OFF}"
  fi
  printf '\n'
  exit 0
fi
if [ "$VIA" = relay ]; then
  say "${DIM}Everything runs here: the students' browsers go to the relay, and it goes${OFF}"
else
  say "${DIM}Everything runs here: the students' browsers go to Cloudflare, and it goes${OFF}"
fi
say "${DIM}to this window. Close it (Ctrl+C) and the link stops working, while colloq${OFF}"
say "${DIM}keeps turning locally at ${LOCAL}.${OFF}"
printf '\n'

# Держим окно живым: туннель существует ровно столько, сколько этот процесс.
wait "$TUNNEL_PID"
