# ---------- build ----------
ARG NODE_IMAGE=node:22-bookworm-slim
FROM ${NODE_IMAGE} AS build
WORKDIR /app

# better-sqlite3 falls back to a source build when no prebuild matches.
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 make g++ ca-certificates \
 && rm -rf /var/lib/apt/lists/*

# Замок вместе с манифестами, и `npm ci`, а не `npm install`.
#
# Без замка каждая пересборка заново разрешала `^`-диапазоны по состоянию
# реестра на день сборки: тесты и typecheck шли против зафиксированных версий,
# а в контейнер приезжали другие — и расхождение проявлялось только там.
# Манифестов три, потому что это workspaces: ci сверяет замок со всеми.
COPY package.json package-lock.json ./
COPY server/package.json server/
COPY web/package.json web/
COPY runtime/package.json runtime/
RUN npm ci --no-audit --no-fund

COPY shared/ shared/
COPY server/ server/
COPY web/ web/
COPY runtime/ runtime/

RUN npm run build:optimized -w @colloq/web \
 && npm run build -w @colloq/server \
 && npm run build -w @colloq/runtime \
 && npm prune --omit=dev

# ---------- runtime ----------
FROM ${NODE_IMAGE} AS app-base
WORKDIR /app
ENV NODE_ENV=production

COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/server/dist ./dist
# Шрифты карточки ссылки (server/src/og-card.ts): читаются с диска рядом с dist.
COPY server/assets ./assets
COPY --from=build /app/web/dist ./public
COPY server/package.json ./package.json

# Списки пакетов едут в образ, и это не про сборку ядра.
#
# Сервер ищет корень репозитория, поднимаясь до каталога kernel/environments.
# В контейнере его не было вовсе, поиск упирался в `/`, и раздел Environments
# оказывался пустым, а «New environment» отвечал 500 (EACCES на /kernel). При
# этом и панель, и текст отказа обещают обратное: «окружения здесь всё равно
# видно и правится». Compose поверх монтирует эту же папку с хоста, так что
# правки из панели переживают пересборку образа.
COPY kernel/environments ./kernel/environments
# Образ — копия программы: MIT велит везти текст лицензии с ней, а бандлы
# несут чужой код под своими лицензиями (THIRD_PARTY_NOTICES.md).
COPY LICENSE THIRD_PARTY_NOTICES.md ./

RUN mkdir -p /data /workspace && chown -R node:node /data /workspace /app
USER node

ENV PORT=3000 \
    DATA_DIR=/data \
    WORKSPACE_DIR=/workspace \
    STATIC_DIR=/app/public
EXPOSE 3000
CMD ["node", "dist/server.js"]

# Explicit workstation development target; never used for a production release.
FROM app-base AS development
USER root
COPY --from=docker:28-cli /usr/local/bin/docker /usr/local/bin/docker
COPY --from=docker:28-cli /usr/local/libexec/docker/cli-plugins/docker-buildx /usr/local/libexec/docker/cli-plugins/docker-buildx
USER node
ENV NODE_ENV=development KERNEL_BACKEND=docker

# Small private controller: no Docker client, host socket, or build context.
FROM ${NODE_IMAGE} AS broker
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app/runtime/dist/runtime.js ./runtime.js
COPY LICENSE ./
USER node
EXPOSE 8787
CMD ["node", "runtime.js"]

# Default and published app image excludes every development-only capability.
FROM app-base AS production
