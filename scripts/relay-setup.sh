#!/usr/bin/env bash
#
# The relay for *.colloq.ru — what Colloq uses instead of Cloudflare Tunnel.
#
# Why at all. A Cloudflare tunnel always ends at Cloudflare's edge addresses: a
# record like *.cfargotunnel.com only makes sense for their proxy, and the
# orange cloud cannot be taken off it. And those addresses do not open from
# Russia — the landing page on colloq.sleep3r.ru did not load right up to the
# day proxying was taken off it. So a seminar exposed through Cloudflare is out
# of reach for the very audience it is made for.
#
# Everything else follows from that. We need an entrance of our own: a machine
# with a public address that Russian networks reach, DNS without proxying, and
# a way to reach an instance that itself sits behind NAT — in a classroom, on
# the teacher's laptop.
#
# Two daemons here and nothing more:
#
#   caddy  holds 443, issues certificates and passes the request on by host
#          name. A certificate is taken on demand, on the first request to a
#          name, rather than as one wildcard for everything: that way this
#          machine does not need to keep a DNS key, and compromising the box
#          does not hand over a certificate for all seminars at once.
#
#   frps   accepts outgoing connections from instances and hands out
#          subdomains to them. An instance needs neither a public address nor
#          an open port — it calls here itself.
#
# And one file next to them — the waiting page (scripts/relay-offline.html).
# Until the teacher has brought up the room, there is no live client for its
# name, and frps would answer with its built-in page: "The page you requested
# was not found… powered by frp". A student who came ten minutes before class
# could tell from it neither what happened nor what to do. Instead
# /etc/colloq-relay/offline.html is served — it is also shown when frps itself
# does not answer, and it reloads itself, so whoever is waiting gets into the
# room without a single click.
#
# The waiting page is home to a pixel capybara (a game in the spirit of
# Chrome's dinosaur) with a shared high-score table. The table is kept by a
# third, tiny daemon — colloq-capy (scripts/relay-capy.py, python3 out of the
# box): caddy hands it the path /.relay/capy/* on any name. The game works
# without it, the table does not.
#
# And a fourth daemon — colloq-assets (scripts/relay-assets.py), a mirror of
# the immutable static files. Before it, EVERY byte of every /assets/*,
# /fonts/* and /pdf/* travelled through the tunnel from the teacher's laptop —
# 598 KB compressed for every arrival, over the same channel the room's
# sockets live on. The files are the same for everyone (names in assets/
# contain a content hash), so the instance puts them here as one archive on
# `make host`, and caddy serves them straight from
# /var/lib/colloq-assets/<name>. A mirror miss is not a failure: the `file`
# matcher lets such a request through to the tunnel, as before.
#
# And one more directory — /etc/caddy/names, the memory of names. A
# certificate is issued only to a name that has a tunnel, and frps keeps its
# list of tunnels in memory: after it restarts or moves to another machine the
# list is empty, and a student who opened the usual class address before the
# class started would get a TLS refusal instead of the waiting page. So once a
# minute a timer copies the names from frps into files in this directory, and
# a name that has been up even once is remembered forever. To add a name in
# advance: touch /etc/caddy/names/<name>.colloq.ru.
#
# Run: scripts/relay-setup.sh root@203.0.113.10
# Only the page: scripts/relay-setup.sh --page root@203.0.113.10
set -euo pipefail

# The mode. A full install takes minutes and touches packages, services and
# configs — there is no reason to run it to fix one paragraph of the text for
# students, so the script has a second entry that writes only the page. The
# flag is parsed before the address: otherwise `--page` would end up in HOST
# and the script would go installing caddy on a machine by that name.
PAGE_ONLY=0
if [ "${1:-}" = "--page" ]; then PAGE_ONLY=1; shift; fi

HOST=${1:?give the target machine: scripts/relay-setup.sh root@203.0.113.10}
DOMAIN=${DOMAIN:-colloq.ru}
FRP_VERSION=${FRP_VERSION:-0.71.0}
# The key is named explicitly: ~/.ssh usually holds a dozen of them, sshd cuts
# the attempt off after the fifth, and the right one is never reached.
SSH_KEY=${SSH_KEY:-$HOME/.ssh/id_ed25519}
SSH=(ssh -o IdentitiesOnly=yes -i "$SSH_KEY")
# The page and the score service lie next to the script and are embedded into
# the remote stream as base64: that way their text — JS with dollars and
# backticks — goes through no bash substitution, neither here nor on the
# machine.
HERE=$(cd "$(dirname "$0")" && pwd)

# A certificate for the whole wildcard — optional: RELAY_WILDCARD=1 and
# CF_TOKEN (the same as for scripts/dns.sh; from the environment or from the
# .env next to the repository).
#
# Without it a name the relay has never seen gets no certificate at all: the
# ask endpoint answers 403, and the browser shows a TLS error before any page
# — the "no such room" state is written but unreachable. With the wildcard any
# name under the zone gets working TLS through Cloudflare's DNS challenge, and
# both the Let's Encrypt ceiling of 50 names a week and issuance depending on
# port 80 go away. The price: the Cloudflare token lives on the relay, one key
# serves all names, and updating caddy past this script (apt, caddy upgrade)
# drops the dns.providers.cloudflare module — caddy then does not start at
# all; running the script again fixes that.
WILDCARD=${RELAY_WILDCARD:-0}
CF_TOKEN=${CF_TOKEN:-$(grep -E '^CF_TOKEN=' "$HERE/../.env" 2>/dev/null | tail -1 | cut -d= -f2- | tr -d ' "' || true)}
if [ "$WILDCARD" = 1 ] && [ -z "$CF_TOKEN" ]; then
  die "RELAY_WILDCARD=1 needs CF_TOKEN (Zone:DNS:Edit on the ${DOMAIN} zone) — in the environment or in .env."
fi
PAGE_FILE=$HERE/relay-offline.html
CAPY_FILE=$HERE/relay-capy.py
ASSETS_FILE=$HERE/relay-assets.py
[ -f "$PAGE_FILE" ] || { printf '\033[31mno %s\033[0m\n' "$PAGE_FILE" >&2; exit 1; }
[ -f "$CAPY_FILE" ] || { printf '\033[31mno %s\033[0m\n' "$CAPY_FILE" >&2; exit 1; }
[ -f "$ASSETS_FILE" ] || { printf '\033[31mno %s\033[0m\n' "$ASSETS_FILE" >&2; exit 1; }
embed() { base64 < "$1" | fold -w 76; }

RED=$'\033[31m'; OFF=$'\033[0m'
say() { printf '\033[1m%s\033[0m\n' "$*"; }
die() { printf '%s%s%s\n' "$RED" "$*" "$OFF" >&2; exit 1; }

# --------------------------------------------------------------- the page
#
# The piece of the remote script that puts the page in place. A separate
# function, because it is needed in two places: in the full install and in
# `--page`. The function prints the text to stdout, and the caller pours it
# into the common stream for `bash -s`. The page itself is
# scripts/relay-offline.html, one file for both modes, so there is nowhere for
# them to drift apart.
relay_page() {
  cat <<'SNIPPET'
echo "== waiting page"
[ -d /etc/colloq-relay ] || { echo "no /etc/colloq-relay — run the full install first"; exit 1; }
[ -d /etc/caddy ]        || { echo "no /etc/caddy — run the full install first"; exit 1; }

# Two copies of one file, and that is not sloppiness. The page is served
# sometimes by frps (when a name has no client), sometimes by caddy (when frps
# itself does not answer), and the daemons run as different users and are
# locked into their own directories. One shared file would mean either caddy
# in the frps group — that is, the right to read all of /etc/colloq-relay,
# the shared secret included — or a page open to the whole machine. It is
# cheaper to put the same text down twice: it is written from here anyway.
page_tmp=$(mktemp)
base64 -d > "$page_tmp" <<'PAGE_B64'
SNIPPET
  embed "$PAGE_FILE"
  cat <<'SNIPPET'
PAGE_B64

# Permissions like the neighbours' in the directory: owner root, the daemon's
# group, read for the group. The daemon reads the file but cannot rewrite it —
# only this script does that, as root.
install -o root -g frps  -m 0640 "$page_tmp" /etc/colloq-relay/offline.html
install -o root -g caddy -m 0640 "$page_tmp" /etc/caddy/offline.html
rm -f "$page_tmp"
SNIPPET
}

# -------------------------------------------------------------- the page only
#
# The quick path: the page and nothing else.
if [ "$PAGE_ONLY" = 1 ]; then
  say "updating the waiting page on $HOST"
  {
    echo 'set -euo pipefail'
    relay_page
    cat <<'CHECK'

# There is nothing to restart, and that is not luck but a property of both
# readers of the file: frps opens it on every 404 answer
# (getNotFoundPageContent does os.ReadFile), caddy's file_server on every
# request. The new text is visible from the very next request.
#
# On a relay installed before the page existed, though, the file would land in
# place with nobody to show it: the configs have not a single line about it.
# That cannot be kept quiet — from outside it looks like "the page did not
# update".
if ! grep -q 'custom404Page' /etc/colloq-relay/frps.toml 2>/dev/null ||
   ! grep -q 'offline.html' /etc/caddy/Caddyfile 2>/dev/null ||
   ! grep -q '/.relay/capy/' /etc/caddy/Caddyfile 2>/dev/null ||
   ! grep -q '/.relay/state' /etc/caddy/Caddyfile 2>/dev/null; then
  echo
  echo "WARNING: the configs do not know about this page yet."
  echo "Run the full install once: make relay-setup WHERE=..."
fi
CHECK
  } | "${SSH[@]}" "$HOST" 'bash -s' || die "could not update the page on $HOST"
  say "done — the new text shows from the next request, nothing to restart"
  exit 0
fi

# ---------------------------------------------------------- the full install

say "installing the relay on $HOST for *.${DOMAIN}"

# The remote script is glued together from three pieces: before the page, the
# page itself and everything after. It is one and the same `bash -s` on the
# other side, so variables (the same TOKEN) survive the gluing — the pieces are
# not separate sessions but parts of one text.
{
# The first lines of the remote script come from local variables. Through the
# stream, not through the ssh command's environment: the command line is
# visible to the whole machine in ps, and a Cloudflare token may be here.
printf 'WILDCARD=%q\nCF_TOKEN=%q\n' "$WILDCARD" "$CF_TOKEN"
cat <<'REMOTE_HEAD'
set -euo pipefail
export DEBIAN_FRONTEND=noninteractive

echo "== packages"
apt-get update -qq
apt-get install -y -qq curl tar >/dev/null

echo "== swap"
# Two gigabytes on top of 3.9 GB of memory — and not so that the machine works
# in them.
#
# Measured on a live class: two hundred students in one evening, and the
# kernel killed now frps, now caddy, thirty-six times. A kill here is not
# "things got slower" but ALL tunnels breaking at once: for every seminar
# behind this relay the room goes into reconnecting. Swap gives the kernel
# something to give up instead of shooting, and MemoryHigh below throttles
# whoever overreaches before it comes to OOM.
#
# A repeated run does nothing: both the file and the fstab line are checked.
if ! swapon --show=NAME --noheadings 2>/dev/null | grep -qx /swapfile; then
  if [ ! -f /swapfile ]; then
    # fallocate is faster, but on some filesystems it leaves holes, and swapon
    # does not take such a file. Then — an honest dd.
    fallocate -l 2G /swapfile 2>/dev/null || dd if=/dev/zero of=/swapfile bs=1M count=2048 status=none
    chmod 600 /swapfile
    mkswap /swapfile >/dev/null 2>&1 || true
  fi
  if ! swapon /swapfile 2>/dev/null; then
    rm -f /swapfile
    dd if=/dev/zero of=/swapfile bs=1M count=2048 status=none
    chmod 600 /swapfile
    mkswap /swapfile >/dev/null
    swapon /swapfile || echo "could not enable swap — not fatal"
  fi
fi
grep -q '^/swapfile ' /etc/fstab 2>/dev/null || echo '/swapfile none swap sw 0 0' >> /etc/fstab
# For this machine swap is a lifebelt, not a working tool: dipping into it
# early means serving pages to students from disk.
sysctl -qw vm.swappiness=10 || true
grep -q '^vm.swappiness' /etc/sysctl.conf 2>/dev/null || echo 'vm.swappiness=10' >> /etc/sysctl.conf
swapon --show 2>/dev/null | tail -n +1 | sed 's/^/  /'

echo "== caddy"
# A binary built on their side instead of the apt package: no modules are
# needed here (on-demand certificates come through HTTP-01), and one file is
# simpler to update and understand than a repository with a key.
# With the wildcard (WILDCARD=1) the dns.providers.cloudflare module is needed
# — the same build service hands out a binary with it; the check is not "the
# binary exists" but "the module exists", otherwise a machine with an old
# caddy would quietly stay without the DNS challenge.
CADDY_URL="https://caddyserver.com/api/download?os=linux&arch=amd64"
if [ "${WILDCARD:-0}" = 1 ]; then CADDY_URL="${CADDY_URL}&p=github.com/caddy-dns/cloudflare"; fi
if ! command -v caddy >/dev/null \
   || { [ "${WILDCARD:-0}" = 1 ] && ! caddy list-modules 2>/dev/null | grep -q '^dns.providers.cloudflare'; }; then
  curl -fsSL -o /usr/local/bin/caddy.new "${CADDY_URL}"
  chmod +x /usr/local/bin/caddy.new
  mv /usr/local/bin/caddy.new /usr/local/bin/caddy
fi
caddy version | head -1

echo "== frps ${FRP_VERSION}"
if [ ! -x /usr/local/bin/frps ]; then
  tmp=$(mktemp -d)
  curl -fsSL "https://github.com/fatedier/frp/releases/download/v${FRP_VERSION}/frp_${FRP_VERSION}_linux_amd64.tar.gz" \
    | tar -xz -C "$tmp" --strip-components=1
  install -m 0755 "$tmp/frps" /usr/local/bin/frps
  rm -rf "$tmp"
fi
frps --version

echo "== users and directories"
id -u caddy >/dev/null 2>&1 || useradd --system --home /var/lib/caddy --shell /usr/sbin/nologin caddy
id -u frps  >/dev/null 2>&1 || useradd --system --home /var/lib/frps  --shell /usr/sbin/nologin frps
id -u capy  >/dev/null 2>&1 || useradd --system --home /var/lib/colloq-capy --shell /usr/sbin/nologin capy
id -u assets >/dev/null 2>&1 || useradd --system --home /var/lib/colloq-assets --shell /usr/sbin/nologin assets
install -d -o caddy -g caddy -m 0750 /var/lib/caddy /etc/caddy /etc/caddy/names
install -d -o frps  -g frps  -m 0750 /var/lib/frps
# The static mirror is written by one daemon and read by another: owner
# assets, group caddy, and read-only for the group — caddy must not be able to
# rewrite what it serves. Bit 2000 (setgid) is required: without it everything
# the service creates inside gets group assets, and caddy answers 403 on every
# file — that is, the mirror simply does not work, silently and entirely.
install -d -o assets -g caddy -m 2750 /var/lib/colloq-assets
# Group frps, not just root: the daemon does not run as root, and one chown on
# the file is not enough — the directory has to be traversable too.
install -d -o root -g frps -m 0750 /etc/colloq-relay

echo "== shared secret"
# With it an instance proves that it may take a subdomain. Without it anyone
# who knows the address could declare themselves hse.colloq.ru.
if [ ! -s /etc/colloq-relay/token ]; then
  head -c 32 /dev/urandom | base64 | tr -d '/+=' | head -c 40 > /etc/colloq-relay/token
fi
chown root:frps /etc/colloq-relay/token
chmod 640 /etc/colloq-relay/token
TOKEN=$(cat /etc/colloq-relay/token)

echo "== frps config"
cat > /etc/colloq-relay/frps.toml <<CONF
# The control port: instances call here. Open to the outside, protected only
# by the shared secret below.
bindPort = 7000

# The port where frps serves HTTP routed by host name.
vhostHTTPPort = 8080

# It and all the other proxy listeners are on loopback only. What comes into
# them is not a visitor but caddy in front of them, which has already taken TLS
# off; 8080 open to the outside would be a way to reach any seminar around the
# encryption.
proxyBindAddr = "127.0.0.1"

# Subdomains are handed out only under this name: an instance asks for "hse",
# gets hse.${DOMAIN} and cannot ask for anything outside the zone.
subDomainHost = "${DOMAIN}"

# What a student sees when a name has no live client: the instance is off, the
# laptop is closed, the tunnel is not up. Without this line frps serves its
# built-in page — "not found… powered by frp" — from which one can tell neither
# what happened nor what to do.
#
# The field name was checked against the sources of the version the script
# installs (ServerConfig.Custom404Page in pkg/config/v1/server.go, json tag
# custom404Page), not from memory. The check was not a courtesy: the config is
# read in strict mode (--strict_config is on by default), so a typo in the name
# is not "the setting did not apply" but an frps that does not start.
# The path is absolute: the service has no WorkingDirectory, its working
# directory is /.
custom404Page = "/etc/colloq-relay/offline.html"

auth.method = "token"
auth.token = "${TOKEN}"

# How many ready connections an instance is allowed to hold.
#
# The instance asks for a reserve (transport.poolCount in scripts/host.sh), so
# that a student's request does not wait for a connection to be set up before
# the first byte; the server has to name a ceiling, otherwise no reserve is
# granted at all. Ten per instance is dozens of idle connections for the whole
# machine, and on 3.9 GB of memory that is nothing next to a first screen
# without an extra round trip over the network.
transport.maxPoolCount = 10

# The status dashboard — loopback only too; look at it through ssh -L.
webServer.addr = "127.0.0.1"
webServer.port = 7500

log.level = "info"
CONF
chown root:frps /etc/colloq-relay/frps.toml
chmod 640 /etc/colloq-relay/frps.toml

echo "== caddy config"
# The site header: by default "any name on 443" with a certificate on demand;
# with the wildcard, one site *.domain and one certificate via DNS.
if [ "${WILDCARD:-0}" = 1 ]; then
  SITE_LABEL="*.${DOMAIN}"
  SITE_TLS="tls {
		dns cloudflare {env.CF_TOKEN}
		resolvers 1.1.1.1
	}"
else
  SITE_LABEL=":443"
  SITE_TLS="tls {
		on_demand
	}"
fi
# Whose certificate. By default Let's Encrypt, as with caddy out of the box.
# But LE lives behind Cloudflare, and from a machine on Cogent (relay2 in
# Estonia, 12 Sep 2026) Cloudflare is not reachable over IPv4 at all and over
# IPv6 only every other time: Cogent and Cloudflare have a long-standing
# peering dispute. ZeroSSL and Google are open from there. The file
# /etc/colloq-relay/acme.env on the machine (ACME_DIR, ACME_EMAIL,
# ACME_EAB_KID, ACME_EAB_KEY) switches the certificate authority; ZeroSSL
# issues EAB for a single email: POST
# https://api.zerossl.com/acme/eab-credentials-email -d email=… . No file —
# Let's Encrypt.
# The MTU of the outgoing path. On relay2 (Cogent), 1500-byte packets to
# Cloudflare — and Let's Encrypt behind it — go dead: the ICMP "fragment"
# message gets lost on the way, the TLS handshake goes through, and the HTTP
# answer never arrives (12 Sep 2026, found by trial: with mtu 1300 on the
# route LE answers in half a second). The number in /etc/colloq-relay/path-mtu
# is put on the default routes (v4 and v6) by a service on every boot; no file
# — nothing changes. The interface MTU is left alone: it also receives the
# students' frames.
if [ -s /etc/colloq-relay/path-mtu ]; then
  PATH_MTU=$(tr -dc '0-9' < /etc/colloq-relay/path-mtu)
  cat > /usr/local/sbin/colloq-relay-mtu <<'MTU'
#!/bin/sh
# Cap the MTU of the default routes at the number in /etc/colloq-relay/path-mtu.
mtu=$(tr -dc '0-9' < /etc/colloq-relay/path-mtu)
[ -n "$mtu" ] || exit 0
ip -4 route show default | while read -r line; do
  # shellcheck disable=SC2086
  ip -4 route change $line mtu "$mtu"
done
ip -6 route show default | sed 's/ expires [^ ]*//; s/ pref [^ ]*//; s/ nhid [^ ]*//' | while read -r line; do
  # shellcheck disable=SC2086
  ip -6 route change $line mtu "$mtu" 2>/dev/null || true
done
MTU
  chmod 755 /usr/local/sbin/colloq-relay-mtu
  cat > /etc/systemd/system/colloq-relay-mtu.service <<UNIT
[Unit]
Description=path MTU ${PATH_MTU} on default routes for colloq relay
After=network-online.target
Wants=network-online.target

[Service]
Type=oneshot
ExecStart=/usr/local/sbin/colloq-relay-mtu
RemainAfterExit=yes

[Install]
WantedBy=multi-user.target
UNIT
  systemctl daemon-reload
  systemctl enable --now colloq-relay-mtu.service >/dev/null 2>&1 || true
fi

ACME_BLOCK=""
if [ -s /etc/colloq-relay/acme.env ]; then
  # shellcheck disable=SC1091
  . /etc/colloq-relay/acme.env
  ACME_BLOCK="
	email ${ACME_EMAIL}
	cert_issuer acme {
		dir ${ACME_DIR}
		eab ${ACME_EAB_KID} ${ACME_EAB_KEY}
	}"
fi
cat > /etc/caddy/Caddyfile <<CONF
{
	# A certificate is taken on the first request to a name, not in advance for
	# the whole wildcard. The price of that is the question below: without it
	# anyone who points their name at this address would make us issue a
	# certificate for it, and the Let's Encrypt limits would run out in an evening.
	on_demand_tls {
		ask http://127.0.0.1:9180/allow
	}${ACME_BLOCK}
}

# Who deserves a certificate. A separate site on loopback, because caddy asks
# itself for permission over HTTP — no code of our own is needed for it.
http://127.0.0.1:9180 {
	# For caddy an address in the site header is a condition on the name, not
	# where to listen. Without bind it would bring 9180 up on all interfaces, and
	# anyone outside could ask for permission for a certificate.
	bind 127.0.0.1
	# The name arrives in the request as ?domain=hse.colloq.ru. The query matcher
	# compares the value as a whole and does not understand a wildcard inside it —
	# with "query domain=*.${DOMAIN}" the ask endpoint answered 403 even for our
	# own names, and no certificate was issued for anyone at all.
	# So the name is moved into the path, where there is a real regular expression.
	rewrite * /{query.domain}
	@ours path_regexp ours ^/([a-z0-9-]+)\.${DOMAIN//./\\.}$
	# And the name has to be NOT JUST OURS but alive: we ask frps whether it has
	# such a tunnel. 200 — the room is exposed, 404 — no such name.
	#
	# This used to be "any name under our zone", and that was enough for scanners
	# to make the relay order certificates for ftp, shop, analytics and random
	# junk: eighteen names in a day. Let's Encrypt caps it at fifty certificates
	# per domain per week, and hitting that first of all means being left without
	# a certificate for a real seminar in the middle of a class. A name whose
	# tunnel existed once stays allowed: it is supposed to keep renewing while the
	# room is opened again.
	handle @ours {
		# The name memory (see the header): if the file /etc/caddy/names/<name>.${DOMAIN}
		# exists, the certificate is issued, whether the tunnel is alive now or not.
		# The matcher sits inside @ours, not next to it: outside, the path "/" would
		# match the directory itself.
		@known file {
			root /etc/caddy/names
			try_files {path}
		}
		handle @known {
			respond 200
		}
		handle {
			rewrite * /api/proxy/http/{re.ours.1}
			reverse_proxy 127.0.0.1:7500
		}
	}
	handle {
		respond 403
	}
}

# Everything else that arrives on 443 under any name.
${SITE_LABEL} {
	${SITE_TLS}
	# Headers without which the instance would not know at which address it was
	# reached: the seminar link and the socket addresses are built from them.
	# Robots have nothing to do here.
	#
	# A classroom opens by a personal link and lives for hours; it has no place in
	# search. And a domain with hundreds of indexed subdomains looks like a farm
	# from the outside — for that Safe Browsing once flagged the whole of
	# colloq.ru, and students would have seen the red screen on every seminar
	# address. The refusal is given before the tunnel: it is the same for all
	# rooms and does not depend on whether a seminar is up right now.
	#
	# Link unfurlers are allowed. Telegram (which also introduces itself as
	# Twitterbot), WhatsApp, iMessage and Slack read robots.txt and do not build a
	# card without permission: a room link in a chat stayed bare (12 Sep 2026).
	# They index nothing — they only take from <head> the class name and the image
	# that the instance puts there for exactly that
	# (server/src/link-preview.ts).
	handle /robots.txt {
		header Content-Type text/plain
		respond "User-agent: TelegramBot
User-agent: Twitterbot
User-agent: facebookexternalhit
User-agent: Facebot
User-agent: WhatsApp
User-agent: Slackbot-LinkExpanding
User-agent: Discordbot
User-agent: LinkedInBot
Allow: /

User-agent: *
Disallow: /
" 200
	}

	# The scores of the waiting page's game go to the colloq-capy service (see the
	# header). The path starts with a dot: no instance address looks like that, and
	# the route takes nothing away from a room even when it is open.
	handle /.relay/capy/* {
		# A body over 4 KB never reaches python; the client address is the one caddy
		# sees, not what the client wrote in a header itself.
		request_body {
			max_size 4KB
		}
		reverse_proxy 127.0.0.1:9181 {
			header_up X-Forwarded-For {remote_host}
			header_up X-Forwarded-Host {host}
		}
	}

	# Receiving static files from the instance: on \`make host\` it puts its
	# assets/, fonts/ and pdf/ here as one archive (scripts/relay-assets.py). The
	# secret is the same as frps's, and an instance can write only into the mirror
	# of its own name — the service checks the name in the path against the one
	# the request came under.
	handle /.relay/assets/* {
		request_body {
			max_size 64MB
		}
		reverse_proxy 127.0.0.1:9182 {
			header_up X-Forwarded-Host {host}
		}
	}

	# Immutable files come from this machine, not through the teacher's laptop.
	#
	# Names in assets/ contain a content hash, fonts/ and pdf/ change only with a
	# release, and the instance itself serves all of it with a long lifetime. So
	# they can be kept here: 598 KB compressed per student stop travelling through
	# the tunnel, and it is left to what it exists for — the live room.
	#
	# The \`file\` matcher is the whole protection against a stale or empty
	# mirror: no file on disk — the rule does not match, and the request goes on
	# into the tunnel, as it always did. That is why it is \`file\` here and not
	# file_server with pass_thru: a 404 answer from the mirror must get neither
	# headers nor a lifetime.
	#
	# The lifetimes are the same as the instance itself sets (server/src/app.ts): a
	# year and immutable only for versioned files, an hour for fonts and pdf. A
	# font under the same name is replaced by hand, and a year on it is a year in
	# which nobody who comes back sees the replacement.
	@mirror {
		host *.${DOMAIN}
		path /assets/* /fonts/* /pdf/*
		file {
			root /var/lib/colloq-assets/{host}
			try_files {path}
		}
	}
	handle @mirror {
		root * /var/lib/colloq-assets/{host}
		header /assets/* Cache-Control "public, max-age=31536000, immutable"
		header /fonts/* Cache-Control "public, max-age=3600"
		header /pdf/* Cache-Control "public, max-age=3600"
		# So that \`curl -sI\` answers "is the mirror working at all?" with one word
		# rather than a comparison of lengths.
		header X-Colloq-Mirror hit
		file_server {
			precompressed br gzip
		}
	}

	# What the relay knows about this name — for the error page. From this answer
	# it tells "the room is not open yet" from "no such room" and from "Colloq on
	# the teacher's machine is silent": frps gives all three the same 404 without a
	# single distinguishing sign, and from outside they cannot be told apart at all.
	#
	# known — the name memory file exists, that is, the room was opened here at
	# some point; tunnel — the tunnel is up right now (we ask frps's own API, the
	# way the certificate ask endpoint above does). Only these two words go out:
	# the address of the teacher's machine and the traffic counters from the API
	# answer stay here.
	handle /.relay/state {
		header Cache-Control "no-store"
		header Content-Type "application/json"
		@known file {
			root /etc/caddy/names
			try_files {host}
		}
		handle @known {
			rewrite * /api/proxy/http/{labels.2}
			reverse_proxy 127.0.0.1:7500 {
				@live status 200
				handle_response @live {
					respond \`{"known":true,"tunnel":true}\` 200
				}
				@gone status 404
				handle_response @gone {
					respond \`{"known":true,"tunnel":false}\` 200
				}
			}
		}
		handle {
			respond \`{"known":false,"tunnel":false}\` 200
		}
	}

	reverse_proxy 127.0.0.1:8080 {
		header_up X-Forwarded-Host {host}
		header_up X-Forwarded-Proto https
	}

	# The same screen when what falls over is not the room but frps itself: a
	# restart, an update, memory running out. Before, a bare gateway error from
	# caddy arrived here, and for a student it cannot be told from "the internet
	# is broken".
	#
	# handle_errors catches only caddy's own errors — that is, the case when frps
	# cannot be reached. The 404 that a live frps gives for a name with no client
	# is an ordinary upstream answer for caddy; it goes right through
	# reverse_proxy and never lands here: the two branches do not compete for the
	# same case. Certificate issuance is not touched at all — it lives before
	# HTTP, in the TLS handshake, and never enters this route.
	handle_errors {
		root * /etc/caddy
		rewrite * /offline.html
		# The page has grown to 116 KB (two languages and four states), and it is
		# opened from a phone over cellular in a lecture hall. Compression cuts it to
		# 34 KB; the rest of the traffic through the relay is not affected — encode
		# sits inside handle_errors and touches only error pages.
		encode gzip zstd
		# The page is the same for all cases, but the text differs: the status code,
		# its name and the log entry number arrive in it by substitution.
		# The delimiters are not the default ones: templates parses the WHOLE file as
		# a Go template, and a pair of curly braces in a row turns up in JS and in text
		# by itself — the very first check failed on a comment where such a pair stood
		# in an explanation. A parse error means an empty answer instead of the error
		# page, that is, a white screen exactly when a person needs an explanation. A
		# pair with a percent sign does not occur in HTML, CSS or JS.
		templates {
			between <% %>
		}
		# An error must not stay in the cache: the room opens a minute later, and the
		# browser would keep showing "not open" from its memory.
		header Cache-Control "no-store"
		# The status code stays what actually happened. With file_server's default 200
		# the page would look like a success, and any check from outside — the same
		# one that waits for the address in make host — would take a dead relay for a
		# live seminar.
		file_server {
			status {err.status_code}
		}
	}
}

# Plain http is needed for the Let's Encrypt challenge; caddy does it itself
# and sends everything else to https.
:80 {
	redir https://{host}{uri} permanent
}
CONF
caddy fmt --overwrite /etc/caddy/Caddyfile >/dev/null 2>&1 || true
caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile
REMOTE_HEAD

# The page is put down before the services start: both already refer to it, and
# the very first request after a restart must get text, not an empty spot.
relay_page

cat <<'REMOTE_TAIL'

echo "== services"
cat > /etc/systemd/system/frps.service <<'UNIT'
[Unit]
Description=frp server for colloq relay
After=network-online.target
Wants=network-online.target

[Service]
User=frps
Group=frps
ExecStart=/usr/local/bin/frps -c /etc/colloq-relay/frps.toml
Restart=always
RestartSec=3
# Ceilings. Measured on a live class: two hundred students in one evening
# brought this machine down — the kernel killed now frps (209 MB), now caddy
# (186 MB), thirty-six times, and every kill broke ALL tunnels at once.
# MemoryHigh is not a kill but throttling: under pressure the kernel starts
# taking pages from whoever overreaches instead of shooting it. One and a half
# gigabytes out of 3.9 — with room for several parallel seminars.
MemoryHigh=1536M
# A thousand students means thousands of sockets, and by default a service
# gets 1024: hitting that means "nothing opens for anyone", without a single
# line in the journal about why.
LimitNOFILE=65535
# This daemon needs nothing extra: it reads one file and holds sockets.
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
PrivateTmp=true
ReadWritePaths=/var/lib/frps

[Install]
WantedBy=multi-user.target
UNIT

cat > /etc/systemd/system/caddy.service <<'UNIT'
[Unit]
Description=Caddy for colloq relay
After=network-online.target
Wants=network-online.target

[Service]
User=caddy
Group=caddy
ExecStart=/usr/local/bin/caddy run --config /etc/caddy/Caddyfile --adapter caddyfile
ExecReload=/usr/local/bin/caddy reload --config /etc/caddy/Caddyfile --adapter caddyfile --force
Restart=on-abnormal
RestartSec=3
# The same ceilings as for frps, and for the same reason: a killed caddy is a
# TLS failure for all names at once. A gigabyte is plenty (the measured maximum
# is 186 MB on two hundred sockets), and it leaves room for the neighbour.
MemoryHigh=1024M
LimitNOFILE=65535
# The right to listen on 80 and 443 without running as root.
AmbientCapabilities=CAP_NET_BIND_SERVICE
CapabilityBoundingSet=CAP_NET_BIND_SERVICE
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
PrivateTmp=true
ReadWritePaths=/var/lib/caddy /etc/caddy

[Install]
WantedBy=multi-user.target
UNIT

echo "== capybara scores"
base64 -d > /usr/local/bin/colloq-capy <<'CAPY_B64'
REMOTE_TAIL
embed "$CAPY_FILE"
cat <<'REMOTE_TAIL'
CAPY_B64
chmod 0755 /usr/local/bin/colloq-capy
# The Cloudflare token goes to the caddy process, and only with the wildcard.
# systemd reads EnvironmentFile as root before dropping privileges, and
# ProtectSystem=strict does not get in the way.
# Without the wildcard both files are removed, so an old token does not outlive
# the switch.
if [ "${WILDCARD:-0}" = 1 ]; then
  install -o root -g caddy -m 0640 /dev/null /etc/caddy/cloudflare.env
  printf 'CF_TOKEN=%s\n' "${CF_TOKEN}" > /etc/caddy/cloudflare.env
  mkdir -p /etc/systemd/system/caddy.service.d
  printf '[Service]\nEnvironmentFile=/etc/caddy/cloudflare.env\n' > /etc/systemd/system/caddy.service.d/cloudflare.conf
else
  rm -f /etc/systemd/system/caddy.service.d/cloudflare.conf /etc/caddy/cloudflare.env
fi
cat > /etc/systemd/system/colloq-capy.service <<'UNIT'
[Unit]
Description=capybara leaderboard for the colloq relay waiting page
After=network-online.target
Wants=network-online.target
[Service]
User=capy
Group=capy
Environment=CAPY_STATE=/var/lib/colloq-capy
Environment=CAPY_PORT=9181
StateDirectory=colloq-capy
ExecStart=/usr/bin/python3 /usr/local/bin/colloq-capy
Restart=always
RestartSec=3
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
PrivateTmp=true
[Install]
WantedBy=multi-user.target
UNIT

echo "== static mirror"
base64 -d > /usr/local/bin/colloq-assets <<'ASSETS_B64'
REMOTE_TAIL
embed "$ASSETS_FILE"
cat <<REMOTE_TAIL
ASSETS_B64
chmod 0755 /usr/local/bin/colloq-assets
# The marker is quoted: \${DOMAIN} is already substituted here, while
# \$CREDENTIALS_DIRECTORY in the comment below is a systemd variable, and it
# must not be expanded at install time (under set -u it brought down the whole
# run with an empty unit). Escaped twice: this text itself goes through a
# heredoc without quotes.
cat > /etc/systemd/system/colloq-assets.service <<'UNIT'
[Unit]
Description=static mirror for colloq relay
After=network-online.target
Wants=network-online.target
[Service]
User=assets
Group=assets
Environment=ASSETS_ROOT=/var/lib/colloq-assets
Environment=ASSETS_PORT=9182
Environment=ASSETS_DOMAIN=${DOMAIN}
ExecStart=/usr/bin/python3 /usr/local/bin/colloq-assets
Restart=always
RestartSec=3
# The secret is the same as frps's — and it comes as a copy from systemd, not
# through membership in the frps group: the service needs one file, not the
# right to read the daemon's whole directory. The file appears in
# \$CREDENTIALS_DIRECTORY/token and is visible only to this service.
LoadCredential=token:/etc/colloq-relay/token
# Parsing someone else's archive: memory with room for unpacking, but no more.
MemoryHigh=256M
# Directories inside the mirror are 0750, files 0640, the group is inherited
# from setgid on the root: caddy reads them, and nobody else.
UMask=0027
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
PrivateTmp=true
ReadWritePaths=/var/lib/colloq-assets
[Install]
WantedBy=multi-user.target
UNIT
REMOTE_TAIL

# From here on it is literal text again: below there are awk with \$4 and
# python, and nothing needs substituting in them.
cat <<'REMOTE_TAIL'

# Cleanup once a day: abandoned names, leftovers of unpacking, past sets.
# Pieces of earlier builds age by themselves — they are carried over into a
# new set only while they are less than a month old
# (scripts/relay-assets.py · carry_over).
cat > /etc/systemd/system/colloq-assets-prune.service <<'UNIT'
[Unit]
Description=drop abandoned colloq relay mirrors
[Service]
Type=oneshot
User=assets
Group=assets
Environment=ASSETS_ROOT=/var/lib/colloq-assets
ExecStart=/usr/bin/python3 /usr/local/bin/colloq-assets --prune
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
PrivateTmp=true
ReadWritePaths=/var/lib/colloq-assets
UNIT
cat > /etc/systemd/system/colloq-assets-prune.timer <<'UNIT'
[Unit]
Description=drop abandoned colloq relay mirrors daily
[Timer]
OnCalendar=daily
Persistent=true
AccuracySec=1h
[Install]
WantedBy=timers.target
UNIT

echo "== name memory"
cat > /usr/local/bin/colloq-relay-names <<NAMES
#!/usr/bin/env bash
# Rewrites /etc/caddy/names from the list of frps tunnels: every name that frps
# has seen since its last start becomes an empty file <name>.${DOMAIN}.
# Files are never deleted — that is what the directory exists for: the frps
# list is empty after each of its restarts, and a name must be remembered
# beyond that.
# Called by the colloq-relay-names.timer timer as user caddy.
set -euo pipefail
python3 - "${DOMAIN}" <<'PY'
import json, re, sys, urllib.request
dom = sys.argv[1]
try:
    d = json.load(urllib.request.urlopen('http://127.0.0.1:7500/api/proxy/http', timeout=5))
except Exception:
    sys.exit(0)
for p in d.get('proxies', []):
    n = (p.get('conf') or {}).get('subdomain') or p.get('name') or ''
    if re.fullmatch(r'[a-z0-9-]+', n):
        open(f'/etc/caddy/names/{n}.{dom}', 'a').close()
PY
NAMES
chmod 0755 /usr/local/bin/colloq-relay-names
cat > /etc/systemd/system/colloq-relay-names.service <<'UNIT'
[Unit]
Description=remember colloq relay names for on-demand TLS
After=frps.service
[Service]
Type=oneshot
User=caddy
Group=caddy
ExecStart=/usr/local/bin/colloq-relay-names
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
PrivateTmp=true
ReadWritePaths=/etc/caddy/names
UNIT
cat > /etc/systemd/system/colloq-relay-names.timer <<'UNIT'
[Unit]
Description=remember colloq relay names every minute
[Timer]
OnBootSec=30s
OnUnitActiveSec=1min
AccuracySec=10s
[Install]
WantedBy=timers.target
UNIT
systemctl daemon-reload
systemctl enable --now frps caddy colloq-capy colloq-assets \
  colloq-relay-names.timer colloq-assets-prune.timer
# enable --now does not touch what is already running, and the script is meant
# to be repeatable: without an explicit restart a second run would leave both
# services on the old config.
systemctl restart frps caddy colloq-capy colloq-assets
sleep 3
systemctl is-active frps caddy colloq-capy colloq-assets | tr '\n' ' '; echo

echo "== listening"
ss -lntp | awk 'NR==1 || /:(80|443|7000|8080|9180|9182|7500)\b/{print "  "$4"  "$6}'

echo "== memory"
free -m | awk 'NR<=3{print "  "$0}'

echo
echo "the secret for instances is in /etc/colloq-relay/token"
REMOTE_TAIL
} | "${SSH[@]}" "$HOST" DOMAIN="$DOMAIN" FRP_VERSION="$FRP_VERSION" 'bash -s'

# Ready-made lines for the instance's .env.
#
# Only the secret used to be printed here — and there was no way to learn which
# variables to put it into, or where they are described at all: RELAY_* is in
# neither .env.example nor the README, and host.sh says nothing about them
# until it picks the relay. People got to the classroom with a Cloudflare
# address that does not open for the group.
TOKEN="$("${SSH[@]}" "$HOST" 'cat /etc/colloq-relay/token' 2>/dev/null || true)"
echo
say "put this into the instance's .env — no indentation, as it is:"
printf 'RELAY_DOMAIN=%s\nRELAY_ADDR=%s\nRELAY_PORT=7000\nRELAY_TOKEN=%s\n' \
  "$DOMAIN" "${HOST#*@}" "${TOKEN:-<from /etc/colloq-relay/token on the relay>}"
echo
say "then take the seminar outside: make host HOST=hse.${DOMAIN}"
echo
say "the text of the \"room is not open yet\" page is edited separately:"
printf '  make relay-page WHERE=%s\n' "$HOST"
