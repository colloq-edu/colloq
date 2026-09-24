import { formatNumber, tr } from './i18n.js'
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
