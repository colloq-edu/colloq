/**
 * What machine is under the instance, and how much of it each room has been
 * given.
 *
 * On 13 Sep 2026 a seminar lost its kernel to memory sixteen times in a row,
 * and the only way to find out was `dmesg`: there was one limit for all rooms,
 * it lived in an environment variable and was shown nowhere in the product.
 * There was no way to raise it for one room, and raising it for everyone meant
 * giving sixteen gigabytes to ten seminars that are fine with two.
 *
 * Hence this module: it answers three questions without which a "how much
 * memory" field is guesswork. How much the machine has at all, how much is
 * free right now, and what has already been handed out to live rooms. Plus
 * the card, because a GPU environment asks for three times the usual memory,
 * and the teacher should see what exactly the seminar is being put on.
 *
 * Nothing here throws. All three sources (/proc, `nvidia-smi`, docker) may be
 * missing on someone else's machine, answer with garbage or hang; then the
 * seminar form simply does not show the hint instead of breaking entirely.
 */
import fs from 'node:fs'
import os from 'node:os'
import { spawn } from 'node:child_process'
import { db, sessionMemoryMb } from '../db.js'
import { listNames, needsGpu } from '../environments.js'
import { containerLimits, defaultCpus, defaultMemoryMb, dockerRead, gpuDevices, roomContainers, memoryLimitMb, ownLimits } from './pool.js'
import { kernelBackend, kernelRuntimeClient } from './runtime-client.js'
import type { GpuCard, InstanceResources, RoomResource } from '@shared/admin'
import type { RuntimeRoom } from '@shared/runtime'
import { observeWorkMemory, workBudgetSnapshot } from '../ops/work-budget.js'

const MB = 1024 * 1024

/*
 * The shape of the answer lives in shared/admin.ts with everything else the
 * panel reads: one documented contract for server and browser, not two
 * similar ones.
 */
export type { GpuCard, InstanceResources, RoomResource } from '@shared/admin'
type Collected = Omit<InstanceResources, 'limits'>

/* --------------------------------------------------------------- memory */

/**
 * How much memory the machine ITSELF has free, in its kernel's opinion, not
 * `freemem`'s.
 *
 * `os.freemem()` is no good on either of the two systems. On Linux it is
 * memory used by NOTHING, page cache included: on a working server it is
 * always close to zero, and a "0.4 GB free" hint out of 72 would honestly
 * scare a teacher on an empty machine. MemAvailable is the kernel's own
 * estimate of "how much can be taken without going to swap", and that is
 * exactly the question the seminar form asks. On macOS `freemem` lies more
 * crudely: the system counts as free only pages used by nothing, and inactive
 * and purgeable pages, the ones it gives up on first demand, are not included.
 * On a Mac with 36 GB, at most half of it in use, the form showed "0.5 GB
 * free" and painted the field with a warning at any limit.
 *
 * So where there is no /proc of our own, the answer is `null`, "don't know":
 * the form then says nothing about free memory. Silence is more honest than a
 * number that scares for nothing.
 */
function hostAvailableMb(): number | null {
  try {
    const meminfo = fs.readFileSync('/proc/meminfo', 'utf8')
    const match = /^MemAvailable:\s+(\d+)\s*kB/m.exec(meminfo)
    if (match) return Math.floor(Number(match[1]) / 1024)
  } catch {
    /* not Linux, or /proc is not mounted: an honest "don't know" below */
  }
  return null
}

/* ---------------------------------------------------------- docker daemon */

/**
 * The machine the room kernels ACTUALLY live on.
 *
 * On Linux the docker daemon is the same kernel, and its numbers match
 * `os.*`. On a Mac and on Windows a VM stands between them:
 * `colima start --memory 12` is twelve gigabytes for all containers at once,
 * however much the Mac has. The room's ceiling is set by whoever runs it, so
 * that is who has to be asked: a container in such a VM has nowhere to take
 * a sixteenth gigabyte from, while a class form going by the Mac's memory
 * would offer thirty-five and accept them, that is, promise a kernel that
 * gets killed for memory on the first heavy cell.
 */
interface Daemon {
  totalMb: number
  /** The daemon's `NCPU`: for a VM it is its share of the cores, not all of the Mac's. */
  cpus: number
}

/** "12514811904 10": the daemon's memory in bytes and its cores. */
export function parseDaemonInfo(out: string): Daemon | null {
  const [bytes, cores] = out.trim().split(/\s+/)
  const totalMb = Math.floor(Number(bytes) / MB)
  const cpus = Math.floor(Number(cores))
  // Zero and garbage mean "don't know", not "none": "none" would go into the
  // field's bounds and leave nothing to set for a room.
  if (!Number.isFinite(totalMb) || totalMb <= 0) return null
  return { totalMb, cpus: Number.isFinite(cpus) && cpus > 0 ? cpus : 0 }
}

/*
 * Asked once a minute, not on every request.
 *
 * `docker info` is a round trip to the daemon: thirty milliseconds on a
 * healthy machine and forever on a hung one. The answer changes exactly when
 * colima was restarted with different memory; a minute is enough for that to
 * reach the form, and enough to keep several teachers' panels from turning
 * into a stream of docker processes. A failure is remembered just like a
 * success: if the daemon is down, for a minute we answer with the machine's
 * numbers instead of calling it again on every PATCH.
 */
const DAEMON_TTL_MS = 60_000
let seenDaemon: Daemon | null = null
let seenAt = 0
let daemonInflight: Promise<Daemon | null> | null = null

type DockerRead = (args: string[], timeoutMs?: number) => Promise<{ code: number; out: string }>
let askDocker: DockerRead = dockerRead
let dockerInjected = false

/**
 * Substitute docker, for tests.
 *
 * Exactly like `useDockerForLimits` in pool.ts and for the same reason: there
 * is no real docker in the suite, yet what has to be checked happens only
 * with it.
 */
export function useDockerInfo(fake: DockerRead | null): void {
  askDocker = fake ?? dockerRead
  dockerInjected = fake !== null
}

/** What the daemon says about itself, cached and without a single exception escaping. */
export function readDaemon(): Promise<Daemon | null> {
  // Under the broker we do not manage the containers, and under the test
  // backend there are none at all: nobody to ask, so the numbers stay the
  // machine's.
  if (kernelBackend() !== 'docker' && !dockerInjected) return Promise.resolve(null)
  if (seenAt && Date.now() - seenAt < DAEMON_TTL_MS) return Promise.resolve(seenDaemon)
  daemonInflight ??= askDocker(['info', '--format', '{{.MemTotal}} {{.NCPU}}'], 3_000)
    .then((res) => (res.code === 0 ? parseDaemonInfo(res.out) : null))
    .catch(() => null)
    .then((value) => {
      seenDaemon = value
      seenAt = Date.now()
      return value
    })
    .finally(() => {
      daemonInflight = null
    })
  return daemonInflight
}

/**
 * The last thing the daemon said, for bounds computed synchronously.
 *
 * The `/api/instance/resources` endpoint computes the bounds AFTER
 * collecting, so the number there is always fresh. But a PATCH of a room's
 * limit also arrives at a cold server; there is no point waiting for docker
 * in it: this time the check goes by the machine's numbers, that is, softer
 * than it should, but the request does not stall for seconds because of an
 * unresponsive daemon. It also warms the cache for the next such request.
 */
function lastDaemon(): Daemon | null {
  void readDaemon()
  return seenDaemon
}

/* ---------------------------------------------------------------- broker */

/**
 * A room's memory on k3s is the broker's number, not the web's environment
 * variables.
 *
 * Under the broker it is the broker that assembles the room's Pod, and it has
 * its own default (RUNTIME_KERNEL_MEMORY, 2Gi out of the box), one for all
 * environments. The form, meanwhile, labelled the field with the docker path's
 * defaults, "4 GB, 16 on a GPU", which the Pod never got. And the broker has
 * its own ceiling: the node minus a gigabyte, or the operator's
 * RUNTIME_KERNEL_MEMORY_MAX. It reports both numbers in /v1/health.
 */
interface BrokerMemory {
  defaultMb: number | null
  maxMb: number | null
}
/*
 * If the broker has never answered yet, its factory default. There is no
 * better guess to offer here: an operator who changed RUNTIME_KERNEL_MEMORY
 * sees their number as soon as the broker answers, and until then the form at
 * least does not promise 4 GB where the Pod will get two.
 */
const BROKER_FACTORY_DEFAULT_MB = 2048
const BROKER_TTL_MS = 60_000
let seenBroker: BrokerMemory = { defaultMb: null, maxMb: null }
let brokerAt = 0
let brokerInflight: Promise<void> | null = null

/** Remember what the broker said about memory; silence about a field does not erase the previous value. */
function rememberBroker(health: { defaultMemoryMb?: number; maxMemoryMb?: number }): void {
  seenBroker = {
    defaultMb: health.defaultMemoryMb ?? seenBroker.defaultMb,
    maxMb: health.maxMemoryMb ?? seenBroker.maxMb,
  }
  brokerAt = Date.now()
}

/**
 * The last thing the broker said about memory, for synchronous bounds.
 *
 * Built the same way as `lastDaemon`: a limit PATCH does not wait for the
 * broker but warms the cache for next time. The form asks
 * /api/instance/resources when it opens anyway, so by the time something is
 * typed into the field the number is fresh.
 */
function lastBroker(): BrokerMemory {
  if (kernelBackend() === 'broker' && (!brokerAt || Date.now() - brokerAt >= BROKER_TTL_MS)) {
    brokerInflight ??= (async () => {
      try {
        rememberBroker(await kernelRuntimeClient().health())
      } catch {
        /* the broker is not configured or is down: we stay with the previous value */
      }
    })().finally(() => {
      brokerInflight = null
    })
  }
  return seenBroker
}

/** A room's default under the broker: one for all environments, as the broker itself has it. */
function brokerDefaultMb(): number {
  return lastBroker().defaultMb ?? BROKER_FACTORY_DEFAULT_MB
}

export interface MemoryPicture {
  totalMb: number
  /** How much more can be handed out; `null` means "we honestly don't know". */
  availableMb: number | null
  /** Whose numbers these are: the server machine's or the docker daemon's. */
  source: 'host' | 'docker'
}

/**
 * The form's two numbers, from the source that knows about them.
 *
 * "Is this the same computer" is decided by a number, not by the platform: a
 * native daemon has exactly as much memory as the machine, a colima VM has
 * its own, and DOCKER_HOST may even point at a neighboring server. The
 * one-sixteenth tolerance covers the difference in what each side counts as
 * "all of the memory".
 */
export function memoryPicture(input: {
  daemonTotalMb: number | null
  hostTotalMb: number
  hostAvailableMb: number | null
  takenMb: number
}): MemoryPicture {
  const { daemonTotalMb, hostTotalMb, hostAvailableMb, takenMb } = input
  const sameMachine =
    daemonTotalMb !== null && Math.abs(daemonTotalMb - hostTotalMb) <= hostTotalMb / 16
  if (daemonTotalMb === null || sameMachine) {
    return { totalMb: hostTotalMb, availableMb: hostAvailableMb, source: 'host' }
  }
  /*
   * A VM's free memory cannot be asked for: it has its own /proc, we do not go
   * inside, and the Mac's MemAvailable has nothing to do with its twelve
   * gigabytes. But exactly what the teacher needs is known: how much more can
   * be HANDED OUT, the daemon's ceiling minus a gigabyte for itself (the same
   * one as in the bounds below) minus what is already promised to live rooms.
   */
  return {
    totalMb: daemonTotalMb,
    availableMb: Math.max(0, daemonTotalMb - HOST_RESERVE_MB - takenMb),
    source: 'docker',
  }
}

/* ------------------------------------------------------------------ GPU */

/**
 * What the local `nvidia-smi` prints for these arguments; `null` — it is not
 * there, it failed, or it did not answer in time.
 *
 * Neither errors nor a missing binary escape. The timeout is short and real
 * (kill, not just reject): `nvidia-smi` on a machine with a hung driver never
 * returns, and this read hangs on the panel's request.
 */
function nvidiaSmi(args: string[]): Promise<string | null> {
  return new Promise((resolve) => {
    let child: ReturnType<typeof spawn>
    try {
      child = spawn('nvidia-smi', args)
    } catch {
      resolve(null)
      return
    }
    let out = ''
    let done = false
    const finish = (value: string | null): void => {
      if (done) return
      done = true
      clearTimeout(timer)
      resolve(value)
    }
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      finish(null)
    }, 3_000)
    child.stdout?.on('data', (chunk: Buffer) => (out += chunk.toString()))
    child.on('error', () => finish(null))
    child.on('close', (code) => finish(code === 0 ? out : null))
  })
}

/**
 * The machine's cards, from `nvidia-smi`, if it is there.
 *
 * An empty list means "no cards visible", and the seminar form then says
 * nothing about GPUs.
 */
async function readGpus(): Promise<GpuCard[]> {
  const out = await nvidiaSmi(['--query-gpu=index,name,memory.total', '--format=csv,noheader,nounits'])
  return out === null ? [] : parseGpus(out)
}

/** "0, NVIDIA GeForce RTX 3090, 24576": one line per card. */
export function parseGpus(out: string): GpuCard[] {
  const cards: GpuCard[] = []
  for (const line of out.split('\n')) {
    const parts = line.split(',').map((part) => part.trim())
    if (parts.length < 3) continue
    const index = Number(parts[0])
    const memoryMb = Number(parts[2].replace(/[^\d]/g, ''))
    if (!Number.isFinite(index) || !parts[1]) continue
    cards.push({ index, name: parts[1], memoryMb: Number.isFinite(memoryMb) ? memoryMb : 0 })
  }
  return cards
}

/* ------------------------------------------- the cards behind KERNEL_GPUS */

/*
 * What each entry of KERNEL_GPUS is: the card's name and its video memory.
 *
 * `readGpus` above answers "what cards does this machine have" for the class
 * form, and inside the colloq-vast container it answers nothing: nvidia-smi is
 * not in the app's image (deploy/vast/README.md lists it as a known gap).
 * Runner cards need more than a picture. A card's memory decides the share
 * every submission on it is promised AND held to (competitions/gpu.ts ·
 * gpuSliceMb), so it has to be read wherever the app actually runs. Two
 * sources, in this order:
 *
 *  - the local `nvidia-smi`, when the server runs on the host: one call for
 *    every card, matched by index or by UUID, the two ways KERNEL_GPUS names a
 *    whole card;
 *  - otherwise the cards themselves, asked from ONE throwaway container that
 *    is given all of them (`docker run --gpus all --entrypoint nvidia-smi`, on
 *    a kernel image already on the machine) and matched the same way. The
 *    NVIDIA toolkit mounts nvidia-smi into every container it gives a card
 *    to, and with every card visible the container numbers them as the host
 *    does, which is how `--gpus device=<index>` names them too. One container
 *    for all of them, not one per card: on the 2 × 4090 VM a probe container
 *    took ~6 s for both cards and ~7 s for each card alone (13 Oct 2026), and
 *    a refresh in the middle of a class is then one container on a busy
 *    daemon rather than one per card. An entry that container did not name
 *    (it failed, or the entry is spelled in a way only `--gpus device=`
 *    understands) is asked from a container of its own,
 *    `--gpus device=<id>`, whose answer is about the card docker hands out
 *    under that very id.
 *
 * A MIG instance stays unknown on purpose: the per-card query describes the
 * physical card the instance is cut from, and a share computed from that would
 * promise each run more than the whole instance has.
 *
 * Read when the server starts and kept warm from then on (`watchGpuCards`),
 * so that neither the owner's Resources tab nor the first GPU run after a
 * restart waits for docker. Cached for ten minutes per card (one minute for
 * "unknown", so a kernel image built a minute ago is noticed soon), one probe
 * at a time for everyone who asks, and nothing ever throws: a card that cannot
 * be asked is a card of unknown size, and the panel says exactly that. A card
 * that has once said its size keeps it through a re-probe that brings none
 * (`remembered`).
 */

/** A card's own word about itself; `null` — it could not be asked, nobody guesses. */
export interface GpuCardFacts {
  name: string | null
  memoryMb: number | null
}

/** An entry of KERNEL_GPUS with what is known about it. */
export interface KnownGpuCard extends GpuCardFacts {
  id: string
}

/** Asks about entries of KERNEL_GPUS; an entry missing from the answer is unknown. */
export type GpuCardProbe = (devices: readonly string[]) => Promise<Map<string, GpuCardFacts>>

const CARD_TTL_MS = 10 * 60_000
const UNKNOWN_CARD_TTL_MS = 60_000
const UNKNOWN_CARD: GpuCardFacts = { name: null, memoryMb: null }
/** The test stand's card: the same made-up 3090 `collect` shows. */
const FAKE_CARD: GpuCardFacts = { name: 'NVIDIA GeForce RTX 3090', memoryMb: 24_576 }
/** Kernel images are `colloq-kernel:<environment>` (kernel/pool.ts · IMAGE_PREFIX). */
const KERNEL_IMAGE = 'colloq-kernel'
/** What the local nvidia-smi and the all-cards container are asked: one line per card (`parseCardList`). */
const CARD_QUERY = ['--query-gpu=index,uuid,name,memory.total', '--format=csv,noheader,nounits']

/** What the cache holds for a card: its facts, and when they are old enough to be asked again. */
interface SeenCard {
  facts: GpuCardFacts
  until: number
}

const seenCards = new Map<string, SeenCard>()
let cardProbe: GpuCardProbe = probeGpuCards
let cardsInflight: { devices: Set<string>; done: Promise<void> } | null = null
let cardWatch: ReturnType<typeof setInterval> | null = null

/**
 * Substitute the probe, for tests; `null` restores the real one. The cache
 * goes with it either way: an answer of the old probe is not the new one's.
 */
export function useGpuCardProbe(fake: GpuCardProbe | null): void {
  cardProbe = fake ?? probeGpuCards
  seenCards.clear()
  cardsInflight = null
}

/**
 * The cards behind these KERNEL_GPUS entries, in the same order.
 *
 * A card asked about before is answered from memory at once, even when the
 * answer is old: the old answer goes out and a fresh probe starts behind it
 * (a card does not change its memory between two page loads). A card never
 * asked about waits for the probe, at most `waitMs`: a participant's page
 * must not wait half a minute for `docker run` on a cold server, and after
 * the deadline the card is simply unknown on this answer and known on the next.
 */
export async function gpuCards(devices: readonly string[], options: { waitMs?: number } = {}): Promise<KnownGpuCard[]> {
  const now = Date.now()
  const unseen = devices.filter((device) => !seenCards.has(device))
  const stale = devices.filter((device) => {
    const seen = seenCards.get(device)
    return seen !== undefined && now >= seen.until
  })
  if (unseen.length + stale.length > 0) {
    const done = refreshCards([...unseen, ...stale])
    if (unseen.length > 0) await within(done, options.waitMs ?? Infinity)
  }
  return devices.map((id) => ({ id, ...(seenCards.get(id)?.facts ?? UNKNOWN_CARD) }))
}

/** One probe for everyone: a caller whose cards are already being asked about joins it. */
function refreshCards(devices: readonly string[]): Promise<void> {
  const flight = cardsInflight
  if (flight && devices.every((device) => flight.devices.has(device))) return flight.done
  const asked = new Set(devices)
  const probe = cardProbe
  const done: Promise<void> = Promise.resolve()
    .then(() => probe([...asked]))
    .catch(() => new Map<string, GpuCardFacts>())
    .then((answer) => {
      // A test swapped the probe meanwhile: this answer belongs to the old one.
      if (probe !== cardProbe) return
      const at = Date.now()
      for (const device of asked) seenCards.set(device, remembered(seenCards.get(device)?.facts, answer.get(device), at))
    })
    .finally(() => {
      if (cardsInflight?.done === done) cardsInflight = null
    })
  cardsInflight = { devices: asked, done }
  return done
}

/**
 * What the cache keeps for a card after a probe: `known` is what it held,
 * `heard` what the probe said (nothing — it failed, timed out or did not name
 * the card).
 *
 * A size the card said goes in, replacing whatever was there, for ten
 * minutes. A probe that brought no size does NOT erase a size the card said
 * before: a card does not change its memory between two probes, while a probe
 * container that times out on a daemon busy with a class's runs, or a
 * `docker image ls` that fails once, is ordinary. Erasing it meant that every
 * GPU run started in the next minute was promised no share at all — no
 * allocator cap and no watchdog (competitions/gpu.ts · gpuSliceFor), on a card
 * whose other runs were capped to theirs, so one greedy notebook could take
 * the memory they had been promised (review, 13 Oct 2026). The kept size is
 * asked again within a minute instead of ten, so the cache is confirmed as
 * soon as the daemon answers. A card that never said its size stays unknown,
 * and is asked again in a minute, as before.
 */
function remembered(known: GpuCardFacts | undefined, heard: GpuCardFacts | undefined, at: number): SeenCard {
  if (heard && heard.memoryMb !== null) return { facts: heard, until: at + CARD_TTL_MS }
  if (known && known.memoryMb !== null) return { facts: known, until: at + UNKNOWN_CARD_TTL_MS }
  return { facts: heard ?? UNKNOWN_CARD, until: at + UNKNOWN_CARD_TTL_MS }
}

/**
 * Keep the inventory warm from the server's start: every card of KERNEL_GPUS
 * is asked about now, in the background, and looked at again every minute,
 * which asks docker only about what has gone stale by the rules above (a size
 * after ten minutes, an unknown one after one) and costs nothing otherwise.
 *
 * Before this, nothing asked until somebody needed an answer. The first open
 * of the Resources tab after a restart waited for the probe containers (the
 * owner's settings read waits seconds for a card never asked about, and the
 * whole tab stays blank meanwhile — ~7 s on the 2 × 4090 VM), and the first
 * GPU run the queue picked up again after a restart waited for its card the
 * same way. Now the answer is there before anyone asks, and a request that
 * comes while the first probe still runs joins it instead of starting another
 * one.
 *
 * Only where this server gives the cards out (the docker backend: under the
 * broker the cluster has them, and the test backend makes them up) and only
 * on a machine whose KERNEL_GPUS lists any. Returns the way to stop it, for
 * tests; the timer does not keep the process alive.
 */
export function watchGpuCards(): () => void {
  if (cardWatch !== null || !dockerGivesCards()) return () => {}
  // Each card once, as the owner's block asks about them: KERNEL_GPUS may name one twice.
  const devices = [...new Set(gpuDevices())]
  if (devices.length === 0) return () => {}
  const look = (): void => void gpuCards(devices, { waitMs: 0 })
  look()
  const watch = setInterval(look, UNKNOWN_CARD_TTL_MS)
  watch.unref?.()
  cardWatch = watch
  return () => {
    clearInterval(watch)
    if (cardWatch === watch) cardWatch = null
  }
}

/** Whether this server hands the machine's cards out itself; a backend setting that does not parse is a "no", not a crash at start. */
function dockerGivesCards(): boolean {
  try {
    return kernelBackend() === 'docker'
  } catch {
    return false
  }
}

/** The work, or the deadline, whichever comes first; never rejects (the work does not). */
function within(work: Promise<void>, ms: number): Promise<void> {
  if (!Number.isFinite(ms)) return work
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, Math.max(0, ms))
    // A deadline is no reason to keep a finished process alive.
    timer.unref?.()
    void work.then(() => {
      clearTimeout(timer)
      resolve()
    })
  })
}

/**
 * The real probe: the local nvidia-smi first, then one throwaway container
 * given every card, then a container of its own for an entry neither named.
 */
async function probeGpuCards(devices: readonly string[]): Promise<Map<string, GpuCardFacts>> {
  const answer = new Map<string, GpuCardFacts>()
  if (kernelBackend() === 'test' && !dockerInjected) {
    for (const device of devices) answer.set(device, FAKE_CARD)
    return answer
  }
  // Under the broker the cluster has the cards; nobody here gives them out.
  if (kernelBackend() !== 'docker' && !dockerInjected) return answer
  const name = (listed: CardRow[]): void => {
    for (const device of devices) {
      const card = listed.find((row) => row.index === device || row.uuid === device)
      if (card && !answer.has(device)) answer.set(device, { name: card.name, memoryMb: card.memoryMb })
    }
  }
  const unnamed = (): string[] => devices.filter((device) => !answer.has(device) && !device.startsWith('MIG-'))
  const local = await nvidiaSmi(CARD_QUERY)
  if (local !== null) name(parseCardList(local))
  if (unnamed().length === 0) return answer
  const image = await probeImage()
  if (!image) return answer
  const all = await cardsInContainer(image)
  if (all) name(all)
  await Promise.all(
    unnamed().map(async (device) => {
      const facts = await cardInContainer(device, image)
      if (facts) answer.set(device, facts)
    }),
  )
  return answer
}

/** One line of `CARD_QUERY`'s answer. */
export type CardRow = { index: string; uuid: string; name: string; memoryMb: number | null }

/**
 * "0, GPU-8f…, NVIDIA GeForce RTX 4090, 24564": one line per card, as
 * `--query-gpu=index,uuid,name,memory.total` prints it. A memory field that
 * is not a number ("[N/A]") is unknown, not zero.
 */
export function parseCardList(out: string): CardRow[] {
  const cards: CardRow[] = []
  for (const line of out.split('\n')) {
    const parts = line.split(',').map((part) => part.trim())
    if (parts.length < 4 || !/^\d+$/.test(parts[0]) || !parts[1]) continue
    const memoryMb = Number(parts[parts.length - 1])
    cards.push({
      index: parts[0],
      uuid: parts[1],
      name: parts.slice(2, -1).join(', '),
      memoryMb: Number.isSafeInteger(memoryMb) && memoryMb > 0 ? memoryMb : null,
    })
  }
  return cards
}

/**
 * "NVIDIA GeForce RTX 4090, 24564" from the probe container. Docker's own
 * words may come before it on the same stream (`run` merges stderr), so the
 * first line of that shape is taken, not the first line.
 */
export function parseCardFacts(out: string): GpuCardFacts | null {
  for (const line of out.split('\n')) {
    const match = /^(.+?),\s*(\d+)\s*$/.exec(line.trim())
    if (!match) continue
    const memoryMb = Number(match[2])
    if (Number.isSafeInteger(memoryMb) && memoryMb > 0) return { name: match[1].trim(), memoryMb }
  }
  return null
}

/**
 * A kernel image to start the probe from, among those already on the
 * machine: `base-gpu` first, it is surely there on a machine with cards. Never
 * pulled (`--pull=never` below): `colloq-kernel` is not on any registry, and a
 * pull attempt is half a minute of nothing.
 */
async function probeImage(): Promise<string | null> {
  const res = await askDocker(['image', 'ls', '--format', '{{.Repository}}:{{.Tag}}', KERNEL_IMAGE], 10_000)
  if (res.code !== 0) return null
  const tags = res.out
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.startsWith(`${KERNEL_IMAGE}:`) && !line.endsWith(':<none>'))
  return tags.find((tag) => tag === `${KERNEL_IMAGE}:base-gpu`) ?? tags.find((tag) => tag === `${KERNEL_IMAGE}:base`) ?? tags[0] ?? null
}

/**
 * Ask the cards themselves what they are, from a container that lives a few
 * seconds: no network, no capabilities, removed on exit. Read-only for the
 * cards — the query takes no memory on them and disturbs no run already there.
 */
function probeContainer(gpus: string, image: string, query: readonly string[]): Promise<{ code: number; out: string }> {
  return askDocker(
    [
      'run', '--rm', '--pull=never', '--network', 'none', '--cap-drop=ALL', '--security-opt=no-new-privileges',
      '--gpus', gpus, '--entrypoint', 'nvidia-smi', image, ...query,
    ],
    30_000,
  )
}

/**
 * Every card at once, from one container given all of them: the same question
 * and the same lines as the local nvidia-smi. `null` — docker did not start
 * it or nvidia-smi failed in it; a partial answer is not read, since a line
 * cut short by the timeout would read as a smaller card.
 */
async function cardsInContainer(image: string): Promise<CardRow[] | null> {
  const res = await probeContainer('all', image, CARD_QUERY)
  return res.code === 0 ? parseCardList(res.out) : null
}

/** One card, from a container given only it: for an entry the all-cards container did not name. */
async function cardInContainer(device: string, image: string): Promise<GpuCardFacts | null> {
  const res = await probeContainer(`device=${device}`, image, ['--query-gpu=name,memory.total', '--format=csv,noheader,nounits'])
  return res.code === 0 ? parseCardFacts(res.out) : null
}

/* ------------------------------------------------------------------ rooms */

interface RoomRow {
  id: string
  name: string
  environment: string | null
  memory_mb: number | null
  cpus: number | null
}

/**
 * The rooms worth talking about: live ones and those whose memory was set by
 * hand.
 *
 * Not all of them: a semester has sixty, and a "who holds the machine" list
 * of sixty rows, fifty-nine of them asleep, answers the wrong question. The
 * cap is there just in case: the panel draws this list.
 */
const selectRooms = db.prepare(
  'SELECT id, name, environment, memory_mb, cpus FROM sessions ORDER BY created_at DESC LIMIT 200',
)
const selectRoom = db.prepare('SELECT id, name, environment, memory_mb, cpus FROM sessions WHERE id = ?')

async function rooms(instanceCpus: number, runtimeRooms?: RuntimeRoom[]): Promise<{ rows: RoomResource[]; takenMb: number; takenCpus: number; memoryBySlot: Map<string, number>; complete: boolean }> {
  let alive: Set<string>
  let complete = true
  const memoryBySlot = new Map<string, number>()
  /*
   * Which classes have a SECOND container, the one personal notebooks live in.
   *
   * Asked by the same `docker ps` as the list of live ones: otherwise the panel
   * would call `inspect` blindly on every live room, only to learn "no such
   * container" for half of them. Under the broker the census has the second
   * Pod since 0.10 (`role: own`), with the numbers kubelet gave it; it must
   * never stand in for the room's own row, which a map by session would do.
   */
  let withOwn = new Set<string>()
  let runningRoom = new Set<string>()
  let runningOwn = new Set<string>()
  const livePod = (room: RuntimeRoom) => room.phase === 'ready' || room.phase === 'pending'
  const runtimeById = new Map(runtimeRooms?.filter((room) => room.role !== 'own').map((room) => [room.sessionId, room]))
  const ownById = new Map(runtimeRooms?.filter((room) => room.role === 'own').map((room) => [room.sessionId, room]))
  try {
    if (runtimeRooms) {
      alive = new Set(runtimeRooms.filter(livePod).map((room) => room.sessionId))
      withOwn = new Set(ownById.keys())
      runningRoom = new Set(runtimeRooms.filter((room) => livePod(room) && room.role !== 'own').map((room) => room.sessionId))
      runningOwn = new Set(runtimeRooms.filter((room) => livePod(room) && room.role === 'own').map((room) => room.sessionId))
    } else {
      const census = kernelBackend() === 'docker' ? await roomContainers({ strict: true }) : []
      alive = new Set(census.filter((r) => r.running).map((r) => r.session))
      withOwn = new Set(census.filter((r) => r.role === 'own').map((r) => r.session))
      runningRoom = new Set(census.filter((r) => r.running && r.role === 'room').map((r) => r.session))
      runningOwn = new Set(census.filter((r) => r.running && r.role === 'own').map((r) => r.session))
      for (const room of census) if (room.stopped) {
        memoryBySlot.set(room.role === 'own' ? `${room.session}#own` : room.session, 0)
      }
    }
  } catch {
    alive = new Set()
    complete = false
  }
  const rows = new Map((selectRooms.all() as RoomRow[]).map((row) => [row.id, row]))
  // Census is authoritative. Neither the DB display window nor an absent DB
  // row can erase resources a running workload still holds.
  for (const id of alive) if (!rows.has(id)) {
    const observed = runtimeById.get(id) ?? ownById.get(id)
    rows.set(id, selectRoom.get(id) as RoomRow | undefined ?? {
      id, name: id, environment: observed?.environment ?? null, memory_mb: null, cpus: null,
    })
  }
  const interesting = [...rows.values()]
    .filter((row) => alive.has(row.id) || row.memory_mb !== null || row.cpus !== null)
  const allocations = await Promise.all(
    interesting.map(async (row) => {
      const settledMb = row.memory_mb ?? envDefaultMb(row.environment)
      const settledCpus = row.cpus ?? instanceCpus
      /*
       * For a live room docker is asked, not the seminar row: they can diverge
       * exactly when it matters, when the limit was raised between lessons
       * while the container has been running on the old one since morning.
       * What has to be shown is what the room has, not what was recorded for
       * it. Both numbers in one `inspect`: the list calls it for every live
       * room.
       */
      // The same rule under the broker: the room census reports memory from
      // the Pod's status, what kubelet set, not what is written in the spec.
      const census = runtimeById.get(row.id)
      const real = runningRoom.has(row.id) && kernelBackend() === 'docker'
        ? await containerLimits(row.id).catch(() => ({ memoryMb: null, cpus: null }))
        : { memoryMb: census?.memoryMb ?? null, cpus: census?.cpus ?? null }
      /*
       * And the same for the personal-notebook container, but only when it
       * exists.
       *
       * Its numbers are the same as the room's (pool.ts · startContainer), yet
       * docker is asked all the same: they can diverge exactly when it
       * matters, when the limit was raised between lessons while one of the
       * containers has been running on the old one since morning.
       */
      const ownPod = ownById.get(row.id)
      const own = !withOwn.has(row.id)
        ? null
        : runtimeRooms
          ? { memoryMb: ownPod?.memoryMb ?? null, cpus: ownPod?.cpus ?? null }
          : await containerLimits(row.id, 'own').catch(() => ({ memoryMb: null, cpus: null }))
      if (kernelBackend() === 'docker' && ((runningRoom.has(row.id) && real.memoryMb === null)
        || (runningOwn.has(row.id) && own?.memoryMb == null))) complete = false
      const ownDefaults = own ? ownLimits(row.id) : null
      return {
        id: row.id,
        name: row.name,
        memoryMb: real.memoryMb ?? settledMb,
        cpus: real.cpus ?? settledCpus,
        environment: row.environment,
        alive: alive.has(row.id),
        ...(own ? { own: { memoryMb: own.memoryMb ?? ownDefaults?.memoryMb ?? settledMb, cpus: own.cpus ?? ownDefaults?.cpus ?? settledCpus } } : {}),
      }
    }),
  )
  let takenMb = 0, takenCpus = 0
  for (const room of allocations) {
    // By Pod, not by class: a class whose only live Pod is its personal
    // notebooks' holds that Pod's memory, not the room's as well.
    if (runningRoom.has(room.id)) {
      takenMb += room.memoryMb
      takenCpus += room.cpus
      memoryBySlot.set(room.id, room.memoryMb)
    }
    if (runningOwn.has(room.id) && room.own) {
      takenMb += room.own.memoryMb
      takenCpus += room.own.cpus
      memoryBySlot.set(`${room.id}#own`, room.own.memoryMb)
    }
  }
  return { rows: allocations.slice(0, 50), takenMb, takenCpus, memoryBySlot, complete }
}

/* ------------------------------------------------------------ collection */

/**
 * The machine as the server sees it right now.
 *
 * Under the test backend the numbers are made up, and made up plausibly:
 * exactly the machine Colloq rents, a 3090 with 72 GB of memory. Without this
 * the seminar form could be neither viewed nor tested on a developer's
 * laptop: there is no `nvidia-smi` there, and "Resources" would be drawn only
 * halfway.
 */
async function collect(): Promise<Collected> {
  const censusStartedAt = process.hrtime.bigint()
  const fake = kernelBackend() === 'test'
  let instanceCpus = defaultCpus()
  let runtimeRooms: RuntimeRoom[] | undefined
  if (kernelBackend() === 'broker') {
    try {
      const client = kernelRuntimeClient()
      const [health, census] = await Promise.all([client.health(), client.rooms().catch(() => [])])
      instanceCpus = health.defaultCpus ?? instanceCpus
      if (health.ok) rememberBroker(health)
      runtimeRooms = census
    } catch { /* Broker unavailable: retain the last configured estimates. */ }
  }
  const perEnvironment: Record<string, { memoryMb: number; gpu: boolean }> = {}
  for (const name of safeNames()) {
    perEnvironment[name] = { memoryMb: envDefaultMb(name), gpu: safeGpu(name) }
  }
  const allocation = await rooms(instanceCpus, runtimeRooms)
  // A live room already holds its memory; it cannot be handed out a second time.
  const takenMb = allocation.takenMb
  const daemon = await readDaemon()
  const picture = memoryPicture({
    daemonTotalMb: daemon?.totalMb ?? null,
    hostTotalMb: Math.floor(os.totalmem() / MB),
    hostAvailableMb: hostAvailableMb(),
    takenMb,
  })
  /*
   * Under the broker "free" is not MemAvailable but what is not yet promised.
   *
   * A room Pod's requests equal its limits, and the scheduler counts all the
   * promised memory as taken, however little of it Python touches. A node
   * with three empty 16 GB rooms is "almost free" by MemAvailable, yet a
   * fourth room will not fit, which is exactly what the field has to warn
   * about. The smaller of the two: MemAvailable also notices memory promised
   * around us (the cluster itself, the application).
   */
  if (kernelBackend() !== 'test') {
    const unpromised = Math.max(0, picture.totalMb - HOST_RESERVE_MB - takenMb)
    picture.availableMb = Math.min(picture.availableMb ?? unpromised, unpromised)
  }
  const brokerMb = kernelBackend() === 'broker' ? brokerDefaultMb() : null
  const gpus = fake ? [{ index: 0, name: 'NVIDIA GeForce RTX 3090', memoryMb: 24_576 }] : await readGpus()
  // An outage is not an empty machine. Keep admission closed until every
  // running allocation can be counted; the UI may still show fallback rows.
  if (!allocation.complete && kernelBackend() === 'docker') picture.availableMb = 0
  observeWorkMemory(allocation.complete ? allocation.memoryBySlot : null, censusStartedAt)
  return {
    memory: fake ? { totalMb: 73_728, availableMb: 51_200, source: 'host' as const } : picture,
    cpus: fake ? 16 : machineCpus(),
    gpus,
    kernel: {
      defaultMemoryMb: brokerMb ?? defaultMemoryMb(false),
      // The broker has no separate GPU default: a Pod with a card gets the same.
      gpuDefaultMemoryMb: brokerMb ?? defaultMemoryMb(true),
      // CPUs are one number per instance: the environment does not affect
      // them, unlike memory, where a GPU environment asks for four times more.
      defaultCpus: instanceCpus,
      perEnvironment,
    },
    rooms: allocation.rows,
  }
}

/** The environment list is read from disk; an empty directory is no reason to refuse an answer. */
function safeNames(): string[] {
  try {
    return listNames()
  } catch {
    return []
  }
}

/**
 * The environment's default, and "don't know" instead of an exception.
 *
 * The environment name comes from the seminar row, and the environment may
 * have been deleted or renamed since. Resolving its chain throws, and the
 * whole answer would fail on it, for the sake of one line in the room list.
 */
function envDefaultMb(name: string | null): number {
  // KERNEL_MEM_<ENVIRONMENT> and 4g/16g belong to `docker run`; the broker's Pod does not see them.
  if (kernelBackend() === 'broker') return brokerDefaultMb()
  try {
    return memoryLimitMb(name ?? '')
  } catch {
    return defaultMemoryMb(false)
  }
}

function safeGpu(name: string): boolean {
  try {
    return needsGpu(name)
  } catch {
    return false
  }
}

/*
 * Ten seconds, and why they are needed at all.
 *
 * The answer costs a read of /proc, a run of `nvidia-smi` and a
 * `docker inspect` for every live room. The seminar form asks for it on open
 * and on every environment change, and the panel is open for several
 * teachers at once; without memory that is dozens of processes a second on a
 * machine that is busy training someone's neural network at the time. Nobody
 * needs anything fresher than ten seconds here: neither the machine's size
 * nor the list of cards changes that fast.
 */
const TTL_MS = 10_000
let cached: { at: number; value: Collected } | null = null
let inflight: Promise<Collected> | null = null

export async function machineResources(options: { fresh?: boolean; beforeReservations?: boolean } = {}): Promise<Collected> {
  if (options.fresh) cached = null
  const display = (value: Collected): Collected => options.beforeReservations ? value : {
    ...value,
    memory: { ...value.memory, availableMb: value.memory.availableMb === null ? null : Math.max(0, value.memory.availableMb - workBudgetSnapshot().memoryMb) },
  }
  // Reservation changes must be visible immediately even while census is cached.
  if (cached && Date.now() - cached.at < TTL_MS) return display(cached.value)
  // One collection for everyone who asked while it runs: otherwise ten panel
  // tabs start ten `nvidia-smi` in one second, exactly what the cache is for.
  inflight ??= collect()
    .then((value) => {
      cached = { at: Date.now(), value }
      return value
    })
    .finally(() => {
      inflight = null
    })
  return display(await inflight)
}

/** Forget what was collected, after a room's limit changed. The daemon too: it
 *  is reconfigured less often, but there is no point remembering it longer
 *  than the rooms. */
export function forgetResources(): void {
  cached = null
  seenDaemon = null
  seenAt = 0
  // The broker's numbers are not erased, only marked stale: without them the
  // PATCH bounds would fall back to the node's memory until the next answer.
  brokerAt = 0
}

/* ----------------------------------------------------------- validation */

/** A kernel cannot start with less than this: Jupyter itself with its imports takes hundreds of megabytes. */
export const MIN_ROOM_MB = 512
/** The machine needs something to live on after the room takes its share. */
export const HOST_RESERVE_MB = 1024

export interface MemoryBounds {
  min: number
  max: number
}

/**
 * The bounds within which a limit makes sense at all.
 *
 * The upper one is the machine's memory minus a gigabyte for the machine
 * itself: a room given everything kills not itself but the server beneath it.
 * It has to be checked on the server, not in the form: the panel knows the
 * numbers, but the browser is not the place that decides how much can be
 * taken from the machine.
 *
 * The machine here is the one that runs the containers. Under colima that is
 * its VM, and a bound based on the Mac's memory would let "sixteen gigabytes"
 * through into docker's twelve: `docker run` would answer that with a refusal
 * in the middle of the lesson.
 */
export function memoryBounds(): MemoryBounds {
  const totalMb =
    kernelBackend() === 'test' ? 73_728 : (lastDaemon()?.totalMb ?? Math.floor(os.totalmem() / MB))
  let max = Math.max(MIN_ROOM_MB, totalMb - HOST_RESERVE_MB)
  /*
   * Under the broker it has the last word: its ceiling is stricter if the
   * operator set RUNTIME_KERNEL_MEMORY_MAX. Accepting more here would mean
   * recording for the room a number the broker will not set on a live room
   * and will cut down to the ceiling for a new Pod.
   */
  const brokerMax = kernelBackend() === 'broker' ? lastBroker().maxMb : null
  if (brokerMax !== null) max = Math.max(MIN_ROOM_MB, Math.min(max, brokerMax))
  return { min: MIN_ROOM_MB, max }
}

/**
 * How many CPUs the machine has, by the same rule as memory.
 *
 * Under the test backend the number is made up and the same as in the
 * endpoint's answer: a bound that does not match the label under the field is
 * a refusal nobody can explain to a person.
 */
export function machineCpus(): number {
  if (kernelBackend() === 'test') return 16
  // And for the same reason as memory: a docker that colima gave ten CPUs
  // rejects `--cpus 12` outright, and the room simply does not start.
  return Math.max(1, lastDaemon()?.cpus || os.cpus().length)
}

/**
 * The bounds for CPUs: from one to all the machine has.
 *
 * There is deliberately no "leave the machine a core" reserve like there is
 * for memory: `--cpus` is a share of time, not hardware taken away. A room
 * with eight CPUs out of eight does not leave the server without a processor,
 * it just competes with it for the processor; a room with the machine's
 * memory minus nothing leaves it with no memory at all.
 */
export function cpuBounds(): MemoryBounds {
  return { min: 1, max: Math.min(machineCpus(), kernelBackend() === 'broker' ? 64 : Infinity) }
}

export type CpuInput = { ok: true; cpus: number | null } | { ok: false; error: 'type' | 'range' }

/** The same measure as for memory: an integer, within bounds, and null means "as for the instance". */
export function readCpuInput(value: unknown): CpuInput {
  if (value === null || value === undefined) return { ok: true, cpus: null }
  if (typeof value !== 'number' || !Number.isInteger(value)) return { ok: false, error: 'type' }
  const { min, max } = cpuBounds()
  if (value < min || value > max) return { ok: false, error: 'range' }
  return { ok: true, cpus: value }
}

export type MemoryInput = { ok: true; mb: number | null } | { ok: false; error: 'type' | 'range' }

/**
 * Parse a submitted "how much memory", with one measure for every endpoint.
 *
 * `null` is a legitimate answer and means "as for the environment": that is
 * how a room is returned to the default without inventing a second field for
 * it. A fraction is rejected, not rounded: the form sends whole megabytes,
 * and a fraction here is a sign that it was not the form that sent it.
 */
export function readMemoryInput(value: unknown): MemoryInput {
  if (value === null || value === undefined) return { ok: true, mb: null }
  if (typeof value !== 'number' || !Number.isInteger(value)) return { ok: false, error: 'type' }
  const { min, max } = memoryBounds()
  if (value < min || value > max) return { ok: false, error: 'range' }
  return { ok: true, mb: value }
}

/** A room's effective limit: its own number or its environment's default. */
export function roomMemoryMb(sessionId: string, environment: string | null): number {
  return sessionMemoryMb(sessionId) ?? envDefaultMb(environment)
}
