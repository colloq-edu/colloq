/**
 * Where a class's kernels compute, as staff hear it (protocol.ts ·
 * `kernel:machine`, remote-classes.md §13.1): the last frame of each role,
 * which the session keeps for the notebook's chip and the staff banner
 * (components/notebook/Notebook.svelte). No Svelte and no browser, so that
 * the rule is checked as it runs (tests/classes-ui-room.test.mts).
 */
import type { ControlServerMessage, KernelMachine } from '@shared/protocol'

export type KernelMachineRole = 'room' | 'own' | 'council'

/** One role's last frame: the machine as the server sees it (null — the slot is on this server), staff's sentence, and when it came. */
export interface KernelMachineFrame {
  machine: KernelMachine | null
  note?: string
  at: number
}

export type KernelMachines = Partial<Record<KernelMachineRole, KernelMachineFrame>>

type MachineMessage = Extract<ControlServerMessage, { t: 'kernel:machine' }>

/**
 * The frames with one more: it replaces its role's. A frame with no
 * sentence of its own — the server's fresher view of the same state, sent
 * right after the one that said what happened (kernel/index.ts ·
 * placementNews) — keeps the sentence staff were told of that state, so the
 * banner of a machine that does not answer goes on reading the server's
 * «…не отвечает с 14:32:05. Ждём до 14:33:05…» rather than the plain one.
 * Another state, or a slot back on this server, forgets it.
 */
export function noteKernelMachine(known: KernelMachines, frame: MachineMessage, at: number): KernelMachines {
  const last = known[frame.role]
  const same = last?.machine != null && frame.machine !== null && last.machine.state === frame.machine.state
  const note = frame.note ?? (same ? last?.note : undefined)
  return { ...known, [frame.role]: { machine: frame.machine, ...(note !== undefined ? { note } : {}), at } }
}
