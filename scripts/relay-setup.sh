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
# И один файл рядом с ними — страница ожидания. Пока преподаватель не поднял
# комнату, живого клиента для её имени нет, и frps отвечал бы своей встроенной
# страницей: «The page you requested was not found… powered by frp». Студенту,
# пришедшему за десять минут до пары, по ней не понять ни что случилось, ни
# что делать. Вместо неё отдаётся /etc/colloq-relay/offline.html — она же
# показывается, если не отвечает сам frps, и она сама перезагружается, так что
# ждущий попадает в комнату без единого нажатия.
#
# Запускать: scripts/relay-setup.sh root@203.0.113.11
# Только страница: scripts/relay-setup.sh --page root@203.0.113.11
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

RED=$'\033[31m'; OFF=$'\033[0m'
say() { printf '\033[1m%s\033[0m\n' "$*"; }
die() { printf '%s%s%s\n' "$RED" "$*" "$OFF" >&2; exit 1; }

# --------------------------------------------------------------- страница
#
# Кусок удалённого скрипта, который кладёт страницу на место. Отдельной
# функцией, потому что нужен в двух местах: в полной установке и в `--page`.
# Функция печатает текст на stdout, а вызывающий вливает его в общий поток для
# `bash -s` — так текст страницы существует в одном экземпляре и не может
# разъехаться между двумя режимами.
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
cat > "$page_tmp" <<'PAGE_EOF'
<!doctype html>
<html lang="ru">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Комната ещё не открыта — Colloq</title>

    <!--
      Страница ждёт вместо студента: раз в 20 секунд браузер просит тот же
      адрес заново, и то обновление, которое случится после поднятия комнаты,
      приведёт прямо в неё. Нажимать ничего не нужно, помнить про F5 — тоже.

      Перезагрузка сделана метой, а не скриптом, намеренно: скрипт может не
      выполниться, а http-equiv="refresh" понимает всё, что вообще открывает
      страницы. 20 секунд — компромисс между «попасть в комнату сразу» и
      «не долбить адрес»: это один запрос на студента в двадцать секунд.
    -->
    <meta http-equiv="refresh" content="20" />

    <!--
      Ни одного внешнего запроса: ни шрифтов, ни картинок, ни библиотек. Эту
      страницу отдаёт ретранслятор в тот момент, когда у него и так что-то не
      так, а открывают её с телефона по сотовой связи в аудитории, где может
      не грузиться вообще ничего. Всё, что ей нужно, — в этом файле.
    -->
    <meta name="color-scheme" content="light dark" />
    <meta name="robots" content="noindex" />

    <style>
      /*
       * Палитра ВШЭ, та же, что у продукта и у лендинга (web/src/index.css,
       * site/styles.css). Светлый набор стоит на голом :root, тёмный приходит
       * из системной настройки: выбирать тему тут негде и незачем — человек
       * пробудет на странице минуту.
       */
      :root {
        --canvas: #ffffff;
        --surface: #f3f6fb;
        --line: #dce3ef;
        --ink: #101a33;
        --muted: #5d6b8a;
        /* Яркий голубой не проходит по контрасту как текст на белом — для
           набора берётся его тёмный вариант, для точки и меток сам голубой. */
        --accent: #0fa0d7;
        --accent-text: #0a6e96;
        --mark: #0f2d69;
      }

      @media (prefers-color-scheme: dark) {
        :root {
          --canvas: #060c1c;
          --surface: #0e1b3d;
          --line: #16244b;
          --ink: #e6e7e8;
          --muted: #9ba6be;
          /* На тёмной земле голубой даёт 6.5:1 — здесь он и есть текст. */
          --accent-text: #0fa0d7;
          /* Синь бренда на почти чёрном не видна; знак берёт светлый её тон. */
          --mark: #7b93c9;
        }
      }

      * { box-sizing: border-box; }

      /*
       * Шрифт только тот, что уже есть у читателя. HSE Sans стоит первым — у
       * половины ФКН он установлен, и тогда страница набрана тем же, чем весь
       * продукт; у остальных её наберёт системный, и это ровно то, что нужно:
       * ни одного байта из сети.
       */
      body {
        margin: 0;
        min-height: 100vh;
        min-height: 100svh;
        display: flex;
        align-items: center;
        justify-content: center;
        padding: clamp(24px, 7vw, 64px);
        background: var(--canvas);
        color: var(--ink);
        font-family: 'HSE Sans', Inter, ui-sans-serif, system-ui, -apple-system,
          'Segoe UI', Roboto, sans-serif;
        font-size: 17px;
        line-height: 28px;
        -webkit-font-smoothing: antialiased;
      }

      main { max-width: 34rem; }

      .mark { display: block; width: 26px; height: 26px; }
      .mark rect { fill: var(--mark); }
      .mark rect:nth-child(2n) { fill: var(--accent); }

      .label {
        margin: 14px 0 0;
        font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
        font-size: 12px;
        font-weight: 500;
        letter-spacing: 0.16em;
        line-height: 18px;
        text-transform: uppercase;
        color: var(--accent-text);
      }

      h1 {
        margin: 12px 0 0;
        font-size: clamp(26px, 5.5vw, 34px);
        line-height: 1.2;
        letter-spacing: -0.01em;
        font-weight: 700;
        /* Заголовок в две строки не должен ронять одно слово на вторую. */
        text-wrap: balance;
      }

      p { margin: 20px 0 0; }

      .note { font-size: 15px; line-height: 24px; color: var(--muted); }

      /* Что делать — единственный блок с землёй под ним: это и есть ответ. */
      .wait {
        display: flex;
        gap: 14px;
        align-items: flex-start;
        margin-top: 28px;
        padding: 18px 20px;
        border: 1px solid var(--line);
        border-radius: 12px;
        background: var(--surface);
      }

      .dot {
        flex: none;
        width: 9px;
        height: 9px;
        margin-top: 10px;
        border-radius: 50%;
        background: var(--accent);
        animation: breathe 2.6s ease-in-out infinite;
      }

      /* Точка дышит, а не мигает: мигание торопит, а тут именно ждут. */
      @keyframes breathe {
        0%, 100% { opacity: 0.35; transform: scale(0.85); }
        50%      { opacity: 1;    transform: scale(1); }
      }

      @media (prefers-reduced-motion: reduce) {
        .dot { animation: none; opacity: 0.9; }
      }
    </style>
  </head>

  <body>
    <main>
      <!-- Знак Colloq: та же сетка, что и в фавиконе продукта. -->
      <svg class="mark" viewBox="0 0 24 24" aria-hidden="true">
        <rect x="2" y="2" width="6" height="6" rx="1.6" />
        <rect x="9" y="2" width="6" height="6" rx="1.6" />
        <rect x="16" y="2" width="6" height="6" rx="1.6" />
        <rect x="2" y="9" width="6" height="6" rx="1.6" />
        <rect x="9" y="9" width="6" height="6" rx="1.6" />
        <rect x="16" y="9" width="6" height="6" rx="1.6" />
        <rect x="2" y="16" width="6" height="6" rx="1.6" />
        <rect x="9" y="16" width="6" height="6" rx="1.6" />
        <rect x="16" y="16" width="6" height="6" rx="1.6" />
      </svg>

      <p class="label">Colloq</p>

      <h1>Комната ещё не открыта</h1>

      <p>
        По этому адресу занятие сейчас не идёт. Комнату открывает
        преподаватель — обычно незадолго до начала, и до этой минуты её здесь
        просто нет.
      </p>

      <p class="wait">
        <span class="dot"></span>
        <span>
          Ждать можно прямо здесь: страница сама обновляется каждые двадцать
          секунд и откроет комнату, как только та появится. Оставьте вкладку
          открытой — нажимать ничего не нужно.
        </span>
      </p>

      <p class="note">
        Если ждёте давно, стоит сверить адрес с тем, который вам дали: одна
        буква в имени уводит на пустую страницу вроде этой.
      </p>
    </main>
  </body>
</html>
PAGE_EOF

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
   ! grep -q 'offline.html' /etc/caddy/Caddyfile 2>/dev/null; then
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
cat <<'REMOTE_HEAD'
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
		rewrite * /api/proxy/http/{re.ours.1}
		reverse_proxy 127.0.0.1:7500
	}
	handle {
		respond 403
	}
}

# Всё остальное, что приходит на 443 по любому имени.
:443 {
	tls {
		on_demand
	}
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
	handle /robots.txt {
		header Content-Type text/plain
		respond "User-agent: *
Disallow: /
" 200
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
