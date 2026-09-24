#!/usr/bin/env bash
#
# Set up a permanent address for seminars, once.
#
# A quick tunnel (make host) hands out a random name like
# https://calm-fox-rides.trycloudflare.com, and a new one on every run. For a
# single class that is fine, but last week's link cannot be reopened, and it
# cannot go into the timetable. A permanent address is set up once and stays.
#
#     ./scripts/tunnel-setup.sh seminar.example.org
#
# After that, `make host HOST=seminar.example.org` always brings up this address.
#
set -euo pipefail

cd "$(dirname "$0")/.."

RED=$'\033[31m'; DIM=$'\033[2m'; BOLD=$'\033[1m'; CYAN=$'\033[36m'; OFF=$'\033[0m'
say() { printf '%s\n' "$*"; }
die() { printf '%s%s%s\n' "$RED" "$*" "$OFF" >&2; exit 1; }

HOSTNAME_ARG="${1:-}"
[ -n "$HOSTNAME_ARG" ] || die "Give the address: ./scripts/tunnel-setup.sh seminar.example.org"

command -v cloudflared >/dev/null 2>&1 || die \
  "cloudflared is not installed. brew install cloudflared — and run this again."

TUNNEL="${COLLOQ_TUNNEL_NAME:-colloq}"

# The login leaves ~/.cloudflared/cert.pem — the certificate that entitles
# cloudflared to create tunnels and write DNS in your zone. It is not the same
# token as CF_TOKEN in .env: that one is issued for DNS records only and cannot
# create a tunnel.
if [ ! -f "$HOME/.cloudflared/cert.pem" ]; then
  say "${BOLD}1/3${OFF} a Cloudflare login is needed — a browser will open"
  say "${DIM}    pick the zone that ${HOSTNAME_ARG} belongs to${OFF}"
  cloudflared tunnel login
else
  say "${BOLD}1/3${OFF} already logged in to Cloudflare"
fi

say "${BOLD}2/3${OFF} tunnel \"${TUNNEL}\""
if cloudflared tunnel list 2>/dev/null | awk '{print $2}' | grep -qx "$TUNNEL"; then
  say "${DIM}    already exists, not creating it again${OFF}"
else
  cloudflared tunnel create "$TUNNEL"
fi

# route dns creates CNAME <hostname> -> <tunnel-id>.cfargotunnel.com.
# If the record already exists and points elsewhere, Cloudflare refuses — this
# keeps a tunnel from silently taking over somebody else's subdomain.
say "${BOLD}3/3${OFF} address ${HOSTNAME_ARG}"
#
# A failure here is a failure, not "Done".
#
# The status used to come from grep at the end of the pipeline: any cloudflared
# error — the zone is not in the account, cert.pem is for another zone, no
# permission, the network — did not match the words "already exists", the
# branch was skipped, and the script printed "Done. From now on the seminar
# comes up with: make host HOST=…". There was no record, and people found out
# in class: `make host` waits a minute and talks about the network's DNS.
#
if out="$(cloudflared tunnel route dns "$TUNNEL" "$HOSTNAME_ARG" 2>&1)"; then
  printf '%s\n' "$out"
else
  printf '%s\n' "$out" >&2
  printf '%s' "$out" | grep -qi 'already exists' \
    || die "could not create the DNS record for ${HOSTNAME_ARG} — see the error above."
  say "${DIM}    the record was already there — leaving it as it is${OFF}"
fi

printf '\n'
say "${BOLD}Done.${OFF} From now on the seminar comes up with:"
say "  ${CYAN}make host HOST=${HOSTNAME_ARG}${OFF}"
printf '\n'
say "${DIM}The permanent address is worth putting in the timetable: unlike a quick${OFF}"
say "${DIM}tunnel, it does not change between classes.${OFF}"
