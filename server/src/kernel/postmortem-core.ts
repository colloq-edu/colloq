/**
 * A dead kernel's container, read: the three questions asked of docker and
 * the cgroup, their answers parsed into numbers, and whether memory killed
 * it. Why it is read this way, and why the kill counter rather than the flag
 * decides, is the header of postmortem.ts.
 *
 * MOVED OUT OF kernel/postmortem.ts, AND KEPT PURE. A class kernel on a
 * machine (docs/architecture/remote-classes.md §7.4) dies there, and only the
 * machine's agent can ask its docker; home still says why, in its own words.
 * So the agent asks exactly home's questions (`readingArgs`), parses the
 * answers exactly as home does (`parseReading`), and sends home the reading;
 * home judges it with `killedByMemory` against what it knew of the container
 * and words it with postmortem.ts · describe, which stays there because its
 * words are home's. Nothing here calls docker or keeps state, and nothing
 * loads the room pool: the agent (dist/runner.js) must not
 * (tests/runner-import-graph.test.mts).
 */

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

/** The cgroup's four numbers of a reading. */
export type CgroupReading = Pick<MemoryReading, 'limit' | 'peak' | 'current' | 'kills'>

/** What one docker call answered: its exit code and what it printed. */
export interface DockerAnswer {
  code: number
  out: string
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
export const CGROUP_SCRIPT = [
  'r=/sys/fs/cgroup',
  'v1=$r/memory',
  'p() { printf "%s %s\\n" "$1" "$(cat "$2" 2>/dev/null)"; }',
  'p limit $r/memory.max; p limit $v1/memory.limit_in_bytes',
  'p peak $r/memory.peak; p peak $v1/memory.max_usage_in_bytes',
  'p current $r/memory.current; p current $v1/memory.usage_in_bytes',
  'cat $r/memory.events 2>/dev/null | sed -n "s/^oom_kill /kills /p"',
  'p kills $v1/memory.failcnt',
].join('; ')

/** The container's state, as `docker inspect` is asked for it: status, exit code, the OOM flag, the memory limit. */
export const INSPECT_FORMAT = '{{.State.Status}} {{.State.ExitCode}} {{.State.OOMKilled}} {{.HostConfig.Memory}}'

/** How much of the container's log is read: the last lines Jupyter managed to say. */
export const LOG_TAIL_LINES = 40

/**
 * The three questions a reading asks of a container, as docker argv: its
 * state, its cgroup, the tail of its log. Home and a machine ask the same
 * three, each through its own docker, with a short timeout of its own.
 */
export function readingArgs(container: string): { inspect: string[]; cgroup: string[]; logs: string[] } {
  return {
    inspect: ['inspect', container, '--format', INSPECT_FORMAT],
    cgroup: ['exec', container, 'sh', '-c', CGROUP_SCRIPT],
    logs: ['logs', '--tail', String(LOG_TAIL_LINES), container],
  }
}

/** The cgroup's four numbers from CGROUP_SCRIPT's output; all `null` when the exec failed. */
export function parseCgroup(answer: DockerAnswer): CgroupReading {
  const found: Record<string, number | null> = { limit: null, peak: null, current: null, kills: null }
  if (answer.code !== 0) return found as CgroupReading
  for (const line of answer.out.split('\n')) {
    const [key, raw] = line.trim().split(/\s+/, 2)
    if (!(key in found)) continue
    // The first non-empty answer wins: v1 and v2 never coexist in one container.
    if (found[key] === null) found[key] = bytes(raw)
  }
  return found as CgroupReading
}

/** Lines Jupyter always prints that explain nothing. */
const NOISE = /running over TCP without encryption|Jupyter Server .* is running|http:\/\/127\.0\.0\.1/i

/** The last three lines of the log that say something; none when `logs` failed. */
export function parseTail(answer: DockerAnswer): string[] {
  if (answer.code !== 0) return []
  return answer.out
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '' && !NOISE.test(line))
    .slice(-3)
}

/**
 * The reading the three answers make. None of them is required to succeed:
 * the container may be gone already, `exec` does not get into a stopped one,
 * and there may be no log at all.
 */
export function parseReading(answers: { inspect: DockerAnswer; cgroup: DockerAnswer; logs: DockerAnswer }): MemoryReading {
  const cgroup = parseCgroup(answers.cgroup)
  const state = answers.inspect
  const [status = '', exit = '', oomKilled = '', hostMemory = ''] = state.code === 0 ? state.out.trim().split(/\s+/) : []
  return {
    limit: cgroup.limit ?? bytes(hostMemory),
    peak: cgroup.peak,
    current: cgroup.current,
    kills: cgroup.kills,
    containerOomKilled: oomKilled === 'true',
    status,
    exit: NUMBER.test(exit) ? Number(exit) : null,
    tail: parseTail(answers.logs),
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
