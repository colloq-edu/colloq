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
set -euo pipefail
cd "$(dirname "$0")"

DOMAIN=${DOMAIN:-colloq.ru}
# Куда смотрят семинары. Тот же адрес, что в RELAY_ADDR у инстансов.
RELAY=${RELAY_ADDR:-203.0.113.11}
# Чья страница на GitHub Pages — цель CNAME для www.
PAGES_HOST=${PAGES_HOST:-sleep3r.github.io}

if [[ -z "${CF_TOKEN_COLLOQ:-}" && -f ../colloq/.env ]]; then
  CF_TOKEN_COLLOQ=$(grep -E '^CF_TOKEN=' ../colloq/.env | tail -1 | cut -d= -f2- | tr -d ' \r')
fi
: "${CF_TOKEN_COLLOQ:?нужен токен с Zone:Read и DNS:Edit на ${DOMAIN}}"

API=https://api.cloudflare.com/client/v4
AUTH=(-H "Authorization: Bearer $CF_TOKEN_COLLOQ" -H "content-type: application/json")

# Поиск зоны по имени — без параметра status. Его допустимые значения это
# active, pending и подобные; «all» не из их числа, и Cloudflare на него не
# ругается, а молча отдаёт пустой список. На этом можно потерять час, решив,
# что у токена нет доступа.
zone=${CF_ZONE_COLLOQ:-$(curl -s "${AUTH[@]}" "$API/zones?name=${DOMAIN}" |
  python3 -c 'import json,sys; r=(json.load(sys.stdin).get("result") or []); print(r[0]["id"] if r else "")')}
[[ -n "$zone" ]] || { echo "зона ${DOMAIN} этому токену не видна" >&2; exit 1; }
echo "зона ${DOMAIN}: $zone"

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
      printf '  убрано    %-5s %-16s -> %s%s\n' "$type" "$name" "$content" \
        "$([[ $proxied == 1 ]] && echo ' (было проксировано)')"
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

  for w in "${want[@]}"; do
    if [[ " $have " == *" $w "* ]]; then
      printf '  на месте  %-5s %-16s -> %s\n' "$type" "$name" "$w"
      continue
    fi
    curl -s -X POST "${AUTH[@]}" "$API/zones/$zone/dns_records" \
      --data "$(printf '{"type":"%s","name":"%s","content":"%s","ttl":300,"proxied":false}' \
                "$type" "$name" "$w")" >/dev/null
    printf '  создано   %-5s %-16s -> %s\n' "$type" "$name" "$w"
  done
}

echo "лендинг на GitHub Pages:"
reconcile A "$DOMAIN" 185.199.108.153 185.199.109.153 185.199.110.153 185.199.111.153
# Без AAAA посетитель на чистом IPv6 не откроет сайт вовсе.
reconcile AAAA "$DOMAIN" 2606:50c0:8000::153 2606:50c0:8001::153 2606:50c0:8002::153 2606:50c0:8003::153
# Сначала снять парковочную A с www, потом ставить CNAME — иначе Cloudflare
# откажет: CNAME и A на одном имени не уживаются.
reconcile A "www.$DOMAIN"
reconcile CNAME "www.$DOMAIN" "$PAGES_HOST"

echo "семинары на ретранслятор:"
# Одной звёздочкой, а не именем на каждый университет: поддомены раздаёт frps
# по общему секрету, и запись в DNS на каждого означала бы самообслуживание
# на ручном приводе.
reconcile A "*.$DOMAIN" "$RELAY"

echo
echo "готово. Дальше:"
echo "  1. запушить лендинг: CNAME в репозитории уже указывает на ${DOMAIN}"
echo "  2. дождаться сертификата Pages на ${DOMAIN}"
echo "  3. проверить с телефона БЕЗ VPN: https://${DOMAIN}"
echo "  4. семинар наружу:  make host HOST=hse.${DOMAIN}"
