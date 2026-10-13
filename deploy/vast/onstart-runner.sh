#!/bin/bash
#
# A Vast.ai VM as a machine for another Colloq instance's submissions
# («машина для посылок», docs/architecture/remote-runners.md). make vast-runner
# fills this file in and rents the VMs with it (scripts/vast-runner.sh); by
# hand, paste it into a VM template's "On-start script" field with the two
# settings below filled in (the third only for a fork's images). It runs on
# every boot and is idempotent: a machine that has joined is left running.
#
# WHAT IS IN HERE IS ALL THE MACHINE GETS: the home's address and an
# enrollment code (and, for a fork, the repository its image comes from). No
# relay token, no registry token, no key of any kind: a rented VM, and its
# on-start with it, is seen by the host's operator and kept in Vast's
# console. The code is the owner's (the home's panel, Resources,
# machines for submissions; or colloq-host runner-code on the home): it lets N
# machines join within at most a day, and is worth nothing after. The machine
# then holds a secret of its own, which the owner can revoke from the panel.

# ---- settings -------------------------------------------------------------
export COLLOQ_RUNNER_URL="https://HOME"   # the home whose submissions this machine runs
export COLLOQ_RUNNER_CODE="CODE"          # 32 hex digits from its owner
export COLLOQ_RUNNER_REPO=""              # the image's repository; empty: ghcr.io/colloq-edu/colloq-server
# ---------------------------------------------------------------------------

# Not settings: this file exists only for Vast VMs, and says so (the same two
# flags as deploy/vast/onstart.sh, for the same reasons). A rented VM keeps
# the driver it booted with: an unattended upgrade of the NVIDIA userspace
# under the loaded module ends every GPU run on the machine.
export COLLOQ_ON_VAST=1
export COLLOQ_FREEZE_UPDATES=1

set -euo pipefail
umask 077
exec > >(tee -a /var/log/colloq-onstart.log) 2>&1
echo "== colloq runner on-start $(date -Is)"

# Docker comes with Vast's Ubuntu VM images; install it only if it is missing.
command -v docker >/dev/null 2>&1 || curl -fsSL https://get.docker.com | sh
systemctl enable --now docker >/dev/null 2>&1 || true
for _ in $(seq 1 60); do docker info >/dev/null 2>&1 && break; sleep 2; done

# The image: the one `colloq-host runner update` chose last, or else the
# published colloq-server of the version the home runs, which its /api/health
# tells anyone. A machine takes new work only while its runner code is the
# home's (decision 5), so it follows the home rather than a version written
# here: a home updated since the rental needs no new on-start. A home that
# does not answer yet (its tunnel coming up, the relay restarting) is asked
# again for five minutes before the boot gives up. COLLOQ_RUNNER_REPO names a
# registry of one's own (a fork's, a mirror's) the way it does for colloq-host,
# which keeps it in runner.env for the updates to come (exported above, it
# reaches colloq-host's `runner up` below). A private one needs a registry
# login that no on-start holds: this file carries no token of any kind.
image="$(head -1 /etc/colloq/runner-image 2>/dev/null || true)"
if [ -z "$image" ]; then
  version=""
  for _ in $(seq 1 30); do
    version="$(curl -sS --max-time 20 "$COLLOQ_RUNNER_URL/api/health" 2>/dev/null \
      | sed -nE 's/.*"version"[[:space:]]*:[[:space:]]*"([0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?)".*/\1/p' | head -1 || true)"
    [ -z "$version" ] || break
    sleep 10
  done
  if [ -z "$version" ]; then
    echo "$COLLOQ_RUNNER_URL did not say which version it runs (GET /api/health); is it up? Reboot to try again."
    exit 1
  fi
  image="${COLLOQ_RUNNER_REPO:-ghcr.io/colloq-edu/colloq-server}:$version"
fi

# The host-side manager lives in the image; install it, then let it do the rest.
docker run --rm -v /usr/local/sbin:/host "$image" install-host /host
exec /usr/local/sbin/colloq-host runner up "$COLLOQ_RUNNER_URL" "$COLLOQ_RUNNER_CODE" "$image"
