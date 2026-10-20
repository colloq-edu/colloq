/**
 * Why the kernel died, in words, not "the kernel died".
 *
 * The room always saw a kernel's death: the queue dropped, the variables
 * gone, the line "The kernel restarted unexpectedly" in the log. Nobody saw
 * the cause. On 13 Sep 2026 a seminar hit the same cell fifteen times in a
 * row, and finding out that the room's container had two gigabytes while
 * `resnet18` on a 224×224 batch asks for more was only possible through
 * `dmesg` on the machine, that is, not at all if you are a teacher in the
 * middle of a lesson.
 *
 * This gathers what docker and the Linux kernel know about it:
 *
 *   - `docker inspect`: the container's exit code and the `OOMKilled` flag,
 *     if the whole container went down;
 *   - the container's cgroup: the limit, the peak, current usage and the kill
 *     COUNTER `memory.events:oom_kill`;
 *   - the tail of the container's log: what Jupyter managed to say.
 *
 * The counter, not the flag, is the main thing here. When the cgroup kills
 * python inside a live container (and that is exactly how it looks: PID 1 is
 * Jupyter itself, which survives and starts the kernel again),
 * `docker inspect` shows `OOMKilled: true` exactly once and then sticks at
 * that value forever. It cannot tell "killed just now" from "killed this
 * morning". The counter in `memory.events` grows with every kill, and the
 * difference from the previous reading is the honest answer to "was it this
 * cell".
 */

import { formatNumber, tr } from '@shared/i18n'
import { dockerRead, roomContainer, type KernelRole } from './pool.js'
import {
  killedByMemory,
  parseCgroup,
  parseReading,
  readingArgs,
  type CgroupReading,
  type MemoryReading,
} from './postmortem-core.js'
import { kernelBackend } from './runtime-client.js'
import { hasLivePlacement } from './remote/placement-store.js'

/*
 * What a reading is made of, how it is parsed and whether memory killed the
 * container moved to postmortem-core.ts, pure, so that a machine's agent reads
 * its class kernels exactly as home reads its own; they are exported from
 * here as they always were.
 */
export { killedByMemory, type MemoryReading }

/** The cause analysis: what happened and what to say about it. */
export interface Postmortem {
  reading: MemoryReading
  /** Whether memory killed it, and killed it JUST NOW rather than some time earlier. */
  oom: boolean
  /** A ready line for the kernel log and for `journalctl`. */
  text: string
}

type Docker = (args: string[], timeoutMs?: number) => Promise<{ code: number; out: string }>

let docker: Docker = dockerRead
let injected = false

/**
 * Substitute docker, for tests.
 *
 * There is no real docker in the tests, yet what has to be checked is exactly
 * what happens only with it: a kernel killed for memory and the line the room
 * reads afterwards. `null` puts everything back as it was.
 *
 * The fake also skips the backend check. Otherwise it would have to be set
 * together with `KERNEL_BACKEND=docker`, and that switches the whole rest of
 * the server to real docker, and a suite checking one line in the log would
 * start bringing up containers on the developer's machine.
 */
export function useDockerForPostmortem(fake: Docker | null): void {
  docker = fake ?? dockerRead
  injected = fake !== null
}

/** Whether there is anyone to ask: our own docker at hand, or a fake from a test. */
function available(): boolean {
  return injected || kernelBackend() === 'docker'
}

/**
 * The last known kill counter for each room.
 *
 * It lives in the server's memory and dies with it, and that is right: after
 * a server restart "how many kills there were BEFORE we started watching" is
 * unknown, and pretending it is known would mean declaring the very first
 * kernel death from any other cause a lack of memory. Without a baseline the
 * peak decides: if it hit the limit, it hit the limit.
 */
const killsSeen = new Map<string, number>()

/**
 * The kill counter is kept PER CONTAINER, and a class has two containers.
 *
 * The second is the one where students' personal notebooks live (pool.ts ·
 * KernelRole): it has its own cgroup, its own limit and its own counter.
 * Counting them as one number would mean declaring a student kernel's death a
 * lack of memory on the teacher's side, or, the other way round, staying
 * silent about a real one.
 */
const seenKey = (sessionId: string, role: KernelRole) => `${role}:${sessionId}`

/** Forget the counters of every container of the class: they are removed together. */
export function forgetKills(sessionId: string): void {
  for (const role of ['room', 'own', 'council'] as const) killsSeen.delete(seenKey(sessionId, role))
}

/**
 * Remember the counter while nothing has happened yet.
 *
 * Called when the kernel has started: from that moment we have a baseline,
 * and the next death can be told apart from yesterday's. Errors are swallowed
 * silently: this is preparation for diagnostics, not diagnostics, and failing
 * a kernel start because of it would be a bad trade.
 */
export async function sampleKills(sessionId: string, role: KernelRole = 'room'): Promise<void> {
  /*
   * A slot on a machine: its baseline is the counter the machine's census
   * last said (§7.4), with no question asked. The container lives there, and
   * this server's docker knows nothing of it.
   */
  if (hasLivePlacement(sessionId, role)) {
    const { machineKernels } = await import('./remote/placement.js')
    const kills = machineKernels.kills(sessionId, role)
    if (kills !== null) killsSeen.set(seenKey(sessionId, role), kills)
    return
  }
  if (!available()) return
  try {
    const reading = await readCgroup(roomContainer(sessionId, role))
    if (reading.kills !== null) killsSeen.set(seenKey(sessionId, role), reading.kills)
  } catch {
    /* Diagnostics have no right to get in the way. */
  }
}

/** The cgroup's numbers of a container (postmortem-core.ts · CGROUP_SCRIPT, parseCgroup). */
async function readCgroup(container: string): Promise<CgroupReading> {
  return parseCgroup(await docker(readingArgs(container).cgroup))
}

/**
 * Ask docker and the cgroup about everything at once.
 *
 * Three reads in parallel, with a short timeout: this happens at a kernel's
 * death, when the room is already waiting for an explanation, and an extra
 * second here is a second of someone's seminar. None of the three is required
 * to succeed: the container may be gone already, `exec` does not get into a
 * stopped one, and there may be no log at all.
 */
export async function readContainer(sessionId: string, role: KernelRole = 'room'): Promise<MemoryReading> {
  const asked = readingArgs(roomContainer(sessionId, role))
  const [inspect, cgroup, logs] = await Promise.all([docker(asked.inspect), docker(asked.cgroup), docker(asked.logs)])
  return parseReading({ inspect, cgroup, logs })
}

function humanBytes(value: number | null): string {
  if (value === null) return '—'
  const gib = value / 1024 ** 3
  if (gib >= 1) return tr('common.gigabytes', { size: formatNumber(Math.round(gib * 10) / 10) })
  return tr('common.megabytes', { size: formatNumber(Math.round(value / 1024 ** 2)) })
}

/**
 * The sentence all of this was gathered for.
 *
 * "The container was killed by memory: limit 2 GB, 2 GB used on cell 21" is
 * enough to understand what to do next without logging into the machine. The
 * cell number is the same one drawn to its left in the room, so there is no
 * need to go looking for it.
 */
export function describe(reading: MemoryReading, oom: boolean, cell: number | null): string {
  const limit = humanBytes(reading.limit)
  const used = humanBytes(reading.peak ?? reading.current)
  if (oom) {
    return cell === null
      ? tr('server.theContainerWasKilledByMemoryLimit.6ab1f2', { p0: limit, p1: used })
      : tr('server.theContainerWasKilledByMemoryOnCell.0d3c74', { p0: limit, p1: used, p2: cell })
  }
  const last = reading.tail.at(-1) ?? ''
  if (reading.status !== '' && reading.status !== 'running') {
    return tr('server.theRoomContainerStoppedWithCode.b72e19', { p0: String(reading.exit ?? '?'), p1: last })
  }
  // Memory has nothing to do with it and the container is alive: what remains is what Python itself said.
  return tr('server.theKernelProcessEndedWithoutRunningOut.4fd8a1', { p0: used, p1: limit, p2: last })
}

/**
 * All together: read, decide, say.
 *
 * `null` when there is nothing to say: not the docker backend (the broker has
 * its own containers and its own diagnostics), docker did not answer, there
 * are no numbers. Silence is better than a confident fabrication: the room
 * has already received an honest "the kernel restarted", and appending a
 * guessed cause to it is exactly the way to lose half a day that all of this
 * exists to prevent.
 */
export async function explain(
  sessionId: string,
  cell: number | null,
  /** Where the dead kernel lived: in the class's container or its personal notebooks'. */
  role: KernelRole = 'room',
): Promise<Postmortem | null> {
  let reading: MemoryReading
  if (hasLivePlacement(sessionId, role)) {
    /*
     * A slot on a machine: the machine reads its container the same three
     * ways (postmortem-core.ts) when asked through its sync (§7.4,
     * `kernels.postmortem`), and the words are this server's, as here.
     */
    const { machineKernels } = await import('./remote/placement.js')
    const read = await machineKernels.reading(sessionId, role)
    if (!read) return null
    reading = read
  } else {
    if (!available()) return null
    try {
      reading = await readContainer(sessionId, role)
    } catch {
      return null
    }
  }
  const key = seenKey(sessionId, role)
  const oom = killedByMemory(reading, killsSeen.get(key))
  if (reading.kills !== null) killsSeen.set(key, reading.kills)
  // Not a single number and not a line of log means docker kept completely silent.
  if (!oom && reading.limit === null && reading.status === '' && reading.tail.length === 0) return null
  return { reading, oom, text: describe(reading, oom, cell) }
}
