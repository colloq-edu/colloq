#!/bin/bash
#
# Colloq on a Vast.ai VM: paste this whole file into the template's
# "On-start script" field (VM templates need the #! line). Edit the settings
# block; everything else ships inside the image. Runs on every boot and is
# idempotent: an unchanged instance is left running.
#
# Full template settings, variables and trade-offs: deploy/vast/README.md.

# ---- settings -------------------------------------------------------------
export COLLOQ_IMAGE="ghcr.io/OWNER/colloq-vast:VERSION"

# Public address. Pick one:
#   relay (your own frps; the path that works from Russia):
#     COLLOQ_HOSTNAME=class1  RELAY_DOMAIN=relay.example.org  RELAY_ADDR=…  RELAY_TOKEN=…
#   named Cloudflare tunnel: CLOUDFLARE_TUNNEL_TOKEN=…  COLLOQ_HOSTNAME=class.example.org
#   nothing: a quick *.trycloudflare.com address, printed in the log
export COLLOQ_HOSTNAME=""
export RELAY_DOMAIN=""
export RELAY_ADDR=""
export RELAY_PORT="7000"
export RELAY_TOKEN=""
export CLOUDFLARE_TUNNEL_TOKEN=""

export UI_LANGUAGE="en"            # en | ru
export ADMIN_EMAIL=""              # prefills the owner claim form
export INSTITUTION=""              # shown next to the logo
export OPENAI_API_KEY=""           # empty: the assistant is off (can be set later in the panel)

# Python environments prepared before the first class. On a GPU offer: base,gpu
export KERNEL_PRELOAD="base"
# Pull prebuilt kernel images instead of building them here (optional):
#   KERNEL_IMAGE_REPO=ghcr.io/OWNER/colloq-kernel  → pulls <repo>:v<version>-<env>
export KERNEL_IMAGE_REPO=""

# Private registry only (a read-only token): used by docker on the VM.
export COLLOQ_REGISTRY_USER=""
export COLLOQ_REGISTRY_TOKEN=""
# ---------------------------------------------------------------------------

set -euo pipefail
# The log carries the owner's setup link until someone claims the instance.
umask 077
exec > >(tee -a /var/log/colloq-onstart.log) 2>&1
echo "== colloq on-start $(date -Is)"

# Docker comes with Vast's Ubuntu VM images; install it only if it is missing.
command -v docker >/dev/null 2>&1 || curl -fsSL https://get.docker.com | sh
systemctl enable --now docker >/dev/null 2>&1 || true
for _ in $(seq 1 60); do docker info >/dev/null 2>&1 && break; sleep 2; done

if [ -n "$COLLOQ_REGISTRY_TOKEN" ]; then
  printf '%s' "$COLLOQ_REGISTRY_TOKEN" \
    | docker login "${COLLOQ_IMAGE%%/*}" -u "${COLLOQ_REGISTRY_USER:-colloq}" --password-stdin
fi

# The host-side manager lives in the image; install it, then let it do the rest.
# After `colloq-host update` the instance runs the image named in
# /etc/colloq/image, and COLLOQ_IMAGE above only chose the first one.
image="$(head -1 /etc/colloq/image 2>/dev/null || true)"
docker run --rm -v /usr/local/sbin:/host "${image:-$COLLOQ_IMAGE}" install-host /host
exec /usr/local/sbin/colloq-host up
