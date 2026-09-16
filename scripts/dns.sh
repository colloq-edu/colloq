#!/usr/bin/env bash
#
# Записи DNS для colloq.ru.
#
# Скрипт приводит зону к нужному виду, а не досыпает в неё записи. Разница не
# косметическая: домен приехал из Рег.ру с парковочными A-записями, и если
# просто добавить рядом адреса GitHub Pages, посетитель будет попадать то на
# сайт, то на заглушку — round-robin честно раздаст и то и другое. Поэтому для
# каждой пары «тип + имя» лишнее удаляется, недостающее создаётся, совпадающее
# не трогается, и запускать это можно сколько угодно раз подряд.
#
# Главное, ради чего всё: **серое облако везде**. Оранжевое означает, что
# посетитель идёт на пограничные адреса Cloudflare, а они из России не
# открываются — лендинг на colloq.sleep3r.ru не грузился ровно до того дня,
# когда с него сняли проксирование. Апекс colloq.ru приехал проксированным,
# и это здесь исправляется.
#
# Токен берётся из .env основного репозитория; нужны Zone:Read и DNS:Edit на
# зону colloq.ru.
#
# Входа два:
#
#   scripts/dns.sh                       привести всю зону к нужному виду:
#                                        лендинг, www и *.colloq.ru на ретранслятор
#   scripts/dns.sh point <имя> <адрес>   одна A-запись: имя → адрес машины
#
# Второй появился не ради удобства. Его зовёт прямой режим `make host-direct`:
# машина с белым адресом принимает пару сама, и её имя должно смотреть на неё,
# а не на ретранслятор. Своей копии этой логики у host.sh нет намеренно —
# «удалить лишнее, создать недостающее, никогда не оставлять проксирование»
# написано здесь один раз и здесь же чинится.
set -euo pipefail
cd "$(dirname "$0")"

# Режим разбирается до всего остального: в режиме point ни лендинг, ни www, ни
# звёздочка не трогаются вовсе — иначе `make host-direct` посреди пары
# переписывал бы записи, о которых его не просили.
MODE=zone
if [[ "${1:-}" == point ]]; then
  MODE=point
  POINT_NAME=${2:?scripts/dns.sh point <name> <address>}
  POINT_ADDR=${3:?scripts/dns.sh point <name> <address>}
fi

# ../.env, а не ../colloq/.env: скрипт приехал из соседнего репозитория, где
# основной клон лежал рядом. Здесь он лежит выше, и прежний путь не существовал
# ни в одном клоне — вместо «нет файла» человек читал «нужен токен с Zone:Read»
# и шёл проверять права токена, который всё это время лежал в .env.
#
# Читает файл общий read_env (scripts/lib.sh) — тот же, которым живут host.sh,
# service.sh и vast.sh.
#
# Двумя строками, а не `ENV_FILE=../.env . ./lib.sh`: присваивание перед
# встроенной командой bash считает временным и после возврата снимает — а
# read_env зовут потом, и файл настроек ему нужен уже настоящий.
#
# COLLOQ_HOME сильнее «этажом выше»: у поставленного через pip colloq этажом
# выше лежит только каталог приложения (доступный на чтение и сносимый
# обновлением), а .env с CF_TOKEN — в каталоге состояния. Без переменной всё
# как было: ../.env, то есть корень репозитория.
ENV_FILE="${COLLOQ_HOME:-..}/.env"
. ./lib.sh

DOMAIN=${DOMAIN:-colloq.ru}
# Куда смотрят семинары. Тот же адрес, что в RELAY_ADDR у инстансов, и берётся
# он оттуда же — из .env, а не из прибитой строки.
#
# Прибитое умолчание здесь было ловушкой: RELAY_ADDR из .env скрипт не читал
# вовсе, и после переезда ретранслятора любой заход «привести зону в порядок»
# (а это единственный способ вернуть имя после host-direct) молча возвращал
# `*.colloq.ru` на старый адрес — то есть уводил все семинары на мёртвую
# машину. Нет адреса — нет и записи: об этом сказано вслух ниже.
RELAY="${RELAY_ADDR:-$(read_env RELAY_ADDR)}"
# Чья страница на GitHub Pages — цель CNAME для www.
PAGES_HOST=${PAGES_HOST:-sleep3r.github.io}

if [[ -z "${CF_TOKEN_COLLOQ:-}" ]]; then
  # `|| true` внутри read_env: файл есть, а строки в нём нет — это «нужен
  # токен», а не молчаливый выход по set -e без единого слова на экране.
  CF_TOKEN_COLLOQ=$(read_env CF_TOKEN)
fi
: "${CF_TOKEN_COLLOQ:?a token with Zone:Read and DNS:Edit on ${DOMAIN} is needed}"

# Идентификатор зоны лежит в том же .env соседней строкой с токеном, а читался
# только из окружения. Из-за этого он не использовался никогда: зона искалась
# запросом, и токену без права листать зоны скрипт отвечал «зона этому токену
# не видна» — при том что её id был у него под рукой.
if [[ -z "${CF_ZONE_COLLOQ:-}" ]]; then
  CF_ZONE_COLLOQ=$(read_env CF_ZONE)
fi

API=https://api.cloudflare.com/client/v4
AUTH=(-H "Authorization: Bearer $CF_TOKEN_COLLOQ" -H "content-type: application/json")

RED=$'\033[31m'; OFF=$'\033[0m'
die() { printf '%s%s%s\n' "$RED" "$*" "$OFF" >&2; exit 1; }

# zone_id_for ИМЯ — в какой зоне живёт это имя.
#
# Спрашивать `?name=hse.colloq.ru` бесполезно: такой зоны нет, а Cloudflare
# отвечает на это не ошибкой, а пустым списком. Поэтому берётся список зон
# токена и из них самая длинная, которой запрошенное имя заканчивается:
# для hse.colloq.ru это colloq.ru, и то же правило работает для чужой зоны,
# если однажды инстанс встанет не под colloq.ru.
#
# И — без параметра status. Его допустимые значения это active, pending и
# подобные; «all» не из их числа, и Cloudflare на него опять же не ругается,
# а молча отдаёт пустой список. На этом можно потерять час, решив, что у
# токена нет доступа.
zone_id_for() {
  local want=$1 id=""
  # Явно названная зона сильнее поиска — но только если речь о ней же:
  # CF_ZONE от colloq.ru для имени в чужой зоне это не подсказка, а ошибка,
  # которая пишет запись не туда.
  if [[ -n "${CF_ZONE_COLLOQ:-}" && ( "$want" == "$DOMAIN" || "$want" == *".$DOMAIN" ) ]]; then
    printf '%s' "$CF_ZONE_COLLOQ"
    return 0
  fi
  id=$(curl -s "${AUTH[@]}" "$API/zones?per_page=200" | WANT="$want" python3 -c '
import json, os, sys
want = os.environ["WANT"]
best = best_id = ""
try:
    zones = json.load(sys.stdin).get("result") or []
except Exception:
    zones = []
for z in zones:
    name = z.get("name") or ""
    if (want == name or want.endswith("." + name)) and len(name) > len(best):
        best, best_id = name, z.get("id") or ""
print(best_id)' 2>/dev/null || true)
  printf '%s' "$id"
}

fetch() { curl -s "${AUTH[@]}" "$API/zones/$zone/dns_records?per_page=200"; }

# reconcile ТИП ИМЯ [СОДЕРЖИМОЕ...]
#
# Приводит все записи данного типа с данным именем ровно к перечисленному
# списку. Пустой список означает «таких записей быть не должно» — так www
# избавляется от парковочной A, прежде чем стать CNAME: Cloudflare не даст
# держать CNAME рядом с A на одном имени.
reconcile() {
  local type=$1 name=$2; shift 2
  local want=("$@")
  local records id content proxied keep w

  records=$(fetch)
  while read -r id content proxied; do
    [[ -n "${id:-}" ]] || continue
    keep=0
    # Проксированную запись сохранять нельзя даже с верным адресом: оранжевое
    # облако и есть то, из-за чего сайт не открывается.
    for w in ${want[@]+"${want[@]}"}; do
      [[ "$content" == "$w" && "$proxied" == "0" ]] && keep=1
    done
    if (( keep == 0 )); then
      curl -s -X DELETE "${AUTH[@]}" "$API/zones/$zone/dns_records/$id" >/dev/null
      printf '  removed   %-5s %-16s -> %s%s\n' "$type" "$name" "$content" \
        "$([[ $proxied == 1 ]] && echo ' (was proxied)')"
    fi
  done < <(printf '%s' "$records" | python3 -c "
import json,sys
for r in json.load(sys.stdin)['result']:
    if r['type']=='$type' and r['name']=='$name':
        print(r['id'], r['content'], int(bool(r.get('proxied'))))")

  [[ ${#want[@]} -gt 0 ]] || return 0

  local have
  have=$(fetch | python3 -c "
import json,sys
print(' '.join(r['content'] for r in json.load(sys.stdin)['result']
      if r['type']=='$type' and r['name']=='$name' and not r.get('proxied')))")

  local resp
  for w in "${want[@]}"; do
    if [[ " $have " == *" $w "* ]]; then
      printf '  in place  %-5s %-16s -> %s\n' "$type" "$name" "$w"
      continue
    fi
    resp=$(curl -s -X POST "${AUTH[@]}" "$API/zones/$zone/dns_records" \
      --data "$(printf '{"type":"%s","name":"%s","content":"%s","ttl":300,"proxied":false}' \
                "$type" "$name" "$w")")
    # Ответ проверяется, а не выбрасывается. Раньше он уходил в /dev/null, и
    # строка «создано» печаталась в том числе тогда, когда Cloudflare отказал —
    # обычно из-за CNAME на том же имени или токена без DNS:Edit. Для зоны это
    # означало «сайт почему-то не открылся», а для прямого режима — машину,
    # которая ждёт сертификат на имя, никуда не указывающее.
    if [[ "$resp" == *'"success":true'* || "$resp" == *'"success": true'* ]]; then
      printf '  created   %-5s %-16s -> %s\n' "$type" "$name" "$w"
    else
      printf '%s\n' "$resp" | head -c 400 >&2; printf '\n' >&2
      die "Cloudflare did not create ${type} ${name} -> ${w}"
    fi
  done
}

# ------------------------------------------------------------- что делаем

# Одна запись: имя → адрес машины. Больше в зоне не трогается ничего.
if [[ "$MODE" == point ]]; then
  zone=$(zone_id_for "$POINT_NAME")
  [[ -n "$zone" ]] || die "this token cannot see the zone for ${POINT_NAME} (CF_TOKEN, CF_ZONE in .env)"
  # Сначала снять CNAME с этого имени, потом ставить A — ровно та же причина,
  # что у www ниже: Cloudflare не даёт держать их рядом. Случай не выдуманный:
  # имя, которое когда-то заводил `make tunnel-setup`, держит CNAME на
  # <id>.cfargotunnel.com, и без этой строки прямой режим на нём отказывал бы
  # со ссылкой на конфликт записей.
  reconcile CNAME "$POINT_NAME"
  # Без проксирования — это здесь главное и единственное. Оранжевое облако
  # увело бы студентов на пограничные адреса Cloudflare, а они из России не
  # открываются: семинар стал бы недоступен ровно той аудитории, ради которой
  # его и выставляют. Прямой режим тем и ценен, что между машиной и залом нет
  # никого; проксирование вернуло бы посредника, да ещё и закрытого.
  reconcile A "$POINT_NAME" "$POINT_ADDR"
  exit 0
fi

# Адрес ретранслятора спрашивается до первой правки зоны, а не перед самой
# звёздочкой: лендинг и www приводятся в порядок раньше её, и отказ на середине
# оставил бы зону наполовину переписанной.
[[ -n "$RELAY" ]] || die "I do not know where to point *.${DOMAIN}: ../.env has no RELAY_ADDR.
  That is the address of the relay (make relay-setup prints it). For one run it
  can also be named like this: RELAY_ADDR=1.2.3.4 scripts/dns.sh"

zone=$(zone_id_for "$DOMAIN")
[[ -n "$zone" ]] || die "this token cannot see the zone ${DOMAIN}"
echo "zone ${DOMAIN}: $zone"

echo "landing page on GitHub Pages:"
reconcile A "$DOMAIN" 185.199.108.153 185.199.109.153 185.199.110.153 185.199.111.153
# Без AAAA посетитель на чистом IPv6 не откроет сайт вовсе.
reconcile AAAA "$DOMAIN" 2606:50c0:8000::153 2606:50c0:8001::153 2606:50c0:8002::153 2606:50c0:8003::153
# Сначала снять парковочную A с www, потом ставить CNAME — иначе Cloudflare
# откажет: CNAME и A на одном имени не уживаются.
reconcile A "www.$DOMAIN"
reconcile CNAME "www.$DOMAIN" "$PAGES_HOST"

echo "classes on the relay:"
# Одной звёздочкой, а не именем на каждый университет: поддомены раздаёт frps
# по общему секрету, и запись в DNS на каждого означала бы самообслуживание
# на ручном приводе.
reconcile A "*.$DOMAIN" "$RELAY"

echo
echo "done. Next:"
echo "  1. push the landing page: CNAME in the repository already points at ${DOMAIN}"
echo "  2. wait for the Pages certificate on ${DOMAIN}"
echo "  3. check from a phone WITHOUT a VPN: https://${DOMAIN}"
echo "  4. publish a class:  make host HOST=hse.${DOMAIN}"
