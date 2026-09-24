# syntax=docker/dockerfile:1
#
# colloq-vast: Colloq as a single image for a rented machine.
#
# Built from the repository root (the context is the whole repository, as for
# the root Dockerfile):
#
#     docker build -f deploy/vast/Dockerfile -t colloq-vast:dev .
#     make vast-image                       the same, with version and revision
#
# WHAT THIS IMAGE IS AND WHAT IT LACKS. Inside: the server, the built client,
# the tunnels (frpc, cloudflared), the docker CLI and the kernel build context.
# The room kernels themselves are NOT inside and cannot be: every room has its
# own container (memory, CPU, pids and GPU are cut by cgroup), and they are
# started by the HOST daemon through the mounted /var/run/docker.sock. So the
# image works on a Vast VM and on any machine with docker, but not on a regular
# vast Docker instance: docker inside is forbidden there. The analysis of the
# decision and its price: deploy/vast/README.md, "Design".
#
# WHY THERE IS NO CUDA. The card is needed by the room kernel, not by the
# server: torch wheels carry their own CUDA runtime, the driver comes from the
# host through nvidia-container-toolkit, and the server puts `--gpus device=N`
# on the room container. An nvidia/cuda image under the server would cost three
# gigabytes of download on every rental and give the room nothing.
#
# The build stage is the same as in the root Dockerfile (the lockfile,
# `npm ci`, build:optimized), and it is repeated here rather than taken from
# there: docker cannot do `FROM` of a stage in another file, and changing the
# root Dockerfile for the sake of this image would mean touching the
# development and release image.

ARG NODE_IMAGE=node:22-bookworm-slim
ARG DOCKER_CLI_IMAGE=docker:28-cli

# ----------------------------------------------------------------- build
#
# On the platform of the BUILDER, not the target: server.js and web/dist are
# JavaScript, they do not care what they were built on. Under emulation (an
# amd64 image on an arm64 laptop) esbuild, a Go binary, crashes with SIGSEGV
# (code 139), checked on 18 Sep 2026, and the client build takes five times
# longer. Emulation is left only with what really depends on the platform:
# the server's node_modules (the deps stage below).
FROM --platform=$BUILDPLATFORM ${NODE_IMAGE} AS build
WORKDIR /app

# The build needs the full node_modules, and it has better-sqlite3 too:
# without a prebuilt binary for the platform it is built from source.
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 make g++ ca-certificates \
 && rm -rf /var/lib/apt/lists/*

# The lockfile together with ALL the workspace manifests: `npm ci` checks the
# lockfile against each of them.
COPY package.json package-lock.json ./
COPY server/package.json server/
COPY web/package.json web/
COPY runtime/package.json runtime/
COPY cli/package.json cli/
RUN npm ci --no-audit --no-fund

COPY shared/ shared/
COPY server/ server/
COPY web/ web/

# The kernel broker (runtime/) is not built here: only the k3s path needs it.
RUN npm run build:optimized -w @colloq/web \
 && npm run build -w @colloq/server

# -------------------------------------------------- server dependencies
#
# On the platform of the TARGET: better-sqlite3 and @resvg/resvg-js are native
# modules, and their build must match the machine the image will run on.
#
# And only the server's. `npm prune --omit=dev` of the root Dockerfile leaves
# in the image everything web declared as dependencies (svelte, codemirror,
# pdf.js), while the client is already built into web/dist, and the server
# needs not a byte of it. The root dependencies (yjs) are needed: shared/ is
# bundled into server.js and imports them.
FROM ${NODE_IMAGE} AS deps
WORKDIR /app
# better-sqlite3 is built from source when there is no prebuilt binary for
# the platform.
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 make g++ ca-certificates \
 && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
COPY server/package.json server/
COPY web/package.json web/
COPY runtime/package.json runtime/
COPY cli/package.json cli/
RUN npm ci --omit=dev --no-audit --no-fund --workspace=@colloq/server --include-workspace-root

# ------------------------------------------------------------ tunnels
#
# Versions and checksums are pinned: the binary that holds the tunnel to the
# relay is what the whole class goes through. frpc is the same version as the
# one installed on the relay (scripts/relay-setup.sh, scripts/vast-legacy.sh).
# Only downloading and verifying, on the builder's platform; TARGETARCH picks
# the architecture of the binaries.
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

# -------------------------------------------------------------- image
FROM ${NODE_IMAGE} AS vast

# tini as PID 1: forwards signals and reaps orphans (frpc, cloudflared, docker
# build in the background). sqlite3 for the class backup
# (scripts/backup-local.sh does VACUUM INTO). curl for the readiness probe and
# the static mirror on the relay.
RUN apt-get update \
 && apt-get install -y --no-install-recommends tini curl ca-certificates sqlite3 procps \
 && rm -rf /var/lib/apt/lists/*

# The docker CLI and buildx are clients of the host daemon: with them the
# server starts the room containers and builds environments from the panel
# (server/src/environments.ts).
COPY --from=dockercli /usr/local/bin/docker /usr/local/bin/docker
COPY --from=dockercli /usr/local/libexec/docker/cli-plugins/docker-buildx /usr/local/libexec/docker/cli-plugins/docker-buildx
COPY --from=tunnels /out/frpc /out/cloudflared /usr/local/bin/

# The layout is the repository's, and that is not a matter of taste. The server
# finds the application root by walking up to kernel/environments
# (environments.ts · findRepoRoot), the card fonts next to dist (og-card.ts),
# and .env two levels above dist/server.js (config.ts · readPublicUrl). With
# the repository paths all three find what they need without a single new
# variable.
WORKDIR /opt/colloq
COPY --from=deps /app/node_modules ./node_modules
COPY --from=build /app/server/dist ./server/dist
# package.json next to dist for the sake of "type": "module": without it node
# reads server.js as CommonJS and fails on the first import.
COPY server/package.json ./server/package.json
COPY server/assets ./server/assets
COPY --from=build /app/web/dist ./web/dist

# The kernel build context: the server builds environments from the panel
# through the host daemon, and the entry point builds the default environment
# on the first start. The `.<name>.built` stamps do not go in (.dockerignore):
# they are about the docker of a particular machine.
COPY kernel/Dockerfile kernel/requirements.txt ./kernel/
COPY kernel/environments/ ./kernel/environments/

# Backup and restore of the class: the same scripts as in the pip wheel.
COPY scripts/lib.sh scripts/backup-local.sh scripts/restore.sh ./scripts/

COPY deploy/vast/entrypoint.sh /usr/local/bin/colloq-vast
COPY deploy/vast/colloq-host deploy/vast/onstart.sh ./deploy/vast/

# The image is a copy of the program, and MIT requires the license text to
# travel with it. The licenses="MIT" label below is about the Colloq code; what
# in the image is under other licenses (frpc, cloudflared, docker CLI, bundles,
# fonts) is listed in the notices.
COPY LICENSE THIRD_PARTY_NOTICES.md ./

# .env is a state file, not an image file: the link leads into the mounted
# directory. The entry point (PUBLIC_URL) and the panel (KERNEL_ENV) write
# there, the server re-reads them from there on the fly, and they survive an
# image update.
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

# The entry point starts as root just to prepare the state directory and the
# docker socket group, while the server, the tunnels and the builds already run
# as node (uid 1000), the same uid as the kernel user in kernel/Dockerfile: both
# sides write the room files, and the matching uid makes that work without
# groups and umask.
USER root
EXPOSE 3000
# livez, not health: health honestly answers 503 until the environment is
# built, and the first build takes minutes. The container is alive meanwhile
# and serves the panel; readiness for the class is shown by `colloq-vast status`
# and /api/health.
HEALTHCHECK --interval=15s --timeout=5s --start-period=60s --retries=4 \
  CMD curl -fsS "http://127.0.0.1:${PORT}/api/livez" >/dev/null || exit 1
STOPSIGNAL SIGTERM
ENTRYPOINT ["/usr/bin/tini", "-g", "--", "/usr/local/bin/colloq-vast"]
CMD ["serve"]
