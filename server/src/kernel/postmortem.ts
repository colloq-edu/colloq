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

import { formatNumber, getLocale, tr } from '@shared/i18n'
import { dockerRead, roomContainer, type KernelRole } from './pool.js'
import { kernelBackend } from './runtime-client.js'

/** What docker and the cgroup told us about the room's container. */
export interface MemoryReading {
  /** The container's memory limit in bytes; `null` if it could not be read. */
  limit: number | null
  /** Peak usage over the container's life. */
  peak: number | null
  /** How much is in use now, already after the kernel restart, hence small. */
  current: number | null
  /** How many times the cgroup has killed a process in this container since its birth. */
  kills: number | null
  /** The docker flag: the whole container went down on memory, not a process inside. */
  containerOomKilled: boolean
  /** The container status: `running`, `exited`, … */
  status: string
  /** The exit code; meaningful only for a stopped container. */
  exit: number | null
  /** The tail of the container's log, without Jupyter's chatter about encryption. */
  tail: string[]
}

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

/** Forget the counters of BOTH of the class's containers: they are removed together. */
export function forgetKills(sessionId: string): void {
  for (const role of ['room', 'own'] as const) killsSeen.delete(seenKey(sessionId, role))
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
  if (!available()) return
  try {
    const reading = await readCgroup(roomContainer(sessionId, role))
    if (reading.kills !== null) killsSeen.set(seenKey(sessionId, role), reading.kills)
  } catch {
    /* Diagnostics have no right to get in the way. */
  }
}

const NUMBER = /^\d+$/

/** `max` in cgroup v2 means "no limit", not a number. */
function bytes(raw: string | undefined): number | null {
  if (raw === undefined) return null
  const value = raw.trim()
  if (value === '' || value === 'max') return null
  if (!NUMBER.test(value)) return null
  const parsed = Number(value)
  // Docker without `--memory` writes a gigantic number into cgroup v1 instead
  // of "no limit": treating it as a limit means saying "2 GB used of 8 exabytes".
  if (!Number.isFinite(parsed) || parsed <= 0 || parsed >= Number.MAX_SAFE_INTEGER) return null
  return parsed
}

/*
 * One command for all four numbers, and both cgroup versions at once.
 *
 * v2 (everything newer than Ubuntu 22.04) keeps them at the root of the
 * container's namespace, v1 in the `memory/` subdirectory and under other
 * names. Asking for the version in a separate request means paying for a
 * second `docker exec` with knowledge that arrives anyway: the file is simply
 * missing, and `cat` stays silent.
 *
 * `memory.peak` appeared in kernel 5.19; where it is missing, current usage
 * counts as the peak, which is surely too low but not made up.
 */
const CGROUP_SCRIPT = [
  'r=/sys/fs/cgroup',
  'v1=$r/memory',
  'p() { printf "%s %s\\n" "$1" "$(cat "$2" 2>/dev/null)"; }',
  'p limit $r/memory.max; p limit $v1/memory.limit_in_bytes',
  'p peak $r/memory.peak; p peak $v1/memory.max_usage_in_bytes',
  'p current $r/memory.current; p current $v1/memory.usage_in_bytes',
  'cat $r/memory.events 2>/dev/null | sed -n "s/^oom_kill /kills /p"',
  'p kills $v1/memory.failcnt',
].join('; ')

async function readCgroup(container: string): Promise<Pick<MemoryReading, 'limit' | 'peak' | 'current' | 'kills'>> {
  const res = await docker(['exec', container, 'sh', '-c', CGROUP_SCRIPT])
  const found: Record<string, number | null> = { limit: null, peak: null, current: null, kills: null }
  if (res.code !== 0) return found as Pick<MemoryReading, 'limit' | 'peak' | 'current' | 'kills'>
  for (const line of res.out.split('\n')) {
    const [key, raw] = line.trim().split(/\s+/, 2)
    if (!(key in found)) continue
    // The first non-empty answer wins: v1 and v2 never coexist in one container.
    if (found[key] === null) found[key] = bytes(raw)
  }
  return found as Pick<MemoryReading, 'limit' | 'peak' | 'current' | 'kills'>
}

/** Lines Jupyter always prints that explain nothing. */
const NOISE = /running over TCP without encryption|Jupyter Server .* is running|http:\/\/127\.0\.0\.1/i

async function readTail(container: string): Promise<string[]> {
  const res = await docker(['logs', '--tail', '40', container])
  if (res.code !== 0) return []
  return res.out
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '' && !NOISE.test(line))
    .slice(-3)
}

const INSPECT = '{{.State.Status}} {{.State.ExitCode}} {{.State.OOMKilled}} {{.HostConfig.Memory}}'

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
  const container = roomContainer(sessionId, role)
  const [state, cgroup, tail] = await Promise.all([
    docker(['inspect', container, '--format', INSPECT]),
    readCgroup(container),
    readTail(container),
  ])
  const [status = '', exit = '', oomKilled = '', hostMemory = ''] = state.code === 0 ? state.out.trim().split(/\s+/) : []
  return {
    limit: cgroup.limit ?? bytes(hostMemory),
    peak: cgroup.peak,
    current: cgroup.current,
    kills: cgroup.kills,
    containerOomKilled: oomKilled === 'true',
    status,
    exit: NUMBER.test(exit) ? Number(exit) : null,
    tail,
  }
}

/**
 * Whether memory killed it, in light of what we already knew about this room.
 *
 * If the counter grew since the last reading, yes, and there is nothing to
 * argue about. If there was no reading (the server was restarted, the room
 * was adopted from elsewhere), we judge by the peak: it is within three
 * percent of the limit for one that was just killed, and noticeably lower for
 * one that died of any other cause. Three percent rather than "equal": the
 * cgroup manages to add part of the last allocation to `memory.peak`, and the
 * peak can be slightly ABOVE the limit.
 */
export function killedByMemory(reading: MemoryReading, seen: number | undefined): boolean {
  if (reading.kills !== null && seen !== undefined) return reading.kills > seen
  if (reading.containerOomKilled) return true
  if (reading.kills !== null && reading.kills > 0 && reading.limit !== null && reading.peak !== null) {
    return reading.peak >= reading.limit * 0.97
  }
  return false
}

function humanBytes(value: number | null): string {
  if (value === null) return '—'
  const english = getLocale() === 'en'
  const gib = value / 1024 ** 3
  if (gib >= 1) return `${formatNumber(Math.round(gib * 10) / 10)} ${english ? 'GB' : 'ГБ'}`
  return `${formatNumber(Math.round(value / 1024 ** 2))} ${english ? 'MB' : 'МБ'}`
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
  if (!available()) return null
  let reading: MemoryReading
  try {
    reading = await readContainer(sessionId, role)
  } catch {
    return null
  }
  const key = seenKey(sessionId, role)
  const oom = killedByMemory(reading, killsSeen.get(key))
  if (reading.kills !== null) killsSeen.set(key, reading.kills)
  // Not a single number and not a line of log means docker kept completely silent.
  if (!oom && reading.limit === null && reading.status === '' && reading.tail.length === 0) return null
  return { reading, oom, text: describe(reading, oom, cell) }
}
