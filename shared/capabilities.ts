/** Operational availability, independent of whether an action is permitted. */
export interface RuntimeCapability { available: boolean; code: string; reason: string | null }
/**
 * `gpu` — whether the executor can give a notebook a share of a card: the
 * broker reports it in /v1/health once the cluster has a GPU resource for
 * submissions. Optional, and read as "no" when absent: a broker from before it
 * cannot run a GPU job, and saying otherwise would queue work it refuses.
 *
 * `gpuSlots` — how many GPU notebooks of this instance the cluster runs at
 * once, as its operator says (RUNTIME_COMPETITION_GPU_SLOTS, 1 to
 * COMPETITION_GPU_SLOTS_MAX): the queue keeps that many at the broker and lets
 * CPU work go past the rest, as it does on this machine's own cards. `null` —
 * the operator did not say; absent — a broker from before the setting. Either
 * way the queue keeps one: a GPU notebook the cluster cannot place holds a
 * general slot for the half a minute the broker waits on the scheduler.
 */
export interface CompetitionCapabilities { execution: RuntimeCapability; preparation: RuntimeCapability; gpu?: RuntimeCapability; gpuSlots?: number | null }
