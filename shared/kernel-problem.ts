import { formatNumber, tr } from './i18n.js'
import type { CellOutput } from './notebook.js'
import { parseRuntimeStartFailure, type RuntimeStartFailure } from './runtime.js'

/**
 * Why the room's Python did not come up — put so that the teacher can fix it.
 *
 * It lives in the shared document's `meta` (`kernelProblem`), not only in the
 * error text, for one reason: everyone sees the cell's text and the kernel
 * log, and there the student gets a short "the server is busy, the teacher
 * sees the reason" (server.kernel.unschedulable). Advice with numbers — "lower
 * the memory of this room or of other rooms" — is for the teacher alone, and
 * the room draws it itself, by role, from this word. The document and not a
 * socket message, so that a teacher who came in after the refusal sees the
 * advice too.
 *
 * Only the server writes it: `meta` is closed to clients by the gate
 * (collab/gate.ts), and the value is still read as untrusted.
 */
export type KernelProblem = RuntimeStartFailure
export const KERNEL_PROBLEM_KEY = 'kernelProblem'

export function readKernelProblem(value: unknown): KernelProblem | null {
  return parseRuntimeStartFailure(value) ?? null
}

/** "6", "2,5" — the memory field steps by half a gigabyte, it needs no hundredths. */
const gigabytes = (mb: number): string => formatNumber(Math.round(mb / 102.4) / 10)

/** Advice for the teacher: what the node cannot give and what to do about it in the panel. */
export function kernelProblemAdvice(problem: KernelProblem): string {
  switch (problem.unschedulable) {
    case 'memory':
      return problem.memoryMb === undefined
        ? tr('room.kernel.unschedulable.memoryAny')
        : tr('room.kernel.unschedulable.memory', { gb: gigabytes(problem.memoryMb) })
    case 'cpu':
      return problem.cpus === undefined
        ? tr('room.kernel.unschedulable.cpuAny')
        : tr('room.kernel.unschedulable.cpu', { count: problem.cpus })
    case 'gpu':
      return tr('room.kernel.unschedulable.gpu')
    default:
      return tr('room.kernel.unschedulable.other')
  }
}

/* ----------------------------------------------- memory refused (Docker) */

/**
 * The name a cell's error carries when the server would not start its kernel
 * because the machine's memory is promised to other classes (Docker
 * admission, server/src/kernel/pool.ts · KernelMemoryRefusal, reason `full`).
 *
 * A word in the output rather than a match on its text: the text is a
 * sentence in the instance's language, the name is the same in every language
 * and every version, and it survives the round trip through the .ipynb on
 * disk, where an extra field would not. The room draws the cell's notice from
 * it (K5) in the viewer's words and by role, and does not count it as the
 * cell's failure: the code never ran. A tab opened before the notice existed
 * reads it as an ordinary error, «KernelMemory: Не хватает памяти на
 * сервере…», which is still the truth.
 */
export const KERNEL_MEMORY_ENAME = 'KernelMemory'

export function isKernelMemoryOutput(output: CellOutput): boolean {
  return output.kind === 'error' && output.ename === KERNEL_MEMORY_ENAME
}

/** Where an owner frees memory: the Resources tab, whose «Работают сейчас» lists what holds it. */
export const KERNEL_MEMORY_ADMIN_HREF = '/admin/resources'

/**
 * What the cell's notice says, and to whom.
 *
 * Everyone reads that other classes took the memory and that a retry in a
 * couple of minutes may work. The second half is the advice, and it depends
 * on who can act on it: only the server's owner stops kernels (the stop on
 * the Resources tab is owner-only), so the owner is sent there with a link,
 * and everyone else, teachers included, is told whom to ask. Telling a
 * teacher to stop idle classes would send them to a tab where there is no
 * button for it.
 */
export function kernelMemoryNotice(owner: boolean): { title: string; body: string; link: string | null } {
  return {
    title: tr('room.kernel.memory.title'),
    body: tr(owner ? 'room.kernel.memory.bodyOwner' : 'room.kernel.memory.body'),
    link: owner ? tr('room.kernel.memory.open') : null,
  }
}
