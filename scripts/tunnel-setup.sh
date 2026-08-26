#!/usr/bin/env bash
#
# Один раз завести постоянный адрес для семинаров.
#
# Быстрый туннель (make host) выдаёт случайное имя вида
# https://calm-fox-rides.trycloudflare.com и новое на каждый запуск. Для одной
# пары это нормально, но ссылку из прошлой недели уже не переоткрыть, и в
# расписание её не поставишь. Постоянный адрес заводится один раз и живёт.
#
#     ./scripts/tunnel-setup.sh seminar.sleep3r.ru
#
# После этого `make host HOST=seminar.sleep3r.ru` всегда поднимает этот адрес.
#
set -euo pipefail

cd "$(dirname "$0")/.."

RED=$'\033[31m'; DIM=$'\033[2m'; BOLD=$'\033[1m'; CYAN=$'\033[36m'; OFF=$'\033[0m'
say() { printf '%s\n' "$*"; }
die() { printf '%s%s%s\n' "$RED" "$*" "$OFF" >&2; exit 1; }

HOSTNAME_ARG="${1:-}"
[ -n "$HOSTNAME_ARG" ] || die "Укажите адрес: ./scripts/tunnel-setup.sh seminar.sleep3r.ru"

command -v cloudflared >/dev/null 2>&1 || die \
  "cloudflared не установлен. brew install cloudflared — и запустите снова."

TUNNEL="${COLLOQ_TUNNEL_NAME:-colloq}"

# Логин кладёт ~/.cloudflared/cert.pem — сертификат, которым cloudflared имеет
# право заводить туннели и писать DNS в вашей зоне. Это не тот же токен, что
# CF_TOKEN в .env: тот выдан только на DNS-записи и туннель создать не может.
if [ ! -f "$HOME/.cloudflared/cert.pem" ]; then
  say "${BOLD}1/3${OFF} нужен вход в Cloudflare — откроется браузер"
  say "${DIM}    выберите зону, которой принадлежит ${HOSTNAME_ARG}${OFF}"
  cloudflared tunnel login
else
  say "${BOLD}1/3${OFF} вход в Cloudflare уже есть"
fi

say "${BOLD}2/3${OFF} туннель «${TUNNEL}»"
if cloudflared tunnel list 2>/dev/null | awk '{print $2}' | grep -qx "$TUNNEL"; then
  say "${DIM}    уже существует, повторно не создаю${OFF}"
else
  cloudflared tunnel create "$TUNNEL"
fi

# route dns создаёт CNAME <hostname> -> <tunnel-id>.cfargotunnel.com.
# Если запись уже есть и указывает не туда, Cloudflare откажет — это защита от
# того, чтобы туннель молча перехватил чужой поддомен.
say "${BOLD}3/3${OFF} адрес ${HOSTNAME_ARG}"
if cloudflared tunnel route dns "$TUNNEL" "$HOSTNAME_ARG" 2>&1 | tee /dev/stderr | grep -qi "already exists"; then
  say "${DIM}    запись уже была — оставляю как есть${OFF}"
fi

printf '\n'
say "${BOLD}Готово.${OFF} Теперь семинар поднимается так:"
say "  ${CYAN}make host HOST=${HOSTNAME_ARG}${OFF}"
printf '\n'
say "${DIM}Постоянный адрес имеет смысл поставить в расписание: он не меняется${OFF}"
say "${DIM}между парами, в отличие от быстрого туннеля.${OFF}"
