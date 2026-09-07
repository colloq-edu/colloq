#!/usr/bin/env bash
#
# Colloq на выделенной машине: сервер службой systemd, ядра комнат — в docker.
#
#   scripts/service.sh install   поставить и запустить (идемпотентно)
#   scripts/service.sh restart   перезапустить — после git pull и сборки
#   scripts/service.sh stop      остановить (ядра комнат остаются жить)
#   scripts/service.sh status    жива ли служба и готова ли вести семинар
#   scripts/service.sh logs      журнал, Ctrl+C — выйти
#
# ЗАЧЕМ ЭТО, КОГДА ЕСТЬ `make up`. Способов запуска три, и они не
# взаимозаменяемы:
#
#   make up   весь стек в docker. Ноутбук, разовая демонстрация, «посмотреть».
#   make run  сервер руками, ядро в docker. Разработка: пересборка — секунды.
#   служба    сервер на хосте под systemd, в docker только ядра. Выделенная
#             машина — своя или арендованная, — на которой идут занятия.
#
# Форму меняли не от красоты. Под `make up` на выделенной машине ломалось
# дважды, и оба раза одинаково — сервер в контейнере не видит того, что вокруг:
#
#   1. Каталоги data/ и workspace/ заводились от root (их создаёт демон docker
#      под bind-монт), а сервер внутри работает от uid 1000: база не
#      открывалась вовсе, контейнер уходил в цикл перезапусков.
#   2. Панель не могла собрать окружение: внутри контейнера нет ни
#      docker-compose.yml, ни kernel/Dockerfile, ни .env — а сборка окружения
#      это они и есть. Кнопка Build была, толку не было.
#
# Сервер на хосте отменяет оба: репозиторий, .env и docker лежат с ним рядом,
# панель всесильна, и расхождения пользователей нет — см. deploy/colloq.service,
# где названа и цена (служба работает от root).
#
# ЧТО ДЕЛАЕТ install, по шагам: проверяет машину, заводит .env, ставит docker
# (если его нет) и Node, собирает проект, собирает образ ядра, чинит владельцев
# каталогов и, наконец, кладёт юнит и ждёт, пока инстанс скажет о готовности.
# Образ раньше каталогов не для порядка: у него и спрашивают, какой группе
# отдавать workspace/.
# Каждый шаг переживает повторный запуск: `install` — это и первая установка, и
# обновление кода.
set -euo pipefail

cd "$(dirname "$0")/.."

RED=$'\033[31m'; DIM=$'\033[2m'; BOLD=$'\033[1m'; CYAN=$'\033[36m'; OFF=$'\033[0m'
say() { printf '%s\n' "$*"; }
die() { printf '%s%s%s\n' "$RED" "$*" "$OFF" >&2; exit 1; }

SERVICE=colloq
UNIT=/etc/systemd/system/$SERVICE.service
TEMPLATE=deploy/$SERVICE.service
# Путь-умолчание, записанный в шаблоне. Заменяется на настоящий каталог
# репозитория; вынесен в переменную, чтобы замена и шаблон не разъехались.
TEMPLATE_ROOT=/opt/colloq
# Node ставится мажорной веткой. 20 — та, на которой проект собирается и
# проверяется; машина, где уже стоит 20 или новее, не трогается вовсе.
NODE_MAJOR="${NODE_MAJOR:-20}"

REPO="$PWD"

# read_env — общий для всех скриптов, scripts/lib.sh: своя копия жила в трёх
# файлах и всюду вырезала пробелы внутри значений.
. ./scripts/lib.sh
PORT="$(read_env PORT)"; PORT="${PORT:-3000}"

CMD="${1:-}"

# ---------------------------------------------------------------- проверки

# Служба — это Linux с systemd и права root. Отказ здесь короткий и до того,
# как что-нибудь установлено: на macOS ставить systemd-юнит некуда, а под
# обычным пользователем всё равно нечем.
need_systemd() {
  [ "$(uname -s)" = Linux ] || die "служба systemd бывает только на Linux.
  На ноутбуке два других способа: make up (всё в docker) или make run."
  command -v systemctl >/dev/null 2>&1 || die "на этой машине нет systemd (systemctl не найден).
  Способ рассчитан на Ubuntu/Debian. Без systemd остаются make up и make run."
}

need_root() {
  [ "$(id -u)" = 0 ] || die "нужны права root: sudo $0 $CMD
  Служба ставится в /etc/systemd/system и работает от root — почему именно так,
  сказано в шапке deploy/colloq.service."
}

# Служба установлена — не «работает», а «есть файл юнита». Ею отвечают на
# вопрос «эта машина уже переведена на новую форму».
installed() { [ -f "$UNIT" ]; }
active() { systemctl is-active --quiet "$SERVICE" 2>/dev/null; }

# Ждём не «systemctl вернул управление», а ответа /api/health: он отвечает 200
# только когда и база читается, и Python комнаты готов запуститься. Ссылка,
# напечатанная над инстансом, который ещё поднимается, — это ссылка, розданная
# аудитории за минуту до того, как она заработает.
wait_health() {
  local tries="${1:-60}" i
  for ((i = 0; i < tries; i++)); do
    if curl -fsS -m 2 "http://localhost:$PORT/api/health" >/dev/null 2>&1; then return 0; fi
    active || return 1
    sleep 1
  done
  return 1
}

# Что сказать, когда готовности не дождались. Две разные беды с одинаковым
# экраном: служба упала (смотреть журнал) и служба жива, но семинар вести
# нельзя (обычно несобранное окружение или выключенный docker).
explain_unhealthy() {
  printf '\n'
  if active; then
    say "${RED}служба работает, но не готова вести семинар${OFF}"
    say "${DIM}что говорит она сама:${OFF}"
    curl -fsS -m 3 "http://localhost:$PORT/api/health" 2>/dev/null | head -c 400 | sed 's/^/    /' || true
    printf '\n'
    say "${DIM}чаще всего это несобранное окружение ядра (make env-build NAME=…)${OFF}"
    say "${DIM}или недоступный docker (systemctl status docker)${OFF}"
  else
    say "${RED}служба не поднялась${OFF}"
  fi
  say "${DIM}журнал: journalctl -u $SERVICE -n 40 --no-pager${OFF}"
  journalctl -u "$SERVICE" -n 20 --no-pager 2>/dev/null | sed 's/^/    /' || true
}

# Рецепт ядра изменился после того, как собрали образ?
#
# «Образ есть — значит готово» верно ровно до правки самого рецепта, и цена
# ошибки тут молчаливая: комнаты идут на прежнем образе, панель говорит
# «Ready», а правка не работает. Так уехала правка matplotlib: `MPLBACKEND=Agg`
# в Dockerfile убирал у ядра всякую врисованную картинку, а после раскатки
# образ остался прежним, потому что он «уже собран».
#
# Список пакетов окружения сюда не входит: за ним следит сам сервер, по своей
# отметке о сборке (server/src/environments.ts · editedSinceBuild), и он умеет
# сравнивать содержимое, а не время. Здесь — только общая для всех окружений
# основа, у которой отметки нет.
kernel_recipe_newer() {
  local image="colloq-kernel:$1" created built file
  created="$(docker image inspect -f '{{.Created}}' "$image" 2>/dev/null || true)"
  [ -n "$created" ] || return 0
  built="$(date -d "$created" +%s 2>/dev/null || true)"
  # Дату не разобрали — пересобирать наугад дороже, чем довериться образу:
  # сборка базы это минуты простоя на каждой раскатке.
  [ -n "$built" ] || return 1
  # Через `if`, а не `[ … ] && return 0`: при `set -e` неудачная проверка на
  # последнем файле уронила бы весь скрипт вместо «нет, не новее».
  for file in kernel/Dockerfile kernel/requirements.txt; do
    [ -f "$file" ] || continue
    if [ "$(stat -c %Y "$file" 2>/dev/null || echo 0)" -gt "$built" ]; then return 0; fi
  done
  return 1
}

# ---------------------------------------------------------------- install

cmd_install() {
  need_systemd
  need_root

  local steps=8

  say "${BOLD}1/$steps${OFF} проверяю машину"
  [ -f package.json ] && [ -d server/src ] || die "это не репозиторий Colloq: $REPO
  Запускать надо из клона: cd /opt/colloq && make service-install"
  [ -f "$TEMPLATE" ] || die "нет $TEMPLATE — шаблона юнита. Клон неполный?"
  # Путь репозитория уезжает и в юнит, и в sed, которым его туда подставляют.
  # Юнит — не оболочка: путь с пробелом там нужно брать в кавычки, а '#' в
  # пути сломал бы саму подстановку. Отказ дешевле молчаливо кривого юнита.
  case "$REPO" in
    *[!A-Za-z0-9._/-]*) die "в пути «$REPO» есть знаки, которых не понимает юнит systemd.
  Перенесите репозиторий туда, где в пути только буквы, цифры, точка, дефис,
  подчёркивание и слэш: /opt/colloq — то, что использует scripts/vast.sh." ;;
  esac
  # Кто держит порт. Второй Colloq на том же порту — это две базы, два
  # setup-token и ссылки, ведущие то туда, то сюда; поймать это по экрану
  # невозможно. Своя же служба (переустановка) — не помеха.
  if active; then
    say "${DIM}    служба уже стоит и работает — это обновление${OFF}"
  elif docker compose ps --status running --services 2>/dev/null | grep -qx app; then
    die "в docker работает app — это Colloq прежней формы, и он держит порт $PORT.
  Остановите его и повторите: make down"
  elif [ -f .colloq.pid ] && kill -0 "$(cat .colloq.pid 2>/dev/null)" 2>/dev/null; then
    die "на хосте работает сервер, запущенный через make run.
  Остановите его и повторите: make stop"
  elif command -v ss >/dev/null 2>&1 && ss -ltn 2>/dev/null | grep -qE "[:.]$PORT[[:space:]]"; then
    die "порт $PORT занят кем-то ещё — служба на него не встанет.
  Посмотреть кем: ss -ltnp | grep :$PORT"
  fi

  say "${BOLD}2/$steps${OFF} настройки"
  # .env заводится тем же кодом, что и для остальных способов запуска: там же
  # выписывается свой JUPYTER_TOKEN вместо общеизвестного из примера. Зовём
  # только когда файла нет: у make на существующий файл ответ «is up to date»,
  # и в выводе установки это лишняя строка, которая выглядит как ошибка.
  [ -f .env ] || make --no-print-directory .env
  # Порт перечитываем: до этой строки его могло не быть вовсе, а дальше по нему
  # проверяют занятость и готовность.
  PORT="$(read_env PORT)"; PORT="${PORT:-3000}"
  # Три строки, которые ломают эту форму молча.
  #
  # WORKSPACE_HOST_DIR для сервера в контейнере называет ./workspace глазами
  # хоста. Здесь сервер САМ на хосте — путь и так верный, — но сервер читает
  # эту переменную ещё и как признак «я в контейнере»: увидев её, он поставит
  # ядро комнаты в сеть compose и позовёт его по имени контейнера, до которого
  # с хоста дороги нет. Каждый Run кончался бы ошибкой.
  if [ -n "$(read_env WORKSPACE_HOST_DIR)" ]; then
    die "в .env задан WORKSPACE_HOST_DIR — уберите строку.
  Она нужна только серверу, который сам живёт в контейнере (make up). Здесь
  сервер на хосте, и по этой переменной он решит, что он в контейнере: ядро
  комнаты уедет в сеть compose, а звать его будут по имени, которого с хоста
  не видно. Комната ответит ошибкой на первом же Run."
  fi
  # KERNEL_NETWORK без WORKSPACE_HOST_DIR сервер не читает вовсе — но строка,
  # оставшаяся от прежней формы, обещает то, чего здесь нет. Говорим и идём.
  if [ -n "$(read_env KERNEL_NETWORK)" ]; then
    say "${DIM}    KERNEL_NETWORK в .env не нужен: сеть compose здесь ни при чём,${OFF}"
    say "${DIM}    ядро комнаты слушает порт на петле. Строка просто не читается.${OFF}"
  fi
  # Изоляция выключена — значит комнаты делят одно ядро. Под `make up` им
  # служило ядро compose; здесь его никто не поднимает, и общего Python на
  # машине нет вовсе.
  if [ "$(read_env KERNEL_ISOLATION)" = off ]; then
    say "${RED}    KERNEL_ISOLATION=off — у комнат не будет своих ядер${OFF}"
    say "${DIM}    А общее ядро compose здесь не поднимается: подняли бы его вы сами${OFF}"
    say "${DIM}    (make dev публикует 8888 на петлю). Иначе Python не будет ни у кого.${OFF}"
  fi
  say "${DIM}    .env на месте${OFF}"

  say "${BOLD}3/$steps${OFF} docker — ядрам комнат"
  export DEBIAN_FRONTEND=noninteractive
  if ! command -v docker >/dev/null 2>&1; then
    say "${DIM}    ставлю (get.docker.com)${OFF}"
    curl -fsSL https://get.docker.com | sh >/dev/null
  fi
  systemctl enable --now docker >/dev/null 2>&1 || true
  docker version --format '{{.Server.Version}}' >/dev/null 2>&1 \
    || die "docker есть, но демон не отвечает: systemctl status docker
  Без него у комнаты нет своего ядра, а на этой машине — и никакого."
  say "${DIM}    docker $(docker version --format '{{.Server.Version}}' 2>/dev/null)${OFF}"
  # Сборка окружений идёт двумя дорогами: `make env-build` зовёт docker compose,
  # панель — прямой `docker build`, а он с 23-го клиента требует buildx. Нет
  # плагина — кнопка Build отвечает «buildx component is missing», и понять это
  # по экрану нельзя. Не отказ: семинар с уже собранным образом идёт и так.
  docker buildx version >/dev/null 2>&1 \
    || say "${RED}    нет docker-buildx-plugin — панель не соберёт окружение${OFF}"
  docker compose version >/dev/null 2>&1 \
    || say "${RED}    нет docker-compose-plugin — make env-build не соберёт окружение${OFF}"

  say "${BOLD}4/$steps${OFF} Node $NODE_MAJOR"
  # Почему nodesource, а не пакет дистрибутива и не nvm.
  #
  # В Debian 12 node это 18, в Ubuntu 22.04 — 12: обе ветки старше того, на чём
  # проект собирается. nvm ставится в оболочку пользователя, а служба systemd
  # ничьей оболочки не видит — юнит просто не нашёл бы node. Остаётся
  # официальный репозиторий nodesource: обычный apt-источник, обновления
  # приезжают вместе с остальной машиной.
  local have=0
  if command -v node >/dev/null 2>&1; then
    have="$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)"
  fi
  if [ "$have" -ge "$NODE_MAJOR" ] 2>/dev/null; then
    say "${DIM}    уже стоит node $(node -v)${OFF}"
  else
    apt-get update -qq
    apt-get install -y -qq curl ca-certificates gnupg >/dev/null
    curl -fsSL "https://deb.nodesource.com/setup_${NODE_MAJOR}.x" | bash - >/dev/null
    apt-get install -y -qq nodejs >/dev/null
    say "${DIM}    node $(node -v)${OFF}"
  fi
  # Инструменты сборки — ради better-sqlite3: готовая сборка есть не под всякую
  # связку версии node и архитектуры, и тогда npm собирает её из исходников. Без
  # компилятора это отказ на `npm ci` с трёхэтажным стеком, из которого причина
  # не следует. Те же три пакета стоят в Dockerfile и по той же причине.
  if ! command -v g++ >/dev/null 2>&1 || ! command -v make >/dev/null 2>&1; then
    apt-get update -qq
    apt-get install -y -qq python3 make g++ >/dev/null
  fi

  say "${BOLD}5/$steps${OFF} собираю"
  say "${DIM}    первый раз это несколько минут${OFF}"
  # `npm ci`, а не install: замок в репозитории, и собирать надо ровно те
  # версии, на которых проект проверяли. --include=dev названо вслух, потому что
  # сборке нужны devDependencies (vite, tsc), а NODE_ENV=production в окружении
  # машины молча выбросил бы их.
  npm ci --no-audit --no-fund --include=dev

  # Клиент собирается РЯДОМ и переезжает на место переименованием.
  #
  # `vite build` первым делом опустошает свой outDir, а web/dist прямо сейчас
  # отдаёт с диска работающая служба (express.static, server/src/index.ts).
  # Пока шла сборка — на арендованной машине это минуты, — любая перезагрузка
  # вкладки в идущей комнате получала 404 на /assets/*.js: белый экран посреди
  # пары ровно потому, что кто-то обновляет код. Эта же команда — единственный
  # штатный способ обновления («git pull && make service-install»), так что
  # случай не редкий.
  #
  # Переименование каталога — одна операция файловой системы, и окна, в котором
  # статики нет, не существует.
  rm -rf web/dist.next web/dist.prev
  npm run build -w @colloq/web -- --outDir dist.next --emptyOutDir
  [ -f web/dist.next/index.html ] || die "сборка прошла, а web/dist.next/index.html нет — комната открылась бы пустой."
  if [ -d web/dist ]; then mv web/dist web/dist.prev; fi
  mv web/dist.next web/dist
  rm -rf web/dist.prev

  # Сервер — один файл, и подмена его работающему процессу не видна вовсе: node
  # прочитал его при старте. Новый возьмётся перезапуском службы восьмым шагом.
  npm run build -w @colloq/server
  [ -f server/dist/server.js ] || die "сборка прошла, а server/dist/server.js нет — смотрите вывод выше."

  say "${BOLD}6/$steps${OFF} образ ядра"
  # Без собранного образа окружения инстанс поднимется, но семинар вести не
  # сможет: комната просит `colloq-kernel:<окружение>`, и его нет. Раньше это
  # делал `make up` заодно со сборкой всего стека; здесь стека нет, и шаг стал
  # виден. Уже собранный образ не пересобирается — это и есть идемпотентность.
  local env_name; env_name="$(read_env KERNEL_ENV)"; env_name="${env_name:-base}"
  if docker image inspect "colloq-kernel:$env_name" >/dev/null 2>&1 && ! kernel_recipe_newer "$env_name"; then
    say "${DIM}    colloq-kernel:$env_name уже собран${OFF}"
  else
    say "${DIM}    собираю colloq-kernel:$env_name — это долго, минуты${OFF}"
    make --no-print-directory env-build NAME="$env_name"
  fi

  say "${BOLD}7/$steps${OFF} каталоги и владельцы"
  mkdir -p data workspace
  # data/ — только сервера. Он root, поэтому владельца здесь не меняем вовсе:
  # база, ключ подписи и токен установки остаются за тем, кто их пишет.
  # (Каталог мог достаться от прежней формы с владельцем 1000 — root пишет туда
  # и так, ломать ничего не нужно.)
  #
  # workspace/ — общий с ядром: сервер кладёт туда загрузки, ядро комнаты пишет
  # результаты ячеек от uid 1000. Группа ядра и бит setgid делают то, что при
  # прежних формах получалось само собой (там обе стороны были uid 1000): всё
  # новое внутри достаётся этой группе, а UMask=0002 из юнита даёт ей право
  # писать. Без этой пары первая же ячейка с open(...,'w') падает
  # PermissionError на зелёном экране.
  #
  # Группа рекурсивно, права — только каталогам. Владельца файлов внутри не
  # трогаем вовсе: то, что писало ядро, принадлежит ему же и им правится, а
  # став root:<группа> с прежними 0644 стало бы для него нередактируемым.
  #
  # Номер группы не прибит, а спрошен у самого образа: `runner` в
  # kernel/Dockerfile заводится с uid 1000, но группу ему выдаёт useradd — и
  # если в родительском образе (окружение может строиться поверх CUDA-базы)
  # gid 1000 уже занят, она окажется другой. Прибитая тысяча тогда молча не
  # совпала бы, и первая ячейка с записью в файл упала бы PermissionError.
  local kgid
  kgid="$(docker run --rm "colloq-kernel:$env_name" id -g 2>/dev/null | tr -dc '0-9' || true)"
  if [ -z "$kgid" ]; then
    kgid=1000
    say "${DIM}    у образа группу не спросил — беру 1000, как в kernel/Dockerfile${OFF}"
  fi
  chgrp -R "$kgid" workspace 2>/dev/null || say "${DIM}    группу $kgid поставить не вышло${OFF}"
  find workspace -type d -exec chmod 2775 {} + 2>/dev/null || true
  say "${DIM}    workspace/ — группа $kgid и setgid: ядро комнаты пишет туда же, куда сервер${OFF}"

  say "${BOLD}8/$steps${OFF} служба"
  # Юнит кладётся из шаблона с подстановкой пути. Сравнение с тем, что уже
  # лежит, — не бережливость: лишний daemon-reload на каждой переустановке
  # прячет в журнале настоящие изменения, а тут видно, менялось ли что-то.
  local tmp; tmp="$(mktemp)"
  sed "s#$TEMPLATE_ROOT#$REPO#g" "$TEMPLATE" > "$tmp"
  if [ -f "$UNIT" ] && cmp -s "$tmp" "$UNIT"; then
    say "${DIM}    $UNIT не изменился${OFF}"
    rm -f "$tmp"
  else
    install -m 0644 "$tmp" "$UNIT"
    rm -f "$tmp"
    say "${DIM}    $UNIT записан${OFF}"
    systemctl daemon-reload
  fi
  # enable — это «подниматься после перезагрузки». Молчаливый отказ здесь стоил
  # бы машины, которая после планового ребута не поднимает семинар вовсе.
  systemctl enable "$SERVICE" >/dev/null 2>&1 \
    || say "${RED}    systemctl enable не прошёл — после перезагрузки служба сама не встанет${OFF}"
  # restart, а не start: команда одна и для первой установки, и для обновления
  # кода, и повторный запуск не должен спотыкаться о «уже работает».
  systemctl restart "$SERVICE"

  if wait_health 90; then
    printf '\n'
    say "${BOLD}Colloq работает службой${OFF} ${DIM}(systemd, от root)${OFF}"
    say "  ${CYAN}$(read_env PUBLIC_URL)${OFF}"
    say "${DIM}журнал: make service-logs · перезапуск: make service-restart${OFF}"
    say "${DIM}наружу: make host HOST=<имя>${OFF}"
  else
    explain_unhealthy
    exit 1
  fi
}

# ---------------------------------------------------------------- прочее

cmd_restart() {
  need_systemd
  need_root
  installed || die "служба не установлена. Поставить: make service-install"
  systemctl restart "$SERVICE"
  if wait_health 60; then
    say "${DIM}служба перезапущена и отвечает${OFF}"
  else
    explain_unhealthy
    exit 1
  fi
}

cmd_stop() {
  need_systemd
  need_root
  installed || die "служба не установлена — останавливать нечего."
  # Только сервер. Контейнеры комнат остаются жить: это ядра с переменными
  # семинара, и убивать их ради перезапуска сервера незачем — при следующем
  # открытии комнаты сервер найдёт их по метке и подхватит. Убрать все разом —
  # make down.
  systemctl stop "$SERVICE"
  say "${DIM}служба остановлена. Ядра комнат остались — снять их: make down${OFF}"
}

cmd_logs() {
  need_systemd
  installed || die "служба не установлена. Поставить: make service-install"
  journalctl -u "$SERVICE" -n 80 -f
}

cmd_status() {
  need_systemd
  if ! installed; then
    say "${DIM}служба не установлена${OFF} ${DIM}($UNIT)${OFF}"
    say "${DIM}поставить: make service-install · другие способы: make up, make run${OFF}"
    return 0
  fi
  systemctl status "$SERVICE" --no-pager -n 5 || true
  printf '\n'
  # «active (running)» — это про процесс, а не про семинар. Отдельным вопросом
  # спрашиваем, готов ли инстанс вести пару: база и Python комнаты.
  if curl -fsS -m 3 "http://localhost:$PORT/api/health" >/dev/null 2>&1; then
    say "${CYAN}готов вести семинар${OFF} ${DIM}(localhost:$PORT/api/health)${OFF}"
  else
    say "${RED}семинар вести не готов${OFF}"
    curl -fsS -m 3 "http://localhost:$PORT/api/health" 2>/dev/null | head -c 400 | sed 's/^/  /' || true
    printf '\n'
  fi
  say "${DIM}PUBLIC_URL: $(read_env PUBLIC_URL)${OFF}"
}

case "$CMD" in
  install) cmd_install ;;
  restart) cmd_restart ;;
  stop)    cmd_stop ;;
  logs)    cmd_logs ;;
  status)  cmd_status ;;
  *)
    say "${BOLD}Colloq службой systemd${OFF} ${DIM}— сервер на хосте, ядра комнат в docker${OFF}"
    say "  scripts/service.sh install  ${DIM}поставить и запустить (он же — обновить)${OFF}"
    say "  scripts/service.sh restart  ${DIM}перезапустить${OFF}"
    say "  scripts/service.sh stop     ${DIM}остановить (ядра комнат остаются)${OFF}"
    say "  scripts/service.sh status   ${DIM}жива ли и готова ли вести семинар${OFF}"
    say "  scripts/service.sh logs     ${DIM}журнал${OFF}"
    say ""
    say "${DIM}то же через make: make service-install · service-restart · service-stop${OFF}"
    say "${DIM}                  make service-status · service-logs${OFF}"
    say "${DIM}Для ноутбука это не нужно: make up (всё в docker) или make run.${OFF}"
    if [ -n "$CMD" ]; then die "не знаю команды «${CMD}»."; fi
    ;;
esac
