#!/usr/bin/env bash
# Vast VM rental and release deployment. Example:
# RELEASE=/path/release.json NAME=hse HOST=hse.colloq.ru scripts/vast.sh up
#
# Only VM-capable on-demand offers are selected. An explicit release manifest
# determines immutable application images and the exact committed deployment
# tools. No mutable working-tree source or billing/DNS credentials are copied.
# Existing instance naming, direct SSH, price and destruction confirmations
# remain in this script. Data lives on the VM disk (Vast Volumes do not support
# VMs); sync exports a validated portable backup for this environment only.
# MODE=live is SQLite-consistent with changing filesystem files. MODE=consistent
# stops all writers, including room kernels; RESUME=1 explicitly restarts them.
# Legacy service/compose hosts require an explicit migration, never an overlay.
# Full operator instructions: docs/deployment-vast.md.
set -euo pipefail

cd "$(dirname "$0")/.."

RED=$'\033[31m'; DIM=$'\033[2m'; BOLD=$'\033[1m'; CYAN=$'\033[36m'; OFF=$'\033[0m'
say() { printf '%s\n' "$*"; }
die() { printf '%s%s%s\n' "$RED" "$*" "$OFF" >&2; exit 1; }

# JSON разбирает python3, а не jq: jq на macOS по умолчанию нет, а python3 уже
# нужен scripts/dns.sh. Разбираемое приезжает функции на stdin.
py() { python3 -c "$1"; }

# read_env — общий для всех скриптов, scripts/lib.sh. Здесь это особенно
# заметно: имена карт в API vast пишутся с пробелом («RTX 4090»), и прежняя
# копия превращала VAST_GPU из .env в «RTX4090», под который предложений нет.
. ./scripts/lib.sh

# Разделитель полей в таблице инстансов — см. instances_tsv.
SEP=$'\037'

API=https://console.vast.ai/api/v0
CMD="${1:-}"
[ "$#" -eq 0 ] || shift
POSITION_NAME=""
REGISTRY_OPTION=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    --registry-config) [ "$#" -ge 2 ] || die '--registry-config requires a JSON file'; REGISTRY_OPTION="$2"; shift 2;;
    --*) die "unknown option: $1";;
    *) [ -z "$POSITION_NAME" ] || die 'only one environment name is allowed'; POSITION_NAME="$1"; shift;;
  esac
done

[ -f .env ] || die "нет .env — сделайте его: make up (или cp .env.example .env)."

# Метка на инстансе. Ею — и только ею — скрипт потом находит арендованную
# машину: переменная в памяти не переживает ни закрытый терминал, ни второй
# ноутбук, а метка живёт на стороне vast. К ней приписывается имя среды:
# «colloq-hse» и «colloq-demo» — две разные машины, и спутать их нельзя даже
# случайно. Голая «colloq» — безымянная среда, та самая первая машина.
LABEL_BASE="$(read_env VAST_LABEL)";    LABEL_BASE="${LABEL_BASE:-colloq}"

# Имя среды. Называют его тремя способами, и все три — одно и то же слово:
# NAME=demo, вторым аргументом (scripts/vast.sh sync demo) или первой частью
# адреса (HOST=demo.colloq.ru). Требовать NAME там, где уже назван HOST, было
# бы лишним словом: адрес и среда — одно имя, и ниже это проверяется.
ENV_NAME="${NAME:-$POSITION_NAME}"
if [ -z "$ENV_NAME" ] && [ -n "${HOST:-}" ]; then ENV_NAME="${HOST%%.*}"; fi
# Имя уходит и в метку на vast, и в путь каталога, и в адрес. Всё, что не буква,
# цифра и дефис в середине, было бы там уже не именем: «../» увело бы копии из
# backups/ куда угодно, а точка — в чужой поддомен.
case "$ENV_NAME" in
  '') : ;;
  *[!A-Za-z0-9-]*|-*|*-)
    die "имя среды «${ENV_NAME}» не годится.
  Оно же поддомен адреса и хвост метки на vast, поэтому годятся буквы, цифры и
  дефис в середине: NAME=demo, NAME=hse-2026." ;;
esac

# Метка и каталог копий — производные от имени, поэтому считаются вместе с ним:
# среду могли не назвать вовсе, и тогда её выберет resolve_env, уже спросив vast.
#
# Копии разложены по средам: backups/hse/ и backups/demo/. Раньше всё
# сваливалось в backups/ вперемешку, а разворачивалось «последнее» — при двух
# средах это прямая дорога положить базу одного семинара в комнату другого.
# Корень backups/ остаётся за безымянной средой: туда же пишет локальный
# `make backup`, и именованная среда этих файлов не видит вовсе.
use_env() {
  LABEL="$LABEL_BASE${ENV_NAME:+-$ENV_NAME}"
  BACKUP_DIR="backups${ENV_NAME:+/$ENV_NAME}"
  # Хвост для подсказок в сообщениях. У безымянной среды его нет вовсе: советуя
  # «NAME=» пустым, мы советовали бы опечатку. А у названной он обязан быть в
  # каждой подсказке — «повторите make vast-up» без имени при двух средах это
  # совет, который уводит не туда.
  NAME_ARG="${ENV_NAME:+ NAME=$ENV_NAME}"
}
use_env

# again КОМАНДА [ИМЯ=ЗНАЧЕНИЕ…] — как повторить команду, строкой для подсказки.
#
# `make vast-*` выбирает скрипт по одному признаку — RELEASE (Makefile ·
# VAST_SCRIPT): есть — этот, нет — прежний scripts/vast-legacy.sh. Подсказки
# здесь были голыми «make vast-sync NAME=hse», и без RELEASE такая строка
# уводила k3s-машину в прежний путь: legacy-sync зовёт там `make
# backup-legacy`, а под релизом на машине нет ни Makefile, ни data/colloq.db,
# и копия не снимается вовсе; legacy-up раскатывает рабочее дерево и службу
# systemd на машину, где стоит релиз. Поэтому: RELEASE известен — make с ним
# же, тем путём, каким сюда и пришли; не известен — сам скрипт, мимо
# переключателя. `up` без релиза не работает вовсе, и его подсказка называет
# RELEASE вслух.
#
# Аргументы — готовые пары вроде «NAME=hse» или «$NAME_ARG» (ведущий пробел
# срезается, пустые пропускаются): у make это его переменные, у скрипта —
# окружение перед именем, как и читает их этот файл.
again() {
  local cmd="$1" args="" a
  shift
  for a in "$@"; do
    a="${a# }"
    [ -z "$a" ] || args="$args $a"
  done
  if [ -n "${RELEASE:-}" ]; then
    printf 'make vast-%s%s RELEASE=%q' "$cmd" "$args" "$RELEASE"
  elif [ "$cmd" = up ]; then
    printf 'make vast-up%s RELEASE=/path/release.json' "$args"
  else
    printf '%sscripts/vast.sh %s' "${args:+${args# } }" "$cmd"
  fi
}
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
PORT=30080 # k3s application NodePort, bound to loopback only

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

INST_NAME=""; INST_ID=""; INST_STATUS=""; INST_SSH_HOST=""; INST_SSH_PORT=""
INST_DPH=""; INST_GPU=""; INST_NGPU=""; INST_START=""; INST_MSG=""

# Наши инстансы, по строке на каждый: имя среды, id, состояние, ssh-хост,
# ssh-порт, $/час, карта, сколько карт, старт, сообщение. С аргументом — только
# инстансы с этой меткой, без аргумента — все наши среды разом, и безымянная
# среди них (у неё пустое первое поле).
#
# Поля разделены \037 (символ «разделитель полей»), а не табуляцией, и это не
# педантизм. Табуляция — пробельный символ, а `read` с пробельным IFS съедает
# ведущие разделители и склеивает подряд идущие: строка безымянной среды
# начинается ровно с пустого поля, и её первой же попыткой разобрать имя
# оказывалось id, состоянием — адрес, ценой — карта. Проверено на выдуманном
# ответе vast: с табуляцией таблица сред разъезжается на первой же строке.
#
# Отказ самого vast и «инстансов нет» — разные вещи, и путать их здесь нельзя:
# из «нет» команда up делает вывод «надо арендовать», и молчаливая ошибка сети
# обернулась бы второй арендованной машиной рядом с первой. Поэтому каждый шаг
# проверяется явно, а не оставляется на set -e: load_instance зовут в условии
# `if`, где set -e не действует.
instances_tsv() {
  local raw out
  raw="$(api GET "instances/")" || die "не смог спросить vast про инстансы."
  out="$(printf '%s' "$raw" | WANT="${1:-}" BASE="$LABEL_BASE" py '
import json, os, sys
base = os.environ["BASE"]
want = os.environ.get("WANT") or ""
rows = []
for i in (json.load(sys.stdin).get("instances") or []):
    label = i.get("label") or ""
    # Чужие инстансы этого аккаунта нас не касаются вовсе, а свои различаются
    # хвостом метки: «colloq» — безымянная среда, «colloq-hse» — среда hse.
    if label == base:
        name = ""
    elif label.startswith(base + "-"):
        name = label[len(base) + 1:]
    else:
        continue
    if want and label != want:
        continue
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
    cols = ("dph_total", "gpu_name", "num_gpus", "start_date", "status_msg")
    cells = [name, str(i.get("id") or ""), str(i.get("actual_status") or ""),
             host, str(port)]
    cells += [str(i.get(c) if i.get(c) is not None else "") for c in cols]
    # Строка разбирается на той стороне через IFS и read: перевод строки в
    # status_msg (а он там бывает многострочный) обрубил бы всё, что за ним.
    rows.append("\x1f".join(
        c.replace("\x1f", " ").replace("\t", " ").replace("\n", " ") for c in cells))
print("\n".join(sorted(rows)))
')" || die "не понял ответ vast про инстансы."
  printf '%s' "$out"
}

# Сколько строк в таблице сред. Пустая строка — это ноль, а не одна.
env_count() { printf '%s\n' "$1" | grep -c . || true; }

# Находит инстанс текущей среды по метке; возвращает 1, если такого нет.
load_instance() {
  local lines line
  lines="$(instances_tsv "$LABEL")"
  [ -n "$lines" ] || { clear_instance; return 1; }
  if [ "$(env_count "$lines")" -gt 1 ]; then
    say "${DIM}машин с меткой «${LABEL}» больше одной — беру первую${OFF}" >&2
  fi
  line="$(printf '%s\n' "$lines" | head -1)"
  IFS=$'\037' read -r INST_NAME INST_ID INST_STATUS INST_SSH_HOST INST_SSH_PORT \
    INST_DPH INST_GPU INST_NGPU INST_START INST_MSG <<<"$line"
  return 0
}

# «Не нашлось» обязано стирать за собой: INST_ID от прошлого, чужого поиска —
# это ssh и rsync в чужую машину, самая дорогая из возможных опечаток.
clear_instance() {
  INST_NAME=""; INST_ID=""; INST_STATUS=""; INST_SSH_HOST=""; INST_SSH_PORT=""
  INST_DPH=""; INST_GPU=""; INST_NGPU=""; INST_START=""; INST_MSG=""
}

# Как среда называется вслух. Безымянная — та самая первая машина с меткой
# «colloq»: у неё имени нет, и врать, что есть, нельзя.
env_title() { printf '%s' "${1:-без имени}"; }

# Список сред. Им отвечает `status` без имени, и им же заканчивается отказ
# опасной команды: «назовите среду», не показав, какие есть, — это предложение
# угадать.
print_envs() {
  local lines="$1" name id st host port dph gpu ngpu start msg s db dir title
  # Свои WANT_HOST и HOST_IP: host_health читает их из глобальных, а таблицу
  # печатают в том числе посреди `up`, где глобальный WANT_HOST — это адрес,
  # ради которого всё и затевалось. Затереть его здесь значило бы выставить
  # наружу не то имя.
  local WANT_HOST HOST_IP
  while IFS=$'\037' read -r name id st host port dph gpu ngpu start msg; do
    [ -n "$id" ] || continue
    s="$(spent "$start" "$dph")"
    title="$(env_title "$name")"
    # Пробелы досыпаем сами: printf считает ширину в БАЙТАХ, а «без имени» — это
    # девять знаков и семнадцать байт, и %-12s не выравнивает её вовсе.
    printf '  %s%s%s%*s %s%s · %s x %s · $%s/час%s%s\n' \
      "$BOLD" "$title" "$OFF" "$(( 12 > ${#title} ? 12 - ${#title} : 0 ))" "" \
      "$DIM" "$st" "$ngpu" "$gpu" "$dph" "${s:+ · $s}" "$OFF"
    if [ -n "$name" ] && [ -n "$RELAY_DOMAIN" ]; then
      # Адрес спрашивается снаружи, у самого имени, а не у машины по ssh: студенту
      # видно именно это, и «инстанс работает» про это ничего не говорит.
      WANT_HOST="$name.$RELAY_DOMAIN"; HOST_IP=""
      if command -v dig >/dev/null 2>&1; then HOST_IP="$(resolve_host "$WANT_HOST" || true)"; fi
      if host_health; then
        printf '               %shttps://%s%s %s— отвечает%s\n' "$CYAN" "$WANT_HOST" "$OFF" "$DIM" "$OFF"
      else
        printf '               %shttps://%s — не отвечает%s\n' "$RED" "$WANT_HOST" "$OFF"
      fi
    elif [ -z "$name" ]; then
      printf '               %sбез имени — назвать: make vast-adopt NAME=<имя>%s\n' "$DIM" "$OFF"
    fi
    dir="backups${name:+/$name}"
    db="$(ls -1t "$dir"/colloq-*.db "$dir"/colloq-*-live.tar.gz "$dir"/colloq-*-consistent.tar.gz 2>/dev/null | head -1 || true)"
    if [ -n "$db" ]; then
      printf '               %sкопия здесь: %s%s\n' "$DIM" "$(backup_age "$db")" "$OFF"
    else
      printf '               %sкопий здесь нет%s %s(%s)%s\n' \
        "$RED" "$OFF" "$DIM" "$(again sync "${name:+NAME=$name}")" "$OFF"
    fi
  done <<<"$lines"
}

# Имя не назвали. Пока среда одна, это не двусмысленность, а лишнее слово:
# берём ту, что есть, и говорим вслух, какую. Как только их две, «первая
# попавшаяся» превращается в «не та» — и вот тогда отказ, со списком: снять
# данные одной среды и развернуть их в другую нельзя ни при каких
# обстоятельствах, а уничтожить чужую машину — тем более.
resolve_env() {
  local what="$1" lines n picked
  [ -z "$ENV_NAME" ] || return 0
  lines="$(instances_tsv)"
  n="$(env_count "$lines")"
  # Ничего не арендовано — среда безымянная, как и было до появления имён.
  [ "$n" -gt 0 ] || return 0
  if [ "$n" -gt 1 ]; then
    say "${RED}сред арендовано несколько — назовите, какую $what${OFF}" >&2
    print_envs "$lines" >&2
    die "например: $(again "$CMD" 'NAME=<имя>')"
  fi
  picked="$(printf '%s' "$lines" | cut -d "$SEP" -f1)"
  if [ -n "$picked" ]; then
    ENV_NAME="$picked"; use_env
    say "${DIM}среда одна — беру «${ENV_NAME}»${OFF}"
  fi
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
  $(again down "$NAME_ARG") · потом $(again up "$NAME_ARG")" ;;
    esac
    sleep 10; waited=$((waited + 10))
  done
  die "машина не дошла до running за 15 минут.
  Посмотреть: $(again status "$NAME_ARG") · уничтожить: $(again down "$NAME_ARG")"
}

# Сколько уже натикало. Не счёт, а порядок величины: vast считает по секундам и
# берёт ещё за диск, поэтому цифра нужна для решения «пора выключать», а не для
# бухгалтерии.
spent() {
  # Без аргументов — про загруженный инстанс, с ними — про строку из таблицы
  # сред: считается одинаково, а данные приезжают из двух разных мест.
  # Именно «-», а не «:-»: пустая строка из таблицы сред означает «старта нет»,
  # и подставлять вместо неё старт другого, ранее загруженного инстанса нельзя.
  local start="${1-$INST_START}" dph="${2-$INST_DPH}"
  [ -n "$start" ] && [ -n "$dph" ] || return 0
  START="$start" DPH="$dph" NOW="$(date +%s)" py '
import os
try:
    h = (float(os.environ["NOW"]) - float(os.environ["START"])) / 3600
    print("%d ч %d мин — примерно $%.2f" % (h, (h % 1) * 60, h * float(os.environ["DPH"])))
except Exception:
    pass
' 2>/dev/null || true
}

# Самая свежая копия данных ЭТОЙ среды, снятая сюда. Её дату показывают и
# `status`, и `down`: «уничтожить» без этой строки — решение вслепую. Смотрим
# только в свой подкаталог: соседская копия здесь хуже, чем никакой, — её
# развернули бы под видом своей.
last_backup() { ls -1t "$BACKUP_DIR"/colloq-*.db "$BACKUP_DIR"/colloq-*-live.tar.gz "$BACKUP_DIR"/colloq-*-consistent.tar.gz 2>/dev/null | head -1 || true; }

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
# Среда и адрес — одно имя, и разойтись им нельзя. По имени среды ищется метка
# на vast, каталог копий и адрес, который потом проверяют снаружи; среда «hse»,
# живущая на demo.colloq.ru, — это ровно та путаница, ради которой среды и
# разделяли. Отказ здесь дешёвый: он до аренды и до единого байта данных.
if [ -n "$WANT_HOST" ] && [ -n "$ENV_NAME" ] && [ "${WANT_HOST%%.*}" != "$ENV_NAME" ]; then
  die "среда «${ENV_NAME}» и адрес «${WANT_HOST}» — разные имена.
  Имя среды и первая часть адреса — одно слово. Или так:
      $(again up "NAME=${WANT_HOST%%.*}" "HOST=${WANT_HOST}")
  или адрес под именем среды: HOST=${ENV_NAME}.${RELAY_DOMAIN:-colloq.ru}"
fi

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

# --------------------------------------------------------------- метка

# Сменить метку живому инстансу. У vast это PUT instances/<id>/ с полем label —
# тот же вызов, которым выше поднимают остановленную машину, и это важно:
# инстанс не пересоздаётся, диск на месте, семинар не прерывается ни на секунду.
relabel() {
  local id="$1" to="$2"
  api PUT "instances/$id/" "$(TO="$to" py '
import json, os
print(json.dumps({"label": os.environ["TO"]}))')" >/dev/null
}

# Какой адрес обслуживает машина — по её собственному .env. Это единственный
# честный ответ на вопрос «чья она»: метка могла остаться от прошлой жизни, а
# PUBLIC_URL туда вписал `make host` в тот момент, когда туннель поднялся.
remote_host_name() {
  local url
  [ "$INST_STATUS" = running ] && [ -n "$INST_SSH_HOST" ] && [ -f "$SSH_KEY" ] || return 1
  url="$(rssh "grep -E '^PUBLIC_URL=' $REMOTE_DIR/.env 2>/dev/null | tail -1 | cut -d= -f2-" \
    </dev/null 2>/dev/null | tr -d ' \r' || true)"
  case "$url" in
    https://*) printf '%s' "${url#https://}" ;;
    *) return 1 ;;
  esac
}

# Безымянная машина под именованную среду. Метка «colloq» осталась от времён
# единственной аренды, и на такой машине сейчас работает боевая среда: осиротеть
# она не должна, а `make vast-up HOST=demo.colloq.ru` обязан вести к ней же, а
# не арендовать вторую рядом.
#
# Но принять её за свою можно только доказав, что она своя, и доказательство
# здесь одно: имя среды — это первая часть адреса, а адрес машина знает сама.
# Совпало — меняем метку и дальше работаем по имени. Не совпало — оставляем её в
# покое: развернуть на чужой машине свою базу значит потерять чужую.
adopt_legacy() {
  local mine="$LABEL" addr
  [ -n "$ENV_NAME" ] || return 1
  LABEL="$LABEL_BASE"
  if ! load_instance; then LABEL="$mine"; return 1; fi
  say "${DIM}    рядом безымянная машина $INST_ID (метка «${LABEL_BASE}») — выясняю, чья она${OFF}"
  if addr="$(remote_host_name)" && [ "${addr%%.*}" = "$ENV_NAME" ]; then
    say "${DIM}    она обслуживает https://$addr — это и есть среда «${ENV_NAME}»${OFF}"
    relabel "$INST_ID" "$mine"
    say "${DIM}    метка «${LABEL_BASE}» → «${mine}»: дальше эта машина находится по имени${OFF}"
    LABEL="$mine"
    load_instance || die "метку сменил, но инстанс по ней не находится.
  Загляните на https://cloud.vast.ai/instances/"
    return 0
  fi
  if [ -n "${addr:-}" ]; then
    say "${DIM}    она обслуживает https://$addr — это не среда «${ENV_NAME}», не трогаю её${OFF}"
  else
    say "${RED}    не смог спросить её, какой адрес она обслуживает${OFF}"
    say "${DIM}    (машина «${INST_STATUS}» или ssh не отвечает). Если это и есть среда${OFF}"
    say "${DIM}    «${ENV_NAME}» — назовите её, а не арендуйте вторую: make vast-adopt NAME=${ENV_NAME}${OFF}"
  fi
  LABEL="$mine"
  clear_instance
  return 1
}

# ---------------------------------------------------------------- adopt

cmd_adopt() {
  need_tools
  auth
  [ -n "$ENV_NAME" ] || die "назовите среду: make vast-adopt NAME=demo
  Так называется машина с меткой «${LABEL_BASE}» — та, что арендована ещё до
  того, как сред стало несколько."
  if load_instance; then
    die "среда «${ENV_NAME}» уже есть — инстанс $INST_ID с меткой «${LABEL}».
  Переименовывать нечего: две машины под одним именем — это и есть путаница."
  fi
  local mine="$LABEL" addr answer
  LABEL="$LABEL_BASE"
  load_instance || die "безымянной машины (метка «${LABEL_BASE}») на vast.ai нет.
  Смотреть, что арендовано: $(again status)"

  printf '\n'
  say "${BOLD}назвать инстанс $INST_ID средой «${ENV_NAME}»${OFF} ${DIM}($INST_NGPU x $INST_GPU, \$$INST_DPH/час)${OFF}"
  say "${DIM}метка «${LABEL_BASE}» → «${mine}». Машина не пересоздаётся: диск, база и${OFF}"
  say "${DIM}открытый туннель остаются как есть — меняется только имя на стороне vast.${OFF}"
  if addr="$(remote_host_name)"; then
    say "${DIM}она обслуживает ${OFF}${BOLD}https://$addr${OFF}"
    if [ "${addr%%.*}" != "$ENV_NAME" ]; then
      say "${RED}а это не «${ENV_NAME}».${OFF} ${DIM}Имя среды — первая часть адреса; назвав её иначе,${OFF}"
      say "${DIM}вы получите среду, чьи копии лежат под одним именем, а адрес — под другим.${OFF}"
    fi
  else
    say "${DIM}какой адрес она обслуживает, спросить не вышло — машина «${INST_STATUS}»${OFF}"
    say "${DIM}или ssh молчит. Имя тогда только на вашей памяти.${OFF}"
  fi
  if [ "${FORCE:-}" != 1 ]; then
    [ -t 0 ] || die "не вижу терминала, чтобы спросить. FORCE=1 — переименовать без вопроса."
    printf '%sпереименовать? [y/N] %s' "$BOLD" "$OFF"
    read -r answer
    case "$answer" in y|Y|д|да) : ;; *) die "не переименовываю." ;; esac
  fi
  relabel "$INST_ID" "$mine"
  printf '\n'
  say "${BOLD}готово${OFF} ${DIM}— теперь: $(again status "NAME=${ENV_NAME}")${OFF}"
  say "${DIM}Копии этой среды отныне снимаются в backups/${ENV_NAME}/. Те, что уже${OFF}"
  say "${DIM}лежат россыпью в backups/, считаются копиями безымянной среды и этой${OFF}"
  say "${DIM}машине больше не поедут. Если они её — перенесите руками:${OFF}"
  say "${DIM}    mkdir -p backups/${ENV_NAME} && mv backups/colloq-<дата>* backups/${ENV_NAME}/${OFF}"
}

# ------------------------------------------------------------------- up

cmd_up() {
  # Validate and assemble an exact committed release before contacting Vast.
  [ -n "${RELEASE:-}" ] && [ -f "$RELEASE" ] || die "нужен явный RELEASE=/path/release.json; рабочее дерево не является релизом."
  local registry_file registry_snapshot="" registry_remote=0
  registry_file="${REGISTRY_OPTION:-${VAST_REGISTRY_CONFIG:-$(read_env VAST_REGISTRY_CONFIG)}}"
  if [ -n "$registry_file" ]; then
    [ "${VAST_REGISTRY_READ_ONLY:-$(read_env VAST_REGISTRY_READ_ONLY)}" = 1 ] \
      || die 'VAST_REGISTRY_READ_ONLY=1 must explicitly confirm a dedicated read-only pull credential; never use a general GitHub/Vast credential.'
    [ -f "$registry_file" ] || die 'registry config file is missing'
    registry_snapshot="$(mktemp -t colloq-registry.XXXXXX)"; TMPS+=("$registry_snapshot")
    # Snapshot only auths; credential helpers and unrelated Docker config cannot
    # run on the rental. Diagnostics must never contain credential values.
    python3 - "$registry_file" "$registry_snapshot" <<'REGISTRY'
import base64, json, os, re, sys
try:
    if os.path.getsize(sys.argv[1]) > 262144: raise ValueError()
    with open(sys.argv[1]) as f: value = json.load(f)
    if not isinstance(value, dict) or set(value) != {'auths'}: raise ValueError()
    auths = value['auths']
    if not isinstance(auths, dict) or not 0 < len(auths) <= 32: raise ValueError()
    for host, entry in auths.items():
        if not isinstance(host, str) or not re.fullmatch(r'(?:https://)?[a-zA-Z0-9.-]+(?::[0-9]{1,5})?(?:/v1/)?', host): raise ValueError()
        if not isinstance(entry, dict) or set(entry) != {'auth'} or not isinstance(entry['auth'], str): raise ValueError()
        decoded = base64.b64decode(entry['auth'], validate=True).decode('utf-8')
        user, sep, password = decoded.partition(':')
        if not sep or not user or not password or len(decoded) > 16384 or any(c in decoded for c in '\r\n\0'): raise ValueError()
    with open(sys.argv[2], 'w') as f: json.dump({'auths': auths}, f)
    os.chmod(sys.argv[2], 0o600)
except Exception:
    raise SystemExit('Invalid registry config: expected only registry auths with base64 username:password; helpers are forbidden')
REGISTRY
    registry_remote=1
  else
    [ "${VAST_PUBLIC_IMAGES:-$(read_env VAST_PUBLIC_IMAGES)}" = 1 ] \
      || die 'Provide --registry-config with dedicated read-only pull credentials, or explicitly declare VAST_PUBLIC_IMAGES=1 for anonymously pullable release images.'
  fi
  python3 scripts/release.py validate --release "$RELEASE" || die "манифест релиза не прошёл проверку."
  if [ "$registry_remote" = 1 ] && [ "${VAST_PUBLIC_IMAGES:-$(read_env VAST_PUBLIC_IMAGES)}" != 1 ]; then
    python3 - "$RELEASE" "$registry_snapshot" <<'COVERAGE'
import json, sys, urllib.parse
with open(sys.argv[1]) as f: release = json.load(f)
with open(sys.argv[2]) as f: auths = json.load(f)['auths']
def canonical(host):
    host = host.lower()
    return 'docker.io' if host in ('index.docker.io', 'registry-1.docker.io') else host
available = {canonical(urllib.parse.urlsplit(key if '://' in key else 'https://' + key).netloc) for key in auths}
images = [release['appImage'], release['runtimeImage']] + [e['image'] for e in release['catalog']['environments']]
plugin = release.get('tooling', {}).get('gpu', {}).get('devicePluginImage')
if plugin: images.append(plugin)
for image in images:
    first = image.split('/')[0]
    host = canonical(first) if '/' in image and ('.' in first or ':' in first or first == 'localhost') else 'docker.io'
    if host not in available:
        raise SystemExit('Release has a registry without pull credentials; supply credentials or explicitly declare VAST_PUBLIC_IMAGES=1 for uncovered images')
COVERAGE
  fi
  local commit artifact
  commit="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["sourceCommit"])' "$RELEASE")"
  [[ "$commit" =~ ^[0-9a-f]{40}$ ]] || die "sourceCommit должен быть полным SHA коммита."
  git cat-file -e "$commit^{commit}" || die "коммита релиза нет здесь; сначала получите его из доверенного репозитория."
  artifact="$(mktemp -t colloq-release.XXXXXX)"; TMPS+=("$artifact")
  git archive --format=tar "$commit" scripts/cluster.sh scripts/release.py scripts/state-lock.py scripts/host.sh scripts/lib.sh scripts/backup.sh scripts/runtime-backup.py scripts/restore.sh > "$artifact" \
    || die "коммит релиза не содержит полный комплект инструментов развёртывания."
  need_tools
  auth
  # Арендовать вслепую дороже всего: без имени и при нескольких средах `up`
  # завёл бы рядом ещё одну машину, а узнали бы об этом по счёту.
  resolve_env "разворачивать"

  # Local backup damage or legacy format must be discovered before renting.
  local available_backup
  available_backup="$(last_backup)"
  if [ -n "$available_backup" ]; then
    case "$available_backup" in
      *-live.tar.gz|*-consistent.tar.gz)
        python3 scripts/runtime-backup.py validate --archive "$available_backup" --name "$ENV_NAME" --release "$RELEASE" >/dev/null;;
      *) die "копия среды имеет старый формат .db; сначала выполните явную миграцию в portable backup.";;
    esac
  fi

  say "${BOLD}1/$STEPS${OFF} проверяю, что всё готово${ENV_NAME:+ для среды «${ENV_NAME}»}"
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

  say "${BOLD}2/$STEPS${OFF} ищу машину среды${ENV_NAME:+ «${ENV_NAME}»} — метка «${LABEL}»"
  # Сначала по своей метке, потом — та самая безымянная, но только если она
  # докажет, что она этой среды и есть.
  if load_instance || adopt_legacy; then
    say "${DIM}    уже арендована: инстанс $INST_ID${OFF}"
    say "${BOLD}3/$STEPS${OFF} разворачиваюсь поверх неё"
    if [ "$INST_STATUS" != running ]; then
      say "${DIM}    он сейчас «${INST_STATUS}» — поднимаю${OFF}"
      api PUT "instances/$INST_ID/" '{"state":"running"}' >/dev/null
      wait_running "$INST_ID"
      load_instance || die "инстанс $INST_ID поднялся, но по метке не находится."
    fi
  else
    say "${DIM}    не арендована — ищу предложение: ${GPU_NAME:-любая карта}${GPU_RAM:+, от $GPU_RAM ГБ}, виртуалка, on-demand, до \$$MAX_PRICE/час${OFF}"
    local query offers pick suitable
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
    suitable="$(printf '%s' "$offers" | py '
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
for o in offers[:8]:
    print("    %-10s %s x %-10s %4.0f ГБ  $%.3f/час  %s" % (
        o.get("id"), o.get("num_gpus"), o.get("gpu_name"),
        # Показываем как на коробке: 24564 МБ это «24 ГБ», а не «25».
        (o.get("gpu_ram") or 0) / 1024, o.get("dph_total") or 0,
        o.get("geolocation") or ""), file=sys.stderr)
# В stdout — ВСЕ подходящие, по строке на предложение, самое дешёвое первым:
# человек может назвать не то, что мы выбрали за него, а любое другое — по
# номеру из списка выше (ближе, карта новее, хозяин знакомый). Номер сверяется
# с этим списком, а не уходит в vast как есть: так нельзя арендовать то, что
# не прошло ни предел цены, ни отсев по драйверу.
for o in offers:
    print("%s\t%.3f\t%s x %s" % (o["id"], o.get("dph_total") or 0,
                                 o.get("num_gpus"), o.get("gpu_name")))
')"
    [ -n "$suitable" ] || die "под эти условия ничего не нашлось.
  Искалось: карта «${GPU_NAME:-любая}», память $GPU_RAM_TEXT, до \$$MAX_PRICE/час,
  диск от $DISK ГБ.
  Ослабить разово: $(again up "$NAME_ARG" 'GPU="RTX 4090"') — или насовсем, в .env:
  VAST_GPU, VAST_GPU_RAM, VAST_MAX_PRICE. Виртуалок на рынке заметно меньше, чем
  обычных инстансов, — это цена решения арендовать именно их."

    local offer_id price what
    # Строка предложения по его номеру — из того же списка подходящих.
    offer_line() { printf '%s\n' "$suitable" | awk -F '\t' -v id="$1" '$1 == id { print; exit }'; }
    announce() {
      say ""
      say "${BOLD}беру $offer_id${OFF} — $what, \$$price/час"
      say "${DIM}пара из двух часов обойдётся примерно в \$$(PRICE="$price" py '
import os; print("%.2f" % (float(os.environ["PRICE"]) * 2))')${OFF}"
    }
    # OFFER=<номер> — назвать предложение заранее (и в сценарии с FORCE=1 тоже).
    if [ -n "${OFFER:-}" ]; then
      pick="$(offer_line "$OFFER")"
      [ -n "$pick" ] || die "предложения $OFFER нет среди подходящих под условия.
  Уберите OFFER — и выберите номер из списка выше."
    else
      pick="$(printf '%s\n' "$suitable" | head -n 1)"
    fi
    IFS=$'\t' read -r offer_id price what <<<"$pick"
    announce
    # Деньги настоящие, поэтому спрашиваем. FORCE=1 — для сценариев, где предел
    # цены задан заранее, в VAST_MAX_PRICE.
    if [ "${FORCE:-}" != 1 ]; then
      [ -t 0 ] || die "не вижу терминала, чтобы спросить. FORCE=1 — арендовать без вопроса."
      printf '%sарендовать? [y/N или номер из списка] %s' "$BOLD" "$OFF"
      local answer; read -r answer
      case "$answer" in
        y|Y|д|да) : ;;
        *[!0-9]*|'') die "не арендую." ;;
        *)
          # Номер вместо «да» — это и есть согласие, только на другое
          # предложение: второй раз не переспрашиваем, но говорим, что берём.
          pick="$(offer_line "$answer")"
          [ -n "$pick" ] || die "предложения $answer нет среди подходящих — не арендую.
  Номера — в списке выше; шире список: VAST_MAX_PRICE, VAST_GPU_RAM в .env."
          IFS=$'\t' read -r offer_id price what <<<"$pick"
          announce
          ;;
      esac
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
  повторите $(again up "$NAME_ARG"): он развернётся поверх неё."
    say "${DIM}    инстанс $new_id${OFF}"
    wait_running "$new_id"
    load_instance || die "инстанс $new_id арендован, но по метке не находится.
  Загляните на https://cloud.vast.ai/instances/"
  fi

  say "${BOLD}4/$STEPS${OFF} жду ssh"
  [ -n "$INST_SSH_HOST" ] && [ -n "$INST_SSH_PORT" ] \
    || die "vast ещё не назвал адрес ssh. Повторите через минуту: $(again up "$NAME_ARG")"
  say "${DIM}    ssh root@$INST_SSH_HOST -p $INST_SSH_PORT${OFF}"
  local waited=0
  until rssh true </dev/null 2>/dev/null; do
    waited=$((waited + 5))
    [ "$waited" -lt 600 ] || die "ssh на машину не отвечает десять минут.
  Тот ли ключ зарегистрирован в аккаунте? Проверить руками:
      ssh -i $SSH_KEY -p $INST_SSH_PORT root@$INST_SSH_HOST"
    sleep 5
  done

  say "${BOLD}5/$STEPS${OFF} переношу проверенный релиз $commit"
  # Refuse unsupported in-place migration before overwriting any legacy tools/data.
  rssh "REMOTE_DIR='$REMOTE_DIR' FRP_VERSION='$FRP_VERSION' bash -s" <<'REMOTE'
set -euo pipefail
if [ -s "$REMOTE_DIR/data/colloq.db" ] || systemctl is-active --quiet colloq 2>/dev/null; then
  echo 'Legacy service/compose data detected. Export and migrate it explicitly; automatic overlay is refused.' >&2
  exit 1
fi
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq rsync curl tar tmux python3 dnsutils ca-certificates gnupg iptables >/dev/null
if ! command -v frpc >/dev/null; then
  tmp=$(mktemp -d)
  curl -fsSL "https://github.com/fatedier/frp/releases/download/v${FRP_VERSION}/frp_${FRP_VERSION}_linux_amd64.tar.gz" -o "$tmp/frp.tar.gz"
  tar -xzf "$tmp/frp.tar.gz" -C "$tmp" --strip-components=1
  install -m 0755 "$tmp/frpc" /usr/local/bin/frpc
fi
[ "$(frpc --version)" = "$FRP_VERSION" ] || { echo 'frpc version differs from pinned relay version' >&2; exit 1; }
mkdir -p "$REMOTE_DIR/backups"
REMOTE
  rsync -a -e "$(ssh_cmd)" "$artifact" "root@$INST_SSH_HOST:$REMOTE_DIR/release-tools.tar"
  rsync -a -e "$(ssh_cmd)" "$RELEASE" "root@$INST_SSH_HOST:$REMOTE_DIR/release.json"
  if [ "$registry_remote" = 1 ]; then
    rsync -a -e "$(ssh_cmd)" "$registry_snapshot" "root@$INST_SSH_HOST:$REMOTE_DIR/registry-pull.json"
  fi
  # Only deployment/application configuration is eligible for first installation.
  # Billing and DNS credentials are never transferred. Existing remote config wins.
  # RUNTIME_KERNEL_MEMORY[_MAX] — память комнаты по умолчанию и потолок для
  # брокера: cluster.sh кладёт их в Deployment брокера из того же файла.
  local tmpenv
  tmpenv="$(mktemp -t colloq-vast-env.XXXXXX)"; TMPS+=("$tmpenv")
  grep -E '^(UI_LANGUAGE|RELAY_(ADDR|PORT|TOKEN|DOMAIN)|INSTITUTION|SESSION_SECRET|ORACLE_[A-Z_]+|OPENAI_[A-Z_]+|ANTHROPIC_[A-Z_]+|RUNTIME_KERNEL_MEMORY(_MAX)?)=' .env > "$tmpenv" || true
  local public_url="http://127.0.0.1:30080"
  [ -z "$WANT_HOST" ] || public_url="https://$WANT_HOST"
  printf 'PORT=30080\nCOLLOQ_CLUSTER=1\nPUBLIC_URL=%s\n' "$public_url" >> "$tmpenv"
  rsync -a -e "$(ssh_cmd)" "$tmpenv" "root@$INST_SSH_HOST:$REMOTE_DIR/.env.incoming"
  local db want_backup=""
  db="$(last_backup)"
  if [ -n "$db" ]; then
    case "$db" in
      *-live.tar.gz|*-consistent.tar.gz)
        python3 scripts/runtime-backup.py validate --archive "$db" --name "$ENV_NAME" >/dev/null
        want_backup="$(basename "$db")"
        rsync -a -e "$(ssh_cmd)" "$db" "root@$INST_SSH_HOST:$REMOTE_DIR/backups/";;
      *) die "есть только старая копия .db; нужен перенос в portable backup, автоматическая миграция запрещена.";;
    esac
  fi
  say "${BOLD}6/$STEPS${OFF} устанавливаю k3s и восстанавливаю только пустую среду"
  rssh "REMOTE_DIR='$REMOTE_DIR' WANT_BACKUP='$want_backup' NAME='$ENV_NAME' REGISTRY_CONFIG='$registry_remote' bash -s" <<'REMOTE'
set -euo pipefail
cd "$REMOTE_DIR"
tar -xf release-tools.tar
if [ ! -f .env ]; then mv .env.incoming .env; fi
chmod 600 .env .env.incoming 2>/dev/null || true
python3 scripts/release.py validate --release release.json
registry_args=()
if [ "$REGISTRY_CONFIG" = 1 ]; then
  chmod 600 "$REMOTE_DIR/registry-pull.json"
  registry_args=(--registry-config "$REMOTE_DIR/registry-pull.json")
fi
if [ -f /var/lib/colloq/releases/current.json ] && [ -s /var/lib/colloq/data/colloq.db ]; then
  bash scripts/cluster.sh update --release "$REMOTE_DIR/release.json" "${registry_args[@]}"
else
  python3 - <<'EMPTY'
from pathlib import Path
for name in ('data', 'workspace'):
    p = Path('/var/lib/colloq') / name
    if p.is_symlink() or (p.exists() and any(p.iterdir())):
        raise SystemExit('Unmanaged nonempty application data: explicit recovery is required')
EMPTY
  bash scripts/cluster.sh prepare --release "$REMOTE_DIR/release.json" --env-file "$REMOTE_DIR/.env" "${registry_args[@]}"
  if [ -n "$WANT_BACKUP" ]; then
    bash scripts/restore.sh --archive "backups/$WANT_BACKUP" --release "$REMOTE_DIR/release.json" --replace
    # Reconcile restored broker secrets/config before starting either application.
    bash scripts/cluster.sh prepare --release "$REMOTE_DIR/release.json" "${registry_args[@]}"
  fi
  bash scripts/cluster.sh start
fi
bash scripts/cluster.sh smoke
REMOTE

  local hosted=""
  if [ -n "$WANT_HOST" ]; then
  say "${BOLD}7/$STEPS${OFF} выставляю наружу на $WANT_HOST"
    # Живой адрес не трогаем.
    #
    # Шаг ниже начинается с `tmux kill-session`, то есть с закрытия туннеля, —
    # а повторный заход бывает ровно на машину, где идёт пара: «довезти правку
    # кода» это тот же `make vast-up HOST=…`. Каждый такой заход рвал зал на
    # переподключение и на несколько секунд ронял ссылки на localhost, хотя
    # адрес всё это время отвечал. Спрашиваем сам адрес: отвечает — трогать
    # нечего, и шаг проходит за одну проверку.
    if host_health; then
      say "${DIM}    $WANT_HOST уже отвечает — туннель и сессию не трогаю${OFF}"
      hosted=1
    # Отказ этого шага не отменяет предыдущих: машина арендована, Colloq на ней
    # работает. Поэтому ветка, а не die, — иначе человек, уже заплативший за
    # машину, не увидел бы даже строчки ssh, по которой на неё войти.
    elif rssh "REMOTE_DIR='$REMOTE_DIR' WANT_HOST='$WANT_HOST' TMUX_SESSION='$TMUX_SESSION' PORT='$PORT' bash -s" <<'REMOTE'
set -euo pipefail
cd "$REMOTE_DIR"

# Прежняя сессия убирается до новой. Ретранслятор не пускает второй frpc с тем
# же поддоменом («already exists»), и повторный vast-up получал бы отказ от
# собственного, ещё живого туннеля — самый обидный вид «занято».
#
# Ctrl+C с ожиданием, а не kill-session, и до проверки здоровья, а не после.
# host.sh на выходе снимает свой адрес с кластера: cluster.sh public-url
# возвращает localhost и перезапускает приложение — до трёх минут. Оборви его
# на полпути — адрес останется мёртвым; не дождись — старая уборка вернёт
# localhost уже ПОВЕРХ адреса новой сессии (имя у них одно), а то и новая
# упрётся в замок состояния, который держит старая. Здоровье спрашивается
# после: оно и дождётся приложения, перезапущенного этой уборкой.
#
# Ждём уборку host.sh, а не окно. Сессию с этим именем заводят и руками —
# `tmux new -s …`, как советует сам vast.sh, когда адрес не назван, — и после
# Ctrl+C она остаётся жить голой оболочкой: по одному has-session такой заход
# простаивал бы все двести секунд ни за чем. Шаблон — от начала строки и с
# bash: командную строку host.sh целиком носит и сервер tmux (он остаётся
# процессом `tmux new-session … bash scripts/host.sh …`), и оболочка `sh -c`
# сессии, а `.sh` — ещё и домен в адресе. Без pgrep — прежнее ожидание окна.
if tmux has-session -t "$TMUX_SESSION" 2>/dev/null; then
  echo "    останавливаю прежнюю сессию $TMUX_SESSION — она снимает адрес с кластера"
  tmux send-keys -t "$TMUX_SESSION" C-c 2>/dev/null || true
  for _ in $(seq 1 100); do
    tmux has-session -t "$TMUX_SESSION" 2>/dev/null || break
    if command -v pgrep >/dev/null 2>&1; then pgrep -f '^[^ ]*bash ([^ ]*/)?scripts/host\.sh' >/dev/null 2>&1 || break; fi
    sleep 2
  done
  tmux kill-session -t "$TMUX_SESSION" 2>/dev/null || true
fi

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

# Туннель живёт ровно столько, сколько живёт `make host`. Запущенный прямо в
# ssh-сессии, он умер бы вместе с ней — то есть в ту секунду, когда закрыли
# ноутбук. Журнал пишется рядом: когда адрес не отвечает, смотреть будут его.
#
# tee -i: Ctrl+C в этом окне достаётся всей группе процессов, и простой tee
# умирал первым — уборка host.sh (снятие адреса с кластера) писала уже в
# пустоту, и ни в окне, ни в host.log не оставалось, снят адрес или нет.
tmux new-session -d -s "$TMUX_SESSION" \
  "cd '$REMOTE_DIR' && COLLOQ_CLUSTER=1 COLLOQ_HOSTNAME='$WANT_HOST' bash scripts/host.sh 2>&1 | tee -i -a host.log"
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
  say "${BOLD}Colloq поднят на арендованной машине${ENV_NAME:+ — среда «${ENV_NAME}»}${OFF}"
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
    say "  ${DIM}повторить, не арендуя ничего заново: $(again up "HOST=$WANT_HOST")${OFF}"
  else
    say "${BOLD}Наружу — оттуда, а не отсюда${OFF} ${DIM}(семинар считается там, где стоит ядро)${OFF}"
    if [ -n "$RELAY_DOMAIN" ]; then
      say "  ${CYAN}$(again up "HOST=<имя>.$RELAY_DOMAIN")${OFF} ${DIM}— отсюда, одной командой${OFF}"
      say "  ${DIM}или руками на машине: cd $REMOTE_DIR && COLLOQ_CLUSTER=1 COLLOQ_HOSTNAME=<имя>.$RELAY_DOMAIN bash scripts/host.sh${OFF}"
    else
      say "  ${CYAN}cd $REMOTE_DIR && COLLOQ_CLUSTER=1 bash scripts/host.sh${OFF}"
      say "  ${DIM}без RELAY_* в .env это Cloudflare, а его адреса из России не${OFF}"
      say "  ${DIM}открываются — см. make relay-setup и раздел README про ретранслятор${OFF}"
    fi
    say "  ${DIM}Руками команда держит окно: туннель живёт, пока она работает.${OFF}"
    say "  ${DIM}Закрываете ноутбук — запускайте её в tmux: tmux new -s $TMUX_SESSION${OFF}"
  fi
  printf '\n'
  say "${DIM}Сервер и ядра комнат работают в k3s:${OFF}"
  say "${DIM}  журнал      ssh … 'cd /opt/colloq && bash scripts/cluster.sh logs'${OFF}"
  say "${DIM}  перезапуск  ssh … 'cd $REMOTE_DIR && bash scripts/cluster.sh start'${OFF}"
  say "${DIM}  обновление  make vast-up$NAME_ARG RELEASE=/path/release.json${OFF}"
  say "${DIM}Окружения собраны заранее и записаны digest-ами в каталоге релиза.${OFF}"
  say "${DIM}Данные оттуда: $(again sync "$NAME_ARG") · уничтожить машину: $(again down "$NAME_ARG")${OFF}"
  say "${RED}Всё, что на этой машине, живёт ровно до её уничтожения.${OFF}"
}

# --------------------------------------------------------------- status

cmd_status() {
  need_tools
  auth
  local db s lines n
  # Имени не назвали — показываем всё, что арендовано. Сред может быть
  # несколько, и «первая попавшаяся» здесь врала бы не по мелочи: цена, копия и
  # адрес принадлежали бы разным машинам. Ровно одна среда — сразу подробности:
  # выбирать не из чего, и лишний шаг был бы лишним.
  if [ -z "$ENV_NAME" ]; then
    lines="$(instances_tsv)"
    n="$(env_count "$lines")"
    if [ "$n" -gt 1 ]; then
      say "${BOLD}арендовано сред: $n${OFF}"
      print_envs "$lines"
      printf '\n'
      say "${DIM}подробности одной: $(again status 'NAME=<имя>')${OFF}"
      say "${DIM}у каждой среды свои машина, счёт и данные — общего только код и ретранслятор${OFF}"
      return 0
    fi
    if [ "$n" -eq 1 ]; then
      ENV_NAME="$(printf '%s' "$lines" | cut -d "$SEP" -f1)"; use_env
    fi
  fi
  db="$(last_backup)"
  if ! load_instance; then
    say "${DIM}на vast.ai ничего не арендовано${OFF} ${DIM}(метка «${LABEL}»)${OFF}"
    say "${DIM}арендовать: $(again up "$NAME_ARG")${OFF}"
    if [ -n "$db" ]; then say "${DIM}последняя копия здесь: $(backup_age "$db")${OFF}"; fi
    return 0
  fi
  printf '%sсреда %s%s %s· инстанс %s · %s · %s x %s · $%s/час%s\n' \
    "$BOLD" "$(env_title "$ENV_NAME")" "$OFF" "$DIM" "$INST_ID" "$INST_STATUS" \
    "$INST_NGPU" "$INST_GPU" "$INST_DPH" "$OFF"
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
      say "  ${RED}colloq на той машине не отвечает${OFF} ${DIM}(журнал: ssh … 'cd /opt/colloq && bash scripts/cluster.sh logs')${OFF}"
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
          # Среда и адрес — одно имя, и здесь это уже не пожелание, а проверка
          # факта: машина сама сказала, что обслуживает. Разошлись — значит
          # копии этой среды снимаются под одним именем, а семинар идёт под
          # другим, и однажды они встретятся не тем концом.
          if [ -n "$ENV_NAME" ] && [ "${name%%.*}" != "$ENV_NAME" ]; then
            say "  ${RED}но среда называется «${ENV_NAME}», а адрес — «${name%%.*}»${OFF}"
            say "  ${DIM}копии этой среды лежат в $BACKUP_DIR/ — под именем среды, не адреса${OFF}"
          fi
        fi
        if [ "$alive" != alive ]; then
          say "  ${DIM}tmux-сессии «${TMUX_SESSION}» на машине нет — держать туннель некому${OFF}"
          say "  ${DIM}поднять снова: $(again up "HOST=${name:-<имя>}")${OFF}"
        fi ;;
      *)
        if [ "$alive" = alive ]; then
          say "  ${DIM}туннель «${TMUX_SESSION}» поднимается — адреса в .env ещё нет${OFF}"
        else
          say "  ${DIM}наружу не выставлен${OFF} ${DIM}($(again up "HOST=<имя>${RELAY_DOMAIN:+.$RELAY_DOMAIN}"))${OFF}"
        fi ;;
    esac
  fi
  if [ -n "$db" ]; then
    say "${DIM}последняя копия здесь: $(backup_age "$db")${OFF}"
  else
    say "${RED}копий здесь нет вовсе${OFF} ${DIM}— снять: $(again sync "$NAME_ARG")${OFF}"
  fi
}

# ----------------------------------------------------------------- sync

cmd_sync() {
  need_tools
  auth
  # Снять данные не той среды — это половина беды; вторая половина в том, что
  # они лягут в чужой каталог и однажды уедут в чужую комнату. Поэтому при
  # нескольких средах имя обязательно.
  resolve_env "снимать"
  load_instance || die "с меткой «${LABEL}» на vast.ai ничего не арендовано — снимать не с чего."
  [ "$INST_STATUS" = running ] || die "инстанс $INST_ID сейчас «${INST_STATUS}».
  Снять данные можно только с работающей машины: поднимите её ($(again up "$NAME_ARG"))
  и повторите."

  local mode="${MODE:-live}"
  case "${RESUME:-0}" in 0|1) ;; *) die "RESUME=0 или RESUME=1";; esac
  case "$mode" in live|consistent) ;; *) die "MODE=live или MODE=consistent";; esac
  say "${BOLD}1/2${OFF} снимаю $mode portable backup"
  rssh "cd $REMOTE_DIR && NAME='$ENV_NAME' MODE='$mode' RESUME='${RESUME:-0}' bash scripts/backup.sh" </dev/null
  say "${BOLD}2/2${OFF} забираю и проверяю копию среды"
  mkdir -p "$BACKUP_DIR"
  local newest
  newest="$(rssh "ls -1t $REMOTE_DIR/backups${ENV_NAME:+/$ENV_NAME}/colloq-*-$mode.tar.gz 2>/dev/null | head -1" </dev/null)"
  case "$newest" in "$REMOTE_DIR/backups"*/colloq-*.tar.gz) ;; *) die "portable backup не найден";; esac
  rsync -a -e "$(ssh_cmd)" "root@$INST_SSH_HOST:$newest" "$BACKUP_DIR/" || die "копия не приехала"
  python3 scripts/runtime-backup.py validate --archive "$BACKUP_DIR/$(basename "$newest")" --name "$ENV_NAME" \
    || die "проверка копии не прошла — машину не уничтожайте"
  say "${BOLD}копия проверена:${OFF} $BACKUP_DIR/$(basename "$newest")"
  say "${DIM}Образы берутся по digest из сохранённого release/catalog. Архив содержит секреты; храните его приватно.${OFF}"

}

# ----------------------------------------------------------------- logs

# Вырезать из журнала то, чем можно воспользоваться.
#
# Журнал службы — это не только строки сервера: туда попадают адреса запросов
# со строкой запроса, а в ней ездят одноразовые ключи на файл; туда же сервер
# печатает ссылку на панель установки — а она И ЕСТЬ ключ ко всему инстансу.
# Забранный сюда журнал живёт в репозитории, летит в чат и прикладывается к
# письму, поэтому фильтр стоит НА ТРУБЕ: нечищеное не касается диска ни секунды.
#
# Режется по форме, а не по списку известных имён: токен участника узнаётся по
# виду (base64url.подпись), ключ провайдера — по приставке, всё остальное — по
# имени параметра рядом. Пропустить лишнее дешевле, чем однажды не заметить.
scrub() {
  py '
import re, sys

# (образец, чем заменить). Порядок важен только тем, что длинное режется до
# короткого: ссылка на панель установки — до общего правила про параметры.
RULES = [
    # Ссылка на панель установки: сама по себе вход хозяином инстанса.
    (r"(/admin/t/)[A-Za-z0-9_\-]+", r"\1<вырезано>"),
    # Одноразовые ключи в строке запроса: token, t, key, sig и их родня.
    (r"([?&](?:token|t|key|api[_\-]?key|access[_\-]?token|auth|secret|sig|"
     r"signature|password|passwd|pwd|code)=)[^&\s\x22\x27<>]+", r"\1<вырезано>"),
    # Заголовок с ключом.
    (r"(?i)(authorization:\s*\w+\s+)\S+", r"\1<вырезано>"),
    (r"(?i)\bBearer\s+[A-Za-z0-9._\-]+", "Bearer <вырезано>"),
    # Печеньки — целиком: там и штат, и вход в панель.
    (r"(?i)((?:set-)?cookie:\s*).*", r"\1<вырезано>"),
    (r"(?i)\b(colloq_staff|connect\.sid)=[^;\s]+", r"\1=<вырезано>"),
    # Токен участника: тело.подпись, оба в base64url. Тело — это JSON, поэтому
    # начинается с eyJ, и спутать его с обычным словом нельзя.
    (r"\beyJ[A-Za-z0-9_\-]{6,}\.[A-Za-z0-9_\-]{10,}", "<вырезано>"),
    # Ключи провайдеров моделей: у всех своя приставка, но форма одна.
    (r"\b(sk|rk|xai|gsk)-[A-Za-z0-9_\-]{12,}", r"\1-<вырезано>"),
    # Строки вида SESSION_SECRET=… — так их печатают и compose, и systemd.
    (r"\b([A-Z][A-Z0-9_]*(?:TOKEN|SECRET|KEY|PASSWORD|PASS))=\S+", r"\1=<вырезано>"),
]
RULES = [(re.compile(a), b) for a, b in RULES]

for line in sys.stdin:
    for rx, repl in RULES:
        line = rx.sub(repl, line)
    sys.stdout.write(line)
'
}

cmd_logs() {
  need_tools
  auth
  # Забрать журнал не той среды не смертельно, но чужие строки в чужой папке —
  # это расследование не той пары; спрашиваем так же, как и на sync.
  resolve_env "смотреть"
  load_instance || die "с меткой «${LABEL}» на vast.ai ничего не арендовано — журнал брать не с чего."
  [ "$INST_STATUS" = running ] || die "инстанс $INST_ID сейчас «${INST_STATUS}».
  Журнал лежит на диске машины, и достать его можно только с работающей:
  поднимите её ($(again up "$NAME_ARG")) и повторите."

  local since="${SINCE:-2h}" dir
  # Kubernetes accepts durations, not journalctl's freeform date expressions.
  [[ "$since" =~ ^[0-9]+[smh]$ ]] || die "SINCE должен быть длительностью: 30m, 2h, 86400s"
  dir="logs${ENV_NAME:+/$ENV_NAME}/$(date +%F)"
  mkdir -p "$dir"
  rssh "k3s kubectl -n colloq logs -l 'colloq.dev/role in (app,runtime)' --all-containers=true --prefix --since='$since' --tail=2000" </dev/null \
    | scrub > "$dir/colloq.log" || die "журнал приложения не отдался"
  rssh "k3s kubectl -n colloq logs -l colloq.kind=room-kernel --all-containers=true --prefix --since='$since' --tail=2000" </dev/null \
    | scrub > "$dir/kernels.log" || die "журнал ядер не отдался"
  say "${BOLD}журналы сохранены в $dir/${OFF}"
  say "${DIM}После удаления Pod его журнал Kubernetes недоступен. Токены вырезаны; данные пользователей могут остаться.${OFF}"

}

# ----------------------------------------------------------------- down

cmd_down() {
  need_tools
  auth
  # Самая дорогая команда здесь. Без имени и при нескольких средах она
  # уничтожила бы «первую попавшуюся» — и восстановить её будет уже не из чего.
  resolve_env "уничтожать"
  load_instance || { say "${DIM}с меткой «${LABEL}» на vast.ai ничего не арендовано${OFF}"; return 0; }

  local s db answer
  s="$(spent)"; db="$(last_backup)"
  printf '\n'
  say "${BOLD}уничтожить инстанс $INST_ID${OFF} ${DIM}— среда $(env_title "$ENV_NAME"), $INST_NGPU x $INST_GPU, \$$INST_DPH/час${s:+, $s}${OFF}"
  say "${RED}Исчезнет всё, что на этой машине:${OFF} база с семинарами, файлы семинаров,"
  say "собранные образы окружений. У vast нет ни корзины, ни снимков."
  if [ -n "$db" ]; then
    say "${DIM}последняя копия здесь: $(backup_age "$db")${OFF}"
  else
    say "${RED}копий здесь нет вовсе.${OFF} ${DIM}Снять: $(again sync "$NAME_ARG")${OFF}"
  fi

  if [ "${FORCE:-}" != 1 ]; then
    [ -t 0 ] || die "не вижу терминала, чтобы спросить. FORCE=1 — уничтожить без вопроса."
    printf '%sнапечатайте «уничтожить», чтобы продолжить: %s' "$BOLD" "$OFF"
    read -r answer
    [ "$answer" = "уничтожить" ] || die "не уничтожаю."
  fi

  api DELETE "instances/$INST_ID/" >/dev/null
  say "${DIM}инстанс $INST_ID уничтожен — счётчик остановлен${OFF}"
  # «Или здесь: make restore NAME=…» здесь больше не советуется: переносимую
  # копию k3s разворачивает только k3s (restore.sh --archive останавливает
  # кластер), а `make restore` без ARCHIVE и RELEASE отказывает сразу.
  #
  # ARCHIVE — только переносимая копия: last_backup находит и прежнюю пару
  # .db, а restore.sh --archive её не примет, и совет отказал бы вторым шагом.
  local archive="<копия из $BACKUP_DIR/>"
  case "$db" in *-live.tar.gz|*-consistent.tar.gz) archive="$db" ;; esac
  say "${DIM}развернуть эти данные заново: $(again up "$NAME_ARG" "${ENV_NAME:+HOST=$ENV_NAME.${RELAY_DOMAIN:-colloq.ru}}")${OFF}"
  say "${DIM}или на своей Linux-машине с k3s: make restore$NAME_ARG ARCHIVE=${archive} RELEASE=${RELEASE:-/path/release.json}${OFF}"
}

case "$CMD" in
  up)     cmd_up ;;
  status) cmd_status ;;
  sync)   cmd_sync ;;
  logs)   cmd_logs ;;
  down)   cmd_down ;;
  adopt)  cmd_adopt ;;
  *)
    say "${BOLD}Colloq на арендованной машине${OFF}"
    say "  scripts/vast.sh up      ${DIM}RELEASE=/path/release.json — арендовать VM и установить релиз${OFF}"
    say "  ${DIM}NAME=demo             ... среда: своя машина, свои копии, свой счёт${OFF}"
    say "  ${DIM}HOST=demo.colloq.ru    ... и сразу выставить наружу на этом адресе${OFF}"
    say "  ${DIM}                        (имя среды тогда можно не называть — оно тут)${OFF}"
    say "  ${DIM}GPU=\"RTX 5070\"         ... на карте, названной вслух${OFF}"
    say "  scripts/vast.sh status  ${DIM}без имени — все среды; с именем — подробности одной${OFF}"
    say "  scripts/vast.sh sync    ${DIM}снять данные оттуда сюда, в backups/<среда>/${OFF}"
    say "  scripts/vast.sh logs    ${DIM}забрать журналы службы и ядер в logs/<среда>/<дата>/${OFF}"
    say "  ${DIM}SINCE=2h               ... за другое окно; умолчание — 2 часа${OFF}"
    say "  scripts/vast.sh down    ${DIM}уничтожить машину вместе со всем, что на ней${OFF}"
    say "  scripts/vast.sh adopt   ${DIM}назвать средой машину со старой меткой «${LABEL_BASE}»${OFF}"
    say ""
    say "${DIM}то же через make — только с RELEASE=/path/release.json: без него make vast-up ·${OFF}"
    say "${DIM}vast-status · vast-sync · vast-logs · vast-down ведут в прежний scripts/vast-legacy.sh${OFF}"
    say "${DIM}Среда — это отдельная машина: отдельные деньги и отдельные данные.${OFF}"
    if [ -n "$CMD" ]; then die "не знаю команды «${CMD}»."; fi
    ;;
esac
