/**
 * The room container's perimeter, as flags, rules and scripts: what is taken
 * from the kernel beyond memory and CPU (privileges, the process count and
 * the road into the local network), with nothing behind it.
 *
 * MOVED OUT OF kernel/perimeter.ts, AND KEPT PURE. Classes on machines
 * (docs/architecture/remote-classes.md §7.1, «занятия на машинах») run their
 * kernels behind home's own perimeter, so that the sandbox is the same by
 * construction: a machine's agent (dist/runner.js) lays out the same flags,
 * the same rules and the same helper script, and it must do so without the
 * database, the settings and the instance's words behind perimeter.ts. So
 * nothing here reads the instance settings or calls docker: what a builder
 * needs is an input (the process ceiling, the mode, the profile), and so are
 * the names the rules live under (`PerimeterScope`). perimeter.ts keeps what
 * is home's (the ceilings read from the instance settings, the installation
 * on this server's docker with its memory of a minute, the refusal in the
 * instance's language) and re-exports every name that used to live there, so
 * nothing that imports them changes. tests/runner-import-graph.test.mts holds
 * this module free of home.
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
 * installer's story (perimeter.ts · helperImage at home).
 *
 * Two operator settings on top (Sep 2026, for university installs).
 * COLLOQ_ROOM_NETWORK=none cuts rooms off entirely: no internet, no campus, no
 * DNS, only the replies to the Colloq server that reaches their Jupyter.
 * KERNEL_BLOCKED_CIDRS adds ranges to the private ones: a campus's public
 * addresses, services that trust campus IPs.
 *
 * If installing fails, the room does NOT come up (at home RoomPerimeterError,
 * with a translated text: what happened and how to fix it). Silently opening
 * the network would be worse than refusing: the teacher believes they are
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
 *
 * ON A MACHINE (§7.5, §7.6). The same flags and the same rules, under names of
 * the machine's own: the bridge `colloq-mrooms-<i6>` and the chains
 * `COLLOQ-MR<i6>-FWD`, `-IN` and `-DENY`, where `<i6>` is six hex characters
 * of the agent's INSTANCE_LABEL (`machinePerimeter`). The agent reaches its
 * rooms the way a home on the host does, through a port published on
 * 127.0.0.1, so its plan exempts nothing, and the IN chain refuses the rooms
 * subnet to the host. Home's mode is the floor: a machine may be stricter and
 * may block more ranges, never fewer (`machinePerimeterPlan`).
 */
import net from 'node:net'
import os from 'node:os'

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

/* ----------------------------------------------------------------- scopes */

/**
 * Whose rooms a perimeter fences: the bridge they live on, the chains the
 * rules go into, the comment the jumps to them carry, and the bridge's labels.
 *
 * Home has one (`HOME_PERIMETER`), the names it always had. A machine has its
 * own (`machinePerimeter`): a machine's daemon may carry a home's rooms too
 * (D20 refuses classes there; distinct names are the defence in depth), and
 * two agents on one daemon (two trees on a university server) must each
 * install, re-check and remove only their own rules and their own jumps.
 */
export interface PerimeterScope {
  /** The bridge the rooms live on. */
  network: string
  /** The chains' common prefix: `<chains>-FWD`, `<chains>-IN` and `<chains>-DENY`. */
  chains: string
  /** The comment on the jumps from DOCKER-USER and INPUT. */
  tag: string
  /** The bridge's labels, `key=value`, as `docker network create` takes them. */
  labels: readonly string[]
}

/** Home's perimeter: the bridge, chains and comment every room has lived under since 18 Sep 2026. */
export const HOME_PERIMETER: PerimeterScope = Object.freeze({
  network: ROOM_NETWORK,
  chains: 'COLLOQ-ROOMS',
  tag: PERIMETER_TAG,
  labels: Object.freeze(['colloq.kind=room-network']),
})

/** A machine's perimeter, with the six hex characters it is named by. */
export interface MachinePerimeter extends PerimeterScope {
  i6: string
}

/** The agent's INSTANCE_LABEL (runner-agent/images.ts): a key, `=`, and the hex of its tree's hash. */
const INSTANCE_LABEL_SHAPE = /^[a-z0-9.-]+=([0-9a-f]{6})[0-9a-f]*$/

/**
 * The perimeter of one machine's class kernels: `colloq-mrooms-<i6>` and the
 * chains `COLLOQ-MR<i6>-*`, `<i6>` being the first six hex characters of the
 * agent's INSTANCE_LABEL.
 *
 * Six characters, not the label's sixteen: an iptables chain name holds 28
 * characters at most, and `COLLOQ-MR<i6>-DENY` is twenty. They are spelled
 * the same in every name, lower case as the label has them and as §7.1 writes
 * them: the bridge, the comment, the chains and the containers
 * (room-spec.ts · machineRoomContainer), so one `grep <i6>` over
 * `iptables-save` and `docker ps` finds all of an agent's. The bridge carries
 * the instance label too, so the agent finds its own by label as it finds its
 * containers. A label of another shape is a caller's mistake, and throws: a
 * perimeter named by a guess could be another agent's.
 */
export function machinePerimeter(instanceLabel: string): MachinePerimeter {
  const i6 = INSTANCE_LABEL_SHAPE.exec(instanceLabel)?.[1]
  if (!i6) throw new Error(`not an agent instance label: ${JSON.stringify(instanceLabel)}`)
  return {
    i6,
    network: `colloq-mrooms-${i6}`,
    chains: `COLLOQ-MR${i6}`,
    tag: `colloq-mrooms-${i6}`,
    labels: ['colloq.kind=class-network', instanceLabel],
  }
}

/** The three chains of a scope, by their roles. */
function chainsOf(scope: PerimeterScope): { fwd: string; in: string; deny: string } {
  return { fwd: `${scope.chains}-FWD`, in: `${scope.chains}-IN`, deny: `${scope.chains}-DENY` }
}

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
 * The profile label of a room container in a mode: the profile version, and
 * in the `none` mode a suffix, since that mode also changes the container
 * itself (`--dns`, which only `docker run` can set).
 */
export function profileFor(mode: RoomNetworkMode): string {
  return mode === 'none' ? `${ROOM_PROFILE}-none` : ROOM_PROFILE
}

/**
 * The profile label a room container gets now (`profileFor` the current
 * mode). A stopped container with a different label is recreated at its next
 * start; a live one keeps running until it stops (pool.ts), and the rules,
 * which follow the subnet rather than the container, apply to it at once.
 */
export function roomProfile(env: NodeJS.ProcessEnv = process.env): string {
  return profileFor(roomNetworkMode(env))
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
  return blockedCidrs((env.KERNEL_BLOCKED_CIDRS ?? '').split(/[\s,]+/).filter(Boolean))
}

/** The entries of a blocklist, by blockedCidrsSetting's rule: normalised ranges, v6 entries, and what is neither. */
function blockedCidrs(entries: readonly string[]): { cidrs: string[]; ignored: string[]; invalid: string[] } {
  const cidrs: string[] = []
  const ignored: string[] = []
  const invalid: string[] = []
  for (const entry of entries) {
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

/** What the hardened profile is made of for one container: its process ceiling, the network mode and the profile label. */
export interface RoomHardening {
  /**
   * The process ceiling: `roomPids` (512) for the class's container, `ownPids`
   * (2048) for the personal notebooks' and the council's (perimeter.ts ·
   * pidsLimit, ownPidsLimit at home; the intent on a machine).
   */
  pids: number
  mode: RoomNetworkMode
  /** The `colloq.profile` label (`profileFor` the mode). */
  profile: string
}

/**
 * Room container hardening: what production sets through the Pod's
 * securityContext (runtime/src/controller.ts), in docker's words. Home's
 * `roomHardeningArgs(env, role)` (perimeter.ts) reads the three inputs from
 * the instance and calls this.
 *
 * What is not here and why. `--read-only`: students install packages with
 * `%pip install` into the container layer, and production mounts /home/runner
 * and /tmp separately for that; here it would break the usual path with no
 * gain. `--tmpfs /tmp`: tmpfs counts against the room's memory, and a dataset
 * downloaded to /tmp would kill the kernel by OOM. seccomp is left alone:
 * docker's default profile stays, the same RuntimeDefault as in production.
 */
export function roomHardeningArgs(hardening: RoomHardening): string[] {
  return [
    // The same uid as in the image and in production (runAsUser/runAsGroup
    // 1000): an image someone built with `USER root` at the end will not
    // become a root room.
    '--user=1000:1000',
    '--cap-drop=ALL',
    // setuid files and file capabilities no longer give anything: not to su,
    // not to a binary the student installed themselves.
    '--security-opt=no-new-privileges',
    `--pids-limit=${hardening.pids}`,
    // No IPv6 at all: there are no v6 rules, so there must be no addresses.
    '--sysctl=net.ipv6.conf.all.disable_ipv6=1',
    '--sysctl=net.ipv6.conf.default.disable_ipv6=1',
    // COLLOQ_ROOM_NETWORK=none: the resolver's upstream is an address the
    // rules refuse, so not even a DNS query leaves (see the header).
    ...(hardening.mode === 'none' ? [`--dns=${BLACKHOLE_DNS}`] : []),
    '--label',
    `colloq.profile=${hardening.profile}`,
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
export function networkCreateArgs(subnet: string | null, scope: PerimeterScope = HOME_PERIMETER): string[] {
  return [
    'network',
    'create',
    '--driver=bridge',
    ...(subnet ? [`--subnet=${subnet}`] : []),
    '--ipv6=false',
    '-o',
    'com.docker.network.bridge.enable_icc=false',
    ...scope.labels.flatMap((label) => ['--label', label]),
    scope.network,
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
 * Refuse the rooms subnets of a plan that would fence nothing. With no subnet
 * the chains go in empty, both jumps go in, and the helper still says ok
 * while the rooms reach everything. An entry that is not an IPv4 range fences
 * the wrong thing (an address without its prefix is one host of a bridge's
 * thousand) and must not reach the root helper's script at all. Home never
 * comes here with either: perimeter.ts · roomSubnets refuses a network with
 * no IPv4 subnet and reads only ranges. A machine's caller passes the
 * subnets its bridge has. A plain error: a caller's mistake.
 */
function checkSubnets(subnets: readonly string[]): void {
  if (subnets.length === 0) throw new Error('a perimeter with no rooms subnet fences nothing')
  const bad = subnets.filter((subnet) => parseCidr(subnet) === null)
  if (bad.length) throw new Error(`not an IPv4 rooms subnet: ${JSON.stringify(bad).slice(0, 300)}`)
}

/**
 * The body for `iptables-restore --noflush`: all three of the scope's chains,
 * whole.
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
export function perimeterRules(
  plan: PerimeterPlan,
  deny: 'reject' | 'drop' = 'reject',
  scope: PerimeterScope = HOME_PERIMETER,
): string {
  checkSubnets(plan.subnets)
  const chain = chainsOf(scope)
  const lines = [
    '*filter',
    `:${chain.fwd} - [0:0]`,
    `:${chain.in} - [0:0]`,
    `:${chain.deny} - [0:0]`,
  ]
  if (deny === 'reject') {
    lines.push(`-A ${chain.deny} -p tcp -j REJECT --reject-with tcp-reset`)
    lines.push(`-A ${chain.deny} -j REJECT --reject-with icmp-admin-prohibited`)
  } else {
    lines.push(`-A ${chain.deny} -j DROP`)
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
  for (const from of [chain.fwd, chain.in]) {
    lines.push(`-A ${from} -m conntrack --ctstate RELATED,ESTABLISHED -j RETURN`)
    for (const address of plan.exempt) lines.push(`-A ${from} -s ${address}/32 -j RETURN`)
    if (none) continue
    lines.push(`-A ${from} -p udp -m udp --dport 53 -j RETURN`)
    lines.push(`-A ${from} -p tcp -m tcp --dport 53 -j RETURN`)
  }
  for (const subnet of plan.subnets) {
    if (none) {
      // Beyond the host nothing a room starts: no internet, no campus, no DNS.
      lines.push(`-A ${chain.fwd} -s ${subnet} -j ${chain.deny}`)
    } else {
      // Beyond the host: private and special addresses no, the operator's
      // extra ranges no, the rest of the internet yes.
      for (const range of [...BLOCKED_V4, ...(plan.extra ?? [])]) {
        lines.push(`-A ${chain.fwd} -s ${subnet} -d ${range} -j ${chain.deny}`)
      }
    }
    // To the host itself nothing: not its LAN addresses, not the bridge
    // gateway, not the neighbours' published ports, not a service on 0.0.0.0.
    lines.push(`-A ${chain.in} -s ${subnet} -j ${chain.deny}`)
  }
  lines.push('COMMIT')
  return lines.join('\n') + '\n'
}

/** How strict each mode is: `none` refuses more than `blocked`, which refuses more than `open`. */
const STRICTNESS: Readonly<Record<RoomNetworkMode, number>> = { open: 0, blocked: 1, none: 2 }

/** Whether `mode` refuses at least what `floor` refuses: the question home asks of a machine's reported mode. */
export function atLeastAsStrict(mode: RoomNetworkMode, floor: RoomNetworkMode): boolean {
  return STRICTNESS[mode] >= STRICTNESS[floor]
}

/**
 * What one side asks of a perimeter: its mode and its KERNEL_BLOCKED_CIDRS.
 * Home's arrives with each intent and is the floor; a machine's own is laid
 * on top of it.
 */
export interface PerimeterPolicy {
  mode: RoomNetworkMode
  blockedCidrs: readonly string[]
}

/**
 * The plan a machine installs for its rooms: home's mode and ranges as the
 * floor (D21), the machine's own on top.
 *
 * A machine may be stricter than home (its owner set COLLOQ_ROOM_NETWORK=none
 * there, or blocks a range of its own campus) and never looser: the stricter
 * of the two modes wins, and the ranges are both lists together, so nothing
 * the machine says can take one of home's away. `open` is not a mode a machine
 * runs in at all: an open home trusts its own network, not a machine's, whose
 * LAN is somebody else's. The exemption list stays empty: the agent runs on
 * the host's network and reaches a room through 127.0.0.1, never from the
 * rooms subnet.
 *
 * A range that is not one is a refusal, as at home (blockedCidrsSetting): a
 * blocklist with a typo leaves exactly that range open while the operator
 * believes it closed, so the plan throws rather than leave the entry out. In
 * the `none` mode the ranges have nothing to add, and nothing in them is read,
 * the rule home's `perimeterPlan` follows.
 *
 * The subnets are the ones the machine's bridge HAS, read after it exists
 * (`networkCreateArgs` if it is missing, then `docker network inspect` and
 * `ipv4Subnets`), the way home's are (perimeter.ts · roomSubnets). The subnet
 * asked of `network create` is not one to trust: the bridge may exist already
 * with another, or come from docker's pool after an overlap. An empty list, or
 * an entry that is not a range, is refused (`checkSubnets`) rather than
 * installed as a fence of nothing, and the subnets are laid out normalised, as
 * the ranges are.
 */
export function machinePerimeterPlan(
  subnets: readonly string[],
  home: PerimeterPolicy,
  machine: PerimeterPolicy = { mode: 'blocked', blockedCidrs: [] },
): PerimeterPlan {
  checkSubnets(subnets)
  const fenced = subnets.map((subnet) => normalizedCidr(subnet)!)
  const mode: 'blocked' | 'none' = home.mode === 'none' || machine.mode === 'none' ? 'none' : 'blocked'
  if (mode === 'none') return { subnets: fenced, exempt: [], mode }
  const { cidrs, invalid } = blockedCidrs([...home.blockedCidrs, ...machine.blockedCidrs])
  if (invalid.length) throw new Error(`not an IPv4 address or range: ${invalid.join(', ').slice(0, 300)}`)
  return cidrs.length ? { subnets: fenced, exempt: [], mode, extra: cidrs } : { subnets: fenced, exempt: [], mode }
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
export function perimeterScript(plan: PerimeterPlan, scope: PerimeterScope = HOME_PERIMETER): string {
  const chain = chainsOf(scope)
  return `${FIND_DOCKERD}[ -n "$pid" ] || { say 'no dockerd process in the host namespaces'; exit 20; }
fw iptables -w -n -L DOCKER-USER >/dev/null 2>&1 || { say 'no DOCKER-USER chain: Docker does not manage iptables on this host'; exit 21; }
if ! fw iptables-restore -w --noflush <<'COLLOQ_RULES'
${perimeterRules(plan, 'reject', scope)}COLLOQ_RULES
then
  say 'REJECT is unavailable, falling back to DROP'
  fw iptables-restore -w --noflush <<'COLLOQ_RULES' || { say 'iptables-restore refused the rules'; exit 22; }
${perimeterRules(plan, 'drop', scope)}COLLOQ_RULES
fi
fw iptables -w -C DOCKER-USER -m comment --comment ${scope.tag} -j ${chain.fwd} 2>/dev/null \\
  || fw iptables -w -I DOCKER-USER 1 -m comment --comment ${scope.tag} -j ${chain.fwd} \\
  || { say 'cannot hook DOCKER-USER'; exit 23; }
fw iptables -w -C INPUT -m comment --comment ${scope.tag} -j ${chain.in} 2>/dev/null \\
  || fw iptables -w -I INPUT 1 -m comment --comment ${scope.tag} -j ${chain.in} \\
  || { say 'cannot hook INPUT'; exit 23; }
say ok
`
}

/**
 * Remove everything of the scope's: the jumps by comment, then its own
 * chains. Other rules are not touched: deletion goes by exactly the line we
 * inserted.
 */
export function perimeterRemovalScript(scope: PerimeterScope = HOME_PERIMETER): string {
  const chain = chainsOf(scope)
  const all = `${chain.fwd} ${chain.in} ${chain.deny}`
  return `${FIND_DOCKERD}[ -n "$pid" ] || exit 0
while fw iptables -w -D DOCKER-USER -m comment --comment ${scope.tag} -j ${chain.fwd} 2>/dev/null; do :; done
while fw iptables -w -D INPUT -m comment --comment ${scope.tag} -j ${chain.in} 2>/dev/null; do :; done
for chain in ${all}; do fw iptables -w -F "$chain" 2>/dev/null; done
for chain in ${all}; do fw iptables -w -X "$chain" 2>/dev/null; done
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
