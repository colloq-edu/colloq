import { tr } from './i18n.js'
/**
 * Состояния машины — словами комнаты.
 *
 * `KernelStatus` и `TerminalStatus` — слова протокола: 'starting', 'idle',
 * 'dead'. В коде так и надо, а в интерфейсе они попадали прямо в русскую
 * строку: «ядро python · starting — оболочка · idle» в журнале ядра и голое
 * `idle` в строке команды — под русским приглашением «оболочка запускается…».
 * Панель на двух языках, причём второй — машинный.
 *
 * Здесь по слову на состояние, и `Record` от типа, а не свободный объект:
 * новое состояние протокола не соберётся, пока ему не подберут русское имя.
 * Родов два, потому что подлежащих два: ядро — оно, оболочка — она; слова
 * ставятся после «ядро»/«оболочка» и больше нигде.
 *
 * Что НЕ отсюда: полоса состояния в шапке комнаты (SessionScreen · `KERNEL`)
 * набрана латиницей заглавными намеренно — это шильдик машины, а не фраза, и
 * читается он как индикатор рядом с точкой цвета. Смешивается языки не там, а
 * внутри предложения.
 */
import type { KernelStatus } from './notebook.js'
import type { TerminalStatus } from './protocol.js'

/** Ядро — оно: «ядро python · считает». */
export const KERNEL_WORD: Record<KernelStatus, string> = {
  get starting() { return tr('server.kernel_word.starting') },
  get restarting() { return tr('server.kernel_word.restarting') },
  get idle() { return tr('server.kernel_word.idle') },
  get busy() { return tr('server.kernel_word.busy') },
  get dead() { return tr('server.kernel_word.dead') },
}

/**
 * Оболочка — она: «оболочка · свободна».
 *
 * Слова те же, что в приглашении строки команды («оболочка запускается…»,
 * «оболочка остановилась», «оболочка не запущена»): одно состояние, названное
 * в ящике дважды по-разному, читается как два разных.
 */
export const SHELL_WORD: Record<TerminalStatus, string> = {
  get closed() { return tr('server.shell_word.closed') },
  get starting() { return tr('server.shell_word.starting') },
  get idle() { return tr('server.shell_word.idle') },
  get busy() { return tr('server.shell_word.busy') },
  get dead() { return tr('server.shell_word.dead') },
}
