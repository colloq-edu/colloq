# ---------- build ----------
FROM node:22-bookworm-slim AS build
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
RUN npm ci --no-audit --no-fund

COPY shared/ shared/
COPY server/ server/
COPY web/ web/

RUN npm run build -w @colloq/web \
 && npm run build -w @colloq/server \
 && npm prune --omit=dev

# ---------- runtime ----------
FROM node:22-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production

COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/server/dist ./dist
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

# Клиент docker, чтобы у комнаты был свой контейнер и под `make up`.
#
# Ядро на семинар сервер поднимает сам, `docker run` — а в контейнере не было
# ни клиента, ни сокета, поэтому все комнаты делили одно ядро compose и видели
# файлы друг друга. Здесь только КЛИЕНТ, четырнадцать мегабайт; демон остаётся
# на хосте, и разговаривает с ним сервер через сокет, который compose монтирует
# рядом. Нет сокета или нет прав на него — клиент честно не отвечает, и комната
# откатывается на общее ядро, как раньше.
COPY --from=docker:28-cli /usr/local/bin/docker /usr/local/bin/docker

RUN mkdir -p /data /workspace && chown -R node:node /data /workspace /app
USER node

ENV PORT=3000 \
    DATA_DIR=/data \
    WORKSPACE_DIR=/workspace \
    STATIC_DIR=/app/public
EXPOSE 3000
CMD ["node", "dist/server.js"]
