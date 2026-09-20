# Colloq — команды на каждый день.
#
# Две вещи, ради которых это существует:
#
#   make run               собрать и запустить
#   make host              поднять семинар и получить ссылку для аудитории
#   make env-use NAME=cv   окружение Python для новых семинаров
#
# Разработка: make dev — сервер с перезагрузкой и Vite в одном терминале.
#
# Всё считается на этой машине. Наружу её выводит `make host` — туннелем,
# исходящим соединением, так что ни белого IP, ни проброса портов на роутере
# не нужно. Туннель идёт либо в Cloudflare, либо на свой ретранслятор под
# *.colloq.ru (make relay-setup) — адреса Cloudflare из России не открываются.
#
# У машины со своим белым адресом есть путь короче: `make host-direct` ставит
# caddy прямо здесь, и посредника на пути студентов нет вовсе. Так и надо
# вести настоящую аудиторию: ретранслятор на гигабайте памяти двести сокетов
# не держит — измерено. Что когда брать — в README, раздел про транспорты.

SHELL := /bin/bash
.DEFAULT_GOAL := help

# Каталог со списками пакетов. Одно окружение — один файл.
ENV_DIR := kernel/environments
# Версия Python по умолчанию — из самого Dockerfile, а не вторым списком: там
# стоит `ARG PARENT=python:<версия>-slim-bookworm`, и именно она действует,
# когда окружение про версию молчит. Своя копия числа разъехалась бы с ней
# молча — и `make env-show` рассказывал бы про 3.11 над образом с 3.12.
PY_DEFAULT := $(shell sed -nE 's/^ARG PARENT=python:([0-9]+\.[0-9]+)-.*/\1/p' kernel/Dockerfile | head -1)
# Какие версии вообще предлагаются — оттуда же, откуда их берёт панель.
PY_LIST := $(shell sed -nE "s/^export const PYTHON_VERSIONS = \[(.*)\].*/\1/p" shared/admin.ts | tr -d "' " | tr ',' ' ')
# Разбор двух директив шапки. Для pip это комментарии, для нас — устройство.
PY_FROM = sed -nE 's/^[[:space:]]*\#[[:space:]]*colloq:[[:space:]]*from[[:space:]]+([^[:space:]]+)[[:space:]]*$$/\1/p'
PY_PICK = sed -nE 's/^[[:space:]]*\#[[:space:]]*colloq:[[:space:]]*python[[:space:]]+(3\.[0-9]+)[[:space:]]*$$/\1/p'
# На каком Python поедет окружение: версию задаёт КОРЕНЬ цепочки `# colloq:
# from`, потому что приходит она из базового образа, а слой поверх готового
# образа интерпретатор не меняет. Восемь шагов — тот же потолок, что и у сборки.
PY_OF = py_of() { n="$$1"; i=0; while [ $$i -lt 8 ]; do u=$$($(PY_FROM) $(ENV_DIR)/$$n.txt 2>/dev/null | head -1); if [ -z "$$u" ] || [ ! -f $(ENV_DIR)/$$u.txt ]; then break; fi; n="$$u"; i=$$((i+1)); done; v=$$($(PY_PICK) $(ENV_DIR)/$$n.txt 2>/dev/null | head -1); printf '%s' "$${v:-$(PY_DEFAULT)}"; }
# Какое окружение сейчас запечено в образ ядра. Пишется в .env, читается compose.
CURRENT_ENV = $(shell grep -E '^KERNEL_ENV=' .env 2>/dev/null | tail -1 | cut -d= -f2- | tr -d ' ')
CURRENT_ENV := $(if $(CURRENT_ENV),$(CURRENT_ENV),base)
# Порт читается из .env, а не из оболочки. Задают его именно там — так говорят
# и README, и .env.example, — а `$$PORT` в рецепте это переменная окружения
# человека, обычно пустая. При PORT=4000 в .env сервер слушал 4000, `make run`
# ждал готовности на 3000 и объявлял здоровый инстанс не поднявшимся.
PORT = $(shell grep -E '^PORT=' .env 2>/dev/null | tail -1 | cut -d= -f2- | tr -d ' ')
PORT := $(if $(PORT),$(PORT),3000)

BOLD := \033[1m
DIM  := \033[2m
CYAN := \033[36m
RED  := \033[31m
OFF  := \033[0m

# Все цели — .PHONY, и это не формальность: рядом лежит каталог `site/`, из-за
# которого `make site` печатал «site is up to date» и не делал ничего — ни
# страниц, ни коммита, ни пуша, — отчитываясь при этом успехом.
.PHONY: help up dev run dirs docker-gid stop logs-run down restart logs status ps shell activity \
        service-install service-restart service-stop service-status service-logs \
        host host-direct relay-setup relay-page tunnel-setup site mirror readme-art site-icons site-og ui sync load course \
        vast-up vast-status vast-sync vast-logs vast-down vast-adopt \
        env-list env-show env-new env-use env-build env-freeze \
        backup restore test check pack wheel version bump

## ------------------------------------------------------------------ запуск

up: .env dirs docker-gid ## Локальная разработка в Docker: отдельное ядро каждой комнате
	docker compose build kernel
	docker compose up -d --build app
	@printf '$(BOLD)colloq на$(OFF) $(CYAN)http://localhost:$(PORT)$(OFF)\n'
	@printf '$(DIM)окружение ядра: $(CURRENT_ENV) · наружу — make host$(OFF)\n'

dirs:
	@# Каталоги под базу и файлы семинаров заводим сами, до docker.
	@#
	@# Bind-монт с несуществующим источником Docker на Linux создаёт от root, а
	@# app работает от node: первая же запись data/session-secret падала с
	@# EACCES, `restart: unless-stopped` крутил контейнер в цикле, setup-token
	@# не печатался — то есть `make up` на свежем клоне не поднимался вовсе. На
	@# macOS этого не видно, поэтому строка выглядит лишней ровно до Ubuntu.
	@mkdir -p data workspace
	@# И отдать их тому, от кого работает сервер в контейнере.
	@#
	@# Создать каталог мало: под root (а на арендованной машине и на сервере
	@# разворачивают именно из-под него) он и владельцем ставит root, а внутри
	@# контейнера сервер — это `node`, uid 1000. База не открывается вовсе,
	@# контейнер уходит в цикл перезапусков с SQLITE_CANTOPEN, и по логу это
	@# читается как поломка сборки, а не как права на папку. Только под root и
	@# только на Linux: на macOS каталоги и так свои, а chown там сломал бы
	@# `make run`, где сервер работает от человека.
	@if [ "$$(id -u)" = 0 ] && [ "$$(uname -s)" = Linux ]; then chown -R 1000:1000 data workspace; fi

docker-gid:
	@# Группа сокета docker — без неё у комнаты нет своего ядра.
	@#
	@# Сервер в контейнере работает от `node`, а сокет принадлежит root:docker.
	@# Нужен тот gid, каким сокет видит ДЕМОН, а не хост: под colima и Docker
	@# Desktop файла на хосте может не быть вовсе, поэтому когда его не видно —
	@# спрашиваем у самого демона одним крошечным контейнером. Пишем в .env, а
	@# не в окружение make: `docker compose` зовут ещё и host.sh, и руки, и все
	@# они читают .env. Не определилось — не беда: сервер не достучится до
	@# docker, скажет об этом в журнал, и комнаты поделят одно ядро, как раньше.
	@grep -qE '^DOCKER_GID=' .env 2>/dev/null || { \
	  gid=$$(stat -c %g /var/run/docker.sock 2>/dev/null \
	    || stat -f %g /var/run/docker.sock 2>/dev/null \
	    || docker run --rm -v /var/run/docker.sock:/var/run/docker.sock busybox stat -c %g /var/run/docker.sock 2>/dev/null); \
	  if [ -n "$$gid" ]; then \
	    printf '\n# Группа сокета docker: с ней сервер поднимает семинару своё ядро.\nDOCKER_GID=%s\n' "$$gid" >> .env; \
	    printf '$(DIM)группа сокета docker: %s — записана в .env, у каждого семинара будет своё ядро$(OFF)\n' "$$gid"; \
	  fi; \
	}

DEV := -f docker-compose.yml -f docker-compose.dev.yml

dev: ## Разработка: сервер с перезагрузкой и Vite, у каждой комнаты своё ядро. OPEN=0 — без браузера, SHARE=1 — ссылка через быстрый туннель
	@# Тот же супервизор, что поднимает занятие у `colloq start` (cli/src/launch.ts):
	@# сам заводит .env, собирает образ ядра, запускает сервер под tsx watch и
	@# Vite, открывает браузер, а по Ctrl+C гасит всё вместе с ядрами этой базы.
	@# Перезагрузка сервера ядра комнат не трогает. Раньше цель только собирала
	@# ядро compose, а сервер поднимали второй командой — и забывали про неё.
	@# SHARE=1 — то же, что `colloq start --share` (cli/src/launch-share.ts).
	@node --import tsx cli/src/launch.ts dev $(if $(filter 0,$(OPEN)),--no-open) $(if $(filter 1,$(SHARE)),--share)

## Как это запускается на самом деле.
##
## Ядро живёт в docker, а сервер — на хосте: так его видно отладчиком, а
## пересборка занимает секунды вместо пересборки образа. Поэтому у ядра
## обязателен dev-override — он публикует 8888 наружу и монтирует ./workspace.
## Без него ядро в контейнере отвечает само себе, сервер с хоста его не
## находит, а файлы семинаров расходятся по двум разным папкам. Контейнер при
## этом выглядит здоровым, поэтому состав файлов задан здесь явно.
PID := .colloq.pid
LOG := .colloq.log

run: .env dirs ## Собрать и запустить. FAST=1 — не сжимать фронтенд заранее (только для правки кода)
	@$(MAKE) --no-print-directory stop
	@# Контейнерный app и хостовой сервер — это два Colloq на одном порту.
	@# Раньше второй просто падал с EADDRINUSE, а после `make down` вставал на
	@# то же место уже пустым: те же localhost:3000, другая база, другой
	@# setup-token, ссылки из расписания отвечают 404. Теперь об этом говорят
	@# вслух и одной командой.
	@if docker compose ps --status running --services 2>/dev/null | grep -qx app; then \
	  printf '$(RED)в docker уже работает app — это второй Colloq на том же порту$(OFF)\n'; \
	  printf '$(DIM)остановить его: make down · или пользоваться им как есть: make logs$(OFF)\n'; \
	  exit 1; \
	fi
	@# И вообще любой, кто держит порт. `make stop` выше знает только про тот
	@# процесс, чей PID записан в файле, — а второй сервер мог поднять кто
	@# угодно, хоть скрипт туннеля. Два Yjs-авторитета на одну комнату дают
	@# полупустую тетрадь с задвоенными ячейками и вечное переподключение, и
	@# понять это по экрану невозможно. Проверка стоит одну команду.
	@#
	@# Спрашивается ровно про СЛУШАТЕЛЯ, обоими вызовами. `lsof -ti :3000`
	@# возвращает pid для любого сокета с этим портом — в том числе для чужой
	@# вкладки, у которой соединение висит в CLOSE_WAIT после только что убитого
	@# сервера. Из-за этого `make run` сразу после `make stop` отказывал
	@# словами «порт занят:» и пустым списком под ними: список-то фильтровал по
	@# LISTEN, а условие — нет.
	@if lsof -nP -iTCP:$(PORT) -sTCP:LISTEN -t >/dev/null 2>&1; then \
	  printf '$(RED)порт $(PORT) уже занят:$(OFF)\n'; \
	  lsof -nP -iTCP:$(PORT) -sTCP:LISTEN | tail -n +2 | awk '{printf "  %s (pid %s)\n", $$1, $$2}'; \
	  printf '$(DIM)это второй Colloq — остановите его и повторите: make stop · make down$(OFF)\n'; \
	  exit 1; \
	fi
	docker compose $(DEV) build kernel
	@printf '$(DIM)образ $(CURRENT_ENV) готов; каждой комнате — отдельное ядро$(OFF)\n'
	@# Сжатое заранее — по умолчанию, и это исправление.
	@#
	@# Раньше сжимал только `make run OPTIMIZE=1`, а без него рядом с assets/ не
	@# было ни одного .br — и сервер сжимал КАЖДЫЙ файл на каждый запрос,
	@# потоковым brotli качества 5 (server/src/app.ts). Измерено на codemirror
	@# из этой сборки: 219 751 байт против 194 920 у качества 11 и 11.6 мс
	@# процессорного времени на каждую отдачу. Двести студентов по звонку — это
	@# двести таких сжатий одного и того же файла на машине, которая в этот
	@# момент поднимает ядра.
	@#
	@# Флага, который нужно вспомнить, для этого мало: его не вспоминали. Теперь
	@# сжатие по умолчанию, а выключается оно там, где действительно мешает, —
	@# в цикле правки кода, где сборка идёт по десять раз в час: FAST=1.
	npm run $(if $(filter 1,$(FAST)),build,build:optimized)
	@# nohup и подоболочка: make уходит сразу, а сервер должен пережить и его,
	@# и закрытие терминала. Всё, что он скажет, включая падение на старте,
	@# уходит в $(LOG) — иначе оно пропадает вместе с оболочкой.
	@# Дописывается, а не перезаписывается: `>` стирал прошлую неделю на каждом
	@# запуске, и «в четверг что-то сломалось» было нечем проверять.
	@#
	@# .env здесь НЕ сорсится, и это исправление. `set -a; . ./.env` — это не
	@# чтение файла, а исполнение его оболочкой: строка `INSTITUTION=Высшая
	@# школа экономики`, ровно та, которую просят .env.example и README, для
	@# bash есть команда `школа` с префиксным присваиванием — «command not
	@# found», и переменная не выставляется вовсе. Сервер читает .env сам
	@# (dotenv, server/src/config.ts), из этого же каталога и с пробелами
	@# внутри значений, — значит достаточно запустить node.
	@#
	@# Разница ровно одна и она обычная для dotenv: переменная, уже выставленная
	@# в оболочке, теперь сильнее строки в .env, а не наоборот. Под службой и в
	@# контейнере так было всегда; PUBLIC_URL — исключение и там, и здесь: его
	@# сервер берёт из файла нарочно (readPublicUrl).
	@( NODE_ENV=development KERNEL_BACKEND=docker STATIC_DIR="$$PWD/web/dist" nohup node server/dist/server.js >> $(LOG) 2>&1 & \
	   echo $$! > $(PID) )
	@# Ждём, пока сервер скажет, что готов, а не две секунды наугад: две
	@# секунды — это либо долго, либо мало, и «мало» печатает ссылку над
	@# инстансом, который ещё поднимается. /api/health отвечает 200 только
	@# когда и база читается, и Jupyter отзывается.
	@#
	@# Ссылка — PUBLIC_URL, а без него то же, что берёт сервер (config.ts ·
	@# readPublicUrl): localhost:PORT. Строки в .env может не быть вовсе: её
	@# нет в файле, который пишут цель .env и colloq, — и готовый сервер
	@# объявлялся пустым «colloq на».
	@ok=; for i in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15; do \
	  if ! kill -0 "$$(cat $(PID) 2>/dev/null)" 2>/dev/null; then break; fi; \
	  if curl -fsS -m 2 "http://localhost:$(PORT)/api/health" >/dev/null 2>&1; then ok=1; break; fi; \
	  sleep 1; \
	done; \
	if [ -n "$$ok" ]; then \
	  url="$$(grep -E '^PUBLIC_URL=' .env | tail -1 | cut -d= -f2-)"; \
	  printf '\n$(BOLD)colloq на$(OFF) $(CYAN)%s$(OFF)\n' "$${url:-http://localhost:$(PORT)}"; \
	  printf '$(DIM)логи: make logs-run · остановить: make stop · наружу: make host$(OFF)\n'; \
	elif kill -0 "$$(cat $(PID) 2>/dev/null)" 2>/dev/null; then \
	  printf '$(RED)сервер запущен, но не отвечает готовностью — ядро не поднялось?$(OFF)\n'; \
	  printf '$(DIM)проверить: docker compose ps · логи: make logs-run$(OFF)\n'; \
	  tail -20 $(LOG); exit 1; \
	else \
	  printf '$(RED)сервер не поднялся. Последнее из $(LOG):$(OFF)\n'; \
	  tail -20 $(LOG); exit 1; \
	fi

stop: ## Остановить сервер на хосте (ядро в docker остаётся)
	@if [ -f $(PID) ] && kill -0 "$$(cat $(PID))" 2>/dev/null; then \
	  kill "$$(cat $(PID))" && printf '$(DIM)сервер остановлен$(OFF)\n'; \
	fi
	@rm -f $(PID)
	@# Про чужие расписки мы не знаем: сервер мог поднять не make run, и тогда
	@# его PID нигде не записан. Сказать о нём вслух — единственный способ не
	@# оставить человека с двумя Colloq, о втором из которых он не догадывается.
	@others="$$(pgrep -f 'node server/dist/server.js' 2>/dev/null || true)"; \
	if [ -n "$$others" ]; then \
	  printf '$(RED)на хосте остались процессы сервера:$(OFF) %s\n' "$$(echo $$others | tr '\n' ' ')"; \
	  printf '$(DIM)их подняли не через make run — снять: pkill -f "node server/dist/server.js"$(OFF)\n'; \
	fi

logs-run: ## Смотреть логи сервера, запущенного через make run
	@tail -f $(LOG)

backup-legacy: ## Копия локального инстанса разработки (база и меняющиеся файлы)
	@# Рецепт жил тридцатью строками прямо здесь, а теперь лежит в
	@# scripts/backup-local.sh — ровно как у restore-legacy ниже и по той же
	@# причине: в колесо pip едут scripts/, а Makefile не едет, и у
	@# поставленного colloq эта копия была недостижима вовсе («make: command
	@# not found»). Второго описания одного и того же быть не должно, поэтому
	@# здесь осталась одна строка.
	@#
	@# Каталог, с которого снимается копия, скрипт берёт из COLLOQ_HOME
	@# (scripts/lib.sh · COLLOQ_STATE_ROOT). Здесь его никто не называет — и
	@# правильно: в репозитории корень состояния и есть корень репозитория.
	@./scripts/backup-local.sh

restore: ## Восстановить k3s: ARCHIVE=копия.tar.gz RELEASE=release.json REPLACE=1
	@test -n "$(ARCHIVE)" || { printf 'ARCHIVE is required; legacy copies use make restore-legacy\n' >&2; exit 1; }
	@test -n "$(RELEASE)" || { printf 'RELEASE is required for portable recovery\n' >&2; exit 1; }
	@args=(--archive "$(ARCHIVE)" --release "$(RELEASE)"); \
	  if [ "$(REPLACE)" = 1 ]; then args+=(--replace); fi; \
	  if [ "$(RECOVER)" = 1 ]; then args+=(--recover); fi; \
	  NAME="$(NAME)" ./scripts/restore.sh "$${args[@]}"

restore-legacy: ## Восстановить локальную копию старого формата: DB=… FILES=…
	@# Пара к backup. Отдельным скриптом, а не тремя строками здесь: под
	@# работающим сервером базу подменять нельзя, а рядом с ней лежит журнал WAL,
	@# который надо убрать вместе со старой базой, — обе проверки объяснены там.
	@#
	@# NAME выбирает каталог: backups/<среда>/ вместо backups/. Без него — корень,
	@# то есть копии здешнего инстанса; чужую среду оттуда не достать даже
	@# случайно, и это единственное, чего мы тут добиваемся.
	@NAME="$(NAME)" ./scripts/restore.sh $(DB) $(FILES)

down: ## Остановить всё (данные и файлы семинаров остаются)
	@# Сначала контейнеры семинаров: у каждой комнаты ДВА — её собственный и
	@# тот, где считаются личные тетради её студентов, — и compose про них не
	@# знает: их поднимает сервер по ходу занятия. Без этой строки «остановить
	@# всё» оставляло бы работать по паре контейнеров на каждую комнату,
	@# открытую сегодня. И именно в этом порядке: под `make up` они стоят в сети compose,
	@# а сеть с чужими контейнерами внутри не удаляется — `docker compose down`
	@# сказал бы «Resource is still in use» и оставил её висеть.
	@ids="$$(docker ps -aq --filter 'label=colloq.kind=room-kernel' 2>/dev/null)"; \
	if [ -n "$$ids" ]; then \
	  docker rm -f $$ids >/dev/null && \
	  printf '$(DIM)убрано контейнеров семинаров: %s$(OFF)\n' "$$(echo $$ids | wc -w | tr -d ' ')"; \
	fi
	docker compose down
	@# «Всё» — это всё, что в docker. Сервер под службой стоит на хосте, и
	@# `docker compose down` его не касается: он останется работать над пустым
	@# местом, поднимая комнатам ядра заново. Сказать об этом дешевле, чем
	@# останавливать службу за спиной у того, кто просил убрать контейнеры.
	@if systemctl is-active --quiet colloq 2>/dev/null; then \
	  printf '$(DIM)сервер при этом работает службой — остановить его: make service-stop$(OFF)\n'; \
	fi

restart: ## Перезапустить сервер в docker, не пересобирая (ядро не трогаем)
	@# Только app, и это важнее, чем кажется.
	@#
	@# Голый `docker compose restart` перезапускал и службу kernel, а это то
	@# ядро, на котором сидят комнаты, когда своего контейнера им не досталось:
	@# Jupyter поднимался пустым, сокеты переподключались как ни в чём не
	@# бывало, в тетради стояли
	@# прежние Out[n], и о пропаже model и df класс узнавал первым NameError
	@# минут через десять. README обещает, что перезапуск сервер переживает, —
	@# обещание про сервер, а не про ядро.
	@if docker compose ps --status running --services 2>/dev/null | grep -qx app; then \
	  docker compose restart app; \
	elif [ -f /etc/systemd/system/colloq.service ]; then \
	  printf '$(DIM)в docker app не запущен, зато стоит служба — перезапускать надо её:$(OFF)\n'; \
	  printf '$(DIM)make service-restart$(OFF)\n'; \
	else \
	  printf '$(DIM)в docker app не запущен — перезапускать нечего.$(OFF)\n'; \
	  printf '$(DIM)сервер на хосте (make run) перезапускается так: make stop · make run$(OFF)\n'; \
	fi

logs: ## Смотреть логи (Ctrl+C — выйти)
	docker compose logs -f --tail=80

status: ## Что запущено и в каком состоянии
	@docker compose ps
	@# На выделенной машине сервер стоит службой, и в выводе compose его нет
	@# вовсе: там только ядра. Без этой строки `make status` показывал бы пустой
	@# список над работающим инстансом.
	@if [ -f /etc/systemd/system/colloq.service ]; then \
	  printf '\n$(DIM)сервер: служба systemd — $(OFF)%s\n' "$$(systemctl is-active colloq 2>/dev/null || echo неизвестно)"; \
	  printf '$(DIM)подробности: make service-status$(OFF)\n'; \
	fi
	@# Контейнеры семинаров стоят отдельно от compose: по паре на комнату (её
	@# собственный и «own» — для личных тетрадей студентов), поднимаются по ходу
	@# занятия и убираются, когда комната два часа пуста.
	@rooms="$$(docker ps --filter 'label=colloq.kind=room-kernel' --format '{{.Label "colloq.session"}} {{.Label "colloq.role"}} {{.Status}}' 2>/dev/null)"; \
	if [ -n "$$rooms" ]; then \
	  printf '\n$(DIM)ядра семинаров:$(OFF)\n'; echo "$$rooms" | sed 's/^/  /'; \
	fi
	@printf '\n$(DIM)окружение ядра:$(OFF) $(BOLD)$(CURRENT_ENV)$(OFF)\n'
	@# Нет строки — сервер берёт localhost:PORT (как и make run выше), это и печатаем.
	@url="$$(grep -E '^PUBLIC_URL=' .env 2>/dev/null | tail -1 | cut -d= -f2-)"; \
	printf '$(DIM)PUBLIC_URL:$(OFF) %s\n' "$${url:-http://localhost:$(PORT)}"

ps: status

shell: ## Оболочка внутри ядра — посмотреть, что там на самом деле стоит
	@# Общее ядро compose есть не всегда. На выделенной машине (сервер службой)
	@# его не поднимает никто: у каждой комнаты своё, а образ окружения лежит
	@# рядом собранным. Тогда открываем одноразовый контейнер из того же образа —
	@# это ответ на вопрос «что стоит в окружении», а не «что доставили руками в
	@# работающую комнату»; второе смотрят в самой комнате, терминалом.
	@if docker compose ps --status running --services 2>/dev/null | grep -qx kernel; then \
	  docker compose exec kernel bash; \
	else \
	  printf '$(DIM)общего ядра нет — открываю одноразовый контейнер colloq-kernel:$(CURRENT_ENV)$(OFF)\n'; \
	  docker run --rm -it colloq-kernel:$(CURRENT_ENV) bash; \
	fi

## ------------------------------------------------------- выделенная машина

## Третий способ запуска, и он не заменяет два предыдущих.
##
##   make up   весь стек в docker — ноутбук, показать, попробовать
##   make run  сервер руками, ядро в docker — разработка
##   служба    сервер на хосте под systemd, в docker только ядра комнат —
##             машина, на которой идут занятия (своя или арендованная)
##
## На выделенной машине сервер вынесен из контейнера не ради скорости. В
## контейнере он не видит того, что вокруг: каталоги данных заводились от root,
## а он внутри работает от uid 1000, — и панель не могла собрать окружение,
## потому что рядом с ней нет ни docker-compose.yml, ни kernel/Dockerfile, ни
## .env. На хосте всё это лежит рядом. Цена названа вслух: служба работает от
## root (ей всё равно нужен docker.sock, а это root-эквивалент), и на машине
## появляется Node. Подробности — в шапке deploy/colloq.service и в README.

service-install: ## Совместимость: установка k3s, RELEASE=/путь/release.json
	@# Он же обновляет: git pull && make service-install — сборка и рестарт внутри.
	@./scripts/service.sh install --release "$(RELEASE)"

service-restart: ## Перезапустить службу и дождаться готовности
	@./scripts/service.sh restart

service-stop: ## Остановить службу (ядра комнат остаются жить)
	@./scripts/service.sh stop

service-status: ## Жива ли служба и готова ли вести семинар
	@./scripts/service.sh status

service-logs: ## Журнал службы (Ctrl+C — выйти)
	@./scripts/service.sh logs

## ----------------------------------------------------------------- учёт

activity: .env ## Активность семинара — в Google-таблицу. ROOM=id (или ALL=1); REPLACE=1 — пересчитать
	@# Строка на человека на семинар, лист «Сводка» считает итог сам. Куда —
	@# ACTIVITY_SHEET_ID в .env; завести таблицу: scripts/activity-sheet.py --create «название».
	@python3 scripts/activity-sheet.py $(ROOM) $(if $(ALL),--all) $(if $(REPLACE),--replace)

## ----------------------------------------------------------------- наружу

host: .env ## Выставить семинар наружу и получить ссылку. HOST=... — свой адрес
	@# Туннель: исходящее соединение отсюда наружу. Работает откуда угодно —
	@# с ноутбука в аудитории, из-за NAT, с арендованной машины, — и держится,
	@# пока открыто окно. Куда именно идёт туннель, решает имя: под RELAY_DOMAIN
	@# — на свой ретранслятор, любое другое — в Cloudflare.
	@COLLOQ_HOSTNAME="$(HOST)" ./scripts/host.sh

host-direct: .env ## То же, но прямо с этой машины: caddy тут, без ретранслятора. HOST=имя
	@# Для машины со своим белым адресом и настоящими 80 и 443. Посредника нет
	@# вовсе: студенты приходят прямо сюда, имя направляется на этот адрес
	@# A-записью, сертификат берётся сам.
	@#
	@# Ради чего: ретранслятор — общая точка отказа для всех имён под ним, и
	@# на гигабайте памяти он двухсот сокетов не держит (измерено на паре: 36
	@# убийств по нехватке памяти за вечер, каждое рвёт все туннели разом).
	@#
	@# Скрипт сам откажется, если 80 и 443 снаружи закрыты, — на арендованной
	@# машине vast.ai так и будет, там прямой режим невозможен.
	@#
	@# sudo: занимаются привилегированные порты и ставится служба caddy.
	@test -n "$(HOST)" || { printf '$(RED)Укажите адрес: make host-direct HOST=hse.colloq.ru$(OFF)\n'; exit 1; }
	@COLLOQ_DIRECT=1 COLLOQ_HOSTNAME="$(HOST)" ./scripts/host.sh

ui: ## Проверить интерфейс настоящим браузером. HEADED=1 — с видимым окном
	@# Появилось после кнопки, которая ничего не делала: типы сходились, тесты
	@# были зелёными, а нажать её было нечем.
	@npm run build >/dev/null && npx tsx scripts/ui-check.mts $(if $(HEADED),--headed,)

sync: ## Проверить, что проектор идёт за пультом, когда листают быстро
	@# Появилось после жалобы с пары: «пролистать вперёд — синк догоняет секунд
	@# пять или не догоняет вообще». Меряет очередь нажатий, а не одно: именно
	@# ожидание ответа после каждого и прятало всю болезнь.
	@npm run build >/dev/null && npx tsx scripts/lecture-sync-check.mts $(if $(HEADED),--headed,)

load: ## Нагрузочный стенд: 500 студентов в одну комнату. N=500 RAMP=60 SPID=<pid>
	@# Появился после вопроса, на который нечем было ответить: «выдержит ли
	@# инстанс поток». perf.mts открывает двоих; здесь — свой семинар, N входов
	@# темпом RAMP, оба сокета на каждого, шторм набора и уборка за собой.
	@#
	@# По ЧУЖОЙ комнате не гонять и нечем: стенд заводит свою и удаляет её.
	@# SPID — pid серверного процесса, ради CPU и RSS; его не угадывают:
	@# служба — systemctl show -p MainPID colloq, make run — cat $(PID).
	@# ulimit: пятьсот студентов это тысяча сокетов, и на macOS по умолчанию их
	@# меньше, чем нужно, — стенд упирался бы в свою же машину.
	@#
	@# Три добровольных раздела — три РАЗНЫЕ формы рассылки, которых в шторме
	@# нет вовсе, и по умолчанию их нет: они единственные, кто оставляет в
	@# комнате не только сокеты.
	@#   TREE=<файлов в секунду>  — всем на каждое изменение дерева
	@#   COUNCIL=<сколько пишут>  — одному пульту от каждого из N (EVERY=<сек>)
	@#   INK=<кадров в секунду>   — от одного ведущего всем N зрителям
	@#
	@# Чужое присутствие серверу стенд НЕ повторяет — как и настоящая вкладка
	@# с тех пор, как появился ownChanges (web/src/lib/presence.ts). Пока
	@# повторял, холостой процессор сервера выходил в 2.7 раза больше, чем
	@# бывает на паре. Померить прежнее поведение: LOAD_ECHO=1 make load.
	@ulimit -n 8192 2>/dev/null || true; \
	 LOAD_STUDENTS="$${N:-500}" LOAD_RAMP_SEC="$${RAMP:-60}" LOAD_IDLE_SEC="$${IDLE:-15}" \
	 LOAD_TYPISTS="$${K:-20}" LOAD_KEYS="$${M:-5}" LOAD_STORM_SEC="$${STORM:-20}" \
	 $(if $(TREE),LOAD_TREE="$(TREE)" LOAD_TREE_SEC="$${TREE_SEC:-10}",) \
	 $(if $(COUNCIL),LOAD_COUNCIL="$(COUNCIL)" LOAD_COUNCIL_EVERY="$${EVERY:-2}" LOAD_COUNCIL_SEC="$${COUNCIL_SEC:-10}",) \
	 $(if $(INK),LOAD_INK="$(INK)" LOAD_INK_SEC="$${INK_SEC:-10}",) \
	 $(if $(SPID),LOAD_SERVER_PID="$(SPID)",) $(if $(STAFF),LOAD_STAFF_JOIN=1,) \
	 npx tsx scripts/load.mts

site: ## Выложить сайт colloq.ru — лендинг и опубликованные семинары. DRY=1 — только собрать
	@# Сайт лежит в site/ этого же репозитория; выкладывает его workflow Pages
	@# по push в main. Отдельный репозиторий был заведён с оговоркой «Pages не
	@# умеет приватные» — неправда, и второй клон рядом больше не нужен.
	@npx tsx scripts/publish-site.mts $(if $(SITE),--site "$(SITE)",) $(if $(BASE),--base "$(BASE)",) $(if $(DRY),--dry,)

mirror: ## Обновить зеркало colloq.cc (тот же сайт для тех, кому Cloudflare открыт). DRY=1 — только рассказать
	@# Второе имя, а не второй сайт: содержимое то же самое, из site/, и
	@# источник у него один — colloq.ru на GitHub Pages. Pages отдаёт сайт по
	@# ОДНОМУ своему имени (site/CNAME), поэтому вторым CNAME так не сделать:
	@# на границе Cloudflare стоит воркер и подменяет Host. Сам colloq.ru при
	@# этом остаётся серым и смотрит прямо на Pages — адреса Cloudflare из
	@# России не открываются, и трогать его нельзя. Подробности рядом со
	@# скриптом: deploy/cloudflare/colloq-cc/README.md.
	@./deploy/cloudflare/colloq-cc/deploy.sh $(if $(DRY),--dry-run,)

site-icons: ## Перерисовать значки сайта из site/favicon.svg (favicon.ico, PNG 48/96/192, apple-touch, icon-512)
	@node --import tsx scripts/site-icons.mts

site-og: ## Перерисовать карточки ссылок лендинга (og.png, og-en.png, og-cc.png)
	@# Три картинки 1200×630 под превью в мессенджерах: русская, английская и
	@# та же английская с подписью colloq.cc для зеркала. Перерисовав, поправьте
	@# метки ?v= у og:image в site/index.html и site/en/index.html — их сверяет
	@# tests/site.test.mts, иначе чат покажет старую картинку из своего кэша.
	@node --import tsx scripts/site-og.mts

readme-art: ## Перерисовать анимации сцен (.github/assets/readme и site/img/scenes)
	@# Двадцать файлов: пять сцен × два языка × две темы. Каталога два, потому
	@# что лендинг раздаётся Pages из site/ и до .github/ не дотягивается.
	@node --import tsx scripts/readme-art.mts

course: ## Курс из расписания в таблице. SHEET=<id> GID=<gid> COL="ML · сильная"
	@test -n "$(SHEET)" || { printf '$(RED)Укажите таблицу: make course SHEET=<id> COL="ML · сильная"$(OFF)\n'; exit 1; }
	@npx tsx scripts/course-from-sheet.mts \
	  --sheet "$(SHEET)" --gid "$${GID:-0}" --column "$(COL)" \
	  $(if $(NAME),--name "$(NAME)",) $(if $(BLURB),--blurb "$(BLURB)",) $(if $(DRY),--dry,)

relay-setup: ## Поставить ретранслятор для *.colloq.ru. WHERE=root@адрес
	@test -n "$(WHERE)" || { printf '$(RED)Укажите машину: make relay-setup WHERE=root@203.0.113.10$(OFF)\n'; exit 1; }
	@./scripts/relay-setup.sh "$(WHERE)"

relay-page: ## Обновить страницу «комната ещё не открыта». WHERE=root@адрес
	@# Её видит студент, пришедший раньше преподавателя. Страница — файл
	@# scripts/relay-offline.html (вместе с игрой про капибару), а полная
	@# установка ради одного абзаца — это
	@# пакеты, бинарники и перезапуск обеих служб на боевой машине, где висят
	@# живые адреса. Здесь только файл: ни одна служба не перезапускается.
	@test -n "$(WHERE)" || { printf '$(RED)Укажите машину: make relay-page WHERE=root@203.0.113.10$(OFF)\n'; exit 1; }
	@./scripts/relay-setup.sh --page "$(WHERE)"

tunnel-setup: ## Один раз завести постоянный адрес. HOST=seminar.example.ru
	@test -n "$(HOST)" || { printf '$(RED)Укажите адрес: make tunnel-setup HOST=seminar.example.ru$(OFF)\n'; exit 1; }
	@./scripts/tunnel-setup.sh "$(HOST)"

## ---------------------------------------------------- машина напрокат

## Своей машины с GPU может не быть вовсе. Тогда её берут почасово на vast.ai —
## и только виртуалкой: в обычном docker-инстансе vast запрещает docker внутри,
## а без него у комнаты нет своего ядра. Данные на арендованной машине живут до
## её уничтожения, поэтому vast-sync здесь не удобство, а половина работы.
## Подробности и цена решения — в шапке scripts/vast.sh и в README.
##
##   make vast-up GPU="RTX 5070" HOST=demo.colloq.ru
##
## — арендовать, развернуть, развернуть копию этой среды из backups/ и открыть
## адрес наружу. Без HOST и GPU всё как раньше: карта из VAST_* в .env, адрес
## не поднимается.
##
## Сред бывает несколько, и это несколько машин: hse.colloq.ru и demo.colloq.ru
## — две аренды, два счёта, две базы, общего только код и ретранслятор. Среда
## зовётся одним словом, и оно же — первая часть адреса, метка на vast и
## подкаталог копий:
##
##   make vast-up NAME=demo HOST=demo.colloq.ru   ·   make vast-sync NAME=demo
##
## Что было на паре — одной командой, без прогулки по ssh:
##
##   make vast-logs NAME=demo            ·   make vast-logs NAME=demo SINCE=-2h
##
## Имя можно не называть, когда назван HOST (оно там уже есть) или когда среда
## одна. Как только их две, sync и down без имени отказывают со списком.

VAST_SCRIPT := $(if $(RELEASE),vast.sh,vast-legacy.sh)

vast-up: ## Арендовать машину с GPU и развернуть Colloq. NAME=среда HOST=имя GPU="RTX 5070"
	@# NAME, HOST и GPU уходят окружением, а не аргументами, — как
	@# COLLOQ_HOSTNAME в `make host`. Пустые они и означают «не просили»: скрипт
	@# тогда ведёт себя ровно как до их появления.
	@# Два пути. Без RELEASE — прежний (scripts/vast-legacy.sh): рабочее дерево,
	@# копия из backups/<среда>/, служба systemd и докер-ядра; с RELEASE=… —
	@# k3s-релиз (scripts/vast.sh). Прежний вернули 13.09.2026: релиза под рукой
	@# не оказалось за два часа до лекции, а машина из копии нужна была сразу.
	@NAME="$(NAME)" HOST="$(HOST)" GPU="$(GPU)" ./scripts/$(VAST_SCRIPT) up

vast-status: ## Что арендовано: без NAME — все среды, с NAME — подробности одной
	@NAME="$(NAME)" ./scripts/$(VAST_SCRIPT) status

vast-sync: ## Снять данные с арендованной машины в backups/<среда>/. NAME=среда
	@NAME="$(NAME)" ./scripts/$(VAST_SCRIPT) sync

vast-logs: ## Забрать журналы с арендованной машины в logs/<среда>/<дата>/. NAME=среда SINCE=today
	@# Раньше это была прогулка по ssh руками, и потому не делалась: чтобы
	@# понять, что было на паре, надо забрать И журнал службы, И журналы ядер
	@# каждой комнаты — включая остановленные, где как раз и лежит причина
	@# остановки. SINCE передаётся окружением, как NAME и HOST: пустое означает
	@# «сегодня». Секреты режутся на лету, до записи на диск, — см. scrub в
	@# scripts/vast.sh и абзац в README.
	@NAME="$(NAME)" SINCE="$(SINCE)" ./scripts/$(VAST_SCRIPT) logs

vast-down: ## Уничтожить арендованную машину — вместе со всем, что на ней. NAME=среда
	@NAME="$(NAME)" ./scripts/$(VAST_SCRIPT) down

vast-adopt: ## Назвать средой машину со старой меткой «colloq». NAME=demo
	@# Метка меняется у живого инстанса, без пересоздания: семинар на нём не
	@# прерывается, диск и туннель остаются как есть. Нужно это ровно один раз —
	@# машине, арендованной до того, как сред стало несколько.
	@test -n "$(NAME)" || { printf '$(RED)Назовите среду: make vast-adopt NAME=demo$(OFF)\n'; exit 1; }
	@NAME="$(NAME)" ./scripts/vast.sh adopt

## ------------------------------------------------------ образ для vast
##
## Готовый образ вместо сборки на арендованной машине: сервер, клиент,
## туннели и контекст ядер в одном colloq-vast. На Vast VM его запускает
## on-start шаблона (deploy/vast/onstart.sh), ядра комнат — соседние
## контейнеры на docker этой VM. Почему VM, а не обычный Docker-инстанс, —
## deploy/vast/README.md, «Design».

# TAG, а не VAST_IMAGE: VAST_IMAGE в .env — уже образ ВИРТУАЛКИ для аренды
# (scripts/vast-legacy.sh, scripts/vast.sh), и одно имя с двумя смыслами
# однажды пометило бы сборку как docker.io/vastai/kvm:… . `=`, а не `?=`:
# переменная окружения с тем же именем сюда не протекает, только make TAG=….
TAG = colloq-vast:dev

.PHONY: vast-image vast-image-run vast-image-stop

vast-image: ## Собрать образ colloq-vast. TAG=имя:тег PLATFORM=linux/amd64
	@# Версия — из корневого package.json (единственный её источник, см.
	@# scripts/version.mts), ревизия — из git: обе едут в метки OCI и в
	@# `colloq-vast version`. Публикация — отдельный шаг владельца: docker push.
	@# Ревизия с -dirty, если дерево расходится с HEAD: иначе метка образа,
	@# собранного из незакоммиченного, называла бы исходником чужой коммит.
	docker build -f deploy/vast/Dockerfile \
	  $(if $(PLATFORM),--platform $(PLATFORM),) \
	  --build-arg COLLOQ_VERSION="$$(node -p "require('./package.json').version")" \
	  --build-arg GIT_SHA="$$(git rev-parse --short HEAD)$$(git diff --quiet HEAD -- 2>/dev/null || echo -dirty)" \
	  -t "$(TAG)" .

vast-image-run: ## Проверить образ у себя: dind вместо VM, комната, ячейка, копия. SEED_KERNEL=1 — не собирать ядро
	@# Внутри docker:dind, а не на docker этой машины: уборка простоя сносит
	@# контейнеры комнат ВСЕХ инстансов на демоне, и стенд рядом с make dev
	@# через полчаса убил бы ядра чужой пары. Стенд остаётся жить — адрес
	@# напечатан; убрать его: make vast-image-stop.
	@IMAGE="$(TAG)" SEED_KERNEL="$(SEED_KERNEL)" ./deploy/vast/smoke.sh up
	@IMAGE="$(TAG)" ./deploy/vast/smoke.sh e2e

vast-image-stop: ## Убрать стенд make vast-image-run вместе со всем, что в нём было
	@./deploy/vast/smoke.sh down

## ------------------------------------------------------------- окружения

env-list: ## Какие окружения заведены
	@printf '$(BOLD)Окружения$(OFF) $(DIM)($(ENV_DIR)/)$(OFF)\n\n'
	@$(PY_OF); for f in $(ENV_DIR)/*.txt; do \
	  name=$$(basename "$$f" .txt); \
	  n=$$(grep -vE '^\s*(#|-|$$)' "$$f" | grep -c . || true); \
	  mark=' '; [ "$$name" = "$(CURRENT_ENV)" ] && mark='*'; \
	  printf '  %s %-14s $(DIM)Python %s · %s пакетов сверх базы$(OFF)\n' "$$mark" "$$name" "$$(py_of "$$name")" "$$n"; \
	done
	@printf '\n$(DIM)* — умолчание для новых семинаров. Сменить: make env-use NAME=<имя>$(OFF)\n'

env-show: ## Что за окружение стоит сейчас и что в нём
	@$(PY_OF); printf '$(BOLD)$(CURRENT_ENV)$(OFF) $(DIM)— $(ENV_DIR)/$(CURRENT_ENV).txt · Python %s$(OFF)\n\n' "$$(py_of $(CURRENT_ENV))"
	@out=$$(grep -vE '^\s*(#|$$)' $(ENV_DIR)/$(CURRENT_ENV).txt 2>/dev/null || true); \
	  if [ -n "$$out" ]; then printf '%s\n' "$$out" | sed 's/^/  /'; \
	  else printf '  $(DIM)ничего сверх базы$(OFF)\n'; fi
	@printf '\n$(DIM)База (есть всегда):$(OFF)\n'
	@grep -vE '^\s*(#|$$)' kernel/requirements.txt | sed 's/^/  /'

env-new: ## Завести окружение. NAME=cv [PYTHON=3.12]
	@test -n "$(NAME)" || { printf '$(RED)Укажите имя: make env-new NAME=cv$(OFF)\n'; exit 1; }
	@test ! -f $(ENV_DIR)/$(NAME).txt || { printf '$(RED)$(ENV_DIR)/$(NAME).txt уже есть.$(OFF)\n'; exit 1; }
	@test -z "$(PYTHON)" || printf '%s\n' $(PY_LIST) | grep -qx '$(PYTHON)' || { \
	  printf '$(RED)Python $(PYTHON) не из тех, на которых собирается ядро: $(PY_LIST)$(OFF)\n'; exit 1; }
	@# Версия — директивой в шапке, и только если её просили НЕ по умолчанию:
	@# файл без строки и файл со строкой про умолчание значат одно и то же, а
	@# второй ещё и врёт, если умолчание в Dockerfile однажды поднимут.
	@: > $(ENV_DIR)/$(NAME).txt
	@test -z "$(PYTHON)" || test "$(PYTHON)" = "$(PY_DEFAULT)" || \
	  printf '# colloq: python $(PYTHON)\n#\n' >> $(ENV_DIR)/$(NAME).txt
	@printf '# Окружение «$(NAME)». Ставится поверх базы из kernel/requirements.txt,\n' >> $(ENV_DIR)/$(NAME).txt
	@printf '# поэтому numpy/pandas/matplotlib/plotly/scikit-learn перечислять не нужно.\n#\n' >> $(ENV_DIR)/$(NAME).txt
	@printf '# Один пакет на строку, как в обычном requirements.txt:\n#\n' >> $(ENV_DIR)/$(NAME).txt
	@printf '#   transformers>=4.44\n#   datasets>=2.20\n' >> $(ENV_DIR)/$(NAME).txt
	@printf '$(BOLD)создан$(OFF) $(ENV_DIR)/$(NAME).txt\n'
	@$(PY_OF); printf '$(DIM)Python %s · впишите пакеты, потом: make env-use NAME=$(NAME)$(OFF)\n' "$$(py_of $(NAME))"

env-build: ## Собрать образ окружения, не переключаясь. NAME=cv
	@test -n "$(NAME)" || { printf '$(RED)Укажите имя: make env-build NAME=cv$(OFF)\n'; exit 1; }
	@test -f $(ENV_DIR)/$(NAME).txt || { printf '$(RED)Нет $(ENV_DIR)/$(NAME).txt — сначала make env-new NAME=$(NAME)$(OFF)\n'; exit 1; }
	@# Цепочка наследования. `# colloq: from base-gpu` в шапке — это «строить
	@# поверх образа того окружения»: родитель идёт первым и только если его
	@# образа ещё нет. Ради этого всё и заведено — правка листа не должна
	@# ставить torch заново. Петля и слишком длинная цепочка — отказ здесь, а
	@# не девять минут сборки, которая всё равно упадёт.
	@set -e; \
	chain=; name=$(NAME); \
	while [ -n "$$name" ]; do \
	  case " $$chain " in *" $$name "*) \
	    printf '$(RED)Окружения ссылаются друг на друга по кругу: %s$(OFF)\n' "$$name"; exit 1;; \
	  esac; \
	  test -f $(ENV_DIR)/$$name.txt || { \
	    printf '$(RED)Нет %s.txt: окружение «%s» названо родителем, а его нет$(OFF)\n' \
	      "$(ENV_DIR)/$$name" "$$name"; exit 1; }; \
	  chain="$$name $$chain"; \
	  [ $$(printf '%s' "$$chain" | wc -w) -le 8 ] || { \
	    printf '$(RED)Цепочка окружений длиннее восьми звеньев$(OFF)\n'; exit 1; }; \
	  name=$$(sed -nE 's/^[[:space:]]*#[[:space:]]*colloq:[[:space:]]*from[[:space:]]+([^[:space:]]+)[[:space:]]*$$/\1/p' $(ENV_DIR)/$$name.txt | head -1); \
	  case "$$name" in '') ;; *[!a-z0-9-]*|-*|*-) \
	    printf '$(RED)«%s» не может быть именем окружения — ни файлом, ни тегом образа$(OFF)\n' "$$name"; \
	    exit 1;; esac; \
	done; \
	parent=; \
	for step in $$chain; do \
	  if [ "$$step" = "$(NAME)" ] || ! docker image inspect colloq-kernel:$$step >/dev/null 2>&1; then \
	    printf '$(BOLD)собираю %s$(OFF)$(DIM)%s$(OFF)\n' "$$step" "$${parent:+ поверх $$parent}"; \
	    KERNEL_ENV=$$step KERNEL_PARENT=$$parent docker compose build kernel; \
	  fi; \
	  parent=colloq-kernel:$$step; \
	done

env-use: .env ## Окружение по умолчанию для новых семинаров. NAME=cv
	@# Пререквизит .env — не формальность. Без него на свежем клоне строка ниже
	@# заводила .env из одной строки KERNEL_ENV=…, и дальше ни make up, ни
	@# make dev своего файла не писали (он же есть): занятие шло с умолчаниями,
	@# с общеизвестным токеном ядра. Та же ошибка у `colloq env use` —
	@# cli/src/commands/env.ts, там основой берётся тот же localClassEnv.
	@test -n "$(NAME)" || { printf '$(RED)Укажите имя: make env-use NAME=cv$(OFF)\n'; exit 1; }
	@test -f $(ENV_DIR)/$(NAME).txt || { printf '$(RED)Нет $(ENV_DIR)/$(NAME).txt — сначала make env-new NAME=$(NAME)$(OFF)\n'; exit 1; }
	@printf '$(DIM)первый раз может быть долго$(OFF)\n'
	@# Через env-build, а не своим `docker compose build`: сборка цепочки
	@# наследования живёт там, и два её списывания разъехались бы на первой же
	@# правке.
	@$(MAKE) --no-print-directory env-build NAME=$(NAME)
	@# Записывается в .env, потому что compose читает KERNEL_ENV оттуда: иначе
	@# следующий `make up` без переменной молча вернул бы старое окружение.
	@#
	@# Содержимое переливается в существующий .env, а не `mv` поверх него — та
	@# же причина, что в scripts/host.sh: на Linux, где docker просит sudo,
	@# `sudo make env-use` переносил файл из /tmp вместе с владельцем root и
	@# правами 0600, и следующий `make run` от человека не мог его прочитать —
	@# инстанс поднимался с умолчаниями, то есть с чужим токеном ядра и
	@# localhost в ссылках для аудитории.
	@tmp=$$(mktemp); grep -vE '^KERNEL_ENV=' .env > "$$tmp" 2>/dev/null || true; \
	  printf 'KERNEL_ENV=$(NAME)\n' >> "$$tmp"; cat "$$tmp" > .env; rm -f "$$tmp"
	@printf '$(BOLD)Окружение по умолчанию для новых семинаров: $(NAME)$(OFF)\n'

env-freeze: ## Показать реальные версии из ядра
	@# То же, что и у `make shell`: общего ядра compose на выделенной машине не
	@# существует, и прежняя строка отвечала там «no such service». Спрашиваем
	@# тогда сам образ окружения — из него и поднимаются ядра комнат.
	@if docker compose ps --status running --services 2>/dev/null | grep -qx kernel; then \
	  docker compose exec -T kernel pip freeze; \
	else \
	  docker run --rm colloq-kernel:$(CURRENT_ENV) pip freeze; \
	fi

## ------------------------------------------------------------------ прочее

test: ## Прогнать тесты
	npm test

check: ## Тесты и проверка типов
	npm test && npm run typecheck

## ------------------------------------------------------------------ пакет

# Пакет для преподавателя: `pip install colloq`, дальше `colloq` — и занятие
# идёт на его машине. Ни репозитория, ни make, ни tsx там нет, поэтому всё,
# что сегодня считается от исходников (сборка фронтенда, отпечаток дерева,
# npm run build), считается ЗДЕСЬ и один раз. Признак «приехало собранным» —
# файл .colloq-dist.json в корне приложения.

pack: ## Собрать дистрибутив для pip в python/colloq/_app. SKIP_BUILD=1 — взять уже собранное
	@# SKIP_BUILD пригодится ровно в двух случаях: когда упаковку правят и
	@# гоняют подряд, и когда на этой машине идёт занятие — `npm run
	@# build:optimized` вычищает web/dist, из которого живой сервер прямо
	@# сейчас отдаёт страницы.
	@npx tsx scripts/pack.mts $(if $(SKIP_BUILD),--skip-build,)

wheel: pack ## Собрать колесо pip в python/dist (публикуем отдельно, не здесь)
	@# pip wheel, а не python -m build: build — отдельный пакет, которого на
	@# машине может не быть, а pip есть везде, где вообще есть pip install.
	@# --no-deps: зависимостей у пакета нет ни одной, и без флага pip лез бы в
	@# сеть только чтобы это подтвердить.
	@rm -rf python/dist
	@python3 -m pip wheel ./python --no-deps --quiet --wheel-dir python/dist
	@printf '$(BOLD)Колесо:$(OFF) %s\n' "$$(ls python/dist/*.whl)"
	@printf '$(DIM)Проверить: python3 -m venv /tmp/colloq-venv && /tmp/colloq-venv/bin/pip install python/dist/*.whl$(OFF)\n'

## ------------------------------------------------------------------ версия

# Версия одна — "version" в корневом package.json. Остальное её копии
# (воркспейсы, замок, python/colloq/_version.py, манифест release-please) и
# производные (веб, сервер, колесо, теги образов); scripts/version.mts
# сверяет их, CI тоже.
#
# Версию здесь не поднимают. Число, CHANGELOG, тег и выпуск делает
# release-please: он держит PR «chore(main): release X.Y.Z», и слияние этого PR
# и есть выпуск. Прежнего `make bump` нет: следующее число решают Conventional
# Commits в main, а не часть, выбранная руками. Цель оставлена, чтобы старая
# привычка получила ответ, а не «No rule to make target». RELEASING.md.

version: ## Версия проекта и сверка всех её копий (то же проверяет CI)
	@node --import tsx scripts/version.mts current
	@node --import tsx scripts/version.mts check

bump:
	@printf '$(RED)Версию поднимает release-please: слейте его PR «chore(main): release X.Y.Z».$(OFF)\n'
	@printf '$(DIM)Следующее число — из Conventional Commits в main; своё — футер Release-As: X.Y.Z. RELEASING.md$(OFF)\n'
	@exit 1

.env:
	@test -f .env || { \
	  printf '$(BOLD)нет .env — пишу .env этой машины (ядра в docker, свой токен ядра)$(OFF)\n'; \
	  : ; \
	  : 'Не копия .env.example. Тот — шаблон прода, KERNEL_BACKEND=broker, и'; \
	  : 'после make up (run, host) супервизор make dev отказывал на нём как на'; \
	  : 'установке с брокером. Пишем тот же файл, что colloq при первом запуске,'; \
	  : 'со своим JUPYTER_TOKEN; почему шеллом, а не node, — scripts/local-env.sh.'; \
	  : 'umask 077: внутри будут ключи входа; упал писатель — пустой .env не'; \
	  : 'оставляем, иначе make счёл бы цель сделанной.'; \
	  ( umask 077; bash scripts/local-env.sh > .env ) || { rm -f .env; exit 1; }; \
	  printf '$(DIM)загляните в него перед семинаром: там ключ ассистента; все настройки — в .env.example$(OFF)\n'; \
	}

help: ## Показать этот список
	@printf '$(BOLD)Colloq$(OFF) $(DIM)— совместные семинары на своём железе$(OFF)\n\n'
	@grep -hE '^[a-z][a-z-]*:.*?## .*$$' $(MAKEFILE_LIST) \
	  | awk 'BEGIN {FS = ":.*?## "}; {printf "  $(CYAN)%-16s$(OFF) %s\n", $$1, $$2}'
	@printf '\n$(DIM)Production: make install RELEASE=/путь/release.json · make host$(OFF)\n'
	@printf '$(DIM)Разработка в Docker: make up$(OFF)\n'
	@printf '$(DIM)Управление k3s: make cluster-status · cluster-logs · cluster-stop$(OFF)\n'
	@printf '$(DIM)Окружение ядра сейчас: $(BOLD)$(CURRENT_ENV)$(OFF)\n'
	@printf '$(DIM)Разработка: make dev · занятие у преподавателя: pip install colloq, colloq start$(OFF)\n'

.PHONY: install update rollback cluster-start cluster-stop cluster-status cluster-logs backup backup-legacy restore-legacy release-validate
install: ## Установить версию на Linux VM. RELEASE=/путь/release.json
	@./scripts/cluster.sh install --release "$(RELEASE)"
update: ## Обновить до явной версии. RELEASE=/путь/release.json
	@./scripts/cluster.sh update --release "$(RELEASE)"
rollback: ## Вернуть совместимую версию. RELEASE=/путь/release.json
	@./scripts/cluster.sh rollback --release "$(RELEASE)"
cluster-start:
	@./scripts/cluster.sh start
cluster-stop:
	@./scripts/cluster.sh stop
cluster-status:
	@./scripts/cluster.sh status
cluster-logs:
	@./scripts/cluster.sh logs
backup: ## Переносимая копия k3s. MODE=consistent — остановить всех писателей
	@./scripts/backup.sh
release-validate:
	@python3 scripts/release.py validate --release "$(RELEASE)"
