#!/usr/bin/env bash
#
# .env локального занятия — для make. Печатает его в stdout; пишет цель `.env`.
#
# Зачем отдельный писатель, когда тот же файл уже выписывает colloq
# (cli/src/launch-config.ts · localClassEnv). Цель `.env` раньше делала
# `cp .env.example .env`, а .env.example — шаблон ПРОДА: KERNEL_BACKEND=broker,
# KERNEL_CATALOG_FILE=/etc/colloq/… . Файл заводит первая же цель, которой он
# нужен (make up, run, host, activity), — и после неё `make dev` отказывал на
# broker: «This is a runtime broker installation». Супервизор при этом прав —
# ослаблять его проверку незачем, — неправ был Makefile, выписавший за
# человека файл, непригодный ровно для того, что человек делает.
#
# Почему не звать сам localClassEnv через node. `make up` — всё в docker, и
# на машине с одним docker (разовая демонстрация, арендованная VM) нет ни node,
# ни node_modules с tsx: цель `.env` упала бы раньше compose. Поэтому текст
# здесь продублирован, а расходиться копиям не даёт тест
# (tests/local-launch-env.test.mts сверяет вывод с localClassEnv(false)
# построчно, кроме значения токена). Правите одно — правьте и другое.
#
# Язык ru: localClassEnv(false) — это ветка репозитория, а make бывает только
# в репозитории. Для `make up` содержимого хватает: compose берёт отсюда PORT,
# BIND_ADDR, UI_LANGUAGE, KERNEL_*, ключи и настройки оракула, прочее у него
# с умолчаниями; DOCKER_GID допишет цель docker-gid.
set -euo pipefail

# Токен ядра свой на каждой установке, 24 байта в hex — как randomBytes(24) у
# colloq. Через od, а не `tr -dc … </dev/urandom | head`: под pipefail tr
# ловит SIGPIPE, подстановка возвращает 141, и set -e обрывал бы скрипт.
token="$(od -An -tx1 -N24 /dev/urandom | tr -d ' \n')"
[ "${#token}" -eq 48 ] || { echo 'local-env.sh: /dev/urandom не дал 24 байта' >&2; exit 1; }

cat <<EOF
# Settings for this machine. colloq wrote this file on its first start:
# edit it and restart with colloq restart. The full list of everything that
# can be configured is in .env.example next to the application.

# The address of the class on this machine. From outside it is visible
# only through colloq host.
PORT=3000
BIND_ADDR=127.0.0.1
UI_LANGUAGE=ru

# The kernels of a class are Docker containers on this computer, one per room.
# Each room container is hardened: no privileges, a process limit, the internet
# yes, your local network and this computer no. COLLOQ_ROOM_NETWORK=open lifts
# the network block for a machine you fully trust.
KERNEL_BACKEND=docker
KERNEL_ENV=base
# Memory and processors of one room. 4g is enough for an ordinary class; for a
# class that trains networks set 8g-16g, if the machine has that much.
KERNEL_MEM=4g
KERNEL_CPUS=2
KERNEL_SHM=1g

# Signs the sign-in links of teachers and students. Left empty, the key is
# created in data/ on its own and survives a restart; a value written here
# wins over it.
SESSION_SECRET=
# Not a shared Jupyter: every room has a token of its own. This line is here
# so the log does not keep the token from .env.example, which everyone knows.
JUPYTER_TOKEN=${token}

# File uploads and the disk space one class may take.
MAX_UPLOAD_MB=50
MAX_SESSION_MB=1024

# The Oracle. Without a key the class still runs, but the model cannot be asked.
AI_PROVIDER=openai
OPENAI_API_KEY=
OPENAI_BASE_URL=https://api.openai.com/v1
OPENAI_MODEL=gpt-4o-mini
EOF
