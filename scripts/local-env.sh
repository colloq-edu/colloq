#!/usr/bin/env bash
#
# The .env of a local class, for make. Prints it to stdout; the `.env` target
# writes it.
#
# Why a separate writer, when colloq already writes out the same file
# (cli/src/launch-config.ts · localClassEnv). The `.env` target used to do
# `cp .env.example .env`, and .env.example is the PRODUCTION template:
# KERNEL_BACKEND=broker, KERNEL_CATALOG_FILE=/etc/colloq/… . The file is
# created by the first target that needs it (make up, run, host, activity),
# and after that `make dev` refused on broker: "This is a runtime broker
# installation". The supervisor is right about it, and there is no reason to
# weaken its check; the one in the wrong was the Makefile, which wrote out for
# a person a file unfit for exactly what that person is doing.
#
# Why not call localClassEnv itself through node. `make up` is all in docker,
# and on a machine with docker alone (a one-off demo, a rented VM) there is
# neither node nor node_modules with tsx: the `.env` target would fail before
# compose. So the text is duplicated here, and a test keeps the copies from
# drifting apart (tests/local-launch-env.test.mts compares the output with
# localClassEnv(false) line by line, except for the token value). Edit one,
# edit the other.
#
# Language ru: localClassEnv(false) is the repository branch, and make exists
# only in the repository. For `make up` the content is enough: compose takes
# PORT, BIND_ADDR, UI_LANGUAGE, KERNEL_*, the keys and the Oracle settings
# from here, and has defaults for the rest; the docker-gid target appends
# DOCKER_GID.
set -euo pipefail

# The kernel token is unique to each installation, 24 bytes in hex, like
# randomBytes(24) in colloq. Through od, not `tr -dc … </dev/urandom | head`:
# under pipefail tr catches SIGPIPE, the substitution returns 141, and set -e
# would cut the script short.
token="$(od -An -tx1 -N24 /dev/urandom | tr -d ' \n')"
[ "${#token}" -eq 48 ] || { echo 'local-env.sh: /dev/urandom did not give 24 bytes' >&2; exit 1; }

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
