import { tr } from './i18n.js'
/**
 * Machine states, in the room's words.
 *
 * `KernelStatus` and `TerminalStatus` are protocol words: 'starting', 'idle',
 * 'dead'. That is right for code, but in the interface they went straight into
 * a Russian line: "ядро python · starting — оболочка · idle" in the kernel log
 * and a bare `idle` in the command line — under the Russian prompt
 * "оболочка запускается…" (shell is starting…). A panel in two languages, the
 * second of them a machine's.
 *
 * Here there is one word per state, and a `Record` over the type rather than a
 * free object: a new protocol state will not compile until it is given a
 * Russian name. There are two genders because there are two subjects: ядро
 * (kernel) is neuter, оболочка (shell) is feminine; the words go after
 * "ядро"/"оболочка" and nowhere else.
 *
 * What does NOT come from here: the status strip in the room header
 * (SessionScreen · `KERNEL`) is set in Latin capitals on purpose — it is the
 * machine's nameplate, not a phrase, and it reads as an indicator next to the
 * colored dot. Languages get mixed not there but inside a sentence.
 */
import type { KernelStatus } from './notebook.js'
import type { TerminalStatus } from './protocol.js'

/** Ядро (kernel) is neuter: "ядро python · считает" (python kernel · running). */
export const KERNEL_WORD: Record<KernelStatus, string> = {
  get off() { return tr('server.kernel_word.off') },
  get starting() { return tr('server.kernel_word.starting') },
  get restarting() { return tr('server.kernel_word.restarting') },
  get idle() { return tr('server.kernel_word.idle') },
  get busy() { return tr('server.kernel_word.busy') },
  get dead() { return tr('server.kernel_word.dead') },
}

/**
 * Оболочка (shell) is feminine: "оболочка · свободна" (shell · idle).
 *
 * The words are the same as in the command-line prompt ("shell is starting…",
 * "shell stopped", "shell not started"): one state named two different ways
 * in the same drawer reads as two different states.
 */
export const SHELL_WORD: Record<TerminalStatus, string> = {
  get closed() { return tr('server.shell_word.closed') },
  get starting() { return tr('server.shell_word.starting') },
  get idle() { return tr('server.shell_word.idle') },
  get busy() { return tr('server.shell_word.busy') },
  get dead() { return tr('server.shell_word.dead') },
}
