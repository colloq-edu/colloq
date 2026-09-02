#!/usr/bin/env bash
#
# Ретранслятор для *.colloq.ru — то, чем Colloq заменяет Cloudflare Tunnel.
#
# Зачем вообще. Туннель Cloudflare всегда упирается в пограничные адреса
# Cloudflare: запись вида *.cfargotunnel.com имеет смысл только для их прокси,
# снять оранжевое облако с неё нельзя. А эти адреса из России не открываются —
# лендинг на colloq.sleep3r.ru не грузился ровно до того дня, когда с него
# сняли проксирование. Значит, семинар, выставленный наружу через Cloudflare,
# недоступен той самой аудитории, для которой он и делается.
#
# Отсюда всё остальное. Нужен свой вход: машина с публичным адресом, на который
# российские сети ходят, DNS без проксирования, и способ дотянуться до
# инстанса, который сам сидит за NAT — в аудитории, на ноутбуке преподавателя.
#
# Здесь два демона и ничего больше:
#
#   caddy  держит 443, выдаёт сертификаты и передаёт запрос дальше по имени
#          хоста. Сертификат берётся по требованию, при первом обращении к
#          имени, а не одной звёздочкой на всё: тогда на этой машине не нужно
#          хранить ключ от DNS, и компрометация коробки не отдаёт сертификат
#          сразу на все семинары.
#
#   frps   принимает исходящие соединения от инстансов и раздаёт им
#          поддомены. Инстансу не нужен ни публичный адрес, ни открытый порт —
#          он звонит сюда сам.
#
# Запускать: scripts/relay-setup.sh root@203.0.113.11
set -euo pipefail

HOST=${1:?укажите куда ставить: scripts/relay-setup.sh root@203.0.113.11}
DOMAIN=${DOMAIN:-colloq.ru}
FRP_VERSION=${FRP_VERSION:-0.71.0}
# Ключ называется явно: в ~/.ssh их обычно с десяток, sshd обрывает попытку
# после пятой, и до нужного дело не доходит.
SSH_KEY=${SSH_KEY:-$HOME/.ssh/id_ed25519}
SSH=(ssh -o IdentitiesOnly=yes -i "$SSH_KEY")

say() { printf '\033[1m%s\033[0m\n' "$*"; }

say "ставлю ретранслятор на $HOST для *.${DOMAIN}"

"${SSH[@]}" "$HOST" DOMAIN="$DOMAIN" FRP_VERSION="$FRP_VERSION" 'bash -s' <<'REMOTE'
set -euo pipefail
export DEBIAN_FRONTEND=noninteractive

echo "== пакеты"
apt-get update -qq
apt-get install -y -qq curl tar >/dev/null

echo "== caddy"
# Собранный на их стороне бинарник вместо пакета из apt: модули здесь не
# нужны (сертификаты по требованию берутся через HTTP-01), а один файл проще
# обновлять и понимать, чем репозиторий с ключом.
if ! command -v caddy >/dev/null; then
  curl -fsSL -o /usr/local/bin/caddy \
    "https://caddyserver.com/api/download?os=linux&arch=amd64"
  chmod +x /usr/local/bin/caddy
fi
caddy version | head -1

echo "== frps ${FRP_VERSION}"
if [ ! -x /usr/local/bin/frps ]; then
  tmp=$(mktemp -d)
  curl -fsSL "https://github.com/fatedier/frp/releases/download/v${FRP_VERSION}/frp_${FRP_VERSION}_linux_amd64.tar.gz" \
    | tar -xz -C "$tmp" --strip-components=1
  install -m 0755 "$tmp/frps" /usr/local/bin/frps
  rm -rf "$tmp"
fi
frps --version

echo "== пользователи и каталоги"
id -u caddy >/dev/null 2>&1 || useradd --system --home /var/lib/caddy --shell /usr/sbin/nologin caddy
id -u frps  >/dev/null 2>&1 || useradd --system --home /var/lib/frps  --shell /usr/sbin/nologin frps
install -d -o caddy -g caddy -m 0750 /var/lib/caddy /etc/caddy
install -d -o frps  -g frps  -m 0750 /var/lib/frps
# Группа frps, а не только root: демон работает не от рута, и одного chown на
# файл мало — каталог тоже нужно уметь пройти.
install -d -o root -g frps -m 0750 /etc/colloq-relay

echo "== общий секрет"
# Им инстанс доказывает, что ему можно занять поддомен. Без него любой,
# кто знает адрес, объявил бы себя hse.colloq.ru.
if [ ! -s /etc/colloq-relay/token ]; then
  head -c 32 /dev/urandom | base64 | tr -d '/+=' | head -c 40 > /etc/colloq-relay/token
fi
chown root:frps /etc/colloq-relay/token
chmod 640 /etc/colloq-relay/token
TOKEN=$(cat /etc/colloq-relay/token)

echo "== настройка frps"
cat > /etc/colloq-relay/frps.toml <<CONF
# Управляющий порт: сюда звонят инстансы. Наружу открыт, защищён только
# общим секретом ниже.
bindPort = 7000

# Порт, на который frps отдаёт разобранный по имени хоста HTTP.
vhostHTTPPort = 8080

# И он, и все прочие слушатели прокси — только на петле. Снаружи в них ходит
# не посетитель, а стоящий перед ними caddy, который уже снял TLS; открытый
# наружу 8080 был бы способом прийти к любому семинару мимо шифрования.
proxyBindAddr = "127.0.0.1"

# Поддомены выдаются только под этим именем: инстанс просит "hse", получает
# hse.${DOMAIN} и не может попросить ничего за пределами зоны.
subDomainHost = "${DOMAIN}"

auth.method = "token"
auth.token = "${TOKEN}"

# Панель состояния — тоже только на петле, смотреть через ssh -L.
webServer.addr = "127.0.0.1"
webServer.port = 7500

log.level = "info"
CONF
chown root:frps /etc/colloq-relay/frps.toml
chmod 640 /etc/colloq-relay/frps.toml

echo "== настройка caddy"
cat > /etc/caddy/Caddyfile <<CONF
{
	# Сертификат берётся при первом обращении к имени, а не заранее на всю
	# звёздочку. Плата за это — вопрос ниже: без него любой, кто направит
	# своё имя на этот адрес, заставил бы нас выпускать сертификат на него,
	# и лимиты Let's Encrypt кончились бы за вечер.
	on_demand_tls {
		ask http://127.0.0.1:9180/allow
	}
}

# Кто достоин сертификата. Отдельный сайт на петле, потому что caddy
# спрашивает разрешение по HTTP у себя же — своего кода для этого не нужно.
http://127.0.0.1:9180 {
	# Адрес в заголовке сайта для caddy — это условие на имя, а не на то, где
	# слушать. Без bind он поднял бы 9180 на всех интерфейсах, и спрашивать
	# разрешение на сертификат мог бы кто угодно снаружи.
	bind 127.0.0.1
	# Имя приезжает в запросе как ?domain=hse.colloq.ru. Матчер query умеет
	# сравнивать значение целиком и не понимает звёздочку внутри него — с
	# `query domain=*.${DOMAIN}` спрашивалка отвечала 403 в том числе на свои
	# собственные имена, и сертификат не выпускался вообще ни для кого.
	# Поэтому имя переносится в путь, где есть настоящее регулярное выражение.
	rewrite * /{query.domain}
	@ours path_regexp ^/[a-z0-9-]+\.${DOMAIN//./\\.}$
	respond @ours 200
	respond 403
}

# Всё остальное, что приходит на 443 по любому имени.
:443 {
	tls {
		on_demand
	}
	# Заголовки, без которых инстанс не узнает, по какому адресу к нему
	# пришли: ссылка на семинар и адреса сокетов строятся из них.
	reverse_proxy 127.0.0.1:8080 {
		header_up X-Forwarded-Host {host}
		header_up X-Forwarded-Proto https
	}
}

# Голый http нужен для проверки Let's Encrypt; caddy делает её сам, а всё
# остальное уводит на https.
:80 {
	redir https://{host}{uri} permanent
}
CONF
caddy fmt --overwrite /etc/caddy/Caddyfile >/dev/null 2>&1 || true
caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile

echo "== службы"
cat > /etc/systemd/system/frps.service <<'UNIT'
[Unit]
Description=frp server for colloq relay
After=network-online.target
Wants=network-online.target

[Service]
User=frps
Group=frps
ExecStart=/usr/local/bin/frps -c /etc/colloq-relay/frps.toml
Restart=always
RestartSec=3
# Ничего лишнего этому демону не нужно: он читает один файл и держит сокеты.
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
PrivateTmp=true
ReadWritePaths=/var/lib/frps

[Install]
WantedBy=multi-user.target
UNIT

cat > /etc/systemd/system/caddy.service <<'UNIT'
[Unit]
Description=Caddy for colloq relay
After=network-online.target
Wants=network-online.target

[Service]
User=caddy
Group=caddy
ExecStart=/usr/local/bin/caddy run --environ --config /etc/caddy/Caddyfile --adapter caddyfile
ExecReload=/usr/local/bin/caddy reload --config /etc/caddy/Caddyfile --adapter caddyfile --force
Restart=on-abnormal
RestartSec=3
# Право слушать 80 и 443 без запуска от root.
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
systemctl enable --now frps caddy
# enable --now не трогает уже запущенное, а скрипт задуман повторяемым:
# без явного перезапуска второй прогон оставил бы обе службы на старом конфиге.
systemctl restart frps caddy
sleep 3
systemctl is-active frps caddy | tr '\n' ' '; echo

echo "== слушают"
ss -lntp | awk 'NR==1 || /:(80|443|7000|8080|9180|7500)\b/{print "  "$4"  "$6}'

echo
echo "секрет для инстансов лежит в /etc/colloq-relay/token"
REMOTE

# Готовые строки для .env инстанса.
#
# Раньше здесь печатался только секрет — а в какие переменные его класть и где
# они вообще описаны, узнать было неоткуда: RELAY_* нет ни в .env.example, ни в
# README, и host.sh про них молчит, пока не выберет ретранслятор. Человек
# доходил до аудитории с адресом Cloudflare, который у группы не открывается.
TOKEN="$("${SSH[@]}" "$HOST" 'cat /etc/colloq-relay/token' 2>/dev/null || true)"
echo
say "впишите это в .env инстанса — без отступов, как есть:"
printf 'RELAY_DOMAIN=%s\nRELAY_ADDR=%s\nRELAY_PORT=7000\nRELAY_TOKEN=%s\n' \
  "$DOMAIN" "${HOST#*@}" "${TOKEN:-<из /etc/colloq-relay/token на ретрансляторе>}"
echo
say "потом семинар наружу: make host HOST=hse.${DOMAIN}"
