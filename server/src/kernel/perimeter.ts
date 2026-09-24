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
 * Linux (the daemon on the host). The helper's image is the kernel image: it
 * is certainly present on a machine that is about to bring up a room, and it
 * has nsenter (util-linux is required in Debian).
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
 * Replies. The server goes to the room's Jupyter itself (a published port on
 * loopback, or a name on the shared network), and the container's reply is a
 * packet FROM the rooms subnet TO a private address. The first rule of every
 * chain is ESTABLISHED,RELATED: everything the container did not start passes.
 *
 * IPv6. There are no rules for it because it is not there at all: the room
 * container comes up with `disable_ipv6=1`. The rooms network is created
 * without IPv6, but even on the compose network, and with `ipv6: true` in
 * daemon.json, the kernel will not get a single v6 address, neither global nor
 * fe80:: on the bridge, so there is nothing to get around the ban with via v6.
 */
import os from 'node:os'
import { tr } from '@shared/i18n'

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

export type RoomNetworkMode = 'blocked' | 'open'

let unknownModeWarned = false

/**
 * COLLOQ_ROOM_NETWORK: `open` is the way out for a trusted machine, anything
 * else means the ban. A typo ("opne") does not become an open network: there
 * must be no erring toward the hole, so an unknown word means the ban and a
 * line in the journal.
 */
export function roomNetworkMode(env: NodeJS.ProcessEnv = process.env): RoomNetworkMode {
  const raw = (env.COLLOQ_ROOM_NETWORK ?? '').trim().toLowerCase()
  if (raw === 'open') return 'open'
  if (raw !== '' && raw !== 'blocked' && !unknownModeWarned) {
    unknownModeWarned = true
    console.warn(`[kernel] COLLOQ_ROOM_NETWORK=${raw}: unknown value, local addresses stay blocked (use "open" to lift the block)`)
  }
  return 'blocked'
}

/**
 * The room's process ceiling: KERNEL_PIDS, 512 by default.
 *
 * A fork bomb in a cell without a ceiling takes down not the room but the
 * machine, and every neighbouring class with it. 512 is plenty for Jupyter,
 * the kernel, the terminal and `DataLoader(num_workers=8)`; production keeps
 * 256 per Pod (deploy/k3s).
 */
export function pidsLimit(env: NodeJS.ProcessEnv = process.env): number {
  const value = Number((env.KERNEL_PIDS ?? '').trim())
  return Number.isInteger(value) && value >= 64 ? value : 512
}

/**
 * The process ceiling of the PERSONAL NOTEBOOKS CONTAINER: KERNEL_OWN_PIDS,
 * 2048 by default.
 *
 * A separate number, because it counts something else. A room container holds
 * one kernel per class notebook plus the terminal; the personal notebooks
 * container holds dozens of kernels at once, one per open draft, and each
 * ipykernel keeps a dozen and a half threads on its own. The room's 512 runs
 * out already at thirty kernels, and that ends not in a refusal but in a
 * `BlockingIOError` in the middle of someone else's run. 2048 is the same 512
 * "per room" multiplied by the ceiling of live kernels (pool.ts ·
 * ownKernelMax): a fork bomb still hits a wall, and that wall is not the
 * neighbour's.
 */
export function ownPidsLimit(env: NodeJS.ProcessEnv = process.env): number {
  const value = Number((env.KERNEL_OWN_PIDS ?? '').trim())
  return Number.isInteger(value) && value >= 64 ? value : 2048
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
    '--label',
    `colloq.profile=${ROOM_PROFILE}`,
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
  /*
   * Both chains begin the same way: replies pass, exempt addresses pass, DNS
   * passes. All of that is RETURN, not ACCEPT: the decision stays with docker
   * and the host firewall; we only strike out our part.
   */
  for (const chain of [CHAIN_FWD, CHAIN_IN]) {
    lines.push(`-A ${chain} -m conntrack --ctstate RELATED,ESTABLISHED -j RETURN`)
    for (const address of plan.exempt) lines.push(`-A ${chain} -s ${address}/32 -j RETURN`)
    lines.push(`-A ${chain} -p udp -m udp --dport 53 -j RETURN`)
    lines.push(`-A ${chain} -p tcp -m tcp --dport 53 -j RETURN`)
  }
  for (const subnet of plan.subnets) {
    // Beyond the host: private and special addresses no, the internet yes.
    for (const range of BLOCKED_V4) lines.push(`-A ${CHAIN_FWD} -s ${subnet} -d ${range} -j ${CHAIN_DENY}`)
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
 * `--pull=never`: the kernel image is not in any registry, and an attempt to
 * pull it would only waste time before the same refusal.
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

/** Refusing a room without the ban: the text is translated and says what to do. */
export class RoomPerimeterError extends Error {
  constructor(readonly reason: string) {
    super(tr('server.roomPerimeter.refused', { p0: reason }))
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

/**
 * The image for the helper: the one asked for (the image of the room being
 * started), otherwise any colloq-kernel on the machine. None at all means
 * there is nothing to bring the room up from either; that refusal will say
 * "environment not built" before we do.
 */
async function helperImage(docker: DockerRun, preferred: string | null): Promise<string | null> {
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
): Promise<void> {
  const subnets = await roomSubnets(docker, target)
  return applyPerimeter(docker, target, subnets, image)
}

/**
 * The same at server start, in advance, so that the first room does not wait
 * for the helper and the operator sees a refusal in the journal before class,
 * not at the first Run.
 *
 * No kernel image yet (vast builds it in the background after start) is not a
 * refusal: there is nothing to bring a room up from anyway, and the room's
 * first start will install the ban.
 */
export async function warmPerimeter(docker: DockerRun, target: RoomNetworkTarget, image: string): Promise<void> {
  if (roomNetworkMode() === 'blocked' && (await helperImage(docker, image)) === null) {
    console.log('[kernel] no kernel image yet; the room network block is installed with the first room')
    return
  }
  try {
    await ensureRoomPerimeter(docker, target, image)
  } catch (err) {
    console.error(`[kernel] ${err instanceof Error ? err.message : String(err)}`)
  }
}

async function applyPerimeter(
  docker: DockerRun,
  target: RoomNetworkTarget,
  subnets: string[],
  image: string | null,
): Promise<void> {
  if (roomNetworkMode() === 'open') {
    lastProblem = null
    if (!openAnnounced) {
      openAnnounced = true
      console.warn(
        '[kernel] COLLOQ_ROOM_NETWORK=open: room kernels can reach this machine, its LAN and cloud metadata. Remove the line to block local addresses.',
      )
      // Open means open: a ban installed by a previous run is removed. If that
      // fails (the helper is not allowed here anyway), there is nothing to
      // remove.
      const img = await helperImage(docker, image)
      if (img) {
        const res = await docker(helperArgs(img, perimeterRemovalScript()), 30_000)
        if (res.code === 0 && /removed/.test(res.out)) applied = null
      }
    }
    return
  }
  const plan: PerimeterPlan = { subnets, exempt: target.create ? [] : ownAddresses(subnets) }
  const key = JSON.stringify(plan)
  if (applied && applied.key === key && Date.now() - applied.at < FRESH_MS) return
  if (inflight) return inflight
  inflight = (async () => {
    try {
      const img = await helperImage(docker, image)
      if (!img) throw new RoomPerimeterError('no colloq-kernel image to run the firewall helper from')
      const res = await docker(helperArgs(img, perimeterScript(plan)), 60_000)
      if (res.code !== 0 || !/colloq-perimeter: ok/.test(res.out)) {
        const said = res.out.split('\n').filter((line) => line.trim()).slice(-2).join(' · ')
        throw new RoomPerimeterError((said || `exit ${res.code}`).slice(0, 300))
      }
      if (!applied || applied.key !== key) {
        console.log(`[kernel] room network ${target.network}: local addresses blocked for ${subnets.join(', ')}`)
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
