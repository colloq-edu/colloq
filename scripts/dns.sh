#!/usr/bin/env bash
#
# DNS records for colloq.ru.
#
# The script brings the zone to the required shape instead of topping it up
# with records. The difference is not cosmetic: the domain came from Reg.ru
# with parking A records, and if you simply add the GitHub Pages addresses next
# to them, a visitor lands now on the site, now on the placeholder: round-robin
# will honestly hand out both. So for each "type + name" pair the extra is
# deleted, the missing is created, the matching is left alone, and this can be
# run any number of times in a row.
#
# The main point of it all: **grey cloud everywhere**. Orange means that the
# visitor goes to Cloudflare's edge addresses, and those do not open from
# Russia: the landing page on colloq.sleep3r.ru did not load right up to the
# day proxying was taken off it. The colloq.ru apex came proxied, and that is
# fixed here.
#
# The token is taken from the .env of the main repository; it needs Zone:Read
# and DNS:Edit on the colloq.ru zone.
#
# There are two entry points:
#
#   scripts/dns.sh                         bring the whole zone into shape:
#                                          landing page, www and *.colloq.ru to the relay
#   scripts/dns.sh point <name> <address>  one A record: name → machine address
#
# The second did not appear for convenience. The direct mode `make host-direct`
# calls it: a machine with a public address takes the class itself, and its
# name must point at it, not at the relay. host.sh has no copy of this logic on
# purpose: "delete the extra, create the missing, never leave proxying on" is
# written here once and is fixed here too.
set -euo pipefail
cd "$(dirname "$0")"

# The mode is parsed before everything else: in point mode neither the landing
# page, nor www, nor the wildcard is touched at all; otherwise `make
# host-direct` in the middle of a class would rewrite records it was not asked
# about.
MODE=zone
if [[ "${1:-}" == point ]]; then
  MODE=point
  POINT_NAME=${2:?scripts/dns.sh point <name> <address>}
  POINT_ADDR=${3:?scripts/dns.sh point <name> <address>}
fi

# ../.env, not ../colloq/.env: the script came from a neighbouring repository,
# where the main clone lay next to it. Here it lies one level up, and the old
# path did not exist in any clone: instead of "no file" a person read "a token
# with Zone:Read is needed" and went off to check the permissions of a token
# that had been lying in .env all along.
#
# The file is read by the shared read_env (scripts/lib.sh), the same one that
# host.sh, service.sh and vast.sh rely on.
#
# Two lines, not `ENV_FILE=../.env . ./lib.sh`: bash treats an assignment in
# front of a builtin as temporary and removes it on return, while read_env is
# called later and by then needs the real settings file.
#
# COLLOQ_HOME wins over "one level up": for colloq installed through pip, one
# level up holds only the application directory (read-only and wiped by an
# update), while the .env with CF_TOKEN is in the state directory. Without the
# variable everything is as before: ../.env, that is, the repository root.
ENV_FILE="${COLLOQ_HOME:-..}/.env"
. ./lib.sh

DOMAIN=${DOMAIN:-colloq.ru}
# Where the seminars point. The same address as RELAY_ADDR on the instances,
# and it is taken from the same place: from .env, not from a hard-coded string.
#
# The hard-coded default here was a trap: the script did not read RELAY_ADDR
# from .env at all, and after the relay moved, any run to "put the zone in
# order" (and that is the only way to get a name back after host-direct)
# silently returned `*.colloq.ru` to the old address, that is, sent every
# seminar to a dead machine. No address, no record: this is said out loud
# below.
RELAY="${RELAY_ADDR:-$(read_env RELAY_ADDR)}"
# Whose page on GitHub Pages: the CNAME target for www.
PAGES_HOST=${PAGES_HOST:-colloq-edu.github.io}

if [[ -z "${CF_TOKEN_COLLOQ:-}" ]]; then
  # `|| true` inside read_env: the file exists but has no such line; that is
  # "a token is needed", not a silent exit via set -e without a single word on
  # the screen.
  CF_TOKEN_COLLOQ=$(read_env CF_TOKEN)
fi
: "${CF_TOKEN_COLLOQ:?a token with Zone:Read and DNS:Edit on ${DOMAIN} is needed}"

# The zone ID lies in the same .env, on the line next to the token, but it was
# read only from the environment. Because of that it was never used: the zone
# was looked up with a request, and to a token without the right to list zones
# the script answered "this token cannot see the zone", while its id was right
# at hand.
if [[ -z "${CF_ZONE_COLLOQ:-}" ]]; then
  CF_ZONE_COLLOQ=$(read_env CF_ZONE)
fi

API=https://api.cloudflare.com/client/v4
AUTH=(-H "Authorization: Bearer $CF_TOKEN_COLLOQ" -H "content-type: application/json")

RED=$'\033[31m'; OFF=$'\033[0m'
die() { printf '%s%s%s\n' "$RED" "$*" "$OFF" >&2; exit 1; }

# zone_id_for NAME: which zone this name lives in.
#
# Asking `?name=hse.colloq.ru` is useless: there is no such zone, and
# Cloudflare answers that not with an error but with an empty list. So the
# token's list of zones is taken, and from it the longest one that the
# requested name ends with: for hse.colloq.ru that is colloq.ru, and the same
# rule works for someone else's zone, if one day an instance stands outside
# colloq.ru.
#
# And no status parameter. Its allowed values are active, pending and the
# like; "all" is not among them, and Cloudflare again does not complain about
# it but silently returns an empty list. You can lose an hour on this,
# deciding that the token has no access.
zone_id_for() {
  local want=$1 id=""
  # An explicitly named zone wins over the search, but only if it is that very
  # zone: CF_ZONE of colloq.ru for a name in someone else's zone is not a hint
  # but a mistake that writes the record in the wrong place.
  if [[ -n "${CF_ZONE_COLLOQ:-}" && ( "$want" == "$DOMAIN" || "$want" == *".$DOMAIN" ) ]]; then
    printf '%s' "$CF_ZONE_COLLOQ"
    return 0
  fi
  id=$(curl -s "${AUTH[@]}" "$API/zones?per_page=200" | WANT="$want" python3 -c '
import json, os, sys
want = os.environ["WANT"]
best = best_id = ""
try:
    zones = json.load(sys.stdin).get("result") or []
except Exception:
    zones = []
for z in zones:
    name = z.get("name") or ""
    if (want == name or want.endswith("." + name)) and len(name) > len(best):
        best, best_id = name, z.get("id") or ""
print(best_id)' 2>/dev/null || true)
  printf '%s' "$id"
}

fetch() { curl -s "${AUTH[@]}" "$API/zones/$zone/dns_records?per_page=200"; }

# reconcile TYPE NAME [CONTENT...]
#
# Brings all records of the given type with the given name to exactly the
# listed set. An empty list means "there must be no such records": that is how
# www gets rid of the parking A before becoming a CNAME, since Cloudflare will
# not let a CNAME sit next to an A on the same name.
reconcile() {
  local type=$1 name=$2; shift 2
  local want=("$@")
  local records id content proxied keep w

  records=$(fetch)
  while read -r id content proxied; do
    [[ -n "${id:-}" ]] || continue
    keep=0
    # A proxied record must not be kept even with the right address: the orange
    # cloud is exactly what keeps the site from opening.
    for w in ${want[@]+"${want[@]}"}; do
      [[ "$content" == "$w" && "$proxied" == "0" ]] && keep=1
    done
    if (( keep == 0 )); then
      curl -s -X DELETE "${AUTH[@]}" "$API/zones/$zone/dns_records/$id" >/dev/null
      printf '  removed   %-5s %-16s -> %s%s\n' "$type" "$name" "$content" \
        "$([[ $proxied == 1 ]] && echo ' (was proxied)')"
    fi
  done < <(printf '%s' "$records" | python3 -c "
import json,sys
for r in json.load(sys.stdin)['result']:
    if r['type']=='$type' and r['name']=='$name':
        print(r['id'], r['content'], int(bool(r.get('proxied'))))")

  [[ ${#want[@]} -gt 0 ]] || return 0

  local have
  have=$(fetch | python3 -c "
import json,sys
print(' '.join(r['content'] for r in json.load(sys.stdin)['result']
      if r['type']=='$type' and r['name']=='$name' and not r.get('proxied')))")

  local resp
  for w in "${want[@]}"; do
    if [[ " $have " == *" $w "* ]]; then
      printf '  in place  %-5s %-16s -> %s\n' "$type" "$name" "$w"
      continue
    fi
    resp=$(curl -s -X POST "${AUTH[@]}" "$API/zones/$zone/dns_records" \
      --data "$(printf '{"type":"%s","name":"%s","content":"%s","ttl":300,"proxied":false}' \
                "$type" "$name" "$w")")
    # The response is checked, not thrown away. It used to go to /dev/null, and
    # the "created" line was printed even when Cloudflare refused, usually
    # because of a CNAME on the same name or a token without DNS:Edit. For the
    # zone that meant "the site somehow did not open", and for the direct mode,
    # a machine waiting for a certificate for a name that points nowhere.
    if [[ "$resp" == *'"success":true'* || "$resp" == *'"success": true'* ]]; then
      printf '  created   %-5s %-16s -> %s\n' "$type" "$name" "$w"
    else
      printf '%s\n' "$resp" | head -c 400 >&2; printf '\n' >&2
      die "Cloudflare did not create ${type} ${name} -> ${w}"
    fi
  done
}

# ------------------------------------------------------------- what we do

# One record: name → machine address. Nothing else in the zone is touched.
if [[ "$MODE" == point ]]; then
  zone=$(zone_id_for "$POINT_NAME")
  [[ -n "$zone" ]] || die "this token cannot see the zone for ${POINT_NAME} (CF_TOKEN, CF_ZONE in .env)"
  # First remove the CNAME from this name, then set the A, for exactly the same
  # reason as with www below: Cloudflare does not let them sit side by side.
  # The case is not made up: a name once created by `make tunnel-setup` holds a
  # CNAME to <id>.cfargotunnel.com, and without this line the direct mode would
  # fail on it, citing a record conflict.
  reconcile CNAME "$POINT_NAME"
  # No proxying: that is the main and only thing here. The orange cloud would
  # take the students to Cloudflare's edge addresses, and those do not open
  # from Russia: the seminar would become unreachable for exactly the audience
  # it is exposed for. The whole value of direct mode is that there is nobody
  # between the machine and the room; proxying would bring back a middleman,
  # and a blocked one at that.
  reconcile A "$POINT_NAME" "$POINT_ADDR"
  exit 0
fi

# The relay address is checked before the first change to the zone, not right
# before the wildcard: the landing page and www are put in order before it, and
# a refusal halfway would leave the zone half rewritten.
[[ -n "$RELAY" ]] || die "I do not know where to point *.${DOMAIN}: ../.env has no RELAY_ADDR.
  That is the address of the relay (make relay-setup prints it). For one run it
  can also be named like this: RELAY_ADDR=1.2.3.4 scripts/dns.sh"

zone=$(zone_id_for "$DOMAIN")
[[ -n "$zone" ]] || die "this token cannot see the zone ${DOMAIN}"
echo "zone ${DOMAIN}: $zone"

echo "landing page on GitHub Pages:"
reconcile A "$DOMAIN" 185.199.108.153 185.199.109.153 185.199.110.153 185.199.111.153
# Without AAAA a visitor on pure IPv6 cannot open the site at all.
reconcile AAAA "$DOMAIN" 2606:50c0:8000::153 2606:50c0:8001::153 2606:50c0:8002::153 2606:50c0:8003::153
# First remove the parking A from www, then set the CNAME, otherwise Cloudflare
# refuses: a CNAME and an A cannot live together on one name.
reconcile A "www.$DOMAIN"
reconcile CNAME "www.$DOMAIN" "$PAGES_HOST"

echo "classes on the relay:"
# One wildcard, not a name per university: subdomains are handed out by frps
# on a shared secret, and a DNS record for each would mean hand-cranked
# self-service.
reconcile A "*.$DOMAIN" "$RELAY"

echo
echo "done. Next:"
echo "  1. push the landing page: CNAME in the repository already points at ${DOMAIN}"
echo "  2. wait for the Pages certificate on ${DOMAIN}"
echo "  3. check from a phone WITHOUT a VPN: https://${DOMAIN}"
echo "  4. publish a class:  make host HOST=hse.${DOMAIN}"
