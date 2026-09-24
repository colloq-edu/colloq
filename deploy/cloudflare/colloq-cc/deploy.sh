#!/usr/bin/env bash
#
# Deploy the colloq.cc mirror: the worker, the routes, the DNS records.
#
# With plain curl, no wrangler, and that is a choice, not a workaround.
# `npx wrangler` pulls fifty packages from the network and needs a separate
# account login, while the mirror is usually fixed exactly when the network is
# bad anyway, and this repository already has a Cloudflare token: scripts/dns.sh
# lives on it. All the worker needs is three API calls, written out right here.
#
# The script brings the account and the zone to the desired state instead of
# topping them up, like scripts/dns.sh, where the same disease was cured the
# same way. Run it as many times in a row as you like: what matches is left
# alone, what is extra is removed, what is missing is created.
#
#   deploy.sh                what exists and what will be done, then the upload
#   deploy.sh --dry-run      only tell, change nothing
#   deploy.sh --down         remove the mirror entirely (routes, DNS, worker)
#
# The token comes from the repository .env through the same read_env as in
# dns.sh. Either CF_TOKEN_CC (if a separate one was made for .cc) or the shared
# CF_TOKEN will do, as long as it has the rights listed in the README alongside.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/../../.." && pwd)"

# In the same order as in dns.sh: COLLOQ_HOME beats the repository root, since
# for colloq installed through pip .env lies in the state directory, not next
# to the application. Two lines, not an assignment in front of `.`: bash would
# drop the temporary value right after the builtin, and read_env is called
# later.
ENV_FILE="${COLLOQ_HOME:-$ROOT}/.env"
. "$ROOT/scripts/lib.sh"

RED=$'\033[31m'; DIM=$'\033[2m'; OFF=$'\033[0m'
die() { printf '%s%s%s\n' "$RED" "$*" "$OFF" >&2; exit 1; }

DRY=0; DOWN=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    --dry-run|-n) DRY=1 ;;
    --down) DOWN=1 ;;
    -h|--help) sed -n '2,25p' "${BASH_SOURCE[0]}" | sed 's/^#\{1,2\} \{0,1\}//'; exit 0 ;;
    *) die "unknown argument: $1 (see --help)" ;;
  esac
  shift
done

# ------------------------------------------------------ settings from toml
#
# The name, the compatibility date and the routes are read from wrangler.toml
# rather than kept here as a second copy: otherwise a route edit in one file
# would silently drift from the other, and a deploy from another machine would
# return the mirror to the old state.
TOML="$HERE/wrangler.toml"
[[ -f "$TOML" ]] || die "no wrangler.toml next to this script"

NAME=$(sed -nE 's/^name[[:space:]]*=[[:space:]]*"([^"]+)".*/\1/p' "$TOML" | head -1)
COMPAT=$(sed -nE 's/^compatibility_date[[:space:]]*=[[:space:]]*"([^"]+)".*/\1/p' "$TOML" | head -1)
MAIN=$(sed -nE 's/^main[[:space:]]*=[[:space:]]*"([^"]+)".*/\1/p' "$TOML" | head -1)
ZONE_NAME=$(sed -nE 's/^zone_name[[:space:]]*=[[:space:]]*"([^"]+)".*/\1/p' "$TOML" | head -1)
# Through while-read, not mapfile: the stock bash on macOS is 3.2, and it has
# no mapfile at all. The Makefile calls exactly /bin/bash, so everyone would
# run into it.
PATTERNS=()
while read -r p; do [[ -n "$p" ]] && PATTERNS+=("$p"); done < <(
  sed -nE 's/^pattern[[:space:]]*=[[:space:]]*"([^"]+)".*/\1/p' "$TOML")

[[ -n "$NAME" && -n "$COMPAT" && -n "$MAIN" && -n "$ZONE_NAME" && ${#PATTERNS[@]} -gt 0 ]] \
  || die "wrangler.toml is missing name/main/compatibility_date/zone_name/routes"
[[ -f "$HERE/$MAIN" ]] || die "wrangler.toml points at $MAIN, and there is no such file"

# The names that need a DNS record: the routes without "/*". We do not keep
# them as a separate list for the same reason: one source of truth.
HOSTNAMES=()
for p in "${PATTERNS[@]}"; do HOSTNAMES+=("${p%%/*}"); done

# ---------------------------------------------------------------- access

if [[ -z "${CF_TOKEN_CC:-}" ]]; then CF_TOKEN_CC=$(read_env CF_TOKEN_CC); fi
if [[ -z "$CF_TOKEN_CC" ]]; then CF_TOKEN_CC="${CF_TOKEN:-}"; fi
if [[ -z "$CF_TOKEN_CC" ]]; then CF_TOKEN_CC=$(read_env CF_TOKEN); fi
: "${CF_TOKEN_CC:?a Cloudflare token is needed: CF_TOKEN_CC or CF_TOKEN in .env (see README.md for the permissions)}"

API=https://api.cloudflare.com/client/v4

# The token does not get into the argv of ANY process: printf is a bash
# builtin, no separate process is started for it, and curl reads the header
# from its config file on stdin. With `-H "Authorization: …"` it would be
# visible in `ps` to anyone on the machine, CI logs included.
api() {
  local method=$1 path=$2; shift 2
  printf 'header = "Authorization: Bearer %s"\n' "$CF_TOKEN_CC" \
    | curl -sS -K - -X "$method" "$API$path" "$@"
}

# The Cloudflare response is always checked, not thrown into /dev/null.
# Without that, "created" would be printed even when permissions were missing,
# and one would find out from a site that does not open.
check() {
  local resp=$1 what=$2
  if ! printf '%s' "$resp" | python3 -c 'import json,sys; sys.exit(0 if json.load(sys.stdin).get("success") else 1)' 2>/dev/null; then
    printf '%s\n' "$resp" | python3 -c '
import json, sys
try:
    errs = json.load(sys.stdin).get("errors") or []
    for e in errs:
        print("  cloudflare:", e.get("code"), e.get("message"))
except Exception:
    pass' >&2 || printf '%s\n' "$resp" | head -c 400 >&2
    die "$what"
  fi
}

# -------------------------------------------------------------- which zone

ZONE_ID="${CF_ZONE_CC:-$(read_env CF_ZONE_CC)}"
ZONE_JSON=""
if [[ -z "$ZONE_ID" ]]; then
  ZONE_JSON=$(api GET "/zones?name=$ZONE_NAME")
  check "$ZONE_JSON" "this token cannot list zones (Zone: Read is missing)"
  ZONE_ID=$(printf '%s' "$ZONE_JSON" | python3 -c '
import json,sys
z = (json.load(sys.stdin).get("result") or [None])[0]
print(z["id"] if z else "")')
else
  ZONE_JSON=$(api GET "/zones/$ZONE_ID")
  check "$ZONE_JSON" "this token cannot read the zone $ZONE_NAME"
fi
[[ -n "$ZONE_ID" ]] || die "the zone ${ZONE_NAME} is not visible to this token.
  Either it is not in this Cloudflare account, or the token has no Zone: Read on it.
  See README.md, section \"Token permissions\"."

# The account is taken FROM THE ZONE, not from CF_ACCOUNT_ID in .env: the
# worker must live in the same account the zone belongs to, otherwise the
# route in it will not find anything to attach to. CF_ACCOUNT_ID in .env was
# set up for colloq.ru, and here it would be not a hint but a way to upload the
# worker to the wrong place.
read -r ACCOUNT_ID ZONE_STATUS < <(printf '%s' "$ZONE_JSON" | python3 -c '
import json,sys
d = json.load(sys.stdin).get("result")
z = d[0] if isinstance(d, list) else d
print((z.get("account") or {}).get("id", ""), z.get("status", "?"))')
[[ -n "$ACCOUNT_ID" ]] || die "the API did not say which account owns ${ZONE_NAME}"

printf 'zone %s: %s (%s), account %s\n' "$ZONE_NAME" "${ZONE_ID:0:8}…" "$ZONE_STATUS" "${ACCOUNT_ID:0:8}…"
if [[ "$ZONE_STATUS" != active ]]; then
  printf '%s  the zone is not active: until the delegation arrives, the mirror will not open%s\n' "$DIM" "$OFF"
fi

# ---------------------------------------------------------------- remove

if (( DOWN )); then
  echo "removing the mirror:"
  routes=$(api GET "/zones/$ZONE_ID/workers/routes"); check "$routes" "cannot list worker routes"
  while read -r id pattern; do
    [[ -n "${id:-}" ]] || continue
    if (( DRY )); then printf '  would remove route  %s\n' "$pattern"; continue; fi
    check "$(api DELETE "/zones/$ZONE_ID/workers/routes/$id")" "cannot remove route $pattern"
    printf '  removed   route     %s\n' "$pattern"
  done < <(printf '%s' "$routes" | NAME="$NAME" python3 -c '
import json,os,sys
for r in json.load(sys.stdin).get("result") or []:
    if r.get("script") == os.environ["NAME"]:
        print(r["id"], r["pattern"])')

  records=$(api GET "/zones/$ZONE_ID/dns_records?per_page=200"); check "$records" "cannot list dns records"
  while read -r id type name; do
    [[ -n "${id:-}" ]] || continue
    if (( DRY )); then printf '  would remove dns    %-5s %s\n' "$type" "$name"; continue; fi
    check "$(api DELETE "/zones/$ZONE_ID/dns_records/$id")" "cannot remove $type $name"
    printf '  removed   dns       %-5s %s\n' "$type" "$name"
  done < <(printf '%s' "$records" | HOSTS="${HOSTNAMES[*]}" python3 -c '
import json,os,sys
hosts = set(os.environ["HOSTS"].split())
for r in json.load(sys.stdin).get("result") or []:
    if r["type"] == "AAAA" and r["name"] in hosts and r["content"] in ("100::", "100:0:0:0:0:0:0:0"):
        print(r["id"], r["type"], r["name"])')

  if (( DRY )); then printf '  would remove worker %s\n' "$NAME"; else
    check "$(api DELETE "/accounts/$ACCOUNT_ID/workers/scripts/$NAME?force=true")" "cannot remove the worker $NAME"
    printf '  removed   worker    %s\n' "$NAME"
  fi
  echo
  echo "colloq.ru is untouched: it never went through Cloudflare in the first place."
  exit 0
fi

# ----------------------------------------------------------------- deploy

# 1. The worker. Module format: the metadata names the main module, and the
#    part with the code must be named exactly the same.
existing=$(api GET "/accounts/$ACCOUNT_ID/workers/scripts")
check "$existing" "this token cannot see workers in this account (Account · Workers Scripts: Edit is missing)"
had=$(printf '%s' "$existing" | NAME="$NAME" python3 -c '
import json,os,sys
print("yes" if any(s.get("id") == os.environ["NAME"] for s in json.load(sys.stdin).get("result") or []) else "no")')

if (( DRY )); then
  printf '  would upload worker %s (%s, compat %s, %s bytes) — %s\n' \
    "$NAME" "$MAIN" "$COMPAT" "$(wc -c < "$HERE/$MAIN" | tr -d ' ')" \
    "$([[ $had == yes ]] && echo 'replacing the existing one' || echo 'new')"
else
  TMP=$(mktemp -d); trap 'rm -rf "$TMP"' EXIT
  printf '{"main_module":"%s","compatibility_date":"%s","bindings":[]}' "$MAIN" "$COMPAT" \
    > "$TMP/metadata.json"
  resp=$(api PUT "/accounts/$ACCOUNT_ID/workers/scripts/$NAME" \
    -F "metadata=<$TMP/metadata.json;type=application/json" \
    -F "$MAIN=@$HERE/$MAIN;type=application/javascript+module")
  check "$resp" "cannot upload the worker $NAME (Account · Workers Scripts: Edit?)"
  printf '  %-9s worker    %s\n' "$([[ $had == yes ]] && echo replaced || echo created)" "$NAME"
fi

# 2. The routes. An existing one with the same pattern is not re-created but
#    edited: deleting and creating anew would mean a window in which the name
#    does not answer.
routes=$(api GET "/zones/$ZONE_ID/workers/routes")
check "$routes" "this token cannot see worker routes in ${ZONE_NAME} (Zone · Workers Routes: Edit is missing)"

for pattern in "${PATTERNS[@]}"; do
  read -r id script < <(printf '%s' "$routes" | PATTERN="$pattern" python3 -c '
import json,os,sys
want = os.environ["PATTERN"]
for r in json.load(sys.stdin).get("result") or []:
    if r.get("pattern") == want:
        print(r["id"], r.get("script") or "-"); break
else:
    print("", "")')
  if [[ -n "${id:-}" && "${script:-}" == "$NAME" ]]; then
    printf '  in place  route     %s -> %s\n' "$pattern" "$NAME"
  elif [[ -n "${id:-}" ]]; then
    if (( DRY )); then printf '  would repoint route %s: %s -> %s\n' "$pattern" "$script" "$NAME"; continue; fi
    check "$(api PUT "/zones/$ZONE_ID/workers/routes/$id" -H 'content-type: application/json' \
      --data "$(printf '{"pattern":"%s","script":"%s"}' "$pattern" "$NAME")")" \
      "cannot repoint route $pattern"
    printf '  repointed route     %s -> %s\n' "$pattern" "$NAME"
  else
    if (( DRY )); then printf '  would create route  %s -> %s\n' "$pattern" "$NAME"; continue; fi
    check "$(api POST "/zones/$ZONE_ID/workers/routes" -H 'content-type: application/json' \
      --data "$(printf '{"pattern":"%s","script":"%s"}' "$pattern" "$NAME")")" \
      "cannot create route $pattern"
    printf '  created   route     %s -> %s\n' "$pattern" "$NAME"
  fi
done

# 3. DNS. A worker route fires only if the name resolves at all and goes
#    THROUGH Cloudflare, so the apex and www get a proxied placeholder.
#
#    100:: is the discard prefix from RFC 6666, "drop the packet". It is chosen
#    on purpose instead of some real address: if the worker route is ever
#    removed or falls off, the request fails right away instead of quietly
#    going off to someone else's machine. The AAAA type does not leave clients
#    without IPv6 out, either: for a proxied name Cloudflare hands out both A
#    and AAAA of its edge addresses, and only Cloudflare itself sees the record
#    behind the cloud.
#
#    Only A, AAAA and CNAME on these names are touched: MX, TXT and everything
#    mail lives on stay in place. Otherwise the very first run would wipe out
#    the domain's mail.
records=$(api GET "/zones/$ZONE_ID/dns_records?per_page=200")
check "$records" "this token cannot see DNS in ${ZONE_NAME} (Zone · DNS: Edit is missing)"

for host in "${HOSTNAMES[@]}"; do
  keep=""
  while read -r id type content proxied; do
    [[ -n "${id:-}" ]] || continue
    if [[ "$type" == AAAA && "$content" == "100::" && "$proxied" == 1 && -z "$keep" ]]; then
      keep=$id
      printf '  in place  dns       AAAA  %-16s -> 100:: (proxied)\n' "$host"
      continue
    fi
    if (( DRY )); then printf '  would remove dns    %-5s %-16s -> %s\n' "$type" "$host" "$content"; continue; fi
    check "$(api DELETE "/zones/$ZONE_ID/dns_records/$id")" "cannot remove $type $host"
    printf '  removed   dns       %-5s %-16s -> %s%s\n' "$type" "$host" "$content" \
      "$([[ $proxied == 1 ]] && echo ' (was proxied)')"
  done < <(printf '%s' "$records" | HOST="$host" python3 -c '
import json,os,sys
host = os.environ["HOST"]
for r in json.load(sys.stdin).get("result") or []:
    if r["name"] == host and r["type"] in ("A", "AAAA", "CNAME"):
        print(r["id"], r["type"], r["content"], int(bool(r.get("proxied"))))')

  [[ -z "$keep" ]] || continue
  if (( DRY )); then printf '  would create dns    AAAA  %-16s -> 100:: (proxied)\n' "$host"; continue; fi
  # ttl 1 means "automatic"; a proxied record accepts no other ttl.
  check "$(api POST "/zones/$ZONE_ID/dns_records" -H 'content-type: application/json' \
    --data "$(printf '{"type":"AAAA","name":"%s","content":"100::","ttl":1,"proxied":true}' "$host")")" \
    "cannot create the placeholder AAAA for $host"
  printf '  created   dns       AAAA  %-16s -> 100:: (proxied)\n' "$host"
done

echo
if (( DRY )); then
  echo "dry run: nothing was changed."
  exit 0
fi
cat <<EOF
done. Check it (give the edge a minute to pick the route up):

  curl -sI https://${HOSTNAMES[0]}/            | grep -iE 'HTTP|x-colloq-mirror|cache-control'
  curl -sI https://${HOSTNAMES[0]}/docs        | grep -i location     # -> https://${HOSTNAMES[0]}/docs/
  curl -sI https://www.${HOSTNAMES[0]}/docs/   | grep -i location     # -> apex
  curl -s  -o /dev/null -w '%{http_code}\\n' -X POST https://${HOSTNAMES[0]}/   # -> 405

colloq.ru is not touched by any of this: it stays grey-clouded, straight on
GitHub Pages, because Cloudflare's addresses do not open from Russia.
EOF
