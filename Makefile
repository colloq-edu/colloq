# Colloq — команды на каждый день.
#
# Две вещи, ради которых это существует:
#
#   make run               собрать и запустить
#   make host              поднять семинар и получить ссылку для аудитории
#   make env-use NAME=cv   переключить ядро на другое окружение Python
#
# Всё считается на этой машине. Ни VPS, ни белого IP, ни проброса портов.

SHELL := /bin/bash
.DEFAULT_GOAL := help

# Каталог со списками пакетов. Одно окружение — один файл.
ENV_DIR := kernel/environments
# Какое окружение сейчас запечено в образ ядра. Пишется в .env, читается compose.
CURRENT_ENV = $(shell grep -E '^KERNEL_ENV=' .env 2>/dev/null | tail -1 | cut -d= -f2- | tr -d ' ')
CURRENT_ENV := $(if $(CURRENT_ENV),$(CURRENT_ENV),base)

BOLD := \033[1m
DIM  := \033[2m
CYAN := \033[36m
RED  := \033[31m
OFF  := \033[0m

.PHONY: help up dev run stop logs-run down restart logs status ps shell \
        host relay-setup tunnel-setup \
        env-list env-show env-new env-use env-build env-freeze \
        backup test check

## ------------------------------------------------------------------ запуск

DEV := -f docker-compose.yml -f docker-compose.dev.yml

up: .env ## Поднять colloq целиком в docker на http://localhost:3000
	docker compose up -d --build
	@printf '$(BOLD)colloq на$(OFF) $(CYAN)http://localhost:$${PORT:-3000}$(OFF)\n'
	@printf '$(DIM)окружение ядра: $(CURRENT_ENV) · наружу — make host$(OFF)\n'

dev: .env ## Ядро в docker, сервер на хосте (npm run dev рядом)
	@# Только ядро и только с override: он публикует 8888 на хост и монтирует
	@# ./workspace, иначе сервер с хоста ядра не видит, а файлы расходятся.
	docker compose $(DEV) up kernel -d
	@printf '$(BOLD)ядро на$(OFF) $(CYAN)http://localhost:8888$(OFF) $(DIM)(окружение: $(CURRENT_ENV))$(OFF)\n'
	@printf '$(DIM)теперь: npm run dev$(OFF)\n'

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

run: .env ## Собрать и запустить. Это то, что нужно после любой правки кода
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
	@if lsof -ti :$${PORT:-3000} >/dev/null 2>&1; then \
	  printf '$(RED)порт $${PORT:-3000} уже занят:$(OFF)\n'; \
	  lsof -i :$${PORT:-3000} -sTCP:LISTEN | tail -n +2 | awk '{printf "  %s (pid %s)\n", $$1, $$2}'; \
	  printf '$(DIM)это второй Colloq — остановите его и повторите: make stop · make down$(OFF)\n'; \
	  exit 1; \
	fi
	docker compose $(DEV) up kernel -d
	@printf '$(DIM)ядро: окружение $(CURRENT_ENV), порт 8888 проброшен$(OFF)\n'
	npm run build
	@# nohup и подоболочка: make уходит сразу, а сервер должен пережить и его,
	@# и закрытие терминала. Всё, что он скажет, включая падение на старте,
	@# уходит в $(LOG) — иначе оно пропадает вместе с оболочкой.
	@# Дописывается, а не перезаписывается: `>` стирал прошлую неделю на каждом
	@# запуске, и «в четверг что-то сломалось» было нечем проверять.
	@( set -a; . ./.env; set +a; \
	   STATIC_DIR="$$PWD/web/dist" nohup node server/dist/server.js >> $(LOG) 2>&1 & \
	   echo $$! > $(PID) )
	@# Ждём, пока сервер скажет, что готов, а не две секунды наугад: две
	@# секунды — это либо долго, либо мало, и «мало» печатает ссылку над
	@# инстансом, который ещё поднимается. /api/health отвечает 200 только
	@# когда и база читается, и Jupyter отзывается.
	@ok=; for i in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15; do \
	  if ! kill -0 "$$(cat $(PID) 2>/dev/null)" 2>/dev/null; then break; fi; \
	  if curl -fsS -m 2 "http://localhost:$${PORT:-3000}/api/health" >/dev/null 2>&1; then ok=1; break; fi; \
	  sleep 1; \
	done; \
	if [ -n "$$ok" ]; then \
	  printf '\n$(BOLD)colloq на$(OFF) $(CYAN)%s$(OFF)\n' \
	    "$$(grep -E '^PUBLIC_URL=' .env | tail -1 | cut -d= -f2-)"; \
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

backup: ## Снять копию базы в backups/ (можно на ходу, семинар не останавливается)
	@# VACUUM INTO читает согласованный снимок и пишет один готовый файл. Копия
	@# самого colloq.db этого не даёт: в режиме WAL половина дня лежит в журнале
	@# рядом, и файл, скопированный на ходу, отстаёт на часы. Проверено.
	@#
	@# Файлы семинаров (./workspace) сюда не входят — это отдельная папка, её
	@# копируют как папку. В базе лежат сами семинары, преподаватели, история
	@# версий и настройки оракула.
	@mkdir -p backups
	@out="backups/colloq-$$(date +%Y%m%d-%H%M%S).db"; \
	  sqlite3 data/colloq.db "VACUUM INTO '$$PWD/$$out'" \
	    && printf '$(BOLD)копия:$(OFF) %s $(DIM)(%s)$(OFF)\n' "$$out" "$$(du -h "$$out" | cut -f1)" \
	    || { printf '$(RED)не вышло. Нужен sqlite3 — brew install sqlite$(OFF)\n'; exit 1; }

down: ## Остановить всё (данные и файлы семинаров остаются)
	docker compose down

restart: ## Перезапустить, не пересобирая
	docker compose restart

logs: ## Смотреть логи (Ctrl+C — выйти)
	docker compose logs -f --tail=80

status: ## Что запущено и в каком состоянии
	@docker compose ps
	@printf '\n$(DIM)окружение ядра:$(OFF) $(BOLD)$(CURRENT_ENV)$(OFF)\n'
	@printf '$(DIM)PUBLIC_URL:$(OFF) %s\n' "$$(grep -E '^PUBLIC_URL=' .env 2>/dev/null | tail -1 | cut -d= -f2-)"

ps: status

shell: ## Оболочка внутри ядра — посмотреть, что там на самом деле стоит
	docker compose exec kernel bash

## ----------------------------------------------------------------- наружу

host: .env ## Выставить семинар наружу и получить ссылку. HOST=... — свой адрес
	@COLLOQ_HOSTNAME="$(HOST)" ./scripts/host.sh

relay-setup: ## Поставить ретранслятор для *.colloq.ru. WHERE=root@адрес
	@test -n "$(WHERE)" || { printf '$(RED)Укажите машину: make relay-setup WHERE=root@203.0.113.11$(OFF)\n'; exit 1; }
	@./scripts/relay-setup.sh "$(WHERE)"

tunnel-setup: ## Один раз завести постоянный адрес. HOST=seminar.example.ru
	@test -n "$(HOST)" || { printf '$(RED)Укажите адрес: make tunnel-setup HOST=seminar.example.ru$(OFF)\n'; exit 1; }
	@./scripts/tunnel-setup.sh "$(HOST)"

## ------------------------------------------------------------- окружения

env-list: ## Какие окружения заведены
	@printf '$(BOLD)Окружения$(OFF) $(DIM)($(ENV_DIR)/)$(OFF)\n\n'
	@for f in $(ENV_DIR)/*.txt; do \
	  name=$$(basename "$$f" .txt); \
	  n=$$(grep -vE '^\s*(#|-|$$)' "$$f" | grep -c . || true); \
	  mark=' '; [ "$$name" = "$(CURRENT_ENV)" ] && mark='*'; \
	  printf '  %s %-14s $(DIM)%s пакетов сверх базы$(OFF)\n' "$$mark" "$$name" "$$n"; \
	done
	@printf '\n$(DIM)* — то, что стоит сейчас. Переключить: make env-use NAME=<имя>$(OFF)\n'

env-show: ## Что за окружение стоит сейчас и что в нём
	@printf '$(BOLD)$(CURRENT_ENV)$(OFF) $(DIM)— $(ENV_DIR)/$(CURRENT_ENV).txt$(OFF)\n\n'
	@out=$$(grep -vE '^\s*(#|$$)' $(ENV_DIR)/$(CURRENT_ENV).txt 2>/dev/null || true); \
	  if [ -n "$$out" ]; then printf '%s\n' "$$out" | sed 's/^/  /'; \
	  else printf '  $(DIM)ничего сверх базы$(OFF)\n'; fi
	@printf '\n$(DIM)База (есть всегда):$(OFF)\n'
	@grep -vE '^\s*(#|$$)' kernel/requirements.txt | sed 's/^/  /'

env-new: ## Завести окружение. NAME=cv
	@test -n "$(NAME)" || { printf '$(RED)Укажите имя: make env-new NAME=cv$(OFF)\n'; exit 1; }
	@test ! -f $(ENV_DIR)/$(NAME).txt || { printf '$(RED)$(ENV_DIR)/$(NAME).txt уже есть.$(OFF)\n'; exit 1; }
	@printf '# Окружение «$(NAME)». Ставится поверх базы из kernel/requirements.txt,\n' > $(ENV_DIR)/$(NAME).txt
	@printf '# поэтому numpy/pandas/matplotlib/scikit-learn перечислять не нужно.\n#\n' >> $(ENV_DIR)/$(NAME).txt
	@printf '# Один пакет на строку, как в обычном requirements.txt:\n#\n' >> $(ENV_DIR)/$(NAME).txt
	@printf '#   transformers>=4.44\n#   datasets>=2.20\n' >> $(ENV_DIR)/$(NAME).txt
	@printf '$(BOLD)создан$(OFF) $(ENV_DIR)/$(NAME).txt\n'
	@printf '$(DIM)впишите пакеты, потом: make env-use NAME=$(NAME)$(OFF)\n'

env-build: ## Собрать образ окружения, не переключаясь. NAME=cv
	@test -n "$(NAME)" || { printf '$(RED)Укажите имя: make env-build NAME=cv$(OFF)\n'; exit 1; }
	@test -f $(ENV_DIR)/$(NAME).txt || { printf '$(RED)Нет $(ENV_DIR)/$(NAME).txt — сначала make env-new NAME=$(NAME)$(OFF)\n'; exit 1; }
	KERNEL_ENV=$(NAME) docker compose build kernel

env-use: ## Переключить ядро на окружение. NAME=cv
	@test -n "$(NAME)" || { printf '$(RED)Укажите имя: make env-use NAME=cv$(OFF)\n'; exit 1; }
	@test -f $(ENV_DIR)/$(NAME).txt || { printf '$(RED)Нет $(ENV_DIR)/$(NAME).txt — сначала make env-new NAME=$(NAME)$(OFF)\n'; exit 1; }
	@printf '$(BOLD)собираю $(NAME)$(OFF) $(DIM)(первый раз может быть долго)$(OFF)\n'
	KERNEL_ENV=$(NAME) docker compose build kernel
	@# Записывается в .env, потому что compose читает KERNEL_ENV оттуда: иначе
	@# следующий `make up` без переменной молча вернул бы старое окружение.
	@tmp=$$(mktemp); grep -vE '^KERNEL_ENV=' .env > "$$tmp" 2>/dev/null || true; \
	  printf 'KERNEL_ENV=$(NAME)\n' >> "$$tmp"; mv "$$tmp" .env
	@# Если ядро работает в dev-режиме, поднимаем его тем же составом файлов:
	@# иначе оно вернётся без проброшенного 8888 и без ./workspace.
	@if docker compose $(DEV) ps kernel --format '{{.Publishers}}' 2>/dev/null | grep -q 8888; then \
	  KERNEL_ENV=$(NAME) docker compose $(DEV) up -d kernel; \
	else \
	  KERNEL_ENV=$(NAME) docker compose up -d kernel; \
	fi
	@printf '\n$(BOLD)ядро работает на окружении $(CYAN)$(NAME)$(OFF)\n'
	@printf '$(RED)Переменные в открытых семинарах потеряны:$(OFF) $(DIM)ядро перезапущено.$(OFF)\n'
	@printf '$(DIM)Ячейки и файлы на месте — нужно просто прогнать заново.$(OFF)\n'

env-freeze: ## Показать реальные версии из работающего ядра
	@docker compose exec -T kernel pip freeze

## ------------------------------------------------------------------ прочее

test: ## Прогнать тесты
	npm test

check: ## Тесты и проверка типов
	npm test && npm run typecheck

.env:
	@test -f .env || { \
	  printf '$(BOLD)нет .env — делаю из .env.example$(OFF)\n'; \
	  cp .env.example .env; \
	  : ; \
	  : 'Секрет между приложением и ядром — свой на каждой установке.'; \
	  : 'В примере стоит colloq-dev-token, и он лежит в публичном репозитории:'; \
	  : 'копия примера как есть означала, что у всех, кто ставил Colloq, один и'; \
	  : 'тот же пароль к контейнеру с Python. Порт слушает только петля, так что'; \
	  : 'это не дыра наружу, — но и оставлять общеизвестное значение незачем,'; \
	  : 'когда его можно выписать одной строкой.'; \
	  tok="$$(LC_ALL=C tr -dc 'a-f0-9' < /dev/urandom | head -c 32)"; \
	  tmp="$$(mktemp)"; \
	  sed "s|^JUPYTER_TOKEN=.*|JUPYTER_TOKEN=$$tok|" .env > "$$tmp" && mv "$$tmp" .env; \
	  printf '$(DIM)загляните в него перед семинаром: там ключ ассистента и почта админа$(OFF)\n'; \
	}

help: ## Показать этот список
	@printf '$(BOLD)Colloq$(OFF) $(DIM)— совместные семинары на своём железе$(OFF)\n\n'
	@grep -hE '^[a-z][a-z-]*:.*?## .*$$' $(MAKEFILE_LIST) \
	  | awk 'BEGIN {FS = ":.*?## "}; {printf "  $(CYAN)%-16s$(OFF) %s\n", $$1, $$2}'
	@printf '\n$(DIM)Каждый день:  make run · make host · раздать ссылку$(OFF)\n'
	@printf '$(DIM)Всё в docker: make up$(OFF)\n'
	@printf '$(DIM)Окружение ядра сейчас: $(BOLD)$(CURRENT_ENV)$(OFF)\n'
