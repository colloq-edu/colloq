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
# И один файл рядом с ними — страница ожидания (scripts/relay-offline.html). Пока преподаватель не поднял
# комнату, живого клиента для её имени нет, и frps отвечал бы своей встроенной
# страницей: «The page you requested was not found… powered by frp». Студенту,
# пришедшему за десять минут до пары, по ней не понять ни что случилось, ни
# что делать. Вместо неё отдаётся /etc/colloq-relay/offline.html — она же
# показывается, если не отвечает сам frps, и она сама перезагружается, так что
# ждущий попадает в комнату без единого нажатия.
#
# На странице ожидания живёт пиксельная капибара (игра в духе динозавра из
# Chrome) с общей таблицей рекордов. Таблицу ведёт третий, крошечный демон —
# colloq-capy (scripts/relay-capy.py, python3 из коробки): caddy отдаёт ему
# путь /.relay/capy/* на любом имени. Игра без него работает, таблица — нет.
#
# И четвёртый демон — colloq-assets (scripts/relay-assets.py), зеркало
# неизменяемой статики. До него КАЖДЫЙ байт каждого /assets/*, /fonts/* и
# /pdf/* ехал через туннель с ноутбука преподавателя — 598 КБ сжатого на
# каждого пришедшего, по тому же каналу, по которому живут сокеты комнаты.
# Файлы у всех одинаковые (имена в assets/ содержат хэш содержимого), поэтому
# инстанс кладёт их сюда одним архивом на `make host`, а отдаёт их caddy прямо
# из /var/lib/colloq-assets/<имя>. Промах зеркала — не отказ: матчер `file`
# пропускает такой запрос в туннель, как было раньше.
#
# И ещё один каталог — /etc/caddy/names, память имён. Сертификат выпускается
# только имени, у которого есть туннель, а список туннелей frps держит в
# памяти: после его перезапуска или переезда на другую машину список пуст, и
# студент, открывший привычный event.example.org до начала пары, получал бы не
# страницу ожидания, а отказ TLS. Поэтому таймер раз в минуту переписывает
# имена из frps в файлы этого каталога, и имя, поднятое хоть раз, помнится
# вечно. Вписать имя заранее: touch /etc/caddy/names/<имя>.colloq.ru.
#
# Запускать: scripts/relay-setup.sh root@203.0.113.12
# Только страница: scripts/relay-setup.sh --page root@203.0.113.12
set -euo pipefail

# Режим. Полная установка идёт минуты и трогает пакеты, службы и конфиги — ради
# правки одного абзаца в тексте для студента гонять её незачем, поэтому у
# скрипта есть второй вход, который пишет только страницу. Флаг разбирается
# до адреса: иначе `--page` уехал бы в HOST и скрипт полез бы ставить каддю на
# машину с таким именем.
PAGE_ONLY=0
if [ "${1:-}" = "--page" ]; then PAGE_ONLY=1; shift; fi

HOST=${1:?укажите куда ставить: scripts/relay-setup.sh root@203.0.113.11}
DOMAIN=${DOMAIN:-colloq.ru}
FRP_VERSION=${FRP_VERSION:-0.71.0}
# Ключ называется явно: в ~/.ssh их обычно с десяток, sshd обрывает попытку
# после пятой, и до нужного дело не доходит.
SSH_KEY=${SSH_KEY:-$HOME/.ssh/id_ed25519}
SSH=(ssh -o IdentitiesOnly=yes -i "$SSH_KEY")
# Страница и сервис очков лежат рядом со скриптом и вкладываются в удалённый
# поток как base64: так их текст — JS с долларами и обратными кавычками —
# не проходит ни через одну подстановку bash ни здесь, ни на машине.
HERE=$(cd "$(dirname "$0")" && pwd)

# Сертификат на всю звёздочку — по желанию: RELAY_WILDCARD=1 и CF_TOKEN (тот
# же, что у scripts/dns.sh; из окружения или из .env рядом с репозиторием).
#
# Без него имя, которого ретранслятор не видел ни разу, не получает
# сертификата вовсе: спрашивалка отвечает 403, и браузер показывает ошибку TLS
# раньше любой страницы — состояние «такой комнаты нет» написано, но
# недостижимо. Со звёздочкой любое имя под зоной получает рабочий TLS через
# DNS-проверку Cloudflare, исчезает потолок Let's Encrypt в 50 имён в неделю и
# зависимость выпуска от порта 80. Плата: токен Cloudflare живёт на
# ретрансляторе, ключ один на все имена, и обновление caddy мимо этого скрипта
# (apt, caddy upgrade) снесёт модуль dns.providers.cloudflare — caddy тогда не
# встанет вовсе; повторный прогон скрипта это чинит.
WILDCARD=${RELAY_WILDCARD:-0}
CF_TOKEN=${CF_TOKEN:-$(grep -E '^CF_TOKEN=' "$HERE/../.env" 2>/dev/null | tail -1 | cut -d= -f2- | tr -d ' "' || true)}
if [ "$WILDCARD" = 1 ] && [ -z "$CF_TOKEN" ]; then
  die "RELAY_WILDCARD=1 требует CF_TOKEN (Zone:DNS:Edit на зону ${DOMAIN}) — в окружении или в .env."
fi
PAGE_FILE=$HERE/relay-offline.html
CAPY_FILE=$HERE/relay-capy.py
ASSETS_FILE=$HERE/relay-assets.py
[ -f "$PAGE_FILE" ] || { printf '\033[31mнет %s\033[0m\n' "$PAGE_FILE" >&2; exit 1; }
[ -f "$CAPY_FILE" ] || { printf '\033[31mнет %s\033[0m\n' "$CAPY_FILE" >&2; exit 1; }
[ -f "$ASSETS_FILE" ] || { printf '\033[31mнет %s\033[0m\n' "$ASSETS_FILE" >&2; exit 1; }
embed() { base64 < "$1" | fold -w 76; }

RED=$'\033[31m'; OFF=$'\033[0m'
say() { printf '\033[1m%s\033[0m\n' "$*"; }
die() { printf '%s%s%s\n' "$RED" "$*" "$OFF" >&2; exit 1; }

# --------------------------------------------------------------- страница
#
# Кусок удалённого скрипта, который кладёт страницу на место. Отдельной
# функцией, потому что нужен в двух местах: в полной установке и в `--page`.
# Функция печатает текст на stdout, а вызывающий вливает его в общий поток для
# `bash -s`. Сама страница — scripts/relay-offline.html, один файл на оба
# режима, так что разъехаться им негде.
relay_page() {
  cat <<'SNIPPET'
echo "== страница ожидания"
[ -d /etc/colloq-relay ] || { echo "нет /etc/colloq-relay — сначала полная установка"; exit 1; }
[ -d /etc/caddy ]        || { echo "нет /etc/caddy — сначала полная установка"; exit 1; }

# Две копии одного файла, и это не небрежность. Страницу отдаёт то frps (когда
# для имени нет клиента), то caddy (когда не отвечает сам frps), а демоны
# работают от разных пользователей и заперты в свои каталоги. Один общий файл
# означал бы либо caddy в группе frps — то есть право читать /etc/colloq-relay
# целиком, вместе с общим секретом, — либо страницу, открытую всей машине.
# Дешевле положить один и тот же текст дважды: пишется он всё равно отсюда.
page_tmp=$(mktemp)
base64 -d > "$page_tmp" <<'PAGE_B64'
SNIPPET
  embed "$PAGE_FILE"
  cat <<'SNIPPET'
PAGE_B64

# Права как у соседей по каталогу: владелец root, группа демона, чтение
# группе. Демон читает файл, но переписать его не может — это делает только
# этот скрипт, из-под root.
install -o root -g frps  -m 0640 "$page_tmp" /etc/colloq-relay/offline.html
install -o root -g caddy -m 0640 "$page_tmp" /etc/caddy/offline.html
rm -f "$page_tmp"
SNIPPET
}

# ------------------------------------------------------------ только страница
#
# Быстрый путь: страница и ничего больше.
if [ "$PAGE_ONLY" = 1 ]; then
  say "обновляю страницу ожидания на $HOST"
  {
    echo 'set -euo pipefail'
    relay_page
    cat <<'CHECK'

# Перезапускать нечего, и это не везение, а свойство обоих читателей файла:
# frps открывает его на каждый ответ 404 (getNotFoundPageContent делает
# os.ReadFile), file_server у caddy — на каждый запрос. Новый текст виден со
# следующего же обращения.
#
# А вот на ретрансляторе, поставленном до появления страницы, файл лёг бы на
# место, и показывать его было бы некому: в конфигах нет ни строки про него.
# Молчать об этом нельзя — снаружи это выглядит как «страница не обновилась».
if ! grep -q 'custom404Page' /etc/colloq-relay/frps.toml 2>/dev/null ||
   ! grep -q 'offline.html' /etc/caddy/Caddyfile 2>/dev/null ||
   ! grep -q '/.relay/capy/' /etc/caddy/Caddyfile 2>/dev/null ||
   ! grep -q '/.relay/state' /etc/caddy/Caddyfile 2>/dev/null; then
  echo
  echo "ВНИМАНИЕ: конфиги ещё не знают про эту страницу."
  echo "Прогоните полную установку один раз: make relay-setup WHERE=..."
fi
CHECK
  } | "${SSH[@]}" "$HOST" 'bash -s' || die "не получилось обновить страницу на $HOST"
  say "готово — новый текст виден со следующего обращения, перезапускать нечего"
  exit 0
fi

# ---------------------------------------------------------- полная установка

say "ставлю ретранслятор на $HOST для *.${DOMAIN}"

# Удалённый скрипт склеивается из трёх кусков: до страницы, сама страница и
# всё после. Это один и тот же `bash -s` на той стороне, поэтому переменные
# (тот же TOKEN) переживают склейку — куски не отдельные сеансы, а части
# одного текста.
{
# Первые строки удалённого скрипта — из локальных переменных. Через поток, а
# не через окружение команды ssh: командная строка видна всей машине в ps, а
# здесь может быть токен Cloudflare.
printf 'WILDCARD=%q\nCF_TOKEN=%q\n' "$WILDCARD" "$CF_TOKEN"
cat <<'REMOTE_HEAD'
set -euo pipefail
export DEBIAN_FRONTEND=noninteractive

echo "== пакеты"
apt-get update -qq
apt-get install -y -qq curl tar >/dev/null

echo "== подкачка"
# Два гигабайта поверх 3.9 ГБ памяти — и не ради того, чтобы машина в них
# работала.
#
# Измерено на живой паре: двести студентов в один вечер, и ядро тридцать шесть
# раз убивало то frps, то caddy. Убийство здесь — не «стало медленнее», а
# разрыв ВСЕХ туннелей разом: у каждого семинара под этим ретранслятором зал
# уходит в переподключение. Подкачка даёт ядру что отдать вместо выстрела, а
# MemoryHigh ниже — тормозить того, кто зарвался, раньше, чем дойдёт до OOM.
#
# Повторный прогон ничего не делает: и файл, и строка в fstab проверяются.
if ! swapon --show=NAME --noheadings 2>/dev/null | grep -qx /swapfile; then
  if [ ! -f /swapfile ]; then
    # fallocate быстрее, но на некоторых файловых системах оставляет дыры, и
    # swapon такой файл не берёт. Тогда — честный dd.
    fallocate -l 2G /swapfile 2>/dev/null || dd if=/dev/zero of=/swapfile bs=1M count=2048 status=none
    chmod 600 /swapfile
    mkswap /swapfile >/dev/null 2>&1 || true
  fi
  if ! swapon /swapfile 2>/dev/null; then
    rm -f /swapfile
    dd if=/dev/zero of=/swapfile bs=1M count=2048 status=none
    chmod 600 /swapfile
    mkswap /swapfile >/dev/null
    swapon /swapfile || echo "подкачку включить не вышло — это не смертельно"
  fi
fi
grep -q '^/swapfile ' /etc/fstab 2>/dev/null || echo '/swapfile none swap sw 0 0' >> /etc/fstab
# Своп для этой машины — спасательный круг, а не рабочий инструмент: лезть в
# него раньше времени значит отдавать студентам страницы через диск.
sysctl -qw vm.swappiness=10 || true
grep -q '^vm.swappiness' /etc/sysctl.conf 2>/dev/null || echo 'vm.swappiness=10' >> /etc/sysctl.conf
swapon --show 2>/dev/null | tail -n +1 | sed 's/^/  /'

echo "== caddy"
# Собранный на их стороне бинарник вместо пакета из apt: модули здесь не
# нужны (сертификаты по требованию берутся через HTTP-01), а один файл проще
# обновлять и понимать, чем репозиторий с ключом.
# Со звёздочкой (WILDCARD=1) нужен модуль dns.providers.cloudflare — тот же
# сервис сборки отдаёт бинарник с ним; проверка не «бинарник есть», а «модуль
# есть», иначе машина со старым caddy тихо осталась бы без DNS-проверки.
CADDY_URL="https://caddyserver.com/api/download?os=linux&arch=amd64"
if [ "${WILDCARD:-0}" = 1 ]; then CADDY_URL="${CADDY_URL}&p=github.com/caddy-dns/cloudflare"; fi
if ! command -v caddy >/dev/null \
   || { [ "${WILDCARD:-0}" = 1 ] && ! caddy list-modules 2>/dev/null | grep -q '^dns.providers.cloudflare'; }; then
  curl -fsSL -o /usr/local/bin/caddy.new "${CADDY_URL}"
  chmod +x /usr/local/bin/caddy.new
  mv /usr/local/bin/caddy.new /usr/local/bin/caddy
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
id -u capy  >/dev/null 2>&1 || useradd --system --home /var/lib/colloq-capy --shell /usr/sbin/nologin capy
id -u assets >/dev/null 2>&1 || useradd --system --home /var/lib/colloq-assets --shell /usr/sbin/nologin assets
install -d -o caddy -g caddy -m 0750 /var/lib/caddy /etc/caddy /etc/caddy/names
install -d -o frps  -g frps  -m 0750 /var/lib/frps
# Зеркало статики пишет один демон, читает другой: владелец assets, группа
# caddy, и только чтение группе — caddy не должен уметь переписать то, что
# раздаёт. Бит 2000 (setgid) обязателен: без него всё, что создаст внутри
# служба, получит группу assets, и caddy будет отдавать 403 на каждый файл —
# то есть зеркало просто не заработает, молча и целиком.
install -d -o assets -g caddy -m 2750 /var/lib/colloq-assets
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

# Что видит студент, когда для имени нет живого клиента: инстанс выключен,
# ноутбук закрыт, туннель не поднят. Без этой строки frps отдаёт свою
# встроенную страницу — «not found… powered by frp», — по которой не понять
# ни что случилось, ни что делать.
#
# Имя поля выверено по исходникам той версии, которую ставит скрипт
# (ServerConfig.Custom404Page в pkg/config/v1/server.go, json-тег
# custom404Page), а не по памяти. Проверять пришлось не из вежливости: конфиг
# читается в строгом режиме (--strict_config по умолчанию включён), поэтому
# промах в имени — не «настройка не применилась», а frps, который не встаёт.
# Путь абсолютный: у службы нет WorkingDirectory, её рабочий каталог — /.
custom404Page = "/etc/colloq-relay/offline.html"

auth.method = "token"
auth.token = "${TOKEN}"

# Сколько готовых соединений разрешается держать инстансу.
#
# Инстанс просит запас (transport.poolCount в scripts/host.sh), чтобы запрос
# студента не ждал установления соединения перед первым байтом; сервер обязан
# назвать потолок, иначе запас не выдаётся вовсе. Десять на инстанс — это
# десятки холостых соединений на всю машину, и на 3.9 ГБ памяти это ничто по
# сравнению с тем, что даёт первый экран без лишнего круга по сети.
transport.maxPoolCount = 10

# Панель состояния — тоже только на петле, смотреть через ssh -L.
webServer.addr = "127.0.0.1"
webServer.port = 7500

log.level = "info"
CONF
chown root:frps /etc/colloq-relay/frps.toml
chmod 640 /etc/colloq-relay/frps.toml

echo "== настройка caddy"
# Заголовок сайта: по умолчанию «любое имя на 443» с сертификатом по
# требованию; со звёздочкой — один сайт *.домен и один сертификат через DNS.
if [ "${WILDCARD:-0}" = 1 ]; then
  SITE_LABEL="*.${DOMAIN}"
  SITE_TLS="tls {
		dns cloudflare {env.CF_TOKEN}
		resolvers 1.1.1.1
	}"
else
  SITE_LABEL=":443"
  SITE_TLS="tls {
		on_demand
	}"
fi
# Чей сертификат. По умолчанию — Let's Encrypt, как у caddy из коробки. Но
# LE живёт за Cloudflare, а у машины на Cogent (relay2 в Эстонии, 12.09.2026)
# до Cloudflare по IPv4 не доходит вовсе, по IPv6 — через раз: у Cogent с
# Cloudflare давний спор о пиринге. ZeroSSL и Google оттуда открыты. Файл
# /etc/colloq-relay/acme.env на машине (ACME_DIR, ACME_EMAIL, ACME_EAB_KID,
# ACME_EAB_KEY) переключает удостоверяющий центр; ZeroSSL выдаёт EAB по
# одному письму: POST https://api.zerossl.com/acme/eab-credentials-email
# -d email=… . Файла нет — Let's Encrypt.
# MTU исходящего пути. На relay2 (Cogent) до Cloudflare — а за ним Let's
# Encrypt — пакеты в 1500 байт глохнут: ICMP «фрагментируй» по дороге
# теряется, TLS-рукопожатие проходит, а ответ HTTP не приходит никогда
# (12.09.2026, найдено перебором: с mtu 1300 на маршруте LE отвечает за
# полсекунды). Число в /etc/colloq-relay/path-mtu вешается на маршруты по
# умолчанию (v4 и v6) службой при каждой загрузке; файла нет — ничего не
# меняется. Интерфейсу MTU не трогаем: он же принимает кадры студентов.
if [ -s /etc/colloq-relay/path-mtu ]; then
  PATH_MTU=$(tr -dc '0-9' < /etc/colloq-relay/path-mtu)
  cat > /usr/local/sbin/colloq-relay-mtu <<'MTU'
#!/bin/sh
# Ограничить MTU маршрутов по умолчанию числом из /etc/colloq-relay/path-mtu.
mtu=$(tr -dc '0-9' < /etc/colloq-relay/path-mtu)
[ -n "$mtu" ] || exit 0
ip -4 route show default | while read -r line; do
  # shellcheck disable=SC2086
  ip -4 route change $line mtu "$mtu"
done
ip -6 route show default | sed 's/ expires [^ ]*//; s/ pref [^ ]*//; s/ nhid [^ ]*//' | while read -r line; do
  # shellcheck disable=SC2086
  ip -6 route change $line mtu "$mtu" 2>/dev/null || true
done
MTU
  chmod 755 /usr/local/sbin/colloq-relay-mtu
  cat > /etc/systemd/system/colloq-relay-mtu.service <<UNIT
[Unit]
Description=path MTU ${PATH_MTU} on default routes for colloq relay
After=network-online.target
Wants=network-online.target

[Service]
Type=oneshot
ExecStart=/usr/local/sbin/colloq-relay-mtu
RemainAfterExit=yes

[Install]
WantedBy=multi-user.target
UNIT
  systemctl daemon-reload
  systemctl enable --now colloq-relay-mtu.service >/dev/null 2>&1 || true
fi

ACME_BLOCK=""
if [ -s /etc/colloq-relay/acme.env ]; then
  # shellcheck disable=SC1091
  . /etc/colloq-relay/acme.env
  ACME_BLOCK="
	email ${ACME_EMAIL}
	cert_issuer acme {
		dir ${ACME_DIR}
		eab ${ACME_EAB_KID} ${ACME_EAB_KEY}
	}"
fi
cat > /etc/caddy/Caddyfile <<CONF
{
	# Сертификат берётся при первом обращении к имени, а не заранее на всю
	# звёздочку. Плата за это — вопрос ниже: без него любой, кто направит
	# своё имя на этот адрес, заставил бы нас выпускать сертификат на него,
	# и лимиты Let's Encrypt кончились бы за вечер.
	on_demand_tls {
		ask http://127.0.0.1:9180/allow
	}${ACME_BLOCK}
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
	# «query domain=*.${DOMAIN}» спрашивалка отвечала 403 в том числе на свои
	# собственные имена, и сертификат не выпускался вообще ни для кого.
	# Поэтому имя переносится в путь, где есть настоящее регулярное выражение.
	rewrite * /{query.domain}
	@ours path_regexp ours ^/([a-z0-9-]+)\.${DOMAIN//./\\.}$
	# И имя должно быть НЕ ПРОСТО НАШИМ, а живым: спрашиваем у frps, есть ли у
	# него такой туннель. 200 — комната выставлена наружу, 404 — имени нет.
	#
	# Раньше здесь стояло «любое имя под нашей зоной», и этого хватило, чтобы
	# сканеры заставили ретранслятор заказать сертификаты на ftp, shop,
	# analytics и случайный мусор: восемнадцать имён за сутки. У Let's Encrypt
	# потолок пятьдесят сертификатов на домен в неделю, и упереться в него
	# первым делом означает остаться без сертификата для настоящего семинара
	# посреди пары. Имя, туннель которого когда-то был, остаётся разрешённым:
	# оно и должно продлеваться, пока комнату открывают снова.
	handle @ours {
		# Память имён (см. шапку): файл /etc/caddy/names/<имя>.${DOMAIN} есть —
		# сертификат выдаётся, жив туннель сейчас или нет. Матчер стоит внутри
		# @ours, а не рядом: снаружи путь «/» совпал бы с самим каталогом.
		@known file {
			root /etc/caddy/names
			try_files {path}
		}
		handle @known {
			respond 200
		}
		handle {
			rewrite * /api/proxy/http/{re.ours.1}
			reverse_proxy 127.0.0.1:7500
		}
	}
	handle {
		respond 403
	}
}

# Всё остальное, что приходит на 443 по любому имени.
${SITE_LABEL} {
	${SITE_TLS}
	# Заголовки, без которых инстанс не узнает, по какому адресу к нему
	# пришли: ссылка на семинар и адреса сокетов строятся из них.
	# Роботам здесь делать нечего.
	#
	# Учебная комната открывается по персональной ссылке и живёт часы; в поиске
	# ей не место. А домен, у которого индексируются сотни поддоменов, со
	# стороны выглядит фермой — за это Safe Browsing однажды пометил colloq.ru
	# целиком, и красный экран увидели бы студенты на всех семинарских адресах.
	# Отказ отдаётся до туннеля: он один и тот же для всех комнат и не зависит
	# от того, поднят ли сейчас семинар.
	#
	# Разворачивателям ссылок — можно. Telegram (он же представляется
	# Twitterbot), WhatsApp, iMessage и Slack читают robots.txt и без
	# разрешения не собирают карточку: ссылка на комнату в чате оставалась
	# голой (12.09.2026). Они ничего не индексируют — только берут из <head>
	# имя занятия и картинку, которые инстанс для того и подставляет
	# (server/src/link-preview.ts).
	handle /robots.txt {
		header Content-Type text/plain
		respond "User-agent: TelegramBot
User-agent: Twitterbot
User-agent: facebookexternalhit
User-agent: Facebot
User-agent: WhatsApp
User-agent: Slackbot-LinkExpanding
User-agent: Discordbot
User-agent: LinkedInBot
Allow: /

User-agent: *
Disallow: /
" 200
	}

	# Очки игры со страницы ожидания — сервису colloq-capy (см. шапку). Путь
	# начинается с точки: ни один адрес инстанса так не выглядит, и маршрут
	# ничего у комнаты не отнимает даже когда она открыта.
	handle /.relay/capy/* {
		# Тело больше 4 КБ до python не доезжает; адрес клиента — тот, что
		# видит caddy, а не то, что клиент написал в заголовке сам.
		request_body {
			max_size 4KB
		}
		reverse_proxy 127.0.0.1:9181 {
			header_up X-Forwarded-For {remote_host}
			header_up X-Forwarded-Host {host}
		}
	}

	# Приём статики от инстанса: на \`make host\` он кладёт сюда свои assets/,
	# fonts/ и pdf/ одним архивом (scripts/relay-assets.py). Секрет тот же, что
	# у frps, и писать инстанс может только в зеркало своего имени — сервис
	# сверяет имя в пути с тем, по которому пришёл запрос.
	handle /.relay/assets/* {
		request_body {
			max_size 64MB
		}
		reverse_proxy 127.0.0.1:9182 {
			header_up X-Forwarded-Host {host}
		}
	}

	# Неизменяемое — с этой машины, а не через ноутбук преподавателя.
	#
	# Имена в assets/ содержат хэш содержимого, fonts/ и pdf/ меняются только с
	# выкладкой, и инстанс сам отдаёт всё это с долгим сроком жизни. Значит их
	# можно держать здесь: 598 КБ сжатого на студента перестают ехать через
	# туннель, и он остаётся тому, ради чего он есть, — живой комнате.
	#
	# Матчер \`file\` — это и есть вся защита от устаревшего или пустого
	# зеркала: нет файла на диске — правило не совпало, запрос идёт дальше в
	# туннель, как было всегда. Поэтому здесь \`file\`, а не file_server с
	# pass_thru: ответ 404 из зеркала не должен получить ни заголовков, ни
	# срока жизни.
	#
	# Сроки — те же, что ставит сам инстанс (server/src/app.ts): год и
	# immutable только версионному, час — шрифтам и pdf. Шрифт под тем же
	# именем меняют руками, и год на него — это год, когда замену не увидит
	# никто из вернувшихся.
	@mirror {
		host *.${DOMAIN}
		path /assets/* /fonts/* /pdf/*
		file {
			root /var/lib/colloq-assets/{host}
			try_files {path}
		}
	}
	handle @mirror {
		root * /var/lib/colloq-assets/{host}
		header /assets/* Cache-Control "public, max-age=31536000, immutable"
		header /fonts/* Cache-Control "public, max-age=3600"
		header /pdf/* Cache-Control "public, max-age=3600"
		# Чтобы \`curl -sI\` отвечал на вопрос «а зеркало-то работает?» одним
		# словом, а не сравнением длин.
		header X-Colloq-Mirror hit
		file_server {
			precompressed br gzip
		}
	}

	# Что ретранслятор знает об этом имени — для страницы ошибки. По этому
	# ответу она отличает «комната ещё не открыта» от «такой комнаты нет» и от
	# «Colloq на машине преподавателя молчит»: у frps для всех трёх один и тот
	# же 404 без единого различимого признака, и снаружи их не разобрать никак.
	#
	# known — файл памяти имён есть, то есть комнату здесь когда-то открывали;
	# tunnel — туннель поднят прямо сейчас (спрашиваем у frps его же API, как
	# это делает спрашивалка сертификатов выше). Наружу уходят только эти два
	# слова: адрес машины преподавателя и счётчики трафика из ответа API
	# остаются здесь.
	handle /.relay/state {
		header Cache-Control "no-store"
		header Content-Type "application/json"
		@known file {
			root /etc/caddy/names
			try_files {host}
		}
		handle @known {
			rewrite * /api/proxy/http/{labels.2}
			reverse_proxy 127.0.0.1:7500 {
				@live status 200
				handle_response @live {
					respond \`{"known":true,"tunnel":true}\` 200
				}
				@gone status 404
				handle_response @gone {
					respond \`{"known":true,"tunnel":false}\` 200
				}
			}
		}
		handle {
			respond \`{"known":false,"tunnel":false}\` 200
		}
	}

	reverse_proxy 127.0.0.1:8080 {
		header_up X-Forwarded-Host {host}
		header_up X-Forwarded-Proto https
	}

	# Тот же экран, когда падает не комната, а сам frps: перезапуск, обновление,
	# кончившаяся память. Раньше сюда приезжала голая ошибка шлюза от caddy, а
	# она для студента неотличима от «интернет сломался».
	#
	# handle_errors ловит только ошибки самого caddy — то есть случай, когда до
	# frps не достучаться. Ответ 404, который живой frps отдаёт для имени без
	# клиента, это для caddy обычный ответ сверху, он идёт через reverse_proxy
	# насквозь и сюда не попадает: две ветки не спорят за один и тот же случай.
	# Выдачу сертификатов это не трогает вовсе — она живёт до HTTP, в
	# рукопожатии TLS, и в этот маршрут не заходит.
	handle_errors {
		root * /etc/caddy
		rewrite * /offline.html
		# Страница выросла до 116 КБ (два языка и четыре состояния), а
		# открывают её с телефона по сотовой связи в аудитории. Сжатие режет
		# её до 34 КБ; на остальное движение через ретранслятор это не влияет —
		# encode стоит внутри handle_errors и трогает только страницы ошибок.
		encode gzip zstd
		# Страница у всех случаев одна, а текст разный: код ответа, его
		# название и номер записи в журнале приезжают в неё подстановкой.
		# Скобки не по умолчанию: templates разбирает как шаблон Go ВЕСЬ файл,
		# а пара фигурных скобок подряд встречается в JS и в тексте сама
		# собой — первая же проверка упала на комментарии, где такая пара
		# стояла в объяснении. Ошибка разбора — это пустой ответ вместо
		# страницы ошибки, то есть белый экран ровно тогда, когда человеку
		# нужно объяснение. Пара с процентом в HTML, CSS и JS не встречается.
		templates {
			between <% %>
		}
		# Ошибку нельзя оставлять в кэше: комната откроется через минуту, а
		# браузер будет показывать «не открыта» из своей памяти.
		header Cache-Control "no-store"
		# Код ответа остаётся тем, что случилось на самом деле. Со стандартным
		# для file_server 200 страница выглядела бы как успех, и любая проверка
		# снаружи — та же, что ждёт адрес в make host, — считала бы мёртвый
		# ретранслятор живым семинаром.
		file_server {
			status {err.status_code}
		}
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
REMOTE_HEAD

# Страница кладётся до запуска служб: обе на неё уже сослались, и первый же
# запрос после перезапуска должен получить текст, а не пустое место.
relay_page

cat <<'REMOTE_TAIL'

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
# Потолки. Измерено на живой паре: двести студентов в один вечер положили эту
# машину — ядро тридцать шесть раз убивало то frps (209 МБ), то caddy (186 МБ),
# и каждое убийство рвало ВСЕ туннели разом. MemoryHigh — не убийство, а
# торможение: под давлением ядро начинает отбирать страницы у того, кто
# зарвался, а не стрелять в него. Полтора гигабайта из 3.9 — с запасом на
# несколько параллельных семинаров.
MemoryHigh=1536M
# Тысяча студентов — это тысячи сокетов, а по умолчанию у службы их 1024:
# упереться в это значит «не открывается ни у кого», без единой строки в
# журнале о том, почему.
LimitNOFILE=65535
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
ExecStart=/usr/local/bin/caddy run --config /etc/caddy/Caddyfile --adapter caddyfile
ExecReload=/usr/local/bin/caddy reload --config /etc/caddy/Caddyfile --adapter caddyfile --force
Restart=on-abnormal
RestartSec=3
# Те же потолки, что у frps, и по той же причине: убитый caddy — это отказ
# TLS сразу всем именам. Гигабайта хватает с большим запасом (измеренный
# максимум — 186 МБ на двух сотнях сокетов), и он оставляет место соседу.
MemoryHigh=1024M
LimitNOFILE=65535
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

echo "== очки капибары"
base64 -d > /usr/local/bin/colloq-capy <<'CAPY_B64'
REMOTE_TAIL
embed "$CAPY_FILE"
cat <<'REMOTE_TAIL'
CAPY_B64
chmod 0755 /usr/local/bin/colloq-capy
# Токен Cloudflare — процессу caddy, только со звёздочкой. EnvironmentFile
# читает systemd от root до сброса прав, ProtectSystem=strict не мешает.
# Без звёздочки оба файла убираются, чтобы старый токен не пережил переключение.
if [ "${WILDCARD:-0}" = 1 ]; then
  install -o root -g caddy -m 0640 /dev/null /etc/caddy/cloudflare.env
  printf 'CF_TOKEN=%s\n' "${CF_TOKEN}" > /etc/caddy/cloudflare.env
  mkdir -p /etc/systemd/system/caddy.service.d
  printf '[Service]\nEnvironmentFile=/etc/caddy/cloudflare.env\n' > /etc/systemd/system/caddy.service.d/cloudflare.conf
else
  rm -f /etc/systemd/system/caddy.service.d/cloudflare.conf /etc/caddy/cloudflare.env
fi
cat > /etc/systemd/system/colloq-capy.service <<'UNIT'
[Unit]
Description=capybara leaderboard for the colloq relay waiting page
After=network-online.target
Wants=network-online.target
[Service]
User=capy
Group=capy
Environment=CAPY_STATE=/var/lib/colloq-capy
Environment=CAPY_PORT=9181
StateDirectory=colloq-capy
ExecStart=/usr/bin/python3 /usr/local/bin/colloq-capy
Restart=always
RestartSec=3
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
PrivateTmp=true
[Install]
WantedBy=multi-user.target
UNIT

echo "== зеркало статики"
base64 -d > /usr/local/bin/colloq-assets <<'ASSETS_B64'
REMOTE_TAIL
embed "$ASSETS_FILE"
cat <<REMOTE_TAIL
ASSETS_B64
chmod 0755 /usr/local/bin/colloq-assets
# Метка в кавычках: \${DOMAIN} уже подставлен здесь, а \$CREDENTIALS_DIRECTORY
# в комментарии ниже — переменная systemd, и раскрывать её при установке
# нельзя (под set -u она роняла весь прогон пустым юнитом). Экранировано
# дважды: этот текст сам идёт через heredoc без кавычек.
cat > /etc/systemd/system/colloq-assets.service <<'UNIT'
[Unit]
Description=static mirror for colloq relay
After=network-online.target
Wants=network-online.target
[Service]
User=assets
Group=assets
Environment=ASSETS_ROOT=/var/lib/colloq-assets
Environment=ASSETS_PORT=9182
Environment=ASSETS_DOMAIN=${DOMAIN}
ExecStart=/usr/bin/python3 /usr/local/bin/colloq-assets
Restart=always
RestartSec=3
# Секрет тот же, что у frps, — и берётся он копией от systemd, а не членством
# в группе frps: службе нужен один файл, а не право читать каталог демона
# целиком. Файл появляется в \$CREDENTIALS_DIRECTORY/token и виден только ей.
LoadCredential=token:/etc/colloq-relay/token
# Разбор чужого архива: памяти — с запасом на распаковку, но не больше.
MemoryHigh=256M
# Каталоги внутри зеркала — 0750, файлы 0640, группа наследуется от setgid на
# корне: читает их caddy, и больше никто.
UMask=0027
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
PrivateTmp=true
ReadWritePaths=/var/lib/colloq-assets
[Install]
WantedBy=multi-user.target
UNIT
REMOTE_TAIL

# Дальше снова буквальный текст: ниже есть и awk с \$4, и python, и подставлять
# в них ничего не надо.
cat <<'REMOTE_TAIL'

# Уборка раз в сутки: брошенные имена, обрывки распаковки, прошлые наборы.
# Куски прежних сборок стареют сами — они переносятся в новый набор только
# пока им меньше месяца (scripts/relay-assets.py · carry_over).
cat > /etc/systemd/system/colloq-assets-prune.service <<'UNIT'
[Unit]
Description=drop abandoned colloq relay mirrors
[Service]
Type=oneshot
User=assets
Group=assets
Environment=ASSETS_ROOT=/var/lib/colloq-assets
ExecStart=/usr/bin/python3 /usr/local/bin/colloq-assets --prune
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
PrivateTmp=true
ReadWritePaths=/var/lib/colloq-assets
UNIT
cat > /etc/systemd/system/colloq-assets-prune.timer <<'UNIT'
[Unit]
Description=drop abandoned colloq relay mirrors daily
[Timer]
OnCalendar=daily
Persistent=true
AccuracySec=1h
[Install]
WantedBy=timers.target
UNIT

echo "== память имён"
cat > /usr/local/bin/colloq-relay-names <<NAMES
#!/usr/bin/env bash
# Переписывает /etc/caddy/names по списку туннелей frps: каждое имя, которое
# frps видел с последнего запуска, становится пустым файлом <имя>.${DOMAIN}.
# Файлы никогда не удаляются — ради этого каталог и существует: список frps
# пуст после каждого его перезапуска, а имя должно помниться дальше.
# Зовётся таймером colloq-relay-names.timer от пользователя caddy.
set -euo pipefail
python3 - "${DOMAIN}" <<'PY'
import json, re, sys, urllib.request
dom = sys.argv[1]
try:
    d = json.load(urllib.request.urlopen('http://127.0.0.1:7500/api/proxy/http', timeout=5))
except Exception:
    sys.exit(0)
for p in d.get('proxies', []):
    n = (p.get('conf') or {}).get('subdomain') or p.get('name') or ''
    if re.fullmatch(r'[a-z0-9-]+', n):
        open(f'/etc/caddy/names/{n}.{dom}', 'a').close()
PY
NAMES
chmod 0755 /usr/local/bin/colloq-relay-names
cat > /etc/systemd/system/colloq-relay-names.service <<'UNIT'
[Unit]
Description=remember colloq relay names for on-demand TLS
After=frps.service
[Service]
Type=oneshot
User=caddy
Group=caddy
ExecStart=/usr/local/bin/colloq-relay-names
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
PrivateTmp=true
ReadWritePaths=/etc/caddy/names
UNIT
cat > /etc/systemd/system/colloq-relay-names.timer <<'UNIT'
[Unit]
Description=remember colloq relay names every minute
[Timer]
OnBootSec=30s
OnUnitActiveSec=1min
AccuracySec=10s
[Install]
WantedBy=timers.target
UNIT
systemctl daemon-reload
systemctl enable --now frps caddy colloq-capy colloq-assets \
  colloq-relay-names.timer colloq-assets-prune.timer
# enable --now не трогает уже запущенное, а скрипт задуман повторяемым:
# без явного перезапуска второй прогон оставил бы обе службы на старом конфиге.
systemctl restart frps caddy colloq-capy colloq-assets
sleep 3
systemctl is-active frps caddy colloq-capy colloq-assets | tr '\n' ' '; echo

echo "== слушают"
ss -lntp | awk 'NR==1 || /:(80|443|7000|8080|9180|9182|7500)\b/{print "  "$4"  "$6}'

echo "== память"
free -m | awk 'NR<=3{print "  "$0}'

echo
echo "секрет для инстансов лежит в /etc/colloq-relay/token"
REMOTE_TAIL
} | "${SSH[@]}" "$HOST" DOMAIN="$DOMAIN" FRP_VERSION="$FRP_VERSION" 'bash -s'

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
echo
say "текст страницы «комната ещё не открыта» правится отдельно:"
printf '  make relay-page WHERE=%s\n' "$HOST"
