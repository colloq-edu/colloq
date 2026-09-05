#!/usr/bin/env bash
#
# Аренда машины на vast.ai — когда своей с GPU нет.
#
#   scripts/vast.sh up      найти, арендовать, развернуть на ней Colloq
#   scripts/vast.sh status  что арендовано, в каком оно состоянии и почём
#   scripts/vast.sh sync    снять данные с арендованной машины сюда
#   scripts/vast.sh down    уничтожить машину — вместе со всем, что на ней
#
# Занятие целиком одной командой:
#
#   make vast-up GPU="RTX 5070" HOST=demo.colloq.ru
#
# — арендовать машину с этой картой, развернуть Colloq, развернуть снятую копию,
# если она лежит в backups/, и открыть адрес наружу. HOST и GPU приезжают
# переменными окружения, а не аргументами: так их передаёт Makefile, и так они
# не мешают старому вызову без них.
#
# АДРЕС ПОДНИМАЕТСЯ ТАМ, А НЕ ЗДЕСЬ: семинар считается на арендованной машине,
# значит и туннель наружу открывать ей. `make host` — это окно, живущее ровно
# столько, сколько живёт туннель, поэтому запускается оно в tmux-сессии
# «colloq-host»: иначе семинар обрывался бы в ту секунду, когда закрыли ноутбук
# и ssh-сессия умерла. Дождаться при этом надо не «tmux запустился», а ответа
# самого адреса снаружи: ссылку, которая ещё не отвечает, раздают аудитории
# один раз и потом полпары выясняют, почему её никто не открыл.
#
# ТОЛЬКО ВИРТУАЛКИ, и это не вкус. vast сдаёт два разных товара: docker-инстанс
# (контейнер на чужой машине) и виртуалку — предложение с vms_enabled=true,
# запускаемое образом из docker.io/vastai/kvm. Colloq поднимает КОНТЕЙНЕР НА
# КАЖДУЮ КОМНАТУ сам, через сокет docker, а внутри docker-инстанса vast docker
# запрещает: «Docker-in-Docker is disabled for security» — их собственный FAQ.
# То есть там сервер не поднял бы ни одного ядра комнаты и молча откатился на
# общее, где из любой комнаты видны файлы всех остальных. Изоляция, ради
# которой контейнер на комнату и заводили, исчезла бы ровно на чужой машине.
# В виртуалке есть systemd, а с ним и docker, и всё работает как дома.
#
# ТОЛЬКО ON-DEMAND. Рядом лежит вдвое более дешёвый interruptible: его отбирает
# тот, кто предложит больше, без предупреждения и в любую секунду. Секунда
# приходится на середину пары. Разница в цене не окупается ничем.
#
# ДАННЫЕ НА НЕЙ ВРЕМЕННЫЕ. Уничтожили инстанс — стёрлось всё, что на диске;
# ушли в ноль по балансу — vast уничтожит его сам. Поэтому `sync` здесь не
# удобство, а вторая половина работы, а `down` сначала показывает, когда
# снималась последняя копия, и просит подтверждение словом.
#
# ЧТО ПРОВЕРЕНО, А ЧТО НЕТ. Поиск предложений прогонялся на живом аккаунте, но
# только чтением: фильтр vms_enabled, форма ответа и поля offers — настоящие.
# Проверено и то, что с негодным ключом vast отвечает HTTP 404 с телом
# {"error":"auth_error"}, — поэтому ниже смотрят в тело ответа, а не в код.
# Сама аренда, разворачивание, снятие данных и уничтожение не выполнялись ни
# разу: за них платят настоящими деньгами. Первый настоящий прогон стоит
# сделать на дешёвом предложении и не в день занятия.
#
# Ключ VAST_TOKEN читается из .env. Он не печатается, не уходит в аргументы
# командной строки (их видно всей машине через `ps`) и не едет на арендованную
# машину: ею уже расплатились, второй раз ключ там не нужен.
set -euo pipefail

cd "$(dirname "$0")/.."

RED=$'\033[31m'; DIM=$'\033[2m'; BOLD=$'\033[1m'; CYAN=$'\033[36m'; OFF=$'\033[0m'
say() { printf '%s\n' "$*"; }
die() { printf '%s%s%s\n' "$RED" "$*" "$OFF" >&2; exit 1; }

# JSON разбирает python3, а не jq: jq на macOS по умолчанию нет, а python3 уже
# нужен scripts/dns.sh. Разбираемое приезжает функции на stdin.
py() { python3 -c "$1"; }

read_env() { grep -E "^$1=" .env 2>/dev/null | tail -1 | cut -d= -f2- | tr -d ' \r' || true; }

API=https://console.vast.ai/api/v0
CMD="${1:-}"

[ -f .env ] || die "нет .env — сделайте его: make up (или cp .env.example .env)."

# Метка на инстансе. Ею — и только ею — скрипт потом находит арендованную
# машину: переменная в памяти не переживает ни закрытый терминал, ни второй
# ноутбук, а метка живёт на стороне vast.
LABEL="$(read_env VAST_LABEL)";         LABEL="${LABEL:-colloq}"
# Образ виртуалки. Теги в vastai/kvm датированные, `latest` там нет вовсе;
# список — hub.docker.com/r/vastai/kvm/tags.
IMAGE="$(read_env VAST_IMAGE)";         IMAGE="${IMAGE:-docker.io/vastai/kvm:ubuntu_cli_22.04-2025-11-21}"
# Диск в гигабайтах. 60 — это образ ядра с torch под CUDA (десятки гигабайт),
# база и файлы семинаров.
DISK="$(read_env VAST_DISK)";           DISK="${DISK:-60}"
MAX_PRICE="$(read_env VAST_MAX_PRICE)"; MAX_PRICE="${MAX_PRICE:-1.0}"
# Пусто — любая карта. Имена в API пишутся с пробелом: «RTX 4090».
# GPU= из командной строки сильнее .env: карту выбирают под занятие («сегодня
# нужна 5070»), а не раз и навсегда.
GPU_NAME="${GPU:-$(read_env VAST_GPU)}"
# Память карты, ГБ. Ниже переводится в мегабайты не через 1024: карта «на
# 24 ГБ» рапортует 24564 МБ, и порог 24*1024=24576 отсекает все 4090 разом.
#
# Умолчание в 24 ГБ достаётся только тем, кто карту не назвал вовсе. Названная
# карта — это уже сделанный выбор памяти: у RTX 5070 её 12 ГБ, и умолчание
# превращало бы внятное «хочу 5070» в «предложений нет», не сказав, кто именно
# их отсёк.
GPU_RAM="$(read_env VAST_GPU_RAM)"
if [ -z "$GPU_RAM" ] && [ -z "$GPU_NAME" ]; then GPU_RAM=24; fi
GPU_RAM_TEXT="${GPU_RAM:+от $GPU_RAM ГБ}"; GPU_RAM_TEXT="${GPU_RAM_TEXT:-любая}"
# Ключ называется явно: в ~/.ssh их обычно с десяток, sshd обрывает попытку
# после пятой, и до нужного дело не доходит.
SSH_KEY="$(read_env VAST_SSH_KEY)";     SSH_KEY="${SSH_KEY:-$HOME/.ssh/id_ed25519}"
# Тильду в .env пишут по-человечески, а для оболочки внутри строки она просто
# символ: без этой строки ключ «~/.ssh/vast» не находится, и скрипт отказывает,
# показывая путь, который человек видит своими глазами и считает верным.
# Тильда здесь — начало образца, а не путь, который надо раскрыть.
# shellcheck disable=SC2088
case "$SSH_KEY" in "~/"*) SSH_KEY="$HOME/${SSH_KEY#\~/}" ;; esac
RELAY_DOMAIN="$(read_env RELAY_DOMAIN)"
RELAY_ADDR="$(read_env RELAY_ADDR)"
# Сам секрет ретранслятора здесь не нужен — его читает host.sh уже на машине.
# Проверяем только, что строка в .env не пуста: пустая означает туннель, который
# не поднимется, и узнать об этом лучше до аренды.
RELAY_TOKEN="$(read_env RELAY_TOKEN)"
# Тот же порт, что и здесь: .env уезжает на машину целиком, и PORT в нём тот
# самый. Прибитая тройка врала бы про здоровье инстанса при PORT=4000.
PORT="$(read_env PORT)";               PORT="${PORT:-3000}"

REMOTE_DIR=/opt/colloq
# Тот же frp, что ставит relay-setup.sh на ретранслятор: там frps, здесь frpc.
FRP_VERSION="${FRP_VERSION:-0.71.0}"

CURLRC=""
TMPS=()
cleanup() {
  local f
  for f in "${TMPS[@]:-}"; do
    if [ -n "$f" ]; then rm -f "$f"; fi
  done
  if [ -n "$CURLRC" ]; then rm -f "$CURLRC"; fi
  return 0
}
trap cleanup EXIT INT TERM

# ------------------------------------------------------------------- ключ

auth() {
  local token
  token="$(read_env VAST_TOKEN)"
  [ -n "$token" ] || die "в .env нет VAST_TOKEN.
  Ключ заводится на https://cloud.vast.ai/manage-keys/ (кнопка +New) и
  показывается там ровно один раз. Впишите его в .env строкой VAST_TOKEN=…"
  # Секрет уходит в файл, а не в аргументы curl: командная строка видна всей
  # машине через `ps`, а этим ключом снимают деньги. mktemp создаёт файл сразу
  # с правами 0600, поэтому нет и мгновения, когда он читаем всеми и уже полон.
  CURLRC="$(mktemp -t colloq-vast.XXXXXX)"
  printf 'header = "Authorization: Bearer %s"\n' "$token" > "$CURLRC"
  unset token
}

# api МЕТОД ПУТЬ [ТЕЛО] — печатает тело ответа, падает на любом отказе.
api() {
  local method="$1" path="$2" body="${3:-}" out code text err
  out="$(mktemp -t colloq-vast-out.XXXXXX)"
  if [ -n "$body" ]; then
    code="$(curl -s -o "$out" -w '%{http_code}' --max-time 90 -K "$CURLRC" \
      -X "$method" -H 'content-type: application/json' -d "$body" "$API/$path" || true)"
  else
    code="$(curl -s -o "$out" -w '%{http_code}' --max-time 90 -K "$CURLRC" \
      -X "$method" "$API/$path" || true)"
  fi
  text="$(cat "$out")"; rm -f "$out"
  # Код ответа здесь не показатель: с негодным ключом vast отвечает 404 — не
  # 401 — и телом {"success":false,"error":"auth_error"}. Проверено. Поэтому
  # решает тело, а код нужен только тогда, когда тела нет вовсе.
  err="$(printf '%s' "$text" | py '
import json, sys
try:
    d = json.load(sys.stdin)
except Exception:
    raise SystemExit
if isinstance(d, dict) and d.get("error"):
    print(d["error"], (d.get("msg") or "").replace("\n", " "))
' || true)"
  case "$err" in
    '') : ;;
    auth_error*) die "vast не принял ключ. Проверьте VAST_TOKEN в .env: он
  показывается один раз, при создании, на https://cloud.vast.ai/manage-keys/" ;;
    *) die "vast отказал: $err" ;;
  esac
  [ -n "$(printf '%s' "$text" | tr -d '[:space:]')" ] \
    || die "vast ответил пустотой (HTTP $code). Повторите через минуту."
  printf '%s' "$text"
}

# ------------------------------------------------------------- инструменты

need() { command -v "$1" >/dev/null 2>&1 || die "нужен $1. $2"; }

need_tools() {
  need curl    "Он есть в любой системе — проверьте PATH."
  need python3 "brew install python — им здесь разбирают ответы vast."
  need ssh     "Он есть в любой системе — проверьте PATH."
  need rsync   "brew install rsync"
  need tar     "Он есть в любой системе — проверьте PATH."
  # Официальный CLI (`curl -fsSL https://vast.ai/install.sh | bash` или
  # `pip install vastai`) здесь не нужен: всё делается по REST. Он пригодится
  # ровно для того, чего этот скрипт намеренно не делает сам, — зарегистрировать
  # ssh-ключ в аккаунте; об этом сказано в отказе ниже.
}

# ------------------------------------------------------------------- ssh

# Подлинность хоста не проверяется, и это цена аренды, а не небрежность:
# машина каждый раз новая, а адреса и порты своих форвардеров vast
# переиспользует — сохранённый ключ от прошлой аренды через неделю встретил бы
# нас «REMOTE HOST IDENTIFICATION HAS CHANGED» и оборвал развёртывание на
# полпути. Сверять не с чем. Отсюда правило, которому подчинено всё остальное:
# на арендованную машину не едет ничего, что не переживёт чужих глаз, —
# VAST_TOKEN в первую очередь.
ssh_opts() {
  printf '%s' "-o BatchMode=yes -o ConnectTimeout=10 -o StrictHostKeyChecking=no \
-o UserKnownHostsFile=/dev/null -o LogLevel=ERROR -o IdentitiesOnly=yes"
}
ssh_cmd() { printf 'ssh %s -i %q -p %s' "$(ssh_opts)" "$SSH_KEY" "$INST_SSH_PORT"; }
# Разбиение на слова здесь и нужно: ssh_opts отдаёт список опций, а не один
# аргумент.
# shellcheck disable=SC2046
rssh() { ssh $(ssh_opts) -i "$SSH_KEY" -p "$INST_SSH_PORT" "root@$INST_SSH_HOST" "$@"; }

# ---------------------------------------------------------------- инстанс

INST_ID=""; INST_STATUS=""; INST_SSH_HOST=""; INST_SSH_PORT=""
INST_DPH=""; INST_GPU=""; INST_NGPU=""; INST_START=""; INST_MSG=""

# Находит наш инстанс по метке; возвращает 1, если такого нет.
#
# Отказ самого vast и «инстанса нет» — разные вещи, и путать их здесь нельзя:
# из «нет» команда up делает вывод «надо арендовать», и молчаливая ошибка сети
# обернулась бы второй арендованной машиной рядом с первой. Поэтому каждый шаг
# проверяется явно, а не оставляется на set -e: load_instance зовут в условии
# `if`, где set -e не действует.
load_instance() {
  local raw line
  raw="$(api GET "instances/")" || die "не смог спросить vast про инстансы."
  line="$(printf '%s' "$raw" | LABEL="$LABEL" py '
import json, os, sys
want = os.environ["LABEL"]
mine = [i for i in (json.load(sys.stdin).get("instances") or [])
        if (i.get("label") or "") == want]
if not mine:
    raise SystemExit
if len(mine) > 1:
    print("машин с меткой «%s» больше одной — беру первую" % want, file=sys.stderr)
i = mine[0]
# Куда стучаться ssh. У виртуалки два ответа, и первый — ложный: поля
# ssh_host/ssh_port называют прокси vast (ssh5.vast.ai:31430), а он поднят
# только у обычных docker-инстансов, и на виртуалке отвечает «connection
# refused» все десять минут ожидания. Правда лежит в ports: докерная карта
# портов машины, где 22/tcp смотрит на публичный адрес и свой номер.
host, port = i.get("ssh_host") or "", i.get("ssh_port") or ""
mapped = ((i.get("ports") or {}).get("22/tcp") or [])
direct = next((m.get("HostPort") for m in mapped if m.get("HostPort")), None)
if direct and i.get("public_ipaddr"):
    host, port = str(i["public_ipaddr"]).strip(), str(direct)
cols = ("id", "actual_status", "dph_total",
        "gpu_name", "num_gpus", "start_date", "status_msg")
print("\t".join([str(i.get("id") or ""), str(i.get("actual_status") or ""),
                 host, str(port)]
                + [str(i.get(c) if i.get(c) is not None else "") for c in cols[2:]]))
')" || die "не понял ответ vast про инстансы."
  [ -n "$line" ] || return 1
  IFS=$'\t' read -r INST_ID INST_STATUS INST_SSH_HOST INST_SSH_PORT \
    INST_DPH INST_GPU INST_NGPU INST_START INST_MSG <<<"$line"
  return 0
}

# Ждёт, пока инстанс дойдёт до running. Виртуалка грузится минуты, а не
# секунды, — но ждать её вечно нельзя: из exited, unknown и offline инстанс в
# running уже не придёт (это сказано у vast прямым текстом), а тарифицируется
# он всё это время.
wait_running() {
  local id="$1" waited=0 raw st msg
  while [ "$waited" -lt 900 ]; do
    raw="$(api GET "instances/$id/")" || die "не смог спросить vast про инстанс $id."
    st="$(printf '%s' "$raw" | py '
import json, sys
print((json.load(sys.stdin).get("instances") or {}).get("actual_status") or "")')"
    case "$st" in
      running) return 0 ;;
      exited|unknown|offline)
        msg="$(printf '%s' "$raw" | py '
import json, sys
print(((json.load(sys.stdin).get("instances") or {}).get("status_msg") or "").strip().replace("\n", " "))')"
        say "${RED}    машина встала в «${st}» — в running это уже не перейдёт${OFF}"
        if [ -n "$msg" ]; then say "${DIM}    $msg${OFF}"; fi
        die "деньги идут, пока инстанс существует. Уничтожьте его и повторите:
  make vast-down · потом make vast-up" ;;
    esac
    sleep 10; waited=$((waited + 10))
  done
  die "машина не дошла до running за 15 минут.
  Посмотреть: make vast-status · уничтожить: make vast-down"
}

# Сколько уже натикало. Не счёт, а порядок величины: vast считает по секундам и
# берёт ещё за диск, поэтому цифра нужна для решения «пора выключать», а не для
# бухгалтерии.
spent() {
  [ -n "$INST_START" ] && [ -n "$INST_DPH" ] || return 0
  START="$INST_START" DPH="$INST_DPH" NOW="$(date +%s)" py '
import os
try:
    h = (float(os.environ["NOW"]) - float(os.environ["START"])) / 3600
    print("%d ч %d мин — примерно $%.2f" % (h, (h % 1) * 60, h * float(os.environ["DPH"])))
except Exception:
    pass
' 2>/dev/null || true
}

# Самая свежая копия данных, снятая сюда. Её дату показывают и `status`, и
# `down`: «уничтожить» без этой строки — решение вслепую.
last_backup() { ls -1t backups/colloq-*.db 2>/dev/null | head -1 || true; }

backup_age() {
  local f="$1" when
  when="$(date -r "$f" '+%d.%m %H:%M' 2>/dev/null || true)"
  printf '%s%s' "$f" "${when:+ ($when)}"
}

# ---------------------------------------------------------------- адрес

# Имя, под которым семинар видно из аудитории. Пусто — наружу не выставляем
# вовсе: это и есть прежнее поведение `vast.sh up`, и ломать его нельзя.
WANT_HOST="${HOST:-}"
# Имя без точки — поддомен нашей зоны: «demo» значит demo.colloq.ru. С точкой
# — полное имя, ровно как его понимает host.sh: транспорт он выбирает по тому,
# кончается ли имя на RELAY_DOMAIN, а не по отдельному флагу.
case "$WANT_HOST" in
  ''|*.*) : ;;
  *)
    [ -n "$RELAY_DOMAIN" ] || die "«${WANT_HOST}» без точки — это поддомен, а RELAY_DOMAIN в .env пуст.
  Напишите имя целиком (HOST=demo.example.ru) или заполните RELAY_*: make relay-setup."
    WANT_HOST="$WANT_HOST.$RELAY_DOMAIN" ;;
esac
# Имя уезжает на арендованную машину внутрь строки, которую там разбирает
# оболочка. Всё, что не буква, цифра, точка и дефис, было бы там уже не именем,
# а второй командой.
case "$WANT_HOST" in
  *[!A-Za-z0-9.-]*) die "в имени «${WANT_HOST}» есть посторонние знаки. Ожидаю имя вида demo.colloq.ru." ;;
esac

# Шагов шесть, а с адресом семь. Считаем заранее: «6/7», после которого седьмого
# не будет, хуже честных «6/6».
STEPS=6
if [ -n "$WANT_HOST" ]; then STEPS=7; fi

TMUX_SESSION=colloq-host
HOST_IP=""

# Адрес спрашивается у публичных резолверов, а не у системного. Это измерено в
# host.sh: getaddrinfo держит отрицательный ответ и объявляет живое имя
# несуществующим. Здесь та же ошибка стоит дороже — по ней отказывают ДО аренды.
resolve_host() {
  local r ip
  for r in 1.1.1.1 8.8.8.8 9.9.9.9; do
    ip="$(dig +short +time=2 +tries=1 "$1" "@$r" 2>/dev/null | grep -E '^[0-9.]+$' | head -1 || true)"
    if [ -n "$ip" ]; then printf '%s' "$ip"; return 0; fi
  done
  return 1
}

# Здоровье проверяется СНАРУЖИ, с этой машины: «localhost отвечает» на
# арендованной верно и при наглухо мёртвом туннеле, то есть ровно в том случае,
# ради которого проверка и заводится. Резолвер подставляется свой — причина та
# же, что абзацем выше.
host_health() {
  local code
  if [ -n "$HOST_IP" ]; then
    code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 \
      --resolve "$WANT_HOST:443:$HOST_IP" "https://$WANT_HOST/api/health" || true)"
    [ "$code" = 200 ] && return 0
  fi
  code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 "https://$WANT_HOST/api/health" || true)"
  [ "$code" = 200 ]
}

# Всё, что можно узнать про адрес, узнаётся до аренды. Машина тарифицируется с
# первой секунды, а «RELAY_TOKEN не вписан» и «имя не резолвится» выясняются
# одинаково быстро и до неё, и после — только во втором случае за деньги.
check_host_ready() {
  [ -n "$WANT_HOST" ] || return 0
  # Наружу арендованная машина умеет выходить только через ретранслятор: frpc
  # на неё ставится, cloudflared нет, да и адреса Cloudflare из России не
  # открываются. Имя не под нашей зоной host.sh увёл бы в Cloudflare, и туннель
  # не поднялся бы вовсе — уже на арендованной машине.
  if [ -z "$RELAY_DOMAIN" ] || [ "${WANT_HOST%".$RELAY_DOMAIN"}" = "$WANT_HOST" ]; then
    die "«${WANT_HOST}» не под зоной ретранслятора${RELAY_DOMAIN:+ («${RELAY_DOMAIN}»)}.
  Арендованная машина выходит наружу только через него: cloudflared туда не
  ставится, а адреса Cloudflare всё равно не открываются из России.
  Возьмите имя вида <что-нибудь>.${RELAY_DOMAIN:-colloq.ru} — или поднимите
  ретранслятор: make relay-setup."
  fi
  [ -n "$RELAY_ADDR" ]  || die "в .env нет RELAY_ADDR — адреса ретранслятора.
  Его печатает make relay-setup, четырьмя строками; они же есть в .env.example."
  [ -n "$RELAY_TOKEN" ] || die "в .env нет RELAY_TOKEN — общего секрета ретранслятора.
  Без него frps на той стороне не пустит туннель, и адрес останется мёртвым."

  if ! command -v dig >/dev/null 2>&1; then
    say "${DIM}    dig не нашёлся — резолв имени не проверяю${OFF}"
  elif HOST_IP="$(resolve_host "$WANT_HOST")"; then
    say "${DIM}    $WANT_HOST → $HOST_IP${OFF}"
    # Не отказ: перед ретранслятором может стоять что угодно. Но имя, ведущее
    # мимо него, — это туннель, который поднимется, и адрес, который молчит.
    if [ -n "$RELAY_ADDR" ] && [ "$HOST_IP" != "$RELAY_ADDR" ]; then
      say "${DIM}    (RELAY_ADDR в .env — $RELAY_ADDR; имя ведёт не туда)${OFF}"
    fi
  else
    die "имя $WANT_HOST не резолвится ни через 1.1.1.1, ни через 8.8.8.8, ни через 9.9.9.9.
  Под ретранслятор заводится запись «*.${RELAY_DOMAIN}» — её ставит scripts/dns.sh.
  Проверить руками: dig +short $WANT_HOST @1.1.1.1
  Отказываюсь до аренды: машина тарифицируется с первой секунды, а имени, которого
  нет, не поможет никакой туннель."
  fi
}

# ------------------------------------------------------------------- up

cmd_up() {
  need_tools
  auth

  say "${BOLD}1/$STEPS${OFF} проверяю, что всё готово"
  # Адрес проверяется первым делом, до ключей и до счёта: он единственный, чью
  # негодность видно, не потратив ни секунды аренды.
  check_host_ready
  [ -f "$SSH_KEY" ] || die "нет ключа $SSH_KEY.
  Заведите: ssh-keygen -t ed25519 — или укажите свой строкой VAST_SSH_KEY в .env"
  [ -f "$SSH_KEY.pub" ] || die "рядом с $SSH_KEY нет $SSH_KEY.pub — публичной половины."

  # Ключ должен стоять в аккаунте ДО аренды. У виртуалок ключи на работающей
  # машине не меняются — это сказано в документации vast прямым текстом, — то
  # есть машина, арендованная без ключа, это машина, в которую нельзя войти, и
  # деньги за неё уже идут. Отказаться сейчас дешевле.
  local mine keys registered
  mine="$(awk '{print $1" "$2}' "$SSH_KEY.pub")"
  keys="$(api GET "ssh/")" || die "не смог спросить vast про ssh-ключи."
  registered="$(printf '%s' "$keys" | MINE="$mine" py '
import json, os, sys
mine = os.environ["MINE"].split()
d = json.load(sys.stdin)
for k in (d if isinstance(d, list) else (d.get("results") or [])):
    # В ответе поле называется public_key, хотя в документации — key.
    v = (k.get("public_key") or k.get("key") or "").split()
    if v[:2] == mine[:2]:
        print("yes")
        break
')"
  [ -n "$registered" ] || die "ключ $SSH_KEY.pub в аккаунте vast не зарегистрирован.
  Виртуалке ключи после запуска не добавляют: арендованная без ключа машина —
  это деньги, потраченные на коробку, в которую не войти. Добавьте ключ на
  https://cloud.vast.ai/account/ — или, если стоит их CLI:
      vastai create ssh-key \"\$(cat $SSH_KEY.pub)\"
  Поставить CLI: curl -fsSL https://vast.ai/install.sh | bash"

  # Баланс. При нуле vast уничтожает инстансы вместе с диском — это второй
  # способ потерять данные, и знать о нём лучше заранее, а не в пятницу.
  local user balance
  user="$(api GET "users/current/")" || die "не смог спросить vast про счёт."
  # Печатается одно число, а не ответ целиком: в этом ответе среди прочего
  # приезжает и ключ от аккаунта.
  balance="$(printf '%s' "$user" | py '
import json, sys
d = json.load(sys.stdin)
b = d.get("credit", d.get("balance"))
print("%.2f" % float(b) if b is not None else "")
')"
  if [ -n "$balance" ]; then say "${DIM}    на счету \$$balance${OFF}"; fi

  if load_instance; then
    say "${BOLD}2/$STEPS${OFF} искать нечего: инстанс $INST_ID с меткой «${LABEL}» уже арендован"
    say "${BOLD}3/$STEPS${OFF} разворачиваюсь поверх него"
    if [ "$INST_STATUS" != running ]; then
      say "${DIM}    он сейчас «${INST_STATUS}» — поднимаю${OFF}"
      api PUT "instances/$INST_ID/" '{"state":"running"}' >/dev/null
      wait_running "$INST_ID"
      load_instance || die "инстанс $INST_ID поднялся, но по метке не находится."
    fi
  else
    say "${BOLD}2/$STEPS${OFF} ищу предложение: ${GPU_NAME:-любая карта}${GPU_RAM:+, от $GPU_RAM ГБ}, виртуалка, on-demand, до \$$MAX_PRICE/час"
    local query offers pick
    query="$(GPU_RAM="$GPU_RAM" MAX_PRICE="$MAX_PRICE" DISK="$DISK" GPU_NAME="$GPU_NAME" py '
import json, os
q = {
    # Только виртуалки: внутри docker-инстанса vast docker запрещён, а без него
    # у комнаты нет своего ядра.
    "vms_enabled": {"eq": True},
    # Только on-demand, и это не фильтр, а вид торга: interruptible вытесняют
    # посреди пары.
    "type": "ondemand",
    "rentable": {"eq": True},
    "rented": {"eq": False},
    "verified": {"eq": True},
    "reliability": {"gte": 0.98},
    "num_gpus": {"gte": 1},
    "disk_space": {"gte": float(os.environ["DISK"]) + 10},
    "dph_total": {"lte": float(os.environ["MAX_PRICE"])},
    "order": [["dph_total", "asc"]],
    # Берём с запасом, потому что драйвер отсеивается уже здесь, у нас: из
    # двадцати предложений после отсева могло не остаться ни одного.
    "limit": 60,
}
ram = os.environ.get("GPU_RAM", "").strip()
if ram:
    # Мегабайты, и порог намеренно не 24*1024: карта «на 24 ГБ» рапортует
    # 24564 МБ, и круглая степень двойки отсекла бы все 4090 разом.
    q["gpu_ram"] = {"gte": int(float(ram) * 1000)}
name = os.environ.get("GPU_NAME", "").strip()
if name:
    q["gpu_name"] = {"in": [name]}
print(json.dumps(q))
')"
    offers="$(api POST "bundles/" "$query")"
    # Первая пятёрка печатается в stderr — чтобы человек видел рынок, а не одну
    # цифру, — а выбор уходит в stdout и разбирается ниже.
    pick="$(printf '%s' "$offers" | py '
import json, sys
offers = json.load(sys.stdin).get("offers") or []
# Драйвер проверяется здесь, а не фильтром vast, — и это не вкус. Колёса torch
# собраны под CUDA 12.x и на 11.8 не поедут, но серверное условие
# cuda_max_good >= 12.1 измеримо врёт: у предложений с RTX 5070 и RTX 5090 в
# ответе стоит cuda_max_good = 13.0, а с этим условием в запросе не находится ни
# одного из них (проверено чтением, дважды подряд, 5 сентября 2026). То есть
# фильтр выбрасывал ровно те карты, ради которых машину и арендуют. Поле в
# ответе при этом верное — условие то же, применяется к ответу.
offers = [o for o in offers if float(o.get("cuda_max_good") or 0) >= 12.1]
for o in offers[:5]:
    print("    %-10s %s x %-10s %4.0f ГБ  $%.3f/час  %s" % (
        o.get("id"), o.get("num_gpus"), o.get("gpu_name"),
        # Показываем как на коробке: 24564 МБ это «24 ГБ», а не «25».
        (o.get("gpu_ram") or 0) / 1024, o.get("dph_total") or 0,
        o.get("geolocation") or ""), file=sys.stderr)
if offers:
    o = offers[0]
    print("%s\t%.3f\t%s x %s" % (o["id"], o.get("dph_total") or 0,
                                 o.get("num_gpus"), o.get("gpu_name")))
')"
    [ -n "$pick" ] || die "под эти условия ничего не нашлось.
  Искалось: карта «${GPU_NAME:-любая}», память $GPU_RAM_TEXT, до \$$MAX_PRICE/час,
  диск от $DISK ГБ.
  Ослабить разово: make vast-up GPU=\"RTX 4090\" — или насовсем, в .env:
  VAST_GPU, VAST_GPU_RAM, VAST_MAX_PRICE. Виртуалок на рынке заметно меньше, чем
  обычных инстансов, — это цена решения арендовать именно их."

    local offer_id price what
    IFS=$'\t' read -r offer_id price what <<<"$pick"
    say ""
    say "${BOLD}беру $offer_id${OFF} — $what, \$$price/час"
    say "${DIM}пара из двух часов обойдётся примерно в \$$(PRICE="$price" py '
import os; print("%.2f" % (float(os.environ["PRICE"]) * 2))')${OFF}"
    # Деньги настоящие, поэтому спрашиваем. FORCE=1 — для сценариев, где предел
    # цены задан заранее, в VAST_MAX_PRICE.
    if [ "${FORCE:-}" != 1 ]; then
      [ -t 0 ] || die "не вижу терминала, чтобы спросить. FORCE=1 — арендовать без вопроса."
      printf '%sарендовать? [y/N] %s' "$BOLD" "$OFF"
      local answer; read -r answer
      case "$answer" in y|Y|д|да) : ;; *) die "не арендую." ;; esac
    fi

    say "${BOLD}3/$STEPS${OFF} арендую"
    local create new_id
    create="$(IMAGE="$IMAGE" DISK="$DISK" LABEL="$LABEL" py '
import json, os
print(json.dumps({
    "image": os.environ["IMAGE"],
    "disk": float(os.environ["DISK"]),
    # Вот эта строка и отличает виртуалку от обычного инстанса.
    "vm": True,
    # У виртуалок vast поддерживает только ssh, и большего не нужно: наружу
    # Colloq выходит исходящим соединением через ретранслятор, поэтому ни
    # одного входящего порта, кроме ssh, мы не просим.
    "runtype": "ssh",
    "label": os.environ["LABEL"],
    "target_state": "running",
    # Предложение могли снять между поиском и арендой. Пусть отказ будет сразу
    # и явный, а не машина, которая «когда-нибудь запустится».
    "cancel_unavail": True,
}))
')"
    new_id="$(api PUT "asks/$offer_id/" "$create" | py '
import json, sys
# Номер инстанса приезжает полем new_contract, а не id: id здесь — это номер
# предложения, и перепутать их значит опрашивать потом чужую машину.
print(json.load(sys.stdin).get("new_contract") or "")')"
    [ -n "$new_id" ] || die "vast не сказал, что арендовал.
  Загляните на https://cloud.vast.ai/instances/ — если машина всё же появилась,
  повторите make vast-up: он развернётся поверх неё."
    say "${DIM}    инстанс $new_id${OFF}"
    wait_running "$new_id"
    load_instance || die "инстанс $new_id арендован, но по метке не находится.
  Загляните на https://cloud.vast.ai/instances/"
  fi

  say "${BOLD}4/$STEPS${OFF} жду ssh"
  [ -n "$INST_SSH_HOST" ] && [ -n "$INST_SSH_PORT" ] \
    || die "vast ещё не назвал адрес ssh. Повторите через минуту: make vast-up"
  say "${DIM}    ssh root@$INST_SSH_HOST -p $INST_SSH_PORT${OFF}"
  local waited=0
  until rssh true </dev/null 2>/dev/null; do
    waited=$((waited + 5))
    [ "$waited" -lt 600 ] || die "ssh на машину не отвечает десять минут.
  Тот ли ключ зарегистрирован в аккаунте? Проверить руками:
      ssh -i $SSH_KEY -p $INST_SSH_PORT root@$INST_SSH_HOST"
    sleep 5
  done

  say "${BOLD}5/$STEPS${OFF} ставлю docker и переношу Colloq"
  rssh "FRP_VERSION='$FRP_VERSION' REMOTE_DIR='$REMOTE_DIR' bash -s" <<'REMOTE'
set -euo pipefail
export DEBIAN_FRONTEND=noninteractive

echo "== пакеты"
apt-get update -qq
# rsync ставится здесь, а не позже: им же копируется репозиторий, и без него на
# той стороне копирование падает на первом же вызове. sqlite3 — для восстановления
# базы, tmux — чтобы туннель пережил закрытый ноутбук.
# dnsutils — ради host.sh: он проверяет поднятый адрес через dig и без него
# откатывается на системный резолвер, который в этой самой проверке и врёт.
apt-get install -y -qq rsync make git curl tar tmux sqlite3 dnsutils ca-certificates gnupg >/dev/null

echo "== docker"
if ! command -v docker >/dev/null; then
  curl -fsSL https://get.docker.com | sh >/dev/null
fi
systemctl enable --now docker >/dev/null 2>&1 || true
docker --version

echo "== gpu"
if command -v nvidia-smi >/dev/null 2>&1; then
  nvidia-smi --query-gpu=index,name,memory.total --format=csv,noheader || true
  # Драйвер на машине есть, но без nvidia-container-toolkit docker карту в
  # контейнер не отдаёт: ядро комнаты поднимется без CUDA, и узнают об этом по
  # torch.cuda.is_available() == False уже на паре. Репозиторий — тот, что
  # описан у NVIDIA; на живой аренде этот путь не проверялся ни разу.
  if ! docker info 2>/dev/null | grep -qi nvidia; then
    curl -fsSL https://nvidia.github.io/libnvidia-container/gpgkey \
      | gpg --dearmor -o /usr/share/keyrings/nvidia-container-toolkit-keyring.gpg
    curl -fsSL https://nvidia.github.io/libnvidia-container/stable/deb/nvidia-container-toolkit.list \
      | sed 's#deb https://#deb [signed-by=/usr/share/keyrings/nvidia-container-toolkit-keyring.gpg] https://#g' \
      > /etc/apt/sources.list.d/nvidia-container-toolkit.list
    apt-get update -qq
    apt-get install -y -qq nvidia-container-toolkit >/dev/null
    nvidia-ctk runtime configure --runtime=docker >/dev/null
    systemctl restart docker
  fi
else
  echo "  nvidia-smi нет — карты этой машине не досталось"
fi

echo "== frpc ${FRP_VERSION}"
# Тот же frp, что стоит на ретрансляторе, только клиентская половина: без неё
# `make host` на этой машине откажется, а Cloudflare из России не открывается.
if [ ! -x /usr/local/bin/frpc ]; then
  tmp=$(mktemp -d)
  curl -fsSL "https://github.com/fatedier/frp/releases/download/v${FRP_VERSION}/frp_${FRP_VERSION}_linux_amd64.tar.gz" \
    | tar -xz -C "$tmp" --strip-components=1
  install -m 0755 "$tmp/frpc" /usr/local/bin/frpc
  rm -rf "$tmp"
fi
frpc --version

mkdir -p "$REMOTE_DIR"
REMOTE

  # Что едет на машину, а что остаётся здесь. Список тот же, что в
  # .dockerignore, и по той же причине: node_modules и .git — это сотни
  # мегабайт пересылки, а data/ и workspace/ приезжают отдельно, снятой копией.
  local excl; excl="$(mktemp -t colloq-vast-excl.XXXXXX)"; TMPS+=("$excl")
  cat > "$excl" <<'EXCL'
node_modules/
.git/
data/
workspace/
backups/
dist/
.env
.env.local
*.log
*.png
.colloq.pid
.colloq.log
.DS_Store
kernel/environments/.*.built
EXCL
  rsync -az --delete --exclude-from="$excl" -e "$(ssh_cmd)" \
    ./ "root@$INST_SSH_HOST:$REMOTE_DIR/"

  # .env едет без ключей, которыми расплачиваются: VAST_TOKEN снимает деньги с
  # карты, CF_* правит зону colloq.ru. Ни то, ни другое семинару не нужно, а
  # машина чужая. Всё остальное — RELAY_*, ключ оракула, SESSION_SECRET — едет
  # как есть: секреты здесь не перевыпускаются, иначе разосланные ссылки на
  # семинары и вход в панель после переезда перестанут работать.
  local tmpenv; tmpenv="$(mktemp -t colloq-vast-env.XXXXXX)"; TMPS+=("$tmpenv")
  grep -vE '^(VAST_[A-Z_]+|CF_[A-Z_]+|PUBLIC_URL)=' .env > "$tmpenv"
  # PUBLIC_URL там свой: его поставит `make host`, когда откроет туннель.
  # Уехавший отсюда адрес чужого туннеля раздал бы аудитории ссылку на ноутбук,
  # которого в этой аудитории нет.
  printf 'PUBLIC_URL=http://localhost:%s\n' "$PORT" >> "$tmpenv"
  # mktemp сделал файл с правами 0600, rsync -a их сохраняет: в .env лежит ключ
  # оракула и ключ подписи, и на той стороне они должны лежать так же.
  rsync -a -e "$(ssh_cmd)" "$tmpenv" "root@$INST_SSH_HOST:$REMOTE_DIR/.env"

  local db files
  db="$(last_backup)"
  if [ -n "$db" ]; then
    say "${DIM}    везу копию: $(basename "$db")${OFF}"
    rssh "mkdir -p $REMOTE_DIR/backups" </dev/null
    rsync -a -e "$(ssh_cmd)" "$db" "root@$INST_SSH_HOST:$REMOTE_DIR/backups/"
    files="${db%.db}-files.tar.gz"
    if [ -f "$files" ]; then
      rsync -a -e "$(ssh_cmd)" "$files" "root@$INST_SSH_HOST:$REMOTE_DIR/backups/"
    else
      say "${DIM}    архива файлов рядом нет — приедет только база${OFF}"
    fi
  else
    say "${DIM}    копии в backups/ нет — машина поднимется пустой${OFF}"
  fi

  say "${BOLD}6/$STEPS${OFF} восстанавливаю данные и поднимаю Colloq"
  rssh "cd $REMOTE_DIR && bash -s" <<'REMOTE'
set -euo pipefail

# Восстановление ДО подъёма: sqlite держит открытым тот файл, который открыл, и
# подменить базу под работающим сервером значит писать в удалённый файл, а на
# экране видеть вчерашнее.
#
# И только на пустой машине. Повторный заход на уже развёрнутую — это обычное
# дело (упал туннель, сменилось имя, доехала правка кода), и разворачивать
# поверх работающей комнаты вчерашнюю копию нельзя: она моложе того, что в
# комнате уже напечатали. Раньше здесь падал весь заход — restore.sh честно
# отказывался работать под живым сервером, и до выставления наружу дело не
# доходило.
# Порт спрашивается у .env этой машины, а не подставляется отсюда: heredoc
# уехал в кавычках, здешние переменные в нём не раскрываются, а инстанс с
# PORT=4000 проверялся бы по чужому порту и «не отвечает» говорил бы про живой.
port_here="$(grep -E '^PORT=' .env 2>/dev/null | head -1 | cut -d= -f2 | tr -dc '0-9')"
if curl -sf -o /dev/null --max-time 3 "http://localhost:${port_here:-3000}/api/health" 2>/dev/null; then
  echo "colloq здесь уже работает — копию не разворачиваю, это не пустая машина"
elif ls backups/colloq-*.db >/dev/null 2>&1; then
  bash scripts/restore.sh
else
  echo "восстанавливать нечего — начинаем с пустой базы"
fi

# Какие устройства отдавать комнатам. Список — в том виде, в каком его понимает
# docker; на арендованной машине это просто номера карт. Нет строки или строка
# пуста — прежнее поведение: GPU не просит никто.
if ! grep -qE '^KERNEL_GPUS=' .env 2>/dev/null; then
  gpus="$(nvidia-smi --query-gpu=index --format=csv,noheader 2>/dev/null | paste -sd, - || true)"
  if [ -n "$gpus" ]; then
    printf '\n# Карты этой машины. Срез достаётся комнате, чьё окружение объявлено\n# строкой «# colloq: gpu» в шапке kernel/environments/<имя>.txt.\nKERNEL_GPUS=%s\n' "$gpus" >> .env
    echo "KERNEL_GPUS=$gpus"
  fi
fi

make up
REMOTE

  local hosted=""
  if [ -n "$WANT_HOST" ]; then
    say "${BOLD}7/$STEPS${OFF} выставляю наружу на $WANT_HOST"
    # Отказ этого шага не отменяет предыдущих: машина арендована, Colloq на ней
    # работает. Поэтому ветка, а не die, — иначе человек, уже заплативший за
    # машину, не увидел бы даже строчки ssh, по которой на неё войти.
    if rssh "REMOTE_DIR='$REMOTE_DIR' WANT_HOST='$WANT_HOST' TMUX_SESSION='$TMUX_SESSION' PORT='$PORT' bash -s" <<'REMOTE'
set -euo pipefail
cd "$REMOTE_DIR"

# host.sh отказывается открывать туннель поверх нездорового инстанса — и
# правильно делает. Но `make up` возвращается, как только compose принял
# команду, а ядро поднимается ещё с полминуты: без этого ожидания «одна команда
# на всё занятие» разваливалась бы гонкой, причём через раз.
ok=""
for _ in $(seq 1 40); do
  if curl -sf -o /dev/null --max-time 5 "http://localhost:$PORT/api/health"; then ok=1; break; fi
  sleep 3
done
[ -n "$ok" ] || {
  echo "colloq на этой машине не отвечает на localhost:$PORT — туннель открывать не на что" >&2
  exit 1
}

# Прежняя сессия убирается до новой. Ретранслятор не пускает второй frpc с тем
# же поддоменом («already exists»), и повторный vast-up получал бы отказ от
# собственного, ещё живого туннеля — самый обидный вид «занято».
tmux kill-session -t "$TMUX_SESSION" 2>/dev/null || true

# Туннель живёт ровно столько, сколько живёт `make host`. Запущенный прямо в
# ssh-сессии, он умер бы вместе с ней — то есть в ту секунду, когда закрыли
# ноутбук. Журнал пишется рядом: когда адрес не отвечает, смотреть будут его.
tmux new-session -d -s "$TMUX_SESSION" \
  "cd '$REMOTE_DIR' && make host HOST='$WANT_HOST' 2>&1 | tee -a host.log"
sleep 2
tmux has-session -t "$TMUX_SESSION" 2>/dev/null || {
  echo "tmux-сессия $TMUX_SESSION не завелась" >&2
  tail -20 host.log 2>/dev/null >&2 || true
  exit 1
}
REMOTE
    then
      # Ждём не «tmux запустился», а ответа самого адреса: между ними frpc,
      # ретранслятор и перезапуск приложения с новым PUBLIC_URL. Потолок — три
      # минуты: дольше это уже не «поднимается», а «не поднялось».
      say "${DIM}    жду ответа с $WANT_HOST${OFF}"
      waited=0
      while [ "$waited" -lt 180 ]; do
        if host_health; then hosted=1; break; fi
        sleep 5; waited=$((waited + 5))
      done
      if [ -z "$hosted" ]; then
        say "${RED}    $WANT_HOST не ответил за три минуты — ссылку не печатаю${OFF}"
      fi
    fi

    if [ -z "$hosted" ]; then
      local pane
      # Сессии может уже и не быть: при отказе ретранслятора `make host` умирает
      # сразу, а с ним кончается и окно. Ради этого случая он и пишет в host.log
      # — журнал переживает сессию, и смотреть тогда надо в него.
      pane="$(rssh "if tmux has-session -t $TMUX_SESSION 2>/dev/null; then tmux capture-pane -pt $TMUX_SESSION -S -60; else tail -30 $REMOTE_DIR/host.log 2>/dev/null; fi | grep -v '^\$' | tail -12" </dev/null 2>/dev/null || true)"
      if [ -n "$pane" ]; then
        say "${DIM}    последнее оттуда:${OFF}"
        printf '%s\n' "$pane" | sed 's/^/      /'
      fi
      say "${DIM}    смотреть дальше:${OFF}"
      say "${DIM}      журнал сессии     ssh -i $SSH_KEY -p $INST_SSH_PORT root@$INST_SSH_HOST 'tmux capture-pane -pt $TMUX_SESSION -S -200'${OFF}"
      say "${DIM}      он же на диске    ssh … 'tail -40 $REMOTE_DIR/host.log'${OFF}"
      say "${DIM}      RELAY_* на машине ssh … 'grep RELAY_ $REMOTE_DIR/.env'${OFF}"
      say "${DIM}      резолвится ли имя dig +short $WANT_HOST @1.1.1.1${OFF}"
      say "${DIM}    Colloq при этом работает — не отвечает именно адрес наружу.${OFF}"
    fi
  fi

  printf '\n'
  say "${BOLD}Colloq поднят на арендованной машине${OFF}"
  say "  ${CYAN}ssh -i $SSH_KEY -p $INST_SSH_PORT root@$INST_SSH_HOST${OFF}"
  printf '\n'
  if [ -n "$hosted" ]; then
    say "${BOLD}Ссылка для аудитории${OFF}"
    say "  ${CYAN}${BOLD}https://$WANT_HOST${OFF}"
    say "  ${DIM}Туннель держит tmux-сессия «${TMUX_SESSION}» на той машине: он${OFF}"
    say "  ${DIM}переживёт закрытый ноутбук, но не уничтожение машины.${OFF}"
    # Ссылку с токеном не забираем сюда и не печатаем: это ключ от инстанса, и
    # чем меньше экранов и журналов он прошёл, тем лучше. Показываем, где взять.
    say "  ${DIM}Вход в панель — ссылка с токеном напечатана в самой сессии:${OFF}"
    say "  ${DIM}  ssh … 'tmux capture-pane -pt $TMUX_SESSION -S -200' | grep /admin/t/${OFF}"
  elif [ -n "$WANT_HOST" ]; then
    # Отдельная ветка, а не общая подсказка: человеку, у которого адрес только
    # что не поднялся, объяснять «наружу — оттуда» поздно. Ему нужно одно —
    # чем повторить. Повтор безопасен: машина уже арендована, и vast-up
    # развернётся поверх неё, а не возьмёт вторую.
    say "${BOLD}Адрес не подтверждён${OFF} ${DIM}— куда смотреть, сказано выше${OFF}"
    say "  ${DIM}повторить, не арендуя ничего заново: make vast-up HOST=$WANT_HOST${OFF}"
  else
    say "${BOLD}Наружу — оттуда, а не отсюда${OFF} ${DIM}(семинар считается там, где стоит ядро)${OFF}"
    if [ -n "$RELAY_DOMAIN" ]; then
      say "  ${CYAN}make vast-up HOST=<имя>.$RELAY_DOMAIN${OFF} ${DIM}— отсюда, одной командой${OFF}"
      say "  ${DIM}или руками на машине: cd $REMOTE_DIR && make host HOST=<имя>.$RELAY_DOMAIN${OFF}"
    else
      say "  ${CYAN}cd $REMOTE_DIR && make host${OFF}"
      say "  ${DIM}без RELAY_* в .env это Cloudflare, а его адреса из России не${OFF}"
      say "  ${DIM}открываются — см. make relay-setup и раздел README про ретранслятор${OFF}"
    fi
    say "  ${DIM}Руками команда держит окно: туннель живёт, пока она работает.${OFF}"
    say "  ${DIM}Закрываете ноутбук — запускайте её в tmux: tmux new -s $TMUX_SESSION${OFF}"
  fi
  printf '\n'
  say "${DIM}Окружение с картой собирается там же: make env-build NAME=gpu${OFF}"
  say "${DIM}Данные оттуда: make vast-sync · уничтожить машину: make vast-down${OFF}"
  say "${RED}Всё, что на этой машине, живёт ровно до её уничтожения.${OFF}"
}

# --------------------------------------------------------------- status

cmd_status() {
  need_tools
  auth
  local db s
  db="$(last_backup)"
  if ! load_instance; then
    say "${DIM}на vast.ai ничего не арендовано${OFF} ${DIM}(метка «${LABEL}»)${OFF}"
    say "${DIM}арендовать: make vast-up${OFF}"
    if [ -n "$db" ]; then say "${DIM}последняя копия здесь: $(backup_age "$db")${OFF}"; fi
    return 0
  fi
  printf '%sинстанс %s%s %s· %s · %s x %s · $%s/час%s\n' \
    "$BOLD" "$INST_ID" "$OFF" "$DIM" "$INST_STATUS" "$INST_NGPU" "$INST_GPU" "$INST_DPH" "$OFF"
  if [ -n "$INST_MSG" ]; then say "${DIM}  $INST_MSG${OFF}"; fi
  s="$(spent)"
  if [ -n "$s" ]; then say "${DIM}  работает $s${OFF}"; fi
  if [ -n "$INST_SSH_HOST" ]; then
    say "${DIM}  ssh -i $SSH_KEY -p $INST_SSH_PORT root@$INST_SSH_HOST${OFF}"
  fi
  # «running» — это про виртуалку, а не про семинар: контейнеры на ней могли и
  # не подняться, и разница видна только отсюда.
  if [ "$INST_STATUS" = running ] && [ -n "$INST_SSH_HOST" ]; then
    if rssh "curl -sf -m 5 http://localhost:$PORT/api/health >/dev/null" </dev/null 2>/dev/null; then
      say "  ${CYAN}colloq на той машине отвечает${OFF}"
    else
      say "  ${RED}colloq на той машине не отвечает${OFF} ${DIM}(cd $REMOTE_DIR && make logs)${OFF}"
    fi

    # Адрес наружу — отдельный вопрос, и спрашивать его надо отдельно: «colloq
    # отвечает» верно и тогда, когда туннель давно умер, а видно это только
    # снаружи. Спрашиваем машину о двух вещах разом (жива ли сессия и какой
    # адрес она успела вписать в .env) и проверяем этот адрес отсюда.
    local info alive public name
    info="$(rssh "cd $REMOTE_DIR 2>/dev/null && { tmux has-session -t $TMUX_SESSION >/dev/null 2>&1 && echo alive || echo dead; grep -E '^PUBLIC_URL=' .env 2>/dev/null | tail -1 | cut -d= -f2-; }" </dev/null 2>/dev/null || true)"
    alive="$(printf '%s\n' "$info" | sed -n 1p | tr -d ' \r')"
    public="$(printf '%s\n' "$info" | sed -n 2p | tr -d ' \r')"
    name="${public#https://}"
    case "$public" in
      https://*)
        # Имя приехало с арендованной машины, а не от человека, поэтому в curl
        # оно идёт только после той же проверки на посторонние знаки.
        case "$name" in *[!A-Za-z0-9.-]*) name="" ;; esac
        if [ -n "$name" ]; then
          WANT_HOST="$name"
          if command -v dig >/dev/null 2>&1; then HOST_IP="$(resolve_host "$name" || true)"; fi
          if host_health; then
            say "  ${CYAN}снаружи отвечает${OFF} ${BOLD}$public${OFF}"
          else
            say "  ${RED}$public снаружи не отвечает${OFF}"
          fi
        fi
        if [ "$alive" != alive ]; then
          say "  ${DIM}tmux-сессии «${TMUX_SESSION}» на машине нет — держать туннель некому${OFF}"
          say "  ${DIM}поднять снова: make vast-up HOST=${name:-<имя>}${OFF}"
        fi ;;
      *)
        if [ "$alive" = alive ]; then
          say "  ${DIM}туннель «${TMUX_SESSION}» поднимается — адреса в .env ещё нет${OFF}"
        else
          say "  ${DIM}наружу не выставлен${OFF} ${DIM}(make vast-up HOST=<имя>${RELAY_DOMAIN:+.$RELAY_DOMAIN})${OFF}"
        fi ;;
    esac
  fi
  if [ -n "$db" ]; then
    say "${DIM}последняя копия здесь: $(backup_age "$db")${OFF}"
  else
    say "${RED}копий здесь нет вовсе${OFF} ${DIM}— снять: make vast-sync${OFF}"
  fi
}

# ----------------------------------------------------------------- sync

cmd_sync() {
  need_tools
  auth
  load_instance || die "с меткой «${LABEL}» на vast.ai ничего не арендовано — снимать не с чего."
  [ "$INST_STATUS" = running ] || die "инстанс $INST_ID сейчас «${INST_STATUS}».
  Снять данные можно только с работающей машины: поднимите её (make vast-up)
  и повторите."

  say "${BOLD}1/2${OFF} снимаю копию на арендованной машине"
  # Копия делается ТАМ, а не копированием файла базы сюда: в режиме WAL
  # половина дня лежит в журнале рядом, и файл, скопированный на ходу,
  # отстаёт на часы. `make backup` пишет согласованный снимок и не требует
  # останавливать семинар.
  rssh "cd $REMOTE_DIR && make backup" </dev/null

  say "${BOLD}2/2${OFF} забираю сюда"
  mkdir -p backups
  local newest
  newest="$(rssh "ls -1t $REMOTE_DIR/backups/colloq-*.db 2>/dev/null | head -1" </dev/null || true)"
  [ -n "$newest" ] || die "на той машине копия не появилась.
  Посмотрите руками: ssh … 'cd $REMOTE_DIR && make backup'"
  rsync -a -e "$(ssh_cmd)" "root@$INST_SSH_HOST:$newest" backups/ \
    || die "база не приехала — не считайте данные снятыми."
  # Отдельным вызовом, а не вторым источником в предыдущем: там, где архива
  # файлов нет, rsync с двумя источниками уронил бы и уже приехавшую базу в
  # общий отказ, и «что именно не снялось» пришлось бы выяснять руками.
  rsync -a -e "$(ssh_cmd)" "root@$INST_SSH_HOST:${newest%.db}-files.tar.gz" backups/ \
    || die "база приехала, а файлы семинаров — нет.
  Это половина копии: тетради и настройки на месте, загруженные файлы остались
  только на арендованной машине. Повторите make vast-sync до make vast-down."

  printf '\n'
  say "${BOLD}приехало${OFF}"
  say "  $(basename "$newest") ${DIM}— база: семинары, преподаватели, история версий, оракул${OFF}"
  say "  $(basename "${newest%.db}-files.tar.gz") ${DIM}— файлы семинаров, ключ подписи, токен установки${OFF}"
  say "${DIM}Не приехали собранные образы окружений: их дешевле пересобрать${OFF}"
  say "${DIM}(make env-build NAME=…), чем возить десятки гигабайт.${OFF}"
  say "${DIM}Развернуть это на пустой машине: make restore${OFF}"
}

# ----------------------------------------------------------------- down

cmd_down() {
  need_tools
  auth
  load_instance || { say "${DIM}с меткой «${LABEL}» на vast.ai ничего не арендовано${OFF}"; return 0; }

  local s db answer
  s="$(spent)"; db="$(last_backup)"
  printf '\n'
  say "${BOLD}уничтожить инстанс $INST_ID${OFF} ${DIM}($INST_NGPU x $INST_GPU, \$$INST_DPH/час${s:+, $s})${OFF}"
  say "${RED}Исчезнет всё, что на этой машине:${OFF} база с семинарами, файлы семинаров,"
  say "собранные образы окружений. У vast нет ни корзины, ни снимков."
  if [ -n "$db" ]; then
    say "${DIM}последняя копия здесь: $(backup_age "$db")${OFF}"
  else
    say "${RED}копий здесь нет вовсе.${OFF} ${DIM}Снять: make vast-sync${OFF}"
  fi

  if [ "${FORCE:-}" != 1 ]; then
    [ -t 0 ] || die "не вижу терминала, чтобы спросить. FORCE=1 — уничтожить без вопроса."
    printf '%sнапечатайте «уничтожить», чтобы продолжить: %s' "$BOLD" "$OFF"
    read -r answer
    [ "$answer" = "уничтожить" ] || die "не уничтожаю."
  fi

  api DELETE "instances/$INST_ID/" >/dev/null
  say "${DIM}инстанс $INST_ID уничтожен — счётчик остановлен${OFF}"
  say "${DIM}развернуть эти данные заново, здесь или на новой машине: make restore${OFF}"
}

case "$CMD" in
  up)     cmd_up ;;
  status) cmd_status ;;
  sync)   cmd_sync ;;
  down)   cmd_down ;;
  *)
    say "${BOLD}Colloq на арендованной машине${OFF}"
    say "  scripts/vast.sh up      ${DIM}найти виртуалку, арендовать, развернуть Colloq${OFF}"
    say "  ${DIM}HOST=demo.colloq.ru    ... и сразу выставить наружу на этом адресе${OFF}"
    say "  ${DIM}GPU=\"RTX 5070\"         ... на карте, названной вслух${OFF}"
    say "  scripts/vast.sh status  ${DIM}что арендовано, живо ли оно и сколько натикало${OFF}"
    say "  scripts/vast.sh sync    ${DIM}снять данные оттуда сюда${OFF}"
    say "  scripts/vast.sh down    ${DIM}уничтожить машину вместе со всем, что на ней${OFF}"
    say ""
    say "${DIM}то же через make: make vast-up · vast-status · vast-sync · vast-down${OFF}"
    if [ -n "$CMD" ]; then die "не знаю команды «${CMD}»."; fi
    ;;
esac
