# syntax=docker/dockerfile:1
#
# colloq-vast — Colloq одним образом для арендованной машины.
#
# Собирается из корня репозитория (контекст — весь репозиторий, как у
# корневого Dockerfile):
#
#     docker build -f deploy/vast/Dockerfile -t colloq-vast:dev .
#     make vast-image                       то же самое, с версией и ревизией
#
# ЧТО ЭТО ЗА ОБРАЗ И ЧЕГО В НЁМ НЕТ. Внутри — сервер, собранный клиент,
# туннели (frpc, cloudflared), docker CLI и контекст сборки ядер. Самих ядер
# комнат внутри НЕТ и быть не может: у каждой комнаты свой контейнер (память,
# процессор, pids и GPU режет cgroup), а поднимает их демон ХОСТА через
# примонтированный /var/run/docker.sock. Поэтому образ работает на Vast VM и
# на любой машине с docker, но не на обычном Docker-инстансе vast: там docker
# внутри запрещён. Разбор решения и цена — deploy/vast/README.md, «Design».
#
# ПОЧЕМУ НЕТ CUDA. Карта нужна ядру комнаты, а не серверу: колёса torch везут
# свой CUDA runtime, драйвер приходит с хоста через nvidia-container-toolkit, и
# `--gpus device=N` ставит сервер на контейнер комнаты. Образ nvidia/cuda под
# сервером стоил бы трёх гигабайт скачивания на каждую аренду и не дал бы
# комнате ничего.
#
# Сборочная стадия — та же, что в корневом Dockerfile (замок, `npm ci`,
# build:optimized), и повторена здесь, а не взята оттуда: `FROM` чужой стадии
# между файлами docker не умеет, а менять корневой Dockerfile ради этого образа
# значило бы трогать образ разработки и релиза.

ARG NODE_IMAGE=node:22-bookworm-slim
ARG DOCKER_CLI_IMAGE=docker:28-cli

# ---------------------------------------------------------------- сборка
#
# На платформе СБОРЩИКА, а не цели: server.js и web/dist — это JavaScript, им
# всё равно, на чём их собрали. Под эмуляцией (amd64-образ на arm64-ноутбуке)
# esbuild, бинарник Go, падает с SIGSEGV (код 139) — проверено 18.09.2026, — а
# сборка клиента идёт впятеро дольше. Эмуляции остаётся только то, что правда
# зависит от платформы: node_modules сервера (стадия deps ниже).
FROM --platform=$BUILDPLATFORM ${NODE_IMAGE} AS build
WORKDIR /app

# Сборке нужен полный node_modules, а в нём тоже better-sqlite3: без готовой
# сборки под платформу он собирается из исходников.
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 make g++ ca-certificates \
 && rm -rf /var/lib/apt/lists/*

# Замок вместе со ВСЕМИ манифестами workspaces: `npm ci` сверяет замок с каждым.
COPY package.json package-lock.json ./
COPY server/package.json server/
COPY web/package.json web/
COPY runtime/package.json runtime/
COPY cli/package.json cli/
RUN npm ci --no-audit --no-fund

COPY shared/ shared/
COPY server/ server/
COPY web/ web/

# Брокер ядер (runtime/) здесь не собирается: он нужен только k3s-пути.
RUN npm run build:optimized -w @colloq/web \
 && npm run build -w @colloq/server

# ------------------------------------------------- зависимости сервера
#
# На платформе ЦЕЛИ: better-sqlite3 и @resvg/resvg-js — нативные модули, и их
# сборка должна совпасть с машиной, на которой образ будет работать.
#
# И только сервера. `npm prune --omit=dev` корневого Dockerfile оставляет в
# образе всё, что web объявил зависимостями (svelte, codemirror, pdf.js), — а
# клиент уже собран в web/dist, серверу из этого не нужно ни байта. Корневые
# зависимости (yjs) нужны: shared/ вшит в server.js и импортирует их.
FROM ${NODE_IMAGE} AS deps
WORKDIR /app
# better-sqlite3 собирается из исходников, когда готовой сборки под платформу нет.
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 make g++ ca-certificates \
 && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
COPY server/package.json server/
COPY web/package.json web/
COPY runtime/package.json runtime/
COPY cli/package.json cli/
RUN npm ci --omit=dev --no-audit --no-fund --workspace=@colloq/server --include-workspace-root

# ------------------------------------------------------------ туннели
#
# Версии и контрольные суммы прибиты: бинарник, который держит туннель до
# ретранслятора, — это то, через что идёт вся пара. frpc той же версии, что
# стоит на ретрансляторе (scripts/relay-setup.sh, scripts/vast-legacy.sh).
# Только скачать и сверить — на платформе сборщика; архитектуру бинарников
# выбирает TARGETARCH.
FROM --platform=$BUILDPLATFORM ${NODE_IMAGE} AS tunnels
ARG TARGETARCH
ARG FRP_VERSION=0.71.0
ARG FRP_SHA256_AMD64=84f27e39f11169f7adcef8e8b70c9329de17747b1f14dad9fb95eef5682ea716
ARG FRP_SHA256_ARM64=f33c293c275d8fc68c654b6fba8f10b2551d6463d09a9fc9cffb7227eae82266
ARG CLOUDFLARED_VERSION=2026.9.1
ARG CLOUDFLARED_SHA256_AMD64=03f1f25d1cc93b9ad6c60569d44060bc4f17ed97075760ed8cfca4b12dcd68cc
ARG CLOUDFLARED_SHA256_ARM64=3d97437c71848bd8df68041e12436b484a661d95073ea1937f01a845ce88faa3
RUN apt-get update \
 && apt-get install -y --no-install-recommends curl ca-certificates \
 && rm -rf /var/lib/apt/lists/*
RUN set -eu; \
    case "${TARGETARCH:-amd64}" in \
      amd64) frp_sum="$FRP_SHA256_AMD64"; cf_sum="$CLOUDFLARED_SHA256_AMD64" ;; \
      arm64) frp_sum="$FRP_SHA256_ARM64"; cf_sum="$CLOUDFLARED_SHA256_ARM64" ;; \
      *) echo "unsupported architecture: $TARGETARCH" >&2; exit 1 ;; \
    esac; \
    arch="${TARGETARCH:-amd64}"; \
    mkdir -p /out /tmp/frp; \
    curl -fsSL -o /tmp/frp.tgz \
      "https://github.com/fatedier/frp/releases/download/v${FRP_VERSION}/frp_${FRP_VERSION}_linux_${arch}.tar.gz"; \
    echo "${frp_sum}  /tmp/frp.tgz" | sha256sum -c -; \
    tar -xzf /tmp/frp.tgz -C /tmp/frp --strip-components=1; \
    install -m 0755 /tmp/frp/frpc /out/frpc; \
    curl -fsSL -o /out/cloudflared \
      "https://github.com/cloudflare/cloudflared/releases/download/${CLOUDFLARED_VERSION}/cloudflared-linux-${arch}"; \
    echo "${cf_sum}  /out/cloudflared" | sha256sum -c -; \
    chmod 0755 /out/cloudflared

FROM ${DOCKER_CLI_IMAGE} AS dockercli

# ------------------------------------------------------------ образ
FROM ${NODE_IMAGE} AS vast

# tini — PID 1: пересылает сигналы и подбирает сирот (frpc, cloudflared, docker
# build в фоне). sqlite3 — для копии занятия (scripts/backup-local.sh делает
# VACUUM INTO). curl — проба готовности и зеркало статики на ретрансляторе.
RUN apt-get update \
 && apt-get install -y --no-install-recommends tini curl ca-certificates sqlite3 procps \
 && rm -rf /var/lib/apt/lists/*

# docker CLI и buildx — клиенты демона хоста: им сервер поднимает контейнеры
# комнат и собирает окружения из панели (server/src/environments.ts).
COPY --from=dockercli /usr/local/bin/docker /usr/local/bin/docker
COPY --from=dockercli /usr/local/libexec/docker/cli-plugins/docker-buildx /usr/local/libexec/docker/cli-plugins/docker-buildx
COPY --from=tunnels /out/frpc /out/cloudflared /usr/local/bin/

# Раскладка — как у репозитория, и это не вкус. Сервер находит корень
# приложения шагами вверх до kernel/environments (environments.ts ·
# findRepoRoot), шрифты карточки — рядом с dist (og-card.ts), а .env — двумя
# уровнями над dist/server.js (config.ts · readPublicUrl). С путями
# репозитория все три находят своё без единой новой переменной.
WORKDIR /opt/colloq
COPY --from=deps /app/node_modules ./node_modules
COPY --from=build /app/server/dist ./server/dist
# package.json рядом с dist — ради "type": "module": без него node читает
# server.js как CommonJS и падает на первом import.
COPY server/package.json ./server/package.json
COPY server/assets ./server/assets
COPY --from=build /app/web/dist ./web/dist

# Контекст сборки ядер: сервер собирает окружения из панели через демон хоста,
# а точка входа — умолчательное окружение при первом запуске. Штампы
# `.<имя>.built` не едут (.dockerignore): они про docker конкретной машины.
COPY kernel/Dockerfile kernel/requirements.txt ./kernel/
COPY kernel/environments/ ./kernel/environments/

# Копия и восстановление занятия — те же скрипты, что у колеса pip.
COPY scripts/lib.sh scripts/backup-local.sh scripts/restore.sh ./scripts/

COPY deploy/vast/entrypoint.sh /usr/local/bin/colloq-vast
COPY deploy/vast/colloq-host deploy/vast/onstart.sh ./deploy/vast/

# Образ — копия программы, и MIT велит везти текст лицензии с ней. Метка
# licenses="MIT" ниже — про код Colloq; что в образе под другими лицензиями
# (frpc, cloudflared, docker CLI, бандлы, шрифты), перечислено в notices.
COPY LICENSE THIRD_PARTY_NOTICES.md ./

# .env — файл состояния, а не образа: ссылка ведёт в примонтированный каталог.
# Туда пишут точка входа (PUBLIC_URL) и панель (KERNEL_ENV), оттуда их
# перечитывает сервер на ходу, и переживают они обновление образа.
RUN chmod 0755 /usr/local/bin/colloq-vast ./deploy/vast/colloq-host ./deploy/vast/onstart.sh \
 && ln -s /workspace/colloq/.env /opt/colloq/.env \
 && mkdir -p /workspace/colloq \
 && chown node:node /workspace/colloq

ARG COLLOQ_VERSION=0.0.0-dev
ARG GIT_SHA=unknown
ARG SOURCE_URL=https://github.com/colloq-edu/colloq
LABEL org.opencontainers.image.title="colloq-vast" \
      org.opencontainers.image.description="Colloq for a rented GPU machine: server, tunnels and kernel build context; room kernels run as sibling containers on the host Docker daemon." \
      org.opencontainers.image.source="${SOURCE_URL}" \
      org.opencontainers.image.version="${COLLOQ_VERSION}" \
      org.opencontainers.image.revision="${GIT_SHA}" \
      org.opencontainers.image.licenses="MIT"

ENV COLLOQ_VERSION=${COLLOQ_VERSION} \
    COLLOQ_REVISION=${GIT_SHA} \
    COLLOQ_HOME=/workspace/colloq \
    PORT=3000 \
    NODE_OPTIONS=--enable-source-maps

# Точка входа стартует от root ровно на подготовку каталога состояния и группы
# сокета docker, а сервер, туннели и сборки уже работают от node (uid 1000) —
# того же uid, что у пользователя ядра в kernel/Dockerfile: файлы комнаты пишут
# обе стороны, и совпадение uid делает это без групп и umask.
USER root
EXPOSE 3000
# livez, а не health: health честно отвечает 503, пока окружение не собрано, а
# первая сборка — минуты. Контейнер при этом жив и отдаёт панель; готовность к
# паре показывает `colloq-vast status` и /api/health.
HEALTHCHECK --interval=15s --timeout=5s --start-period=60s --retries=4 \
  CMD curl -fsS "http://127.0.0.1:${PORT}/api/livez" >/dev/null || exit 1
STOPSIGNAL SIGTERM
ENTRYPOINT ["/usr/bin/tini", "-g", "--", "/usr/local/bin/colloq-vast"]
CMD ["serve"]
