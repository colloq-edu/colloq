# ---------- build ----------
ARG NODE_IMAGE=node:22-bookworm-slim
FROM ${NODE_IMAGE} AS build
WORKDIR /app

# better-sqlite3 falls back to a source build when no prebuild matches.
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 make g++ ca-certificates \
 && rm -rf /var/lib/apt/lists/*

# The lockfile together with the manifests, and `npm ci`, not `npm install`.
#
# Without the lockfile every rebuild resolved the `^` ranges anew against the
# state of the registry on the day of the build: tests and typecheck ran
# against the pinned versions, while the container got different ones, and
# the divergence showed up only there. There are three manifests because
# these are workspaces: ci checks the lockfile against all of them.
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
# Fonts of the link card (server/src/og-card.ts): read from disk next to dist.
COPY server/assets ./assets
COPY --from=build /app/web/dist ./public
COPY server/package.json ./package.json

# The package lists go into the image, and this is not about building the
# kernel.
#
# The server finds the repository root by walking up to the
# kernel/environments directory. In the container that directory did not
# exist at all, the search hit `/`, and the Environments section came up
# empty, while "New environment" answered 500 (EACCES on /kernel). Meanwhile
# both the panel and the refusal text promise the opposite: "environments are
# still visible and editable here". Compose mounts this same folder from the
# host on top, so edits from the panel survive an image rebuild.
COPY kernel/environments ./kernel/environments
# The image is a copy of the program: MIT requires the license text to travel
# with it, and the bundles carry other people's code under their own licenses
# (THIRD_PARTY_NOTICES.md).
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
COPY runtime/package.json ./package.json
COPY --from=build /app/runtime/dist/runtime.js ./runtime.js
COPY --from=build /app/runtime/dist/export-sidecar.js ./export-sidecar.js
COPY --from=build /app/runtime/dist/competition-proxy.js ./competition-proxy.js
COPY LICENSE ./
USER node
EXPOSE 8787
CMD ["node", "runtime.js"]

# Default and published app image excludes every development-only capability.
FROM app-base AS production
