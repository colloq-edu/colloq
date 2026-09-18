#!/usr/bin/env bash
#
# Выложить зеркало colloq.cc: воркер, маршруты, записи DNS.
#
# Голым curl, без wrangler, и это выбор, а не обход. `npx wrangler` тянет из
# сети полсотни пакетов и требует отдельного входа в аккаунт; чинят же зеркало
# обычно ровно тогда, когда с сетью и так плохо, а токен для Cloudflare в этом
# репозитории уже есть — им живёт scripts/dns.sh. Всё, что нужно воркеру, —
# три вызова API, и они здесь написаны прямо.
#
# Скрипт приводит аккаунт и зону к нужному виду, а не досыпает в них — как и
# scripts/dns.sh, у которого та же болезнь лечилась тем же способом. Запускать
# сколько угодно раз подряд: совпадающее не трогается, лишнее убирается,
# недостающее создаётся.
#
#   deploy.sh                что есть и что будет сделано + выкладка
#   deploy.sh --dry-run      только рассказать, ничего не менять
#   deploy.sh --down         снять зеркало целиком (маршруты, DNS, воркер)
#
# Токен берётся из .env репозитория тем же read_env, что у dns.sh. Годится
# либо CF_TOKEN_CC (если для .cc завели отдельный), либо общий CF_TOKEN —
# лишь бы у него были права, перечисленные в README рядом.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/../../.." && pwd)"

# Тем же порядком, что у dns.sh: COLLOQ_HOME сильнее корня репозитория —
# у поставленного через pip colloq .env лежит в каталоге состояния, а не рядом
# с приложением. Двумя строками, а не присваиванием перед `.`: bash снял бы
# временное значение сразу после встроенной команды, а read_env зовут потом.
ENV_FILE="${COLLOQ_HOME:-$ROOT}/.env"
. "$ROOT/scripts/lib.sh"

RED=$'\033[31m'; DIM=$'\033[2m'; OFF=$'\033[0m'
die() { printf '%s%s%s\n' "$RED" "$*" "$OFF" >&2; exit 1; }

DRY=0; DOWN=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    --dry-run|-n) DRY=1 ;;
    --down) DOWN=1 ;;
    -h|--help) sed -n '2,25p' "${BASH_SOURCE[0]}" | sed 's/^#\{1,2\} \{0,1\}//'; exit 0 ;;
    *) die "unknown argument: $1 (see --help)" ;;
  esac
  shift
done

# ------------------------------------------------------- настройки из toml
#
# Имя, дата совместимости и маршруты читаются из wrangler.toml, а не лежат
# здесь второй копией: иначе правка маршрута в одном файле молча разъезжалась
# бы со вторым, и выкладка с чужой машины возвращала бы зеркало к прежнему.
TOML="$HERE/wrangler.toml"
[[ -f "$TOML" ]] || die "no wrangler.toml next to this script"

NAME=$(sed -nE 's/^name[[:space:]]*=[[:space:]]*"([^"]+)".*/\1/p' "$TOML" | head -1)
COMPAT=$(sed -nE 's/^compatibility_date[[:space:]]*=[[:space:]]*"([^"]+)".*/\1/p' "$TOML" | head -1)
MAIN=$(sed -nE 's/^main[[:space:]]*=[[:space:]]*"([^"]+)".*/\1/p' "$TOML" | head -1)
ZONE_NAME=$(sed -nE 's/^zone_name[[:space:]]*=[[:space:]]*"([^"]+)".*/\1/p' "$TOML" | head -1)
# Через while-read, а не mapfile: в macOS штатный bash — 3.2, и mapfile там нет
# вовсе. Makefile зовёт именно /bin/bash, так что проверять это будет каждый.
PATTERNS=()
while read -r p; do [[ -n "$p" ]] && PATTERNS+=("$p"); done < <(
  sed -nE 's/^pattern[[:space:]]*=[[:space:]]*"([^"]+)".*/\1/p' "$TOML")

[[ -n "$NAME" && -n "$COMPAT" && -n "$MAIN" && -n "$ZONE_NAME" && ${#PATTERNS[@]} -gt 0 ]] \
  || die "wrangler.toml is missing name/main/compatibility_date/zone_name/routes"
[[ -f "$HERE/$MAIN" ]] || die "wrangler.toml points at $MAIN, and there is no such file"

# Имена, которым нужна запись в DNS: это маршруты без «/*». Отдельным списком
# их не держим по той же причине — один источник правды.
HOSTNAMES=()
for p in "${PATTERNS[@]}"; do HOSTNAMES+=("${p%%/*}"); done

# ---------------------------------------------------------------- доступ

if [[ -z "${CF_TOKEN_CC:-}" ]]; then CF_TOKEN_CC=$(read_env CF_TOKEN_CC); fi
if [[ -z "$CF_TOKEN_CC" ]]; then CF_TOKEN_CC="${CF_TOKEN:-}"; fi
if [[ -z "$CF_TOKEN_CC" ]]; then CF_TOKEN_CC=$(read_env CF_TOKEN); fi
: "${CF_TOKEN_CC:?a Cloudflare token is needed: CF_TOKEN_CC or CF_TOKEN in .env (see README.md for the permissions)}"

API=https://api.cloudflare.com/client/v4

# Токен не попадает в argv НИ ОДНОГО процесса: printf — встроенная команда
# bash, отдельного процесса под неё не заводится, а curl читает заголовок из
# своего файла настроек на stdin. Через `-H "Authorization: …"` он был бы виден
# в `ps` любому на машине — в том числе в журналах CI.
api() {
  local method=$1 path=$2; shift 2
  printf 'header = "Authorization: Bearer %s"\n' "$CF_TOKEN_CC" \
    | curl -sS -K - -X "$method" "$API$path" "$@"
}

# Ответ Cloudflare проверяется всегда, а не выбрасывается в /dev/null. Без
# этого «создано» печаталось бы и тогда, когда прав не хватило, — а узнавали бы
# об этом по неоткрывающемуся сайту.
check() {
  local resp=$1 what=$2
  if ! printf '%s' "$resp" | python3 -c 'import json,sys; sys.exit(0 if json.load(sys.stdin).get("success") else 1)' 2>/dev/null; then
    printf '%s\n' "$resp" | python3 -c '
import json, sys
try:
    errs = json.load(sys.stdin).get("errors") or []
    for e in errs:
        print("  cloudflare:", e.get("code"), e.get("message"))
except Exception:
    pass' >&2 || printf '%s\n' "$resp" | head -c 400 >&2
    die "$what"
  fi
}

# ------------------------------------------------------------ что за зона

ZONE_ID="${CF_ZONE_CC:-$(read_env CF_ZONE_CC)}"
ZONE_JSON=""
if [[ -z "$ZONE_ID" ]]; then
  ZONE_JSON=$(api GET "/zones?name=$ZONE_NAME")
  check "$ZONE_JSON" "this token cannot list zones (Zone: Read is missing)"
  ZONE_ID=$(printf '%s' "$ZONE_JSON" | python3 -c '
import json,sys
z = (json.load(sys.stdin).get("result") or [None])[0]
print(z["id"] if z else "")')
else
  ZONE_JSON=$(api GET "/zones/$ZONE_ID")
  check "$ZONE_JSON" "this token cannot read the zone $ZONE_NAME"
fi
[[ -n "$ZONE_ID" ]] || die "the zone ${ZONE_NAME} is not visible to this token.
  Either it is not in this Cloudflare account, or the token has no Zone: Read on it.
  See README.md, section «Token permissions»."

# Аккаунт берётся ИЗ ЗОНЫ, а не из CF_ACCOUNT_ID в .env: воркер обязан лежать
# в том же аккаунте, которому принадлежит зона, иначе маршрут в ней не найдёт,
# к чему привязаться. CF_ACCOUNT_ID в .env заведён под colloq.ru и тут был бы
# не подсказкой, а способом выложить воркер не туда.
read -r ACCOUNT_ID ZONE_STATUS < <(printf '%s' "$ZONE_JSON" | python3 -c '
import json,sys
d = json.load(sys.stdin).get("result")
z = d[0] if isinstance(d, list) else d
print((z.get("account") or {}).get("id", ""), z.get("status", "?"))')
[[ -n "$ACCOUNT_ID" ]] || die "the API did not say which account owns ${ZONE_NAME}"

printf 'zone %s: %s (%s), account %s\n' "$ZONE_NAME" "${ZONE_ID:0:8}…" "$ZONE_STATUS" "${ACCOUNT_ID:0:8}…"
if [[ "$ZONE_STATUS" != active ]]; then
  printf '%s  зона не active: пока делегирование не доедет, зеркало не откроется%s\n' "$DIM" "$OFF"
fi

# ------------------------------------------------------------------ снять

if (( DOWN )); then
  echo "removing the mirror:"
  routes=$(api GET "/zones/$ZONE_ID/workers/routes"); check "$routes" "cannot list worker routes"
  while read -r id pattern; do
    [[ -n "${id:-}" ]] || continue
    if (( DRY )); then printf '  would remove route  %s\n' "$pattern"; continue; fi
    check "$(api DELETE "/zones/$ZONE_ID/workers/routes/$id")" "cannot remove route $pattern"
    printf '  removed   route     %s\n' "$pattern"
  done < <(printf '%s' "$routes" | NAME="$NAME" python3 -c '
import json,os,sys
for r in json.load(sys.stdin).get("result") or []:
    if r.get("script") == os.environ["NAME"]:
        print(r["id"], r["pattern"])')

  records=$(api GET "/zones/$ZONE_ID/dns_records?per_page=200"); check "$records" "cannot list dns records"
  while read -r id type name; do
    [[ -n "${id:-}" ]] || continue
    if (( DRY )); then printf '  would remove dns    %-5s %s\n' "$type" "$name"; continue; fi
    check "$(api DELETE "/zones/$ZONE_ID/dns_records/$id")" "cannot remove $type $name"
    printf '  removed   dns       %-5s %s\n' "$type" "$name"
  done < <(printf '%s' "$records" | HOSTS="${HOSTNAMES[*]}" python3 -c '
import json,os,sys
hosts = set(os.environ["HOSTS"].split())
for r in json.load(sys.stdin).get("result") or []:
    if r["type"] == "AAAA" and r["name"] in hosts and r["content"] in ("100::", "100:0:0:0:0:0:0:0"):
        print(r["id"], r["type"], r["name"])')

  if (( DRY )); then printf '  would remove worker %s\n' "$NAME"; else
    check "$(api DELETE "/accounts/$ACCOUNT_ID/workers/scripts/$NAME?force=true")" "cannot remove the worker $NAME"
    printf '  removed   worker    %s\n' "$NAME"
  fi
  echo
  echo "colloq.ru is untouched: it never went through Cloudflare in the first place."
  exit 0
fi

# --------------------------------------------------------------- выложить

# 1. Воркер. Модульный формат: metadata называет главный модуль, и часть с
#    кодом обязана называться ровно так же.
existing=$(api GET "/accounts/$ACCOUNT_ID/workers/scripts")
check "$existing" "this token cannot see workers in this account (Account · Workers Scripts: Edit is missing)"
had=$(printf '%s' "$existing" | NAME="$NAME" python3 -c '
import json,os,sys
print("yes" if any(s.get("id") == os.environ["NAME"] for s in json.load(sys.stdin).get("result") or []) else "no")')

if (( DRY )); then
  printf '  would upload worker %s (%s, compat %s, %s bytes) — %s\n' \
    "$NAME" "$MAIN" "$COMPAT" "$(wc -c < "$HERE/$MAIN" | tr -d ' ')" \
    "$([[ $had == yes ]] && echo 'replacing the existing one' || echo 'new')"
else
  TMP=$(mktemp -d); trap 'rm -rf "$TMP"' EXIT
  printf '{"main_module":"%s","compatibility_date":"%s","bindings":[]}' "$MAIN" "$COMPAT" \
    > "$TMP/metadata.json"
  resp=$(api PUT "/accounts/$ACCOUNT_ID/workers/scripts/$NAME" \
    -F "metadata=<$TMP/metadata.json;type=application/json" \
    -F "$MAIN=@$HERE/$MAIN;type=application/javascript+module")
  check "$resp" "cannot upload the worker $NAME (Account · Workers Scripts: Edit?)"
  printf '  %-9s worker    %s\n' "$([[ $had == yes ]] && echo replaced || echo created)" "$NAME"
fi

# 2. Маршруты. Существующий с тем же образцом не пересоздаётся, а правится:
#    удалить и создать заново означало бы окно, в котором имя не отвечает.
routes=$(api GET "/zones/$ZONE_ID/workers/routes")
check "$routes" "this token cannot see worker routes in ${ZONE_NAME} (Zone · Workers Routes: Edit is missing)"

for pattern in "${PATTERNS[@]}"; do
  read -r id script < <(printf '%s' "$routes" | PATTERN="$pattern" python3 -c '
import json,os,sys
want = os.environ["PATTERN"]
for r in json.load(sys.stdin).get("result") or []:
    if r.get("pattern") == want:
        print(r["id"], r.get("script") or "-"); break
else:
    print("", "")')
  if [[ -n "${id:-}" && "${script:-}" == "$NAME" ]]; then
    printf '  in place  route     %s -> %s\n' "$pattern" "$NAME"
  elif [[ -n "${id:-}" ]]; then
    if (( DRY )); then printf '  would repoint route %s: %s -> %s\n' "$pattern" "$script" "$NAME"; continue; fi
    check "$(api PUT "/zones/$ZONE_ID/workers/routes/$id" -H 'content-type: application/json' \
      --data "$(printf '{"pattern":"%s","script":"%s"}' "$pattern" "$NAME")")" \
      "cannot repoint route $pattern"
    printf '  repointed route     %s -> %s\n' "$pattern" "$NAME"
  else
    if (( DRY )); then printf '  would create route  %s -> %s\n' "$pattern" "$NAME"; continue; fi
    check "$(api POST "/zones/$ZONE_ID/workers/routes" -H 'content-type: application/json' \
      --data "$(printf '{"pattern":"%s","script":"%s"}' "$pattern" "$NAME")")" \
      "cannot create route $pattern"
    printf '  created   route     %s -> %s\n' "$pattern" "$NAME"
  fi
done

# 3. DNS. Маршрут воркера срабатывает только если имя вообще резолвится и идёт
#    ЧЕРЕЗ Cloudflare, поэтому на апекс и www ставится проксированная заглушка.
#
#    100:: — это префикс-сток из RFC 6666, «выбросить пакет». Выбран он нарочно
#    вместо какого-нибудь настоящего адреса: если маршрут воркера однажды снимут
#    или он отвалится, запрос упадёт сразу, а не уедет тихо на чью-то чужую
#    машину. Тип AAAA при этом не оставляет за бортом клиентов без IPv6:
#    проксированному имени Cloudflare раздаёт и A, и AAAA своих пограничных
#    адресов, а запись за облаком видит только он сам.
#
#    Трогаются только A, AAAA и CNAME на этих именах: MX, TXT и всё, чем живёт
#    почта, остаются на месте. Иначе первый же запуск снёс бы домену почту.
records=$(api GET "/zones/$ZONE_ID/dns_records?per_page=200")
check "$records" "this token cannot see DNS in ${ZONE_NAME} (Zone · DNS: Edit is missing)"

for host in "${HOSTNAMES[@]}"; do
  keep=""
  while read -r id type content proxied; do
    [[ -n "${id:-}" ]] || continue
    if [[ "$type" == AAAA && "$content" == "100::" && "$proxied" == 1 && -z "$keep" ]]; then
      keep=$id
      printf '  in place  dns       AAAA  %-16s -> 100:: (proxied)\n' "$host"
      continue
    fi
    if (( DRY )); then printf '  would remove dns    %-5s %-16s -> %s\n' "$type" "$host" "$content"; continue; fi
    check "$(api DELETE "/zones/$ZONE_ID/dns_records/$id")" "cannot remove $type $host"
    printf '  removed   dns       %-5s %-16s -> %s%s\n' "$type" "$host" "$content" \
      "$([[ $proxied == 1 ]] && echo ' (was proxied)')"
  done < <(printf '%s' "$records" | HOST="$host" python3 -c '
import json,os,sys
host = os.environ["HOST"]
for r in json.load(sys.stdin).get("result") or []:
    if r["name"] == host and r["type"] in ("A", "AAAA", "CNAME"):
        print(r["id"], r["type"], r["content"], int(bool(r.get("proxied"))))')

  [[ -z "$keep" ]] || continue
  if (( DRY )); then printf '  would create dns    AAAA  %-16s -> 100:: (proxied)\n' "$host"; continue; fi
  # ttl 1 — «автоматически»; проксированная запись другого ttl не принимает.
  check "$(api POST "/zones/$ZONE_ID/dns_records" -H 'content-type: application/json' \
    --data "$(printf '{"type":"AAAA","name":"%s","content":"100::","ttl":1,"proxied":true}' "$host")")" \
    "cannot create the placeholder AAAA for $host"
  printf '  created   dns       AAAA  %-16s -> 100:: (proxied)\n' "$host"
done

echo
if (( DRY )); then
  echo "dry run: nothing was changed."
  exit 0
fi
cat <<EOF
done. Check it (give the edge a minute to pick the route up):

  curl -sI https://${HOSTNAMES[0]}/            | grep -iE 'HTTP|x-colloq-mirror|cache-control'
  curl -sI https://${HOSTNAMES[0]}/docs        | grep -i location     # -> https://${HOSTNAMES[0]}/docs/
  curl -sI https://www.${HOSTNAMES[0]}/docs/   | grep -i location     # -> apex
  curl -s  -o /dev/null -w '%{http_code}\\n' -X POST https://${HOSTNAMES[0]}/   # -> 405

colloq.ru is not touched by any of this: it stays grey-clouded, straight on
GitHub Pages, because Cloudflare's addresses do not open from Russia.
EOF
