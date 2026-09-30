/**
 * The room container's perimeter on the docker backend: what is taken from the
 * kernel beyond memory and CPU: privileges, the process count and the road
 * into the local network.
 *
 * The owner's decision (18 Sep 2026): the hardened profile ALWAYS, not only
 * when a class is open to the outside. Before it the local path (`colloq
 * start`, `make dev`, `make run`/`make up`, the vast image) had two holes
 * beyond kernel isolation itself:
 *
 *   1. docker's default privileges. The kernel already runs as runner (uid
 *      1000), but the bounding set of capabilities stayed full: any setuid file
 *      in the image (or a package a student installed) would take them back;
 *   2. an open network. Student code reached the teacher's router, every
 *      machine on their home or university network, the computer itself (on
 *      colima `host.docker.internal:3000` is the live Colloq server, checked on
 *      18 Sep 2026) and the cloud metadata at 169.254.169.254 on a rented
 *      machine.
 *
 * What it is now.
 *
 * Privileges are handled by `docker run` flags (`roomHardeningArgs`): cap-drop
 * ALL, no-new-privileges, an explicit uid 1000, pids-limit. There is nothing to
 * add back: the image does nothing as root at startup, since kernel/Dockerfile
 * ends with `USER runner` and Jupyter starts straight as that user (checked:
 * CapEff and CapBnd inside are zeros; the kernel, pip and the terminal work).
 *
 * The network is handled by iptables rules on the docker daemon's machine, in
 * chains only we own (COLLOQ-ROOMS-*), with jumps from DOCKER-USER (everything
 * the container sends beyond the host) and from INPUT (everything it sends to
 * the host itself: its LAN addresses, the bridge gateway, neighbouring
 * published ports). DOCKER-USER is the only place in FORWARD that docker
 * promises not to touch and puts FIRST: a rule inserted into FORWARD itself
 * would be overtaken by the daemon's own ACCEPTs after a restart. The internet
 * stays: only private and special-purpose ranges are banned (BLOCKED_V4), and
 * everything else goes as before: pip, datasets, APIs.
 *
 * The rules are installed by a short-lived helper container through the same
 * docker socket the server already has (`--privileged --pid=host --net=host`).
 * Inside, it finds the dockerd process and calls iptables IN ITS mount
 * namespace (nsenter -m). That settles the "iptables-nft or iptables-legacy"
 * question by itself: it is exactly the binary the daemon uses, and picking
 * the wrong backend, as a separate iptables in our own image could, is
 * impossible here. The same works on all three forms: colima and Docker
 * Desktop (the daemon in its own Linux VM, which is where we land), and plain
 * Linux (the daemon on the host). The helper needs nothing of its own but sh,
 * readlink, cat and nsenter (util-linux is essential in Debian): iptables
 * itself comes from the daemon's filesystem. Which image it runs from is its
 * own story, see `helperImage`.
 *
 * Two operator settings on top (Sep 2026, for university installs).
 * COLLOQ_ROOM_NETWORK=none cuts rooms off entirely: no internet, no campus, no
 * DNS, only the replies to the Colloq server that reaches their Jupyter.
 * KERNEL_BLOCKED_CIDRS adds ranges to the private ones: a campus's public
 * addresses, services that trust campus IPs.
 *
 * If installing fails, the room does NOT come up (RoomPerimeterError with a
 * translated text: what happened and how to fix it). Silently opening the
 * network would be worse than refusing: the teacher believes they are
 * protected. For a trusted machine where the helper cannot start (rootless
 * docker, Docker Desktop with Enhanced Container Isolation, podman) there is an
 * explicit way out: COLLOQ_ROOM_NETWORK=open; rooms run without the ban, and
 * the server and `colloq doctor` say so out loud.
 *
 * Three subtleties that make the rules the way they are.
 *
 * DNS. Docker's built-in resolver (127.0.0.11) sometimes forwards queries from
 * the host's namespace (`ExtServers: [host(…)]`, as on colima and on Linux with
 * systemd-resolved), and sometimes FROM THE CONTAINER'S NETWORK, and then the
 * destination address is private: 192.168.65.7 on Docker Desktop, the router
 * 192.168.1.1 on plain Linux, 169.254.169.254 on GCP. So port 53 is allowed to
 * any address: without that not a single `pip install` would work on half the
 * machines. The price: a student can query the router's DNS, but still cannot
 * connect to what they learn.
 *
 * In the `none` mode there is no such exception, and the resolver's other road
 * is closed too: with an upstream on the host's own loopback (a local dnsmasq,
 * colima) the daemon forwards a room's queries from ITS namespace, where no
 * rule of ours sees them. So a room in that mode is started with
 * `--dns=192.0.2.1` (`BLACKHOLE_DNS`): the resolver then forwards from the
 * room's own namespace, to an address the `none` rules refuse at once.
 *
 * Replies. The server goes to the room's Jupyter itself (a published port on
 * loopback, or a name on the shared network), and the container's reply is a
 * packet FROM the rooms subnet TO a private address. The first rule of every
 * chain is ESTABLISHED,RELATED: everything the container did not start passes.
 * That is also all that keeps a `none` room reachable: the server's NEW
 * connection comes from the host or from an exempt address, never from the
 * rooms subnet, and nothing a room starts itself gets past the chains.
 *
 * IPv6. There are no rules for it because it is not there at all: the room
 * container comes up with `disable_ipv6=1`. The rooms network is created
 * without IPv6, but even on the compose network, and with `ipv6: true` in
 * daemon.json, the kernel will not get a single v6 address, neither global nor
 * fe80:: on the bridge, so there is nothing to get around the ban with via v6.
 */
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import { tr } from '@shared/i18n'
import { resourceValue } from '../admin/resource-settings.js'

/** The rooms network the server creates itself when it lives on the host. */
export const ROOM_NETWORK = 'colloq-rooms'

/**
 * This network's subnet, deliberately outside docker's pools (172.17–31/16 and
 * 192.168/16 by /20): so the first compose network to come along does not take
 * it, and `network create` does not fail with "Pool overlaps". A /22 is a
 * thousand addresses; there are never that many containers even on a big
 * machine, and only a LIVE container holds an address. Overridden by
 * KERNEL_ROOM_SUBNET, in case this subnet is already taken by someone's LAN or
 * VPN.
 */
export const DEFAULT_ROOM_SUBNET = '10.213.0.0/22'

/**
 * The profile version: the `colloq.profile` label on a room container.
 *
 * A container without it was brought up before hardening: a live one lives on
 * until it stops (removing it in the middle of class means losing every
 * variable), a stopped one is recreated at the next start. When the profile
 * changes, we bump the number, and the same rule moves the rooms to the new
 * one by itself.
 */
export const ROOM_PROFILE = '1'

/**
 * Where a `none` room's resolver forwards what it cannot answer itself.
 *
 * TEST-NET-1 (RFC 5737): an address that exists nowhere, so a query sent there
 * is lost even on a machine where our rules are missing. Not a loopback
 * address on purpose: the daemon forwards to a non-loopback upstream from the
 * room's own namespace, where the `none` rules refuse it within a millisecond.
 * Names of containers on the same network still resolve, and do no harm: the
 * rules refuse every connection a room starts.
 */
export const BLACKHOLE_DNS = '192.0.2.1'

/** The docker label that tells the helper apart from rooms. */
export const PERIMETER_KIND = 'room-perimeter'

/** The comment on our jumps: it is how (and the only way) we find them. */
export const PERIMETER_TAG = 'colloq-rooms'

const CHAIN_FWD = 'COLLOQ-ROOMS-FWD'
const CHAIN_IN = 'COLLOQ-ROOMS-IN'
const CHAIN_DENY = 'COLLOQ-ROOMS-DENY'

/**
 * Where a room must not go. The owner's list plus what nobody goes to by
 * definition: "this network" 0/8 and the reserved 240/4 with broadcast.
 *
 * 198.18.0.0/15 is deliberately absent: the fake-ip DNS of Clash and sing-box
 * answers with it, and on such a machine the ban would take the whole internet
 * away from the room.
 */
export const BLOCKED_V4 = [
  '0.0.0.0/8',
  '10.0.0.0/8',
  '100.64.0.0/10',
  '127.0.0.0/8',
  '169.254.0.0/16',
  '172.16.0.0/12',
  '192.168.0.0/16',
  '224.0.0.0/4',
  '240.0.0.0/4',
] as const

/* -------------------------------------------------------------- settings */

export type RoomNetworkMode = 'blocked' | 'open' | 'none'

let unknownModeWarned = false

/**
 * COLLOQ_ROOM_NETWORK: `open` is the way out for a trusted machine, `none`
 * the way in for an institution that lets student code reach nothing at all,
 * anything else means the ban. A typo ("opne") does not become an open
 * network: there must be no erring toward the hole, so an unknown word means
 * the ban and a line in the journal.
 */
export function roomNetworkMode(env: NodeJS.ProcessEnv = process.env): RoomNetworkMode {
  const raw = (env.COLLOQ_ROOM_NETWORK ?? '').trim().toLowerCase()
  if (raw === 'open') return 'open'
  if (raw === 'none') return 'none'
  if (raw !== '' && raw !== 'blocked' && !unknownModeWarned) {
    unknownModeWarned = true
    console.warn(
      `[kernel] COLLOQ_ROOM_NETWORK=${raw}: unknown value, local addresses stay blocked (use "none" to cut rooms off entirely, "open" to lift the block)`,
    )
  }
  return 'blocked'
}

/**
 * The profile label a room container gets now: the profile version, and in
 * the `none` mode a suffix, since that mode also changes the container itself
 * (`--dns`, which only `docker run` can set). A stopped container with a
 * different label is recreated at its next start; a live one keeps running
 * until it stops (pool.ts), and the rules, which follow the subnet rather
 * than the container, apply to it at once.
 */
export function roomProfile(env: NodeJS.ProcessEnv = process.env): string {
  return roomNetworkMode(env) === 'none' ? `${ROOM_PROFILE}-none` : ROOM_PROFILE
}

/**
 * KERNEL_BLOCKED_CIDRS: ranges a room may not reach on top of BLOCKED_V4 —
 * a campus's own public addresses, a library proxy that trusts campus IPs.
 * Commas or spaces between entries; a bare address means that one address.
 *
 * Only IPv4 counts: a room has no IPv6 at all (see the header), so a v6 range
 * from a campus list is valid and has nothing to act on; it is reported, not
 * refused. Anything else that is not an address or a range is a refusal, not
 * a skipped line: a blocklist with a typo would leave exactly that range open
 * while the operator believes it closed.
 */
export function blockedCidrsSetting(env: NodeJS.ProcessEnv = process.env): {
  cidrs: string[]
  ignored: string[]
  invalid: string[]
} {
  const cidrs: string[] = []
  const ignored: string[] = []
  const invalid: string[] = []
  for (const entry of (env.KERNEL_BLOCKED_CIDRS ?? '').split(/[\s,]+/).filter(Boolean)) {
    const v4 = normalizedCidr(entry.includes('/') ? entry : `${entry}/32`)
    if (v4) {
      if (!cidrs.includes(v4) && !(BLOCKED_V4 as readonly string[]).includes(v4)) cidrs.push(v4)
      continue
    }
    const [address, bits, extra] = entry.split('/')
    const v6 =
      extra === undefined &&
      net.isIPv6(address ?? '') &&
      (bits === undefined || (/^\d{1,3}$/.test(bits) && Number(bits) <= 128))
    if (v6) ignored.push(entry)
    else invalid.push(entry)
  }
  return { cidrs, ignored, invalid }
}

/** An IPv4 range with its host bits cleared (`10.1.2.3/8` → `10.0.0.0/8`), or null. */
function normalizedCidr(value: string): string | null {
  const parsed = parseCidr(value)
  if (!parsed) return null
  const size = 2 ** (32 - parsed.bits)
  const base = Math.floor(parsed.base / size) * size
  const octets = [24, 16, 8, 0].map((shift) => Math.floor(base / 2 ** shift) % 256)
  return `${octets.join('.')}/${parsed.bits}`
}

/**
 * The room's process ceiling, 512 by default: the instance setting `roomPids`
 * (admin/resource-settings.ts), then KERNEL_PIDS. Read at `docker run`, so a
 * change reaches the next container, not a running one.
 *
 * A fork bomb in a cell without a ceiling takes down not the room but the
 * machine, and every neighbouring class with it. 512 is plenty for Jupyter,
 * the kernel, the terminal and `DataLoader(num_workers=8)`; production keeps
 * 256 per Pod (deploy/k3s).
 */
export function pidsLimit(env: NodeJS.ProcessEnv = process.env): number {
  return resourceValue('roomPids', env)
}

/**
 * The process ceiling of the PERSONAL NOTEBOOKS CONTAINER, 2048 by default:
 * the instance setting `ownPids`, then KERNEL_OWN_PIDS.
 *
 * A separate number, because it counts something else. A room container holds
 * one kernel per class notebook plus the terminal; the personal notebooks
 * container holds dozens of kernels at once, one per open draft, and each
 * ipykernel keeps a dozen and a half threads on its own. The room's 512 runs
 * out already at thirty kernels, and that ends not in a refusal but in a
 * `BlockingIOError` in the middle of someone else's run. 2048 is the same 512
 * "per room" multiplied by a ceiling of live kernels (pool.ts ·
 * ownKernelMax): a fork bomb still hits a wall, and that wall is not the
 * neighbour's.
 */
export function ownPidsLimit(env: NodeJS.ProcessEnv = process.env): number {
  return resourceValue('ownPids', env)
}

/** KERNEL_ROOM_SUBNET if it is a real IPv4 CIDR; otherwise the default. */
export function roomSubnetSetting(env: NodeJS.ProcessEnv = process.env): { subnet: string; explicit: boolean } {
  const raw = (env.KERNEL_ROOM_SUBNET ?? '').trim()
  if (raw === '') return { subnet: DEFAULT_ROOM_SUBNET, explicit: false }
  if (parseCidr(raw) === null) {
    console.warn(`[kernel] KERNEL_ROOM_SUBNET=${raw} is not an IPv4 CIDR; using ${DEFAULT_ROOM_SUBNET}`)
    return { subnet: DEFAULT_ROOM_SUBNET, explicit: false }
  }
  return { subnet: raw, explicit: true }
}

/* ------------------------------------------------------- docker run flags */

/**
 * Room container hardening: what production sets through the Pod's
 * securityContext (runtime/src/controller.ts), in docker's words.
 *
 * What is not here and why. `--read-only`: students install packages with
 * `%pip install` into the container layer, and production mounts /home/runner
 * and /tmp separately for that; here it would break the usual path with no
 * gain. `--tmpfs /tmp`: tmpfs counts against the room's memory, and a dataset
 * downloaded to /tmp would kill the kernel by OOM. seccomp is left alone:
 * docker's default profile stays, the same RuntimeDefault as in production.
 */
export function roomHardeningArgs(
  env: NodeJS.ProcessEnv = process.env,
  /** The personal notebooks container uses its own ceiling, `ownPidsLimit`. */
  role: 'room' | 'own' = 'room',
): string[] {
  return [
    // The same uid as in the image and in production (runAsUser/runAsGroup
    // 1000): an image someone built with `USER root` at the end will not
    // become a root room.
    '--user=1000:1000',
    '--cap-drop=ALL',
    // setuid files and file capabilities no longer give anything: not to su,
    // not to a binary the student installed themselves.
    '--security-opt=no-new-privileges',
    `--pids-limit=${role === 'own' ? ownPidsLimit(env) : pidsLimit(env)}`,
    // No IPv6 at all: there are no v6 rules, so there must be no addresses.
    '--sysctl=net.ipv6.conf.all.disable_ipv6=1',
    '--sysctl=net.ipv6.conf.default.disable_ipv6=1',
    // COLLOQ_ROOM_NETWORK=none: the resolver's upstream is an address the
    // rules refuse, so not even a DNS query leaves (see the header).
    ...(roomNetworkMode(env) === 'none' ? [`--dns=${BLACKHOLE_DNS}`] : []),
    '--label',
    `colloq.profile=${roomProfile(env)}`,
  ]
}

/**
 * `docker network create` arguments for the rooms network.
 *
 * ICC is off: rooms do not see each other even when our rules are absent
 * (COLLOQ_ROOM_NETWORK=open); a neighbour's Jupyter is closed by a token, but
 * there is no reason to knock on it. The server reaches a room not over this
 * network but through a published port, so it does not need ICC. IPv6 is
 * turned off explicitly, in case daemon.json has `default-network-opts` with
 * ipv6.
 */
export function networkCreateArgs(subnet: string | null): string[] {
  return [
    'network',
    'create',
    '--driver=bridge',
    ...(subnet ? [`--subnet=${subnet}`] : []),
    '--ipv6=false',
    '-o',
    'com.docker.network.bridge.enable_icc=false',
    '--label',
    'colloq.kind=room-network',
    ROOM_NETWORK,
  ]
}

/* ------------------------------------------------------------- addresses */

export function parseIpv4(ip: string): number | null {
  const parts = ip.trim().split('.')
  if (parts.length !== 4) return null
  let value = 0
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null
    const octet = Number(part)
    if (octet > 255) return null
    value = value * 256 + octet
  }
  return value
}

export function parseCidr(cidr: string): { base: number; bits: number } | null {
  const [ip, bitsText, extra] = cidr.trim().split('/')
  if (extra !== undefined || ip === undefined || bitsText === undefined) return null
  if (!/^\d{1,2}$/.test(bitsText)) return null
  const bits = Number(bitsText)
  const base = parseIpv4(ip)
  if (base === null || bits > 32) return null
  return { base, bits }
}

export function ipv4InCidr(ip: string, cidr: string): boolean {
  const addr = parseIpv4(ip)
  const net = parseCidr(cidr)
  if (addr === null || net === null) return false
  if (net.bits === 0) return true
  const size = 2 ** (32 - net.bits)
  return Math.floor(addr / size) === Math.floor(net.base / size)
}

/**
 * The server's own addresses inside the rooms subnet, only when the server
 * itself is in a container and shares the network with the rooms (`make up`,
 * the vast image).
 *
 * The rules are written by source subnet, and the server lives in that subnet
 * too: without the exemption it would lose the tunnel (frpc and cloudflared go
 * out from the same container), the Oracle model's private address, and the
 * road to the kernels. A room has no way to forge this address: the kernel has
 * neither NET_RAW nor NET_ADMIN.
 */
export function ownAddresses(
  subnets: readonly string[],
  interfaces: NodeJS.Dict<os.NetworkInterfaceInfo[]> = os.networkInterfaces(),
): string[] {
  const found = new Set<string>()
  for (const list of Object.values(interfaces)) {
    for (const info of list ?? []) {
      if (info.family !== 'IPv4' || info.internal) continue
      if (subnets.some((subnet) => ipv4InCidr(info.address, subnet))) found.add(info.address)
    }
  }
  return [...found].sort()
}

/** IPv4 subnets from `docker network inspect` (IPv6 dropped: rooms have none). */
export function ipv4Subnets(text: string): string[] {
  return text
    .split(/\s+/)
    .map((item) => item.trim())
    .filter((item) => parseCidr(item) !== null)
}

/* ---------------------------------------------------------------- rules */

export interface PerimeterPlan {
  /** The subnets room containers send from. */
  subnets: string[]
  /** Addresses inside them that may go anywhere (the server on the compose network). */
  exempt: string[]
  /**
   * `blocked` (the default): private ranges, `extra` and the host itself are
   * refused, the internet and DNS pass. `none`: everything a room starts is
   * refused, DNS included; only replies pass.
   */
  mode?: 'blocked' | 'none'
  /** KERNEL_BLOCKED_CIDRS, normalised: refused on top of BLOCKED_V4 in the blocked mode. */
  extra?: string[]
}

/**
 * The body for `iptables-restore --noflush`: all three of our chains, whole.
 *
 * Atomic: either the kernel gets the whole set or nothing; declaring our own
 * chain with a `:NAME` line under --noflush flushes exactly that chain, and a
 * repeated call does not breed copies (checked on iptables-nft 1.8.10 on
 * colima). The body does not touch other chains at all: the jumps in
 * DOCKER-USER and INPUT are installed by the script separately, with a `-C`
 * check.
 *
 * `reject` refuses at once: TCP gets an RST ("Connection refused" within a
 * millisecond), everything else ICMP "administratively prohibited". Not DROP:
 * a request hanging for a minute would look to a student like "the internet is
 * slow". The kernel rate-limits ICMP but not RST, hence TCP separately. `drop`
 * is the fallback for a kernel without the REJECT module.
 */
export function perimeterRules(plan: PerimeterPlan, deny: 'reject' | 'drop' = 'reject'): string {
  const lines = [
    '*filter',
    `:${CHAIN_FWD} - [0:0]`,
    `:${CHAIN_IN} - [0:0]`,
    `:${CHAIN_DENY} - [0:0]`,
  ]
  if (deny === 'reject') {
    lines.push(`-A ${CHAIN_DENY} -p tcp -j REJECT --reject-with tcp-reset`)
    lines.push(`-A ${CHAIN_DENY} -j REJECT --reject-with icmp-admin-prohibited`)
  } else {
    lines.push(`-A ${CHAIN_DENY} -j DROP`)
  }
  const none = plan.mode === 'none'
  /*
   * Both chains begin the same way: replies pass, exempt addresses pass, DNS
   * passes (not in the `none` mode). All of that is RETURN, not ACCEPT: the
   * decision stays with docker and the host firewall; we only strike out our
   * part.
   *
   * DNS goes before the extra ranges as well: a campus's resolver lives in the
   * campus's own range, and the daemon may forward a room's queries to it from
   * the room's namespace, so refusing it would take every name away from the
   * room, pip's included.
   */
  for (const chain of [CHAIN_FWD, CHAIN_IN]) {
    lines.push(`-A ${chain} -m conntrack --ctstate RELATED,ESTABLISHED -j RETURN`)
    for (const address of plan.exempt) lines.push(`-A ${chain} -s ${address}/32 -j RETURN`)
    if (none) continue
    lines.push(`-A ${chain} -p udp -m udp --dport 53 -j RETURN`)
    lines.push(`-A ${chain} -p tcp -m tcp --dport 53 -j RETURN`)
  }
  for (const subnet of plan.subnets) {
    if (none) {
      // Beyond the host nothing a room starts: no internet, no campus, no DNS.
      lines.push(`-A ${CHAIN_FWD} -s ${subnet} -j ${CHAIN_DENY}`)
    } else {
      // Beyond the host: private and special addresses no, the operator's
      // extra ranges no, the rest of the internet yes.
      for (const range of [...BLOCKED_V4, ...(plan.extra ?? [])]) {
        lines.push(`-A ${CHAIN_FWD} -s ${subnet} -d ${range} -j ${CHAIN_DENY}`)
      }
    }
    // To the host itself nothing: not its LAN addresses, not the bridge
    // gateway, not the neighbours' published ports, not a service on 0.0.0.0.
    lines.push(`-A ${CHAIN_IN} -s ${subnet} -j ${CHAIN_DENY}`)
  }
  lines.push('COMMIT')
  return lines.join('\n') + '\n'
}

/**
 * Find dockerd and call its iptables: the common head of the helper scripts.
 *
 * dockerd is looked for not as the first one found by name but as the one
 * whose network namespace matches ours: `--net=host` by definition gives the
 * daemon's own network, while a nested dockerd (a neighbour's docker-in-docker)
 * lives in its own.
 */
const FIND_DOCKERD = `set -u
say() { printf 'colloq-perimeter: %s\\n' "$*"; }
me=$(readlink /proc/self/ns/net)
pid=
for p in /proc/[0-9]*; do
  [ "$(cat "$p/comm" 2>/dev/null)" = dockerd ] || continue
  [ "$(readlink "$p/ns/net" 2>/dev/null)" = "$me" ] || continue
  pid=\${p#/proc/}
  break
done
fw() { nsenter -t "$pid" -m -- "$@"; }
`

/**
 * The helper script: install (or update) the rules and the jumps to them.
 *
 * Exit codes let a refusal name its cause: 20, the daemon is not visible
 * (podman, a remote daemon, rootless without the host pid); 21, there is no
 * DOCKER-USER (the daemon has `iptables: false`, or docker 29's nftables
 * backend); 22, iptables did not accept the rules; 23, the jumps did not go
 * in.
 */
export function perimeterScript(plan: PerimeterPlan): string {
  return `${FIND_DOCKERD}[ -n "$pid" ] || { say 'no dockerd process in the host namespaces'; exit 20; }
fw iptables -w -n -L DOCKER-USER >/dev/null 2>&1 || { say 'no DOCKER-USER chain: Docker does not manage iptables on this host'; exit 21; }
if ! fw iptables-restore -w --noflush <<'COLLOQ_RULES'
${perimeterRules(plan, 'reject')}COLLOQ_RULES
then
  say 'REJECT is unavailable, falling back to DROP'
  fw iptables-restore -w --noflush <<'COLLOQ_RULES' || { say 'iptables-restore refused the rules'; exit 22; }
${perimeterRules(plan, 'drop')}COLLOQ_RULES
fi
fw iptables -w -C DOCKER-USER -m comment --comment ${PERIMETER_TAG} -j ${CHAIN_FWD} 2>/dev/null \\
  || fw iptables -w -I DOCKER-USER 1 -m comment --comment ${PERIMETER_TAG} -j ${CHAIN_FWD} \\
  || { say 'cannot hook DOCKER-USER'; exit 23; }
fw iptables -w -C INPUT -m comment --comment ${PERIMETER_TAG} -j ${CHAIN_IN} 2>/dev/null \\
  || fw iptables -w -I INPUT 1 -m comment --comment ${PERIMETER_TAG} -j ${CHAIN_IN} \\
  || { say 'cannot hook INPUT'; exit 23; }
say ok
`
}

/**
 * Remove everything of ours: the jumps by comment, then our own chains. Other
 * rules are not touched: deletion goes by exactly the line we inserted.
 */
export function perimeterRemovalScript(): string {
  return `${FIND_DOCKERD}[ -n "$pid" ] || exit 0
while fw iptables -w -D DOCKER-USER -m comment --comment ${PERIMETER_TAG} -j ${CHAIN_FWD} 2>/dev/null; do :; done
while fw iptables -w -D INPUT -m comment --comment ${PERIMETER_TAG} -j ${CHAIN_IN} 2>/dev/null; do :; done
for chain in ${CHAIN_FWD} ${CHAIN_IN} ${CHAIN_DENY}; do fw iptables -w -F "$chain" 2>/dev/null; done
for chain in ${CHAIN_FWD} ${CHAIN_IN} ${CHAIN_DENY}; do fw iptables -w -X "$chain" 2>/dev/null; done
say removed
`
}

/**
 * The helper's `docker run`. The privileges are its own, not the room's: it
 * lives for a second, runs only our script and removes itself (`--rm`).
 * `--pull=never`: every image it may run is already on the machine (the
 * server's own, one the operator pulled, or a locally built kernel), and a
 * pull would only waste time before the same refusal, or reach a registry
 * from a campus that has none.
 */
export function helperArgs(image: string, script: string): string[] {
  return [
    'run',
    '--rm',
    '--privileged',
    '--pid=host',
    '--network=host',
    '--user=0:0',
    '--pull=never',
    '--no-healthcheck',
    '--label',
    `colloq.kind=${PERIMETER_KIND}`,
    '--entrypoint=sh',
    image,
    '-c',
    script,
  ]
}

/* --------------------------------------------------------- installation */

interface RunResult {
  code: number
  out: string
}
export type DockerRun = (args: string[], timeoutMs?: number) => Promise<RunResult>

/**
 * Refusing a room without the ban: the text is translated and says what to do.
 * The key picks the text: the helper failed (the default), the operator's
 * blocklist is broken, there is no image the helper may run from.
 */
export class RoomPerimeterError extends Error {
  constructor(
    readonly reason: string,
    key:
      | 'server.roomPerimeter.refused'
      | 'server.roomPerimeter.badBlockedCidrs'
      | 'server.roomPerimeter.noHelperImage' = 'server.roomPerimeter.refused',
  ) {
    super(tr(key, { p0: reason }))
    this.name = 'RoomPerimeterError'
  }
}

/**
 * Where the rooms are and how to recognise them: the network name, and whether
 * to create it ourselves.
 *
 * On the host (`make dev`, `colloq start`, `make run`) the network is ours,
 * `colloq-rooms`. In a container (`make up`, vast) rooms live on the network
 * the server shares with them (KERNEL_NETWORK); whoever launched us creates
 * it, and we read the subnet from docker.
 */
export interface RoomNetworkTarget {
  network: string
  create: boolean
}

/**
 * Success is remembered for a minute, no longer.
 *
 * A rule can disappear: a reboot of the colima or Docker Desktop VM, an
 * `iptables -F` by hand. Checking on every room start would mean an extra
 * privileged container for each of thirty students in the first minute of
 * class; never checking would mean trusting a rule that is no longer there. A
 * minute is one helper per wave of starts, and a fresh look after any daemon
 * restart (which itself takes longer).
 */
const FRESH_MS = 60_000

let applied: { key: string; at: number } | null = null
let inflight: Promise<void> | null = null
/** The last refusal, so it can be told to those who ask about the state too. */
let lastProblem: string | null = null
let openAnnounced = false
/** Said once per process: a setting that has nothing to act on. */
let ignoredAnnounced = false
/** The server's own image ID, once found: a running container never changes its image. */
let ownImage: string | null = null

export function perimeterProblem(): string | null {
  return lastProblem
}

/** Do not trust the remembered success: the next room start asks docker again. */
export function perimeterStale(): void {
  applied = null
}

/** Forget everything, for tests, so one case does not inherit another's memory. */
export function forgetPerimeter(): void {
  applied = null
  inflight = null
  lastProblem = null
  openAnnounced = false
  ignoredAnnounced = false
  ownImage = null
}

/** The rooms network's subnets; creates it if it is our network and missing. */
async function roomSubnets(docker: DockerRun, target: RoomNetworkTarget): Promise<string[]> {
  const inspect = () =>
    docker(['network', 'inspect', target.network, '--format', '{{range .IPAM.Config}}{{.Subnet}} {{end}}'], 10_000)
  let found = await inspect()
  if (found.code !== 0 && target.create) {
    const { subnet, explicit } = roomSubnetSetting()
    let made = await docker(networkCreateArgs(subnet), 30_000)
    /*
     * The subnet already belongs to someone (another docker network on this
     * machine), and it was not named explicitly: let docker choose. The rules
     * are written for the subnet the network actually got anyway, not for the
     * default.
     */
    if (made.code !== 0 && !explicit && /overlap/i.test(made.out)) {
      console.warn(`[kernel] ${subnet} is taken on this Docker; ${ROOM_NETWORK} gets a subnet from Docker's pool`)
      made = await docker(networkCreateArgs(null), 30_000)
    }
    // Two processes created the network at once: for the second it is enough
    // that the network exists.
    if (made.code !== 0 && !/already exists/i.test(made.out)) {
      throw new RoomPerimeterError(`docker network create ${ROOM_NETWORK}: ${made.out.slice(-200)}`)
    }
    if (made.code === 0) console.log(`[kernel] created docker network ${ROOM_NETWORK} for room kernels`)
    found = await inspect()
  }
  if (found.code !== 0) throw new RoomPerimeterError(`docker network inspect ${target.network}: ${found.out.slice(-200)}`)
  const subnets = ipv4Subnets(found.out)
  if (subnets.length === 0) throw new RoomPerimeterError(`network ${target.network} has no IPv4 subnet`)
  return subnets
}

export interface HelperImageOptions {
  env?: NodeJS.ProcessEnv
  /** Whether the server itself runs in a container: `/.dockerenv`, the marker pool.ts uses too. */
  inContainer?: () => boolean
  /** This container's name as docker knows it, when COLLOQ_CONTAINER does not say. */
  hostname?: () => string
}

const IMAGE_ID = /^(?:sha256:)?[a-f0-9]{64}$/

/**
 * The image the privileged helper runs from.
 *
 * It used to be the room's kernel image, and that made it the weakest link on
 * the machine: the helper runs as root with the host's pid and network
 * namespaces, while the kernel image is built from package lists any teacher
 * edits in the panel, pip options included. One poisoned package in a list
 * would run as root on the host at the next room start. So, in order:
 *
 *   1. COLLOQ_HELPER_IMAGE, when the operator names one (a digest-pinned
 *      minimal image with sh and nsenter). It must already be on the machine:
 *      the helper never pulls.
 *   2. The server's own image, when the server runs in a container (the Vast
 *      image, `make up`): built by CI, not editable from the panel, certainly
 *      present, and it has nsenter. Found the way the image's entry point
 *      finds itself (deploy/vast/entrypoint.sh · locate_self): COLLOQ_CONTAINER,
 *      else the hostname, which docker sets to the container ID.
 *   3. Today's choice on a teacher's own machine, where the server runs on
 *      the host and has no image: the room's kernel image, else any
 *      colloq-kernel. The teacher who edits the lists is the machine's owner
 *      there.
 *
 * Images from the first two come back as their ID, exactly the bytes that
 * were inspected: a tag moved between the inspect and the run cannot swap
 * them. Null only in the third case with no kernel image at all: there is
 * nothing to bring a room up from either, and that refusal says "environment
 * not built" before this one does. When the first two cannot be satisfied,
 * this refuses rather than falling back to the kernel image, which would
 * reopen exactly the hole this closes.
 */
export async function helperImage(
  docker: DockerRun,
  preferred: string | null,
  options: HelperImageOptions = {},
): Promise<string | null> {
  const env = options.env ?? process.env
  const override = (env.COLLOQ_HELPER_IMAGE ?? '').trim()
  if (override) {
    const found = await docker(['image', 'inspect', '--format', '{{.Id}}', override], 10_000)
    const id = found.out.trim()
    if (found.code !== 0 || !IMAGE_ID.test(id)) {
      throw new RoomPerimeterError(`COLLOQ_HELPER_IMAGE=${override} is not on this Docker; docker pull it first`, 'server.roomPerimeter.noHelperImage')
    }
    return id
  }
  if ((options.inContainer ?? (() => fs.existsSync('/.dockerenv')))()) {
    if (ownImage) return ownImage
    const self = (env.COLLOQ_CONTAINER ?? '').trim() || (options.hostname ?? os.hostname)()
    const found = await docker(['inspect', '--type', 'container', '--format', '{{.Image}}', self], 10_000)
    const id = found.out.trim()
    if (found.code !== 0 || !IMAGE_ID.test(id)) {
      throw new RoomPerimeterError(
        `this server's container "${self}" is not visible to Docker; set COLLOQ_CONTAINER to its name, or COLLOQ_HELPER_IMAGE`,
        'server.roomPerimeter.noHelperImage',
      )
    }
    ownImage = id
    return id
  }
  if (preferred) {
    const own = await docker(['image', 'inspect', preferred, '--format', '{{.Id}}'], 10_000)
    if (own.code === 0) return preferred
  }
  const any = await docker(['images', 'colloq-kernel', '--format', '{{.Repository}}:{{.Tag}}'], 10_000)
  if (any.code !== 0) return null
  return any.out.split('\n').map((line) => line.trim()).find((line) => line && !line.endsWith(':<none>')) ?? null
}

/**
 * The rooms network exists and the ban on local addresses is in place, or a
 * refusal.
 *
 * Called before every `docker run` and `docker start` of a room (success is
 * remembered for a minute, simultaneous calls share one helper) and once at
 * server start. Throws RoomPerimeterError, and then the room does not come up.
 */
export async function ensureRoomPerimeter(
  docker: DockerRun,
  target: RoomNetworkTarget,
  image: string | null,
  options: HelperImageOptions = {},
): Promise<void> {
  const subnets = await roomSubnets(docker, target)
  return applyPerimeter(docker, target, subnets, image, options)
}

/**
 * The same at server start, in advance, so that the first room does not wait
 * for the helper and the operator sees a refusal in the journal before class,
 * not at the first Run.
 *
 * No kernel image yet (vast builds it in the background after start) is not a
 * refusal on a machine where the helper would run from it: there is nothing
 * to bring a room up from anyway, and the room's first start will install the
 * ban. Where the helper runs from the server's own image, the ban goes up now.
 */
export async function warmPerimeter(
  docker: DockerRun,
  target: RoomNetworkTarget,
  image: string,
  options: HelperImageOptions = {},
): Promise<void> {
  try {
    if (roomNetworkMode() !== 'open' && (await helperImage(docker, image, options)) === null) {
      console.log('[kernel] no kernel image yet; the room network block is installed with the first room')
      return
    }
    await ensureRoomPerimeter(docker, target, image, options)
  } catch (err) {
    console.error(`[kernel] ${err instanceof Error ? err.message : String(err)}`)
  }
}

/**
 * What the rules are made of in the current mode, or the refusal of a broken
 * blocklist. A setting that has nothing to act on (v6 ranges; any list in the
 * `none` mode, which refuses everything anyway) is said once, not refused.
 */
function perimeterPlan(mode: 'blocked' | 'none', subnets: string[], exempt: string[]): PerimeterPlan {
  const { cidrs, ignored, invalid } = blockedCidrsSetting()
  if (mode === 'none') {
    if ((cidrs.length || ignored.length || invalid.length) && !ignoredAnnounced) {
      ignoredAnnounced = true
      console.warn('[kernel] COLLOQ_ROOM_NETWORK=none refuses everything a room starts; KERNEL_BLOCKED_CIDRS has nothing to add')
    }
    return { subnets, exempt, mode }
  }
  if (invalid.length) throw new RoomPerimeterError(invalid.join(', ').slice(0, 300), 'server.roomPerimeter.badBlockedCidrs')
  if (ignored.length && !ignoredAnnounced) {
    ignoredAnnounced = true
    console.warn(`[kernel] KERNEL_BLOCKED_CIDRS: rooms have no IPv6, so ${ignored.join(', ')} has nothing to block`)
  }
  return cidrs.length ? { subnets, exempt, mode, extra: cidrs } : { subnets, exempt, mode }
}

async function applyPerimeter(
  docker: DockerRun,
  target: RoomNetworkTarget,
  subnets: string[],
  image: string | null,
  options: HelperImageOptions,
): Promise<void> {
  const mode = roomNetworkMode()
  if (mode === 'open') {
    lastProblem = null
    if (!openAnnounced) {
      openAnnounced = true
      console.warn(
        '[kernel] COLLOQ_ROOM_NETWORK=open: room kernels can reach this machine, its LAN and cloud metadata. Remove the line to block local addresses.',
      )
      if ((process.env.KERNEL_BLOCKED_CIDRS ?? '').trim()) {
        console.warn('[kernel] COLLOQ_ROOM_NETWORK=open lifts every block, KERNEL_BLOCKED_CIDRS included')
      }
      // Open means open: a ban installed by a previous run is removed. If that
      // fails (the helper is not allowed here anyway, or has no image to run
      // from), there is nothing to remove.
      const img = await helperImage(docker, image, options).catch(() => null)
      if (img) {
        const res = await docker(helperArgs(img, perimeterRemovalScript()), 30_000)
        if (res.code === 0 && /removed/.test(res.out)) applied = null
      }
    }
    return
  }
  let plan: PerimeterPlan
  try {
    plan = perimeterPlan(mode, subnets, target.create ? [] : ownAddresses(subnets))
  } catch (err) {
    applied = null
    lastProblem = err instanceof Error ? err.message : String(err)
    throw err
  }
  const key = JSON.stringify(plan)
  if (applied && applied.key === key && Date.now() - applied.at < FRESH_MS) return
  if (inflight) return inflight
  inflight = (async () => {
    try {
      const img = await helperImage(docker, image, options)
      if (!img) throw new RoomPerimeterError('no colloq-kernel image to run the firewall helper from')
      const res = await docker(helperArgs(img, perimeterScript(plan)), 60_000)
      if (res.code !== 0 || !/colloq-perimeter: ok/.test(res.out)) {
        const said = res.out.split('\n').filter((line) => line.trim()).slice(-2).join(' · ')
        throw new RoomPerimeterError((said || `exit ${res.code}`).slice(0, 300))
      }
      if (!applied || applied.key !== key) {
        const what =
          plan.mode === 'none'
            ? 'no outbound traffic (COLLOQ_ROOM_NETWORK=none)'
            : plan.extra?.length
              ? `local addresses and ${plan.extra.length} extra range(s) blocked (KERNEL_BLOCKED_CIDRS)`
              : 'local addresses blocked'
        console.log(`[kernel] room network ${target.network}: ${what} for ${subnets.join(', ')}`)
      }
      applied = { key, at: Date.now() }
      lastProblem = null
    } catch (err) {
      applied = null
      lastProblem = err instanceof Error ? err.message : String(err)
      throw err
    } finally {
      inflight = null
    }
  })()
  return inflight
}
