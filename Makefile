# Colloq — команды на каждый день.
#
# Две вещи, ради которых это существует:
#
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

.PHONY: help up dev down restart logs status ps shell \
        host tunnel-setup \
        env-list env-show env-new env-use env-build env-freeze \
        test check

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
	  printf '$(DIM)загляните в него перед семинаром: там ключ ассистента и почта админа$(OFF)\n'; \
	}

help: ## Показать этот список
	@printf '$(BOLD)Colloq$(OFF) $(DIM)— совместные семинары на своём железе$(OFF)\n\n'
	@grep -hE '^[a-z][a-z-]*:.*?## .*$$' $(MAKEFILE_LIST) \
	  | awk 'BEGIN {FS = ":.*?## "}; {printf "  $(CYAN)%-16s$(OFF) %s\n", $$1, $$2}'
	@printf '\n$(DIM)Обычный семинар: make up · make host · раздать ссылку$(OFF)\n'
	@printf '$(DIM)Окружение ядра сейчас: $(BOLD)$(CURRENT_ENV)$(OFF)\n'
