# ---------- build ----------
FROM node:22-bookworm-slim AS build
WORKDIR /app

# better-sqlite3 falls back to a source build when no prebuild matches.
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 make g++ ca-certificates \
 && rm -rf /var/lib/apt/lists/*

COPY package.json ./
COPY server/package.json server/
COPY web/package.json web/
RUN npm install --no-audit --no-fund

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

RUN mkdir -p /data /workspace && chown -R node:node /data /workspace /app
USER node

ENV PORT=3000 \
    DATA_DIR=/data \
    WORKSPACE_DIR=/workspace \
    STATIC_DIR=/app/public
EXPOSE 3000
CMD ["node", "dist/server.js"]
