/**
 * What ONE submission can be given on each executor of submissions: this
 * server and the machines that run submissions for it. Three readers ask: the
 * bounds of the defaults in «Ресурсы» (settings.ts · submissionCeiling), what
 * a new competition starts with (newCompetitionDefaults), and the pump, which
 * leaves to the machines a notebook this server could never give what it
 * asks (runner.ts · leftToMachines).
 *
 * By the same arithmetic as the rest of the code, never a second copy of
 * it. This server: its CPUs — a share of time, no core kept back
 * (kernel/resources.ts · cpuBounds) — and its memory less the host's
 * reserve, the most the queue's admission can ever promise competition work
 * here (capacity.ts · usableMemoryMb, before the rooms take theirs); a run's
 * own limits get that less the headroom reserved on top of them
 * (homeLimitRoom), and that is the defaults' bound. A machine: what its agent
 * offers when it holds nothing (runner-agent/machine.ts · freeCapacity), a
 * core and the host's reserve kept for itself, less the cushion a run's
 * claim adds to its memory (remote/fit.ts · stepClaim) — what
 * capabilities.ts · machinesRunIt reads from a machine's facts too.
 */
import { REMOTE_CONTAINER_CUSHION_MB, REMOTE_HOST_RESERVE_MB } from '@shared/remote-runner'
import { HOST_RESERVE_MB } from '../kernel/resources.js'
import { machineShape } from './capacity.js'
import type { CompetitionDefaults } from '@shared/competitions-settings'
import { competitionDefaults, homeNotebooksSetting, submissionCeiling, type SubmissionCeiling } from './settings.js'
import { listStandingRunners } from './remote/store.js'

/**
 * Memory headroom on top of what a submission asks for.
 *
 * A container costs more than its `--memory`: on top of it there is the
 * docker layer, the python process itself before the notebook's first line,
 * and the tmpfs, which counts toward the limit but is not taken up at once.
 * Two hundred and fifty-six megabytes is the cushion at which `docker run`
 * does not refuse at the boundary. The pump reserves it with every run
 * (runner.ts · runReservationMb, which re-exports it), and the defaults'
 * bound leaves it (homeLimitRoom).
 */
export const RUN_RESERVE_MB = 256

/** One run's room: its CPUs and its memory, MB. */
export interface RunRoom {
  cpus: number
  memoryMb: number
}

let homeStandIn: RunRoom | null = null

/**
 * Substitute this server's size, for tests: the test stand is sixteen CPUs
 * and seventy-two gigabytes, and no competition (64 GB at most) asks more
 * memory than that — so a server too small for a notebook's memory is only
 * ever met with one put in its place. Every reader below sees it: the
 * ceiling, the pump's pass-over and its cores.
 */
export function useHomeRunRoom(room: RunRoom | null): void {
  homeStandIn = room
}

/** What one run can be given on this server, with nothing else running. */
export function homeRunRoom(): RunRoom {
  if (homeStandIn) return { ...homeStandIn }
  const machine = machineShape()
  return { cpus: machine.cpus, memoryMb: machine.memoryMb - HOST_RESERVE_MB }
}

/**
 * The most one run's own limits may ask of this server and still be admitted
 * here: its room less the headroom the pump reserves on top of a run's
 * memory (RUN_RESERVE_MB). A machine's room leaves its claim's cushion the
 * same way (machineRunRoom). A default within it is one this server runs; at
 * its room itself it was accepted by the form and then passed over by the
 * pump for ever (runner.ts · leftToMachines), its reservation 256 MB past
 * what the queue could ever give it.
 */
export function homeLimitRoom(): RunRoom {
  const room = homeRunRoom()
  return { cpus: room.cpus, memoryMb: Math.max(0, room.memoryMb - RUN_RESERVE_MB) }
}

/** What one run can be given on a machine, by what the machine said it is (RemoteFacts). */
export function machineRunRoom(facts: RunRoom): RunRoom {
  return { cpus: Math.max(0, facts.cpus - 1), memoryMb: Math.max(0, facts.memoryMb - REMOTE_HOST_RESERVE_MB - REMOTE_CONTAINER_CUSHION_MB) }
}

/**
 * The ceiling as things are now: this server, and every machine not revoked
 * (active or draining) that has said what it is — online or not: a ceiling
 * that fell to this server's eight cores whenever a machine missed a sync
 * would refuse a form that was fine a minute before. `homeNotebooks` — the
 * switch to count with, the stored one by default; a save of the form
 * passes the one it leaves (settings.ts · homeNotebooksAfter).
 */
export function submissionCeilingNow(homeNotebooks = homeNotebooksSetting().value): SubmissionCeiling {
  return submissionCeiling({
    home: homeLimitRoom(),
    homeNotebooks,
    machines: listStandingRunners().flatMap((runner) => (runner.facts ? [{ name: runner.name, ...machineRunRoom(runner.facts) }] : [])),
  })
}

/**
 * What a new competition starts with now: the instance's defaults
 * (settings.ts · competitionDefaults), its cores and memory held to the
 * ceiling as it is now. A default stored past the ceiling stays the owner's
 * — the bound before 0.25 (the machine less a gigabyte, which the form
 * pulled any larger number to), one saved while only the machines ran
 * notebooks, one from before the machine that gave it was revoked — and
 * «Ресурсы» says so under the fields (web/src/admin/competition-materials.ts
 * · pastBoundNote). A competition born with it had every notebook passed
 * over here for its memory (runner.ts · leftToMachines), waiting for a
 * machine that may never come, or every run on fewer cores than it asked,
 * said in each run. Read by the new competition (store.ts ·
 * createCompetition) and by the memory budget that promises its slots
 * (routes/admin-resources.ts · competitionShare).
 */
export function newCompetitionDefaults(): CompetitionDefaults {
  const { limits } = competitionDefaults()
  const ceiling = submissionCeilingNow()
  return { ...limits, cpus: Math.min(limits.cpus, ceiling.cpus.max), memoryMb: Math.min(limits.memoryMb, ceiling.memoryMb.max) }
}
